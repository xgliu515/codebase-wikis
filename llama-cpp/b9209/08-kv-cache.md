# 第 8 章 KV 缓存与内存子系统

## 总览

自回归语言模型生成第 t 个 token 时，需要计算该 token 与全部历史 token 的注意力。若不缓存，每步都要从头重算所有历史层的 K、V 投影，计算量随序列长度线性增长。KV cache 将每一层每一个历史 token 的 K、V 值持久化存储，使 TG（token generation）阶段每步仅需对新 token 做一次前向传播并读取已有缓存，从 O(T²) 降至 O(T)。

llama.cpp 的内存子系统通过 `llama_memory_i` 抽象接口统一了 KV cache 与 recurrent state 两类完全不同的持久状态，并提供了多种变体以适应不同的模型架构。

本章涵盖：

1. `llama_memory_i` 抽象接口设计
2. `llama_kv_cache` 的张量布局与 cells 元数据
3. 槽位分配：`slot_info` 与 `find_slot`
4. KV cache 如何接入计算图（kq mask 构建）
5. 变体：iswa / recurrent / hybrid
6. 序列操作与 server 多用户场景

---

## 8.1 为什么需要 KV 缓存

Transformer 解码器的自注意力计算：

```
Q = x * W_q    [n_tokens, n_embd_head * n_head]
K = x * W_k    [n_tokens, n_embd_head * n_head_kv]
V = x * W_v    [n_tokens, n_embd_head * n_head_kv]
attn = softmax(Q * K^T / sqrt(d)) * V
```

在自回归解码阶段，每步 x 只有 1 行（当前 token），但 K、V 要跨越所有历史位置。若不缓存，第 t 步需要重算前 t 个 token 的 K、V，总计算量 O(T²)。KV cache 将第 1..t-1 步的 K、V 留存，第 t 步只追加新的 1 行，总计算量降至 O(T)，代价是额外的显存占用（与序列长度成正比）。

---

## 8.2 llama_memory_i 抽象接口

定义于 `src/llama-memory.h:71`，是整个内存子系统的核心抽象：

```cpp
// src/llama-memory.h:71-125
struct llama_memory_i {
    // 回调类型：用于过滤层、复用层
    using layer_filter_cb = std::function<bool(int32_t il)>;
    using layer_reuse_cb  = std::function<int32_t(int32_t il)>;

    // 批次处理：拆分 batch → ubatches，检查是否能放入缓存
    virtual llama_memory_context_ptr init_batch(
        llama_batch_allocr & balloc, uint32_t n_ubatch, bool embd_all) = 0;

    // 模拟满缓存，用于 sched_reserve 阶段
    virtual llama_memory_context_ptr init_full() = 0;

    // 执行 pending 的 shift/copy 等更新操作
    virtual llama_memory_context_ptr init_update(llama_context * lctx, bool optimize) = 0;

    // 序列级操作
    virtual bool seq_rm  (llama_seq_id, llama_pos p0, llama_pos p1) = 0;
    virtual void seq_cp  (llama_seq_id src, llama_seq_id dst, llama_pos p0, llama_pos p1) = 0;
    virtual void seq_keep(llama_seq_id) = 0;
    virtual void seq_add (llama_seq_id, llama_pos p0, llama_pos p1, llama_pos shift) = 0;
    virtual void seq_div (llama_seq_id, llama_pos p0, llama_pos p1, int d) = 0;
    // ...
};
```

### 8.2.1 llama_memory_context_i：执行上下文

每次调用 `init_batch` 返回一个 `llama_memory_context_i`，它持有本次批次的所有 ubatch 及对应的槽位分配信息：

```cpp
// src/llama-memory.h:49-65
struct llama_memory_context_i {
    virtual bool next()    = 0;  // 推进到下一个 ubatch，返回 false 表示全部处理完
    virtual bool apply()   = 0;  // 将当前 ubatch 的槽位信息写入 cells 元数据
    virtual const llama_ubatch & get_ubatch() const = 0;
    virtual llama_memory_status  get_status()  const = 0;
};
```

`llama_memory_status` 枚举（`src/llama-memory.h:28`）：

