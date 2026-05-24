# Chapter 15: Glossary & FAQ

> Code version locked to antirez/ds4@f91c12b (2026-05-24, "Improve prefill progress callbacks"). All `file:line` references in this chapter point into that exact tree.

This chapter is the appendix the rest of the wiki points back to. **Part 1** is a term-by-term glossary covering every load-bearing noun in the codebase — public API types, model concepts, quantisation formats, KV cache machinery, backends, server runtime, and adjacent tooling. **Part 2** answers the questions a first-time reader keeps tripping over; most need cross-file evidence rather than one function definition. **Part 3** is the cheatsheet: env vars, CLI flags, build commands, and a top-level source map. There are no figures here; use the search box and the inline `file:line` refs to jump straight into source.

---

## Part 1: Glossary

The glossary is grouped into sections. Within each section, entries are alphabetical. Cross-references are written as `Chapter N` or as `(see <Term>)`.

**A. Public engine API (`ds4.h`)**

### ds4_backend
- Definition: Enum of supported compute backends. Values: `DS4_BACKEND_METAL` (default on macOS), `DS4_BACKEND_CUDA` (Linux GPU), `DS4_BACKEND_CPU` (Linux only — see FAQ on the macOS VM bug).
- Source: `ds4.h:17` defines the enum; `ds4.c:74` `ds4_backend_uses_graph()` returns true for the two GPU backends.

### ds4_chat_append_assistant_prefix
- Definition: Append the assistant role marker and the `<think>` opener (when the requested think mode is `HIGH` or `MAX`) to a token buffer, leaving the cursor where sampling can start.
- Source: `ds4.c:15301` defines `ds4_chat_append_assistant_prefix`; declared at `ds4.h:148`.

### ds4_chat_append_max_effort_prefix
- Definition: Inject the literal `DS4_REASONING_EFFORT_MAX_PREFIX` text (a four-line "be very thorough" preamble) into a token buffer; used when `DS4_THINK_MAX` is active and the context window is large enough.
- Source: `ds4.c:15275` defines the function; the prefix string itself lives at `ds4.c:64`.

### ds4_chat_append_message
- Definition: Append a `(role, content)` pair to a chat-template token buffer. The function does the BPE-level template stitching for the DeepSeek chat dialect; CLI and server both build prompts this way.
- Source: `ds4.c:15279` defines the function; declared at `ds4.h:147`.

### ds4_chat_begin
- Definition: Initialise a fresh chat token buffer with the model's beginning-of-stream marker. Always paired with subsequent `ds4_chat_append_message` calls.
- Source: `ds4.c:15262` defines the function; declared at `ds4.h:139`.

### ds4_context_memory_estimate
- Definition: Returns a `ds4_context_memory` struct (raw bytes, compressed bytes, scratch bytes, total) describing how much memory a session of a given context size will consume on a given backend, before the session is created. The CLI uses it to print the early budget line.
- Source: declared at `ds4.h:108`; the struct itself at `ds4.h:80`.

### ds4_encode_chat_prompt
- Definition: One-shot helper that emits the system message, the user message, and the assistant prefix at the right think mode into one token buffer. The CLI uses it for non-REPL `-p` invocations.
- Source: `ds4.c:15266` defines the function; declared at `ds4.h:140`.

### ds4_engine
- Definition: Opaque handle to the loaded model and all read-only inference infrastructure (mapped GGUF, weight tensors, tokenizer vocab, compiled Metal/CUDA pipelines). One per process; immutable for the lifetime of the process.
- Source: forward-declared at `ds4.h:57`; created by `ds4_engine_open()` at `ds4.c:17636`.

### ds4_engine_collect_imatrix
- Definition: Run a calibration dataset through the live engine, accumulating per-column activation second moments, and write the resulting importance matrix as a `.imatrix` file. Used by the quant build pipeline in `gguf-tools/`.
- Source: declared at `ds4.h:118`; implementation entry is around `ds4.c:17636`+ via `ds4_engine_open` then walked by helpers below it.

### ds4_engine_open
- Definition: Memory-maps the GGUF model, validates that the layout matches the DeepSeek V4 Flash compile-time constants, builds the tokenizer vocab and (on GPU backends) prepares command-buffer plans. The single process-wide instance lock (see _Instance lock_) is acquired here.
- Source: `ds4.c:17636` defines the function; declared at `ds4.h:96`; instance lock taken at `ds4.c:17661`.

### ds4_engine_options
- Definition: Plain-old-data struct describing how an engine should open: `model_path`, `mtp_path`, `backend`, `n_threads`, `mtp_draft_tokens`, `mtp_margin`, directional-steering knobs, `power_percent`, `warm_weights`, `quality`.
- Source: defined at `ds4.h:62`.

### ds4_log
- Definition: The single text logging entry point used by all five binaries. Routes to stderr with a `ds4_log_type` tag (`DEFAULT`, `PREFILL`, `GENERATION`, `KVCACHE`, `TOOL`, `WARNING`, `TIMING`, `OK`, `ERROR`); colourised when the destination is a TTY.
- Source: declared at `ds4.h:110`; the `ds4_log_type` enum at `ds4.h:29`.

### ds4_session
- Definition: Opaque handle representing a single mutable inference timeline against an engine. Owns the live KV cache (raw rows + compressed rows + indexer), the current token list, and the last-row logits.
- Source: forward-declared at `ds4.h:58`; created by `ds4_session_create()` at `ds4.c:17796`.

### ds4_session_create
- Definition: Allocate a session bound to an engine and a fixed `ctx_size`. The session preallocates its raw, compressed, and scratch buffers to that ceiling; growing later is not supported.
- Source: `ds4.c:17796` defines the function; declared at `ds4.h:155`.

### ds4_session_eval
- Definition: Push one already-known token through the model: extend the KV cache by one row, recompute logits. Used during decode after sampling.
- Source: `ds4.c:18305` defines the function; declared at `ds4.h:187`.

### ds4_session_eval_speculative_argmax
- Definition: Greedy-only multi-token decode using the MTP draft model. The engine speculates up to `max_tokens` tokens, verifies them against the full model in one batched forward, returns the count actually accepted.
- Source: `ds4.c:18316` defines the function; declared at `ds4.h:188`.

### ds4_session_load_payload
- Definition: Inverse of `ds4_session_save_payload`. Reads the engine-side serialised KV graph state back into a live session from a `FILE *`, advancing the file by `payload_bytes`. Disk KV cache and snapshot APIs both build on this.
- Source: `ds4.c:16761` defines the function; declared at `ds4.h:205`.

### ds4_session_payload_bytes
- Definition: How many bytes `ds4_session_save_payload` will write for the current live state. Callers (HTTP server, agent) use this to pre-size files and check disk budget before saving.
- Source: `ds4.c:16530` defines the function; declared at `ds4.h:203`.

### ds4_session_rewind
- Definition: Logically truncate the live session to a given token position, discarding the suffix from the KV cache. Used after generation overshoots a stop sequence and the server needs to back off.
- Source: `ds4.c:18917` defines the function; declared at `ds4.h:193`.

### ds4_session_sample
- Definition: Draw a token from the last-row logits using temperature / top-k / top-p / min-p with a caller-owned RNG state. Does not extend the session (callers follow up with `ds4_session_eval`).
- Source: `ds4.c:18159` defines the function; declared at `ds4.h:183`.

### ds4_session_save_payload
- Definition: Serialise the engine-side KV state (per-layer raw rows, compressed rows, last-row logits, checkpoint metadata) to a `FILE *`. The outer header and file naming policy belong to the HTTP/agent layer; this function only emits the DS4-specific payload.
- Source: `ds4.c:16555` defines the function; declared at `ds4.h:204`.

### ds4_session_snapshot
- Definition: A heap-allocated byte buffer that holds one `save_payload` blob and is round-tripped via `fmemopen()`. Used by `ds4-bench` (and tests) for purely in-memory checkpoint/restore.
- Source: struct at `ds4.h:90`; `ds4_session_save_snapshot` at `ds4.c:17125`; `ds4_session_load_snapshot` at `ds4.c:17173`.

### ds4_session_sync
- Definition: The prefix-reuse workhorse. Given a full prompt token sequence, the function finds the longest common prefix with the live KV state and only prefills the new suffix. This is what makes multi-turn chat fast.
- Source: `ds4.c:17924` defines the function; declared at `ds4.h:175`.

### ds4_think_mode
- Definition: Three-valued enum picking how much hidden reasoning the assistant should emit: `DS4_THINK_NONE`, `DS4_THINK_HIGH` (standard `<think>...</think>` block), `DS4_THINK_MAX` (with the reasoning-effort preamble; needs >= 384K context).
- Source: `ds4.h:23` defines the enum; `ds4_think_mode_for_context()` at `ds4.h:107` auto-downgrades MAX to HIGH below `DS4_THINK_MAX_MIN_CONTEXT`.

### ds4_tokens
- Definition: A plain growable `int *` vector with `len` and `cap` fields. Used for every prompt, every assistant continuation, every checkpoint token list; deliberately a thin wrapper so callers can read `tokens.v[i]` directly.
- Source: defined at `ds4.h:41`; helpers `ds4_tokens_push`/`ds4_tokens_free`/`ds4_tokens_copy`/`ds4_tokens_starts_with` declared at `ds4.h:132-135`.

**B. Model architecture (compile-time constants in `ds4.c`)**

