# Trace 步骤 06 —— 一个字符串和一个 dict，怎么变成标准请求对象？

## 1. 当前情境

步骤 01–05 全是初始化：`ServerArgs` 已冻结、三个子进程已启动、模型权重已上 GPU、KV cache 池已分配、CUDA graph 已捕获。引擎此刻处于「待命」状态。

现在我们执行第二行代码：

```python
output = engine.generate(
    "The capital of France is",
    {"max_new_tokens": 3, "temperature": 0},
)
```

Python 解释器进入 `Engine.generate`（`python/sglang/srt/entrypoints/engine.py:309`）。我们手里只有一个裸字符串和一个 dict——引擎内部的任何组件都不认识这两样东西。

## 2. 问题

`Engine.generate` 的下一步是调用 `TokenizerManager.generate_request`。但 `TokenizerManager` 需要的不是裸字符串：它要知道这是单条请求还是批量请求、采样参数是否合法、请求 ID 是多少、logprob 开不开……这些在用户的 dict 里统统没有。

更麻烦的是，`Engine.generate` 同时支持：

- 单条 `str` / 批量 `List[str]`；
- 直接传 `input_ids`（已分词的 token id list）；
- 多模态输入（图片、音频、视频）；
- 流式 / 非流式；
- 并行采样（`n > 1`）。

把「所有这些变体的参数归一化」这件事做在哪里？如何保证下游组件不需要自己判断「这是单条还是批量」？

## 3. 朴素思路

最直白的做法：在 `generate` 函数体里写 `if isinstance(prompt, str): ...`，把各种变体的分支逻辑全塞进去，然后把各个字段分别传给 `TokenizerManager`——多少个参数就多少个参数位。

这很自然。函数签名已经有 30 多个参数了，直接再加几个 `if`，哪里不对处理哪里。

## 4. 为什么朴素思路会崩

三个具体问题：

**问题一：归一化必须在跨进程之前做。** `TokenizerManager` 在主进程里、`Scheduler` 在子进程里。如果不事先归一化，批量和单条的判断逻辑就要在两个进程各做一遍；一旦出现不一致（比如 `n=2` 时的并行采样展开），两侧对「批量大小」的认知会分叉，后续的 ZMQ 消息拆解就会出错。

**问题二：`n > 1` 并行采样需要把单条请求膨胀成 n 条。** 用户传 `{"n": 4}`，引擎应该对同一个 prompt 生成 4 条独立序列。如果不在统一的地方做「单条 → 4 条批量」的展开，下游每个组件都要自己识别 `n` 并展开——代码会到处重复。

**问题三：默认值填充只能做一次。** `return_logprob` 没传就是 `False`；`rid` 没传就要生成一个 UUID；`logprob_start_len` 没传就是 `-1`。如果这些默认值的填充散落在各组件里，一个不设、下游就会遇到 `None` 然后崩。

核心矛盾与步骤 01 的 `ServerArgs` 如出一辙：**必须有一个「单一对象」承接所有输入变体，在跨进程之前把它归一化到一个确定性的形态。**

## 5. SGLang 的做法

`Engine.generate` 做的事非常专一：把所有参数原样塞进一个 `GenerateReqInput` dataclass，然后把这个对象交给 `TokenizerManager.generate_request`。

```text
engine.generate("The capital of France is", {"max_new_tokens": 3, "temperature": 0})
        │
        ▼
  GenerateReqInput(
    text   = "The capital of France is",    <- str
    sampling_params = {"max_new_tokens": 3, "temperature": 0},   <- dict，原样放
    rid    = None,    <- 还没有 UUID
    return_logprob = False,    <- 调用时给的默认值
    ...其余约 30 个字段全为 None 或默认值...
  )
        │
        ▼
  tokenizer_manager.generate_request(obj, request=None)
        │
        ├─ obj.normalize_batch_and_arguments()   <- 在这里做真正的归一化
        │         ├─ _validate_inputs()           <- 检查 text/input_ids/input_embeds 三选一
        │         ├─ _determine_batch_size()      <- is_single=True, batch_size=1
        │         ├─ _handle_parallel_sampling()  <- n=1，不需要展开
        │         └─ _normalize_single_inputs()   <- 填 rid(UUID)、默认 logprob 参数...
        │
        └─ (归一化完毕，下一步分词)
```

关键设计点：

1. **`Engine.generate` 只是一个薄壳**（`engine.py:309–399`）。它的职责只是把 30 多个参数原样包进 `GenerateReqInput`，然后调用 `tokenizer_manager.generate_request`。没有任何归一化逻辑在这里。