```
LLAMA_MEMORY_STATUS_SUCCESS         ─── 全部 ubatch 都找到了槽位
LLAMA_MEMORY_STATUS_NO_UPDATE       ─── 没有需要处理的更新（init_update 专用）
LLAMA_MEMORY_STATUS_FAILED_PREPARE  ─── 找不到足够的 KV 槽位（通常触发 defrag 重试）
LLAMA_MEMORY_STATUS_FAILED_COMPUTE  ─── 计算失败（shift 图执行失败等）
```

**设计意图**：`apply()` 是唯一真正修改 memory 状态的方法。在 `init_batch` 阶段，`prepare()` 仅模拟槽位分配并回滚（原子性预检），实际写入推迟到 `apply()`，从而实现"要么全成功要么全失败"的语义。

---

## 8.3 llama_kv_cache：张量布局与 cells 元数据

`llama_kv_cache` 实现于 `src/llama-kv-cache.h:20`，继承 `llama_memory_i`。

### 8.3.1 张量布局

每层 KV 以一对 3D 张量存储（`src/llama-kv-cache.cpp:210`）：

```cpp
// src/llama-kv-cache.cpp:210-214
ggml_tensor * k = ggml_new_tensor_3d(ctx, type_k,
    n_embd_k_gqa,   // n_embd_head_k * n_head_kv
    kv_size,        // KV cache 总槽位数
    n_stream);      // 流数（unified=1，否则=n_seq_max）

ggml_tensor * v = ggml_new_tensor_3d(ctx, type_v,
    n_embd_v_gqa,   // n_embd_head_v * n_head_kv（或 padded 版本）
    kv_size,
    n_stream);
```

<svg viewBox="0 0 760 160" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="K tensor memory layout in KV cache">
  <defs>
    <marker id="ar8-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="160" fill="#f8fafc" rx="6"/>
  <text x="380" y="26" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">K 张量内存布局（n_stream=1 时）</text>
  <rect x="40" y="40" width="120" height="60" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="100" y="66" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">cell 0</text>
  <text x="100" y="85" text-anchor="middle" font-size="11" fill="#64748b">[d_k_gqa]</text>
  <rect x="172" y="40" width="120" height="60" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="232" y="66" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">cell 1</text>
  <text x="232" y="85" text-anchor="middle" font-size="11" fill="#64748b">[d_k_gqa]</text>
  <rect x="304" y="40" width="120" height="60" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="364" y="66" text-anchor="middle" font-size="12" fill="#94a3b8">cell 2</text>
  <text x="364" y="85" text-anchor="middle" font-size="11" fill="#94a3b8">[d_k_gqa]</text>
  <rect x="436" y="40" width="60" height="60" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="466" y="76" text-anchor="middle" font-size="14" fill="#94a3b8">…</text>
  <rect x="508" y="40" width="210" height="60" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="613" y="66" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">cell kv_size-1</text>
  <text x="613" y="85" text-anchor="middle" font-size="11" fill="#64748b">[d_k_gqa]</text>
  <line x1="40" y1="115" x2="718" y2="115" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8-1)"/>
  <text x="380" y="135" text-anchor="middle" font-size="11" fill="#64748b">每行 = 一个 token 位置在该层的 K 投影（所有 head concat，n_embd_head_k × n_head_kv）</text>
  <text x="42" y="148" text-anchor="start" font-size="10" fill="#94a3b8">offset 0</text>
  <text x="720" y="148" text-anchor="end" font-size="10" fill="#94a3b8">kv_size × d_k_gqa</text>
</svg>
<span class="figure-caption">图 R8.1 ｜ KV cache K 张量内存布局：每个 cell 存储一个 token 位置的 K 投影向量（n_stream=1）</span>

<details>
<summary>ASCII 原版</summary>

```
K 张量内存布局（n_stream=1 时）：
┌──────────────────────────────────────────────────────┐
│  cell 0    │  cell 1    │  ... │  cell kv_size-1    │
│ [d_k_gqa]  │ [d_k_gqa]  │      │ [d_k_gqa]          │
└──────────────────────────────────────────────────────┘
每行 = 一个 token 位置在该层的 K 投影（所有 head concat）
```

</details>

