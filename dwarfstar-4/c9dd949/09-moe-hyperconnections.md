# 第 9 章：超连接与 MoE 前向计算

本章讲述 DwarfStar 4 的两个核心结构创新：超连接（Hyper-Connections，HC）替代传统残差流，以及混合专家（MoE）FFN 子层。量化格式（IQ2_XXS、Q2_K、Q8_0）参见 [第 4 章](04-quantization.md)；KV 缓存见 [第 7 章](07-kv-cache.md)；注意力 HC 调用见 [第 8 章](08-attention.md)。

---

## 9.1 超连接概念

### 9.1.1 传统残差流的局限

标准 transformer 的残差连接是标量加法：`x ← x + sublayer(x)`，整个网络共享单一的 embedding 流。这要求每个子层既要提取特征，又不能破坏已有信息——两个目标相互干扰。

### 9.1.2 HC 的解决方案

HC 为每个 token 维护 **4 条并行流**（`DS4_N_HC=4`），每条流维度与 embedding 相同（4096）。每个子层执行前，一个小型学习投影（"HC pre"）把 4 条流汇聚成单一输入；子层执行后，另一个投影（"HC post"）把输出注入回 4 条流。

这相当于给每个子层提供了可学习的"读写头"，让网络自由决定从哪些流读取信息、把结果写到哪些流。最终在 LM head 之前，再次汇聚 4 条流输出 logits。

<svg viewBox="0 0 640 520" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Hyper-Connections: 4 parallel streams collapsed by HC pre into sublayer input, then expanded back by HC post">
  <defs>
    <marker id="ar9-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="320" y="20" text-anchor="middle" font-size="11" fill="#64748b">4 条 HC 流（每条 4096 维）</text>
  <rect x="60" y="28" width="120" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="120" y="52" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">stream_0</text>
  <rect x="200" y="28" width="120" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="260" y="52" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">stream_1</text>
  <rect x="340" y="28" width="120" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="400" y="52" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">stream_2</text>
  <rect x="480" y="28" width="100" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="530" y="52" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">stream_3</text>
  <line x1="120" y1="68" x2="240" y2="128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-1)"/>
  <line x1="260" y1="68" x2="270" y2="128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-1)"/>
  <line x1="400" y1="68" x2="360" y2="128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-1)"/>
  <line x1="530" y1="68" x2="400" y2="128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-1)"/>
  <rect x="140" y="128" width="360" height="60" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="152" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">HC pre</text>
  <text x="320" y="172" text-anchor="middle" font-size="11" fill="#64748b">投影 + Sinkhorn → pre weights / post gates / combine</text>
  <line x1="320" y1="188" x2="320" y2="228" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-1)"/>
  <rect x="200" y="228" width="240" height="44" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="248" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">input (4096)</text>
  <text x="320" y="265" text-anchor="middle" font-size="10" fill="#64748b">加权求和 4 条流</text>
  <line x1="320" y1="272" x2="320" y2="308" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-1)"/>
  <rect x="140" y="308" width="360" height="52" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="330" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">sublayer（attention / FFN）</text>
  <text x="320" y="350" text-anchor="middle" font-size="10" fill="#64748b">block_out (4096)</text>
  <line x1="320" y1="360" x2="320" y2="396" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-1)"/>
  <rect x="140" y="396" width="360" height="60" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="420" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">HC post</text>
  <text x="320" y="440" text-anchor="middle" font-size="11" fill="#64748b">注入 + combine 矩阵混合 → 4 条更新流</text>
  <line x1="240" y1="456" x2="120" y2="484" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-1)"/>
  <line x1="280" y1="456" x2="260" y2="484" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-1)"/>
  <line x1="360" y1="456" x2="400" y2="484" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-1)"/>
  <line x1="400" y1="456" x2="530" y2="484" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-1)"/>
  <rect x="60" y="484" width="120" height="28" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="120" y="503" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">stream_0'</text>
  <rect x="200" y="484" width="120" height="28" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="260" y="503" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">stream_1'</text>
  <rect x="340" y="484" width="120" height="28" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="400" y="503" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">stream_2'</text>
  <rect x="480" y="484" width="100" height="28" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="530" y="503" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">stream_3'</text>
