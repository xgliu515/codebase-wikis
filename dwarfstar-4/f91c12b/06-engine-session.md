# Chapter 06: Engine, Session & session_sync

> Code version locked to `antirez/ds4@f91c12b` (2026-05-22). All `file:line` refs are repo-root-relative paths at this commit.

## 0. The problem this chapter solves

LLM serving has two fundamentally different "things" that need names. There is the *model*: the GGUF file mapped into memory, the vocabulary, the tokenizer tables, the per-layer weight pointers, the backend (Metal/CUDA/CPU) initialization. The model is heavy to load and small after that — measured in tens of GiB of memory map and tens of milliseconds of wall time once the OS has the pages cached.

Then there is the *inference timeline*: one specific conversation in flight, its KV cache, its current logits, its checkpoint of "tokens I have already evaluated." An inference timeline is cheap to create, mutates with every decoded token, and there can be many of them open against one model.

ds4 separates these two ideas into `ds4_engine` (the model) and `ds4_session` (the timeline). The public header `ds4.h:9-15` spells out the contract:

```
The CLI and server should treat ds4_engine as the loaded model and
ds4_session as one mutable inference timeline.  A session owns the live KV
cache and logits; callers provide full token prefixes and let
ds4_session_sync() reuse, extend, or rebuild the graph state.  Keep this
header narrow so HTTP/CLI code does not depend on tensor internals.
```

This chapter follows that contract end-to-end. We walk the engine open/close lifecycle, the session create/destroy lifecycle, and then the single function that is the heart of the engine: `ds4_session_sync`. We then look at sampling, snapshotting, rewriting, the CPU reference path, and the single-instance lock that protects against accidentally launching two ds4 processes.

## 1. ds4_engine vs ds4_session

### 1.1 Two structs, two lifetimes

`ds4_engine` is the read-only model layer (`ds4.c:14707-14724`):

```c
/* ds4.c:14707 */
struct ds4_engine {
    ds4_model model;                /* GGUF mmap + tensor metadata */
    ds4_model mtp_model;            /* MTP draft model, optional */
    ds4_vocab vocab;                /* BPE tables and special tokens */
    ds4_weights weights;            /* pointers into the mmap */
    ds4_mtp_weights mtp_weights;
    ds4_backend backend;
    int   mtp_draft_tokens;
    float mtp_margin;
    char  *directional_steering_file;
    float *directional_steering_dirs;
    float directional_steering_attn_scale;
    float directional_steering_ffn_scale;
    int   power_percent;
    bool  quality;
    bool  metal_ready;
    bool  mtp_ready;
};
```

After `ds4_engine_open` returns, nothing in this struct mutates apart from runtime knobs like `power_percent` (`ds4.c:17774`). All concurrent sessions on the same engine read the same weight pointers.

`ds4_session` is the mutable timeline (`ds4.c:16058-16079`):

```c
/* ds4.c:16058 */
struct ds4_session {
    ds4_engine *engine;
#ifndef DS4_NO_GPU
    ds4_gpu_graph graph;            /* Metal/CUDA graph with live KV */
#endif
    ds4_kv_cache cpu_cache;         /* CPU path KV */
    ds4_cpu_decode_scratch cpu_scratch;
    token_vec checkpoint;           /* the source of truth */
    float *logits;                  /* last-step logits, DS4_N_VOCAB floats */
    float *mtp_logits;              /* MTP draft logits if MTP is on */
    int   mtp_draft_token;
    uint64_t mtp_probe_total;
    uint64_t mtp_probe_hit;
    ds4_session_progress_fn progress;
    void *progress_ud;
    ds4_session_progress_fn display_progress;
    void *display_progress_ud;
    uint32_t prefill_cap;
    int  ctx_size;
    bool checkpoint_valid;
    bool mtp_draft_valid;
};
```

Two things move every sync/eval call: `checkpoint` (the integer prefix the live state corresponds to) and `logits` (the most recent floating-point output). The GPU `graph` carries the live KV cache for the GPU path; the CPU path uses `cpu_cache` plus a preallocated `cpu_scratch`.

The architectural payoff of this split is straightforward:

- **Multiple concurrent sessions** can share one engine. Each session has its own KV cache; weight reads are immutable.
- **No state at the HTTP/CLI layer.** Both clients resend or reconstruct the full transcript each request. `ds4_session_sync` is the only thing that decides what's "new" vs. "already done."
- **Disk snapshots are tightly scoped.** Save/load only touches session state — token vector, logits, KV rows. Weights stay in the GGUF on disk.

### 1.2 Visual

```
              ds4_engine (read-only after open)
              ┌────────────────────────────────────┐
              │ ds4_model     GGUF mmap + metadata │
              │ ds4_vocab     tokenizer tables     │
              │ ds4_weights   pointers into mmap   │
              │ ds4_mtp_*     draft model          │
              │ backend, quality, steering         │
              └────────────────────────────────────┘
                  ▲              ▲              ▲
                  │ shared       │ shared       │ shared
                  │              │              │
        ┌─────────┴────┐ ┌───────┴──────┐ ┌─────┴────────┐
        │ ds4_session  │ │ ds4_session  │ │ ds4_session  │
        │   (chat 1)   │ │   (chat 2)   │ │   (probe)    │
        ├──────────────┤ ├──────────────┤ ├──────────────┤
        │ KV cache     │ │ KV cache     │ │ KV cache     │
        │ checkpoint   │ │ checkpoint   │ │ checkpoint   │
        │ logits       │ │ logits       │ │ logits       │
        └──────────────┘ └──────────────┘ └──────────────┘
```

## 2. ds4_engine_open

### 2.1 Signature and options

```c
/* ds4.h:96 */
int ds4_engine_open(ds4_engine **out, const ds4_engine_options *opt);
```

`ds4_engine_options` (`ds4.h:62-75`):

| Field | Meaning |
|------|---------|
| `model_path` | GGUF path to the main model |
| `mtp_path`   | GGUF path to the MTP draft model (optional) |
| `backend`    | `DS4_BACKEND_METAL` / `DS4_BACKEND_CUDA` / `DS4_BACKEND_CPU` |
| `n_threads`  | CPU thread count; ≤0 means auto-detect |
| `mtp_draft_tokens` | MTP draft length 1–16 |
| `mtp_margin` | MTP acceptance margin (default 3.0) |
| `directional_steering_file` | F32 binary, `[DS4_N_LAYER × DS4_N_EMBD]` |
| `directional_steering_attn`/`ffn` | per-domain scales |
| `power_percent` | 1–100, controls GPU clock/power throttle |
| `warm_weights` | when true, sequentially touch the weight pages to fault them in |
| `quality` | enables the high-quality (slower) graph variant |

