# Trace 步骤 13 —— 新 token 怎么回到 EngineCore 并并入 request？

> 上一步终态：Sampler 在 worker 进程里生成了 1 个 token id，封进 `SamplerOutput.sampled_token_ids`（`[1,1]` 的 GPU int32 tensor）。LLM offline 模式下 worker 与 EngineCore 同进程，但仍要走完"包装 → 出 worker → 进 scheduler → 改 Request"。
> 本步终态：Request 的 `_output_token_ids = [tok_1]`、`num_computed_tokens=4` 已更新；`check_stop` 跑过未触发；Request 仍在 `running`、状态 `RUNNING`；OutputProcessor 已就 tok_1 做了增量 detokenize；下一 step 的 scheduler 视角下，它从"prefill 4 token"变成"decode 1 token"。

## 1. 当前情境

第 12 步的 `Sampler.forward` 返回 `SamplerOutput`，被 `gpu_model_runner.py:4306` 接住。之后 `gpu_model_runner` 在 `_bookkeeping_sync`（`gpu_model_runner.py:3470`）里做 D2H 把 sampled token 拷回 CPU、记录 prev_sampled_token_ids 等，最后整 batch 结果打包成 `ModelRunnerOutput`（`vllm/v1/outputs.py:233`）回到 EngineCore。

`EngineCore.step`（`core.py:425`）：

```python
scheduler_output = self.scheduler.schedule()                  # 第 5/6 步
future = self.model_executor.execute_model(scheduler_output, ...)  # 第 7-12 步
grammar_output = self.scheduler.get_grammar_bitmask(scheduler_output)
model_output = future.result()                                 # 拿 ModelRunnerOutput
...
engine_core_outputs = self.scheduler.update_from_output(       # ← 本步主战场
    scheduler_output, model_output
)
```

本步要看的是 `scheduler.update_from_output` + 紧接其后由 `LLMEngine` 调用的 `output_processor.process_outputs`。

## 2. 问题

token 已生成、停止条件还没触发，看似 `request.output_token_ids.append(tok)` 一句完事。但实际要回答三件事：

1. **谁拥有这个 Request 对象？** worker 里没有；它在 EngineCore 进程的 scheduler 里。ModelRunnerOutput 跨"边界"回来后必须**用 req_id 反查 Request**，再写它的字段。
2. **谁判定"还要不要继续"？** max_tokens / EOS / stop_token_ids / min_tokens / repetition 看 token id 就能判；但 stop **strings**（如 `stop=["\n\n"]`）必须先 detokenize 成字符串才能匹配，依赖 tokenizer。两者天然分裂到两个地方。
3. **下一 step 调度它时是 prefill 还是 decode？** 看似状态机问题，**V1 没有显式的"prefill / decode"状态字段**（`scheduler.py:330-339` 注释）。所谓"切换"是 `num_computed_tokens` vs `num_tokens_with_spec` 关系自然推出的——这是 V1 干净的关键。

## 3. 朴素思路

当普通状态机：

```python
class Request:
    state: "PREFILL" | "DECODE" | "FINISHED"

def update(req, new_token):
    req.output_token_ids.append(new_token)
    if req.state == "PREFILL": req.state = "DECODE"
    if len(req.output_token_ids) >= req.max_tokens: req.state = "FINISHED"
```

读起来清楚，对应 V0 的真实结构（V0 `SequenceStatus` 就有 `WAITING / RUNNING / SWAPPED / FINISHED_STOPPED ...`）。

## 4. 为什么朴素思路会崩

**它把"prefill / decode"当成 Request 的属性，但实际上这是 scheduler 决策的结果，不是 request 的本质状态**。

崩在哪：

- **chunked prefill**：4096 token 不可能一步喂完；上一步 2048、这一步 2048，中间这步还在 prefill 中且没生成 token
- **prefix caching 命中**：3000 token prompt 命中 2900 prefix，"prefill"只需算最后 100 个，下一步直接 decode；prefill 阶段只跑一次小步
- **speculative decoding**：一次 step 可能既"补 prefill 剩的 token"又"接受 draft 5 个 token"，状态二选一已经表达不出
- **混合 batch**：同一 step 有的 request 在 prefill、有的在 decode；状态字段在 request 上、调度决策在 scheduler 上，两边一致是 bug 之源

