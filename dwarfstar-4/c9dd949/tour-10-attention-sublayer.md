# Trace 步骤 10 —— 一层里的注意力，为什么 Q 要先压到 1024 维？

## 1. 当前情境

步骤 09 完成的是"层主序推进"的宏观视角：所有 prompt token 从第 0 层走到第 42 层。现在
把镜头拉近，聚焦到**某一层内部的注意力子层**。

以第 2 层（il=2，第一个 ratio-4 压缩层）为例。进入本子层时的数据状态：

- `inp_hc`：形状 `[n_tok, 4, 4096]`（4 条 HC 流 × 嵌入宽度），由上一层 FFN 的 HC post
  输出，或由 token 嵌入种子（第 0 层时）产生。
- `cache->layer[il]`：此层的 KV 缓存，内含 raw 滑窗（`raw_kv`，容量 `raw_cap`
  行）和压缩行（`attn_comp_kv`，目前为空，`n_comp = 0`）。

注意力子层要做的事：从 HC 流中提取归一化后的 token 表示，投影出 Q 和 KV，旋转位置编码，
在 raw + 压缩 KV 上做 softmax 注意力，再把注意力输出注入回 HC 流。

## 2. 问题

DS4 的注意力头配置非常"极端"：`DS4_N_HEAD = 64` 个 Q 头，但 KV 只有 **1 头**（GQA
极限形式）；每头宽度 `DS4_N_HEAD_DIM = 512`（`ds4.c:92`）。这意味着：

- Q 的完整投影矩阵是 `4096 → 64×512 = 32768` 维，参数量 `4096×32768 ≈ 134M`，
  单层就占约 **256 MiB**（Q8_0）。
- 43 层叠加，仅 Q 投影就接近 **11 GiB**。
- KV 只有 1 头，但宽度仍为 512，KV 缓存的 per-token per-layer 开销是 `512×2×4=4 KiB`；
  1M 上下文 × 43 层 ≈ **172 GiB**，根本放不进任何本地 GPU。

这两个问题——投影参数过大、KV 缓存过大——都必须在这一步给出答案。

## 3. 朴素思路

传统多头注意力的做法：

1. 对输入做一次 `4096 → 32768` 的线性变换，得到所有头拼在一起的 Q。
2. 再做 `4096 → 512`（K）和 `4096 → 512`（V）两个投影。
3. 把 K、V 分别存进 KV 缓存。
4. Q 与缓存里所有位置的 K 做点积，softmax，乘 V。

这个流程在标准 Llama/GPT 系列上完全没问题。

## 4. 为什么朴素思路会崩

**参数量**：`4096 → 32768` 的全秩投影矩阵有 `134M` 参数，Q8_0 量化后仍有 `134 MiB`；
43 层合计 **5.8 GiB** 仅用于 Q 投影。若再按同样方式投影 K（`4096 → 512`）和 V（`4096 → 512`），
KV 投影还要再加近 1 GiB。每次推理每层要做两次 `4096 × 32768` 矩阵向量乘，计算量也很大。

**KV 缓存**：DS4 的目标上下文是 1M token。若为每一层、每一个 position 各存一条
`512` 维的 K 和一条 `512` 维的 V（float32），则一个会话的 KV 缓存大小为：
`1,000,000 × 43 × 512 × 2 × 4 字节 ≈ 176 GiB`。这远超任何本地推理设备的内存上限。

这两个瓶颈——Q 投影过宽、KV 缓存过大——是同一个根本矛盾：**head_dim=512 太宽了**。

## 5. DwarfStar 4 的做法

DS4 的解法是两个相互呼应的低秩压缩技巧：

### Q 低秩投影（Multi-head Latent Attention Q 路径）

