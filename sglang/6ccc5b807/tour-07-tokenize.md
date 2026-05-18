# Trace 步骤 07 —— 文本怎么变成 token id，采样参数怎么变成对象？

## 1. 当前情境

步骤 06 结束时，`GenerateReqInput` 已归一化：`is_single=True`、`rid` 已有 UUID、`sampling_params` 仍是原始 dict `{"max_new_tokens": 3, "temperature": 0}`。此刻执行流在主进程的 `TokenizerManager.generate_request` 里（`python/sglang/srt/managers/tokenizer_manager.py:515`），刚调用完 `obj.normalize_batch_and_arguments()`，即将进入分词。

## 2. 问题

Scheduler（`scheduler.py`）和 ModelRunner 只认 token id（整数列表），不认字符串。要把 `"The capital of France is"` 送进 GPU，必须先把它变成 `[791, 6864, 315, 9822, 374]` 这样的整数序列（具体值取决于 Llama tokenizer）。

同时，`sampling_params` dict `{"max_new_tokens": 3, "temperature": 0}` 里的 `temperature=0` 对下游没有意义——GPU 采样内核期望的是「贪心：`top_k=1`」，而不是一个会触发除以零的浮点数。这个转换要在什么地方、由谁来做？

另一个问题是：为什么要把分词单独放在一个 `TokenizerManager` 里，而不是直接在 `Scheduler` 或 `ModelRunner` 内部做？

## 3. 朴素思路

最简单的想法：在 `Scheduler` 的 `recv_requests` 里，收到字符串请求就调 `tokenizer.encode()`，再组 batch。分词和调度放在同一进程里，省去跨进程通信，代码也简单。

## 4. 为什么朴素思路会崩

把分词放进 Scheduler 有三个具体问题：

**问题一：分词是 CPU 密集任务，会抢占调度器的 GPU 时间。** Scheduler 的主循环必须在一次前向（约几毫秒）之内跑完「收请求 → 前缀匹配 → KV 分配 → 组 batch → 触发前向」四步。如果某条请求的 prompt 有 4096 个 token，HuggingFace tokenizer 的 BPE 编码可能需要数毫秒的纯 CPU 时间——这段时间 GPU 在空转等待调度器，白白浪费算力。

**问题二：Scheduler 子进程没有 event loop，处理不了并发请求的异步等待。** HTTP 服务器同时收到 100 条请求，它们必须并发地等待分词结果。Scheduler 是单线程同步的，不能同时服务多个等待中的 HTTP 请求。

**问题三：分词和采样参数验证在 Scheduler 里做，意味着错误要等到进入调度器之后才被发现。** 此时请求已经占了一个 `rid` 槽，还可能已经在 `waiting_queue` 里待了几十毫秒，失败代价更高。

核心逻辑：**分词是「请求准入」的一部分，应当在请求进入 Scheduler 之前做完，且可以和其他请求并发地做。** 单独一个进程（`TokenizerManager`）负责分词，天然满足这两点。

## 5. SGLang 的做法

`TokenizerManager` 在主进程里（和 `Engine` 同进程），带一个 asyncio 事件循环。它接收 `GenerateReqInput`，做完分词和采样参数归一化，打包成 `TokenizedGenerateReqInput` 之后再通过 ZMQ 发给 Scheduler 子进程（ZMQ 发送是步骤 08 的内容，这里先关注数据变换本身）。

```text
GenerateReqInput (is_single=True)
        │
        ▼  tokenizer_manager.generate_request (tokenizer_manager.py:515)
        │
        ├─ normalize_batch_and_arguments()          <- 步骤 06 已做
        │
        ├─ obj.is_single == True
        │
        ▼  _tokenize_one_request(obj)  (tokenizer_manager.py:707)
        │
        ├─ obj.text != None, obj.input_ids == None
        │       └─ _tokenize_texts("The capital of France is")
        │               └─ tokenizer(["The capital of France is"])
        │                       -> input_ids = [791, 6864, 315, 9822, 374]  (6 tokens)
        │
        ├─ _validate_one_request(obj, input_ids)
        │       └─ 6 + 3 = 9 < context_len (131072)  -> 通过
        │
        ▼  _create_tokenized_object(...)  (tokenizer_manager.py:974)
        │
        ├─ sampling_kwargs = {"max_new_tokens": 3, "temperature": 0}
        ├─ SamplingParams(**sampling_kwargs)
        │       └─ temperature=0 < eps  =>  temperature=1.0, top_k=1  (greedy)
        ├─ sampling_params.normalize(tokenizer)  <- 处理 stop strings 等
        ├─ sampling_params.verify(vocab_size)    <- 合法性检查
        │
        └─ TokenizedGenerateReqInput(
               input_text = "The capital of France is",
               input_ids  = [791, 6864, 315, 9822, 374],
               mm_inputs  = None,
               sampling_params = SamplingParams(max_new_tokens=3, top_k=1, ...),
               return_logprob  = False,
               stream          = False,
               rid             = "a3f7...",
               ...
           )
```