</svg>
<span class="figure-caption">图 R9.1 ｜ HC 4 条并行流经 pre 汇聚进子层、post 再展开：每个子层获得可学习的"读写头"</span>

<details>
<summary>ASCII 原版</summary>

```
                  stream_0 (4096)
                  stream_1 (4096)   ← 4 条 HC 流
                  stream_2 (4096)
                  stream_3 (4096)
                        │
              HC pre（投影 + Sinkhorn）
                        │
                  input (4096)
                        │
              sublayer（attention / FFN）
                        │
                  output (4096)
                        │
              HC post（注入 + combine）
                        │
                  stream_0' (4096)
                  stream_1' (4096)   ← 更新后的 4 条流
                  stream_2' (4096)
                  stream_3' (4096)
```

</details>

---

## 9.2 HC 初始化

`ds4.c:4429`（`hc_from_plain_embedding`）：

```c
static void hc_from_plain_embedding(float *out_hc,
        const float *x, uint32_t n_embd, uint32_t n_hc) {
    for (uint32_t h = 0; h < n_hc; h++) {
        memcpy(out_hc + (uint64_t)h * n_embd, x,
               (size_t)n_embd * sizeof(x[0]));
    }
}
```

输入 embedding（4096 维）广播到所有 4 条流——第 0 层开始时 4 条流完全相同。网络通过 HC pre/post 投影逐层分化各流的表示。

这种初始化保证了 HC 流在第 0 层的对称性，使得网络可以从简单的均等分配出发学习非对称的流分工。

---

## 9.3 HC pre 步骤：归一化与 Sinkhorn 控制向量

### 9.3.1 整体结构

`ds4.c:4354`（`hc_pre_from_state_one_scratch`）——完整 HC pre 步骤：

```c
/* 1. 把 4×4096 的 HC state 展平，做整体 RMSNorm（无学习 scale） */
rms_norm_no_weight(flat, residual_hc, hc_dim, DS4_RMS_EPS);

/* 2. F16 matvec：4×4096 → HC_MIX（24维，= 2×4 + 4×4） */
matvec_f16(mix, model, fn, flat);

/* 3. Sinkhorn 分解：输出 pre weights(4), post gates(4), combine matrix(4×4) */
hc_split_sinkhorn_one(split, mix, scale, base, n_hc, DS4_N_HC_SINKHORN_ITER, 1e-6f);

/* 4. 加权求和 4 条流 → 单一输入向量 */
hc_weighted_sum_one(out, residual_hc, split, DS4_N_EMBD, n_hc);

memcpy(post, split + n_hc, n_hc * sizeof(post[0]));               // post gates
memcpy(comb, split + 2*n_hc, n_hc*n_hc * sizeof(comb[0]));       // combine matrix
```

### 9.3.2 无学习 scale 的 RMSNorm

`ds4.c:2771`（`rms_norm_no_weight`）：

```c
static void rms_norm_no_weight(float *out, const float *x,
        uint64_t n, float eps) {
    double ss = 0.0;
    for (uint64_t i = 0; i < n; i++) ss += (double)x[i] * x[i];
    const float scale = 1.0f / sqrtf((float)(ss / (double)n) + eps);
    for (uint64_t i = 0; i < n; i++) out[i] = x[i] * scale;
}
```

HC 控制投影（归一化 4×4096 维向量后投影）使用此版本——没有 per-channel 学习 scale。标准 DS4 RMSNorm（`ds4.c:2780`，`rms_norm_weight`）则带有 `weight[i]` 乘法，用于注意力/FFN 前的主干归一化。

HC 为何不需要学习 scale？因为控制投影的输出是一组"路由权重"，只需方向信息，幅值由后续 sigmoid/softmax 决定，额外的学习 scale 是冗余的。

### 9.3.3 Sinkhorn 分解

`ds4.c:4256`（`hc_split_sinkhorn_one`）把 24 维 mix 向量解码为：
- `out[0..3]`：pre weights（sigmoid，表示从 stream h 读取的权重）
- `out[4..7]`：post gates（2×sigmoid，表示写入 stream h 的强度，范围 [0,2]）
- `out[8..23]`：combine matrix（4×4 double-normalized doubly-stochastic 矩阵）

