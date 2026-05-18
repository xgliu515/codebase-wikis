# Trace 步骤 17 —— prefill 结束后，请求怎么变成 decode 循环？

## 1. 当前情境

prefill 已经跑完，`req.output_ids = [<" Paris" 的 token id>]`，长度为 1。
请求此刻在 `Scheduler` 的 `running_batch` 里（还是 `EXTEND` 模式的 last_batch）。
`max_new_tokens=3`，还需要再生成 2 个 token（"." 和可能的 EOS/下一个词）才能结束。

KV cache 里已经有 prompt 6 个 token 的 KV，以及第一个生成 token 的 KV。
GPU 上没有空闲的计算——下一个 decode step 还没开始。

## 2. 问题

prefill 一次性处理了 prompt 的所有 token（本例约 6 个），生成了 1 个新 token。
接下来还要生成第 2、第 3 个 token。但我们不可能每次都把整个 prompt 重新过一遍
——那样每步的计算量都是 O(n)，随 prompt 长度线性增长，对长文本完全不可接受。

问题是：**已有的 KV 怎么复用？新 token 怎么只喂 1 个进去？调度器怎么知道
该切换到 decode 模式？**

## 3. 朴素思路

每个 decode step 都把 `prompt_tokens + output_tokens` 全部重新拼在一起输入模型，
重新计算所有位置的 attention。

逻辑清晰，实现简单——事实上早期 naive transformer 推理就是这么做的。

## 4. 为什么朴素思路会崩

**计算量随输出长度线性增长**。生成第 k 个 token 时，必须对 prefix + k-1 个已
生成 token 都算一遍 attention。如果 prompt 有 1024 个 token、要生成 512 个，
总计算量是 O(1024×512 + ... + 1536×512) ≈ O(n²)，而有了 KV cache 只需 O(n)。

**显存双重浪费**。除了重复计算，每次还要在显存里保存一份完整的 prompt 激活，
而它们的值根本没变。

**批处理效率极差**。把一个 6-token 的 decode 步骤和一个 1024-token 的 prefill
放在同一个 `EXTEND` forward 里，GPU 的实际利用率取决于最长的那个，其余全部等待。

## 5. SGLang 的做法

prefill（`EXTEND` 模式）结束后，请求被迁移进 `DECODE` 模式——每步只喂上一步
采出的那 1 个 token，利用已缓存的 KV 做增量 attention。

**整体状态机**

<svg viewBox="0 0 600 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="State machine of prefill transitioning into the decode loop">
<defs>
<marker id="t17ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="120" y="14" width="360" height="58" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
<text x="300" y="35" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">prefill 结束 · process_batch_result_prefill</text>
<text x="300" y="53" font-size="10" text-anchor="middle" fill="#64748b">output_ids.append(首 token)（步骤 16）</text>
<text x="300" y="67" font-size="10" text-anchor="middle" fill="#64748b">maybe_cache_unfinished_req → prefix KV 挂进 radix tree</text>
<line x1="300" y1="72" x2="300" y2="92" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t17ar)"/>
<rect x="120" y="94" width="360" height="56" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.1"/>
<text x="300" y="115" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">get_next_batch_to_run（下一轮调度循环）</text>
<text x="300" y="133" font-size="10" text-anchor="middle" fill="#64748b">last_batch(EXTEND) 合并进 running_batch</text>
<text x="300" y="146" font-size="10" text-anchor="middle" fill="#64748b">update_running_batch 过滤已完成请求</text>
<line x1="300" y1="150" x2="300" y2="170" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t17ar)"/>
<rect x="120" y="172" width="360" height="62" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
<text x="300" y="193" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">running_batch · DECODE 模式</text>
<text x="300" y="211" font-size="10" text-anchor="middle" fill="#64748b">input_ids = [上一步采出的 token]　形状 [B]</text>
<text x="300" y="225" font-size="10" text-anchor="middle" fill="#64748b">seq_lens 增 1　out_cache_loc = 新分配的 1 个 KV 槽</text>
<line x1="300" y1="234" x2="300" y2="254" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t17ar)"/>
<rect x="120" y="256" width="360" height="62" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.1"/>
<text x="300" y="277" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">ForwardBatch(DECODE)</text>
<text x="300" y="295" font-size="10" text-anchor="middle" fill="#64748b">读已有 KV（步骤 15 机制）＋ 只写回 1 个新 KV</text>
<text x="300" y="309" font-size="10" text-anchor="middle" fill="#64748b">1 个新 logits → 采样 → 追加 output_ids</text>
<path d="M120 287 C 60 287, 60 203, 116 203" fill="none" stroke="#16a34a" stroke-width="1.3" stroke-dasharray="4,3" marker-end="url(#t17ar)"/>
<text x="64" y="248" font-size="10" fill="#16a34a">循环 2 次</text>
<text x="64" y="262" font-size="10" fill="#16a34a">共 3 token</text>
<line x1="300" y1="318" x2="300" y2="346" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t17ar)"/>
<rect x="170" y="348" width="260" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
<text x="300" y="371" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">max_new_tokens 命中 → 步骤 18</text>
</svg>
<span class="figure-caption">图 T17.1 ｜ prefill 结束后请求转入 DECODE 模式，每轮调度循环逐 token 自回归，循环至命中停止条件</span>