### APE / Attention Sinks
- Definition: A learned per-head bias scalar (`attn_sinks` weight) that participates in the attention softmax denominator. It gives every token a fall-back "sink" target so attention does not over-dilute on very long contexts. Sometimes called Attention Pool Embedding in upstream literature; here it is plain `attn_sinks`.
- Source: `ds4.c:2090` declares `attn_sinks` in the layer struct; `ds4.c:4997` CPU implementation; `ds4.c:6731` and `ds4.c:6794` long-context paths.

### Biased top-k
- Definition: How non-hash MoE layers pick experts: add a load-balancing bias to the router logits, take the top-`DS4_N_EXPERT_USED=6`, then weight the selected experts by the _unbiased_ softmax probabilities. The bias improves balance; the unbiased weights preserve gradient accuracy.
- Source: see the comment block around `ds4.c:5308` in router select.

### Compressed KV cache
- Definition: The low-dimensional KV representation produced by DeepSeek V4 Flash's MLA-style attention. Each compressed row stores a low-rank K/V plus a small RoPE tail; tens of times smaller per token than vanilla MHA KV. Compressed rows are the long-term memory of the session.
- Source: `ds4.c:15937` and `ds4.c:16212` (per-layer save/load); referenced from the indexer in `ds4.c:11473`.

### DS4_COMPRESS_ROPE_FREQ_BASE
- Definition: `160000.0f` — the RoPE base frequency used in compressed-KV layers (vs. `10000.0f` for the raw / SWA path). The high base extends the model's effective positional range so the compressed indexer can reach far back without aliasing.
- Source: `ds4.c:61` defines the constant; consumed at `ds4.c:4839`.

### DS4_N_EXPERT / DS4_N_EXPERT_USED / DS4_N_EXPERT_SHARED
- Definition: `256` total routed experts per MoE layer; `6` activated per token via the router; `1` shared expert always activated. Together they implement DeepSeek V4 Flash's sparse FFN.
- Source: `ds4.c:99-101` defines the constants.

### DS4_N_HASH_LAYER
- Definition: `3` — the first three MoE layers use a deterministic hash router instead of a learned router. Saves the router matmul and stabilises early-layer training.
- Source: `ds4.c:103` defines the constant; `ds4.c:5265` `layer_hash_router_weights_from_probs()` consumes it.

### DS4_N_HC
- Definition: `4` — the number of hyper-connection streams per layer. Each layer maintains and updates four residual streams in parallel; per-token information can route across the streams via Sinkhorn-normalised weights.
- Source: `ds4.c:114` defines the constant; `ds4.c:115` defines `DS4_N_HC_SINKHORN_ITER=20`; per-step normalisation lives in the Sinkhorn helper around `ds4.c:4258`.

### DS4_N_INDEXER_HEAD / DS4_N_INDEXER_HEAD_DIM / DS4_N_INDEXER_TOP_K
- Definition: `64` indexer heads, each `128`-dim, selecting the top `512` compressed rows. Together they form the sparse-attention selector that makes ratio-4 layers efficient at long context. The selection is part of the model's semantics, not a kernel-level approximation.
- Source: `ds4.c:105-113` (with the comment explicitly forbidding lowering `TOP_K` for speed).

### DS4_N_LAYER
- Definition: `43` — the fixed number of transformer layers in DeepSeek V4 Flash. Used everywhere as the upper bound of layer-walking loops; never read from GGUF metadata at runtime.
- Source: `ds4.c:88` defines the constant.

### DS4_N_LORA_Q / DS4_N_LORA_O
- Definition: `1024` — low-rank dimensions for the Q projection and the output projection. Q is computed in two matmuls (`embedding -> 1024 -> n_head * head_dim`) instead of one direct projection, saving parameters and bandwidth.
- Source: `ds4.c:97-98` defines the constants.

### DS4_N_SWA
- Definition: `128` — the sliding-window size for the raw KV cache. Only the last 128 raw rows are kept; older positions exist only in compressed form.
- Source: `ds4.c:104` defines the constant; consumed across the raw-cache paths.

### DS4_REASONING_EFFORT_MAX_PREFIX
- Definition: A four-line "Reasoning Effort: Absolute maximum..." plain-text preamble. When `DS4_THINK_MAX` is active and the context allows it, this is tokenised and prepended to the prompt before the user message.
- Source: `ds4.c:64` defines the literal; injected in `ds4.c:15184` (`bpe_tokenize_text`) and `ds4.c:15275-15276`.

### DS4_ROPE_FREQ_BASE / DS4_ROPE_SCALE_FACTOR
- Definition: `10000.0f` and `16.0f`. Together with `DS4_ROPE_ORIG_CTX = 65536` they parameterise the YaRN-scaled rotary embedding the raw / SWA path uses. `DS4_ROPE_YARN_BETA_FAST = 32.0`, `DS4_ROPE_YARN_BETA_SLOW = 1.0` round out the YaRN profile.
- Source: `ds4.c:57-62` defines all five constants.

### DS4_THINK_MAX_MIN_CONTEXT
- Definition: `393216u` — the smallest context size at which `DS4_THINK_MAX` is actually honoured. Below this the engine silently downgrades to `DS4_THINK_HIGH` to avoid asking for a reasoning budget the context window cannot hold.
- Source: `ds4.c:72` defines the constant; the auto-downgrade lives behind `ds4_think_mode_for_context()` at `ds4.h:107`.

### Hash router
- Definition: The deterministic expert-selection function used by the first three MoE layers. Maps each token to its experts by hashing token features into the `DS4_N_EXPERT_USED`-sized slot set, skipping the learned router for those layers.
- Source: `ds4.c:5265` defines `layer_hash_router_weights_from_probs()`; controlled by `DS4_N_HASH_LAYER`.

### Hyper-connection (HC)
- Definition: DeepSeek V4 Flash's four-way residual mechanism. Instead of a single residual stream per layer, four streams are maintained side by side; a learned mixing weight matrix is normalised via Sinkhorn iteration so flow across streams stays well-conditioned.
- Source: `DS4_N_HC = 4` at `ds4.c:114`; per-batch flat representation at `ds4.c:213` (`hc_flat`); Sinkhorn helper around `ds4.c:4258`.

### Indexer
- Definition: An extra small set of `DS4_N_INDEXER_HEAD = 64` attention heads inserted in ratio-4 layers. Its only job is to score every compressed row and pick the top `DS4_N_INDEXER_TOP_K = 512` for the real attention computation, turning dense attention over the whole compressed history into top-k sparse attention.
- Source: constants at `ds4.c:105-113`; consumed in the prefill/decode index paths around `ds4.c:11473`.

### Layer-major prefill
- Definition: Both the CPU and the Metal/CUDA prefill paths walk layer-by-layer over a whole micro-batch of tokens before moving to the next layer. This maximises matmul batch size and arithmetic intensity at the cost of slightly higher peak activation memory.
- Source: CPU path entry around `ds4.c:7783`; Metal entry around `ds4.c:13222`.

### Low-rank Q projection
- Definition: A two-step Q computation: project the embedding down to `DS4_N_LORA_Q = 1024` first, then expand back up to `n_head * head_dim`. Cuts parameter count and memory bandwidth on the hot Q path.
- Source: `DS4_N_LORA_Q` at `ds4.c:97`; the corresponding `Q_a`/`Q_b` weights are bound in the layer table around `ds4.c:2693`.

### Mixture of Experts (MoE)
- Definition: The FFN of every MoE layer in DeepSeek V4 Flash. Routes each token to `DS4_N_EXPERT_USED = 6` of `DS4_N_EXPERT = 256` routed experts plus `DS4_N_EXPERT_SHARED = 1` shared expert. Drastically reduces per-token FLOPs while keeping total parameter count high.
- Source: constants at `ds4.c:99-101`; gate/up/down weight binding around `ds4.c:2682`.

### Multi-Token Prediction (MTP)
- Definition: A small auxiliary head and lightweight transformer (the "draft model") that predicts the next 1-2 tokens cheaply. When loaded via `--mtp`, ds4 uses it as a speculative decoder in greedy sampling. The draft is verified against the full model in a single batched forward.
- Source: `ds4_engine_has_mtp()` at `ds4.h:197`; `ds4_session_eval_speculative_argmax` at `ds4.c:18316`; gating in `ds4_server.c:10292` (`DS4_MTP_SPEC_DISABLE`).

### Ratio-4 layer / ratio-128 layer
- Definition: `ds4_layer_compress_ratio(il)` returns `0` for the first two dense layers, `4` for even-indexed layers from 2 onward, and `128` for odd-indexed ones. The 4 vs 128 number is the ratio between full and compressed K/V dimensions; ratio-4 layers also carry an indexer. About 20 layers are ratio-4 and another 20 are ratio-128.
- Source: `ds4.c:418` defines `ds4_layer_compress_ratio()`.

### RMSNorm
- Definition: Root-mean-square normalisation — LayerNorm without the mean-centering step. Used everywhere ds4 needs normalisation; epsilon is `DS4_RMS_EPS = 1.0e-6f`.
- Source: `ds4.c:53` defines the epsilon; consumed across the per-layer paths.

### RoPE / Rotary Position Embedding
- Definition: The pairwise complex-number rotation that encodes position into Q and K. ds4 uses YaRN-scaled RoPE with the raw frequency base for the SWA path and a higher base (`DS4_COMPRESS_ROPE_FREQ_BASE`) for compressed-KV layers; the tail of `DS4_N_ROT = 64` dimensions of each head is the only part that is rotated.
- Source: constants at `ds4.c:57-62`; the RoPE-applies-only-to-compressed-tail guard at `ds4.c:4839`.

