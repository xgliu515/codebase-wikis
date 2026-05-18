# 第 2 章：DeepSeek V4 Flash 模型结构

> 代码版本：antirez/ds4@c9dd949（2026-05-18）
>
> 本章是"理论"章，讲清楚模型本身的特殊之处，以及这些特殊之处如何体现在 ds4 代码的常量和数据结构中。实现细节（Metal kernel、量化格式、KV 序列化）分别在 [第 8 章](08-attention.md)、[第 4 章](04-quantization.md)、[第 6 章](06-engine-session.md) 展开。

---

## 目录

1. [整体规格](#1-整体规格)
2. [超连接（Hyper-Connections）](#2-超连接hyper-connections)
3. [压缩 KV 缓存](#3-压缩-kv-缓存)
4. [注意力机制](#4-注意力机制)
5. [MoE 专家路由](#5-moe-专家路由)
6. [量化策略](#6-量化策略)
7. [MTP 多 token 预测](#7-mtp-多-token-预测)
8. [Thinking 模式](#8-thinking-模式)

---

## 1 整体规格

### 1.1 固定形状常量

`ds4.c:86-109` 定义了该引擎能接受的**唯一**模型形状：

```c
enum {
    DS4_N_LAYER            = 43,     // transformer 层数
    DS4_N_EMBD             = 4096,   // 嵌入维度
    DS4_N_VOCAB            = 129280, // 词汇表大小
    DS4_N_HEAD             = 64,     // Q 头数
    DS4_N_HEAD_KV          = 1,      // KV 头数（单头宽 KV）
    DS4_N_HEAD_DIM         = 512,    // 每个 KV head 的宽度
    DS4_N_ROT              = 64,     // RoPE 旋转维度数
    DS4_N_LORA_Q           = 1024,   // Q 低秩投影中间维度
    DS4_N_EXPERT           = 256,    // 路由专家总数
    DS4_N_EXPERT_USED      = 6,      // 每 token 激活的专家数
    DS4_N_EXPERT_SHARED    = 1,      // 共享专家数
    DS4_N_FF_EXP           = 2048,   // 专家 FFN 隐层宽度
    DS4_N_HASH_LAYER       = 3,      // 前 N 层用哈希路由
    DS4_N_SWA              = 128,    // 滑动窗口原始 KV 行数
    DS4_N_HC               = 4,      // 超连接流数
    DS4_N_HC_SINKHORN_ITER = 20,     // Sinkhorn 迭代次数
};
```

这些常量是整个代码库的"宪法"。元数据校验函数（`ds4.c:2558-2617`）在加载 GGUF 时逐一断言，任何不符合预期的值都会使进程以非零状态退出。

### 1.2 三大数字

| 参数 | 值 | 说明 |
|---|---|---|
| 层数 | 43 | `DS4_N_LAYER`，`ds4.c:87` |
| 总参数 | ~284B | MoE 架构，活跃参数远少于总量 |
| 上下文窗口 | 1M tokens | 需配合足够的 KV cache（见 `README.md:29`）|

1M token 上下文在 2bit 量化下的 KV 内存：README 估算约 26GB（其中压缩索引器约 22GB）。128GB 机器建议将上下文设在 100~300k 以保留余量。

---

## 2 超连接（Hyper-Connections）

### 2.1 概念

标准 Transformer 每个 token 只维护一条残差流（一个 `[n_embd]` 向量）。DS4 Flash 引入了**超连接（Hyper-Connections, HC）**，每个 token 同时维护 **4 条独立流**（`DS4_N_HC = 4`，`ds4.c:107`），层间残差更新通过学习到的混合矩阵而非简单加法来组合这四条流。

这是 DeepSeek 原创的架构特性，设计目标是增强层间信息路由的灵活性，类似于多头注意力给予注意力模块多条独立通路。

### 2.2 每层两步：pre 与 post

HC 在每个子层（注意力 + FFN）前后各执行一步：

<svg viewBox="0 0 640 500" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="HC pre and post steps around a sublayer: 4 HC streams flow through pre-projection, sublayer, and post-injection">
  <defs>
    <marker id="ar2-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="160" y="10" width="320" height="68" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="33" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">残差 HC 状态</text>
  <text x="320" y="53" text-anchor="middle" font-size="11" fill="#64748b">4 条流 × 4096 维</text>
  <text x="320" y="70" text-anchor="middle" font-size="10" fill="#94a3b8">stream_0 … stream_3</text>
  <line x1="320" y1="78" x2="320" y2="108" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2-1)"/>
  <rect x="120" y="108" width="400" height="72" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="130" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">HC pre — hc_pre_from_state_one_scratch()</text>
  <text x="320" y="150" text-anchor="middle" font-size="11" fill="#64748b">flatten → RMSNorm → matvec_f16 → Sinkhorn split</text>
  <text x="320" y="168" text-anchor="middle" font-size="10" fill="#94a3b8">ds4.c:4354</text>
  <line x1="230" y1="180" x2="160" y2="220" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2-1)"/>
  <line x1="320" y1="180" x2="320" y2="220" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2-1)"/>
  <line x1="410" y1="180" x2="480" y2="220" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2-1)"/>
  <rect x="60" y="220" width="160" height="52" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="140" y="242" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">out (4096)</text>
  <text x="140" y="260" text-anchor="middle" font-size="10" fill="#64748b">子层普通输入</text>
  <rect x="240" y="220" width="160" height="52" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="242" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">post[4]</text>
  <text x="320" y="260" text-anchor="middle" font-size="10" fill="#64748b">后置门控权重</text>
  <rect x="420" y="220" width="160" height="52" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="500" y="242" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">comb[4×4]</text>
  <text x="500" y="260" text-anchor="middle" font-size="10" fill="#64748b">HC 流混合矩阵</text>
  <line x1="140" y1="272" x2="140" y2="298" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2-1)"/>
  <rect x="60" y="298" width="400" height="52" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="260" y="320" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">attention / FFN 子层</text>
  <text x="260" y="340" text-anchor="middle" font-size="11" fill="#64748b">block_out (4096)</text>
  <line x1="260" y1="350" x2="260" y2="378" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2-1)"/>
  <line x1="500" y1="272" x2="500" y2="398" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <line x1="320" y1="272" x2="320" y2="398" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <rect x="80" y="378" width="480" height="72" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="400" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">HC post — hc_post_one()</text>
  <text x="320" y="418" text-anchor="middle" font-size="11" fill="#64748b">block_out × post[dst] + Σ comb[dst,src] × residual_hc[src]</text>
  <text x="320" y="436" text-anchor="middle" font-size="10" fill="#94a3b8">ds4.c:4436</text>
  <line x1="320" y1="450" x2="320" y2="478" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2-1)"/>
  <rect x="160" y="478" width="320" height="16" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="491" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">新的残差 HC 状态 (4 × 4096)</text>
</svg>
<span class="figure-caption">图 R2.1 ｜ 超连接 pre/post 两步：HC 状态经投影为子层输入，子层输出经 combine 矩阵注入回 4 条流</span>

<details>
<summary>ASCII 原版</summary>

```
残差 HC 状态 (4 × 4096)
      │
      ▼  hc_pre_from_state_one_scratch()  (ds4.c:4354)
  [flatten → RMSNorm → matvec_f16 → Sinkhorn split]
      │
      ├── out (4096)  ← 子层的普通输入
      ├── post[4]     ← 每条 HC 流的后置门控权重
      └── comb[4×4]   ← HC 流之间的混合矩阵
      │
      ▼  attention / FFN 子层
      │
      ▼  hc_post_one()  (ds4.c:4436)
  [block_out × post[dst] + Σ comb[dst,src] × residual_hc[src]]
      │
      ▼ 新的残差 HC 状态 (4 × 4096)
```

</details>

**pre 步骤**（`ds4.c:4354-4387`）：

1. 将 4 条 HC 流拼接成 `[4 × 4096]` 张量，做 RMSNorm；
2. 通过 `hc_attn_fn`（F16 矩阵）投影得到混合控制向量 `mix[24]`；
3. 调用 `hc_split_sinkhorn_one()`（`ds4.c:4258-4335`）解码出 pre 权重、post 门控和双归一化 combine 矩阵（20 次 Sinkhorn 迭代确保行列归一化）；
4. 对 4 条流做加权和，得到子层输入 `out[4096]`。

**post 步骤**（`ds4.c:4436-4458`）：

```c
for (uint32_t dst = 0; dst < n_hc; dst++) {
    for (uint32_t d = 0; d < n_embd; d++) {
        float acc = block_out[d] * post[dst];
        for (uint32_t src = 0; src < n_hc; src++)
            acc += comb[dst + src * n_hc] * residual_hc[src * n_embd + d];
        out_hc[dst * n_embd + d] = acc;
    }
}
```

每条目标 HC 流的新值 = 子层输出 × 该流的 post 门控 + 各源流经 combine 矩阵加权之和。

### 2.3 初始化与输出

- **初始化**（`ds4.c:4429-4434`）：嵌入层输出时，将同一个 token 向量复制到全部 4 条 HC 流（所有流起点相同，层间逐渐分化）。
- **输出**（`ds4.c:8006-8033`）：输出 HC head 用 sigmoid 门控对 4 条流做加权平均，再接 RMSNorm 和 vocab 投影。

### 2.4 为什么要 Sinkhorn

Sinkhorn 算法（20 次行列交替归一化）把 4×4 的 combine 矩阵约束为双随机矩阵（行和与列和均为 1），使不同 HC 流的信息流量守恒，防止某条流的梯度在训练中主导其余流。这是 HC 设计能稳定训练的关键。

每层的 HC 参数张量：

| 张量字段 | 含义 |
|---|---|
| `hc_attn_fn` / `hc_ffn_fn` | 注意力 / FFN 前的 HC 控制投影（F16）|
| `hc_attn_scale` / `hc_ffn_scale` | 控制投影的三个缩放因子（pre/post/comb）|
| `hc_attn_base` / `hc_ffn_base` | 控制投影的偏置向量 |

层权重结构见 `ds4.c:2059-2095`（`ds4_layer_weights`）。

---

## 3 压缩 KV 缓存

### 3.1 双轨道设计

DS4 Flash 对注意力 KV 采用双轨道设计，以支持 1M token 上下文：

<svg viewBox="0 0 640 260" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Per-layer KV cache dual-track: raw sliding window on top, compressed KV below">
  <defs>
    <marker id="ar2-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="320" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">每一层的 KV 存储</text>
  <rect x="40" y="36" width="560" height="90" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="60" y="60" font-size="13" font-weight="600" fill="currentColor">原始滑动窗口（Raw SWA）</text>
  <text x="60" y="82" font-size="11" fill="#64748b">容量：DS4_N_SWA = 128 行（最近 128 个 token 的精确 KV）</text>
  <text x="60" y="100" font-size="11" fill="#64748b">存储：float16，每行 DS4_N_HEAD_DIM = 512 维</text>
  <text x="60" y="118" font-size="11" fill="#64748b">作用：保留最近 token 的精确 KV，避免压缩误差</text>
  <line x1="320" y1="126" x2="320" y2="150" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4,3"/>
  <rect x="40" y="150" width="560" height="90" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="60" y="174" font-size="13" font-weight="600" fill="currentColor">压缩 KV（Compressed KV）</text>
  <text x="60" y="196" font-size="11" fill="#64748b">容量：ctx_size / compress_ratio + 2</text>
  <text x="60" y="214" font-size="11" fill="#64748b">存储：float16（同 head_dim）</text>
  <text x="60" y="232" font-size="11" fill="#64748b">作用：以有损方式存储远距离历史 KV</text>
</svg>
<span class="figure-caption">图 R2.2 ｜ 每层 KV 存储双轨道：精确滑动窗口（128 行）+ 有损压缩 KV（覆盖远距离历史）</span>

<details>
<summary>ASCII 原版</summary>

```
每一层的 KV 存储
┌────────────────────────────────────────────────────┐
│ 原始滑动窗口（Raw SWA）                              │
│   容量: DS4_N_SWA = 128 行（近 128 个 token 的精确 KV）│
│   存储: float16（每行 DS4_N_HEAD_DIM = 512 维）       │
│   作用: 保留最近 token 的精确 KV，避免压缩误差        │
└────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────┐
│ 压缩 KV（Compressed KV）                            │
│   容量: ctx_size / compress_ratio + 2              │
│   存储: float16（同 head_dim）                       │
│   作用: 以有损方式存储远距离历史 KV                   │
└────────────────────────────────────────────────────┘
```

</details>

KV cache 按层分配（`ds4.c:6331-6373`），每层独立初始化。

### 3.2 层的压缩比

`ds4.c:411-415` 定义了每层的压缩模式：

```c
static uint32_t ds4_layer_compress_ratio(uint32_t il) {
    if (il < 2) return 0;          // 第 0、1 层：不压缩（dense 层）
    return (il & 1u) == 0 ? 4u : 128u;  // 偶数层 ratio-4，奇数层 ratio-128
}
```

规律：
- 第 0、1 层（dense 层）：**不启用压缩 KV**，只有原始滑动窗口；
- 偶数层（2, 4, 6, ...）：**ratio-4**，每 4 个原始 KV 行被软聚合为 1 个压缩行，并附带 indexer（见下）；
- 奇数层（3, 5, 7, ...）：**ratio-128**，每 128 个原始 KV 行聚合为 1 行，压缩率更高，无 indexer。

### 3.3 Ratio-4 层的 Indexer

ratio-4 层（偶数层 ≥ 2）在压缩 KV 之外还维护一个**索引器（indexer）**压缩序列（`ds4.c:6362-6370`），用于在 decode 时快速筛选哪些压缩行值得参与注意力：

```c
if (ratio == 4) {
    cache->layer[il].index_comp_kv = xmalloc_zeroed(
        comp_cap * DS4_N_INDEXER_HEAD_DIM, sizeof(float));
    // ...index_state_kv, index_state_score
}
```

索引器使用 64 个头、每头 128 维（`DS4_N_INDEXER_HEAD = 64`，`DS4_N_INDEXER_HEAD_DIM = 128`），通过 top-512 筛选（`DS4_N_INDEXER_TOP_K = 512`，`ds4.c:105`）确定哪些压缩 KV 行对当前 query 有意义。设计意图：ratio-4 层的压缩行更多（精细度更高），需要 indexer 来剪枝；ratio-128 层每 128 token 只产生 1 行，总量本就少，不需要 indexer。

### 3.4 E4M3 风格量化

`ds4.c:1632-1634` 的注释解释了 non-RoPE 部分的存储方式：

> DeepSeek V4 stores the non-RoPE part of compressed KV through an E4M3-style round trip.  Keeping this in the CPU reference makes cache values comparable to the Metal graph's compressed-cache behavior.

每个 KV 向量由两部分组成：
- **non-RoPE 部分**（前 `head_dim - n_rot = 512 - 64 = 448` 维）：通过 E4M3FN 量化往返（每 64 个值分一组，组内最大值为缩放基准），存储精度约等于 8 位浮点；
- **RoPE 部分**（后 64 维）：保持 float16 精度，因为 RoPE 旋转会使细节更敏感。

CPU 参考实现见 `ds4.c:1635-1653`（`dsv4_fp8_kv_quantize_row_inplace_cpu`）。

---

## 4 注意力机制

### 4.1 低秩 Q 投影

标准多头注意力从嵌入维度直接投影到 `n_head × head_dim`。DS4 Flash 的 Q 投影采用**低秩分解**（`ds4.c:4666-4684`）：

```c
/* Q projection is low-rank: Q8_0 into a 1024 vector, RMSNorm, then Q8_0
 * back to 64 heads of width 512. */
matvec_q8_0(qr, model, layer->attn_q_a, norm);       // 4096 → 1024
rms_norm_weight(qr_norm, qr, q_a_norm, 1024, ...);    // 1024 维 RMSNorm
matvec_q8_0(q, model, layer->attn_q_b, qr_norm);      // 1024 → 64×512
head_rms_norm_inplace(q, DS4_N_HEAD, DS4_N_HEAD_DIM, ...); // 每头 RMSNorm
```

形状路径：`4096 → (Q8_0) → 1024 → RMSNorm → (Q8_0) → 64×512`。中间的 1024 维向量也被复用于输出 LoRA 投影（`layer->attn_output_a`）。

### 4.2 单宽 KV 头

KV 投影是**单头宽 512**（`DS4_N_HEAD_KV = 1`，`DS4_N_HEAD_DIM = 512`，`ds4.c:4704-4718`）：

```c
/* KV projection has one KV head of width 512, followed by a learned RMSNorm. */
matvec_q8_0(raw, model, layer->attn_kv, normed);  // 4096 → 512
rms_norm_weight(kv, raw, kv_norm, 512, ...);
```

单 KV 头意味着 64 个 Q 头全都关注同一组 K/V——这是 MQA（Multi-Query Attention）的极端形式。优点是 KV cache 大小仅与头宽成比例而非头数，极大降低内存占用；代价是每个 Q 头必须从宽达 512 的共享 KV 中自行提取不同的信息，这也是 head_dim 选用 512 而非 128 的原因之一。

### 4.3 仅对尾部做 RoPE

DS4 Flash 不对整个 head 向量做 RoPE，而只旋转**每个 head 的最后 64 维**（`DS4_N_ROT = 64`）（`ds4.c:4763-4768`）：

```c
/* Apply DS4 RoPE only to the tail of each head.  Compressed layers use the
 * long-context frequency base and scale; inverse mode rotates attention output
 * back before the grouped output projection. */
```

前 `512 - 64 = 448` 维不受位置编码干扰，可以更自由地表达内容信息；后 64 维携带位置信息。将这两部分合并进同一宽 head 是 DS4 Flash 实现 MLA（Multi-head Latent Attention）的关键——KV 向量的 non-RoPE 部分可以被压缩存储，而 RoPE 部分必须在 decode 时按当前位置重新计算。

### 4.4 Dense 层与 Compressed 层用不同 RoPE base

`ds4.c:4816-4828` 实现这一区分：

```c
static float layer_rope_freq_base(uint32_t il) {
    return ds4_layer_compress_ratio(il) != 0 && DS4_COMPRESS_ROPE_FREQ_BASE > 0.0f
        ? DS4_COMPRESS_ROPE_FREQ_BASE   // 160000.0f（ds4.c:60）
        : DS4_ROPE_FREQ_BASE;           // 10000.0f（ds4.c:56）
}
```

Dense 层（第 0、1 层）使用标准 base 10000；compressed 层（第 2 层起）使用 160000，并启用 YaRN 频率缩放（`DS4_ROPE_SCALE_FACTOR = 16.0f`，`ds4.c:57`）以支持 1M token 的超长上下文。较高的 base 使高频维度的旋转周期更长，减少在极长序列中的位置混叠。

### 4.5 sink logit 注意力

DS4 Flash 的注意力分母中包含一个**学习到的 sink logit**（`ds4.c:4967-5006`）：

```c
/* Sink-aware attention over a set of KV rows.  The learned sink logit is
 * part of the softmax denominator but contributes no value vector. */
float max_score = sinks[h];   // per-head 学习参数
// ...
float denom = expf(sinks[h] - max_score);  // sink 贡献分母但无 value
for (uint32_t r = 0; r < n_kv; r++) {
    const float weight = expf(score[r] - max_score);
    denom += weight;
    axpy_f32(oh, kv, weight, DS4_N_HEAD_DIM);
}
```

sink logit 相当于一个"黑洞"token——当所有 KV 行的相关性都很低时，注意力权重会流向 sink 而非强行分配给不相关的 KV 行，避免注意力分布过于平坦导致输出被噪声污染。每个 Q 头有独立的 sink logit（`attn_sinks` 张量，形状 `[DS4_N_HEAD]`）。

### 4.6 分组输出投影（LoRA）

64 个 Q 头的注意力输出经过**分组 LoRA 投影**回到嵌入维度（`ds4.c:5018-5036`）：

```c
/* Attention output projection is grouped: each group first maps its heads
 * to a 1024-rank low vector, then all groups are projected back to 4096. */
const uint32_t n_groups = 8;
const uint32_t group_heads = DS4_N_HEAD / n_groups;  // = 8 heads/group
const uint32_t rank = 1024;
// attn_output_a: 8组 × (8头×512) → 1024
// attn_output_b: 8×1024 → 4096
```

8 组各自先将 `8×512 = 4096` 维压缩为 1024，再从 `8×1024 = 8192` 投影到 4096。两段都是 Q8_0 量化。

---

## 5 MoE 专家路由

### 5.1 架构概览

每层的 FFN 部分包含两个组件：

<svg viewBox="0 0 640 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="MoE FFN layer: shared expert and routed MoE run in parallel, outputs summed back to residual">
  <defs>
    <marker id="ar2-3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="220" y="10" width="200" height="44" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="30" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">嵌入向量 x (4096)</text>
  <text x="320" y="47" text-anchor="middle" font-size="10" fill="#64748b">来自 HC pre 输出</text>
  <line x1="220" y1="54" x2="130" y2="108" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2-3)"/>
  <line x1="420" y1="54" x2="510" y2="108" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2-3)"/>
  <rect x="40" y="108" width="200" height="72" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="140" y="132" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">共享专家</text>
  <text x="140" y="150" text-anchor="middle" font-size="10" fill="#64748b">Q8_0 SwiGLU MLP</text>
  <text x="140" y="168" text-anchor="middle" font-size="10" fill="#64748b">每 token 必跑</text>
  <rect x="400" y="108" width="200" height="72" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="500" y="132" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">路由专家（MoE）</text>
  <text x="500" y="150" text-anchor="middle" font-size="10" fill="#64748b">256 选 6</text>
  <text x="500" y="168" text-anchor="middle" font-size="10" fill="#64748b">IQ2_XXS gate/up · Q2_K down</text>
  <line x1="140" y1="180" x2="260" y2="228" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2-3)"/>
  <line x1="500" y1="180" x2="380" y2="228" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2-3)"/>
  <rect x="220" y="228" width="200" height="44" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="248" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">shared + moe → 相加</text>
  <text x="320" y="265" text-anchor="middle" font-size="10" fill="#64748b">输出回残差流 (4096)</text>
