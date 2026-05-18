# 第 8 章：注意力子层

本章讲述 DwarfStar 4 如何在每个 transformer 层中执行注意力计算：从低秩 Q 投影、单 KV head 的压缩投影，到 per-head 归一化、layer-specific RoPE、sink-aware softmax、分组输出投影，以及 decode/prefill 两种代码路径。KV 缓存的存储与更新见 [第 7 章](07-kv-cache.md)；量化格式见 [第 4 章](04-quantization.md)；超连接（HC）数据流见 [第 9 章](09-moe-hyperconnections.md)。

---

## 8.1 注意力子层的整体位置

DeepSeek V4 Flash 每层的注意力子层被 HC 框架包裹。核心函数 `layer_attention_raw_swa_one`（`ds4.c:7068`）的调用上下文：

<svg viewBox="0 0 640 560" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Attention sublayer call stack from HC pre to HC post">
  <defs>
    <marker id="ar81" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="200" y="10" width="240" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="30" font-size="12" font-weight="600" fill="#7c3aed" text-anchor="middle">inp_hc (4 × 4096)</text>
  <line x1="320" y1="42" x2="320" y2="62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar81)"/>
  <rect x="160" y="62" width="320" height="32" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="78" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">hc_pre_from_state_one</text>
  <text x="320" y="88" font-size="10" fill="#64748b" text-anchor="middle">归一化 HC state，投影控制向量（见第 9 章）</text>
  <line x1="320" y1="94" x2="320" y2="114" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar81)"/>
  <text x="440" y="108" font-size="10" fill="#94a3b8">attn_cur (4096)</text>
  <rect x="180" y="114" width="280" height="28" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="132" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">layer_attn_norm_one ← 注意力 RMSNorm</text>
  <line x1="320" y1="142" x2="320" y2="162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar81)"/>
  <text x="440" y="156" font-size="10" fill="#94a3b8">attn_norm (4096)</text>
  <rect x="140" y="162" width="180" height="28" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="230" y="180" font-size="10" fill="#ea580c" text-anchor="middle">layer_q_projection_with_lora</text>
  <rect x="340" y="162" width="160" height="28" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="420" y="180" font-size="10" fill="#ea580c" text-anchor="middle">layer_kv_projection_normed</text>
  <line x1="230" y1="190" x2="320" y2="218" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar81)"/>
  <line x1="420" y1="190" x2="320" y2="218" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar81)"/>
  <text x="130" y="208" font-size="10" fill="#94a3b8">q (64h×512)</text>
  <text x="470" y="208" font-size="10" fill="#94a3b8">kv (512)</text>
  <rect x="140" y="218" width="360" height="52" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="320" y="234" font-size="10" fill="#64748b" text-anchor="middle">rope_tail_layer_inplace(q)  ← Q 的 RoPE</text>
  <text x="320" y="248" font-size="10" fill="#64748b" text-anchor="middle">rope_tail_layer_inplace(kv) ← KV 的 RoPE · FP8 量化(nope)</text>
  <text x="320" y="262" font-size="10" fill="#64748b" text-anchor="middle">kv_cache_push_raw + compressor ← 写入 KV 缓存（见第 7 章）</text>
  <line x1="320" y1="270" x2="320" y2="290" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar81)"/>
  <rect x="160" y="290" width="320" height="32" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="320" y="306" font-size="11" font-weight="600" fill="#0d9488" text-anchor="middle">layer_attention_mixed_one</text>
  <text x="320" y="316" font-size="10" fill="#64748b" text-anchor="middle">注意力计算（raw + comp）</text>
  <line x1="320" y1="322" x2="320" y2="342" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar81)"/>
  <rect x="140" y="342" width="360" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="320" y="354" font-size="10" fill="#64748b" text-anchor="middle">rope_tail_layer_inplace(inverse) ← 逆 RoPE 恢复 heads</text>
  <text x="320" y="364" font-size="10" fill="#64748b" text-anchor="middle">layer_grouped_out_one ← 分组输出投影</text>
  <line x1="320" y1="370" x2="320" y2="390" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar81)"/>
  <text x="440" y="384" font-size="10" fill="#94a3b8">attn_out (4096)</text>
  <rect x="180" y="390" width="280" height="28" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="408" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">hc_post_one ← 注入 HC state（见第 9 章）</text>
  <line x1="320" y1="418" x2="320" y2="438" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar81)"/>
  <rect x="200" y="438" width="240" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="458" font-size="12" font-weight="600" fill="#7c3aed" text-anchor="middle">after_attn_hc (4 × 4096)</text>