### Routed expert
- Definition: An MoE expert selected dynamically by the router per token (as opposed to the shared expert). Each MoE layer has `DS4_N_EXPERT = 256` routed experts; only `DS4_N_EXPERT_USED = 6` activate per token.
- Source: constants at `ds4.c:99-100`; quantised differently from the rest of the model (see FAQ).

### Shared expert
- Definition: A single FFN block per MoE layer that fires unconditionally for every token, summed with the routed-expert outputs. Guarantees every token gets a baseline FFN transformation, regardless of routing.
- Source: `DS4_N_EXPERT_SHARED = 1` at `ds4.c:101`.

### Sinkhorn iteration
- Definition: The fixed-point row/column normalisation algorithm that turns the raw hyper-connection split matrix into a doubly stochastic one. ds4 runs it for `DS4_N_HC_SINKHORN_ITER = 20` iterations on every layer.
- Source: `ds4.c:115`; helper around `ds4.c:4258` (`hc_split_sinkhorn_one()`).

### Sliding-Window Attention (SWA) cache
- Definition: The raw, unquantised KV cache for the last `DS4_N_SWA = 128` rows. Used by local-attention layers and as the high-precision source for fresh compressed rows. Implemented as a ring buffer.
- Source: `DS4_N_SWA` at `ds4.c:104`; the SWA-only KV slice is what `ds4.c:15846` annotates as "only the last few rows".

### SwiGLU
- Definition: The FFN activation `SiLU(gate) * up`, where `SiLU(x) = x * sigmoid(x)`. ds4 clamps the SiLU exponent at `DS4_SWIGLU_CLAMP_EXP = 10.0f` to avoid `expf` overflow in low-precision compute paths.
- Source: `ds4.c:56` defines the clamp.

**C. Tokenizer & chat template**

### BPE merge ranks
- Definition: The byte-pair-encoding merge table embedded in the GGUF. Together with the vocab strings it lets `bpe_tokenize_text` reproduce the exact tokenisation the model expects.
- Source: vocab loading + merge table parsing in the engine open path (search "bpe" in `ds4.c`); main entry `bpe_tokenize_text` is called from `ds4.c:15184`.

### DSML (DeepSeek Markup Language)
- Definition: The XML-ish text format the model emits for tool calls. A tool-calls block opens with `<｜DSML｜tool_calls>`; each call is wrapped in `<｜DSML｜invoke name="...">` with arguments as `<｜DSML｜parameter name="..." string="true|false">VALUE</｜DSML｜parameter>`. The server parses DSML out of the live token stream and translates it into the OpenAI / Anthropic JSON tool-call shape.
- Source: constants at `ds4_server.c:4183-4190`; the system-prompt teaching block at `ds4_server.c:2000-2012`; emission helpers at `ds4_server.c:2221-2234`.

### ds4_token_assistant / ds4_token_user / ds4_token_eos
- Definition: Special-token id accessors. The server uses them to insert role markers without hard-coding integer ids that depend on tokenizer revision.
- Source: declared at `ds4.h:151-153`.

### ds4_tokenize_rendered_chat
- Definition: Tokenise a string that is already in fully rendered chat-template form (i.e. includes the role markers and turn boundaries). Used when the disk KV cache reloads a `.kvc` file whose name encodes the rendered text.
- Source: declared at `ds4.h:138`.

### Thinking mode
- Definition: Whether the assistant must emit a hidden `<think>...</think>` block before its visible answer. Three levels: `NONE` (no think), `HIGH` (standard), `MAX` (with the reasoning-effort preamble, needs >= 384K context).
- Source: enum at `ds4.h:23`; per-turn handling in `ds4_server.c:10292` (which intentionally does _not_ replay prior `<think>` blocks).

**D. KV cache, snapshots, persistence**

### Compressed cache (in payload)
- Definition: The compressed KV rows for every position from token 0 up to the current frontier, written by `ds4_session_save_payload`. Survives across process restarts when persisted to a `.kvc` file.
- Source: per-layer compressed-block write in `ds4.c:16443`; size calculation in `ds4.c:15858`.

### `ds4_kvstore`
- Definition: The disk KV cache implementation linked into `ds4-server` and `ds4-agent`. Owns a directory of `.kvc` files, an in-memory index of entries, an LRU+hit eviction scorer, and the byte-prefix matching that lets a fresh request hit a saved checkpoint.
- Source: struct at `ds4_kvstore.h:64`; helpers throughout `ds4_kvstore.c`; the in-process state lives at `ds4_server.c:7686` (`kv_disk_cache kv`).

### Instance lock
- Definition: The advisory `flock(LOCK_EX | LOCK_NB)` ds4 takes on `/tmp/ds4.lock` (or `$DS4_LOCK_FILE`) at engine open. Prevents two ds4 processes from sharing the same machine — the mapped GGUF and Metal/CUDA resources are too large to coexist.
- Source: `ds4_acquire_instance_lock()` at `ds4.c:16014`; release at `ds4.c:16005`.

### KVC file
- Definition: A `.kvc` file on disk holding one session checkpoint. Filename is `SHA1(rendered_text).kvc`. Format: 48-byte fixed header (magic, version, quant bits, reason code, ext flags, tokens, hits, ctx_size, timestamps, payload size) followed by a 4-byte text length, the rendered text bytes, the engine-side payload, and optional trailer blocks (tool-map, responses-visible, thinking-visible, session title).
- Source: header constants at `ds4_kvstore.h:11-18`; layout in `ds4_kvstore_fill_header()` at `ds4_kvstore.c:379`; ext flags at `ds4_kvstore.h:15-18`.

### KV checkpoint
- Definition: A serialisable point in a session's history that can be reloaded into a fresh session. The on-disk form is a `.kvc` file; the in-memory form is a `ds4_session_snapshot`.
- Source: store function in `ds4_kvstore.c` (`ds4_kvstore_store_live_prefix`); load in `ds4_kvstore_try_load_text` at `ds4_kvstore.h:177`.

### KV store eviction score
- Definition: A blended score combining LRU age, hit count (with a 6-hour half-life — `DS4_KVSTORE_HIT_HALF_LIFE_SECONDS`), and how much of the live session the entry overlaps. The disk cache drops entries with the lowest score when the budget is exceeded.
- Source: `ds4_kvstore_entry_eviction_score()` at `ds4_kvstore.h:141`; the half-life constant at `ds4_kvstore.h:13`.

### Live KV (live session)
- Definition: The in-memory KV state of the single server-side `ds4_session`. There is exactly one live session per ds4-server / ds4-agent process; checkpoints to disk happen around it.
- Source: `ds4_server.c:7684` declares `ds4_session *session` on the server struct.

### Payload
- Definition: The engine-defined byte format produced by `ds4_session_save_payload`. Holds the checkpoint token ids, per-layer raw rows (E4M3 for the non-RoPE half), per-layer compressed rows, and the last-row logits. Owned by the engine; the outer file format is owned by the persistence layer.
- Source: write entry `ds4.c:16555`; load entry `ds4.c:16761`; size calculator `ds4.c:16530`.

### rax (radix tree)
- Definition: A radix tree library (originally from Redis) used by `ds4-server` to index the tool memory map: one tree by tool id, one tree by DSML text. Lets the server replay sampled tool calls by id without scanning a list.
- Source: `rax.c`, `rax.h`, `rax_malloc.h` at repo root; constructed in `ds4_server.c:7746`.

### Raw cache (in payload)
- Definition: The last `DS4_N_SWA = 128` raw rows of KV per layer, plus the E4M3-quantised non-RoPE part for the still-fresh window. Stored separately from the compressed cache because their lifetimes differ — raw rows roll out of the window quickly.
- Source: per-layer raw-block write in `ds4.c:16474`; comment at `ds4.c:15846` ("only the last few rows").

### Sink reason
- Definition: A small enum the disk KV store records on each checkpoint explaining why it was written: `COLD` (first store for a brand-new prompt prefix), `CONTINUED` (interval store along a session), `EVICT` (forced eviction), `SHUTDOWN` (graceful exit), `AGENT_SYSTEM` / `AGENT_SESSION` (agent-only). Useful in trace files to understand cache layout.
- Source: enum at `ds4_kvstore.h:20-28`.

### Tool memory / tool-id map
- Definition: An in-process map from a randomly assigned tool-call id to the exact DSML byte sequence the model sampled. When a client later replays the same tool-call id in conversation history, the server splices the remembered DSML back into the prompt instead of re-rendering JSON, keeping the KV cache aligned.
- Source: types at `ds4_server.c:7616-7649`; `tool_memory_remember()` at `ds4_server.c:8072`; canonical-rewrite escape hatch via `--disable-exact-dsml-tool-replay`.

**E. Quantisation & GGUF**

### E2M1 (FP4)
- Definition: A 4-bit floating-point format (2-bit exponent, 1-bit mantissa) ds4 supports in some helper paths for ultra-compact storage. Mostly a reference / experiment path; the production quant uses the IQ2 / Q2_K / Q8_0 mix.
- Source: `dsv4_e2m1fn_value_cpu()` around `ds4.c:1676`.

