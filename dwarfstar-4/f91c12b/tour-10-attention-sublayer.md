# Tour Step 10: Inside one layer's attention sublayer

> Code version locked to `ds4@f91c12b` (2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

Step 09 walked the outer prefill loop. Now we zoom in to **what happens inside one layer, for one ubatch** — specifically the attention half (the MoE FFN half is the next step). For our `"hello"` trace, this code runs 43 times in sequence; we describe one pass, say layer `il = 2` (the first ratio-4 compressed layer, so we hit the interesting branch).

At entry to the attention sublayer of layer `il`:

- `g->batch_cur_hc` holds `[n_tok, 4, 4096]` — four HC streams per prompt token, output from the previous layer's FFN (or the embedding seed if `il == 0`).
- `cache->layer[il].raw_kv` is empty for this layer (we are filling it).
- `cache->layer[il].attn_comp_kv` is empty (compressed-cache rows are pushed as tokens flow through).

The attention sublayer must: project HC streams into a single content vector per token, compute Q and KV from that vector, apply position encoding, attend over the **current ubatch's KV plus the compressed cache from past prompt prefix** (empty for `pos0 = 0`), and inject the result back into the HC streams via `hc_post`.

This step deliberately stays out of the **compressed-cache writer path** (the `attn_compressor_*` weights, the indexer, the ratio-4 promotion) — that machinery is the subject of step 12. We only note here that the compressor consumes the same `attn_norm` we compute.

## 2. The problem

> Each layer must produce per-token Q vectors wide enough to give the model 64 attention heads of capacity, must compute K and V for the same token, must encode position, and must combine all of that with the previous tokens' KV — all without exhausting GPU memory either at compute time (Q projection weights per layer) or at cache time (KV cache per token across millions of positions and dozens of layers).

The numbers force the issue:

- Per-head dimension is `DS4_N_HEAD_DIM = 512` (`ds4.c:93`), and per-layer head count is `DS4_N_HEAD = 64` (`ds4.c:91`). A full-rank Q projection from `DS4_N_EMBD = 4096` to `DS4_N_HEAD × DS4_N_HEAD_DIM = 32768` would be `4096 × 32768 ≈ 134M` parameters per layer.
- DS4's target is million-token context. At one K plus one V per token per layer at width 512 in F32, that is `1M × 43 × 512 × 2 × 4 ≈ 172 GiB` just for KV cache.
- Naive O(N²) attention over 1M positions is 1 trillion dot products per layer per token.

Each of these is a build-or-don't-build constraint; this step shows the three design moves that resolve them simultaneously.

## 3. Naive approach

Standard multi-head attention from the textbook:

1. Linear projection `4096 → 32768` for Q (all 64 heads in one matmul).
2. Linear projections `4096 → 512` for K and `4096 → 512` for V.
3. Apply RoPE to **all** 512 dims of each head.
4. Push K and V into a per-layer cache.
5. Compute `softmax(QK^T / sqrt(d)) V` over **every** cached position.
6. Project the head outputs back through `32768 → 4096`.

This is what Llama-style architectures do. It is the obvious starting point.

## 4. Why the naive approach breaks

**The Q projection alone would dominate the weight budget.** `134M × 43 layers × 1 byte (Q8_0) ≈ 5.8 GB` just for Q projections. The full set of weights would already exceed the 16-32 GB Mac unified-memory budget DS4 is built for, before MoE FFN weights are even counted.

**KV cache blows the memory bound by 100×.** 172 GiB has no path to fitting on a personal device. Even at 64k context the per-layer KV is `64k × 43 × 512 × 2 × 4 = 11 GB`, still a non-starter on consumer hardware.

**RoPE on all 512 dims hurts long-context generalization.** Standard RoPE rotates every dimension by a position-dependent angle; with enough rotation across enough dimensions, content and position information get entangled and the model struggles to extrapolate beyond training-time positions.

**Softmax over millions of past positions floods the attention with noise.** Even if the cache fit, every distant unrelated token contributes a non-zero softmax weight, drowning the signal from the few tokens that actually matter.

**Causal masking does not save you on prefill.** It zeroes upper-triangular weights but does not reduce the matmul cost: you still compute all `N × N` scores and only then mask the futures.

All four problems share one root: **DS4's "head dim = 512, head count = 64" choice makes head_dim too wide for textbook attention**. The fix needs to compress the projection and the cache simultaneously.

## 5. ds4's approach

ds4's approach is to **collapse the projection to a low-rank bottleneck (Q-A then RMSNorm then Q-B), keep only one shared KV head (GQA-1) at full width, rotate only the tail 64 dimensions with RoPE, and combine raw 128-row SWA cache with a much smaller compressed cache plus a learned sink logit**. Each move is independent but they compose.

### A. Low-rank Q projection (4096 → 1024 → 32768)

`layer_q_projection_normed_one` at `ds4.c:4689-4705` is the CPU canonical form (the batched Metal kernel is structurally identical):

```c
matvec_q8_0(qr,        model, layer->attn_q_a,      norm);        // 4096 → 1024
rms_norm_weight(qr_norm, qr, q_a_norm, 1024, DS4_RMS_EPS);         // learned norm
matvec_q8_0(q,         model, layer->attn_q_b,      qr_norm);    // 1024 → 64*512
head_rms_norm_inplace(q, DS4_N_HEAD, DS4_N_HEAD_DIM, DS4_RMS_EPS);// per-head norm
```

The bottleneck width `DS4_N_LORA_Q = 1024` (`ds4.c:97`) is the rank of the projection. Parameter count drops to `4096 × 1024 + 1024 × 32768 = 4.2M + 33.6M ≈ 38M` per layer, **3.5× smaller** than the full-rank 134M. The `attn_q_a_norm` RMSNorm between the two matmuls is **learned** (`DS4_TENSOR_F32, dim=1024`, see the layout check at `ds4.c:2400`); it stabilises the 1024-dim bottleneck so gradients flow cleanly even though the bandwidth between the two projections is throttled.

The batched prefill version is in `layer_attention_raw_swa_batch` at `ds4.c:7261-7278`, using `matmul_q8_0_batch` so the same weights are read once per layer regardless of how many tokens are in the ubatch.

### B. Single-head KV at full width (GQA-1)

`layer_kv_projection_normed_one` at `ds4.c:4726-4738`:

```c
matvec_q8_0(raw,  model, layer->attn_kv, normed);                  // 4096 → 512
rms_norm_weight(kv, raw, kv_norm, DS4_N_HEAD_DIM, DS4_RMS_EPS);    // learned norm
```

Only **one** KV "head" of width 512 is produced (`DS4_N_HEAD_KV = 1`; the `attn_kv` weight layout check at `ds4.c:2402` is `[DS4_N_EMBD, DS4_N_HEAD_DIM]` — no head multiplier). All 64 Q heads attend over the same K and V. This is Grouped-Query Attention at the extreme of group size = 64 (a.k.a. GQA-1).

Per-token per-layer KV footprint drops from `64 × 512 × 2 × 4 = 256 KiB` (full multi-head) to `512 × 4 = 2 KiB` — a **128× reduction**. Combined with the compressed-cache path (step 12) and the 128-row raw window (`DS4_N_SWA`, `ds4.c:104`), this is what makes million-token contexts plausible on a Mac.

### C. Tail-only RoPE on 64 of 512 dims

`rope_tail_layer_inplace` at `ds4.c:4851-4884` (calling `rope_tail_ext_inplace` at `ds4.c:4787`) rotates **only** the last `DS4_N_ROT = 64` dims (`ds4.c:95`) of each head:

```c
const bool compressed = ds4_layer_compress_ratio(il) != 0;
const float freq_base = layer_rope_freq_base(il);
const float freq_scale = layer_rope_freq_scale(il);
...
rope_tail_ext_inplace(x, n_head, head_dim, n_rot, pos,
                      compressed ? DS4_ROPE_ORIG_CTX : 0,
                      freq_base, freq_scale, ext_factor, attn_factor, ...);
```

Two important branches inside `freq_base` / `freq_scale`:

- **Dense layers** (`il < 2`, compress ratio 0) use `DS4_ROPE_FREQ_BASE = 10000.0f` (`ds4.c:57`).
- **Compressed layers** (`ratio != 0`) use `DS4_COMPRESS_ROPE_FREQ_BASE = 160000.0f` (`ds4.c:61`) plus YaRN frequency interpolation (`ds4.c:4862-4870`). Higher base spreads rotation angles wider, so very distant positions stay distinguishable; YaRN interpolation handles extrapolation beyond the trained context.

The first 448 dims of each head are "nope" (no positional encoding) — they carry **content** unmolested by position. Only the last 64 dims encode where the token sits. This split between content and position dimensions is a key DS4 design choice that lets attention extrapolate cleanly.

After attention runs over RoPE'd Q and K, the output heads are rotated **back** with `inverse = true` (`ds4.c:7382-7387` for the batched path's per-token inverse-rope step) so the output projection sees content-aligned vectors.