### 2.2 Load sequence

The implementation is at `ds4.c:17636-17760`. The sequence:

```
 1. validate options                                       ds4.c:17647-17659
 2. ds4_acquire_instance_lock()    ← single-process lock   ds4.c:17661
 3. model_open()                   ← mmap GGUF             ds4.c:17664
 4. model_warm_weights()           ← optional page touch   ds4.c:17665
 5. vocab_load()                   ← BPE tables            ds4.c:17666
 6. config_validate_model()        ← shape verification    ds4.c:17667
 7. weights_bind()                 ← bind tensor pointers  ds4.c:17668
 8. cpu_load_directional_steering()← optional steering     ds4.c:17669
 9. mtp model: model_open + bind   ← if mtp_path supplied  ds4.c:17674
10. backend mismatch checks        ← compile-time pinning  ds4.c:17684-17699
11. ds4_gpu_init() (Metal/CUDA)                            ds4.c:17701
12. ds4_gpu_set_model_map_range()  ← register weight VM    ds4.c:17711
13. accelerator_cache_model_tensors() (no-MTP case only)   ds4.c:17738
```

Steps 11–13 only run for graph backends (`ds4_backend_uses_graph`, `ds4.c:74-76`). The CPU backend skips all GPU initialization but still acquires the instance lock and opens the model.

The "backend mismatch checks" at step 10 reject mismatched-build/runtime requests: a Metal-linked binary refuses CUDA requests and vice versa.

### 2.3 ds4_engine_close

`ds4_engine_close` (`ds4.c:17780-17794`) tears down in reverse:

```c
/* ds4.c:17780 */
void ds4_engine_close(ds4_engine *e) {
    if (!e) return;
    weights_free(&e->weights);
    vocab_free(&e->vocab);
    ds4_threads_shutdown();
    if (e->mtp_ready) model_close(&e->mtp_model);
    model_close(&e->model);
#ifndef DS4_NO_GPU
    ds4_gpu_cleanup();
#endif
    ds4_release_instance_lock();
    free(e->directional_steering_dirs);
    free(e->directional_steering_file);
    free(e);
}
```

The order matters in a subtle way: `weights_free` and `vocab_free` only touch in-process data; `model_close` unmaps the GGUF; `ds4_gpu_cleanup` releases device memory. The instance lock is released last (`ds4_release_instance_lock`, `ds4.c:16005-16010`) so another process can take over only after the current process has finished tearing down GPU resources.

## 3. The single-instance lock

`ds4_acquire_instance_lock` (`ds4.c:16012-16056`):

```c
/* ds4.c:16012 */
/* Refuse to start a second ds4 process.  The model can map tens of GiB, so a
 * stale accidental second run is more dangerous than a normal CLI error. */
static void ds4_acquire_instance_lock(void) {
    const char *path = getenv("DS4_LOCK_FILE");
    if (!path || !path[0]) path = "/tmp/ds4.lock";

    const int fd = open(path, O_RDWR | O_CREAT, 0600);
    if (fd < 0) ds4_die_open(...);
    (void)fcntl(fd, F_SETFD, FD_CLOEXEC);

    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        if (errno == EWOULDBLOCK) {
            char buf[64];
            const ssize_t n = pread(fd, buf, sizeof(buf) - 1, 0);
            long owner = -1;
            if (n > 0) { buf[n] = '\0'; owner = strtol(buf, &end, 10); }
            if (owner > 0) {
                fprintf(stderr, "ds4: another ds4 process is already running"
                                " (pid %ld); refusing to start\n", owner);
            } else {
                fprintf(stderr, "ds4: another ds4 process is already running;"
                                " refusing to start\n");
            }
            close(fd);
            exit(2);
        }
        /* ... other flock errors */
    }

    if (ftruncate(fd, 0) != 0) { /* ... */ }
    dprintf(fd, "%ld\n", (long)getpid());
    g_ds4_lock_fd = fd;
    atexit(ds4_release_instance_lock);
}
```

Three properties:

- The lock file is `/tmp/ds4.lock` by default, overridable via `DS4_LOCK_FILE` (`ds4.c:16015`). Containerized deployments that run multiple ds4 processes on separate GPUs set different paths.
- `flock(LOCK_EX | LOCK_NB)` is non-blocking. Failing fast with a clear message ("another ds4 process is already running (pid 12345); refusing to start") is much better than silently waiting forever or competing for GPU memory.
- The PID is written to the lock file so the error message can name the offender. `FD_CLOEXEC` ensures that if ds4 ever `exec`s a child process, the child does not inherit the lock fd.
- `atexit(ds4_release_instance_lock)` ensures the lock is released on normal exit. `ds4_engine_close` also calls `ds4_release_instance_lock` explicitly, which is idempotent (`g_ds4_lock_fd >= 0` check at `ds4.c:16006`).

The "why" is at `ds4.c:16012-16013`: "*The model can map tens of GiB, so a stale accidental second run is more dangerous than a normal CLI error.*" If two processes both mmap the same 80 GiB GGUF, the OS may keep both copies hot in page cache, drive swap, or trigger OOM. Worse, on Metal the second `ds4_gpu_init` may silently corrupt the first process's GPU state. Refusing to start is the only safe behavior.

## 4. ds4_session lifecycle

### 4.1 Create

```c
/* ds4.h:155 */
int ds4_session_create(ds4_session **out, ds4_engine *e, int ctx_size);
```

Implementation at `ds4.c:17796-17843`.

CPU path (`ds4.c:17798-17808`):

```c
/* ds4.c:17798 */
if (e->backend == DS4_BACKEND_CPU) {
    ds4_session *s = xcalloc(1, sizeof(*s));
    s->engine = e;
    s->ctx_size = ctx_size;
    s->prefill_cap = ds4_default_prefill_cap_for_prompt(ctx_size);
    kv_cache_init(&s->cpu_cache, (uint32_t)ctx_size, 0);
    cpu_decode_scratch_init(&s->cpu_scratch, (uint32_t)ctx_size);
    s->logits = xmalloc((size_t)DS4_N_VOCAB * sizeof(s->logits[0]));
    *out = s;
    return 0;
}
```

GPU path (`ds4.c:17812-17841`):