</svg>
<span class="figure-caption">图 R2.3 ｜ MoE FFN 子层：共享专家（必跑）与路由专家（256 选 6）并行执行后输出相加</span>

<details>
<summary>ASCII 原版</summary>

```
嵌入向量 x (4096)
   │
   ├──► 共享专家（Shared Expert）：Q8_0 SwiGLU MLP，每 token 必跑
   │
   └──► 路由专家（Routed MoE）：256 选 6，IQ2_XXS/Q2_K 量化
         │
         └──► 两者输出相加回到残差流
```

</details>

### 5.2 哈希路由（前 3 层）

前 `DS4_N_HASH_LAYER = 3` 层（层号 0、1、2）使用**token-id 哈希路由**（`ds4.c:5230-5247`）：

```c
/* Early DS4 layers use token-id hash routing instead of top-k routing. */
static void layer_hash_selected_experts(
        int selected[DS4_N_EXPERT_USED], ..., int token) {
    // ffn_gate_tid2eid 是一张 [N_EXPERT_USED × vocab_size] 的查找表
    const int32_t *row = table + (uint64_t)token * DS4_N_EXPERT_USED;
    for (int i = 0; i < DS4_N_EXPERT_USED; i++) selected[i] = row[i];
}
```

哈希路由的核心是一张 `[6 × 129280]` 的整数查找表（`ffn_gate_tid2eid`），根据 token ID 直接确定激活的 6 个专家。这使得前几层（token ID 到专家的映射相对静态）能够利用缓存局部性，也避免了在推理极早期就进行复杂的路由计算。

