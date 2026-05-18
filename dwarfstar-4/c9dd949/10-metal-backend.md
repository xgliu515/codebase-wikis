# 第 10 章：Metal 后端

> 代码版本：antirez/ds4@c9dd949（2026-05-18）

---

## 目录

1. [整模型图理念](#1-整模型图理念)
2. [文件布局与职责边界](#2-文件布局与职责边界)
3. [Metal Kernel 文件分类](#3-metal-kernel-文件分类)
4. [ds4_gpu_graph：整模型图状态](#4-ds4_gpu_graph整模型图状态)
5. [分配与释放：`metal_graph_alloc_raw_cap` / `metal_graph_free`](#5-分配与释放)
6. [单 Token Decode 流水线](#6-单-token-decode-流水线)
7. [最终输出头：HC Collapse + Norm + 词表投影](#7-最终输出头)
8. [批量 Prefill 流水线](#8-批量-prefill-流水线)
9. [分块 Prefill](#9-分块-prefill)
10. [Prefill Ubatch 大小选择](#10-prefill-ubatch-大小选择)
11. [上传 Prompt Token Id](#11-上传-prompt-token-id)
12. [关键常量与调试环境变量](#12-关键常量与调试环境变量)

---

## 1. 整模型图理念

ds4 的 Metal 路径不使用动态节点图（如 Metal Performance Shaders Graph 或 llama.cpp 的 ggml 计算图）。取而代之，`ds4.c` 内的图调度器直接按固定顺序调用 `ds4_gpu.h` 中声明的原语，每个原语对应一次 `[encoder setComputePipelineState:...]` + `[encoder dispatchThreadgroups:...]`。整个模型由两条"磁带"组成：

<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Decode tape vs Prefill tape showing the two fixed-order GPU execution sequences">
  <defs>
    <marker id="ar-r10-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="10" width="340" height="260" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <rect x="20" y="10" width="340" height="36" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="190" y="33" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">Decode 磁带（单 token）</text>
  <rect x="40" y="60" width="300" height="34" rx="4" fill="#fff7ed" stroke="#ea580c" stroke-width="1"/>
  <text x="190" y="82" text-anchor="middle" font-size="11" fill="#64748b">embed_token_hc</text>
  <line x1="190" y1="94" x2="190" y2="112" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r10-1)"/>
  <rect x="40" y="112" width="300" height="50" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="190" y="131" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">for il in 0..42:</text>
  <text x="190" y="149" text-anchor="middle" font-size="11" fill="#64748b">decode_layer(il)　metal_graph_encode_decode_layer</text>
  <line x1="190" y1="162" x2="190" y2="180" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r10-1)"/>
  <rect x="40" y="180" width="300" height="40" rx="4" fill="#fff7ed" stroke="#ea580c" stroke-width="1"/>
  <text x="190" y="198" text-anchor="middle" font-size="11" fill="#64748b">encode_output_head</text>
  <text x="190" y="213" text-anchor="middle" font-size="10" fill="#94a3b8">HC collapse + norm + lm_head</text>
  <rect x="400" y="10" width="340" height="260" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <rect x="400" y="10" width="340" height="36" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="570" y="33" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">Prefill 磁带（批量 token）</text>
  <rect x="420" y="60" width="300" height="34" rx="4" fill="#f0fdfa" stroke="#0d9488" stroke-width="1"/>
  <text x="570" y="82" text-anchor="middle" font-size="11" fill="#64748b">upload_prompt_tokens + upload_embeddings_hc</text>
  <line x1="570" y1="94" x2="570" y2="112" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r10-1)"/>
  <rect x="420" y="112" width="300" height="50" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="570" y="131" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">for il in 0..42:</text>
  <text x="570" y="149" text-anchor="middle" font-size="11" fill="#64748b">encode_layer_batch(il)　attn_batch + ffn_batch</text>
  <line x1="570" y1="162" x2="570" y2="180" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r10-1)"/>
  <rect x="420" y="180" width="300" height="40" rx="4" fill="#f0fdfa" stroke="#0d9488" stroke-width="1"/>
  <text x="570" y="198" text-anchor="middle" font-size="11" fill="#64748b">encode_output_head</text>
  <text x="570" y="213" text-anchor="middle" font-size="10" fill="#94a3b8">HC collapse + norm + lm_head</text>
</svg>
<span class="figure-caption">图 R10.1 ｜ Decode 与 Prefill 两条执行磁带：固定顺序的 GPU kernel 序列，共享 output head 步骤</span>

<details>
<summary>ASCII 原版</summary>

```
Decode 磁带（单 token）
  embed_token_hc
  for il in 0..42:
      decode_layer(il)          ← metal_graph_encode_decode_layer
  encode_output_head            ← HC collapse + norm + lm_head

Prefill 磁带（批量 token）
  upload_prompt_tokens + upload_embeddings_hc
  for il in 0..42:
      encode_layer_batch(il)    ← attn_batch + ffn_batch
  encode_output_head
```

</details>

这种固定顺序带来几个好处：

- **可预测的内存占用**：所有中间张量在 `metal_graph_alloc_raw_cap` 时一次性分配，生命期等于会话生命期，不存在运行时动态分配。
- **CPU/GPU 重叠**：`metal_graph_encode_token_raw_swa` 在编码前 4 层后调用 `ds4_gpu_flush_commands()`（`ds4.c:10863`），让 GPU 开始执行前缀同时 CPU 继续编码后续层。
- **容易诊断**：每个 `ds4_gpu_*_tensor` 调用都对应一个命名明确的张量，调试时只需在 `metal_graph_debug_dump_tensor` 里打印就能逐层追踪。

---

## 2. 文件布局与职责边界

| 文件 | 行数 | 职责 |
|------|------|------|
| `ds4_metal.m` | 14721 | Objective-C Metal 运行时：设备/队列/库初始化、`MTLBuffer` 包装、pipeline state 缓存、所有 `ds4_gpu_*_tensor` 函数实现 |
| `ds4_gpu.h` | 811 | C/Objective-C 共享头：`ds4_gpu_tensor` 不透明指针声明 + 全部原语函数签名 |
| `ds4.c` | 18403 | 模型语义与图调度：`ds4_gpu_graph` 结构体定义、分配/释放、decode/prefill 编码循环、推测解码状态机 |
| `metal/` | — | `.metal` kernel 源文件（见第 3 节） |

**职责切割原则**：`ds4_metal.m` 只知道 `MTLBuffer`，不知道层号；`ds4.c` 只知道 `ds4_gpu_tensor *`，不知道 `MTLBuffer`。这个边界让 CUDA 后端（`ds4_cuda.cu`）能以 `extern "C"` 实现完全相同的 C API，而无需修改 `ds4.c`。

`ds4_gpu.h:16` 对这一设计的说明：

```c
/* The public GPU API is tensor-resident: activations, KV state, and scratch
 * buffers stay device-owned across the whole prefill/decode command sequence. */
typedef struct ds4_gpu_tensor ds4_gpu_tensor;
```

命令批量的三个生命周期调用（`ds4_gpu.h:34-37`）：

```c
int ds4_gpu_begin_commands(void);
int ds4_gpu_flush_commands(void);   // 提交当前批次但不等待
int ds4_gpu_end_commands(void);     // 提交并等待 GPU 完成
int ds4_gpu_synchronize(void);      // 纯同步，不涉及命令编码
```

Metal 实现将这四个函数映射到 `MTLCommandBuffer` 的生命周期管理。

---

## 3. Metal Kernel 文件分类

`metal/` 目录下共 19 个 `.metal` 文件，按功能分为四组：

### 3.1 注意力组

| 文件 | 核心 kernel | 说明 |
|------|------------|------|
| `flash_attn.metal` | `flash_attn_ext`（多变体） | Prefill 阶段对当前 ubatch 内部做 Flash Attention；使用 `FC_FLASH_ATTN_EXT_*` 宏区分 padding/block/vec/reduce 变体 |
| `dsv4_kv.metal` | `dsv4_fp8_kv_quantize`、`dsv4_kv_fp8_store` | FP8（E4M3 / E2M1）KV 量化与存储；`kv_fp8_store` 是 decode 融合路径，一次 dispatch 完成 FP8 round-trip 并写入 raw cache |
| `dsv4_rope.metal` | `rope_tail_batch` | DS4 的"尾部 RoPE"：只对 head_dim 的后 `n_rot` 个维度做旋转位置编码，前缀保持不变 |

### 3.2 HC（Hyper-Connection）组

| 文件 | 核心 kernel | 说明 |
|------|------------|------|
| `dsv4_hc.metal` | `hc_split_sinkhorn`、`hc_split_weighted_sum`、`hc_split_weighted_sum_norm`、`hc_weighted_sum`、`hc_expand`等 | 四路残差流的分离/合并；Sinkhorn 迭代归一化 HC mixer 权重；decode 中的融合 kernel 将 split+weighted_sum 合并为单次 dispatch |

### 3.3 FFN 组

| 文件 | 核心 kernel | 说明 |
|------|------------|------|
| `moe.metal` | `moe_mul_mv_id_iq2_xxs`、`moe_mul_mv_id_q2_k`、`moe_mul_mv_id_q4_k` 及 pair/sum6 变体 | 路由专家矩阵向量积，权重格式 IQ2_XXS / Q2_K / Q4_K；sum6 变体在一次 kernel 内累加全部 6 个被选专家 |
| `glu.metal` | SwiGLU | gate-up 融合 SiLU 激活 |
| `dense.metal` | `matmul_q8_0`、`matmul_f16`、`matmul_f32` | Q/KV/输出投影；Q8_0 为主要权重格式，F16 用于 HC 混合投影 |
| `dsv4_misc.metal` | router 相关工具 kernel | 路由器概率归一化、hash 路由辅助 |
| `softmax.metal` | `soft_max_f32` 及 DS4 压缩池 softmax | 注意力分数归一化 |

### 3.4 工具组

| 文件 | 主要作用 |
|------|---------|
| `norm.metal` | RMS norm（普通 + 带权重 + QKV 融合版） |
| `argsort.metal` | F32 降序 argsort + merge；用于 indexer top-k |
| `get_rows.metal` / `set_rows.metal` | token embedding 查表读写 |
| `cpy.metal` | F32↔F16 逐元素拷贝 |
| `concat.metal` | 张量拼接 |
| `repeat.metal` | HC 初始嵌入广播（1 行 → N_HC 行） |
| `sum_rows.metal` | 行求和（用于路由权重归一） |
| `bin.metal` | 逐元素二元运算（mul_scalar、div_row） |
| `unary.metal` | sigmoid / silu / softplus / sqrt / clamp / scale / fill |

---

## 4. `ds4_gpu_graph`：整模型图状态

`ds4_gpu_graph`（`ds4.c:8144-8307`）是整个 Metal 后端的核心数据结构，保存一个会话的全部设备端张量。它分为四个逻辑区块：

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4_gpu_graph data structure with four logical sections: decode work tensors, persistent KV cache, speculative decode scratch, and batch prefill work tensors">
  <defs>
    <marker id="ar-r10-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="10" width="720" height="36" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="33" text-anchor="middle" font-size="14" font-weight="700" fill="#ea580c">ds4_gpu_graph</text>
  <line x1="80" y1="46" x2="80" y2="320" stroke="#cbd5e1" stroke-width="1.2"/>
  <line x1="80" y1="82" x2="110" y2="82" stroke="#cbd5e1" stroke-width="1.2"/>
  <rect x="110" y="60" width="610" height="50" rx="4" fill="#fff7ed" stroke="#ea580c" stroke-width="1"/>
  <text x="125" y="79" font-size="11" font-weight="600" fill="#ea580c">decode 工作张量</text>
  <text x="125" y="97" font-size="11" fill="#64748b">cur_hc, flat_hc, hc_mix, hc_split, …, logits　— 每 token 推理复用，不随层循环增长</text>
  <line x1="80" y1="136" x2="110" y2="136" stroke="#cbd5e1" stroke-width="1.2"/>
  <rect x="110" y="114" width="610" height="52" rx="4" fill="#f0fdfa" stroke="#0d9488" stroke-width="1"/>
  <text x="125" y="133" font-size="11" font-weight="600" fill="#0d9488">持久 KV 缓存</text>
  <text x="125" y="151" font-size="11" fill="#64748b">layer_raw_cache[43], layer_attn_comp_cache[43], layer_index_comp_cache[43]</text>
  <text x="125" y="164" font-size="10" fill="#94a3b8">会话生命期内只增不减（环形写入）</text>
  <line x1="80" y1="194" x2="110" y2="194" stroke="#cbd5e1" stroke-width="1.2"/>
  <rect x="110" y="172" width="610" height="52" rx="4" fill="#faf5ff" stroke="#7c3aed" stroke-width="1"/>
  <text x="125" y="191" font-size="11" font-weight="600" fill="#7c3aed">推测解码暂存</text>
  <text x="125" y="209" font-size="11" fill="#64748b">spec_*_state_kv/score[43], spec_prefix1_*[43], spec_logits</text>
  <text x="125" y="222" font-size="10" fill="#94a3b8">N=2 验证器用于快速 partial-accept 的 compressor frontier 快照</text>
  <line x1="80" y1="252" x2="110" y2="252" stroke="#cbd5e1" stroke-width="1.2"/>
  <rect x="110" y="230" width="610" height="50" rx="4" fill="#f0f9ff" stroke="#0ea5e9" stroke-width="1"/>
  <text x="125" y="249" font-size="11" font-weight="600" fill="#0ea5e9">批量 Prefill 工作张量</text>
  <text x="125" y="267" font-size="11" fill="#64748b">batch_cur_hc, batch_next_hc, batch_flat_hc, …</text>
  <text x="125" y="280" font-size="10" fill="#94a3b8">仅在 prefill 期间激活；容量 = prefill_cap 行</text>
</svg>
<span class="figure-caption">图 R10.2 ｜ ds4_gpu_graph 四个逻辑区块：decode 工作张量、持久 KV 缓存、推测解码暂存、批量 prefill 工作张量</span>

<details>
<summary>ASCII 原版</summary>

```
ds4_gpu_graph
├── decode 工作张量（cur_hc, flat_hc, hc_mix, hc_split, ..., logits）
│   └── 每 token 推理复用，不随层循环增长
├── 持久 KV 缓存（layer_raw_cache[43], layer_attn_comp_cache[43],
│                 layer_index_comp_cache[43] 以及各层的 compressor state）
│   └── 会话生命期内只增不减（环形写入）
├── 推测解码暂存（spec_*_state_kv/score[43], spec_prefix1_*[43], spec_logits）
│   └── N=2 验证器用于快速 partial-accept 的 compressor frontier 快照
└── 批量 Prefill 工作张量（batch_cur_hc, batch_next_hc, batch_flat_hc, ...）
    └── 仅在 prefill 期间激活；容量 = prefill_cap 行
```

</details>

关键成员（`ds4.c:8194`）：

```c
uint32_t raw_cap;       // raw SWA ring 容量（行数）
uint32_t comp_cap;      // 最大压缩缓存行数（全局最坏情况）
uint32_t raw_window;    // 逻辑 SWA 窗口大小 = DS4_N_SWA
uint32_t prefill_cap;   // 批量 prefill 单次最大 token 数
uint32_t layer_comp_cap[DS4_N_LAYER]; // 每层的压缩缓存容量
```

---

## 5. 分配与释放

### 5.1 `metal_graph_alloc_raw_cap`（`ds4.c:8687`）

```c
static bool metal_graph_alloc_raw_cap(
        ds4_gpu_graph *g,
        const ds4_weights     *weights,
        const ds4_layer_weights *layer,
        uint32_t                raw_cap,
        uint32_t                ctx_size,
        uint32_t                prefill_cap,
        bool                    enable_mtp);
```

该函数是唯一的分配入口，它做以下工作：

1. **参数归一化**：确保 `raw_cap >= raw_window`，`comp_cap = ctx_size / min_ratio + 2`，每层的 `layer_comp_cap` 按各层实际 ratio 独立计算（`ds4.c:8712-8727`）。
2. **维度计算**：从 `weights` 提取 `q_rank`、`q_dim`、`low_dim`、`group_dim`、`shared_dim`、`routed_mid_dim`、`vocab_dim` 等，确保工作张量恰好容纳该模型的实际形状。
3. **一次性分配**：`ds4_gpu_tensor_alloc` 对每个命名张量各调用一次；失败则整个分配返回 false，调用方负责调用 `metal_graph_free` 释放已分配的部分。

```c
// ds4.c:8729-8733（部分）
const uint64_t hc_dim  = (uint64_t)DS4_N_HC * DS4_N_EMBD;
const uint64_t mix_hc  = 2ull * DS4_N_HC + (uint64_t)DS4_N_HC * DS4_N_HC;
const uint64_t q_rank  = layer->attn_q_a->dim[1];
const uint64_t q_dim   = (uint64_t)DS4_N_HEAD * DS4_N_HEAD_DIM;
const uint64_t low_dim = (uint64_t)DS4_N_OUT_GROUP * DS4_N_LORA_O;
```

### 5.2 `metal_graph_free`（`ds4.c:8309`）

```c
static void metal_graph_free(ds4_gpu_graph *g) {
    ds4_gpu_tensor_free(g->directional_steering_dirs);
    ds4_gpu_tensor_free(g->batch_ffn_out);
    // ... 逐一释放所有张量 ...
}
```

释放顺序无关紧要（`ds4_gpu_tensor_free` 接受 NULL），但注意每个 `ds4_gpu_tensor *` 只释放一次——没有引用计数，调用方须确保唯一所有权。

---

## 6. 单 Token Decode 流水线

### 6.1 编码一个 decode 层（`ds4.c:9213`）

`metal_graph_encode_decode_layer` 是 decode 的核心循环体，按以下顺序提交 kernel：

<svg viewBox="0 0 760 500" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Decode layer kernel dispatch sequence: HC norm, attention sublayer steps 1-15, and FFN sublayer">
  <defs>
    <marker id="ar-r10-3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="10" width="720" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="30" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">metal_graph_encode_decode_layer — kernel dispatch 顺序</text>
  <rect x="20" y="48" width="340" height="340" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1"/>
  <text x="190" y="68" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">注意力子层</text>
  <text x="36" y="90" font-size="10" fill="#64748b">① rms_norm_plain_tensor(flat_hc, cur_hc)</text>
  <text x="52" y="104" font-size="10" fill="#94a3b8">HC 平坦化 RMS norm</text>
  <text x="36" y="120" font-size="10" fill="#64748b">② matmul_plain(hc_mix, hc_attn_fn, flat_hc)</text>
  <text x="52" y="134" font-size="10" fill="#94a3b8">HC 混合投影</text>
  <text x="36" y="150" font-size="10" fill="#64748b">③ hc_split_weighted_sum OR hc_split_sinkhorn</text>
  <text x="52" y="164" font-size="10" fill="#94a3b8">HC split + weighted sum（融合/参考路径）</text>
  <text x="36" y="180" font-size="10" fill="#64748b">④ rms_norm_weight(attn_norm, attn_cur)</text>
  <text x="52" y="194" font-size="10" fill="#94a3b8">注意力子层 norm</text>
  <text x="36" y="210" font-size="10" fill="#64748b">⑤ matmul_q8_0(qr, attn_q_a) — Q LoRA down projection</text>
  <text x="36" y="226" font-size="10" fill="#64748b">⑥ head_rms_norm OR rms_norm_plain — Q head norm</text>
  <text x="36" y="242" font-size="10" fill="#64748b">⑦ rope_tail / head_rms_norm_rope_tail — DS4 尾部 RoPE</text>
  <text x="36" y="258" font-size="10" fill="#64748b">⑧ matmul_f16(kv_raw) — KV projection</text>
  <text x="36" y="274" font-size="10" fill="#64748b">⑨ dsv4_qkv_rms_norm_rows / head_rms_norm — KV norm</text>
  <text x="36" y="290" font-size="10" fill="#64748b">⑩ dsv4_fp8_kv_quantize — KV FP8 量化（RoPE 区域）</text>
  <text x="36" y="306" font-size="10" fill="#64748b">⑪ kv_fp8_store_raw_tensor — 写入 raw SWA ring</text>
  <text x="36" y="322" font-size="10" fill="#64748b">⑫ [compressor_update for compressed layers]</text>
  <text x="36" y="338" font-size="10" fill="#64748b">⑬ attention_decode_heads OR attention_decode_mixed</text>
  <text x="36" y="354" font-size="10" fill="#64748b">⑭ attention_output_q8_batch — 输出投影（含 LoRA）</text>
  <text x="36" y="370" font-size="10" fill="#64748b">⑮ hc_expand — HC 展开写回四路残差</text>
  <line x1="380" y1="218" x2="400" y2="218" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r10-3)"/>
  <rect x="400" y="48" width="340" height="340" rx="6" fill="#f0fdfa" stroke="#0d9488" stroke-width="1"/>
  <text x="570" y="68" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">FFN 子层</text>
  <text x="416" y="90" font-size="10" fill="#64748b">① rms_norm_plain_tensor(flat_hc, cur_hc)</text>
  <text x="416" y="110" font-size="10" fill="#64748b">② matmul_f16(hc_mix, hc_ffn_fn) — HC 混合投影</text>
  <text x="416" y="130" font-size="10" fill="#64748b">③ hc_split_weighted_sum（融合路径）</text>
  <text x="416" y="150" font-size="10" fill="#64748b">④ rms_norm_weight(ffn_norm)</text>
  <text x="416" y="170" font-size="10" fill="#64748b">⑤ router: matmul + sigmoid + top-k / hash routing</text>
  <text x="416" y="190" font-size="10" fill="#64748b">⑥ shared expert: gate + up (SwiGLU)</text>
  <text x="416" y="210" font-size="10" fill="#64748b">⑦ routed_moe（IQ2_XXS / Q2_K / Q4_K）</text>
  <text x="416" y="230" font-size="10" fill="#64748b">⑧ shared_down_hc_expand_q8_0（fused down + HC expand）</text>
  <rect x="20" y="406" width="720" height="44" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="380" y="424" text-anchor="middle" font-size="11" fill="#64748b">压缩层（compress_ratio ≠ 0）额外执行 compressor_update_tensor</text>
  <text x="380" y="440" text-anchor="middle" font-size="11" fill="#64748b">ratio-4 indexer 层再额外执行 indexer scoring + top-k</text>
</svg>
<span class="figure-caption">图 R10.3 ｜ decode layer 的 kernel dispatch 顺序：左侧 15 步注意力子层，右侧 8 步 FFN 子层</span>

<details>
<summary>ASCII 原版</summary>

```
1. rms_norm_plain_tensor(flat_hc, cur_hc)        // HC 平坦化 RMS norm
2. matmul_plain(hc_mix, hc_attn_fn, flat_hc)     // HC 混合投影
3. hc_split_weighted_sum OR hc_split_sinkhorn    // HC split + weighted sum（融合/参考路径）
4. rms_norm_weight(attn_norm, attn_cur)          // 注意力子层 norm
5. matmul_q8_0(qr, attn_q_a)                    // Q LoRA down projection
6. head_rms_norm OR rms_norm_plain               // Q head norm
7. rope_tail / head_rms_norm_rope_tail           // DS4 尾部 RoPE
8. matmul_f16(kv_raw)                            // KV projection
9. dsv4_qkv_rms_norm_rows / head_rms_norm       // KV norm
10. dsv4_fp8_kv_quantize                         // KV FP8 量化（RoPE 区域）
11. kv_fp8_store_raw_tensor OR store_raw_kv      // 写入 raw SWA ring
12. [compressor_update for compressed layers]    // 压缩缓存更新
13. attention_decode_heads OR attention_decode_mixed // 注意力计算
14. attention_output_q8_batch                    // 输出投影（含 LoRA）
15. hc_expand                                    // HC 展开写回四路残差
16. [FFN 子层：norm + router + shared_expert + routed_moe + hc_expand]
```

</details>

对于压缩层（`ds4_layer_compress_ratio(il) != 0`），步骤 12 调用 `ds4_gpu_compressor_update_tensor`；对于 ratio-4 的 indexer 层，还额外执行 indexer scoring + top-k。

### 6.2 完整单 token decode step（`ds4.c:10808`）

```c
static bool metal_graph_encode_token_raw_swa(
        ds4_gpu_graph *g,
        const ds4_model  *model,
        const ds4_weights *weights,
        int   token,
        uint32_t pos,
        bool  need_logits,
        bool  allow_split_flush) {

    // 嵌入 token → cur_hc（4 * DS4_N_EMBD 维 HC 张量）
    ok = ds4_gpu_embed_token_hc_tensor(g->cur_hc, ...);

    // CPU/GPU 重叠：编码前 split_after_layers 层后 flush
    for (uint32_t il = 0; ok && il < DS4_N_LAYER; il++) {
        ok = metal_graph_encode_decode_layer(g, model, &weights->layer[il],
                                             il, pos, g->layer_raw_cache[il],
                                             g->raw_cap, raw_row, n_raw, token);
        swap(g->cur_hc, g->after_ffn_hc);
        if (allow_split_flush && il + 1u == split_after_layers)
            ok = ds4_gpu_flush_commands() != 0;  // ds4.c:10864
    }

    if (need_logits) ok = metal_graph_encode_output_head(g, model, weights, ...);
    return ok;
}
```

`split_after_layers` 默认为 4，可通过环境变量 `DS4_METAL_GRAPH_TOKEN_SPLIT_LAYERS` 覆盖。

### 6.3 执行一个 Metal decode token 并读回 logits（`ds4.c:12775`）

```c
static bool metal_graph_eval_token_raw_swa(
        ds4_gpu_graph *g, ...,
        int token, uint32_t pos, float *logits) {

    bool ok = ds4_gpu_begin_commands() != 0;
    if (ok) ok = metal_graph_encode_token_raw_swa(g, ..., token, pos,
                                                   logits != NULL, true);
    if (ok) ok = ds4_gpu_end_commands() != 0;   // 等待 GPU 完成

    if (ok && logits)
        ok = ds4_gpu_tensor_read(g->logits, 0, logits,
                                 (uint64_t)DS4_N_VOCAB * sizeof(float)) != 0;
    return ok;
}
```

`ds4_gpu_begin_commands` / `ds4_gpu_end_commands` 在 Metal 侧对应一个（或多个因 flush 而分裂的）`MTLCommandBuffer`；`ds4_gpu_tensor_read` 在 GPU 完成后执行同步 CPU 内存拷贝。

---

## 7. 最终输出头

`metal_graph_encode_output_head`（`ds4.c:9980`）在最后一层之后处理 HC collapse 并产出词表 logits：

```c
static bool metal_graph_encode_output_head(
        ds4_gpu_graph *g, ..., uint64_t vocab_dim) {

    // 1. HC 平坦化 RMS norm
    ok = ds4_gpu_rms_norm_plain_tensor(g->flat_hc, g->cur_hc, hc_dim, DS4_RMS_EPS);

    // 2. F16 投影：flat_hc → output_pre（HC 维 → DS4_N_HC）
    ok = ds4_gpu_matmul_f16_tensor(g->output_pre,
                                   weights->output_hc_fn->abs_offset, hc_dim, DS4_N_HC, ...);

    // 3. 计算 HC 权重（Sinkhorn 归一化的输出端）
    ok = ds4_gpu_output_hc_weights_tensor(g->output_weights, g->output_pre,
                                          weights->output_hc_scale, weights->output_hc_base, ...);

    // 4. weighted sum：4 路 HC → 单路 DS4_N_EMBD 向量
    ok = ds4_gpu_hc_weighted_sum_tensor(g->output_embd, g->cur_hc,
                                        g->output_weights, DS4_N_EMBD, DS4_N_HC);

    // 5. RMS norm + 权重（output_norm weights）
    ok = ds4_gpu_rms_norm_weight_tensor(g->output_norm, g->output_embd,
                                        weights->output_norm->abs_offset, DS4_N_EMBD, ...);

    // 6. Q8_0 词表投影 → g->logits（vocab_dim 个 f32）
    ok = ds4_gpu_matmul_q8_0_tensor(g->logits, weights->output->abs_offset,
                                    DS4_N_EMBD, vocab_dim, g->output_norm, 1);
    return ok;
}
```

这六步在 prefill 和 decode 中完全复用，唯一区别是 prefill 把 `g->cur_hc` 临时指向最后一个 token 的行切片（`ds4.c:13286-13293`）。

---

## 8. 批量 Prefill 流水线

### 8.1 编码 prefill 注意力半层（`ds4.c:11083`）

`metal_graph_encode_layer_attention_batch` 处理一个 ubatch 的注意力子层，与 decode 的 `metal_graph_encode_decode_layer` 互为"批量版"：

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Prefill attention half-layer batch kernel sequence running on n_tokens rows simultaneously">
  <defs>
    <marker id="ar-r10-4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="10" width="720" height="28" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="28" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">metal_graph_encode_layer_attention_batch — 对 n_tokens 行同时运行</text>
  <rect x="20" y="46" width="340" height="274" rx="6" fill="#f0fdfa" stroke="#0d9488" stroke-width="1"/>
  <text x="36" y="68" font-size="10" fill="#64748b">① rms_norm_plain_rows(batch_flat_hc, batch_cur_hc)</text>
  <text x="36" y="86" font-size="10" fill="#64748b">② matmul_f16(hc_mix_view, hc_attn_fn)</text>
  <text x="52" y="100" font-size="10" fill="#94a3b8">n_tokens × mix_hc</text>
  <text x="36" y="116" font-size="10" fill="#64748b">③ hc_split_weighted_sum (fused)</text>
  <text x="52" y="130" font-size="10" fill="#94a3b8">OR sinkhorn+weighted_sum (reference)</text>
  <text x="36" y="146" font-size="10" fill="#64748b">④ rms_norm_weight_rows(batch_attn_norm)</text>
  <text x="36" y="162" font-size="10" fill="#64748b">⑤ matmul_q8_0(batch_qr, attn_q_a)</text>
  <text x="36" y="178" font-size="10" fill="#64748b">⑥ [norm + rope for q, matmul for kv]</text>
  <rect x="400" y="46" width="340" height="274" rx="6" fill="#f0fdfa" stroke="#0d9488" stroke-width="1"/>
  <text x="416" y="68" font-size="10" fill="#64748b">⑦ store_raw_kv_batch — 写入 raw ring（batch）</text>
  <text x="416" y="86" font-size="10" fill="#64748b">⑧ [compressor_prefill for compressed layers]</text>
  <text x="432" y="100" font-size="10" fill="#94a3b8">批量矩阵运算版，效率远高于逐 token 累积</text>
  <text x="416" y="116" font-size="10" fill="#64748b">⑨ attention_prefill_raw_heads</text>
  <text x="432" y="130" font-size="10" fill="#94a3b8">OR static_mixed OR masked_mixed</text>
  <text x="416" y="146" font-size="10" fill="#64748b">⑩ attention_output_q8_batch</text>
  <text x="416" y="162" font-size="10" fill="#64748b">⑪ hc_expand_add_split</text>
  <text x="432" y="176" font-size="10" fill="#94a3b8">attn 后更新 batch_after_attn_hc</text>
  <line x1="360" y1="183" x2="400" y2="183" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r10-4)"/>
</svg>
<span class="figure-caption">图 R10.4 ｜ prefill 注意力半层批量 kernel 序列：11 步并行处理 n_tokens 行，compressor_prefill 以批量矩阵运算替代逐 token 累积</span>

<details>
<summary>ASCII 原版</summary>

```
对 n_tokens 行同时运行：
1. rms_norm_plain_rows(batch_flat_hc, batch_cur_hc)
2. matmul_f16(hc_mix_view, hc_attn_fn)           // n_tokens × mix_hc
3. hc_split_weighted_sum (fused) OR sinkhorn+weighted_sum (reference)
4. rms_norm_weight_rows(batch_attn_norm)
5. matmul_q8_0(batch_qr, attn_q_a)
6. [norm + rope for q, matmul for kv]
7. store_raw_kv_batch                             // 写入 raw ring（batch）
8. [compressor_prefill for compressed layers]
9. attention_prefill_raw_heads OR static_mixed OR masked_mixed
10. attention_output_q8_batch
11. hc_expand_add_split (attn 后更新 batch_after_attn_hc)
```

</details>

关键区别：prefill 对压缩层调用 `ds4_gpu_compressor_prefill_tensor` 而不是逐 token 的 `compressor_update_tensor`，前者是批量矩阵运算版本，效率远高于逐 token 累积。

### 8.2 编码 prefill FFN 半层（`ds4.c:12496`）

`metal_graph_encode_layer_ffn_batch` 处理同一 ubatch 的 FFN 子层：

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Prefill FFN half-layer batch kernel sequence: HC norm, router, shared expert, routed MoE, and fused HC expand">
  <rect x="20" y="10" width="720" height="28" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="28" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">metal_graph_encode_layer_ffn_batch</text>
  <rect x="20" y="46" width="340" height="234" rx="6" fill="#f0fdfa" stroke="#0d9488" stroke-width="1"/>
  <text x="190" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">HC 准备 + 路由</text>
  <text x="36" y="86" font-size="10" fill="#64748b">① rms_norm_plain_rows(batch_flat_hc, batch_after_attn_hc)</text>
  <text x="36" y="104" font-size="10" fill="#64748b">② matmul_f16(hc_mix_view, hc_ffn_fn)</text>
  <text x="36" y="122" font-size="10" fill="#64748b">③ hc_split_weighted_sum (fused)</text>
  <text x="36" y="140" font-size="10" fill="#64748b">④ rms_norm_weight_rows(batch_ffn_norm)</text>
  <text x="36" y="160" font-size="10" fill="#64748b">⑤ matmul_f16_pair(batch_shared_gate, batch_shared_up)</text>
  <text x="52" y="174" font-size="10" fill="#94a3b8">shared expert gate + up</text>
  <text x="36" y="192" font-size="10" fill="#64748b">⑥ router: matmul + sigmoid + top-k</text>
  <text x="52" y="206" font-size="10" fill="#94a3b8">OR hash routing</text>
  <rect x="400" y="46" width="340" height="234" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1"/>
  <text x="570" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">专家计算 + 输出</text>
  <text x="416" y="86" font-size="10" fill="#64748b">⑦ routed_moe_batch</text>
  <text x="432" y="100" font-size="10" fill="#94a3b8">IQ2_XXS / Q2_K / Q4_K gate/up/down</text>
  <text x="416" y="120" font-size="10" fill="#64748b">⑧ shared_down_hc_expand_q8_0</text>
  <text x="432" y="134" font-size="10" fill="#94a3b8">fused: down_proj + HC expand</text>
</svg>
<span class="figure-caption">图 R10.5 ｜ prefill FFN 半层批量 kernel 序列：HC 准备与路由（步骤 ①-⑥）、路由专家计算与 HC 展开（步骤 ⑦-⑧）</span>

<details>
<summary>ASCII 原版</summary>

```
1. rms_norm_plain_rows(batch_flat_hc, batch_after_attn_hc)
2. matmul_f16(hc_mix_view, hc_ffn_fn)
3. hc_split_weighted_sum (fused)
4. rms_norm_weight_rows(batch_ffn_norm)
5. matmul_f16_pair(batch_shared_gate, batch_shared_up)   // shared expert gate+up
6. router: matmul + sigmoid + top-k 或 hash routing
7. routed_moe_batch（IQ2_XXS / Q2_K / Q4_K gate/up/down）
8. shared_down_hc_expand_q8_0（fused：down_proj + HC expand）
```

</details>

### 8.3 完整层编码（`ds4.c:12757`）

```c
static bool metal_graph_encode_layer_batch(
        ds4_gpu_graph *g, ..., uint32_t il, uint32_t pos0, uint32_t n_tokens) {
    bool ok = metal_graph_encode_layer_attention_batch(g, model, layer, il, pos0, n_tokens);
    if (ok) ok = metal_graph_encode_layer_ffn_batch(g, model, layer, il, pos0, n_tokens);
    if (ok) {
        // 交换 batch_cur_hc / batch_next_hc 为下一层做准备
        ds4_gpu_tensor *tmp = g->batch_cur_hc;
        g->batch_cur_hc  = g->batch_next_hc;
        g->batch_next_hc = tmp;
    }
    return ok;
}
```

### 8.4 Layer-major prefill 执行（`ds4.c:13222`）

```c
static bool metal_graph_prefill_layer_major(
        ds4_gpu_graph *g, ..., int n_tokens, float *logits, ...) {

    metal_graph_upload_prompt_tokens(g->prefill_tokens, prompt, 0, n_tokens);
    metal_graph_warmup_prefill_kernels(g, model, weights, n_tokens);

    // 短 prompt（≤2048 token）：一个 command buffer 跑全部层
    bool split_commands = n_tokens > 2048 || imatrix != NULL;

    if (!split_commands) {
        metal_graph_upload_prompt_embeddings_hc(g->batch_cur_hc, ...);
        ds4_gpu_begin_commands();
        for (uint32_t il = 0; il < DS4_N_LAYER; il++)
            metal_graph_encode_layer_batch(g, model, &weights->layer[il],
                                           il, 0, n_tokens);
        // encode_output_head → 取最后一行 cur_hc 做 logits
        ds4_gpu_end_commands();
    } else {
        // 逐层提交：防止 macOS watchdog 杀掉长时间占用 GPU 的进程
        for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
            ds4_gpu_begin_commands();
            metal_graph_encode_layer_batch(g, ..., il, 0, n_tokens);
            ds4_gpu_end_commands();
        }
        // 最终 output head
    }
    return ds4_gpu_tensor_read(g->logits, 0, logits, ...);
}
```

**Layer-major 的意义**：每层只需 `prefill_cap` 行的激活内存（而非 `n_tokens × n_layers` 的全局激活张量）。KV 缓存在每层循环中就地更新，不需要额外暂存，与 decode 共享同一套持久缓存张量。

---

## 9. 分块 Prefill

### 9.1 分块主循环（`ds4.c:13521`）

`metal_graph_prefill_chunked_range` 处理超过 `prefill_cap` 的 prompt，将其切成多个 chunk 依次执行：

```c
static bool metal_graph_prefill_chunked_range(
        ds4_gpu_graph *g, ...,
        uint32_t start, uint32_t n_tokens, float *logits, ...) {

    uint32_t chunk_cap = g->prefill_cap;
    // 续接模式：对齐到 prefill_cap 边界
    if (start != 0 && chunk_cap > g->raw_cap) chunk_cap = g->raw_cap;

    for (uint32_t pos0 = start; pos0 < start + n_tokens; ) {
        const uint32_t chunk = min(remaining, local_cap);

        metal_graph_upload_prompt_tokens(g->prefill_tokens, prompt, pos0, chunk);
        metal_graph_upload_prompt_embeddings_hc(g->batch_cur_hc, ..., pos0, chunk);

        for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
            ds4_gpu_begin_commands();
            metal_graph_encode_layer_batch(g, model, &weights->layer[il],
                                           il, pos0, chunk);
            ds4_gpu_end_commands();  // 逐层提交
        }
        pos0 += chunk;
    }
    // 最终输出头
}
```

**对齐的必要性**：分块从 `start` 续接时，`pos0 % prefill_cap == 0` 的对齐保证压缩窗口和行终止（row finalization）的调度与完整冷启动 prefill 完全一致，避免 compressor frontier 产生分歧。

### 9.2 `metal_graph_prefill_chunked`（`ds4.c:13686`）

```c
static bool metal_graph_prefill_chunked(
        ds4_gpu_graph *g, ..., int n_tokens, float *logits, ...) {
    return metal_graph_prefill_chunked_range(g, ..., 0, n_tokens, logits, ...);
}
```

这是从 position 0 开始的简化包装，用于完整 prompt 的分块处理。

---

## 10. Prefill Ubatch 大小选择

`metal_graph_prefill_cap_for_prompt`（`ds4.c:13982`）：

```c
static uint32_t metal_graph_prefill_cap_for_prompt(int prompt_len) {
    return ds4_default_prefill_cap_for_prompt(prompt_len);
}
```

`ds4_context_memory_estimate`（`ds4.c:14002`）在会话创建时计算 `prefill_cap`，规则是：

- 普通 prompt（≤2048 token）：`prefill_cap = prompt_len`（即整 prompt 作为一个 ubatch）
- 长 prompt（>2048 token）：`prefill_cap = 2048`（分块模式）

raw_cap 的计算（`ds4.c:13944-13978`）：

```text
raw_cap = align_up(min(raw_window + prefill_cap, ctx_size), 256)
raw_cap = clamp(raw_cap, raw_window, 8192)
```

这保证在 prefill 最后一个 ubatch时，raw SWA ring 能同时容纳当前 ubatch 加上前面逻辑窗口内的全部 raw KV 行。

---

## 11. 上传 Prompt Token Id

`metal_graph_upload_prompt_tokens`（`ds4.c:10883`）：

```c
static bool metal_graph_upload_prompt_tokens(
        ds4_gpu_tensor *out_tokens,
        const token_vec  *prompt,
        uint32_t pos0, uint32_t n_tokens) {

    int32_t *tokens = xmalloc(n_tokens * sizeof(tokens[0]));
    for (uint32_t i = 0; i < n_tokens; i++)
        tokens[i] = prompt->v[pos0 + i];

    bool ok = ds4_gpu_tensor_write(out_tokens, 0, tokens,
                                   n_tokens * sizeof(tokens[0])) != 0;
    free(tokens);
    return ok;
}
```

Token id 需要上传到 GPU 的原因：DeepSeek V4 的 MoE 路由有两种模式——**学习路由**（根据隐状态概率选专家）和 **hash 路由**（根据 token id 的哈希直接决定专家）。Hash 路由在某些层或某些推理配置下使用，此时 `ds4_gpu_router_select_batch_tensor` 需要访问 `g->prefill_tokens` 中存储的原始 token id。

---

## 12. 关键常量与调试环境变量

| 常量/变量 | 值/含义 |
|-----------|---------|
| `DS4_N_LAYER` | 43（含 1 个 MTP 层） |
| `DS4_N_EMBD` | 7168 |
| `DS4_N_HEAD` | 128 |
| `DS4_N_HEAD_DIM` | 128 |
| `DS4_N_HC` | 4（四路 Hyper-Connection 残差流） |
| `DS4_N_SWA` | 128（滑动窗口注意力 token 数） |
| `DS4_N_ROT` | 64（RoPE 旋转维度数） |
| `DS4_RMS_EPS` | 1e-6 |

| 环境变量 | 作用 |
|----------|------|
| `DS4_METAL_GRAPH_TOKEN_SPLIT_LAYERS` | 覆盖 decode split flush 层数（默认 4） |
| `DS4_METAL_GRAPH_TOKEN_PROFILE` | 打印 encode/execute/read 耗时 |
| `DS4_METAL_GRAPH_PREFILL_PROFILE` | 打印 prefill 各层 encode/execute 耗时 |
| `DS4_METAL_DECODE_STAGE_PROFILE` | 逐阶段打印 decode 每个 kernel 耗时（需 `end_commands` 同步点） |
| `DS4_METAL_LAYER_STAGE_PROFILE` | 逐阶段打印 prefill attn/ffn 耗时 |
| `DS4_METAL_GRAPH_OUTPUT_ROW` | 强制选取特定行作为 output head 输入（调试用） |
| `DS4_METAL_GRAPH_RAW_CAP` | 覆盖 raw SWA ring 容量 |
| `DS4_METAL_RESUME_PREFILL_MIN` | server 续接 prefill 的最小 token 阈值 |

---

## 相关章节

- [第 11 章：CUDA 后端](11-cuda-backend.md) —— `ds4_gpu.h` 的 CUDA 实现，与本章的 Metal 实现对应
- [第 12 章：推测解码与 MTP](12-speculative-mtp.md) —— 使用本章描述的 `metal_graph_eval_token_raw_swa`、`metal_graph_verify_suffix_tops`、`metal_graph_verify_decode2_exact`