V0 走过这条路；V1 重写时刻意砍掉状态字段。`scheduler.py:330-339`：

> "There's no 'decoding phase' nor 'prefill phase' in the scheduler. Each request just has the num_computed_tokens and num_tokens_with_spec. … At each step, the scheduler tries to assign tokens so that each request's num_computed_tokens can catch up its num_tokens_with_spec."

所以**朴素思路在 V1 里被设计否决**。本步更新的不是"状态字段"，而是两个数字——`_output_token_ids` 长度和 `num_computed_tokens`——让下一次 `schedule()` 自然推出"差 1 个 token 没算（decode 1 个）"。

第二个崩点：stop check 不能全放 EngineCore。stop **strings** 必须先增量 detokenize 才能匹配，而 tokenizer 是重对象，拉进 EngineCore 拖慢 hot loop。所以 V1 把 stop string 判定下放到 OutputProcessor。

## 5. vllm 的做法

**三件事分三处**：

<svg viewBox="0 0 880 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="token 从 worker 经 EngineCore 到前端的三进程职责切分">
  <defs>
    <marker id="t13ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="440" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">token 回流的三段职责切分（offline 同进程，但边界清晰）</text>
  <g transform="translate(20, 44)">
    <rect x="0" y="0" width="260" height="270" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="130" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#9a3412">worker 进程</text>
    <text x="130" y="38" text-anchor="middle" font-size="10" fill="#7c2d12">GPU 计算 + sampling</text>
    <line x1="12" y1="46" x2="248" y2="46" stroke="#ea580c" stroke-width="0.6" stroke-dasharray="2,2"/>
    <rect x="20" y="64" width="220" height="36" fill="white" stroke="#ea580c" stroke-width="1" rx="3"/>
    <text x="130" y="82" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">Sampler.forward</text>
    <text x="130" y="94" text-anchor="middle" font-size="9" fill="#7c2d12">[B,1] int32 GPU tensor</text>
    <line x1="130" y1="104" x2="130" y2="124" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar)"/>
    <rect x="20" y="128" width="220" height="36" fill="white" stroke="#ea580c" stroke-width="1" rx="3"/>
    <text x="130" y="146" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">_bookkeeping_sync</text>
    <text x="130" y="158" text-anchor="middle" font-size="9" fill="#7c2d12">D2H → list[list[int]]</text>
    <line x1="130" y1="168" x2="130" y2="188" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar)"/>
    <rect x="20" y="192" width="220" height="40" fill="#fef3c7" stroke="#facc15" stroke-width="1.2" rx="3"/>
    <text x="130" y="210" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">ModelRunnerOutput</text>
    <text x="130" y="224" text-anchor="middle" font-size="9" fill="#a16207">sampled_token_ids=[[tok_1]]</text>
    <text x="130" y="256" text-anchor="middle" font-size="10" font-style="italic" fill="#9a3412">不知道 Request 对象</text>
  </g>
  <path d="M 280 178 L 320 178" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#t13ar)"/>
  <text x="300" y="170" text-anchor="middle" font-size="9" fill="#64748b">回 EngineCore</text>
  <g transform="translate(320, 44)">
    <rect x="0" y="0" width="260" height="270" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="130" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">EngineCore 进程</text>
    <text x="130" y="38" text-anchor="middle" font-size="10" fill="#4c1d95">scheduler.update_from_output</text>
    <line x1="12" y1="46" x2="248" y2="46" stroke="#7c3aed" stroke-width="0.6" stroke-dasharray="2,2"/>
    <rect x="20" y="64" width="220" height="34" fill="white" stroke="#7c3aed" stroke-width="1" rx="3"/>
    <text x="130" y="80" text-anchor="middle" font-size="11" fill="#5b21b6">① 用 req_id 反查 Request</text>
    <text x="130" y="92" text-anchor="middle" font-size="9" fill="#6d28d9">requests[req_id] 拿到对象</text>
    <line x1="130" y1="98" x2="130" y2="112" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar)"/>
    <rect x="20" y="116" width="220" height="34" fill="white" stroke="#7c3aed" stroke-width="1" rx="3"/>
    <text x="130" y="132" text-anchor="middle" font-size="11" fill="#5b21b6">② append_output_token_ids</text>
    <text x="130" y="144" text-anchor="middle" font-size="9" fill="#6d28d9">_output_token_ids += [tok_1]</text>
    <line x1="130" y1="150" x2="130" y2="164" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar)"/>
    <rect x="20" y="168" width="220" height="34" fill="white" stroke="#7c3aed" stroke-width="1" rx="3"/>
    <text x="130" y="184" text-anchor="middle" font-size="11" fill="#5b21b6">③ check_stop（按 token id）</text>
    <text x="130" y="196" text-anchor="middle" font-size="9" fill="#6d28d9">EOS / max_tokens / min_tokens</text>
    <line x1="130" y1="202" x2="130" y2="216" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar)"/>
    <rect x="20" y="220" width="220" height="40" fill="#ede9fe" stroke="#7c3aed" stroke-width="1.2" rx="3"/>
    <text x="130" y="238" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">④ 打包 EngineCoreOutput</text>
    <text x="130" y="252" text-anchor="middle" font-size="9" fill="#6d28d9">new_token_ids=[tok_1]</text>
  </g>
  <path d="M 580 178 L 620 178" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#t13ar)"/>
  <text x="600" y="170" text-anchor="middle" font-size="9" fill="#64748b">交前端</text>
  <g transform="translate(620, 44)">
    <rect x="0" y="0" width="240" height="270" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
    <text x="120" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#115e59">前端进程</text>
    <text x="120" y="38" text-anchor="middle" font-size="10" fill="#0f766e">output_processor.process_outputs</text>
    <line x1="12" y1="46" x2="228" y2="46" stroke="#0d9488" stroke-width="0.6" stroke-dasharray="2,2"/>
    <rect x="20" y="64" width="200" height="34" fill="white" stroke="#0d9488" stroke-width="1" rx="3"/>
    <text x="120" y="80" text-anchor="middle" font-size="11" fill="#115e59">Detokenizer.update</text>
    <text x="120" y="92" text-anchor="middle" font-size="9" fill="#0f766e">token → 增量字符串</text>
    <line x1="120" y1="98" x2="120" y2="112" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar)"/>
    <rect x="20" y="116" width="200" height="34" fill="white" stroke="#0d9488" stroke-width="1" rx="3"/>
    <text x="120" y="132" text-anchor="middle" font-size="11" fill="#115e59">评估 stop strings</text>
    <text x="120" y="144" text-anchor="middle" font-size="9" fill="#0f766e">字符串级（需 tokenizer）</text>
    <line x1="120" y1="150" x2="120" y2="164" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar)"/>
    <rect x="20" y="168" width="200" height="34" fill="white" stroke="#0d9488" stroke-width="1" rx="3"/>
    <text x="120" y="184" text-anchor="middle" font-size="11" fill="#115e59">logprobs_processor</text>
    <text x="120" y="196" text-anchor="middle" font-size="9" fill="#0f766e">若启用则 gather</text>
    <line x1="120" y1="202" x2="120" y2="216" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar)"/>
    <rect x="20" y="220" width="200" height="40" fill="#dcfce7" stroke="#16a34a" stroke-width="1.2" rx="3"/>
    <text x="120" y="238" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">组装 RequestOutput</text>
    <text x="120" y="252" text-anchor="middle" font-size="9" fill="#14532d">流式推送 / offline 累积</text>
  </g>
  <g transform="translate(20, 326)">
    <text x="0" y="14" font-size="11" fill="currentColor"><tspan font-weight="700" fill="#475569">划分依据：</tspan>token id 级判停（EOS / max_tokens）放 EngineCore（hot loop），字符串级判停（stop="\n\n"）放前端（重 tokenizer，不能拖 hot loop）</text>
  </g>
