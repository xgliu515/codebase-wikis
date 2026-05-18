# Trace 步骤 18 —— 命中停止条件后，文本怎么回到用户手里？

## 1. 当前情境

第 3 轮 decode 刚跑完。`req.output_ids = [<" Paris">, <".">, <token3>]`，长度为 3。
`process_batch_result_decode` 在逐请求做后处理时调用了 `req.check_finished()`
（`python/sglang/srt/managers/scheduler_output_processor_mixin.py:564`）。

模型仍在 GPU 上待机，KV cache 里保存着 prompt + 3 个 output token 的全量 KV。
此刻有三件事还没完成：

- 请求有没有被判定为"结束"？
- `[<" Paris">, <".">, <token3>]` 这串 token id 怎么变回字符串 `" Paris."`？
- KV cache 怎么处理——释放还是保留供下次复用？

## 2. 问题

判定结束、释放内存、detokenize、把结果跨进程发回给用户——这四件事必须在正确的顺序、
正确的进程里发生。具体难点是：

- **停止条件不止一种**：`max_new_tokens`、EOS token、`stop` 字符串、grammar 终止——
  每种都有不同的判定时机，有的要在采样后立即判、有的要等几个 token 拼完才能匹配；
- **KV 不能无脑释放**：如果未来有相同 prompt 的请求，能复用这段 KV 就不用重算；
  但如果不释放，显存会耗尽；
- **detokenize 是 CPU 操作，不能阻塞 GPU 的推理**：所以必须在独立进程里异步做；
- **结果必须跨三个进程边界回到用户**：Scheduler → DetokenizerManager → TokenizerManager → 用户。

## 3. 朴素思路

在 Scheduler 进程里，检查完结束条件后，直接调用 tokenizer 的 `decode` 方法把
token id 转回字符串，再通过某种 RPC 发给用户。

逻辑直接，省去了中间进程。

## 4. 为什么朴素思路会崩

**阻塞 GPU pipeline**。tokenizer 的 `batch_decode` 是 CPU 密集操作，调用一次
HuggingFace fast tokenizer 对几百个 token 解码可能需要几毫秒。在这几毫秒里，
GPU 完全空转——下一个 batch 没法及时准备好。系统吞吐直接打折。

**Scheduler 进程不能持有重型对象**。Scheduler 是单线程事件循环，任何耗时操作
都会让整个调度暂停。词表 128 K 的 tokenizer 光是加载就要占几百 MB，再让它常驻
Scheduler 进程里是对内存的浪费。

**没有增量解码（incremental decode）的地方**。流式输出（streaming）要求每生成一个
token 就发一次文本片段。`Scheduler` 不知道怎么增量处理 `"▁Paris"` → `"Paris"` 这种
byte-pair 边界问题——它需要一个有状态的 `DecodeStatus` 来跟踪 surr_offset / read_offset。

## 5. SGLang 的做法

**阶段一：Scheduler 判定结束**

`req.check_finished`（`python/sglang/srt/managers/schedule_batch.py:1203`）
按优先级逐项检查：

