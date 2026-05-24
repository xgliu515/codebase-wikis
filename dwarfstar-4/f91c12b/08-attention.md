# Chapter 08: Attention Sublayer and RoPE

> Code version locked to `dwarfstar/ds4@f91c12b` (DwarfStar 4 inference engine for DeepSeek V4 Flash). All `file:line` refs are repo-root-relative paths at this commit.

## 0. The problem this chapter solves

Chapter 07 explained where the KV cache rows come from and how they are stored. This chapter takes the other side of the contract: given a token's hidden state and a populated dual cache, how does the attention sublayer compute its output?

DS4's attention has six distinguishing features versus a textbook transformer:

1. **Extreme grouped-query attention**: `DS4_N_HEAD = 64` Q heads but only `DS4_N_HEAD_KV = 1` KV head (`ds4.c:91-92`). All 64 query heads dot-product against the same 512-dim KV vector.
2. **Low-rank Q projection**: a two-stage 4096 → 1024 → 32768 Q projection with a learned RMSNorm between the stages, instead of a single 4096 → 32768 matrix (`ds4.c:4689-4723`).
3. **Tail-only RoPE**: only the last 64 of 512 head dims are rotated (`ds4.c:4787-4835`). The 448-dim "nope" head is FP8-quantized for cache storage; the 64-dim "rope" tail carries all position information.
4. **Layer-dependent RoPE base**: compressed layers (ratio 4 or 128) use a 16× larger frequency base and a 1/16 frequency scale via YaRN extrapolation (`ds4.c:4838-4882`); dense layers (0, 1) use the standard 10000 base.
5. **Sink-aware softmax**: each head has a learned `sink` logit that participates in the softmax denominator but contributes no value (`ds4.c:4990-5028`, `ds4.c:6731-6781`).
6. **Mixed raw + compressed attention**: a single softmax over the concatenation of `raw_kv[0..n_raw)` and the indexer-masked `attn_comp_kv[0..n_comp)` (`ds4.c:6721-6781`).
7. **Grouped low-rank output**: 8 parallel low-rank head-groups, each 4096 → 1024, then a single 8×1024 → 4096 projection (`ds4.c:5041-5057`).

Each of these has a *why*. This chapter walks them in the order one decode token's attention sublayer flows through them — HC pre, RMSNorm, Q/KV projection, RoPE, cache write, attention, inverse RoPE, grouped output, HC post — with cross-references to Chapter 07 (cache writes) and Chapter 09 (HC pre/post).

<svg viewBox="0 0 760 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Attention sublayer call sequence overview"><defs><marker id="r81arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">layer_attention_raw_swa_one (ds4.c:7090-7198) flow</text><rect x="260" y="38" width="240" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="380" y="58" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">inp_hc (4 streams × 4096)</text><line x1="380" y1="70" x2="380" y2="88" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81arrow)"/><rect x="220" y="88" width="320" height="32" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/><text x="380" y="108" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">hc_pre_from_state_one → attn_cur (4096), post, comb</text><line x1="380" y1="120" x2="380" y2="138" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81arrow)"/><rect x="220" y="138" width="320" height="32" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="380" y="158" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">layer_attn_norm_one → attn_norm (4096)</text><line x1="380" y1="170" x2="380" y2="188" stroke="#94a3b8" stroke-width="1.2"/><line x1="200" y1="188" x2="560" y2="188" stroke="#94a3b8" stroke-width="1.2"/><line x1="200" y1="188" x2="200" y2="208" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81arrow)"/><line x1="560" y1="188" x2="560" y2="208" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81arrow)"/><rect x="80" y="208" width="240" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="200" y="226" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">layer_q_projection_with_lora_one</text><text x="200" y="240" text-anchor="middle" font-size="10" fill="#7c2d12">Q8_0 4096→1024 · RMSNorm · Q8_0 1024→32768 · per-head norm</text><rect x="440" y="208" width="240" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="560" y="226" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">layer_kv_projection_normed_one</text><text x="560" y="240" text-anchor="middle" font-size="10" fill="#7c2d12">Q8_0 4096→512 · learned RMSNorm</text><line x1="200" y1="252" x2="200" y2="270" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81arrow)"/><line x1="560" y1="252" x2="560" y2="270" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81arrow)"/><rect x="80" y="270" width="240" height="32" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/><text x="200" y="290" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">RoPE q (tail 64 / 512 dims)</text><rect x="440" y="270" width="240" height="32" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/><text x="560" y="290" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">RoPE kv · FP8 nope · push to cache</text><line x1="200" y1="302" x2="380" y2="328" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81arrow)"/><line x1="560" y1="302" x2="380" y2="328" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81arrow)"/><rect x="200" y="328" width="360" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="380" y="346" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">layer_attention_mixed_one OR layer_attention_rows_one</text><text x="380" y="360" text-anchor="middle" font-size="10" fill="#064e3b">sink-aware softmax · raw_kv ++ comp_kv (masked for ratio-4)</text><line x1="380" y1="372" x2="380" y2="390" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81arrow)"/><rect x="220" y="390" width="320" height="32" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/><text x="380" y="410" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">inverse RoPE on heads (sin_sign = -1)</text><line x1="380" y1="422" x2="380" y2="440" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81arrow)"/><rect x="220" y="440" width="320" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="380" y="460" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">layer_grouped_out_one (8 groups × 4096→1024 → 4096)</text><line x1="380" y1="472" x2="380" y2="490" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81arrow)"/><rect x="220" y="490" width="320" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="380" y="510" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">hc_post_one → after_attn_hc (4 streams)</text></svg>
<span class="figure-caption">Figure R8.1 | Attention sublayer call sequence. HC pre collapses 4 residual streams into one 4096-wide vector; the attention math runs; HC post fans the result back out to 4 streams (see Chapter 09).</span>

## 1. Low-rank Q projection: why two stages

A standard Q projection at this scale would be `[4096, 64*512] = [4096, 32768]` parameters per layer. That is 134M parameters, just for Q, just for one layer, before quantization. Multiplied by 43 layers it adds up to over 5.7B parameters — bigger than many models in total.

DS4 cuts this with a low-rank decomposition. The Q projection is split into two stages with an RMSNorm between them:

```c
// ds4.c:4689-4706
static void layer_q_projection_normed_one(
        const ds4_model   * model,
        const ds4_layer_weights * layer,
        const float       * norm,
        float             * q) {
    float *qr = xmalloc(1024 * sizeof(qr[0]));
    float *qr_norm = xmalloc(1024 * sizeof(qr_norm[0]));

    const float *q_a_norm = tensor_data(model, layer->attn_q_a_norm);

    matvec_q8_0(qr, model, layer->attn_q_a, norm);
    rms_norm_weight(qr_norm, qr, q_a_norm, 1024, DS4_RMS_EPS);
    matvec_q8_0(q, model, layer->attn_q_b, qr_norm);
    head_rms_norm_inplace(q, DS4_N_HEAD, DS4_N_HEAD_DIM, DS4_RMS_EPS);

    free(qr_norm);
    free(qr);
}
```

The shapes are checked at boot in `weights_validate_layout` (`ds4.c:2399-2401`):

- `attn_q_a`: Q8_0, `[4096, 1024]` — compresses the hidden state to a low-rank intermediate.
- `attn_q_a_norm`: F32, `[1024]` — per-channel learned RMSNorm scale.
- `attn_q_b`: Q8_0, `[1024, 32768]` — expands back to 64 heads × 512.

The parameter count drops from 4096 × 32768 = 134M to (4096 × 1024) + 1024 + (1024 × 32768) = 4M + 1024 + 33.5M ≈ 37.5M per layer. The Q projection is now ~28% of its original size.

The RMSNorm in the middle (`attn_q_a_norm`) is critical for training stability. Without it the gradient through `attn_q_b` would have to handle activations of arbitrary scale; the learned per-channel norm scale removes that burden by clamping the low-rank intermediate to a consistent distribution.

The second key call here is `head_rms_norm_inplace` at line 4702. After the second projection produces the 64 × 512 head matrix, each head is independently RMS-normalized (no learned scale this time):

```c
// ds4.c:2811-2820
static void head_rms_norm_inplace(float *x, uint32_t n_head, uint32_t head_dim, float eps) {
    for (uint32_t h = 0; h < n_head; h++) {
        float *head = x + (uint64_t)h * head_dim;
        double ss = 0.0;
        for (uint32_t i = 0; i < head_dim; i++) ss += (double)head[i] * head[i];

        const float scale = 1.0f / sqrtf((float)(ss / (double)head_dim) + eps);
        for (uint32_t i = 0; i < head_dim; i++) head[i] *= scale;
    }
}
```

This is L2-normalization-per-head (modulo `eps`). Why no learned scale? Because attention is *already* `1/sqrt(head_dim)`-scaled at the dot-product step (`kq_scale`, §5). A learned per-head scale on Q would just shift the Q magnitude up and down, which is mathematically equivalent to scaling the dot-product. Folding the scale into Q's preprocessing means it cannot be learned; that prevents one common form of attention degeneracy (a head learning to scale itself out of the softmax).

