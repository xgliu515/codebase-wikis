# 第 14 章：磁盘 KV 缓存与会话持久化

> 代码版本：antirez/ds4@c9dd949（2026-05-18）  
> 相关章节：[第 13 章 HTTP 服务器与 Agent API](13-http-server-api.md) · [第 6 章 引擎会话](06-engine-session.md)

---

## 14.1 设计哲学

DS4 的 KV 缓存经过极度压缩——DeepSeek V4 Flash 使用 MLA（Multi-Head Latent Attention）将每层的 KV 状态压缩到远低于传统 MHA 的体积。与此同时，现代 SSD（尤其是 MacBook 内置 NVMe）的顺序读写带宽通常可以在几秒内完成数 GB 的传输。

`ds4_server.c:8151` 的注释道出了这一设计的核心洞察：

```c
/* The server has one live Metal session.  We persist reusable DS4 session
 * snapshots when a cold prompt reaches a useful prefix, when a long continued
 * conversation has grown far enough, and when a request evicts the live session.
 * The cache key is the SHA1 of the rendered byte prefix.  The payload still
 * stores exact token IDs and graph state; the filename only selects a checkpoint
 * whose decoded transcript bytes are a prefix of the next rendered request.
 *
 * Files are loaded with plain read/write I/O into the existing graph tensors;
 * mmap is deliberately avoided here so cache restore cannot add more VM
 * mappings to a process that already maps a very large GGUF. */
```

README 的核心论断："the KV cache is actually a first-class disk citizen"——这不只是工程优化，而是架构立场。对于 local agent 会话来说，只要 prompt 不变，磁盘上的 KV 状态与 RAM 中的状态一样有价值。

---

## 14.2 职责划分：服务器 vs 引擎

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Responsibility split between ds4_server.c and ds4.c for disk KV cache">
  <defs>
    <marker id="ar141" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="20" width="320" height="196" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="180" y="44" font-size="13" font-weight="700" fill="#ea580c" text-anchor="middle">ds4_server.c</text>
  <text x="180" y="60" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">KVC 文件 header 格式</text>
  <text x="40" y="76" font-size="10" fill="#64748b">• magic、version、quant bits</text>
  <text x="40" y="90" font-size="10" fill="#64748b">• token count、hit count</text>
  <text x="40" y="104" font-size="10" fill="#64748b">• context size、creation / last-used</text>
  <text x="40" y="118" font-size="10" fill="#64748b">• SHA1 文件名策略</text>
  <text x="40" y="132" font-size="10" fill="#64748b">• 预算 / 淘汰策略</text>
  <text x="40" y="146" font-size="10" fill="#64748b">• tool-id map 附加 section</text>
  <rect x="420" y="20" width="320" height="196" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="580" y="44" font-size="13" font-weight="700" fill="#0d9488" text-anchor="middle">ds4.c</text>
  <text x="580" y="60" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">DS4 特化的序列化图状态</text>
  <text x="440" y="76" font-size="10" fill="#64748b">• token IDs + 逐层张量数据</text>
  <text x="440" y="90" font-size="10" fill="#64748b">• raw SWA 缓存行</text>
  <text x="440" y="104" font-size="10" fill="#64748b">• compressed KV 缓存行</text>
  <text x="440" y="118" font-size="10" fill="#64748b">• attn_state（压缩器状态）</text>
  <text x="440" y="132" font-size="10" fill="#64748b">• indexer state（ratio-4 层）</text>
  <text x="440" y="146" font-size="10" fill="#64748b">• logits（最后 N_VOCAB float）</text>
  <line x1="340" y1="120" x2="420" y2="120" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4,3"/>
  <rect x="200" y="232" width="360" height="52" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="380" y="250" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">公共接口（ds4.h）</text>
  <text x="380" y="264" font-size="10" fill="#64748b" text-anchor="middle">ds4_session_payload_bytes(s)</text>
  <text x="380" y="278" font-size="10" fill="#64748b" text-anchor="middle">ds4_session_save_payload / ds4_session_load_payload</text>
  <line x1="180" y1="216" x2="320" y2="232" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar141)"/>
  <line x1="580" y1="216" x2="440" y2="232" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar141)"/>
