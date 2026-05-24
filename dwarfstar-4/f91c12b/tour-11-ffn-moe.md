# Tour Step 11: The FFN+MoE sublayer for this layer

Code version locked to `ds4@f91c12b50a` (2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

Tour step 10 ended with the attention sublayer's output integrated into the residual stream via `hc_post_one` (`ds4.c:7187`). For the same layer the FFN+MoE half now runs.

The token enters the FFN sublayer carrying a four-stream residual `inp_hc` of shape `[DS4_N_HC, DS4_N_EMBD] = [4, 4096]` (`ds4.c:114`, `ds4.c:89`). That residual was just rewritten by attention, but the FFN must run its own HC pre, its own normalization, its own sublayer body, and its own HC post — symmetric to attention's structure but acting through a totally different transform.

The body we will trace is `layer_ffn_one()` at `ds4.c:5680`. By the time it returns into `out_hc`, the layer is fully done; the next layer reads from this buffer.

DS4 has 43 layers (`ds4.c:88`). Per-layer the FFN holds 256 routed experts of shape `4096 -> 2048 -> 4096` plus one shared expert (`ds4.c:99-102`). Total FFN parameter count across 43 layers is ~6.6 GiB per layer × 43 ≈ 284 B routed parameters, but **only 6 of the 256 experts** are activated per token (`DS4_N_EXPERT_USED = 6`, `ds4.c:100`).

## 2. The problem

A four-stream residual carries the layer's working state. We need to:

1. Reduce the four streams into a single 4096-wide vector the FFN can operate on (HC pre).
2. RMSNorm that vector under `layer->ffn_norm`.
3. Pick six of 256 experts to compute against — different experts for different tokens, but cheaply enough that routing itself does not dominate cost.
4. Run the chosen experts: a quantized `gate`/`up` projection from IQ2_XXS, SwiGLU with clamp, router-weight scaling, then a Q2_K `down` projection summed across experts.
5. Also run a single shared expert (Q8_0 SwiGLU) that every token always uses.
6. Sum the routed and shared FFN outputs and write the result back into the four-stream residual (HC post).

Constraint: this happens for every prompt token, at every one of 43 layers. The wall-clock budget per token-layer FFN on an M4 Max is on the order of low milliseconds; DS4 must not stall on either router math or expert matmul. And the residual that arrives is non-trivially coupled across 4 streams, so the "split the input" step is itself a small inner optimization problem.

## 3. Naive approach

The textbook dense FFN: RMSNorm the input, project up to a fat hidden dim with `gate` and `up`, apply SwiGLU, project back down. For DS4's per-layer FFN budget this would mean either (a) running a single dense 4096 -> 11008 -> 4096 MLP, or (b) running all 256 experts dense and averaging. Use a plain residual `x + ffn(x)`, ignore HC entirely.

For routing in scheme (b), the obvious approach is plain top-6 over a 256-wide softmax with no router bias and equal weights — easy to code, "fair" to all experts.

## 4. Why the naive approach breaks

- **Dense 4096 -> 11008 -> 4096 underfits.** DeepSeek V4's design banks on a vastly larger parameter pool than a single dense FFN of that size could hold; the model loses its capacity reservoir.
- **256 dense experts is unaffordable.** Each routed expert is `4096*2048*2 + 2048*4096 ≈ 25 M FP equivalents`. Running all 256 per token per layer is `~6.4 G ops × 43 layers ≈ 275 G ops per token` just for FFN, plus the entire 6.6 GiB of routed expert weights must be touched — bandwidth-bound at well under 1 token/sec on consumer hardware.
- **Plain top-6 on probabilities collapses to a small expert subset.** Under unbiased softmax routing a few experts dominate, the rest never train, and capacity goes underused. DeepSeek V4 fixes this with two devices: a learned per-expert selection bias added to the score (`ffn_exp_probs_b`, used at `ds4.c:5360-5363`), and for the first 3 layers a deterministic token-id hash table (`ffn_gate_tid2eid`, `ds4.c:5252-5269`) that ignores logits entirely. Without those two devices, training-time load balancing collapses.
- **Naive residual `x + ffn(x)` loses gradient signal.** With 43 layers the residual stream becomes a chain of identical adds; numerical drift in any one layer is hard to attenuate. Hyper-Connections solve this by keeping four parallel residual lanes and remixing them per sublayer via a Sinkhorn-stabilized weighting, so gradient flow and forward stability both decouple across lanes.
- **Re-projecting through the HC mixer naively would cost a 16K -> 16K matmul.** The mixer must be small, and its Sinkhorn step must converge fast: 20 iterations (`DS4_N_HC_SINKHORN_ITER = 20`, `ds4.c:115`) is enough for `n_hc = 4`.

## 5. ds4's approach

ds4's approach is to compose the FFN sublayer out of six tiny, named steps inside `layer_ffn_one()` at `ds4.c:5680`, each of which is a small matmul or pointwise op, so that the full body is one allocation-light pipeline rather than a single heavy operator. The 4-stream HC residual is collapsed into a single working row, the FFN body runs on that row, and the result is expanded back into 4 streams — symmetric to how attention's HC pre/post wraps the attention body.

**Step A. HC pre (`ds4.c:5706-5712`).** `hc_pre_from_state_one(model, layer->hc_ffn_fn, layer->hc_ffn_scale, layer->hc_ffn_base, inp_hc, ffn_cur, post, comb)` does four operations (see `ds4.c:4377-4408`):

1. `rms_norm_no_weight(flat, inp_hc, hc_dim, DS4_RMS_EPS)` flattens the `[4, 4096]` HC state into a single 16384-vector and RMSNorms it (`ds4.c:4394`).
2. `matvec_f16(mix, model, fn, flat)` projects that 16384-vector through `hc_ffn_fn` (F16, `[16384, 2*n_hc + n_hc*n_hc] = [16384, 24]`) into 24 control numbers (`ds4.c:4398`).
3. `hc_split_sinkhorn_one(split, mix, scale, base, 4, 20, 1e-6)` runs **20 iterations of Sinkhorn normalization** over the first `n_hc` of the 24 numbers to produce the `split` weights (`ds4.c:4403`). This guarantees the four lane weights are nonnegative and normalize cleanly to one — the algorithmic load-balancer for HC.
4. `hc_weighted_sum_one(ffn_cur, inp_hc, split, 4096, 4)` reduces the four streams into a single 4096-wide vector using the split weights (`ds4.c:4404`).

The remaining 4 + 16 outputs of the mixer become `post` (per-stream gates for HC post) and `comb` (a `n_hc x n_hc` recombination matrix), saved for later.

**Step B. FFN RMSNorm (`ds4.c:5719-5721`).** A normal `rms_norm_weight(norm, ffn_cur, ffn_norm, 4096, 1e-6)` against `layer->ffn_norm` (F32 `[4096]`, `ds4.c:2430`). This is the standard Pre-LN that any transformer FFN has.

**Step C. Routed expert selection.** Inside `layer_routed_moe_one()` (`ds4.c:5382`) the code branches on whether the layer has a hash table:

- **First 3 layers (`il < DS4_N_HASH_LAYER = 3`, `ds4.c:103`)** use deterministic token-id-keyed selection: `layer_hash_selected_experts()` (`ds4.c:5252-5269`) looks up the row `token` of `ffn_gate_tid2eid` (a `[6, n_vocab]` `i32` table). Six experts are selected by direct table lookup — no logits computed for selection. The router probs are then computed once anyway (`layer_router_probs_one`, `ds4.c:5273-5284`) and used only for weighting via `layer_hash_router_weights_one()` (`ds4.c:5303-5313`).
- **Later 40 layers** use biased top-6: `layer_topk_selected_experts()` at `ds4.c:5338` computes `probs = sqrt(softplus(matvec_f16(ffn_gate_inp, x)))` (`ds4.c:5273-5284`), adds `layer->ffn_exp_probs_b` bias (`ds4.c:5360-5363`), runs `topk_desc(selection, 256, 6, selected)` (`ds4.c:5315-5327`, `ds4.c:5365`), and weights the chosen six by the **unbiased** probs renormalized to sum to `DS4_EXPERT_WEIGHT_SCALE = 1.5` (`ds4.c:5366-5375`, `ds4.c:55`).

This dual routing scheme is the load-balancing fix from section 4: the first three layers cannot collapse to a few experts because the table is per-token-id deterministic, and the later layers' bias keeps utilization spread.

**Step D. Routed expert body (`ds4.c:5415-5429`).** With six experts chosen, the body does:

1. `ds4_quantize_row_q8_K(x, xq, 4096)` quantizes the activation once (`ds4.c:5406`). The same `xq` feeds all six experts.
2. `matvec_iq2_xxs_experts_mid_prequant(mid_all, ...)` (`ds4.c:5416-5423`, defined at `ds4.c:3938`) runs gate and up projections from **IQ2_XXS** expert tensors for all six experts in one pass, applies the SwiGLU clamp (`DS4_SWIGLU_CLAMP_EXP = 10.0`, `ds4.c:56`), multiplies by the expert's router weight, and stores 6 mid-vectors of width 2048 (`DS4_N_FF_EXP`, `ds4.c:102`).
3. Each mid-vector is requantized to Q8_K (`ds4.c:5424-5428`).
4. `matvec_q2_k_experts_accum_prequant(out, ...)` (`ds4.c:5429`, defined at `ds4.c:4055`) runs **Q2_K** down projections from `ffn_down_exps` for all six experts and **accumulates directly into `out`**, so the routed expert sum lives in `moe[]` without a separate reduction.

**Step E. Shared expert (`ds4.c:5738`).** `layer_shared_ffn_one()` at `ds4.c:5129` runs a normal Q8_0 SwiGLU MLP for every token: `quantize_q8_0_activation`, `matvec_q8_0_pair_prequant` for gate+up, SwiGLU, then `matmul_q8_0` for down. It is the high-precision dense base every token always uses.

**Step F. Sum and HC post (`ds4.c:5746-5757`).**

```c
for (uint32_t i = 0; i < DS4_N_EMBD; i++) ffn_out[i] = moe[i] + shared[i];
hc_post_one(out_hc, ffn_out, inp_hc, post, comb, DS4_N_EMBD, n_hc);
```

`hc_post_one()` at `ds4.c:4459-4479` expands the single 4096-wide FFN output back into a `[4, 4096]` residual:

```c
for (dst = 0..n_hc) for (d = 0..n_embd)
    out_hc[dst][d] = ffn_out[d] * post[dst]
                   + sum_src( comb[dst + src*n_hc] * inp_hc[src][d] )
```

The new four-stream state is the **sublayer output gated by `post`** plus a **mixed copy of the original four streams** through `comb`. The mixing matrix is what gives HC its gradient-flow advantage over a plain residual: each lane can selectively borrow from the other three.

After step F, `out_hc` is the layer's complete residual. The next layer's attention sublayer reads it as its `inp_hc`.

## 6. Code locations

- `ds4.c:88-115` — Architecture constants: `DS4_N_LAYER = 43`, `DS4_N_EMBD = 4096`, `DS4_N_EXPERT = 256`, `DS4_N_EXPERT_USED = 6`, `DS4_N_FF_EXP = 2048`, `DS4_N_HC = 4`, `DS4_N_HC_SINKHORN_ITER = 20`, `DS4_N_HASH_LAYER = 3`.
- `ds4.c:51-56` — `DS4_RMS_EPS`, `DS4_HC_EPS`, `DS4_EXPERT_WEIGHT_SCALE`, `DS4_SWIGLU_CLAMP_EXP`.
- `ds4.c:4279-4358` — `hc_split_sinkhorn_one`: the 20-iteration Sinkhorn split.
- `ds4.c:4360-4373` — `hc_weighted_sum_one`: 4-stream reduction.
- `ds4.c:4377-4408` — `hc_pre_from_state_one_scratch`: RMSNorm + matvec_f16 + Sinkhorn + weighted sum.
- `ds4.c:4459-4479` — `hc_post_one`: 4-stream expansion with `post` gate and `comb` mix.
- `ds4.c:5129-5249` — `layer_shared_ffn_one` and its decode variant.
- `ds4.c:5252-5269` — `layer_hash_selected_experts`: token-id hash table lookup.
- `ds4.c:5273-5284` — `layer_router_probs_one`: `sqrt(softplus(logits))`.
- `ds4.c:5286-5312` — hash-route weight finalization.
- `ds4.c:5315-5327` — `topk_desc`: insertion-style top-k.
- `ds4.c:5338-5376` — `layer_topk_selected_experts` and its `_from_probs` core (bias add + top-k + unbiased weights).
- `ds4.c:5382-5476` — `layer_routed_moe_one`: branches on hash vs top-k, runs IQ2_XXS gate/up and Q2_K down.
- `ds4.c:3866-3998` — IQ2_XXS expert matvec workers (`matvec_iq2_xxs_expert_pair_prequant`, `matvec_iq2_xxs_experts_mid_prequant`).
- `ds4.c:4001-4097` — Q2_K expert matvec workers (`matvec_q2_k_expert`, `matvec_q2_k_experts_accum_prequant`).
- `ds4.c:5680-5782` — `layer_ffn_one`: the full single-token FFN orchestrator.
- `ds4.c:2393-2442` — Layer weight layout: `ffn_gate_exps`/`ffn_up_exps` IQ2_XXS, `ffn_down_exps` Q2_K, shared Q8_0, `hc_ffn_*` mixer.
- `ds4_gpu.h:570-687` — Metal MoE kernel signatures: `ds4_gpu_router_select_*`, `ds4_gpu_routed_moe_one_tensor`, `ds4_gpu_routed_moe_batch_tensor`.
- `ds4_gpu.h:688-803` — Metal HC kernel signatures: `ds4_gpu_hc_split_sinkhorn_tensor`, `ds4_gpu_hc_expand_*`, fused split+norm.
- `metal/moe.metal:136-208` — `kernel_dsv4_moe_swiglu_weight*` and `kernel_dsv4_moe_sum6_f32` (six-way down sum).
- `metal/moe.metal:929-1192` — Mul-by-id kernels for IQ2_XXS and Q4_K paired matmuls.
- `metal/dsv4_hc.metal:107-578` — Sinkhorn split, fused split+weighted-sum, fused split+sum+norm; HC expand kernels at `541-862`.

## 7. Branches and extensions

We followed the single-token CPU path through `layer_ffn_one`. The branches we skipped:

- **Batched / parallel FFN paths.** `layer_ffn_one_decode_scratch` at `ds4.c:5785` runs the same math against a pre-allocated arena; `layer_ffn_batch` at `ds4.c:5870` and `layer_ffn_shared_batch` at `ds4.c:5990` batch the shared expert and route-by-expert for prefill. The choice between them is gated by `DS4_BATCHED_FFN`, `DS4_NO_SHARED_BATCH_FFN`, and `DS4_PARALLEL_FFN` env vars at `ds4.c:7800-7810`. Chapter 09 §3 in [09-moe-hyperconnections.md](./09-moe-hyperconnections.md) covers the batching strategy and when each path is faster.
- **Metal MoE.** On Apple silicon the same six selected experts are scheduled through `ds4_gpu_routed_moe_one_tensor` / `ds4_gpu_routed_moe_batch_tensor` (`ds4_gpu.h:633-687`). The Metal path co-locates router selection on the GPU (`metal/dsv4_misc.metal:201-322` for `router_weights_one`, `router_finalize_one`, `topk_mask`, `topk_mask_scatter`). For the layout of the IQ2_XXS / Q2_K kernels see Chapter 10 §4 in [10-metal-backend.md](./10-metal-backend.md).
- **Hyper-Connections as a load-balancing analogue.** The Sinkhorn iteration count (20) and the `post`/`comb` decomposition are the HC-specific math. Chapter 09 §2 in [09-moe-hyperconnections.md](./09-moe-hyperconnections.md) derives why Sinkhorn over `n_hc = 4` converges in well under 20 steps and why the 20 is a safety margin.
- **Hash routing for early layers.** The decision to hardcode three hash-routed layers protects token-ID-rare experts from starvation during training. The runtime table is shipped in the GGUF as `ffn_gate_tid2eid` (`ds4.c:5257`); the loader verifies it at `ds4.c:2444-2448`. See Chapter 02 §6 in [02-model-architecture.md](./02-model-architecture.md) for the design rationale.
- **Steering directions.** `cpu_directional_steering_project_rows(ffn_out, steering_dirs, il, 1, steering_scale)` at `ds4.c:5750` projects out a learned set of "axis" directions from the FFN output; used by the eval harness, ignored at decode (`steering_scale = 0`). Defined in `ds4_eval.c`.
- **Quant variants.** A Q4_K high-memory variant of routed experts exists (`ds4.c:133`, kernel `kernel_mul_mv_id_q4_K_pair_*` at `metal/moe.metal:1129-1480`); the IQ2_XXS+Q2_K combination is the shipped default. See Chapter 04 §5 in [04-quantization.md](./04-quantization.md) for the expert-tensor quantization choices.

## 8. What you should now have in your head

- The FFN sublayer is six named steps: **HC pre (RMSNorm + F16 mix + Sinkhorn + weighted sum)** -> **FFN RMSNorm** -> **routed expert selection (hash for first 3 layers, biased top-6 for the other 40)** -> **routed body (IQ2_XXS gate/up, SwiGLU with router weight, Q2_K down summed)** -> **shared Q8_0 expert** -> **sum + HC post (`block_out * post + comb * residual`)**.
- Only 6 of 256 routed experts run per token (`DS4_N_EXPERT_USED = 6`, `ds4.c:100`); router probability `sqrt(softplus(logits))` is used for weighting, but selection uses `probs + ffn_exp_probs_b` (`ds4.c:5360-5363`). The first three layers bypass logits entirely and look up six experts from a per-token-id table (`ds4.c:5252-5269`).
- HC = four parallel residual streams. `hc_pre_from_state_one` (`ds4.c:4377`) reduces them to one row via a Sinkhorn-balanced weighted sum, runs 20 iterations to stabilize (`DS4_N_HC_SINKHORN_ITER`, `ds4.c:115`), and stores `post`/`comb` so `hc_post_one` (`ds4.c:4459`) can rebuild the four streams afterward.
- The expert quantization mix is **IQ2_XXS for gate/up**, **Q2_K for down**, **Q8_0 for the shared expert** (`ds4.c:2433-2442`). The activation is requantized to Q8_K once at `ds4.c:5406` and reused for all six experts.
- After this step, `out_hc[4 * 4096]` is the layer's complete output and becomes the next layer's `inp_hc` — for a 3-layer trace nothing else has run; for the real model 42 more layers follow before tour step 13 collapses the streams into logits.