There is a companion function `layer_q_projection_with_lora_one` (`ds4.c:4708-4723`) that returns *both* `q` (the 32768-dim head matrix) *and* the intermediate `qr_norm` (the 1024-dim low-rank vector). The indexer (Chapter 07 §7) needs `qr_norm` to build its own queries — it shares the same low-rank Q lane, so the engine avoids recomputing it.

## 2. KV projection: single shared head

`DS4_N_HEAD_KV = 1` means all 64 Q heads attend against one shared KV head. The projection is a straightforward Q8_0 matmul plus a learned RMSNorm:

```c
// ds4.c:4725-4739
static void layer_kv_projection_normed_one(
        const ds4_model   * model,
        const ds4_layer_weights * layer,
        const float       * normed,
        float             * kv) {
    float *raw = xmalloc((size_t)DS4_N_HEAD_DIM * sizeof(raw[0]));

    const float *kv_norm = tensor_data(model, layer->attn_kv_a_norm);

    matvec_q8_0(raw, model, layer->attn_kv, normed);
    rms_norm_weight(kv, raw, kv_norm, DS4_N_HEAD_DIM, DS4_RMS_EPS);

    free(raw);
}
```

Shapes (`ds4.c:2402-2403`):

- `attn_kv`: Q8_0, `[4096, 512]`.
- `attn_kv_a_norm`: F32, `[512]`.

The single 512-dim KV vector is what gets pushed to the raw cache and what the compressor's gate/wkv project from. The learned RMSNorm at the end is essential for the compressor's correctness: the compressor's own RMSNorm at its output happens *after* the per-dim softmax, so the KV vector entering the pool needs to be on a normalized scale or the pool's softmax will be dominated by whichever channels happen to have large pre-norm magnitudes.

Parameter count: 4096 × 512 = 2M per layer + 512 scales. Compare with a multi-head KV scheme — a 64-head KV would be 64× larger at 128M parameters per layer just for K and V. The single shared KV head is what makes the cache row a tractable 512 floats per token per layer (§Chapter 07).

## 3. Layer-dependent RoPE

DS4 uses **tail-only RoPE**: only the last `DS4_N_ROT = 64` of the 512 head dims are rotated. The first `448 = 512 - 64` dims (the "nope" part) carry no position information from RoPE; they are the dims that will be FP8-quantized into the compressed cache.

The general rotation kernel is `rope_tail_ext_inplace` (`ds4.c:4787-4835`):

```c
// ds4.c:4787-4835 (abridged)
static void rope_tail_ext_inplace(
        float    * x, uint32_t n_head, uint32_t head_dim, uint32_t n_rot,
        uint32_t pos, uint64_t n_ctx_orig, float freq_base, float freq_scale,
        float ext_factor, float attn_factor, float beta_fast, float beta_slow,
        bool inverse) {
    const uint32_t n_nope = head_dim - n_rot;
    const float theta_scale = powf(freq_base, -2.0f / (float)n_rot);
    const float sin_sign = inverse ? -1.0f : 1.0f;
    float corr_dims[2] = { 0.0f, 0.0f };
    if (ext_factor != 0.0f) {
        rope_yarn_corr_dims((int)n_rot, n_ctx_orig, freq_base, beta_fast, beta_slow, corr_dims);
    }

    for (uint32_t h = 0; h < n_head; h++) {
        float *tail = x + (uint64_t)h * head_dim + n_nope;
        float theta_extrap = (float)pos;
        for (uint32_t i = 0; i < n_rot; i += 2) {
            const float theta_interp = freq_scale * theta_extrap;
            float theta = theta_interp;
            float mscale = attn_factor;
            if (ext_factor != 0.0f) {
                const float ramp_mix = rope_yarn_ramp(corr_dims[0], corr_dims[1], (int)i) * ext_factor;
                theta = theta_interp * (1.0f - ramp_mix) + theta_extrap * ramp_mix;
                mscale *= 1.0f + 0.1f * logf(1.0f / freq_scale);
            }
            const float c = cosf(theta) * mscale;
            const float s = sin_sign * sinf(theta) * mscale;
            const float x0 = tail[i + 0];
            const float x1 = tail[i + 1];
            tail[i + 0] = x0 * c - x1 * s;
            tail[i + 1] = x0 * s + x1 * c;
            theta_extrap *= theta_scale;
        }
    }
}
```

The interesting parts:

- **`n_nope = head_dim - n_rot`** — the offset where the rotation starts within each head. Dims `[0, n_nope)` are untouched; dims `[n_nope, head_dim)` are the RoPE tail.
- **`theta_scale = freq_base^(-2/n_rot)`** — standard RoPE per-pair frequency progression. With `n_rot = 64` we have 32 pairs at decreasing frequencies.
- **YaRN interpolation** when `ext_factor != 0` — the `ramp_mix` blends between `theta_interp` (frequency-scaled, for context extension) and `theta_extrap` (unscaled, for short positions). The boundary is determined by `corr_dims`, which is computed from `beta_fast` and `beta_slow`. This is the standard YaRN mechanism for extending RoPE to long contexts without degrading short-context behavior.
- **`sin_sign = inverse ? -1.0f : 1.0f`** — inverse RoPE flips the sin sign, which undoes the rotation when applied to the value vectors that come out of attention. See §6.

The layer wrapper `rope_tail_layer_inplace` (`ds4.c:4851-4882`) picks the per-layer parameters:

```c
// ds4.c:4838-4882
static float layer_rope_freq_base(uint32_t il) {
    return ds4_layer_compress_ratio(il) != 0 && DS4_COMPRESS_ROPE_FREQ_BASE > 0.0f
        ? DS4_COMPRESS_ROPE_FREQ_BASE
        : DS4_ROPE_FREQ_BASE;
}

static float layer_rope_freq_scale(uint32_t il) {
    if (ds4_layer_compress_ratio(il) == 0 || DS4_ROPE_SCALE_FACTOR <= 0.0f) {
        return 1.0f;
    }
    return 1.0f / DS4_ROPE_SCALE_FACTOR;
}

static void rope_tail_layer_inplace(
        float * x, uint32_t n_head, uint32_t head_dim, uint32_t n_rot,
        uint32_t pos, uint32_t il, bool inverse) {
    const bool compressed = ds4_layer_compress_ratio(il) != 0;
    const float freq_base = layer_rope_freq_base(il);
    const float freq_scale = layer_rope_freq_scale(il);
    const float ext_factor = compressed && DS4_ROPE_SCALE_FACTOR > 1.0f ? 1.0f : 0.0f;
    float attn_factor = 1.0f;
    if (ext_factor != 0.0f && freq_scale > 0.0f) {
        attn_factor /= 1.0f + 0.1f * logf(1.0f / freq_scale);
    }

    rope_tail_ext_inplace(x, n_head, head_dim, n_rot, pos,
                          compressed ? DS4_ROPE_ORIG_CTX : 0,
                          freq_base, freq_scale, ext_factor, attn_factor,
                          DS4_ROPE_YARN_BETA_FAST, DS4_ROPE_YARN_BETA_SLOW,
                          inverse);
}
```

Two RoPE regimes:

- **Dense layers (0, 1)**: `freq_base = 10000` (`DS4_ROPE_FREQ_BASE`, `ds4.c:57`), `freq_scale = 1`, no YaRN extension. Standard RoPE.
- **Compressed layers (2-42)**: `freq_base = 160000` (`DS4_COMPRESS_ROPE_FREQ_BASE`, `ds4.c:61`), `freq_scale = 1/16` (`DS4_ROPE_SCALE_FACTOR = 16`, `ds4.c:58`), `ext_factor = 1.0`, `n_ctx_orig = 65536` (`DS4_ROPE_ORIG_CTX`, `ds4.c:62`).

The compressed layers use a much higher frequency base and a fractional frequency scale together with YaRN extrapolation. The combined effect: the angular distance between adjacent positions is much smaller in the higher dims (the high-frequency dims rotate slower in absolute terms), which extends the effective context the model can resolve without retraining. The `n_ctx_orig = 65536` parameter tells YaRN that the model was originally trained for 64K context; everything beyond that uses the extrapolation curve.

The `attn_factor` adjustment (lines 4864-4870) is a small but load-bearing detail. The comment in the source explains it:

> This YaRN helper applies magnitude scaling internally. DeepSeek V4 reference RoPE uses interpolation without that magnitude change, so pass the inverse factor here and let the helper cancel itself out.

YaRN's standard formulation multiplies the cos/sin by `1 + 0.1 * log(1/freq_scale)` to compensate for the frequency stretching. DeepSeek V4's reference RoPE does *not* want that magnitude scaling. The fix: pre-divide `attn_factor` by the same factor, so when the helper multiplies by it again, the two cancel. This matches the reference DeepSeek graph exactly.

Dense layers leave `n_ctx_orig = 0`, which (via `ext_factor = 0` at line 4805) bypasses the YaRN math entirely — short context layers use the original RoPE formulation without modification.