</svg>
<span class="figure-caption">图 R14.1 ｜ 职责划分：ds4_server.c 负责文件头格式与淘汰策略，ds4.c 负责张量序列化，两侧通过公共接口对接</span>

<details>
<summary>ASCII 原版</summary>

```
ds4_server.c                         ds4.c
─────────────────────                ─────────────────────────
KVC 文件 header 格式                  DS4 特化的序列化图状态
  magic、version、quant bits          token IDs + 逐层张量数据
  token count、hit count              raw SWA 缓存行
  context size、creation/last-used    compressed KV 缓存行
  SHA1 文件名策略                      attn_state（压缩器状态）
  预算/淘汰策略                         indexer state（ratio-4 层）
  tool-id map 附加 section             logits（最后 N_VOCAB float）

公共接口（ds4.h）：
  ds4_session_payload_bytes(s)
  ds4_session_save_payload(s, fp, err, errlen)
  ds4_session_load_payload(s, fp, payload_bytes, err, errlen)
```

</details>

这种职责划分保证了 `ds4_server.c` 不需要了解任何张量的内部布局，而引擎侧代码也不需要了解文件名命名规则或磁盘预算策略。

---

## 14.3 引擎侧：payload 序列化

### 14.3.1 精确 payload 大小

`ds4.c:15858` 的 `session_payload_live_tensor_bytes()` 根据 live 状态（而不是容量上限）计算精确字节数：

```c
/* Return the exact engine-owned payload size, excluding the server's KVC file
 * header and observability text.  This is deliberately based on live row counts
 * rather than capacities so the disk cache scales with saved tokens, not with
 * the maximum context size used to allocate the graph. */
static uint64_t session_payload_live_tensor_bytes(const ds4_gpu_graph *g, uint32_t checkpoint_len) {
    uint64_t bytes = 0;
    const uint32_t raw_live = session_raw_live_rows(g, checkpoint_len);
    for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
        bytes += (uint64_t)raw_live * DS4_N_HEAD_DIM * sizeof(float);
        const uint32_t ratio = ds4_layer_compress_ratio(il);
        if (ratio == 0) continue;
        bytes += (uint64_t)g->layer_n_comp[il] * DS4_N_HEAD_DIM * sizeof(float);
        bytes += layer_attn_state_bytes(ratio);
        bytes += layer_attn_state_bytes(ratio);
        if (ratio == 4) {
            bytes += (uint64_t)g->layer_n_index_comp[il] * DS4_N_INDEXER_HEAD_DIM * sizeof(float);
            bytes += layer_index_state_bytes(ratio);
            bytes += layer_index_state_bytes(ratio);
        }
    }
    return bytes;
}
```

**只需最后 SWA 行**（`ds4.c:15846`）：raw KV 缓存（SWA 窗口缓存）只保存最后 `DS4_N_SWA`（128）行，因为下一次 suffix 写入会自己建立新行，无需更早的 raw 数据。compressed KV 行则保存全部，因为稀疏 attention 可以选择任意历史行。

### 14.3.2 固定缓冲拷贝

`ds4.c:15881` 的注释说明了为什么不用 mmap：

```c
/* Metal tensors are copied through a fixed-size CPU buffer.  We do not mmap the
 * cache file and we do not allocate a second graph-sized blob just to serialize
 * it; both would be poor fits for this very large model. */
```

Metal GPU 张量通过一个固定大小的 CPU 缓冲区逐步复制到文件，避免了为整个 payload 分配第二块内存。读取时同样通过固定缓冲区写入已分配的 GPU 张量，不添加额外的 VM 映射。

### 14.3.3 payload 二进制格式（GPU 路径）