<svg viewBox="0 0 640 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Q low-rank projection pipeline: 4096-dim input compressed to 1024 via attn_q_a, RMSNorm stabilization, then expanded to 32768 via attn_q_b with per-head RMSNorm">
  <defs>
    <marker id="ar101" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="180" y="14" width="200" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="280" y="34" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">归一化输入 (4096)</text>
  <line x1="280" y1="46" x2="280" y2="68" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar101)"/>
  <rect x="130" y="68" width="300" height="38" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="280" y="85" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">attn_q_a  [Q8_0, 4096 → 1024]</text>
  <text x="280" y="100" text-anchor="middle" font-size="10" fill="#64748b">先"压扁"到低秩空间</text>
  <line x1="280" y1="106" x2="280" y2="128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar101)"/>
  <rect x="200" y="128" width="160" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="280" y="147" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">qr (1024)</text>
  <line x1="280" y1="156" x2="280" y2="178" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar101)"/>
  <rect x="130" y="178" width="300" height="38" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="280" y="195" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">attn_q_a_norm  [F32, 1024]</text>
  <text x="280" y="210" text-anchor="middle" font-size="10" fill="#64748b">对压缩后向量做 RMSNorm（学习的）</text>
  <line x1="280" y1="216" x2="280" y2="238" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar101)"/>
  <rect x="200" y="238" width="160" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="280" y="257" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">qr_norm (1024)</text>
  <line x1="280" y1="266" x2="280" y2="288" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar101)"/>
  <rect x="110" y="288" width="340" height="38" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="280" y="305" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">attn_q_b  [Q8_0, 1024 → 64×512]</text>
  <text x="280" y="320" text-anchor="middle" font-size="10" fill="#64748b">再"展开"到全头宽</text>
  <line x1="280" y1="326" x2="280" y2="342" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar101)"/>
  <rect x="160" y="342" width="240" height="14" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="280" y="353" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">q (64×512 = 32768)  →  head_rms_norm_inplace</text>
  <text x="14" y="200" font-size="10" fill="#94a3b8">3.5×</text>
  <text x="14" y="212" font-size="10" fill="#94a3b8">压缩</text>
  <line x1="30" y1="46" x2="30" y2="330" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="30" y="40" text-anchor="middle" font-size="9" fill="#94a3b8">参数量</text>
  <text x="540" y="85" font-size="10" fill="#94a3b8">4M 参数</text>
  <text x="540" y="307" font-size="10" fill="#94a3b8">33.6M 参数</text>
  <text x="540" y="348" font-size="10" fill="#ea580c">vs 全秩 134M</text>
</svg>
<span class="figure-caption">图 T10.1 ｜ Q 低秩投影：4096 → 1024（压扁）→ RMSNorm → 32768（展开），参数量缩减 3.5 倍</span>

<details>
<summary>ASCII 原版</summary>

```
归一化输入 (4096)
     |
  attn_q_a [Q8_0, 4096 → 1024]   ← 先"压扁"到低秩空间
     |
  中间向量 qr (1024)
     |
  attn_q_a_norm [F32, 1024]       ← 对压缩后向量做 RMSNorm（学习的）
     |
  qr_norm (1024)
     |
  attn_q_b [Q8_0, 1024 → 64×512] ← 再"展开"到全头宽
     |
  q (64×512 = 32768)
     |
  head_rms_norm_inplace            ← 按头做 RMSNorm
```

</details>

关键数字：全秩方案需要 `4096×32768 = 134M` 参数；低秩方案需要
`4096×1024 + 1024×32768 = 4.2M + 33.6M = 37.8M` 参数，**缩减 3.5 倍**。
中间的 1024 维瓶颈（`DS4_N_LORA_Q = 1024`，`ds4.c:96`）迫使模型只能
通过 1024 个自由度来表达 Q，这在语义上是一种压缩，但因为有学习的 RMSNorm
稳定中间表示，梯度可以正常流过。

### KV 低秩投影（单 KV 头）

<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="KV single-head projection: 4096-dim input projected directly to 512-dim via attn_kv, then RMSNorm stabilization">
  <defs>
    <marker id="ar102" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="180" y="14" width="200" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="280" y="34" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">归一化输入 (4096)</text>
  <line x1="280" y1="46" x2="280" y2="68" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar102)"/>
  <rect x="130" y="68" width="300" height="38" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="280" y="85" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">attn_kv  [Q8_0, 4096 → 512]</text>
  <text x="280" y="100" text-anchor="middle" font-size="10" fill="#64748b">直接投影到 1 头 × 512 维（GQA-1）</text>
  <line x1="280" y1="106" x2="280" y2="128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar102)"/>
  <rect x="200" y="128" width="160" height="28" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="280" y="147" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">kv_raw (512)</text>
  <line x1="280" y1="156" x2="280" y2="178" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar102)"/>
  <rect x="130" y="178" width="300" height="38" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="280" y="196" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">attn_kv_a_norm  [F32, 512]</text>
  <text x="280" y="212" text-anchor="middle" font-size="10" fill="#64748b">学习的 RMSNorm</text>
  <line x1="280" y1="216" x2="280" y2="228" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar102)"/>
  <rect x="210" y="228" width="140" height="6" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="480" y="232" font-size="10" fill="#0d9488">→ kv (512)，存入 KV 缓存</text>
  <text x="480" y="90" font-size="10" fill="#64748b">2M 参数</text>
  <text x="480" y="102" font-size="10" fill="#0d9488">128× 缩减</text>