V 张量有两种模式：
- **非转置**（FA 启用，`v_trans=false`）：布局与 K 相同，`[d_v_gqa, kv_size, n_stream]`
- **转置**（FA 禁用，`v_trans=true`）：`[kv_size, n_head_kv, d_embd_head_v, n_stream]`，转置后更适合矩阵乘法的 strided 访问模式

多流（`n_stream = n_seq_max`）时，每个序列拥有独立的 `kv_size` slots 切片，互不干扰。通过 `k_stream[s]` 和 `v_stream[s]` 访问（`src/llama-kv-cache.h:221-222`）。

### 8.3.2 llama_kv_cells：cells 元数据

`llama_kv_cells`（`src/llama-kv-cells.h:32`）是 per-stream 的纯元数据，不含实际 KV 值：

```cpp
// src/llama-kv-cells.h:459-499（私有成员）
std::set<uint32_t>    used;         // 已使用的 cell 索引集合（快速统计）
std::vector<llama_pos> pos;         // pos[i] = cell i 存储的 token 位置（-1=空）
std::vector<llama_kv_cell_ext> ext; // 2D 扩展位置（M-RoPE 使用）
std::vector<llama_pos> shift;       // 累积的位置偏移（K-shift 使用）
std::vector<seq_set_t> seq;         // seq[i] 是 bitset，标记 cell i 属于哪些序列
// seq_pos[s] = map<llama_pos, int>  各序列的位置->引用计数（快速查 min/max）
std::map<llama_pos, int> seq_pos[LLAMA_MAX_SEQ];
```

关键设计：`seq[i]` 是 `bitset<LLAMA_MAX_SEQ>`，允许一个 cell 被多个序列共享（beam search 的 prefix sharing 依赖此特性）。`seq_pos[s]` 的 map 结构让 `seq_pos_min(s)` 和 `seq_pos_max(s)` 均为 O(1)。

---

## 8.4 槽位分配

### 8.4.1 slot_info 结构

```cpp
// src/llama-kv-cache.h:33-92
struct slot_info {
    uint32_t s0, s1;                    // 参与的 stream 范围 [s0, s1]
    std::vector<llama_seq_id> strm;     // [n_seqs]  各序列所在 stream
    std::vector<idx_vec_t>    idxs;     // [n_seqs][n_tokens] cell 索引列表

    uint32_t head() const;              // 连续情况下的起始 cell（兼容旧代码）
    bool is_contiguous() const;         // 索引是否连续
};
```

`slot_info` 把 ubatch 中的每个 token 映射到 KV 张量中具体的 cell 索引。后续图构建时，`k_idxs[i] = strm[s]*kv_size + idxs[s][ii]`（`src/llama-kv-cache.cpp:1363`），通过 `ggml_set_rows` 完成散射写入。

### 8.4.2 find_slot 搜索算法

`find_slot`（`src/llama-kv-cache.cpp:818`）对 ubatch 的每条不重复序列做：

1. 从 `v_heads[stream_id]` 开始（一个 ring buffer 指针，减少扫描长度）
2. 若 `head_cur > cells.get_used() + 2*n_tokens`，重置 head_cur=0（避免跳过前部空洞）
3. 逐 cell 检查"可用性"：

```cpp
// src/llama-kv-cache.cpp:962-981
bool can_use = cells.is_empty(idx);  // 空 cell 直接可用

if (!can_use && cells.seq_count(idx) == 1) {
    // SWA 窗口判断：若该 cell 存储的位置已被 SWA 滑出窗口 → 可覆盖
    if (llama_hparams::is_masked_swa(n_swa, swa_type,
            pos_cell, cells.seq_pos_max(seq_id_cell) + 1)) {
        can_use = true;
    }
}
```

4. 收集到足够的 `n_tokens` 个 cell 后返回

非连续模式（`cont=false`）下允许散射分配；连续模式（`cont=true`）下要求 `idxs` 必须连续——这是旧 API 兼容路径，目前主要路径均为非连续。

### 8.4.3 apply_ubatch：写入元数据

`apply_ubatch`（`src/llama-kv-cache.cpp:1017`）在 `mctx->apply()` 时被调用，将 ubatch 的 token 位置信息写入 `v_cells`：

