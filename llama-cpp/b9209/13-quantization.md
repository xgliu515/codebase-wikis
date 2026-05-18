# 第 13 章 量化与模型压缩

## 概述

量化是 llama.cpp 的核心竞争力之一。一个 7B 参数的模型以 FP16 存储需要约 14 GB 显存/内存，而使用 Q4_K_M 量化后降至约 4.6 GB，在可接受的精度损失下使大多数消费级硬件成为可能。llama.cpp 的量化系统由以下几个层次构成：

- **块量化数据结构**：`ggml/src/ggml-common.h` 中定义的 `block_*` 结构体，是所有量化类型的物理表示
- **量化类型枚举**：`ggml/include/ggml.h` 中的 `ggml_type`，标识每个张量的存储格式
- **文件级量化标识**：`include/llama.h` 中的 `llama_ftype`，描述整个模型文件的量化策略
- **量化核函数**：`ggml/src/ggml-quants.c` 中的 `quantize_*` / `dequantize_row_*` 函数族
- **模型量化流程**：`src/llama-quant.cpp` 中的 `llama_model_quantize_impl`，逐张量决策并执行量化

---

## 13.1 为什么量化

### 显存与带宽瓶颈

大语言模型推理的主要瓶颈不是计算量（FLOP），而是内存带宽。每次 forward pass 需要从显存读取全部权重矩阵。以 Llama-3-8B 为例：

| 精度 | 权重大小 | 读取带宽需求（每 token） |
|------|---------|------------------------|
| F32  | 32 GB   | ~32 GB/token           |
| F16/BF16 | 16 GB | ~16 GB/token       |
| Q8_0 | 8.5 GB  | ~8.5 GB/token          |
| Q4_K_M | 4.6 GB | ~4.6 GB/token        |
| Q2_K | 3.0 GB  | ~3.0 GB/token          |

量化通过牺牲表示精度换取：
1. **显存占用降低**：可加载更大模型或更多并发请求
2. **带宽压力减轻**：内存读取量减少，单 token 延迟降低
3. **缓存利用率提升**：量化权重更小，L2/L3 缓存命中率上升

### 量化的代价

量化引入的误差体现为困惑度（perplexity）上升。以 Llama-3-8B 的基准数据为参考（来自 `tools/quantize/quantize.cpp`，`QUANT_OPTIONS` 数组）：

```c
// tools/quantize/quantize.cpp:34
static const std::vector<quant_option> QUANT_OPTIONS = {
    { "Q4_0",   LLAMA_FTYPE_MOSTLY_Q4_0, " 4.34G, +0.4685 ppl @ Llama-3-8B",  },
    { "Q4_K_M", LLAMA_FTYPE_MOSTLY_Q4_K_M," 4.58G, +0.1754 ppl @ Llama-3-8B", },
    { "Q5_K_M", LLAMA_FTYPE_MOSTLY_Q5_K_M," 5.33G, +0.0569 ppl @ Llama-3-8B", },
    { "Q6_K",   LLAMA_FTYPE_MOSTLY_Q6_K, " 6.14G, +0.0217 ppl @ Llama-3-8B",  },
    { "Q8_0",   LLAMA_FTYPE_MOSTLY_Q8_0, " 7.96G, +0.0026 ppl @ Llama-3-8B",  },
};
```

Q4_K_M 在压缩比与精度之间取得了较好平衡，是社区最常用的量化格式。

---

## 13.2 块量化原理

### 核心思想

ggml 采用**块量化（block quantization）**：将权重张量切分成固定大小的块（block），同一块内的所有元素共享一个或多个缩放因子（scale）和可选的偏移量（min）。反量化时：

```
w_fp32[i] = scale * q[i]          // 对称量化（Q4_0、Q8_0）
w_fp32[i] = scale * q[i] + min    // 非对称量化（Q4_1）
```

这样只需存储少量高精度 scale，其余权重使用低位整数表示，实现压缩。

### 基本块结构定义

`ggml/src/ggml-common.h` 集中定义了所有量化格式的块结构体。以最基础的两种为例：