<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="DS4 session payload binary format memory layout">
  <defs>
    <marker id="ar142" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="10" width="540" height="36" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="290" y="24" font-size="11" font-weight="700" fill="#7c3aed" text-anchor="middle">header: DS4_SESSION_PAYLOAD_U32_FIELDS × uint32_t</text>
  <text x="290" y="38" font-size="9" fill="#64748b" text-anchor="middle">MAGIC · VERSION · ctx_size · prefill_cap · raw_cap · comp_cap · checkpoint_len · N_LAYER · N_HEAD_DIM · N_INDEXER_HEAD_DIM · N_VOCAB · raw_live</text>
  <rect x="20" y="54" width="540" height="26" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="290" y="71" font-size="10" fill="#ea580c" font-weight="600" text-anchor="middle">checkpoint token IDs: checkpoint_len × uint32_t</text>
  <rect x="20" y="86" width="540" height="26" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="290" y="103" font-size="10" fill="#ea580c" font-weight="600" text-anchor="middle">logits: N_VOCAB × float32（最后一个 token 的 logit）</text>
  <rect x="20" y="118" width="540" height="26" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="290" y="135" font-size="10" fill="#64748b" text-anchor="middle">per-layer 压缩行计数: N_LAYER × uint32_t  (n_comp)</text>
  <rect x="20" y="150" width="540" height="26" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="290" y="167" font-size="10" fill="#64748b" text-anchor="middle">per-layer indexer 压缩行计数: N_LAYER × uint32_t  (n_index_comp)</text>
  <text x="290" y="194" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">per-layer 张量数据（43 层迭代）</text>
  <rect x="20" y="202" width="540" height="26" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="290" y="219" font-size="10" fill="#0d9488" font-weight="600" text-anchor="middle">raw KV: raw_live × N_HEAD_DIM × float32</text>
  <rect x="40" y="234" width="500" height="26" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3,2"/>
  <text x="290" y="251" font-size="10" fill="#64748b" text-anchor="middle">[compressed layers only]</text>
  <rect x="60" y="266" width="460" height="22" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="290" y="281" font-size="10" fill="#0d9488" text-anchor="middle">comp KV: n_comp × N_HEAD_DIM × float32</text>
  <rect x="60" y="294" width="220" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="170" y="309" font-size="10" fill="#64748b" text-anchor="middle">attn_state K: layer_attn_state_bytes(ratio)</text>
  <rect x="300" y="294" width="220" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="410" y="309" font-size="10" fill="#64748b" text-anchor="middle">attn_state V: layer_attn_state_bytes(ratio)</text>
  <rect x="80" y="322" width="440" height="22" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1" stroke-dasharray="3,2"/>
  <text x="300" y="337" font-size="10" fill="#ea580c" text-anchor="middle">[ratio==4 only]</text>
  <rect x="100" y="350" width="420" height="22" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="310" y="365" font-size="10" fill="#ea580c" text-anchor="middle">index_comp: n_index_comp × N_INDEXER_HEAD_DIM × float32</text>
  <rect x="100" y="378" width="420" height="22" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="310" y="393" font-size="10" fill="#ea580c" text-anchor="middle">index_state K/V: layer_index_state_bytes(4)</text>
  <line x1="600" y1="10" x2="600" y2="400" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3,2"/>
  <text x="620" y="46" font-size="9" fill="#94a3b8" transform="rotate(90,620,46)" text-anchor="middle">固定头</text>
  <text x="635" y="130" font-size="9" fill="#94a3b8" transform="rotate(90,635,130)" text-anchor="middle">全局计数</text>
  <text x="650" y="300" font-size="9" fill="#94a3b8" transform="rotate(90,650,300)" text-anchor="middle">逐层张量</text>
</svg>
<span class="figure-caption">图 R14.2 ｜ payload 二进制格式内存布局：固定头 → token IDs → logits → 全局计数 → 43 层逐层张量</span>

<details>
<summary>ASCII 原版</summary>

```
header: DS4_SESSION_PAYLOAD_U32_FIELDS 个 uint32_t
  └── MAGIC、VERSION、ctx_size、prefill_cap、raw_cap、comp_cap
      checkpoint_len、N_LAYER、N_HEAD_DIM、N_INDEXER_HEAD_DIM、N_VOCAB、raw_live

checkpoint token IDs: checkpoint_len × uint32_t

logits: N_VOCAB × float32（最后一个 token 的 logit）

per-layer 压缩行计数: N_LAYER × uint32_t (n_comp)
per-layer indexer 压缩行计数: N_LAYER × uint32_t (n_index_comp)

per-layer 张量数据（43 层迭代）：
  raw KV: raw_live × N_HEAD_DIM × float32
  [compressed layers only]:
    comp KV: n_comp × N_HEAD_DIM × float32
    attn_state K: layer_attn_state_bytes(ratio)
    attn_state V: layer_attn_state_bytes(ratio)
    [ratio==4 only]:
      index_comp: n_index_comp × N_INDEXER_HEAD_DIM × float32
      index_state K/V: layer_index_state_bytes(4)
```