2. **归一化在 `GenerateReqInput.normalize_batch_and_arguments()`**（`io_struct.py:270`）里做，由 `TokenizerManager.generate_request`（`tokenizer_manager.py:515`）的第一步调用。这个方法内部按顺序调用四个私有方法：
   - `_validate_inputs`（`io_struct.py:306`）：确保 text / input_ids / input_embeds 三选一；
   - `_determine_batch_size`（`io_struct.py:319`）：根据 `text` 是 `str` 还是 `list` 设置 `is_single` 和 `batch_size`；
   - `_handle_parallel_sampling`（`io_struct.py:347`）：如果 `n > 1` 且 `is_single`，把单条展开成 n 条批量；
   - `_normalize_single_inputs` 或 `_normalize_batch_inputs`（`io_struct.py:373`）：填充 `rid`（UUID）和各种默认值。

3. **`sampling_params` 此刻仍是原始 dict**，不是 `SamplingParams` 对象。`{"max_new_tokens": 3, "temperature": 0}` 原样放在 `obj.sampling_params` 里，等到步骤 07 分词之后才会被 `SamplingParams(**sampling_kwargs)` 实例化。

4. **非流式路径**（我们的 trace）在 `generate` 末尾（`engine.py:398`）用 `self.loop.run_until_complete(generator.__anext__())` 把异步生成器跑成同步调用，阻塞直到收到结果。

对于我们的具体调用，`normalize_batch_and_arguments` 执行完之后，对象状态是：

```text
GenerateReqInput {
  text              = "The capital of France is"
  sampling_params   = {"max_new_tokens": 3, "temperature": 0}   # 仍是 dict
  is_single         = True
  batch_size        = 1
  parallel_sample_num = 1
  rid               = "a3f7..."  (新生成的 UUID hex)
  return_logprob    = False
  logprob_start_len = -1
  top_logprobs_num  = 0
  token_ids_logprob = None
  image_data / audio_data / video_data = None
  stream            = False
  ...
}
```

## 6. 代码位置

按这个顺序读：

- `python/sglang/srt/entrypoints/engine.py:309` —— `Engine.generate` 函数签名（30 多个参数）；
- `engine.py:357–383` —— 构造 `GenerateReqInput` 的那一段，参数原样塞进；
- `engine.py:384` —— `self.tokenizer_manager.generate_request(obj, None)`，把对象交出去；
- `engine.py:398` —— 非流式路径：`self.loop.run_until_complete(generator.__anext__())`；
- `python/sglang/srt/managers/io_struct.py:134` —— `GenerateReqInput` dataclass 定义，约 60 个字段；
- `io_struct.py:270` —— `normalize_batch_and_arguments` 方法，看归一化的整体结构；
- `io_struct.py:306–408` —— 四个私有归一化方法；
- `python/sglang/srt/managers/tokenizer_manager.py:515` —— `generate_request` 的头几行，可以看到 `normalize_batch_and_arguments` 在第一步就被调用。

## 7. 分支与延伸

- `GenerateReqInput` 的完整字段含义（多模态、LoRA、disaggregated 推理等）→ [第 05 章 请求数据结构](05-request-data-structures.md)
- `Engine` 的整体结构、`tokenizer_manager` 属性的来源 → [第 04 章 Engine 与多进程编排](04-engine-and-processes.md)
- `parallel_sample_num > 1` 时 `_handle_parallel_sampling` 把单条展开成批量的细节 → [第 05 章 §批量与并行采样](05-request-data-structures.md)
- HTTP 服务器路径（`sglang/srt/entrypoints/http_server.py`）同样构造 `GenerateReqInput` 再调 `generate_request`，区别只是多了 FastAPI `Request` 对象做限流 → [第 03 章 HTTP 服务器](03-http-server.md)
- `sampling_params` 从 dict 升级成 `SamplingParams` 对象发生在步骤 07 → [第 11 章 采样参数](11-sampling-constrained.md)

## 8. 走完这一步你脑子里应该多了什么

1. `Engine.generate` 本身是**薄壳**，不做归一化：它只负责把参数原样包进 `GenerateReqInput`，然后把这个对象交给 `TokenizerManager.generate_request`。
2. **归一化集中在 `GenerateReqInput.normalize_batch_and_arguments()`**：单条/批量判断、并行采样展开、UUID 生成、默认值填充，全在这里一次性完成，且发生在分词和跨进程传输之前。
3. **`sampling_params` 此刻仍是原始 dict**，不是 `SamplingParams` 对象——dict 里的 `temperature=0` 要到步骤 07 才会被转换成贪心采样的 `top_k=1`。
4. 非流式 `generate` 靠 `loop.run_until_complete` 把异步生成器「压」成同步调用；这使得 `Engine` 可以在完全不改动内部异步架构的前提下提供同步接口。