```c
/* pre weights */
for (int i = 0; i < n_hc; i++) {
    const float z = mix[i] * pre_scale + base[i];
    out[i] = 1.0f / (1.0f + expf(-z)) + eps;  // sigmoid + epsilon
}
/* post gates */
for (int i = 0; i < n_hc; i++) {
    const float z = mix[n_hc + i] * post_scale + base[n_hc + i];
    out[n_hc + i] = 2.0f / (1.0f + expf(-z));  // 2 × sigmoid，范围(0,2)
}
/* combine matrix: softmax 行归一化 → 列归一化 → 迭代 20 次（Sinkhorn） */
```

Sinkhorn 迭代（20 次，`DS4_N_HC_SINKHORN_ITER`）确保 combine matrix 是双随机矩阵（行和=1，列和=1），即各流的信息守恒。这防止 HC 后步骤对某些流施加不均衡的影响。

### 9.3.4 加权求和成单一输入

```c
static void hc_weighted_sum_one(
        float *out, const float *x, const float *weights,
        uint32_t n_embd, uint32_t n_hc) {
    for (uint32_t d = 0; d < n_embd; d++) {
        float acc = 0.0f;
        for (uint32_t h = 0; h < n_hc; h++)
            acc += x[(uint64_t)h * n_embd + d] * weights[h];
        out[d] = acc;
    }
}
```

`weights` 即 pre weights（4 个 sigmoid 值），`x` 是 4 条 HC 流，加权和输出即送入子层的 4096 维向量。

---

## 9.4 HC post 步骤：注入输出并混合流

`ds4.c:4436`（`hc_post_one`）：

```c
static void hc_post_one(
        float *out_hc, const float *block_out,
        const float *residual_hc,
        const float *post, const float *comb,
        uint32_t n_embd, uint32_t n_hc) {
    for (uint32_t dst = 0; dst < n_hc; dst++) {
        for (uint32_t d = 0; d < n_embd; d++) {
            float acc = block_out[d] * post[dst];
            for (uint32_t src = 0; src < n_hc; src++)
                acc += comb[dst + src * n_hc] * residual_hc[(uint64_t)src * n_embd + d];
            out_hc[(uint64_t)dst * n_embd + d] = acc;
        }
    }
}
```

对目标流 `dst` 的每个维度 `d`：
- `block_out[d] * post[dst]`：子层输出乘以对应的 post gate（0~2 范围）
- `comb[dst, src] * residual_hc[src, d]`：原始 4 条流通过双随机 combine 矩阵混合的贡献
- 两者相加得到新的 stream_dst

`comb` 是行为目标、列为来源的矩阵（`comb[dst + src * n_hc]`），Sinkhorn 保证其行列和均为 1。

---

## 9.5 最终 HC 收敛

`ds4.c:8006`（`output_hc_head_one`）：

```c
static void output_hc_head_one(
        float *out, const ds4_model *model,
        const ds4_weights *weights, const float *inp_hc) {
    rms_norm_no_weight(flat, inp_hc, hc_dim, DS4_RMS_EPS);
    matvec_f16(pre, model, weights->output_hc_fn, flat);
    const float *scale = tensor_data(model, weights->output_hc_scale);
    const float *base  = tensor_data(model, weights->output_hc_base);
    for (uint32_t i = 0; i < n_hc; i++)
        w[i] = sigmoid_stable(pre[i] * scale[0] + base[i]) + DS4_HC_EPS;
    hc_weighted_sum_one(out, inp_hc, w, DS4_N_EMBD, n_hc);
}
```

与 HC pre 类似：归一化 4×4096 → F16 投影得 4 个 pre weights → sigmoid → 加权求和得单一 4096 维向量，送入 output RMSNorm 和 vocab 投影（`output_logits_one`，`ds4.c:8036`）。

---

## 9.6 两种 RMSNorm 的比较

| 函数 | 文件行 | 学习 scale | 使用场景 |
|------|--------|-----------|---------|
| `rms_norm_no_weight` | `ds4.c:2771` | 无 | HC 控制向量归一化、HC 收敛 |
| `rms_norm_weight` | `ds4.c:2780` | 有（F32 per-channel） | 注意力/FFN 前归一化、KV 归一化、压缩器输出归一化 |
| `head_rms_norm_inplace` | `ds4.c:2789` | 无（就地） | per-head Q 归一化 |

---

## 9.7 早层路由：token-id 哈希