</svg>
<span class="figure-caption">图 T13.1 ｜ token 回流的三段职责切分：worker 出 token、EngineCore scheduler 反查 Request 改字段 + 按 token id 判停、前端 OutputProcessor 做增量 detokenize + 按字符串判停。offline 模式下三者同进程，但划分依据"是否需要 tokenizer"决定了职责归属</span>

<details>
<summary>ASCII 原版</summary>

```
worker 进程                      EngineCore 进程                       前端进程
─────────────                    ────────────────                       ──────────
Sampler → SamplerOutput          scheduler.update_from_output           output_processor.process_outputs
                                  ├─ 用 req_id 查 Request                ├─ Detokenizer.update（增量出字符串）
                                  ├─ append_output_token_ids             ├─ 评估 stop strings
                                  ├─ check_stop（按 token id 判停）      └─ 组装 RequestOutput
                                  └─ 打包 EngineCoreOutput
```

</details>

LLM offline 模式下三者同进程，但调用边界仍清晰。

### 5.1 反查 Request 与 append

`scheduler.update_from_output`（`scheduler.py:1283`）入参 `sampled_token_ids: list[list[int]]`（D2H 在 `_bookkeeping_sync` 完成）。本 trace 它是 `[[<tok_1>]]`。

主循环（`scheduler.py:1347`）按 req_id 反查 Request、取出 `generated_token_ids`，再调 `_update_request_with_output`（`scheduler.py:1649`）：