```c
/* ds4.c:17812 */
if (!ds4_backend_uses_graph(e->backend) || !e->metal_ready) return 1;

ds4_session *s = xcalloc(1, sizeof(*s));
s->engine = e;
s->ctx_size = ctx_size;
s->prefill_cap = metal_graph_prefill_cap_for_prompt(ctx_size);
const uint32_t raw_cap = metal_graph_raw_cap_for_context(ctx_size, s->prefill_cap);
if (!metal_graph_alloc_raw_cap(&s->graph, &e->weights, &e->weights.layer[0],
                               raw_cap, (uint32_t)ctx_size, s->prefill_cap, e->mtp_ready))
{
    free(s);
    return 1;
}
s->graph.quality = e->quality;
s->graph.power_percent = (uint32_t)e->power_percent;
if (!metal_graph_load_directional_steering(&s->graph, ...)) {
    metal_graph_free(&s->graph);
    free(s);
    return 1;
}
s->logits = xmalloc((size_t)DS4_N_VOCAB * sizeof(s->logits[0]));
if (e->mtp_ready) {
    s->mtp_logits = xmalloc((size_t)DS4_N_VOCAB * sizeof(s->mtp_logits[0]));
    s->mtp_draft_token = -1;
}
```

`metal_graph_alloc_raw_cap` is the GPU-side equivalent of `kv_cache_init`: it allocates the raw SWA window, the compressed KV cache, the indexer cache, and every scratch tensor needed by Metal/CUDA shaders. `prefill_cap` determines the maximum ubatch size and feeds the buffer dimensioning.

### 4.2 prefill_cap

```c
/* ds4.c:6205 */
static uint32_t ds4_default_prefill_cap_for_prompt(int prompt_len) {
    if (prompt_len <= 0) return 1;
    uint32_t cap = (uint32_t)prompt_len;

    const char *env = getenv("DS4_METAL_PREFILL_CHUNK");
    if (env && env[0]) {
        char *endp = NULL;
        const long v = strtol(env, &endp, 10);
        if (endp != env) {
            if (v <= 0) return cap;
            cap = (uint32_t)v;
        }
    } else if (prompt_len > 4096) {
        cap = 4096u;
    }

    if (cap == 0) cap = 1;
    if (cap > (uint32_t)prompt_len) cap = (uint32_t)prompt_len;
    return cap;
}
```

The rule is "whole-batch when small, 4096-token chunks when large, env override always wins." For chat-typical prompts (a few hundred tokens up to a few thousand), a single prefill ubatch is fastest. For multi-thousand-token prompts, the GPU buffers needed to hold all intermediates simultaneously become impractical, so the prefill is chunked. The 4096 boundary was chosen by measurement on M3-class Apple Silicon; the env var `DS4_METAL_PREFILL_CHUNK` allows tuning for different hardware.

### 4.3 Free

`ds4_session_free` (`ds4.c:17845-17860`):

```c
/* ds4.c:17845 */
void ds4_session_free(ds4_session *s) {
    if (!s) return;
    if (ds4_session_is_cpu(s)) {
        kv_cache_free(&s->cpu_cache);
        cpu_decode_scratch_free(&s->cpu_scratch);
    }
#ifndef DS4_NO_GPU
    else {
        metal_graph_free(&s->graph);
    }
#endif
    token_vec_free(&s->checkpoint);
    free(s->logits);
    free(s->mtp_logits);
    free(s);
}
```

Each path releases the backend-specific state then the shared session fields.

### 4.4 Progress callbacks

The two progress hooks (`ds4.h:159-162`):

```c
/* Backend-grade progress; safe to use as a KV checkpoint advance signal. */
void ds4_session_set_progress(ds4_session *s, ds4_session_progress_fn fn, void *ud);

/* UI-only progress; may report fine-grained inside-a-chunk progress; callers
 * must not treat it as a durable KV checkpoint boundary. */
void ds4_session_set_display_progress(ds4_session *s, ds4_session_progress_fn fn, void *ud);
```

Both share the same callback signature (`ds4.h:60`):

```c
typedef void (*ds4_session_progress_fn)(void *ud, const char *event,
                                        int current, int total);
```

The only event currently emitted is `"prefill_chunk"`. The backend progress callback is invoked at chunk boundaries that are durable — i.e. when the engine has actually advanced the checkpoint by `current` tokens. The display progress callback may fire more often inside a chunk for UI smoothness, but those advances are not safe to treat as checkpoint boundaries.

Inside `ds4_session_sync`, the wrapper `ds4_session_note_prefill_progress` (`ds4.c:17896-17906`) attaches each progress firing to a temporary advance of the session checkpoint, so the chunked prefill can periodically expose a consistent intermediate state to callers that watch the checkpoint length.

## 5. ds4_session_sync — the heart

### 5.1 Signature

```c
/* ds4.h:175 */
int ds4_session_sync(ds4_session *s, const ds4_tokens *prompt, char *err, size_t errlen);
```

The contract from `ds4.c:17909-17923`:

```
Bring the live backend state to exactly the supplied token prefix.

ds4-server and the REPL are stateless at the text/API layer but stateful here:
they resend or rebuild the full transcript, and this function decides whether
the live checkpoint is a prefix.  A matching prefix is extended in one of two
ways:

  - long suffix: batched layer-major prefill, aligned to absolute chunk
    boundaries so compressor/indexer rows finalize in the same order as a
    cold prompt;
  - short suffix: ordinary one-token decode, which is faster below the
    measured crossover and preserves exact autoregressive semantics.

A non-matching prompt discards the checkpoint and prefills from token zero.
```

### 5.2 The decision tree

```
ds4_session_sync(s, prompt)
    │
    ├─ prompt.len <= 0 OR prompt.len >= ctx_size  →  error
    │
    ├─ CPU backend?
    │     │
    │     ├─ checkpoint_valid AND prompt starts with checkpoint?
    │     │     ├─ yes: loop decode for the suffix, one token at a time
    │     │     └─ no:  reset cache, layer-major prefill the full prompt
    │     └─ return 0
    │
    └─ GPU backend
          │
          ├─ checkpoint_valid AND prompt starts with checkpoint?
          │     │
          │     ├─ suffix == 0:           return 0   (already at target)
          │     │
          │     ├─ suffix >= resume_min (default 4):
          │     │     metal_graph_prefill_chunked_range
          │     │     (chunked prefill, absolute-position aligned)
          │     │
          │     └─ suffix < resume_min:
          │           per-token metal_graph_eval_token_raw_swa
          │
          └─ checkpoint mismatch:
                metal_graph_reset_prefill_state
                metal_graph_prefill_chunked (if len > prefill_cap)
                OR metal_graph_prefill_raw_swa (otherwise)
```

### 5.3 CPU path

`ds4.c:17929-17968`:

```c
/* ds4.c:17929 */
if (ds4_session_is_cpu(s)) {
    ds4_engine *e = s->engine;
    if (s->checkpoint_valid &&
        prompt->len >= s->checkpoint.len &&
        ds4_tokens_starts_with(prompt, &s->checkpoint))
    {
        s->mtp_draft_valid = false;
        for (int i = s->checkpoint.len; i < prompt->len; i++) {
            forward_token_raw_swa_cpu_decode_scratch(s->logits,
                                                     &e->model,
                                                     &e->weights,
                                                     &s->cpu_cache,
                                                     prompt->v[i],
                                                     (uint32_t)s->checkpoint.len,
                                                     e->directional_steering_dirs,
                                                     e->directional_steering_attn_scale,
                                                     e->directional_steering_ffn_scale,
                                                     &s->cpu_scratch);
            token_vec_push(&s->checkpoint, prompt->v[i]);
            if (s->progress) s->progress(s->progress_ud, "prefill_chunk", i + 1, prompt->len);
        }
        s->checkpoint_valid = true;
        return 0;
    }

    session_cpu_reset_cache(s);
    prefill_layer_major_cpu(s->logits, &e->model, &e->weights, &s->cpu_cache, prompt, ...);
    ds4_tokens_copy(&s->checkpoint, prompt);
    s->checkpoint_valid = true;
    s->mtp_draft_valid = false;
    if (s->progress) s->progress(s->progress_ud, "prefill_chunk", prompt->len, prompt->len);
    return 0;
}
```

The CPU path has no chunking heuristic — it always uses single-token decode for any suffix and layer-major prefill for any full prompt. That keeps the CPU code simple at the cost of speed.

### 5.4 GPU path: matching checkpoint, long suffix

`ds4.c:17978-18015`:

```c
/* ds4.c:17978 */
if (s->checkpoint_valid &&
    prompt->len >= s->checkpoint.len &&
    ds4_tokens_starts_with(prompt, &s->checkpoint))
{
    s->mtp_draft_valid = false;
    const int suffix = prompt->len - s->checkpoint.len;
    const uint32_t resume_min = metal_graph_resume_prefill_min_tokens();
    if (suffix > 0 && (uint32_t)suffix >= resume_min) {
        ds4_sync_progress progress = {
            .session = s,
            .prompt = prompt,
            .user = s->progress,
            .user_ud = s->progress_ud,
        };
        ds4_session_progress_fn progress_fn =
            s->progress ? ds4_session_note_prefill_progress : NULL;
        bool ok = metal_graph_prefill_chunked_range(&s->graph,
                                                    &e->model,
                                                    &e->weights,
                                                    prompt,
                                                    (uint32_t)s->checkpoint.len,
                                                    (uint32_t)suffix,
                                                    s->logits,
                                                    false,
                                                    progress_fn,
                                                    progress_fn ? &progress : NULL,
                                                    s->display_progress,
                                                    s->display_progress_ud,
                                                    NULL);
        if (!ok) {
            snprintf(err, errlen, "%s resumed prefill failed while extending checkpoint", backend_name);
            s->checkpoint_valid = false;
            return 1;
        }
        ds4_tokens_copy(&s->checkpoint, prompt);
        s->checkpoint_valid = true;
        return 0;
    }
    /* short suffix: per-token decode */
}
```

`resume_min` is the crossover where batched prefill beats per-token decode. `metal_graph_resume_prefill_min_tokens` (`ds4.c:14307-14318`):

```c
/* ds4.c:14307 */
static uint32_t metal_graph_resume_prefill_min_tokens(void) {
    const char *env = getenv("DS4_METAL_RESUME_PREFILL_MIN");
    if (env && env[0]) {
        char *endp = NULL;
        const long v = strtol(env, &endp, 10);
        if (endp != env) {
            if (v <= 0) return UINT32_MAX;
            return (uint32_t)v;
        }
    }
    return 4u;
}
```

The default is 4 — i.e. as soon as the suffix is 4 or more tokens, use chunked prefill. The comment block at `ds4.c:14303-14306` explains: "*On an M3 Max, prefill is faster from 2-token suffixes upward; keep the default at 4 as a conservative crossover.*" Setting the env var to 0 disables the chunked path entirely; setting it large forces per-token decode for everything.

The reason chunked prefill needs the `_range` variant and not just plain `_chunked` is alignment. The compressor and indexer in DeepSeek's KV machinery commit rows at absolute positions; if a resumed prefill produced rows in a different order than a cold prefill, the two checkpoints would diverge numerically over time. `metal_graph_prefill_chunked_range` takes the absolute starting position (`s->checkpoint.len`) as an argument so the chunk boundaries land at the same offsets a cold prefill would have produced.

### 5.5 GPU path: matching checkpoint, short suffix

`ds4.c:18017-18029`:

```c
/* ds4.c:18017 */
for (int i = s->checkpoint.len; i < prompt->len; i++) {
    if (!metal_graph_eval_token_raw_swa(&s->graph, &e->model, &e->weights,
                                        (uint32_t)prompt->v[i],
                                        (uint32_t)s->checkpoint.len,
                                        s->logits))
    {
        snprintf(err, errlen, "%s decode failed while extending checkpoint", backend_name);
        s->checkpoint_valid = false;
        return 1;
    }
    token_vec_push(&s->checkpoint, prompt->v[i]);
}
return 0;
```

`metal_graph_eval_token_raw_swa` is the per-token decode path — exactly the function `ds4_session_eval` calls. For a 1-3 token suffix, it's the same code path the generation loop already uses, so there is no setup overhead.

### 5.6 GPU path: cold start

`ds4.c:18032-18068`:

```c
/* ds4.c:18032 */
bool ok;
s->checkpoint_valid = false;
s->mtp_draft_valid = false;
if (!metal_graph_reset_prefill_state(&s->graph)) {
    snprintf(err, errlen, "%s prefill state reset failed", backend_name);
    return 1;
}
if (s->prefill_cap < (uint32_t)prompt->len) {
    /* large prompt: chunked prefill */
    ok = metal_graph_prefill_chunked(&s->graph, &e->model, &e->weights,
                                     prompt, prompt->len, s->logits, false,
                                     progress_fn, ..., s->display_progress, ...);
} else {
    /* fits in one ubatch */
    ok = metal_graph_prefill_raw_swa(&s->graph, &e->model, &e->weights,
                                     prompt, prompt->len, s->logits, false,
                                     s->display_progress, ...);
}
if (!ok) {
    snprintf(err, errlen, "%s prefill failed", backend_name);
    s->checkpoint_valid = false;
    return 1;
}
ds4_tokens_copy(&s->checkpoint, prompt);
s->checkpoint_valid = true;
s->mtp_draft_valid = false;
s->graph.mtp_n_raw = 0;
return 0;
```