```cpp
// src/llama-kv-cache.cpp:1046-1059
cells.pos_set(idx, ubatch.pos[i]);      // 记录 token 位置
if (ubatch.is_pos_2d()) {
    cells.ext_set(idx, { x, y });       // M-RoPE 的 2D 位置
}
// 移动 head 指针到 slot 末尾
head = sinfo.idxs[s].back() + 1;
```

SWA 剔除时，还会清理被覆盖 cell 所在序列中比该位置更早的 tokens（维护 `[pos_min, pos_max]` 连续不变量，见 `src/llama-kv-cache.cpp:1062`）。

---

## 8.5 KV cache 的图接线

### 8.5.1 k_idxs / v_idxs 张量

在 `model.build_graph` 中，每一层的注意力计算需要三步图节点：

<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="KV cache graph wiring: read, write, and attention steps">
  <defs>
    <marker id="ar8-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="280" fill="#f8fafc" rx="6"/>
  <rect x="20" y="16" width="36" height="246" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="38" y="145" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" transform="rotate(-90,38,145)">步骤顺序</text>
  <rect x="70" y="16" width="670" height="68" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="120" y="34" font-size="12" font-weight="700" fill="currentColor">① 读 KV</text>
  <text x="120" y="52" font-size="11" fill="#0d9488">get_k() → view 4D [d_head, n_head_kv, n_kv, n_stream]</text>
  <text x="120" y="72" font-size="11" fill="#0d9488">get_v() → view 4D（FA 启用时同形状；FA 禁用时为转置布局）</text>
  <rect x="70" y="98" width="670" height="82" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="120" y="116" font-size="12" font-weight="700" fill="currentColor">② 写 KV（散射写入）</text>
  <text x="120" y="136" font-size="11" fill="#7c3aed">cpy_k() = ggml_set_rows(k_cache, k_cur_2d, k_idxs)</text>
  <text x="120" y="154" font-size="11" fill="#7c3aed">cpy_v() = ggml_set_rows(v_cache, v_cur_2d, v_idxs)    ← FA 模式</text>
  <text x="120" y="172" font-size="11" fill="#7c3aed">cpy_v() = ggml_set_rows(v_view_1d, v_cur_1d, v_idxs)  ← 非FA 转置散射</text>
  <rect x="70" y="194" width="670" height="68" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="120" y="214" font-size="12" font-weight="700" fill="currentColor">③ 注意力计算</text>
  <text x="120" y="234" font-size="11" fill="#ea580c">GGML_OP_FLASH_ATTN_EXT(Q, K_full, V_full, mask)</text>
  <text x="120" y="254" font-size="11" fill="#ea580c">或 softmax(Q × K_full^T / √d) × V_full</text>
  <line x1="56" y1="85" x2="56" y2="97" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8-2)"/>
  <line x1="56" y1="181" x2="56" y2="193" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8-2)"/>
</svg>
<span class="figure-caption">图 R8.2 ｜ KV cache 图接线三步：读取历史 KV 视图、散射写入新 token、执行注意力计算</span>

<details>
<summary>ASCII 原版</summary>

```
1. 读 K：get_k(ctx, il, n_kv, sinfo) → view 4D [d_head, n_head_kv, n_kv, n_stream]
         get_v(ctx, il, n_kv, sinfo) → view 4D

2. 写 K：cpy_k(ctx, k_cur, k_idxs, il, sinfo)
         = ggml_set_rows(k_cache, k_cur_2d, k_idxs)

         cpy_v(ctx, v_cur, v_idxs, il, sinfo)
         = ggml_set_rows(v_cache, v_cur_2d, v_idxs)  (FA)
         = ggml_set_rows(v_view_1d, v_cur_1d, v_idxs) (非FA，转置散射)

3. 注意力：GGML_OP_FLASH_ATTN_EXT 或 softmax(QK^T) * V
```

</details>

`k_idxs` 是一个 `[n_tokens]` int64 张量，`set_input_k_idxs` 在运行时填充（`src/llama-kv-cache.cpp:1355`）：