</details>

### 14.3.4 snapshot：内存到内存版本

`ds4_session_save_snapshot()` / `ds4_session_load_snapshot()` 在 `ds4.c:16658/16697` 实现。它们用 `fmemopen()` 将 `ds4_session_snapshot.ptr`（堆分配的字节缓冲区）包装成 `FILE*`，然后直接调用 `save_payload` / `load_payload`。这为 `ds4-bench` 等工具在不触及磁盘的情况下保存/恢复 KV 状态提供了支持。

---

## 14.4 服务器侧：KVC 文件策略

### 14.4.1 KVC 文件格式

文件名是 `SHA1(cache_text_bytes).kvc`，其中 `cache_text_bytes` 是保存的 rendered text 前缀（用于调试和重建匹配）。

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="KVC disk file format layout with fixed header, rendered text, engine payload, and optional tool-id map">
  <defs>
    <marker id="ar143" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="20" y="18" font-size="11" font-weight="600" fill="currentColor">KVC 文件布局（ds4_server.c:8172）</text>
  <rect x="20" y="26" width="360" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="200" y="41" font-size="10" font-weight="700" fill="#7c3aed" text-anchor="middle">"KVC" + version (1B) ← magic</text>
  <rect x="20" y="52" width="180" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="110" y="67" font-size="10" fill="#64748b" text-anchor="middle">quant_bits (1B)</text>
  <rect x="206" y="52" width="174" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="293" y="67" font-size="10" fill="#64748b" text-anchor="middle">save_reason (1B)</text>
  <rect x="20" y="78" width="118" height="22" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="79" y="93" font-size="10" fill="#ea580c" text-anchor="middle">token_count (4B)</text>
  <rect x="144" y="78" width="118" height="22" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="203" y="93" font-size="10" fill="#ea580c" text-anchor="middle">hit_count (4B)</text>
  <rect x="268" y="78" width="112" height="22" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="324" y="93" font-size="10" fill="#ea580c" text-anchor="middle">context_size (4B)</text>
  <rect x="20" y="104" width="178" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="109" y="119" font-size="10" fill="#64748b" text-anchor="middle">creation_time (8B, LE)</text>
  <rect x="204" y="104" width="176" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="292" y="119" font-size="10" fill="#64748b" text-anchor="middle">last_used_time (8B, LE)</text>
  <rect x="20" y="130" width="226" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="133" y="145" font-size="10" fill="#64748b" text-anchor="middle">payload_byte_count (8B, LE)</text>
  <rect x="252" y="130" width="128" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="316" y="145" font-size="10" fill="#64748b" text-anchor="middle">text_byte_count (4B)</text>
  <text x="396" y="90" font-size="9" fill="#94a3b8">KV_CACHE_FIXED_HEADER</text>
  <text x="396" y="102" font-size="9" fill="#94a3b8">= 48 B + 4 B</text>
  <line x1="384" y1="26" x2="500" y2="26" stroke="#94a3b8" stroke-width="0.8" stroke-dasharray="2,2"/>
  <line x1="384" y1="152" x2="500" y2="152" stroke="#94a3b8" stroke-width="0.8" stroke-dasharray="2,2"/>
  <line x1="500" y1="26" x2="500" y2="152" stroke="#94a3b8" stroke-width="0.8" stroke-dasharray="2,2"/>
  <rect x="20" y="160" width="360" height="36" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="200" y="176" font-size="10" font-weight="600" fill="#0d9488" text-anchor="middle">rendered_text (text_byte_count bytes)</text>
  <text x="200" y="190" font-size="9" fill="#64748b" text-anchor="middle">供人阅读，用于前缀匹配</text>
  <rect x="20" y="202" width="360" height="36" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="200" y="218" font-size="10" font-weight="600" fill="#ea580c" text-anchor="middle">DS4 engine payload (payload_byte_count bytes)</text>
  <text x="200" y="232" font-size="9" fill="#64748b" text-anchor="middle">ds4_session_save_payload() 输出</text>
  <rect x="20" y="244" width="360" height="56" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="200" y="260" font-size="10" font-weight="600" fill="#64748b" text-anchor="middle">[optional] tool-id map section</text>
  <text x="200" y="276" font-size="9" fill="#94a3b8" text-anchor="middle">KTM magic (3B) + version (1B) + flags (4B)</text>
  <text x="200" y="290" font-size="9" fill="#94a3b8" text-anchor="middle">tool_id → DSML block 映射项</text>
  <line x1="560" y1="26" x2="730" y2="26" stroke="#cbd5e1" stroke-width="1"/>
  <line x1="560" y1="152" x2="730" y2="152" stroke="#cbd5e1" stroke-width="1"/>
  <line x1="560" y1="300" x2="730" y2="300" stroke="#cbd5e1" stroke-width="1"/>
  <line x1="730" y1="26" x2="730" y2="300" stroke="#cbd5e1" stroke-width="1"/>
  <text x="640" y="96" font-size="10" fill="#94a3b8" text-anchor="middle">固定头</text>
  <text x="640" y="108" font-size="9" fill="#94a3b8" text-anchor="middle">（大小由 quant bits</text>
  <text x="640" y="120" font-size="9" fill="#94a3b8" text-anchor="middle">+ save reason 决定）</text>
  <text x="640" y="225" font-size="10" fill="#94a3b8" text-anchor="middle">可变长度</text>
  <text x="640" y="237" font-size="9" fill="#94a3b8" text-anchor="middle">（与 token 数成比例）</text>
  <line x1="730" y1="88" x2="720" y2="88" stroke="#94a3b8" stroke-width="0.8"/>
  <line x1="730" y1="152" x2="720" y2="152" stroke="#94a3b8" stroke-width="0.8"/>
