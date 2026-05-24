# Chapter 02: DeepSeek V4 Flash Model Architecture

> Code version locked to `antirez/ds4@f91c12b` (2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

This chapter is the theory chapter. It explains what makes the DeepSeek V4 Flash model unusual and how those structural choices show up as constants and data structures in `ds4.c`. Implementation details — Metal kernels, quantization formats, KV serialization — live in their own chapters; here we only need to know the shape of the model and the *why* behind each design decision.

If you have read a textbook description of a transformer with multi-head attention, RoPE, and an MoE feed-forward, you have the prerequisites. Everything that diverges from that baseline is called out below.

---

## 1. Headline Numbers

### 1.1 The constants the engine refuses to negotiate

`ds4.c:87-116` declares one `enum` that controls every shape in the codebase:

```c
enum {
    DS4_N_LAYER            = 43,
    DS4_N_EMBD             = 4096,
    DS4_N_VOCAB            = 129280,
    DS4_N_HEAD             = 64,
    DS4_N_HEAD_KV          = 1,
    DS4_N_HEAD_DIM         = 512,
    DS4_N_VALUE_DIM        = 512,
    DS4_N_ROT              = 64,
    DS4_N_OUT_GROUP        = 8,
    DS4_N_LORA_Q           = 1024,
    DS4_N_LORA_O           = 1024,
    DS4_N_EXPERT           = 256,
    DS4_N_EXPERT_USED      = 6,
    DS4_N_EXPERT_SHARED    = 1,
    DS4_N_FF_EXP           = 2048,
    DS4_N_HASH_LAYER       = 3,
    DS4_N_SWA              = 128,
    DS4_N_INDEXER_HEAD     = 64,
    DS4_N_INDEXER_HEAD_DIM = 128,
    DS4_N_INDEXER_TOP_K    = 512,
    DS4_N_HC               = 4,
    DS4_N_HC_SINKHORN_ITER = 20,
};
```

These constants are the engine's **constitution**. Every weight tensor's expected shape, every per-layer KV cache, every kernel dispatch is computed from these numbers. The metadata validator at `ds4.c:2585-2667` enforces each one against the GGUF header on load; a mismatch is a fatal error.

### 1.2 The three numbers that matter to operators

| Parameter | Value | Where |
|-----------|-------|-------|
| Layers | 43 | `DS4_N_LAYER`, `ds4.c:88` |
| Total / active parameters | 284 B total / 13 B active | `MODEL_CARD.md:16` |
| Context window | 1 M tokens | `README.md:29` |

Operators care about these because they determine memory budget. A 1M-token context with the default raw-SWA window of 128 tokens (`DS4_N_SWA = 128`) plus ratio-4/128 compressed KV plus indexer state at 2bit quantization fits a 128 GB MacBook with headroom. Going below 96 GB forces a smaller context window or a different machine.

### 1.3 The four numbers that matter to a kernel writer

| Parameter | Value | Why |
|-----------|-------|-----|
| `DS4_N_HEAD = 64`, `DS4_N_HEAD_KV = 1` | MQA-extreme | 64 Q heads share **one** wide KV head. KV cache is sized by head width alone, not head count. |
| `DS4_N_HEAD_DIM = 512` | Wide KV head | The single KV head is 512 wide so 64 Q heads can extract independent information from it. |
| `DS4_N_ROT = 64` | Tail-only RoPE | Only the last 64 dimensions of each head get RoPE applied. The first 448 are content-only. |
| `DS4_N_EXPERT = 256`, `DS4_N_EXPERT_USED = 6` | Sparse MoE | Each token routes through 6 of 256 routed experts plus 1 shared expert. |

Each of these has consequences described in the rest of the chapter.

---

## 2. The Per-Layer Block

Before zooming into any one component, here is the shape of a single transformer block in DS4 Flash. Every one of the 43 layers does the same six things in order:

<svg viewBox="0 0 820 640" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="DeepSeek V4 Flash per-layer transformer block: HC residual stream, attention sublayer, FFN/MoE sublayer, with HC pre/post wrappers">
<defs>
<marker id="ar21" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="410" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Per-layer transformer block (one of 43 layers)</text>
<rect x="200" y="38" width="420" height="44" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2" rx="6"/>
<text x="410" y="58" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Input: HC residual stream</text>
<text x="410" y="74" text-anchor="middle" font-size="10" fill="#64748b">4 streams x n_embd = 4 x 4096 = 16384 floats</text>
<line x1="410" y1="82" x2="410" y2="96" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar21)"/>
<rect x="120" y="96" width="580" height="34" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="280" y="117" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">HC pre (attn)</text>
<text x="520" y="117" text-anchor="middle" font-size="10" fill="#64748b">-&gt; sublayer input + post[4] + comb[4x4]</text>
<text x="700" y="117" text-anchor="end" font-size="9" fill="#94a3b8">ds4.c:4429</text>
<line x1="410" y1="130" x2="410" y2="144" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar21)"/>
<rect x="80" y="144" width="660" height="148" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="410" y="164" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">Attention sublayer</text>
<text x="100" y="184" font-size="10" fill="#64748b">RMSNorm</text>
<text x="730" y="184" text-anchor="end" font-size="9" fill="#94a3b8">ds4.c:4687</text>
<text x="100" y="200" font-size="10" fill="#64748b">Q low-rank projection: 4096 -&gt; 1024 -&gt; 64x512</text>
<text x="730" y="200" text-anchor="end" font-size="9" fill="#94a3b8">ds4.c:4689</text>
<text x="100" y="216" font-size="10" fill="#64748b">KV projection (single head, width 512) + RMSNorm</text>
<text x="730" y="216" text-anchor="end" font-size="9" fill="#94a3b8">ds4.c:4726</text>
<text x="100" y="232" font-size="10" fill="#64748b">tail-RoPE on last 64 dims</text>
<text x="730" y="232" text-anchor="end" font-size="9" fill="#94a3b8">ds4.c:4851</text>
<text x="100" y="248" font-size="10" fill="#64748b">push KV into raw SWA cache; finalize a compressed row</text>
<text x="730" y="248" text-anchor="end" font-size="9" fill="#94a3b8">ds4.c:6354</text>
<text x="100" y="264" font-size="10" fill="#64748b">sink-aware softmax over raw + compressed KV rows</text>
<text x="730" y="264" text-anchor="end" font-size="9" fill="#94a3b8">ds4.c:4990</text>
<text x="100" y="280" font-size="10" fill="#64748b">grouped LoRA output projection: 64x512 -&gt; 8 groups -&gt; 4096</text>
<text x="730" y="280" text-anchor="end" font-size="9" fill="#94a3b8">ds4.c:5039</text>
<line x1="410" y1="292" x2="410" y2="306" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar21)"/>
<rect x="120" y="306" width="580" height="34" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="280" y="327" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">HC post (attn)</text>
<text x="520" y="327" text-anchor="middle" font-size="10" fill="#64748b">-&gt; updated 4-stream residual</text>
<text x="700" y="327" text-anchor="end" font-size="9" fill="#94a3b8">ds4.c:4459</text>
<line x1="410" y1="340" x2="410" y2="354" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar21)"/>
<rect x="120" y="354" width="580" height="34" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="280" y="375" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">HC pre (ffn)</text>
<text x="520" y="375" text-anchor="middle" font-size="10" fill="#64748b">-&gt; sublayer input + post[4] + comb[4x4]</text>
<line x1="410" y1="388" x2="410" y2="402" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar21)"/>
<rect x="80" y="402" width="660" height="132" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
<text x="410" y="422" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">FFN/MoE sublayer</text>
<text x="100" y="442" font-size="10" fill="#64748b">RMSNorm</text>
<text x="100" y="458" font-size="10" fill="#64748b">shared expert (Q8_0 SwiGLU MLP, runs always)</text>
<text x="730" y="458" text-anchor="end" font-size="9" fill="#94a3b8">ds4.c:5128</text>
<text x="100" y="474" font-size="10" fill="#64748b">router score: sqrt(softplus(logits))</text>
<text x="730" y="474" text-anchor="end" font-size="9" fill="#94a3b8">ds4.c:5273</text>
<text x="100" y="490" font-size="10" fill="#64748b">select 6 experts (hash for il&lt;3, biased top-k otherwise)</text>
<text x="730" y="490" text-anchor="end" font-size="9" fill="#94a3b8">ds4.c:5252, 5338</text>
<text x="100" y="506" font-size="10" fill="#64748b">run 6 routed experts (IQ2_XXS gate/up, Q2_K down)</text>
<text x="730" y="506" text-anchor="end" font-size="9" fill="#94a3b8">ds4.c:5382</text>
<text x="100" y="522" font-size="10" fill="#64748b">sum shared + routed -&gt; sublayer output</text>
<line x1="410" y1="534" x2="410" y2="548" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar21)"/>
<rect x="120" y="548" width="580" height="34" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="280" y="569" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">HC post (ffn)</text>
<text x="520" y="569" text-anchor="middle" font-size="10" fill="#64748b">-&gt; updated 4-stream residual</text>
<line x1="410" y1="582" x2="410" y2="596" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar21)"/>
<rect x="200" y="596" width="420" height="36" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2" rx="6"/>
<text x="410" y="618" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">Output: HC residual stream -&gt; next layer</text>
</svg>
<span class="figure-caption">Figure R2.1 | Inside one DS4 Flash layer: a 4-stream HC residual flows through an HC-pre/post-wrapped attention sublayer, then through an HC-pre/post-wrapped FFN/MoE sublayer.</span>

<details>
<summary>ASCII original</summary>