```cpp
// src/llama-kv-cache.cpp:1362-1368
for (uint32_t s = 0; s < sinfo.n_stream(); ++s) {
    const int64_t offs = sinfo.strm[s] * get_size();  // stream 偏移
    for (uint32_t i = 0; i < sinfo.size(); ++i) {
        data[s*sinfo.size() + i] = offs + sinfo.idxs[s][i];  // 全局 cell 索引
    }
}
```

V cache 转置时，`v_idxs` 的每个 token 展开为 `n_embd_v_gqa` 个元素，将二维转置散射展平为一维索引（`src/llama-kv-cache.cpp:1386-1401`）。

### 8.5.2 kq_mask 构建

`kq_mask` 是 `[n_tokens, n_kv, n_stream]` float 张量（softmax attn 时），或直接传递给 FlashAttention（仅需因果 mask）。`set_input_kq_mask`（`src/llama-kv-cache.cpp:1609`）使用模板展开优化：

```cpp
// src/llama-kv-cache.cpp:1433-1434
template<bool causal, bool swa, bool is_2d, bool alibi>
static void set_input_kq_mask_impl(const args_set_input_kq_mask & args, float * data) {
```

四维模板参数组合在编译期展开，避免运行时 branch。mask 构建逻辑：

```text
对每个 query token q（位置 p1）和每个 KV cell j（位置 p_j）：
  data[q * n_kv + j] =
    0.0f                   如果允许注意力（token q 能看到 cell j）
    -INFINITY              如果屏蔽

  屏蔽条件（满足任一即屏蔽）：
    1. cells[j].is_empty()                   ← 空 cell
    2. !cells[j].seq_has(seq_id)             ← 不属于同一序列
    3. causal && p_j > p1                    ← 因果 mask（只看历史）
    4. swa && is_masked_swa(n_swa, type, p_j, p1+1) ← SWA 窗口外
```

优化细节（`src/llama-kv-cache.cpp:1483`）：同序列的多个 query token，KQ mask 几乎相同（只有紧邻 query 位置的 cells 不同），第一个 token 完整扫描，后续 token 直接 memcpy 再更新差异部分。

---

## 8.6 变体

### 8.6.1 llama_kv_cache（标准全注意力）

- 适用：GPT 类 decoder-only，GQA/MQA
- `n_stream=1`（`unified=true`）：所有序列共享一片连续 KV 空间，序列间通过 kq_mask 隔离
- `n_stream=n_seq_max`（`unified=false`）：每个序列独占一片 KV 空间，无需 mask 隔离，适合序列间 KV 不共享前缀的多用户场景

### 8.6.2 llama_kv_cache_iswa（iSWA，滑动窗口注意力）

定义于 `src/llama-kv-cache-iswa.h:14`，持有**两个** `llama_kv_cache` 实例：

```cpp
// 内部：
// kv_attn  → 全注意力层（non-SWA layers）
// kv_swa   → 滑动窗口注意力层（SWA layers）
```

为什么需要两个实例：SWA 层的有效上下文远小于全局 n_ctx，可以分配更小的缓冲（`n_swa` slots 而非 `n_ctx` slots）。iSWA（interleaved SWA）是 Gemma2/3 等模型采用的每隔一层使用 SWA 的架构。`swa_full=false` 时 SWA 缓冲仅分配 `n_swa` 大小，显著节省显存。

`init_batch` 的状态组合：

```cpp
// src/llama-memory.h:37
llama_memory_status llama_memory_status_combine(s0, s1)
// 两个 cache 的 init_batch 结果取更严格的状态
```

### 8.6.3 llama_memory_recurrent（SSM/Mamba）

定义于 `src/llama-memory-recurrent.h:17`，为 Mamba、RWKV 等循环状态模型提供内存。

与 KV cache 的根本区别：

| 维度 | KV cache | recurrent state |
|------|----------|-----------------|
| 存储 | 每个历史 token 的 K/V | 固定大小的隐状态（与序列长度无关） |
| PP 处理 | O(T²) 注意力 | chunked scan（线性）|
| 内存 | O(n_ctx * n_layers) | O(n_seq_max * n_layers) |
| 状态转移 | 无（随机访问） | 必须顺序处理 |