<svg viewBox="0 0 620 296" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="check_finished priority-ordered branch checks">
<defs>
<marker id="t18ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="30" y="120" width="120" height="46" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="90" y="140" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">check_</text>
<text x="90" y="156" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">finished()</text>
<line x1="150" y1="143" x2="186" y2="34" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#t18ar)"/>
<line x1="150" y1="143" x2="186" y2="92" stroke="#16a34a" stroke-width="1.6" marker-end="url(#t18ar)"/>
<line x1="150" y1="143" x2="186" y2="150" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#t18ar)"/>
<line x1="150" y1="143" x2="186" y2="208" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#t18ar)"/>
<line x1="150" y1="143" x2="186" y2="266" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#t18ar)"/>
<rect x="188" y="14" width="320" height="38" rx="5" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="200" y="38" font-size="10" fill="currentColor">① to_finish 被外部设置（abort / timeout）</text>
<text x="600" y="38" text-anchor="end" font-size="10" fill="#64748b">FINISH_ABORT</text>
<rect x="188" y="72" width="320" height="38" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
<text x="200" y="96" font-size="10" fill="currentColor">② len(output_ids) ≥ max_new_tokens　← 本例</text>
<text x="600" y="96" text-anchor="end" font-size="10" font-weight="600" fill="#16a34a">FINISH_LENGTH</text>
<rect x="188" y="130" width="320" height="38" rx="5" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="200" y="154" font-size="10" fill="currentColor">③ grammar 终止</text>
<text x="600" y="154" text-anchor="end" font-size="10" fill="#64748b">FINISH_MATCHED_TOKEN</text>
<rect x="188" y="188" width="320" height="38" rx="5" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="200" y="212" font-size="10" fill="currentColor">④ 最新 token 命中 stop token set</text>
<text x="600" y="212" text-anchor="end" font-size="10" fill="#64748b">FINISH_MATCHED_TOKEN</text>
<rect x="188" y="246" width="320" height="38" rx="5" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="200" y="270" font-size="10" fill="currentColor">⑤ 近若干 token 拼接匹配 stop string</text>
<text x="600" y="270" text-anchor="end" font-size="10" fill="#64748b">FINISH_MATCHED_STR</text>
</svg>
<span class="figure-caption">图 T18.1 ｜ check_finished 按优先级逐项检查结束条件；本例命中 ② max_new_tokens → FINISH_LENGTH</span>

<details>
<summary>ASCII 原版</summary>

```text
check_finished()
  │
  ├─ 1. to_finish 被外部设置？(abort / timeout)  → FINISH_ABORT
  │
  ├─ 2. len(output_ids) >= max_new_tokens ?      → FINISH_LENGTH   ← 本例走这里
  │
  ├─ 3. grammar 终止？                            → FINISH_MATCHED_TOKEN
  │
  ├─ 4. 最新 token 命中 stop token set？          → FINISH_MATCHED_TOKEN
  │
  └─ 5. 最近几个 token 拼起来匹配 stop string？  → FINISH_MATCHED_STR
```

</details>

本例 `len(output_ids) == 3 == max_new_tokens`，在第 2 条命中，
`req.finished_reason = FINISH_LENGTH(length=3)`。

**阶段二：KV cache 释放与复用决策**

`_handle_finished_req`（`scheduler_output_processor_mixin.py:634`）
在请求结束时调用 `release_kv_cache(req, self.tree_cache)`
（`python/sglang/srt/mem_cache/common.py:566`）。

```text
release_kv_cache(req, tree_cache)
  │
  └─ tree_cache.cache_finished_req(req, is_insert=True)
         │
         │  token_ids = origin_input_ids + output_ids  (prompt + 3 output)
         │  key       = RadixKey(token_ids).page_aligned(page_size)
         │
         ├─[is_insert=True]  tree_cache.insert(key, kv_indices)
         │     → 把这段 KV 挂进 radix tree，供未来相同 prefix 的请求复用
         │     → 释放 tree 里已有的重复 KV（prefix 命中部分）
         │
         └─ token_to_kv_pool_allocator.free(overallocated_tail)
               → 释放 page 对齐之外的尾部 KV 槽（若有）
```

对于本例（首次请求，radix tree 为空），`insert` 会把 prompt + 3 output token
的 KV 节点插入 radix tree，并将 lock_ref 降为 0（可被 LRU 淘汰）。
未来如果有相同 prompt 的新请求，步骤 10 的 `match_prefix` 就能命中这里，
直接跳过 prefill。

```text
radix tree（释放后）：
  root
  └── "The capital of France is" → " Paris" → "."
       [KV indices 仍在显存，ref=0，可被 LRU 淘汰]
```

**阶段三：Scheduler → DetokenizerManager**

`stream_output_generation`（`scheduler_output_processor_mixin.py:1264`）
把结束的请求打包成 `BatchTokenIDOutput`，通过 ZMQ PUSH socket 发给
`DetokenizerManager` 进程。关键字段：

- `rids`：请求 id 列表；
- `decode_ids`：`output_ids`（token id 列表）；
- `finished_reasons`：`FINISH_LENGTH.to_json()`；
- `read_offsets`：用于增量解码的偏移。

**阶段四：DetokenizerManager detokenize**