```
Input: HC residual stream (4 streams x n_embd = 4 x 4096)
   |
   |--- HC pre (attn)  -> sublayer input + post[4] + comb[4x4]   ds4.c:4429
   |
   v
   attention sublayer
     - RMSNorm                                                   ds4.c:4687
     - Q low-rank projection: 4096 -> 1024 -> 64x512             ds4.c:4689
     - KV projection (single head, width 512) + RMSNorm          ds4.c:4726
     - tail-RoPE on last 64 dims                                 ds4.c:4851
     - push KV into raw SWA cache; finalize a compressed row     ds4.c:6354
     - sink-aware softmax over raw + compressed KV rows          ds4.c:4990
     - grouped LoRA output projection: 64x512 -> 8 groups -> 4096 ds4.c:5039
   |
   |--- HC post (attn) -> updated 4-stream residual              ds4.c:4459
   |
   |--- HC pre (ffn)   -> sublayer input + post[4] + comb[4x4]
   |
   v
   FFN/MoE sublayer
     - RMSNorm
     - shared expert (Q8_0 SwiGLU MLP, runs always)              ds4.c:5128
     - router score: sqrt(softplus(logits))                      ds4.c:5273
     - select 6 experts (hash for il<3, biased top-k otherwise)  ds4.c:5252, 5338
     - run 6 routed experts (IQ2_XXS gate/up, Q2_K down)         ds4.c:5382
     - sum shared + routed -> sublayer output
   |
   |--- HC post (ffn)  -> updated 4-stream residual
   |
   v
Output: HC residual stream for next layer
```

</details>

After all 43 layers, an output HC head (`ds4.c:2384-2387`) reduces the four streams back to a single embedding, RMSNorms it, and projects through the Q8_0 vocab matrix.

The next sections explain each of these pieces.

---

## 3. Hyper-Connections (HC)

### 3.1 The problem hyper-connections solve

A standard transformer maintains **one** residual stream per token: each layer reads it, computes a sublayer output, and adds the output back. The residual stream is the only memory the layers share. Deep models pay a price for this: gradient signal gets routed through one channel, and information about different aspects of the token (semantics, syntax, position) all compete for bandwidth on the same vector.

Hyper-connections (HC) let each token carry **four** residual streams that evolve through the layers under learned mixing. The streams are not independent — every sublayer learns how to combine them — but each stream can specialise.

DS4 Flash sets `DS4_N_HC = 4` (`ds4.c:114`). The width of one stream is the embedding dimension `DS4_N_EMBD = 4096`, so the full per-token residual state is `4 x 4096 = 16384` floats. `AGENT.md` and the DeepSeek model card (`MODEL_CARD.md:68-69`) describe this as Manifold-Constrained Hyper-Connections (mHC), where the constraint is enforced by Sinkhorn normalisation of the combine matrix.

### 3.2 The pre / post pair around each sublayer

Each sublayer (attention or FFN) is wrapped by an **HC pre** and an **HC post**:

- **HC pre** reads the 4-stream state, computes a control vector, and decodes from that vector:
  - a weighted sum of the 4 streams (the sublayer input, `[4096]`),
  - a 4-element post-gate vector,
  - a 4x4 combine matrix.
- The sublayer runs on its single 4096-wide input and produces a 4096-wide output.
- **HC post** updates each of the 4 streams using the sublayer output (gated by `post[dst]`) and the previous streams (weighted by `comb[dst, src]`).

The pre step is `hc_pre_from_state_one_scratch` (`ds4.c:4377-4408`):

```c
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

Note the layout of `split[24]`: the first 4 entries are the pre weights, the next 4 are post gates, the last 16 (4x4) are the combine matrix.

The post step (`ds4.c:4459-4479`) is the corresponding write:

```c
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
```

Each destination stream `dst` is filled with: the sublayer output scaled by its post-gate `post[dst]`, plus a weighted mix of the previous streams. The mixing weights are read from `comb[dst, src]`.

### 3.3 Sinkhorn balancing

The combine matrix matters. If the network is free to put all the weight on one stream and zero out the others, the multi-stream design collapses to a single-stream model. Worse, training would be unstable because one stream's gradient would dominate.

DS4 Flash uses **Sinkhorn iteration** to keep the combine matrix doubly stochastic (rows and columns each sum to 1). `hc_split_sinkhorn_one` (`ds4.c:4279-4356`) runs 20 alternating row/column normalisations on the raw 4x4 mix output:

```c
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

The pre weights and post gates go through sigmoid (`out[i] = 1 / (1 + exp(-z)) + eps`) and a doubled sigmoid (`out[off] = 2 / (1 + exp(-z))`) respectively, both at lines 4291-4300. The result is that no stream can dominate, and the combine matrix is a soft permutation rather than an arbitrary linear map.

This is what `MODEL_CARD.md:68-69` means by "manifold-constrained". The constraint is a topology constraint, applied directly during inference and not just as a regulariser during training.

### 3.4 Stream initialisation and the output HC head

The 4 streams start their lives identical. `hc_from_plain_embedding` (`ds4.c:4451-4455`) copies the same token embedding into all 4 streams:

```c
static void hc_from_plain_embedding(float *out_hc, const float *x, uint32_t n_embd, uint32_t n_hc) {
    for (uint32_t h = 0; h < n_hc; h++) {
        memcpy(out_hc + (uint64_t)h * n_embd, x, (size_t)n_embd * sizeof(x[0]));
    }
}
```

Layers gradually differentiate them. At the end of the 43-layer stack, the **output HC head** combines them back into a single vector. The output head consists of three tensors validated at `ds4.c:2384-2387`:

```c
tensor_expect_layout(w->output_hc_base,  DS4_TENSOR_F32,  1, DS4_N_HC, 0, 0);
tensor_expect_layout(w->output_hc_fn,    DS4_TENSOR_F16,  2, hc_dim, DS4_N_HC, 0);
tensor_expect_layout(w->output_hc_scale, DS4_TENSOR_F32,  1, 1, 0, 0);
```

The 4 streams flow through `output_hc_fn`, the result is sigmoid-gated, and then a learned weighting collapses them to one 4096-wide vector that gets RMSNormed and projected through the Q8_0 vocab matrix to produce the 129280 logits.

### 3.5 Per-layer HC tensors

Each layer has six HC-related tensors validated at `ds4.c:2395-2397` and again at `ds4.c:2427-2429`:

| Tensor | Type | Shape | Purpose |
|--------|------|-------|---------|
| `hc_attn_fn` / `hc_ffn_fn` | F16 | `[hc_dim, hc_mix_dim]` | Project HC state to a 24-element mix vector |
| `hc_attn_scale` / `hc_ffn_scale` | F32 | `[3]` | Scale factors for pre, post, comb regions |
| `hc_attn_base` / `hc_ffn_base` | F32 | `[hc_mix_dim]` | Bias added to the mix vector |

where `hc_dim = 4 * 4096 = 16384` and `hc_mix_dim = 2 * 4 + 4 * 4 = 24`. The `fn` tensor is the only HC weight that is matrix-shaped; everything else is a small vector. The 24-element output decomposes as `[pre(4)] [post(4)] [comb(4x4)]`.

### 3.6 Why HC pays for itself

The cost of HC at inference is straightforward: 4x more residual bandwidth at each sublayer boundary, plus the Sinkhorn iteration on a 4x4 matrix per token per sublayer. The Sinkhorn is cheap (20 iterations on 16 elements); the residual bandwidth is the real cost.

The benefit, claimed by the model authors and supported by the engine's empirical results, is that gradient signal can flow through multiple paths during training, leading to better-trained deep networks at no inference-time loss of throughput beyond the residual-bandwidth overhead. The mHC variant adds the Sinkhorn constraint to make training more stable.

For ds4 specifically, HC is just shape that has to be handled correctly. The validator enforces the shape; the kernels (CPU and Metal) implement the pre / post pair; the Sinkhorn iteration is small enough to inline.

---

## 4. Attention

### 4.1 Low-rank Q projection with mid-projection norm

Standard multi-head attention projects an `[n_embd]` vector to `[n_head * head_dim]` in one matrix multiplication. DS4 Flash splits Q into two stages with a normalisation in the middle. `layer_q_projection_normed_one` (`ds4.c:4689-4706`):

```c
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

The shape path is `4096 -> Q8_0 -> 1024 -> RMSNorm -> Q8_0 -> 64 x 512`. The intermediate 1024-wide vector is also reused as the output projection's low-rank vector (the `DS4_N_LORA_O = 1024` constant at `ds4.c:98`).

Two design decisions are baked in here:

- **Two-stage projection saves parameters.** A direct projection from 4096 to `64 * 512 = 32768` is 4096 * 32768 = 134 M parameters. The two-stage version is 4096 * 1024 + 1024 * 32768 = 4 M + 33 M = 37 M parameters — about 28 % the size.
- **The mid-projection RMSNorm is essential.** Without it, the 1024-wide intermediate could be arbitrary; with it, the second projection sees a unit-norm input and the two stages become trainable as separate components. The norm vector `attn_q_a_norm` is a single F32 tensor of length 1024 (`ds4.c:2400`).

The final `head_rms_norm_inplace` (line 4702) normalises *each of the 64 heads* independently. This is unusual — most attention implementations skip per-head norm — and is required by the model's mid-attention numeric regime.

### 4.2 Single wide KV head (MQA extreme)

`DS4_N_HEAD_KV = 1` (`ds4.c:92`). All 64 query heads attend to the same single KV head. `layer_kv_projection_normed_one` (`ds4.c:4726-4739`):

```c
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