路由权重仍由 router 概率决定（`layer_hash_router_weights_one`，`ds4.c:5282`），只是**选择（selection）**由哈希表确定而非 top-k。

### 5.3 偏置 top-k 路由（第 3 层起）

从第 `DS4_N_HASH_LAYER = 3` 层起改用**偏置 top-k**（`ds4.c:5308-5355`）：

```c
/* Later layers choose the six experts by biased top-k, but weight them
 * using the unbiased router probabilities. */
if (layer->ffn_exp_probs_b) {
    const float *bias = tensor_data(model, layer->ffn_exp_probs_b);
    for (int i = 0; i < DS4_N_EXPERT; i++) selection[i] += bias[i];
}
topk_desc(selection, DS4_N_EXPERT, DS4_N_EXPERT_USED, selected);
// 用未加偏置的 probs 计算权重
for (int i = 0; i < DS4_N_EXPERT_USED; i++)
    expert_weight[i] = probs[selected[i]];
```

`ffn_exp_probs_b` 是每个专家的学习偏置（DeepSeek 用它来平衡专家负载），加到 router 分数上做 top-k 选择，但**最终权重使用未加偏置的原始 router 概率**——选择和权重解耦，使得负载均衡不影响输出语义。

### 5.4 Router 分数公式

`ds4.c:5250-5262` 揭示了 router 概率的计算公式：

