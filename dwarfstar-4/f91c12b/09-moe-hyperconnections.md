# Chapter 09: MoE, Hyper-Connection, and FFN

> Code version locked to `dwarfstar/ds4@f91c12b` (DwarfStar 4 inference engine for DeepSeek V4 Flash). All `file:line` refs are repo-root-relative paths at this commit.

## 0. The problem this chapter solves

Chapter 08 explained the attention sublayer, but a full transformer layer is *attention + FFN*. In DS4 the FFN half is where the bulk of the model's parameters live, and where DeepSeek V4 Flash's architectural choices diverge most from a textbook transformer:

1. **256 routed experts per layer, top-6 per token**: each layer's FFN is a Mixture-of-Experts (MoE) with `DS4_N_EXPERT = 256` candidate experts (`ds4.c:99`); each token selects `DS4_N_EXPERT_USED = 6` of them (`ds4.c:100`).
2. **Hash-mode routing for the first 3 layers**: layers 0, 1, 2 (where `il < DS4_N_HASH_LAYER = 3`, `ds4.c:103`) bypass the learned router entirely and look up expert indices by token id (`ds4.c:5252-5269`).
3. **Asymmetric expert quantization**: gate and up matrices are IQ2_XXS (~2 bits/weight); the down matrix is Q2_K (also low-bit but with per-block scaling). The shared expert is Q8_0 (high precision) (`ds4.c:5382-5429`).
4. **One always-on shared expert** alongside the routed experts (`ds4.c:5129-5161`).
5. **Hyper-connection (HC) residual carrier**: 4 parallel residual streams per token (`DS4_N_HC = 4`, `ds4.c:114`), collapsed to one before each sublayer (attention and FFN both) and fanned back out after. The collapse and fan-out use learned weights stabilized by **20 iterations of Sinkhorn doubly-stochastic balancing** (`DS4_N_HC_SINKHORN_ITER = 20`, `ds4.c:115`).
6. **SwiGLU with clamp**: the gate/up product is clamped to ±10 before silu, to contain the dynamic range of the IQ2_XXS quantization noise (`DS4_SWIGLU_CLAMP_EXP = 10.0`, `ds4.c:56`).
7. **Biased top-K selection but unbiased weighting**: the router's selection includes a learned per-expert bias for load balancing; the weights applied to expert outputs use the unbiased softplus probabilities (`ds4.c:5350-5376`).

The chapter walks these in the order one token's FFN sublayer touches them — HC pre → FFN RMSNorm → router → routed MoE → shared expert → sum → HC post — then closes with how HC interacts across layers to make a 43-block residual stream stable.

<svg viewBox="0 0 760 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="FFN sublayer and HC wrapping flow"><defs><marker id="r91ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">layer_ffn_one (ds4.c:5680-5782) — FFN sublayer with HC wrapping</text><rect x="260" y="40" width="240" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="380" y="60" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">inp_hc (4 streams × 4096)</text><line x1="380" y1="72" x2="380" y2="90" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r91ar)"/><rect x="220" y="90" width="320" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/><text x="380" y="108" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">hc_pre_from_state_one (FFN weights)</text><text x="380" y="122" text-anchor="middle" font-size="10" fill="#64748b">flat → mix → sinkhorn split → ffn_cur + post + comb</text><line x1="380" y1="130" x2="380" y2="148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r91ar)"/><rect x="220" y="148" width="320" height="28" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="380" y="166" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">FFN RMSNorm → norm (4096)</text><line x1="380" y1="176" x2="380" y2="196" stroke="#94a3b8" stroke-width="1.2"/><line x1="200" y1="196" x2="560" y2="196" stroke="#94a3b8" stroke-width="1.2"/><line x1="200" y1="196" x2="200" y2="218" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r91ar)"/><line x1="560" y1="196" x2="560" y2="218" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r91ar)"/><rect x="40" y="218" width="320" height="100" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="200" y="238" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">layer_routed_moe_one (256 experts, top-6)</text><text x="200" y="254" text-anchor="middle" font-size="10" fill="#7c2d12">layers 0,1,2: hash route (ffn_gate_tid2eid)</text><text x="200" y="268" text-anchor="middle" font-size="10" fill="#7c2d12">layers 3..42: biased top-K of softplus probs</text><text x="200" y="284" text-anchor="middle" font-size="10" fill="#7c2d12">IQ2_XXS gate/up · clamp · silu · weight</text><text x="200" y="298" text-anchor="middle" font-size="10" fill="#7c2d12">Q2_K down · accumulate → moe (4096)</text><text x="200" y="312" text-anchor="middle" font-size="10" fill="#7c2d12">weights × DS4_EXPERT_WEIGHT_SCALE (1.5)</text><rect x="400" y="218" width="320" height="100" rx="6" fill="#bbf7d0" stroke="#16a34a" stroke-width="1.5"/><text x="560" y="238" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">layer_shared_ffn_one (Q8_0 SwiGLU)</text><text x="560" y="254" text-anchor="middle" font-size="10" fill="#14532d">always-on, 1 shared expert per layer</text><text x="560" y="268" text-anchor="middle" font-size="10" fill="#14532d">Q8_0 fused gate+up matmul</text><text x="560" y="282" text-anchor="middle" font-size="10" fill="#14532d">SwiGLU with same clamp=10</text><text x="560" y="298" text-anchor="middle" font-size="10" fill="#14532d">Q8_0 down → shared (4096)</text><line x1="200" y1="318" x2="380" y2="346" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r91ar)"/><line x1="560" y1="318" x2="380" y2="346" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r91ar)"/><rect x="220" y="346" width="320" height="32" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="380" y="366" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">ffn_out = moe + shared (4096)</text><line x1="380" y1="378" x2="380" y2="396" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r91ar)"/><rect x="220" y="396" width="320" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/><text x="380" y="414" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">hc_post_one</text><text x="380" y="428" text-anchor="middle" font-size="10" fill="#64748b">block_out × post + comb × residual_hc → out_hc</text><line x1="380" y1="436" x2="380" y2="454" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r91ar)"/><rect x="260" y="454" width="240" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="380" y="474" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">out_hc (4 streams × 4096)</text></svg>
<span class="figure-caption">Figure R9.1 | FFN sublayer with HC wrapping. The routed MoE and the shared expert run in parallel on the same normalized input and their outputs sum before HC post-expansion. HC pre and HC post are the only places the 4-stream residual carrier interacts with the per-token math.</span>

## 1. Hyper-connection: 4 parallel residual streams

DS4 replaces the classical transformer's single residual stream with **four parallel streams**. Each token carries 4 × 4096 = 16384 floats of residual state through the layers; before each sublayer those streams collapse into a single 4096-wide vector ("HC pre"), and after the sublayer the result is fanned back out to 4 streams ("HC post").

The motivation, in one sentence: in a standard transformer, residual addition is a scalar `x ← x + sublayer(x)` operation. Every sublayer competes for "residual bandwidth" — adding too much overwrites information from earlier layers; adding too little wastes the sublayer's representational capacity. Hyper-connection gives the network 4 parallel "lanes" so different aspects of a token's representation can flow forward independently, with per-sublayer learned mixing.

The HC state is initialized from the input embedding by broadcasting (`ds4.c:4450-4455`):

```c
// ds4.c:4450-4455
static void hc_from_plain_embedding(float *out_hc, const float *x, uint32_t n_embd, uint32_t n_hc) {
    for (uint32_t h = 0; h < n_hc; h++) {
        memcpy(out_hc + (uint64_t)h * n_embd, x, (size_t)n_embd * sizeof(x[0]));
    }
}
```

All 4 streams start equal to the token embedding. Through the layers, they diverge: each sublayer's HC pre reads all 4 streams and produces a learned-weighted collapse; the sublayer runs; HC post re-expands into 4 streams using *different* learned weights, so the streams now differ.

The collapse step is the load-bearing piece. It runs `hc_pre_from_state_one_scratch` (`ds4.c:4377-4408`):