The shape path is `4096 -> Q8_0 -> 512 -> RMSNorm -> 512`. The KV is 512 wide and there is only one of it per token per layer.

Multi-Query Attention (MQA) and Grouped-Query Attention (GQA) reduce KV head count to save cache. DS4 Flash takes MQA to its extreme: every Q head reads the same KV. The win is enormous for KV-cache footprint:

- A standard MHA cache stores `n_layer * 2 * n_head * head_dim` floats per token. For DS4-shape with `n_head = 64`, `head_dim = 512` this would be `43 * 2 * 64 * 512 = 2.8 M` floats per token — 5.6 MB at fp16. A 1M-token context would need 5.6 TB of KV.
- DS4's MQA cache stores `n_layer * 1 * 512` per token (just K, since V shares the same head). That is `43 * 512 = 22 K` floats per token — 44 KB at fp16. A 1M-token raw cache would still be 44 GB — but DS4 only stores the latest 128 tokens raw, and aggressively compresses the rest. The compression is described in section 5.

The cost of single-head KV is that each Q head has to find its own information in the same shared 512-wide KV. This is the reason `DS4_N_HEAD_DIM = 512` — wider than the typical 128 — so the 64 Q heads have a wider information surface to work with.

### 4.3 Tail-only RoPE

DS4 Flash applies RoPE only to the last 64 dimensions of each head, not to the full head. `rope_tail_ext_inplace` (`ds4.c:4787-4835`) has this loop:

```c
for (uint32_t h = 0; h < n_head; h++) {
    float *tail = x + (uint64_t)h * head_dim + n_nope;  /* skip first n_nope dims */
    float theta_extrap = (float)pos;

    for (uint32_t i = 0; i < n_rot; i += 2) {
        /* RoPE rotation only on the tail (last n_rot dims) */
        ...
    }
}
```

with `n_nope = head_dim - n_rot = 512 - 64 = 448`. The first 448 dimensions of each head carry no positional encoding; the last 64 carry the full RoPE rotation.

The reason is the compressed-KV strategy. Position-encoded entries must be re-rotated whenever they are looked up at a different relative offset, while position-free entries can be summed and averaged into compressed rows safely. By segregating position into a small tail, DS4 Flash can compress the `nope` (no-position-encoding) part of the KV via an E4M3-style FP8 round-trip — the function `dsv4_fp8_kv_quantize_row_inplace_cpu` at `ds4.c:1656-1674` does exactly this only over `n_nope = head_dim - n_rot` dimensions:

```c
static void dsv4_fp8_kv_quantize_row_inplace_cpu(float *x, uint32_t head_dim, uint32_t n_rot) {
    const uint32_t n_nope = head_dim - n_rot;
    for (uint32_t off = 0; off < n_nope; off += 64) {
        /* per-64-element group: find amax, scale, quantize each value through E4M3FN */
    }
}
```

The RoPE tail (the last 64 dims) is kept at fp16 because its values change with position and would otherwise lose too much fidelity through low-bit quantization.

This is a deliberate co-design: tail-only RoPE makes the rest of the KV vector compressible.

### 4.4 Layer-dependent RoPE base and scaling

Not every layer gets the same RoPE configuration. `layer_rope_freq_base` (`ds4.c:4838-4842`):

```c
static float layer_rope_freq_base(uint32_t il) {
    return ds4_layer_compress_ratio(il) != 0 && DS4_COMPRESS_ROPE_FREQ_BASE > 0.0f
        ? DS4_COMPRESS_ROPE_FREQ_BASE
        : DS4_ROPE_FREQ_BASE;
}
```

with `DS4_ROPE_FREQ_BASE = 10000.0` (`ds4.c:57`) and `DS4_COMPRESS_ROPE_FREQ_BASE = 160000.0` (`ds4.c:61`). Layers 0 and 1 (the dense layers, see section 5) use base 10000; layers 2..42 (the compressed layers) use base 160000.

Why? A 1M-token context exposes high-frequency RoPE dimensions to absurd rotation angles. The higher base flattens the frequency spectrum, making positional encoding work at extreme distances. The dense layers (which only ever see the latest 128 tokens via raw SWA) do not need this and stick with the standard 10000.

The compressed layers additionally apply YaRN-style frequency scaling. `layer_rope_freq_scale` (`ds4.c:4844-4849`) returns `1 / DS4_ROPE_SCALE_FACTOR = 1/16` for compressed layers and 1 for dense layers. The YaRN correction dims and the per-dimension interpolation ramp are computed in `rope_yarn_corr_dims` and applied inside `rope_tail_ext_inplace` (`ds4.c:4777-4834`).

The original-context constant `DS4_ROPE_ORIG_CTX = 65536` (`ds4.c:62`) is the model's pretraining context length; YaRN scaling interpolates between behaviour at this length and behaviour at the actual position.

### 4.5 Sink-aware attention

DS4 Flash adds a learned **sink logit** per head to the attention denominator. `layer_attention_rows_one` (`ds4.c:4990-5028`):

```c
static void layer_attention_rows_one(
        float             * out_heads,
        const ds4_model   * model,
        const ds4_layer_weights * layer,
        const float       * q,
        const float       * kv_rows,
        uint32_t            n_kv) {
    const float *sinks = tensor_data(model, layer->attn_sinks);
    const float kq_scale = 1.0f / sqrtf((float)DS4_N_HEAD_DIM);
    float score_stack[512];
    float *score = n_kv <= 512 ? score_stack : xmalloc((size_t)n_kv * sizeof(score[0]));

    for (uint32_t h = 0; h < DS4_N_HEAD; h++) {
        const float *qh = q + (uint64_t)h * DS4_N_HEAD_DIM;

        float max_score = sinks[h];
        for (uint32_t r = 0; r < n_kv; r++) {
            const float *kv = kv_rows + (uint64_t)r * DS4_N_HEAD_DIM;
            score[r] = dot_f32(qh, kv, DS4_N_HEAD_DIM) * kq_scale;
            if (score[r] > max_score) max_score = score[r];
        }

        float *oh = out_heads + (uint64_t)h * DS4_N_HEAD_DIM;
        memset(oh, 0, (size_t)DS4_N_HEAD_DIM * sizeof(oh[0]));

        float denom = expf(sinks[h] - max_score);
        for (uint32_t r = 0; r < n_kv; r++) {
            const float weight = expf(score[r] - max_score);
            const float *kv = kv_rows + (uint64_t)r * DS4_N_HEAD_DIM;
            denom += weight;
            axpy_f32(oh, kv, weight, DS4_N_HEAD_DIM);
        }

        const float inv = 1.0f / denom;
        scale_f32(oh, inv, DS4_N_HEAD_DIM);
    }
    /* ... */
}
```

`sinks[h]` is a learned scalar per Q head (the `attn_sinks` tensor has shape `[DS4_N_HEAD = 64]`, validated at `ds4.c:2404`). It participates in the softmax denominator but contributes nothing to the value sum.

The sink is best understood as an **escape valve** for attention. When all KV rows are uninteresting (low scores relative to the sink), the attention weights flow into the sink, and the output is small. Without a sink, the softmax would force the attention distribution to add to 1 even when nothing relevant is in the KV — leading to noisy outputs in regions where the model has nothing useful to retrieve.

Several variants of attention use sinks; DS4 Flash's choice is to make the sink **per-head** rather than per-layer, allowing different heads to abstain independently.

### 4.6 Grouped LoRA output projection

The 64 attention heads each produce a 512-wide value vector, for a total of `64 * 512 = 32768` floats. Standard attention projects this back to 4096 through a single 32768x4096 matrix (134 M parameters). DS4 Flash uses a **grouped low-rank** projection.

`weights_validate_layout` at `ds4.c:2405-2406` shows the expected layout:

```c
tensor_expect_layout(l->attn_output_a,  DS4_TENSOR_Q8_0, 2, DS4_N_HEAD_DIM * (DS4_N_HEAD / DS4_N_OUT_GROUP), out_low_dim, 0);
tensor_expect_layout(l->attn_output_b,  DS4_TENSOR_Q8_0, 2, out_low_dim, DS4_N_EMBD, 0);
```

with `DS4_N_OUT_GROUP = 8` (`ds4.c:96`) and `out_low_dim = DS4_N_OUT_GROUP * DS4_N_LORA_O = 8 * 1024 = 8192`.

The shape path is:

