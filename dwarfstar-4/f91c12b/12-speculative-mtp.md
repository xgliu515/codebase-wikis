# Chapter 12: Speculative Decoding and MTP

> Code version locked to `antirez/ds4@f91c12b` (2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 12.1 The problem this chapter solves

Greedy autoregressive decoding has one inherent bottleneck: each new token requires a full forward pass through the model. For a 43-layer model like DS4, one decode step touches every layer's weights, KV cache, and activation buffers, and produces exactly one new token. The decode-step latency floor is a hardware property — you cannot go faster than the time it takes to memory-stream the weights once.

Speculative decoding is the standard escape hatch. The idea: a *cheaper* draft model proposes K tokens ahead; the full *target* model then verifies all K positions in **one** forward pass (because verification is just running the model on a known prefix and checking what it would have predicted). When the target agrees with the draft for the first `k ≤ K` positions, you've produced `k+1` tokens for the cost of roughly one full forward pass plus the cheap draft. When the agreement is high, this is close to a `K+1`× speedup; when it's low, you pay the verifier cost for nothing.

DeepSeek V4 Flash ships a built-in cheap drafter: the **MTP (Multi-Token Prediction) head**. It is a small additional transformer block (a single layer) plus an embedding projection, included alongside the main model in the GGUF file when present. Its job is exactly this: given the target model's hidden state after token `t` and the target's next-token output `token_{t+1}`, predict `token_{t+2}` cheaply.

This chapter walks the MTP-driven speculative decoding path in ds4 from the top down:

1. The MTP module itself and what makes it cheap (12.2).
2. The engine-level API and configuration (12.3).
3. The four-phase state machine in `ds4_session_eval_speculative_argmax` (12.4).
4. Step 0: free verification of `draft[0]` from base logits (12.5).
5. Recursive MTP draft generation (12.6).
6. The margin-skip fast path (12.7).
7. Verifier selection: exact N=2 vs. batched layer-major (12.8).
8. The batched verifier `metal_graph_verify_suffix_tops` (12.9).
9. The exact N=2 verifier `metal_graph_verify_decode2_exact` (12.10).
10. Prefix-1 capture and `spec_frontier_commit_prefix1` (12.11).
11. The batched output head `metal_graph_encode_output_head_batch` (12.12).
12. KV rewind via `mtp_n_raw` and `DS4_MTP_KEEP_ACCEPTED` (12.13).
13. CLI activation and the current opt-in model (12.14).
14. Performance model and the README's "slight speedup" caveat (12.15).

A central caveat up front, from `README.md:133-135`:

> The current MTP/speculative decoding path is still experimental: it is correctness-gated and currently provides at most a slight speedup, not a meaningful generation-speed win.

This is not a default-on feature. Speculative decoding in ds4 is opt-in (`--mtp FILE --mtp-draft N`), and the engineering goal is *correctness preservation under all draft outcomes*, with speed as a future improvement.

## 12.2 What MTP is

The MTP head is a small additional block that DeepSeek V4 Flash includes in its GGUF. Architecturally it consists of:

- A token embedding norm (`mtp.enorm`) and projection (`mtp.e_proj`).
- A hidden-state norm (`mtp.hnorm`) and projection (`mtp.h_proj`) over the previous step's HC residual.
- One full transformer layer (`mtp.block`) — with its own Q/KV/output projections, MoE FFN, and compressor state — that runs on top of the combined input.
- An HC-collapsing output head (`mtp.hc_head_fn`, `mtp.hc_head_scale`, `mtp.hc_head_base`) plus output norm (`mtp.norm`).

It shares the **target model's vocabulary projection** (`base_weights->output`). This is the load-bearing efficiency property: the most expensive part of computing a probability distribution over the 100K+ vocabulary is the matmul against the full vocab matrix, and MTP avoids that duplication by reusing the target's `output` weight.

```
Target model (43 layers):
  token_t -> embed -> [layer 0..42] -> h_t -> output_head -> logits_t -> argmax -> token_{t+1}

MTP draft (1 layer + projections):
  (h_t, token_{t+1})
       -> mtp.enorm + mtp.e_proj on token_{t+1}
       -> repeat into HC channels -> mtp_eproj_hc
       -> mtp.hnorm + mtp.h_proj on h_t (the HC residual) -> mtp_hproj_hc
       -> mtp_input_hc = mtp_eproj_hc + mtp_hproj_hc
       -> mtp.block.encode_decode_layer at pos = checkpoint_len + i
       -> mtp.hc_head_fn / hc_head_weights / hc_weighted_sum / norm
       -> base_weights->output matmul (vocab projection) -> draft_logits
       -> argmax -> draft_token_{t+2}
```

The implementation is `metal_graph_eval_mtp_draft_from_hc` (`ds4.c:13205-13320`). Three of the same patterns from chapter 10 appear:

1. **One big `begin_commands`/`end_commands` envelope** (`ds4.c:13227`, `13303`) — the whole draft step is one Metal command batch.
2. **Pointer-swap HC tensors** — `cur_hc` and `after_ffn_hc` are saved and restored around the call so the layer encoder works against MTP's own HC tensors (`mtp_input_hc`, `out_hc`).
3. **A separate raw cache** (`g->mtp_raw_cache`) — MTP writes its KV state into this cache, not into `layer_raw_cache[il]`. The target model's KV is undisturbed until verification succeeds.

The output head is the MTP variant `metal_graph_encode_output_head_mtp` (`ds4.c:10455-10495`), which uses MTP's HC weights but the target's vocab matmul:

```c
// ds4.c:10486-10493
if (ok) ok = ds4_gpu_matmul_q8_0_tensor(g->logits,
                                          base_model->map,
                                          base_model->size,
                                          base_weights->output->abs_offset,   // <-- target vocab
                                          DS4_N_EMBD,
                                          vocab_dim,
                                          g->output_norm,
                                          1) != 0;
```

After the draft step:

- `g->logits` holds the MTP-predicted logits for the next token.
- `g->mtp_n_raw` advances by 1 (`ds4.c:13313`) to count the new MTP KV row.
- The target model's `s->logits` is untouched; the target's KV state is untouched.

## 12.3 Engine-level API

`ds4.h` exposes three MTP-related entries:

```c
// ds4.h:188-191
int ds4_session_eval_speculative_argmax(ds4_session *s, int first_token,
                                        int max_tokens, int eos_token,
                                        int *accepted, int accepted_cap,
                                        char *err, size_t errlen);

// ds4.h:197-198
bool ds4_engine_has_mtp(ds4_engine *e);
int  ds4_engine_mtp_draft_tokens(ds4_engine *e);
```

And three configuration fields (`ds4.h:62-69`):

```c
typedef struct {
    const char *model_path;
    const char *mtp_path;             // NULL = MTP not loaded
    ds4_backend backend;
    int n_threads;
    int mtp_draft_tokens;             // max draft depth per cycle; 1 = no speculation
    float mtp_margin;                 // MTP confidence threshold for fast N=2 path
    ...
} ds4_engine_options;
```

`ds4_session_eval_speculative_argmax` is the entry point used by the CLI in greedy mode. It returns:

- `>= 1` — the number of tokens written into `accepted[]`. Even when speculation fully fails, `first_token` is always accepted (it was already committed before any draft work).
- `-1` — internal error; `err` is populated.

The contract is: every call accepts at least one token, never blocks waiting for input, and leaves the session in a fully-defined state. There is no "tentative accept" or "must call commit later" — the function either commits or rolls back atomically.

`ds4_engine_mtp_draft_tokens` (`ds4.c:16414-16416`) returns the configured depth only when MTP is actually loaded and the backend is GPU:

```c
int ds4_engine_mtp_draft_tokens(ds4_engine *e) {
    return e && e->backend != DS4_BACKEND_CPU && e->mtp_ready ? e->mtp_draft_tokens : 0;
}
```

The CPU backend (`DS4_BACKEND_CPU`) does not have MTP-on-GPU plumbing, so it always reports 0 regardless of configuration.

## 12.4 The four-phase state machine

The state-machine comment at `ds4.c:18309-18315` lays out the algorithm:

```c
/* Speculative decode state machine:
 * 1. commit the normal target token and use its logits to validate draft[0];
 * 2. let MTP recursively draft a tiny suffix from its own raw-cache frontier;
 * 3. verify the suffix with the target graph, committing only the accepted
 *    prefix and rolling back speculative Metal state on miss;
 * 4. fall back to ordinary one-token decode if the fast verifier cannot prove
 *    the target stream. */
```

The function body (`ds4.c:18316-18900`) implements those four phases plus several intermediate fast paths. The structural shape:

```
ds4_session_eval_speculative_argmax(s, first_token, ...) {
    ds4_session_eval(s, first_token)         // PHASE 1: commit first_token
    accepted[0] = first_token
    if (!mtp_ready || draft_tokens <= 1) return 1
    if (sample_argmax(base logits) != drafts[0]) return 1   // free verify draft[0]

    for (i = 1; i < draft_cap; i++)          // PHASE 2: generate drafts[1..]
        metal_graph_eval_mtp_draft_from_hc(...)

    if (margin < threshold)                  // FAST PATH: margin-skip
        return single-token decode of drafts[0]

    if (draft_n == 2 && strict_mtp)          // PHASE 3a: exact N=2 verifier
        metal_graph_verify_decode2_exact(...)
    else                                     // PHASE 3b: batched layer-major
        metal_graph_verify_suffix_tops(...)

    if (verifier failed) {                   // PHASE 4: fallback
        restore frontier
        for each draft: metal_graph_eval_token_raw_swa_top(...)
    }

    return n_accept
}
```

Each phase has its own bookkeeping for the MTP raw cache (12.13) and for the target's compressor frontiers (12.11). The complexity is in the *recovery* paths — what to do when a draft is partially accepted, or when the verifier itself fails.

## 12.5 Phase 1: free verification of `draft[0]`

After `ds4_session_eval(s, first_token)` commits the first token (`ds4.c:18345`), `s->logits` holds the target's full vocab distribution for what the next token *would* be. The MTP draft from the *previous* decode cycle is stored in `s->mtp_draft_token`. The verification is a single CPU-side comparison:

```c
// ds4.c:18361, 18387-18392
drafts[0] = s->mtp_draft_token;
...
if (sample_argmax(s->logits, DS4_N_VOCAB) != drafts[0]) {
    if (getenv("DS4_MTP_SPEC_LOG")) {
        fprintf(stderr, "ds4: mtp spec miss first draft=%d\n", drafts[0]);
    }
    return n_accept;
}
```

This is "free verification" because the comparison costs no GPU work — the target logits are already on host from the just-completed `ds4_session_eval`. Three outcomes:

- **Match.** Continue to phase 2.
- **No match.** Bail; `first_token` is already accepted. The whole speculative cycle saves nothing this round.
- **EOS as draft.** `draft_cap = 1` (line 18393) — even if `draft[0]` was EOS, we're not generating further drafts past it.

The previous-cycle MTP draft is produced by `ds4_session_eval_internal` when `mtp_ready` is true (`ds4.c:18260-18301`):

```c
// abridged
const bool need_mtp_draft = e->mtp_ready && s->mtp_draft_valid_after_eval &&
    (e->mtp_draft_tokens > 1 || mtp_probe_log);
if (need_mtp_draft) {
    int mtp_top = -1;
    metal_graph_eval_mtp_draft_from_hc(&s->graph, ...,
                                       s->graph.mtp_input_hc, s->graph.mtp_state_hc,
                                       target_token, pos,
                                       getenv("DS4_MTP_FULL_LOGITS") ? s->mtp_logits : NULL,
                                       &mtp_top);
    s->mtp_draft_token = mtp_top >= 0 ? mtp_top : sample_argmax(s->mtp_logits, DS4_N_VOCAB);
    s->mtp_draft_valid = true;
}
```

So every normal decode step produces a draft for the *next* cycle, free, as long as MTP is loaded. The "free draft[0] verify" then becomes a single argmax comparison at the start of the speculative call.

## 12.6 Phase 2: recursive MTP draft generation

If `draft[0]` matched and `draft_cap > 1`, the engine runs MTP recursively to produce `drafts[1..draft_cap-1]`. Each iteration:

1. Take the previous MTP HC state.
2. Run one MTP layer (`metal_graph_eval_mtp_draft_from_hc`).
3. Read out the top token (or full logits if needed) and store it in `drafts[i]`.
4. Stop at EOS.

The loop (`ds4.c:18407-18430`):

```c
for (; draft_n < draft_cap; draft_n++) {
    ds4_gpu_tensor *prev_hc = (draft_n & 1) ? s->graph.mtp_state_hc : s->graph.mtp_next_hc;
    ds4_gpu_tensor *out_hc  = (draft_n & 1) ? s->graph.mtp_next_hc  : s->graph.mtp_state_hc;
    int mtp_top = -1;
    if (!metal_graph_eval_mtp_draft_from_hc(&s->graph, ...,
                                            prev_hc, out_hc,
                                            drafts[draft_n - 1],
                                            (uint32_t)(s->checkpoint.len + draft_n - 1),
                                            mtp_need_logits ? s->mtp_logits : NULL,
                                            &mtp_top))
    {
        return n_accept;
    }
    drafts[draft_n] = mtp_top >= 0 ? mtp_top : sample_argmax(s->mtp_logits, DS4_N_VOCAB);
    if (drafts[draft_n] == eos_token) {
        draft_n++;
        break;
    }
}
```

Two HC tensors `mtp_state_hc` and `mtp_next_hc` ping-pong between iterations (the `(draft_n & 1)` selector). Each MTP layer reads the previous step's HC residual and writes the next. The previous draft token is embedded fresh into `mtp_embed`/`mtp_input_hc` inside the `_from_hc` helper.

Performance: each iteration is roughly **one MTP transformer layer + one vocab matmul + one indexer top-1**. The MTP layer is on the order of 1/43 the cost of a full decode (43 target layers). The vocab matmul is the same cost as a target output head (~25-50% of a decode step in practice). So one MTP draft step is roughly 0.3-0.5× one target decode step.

For `draft_n == 2` (the default), draft generation costs ~0.3-0.5× a target decode beyond `first_token`. That's the budget being spent in exchange for a possible 2× throughput.

### 12.6.1 The MTP raw cache

The previous-step MTP KV row was written into `g->mtp_raw_cache` at position `s->checkpoint.len + draft_n - 2`. The new step writes at `s->checkpoint.len + draft_n - 1`. The raw cache is a SWA ring of size `g->raw_window` (128 rows), so positions wrap modulo the ring. The MTP "frontier" is just an integer counter (`g->mtp_n_raw`), incremented by `metal_graph_eval_mtp_draft_from_hc` on success (`ds4.c:13313`):

```c
if (ok && g->mtp_n_raw < g->raw_window) g->mtp_n_raw++;
```

After verification finishes, the counter is reset to reflect which drafts were actually accepted. This is the elegant part: MTP doesn't need an explicit rollback mechanism — the counter alone decides which rows are "live" and which are stale.

## 12.7 Phase 2b: the margin-skip fast path

When MTP is unconfident in `drafts[1]`, running the full target verifier is expensive and usually wasted. The margin-skip path takes a cheap exit:

```c
// ds4.c:18438-18479 (abridged)
if (!strict_mtp && draft_n == 2 && mtp_margin_threshold > 0.0f) {
    // Compute MTP's top-2 logit margin on drafts[1]
    if (!mtp_conf_log) {
        float v0 = 0.0f, v1 = 0.0f;
        logits_top2(s->mtp_logits, DS4_N_VOCAB, &mtp_last_top0, &v0, &mtp_last_top1, &v1);
        mtp_last_margin = v0 - v1;
    }
    if (mtp_last_margin < mtp_margin_threshold) {
        // MTP isn't confident; just do one target decode for drafts[0].
        float *row_logits = xmalloc((size_t)DS4_N_VOCAB * sizeof(row_logits[0]));
        const int start = s->checkpoint.len;
        bool ok = metal_graph_eval_token_raw_swa(&s->graph, &e->model, &e->weights,
                                                 drafts[0], (uint32_t)start, row_logits);
        ...
        memcpy(s->logits, row_logits, ...);
        token_vec_push(&s->checkpoint, drafts[0]);
        accepted[n_accept++] = drafts[0];
        DS4_MTP_KEEP_ACCEPTED(1);
        return n_accept;
    }
}
```

The trigger:

- `!strict_mtp` (not in quality mode).
- `draft_n == 2` (exactly the standard case).
- `mtp_margin_threshold > 0.0f` (margin gate is on).
- MTP's top-1 vs top-2 gap on `drafts[1]` is below the threshold (default 3.0, configurable via `--mtp-margin F` or `DS4_MTP_MIN_MARGIN`).

When triggered, the engine commits `drafts[0]` via a normal single-token decode and returns. The N=2 verifier never runs; the cost of the failed speculative cycle is just one target decode (which would have been needed anyway) plus the MTP draft work (already done).

**Why margin works as a predictor.** When MTP's top-1 and top-2 are within 3 logits, MTP is essentially a coin flip — the draft is at most ~95% likely to be right, and conditional on being wrong the verifier has spent its budget for nothing. Below the threshold, the expected cost-vs-gain ratio of running the verifier flips negative.

The 3.0 threshold is the CLI default (`ds4_cli.c:1414-1415`):

```c
.mtp_draft_tokens = 1,
.mtp_margin = 3.0f,
```

(The `.mtp_draft_tokens = 1` field-default is the speculation-disabled state; users opt in with `--mtp-draft 2`.)

`DS4_MTP_CONF_LOG=1` prints the per-cycle margin and acceptance stats, which is how the 3.0 default was chosen empirically.

## 12.8 Verifier selection

After margin-skip is exhausted, the engine picks one of two verifiers (`ds4.c:18489-18491`):

```c
const bool use_decode2_exact =
    draft_n == 2 && strict_mtp && getenv("DS4_MTP_BATCH_VERIFY") == NULL;
```

The decision tree:

```
                  draft_n
                /         \
              == 2         > 2 (rare; only with --mtp-draft 3+)
             /              \
       strict_mtp?            metal_graph_verify_suffix_tops
       /         \
      Yes         No
       |           |
   DS4_MTP_BATCH   metal_graph_verify_suffix_tops
   _VERIFY set?
   /         \
  Yes         No
   |           |
   _verify_   metal_graph_verify_decode2_exact
   suffix_
   tops
```

Two verifiers:

1. **`metal_graph_verify_suffix_tops`** (12.9). Layer-major batched verifier, same kernels as prefill. Fast but uses batch reductions, which can produce slightly different greedy outputs for nearly-tied logits.

2. **`metal_graph_verify_decode2_exact`** (12.10). N=2-specific. Runs the exact decode kernels but interleaves two tokens layer-by-layer within one command stream. Slower but preserves the byte-identical output of sequential one-token decode.

The trade-off comment (`ds4.c:18481-18488`):

```c
/*
 * The useful N=2 verifier is the tiny batch path: it verifies two target
 * positions in one layer-major pass and commits prefix-1 directly on a
 * partial accept.  Like the rest of the non-quality Metal path, it may pick
 * a different greedy token when batched reductions perturb nearly-tied
 * logits.  --quality / DS4_MTP_STRICT selects the exact decode verifier,
 * which preserves the one-token target stream but is not a speed win.
 */
```

So:

- Normal users: batched verifier. Slightly different tied-logit handling, but no quality loss; faster.
- `--quality` users: exact verifier. Matches the deterministic-decoded output byte-for-byte.
- `DS4_MTP_BATCH_VERIFY=1` even under `--quality`: lets benchmarkers measure batched-verifier performance without changing the underlying quality flag everywhere.

## 12.9 The batched verifier: `metal_graph_verify_suffix_tops`

`metal_graph_verify_suffix_tops` (`ds4.c:14039-14111`) processes all draft tokens together as a `draft_n`-row mini-prefill ubatch. It is structurally identical to the prefill encoder, with one extra step (the batched output head) and one extra readback (per-row top tokens):

```c
// ds4.c:14054-14110 (abridged)
bool ok = metal_graph_upload_prompt_tokens(g->prefill_tokens, prompt, start, n_tokens);
if (ok) ok = metal_graph_upload_prompt_embeddings_hc(g->batch_cur_hc, ...);

const bool saved_capture = g->spec_capture_prefix1;
g->spec_capture_prefix1 = capture_prefix1 && n_tokens == 2;

ok = ds4_gpu_begin_commands() != 0;
for (uint32_t il = 0; ok && il < DS4_N_LAYER; il++) {
    ok = metal_graph_encode_layer_batch(g, model, &weights->layer[il],
                                        il, start, n_tokens);
}
if (ok) ok = ds4_gpu_end_commands() != 0;
g->spec_capture_prefix1 = saved_capture;

ok = ds4_gpu_begin_commands() != 0;
if (ok) ok = metal_graph_encode_output_head_batch(g, model, weights, n_tokens, vocab_dim);
if (ok) {
    if (top_rows) {
        ok = ds4_gpu_indexer_topk_tensor(g->comp_selected, g->spec_logits,
                                         DS4_N_VOCAB, 1, top_rows) != 0;
    }
}
if (ok) ok = ds4_gpu_end_commands() != 0;

if (ok && top_rows) {
    ok = ds4_gpu_tensor_read(g->comp_selected, 0, row_tops, top_rows * sizeof(row_tops[0]));
}
if (ok && row_logits) {
    ok = ds4_gpu_tensor_read(g->spec_logits, 0, row_logits, n_tokens * DS4_N_VOCAB * ...);
}
```

Three parts:

1. **Layer-major batched encode** (lines 14067-14076). Reuses `metal_graph_encode_layer_batch` from prefill — same kernels, same fused HC ops, same compressor frontier updates. The only difference is the optional `spec_capture_prefix1` flag enabled for `n_tokens == 2` so the per-layer encoder snapshots the post-token-0 frontiers (12.11).

2. **Batched output head + per-row top-1** (lines 14081-14094). `metal_graph_encode_output_head_batch` computes vocab logits for all `n_tokens` rows in one pass (12.12). `ds4_gpu_indexer_topk_tensor` with `top_k=1` then reduces each row's logits to a single int32 top index. The whole pipeline stays on GPU; the host only reads back `top_rows * sizeof(int32)` integers and optionally the last row's full logits.

3. **Verification on host** (in the caller, `ds4.c:18621-18625`):

   ```c
   int commit_drafts = 1;
   for (int i = 1; i < draft_n; i++) {
       if (row_tops[i - 1] != drafts[i]) break;
       commit_drafts++;
   }
   ```

   The verifier proves draft `i` if the target's top-1 token at position `i-1` matches `drafts[i]`. The first mismatch ends the accepted prefix.

The verifier's *cost* is one `n_tokens`-row prefill plus one `n_tokens`-row batched output head plus one batched top-1. For `n_tokens=2`, that's far cheaper than two single-token decodes — empirically about 1.2-1.5× the cost of one single decode, not 2×.

### 12.9.1 Why batching can perturb tied logits

In the per-layer batch encoder, several kernels do reductions across `n_tokens` rows (e.g. the RMS-norm `rms_norm_plain_rows_tensor` computes a per-row mean independently, but the matmul kernel's row-wise vector dot uses warp-shuffle accumulation that picks up rows in different orders for `n_tokens > 1` vs. `n_tokens == 1`). The accumulator schedule difference is in the 7th decimal place of the final logits — well below the model's actual precision.

But for *tied* logits (two tokens with identical probability under the model), a 7th-decimal nudge can flip which one wins the argmax. This is what the comment at `ds4.c:18484-18486` is warning about. It doesn't change generation quality; it makes the output non-byte-identical to one-token decode. `--quality` mode is for users who need exact-match-with-non-speculative-decode reproducibility.

## 12.10 The exact N=2 verifier: `metal_graph_verify_decode2_exact`

`metal_graph_verify_decode2_exact` (`ds4.c:14130-14259`) interleaves two tokens through the decode kernels within one command stream, in layer order:

```
For il in 0..42:
  encode_decode_layer(il, token0, pos=start)
  capture_prefix1_attn_state(il)           // <-- between tokens, save frontier
  capture_prefix1_index_state(il)
  encode_decode_layer(il, token1, pos=start+1)
```

The code (`ds4.c:14170-14210`):

```c
if (ok) ok = ds4_gpu_begin_commands() != 0;
for (uint32_t il = 0; ok && il < DS4_N_LAYER; il++) {
    const uint32_t pos0 = start;
    const uint32_t pos1 = start + 1u;

    g->cur_hc = cur0; g->after_ffn_hc = next0;
    ok = metal_graph_encode_decode_layer(g, model, &weights->layer[il], il, pos0,
                                         g->layer_raw_cache[il], g->raw_cap,
                                         pos0 % g->raw_cap,
                                         metal_graph_raw_span_for_batch(g, pos0, 1),
                                         token0);
    if (!ok) break;
    ok = metal_graph_capture_prefix1_attn_state(g, il) &&
         metal_graph_capture_prefix1_index_state(g, il);
    if (!ok) break;

    g->cur_hc = cur1; g->after_ffn_hc = next1;
    ok = metal_graph_encode_decode_layer(g, model, &weights->layer[il], il, pos1,
                                         g->layer_raw_cache[il], g->raw_cap,
                                         pos1 % g->raw_cap,
                                         metal_graph_raw_span_for_batch(g, pos1, 1),
                                         token1);
    if (!ok) break;

    ds4_gpu_tensor *tmp = cur0; cur0 = next0; next0 = tmp;
    tmp = cur1; cur1 = next1; next1 = tmp;
}
if (ok) ok = ds4_gpu_end_commands() != 0;
```

Three key properties:

1. **One command buffer.** All 43 × (encode-token0 + capture-prefix1 + encode-token1) operations are encoded into one `MTLCommandBuffer` (or queued on the CUDA stream). No layer-boundary synchronization point.

2. **Cache update order matches sequential decode.** Within layer `il`, token0 writes its KV row before token1 sees that row. The KV ring's `raw_row = pos % raw_cap` policy ensures the two rows don't collide. The compressor state is also updated in the same order as it would be in two sequential one-token decodes.

3. **Prefix-1 capture happens between token0 and token1.** Each layer's post-token-0 compressor frontier is snapshotted into `spec_prefix1_attn_state_*` and `spec_prefix1_index_state_*` (12.11). If the verifier ends up only accepting token0, the cached frontiers are committed without replaying anything.

After the layer loop, the function runs two separate output heads — one for token0 (`g->cur_hc = cur0`, lines 14215-14233), one for token1 (`g->cur_hc = cur1`, lines 14236-14249). The output heads are *not* batched, because the batched output head can have the same tied-logit perturbation as the verifier; using the one-row head preserves bit-exact match.

The function returns `top0` (target's top-1 after token0) plus `logits0` and `logits1` (full logits after each). The caller (`ds4.c:18514`) checks `row0_top == drafts[1]`:

- Match: full accept. Commit both tokens, copy `logits1` to `s->logits`, advance MTP cache by 2.
- Mismatch: partial accept. Commit token0, copy `logits0` to `s->logits`, advance MTP cache by 1, and commit the prefix-1 frontier via `spec_frontier_commit_prefix1`.

## 12.11 Prefix-1 capture and commit

### 12.11.1 Capture

`metal_graph_capture_prefix1_attn_state` (`ds4.c:9180-9188`):

```c
static bool metal_graph_capture_prefix1_attn_state(ds4_gpu_graph *g, uint32_t il) {
    if (!g->spec_capture_prefix1 || !g->spec_prefix1_attn_state_kv[il]) return true;
    const uint64_t bytes = ds4_gpu_tensor_bytes(g->layer_attn_state_kv[il]);
    g->spec_prefix1_n_comp[il] = g->layer_n_comp[il];
    return ds4_gpu_tensor_copy(g->spec_prefix1_attn_state_kv[il], 0,
                                 g->layer_attn_state_kv[il], 0, bytes) != 0 &&
           ds4_gpu_tensor_copy(g->spec_prefix1_attn_state_score[il], 0,
                                 g->layer_attn_state_score[il], 0, bytes) != 0;
}
```

And the indexer-state variant `metal_graph_capture_prefix1_index_state` at `ds4.c:9190-9198`.

The capture is **just three small device-to-device copies plus one int32 store** per compressed layer:

- `layer_attn_state_kv` → `spec_prefix1_attn_state_kv` (a few KiB per layer)
- `layer_attn_state_score` → `spec_prefix1_attn_state_score` (same)
- `spec_prefix1_n_comp[il] = layer_n_comp[il]` (one int)
- For ratio-4 layers, the same trio for `index_state_*` and `n_index_comp`.

Why this is cheap: only the compressor *frontier* needs to be saved, not the full KV cache. The raw SWA ring has 8192 rows in long-context mode (and only 128 are actually visible); writing token1's row into the ring at `(pos+1) % raw_cap` doesn't displace any row that's still in token0's visible window. Only the compressor state — which is small and per-layer — needs to be snapshottable.

The comment context at the capture site is in chapter 10's data structure section, but the load-bearing insight is at `ds4.c:18583-18589`:

```c
/*
 * The production MTP depth is two.  Prefix-1 capture makes partial
 * accepts cheap, but it copies per-layer compressor frontiers even when
 * both draft tokens are accepted.  Full accepts are the path that makes
 * MTP worthwhile, so by default we snapshot before the verifier and
 * replay one token on partial accept.  DS4_MTP_CAPTURE_PREFIX1 restores
 * the older no-replay partial path for measurement.
 */
```

So in batched-verifier mode (12.9), prefix-1 capture is gated by `capture_prefix1` (line 18590):

```c
const bool capture_prefix1 =
    draft_n == 2 && (!strict_mtp || getenv("DS4_MTP_CAPTURE_PREFIX1") != NULL);
```

Without prefix-1 capture, partial accepts cost an additional one-token replay (`metal_graph_eval_token_raw_swa` at `ds4.c:18732`) — the partial-accept path becomes "restore the full pre-verifier snapshot, then replay token0 with the normal decode path." That's slower but doesn't double-pay on full accepts.

### 12.11.2 Commit

When partial-accept happens *with* prefix-1 capture, `spec_frontier_commit_prefix1` (`ds4.c:16502-16527`) does the inverse copy: snapshot → live state.

```c
static bool spec_frontier_commit_prefix1(ds4_session *s) {
    ds4_gpu_graph *g = &s->graph;
    bool ok = ds4_gpu_begin_commands() != 0;
    for (uint32_t il = 0; ok && il < DS4_N_LAYER; il++) {
        const uint32_t ratio = ds4_layer_compress_ratio(il);
        if (ratio == 0) continue;

        g->layer_n_comp[il] = g->spec_prefix1_n_comp[il];
        const uint64_t ab = ds4_gpu_tensor_bytes(g->layer_attn_state_kv[il]);
        ok = ds4_gpu_tensor_copy(g->layer_attn_state_kv[il], 0,
                                   g->spec_prefix1_attn_state_kv[il], 0, ab) != 0 &&
             ds4_gpu_tensor_copy(g->layer_attn_state_score[il], 0,
                                   g->spec_prefix1_attn_state_score[il], 0, ab) != 0;
        if (ok && ratio == 4) {
            g->layer_n_index_comp[il] = g->spec_prefix1_n_index_comp[il];
            const uint64_t ib = ds4_gpu_tensor_bytes(g->layer_index_state_kv[il]);
            ok = ds4_gpu_tensor_copy(g->layer_index_state_kv[il], 0,
                                       g->spec_prefix1_index_state_kv[il], 0, ib) != 0 &&
                 ds4_gpu_tensor_copy(g->layer_index_state_score[il], 0,
                                       g->spec_prefix1_index_state_score[il], 0, ib) != 0;
        }
    }
    if (ok) ok = ds4_gpu_end_commands() != 0;
    else (void)ds4_gpu_synchronize();
    return ok;
}
```

The commit-prefix1 cost is ~43 small device-to-device copies (only the compressed layers, around 30 of the 43, actually run). At a few KiB each, the whole operation is a few hundred microseconds — dramatically cheaper than replaying one full token decode.

What happens to the second draft row's data in the various caches:

- **Raw SWA ring.** Token1's row at `(pos+1) % raw_cap` is still physically present, but logically out-of-window because `s->checkpoint.len` rewinds to `start + 1` (only token0 accepted). Next decode step writes at `(pos+1) % raw_cap` — the same slot — overwriting it.
- **Attention compressor cache.** `layer_n_comp[il]` is restored; the second row's contribution to compressed pool is invisible.
- **Indexer compressor cache.** Same; `layer_n_index_comp[il]` restored.

No memory zeroing is needed; the counters alone make the unwanted rows "vanish."

## 12.12 The batched output head

`metal_graph_encode_output_head_batch` (`ds4.c:10326-10408`) computes vocab logits for every row of `batch_cur_hc` in one batched run. It mirrors the per-row `metal_graph_encode_output_head` (chapter 10.7.4) but operates on `n_tokens` rows simultaneously:

```c
static bool metal_graph_encode_output_head_batch(
        ds4_gpu_graph *g,
        const ds4_model       *model,
        const ds4_weights     *weights,
        uint32_t               n_tokens,
        uint64_t               vocab_dim) {
    if (n_tokens == 0 || n_tokens > g->prefill_cap || !g->spec_logits) return false;
    ...
    ok = ds4_gpu_rms_norm_plain_rows_tensor(g->batch_flat_hc, g->batch_cur_hc, hc_dim, n_tokens, DS4_RMS_EPS);
    ok = ds4_gpu_matmul_f16_tensor(output_pre, ..., hc_dim, DS4_N_HC, g->batch_flat_hc, n_tokens);
    ok = ds4_gpu_output_hc_weights_tensor(output_weights, output_pre, ..., DS4_N_HC, DS4_HC_EPS);
    ok = ds4_gpu_hc_weighted_sum_tensor(output_embd, g->batch_cur_hc, output_weights, DS4_N_EMBD, DS4_N_HC);
    ok = ds4_gpu_rms_norm_weight_rows_tensor(output_norm, output_embd, ..., DS4_N_EMBD, n_tokens, DS4_RMS_EPS);
    ok = ds4_gpu_matmul_q8_0_tensor(logits, ..., DS4_N_EMBD, vocab_dim, output_norm, n_tokens);
    ...
}
```

Six stages, each operating on `n_tokens` rows. The output is written to `g->spec_logits`, which is sized as `prefill_cap * vocab_size * 4 bytes`. (At `prefill_cap=4096`, that's ~1.5 GB on a 90K-vocab model — sized once at session start.)

After the batched head, the caller in `metal_graph_verify_suffix_tops` calls `ds4_gpu_indexer_topk_tensor` (`ds4.c:14089`) with `top_k=1` to reduce each row to a single int32. The CPU then reads `row_tops[0..n_tokens-2]` (the per-row top ids) and optionally `spec_logits[n_tokens-1]` (the last row's full logits) — only two `ds4_gpu_tensor_read` calls regardless of `draft_n`.

Compared to running the one-row output head `n_tokens` times sequentially:

- The HC collapse and vocab projection are batched, so the GPU utilization is much higher (especially on CUDA where small per-call launches have overhead).
- One Metal command buffer instead of `n_tokens`.
- One readback instead of `n_tokens`.

For `n_tokens=2`, the wall-clock cost is roughly 1.3-1.5× one head, not 2×.

## 12.13 KV rewind via `mtp_n_raw` and `DS4_MTP_KEEP_ACCEPTED`

The MTP raw cache rollback is implemented as a counter update only. Lines `ds4.c:18401-18405`:

```c
const uint32_t mtp_base_raw = s->graph.mtp_n_raw;
#define DS4_MTP_KEEP_ACCEPTED(n_) do { \
    uint32_t keep_ = mtp_base_raw + (uint32_t)(n_); \
    if (keep_ > s->graph.raw_window) keep_ = s->graph.raw_window; \
    s->graph.mtp_n_raw = keep_; \
} while (0)
```

The macro captures `mtp_base_raw` at function entry — that's the MTP cache row count before any drafting started this cycle. Then on each exit path, `DS4_MTP_KEEP_ACCEPTED(n)` sets the cache count to `base + n`, where `n` is the number of drafts that ended up being committed:

| Outcome | Macro call | Resulting `mtp_n_raw` |
|---------|-----------|------------------------|
| Full N=2 accept | `DS4_MTP_KEEP_ACCEPTED(2)` | base + 2 (cap at `raw_window`) |
| Partial accept (only token0) | `DS4_MTP_KEEP_ACCEPTED(1)` | base + 1 |
| Margin skip (token0 only) | `DS4_MTP_KEEP_ACCEPTED(1)` | base + 1 |
| Total failure | `DS4_MTP_KEEP_ACCEPTED(0)` | base (no advance) |

The `#undef` at line 18883 scopes the macro to just this function — it's intentionally local.

The MTP raw cache is *only* used by `metal_graph_eval_mtp_draft_from_hc` for its own KV reads in the next draft cycle. Since the cache is a ring and the next draft will write at `mtp_n_raw % raw_window`, rolled-back rows are overwritten on the next call. No memory traffic, no zeroing — just a counter.

### 12.13.1 Why the target's raw cache doesn't need a similar mechanism

The target model's `layer_raw_cache[il]` *does* get written to by the verifier — each verifier kernel writes token0's and token1's KV rows into the ring at their physical positions. On a partial accept, token1's row is logically out-of-window (12.11.2), and the next decode step writes at `(pos+1) % raw_cap` — the same slot — overwriting it. So the same "counter-based rollback" pattern applies, but the counter here is `s->checkpoint.len` rather than a dedicated `n_raw`.

The compressor frontier is the one piece that needs an explicit copy-out / copy-in. Hence the `spec_prefix1_*` tensors in `ds4_gpu_graph` (chapter 10.6) and the `metal_graph_capture_prefix1_*` / `spec_frontier_commit_prefix1` pair described above.

## 12.14 CLI activation

The interactive and one-shot CLI paths both use `ds4_session_eval_speculative_argmax` when three conditions hold (`ds4_cli.c:530-532`):

```c
if (cfg->gen.temperature <= 0.0f && ds4_engine_mtp_draft_tokens(engine) > 1 &&
    getenv("DS4_MTP_SPEC_DISABLE") == NULL) {
    ntok = ds4_session_eval_speculative_argmax(session,
                                               token,
                                               max_tokens - generated,
                                               ds4_token_eos(engine),
                                               toks, sizeof(toks)/sizeof(toks[0]),
                                               err, sizeof(err));
} else {
    ds4_session_eval(session, token, err, sizeof(err));
    toks[0] = token;
    ntok = 1;
}
```

Three gates:

1. **Greedy decoding required.** `temperature <= 0.0f`. Speculative decoding with sampling needs rejection sampling against the target distribution; ds4 implements only the argmax variant. Setting `--temp 1.0` (the default) disables speculation automatically.

2. **MTP must be configured.** `ds4_engine_mtp_draft_tokens(engine) > 1`. This requires:
   - `--mtp FILE` was passed (loads the MTP GGUF).
   - `--mtp-draft N` was passed with `N >= 2`.
   - The backend is GPU (CPU backend always returns 0).

3. **No environment override.** `DS4_MTP_SPEC_DISABLE` is unset.

The default CLI configuration (`ds4_cli.c:1411-1416`) has `mtp_draft_tokens = 1`, which means **speculation is off by default even with `--mtp` loaded** — you must explicitly pass `--mtp-draft 2` (or higher).

The same logic appears in the chat-mode loop (`ds4_cli.c:1178-1180`) — both paths share the activation gate.

### 12.14.1 No `--no-mtp` flag exists

In contrast to the previous wiki revision's description of MTP as a default-on feature with a `--no-mtp` opt-out, the current code at `f91c12b` has speculation **opt-in only**. The runtime opt-out is `DS4_MTP_SPEC_DISABLE` (env var), used mainly for A/B testing and CI cross-checks against non-speculative output. There is no CLI flag to disable speculation once enabled because the user already had to actively turn it on; turning it off is one decision earlier.

The README's framing matches (`README.md:131-135`):

> `./download_model.sh mtp` fetches the optional speculative decoding support GGUF. It can be used with q2-imatrix, q4-imatrix, q2, and q4, but must be enabled explicitly with `--mtp`. The current MTP/speculative decoding path is still experimental: it is correctness-gated and currently provides at most a slight speedup, not a meaningful generation-speed win.

This is the operative public statement about MTP at f91c12b.

## 12.15 Performance model and the README's "slight speedup"

The README's framing is honest about the current state: MTP "currently provides at most a slight speedup." There are two reasons for this.

### 12.15.1 The cost model

A non-speculative decode cycle:

```
cost_normal = decode(target)
output = 1 token
```

A speculative cycle (N=2) with full acceptance:

```
cost_spec_full = decode(target)             // first_token via eval()
              + draft(MTP)                  // generate drafts[1]
              + verify(2 tokens, batched)   // metal_graph_verify_suffix_tops or _decode2_exact
output = 2 tokens
```

The savings condition is `cost_spec_full < 2 * cost_normal`:

```
draft(MTP) + verify(2) < cost_normal
```

For MTP, `draft(MTP)` ≈ `1/43 × cost_layer + cost_vocab_proj` ≈ 0.3-0.5 × `cost_normal` (the vocab projection is the dominant non-layer cost).

For the batched verifier, `verify(2) ≈ 1.3-1.5 × cost_normal` empirically (small-prefill is not 2× cheaper than two decodes; batch kernel overhead is meaningful at this size).

So `cost_spec_full ≈ cost_normal + 0.4 × cost_normal + 1.4 × cost_normal = 2.8 × cost_normal` for 2 tokens — *more* than 2 × `cost_normal`. The net win is *negative* at the per-cycle level.

### 12.15.2 What makes it work in expectation

The math changes when you account for the *frequency* of full acceptance and the *margin-skip* fast path:

- **Full N=2 acceptance** (≈70-80% of cycles in typical workloads): pays the 2.8x cost; produces 2 tokens. Per-token cost = 1.4 × `cost_normal`.
- **Partial accept** (some fraction): pays for the verifier *and* a target decode. Per-token cost > 2 × `cost_normal`. This is the loss case.
- **Margin-skip** (≈20-30% of cycles): pays `cost_normal + draft(MTP)` ≈ 1.4 × `cost_normal`; produces 1 token. Per-token cost = 1.4 × `cost_normal`. Same as full accept but for half the output.

The "at most a slight speedup" caveat reflects that the verifier cost is currently too high. If the batched verifier could be cut to ~0.7-0.9 × `cost_normal`, the full-accept path would be a real win; with current numbers, the gain is fragile.

### 12.15.3 Why ds4 has it anyway

Despite the "slight speedup" status, the speculative-decode plumbing is fully wired because:

1. **The MTP head is part of the model.** Not shipping a code path that uses it would leave a load-bearing model component dead-weight.
2. **It demonstrates correctness.** The `--quality / DS4_MTP_STRICT` mode running `metal_graph_verify_decode2_exact` produces byte-identical output to non-speculative decode, proving the verifier is sound.
3. **The infrastructure is also used for prefill verification.** `metal_graph_verify_suffix_tops` and `metal_graph_encode_output_head_batch` are the batched-prefill pieces that also benefit non-speculative prefill (`metal_graph_prefill_layer_major` uses output-head views; the batched variant is for the verifier).
4. **It opens the door to deeper drafts.** With `mtp_draft_tokens = 3` or `4`, the cost amortization gets better — provided the acceptance rate stays high. The current default of 2 is conservative.

The codebase is honest about the state: the README labels it "experimental," the CLI requires explicit opt-in (`--mtp-draft 2`), and the production default of `mtp_draft_tokens = 1` keeps it off unless the user has investigated whether their workload benefits.

## 12.16 Bench evaluation

The codebase's primary benchmark, `ds4-bench` (`ds4_bench.c`), measures *non-speculative* prefill and generation throughput at varying context sizes. It does **not** measure speculative-decode speedup directly. The benchmark CSV files under `speed-bench/` (e.g. `m4_max.csv`, `m2_ultra.csv`) report tokens-per-second on hardware-by-hardware basis without an MTP enabled.

To measure MTP's effect, one runs `ds4-bench` once with `--mtp`/`--mtp-draft 2` and once without, then compares wall-clock generation time. The CLI flags exist in `ds4-bench`, but the bench harness doesn't have a built-in speedup metric. Users investigating MTP report numbers manually.

The `DS4_MTP_TIMING=1` environment variable (`ds4.c:18371`) prints per-cycle timing breakdowns (draft, snapshot, verify, prefix-commit). This is the lowest-level introspection available:

```
ds4: mtp timing micro drafted=2 committed=2 draft=12.345 ms snapshot=3.456 ms verify=45.678 ms total=89.012 ms
ds4: mtp timing margin-skip drafted=2 committed=1 margin=2.345 threshold=3.000 draft=12.345 ms verify=78.901 ms total=91.246 ms
ds4: mtp timing decode2 drafted=2 committed=2 draft=12.345 ms snapshot=3.456 ms verify=89.012 ms total=104.813 ms
ds4: mtp timing seq drafted=2 verified=2 draft=12.345 ms verify=180.456 ms total=192.801 ms
```

Five variants of the timing line, one per verifier/outcome combination, identify exactly which path the engine took for that cycle.

`DS4_MTP_CONF_LOG=1` prints the per-cycle margin and accept counts:

```
ds4: mtp conf drafted=2 committed=2 mtp_top=12345 runner=23456 margin=4.521 target_next=12345 draft_next=12345
```

Together, these two env vars are the tool for *empirical* speedup measurement. They are not summarized into a single number by any built-in script.

## 12.17 Debug environment variables

The MTP-related env vars:

| Variable | Purpose |
|----------|---------|
| `DS4_MTP_SPEC_DISABLE` | Disable speculative path even when `--mtp-draft 2`+ is set (`ds4_cli.c:531`) |
| `DS4_MTP_STRICT` | Force strict mode (use exact verifier) even without `--quality` (`ds4.c:18363`) |
| `DS4_MTP_BATCH_VERIFY` | Force batched verifier even in strict mode (`ds4.c:18490`) |
| `DS4_MTP_CAPTURE_PREFIX1` | Force prefix-1 capture in strict mode (otherwise off in strict mode by default) (`ds4.c:18591`) |
| `DS4_MTP_TIMING` | Print per-cycle stage timings (`ds4.c:18371`) |
| `DS4_MTP_CONF_LOG` | Print per-cycle margin and committed-count (`ds4.c:18372`) |
| `DS4_MTP_MIN_MARGIN` | Override the margin threshold (default 3.0) (`ds4.c:18365`) |
| `DS4_MTP_SPEC_LOG` | Print diagnostic messages for first-draft miss and verifier fallback (`ds4.c:18388`, `18570`, `18823`, `18840`, `18893`) |
| `DS4_MTP_FULL_LOGITS` | Always read full MTP logits even when only top-1 is needed (debug) (`ds4.c:18374`) |
| `DS4_MTP_EXACT_REPLAY` | After verifier, exact-replay accepted drafts with sequential decode (consistency check) (`ds4.c:18592`) |
| `DS4_MTP_FORCE_SNAPSHOT` | Always snapshot the spec frontier, even when not strictly needed (`ds4.c:18596`) |

The combination `DS4_MTP_STRICT=1 DS4_MTP_EXACT_REPLAY=1 DS4_MTP_SPEC_LOG=1` is the most stringent debug mode: exact verifier, sequential replay after acceptance, and diagnostic messages on every fallback. Anything that produces a different output from non-speculative decode under this configuration is a verifier bug.

## 12.18 What we left for later

This chapter covered the speculative-decoding state machine and how the verifier preserves correctness. Three deeper threads remain:

- **MTP weight loading.** The MTP block's `Q_a`/`Q_b`/`KV`/`FFN`/`output` weights live in the optional MTP GGUF; the loading code in `ds4.c` mirrors the main-model loading but with a `ds4_mtp_weights` struct. The structural form is the same as the main model's `ds4_weights`.
- **Sampling-compatible speculative decoding.** Implementing the full rejection-sampling variant (so MTP works for `temperature > 0`) is an open extension. It requires reading full MTP logits and target logits, then accept-sampling against the ratio — none of which is wired today.
- **Multi-step MTP recursion.** The current MTP block is one transformer layer. Recursive MTP (running the MTP block multiple times with its own KV cache, to generate deeper drafts cheaply) is conceptually possible but the engineering cost is non-trivial: the MTP raw-cache ring would need to grow, and the recursive drafter would need to integrate with the verifier's prefix-1 capture.

The throughline of this chapter: **ds4's speculative-decode path implements the standard draft-then-verify algorithm with a model-supplied draft head (MTP), three verifier strategies (exact, batched, fallback sequential), and a margin-skip cost gate to avoid wasted verifies.** The correctness story is solid (under `--quality` the output is byte-identical to non-speculative decode); the performance story is still in flight, which is why the feature is opt-in and labeled experimental.

## Related chapters

- Chapter 10: Metal Backend and Kernels — `metal_graph_encode_decode_layer`, `metal_graph_verify_suffix_tops`, `metal_graph_verify_decode2_exact` implementations.
- Chapter 11: CUDA Backend (DGX Spark) — the same speculative path runs unchanged on CUDA because the `ds4_gpu.h` contract is backend-agnostic.