### E4M3FN (FP8)
- Definition: An 8-bit floating-point format (4-bit exponent, 3-bit mantissa, no-NaN variant) with maximum representable value `448`. ds4 quantises the non-RoPE part of every compressed-KV row in groups of 64 sharing a per-group float scale.
- Source: dequant table at `ds4.c:1611`; row-quantiser at `ds4.c:1656`; comment block at `ds4.c:1653`.

### GGUF
- Definition: The serialisation format ds4 reads its model weights from. Reuses ggml/llama.cpp conventions for tensor metadata and the standard quant block layouts (Q2_K, Q4_K, Q8_0, Q8_K, IQ2_XXS). ds4 only accepts GGUFs whose layout matches the DeepSeek V4 Flash constants — not a generic loader.
- Source: layout validator at `ds4.c:2393`; quant block structs at `ds4.c:139-162`.

### imatrix (importance matrix)
- Definition: A per-tensor column-wise activation second-moment vector collected on a calibration dataset. Feeds the 2-bit IQ2_XXS quantiser so it can keep the most important weight columns intact.
- Source: collection driven by `ds4_engine_collect_imatrix()` at `ds4.h:118`; consumed by `gguf-tools/deepseek4-quantize.c` and the `gguf-tools/imatrix/` sources.

### IQ2_XXS
- Definition: A 2-bit "importance-quantised, extra-extra-small" block format from the ggml ecosystem. Each 256-element super-block packs codebook indices plus a single fp16 scale. ds4 uses IQ2_XXS for the bulk of MoE routed gate/up weights (the params with the largest count and the lowest per-token activation rate).
- Source: block struct at `ds4.c:159`; quant tables in `ds4_iq2_tables_cuda.inc`.

### Q2_K
- Definition: A 2-bit block format with super-block + 16-element block scaling. ds4 uses it for MoE routed `down` weights. Slightly higher information density than IQ2_XXS on uniform distributions, slightly faster to decode.
- Source: block struct at `ds4.c:139`; size assert at `ds4.c:165`.

### Q4_K
- Definition: A 4-bit block format. ds4 reads it in the higher-quality MoE variant (the "q4-imatrix" download). Same super-block layout as Q2_K, twice the bits per weight.
- Source: block struct at `ds4.c:146`; size assert at `ds4.c:166`.

### Q8_0
- Definition: An 8-bit uniform block quantisation (32 elements share an fp16 scale). ds4 uses it for everything where precision matters: shared expert, attention projections, router weights, output head. Together with FP16 it forms the quality-critical "spine" of the asymmetric quant.
- Source: dequant paths throughout `gguf-tools/quants.c`; used for shared/attention tensors at `ds4.c:2693`+.

### Q8_K
- Definition: A Q8 variant with fp32 (not fp16) per-block scales, used as an activation block format during integer matmuls. Not a stored weight type — appears in the temporary activation buffer for Q2_K dot products.
- Source: block struct at `ds4.c:153`; size assert at `ds4.c:167`.

**F. Backends & kernels**

### CPU backend
- Definition: The reference fixed-point inference path; selected by `--cpu` or `--backend cpu`. Safe to use on Linux (`make cpu`); on macOS it can crash the kernel because of a virtual-memory implementation bug when the process maps a multi-tens-of-gigabytes GGUF and then asks for additional large allocations (see FAQ).
- Source: prefill walk at `ds4.c:7783`; backend gate at `ds4.c:74`.

### CUDA backend
- Definition: The NVIDIA path, primarily tuned for DGX Spark (GB10) but with a generic mode. Implemented in `ds4_cuda.cu`; builds via `make cuda-spark` or `make cuda-generic`.
- Source: `ds4_cuda.cu` (10737 lines); env-var tuning surface starts at `ds4_cuda.cu:504`.

### Flash-attention kernel
- Definition: The Metal kernel doing fused attention with on-chip K/V tiles. Persistent shared buffers (`g_flash_attn_mask_buffer` etc.) keep allocation costs out of the per-step path.
- Source: `metal/flash_attn.metal` (1426 lines); buffer declarations at `ds4_metal.m:108-113`.

### GPU resource cache (Metal residency)
- Definition: A Metal-specific cache of resident `MTLBuffer` objects that warms the GPU's wired memory on engine open. Disabled by `DS4_METAL_NO_RESIDENCY`. The same machinery also warms model views on startup unless `DS4_METAL_NO_MODEL_WARMUP` is set.
- Source: residency gate at `ds4_metal.m:415`; warmup gate at `ds4_metal.m:547`.

### Metal backend
- Definition: The Apple GPU path; the primary development / quality target. Implemented in `ds4_metal.m`; ships compiled Metal kernels in `metal/*.metal`.
- Source: `ds4_metal.m` (15738 lines); per-step graph entry around `ds4.c:13222`.

### Metal whole-model graph
- Definition: ds4 plans a single Metal command buffer that walks all 43 layers, instead of dispatching one kernel call per layer per token. This maximises pipeline utilisation by making the GPU schedule work on graph-known data dependencies.
- Source: layout in the Metal generation entry around `ds4.c:15448`.

### dsv4_hc kernel
- Definition: Metal kernel family for hyper-connection mixing and Sinkhorn iteration. The fast variant expands 4-way HC residuals into per-stream buffers in one pass.
- Source: `metal/dsv4_hc.metal` (885 lines); pipeline at `ds4_metal.m:103` (`g_dsv4_hc_expand4_pipeline`).

### dsv4_misc kernel
- Definition: Catch-all Metal kernel set for the leftover element-wise / small-tensor ops in the DeepSeek path (cross-stream copies, scale fix-ups, etc.) that don't justify a dedicated kernel.
- Source: `metal/dsv4_misc.metal` (1327 lines).

### moe kernel
- Definition: The fused Metal MoE expert dispatch. Walks the per-token expert selection and runs IQ2/Q2 weighted matmuls without staging activations through global memory.
- Source: `metal/moe.metal` (1873 lines); the CUDA counterpart starts at `ds4_cuda.cu:9938`.

**G. Server runtime (`ds4_server.c`)**

### Canonical rewrite fallback
- Definition: When the exact-DSML tool-replay path is disabled (via `--disable-exact-dsml-tool-replay`), the server falls back to re-rendering tool calls from canonical JSON. This is less efficient (small KV-cache misses are likely) but the only option when client-side tool history was lost.
- Source: env gate at `ds4_server.c:7691` (`disable_exact_dsml_tool_replay`); message at `ds4_server.c:11565`.

### Client thread
- Definition: One pthread per accepted HTTP connection, spawned from the server accept loop. Parses requests, builds a `job` on its stack, hands it to the worker, then writes the SSE/HTTP response as the worker reports tokens.
- Source: `client_main` at `ds4_server.c:11078`; spawned at `ds4_server.c:11624`.

### Graph worker (single)
- Definition: The single dedicated pthread that owns the Metal/CUDA session and serialises all inference work. Implemented as `worker_main` pulling `job`s off a linked-list queue. There is exactly one worker per server: the GPU session is not shareable.
- Source: `worker_main` at `ds4_server.c:10910`; queue at `ds4_server.c:7697-7698` (`head`, `tail`); dequeue / enqueue at `ds4_server.c:10882`, `:10895`.

### In-think tool call
- Definition: A tool-call DSML block emitted by the model _inside_ a `<think>...</think>` reasoning span (as opposed to after it). The server stops generation cleanly when this happens so the client can run the tool and reply. See commit `b63d77a` for the introduction of this stop reason.
- Source: see the commit `Stop generation on in-think tool calls`; surfaces in generation tracking inside `generate_job`.

### Job
- Definition: A stack-owned struct on a client thread holding the request, the socket fd, and a done/cv flag. The worker thread mutates `done` when generation finishes; the client thread waits on the cv before returning to HTTP-response writing.
- Source: struct at `ds4_server.c:7710-7717` (note the explicit comment about why it is _not_ heap-allocated).

### Prefill chunking
- Definition: Long prompts are split into micro-batches (ubatches) before being prefilled. Each chunk is sized by `ds4_default_prefill_cap_for_prompt()`; the default cap can be overridden by `DS4_METAL_PREFILL_CHUNK`.
- Source: chunk picker at `ds4.c:6184`; env override at `ds4.c:6209`.

### Server config
- Definition: The parsed argv shape of `ds4-server`, holding engine options, `ctx_size`, `kv_disk_dir`, `kv_cache` options, `default_tokens`, `disable_exact_dsml_tool_replay`, `tool_memory_max_ids`, `enable_cors`, `chdir_path`, `trace_path`.
- Source: returned from `parse_options()` at `ds4_server.c:11520`.

### SSE streaming
- Definition: All three streamed dialects (`/v1/chat/completions`, `/v1/responses`, Anthropic `/v1/messages`) use Server-Sent Events. ds4 has separate writer helpers per dialect: `sse_chunk`, `responses_sse_emit_event`, `anthropic_sse_open_block`, etc.
- Source: openai stream helpers at `ds4_server.c:4850-5146`; responses at `:6025-6431`; anthropic at `:6893-7045`.

### Trace file
- Definition: An optional human-readable log of every cache lookup, prefill, decode, and tool-memory operation. Enabled via `--trace PATH`; keys like `cache_source: memory-text` and `kv cache hit text` make it the primary debugging tool for cache effectiveness.
- Source: `s.trace` field at `ds4_server.c:7702`; CLI flag at `ds4_server.c:11456`.