<svg viewBox="0 0 780 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Grouped LoRA output projection: 64x512 attention heads grouped into 8 groups, per-group LoRA-down to 1024, then LoRA-up to 4096">
<defs>
<marker id="ar22" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="390" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Grouped LoRA output projection (per layer)</text>
<rect x="40" y="42" width="700" height="46" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2" rx="6"/>
<text x="390" y="62" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Attention output: 64 heads x 512 dims = 32768</text>
<text x="390" y="78" text-anchor="middle" font-size="10" fill="#64748b">Logical grouping: 8 groups of 8 heads each (8 x 8 x 512 = 32768)</text>
<rect x="80" y="100" width="70" height="30" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="3"/>
<text x="115" y="120" text-anchor="middle" font-size="9" fill="#7c3aed">grp 0</text>
<rect x="155" y="100" width="70" height="30" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="3"/>
<text x="190" y="120" text-anchor="middle" font-size="9" fill="#7c3aed">grp 1</text>
<rect x="230" y="100" width="70" height="30" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="3"/>
<text x="265" y="120" text-anchor="middle" font-size="9" fill="#7c3aed">grp 2</text>
<rect x="305" y="100" width="70" height="30" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="3"/>
<text x="340" y="120" text-anchor="middle" font-size="9" fill="#7c3aed">grp 3</text>
<rect x="380" y="100" width="70" height="30" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="3"/>
<text x="415" y="120" text-anchor="middle" font-size="9" fill="#7c3aed">grp 4</text>
<rect x="455" y="100" width="70" height="30" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="3"/>
<text x="490" y="120" text-anchor="middle" font-size="9" fill="#7c3aed">grp 5</text>
<rect x="530" y="100" width="70" height="30" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="3"/>
<text x="565" y="120" text-anchor="middle" font-size="9" fill="#7c3aed">grp 6</text>
<rect x="605" y="100" width="70" height="30" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="3"/>
<text x="640" y="120" text-anchor="middle" font-size="9" fill="#7c3aed">grp 7</text>
<text x="690" y="120" font-size="9" fill="#94a3b8">[8x512]</text>
<line x1="390" y1="135" x2="390" y2="150" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar22)"/>
<rect x="40" y="150" width="700" height="56" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="390" y="172" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">attn_output_a (Q8_0)</text>
<text x="390" y="188" text-anchor="middle" font-size="10" fill="#64748b">8 independent per-group LoRA-down: [8x512 -&gt; 1024] each</text>
<text x="390" y="202" text-anchor="middle" font-size="10" fill="#64748b">output: 8 groups x 1024 = 8192 dims (block-diagonal projection)</text>
<line x1="390" y1="206" x2="390" y2="220" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar22)"/>
<rect x="120" y="220" width="120" height="26" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="3"/>
<text x="180" y="237" text-anchor="middle" font-size="10" fill="#0d9488">[1024]</text>
<rect x="250" y="220" width="120" height="26" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="3"/>
<text x="310" y="237" text-anchor="middle" font-size="10" fill="#0d9488">[1024]</text>
<text x="385" y="237" font-size="11" fill="#64748b">...</text>
<rect x="420" y="220" width="120" height="26" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="3"/>
<text x="480" y="237" text-anchor="middle" font-size="10" fill="#0d9488">[1024]</text>
<rect x="550" y="220" width="120" height="26" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="3"/>
<text x="610" y="237" text-anchor="middle" font-size="10" fill="#0d9488">[1024]</text>
<text x="690" y="237" font-size="9" fill="#94a3b8">8192</text>
<line x1="390" y1="252" x2="390" y2="266" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar22)"/>
<rect x="40" y="266" width="700" height="48" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="390" y="288" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">attn_output_b (Q8_0)</text>
<text x="390" y="304" text-anchor="middle" font-size="10" fill="#64748b">LoRA-up to embedding dim: [8192, 4096] -- mixes the 8 group slices</text>
<line x1="390" y1="314" x2="390" y2="328" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar22)"/>
<rect x="240" y="328" width="300" height="28" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" rx="6"/>
<text x="390" y="347" text-anchor="middle" font-size="11" font-weight="700" fill="#16a34a">Output: 4096 (embedding dim)</text>
</svg>
<span class="figure-caption">Figure R2.2 | The grouped LoRA output projection halves the parameter count: attn_output_a is block-diagonal across 8 groups of 8 heads, attn_output_b then mixes the eight 1024-wide slices into one 4096-wide vector.</span>

<details>
<summary>ASCII original</summary>

```
attn output (heads: 64 heads * 512 dims = 32768)
   group into 8 groups of 8 heads each (8 * 8 * 512 = 32768 input dims)
   |
   v
attn_output_a (Q8_0, [8*512, 1024]) -- per-group LoRA-down to 1024
   output: 8 groups * 1024 = 8192 dims
   |
   v
attn_output_b (Q8_0, [8192, 4096]) -- LoRA-up to embedding dim
   output: 4096
```

</details>

Total parameters: `8 * (8 * 512 * 1024) + 8192 * 4096 = 33.5 M + 33.5 M = 67 M`. That is half the dense alternative, and the bottleneck rank of 1024 helps as a regulariser.

The "grouped" part is that `attn_output_a` is logically 8 separate matrices, each mapping one group of 8 heads to its own 1024-dim slice; `attn_output_b` then mixes the 8 slices into the final 4096-dim output. This factorisation is mathematically equivalent to forcing the first projection's matrix to be block-diagonal, which both saves parameters and matches the natural grouping of heads.

---

## 5. The Compressed KV Cache

This is the structural feature that makes a 1M-token context fit in 128 GB of unified memory. The full story is in Chapter 06; here we cover the shape.

### 5.1 The dual-track per-layer KV cache

Every layer's KV cache has two tracks. `ds4_layer_cache` (`ds4.c:6178-6191`):

```c
typedef struct {
    uint32_t cap_raw;
    uint32_t n_raw;
    float *raw_kv;                /* raw sliding window cache */

    uint32_t compress_ratio;
    uint32_t comp_cap;
    uint32_t n_comp;
    float *attn_comp_kv;          /* compressed KV (lossy) */
    float *attn_state_kv;
    float *attn_state_score;

    uint32_t n_index_comp;
    float *index_comp_kv;         /* indexer compressed stream (ratio-4 only) */
    float *index_state_kv;
    float *index_state_score;
} ds4_layer_cache;
```

The **raw track** stores the last `DS4_N_SWA = 128` tokens' KV exactly at fp16 precision. It is sized by `cap_raw` rows; once full it slides forward by one row per new token (`kv_cache_push_raw` at `ds4.c:6411`).

The **compressed track** stores the older KV at lower fidelity. It is per-layer because different layers compress at different ratios.

### 5.2 Per-layer compression ratio

`ds4_layer_compress_ratio` (`ds4.c:418-422`) is the source of truth:

```c
static uint32_t ds4_layer_compress_ratio(uint32_t il) {
    if (il >= DS4_N_LAYER) ds4_die("DeepSeek4 layer index is outside the fixed model layout");
    if (il < 2) return 0;
    return (il & 1u) == 0 ? 4u : 128u;
}
```

The pattern:

- Layers 0 and 1 — ratio 0 (no compression, dense layers).
- Layers 2, 4, 6, ..., 42 (even) — ratio 4 (one compressed row per 4 raw tokens, plus an indexer track).
- Layers 3, 5, 7, ..., 41 (odd) — ratio 128 (one compressed row per 128 raw tokens, no indexer).

The GGUF metadata key `deepseek4.attention.compress_ratios` records the per-layer ratio as an array; `validate_compress_ratio_metadata` (`ds4.c:2495-2527`) compares the on-disk array element by element to what `ds4_layer_compress_ratio` returns. A mismatch is fatal.

This is the same pattern the DeepSeek model card describes as Compressed Sparse Attention (CSA) plus Heavily Compressed Attention (HCA) (`MODEL_CARD.md:25-37`). The alternation between ratio-4 and ratio-128 is interleaved so that every token is attended to from both a fine-grained selective view and a coarse-grained heavy view as it ages.

### 5.3 KV cache allocation

`kv_cache_init` (`ds4.c:6354-6394`) allocates per-layer cache buffers based on the ratio:

```c
for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
    const uint32_t ratio = ds4_layer_compress_ratio(il);
    cache->layer[il].cap_raw = raw_cap;
    cache->layer[il].raw_kv = xmalloc_zeroed((size_t)raw_cap * DS4_N_HEAD_DIM, sizeof(float));
    cache->layer[il].compress_ratio = ratio;

    if (ratio != 0) {
        const uint32_t coff = ratio == 4 ? 2u : 1u;
        const uint32_t comp_cap = ctx_size / ratio + 2;
        const uint32_t attn_width = coff * DS4_N_HEAD_DIM;
        const uint32_t attn_rows = coff * ratio;

        cache->layer[il].comp_cap = comp_cap;
        cache->layer[il].attn_comp_kv = xmalloc_zeroed((size_t)comp_cap * DS4_N_HEAD_DIM, sizeof(float));
        cache->layer[il].attn_state_kv = xmalloc_zeroed((size_t)attn_width * attn_rows, sizeof(float));
        cache->layer[il].attn_state_score = xmalloc((size_t)attn_width * attn_rows * sizeof(float));
        /* ... initialize attn_state_score to -inf ... */

        if (ratio == 4) {
            const uint32_t index_width = coff * DS4_N_INDEXER_HEAD_DIM;
            const uint32_t index_rows = coff * ratio;
            cache->layer[il].index_comp_kv = xmalloc_zeroed((size_t)comp_cap * DS4_N_INDEXER_HEAD_DIM, sizeof(float));
            cache->layer[il].index_state_kv = xmalloc_zeroed((size_t)index_width * index_rows, sizeof(float));
            cache->layer[il].index_state_score = xmalloc((size_t)index_width * index_rows * sizeof(float));
            /* ... */
        }
    }
}
```

Things to notice:

- The compressed capacity `comp_cap = ctx_size / ratio + 2`. For a 1M context: ratio-4 layers need `1M / 4 + 2 = 256K` compressed rows; ratio-128 layers need `1M / 128 + 2 = 8K` compressed rows.
- The compressor maintains intermediate state across the in-progress compression window (`attn_state_kv`, `attn_state_score`). Scores are initialised to `-inf` so the first real score wins.
- Only ratio-4 layers allocate the indexer cache (`index_*`). Ratio-128 layers compress so aggressively that scoring individual rows is unnecessary.

### 5.4 The indexer (ratio-4 layers only)

The indexer is a separate small "attention" mechanism that selects which compressed rows are worth visiting during the main attention. It has its own tensors per ratio-4 layer (`ds4.c:2419-2424`):