```c
// ggml/src/ggml-common.h:184
#define QK4_0 32
typedef struct {
    ggml_half d;           // delta（缩放因子，FP16）
    uint8_t qs[QK4_0 / 2]; // nibbles / quants（4bit×32 = 16字节）
} block_q4_0;
static_assert(sizeof(block_q4_0) == sizeof(ggml_half) + QK4_0 / 2, "...");

// ggml/src/ggml-common.h:191
#define QK4_1 32
typedef struct {
    GGML_EXTENSION union {
        struct { ggml_half d; ggml_half m; } GGML_COMMON_AGGR_S; // d=scale, m=min
        ggml_half2 dm;
    } GGML_COMMON_AGGR_U;
    uint8_t qs[QK4_1 / 2]; // nibbles
} block_q4_1;
```

每个 `block_q4_0` 包含 32 个 4-bit 量化值（存于 16 字节 `qs`）和 1 个 FP16 缩放因子（2 字节），每权重有效位数 = 16/32×8 + 2/32×16 = 4 + 1 = 约 4.5 bpw（bits per weight）。

```c
// ggml/src/ggml-common.h:241
#define QK8_0 32
typedef struct {
    ggml_half d;       // delta
    int8_t  qs[QK8_0]; // quants（8bit×32 = 32字节）
} block_q8_0;
```

### 超级块（Super-block / K-quant）

K-quant 引入了两级层次：内层是 QK_K=256 个权重组成的**超级块**，外层进一步划分子块。`QK_K` 定义于：

```c
// ggml/src/ggml-common.h:89
#define QK_K 256
#define K_SCALE_SIZE 12
```

以 Q4_K 为例（超级块内有 8 个 32 元素子块）：

```c
// ggml/src/ggml-common.h:317
typedef struct {
    GGML_EXTENSION union {
        struct {
            ggml_half d;    // super-block scale for quantized scales
            ggml_half dmin; // super-block scale for quantized mins
        } GGML_COMMON_AGGR_S;
        ggml_half2 dm;
    } GGML_COMMON_AGGR_U;
    uint8_t scales[K_SCALE_SIZE]; // scales and mins, quantized with 6 bits
    uint8_t qs[QK_K/2];           // 4-bit quants
} block_q4_K;
```

超级块的 scales 本身也被量化为 6-bit 存储，进一步节省空间。有效位数约 4.5 bpw。

---

## 13.3 量化类型族

### 13.3.1 ggml_type 枚举

`ggml/include/ggml.h` 中的 `ggml_type` 是 ggml 内部标识张量存储格式的枚举：

```c
// ggml/include/ggml.h:390
enum ggml_type {
    GGML_TYPE_F32     = 0,
    GGML_TYPE_F16     = 1,
    GGML_TYPE_Q4_0    = 2,
    GGML_TYPE_Q4_1    = 3,
    GGML_TYPE_Q5_0    = 6,
    GGML_TYPE_Q5_1    = 7,
    GGML_TYPE_Q8_0    = 8,
    GGML_TYPE_Q8_1    = 9,
    GGML_TYPE_Q2_K    = 10,
    GGML_TYPE_Q3_K    = 11,
    GGML_TYPE_Q4_K    = 12,
    GGML_TYPE_Q5_K    = 13,
    GGML_TYPE_Q6_K    = 14,
    GGML_TYPE_Q8_K    = 15,
    GGML_TYPE_IQ2_XXS = 16,
    GGML_TYPE_IQ2_XS  = 17,
    GGML_TYPE_IQ3_XXS = 18,
    GGML_TYPE_IQ1_S   = 19,
    GGML_TYPE_IQ4_NL  = 20,
    GGML_TYPE_IQ3_S   = 21,
    GGML_TYPE_IQ2_S   = 22,
    GGML_TYPE_IQ4_XS  = 23,
    GGML_TYPE_IQ1_M   = 29,
    GGML_TYPE_BF16    = 30,
    GGML_TYPE_TQ1_0   = 34,
    GGML_TYPE_TQ2_0   = 35,
    GGML_TYPE_MXFP4   = 39,
    GGML_TYPE_NVFP4   = 40,
    GGML_TYPE_Q1_0    = 41,
    GGML_TYPE_COUNT   = 42,
};
```

### 13.3.2 传统量化：Q4_0 / Q4_1 / Q5_0 / Q5_1 / Q8_0

