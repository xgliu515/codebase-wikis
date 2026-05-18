# Trace 步骤 04 —— `["你好"]` 怎么变成内部 Request 并入队？

> 上一步终态：`LLM(...)` 已返回；模型权重在 GPU 上，KV cache 池已分配；EngineCore 与 LLMEngine 都构造完毕。
> 调用 `llm.generate(["你好"], SamplingParams(max_tokens=3, temperature=0))` 进入本步。

## 1. 当前情境

第 03 步结束后，进程里已经躺着一整套对象：

- `llm: LLM`（用户拿到的句柄）
- `llm.llm_engine: LLMEngine`（同步前端，负责 tokenize、调度返回值）
- `llm.llm_engine.engine_core: InprocClient`（**同进程**情况下；多进程模式下是 `SyncMPClient`/`AsyncMPClient`）
- `InprocClient.engine_core: EngineCore`（持有 `Scheduler`、`Executor`、KV cache 池）

`Scheduler.waiting` / `Scheduler.running` 都是空的。GPU 上 attention block pool 全部 `ref_cnt=0`、挂在 `FreeKVCacheBlockQueue` 上。

用户调用 `llm.generate(["你好"], SamplingParams(max_tokens=3, temperature=0))`，按回车。`generate` 内部干完两件事就返回：

1. 把 `["你好"]` 变成一个内部 `Request` 并塞进 `Scheduler.waiting`；
2. 反复 `step()` 直到该 request finished，把结果返回给用户。

本步只关心第 1 件事——准确地说，是"塞进 waiting"前的全部路径。下一步（step 05）才开始第 1 次 `step()`。

## 2. 问题

用户给的就是一个 Python `str`：`"你好"`。但 scheduler 想看到的是一个数据结构清晰、字段齐全的 `Request` 对象，里面至少要有：

- `request_id`（全局唯一，方便后续 abort、查状态、对账输出）
- `prompt_token_ids`（一串 int，模型才认这个）
- `sampling_params`（克隆好、已校验、`max_tokens` 已填、`stop_token_ids` 已并入 EOS）
- `arrival_time`（FCFS 排序、metrics 都要它）
- 可能的 `mm_features`、`lora_request`、`cache_salt`、`priority` 等

需求拆开来就是 4 件事：

1. **格式转换**：`"你好"` → token ids（tokenize）
2. **参数补全与校验**：`SamplingParams` 里没填的字段要按 model_config / generation_config / tokenizer 推一遍默认值，填错的要立刻抛
3. **跨进程序列化**：在多进程模式下，前端进程构造的请求要能通过 ZMQ 序列化送到 EngineCore 进程
4. **入队**：把对象交给 scheduler 的 waiting queue（不能直接交给 running——能不能跑、跑多少 token 是 scheduler 的决定，不是入队人的决定）

## 3. 朴素思路

最简单的写法是：在 `LLM.generate` 里当场 tokenize、当场 `new Request(...)`、直接 `scheduler.add_request(req)` 完事。整个流程 5 行 Python 就够。

```python
def generate(self, prompts, sp):
    for p in prompts:
        ids = self.tokenizer.encode(p)
        req = Request(prompt_token_ids=ids, sampling_params=sp, ...)
        self.scheduler.add_request(req)
    return self._loop_until_done()
```

`Request` 跟 scheduler 同模块，import 一下就能用，看起来非常直接。

## 4. 为什么朴素思路会崩

四个具体问题：