## 4. The raw KV path: project, RoPE, FP8, push

After Q and KV are projected, the attention sublayer hands off to the cache writer:

```c
// ds4.c:7126-7130
rope_tail_layer_inplace(q,  DS4_N_HEAD,    DS4_N_HEAD_DIM, DS4_N_ROT, pos, il, false);
rope_tail_layer_inplace(kv, DS4_N_HEAD_KV, DS4_N_HEAD_DIM, DS4_N_ROT, pos, il, false);
dsv4_fp8_kv_quantize_row_inplace_cpu(kv, DS4_N_HEAD_DIM, DS4_N_ROT);

kv_cache_push_raw(cache, kv);
```

Three lines. The first two RoPE-rotate Q and KV at the *same* position with the *same* layer parameters — they have to match for the dot product to make sense. The third applies the FP8 round-trip to the KV vector's nope dims (Chapter 07 §6), simulating what the GPU stores; the rope tail is left alone because RoPE precision matters more for the dot-product math than for the cache memory budget. Then `kv_cache_push_raw` writes the row into the ring buffer.

Note that `kv` is *only* the single KV head's vector (`DS4_N_HEAD_KV = 1`), 512 dims; the RoPE call passes `DS4_N_HEAD_KV = 1` so it rotates just that one head. The Q matrix is 64 × 512 — its RoPE call rotates the tail of every Q head, all at the same `pos`.

## 5. Sink-aware mixed attention

This is where the dual cache pays off. The single-token attention reads both `raw_kv` and `attn_comp_kv` through one softmax (`layer_attention_mixed_one`, `ds4.c:6721-6781`):

```c
// ds4.c:6721-6781 (abridged)
static void layer_attention_mixed_one(
        float * out_heads,
        const ds4_model   * model,
        const ds4_layer_weights * layer,
        const float * q,
        const float * raw_kv, uint32_t n_raw,
        const float * comp_kv, uint32_t n_comp,
        const bool  * comp_allowed) {
    const float *sinks = tensor_data(model, layer->attn_sinks);
    const float kq_scale = 1.0f / sqrtf((float)DS4_N_HEAD_DIM);
    const uint32_t n_total = n_raw + n_comp;
    float score_stack[512];
    float *score = n_total <= 512 ? score_stack : xmalloc(n_total * sizeof(float));

    for (uint32_t h = 0; h < DS4_N_HEAD; h++) {
        const float *qh = q + (uint64_t)h * DS4_N_HEAD_DIM;
        float max_score = sinks[h];
        uint32_t idx = 0;

        for (uint32_t r = 0; r < n_raw; r++, idx++) {
            const float *kv = raw_kv + (uint64_t)r * DS4_N_HEAD_DIM;
            score[idx] = dot_f32(qh, kv, DS4_N_HEAD_DIM) * kq_scale;
            if (score[idx] > max_score) max_score = score[idx];
        }
        for (uint32_t r = 0; r < n_comp; r++, idx++) {
            if (comp_allowed && !comp_allowed[r]) {
                score[idx] = DS4_NEG_INF;
                continue;
            }
            const float *kv = comp_kv + (uint64_t)r * DS4_N_HEAD_DIM;
            score[idx] = dot_f32(qh, kv, DS4_N_HEAD_DIM) * kq_scale;
            if (score[idx] > max_score) max_score = score[idx];
        }

        float *oh = out_heads + (uint64_t)h * DS4_N_HEAD_DIM;
        memset(oh, 0, DS4_N_HEAD_DIM * sizeof(float));

        float denom = expf(sinks[h] - max_score);
        idx = 0;
        for (uint32_t r = 0; r < n_raw; r++, idx++) {
            const float weight = expf(score[idx] - max_score);
            denom += weight;
            axpy_f32(oh, raw_kv + (uint64_t)r * DS4_N_HEAD_DIM, weight, DS4_N_HEAD_DIM);
        }
        for (uint32_t r = 0; r < n_comp; r++, idx++) {
            if (score[idx] <= DS4_NEG_INF * 0.5f) continue;
            const float weight = expf(score[idx] - max_score);
            denom += weight;
            axpy_f32(oh, comp_kv + (uint64_t)r * DS4_N_HEAD_DIM, weight, DS4_N_HEAD_DIM);
        }

        scale_f32(oh, 1.0f / denom, DS4_N_HEAD_DIM);
    }
}
```

The math is standard scaled-dot-product attention with two modifications:

**The sink logit (`sinks[h]`)** participates in the softmax denominator but contributes no value vector. The initialization `max_score = sinks[h]` (line 6739) and `denom = expf(sinks[h] - max_score)` (line 6760) include sink in the running max and the denominator without ever adding a `sinks[h] * value` to the output. This is the "attention sink" mechanism from Streaming-LLM / Quiet-STaR: a learned scalar per head that absorbs softmax probability mass the head doesn't want to allocate to any actual token. Without it, attention is forced to put weight *somewhere*, even on irrelevant tokens; with it, a head can effectively "abstain" by putting all its mass on the sink.

`attn_sinks` is shape `[DS4_N_HEAD] = [64]` F32 (`ds4.c:2404`). One scalar per head, learned at training time.

**The indexer mask (`comp_allowed`)** filters compressed rows for ratio-4 layers. A masked row gets `score[idx] = DS4_NEG_INF` (line 6749); the softmax effectively zeroes its weight. In the accumulation pass, the explicit check `if (score[idx] <= DS4_NEG_INF * 0.5f) continue` (line 6769) skips the value accumulation entirely so the masked row's KV is never read. This is both a correctness check (`expf(-inf - max_score)` is `0.0`, but we'd still pay the read) and a memory-bandwidth optimization.

For ratio-128 layers, `comp_allowed = NULL` (line 7176 in `layer_attention_raw_swa_one`), and the kernel attends to all compressed rows. For dense layers (ratio 0), the code path is different: `layer_attention_rows_one` (`ds4.c:4990-5028`) handles the no-compressed-rows case with the same sink-aware math but only one loop over `kv_rows`.

**Score buffer**: the function uses a stack array (`float score_stack[512]`, line 6734) for the score buffer when `n_total <= 512`, falling back to `malloc` for larger contexts. The stack version is the hot path: a sliding window of 128 plus a typical small `n_comp` fits easily. The decode-scratch variant (`layer_attention_mixed_one_decode_scratch`, `ds4.c:6783-6842`) uses the persistent `scratch->attn_score` buffer and is checked against `scratch->attn_score_cap` at runtime (line 6797).

## 6. Inverse RoPE on the heads

After attention produces the head matrix (64 heads × 512), the engine applies *inverse* RoPE before the grouped output projection:

```c
// ds4.c:7184
rope_tail_layer_inplace(heads, DS4_N_HEAD, DS4_N_HEAD_DIM, DS4_N_ROT, pos, il, true);
```

The `inverse = true` parameter flips `sin_sign` in `rope_tail_ext_inplace` (`ds4.c:4803`). This undoes the RoPE rotation that was implicitly carried through the attention math.

Why? Because the value vector being weighted-summed is not a "value" in the canonical Q/K/V sense — DS4's single KV head provides *both* the K (for dot products) and the V (for accumulation). The K side gets RoPE'd to encode position into the dot product. The V side, when accumulated, inherits that RoPE rotation. But the downstream output projection needs to see *un-rotated* value content; otherwise the output projection would have to learn a different rotation per position, defeating position-translation invariance.

The fix: rotate the accumulated head outputs *backwards*, undoing the RoPE that was on the V side. Now `grouped_out` sees position-invariant value content. The position information has done its job (it influenced which KV rows got high softmax weight) and can be removed from the output.

This is one of those one-line tricks that looks like a typo when you first encounter it and turns out to be load-bearing once you trace the math.

## 7. Grouped low-rank output projection

The output projection has its own low-rank decomposition, similar in spirit to Q. `layer_grouped_out_one` (`ds4.c:5041-5057`):

```c
// ds4.c:5041-5057
static void layer_grouped_out_one(
        float             * out,
        const ds4_model   * model,
        const ds4_layer_weights * layer,
        const float       * heads) {
    const uint32_t n_groups = 8;
    const uint32_t group_heads = DS4_N_HEAD / n_groups;
    const uint32_t group_dim = DS4_N_HEAD_DIM * group_heads;
    const uint32_t rank = 1024;

    float *low = xcalloc((size_t)n_groups * rank, sizeof(low[0]));

    matvec_q8_0_grouped_rows(low, model, layer->attn_output_a, heads, n_groups, group_dim, rank);

    matvec_q8_0(out, model, layer->attn_output_b, low);
    free(low);
}
```

The shapes:

- `attn_output_a`: Q8_0, shape `[DS4_N_HEAD_DIM * (DS4_N_HEAD / DS4_N_OUT_GROUP), DS4_N_OUT_GROUP * DS4_N_LORA_O]` = `[4096, 8 * 1024]` (`ds4.c:2405`). The rows partition into `DS4_N_OUT_GROUP = 8` groups, each row corresponding to a `group_dim = 8 heads × 512 dims = 4096`-wide block of the head matrix.
- `attn_output_b`: Q8_0, shape `[8 * 1024, 4096]` = `[8192, 4096]` (`ds4.c:2406`). Projects the concatenated low-rank vectors back to the embedding width.

