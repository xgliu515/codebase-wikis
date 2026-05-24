# Tour Step 07: `ds4_session_create` and the first `ds4_session_sync`

> Code version locked to `ds4@f91c12b50a1448527c435c028bfc70d1b00f6c33` (2026). All `file:line` refs are repo-root-relative paths at this commit. Trace target: `./ds4 -m DS4.gguf -p "hello" -n 3`.

## 1. Current situation

`build_prompt` returned with `prompt.len ≈ 10-12` (`ds4_tokens` holding `[bos, <system tokens>, user_id, <"hello" tokens>, assistant_id, think_start_id]`). Control flows out of `run_generation`'s prompt-build path into the sampled-generation path at `ds4_cli.c:475-477`:

```c
static int run_sampled_generation(ds4_engine *engine, const cli_config *cfg, const ds4_tokens *prompt) {
    ds4_session *session = NULL;
    if (ds4_session_create(&session, engine, cfg->gen.ctx_size) != 0) { ... }
```

At this moment: `engine` is the immutable engine pointer from tour-05, `prompt` is a ds4_tokens with the encoded prompt, `cfg->gen.ctx_size = 32768`, `session = NULL`. No KV cache exists yet. The GPU is idle apart from the Library it loaded at engine open. By the end of this step, `session` is a valid `ds4_session *` and `ds4_session_sync(session, prompt, ...)` has been **called** with the prompt — the engine is one step away from entering the prefill loop (tour-08).

This step covers two function calls in sequence: `ds4_session_create` (allocate state) and the entry into `ds4_session_sync` (decide what work to do — for a fresh session, "full prefill").

## 2. The problem

The CLI has a prompt and an engine. To run inference it needs all the inference-time mutable state: per-layer KV caches (43 of them), all activation tensors, the HC state buffers, the logits buffer. These are large (hundreds of MB to several GB depending on `ctx_size`), expensive to allocate, and per-conversation.

> But there is a second problem layered on top: the CLI calls `ds4_session_sync(session, prompt, ...)` where `prompt` is the **full** prompt token array, every time. In multi-turn conversations or REPL use, the prompt for turn N+1 is the turn-N prompt plus the new tokens; re-prefilling the shared prefix is wasted work. The session must answer "how much new work is there?" — full prefill, incremental prefill, or short-suffix decode — based on whether the live cache state is a prefix of the new prompt.

These are intertwined because the session struct holds both the allocated buffers (problem 1) and the `checkpoint` token array that records "what is the cache currently consistent with" (problem 2).

## 3. Naive approach

Two functions: `engine_prefill(engine, prompt) → logits` and `engine_decode(engine, token) → logits`. The engine internally holds the KV cache. The first function rebuilds the cache from scratch every call; the second extends it by one token. Stateless API at the call site; engine owns everything.

## 4. Why the naive approach breaks

Putting the KV cache inside `engine` defeats both the concurrency model and the prefix-reuse optimization:

- **Concurrency dies.** `ds4-server` may serve two conversations at once. With one cache on the engine, the second request overwrites the first's state. The choices are (a) serialize all requests through a global lock (single-threaded throughput), (b) duplicate the engine — including 25 GiB of weights — for each request (impossible at any real load), or (c) ... give each conversation its own per-request state object, which is exactly the session design.
- **Re-prefill on every call is O(N) per turn.** A 30-turn conversation with a growing prompt would re-encode the entire history on each turn. The prefill cost grows quadratically in the number of turns. Real LLM serving requires prefix reuse: detect that turn N+1's prompt is turn N's prompt extended, and only compute the suffix.
- **Detecting the shared prefix needs state.** "Is the cache currently a prefix of the new prompt?" requires the session to remember which exact token sequence it last consumed. That sequence — the `checkpoint` — is not derivable from the cache contents alone (the cache is the *result* of running those tokens through the model, not the tokens themselves). It must be stored alongside.
- **Lifetimes are different.** The engine lives for the whole process. A session lives for one conversation; the server creates and destroys hundreds of sessions per day. Conflating them means tearing down weights every time a conversation ends.

The core insight: cache and weights have different lifecycles and different mutability profiles. Putting them in the same object only makes both jobs harder.