### D. Sink-aware softmax with raw + compressed KV

`layer_attention_rows_one` at `ds4.c:4990-5028` is the prefill-flavored softmax core. The crucial line:

```c
float denom = expf(sinks[h] - max_score);
for (uint32_t r = 0; r < n_kv; r++) {
    const float weight = expf(score[r] - max_score);
    denom += weight;
    axpy_f32(oh, kv, weight, DS4_N_HEAD_DIM);
}
const float inv = 1.0f / denom;
```

The **sink logit** `sinks[h]` (per-head learned scalar, weight `layer->attn_sinks` of dim `DS4_N_HEAD = 64`, `ds4.c:2404`) enters the softmax denominator but never contributes a value vector. The model learns "how much attention should I refuse to spend on real positions", letting heads ignore everything in the cache when the right semantics is "no past token is relevant". This avoids the forced-allocation problem where a row that has nowhere good to look would otherwise spread weight uniformly.

For compressed layers (`ratio != 0`), `layer_attention_mixed_one` at `ds4.c:6721` replaces `layer_attention_rows_one`. It attends over **both** the raw 128-row SWA window **and** the compressed cache rows, with an optional `comp_allowed` mask from the ratio-4 indexer (`ds4.c:7163-7177`). For the prefill of a fresh prompt, both caches start at zero rows and grow as tokens are processed; for an in-flight session continuing from a checkpoint, the caches arrive pre-populated.