</svg>
<span class="figure-caption">图 R14.3 ｜ KVC 磁盘文件格式：固定头（quant bits、淘汰元数据）→ 文本前缀 → 引擎 payload → 可选 tool-id map</span>

<details>
<summary>ASCII 原版</summary>

```
KVC 文件布局（ds4_server.c:8172）：
  "KVC" + version (1 byte)                    ← magic
  quant_bits (1B)                              ← 量化位宽，用于跨量化版本验证
  save_reason (1B)                             ← cold/continued/evict/shutdown
  token_count (4B, LE)                         ← 保存时的 token 数
  hit_count (4B, LE)                           ← 磁盘命中计数
  context_size (4B, LE)                        ← 保存时的 context 容量
  creation_time (8B, LE)                       ← Unix 时间戳
  last_used_time (8B, LE)
  payload_byte_count (8B, LE)
  text_byte_count (4B, LE)
  rendered_text (text_byte_count bytes)        ← 供人阅读，用于前缀匹配
  DS4 engine payload (payload_byte_count bytes)← ds4_session_save_payload() 输出
  [optional] tool-id map section
    KTM magic (3B) + version (1B) + flags (4B)
    tool_id → DSML block 映射项
```

</details>

头部总固定长度为 `KV_CACHE_FIXED_HEADER`（48 字节）加上 text_byte_count 的 4 字节字段。

### 14.4.2 磁盘命中计数与衰减

`ds4_server.c:8209` 的注释解释了命中计数的设计：

```c
/* Disk-hit counts are evidence that a checkpoint was useful, but only while
 * the workload still resembles the one that produced those hits.  Prompt or
 * tool-schema changes can make a once-hot checkpoint impossible to match, so
 * eviction decays only the hit bonus with inactivity.  The baseline token/byte
 * value remains intact: old files are not punished for age, they just stop
 * carrying stale popularity forever. */
#define KV_CACHE_HIT_HALF_LIFE_SECONDS (6ull * 60ull * 60ull)
```

命中分的半衰期为 6 小时。淘汰评分公式：`score = token_count + effective_hit_bonus`，其中 hit bonus 按时间衰减。这样既保留了长 token 序列的基线价值，又让不再被访问的热点文件逐渐让位给新的 checkpoint。

### 14.4.3 文本前缀匹配而非 token 前缀