### ubatch (micro-batch)
- Definition: The per-step chunk of prompt tokens that the Metal/CPU prefill processes together. Sized by `ds4_default_prefill_cap_for_prompt()` (typically up to 2048 on Metal) so kernel scheduling and KV-allocation stays predictable.
- Source: `ds4.c:6184` (chunk picker).

**H. CLI binaries**

### ds4 (CLI)
- Definition: The interactive command-line client. Loads an engine, optionally a single `-p` prompt or `--prompt-file`, otherwise drops into a `linenoise`-driven chat REPL. Also hosts the imatrix collector, the head/first-token/metal-graph smoke tests, and the token dumper.
- Source: `ds4_cli.c:1571` (`main`); argv parser at `ds4_cli.c:1409`.

### ds4-agent
- Definition: A standalone TUI coding agent. One process, one DS4 session, one worker thread; full tool stack (shell exec, web browsing via `ds4_web.c`, etc.) so an instance can do work end-to-end without an external client.
- Source: `ds4_agent.c` (9545 lines); web helper at `ds4_web.c`.

### ds4-bench
- Definition: The throughput benchmark. Walks one fixed prompt to configurable context frontiers, measures the newest prefill interval and a fixed greedy decode at each frontier, optionally writing CSV. Uses `ds4_session_save_snapshot` to bracket the timed sections.
- Source: `ds4_bench.c:1-50` describes the methodology.

### ds4-eval
- Definition: A small built-in benchmark integration harness. Loads the real model, runs an audited subset (GPQA Diamond, SuperGPQA, AIME 2025, COMPSEC) through full prefill + sampling + grading. Pure ANSI two-pane TUI; no ncurses.
- Source: `ds4_eval.c:1-30` (top comment).

### ds4-server
- Definition: The HTTP server. Speaks OpenAI chat-completions, OpenAI Responses, and Anthropic messages dialects. Single graph worker; one or more client threads; optional disk KV cache; optional tool-memory.
- Source: `ds4_server.c` (15348 lines); `main()` at `:11524`.

### gguf-tools
- Definition: Standalone tools for inspecting and producing GGUF files: `deepseek4-quantize` (run the calibrated quantisation pipeline for DeepSeek V4 Flash) plus quality-testing harnesses and the imatrix collection runner.
- Source: `gguf-tools/deepseek4-quantize.c` (1888 lines); shared quant kernels in `gguf-tools/quants.c` (1109 lines).

### linenoise
- Definition: The MIT-licensed single-file line-editor library that powers `ds4`'s REPL and `ds4-agent`'s prompt. Provides history, multi-line editing, and a multiplexed editor needed by the agent.
- Source: `linenoise.c`, `linenoise.h`; an extra `linenoiseEditInsert` symbol is forward-declared in `ds4_agent.c:33`.

**I. Miscellaneous & utilities**

### `--power` / power_percent
- Definition: A duty-cycle throttle that inserts calibrated `nanosleep` gaps between layer kernels so the engine runs at roughly N% of full throughput. Useful for keeping a laptop battery and fans tame during long agent sessions. Plumbed through `ds4_engine_options.power_percent`, `ds4_engine_set_power`, `ds4_session_set_power`.
- Source: declared at `ds4.h:100-101` and `ds4.h:157-158`; throttle implementation `graph_power_sleep()` at `ds4.c:8359`.

### `--quality`
- Definition: Engine-wide flag that opts into the slower / higher-precision compute paths: stricter MTP verification, no TF32 on CUDA, lower-error fast-math choices in mixed-precision kernels. Pays a real throughput cost; recommended only for evaluation or when reproducing benchmark numbers.
- Source: `ds4.h:74` (`opt.quality`); read at `ds4.c:18363` (`strict_mtp = e->quality || ...`) and at `ds4_cuda.cu:1216`, `:1575` (TF32 gate).

### `--warm-weights`
- Definition: Touch every page of every weight tensor after engine open, so subsequent prefill / decode steps don't pay first-touch faulting latency. Trades startup time for steady-state determinism.
- Source: `ds4.h:73` declares `opt.warm_weights`; CLI flag at `ds4_cli.c:1540`.

### Default model path
- Definition: When `-m` is not supplied, both `ds4` and `ds4-server` look for `./ds4flash.gguf` in the current working directory. `ds4-server`'s `--chdir` flag is useful when a wrapper needs the binary to find both the model and the `metal/*.metal` source tree from a fixed base.
- Source: `ds4_cli.c:1412` (`.model_path = "ds4flash.gguf"`); `ds4_server.c:11448` (`--chdir`).

### Directional steering
- Definition: A research-style steering vector loaded from a file via `--dir-steering-file`. Its FFN-stream scale (`--dir-steering-ffn`) and attention-stream scale (`--dir-steering-attn`) inject the vector into each layer's residual streams; default FFN scale is 1.0, default attention scale is 0. Lives in `dir-steering/`.
- Source: `ds4.h:69-71` declares the option fields; `ds4_cli.c:1479-1486` parses the flags.

### `make test`
- Definition: The repository-level test target. Builds `ds4_test` and `ds4-eval`, then runs `./ds4-eval --self-test-extractors` followed by `./ds4_test`. The latter requires a real model file (it links the engine, not stubs).
- Source: `Makefile:194-196`.

### `ds4_test`
- Definition: A small unit-test runner that includes `ds4_server.c` directly (via `tests/ds4_test.c`) so the file-internal helpers can be exercised. Has a `--server` mode for server-specific tests.
- Source: `Makefile:148-149`, `:187-192`; sources under `tests/`.

---

## Part 2: FAQ

### Why a model-specific engine instead of a generic GGUF runtime?

The whole point of ds4 is to have a small, readable inference codebase that does one thing very well. Every model dimension (`DS4_N_LAYER = 43`, `DS4_N_EMBD = 4096`, `DS4_N_VOCAB = 129280`, `DS4_N_EXPERT = 256`, etc.) is a compile-time constant the kernels and shaders specialise on. The validator at `ds4.c:2393` actively rejects GGUFs that do not match this fixed shape. Supporting a generic runtime would force runtime dimension queries, dynamic kernel selection, and a much larger surface — directly at odds with the project's "small readable C" goal.

### Why mmap the GGUF instead of reading it into RAM?

Because GGUF weights are multi-tens-of-gigabytes and the OS is excellent at paging cold pages back out. mmap means startup time is dominated by the metadata walk, not by I/O, and the kernel can drop and re-fetch routed-expert pages on demand. The KV cache files on disk are deliberately _not_ mmap'd: the process already holds a huge mapped weight file, and adding more VM mappings risks the macOS VM bug discussed below. The strategy is documented in the comment block around `ds4.c:15620`.

### What does "ratio-4" actually mean — ratio of what?

It is the ratio between the raw head dimension and the compressed head dimension in MLA-style attention. `ds4_layer_compress_ratio(il)` (`ds4.c:418`) returns 0 for the first two dense layers, then alternates 4 and 128 for the remaining 41 layers. Ratio-4 layers also carry an indexer (`DS4_N_INDEXER_HEAD = 64`, `DS4_N_INDEXER_TOP_K = 512`) that selects which compressed rows participate in attention, turning dense attention over a million-token compressed history into top-512 sparse attention.

### Why is only the routed expert path 2-bit quantised?

Because the routed experts contain the vast majority of parameters (256 experts per MoE layer × 41 MoE layers × 3 tensors each at `DS4_N_FF_EXP = 2048`) but only `DS4_N_EXPERT_USED = 6` of them activate per token. Loss in those weights spreads over the whole context, and an importance-matrix-guided 2-bit format (IQ2_XXS for gate/up; Q2_K for down — see the block-struct declarations at `ds4.c:139-162`) preserves quality at a fraction of the disk and bandwidth cost. The quality-critical path (shared expert, attention Q/KV/O projections, router weights, output head) stays at Q8_0 or FP16.

### How does ds4 handle a 1M-token context on a 96 GB machine?

Two compounding tricks. (1) The compressed KV cache stores each token's K/V at ratio-4 or ratio-128 of the raw size, with the non-RoPE half quantised to E4M3 FP8 (`ds4.c:1656`). A million compressed rows fit where 30k raw rows would not. (2) Ratio-4 layers replace dense attention with top-`DS4_N_INDEXER_TOP_K = 512` sparse attention through the indexer (`ds4.c:113`), so compute and bandwidth at decode time stays bounded regardless of how many compressed rows are stored.

### What is the difference between raw cache and compressed cache?

The raw cache (SWA cache) is the last `DS4_N_SWA = 128` rows of unquantised KV per layer. It feeds local-attention layers and is the source from which fresh compressed rows are derived. The compressed cache is the long-term store: a lower-dimensional KV representation (ratio-4 or ratio-128) covering every position from token 0 to the current frontier, with the non-RoPE half quantised to E4M3. Both are written to disk by `ds4_session_save_payload` (`ds4.c:16555`) but their sizes differ by orders of magnitude.

### When does speculative decoding (MTP) help vs hurt?

MTP helps when sampling is greedy (`temperature = 0` / argmax) and the draft model's predictions agree with the full model often enough. ds4 enforces this: speculative decoding only runs through `ds4_session_eval_speculative_argmax` (`ds4.c:18316`), gated behind the `temperature == 0` branch in the server (`ds4_server.c:10292`). It hurts when the draft repeatedly disagrees, because each verification still does a full forward pass; the `--mtp-margin` flag (default 3.0) tunes how confident the draft has to be before its prediction is accepted. `DS4_MTP_SPEC_DISABLE` is the kill switch.

