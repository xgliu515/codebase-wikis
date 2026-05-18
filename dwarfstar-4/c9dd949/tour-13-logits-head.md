# Trace 步骤 13 —— 43 层走完，怎么从 HC 流变出一排词表分数？

## 1. 当前情境

所有 prompt token（「你好」对应的 token 序列）已经走完全部 43 层。对于 Metal
路径，`batch_cur_hc` GPU 缓冲里存放着每个 prompt token 对应的 HC 流——每个 token
的状态是一个 `DS4_N_HC × DS4_N_EMBD = 4 × 4096` 的 float 矩阵，共 16 384 个
float。所有层的 raw SWA 缓存和压缩器状态已全部写入，prefill 前向至此完成。

现在还缺什么？模型的最终目标是给出「下一个 token 是什么」的概率分布，而这需要
一个 `DS4_N_VOCAB = 129 280` 维的分数向量（logits）。HC 流是内部表示，必须先
把它折叠成一个普通的 4096 维 embedding，再经 RMSNorm 归一化，最后投影到词表
维度。

关键的第一个问题是：43 层走完后有多个 prompt token 的 HC 流，要对哪一行做
logits 头计算？

## 2. 问题

这一步要解决两件事：

1. **选行**：prefill 批量处理了所有 prompt token，但只需要最后一个 token 的
   logits——它预测的才是紧接在 prompt 之后该出现的 token。算所有行既浪费 GPU
   时间，又会输出多余向量，采样器无法直接用。
2. **折叠 HC 流**：4 条 HC 流是并行的残差通道，不能直接送进词表投影矩阵。需要
   一个可学习的加权合并步骤把它们收敛成一个向量，然后才能走 RMSNorm + LM head。

## 3. 朴素思路

最直接的想法：prefill 结束后对每个 token 都算一次 logits，然后只取最后一行。
折叠 HC 时，既然有 4 条流，简单地加总或取均值就行，加上 RMSNorm 后做矩阵乘法
投影到词表。

## 4. 为什么朴素思路会崩

- **对所有行算 logits 太贵**：「你好」只有几个 token，但对于长 prompt（数千
  token）来说，词表投影是 `4096 × 129 280` 的矩阵乘法，每行约 10.6 亿次乘加。
  多余的行不会被用到，等同于白白扔掉时间和带宽。Metal GPU 路径已经明确只对
  `output_row = n_tokens - 1` 做视图（`ds4.c:13277`），这正是"只算最后一行"的
  硬编码证据。
- **均值合并丢失方向信息**：HC 流不是等权的，它们在每一层分别承担不同的残差
  权重（这由 Sinkhorn split 学得）。输出时同样需要一个**可学习的**合并权重，
  而不是固定的算术均值。用固定均值等价于把模型对各流的学习全部抛弃。

## 5. DwarfStar 4 的做法

整个输出头分三步，CPU 和 Metal 路径逻辑一致，只是 CPU 版以函数调用链实现，
Metal 版把所有步骤编码进一个 command buffer：

