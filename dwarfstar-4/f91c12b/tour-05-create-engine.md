# Tour Step 05: Finishing `ds4_engine_open` — GPU init, mmap registration, weight warm-up

> Code version locked to `ds4@f91c12b50a1448527c435c028bfc70d1b00f6c33` (2026). All `file:line` refs are repo-root-relative paths at this commit. Trace target: `./ds4 -m DS4.gguf -p "hello" -n 3`.

## 1. Current situation

After tour-04, the `ds4_engine` struct (`ds4.c:14707-14724`) has its `model`, `vocab`, `weights`, and `backend` (= `DS4_BACKEND_METAL` on Apple Silicon) fields populated. `config_validate_model` has accepted every hyperparameter (43 layers, `DS4_N_EMBD = 4096`, `DS4_N_VOCAB = 129280`, sliding-window = 128, etc.). The mmap region holding the 25 GiB of quantized tensor data is set up but cold — no page faults have read it yet.

Execution is parked at `ds4.c:17683`, the `#ifndef DS4_NO_GPU` block. The remaining work in `ds4_engine_open` (which spans `ds4.c:17636-17760`) is the GPU-side setup: initializing the Metal driver, registering the mmap range as a GPU-visible buffer, and pre-touching ("caching") the model tensors so first-prefill page faults do not happen on the inference critical path. By the end of this step `e->metal_ready` becomes `true` and the engine pointer is returned to the CLI.

Importantly, `ds4_engine_open` does **not** allocate the KV cache, the activation tensors, or the logits buffer here. Those are per-session (per-conversation) and live on `ds4_session`, not on `ds4_engine`. They are allocated in `ds4_session_create` (tour-07).

## 2. The problem

The Metal backend has three structural requirements that must be met before the first inference call:

> (a) The Metal driver must be initialized; CommandQueues, default Library, and global pipeline caches must exist. (b) The 25 GiB of mmap'd weight data must be registered with Metal as a "shared" buffer so GPU kernels can read it directly without an explicit CPU→GPU copy. (c) The OS page cache for the tensor data region should already contain the weight bytes so the first prefill does not stall on disk I/O for hundreds of megabytes.

Each of these is global, expensive, and must happen exactly once per model. Doing them lazily on the first inference call is tempting (faster startup) but creates a host of secondary problems described in section 4. A fourth, subtler problem: any per-session resource (KV caches, activation tensors) cannot be allocated until `ctx_size` is known. The naive design conflates "model-level setup" with "session-level allocation" and ends up doing both in the wrong place.

## 3. Naive approach