### Why does ds4-server have a single serial graph worker?

Because the GPU session is not shareable. There is exactly one `ds4_session *session` on the server struct (`ds4_server.c:7684`) and exactly one `worker_main` pthread (`ds4_server.c:10910`) that mutates it. Jobs are enqueued by the per-connection client thread and processed strictly in arrival order. Multiplexing two LLM clients on one ds4-server is therefore round-robin queueing — fine for a personal agent stack, not the design for a multi-tenant fleet.

### How does the disk KV cache differ from the in-memory KV cache?

The in-memory cache is just the live `ds4_session`: one timeline, one set of raw and compressed rows, no on-disk component. The disk cache (`ds4_kvstore`, in `ds4_kvstore.h:64`) is a directory of `.kvc` checkpoint files, indexed by SHA1 of the rendered prompt text. When a fresh request arrives, the server text-prefix-matches it against the disk index, picks the best entry, loads it into the live session, and prefills only the suffix. The disk cache is what enables cross-process recovery (server restart, client switch on the same physical machine, etc.).

### What is "thinking mode" and what is the difference between high and max?

Thinking mode determines how much hidden reasoning the assistant emits between the user message and the visible answer. `DS4_THINK_NONE` skips it entirely. `DS4_THINK_HIGH` emits a standard `<think>...</think>` block. `DS4_THINK_MAX` additionally tokenises the `DS4_REASONING_EFFORT_MAX_PREFIX` preamble (`ds4.c:64`) before the user message — a four-line "Absolute maximum, no shortcuts" instruction. Because MAX needs a large reasoning budget, the engine auto-downgrades to HIGH whenever the context is below `DS4_THINK_MAX_MIN_CONTEXT = 393216` tokens (`ds4.c:72`).

### What is DSML and why not just JSON tool calls?

DSML is the XML-ish text format the model was trained to emit for tool calls (constants at `ds4_server.c:4183-4190`). The reason to keep it is KV-cache alignment: when an OpenAI/Anthropic client later replays a tool call in conversation history, it sends JSON, and re-rendering that JSON back to bytes will usually not produce the exact byte sequence the model originally sampled. That mismatch breaks the prefix-reuse property `ds4_session_sync` (`ds4.c:17924`) relies on. The tool memory (`ds4_server.c:8072`) remembers the original DSML under a generated tool id; when the id comes back, the server splices the remembered bytes back into the prompt, keeping the cache aligned.

### How big can a single prompt be? What about a session?

A single prompt is bounded by the engine's `ctx_size`, set when `ds4_session_create` is called (`ds4.c:17796`). The CLI defaults to `32768`; the server is configured with `--ctx`. The hard architectural ceiling is whatever `DS4_THINK_MAX_MIN_CONTEXT` happens to be — but the practical ceiling is set by available RAM: compressed KV bytes scale linearly with context. The 96 GB Mac configuration in the README hits about 250K tokens comfortably; 512 GB Mac Studio reaches near-1M.

### Can I run ds4 without a GPU?

Yes, on Linux, by building with `make cpu`. The CPU prefill walks layer-major over micro-batches starting at `ds4.c:7783` and gives a real (if slow) inference loop. On macOS the CPU path is dangerous: a current macOS kernel virtual-memory bug can crash the machine when the process has the multi-tens-of-gigabytes GGUF mapped and additionally tries to allocate the CPU intermediate buffers. The README is explicit about this. The Metal path is the default and the safe path on macOS.

### How does ds4 compare to llama.cpp on the same model?

ds4 reads the same GGUF format and shares the IQ2_XXS / Q2_K / Q8_0 block layouts, but the architecture-specific paths are different. ds4 has the indexer in ratio-4 layers (`ds4.c:113`), the 4-way hyper-connection with Sinkhorn normalisation (`ds4.c:114-115`), the layer-major Metal whole-model graph (`ds4.c:15448`), and the asymmetric MoE-routed-only quantisation. None of that is in llama.cpp's generic Transformer path. The trade-off is generality: ds4 will refuse to load anything that is not the exact DeepSeek V4 Flash shape.

### How do I add support for a new quantisation format?

You would add (1) the block struct + size assert at `ds4.c:139-168`, (2) a dequant kernel in `gguf-tools/quants.c`, (3) the CPU per-row reader in the routed-MoE loop in `ds4.c`, (4) a Metal kernel under `metal/moe.metal` (or a new file), and (5) a CUDA kernel in `ds4_cuda.cu`. Then the validator at `ds4.c:2393` needs to allow the new tensor type for the right tensor names. It is not a small change: the kernels are intentionally specialised on the format constants.

### Why is `previous_response_id` / `conversation` rejected on the Responses endpoint?

Because ds4 does not yet ship a durable response object store. Accepting either field without loading the referenced items would silently truncate the prompt — much worse than failing fast — so the server explicitly returns an error when they are non-null (`ds4_server.c:3819-3841`). The supported modes are (a) a live in-memory continuation that is validated by visible-transcript hashing and tool-call ids, or (b) fully stateless replay of the entire input list. The trace logs each cache decision with `cache_source: …` keys so the operator can tell which path a turn took.

### What does the trace file actually contain?

Once `--trace PATH` is set, every cache lookup, prefill, decode, tool-memory operation, and store / evict decision is logged as a free-form line keyed by request id. The most useful keys are `cache_source: memory-text`, `cache_source: memory-token`, `cache_source: responses-visible`, `cache_source: responses-tool-output`, `cache_source: anthropic-tool-output`, `cache_source: thinking-visible`, `kv cache hit text` (disk hit), `canonicalization needs rebuild` (rare — and should be avoided), and `tool replay: mem=N disk=M`. Open the trace alongside the request log to understand throughput problems.

### How does the agent stay responsive while the worker thread is generating?

`ds4-agent` is a deliberately simple split: the UI thread owns the terminal (`linenoise` for editing, ANSI for redraw), the worker thread owns the live DS4 session and KV state. They share a small streaming buffer; the worker pushes assistant tokens and DSML events, the UI thread debounces redraws. `linenoiseEditInsert` is the deliberately not-public symbol the agent reaches into to restore typed text after Enter is pressed during generation (`ds4_agent.c:33`).

### What is "in-think tool call" handling and why did it need a stop reason?

Sometimes the model emits a DSML tool-calls block from inside an open `<think>` reasoning span. Before commit `b63d77a` ("Stop generation on in-think tool calls") ds4 would continue sampling past that point, which mixed the post-tool answer text with tool-call arguments and corrupted the chat-template state. The fix: stop generation cleanly when a DSML tool-call open tag is detected inside a `<think>` span, hand the call back to the client, and let the client deliver the tool result that closes the think turn.

---

## Part 3: Cheat sheet appendix

**Environment variables**

Only the env vars that affect _public_ behaviour are listed. Many internal CUDA/Metal kernel toggles exist (search `getenv("DS4_CUDA_` and `getenv("DS4_METAL_` in source) — they are intentionally undocumented and reserved for kernel A/B work.