这些是 ggml 最早支持的量化格式，每块 32 元素，无超级块层次：

| 类型 | bpw | 块大小 | scale 数 | 特点 |
|------|-----|--------|---------|------|
| Q4_0 | 4.34 | 32 | 1×FP16 | 对称，仅 scale |
| Q4_1 | 4.78 | 32 | 2×FP16 | 非对称，scale+min |
| Q5_0 | 5.21 | 32 | 1×FP16 | 5-bit，高位存 qh[4] |
| Q5_1 | 5.65 | 32 | 2×FP16 | 5-bit 非对称 |
| Q8_0 | 8.5  | 32 | 1×FP16 | 8-bit 对称，几乎无损 |

Q8_0 主要用于激活值（activation）量化（即运算时的 `src1` 张量），在 CUDA 的 MMVQ kernel 中广泛使用。

### 13.3.3 K-quant（Q2_K … Q6_K）

K-quant 于 2023 年引入，基于超级块（256 元素）+量化的 scales 实现更高精度/压缩比：

| 类型 | 实际 bpw | 超级块 | 块注释 |
|------|---------|--------|-------|
| Q2_K | 2.625   | 256    | 2-bit quants，4-bit scales，`ggml-common.h:288` |
| Q3_K | 3.4375  | 256    | 3-bit quants（high bit 单独存）`ggml-common.h:305` |
| Q4_K | 4.5     | 256    | 4-bit quants，6-bit scales `ggml-common.h:317` |
| Q5_K | 5.5     | 256    | 5-bit quants `ggml-common.h:334` |
| Q6_K | 6.5625  | 256    | 6-bit quants（ql+qh）`ggml-common.h:352` |

Q6_K 结构体：

```c
// ggml/src/ggml-common.h:352
typedef struct {
    uint8_t ql[QK_K/2];      // quants, lower 4 bits
    uint8_t qh[QK_K/4];      // quants, upper 2 bits
    int8_t  scales[QK_K/16]; // scales, quantized with 8 bits
    ggml_half d;             // super-block scale
} block_q6_K;
```

K-quant 的 S/M/L 变体（如 Q3_K_S/M/L、Q4_K_S/M）是在 `llama-quant.cpp` 中通过为特定张量类别分配不同基础类型实现的，并非 `ggml_type` 枚举层面的区别。

### 13.3.4 IQ 系列（Importance-aware Quantization）

IQ 系列是 llama.cpp 独有的量化方案，结合 imatrix（重要性矩阵）对每个权重通道的重要程度加权选择量化码本。代码位于 `ggml/src/ggml-quants.c`：

| 类型 | bpw | 核函数入口 | 特点 |
|------|-----|-----------|------|
| IQ1_S | 1.56 | `dequantize_row_iq1_s:2574` | 1.56 bpw，极低精度 |
| IQ1_M | 1.75 | `dequantize_row_iq1_m:2599` | 比 IQ1_S 略高 |
| IQ2_XXS | 2.06 | `dequantize_row_iq2_xxs:2412` | 2-bit 超低精度 |
| IQ2_XS  | 2.31 | `dequantize_row_iq2_xs:2440` | 2-bit 稍高 |
| IQ2_S   | 2.5  | `dequantize_row_iq2_s:2467` | |
| IQ3_XXS | 3.06 | `dequantize_row_iq3_xxs:2499` | |
| IQ3_S   | 3.44 | `dequantize_row_iq3_s:2531` | |
| IQ4_NL  | 4.5  | `dequantize_row_iq4_nl:2649` | 非线性码本 |
| IQ4_XS  | 4.25 | `dequantize_row_iq4_xs:2667` | |

IQ2_XXS、IQ2_XS、IQ1_S 在量化时**强制要求** imatrix，否则 `ggml_quantize_chunk` 会断言失败（见下一节）。

IQ4_NL 使用固定的非线性（non-linear）码本，通过查表完成反量化，无需 imatrix。

### 13.3.5 三值量化（TQ：Ternary Quantization）

TQ 系列将权重量化为三个值（0、+1、-1），实现 1.69 bpw（TQ1_0）和 2.06 bpw（TQ2_0）：