1. **`tokenizer` 跟 `scheduler` 不该在同一个进程里跑**。tokenizer 是纯 CPU 工作（HF tokenizers 一般是 Rust 实现，但仍然走 Python 调用栈），scheduler 是 GPU 进程的事件循环。把两者塞在一起，tokenize 长 prompt 时会卡住 step 循环，吞吐立刻掉。
2. **多进程模式下 `Request` 不能直接传**。`Request`（`vllm/v1/request.py:59`）持有 `StructuredOutputRequest`（其中可能有 xgrammar matcher 句柄）、`ConstantList` 视图、回调函数 `_block_hasher` 等不可序列化的字段。多进程必须用一个**可 msgspec 序列化**的"传输层结构"。
3. **`SamplingParams` 必须 clone**。同一个用户传进来的 `SamplingParams` 实例可能被多 prompt 共享（`llm.generate([p1, p2], same_sp)`）。`process_inputs` 里会按 `model_config.generation_config` / `tokenizer.eos_token_id` 改 `sp.stop_token_ids`、按 prompt 长度改 `sp.max_tokens`。**不 clone 会污染用户传进来的对象，且并发请求互相串改**。
4. **入"waiting"不能等于"立刻可跑"**。Scheduler 需要先看 token budget、看 KV 空间、看 LoRA 上限、看 max_num_seqs，才能决定本 step 跑哪些 request。如果 add 时直接进 running，所有这些检查就被绕过了，第一次 step 就 OOM 或越限。

## 5. vllm 的做法

vllm 把这条路径拆成**三个对象 + 两次形变**，每步只承担一件事：

```
用户             LLM            LLMEngine         InputProcessor      EngineCoreClient        EngineCore           Scheduler
str    --->  generate()  --->  add_request() --->  process_inputs() ---> add_request() ---> add_request() ---> add_request()
                                                       |                       |                  |
                                                EngineCoreRequest       (序列化边界)        Request 对象        进 waiting 队列
                                                (msgspec.Struct)         InprocClient
                                                                          直接转发
```

**两个数据结构的分工**：

- `EngineCoreRequest`（`vllm/v1/engine/__init__.py:80`）：`msgspec.Struct, array_like=True, gc=False`。**纯数据**，所有字段都是序列化友好的。这是"前端 → EngineCore"的传输协议。
- `Request`（`vllm/v1/request.py:59`）：**完整运行时对象**。带 `status` 状态机、`block_hashes` 链表、`_block_hasher` 回调、`structured_output_request` 句柄、`events` 时间轴、`prefill_stats` 等等。Scheduler 看的是它。

**为什么要 EngineCoreClient 这层抽象——同进程也要走？** 因为 vllm 想让 LLMEngine 代码只写一份：

- offline `LLM(...)` 走 `InprocClient`（`core_client.py:274`），`add_request` 实际就是直接调 `EngineCore.preprocess_add_request` + `EngineCore.add_request`（`core_client.py:295-297`）——零开销。
- 在线推理（`AsyncLLM`）走 `AsyncMPClient`，`add_request` 把 `EngineCoreRequest` 通过 ZMQ 推到 EngineCore 进程的 `input_queue`，那个进程的 `run_busy_loop`（`core.py:1187`）poll input_queue 并调 `_handle_client_request`。

也就是说**接口完全一样，实现可换**。本 trace 走 offline 路径，没有真的"busy loop 等待"——同步进程里 `_run_engine`（`llm.py:1419`）就是个 `while has_unfinished_requests: step()` 循环，但 `EngineCoreClient` 这层接口照样在，所以代码看起来跟 server 模式一模一样。

**为什么进的是 waiting 而不是 running**：调度判断（token budget、KV 容量、并发上限、LoRA 上限、结构化输出语法编译状态）全部在 `Scheduler.schedule()` 里完成（见步骤 05）。`add_request` 只做一件事——把 request 追加到 `self.waiting`（`scheduler.py:1755-1777`）并记一个 `QUEUED` 事件。能否进 running、能跑多少 token，下一次 `step()` 时由 scheduler 当场决定。

**完整调用链与每一步的产物**（以 `llm.generate(["你好"], SamplingParams(max_tokens=3, temperature=0))` 为例）：