| Variable | Location | Effect |
|---|---|---|
| `DS4_LOCK_FILE` | `ds4.c:16015` | Override the path used by the process-wide instance lock (default `/tmp/ds4.lock`). |
| `DS4_THREADS` | `ds4.c:710` | Override the CPU thread count for the CPU backend. |
| `DS4_MTP_SPEC_DISABLE` | `ds4_server.c:10292`, `ds4_cli.c:531`, `ds4_cli.c:1179` | Kill switch for MTP speculative decoding even when the MTP file was loaded. |
| `DS4_MTP_PROBE` | `ds4.c:18257`, `:18297` | Log per-step speculative-decoding telemetry. |
| `DS4_MTP_STRICT` | `ds4.c:18363` | Force the strict MTP verification path even outside `--quality`. |
| `DS4_MTP_MIN_MARGIN` | `ds4.c:18365` | Override the draft-vs-target acceptance margin. |
| `DS4_MTP_TIMING` | `ds4.c:18371` | Log timing of each speculative segment. |
| `DS4_MTP_SPEC_LOG` | `ds4.c:18388`, `:18570`, `:18823`, `:18840`, `:18893` | Verbose per-step speculative trace. |
| `DS4_MTP_BATCH_VERIFY` | `ds4.c:18490` | Force one-shot batch verification of the 2-token draft. |
| `DS4_MTP_FULL_LOGITS` | `ds4.c:18293`, `:18374` | Keep full draft logits around for diagnostics. |
| `DS4_MTP_FORCE_SNAPSHOT` | `ds4.c:18596` | Force a snapshot capture at the speculative branch. |
| `DS4_MTP_EXACT_REPLAY` | `ds4.c:18592` | Force exact-replay verification (debug-only). |
| `DS4_MTP_CAPTURE_PREFIX1` | `ds4.c:18591` | Capture prefix-1 state for N=2 speculation. |
| `DS4_MTP_CONF_LOG` | `ds4.c:18372` | Log per-step draft confidence. |
| `DS4_METAL_PREFILL_CHUNK` | `ds4.c:6209` | Override Metal prefill ubatch size (default picked by `ds4_default_prefill_cap_for_prompt()`). |
| `DS4_METAL_NO_RESIDENCY` | `ds4_metal.m:415`, `:537`, `:547`, `:1345` | Disable Metal GPU residency cache. |
| `DS4_METAL_NO_MODEL_WARMUP` | `ds4_metal.m:548` | Skip the engine-open Metal model warmup pass. |
| `DS4_METAL_MEMORY_REPORT` | `ds4.c:14419`, `:15834` | Dump a Metal memory-usage report after engine open. |
| `DS4_METAL_TRACE_ALLOCS` | `ds4_metal.m:1289` | Trace Metal allocation requests. |
| `DS4_METAL_MODEL_WARMUP_STRIDE_MB` | `ds4_metal.m:914` | Override the model-warmup page stride. |
| `DS4_METAL_GRAPH_DUMP_PREFIX` / `_NAME` / `_LAYER` / `_POS` | `ds4.c:8670-8680` | Dump intermediate Metal graph tensors to disk for diff testing. |
| `DS4_METAL_GRAPH_TRACE_LAYERS` | `ds4.c:10983` | Trace per-layer Metal graph execution. |
| `DS4_METAL_GRAPH_TEACHER_FORCE` | `ds4.c:10986` | Teacher-force the Metal graph against a CPU reference. |
| `DS4_METAL_DECODE_STAGE_PROFILE` | `ds4.c:9496` | Stage-level profiling of Metal decode. |
| `DS4_METAL_INDEXER_STAGE_PROFILE` | `ds4.c:9649` | Stage-level profiling of the indexer kernel. |
| `DS4_METAL_LAYER_STAGE_PROFILE` | `ds4.c:11477` | Stage-level profiling per layer. |
| `DS4_METAL_Q_STAGE_PROFILE` | `ds4.c:11478` | Stage-level profiling of the Q projection. |
| `DS4_METAL_GRAPH_TOKEN_PROFILE` | `ds4.c:13134` | Profile the full token graph. |
| `DS4_METAL_GRAPH_PREFILL_PROFILE` | `ds4.c:13629` | Profile the Metal prefill graph. |
| `DS4_METAL_GRAPH_PREFILL_SPLIT_PROFILE` | `ds4.c:13617` | Profile prefill split phases. |
| `DS4_METAL_GRAPH_OUTPUT_ROW` | `ds4.c:13662`, `:13827` | Override the output row index in the test graphs. |
| `DS4_METAL_GPU_BATCH_EMBED_MIN` | `ds4.c:11321` | Minimum tokens before using GPU batched embed. |
| `DS4_METAL_NO_PREFILL_KERNEL_WARMUP` | `ds4.c:11354` | Skip the prefill kernel warmup. |
| `DS4_METAL_GRAPH_TOKEN_SPLIT_LAYERS` | `ds4.c:11143` | Split the token graph after this many layers. |
| `DS4_METAL_DISABLE_SHARED_GATE_UP_SWIGLU_FUSION` | `ds4.c:10168` | Disable the fused shared-expert gate+up+SwiGLU kernel. |
| `DS4_DECODE_PROFILE_DETAIL` | `ds4.c:5691`, `:5796`, `:7562` | Detailed decode-phase profile output. |
| `DS4_PREFILL_PROFILE_DETAIL` | `ds4.c:6002`, `:7213` | Detailed prefill-phase profile output. |
| `DS4_PREFILL_PROFILE_TOKEN` | `ds4.c:7520` | Per-token prefill profile. |
| `DS4_PREFILL_BATCH` | `ds4.c:7804` | Override prefill batch size (CPU). |
| `DS4_BATCHED_FFN` | `ds4.c:7801` | Force the batched FFN path. |
| `DS4_PARALLEL_FFN` | `ds4.c:7802` | Force per-expert parallel FFN. |
| `DS4_NO_SHARED_BATCH_FFN` | `ds4.c:7803` | Disable the shared-expert batched FFN. |
| `DS4_NO_BATCHED_ATTN` | `ds4.c:7800` | Disable batched attention. |
| `DS4_BATCHED_ROPE_MAX` | `ds4.c:7301` | Maximum tokens per batched RoPE call. |
| `DS4_NO_BATCHED_ROPE` | `ds4.c:7308` | Disable batched RoPE. |
| `DS4_PARALLEL_ATTN_ROWS` / `DS4_NO_PARALLEL_ATTN_ROWS` | `ds4.c:7291`, `:7294` | Force / disable parallel attention rows. |
| `DS4_ROUTED_TOKEN_PARALLEL` / `DS4_NO_ROUTED_TOKEN_PARALLEL` | `ds4.c:6018-6019` | Force / disable parallel routed-token dispatch. |
| `DS4_TRACE_TOP` | `ds4.c:15695`, `:15838` | Print top-k tokens at every step. |
| `DS4_TOKEN_TIMING` | `ds4.c:15726`, `:15839` | Per-token wall-clock log. |
| `DS4_CPU_DUMP_LOGITS` | `ds4.c:14457` | Dump CPU logits at the test entry. |
| `DS4_CPU_DUMP_PREFILL_LOGITS` | `ds4.c:15713` | Dump CPU prefill logits. |
| `DS4_METAL_DUMP_PREFILL_LOGITS` | `ds4.c:15860` | Dump Metal prefill logits. |
| `DS4_ORACLE_LOGITS` | `ds4.c:14428` | Load an oracle logits file for the graph-test. |
| `DS4_CUDA_WEIGHT_PRELOAD_SPAN_MB` | `ds4.c:1385` | CUDA weight-preload span size. |
| `DS4_CUDA_DIRECT_MODEL` | `ds4.c:1450` | Skip the CUDA model copy; use the mapping directly. |
| `DS4_CUDA_Q8_F16_PRELOAD` / `DS4_CUDA_Q8_F32_PRELOAD` | `ds4.c:1457-1458` | CUDA Q8 weight preload precision. |
| `DS4_CUDA_NO_TF32` | `ds4_cuda.cu:1216`, `:1575` | Disable TF32 in cuBLAS. |
| `DS4_CUDA_MOE_PROFILE` | `ds4_cuda.cu:9938` | Profile CUDA MoE kernels. |
| `DS4_CUDA_WEIGHT_CACHE_*` family | `ds4_cuda.cu:573`+ | Tune the CUDA weight cache (verbose, limit, arena). |

**CLI flags — `./ds4`**

Parsed in `ds4_cli.c:1431-1549`. Defaults are set at `ds4_cli.c:1410-1428`.

| Flag | Effect |
|---|---|
| `-h`, `--help` | Print usage. |
| `-p`, `--prompt TEXT` | Run a single prompt non-interactively. |
| `--prompt-file PATH` | Read the prompt from a file. |
| `-sys`, `--system TEXT` | Override the system message (default `"You are a helpful assistant"`). |
| `-m`, `--model PATH` | GGUF path (default `ds4flash.gguf`). |
| `--mtp PATH` | Load an MTP draft model (enables speculative decode in greedy). |
| `--mtp-draft N` | Number of draft tokens per speculation (default 1). |
| `--mtp-margin F` | Acceptance margin for the draft (default 3.0). |
| `-n`, `--tokens N` | Max tokens to generate (default 50000). |
| `-c`, `--ctx N` | Context size (default 32768). |
| `--temp F` | Sampling temperature. |
| `--top-p F` | Top-p sampling. |
| `--min-p F` | Min-p sampling cutoff (default 0.05). |
| `--seed U` | RNG seed (uint64). |
| `--quality` | Enable the higher-precision compute paths (slower, stricter MTP). |
| `--power N` | Limit GPU duty cycle to N% (1-100). |
| `--dir-steering-file PATH` | Load a directional-steering vector file. |
| `--dir-steering-ffn F` | Steering scale for FFN streams. |
| `--dir-steering-attn F` | Steering scale for attention streams. |
| `-t`, `--threads N` | CPU thread count. |
| `--backend B` / `--cpu` / `--metal` / `--cuda` | Backend selection. |
| `--dump-tokens` | Print the tokenisation of `-p` text and exit. |
| `--dump-logits PATH` | Dump per-token logits to PATH. |
| `--dump-logprobs PATH` | Dump top-k log-probs to PATH. |
| `--logprobs-top-k N` | Top-k size for `--dump-logprobs` (default 20). |
| `--perplexity-file PATH` | Run perplexity over the file. |
| `--imatrix-dataset PATH` / `--imatrix-out PATH` | Collect an importance matrix. |
| `--imatrix-max-prompts N` / `--imatrix-max-tokens N` | Caps for imatrix collection. |
| `--think` | `DS4_THINK_HIGH` (default). |
| `--think-max` | `DS4_THINK_MAX` (requires ctx >= 393216). |
| `--nothink` | `DS4_THINK_NONE`. |
| `--head-test` | Lightweight head-only smoke test. |
| `--first-token-test` | Generate just the first token and exit. |
| `--metal-graph-test` / `--metal-graph-full-test` / `--metal-graph-prompt-test` | Metal-graph regression tests. |
| `--inspect` | Print model info and exit. |
| `--warm-weights` | Touch every weight page after open. |

REPL-only slash commands (`ds4_cli.c:1310`+): `/ctx N`, `/read PATH`, `/help`, `/quit` / `/exit`.

**CLI flags — `./ds4-server`**

Parsed in `ds4_server.c:11431-11520`.

