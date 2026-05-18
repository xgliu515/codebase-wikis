# Trace 步骤 07 —— 会话是什么？为什么 prompt 要先 "sync" 一下？

## 1. 当前情境

`build_prompt` 已经把 "你好" 编码成约 15–20 个整数的 `ds4_tokens prompt`，
其中包含 BOS、system prompt 的 BPE token、`<｜User｜>`、"你好"的 BPE token、
`<｜Assistant｜>`、`<think>`。

执行流进入 `run_sampled_generation`（`ds4_cli.c:462`），第一行就是：

```c
if (ds4_session_create(&session, engine, cfg->gen.ctx_size) != 0) { ... }
```

此刻 `session = NULL`，`engine` 有效，`cfg->gen.ctx_size = 32768`。

## 2. 问题

这一步需要解决两件分开的事：

1. **会话是什么**：模型推理不是无状态的——每生成一个 token，KV 缓存就增长一行，
   下一个 token 的计算需要看到这一行。谁来持有这个可变的运行时状态？
2. **sync 的语义**：拿到 `ds4_tokens` 之后不能直接开始采样——模型必须先把所有
   prompt token 推进一遍前向（prefill），才能得到第一个生成 token 的 logits。
   但在 REPL 或服务器场景里，同一条前缀可能已经被上一次请求处理过，
   重做一遍是浪费。`sync` 的职责就是判断："需要全量 prefill，还是只做增量？"

## 3. 朴素思路

`engine` 里直接放一个 KV 缓存数组，每条请求调用一个 `engine_prefill(prompt)`，
函数里把 prompt 全部跑一遍，把 KV 缓存填好，返回 logits。
采样时再调 `engine_decode(token)` 追加新 token。

## 4. 为什么朴素思路会崩

把 KV 缓存放在 engine 里，意味着 engine 变成**可变**的，立刻打破多并发的安全性：

- **并发**：`ds4-server` 可能同时处理两条对话请求，两条请求各需要自己的 KV 缓存。
  若 engine 只有一个 KV 缓存，第二条请求会覆盖第一条的状态。
- **重用检测**：REPL 和服务器里，调用者每次都把**完整的 token 前缀**传进来，
  而不是增量。检测"这次前缀是上次的超集"这个逻辑需要保存上次的 checkpoint，
  而 checkpoint 是 per-session 的状态，不是 engine 级别的。
- **生命周期**：一条对话可能持续多轮，每轮都延伸同一个 KV 缓存；而 engine
  的生命周期是整个进程。把两个不同生命周期的对象混在一起只会让资源管理变复杂。

## 5. DwarfStar 4 的做法