```c
// ds4.c:4377-4408 (abridged)
static void hc_pre_from_state_one_scratch(
        const ds4_model   * model,
        const ds4_tensor  * fn,
        const ds4_tensor  * scale_tensor,
        const ds4_tensor  * base_tensor,
        const float       * residual_hc,
        float             * out,
        float             * post,
        float             * comb,
        float             * flat,
        bool                serial_fn) {
    const uint32_t n_hc = DS4_N_HC;
    const uint64_t hc_dim = (uint64_t)DS4_N_EMBD * n_hc;

    float mix[24];
    float split[24];

    rms_norm_no_weight(flat, residual_hc, hc_dim, DS4_RMS_EPS);
    if (serial_fn) {
        matvec_f16_serial(mix, model, fn, flat);
    } else {
        matvec_f16(mix, model, fn, flat);
    }

    const float *scale = tensor_data(model, scale_tensor);
    const float *base = tensor_data(model, base_tensor);
    hc_split_sinkhorn_one(split, mix, scale, base, (int)n_hc, DS4_N_HC_SINKHORN_ITER, 1.0e-6f);
    hc_weighted_sum_one(out, residual_hc, split, DS4_N_EMBD, n_hc);

    memcpy(post, split + n_hc, n_hc * sizeof(post[0]));
    memcpy(comb, split + 2 * n_hc, n_hc * n_hc * sizeof(comb[0]));
}
```

The 24-float `mix` vector is laid out as:

- `mix[0..3]` — raw pre-weight logits (one per HC stream).
- `mix[4..7]` — raw post-gate logits (one per HC stream).
- `mix[8..23]` — raw combine matrix (4×4, row=dst, col=src).