`DetokenizerManager.event_loop`（`python/sglang/srt/managers/detokenizer_manager.py:145`）
收到 `BatchTokenIDOutput` 后，进入 `handle_batch_token_id_out`，核心逻辑在
`_decode_batch_token_id_output`（第 231 行）：

```text
BatchTokenIDOutput
  │
  ├─ 1. 查 / 建 DecodeStatus (per-rid 有状态对象)
  │       decode_ids   = output_ids
  │       read_offset  = 上次已读到的位置
  │       surr_offset  = 用于处理 byte-pair 边界的辅助偏移
  │
  ├─ 2. trim_matched_stop()  去掉 stop token/string（若有）
  │
  ├─ 3. tokenizer.batch_decode(read_ids) → read_texts
  │       tokenizer.batch_decode(surr_ids) → surr_texts
  │
  ├─ 4. new_text = read_texts[i][len(surr_texts[i]):]
  │       (增量解码：减去 surrogate 前缀，得到本轮新增文本)
  │
  └─ 5. finished: del decode_status[rid]  (清理状态)
         output_str = s.decoded_text + new_text = " Paris."
```

结果打包成 `BatchStrOutput`，通过 ZMQ PUSH 发给 `TokenizerManager`。

**阶段五：TokenizerManager → 用户**

`TokenizerManager` 收到 `BatchStrOutput`，找到对应请求的 asyncio future，
调用 `future.set_result({"text": " Paris.", ...})`。`Engine.generate`
内部的 `asyncio.run(...)` 等到 future 就绪，把结果返回给用户。

<svg viewBox="0 0 660 220" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Result return path from Scheduler back to engine.generate">
<defs>
<marker id="t18br" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="20" y="40" width="160" height="56" rx="8" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.4"/>
<text x="100" y="64" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Scheduler</text>
<text x="100" y="83" text-anchor="middle" font-size="10" fill="#64748b">产出 token ids</text>
<line x1="180" y1="68" x2="240" y2="68" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#t18br)"/>
<text x="210" y="58" text-anchor="middle" font-size="9" fill="#94a3b8">ZMQ</text>
<rect x="242" y="40" width="170" height="56" rx="8" fill="#f1f5f9" stroke="#7c3aed" stroke-width="1.4"/>
<text x="327" y="64" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">DetokenizerManager</text>
<text x="327" y="83" text-anchor="middle" font-size="10" fill="#64748b">token ids → 文本</text>
<line x1="412" y1="68" x2="472" y2="68" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#t18br)"/>
<text x="442" y="58" text-anchor="middle" font-size="9" fill="#94a3b8">ZMQ</text>
<rect x="474" y="40" width="170" height="56" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="559" y="64" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">TokenizerManager</text>
<text x="559" y="83" text-anchor="middle" font-size="10" fill="#64748b">收 BatchStrOutput</text>
<line x1="559" y1="96" x2="559" y2="124" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t18br)"/>
<rect x="430" y="126" width="258" height="34" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="559" y="147" text-anchor="middle" font-size="11" fill="currentColor">future.set_result(...)</text>
<line x1="559" y1="160" x2="559" y2="180" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t18br)"/>
<rect x="400" y="182" width="318" height="34" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
<text x="559" y="203" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">engine.generate() 返回 {"text": " Paris."}</text>
</svg>
<span class="figure-caption">图 T18.2 ｜ 结果回流：Scheduler → Detokenizer → TokenizerManager，经 future 交还 engine.generate</span>

<details>
<summary>ASCII 原版</summary>

```text
Scheduler ──ZMQ PUSH──► DetokenizerManager ──ZMQ PUSH──► TokenizerManager
  (token ids)                 (decode)              (BatchStrOutput)      │
                                                                          │
                                                                  future.set_result()
                                                                          │
                                                                    engine.generate()
                                                                    返回 {"text": " Paris."}
```

</details>

## 6. 代码位置

按阅读顺序：

- `python/sglang/srt/managers/schedule_batch.py:1203-1232`
  —— `Req.check_finished`：停止条件判定的完整逻辑，
  `FINISH_LENGTH` 判断在第 1212-1216 行。