```c
// ggml/src/ggml-common.h:265
// 1.6875 bpw
typedef struct {
    uint8_t qs[(QK_K - 4 * QK_K / 64) / 5]; // 5 elements per byte (3^5=243<256)
    uint8_t qh[QK_K/64]; // 4 elements per byte
    ggml_half d;
} block_tq1_0;

// 2.0625 bpw
typedef struct {
    uint8_t qs[QK_K/4]; // 2 bits per element
    ggml_half d;
} block_tq2_0;
```

TQ1_0 利用 $3^5 = 243 < 256$ 的特性，每字节打包 5 个三值元素。适用于原生三值训练的模型（如 BitNet）。

### 13.3.6 MXFP4 / NVFP4

这两种格式是针对现代 GPU（NVIDIA Blackwell/Ada）的原生 FP4 支持设计的：

```c
// ggml/src/ggml-common.h:204
#define QK_MXFP4 32
typedef struct {
    uint8_t e; // E8M0 scale（MX 格式的超级块 scale）
    uint8_t qs[QK_MXFP4/2]; // packed 4-bit E2M1 values
} block_mxfp4;

// ggml/src/ggml-common.h:211
#define QK_NVFP4 64
#define QK_NVFP4_SUB 16  // sub-block size for per-group scales
typedef struct {
    uint8_t d[QK_NVFP4/QK_NVFP4_SUB]; // UE4M3 scales (4 bytes, 每16元素一个)
    uint8_t qs[QK_NVFP4/2];            // packed 4-bit E2M1 values
} block_nvfp4;
```

- `MXFP4`：使用 E2M1 表示法（2 位指数、1 位尾数），每 32 元素共享 E8M0 scale
- `NVFP4`：每 16 元素子块单独 UE4M3 scale，块大小 64 元素

`LLAMA_FTYPE_MOSTLY_MXFP4_MOE`（值 38）专门为 MoE 模型设计：MoE 张量使用 MXFP4，非 MoE 张量使用 Q8_0，见 `src/llama-quant.cpp:461`。

### 13.3.7 BF16

BF16 是 Brain Float 16，16-bit 但指数范围与 FP32 相同（8-bit 指数，7-bit 尾数），相比 FP16 在数值稳定性上有优势，不视为"量化"但作为精简精度格式列在 `ggml_type` 中（值 30）。

---

## 13.4 文件级量化标识：llama_ftype

`llama_ftype` 是 GGUF 文件元数据中记录的整体量化策略，位于：

```c
// include/llama.h:117
enum llama_ftype {
    LLAMA_FTYPE_ALL_F32              = 0,
    LLAMA_FTYPE_MOSTLY_F16           = 1,
    LLAMA_FTYPE_MOSTLY_Q4_0          = 2,
    LLAMA_FTYPE_MOSTLY_Q4_1          = 3,
    LLAMA_FTYPE_MOSTLY_Q8_0          = 7,
    LLAMA_FTYPE_MOSTLY_Q2_K          = 10,
    LLAMA_FTYPE_MOSTLY_Q3_K_S        = 11,
    LLAMA_FTYPE_MOSTLY_Q3_K_M        = 12,
    LLAMA_FTYPE_MOSTLY_Q3_K_L        = 13,
    LLAMA_FTYPE_MOSTLY_Q4_K_S        = 14,
    LLAMA_FTYPE_MOSTLY_Q4_K_M        = 15,
    LLAMA_FTYPE_MOSTLY_Q5_K_S        = 16,
    LLAMA_FTYPE_MOSTLY_Q5_K_M        = 17,
    LLAMA_FTYPE_MOSTLY_Q6_K          = 18,
    LLAMA_FTYPE_MOSTLY_IQ2_XXS       = 19,
    // ... IQ 系列 ...
    LLAMA_FTYPE_MOSTLY_BF16          = 32,
    LLAMA_FTYPE_MOSTLY_TQ1_0         = 36,
    LLAMA_FTYPE_MOSTLY_TQ2_0         = 37,
    LLAMA_FTYPE_MOSTLY_MXFP4_MOE     = 38,
    LLAMA_FTYPE_MOSTLY_NVFP4         = 39,
    LLAMA_FTYPE_MOSTLY_Q1_0          = 40,
    LLAMA_FTYPE_GUESSED = 1024,
};
```