Two paths based on prompt size relative to `prefill_cap`. The cold start discards the previous checkpoint completely (`checkpoint_valid = false` before, refilled after).

### 5.7 Returning a useful error

Notice every error path snprintfs into the caller's buffer:

```c
snprintf(err, errlen, "%s prefill failed", backend_name);
```

The server's HTTP error handler wraps this into a JSON response. The CLI prints it to stderr. The contract is "if return is nonzero, `err` is filled with a human-readable explanation."

## 6. Rewrites and common-prefix logic

### 6.1 ds4_session_common_prefix

```c
/* ds4.c:18132 */
int ds4_session_common_prefix(ds4_session *s, const ds4_tokens *prompt) {
    if (!s->checkpoint_valid) return 0;
    int n = s->checkpoint.len < prompt->len ? s->checkpoint.len : prompt->len;
    int i = 0;
    while (i < n && s->checkpoint.v[i] == prompt->v[i]) i++;
    return i;
}
```

Linear scan, O(min(checkpoint.len, prompt.len)). Returns 0 if the checkpoint is invalid.

### 6.2 ds4_session_rewrite_requires_rebuild

```c
/* ds4.c:18079 */
bool ds4_session_rewrite_requires_rebuild(int live_len, int canonical_len, int common) {
    if (live_len < 0 || canonical_len < 0 || common < 0) return true;
    if (common > live_len || common > canonical_len) return true;
    return common < live_len;
}
```

The "rebuild needed" criterion is simply: did the canonical version diverge from the live version *before* the live end? The comment block at `ds4.c:18072-18078` lays out why:

```
A DS4 session checkpoint is more than a token vector: the backend state also
contains raw SWA rows, compressed KV rows, indexer rows, and compressor
frontiers.  Replacing any part of the live tail requires restoring that whole
frontier first.  Extending exactly at the live end is safe; rewriting behind
it is not an in-place operation.
```

Concretely, when the server feeds back a tool call canonicalized with a different attribute order than the model originally emitted, the canonical prompt's tail diverges from the live checkpoint's tail. The KV rows already committed for the original tail are wrong for the canonical tail, and rolling them back requires per-position frontier snapshots that the current implementation does not maintain.

### 6.3 ds4_session_rewrite_from_common

```c
/* ds4.c:18095 */
ds4_session_rewrite_result ds4_session_rewrite_from_common(
        ds4_session *s, const ds4_tokens *prompt, int common,
        char *err, size_t errlen) {
    if (!s || !prompt || prompt->len <= 0 || prompt->len >= s->ctx_size) {
        snprintf(err, errlen, "prompt exceeds context");
        return DS4_SESSION_REWRITE_ERROR;
    }
    if (!s->checkpoint_valid) {
        snprintf(err, errlen, "session has no valid checkpoint");
        return DS4_SESSION_REWRITE_ERROR;
    }
    if (common < 0 || common > s->checkpoint.len || common > prompt->len) {
        snprintf(err, errlen, "invalid rewrite prefix");
        return DS4_SESSION_REWRITE_ERROR;
    }
    for (int i = 0; i < common; i++) {
        if (s->checkpoint.v[i] != prompt->v[i]) {
            snprintf(err, errlen, "rewrite prefix does not match live checkpoint");
            return DS4_SESSION_REWRITE_ERROR;
        }
    }

    if (common == s->checkpoint.len) {
        return ds4_session_sync(s, prompt, err, errlen) == 0 ?
            DS4_SESSION_REWRITE_OK : DS4_SESSION_REWRITE_ERROR;
    }

    if (ds4_session_rewrite_requires_rebuild(s->checkpoint.len, prompt->len, common)) {
        snprintf(err, errlen, "rewrite needs rebuild: common=%d live=%d canonical=%d",
                 common, s->checkpoint.len, prompt->len);
        return DS4_SESSION_REWRITE_REBUILD_NEEDED;
    }

    snprintf(err, errlen, "unexpected canonical rewrite state");
    return DS4_SESSION_REWRITE_ERROR;
}
```

The three return paths:

- `DS4_SESSION_REWRITE_OK` — the canonical prompt extends the live checkpoint at its tail, so a plain `ds4_session_sync` extends it. This is the common case after a tool-call round trip where the canonical DSML happens to match the model's emitted DSML.
- `DS4_SESSION_REWRITE_REBUILD_NEEDED` — the canonical prompt diverges before the live tail. The session does not mutate; the caller (typically `ds4_server.c`) should look for a disk KV snapshot covering the common prefix and load it, or fall back to a cold start.
- `DS4_SESSION_REWRITE_ERROR` — argument errors or an inconsistent state.

```
Scenario A: pure append
  checkpoint:  [A B C D]
  canonical:   [A B C D E F]
  common = 4, live = 4 → OK, sync extends with [E F]

Scenario B: divergence ahead of live tail (tool-call canonicalization)
  checkpoint:  [A B C X Y]    ← live includes already-sampled X Y
  canonical:   [A B C X' Y']  ← server's canonical form has different bytes
  common = 3, live = 5 → REBUILD_NEEDED

  Server response: search disk KV cache for an entry whose token prefix matches
  the canonical [A B C ...]; if found, load_payload + sync.  Otherwise
  invalidate and cold-start.
```

## 7. Sampling

### 7.1 The sampling API

```c
/* ds4.h:181-185 */
int ds4_session_argmax(ds4_session *s);
int ds4_session_argmax_excluding(ds4_session *s, int excluded_id);
int ds4_session_sample(ds4_session *s, float temperature, int top_k,
                       float top_p, float min_p, uint64_t *rng);
int ds4_session_top_logprobs(ds4_session *s, ds4_token_score *out, int k);
int ds4_session_token_logprob(ds4_session *s, int token, ds4_token_score *out);
```

The defaults are at `ds4.h:53-55`:

```c
#define DS4_DEFAULT_TEMPERATURE 1.0f
#define DS4_DEFAULT_TOP_P 1.0f
#define DS4_DEFAULT_MIN_P 0.05f
```

The `_excluding` variant is used for negative prompting (skip an EOS that prematurely closes a tool call, etc.).

### 7.2 ds4_session_sample

```c
/* ds4.c:18159 */
int ds4_session_sample(ds4_session *s, float temperature, int top_k,
                       float top_p, float min_p, uint64_t *rng) {
    return sample_top_p_min_p(s->logits, DS4_N_VOCAB, temperature, top_k, top_p, min_p, rng);
}
```

