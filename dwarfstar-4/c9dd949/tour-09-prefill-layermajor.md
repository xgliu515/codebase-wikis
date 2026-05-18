# Trace 步骤 09 —— 为什么是"所有 token 走完一层"，而不是"一个 token 走完所有层"？

## 1. 当前情境

步骤 08 结束后：

```
s->prefill_cap = prompt_len    // 「你好」很短，一个 ubatch 够用
s->graph.raw_cap               // 已分配好，能容纳 SWA 窗口 + 一个 ubatch
batch_cur_hc[n_tok, 4, 4096]  // 所有 token 的 HC 状态已用 token embedding 种子
```

现在 `ds4_session_sync`（`ds4.c:17534`-17536）判断 `prefill_cap >= prompt_len`，
调用 `metal_graph_prefill_raw_swa`（`ds4.c:13483`），后者立刻转入
`metal_graph_prefill_layer_major`（`ds4.c:13224`）——这就是 prefill 真正的执行
入口。

这一步会把所有 prompt token 推过全部 43 层（`DS4_N_LAYER = 43`，`ds4.c:87`），
最终把最后一个 token 位置的 HC 状态传给 logits head，得到首个采样的分布。
同时，每一层的 raw SWA 缓存和压缩器状态都将被填满，供后续 decode 步骤使用。

---

## 2. 问题

Prefill 要把 N 个 token 推过 L 层网络。两个维度的遍历顺序有两种选择：

- **token-major**：先把 token 0 走完全部 43 层，再走 token 1，……
- **layer-major**：先让所有 N 个 token 都过第 0 层，再都过第 1 层，……

这两种顺序的数学结果完全相同（忽略 causal mask 时也不完全成立，但 prefill 里
causal attention 可以用 masked matmul 一次算完），但在硬件上的表现差异极大。
选错了轻则慢几倍，重则内存爆掉。

---

## 3. 朴素思路

"一个 token 走完所有层"——即 token-major 顺序——是最直觉的做法。
想象手工模拟一个 transformer：你会先把第一个词的向量喂进第 0 层的 attention
和 FFN，拿到它的第 0 层输出，再喂进第 1 层……直到第 43 层得到它的最终表示。
然后处理第二个词，以此类推。

这个思路和 decode（单 token 生成）阶段的工作方式完全一致，感觉自然。

---

## 4. 为什么朴素思路会崩

Token-major 在 prefill 场景有两个根本性的问题：

**问题 1：权重反复从内存搬入，无法复用**

DeepSeek V4 Flash 是一个 MoE 模型，每层的 FFN 权重有 256 个专家
（`DS4_N_EXPERT = 256`，`ds4.c:98`），量化后每个专家仍占几十 MB。
Token-major 时，处理 token 0 要把第 0 层所有专家权重从 DRAM 或统一内存搬入
GPU 计算单元，处理完丢弃；处理 token 1 又要搬一遍……N 个 token 就搬 N 遍。
L2/L3 缓存对几十 MB 的矩阵无能为力，每次都是冷读。

Layer-major 时，处理第 0 层：先把第 0 层所有权重搬进来，然后对所有 N 个 token
同时做 matmul。权重只搬一次，被 N 个 token 共享。这是**权重局部性**的核心收益。

**问题 2：无法利用批量 matmul**

GPU 的核心优势是 SIMD/SIMT 并行：给一个矩阵乘一批向量，远比给它乘 N 次单个向量
快——批量路径可以用 GEMM（General Matrix Multiply），而逐 token 路径只能用
GEMV（General Matrix-Vector multiply）。对于 4096 维的嵌入，批量 N=8 的 GEMM
吞吐量比 N=1 的 GEMV 高一个数量级以上。

Token-major 每次只有 1 个 token，必须用 GEMV；layer-major 把所有 N 个 token
合并成一个矩阵，天然适合 GEMM。

以 `你好` 的 prefill 举例：即便只有几个 token，layer-major 也避免了 43 × N 次
单独的权重读取，改为 43 次（每层一次），每次权重读取服务所有 token。

---

## 5. DwarfStar 4 的做法

Metal 路径的 layer-major prefill 主循环如下（`ds4.c:13262`-13273，短 prompt 非分
split_commands 路径）：

```text
upload HC seed  →  for il in [0, 43):
                       encode_layer_batch(il, all tokens)
                   →  encode_output_head(last token row)
                   →  end_commands  →  read logits
```