</svg>
<span class="figure-caption">图 R8.1 ｜ 注意力子层完整调用栈：HC pre → Q/KV 投影 → RoPE → 混合注意力 → 输出投影 → HC post</span>

<details>
<summary>ASCII 原版</summary>

```
inp_hc (4 × 4096)
    │
    ▼
hc_pre_from_state_one        ← 归一化 HC state，投影控制向量 (见第9章)
    │
    ▼ attn_cur (4096)
layer_attn_norm_one          ← 注意力 RMSNorm
    │
    ▼ attn_norm (4096)
layer_q_projection_with_lora_one  ← 低秩 Q 投影
layer_kv_projection_normed_one    ← KV 投影 + norm
    │
    ▼ q (64 heads × 512), kv (512)
rope_tail_layer_inplace(q)   ← Q 的 RoPE
rope_tail_layer_inplace(kv)  ← KV 的 RoPE
FP8 量化(kv nope 部分)
kv_cache_push_raw + compressor  ← 写入 KV 缓存 (见第7章)
    │
    ▼
layer_attention_mixed_one    ← 注意力计算（raw + comp）
rope_tail_layer_inplace(inverse)  ← 逆 RoPE 恢复 heads
layer_grouped_out_one        ← 分组输出投影
    │
    ▼ attn_out (4096)
hc_post_one                  ← 注入 HC state (见第9章)
    │
    ▼ after_attn_hc (4 × 4096)
```

</details>

---

## 8.2 低秩 Q 投影

### 8.2.1 问题

64 heads × 512 = 32768 维的 Q 向量直接从 4096 维 embedding 投影，参数量是 4096×32768=134M，代价很高。低秩分解将其拆分为两步：4096→1024（压缩），1024→32768（恢复），中间加一个 RMSNorm 稳定训练。

### 8.2.2 实现

`ds4.c:4666`（`layer_q_projection_normed_one`）：

```c
static void layer_q_projection_normed_one(
        const ds4_model *model,
        const ds4_layer_weights *layer,
        const float *norm, float *q) {
    float *qr = xmalloc(1024 * sizeof(qr[0]));
    float *qr_norm = xmalloc(1024 * sizeof(qr_norm[0]));
    const float *q_a_norm = tensor_data(model, layer->attn_q_a_norm);

    matvec_q8_0(qr, model, layer->attn_q_a, norm);          // 4096 → 1024
    rms_norm_weight(qr_norm, qr, q_a_norm, 1024, DS4_RMS_EPS);  // RMSNorm
    matvec_q8_0(q, model, layer->attn_q_b, qr_norm);        // 1024 → 32768
    head_rms_norm_inplace(q, DS4_N_HEAD, DS4_N_HEAD_DIM, DS4_RMS_EPS); // per-head norm
    free(qr_norm);
    free(qr);
}
```

张量规格（`ds4.c:2378`）：
- `attn_q_a`：Q8_0，shape `[4096, 1024]`（`DS4_N_EMBD × DS4_N_LORA_Q`）
- `attn_q_a_norm`：F32，shape `[1024]`（per-channel 学习 scale）
- `attn_q_b`：Q8_0，shape `[1024, 32768]`（`DS4_N_LORA_Q × DS4_N_HEAD × DS4_N_HEAD_DIM`）

