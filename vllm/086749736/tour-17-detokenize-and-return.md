# 第 17 步 —— token ids 怎么变回字符串、`llm.generate` 怎么返回？

> 这是 vllm 单请求 trace 的最后一步。
> 上一步：req#1 在 EngineCore 标 FINISHED；KV blocks 释放回 pool（保留 hash 索引）；scheduler 把 `EngineCoreOutput(request_id, new_token_ids=[tok3], finish_reason=LENGTH, ...)` 加进当前 step 的输出列表。
> 本步：这条 output 沿"EngineCore → LLMEngine → OutputProcessor → Detokenizer → RequestOutput"流回 `LLM._run_engine`，构造 `RequestOutput` 返回给用户。

## 1. 当前情境

trace 状态：

- `system.req_queue`：空（req#1 FINISHED 已从 running 移出，从 scheduler.requests dict del 掉）
- `system.kv_pool`：req#1 的 block 回到 free queue 尾部，`ref_cnt = 0`，hash 索引还在
- `outputs`：`final_token_ids = [tok1, tok2, tok3]`（这 3 个 token id 是 sampler 的输出，还是数字）

`EngineCore.step()` 返回 `(engine_core_outputs: dict[int, EngineCoreOutputs], model_executed: bool)`，里面包了一条 `EngineCoreOutput`。这个 dict key 是 `client_index`（多 client 场景区分），offline LLM 模式下只有 client 0。

`LLMEngine.step()` 接住这个返回 (`vllm/v1/engine/llm_engine.py:287`)，把它喂给 OutputProcessor。控制流即将穿过 detokenizer。

## 2. 问题

用户最终想要的是 `out[0].outputs[0].text`——一个 Python `str`。手里有 3 个 token id。

天然的想法：

```python
text = tokenizer.decode([tok1, tok2, tok3])
```

为什么 vllm 不这么干、专门做个 `IncrementalDetokenizer`？

**核心问题**：

(a) **流式输出场景**。chatbot / OpenAI API `stream=True` 时，每生成一个 token 就要往客户端推一段新 text。"等所有 token 生成完再 decode" 等价于"不支持流式"。

(b) **BPE token 不对齐 UTF-8**。subword tokenizer 把"中文字符"切成 2-3 个 byte-level token。单独 decode 一个 BPE token 可能拿到一个**不完整的 UTF-8 序列**（比如 b'\xe4\xbd' 是"你"的前两个字节，第三个字节在下个 token 里）。简单逐 token decode 会出乱码、甚至抛 `UnicodeDecodeError`。

(c) **special token 的空格规则**。`tokenizer.decode([t1, t2])` 和 `decode([t1]) + decode([t2])` 不一定相等——special token 周围有"是否插空格"的规则差异。

(d) **`offline` 和 `streaming` 应该共用一套路径**。如果 offline 用 `tokenizer.decode()`、streaming 用增量 decode，两条路径输出会有微小差异，是潜在 bug 源。

## 3. 朴素思路

每次新 token 到达时：

```python
self.token_buffer.append(new_token_id)
text = self.tokenizer.decode(self.token_buffer)  # 重 decode 全部
delta = text[len(self.last_text):]
self.last_text = text
```

每次 O(N) 重 decode 全 buffer。

## 4. 为什么朴素思路会崩

(a) **O(N) 复杂度叠加**。一个 request 生成 2000 token，第 i 个 token 触发对前 i 个 token 的 decode；累积成 O(N²) detokenization 工作。在 high-throughput server 这是可见开销。

(b) **不完整 UTF-8 处理仍然没解决**。每次重 decode 时如果最后一个 token 切在 UTF-8 中间，`decode()` 要么报错要么吞字节——你拿到的 `text` 时不时缺最后一个字符，delta 跳来跳去。

(c) **多语言 token 混合时 special-token 空格规则不稳定**。重 decode 偶尔多/少一个空格，delta 出现负数（新 text 比旧 text 短）。

vllm 需要一个能**带状态、按 byte 累积、知道何时该 emit 字符**的 decoder。HuggingFace `tokenizers` 库专门提供了一个：`DecodeStream`。

## 5. vllm 的做法

整个流程分三层：**OutputProcessor → IncrementalDetokenizer → RequestOutput**。

### 5a. OutputProcessor 接收 EngineCoreOutput

`LLMEngine.step` 拿到 EngineCore 返回的 outputs，调 `OutputProcessor.process_outputs` (`vllm/v1/engine/output_processor.py:576`)。它对每个 `engine_core_output` 做四件事：

1. 取出 `RequestState`（内部为每个 request 维护的"用户视角状态"，包了 `IncrementalDetokenizer`、`LogprobsProcessor`、`parent_req`、queue 等）
2. 调 `req_state.detokenizer.update(new_token_ids, ...)` (`vllm/v1/engine/output_processor.py:639`) detokenize
3. 调 `req_state.make_request_output(...)` (`vllm/v1/engine/output_processor.py:651`) 拼装 `RequestOutput`；AsyncLLM 路径 `put` 进 queue，LLMEngine 路径 append 到 list
4. 若 `finish_reason is not None`，调 `self._finish_request(req_state)` (`vllm/v1/engine/output_processor.py:677`) 把 req_state 从 `request_states` dict 删掉