三件核心的事：

**1. 调用 HuggingFace tokenizer 把字符串变成 token id。**  `_tokenize_texts`（`tokenizer_manager.py:620`）把文本包进一个 list（`["The capital of France is"]`），调用 tokenizer，取出 `input_ids[0]`。对于非 fast tokenizer 走 `encode` 逐条调用，对于 fast tokenizer 走批量调用接口。单条 + fast tokenizer 的路径还可以走 `AsyncDynamicbatchTokenizer`（`tokenizer_manager.py:676`），把多个并发请求在 CPU 上合批编码。

**2. `temperature=0` 的转换。** `SamplingParams.__init__`（`sampling_params.py:113`）里有一个判断：`if 0 <= temperature < _SAMPLING_EPS: temperature = 1.0; top_k = 1`。这是把「温度为零」这个数学上的特殊情况转化为「贪心采样（`top_k=1`）」，避免采样核在做 `logits / temperature` 时出现除以零。

**3. `sampling_params.normalize(tokenizer)`（`sampling_params.py:178`）。** 主要处理 stop strings：把字符串形式的 stop 条件（`stop=["</s>"]`）转成 token id 集合，以便调度器在每步解码后直接比对 token id，不用再 decode 回字符串再比较。

归一化完的 `SamplingParams` 对象状态（对应我们的 trace）：

```text
SamplingParams {
  max_new_tokens = 3
  temperature    = 1.0        # 从 0 转换而来
  top_k          = 1          # 贪心：只取最大概率
  top_p          = 1.0        # 不截断
  min_p          = 0.0
  stop_strs      = []
  stop_str_max_len = 0
  ...
}
```

## 6. 代码位置

按这个顺序读：

- `python/sglang/srt/managers/tokenizer_manager.py:515` —— `generate_request` 协程，看 `is_single` 分支如何进入 `_tokenize_one_request`；
- `tokenizer_manager.py:707` —— `_tokenize_one_request`，文本分词的主逻辑；
- `tokenizer_manager.py:620` —— `_tokenize_texts`，封装了 fast/slow tokenizer 和 async 批量三条路径；
- `tokenizer_manager.py:974` —— `_create_tokenized_object`，构造 `TokenizedGenerateReqInput` 并在此处实例化 `SamplingParams`；
- `tokenizer_manager.py:826` —— `_validate_one_request`，检查 input + max_new_tokens 不超 context_len；
- `python/sglang/srt/managers/io_struct.py:711` —— `TokenizedGenerateReqInput` dataclass 定义，注意 `sampling_params` 字段类型已变为 `SamplingParams`（不再是 dict）；
- `python/sglang/srt/sampling/sampling_params.py:31` —— `SamplingParams.__init__`，重点看 `temperature=0` 的特殊处理（`:113`）和 `top_k=-1` 的处理（`:117`）；
- `sampling_params.py:120` —— `verify`，合法性检查；
- `sampling_params.py:178` —— `normalize`，stop strings 转 token id。

## 7. 分支与延伸

- `TokenizerManager` 的完整生命周期、它与 `Engine` 在同一进程中的含义、`init_ipc_channels` 里 ZMQ socket 的建立 → [第 04 章 Engine 与多进程编排](04-engine-and-processes.md)
- `SamplingParams` 的所有字段含义、`json_schema` / `regex` 约束解码参数如何在此处归一化 → [第 11 章 采样与约束解码](11-sampling-constrained.md)
- 批量请求（`is_single=False`）走 `_handle_batch_request`，内部调 `_batch_tokenize_and_process`，可以把多条请求的文本一次性送进 tokenizer 做批量编码 → [第 05 章 请求数据结构](05-request-data-structures.md)
- 多模态请求（含图片）在 `_tokenize_one_request` 里额外调用 `mm_processor.process_mm_data_async`，把图片转成 patch 并插入 `input_ids` 中对应位置 → [第 04 章 §多模态处理](04-engine-and-processes.md)

## 8. 走完这一步你脑子里应该多了什么

1. **分词放在独立进程（`TokenizerManager`）而非 Scheduler 里，根本原因是隔离 CPU 开销**：分词是纯 CPU 任务，和 GPU 前向并发执行才能让 GPU 不等待；同时 `TokenizerManager` 带 asyncio，可以并发处理多条请求的分词等待。
2. **`temperature=0` 在 `SamplingParams.__init__` 就被转换成 `top_k=1`**（贪心采样），而不是等到采样内核里再处理——这样内核无需特判 temperature=0 的除以零。
3. **`sampling_params` 从 dict 升级成 `SamplingParams` 对象**，发生在 `_create_tokenized_object` 里，经历「构造 → normalize → verify」三步；之后下游所有代码只看 `SamplingParams` 的属性，不再解析 dict。
4. **`TokenizedGenerateReqInput`** 是分词阶段的终态：它包含 `input_ids`（整数列表）、已实例化的 `SamplingParams`、以及原始 `input_text`（用于后续 detokenize 时的调试）。这是要发往 Scheduler 子进程的对象。