The matmul `fn` (named `hc_attn_fn` or `hc_ffn_fn` depending on which sublayer's HC pre we are running) is an F16 matrix of shape `[hc_dim, hc_mix_dim] = [16384, 24]` (`ds4.c:2410-2411`). It projects the flattened 4-stream residual to the 24-float mix vector. The norm is `rms_norm_no_weight` (no learned scale) because the mix output is going to feed a Sinkhorn normalization that itself enforces a scale.

Then `hc_split_sinkhorn_one` (`ds4.c:4279-4356`) decodes the 24 floats into:

- `split[0..3]` — pre weights: `sigmoid(mix[i] * scale[0] + base[i]) + eps`. These are the weights used to collapse the 4 streams into one.
- `split[4..7]` — post gates: `2 * sigmoid(mix[4+i] * scale[1] + base[4+i])`. Range `(0, 2)`. These multiply the sublayer output when it's fanned back out.
- `split[8..23]` — combine matrix: a 4×4 row-and-column normalized doubly-stochastic matrix produced by **20 iterations of Sinkhorn balancing** starting from `mix[8..23] * scale[2] + base[8..23]`.

The combine matrix is the most subtle piece. Let's look at it.

## 2. The Sinkhorn balancing

```c
// ds4.c:4279-4356 (Sinkhorn portion)
float c[16 * 16];

for (int dst = 0; dst < n_hc; dst++) {
    float row_max = DS4_NEG_INF;
    for (int src = 0; src < n_hc; src++) {
        const int idx = src + dst * n_hc;
        const int off = 2 * n_hc + idx;
        const float v = mix[off] * comb_scale + base[off];
        c[idx] = v;
        if (v > row_max) row_max = v;
    }

    float row_sum = 0.0f;
    for (int src = 0; src < n_hc; src++) {
        const int idx = src + dst * n_hc;
        const float v = expf(c[idx] - row_max);
        c[idx] = v;
        row_sum += v;
    }

    const float inv = 1.0f / row_sum;
    for (int src = 0; src < n_hc; src++) {
        const int idx = src + dst * n_hc;
        c[idx] = c[idx] * inv + eps;
    }
}

/* Column normalize once: */
for (int src = 0; src < n_hc; src++) {
    float sum = 0.0f;
    for (int dst = 0; dst < n_hc; dst++) sum += c[src + dst * n_hc];
    const float inv = 1.0f / (sum + eps);
    for (int dst = 0; dst < n_hc; dst++) c[src + dst * n_hc] *= inv;
}

/* Then iterate row+column normalization 19 more times: */
for (int iter = 1; iter < iters; iter++) {
    for (int dst = 0; dst < n_hc; dst++) {
        float sum = 0.0f;
        for (int src = 0; src < n_hc; src++) sum += c[src + dst * n_hc];
        const float inv = 1.0f / (sum + eps);
        for (int src = 0; src < n_hc; src++) c[src + dst * n_hc] *= inv;
    }
    for (int src = 0; src < n_hc; src++) {
        float sum = 0.0f;
        for (int dst = 0; dst < n_hc; dst++) sum += c[src + dst * n_hc];
        const float inv = 1.0f / (sum + eps);
        for (int dst = 0; dst < n_hc; dst++) c[src + dst * n_hc] *= inv;
    }
}
```

The algorithm: take the 4×4 matrix of raw logits, apply softmax per row (rows sum to 1), then alternately normalize columns (columns sum to 1) and rows (rows sum to 1) for 20 iterations total. After 20 iterations the matrix is a **doubly-stochastic matrix** — all rows and all columns sum to 1.

Why? Because the combine matrix in HC post (§4) determines how each new stream `dst` is built from a linear combination of the old streams `src`. If the matrix is doubly stochastic:

- Each *destination* stream is a probability mixture over source streams (rows sum to 1 — "where does dst-stream-h's content come from?").
- Each *source* stream is fully distributed across destination streams (columns sum to 1 — "where does src-stream-h's content go?").

A non-stochastic matrix could let one stream's information leak into all 4 destinations (column sum > 1, amplification) or vanish (column sum < 1, dilution). The Sinkhorn iteration enforces both bounds, making the residual flow conservative: information is neither created nor destroyed by the HC mixing step.

20 iterations is the value the model was trained with. Fewer would not fully balance the matrix; more would not improve much past convergence. `DS4_N_HC_SINKHORN_ITER` is a hardcoded constant (`ds4.c:115`) for the same reason as `DS4_N_INDEXER_TOP_K = 512` — it is a model property, not a tuning knob.

## 3. The collapse and the per-stream contributions

After Sinkhorn, the pre weights are sigmoids (range `(0, 1)`) and the combine matrix is doubly-stochastic. The collapse step `hc_weighted_sum_one` (`ds4.c:4360-4373`) is straightforward:

```c
// ds4.c:4360-4373
static void hc_weighted_sum_one(
        float       * out,
        const float * x,
        const float * weights,
        uint32_t      n_embd,
        uint32_t      n_hc) {
    for (uint32_t d = 0; d < n_embd; d++) {
        float acc = 0.0f;
        for (uint32_t h = 0; h < n_hc; h++) {
            acc += x[(uint64_t)h * n_embd + d] * weights[h];
        }
        out[d] = acc;
    }
}
```

For each of the 4096 output dimensions, sum the 4 streams weighted by `split[0..3]` (pre weights). The result is a single 4096-wide vector — the sublayer input.

Note that the pre weights are *not* required to sum to 1. They are independent sigmoids. So the collapsed output's magnitude depends on how many streams are "active" (sigmoid near 1) vs "muted" (sigmoid near 0). The downstream RMSNorm absorbs the magnitude difference, so this is fine — the network can learn to use fewer streams without breaking the math.

## 4. The expansion: HC post

After the sublayer produces its 4096-wide output `block_out`, HC post fans it back to 4 streams (`hc_post_one`, `ds4.c:4459-4479`):

```c
// ds4.c:4459-4479
static void hc_post_one(
        float       * out_hc,
        const float * block_out,
        const float * residual_hc,
        const float * post,
        const float * comb,
        uint32_t      n_embd,
        uint32_t      n_hc) {
    for (uint32_t dst = 0; dst < n_hc; dst++) {
        for (uint32_t d = 0; d < n_embd; d++) {
            float acc = block_out[d] * post[dst];

            for (uint32_t src = 0; src < n_hc; src++) {
                /* The HC combine matrix is addressed as [dst_hc, src_hc]. */
                acc += comb[dst + src * n_hc] * residual_hc[(uint64_t)src * n_embd + d];
            }

            out_hc[(uint64_t)dst * n_embd + d] = acc;
        }
    }
}
```

For each destination stream `dst`:

1. Start with `block_out * post[dst]` — the sublayer's output scaled by the destination stream's post gate.
2. Add `comb[dst, src] * residual_hc[src]` summed over all source streams — the doubly-stochastic mixing of the old streams.

The combine matrix's column-stochasticity ensures the residual content's magnitude is preserved across the mixing. The post gates can amplify or attenuate the sublayer's contribution to each destination stream independently (since they are 2× sigmoid, range `(0, 2)`, so a stream can receive up to 2× the sublayer output if the post gate is fully activated).

Two architectural observations:

- The same `block_out` lands in all 4 streams, weighted differently. So if the sublayer produced a useful contribution, *every* stream gets some share. No stream is "skipped" for this sublayer's output.
- The residual mixing is a **linear combination of the input streams**. So the output streams are still linear functions of the input streams — HC does not introduce non-linearity beyond the sublayer itself.

The batched version `hc_post_batch` (`ds4.c:4481-4540`) does the same math for `n_tok` tokens in parallel via `ds4_parallel_for`. The batch worker (line 4492) handles one token at a time per thread, with the four-stream loop unrolled inside.

## 5. Two RMSNorms, one purpose

DS4 uses *two* RMSNorm variants, and the choice between them is consistent with HC's design:

- **`rms_norm_no_weight`** (`ds4.c:2793-2799`): no learned scale. Used by HC control vectors (the flatten step before `hc_attn_fn`/`hc_ffn_fn` projection) and by the final HC head collapse (`output_hc_head_one`, `ds4.c:8029-8054`). Why no scale? Because the next step is a small projection (`fn`) plus a Sinkhorn / sigmoid path — the scale would be a redundant degree of freedom that the network can absorb into the projection weights.
- **`rms_norm_weight`** (`ds4.c:2802-2808`): per-channel learned scale. Used by all sublayer RMSNorms (attention RMSNorm, FFN RMSNorm, KV norm, compressor output norm). Why with scale? Because the next step is a *large* linear projection — letting each channel learn an independent scale gives the projection more representational capacity.

The third norm variant, `head_rms_norm_inplace` (`ds4.c:2811-2820`), is the per-head L2 normalization on Q vectors discussed in Chapter 08. Three RMSNorm flavors, each used in exactly one role.

## 6. Routing: hash mode vs. learned

The router decides which 6 of 256 experts a token visits. DS4 has two routing modes — the picked mode depends on the layer:

```c
// ds4.c:5408-5413 (from layer_routed_moe_one)
if (layer->ffn_gate_tid2eid) {
    layer_hash_selected_experts(selected, model, layer, token);
    layer_hash_router_weights_one(expert_weight, model, layer, x, selected);
} else {
    layer_topk_selected_experts(selected, expert_weight, model, layer, x);
}
```

The choice is based on whether the layer has the `ffn_gate_tid2eid` tensor. The weight binder enforces this only for `il < DS4_N_HASH_LAYER = 3` (`ds4.c:2443-2445`):

```c
// ds4.c:2443-2445
if (il < DS4_N_HASH_LAYER) {
    tensor_expect_layout(l->ffn_gate_tid2eid, DS4_TENSOR_I32, 2, DS4_N_EXPERT_USED, DS4_N_VOCAB, 0);
}
```

So **layers 0, 1, 2** use hash routing; **layers 3 through 42** use learned routing.

### Hash routing

`layer_hash_selected_experts` (`ds4.c:5252-5269`) is a token-id lookup:

```c
// ds4.c:5252-5269
static void layer_hash_selected_experts(
        int                    selected[DS4_N_EXPERT_USED],
        const ds4_model       *model,
        const ds4_layer_weights *layer,
        int                    token) {
    ds4_tensor *t = layer->ffn_gate_tid2eid;
    if (!t) ds4_die("hash routing table is missing for this layer");
    if (t->type != 26 || t->ndim != 2 || t->dim[0] != DS4_N_EXPERT_USED) {
        ds4_die("ffn_gate_tid2eid.weight has an unexpected layout");
    }
    if (token < 0 || (uint64_t)token >= t->dim[1]) {
        ds4_die("token id is outside the hash routing table");
    }

    const int32_t *table = tensor_data(model, t);
    const int32_t *row = table + (uint64_t)token * DS4_N_EXPERT_USED;
    for (int i = 0; i < DS4_N_EXPERT_USED; i++) selected[i] = row[i];
}
```

The `ffn_gate_tid2eid` tensor is shape `[6, 129280]` of int32 — for each of the 129280 vocab tokens, a fixed list of 6 expert indices. The router does *nothing*; it reads the table.

Why? Because at the very first layers, the token embeddings have not yet been transformed enough for content-based routing to produce useful signal. The model was trained with a hash-routed assignment so that experts in early layers learn token-specific patterns directly from token id. By layer 3 the embeddings have been refined enough for learned routing to be useful.

The expert *weights* for hash-routed layers still come from the learned router (`layer_hash_router_weights_one`, `ds4.c:5303-5313`). The router computes softplus probabilities, looks up the 6 hash-selected experts in those probabilities, and normalizes the weights. So the router's output magnitudes are still meaningful even when its choice is overridden.

### Learned routing

For layers 3 onward, `layer_topk_selected_experts` runs (`ds4.c:5338-5347`):

```c
// ds4.c:5338-5347
static void layer_topk_selected_experts(
        int                    selected[DS4_N_EXPERT_USED],
        float                  expert_weight[DS4_N_EXPERT_USED],
        const ds4_model       *model,
        const ds4_layer_weights *layer,
        const float           *x) {
    float probs[DS4_N_EXPERT];

    layer_router_probs_one(probs, model, layer, x);
    layer_topk_selected_experts_from_probs(selected, expert_weight, model, layer, probs);
}
```

The router proper is `layer_router_probs_one` (`ds4.c:5273-5284`):

```c
// ds4.c:5273-5284
static void layer_router_probs_one(
        float             probs[DS4_N_EXPERT],
        const ds4_model   * model,
        const ds4_layer_weights * layer,
        const float       * x) {
    float logits[DS4_N_EXPERT];

    matvec_f16(logits, model, layer->ffn_gate_inp, x);
    for (int i = 0; i < DS4_N_EXPERT; i++) {
        probs[i] = sqrtf(softplus_stable(logits[i]));
    }
}
```

The router weight `ffn_gate_inp` is F16, shape `[4096, 256]` (`ds4.c:2419`). It projects the normalized hidden state to 256 raw logits. The activation is **`sqrt(softplus(x))`** — `softplus(x) = log(1 + exp(x))` — not the usual softmax. Two consequences:

- Each expert's probability is independent of the others; no normalization across experts. The router is not picking "one of 256"; it is scoring each expert independently.
- `sqrt(softplus(x))` is monotonic, smooth, and always non-negative, but it does not sum to 1 across experts. The resulting `probs` array is just a vector of expert scores.

The actual top-K with a load-balancing twist is `layer_topk_selected_experts_from_probs` (`ds4.c:5350-5376`):

```c
// ds4.c:5350-5376
static void layer_topk_selected_experts_from_probs(
        int                    selected[DS4_N_EXPERT_USED],
        float                  expert_weight[DS4_N_EXPERT_USED],
        const ds4_model       *model,
        const ds4_layer_weights *layer,
        const float           probs[DS4_N_EXPERT]) {
    float selection[DS4_N_EXPERT];

    memcpy(selection, probs, sizeof(selection));

    if (layer->ffn_exp_probs_b) {
        const float *bias = tensor_data(model, layer->ffn_exp_probs_b);
        for (int i = 0; i < DS4_N_EXPERT; i++) selection[i] += bias[i];
    }

    topk_desc(selection, DS4_N_EXPERT, DS4_N_EXPERT_USED, selected);

    float sum = 0.0f;
    for (int i = 0; i < DS4_N_EXPERT_USED; i++) {
        expert_weight[i] = probs[selected[i]];
        sum += expert_weight[i];
    }
    if (sum < 6.103515625e-5f) sum = 6.103515625e-5f;
    for (int i = 0; i < DS4_N_EXPERT_USED; i++) {
        expert_weight[i] = expert_weight[i] / sum * DS4_EXPERT_WEIGHT_SCALE;
    }
}
```

Two passes:

1. **Selection**: copy `probs` to `selection`, add per-expert bias `ffn_exp_probs_b` (a learned 256-float vector at `ds4.c:2421`), and select top-6 indices by descending value.
2. **Weighting**: gather the *unbiased* `probs` values at the selected indices, normalize them so they sum to 1, then multiply by `DS4_EXPERT_WEIGHT_SCALE = 1.5` (`ds4.c:55`).

The bias is added only for selection. The weights use unbiased probs. This is the load-balancing trick: the bias `ffn_exp_probs_b` is trained to push under-utilized experts above the top-K cutoff (so they get more traffic), but the weighting still reflects the model's "true" preference. An expert promoted by bias does not get an inflated weight — it just gets the chance to contribute. Once it contributes, the model can train its weights based on the unbiased preference.

The `DS4_EXPERT_WEIGHT_SCALE = 1.5` global multiplier means the 6 expert weights sum to 1.5, not 1. The extra `0.5` is to keep the routed MoE's overall contribution on a comparable scale to the shared expert's output, which has no normalization. With this scaling, when the routed MoE's `moe` and the shared expert's `shared` are summed (`ds4.c:5747-5749`), both are at a similar magnitude and neither dominates.

The `topk_desc` helper (`ds4.c:5315-5327`) is a naive O(n × k) sort that walks all 256 scores k=6 times. At 256 entries this is faster than a heap; the constant factor is tiny.

## 7. Routed expert math: IQ2_XXS gate/up plus Q2_K down

Once the 6 experts are selected and weighted, `layer_routed_moe_one` (`ds4.c:5382-5476`) runs the actual expert math. The non-trace branch is the production path:

```c
// ds4.c:5415-5429 (the non-trace branch)
if (!trace) {
    matvec_iq2_xxs_experts_mid_prequant(mid_all, model,
                                        layer->ffn_gate_exps,
                                        layer->ffn_up_exps,
                                        xq,
                                        selected,
                                        expert_weight,
                                        DS4_N_EXPERT_USED,
                                        clamp);
    for (int i = 0; i < DS4_N_EXPERT_USED; i++) {
        ds4_quantize_row_q8_K(mid_all + (uint64_t)i * down_in_dim,
                              midq + (uint64_t)i * (down_in_dim / QK_K),
                              (int64_t)down_in_dim);
    }
    matvec_q2_k_experts_accum_prequant(out, model, layer->ffn_down_exps, midq, selected, DS4_N_EXPERT_USED);
}
```

Three phases:

**1. Activation quantization once.** Before any expert runs, the 4096-wide input `x` is quantized to Q8_K blocks once (`ds4.c:5406`):

```c
ds4_quantize_row_q8_K(x, xq, (int64_t)expert_in_dim);
```

The same `xq` block array (4096 / 256 = 16 Q8_K blocks) is reused by every selected expert. This is essential — quantizing the activation 6 times would dominate the cost.

**2. Fused gate/up for all 6 experts.** `matvec_iq2_xxs_experts_mid_prequant` (`ds4.c:3938-...`) takes all 6 selected experts and produces their `mid = silu(clamp(gate)) * clamp(up) * expert_weight` vectors in one parallel sweep. The "fused" part: for each expert, gate and up share the same input activation, so the kernel reads each IQ2_XXS expert's gate weight and up weight together. The clamp is `DS4_SWIGLU_CLAMP_EXP = 10.0`; values are clipped to `[-10, +10]` for the up matrix and `[None, +10]` for gate (gate is silu-applied so its negative tail is bounded by silu's saturation).