<details>
<summary>ASCII 原版</summary>

```text
prefill 结束 (process_batch_result_prefill)
    │  req.output_ids.append(first_token)     <- 步骤 16
    │  maybe_cache_unfinished_req()           <- 把 prefix KV 挂进 radix tree
    │
    ▼
get_next_batch_to_run()  [下一轮调度循环]
    │  last_batch (EXTEND) 合并进 running_batch
    │  running_batch.update_running_batch()   <- 过滤已完成请求
    │
    ▼
running_batch (DECODE 模式)  ← 本步骤的核心
    │  input_ids  = [上一步采出的 token]      形状 [B]
    │  seq_lens   = [prompt_len + output_len]
    │  out_cache_loc = 新分配的 1 个 KV 槽
    │
    ▼
ForwardBatch (DECODE)
    │  注意力后端读已有 KV（步骤 15 的机制）
    │  只写回 1 个新的 KV
    │  得到 1 个新 logits → 采样 → 追加 output_ids
    │
    ▼ (循环 2 次，共生成 3 个 token)
max_new_tokens 命中 → 步骤 18
```

</details>

**prefill 与 decode 的本质区别**

| 维度 | prefill (EXTEND) | decode (DECODE) |
|------|-----------------|-----------------|
| 输入 token 数 | N（整个 prompt） | 1（上一步采出的 token） |
| attention | 全量 attention（含 causal mask） | 每个请求只查 1 个 query，但 KV 来自全部历史 |
| KV 写入量 | N 个 | 1 个 |
| 计算量 | O(N²) 或 O(N·S)（S=KV 总长） | O(S)（S=当前序列长） |
| 典型 batch size | 较小（受 KV 分配限制） | 较大（可装入更多请求） |
| CUDA graph 适用性 | 不适用（输入长度不固定） | 适用（每步 1 token，形状固定） |

**decode batch 的组建**

`ScheduleBatch.prepare_for_decode`（`python/sglang/srt/managers/schedule_batch.py`，
`prepare_for_decode` 附近）在进入 `ForwardBatch` 之前做三件事：

```python
# schedule_batch.py:2328-2341 (精简)
self.input_ids = self.output_ids.to(torch.int64)  # 上一步采出的 token
self.output_ids = None
self.out_cache_loc = alloc_for_decode(self, token_per_req=1)  # 分配 1 个 KV 槽
for req in self.reqs:
    req.kv_committed_len += 1
    req.kv_allocated_len += 1
```

`input_ids` 的形状是 `[B]`（每请求 1 个 token），而 prefill 时是
`[sum(seq_lens)]`（所有请求的 token 拼接）。这个形状变化是 decode 的标志。

**KV 增量追加**

decode step 的 `out_cache_loc` 是 `alloc_for_decode` 分配的 1 个新 slot
（`common.py:alloc_for_decode`）。注意力后端在 forward 时：

- **读**：从 `req_to_token_pool` 查出该请求的所有历史 KV index，读全量 KV；
- **写**：把新的 1 个 KV 写入 `out_cache_loc` 对应的物理槽；
- `kv_committed_len` 加 1，下一步的 `seq_lens` 自动多 1。

**本例的两轮 decode**