| 步骤 | 函数 | 产物 |
| --- | --- | --- |
| 1 | `LLM.generate` → `_run_completion` → `_add_completion_requests`（`llm.py:423,1208,1172`） | 一个 `EngineInput`（已 tokenize 的 dict） |
| 2 | `Renderer.render_cmpl`（`llm.py:855`） | `prompt_token_ids = [108386]`（Qwen tokenizer 给 `"你好"` 的一个 token，示意；实际可能 1-2 个） |
| 3 | `_add_request` → `LLMEngine.add_request`（`llm.py:1398`、`llm_engine.py:209`） | 调 `input_processor.process_inputs` |
| 4 | `InputProcessor.process_inputs`（`input_processor.py:234`） | 一个 `EngineCoreRequest`：填好 `request_id`、`prompt_token_ids`、`sampling_params=sp.clone()`、`arrival_time=time.time()`、`max_tokens=3` |
| 5 | `InputProcessor.assign_request_id`（`input_processor.py:215`） | `request_id` 末尾追加 8 字符随机 uuid，防外部 id 冲突；原 id 存到 `external_req_id` |
| 6 | `LLMEngine.add_request` 调 `self.engine_core.add_request(request)`（`llm_engine.py:267`） | 转给 `EngineCoreClient` |
| 7 | `InprocClient.add_request`（`core_client.py:295`） | 调 `engine_core.preprocess_add_request` 把 `EngineCoreRequest` 变成 `Request`（`core.py:788,802`），再调 `engine_core.add_request` |
| 8 | `EngineCore.add_request`（`core.py:334`） | 调 `self.scheduler.add_request(request)` |
| 9 | `Scheduler.add_request`（`scheduler.py:1755`） | request 追加到 `self.waiting`；`self.requests[req_id] = request`；记 `QUEUED` 事件 |

第 7 步那个 `Request.from_engine_core_request`（`request.py:190`）是关键的"复活"：它从 `EngineCoreRequest`（纯数据）重建出带回调 `_block_hasher` 的运行时 `Request`，并在构造里立刻调一次 `update_block_hashes()`（`request.py:177,230`）——这一步对 prefix caching 至关重要，下一篇会展开。

到这里函数返回到 `_run_engine`（`llm.py:1419`），循环开始等 step 出结果。

## 6. 代码位置

- `vllm/entrypoints/llm.py:423` —— `LLM.generate`（用户入口）
- `vllm/entrypoints/llm.py:1172` —— `_add_completion_requests`（批量 tokenize 与提交）
- `vllm/entrypoints/llm.py:1398` —— `LLM._add_request`（生成 `request_id`，调 `LLMEngine.add_request`）
- `vllm/entrypoints/llm.py:1419` —— `_run_engine`（外层循环：`while has_unfinished_requests: step()`）
- `vllm/v1/engine/llm_engine.py:209` —— `LLMEngine.add_request`（前端入口；分支：`EngineCoreRequest` vs 原始 prompt）
- `vllm/v1/engine/input_processor.py:234` —— `process_inputs`（构造 `EngineCoreRequest`，clone `SamplingParams`，填 `max_tokens`）
- `vllm/v1/engine/input_processor.py:215` —— `assign_request_id`（追加 8 字符 uuid）
- `vllm/v1/engine/__init__.py:80` —— `EngineCoreRequest`（msgspec.Struct，传输层数据结构）
- `vllm/v1/request.py:59` —— `Request`（运行时对象）
- `vllm/v1/request.py:190` —— `Request.from_engine_core_request`（数据 → 运行时对象转换）
- `vllm/v1/engine/core_client.py:81` —— `EngineCoreClient.make_client`（offline 时返回 `InprocClient`）
- `vllm/v1/engine/core_client.py:274` —— `InprocClient`（同进程直接调 `EngineCore`）
- `vllm/v1/engine/core_client.py:295` —— `InprocClient.add_request`
- `vllm/v1/engine/core.py:788` —— `EngineCore.preprocess_add_request`（`EngineCoreRequest` → `Request`）
- `vllm/v1/engine/core.py:334` —— `EngineCore.add_request`（转给 `Scheduler`）
- `vllm/v1/engine/core.py:1187` —— `EngineCoreProc.run_busy_loop`（多进程模式才走，offline 不走）
- `vllm/v1/core/sched/scheduler.py:1755` —— `Scheduler.add_request`（真正进 waiting）