`llama_ftype` 是**文件级**声明，描述"大多数权重张量使用哪种格式"，而实际上每个张量的类型可能不同（output、embedding 等会用更高精度）。`llama_ftype_get_default_type()` 函数将 ftype 转换为对应的默认 `ggml_type`，在 `src/llama-quant.cpp:866` 调用。

---

## 13.5 量化流程：llama_model_quantize

### 入口点

```c
// include/llama.h:633
LLAMA_API uint32_t llama_model_quantize(
        const char * fname_inp,
        const char * fname_out,
        const llama_model_quantize_params * params);
```

量化参数结构体（`include/llama.h:404`）包含：

```c
typedef struct llama_model_quantize_params {
    int32_t nthread;                    // 量化线程数
    enum llama_ftype ftype;             // 目标 ftype
    enum ggml_type output_tensor_type;  // output 张量类型覆盖
    enum ggml_type token_embedding_type;// embedding 类型覆盖
    bool allow_requantize;              // 允许对已量化张量重量化
    bool quantize_output_tensor;        // 是否量化 output.weight
    bool only_copy;                     // 仅复制，不量化
    bool pure;                          // 所有张量统一使用默认类型
    bool keep_split;                    // 保持分片数量
    bool dry_run;                       // 仅计算大小，不实际量化
    const struct llama_model_imatrix_data * imatrix;     // 重要性矩阵
    const struct llama_model_kv_override * kv_overrides; // 元数据覆盖
    const struct llama_model_tensor_override * tt_overrides; // 张量类型覆盖
    const int32_t * prune_layers;       // 层剪枝
} llama_model_quantize_params;
```

### 实现核心

`llama_model_quantize_impl`（`src/llama-quant.cpp:857`）的主要步骤：

1. 用 `llama_model_loader` 加载源模型（支持 mmap）
2. 初始化 `quantize_state_impl`（记录各张量类别计数器）
3. 遍历所有张量，调用 `llama_tensor_get_type` 决定目标量化类型
4. 对每个张量调用 `llama_tensor_quantize_impl` 完成实际量化
5. 写入 GGUF 输出文件

### 张量分类

`src/llama-quant.cpp:25` 定义了张量类别枚举，`tensor_get_category`（第 115 行）通过匹配张量名称进行分类：

```c
enum class tensor_category {
    TOKEN_EMBD,
    ATTENTION_Q, ATTENTION_V, ATTENTION_K, ATTENTION_QKV, ATTENTION_KV_B,
    ATTENTION_OUTPUT,
    FFN_UP, FFN_GATE, FFN_DOWN,
    OUTPUT,
    OTHER
};
```

### 哪些张量保持高精度

`llama_tensor_get_type_impl`（`src/llama-quant.cpp:411`）包含所有特殊处理逻辑：

```c
// src/llama-quant.cpp:439
if (category == tensor_category::OUTPUT ||
    (qs.has_tied_embeddings && category == tensor_category::TOKEN_EMBD)) {
    // output.weight 默认保持 Q6_K（对于大多数 ftype）
    // 对于极低精度 ftype（IQ1/IQ2 系列），保持 Q5_K
    if (ftype == LLAMA_FTYPE_MOSTLY_IQ2_XXS || ...) {
        new_type = GGML_TYPE_Q5_K;
    } else if (new_type != GGML_TYPE_Q8_0) {
        new_type = GGML_TYPE_Q6_K;  // 默认
    }
}
```

关键规则：
- **output.weight**：默认升级到 Q6_K 或 Q5_K（比主体精度高），极端情况下为 Q8_0
- **token_embeddings**：根据 ftype 升级到 Q2_K 或 IQ3_S 等
- **attention_v（及 QKV 合并层）**：对于 IQ1/IQ2 等极低精度 ftype，自动升级到 Q4_K 或 Q2_K
- **1D 张量**（bias、norm weights）：不参与量化，保持原精度（F32/F16）

通过 `params->tt_overrides` 可以对特定张量名称进行精确的类型覆盖，用于高级调优。

### 多线程量化执行

`llama_tensor_quantize_impl`（`src/llama-quant.cpp:709`）将每个张量按行分块分发给多个线程：