</svg>
<span class="figure-caption">图 T10.2 ｜ KV 单头投影：直接 4096 → 512，仅 1 个 KV 头（GQA-1），每 token 每层只存 2 KiB</span>

<details>
<summary>ASCII 原版</summary>

```
归一化输入 (4096)
     |
  attn_kv [Q8_0, 4096 → 512]     ← 直接投影到 1 头 × 512 维
     |
  原始 kv_raw (512)
     |
  attn_kv_a_norm [F32, 512]       ← 学习的 RMSNorm
     |
  kv (512)
```

</details>

只有 1 个 KV 头，所以 KV 矩阵是 `4096×512`，参数量约 **2M**。所有 64 个 Q 头与同一个
KV 对做注意力——这是 Grouped Query Attention 的极端形式（GQA-1）。KV 缓存的 per-token
per-layer 大小从 `64×512×2×4 = 256 KiB` 降到 `512×4 = 2 KiB`，**缩减 128 倍**。

### RoPE 只作用于尾部 64 维

每头 512 维中，前 `512-64 = 448` 维是"nope"（no position encoding），后
`DS4_N_ROT = 64` 维才做 RoPE（`ds4.c:4780`）。这样 RoPE 的旋转只涉及很小一部分维度，
主体语义维度不受位置扰动。

dense 层（il < 2）使用 `DS4_ROPE_FREQ_BASE = 10000.0f`（`ds4.c:56`）；
压缩层（il ≥ 2，ratio ≠ 0）使用 `DS4_COMPRESS_ROPE_FREQ_BASE = 160000.0f`（`ds4.c:60`），
并额外做 YaRN 频率插值（`ds4.c:4816`），因为压缩层的 KV 要覆盖极长上下文。

### Sink-aware 注意力

softmax 的分母里有一个**学习的 sink logit**（`layer->attn_sinks`，每头一个标量，
`ds4.c:4976`）。标准 softmax 分母是 `sum(exp(score_i))`；DS4 的分母是
`exp(sink_logit) + sum(exp(score_i))`。sink logit 相当于一个"吸收多余注意力权重"
的虚拟位置，让模型学到"我不需要关注任何已有 KV 行"的能力，避免注意力被强迫
分配到无关位置。

完整的 prefill 注意力流程图：

