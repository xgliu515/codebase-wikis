# 第 7 章：KV 缓存——压缩与原始滑动窗口

本章讲述 DwarfStar 4 如何在单一上下文窗口内同时维护两类 KV 历史：一个定长 raw 滑动窗口（SWA）保留最近的精确值，以及一组压缩行用于远程上下文的软摘要。注意力子层使用时参见 [第 8 章](08-attention.md)；量化细节参见 [第 4 章](04-quantization.md)。

---

## 7.1 设计动机：为什么需要两种缓存

标准 KV 缓存的问题是内存随序列长度线性增长。一个朴素的解法是固定滑动窗口，但这样超出窗口的内容就被完全遗忘。DeepSeek V4 Flash 的压缩方案在窗口外维持一个"软历史"：把每 ratio 个 token 的 KV 向量通过 per-dimension softmax 池化汇聚成一行，从而以远小于原始序列的代价保留全局语义。

两种缓存的直觉分工：

<svg viewBox="0 0 760 220" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="KV cache timeline showing compressed history and raw sliding window">
  <defs>
    <marker id="ar71" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="0" y="0" width="760" height="220" fill="none"/>
  <text x="20" y="28" font-size="12" font-weight="600" fill="currentColor">序列时间轴</text>
  <line x1="20" y1="44" x2="720" y2="44" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar71)"/>
  <rect x="20" y="56" width="300" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="170" y="73" font-size="12" font-weight="600" fill="#ea580c" text-anchor="middle">... 老 token ...</text>
  <text x="170" y="90" font-size="10" fill="#64748b" text-anchor="middle">压缩历史区</text>
  <rect x="340" y="56" width="260" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="470" y="73" font-size="12" font-weight="600" fill="#0d9488" text-anchor="middle">... 近期 raw window ...</text>
  <text x="470" y="90" font-size="10" fill="#64748b" text-anchor="middle">精确缓存区</text>
  <rect x="620" y="56" width="80" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="660" y="73" font-size="12" font-weight="600" fill="#7c3aed" text-anchor="middle">当前</text>
  <text x="660" y="90" font-size="10" fill="#64748b" text-anchor="middle">token</text>
  <line x1="170" y1="100" x2="170" y2="148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <line x1="470" y1="100" x2="470" y2="148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="60" y="148" width="220" height="56" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="170" y="166" font-size="12" font-weight="600" fill="#ea580c" text-anchor="middle">压缩行 (attn_comp_kv)</text>
  <text x="170" y="181" font-size="10" fill="#64748b" text-anchor="middle">每 ratio 个 token 汇聚一行</text>
  <text x="170" y="196" font-size="10" fill="#64748b" text-anchor="middle">全局软历史</text>
  <rect x="360" y="148" width="220" height="56" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="470" y="166" font-size="12" font-weight="600" fill="#0d9488" text-anchor="middle">raw 行 (raw_kv)</text>
  <text x="470" y="181" font-size="10" fill="#64748b" text-anchor="middle">最近 raw_cap 行，精确存储</text>
  <text x="470" y="196" font-size="10" fill="#64748b" text-anchor="middle">局部精确注意力</text>
</svg>
<span class="figure-caption">图 R7.1 ｜ KV 缓存时间轴：老 token 汇聚为压缩行，近期 token 精确保存在 raw 滑动窗口</span>

<details>
<summary>ASCII 原版</summary>

```
序列时间轴
───────────────────────────────────────────────────────►
  [... 老 token ...] [... 近期 raw window ...] [当前]
        ↓                       ↓
  压缩行 (attn_comp_kv)    raw 行 (raw_kv)
  每 ratio 个 token          最近 raw_cap 行
  汇聚一行                   精确存储
  全局软历史                  局部精确注意力
```

</details>

---

## 7.2 KV 缓存数据结构

### 7.2.1 整体布局

每层缓存由 `ds4_layer_cache` 描述，43 层在 `ds4_kv_cache.layer[]` 数组中：

`ds4.c:6331`（`kv_cache_init`）——分配时即体现两部分结构：