- `python/sglang/srt/managers/schedule_batch.py:133-190`
  —— `FINISH_MATCHED_TOKEN`、`FINISH_MATCHED_STR`、`FINISH_LENGTH`、`FINISH_ABORT`
  的定义及 `to_json`，对应 OpenAI API 的 `finish_reason` 字段。

- `python/sglang/srt/managers/scheduler_output_processor_mixin.py:634-661`
  —— `_handle_finished_req`：请求结束时的收尾逻辑，调用 `release_kv_cache`。

- `python/sglang/srt/mem_cache/common.py:566-619`
  —— `release_kv_cache`：决定是否插入 radix tree，再释放尾部 overallocated KV。

- `python/sglang/srt/mem_cache/radix_cache.py:440-486`
  —— `RadixCache.cache_finished_req`：实际把 KV index 插入 radix tree 的逻辑，
  第 466-474 行是 `is_insert=True` 的 insert 路径，第 484-485 行释放 lock_ref。

- `python/sglang/srt/managers/scheduler_output_processor_mixin.py:1264-1309`
  —— `stream_output_generation`（或其调用点）：构建 `BatchTokenIDOutput`
  并发给 DetokenizerManager。

- `python/sglang/srt/managers/detokenizer_manager.py:231-334`
  —— `_decode_batch_token_id_output`：incremental detokenize 的核心，
  `DecodeStatus` 的 surr_offset / read_offset 滑动窗口在第 257、314-315 行更新。

## 7. 分支与延伸

- `DetokenizerManager` 的进程架构、与 `TokenizerManager` 的 ZMQ 通道、
  `DecodeStatus` 状态的生命周期
  → [第 04 章 DetokenizerManager](04-engine-and-processes.md)

- `RadixCache.cache_finished_req` 把 KV 节点插入 radix tree 后，如何在显存不足时
  被 LRU 淘汰（`evict` / `dec_lock_ref`）、哪些节点受保护不可淘汰
  → [第 06 章 前缀缓存淘汰](06-radix-cache.md)

- `Scheduler` 在批量结束时如何一次性打包多个请求的 `BatchTokenIDOutput`、
  流式输出（streaming=True）下如何在每个 decode step 都发一次增量文本
  → [第 08 章 调度器](08-scheduler.md)

- stop 字符串的多 token 匹配（`_check_str_based_finish`）与
  `finished_len` 截断（避免把 stop string 本身包含在输出里）的细节
  → [第 11 章 采样与约束解码 §stop conditions](11-sampling-constrained.md)

## 8. 走完这一步你脑子里应该多了什么

1. **停止条件有优先级顺序**：`to_finish`（外部中止）> `max_new_tokens` >
   grammar 终止 > stop token > stop string。本例在 `max_new_tokens=3` 处命中
   `FINISH_LENGTH`，后面的条件不再检查。

2. **KV 释放不等于清空显存**：`cache_finished_req` 把 KV 节点插入 radix tree，
   ref 降为 0 但数据还在显存里，等价于"放进 LRU 池"——未来相同 prefix 的请求
   直接命中、跳过 prefill；只有显存不足时 LRU 淘汰才会真正 free 这些槽。

3. **detokenize 在独立进程里异步完成**：Scheduler 只发 token id，不调用 tokenizer，
   不阻塞 GPU pipeline。`DetokenizerManager` 用 `DecodeStatus` 维护 per-request 的
   incremental decode 状态，处理 byte-pair 边界带来的 `"▁"` 前缀问题。

4. **结果跨三个进程边界回到用户**：Scheduler → DetokenizerManager（token id → 文本）
   → TokenizerManager（文本 → asyncio future）→ `engine.generate()` 返回值。
   每一跳都是 ZMQ PUSH/PULL，异步、无阻塞。

5. **trace 在这里闭环**：`engine.generate("The capital of France is", ...)` 返回
   `{"text": " Paris."}`，整条 18 步路径——入口参数化 → 分词 → IPC → 调度 → 前缀匹配 →
   KV 分配 → prefill → 注意力 → 采样 → decode 循环 → 结束判定 → detokenize → 返回——
   首尾相接，每一步的输出恰好是下一步的输入。