```c
// src/llama-quant.cpp:712
size_t new_size = ggml_quantize_chunk(new_type, f32_data, new_data,
                                      0, nrows, n_per_row, imatrix);
// 多线程时按行分片：
size_t this_size = ggml_quantize_chunk(new_type, f32_data, new_data,
                                       first_row * n_per_row, this_nrow,
                                       n_per_row, imatrix);
```

---

## 13.6 imatrix：重要性矩阵

### 动机

在极低 bpw（IQ2 及以下）时，简单地最小化量化误差会导致模型质量急剧下降。不同权重通道对模型输出的影响差异极大——某些通道是"关键"的，量化误差对其影响更大。imatrix 通过统计权重在代表性数据集上的激活平方均值来近似每个通道的重要性。

### 收集过程

`tools/imatrix/imatrix.cpp` 中的 `IMatrixCollector`（第 61 行）通过注册 `ggml_backend_sched` 的回调函数，在模型推理时钩住所有 `GGML_OP_MUL_MAT` 操作：

```c
// tools/imatrix/imatrix.cpp:229
bool IMatrixCollector::collect_imatrix(struct ggml_tensor * t, bool ask, void * user_data) {
    // t 是 mul_mat 的输入张量（src1），统计其行的平方和
}
```

收集完成后将激活统计数据保存为 `.gguf`（新格式）或 `.dat`（旧格式）文件，包含每个权重矩阵的 `n_per_row` 个重要性分数。

典型用法：

```bash
llama-imatrix -m model.gguf -f calibration-data.txt -o imatrix.gguf \
    --chunk 512 --save-frequency 10
```

### imatrix 在量化中的作用

量化核函数（如 `quantize_iq2_xs`、`quantize_iq4_xs`）接受 `const float * quant_weights` 参数，该参数即来自 imatrix。权重选择量化码本时，高重要性通道的误差被赋予更大的惩罚权重，使量化结果更偏向保护重要通道的精度。

`ggml_quantize_requires_imatrix` 标记哪些类型强制要求 imatrix：

```c
// ggml/src/ggml.c:7660
bool ggml_quantize_requires_imatrix(enum ggml_type type) {
    return
        type == GGML_TYPE_IQ2_XXS ||
        type == GGML_TYPE_IQ2_XS  ||
        type == GGML_TYPE_IQ1_S;
}
```

没有 imatrix 对这三种类型调用 `ggml_quantize_chunk` 会触发 `GGML_ASSERT` 失败（`ggml.c:7679`）。

---

## 13.7 量化工具用法

### llama-quantize 工具

`tools/quantize/quantize.cpp` 包装了 `llama_model_quantize` API，提供命令行接口：

```bash
# 基本量化
llama-quantize input.gguf output.gguf Q4_K_M

# 使用 imatrix
llama-quantize --imatrix imatrix.gguf input.gguf output.gguf Q4_K_M

# 指定线程数、特定张量类型覆盖
llama-quantize --threads 8 \
    --tensor-type "blk.0.attn_q.weight=Q6_K" \
    input.gguf output.gguf Q4_K_M

# 干运行（只计算大小）
llama-quantize --dry-run input.gguf output.gguf Q4_K_M

# 仅复制（不量化，更改元数据）
llama-quantize input.gguf output.gguf COPY

# 列出所有可用量化类型
llama-quantize --list
```

### ggml-quants.c 中的量化/反量化核函数

所有量化格式在 `ggml/src/ggml-quants.c` 中都有对应的：
- `quantize_row_*_ref`：纯 C 参考实现（`ggml/src/ggml-quants.h:18-40`）
- `quantize_*`：支持 imatrix 的量化实现（`ggml/src/ggml-quants.c:2052`）
- `dequantize_row_*`：反量化实现（`ggml/src/ggml-quants.c:397`）

以 Q4_0 反量化为例（`ggml/src/ggml-quants.c:397`）：

```c
void dequantize_row_q4_0(const block_q4_0 * GGML_RESTRICT x,
                          float * GGML_RESTRICT y, int64_t k) {
    // 遍历每个 block，取 d（FP16 scale），将 4-bit 整数还原为 float
    for (int i = 0; i < nb; i++) {
        const float d = GGML_FP16_TO_FP32(x[i].d);
        for (int j = 0; j < QK4_0/2; ++j) {
            const int x0 = (x[i].qs[j] & 0x0F) - 8;
            const int x1 = (x[i].qs[j] >>   4) - 8;
            y[i*QK4_0 + 2*j + 0] = x0*d;
            y[i*QK4_0 + 2*j + 1] = x1*d;
        }
    }
}
```