完整的调用链：

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Call tree for layer-major prefill: ds4_session_sync → metal_graph_prefill_raw_swa → metal_graph_prefill_layer_major with upload, layer loop, and output head steps">
  <defs>
    <marker id="ar91" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="14" width="210" height="30" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="125" y="33" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">ds4_session_sync</text>
  <line x1="125" y1="44" x2="125" y2="62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar91)"/>
  <rect x="20" y="62" width="310" height="30" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="175" y="79" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">metal_graph_prefill_raw_swa</text>
  <text x="340" y="79" font-size="10" fill="#94a3b8">ds4.c:13483</text>
  <line x1="175" y1="92" x2="175" y2="110" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar91)"/>
  <rect x="20" y="110" width="310" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="175" y="127" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">metal_graph_prefill_layer_major</text>
  <text x="340" y="127" font-size="10" fill="#94a3b8">ds4.c:13224</text>
  <line x1="60" y1="140" x2="60" y2="298" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <line x1="60" y1="158" x2="80" y2="158" stroke="#94a3b8" stroke-width="1"/>
  <rect x="80" y="144" width="240" height="26" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="200" y="161" text-anchor="middle" font-size="10" fill="currentColor">upload_prompt_tokens</text>
  <text x="330" y="161" font-size="10" fill="#94a3b8">ds4.c:13235</text>
  <line x1="60" y1="184" x2="80" y2="184" stroke="#94a3b8" stroke-width="1"/>
  <rect x="80" y="170" width="270" height="26" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="215" y="187" text-anchor="middle" font-size="10" fill="currentColor">upload_prompt_embeddings_hc</text>
  <text x="360" y="187" font-size="10" fill="#94a3b8">ds4.c:13254</text>
  <line x1="60" y1="210" x2="80" y2="210" stroke="#94a3b8" stroke-width="1"/>
  <rect x="80" y="198" width="220" height="24" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="190" y="214" text-anchor="middle" font-size="10" fill="currentColor">for il = 0 .. 42: encode_layer_batch</text>
  <text x="310" y="214" font-size="10" fill="#94a3b8">ds4.c:12757</text>
  <line x1="110" y1="222" x2="110" y2="270" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <line x1="110" y1="238" x2="130" y2="238" stroke="#94a3b8" stroke-width="1"/>
  <rect x="130" y="226" width="220" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="240" y="241" text-anchor="middle" font-size="10" fill="#64748b">encode_layer_attention_batch</text>
  <text x="360" y="241" font-size="10" fill="#94a3b8">ds4.c:11152</text>
  <line x1="110" y1="258" x2="130" y2="258" stroke="#94a3b8" stroke-width="1"/>
  <rect x="130" y="246" width="220" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="240" y="261" text-anchor="middle" font-size="10" fill="#64748b">encode_layer_ffn_batch</text>
  <text x="360" y="261" font-size="10" fill="#94a3b8">ds4.c:12498</text>
  <text x="130" y="284" font-size="10" fill="#0d9488">swap(batch_cur_hc, batch_next_hc)</text>
  <line x1="60" y1="296" x2="80" y2="296" stroke="#94a3b8" stroke-width="1"/>
  <rect x="80" y="284" width="200" height="24" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="180" y="300" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">encode_output_head（最后一行）</text>
  <text x="290" y="300" font-size="10" fill="#94a3b8">→ logits</text>
</svg>
<span class="figure-caption">图 T9.1 ｜ layer-major prefill 完整调用链：DS4 会话同步 → 原始 SWA → 分层主循环</span>

<details>
<summary>ASCII 原版</summary>

```
ds4_session_sync
  └─ metal_graph_prefill_raw_swa              ds4.c:13483
       └─ metal_graph_prefill_layer_major     ds4.c:13224
            ├─ upload_prompt_tokens           ds4.c:13235
            ├─ upload_prompt_embeddings_hc    ds4.c:13254   (HC 种子，步骤 08)
            ├─ begin_commands
            ├─ for il=0..42:
            │    encode_layer_batch           ds4.c:12757
            │      ├─ encode_layer_attention_batch  ds4.c:11152
            │      └─ encode_layer_ffn_batch        ds4.c:12498
            │    swap(batch_cur_hc, batch_next_hc)
            ├─ encode_output_head             (最后一行)
            └─ end_commands → read logits
```

</details>

两个关键的数据流动细节：