**阅读顺序**：`LLM.generate` → `LLMEngine.add_request` → `process_inputs` → `EngineCoreRequest` 定义 → `InprocClient.add_request` → `EngineCore.preprocess_add_request` → `Request.from_engine_core_request` → `Scheduler.add_request`。最后回头看 `EngineCoreProc.run_busy_loop` 对比异步路径，会更明白 InprocClient 为什么存在。

## 7. 分支与延伸

- **多进程模式下 `add_request` 怎么走？** `AsyncMPClient` / `SyncMPClient` 把 `EngineCoreRequest` msgspec 编码后通过 ZMQ DEALER socket 推到 EngineCore 进程；那边由 `EngineCoreProc.run_busy_loop` → `_process_input_queue` → `_handle_client_request` 接收 → 第 7 步开始的路径同 offline。→ 第 3 章 §7 "EngineCoreClient" + §8 "进程拓扑（offline vs server）"
- **AsyncLLM 路径（OpenAI 兼容 server）**：tokenize 跑在前端进程的 asyncio 线程池；EngineCore 是独立进程；前端通过 `add_request_async` 提交。→ 第 3 章 §5 "AsyncLLM"
- **`n>1`（fan-out 子请求）**：`LLMEngine.add_request` 里若 `n>1` 会构造 `ParentRequest`，对每个 child 复制一次 `Request`（最后一个除外），分别调 `engine_core.add_request`（`llm_engine.py:270-285`）。→ 第 3 章 §9 "输入处理" + 第 9 章 "采样" 中 `n>1` 与 best_of 的差异
- **`add_request` 时如果 prompt 超 max_model_len**：`_validate_model_input`（`input_processor.py:426`）会抛 `ValueError`，request 根本不进 waiting。
- **结构化输出请求**：`Request.__init__` 若发现 `sampling_params.guided_*`，初始 `status` 不是 `WAITING` 而是 `WAITING_FOR_STRUCTURED_OUTPUT_GRAMMAR`（`request.py:112`），等 grammar 编译完才允许 schedule。`preprocess_add_request` 里同步调 `grammar_init`（`core.py:803-810`）触发后台编译。→ 第 11 章 "结构化输出"
- **`request_id` 随机后缀**：`assign_request_id` 给外部 id 追加 8 字符 uuid（`input_processor.py:225-232`），可被环境变量 `VLLM_DISABLE_REQUEST_ID_RANDOMIZATION` 关掉（不推荐——会让重复 id 静默串数据）。
- **`prompt` 是 token id 列表而不是 str**：`Renderer.render_cmpl` 跳过 tokenize 直接构造 `EngineInput`；路径其余不变。
- **多模态请求**：`mm_features` 字段非空，会在 `EngineCore.preprocess_add_request` 时通过 `mm_receiver_cache` 解引用（`core.py:797-800`），多进程下避免大张量重复传输。→ 第 11 章 "多模态"
- **`priority>0` 的请求**：会进 `PriorityRequestQueue` 而不是 `FCFSRequestQueue`（`scheduler.py:158,164`、`request_queue.py:131`）。→ 第 4 章 §12 "关键参数：scheduling policy"

## 8. 走完这一步你脑子里应该多了什么

1. **vllm 用两个数据结构把"传输"和"运行"分开**：`EngineCoreRequest`（msgspec、纯数据、跨进程 ok）和 `Request`（运行时、带回调、带状态机）。中间转换在 `Request.from_engine_core_request` 一行完成。
2. **`EngineCoreClient` 是 offline 与 server 唯一的差**——`InprocClient` 同进程零开销、`SyncMPClient`/`AsyncMPClient` 走 ZMQ。LLMEngine 上层代码不区分。
3. **新 request 永远先进 `waiting`，永远由 `Scheduler.schedule()` 决定能否进 `running`**。`add_request` 自己只做"挂上链表 + 记 QUEUED 事件"两件事。
4. **`SamplingParams` 必须 clone、`request_id` 必须加 uuid、`max_tokens` 必须补全**——这三件事都在 `InputProcessor.process_inputs` / `assign_request_id` 里完成，是"用户友好 → 引擎能用"的转译层。
