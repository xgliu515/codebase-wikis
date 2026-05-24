# Chapter 11: CUDA Backend (DGX Spark)

> Code version locked to `antirez/ds4@f91c12b` (2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 11.1 The problem this chapter solves

Chapter 10 walked through the Metal backend: `ds4_metal.m` provides 200+ primitives that the engine in `ds4.c` calls via the `ds4_gpu.h` contract. The CUDA backend in `ds4_cuda.cu` (10,737 lines) implements the *exact same primitives* with the *exact same names* — `extern "C"` linkage makes them indistinguishable to the engine at link time. The result: `ds4.c`'s decode and prefill encoders work unchanged on Linux/NVIDIA, and the rest of the system (CLI, server, agent, benchmarks) doesn't know which backend is running underneath.

That symmetry is the point of the chapter. The interesting differences live not in *what* primitives exist (they're the same) but in *how* a CUDA kernel launch differs from a Metal command-buffer encode, how the model weights reach the GPU (HMM vs. DMA vs. pinned-host), how `cuBLAS` plays alongside hand-rolled kernels, and what the DGX Spark / GB10 target does that a workstation NVIDIA GPU does not.

This chapter covers:

1. The target hardware (DGX Spark + GB10) and what assumptions it lets the code make (11.2).
2. The file structure of `ds4_cuda.cu` — kernel inventory by stage (11.3).
3. Init, cuBLAS, and TF32 (11.4).
4. The command-batch model: how `begin/flush/end_commands` collapse to `cudaDeviceSynchronize` (11.5).
5. Weight residency: HMM direct, arena copy, page-locked staging, the Q8→F16 cache (11.6).
6. The `ds4_iq2_tables_cuda.inc` lookup tables shared with `metal/moe.metal` (11.7).
7. Sample kernel walkthrough: `attention_decode_mixed_kernel` and its online-softmax sibling (11.8).
8. How CUDA cooperative-group patterns differ from Metal threadgroup patterns (11.9).
9. The Makefile branch and `make cuda-spark` / `make cuda-generic` / `make cuda CUDA_ARCH=...` targets (11.10).
10. The long-context smoke test that exercises the `n_comp > 8192` overflow path (11.11).
11. The remaining gotcha set — managed KV cache, FP8, cuBLAS-vs-hand-rolled, and CUDA env vars (11.12).

The throughline: **the CUDA backend trades Metal's command-buffer batching for stream-based kernel launches, then makes up for the lost batching opportunities with cuBLAS for large matmuls and a Q8→F16 weight cache for hot Q8_0 paths.**

```
+-----------------+   +-------------------------+   +-------------------------+
| ds4.c           |   | ds4_cuda.cu (10.7k LOC) |   | CUDA / cuBLAS / nvcc    |
| (same code as   |   | - all kernels (__global__|   | - default stream         |
|  Metal path)    |   | - cuBLAS for big matmul |   | - cudaDeviceSynchronize |
|                 |---|- managed KV fallback    |---|- TF32 tensor cores      |
| ds4_gpu.h       |   | - HMM/arena/staged DMA  |   | - cooperative groups    |
|                 |   | - Q8->F16 weight cache  |   | - cub::BlockRadixSort   |
+-----------------+   +-------------------------+   +-------------------------+
                            includes
                                |
                                v
                      +--------------------------+
                      | ds4_iq2_tables_cuda.inc  |
                      | (shared LUTs with Metal) |
                      +--------------------------+
```

## 11.2 Target hardware and platform

The CUDA backend has one *primary* target and several *general* fallbacks. The primary is **NVIDIA DGX Spark / GB10** — the consumer/workstation member of NVIDIA's Grace-Hopper-style ARM-CPU + GPU SoC family. Two GB10 properties shape the design:

1. **Unified host/device memory with HMM (Heterogeneous Memory Management).** The GPU can directly read host-mmap'd pages with no DMA copy, as long as the address ranges are HMM-registered. ds4 detects this at startup and skips the model copy entirely.

2. **Limited device memory** (DGX Spark ships with ~128 GiB unified memory shared with the CPU). A million-token KV cache plus the 60-100 GiB model weights plus the activation working set can easily exceed plain `cudaMalloc`'s pool, so the engine falls back to managed memory for very long contexts.

The *general* fallbacks are discrete-GPU CUDA (RTX, A6000, H100) and earlier Grace-Hopper (H100/GB200). These don't get the HMM zero-copy path; they pay a DMA upload cost at startup and then run identically. The build target `make cuda-generic` covers them.

`ds4_gpu_init` (`ds4_cuda.cu:1205-1222`) reports what was detected:

```cpp
extern "C" int ds4_gpu_init(void) {
    int dev = 0;
    if (!cuda_ok(cudaSetDevice(dev), "set device")) return 0;
    cudaDeviceProp prop;
    if (cudaGetDeviceProperties(&prop, dev) == cudaSuccess) {
        fprintf(stderr, "ds4: CUDA backend initialized on %s (sm_%d%d)\n",
                prop.name, prop.major, prop.minor);
    }
    if (!g_cublas_ready) {
        if (!cublas_ok(cublasCreate(&g_cublas), "create handle")) return 0;
        const cublasMath_t math_mode =
            (g_quality_mode || getenv("DS4_CUDA_NO_TF32") != NULL)
                ? CUBLAS_DEFAULT_MATH
                : CUBLAS_TF32_TENSOR_OP_MATH;
        (void)cublasSetMathMode(g_cublas, math_mode);
        g_cublas_ready = 1;
    }
    return 1;
}
```

Two configuration knobs decided here:

- **TF32 by default.** `CUBLAS_TF32_TENSOR_OP_MATH` lets cuBLAS use Tensor Core TF32 for F32 GEMMs. Roughly 4× speedup on Ampere/Hopper for FP32 inputs at the cost of slightly reduced mantissa precision (truncates 23 → 10 bits). For DS4's mid-precision activations this is invisible in practice.
- **`--quality` mode or `DS4_CUDA_NO_TF32` switches to `CUBLAS_DEFAULT_MATH`.** That restores full F32 accumulation and matches the precision policy of the Metal path's reference kernels.

The single device (`cudaSetDevice(0)`) is intentional. DS4 is a single-GPU inference engine; multi-GPU would require sharding the model and the KV cache across devices, which the codebase does not do.

## 11.3 `ds4_cuda.cu` file structure

The 10,737-line file is organized roughly by stage:

```
Lines 1-87       Headers, enums, DS4_CUDA_ATTENTION_SCORE_CAP (= 8192)
Lines 38-42      struct ds4_gpu_tensor (POD: ptr, bytes, owner)
Lines 44-67      Quantization block structs (cuda_block_q2_K, q4_K, q8_K, iq2_xxs)
Line 69          #include "ds4_iq2_tables_cuda.inc"
Lines 71-148     File-scope globals: model views, arenas, Q8/F16 cache, cuBLAS handle, streams
Lines 149-1196   Model-load subsystem (prefetch, arena, page-lock register, DMA, Q8→F16 cache)
Lines 1199-1415  ds4_gpu_init / cleanup / tensor alloc / free / read / write / copy /
                 begin/flush/end_commands
Lines 1417-1581  ds4_gpu_set_model_map (HMM detection, registration, range mapping)
Lines 1582-2200  Embeddings, F16/F32/Q8_0 matmul kernels, RMS norm kernels
Lines 2200-2500  QKV norm, head RMS norm, RoPE (rope_tail_kernel with pos_stride)
Lines 2486-2700  FP8 KV quantize / indexer FP4 / raw KV store
Lines 2562-3870  Attention kernels (prefill flash, decode mixed, indexed mixed, heads8 online)
Lines 3871-4200  HC kernels (sinkhorn, weighted sum, expand, fused variants), compressor kernels
Lines 4198-4800  Router select, SwiGLU, indexer scoring (direct + WMMA tiled variants)
Lines 4800-5500  Indexer top-k (multiple radix-sort and merge kernels)
Lines 5496+      extern "C" primitive functions (one per ds4_gpu.h declaration)
Lines 8389+      MoE kernels (gate/up/mid decode for IQ2_XXS/Q4_K, down sum6 variants)
```

There is no clean section header in the file — these are approximate boundaries from `grep`-ing `^__global__ static void` and `^extern "C"`. The reader following along should expect to scroll a lot.

### 11.3.1 The kernel inventory

Each Metal kernel file has a CUDA counterpart. The names are not always identical (CUDA C++ doesn't allow the same identifier in two files, so they're disambiguated), but the role is one-to-one:

| Metal file (`metal/*.metal`) | CUDA kernel (`ds4_cuda.cu`) | Role |
|-----------------------------|------------------------------|------|
| `flash_attn.metal` | `attention_prefill_raw_kernel` (2562), `attention_prefill_mixed_kernel` (2618), `attention_prefill_raw_softmax_kernel` (2697), `attention_prefill_mixed_softmax_kernel` (2742) | Prefill Flash Attention; explicit raw/mixed/softmax splits |
| `flash_attn.metal` (vec) | `attention_decode_mixed_kernel` (2865), `attention_decode_mixed_heads8_online_kernel` (3658), `attention_static_mixed_heads8_online_kernel` (3534) | Decode attention; online softmax for long contexts |
| `dsv4_misc.metal` (indexed mixed) | `attention_indexed_mixed_kernel` (3033), `attention_indexed_mixed_heads8_rb4_kernel` (3193), `attention_indexed_mixed_heads8_online_kernel` (3369) | Indexed-sparse attention for compressed (ratio-4) layers |
| `dsv4_kv.metal` | `fp8_kv_quantize_kernel` (2486), `indexer_hadamard_fp4_kernel` (2510), `store_raw_kv_batch_kernel` (2552) | FP8 KV quantize, indexer FP4 Hadamard, raw KV store |
| `dsv4_rope.metal` | `rope_tail_kernel` (2340), `head_rms_norm_rope_tail_kernel` (2267) | Tail RoPE (with `pos_stride` parameter — see 11.7.1) |
| `dsv4_hc.metal` | `hc_split_sinkhorn_kernel` (3871), `hc_weighted_sum_kernel` (3877), `hc_expand_kernel` (3891), `hc_split_weighted_sum_fused_kernel` (3923), `hc_split_weighted_sum_norm_fused_kernel` (3951), `output_hc_weights_kernel` (3998) | Hyper-Connection split/expand/weighted-sum, both fused and reference variants |
| `moe.metal` (gate/up) | `moe_gate_up_mid_decode_lut_qwarp32_kernel` (8389+), `moe_gate_up_mid_decode_q4K_qwarp32_kernel` (9154) | MoE gate+up+mid for IQ2_XXS (with LUT) and Q4_K |
| `moe.metal` (down sum6) | `moe_down_sum6_qwarp32_kernel` (9208+), `moe_down_sorted_qwarp32_kernel` (9262) | MoE down projection with fixed 6-expert accumulation |
| `dense.metal` (Q8_0) | `matmul_q8_0_preq_kernel` (1897), `matmul_q8_0_preq_warp8_kernel` (1933), `matmul_q8_0_pair_preq_warp8_kernel` (1960), `matmul_q8_0_hc_expand_preq_warp8_kernel` (2005), `matmul_q8_0_preq_batch_warp8_kernel` (2055) | Q8_0 matmul: serial / warp-parallel / paired / fused with HC expand / batched |
| `dense.metal` (F16/F32) | `matmul_f16_kernel` (1610), `matmul_f16_ordered_chunks_kernel` (1658), `matmul_f16_pair_ordered_chunks_kernel` (1690), `matmul_f32_kernel` (1733) | F16 / F32 matmul (small matrices); cuBLAS for big ones |
| `glu.metal` | `swiglu_kernel` (4423) | SwiGLU activation |
| `norm.metal` | `rms_norm_plain_kernel` (2163), `rms_norm_weight_kernel` (2186), `dsv4_qkv_rms_norm_rows_kernel` (2209), `head_rms_norm_kernel` (2245) | RMS norm variants |
| `argsort.metal` | `indexer_topk_kernel` (5025), `indexer_topk_8192_cub_kernel` (5056), `indexer_topk_1024_kernel` (5096), `indexer_topk_pow2_kernel` (5145), `indexer_topk_pow2_u16_kernel` (5200), `indexer_topk_chunk_pow2_kernel` (5255), `indexer_topk_merge_pow2_kernel` (5317), `indexer_topk_tree_merge_pow2_kernel` (5377), `indexed_topk_sort_512_asc_kernel` (5447) | Top-k variants — uses `cub::BlockRadixSort` for 8192-row case |
| `get_rows.metal` | `embed_token_hc_kernel` (1582), `embed_tokens_hc_kernel` (1590) | Token embedding lookup |
| `unary.metal` / `bin.metal` | `add_kernel` (4436), `fill_f32_kernel` (4014), `zero_kernel` (4473), `directional_steering_project_kernel` (4442) | Elementwise unary/binary |
| `repeat.metal` | `repeat_hc_kernel` (1761) | HC broadcast |
| `cpy.metal` | `f32_to_f16_kernel` (1768), `quantize_q8_0_f32_kernel` (1862) | Type conversion |

Roughly 80-90 distinct `__global__` kernels, plus a tail of supporting kernels for compressor maintenance (`compressor_store_kernel` at 4019, `compressor_set_rows_kernel` at 4045, `compressor_prefill_pool_kernel` at 4072, `compressor_update_pool_kernel` at 4139, `compressor_shift_ratio4_kernel` at 4180) and router selection (`router_select_kernel` at 4198, `_parallel_kernel` at 4250, `_warp_topk_kernel` at 4312).

### 11.3.2 The `ds4_gpu_tensor` POD

On the CUDA side, `ds4_gpu_tensor` is a plain C struct (`ds4_cuda.cu:38-42`):

```cpp
struct ds4_gpu_tensor {
    void *ptr;
    uint64_t bytes;
    int owner;
};
```

Three fields:

- `ptr` — either a `cudaMalloc` device pointer or a `cudaMallocManaged` unified-memory pointer.
- `bytes` — logical size.
- `owner` — 1 if `cudaFree` should be called on free; 0 if this is a view (`ds4_gpu_tensor_view`).

Compared to Metal's `DS4MetalTensor` (chapter 10.3.3), there's no `offset` field — view tensors instead store a pre-offset `ptr` directly. The same engine-side semantics work because the engine never touches the inner layout.

## 11.4 Init, cuBLAS, and the TF32 policy

### 11.4.1 cuBLAS lifecycle

cuBLAS is created once at `ds4_gpu_init` and destroyed at `ds4_gpu_cleanup` (`ds4_cuda.cu:1213-1221`, `1227-1231`). The handle (`g_cublas`) is a process-global. There is one handle for the whole process; no per-session contexts.

cuBLAS is used for **large F32 and F16 matmuls** — specifically, F32 GEMM for the Q8_0 weights converted to F32 (`ds4_cuda.cu:5847-5866`) and F16 GEMM for the Q8_0 weights converted to F16 (`ds4_cuda.cu:5867-5895`), both gated on `n_tok > 1` and on the Q8→F16/F32 cache being warm. For single-token decode (`n_tok == 1`), the hand-rolled `matmul_q8_0_preq_warp8_kernel` is faster than cuBLAS because the dispatch is dominated by the cuBLAS calling-convention overhead at that matrix size.

The decision point in `ds4_gpu_matmul_q8_0_tensor` (`ds4_cuda.cu:5840-5900` excerpt):

```cpp
if (g_cublas_ready && n_tok > 1) {
    const float *w_f32 = cuda_q8_f32_ptr(...);
    if (w_f32) {
        cublasStatus_t st = cublasSgemm(g_cublas, CUBLAS_OP_T, CUBLAS_OP_N,
                                        (int)out_dim, (int)n_tok, (int)in_dim,
                                        &alpha, w_f32, (int)in_dim,
                                        (const float *)x->ptr, (int)in_dim,
                                        &beta, (float *)out->ptr, (int)out_dim);
        return cublas_ok(st, "q8 fp32 matmul");
    }
    const __half *w_f16 = cuda_q8_f16_ptr(...);
    if (w_f16) {
        ...
        cublasStatus_t st = cublasGemmEx(g_cublas, CUBLAS_OP_T, CUBLAS_OP_N,
                                         (int)out_dim, (int)n_tok, (int)in_dim,
                                         &alpha, w_f16, CUDA_R_16F, (int)in_dim,
                                         xh, CUDA_R_16F, (int)in_dim,
                                         &beta, out->ptr, CUDA_R_32F, (int)out_dim,
                                         CUDA_R_32F, CUBLAS_GEMM_DEFAULT);
        ...
    }
}
// Fall through to hand-rolled kernels when none of the above apply
```

Three fallback layers, in order:

1. **cuBLAS F32 GEMM** — if a Q8→F32 cache slot exists for these weights.
2. **cuBLAS F16 GEMM** — if a Q8→F16 cache slot exists. Converts activations to F16 on the fly via `f32_to_f16_kernel`.
3. **Hand-rolled Q8_0 kernel** — `matmul_q8_0_preq_batch_warp8_kernel`. No conversion; reads the Q8_0 weights directly.

The cache hit rates determine the active path. By default the Q8→F16 cache covers attention output projections and some Q_b projections; the Q8→F32 cache is opt-in (`DS4_CUDA_Q8_F32_ALL`, `DS4_CUDA_ATTN_Q_B_F32_CACHE`).

### 11.4.2 The TF32 trade

TF32 (`CUBLAS_TF32_TENSOR_OP_MATH`) is on by default. The trade-off comment lives in `ds4_gpu_init` (`ds4_cuda.cu:1215-1219`) implicitly: `g_quality_mode || getenv("DS4_CUDA_NO_TF32")` selects `CUBLAS_DEFAULT_MATH`. There are two contexts that set quality mode:

- **CLI flag `--quality`** — `ds4_cli.c:1414` sets `c.engine.quality = true`; the engine forwards this to `ds4_gpu_set_quality`.
- **Env var `DS4_CUDA_NO_TF32`** — pure override for users who want to measure TF32's actual numerical impact without changing the model behavior elsewhere.

`--quality` mode does more than disable TF32: it also disables the F16 GEMM path entirely in some cases (`ds4_cuda.cu:509-514`), forcing F32 accumulation. The full quality-mode handling spreads across both `ds4_cuda.cu` and `ds4_metal.m`; see chapter 12.8 for how it interacts with the speculative decoding verifier.

## 11.5 The command-batch model

Chapter 10.4 introduced the four `ds4_gpu_*_commands` functions and showed Metal's implementation. The CUDA implementation is dramatically simpler (`ds4_cuda.cu:1412-1415`):

```cpp
extern "C" int ds4_gpu_begin_commands(void) { return 1; }
extern "C" int ds4_gpu_flush_commands(void) { return cuda_ok(cudaDeviceSynchronize(), "flush"); }
extern "C" int ds4_gpu_end_commands(void) { return cuda_ok(cudaDeviceSynchronize(), "end commands"); }
extern "C" int ds4_gpu_synchronize(void) { return cuda_ok(cudaDeviceSynchronize(), "synchronize"); }
```

`begin_commands` is a *noop* — the CUDA runtime already has a default stream that queues kernel launches; there's nothing to "open." `flush_commands` and `end_commands` both perform a full device synchronize, because CUDA has no equivalent of Metal's "commit the current command buffer, start a new one, but keep the GPU busy" — once you've issued a `cudaDeviceSynchronize`, the GPU drains.

### 11.5.1 Performance implications

The lack of split-buffer batching on CUDA changes one specific optimization in the engine:

In Metal, `metal_graph_encode_token_raw_swa` (10.7.2) issues `ds4_gpu_flush_commands` after the first 4 layers to start GPU execution while CPU encoding continues. On CUDA, that same call performs a full `cudaDeviceSynchronize` — which *prevents* the very overlap it was supposed to enable. The CUDA backend isn't actively harmed by it: the CPU-side encoding cost on CUDA is much smaller (kernel launches are tiny), so the overlap was less valuable to begin with. But the engine-level optimization is effectively neutralized on CUDA.

The decision was to keep one code path. The engine doesn't need to know which backend it's running on; the backends just translate the abstract notion of "flush" into whatever's natural for them.

### 11.5.2 What CUDA gets that Metal does not

The CUDA backend has access to two facilities that have no Metal equivalent:

1. **Per-kernel streams.** `ds4_cuda.cu:85` declares `g_model_upload_stream`, used for prefetching model pages asynchronously while the main stream runs compute. This is a non-trivial setup-time win.
2. **Events for fine-grained sync.** `g_model_stage_event[4]` (`ds4_cuda.cu:146`) marks DMA-completion boundaries during staged model load, so the main stream can wait on a *specific* upload finishing rather than draining everything.

Neither of these is reachable from the engine; they're internal to the model-loading subsystem (11.6.2).

## 11.6 Weight residency

`ds4_set_model_*` calls bring the GGUF model into a GPU-visible location. The Metal path mmaps and views; the CUDA path has *three* strategies with priority order:

```
Priority 1: HMM direct (g_model_hmm_direct = 1)
            GPU reads host mmap pages directly via HMM page-fault.
            Zero copy. DGX Spark + recent driver only.
            ds4_cuda.cu:770 sets g_model_hmm_direct = 1 on success.

Priority 2: Arena copy (cuda_model_arena)
            Allocate device-side arena, copy GGUF ranges into it.
            Used when HMM unavailable but device memory permits.
            ds4_cuda.cu:957-996 cuda_model_arena_alloc.

Priority 3: Pinned-host staged DMA (cuda_model_range_ptr_from_fd)
            Read from fd into page-locked host buffer, DMA to device arena.
            Used for very large models on limited-device-memory hardware.
            ds4_cuda.cu:998-1093.

Priority 4: cudaHostRegister (fallback)
            Register mmap'd pages as pinned. GPU still does DMA per access.
            Cheapest setup but slowest at runtime.
            ds4_cuda.cu:1473 cudaHostRegister(... cudaHostRegisterMapped ...).
```

### 11.6.1 HMM detection

The HMM check happens during `ds4_gpu_set_model_map`. After `cudaPointerGetAttributes` or a probe access succeeds (`ds4_cuda.cu:763-770`), the global flag is flipped:

```cpp
g_model_hmm_direct = 1;
```

When `g_model_hmm_direct` is set, every subsequent `cuda_model_range_ptr` (`ds4_cuda.cu:193-196`) returns the *original* host mmap pointer:

```cpp
static const char *cuda_model_ptr(const void *model_map, uint64_t offset) {
    if (model_map == g_model_host_base && g_model_device_base) return g_model_device_base + offset;
    return (const char *)model_map + offset;
}
```

Kernels read directly from the host mmap addresses; the GPU handles the page-fault internally. No `cudaMemcpy` ever runs for model weights.

On non-HMM systems, `g_model_device_base` points to the arena, and weight accesses go through the arena pointer.

### 11.6.2 The model load progress

Loading 60-100 GiB onto a device is slow enough to need progress reporting. `cuda_model_load_progress_note` (`ds4_cuda.cu:656-690`) tracks bytes loaded and prints periodic updates:

```cpp
fprintf(stderr, "ds4: CUDA loading model tensors into device cache: 0.00 GiB");
```

The cadence is TTY-aware: on a terminal it prints every 2 GiB; on a non-terminal (CI logs, redirected output) it prints every 16 GiB. `DS4_CUDA_WEIGHT_CACHE_VERBOSE=1` disables the periodic message and instead prints each individual range as it's cached.

### 11.6.3 Q8→F16 cache

The Q8→F16 cache (`cuda_q8_f16_range`, `ds4_cuda.cu:108-115`):

```cpp
struct cuda_q8_f16_range {
    const void *host_base;
    uint64_t offset;
    uint64_t weight_bytes;
    uint64_t in_dim;
    uint64_t out_dim;
    __half *device_ptr;
};
```

For each Q8_0 weight tensor that's worth caching (decided by `cuda_q8_f16_label_eligible` at `ds4_cuda.cu:469-499`), the engine dequantizes the entire tensor to F16 at load time and stores the `__half*` on the device. Subsequent matmuls call `cuda_q8_f16_ptr` to find the cached F16 weights; cuBLAS GEMM handles the actual multiply.

The selection of which weights to cache is conservative:

- Attention output projection (`label == "attn_output"`): always (`ds4_cuda.cu:476-478`).
- Q LoRA up projection (`attn_q_b`): unless `DS4_CUDA_NO_ATTN_Q_B_F16_CACHE` is set.
- Other Q8_0 weights: gated by `DS4_CUDA_Q8_F16_ALL`.

The cache budget is bounded by available device memory; the cache disables itself permanently if it runs out (`g_q8_f16_disabled_after_oom`, `ds4_cuda.cu:450-460`) to avoid repeated retry-and-fail cycles.

### 11.6.4 Managed-memory fallback

`ds4_gpu_should_use_managed_kv_cache` (`ds4_cuda.cu:1327-1352`) is the policy:

```cpp
extern "C" int ds4_gpu_should_use_managed_kv_cache(uint64_t kv_cache_bytes, uint64_t context_bytes) {
    // Used at session init; the engine asks "should I allocate the KV cache
    // as managed memory instead of device memory?"  Returns 1 on memory pressure.
    ...
}
```

When the answer is 1, every `metal_graph_alloc_kv_cache_tensor` call routes to `ds4_gpu_tensor_alloc_managed` (`ds4_cuda.cu:1305-1326`) which uses `cudaMallocManaged` instead of `cudaMalloc`. The unified-memory page-fault hardware demand-pages KV-cache rows as needed, at runtime cost.

The user-visible message at session start (`ds4.c:8878-8884`) explains the trade-off:

```c
"ds4: CUDA using managed KV cache for ctx=%u "
"(kv cache %.2f GiB, context buffers %.2f GiB); "
"this may degrade performance but is needed for very large contexts\n"
```

This message only fires for CUDA backends; the Metal `ds4_gpu_should_use_managed_kv_cache` always returns 0.

## 11.7 The IQ2 LUTs and code sharing with Metal

`ds4_iq2_tables_cuda.inc` (77 lines) is a small `#include`-only file containing two `__device__ __constant__` arrays:

```cpp
__device__ __constant__ uint8_t cuda_ksigns_iq2xs[128] = {
      0, 129, 130,   3, 132,   5,   6, 135, 136,   9,  10, 139,  12, 141, 142,  15,
    ... (128 entries) ...
};

__device__ __constant__ uint64_t cuda_iq2xxs_grid[256] = {
    ... (256 entries) ...
};
```

`cuda_ksigns_iq2xs` is the sign-bit lookup table for IQ2_XXS dequantization — the byte `i` is mapped to a 7-bit XOR-encoded sign pattern. `cuda_iq2xxs_grid` is the 256-entry IQ2_XXS codebook: 8 quantized output values per entry packed into a `uint64_t`.

These tables are *identical* to the ones used by `metal/moe.metal` — they implement the same dequantization algorithm — but they're declared with different storage qualifiers because CUDA and Metal disagree:

- **CUDA:** `__device__ __constant__` arrays. Read-only, broadcast-cached on each SM.
- **Metal:** `static constant` arrays inside the kernel file (in `metal/moe.metal`). Read-only, accessible from threadgroup-level constants memory.

The values are produced by `gguf-tools/iq2-tools` (offline) and copied into the two source files. They are not synthesized at build time — there's no script that regenerates them. The two copies sit side by side in the repo as a deliberate denormalization, on the principle that the tables are small and stable enough that the duplication is less painful than the cross-language code generator that would be needed to share them.

### 11.7.1 The pos_stride RoPE fix (still present at f91c12b)

Commit `c9dd949` (covered in the c9dd949 wiki) added a `pos_stride` parameter to `rope_tail_kernel` to fix the compressed-prefill RoPE position computation. The fix is still in place at f91c12b (`ds4_cuda.cu:2340-2393`):

```cpp
__global__ static void rope_tail_kernel(
        float *x,
        uint32_t n_tok,
        uint32_t n_head,
        uint32_t head_dim,
        uint32_t n_rot,
        uint32_t pos0,
        uint32_t pos_stride,
        uint32_t n_ctx_orig,
        int inverse,
        float freq_base,
        float freq_scale,
        ...) {
    ...
    float theta_extrap = (float)(pos0 + t * pos_stride) * powf(freq_base, -((float)i) / (float)n_rot);
    ...
}
```

`pos_stride = 1` for normal decode and prefill; `pos_stride = ratio` (typically 4) for compressed prefill, where each row corresponds to `ratio` consecutive original token positions. The Metal backend's `metal/dsv4_rope.metal:rope_tail_batch` kernel uses a separate `src2` parameter to carry per-row position values, which sidesteps the issue entirely.

## 11.8 Sample kernel: `attention_decode_mixed_kernel`

To make the kernel-launch pattern concrete, look at `attention_decode_mixed_kernel` (`ds4_cuda.cu:2865-2900` excerpt):

```cpp
__global__ static void attention_decode_mixed_kernel(
        float *heads,
        const float *sinks,
        const float *q,
        const float *raw_kv,
        const float *comp_kv,
        const float *comp_mask,
        uint32_t use_comp_mask,
        uint32_t n_tokens,
        uint32_t pos0,
        uint32_t n_raw,
        uint32_t raw_cap,
        uint32_t raw_start,
        uint32_t n_comp,
        uint32_t window,
        uint32_t ratio,
        uint32_t n_head,
        uint32_t head_dim) {
    uint32_t t = blockIdx.x;
    uint32_t h = blockIdx.y;
    if (t >= n_tokens || h >= n_head) return;
    ...
    __shared__ float scores[DS4_CUDA_ATTENTION_SCORE_CAP];   // 32 KiB
    __shared__ uint32_t raw_rows[256];
    __shared__ float partial[256];
    __shared__ float max_s;
    __shared__ float denom;
    __shared__ uint32_t raw_count;
    __shared__ uint32_t raw_first_idx;
    ...
}
```

Three observable patterns:

1. **Grid shape is `(n_tokens, n_head)`.** One CUDA thread *block* per (token, head) pair. For decode, `n_tokens = 1` so the launch is `(1, 128)` — 128 blocks, one per head. The intra-block thread count is set in the launch invocation (typically 128 or 256 threads).

2. **Shared memory holds the score buffer.** `__shared__ float scores[DS4_CUDA_ATTENTION_SCORE_CAP]` allocates 8192 × 4 = 32 KiB per block. This is the *hard cap*: when `n_comp > 8192 - 256 = 7936`, the host-side dispatch must route to the online variant `attention_decode_mixed_heads8_online_kernel` (`ds4_cuda.cu:3658`) which does the softmax incrementally without storing all scores at once.

3. **Per-block softmax stays in shared memory.** `max_s` and `denom` are also `__shared__` — the kernel computes the per-row softmax denominator via a block-wide reduction in shared memory. The final softmax-weighted KV sum is then accumulated and written to `heads`.

The host-side launcher for this kernel checks `cuda_attention_score_buffer_fits(n_comp)` (`ds4_cuda.cu:189-191`):

```cpp
static int cuda_attention_score_buffer_fits(uint32_t n_comp) {
    return n_comp <= DS4_CUDA_ATTENTION_SCORE_CAP - DS4_CUDA_ATTENTION_RAW_SCORE_CAP;
}
```

If it doesn't fit, the dispatch picks `attention_decode_mixed_heads8_online_kernel` instead. This branching is invisible to the engine; the `ds4_gpu_attention_decode_mixed_tensor` primitive just routes.

### 11.8.1 The online softmax variant

`attention_decode_mixed_heads8_online_kernel` (`ds4_cuda.cu:3658-3870`) handles the long-context case. It uses **head-group-of-8** parallelism — eight heads share one block, with each warp (32 lanes) handling one head:

```cpp
__global__ static void attention_decode_mixed_heads8_online_kernel(...) {
    uint32_t t = blockIdx.x;
    uint32_t head_group = blockIdx.y;
    if (t >= n_tokens || head_dim != 512u) return;
    const uint32_t lane = threadIdx.x & 31u;
    const uint32_t warp = threadIdx.x >> 5u;
    const uint32_t head = head_group * 8u + warp;
    ...
    __shared__ uint32_t raw_rows[256];
    __shared__ float4 kv_shared[4 * 128];   // 8 KiB (much less than 32 KiB)
    ...
}
```

The structure is the standard online-softmax pattern:

- Iterate KV rows in chunks; for each chunk, compute scaled dot-products in registers, find running max, rescale running sum by `exp(old_max - new_max)`, accumulate new exp-weighted values.
- At the end, normalize by `denom = sum(exp(scores - max))`.

The trade-off: online softmax is *correct* for any context length, but it doesn't get to keep all scores in shared memory, so it can't batch the final V-projection. It runs slightly slower than the offline variant for short contexts, which is why the offline variant exists as a fast path for `n_comp <= 7936`.

Both kernels have the same `__global__` linkage and both are launched from the same host-side dispatcher (`ds4_gpu_attention_decode_mixed_tensor` and friends in the lower portion of `ds4_cuda.cu`). The dispatcher reads `n_comp` and `head_dim` and picks the right kernel.

## 11.9 CUDA cooperative groups vs. Metal threadgroups

Both Metal and CUDA expose an on-chip parallelism model: groups of threads cooperate via shared/threadgroup memory and warp/SIMD-group reductions. The naming and exact semantics differ:

| Concept | Metal | CUDA |
|---------|-------|------|
| Thread group | threadgroup | thread block |
| Shared memory per group | threadgroup memory | shared memory |
| Warp/lane | SIMD-group | warp |
| Warp size | 32 (on Apple Silicon) | 32 (NVIDIA) |
| Warp reduction primitives | `simd_*` (e.g. `simd_sum`) | `__shfl_*_sync` |
| Warp ballot | `simd_ballot` | `__ballot_sync` |
| Sub-group voting | (limited) | `cooperative_groups::coalesced_group` |
| Async copy | `simdgroup_async_copy_*` | `cuda::memcpy_async`, `cp.async` |
| Block-level sort | (manual) | `cub::BlockRadixSort` |

DS4 uses these patterns differently per backend:

- **Online softmax in Flash Attention.** Metal uses `simd_sum` for max and sum reductions; CUDA uses `__shfl_xor_sync` with the same loop unrolling.
- **Top-k merging.** Metal's `argsort.metal` implements a manual bitonic merge; CUDA's `indexer_topk_8192_cub_kernel` (`ds4_cuda.cu:5056`) uses `cub::BlockRadixSort<float, BLOCK_THREADS, ITEMS_PER_THREAD, uint32_t>` for the 8192-row case, getting CUB's heavily-tuned radix-sort implementation.
- **MoE expert reduction.** Both use shared-memory reductions across a warp; the CUDA `_qwarp32_kernel` suffix in `moe_down_sum6_qwarp32_kernel` (`ds4_cuda.cu:9208`) denotes "quantize, warp size 32" specialization.

The hand-written reductions on both backends produce the same numeric output for the same inputs, modulo TF32 vs. F32 differences when TF32 is enabled.

### 11.8.1 FP8 support

NVIDIA Hopper (sm_90) and later have native FP8 (E4M3 and E5M2) tensor-core support. DS4 does *not* use the native FP8 GEMM path even on Hopper — instead, its FP8 KV quantize/dequantize kernels operate in software via the same byte-level dequant logic that the Metal path uses.

This is intentional: the FP8 storage format chosen by DS4 (E4M3 with custom scaling, see `metal/dsv4_kv.metal`) does not exactly match Hopper's native FP8. The custom format trades some precision for a tighter dynamic range fitted to the DeepSeek V4 KV distribution. Using Hopper's tensor cores would require either changing the storage format (a model-side change) or padding/repacking on the fly (which would erase the perf gain).

Apple Silicon has no FP8 support; the Metal implementation uses the same software path. So FP8 on both backends is identical software, which is convenient for cross-platform debugging.

## 11.10 Build: the CUDA Makefile branch

The Makefile picks Metal or CUDA from `uname -s` (`Makefile:2-8`):

```makefile
UNAME_S := $(shell uname -s)

ifeq ($(UNAME_S),Darwin)
NATIVE_CPU_FLAG ?= -mcpu=native
else
NATIVE_CPU_FLAG ?= -march=native
endif
```

The Linux branch (`Makefile:21-34`) sets:

```makefile
CFLAGS += -D_GNU_SOURCE -fno-finite-math-only
CUDA_HOME ?= /usr/local/cuda
NVCC ?= $(CUDA_HOME)/bin/nvcc
CUDA_ARCH ?=
ifneq ($(strip $(CUDA_ARCH)),)
NVCC_ARCH_FLAGS := -arch=$(CUDA_ARCH)
endif
NVCCFLAGS ?= -O3 -g -lineinfo --use_fast_math $(NVCC_ARCH_FLAGS) \
             -Xcompiler $(NATIVE_CPU_FLAG) -Xcompiler -pthread
CUDA_LDLIBS ?= -lm -Xcompiler -pthread \
               -L$(CUDA_HOME)/targets/sbsa-linux/lib \
               -L$(CUDA_HOME)/lib64 \
               -lcudart -lcublas
CORE_OBJS = ds4.o ds4_cuda.o
```

Three things worth pointing at:

1. **`-fno-finite-math-only`** — added to the CPU compiler on Linux because some attention kernels rely on `inf`/`nan` for masked-out positions. Apple Clang doesn't need this.
2. **`-Xcompiler $(NATIVE_CPU_FLAG)`** — `nvcc` forwards the CPU flag to the host compiler (typically gcc or clang) so the host-side code gets native CPU codegen.
3. **`-L$(CUDA_HOME)/targets/sbsa-linux/lib`** — the SBSA path is the ARM-64 SBSA (Server Base System Architecture) variant of the CUDA libraries. This is the path used on DGX Spark / GB10.

### 11.9.1 The three target shortcuts

`Makefile:84-96`:

```makefile
cuda-spark:
    $(MAKE) ds4 ds4-server ds4-bench ds4-eval ds4-agent CUDA_ARCH=

cuda-generic:
    $(MAKE) ds4 ds4-server ds4-bench ds4-eval ds4-agent CUDA_ARCH=native

cuda:
    @if [ -z "$(strip $(CUDA_ARCH))" ]; then \
        echo "error: specify CUDA_ARCH, for example: make cuda CUDA_ARCH=sm_120"; \
        exit 2; \
    fi
    $(MAKE) ds4 ds4-server ds4-bench ds4-eval ds4-agent CUDA_ARCH="$(CUDA_ARCH)"
```

- `make cuda-spark` — empty `CUDA_ARCH`. `nvcc` auto-detects the SM version of the device present at compile time. This is the recommended path on DGX Spark.
- `make cuda-generic` — `CUDA_ARCH=native`. Same as `-arch=native`. Useful for workstations where the build machine has the target GPU installed.
- `make cuda CUDA_ARCH=sm_120` — explicit. Required for cross-compilation or for forcing a specific architecture in CI.

The compile rule for `ds4_cuda.o` (`Makefile:181-182`):

```makefile
ds4_cuda.o: ds4_cuda.cu ds4_gpu.h ds4_iq2_tables_cuda.inc
    $(NVCC) $(NVCCFLAGS) -c -o $@ ds4_cuda.cu
```

`ds4.c`, `ds4_cli.c`, `ds4_server.c`, `ds4_bench.c`, `ds4_eval.c`, `ds4_agent.c` are still compiled with `$(CC)` (gcc/clang). The final binary is linked via `nvcc` so the CUDA libraries are pulled in:

```makefile
# Makefile:98-99
ds4: ds4_cli.o linenoise.o $(CORE_OBJS)
    $(NVCC) $(NVCCFLAGS) -o $@ $^ $(CUDA_LDLIBS)
```

### 11.9.2 CPU-only path

Both Darwin and Linux can also build a CPU-only `ds4` (`Makefile:113-118` and `63-68`). The CPU build adds `-DDS4_NO_GPU` to `CFLAGS`, links *no* GPU library, and uses `ds4_cpu.o` (a build of `ds4.c` with `DS4_NO_GPU` defined). This is useful for debugging without a GPU and for the reference numerical path.

`make test` invokes the test binary, which uses the same backend as the host build (`Makefile:187-196`).

## 11.11 The long-context regression test

The CUDA-only `make cuda-regression` target builds and runs `tests/cuda_long_context_smoke.c`. The binary links *only* `ds4_cuda.o` (no engine, no `ds4.c`), so it tests the GPU primitives in isolation. Two tests:

### 11.10.1 `check_large_topk` (`tests/cuda_long_context_smoke.c:22`)

```c
const uint32_t n_comp = 32768;
const uint32_t n_tokens = 32;
const uint32_t top_k = 512;
```

Synthesizes a 32×32768 score matrix where each row is `[0, 1, 2, …, 32767]`, calls `ds4_gpu_indexer_topk_tensor`, and verifies that the returned top-512 are exactly `[32767, 32766, …, 32256]` (descending). The test also measures wall time and fails if it exceeds `DS4_CUDA_TOPK_REGRESSION_SEC` (default 2 seconds).

This catches two classes of regressions:

- **Correctness.** Any mistake in `cub::BlockRadixSort` orientation, merge order, or boundary handling would produce a wrong top-k. The synthetic input makes the expected output trivially checkable.
- **Performance.** A 32K-row top-k that suddenly takes >2s indicates a kernel launching with the wrong grid/block sizes or hitting a non-fast-path branch.

### 11.10.2 `check_decode_attention_overflow_path` (`tests/cuda_long_context_smoke.c:82`)

```c
const uint32_t n_comp = 8100;  // > DS4_CUDA_ATTENTION_RAW_SCORE_CAP (256)
```

`attention_decode_mixed_kernel` stores per-row scores in shared memory. The cap is `DS4_CUDA_ATTENTION_SCORE_CAP = 8192` (`ds4_cuda.cu:33`), with `DS4_CUDA_ATTENTION_RAW_SCORE_CAP = 256` reserved for the raw window. When `n_comp` exceeds `8192 - 256 = 7936`, the host-side dispatch must route to the online-softmax kernel (`attention_decode_mixed_heads8_online_kernel`) instead.

The test picks `n_comp = 8100` — just over the threshold — to ensure the routing decision actually fires. It dispatches a synthetic decode call with compressed-row values that should produce a near-1.0 attention output, then verifies the output is non-zero. The test does *not* check exact numerical output (the online kernel has slightly different rounding); it checks that the path executes correctly.

### 11.10.3 Why this exists

The combination of:

1. A fixed `DS4_CUDA_ATTENTION_SCORE_CAP` shared-memory cap (limits how many compressed rows a single kernel can score).
2. Routing logic that has to choose the right kernel based on `n_comp`.
3. Hopper/Ampere/Ada having different max-shared-memory-per-block limits (varying from 48 KiB to 228 KiB).

…makes the threshold a real source of regressions. Anyone changing the cap, the routing, or the kernel's shared-memory layout could silently break long-context decode without noticing on the short-context smoke runs that the rest of CI does. `make cuda-regression` is the dedicated guard.

## 11.12 Notable env vars

The CUDA backend has 30+ env vars (`grep -c "getenv" ds4_cuda.cu` returns 124 occurrences). The most user-facing ones:

| Variable | Purpose |
|----------|---------|
| `DS4_CUDA_NO_TF32` | Force `CUBLAS_DEFAULT_MATH`, disabling TF32 tensor cores (`ds4_cuda.cu:1216`) |
| `DS4_CUDA_NO_FD_CACHE` | Disable the fd-based weight cache (force per-range DMA) (`ds4_cuda.cu:228`) |
| `DS4_CUDA_DIRECT_MODEL` | Try direct read from fd into device memory (`ds4_cuda.cu:206`) |
| `DS4_CUDA_WEIGHT_CACHE` / `_PRELOAD` | Force the arena-copy path even when HMM is available (`ds4_cuda.cu:202-203`) |
| `DS4_CUDA_WEIGHT_CACHE_VERBOSE` | Print each weight range as it's cached, suppress periodic progress (`ds4_cuda.cu:251`) |
| `DS4_CUDA_COPY_MODEL` | Force `cuda_model_copy_chunked` path (`ds4_cuda.cu:697`) |
| `DS4_CUDA_NO_MODEL_PREFETCH` | Disable the async prefetch stream (`ds4_cuda.cu:696`) |
| `DS4_CUDA_MODEL_PREFETCH_SYNC` | Wait for prefetch completion before returning from set_model (`ds4_cuda.cu:757`) |
| `DS4_CUDA_MODEL_COPY_CHUNK_MB` | Chunk size for staged DMA upload (`ds4_cuda.cu:776`) |
| `DS4_CUDA_KEEP_MODEL_PAGES` | Don't `madvise(MADV_DONTNEED)` after upload (keeps host mmap pages resident) (`ds4_cuda.cu:789`) |
| `DS4_CUDA_NO_Q8_F16_CACHE` | Disable the Q8→F16 dequantization cache entirely (`ds4_cuda.cu:469`) |
| `DS4_CUDA_Q8_F16_ALL` | Cache *every* Q8_0 weight as F16 (very memory-hungry) (`ds4_cuda.cu:471`) |
| `DS4_CUDA_NO_ATTENTION_OUTPUT_F16_CACHE` | Disable the F16 cache for `attn_output` (`ds4_cuda.cu:477`) |
| `DS4_CUDA_NO_ATTN_Q_B_F16_CACHE` | Disable the F16 cache for `attn_q_b` (`ds4_cuda.cu:480`) |
| `DS4_CUDA_NO_Q8_DP4A` | Disable DP4A intrinsics (the int8 dot-product hardware path) (`ds4_cuda.cu:504`) |
| `DS4_CUDA_NO_Q8_F32_CACHE` | Disable Q8→F32 cache (`ds4_cuda.cu:517`) |
| `DS4_CUDA_Q8_F32_ALL` | Cache every Q8_0 weight as F32 (`ds4_cuda.cu:518`) |
| `DS4_CUDA_ATTN_Q_B_F32_CACHE` | Cache `attn_q_b` as F32 instead of F16 (`ds4_cuda.cu:520`) |
| `DS4_CUDA_TOPK_REGRESSION_SEC` | Timeout for the long-context regression test (default 2.0) |

The cache-knob density reflects the *empirical* nature of which weights are worth dequantizing in advance: each `DS4_CUDA_NO_*_CACHE` corresponds to a measured win that someone has occasionally needed to turn off (e.g. when device memory was already tight). The defaults are tuned for DGX Spark with q2-imatrix weights.

## 11.13 The Q8→F16 cache eligibility rules

The Q8→F16 dequantization cache (introduced in 11.6.3) is governed by `cuda_q8_f16_label_eligible` (`ds4_cuda.cu:469-499`). Reading it explains the heuristics:

```cpp
static int cuda_q8_f16_label_eligible(const char *label, uint64_t weight_bytes) {
    if (getenv("DS4_CUDA_NO_Q8_F16_CACHE") != NULL) return 0;
    if (!label) return 0;
    if (getenv("DS4_CUDA_Q8_F16_ALL") != NULL) return 1;
    if (!strcmp(label, "attn_output")) {
        // Attention output projection is hottest on the decode path; always cache.
        return getenv("DS4_CUDA_NO_ATTENTION_OUTPUT_F16_CACHE") == NULL;
    }
    if (!strcmp(label, "attn_q_b")) {
        // Q LoRA up projection; cache by default.
        return getenv("DS4_CUDA_NO_ATTN_Q_B_F16_CACHE") == NULL;
    }
    if (!strncmp(label, "ffn_", 4)) {
        // FFN weights are large (per-expert); cache only on explicit Q8_F16_ALL.
        return 0;
    }
    ...
}
```

Two design choices visible here:

1. **The cache is per-label, not per-tensor.** Every weight tensor in the GGUF carries a label string (e.g. `"attn_output"`, `"attn_q_b"`, `"ffn_down_exps"`). The cache key is the label plus the offset into the model file; the value is a `__half *` device pointer.
2. **The default is conservative.** Only two specific projections (`attn_output` and `attn_q_b`) are cached by default. Everything else requires explicit opt-in via `DS4_CUDA_Q8_F16_ALL`. The reason: dequantizing a Q8_0 weight to F16 doubles its size (Q8_0 is 1.0625 bytes/element with the scale; F16 is 2 bytes/element). For the 60+ GB of MoE expert weights, that doubling would push past device memory.

The cache's failure mode is graceful (`ds4_cuda.cu:450-460`):

```cpp
static void cuda_q8_f16_cache_disable_after_failure(const char *what, uint64_t needed_bytes) {
    if (!g_q8_f16_disabled_after_oom) {
        fprintf(stderr, "ds4: CUDA Q8→F16 cache disabled after %s (needed %.2f MiB)\n",
                what, (double)needed_bytes / 1048576.0);
    }
    g_q8_f16_disabled_after_oom = 1;
    ...
}
```

Once disabled, `cuda_q8_f16_eligible` returns 0 for *every* subsequent call until process exit, so the engine doesn't waste time retrying allocations that will fail.

### 11.13.1 Why this matters for inference latency

Decode latency is dominated by weight memory bandwidth: every token forward-passes through 43 layers' worth of weights. The Q8_0 dequantization cost — converting a packed 8-bit value to F32 — is small per element but happens for every element of every weight in the hot path.

For the attention output projection specifically (`weights->layer[il].attn_output`), the cache shifts this dequantization out of the hot loop:

- **Without cache:** `matmul_q8_0_preq_warp8_kernel` reads Q8_0 weights, dequantizes inline, multiplies. Each invocation reads N × M Q8_0 bytes from device memory.
- **With cache:** cuBLAS F16 GEMM reads N × M × 2 F16 bytes from device memory. The dequantization happens *once at load time*.

The trade-off is device memory used. For DS4 model sizes (`attn_output` is ~14 MiB per layer × 43 layers ≈ 600 MiB total in F16), the cache fits comfortably on the GB10's unified memory pool. On smaller workstation GPUs the cache may not fit at all — which is why `DS4_CUDA_NO_ATTENTION_OUTPUT_F16_CACHE` exists.

## 11.14 Async model prefetch

`ds4_cuda.cu:696-790` implements an asynchronous prefetch stream that warms the device-side weight cache while the engine is still doing CPU work (parsing GGUF metadata, building the layer-weight pointers, etc.). The choice to prefetch is gated by several env vars (`ds4_cuda.cu:696-700`):

```cpp
if (getenv("DS4_CUDA_NO_MODEL_PREFETCH") != NULL ||
    getenv("DS4_CUDA_COPY_MODEL") != NULL ||
    getenv("DS4_CUDA_WEIGHT_CACHE") != NULL ||
    getenv("DS4_CUDA_WEIGHT_PRELOAD") != NULL) {
    // Skip async prefetch; the synchronous path will handle this.
    return 1;
}
```

The async prefetch uses `g_model_prefetch_stream` (a non-default CUDA stream, `ds4_cuda.cu:84`). The default-stream compute that runs later — kernel launches from the engine — implicitly synchronizes against work on the prefetch stream when accessing the same memory regions, so the engine doesn't have to do explicit synchronization. CUDA's stream-priority and dependency model handles it.

The `DS4_CUDA_MODEL_PREFETCH_SYNC` env var forces a `cudaStreamSynchronize(g_model_prefetch_stream)` immediately after kickoff (`ds4_cuda.cu:757`), which converts the prefetch from async to sync. This is the debug mode for measuring how much wall-clock time the async prefetch is actually saving.

```cpp
if (getenv("DS4_CUDA_MODEL_PREFETCH_SYNC") != NULL) {
    err = cudaStreamSynchronize(g_model_prefetch_stream);
    ...
}
```

There is no equivalent on the Metal side. Apple Silicon's unified memory architecture means the model mmap is already "on the device" the moment the page-cache faults it in; no prefetch stream is meaningful.

## 11.15 Debugging and observability differences

The CUDA and Metal backends have very different debug surfaces:

| Concern | Metal | CUDA |
|---------|-------|------|
| Kernel launch failure | `cb.status == MTLCommandBufferStatusError` after `waitUntilCompleted` | `cudaGetLastError()` after launch |
| Out-of-memory | Allocation returns nil from `newBufferWithLength:` | `cudaMalloc` returns `cudaErrorMemoryAllocation` |
| Per-kernel profiling | `MTLCaptureManager`, Xcode GPU Capture | `nsys profile`, `ncu`, `cuda-memcheck` |
| Validation layer | Metal validation in Xcode | `compute-sanitizer` (replacement for `cuda-memcheck`) |
| Build-time errors | Runtime (Metal source is compiled at load time) | Compile-time (nvcc fails the build) |
| Symbol-level debug | `setLabel:` on buffers + Xcode | `-lineinfo` + ncu source view |
| Memory leaks | ARC's ref counting + Instruments | manual `cudaMalloc`/`cudaFree` discipline + `cuda-memcheck` |

The most practical difference: CUDA errors are *immediately* returned from the launch site, while Metal errors are surfaced only after `commit` and `waitUntilCompleted`. CUDA's `cudaGetLastError()` resets sticky-error state, so a missed check at one launch poisons all later checks until cleared. The DS4 code wraps every launch in `cuda_ok(...)` to enforce this discipline:

```cpp
// ds4_cuda.cu (typical pattern, used throughout)
kernel<<<grid, block, smem, stream>>>(args...);
if (!cuda_ok(cudaGetLastError(), "kernel name launch")) return 0;
```

`cuda_ok` (`ds4_cuda.cu:149`) prints a diagnostic with the kernel name on failure, returns 0, and resets `cudaGetLastError()` so the failure doesn't propagate to the next check.

Metal has no such per-call check; failures surface at the next `waitUntilCompleted`. `ds4_gpu_wait_command_buffer` (`ds4_metal.m:270-277`) handles them:

```objc
static int ds4_gpu_wait_command_buffer(id<MTLCommandBuffer> cb, const char *label) {
    [cb waitUntilCompleted];
    if (cb.status == MTLCommandBufferStatusError) {
        fprintf(stderr, "ds4: Metal %s failed: %s\n",
                label, [[cb.error localizedDescription] UTF8String]);
        return 0;
    }
    return 1;
}
```

For both backends, the rendered error message tells the user *which* kernel (Metal) or *which* primitive (CUDA, via the `cuda_ok` label) failed. Neither backend includes a Python-style traceback; the labels are the localization mechanism.

## 11.16 What we left for later

This chapter outlined the CUDA backend's structure and contrasted it with Metal. Three deeper topics belong to their own future chapters:

- **The numerics validation suite.** `ds4_eval.c` runs token-by-token comparisons between backends to catch numerical drift; it depends on backend-specific weight access patterns and is interesting in its own right.
- **CUDA kernel internals.** The Flash Attention kernels, the indexed-mixed-attention long-context path, the MoE warp-shuffle reductions — each is dense math with its own optimizations worth a detailed walkthrough. This chapter named them; a future chapter could walk one of them stage by stage.
- **The DGX Spark hardware platform.** GB10 is a recent SoC; its exact memory hierarchy (LPDDR5X bandwidth, on-package NVLink, HBM-or-LPDDR variants) shapes which kernel optimizations matter. A dedicated platform writeup would document the specific tunings ds4 picks for Spark vs. workstation NVIDIA hardware.

The throughline: **CUDA implements the same `ds4_gpu.h` contract Metal does, trades command-buffer batching for stream queuing, and adds cuBLAS plus an aggressive Q8→F16 weight cache to recover the matmul performance.** The engine code in `ds4.c` doesn't see any of it, which is why the same C source produces working binaries on both platforms.

The single-file structure of `ds4_cuda.cu` deserves one closing note. The file is 10,737 lines, all in one translation unit. There's no header that breaks out the kernel declarations; the file is meant to be read end-to-end (or grep'd for the specific kernel of interest). That choice keeps compile-time symbol resolution simple — every helper is `static`, every kernel is `__global__ static`, every exported function is `extern "C"`. The price is one slow nvcc compile per backend change. The benefit is that `ds4_cuda.cu` is *the* CUDA backend; there's no header to keep in sync, no internal API to version, and no risk of dynamic library mismatches at deploy time.

## Related chapters

- Chapter 10: Metal Backend and Kernels — the same `ds4_gpu.h` API implemented in Objective-C with Metal command buffers.
- Chapter 12: Speculative Decoding and MTP — runs transparently on either backend through the shared graph scheduler.