`layer_q_projection_with_lora_one`（`ds4.c:4687`）是带副输出版本：它同时返回 `qr_norm`（1024 维），供 indexer（[第 7 章](07-kv-cache.md#7.6) ratio-4 层）复用，避免重复计算。

---

## 8.3 per-head Q 归一化

`ds4.c:2789`（`head_rms_norm_inplace`）：

```c
static void head_rms_norm_inplace(float *x, uint32_t n_head,
        uint32_t head_dim, float eps) {
    for (uint32_t h = 0; h < n_head; h++) {
        float *head = x + (uint64_t)h * head_dim;
        double ss = 0.0;
        for (uint32_t i = 0; i < head_dim; i++)
            ss += (double)head[i] * head[i];
        const float scale = 1.0f / sqrtf((float)(ss / (double)head_dim) + eps);
        for (uint32_t i = 0; i < head_dim; i++) head[i] *= scale;
    }
}
```

注意这是**不带学习 scale** 的 RMSNorm（只做 `x / rms(x)`，无 weight 参数）。每个 attention head 独立归一化，相当于对 Q 向量做 L2 归一化（忽略 eps）。目的是防止不同 head 之间因幅值差异导致注意力分数分布失衡。

---

## 8.4 KV 投影

### 8.4.1 单 KV Head 设计

DS4 Flash 只有 `DS4_N_HEAD_KV=1` 个 KV head（GQA 极端情况），所有 64 个 Q head 共享同一个 512 维 KV 向量。这大幅降低 KV 缓存带宽：每个 token 存 1×512 float 而非 64×512。

`ds4.c:4704`（`layer_kv_projection_normed_one`）：

```c
static void layer_kv_projection_normed_one(
        const ds4_model *model,
        const ds4_layer_weights *layer,
        const float *normed, float *kv) {
    float *raw = xmalloc((size_t)DS4_N_HEAD_DIM * sizeof(raw[0]));
    const float *kv_norm = tensor_data(model, layer->attn_kv_a_norm);

    matvec_q8_0(raw, model, layer->attn_kv, normed);         // 4096 → 512
    rms_norm_weight(kv, raw, kv_norm, DS4_N_HEAD_DIM, DS4_RMS_EPS); // 学习 RMSNorm
    free(raw);
}
```

张量规格（`ds4.c:2381`）：
- `attn_kv`：Q8_0，shape `[4096, 512]`（`DS4_N_EMBD × DS4_N_HEAD_DIM`）
- `attn_kv_a_norm`：F32，shape `[512]`（per-channel 学习 scale）

与 Q 的两步投影不同，KV 是直接 4096→512 的单步投影加一个有学习 scale 的 RMSNorm。这个 RMSNorm 对于压缩器的池化质量至关重要：它稳定了存入 KV 缓存的向量幅值。

---

## 8.5 RoPE：只作用于尾部，层类型决定参数

### 8.5.1 tail-only RoPE 的设计

KV 向量每行 512 维，前 `512-64=448` 维为 nope（non-RoPE），后 64 维（`DS4_N_ROT`）为 RoPE 旋转区域。Q 向量每 head 512 维，同样只旋转尾部 64 维。

将 RoPE 限制在尾部有两个好处：
1. nope 部分可以做 FP8 量化而不影响位置编码（位置信息存于 RoPE 维度）
2. 压缩器处理 nope 部分时无需感知绝对位置，改用 APE 偏置提供窗口内相对位置

`ds4.c:4763`（`rope_tail_ext_inplace`）的核心：

```c
for (uint32_t h = 0; h < n_head; h++) {
    float *tail = x + (uint64_t)h * head_dim + n_nope;  // 跳过 nope 部分
    float theta_extrap = (float)pos;
    for (uint32_t i = 0; i < n_rot; i += 2) {
        /* YaRN 插值：theta = lerp(interp, extrap, ramp_mix) */
        const float theta_interp = freq_scale * theta_extrap;
        float theta = theta_interp;
        if (ext_factor != 0.0f) {
            const float ramp_mix = rope_yarn_ramp(...) * ext_factor;
            theta = theta_interp * (1.0f - ramp_mix) + theta_extrap * ramp_mix;
        }
        const float c = cosf(theta) * mscale;
        const float s = sin_sign * sinf(theta) * mscale;
        /* 旋转两个相邻维度 */
        tail[i+0] = x0 * c - x1 * s;
        tail[i+1] = x0 * s + x1 * c;
        theta_extrap *= theta_scale;
    }
}
```

### 8.5.2 dense 层与 compressed 层使用不同参数

`ds4.c:4816`（`layer_rope_freq_base`）：

```c
static float layer_rope_freq_base(uint32_t il) {
    return ds4_layer_compress_ratio(il) != 0 && DS4_COMPRESS_ROPE_FREQ_BASE > 0.0f
        ? DS4_COMPRESS_ROPE_FREQ_BASE   // 160000.0f，长上下文
        : DS4_ROPE_FREQ_BASE;           // 10000.0f，标准
}
```

压缩层（ratio != 0，即层 2-42）使用 freq_base=160000，同时 `freq_scale = 1/16`（`DS4_ROPE_SCALE_FACTOR=16`），配合 YaRN 插值（`ext_factor=1.0`，`orig_ctx=65536`）实现 16× 上下文扩展。dense 层（层 0-1）使用标准 base=10000。

逆 RoPE（`inverse=true`，`sin_sign=-1`）在注意力计算后对 heads 矩阵调用，把 value 向量的位置编码抹去，确保输出投影看到的是不含 RoPE 旋转的 value 内容。

---

## 8.6 sink-aware 注意力

### 8.6.1 sink logit 的作用

传统注意力 softmax 要求所有 score 之和为 1，但实际上某些 token 可能完全无关——强制分配注意力权重会引入噪声。DS4 为每个 head 学习一个"sink logit"：它参与 softmax 的分母，但不贡献任何 value 向量。等效于在 KV 序列前插入一个"黑洞"token，只消耗权重而不输出内容。

`ds4.c:4967`（`layer_attention_rows_one`）：

```c
const float *sinks = tensor_data(model, layer->attn_sinks);  // shape [64]
/* 初始 max_score 从 sinks[h] 出发，而非 -INF */
float max_score = sinks[h];
for (uint32_t r = 0; r < n_kv; r++) {
    score[r] = dot_f32(qh, kv_rows + r*DS4_N_HEAD_DIM, DS4_N_HEAD_DIM) * kq_scale;
    if (score[r] > max_score) max_score = score[r];
}
/* softmax 分母以 sink 的贡献开局 */
float denom = expf(sinks[h] - max_score);
for (uint32_t r = 0; r < n_kv; r++) {
    const float weight = expf(score[r] - max_score);
    axpy_f32(oh, kv_rows + r*DS4_N_HEAD_DIM, weight, DS4_N_HEAD_DIM);
    denom += weight;
}
scale_f32(oh, 1.0f / denom, DS4_N_HEAD_DIM);
```

`attn_sinks` 是 F32 张量，shape `[DS4_N_HEAD=64]`，每个 head 一个标量。训练时这些值会自动学习到合适的"吸收无关注意力"水平。

---

## 8.7 raw SWA + 压缩行的混合注意力

### 8.7.1 layer_attention_mixed_one

`ds4.c:6698`（`layer_attention_mixed_one`）同时接受 raw 行和压缩行：

```c
static void layer_attention_mixed_one(
        float *out_heads, ...,
        const float *raw_kv, uint32_t n_raw,
        const float *comp_kv, uint32_t n_comp,
        const bool  *comp_allowed) {   // 来自 indexer，可以为 NULL
    for (uint32_t h = 0; h < DS4_N_HEAD; h++) {
        float max_score = sinks[h];    // sink logit 作起始
        /* raw 行 */
        for (r in 0..n_raw) score[r] = dot(qh, raw_kv[r]) * kq_scale;
        /* 压缩行（受 allowed 掩码过滤） */
        for (r in 0..n_comp) {
            if (comp_allowed && !comp_allowed[r]) { score[n_raw+r] = NEG_INF; continue; }
            score[n_raw+r] = dot(qh, comp_kv[r]) * kq_scale;
        }
        /* softmax + value accumulation */
    }
}
```

`comp_allowed=NULL` 时表示 ratio-128 层（无 indexer），全部压缩行参与注意力。ratio-4 层传入 indexer 生成的 allowed 掩码，只有 top-512 行不被置为 `NEG_INF`（`ds4.c:6727`）。

### 8.7.2 decode scratch 版本

`layer_attention_mixed_one_decode_scratch`（`ds4.c:6762`）从 `scratch->attn_score` 借用 score 缓冲区（容量预计算为 `raw_cap + comp_cap`），避免栈溢出风险（`ds4.c:6776`检查上限）。

---

## 8.8 分组输出投影

### 8.8.1 为什么要分组

输出投影的朴素做法是一个 `[32768, 4096]` 矩阵。分组低秩（`ds4.c:5018`）把它拆为：
1. 8 组，每组 `8 heads × 512 = 4096` 维 → 1024 维低秩向量（`attn_output_a`，Q8_0）
2. 把 `8 × 1024 = 8192` 的拼接 → 4096（`attn_output_b`，Q8_0）

```c
static void layer_grouped_out_one(
        float *out, const ds4_model *model,
        const ds4_layer_weights *layer, const float *heads) {
    const uint32_t n_groups = 8;
    const uint32_t group_heads = DS4_N_HEAD / n_groups;      // 8 heads/group
    const uint32_t group_dim = DS4_N_HEAD_DIM * group_heads; // 4096
    const uint32_t rank = 1024;                               // DS4_N_LORA_O

    float *low = xcalloc((size_t)n_groups * rank, sizeof(low[0]));
    matvec_q8_0_grouped_rows(low, model, layer->attn_output_a,
                             heads, n_groups, group_dim, rank);
    matvec_q8_0(out, model, layer->attn_output_b, low);
    free(low);
}
```

`attn_output_a`：shape `[4096, 1024]`，按行切分为 8 块，每块对应一组的 group_dim=4096 维输入。`matvec_q8_0_grouped_rows` 并行处理 8 组，输出 `8×1024` 维拼接向量。

---

## 8.9 prefix prefill 注意力（新 prompt）

`ds4.c:6906`（`layer_attention_prefix_batch`）：prefill 时计算整批 token 的注意力，但 KV 缓存在 prefill 后才真正使用。每个 token `t` 只能看到位置 `≤t` 的 raw 行（causal mask），以及 prefill 前已存在的压缩行（不受 causal 限制）。

具体地，每个 token 看到的 raw 行数为 `min(t+1, raw_cap)`，并且使用 `comp_counts[t]` 指定该 token 可见的压缩行数（prefill 期间压缩行逐步增长）。

`layer_attention_prefix_batch_worker`（在 `ds4.c:6921` 被并行分发）对 `n_tok × DS4_N_HEAD` 个 head 并行执行注意力。

---

## 8.10 批量 prefill 注意力

`ds4.c:7179`（`layer_attention_raw_swa_batch`）处理整个 prefill 批次：

1. 批量 HC pre：批量归一化 + HC 控制投影（并行 token）
2. 批量 Q 投影（`matmul_q8_0_batch`）
3. 批量 KV 投影
4. 批量 RoPE
5. **token-by-token 循环**：对每个 token 更新 raw 缓存和压缩器（必须顺序执行，因为压缩器有状态）
6. 批量 prefix attention（`layer_attention_prefix_batch`，并行）
7. 批量输出投影

token-by-token 循环（`ds4.c:~7260` 附近）是 prefill 吞吐的瓶颈之一，因为压缩器的滚动 state 无法并行化——必须按时间顺序更新。

---

## 8.11 单 token decode 注意力子层

`ds4.c:7068`（`layer_attention_raw_swa_one`）是 decode 时的主路径：

```c
/* 1. HC pre */
hc_pre_from_state_one(model, layer->hc_attn_fn, ...,
                      attn_residual, attn_cur, post, comb);
/* 2. attn norm */
layer_attn_norm_one(attn_norm, model, layer, attn_cur);
/* 3. Q/KV 投影 */
layer_q_projection_with_lora_one(model, layer, attn_norm, q, qr_norm);
layer_kv_projection_normed_one(model, layer, attn_norm, kv);
/* 4. RoPE */
rope_tail_layer_inplace(q, DS4_N_HEAD, DS4_N_HEAD_DIM, DS4_N_ROT, pos, il, false);
rope_tail_layer_inplace(kv, DS4_N_HEAD_KV, DS4_N_HEAD_DIM, DS4_N_ROT, pos, il, false);
dsv4_fp8_kv_quantize_row_inplace_cpu(kv, DS4_N_HEAD_DIM, DS4_N_ROT);
/* 5. 更新 KV 缓存 + 压缩器 */
kv_cache_push_raw(cache, kv);
if (ratio != 0) { compressor_decode_one(...); /* → attn_comp_kv */ }
/* 6. ratio-4：indexer 选允许行 */
if (ratio == 4) comp_allowed = indexer_allowed_decode_one(...);
/* 7. 注意力 */
if (ratio != 0)
    layer_attention_mixed_one(heads, ..., raw_kv, n_raw, attn_comp_kv, n_comp, comp_allowed);
else
    layer_attention_rows_one(heads, ..., raw_kv, n_raw);
/* 8. 逆 RoPE */
rope_tail_layer_inplace(heads, DS4_N_HEAD, DS4_N_HEAD_DIM, DS4_N_ROT, pos, il, true);
/* 9. 输出投影 */
layer_grouped_out_one(attn_out, model, layer, heads);
/* 10. HC post */
hc_post_one(after_attn_hc, attn_out, attn_residual, post, comb, DS4_N_EMBD, n_hc);
```

decode scratch 版本（`layer_attention_raw_swa_one_decode_scratch`，`ds4.c:~7190`）从预分配缓冲区取得所有临时缓冲，整个路径零动态内存分配。

---

## 8.12 关键常数汇总

| 常量 | 值 | 含义 |
|------|----|------|
| `DS4_N_HEAD` | 64 | Q head 数 |
| `DS4_N_HEAD_KV` | 1 | KV head 数 |
| `DS4_N_HEAD_DIM` | 512 | head 维度 |
| `DS4_N_ROT` | 64 | RoPE 旋转维度（tail 部分） |
| `DS4_N_LORA_Q` | 1024 | Q 低秩中间维度 |
| `DS4_N_LORA_O` | 1024 | 输出低秩维度 |
| `DS4_N_OUT_GROUP` | 8 | 输出投影分组数 |
| `DS4_ROPE_FREQ_BASE` | 10000.0 | dense 层 RoPE base |
| `DS4_COMPRESS_ROPE_FREQ_BASE` | 160000.0 | 压缩层 RoPE base |
| `DS4_ROPE_SCALE_FACTOR` | 16.0 | 压缩层 RoPE 频率缩放 |
| `DS4_ROPE_ORIG_CTX` | 65536 | YaRN 参考上下文长度 |

---

## 8.13 注意力的数值稳定性约定

1. **max-trick softmax**：所有 softmax 计算（包括 sink 参与时）均用 max 偏移
2. **sink 与 max 的交互**：`max_score` 初始化为 `sinks[h]`，确保 sink 的 exp 也参与精度截断
3. **Q scale**：`kq_scale = 1/sqrt(512)`，在点积前乘以，而非归一化 Q（因为 per-head RMSNorm 已经控制了 Q 的幅值）
4. **逆 RoPE**：value head 在输出投影前需要逆 RoPE，使投影矩阵学习到不含位置信息的语义

---

## 本章小结

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Attention data flow summary: Q/KV projection, RoPE, mixed attention, grouped output">
  <defs>
    <marker id="ar82" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="ar82g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#16a34a"/>
    </marker>
  </defs>
  <rect x="290" y="8" width="180" height="28" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="26" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">attn_norm (4096)</text>
  <line x1="380" y1="36" x2="380" y2="56" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="180" y1="56" x2="580" y2="56" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="180" y1="56" x2="180" y2="76" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar82)"/>
  <line x1="580" y1="56" x2="580" y2="76" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar82)"/>
  <rect x="20" y="76" width="320" height="80" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="180" y="95" font-size="11" font-weight="700" fill="#ea580c" text-anchor="middle">Q 路径</text>
  <text x="180" y="111" font-size="10" fill="#64748b" text-anchor="middle">4096 →[Q8_0]→ 1024</text>
  <text x="180" y="124" font-size="10" fill="#64748b" text-anchor="middle">→ RMSNorm → 1024 →[Q8_0]→ 64h×512</text>
  <text x="180" y="137" font-size="10" fill="#64748b" text-anchor="middle">→ per-head RMSNorm → RoPE(tail 64)</text>
  <rect x="420" y="76" width="320" height="80" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="580" y="95" font-size="11" font-weight="700" fill="#0d9488" text-anchor="middle">KV 路径</text>
  <text x="580" y="111" font-size="10" fill="#64748b" text-anchor="middle">4096 →[Q8_0]→ 512</text>
  <text x="580" y="124" font-size="10" fill="#64748b" text-anchor="middle">→ RMSNorm → FP8(nope) + RoPE(tail 64)</text>
  <text x="580" y="137" font-size="10" fill="#64748b" text-anchor="middle">→ KV 缓存（raw + comp，见第 7 章）</text>
  <line x1="180" y1="156" x2="380" y2="196" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar82)"/>
  <line x1="580" y1="156" x2="380" y2="196" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar82)"/>
  <text x="80" y="184" font-size="10" fill="#94a3b8">q (64h×512)</text>
  <text x="540" y="184" font-size="10" fill="#94a3b8">raw_kv, comp_kv</text>
  <rect x="160" y="196" width="440" height="36" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="380" y="210" font-size="11" font-weight="600" fill="#16a34a" text-anchor="middle">sink-aware softmax + mixed attention</text>
  <text x="380" y="224" font-size="10" fill="#64748b" text-anchor="middle">comp 受 indexer 掩码（ratio-4 层 top-512 行）</text>
  <line x1="380" y1="232" x2="380" y2="254" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar82)"/>
  <text x="440" y="248" font-size="10" fill="#94a3b8">heads (64h×512)</text>
  <rect x="160" y="254" width="440" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="380" y="268" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">逆 RoPE → 分组输出投影</text>
  <text x="380" y="282" font-size="10" fill="#64748b" text-anchor="middle">8 组 × (4096→1024)，拼接 8×1024 → 4096</text>
  <line x1="380" y1="290" x2="380" y2="312" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar82)"/>
  <text x="440" y="306" font-size="10" fill="#94a3b8">attn_out (4096)</text>
  <rect x="270" y="312" width="220" height="28" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="330" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">attn_out (4096)</text>
</svg>
<span class="figure-caption">图 R8.2 ｜ 注意力数据流总结：Q 低秩两步投影与 KV 单步投影汇入混合注意力，再经分组低秩输出投影</span>

<details>
<summary>ASCII 原版</summary>

```
attn_norm (4096)
    ├── Q: 4096 →[Q8_0]→ 1024 → RMSNorm → 1024 →[Q8_0]→ 64h×512 → per-head RMSNorm → RoPE(tail 64)
    └── KV: 4096 →[Q8_0]→ 512 → RMSNorm → FP8(nope) + RoPE(tail 64)
                                                    ↓
                                          KV 缓存（raw + comp，见第7章）
    ↓ q (64h×512), raw_kv, comp_kv
sink-aware softmax + mixed attention (comp 受 indexer 掩码)
    ↓ heads (64h×512)
逆 RoPE → 分组输出投影 (8组 × 4096→1024，拼接→4096)
    ↓ attn_out (4096)
```

</details>

DS4 注意力的核心创新：极端 GQA（1 KV head），Q 低秩分解，per-head 归一化，tail-only RoPE（压缩层与 dense 层不同参数），学习 sink logit，以及分组低秩输出投影。