DwarfStar 4 用一对严格分工的对象解决这些问题：

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4_engine immutable process-level object vs ds4_session mutable per-request object showing their fields">
  <defs>
    <marker id="ar7a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="10" width="330" height="260" rx="8" fill="#f1f5f9" stroke="#0d9488" stroke-width="2"/>
  <rect x="20" y="10" width="330" height="44" rx="8" fill="#0d9488"/>
  <rect x="20" y="44" width="330" height="10" fill="#0d9488"/>
  <text x="185" y="30" text-anchor="middle" font-size="13" font-weight="700" fill="white">ds4_engine</text>
  <text x="185" y="47" text-anchor="middle" font-size="11" fill="#99f6e4">不可变，进程级别</text>
  <text x="185" y="64" text-anchor="middle" font-size="10" fill="#64748b">自 ds4_engine_open 返回后只读</text>
  <line x1="50" y1="72" x2="50" y2="220" stroke="#94a3b8" stroke-width="1"/>
  <line x1="50" y1="86" x2="65" y2="86" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar7a)"/>
  <text x="75" y="90" font-size="11" fill="currentColor">ds4_model</text>
  <text x="220" y="90" font-size="10" fill="#64748b">mmap 句柄，张量目录</text>
  <line x1="50" y1="110" x2="65" y2="110" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar7a)"/>
  <text x="75" y="114" font-size="11" fill="currentColor">ds4_vocab</text>
  <text x="220" y="114" font-size="10" fill="#64748b">词表，merge ranks</text>
  <line x1="50" y1="134" x2="65" y2="134" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar7a)"/>
  <text x="75" y="138" font-size="11" fill="currentColor">ds4_weights</text>
  <text x="190" y="138" font-size="10" fill="#64748b">43 层权重指针（引用 mmap）</text>
  <line x1="50" y1="158" x2="65" y2="158" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar7a)"/>
  <text x="75" y="162" font-size="11" fill="currentColor">metal_ready</text>
  <text x="220" y="162" font-size="10" fill="#64748b">GPU 已初始化</text>
  <rect x="410" y="10" width="330" height="260" rx="8" fill="#f1f5f9" stroke="#ea580c" stroke-width="2"/>
  <rect x="410" y="10" width="330" height="44" rx="8" fill="#ea580c"/>
  <rect x="410" y="44" width="330" height="10" fill="#ea580c"/>
  <text x="575" y="30" text-anchor="middle" font-size="13" font-weight="700" fill="white">ds4_session</text>
  <text x="575" y="47" text-anchor="middle" font-size="11" fill="#fed7aa">可变，请求/对话级别</text>
  <text x="575" y="64" text-anchor="middle" font-size="10" fill="#64748b">每条对话独立持有，可并发</text>
  <line x1="440" y1="72" x2="440" y2="250" stroke="#94a3b8" stroke-width="1"/>
  <line x1="440" y1="86" x2="455" y2="86" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar7a)"/>
  <text x="465" y="90" font-size="11" fill="currentColor">graph</text>
  <text x="530" y="90" font-size="10" fill="#64748b">KV 缓存缓冲，中间张量</text>
  <line x1="440" y1="110" x2="455" y2="110" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar7a)"/>
  <text x="465" y="114" font-size="11" fill="currentColor">checkpoint</text>
  <text x="565" y="114" font-size="10" fill="#64748b">上次 sync 后的 token 前缀</text>
  <line x1="440" y1="134" x2="455" y2="134" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar7a)"/>
  <text x="465" y="138" font-size="11" fill="currentColor">logits</text>
  <text x="530" y="138" font-size="10" fill="#64748b">最后 token 的 vocab 分布</text>
  <line x1="440" y1="158" x2="455" y2="158" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar7a)"/>
  <text x="465" y="162" font-size="11" fill="currentColor">prefill_cap</text>
  <text x="565" y="162" font-size="10" fill="#64748b">本 session 的 ubatch 上限</text>
  <line x1="440" y1="182" x2="455" y2="182" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar7a)"/>
  <text x="465" y="186" font-size="11" fill="currentColor">ctx_size</text>
  <text x="540" y="186" font-size="10" fill="#64748b">逻辑窗口大小</text>
  <line x1="440" y1="206" x2="455" y2="206" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar7a)"/>
  <text x="465" y="210" font-size="11" fill="currentColor">checkpoint_valid</text>
  <text x="605" y="210" font-size="10" fill="#64748b">bool，是否有效</text>
  <line x1="350" y1="140" x2="408" y2="140" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar7a)"/>
  <text x="380" y="135" text-anchor="middle" font-size="9" fill="#94a3b8">持有引用</text>
</svg>
<span class="figure-caption">图 T7.1 ｜ ds4_engine（不可变，进程级）与 ds4_session（可变，请求级）的字段分工：engine 只读，多个 session 可并发安全地引用同一 engine</span>

<details>
<summary>ASCII 原版</summary>

```
ds4_engine（不可变，进程级别）
  |-- ds4_model    : mmap 句柄，张量目录
  |-- ds4_vocab    : 词表，merge ranks
  |-- ds4_weights  : 43 层权重指针（引用 mmap）
  |-- metal_ready  : GPU 已初始化
  自 ds4_engine_open 返回后只读

ds4_session（可变，请求/对话级别）
  |-- ds4_gpu_graph graph : KV 缓存缓冲，所有中间张量
  |-- token_vec checkpoint: 上次 sync 后的完整 token 前缀
  |-- float *logits       : 最后一个 token 的 vocab 分布
  |-- uint32_t prefill_cap: 本 session 的 ubatch 上限
  |-- int ctx_size        : 逻辑窗口大小
  |-- bool checkpoint_valid
```

</details>

**`ds4_session_create`**（`ds4.c:17308`）为新会话分配上述所有可变状态：