<svg viewBox="0 0 760 500" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Output head pipeline: row selection from batch HC, HC collapse with sigmoid gating, RMSNorm, Q8_0 vocab projection to logits">
  <defs>
    <marker id="ar13a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="230" y="10" width="300" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/>
  <text x="380" y="27" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">batch_cur_hc</text>
  <text x="380" y="40" text-anchor="middle" font-size="10" fill="#64748b">n_tokens × 4 × 4096 float  GPU 缓冲</text>
  <line x1="380" y1="44" x2="380" y2="68" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar13a)"/>
  <rect x="230" y="68" width="300" height="26" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="380" y="85" text-anchor="middle" font-size="11" fill="#64748b">取行视图：output_row = n_tokens − 1</text>
  <line x1="380" y1="94" x2="380" y2="114" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar13a)"/>
  <rect x="260" y="114" width="240" height="26" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="131" text-anchor="middle" font-size="11" fill="currentColor">last_hc  (1 × 4 × 4096 float)</text>
  <rect x="60" y="150" width="640" height="140" rx="8" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="168" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">步骤 A：HC collapse</text>
  <line x1="380" y1="140" x2="380" y2="150" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar13a)"/>
  <rect x="80" y="174" width="280" height="22" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="220" y="188" text-anchor="middle" font-size="10" fill="#64748b">1. flat_hc = RMSNorm(last_hc, dim=4×4096)  去量纲</text>
  <rect x="80" y="202" width="280" height="22" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="220" y="216" text-anchor="middle" font-size="10" fill="#64748b">2. output_pre = flat_hc @ output_hc_fn  (F16, 4096→4)</text>
  <rect x="80" y="230" width="280" height="22" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="220" y="244" text-anchor="middle" font-size="10" fill="#64748b">3. w[i] = sigmoid(pre[i]×scale + base[i]) + HC_EPS</text>
  <rect x="80" y="258" width="280" height="22" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="220" y="272" text-anchor="middle" font-size="10" fill="#64748b">4. output_embd = Σᵢ w[i] × last_hc[i]   → 4096 维</text>
  <line x1="390" y1="174" x2="660" y2="174" stroke="#cbd5e1" stroke-width="1"/>
  <text x="530" y="188" text-anchor="middle" font-size="10" fill="#94a3b8">投影到 n_hc=4 维控制空间</text>
  <text x="530" y="216" text-anchor="middle" font-size="10" fill="#94a3b8">可学习标量门控，保证 w[i] &gt; 0</text>
  <text x="530" y="244" text-anchor="middle" font-size="10" fill="#94a3b8">4 条 HC 流加权线性组合</text>
  <line x1="380" y1="290" x2="380" y2="314" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar13a)"/>
  <rect x="240" y="314" width="280" height="26" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="331" text-anchor="middle" font-size="11" fill="currentColor">output_embd  (4096 float)</text>
  <rect x="60" y="350" width="640" height="36" rx="6" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="200" y="368" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">步骤 B：输出 RMSNorm</text>
  <text x="490" y="368" text-anchor="middle" font-size="10" fill="#64748b">output_norm = RMSNorm(output_embd, weight=output_norm_w)</text>
  <line x1="380" y1="340" x2="380" y2="350" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar13a)"/>
  <line x1="380" y1="386" x2="380" y2="406" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar13a)"/>
  <rect x="240" y="406" width="280" height="26" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="423" text-anchor="middle" font-size="11" fill="currentColor">output_norm  (4096 float，已归一化)</text>
  <rect x="60" y="442" width="640" height="30" rx="6" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="200" y="460" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">步骤 C：Q8_0 词表投影</text>
  <text x="490" y="460" text-anchor="middle" font-size="10" fill="#64748b">logits = output_norm @ output  (Q8_0, 4096→129280)</text>
  <line x1="380" y1="432" x2="380" y2="442" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar13a)"/>
  <line x1="380" y1="472" x2="380" y2="486" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar13a)"/>
  <rect x="250" y="486" width="260" height="12" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="496" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">logits  (129280 float  读回 CPU / session.logits)</text>
</svg>
<span class="figure-caption">图 T13.1 ｜ 输出头三步流水线：行选取 → HC collapse（sigmoid 门控加权求和）→ RMSNorm → Q8_0 词表投影</span>

<details>
<summary>ASCII 原版</summary>

```
  batch_cur_hc  (n_tokens × 4 × 4096 float，GPU 缓冲)
        |
        |  取行视图：output_row = n_tokens - 1
        v
  last_hc  (1 × 4 × 4096 float)
        |
        +------ 步骤 A：HC collapse --------------------------------+
        |                                                           |
        |  1. flat_hc = RMSNorm(last_hc, dim=4×4096)              |
        |     (去量纲，方便后面线性投影)                             |
        |  2. output_pre = flat_hc @ output_hc_fn   (F16, 4096→4) |
        |     (把扁平 HC 投到 n_hc=4 维控制空间)                    |
        |  3. w[i] = sigmoid(pre[i]*scale + base[i]) + HC_EPS      |
        |     (可学习的标量门控，保证 w[i] > 0)                     |
        |  4. output_embd = Σ_i w[i] * last_hc[i]                  |
        |     (按权重对 4 条 HC 流做加权求和，结果为 4096 维)        |
        +-----------------------------------------------------------+
        |
        v
  output_embd  (4096 float)
        |
        +------ 步骤 B：输出 RMSNorm --------------------------------+
        |  output_norm = RMSNorm(output_embd, weight=output_norm_w)  |
        +-----------------------------------------------------------+
        |
        v
  output_norm  (4096 float，已归一化)
        |
        +------ 步骤 C：Q8_0 词表投影 ------------------------------+
        |  logits = output_norm @ output  (Q8_0, 4096→129280)       |
        +-----------------------------------------------------------+
        |
        v
  logits  (129280 float，读回 CPU / session.logits)
```

</details>

**为什么只算最后一行**：语言模型的输出语义是「在看到位置 t 之前所有 token 后，
位置 t 应该是什么」。prefill 中对第 0..T-2 行算 logits 没有意义——它们预测的
是 prompt 内部已知的 token，对生成没有贡献，纯属浪费。Metal 路径中：

```c
// ds4.c:13277
uint32_t output_row = (uint32_t)n_tokens - 1u;
// ...
last_hc = metal_graph_tensor_row_view(g->batch_cur_hc, output_row, hc_dim);
g->cur_hc = last_hc;
ok = metal_graph_encode_output_head(g, model, weights, weights->output->dim[1]);
```

CPU 路径同理，在 `ds4.c:7914`：

```c
output_logits_one(logits, model, weights, cur + (n_tok - 1) * hc_dim);
```

`n_tok - 1` 正是最后一个 prompt token 的下标。

**HC collapse 细节**（`ds4.c:8006-8033`）：`output_hc_head_one` 的核心是
`hc_weighted_sum_one`（`ds4.c:4339`），它对每个 embedding 维度 `d` 做：