```c
tensor_expect_layout(l->indexer_attn_q_b,          DS4_TENSOR_F16, 2, DS4_N_LORA_Q, index_q_dim, 0);
tensor_expect_layout(l->indexer_proj,              DS4_TENSOR_F16, 2, DS4_N_EMBD, DS4_N_INDEXER_HEAD, 0);
tensor_expect_layout(l->indexer_compressor_ape,    DS4_TENSOR_F16, 2, index_width, ratio, 0);
tensor_expect_layout(l->indexer_compressor_kv,     DS4_TENSOR_F16, 2, DS4_N_EMBD, index_width, 0);
tensor_expect_layout(l->indexer_compressor_gate,   DS4_TENSOR_F16, 2, DS4_N_EMBD, index_width, 0);
tensor_expect_layout(l->indexer_compressor_norm,   DS4_TENSOR_F32, 1, DS4_N_INDEXER_HEAD_DIM, 0, 0);
```

with `index_q_dim = DS4_N_INDEXER_HEAD * DS4_N_INDEXER_HEAD_DIM = 64 * 128 = 8192`.

The indexer's role during attention:

1. From the current query, compute a small `[64, 128]` indexer-Q and dot it against the layer's `index_comp_kv` rows.
2. Take the top `DS4_N_INDEXER_TOP_K = 512` highest-scoring compressed rows.
3. Use only those 512 rows (plus the raw window) in the main attention.

For a 1M context in a ratio-4 layer, the indexer reduces 256K candidate compressed rows down to 512 actively-attended rows. That is why the ratio-4 layers can stay accurate: they are *selectively* compressed, with the indexer choosing which old context matters.

The ratio-128 layers do not need an indexer because there are only ~8K candidates at 1M context, and the model uses all of them directly. This is the difference between "selective compressed attention" and "heavily compressed attention" in the model card's terminology (`MODEL_CARD.md:45-49`).

Note that `DS4_N_INDEXER_TOP_K = 512` is **not** a configurable parameter. The comment at `ds4.c:107-113` is explicit:

```c
/*
 * This is part of the DeepSeek-V4 attention semantics.  Do not lower it for
 * Metal4/M5 speed: selecting fewer compressed rows changes which memory the
 * model attends to, so it is an algorithmic approximation rather than local
 * numerical drift from a different kernel implementation.
 */
DS4_N_INDEXER_TOP_K    = 512,
```

Changing `top_k` would be a model change, not an engine optimisation.

### 5.5 Quantization of the compressed KV: E4M3-style FP8

The compressed KV is stored at FP8 precision via an E4M3 round-trip. `dsv4_fp8_kv_quantize_row_inplace_cpu` (`ds4.c:1656-1674`) is the reference implementation:

```c
static void dsv4_fp8_kv_quantize_row_inplace_cpu(float *x, uint32_t head_dim, uint32_t n_rot) {
    const uint32_t n_nope = head_dim - n_rot;
    for (uint32_t off = 0; off < n_nope; off += 64) {
        float amax = 0.0f;
        for (uint32_t i = 0; i < 64; i++) {
            const float av = fabsf(x[off + i]);
            if (av > amax) amax = av;
        }

        if (amax < 1.0e-4f) amax = 1.0e-4f;
        const float scale = ldexpf(1.0f, (int)ceilf(log2f(amax / 448.0f)));
        for (uint32_t i = 0; i < 64; i++) {
            float v = x[off + i] / scale;
            if (v > 448.0f) v = 448.0f;
            if (v < -448.0f) v = -448.0f;
            x[off + i] = dsv4_e4m3fn_dequant_cpu(v) * scale;
        }
    }
}
```

The function operates **in-place**: it reads a float vector, quantizes through E4M3FN (max value 448), and writes back the dequantized approximation. The compression is per-64-element group: each group has its own scale, computed as the largest power-of-two value at or above `amax / 448`. Only the `n_nope = head_dim - n_rot = 448` content dimensions are quantized; the 64 RoPE-rotated tail dimensions stay at fp16.

The reason for in-place rather than fp8-stored: the cache holds fp16 throughout the live engine, but its values are constrained to the FP8-representable lattice. This makes the CPU reference code identical to the GPU graph's behaviour. The CPU code's comment (`ds4.c:1632-1634`) explains:

> DeepSeek V4 stores the non-RoPE part of compressed KV through an E4M3-style round trip. Keeping this in the CPU reference makes cache values comparable to the Metal graph's compressed-cache behavior.

---

## 6. MoE: Mixture of Experts

### 6.1 Two parallel paths through the FFN

Each layer's FFN sublayer has two components that run in parallel and sum their outputs:

<svg viewBox="0 0 780 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="DS4 Flash FFN sublayer: two parallel paths, a Q8_0 shared expert that always runs and a 6-of-256 routed MoE">
<defs>
<marker id="ar23" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="390" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">FFN sublayer: shared expert + routed MoE (parallel)</text>
<rect x="270" y="40" width="240" height="40" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2" rx="6"/>
<text x="390" y="64" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">input x (4096)</text>
<line x1="320" y1="80" x2="180" y2="116" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar23)"/>
<line x1="460" y1="80" x2="600" y2="116" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar23)"/>
<rect x="40" y="116" width="280" height="160" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="8"/>
<text x="180" y="138" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">Shared expert</text>
<text x="180" y="156" text-anchor="middle" font-size="10" fill="#64748b">runs unconditionally for every token</text>
<rect x="60" y="170" width="240" height="22" fill="#ffffff" stroke="#0d9488" stroke-width="1" rx="3"/>
<text x="180" y="185" text-anchor="middle" font-size="10" fill="#0d9488">Q8_0 SwiGLU MLP</text>
<text x="180" y="208" text-anchor="middle" font-size="10" fill="#64748b">hidden width = DS4_N_FF_EXP = 2048</text>
<text x="180" y="224" text-anchor="middle" font-size="10" fill="#64748b">gate / up / down all Q8_0 (~8.5 bit)</text>
<text x="180" y="244" text-anchor="middle" font-size="10" fill="#64748b">DS4_N_EXPERT_SHARED = 1</text>
<text x="180" y="260" text-anchor="middle" font-size="9" font-style="italic" fill="#94a3b8">every-token features; precision matters</text>
<rect x="460" y="116" width="280" height="160" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="8"/>
<text x="600" y="138" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">Routed MoE</text>
<text x="600" y="156" text-anchor="middle" font-size="10" fill="#64748b">select 6 of 256 routed experts</text>
<rect x="480" y="170" width="240" height="22" fill="#ffffff" stroke="#ea580c" stroke-width="1" rx="3"/>
<text x="600" y="185" text-anchor="middle" font-size="10" fill="#ea580c">IQ2_XXS gate/up &middot; Q2_K down (~2 bit)</text>
<text x="600" y="208" text-anchor="middle" font-size="10" fill="#64748b">router: sqrt(softplus(logits))</text>
<text x="600" y="224" text-anchor="middle" font-size="10" fill="#64748b">il&lt;3: hash routing; il&gt;=3: biased top-k</text>
<text x="600" y="244" text-anchor="middle" font-size="10" fill="#64748b">DS4_N_EXPERT_USED = 6 / DS4_N_EXPERT = 256</text>
<text x="600" y="260" text-anchor="middle" font-size="9" font-style="italic" fill="#94a3b8">sparse; per-expert error averages out</text>
<line x1="180" y1="276" x2="380" y2="306" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar23)"/>
<line x1="600" y1="276" x2="400" y2="306" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar23)"/>
<rect x="290" y="306" width="200" height="30" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" rx="6"/>
<text x="390" y="326" text-anchor="middle" font-size="11" font-weight="700" fill="#16a34a">sum -&gt; sublayer output</text>
</svg>
<span class="figure-caption">Figure R2.3 | Each FFN sublayer runs two paths in parallel: a high-precision Q8_0 shared expert that processes every token, plus 6 of 256 low-bit routed experts whose outputs are summed back together.</span>

<details>
<summary>ASCII original</summary>

```
input x (4096)
  +---------------------------+
  |                           |
  v                           v
shared expert            routed MoE: 256 experts, select 6
(Q8_0 SwiGLU MLP)        (IQ2_XXS gate/up, Q2_K down)
  |                           |
  +-----------+---------------+
              v
            sum -> back to residual
```

</details>

The shared expert runs unconditionally; the routed MoE runs only the selected 6 of 256 experts. Both contribute to the FFN output.

### 6.2 Shared expert

The shared expert is a standard Q8_0 SwiGLU MLP (`layer_shared_ffn_one` at `ds4.c:5128-5183`):

- gate / up / down projections all Q8_0 quantized
- hidden width `DS4_N_FF_EXP = 2048`
- swiglu: `silu(gate) * up` then down

Its tensors are validated at `ds4.c:2440-2442`:

```c
tensor_expect_layout(l->ffn_gate_shexp, DS4_TENSOR_Q8_0,    2, DS4_N_EMBD, DS4_N_FF_EXP, 0);
tensor_expect_layout(l->ffn_up_shexp,   DS4_TENSOR_Q8_0,    2, DS4_N_EMBD, DS4_N_FF_EXP, 0);
tensor_expect_layout(l->ffn_down_shexp, DS4_TENSOR_Q8_0,    2, DS4_N_FF_EXP, DS4_N_EMBD, 0);
```

`DS4_N_EXPERT_SHARED = 1` (`ds4.c:101`) — there is exactly one shared expert per layer. The shared expert exists to capture the kind of feature transformation every token needs regardless of routing; only the higher-order, more specialised features are pushed into the routed experts.

The shared expert is **Q8_0** rather than 2-bit. Q8_0 is the higher-fidelity quantization; routed experts can afford 2-bit because they only see a fraction of tokens, but the shared expert sees every token and any precision loss compounds.