### 5b. IncrementalDetokenizer.update

`BaseIncrementalDetokenizer.update` (`vllm/v1/engine/detokenizer.py:95-142`) 把 `new_token_ids` append 到 `self.token_ids` 并对每个 token 调 `decode_next`，累加到 `self.output_text`。

关键是 `decode_next`——`FastIncrementalDetokenizer.decode_next` (`vllm/v1/engine/detokenizer.py:210`) 最终调到 `self.stream.step(self.tokenizer, next_token_id)` (`vllm/v1/engine/detokenizer.py:225`)。

`self.stream` 是 `tokenizers.decoders.DecodeStream`（构造在 `vllm/v1/engine/detokenizer.py:183`），HuggingFace `tokenizers` 库提供的**带状态的 byte 累积器**：

- 内部缓 byte，**只在能拼出完整 UTF-8 字符时** emit 出来
- 切在 UTF-8 中间的 token 会先暂存，等下一个 token 来凑齐再一起 emit
- BPE 的 prefix space 规则也在内部处理

构造时把 `request.prompt_token_ids` 当 `ids=` 传进去（`vllm/v1/engine/detokenizer.py:183-186`）：让 stream 内部 byte 状态 = "已经 decode 完整个 prompt 之后"，这样第一个 output token decode 出来就是"接在 prompt 后面的部分"，不会含 prompt 的尾巴。

异常分支 (`vllm/v1/engine/detokenizer.py:231-247`)：tokenizer 偶尔吐 non-monotonic 非法 UTF-8（issue #17448），捕获后 reset stream；OverflowError 兜底（issue #21951）。

本 trace 3 个 token 走完后，`self.output_text` 累积成一个 Python str。

### 5c. 构造 RequestOutput

`RequestState.make_request_output` (`vllm/v1/engine/output_processor.py:272`) 把 `output_text`、`token_ids`、`logprobs`、`finish_reason` 等组装成 `RequestOutput` (`vllm/outputs.py:85`)。

`RequestOutput` 包了：
- `request_id`
- `prompt: str`
- `prompt_token_ids: list[int]`
- `outputs: list[CompletionOutput]`——n=1 时长度 1
- `finished: bool`

每个 `CompletionOutput` (`vllm/outputs.py:22`) 包：
- `index: int`（n>1 时区分）
- `text: str`
- `token_ids: list[int]`
- `cumulative_logprob`
- `finish_reason: FinishReason`

本 trace `n=1, finish_reason=LENGTH`。

### 5d. _run_engine 累积 & 返回

回到 entry：`LLM._run_engine` (`vllm/entrypoints/llm.py:1419-1472`) 的核心循环就是 `while self.llm_engine.has_unfinished_requests(): step_outputs = self.llm_engine.step(); for output in step_outputs: if output.finished: outputs.append(output)`。req#1 的 `RequestOutput` 在某一 step 出现、`finished == True`，append 到 `outputs`、tqdm `pbar.update(n)`。

下次循环 `has_unfinished_requests()` 返回 `False`（scheduler 端 `get_num_unfinished_requests` at `vllm/v1/core/sched/scheduler.py:1872` 返回 0），跳出循环，最后 `return sorted(outputs, key=lambda x: int(x.request_id))` (`vllm/entrypoints/llm.py:1472`)。排序是因为多 request 时 finish 顺序不一定等于添加顺序，要保证返回顺序和 `prompts` 列表对齐。

控制流回到用户：`out = llm.generate(["你好"], SamplingParams(max_tokens=3, temperature=0))` 返回，`out[0].outputs[0].text` 是个 1-3 个汉字 / 标点的字符串（greedy + max_tokens=3 + Qwen2.5-7B-Instruct 对"你好"的实际续写，**不保证好看**——可能是"，"、"！"、"我是" 等等，取决于模型实际 logit）。

### 一个值得注意的细节：parallel sampling (n>1)

`vllm/v1/engine/parallel_sampling.py::ParentRequest` (`vllm/v1/engine/parallel_sampling.py:13`) 把 n>1 的 request 拆成 n 个子 request 进 EngineCore，每个独立 sampler / detokenize；OutputProcessor 在 `_finish_request` 时通过 `parent_req` 把子 request 的 `CompletionOutput` 聚合回同一个 `RequestOutput.outputs` 列表。本 trace `n=1`，没碰这条路径，但代码路径依旧从 OutputProcessor 流出。

## 6. 代码位置

主线：