```c
/* ds4.c:6333 */
static void kv_cache_init(ds4_kv_cache *cache, uint32_t ctx_size, uint32_t raw_cap) {
    for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
        const uint32_t ratio = ds4_layer_compress_ratio(il);
        cache->layer[il].cap_raw = raw_cap;
        cache->layer[il].raw_kv = xmalloc_zeroed((size_t)raw_cap * DS4_N_HEAD_DIM,
                                                  sizeof(float));
        cache->layer[il].compress_ratio = ratio;

        if (ratio != 0) {
            const uint32_t comp_cap = ctx_size / ratio + 2;
            cache->layer[il].attn_comp_kv = xmalloc_zeroed(
                (size_t)comp_cap * DS4_N_HEAD_DIM, sizeof(float));
            /* ... 还有 state_kv、state_score ... */
        }
    }
}
```

`ds4_layer_cache` 的关键字段：

| 字段 | 类型 | 含义 |
|------|------|------|
| `raw_kv` | `float *` | raw SWA 行，每行 `DS4_N_HEAD_DIM`=512 float |
| `n_raw` | `uint32_t` | 当前有效 raw 行数 |
| `cap_raw` | `uint32_t` | raw 区容量（等于 `raw_cap`） |
| `attn_comp_kv` | `float *` | 压缩行存储，每行 512 float |
| `n_comp` | `uint32_t` | 已压缩行数 |
| `comp_cap` | `uint32_t` | 压缩区容量（`ctx_size/ratio+2`） |
| `attn_state_kv` | `float *` | 压缩器滚动窗口的 KV 状态 |
| `attn_state_score` | `float *` | 压缩器滚动窗口的 score 状态 |
| `index_comp_kv` | `float *` | ratio-4 层专用的 indexer 压缩行 |
| `compress_ratio` | `uint32_t` | 0 表示不压缩，4 或 128 |

### 7.2.2 压缩比规则

`ds4.c:411`：

```c
static uint32_t ds4_layer_compress_ratio(uint32_t il) {
    if (il < 2) return 0;          // 层 0-1：纯 raw，不压缩
    return (il & 1u) == 0 ? 4u : 128u;
}
```

即：
- 层 0-1：`ratio=0`，只有 raw SWA，无压缩
- 偶数层（2、4、6…42）：`ratio=4`，每 4 个 token 压缩一行，同时运行 indexer
- 奇数层（3、5、7…41）：`ratio=128`，每 128 个 token 压缩一行

ratio-4 层压缩频率高，历史密度大，但访问时需要 indexer 筛选；ratio-128 层相当于稀疏全局摘要。

---

## 7.3 raw 滑动窗口追加

### 7.3.1 滑动逻辑

`ds4.c:6389`（`kv_cache_push_raw`）：

```c
static void kv_cache_push_raw(ds4_layer_cache *cache, const float *kv) {
    if (cache->n_raw < cache->cap_raw) {
        float *dst = cache->raw_kv + (uint64_t)cache->n_raw * DS4_N_HEAD_DIM;
        for (uint32_t i = 0; i < DS4_N_HEAD_DIM; i++)
            dst[i] = f16_to_f32(f32_to_f16(kv[i]));
        cache->n_raw++;
        return;
    }
    /* 满了：把 [1..cap_raw-1] 整体向前移动一行 */
    memmove(cache->raw_kv,
            cache->raw_kv + DS4_N_HEAD_DIM,
            (size_t)(cache->cap_raw - 1) * DS4_N_HEAD_DIM * sizeof(float));
    float *dst = cache->raw_kv + (uint64_t)(cache->cap_raw - 1) * DS4_N_HEAD_DIM;
    for (uint32_t i = 0; i < DS4_N_HEAD_DIM; i++)
        dst[i] = f16_to_f32(f32_to_f16(kv[i]));
}
```

注意存入时对所有维度做了一轮 F32→F16→F32 的精度截断。这与模型训练精度一致（Metal/CUDA backend 亦使用 F16 存储 raw KV）。窗口满后的滑动是 `memmove`，开销为 `O(cap_raw × head_dim)`——在解码时 `cap_raw=128` 行（`DS4_N_SWA`），这相当于移动 128×512×4=262 KB，可接受。

### 7.3.2 默认容量

`ds4.c:6177`：