### 6.3 Routed MoE: 256 experts, top-6

`DS4_N_EXPERT = 256`, `DS4_N_EXPERT_USED = 6`. Of 256 routed experts, each token's FFN selects 6 to run.

The tensor types are validated at `ds4.c:2433-2435`:

```c
tensor_expect_routed_expert(l->ffn_gate_exps, 3, DS4_N_EMBD, DS4_N_FF_EXP, DS4_N_EXPERT);
tensor_expect_routed_expert(l->ffn_up_exps,   3, DS4_N_EMBD, DS4_N_FF_EXP, DS4_N_EXPERT);
tensor_expect_routed_expert(l->ffn_down_exps, 3, DS4_N_FF_EXP, DS4_N_EMBD, DS4_N_EXPERT);
```

`tensor_expect_routed_expert` (`ds4.c:2337-2374`) allows one of three quant types per the helper `tensor_is_routed_expert_type` (`ds4.c:2316-2320`):

```c
static bool tensor_is_routed_expert_type(uint32_t type) {
    return type == DS4_TENSOR_IQ2_XXS ||
           type == DS4_TENSOR_Q2_K ||
           type == DS4_TENSOR_Q4_K;
}
```

The standard 2-bit GGUFs in `download_model.sh q2-imatrix` use IQ2_XXS for gate/up and Q2_K for down. The Q4 build uses Q4_K throughout. `weights_validate_layout` further requires that `gate_exps` and `up_exps` have the same type (`ds4.c:2436-2439`), because the kernels expect them to dispatch identically.

### 6.4 Two router schemes

Routing differs between the first three layers and the rest. `DS4_N_HASH_LAYER = 3` (`ds4.c:103`) marks the boundary.

**Layers 0-2: hash routing.** `layer_hash_selected_experts` (`ds4.c:5252-5269`):

```c
static void layer_hash_selected_experts(
        int                    selected[DS4_N_EXPERT_USED],
        const ds4_model       *model,
        const ds4_layer_weights *layer,
        int                    token) {
    ds4_tensor *t = layer->ffn_gate_tid2eid;
    if (!t) ds4_die("hash routing table is missing for this layer");
    /* ... shape checks ... */
    const int32_t *table = tensor_data(model, t);
    const int32_t *row = table + (uint64_t)token * DS4_N_EXPERT_USED;
    for (int i = 0; i < DS4_N_EXPERT_USED; i++) selected[i] = row[i];
}
```

The expert selection is a direct lookup keyed by token ID into a fixed `[6, 129280]` int32 table (`ffn_gate_tid2eid`, validated at `ds4.c:2443-2445`). Each token always activates the same 6 experts in these early layers; the only thing the router learns is the per-token weight.

**Why hash routing for early layers?** Two reasons. First, very early in the network the token identity is more informative than its representation — the model has not yet built rich features. Second, hash routing is cache-friendly: the same token always hits the same expert IDs, so during prefill a batch of identical tokens has perfect locality.

**Layers 3-42: biased top-k routing.** `layer_topk_selected_experts_from_probs` (`ds4.c:5350-5376`):

```c
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

There are two layers of decoupling here:

1. **Biased selection, unbiased weight.** The per-expert bias `ffn_exp_probs_b` is added to the router probabilities only for the purpose of selecting which 6 experts to run. The actual weight applied to each expert's output uses the *unbiased* probability. The bias is what the DeepSeek team uses for load balancing during training — it shifts routing toward underused experts without distorting their semantic contribution.
2. **Sum-renormalisation with scale.** After picking 6, the weights are renormalised to sum to 1 (within a numeric floor) and then multiplied by `DS4_EXPERT_WEIGHT_SCALE = 1.5` (`ds4.c:55`). The 1.5 compensates for the loss of mass relative to a softmax over all 256 — empirically chosen to keep activation magnitudes in the right range.

### 6.5 Router score formula

The router score is **not** a softmax. It is `sqrt(softplus(logit))`. From `layer_router_probs_one` (`ds4.c:5273-5284`):

```c
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

`softplus_stable` (`ds4.c:5109-5113`) is the numerically careful softplus: `log(1 + exp(x))`, with extremes handled to avoid overflow.

Why this rather than softmax? Two properties:

- **Non-normalised**: probs are positive but do not sum to 1 across the 256 experts. This decouples the bias-vs-weight design above; if probs were a softmax, biasing one expert would push other probs down and corrupt the weighting.
- **Sub-linear in logit magnitude**: the `sqrt` outside softplus dampens the dominance of high-logit experts. Combined with the post-selection renormalisation, this keeps the weight distribution among the chosen 6 less spiky.

The router-input projection itself is `ffn_gate_inp` (validated at `ds4.c:2431` as `F16, [DS4_N_EMBD, DS4_N_EXPERT]`). It is kept at F16 — full precision — because routing decisions are sensitive to small numerical differences.

### 6.6 Asymmetric quantization

`README.md:97-101` states the design:

> The 2 bit quants use a very asymmetrical quantization: only the routed MoE experts are quantized, up/gate at IQ2_XXS, down at Q2_K. They are the majority of all the model space: the other components (shared experts, projections, routing) are left untouched to guarantee quality.

The reasoning:

| Component | Quantization | Why |
|-----------|--------------|-----|
| Routed expert gate/up | IQ2_XXS (~2 bit) | 256 experts; only 6 active per token; per-expert error averages out |
| Routed expert down | Q2_K (~2 bit) | Same reasoning |
| Shared expert | Q8_0 (~8.5 bit) | Runs every token; error accumulates |
| Q low-rank, KV, output projections | Q8_0 / F16 | Attention is the sensitive path |
| Router gate_inp | F16 | Routing decisions matter |
| Token embedding | F16 | Input fidelity matters |
| Vocab projection (output) | Q8_0 | Logit precision matters |

The 256 routed-expert matrices dominate the storage: at 4096 x 2048 per matrix and 3 matrices (gate/up/down) per expert, that is `256 * 3 * 4096 * 2048 = 6.4 G` parameters in routed experts out of `~284 G` total — actually the bulk of the parameter count. By restricting 2-bit storage to just these matrices, the model achieves the ~85 GB on-disk size that fits 128 GB MacBook unified memory while keeping the high-precision components untouched.

This asymmetry is the key reason ds4 ships its own quants instead of using community GGUFs. A naïve "everything Q2" quant would tank quality; this asymmetric one preserves it.

---

## 7. The MTP Draft Model

DS4 Flash ships an optional Multi-Token Prediction head as a **separate GGUF**. From `ds4.c:2128-2138`:

```c
typedef struct {
    ds4_tensor *e_proj;
    ds4_tensor *h_proj;
    ds4_tensor *enorm;
    ds4_tensor *hnorm;
    ds4_tensor *norm;
    ds4_tensor *hc_head_base;
    ds4_tensor *hc_head_fn;
    ds4_tensor *hc_head_scale;
    ds4_layer_weights block;
} ds4_mtp_weights;
```

The MTP head is essentially one extra transformer layer plus an embedding-projection and a hidden-projection feed-in, plus its own HC output head. It is bound from the same GGUF format under a `mtp.0.*` prefix (`ds4.c:2731-2748`) and its layout validation lives at `ds4.c:2449-2477`.

When the main model produces a token, the MTP head — driven by the main model's last hidden state — predicts a few additional draft tokens. The next decode step verifies those drafts in parallel with the main model. Accepted drafts are committed; rejected ones are discarded.

The relevant CLI flags are `--mtp <path>`, `--mtp-draft <N>` (default 1, capped at 16 in `ds4.c:17645`), and `--mtp-margin <X>` (default 3.0). Higher margin demands more confidence before accepting a draft.

MTP is the subject of Chapter 12. For this chapter, the takeaway is that it lives at the engine layer (`ds4_engine_open` loads it via `model_open` and `mtp_weights_bind`), and the rest of the engine is unaware of whether MTP is active; it shows up only in `ds4_session_eval_speculative_argmax` (`ds4.h:188-191`).

---

## 8. Think Modes

DS4 Flash exposes three reasoning modes (`ds4.h:23-27`):

```c
typedef enum {
    DS4_THINK_NONE,
    DS4_THINK_HIGH,
    DS4_THINK_MAX,
} ds4_think_mode;
```

The default is `DS4_THINK_HIGH`. Modes affect:

- **Prompt rendering**: `DS4_THINK_MAX` injects a prefix into the prompt asking for maximum reasoning effort. The prefix is the static string `DS4_REASONING_EFFORT_MAX_PREFIX` at `ds4.c:64-67`:

  ```c
  static const char DS4_REASONING_EFFORT_MAX_PREFIX[] =
      "Reasoning Effort: Absolute maximum with no shortcuts permitted.\n"
      "You MUST be very thorough in your thinking and comprehensively decompose the problem to resolve the root cause, rigorously stress-testing your logic against all potential paths, edge cases, and adversarial scenarios.\n"
      "Explicitly write out your entire deliberation process, documenting every intermediate step, considered alternative, and rejected hypothesis to ensure absolutely no assumption is left unchecked.\n\n";
  ```

  `ds4_chat_append_max_effort_prefix` (`ds4.h:146`) tokenizes this and prepends it.

- **Context-window gating**: `DS4_THINK_MAX_MIN_CONTEXT = 393216` (`ds4.c:72`). The comment is explicit:

  ```c
  /* DeepSeek recommends Think Max only with at least a 384K-token context window.
   * Below that size we keep ordinary thinking to avoid injecting a prompt that
   * asks for a reasoning budget the allocated context is not meant to hold. */
  ```

  `ds4_think_mode_for_context` (`ds4.h:107`) is the helper that the CLI uses to auto-downgrade Think Max to High when the user's `--ctx` is too small.