Equivalent dense layer would be 32768 → 4096 = 134M parameters. The grouped low-rank version is (4096 × 8192) + (8192 × 4096) = 33.5M + 33.5M = 67M, half the size.

The grouped step (`matvec_q8_0_grouped_rows`) is implemented to process all 8 groups in parallel. Each group reads 4096 dims of heads (8 consecutive heads, all 512 dims each) and produces 1024 low-rank outputs. The 8 outputs are then concatenated and projected through `attn_output_b` to give the 4096-dim `attn_out`.

The decode-scratch variant (`layer_grouped_out_one_decode_scratch`, `ds4.c:5059-5074`) uses `scratch->attn_low` (a persistent 8 × 1024 buffer) so the hot decode path makes zero allocations.

## 8. The full decode-step assembly

`layer_attention_raw_swa_one` (`ds4.c:7090-7198`) is the single-token attention sublayer end to end. The non-scratch reference reads:

```c
// ds4.c:7115-7188 (abridged structure)
memcpy(attn_residual, inp_hc, (size_t)n_hc * DS4_N_EMBD * sizeof(inp_hc[0]));
hc_pre_from_state_one(model,
                      layer->hc_attn_fn,
                      layer->hc_attn_scale,
                      layer->hc_attn_base,
                      attn_residual, attn_cur, post, comb);

layer_attn_norm_one(attn_norm, model, layer, attn_cur);
layer_q_projection_with_lora_one(model, layer, attn_norm, q, qr_norm);
layer_kv_projection_normed_one(model, layer, attn_norm, kv);

rope_tail_layer_inplace(q,  DS4_N_HEAD,    DS4_N_HEAD_DIM, DS4_N_ROT, pos, il, false);
rope_tail_layer_inplace(kv, DS4_N_HEAD_KV, DS4_N_HEAD_DIM, DS4_N_ROT, pos, il, false);
dsv4_fp8_kv_quantize_row_inplace_cpu(kv, DS4_N_HEAD_DIM, DS4_N_ROT);

kv_cache_push_raw(cache, kv);

const uint32_t ratio = cache->compress_ratio;
if (ratio != 0) {
    /* compressor write + (ratio-4) indexer write + indexer scoring */
    layer_attention_mixed_one(heads, model, layer, q,
                              cache->raw_kv, cache->n_raw,
                              cache->attn_comp_kv, cache->n_comp,
                              comp_allowed);
} else {
    layer_attention_rows_one(heads, model, layer, q, cache->raw_kv, cache->n_raw);
}

rope_tail_layer_inplace(heads, DS4_N_HEAD, DS4_N_HEAD_DIM, DS4_N_ROT, pos, il, true);
layer_grouped_out_one(attn_out, model, layer, heads);
cpu_directional_steering_project_rows(attn_out, steering_dirs, il, 1, steering_scale);
hc_post_one(after_attn_hc, attn_out, attn_residual, post, comb, DS4_N_EMBD, n_hc);
```

Reading top to bottom:

1. **Save the 4-stream residual** (`memcpy attn_residual ← inp_hc`). HC post needs it.
2. **HC pre** collapses the 4 streams into a single 4096-wide vector. See Chapter 09.
3. **Attention RMSNorm** with learned scale (`attn_norm`).
4. **Q and KV projections** as in §1 and §2. Q comes with `qr_norm` for the indexer.
5. **RoPE Q and KV** at the same position, same layer parameters.
6. **FP8 KV nope** (Chapter 07 §6).
7. **Push to raw cache** (Chapter 07 §4).
8. **If layer compresses**: update the compressor and (ratio-4) the indexer, then attend with `layer_attention_mixed_one`. Otherwise attend with the simpler `layer_attention_rows_one`.
9. **Inverse RoPE** on the head outputs (§6).
10. **Grouped output projection** (§7).
11. **Directional steering** — a steering-vector hook (`cpu_directional_steering_project_rows`) that, when steering directions are loaded, projects out a direction component before the residual rejoins. Not commonly used; for activation-engineering experiments.
12. **HC post** fans the 4096-wide attention output back to 4 residual streams (Chapter 09).

The decode-scratch version `layer_attention_raw_swa_one_decode_scratch` (around `ds4.c:7567+`, called from the main decode loop) is byte-equivalent but uses `scratch->*` buffers everywhere.

## 9. Batched prefill: the same dance, parallel

Prefill processes an entire prompt token batch in one go. `layer_attention_raw_swa_batch` (`ds4.c:7202-...`) starts the same way:

```c
// ds4.c:7246-7287 (abridged)
hc_pre_norm_batch(model,
                  layer->hc_attn_fn, layer->hc_attn_scale, layer->hc_attn_base,
                  layer->attn_norm,
                  inp_hc, attn_residual, attn_cur, attn_norm, post, comb, n_tok);

matmul_q8_0_batch(qr, model, layer->attn_q_a, attn_norm, n_tok);
for (uint32_t t = 0; t < n_tok; t++) {
    rms_norm_weight(qr_norm + t * 1024, qr + t * 1024, q_a_norm, 1024, DS4_RMS_EPS);
}
matmul_q8_0_batch(q, model, layer->attn_q_b, qr_norm, n_tok);
for (uint32_t t = 0; t < n_tok; t++) {
    head_rms_norm_inplace(q + t * q_dim, DS4_N_HEAD, DS4_N_HEAD_DIM, DS4_RMS_EPS);
}

matmul_q8_0_batch(kv_raw, model, layer->attn_kv, attn_norm, n_tok);
for (uint32_t t = 0; t < n_tok; t++) {
    rms_norm_weight(kv + t * DS4_N_HEAD_DIM, kv_raw + t * DS4_N_HEAD_DIM, kv_norm,
                    DS4_N_HEAD_DIM, DS4_RMS_EPS);
}
```

The pattern: the matmuls are batched (`matmul_q8_0_batch`), the per-token-norms run in a tight loop. After projections, RoPE and FP8 are applied across all tokens, then the per-token cache write loop runs (Chapter 07 §9). Finally `layer_attention_prefix_batch` (`ds4.c:6929-6960`) runs the attention pass over all `n_tok × DS4_N_HEAD` head-token pairs in parallel:

```c
// ds4.c:6929-6960 (abridged)
static void layer_attention_prefix_batch(
        float * out_heads, const ds4_model * model, const ds4_layer_weights * layer,
        const float * q, const float * raw_kv, const float * comp_kv,
        const uint32_t * comp_counts, const uint8_t * allowed_mask,
        const uint8_t * allowed_bits, uint64_t allowed_stride,
        uint32_t n_tok, uint32_t raw_cap) {
    layer_attention_prefix_batch_ctx ctx = { ... };
    ds4_parallel_for_min_rows((uint64_t)n_tok * DS4_N_HEAD,
                              layer_attention_prefix_batch_worker, &ctx, 1);
}
```

Inside the worker (`layer_attention_prefix_batch_worker`, `ds4.c:6868-6925`), each `(t, h)` pair computes its attention independently. The visible raw rows are determined by `raw_count = min(t+1, raw_cap)` and `raw_start = t + 1 - raw_count` (lines 6880-6881) — causal masking baked into the index range, not a mask. The visible compressed rows are `comp_count = comp_counts[t]` — a per-token visibility profile computed as the compressors emit rows during the per-token loop.

The `allowed_bits` bitmask (line 6864-6866) packs the indexer mask for the entire prefill batch: bit `(t * stride + c)` says whether token `t` may attend compressed row `c`. Bit-packed because at large `n_tok × n_comp` the array would be huge as bytes.

The grouped output projection then runs batched (`layer_grouped_out_batch`, `ds4.c:5076+`), and HC post batched too (`hc_post_batch`, `ds4.c:4481-4540`).

The key fact about prefill: the **token-by-token cache write loop** (Chapter 07 §9) cannot be parallelized because the compressor state is sequential, but every other phase (projections, RoPE, attention scoring, output projection) is fully parallel. So the prefill cost decomposes into a small serial section (compressor state updates) and a large parallel section (the projections and attention math). On a many-core CPU or a GPU, the parallel section dominates by orders of magnitude.

## 10. GPU kernel mapping

For reference, the equivalent GPU kernel surface (`ds4_gpu.h:129-542`):