```c
static uint32_t ds4_default_raw_cap(uint32_t ctx_size) {
    uint32_t raw_cap = DS4_N_SWA;   // 128
    if (raw_cap > ctx_size) raw_cap = ctx_size;
    if (raw_cap == 0) raw_cap = 1;
    return raw_cap;
}
```

`DS4_N_SWA=128` 行，即保留最近 128 个 token 的精确 KV。

---

## 7.4 流式压缩器

### 7.4.1 问题背景

每次 decode 一个 token，如何实时产生压缩行而无需重放整个历史？答案是维护一个"滚动窗口状态"：长度为 `ratio` 的 state 矩阵存储当前压缩窗口内的 KV 和 score 行，每个 token 更新一次，窗口满时池化输出一行。

### 7.4.2 单 token 流式更新

`ds4.c:6512`（`compressor_decode_one`）：

```c
static bool compressor_decode_one(
        float *out_comp, const ds4_model *model,
        const ds4_tensor *wkv, const ds4_tensor *wgate,
        const ds4_tensor *ape,  const ds4_tensor *norm,
        const float *x,
        float *state_kv, float *state_score,
        uint32_t head_dim, uint32_t compress_ratio,
        uint32_t il, uint32_t pos) {
    const uint32_t coff = compress_ratio == 4 ? 2u : 1u;
    const uint32_t width = coff * head_dim;
    const uint32_t pos_mod = pos % compress_ratio;
    const uint32_t row = compress_ratio == 4 ? compress_ratio + pos_mod : pos_mod;
    const bool should_compress = ((pos + 1) % compress_ratio) == 0;
    /* ... 投影 kv_cur / sc_cur ... */
    /* 加位置编码偏置（APE） */
    for (uint32_t j = 0; j < width; j++)
        sc_cur[j] += tensor_2d_value(model, ape, j, pos_mod);
    /* 写入 state 的对应行 */
    memcpy(state_kv    + (uint64_t)row * width, kv_cur, ...);
    memcpy(state_score + (uint64_t)row * width, sc_cur, ...);
    if (!should_compress) return false;
    /* 窗口满：池化 → 归一化 → RoPE → FP8 量化 → 输出 */
    compressor_pool_decode_state(pooled, state_kv, state_score, head_dim, compress_ratio);
    /* RMSNorm + RoPE + FP8 写入 out_comp */
    return true;
}
```

关键步骤：
1. 投影：把当前 token 的 4096 维向量通过 `wkv`（F16）和 `wgate`（F16）投影到 `width` 维的 `kv_cur` 和 `sc_cur`
2. APE（绝对位置编码偏置）：`sc_cur[j] += ape[j, pos_mod]`，让 score 感知窗口内位置
3. 写入 state：在 `state_kv/state_score` 的第 `row` 行写入本 token 的 KV 和 score
4. 判断是否压缩：`(pos + 1) % ratio == 0` 时触发
5. 若触发：调用 `compressor_pool_decode_state` 池化，然后 RMSNorm + RoPE + FP8 量化写入 `out_comp`

### 7.4.3 per-dimension softmax 池化

`ds4.c:6457`（`compressor_pool_decode_state`）：

```c
for (uint32_t j = 0; j < head_dim; j++) {
    /* 找 max score（用于 numerically stable softmax） */
    float max_score = DS4_NEG_INF;
    for (uint32_t r = 0; r < compress_ratio; r++) {
        const float s = state_score[(uint64_t)r * width + j];
        if (s > max_score) max_score = s;
    }
    float denom = 0.0f, sum = 0.0f;
    for (uint32_t r = 0; r < compress_ratio; r++) {
        const float w = expf(state_score[(uint64_t)r * width + j] - max_score);
        denom += w;
        sum += w * state_kv[(uint64_t)r * width + j];
    }
    out[j] = denom > 0.0f ? sum / denom : 0.0f;
}
```

这是 **per-dimension** 的 softmax：每个维度 `j` 独立在 ratio 个窗口行上做 softmax 加权，得到该维度的汇聚值。与标准的 cross-token 注意力不同，这里的"注意力"只在压缩窗口内部计算，权重来自模型学习的 score 投影。