The actual filter pipeline (`ds4.c:15573-15633`):

1. If `temperature <= 0`, fall through to `sample_argmax`.
2. Build a top-k buffer (capped at 1024 ids) using insertion sort.
3. Compute softmax probabilities relative to `max_logit` for numeric stability.
4. Walk the sorted probabilities, summing until either `min_p * top_prob` cuts off the tail or cumulative probability reaches `top_p`.
5. Inverse-transform sample from the filtered set using `rng`.

```c
/* ds4.c:15614 */
const float min_prob = (probs[0] / sum) * min_p;
float filtered_sum = 0.0f;
int filtered = 0;
for (int i = 0; i < n; i++) {
    float p = probs[i] / sum;
    if (i > 0 && p < min_prob) break;
    filtered_sum += probs[i];
    filtered++;
    if (filtered_sum / sum >= top_p) break;
}
```

`min_p` is a more recent addition to the filter family and is the project's preferred knob — it adapts to the entropy of the logit distribution. A low-entropy distribution (the model is sure) cuts the tail very aggressively; a high-entropy distribution (the model is unsure) keeps more options.

### 7.3 Determinism

The RNG state is caller-supplied (`uint64_t *rng`). The caller passes the same pointer across `ds4_session_sample` calls within one generation to keep the sequence deterministic. ds4 does not own RNG state; each session's RNG is whatever the CLI or server hands it.

## 8. ds4_session_eval and speculative decoding

### 8.1 Plain eval

```c
/* ds4.c:18305 */
int ds4_session_eval(ds4_session *s, int token, char *err, size_t errlen) {
    return ds4_session_eval_internal(s, token, true, err, errlen);
}
```

`ds4_session_eval_internal` (`ds4.c:18228-18303`) appends one token to the live state and updates `logits`. The `probe_mtp` argument controls whether to attempt MTP drafting after each step.

For the CPU path it's just a `forward_token_raw_swa_cpu_decode_scratch` call (`ds4.c:18233-18247`). For the GPU path it's `metal_graph_eval_token_raw_swa` plus, if MTP is enabled, a follow-up `metal_graph_eval_mtp_draft` to populate `mtp_draft_token` for the next round.

### 8.2 Speculative decode

```c
/* ds4.h:188 */
int ds4_session_eval_speculative_argmax(ds4_session *s, int first_token,
                                        int max_tokens, int eos_token,
                                        int *accepted, int accepted_cap,
                                        char *err, size_t errlen);
```

`ds4.c:18316-18908` is the implementation. The state machine described by the comment at `ds4.c:18309-18315`:

```
1. commit the normal target token and use its logits to validate draft[0];
2. let MTP recursively draft a tiny suffix from its own raw-cache frontier;
3. verify the suffix with the target graph, committing only the accepted
   prefix and rolling back speculative Metal state on miss;
4. fall back to ordinary one-token decode if the fast verifier cannot prove
   the target stream.
```

The key safety property is *MTP never replaces the target model's sampling*; it only proposes positions for the target model to verify cheaply. If verification fails, the engine falls back to ordinary decode and the user-facing token stream is unchanged.

## 9. Session-level state mutation outside sync

Three helpers reach into the session without going through full sync:

```c
/* ds4.c:18911 */
void ds4_session_invalidate(ds4_session *s) {
    s->checkpoint_valid = false;
    s->checkpoint.len = 0;
    s->mtp_draft_valid = false;
}

/* ds4.c:18917 */
void ds4_session_rewind(ds4_session *s, int pos) {
    if (pos < 0) pos = 0;
    if (pos > s->checkpoint.len) pos = s->checkpoint.len;
    s->checkpoint.len = pos;
    s->mtp_draft_valid = false;
}

/* ds4.c:18924 */
int ds4_session_pos(ds4_session *s) {
    return s->checkpoint.len;
}
```

`ds4_session_invalidate` is the nuclear option: next sync will cold-start. Used when the server detects a hard mismatch or a backend error.

`ds4_session_rewind` truncates `checkpoint.len` without touching the underlying KV cache rows. This is exactly the right thing to do when you want to drop the last N tokens: the GPU rows for positions ≥ pos will be overwritten by the next decode/prefill at those positions, so leaving stale data behind costs nothing.

`ds4_session_pos` and `ds4_session_ctx` (`ds4.c:18928`) expose the bookkeeping for caller use.

## 10. Snapshot save/load

### 10.1 Public surface

```c
/* ds4.h:203-208 */
uint64_t ds4_session_payload_bytes(ds4_session *s);
int ds4_session_save_payload(ds4_session *s, FILE *fp, char *err, size_t errlen);
int ds4_session_load_payload(ds4_session *s, FILE *fp, uint64_t payload_bytes,
                             char *err, size_t errlen);
int ds4_session_save_snapshot(ds4_session *s, ds4_session_snapshot *snap,
                              char *err, size_t errlen);
int ds4_session_load_snapshot(ds4_session *s, const ds4_session_snapshot *snap,
                              char *err, size_t errlen);
void ds4_session_snapshot_free(ds4_session_snapshot *snap);
```

The split between FILE\* and memory-buffer APIs lets the server stream large payloads to disk without intermediate buffering, while the snapshot variant builds a contiguous buffer for in-memory caching.

### 10.2 Payload layout

The header at `ds4.c:16102-16105`:

```c
#define DS4_SESSION_PAYLOAD_MAGIC UINT32_C(0x34565344) /* "DSV4" */
#define DS4_SESSION_PAYLOAD_VERSION UINT32_C(1)
#define DS4_SESSION_PAYLOAD_U32_FIELDS 13u
#define DS4_SESSION_IO_CHUNK (8u * 1024u * 1024u)
```

13 32-bit header fields, then body. The CPU and GPU paths share the header schema (`ds4.c:16564-16578` for CPU, `16642-16654` for GPU):

```
field  0  magic                = 0x34565344 ("DSV4")
field  1  version              = 1
field  2  ctx_size             = session's context budget
field  3  prefill_cap          = ubatch size used at create time
field  4  raw_cap              = raw SWA cache capacity
field  5  raw_window           = active raw window size (GPU only; mirror of raw_cap on CPU)
field  6  comp_cap             = compressed KV cache capacity
field  7  checkpoint.len       = token count
field  8  DS4_N_LAYER          = 43, for cross-check
field  9  DS4_N_HEAD_DIM       = 512
field 10  DS4_N_INDEXER_HEAD_DIM = 128
field 11  DS4_N_VOCAB          = 129280
field 12  raw_live             = number of raw rows actually serialized
```