| Flag | Effect |
|---|---|
| `-h`, `--help` | Print usage. |
| `-m`, `--model PATH` | GGUF path (default `ds4flash.gguf`). |
| `--mtp PATH` / `--mtp-draft N` / `--mtp-margin F` | MTP setup. |
| `-c`, `--ctx N` | Context size. |
| `-n`, `--tokens N` | Default `max_tokens` if a request omits it. |
| `-t`, `--threads N` | CPU thread count. |
| `--chdir PATH` | `chdir()` here before opening Metal kernels (for relative `metal/*.metal` lookup). |
| `--host HOST` / `--port N` | Bind address (default port handled internally). |
| `--cors` | Enable permissive CORS headers. |
| `--trace PATH` | Write the diagnostic trace log. |
| `--kv-disk-dir PATH` | Enable the disk KV cache rooted at PATH. |
| `--kv-disk-space-mb MB` | Disk cache budget (default `DS4_KVSTORE_DEFAULT_MB = 4096`). |
| `--kv-cache-min-tokens N` | Smallest prompt for which to write a checkpoint. |
| `--kv-cache-cold-max-tokens N` | Skip cold checkpointing above this size. |
| `--kv-cache-continued-interval-tokens N` | Token interval for "continued" checkpoints. |
| `--kv-cache-boundary-trim-tokens N` | Trim policy at chat-turn boundaries. |
| `--kv-cache-boundary-align-tokens N` | Align policy at chat-turn boundaries. |
| `--kv-cache-reject-different-quant` | Refuse cross-quant reuse. |
| `--disable-exact-dsml-tool-replay` | Force canonical-JSON tool replay. |
| `--tool-memory-max-ids N` | Override `DS4_TOOL_MEMORY_DEFAULT_MAX_IDS = 100000`. |
| `--quality` / `--power N` | Same semantics as `ds4`. |
| `--dir-steering-file` / `--dir-steering-ffn F` / `--dir-steering-attn F` | Directional steering. |
| `--warm-weights` | Touch weight pages after open. |
| `--metal` / `--cuda` / `--cpu` / `--backend B` | Backend selection. |

**Common build commands**

From `Makefile`:

```sh
# macOS Metal (default)
make                  # builds ./ds4, ./ds4-server, ./ds4-bench, ./ds4-eval, ./ds4-agent

# Linux CUDA
make cuda-spark       # DGX Spark / GB10 (default CUDA_ARCH)
make cuda-generic     # local CUDA GPU (CUDA_ARCH=native)
make cuda CUDA_ARCH=sm_120   # explicit nvcc -arch

# CPU-only
make cpu              # safe on Linux; not on macOS (see FAQ)

# Tests
make ds4_test         # build only
make test             # builds + runs ./ds4-eval --self-test-extractors then ./ds4_test
make cuda-regression  # CUDA long-context smoke (Linux only)

# Clean
make clean
```

Compiler defaults (`Makefile:11-12`): `-O3 -ffast-math -g -march=native -Wall -Wextra -std=c99` (and `-fobjc-arc` for the Metal Obj-C source). Set `DEBUG_FLAGS=` to drop the `-g` line; set `CFLAGS=-fsanitize=address,undefined` to build an ASAN ds4.

**Common runtime invocations**

```sh
# Inspect a model file (no inference)
./ds4 --inspect

# One-shot prompt
./ds4 -m ds4flash.gguf -p "Explain the indexer in one paragraph."

# Interactive REPL (default if no -p)
./ds4 -m ds4flash.gguf
#   /ctx 65536      change context size
#   /read PATH      paste a file as the next user message
#   /help           list commands
#   /quit           exit

# Deep reasoning prompt (auto-downgrades to --think if ctx < 393216)
./ds4 --think-max --ctx 393216 -p "..."

# Server with disk KV cache enabled
./ds4-server \
    -m ds4flash.gguf \
    --ctx 100000 \
    --kv-disk-dir /tmp/ds4-kv \
    --kv-disk-space-mb 8192 \
    --trace /tmp/ds4-trace.txt \
    --port 8080

# OpenAI-style call into the server
curl -s http://localhost:8080/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model":"ds4","messages":[{"role":"user","content":"Hello"}],"stream":false}'

# Benchmark throughput across context frontiers
./ds4-bench \
    -m ds4flash.gguf \
    --prompt-file speed-bench/promessi_sposi.txt \
    --ctx-start 2048 --ctx-max 65536 --step-incr 2048 --gen-tokens 128
```

**Trace-file keys cheat sheet**

| Key | Meaning |
|---|---|
| `cache_source: memory-token` | Exact token-prefix match against the live KV. |
| `cache_source: memory-text` | Rendered-text prefix match against the live KV. |
| `cache_source: responses-visible` | Match against the Responses visible-transcript trailer. |
| `cache_source: responses-tool-output` | Match against the responses tool-output-only trailer. |
| `cache_source: anthropic-tool-output` | Anthropic live tool-output match. |
| `cache_source: thinking-visible` | Match against a stored thinking-visible trailer. |
| `kv cache hit text` | Disk KV cache hit on rendered text. |
| `canonicalization needs rebuild` | Tool checkpoint needed a fallback rebuild — should be rare. |
| `tool replay: mem=N disk=M` | Counts of replayed tool calls from in-process tool memory vs disk. |
| `thinking live checkpoint remembered` | A `thinking-visible` key was added to the live tool state. |

**Source file map**

Top-level C / Obj-C / CUDA files at `f91c12b`. Line counts via `wc -l`.

| File | Lines | What lives here |
|---|---:|---|
| `ds4.c` | 18930 | The engine: GGUF loader, layer table, tokenizer, CPU prefill/decode, Metal/CUDA graph driver, public API (`ds4_engine_open`, `ds4_session_*`, `ds4_chat_*`), MTP speculative decode. |
| `ds4.h` | 210 | Public engine boundary; the only header `ds4_cli.c` / `ds4_server.c` / `ds4_agent.c` include. |
| `ds4_cli.c` | 1614 | The `ds4` interactive REPL and one-shot CLI; uses `linenoise` for the editor. |
| `ds4_server.c` | 15348 | `ds4-server`: HTTP listener, OpenAI / Responses / Anthropic dialect implementations, tool-call DSML, single graph worker, tool memory, disk KV cache glue. |
| `ds4_agent.c` | 9545 | `ds4-agent`: standalone TUI coding agent (its own worker thread, its own KV-cache integration, shell-exec and web tools). |
| `ds4_bench.c` | 534 | `ds4-bench`: throughput benchmark with snapshot/restore between frontier measurements. |
| `ds4_eval.c` | 3813 | `ds4-eval`: built-in audited GPQA/SuperGPQA/AIME/COMPSEC harness with a two-pane TUI. |
| `ds4_metal.m` | 15738 | Metal backend: kernel pipelines, GPU residency cache, command-buffer planning, shared buffers (`g_flash_attn_*` etc.). |
| `ds4_cuda.cu` | 10737 | CUDA backend: kernels for attention, MoE, indexer, weight cache; the env-var-driven kernel selection lives here. |
| `ds4_gpu.h` | 819 | Shared GPU interface (`#include`'d by `ds4.c` when not `DS4_NO_GPU`); the boundary the backend modules implement. |
| `ds4_kvstore.c` | 1278 | Disk KV cache: `.kvc` file format, header read/write, eviction scoring, byte-prefix matching. |
| `ds4_kvstore.h` | 205 | Disk-cache public types and helpers. |
| `ds4_web.c` | 1269 | Web fetcher used by `ds4-agent` (page fetching + scrolling heuristics; see commits `d332fba`, `fa10ba9`). |
| `ds4_web.h` | (small) | Header for the above. |
| `linenoise.c` / `linenoise.h` | ~93k chars | Line-editor library (MIT, slightly extended for the agent's multiplexed editor). |
| `rax.c` / `rax.h` / `rax_malloc.h` | ~105k chars | Radix tree (from Redis) — used by `ds4-server` tool memory. |
| `ds4_iq2_tables_cuda.inc` | 6173 chars | Generated IQ2 dequant lookup tables included from `ds4_cuda.cu`. |
| `Makefile` | 199 | Build orchestration (Metal default on Darwin, CUDA / CPU paths on Linux). |
| `metal/*.metal` | 19 files, ~9.2k lines | Metal compute kernels: `flash_attn.metal`, `moe.metal`, `dsv4_hc.metal`, `dsv4_misc.metal`, `dsv4_kv.metal`, `dsv4_rope.metal`, `dense.metal`, `softmax.metal`, `norm.metal`, `glu.metal`, `argsort.metal`, etc. |
| `gguf-tools/deepseek4-quantize.c` | 1888 | The audited quantisation pipeline that produces the DS4 GGUFs. |
| `gguf-tools/quants.c` | 1109 | Dequant block kernels (Q2_K, Q4_K, Q8_0, Q8_K, IQ2_XXS) shared across tools. |
| `gguf-tools/imatrix/` | (dir) | Importance-matrix collection scripts and runners. |
| `gguf-tools/mixed/`, `gguf-tools/quality-testing/` | (dirs) | Quant mix authoring and per-quant quality probes. |
| `tests/` | (dir) | Unit tests and the CUDA long-context smoke harness (`tests/cuda_long_context_smoke.c`). |
| `speed-bench/` | (dir) | Long prompts used by `ds4-bench` (e.g. `promessi_sposi.txt`). |
| `dir-steering/` | (dir) | Reference directional-steering vectors. |
| `misc/` | (dir) | Misc supporting files. |
| `download_model.sh` | 4647 chars | Helper script to fetch the official model files. |
| `README.md` | 43056 chars | Project README — the most up-to-date prose reference. |
| `MODEL_CARD.md` / `AGENT.md` / `CONTRIBUTING.md` | (small) | Documentation. |
