# Trace 步骤 11 —— 284B 参数的 MoE，单个 token 凭什么只算一小部分？

## 1. 当前情境

步骤 10 结束后，注意力子层的输出已经通过 HC post 写回了 `inp_hc`。现在同一层的
FFN 子层接管这个 HC 状态。

此时 `inp_hc` 的形状是 `[n_tok, 4, 4096]`（4 条 HC 流 × 嵌入宽度）。FFN 子层的目标
与注意力子层对称：从 HC 流中取出 FFN 输入，喂给专家网络，把输出再注回 HC。

DS4 的 FFN 是一个 **Mixture-of-Experts（MoE）**：模型总共有 `DS4_N_EXPERT = 256` 个
路由专家，加上 1 个对所有 token 都激活的共享专家。每层的 FFN 参数量约 **6.6B**
（256 专家 × 2 × 4096×2048 IQ2_XXS + 1 共享专家 Q8_0），43 层合计超过 **284B 参数**。
但每个 token 只激活 **6 个**路由专家，实际计算量只是全参数的 6/256 ≈ 2.3%。

## 2. 问题

这一步要回答：一个 token 向量经过 FFN 子层，具体走哪些路径？哪个模块决定"选哪 6 个
专家"？专家内部怎么算？共享专家有什么不同？归一化和残差怎么通过 HC 机制接入？

最关键的问题是：**为什么 token 能只算全部参数的一小部分，同时模型效果不退化？**

## 3. 朴素思路

朴素的密集 FFN（dense MLP）思路：

1. 对输入做 RMSNorm。
2. 上投影（gate + up，SwiGLU）：`4096 → 2048` 维两次。
3. 下投影：`2048 → 4096`。

对 DS4 来说，如果把 256 个专家全部激活，每 token 就要跑 256 次 SwiGLU 和 256 次
下投影，计算量约 `256 × (2 × 4096×2048 + 4096×2048) = 256 × 25B FLOPs = 6.4T FLOPs`
每 token 每层，在任何硬件上都不可接受。

## 4. 为什么朴素思路会崩

**计算量**：384B 密集 FFN 每层前向大约需要 `2 × 384B FLOPs ≈ 768G FLOPs`（仅 FFN）；
43 层就是 **33T FLOPs/token**。A100 的峰值算力约 78 TFLOPs，生成一个 token 需要约
0.4 秒，远不能实时。

**内存带宽**：即使不算计算，加载 284B 参数权重本身（每 token 每层）就需要读取 **6.6 GiB**
数据。16 GB/s 的 PCIe 带宽下需要超过 **400 ms/层**，根本无法实时推理。

MoE 的核心思路是：大量参数存在磁盘/显存，但每次推理只激活一小部分（路由选出的专家），
这样参数量和表达能力可以很大，同时单次推理成本保持有限。

## 5. DwarfStar 4 的做法

FFN 子层分五个阶段，由 `layer_ffn_one()`（单 token）或批量版本协调完成：

### 阶段一：HC pre（`ds4.c:4354`）