### 9.7.1 问题

前几层（`ds4.c:5230` 检测 `layer->ffn_gate_tid2eid != NULL`）使用哈希路由而非 top-k。原因：在网络浅层，token 的语义 embedding 尚未充分分化，基于内容的 top-k 选择意义不大；直接把 token_id 映射到固定专家组合更稳定，也避免了路由塌陷（所有 token 选同一批专家）。

### 9.7.2 实现

`ds4.c:5230`（`layer_hash_selected_experts`）：

```c
const int32_t *table = tensor_data(model, t);  // shape [DS4_N_EXPERT_USED=6, DS4_N_VOCAB]
const int32_t *row = table + (uint64_t)token * DS4_N_EXPERT_USED;
for (int i = 0; i < DS4_N_EXPERT_USED; i++) selected[i] = row[i];
```

`ffn_gate_tid2eid` 是一张查找表：给定 token_id，直接返回预设的 6 个专家编号。这张表在训练/转换时预计算，推理时零开销。

即使使用哈希路由，权重仍然由 router probabilities 决定（`layer_hash_router_weights_one`）：对 6 个预选专家，查其 softplus 分数，归一化后乘以 `DS4_EXPERT_WEIGHT_SCALE=1.5`。

---

## 9.8 后层路由：偏置 top-k + softplus score

### 9.8.1 score 计算

`ds4.c:5250`（`layer_router_probs_one`）：

```c
static void layer_router_probs_one(
        float probs[DS4_N_EXPERT], ...) {
    float logits[DS4_N_EXPERT];
    matvec_f16(logits, model, layer->ffn_gate_inp, x);  // 4096 → 256
    for (int i = 0; i < DS4_N_EXPERT; i++)
        probs[i] = sqrtf(softplus_stable(logits[i]));
}
```

`softplus(x) = log(1 + exp(x))`，再取平方根。这个变换把任意实数映射到 `[0, ∞)`，相比标准 softmax 有两个优点：
1. **非竞争性**：每个专家的 score 独立计算，不受其他专家影响
2. **非稀疏性**：不会因为 softmax 归一化把弱专家的 score 压到极小

### 9.8.2 偏置 top-k 选择

`ds4.c:5308`（`layer_topk_selected_experts_from_probs`）：

```c
float selection[DS4_N_EXPERT];
memcpy(selection, probs, sizeof(selection));
if (layer->ffn_exp_probs_b) {
    const float *bias = tensor_data(model, layer->ffn_exp_probs_b); // [256]
    for (int i = 0; i < DS4_N_EXPERT; i++) selection[i] += bias[i];
}
topk_desc(selection, DS4_N_EXPERT, DS4_N_EXPERT_USED, selected);
/* 归一化时用 probs（无偏置），不用 selection（有偏置） */
float sum = 0.0f;
for (int i = 0; i < DS4_N_EXPERT_USED; i++) {
    expert_weight[i] = probs[selected[i]];
    sum += expert_weight[i];
}
if (sum < 6.103515625e-5f) sum = 6.103515625e-5f;
for (int i = 0; i < DS4_N_EXPERT_USED; i++)
    expert_weight[i] = expert_weight[i] / sum * DS4_EXPERT_WEIGHT_SCALE;
```

关键设计：**选择用有偏置的 score，权重用无偏置的 probs**。偏置 `ffn_exp_probs_b` 是训练中学习的负载均衡调节量，用于推动专家选择更均匀，但不改变最终权重的语义。

归一化后乘以 `DS4_EXPERT_WEIGHT_SCALE=1.5`：这是一个全局缩放因子，让专家输出在加到残差流时具有适当幅值。

---

## 9.9 路由专家计算：IQ2_XXS + Q2_K

### 9.9.1 整体流程（单 token）

`ds4.c:5359`（`layer_routed_moe_one`）：

