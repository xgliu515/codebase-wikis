# 第 4 章：特化 2-bit 量化与 imatrix

**代码版本**：antirez/ds4@c9dd949（2026-05-18）

---

## 目录

1. [为什么 DS4 能用 2-bit 运行](#1-为什么-ds4-能用-2-bit-运行)
2. [量化类型详解](#2-量化类型详解)
3. [激活量化：Q8_K 动态块](#3-激活量化q8_k-动态块)
4. [gguf-tools/ 目录结构与职责](#4-gguf-tools-目录结构与职责)
5. [imatrix：重要性矩阵](#5-imatrix重要性矩阵)
6. [质量测试体系](#6-质量测试体系)

---

## 1. 为什么 DS4 能用 2-bit 运行

DeepSeek V4 Flash 是 MoE（Mixture-of-Experts）架构：43 层，每层 256 个路由专家，每次推理每层激活其中 6 个。关键数字如下（`ds4.c:86-109`）：

```text
DS4_N_LAYER         = 43
DS4_N_EXPERT        = 256   路由专家总数
DS4_N_EXPERT_USED   = 6     每层每 token 激活的专家数
DS4_N_EMBD          = 4096  embedding 维度
DS4_N_FF_EXP        = 2048  每个路由专家的 FFN 中间宽度
```

每个路由专家持有三组矩阵（gate/up/down），形状分别为：
- gate_exps / up_exps：`[4096, 2048, 256]` — 每个专家是 `4096×2048`
- down_exps：`[2048, 4096, 256]` — 每个专家是 `2048×4096`

43 层 × 256 个专家 × 3 组 × (4096×2048 + 4096×2048) = 约 **540 亿参数**仅在路由专家中。

如果用 F16（2 字节/元素）存储，路由专家部分约需 100 GiB，超过了 96GB MacBook 的物理内存上限，即便是 128GB 也没有余量给 KV 缓存。

2-bit 量化的效果：

```text
IQ2_XXS: 256 元素 / 块, 66 字节 / 块 → 2.0625 bits/weight
Q2_K:    256 元素 / 块, 84 字节 / 块 → 2.625  bits/weight
```

以 IQ2_XXS 量化路由 gate/up，Q2_K 量化 down，整个路由专家部分降至约 **26-28 GiB**，搭配 Q8_0 注意力和共享层，总模型文件约 80-90 GiB，MacBook 96GB 可以运行，并留有足够空间给长上下文 KV 缓存。

---

## 2. 量化类型详解

### 2.1 全局量化类型表

ds4 运行时在 `ds4.c:856-886` 中定义了完整的 GGUF 类型注册表：

```c
/* ds4.c:856 */
static const gguf_type_info gguf_types[] = {
    [8]  = {"q8_0",    32,  34},   /* 每块 32 元素, 34 字节 */
    [10] = {"q2_k",   256,  84},
    [12] = {"q4_k",   256, 144},
    [15] = {"q8_k",   256, 292},
    [16] = {"iq2_xxs",256,  66},
    ...
};
```

推理代码专门处理的类型枚举（`ds4.c:888-896`）：

```c
enum {
    DS4_TENSOR_F32     = 0,
    DS4_TENSOR_F16     = 1,
    DS4_TENSOR_Q8_0    = 8,
    DS4_TENSOR_Q2_K    = 10,
    DS4_TENSOR_Q4_K    = 12,
    DS4_TENSOR_IQ2_XXS = 16,
    DS4_TENSOR_I32     = 26,
};
```

### 2.2 IQ2_XXS：路由专家 gate/up 权重

**IQ2_XXS**（Importance-Quantized 2-bit eXtra eXtra Small）是 llama.cpp 体系中最激进的 2-bit 格式。每块 256 个元素，共 66 字节，有效位率 2.0625 bits/weight。

块结构（`ds4.c:152-155`）：

```c
typedef struct {
    uint16_t d;              /* F16 scale */
    uint16_t qs[QK_K / 8];  /* 32 × uint16_t = 64 字节索引+符号 */
} block_iq2_xxs;
/* sizeof = 66 字节（编译时 assert 验证，ds4.c:161） */
```

每个 `uint16_t` 编码 8 个权重值：低 8 位是 256-entry 码本（`iq2xxs_grid[]`，`ds4.c:236`）的索引，高 8 位（实际是两个 `uint16_t` 合并后高 7 位 × 2 对）是符号位掩码，通过 `ksigns_iq2xs[]`（`ds4.c:225`）查表解码。

**为什么 IQ2_XXS 必须有 imatrix**：码本条目固定 256 个，对高方差列（即输入分布中激活强度大的列）量化误差会放大。imatrix 为每列提供重要性权重，使量化器在标度搜索（`ds4q_make_qkx2_quants()`）中优先减小高激活列的误差，而不是均匀最小化 L2。

`quants.c:54` 中 `requires_imatrix = true` 字段驱动 `ds4q_quantize_chunk()` 在无 imatrix 时触发合成后备策略（见第 4、5 节）。

**解量化内核**：`ds4.c:1889`（`ds4_vec_dot_iq2_xxs_q8_K`）实现了 ARM NEON dotprod 加速路径，对每 32 个权重，从 `iq2xxs_grid` 取两个 8 元素向量，乘以从 `ksigns_iq2xs` 取的符号向量，做整数 dot product，最后乘以块 scale。

### 2.3 Q2_K：路由专家 down 权重

**Q2_K** 是 K-quant 系列的 2-bit 成员，信噪比高于 IQ2_XXS，但每块 84 字节略大。

块结构（`ds4.c:132-137`）：

```c
typedef struct {
    uint8_t  scales[QK_K / 16];  /* 16 字节: 每个 sub-block 4+4 bits scale/min */
    uint8_t  qs[QK_K / 4];       /* 64 字节: 每元素 2 bits */
    uint16_t d;                   /* F16 全局 scale */
    uint16_t dmin;                /* F16 全局 min */
} block_q2_K;
/* sizeof = 84 字节（ds4.c:158 断言） */
```

256 元素分为 16 个 sub-block（每 sub-block 16 元素）。每个 sub-block 有独立的 4-bit scale 和 4-bit min，与全局 `d`/`dmin` 相乘得到实际 scale。这种分层结构使其在不需要 imatrix 的情况下仍能维持可接受的量化质量（`quants.c:48` 中 `requires_imatrix = false`）。

**用途分配**：Q2_K 用于路由专家的 **down 投影**（`ffn_down_exps`），而非 gate/up。这背后有语义原因：down 投影的输入是经 SwiGLU 激活后的中间层（已经被非线性挤压过），信息分布比 gate/up 的输入（layer norm 后的 embedding）更加均匀，Q2_K 的均匀量化误差不敏感，可接受不带 imatrix。

解量化内核（`ds4.c:1769`，`ds4_vec_dot_q2_K_q8_K`）：ARM NEON DOTPROD 实现中，利用 `vdotq_s32` 同时处理两路 2-bit 权重，每 32 个权重一轮，性能约是标量路径的 4×。

### 2.4 Q8_0：dense 投影与词表

**Q8_0** 是最简单的量化格式：每块 32 元素，34 字节。

```c
/* gguf_types[8] = {"q8_0", 32, 34} */
/* 结构: uint16_t d (F16 scale) + int8_t qs[32] */
```

用于注意力矩阵（`attn_q_a`, `attn_q_b`, `attn_kv`, `attn_output_a/b`）、共享专家（`ffn_gate_shexp`, `ffn_up_shexp`, `ffn_down_shexp`）以及最终输出词表投影（`output.weight`）。

这些张量的激活强度高（每 token 必须计算，路由命中率 100%），精度损失会直接影响全局质量，因此选用 Q8_0 而非更低 bit 的格式。

### 2.5 Q8_K：激活量化临时块

**Q8_K** 与 Q8_0 不同：它专用于**激活向量**（而非权重存储），是在 CPU 推理路径中把 float 激活量化成整数以便与 Q2_K/IQ2_XXS 权重做高效 dot product 的中间格式。块大小 256 元素，292 字节（见第 3 节详述）。

### 2.6 F16：高精度层

F16 用于：
- `token_embd.weight`（词嵌入，`[129280, 4096]`）
- 压缩器和索引器权重（`attn_compressor_*`, `indexer_compressor_*`）
- 路由 gate 权重（`ffn_gate_inp.weight`，`[4096, 256]`）
- 超连接（Hyper-Connection）函数权重（`hc_attn_fn`, `hc_ffn_fn`）

这些张量或者尺寸小（路由 gate 矩阵 4096×256 = 4M 元素，F16 仅 8MB）、或者对精度敏感（词嵌入作为整个推理链的起点），不值得为节省内存而降低精度。

---

## 3. 激活量化：Q8_K 动态块

### 原理

路由专家的 gate/up（IQ2_XXS）和 down（Q2_K）内核要求激活向量也是整数格式，才能使用 DOTPROD 指令做 INT8×INT8 计算。CPU 推理路径在每次专家调用前，把浮点激活即时量化为 Q8_K 块。

**Q8_K 块结构**（`ds4.c:146-150`）：

```c
typedef struct {
    float   d;                   /* F32 全局 scale（不是 F16！）*/
    int8_t  qs[QK_K];            /* 256 × INT8 量化值 */
    int16_t bsums[QK_K / 16];    /* 每 16 元素的 INT8 部分和，Q2_K 点积加速 */
} block_q8_K;
/* sizeof = 292 字节（ds4.c:160 断言） */
```

与权重格式用 F16 scale 不同，Q8_K 用 F32 scale，原因是它在计算期间动态生成，不需要极小的存储空间，F32 可避免额外的转换精度损失。`bsums` 字段专为 Q2_K 的 min 项累加优化：Q2_K dot product 公式中有 `dmin × sum(q8)` 项，提前存储 16 元素小和可减少运行时计算量（`ds4.c:1858`）。

### ds4_quantize_row_q8_K 实现

`ds4.c:1727-1767`：

```c
/* ds4.c:1727 */
static void ds4_quantize_row_q8_K(const float *x, block_q8_K *y, int64_t k) {
    if (k % QK_K != 0) ds4_die("Q8_K quantization length is not QK_K aligned");
    const int64_t nb = k / QK_K;

    for (int64_t b = 0; b < nb; b++) {
        /* 找块内绝对值最大的元素，用它的有符号值作为 scale 基准 */
        float max = 0.0f, amax = 0.0f;
        for (int j = 0; j < QK_K; j++) {
            const float ax = fabsf(x[j]);
            if (ax > amax) { amax = ax; max = x[j]; }
        }

        const float iscale = -127.0f / max;   /* 负号处理有符号/无符号 */
        for (int j = 0; j < QK_K; j++) {
            int v = (int)lrintf(iscale * x[j]);
            v = v > 127 ? 127 : (v < -128 ? -128 : v);
            y[b].qs[j] = (int8_t)v;
        }
        /* 计算 bsums：每 16 元素求和，供 Q2_K dot product 使用 */
        for (int j = 0; j < QK_K / 16; j++) {
            int sum = 0;
            for (int i = 0; i < 16; i++) sum += y[b].qs[j * 16 + i];
            y[b].bsums[j] = (int16_t)sum;
        }
        y[b].d = 1.0f / iscale;
        x += QK_K;
    }
}
```

关键设计决策：
- 以**最大有符号值**（而非绝对值最大）作为 scale 基准，保留符号方向；
- `iscale = -127 / max`：当 `max > 0` 时 `iscale < 0`，量化公式 `iscale * x` 对正值产生负的整数，对负值产生正值，然后存入 INT8（使绝对最大值映射到 ±127）；
- 饱和钳位到 `[-128, 127]`，防止溢出。

### 调用点

CPU 推理路径中，在进入专家矩阵乘法前调用（`ds4.c:3994, 4119, 4142, 5385, 5404`）：

```c
/* ds4.c:3994 */
ds4_quantize_row_q8_K(x, xq, (int64_t)in_dim);
/* xq 随后被多个专家行的 dot product 共享 */
```

**共享激活向量**是关键优化：一次 Q8_K 量化的结果可被同一层被激活的 6 个专家复用，而不是每个专家单独量化一次。

---

## 4. gguf-tools/ 目录结构与职责

```text
gguf-tools/
  deepseek4-quantize.c   HF safetensors -> GGUF 量化器（主程序）
  quants.c               量化基础库实现
  quants.h               量化 API（类型枚举、函数声明）
  imatrix/               imatrix 数据集与采集说明
    dataset/
      build_ds4_imatrix_dataset.py  生成校准数据集的脚本
  quality-testing/       量化质量评测工具
    collect_official.py  从 DeepSeek API 采集官方 continuation
    compare_scores.py    对比两个 GGUF 变体的 NLL 分数
    score_official.c     本地 GGUF 对官方 continuation 打分
    prompts.jsonl        100 条测试 prompt
  Makefile               构建规则（纯 C，不依赖 GGML）
  README.md              使用说明
```

### 4.1 quants.h 与 quants.c

`quants.h` 定义了量化库的公开 API（`gguf-tools/quants.h:18-75`）：

- 类型枚举 `ds4q_type`，值与 GGUF 类型 ID 一致，保证模板元数据无需翻译即可复用；
- `ds4q_requires_imatrix(type)`：返回该类型是否强制需要 imatrix（仅 IQ2_XXS 系列为 true）；
- `ds4q_quantize_chunk(type, src, dst, start, nrows, ncols, imatrix)`：主量化接口，支持分块并行；
- `ds4q_block_size()` / `ds4q_row_size()`：查询对齐和字节大小。

`quants.c` 的特征表（`quants.c:39-74`）：

```c
static const ds4q_traits ds4q_type_traits[DS4Q_TYPE_COUNT] = {
    [DS4Q_TYPE_Q8_0]    = { "q8_0",   32,  34, true,  false },
    [DS4Q_TYPE_Q2_K]    = { "q2_K",  256,  84, true,  false },
    [DS4Q_TYPE_Q4_K]    = { "q4_K",  256, 144, true,  false },
    [DS4Q_TYPE_IQ2_XXS] = { "iq2_xxs",256, 66, true,  true  },
    ...
};
```

最后两个字段：`can_quantize`（是否支持量化输出）和 `requires_imatrix`（是否强制要求 imatrix）。

`quants.c` 的量化实现直接源自 MIT 许可的 GGML/llama.cpp，经过精简仅保留 DS4 需要的 4 种输出格式（Q8_0、Q2_K、Q4_K、IQ2_XXS）。文件开头注释（`quants.c:9`）明确说明"字节布局兼容性比通用性更重要"——目标是保持与 llama.cpp 生成的 GGUF 字节级互通。

### 4.2 deepseek4-quantize.c

这是离线量化的主程序（1888 行，纯 C，无 GGML 依赖）。核心功能：

**输入/输出流程**（`deepseek4-quantize.c:1-19`）：

<svg viewBox="0 0 640 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="deepseek4-quantize.c input/output data flow: HF safetensors and template GGUF merge into quantizer, then output GGUF">
  <defs>
    <marker id="ar41" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="40" y="20" width="240" height="80" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="160" y="46" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">HF safetensors</text>
  <text x="160" y="63" text-anchor="middle" font-size="11" fill="#64748b">FP8 E4M3 权重（dense）</text>
  <text x="160" y="79" text-anchor="middle" font-size="11" fill="#64748b">FP4 packed 权重（路由专家）</text>
  <rect x="40" y="140" width="240" height="56" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="160" y="163" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">模板 GGUF</text>
  <text x="160" y="181" text-anchor="middle" font-size="11" fill="#64748b">元数据 · 张量名顺序 · shape</text>
  <rect x="360" y="140" width="220" height="56" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="470" y="163" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">可选 imatrix</text>
  <text x="470" y="181" text-anchor="middle" font-size="11" fill="#64748b">每层每专家每列 激活平方统计</text>
  <rect x="160" y="250" width="300" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="310" y="276" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">目标类型量化</text>
  <text x="310" y="295" text-anchor="middle" font-size="11" fill="#64748b">Q8_0 / Q2_K / Q4_K / IQ2_XXS</text>
  <rect x="210" y="360" width="200" height="44" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/>
  <text x="310" y="387" text-anchor="middle" font-size="14" font-weight="700" fill="#ea580c">输出 GGUF</text>
  <line x1="160" y1="100" x2="160" y2="130" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar41)"/>
  <text x="162" y="120" font-size="10" fill="#94a3b8">FP8→F32 / FP4→F32</text>
  <line x1="160" y1="196" x2="220" y2="240" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar41)"/>
  <line x1="470" y1="196" x2="400" y2="240" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar41)"/>
  <line x1="310" y1="310" x2="310" y2="350" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar41)"/>
</svg>
<span class="figure-caption">图 R4.1 ｜ deepseek4-quantize.c 输入/输出数据流：HF safetensors + 模板 GGUF（+ 可选 imatrix）→ 量化 → 输出 GGUF</span>

<details>
<summary>ASCII 原版</summary>

```
HF safetensors（FP8 E4M3 权重）
    |-- FP8 E4M3 + E8M0 → F32 反量化
    |-- FP4 packed + E8M0 → F32 反量化（路由专家专用）
    |
    +-- 模板 GGUF（提供元数据、张量名顺序、张量 shape）
    |
    v
目标类型量化（Q8_0 / Q2_K / Q4_K / IQ2_XXS）
    |
    +-- [可选 imatrix]
    v
输出 GGUF
```

</details>

**量化策略 API**（`deepseek4-quantize.c:1699-1713`）：

```text
--experts TYPE          路由 gate/up/down 全部设为 TYPE
--routed-w1 TYPE        路由 gate 专家类型
--routed-w2 TYPE        路由 down 专家类型
--routed-w3 TYPE        路由 up 专家类型
--attention-proj TYPE   attn_q/kv/output 投影
--shared TYPE           共享专家
--output TYPE           output.* 词表
--dense TYPE            其余 2D+ 非路由张量
--tensor-type PFX=TYPE  精确覆盖
```

**模板机制**（`deepseek4-quantize.c:11`）：量化器不自行生成 GGUF 元数据和张量名顺序，而是从已有的**模板 GGUF** 中复制这些信息，仅替换张量字节内容。这保证了字段名兼容性，并允许在多次量化实验中保持相同的元数据。

**路由专家多线程**（`deepseek4-quantize.c:1245-1259`）：256 个专家的量化通过 `pthreads` 并行，`--threads N` 控制工作线程数（默认 8）。每个专家独立读取 FP4 safetensor、反量化到 F32、应用 imatrix 量化成目标格式，写入输出缓冲区的对应切片。

**FP4 路由专家反量化**（`deepseek4-quantize.c:1233`）：HF safetensors 中路由专家使用 `FP4 + E8M0` 格式（每行 2 列打包成一个 uint8）。`dequant_fp4_weight()` 完成 FP4→F32 展开，得到 `[in_dim × 2, out_dim / 2]` 形状（注意 HF 和 GGUF 的形状转置关系）。

### 4.3 imatrix/ 子目录

`imatrix/dataset/` 包含 `build_ds4_imatrix_dataset.py`，生成 ds4 格式的校准语料（带 `===== DS4_IMATRIX_PROMPT` 分隔符的渲染对话文本），输出到 `rendered_prompts.txt`。

采集命令（来自 `gguf-tools/README.md:37-42`）：

```sh
./ds4 \
  -m gguf/MODEL.gguf \
  --imatrix-dataset gguf-tools/imatrix/dataset/rendered_prompts.txt \
  --imatrix-out gguf/ds4-imatrix.dat \
  --ctx 32768
```

### 4.4 quality-testing/ 子目录

见第 6 节详述。

---

## 5. imatrix：重要性矩阵

### 5.1 概念与必要性

**Importance Matrix（imatrix）** 是对每个路由专家张量的**每列**估算一个重要性权重向量，反映该列在真实推理激活中的平均平方贡献：

```text
imatrix[col] ≈ mean_over_tokens(activation[col]^2)
```

2-bit 量化（IQ2_XXS）的码本只有 256 个条目，即便加上符号位也只能表示有限的值域。对于高方差列（在实际输入中经常被强激活的列），统一最小化 L2 误差会把量化预算浪费在低激活列上，高激活列反而误差较大，放大输出误差。

imatrix 给量化器提供列权重：

```text
weighted_L2_error = sum_j( imatrix[j] * (x[j] - quant(x[j]))^2 )
```

量化器在搜索最优 scale 时最小化加权误差，使高激活列获得更精确的量化。

### 5.2 ds4 的采集实现

#### 数据结构

`ds4_imatrix_collector`（`ds4.c:13007-13022`）：

```c
typedef struct {
    float *gate_up_sum2;   /* [layer][expert][4096]  gate/up 列平方和 */
    float *down_sum2;      /* [layer][expert][2048]  down  列平方和 */
    uint32_t gate_up_count[DS4_N_LAYER][DS4_N_EXPERT];
    uint32_t down_count[DS4_N_LAYER][DS4_N_EXPERT];
    float *ffn_norm_buf;       /* 暂存 FFN norm 输出（激活向量）*/
    float *routed_mid_buf;     /* 暂存路由专家中间层输出（F32）*/
    uint16_t *routed_mid_f16_buf; /* 同上 F16 变体 */
    int *selected_buf;         /* 每 token 激活的专家 ID */
    float *sq_tmp;             /* 逐元素平方的临时缓冲 */
    uint32_t cap_tokens;
    uint64_t observed_tokens;
    uint64_t observed_routes;
    uint32_t chunks;
    const char *dataset_path;
} ds4_imatrix_collector;
```

采集粒度是**每层、每专家、每列**，分别对 gate/up（输入 4096 维）和 down（输入 2048 维）维护累积平方和。

#### 每层批次采集

`imatrix_collect_layer_batch()`（`ds4.c:13061-13114`）在推理图执行后，从 GPU 读回三个张量（`ds4.c:13076-13078`）：

```c
ds4_gpu_tensor_read(g->batch_ffn_norm,        0, c->ffn_norm_buf,   norm_bytes);
ds4_gpu_tensor_read(g->batch_routed_mid,      0, mid_dst,           mid_bytes);
ds4_gpu_tensor_read(g->batch_router_selected, 0, c->selected_buf,   sel_bytes);
```

- `batch_ffn_norm`：FFN RMSNorm 输出，即路由专家 gate/up 的实际输入激活；
- `batch_routed_mid`：gate × up（SwiGLU 输出），即 down 矩阵的输入；
- `batch_router_selected`：每 token 选中的专家 ID 列表。

然后（`ds4.c:13083-13113`）：

```c
/* 对每个 token 和每个激活专家 */
for (uint32_t t = 0; t < n_tokens; t++) {
    const float *x = c->ffn_norm_buf + t * DS4_N_EMBD;
    for (uint32_t i = 0; i < DS4_N_EMBD; i++)
        c->sq_tmp[i] = x[i] * x[i];  /* 激活平方 */

    for (uint32_t slot = 0; slot < DS4_N_EXPERT_USED; slot++) {
        int expert = c->selected_buf[t * DS4_N_EXPERT_USED + slot];
        float *gate_up = imatrix_gate_up_ptr(c, il, expert);
        for (uint32_t i = 0; i < DS4_N_EMBD; i++)
            gate_up[i] += c->sq_tmp[i];  /* 累积到对应专家的列统计 */
        c->gate_up_count[il][expert]++;

        /* 类似处理 down 矩阵的 mid 激活 */
    }
}
```

关键是**只对实际被路由到的专家累积统计**，未被激活的专家保持 0，因此稀疏激活的专家会天然有更小的 imatrix 值（从而允许更大的量化误差）。

#### 输出格式

采集完成后，`imatrix_collector_save()`（`ds4.c:13150`）以 llama.cpp 的 legacy `.dat` 格式输出：

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="imatrix .dat binary file layout: header n_entries, repeated entry records, footer n_chunks and dataset_path">
  <defs>
    <marker id="ar42" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">imatrix .dat 文件布局</text>
  <rect x="20" y="36" width="720" height="36" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="380" y="58" text-anchor="middle" font-size="12" font-weight="600" fill="#7c3aed">int32  n_entries</text>
  <text x="692" y="58" text-anchor="end" font-size="10" fill="#94a3b8">文件头</text>
  <rect x="20" y="82" width="720" height="100" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="102" text-anchor="middle" font-size="11" fill="#64748b">重复 n_entries 次</text>
  <rect x="40" y="110" width="120" height="60" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="100" y="130" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">int32</text>
  <text x="100" y="147" text-anchor="middle" font-size="10" fill="#64748b">name_len</text>
  <rect x="172" y="110" width="120" height="60" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="232" y="130" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">char[]</text>
  <text x="232" y="147" text-anchor="middle" font-size="10" fill="#64748b">name</text>
  <text x="232" y="162" text-anchor="middle" font-size="10" fill="#94a3b8">(张量 GGUF 名)</text>
  <rect x="304" y="110" width="100" height="60" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="354" y="130" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">int32</text>
  <text x="354" y="147" text-anchor="middle" font-size="10" fill="#64748b">ncall</text>
  <rect x="416" y="110" width="100" height="60" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="466" y="130" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">int32</text>
  <text x="466" y="147" text-anchor="middle" font-size="10" fill="#64748b">nval</text>
  <rect x="528" y="110" width="192" height="60" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="624" y="130" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">float32[]  values</text>
  <text x="624" y="147" text-anchor="middle" font-size="10" fill="#64748b">n_expert × n_cols 个 float</text>
  <text x="624" y="162" text-anchor="middle" font-size="10" fill="#94a3b8">= nval 个</text>
  <rect x="20" y="194" width="720" height="36" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="280" y="216" text-anchor="middle" font-size="12" font-weight="600" fill="#7c3aed">int32  n_chunks</text>
  <text x="550" y="216" text-anchor="middle" font-size="12" font-weight="600" fill="#7c3aed">int32  dataset_len</text>
  <text x="692" y="216" text-anchor="end" font-size="10" fill="#94a3b8">文件尾</text>
  <rect x="20" y="242" width="720" height="36" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="380" y="264" text-anchor="middle" font-size="12" font-weight="600" fill="#7c3aed">char[]  dataset_path</text>
  <text x="160" y="292" text-anchor="middle" font-size="10" fill="#94a3b8">切片访问：values + expert_id × ncols</text>
</svg>
<span class="figure-caption">图 R4.2 ｜ imatrix .dat 二进制文件布局：文件头记录条目数，主体重复存储每张量的重要性向量，文件尾记录数据集路径</span>

<details>
<summary>ASCII 原版</summary>

```
[int32 n_entries]
  [int32 name_len][char[] name][int32 ncall][int32 nval][float32[] values]
  ...
[int32 n_chunks]
[int32 dataset_len][char[] dataset_path]
```

</details>

张量名格式采用 ds4 的 GGUF 名（如 `blk.0.ffn_gate_exps.weight`），存储方式是 **n_experts 个专家向量连续排列**（`ds4.c:13003-13005`）：

```text
一个 imatrix 条目包含 n_expert * n_columns 个 float，
量化器从中切片 values + expert_id * ncols 得到单个专家的重要性向量。
```

#### CLI 参数

`ds4_cli.c:163-170`（`--imatrix-*` 参数）：

```text
--imatrix-dataset FILE    校准数据集文件（ds4 渲染格式）
--imatrix-out FILE        输出 .dat 文件路径
--imatrix-max-prompts N   最多处理 N 个 prompt 后停止
--imatrix-max-tokens N    最多处理 N 个 token 后停止
```

两个参数必须同时指定（`ds4_cli.c:1326-1331`），否则报错。

`ds4_engine_collect_imatrix()`（`ds4.h:114-119`，实现 `ds4.c:16792`）是对外暴露的 API：

```c
int ds4_engine_collect_imatrix(ds4_engine *e,
                               const char *dataset_path,
                               const char *output_path,
                               int ctx_size,
                               int max_prompts,
                               int max_tokens);
```

**当前限制**（`ds4.c:16809-16811`）：imatrix 采集只支持 Metal 后端，CPU 和 CUDA 不支持，因为 CPU 路径没有将中间激活保留在独立 GPU 张量中，无法高效批量读回。

### 5.3 无 imatrix 时的合成后备

当 IQ2_XXS 量化被请求但未提供 imatrix 时（`deepseek4-quantize.c:1117-1124`）：

```c
if (!im_ptr && ds4q_requires_imatrix(type)) {
    synthetic = xcalloc((size_t)ncols, sizeof(float));
    for (int64_t r = 0; r < nrows; r++) {
        const float *row = src + r * ncols;
        for (int64_t c = 0; c < ncols; c++)
            synthetic[c] += row[c] * row[c];  /* 权重能量启发 */
    }
    im_ptr = synthetic;
}
```

这是权重能量启发（`gguf-tools/README.md:121`）：

```text
importance[column] = sum_rows(weight[row][column]^2)
```

直觉：权重绝对值大的列对输出影响更大（即便不知道激活分布），使用权重自身的方差作为列重要性代理。这比均匀量化要好，但不如真实激活统计——`gguf-tools/README.md:121` 称其为"足够支撑第一个可用的 2-bit GGUF"，建议正式发布时使用真实 imatrix。

---

## 6. 质量测试体系

### 6.1 官方 Continuation 对比方法

质量测试使用**目标 token 负对数似然（NLL）**作为指标，而非采样一次输出比对（`quality-testing/README.md`）：

```text
metric = mean_{prompt p} mean_{token t in continuation_p}( -log P_model(t | prefix_t) )
```

低 NLL 意味着本地 GGUF 模型对官方 DeepSeek API 输出的每个 token 都赋予了高概率——即行为与官方一致。该指标确定性强，可重复，不受采样随机性影响。

### 6.2 测试流程

**步骤 1：采集官方 continuation**（`quality-testing/collect_official.py`）

从 DeepSeek API 获取 100 个 prompt 各自的 24 token 官方 continuation，写入 `data/manifest.tsv`。

**步骤 2：构建打分器**（`quality-testing/score_official.c`）

链接 DS4 运行时，针对每个 prompt，调用 `ds4_engine_first_token_test()` 和完整的 prefill 路径，计算本地模型对官方 continuation 每个 token 的 log probability。

**步骤 3：打分**

```sh
gguf-tools/quality-testing/score_official \
  MODEL.gguf \
  quality-testing/data/manifest.tsv \
  /tmp/model.tsv \
  4096     # context size
```

**步骤 4：对比两个变体**

```sh
python3 quality-testing/compare_scores.py /tmp/old.tsv /tmp/new.tsv
```

输出字段（`quality-testing/README.md:63-72`）：
- `avg_nll`：平均负对数似然，越低越好；
- `delta_new_minus_old`：负值表示新 GGUF 更接近官方；
- `case_wins_new_old_ties`：逐 case NLL 胜负统计；
- `first_token_matches`：本地贪心第一 token 与官方一致的比例；
- `avg_greedy_lcp`：贪心解码最长公共前缀均值。

### 6.3 tests/ 目录的正确性测试

`tests/test-vectors/` 包含固定的官方 logit 向量（`official.vec`），由 `fetch_official_vectors.py` 从 API 采集生成。`ds4_test.c` 中的集成测试对比本地推理输出的 logit 分布与官方参考，确保推理实现的正确性不因代码变更而退化。

`tests/ds4_test.c:1-43` 展示了测试框架接口：

```c
static ds4_engine *test_get_engine(bool quality) {
    ds4_engine_options opt = {
        .model_path = test_model_path(),  /* 环境变量 DS4_TEST_MODEL */
        .backend = DS4_BACKEND_METAL,     /* 或 CUDA */
        .quality = quality,               /* 精度模式 */
    };
    TEST_ASSERT(ds4_engine_open(slot, &opt) == 0);
    return *slot;
}
```

`tests/cuda_long_context_smoke.c` 专门测试 CUDA 路径在长上下文（32768+ token）下的正确性，对应 `tests/long_context_*.txt` 中的压力测试 prompt。

---

## 量化格式与用途速查

<svg viewBox="0 0 760 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="DS4 quantization format lookup table: tensor role, format, bits per weight, imatrix required">
  <rect x="10" y="10" width="740" height="380" rx="6" fill="none" stroke="#cbd5e1" stroke-width="1"/>
  <rect x="10" y="10" width="740" height="36" rx="6" fill="#f1f5f9"/>
  <line x1="10" y1="46" x2="750" y2="46" stroke="#cbd5e1" stroke-width="1"/>
  <text x="220" y="33" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">张量角色</text>
  <text x="490" y="33" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">量化格式</text>
  <text x="596" y="33" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">bits/w</text>
  <text x="690" y="33" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">需要 imatrix</text>
  <line x1="400" y1="10" x2="400" y2="390" stroke="#cbd5e1" stroke-width="0.8"/>
  <line x1="560" y1="10" x2="560" y2="390" stroke="#cbd5e1" stroke-width="0.8"/>
  <line x1="636" y1="10" x2="636" y2="390" stroke="#cbd5e1" stroke-width="0.8"/>
  <rect x="11" y="47" width="738" height="30" rx="0" fill="#fff7ed"/>
  <text x="220" y="66" text-anchor="middle" font-size="12" fill="currentColor">路由专家 gate/up</text>
  <text x="480" y="66" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">IQ2_XXS</text>
  <text x="596" y="66" text-anchor="middle" font-size="12" fill="#64748b">2.06</text>
  <text x="690" y="66" text-anchor="middle" font-size="12" font-weight="600" fill="#dc2626">是（或合成代替）</text>
  <line x1="10" y1="77" x2="750" y2="77" stroke="#cbd5e1" stroke-width="0.6"/>
  <rect x="11" y="78" width="738" height="30" rx="0" fill="#fff7ed"/>
  <text x="220" y="97" text-anchor="middle" font-size="12" fill="currentColor">路由专家 down</text>
  <text x="480" y="97" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">Q2_K</text>
  <text x="596" y="97" text-anchor="middle" font-size="12" fill="#64748b">2.63</text>
  <text x="690" y="97" text-anchor="middle" font-size="12" fill="#16a34a">否</text>
  <line x1="10" y1="108" x2="750" y2="108" stroke="#cbd5e1" stroke-width="0.6"/>
  <text x="220" y="127" text-anchor="middle" font-size="12" fill="#94a3b8">[可选] 路由专家 gate/up/down</text>
  <text x="480" y="127" text-anchor="middle" font-size="12" fill="#7c3aed">Q4_K</text>
  <text x="596" y="127" text-anchor="middle" font-size="12" fill="#64748b">4.5</text>
  <text x="690" y="127" text-anchor="middle" font-size="12" fill="#16a34a">否</text>
  <line x1="10" y1="138" x2="750" y2="138" stroke="#cbd5e1" stroke-width="0.6"/>
  <rect x="11" y="139" width="738" height="90" rx="0" fill="#f0f9ff"/>
  <text x="220" y="158" text-anchor="middle" font-size="12" fill="currentColor">注意力投影（q, kv, out）</text>
  <text x="480" y="158" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">Q8_0</text>
  <text x="596" y="158" text-anchor="middle" font-size="12" fill="#64748b">8.5</text>
  <text x="690" y="158" text-anchor="middle" font-size="12" fill="#16a34a">否</text>
  <line x1="10" y1="169" x2="750" y2="169" stroke="#cbd5e1" stroke-width="0.6"/>
  <text x="220" y="188" text-anchor="middle" font-size="12" fill="currentColor">共享专家</text>
  <text x="480" y="188" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">Q8_0</text>
  <text x="596" y="188" text-anchor="middle" font-size="12" fill="#64748b">8.5</text>
  <text x="690" y="188" text-anchor="middle" font-size="12" fill="#16a34a">否</text>
  <line x1="10" y1="199" x2="750" y2="199" stroke="#cbd5e1" stroke-width="0.6"/>
  <text x="220" y="218" text-anchor="middle" font-size="12" fill="currentColor">输出词表（output.weight）</text>
  <text x="480" y="218" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">Q8_0</text>
  <text x="596" y="218" text-anchor="middle" font-size="12" fill="#64748b">8.5</text>
  <text x="690" y="218" text-anchor="middle" font-size="12" fill="#16a34a">否</text>
  <line x1="10" y1="229" x2="750" y2="229" stroke="#cbd5e1" stroke-width="0.6"/>
  <rect x="11" y="230" width="738" height="120" rx="0" fill="#f1f5f9"/>
  <text x="220" y="249" text-anchor="middle" font-size="12" fill="currentColor">词嵌入（token_embd）</text>
  <text x="480" y="249" text-anchor="middle" font-size="12" fill="#0ea5e9">F16</text>
  <text x="596" y="249" text-anchor="middle" font-size="12" fill="#64748b">16</text>
  <text x="690" y="249" text-anchor="middle" font-size="12" fill="#94a3b8">—</text>
  <line x1="10" y1="260" x2="750" y2="260" stroke="#cbd5e1" stroke-width="0.6"/>
  <text x="220" y="279" text-anchor="middle" font-size="12" fill="currentColor">压缩器 / 索引器权重</text>
  <text x="480" y="279" text-anchor="middle" font-size="12" fill="#0ea5e9">F16</text>
  <text x="596" y="279" text-anchor="middle" font-size="12" fill="#64748b">16</text>
  <text x="690" y="279" text-anchor="middle" font-size="12" fill="#94a3b8">—</text>
  <line x1="10" y1="290" x2="750" y2="290" stroke="#cbd5e1" stroke-width="0.6"/>
  <text x="220" y="309" text-anchor="middle" font-size="12" fill="currentColor">路由 gate 权重矩阵 / 超连接权重</text>
  <text x="480" y="309" text-anchor="middle" font-size="12" fill="#0ea5e9">F16</text>
  <text x="596" y="309" text-anchor="middle" font-size="12" fill="#64748b">16</text>
  <text x="690" y="309" text-anchor="middle" font-size="12" fill="#94a3b8">—</text>
  <line x1="10" y1="320" x2="750" y2="320" stroke="#cbd5e1" stroke-width="0.6"/>
  <text x="220" y="339" text-anchor="middle" font-size="12" fill="currentColor">RMSNorm / 标量参数</text>
  <text x="480" y="339" text-anchor="middle" font-size="12" fill="#64748b">F32</text>
  <text x="596" y="339" text-anchor="middle" font-size="12" fill="#64748b">32</text>
  <text x="690" y="339" text-anchor="middle" font-size="12" fill="#94a3b8">—</text>
  <line x1="10" y1="350" x2="750" y2="350" stroke="#cbd5e1" stroke-width="0.6"/>
  <rect x="11" y="351" width="738" height="38" rx="0" fill="#f0fdf4"/>
  <text x="220" y="374" text-anchor="middle" font-size="12" fill="#64748b">激活向量（临时，运行时生成）</text>
  <text x="480" y="374" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">Q8_K</text>
  <text x="596" y="374" text-anchor="middle" font-size="12" fill="#64748b">9.1</text>
  <text x="690" y="374" text-anchor="middle" font-size="12" fill="#94a3b8">—</text>
</svg>
<span class="figure-caption">图 R4.3 ｜ DS4 各张量角色对应的量化格式、位宽与 imatrix 需求速查表</span>

<details>
<summary>ASCII 原版</summary>

```
张量角色                   量化格式       bits/w   需要 imatrix
--------------------------------------------------------
路由专家 gate/up           IQ2_XXS       2.06     是（或合成代替）
路由专家 down              Q2_K          2.63     否
[可选] 路由专家 gate/up/down Q4_K        4.5      否
注意力投影（q,kv,out）     Q8_0          8.5      否
共享专家                   Q8_0          8.5      否
输出词表（output.weight）  Q8_0          8.5      否
词嵌入（token_embd）       F16           16       —
压缩器 / 索引器权重        F16           16       —
路由 gate 权重矩阵         F16           16       —
超连接权重                 F16           16       —
RMSNorm / 标量参数         F32           32       —
激活向量（临时）           Q8_K          9.1      — (运行时生成)
```

</details>

---

**参考章节**：[第 3 章：GGUF 加载与模型初始化](./03-gguf-loading.md)