<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="HC pre stage: four operations on inp_hc producing ffn_cur, post and comb">
  <defs>
    <marker id="ar11a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="220" y="10" width="200" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="31" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">inp_hc [4, 4096]</text>
  <line x1="320" y1="42" x2="320" y2="66" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11a)"/>
  <line x1="320" y1="66" x2="90" y2="66" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="320" y1="66" x2="550" y2="66" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="90" y1="66" x2="90" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11a)"/>
  <line x1="215" y1="66" x2="215" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11a)"/>
  <line x1="425" y1="66" x2="425" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11a)"/>
  <line x1="550" y1="66" x2="550" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11a)"/>
  <rect x="20" y="86" width="140" height="32" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="90" y="102" text-anchor="middle" font-size="11" fill="#64748b">rms_norm_no_weight</text>
  <text x="90" y="116" text-anchor="middle" font-size="10" fill="#94a3b8">HC 展开 RMSNorm</text>
  <rect x="145" y="86" width="140" height="32" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="215" y="102" text-anchor="middle" font-size="11" fill="#64748b">matvec_f16</text>
  <text x="215" y="116" text-anchor="middle" font-size="10" fill="#94a3b8">hc_ffn_fn 投影</text>
  <rect x="355" y="86" width="140" height="32" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="425" y="102" text-anchor="middle" font-size="11" fill="#64748b">hc_split_sinkhorn_one</text>
  <text x="425" y="116" text-anchor="middle" font-size="10" fill="#94a3b8">Sinkhorn → split/post/comb</text>
  <rect x="480" y="86" width="140" height="32" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="550" y="102" text-anchor="middle" font-size="11" fill="#64748b">hc_weighted_sum_one</text>
  <text x="550" y="116" text-anchor="middle" font-size="10" fill="#94a3b8">加权求和</text>
  <line x1="90" y1="118" x2="90" y2="148" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <line x1="215" y1="118" x2="215" y2="148" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <line x1="425" y1="118" x2="320" y2="148" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <line x1="550" y1="118" x2="320" y2="148" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <rect x="220" y="148" width="200" height="32" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="320" y="164" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">ffn_cur [4096]</text>
  <text x="320" y="178" text-anchor="middle" font-size="10" fill="#64748b">+ post[4]  + comb[4×4]</text>
  <text x="20" y="220" font-size="10" fill="#94a3b8">hc_pre_from_state_one()  ds4.c:4354</text>
</svg>
<span class="figure-caption">图 T11.1 ｜ HC pre 阶段：四步操作从 inp_hc 提炼出 ffn_cur、post 和 comb</span>

<details>
<summary>ASCII 原版</summary>

```
inp_hc [4, 4096]
   |
   +-- rms_norm_no_weight (对整个 HC 展开向量做 RMSNorm)
   +-- matvec_f16 (hc_ffn_fn)        ← 投影控制向量
   +-- hc_split_sinkhorn_one          ← Sinkhorn 归一化，分成 split/post/comb
   +-- hc_weighted_sum_one            ← 加权求和得 ffn_cur [4096]
```

</details>

`hc_pre_from_state_one()` 从 4 条 HC 流中提炼出一个 4096 维的"sublayer input"
(`ffn_cur`)，同时记录下 `post`（4 个标量）和 `comb`（4×4 矩阵），供 HC post 使用。

### 阶段二：FFN RMSNorm（`ds4.c:5700`）

```text
ffn_cur [4096]
   |
   layer->ffn_norm [F32, 4096]   ← 学习权重 RMSNorm
   |
   norm [4096]
```

### 阶段三：路由选专家（`ds4.c:5230` / `ds4.c:5308`）

DS4 有两套路由机制，由层号决定：

**早层（有 `ffn_gate_tid2eid` 的层）：哈希路由**（`ds4.c:5230`）

```text
token_id
   |
   ffn_gate_tid2eid [I32, DS4_N_EXPERT_USED × vocab]   ← 查表
   |
   selected[6]   ← 该 token_id 固定映射到这 6 个专家
```

哈希路由完全不依赖输入向量内容，只看 token id。路由权重仍然通过
`layer_router_probs_one()`（`ds4.c:5252`）从 `ffn_gate_inp` 矩阵计算，
但选哪几个是固定的，不依赖上下文。

**后层：偏置 top-k 路由**（`ds4.c:5308`）