### 7.4.4 ratio-4 层的双通道状态

`compress_ratio == 4` 时 `coff=2`，state 宽度为 `2 × head_dim`，state 行数为 `2 × ratio = 8`。其中：
- `row 0..3`：前一个压缩窗口的残留（供后续使用）
- `row 4..7`（`row = compress_ratio + pos_mod`）：当前窗口写入位

池化时会把前后两组 row 的 score 一起参与 max 查找（`ds4.c:6471`）。窗口压缩完成后把 `row 4..7` 复制到 `row 0..3` 作为下一个周期的"前一窗口"（`ds4.c:6589`）。

### 7.4.5 decode scratch 版本

生产路径中解码器使用 `compressor_decode_one_decode_scratch`（`ds4.c:6611`），它从预分配的 `ds4_cpu_decode_scratch` 结构中借用缓冲区，避免 hot loop 中的 malloc/free。逻辑完全相同，只是把 `xmalloc` 改为 `scratch->comp_kv_cur` 等字段。

---

## 7.5 prefill 后清理压缩器状态

prefill 结束后，压缩器 state 中可能有未完整填满的窗口（即 `n_tokens % ratio != 0`）。这些"悬挂"的部分 state 行需要清零，否则 decode 阶段的流式压缩器会把旧的 prefill 残留当作有效 score 参与池化。

`ds4.c:6412`（`compressor_finish_prefill_state_cpu`）：

```c
const uint32_t rem = n_tokens % compress_ratio;
const uint32_t clear_start = compress_ratio == 4 ? compress_ratio + rem : rem;
const uint32_t clear_end   = compress_ratio == 4 ? 2u * compress_ratio : compress_ratio;

for (uint32_t row = clear_start; row < clear_end; row++) {
    memset(kv    + (uint64_t)row * width, 0, ...);
    for (uint32_t i = 0; i < width; i++) score[i + row*width] = DS4_NEG_INF;
}
```

把 `[clear_start, clear_end)` 范围内的 state 行置为"空"（KV 全 0，score 全 `DS4_NEG_INF`），确保 decode 第一个 token 时池化结果不受 prefill 末尾不完整窗口的影响。

`kv_cache_finish_prefill_states`（`ds4.c:6436`）遍历所有层调用此函数，ratio=4 层还需清理 indexer state。

---

## 7.6 ratio-4 层的 indexer

### 7.6.1 问题

ratio-4 层压缩频繁，long context 时 `n_comp` 可以很大（`ctx/4`）。若 attention 扫描全部压缩行，计算量过大。indexer 是一个小型"辅助注意力"，用来在正式 attention 前选出最相关的 `DS4_N_INDEXER_TOP_K=512` 行。

### 7.6.2 indexer 结构

ratio-4 层同时维护：
- `index_comp_kv`：indexer 压缩行，每行 `DS4_N_INDEXER_HEAD_DIM=128` float
- `index_state_kv/score`：indexer 压缩器状态（与 attn 压缩器并行运行）
- 权重：`indexer_compressor_kv/gate/ape/norm`、`indexer_attn_q_b`、`indexer_proj`

### 7.6.3 allowed 掩码生成

`ds4.c:6941`（`indexer_allowed_decode_one`）：

```c
matvec_any(q, model, layer->indexer_attn_q_b, qr_norm);
rope_tail_layer_inplace(q, n_head, head_dim, DS4_N_ROT, pos, il, false);
dsv4_indexer_qat_rows_inplace_cpu(q, n_head, head_dim);

matvec_any(weights, model, layer->indexer_proj, cur);
const float scale = 1.0f / sqrtf((float)(head_dim * n_head));

for (uint32_t c = 0; c < n_comp; c++) {
    float s = 0.0f;
    for (uint32_t h = 0; h < n_head; h++) {
        float dot = dot_f32(kv, qh, head_dim);
        if (dot < 0.0f) dot = 0.0f;          // ReLU 截断负相似度
        s += dot * weights[h];
    }
    scores[c] = s;
}
/* top_k 选择，写入 allowed[] */
```