## 5. ds4's approach

ds4's approach is to **separate `ds4_engine` (immutable, process-level, holds weights) from `ds4_session` (mutable, conversation-level, holds KV cache + logits + checkpoint token array), with `ds4_session_sync(s, full_prompt, ...)` deciding at call time whether to do full prefill, batched incremental prefill, or per-token decode based on whether the live checkpoint is a prefix of the requested prompt**.

The two functions to look at:

**`ds4_session_create`** (`ds4.c:17796-17843`) allocates per-conversation state. The Metal path (lines 17811-17841) is the relevant one for our trace:

1. Reject invalid inputs (`out == NULL`, `e == NULL`, `ctx_size <= 0`, backend uses graph but `e->metal_ready == false`). Lines 17797 and 17812.
2. `xcalloc(1, sizeof(*s))` and stash `s->engine = e`, `s->ctx_size = ctx_size`. Lines 17814-17816.
3. Compute capacities: `s->prefill_cap = metal_graph_prefill_cap_for_prompt(ctx_size)` (= 4096 for `ctx_size = 32768`, see `ds4.c:6217-6219`) and `raw_cap = metal_graph_raw_cap_for_context(ctx_size, s->prefill_cap)` (= `align_up(128 + 4096, 256) = 4352`). Lines 17817-17818.
4. **Allocate the entire per-session graph**: `metal_graph_alloc_raw_cap(&s->graph, &e->weights, &e->weights.layer[0], raw_cap, ctx_size, s->prefill_cap, e->mtp_ready)` at lines 17819-17820. This is the big allocation. Inside `metal_graph_alloc_raw_cap` (`ds4.c:8806-9128`):
   - Per-layer raw SWA cache: `raw_cap × DS4_N_HEAD_DIM × sizeof(float)` × 43 layers.
   - Per-layer compressed-KV cache for compressed-ratio layers (`ds4_layer_compress_ratio(il) != 0`): `comp_cap × DS4_N_HEAD_DIM × sizeof(float)` per such layer.
   - Per-layer indexer cache for ratio-4 layers: `comp_cap × DS4_N_INDEXER_HEAD_DIM × sizeof(float)`.
   - HC state buffers (`cur_hc`, `flat_hc`, `hc_mix`, `hc_split`), each `DS4_N_HC × DS4_N_EMBD × sizeof(float)`.
   - Activation scratch: query / key-value / heads / attn_low / attn_out for the attention pass, and gate/up/down workspaces for the FFN/MoE pass.
   - Output logits buffer: `DS4_N_VOCAB × sizeof(float)` = 129 280 × 4 = ~505 KB per logits.
5. Copy quality / power settings from engine to graph (lines 17825-17826) — these affect kernel variant selection.
6. Load directional steering if configured (lines 17827-17834); skipped in our trace.
7. Allocate the host-visible `s->logits` (and `s->mtp_logits` when MTP is on). Lines 17835-17839.
8. `*out = s; return 0;` — session is ready to use.

At this point `session->checkpoint.len == 0`, `session->checkpoint_valid == false`. The buffers are allocated but uninitialized (the raw KV cache contents are whatever Metal gave us; the next prefill writes them before reading).

Back in the CLI (`ds4_cli.c:498-509`), the next call is `ds4_session_sync(session, prompt, err, sizeof(err))`. This is where the prefix-reuse decision is made.

**`ds4_session_sync`** (`ds4.c:17924-18070`) is the function the engine reaches every time the CLI / server has a new prompt. Its decision tree (Metal path, `ds4.c:17974-18069`):

```
if (s->checkpoint_valid && prompt is a non-strict extension of s->checkpoint):
    suffix = prompt->len - s->checkpoint.len
    if suffix >= metal_graph_resume_prefill_min_tokens():    // default 4
        batched incremental prefill of the suffix only
    else:
        per-token decode of the suffix
    return 0

// otherwise: full prefill from scratch
s->checkpoint_valid = false
metal_graph_reset_prefill_state(&s->graph)
if (s->prefill_cap < prompt->len):
    metal_graph_prefill_chunked(...)
else:
    metal_graph_prefill_raw_swa(...)
ds4_tokens_copy(&s->checkpoint, prompt)
s->checkpoint_valid = true
return 0
```