`llama_memory_recurrent` 的 cells 是"槽"而非"位置"，每个序列占用一个槽（`head` 追踪下一个可用槽位）。n_rs_seq 支持滚动快照回滚（recurrent state rollback），用于 speculative decoding 失败时恢复。

### 8.6.4 llama_memory_hybrid（混合架构）

定义于 `src/llama-memory-hybrid.h:19`，同时持有一个 `llama_kv_cache` 和一个 `llama_memory_recurrent`：

```cpp
// src/llama-memory-hybrid.h:20-42
class llama_memory_hybrid : public llama_memory_i {
    // 内部：
    // std::unique_ptr<llama_kv_cache>        kv;
    // std::unique_ptr<llama_memory_recurrent> rs;
    // 每层由 filter_attn / filter_recr 决定使用哪一个
};
```

适用模型：Jamba（Mamba + attention 交替）、Zamba、MambaFormer 等混合架构。每个 ubatch 的处理需要同时更新 KV cache（注意力层）和 recurrent state（SSM 层），`init_batch` 的结果是两个子 mctx 的组合状态。

### 8.6.5 llama_memory_hybrid_iswa（iSWA + recurrent）

定义于 `src/llama-memory-hybrid-iswa.h`，在 hybrid 基础上，KV cache 部分进一步使用 iSWA 变体，适用于带 SWA 注意力层的混合模型。

---

## 8.7 序列操作与 server 多用户场景

所有内存变体都通过 `llama_memory_i` 暴露以下操作（`src/llama-memory.h:106-113`）：

### 8.7.1 seq_rm：删除序列片段

```cpp
bool seq_rm(llama_seq_id seq_id, llama_pos p0, llama_pos p1)
```

**实现**（`src/llama-kv-cache.cpp:343`）：遍历 stream 的所有 cells，将 `pos ∈ [p0, p1)` 且属于 `seq_id` 的 cell 从 bitset 中移除该 seq_id；若 cell 变空则标记为可用。`seq_id=-1` 时删除所有序列。

**server 场景**：请求完成后立即 `seq_rm(seq_id, 0, -1)` 释放该请求占用的全部 KV 槽位，供下一个请求复用。

### 8.7.2 seq_cp：复制序列 KV

```cpp
void seq_cp(llama_seq_id src, llama_seq_id dst, llama_pos p0, llama_pos p1)
```

**实现**（`src/llama-kv-cache.cpp:406`）：若 src 和 dst 在同一 stream，只需在 cells 元数据中将 dst 加入对应 cell 的 seq bitset（**无需复制张量数据**）——这正是 prefix sharing 的底层机制：多个请求共享相同前缀时，复制元数据即可让所有请求的 KV 指向同一块物理存储。

跨 stream 复制（`unified=false`）必须实际复制张量缓冲，操作更重，因此在批量序列克隆（如 beam search）时建议使用 unified 模式。

### 8.7.3 seq_keep：仅保留指定序列

```cpp
void seq_keep(llama_seq_id seq_id)
```

保留 `seq_id`，将其他所有序列从 cells 中清除。实现上遍历所有 cells，对每个 cell 调用 `cells.seq_keep(i, seq_id)`（`src/llama-kv-cells.h:261`）。

**server 场景**：在 speculative decoding 的树形 beam search 后确认最终序列时，用 `seq_keep` 一次性清理所有被拒绝的候选路径。

### 8.7.4 seq_add：平移位置（K-shift）

```cpp
void seq_add(llama_seq_id seq_id, llama_pos p0, llama_pos p1, llama_pos shift)
```

将 `[p0, p1)` 范围内的 cells 位置平移 `shift`，同时累加到 `cells.shift[i]`（`src/llama-kv-cache.cpp:515`）。`shift` 数组由 `set_input_k_shift` 在图构建时传入，通过 RoPE 重新旋转 K cache（`src/llama-kv-cache.cpp:782`）。

**server 场景**：上下文窗口快满时，`seq_add(seq_id, 1, -1, -1)` 将整个序列的位置前移 1（等效于丢弃最早一个 token 的 KV），同时触发 K-shift 图重新旋转 K cache，维护 RoPE 位置的正确性。这是 server 端实现"滑动窗口"推理的核心机制。