```c
/* Router scores use sqrt(softplus(logit)) */
for (int i = 0; i < DS4_N_EXPERT; i++) {
    probs[i] = sqrtf(softplus_stable(logits[i]));
}
```

`router_score = sqrt(softplus(logit))`。softplus 保证分数非负（与 softmax 不同，不归一化），sqrt 缩小高分专家的权重优势，使多专家合并时更平滑。归一化在选出 6 名专家后做（`ds4.c:5346-5353`），同时乘以 `DS4_EXPERT_WEIGHT_SCALE = 1.5f` 补偿选 6 归一化带来的幅度损失（`ds4.c:54`）。

### 5.5 共享专家

`ds4.c:5107-5140` 实现共享专家：

```c
/* The shared expert is a normal Q8_0 SwiGLU MLP that runs for every token. */
// gate/up/down 均为 Q8_0，隐层宽 DS4_N_FF_EXP = 2048
```

每个 token 必然经过共享专家，不受路由选择影响，提供稳定的底层特征变换。共享专家的 gate/up/down 三个矩阵均为 Q8_0 量化，比路由专家的 IQ2_XXS 精度更高，因为它在所有 token 上累积影响。

---

## 6 量化策略

DS4 Flash 采用**非对称量化混合**策略：

| 组件 | 量化 | 理由 |
|---|---|---|
| 路由专家 gate/up | IQ2_XXS（~2 bit）| 数量多（256 个），但每 token 只激活 6 个；整体推理质量由选择机制保障 |
| 路由专家 down | Q2_K（~2 bit）| 同上 |
| 共享专家 gate/up/down | Q8_0（8 bit）| 每 token 必跑，精度影响直接累积 |
| Q/KV/输出投影 | Q8_0 / F16 | 注意力是质量的敏感路径 |
| 路由器 gate_inp | F16 | 路由决策直接影响专家选择，需要高精度 |
| Token 嵌入 + 词汇投影 | F16 / Q8_0 | 首尾精度影响明显 |