**1. batch_cur_hc / batch_next_hc 双缓冲 ping-pong**

`batch_cur_hc` 是当前层的输入，`batch_next_hc` 是当前层的输出。每层编码完成后
（`ds4.c:12768`-12771）执行指针交换：

```c
ds4_gpu_tensor *tmp = g->batch_cur_hc;
g->batch_cur_hc = g->batch_next_hc;
g->batch_next_hc = tmp;
```

这样 `batch_cur_hc` 始终指向「最新的激活」，无需拷贝。

**2. raw SWA 缓存和压缩器状态在 attention batch 里逐层填满**

`metal_graph_encode_layer_attention_batch`（`ds4.c:11152`）会把所有 token 的
KV 向量写入 raw SWA 缓存（`g->layer_raw_kv`），并——对于有压缩器的层——同步更新
压缩器的 KV 状态和累积得分（`g->layer_attn_state_kv` / `g->layer_attn_state_score`）。
43 层全部跑完后，raw SWA 里已经有 prompt 全部 token 的 KV 行，压缩器状态也已
根据 prompt 完整更新。

**整体数据流示意：**

<svg viewBox="0 0 760 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Layer-major prefill data flow: tokens columns processed row by row through attention and FFN for each of 43 layers, writing KV to raw SWA and updating HC buffers">
  <defs>
    <marker id="ar92" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="200" y="20" text-anchor="middle" font-size="11" fill="#64748b">token 0</text>
  <text x="290" y="20" text-anchor="middle" font-size="11" fill="#64748b">token 1</text>
  <text x="380" y="20" text-anchor="middle" font-size="11" fill="#64748b">…</text>
  <text x="470" y="20" text-anchor="middle" font-size="11" fill="#64748b">token N-1</text>
  <text x="20" y="52" font-size="11" font-weight="600" fill="#ea580c">layer 0</text>
  <rect x="160" y="36" width="80" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="200" y="52" text-anchor="middle" font-size="10" fill="currentColor">KV0_0</text>
  <rect x="250" y="36" width="80" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="290" y="52" text-anchor="middle" font-size="10" fill="currentColor">KV0_1</text>
  <text x="380" y="52" text-anchor="middle" font-size="11" fill="#94a3b8">…</text>
  <rect x="430" y="36" width="80" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="470" y="52" text-anchor="middle" font-size="10" fill="currentColor">KV0_N</text>
  <text x="526" y="52" font-size="10" fill="#64748b">→ raw SWA[0]</text>
  <rect x="160" y="66" width="80" height="24" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="200" y="82" text-anchor="middle" font-size="10" fill="currentColor">HC0_0</text>
  <rect x="250" y="66" width="80" height="24" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="290" y="82" text-anchor="middle" font-size="10" fill="currentColor">HC0_1</text>
  <text x="380" y="82" text-anchor="middle" font-size="11" fill="#94a3b8">…</text>
  <rect x="430" y="66" width="80" height="24" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="470" y="82" text-anchor="middle" font-size="10" fill="currentColor">HC0_N</text>
  <text x="526" y="82" font-size="10" fill="#7c3aed">→ batch_next_hc</text>
  <line x1="30" y1="100" x2="680" y2="100" stroke="#0d9488" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="380" y="113" text-anchor="middle" font-size="10" fill="#0d9488">swap(batch_cur_hc, batch_next_hc)</text>
  <text x="20" y="140" font-size="11" font-weight="600" fill="#ea580c">layer 1</text>
  <rect x="160" y="124" width="80" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="200" y="140" text-anchor="middle" font-size="10" fill="currentColor">KV1_0</text>
  <rect x="250" y="124" width="80" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="290" y="140" text-anchor="middle" font-size="10" fill="currentColor">KV1_1</text>
  <text x="380" y="140" text-anchor="middle" font-size="11" fill="#94a3b8">…</text>
  <rect x="430" y="124" width="80" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="470" y="140" text-anchor="middle" font-size="10" fill="currentColor">KV1_N</text>
  <text x="526" y="140" font-size="10" fill="#64748b">→ raw SWA[1]</text>
  <rect x="160" y="154" width="80" height="24" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="200" y="170" text-anchor="middle" font-size="10" fill="currentColor">HC1_0</text>
  <rect x="250" y="154" width="80" height="24" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="290" y="170" text-anchor="middle" font-size="10" fill="currentColor">HC1_1</text>
  <text x="380" y="170" text-anchor="middle" font-size="11" fill="#94a3b8">…</text>
  <rect x="430" y="154" width="80" height="24" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="470" y="170" text-anchor="middle" font-size="10" fill="currentColor">HC1_N</text>
  <text x="526" y="170" font-size="10" fill="#7c3aed">→ batch_next_hc</text>
  <text x="380" y="210" text-anchor="middle" font-size="14" fill="#94a3b8">⋮</text>
  <text x="380" y="228" text-anchor="middle" font-size="10" fill="#94a3b8">（层 2 … 41，结构相同）</text>
  <text x="20" y="262" font-size="11" font-weight="600" fill="#ea580c">layer 42</text>
  <rect x="160" y="246" width="80" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="200" y="262" text-anchor="middle" font-size="10" fill="currentColor">KV42_0</text>
  <rect x="250" y="246" width="80" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="290" y="262" text-anchor="middle" font-size="10" fill="currentColor">KV42_1</text>
  <text x="380" y="262" text-anchor="middle" font-size="11" fill="#94a3b8">…</text>
  <rect x="430" y="246" width="80" height="24" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="470" y="262" text-anchor="middle" font-size="10" fill="currentColor">KV42_N</text>
  <text x="526" y="262" font-size="10" fill="#64748b">→ raw SWA[42]</text>
  <rect x="160" y="276" width="80" height="24" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="200" y="292" text-anchor="middle" font-size="10" fill="currentColor">HC42_0</text>
  <rect x="250" y="276" width="80" height="24" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="290" y="292" text-anchor="middle" font-size="10" fill="currentColor">HC42_1</text>
  <text x="380" y="292" text-anchor="middle" font-size="11" fill="#94a3b8">…</text>
  <rect x="430" y="276" width="80" height="24" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/>
  <text x="470" y="292" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">HC42_{N-1}</text>
  <text x="526" y="292" font-size="10" fill="#ea580c">← 取末行</text>
  <line x1="30" y1="312" x2="680" y2="312" stroke="#ea580c" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="380" y="325" text-anchor="middle" font-size="10" fill="#ea580c">取最后行 → output head</text>
  <line x1="470" y1="300" x2="470" y2="350" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar92)"/>
  <rect x="380" y="350" width="180" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="470" y="369" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">logits[vocab_size]</text>