### 8.7.5 seq_div：压缩位置（YARN 时间步压缩）

```cpp
void seq_div(llama_seq_id seq_id, llama_pos p0, llama_pos p1, int d)
```

将位置除以 d，用于某些位置编码变体中的时间步压缩场景。

---

## 8.8 KV cache 内存管理

### 8.8.1 n_kv 的填充对齐

每次图构建时，实际读取的 cache 大小 `n_kv` 由 `get_n_kv(sinfo)` 计算（`src/llama-kv-cache.cpp:1129`）：

```cpp
// src/llama-kv-cache.cpp:1133-1143
const uint32_t n_pad_cur = std::max(n_pad, 256u);
// n_kv = GGML_PAD(used_max_p1, n_pad_cur)
result = std::max(
    std::min(cells.size(),
             std::max(n_pad_cur, GGML_PAD(cells.used_max_p1(), n_pad_cur))),
    result);
```

将 n_kv 对齐到 256 的倍数，使图拓扑（特别是 kq_mask 的形状）在多次调用间保持稳定，触发图复用优化，避免每次微量变化都重建图。

### 8.8.2 状态序列化

`state_write`（`src/llama-kv-cache.h:143`）将 cells 元数据和 KV 张量数据序列化：

```text
写入格式：
  [cell_count u32] [cells meta: pos[], seq[]] [KV tensor bytes]

读取格式（state_read）：
  → 调用 find_slot 找到空槽
  → 恢复 cells 元数据
  → 将 KV 字节数据写回 device buffer
```

单序列版本（`state_seq_get/set_data`，`include/llama.h`）只序列化指定 seq_id 的 cells，支持 server 端请求级别的状态快照与恢复，实现跨节点迁移或持久化缓存。

---

## 8.9 数据流总览

<svg viewBox="0 0 760 480" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="KV cache data flow in TG step">
  <defs>
    <marker id="ar8-3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="480" fill="#f8fafc" rx="6"/>
  <rect x="230" y="14" width="300" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="37" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">llama_decode（第 t 步 TG）</text>
  <line x1="380" y1="50" x2="380" y2="68" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8-3)"/>
  <rect x="60" y="70" width="640" height="72" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="180" y="90" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">memory→init_batch()</text>
  <text x="450" y="96" text-anchor="middle" font-size="11" fill="#64748b">find_slot()  寻找空闲 cell</text>
  <rect x="220" y="106" width="380" height="28" rx="4" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="240" y="116" font-size="10" fill="#94a3b8">cells:</text>
  <rect x="280" y="108" width="32" height="22" rx="2" fill="#f1f5f9" stroke="#cbd5e1"/><text x="296" y="124" text-anchor="middle" font-size="10" fill="#94a3b8">.</text>
  <rect x="314" y="108" width="32" height="22" rx="2" fill="#f1f5f9" stroke="#cbd5e1"/><text x="330" y="124" text-anchor="middle" font-size="10" fill="#94a3b8">.</text>
  <rect x="348" y="108" width="32" height="22" rx="2" fill="#99f6e4" stroke="#0d9488"/><text x="364" y="124" text-anchor="middle" font-size="10" fill="#0d9488">A</text>
  <rect x="382" y="108" width="32" height="22" rx="2" fill="#99f6e4" stroke="#0d9488"/><text x="398" y="124" text-anchor="middle" font-size="10" fill="#0d9488">A</text>
  <rect x="416" y="108" width="32" height="22" rx="2" fill="#99f6e4" stroke="#0d9488"/><text x="432" y="124" text-anchor="middle" font-size="10" fill="#0d9488">A</text>
  <rect x="450" y="108" width="32" height="22" rx="2" fill="#ddd6fe" stroke="#7c3aed"/><text x="466" y="124" text-anchor="middle" font-size="10" fill="#7c3aed">B</text>
  <rect x="484" y="108" width="32" height="22" rx="2" fill="#ddd6fe" stroke="#7c3aed"/><text x="500" y="124" text-anchor="middle" font-size="10" fill="#7c3aed">B</text>
  <rect x="518" y="108" width="32" height="22" rx="2" fill="#fef2f2" stroke="#dc2626" stroke-dasharray="3,2"/><text x="534" y="124" text-anchor="middle" font-size="10" fill="#dc2626">新</text>
  <rect x="552" y="108" width="32" height="22" rx="2" fill="#f1f5f9" stroke="#cbd5e1"/><text x="568" y="124" text-anchor="middle" font-size="10" fill="#94a3b8">.</text>
  <line x1="380" y1="142" x2="380" y2="162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8-3)"/>
  <rect x="60" y="164" width="640" height="180" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="160" y="184" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">process_ubatch()</text>
  <rect x="80" y="192" width="600" height="26" rx="4" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="390" y="210" text-anchor="middle" font-size="11" fill="#64748b">mctx→apply()  写 cells 元数据：pos[idx]=t, seq[idx] |= seq_id</text>
  <rect x="80" y="224" width="600" height="26" rx="4" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="390" y="242" text-anchor="middle" font-size="11" fill="#64748b">set_inputs()  k_idxs = stream×kv_size + cell_idx；kq_mask 历史=0 空=-∞</text>
  <rect x="80" y="256" width="600" height="80" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="160" y="274" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">graph_compute()</text>
  <text x="390" y="292" text-anchor="middle" font-size="11" fill="#7c3aed">k_cur = x × W_k → ggml_set_rows(K_cache, k_cur, k_idxs)  写 K</text>
  <text x="390" y="310" text-anchor="middle" font-size="11" fill="#7c3aed">v_cur = x × W_v → ggml_set_rows(V_cache, v_cur, v_idxs)  写 V</text>
  <text x="390" y="328" text-anchor="middle" font-size="11" fill="#7c3aed">attn = FA(Q, K_full, V_full, kq_mask)</text>
  <line x1="380" y1="344" x2="380" y2="364" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8-3)"/>
  <rect x="240" y="366" width="280" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="388" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">logits → ctx→logits buffer</text>