算法：
1. 用 `qr_norm`（Q 低秩投影的中间向量）投影得到 indexer query，RoPE + QAT 量化
2. 用当前 token 的 embedding 投影得到 `DS4_N_INDEXER_HEAD=64` 个头权重
3. 对每个压缩行计算加权多头点积，负值截断（ReLU）
4. top-k 选出 512 个最高分行，设 `allowed[c]=true`

decode scratch 版本（`ds4.c:7005`）从预分配缓冲区借用 `allowed`、`q`、`weights`、`scores`，以避免 malloc。

---

## 7.7 non-RoPE 部分的 E4M3 风格存储

### 7.7.1 背景

KV 向量每行 512 维，其中尾部 `DS4_N_ROT=64` 维为 RoPE 部分，前 `512-64=448` 维为 non-RoPE 部分（nope）。nope 部分在存入压缩行前通过 E4M3FN 风格的量化舍入——模拟 Metal/CUDA backend 中 FP8 精度。

`ds4.c:1632`（`dsv4_fp8_kv_quantize_row_inplace_cpu`）：

```c
static void dsv4_fp8_kv_quantize_row_inplace_cpu(float *x,
        uint32_t head_dim, uint32_t n_rot) {
    const uint32_t n_nope = head_dim - n_rot;  // 448
    for (uint32_t off = 0; off < n_nope; off += 64) {
        float amax = 0.0f;
        for (uint32_t i = 0; i < 64; i++) {
            const float av = fabsf(x[off + i]);
            if (av > amax) amax = av;
        }
        if (amax < 1.0e-4f) amax = 1.0e-4f;
        const float scale = ldexpf(1.0f, (int)ceilf(log2f(amax / 448.0f)));
        for (uint32_t i = 0; i < 64; i++) {
            float v = x[off + i] / scale;
            v = fmaxf(-448.0f, fminf(448.0f, v));
            x[off + i] = dsv4_e4m3fn_dequant_cpu(v) * scale;
        }
    }
}
```

每 64 维为一个块，找到绝对最大值后选择 2 的幂次 scale（对齐 E4M3FN 的 exponent），然后量化再反量化，实现精度截断。这保证 CPU 路径的 KV 值与 Metal/CUDA 生成的 FP8 值在精度上一致，两者产生相同的注意力分数。

RoPE 部分（尾部 64 维）不做此截断，因为它们会在每次解码时被当前 token 的 RoPE 角度覆写。

---

## 7.8 KV 缓存内存估算

### 7.8.1 公开 API

`ds4.h:104` / `ds4.c:14002`（`ds4_context_memory_estimate`）返回 `ds4_context_memory`：

```c
typedef struct {
    uint64_t total_bytes;
    uint64_t raw_bytes;
    uint64_t compressed_bytes;
    uint64_t scratch_bytes;
    uint32_t prefill_cap;
    uint32_t raw_cap;
    uint32_t comp_cap;
} ds4_context_memory;
```

### 7.8.2 CPU backend 估算逻辑（`ds4.c:14041`）

```c
m.raw_cap = ds4_default_raw_cap(ctx);   // = min(128, ctx)
m.raw_bytes = DS4_N_LAYER * m.raw_cap * DS4_N_HEAD_DIM * sizeof(float);
//          = 43 × 128 × 512 × 4 = ~11 MB（ctx≥128 时）

for (uint32_t il ...) {
    const uint32_t comp_cap = ctx / ratio + 2;
    m.compressed_bytes += comp_cap * DS4_N_HEAD_DIM * sizeof(float);
    if (ratio == 4)
        m.compressed_bytes += comp_cap * DS4_N_INDEXER_HEAD_DIM * sizeof(float);
}
```

以 ctx=4096 为例：
- 所有层 raw：43 × 128 × 512 × 4 B ≈ 11 MB
- ratio=4 层（层 2,4,...42，共 21 层）：comp_cap=1026，每层 attn=(1026×512×4)+(1026×128×4) B ≈ 2.6 MB
- ratio=128 层（层 3,5,...41，共 21 层）：comp_cap=34，每层 attn=34×512×4 B ≈ 70 KB
- 总压缩：~56 MB

### 7.8.3 Metal backend 的 raw_cap 选择

`ds4.c:13944`（`metal_graph_raw_cap_for_context`）：

