# 第 11 章：CUDA 后端

> 代码版本：antirez/ds4@c9dd949（2026-05-18）

---

## 目录

1. [定位与目标平台](#1-定位与目标平台)
2. [文件结构](#2-文件结构)
3. [`ds4_cuda.cu` 内部结构](#3-ds4_cudacu-内部结构)
4. [与 Metal 路径的对应关系](#4-与-metal-路径的对应关系)
5. [命令批量模型：cudaDeviceSynchronize 作为 end_commands](#5-命令批量模型)
6. [模型权重加载策略](#6-模型权重加载策略)
7. [Q8→F16 预缓存（`cuda_q8_f16_range`）](#7-q8f16-预缓存)
8. [主要 Kernel 分类](#8-主要-kernel-分类)
9. [构建：Makefile 中的 CUDA 分支](#9-构建makefile-中的-cuda-分支)
10. [最近修正：压缩 Prefill RoPE positions（c9dd949）](#10-最近修正压缩-prefill-rope-positions)
11. [长上下文冒烟测试](#11-长上下文冒烟测试)
12. [关键环境变量](#12-关键环境变量)

---

## 1. 定位与目标平台

CUDA 后端是 ds4 在 Linux 上的主要推理路径，主要针对 **NVIDIA DGX Spark / GB10** 硬件。它与 Metal 后端的定位完全对称：

```text
macOS (Apple Silicon)    →  Metal 后端  (ds4_metal.m)
Linux (NVIDIA GPU)       →  CUDA 后端   (ds4_cuda.cu)
任意平台（调试/CPU）     →  CPU 后端    (ds4.c, #ifdef DS4_NO_GPU)
```

DGX Spark 的 GB10 芯片使用 ARM + NVLink 架构，CUDA 代码无需修改即可运行；构建时使用 `make cuda-spark`（不指定 `-arch`，由 NVCC 自动检测）。

`ds4_gpu_init`（`ds4_cuda.cu:1205`）初始化时打印设备名与 SM 版本：

```c
fprintf(stderr, "ds4: CUDA backend initialized on %s (sm_%d%d)\n",
        prop.name, prop.major, prop.minor);
```

cuBLAS handle 在同一函数中创建，数学模式默认启用 TF32（`CUBLAS_TF32_TENSOR_OP_MATH`），`--quality` 模式或环境变量 `DS4_CUDA_NO_TF32` 切换回精确计算。

---

## 2. 文件结构

| 文件 | 行数 | 职责 |
|------|------|------|
| `ds4_cuda.cu` | 10723 | 全部 CUDA kernel + `extern "C"` 封装函数，实现 `ds4_gpu.h` 中声明的所有原语 |
| `ds4_gpu.h` | 811 | 与 Metal 共享的 C API 头（见[第 10 章](10-metal-backend.md#2-文件布局与职责边界)） |
| `ds4_iq2_tables_cuda.inc` | — | `__device__ __constant__` 全局表：`cuda_ksigns_iq2xs[128]`（符号查找表）+ `cuda_iq2xxs_grid[256]`（IQ2_XXS 码本），由 `#include "ds4_iq2_tables_cuda.inc"` 嵌入 `ds4_cuda.cu:69` |

`ds4_iq2_tables_cuda.inc` 的表与 `moe.metal` 中的 Metal 版本 `ds4_metal_ksigns_iq2xs` / `ds4_metal_iq2xxs_grid` 数值完全相同，但声明空间不同（CUDA 用 `__device__ __constant__`，Metal 用 `static constant`）。

---

## 3. `ds4_cuda.cu` 内部结构

文件按功能分为若干段，大致顺序如下：

```text
行 1-87      头文件 include，枚举常量（SCORE_CAP、RAW_SCORE_CAP、TOPK_MERGE_GROUP）
行 38-42     ds4_gpu_tensor 定义（ptr + bytes + owner）
行 44-131    量化结构体（cuda_block_q2_K、q4_K、q8_K、iq2_xxs）
行 69        #include "ds4_iq2_tables_cuda.inc"
行 71-141    全局状态：模型映射、cuBLAS handle、quality mode
行 90-131    模型范围缓存结构体（cuda_model_range、cuda_model_arena、q8_f16_range、q8_f32_range）
行 149-1203  模型加载子系统（prefetch、arena、stage read、range 管理、Q8→F16 预缓存）
行 1205-1415 ds4_gpu_init/cleanup，tensor alloc/free/read/write，begin/flush/end/synchronize
行 1582-5500 Embedding、matmul、norm、RoPE、KV 量化等基础 kernel + extern "C" 封装
行 5500-8388 Attention kernels（prefill flash、decode mixed、online、compressor）
行 8389-10723 MoE kernels（gate/up/mid 各量化格式，down sum6，batch 变体）
```

`ds4_gpu_tensor` 在 CUDA 侧是一个简单 POD：

```c
struct ds4_gpu_tensor {
    void *ptr;          // cudaMalloc 地址或 managed memory 地址
    uint64_t bytes;
    int owner;          // 1 = 拥有者需 cudaFree，0 = view（不 free）
};
```

---

## 4. 与 Metal 路径的对应关系

CUDA 后端实现的是**完全相同的 C API**（`ds4_gpu.h`），因此 `ds4.c` 中的图调度代码（`metal_graph_encode_decode_layer`、`metal_graph_prefill_layer_major` 等）**不区分** Metal 和 CUDA——它们只调用 `ds4_gpu_*_tensor` 函数，由链接器决定使用哪个实现。

### 整模型图理念的一致性

- **decode 磁带**：`ds4.c` 的 `metal_graph_encode_token_raw_swa` 对 Metal 和 CUDA 均适用，因为两者的 `ds4_gpu_embed_token_hc_tensor`、`ds4_gpu_rms_norm_plain_tensor`、`ds4_gpu_matmul_f16_tensor` 等都以 `extern "C"` 导出。
- **prefill layer-major**：`metal_graph_prefill_layer_major` 和 `metal_graph_prefill_chunked_range` 同样无需修改。

### 主要差异

| 方面 | Metal | CUDA |
|------|-------|------|
| 命令编码 | `MTLCommandBuffer` + `MTLComputeCommandEncoder` | 每次 kernel launch 立即入队，`cudaDeviceSynchronize` 等待 |
| `begin_commands` / `end_commands` | 真正创建/提交 command buffer | noop / `cudaDeviceSynchronize`（`ds4_cuda.cu:1412-1414`） |
| `flush_commands` | 提交当前 CB，创建新 CB | `cudaDeviceSynchronize`（同步语义略强于 Metal） |
| 权重访问 | `MTLBuffer` wrapping mmap | CUDA Unified Memory 或 cudaHostRegister + 分段 DMA 拷贝 |
| 权重预缓存 | Model residency set | Q8→F16 预缓存到 device（`cuda_q8_f16_range`），可选 |
| 矩阵乘法 | 手写 Metal kernel | 小矩阵手写 CUDA kernel；部分大矩阵走 cuBLAS SGEMM |

**`begin_commands` / `end_commands` 的 CUDA 实现**（`ds4_cuda.cu:1412-1415`）：

```c
extern "C" int ds4_gpu_begin_commands(void) { return 1; }
extern "C" int ds4_gpu_flush_commands(void) {
    return cuda_ok(cudaDeviceSynchronize(), "flush");
}
extern "C" int ds4_gpu_end_commands(void) {
    return cuda_ok(cudaDeviceSynchronize(), "end commands");
}
extern "C" int ds4_gpu_synchronize(void) {
    return cuda_ok(cudaDeviceSynchronize(), "synchronize");
}
```

这意味着 CUDA 路径中每次"命令批次"边界都是一次完整同步。`metal_graph_prefill_layer_major` 对长 prompt 逐层调用 `begin_commands` + `end_commands` 的设计，在 CUDA 侧变成逐层同步——性能代价可接受，因为每层的 GPU 计算时间远大于同步开销。

---

## 5. 命令批量模型

Metal 侧的 `MTLCommandBuffer` 批量（多个 kernel 共享一个 CB 以减少调度开销）在 CUDA 侧完全退化为"每次 kernel 直接 launch"。CUDA runtime 有自己的 kernel 队列和流（默认流），不需要 ds4 手动批量。

这一差异在推测解码路径中有实际影响：Metal 的 `metal_graph_eval_token_raw_swa` 在 encode 阶段结束后才调用一次 `end_commands`（等待整个 decode pass），而 CUDA 路径的每次 `ds4_gpu_end_commands` 调用都立即同步，因此推测解码的 N=2 验证器在 CUDA 侧每个 token 的 encode+execute 之间都有同步点。

---

## 6. 模型权重加载策略

CUDA 后端有多种权重访问模式，按优先级：

```text
1. DGX Spark HMM 直接访问（g_model_hmm_direct）
   GPU 通过 HMM（Heterogeneous Memory Management）直接访问 host mmap 页，
   不需要显式 DMA 拷贝。ds4_cuda.cu:76 检测是否支持。

2. 分段 DMA 拷贝（cuda_model_copy_chunked，ds4_cuda.cu:1094）
   将 GGUF 的权重范围分批 cudaMemcpy 到 device arena，
   有进度打印（DS4_CUDA_LOAD_PROGRESS）。

3. cudaHostRegister 页锁定（cuda_model_range_ptr_from_fd，ds4_cuda.cu:998）
   通过 fd 分段 pread，写入 page-locked host buffer，
   再 cudaMemcpy 到 device。用于无 HMM 的普通 Linux。
```

全局变量（`ds4_cuda.cu:71-83`）：

```c
static const void *g_model_host_base;         // mmap 基址
static const char *g_model_device_base;       // device 侧基址（若完整拷贝）
static uint64_t    g_model_registered_size;
static int         g_model_hmm_direct;        // 1 = 可直接 GPU 访问 host mmap
```

---

## 7. Q8→F16 预缓存

`cuda_q8_f16_range`（`ds4_cuda.cu:108-115`）是一个可选的权重预热机制：把 Q8_0 量化的权重在加载时解量化为 F16 并缓存在 device 显存中。

触发条件（`ds4_cuda.cu:466`）：
- 权重 label 匹配特定模式（如注意力输出投影），且
- 当前 Q8 F16 缓存用量未超过预算上限（`DS4_CUDA_Q8_F16_CACHE_MIB` 环境变量控制，默认值从可用显存推算）

这使得高频使用的权重可以避免重复解量化，特别是在 decode 路径上。`cuda_q8_f16_ptr`（`ds4_cuda.cu:526`）负责查找缓存，未命中时返回 NULL，调用方退回 Q8_0 在线解量化路径。

---

## 8. 主要 Kernel 分类

### 8.1 嵌入与基础算子

| Kernel | 文件行 | 说明 |
|--------|--------|------|
| `embed_token_hc_kernel` | 1582 | 单 token 嵌入，F16 权重 → F32 HC 张量 |
| `embed_tokens_hc_kernel` | 1590 | 批量版，prefill 用 |
| `matmul_f16_kernel` | 1610 | F16 权重矩阵向量积（小矩阵手写） |
| `matmul_f16_ordered_chunks_kernel` | 1658 | 分块版，用于较大的投影 |
| `matmul_q8_0_preq_warp8_kernel` | 1933 | Q8_0 预量化 warp 并行 matmul（decode 主路径） |
| `matmul_q8_0_preq_batch_warp8_kernel` | 2055 | 批量版（prefill） |
| `rms_norm_plain_kernel` | 2163 | 不带权重的 RMS norm |
| `rms_norm_weight_kernel` | 2186 | 带权重的 RMS norm |
| `dsv4_qkv_rms_norm_rows_kernel` | 2209 | Q 和 KV 的融合双路 RMS norm |

### 8.2 位置编码

| Kernel | 文件行 | 说明 |
|--------|--------|------|
| `rope_tail_kernel` | 2340 | DS4 尾部 RoPE；c9dd949 修正了 `pos_stride` 参数 |
| `head_rms_norm_rope_tail_kernel` | 2267 | head norm + rope 融合版 |

### 8.3 注意力

| Kernel | 文件行 | 说明 |
|--------|--------|------|
| `attention_prefill_raw_kernel` | 2562 | Prefill 纯 raw SWA Flash Attention |
| `attention_prefill_mixed_kernel` | 2618 | Prefill 混合（raw + compressed） |
| `attention_decode_mixed_kernel` | 2865 | Decode 混合注意力（共享内存中存放全部 score，上限 `DS4_CUDA_ATTENTION_SCORE_CAP=8192`） |
| `attention_decode_mixed_heads8_online_kernel` | 3658 | 超过 SCORE_CAP 时的 online softmax 路径，用于长上下文 |
| `compressor_update_pool_kernel` | 4139 | Decode 时更新 compressor 状态（单 token） |
| `compressor_prefill_pool_kernel` | 4072 | Prefill 时批量生成压缩行 |

`DS4_CUDA_ATTENTION_SCORE_CAP = 8192`（`ds4_cuda.cu:33`）是 decode mixed kernel 的硬上限：当 `n_comp > 8192` 时，路由到 online kernel。长上下文冒烟测试（第 11 节）专门验证这一切换路径。

### 8.4 MoE

| Kernel | 文件行 | 说明 |
|--------|--------|------|
| `moe_gate_up_mid_decode_lut_qwarp32_kernel` | 8389 | IQ2_XXS gate/up 解量化 + SwiGLU（decode，LUT 辅助） |
| `moe_gate_up_mid_decode_q4K_qwarp32_kernel` | 9154 | Q4_K 版 decode gate/up/mid |
| `moe_down_sum6_qwarp32_kernel` | 9208 | Q2_K down projection，固定 6 专家累加 |
| `moe_down_sorted_qwarp32_kernel` | 9262 | 排序后的 down projection（batch 用） |

---

## 9. 构建：Makefile 中的 CUDA 分支

Makefile 以 `uname -s` 区分 Darwin（Metal）和 Linux（CUDA）：

```makefile
# Makefile:20-33
else   # Linux
CUDA_HOME ?= /usr/local/cuda
NVCC      ?= $(CUDA_HOME)/bin/nvcc
CUDA_ARCH ?=
NVCCFLAGS ?= -O3 --use_fast_math $(NVCC_ARCH_FLAGS) \
             -Xcompiler $(NATIVE_CPU_FLAG) -Xcompiler -pthread
CUDA_LDLIBS ?= -lm -Xcompiler -pthread \
               -L$(CUDA_HOME)/targets/sbsa-linux/lib \
               -L$(CUDA_HOME)/lib64 \
               -lcudart -lcublas
CORE_OBJS = ds4.o ds4_cuda.o
endif
```

三种常用构建目标（`Makefile:79-91`）：

| 目标 | 命令 | 适用场景 |
|------|------|---------|
| DGX Spark | `make cuda-spark` | GB10，不指定 arch（NVCC 自动检测） |
| 本地 GPU | `make cuda-generic` | 传 `CUDA_ARCH=native` |
| 指定 arch | `make cuda CUDA_ARCH=sm_120` | 明确 SM 版本 |

编译规则（`Makefile:160-161`）：

```makefile
ds4_cuda.o: ds4_cuda.cu ds4_gpu.h ds4_iq2_tables_cuda.inc
	$(NVCC) $(NVCCFLAGS) -c -o $@ ds4_cuda.cu
```

`ds4.c` 和 `ds4_cli.c` 等仍用 `$(CC)`（gcc/clang）编译，最终由 `$(NVCC)` 链接：

```makefile
ds4: ds4_cli.o linenoise.o $(CORE_OBJS)
	$(NVCC) $(NVCCFLAGS) -o $@ $^ $(CUDA_LDLIBS)
```

CPU-only 构建在 Linux 上也可用（`make cpu`），编译 `ds4.c` 时加 `-DDS4_NO_GPU`，不链接 CUDA 库。

---

## 10. 最近修正：压缩 Prefill RoPE positions

**commit c9dd949**（2026-05-17）修复了压缩 prefill 路径中 `rope_tail_kernel` 位置计算错误。

### 问题根源

压缩层在 prefill 阶段将 `n_comp` 个压缩行写入 `comp_cache`，每个压缩行对应 `ratio` 个原始 token 的池化结果。第 `r` 个压缩行的正确 RoPE 位置应为 `pos0 + r * ratio`，而修复前使用的是逐 thread 递增的 `pos0 + t`（即 `t = 0, 1, 2, ...`），相当于错误地把压缩行当成连续 token 处理。

### 修复方法

在 `rope_tail_kernel` 签名中增加 `pos_stride` 参数（`ds4_cuda.cu:2347`）：

```c
__global__ static void rope_tail_kernel(
        float *x, uint32_t n_tok, uint32_t n_head,
        uint32_t head_dim, uint32_t n_rot,
        uint32_t pos0,
        uint32_t pos_stride,   // 新增：每个 token 的位置步长
        uint32_t n_ctx_orig, ...);
```

内核中的位置计算从 `pos0 + t` 改为 `pos0 + t * pos_stride`（`ds4_cuda.cu:2375`）：

```c
- float theta_extrap = (float)(pos0 + t) * powf(freq_base, ...);
+ float theta_extrap = (float)(pos0 + t * pos_stride) * powf(freq_base, ...);
```

普通 decode/prefill 调用时传 `pos_stride=1`（行为不变）：

```c
// ds4_cuda.cu:6358 — 普通 rope
rope_tail_kernel<<<...>>>(..., pos0, 1, n_ctx_orig, ...);
```

压缩 prefill 调用时传 `pos_stride=ratio`：

```c
// ds4_cuda.cu:6625 — 压缩 prefill rope（修复后）
rope_tail_kernel<<<(pairs + 255) / 256, 256>>>(
        (float *)comp_cache->ptr, n_comp, 1, head_dim, n_rot,
        pos0, ratio,    // pos_stride = ratio
        n_ctx_orig, 0, ...);
```

同样的修正也应用于 `ds4_gpu_compressor_prefill_ratio4_replay_tensor`（`ds4_cuda.cu:6695`）。

### 影响范围

- 只影响有压缩层（`ratio != 0`）的 prefill，即涉及 ratio-4 和 ratio-128 层的上下文构建
- Decode 路径（`ds4_gpu_rope_tail_tensor`）不受影响，因为 decode 每次只处理 1 token，`pos_stride=1` 恒成立
- Metal 后端的 `dsv4_rope.metal` 中 `rope_tail_batch` kernel 使用 `src2` 参数传递 position 数组，本就是 per-token 的正确位置，不存在此问题

---

## 11. 长上下文冒烟测试

`tests/cuda_long_context_smoke.c` 包含两个回归测试，构建目标为 `make cuda-regression`（`Makefile:111`）：

### 测试 1：大 top-k 正确性与性能（`check_large_topk`）

```c
const uint32_t n_comp   = 32768;  // 超长上下文的压缩行数
const uint32_t n_tokens = 32;
const uint32_t top_k    = 512;
```

验证 `ds4_gpu_indexer_topk_tensor` 对 32K 压缩行的 top-512 结果是否完全正确（期望降序排列），并检查执行时间不超过阈值（默认 2s，可用 `DS4_CUDA_TOPK_REGRESSION_SEC` 覆盖）。

### 测试 2：Decode 注意力 overflow 路径（`check_decode_attention_overflow_path`）

```c
const uint32_t n_comp = 8100;  // 超过 DS4_CUDA_ATTENTION_SCORE_CAP = 8192 的边界值
```

当 `n_comp > DS4_CUDA_ATTENTION_RAW_SCORE_CAP（256）` 时，`attention_decode_mixed_kernel` 的共享内存无法容纳全部 score，需要路由到 `attention_decode_mixed_heads8_online_kernel`。这个测试强制触发该切换并验证输出非零（压缩行的第一个元素为 1.0，注意力输出应接近 1.0）。

测试的构建规则（`Makefile:163-164`）：

```makefile
tests/cuda_long_context_smoke: tests/cuda_long_context_smoke.o ds4_cuda.o
	$(NVCC) $(NVCCFLAGS) -o $@ $^ $(CUDA_LDLIBS)
```

注意该测试只链接 `ds4_cuda.o`，不包含 `ds4.o`（模型层），因此可以在没有模型文件的环境中运行。

---

## 12. 关键环境变量

| 环境变量 | 说明 |
|----------|------|
| `DS4_CUDA_NO_TF32` | 禁用 cuBLAS TF32 数学模式，切换为精确 F32 |
| `DS4_CUDA_Q8_F16_CACHE_MIB` | Q8→F16 预缓存上限（MiB），0 禁用 |
| `DS4_CUDA_TOPK_REGRESSION_SEC` | top-k 回归测试的时间阈值（默认 2s） |
| `DS4_CUDA_LOAD_PROGRESS` | 打印权重加载进度 |

---

## 相关章节

- [第 10 章：Metal 后端](10-metal-backend.md) —— 同一套 `ds4_gpu.h` API 的 Metal 实现，图调度逻辑在 `ds4.c` 中完全共享
- [第 12 章：推测解码与 MTP](12-speculative-mtp.md) —— 推测解码状态机在 Metal/CUDA 两侧完全透明使用