- 调用 `metal_graph_prefill_cap_for_prompt(ctx_size)` 算出 prefill ubatch 上限。
- 调用 `metal_graph_raw_cap_for_context(ctx_size, prefill_cap)` 算出 raw SWA 容量。
- 调用 `metal_graph_alloc_raw_cap` 分配 43 层 KV 缓存缓冲、所有中间激活张量、
  HC 状态张量、logits 缓冲。
- 返回时 `session->checkpoint_valid = false`，KV 缓存全零/全负无穷（已填充初值）。

**`ds4_session_sync`**（`ds4.c:17415`）把会话的活跃后端状态带到给定的完整 token 前缀。
这是整个推理流程里**唯一决定"做多少工作"的地方**。判断逻辑如下：

<svg viewBox="0 0 640 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4_session_sync decision tree: full prefill vs incremental prefill vs short-tail decode paths">
  <defs>
    <marker id="ar7b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="160" y="10" width="320" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="25" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">ds4_session_sync</text>
  <text x="320" y="42" text-anchor="middle" font-size="10" fill="#64748b">(session, prompt, err, errlen)</text>
  <line x1="320" y1="50" x2="320" y2="80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7b)"/>
  <polygon points="320,80 480,120 320,160 160,120" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="320" y="113" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">checkpoint_valid</text>
  <text x="320" y="128" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">&amp;&amp; prompt 以 checkpoint 为前缀？</text>
  <line x1="160" y1="120" x2="80" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7b)"/>
  <text x="120" y="113" text-anchor="middle" font-size="10" fill="#dc2626">NO</text>
  <rect x="10" y="100" width="70" height="44" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="45" y="118" text-anchor="middle" font-size="10" font-weight="600" fill="#dc2626">全量</text>
  <text x="45" y="131" text-anchor="middle" font-size="10" fill="#dc2626">prefill</text>
  <text x="45" y="144" text-anchor="middle" font-size="9" fill="#94a3b8">冷启动路径</text>
  <line x1="480" y1="120" x2="560" y2="120" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <text x="520" y="113" text-anchor="middle" font-size="10" fill="#16a34a">YES</text>
  <text x="320" y="160" text-anchor="middle"/>
  <line x1="320" y1="160" x2="320" y2="186" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7b)"/>
  <rect x="140" y="186" width="360" height="32" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="320" y="201" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">suffix = prompt→len − checkpoint→len</text>
  <text x="320" y="213" text-anchor="middle" font-size="10" fill="#64748b">计算未处理的后缀长度</text>
  <line x1="320" y1="218" x2="320" y2="246" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7b)"/>
  <polygon points="320,246 480,278 320,310 160,278" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="320" y="270" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">suffix &gt;= resume_min</text>
  <text x="320" y="285" text-anchor="middle" font-size="10" fill="#64748b">（约 32 token）？</text>
  <line x1="160" y1="278" x2="80" y2="278" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7b)"/>
  <text x="120" y="271" text-anchor="middle" font-size="10" fill="#dc2626">NO</text>
  <rect x="10" y="258" width="70" height="44" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
  <text x="45" y="276" text-anchor="middle" font-size="10" font-weight="600" fill="#dc2626">短尾</text>
  <text x="45" y="289" text-anchor="middle" font-size="10" fill="#dc2626">decode</text>
  <text x="45" y="302" text-anchor="middle" font-size="9" fill="#94a3b8">逐 token 追加</text>
  <line x1="480" y1="278" x2="560" y2="278" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <text x="520" y="271" text-anchor="middle" font-size="10" fill="#16a34a">YES</text>
  <line x1="320" y1="310" x2="320" y2="340" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7b)"/>
  <rect x="120" y="340" width="400" height="32" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="320" y="358" text-anchor="middle" font-size="12" font-weight="700" fill="#16a34a">增量 batched prefill（只处理 suffix 部分）</text>
</svg>
<span class="figure-caption">图 T7.2 ｜ ds4_session_sync 的三条执行路径：前缀不匹配→全量 prefill（冷启动）；后缀短→逐 token decode（短尾）；后缀长→增量 batched prefill</span>

<details>
<summary>ASCII 原版</summary>