For our trace, `s->checkpoint_valid == false`, so the prefix branch is skipped at `ds4.c:17978`. The function falls through to the full-prefill path:

1. Reset the prefill state via `metal_graph_reset_prefill_state` (line 18035).
2. Choose between chunked and whole-batch prefill: `s->prefill_cap = 4096` vs `prompt->len ≈ 12`. Since `prefill_cap > prompt->len`, the chunked branch is skipped and `metal_graph_prefill_raw_swa` runs whole-batch (lines 18053-18057).
3. On success, copy the prompt into `s->checkpoint` and set `checkpoint_valid = true` (lines 18064-18065).

This step ends here, at the boundary of `metal_graph_prefill_raw_swa` — the actual prefill kernel dispatch. That call is tour-08 / tour-09's territory.

Several details worth pinning down before moving on:

The `progress` callback (lines 17896-17906) is the CLI's mechanism for "show a progress bar during long prefills". `cli_prefill_progress_cb` (`ds4_cli.c:301`) prints `[ N/total ]` on stderr; the session does not know or care about display. The display side has its own `display_progress` callback in case the UI wants finer-grained progress without polluting the durable checkpoint logic.

The `checkpoint` field is a `token_vec` (`ds4.c:16065`), an internal growable int array equivalent to `ds4_tokens`. It is **not** the same memory as the KV cache. The KV cache is the live per-row attention state; the checkpoint is the prompt that produced that state. The pair must stay consistent: if the cache is invalidated, `checkpoint_valid` is set false; if the cache is extended by one token, `checkpoint` gains one entry.

There is a third path: rewriting an in-place suffix after parsing a tool call. `ds4_session_rewrite_requires_rebuild` (`ds4.c:18079`) returns true whenever the rewrite cuts into a sampled tail, because the raw SWA rows and compressed KV rows behind the live end of the sequence cannot be undone in place. The server may then load an older disk checkpoint or replay. This is outside our trace but is the same `checkpoint_valid` discipline applied to a different operation.

When the function returns, the session's logits buffer holds the next-token distribution for position `prompt->len` (the position just after `<think>`). The CLI's sampler in tour-13 reads from there.

## 6. Code locations

In reading order:

- `ds4_cli.c:475-509` — `run_sampled_generation`; `ds4_session_create` then `ds4_session_sync` with progress callbacks installed.
- `ds4.h:155` — `ds4_session_create` public declaration.
- `ds4.h:172-175` — `ds4_session_sync` public declaration with the prefix-reuse contract documented.
- `ds4.c:16058-16079` — `struct ds4_session`: graph, cpu_cache, checkpoint, logits, mtp state, callbacks, prefill_cap, ctx_size, validity flags.
- `ds4.c:17796-17843` — `ds4_session_create` implementation; Metal path 17811-17841.
- `ds4.c:17819-17820` — `metal_graph_alloc_raw_cap` invocation, the per-session allocator.
- `ds4.c:8806-9128` — `metal_graph_alloc_raw_cap` body; the actual per-buffer allocations.
- `ds4.c:14263-14294` — `metal_graph_raw_cap_for_context`; raw SWA cache sizing formula.
- `ds4.c:14299-14301` — `metal_graph_prefill_cap_for_prompt`; prefill ubatch sizing.
- `ds4.c:6205-6224` — `ds4_default_prefill_cap_for_prompt`; the underlying default (4096 cap above prompt length 4096).
- `ds4.c:14307-14322` — `metal_graph_resume_prefill_min_tokens`; the short-suffix crossover (default 4).
- `ds4.c:17896-17906` — `ds4_session_note_prefill_progress`; the progress wrapper that updates `checkpoint` per chunk.
- `ds4.c:17909-17923` — `ds4_session_sync` block comment explaining the three paths.
- `ds4.c:17924-18070` — `ds4_session_sync` implementation.
- `ds4.c:17978-18030` — the prefix-extension branch (resumed prefill or short decode).
- `ds4.c:18032-18068` — the full-prefill branch.
- `ds4.c:18079-18083` — `ds4_session_rewrite_requires_rebuild`; the safety check for in-place suffix rewrites.

## 7. Branches and extensions