```c
uint64_t wanted = (uint64_t)DS4_N_SWA + prefill_cap;
wanted = align_up(wanted, 256u);
if (wanted > 8192u) wanted = 8192u;
```

Metal prefill 时 raw 缓存需容纳上一 SWA 窗口（128）加上当前 ubatch（最大 2048），结果向上对齐到 256 行倍数，上限 8192。对齐是为了让 FlashAttention 的块分组与 CPU 参考路径的行序保持一致。

---

## 7.9 KV 缓存数据流总览

<svg viewBox="0 0 760 500" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Decode path data flow: token to KV cache update">
  <defs>
    <marker id="ar72" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="ar72b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#0d9488"/>
    </marker>
    <marker id="ar72c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/>
    </marker>
  </defs>
  <text x="380" y="22" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">每个 token 到来时（decode 路径）</text>
  <rect x="290" y="32" width="180" height="32" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="52" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">attn_norm(token)</text>
  <line x1="380" y1="64" x2="380" y2="84" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <line x1="380" y1="84" x2="180" y2="84" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="380" y1="84" x2="580" y2="84" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="180" y1="84" x2="180" y2="104" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <line x1="580" y1="84" x2="580" y2="104" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <rect x="90" y="104" width="180" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="180" y="124" font-size="11" font-weight="600" fill="#ea580c" text-anchor="middle">kv_projection → kv (512维)</text>
  <rect x="490" y="104" width="180" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="580" y="118" font-size="11" font-weight="600" fill="#7c3aed" text-anchor="middle">compressor_decode_one</text>
  <text x="580" y="130" font-size="10" fill="#64748b" text-anchor="middle">(wkv, wgate, ape, norm, x)</text>
  <line x1="180" y1="136" x2="180" y2="158" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="120" y1="158" x2="250" y2="158" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="120" y1="158" x2="120" y2="176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <line x1="180" y1="158" x2="180" y2="176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <line x1="250" y1="158" x2="250" y2="176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <rect x="50" y="176" width="140" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="120" y="194" font-size="10" fill="#64748b" text-anchor="middle">RoPE(kv 尾部 64 维)</text>
  <rect x="140" y="176" width="100" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="190" y="194" font-size="10" fill="#64748b" text-anchor="middle">FP8 nope 量化</text>
  <line x1="250" y1="204" x2="250" y2="224" stroke="#ea580c" stroke-width="1.2" marker-end="url(#ar72c)"/>
  <rect x="160" y="224" width="180" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="250" y="238" font-size="11" font-weight="600" fill="#ea580c" text-anchor="middle">kv_cache_push_raw</text>
  <text x="250" y="250" font-size="10" fill="#64748b" text-anchor="middle">→ raw_kv[n_raw]（滑动）</text>
  <line x1="580" y1="136" x2="580" y2="158" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="520" y1="158" x2="640" y2="158" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="520" y1="158" x2="520" y2="176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <line x1="580" y1="158" x2="580" y2="176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <line x1="640" y1="158" x2="640" y2="176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <rect x="458" y="176" width="128" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="522" y="194" font-size="10" fill="#64748b" text-anchor="middle">投影 kv_cur, sc_cur</text>
  <rect x="534" y="176" width="96" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="582" y="194" font-size="10" fill="#64748b" text-anchor="middle">APE 偏置 sc_cur</text>
  <rect x="596" y="176" width="108" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="650" y="194" font-size="10" fill="#64748b" text-anchor="middle">写 state_kv[row]</text>
  <line x1="580" y1="204" x2="580" y2="234" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <text x="580" y="228" font-size="10" fill="#94a3b8" text-anchor="middle">每 ratio token</text>
  <line x1="580" y1="234" x2="580" y2="254" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <rect x="470" y="254" width="220" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="580" y="268" font-size="11" font-weight="600" fill="#7c3aed" text-anchor="middle">compressor_pool_decode_state</text>
  <text x="580" y="280" font-size="10" fill="#64748b" text-anchor="middle">窗口满，触发池化</text>
  <line x1="580" y1="286" x2="580" y2="308" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="520" y1="308" x2="640" y2="308" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="520" y1="308" x2="520" y2="326" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <line x1="580" y1="308" x2="580" y2="326" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <line x1="640" y1="308" x2="640" y2="326" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <rect x="456" y="326" width="130" height="24" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="521" y="342" font-size="10" fill="#64748b" text-anchor="middle">per-dim softmax 池化</text>
  <rect x="552" y="326" width="80" height="24" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="592" y="342" font-size="10" fill="#64748b" text-anchor="middle">RMSNorm · RoPE</text>
  <rect x="604" y="326" width="80" height="24" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="644" y="342" font-size="10" fill="#64748b" text-anchor="middle">FP8 量化</text>
  <line x1="580" y1="350" x2="580" y2="372" stroke="#7c3aed" stroke-width="1.2" marker-end="url(#ar72)"/>
  <rect x="470" y="372" width="220" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="580" y="386" font-size="11" font-weight="600" fill="#7c3aed" text-anchor="middle">kv_cache_push_comp</text>
  <text x="580" y="398" font-size="10" fill="#64748b" text-anchor="middle">→ attn_comp_kv[n_comp]</text>
  <rect x="460" y="440" width="240" height="48" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" stroke-dasharray="5,3"/>
  <text x="580" y="458" font-size="11" font-weight="600" fill="#0d9488" text-anchor="middle">ratio=4 层并行运行</text>
  <text x="580" y="472" font-size="10" fill="#64748b" text-anchor="middle">indexer 压缩器 → index_comp_kv[n_index_comp]</text>
  <line x1="580" y1="404" x2="580" y2="440" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="4,3" marker-end="url(#ar72b)"/>