```c
/* 1. 激活 Q8_K 量化（供 IQ2_XXS 点积） */
ds4_quantize_row_q8_K(x, xq, (int64_t)expert_in_dim);

/* 2. 路由选择 */
if (hash) layer_hash_selected_experts(selected, ...);
else      layer_topk_selected_experts(selected, expert_weight, ...);

/* 3. IQ2_XXS gate/up 批量投影 + SwiGLU */
matvec_iq2_xxs_experts_mid_prequant(
        mid_all, model,
        layer->ffn_gate_exps, layer->ffn_up_exps,
        xq, selected, expert_weight,
        DS4_N_EXPERT_USED, clamp);  // clamp = DS4_SWIGLU_CLAMP_EXP = 10.0

/* 4. mid 量化（供 Q2_K 点积） */
for (int i = 0; i < DS4_N_EXPERT_USED; i++)
    ds4_quantize_row_q8_K(mid_all + i*down_in_dim, midq + i*..., ...);

/* 5. Q2_K down 投影，累加到 out */
matvec_q2_k_experts_accum_prequant(out, model, layer->ffn_down_exps,
                                   midq, selected, DS4_N_EXPERT_USED);
```

### 9.9.2 gate/up 投影（IQ2_XXS，`ds4.c:3845`）

`matvec_iq2_xxs_expert_pair_prequant` 对单个专家的 gate 和 up 矩阵（均 IQ2_XXS）共享同一个 Q8_K 激活向量，计算 gate 和 up 的点积结果。

批量版 `matvec_iq2_xxs_experts_mid_prequant`（`ds4.c:3915`）通过 `ds4_parallel_for` 对 `n_expert × out_dim` 个输出维度并行计算。每个输出 `(slot, row)` 对：
1. 找到 slot 对应的专家的 gate/up row
2. IQ2_XXS 点积
3. clamp（|gate|, |up| <= 10）
4. `silu(gate) * up * expert_weight[slot]` → `mid_all[slot, row]`

### 9.9.3 SwiGLU clamp 的必要性

`DS4_SWIGLU_CLAMP_EXP=10.0` 对 gate 和 up 的值域做截断（`ds4.c:5429`）：

```c
if (limit > 1.0e-6f) {
    if (gate[j] > limit) gate[j] = limit;
    if (up[j] > limit) up[j] = limit;
    if (up[j] < -limit) up[j] = -limit;
}
mid[j] = silu(gate[j]) * up[j] * expert_weight[i];
```

IQ2_XXS 是极低比特（约 2.06 bpw）量化，量化噪声可能导致异常值。clamp 截断可以防止单个量化误差通过 silu 指数放大到影响后续层的幅值。

### 9.9.4 down 投影（Q2_K，`ds4.c:3980`）

`matvec_q2_k_experts_accum_prequant`（`ds4.c:4032`）：对每个输出维度 `row`，累加所有选中专家的 Q2_K 点积结果：

```c
for (uint64_t row = row0; row < row1; row++) {
    float acc = 0.0f;
    for (int i = 0; i < ctx->n_expert; i++) {
        float v = 0.0f;
        const block_q2_K *br = (const block_q2_K *)(ctx->base[i] + row * ctx->row_bytes[i]);
        ds4_vec_dot_q2_K_q8_K((int)ctx->in_dim, &v, br, ctx->xq[i]);
        acc += v;
    }
    ctx->out[row] = acc;
}
```

down 矩阵的 `in_dim = DS4_N_FF_EXP = 2048`，`out_dim = DS4_N_EMBD = 4096`。每个专家输出一个 4096 维向量，6 个专家的输出直接累加（不乘 expert_weight，因为 weight 已在 mid 阶段吸收）。

---

## 9.10 共享专家

`ds4.c:5107`（`layer_shared_ffn_one`）——对每个 token 无条件执行的 SwiGLU MLP：

```c
static void layer_shared_ffn_one(
        float *out, const ds4_model *model,
        const ds4_layer_weights *layer, const float *x) {
    /* gate 和 up 矩阵（Q8_0）共享激活量化 */
    quantize_q8_0_activation(x, xq, xscale, in_dim);
    matvec_q8_0_pair_prequant(gate, up, model,
                              layer->ffn_gate_shexp,
                              layer->ffn_up_shexp,
                              xq, xscale);
    swiglu(mid, gate, up, DS4_N_FF_EXP, DS4_SWIGLU_CLAMP_EXP);  // 同样 clamp=10
    matvec_q8_0(out, model, layer->ffn_down_shexp, mid);
}
```

张量规格（`ds4.c:2419`）：
- `ffn_gate_shexp`、`ffn_up_shexp`：Q8_0，shape `[4096, 2048]`
- `ffn_down_shexp`：Q8_0，shape `[2048, 4096]`