Lazy initialization. `ds4_engine_open` does nothing GPU-related — it just stores the model path. The first call to `ds4_session_create` or `ds4_session_sync` lazily initializes Metal, registers the mmap, and warms weights. This minimizes startup for users who do `./ds4 -m DS4.gguf --inspect` (just print model metadata, never run inference) and amortizes work to "when actually needed". Many ML inference frameworks (PyTorch's eager mode, TensorFlow's default session, llama.cpp's older versions) use some form of this pattern.

## 4. Why the naive approach breaks

Lazy GPU init looks attractive in the single-prompt CLI case (eliminates a second of startup for `--inspect` users), but breaks immediately under realistic conditions:

- **Allocation failure timing is unpredictable.** A `ds4-server` process that has accepted three concurrent HTTP requests may simultaneously enter "first inference" code paths. The first one triggers Metal init; the second and third either crash on a half-initialized driver or race on internal Metal state. The exposed failure mode is "two of three requests fail with `Metal device not ready`", which is a heisenbug — only reproducible under sufficient load.
- **`ds4_gpu_set_model_map_range` is global.** Metal's shared-buffer registration (`ds4.c:17711-17714`) is a process-wide operation: it tells the driver "this 25 GiB span of process address space is GPU-visible". Calling it twice on the same range returns a driver error. The only safe place to call it is once, before any session exists.
- **First-token latency becomes erratic.** With lazy weight warm-up, the first 1-3 tokens of the first prefill incur page faults for hundreds of MB of weights. Users see "the first response takes 8 seconds, the second takes 200 ms"; nobody knows which result to trust for benchmarking. Eager warm-up moves the cost to a predictable, observable startup phase.
- **`--inspect` and `--dump-tokens` paths legitimately should not pay GPU cost** — but they are detected and short-circuited *before* `ds4_engine_open` is called (`ds4_cli.c:1573-1583`, `1585-1596`). The lazy-init argument that some commands never need GPU is true but is solved by the dispatcher, not by deferred init inside the engine.
- **VM budget rejection is silent and late.** Apple's Metal on macOS enforces a per-process accelerator VM budget (typically a few hundred GiB). If the model + per-session graphs exceed the budget, `ds4_gpu_set_model_map_range` returns false. Catching this at engine open (`ds4.c:17715-17723`) is a clean failure with a useful error message. Catching it inside `ds4_session_sync` would terminate inference mid-stream.

The deeper issue: GPU resources have process-level lifecycle (one driver, one Library, one mmap registration), but inference work has session-level lifecycle (one KV cache per conversation). Conflating the two — by lazily initializing process state from session code — confuses the lifetimes and breaks concurrency.

## 5. ds4's approach

ds4's approach is to **front-load every process-level GPU initialization step into a strict serial sequence inside `ds4_engine_open`, returning a non-zero error code on any failure with the engine cleaned up, and only flip `e->metal_ready = true` after every step succeeds**. The session-level work — KV caches, activation tensors, logits — is explicitly excluded from the engine and deferred to `ds4_session_create`.

The sequence inside the `#ifndef DS4_NO_GPU` block (`ds4.c:17683-17747`):

**Step 1: backend platform sanity** (`ds4.c:17684-17699`). If the build is linked against Metal but `--backend cuda` was requested (or vice versa), fail immediately with a precise message. This is a build-time vs runtime mismatch and there is no useful recovery. The check uses `__APPLE__` as a proxy for "this binary is Metal-linked"; cross-builds (Apple silicon binary running on Linux through Rosetta-style emulation) are not supported.

**Step 2: `ds4_gpu_init`** (`ds4.c:17701`). Creates the Metal device, command queue, and default Library. Returns non-zero on failure (no GPU available, Library load failed, etc.). The result is stored in `e->metal_ready` provisionally; on failure the engine is closed and `ds4_engine_open` returns 1.

The Library is the compiled `.metallib` shipped inside the ds4 binary; it contains every shader (FlashAttention variants, FFN GEMM, RMSNorm, RoPE, sampling) that any kernel might dispatch. Loading the Library is roughly 200-400 ms on a cold start (the linker must JIT-compile pipeline state objects for the device's specific GPU family). This is the largest single chunk of GPU init time and is unavoidable.

**Step 3: backend quality knob** (`ds4.c:17709`). `ds4_gpu_set_quality(e->quality)` toggles between "exact" and "fast-approx" kernel variants (e.g., F16 vs F32 accumulators for the attention sums). Set early because subsequent kernel compilations consult this.

**Step 4: register the mmap as a GPU-shared buffer** (`ds4.c:17710-17723`). `ds4_gpu_set_model_fd` records the file descriptor for any future memory-pressure handling. `ds4_gpu_set_model_map_range(map, size, tensor_data_pos, tensor_bytes)` tells Metal the byte range `[tensor_data_pos, tensor_data_pos + tensor_bytes)` of the mmap is shared with the GPU. Inference kernels then read weights directly from this region — **no CPU→GPU copy of the 25 GiB**. Failure here is most often "accelerator VM budget exhausted" and is reported as such (`ds4.c:17716-17719`). On Apple Silicon's unified memory, "shared" really means shared physical pages; on a discrete GPU it would be a pinned-page registration.

Note the explicit narrowing to the tensor data region only: the metadata KV section (which tour-04 walked for the tokenizer) is excluded from the GPU mapping. Metal only sees the weight bytes. This is a small win for the driver's VM budget tracking and a small loss of generality (no GPU access to KV metadata), and the trade-off is correct because no kernel ever needs to read metadata at inference time.

**Step 5: MTP support model mapping if present** (`ds4.c:17724-17737`). Identical to step 4 but for the speculative-decoding side model loaded via `--mtp`. Our trace does not use MTP (`opt->mtp_path == NULL` per default CLI options), so this is skipped. When enabled, MTP roughly doubles the per-token mmap registration cost and adds the MTP draft tokens to the per-session graph state — but adds nothing to per-session memory beyond a `mtp_logits` buffer.

**Step 6: weight warm-up** (`ds4.c:17738-17744`). `accelerator_cache_model_tensors(e->backend, &e->model)` walks every tensor referenced by `e->weights` and touches one byte from each page of every tensor's data. On macOS this triggers the kernel to populate the page cache for those ranges; subsequent prefill kernels then read from already-resident pages. The cost is a few seconds of disk I/O up front instead of stuttering page faults during the first prefill. For MTP-enabled runs this step is replaced by the MTP-aware path; for our trace it runs and resident memory rises by ~25 GiB.

The warm-up has two implementations of `accelerator_cache_model_tensors` (`ds4.c:1447` for Metal builds, `ds4.c:1484` for CUDA builds), selected by `#ifdef` at compile time. Both walk the same tensor list but use different driver-specific touch operations. Failure here (e.g., I/O error reading from the GGUF file) does abort startup: `ds4.c:17738-17744` calls `ds4_engine_close` and returns 1 with a `failed to prepare startup model cache` error. The reasoning is the same as for `ds4_gpu_set_model_map_range` failure — better to fail at open than to stutter through every first prefill.

**Step 7: success** (`ds4.c:17745-17758`). Print `ds4: metal backend initialized for graph diagnostics`. Set `*out = e`. Return 0.

The error-handling pattern across steps 1-6 is uniform: each step either succeeds or calls `ds4_engine_close(e)`, sets `*out = NULL`, and returns 1. The close path (`ds4.c:17780-17794`) walks every initialized resource in reverse order — `weights_free`, `vocab_free`, GPU cleanup, model close, releasing the instance lock — so partial init produces no leaks. This is one of the few places in the codebase that uses the "destructor handles everything" pattern; most C code uses explicit goto-cleanup chains. The reason: `ds4_engine_close` is also the normal-shutdown path, so it must handle all subsets of "what got initialized" anyway.

The engine struct after success has `metal_ready = true`, all pointer fields populated, and **no per-session state**. A second concurrent thread calling `ds4_session_create(&s2, e, ctx_size)` works correctly because `e` is now read-only for the rest of the process's lifetime.

Note `ds4_acquire_instance_lock()` at `ds4.c:17661`: a per-process file lock that prevents two ds4 binaries from claiming the same GPU device simultaneously. This is enforced at engine open and released in `ds4_engine_close` (`ds4.c:17790`). Two instances on the same machine would both call `ds4_gpu_set_model_map_range` and one would fail, but the file lock makes the failure deterministic and gives a clearer error than the Metal driver's "duplicate mapping" complaint.

What this step explicitly does NOT do: it does not allocate the per-layer raw SWA cache, the compressed-KV cache, the indexer cache, the activation scratch tensors, the HC state buffers, or the logits buffer. All of those are functions of `ctx_size`, which is not known until `ds4_session_create(s, e, ctx_size)` is called (the CLI default is `cfg.gen.ctx_size = 32768` at `ds4_cli.c:1421`). The allocator `metal_graph_alloc_raw_cap` (`ds4.c:8806`) is invoked by `ds4_session_create`, not here.

The session-vs-engine split is observable in the struct layouts: `ds4_engine` (`ds4.c:14707-14724`) has 16 fields, all of them immutable post-open. `ds4_session` (`ds4.c:16058-16079`) has 18 fields, all of them mutable: `graph` (the Metal allocator output), `cpu_cache` (CPU path), `checkpoint` (the token-prefix snapshot), `logits` (the latest output), `mtp_logits`, MTP draft state, two progress callbacks, plus `prefill_cap`, `ctx_size`, and two booleans. The cleanest way to read the codebase is: any field on `ds4_engine` is "model knowledge"; any field on `ds4_session` is "live inference state".

The context-window math is also session-side: `metal_graph_raw_cap_for_context` (`ds4.c:14263`) computes the raw SWA cache rows as `align_up(DS4_N_SWA + prefill_cap, 256)` clamped to 8192, and `metal_graph_prefill_cap_for_prompt` (`ds4.c:14299`) decides the prefill ubatch size (whole-batch for prompts ≤4096, 4096-token chunks otherwise). Both are pure functions that take `ctx_size` and `prompt_len` and produce capacities; neither depends on engine state. The engine's only job is to make the inputs to that math (the weights and the GPU) available.

For our `-p "hello"` trace, `cfg.gen.ctx_size = 32768`. Tour-07's `ds4_session_create` will compute `prefill_cap = ds4_default_prefill_cap_for_prompt(32768) = 4096` (the function caps at 4096 for any input ≥ 4096, see `ds4.c:6217-6219`), then `raw_cap = align_up(128 + 4096, 256) = 4352`. The resulting per-layer raw SWA buffer is 4352 × `DS4_N_HEAD_DIM` × sizeof(float). None of this is allocated in `ds4_engine_open`; the numbers are shown here only to make concrete how much engine-vs-session work is left to do after this step returns.

A subtle but important property: from outside the engine, every `ds4_engine *` either points to a fully initialized engine or has not been observed (it was the local variable being passed to `ds4_engine_open`). Code that reads `e->vocab.n_vocab` or `e->weights.layer[0].attn_q_a` can do so without locks or null checks for those substructures; the engine struct is initialized once and frozen. This is what lets `ds4-server` use multiple worker threads with a single shared `engine` pointer without any synchronization on engine state.

## 6. Code locations

In reading order:

- `ds4.h:62-75` — `ds4_engine_options`: `model_path`, `backend`, `n_threads`, `warm_weights`, `quality`, MTP and steering knobs.
- `ds4.h:96` — `ds4_engine_open` public declaration.
- `ds4.c:14707-14724` — `struct ds4_engine`: holds only immutable model-level state; no KV cache or activations.
- `ds4.c:17636-17760` — `ds4_engine_open` implementation, the function this step traces.
- `ds4.c:17664-17668` — pre-GPU sequence: `model_open` → `vocab_load` → `config_validate_model` → `weights_bind`.
- `ds4.c:17683-17699` — backend platform compatibility check (Metal-built binary refuses `--backend cuda`).
- `ds4.c:17700-17708` — `ds4_gpu_init` call; on failure `ds4_engine_close` + return 1.
- `ds4.c:17709` — `ds4_gpu_set_quality(e->quality)` toggles kernel variant.
- `ds4.c:17710-17723` — `ds4_gpu_set_model_fd` + `ds4_gpu_set_model_map_range`; the mmap-to-GPU bridge.
- `ds4.c:17724-17737` — MTP model mapping (skipped in this trace).
- `ds4.c:17738-17744` — `accelerator_cache_model_tensors`; the eager weight warm-up.
- `ds4.c:17745-17747` — success message.
- `ds4.c:17758-17759` — `*out = e; return 0;`.
- `ds4_cli.c:1590` — the CLI call site: `ds4_engine_open(&engine, &cfg.engine)`.
- `ds4.c:8806-9128` — `metal_graph_alloc_raw_cap`, the per-session allocator (called from `ds4_session_create`, not here, but worth knowing where it lives).

## 7. Branches and extensions

We took the happy path on Apple Silicon with no MTP, no directional steering, and no MTP draft tokens. The other paths:

- **CPU backend.** `--backend cpu` skips `ds4_gpu_init` and friends entirely; the CPU path uses `kv_cache_init` / `cpu_decode_scratch_init` inside `ds4_session_create` (`ds4.c:17803-17804`) instead of the Metal allocator. Same overall lifecycle, different allocations. The CPU path is mostly used for debugging and for the reference forward used by graph-diagnostic kernels; production inference on Apple Silicon always uses Metal. See [Chapter 10: Metal and CUDA backends](./10-metal-backend.md).
- **MTP (speculative decoding) startup.** With `--mtp DS4-mtp.gguf`, `ds4_engine_open` opens a second GGUF, calls `mtp_weights_bind`, sets `e->mtp_ready = true`, and routes step 5 instead of step 6. The MTP draft tokens (`opt->mtp_draft_tokens`, default 1) and accept margin (`opt->mtp_margin`, default 3.0) are stored on the engine. See [Chapter 12: Speculative decoding and MTP](./12-speculative-mtp.md).
- **Directional steering.** `--dir-steering-file` + non-zero attn/ffn scales load per-layer steering vectors from a binary file. CPU steering uses `cpu_load_directional_steering` (`ds4.c:14754`) inside `ds4_engine_open`; Metal steering loads in `ds4_session_create` because the steering tensors need GPU buffers. The mechanism is separate from the engine/session split otherwise.
- **`--warm-weights` vs `accelerator_cache_model_tensors`.** Two distinct warm-up paths exist: `model_warm_weights` (`ds4.c:17665`) touches OS pages from the CPU side before `vocab_load` even runs; `accelerator_cache_model_tensors` (`ds4.c:17738`) re-touches them after GPU mapping. The former is opt-in via `cfg.engine.warm_weights`; the latter is automatic for any graph backend. Calling both is idempotent — the kernel does not page in the same page twice.
- **`ds4_context_memory_estimate`.** The CLI calls this (`log_context_memory` at `ds4_cli.c:1586`) before `ds4_engine_open` to print expected VRAM use. The function computes capacities using the same `metal_graph_raw_cap_for_context` math without allocating anything — a dry run of the session-level allocator. See [Chapter 6: Engine and Session](./06-engine-session.md) for the memory-estimate API.
- **Quantization and kernel variants.** `e->quality` plus the per-tensor quant types (Q4_K, Q8_0, F16, etc.) determine which Metal kernels are compiled and used. See [Chapter 4: Quantization](./04-quantization.md) and [Chapter 10 §kernel selection](./10-metal-backend.md).
- **The instance lock.** `ds4_acquire_instance_lock` / `ds4_release_instance_lock` (`ds4.c:17661` and `17790`) enforce single-instance ownership of the GPU on the local machine. The lock file lives under the user's runtime directory; a second `ds4` invocation while the first is running blocks at engine open until the first releases. See [Chapter 1: Architecture Overview](./01-architecture-overview.md) for the rationale (preventing duplicate `ds4_gpu_set_model_map_range` and avoiding accelerator VM oversubscription).

## 8. What you should now have in your head

1. **The engine is "process-level immutable", the session is "request-level mutable".** `ds4_engine` holds model + tokenizer + weight pointers + `metal_ready` flag — once `ds4_engine_open` returns 0, the struct is read-only for the rest of the process's life. Multiple concurrent `ds4_session` objects can safely share a single engine pointer.
2. **GPU initialization, mmap-to-Metal registration, and weight warm-up all happen here, eagerly, in strict order.** Any failure short-circuits with a clean error, freeing the engine via `ds4_engine_close`. There is no "half-initialized" engine state observable from outside `ds4_engine_open`.
3. **Weights are zero-copy from disk to GPU on Apple Silicon.** `ds4_gpu_set_model_map_range` registers the mmap span as shared with Metal; the GPU reads weight tensor data directly from the OS page cache. The 25 GiB are never duplicated to a separate GPU buffer.
4. **KV cache / activation tensors are NOT allocated here.** Those are functions of `ctx_size`, which is a session parameter. The engine has no notion of context window. `metal_graph_alloc_raw_cap` runs from `ds4_session_create` (tour-07).
5. **`accelerator_cache_model_tensors` is the difference between predictable first-token latency and a 5-second cold start.** It pre-faults the weight pages so prefill kernels do not block on disk I/O. The cost is a one-time spike of resident memory at startup, which is exactly when users expect it.
6. **At step end, `*out = e` and `return 0`.** The CLI now has a usable engine. Control returns to `main` at `ds4_cli.c:1590`, which then dispatches to `run_generation` (tour-06's entry point) for the `-p "hello"` non-empty-prompt path.
7. **Error handling is symmetric.** Every failure path calls `ds4_engine_close` and returns 1; there is no "partial engine" state. The same destructor handles normal shutdown at process exit, so it must handle every subset of "what was initialized" — and does.
8. **Lock and unlock are paired across the engine lifetime.** `ds4_acquire_instance_lock` runs at the very top of `ds4_engine_open`; `ds4_release_instance_lock` runs in `ds4_engine_close`. A second ds4 process on the same machine blocks until the first one finishes — making `ds4_gpu_set_model_map_range` collisions structurally impossible.