- **Sampling overrides** (in the server): when thinking is enabled, ds4-server forces `temperature = 1, min_p = 0.05` to match official API behaviour (`README.md:334-337`).

There is **no model-level switch** for Think mode. Mode selection is purely prompt-engineering; the engine emits the right token sequence and trusts the model to behave as instructed.

---

## 9. The Per-Layer Tensor Inventory

For reference when reading later chapters, here is the full per-layer tensor set as declared in `ds4_layer_weights` (`ds4.c:2080-2116`):

<svg viewBox="0 0 880 760" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Per-layer tensor inventory: HC, attention, compressor, indexer, FFN, and hash routing tensor groups with presence conditions">
<text x="440" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Per-layer tensor inventory (ds4_layer_weights, ds4.c:2080-2116)</text>
<text x="440" y="40" text-anchor="middle" font-size="10" font-style="italic" fill="#64748b">hc_dim = 4 x 4096 = 16384; comp_width = coff x 512 (coff=2 ratio-4, coff=1 ratio-128); index_width = 2 x 128 = 256</text>
<rect x="20" y="54" width="420" height="160" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="230" y="74" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">HC (always present)</text>
<text x="32" y="92" font-size="10" fill="#64748b">hc_attn_fn       F16  [hc_dim, 24]   attn HC pre projection</text>
<text x="32" y="106" font-size="10" fill="#64748b">hc_attn_scale    F32  [3]            attn pre/post/comb scales</text>
<text x="32" y="120" font-size="10" fill="#64748b">hc_attn_base     F32  [24]           attn HC pre bias</text>
<text x="32" y="134" font-size="10" fill="#64748b">hc_ffn_fn        F16  [hc_dim, 24]   FFN HC pre projection</text>
<text x="32" y="148" font-size="10" fill="#64748b">hc_ffn_scale     F32  [3]            FFN pre/post/comb scales</text>
<text x="32" y="162" font-size="10" fill="#64748b">hc_ffn_base      F32  [24]           FFN HC pre bias</text>
<text x="32" y="186" font-size="9" font-style="italic" fill="#94a3b8">24-element output decomposes as [pre(4)] [post(4)] [comb(4x4)]</text>
<text x="32" y="202" font-size="9" font-style="italic" fill="#94a3b8">fn is the only matrix-shaped HC tensor; the rest are tiny vectors</text>
<rect x="460" y="54" width="400" height="270" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="660" y="74" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">Attention (always present)</text>
<text x="472" y="92" font-size="10" fill="#64748b">attn_norm         F32   [4096]</text>
<text x="472" y="106" font-size="10" fill="#64748b">attn_q_a          Q8_0  [4096, 1024]    -- LoRA down</text>
<text x="472" y="120" font-size="10" fill="#64748b">attn_q_a_norm     F32   [1024]          -- mid-projection norm</text>
<text x="472" y="134" font-size="10" fill="#64748b">attn_q_b          Q8_0  [1024, 64*512]  -- LoRA up to heads</text>
<text x="472" y="148" font-size="10" fill="#64748b">attn_kv           Q8_0  [4096, 512]     -- single wide KV head</text>
<text x="472" y="162" font-size="10" fill="#64748b">attn_kv_a_norm    F32   [512]</text>
<text x="472" y="176" font-size="10" fill="#64748b">attn_sinks        F32   [64]            -- per-head sink logit</text>
<text x="472" y="190" font-size="10" fill="#64748b">attn_output_a     Q8_0  [8*512, 8192]   -- grouped LoRA down</text>
<text x="472" y="204" font-size="10" fill="#64748b">attn_output_b     Q8_0  [8192, 4096]    -- LoRA up to embedding</text>
<text x="472" y="234" font-size="11" font-weight="700" fill="#ea580c">Compressor (ratio != 0)</text>
<text x="472" y="252" font-size="10" fill="#64748b">attn_compressor_ape   F16  [comp_width, ratio]</text>
<text x="472" y="266" font-size="10" fill="#64748b">attn_compressor_kv    F16  [4096, comp_width]</text>
<text x="472" y="280" font-size="10" fill="#64748b">attn_compressor_gate  F16  [4096, comp_width]</text>
<text x="472" y="294" font-size="10" fill="#64748b">attn_compressor_norm  F32  [512]</text>
<text x="472" y="316" font-size="9" font-style="italic" fill="#94a3b8">layers 0-1 dense (no compressor); layers 2..42 have one</text>
<rect x="20" y="232" width="420" height="216" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
<text x="230" y="252" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">Indexer (ratio == 4 only)</text>
<text x="32" y="270" font-size="10" fill="#64748b">indexer_attn_q_b         F16  [1024, 8192]</text>
<text x="32" y="284" font-size="10" fill="#64748b">indexer_proj             F16  [4096, 64]</text>
<text x="32" y="298" font-size="10" fill="#64748b">indexer_compressor_ape   F16  [index_width, 4]</text>
<text x="32" y="312" font-size="10" fill="#64748b">indexer_compressor_kv    F16  [4096, index_width]</text>
<text x="32" y="326" font-size="10" fill="#64748b">indexer_compressor_gate  F16  [4096, index_width]</text>
<text x="32" y="340" font-size="10" fill="#64748b">indexer_compressor_norm  F32  [128]</text>
<text x="32" y="364" font-size="9" font-style="italic" fill="#94a3b8">Only even layers from 2 (ratio-4 compression).</text>
<text x="32" y="378" font-size="9" font-style="italic" fill="#94a3b8">Selects top-512 candidate compressed rows for main attention.</text>
<text x="32" y="400" font-size="10" fill="#64748b">index_q_dim = DS4_N_INDEXER_HEAD x DS4_N_INDEXER_HEAD_DIM = 8192</text>
<text x="32" y="416" font-size="10" fill="#64748b">DS4_N_INDEXER_TOP_K = 512 (algorithmic, NOT tunable)</text>
<text x="32" y="436" font-size="9" font-style="italic" fill="#94a3b8">Ratio-128 layers have no indexer (all candidates used directly).</text>
<rect x="20" y="468" width="840" height="226" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="440" y="488" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">FFN (always present)</text>
<text x="32" y="506" font-size="10" fill="#64748b">ffn_norm           F32   [4096]</text>
<text x="32" y="520" font-size="10" fill="#64748b">ffn_gate_inp       F16   [4096, 256]                                  -- router (kept at F16, decisions matter)</text>
<text x="32" y="534" font-size="10" fill="#64748b">ffn_exp_probs_b    F32   [256] (optional)                             -- per-expert routing bias</text>
<text x="32" y="554" font-size="11" font-weight="700" fill="#ea580c">Routed experts (asymmetric quantization, dominate parameter count)</text>
<text x="32" y="570" font-size="10" fill="#64748b">ffn_gate_exps      IQ2_XXS | Q2_K | Q4_K   [4096, 2048, 256]</text>
<text x="32" y="584" font-size="10" fill="#64748b">ffn_up_exps        same type as gate       [4096, 2048, 256]</text>
<text x="32" y="598" font-size="10" fill="#64748b">ffn_down_exps      IQ2_XXS | Q2_K | Q4_K   [2048, 4096, 256]</text>
<text x="32" y="620" font-size="11" font-weight="700" fill="#ea580c">Shared expert (high precision, runs every token)</text>
<text x="32" y="636" font-size="10" fill="#64748b">ffn_gate_shexp     Q8_0   [4096, 2048]</text>
<text x="32" y="650" font-size="10" fill="#64748b">ffn_up_shexp       Q8_0   [4096, 2048]</text>
<text x="32" y="664" font-size="10" fill="#64748b">ffn_down_shexp     Q8_0   [2048, 4096]</text>
<text x="32" y="686" font-size="9" font-style="italic" fill="#94a3b8">256 experts x 3 matrices = bulk of parameters; restricted to 2-bit to fit 128 GB unified memory.</text>
<rect x="20" y="710" width="840" height="40" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="240" y="732" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">Hash routing (il &lt; 3 only)</text>
<text x="430" y="732" font-size="10" fill="#64748b">ffn_gate_tid2eid   I32   [6, 129280]   -- direct token-id -&gt; 6 experts table</text>
</svg>
<span class="figure-caption">Figure R2.4 | Per-layer tensor inventory grouped by component, with conditional presence (compressor only when ratio != 0, indexer only when ratio == 4, hash routing only for layers 0-2).</span>

<details>
<summary>ASCII original</summary>