- **Projections**: `ds4_gpu_matmul_q8_0_tensor` (`ds4_gpu.h:137`) handles all Q/KV/output Q8_0 matmuls. The `n_tok` parameter lets one call handle batched prefill or single-token decode.
- **Norms**: `ds4_gpu_rms_norm_plain_tensor`, `ds4_gpu_rms_norm_weight_tensor`, `ds4_gpu_head_rms_norm_tensor`, `ds4_gpu_dsv4_qkv_rms_norm_rows_tensor` (`ds4_gpu.h:198-249`). The last one is a fused pair that normalizes Q and KV in one kernel.
- **FP8 quantize**: `ds4_gpu_dsv4_fp8_kv_quantize_tensor` (`ds4_gpu.h:251-255`), `ds4_gpu_kv_fp8_store_raw_tensor` (`ds4_gpu.h:281-287`). The fused store-raw kernel applies FP8 nope plus the F16 raw-cache write in one dispatch (the comment at `ds4_gpu.h:278-280` documents this is "Release decode fused KV finalizer").
- **Indexer QAT**: `ds4_gpu_dsv4_indexer_qat_tensor` (`ds4_gpu.h:257-260`).
- **RoPE**: `ds4_gpu_rope_tail_tensor` (`ds4_gpu.h:262-276`). All YaRN parameters explicit.
- **Attention**: there are *six* attention kernels for different modes (`ds4_gpu.h:421-542`):
  - `ds4_gpu_attention_decode_heads_tensor` — one token, single position.
  - `ds4_gpu_attention_decode_raw_batch_heads_tensor` — batched decode (e.g. parallel sampling), raw cache only.
  - `ds4_gpu_attention_decode_mixed_batch_heads_tensor` — batched decode, raw + compressed.
  - `ds4_gpu_attention_indexed_mixed_batch_heads_tensor` — batched decode, raw + compressed + indexer top-k mask.
  - `ds4_gpu_attention_prefill_raw_heads_tensor` — batched prefill, raw cache only.
  - `ds4_gpu_attention_prefill_static_mixed_heads_tensor` and `..._masked_mixed_heads_tensor` — batched prefill with compressed cache, with and without indexer mask.

The Metal implementations are in `metal/flash_attn.metal` (general FlashAttention; the dense layers use `kernel_flash_attn_ext` at line 889) and `metal/dsv4_misc.metal` (the mixed/indexed kernels specific to DS4: `kernel_dsv4_indexed_mixed_attention_heads8` at line 577, plus a `_rb16` variant at line 685 tuned for ring-buffer attentions of 16-aligned strides).

The output projection is `ds4_gpu_attention_output_q8_batch_tensor` (`ds4_gpu.h:544-558`) plus its low-rank-only counterpart `ds4_gpu_attention_output_low_q8_tensor` (`ds4_gpu.h:560-568`). The fused two-step low-rank projection is implemented in `metal/moe.metal` (where it shares dispatch machinery with the expert routed projections): `kernel_dsv4_attn_out_low_q8_0_f32` at line 874 and the multi-pass tile-launching kernel `kernel_attn_out_low_q8_0_mpp_direct_rhs` at line 1768.

## 10.5. The fused Q/KV projection on GPU

A small but important fusion: on the GPU, the Q and KV RMSNorms can run in one kernel via `ds4_gpu_dsv4_qkv_rms_norm_rows_tensor` (`ds4_gpu.h:230-242`):

```c
// ds4_gpu.h:230-242
int ds4_gpu_dsv4_qkv_rms_norm_rows_tensor(
        ds4_gpu_tensor       *q_out,
        const ds4_gpu_tensor *q,
        const void             *model_map,
        uint64_t                model_size,
        uint64_t                q_weight_offset,
        uint32_t                q_n,
        ds4_gpu_tensor       *kv_out,
        const ds4_gpu_tensor *kv,
        uint64_t                kv_weight_offset,
        uint32_t                kv_n,
        uint32_t                rows,
        float                   eps);
```

The kernel takes both Q (after the `attn_q_b` projection) and KV (after the `attn_kv` projection) plus their respective learned norm weights, and normalizes both in one dispatch. Why fuse them? Because the per-token normalization is very memory-bound (load 1024-dim Q, load 512-dim KV, do simple arithmetic, store both back) and a single kernel can interleave the two loads to hide memory latency. The CPU path has no such fusion — it would not pay back the additional code complexity on a serial loop.

The matmul side has a similar fusion: `ds4_gpu_matmul_f16_pair_tensor` (`ds4_gpu.h:170-180`) computes two F16 matmuls sharing one input. The compressor uses this for `wkv` and `wgate` (which always share `attn_norm` as input); the FFN's shared expert uses an analogous Q8_0 pair fusion (`ds4_gpu_shared_gate_up_swiglu_q8_0_tensor`, `ds4_gpu.h:147-158`).

## 10.6. The HC pre buffer requirement

A subtle requirement: HC pre needs `attn_residual` to be a *copy* of `inp_hc`, not a pointer. The reason is that `hc_pre_from_state_one` reads `inp_hc` to compute the mix vector and then `hc_post_one` reads the same residual to add to the new attention output. If HC pre were to overwrite `inp_hc`, HC post would have the wrong residual.

In the non-scratch path, this is a `memcpy` (`ds4.c:7115`):

```c
memcpy(attn_residual, inp_hc, (size_t)n_hc * DS4_N_EMBD * sizeof(inp_hc[0]));
```

In the decode-scratch path, the scratch struct has its own `attn_residual` buffer (`ds4.c:6257`) and the engine memcpys into it from `inp_hc` before HC pre runs. Either way, HC pre and HC post must see the same `residual_hc` content.

## 11. Inside `layer_attention_rows_one`: dense layers only

For comparison, the dense-layer attention (`layer_attention_rows_one`, `ds4.c:4990-5028`) is just the raw-cache half of the mixed kernel:

```c
// ds4.c:4990-5028 (abridged)
static void layer_attention_rows_one(
        float * out_heads, const ds4_model * model, const ds4_layer_weights * layer,
        const float * q, const float * kv_rows, uint32_t n_kv) {
    const float *sinks = tensor_data(model, layer->attn_sinks);
    const float kq_scale = 1.0f / sqrtf((float)DS4_N_HEAD_DIM);
    float score_stack[512];
    float *score = n_kv <= 512 ? score_stack : xmalloc(n_kv * sizeof(float));

    for (uint32_t h = 0; h < DS4_N_HEAD; h++) {
        const float *qh = q + (uint64_t)h * DS4_N_HEAD_DIM;
        float max_score = sinks[h];
        for (uint32_t r = 0; r < n_kv; r++) {
            const float *kv = kv_rows + (uint64_t)r * DS4_N_HEAD_DIM;
            score[r] = dot_f32(qh, kv, DS4_N_HEAD_DIM) * kq_scale;
            if (score[r] > max_score) max_score = score[r];
        }
        float *oh = out_heads + (uint64_t)h * DS4_N_HEAD_DIM;
        memset(oh, 0, DS4_N_HEAD_DIM * sizeof(float));
        float denom = expf(sinks[h] - max_score);
        for (uint32_t r = 0; r < n_kv; r++) {
            const float weight = expf(score[r] - max_score);
            denom += weight;
            axpy_f32(oh, kv_rows + (uint64_t)r * DS4_N_HEAD_DIM, weight, DS4_N_HEAD_DIM);
        }
        scale_f32(oh, 1.0f / denom, DS4_N_HEAD_DIM);
    }
}
```

Same sink-aware softmax, same `kq_scale`, same per-head independence. The mixed kernel is just this with a second loop appended that handles compressed rows under the indexer mask. For layers 0 and 1 (ratio = 0), the raw cache is the entire cache: 128 rows of recent context, no compressed history. The attention output then flows through the rest of the sublayer unchanged.

## 11.5. End-to-end token walkthrough

Let's trace what happens to one token, layer by layer, focusing on the attention sublayer. Suppose `pos = 200` (a token well past the end of the raw SWA's 128-row capacity), context length 4096, ratio-4 layer (say layer 16).

Pre-conditions on cache entry:

- `cache->n_raw = 128` (raw window saturated; it has been sliding since pos 128).
- `cache->n_comp = 200 / 4 = 50` (a compressed row has been emitted every 4 positions for 200 positions).
- `cache->n_index_comp = 50` (the indexer has been compressing in parallel).
- `cache->attn_state_kv` and `cache->attn_state_score` contain the current open window (rows 4..7) plus the previous window's snapshot (rows 0..3) for ratio-4 layers.

Step 1: HC pre (Chapter 09). Inputs 4 streams × 4096 floats from `inp_hc`. Output: `attn_cur` (4096-wide), `post[4]`, `comb[16]`. The residual `attn_residual` is saved.

Step 2: `layer_attn_norm_one` produces `attn_norm` (4096-wide), the RMS-normalized attention input.

Step 3: Q projection. `attn_q_a` (Q8_0) maps `attn_norm` to `qr` (1024). RMSNorm with `attn_q_a_norm` produces `qr_norm` (1024). `attn_q_b` (Q8_0) maps `qr_norm` to `q` (32768 = 64 × 512). Per-head RMSNorm normalizes each of the 64 heads independently.

Step 4: KV projection. `attn_kv` (Q8_0) maps `attn_norm` to `raw` (512). RMSNorm with `attn_kv_a_norm` produces `kv` (512).

Step 5: RoPE both. Q's 64 heads each get their last 64 dims rotated at angle `freq_scale * pos` (with YaRN curve), using compressed-layer parameters (`freq_base = 160000`, `freq_scale = 1/16`, `ext_factor = 1`). KV's single head gets the same treatment.