<svg viewBox="0 0 760 560" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Complete prefill attention sublayer flow: HC input through pre-norm, Q and KV low-rank projections, per-token RoPE and attention with sink logit, grouped output projection, and HC post injection">
  <defs>
    <marker id="ar103" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="240" y="10" width="260" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="370" y="29" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">inp_hc [n_tok, 4, 4096]</text>
  <line x1="370" y1="40" x2="370" y2="58" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar103)"/>
  <rect x="190" y="58" width="360" height="38" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="370" y="75" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">hc_pre_norm_batch</text>
  <text x="370" y="90" text-anchor="middle" font-size="10" fill="#64748b">归一化 HC、Sinkhorn 分配、提取 attn_cur + attn_norm</text>
  <text x="560" y="80" font-size="9" fill="#94a3b8">ds4.c:7225</text>
  <line x1="260" y1="96" x2="180" y2="120" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar103)"/>
  <line x1="480" y1="96" x2="560" y2="120" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar103)"/>
  <rect x="60" y="120" width="220" height="86" rx="6" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="170" y="137" text-anchor="middle" font-size="11" font-weight="600" fill="#0ea5e9">Q 低秩投影</text>
  <text x="170" y="152" text-anchor="middle" font-size="10" fill="#64748b">matmul → qr [n_tok, 1024]</text>
  <text x="170" y="166" text-anchor="middle" font-size="10" fill="#64748b">rms_norm → qr_norm</text>
  <text x="170" y="180" text-anchor="middle" font-size="10" fill="#64748b">matmul → q [n_tok, 64×512]</text>
  <text x="170" y="194" text-anchor="middle" font-size="10" fill="#64748b">head_rms_norm</text>
  <text x="285" y="137" font-size="9" fill="#94a3b8">:7240–7250</text>
  <rect x="450" y="120" width="220" height="68" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.2"/>
  <text x="560" y="137" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">KV 单头投影</text>
  <text x="560" y="152" text-anchor="middle" font-size="10" fill="#64748b">matmul → kv_raw [n_tok, 512]</text>
  <text x="560" y="166" text-anchor="middle" font-size="10" fill="#64748b">rms_norm → kv [n_tok, 512]</text>
  <text x="675" y="137" font-size="9" fill="#94a3b8">:7258–7260</text>
  <line x1="170" y1="206" x2="170" y2="240" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar103)"/>
  <line x1="560" y1="188" x2="560" y2="240" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar103)"/>
  <rect x="80" y="240" width="590" height="130" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="375" y="258" text-anchor="middle" font-size="11" font-weight="700" fill="#16a34a">for each token t:</text>
  <text x="110" y="276" font-size="10" fill="#64748b">rope_tail_layer_inplace(q_t)</text>
  <text x="110" y="292" font-size="10" fill="#64748b">rope_tail_layer_inplace(kv_t)</text>
  <text x="110" y="308" font-size="10" fill="#64748b">compressor_decode_one（压缩层）</text>
  <text x="110" y="324" font-size="10" fill="#64748b">indexer_allowed_decode_one（ratio-4）</text>
  <text x="110" y="340" font-size="10" fill="#64748b">layer_attention_mixed_one</text>
  <text x="330" y="340" font-size="10" fill="#ea580c">sink logit + raw KV + 压缩 KV → heads</text>
  <text x="110" y="356" font-size="10" fill="#64748b">rope_tail_layer_inplace(heads, inverse)</text>
  <text x="640" y="276" font-size="9" fill="#94a3b8">:7337</text>
  <text x="640" y="292" font-size="9" fill="#94a3b8">:7338</text>
  <text x="640" y="308" font-size="9" fill="#94a3b8">:6514</text>
  <text x="640" y="324" font-size="9" fill="#94a3b8">:6943</text>
  <text x="640" y="340" font-size="9" fill="#94a3b8">:6700</text>
  <text x="640" y="356" font-size="9" fill="#94a3b8">:7163</text>
  <line x1="370" y1="370" x2="370" y2="398" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar103)"/>
  <rect x="190" y="398" width="360" height="38" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="370" y="415" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">layer_grouped_out_one</text>
  <text x="370" y="430" text-anchor="middle" font-size="10" fill="#64748b">8 组 → low 1024 → 4096</text>
  <text x="560" y="418" font-size="9" fill="#94a3b8">ds4.c:7164</text>
  <line x1="370" y1="436" x2="370" y2="464" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar103)"/>
  <rect x="190" y="464" width="360" height="38" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="370" y="481" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">hc_post_one</text>
  <text x="370" y="496" text-anchor="middle" font-size="10" fill="#64748b">注意力输出注入 HC 流</text>
  <text x="560" y="481" font-size="9" fill="#94a3b8">ds4.c:7166</text>
  <line x1="370" y1="502" x2="370" y2="530" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar103)"/>
  <rect x="240" y="530" width="260" height="26" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="370" y="547" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">inp_hc（更新后，送下一层）</text>
</svg>
<span class="figure-caption">图 T10.3 ｜ Prefill 注意力子层全流程：HC 预归一化 → Q/KV 低秩投影 → 逐 token RoPE + sink 注意力 → 分组输出投影 → HC 后注入</span>

<details>
<summary>ASCII 原版</summary>

```
inp_hc [n_tok, 4, 4096]
   |
   +-- hc_pre_norm_batch              (ds4.c:7225)
   |     归一化 HC、Sinkhorn 分配、提取 attn_cur + attn_norm
   |
   +-- matmul_q8_0_batch → qr        (ds4.c:7240)  [n_tok, 1024]
   +-- rms_norm per tok  → qr_norm   (ds4.c:7242)  [n_tok, 1024]
   +-- matmul_q8_0_batch → q         (ds4.c:7248)  [n_tok, 64×512]
   +-- head_rms_norm per tok          (ds4.c:7250)
   |
   +-- matmul_q8_0_batch → kv_raw    (ds4.c:7258)  [n_tok, 512]
   +-- rms_norm per tok  → kv        (ds4.c:7260)  [n_tok, 512]
   |
   for each token t:
     +-- rope_tail_layer_inplace(q_t)             (ds4.c:7337)
     +-- rope_tail_layer_inplace(kv_t)            (ds4.c:7338)
     +-- compressor_decode_one (压缩层)           (ds4.c:6514)
     +-- indexer_allowed_decode_one (ratio-4)     (ds4.c:6943)
     +-- layer_attention_mixed_one                (ds4.c:6700)
         sink logit + raw KV + 压缩 KV → heads
     +-- rope_tail_layer_inplace(heads, inverse)  (ds4.c:7163)
   |
   +-- layer_grouped_out_one                      (ds4.c:7164)
       8 组 → low 1024 → 4096
   |
   +-- hc_post_one                                (ds4.c:7166)
       注意力输出注入 HC 流
```