<svg viewBox="0 0 640 330" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Biased top-k routing: norm vector through gate weights, sqrt-softplus, bias addition, top-6 selection and weight normalization">
  <defs>
    <marker id="ar11b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="220" y="10" width="200" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="31" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">norm [4096]</text>
  <line x1="320" y1="42" x2="320" y2="62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11b)"/>
  <rect x="180" y="62" width="280" height="28" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="76" text-anchor="middle" font-size="11" fill="#64748b">ffn_gate_inp</text>
  <text x="320" y="88" text-anchor="middle" font-size="10" fill="#94a3b8">F16  4096 × 256  路由器权重</text>
  <line x1="320" y1="90" x2="320" y2="110" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11b)"/>
  <rect x="220" y="110" width="200" height="28" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="129" text-anchor="middle" font-size="12" fill="currentColor">logits [256]</text>
  <line x1="320" y1="138" x2="320" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11b)"/>
  <rect x="160" y="158" width="320" height="28" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="177" text-anchor="middle" font-size="11" fill="#64748b">probs[i] = sqrt(softplus(logits[i]))</text>
  <line x1="320" y1="186" x2="320" y2="206" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11b)"/>
  <rect x="140" y="206" width="360" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="320" y="225" text-anchor="middle" font-size="11" fill="#64748b">selection[i] = probs[i] + ffn_exp_probs_b[i]</text>
  <text x="510" y="218" font-size="10" fill="#94a3b8">← 加负载均衡偏置</text>
  <line x1="320" y1="234" x2="320" y2="254" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11b)"/>
  <rect x="200" y="254" width="240" height="28" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="273" text-anchor="middle" font-size="11" fill="#64748b">top-6 by selection → selected[6]</text>
  <line x1="320" y1="282" x2="320" y2="302" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11b)"/>
  <rect x="120" y="302" width="400" height="20" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="320" y="316" text-anchor="middle" font-size="10" fill="currentColor">expert_weight[i] = probs[selected[i]] / Σprobs × 1.5f  （无偏置归一化）</text>
</svg>
<span class="figure-caption">图 T11.2 ｜ 偏置 top-k 路由：加偏置选专家、去偏置归一化权重</span>

<details>
<summary>ASCII 原版</summary>

```
norm [4096]
   |
   ffn_gate_inp [F16, 4096 × 256]   ← 路由器权重
   |
   logits [256]
   |
   probs[i] = sqrt(softplus(logits[i]))
   |
   selection[i] = probs[i] + ffn_exp_probs_b[i]   ← 加偏置
   |
   top-6 by selection → selected[6]
   expert_weight[i] = probs[selected[i]] / sum(probs[selected])
                      × DS4_EXPERT_WEIGHT_SCALE (1.5f)
```

</details>

选择时用带偏置的分数（`ffn_exp_probs_b`，学习的负载均衡偏置），但权重归一化时
用**无偏置的原始 prob**，保证梯度流不受偏置扰动。

### 阶段四：运行路由专家（`ds4.c:5359`）

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Routed MoE expert computation: IQ2XXS gate and up projections for 6 experts, SwiGLU activation, Q2K down projection accumulated to moe output">
  <defs>
    <marker id="ar11c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="280" y="10" width="200" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="27" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">norm [4096]</text>
  <text x="380" y="39" text-anchor="middle" font-size="10" fill="#64748b">已量化为 block_q8_K</text>
  <line x1="380" y1="42" x2="380" y2="62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11c)"/>
  <rect x="200" y="62" width="360" height="26" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="380" y="79" text-anchor="middle" font-size="11" fill="#64748b">matvec_iq2_xxs_experts_mid_prequant</text>
  <line x1="380" y1="88" x2="100" y2="88" stroke="#94a3b8" stroke-width="1"/>
  <line x1="380" y1="88" x2="380" y2="88" stroke="#94a3b8" stroke-width="1"/>
  <line x1="380" y1="88" x2="660" y2="88" stroke="#94a3b8" stroke-width="1"/>
  <line x1="100" y1="88" x2="100" y2="108" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11c)"/>
  <line x1="380" y1="88" x2="380" y2="108" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11c)"/>
  <line x1="660" y1="88" x2="660" y2="108" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11c)"/>
  <rect x="30" y="108" width="140" height="52" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="100" y="126" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">Expert 0</text>
  <text x="100" y="140" text-anchor="middle" font-size="10" fill="#64748b">gate × xq (IQ2_XXS)</text>
  <text x="100" y="152" text-anchor="middle" font-size="10" fill="#64748b">up × xq (IQ2_XXS)</text>
  <rect x="310" y="108" width="140" height="52" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="126" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">Expert 1-4</text>
  <text x="380" y="140" text-anchor="middle" font-size="10" fill="#64748b">gate × xq (IQ2_XXS)</text>
  <text x="380" y="152" text-anchor="middle" font-size="10" fill="#64748b">up × xq (IQ2_XXS)</text>
  <rect x="590" y="108" width="140" height="52" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="660" y="126" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">Expert 5</text>
  <text x="660" y="140" text-anchor="middle" font-size="10" fill="#64748b">gate × xq (IQ2_XXS)</text>
  <text x="660" y="152" text-anchor="middle" font-size="10" fill="#64748b">up × xq (IQ2_XXS)</text>
  <text x="265" y="134" text-anchor="middle" font-size="18" fill="#94a3b8">···</text>
  <text x="495" y="134" text-anchor="middle" font-size="18" fill="#94a3b8">···</text>
  <line x1="100" y1="160" x2="100" y2="188" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <line x1="380" y1="160" x2="380" y2="188" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <line x1="660" y1="160" x2="660" y2="188" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <line x1="100" y1="188" x2="660" y2="188" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="180" text-anchor="middle" font-size="10" fill="#64748b">silu(gate_i) × up_i × expert_weight[i]</text>
  <line x1="380" y1="188" x2="380" y2="208" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11c)"/>
  <rect x="240" y="208" width="280" height="28" rx="5" fill="#f1f5f9" stroke="#0d9488" stroke-width="1"/>
  <text x="380" y="222" text-anchor="middle" font-size="11" fill="currentColor">mid_all [6 × 2048]</text>
  <text x="380" y="234" text-anchor="middle" font-size="10" fill="#94a3b8">量化为 block_q8_K</text>
  <line x1="380" y1="236" x2="380" y2="256" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11c)"/>
  <rect x="190" y="256" width="380" height="26" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="380" y="273" text-anchor="middle" font-size="11" fill="#64748b">matvec_q2_k_experts_accum_prequant  Q2_K 下投影 [2048→4096] 累加</text>
  <line x1="380" y1="282" x2="380" y2="302" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11c)"/>
  <rect x="280" y="302" width="200" height="12" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="312" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">moe [4096]</text>