```python
for output_token_id in new_token_ids:
    request.append_output_token_ids(output_token_id)
    stopped = check_stop(request, self.max_model_len)
    if stopped: del new_token_ids[num_new:]; break
```

`Request.append_output_token_ids`（`request.py:217`）做两件事：append 到 `_output_token_ids` 和 `_all_token_ids`，再 `update_block_hashes()` 维护 prefix caching 的 block hash。

`check_stop`（`vllm/v1/core/sched/utils.py:94`）判定顺序：① `num_output_tokens < min_tokens` → False；② `last_token == eos_token_id` → FINISHED_STOPPED；③ `last_token in stop_token_ids` → FINISHED_STOPPED；④ `num_tokens >= max_model_len` 或 `num_output_tokens >= max_tokens` → FINISHED_LENGTH_CAPPED；⑤ `repetition_detection` 命中 → FINISHED_REPETITION；否则 False。

**本 trace**：`min_tokens=0` 不挡；tok_1 不是 EOS；`stop_token_ids=None`；`num_output_tokens=1 < max_tokens=3` 且 `num_tokens=5 < max_model_len`；`repetition_detection=None`。**返回 stopped=False**，状态仍 `RUNNING`。

### 5.2 状态从 prefill 自然滑入 decode

这是本步**最反直觉**的点。Scheduler 没改任何 enum 字段，但下一次 `schedule()` 看它会自动按 decode 路径来。

关键数值轨迹（`num_tokens = num_prompt_tokens + len(_output_token_ids)`）：

| 阶段                  | num_tokens | num_computed_tokens | 差值 |
| --------------------- | ---------- | ------------------- | ---- |
| 第 5 步调度前         | 4          | 0                   | 4    |
| 第 5 步调度后（forward 前）| 4    | 4                   | 0    |
| 本步 append tok_1 后  | 5          | 4                   | 1    |

上一步 `_update_after_schedule`（`scheduler.py:951, 964`）已经把 `num_computed_tokens += num_scheduled_token` 从 0 加到 4，于是 forward 还没跑完时 scheduler 视角下"4 个 prompt token 都已经算好 KV"。本步把 `_output_token_ids` 从空变成 `[tok_1]`，**差值变成 1**。

下一次 `schedule()`（`scheduler.py:385`）：`num_new_tokens = num_tokens_with_spec + num_output_placeholders - num_computed_tokens = 5 + 0 - 4 = 1`，发出 `num_scheduled_tokens[req] = 1` —— 一次 decode step。**没有任何字段被显式改成 DECODE**，只是差值变成 1。