</svg>
<span class="figure-caption">图 R7.2 ｜ decode 路径数据流：每个 token 分两路写入 raw 滑动窗口与流式压缩器</span>

<details>
<summary>ASCII 原版</summary>

```
每个 token 到来时（decode 路径）：

attn_norm(token)
    │
    ├──► kv_projection ──► kv (512维)
    │        │
    │        ├──► RoPE(kv尾部64维)
    │        ├──► FP8 nope 量化
    │        └──► kv_cache_push_raw ──► raw_kv[n_raw] (滑动)
    │
    └──► compressor_decode_one(wkv, wgate, ape, norm, x)
             │
             ├── 投影 kv_cur, sc_cur (width维)
             ├── APE 偏置 sc_cur
             ├── 写 state_kv[row], state_score[row]
             │
             └── (每 ratio token) ──► compressor_pool_decode_state
                                          │
                                          ├── per-dim softmax 池化
                                          ├── RMSNorm
                                          ├── RoPE
                                          ├── FP8 量化
                                          └── kv_cache_push_comp ──► attn_comp_kv[n_comp]

                 ratio=4 层还并行运行 indexer 压缩器 ──► index_comp_kv[n_index_comp]
```

</details>

注意 raw 区和压缩区的更新是解耦的：raw 每个 token 更新一次，压缩区每 ratio 个 token 输出一行。注意力计算时同时使用两者（见 [第 8 章](08-attention.md)）。

---

## 7.10 编码规范细节

- **F16 截断**：raw_kv 写入时全部经过 `f32_to_f16` + `f32_to_f16`（`ds4.c:6393`），对齐硬件精度
- **DS4_NEG_INF**：用于初始化 state_score 的"空槽"标记，确保空槽在 softmax 中权重趋于零
- **attn_state_score 初始化**（`ds4.c:6357`）：分配时显式将所有 state_score 置 `DS4_NEG_INF`，而非零，避免未初始化行被错误地赋予非零权重

---

## 本章小结

| 组件 | 主函数 | 每层行数 | 刷新频率 |
|------|--------|----------|----------|
| raw SWA | `kv_cache_push_raw` | `raw_cap`（128） | 每 token |
| attn 压缩行 | `compressor_decode_one` | `ctx/ratio+2` | 每 ratio token |
| indexer 压缩行 | ratio-4 层 | 同 attn | 每 ratio token |
| state 缓冲 | `compressor_finish_prefill_state_cpu` | `2×ratio` 行 | prefill 结束清理 |

理解这两层缓存的交互是读懂注意力子层（[第 8 章](08-attention.md)）和整体内存预算的基础。