磁盘查找用 **渲染后的文本字节前缀**，而不是 token 序列。原因是（`ds4_server.c:9053`）：

```c
/* A same-text-prefix file can be reused by a larger context, but not by a
 * smaller one: the payload was validated against the context capacity recorded
 * in the file.  If the existing file cannot be used by this server, replace it
 * so this context can still populate its own cache. */
```

文本前缀有两个关键特性：
1. 文本相同但 token 化略有不同的请求（因为跨 prompt 边界的 BPE 合并）仍然可以命中同一个 checkpoint
2. context 容量更大的服务器可以复用 context 更小的服务器保存的 checkpoint，反之不行

### 14.4.4 分词器边界修剪与对齐

`ds4_server.c:8199` 描述了边界修剪的原因：

```c
/* Tokenizers may merge text across the prompt boundary.  Trimming a small tail
 * still improves the cheap token-prefix path, while text-prefix lookup handles
 * the cases where canonical prompt tokenization spells the same bytes
 * differently.  The 2048 alignment also matches the Metal prefill chunk
 * schedule, which keeps compressor row finalization identical to a cold full
 * prompt. */
#define KV_CACHE_DEFAULT_BOUNDARY_TRIM_TOKENS 32
#define KV_CACHE_DEFAULT_BOUNDARY_ALIGN_TOKENS 2048
```

保存时去掉最后 32 个 token（`boundary_trim_tokens`），然后向下对齐到 2048 token 边界（`boundary_align_tokens`）。这确保：
- 不会在 BPE 合并敏感的边界处切割 prompt
- 保存的 checkpoint 长度与 Metal prefill chunk 调度对齐，后续的压缩器行完成状态与冷启动完全一致

### 14.4.5 持续对话的定期保存

`ds4_server.c:9045` 附近定义了 `continued_interval_tokens`（默认 10000）：每生成 10000 个 token 在绝对对齐的 token 边界保存一次 checkpoint，确保长 agent 会话在 SSD 上有近期可用的恢复点，而不依赖上次冷启动的 checkpoint。

```c
/* The schedule is anchored to absolute aligned frontiers, not relative to the
 * last cold/evict file. Otherwise an early cold checkpoint can shift the whole
 * schedule and leave long generations with no recent durable restart point. */
```

### 14.4.6 磁盘 KVC 文件打开逻辑

`kv_cache_open()` 在 `ds4_server.c:8901` 初始化磁盘缓存。服务器启动时调用 `kv_cache_evict()` 扫描目录，按评分排序，删除超出预算的旧文件。

`kv_cache_file_text_matches()` 在 `ds4_server.c:9057` 验证磁盘文件与请求文本的匹配性：读取文件头和 rendered text，计算 SHA1，与文件名比较，同时验证 `text_bytes` 字段匹配。

### 14.4.7 tool-id map 附加节

保存时，`kv_cache_store()` 还将当前已知的 tool-id → DSML 映射写入文件末尾的 KTM section（`KV_EXT_TOOL_MAP`，位 0）。只保存那些 DSML 块出现在 cache text 中的映射项——这确保从磁盘恢复后仍然能够精确重放历史工具调用，保持 KV 缓存对齐。

恢复时，`kv_cache_restore()` 先加载 tool-id map 到内存，再调用 `ds4_session_load_payload()` 恢复图状态，然后在 prompt 渲染之前将 tool-id 注入 `server.tool_mem`。

---

## 14.5 Responses visible 与 thinking visible 的磁盘键

常规 checkpoint 的磁盘文件名是 SHA1(rendered_token_prefix)。对于两种特殊 live 状态，disk key 用的是 **visible transcript** 而不是包含隐藏 reasoning 的完整 token 文本。

```
KV_EXT_RESPONSES_VISIBLE (位 1)：
  文件名 = SHA1(visible_transcript)
  payload = 包含 hidden reasoning 的完整 live KV
  用途：Codex/Pi 客户端切换时，从磁盘恢复 Responses session，
        包含推理状态，查找键是客户端能重放的可见内容

KV_EXT_THINKING_VISIBLE (位 2)：
  文件名 = SHA1(thinking_visible_text)
  payload = 包含 hidden thinking 的完整 live KV
  用途：chat/completions 或 Anthropic 的 thinking 答复，
        后续请求用可见文本前缀匹配，复用包含思维链的 KV
```