共享专家的 hidden dim 同为 `DS4_N_FF_EXP=2048`，与路由专家相同，使用 Q8_0 而非 IQ2_XXS（精度更高），无 clamp（实际代码传入相同 clamp 值，但 Q8_0 量化误差小，clamp 很少触发）。

---

## 9.11 decode 版 MoE（scratch 路径）

`ds4.c:5457`（`layer_routed_moe_one_prealloc`）——decode 路径使用预分配缓冲区：

```c
static void layer_routed_moe_one_prealloc(
        float *out, ...,
        float *mid_all, block_q8_K *xq, block_q8_K *midq) {
    /* 与 layer_routed_moe_one 相同逻辑，但 mid_all/xq/midq 由外部提供 */
    matvec_iq2_xxs_experts_mid_prequant(mid_all, ...);
    /* ... */
    matvec_q2_k_experts_accum_prequant(out, ...);
}
```

scratch buffers 在 `ds4_cpu_decode_scratch` 中预分配，整个 decode 阶段零动态 malloc。

---

## 9.12 prefill 版 MoE（按专家分组）

`ds4.c:5507`（`layer_routed_moe_batch`）：prefill 时对整个 token batch 按专家分组，使每个活跃专家的权重行只被扫描一次。

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Prefill MoE batch pipeline: route tokens, radix sort by expert, parallel gate/up, quantize mid, parallel down accumulate">
  <defs>
    <marker id="ar9-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="20" width="160" height="60" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="100" y="44" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">① 全 token 路由</text>
  <text x="100" y="62" text-anchor="middle" font-size="10" fill="#64748b">n_tok × 6 个</text>
  <text x="100" y="76" text-anchor="middle" font-size="10" fill="#64748b">(token, expert) pair</text>
  <line x1="180" y1="50" x2="210" y2="50" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-2)"/>
  <rect x="210" y="20" width="160" height="60" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="290" y="44" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">② 基数排序</text>
  <text x="290" y="62" text-anchor="middle" font-size="10" fill="#64748b">counts → cursor →</text>
  <text x="290" y="76" text-anchor="middle" font-size="10" fill="#64748b">pair_ids（按专家连续）</text>
  <line x1="370" y1="50" x2="400" y2="50" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-2)"/>
  <rect x="400" y="20" width="160" height="60" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="480" y="44" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">③ 活跃专家列表</text>
  <text x="480" y="62" text-anchor="middle" font-size="10" fill="#64748b">active_expert[]</text>
  <text x="480" y="76" text-anchor="middle" font-size="10" fill="#64748b">去重 + 收集</text>
  <line x1="290" y1="80" x2="290" y2="140" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-2)"/>
  <rect x="110" y="140" width="360" height="60" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="290" y="163" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">④ 并行：对每个活跃专家 e</text>
  <text x="290" y="181" text-anchor="middle" font-size="10" fill="#64748b">扫描 IQ2_XXS gate/up 行，为所有选了 e 的 token</text>
  <text x="290" y="196" text-anchor="middle" font-size="10" fill="#64748b">计算 mid 向量（clamp + silu × weight）</text>
  <line x1="290" y1="200" x2="290" y2="240" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-2)"/>
  <rect x="150" y="240" width="280" height="44" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="290" y="260" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">⑤ 并行量化 mid → midq（Q8_K）</text>
  <text x="290" y="276" text-anchor="middle" font-size="10" fill="#64748b">为 down 投影预量化</text>
  <line x1="290" y1="284" x2="290" y2="310" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-2)"/>
  <rect x="100" y="310" width="380" height="24" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="290" y="327" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">⑥ 并行 down 维度累加：Q2_K 点积 × 所有 pair → out</text>
  <text x="620" y="44" text-anchor="middle" font-size="10" fill="#94a3b8">专家权重行</text>
  <text x="620" y="58" text-anchor="middle" font-size="10" fill="#94a3b8">只读一次</text>
  <line x1="560" y1="50" x2="598" y2="50" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <rect x="598" y="36" width="90" height="28" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/>
  <text x="643" y="50" text-anchor="middle" font-size="9" fill="#16a34a" font-weight="600">带宽节省</text>
  <text x="643" y="62" text-anchor="middle" font-size="9" fill="#64748b">≈ N/batch_per_exp</text>