### Putting the pipeline together (batched form)

`layer_attention_raw_swa_batch` at `ds4.c:7202-7484` (CPU reference) is the canonical sequence for one layer's attention over `n_tok` rows:

1. **HC pre-norm**: `hc_pre_norm_batch` (`ds4.c:7245-7259`) reduces 4 HC streams to one `attn_norm` per token plus a `post`/`comb` matrix for the residual injection on the way out.
2. **Q matmul + norm**: `matmul_q8_0_batch` for `attn_q_a` → 1024, per-token `rms_norm_weight`, `matmul_q8_0_batch` for `attn_q_b` → 32768, per-head RMSNorm.
3. **KV matmul + norm**: `matmul_q8_0_batch` for `attn_kv` → 512, per-token `rms_norm_weight`.
4. **Per-token loop** (`ds4.c:7350-7415`):
   - `rope_tail_layer_inplace(q_t)` and `rope_tail_layer_inplace(kv_t)`.
   - `dsv4_fp8_kv_quantize_row_inplace_cpu` (`ds4.c:7365`) — KV is stored as DSv4 FP8 in cache to halve its footprint.
   - `kv_cache_push_raw` writes one row into `raw_kv`.
   - For compressed layers: `compressor_decode_one` updates the accumulator state and, when a window closes, pushes a row to `attn_comp_kv` (subject of step 12).
   - For ratio-4 layers: `indexer_allowed_decode_one` produces `comp_allowed`.
   - `layer_attention_mixed_one` (compressed) or `layer_attention_rows_one` (dense) runs the sink-aware softmax over the available KV.
   - `rope_tail_layer_inplace(heads, inverse=true)` rotates output heads back.
5. **Grouped output projection**: `layer_grouped_out_one` (`ds4.c:5041`) collapses 64 heads → 8 groups of 8 heads → low-rank 1024 → 4096 via `attn_output_a` and a second matmul. This mirrors the Q projection's "compress then expand" structure for output too.
6. **HC post**: `hc_post_one` (`ds4.c:4458`) mixes the 4096-wide attention output back into the 4 HC streams via the learned `post` and `comb` matrices derived in step 1.

On Metal, `metal_graph_encode_layer_attention_batch` (`ds4.c:11456-12830`) is the same algorithm staged across the kernels in `metal/dense.metal`, `metal/dsv4_rope.metal`, `metal/flash_attn.metal`, and `metal/dsv4_kv.metal`, with the same head/group/rank constants. The `ds4_gpu_attention_prefill_static_mixed_heads_tensor` entry in `ds4_gpu.h:511-525` is the dense-cache + compressed-cache attention kernel for prefill.

## 6. Code locations