统一入口 `ggml_quantize_chunk`（`ggml.c:7668`）是所有量化路径的公共接口，自动初始化量化码表并分发到对应的格式实现。

---

## 13.8 量化对推理路径的影响

### 反量化时机

量化权重**不在加载时解码**，而是在计算时按需处理。ggml 支持两种模式：

1. **即时反量化**（CPU 主路径）：在 `ggml_mul_mat` 的 CPU kernel 执行时，将量化权重行反量化为 FP32，再进行点积计算
2. **原生量化 kernel**（GPU 路径）：CUDA/Metal 后端实现了直接操作量化格式的 kernel，避免显式反量化，提高吞吐量

### CUDA 后端

CUDA 后端的量化矩阵乘法分为两条路径（`ggml/src/ggml-cuda/ggml-cuda.cu:2537`）：

- **MMVQ（Matrix-Vector Quantized）**：`ggml_cuda_mul_mat_vec_q`，适用于 batch size=1 的自回归解码阶段，直接处理量化 src0
- **MMQ（Matrix-Matrix Quantized）**：`ggml/src/ggml-cuda/mmq.cu`，适用于批处理 prefill；`src1` 在执行前被在线量化为 Q8_1（`quantize_mmq_q8_1_cuda`，第 385 行），然后与量化 src0 做整数点积

MXFP4/NVFP4 在 CUDA 后端有专用的 `quantize_mmq_mxfp4`（`ggml/src/ggml-cuda/quantize.cu:171`）和 `quantize_mmq_nvfp4`（第 74 行）kernel。

### Metal 后端（macOS/iOS）

Metal 后端通过 MSL shader 实现了 Q4_0、Q4_1、Q5_0、Q5_1、Q8_0、Q2_K、Q4_K、Q6_K、IQ4_NL 等格式的 GPU 加速 kernel，直接在 GPU 上处理量化数据，无需 CPU 介入。

### 量化对推理速度的影响

| 场景 | 量化收益 |
|------|---------|
| 解码（batch=1） | 主要受内存带宽限制，量化直接减少读取量，速度近线性提升 |
| 预填充（大 batch） | 受计算限制，量化减少的带宽效益相对较小，但仍有收益 |
| CPU 推理 | Q4_0/Q4_K 有 AVX2 SIMD 优化路径，速度显著快于 FP16 |

KV cache 也可以量化（通过 `LLAMA_ARG_CACHE_TYPE_K` / `LLAMA_ARG_CACHE_TYPE_V` 环境变量），支持 Q8_0、Q4_0 等格式，进一步减少 KV cache 的显存占用，但反量化会增加注意力计算的少量开销。

---

## 13.9 各量化类型选型建议

基于 `tools/quantize/quantize.cpp:34` 的基准数据及社区经验：

| 需求 | 推荐类型 | 说明 |
|------|---------|------|
| 最高精度，可接受大体积 | Q8_0 / BF16 | Q8_0 几乎无损（+0.003 ppl），BF16 数值稳定 |
| 性价比最优（推荐） | Q4_K_M | +0.18 ppl，适合大多数场景 |
| 略小体积 | Q4_K_S | 比 Q4_K_M 略小，精度略低 |
| 追求更高精度 | Q5_K_M / Q6_K | Q5_K_M +0.06 ppl，Q6_K +0.02 ppl |
| 极低显存（有 imatrix） | IQ4_XS / IQ4_NL | 约 4.25 bpw，比 Q4_0 更精确 |
| 显存极其紧张 | IQ2_M / IQ3_S | 需要 imatrix，质量下降较显著 |
| 三值模型（BitNet） | TQ1_0 / TQ2_0 | 仅适用于原生三值训练模型 |
| MoE 模型 GPU 加速 | MXFP4_MOE | 专为 Blackwell 等支持 FP4 的 GPU |

使用 imatrix 可以在同等 bpw 下将精度提升约 0.1-0.5 ppl，对 IQ 系列格式尤其关键。