2bit 量化仅针对路由专家，这些专家占模型参数的大多数（256 个 × 2048 × 4096 × 3 矩阵），但其余高精度组件保证了：词汇投影、注意力投影、共享专家、路由器都不受极低精度影响。

`README.md:99` 明确说明："The 2 bit quants use a very asymmetrical quantization: only the routed MoE experts are quantized... They are the majority of all the model space."

量化格式的实现细节（block layout、IQ2_XXS 反量化核）见 [第 4 章](04-quantization.md)。

---

## 7 MTP 多 token 预测

### 7.1 概念

DS4 Flash 模型自带一个**MTP（Multi-Token Prediction）头**，可用于推测解码（speculative decoding）。MTP 模型作为独立 GGUF 文件发布，通过 `--mtp MTP.gguf` 加载：

```sh
./ds4 --mtp ds4flash_mtp.gguf --mtp-draft 2 -p "..."
```

### 7.2 MTP 权重结构

`ds4.c:2107-2117` 定义 MTP 权重结构体：

```c
typedef struct {
    ds4_tensor *e_proj;       // 嵌入投影
    ds4_tensor *h_proj;       // 隐层投影
    ds4_tensor *enorm, *hnorm, *norm;  // 三个 RMSNorm
    ds4_tensor *hc_head_base, *hc_head_fn, *hc_head_scale; // HC 输出头
    ds4_layer_weights block;  // 一个完整的 transformer 层（同主模型）
} ds4_mtp_weights;
```