</svg>
<span class="figure-caption">图 T9.2 ｜ Layer-major prefill 数据流：每层先写 KV 至 raw SWA，再更新 HC 双缓冲，最终取末 token 行输出 logits</span>

<details>
<summary>ASCII 原版</summary>

```
                  token 0  token 1  ...  token N-1
layer 0 attn:  [  KV0_0    KV0_1   ...   KV0_N  ]  → 写入 raw SWA[layer 0]
layer 0 ffn:   [ HC0_0    HC0_1   ...   HC0_N  ]  → batch_next_hc
               ────────────────────────────────── swap ──
layer 1 attn:  [  KV1_0    KV1_1   ...   KV1_N  ]  → 写入 raw SWA[layer 1]
layer 1 ffn:   [ HC1_0    HC1_1   ...   HC1_N  ]  → batch_next_hc
               ...
layer 42 attn: [  KV42_0   KV42_1  ...  KV42_N  ]  → 写入 raw SWA[layer 42]
layer 42 ffn:  [ HC42_0   HC42_1  ...  HC42_N  ]  → batch_cur_hc
               ────────────────────────────────── 取最后行 ──
output head:   HC42_{N-1}  →  logits[vocab_size]
```

</details>

**CPU 路径的等价逻辑**（`ds4.c:7761`）可作对照阅读：

```c
// 先种子所有 token 的 HC
for t in [0, n_tok): embed + hc_from_plain_embedding(cur[t])

// 逐层推进
for il in [0, n_layer):
    layer_attention_raw_swa_batch(attn, cur, n_tok, il)
    layer_ffn_shared_batch(next, attn, n_tok, il)
    swap(cur, next)

// 取最后 token 输出 logits
output_logits_one(logits, cur[n_tok - 1])
```

结构与 Metal 路径完全一致，双缓冲交换、逐层遍历、最后取末行，只是执行在 CPU 上。

---

## 6. 代码位置

按阅读顺序：

- `ds4.c:17534` —— `ds4_session_sync`（Metal 路径），判断是否整批 prefill 并调用
  `metal_graph_prefill_raw_swa`。