After the header:

```
checkpoint.len * uint32  → the token sequence
DS4_N_VOCAB * float32    → last-step logits
DS4_N_LAYER * uint32     → per-layer n_comp (compressed row count)
DS4_N_LAYER * uint32     → per-layer n_index_comp
per layer:
  raw_live * DS4_N_HEAD_DIM * float32  → raw SWA rows (last window only)
  if compress_ratio != 0:
    n_comp * DS4_N_HEAD_DIM * float32  → compressed attn KV rows
    attn_state_kv bytes                → compressor frontier
    attn_state_score bytes             → compressor scores
  if compress_ratio == 4 (ratio-4 layers have an indexer):
    n_index_comp * DS4_N_INDEXER_HEAD_DIM * float32  → indexer KV rows
    index_state_kv bytes
    index_state_score bytes
```

The comment at `ds4.c:16081-16100` describes the design intent:

```
The payload is intentionally not mmaped: restoring a checkpoint copies bytes
back into the already allocated Metal tensors, preserving the same live graph
buffers used by normal prefill/decode.  The raw SWA cache is serialized as the
last logical window only; suffix prefill writes its own raw rows before
attention.  The compressed caches are serialized up to their live row counts
because sparse attention may select rows from the whole prefix.

The payload is model-specific rather than self-describing.  The fixed header
records enough shape information to reject a file written for a different DS4
runtime, then the body writes: checkpoint tokens, last logits, per-layer
compressed row counts, raw SWA rows in logical order, compressed attention
rows, and the compressor/indexer frontiers.  That is the minimum state needed
for the next token to match a session that had just prefetched the prefix.
```

### 10.3 Load path

Load (`ds4.c:16761-...`) reads the header, validates magic/version, validates the shape constants against the current build (so a payload written by a different binary is rejected), then copies bytes back into the appropriate session/graph fields. After load, `checkpoint_valid = true` and the session is ready for the next sync or eval.

The "model-specific rather than self-describing" property is the whole reason these payloads can be ~MBs rather than ~GBs: the loader knows the shape of every field at compile time, so the payload just streams floats with no per-field metadata.

## 11. CPU reference path

### 11.1 Why it exists

The CPU path is not the production path on any platform that has a GPU. Its purpose is to be the *numerically definitive* implementation that the Metal and CUDA backends can be compared against, layer by layer, in the GPU/CPU equivalence tests.

If a Metal shader's IQ2_XXS dot kernel drifts, the equivalence test will flag the drift. If a CUDA reduction collapses in a corner case, the equivalence test will flag it. The CPU path's job is to be slow, exact, and easy to read.

### 11.2 Persistent thread pool

`ds4_threads_init` (`ds4.c:697-734`):

```c
/* ds4.c:697 */
/* Create the persistent CPU worker pool.  Decode reuses these threads instead
 * of creating pthreads in the token loop. */
static void ds4_threads_init(void) {
    if (g_pool.initialized) return;

    pthread_once(&iq2xxs_signed_grid_once, iq2xxs_signed_grid_init);

    uint32_t n_threads = 12;
    const long online_cpus = sysconf(_SC_NPROCESSORS_ONLN);
    if (online_cpus > 0) {
        n_threads = online_cpus < 12 ? (uint32_t)online_cpus : 12;
    }
    const char *env = getenv("DS4_THREADS");
    if (env && env[0]) {
        long v = strtol(env, NULL, 10);
        if (v > 0) n_threads = (uint32_t)v;
    }
    if (g_requested_threads > 0) n_threads = g_requested_threads;
    /* ... */

    for (uint32_t i = 1; i < n_threads; i++) {
        pthread_create(&g_pool.threads[i], NULL, ds4_worker_main, ...);
    }
}
```

The pool is lazy-initialized on first parallel call. It caps at 12 threads (matching the M3 Max P-core count) but can be overridden via `DS4_THREADS` env var or the `n_threads` option. The signed IQ2 grid initialization (Chapter 4 Section 3.2) piggybacks on the same `pthread_once` to avoid a separate init path.

### 11.3 Single-token decode

```c
/* ds4.c:7724 */
static void forward_token_raw_swa_cpu_decode_scratch(
        float * logits,
        const ds4_model   * model,
        const ds4_weights * weights,
        ds4_kv_cache      * cache,
        int                 token,
        uint32_t            pos,
        const float       * steering_dirs,
        float               steering_attn_scale,
        float               steering_ffn_scale,
        ds4_cpu_decode_scratch * scratch) {
    float *cur = scratch->cur;
    float *next = scratch->next;

    embed_token_f16(model, weights, token, scratch->plain);
    hc_from_plain_embedding(cur, scratch->plain, DS4_N_EMBD, DS4_N_HC);

    for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
        layer_forward_raw_swa_one(next, model, &weights->layer[il], &cache->layer[il],
                                  cur, il, pos, token,
                                  steering_dirs,
                                  steering_attn_scale,
                                  steering_ffn_scale,
                                  scratch);
        float *tmp = cur;
        cur = next;
        next = tmp;
    }

    if (logits) {
        output_logits_one_decode_scratch(logits, model, weights, cur, scratch);
    }
}
```

Two F32 buffers (`cur`, `next`) of size `DS4_N_HC × DS4_N_EMBD` ping-pong through 43 layers. No allocation in the loop — `scratch` carries every working buffer (see the layout at `ds4.c:170-226`).

### 11.4 Layer-major prefill

```c
/* ds4.c:7784 */
static void prefill_layer_major_cpu(
        float             * logits,
        const ds4_model   * model,
        const ds4_weights * weights,
        ds4_kv_cache      * cache,
        const token_vec   * prompt,
        const float       * steering_dirs,
        float               steering_attn_scale,
        float               steering_ffn_scale) {
    const uint64_t hc_dim = (uint64_t)DS4_N_HC * DS4_N_EMBD;
    const uint64_t n_tok = (uint64_t)prompt->len;
    float *cur = xmalloc((size_t)n_tok * hc_dim * sizeof(cur[0]));
    float *next = xmalloc((size_t)n_tok * hc_dim * sizeof(next[0]));
    float *attn = xmalloc((size_t)n_tok * hc_dim * sizeof(attn[0]));
    /* ... */
    for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
        fprintf(stderr, "ds4: prefill layer %u/%u\r", il + 1, DS4_N_LAYER);
        layer_attention_raw_swa_batch(...);
        /* FFN: batched_ffn / shared_batch_ffn / per-token */
        /* swap cur and next */
    }
}
```