</svg>
<span class="figure-caption">图 R9.2 ｜ Prefill MoE 按专家分组 pipeline：基数排序后每专家权重行只扫描一次，大幅降低内存带宽</span>

<details>
<summary>ASCII 原版</summary>

```
步骤：
1. 对所有 token 计算路由（或哈希选择），得到 n_tok × 6 个 (token, expert) pair
2. 按 expert 做基数排序：counts[] → cursor[] → pair_ids[]（排序后每专家对应的 pair 连续）
3. 找出活跃专家列表 active_expert[]
4. 并行：对每个活跃专家 e，扫描其 IQ2_XXS gate/up 行，
   为所有选了 e 的 token 计算 mid 向量（clamp + silu × weight）
5. 并行量化 mid → midq（Q8_K）
6. 并行：对每个输出维度 row，累加所有 (token, expert) pair 的 Q2_K 点积
```

</details>

分组的好处：若 N 个 token 选同一专家，专家的权重行（IQ2_XXS）只被读一次，而不是 N 次。在 batch 规模 N=2048 时，内存带宽降低约 `N/batch_per_expert` 倍。

---

## 9.13 完整 FFN 子层

`ds4.c:5657`（`layer_ffn_one`）——单 token 版本：

```c
static void layer_ffn_one(
        float *out_hc, ...,
        const float *inp_hc, uint32_t il, int token, ...) {
    /* 1. HC pre */
    hc_pre_from_state_one(model, layer->hc_ffn_fn,
                          layer->hc_ffn_scale, layer->hc_ffn_base,
                          inp_hc, ffn_cur, post, comb);
    /* 2. FFN RMSNorm */
    rms_norm_weight(norm, ffn_cur, ffn_norm, DS4_N_EMBD, DS4_RMS_EPS);
    /* 3. 路由 MoE（IQ2_XXS gate/up + Q2_K down） */
    layer_routed_moe_one(moe, model, layer, norm, il, token, DS4_SWIGLU_CLAMP_EXP, false);
    /* 4. 共享专家（Q8_0 SwiGLU） */
    layer_shared_ffn_one(shared, model, layer, norm);
    /* 5. 加和 */
    for (uint32_t i = 0; i < DS4_N_EMBD; i++) ffn_out[i] = moe[i] + shared[i];
    /* 6. HC post */
    hc_post_one(out_hc, ffn_out, inp_hc, post, comb, DS4_N_EMBD, n_hc);
}
```

路由 MoE 和共享专家独立并行于同一个归一化输入 `norm`，输出直接相加（无任何门控混合）——这是 MoE 加共享专家的典型设计，确保共享专家总能提供稳定的基础表示，路由专家在其之上叠加专化信息。

---

## 9.14 FFN 数据流总览

<svg viewBox="0 0 760 500" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Complete FFN sublayer data flow: HC pre, RMSNorm, parallel routed MoE and shared expert, sum, HC post">
  <defs>
    <marker id="ar9-3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="240" y="10" width="280" height="44" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="30" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">inp_hc (4 × 4096)</text>
  <text x="380" y="47" text-anchor="middle" font-size="10" fill="#64748b">4 条 HC 流</text>
  <line x1="380" y1="54" x2="380" y2="84" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-3)"/>
  <rect x="180" y="84" width="400" height="44" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="104" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">HC pre</text>
  <text x="380" y="120" text-anchor="middle" font-size="10" fill="#64748b">保留 residual_hc · post · comb；输出 ffn_cur (4096)</text>
  <line x1="380" y1="128" x2="380" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-3)"/>
  <rect x="240" y="158" width="280" height="36" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="178" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">FFN RMSNorm → norm (4096)</text>
  <line x1="280" y1="194" x2="160" y2="234" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-3)"/>
  <line x1="480" y1="194" x2="600" y2="234" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-3)"/>
  <rect x="20" y="234" width="280" height="80" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="160" y="258" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">路由 MoE (6 / 256 专家)</text>
  <text x="160" y="274" text-anchor="middle" font-size="10" fill="#64748b">Q8_K(norm) → IQ2_XXS gate/up</text>
  <text x="160" y="290" text-anchor="middle" font-size="10" fill="#64748b">clamp → silu × weight</text>
  <text x="160" y="306" text-anchor="middle" font-size="10" fill="#64748b">Q8_K(mid) → Q2_K down → moe (4096)</text>
  <rect x="460" y="234" width="280" height="80" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="600" y="258" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">共享专家</text>
  <text x="600" y="274" text-anchor="middle" font-size="10" fill="#64748b">Q8_0 gate/up</text>
  <text x="600" y="290" text-anchor="middle" font-size="10" fill="#64748b">silu</text>
  <text x="600" y="306" text-anchor="middle" font-size="10" fill="#64748b">Q8_0 down → shared (4096)</text>
  <line x1="160" y1="314" x2="300" y2="362" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-3)"/>
  <line x1="600" y1="314" x2="460" y2="362" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-3)"/>
  <rect x="240" y="362" width="280" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="382" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ffn_out = moe + shared (4096)</text>
  <line x1="380" y1="398" x2="380" y2="428" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9-3)"/>
  <rect x="180" y="428" width="400" height="44" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="448" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">HC post</text>
  <text x="380" y="464" text-anchor="middle" font-size="10" fill="#64748b">注入 + combine 矩阵 → out_hc (4 × 4096)</text>