- `ds4.c:13483` —— `metal_graph_prefill_raw_swa`：简单校验后转 layer-major 入口。
- `ds4.c:13224` —— `metal_graph_prefill_layer_major`：layer-major 执行主体，
  含短 prompt 单命令缓冲区路径（`ds4.c:13253`-13325）和长 prompt
  逐层提交路径（`ds4.c:13354`-13428）。
- `ds4.c:12757` —— `metal_graph_encode_layer_batch`：编码完整一层（attention +
  FFN），执行 `batch_cur_hc / batch_next_hc` 指针交换。
- `ds4.c:11152` —— `metal_graph_encode_layer_attention_batch`：批量 attention，
  向 raw SWA 写 KV、更新压缩器状态。
- `ds4.c:12498` —— `metal_graph_encode_layer_ffn_batch`：批量 MoE FFN，读
  `batch_after_attn_hc`，写 `batch_next_hc`。
- `ds4.c:7761` —— `prefill_layer_major_cpu`：CPU 参考实现，逻辑结构与 Metal
  路径一一对应，适合理解双缓冲与逐层遍历的抽象语义。
- `ds4.c:13521` —— `metal_graph_prefill_chunked_range`：当 `prefill_cap < n_tokens`
  时使用的分块路径，每块内部同样是一次 layer-major 前向。

---

## 7. 分支与延伸

- **每层 attention 子层的内部细节**——低秩 Q/KV 投影、仅尾部 RoPE、如何把
  所有 token 的 KV 写入 raw SWA——见
  [第 10 章 Metal](10-metal-backend.md)。

- **每层 FFN/MoE 的内部细节**——HC pre 变换、哈希路由 vs 偏置 top-k、IQ2_XXS
  专家、共享专家——见
  [第 9 章 超连接与 MoE](09-moe-hyperconnections.md)。

- **raw SWA 缓存如何在 prefill 后支撑 decode**——prefill 把全部 token 的 KV
  写入 raw SWA，decode 每步追加一行，当行数超出 SWA 窗口时旧行被淘汰或压缩——
  见 [第 7 章 KV 缓存](07-kv-cache.md)。

- **长 prompt 的分块 prefill**——当 prompt 超过 2048 token 时，`session_sync`
  走 `metal_graph_prefill_chunked`，每块单独做一次 layer-major 前向，块间通过
  `raw_cap` 对齐保证压缩窗口调度正确——见
  [第 6 章 引擎与会话](06-engine-session.md) 和
  [第 10 章 Metal](10-metal-backend.md)。

- **为什么短 prompt 走单命令缓冲区而长 prompt 逐层提交**——macOS watchdog 对
  长时间占用 GPU 的命令缓冲区有超时保护，超过 2048 token 的 prefill 如果放进
  单个命令缓冲区可能触发 WindowServer 看门狗（`ds4.c:13242`-13247）；逐层提交
  把每层编码为独立的命令缓冲区，给系统以调度机会——见
  [第 10 章 Metal §命令缓冲区调度](10-metal-backend.md)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **Layer-major 是 prefill 的唯一合理选择**。它让每层权重只从内存搬一次，服务
   所有 token，将 GEMV 升级为 GEMM，是权重局部性和批量 matmul 效率的共同要求。

2. **双缓冲 ping-pong 是激活流动的核心机制**。`batch_cur_hc` / `batch_next_hc`
   轮流充当输入和输出缓冲区，每层完成后只需交换指针，无需拷贝激活数据。

3. **prefill 结束后 raw SWA + 压缩器状态已完全就绪**。43 层全部运行完毕时，
   raw SWA 里存有所有 prompt token 的 KV，压缩器状态也已根据 prompt 更新。
   decode 阶段直接在这个状态上续接，不需要重新计算任何历史 KV。

4. **logits 只取最后一个 token 的输出**。`batch_cur_hc` 里有 N 行，但
   `encode_output_head` 只对最后一行（`output_row = n_tokens - 1`，`ds4.c:13432`）
   做 HC collapse 和词表投影，其余行的计算结果在 prefill 里仅用于填 KV 缓存
   和传播激活，不产生 logits。

5. **短 prompt（不超过 2048）走单命令缓冲区**，避免了命令缓冲区创建/提交的开销；
   长 prompt 逐层提交，规避 macOS watchdog 超时。这条分支逻辑在
   `metal_graph_prefill_layer_major`（`ds4.c:13247`）里通过 `split_commands` 标志控制。