- `ds4.c:4689-4705` — `layer_q_projection_normed_one`: 4096→1024→32768 low-rank Q with learned bottleneck RMSNorm.
- `ds4.c:4726-4738` — `layer_kv_projection_normed_one`: single-head 4096→512 KV with learned norm.
- `ds4.c:4787-4849` — `rope_tail_ext_inplace`: tail-only RoPE with YaRN ext-factor and inverse mode.
- `ds4.c:4851-4884` — `rope_tail_layer_inplace`: per-layer wrapper that picks dense vs compressed-layer base/scale.
- `ds4.c:4990-5028` — `layer_attention_rows_one`: sink-aware softmax over a single KV-row set.
- `ds4.c:5041-5066` — `layer_grouped_out_one`: grouped output projection 64-heads → 8 groups → 1024 → 4096.
- `ds4.c:4458-4480` — `hc_post_one`: mixes attention output back into 4 HC streams via learned `post` and `comb`.
- `ds4.c:6721-6781` — `layer_attention_mixed_one`: combined raw + compressed-cache softmax with optional ratio-4 mask.
- `ds4.c:7202-7484` — `layer_attention_raw_swa_batch`: CPU reference for the full batched prefill attention sublayer.
- `ds4.c:11456-12830` — `metal_graph_encode_layer_attention_batch`: GPU entry, same pipeline using Metal kernels.
- `ds4_gpu.h:511-525` — `ds4_gpu_attention_prefill_static_mixed_heads_tensor`: combined raw + compressed-cache attention kernel.
- `metal/flash_attn.metal` — sink-aware flash attention kernels used by the prefill path.
- `ds4.c:88-114` — model constants (`DS4_N_EMBD`, `DS4_N_HEAD`, `DS4_N_HEAD_DIM`, `DS4_N_LORA_Q`, `DS4_N_ROT`, `DS4_N_SWA`).

## 7. Branches and extensions

- For the **compressed-cache writer side** — `attn_compressor_kv/gate/ape/norm`, the ratio-4 indexer compressor, when a window closes and a row is pushed to `attn_comp_kv` — see [Tour Step 12](./tour-12-ratio4-compressor.md) and [Chapter 07 KV Cache](./07-kv-cache.md).
- For the **HC architecture** — what the 4 streams encode, how `hc_attn_fn` / `hc_ffn_fn` mix them at each sublayer, and the Sinkhorn allocation inside `hc_pre_norm_batch` — see [Chapter 09 Hyperconnections and MoE](./09-moe-hyperconnections.md).
- For the **complete attention parameter table** — sink logits per head, RoPE base/scale per layer class, group/rank counts, FP8 KV quantization details — see [Chapter 08 Attention](./08-attention.md).
- For **decode-time attention** (single-token, `layer_attention_raw_swa_one` and `_decode_scratch` variants), how the same primitives are reused with a `ds4_cpu_decode_scratch` to avoid hot-loop malloc, see [Chapter 07 KV Cache §decode scratch](./07-kv-cache.md).
- For the **Metal kernels** that implement these primitives on GPU — `dense.metal` matmul kernels, `flash_attn.metal` sink-aware attention, `dsv4_kv.metal` FP8 KV quantization — see [Chapter 10 Metal Backend](./10-metal-backend.md).

## 8. What you should now have in your head

- **Q low-rank projection** `4096 → 1024 → 32768` with a **learned** RMSNorm between the two matmuls — same expressivity at 3.5× fewer parameters, the core of "Multi-head Latent Attention" Q path.
- **GQA-1** — one KV head of width 512 shared by all 64 Q heads — drops per-token per-layer KV memory by **128×**, making million-token contexts feasible on consumer hardware.
- **Tail-only RoPE** rotates only the last 64 of 512 dims per head; the first 448 dims are "nope" content. Dense layers use base 10000, compressed layers use base 160000 plus YaRN — content and position live in different sub-spaces of each head.
- **A per-head learned sink logit** enters the softmax denominator without contributing a value — this gives the model a way to "spend no attention on anything" when no past token matters, instead of forcing weight onto irrelevant positions.
- After this step, the attention sublayer has produced one 4096-wide `attn_out` per token, written it back into the HC streams via `hc_post_one`, and updated `raw_kv` (and compressed caches on compressed layers). The next sublayer in this same layer — the MoE FFN — reads from `batch_next_hc`. Step 11 covers that path.