```
ds4_session_sync(session, prompt, err, errlen)
        |
        v
  checkpoint_valid && prompt 以 checkpoint 为前缀？
        |
   YES  |  NO
        |   +---> 丢弃 checkpoint，全量 prefill（冷启动路径）
        v
  suffix = prompt->len - checkpoint->len
        |
   suffix >= resume_min（约 32）?
        |
   YES  |  NO
        |   +---> 单 token decode 逐个追加（短尾路径）
        v
  batched prefill 只处理 suffix 部分（增量路径）
```

</details>

对这条 trace，`session` 刚建好，`checkpoint_valid = false`——**直接走全量 prefill**。
`sync` 调用返回后：

- 全部 prompt token 走完 43 层前向（prefill）；
- `session->checkpoint` 变为当前 prompt 的完整副本，`checkpoint_valid = true`；
- `session->logits` 存着最后一个 token（即 `<think>`）的 logits 向量，
  长度 `DS4_N_VOCAB = 129280`；
- `ds4_session_pos(session) == prompt->len`，下一个生成位置已就绪。

## 6. 代码位置

按阅读顺序：

- `ds4_cli.c:462` —— `run_sampled_generation()`，第一行 `ds4_session_create`，
  第 487 行 `ds4_session_sync`。
- `ds4.h:151` —— `ds4_session_create` 公开声明。
- `ds4.h:166` —— `ds4_session_sync` 公开声明，注释说明"checkpoint 是前缀时只做增量"。
- `ds4.c:15715` —— `struct ds4_session` 定义，展示所有可变字段。
- `ds4.c:17308` —— `ds4_session_create` 实现；`17330` 是 `metal_graph_alloc_raw_cap` 调用。
- `ds4.c:17400` —— `ds4_session_sync` 的块注释，详细说明三条执行路径（全量 / 增量批 / 短尾 decode）。
- `ds4.c:17415` —— `ds4_session_sync` 实现入口；`17469` 是前缀匹配判断；
  `17521–17537` 是全量 prefill 的 `prefill_cap` vs `chunked` 分支。

## 7. 分支与延伸

- engine vs session 分工的详细设计，以及服务器多请求并发时各 session 如何独立
  持有 KV 缓存 →
  [第 6 章 引擎与会话](06-engine-session.md)
- sync 里"短尾路径"用到的单 token decode（`metal_graph_eval_token_raw_swa`），
  以及"增量批 prefill"里 checkpoint 对齐到 chunk 边界的原因 →
  [第 6 章 §session_sync 路径选择](06-engine-session.md)
- 磁盘 KV 缓存（`ds4_session_save_payload` / `ds4_session_load_payload`）如何让
  server 跨进程复用已有 checkpoint，以及 sync 在有磁盘快照时的降级策略 →
  [第 14 章 磁盘 KV 缓存](14-disk-kv-cache.md)
- `metal_graph_alloc_raw_cap` 里 `raw_cap / comp_cap / prefill_cap` 三个容量参数的
  计算，以及各层压缩比（ratio==4 的 indexer 层）对内存分配的影响 →
  [第 10 章 Metal 与 CUDA 后端](10-metal-backend.md)

## 8. 走完这一步你脑子里应该多了什么

1. **engine 不可变，session 可变**：KV 缓存、中间激活、logits 全在 session 里；
   engine 从 `ds4_engine_open` 返回后就是只读的，多个 session 可并发安全地持有同一个 engine 指针。
2. `ds4_session_sync` 的核心思想是**前缀复用**：调用者每次传入完整的 token 前缀，
   sync 自己检测 checkpoint 是否匹配，决定做全量 prefill 还是增量；调用者不需要跟踪
   "上次处理到哪里"。
3. 这条 trace 是**冷启动**：session 刚建好，`checkpoint_valid = false`，
   sync 直接走全量 prefill，把所有 prompt token 一起推进 43 层。
4. sync 返回后，`session->logits` 就是 prompt 最后一个 token 的 next-token logits，
   采样器（步骤 14）可以直接从这里采出第一个生成 token。
5. `checkpoint` 是一个 token id 数组（`token_vec`）而非字符串——它记录的是上次
   sync 时处理过的完整 token 序列，是下次调用 sync 时前缀匹配的依据。