</svg>
<span class="figure-caption">图 T11.3 ｜ 路由 MoE 计算：6 个专家 IQ2_XXS 门控/上投影 + SwiGLU + Q2_K 下投影累加</span>

<details>
<summary>ASCII 原版</summary>

```
norm [4096]  (已量化为 block_q8_K)
   |
   matvec_iq2_xxs_experts_mid_prequant
   ├── 对 selected[0..5] 每个专家:
   │     gate_row × xq (IQ2_XXS)  → gate_i
   │     up_row   × xq (IQ2_XXS)  → up_i
   │     silu(gate_i) * up_i * expert_weight[i] → mid_i [2048]
   |
   mid_all [6 × 2048]  (量化为 block_q8_K)
   |
   matvec_q2_k_experts_accum_prequant
   ├── 对 6 个专家各做 Q2_K 下投影 [2048 → 4096]
   └── 累加到 moe [4096]
```

</details>

gate 和 up 投影使用 **IQ2_XXS**（`ds4.c:3915`），约 2.06 bits/weight，是 DS4 中压缩
比最激进的量化格式。down 投影使用 **Q2_K**（`ds4.c:4032`），约 2.5 bits/weight，
略高精度以减少输出误差。

两步矩阵向量乘并行计算：`ds4_parallel_for` 把 6 个专家的 `DS4_N_FF_EXP = 2048` 行
分配给多线程，`n_expert × out_dim = 6 × 2048 = 12288` 个独立任务（`ds4.c:3961`）。

### 阶段五：共享专家（`ds4.c:5107`）

```text
norm [4096]
   |
   ffn_gate_shexp / ffn_up_shexp [Q8_0, 4096 × 2048]   ← 共享专家权重（每 token 必跑）
   |
   silu(gate) * up → mid [2048]
   |
   ffn_down_shexp [Q8_0, 2048 × 4096]
   |
   shared [4096]
```

共享专家是标准 Q8_0 SwiGLU MLP，使用比路由专家更高精度的量化（Q8_0 ≈ 8 bits vs
IQ2_XXS ≈ 2 bits），因为它对每个 token 都生效，精度损失会累积。

最终 FFN 输出是路由专家和共享专家的直接相加：`ffn_out = moe + shared`（`ds4.c:5727`）。

### 阶段六：HC post（`ds4.c:4436`）

```text
ffn_out [4096]
   |
   hc_post_one(out_hc, ffn_out, inp_hc, post, comb, DS4_N_EMBD, n_hc)
   |
   out_hc[dst][d] = ffn_out[d] * post[dst]
                  + sum_src( comb[dst, src] * inp_hc[src][d] )
```

