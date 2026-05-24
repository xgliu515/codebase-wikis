# Tour Step 13: HC collapse, RMSNorm, and the Q8_0 vocab head

Code version locked to `ds4@f91c12b50a` (2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

`prefill_layer_major_cpu()` at `ds4.c:7784` has walked all 43 layers, alternating attention sublayer (tour step 10), FFN+MoE sublayer (tour step 11), and on compressed layers also the compressor and indexer (tour step 12). Inside that function `cur` and `next` are two ping-ponged buffers of size `[n_tok, DS4_N_HC, DS4_N_EMBD] = [n_tok, 4, 4096]` floats (`ds4.c:7793-7796`). When the layer loop at `ds4.c:7819-7930` finishes, `cur` holds the post-layer-42 four-stream residual for every prompt position.

For our trace `./ds4 -m DS4.gguf -p "hello" -n 3` the prompt is one or two BPE tokens, so `n_tok` is small. `kv_cache_finish_prefill_states(cache, n_tok)` at `ds4.c:7932` cleans up unused compressor frontiers (see tour step 12).

But the engine has not yet produced anything sampleable. Sampling needs a `logits` vector of width `DS4_N_VOCAB = 129280` (`ds4.c:90`). The four-stream HC residual is the model's *internal* representation; the language-model head must collapse the four streams into a single 4096-vector, normalize it, and project it through the Q8_0 vocabulary matrix to get logits.

The single line that triggers all of this is `ds4.c:7934-7936`:

```c
if (logits) {
    output_logits_one(logits, model, weights, cur + (n_tok - 1) * hc_dim);
}
```

The arithmetic `cur + (n_tok - 1) * hc_dim` selects the **last** prompt position's HC state. Everything else in `cur` is discarded.

## 2. The problem

Three sub-problems must be solved together:

1. **Pick the right row.** Prefill computed HC residuals for every prompt position because all of them must be in the KV/compressed caches. But the only row we need to sample from is the **last** prompt position — its logits predict the token immediately after the prompt. Computing logits for every prompt position wastes a 4096×129280 matmul per skipped position.
2. **Collapse 4 HC streams into 1 embedding.** The four lanes were carefully maintained for residual stability; they are not equally weighted, so a naive mean would erase the per-lane scaling the model learned. We need a *learned* gating that produces nonneg weights, then a weighted sum.
3. **Normalize and project to vocab.** Standard `RMSNorm` against `output_norm.weight` (`ds4.c:2677, 2388`), then Q8_0 matmul against `output.weight` of shape `[4096, 129280]` (`ds4.c:2389`). The Q8_0 matmul is `4096 × 129280 ≈ 530 M` ops — non-trivial — so we want to run it exactly once.

End state: a fully populated `logits[129280]` ready for sampling (tour step 14).

## 3. Naive approach

Skip the HC collapse and feed any one of the four streams to the head. Or take their arithmetic mean. Then RMSNorm and project to vocab using a normal `matmul`. Alternatively: do an "early exit" — pull from some middle layer's residual rather than running all 43 layers, in the hope that intermediate representations are good enough for greedy.

## 4. Why the naive approach breaks

- **Single-stream readout discards three quarters of the residual signal.** HC's whole point is that each lane carries a slightly different residual decomposition; the four are not redundant. Picking lane 0 is equivalent to training a 4× wider residual model and then ignoring three of four channels — the model never learned to live in that mode.
- **Arithmetic mean discards the learned per-lane gating.** The HC mixer at every layer applied position-specific `post` and `comb` weights tying the lanes together. The final readout has to do its own learned gating, so the head can compensate for whatever pattern the last layer produced. A fixed `(1/4, 1/4, 1/4, 1/4)` is a model the original training never optimized for.
- **No sigmoid means weights can be negative or unbounded.** The four-stream weighted sum needs guaranteed nonneg weights so that the head behaves like a probability-of-lane gate. DS4 enforces this with `sigmoid(pre[i] * scale + base[i]) + DS4_HC_EPS` (`ds4.c:8046`), which is the strict analogue of the layer-level Sinkhorn split — except here we only need one row per token, so a sigmoid is enough.
- **Skipping layers ("early exit") loses model capability.** The reason DS4 has 43 layers is that the last few apply long-range corrections; early exit by 5 layers visibly degrades benchmarks even when greedy decode looks plausible.
- **Computing logits for every prompt position wastes work.** Each extra row costs `4096 * 129280 ≈ 530 M Q8_0 multiplies`. Multiplied across a 4 K-token prompt that's a 2 T-op tax for nothing. The Metal path explicitly hardcodes the "last row only" view; the CPU path uses the pointer arithmetic above.

## 5. ds4's approach

ds4's approach is to compose the LM head as a fixed three-stage pipeline that runs **on exactly one row** — the last prompt position. The three stages are HC collapse, RMSNorm, and Q8_0 vocabulary projection, implemented by `output_logits_one()` at `ds4.c:8057-8072`:

```c
static void output_logits_one(
        float             * logits,
        const ds4_model   * model,
        const ds4_weights * weights,
        const float       * inp_hc) {
    float *embd = xmalloc((size_t)DS4_N_EMBD * sizeof(embd[0]));
    float *norm = xmalloc((size_t)DS4_N_EMBD * sizeof(norm[0]));

    output_hc_head_one(embd, model, weights, inp_hc);
    rms_norm_weight(norm, embd, tensor_data(model, weights->output_norm),
                    DS4_N_EMBD, DS4_RMS_EPS);

    matvec_q8_0(logits, model, weights->output, norm);
    ...
}
```

**Stage A. Row selection.** Caller at `ds4.c:7935` does the row arithmetic. No extra kernel: the head receives a `float *inp_hc` already pointing at the right `[4, 4096]` slice.

**Stage B. HC collapse (`output_hc_head_one`, `ds4.c:8029-8054`).** Four operations:

```c
const uint32_t n_hc = DS4_N_HC;                       // 4
const uint64_t hc_dim = (uint64_t)DS4_N_EMBD * n_hc;  // 16384
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
```

1. **Flatten + RMSNorm.** The whole `[4, 4096] = 16384` block is treated as one vector and RMSNorm'd without a weight (`ds4.c:8040`). This is consistent with how the layer-level HC pre starts (`ds4.c:4394`).
2. **F16 projection to 4 control values.** `output_hc_fn` is `F16 [16384, 4]` (`ds4.c:2386`); `matvec_f16` gives a 4-vector `pre[4]` of pre-gates (`ds4.c:8041`).
3. **Sigmoid gate.** A single scalar `scale` (F32 [1]) and a vector `base` (F32 [4]) parameterize the gate (`ds4.c:2385, 2387`). The sigmoid + `DS4_HC_EPS` ensures `w[i] > 0` and bounded above by `1 + epsilon` (`ds4.c:8045-8047`). This is the **learned, positive-weighted, scalar-gated** version of the Sinkhorn split — the layer-level mixer used Sinkhorn because it needed an `n_hc × n_hc` matrix; the head only needs `n_hc` weights, so a sigmoid is sufficient.
4. **Weighted sum.** `hc_weighted_sum_one(out, inp_hc, w, 4096, 4)` at `ds4.c:8049` produces a single 4096-vector by `out[d] = sum_h w[h] * inp_hc[h * n_embd + d]` (`ds4.c:4360-4373`).

**Stage C. Output RMSNorm.** `rms_norm_weight(norm, embd, output_norm, 4096, DS4_RMS_EPS)` at `ds4.c:8066`, with the standard weight `output_norm.weight` (`ds4.c:2388`, `ds4.c:2677`).

**Stage D. Q8_0 vocab projection.** `matvec_q8_0(logits, model, weights->output, norm)` at `ds4.c:8068`. The output tensor is `Q8_0 [4096, 129280]` (`ds4.c:2389`). Q8_0 stores blocks of 32 int8 with one F32 scale per block; the matvec is implemented in `ds4.c` as a tiled int8 dot product. The result is a dense `float[129280]` of logits ready for the sampler.

`output_logits_one_decode_scratch()` at `ds4.c:8075-8098` is the allocation-free decode equivalent: it reuses `scratch->output_flat`, `output_pre`, `output_weights`, `output_embd`, `output_norm` instead of `xmalloc`ing per call, and uses `matvec_q8_0_decode_scratch` for the final projection.

**On the Metal path.** The release executor's per-decode state allocates `output_pre`, `output_weights`, `output_embd`, `output_norm` once at startup (`ds4.c:8271-8274`) and reuses them. The HC collapse maps to `ds4_gpu_output_hc_weights_tensor` (`ds4_gpu.h:754-762`) followed by `ds4_gpu_hc_weighted_sum_tensor` (`ds4_gpu.h:707-712`), then a Q8_0 matmul kernel for the vocab head.

When `output_logits_one` returns, `logits[0..129279]` is dense `float32` data. The caller (`prefill_layer_major_cpu`, `ds4.c:7934-7936`) will hand it to the sampler in the next tour step.

## 6. Code locations

- `ds4.c:88-90, 114` — `DS4_N_LAYER = 43`, `DS4_N_EMBD = 4096`, `DS4_N_VOCAB = 129280`, `DS4_N_HC = 4`.
- `ds4.c:54` — `DS4_HC_EPS = 1e-6f`, added inside the sigmoid gate.
- `ds4.c:53` — `DS4_RMS_EPS = 1e-6f`, used by both the HC flatten-RMSNorm and the output norm.
- `ds4.c:2120-2123` — Output tensors: `output_hc_base`, `output_hc_fn`, `output_hc_scale`, `output_norm`.
- `ds4.c:2384-2389` — Output tensor layout checks: `output_hc_base F32[4]`, `output_hc_fn F16[16384, 4]`, `output_hc_scale F32[1]`, `output_norm F32[4096]`, `output Q8_0[4096, 129280]`.
- `ds4.c:2674-2677` — GGUF binding of those tensors (`output_hc_base.weight`, etc.).
- `ds4.c:4360-4373` — `hc_weighted_sum_one`: 4-stream weighted sum used by both layer-level HC pre and the LM head.
- `ds4.c:7793-7796` — `prefill_layer_major_cpu`: `cur` / `next` HC ping-pong, shape `[n_tok, 4, 4096]`.
- `ds4.c:7819-7930` — Layer loop.
- `ds4.c:7932` — `kv_cache_finish_prefill_states(cache, n_tok)`.
- `ds4.c:7934-7936` — Head call site; `cur + (n_tok - 1) * hc_dim` selects the last prompt position.
- `ds4.c:6159-6163` — Forward declaration of `output_logits_one`.
- `ds4.c:8029-8054` — `output_hc_head_one`: RMSNorm + F16 projection + sigmoid gate + weighted sum.
- `ds4.c:8045-8047` — The sigmoid gate: `w[i] = sigmoid_stable(pre[i] * scale[0] + base[i]) + DS4_HC_EPS`.
- `ds4.c:8056-8072` — `output_logits_one`: HC collapse + output norm + Q8_0 vocab projection.
- `ds4.c:8074-8098` — `output_logits_one_decode_scratch`: scratch-arena variant used by decode.
- `ds4.c:6298-6300` — Allocation of `output_pre`, `output_weights`, `output_embd`, `output_norm` inside `cpu_decode_scratch_init`.
- `ds4.c:8271-8274` — Metal release graph state's matching `output_pre`, `output_weights`, `output_embd`, `output_norm` tensors.
- `ds4_gpu.h:754-762` — `ds4_gpu_output_hc_weights_tensor`: Metal sigmoid gate.
- `ds4_gpu.h:707-712` — `ds4_gpu_hc_weighted_sum_tensor`: Metal 4-stream weighted sum.

## 7. Branches and extensions

- **Speculative MTP head.** DS4 ships an additional "multi-token prediction" head (`mtp.0.*` tensors, `ds4.c:2734-2767`) that produces a draft token from the same final HC state. The verification path uses `output_logits_one` against both the main and MTP heads. Chapter 12 §3 in [12-speculative-mtp.md](./12-speculative-mtp.md) covers the MTP draft/verify protocol and where its head tensors plug in.
- **Decode-time scratch reuse.** During decode the head is called once per generated token. The decode-scratch variant at `ds4.c:8075` reuses arena buffers so the hot loop has zero malloc — important because `output_logits_one`'s naive variant allocates 5 buffers per call. See Chapter 06 §5 in [06-engine-session.md](./06-engine-session.md) for the scratch-arena lifecycle.
- **Per-row logits at prefill (for eval).** `ds4_eval.c` patches the prefill to call the head on every prompt row (not just the last) when computing prompt-perplexity. The standard binary skips this. Chapter 06 §6 in [06-engine-session.md](./06-engine-session.md) covers eval vs decode prefill semantics.
- **Metal path layout.** The release executor's per-decode tensors at `ds4.c:8271-8274` mirror the CPU scratch arena. The HC collapse on Metal runs as a `ds4_gpu_output_hc_weights_tensor` + `ds4_gpu_hc_weighted_sum_tensor` pair; the Q8_0 matmul reuses the generic `matmul_q8_0` kernel from `metal/dense.metal`. Chapter 10 §6 in [10-metal-backend.md](./10-metal-backend.md) covers Metal's command-buffer construction for the head.
- **Vocab size.** 129280 includes both the model's true vocabulary and reserved sentinel slots for tool-calling and reasoning. Chapter 05 §2 in [05-tokenizer-chat.md](./05-tokenizer-chat.md) maps token IDs to special semantics.
- **Sampling temperature / argmax fast path.** The `-n 3` driver in this trace uses greedy `argmax_f32` (`ds4.c:8129-8135`) over `logits`; production decode runs the full sampler with temperature, top-k, top-p, and repetition penalty. That is tour step 14, not this step.

## 8. What you should now have in your head

- The head runs **once at end-of-prefill**, on **one row** — `cur + (n_tok - 1) * hc_dim` at `ds4.c:7935`. Every earlier prompt position's HC state is computed (because the cache update requires it) and immediately discarded by the head.
- HC collapse is **flatten + RMSNorm + F16 projection to 4 numbers + sigmoid gate + 4-stream weighted sum** (`output_hc_head_one`, `ds4.c:8029-8054`). The gate is `sigmoid(pre[i] * scale + base[i]) + 1e-6` — strictly positive weights, learned per stream.
- The full head is three named stages: `output_hc_head_one` → `rms_norm_weight` → `matvec_q8_0`, wired together by `output_logits_one` at `ds4.c:8057-8072`. End-to-end inputs are one `[4, 4096]` slice plus `output_hc_*` (`F32[4]`, `F16[16384, 4]`, `F32[1]`), `output_norm` (`F32[4096]`), and `output` (`Q8_0[4096, 129280]`).
- After this step `logits[0..129279]` is a dense `float32` array sitting in the caller's buffer, ready for sampling (next tour step). Greedy decode for `-n 3` just calls `argmax_f32(logits, 129280)` at `ds4.c:8129-8135`.
- The decode-scratch version (`output_logits_one_decode_scratch`, `ds4.c:8075-8098`) is the per-token equivalent that reuses the scratch arena allocated in `cpu_decode_scratch_init` at `ds4.c:6298-6300`. The Metal release executor's matching tensors are at `ds4.c:8271-8274`.
