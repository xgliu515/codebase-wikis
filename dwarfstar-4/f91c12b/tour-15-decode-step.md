# Tour Step 15: Producing token #2 — one decode step

> Code version locked to `antirez/ds4@f91c12b` (main, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

Tour-14 returned an integer `token` — call it `t1`, the first sampled token. `session->checkpoint.len` still equals `prompt.len`; `session->logits` still holds the post-prefill logits (which will be overwritten by the end of this step); the GPU's raw SWA cache and the streaming compressors are in the exact state prefill left them in (tour-09 through tour-13).

The next line in `run_sampled_generation` for our trace is the ordinary (non-speculative) branch at [`ds4_cli.c:546`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L546):

```c
if (ds4_session_eval(session, token, err, sizeof(err)) != 0) {
    fprintf(stderr, "ds4: decode failed: %s\n", err);
    ds4_session_free(session);
    return 1;
}
```

By the end of this step:

- `session->checkpoint.len == prompt.len + 1` (token appended).
- The KV caches have one new raw SWA row written at the per-layer slot `pos % raw_cap` (Metal) or appended/shifted on CPU.
- The streaming compressor state has been advanced for `t1`; if `t1` is at a compressor boundary, one new compressed KV row has been emitted.
- `session->logits` has been overwritten with the logits **for the position after `t1`** — that is the input to tour-16's next sampling call.
- No token text has been printed; printing happens in tour-16 once `ntok` and the EOS check have decided whether to emit.

## 2. The problem

> Generate the logits for **position `prompt.len + 1`** by feeding back the single token `t1`. The work has the same shape as prefill — embed, 43 transformer layers, output head — but the per-token cost has to be near-constant rather than re-paying the full prompt every step, and a Metal/CUDA graph optimized for prefill's batch-of-N shape will be the wrong tool for a batch-of-1.

## 3. Naive approach

The shortest "correct" implementation: build a minimal token vector containing the entire conversation so far — `prompt[0..n) ++ [t1]` — and call the prefill path on it. Throw away all logits except the last row, return that row.

The model is stateless w.r.t. caches in this view, so the math is obviously right. One code path; no separate "decode" subsystem.

## 4. Why the naive approach breaks

Re-prefilling on every decode step is what KV caches exist to defeat. The failures are quantitative and qualitative:

- **Quadratic cost in generated length.** Each decode step would do the work of prefilling `len_so_far` tokens. For a 10 000-token prompt and 1 000 generated tokens, total work is `~∑ k for k=10000..11000 ≈ 10.5M` token-equivalents instead of `~10K + 1K = 11K`. That is three orders of magnitude.
- **Recomputes K/V projections that were already done.** Prefill writes every prompt token's per-layer key/value vectors into the cache. Re-prefilling repeats those projections — pure waste.
- **Wrong GPU shape for batch=1.** The prefill graph has tensor dimensions sized to `n_tokens`; allocations are sized to `prefill_cap`. Reusing it for a single token leaves nearly all of that capacity idle and pays the dispatch/encoding overhead designed to be amortized over hundreds of tokens.
- **Compressors lose their streaming guarantee.** The ratio-4 attention compressor is **stateful**: prefill flushes scratch states at boundaries (`kv_cache_finish_prefill_states` at [`ds4.c:6457`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L6457)). Re-running prefill on the whole conversation would re-initialize that state mid-conversation, producing a different KV stream than incremental decode — outputs would diverge from a session that ran token-by-token.

The decoder has to be a **distinct hot path** with its own GPU graph, sized for batch=1, that *reads* the cache for old positions and *appends one row* for the new position.

## 5. ds4's approach

ds4's approach is to **route `ds4_session_eval` through a separate single-token Metal/CUDA graph** that embeds one token, runs all 43 layers reading old K/V rows from the raw SWA cache, writes one new row per layer at `pos % raw_cap`, advances the streaming compressors by one tick, and reads only the new logits row back to host.

The C entry is `ds4_session_eval` at [`ds4.h:187`](https://github.com/antirez/ds4/blob/f91c12b/ds4.h#L187) → [`ds4.c:18305`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18305) → `ds4_session_eval_internal` at [`ds4.c:18228`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18228). The internal function forks on backend:

**CPU backend** ([`ds4.c:18231-18247`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18231)):

```c
if (ds4_session_is_cpu(s)) {
    forward_token_raw_swa_cpu_decode_scratch(s->logits, &e->model, &e->weights,
                                             &s->cpu_cache, token,
                                             (uint32_t)s->checkpoint.len,
                                             ..., &s->cpu_scratch);
    token_vec_push(&s->checkpoint, token);
    s->checkpoint_valid = true;
    ...
}
```

`forward_token_raw_swa_cpu_decode_scratch` ([`ds4.c:7724`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L7724)) uses a **pre-allocated** `cpu_decode_scratch` so no `malloc` happens per token. Inside, for every layer it calls `kv_cache_push_raw` ([`ds4.c:6411`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L6411)) — append a row to `raw_kv` if there is room, otherwise `memmove` the buffer left by one row and write the new row at the tail (the classical CPU sliding-window). After attention, `compressor_decode_one` ([`ds4.c:6535`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L6535)) updates the rolling compressor state for that layer and emits a new compressed row whenever `(pos + 1) % compress_ratio == 0`.

**Metal backend** ([`ds4.c:18256-18302`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18256)):

```c
if (!metal_graph_eval_token_raw_swa(&s->graph, &e->model, &e->weights,
                                    (uint32_t)token,
                                    (uint32_t)s->checkpoint.len,
                                    s->logits))
{ ... }
token_vec_push(&s->checkpoint, token);
```

`metal_graph_eval_token_raw_swa` at [`ds4.c:13127`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L13127) is the **decode** counterpart of the prefill executor. The structure of one call is `begin_commands` → encode → `end_commands` → tensor read:

```c
bool ok = ds4_gpu_begin_commands() != 0;
if (ok) ok = metal_graph_encode_token_raw_swa(g, model, weights,
                                              token, pos, logits != NULL, true);
const double t_encoded = ...;
if (ok) ok = ds4_gpu_end_commands() != 0;
if (ok && logits) {
    ok = ds4_gpu_tensor_read(g->logits, 0, logits,
                             (uint64_t)DS4_N_VOCAB * sizeof(float)) != 0;
}
```

The actual graph body is `metal_graph_encode_token_raw_swa` at [`ds4.c:11111`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L11111). It does:

1. **Embed**: `ds4_gpu_embed_token_hc_tensor` loads one row from the `token_embd` F16 table into the initial HC state.
2. **For each of `DS4_N_LAYER` layers**: call `metal_graph_encode_decode_layer` ([`ds4.c:9461`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L9461)) — the **decode** layer encoder, which is **not** `metal_graph_encode_layer_batch` ([`ds4.c:13109`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L13109), the prefill one). The decode layer reads the raw SWA cache rows for old positions, writes the new row at `raw_row = pos % raw_cap` ([`ds4.c:11123`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L11123)), and runs FFN/MoE on a single-row tensor.
3. **Split-flush after `split_after_layers` (default 4) layers** ([`ds4.c:11142-11166`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L11142)): `ds4_gpu_flush_commands` so the GPU starts executing while the CPU is still encoding the remaining layers — explicit CPU↔GPU pipeline overlap, calibrated by measurement.
4. **Output head**: `metal_graph_encode_output_head` writes `DS4_N_VOCAB` floats to `g->logits`.
5. **Read**: one `ds4_gpu_tensor_read` of 129 280 floats back to `s->logits`.

The crucial difference from prefill is at the **tensor shapes**: prefill's `batch_cur_hc` is `(prefill_cap, N_HC, N_EMBD)`; decode's `cur_hc` is `(1, N_HC, N_EMBD)`. Two physically distinct tensor sets allocated at session-create time (see [`ds4.c:8634-9020`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L8634)). The "prefill graph" and "decode graph" share weights but have their own activation buffers — that is what lets each one be optimal for its batch shape.

After the read, control returns to `ds4_session_eval_internal`, which appends `token` to `s->checkpoint` ([`ds4.c:18283`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18283)) and (if MTP is loaded and `mtp_draft_tokens > 1`) opportunistically asks the MTP drafter to propose what `t2` will be — see tour-12's reference chapter for why this MTP draft is computed during decode rather than during sampling.

Net effect of one call: `session->logits` now contains the next-token logits, `checkpoint.len += 1`, one new K/V row per layer is in the cache, and the streaming compressor frontiers have advanced.

## 6. Code locations

- [`ds4.h:187`](https://github.com/antirez/ds4/blob/f91c12b/ds4.h#L187) — `ds4_session_eval` public signature.
- [`ds4.c:18305`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18305) — `ds4_session_eval`: trivial wrapper to `_internal` with `probe_mtp = true`.
- [`ds4.c:18228`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18228) — `ds4_session_eval_internal`: backend fork; this is the function that owns the per-step state transition.
- [`ds4.c:18231-18247`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18231) — CPU branch: calls `forward_token_raw_swa_cpu_decode_scratch`, then `token_vec_push`.
- [`ds4.c:18256-18283`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18256) — Metal/CUDA branch: calls `metal_graph_eval_token_raw_swa`, then `token_vec_push`.
- [`ds4.c:18284-18300`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18284) — MTP draft hook (only fires when `mtp_draft_tokens > 1` or `DS4_MTP_PROBE` is set).
- [`ds4.c:13127`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L13127) — `metal_graph_eval_token_raw_swa`: the `begin_commands` / encode / `end_commands` / tensor-read sequence for one decode step.
- [`ds4.c:11111`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L11111) — `metal_graph_encode_token_raw_swa`: the decode graph body — embed, 43 layers, split-flush after 4 layers, output head.
- [`ds4.c:11123`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L11123) — `raw_row = pos % g->raw_cap`: the ring-buffer index into the raw SWA cache.
- [`ds4.c:11142-11166`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L11142) — `split_after_layers` (default 4) and the `DS4_METAL_GRAPH_TOKEN_SPLIT_LAYERS` env override; the CPU↔GPU overlap point.
- [`ds4.c:9461`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L9461) — `metal_graph_encode_decode_layer`: single-token version of one transformer layer (attention + FFN/MoE).
- [`ds4.c:13109`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L13109) — `metal_graph_encode_layer_batch`: the **prefill** sibling; this is the function decode is *not* using.
- [`ds4.c:7724`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L7724) — `forward_token_raw_swa_cpu_decode_scratch`: CPU-backend single-token forward with pre-allocated scratch.
- [`ds4.c:6411`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L6411) — `kv_cache_push_raw`: CPU raw SWA append-or-shift.
- [`ds4.c:6535`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L6535) — `compressor_decode_one`: streaming ratio-4 compressor advance.
- [`ds4_cli.c:546`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L546) — the call site we are tracing.

## 7. Branches and extensions

- **MTP draft side-effect.** When `e->mtp_ready && e->mtp_draft_tokens > 1`, `ds4_session_eval` *also* runs the MTP graph to predict the next token while it is here. The next call to `ds4_session_eval` then consumes that draft if the sampled token matches. This is correctness-safe (the target stream is always validated) and is the basis for speculative decoding at `temperature == 0`. Full state machine in [Chapter 12 (Speculative decoding and MTP)](12-speculative-mtp.md).
- **Raw SWA capacity and indexer compressor.** The raw cache is sized by `metal_graph_raw_cap_for_context(ctx_size, prefill_cap)`. When the new row would overflow, the per-layer ring buffer wraps; older positions are reachable only through the compressor. The compressor's ratio-4 design and how attention queries fuse both stores are in [Chapter 07 (KV cache)](07-kv-cache.md) and [Chapter 08 (Attention)](08-attention.md).
- **Two graphs, one set of weights.** Prefill and decode share the GGUF-backed weight tensors but have **distinct** activation tensor sets (the `batch_*_hc` for prefill vs `cur_hc`/`after_ffn_hc` for decode). The session-create allocator splits them at [`ds4.c:8634-9020`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L8634). See [Chapter 10 (Metal backend)](10-metal-backend.md) for the full tensor inventory.
- **CUDA path.** The CUDA backend implements the same shape: `ds4_cuda.cu` mirrors `metal_graph_eval_token_raw_swa` / `metal_graph_encode_decode_layer` with `ds4_gpu_*` calls dispatched through the unified `ds4_gpu.h` interface. See [Chapter 11 (CUDA backend)](11-cuda-backend.md).
- **Speculative decode batch.** When the loop is at `temperature <= 0` with MTP, instead of one `ds4_session_eval` per token we get one `ds4_session_eval_speculative_argmax` per accepted suffix — multiple positions verified per Metal command buffer. Same per-layer encoder, just different driver code.

## 8. What you should now have in your head

- **Decode is its own graph.** ds4 does not "re-prefill the conversation"; it has a single-token Metal/CUDA graph (`metal_graph_encode_token_raw_swa`) with its own batch-of-1 activation tensors, distinct from the batch-of-N prefill graph.
- **One new K/V row per layer per call.** The ring-buffer index is `raw_row = pos % raw_cap`. No memmove on the Metal path; CPU path shifts on overflow.
- **Split-flush after 4 layers** lets the GPU start executing while the CPU still encodes the rest of the graph. The split point is a measured constant, env-overridable via `DS4_METAL_GRAPH_TOKEN_SPLIT_LAYERS`.
- **Streaming compressors advance by one tick per decode step.** The ratio-4 compressor emits a new compressed row only on boundary positions; this matches the row sequence prefill would have produced for the same prefix.
- **`ds4_session_eval` does two semantically separable things in one call**: write one cache row (state mutation) and overwrite `session->logits` (next-token signal). Tour-16's next sampling call reads only the second; the first is invisible to it but is what makes tour-15 + tour-16 a coherent loop.