```
HC (always):
  hc_attn_fn   F16  [hc_dim, 24]     -- attention HC pre projection
  hc_attn_scale F32 [3]              -- attention HC pre/post/comb scales
  hc_attn_base  F32 [24]             -- attention HC pre bias
  hc_ffn_fn    F16  [hc_dim, 24]     -- FFN HC pre projection
  hc_ffn_scale F32  [3]              -- FFN HC pre/post/comb scales
  hc_ffn_base  F32  [24]             -- FFN HC pre bias

Attention (always):
  attn_norm        F32  [4096]
  attn_q_a         Q8_0 [4096, 1024]
  attn_q_a_norm    F32  [1024]
  attn_q_b         Q8_0 [1024, 64*512]
  attn_kv          Q8_0 [4096, 512]
  attn_kv_a_norm   F32  [512]
  attn_sinks       F32  [64]         -- per-head sink logit
  attn_output_a    Q8_0 [8*512, 8192] -- grouped LoRA down
  attn_output_b    Q8_0 [8192, 4096]  -- LoRA up to embedding

Compressor (ratio != 0):
  attn_compressor_ape   F16  [comp_width, ratio]
  attn_compressor_kv    F16  [4096, comp_width]
  attn_compressor_gate  F16  [4096, comp_width]
  attn_compressor_norm  F32  [512]

Indexer (ratio == 4 only):
  indexer_attn_q_b         F16  [1024, 8192]
  indexer_proj             F16  [4096, 64]
  indexer_compressor_ape   F16  [index_width, 4]
  indexer_compressor_kv    F16  [4096, index_width]
  indexer_compressor_gate  F16  [4096, index_width]
  indexer_compressor_norm  F32  [128]

FFN (always):
  ffn_norm         F32  [4096]
  ffn_gate_inp     F16  [4096, 256]
  ffn_exp_probs_b  F32  [256] (optional, present in main 256-expert layers)
  ffn_gate_exps    IQ2_XXS | Q2_K | Q4_K  [4096, 2048, 256]
  ffn_up_exps      same type as gate
  ffn_down_exps    IQ2_XXS | Q2_K | Q4_K  [2048, 4096, 256]
  ffn_gate_shexp   Q8_0 [4096, 2048]
  ffn_up_shexp     Q8_0 [4096, 2048]
  ffn_down_shexp   Q8_0 [2048, 4096]

Hash routing (il < 3 only):
  ffn_gate_tid2eid I32 [6, 129280]
```

</details>

where `hc_dim = 4 * 4096 = 16384`, `comp_width = coff * 512` (with `coff = 2` for ratio-4, `coff = 1` for ratio-128), `index_width = 2 * 128 = 256`.

For 43 layers, the parameter count is dominated by:

- Routed experts: 43 * 3 * 4096 * 2048 * 256 / 256 (per-expert) = 256 experts of 25 M parameters each per layer, for `43 * 256 * 25 M ≈ 275 G` parameters in routed experts.
- The rest (HC, attention, shared experts, embeddings, output): tens of billions of parameters, all at higher precision.

The asymmetric quantization (routed experts at 2-bit, everything else at fp16 or Q8_0) is what lets a model of this depth and width fit in 96-128 GB of unified memory while still producing high-quality outputs.

---

## 10. How the Shape Surfaces in Kernels

The Metal kernels under `metal/*.metal` parameterise on the runtime-known values (`n_tokens`, `n_kv`) but rely on the compile-time constants from `ds4.c` for everything structural. Open `metal/dsv4_hc.metal` and the first thing you see is:

<svg viewBox="0 0 800 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Metal kernel arg struct ds4_metal_args_dsv4_hc_split_sinkhorn: parameterized fields with C-driver-supplied constant values">
<text x="400" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Metal kernel arg struct: parameterized but C driver always passes constants</text>
<rect x="40" y="40" width="380" height="280" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.5" rx="6"/>
<text x="230" y="60" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">metal/dsv4_hc.metal -- arg struct</text>
<text x="60" y="86" font-size="11" font-weight="600" fill="currentColor">struct ds4_metal_args_dsv4_hc_split_sinkhorn {</text>
<text x="76" y="106" font-size="11" fill="#ea580c">int32_t  n_hc;</text>
<text x="76" y="124" font-size="11" fill="#ea580c">int32_t  sinkhorn_iters;</text>
<text x="76" y="144" font-size="11" fill="#0d9488">int64_t  n_rows;</text>
<text x="76" y="162" font-size="11" fill="#0d9488">int64_t  mix_hc;</text>
<text x="76" y="180" font-size="11" fill="#7c3aed">uint64_t nb01;</text>
<text x="76" y="198" font-size="11" fill="#7c3aed">uint64_t nb1;</text>
<text x="76" y="216" font-size="11" fill="#7c3aed">float    eps;</text>
<text x="60" y="236" font-size="11" font-weight="600" fill="currentColor">};</text>
<text x="60" y="266" font-size="10" font-style="italic" fill="#64748b">Three categories of field, by who supplies the value:</text>
<rect x="50" y="276" width="14" height="14" fill="#fed7aa" stroke="#ea580c" stroke-width="1" rx="2"/>
<text x="70" y="288" font-size="10" fill="#64748b">compile-time C constants</text>
<rect x="50" y="295" width="14" height="14" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="2"/>
<text x="70" y="307" font-size="10" fill="#64748b">runtime-known (per-batch)</text>
<line x1="430" y1="120" x2="465" y2="120" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar25)"/>
<defs>
<marker id="ar25" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="470" y="40" width="310" height="280" fill="#ffffff" stroke="#cbd5e1" stroke-width="1" rx="6"/>
<text x="625" y="60" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Value the C driver always passes</text>
<rect x="480" y="76" width="290" height="50" fill="#fed7aa" stroke="#ea580c" stroke-width="1" rx="4"/>
<text x="490" y="94" font-size="10" font-weight="600" fill="#ea580c">n_hc            = DS4_N_HC = 4</text>
<text x="490" y="108" font-size="10" font-weight="600" fill="#ea580c">sinkhorn_iters  = DS4_N_HC_SINKHORN_ITER = 20</text>
<text x="490" y="122" font-size="9" font-style="italic" fill="#94a3b8">never anything else for this model</text>
<rect x="480" y="134" width="290" height="48" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="4"/>
<text x="490" y="152" font-size="10" font-weight="600" fill="#0d9488">n_rows = batch / token count</text>
<text x="490" y="166" font-size="10" font-weight="600" fill="#0d9488">mix_hc = derived from layout</text>
<text x="490" y="178" font-size="9" font-style="italic" fill="#94a3b8">change per dispatch</text>
<rect x="480" y="190" width="290" height="64" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="4"/>
<text x="490" y="208" font-size="10" font-weight="600" fill="#7c3aed">nb01, nb1 = tensor stride bytes</text>
<text x="490" y="222" font-size="10" font-weight="600" fill="#7c3aed">eps        = DS4_RMS_EPS</text>
<text x="490" y="236" font-size="9" font-style="italic" fill="#94a3b8">tensor-layout metadata; computed</text>
<text x="490" y="248" font-size="9" font-style="italic" fill="#94a3b8">at dispatch time</text>
<text x="625" y="282" text-anchor="middle" font-size="10" font-style="italic" fill="#64748b">Same pattern applies to 19 other shaders</text>
<text x="625" y="298" text-anchor="middle" font-size="10" font-style="italic" fill="#64748b">in metal/*.metal (kv, rope, moe, etc.):</text>
<text x="625" y="312" text-anchor="middle" font-size="10" font-style="italic" fill="#64748b">portable signatures, fixed callers.</text>
</svg>
<span class="figure-caption">Figure R2.5 | Metal shaders are written portably (every shape is a parameter), but the C driver always passes the DS4_N_* compile-time constants -- so the kernels effectively run for one model only.</span>

<details>
<summary>ASCII original</summary>

```
struct ds4_metal_args_dsv4_hc_split_sinkhorn {
    int32_t  n_hc;
    int32_t  sinkhorn_iters;
    int64_t  n_rows;
    int64_t  mix_hc;
    uint64_t nb01;
    uint64_t nb1;
    float    eps;
};
```

</details>

The arg struct takes `n_hc` and `sinkhorn_iters` as parameters — but they are always set to `DS4_N_HC = 4` and `DS4_N_HC_SINKHORN_ITER = 20` from the C side. The Metal side is parameterised but the values are never anything else for this model. This is the pattern: the kernels are written portably, but the C driver always passes the same constants.

The same applies to the 19 other shaders under `metal/`:

- `metal/dsv4_kv.metal` — KV cache push, compression, indexer score
- `metal/dsv4_rope.metal` — tail-RoPE rotation
- `metal/dsv4_hc.metal` — HC pre/post and Sinkhorn
- `metal/moe.metal` — routed-expert dispatch
- `metal/flash_attn.metal` — sink-aware attention
- `metal/glu.metal` — SwiGLU activation
- `metal/norm.metal`, `metal/softmax.metal`, `metal/argsort.metal`, etc.

For an MQA-extreme MLA-style model with HC, CSA+HCA attention, FP8 KV, and 2-bit MoE, this set of kernels covers everything the forward pass needs.

---

## 11. Summary

What you should remember about the model:

- **43 layers, 4096 emb, 129280 vocab, 64 Q heads, 1 wide KV head of 512, 64-dim RoPE tail.** The shape is fixed; the engine refuses any GGUF that does not match.
- **Hyper-connections** carry 4 residual streams per token through the layers, mixed by a learned 4x4 Sinkhorn-balanced matrix at every sublayer boundary.
- **MQA-extreme attention** with a wide 512-dim KV head and per-head learned sink logits. Tail-only RoPE keeps the content dims position-free so they can be compressed.
- **Layers 0-1 are dense** (no compressed KV). **Even layers from 2** use ratio-4 compression plus a 64-head indexer that selects top-512 compressed rows. **Odd layers from 3** use ratio-128 compression and visit all candidates directly.
- **Each FFN combines a Q8_0 shared expert (always-on) with 6-of-256 routed experts** at 2-bit (IQ2_XXS gate/up, Q2_K down). Routing is hash-based for layers 0-2, biased top-k afterward.
- **Asymmetric quantization** keeps everything except routed experts at higher precision. This is the reason a 284B model fits in 128 GB of unified memory without quality collapse.
- **Optional MTP head** lets the engine speculate up to 16 future tokens per step and verify them in the next pass.

Chapter 03 covers how all this shape gets read out of a GGUF file. Chapter 06 covers how `ds4_session` orchestrates prefill, decode, and live KV management.