The output `mid_all` is shape `[6, 2048]` — one mid vector per selected expert.

**3. Mid quantization and accumulated down projection.** Each of the 6 mid vectors is quantized to Q8_K, then `matvec_q2_k_experts_accum_prequant` (`ds4.c:4055-...`) accumulates `down_expert_i(mid_i)` for all 6 experts into the output. Q2_K is a higher-precision low-bit format than IQ2_XXS (it has per-block scales and minimums); this asymmetry between gate/up (IQ2_XXS) and down (Q2_K) is a quality-tuned compromise — DeepSeek V4 found that down sensitivity is higher than gate/up sensitivity, so down gets the more accurate format.

The accumulator pattern (`matvec_q2_k_experts_accum_prequant`) reads each *row* of the down matrix once per output dim, summing the contributions of all 6 selected experts' down weights. This is the right traffic pattern: for `down_in_dim = 2048` and `out_dim = 4096`, each output row visits 6 expert rows × 2048 dims × Q2_K = small number of bytes. The activations (`midq`) are read 6 times — once per expert — but they are tiny compared to the weights.

The result `out` is the routed MoE's contribution, a 4096-wide vector. Expert weights are already absorbed into `mid_all` via `silu(gate) * up * expert_weight[slot]` (this is what the `clamp + weights` parameter to `matvec_iq2_xxs_experts_mid_prequant` controls).

## 8. The clamp on SwiGLU: why 10

`DS4_SWIGLU_CLAMP_EXP = 10.0` (`ds4.c:56`). The standalone `swiglu` function (`ds4.c:5115-5126`) shows what the clamp does:

```c
// ds4.c:5115-5126
static void swiglu(float *out, const float *gate, const float *up, uint64_t n, float clamp) {
    for (uint64_t i = 0; i < n; i++) {
        float g = gate[i];
        float u = up[i];
        if (clamp > 1.0e-6f) {
            if (g > clamp) g = clamp;
            if (u > clamp) u = clamp;
            if (u < -clamp) u = -clamp;
        }
        out[i] = silu(g) * u;
    }
}
```

The clamp affects three boundaries: `gate <= 10`, `up <= 10`, `up >= -10`. The gate has no lower clamp because `silu(x)` for `x < 0` is bounded between -0.279 and 0 — no runaway. The up matrix is clipped on both sides because it gets multiplied by `silu(g)`; if `up` were `1e6`, the product would be `~1e6` no matter what `g` is.

Why `10`? It is the value tuned for IQ2_XXS quantization. IQ2_XXS uses ~2 bits per weight, so each cell encodes one of 4 quantization codes. A single quantization error in the weight can shift the dot product by a substantial amount when the activation is large; clamping the activation at 10 bounds the worst-case error. The validator at boot (`validate_swiglu_clamp_metadata`, `ds4.c:2531-2553`) checks that the GGUF declares the same clamp value for every layer.

The same clamp is passed to the shared expert (`layer_shared_ffn_one`, line 5153, with `DS4_SWIGLU_CLAMP_EXP`). For Q8_0 quantization the clamp is essentially never hit (Q8_0 noise is much smaller than the activation magnitudes), but passing the same value keeps the math uniform across routed and shared experts.

## 9. The shared expert

Every token visits the shared expert in addition to its 6 routed experts. `layer_shared_ffn_one` (`ds4.c:5129-5161`):