```
out[d] = Σ_{h=0}^{3} w[h] * last_hc[h * 4096 + d]
```

其中 `w[h]` 由 sigmoid 门控学得，加上 `DS4_HC_EPS = 1e-6f` 保证数值稳定。

**词表投影用 Q8_0**（`ds4.c:8047`）：`output` 权重张量是
`DS4_N_EMBD × DS4_N_VOCAB = 4096 × 129280`，以 Q8_0 量化存储
（`ds4.c:2368` 的 `tensor_expect_layout` 校验）。Q8_0 保留足够精度同时降低
带宽占用，是 DS4 Flash 词表投影的默认精度。

**Metal 编码函数**（`ds4.c:9980`）：`metal_graph_encode_output_head` 按顺序
调用六个 GPU 算子：RMSNorm（无权重）、F16 matmul（HC→4）、
`ds4_gpu_output_hc_weights_tensor`（sigmoid 门控）、HC 加权求和、
RMSNorm（带权重）、Q8_0 matmul（4096→129280）。结果写入 `g->logits`，
之后由 `ds4_gpu_tensor_read` 读回 CPU 的 `session.logits` 数组
（`ds4.c:13312`）。

## 6. 代码位置

按推荐阅读顺序：

- `ds4.c:7914` —— CPU prefill 输出头入口：`output_logits_one(..., cur + (n_tok-1) * hc_dim)`，只算最后一行。
- `ds4.c:13277` —— Metal layer-major prefill 取最后一行视图 `output_row = n_tokens - 1`。
- `ds4.c:13441-13450` —— Metal 层主序路径：`metal_graph_tensor_row_view` 后调 `metal_graph_encode_output_head`。
- `ds4.c:8006` —— `output_hc_head_one`：HC collapse 实现（RMSNorm-flat → F16投影 → sigmoid门控 → 加权求和）。
- `ds4.c:8035` —— `output_logits_one`：三步组合（HC collapse、RMSNorm、Q8_0投影）的 CPU 顶层入口。
- `ds4.c:4339` —— `hc_weighted_sum_one`：4 条 HC 流加权求和内核。
- `ds4.c:9980` —— `metal_graph_encode_output_head`：Metal 端六步算子编码。
- `ds4.c:13312` —— `ds4_gpu_tensor_read` 把 logits 读回 CPU 的 `session.logits`。
- `ds4.c:2368` —— `tensor_expect_layout(w->output, DS4_TENSOR_Q8_0, 2, DS4_N_EMBD, DS4_N_VOCAB, 0)`：校验词表投影矩阵为 Q8_0。

## 7. 分支与延伸

- HC 流在每一层如何被维护、Sinkhorn split 如何决定各流的权重，以及本步的
  collapse 为什么是 sigmoid 门控而非 Sinkhorn，参见
  [第 9 章 超连接与 MoE](09-moe-hyperconnections.md)。
- 词表投影权重的量化格式（Q8_0）及其与注意力层 Q8_0 投影的差异，参见
  [第 2 章 模型结构](02-model-architecture.md)。
- Metal 端的六步输出头编码算子（`ds4_gpu_rms_norm_plain_tensor`、
  `ds4_gpu_matmul_f16_tensor`、`ds4_gpu_output_hc_weights_tensor`、
  `ds4_gpu_hc_weighted_sum_tensor`、`ds4_gpu_rms_norm_weight_tensor`、
  `ds4_gpu_matmul_q8_0_tensor`）的底层实现与 MTL shader，参见
  [第 10 章 Metal 后端](10-metal-backend.md)。
- 推测解码（MTP）场景下需要对批量行都算 logits，此时走
  `metal_graph_encode_output_head_batch`（`ds4.c:10050`），参见
  [第 12 章 推测解码与 MTP](12-speculative-mtp.md)。

## 8. 走完这一步你脑子里应该多了什么

1. prefill 结束后只对 **最后一个 prompt token** 的 HC 流算 logits——下标
   `n_tokens - 1`；对其余行算 logits 既无意义又浪费，Metal 和 CPU 两条路径都
   明确跳过。
2. HC collapse 不是简单求和，而是一个**可学习的 sigmoid 门控加权求和**：先把
   扁平化的 HC 流 RMSNorm 后投影到 4 维控制空间，经 sigmoid 得到 4 个标量权重，
   再对 4 条 HC 流做加权线性组合，结果为 4096 维普通 embedding。
3. 折叠后需要再做一次**带权重的 RMSNorm**（区别于 collapse 内部的无权重
   RMSNorm），这是 Transformer 的标准输出归一化，让 LM head 的输入量级稳定。
4. 词表投影矩阵 `output` 以 **Q8_0** 量化（4096 × 129280），兼顾精度与带宽；
   量化格式在模型加载时由 `tensor_expect_layout` 校验，跑偏会立即报错。
5. Metal 路径将六步输出头操作编码进同一个 command buffer，避免中间结果回读到
   CPU，读回只在最后一步（`ds4_gpu_tensor_read`）发生一次。