这种机制使多客户端（Codex + Pi + Claude Code + opencode）共享同一个磁盘缓存目录，各自的 session 都能在切换后通过各自的可见 key 从磁盘恢复。

---

## 14.6 为什么这让长 agent 会话变得实用

一次典型的 100k token agent 会话（以 Claude Code 为例）的请求序列：

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Long agent session timeline showing KV cache hit and prefill cost per turn">
  <defs>
    <marker id="ar144" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="ar144g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#16a34a"/>
    </marker>
    <marker id="ar144o" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/>
    </marker>
  </defs>
  <text x="380" y="18" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">100k token agent 会话时间线（以 Claude Code 为例）</text>
  <line x1="30" y1="40" x2="720" y2="40" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar144)"/>
  <text x="725" y="44" font-size="10" fill="#94a3b8">时间</text>
  <line x1="60" y1="35" x2="60" y2="45" stroke="#94a3b8" stroke-width="1"/>
  <line x1="190" y1="35" x2="190" y2="45" stroke="#94a3b8" stroke-width="1"/>
  <line x1="310" y1="35" x2="310" y2="45" stroke="#94a3b8" stroke-width="1"/>
  <line x1="430" y1="35" x2="430" y2="45" stroke="#94a3b8" stroke-width="1"/>
  <line x1="550" y1="35" x2="550" y2="45" stroke="#94a3b8" stroke-width="1"/>
  <line x1="660" y1="35" x2="660" y2="45" stroke="#94a3b8" stroke-width="1"/>
  <rect x="30" y="58" width="120" height="54" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="90" y="73" font-size="10" font-weight="700" fill="#dc2626" text-anchor="middle">turn 1</text>
  <text x="90" y="87" font-size="9" fill="#64748b" text-anchor="middle">冷 prefill</text>
  <text x="90" y="100" font-size="9" fill="#64748b" text-anchor="middle">30k tokens</text>
  <line x1="90" y1="112" x2="90" y2="128" stroke="#ea580c" stroke-width="1.2" marker-end="url(#ar144o)"/>
  <rect x="30" y="128" width="120" height="26" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="90" y="145" font-size="9" fill="#ea580c" text-anchor="middle">→ 保存 cold checkpoint</text>
  <rect x="160" y="58" width="120" height="54" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="220" y="73" font-size="10" font-weight="700" fill="#16a34a" text-anchor="middle">turn 2</text>
  <text x="220" y="87" font-size="9" fill="#64748b" text-anchor="middle">tool call</text>
  <text x="220" y="100" font-size="9" fill="#64748b" text-anchor="middle">4 token，live 续写</text>
  <rect x="160" y="128" width="120" height="26" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/>
  <text x="220" y="145" font-size="9" fill="#16a34a" text-anchor="middle">无 prefill</text>
  <rect x="290" y="58" width="120" height="54" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="350" y="73" font-size="10" font-weight="700" fill="#16a34a" text-anchor="middle">turn 3</text>
  <text x="350" y="87" font-size="9" fill="#64748b" text-anchor="middle">tool result</text>
  <text x="350" y="100" font-size="9" fill="#64748b" text-anchor="middle">200 token suffix</text>
  <rect x="290" y="128" width="120" height="26" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/>
  <text x="350" y="145" font-size="9" fill="#16a34a" text-anchor="middle">追加 suffix</text>
  <rect x="410" y="58" width="120" height="54" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="470" y="73" font-size="10" font-weight="700" fill="#16a34a" text-anchor="middle">turn 4</text>
  <text x="470" y="87" font-size="9" fill="#64748b" text-anchor="middle">新 user 消息</text>
  <text x="470" y="100" font-size="9" fill="#64748b" text-anchor="middle">文本前缀命中</text>
  <rect x="410" y="128" width="120" height="26" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/>
  <text x="470" y="145" font-size="9" fill="#16a34a" text-anchor="middle">只 prefill 增量</text>
  <rect x="530" y="58" width="110" height="54" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="4,3"/>
  <text x="585" y="73" font-size="10" font-weight="700" fill="#dc2626" text-anchor="middle">turn N</text>
  <text x="585" y="87" font-size="9" fill="#64748b" text-anchor="middle">会话超出 live KV</text>
  <text x="585" y="100" font-size="9" fill="#64748b" text-anchor="middle">磁盘 continued 恢复</text>
  <rect x="530" y="128" width="110" height="26" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/>
  <text x="585" y="145" font-size="9" fill="#16a34a" text-anchor="middle">prefill 增量</text>
  <rect x="648" y="58" width="92" height="54" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="694" y="73" font-size="10" font-weight="700" fill="#7c3aed" text-anchor="middle">重启</text>
  <text x="694" y="87" font-size="9" fill="#64748b" text-anchor="middle">server restart</text>
  <text x="694" y="100" font-size="9" fill="#64748b" text-anchor="middle">visible checkpoint</text>
  <rect x="648" y="128" width="92" height="26" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/>
  <text x="694" y="145" font-size="9" fill="#16a34a" text-anchor="middle">prefill 增量</text>
  <text x="30" y="190" font-size="10" font-weight="600" fill="currentColor">真正执行 prefill 的 token 数：</text>
  <rect x="30" y="202" width="220" height="24" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="140" y="218" font-size="9" fill="#64748b" text-anchor="middle">tool 续写：约 10-50 token（EOS + result + prefix）</text>
  <rect x="260" y="202" width="220" height="24" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="370" y="218" font-size="9" fill="#64748b" text-anchor="middle">正常续写：约 100-500 token（新增 suffix）</text>
  <rect x="490" y="202" width="250" height="24" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="615" y="218" font-size="9" fill="#64748b" text-anchor="middle">冷启动恢复：仅 checkpoint_boundary → prompt_end 增量</text>