```c
// ds4.c:5129-5161
static void layer_shared_ffn_one(
        float             * out,
        const ds4_model   * model,
        const ds4_layer_weights * layer,
        const float       * x) {
    float *gate = xmalloc((size_t)DS4_N_FF_EXP * sizeof(gate[0]));
    float *up = xmalloc((size_t)DS4_N_FF_EXP * sizeof(up[0]));
    float *mid = xmalloc((size_t)DS4_N_FF_EXP * sizeof(mid[0]));
    const uint64_t in_dim = layer->ffn_gate_shexp->dim[0];
    const uint64_t blocks = (in_dim + 31) / 32;
    int8_t *xq = xmalloc((size_t)blocks * 32);
    float *xscale = xmalloc((size_t)blocks * sizeof(xscale[0]));

    if (layer->ffn_up_shexp->type != 8 ||
        layer->ffn_gate_shexp->type != 8 ||
        layer->ffn_up_shexp->dim[0] != in_dim) {
        ds4_die("shared expert gate/up tensors do not share a Q8_0 input layout");
    }

    quantize_q8_0_activation(x, xq, xscale, in_dim);
    matvec_q8_0_pair_prequant(gate, up, model,
                              layer->ffn_gate_shexp,
                              layer->ffn_up_shexp,
                              xq, xscale);
    swiglu(mid, gate, up, DS4_N_FF_EXP, DS4_SWIGLU_CLAMP_EXP);
    matvec_q8_0(out, model, layer->ffn_down_shexp, mid);
    /* free locals */
}
```

The shared expert is a regular SwiGLU MLP with three Q8_0 matrices:

- `ffn_gate_shexp` and `ffn_up_shexp`: Q8_0, both `[4096, 2048]` (`ds4.c:2440-2441`).
- `ffn_down_shexp`: Q8_0, `[2048, 4096]` (`ds4.c:2442`).

`DS4_N_FF_EXP = 2048` (`ds4.c:102`) is the same hidden dim as the routed experts. The shared expert has roughly the same parameter count as one routed expert — about 25M weights per layer.

The fused `matvec_q8_0_pair_prequant` computes gate and up in one pass over the (pre-quantized) activation, halving the memory bandwidth. After SwiGLU produces the mid vector, the down projection produces the shared output.

The shared expert's purpose: provide a baseline "always-on" transformation that the network can rely on regardless of routing. Routed experts learn specialized patterns; the shared expert learns the common transformations every token needs. Combined: `ffn_out = moe + shared` (`ds4.c:5747-5749`). No gating between them — both contributions are direct sums.

The choice of Q8_0 (much higher precision than IQ2_XXS) for the shared expert is intentional: a single shared expert is consulted by *every* token, so noise in its weights propagates broadly. IQ2_XXS noise is acceptable when averaged over 6 of 256 experts (the routed MoE); Q8_0 keeps the shared expert reliable.

## 10. Putting the FFN together

`layer_ffn_one` (`ds4.c:5680-5782`) wraps the FFN sublayer with HC:

```c
// ds4.c:5705-5757 (abridged structure)
hc_pre_from_state_one(model,
                      layer->hc_ffn_fn,
                      layer->hc_ffn_scale,
                      layer->hc_ffn_base,
                      inp_hc, ffn_cur, post, comb);

const float *ffn_norm = tensor_data(model, layer->ffn_norm);
rms_norm_weight(norm, ffn_cur, ffn_norm, DS4_N_EMBD, DS4_RMS_EPS);

layer_routed_moe_one(moe, model, layer, norm, il, token, DS4_SWIGLU_CLAMP_EXP, trace);
layer_shared_ffn_one(shared, model, layer, norm);

for (uint32_t i = 0; i < DS4_N_EMBD; i++) {
    ffn_out[i] = moe[i] + shared[i];
}
cpu_directional_steering_project_rows(ffn_out, steering_dirs, il, 1, steering_scale);

hc_post_one(out_hc, ffn_out, inp_hc, post, comb, DS4_N_EMBD, n_hc);
```

Five steps:

1. HC pre using `hc_ffn_fn` / `hc_ffn_scale` / `hc_ffn_base` (a *different* set of HC weights than the attention sublayer's `hc_attn_fn` family — each sublayer has its own collapse projection).
2. FFN RMSNorm with learned scale `ffn_norm`.
3. Routed MoE and shared expert run in parallel on the *same* normalized input. They are independent — neither depends on the other's output. On a multi-threaded CPU or a GPU the two can run concurrently. (DS4 does not explicitly schedule them in parallel on CPU but the math allows it.)
4. Sum the two contributions. Optional directional steering hook (same as in attention, normally a no-op).
5. HC post fans `ffn_out` back to 4 streams.

The decode-scratch version `layer_ffn_one_decode_scratch` (`ds4.c:5785-5857`) is the same with persistent scratch buffers.

The "routed + shared + sum" pattern is the typical MoE design. The variant DS4 picks — Q8_0 shared with `1.5x` weight scaling on the routed side — is what makes the two halves complementary in magnitude rather than competing.

## 11. Prefill MoE: batched by expert

Prefill processes the whole prompt at once. The naive way to run MoE on a batch: for each token, run the per-token MoE. That would re-read each selected expert's weight rows once per token. For 2048 prompt tokens and 6 experts each, that is potentially 12288 expert reads — even though only 256 distinct experts exist.

`layer_routed_moe_batch` (`ds4.c:5530-...`) instead groups tokens by expert. Pseudo-flow (the full implementation is ~150 lines):

1. Run the router for all `n_tok` tokens, producing `n_tok × 6 = total_pairs` (token, expert, weight) triples.
2. Radix-sort the pairs by expert id. Now all tokens that selected expert E are contiguous in the sorted array.
3. Identify the active experts (the distinct expert ids present).
4. For each active expert, in parallel: scan the expert's IQ2_XXS gate/up weight rows once and produce one `mid` vector per (token, slot) pair that selected this expert.
5. Quantize all mid vectors to Q8_K.
6. For each output dim, accumulate the Q2_K down projection over all (token, expert) pairs.

The benefit: each expert's weight matrix is read *once* across the entire batch, no matter how many tokens chose it. For a 2K-token prefill, expert weights are read ~50 times instead of 12288 times — orders of magnitude less memory bandwidth.

The implementation uses `ds4_parallel_for` for parallelism across active experts (step 4) and across output dims (step 6). The radix sort (step 2) is a small serial section that limits prefill throughput on very large batches; for typical 2-4K prompts it is a small fraction of the total cost.

## 12. The final HC collapse

After all 43 layers, the HC state needs to become a single 4096-wide vector again before the LM head (vocabulary projection) can run. `output_hc_head_one` (`ds4.c:8029-8054`):

```c
// ds4.c:8029-8054
static void output_hc_head_one(
        float             * out,
        const ds4_model   * model,
        const ds4_weights * weights,
        const float       * inp_hc) {
    const uint32_t n_hc = DS4_N_HC;
    const uint64_t hc_dim = (uint64_t)DS4_N_EMBD * n_hc;
    float *flat = xmalloc((size_t)hc_dim * sizeof(flat[0]));
    float *pre = xmalloc((size_t)n_hc * sizeof(pre[0]));
    float *w = xmalloc((size_t)n_hc * sizeof(w[0]));

    rms_norm_no_weight(flat, inp_hc, hc_dim, DS4_RMS_EPS);
    matvec_f16(pre, model, weights->output_hc_fn, flat);

    const float *scale = tensor_data(model, weights->output_hc_scale);
    const float *base = tensor_data(model, weights->output_hc_base);
    for (uint32_t i = 0; i < n_hc; i++) {
        w[i] = sigmoid_stable(pre[i] * scale[0] + base[i]) + DS4_HC_EPS;
    }

    hc_weighted_sum_one(out, inp_hc, w, DS4_N_EMBD, n_hc);
    /* free */
}
```

This is HC pre simplified: no Sinkhorn, no post gates, no combine matrix — just 4 sigmoidal weights and a weighted sum. The output `out` is the single 4096-wide vector that gets fed to the output norm and the Q8_0 vocab projection (`ds4.c:8057-8072`).

The simpler form makes sense: this is the *final* collapse. There is no next sublayer to feed; no need to re-fan-out the streams. Just merge them with learned per-stream weights and produce the embedding for logits.

`output_hc_scale` is a 1-float tensor (`ds4.c:2386`); `output_hc_base` is 4 floats; `output_hc_fn` is shape `[16384, 4]`. The whole final collapse is a few thousand parameters — trivial compared to the LM head matrix (`weights->output`, Q8_0 `[4096, 129280]`, ~528M weights for the vocab projection).

## 13. How HC interacts with MoE across layers

Stepping back: each layer wraps both attention and FFN in HC pre/post. So the 4 residual streams pass through `2 × 43 = 86` HC pre+post cycles. After each cycle, the streams have been linearly mixed (by the combine matrix) and additively perturbed (by the sublayer output via the post gates).

Two architectural consequences:

**Streams can specialize.** The Sinkhorn combine matrix can be near-identity (each row strongly peaked at one column), in which case streams stay separated, or near-uniform (each row spread across columns), in which case streams blend. The network can learn either pattern. In practice different layers learn different mixing densities — early layers tend to mix more (extracting common features); later layers tend to keep streams more separated (preserving specialized representations).

**The post gates can route sublayer output preferentially.** A sublayer can choose to write its output into, say, stream 2 strongly (`post[2]` near 2) and stream 0 weakly (`post[0]` near 0). This means a sublayer's output mostly affects one stream's downstream trajectory while leaving the other streams to carry the unmodified information forward.

This is the "hyper" part of hyper-connection: the network gets *meta-residual control* — not just whether to use the residual but where to write each sublayer's contribution and how to mix the inputs.

The choice of `n_hc = 4` is a parameter-cost / expressiveness tradeoff. With `n_hc = 1` HC degenerates to a single residual with sigmoidal gating. With `n_hc = 4` we get 16 mix entries plus 4 pre weights plus 4 post gates = 24 control floats per token per sublayer — a small overhead. Higher `n_hc` would add more parameter cost (the `fn` matmul is `[n_embd * n_hc, hc_mix_dim]` where `hc_mix_dim` also grows quadratically) without obviously paying back.

## 14. Decode-scratch FFN

The decode-time FFN (`layer_ffn_one_decode_scratch`, `ds4.c:5785-5857`) follows the same structure but threads the scratch arena through:

```c
// ds4.c:5807-5843 (abridged)
hc_pre_from_state_one_scratch(model,
                              layer->hc_ffn_fn,
                              layer->hc_ffn_scale,
                              layer->hc_ffn_base,
                              inp_hc, scratch->ffn_cur, post, comb,
                              scratch->hc_flat, false);

rms_norm_weight(scratch->ffn_norm, scratch->ffn_cur, ffn_norm, DS4_N_EMBD, DS4_RMS_EPS);

layer_routed_moe_one_prealloc(scratch->ffn_moe, model, layer,
                              scratch->ffn_norm, il, token, DS4_SWIGLU_CLAMP_EXP,
                              scratch->routed_mid_all, scratch->routed_xq, scratch->routed_midq);

layer_shared_ffn_one_decode_scratch(scratch->ffn_shared, model, layer,
                                    scratch->ffn_norm, scratch);

for (uint32_t i = 0; i < DS4_N_EMBD; i++) {
    scratch->ffn_out[i] = scratch->ffn_moe[i] + scratch->ffn_shared[i];
}
hc_post_one(out_hc, scratch->ffn_out, inp_hc, post, comb, DS4_N_EMBD, n_hc);
```

The MoE prealloc variant (`layer_routed_moe_one_prealloc`, `ds4.c:5480-5526`) takes the `mid_all`, `xq`, `midq` buffers from the caller's scratch instead of mallocing them. The shared expert scratch variant (`layer_shared_ffn_one_decode_scratch`, `ds4.c:5163-5186`) does the same for the shared expert's gate/up/mid buffers.

Together with the decode-scratch attention path (Chapter 08 §12.6), the result is a 43-layer decode pass that allocates exactly zero bytes — every temporary is in `scratch` and lives for the lifetime of the context.

## 15. GPU kernel surface for MoE and HC

For completeness, the GPU surface (`ds4_gpu.h:570-789`):

**MoE kernels** (`ds4_gpu.h:600-686`):

- `ds4_gpu_router_select_tensor` and `ds4_gpu_router_select_batch_tensor` — handle both hash and learned routing in one entry point, with `hash_mode` and `has_bias` booleans choosing the path.
- `ds4_gpu_routed_moe_one_tensor` and `ds4_gpu_routed_moe_batch_tensor` — the full expert execution: gate, up, SwiGLU with clamp, mid quantize, down accumulate. The batch variant uses the radix-grouped scheduling described in §11.
- `ds4_gpu_swiglu_tensor` — the small standalone SwiGLU kernel used by the shared expert.

**HC kernels** (`ds4_gpu.h:696-789`):

- `ds4_gpu_hc_split_sinkhorn_tensor` — the Sinkhorn decomposition; runs 20 iterations on-device.
- `ds4_gpu_hc_weighted_sum_tensor` and the fused `ds4_gpu_hc_split_weighted_sum_tensor` — the collapse step.
- `ds4_gpu_hc_split_weighted_sum_norm_tensor` — fuses Sinkhorn + collapse + RMSNorm into one kernel. This is the production decode path: one dispatch produces `attn_norm` directly from `inp_hc`.
- `ds4_gpu_hc_expand_tensor` and variants — the HC post step. `ds4_gpu_hc_expand_add_split_tensor` adds a second block output (used when the same HC post must absorb both the MoE and shared expert outputs in one kernel).
- `ds4_gpu_shared_down_hc_expand_q8_0_tensor` and `ds4_gpu_matmul_q8_0_hc_expand_tensor` — even more aggressively fused: the shared expert's down projection (or any Q8_0 projection) is fused with HC post into a single kernel.

The Metal implementations are in `metal/dsv4_hc.metal` (kernels `kernel_dsv4_hc_split_sinkhorn` line 107, `kernel_dsv4_hc_split_weighted_sum` line 282, `kernel_dsv4_hc_split_weighted_sum_norm4` line 395, `kernel_dsv4_hc_expand` line 541, `kernel_dsv4_hc_expand4` line 579, `kernel_dsv4_shared_down_hc_expand4_q8_0` line 631, `kernel_dsv4_q8_hc_expand4_q8_0` line 752, `kernel_dsv4_hc_weighted_sum` line 863) and `metal/moe.metal` (the routed MoE kernels: `kernel_dsv4_moe_swiglu_weight` line 136, `kernel_dsv4_moe_sum6_f32` line 208, `kernel_mul_mv_id_iq2_xxs_pair_*` lines 929+, `kernel_mul_mv_id_q2_K_sum6_f32` line 1277, plus the matrix-mul-via-id variants for batched expert dispatch).

## 16. Constants table

| Constant | Value | Used for |
|----------|-------|----------|
| `DS4_N_HC` | 4 | HC residual stream count |
| `DS4_N_HC_SINKHORN_ITER` | 20 | Sinkhorn iterations to enforce doubly-stochastic |
| `DS4_HC_EPS` | (small, `1e-6`-ish) | Epsilon in sigmoid + eps and Sinkhorn |
| `DS4_N_EXPERT` | 256 | Routed experts per layer |
| `DS4_N_EXPERT_USED` | 6 | Top-K experts per token |
| `DS4_N_EXPERT_SHARED` | 1 | Shared experts (always on) |
| `DS4_N_FF_EXP` | 2048 | Expert hidden dim |
| `DS4_N_HASH_LAYER` | 3 | First N layers use hash routing |
| `DS4_EXPERT_WEIGHT_SCALE` | 1.5 | Routed expert total weight scale |
| `DS4_SWIGLU_CLAMP_EXP` | 10.0 | Gate/up clamp before silu |

## 16.5. The expert weight layout in storage

A practical detail about the routed MoE: the gate/up/down expert matrices in the GGUF are stored as **a single 3D tensor per layer**, not as a separate matrix per expert. The validator at boot (`ds4.c:2429-2432`):

```c
// ds4.c:2429-2432
tensor_expect_routed_expert(l->ffn_gate_exps, 3, DS4_N_EMBD, DS4_N_FF_EXP, DS4_N_EXPERT);
tensor_expect_routed_expert(l->ffn_up_exps,   3, DS4_N_EMBD, DS4_N_FF_EXP, DS4_N_EXPERT);
tensor_expect_routed_expert(l->ffn_down_exps, 3, DS4_N_FF_EXP, DS4_N_EMBD, DS4_N_EXPERT);
```

So `ffn_gate_exps` is a single IQ2_XXS tensor with shape `[4096, 2048, 256]`. Indexing into expert `e` reads a 2D slice `[4096, 2048]` from the 3D structure. The on-disk layout has all expert 0's bytes first, then all of expert 1's, etc.

This contiguous layout matters for the prefill MoE's expert-grouped scheduling (§11): once you know expert E is selected by some subset of tokens, you can read expert E's weights as a single contiguous byte range. The OS's read-ahead works correctly; the page cache aligns to expert boundaries; the memory bandwidth is read-only-once.

For the shared expert, there is no "expert index" axis — `ffn_gate_shexp`, `ffn_up_shexp`, `ffn_down_shexp` are 2D Q8_0 tensors, one per layer (`ds4.c:2440-2442`). The shared expert is always read every token, so its layout simply matches the dense matmul pattern.

## 16.6. The hash table size

`ffn_gate_tid2eid` is shape `[6, 129280]` per layer for layers 0,1,2. That is 6 × 129280 × 4 bytes = 3.0 MiB per layer, ~9 MiB total for the three hash layers. It is part of the GGUF and loaded with the rest of the weights; the only runtime cost is a single int32 array lookup per layer per token (lines 5266-5268).

Compared to the learned router for layers 3-42: each has `ffn_gate_inp` of shape `[4096, 256]` F16 = 2 MiB, plus the `ffn_exp_probs_b` of 1 KB. The hash table is bigger per layer because it indexes by vocab, but it does not require any matmul work — the lookup is `O(1)`.

The break-even calculation: if learned routing is 256 floating-point operations per token (one `matvec_f16(4096 → 256)` is more than that, but in the same order), and hash lookup is essentially free, the hash layers save a few hundred FLOPs per token per layer. Multiplied across the prompt batch it adds up; more important, hash routing is *deterministic* given a token id, which removes one source of variance from early-layer training and inference.

## 16.7. The router probability shape

A subtle math note: `sqrt(softplus(x))` is not a probability in the strict sense — it doesn't sum to 1 across experts. But it has properties that make it useful as a *score*:

- Always non-negative: `softplus(x) > 0` for all x, so `sqrt(softplus(x)) >= 0`.
- Saturates linearly for large x: `softplus(x) ≈ x` for x >> 0, so `sqrt(softplus(x)) ≈ sqrt(x)` — slower growth than the raw logit.
- Bounded below by `softplus(0) = ln(2) ≈ 0.693`, so `sqrt(softplus(0)) ≈ 0.832`. Even an expert with zero raw logit has a finite score.

The sqrt suppresses extreme values. A logit of 100 produces a softplus of 100 and a probability of 10; a logit of 10000 produces a probability of 100. Without the sqrt, a single highly-activated expert could dominate the weights. With the sqrt, the ratio between weights is dampened — the model still has its top-K preference but doesn't put 99% of mass on one expert.

When the 6 selected experts' probabilities are normalized to sum to 1.5 (§6), this damping translates to weights that are more uniform across the 6 picks. A typical distribution might be (0.35, 0.30, 0.25, 0.25, 0.20, 0.15) before sum-normalization; after, the weights end up like (0.35, 0.30, 0.25, 0.25, 0.20, 0.15) × 1.5 / 1.5 ≈ unchanged ratios but summing to 1.5. The shared expert then sees its own untouched contribution; the routed MoE provides 1.5× a unit-weighted mixture; together they form a ~2.5×-magnitude contribution that the HC post step rescales via its post gates.

## 17. Why this design

Three architectural claims:

**MoE with 256 experts × top-6 is the parameter-vs-compute frontier.** At 671B total parameters, the model has the capacity of a dense 600B+ model but the per-token compute of a ~37B dense model (6 experts × ~6B each + shared + attention). The 256/6 ratio is a sparsity factor of ~43×; this is the lever DeepSeek V4 Flash pulls hardest. The mixed quantization (IQ2_XXS gate/up + Q2_K down + Q8_0 shared) further compresses the experts so the on-disk model fits in a manageable footprint.

**Hash routing for the first 3 layers solves the cold-start problem.** Learned routing on top of unprocessed embeddings tends to collapse — every token routes to the same handful of experts, no learning signal reaches the others. The hash table forces a uniform expert workload at the layers where embeddings are too raw for content-based routing to work. By layer 3, the embedding has been transformed enough that learned routing has signal to work with.

**Hyper-connection makes deep MoE stacks stable.** A 43-layer MoE stack with sparse routing is prone to instabilities: a token might land on near-random experts in one layer and well-tuned experts in the next, producing inconsistent residual contributions. The 4-stream HC carrier lets different streams be modified by different sublayers' outputs (via the post gates), so a "noisy" expert pick at one layer affects only some streams and the others continue to carry stable information forward. The Sinkhorn balancing on the combine matrix ensures the mixing across streams is information-preserving, preventing catastrophic cancellation or amplification across layers.

The interaction with MoE specifically: the 4-stream HC sees each token as having 4 parallel "content channels"; the MoE per-layer expert pick can be specialized to one channel (via the post gates) so a poorly-routed expert at one layer doesn't poison all the content the token carries forward. This is why DS4 picks both HC and aggressive MoE at the same time — they cover each other's failure modes.

## 17.5. The directional steering hook

Both `layer_attention_raw_swa_one` (`ds4.c:7186`) and `layer_ffn_one` (`ds4.c:5750`) call `cpu_directional_steering_project_rows` between the sublayer output and the HC post step:

```c
cpu_directional_steering_project_rows(ffn_out, steering_dirs, il, 1, steering_scale);
```

When `steering_dirs` is `NULL` or `steering_scale` is 0, this is a no-op. When set, the function projects a learned direction out of (or into) the sublayer output, scaled by `steering_scale`. This is a hook for **activation engineering** — applying steering vectors to nudge the model's behavior at inference time without retraining.

The hook is per-layer (`il` parameter) — different directions can be applied at different layers. The Metal/CUDA paths have the same hook: `ds4_gpu_directional_steering_project_tensor` (`ds4_gpu.h:592-598`). The kernel implementations are in `metal/dsv4_misc.metal` (`kernel_dsv4_directional_steering_project_f32` line 106).

For a normal inference run (no steering active), this hook costs essentially nothing (a single null pointer check). For steered inference (a research mode), it provides a clean place to inject behavioral controls without touching the sublayer math.

## 18. Per-token FFN pseudo-flow

To close out, the FFN sublayer for one decode token:

<svg viewBox="0 0 820 580" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="FFN sublayer pipeline with HC pre, routed MoE, shared expert, HC post"><defs><marker id="r91ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="410" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">FFN sublayer — one decode token, one layer</text><rect x="40" y="40" width="740" height="36" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/><text x="410" y="58" text-anchor="middle" font-size="11" font-weight="700" fill="#0369a1">input: inp_hc (4 × 4096) from attention HC-post + il + token</text><text x="410" y="70" text-anchor="middle" font-size="10" fill="#075985">token id matters only when il &lt; 3 (hash routing path)</text><line x1="410" y1="76" x2="410" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r91ar)"/><rect x="40" y="88" width="740" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="410" y="106" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">1. HC pre (FFN weights)</text><text x="410" y="122" text-anchor="middle" font-size="10" fill="#5b21b6">flat = rms_norm_no_weight(inp_hc) → mix = matvec_f16(hc_ffn_fn) → split = sinkhorn(...) → ffn_cur (4096)</text><line x1="410" y1="132" x2="410" y2="142" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r91ar)"/><rect x="40" y="142" width="740" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="410" y="160" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">2. FFN RMSNorm with learned scale</text><text x="410" y="172" text-anchor="middle" font-size="10" fill="#5b21b6">norm = rms_norm_weight(ffn_cur, layer.ffn_norm)</text><line x1="410" y1="178" x2="410" y2="188" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r91ar)"/><rect x="40" y="188" width="450" height="120" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="50" y="206" font-size="11" font-weight="700" fill="#9a3412">3. Routed MoE (6 of 256 experts)</text><text x="50" y="224" font-size="10" fill="#7c2d12">il &lt; 3: selected = ffn_gate_tid2eid[token]  (hash routing)</text><text x="50" y="238" font-size="10" fill="#7c2d12">il ≥ 3: probs = √softplus(ffn_gate_inp · norm)  → top-6 on (probs + bias)</text><text x="50" y="252" font-size="10" fill="#7c2d12">xq = quantize_q8_K(norm)  // one-time activation quant</text><text x="50" y="266" font-size="10" fill="#7c2d12">for slot in 0..5: mid = SiLU(clamp(iq2_xxs·xq)) × clamp(iq2_xxs·xq)</text><text x="50" y="280" font-size="10" fill="#7c2d12">midq = quantize_q8_K(mid)</text><text x="50" y="294" font-size="10" fill="#7c2d12">moe = Σ q2_k_dot(down_expert, midq) over 6 slots × weight × 1.5</text><rect x="500" y="188" width="280" height="120" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="510" y="206" font-size="11" font-weight="700" fill="#115e59">4. Shared expert (always on)</text><text x="510" y="224" font-size="10" fill="#064e3b">shared_xq = quantize_q8_0(norm)</text><text x="510" y="238" font-size="10" fill="#064e3b">gate, up = q8_0_pair_matmul</text><text x="510" y="252" font-size="10" fill="#064e3b">  (ffn_gate_shexp, ffn_up_shexp)</text><text x="510" y="266" font-size="10" fill="#064e3b">shared_mid = SwiGLU(gate, up, clamp=10)</text><text x="510" y="280" font-size="10" fill="#064e3b">shared = q8_0_matmul(ffn_down_shexp,</text><text x="510" y="294" font-size="10" fill="#064e3b">  shared_mid)</text><line x1="265" y1="308" x2="265" y2="332" stroke="#ea580c" stroke-width="1.2" marker-end="url(#r91ar)"/><line x1="640" y1="308" x2="640" y2="332" stroke="#0d9488" stroke-width="1.2" marker-end="url(#r91ar)"/><line x1="265" y1="320" x2="640" y2="320" stroke="#94a3b8" stroke-width="1.2"/><circle cx="450" cy="320" r="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="465" y="324" font-size="10" font-weight="700" fill="#92400e">+</text><rect x="40" y="332" width="740" height="44" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="410" y="350" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">5. Sum and steering</text><text x="410" y="366" text-anchor="middle" font-size="10" fill="#78350f">ffn_out = moe + shared  →  directional_steering_project(ffn_out, il, steering_dirs)</text><line x1="410" y1="376" x2="410" y2="388" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r91ar)"/><rect x="40" y="388" width="740" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="410" y="406" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">6. HC post</text><text x="410" y="422" text-anchor="middle" font-size="10" fill="#5b21b6">out_hc = hc_post(ffn_out, residual_hc=inp_hc, post=split[4..7], comb=split[8..23])</text><line x1="410" y1="432" x2="410" y2="444" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r91ar)"/><rect x="40" y="444" width="740" height="36" rx="6" fill="#bbf7d0" stroke="#16a34a" stroke-width="1.5"/><text x="410" y="462" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">output: out_hc (4 × 4096) → next layer's attention</text><text x="410" y="474" text-anchor="middle" font-size="10" fill="#166534">4 HC streams mixed/recombined; 6 of 256 routed experts and the always-on shared expert have contributed</text><text x="40" y="510" font-size="11" font-weight="700" fill="currentColor">Weight schemas:</text><text x="40" y="526" font-size="10" fill="#64748b">routed experts: gate_inp F16 (256-wide) · gate/up IQ2_XXS · down Q2_K · per-expert bias ffn_exp_probs_b</text><text x="40" y="540" font-size="10" fill="#64748b">shared expert: gate/up/down Q8_0 (paired matmul for gate+up sharing one activation quant)</text><text x="40" y="554" font-size="10" fill="#64748b">expert_weight scaled × 1.5 across all selected slots so the 6-of-256 sum reaches typical residual magnitude</text></svg>
<span class="figure-caption">Figure R9.2 | The FFN sublayer pipeline: HC pre reduces 4 streams to one normalized vector, the router picks 6 of 256 experts (hash for layers 0-2, top-K otherwise), MoE and the always-on shared expert run in parallel, their outputs sum, and HC post expands back to the 4-stream residual carrier.</span>