</svg>
<span class="figure-caption">图 R8.3 ｜ KV cache 单步 TG 数据流：槽位分配 → 元数据写入 → 散射写 K/V → 全历史注意力 → logits 输出</span>

<details>
<summary>ASCII 原版</summary>

```
llama_decode (第 t 步 TG)
    │
    ├── memory->init_batch()
    │       └── find_slot()          寻找空闲 cell
    │           cells: [. . A A A B B . .]
    │                        ^ 新 token 写入位置
    │
    ├── process_ubatch()
    │       ├── mctx->apply()        更新 cells 元数据：pos[idx]=t, seq[idx]|=seq_id
    │       │
    │       ├── set_input_k_idxs()   k_idxs[0] = stream*kv_size + cell_idx
    │       ├── set_input_v_idxs()   v_idxs[*] = (同上，转置时展开)
    │       ├── set_input_kq_mask()  [1, n_kv] mask：历史 token=0，未来/空=-inf
    │       │
    │       └── graph_compute()
    │               ├── k_cur = x * W_k             新 token 的 K
    │               ├── ggml_set_rows(K_cache, k_cur, k_idxs)  写入 cache
    │               ├── ggml_set_rows(V_cache, v_cur, v_idxs)  写入 cache
    │               ├── K_full = get_k(n_kv)        读取全部历史 K
    │               ├── V_full = get_v(n_kv)        读取全部历史 V
    │               └── attn = FA(Q, K_full, V_full, kq_mask)
    │
    └── logits → ctx->logits buffer
```

</details>

---

## 参考源文件

- `src/llama-memory.h` — `llama_memory_i` 接口 + `llama_memory_context_i`
- `src/llama-kv-cache.h` / `src/llama-kv-cache.cpp` — 标准 KV cache 实现
- `src/llama-kv-cells.h` — `llama_kv_cells` cells 元数据
- `src/llama-kv-cache-iswa.h` / `.cpp` — iSWA 变体（双缓存）
- `src/llama-memory-recurrent.h` / `.cpp` — SSM/Mamba recurrent state
- `src/llama-memory-hybrid.h` / `.cpp` — attention + recurrent 混合
- `src/llama-memory-hybrid-iswa.h` / `.cpp` — iSWA + recurrent 混合