Layer-major means: all N prompt tokens through layer 0, then all N through layer 1, and so on. This is a batched matmul opportunity at every layer, which a token-major prefill would not provide. It's the same loop structure GPU prefill uses; the CPU implementation differs only in dispatch (calls into SIMD helpers vs. shaders).

### 11.5 Entry point

`generate_raw_swa_cpu` (`ds4.c:15669-...`):

```c
/* ds4.c:15669 */
static int generate_raw_swa_cpu(...) {
    fprintf(stderr, "ds4: using CPU generation with layer-major prefill\n");
    ds4_kv_cache cache;
    kv_cache_init(&cache, (uint32_t)ctx_size, 0);
    ds4_cpu_decode_scratch decode_scratch;
    cpu_decode_scratch_init(&decode_scratch, (uint32_t)ctx_size);
    prefill_layer_major_cpu(logits, model, weights, &cache, prompt, ...);
    /* argmax sampling loop, calls forward_token_raw_swa_cpu_decode_scratch */
}
```

This is what `ds4_engine_generate_argmax` calls when the backend is CPU. It uses `argmax` sampling — the CPU path is for correctness testing, not user-facing generation.

## 12. End-to-end inference flow

```
   User request (full chat history)
        │
        ▼  ds4_encode_chat_prompt / ds4_chat_append_message
   ds4_tokens prompt   (Chapter 5)
        │
        ▼  ds4_session_common_prefix(s, &prompt)
   common = N
        │
        ├─ common == prompt.len?
        │     → already at target, just read s->logits
        │
        ├─ common == s->checkpoint.len?
        │     → ds4_session_sync(s, &prompt)
        │       (suffix-only prefill, fast)
        │
        └─ common < s->checkpoint.len?
              → ds4_session_rewrite_from_common
                ├─ REWRITE_OK: sync (already covered above)
                ├─ REBUILD_NEEDED:
                │     server looks for disk KV at common-prefix length
                │     if found: ds4_session_load_payload + sync suffix
                │     if not:   ds4_session_invalidate + sync (cold)
                └─ ERROR: surface to client
        │
        ▼   generation loop
   while not EOS and tokens remaining:
      token = ds4_session_sample(s, T, top_k, top_p, min_p, &rng)
      ds4_session_eval(s, token, err, errlen)
      emit(token)
```

This is what makes ds4 feel "stateful" to a user while being entirely stateless at the API surface. The HTTP layer doesn't track conversations; the engine does, opaquely, through `ds4_session_sync`.

## 13. Quick reference

```c
/* engine */
int  ds4_engine_open(ds4_engine **out, const ds4_engine_options *opt);   /* ds4.c:17636 */
void ds4_engine_close(ds4_engine *e);                                     /* ds4.c:17780 */

/* session lifecycle */
int  ds4_session_create(ds4_session **out, ds4_engine *e, int ctx_size); /* ds4.c:17796 */
void ds4_session_free(ds4_session *s);                                    /* ds4.c:17845 */
void ds4_session_set_progress(ds4_session *s, fn, ud);                    /* ds4.c:17876 */
void ds4_session_set_display_progress(ds4_session *s, fn, ud);            /* ds4.c:17882 */

/* sync and rewrite */
int  ds4_session_sync(ds4_session *s, prompt, err, errlen);               /* ds4.c:17924 */
int  ds4_session_common_prefix(ds4_session *s, prompt);                   /* ds4.c:18132 */
bool ds4_session_rewrite_requires_rebuild(live, canonical, common);       /* ds4.c:18079 */
ds4_session_rewrite_result ds4_session_rewrite_from_common(...);          /* ds4.c:18095 */

/* sampling */
int  ds4_session_argmax(ds4_session *s);                                  /* ds4.c:18140 */
int  ds4_session_argmax_excluding(ds4_session *s, excluded_id);           /* ds4.c:18144 */
int  ds4_session_sample(ds4_session *s, T, top_k, top_p, min_p, rng);     /* ds4.c:18159 */
int  ds4_session_top_logprobs(ds4_session *s, out, k);                    /* ds4.c:18163 */
int  ds4_session_token_logprob(ds4_session *s, token, out);               /* ds4.c:18200 */

/* eval */
int  ds4_session_eval(ds4_session *s, token, err, errlen);                /* ds4.c:18305 */
int  ds4_session_eval_speculative_argmax(...);                            /* ds4.c:18316 */

/* state mutation */
void ds4_session_invalidate(ds4_session *s);                              /* ds4.c:18911 */
void ds4_session_rewind(ds4_session *s, pos);                             /* ds4.c:18917 */
int  ds4_session_pos(ds4_session *s);                                     /* ds4.c:18924 */
int  ds4_session_ctx(ds4_session *s);                                     /* ds4.c:18928 */
const ds4_tokens *ds4_session_tokens(ds4_session *s);

/* disk payload */
uint64_t ds4_session_payload_bytes(ds4_session *s);                       /* ds4.c:16530 */
int      ds4_session_save_payload(ds4_session *s, fp, err, errlen);       /* ds4.c:16555 */
int      ds4_session_load_payload(ds4_session *s, fp, bytes, err, len);   /* ds4.c:16761 */
int      ds4_session_save_snapshot(ds4_session *s, snap, err, errlen);    /* ds4.c:17125 */
int      ds4_session_load_snapshot(ds4_session *s, snap, err, errlen);    /* ds4.c:17164 */
```

Key constants:

```c
DS4_N_LAYER              = 43        /* ds4.c:88 */
DS4_N_EMBD               = 4096
DS4_N_VOCAB              = 129280
DS4_THINK_MAX_MIN_CONTEXT= 393216    /* ds4.c:72 */
DS4_DEFAULT_TEMPERATURE  = 1.0       /* ds4.h:53 */
DS4_DEFAULT_TOP_P        = 1.0
DS4_DEFAULT_MIN_P        = 0.05
resume_prefill default   = 4 tokens  /* DS4_METAL_RESUME_PREFILL_MIN env */
prefill_cap default      = 4096      /* DS4_METAL_PREFILL_CHUNK env */
```

## 14. Cross-references

- The token vector that feeds `ds4_session_sync` is built by the tokenizer in Chapter 5.
- The weight tensors `ds4_engine_open` binds were verified by the GGUF loader described in Chapter 3.
- The Metal and CUDA shader implementations behind `metal_graph_*` and the CUDA equivalents are subjects of later chapters.
- The KV cache rows that `payload_*` reads and writes are produced by the attention/compressor described in Chapter 7.
- The disk KV cache that uses the payload API is Chapter 14.
- The MTP draft model that `ds4_session_eval_speculative_argmax` consults is covered separately.