<details>
<summary>ASCII fallback</summary>

```
input:   inp_hc     (4 × 4096 floats from attention HC post)
         il         (layer index)
         token      (token id, used only by hash routing for il < 3)

# Step 1: HC pre using FFN weights
flat ← rms_norm_no_weight(inp_hc)
mix ← matvec_f16(hc_ffn_fn, flat)             # 16384 → 24
split ← sinkhorn_decompose(mix, hc_ffn_scale, hc_ffn_base, iters=20)
ffn_cur ← weighted_sum(inp_hc, split[0..3])

# Step 2: FFN RMSNorm with learned scale
norm ← rms_norm_weight(ffn_cur, layer.ffn_norm)

# Step 3: routed MoE
if il < 3:
    selected ← layer.ffn_gate_tid2eid[token]        # hash routing
    expert_weight ← unbiased_softplus_probs(norm)[selected], normalized × 1.5
else:
    probs ← sqrt(softplus(matvec_f16(layer.ffn_gate_inp, norm)))   # 256 probs
    selection ← probs + layer.ffn_exp_probs_b                       # biased for routing
    selected ← top_6(selection)
    expert_weight ← probs[selected] / sum × 1.5                     # unbiased weights × 1.5

xq ← quantize_q8_K(norm)                                # one-time activation quant
for slot in 0..5:
    expert = selected[slot]
    mid[slot] ← silu(clamp(iq2_xxs_dot(gate_expert, xq), 10))
              × clamp(iq2_xxs_dot(up_expert, xq), -10, 10)
              × expert_weight[slot]
midq[slot] ← quantize_q8_K(mid[slot])
moe ← Σ q2_k_dot(down_expert, midq[slot]) over slots                # 6 experts accumulate

# Step 4: shared expert (always on)
shared_xq ← quantize_q8_0(norm)
shared_gate, shared_up ← q8_0_pair_matmul(ffn_gate_shexp, ffn_up_shexp, shared_xq)
shared_mid ← swiglu(shared_gate, shared_up, clamp=10)
shared ← q8_0_matmul(ffn_down_shexp, shared_mid)

# Step 5: sum and HC post
ffn_out ← moe + shared
directional_steering_project(ffn_out, il, steering_dirs)
out_hc ← hc_post(ffn_out, residual_hc=inp_hc, post=split[4..7], comb=split[8..23])

output: out_hc (4 × 4096), passed to the next layer's attention sublayer
```

</details>

Combined with the attention pseudo-flow in Chapter 08, this is the full per-token, per-layer transformer block. 43 such blocks, then the final HC head collapse (§12), then `rms_norm_weight + matvec_q8_0(weights->output)` produces logits over the 129280-token vocabulary.

That is DeepSeek V4 Flash, end to end, on DwarfStar 4.