Step 6: FP8-quantize the KV nope (first 448 of 512 dims) in 64-dim blocks. The RoPE tail is left in F32.

Step 7: `kv_cache_push_raw` — the raw cache is full at 128 rows, so it slides one row forward (256 KiB memmove) and the new KV is F16-rounded into position 127. `cache->n_raw` stays at 128.

Step 8: Compressor write. `compressor_decode_one` projects `attn_norm` through `attn_compressor_kv` and `attn_compressor_gate` (4096 → 1024 each, since `coff = 2` for ratio-4). The 1024-dim result is APE-biased and written into row 4 of the rolling state (since `pos_mod = 200 % 4 = 0`, `row = 4 + 0`). Since `(200 + 1) % 4 != 0`, no row is emitted.

Wait — let me re-check. `pos = 200`, `(pos + 1) % ratio = 201 % 4 = 1`. So `should_compress = false`. No compressed row this step. `n_comp` stays at 50.

For pos = 203: `pos_mod = 203 % 4 = 3`, `row = 4 + 3 = 7`. `(203 + 1) % 4 = 0`, `should_compress = true`. Pool runs, emits row, `n_comp` becomes 51. State rolls (rows 4-7 → rows 0-3, current rows duplicated into 4-7). For the next four tokens (pos 204-207), rows 4-7 are overwritten with the new window.

Step 9: Indexer write. Same logic as attention compressor but with `indexer_compressor_*` weights producing 128-wide output. Pool emits to `index_comp_kv` on the same boundaries.

Step 10: Indexer scoring. `indexer_allowed_decode_one` runs. With `n_comp = 50` and `top_k = 512`, `top_k >= n_comp`, so the function takes the shortcut at line 6977: every compressed row is allowed (`allowed[i] = true` for all i). The indexer's actual selection only kicks in when `n_comp > 512`, which at this context length doesn't happen yet.

Step 11: Mixed attention. `layer_attention_mixed_one` reads `q` (64 × 512), `raw_kv` (128 × 512), `attn_comp_kv` (50 × 512), `comp_allowed` (50 booleans, all true). For each of the 64 heads:

- 128 + 50 = 178 score computations (dot products at `kq_scale = 1/sqrt(512)`).
- `max_score` starts at `sinks[h]` and is updated.
- Softmax: `denom = expf(sinks[h] - max_score)` plus all `expf(score - max_score)` for both raw and compressed rows.
- 178 axpy accumulations into `oh` (the head's output vector).
- One scale by `1/denom`.

The work is `O(178 × 512) ≈ 91K floating-point operations per head per layer per token`. Times 64 heads ≈ 5.8M ops. Times 43 layers ≈ 250M ops per token's attention. The KV cache reads dominate the memory bandwidth: 178 × 512 floats × 4 bytes ≈ 360 KiB read per head per layer (the 64 heads share the same KV rows so the actual read is just 360 KiB per layer × 43 = 15 MiB per token).

Step 12: Inverse RoPE. Each head's output gets the inverse rotation at `pos = 200` to remove position information from the value-side.

Step 13: Grouped output. The 32768-dim head matrix is partitioned into 8 groups of 4 heads × 512 = 2048 wait — 64 / 8 = 8 heads per group, 8 × 512 = 4096. The 8 groups each project 4096 → 1024 via `attn_output_a`, producing 8 × 1024 = 8192. Then `attn_output_b` projects 8192 → 4096, producing `attn_out`.

Step 14: HC post. `attn_out` is mixed back into the 4-stream residual using `post` and `comb` from step 1; the result is `after_attn_hc`.

That is one token's pass through one layer's attention sublayer. The FFN sublayer (Chapter 09) does the same dance for its own MoE+shared-expert math, also wrapped in HC pre/post. Total per-layer attention cost: dominated by the matmuls (Q at 4096→1024→32768 and KV at 4096→512, both batched against 64 heads' worth of Q8_0 quantization), the 178 dot products into the cache, and the grouped output matmul.

## 12. Numerical conventions worth memorizing

A handful of small invariants that the rest of the codebase relies on:

- **`kq_scale = 1 / sqrt(head_dim)`** (`ds4.c:6732`, `ds4.c:4998`). Standard attention scaling. The Q vector is *not* additionally scaled by the head norm — per-head RMSNorm has already enforced the right magnitude (§1).
- **Sink in the max**: `max_score = sinks[h]` initialization (lines 6739, 5005). Without this the sink would be exponentially small after `max_score - sinks[h]` and contribute nothing. Keeping it in the max keeps it on the softmax's working scale.
- **Sink in the denom only**: the sink does *not* contribute to `oh` — `axpy_f32` only runs for the real KV rows. Sink is a "denominator-only" softmax slot.
- **Inverse RoPE convention**: `sin_sign = inverse ? -1.0f : 1.0f` (line 4803). The cosine sign is unchanged in inverse mode; only sine flips. This is the standard exp(-iθ) = cos(θ) - i sin(θ) inverse of exp(iθ) = cos(θ) + i sin(θ).
- **Score buffer fast path is 512**: both `layer_attention_mixed_one` (line 6734) and `layer_attention_rows_one` (line 4999) use a 512-element stack array. With `cap_raw = 128` and `n_comp` typically much smaller than 512 in steady state, the stack path is the common case.
- **`expf` on negative arguments**: the codebase uses `expf` directly with `score - max_score` arguments. Since `max_score >= score` by construction, the argument is always non-positive, and `expf` produces values in `[0, 1]`. No overflow concerns.

## 12.5. When the indexer actually kicks in

The walk-through in §11.5 had `n_comp = 50 < 512 = top_k`, so the indexer's selection was a no-op (every row allowed). At what context lengths does the indexer become load-bearing?

Reading `indexer_allowed_decode_one` (`ds4.c:6964-7024`): the shortcut at line 6977 triggers when `top_k >= n_comp`. With `top_k = 512` and ratio-4 compression, `n_comp = pos / 4`. So the indexer's selection becomes active when `pos / 4 >= 512`, i.e., `pos >= 2048`.

For prompts shorter than 2048 tokens, the indexer compressor is still computing the indexer cache rows (and the indexer's quantization-aware-training Hadamard+FP4 path), but the actual top-K filtering is a pass-through. For prompts at 4K, the indexer is filtering — about half the compressed rows on average are masked. For prompts at 64K, the filtering is severe: `n_comp = 16384`, top-K selects 512, only 3% of compressed rows reach attention.

This staged activation means the indexer's *cost* (running the small attention to score every compressed row) grows linearly with context, but its *benefit* (cutting attention from O(n_comp) to O(top_k)) grows faster. Past 2K tokens, the indexer pays for itself; past 8K tokens, it is essential — without it, attention's compressed-row scan would dominate the per-token cost.

The same shortcut exists in `indexer_allowed_decode_one_decode_scratch` (`ds4.c:7042-7046`) and in the GPU kernels (which check `n_comp <= top_k` before launching the top-K kernel). The mask format is also adaptive: in the bitmask path used by prefill (`layer_attention_prefix_batch`, `ds4.c:6863-6866`), the bits-per-token array packs the mask densely; for decode, a `bool[n_comp]` array is enough since only the current token is being processed.

## 12.6. The decode-scratch attention path

For completeness, the decode-time mixed attention (`layer_attention_mixed_one_decode_scratch`, `ds4.c:6783-6842`) is byte-identical math to the non-scratch version but uses the persistent `scratch->attn_score` buffer:

```c
// ds4.c:6796-6798
const uint32_t n_total = n_raw + n_comp;
if (n_total > scratch->attn_score_cap) ds4_die("CPU decode attention score scratch buffer is too small");
float *score = scratch->attn_score;
```

The `attn_score_cap` was sized at scratch init as `raw_cap + comp_cap = 128 + (ctx_size/4 + 2)` (`ds4.c:6233`). For ctx=4096 that is 1026 entries; for ctx=64K it is 16386. Either way, well under the typical L1 cache size. The hot loop spends most of its time in `dot_f32` over the 512-dim cache rows; the score buffer access is the inner-most index variable and stays cache-hot.

A subtle correctness check: line 6797 dies if the score buffer is too small. This is the kind of assertion that should *never* fire in production — it would mean the cache grew beyond the context size estimate at init — but its presence catches bugs that would otherwise silently corrupt attention scores by writing past the buffer.

The decode-scratch grouped output (`layer_grouped_out_one_decode_scratch`, `ds4.c:5059-5074`) uses `scratch->attn_low` as the 8 × 1024 intermediate buffer. The decode-scratch RoPE just calls the same `rope_tail_layer_inplace` function — RoPE is in-place and uses no scratch.

The result: a 43-layer attention pass during decode performs *zero* `malloc` calls. Every temporary buffer is preallocated, the persistent scratch arena is sized once per context, and the hot loop is entirely arithmetic and cache reads.

## 12.7. Diagnostic profiling hooks

The attention sublayer has built-in profiling that ships in the production binary, gated on environment variables. In `layer_attention_raw_swa_batch` (`ds4.c:7213-7224`):

```c
const bool profile = getenv("DS4_PREFILL_PROFILE_DETAIL") != NULL;
const double t_start = profile ? now_sec() : 0.0;
double t_hc_norm = 0.0;
double t_q = 0.0;
double t_kv = 0.0;
double t_token_loop = 0.0;
double t_tl_rope_cache = 0.0;
double t_tl_compress = 0.0;
double t_tl_indexer = 0.0;
double t_tl_attn_rows = 0.0;
double t_tl_inv_rope = 0.0;
double t_out = 0.0;
```

Setting `DS4_PREFILL_PROFILE_DETAIL=1` produces per-layer timing breakdowns at prefill: how much was spent in HC pre+norm, in Q projection, in KV projection, in the per-token loop (broken down further into RoPE+cache, compressor, indexer, attention rows, inverse RoPE), and in the output projection. This is essential when investigating performance: the dual cache architecture has many cost centers and the dominant one shifts with context length.

The same `getenv` hook exists in the decode FFN (`layer_ffn_one`, `ds4.c:5691`) and the decode-scratch FFN (`layer_ffn_one_decode_scratch`, `ds4.c:5796`) — `DS4_DECODE_PROFILE_DETAIL=1` enables similar per-layer breakdowns at decode time. The print format (one stderr line per layer per token) is verbose but lets a developer see exactly where a slowdown is coming from when comparing two runs.

A separate diagnostic hook is the `trace = true` flag passed to `layer_routed_moe_one` (`ds4.c:5713-5750`) which calls `print_vec_stats` after each expert's gate/up/mid/down to show min/max/mean of every activation. This is used during model-conversion validation to ensure the engine's intermediate activations match the reference implementation byte-for-byte.

## 12.8. Constants at a glance

A reference table of the attention-relevant constants (all from `ds4.c:55-115`):

| Constant | Value | Used for |
|----------|-------|----------|
| `DS4_N_LAYER` | 43 | Number of transformer blocks |
| `DS4_N_EMBD` | 4096 | Hidden state width |
| `DS4_N_HEAD` | 64 | Number of Q heads |
| `DS4_N_HEAD_KV` | 1 | Number of KV heads (shared by all Q heads) |
| `DS4_N_HEAD_DIM` | 512 | Per-head dimension |
| `DS4_N_VALUE_DIM` | 512 | Per-head value dim (== HEAD_DIM, no separate V projection) |
| `DS4_N_ROT` | 64 | RoPE-rotated dims at tail of each head |
| `DS4_N_OUT_GROUP` | 8 | Output projection group count |
| `DS4_N_LORA_Q` | 1024 | Q low-rank intermediate dim |
| `DS4_N_LORA_O` | 1024 | Output low-rank intermediate dim |
| `DS4_N_SWA` | 128 | Raw sliding-window cache capacity |
| `DS4_ROPE_FREQ_BASE` | 10000.0 | Dense-layer RoPE base |
| `DS4_COMPRESS_ROPE_FREQ_BASE` | 160000.0 | Compressed-layer RoPE base |
| `DS4_ROPE_SCALE_FACTOR` | 16.0 | Compressed-layer RoPE freq scale = 1/16 |
| `DS4_ROPE_ORIG_CTX` | 65536 | YaRN reference context length |
| `DS4_ROPE_YARN_BETA_FAST` | 32.0 | YaRN fast cutoff |
| `DS4_ROPE_YARN_BETA_SLOW` | 1.0 | YaRN slow cutoff |
| `DS4_RMS_EPS` | (small) | Numerical floor for RMSNorm |

`DS4_N_VALUE_DIM = DS4_N_HEAD_DIM` (both 512) means DS4 does not have a separate V projection like classical attention. The same 512-dim KV vector serves as both K (for dot products) and V (for weighted accumulation). The single KV projection produces one 512-dim vector and attention treats it as K when computing scores and as V when accumulating; the inverse RoPE step at the end (`§6`) cleans up the position bias on the value-side use.

## 13. Why this design

Pulling back from the code, here is the architectural argument for each piece.

**Low-rank Q and grouped low-rank output**: parameter efficiency. A naive Q projection at 64 heads × 512 head_dim is 134M params per layer; DS4's two-stage version is 37M (a 3.6× saving). Multiplied across 43 layers this is the difference between a model that needs a 700GB GGUF and one that fits in 400GB.

**Single shared KV head (`DS4_N_HEAD_KV = 1`)**: cache size. With 64 KV heads the KV cache would be 64× larger. The single head shifts the model away from "every Q head has its own K and V" toward "one KV stream is interpreted by 64 different Q heads." The tradeoff is that the heads share a position embedding (one RoPE rotation), but in practice 64 differently-projected queries against one shared KV provide enough expressive capacity.

**Tail-only RoPE**: lets the nope dims be FP8-quantized for cache storage without losing position information. The 448-dim nope is the bulk of the KV vector; quantizing it (and matching the quantization on the CPU path) is what makes the compressed cache fit in memory. The 64-dim rope tail stays in F16 because position-encoded values cannot tolerate the same quantization without breaking the dot products.

**Layer-dependent RoPE**: long-context capability. The compressed layers do most of the long-range pattern matching, so they need the YaRN extension to handle positions beyond the 64K original training context. The dense layers handle local patterns and don't need extension.

**Sink-aware softmax**: lets attention abstain. In compressed long-context models, many tokens have no obvious "interesting" KV rows to attend to; without sinks, attention has to put weight somewhere, which means it attends to noise. Sinks absorb that noise.

**Mixed raw + compressed attention through one softmax**: model-side simplicity. The model does not need a separate "compressed attention" or "long-term memory" code path; it just attends, and the engine arranges for the right KV rows to be visible at each position.

**Grouped low-rank output**: parameter efficiency again, this time for the output side. 8 groups × 4096 → 1024 plus 8192 → 4096 is 67M params per layer instead of 134M.

The combined effect: an attention sublayer that uses about a third of a naive transformer's parameters, scales to 384K context via YaRN extension, and reads two complementary caches through one unified softmax kernel. Every line of `layer_attention_raw_swa_one` is a step toward one of those objectives.

## 13.5. The MTP attention block

DS4 also implements a *Multi-Token Prediction* (MTP) module — a special extra block (`mtp.0.*` tensors, validated at `ds4.c:2449-2493`) that predicts a second token in parallel with the main next-token prediction. Its attention sublayer is structurally identical to a normal layer's: same HC pre, same low-rank Q, same KV with one head, same sink-aware softmax, same grouped output. The only differences are the weight tensor names (`mtp.0.attn_*` instead of `blk.N.attn_*`) and that the MTP block runs once at the end of the main 43-layer stack rather than being interleaved.

Because the math is identical, the MTP attention uses the same `layer_attention_*` functions, just with a different `ds4_layer_weights` pointer. This is one of the architectural wins of how the attention code is structured: the per-layer math is fully parameterized by a `layer_weights` struct, so any block that has the same weight schema can reuse it. The MTP block is one such block; future extensions (an extra deep MLP, a sidecar attention head, a draft model) could plug in the same way.

The MTP block's attention does *not* maintain its own KV cache. It is computed only on the final token of the main stack and only contributes to a separate logits head. So while the function signatures are shared with the regular layers, the MTP path runs only once per token and reads from a transient KV vector rather than from a persistent layer cache.

## 14. Pseudo-flow per token

To bring it all together as a single readable script — the attention sublayer for one decode token, one layer:

<svg viewBox="0 0 820 600" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Attention sublayer 10-step pipeline for one decode token"><defs><marker id="r81ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="410" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Attention sublayer — 10 steps, one decode token, one layer</text><rect x="40" y="40" width="740" height="36" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/><text x="410" y="58" text-anchor="middle" font-size="11" font-weight="700" fill="#0369a1">input: inp_hc (4 × 4096 HC streams) + pos + il + cache</text><text x="410" y="70" text-anchor="middle" font-size="10" fill="#075985">enters from the previous layer's FFN HC-post</text><line x1="410" y1="76" x2="410" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81ar)"/><rect x="40" y="88" width="360" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="50" y="106" font-size="11" font-weight="700" fill="#5b21b6">1. HC pre (Ch 09)</text><text x="50" y="120" font-size="10" fill="#5b21b6">flat → mix → sinkhorn split → attn_cur (4096)</text><rect x="420" y="88" width="360" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="430" y="106" font-size="11" font-weight="700" fill="#5b21b6">2. attention RMSNorm</text><text x="430" y="120" font-size="10" fill="#5b21b6">attn_norm = rms_norm_weight(attn_cur, layer.attn_norm)</text><line x1="220" y1="128" x2="220" y2="140" stroke="#94a3b8" stroke-width="1.2"/><line x1="600" y1="128" x2="600" y2="140" stroke="#94a3b8" stroke-width="1.2"/><line x1="220" y1="140" x2="600" y2="140" stroke="#94a3b8" stroke-width="1.2"/><line x1="220" y1="140" x2="220" y2="152" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81ar)"/><line x1="410" y1="140" x2="410" y2="152" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81ar)"/><line x1="600" y1="140" x2="600" y2="152" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81ar)"/><rect x="40" y="152" width="240" height="50" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="50" y="170" font-size="11" font-weight="700" fill="#9a3412">3. Q low-rank</text><text x="50" y="184" font-size="10" fill="#7c2d12">attn_q_a 4096→1024 · rms_norm</text><text x="50" y="196" font-size="10" fill="#7c2d12">attn_q_b 1024→32768 · per-head norm</text><rect x="290" y="152" width="240" height="50" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="300" y="170" font-size="11" font-weight="700" fill="#115e59">4. KV projection</text><text x="300" y="184" font-size="10" fill="#064e3b">attn_kv 4096→512 (one shared head)</text><text x="300" y="196" font-size="10" fill="#064e3b">+ rms_norm_weight(attn_kv_a_norm)</text><rect x="540" y="152" width="240" height="50" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="550" y="170" font-size="11" font-weight="700" fill="#92400e">5. RoPE tail</text><text x="550" y="184" font-size="10" fill="#78350f">rope_tail(q, 64 heads, pos, il)</text><text x="550" y="196" font-size="10" fill="#78350f">rope_tail(kv) · fp8_quantize_nope(kv)</text><line x1="160" y1="202" x2="160" y2="214" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81ar)"/><line x1="410" y1="202" x2="410" y2="214" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81ar)"/><line x1="660" y1="202" x2="660" y2="214" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81ar)"/><rect x="40" y="214" width="740" height="68" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="410" y="232" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">6. cache push (Ch 07)</text><text x="410" y="248" text-anchor="middle" font-size="10" fill="#7c2d12">push_raw(cache, kv) — append or slide the 128-row ring</text><text x="410" y="262" text-anchor="middle" font-size="10" fill="#7c2d12">if ratio != 0: compressor_decode_one(attn_*) and (ratio=4) indexer_compressor + indexer_allowed</text><text x="410" y="274" text-anchor="middle" font-size="10" fill="#7c2d12">→ produces comp_allowed mask for the mixed attention</text><line x1="410" y1="282" x2="410" y2="294" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81ar)"/><rect x="40" y="294" width="740" height="48" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="410" y="312" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">7. mixed attention with sink</text><text x="410" y="328" text-anchor="middle" font-size="10" fill="#5b21b6">ratio != 0: mixed_attention(q, sinks, raw_kv, attn_comp_kv, comp_allowed)</text><text x="410" y="338" text-anchor="middle" font-size="10" fill="#5b21b6">ratio == 0: rows_attention(q, sinks, raw_kv) → heads (64 × 512)</text><line x1="410" y1="342" x2="410" y2="354" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81ar)"/><rect x="40" y="354" width="360" height="40" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="50" y="372" font-size="11" font-weight="700" fill="#92400e">8. inverse RoPE on heads</text><text x="50" y="386" font-size="10" fill="#78350f">rope_tail(heads, 64 heads, pos, il, inverse=true)</text><rect x="420" y="354" width="360" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="430" y="372" font-size="11" font-weight="700" fill="#115e59">9. grouped low-rank output</text><text x="430" y="386" font-size="10" fill="#064e3b">8 × (heads→1024) · attn_output_b 8192→4096 + steering</text><line x1="220" y1="394" x2="220" y2="406" stroke="#94a3b8" stroke-width="1.2"/><line x1="600" y1="394" x2="600" y2="406" stroke="#94a3b8" stroke-width="1.2"/><line x1="220" y1="406" x2="600" y2="406" stroke="#94a3b8" stroke-width="1.2"/><line x1="410" y1="406" x2="410" y2="418" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81ar)"/><rect x="40" y="418" width="740" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="410" y="436" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">10. HC post (Ch 09)</text><text x="410" y="452" text-anchor="middle" font-size="10" fill="#5b21b6">after_attn_hc = hc_post(attn_out, attn_residual, split[4..7], split[8..23])</text><line x1="410" y1="462" x2="410" y2="474" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r81ar)"/><rect x="40" y="474" width="740" height="36" rx="6" fill="#bbf7d0" stroke="#16a34a" stroke-width="1.5"/><text x="410" y="492" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">output: after_attn_hc (4 × 4096) → FFN sublayer (Ch 09)</text><text x="410" y="504" text-anchor="middle" font-size="10" fill="#166534">cache rows committed for this token; sink-aware softmax has emitted the new heads</text><text x="40" y="540" font-size="10" fill="#64748b">side products: raw_kv slid by one row; attn_comp_kv / index_comp_kv each gain a row on ratio boundaries</text><text x="40" y="556" font-size="10" fill="#64748b">freq_base=160K and freq_scale=1/16 with YaRN extension on the RoPE tails of compressed layers</text></svg>
<span class="figure-caption">Figure R8.2 | The attention sublayer's 10-step pipeline for one decode token. HC pre and post wrap a low-rank Q/KV projection, RoPE-tail position encoding, cache push (raw + compressed + indexer), mixed sink-aware attention, inverse RoPE, and the grouped output projection.</span>

<details>
<summary>ASCII fallback</summary>

```
input:   inp_hc     (4 × 4096 floats, the HC residual streams)
         pos        (token position)
         il         (layer index, 0..42)
         cache      (this layer's ds4_layer_cache)

# Step 1: HC pre — Chapter 09
flat ← rms_norm_no_weight(inp_hc)
mix ← matvec_f16(hc_attn_fn, flat)              # 16384 → 24 mix lane
split ← sinkhorn(mix, scale, base, iters=20)    # pre weights, post gates, comb matrix
attn_cur ← weighted_sum(inp_hc, split[0..3])     # 4096 collapsed
save inp_hc as attn_residual

# Step 2: attention RMSNorm with learned scale
attn_norm ← rms_norm_weight(attn_cur, layer.attn_norm)

# Step 3: Q low-rank projection
qr ← matvec_q8_0(layer.attn_q_a, attn_norm)            # 4096 → 1024
qr_norm ← rms_norm_weight(qr, layer.attn_q_a_norm)
q ← matvec_q8_0(layer.attn_q_b, qr_norm)               # 1024 → 32768
per_head_rms_norm(q)                                    # normalize each of 64 heads

# Step 4: KV projection
kv_raw ← matvec_q8_0(layer.attn_kv, attn_norm)         # 4096 → 512
kv ← rms_norm_weight(kv_raw, layer.attn_kv_a_norm)

# Step 5: RoPE (compressed layers use freq_base=160K, freq_scale=1/16, YaRN ext)
rope_tail(q,  64 heads, pos, il, inverse=false)
rope_tail(kv,  1 head,  pos, il, inverse=false)
fp8_quantize_nope(kv)                                   # CPU mirrors GPU storage

# Step 6: cache push (Chapter 07)
push_raw(cache, kv)                                     # appends or slides
if cache.compress_ratio != 0:
    comp ← compressor_decode_one(attn_compressor_*, attn_norm, pos)
    if comp emitted:
        push_comp(cache.attn_comp_kv, comp)
    if cache.compress_ratio == 4:
        idx_comp ← compressor_decode_one(indexer_compressor_*, attn_norm, pos)
        if idx_comp emitted:
            push_comp(cache.index_comp_kv, idx_comp)
        comp_allowed ← indexer_allowed_decode_one(attn_norm, qr_norm, cache.index_comp_kv)

# Step 7: mixed attention with sink
if cache.compress_ratio != 0:
    heads ← mixed_attention(q, sinks, cache.raw_kv, cache.attn_comp_kv, comp_allowed)
else:
    heads ← rows_attention(q, sinks, cache.raw_kv)

# Step 8: inverse RoPE, undo position info on the value side
rope_tail(heads, 64 heads, pos, il, inverse=true)

# Step 9: grouped low-rank output
for g in 0..7:
    low[g] ← matvec_q8_0(attn_output_a[g], heads[g*8:(g+1)*8])    # 4096 → 1024
attn_out ← matvec_q8_0(attn_output_b, concat(low))                # 8192 → 4096
directional_steering_project(attn_out, il, steering_dirs)

# Step 10: HC post — Chapter 09
after_attn_hc ← hc_post(attn_out, attn_residual, split[4..7], split[8..23])

output: after_attn_hc (4 × 4096), passed to FFN sublayer (Chapter 09)
```

</details>

That is one "attention half" of one transformer block. The FFN half follows the same outer wrapping (HC pre → sublayer → HC post) with different inner work (RMSNorm, MoE router, IQ2_XXS expert matmuls, Q2_K down, shared Q8_0 SwiGLU, sum, HC post). The whole transformer block — attention half plus FFN half — is what Chapter 09 covers.

Chapter 09 picks up the other half of each transformer layer: the FFN, the MoE routing of 256 experts, the four-stream hyper-connection residual carrier that wraps both attention and FFN, and the Sinkhorn balancing that makes HC stable across 43 layers of mixing.