MTP 头本质上是一个完整的 transformer 层，接收主模型的最后隐层状态并预测接下来的 draft token。加载时会绑定 `mtp.0.*` 前缀的张量（`ds4.c:2713-2748`）。

### 7.3 推测解码流程

MTP 被用作推测解码的 drafter：主模型 decode 一个 token，MTP 头在同一 forward pass 中预测若干 draft token，下一步主模型同时 verify 这些 draft token。当前实现通过置信度门控（`--mtp-margin`，默认 3.0）过滤质量不足的草稿，避免错误接受导致质量下降。

MTP 在 Metal graph 路径中有专用的 GPU 张量组（`ds4.c:8240-8252`）和独立的原始 KV cache（`mtp_raw_cache`）。

推测解码的详细实现见 [第 12 章](12-speculative-mtp.md)。

---

## 8 Thinking 模式

### 8.1 三档模式

`ds4.h:23-27` 定义三种思维模式：

```c
typedef enum {
    DS4_THINK_NONE,   // --nothink：直接回答，不产生 <think> 段落
    DS4_THINK_HIGH,   // --think：标准思维模式（默认）
    DS4_THINK_MAX,    // --think-max：最大努力推理
} ds4_think_mode;
```

服务器和 CLI 默认使用 `DS4_THINK_HIGH`。