类比：prefill 时 `num_tokens=4, computed=0` 差 4；chunked prefill 时差值随每步 advance 减小；decode 时每生成 1 个 output token 差值就重新变 1。"prefill → decode 切换"在 V1 里是**自然涌现的相变**，是 `num_computed_tokens` 与"刚 append 的 output token"之间的相位关系。

### 5.3 打包 EngineCoreOutput & OutputProcessor

回到 `update_from_output`（`scheduler.py:1500`）：满足 `new_token_ids or stopped or ...` 就 append 一条 `EngineCoreOutput(request_id, new_token_ids=[tok_1], finish_reason=None, ...)`，按 client_index 汇总返回 `dict[int, EngineCoreOutputs]`，由 LLMEngine 接住传给 OutputProcessor。

`output_processor.py:576` 的 `process_outputs` 对每条 output 调 `req_state.detokenizer.update(new_token_ids, finish_reason==STOP)`，再 `logprobs_processor.update_from_output(...)`，最后 `make_request_output(...)`。`IncrementalDetokenizer.update`（`detokenizer.py:90`）对每个 new_token_id：`token_ids.append`、`output_text += decode_next(...)`，再用 `check_stop_strings` 看新增字符是否命中 `stop`。

**本 trace**：`stop=None`、`logprobs=None`，logprobs_processor 是 no-op；detokenizer 把 tok_1 解出 1-3 个 byte 追加到 `output_text`——因为 offline `llm.generate` 默认不流式（累到底再返回），字符串先存着，下两步继续累。若是 `AsyncLLM` 流式接口，这里会触发一次 token-level 推送——这就是"流式输出在哪发力"的答案：下放到 OutputProcessor，不塞 hot loop。

### 5.4 一图收尾

<svg viewBox="0 0 760 520" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="本步 tok_1 从 GPU 一路落到下一次 schedule 的完整链路">
  <defs>
    <marker id="t13ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">本 trace tok_1 的完整回流轨迹</text>
  <g transform="translate(120, 44)">
    <rect x="0" y="0" width="520" height="46" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="5"/>
    <text x="260" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#9a3412">SamplerOutput ([B=1, 1] int32 GPU)</text>
    <text x="260" y="36" text-anchor="middle" font-size="10" fill="#7c2d12">第 12 步 sampler 出 tok_1</text>
  </g>
  <line x1="380" y1="90" x2="380" y2="114" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar2)"/>
  <text x="392" y="106" font-size="10" fill="#64748b">D2H in _bookkeeping_sync</text>
  <g transform="translate(120, 118)">
    <rect x="0" y="0" width="520" height="46" fill="#fef3c7" stroke="#facc15" stroke-width="1.5" rx="5"/>
    <text x="260" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#92400e">ModelRunnerOutput.sampled_token_ids = [[tok_1]]</text>
    <text x="260" y="36" text-anchor="middle" font-size="10" fill="#a16207">已落 CPU，list[list[int]]</text>
  </g>
  <line x1="380" y1="164" x2="380" y2="188" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar2)"/>
  <text x="392" y="180" font-size="10" fill="#64748b">回 EngineCore</text>
  <g transform="translate(40, 192)">
    <rect x="0" y="0" width="680" height="120" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="340" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">scheduler.update_from_output</text>
    <line x1="16" y1="32" x2="664" y2="32" stroke="#7c3aed" stroke-width="0.6" stroke-dasharray="2,2"/>
    <text x="20" y="50" font-size="10" font-family="monospace" fill="#4c1d95">request = self.requests[req_id]　　← 跨"边界"反查</text>
    <text x="20" y="68" font-size="10" font-family="monospace" fill="#4c1d95">request.append_output_token_ids(tok_1)　→ _output_token_ids = [tok_1]</text>
    <text x="20" y="86" font-size="10" font-family="monospace" fill="#4c1d95">check_stop(request) → False　 (tok_1 ≠ EOS, 1 &lt; max_tokens=3)</text>
    <text x="20" y="104" font-size="10" font-family="monospace" fill="#4c1d95">outputs.append(EngineCoreOutput(new_token_ids=[tok_1], finish_reason=None))</text>
  </g>
  <line x1="380" y1="312" x2="380" y2="334" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar2)"/>
  <text x="392" y="326" font-size="10" fill="#64748b">交 OutputProcessor</text>
  <g transform="translate(40, 338)">
    <rect x="0" y="0" width="680" height="78" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
    <text x="340" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#115e59">output_processor.process_outputs</text>
    <line x1="16" y1="32" x2="664" y2="32" stroke="#0d9488" stroke-width="0.6" stroke-dasharray="2,2"/>
    <text x="20" y="50" font-size="10" font-family="monospace" fill="#134e4a">detokenizer.update([tok_1])　→ output_text += decode_next(tok_1)</text>
    <text x="20" y="68" font-size="10" font-family="monospace" fill="#134e4a">make_request_output(...)　 暂不 finalize （offline 累积到第 17 步）</text>
  </g>
  <line x1="380" y1="416" x2="380" y2="440" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar2)"/>
  <text x="392" y="432" font-size="10" fill="#64748b">下一次 step</text>
  <g transform="translate(120, 444)">
    <rect x="0" y="0" width="520" height="60" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" rx="6"/>
    <text x="260" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#166534">下一次 schedule()</text>
    <text x="260" y="42" text-anchor="middle" font-size="11" font-family="monospace" fill="#15803d">num_new_tokens = num_tokens_with_spec − num_computed_tokens</text>
    <text x="260" y="56" text-anchor="middle" font-size="11" font-family="monospace" fill="#15803d">= 5 − 4 = 1　 → decode step（第 14 步）</text>
  </g>