</details>

## 6. 代码位置

按阅读顺序：

- `ds4.c:4666` —— `layer_q_projection_normed_one()`：Q 低秩投影（单 token）。
  三步：`attn_q_a` → `q_a_norm` RMSNorm → `attn_q_b` → `head_rms_norm`。
- `ds4.c:4704` —— `layer_kv_projection_normed_one()`：KV 投影（单 token）。
  一步 `attn_kv` 后接学习 RMSNorm `attn_kv_a_norm`。
- `ds4.c:4763` —— `rope_tail_ext_inplace()`：只旋转尾部 `n_nope = head_dim - n_rot`
  之后的 64 维；`inverse=true` 时做逆旋转（用于输出投影前撤销 RoPE）。
- `ds4.c:4816` —— `layer_rope_freq_base()` / `layer_rope_freq_scale()`：
  dense 层用 base=10000，压缩层用 base=160000 + freq_scale=1/16。
- `ds4.c:4967` —— `layer_attention_rows_one()`：sink-aware softmax 核心。
  `denom = exp(sink_logit - max) + sum(exp(score_r - max))`，sink 只进分母。
- `ds4.c:6698` —— `layer_attention_mixed_one()`：同时处理 raw KV 行和压缩行；
  `comp_allowed` 为 `NULL` 时跳过 ratio-4 indexer 的屏蔽逻辑。
- `ds4.c:7179` —— `layer_attention_raw_swa_batch()`：prefill 批量注意力入口，
  含所有矩阵乘、逐 token RoPE、压缩器更新、prefill 注意力、输出投影。

## 7. 分支与延伸

- 本步的 KV 缓存结构（`raw_kv` + `attn_comp_kv`）在步骤 12 有详细讲解 →
  [第 7 章 KV 缓存](07-kv-cache.md)
- sink logit、低秩 Q、GQA-1 都是注意力子层的核心设计，完整参数表在 →
  [第 8 章 注意力子层](08-attention.md)
- `DS4_N_LAYER=43`、`DS4_N_HEAD=64`、`DS4_N_HEAD_DIM=512` 等模型超参与架构图 →
  [第 2 章 模型结构](02-model-architecture.md)
- 压缩层 RoPE base 为什么是 160000，以及 YaRN 插值的原理 →
  [第 8 章 注意力子层](08-attention.md)
- decode 阶段只有 1 个 token，走 `layer_attention_raw_swa_one()` 而非 batch 版本；
  该函数使用 `ds4_cpu_decode_scratch` 减少 malloc 开销 →
  [第 7 章 KV 缓存](07-kv-cache.md)
- Metal 后端的批量注意力用 GPU kernel 替代这里的 CPU 循环 →
  [第 8 章 注意力子层](08-attention.md)

## 8. 走完这一步你脑子里应该多了什么

1. Q 投影的"先压后展"：`4096 → 1024 → 32768`，中间加一个学习 RMSNorm，
   参数量比全秩方案少 **3.5 倍**，这是 MLA（Multi-head Latent Attention）的核心思路。
2. KV 只有 1 头（GQA-1）且宽度 512：每个 token 在每层只存 **2 KiB** KV，是
   让 1M 上下文在本地可行的第一道防线。
3. RoPE 只旋转每头尾部 64 维，前 448 维是 nope——位置信息和内容信息在维度上
   是分离的，不会互相干扰。
4. dense 层与压缩层使用不同的 RoPE 频率基数（10000 vs 160000），压缩层还叠加
   YaRN 频率插值，以应对超长上下文下的位置外推。
5. sink logit 是一个每头可学习的标量，进入 softmax 分母但不贡献 value，
   让模型可以学到"忽略所有已有 KV"的注意力权重分布。