</svg>
<span class="figure-caption">图 R9.3 ｜ FFN 子层完整数据流：HC pre → RMSNorm → 路由 MoE 与共享专家并行 → 相加 → HC post</span>

<details>
<summary>ASCII 原版</summary>

```
inp_hc (4 × 4096)
    │
    ▼
HC pre ──────────────────────────────────────────────── (保留 residual_hc, post, comb)
    │
    ▼ ffn_cur (4096)
FFN RMSNorm
    │
    ▼ norm (4096)
    ├──► 路由 MoE:
    │       Q8_K(norm) → IQ2_XXS gate/up × 6专家 → clamp → silu × weight
    │       → Q8_K(mid) → Q2_K down × 6专家累加 → moe (4096)
    │
    └──► 共享专家:
            Q8_0 gate/up → silu → Q8_0 down → shared (4096)
    │
    ▼ ffn_out = moe + shared (4096)
    │
    ▼
HC post → out_hc (4 × 4096)
```

</details>

---

## 9.15 关键常数汇总

| 常量 | 值 | 含义 |
|------|----|------|
| `DS4_N_HC` | 4 | HC 流数量 |
| `DS4_N_HC_SINKHORN_ITER` | 20 | Sinkhorn 迭代次数 |
| `DS4_HC_EPS` | 1e-6 | pre/post weight 的 epsilon 防零 |
| `DS4_N_EXPERT` | 256 | 路由专家总数 |
| `DS4_N_EXPERT_USED` | 6 | 每 token 选取的路由专家数 |
| `DS4_N_EXPERT_SHARED` | 1 | 共享专家数 |
| `DS4_N_FF_EXP` | 2048 | 专家 hidden dim |
| `DS4_EXPERT_WEIGHT_SCALE` | 1.5 | 专家权重归一化后的缩放因子 |
| `DS4_SWIGLU_CLAMP_EXP` | 10.0 | gate/up 截断上限 |

---

## 9.16 早层与后层路由的边界

`ds4.c:5230` 判断 `layer->ffn_gate_tid2eid != NULL`，而 `ffn_gate_tid2eid` 的存在由模型文件决定。根据 `ds4.c:2423`，只有当配置中显式声明了该张量的层才使用哈希路由。根据 DeepSeek V4 Flash 架构，前 3 层（层 0-2）使用哈希路由，后续层使用 top-k 偏置路由——但具体边界由加载的模型文件决定，引擎不硬编码。

---

## 本章小结

DS4 的 HC + MoE 架构有三个层次的专家化机制同时工作：

1. **HC 流分工**（宏观）：4 条流通过学习的读/写投影分担不同的表示角色
2. **MoE 路由**（中观）：每个 token 动态选 6/256 个路由专家 + 1 个共享专家
3. **量化分层**（微观）：共享专家用 Q8_0，路由专家 gate/up 用 IQ2_XXS（2 bpw），down 用 Q2_K（更高精度），平衡了精度与内存

理解这三层机制的交互，是阅读完整前向计算主循环（`ds4.c:~7990`）的基础。