### 8.2 Think Max 的上下文要求

`ds4.c:68-71` 写明：

```c
/* DeepSeek recommends Think Max only with at least a 384K-token context window.
 * Below that size we keep ordinary thinking to avoid injecting a prompt that
 * asks for a reasoning budget the allocated context is not meant to hold. */
#define DS4_THINK_MAX_MIN_CONTEXT 393216u  // 384K tokens
```

`ds4.h:103` 暴露查询函数 `ds4_think_mode_for_context()`，使 CLI/server 能在创建会话时自动降级：如果 `--ctx < 384K` 则 Think Max 自动回退为 Think High。这防止了模型在小窗口中生成无法容纳的超长思维链。

### 8.3 Think Max 提示词

`ds4.c:63-66` 定义了 Think Max 模式在 prompt 中注入的前缀文本（`DS4_REASONING_EFFORT_MAX_PREFIX`）——一段引导模型进行极度彻底推理的指令。该文本通过 `ds4_chat_append_max_effort_prefix()`（`ds4.h:142`）追加到 prompt 开头，对模型本身的权重没有任何影响，纯粹是 prompt engineering。

### 8.4 采样行为

在 thinking 模式下，服务器使用固定采样参数（`temperature=1, min_p=0.05`）并忽略客户端的 `temperature` / `top_p` 等设置，与 DeepSeek 官方 API 行为保持一致（`README.md:334-337`）。在 `DS4_THINK_NONE` 模式下客户端采样参数生效。