</svg>
<span class="figure-caption">图 R14.4 ｜ 长 agent 会话时间线：磁盘 KV 缓存将大多数 turn 的 prefill 代价从全 prompt 降低到增量 token</span>

<details>
<summary>ASCII 原版</summary>

```
turn 1: 冷 prefill 30k tokens → 保存 cold checkpoint
turn 2: tool call，4 个新 token，live ID 续写 → 无 prefill
turn 3: tool result，200 token suffix → 追加 suffix
turn 4: 新 user 消息，扩展 prompt → 文本前缀命中 checkpoint → 只 prefill 增量
…
turn N: 会话超出 live KV → 从磁盘 continued checkpoint 恢复，prefill 增量
server restart: 从磁盘 visible checkpoint 恢复，prefill 增量
```

</details>

每次请求中真正执行 prefill 的 token 数量从整个 prompt 长度降低到：
- tool 续写：仅 EOS + tool_result + assistant_prefix（约 10-50 token）
- 正常续写：仅新增 suffix（通常 100-500 token）
- 冷启动后恢复：仅 checkpoint_boundary 到 prompt_end 的增量

这与 [第 6 章](06-engine-session.md) 的 `ds4_session_sync()` 直接配合：sync 函数接受 effective_prompt，其 cached 部分（已由 load_payload 恢复）不需要重新 prefill。

---

## 14.7 与 session_sync 的配合

`ds4.h:166` 的 `ds4_session_sync()` 是引擎侧的续写入口：

```c
/* Synchronize the live session to a full prompt token prefix.  If the current
 * checkpoint is a prefix, only the suffix is evaluated; otherwise the backend
 * state is refilled from scratch. */
int ds4_session_sync(ds4_session *s, const ds4_tokens *prompt, char *err, size_t errlen);
```

`generate_job()` 在决策完成后：
1. 调用 `ds4_session_load_payload()` 恢复磁盘 checkpoint（如果磁盘命中）
2. 构建 `effective_prompt = checkpoint_tokens + suffix_tokens`
3. 调用 `ds4_session_sync(session, effective_prompt, ...)`
4. sync 检测 `ds4_session_common_prefix()` == `effective_prompt.len - suffix.len`，只 prefill suffix

BPE 边界不切割保证（`ds4_server.c:10498`）：

```
不使用 canonical full_prompt 的前 N 个 token，因为 BPE 可能跨字节边界合并。
从 checkpoint 的 exact token history 出发，对 suffix 文本重新独立分词。
```