</svg>
<span class="figure-caption">图 T13.2 ｜ tok_1 一路从 GPU sampler 落到下一次 schedule 决策。append → check_stop（False）→ EngineCoreOutput → detokenize；下一次 schedule 看到 5−4=1，自动按 decode 路径调度——"prefill→decode 切换"在 V1 里就是这个差值的相变，没有任何 enum 字段被显式翻转</span>

<details>
<summary>ASCII 原版</summary>

```
SamplerOutput([B=1, 1] int32 GPU)
        │  D2H in _bookkeeping_sync
        ▼
ModelRunnerOutput.sampled_token_ids = [[tok_1]]   (CPU list[list[int]])
        │
        ▼
scheduler.update_from_output
        ├── request = self.requests[req_id]      ← 跨"边界"反查
        ├── request.append_output_token_ids(tok_1) → _output_token_ids=[tok_1]
        ├── check_stop → False
        └── outputs.append(EngineCoreOutput(new_token_ids=[tok_1], finish_reason=None))

output_processor.process_outputs
        ├── detokenizer.update([tok_1]) → output_text += decode_next(tok_1)
        └── make_request_output(...) 暂不 finalize（offline 累积）

下一次 schedule()
        ▼
num_new_tokens = 5 + 0 - 4 = 1 → decode step（第 14 步）
```

</details>

## 6. 代码位置

- `vllm/v1/engine/core.py:425` —— `EngineCore.step`，先 schedule 再 execute 再 update_from_output
- `vllm/v1/core/sched/scheduler.py:1283` —— `update_from_output` 主循环
- `vllm/v1/core/sched/scheduler.py:1347` —— 按 req_id 反查 Request
- `vllm/v1/core/sched/scheduler.py:1649` —— `_update_request_with_output`：append + check_stop
- `vllm/v1/core/sched/scheduler.py:1500` —— 打包 `EngineCoreOutput`
- `vllm/v1/core/sched/scheduler.py:951` / `:964` —— `_update_after_schedule`，advance `num_computed_tokens`
- `vllm/v1/core/sched/scheduler.py:330-339` —— "scheduler 没有 prefill/decode 状态字段"的官方注释
- `vllm/v1/core/sched/scheduler.py:385-389` —— 下一 `schedule()` 推断 num_new_tokens 的差值算式
- `vllm/v1/core/sched/utils.py:94` —— `check_stop` 实现
- `vllm/v1/request.py:217` —— `Request.append_output_token_ids`
- `vllm/v1/request.py:316` —— `RequestStatus` 枚举（无 PREFILLING/DECODING）
- `vllm/v1/engine/output_processor.py:576` —— `process_outputs`
- `vllm/v1/engine/detokenizer.py:90` —— `IncrementalDetokenizer.update`
- `vllm/v1/outputs.py:233` —— `ModelRunnerOutput`