```text
decode step 1:
  input_ids = [" Paris" token]
  seq_lens  = [7]   (6 prompt + 1 output)
  → 采样得 "." 的 token id
  req.output_ids = [" Paris", "."]

decode step 2:
  input_ids = ["." token]
  seq_lens  = [8]
  → 采样得第 3 个 token（此处为 EOS 或超出 max_new_tokens）
  req.output_ids = [" Paris", ".", <token3>]
  check_finished(): len(output_ids)==3 == max_new_tokens → FINISH_LENGTH
```

**为什么 decode batch 可以混入不同长度的请求**

decode 模式下每个请求只贡献 1 个 query，`seq_lens` 的差异只影响它需要读多少
历史 KV，而不影响 `input_ids` 的形状（始终是 `[B]`）。这让调度器能把几十甚至
上百个不同状态的请求打包进同一个 decode batch，充分利用 GPU。

## 6. 代码位置

按阅读顺序：

- `python/sglang/srt/managers/scheduler.py:2498`
  —— `get_next_batch_to_run`：调度循环入口。
  第 2535-2562 行：把 `last_batch`（prefill）里已完成的请求合并进
  `running_batch`（decode）。
  第 2596-2604 行：如果没有新 prefill，就把 `running_batch` 送去跑 decode。

- `python/sglang/srt/managers/scheduler.py:2906`
  —— `update_running_batch`：decode 前先过滤已完成请求、检查 KV 内存是否够用，
  必要时触发 retract（抢占部分 decode 请求、把它们退回 waiting queue）。

- `python/sglang/srt/managers/schedule_batch.py:2295-2341`
  —— `prepare_for_decode`（搜 `self.input_ids = self.output_ids`）：
  把上一步 output_ids 设为本步 input_ids，分配新 KV 槽，更新 seq_lens。

- `python/sglang/srt/model_executor/forward_batch_info.py:78-168`
  —— `ForwardMode` 枚举：`EXTEND`（prefill）、`DECODE`（decode）、`MIXED`
  （二者混合，chunked prefill 场景）的定义与判断方法。

- `python/sglang/srt/managers/scheduler_output_processor_mixin.py:468-566`
  —— `process_batch_result_decode`：decode 结果处理，逐请求追加 `output_ids`、
  调用 `check_finished`、调用 `_handle_finished_req`（触发 KV 释放）。

## 7. 分支与延伸

- 调度器如何决定哪些请求进入 decode batch、何时触发 retract、
  `new_token_ratio` 怎么控制 KV 内存压力
  → [第 08 章 调度器](08-scheduler.md)

- `ModelRunner` 如何区分 prefill 和 decode 前向、CUDA graph 为什么只能用于 decode
  → [第 09 章 ModelRunner](09-model-runner.md)

- 投机解码（speculative decoding）通过在 decode 阶段同时验证多个 draft token，
  把每次 decode 步骤的有效吞吐提升数倍，它的 verify 逻辑完全绕过标准 decode 路径
  → [第 12 章 投机解码](12-speculative-decoding.md)

- chunked prefill（`MIXED` 模式）允许把一个大 prefill 切成若干 chunk，
  和已有 decode 请求交错调度，降低长 prompt 对 decode 请求的延迟冲击
  → [第 08 章 调度器 §chunked prefill](08-scheduler.md)

## 8. 走完这一步你脑子里应该多了什么

1. **prefill 和 decode 的本质区别在于输入形状**：prefill 输入
   `[sum(prompt_lens)]` 个 token，decode 每步只输入 `[B]` 个 token（每请求 1 个），
   KV cache 让后者得以复用所有历史 KV，把每步计算量从 O(N²) 降到 O(S)。

2. **decode batch 是动态维护的 `running_batch`**：每轮调度循环里，
   `get_next_batch_to_run` 把上轮 prefill 完成的请求合并进 `running_batch`，
   再调用 `update_running_batch` 过滤已结束的请求，剩下的就是下一轮 decode 的成员。

3. **`prepare_for_decode` 是每轮 decode 的准备动作**：
   `output_ids → input_ids`、分配 1 个新 KV 槽、`seq_lens += 1`，
   三步合一，整个 batch 向量化完成，没有 Python 循环。

4. **decode 循环转几圈由 `check_finished` 决定**：每次 `process_batch_result_decode`
   都会为每个请求调用 `check_finished`，命中 `max_new_tokens`/EOS/stop_str
   任意一个就设置 `finished_reason`，下一轮 `update_running_batch` 会把它过滤掉。
   本例第 3 轮后 `len(output_ids)==3==max_new_tokens`，循环终止。