---

## 附录：模型层权重字段一览

`ds4_layer_weights`（`ds4.c:2059-2095`）中每个字段对应的模型组件：

```text
HC 相关:
  hc_attn_fn/scale/base   — 注意力前 HC 控制投影
  hc_ffn_fn/scale/base    — FFN 前 HC 控制投影

注意力:
  attn_norm               — 注意力前 RMSNorm
  attn_q_a/q_a_norm/q_b  — Q 低秩投影（两段 + 中间 norm）
  attn_kv/kv_a_norm       — KV 投影 + norm
  attn_sinks              — per-head sink logit
  attn_output_a/b         — 分组 LoRA 输出投影

压缩器（compressed 层）:
  attn_compressor_ape/kv/gate/norm    — 注意力 KV 压缩器
  indexer_attn_q_b/proj/...           — ratio-4 层的 indexer

FFN:
  ffn_norm                — FFN 前 RMSNorm
  ffn_gate_tid2eid        — 哈希路由表（前 3 层有）
  ffn_gate_inp            — router 门控投影（F16）
  ffn_exp_probs_b         — 专家偏置（用于 top-k 选择）
  ffn_gate/up/down_exps   — IQ2_XXS/Q2_K 路由专家矩阵
  ffn_gate/up/down_shexp  — Q8_0 共享专家矩阵
```

---

**相关章节**：[第 1 章：架构总览](01-architecture-overview.md) | [第 4 章：量化格式](04-quantization.md) | [第 8 章：注意力子层](08-attention.md) | [第 12 章：推测解码 MTP](12-speculative-mtp.md) | [导览总览](tour-00-overview.md)