**阅读顺序**：先看 `core.py:step` 5 行总览；再到 `scheduler.update_from_output` 跟一次主循环；穿插 `_update_request_with_output` + `check_stop` 看停止判定；最后看 `output_processor.process_outputs` 理解为什么 stop strings 不在 scheduler 里判。中途**一定**回头读 `scheduler.py:330-339` 注释，否则会错过 V1 设计哲学。

## 7. 分支与延伸

- **整个 EngineCore.step 的全貌（schedule / execute / update_from_output / output_processor）**：本步只盯后半段，整流程结构 → 第 3 章 §6 "EngineCore step"
- **RequestStatus 枚举到底有哪些、转换有限自动机长什么样**：V1 没有 PREFILLING/DECODING → 第 4 章 §2 "Request 状态机"
- **下一 `schedule()` 怎么把"差 1 个 token"转成 decode batch**：差值算式、token_budget、continuous batching 的成本 → 第 4 章 §3 "schedule 主流程"
- **stop strings 为什么不能在 EngineCore 判定**：tokenizer 重量、跨进程序列化、流式语义 → 第 3 章 §10 "输出处理"
- **OutputProcessor / Detokenizer 流式 vs offline 的差异**：流式时每 step 推一次 RequestOutput，offline 时累到 finish；`output_kind` 控制 → 第 3 章 §10
- **stop string 截断时为什么要备份 `stop_check_offset`**：处理 token 边界跨 stop 字符串的情况 → 第 12 章 FAQ "stop 字符串"
- **`kv_transfer_params` 是什么、为什么也在 EngineCoreOutput 里**：KV connector 的 receiver 端要知道这次输出关联的传输状态 → 第 11 章 KV connector
- **async scheduling 模式下流程怎么变**：worker 不阻塞 EngineCore，update_from_output 里有 `num_output_placeholders` 占位逻辑（`scheduler.py:376, 384`）→ 第 4 章 §3
- **chunked prefill 的相位关系**：本 trace prompt 只 4 token 一次喂完；超过 max_num_batched_tokens 时被切块，每步都不 append output token → 第 4 章 §3
- **prefix caching 命中时 `num_computed_tokens` 初值不是 0**：`scheduler.py:621-639` 会先把 cache 命中的 token 算作 computed → 第 5 章 §3 "prefix caching"

## 8. 走完这一步你脑子里应该多了什么

1. **V1 scheduler 没有 "PREFILL / DECODE" 状态字段**——分界完全是 `num_tokens_with_spec - num_computed_tokens` 这个差值的自然结果。这是 V1 比 V0 干净的关键决策；理解它之后 chunked prefill、prefix caching、spec decode 的兼容性都变成一个公式。
2. **本步真正改写 Request 的只有两处**：`append_output_token_ids` 让 `_output_token_ids` 长度 +1，`update_block_hashes` 给 prefix caching 维护 hash。`RequestStatus.RUNNING` 没变。
3. **停止条件分两层**：scheduler 内 `check_stop` 判 max_tokens / EOS / stop_token_ids / min_tokens / repetition；OutputProcessor 内 detokenizer 判 stop strings。划分依据是"是否需要 tokenizer"。
4. **OutputProcessor 是流式 vs offline 的解耦点**：流式时每 step 推送，offline 时累到 finish 再返回。本 trace 走 offline，所以 tok_1 只是被存起来，等下两步 token 一起 finalize（第 16/17 步）。