- `vllm/entrypoints/llm.py::LLM._run_engine` (`vllm/entrypoints/llm.py:1419`) —— 用户 entrypoint 的步进循环
- `vllm/entrypoints/llm.py::LLM.generate` (`vllm/entrypoints/llm.py:423`) —— 第 569 行调到 `_run_engine`
- `vllm/v1/engine/llm_engine.py::LLMEngine.step` (`vllm/v1/engine/llm_engine.py:287`) —— EngineCore → OutputProcessor 的桥
- `vllm/v1/engine/output_processor.py::OutputProcessor.process_outputs` (`vllm/v1/engine/output_processor.py:576`)
- `vllm/v1/engine/output_processor.py::RequestState.make_request_output` (`vllm/v1/engine/output_processor.py:272`)
- `vllm/v1/engine/output_processor.py::OutputProcessor._finish_request` (`vllm/v1/engine/output_processor.py:695`)
- `vllm/v1/engine/detokenizer.py::IncrementalDetokenizer` (`vllm/v1/engine/detokenizer.py:30`) —— 抽象基类
- `vllm/v1/engine/detokenizer.py::BaseIncrementalDetokenizer.update` (`vllm/v1/engine/detokenizer.py:95`)
- `vllm/v1/engine/detokenizer.py::FastIncrementalDetokenizer` (`vllm/v1/engine/detokenizer.py:167`) —— 用 HuggingFace `tokenizers` 的 `DecodeStream`
- `vllm/v1/engine/detokenizer.py::SlowIncrementalDetokenizer` (`vllm/v1/engine/detokenizer.py:250`) —— sentencepiece 等非 fast tokenizer 走这条
- `vllm/outputs.py::RequestOutput` (`vllm/outputs.py:85`) + `CompletionOutput` (`vllm/outputs.py:22`)
- `vllm/v1/engine/parallel_sampling.py::ParentRequest` (`vllm/v1/engine/parallel_sampling.py:13`) —— n>1 时聚合

**阅读顺序**：先回 entry `_run_engine` 看终止条件 `has_unfinished_requests()`，再到 `LLMEngine.step` 看它怎么调 OutputProcessor；接着 `process_outputs` 是核心，理解"detokenize → make_request_output → enqueue/append → _finish_request"四件套；最后单独看 `BaseIncrementalDetokenizer.update` + `FastIncrementalDetokenizer.decode_next`，理解 `DecodeStream` 的 byte 累积语义。

## 7. 分支与延伸

- **AsyncLLM 路径（OpenAI API server）**：`req_state.queue` 不为 None，每次 detokenize 完直接 `queue.put(output)`，由各 request 的 `generate()` async task 接走 → 第 3 章 §10 "输出处理 + Detokenizer"
- **logprobs 处理**：`req_state.logprobs_processor.update_from_output` (`vllm/v1/engine/output_processor.py:648`) 把 EngineCore 返回的 logprob tensor 转 Python 结构 → 第 9 章 §9 "Logprobs"
- **n>1 的 parallel sampling 聚合机制**：`ParentRequest.get_outputs` 怎么决定何时 emit 完整 RequestOutput → 第 9 章 §11 + `vllm/v1/engine/parallel_sampling.py:100`
- **stream 模式下 `delta` text 怎么算？** `get_next_output_text(finished, delta=True)` (`vllm/v1/engine/detokenizer.py:148-164`) 维护 `_last_output_text_offset` → 第 3 章 §10
- **special token / EOS 的隐藏行为**：`skip_special_tokens=True`（默认）会跳过 `<|endoftext|>` 等；`spaces_between_special_tokens` 控制空格 → `vllm/v1/engine/detokenizer.py:175-208`
- **LLM 构造时 entrypoint 链**（如何走到 LLMEngine 而不是 AsyncLLM）→ 第 3 章 §2 "LLM 类"
- **stop_string（用字符串而不是 token id 当停止条件）**：detokenizer 在 `update` 里调 `check_stop_strings` (`vllm/v1/engine/detokenizer.py:309`)，命中后 OutputProcessor 还要通知 EngineCore abort（process_outputs 里的 `reqs_to_abort` 列表 at `vllm/v1/engine/output_processor.py:678-681`） → 第 4 章 §6

## 8. 走完这一步你脑子里应该多了什么

1. **token ids → text 不是 `tokenizer.decode()` 一句话**：因为流式输出、UTF-8 字符跨 token、special-token 空格规则，必须有带状态的增量 decode。vllm 委托给 HuggingFace `tokenizers` 的 `DecodeStream`
2. `IncrementalDetokenizer` 用 prompt **预热** stream，让第一个 output token 的 decode 文本干净
3. OutputProcessor 是"EngineCore 视角（token id、finish_reason 枚举）"和"用户视角（RequestOutput 对象、str 文本）"的转换层；它**不在 EngineCore 进程**里，跑在 LLMEngine 主进程
4. offline `LLM.generate` 和 AsyncLLM `generate()` 共用同一份 OutputProcessor + Detokenizer 代码，区别只在出口：list append vs queue.put
5. 走到这里 trace 完整闭环：`LLM("Qwen/Qwen2.5-7B-Instruct").generate(["你好"], SamplingParams(max_tokens=3, temperature=0))` 经过 17 步——构造（01-03）、入队（04）、调度（05-06）、worker 准备（07-08）、prefill forward（09-11）、sampler（12-13）、decode + continuous batching（14-15）、停止 + 清理（16）、detokenize + 返回（17）——拿到 `out[0].outputs[0].text`。每一步的设计你现在都知道了"为什么不是更简单的 X"