This step took the cold-start full-prefill path. The other paths:

- **Incremental prefill on multi-turn prompts.** When the new prompt is a strict extension of the live checkpoint and the suffix is ≥ `metal_graph_resume_prefill_min_tokens()`, sync runs `metal_graph_prefill_chunked_range` (`ds4.c:17994-18006`) only on the suffix. This is the dominant path for `ds4-server` under load. See [Chapter 6: Engine and Session](./06-engine-session.md).
- **Short-suffix decode.** Suffix of 1-3 tokens uses `metal_graph_eval_token_raw_swa` (`ds4.c:18018-18020`) per token. The crossover threshold is configurable via `DS4_METAL_RESUME_PREFILL_MIN`. See [Chapter 6 §sync paths](./06-engine-session.md).
- **CPU backend.** Skips the Metal allocator and uses `kv_cache_init` / `cpu_decode_scratch_init` (`ds4.c:17803-17805`). The CPU sync path (`ds4.c:17929-17968`) is structurally identical but uses CPU-side kernels. See [Chapter 10: Metal and CUDA backends](./10-metal-backend.md).
- **Disk KV cache.** `ds4_session_save_payload` / `ds4_session_load_payload` (`ds4.h:204-205`) let the server persist a checkpoint to disk between requests. When the server restores a payload before calling sync, the prefix-extension branch fires and the per-request prefill cost drops to near zero. See [Chapter 14: Disk KV cache](./14-disk-kv-cache.md).
- **Rewriting after tool calls.** When the model emits DSML in a slightly different byte order than the canonical re-tokenization would produce, `ds4_session_rewrite_from_common` (`ds4.c:18095`) negotiates whether the live suffix can be replaced in place or whether a rebuild is needed. The same checkpoint-validity discipline applies. See [Chapter 13: HTTP Server API](./13-http-server-api.md).
- **MTP (speculative decoding) state.** `s->mtp_logits` and `s->mtp_draft_token` are allocated here when `e->mtp_ready` is true; sync resets `s->mtp_draft_valid = false` on every full or incremental prefill. See [Chapter 12: Speculative MTP](./12-speculative-mtp.md).
- **Quantization affects per-tensor allocator behavior** (the per-layer compressed-KV cache differs by layer type), but does not change the session lifecycle. See [Chapter 4: Quantization](./04-quantization.md).

## 8. What you should now have in your head

1. **Engine = immutable model state, Session = mutable inference state.** `ds4_engine` is the loaded weights + tokenizer + GPU library; `ds4_session` is one conversation's KV cache + activations + logits + token-prefix checkpoint. The CLI runs one session; the server runs N concurrent sessions sharing one engine.
2. **`ds4_session_create` is where the big allocation happens.** Per-layer raw SWA cache (43 buffers), per-layer compressed-KV cache, indexer cache for ratio-4 layers, HC state buffers, activation scratch, logits buffer — all allocated once at session create from `metal_graph_alloc_raw_cap` (`ds4.c:8806`), sized by `ctx_size` and `prefill_cap`.
3. **`ds4_session_sync(s, full_prompt, ...)` is the dispatcher between full prefill, incremental prefill, and short-suffix decode.** The decision uses `s->checkpoint_valid` and whether `prompt` is a non-strict extension of `s->checkpoint`. Callers always pass the **full** prompt; the session figures out what is new.
4. **For our `-p "hello"` cold-start trace, sync takes the full-prefill branch.** `checkpoint_valid` is false, so the prefix check fails immediately; the function falls through to `metal_graph_prefill_raw_swa` (whole-batch, because `prefill_cap > prompt->len`). After the kernel returns, `checkpoint = prompt copy` and `checkpoint_valid = true`.
5. **The `checkpoint` is a token-id array, not bytes.** It records the exact token sequence the live cache is consistent with. Extending the cache and extending the checkpoint must always happen together; if a kernel fails mid-flight, both are marked invalid.
6. **This step ends one call into `metal_graph_prefill_raw_swa`.** The actual prefill kernel dispatch — embedding lookup, 43-layer forward, FFN/MoE, output projection — is tour-08 and tour-09. The session is now armed; the next token's logits will land in `session->logits` when prefill completes.