`post`（4 个标量）决定 FFN 输出如何分配到各 HC 流；`comb`（4×4 矩阵）决定各 HC
流如何从上一步的 HC 状态相互混合。这两个张量都是 HC pre 在 Sinkhorn 步骤中算出的，
是"本 token 专属"的混合配方。

完整的 FFN 单 token 流程图：

<svg viewBox="0 0 760 480" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Complete FFN sublayer single-token data flow: HC pre, RMSNorm, parallel routed MoE and shared expert, add merge, HC post">
  <defs>
    <marker id="ar11d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="280" y="10" width="200" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/>
  <text x="380" y="32" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">inp_hc [4, 4096]</text>
  <line x1="380" y1="44" x2="380" y2="68" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11d)"/>
  <rect x="250" y="68" width="260" height="34" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="85" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">hc_pre</text>
  <text x="380" y="97" text-anchor="middle" font-size="10" fill="#64748b">→ ffn_cur [4096]  + post[4]  + comb[4×4]   ds4.c:5686</text>
  <line x1="380" y1="102" x2="380" y2="126" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11d)"/>
  <rect x="260" y="126" width="240" height="30" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="141" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">ffn_norm → norm [4096]</text>
  <text x="540" y="146" font-size="10" fill="#94a3b8">ds4.c:5699</text>
  <line x1="380" y1="156" x2="380" y2="176" stroke="#94a3b8" stroke-width="1.5"/>
  <line x1="180" y1="176" x2="580" y2="176" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="180" y1="176" x2="180" y2="196" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11d)"/>
  <line x1="580" y1="176" x2="580" y2="196" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11d)"/>
  <rect x="60" y="196" width="240" height="54" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="180" y="217" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">layer_routed_moe_one</text>
  <text x="180" y="231" text-anchor="middle" font-size="10" fill="#64748b">路由 (hash or top-k)</text>
  <text x="180" y="243" text-anchor="middle" font-size="10" fill="#64748b">IQ2_XXS gate/up + Q2_K down</text>
  <text x="180" y="254" text-anchor="middle" font-size="10" fill="#94a3b8">ds4.c:5709</text>
  <rect x="460" y="196" width="240" height="54" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="580" y="217" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">layer_shared_ffn_one</text>
  <text x="580" y="231" text-anchor="middle" font-size="10" fill="#64748b">Q8_0 gate / up / down</text>
  <text x="580" y="243" text-anchor="middle" font-size="10" fill="#64748b">SwiGLU MLP（每 token 必跑）</text>
  <text x="580" y="254" text-anchor="middle" font-size="10" fill="#94a3b8">ds4.c:5717</text>
  <line x1="180" y1="250" x2="180" y2="280" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <line x1="580" y1="250" x2="580" y2="280" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <text x="180" y="273" text-anchor="middle" font-size="11" fill="#64748b">moe [4096]</text>
  <text x="580" y="273" text-anchor="middle" font-size="11" fill="#64748b">shared [4096]</text>
  <line x1="180" y1="280" x2="380" y2="308" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11d)"/>
  <line x1="580" y1="280" x2="380" y2="308" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11d)"/>
  <rect x="280" y="308" width="200" height="30" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="324" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">ffn_out = moe + shared</text>
  <text x="490" y="331" font-size="10" fill="#94a3b8">ds4.c:5726</text>
  <line x1="380" y1="338" x2="380" y2="362" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11d)"/>
  <rect x="250" y="362" width="260" height="34" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="379" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">hc_post</text>
  <text x="380" y="391" text-anchor="middle" font-size="10" fill="#64748b">post[4] + comb[4×4] 注回各 HC 流  ds4.c:5736</text>
  <line x1="380" y1="396" x2="380" y2="420" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11d)"/>
  <rect x="280" y="420" width="200" height="34" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="2"/>
  <text x="380" y="442" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">out_hc [4, 4096]</text>
</svg>
<span class="figure-caption">图 T11.4 ｜ FFN 子层单 token 完整数据流：HC pre → 归一化 → 并行 MoE 和共享专家 → 相加 → HC post</span>

