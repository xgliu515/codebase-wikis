# Chapter 10: Metal Backend and Kernels

> Code version locked to `antirez/ds4@f91c12b` (2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 10.1 The problem this chapter solves

DeepSeek V4 Flash is a 43-layer Mixture-of-Experts transformer with a four-way Hyper-Connection residual stream, FP8 KV cache, ratio-4 indexed attention, and a sliding-window raw cache. On Apple Silicon every one of those concepts has to land in a Metal compute kernel that runs inside an `MTLCommandBuffer`. On Linux/CUDA the same concepts have to land in CUDA kernels launched into the default stream (chapter 11). Whatever the backend is, the C engine in `ds4.c` is the same code: it builds graph state, sweeps through layers, and reads back logits.

That cross-backend symmetry is paid for by a narrow, *tensor-resident* C API declared in `ds4_gpu.h`. The engine never touches a `MTLBuffer` or a `cudaMalloc` pointer. Instead it holds opaque `ds4_gpu_tensor *` handles whose lifetime is the lifetime of the session, and it submits work through a fixed set of primitives: `ds4_gpu_embed_token_hc_tensor`, `ds4_gpu_matmul_q8_0_tensor`, `ds4_gpu_rms_norm_plain_tensor`, `ds4_gpu_attention_decode_mixed_tensor`, and dozens more. The Objective-C glue in `ds4_metal.m` (15,738 lines) maps each primitive to a kernel function loaded from one of the 19 `.metal` files under `metal/`, and arranges the calls into one large command buffer per token (decode) or one per layer (long-prompt prefill).

This chapter walks the Metal-side machinery from the bottom up:

1. The `ds4_gpu.h` contract and why the API is tensor-resident (10.2).
2. `ds4_metal.m` initialization, the per-session `MTLDevice`/`MTLCommandQueue`/`MTLLibrary` triple, and the `DS4MetalTensor` wrapper (10.3).
3. The command-batching state machine: `g_batch_cb`, `g_batch_enc`, `g_pending_cbs` (10.4).
4. The 19 kernel files in `metal/`, grouped by stage (10.5).
5. `ds4_gpu_graph` — the per-session pile of tensors that decode and prefill swap through (10.6).
6. Decode: single-token layer encoder with the four-layer flush split (10.7).
7. Prefill: layer-major batched encoder, chunked execution, the `DS4_METAL_PREFILL_CHUNK` knob (10.8).
8. How the Metal binding pattern differs from CUDA's stream-launch pattern (10.9).
9. Debug environment variables and where they hook in (10.10).

It deliberately stops short of the kernel internals (the actual shader math) — that level of detail belongs to a future chapter on numerics.

```
+----------------------+        +-------------------------+        +-------------------+
| ds4.c                |        | ds4_metal.m (15.7k LOC) |        | metal/ (19 files) |
| - model semantics    |        | - MTLDevice/Queue/Lib   |        | - flash_attn      |
| - graph scheduling   |  C API | - DS4MetalTensor wrap   | Metal  | - moe             |
| - decode/prefill     |------->| - command batching      |------->| - dsv4_hc         |
| - speculative state  | header | - argument buffer pack  | shader | - dsv4_kv         |
|   machine            |        | - 200+ primitive impls  | lang   | - dsv4_rope       |
|                      |        |                         |        | - dsv4_misc       |
+----------------------+        +-------------------------+        | - dense/glu/norm  |
                                                                   | - softmax/argsort |
                                                                   | - get/set_rows    |
                                                                   | - cpy/concat/...  |
                                                                   +-------------------+
```

The throughline is: **the engine sees a tensor calculator; the Metal backend sees a kernel dispatcher; the kernel files see math.** Each layer hides the next, and the boundary is `ds4_gpu.h`.

## 10.2 The `ds4_gpu.h` contract

`ds4_gpu.h` (819 lines) is the *only* file `ds4.c` includes to talk to the GPU. Its header explains the contract (`ds4_gpu.h:1-16`):

```c
/* =========================================================================
 * GPU Tensor and Command Lifetime.
 * =========================================================================
 *
 * Opaque device tensor used by the DS4-specific GPU executor.
 *
 * The public GPU API is tensor-resident: activations, KV state, and scratch
 * buffers stay device-owned across the whole prefill/decode command sequence.
 */
typedef struct ds4_gpu_tensor ds4_gpu_tensor;
```

"Tensor-resident" is the key idea. Once a tensor is allocated, it stays on device until freed; the engine never copies activations or KV state to host memory in the hot path. The only host-side traffic is (a) writing prompt token ids (`ds4_gpu_tensor_write`) before prefill, and (b) reading the final logits row (`ds4_gpu_tensor_read`) after decode. Everything in between — embeddings, intermediate hidden states, attention scores, the FP8 KV ring, compressed pool, indexer scratch — lives on the GPU.

Five primitive groups cover the surface:

1. **Tensor lifetime** (`ds4_gpu.h:21-35`) — `ds4_gpu_tensor_alloc`, `_alloc_managed`, `_view`, `_free`, `_bytes`, `_contents`, `_fill_f32`, `_write`, `_read`, `_copy`, `_copy_f32_to_f16`. Managed allocation routes through CUDA Unified Memory on Linux when the KV cache won't fit in pinned device memory; on Metal it is treated identically to regular allocation because the unified-memory model already covers the case.

2. **Command batching** (`ds4_gpu.h:37-40`):

   ```c
   int ds4_gpu_begin_commands(void);
   int ds4_gpu_flush_commands(void);
   int ds4_gpu_end_commands(void);
   int ds4_gpu_synchronize(void);
   ```

   These four functions define the *batch* boundary visible to the engine. `begin` opens a new `MTLCommandBuffer`; `flush` commits the current one and opens a fresh buffer so encoding can continue; `end` commits and waits; `synchronize` waits for anything pending without opening a new buffer. The CUDA backend implements the same four functions with `cudaDeviceSynchronize` (chapter 11) — making the engine's batching code portable.

3. **Model residency** (`ds4_gpu.h:42-49`):

   ```c
   int ds4_gpu_set_model_map(const void *model_map, uint64_t model_size);
   int ds4_gpu_set_model_fd(int fd);
   int ds4_gpu_set_model_map_range(const void *model_map, uint64_t model_size, uint64_t map_offset, uint64_t map_size);
   int ds4_gpu_cache_model_range(const void *model_map, uint64_t model_size, uint64_t offset, uint64_t bytes, const char *label);
   int ds4_gpu_cache_q8_f16_range(const void *model_map, uint64_t model_size, uint64_t offset, uint64_t bytes, uint64_t in_dim, uint64_t out_dim, const char *label);
   int ds4_gpu_should_use_managed_kv_cache(uint64_t kv_cache_bytes, uint64_t context_bytes);
   void ds4_gpu_set_quality(bool quality);
   void ds4_gpu_print_memory_report(const char *label);
   ```

   These eight calls are the cache (GPU-side weight residency) cooperation surface. On Metal, the mmap'd GGUF file is wrapped as an `MTLBuffer` view that participates in the device's residency set (10.3.3). On CUDA, the same range may be DMA-copied into device memory or accessed via HMM (chapter 11). The engine passes weight offsets through the same wire shape regardless.

4. **Embedding / matmul / norm / attention / MoE primitives** (`ds4_gpu.h:51-819`) — 200+ functions corresponding to roughly the same number of named kernels. Each primitive takes a result tensor, the operands (input tensors plus offset/dim metadata for model weight slices), and any per-call constants. There is no general kernel-launch helper; every primitive has its own typed entry point. This is verbose but makes both sides debuggable: a stack frame names the actual operation.

5. **Lifecycle** (`ds4_gpu.h:18-19`):

   ```c
   int ds4_gpu_init(void);
   void ds4_gpu_cleanup(void);
   ```

   Symmetric init/cleanup. The engine calls them once per process.

The contract has **no model semantics**. The header does not know what HC is, does not know the layer count, does not know about MTP. It knows about tensors, model-map offsets, and kernel-shaped primitives. The model semantics live in `ds4.c`; the kernels live under `metal/`. The Metal/CUDA glue is squarely in the middle.

## 10.3 `ds4_metal.m` runtime initialization

### 10.3.1 The header

The top of `ds4_metal.m:18-27` spells out the design boundary:

```objc
/*
 * Objective-C Metal glue for the C engine.
 *
 * The C code owns model semantics and graph scheduling.  This file owns only
 * Metal objects: device/queue/library setup, mmap-backed weight views, command
 * batching, persistent tensors, scratch buffers, and thin wrappers around the
 * kernel files in the metal directory.  Keeping this boundary narrow makes the
 * inference path readable from C while still using Objective-C where Metal
 * requires it.
 */
```

This boundary is enforced by what's *not* there. `ds4_metal.m` never includes `ds4.h`'s engine internals (no `ds4_session`, no `ds4_weights`); it only includes `ds4.h` and `ds4_gpu.h`. Conversely, `ds4.c` never includes a Metal header — even though it builds command-buffer-shaped sequences, it does so through the `ds4_gpu.h` portal.

### 10.3.2 Global Metal state

The handful of file-scope variables at the top of `ds4_metal.m:35-40` is the entire Metal runtime:

```objc
static id<MTLDevice> g_device;
static id<MTLCommandQueue> g_queue;
static id<MTLLibrary> g_library;
static id<MTLCommandBuffer> g_batch_cb;
static id<MTLComputeCommandEncoder> g_batch_enc;
static NSMutableArray<id<MTLCommandBuffer>> *g_pending_cbs;
```

Plus 130-odd `id<MTLComputePipelineState> g_*_pipeline` slots (`ds4_metal.m:41-188`) — one per kernel function ever launched. Pipeline states are expensive to build (a small JIT compile per `[device newComputePipelineStateWithFunction:]`), so each one is built once and cached for the life of the process.

`ds4_gpu_init` (`ds4_metal.m:2949`) walks through:

1. `MTLCreateSystemDefaultDevice()` — picks the highest-performance GPU.
2. `[g_device newCommandQueue]` — one queue for the whole process. There is no multi-queue parallelism in ds4; everything goes through this one queue.
3. Loads `MTLLibrary` from the `metal/*.metal` source files compiled into the binary. The source is compiled at runtime via `[g_device newLibraryWithSource:options:error:]` (`ds4_metal.m:3036`), which gives the runtime full Metal Standard Library access and lets the kernel files use template-style `#define`-driven specializations.

Pipeline states are not built up-front. Instead, the first call to a particular primitive allocates the pipeline lazily inside the primitive function. The shared helper `ds4_gpu_get_or_build_pipeline(name)` (used throughout `ds4_metal.m`) checks the cached slot, and if empty, fetches the function from `g_library` and builds the pipeline. This deferred build means a process that never touches MoE never pays the MoE-kernel compile cost.

### 10.3.3 The `DS4MetalTensor` wrapper

The opaque `ds4_gpu_tensor *` that the engine sees is — on Metal — a bridged pointer to an Objective-C object (`ds4_metal.m:211-219`):

```objc
@interface DS4MetalTensor : NSObject
@property(nonatomic, strong) id<MTLBuffer> buffer;
@property(nonatomic, assign) uint64_t offset;
@property(nonatomic, assign) uint64_t bytes;
@property(nonatomic, assign) uint8_t owner;
@end

@implementation DS4MetalTensor
@end
```

Four fields:

- `buffer` — the underlying `MTLBuffer`. Multiple tensor objects can share the same buffer when one is a `ds4_gpu_tensor_view` over the other.
- `offset` — byte offset into the buffer. Views use a nonzero offset; owning tensors use zero.
- `bytes` — logical size of the tensor.
- `owner` — 1 if this object owns the buffer (and must release it on free), 0 if it's a view.

The bridge helpers (`ds4_metal.m:221-239`) cast between `ds4_gpu_tensor *` and `DS4MetalTensor *` without copying. Under ARC, this works because the engine holds a `(__bridge_retained DS4MetalTensor *)` reference: when `ds4_gpu_tensor_free` is called, it bridge-transfers back into ARC and the object is released.

### 10.3.4 Model-residency views

The mmap'd GGUF file is wrapped in `MTLBuffer` views via `ds4_gpu_set_model_map` and `ds4_gpu_set_model_map_range`. Each view is recorded in `g_model_views[DS4_METAL_MAX_MODEL_VIEWS]` (`ds4_metal.m:208`). When a kernel needs a weight slice, the primitive function locates the right view, computes the byte offset within it, and binds the buffer to the encoder with `setBuffer:offset:atIndex:`.

This is the equivalent of CUDA's `g_model_device_base` (chapter 11), but with one crucial difference: on Apple Silicon, the buffer view *is* the mmap'd page, with no copy. The unified-memory architecture lets the GPU read directly from the same physical pages that `mmap` brought into the page cache. On discrete-GPU CUDA the equivalent operation is a DMA upload; on DGX Spark's GB10, HMM can avoid the copy in many cases (chapter 11.6).

## 10.4 Command-buffer batching

### 10.4.1 Why batch at all

Every `MTLCommandBuffer` has a per-submit cost (the kernel needs to schedule it, the GPU needs to context-switch in, etc.). A DS4 decode step calls roughly 200 distinct kernels — `embed_token_hc`, then ~15 per layer for 43 layers, then 6 for the output head. If each kernel committed its own command buffer, those 200 submits would dominate the actual GPU work.

The fix is to encode many primitives into one command buffer. The engine signals batch boundaries with `ds4_gpu_begin_commands` and `ds4_gpu_end_commands`:

```c
// ds4.c:13139 (decode), as one example
bool ok = ds4_gpu_begin_commands() != 0;
if (ok) ok = metal_graph_encode_token_raw_swa(g, model, weights, token, pos,
                                               logits != NULL, true);
if (ok) ok = ds4_gpu_end_commands() != 0;
```

Inside `metal_graph_encode_token_raw_swa`, 200+ primitives run; each appends to the *single* command buffer that `g_batch_cb` points to. Only at `end_commands` does the buffer commit and wait.

### 10.4.2 The four-function state machine

`ds4_gpu_begin_commands` (`ds4_metal.m:4325-4330`):

```objc
int ds4_gpu_begin_commands(void) {
    if (!g_initialized && !ds4_gpu_init()) return 0;
    if (g_batch_cb) return 0;
    g_batch_cb = [g_queue commandBuffer];
    return g_batch_cb != nil;
}
```

Opens one fresh buffer. The function explicitly *fails* (returns 0) if there's already a batch open — re-entry would be a programming bug because the engine is supposed to think in terms of "one batch open at a time."

`ds4_gpu_flush_commands` (`ds4_metal.m:4332-4349`):

```objc
int ds4_gpu_flush_commands(void) {
    if (!g_initialized && !ds4_gpu_init()) return 0;
    if (!g_batch_cb) return 0;

    ds4_gpu_close_batch_encoder();
    id<MTLCommandBuffer> cb = g_batch_cb;
    g_batch_cb = nil;
    [cb commit];
    [g_pending_cbs addObject:cb];

    g_batch_cb = [g_queue commandBuffer];
    ...
    return 1;
}
```

Commits the current buffer *without waiting*, parks it in `g_pending_cbs`, and immediately opens a fresh one so encoding can continue. The GPU starts executing the committed buffer while the CPU encodes the next batch. This is the load-bearing primitive for CPU/GPU overlap. The engine uses it in `metal_graph_encode_token_raw_swa` (10.7.2) to overlap CPU encoding of layers 5-43 with GPU execution of layers 1-4.

`ds4_gpu_end_commands` (`ds4_metal.m:4351-4357`):

```objc
int ds4_gpu_end_commands(void) {
    if (!g_batch_cb) return 0;
    ds4_gpu_close_batch_encoder();
    id<MTLCommandBuffer> cb = g_batch_cb;
    g_batch_cb = nil;
    return ds4_gpu_finish_command_buffer(cb, 1, "command batch");
}
```

Commits the current buffer and *waits* (`finish_command_buffer` calls `waitUntilCompleted`, and also drains `g_pending_cbs`). After `end_commands` returns success, all GPU work the engine submitted is complete and read-backs are safe.

`ds4_gpu_synchronize` (`ds4_metal.m:4403-4415`) is the no-op-friendly variant: if a batch is open it calls `end_commands`; otherwise it drains pending buffers; otherwise it does nothing.

### 10.4.3 Encoder lifetime within one buffer

A `MTLCommandBuffer` cannot have multiple compute encoders open at once. Every primitive that wants to dispatch a kernel either creates its own encoder or reuses `g_batch_enc`. The helpers `ds4_gpu_command_buffer` (`ds4_metal.m:241-248`) and `ds4_gpu_compute_encoder` (`ds4_metal.m:250-256`) make this transparent:

```objc
static id<MTLCommandBuffer> ds4_gpu_command_buffer(int *owned) {
    if (g_batch_cb) { *owned = 0; return g_batch_cb; }
    *owned = 1;
    return [g_queue commandBuffer];
}

static id<MTLComputeCommandEncoder> ds4_gpu_compute_encoder(id<MTLCommandBuffer> cb) {
    if (g_batch_cb && cb == g_batch_cb) {
        if (!g_batch_enc) g_batch_enc = [cb computeCommandEncoder];
        return g_batch_enc;
    }
    return [cb computeCommandEncoder];
}
```

When a batch is open, *all* primitives share the same encoder (`g_batch_enc`). The encoder is closed lazily — `ds4_gpu_close_batch_encoder` (`ds4_metal.m:264-268`) ends the encoding only when the batch itself commits, or when a primitive needs to *not* be inside a compute encoder (e.g. a blit-copy primitive that uses an `MTLBlitCommandEncoder` instead).

That shared encoder is the *real* batching mechanism. One encoder means one Metal `setComputePipelineState` flip per kernel, but all kernels see one wall-clock dispatch queue. Compared to per-primitive encoders, shared-encoder dispatch is roughly 5-10× lower-overhead per kernel.

```
+-----------------------------------------------------------+
| Engine: ds4_gpu_begin_commands()                          |
|        -> g_batch_cb := [queue commandBuffer]             |
+-----------------------------------------------------------+
| Engine: ds4_gpu_embed_token_hc_tensor(...)                |
|        -> ds4_gpu_command_buffer(&owned) = g_batch_cb     |
|        -> ds4_gpu_compute_encoder(cb) creates g_batch_enc |
|        -> setComputePipelineState(embed_hc_pipeline)      |
|        -> dispatchThreadgroups(...)                       |
+-----------------------------------------------------------+
| Engine: ds4_gpu_matmul_q8_0_tensor(...) [Layer 0 Q proj]  |
|        -> reuses g_batch_cb and g_batch_enc               |
|        -> setComputePipelineState(matmul_q8_0_pipeline)   |
|        -> dispatchThreadgroups(...)                       |
+-----------------------------------------------------------+
| ... 200 more primitives ...                               |
+-----------------------------------------------------------+
| Engine: ds4_gpu_flush_commands()  [after layer 4]         |
|        -> [g_batch_enc endEncoding]                       |
|        -> [g_batch_cb commit]                             |
|        -> g_pending_cbs += g_batch_cb                     |
|        -> g_batch_cb := [queue commandBuffer]             |
| GPU starts running while CPU encodes layers 5-43          |
+-----------------------------------------------------------+
| Engine: ds4_gpu_end_commands()                            |
|        -> waitUntilCompleted on g_batch_cb                |
|        -> wait on every g_pending_cbs                     |
+-----------------------------------------------------------+
| Engine: ds4_gpu_tensor_read(g->logits, ...)               |
|        Logits already populated; this is host-side memcpy |
+-----------------------------------------------------------+
```

### 10.4.4 Why the engine can stay backend-agnostic

The engine code never sees `MTLCommandBuffer`. It calls four `ds4_gpu_*_commands` functions, and the Metal/CUDA backends implement them differently:

| Engine call             | Metal action                                  | CUDA action                |
|-------------------------|-----------------------------------------------|----------------------------|
| `begin_commands()`      | New `MTLCommandBuffer`, set as `g_batch_cb`   | Return 1 (noop)            |
| `flush_commands()`      | Commit current CB, queue it, open new CB      | `cudaDeviceSynchronize()`  |
| `end_commands()`        | Commit current CB and wait                    | `cudaDeviceSynchronize()`  |
| `synchronize()`         | Wait on all pending CBs                       | `cudaDeviceSynchronize()`  |

(CUDA detail in `ds4_cuda.cu:1412-1415` — see chapter 11.) The reason the engine code in `ds4.c` works on both backends is precisely this contract.

## 10.5 The 19 Metal kernel files

`metal/` (9,183 total lines across 19 files) groups kernels by stage. Reading `ls metal/` is the fastest tour:

| File                  | Lines | Role |
|-----------------------|-------|------|
| `flash_attn.metal`    | 1,426 | Flash Attention prefill: padding, block, vec, reduce variants. Heavy template machinery (`kernel_flash_attn_ext_pad` at line 139, `kernel_flash_attn_ext_blk` at 208, the vectorized `kernel_flash_attn_ext_vec` at 961, the reduce stage at 1386). |
| `moe.metal`           | 1,873 | Routed expert matmul-vec for `IQ2_XXS` (gate/up), `Q2_K` (down), and `Q4_K` variants. Includes paired and sum-6 versions that fuse the six top-k experts into one dispatch. |
| `dsv4_hc.metal`       |   885 | Hyper-Connection ops: 4-way split (`kernel_dsv4_hc_split_sinkhorn` at 107, `kernel_dsv4_hc_split_weighted_sum` at 282, the norm-fused variant `_norm4` at 395), expand (`kernel_dsv4_hc_expand` at 541, `_expand4` at 579), and the fused down+expand kernels (`kernel_dsv4_shared_down_hc_expand4_q8_0` at 631, `kernel_dsv4_q8_hc_expand4_q8_0` at 752). |
| `dsv4_misc.metal`     | 1,327 | Indexer (`kernel_dsv4_indexer_score_one_direct` at 142, tiled scoring at 841/974), router weight selection (201/226), top-k mask, sort, indexed mixed-attention kernels (`kernel_dsv4_indexed_mixed_attention_heads8` at 577, `_rb16` at 685), directional steering projection. |
| `dsv4_kv.metal`       |   314 | FP8 KV quantize/store: `kernel_dsv4_fp8_kv_quantize_f32` at 104, the indexer's FP4 Hadamard at 156, the decode-fused `kernel_dsv4_kv_fp8_store_f32` at 208 (writes raw-cache row and indexer-cache row in one dispatch), and `kernel_dsv4_compressor_store_one` at 288 (compressor frontier update). |
| `dsv4_rope.metal`     |   165 | DS4 tail RoPE: rotates only the trailing `n_rot=64` dimensions of `head_dim=128`, leaving the leading `n_nope` dimensions untouched. |
| `dense.metal`         | 1,600 | Q/KV/attention-output projections: `matmul_q8_0` is the workhorse (decode and prefill); `matmul_f16` is used for HC mix projections; `matmul_f32` handles full-precision paths. |
| `glu.metal`           |    40 | SwiGLU fusion of gate and up activations for the shared expert. |
| `softmax.metal`       |   241 | Standard `soft_max_f32` plus DS4-specific compressed-pool softmax. |
| `argsort.metal`       |   266 | F32 descending argsort and merge; used by the indexer top-k. |
| `norm.metal`          |   160 | RMS norm: plain (no weight), with weight, and the fused QKV variant. |
| `get_rows.metal`      |    54 | Token embedding lookup (F32/F16/I32 variants for HC seeding and prompt-token gather). |
| `set_rows.metal`      |    55 | Symmetric scatter. |
| `cpy.metal`           |    57 | F32↔F16 elementwise copies. |
| `concat.metal`        |    62 | Tensor concatenation. |
| `repeat.metal`        |    52 | Single-row broadcast across HC channels (1 → N_HC). |
| `sum_rows.metal`      |   102 | Row-wise reduction for router weight normalization. |
| `bin.metal`           |   192 | Elementwise binary ops (`mul_scalar`, `div_row`). |
| `unary.metal`         |   312 | Unary ops: sigmoid, silu, softplus, sqrt, clamp, scale, fill. |

Each file uses `kernel void` Metal Shading Language entry points that the Objective-C side fetches by name. `flash_attn.metal:889-925` is a good example of how templating works:

```msl
kernel void kernel_flash_attn_ext(...) {
    // generic body
}

// Explicit template instantiation for DS4's K=512, V=512 case:
kernel flash_attn_ext_dk512_t kernel_flash_attn_ext<
    FA_NONVEC_TYPES, half4x4, 1, dequantize_f16,
    half4x4, 1, dequantize_f16, 512, 512>;
```

This is C++-style template specialization, used by Metal-Standard-Library kernels to produce one optimized variant per (K dim, V dim, dequant function) tuple at shader-compile time.

### 10.5.1 Why one file per stage, not one file per kernel

Two reasons. First, kernels in the same stage share helper functions: every routed-expert kernel in `moe.metal` uses the same dequantization helpers for `IQ2_XXS` blocks; every Flash-Attention kernel in `flash_attn.metal` uses the same online softmax accumulator. Putting them in one file lets the helpers be `static`/`inline` rather than exported. Second, the Metal source is compiled at runtime — one file is one compile unit. With 19 compile units and one cold compile, library setup is ~0.5-1 second instead of ~5 seconds with 100+ files.

## 10.6 `ds4_gpu_graph` — the per-session tensor pile

`ds4_gpu_graph` (`ds4.c:8179-8330`) is the central data structure of the entire backend. One session has one of these. It contains every device tensor the session uses, divided into five regions:

```
+-----------------------------------------------------+
| ds4_gpu_graph (per session)                         |
+-----------------------------------------------------+
| (1) Decode work tensors (ds4.c:8179-8196)           |
|     cur_hc, flat_hc, hc_mix, hc_split,              |
|     attn_cur, attn_norm, qr, qr_norm, q,            |
|     kv_raw, kv, hc_pre, hc_post, hc_comb            |
+-----------------------------------------------------+
| (2) Persistent KV state (ds4.c:8198-8209)           |
|     layer_raw_cache[DS4_N_LAYER]    (ring per layer)|
|     layer_attn_comp_cache[DS4_N_LAYER]              |
|     layer_attn_state_kv/score[DS4_N_LAYER]          |
|     layer_index_comp_cache[DS4_N_LAYER]             |
|     layer_index_state_kv/score[DS4_N_LAYER]         |
+-----------------------------------------------------+
| (3) Speculative scratch (ds4.c:8211-8228)           |
|     spec_attn_state_kv/score[DS4_N_LAYER]           |
|     spec_index_state_kv/score[DS4_N_LAYER]          |
|     spec_prefix1_attn_state_kv/score[DS4_N_LAYER]   |
|     spec_prefix1_index_state_kv/score[DS4_N_LAYER]  |
|     spec_logits                                     |
|     layer_n_comp/index_comp[DS4_N_LAYER]            |
|     spec_capture_prefix1                            |
+-----------------------------------------------------+
| (4) MTP state (ds4.c:8277-8292)                     |
|     mtp_embed, mtp_enorm, mtp_eproj, mtp_eproj_hc,  |
|     mtp_hnorm_hc, mtp_hproj_hc, mtp_input_hc,       |
|     mtp_state_hc, mtp_next_hc, mtp_raw_cache,       |
|     mtp_n_raw, prefill_cap, raw_window              |
+-----------------------------------------------------+
| (5) Batched prefill tensors (ds4.c:8294-...)        |
|     prefill_tokens, batch_cur_hc, batch_next_hc,    |
|     batch_flat_hc, batch_hc_mix, batch_hc_split,    |
|     batch_attn_cur, batch_attn_norm, batch_qr, ...  |
+-----------------------------------------------------+
```

The four governing scalars are at `ds4.c:8229-8236`:

```c
uint32_t raw_cap;               // raw SWA ring capacity (rows)
uint32_t comp_cap;              // worst-case compressed cap across layers
uint32_t layer_comp_cap[DS4_N_LAYER]; // per-layer compressed cap
uint32_t attn_comp_stage_cap;   // staging buffer cap for attn-compressed prefill
uint32_t raw_window;            // logical SWA window (= DS4_N_SWA)
uint32_t prefill_cap;           // max tokens per prefill ubatch
```

Two of these merit a closer look:

- **`raw_cap` vs. `raw_window`.** `raw_window` is the *logical* attention window the model uses (DS4_N_SWA = 128 tokens). `raw_cap` is the *physical* row count of the ring buffer the engine allocates per layer; it must be at least `raw_window + prefill_cap` so a prefill ubatch can be written into the ring without overwriting still-visible rows. The formula at `ds4.c:8822-8824` enforces this: `raw_cap = max(raw_cap, raw_window)` then clamped to `ctx_size`.

- **`layer_comp_cap[il]` vs. `comp_cap`.** Different layers have different compression ratios (some are ratio-4, some are ratio-128, some are uncompressed). The per-layer cap (`ds4.c:8840-8847`) is `ctx_size / ratio + 2`; the global `comp_cap` is the same formula with `min_ratio`, used to size *shared* work tensors that all layers might use. Sizing per-layer caches at the per-layer ratio (rather than the worst case) saves multiple gigabytes at long context for ratio-128 layers.

### 10.6.1 Allocation: `metal_graph_alloc_raw_cap`

`metal_graph_alloc_raw_cap` (`ds4.c:8806-9136`) is the only allocation entry point. It receives `raw_cap`, `ctx_size`, `prefill_cap`, and `enable_mtp`; from those it derives every other size constant, then makes one `ds4_gpu_tensor_alloc` call per named tensor.

```c
// ds4.c:8806-8848 (abridged)
static bool metal_graph_alloc_raw_cap(
        ds4_gpu_graph *g,
        const ds4_weights     *weights,
        const ds4_layer_weights *layer,
        uint32_t                raw_cap,
        uint32_t                ctx_size,
        uint32_t                prefill_cap,
        bool                    enable_mtp) {
    memset(g, 0, sizeof(*g));
    g->mtp_enabled = enable_mtp;
    ...
    if (raw_cap < raw_window) raw_cap = raw_window;
    if (raw_cap > ctx_size) raw_cap = ctx_size;
    g->raw_cap = raw_cap;
    g->raw_window = raw_window;
    g->prefill_cap = prefill_cap;
    g->comp_cap = ctx_size / min_ratio + 2u;
    for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
        const uint32_t ratio = ds4_layer_compress_ratio(il);
        g->layer_comp_cap[il] = ratio == 0 ? 0 : ctx_size / ratio + 2u;
    }
    ...
```

After the size math, the function `ds4_gpu_tensor_alloc`s each tensor in order: working tensors first (`cur_hc`, `flat_hc`, `hc_mix`, …), then per-layer KV caches in a loop, then speculative scratch if `enable_mtp` is set, then MTP weights, then batched-prefill tensors. The Metal backend resolves each `ds4_gpu_tensor_alloc` to `[g_device newBufferWithLength:options:]` with `MTLResourceStorageModePrivate`, except for tensors that need host visibility (mask buffers in particular — see `ds4_gpu_scratch_needs_cpu_access` at `ds4_metal.m:311-315`).

On allocation failure (most commonly an out-of-memory `cudaMalloc` on CUDA-side managed KV cache), the function calls `metal_graph_free` and returns `false`. The engine's session-init path treats this as a fatal session error.

### 10.6.2 The `metal_graph_alloc_kv_cache_tensor` helper

The per-layer raw and compressed caches go through `metal_graph_alloc_kv_cache_tensor`, which checks `ds4_gpu_should_use_managed_kv_cache` to decide whether to use device-private memory or unified-managed memory. On Metal this almost always picks private memory; on CUDA it falls back to managed memory for very large contexts (chapter 11.5).

The decision is logged when managed memory kicks in (`ds4.c:8869-8884`):

```c
const bool managed_kv_cache =
    ds4_gpu_should_use_managed_kv_cache(kv_cache_bytes, context_bytes) != 0;
if (managed_kv_cache) {
    fprintf(stderr,
            "ds4: CUDA using managed KV cache for ctx=%u "
            "(kv cache %.2f GiB, context buffers %.2f GiB); "
            "this may degrade performance but is needed for very large contexts\n",
            ctx_size,
            (double)kv_cache_bytes / 1073741824.0,
            (double)context_bytes / 1073741824.0);
}
```

Note the message text says "CUDA" — the policy code is currently CUDA-driven. Metal sessions don't currently fall back to managed memory; `ds4_gpu_should_use_managed_kv_cache` returns 0 on the Metal backend. The Apple Silicon unified-memory model means the same RAM is GPU-visible regardless.

### 10.6.3 Free: `metal_graph_free`

`metal_graph_free` (`ds4.c:8387-8606`) is the cleanup: iterate every tensor field, call `ds4_gpu_tensor_free`, then `memset(g, 0, sizeof(*g))`. `ds4_gpu_tensor_free` is null-safe, so the cleanup pass can run on a partially-allocated graph (`ds4.c:9128`):

```c
if (!ok) metal_graph_free(g);
```

This is the safe-on-failure idiom: any allocation failure inside `metal_graph_alloc_raw_cap` causes the function to return false, and the caller cleans up.

## 10.7 Decode: single-token layer encoder

The decode path is the hotter loop — every generated token runs it. It is structured as **one command buffer per token, split into two by a flush after layer 4**.

### 10.7.1 The per-layer encoder

`metal_graph_encode_decode_layer` (`ds4.c:9461-10254`) is the per-layer body. It dispatches roughly 15 kernels in this order:

1. `rms_norm_plain` on `cur_hc` → `flat_hc` (`ds4.c:9503`)
2. `matmul_plain` of `hc_attn_fn` into `hc_mix` (the HC mixing projection)
3. `hc_split_weighted_sum` (fused) or `hc_split_sinkhorn` + `hc_weighted_sum` (reference) → `attn_cur`
4. `rms_norm_weight` with `attn_norm` weight
5. `matmul_q8_0` for the Q LoRA down projection → `qr`
6. `head_rms_norm` (or `rms_norm_plain` + `rope_tail`) for Q head normalization
7. `rope_tail` rotates the trailing `n_rot=64` dims of each Q head
8. `matmul_f16` for the KV projection → `kv_raw`
9. `dsv4_qkv_rms_norm_rows` (fused QKV norm) or split norms
10. `dsv4_fp8_kv_quantize` quantizes KV from F32 to FP8 E4M3/E2M1
11. `kv_fp8_store_raw` writes the row into the layer's raw SWA ring at `pos % raw_cap`
12. For compressed layers (ratio ≠ 0): `compressor_update` updates the per-layer compressor frontier
13. `attention_decode_mixed` (or indexed/`heads8_online` variant for ratio-4 layers) → `attn_low`
14. `attention_output_q8_batch` applies the output projection (Q8_0) → `attn_out`
15. `hc_expand_add_split` writes the attention contribution back to the four-way HC residual

That's the attention sublayer. The FFN sublayer that follows it dispatches 8 more kernels (norm, HC mix, split, router, shared expert gate+up, routed MoE, fused shared down + HC expand). Each call goes through `ds4_gpu_*_tensor` (e.g. `ds4_gpu_rms_norm_plain_tensor` at line 9503), which in `ds4_metal.m` resolves to `[encoder setComputePipelineState:...] / [encoder dispatchThreadgroups:...]` on the shared `g_batch_enc`.

The decode encoder has many `DS4_METAL_DECODE_STAGE_PROFILE` hooks (`ds4.c:9498-10249`) — when the env var is set, it inserts an `end_commands`/`begin_commands` boundary between stages so the per-kernel wall time becomes observable. The default (env unset) does no synchronization, leaving the whole layer as one shared-encoder dispatch.

### 10.7.2 The four-layer flush split

`metal_graph_encode_token_raw_swa` (`ds4.c:11111-11173`) is the loop driver. It first embeds the input token into `cur_hc`, then runs the per-layer encoder for all 43 layers, then runs the output head if logits are needed.

```c
// ds4.c:11142-11167 (abridged)
uint32_t split_after_layers = 4;
const char *split_env = getenv("DS4_METAL_GRAPH_TOKEN_SPLIT_LAYERS");
if (split_env && split_env[0]) {
    char *end = NULL;
    unsigned long v = strtoul(split_env, &end, 10);
    if (end != split_env && v <= DS4_N_LAYER) split_after_layers = (uint32_t)v;
}

for (uint32_t il = 0; ok && il < DS4_N_LAYER; il++) {
    ok = metal_graph_encode_decode_layer(g, model, &weights->layer[il],
                                         il, pos, g->layer_raw_cache[il],
                                         g->raw_cap, raw_row, n_raw, token);
    ds4_gpu_tensor *tmp = g->cur_hc;
    g->cur_hc = g->after_ffn_hc;
    g->after_ffn_hc = tmp;
    if (ok && allow_split_flush && split_after_layers != 0 && il + 1u == split_after_layers) {
        ok = ds4_gpu_flush_commands() != 0;
    }
}
```

Two behaviors worth noting:

1. **Pointer swap, not copy.** After each layer, the engine swaps `cur_hc` and `after_ffn_hc`. The four-way HC residual produced by the FFN becomes the input to the next layer's attention with zero memory traffic. This is one place where keeping tensors device-resident pays off — a copy would dominate per-layer cost.

2. **Flush at layer 4, not at the end.** After 4 layers' worth of kernels are encoded, the engine calls `ds4_gpu_flush_commands`. That commits the layer-0-through-3 command buffer to the GPU and opens a fresh one. The GPU starts executing layers 0-3 while the CPU encodes layers 4 through 42. By the time encoding finishes, layers 0-3 are usually already done; `end_commands` then waits on the smaller layer-4-through-42 buffer.

The comment at `ds4.c:11135-11141` explains why the split is empirical:

```c
/*
 * Start executing the prefix of the decode graph while the CPU is still
 * encoding the rest. The split point is layer-based because this executor is
 * a fixed DS4 tape, not a dynamic node graph; four layers is the measured
 * point where the prefix is large enough to hide useful work without
 * starving the second command buffer.
 */
```

If a future kernel rework moves the encode/execute ratio, `DS4_METAL_GRAPH_TOKEN_SPLIT_LAYERS` lets a user retune without recompiling.

### 10.7.3 The complete one-token decode

`metal_graph_eval_token_raw_swa` (`ds4.c:13127-13170`) wraps the encoder in `begin_commands`/`end_commands`:

```c
static bool metal_graph_eval_token_raw_swa(
        ds4_gpu_graph *g, ...,
        int token, uint32_t pos, float *logits) {
    bool ok = ds4_gpu_begin_commands() != 0;
    if (ok) ok = metal_graph_encode_token_raw_swa(g, model, weights, token, pos,
                                                   logits != NULL, true);
    if (ok) ok = ds4_gpu_end_commands() != 0;
    if (ok && logits)
        ok = ds4_gpu_tensor_read(g->logits, 0, logits,
                                 (uint64_t)DS4_N_VOCAB * sizeof(float)) != 0;
    return ok;
}
```

Only after `end_commands` returns is the `ds4_gpu_tensor_read` of `g->logits` safe (the GPU has finished writing). The read is a `memcpy` from a CPU-visible mapping of the device buffer on Apple Silicon, so it's effectively free.

### 10.7.4 The output head

`metal_graph_encode_output_head` (`ds4.c:10257-10325`) is shared between decode and prefill. It walks six stages:

1. `rms_norm_plain` on `cur_hc` → `flat_hc`
2. `matmul_f16` of `output_hc_fn` → `output_pre` (HC → HC dim collapse)
3. `output_hc_weights` computes the Sinkhorn-normalized HC mixing weights
4. `hc_weighted_sum` collapses the four HC channels into a single `N_EMBD` vector → `output_embd`
5. `rms_norm_weight` with `output_norm` → `output_norm` tensor
6. `matmul_q8_0` projects to vocab → `g->logits`

In decode, all six stages run on one token of data. In prefill (10.8) the same six stages run, but the engine first views `g->cur_hc` to point at the last row of `batch_cur_hc` so the head computes logits for the final token only (intermediate-row logits are computed in batch by `metal_graph_encode_output_head_batch`, used by the speculative verifier — chapter 12.7).

## 10.8 Prefill: layer-major batched encoder

Prefill processes a chunk of prompt tokens through every layer before moving to the next chunk. There are three layered functions: `metal_graph_encode_layer_batch` (per layer), `metal_graph_prefill_layer_major` (whole-prompt or chunked-ubatch), and `metal_graph_prefill_chunked_range` (the outer chunking loop). The Metal command-buffer split here is different from decode: long-prompt prefill submits *one command buffer per layer*, not per token.

### 10.8.1 Per-layer batch encoder

`metal_graph_encode_layer_batch` (`ds4.c:13109-13125`) is the per-layer body:

```c
static bool metal_graph_encode_layer_batch(
        ds4_gpu_graph *g, ..., uint32_t il, uint32_t pos0, uint32_t n_tokens) {
    bool ok = metal_graph_encode_layer_attention_batch(g, model, layer, il, pos0, n_tokens);
    if (ok) ok = metal_graph_encode_layer_ffn_batch(g, model, layer, il, pos0, n_tokens);
    if (ok) {
        ds4_gpu_tensor *tmp = g->batch_cur_hc;
        g->batch_cur_hc  = g->batch_next_hc;
        g->batch_next_hc = tmp;
    }
    return ok;
}
```

Two halves: attention (`metal_graph_encode_layer_attention_batch` at `ds4.c:11456-12834`) and FFN (`metal_graph_encode_layer_ffn_batch` at `ds4.c:12834-13107`). Both halves take `n_tokens` and operate on `batch_cur_hc` row-stride buffers rather than the single-row decode tensors. The same pointer-swap trick (`batch_cur_hc` ↔ `batch_next_hc`) carries the HC residual to the next layer.

The attention half uses the prefill Flash Attention variants in `flash_attn.metal` (the four template specializations: pad / blk / vec / vec_reduce) when the layer is uncompressed, and the indexed-mixed variants in `dsv4_misc.metal` when the layer is compressed. The FFN half uses the batched MoE kernels in `moe.metal` (which can process all `n_tokens` rows together with shared expert dispatch).

### 10.8.2 `metal_graph_prefill_layer_major`

`metal_graph_prefill_layer_major` (`ds4.c:13593-13898`) orchestrates one full prompt's worth of work, up to `prefill_cap` tokens. It branches on whether to use a single command buffer or one per layer:

```c
// ds4.c:13625-13628
const bool throttle = graph_power_throttle_enabled(g);
const bool callback_split = display_progress != NULL && n_tokens >= 32;
const bool split_commands = split_profile || throttle || callback_split ||
                            n_tokens > 2048 || imatrix != NULL;
```

`split_commands` becomes true when:

- The prompt is longer than 2048 tokens (`n_tokens > 2048`), or
- An imatrix is being collected (need stage-by-stage stats), or
- A power-throttle limit is in effect, or
- A frontend wants per-layer progress callbacks, or
- The split profile env var is set.

The 2048-token threshold is the macOS WindowServer watchdog timer: one command buffer that takes more than a few seconds to execute risks being killed as a hung GPU job. By committing each layer as its own command buffer, the GPU surfaces frequent enough to dodge the watchdog.

For short prompts (`!split_commands`) the path is one command buffer through all 43 layers (`ds4.c:13642-13683`):

```c
if (!split_commands) {
    ok = metal_graph_upload_prompt_embeddings_hc(g->batch_cur_hc, ...);
    if (ok) ok = ds4_gpu_begin_commands() != 0;
    for (uint32_t il = 0; ok && il < DS4_N_LAYER; il++) {
        ok = metal_graph_encode_layer_batch(g, model, &weights->layer[il],
                                            il, start, n_tokens);
        ...
    }
    ...
    if (ok && logits) {
        last_hc = metal_graph_tensor_row_view(g->batch_cur_hc, output_row, hc_dim);
        g->cur_hc = last_hc;
        ok = metal_graph_encode_output_head(g, model, weights, weights->output->dim[1]);
        g->cur_hc = saved_cur;
    }
    if (ok) ok = ds4_gpu_end_commands() != 0;
    ...
}
```

Notice the row-view trick at line 13673: `metal_graph_tensor_row_view` creates a view tensor whose `offset` is `output_row * hc_dim * sizeof(float)` and whose `bytes` is one row's worth. The view is then used as `g->cur_hc` for the output head call so the head computes logits only for the requested row (typically the last token). This avoids a custom batched output head for the short-prompt case — the same one-row head function is reused.

For long prompts (`split_commands`), each layer gets its own command buffer (`ds4.c:13784-13838`). Per-layer commit is the natural fit for callback-driven progress (one `display_progress` call per layer) and avoids the watchdog.

### 10.8.3 `metal_graph_prefill_chunked_range` and the chunk cap

`metal_graph_prefill_chunked_range` (`ds4.c:13915-13999`) splits the full prompt into multiple `prefill_cap`-sized chunks:

```c
static bool metal_graph_prefill_chunked_range(
        ds4_gpu_graph *g, ...,
        uint32_t start, uint32_t n_tokens, ...) {
    uint32_t chunk_cap = g->prefill_cap;
    if (start != 0 && chunk_cap > g->raw_cap) chunk_cap = g->raw_cap;

    for (uint32_t pos0 = start; pos0 < start + n_tokens; ) {
        const uint32_t chunk = ...;  // min(remaining, chunk_cap)
        bool ok = metal_graph_prefill_layer_major(g, ..., pos0, chunk, ...);
        if (!ok) return false;
        pos0 += chunk;
    }
    return true;
}
```

The chunk cap comes from `ds4_default_prefill_cap_for_prompt` (`ds4.c:6205-6224`):

```c
static uint32_t ds4_default_prefill_cap_for_prompt(int prompt_len) {
    if (prompt_len <= 0) return 1;
    uint32_t cap = (uint32_t)prompt_len;

    const char *env = getenv("DS4_METAL_PREFILL_CHUNK");
    if (env && env[0]) {
        char *endp = NULL;
        const long v = strtol(env, &endp, 10);
        if (endp != env) {
            if (v <= 0) return cap;
            cap = (uint32_t)v;
        }
    } else if (prompt_len > 4096) {
        cap = 4096u;
    }

    if (cap == 0) cap = 1;
    if (cap > (uint32_t)prompt_len) cap = (uint32_t)prompt_len;
    return cap;
}
```

Three rules:

1. **`DS4_METAL_PREFILL_CHUNK` overrides everything.** If set, it picks the chunk size directly.
2. **Default for ≤4096-token prompts is one chunk.** The whole prompt is one prefill ubatch.
3. **Default for >4096-token prompts is 4096-token chunks.** Long prompts are broken up.

The 4096 default is tuned against macOS watchdog behavior and the practical wall-clock cost of one Metal command buffer at that size. Note this default changed between commit c9dd949 (where it was 2048) and f91c12b (now 4096). The 4096 figure is the most recent measurement; users on slower devices may want to lower it.

### 10.8.4 The kernel warmup pass

Before the main prefill loop runs, `metal_graph_warmup_prefill_kernels` (`ds4.c:11348-11383`) issues a single F16 matmul on scratch storage:

```c
static bool metal_graph_warmup_prefill_kernels(
        ds4_gpu_graph   *g, ...,
        uint32_t           n_tokens) {
    static bool warmed = false;
    if (warmed || getenv("DS4_METAL_NO_PREFILL_KERNEL_WARMUP") != NULL) return true;
    if (n_tokens <= 8) return true;

    /* The first batched F16 matmul can pay Metal's one-time pipeline execution
     * cost. Run the same HC attention projection on scratch storage before the
     * measured prefill. The output is overwritten by the real graph. */

    bool ok = ds4_gpu_begin_commands() != 0;
    if (ok) {
        ok = ds4_gpu_matmul_f16_tensor(g->batch_hc_mix, model->map, model->size,
                                         weights->layer[0].hc_attn_fn->abs_offset,
                                         hc_dim, mix_hc, g->batch_flat_hc, n_tokens) != 0;
    }
    if (ok) ok = ds4_gpu_end_commands() != 0;
    ...
}
```

The warmup runs once per process (the static `warmed` flag) and adds the cost of one matmul to the first prefill. Without it, the *measured* first prefill includes Metal's one-time pipeline JIT cost — visible to benchmarks as a multi-hundred-ms spike on the first prompt. The warmup hides it in cold-startup time.

`DS4_METAL_NO_PREFILL_KERNEL_WARMUP` disables this for users measuring true cold-start cost.

### 10.8.5 The layer-major argument

Layer-major prefill (process all tokens through layer 0, then all tokens through layer 1, …) has two advantages over token-major:

1. **Memory.** Token-major would need either (a) `n_tokens × n_layers` activation memory to keep every intermediate row, or (b) one full forward pass per token. Layer-major reuses one set of `n_tokens`-row buffers across layers.
2. **Cache locality.** Within one layer, the same weight slices are touched once per token row, contiguously. Token-major would re-stream the layer weights for every token.

The cost is that the KV cache must be updated *in place* by each layer's prefill kernel rather than at the end. The compressor frontier maintenance is consequently the trickiest piece: each layer's per-token-row contribution to its compressed cache must be applied before the next layer starts. The kernels in `dsv4_kv.metal` and the indexer kernels in `dsv4_misc.metal` are specifically designed to take a row-stride and a `(pos0, n_tokens)` pair so they can do this batched update.

## 10.9 Metal vs. CUDA: how the binding patterns differ

The engine code looks identical on both backends, but the *binding* pattern — how kernel arguments reach the GPU — is materially different.

### 10.9.1 Metal: argument buffers

In Metal, every kernel call uses `[encoder setBuffer:offset:atIndex:]` for each input tensor, and `[encoder setBytes:length:atIndex:]` for inline scalars. For DS4 the buffer-binding pattern is consistent: index 0 is the output, indices 1..N are inputs, index N+1 onward are scalars. The whole binding is per-dispatch, but because all primitives share the encoder, the binding overhead is amortized.

A typical primitive call in `ds4_metal.m` (e.g. `ds4_gpu_matmul_f16_tensor`) does:

1. Look up the cached `MTLComputePipelineState` for `"matmul_f16"`.
2. `[encoder setComputePipelineState:pipeline]`.
3. Bind output, weights buffer (the mmap'd model view), input tensor, and any scalars.
4. `[encoder dispatchThreadgroups:gridSize threadsPerThreadgroup:tgSize]`.

Threadgroup memory sizing is mostly fixed per kernel; a few kernels (Flash Attention block, MoE sum-6) compute their threadgroup memory at dispatch time based on the head dimension or expert count and call `[encoder setThreadgroupMemoryLength:atIndex:]` before dispatching.

### 10.9.2 CUDA: stream launches and cooperative groups

On CUDA every kernel call is `kernel<<<grid, block, smem, stream>>>(args...)`. There's no explicit "encoder" — the stream is the queue. Kernels are launched directly into the default stream by `ds4_cuda.cu`. The arguments are passed by value to the kernel function, which is C++ rather than Objective-C.

This means:

- **No per-call binding cost.** A kernel launch is one syscall in the worst case.
- **No shared encoder.** Every kernel is its own launch; the CUDA runtime queues them on the stream automatically.
- **No JIT compile.** Kernels are compiled to PTX by `nvcc` at *build* time, not load time. The trade-off is build-time complexity (the Makefile must invoke `nvcc`) for a faster cold start.

The detailed CUDA analog is in chapter 11.

### 10.9.3 Threadgroup memory vs. shared memory

Both Metal and CUDA expose on-chip scratch ("threadgroup memory" on Metal, "shared memory" on CUDA). DS4 uses it heavily for:

- Online-softmax accumulators in Flash Attention.
- Compressed-row pools in the attention decode mixed kernel (the `DS4_CUDA_ATTENTION_SCORE_CAP = 8192` constant in `ds4_cuda.cu:33` corresponds to the threadgroup buffer in `metal/dsv4_misc.metal:577`'s indexed-mixed attention).
- Indexer top-k merge structures in `argsort.metal` and `metal/dsv4_misc.metal:1245`.

The sizing is conservative — small enough to fit M1/M2/M3 Pro and Max chips that have 32 KB threadgroup memory per SM. M5 GPUs have more, and one M5-only optimization (`ds4_gpu_use_m5_private_scratch` at `ds4_metal.m:301-309`) takes advantage of it.

## 10.10 Debug environment variables

The Metal path is instrumented with optional profiling and disable flags. The most useful ones for understanding behavior:

| Variable | What it does |
|----------|--------------|
| `DS4_METAL_PREFILL_CHUNK=N` | Override prefill ubatch size (default: prompt size or 4096) (`ds4.c:6209`) |
| `DS4_METAL_GRAPH_TOKEN_SPLIT_LAYERS=N` | Override the four-layer flush split for decode (`ds4.c:11143`) |
| `DS4_METAL_GRAPH_TOKEN_PROFILE` | Print encode/execute/read timing for each decode step |
| `DS4_METAL_GRAPH_PREFILL_PROFILE` | Same for prefill |
| `DS4_METAL_DECODE_STAGE_PROFILE` | Per-stage timing inside `metal_graph_encode_decode_layer` (`ds4.c:9496`) |
| `DS4_METAL_LAYER_STAGE_PROFILE` | Per-stage timing inside the prefill attention/FFN encoders (`ds4.c:11477`) |
| `DS4_METAL_INDEXER_STAGE_PROFILE` | Per-stage timing inside the indexer path |
| `DS4_METAL_GRAPH_PREFILL_SPLIT_PROFILE` | Force layer-major prefill split + per-layer timing (`ds4.c:13617`) |
| `DS4_METAL_GRAPH_OUTPUT_ROW=N` | Force the output head to pick row N rather than the last row (debug) (`ds4.c:13662`) |
| `DS4_METAL_GRAPH_DUMP_PREFIX`, `_NAME`, `_LAYER`, `_POS` | Dump named tensor contents to files at specific layer/position (`ds4.c:8670-8694`) |
| `DS4_METAL_GRAPH_TRACE_LAYERS` | Per-layer execution trace (`ds4.c:10983`) |
| `DS4_METAL_DISABLE_HC_FUSION` | Disable HC split+weighted_sum fusion; use the reference two-step path (`ds4.c:9254`) |
| `DS4_METAL_DISABLE_KV_FUSION` | Disable KV FP8 store fusion (`ds4.c:9259`) |
| `DS4_METAL_DISABLE_QKV_NORM_FUSION` | Disable the fused QKV RMS norm (`ds4.c:9264`) |
| `DS4_METAL_DISABLE_HC_NORM_FUSION` | Disable the HC split+weighted_sum_norm fusion (`ds4.c:9274`) |
| `DS4_METAL_DISABLE_SHARED_DOWN_HC_FUSION` | Disable the shared expert down + HC expand fusion (`ds4.c:9279`) |
| `DS4_METAL_DISABLE_ATTN_OUT_HC_FUSION` | Disable the attention output + HC expand fusion (`ds4.c:9284`) |
| `DS4_METAL_DISABLE_COMPRESSOR_PAIR_PROJ` | Disable paired compressor projections (`ds4.c:9269`) |
| `DS4_METAL_DISABLE_SHARED_GATE_UP_SWIGLU_FUSION` | Disable the shared expert SwiGLU fusion (`ds4.c:10168`) |
| `DS4_METAL_NO_PREFILL_KERNEL_WARMUP` | Disable the prefill warmup matmul (`ds4.c:11354`) |
| `DS4_METAL_DECODE_INDEXER_SPARSE_THRESHOLD=N` | Threshold to switch between dense and indexed-sparse decode attention (`ds4.c:9206`) |

The disable-fusion flags are particularly useful for numerical validation: each fused kernel was added as an optimization, and disabling lets a developer compare the fused output against the reference. The CI doesn't enable them all by default, but they exist for narrow regression hunts.

The decode and prefill stage profilers (`DS4_METAL_DECODE_STAGE_PROFILE`, `DS4_METAL_LAYER_STAGE_PROFILE`) are how the four-layer flush split (10.7.2) and the chunked-prefill threshold were chosen.

## 10.11 What we left for later

This chapter covered the structural shape of the Metal backend. Three deeper topics belong to their own chapters:

- **Compressed-attention internals** — the ratio-4 indexer scoring, top-k selection, indexed mixed attention, and compressor frontier maintenance live across `dsv4_misc.metal`, `dsv4_kv.metal`, and `dsv4_hc.metal`. Those kernels implement the DeepSeek V4 sparse-attention algorithm, which has its own conceptual model worth a chapter.
- **MoE routing and the IQ2_XXS quantization** — `moe.metal` and the codebooks in `dsv4_misc.metal` are dense math, with several optimization passes (sum-6 fusion, the warp-shuffle MoE down kernel) that warrant their own walkthrough.
- **The speculative-decoding state machine** — `spec_attn_state_kv`, `spec_prefix1_*`, `metal_graph_capture_prefix1_attn_state`, `metal_graph_verify_decode2_exact`, `metal_graph_verify_suffix_tops` — covered in chapter 12.

The throughline of this chapter is: **the Metal backend is a thin Objective-C dispatcher that turns the engine's tensor calculator language into shared-encoder command-buffer batches.** That separation lets the engine code be backend-agnostic, lets the kernel files be pure shader math, and leaves `ds4_metal.m` to own only what's actually Metal-specific.

## Related chapters

- Chapter 11: CUDA Backend (DGX Spark) — the CUDA implementation of the same `ds4_gpu.h` contract.
- Chapter 12: Speculative Decoding and MTP — uses `metal_graph_eval_token_raw_swa`, `metal_graph_verify_suffix_tops`, and `metal_graph_verify_decode2_exact`.