<details>
<summary>ASCII 原版</summary>

```
inp_hc [4, 4096]
   |
   hc_pre → ffn_cur [4096]  +  post[4]  +  comb[4×4]     (ds4.c:5686)
   |
   ffn_norm → norm [4096]                                   (ds4.c:5699)
   |
   +--> layer_routed_moe_one → moe [4096]                   (ds4.c:5709)
   |      路由 (hash or top-k) + IQ2_XXS gate/up + Q2_K down
   |
   +--> layer_shared_ffn_one → shared [4096]                (ds4.c:5717)
   |      Q8_0 gate/up/down
   |
   ffn_out = moe + shared                                    (ds4.c:5726)
   |
   hc_post → out_hc [4, 4096]                               (ds4.c:5736)
```

</details>

## 6. 代码位置

按阅读顺序：

- `ds4.c:4354` —— `hc_pre_from_state_one_scratch()`：HC pre 核心，包含 Sinkhorn 分配。
- `ds4.c:5107` —— `layer_shared_ffn_one()`：共享专家（Q8_0 SwiGLU MLP，每 token 必跑）。
- `ds4.c:5230` —— `layer_hash_selected_experts()`：哈希路由，查 `ffn_gate_tid2eid` 表。
- `ds4.c:5308` —— `layer_topk_selected_experts_from_probs()`：带偏置 top-k 路由，
  选 6 专家时加偏置，权重归一化时去偏置。
- `ds4.c:5359` —— `layer_routed_moe_one()`：单 token 路由 MoE 主函数，含路由、
  IQ2_XXS 并行矩阵乘、Q2_K 累加下投影。
- `ds4.c:3915` —— `matvec_iq2_xxs_experts_mid_prequant()`：IQ2_XXS gate/up
  并行核心，`ds4_parallel_for` 分配 `n_expert × out_dim` 任务。
- `ds4.c:4032` —— `matvec_q2_k_experts_accum_prequant()`：Q2_K down 投影累加。
- `ds4.c:5657` —— `layer_ffn_one()`：完整 FFN 子层协调函数（单 token），
  六个阶段按顺序串联。

## 7. 分支与延伸

- HC pre/post 的 Sinkhorn 分配和"多流混合"机制的完整原理 →
  [第 9 章 超连接与 MoE](09-moe-hyperconnections.md)
- IQ2_XXS 和 Q2_K 的量化格式细节（block 结构、精度权衡） →
  [第 4 章 量化](04-quantization.md)
- 256 个专家的总参数量计算、MoE 架构与 dense 模型对比 →
  [第 2 章 模型结构](02-model-architecture.md)
- prefill 批量 FFN（`layer_ffn_raw_swa_batch()`）与单 token 版本的差异：
  批量版本对共享专家做矩阵矩阵乘，路由专家仍逐 token 串行 →
  [第 9 章 超连接与 MoE](09-moe-hyperconnections.md)
- 负载均衡偏置 `ffn_exp_probs_b` 的训练来源与推理时固定值的意义 →
  [第 2 章 模型结构](02-model-architecture.md)

## 8. 走完这一步你脑子里应该多了什么

1. 284B 参数的 MoE 每 token 只激活 6/256 ≈ **2.3%** 的路由专家，加上一个共享专家，
   实际 FFN 计算量相当于约 7 个小型 MLP，而不是 256 个。
2. 早层用**哈希路由**（仅看 token id），后层用**偏置 top-k 路由**（看上下文向量）；
   选择时加偏置保证负载均衡，权重归一化时去偏置保证无偏梯度。
3. 路由专家权重用 **IQ2_XXS**（约 2 bits）量化 gate/up，**Q2_K**（约 2.5 bits）量化
   down，共享专家用 **Q8_0**（8 bits）——精度分配与使用频率成正比。
4. HC pre/post 是 FFN 与 HC 流连接的接口：pre 从多流中提炼输入，post 把输出按
   Sinkhorn 学到的配方注回各流，这让不同 HC 流可以专注不同语义角色。
5. FFN 输出是路由 MoE 和共享专家结果的**直接相加**，共享专家充当"保底"基础变换，
   路由专家在此基础上叠加专用语义。
