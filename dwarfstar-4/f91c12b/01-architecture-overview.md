# Chapter 01: Architecture Overview & Boot Flow

> Code version locked to `antirez/ds4@f91c12b` (2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

This chapter is written for systems engineers fluent in C who are about to open `ds4.c` for the first time. Before any subsystem deep-dive, you need a reliable map: what DwarfStar 4 (ds4) is, why it is shaped the way it is, what the five binaries are, and what actually happens between typing `./ds4 -p "hello"` on a shell and the engine emitting its first sampled token. Later chapters drill down layer by layer; this one only draws the skeleton.

---

## 1. What ds4 Is

### 1.1 A one-sentence definition

ds4 is a **standalone C inference engine purpose-built for DeepSeek V4 Flash**. It is not a generic GGUF runner, not a wrapper around llama.cpp, and not a research scaffold. The first paragraph of `README.md` is unusually direct (`README.md:3-10`):

```
DwarfStar 4 is a small native inference engine specific for DeepSeek V4 Flash.
It is intentionally narrow: not a generic GGUF runner, not a wrapper around
another runtime: it is completely self-contained. Other than running the model
in a correct and fast way, the project goal is to provide DS4 specific
loading, prompt rendering, tool calling, KV state handling (RAM and on-disk),
server API and integrated coding agent, all ready to work with coding agents
or with the provided CLI interface.
```

Three judgements shape the entire codebase:

1. **"specific for DeepSeek V4 Flash"** — every shape constant is hard-coded. `ds4.c:87-116` defines the exact `enum` of layer counts, embedding dimensions, expert counts, and HC/Sinkhorn parameters; the metadata validator at `ds4.c:2585-2667` rejects any GGUF whose declared values disagree by even one. The benefit is that the inference code can use compile-time-known shapes everywhere (`DS4_N_LAYER`, `DS4_N_EXPERT`, `DS4_N_HEAD_DIM`), which simplifies every kernel and removes a whole class of "model loaded but inference subtly wrong" bugs.
2. **"completely self-contained"** — `ds4.c` does not link `ggml` or `llama.cpp`. The comment at the top of `README.md:46-55` is honest about the lineage: GGUF format, quantization layouts, and several CPU dot-product routines are adapted under MIT, but the inference path is hand-rolled. The single-translation-unit `ds4.c` is currently ~18,930 lines; `ds4_gpu.h` is the only abstraction layer between it and a backend.
3. **"server API and integrated coding agent ... ready to work with coding agents"** — the project ships five binaries. The library boundary at `ds4.h` is the only thing they share. This means the inference engine can evolve independently from the application surface; conversely, application code can never poke into tensor internals.

### 1.2 Design constraints from AGENT.md

`AGENT.md` is the project's working contract; the goals section (`AGENT.md:8-16`) lists five constraints that explain why the code looks the way it does:

```
- Keep the production path as whole-model Metal graph inference.
- Keep model loading mmap-backed; do not eagerly copy the full GGUF.
- Keep the CPU backend CPU-only and use it only as reference/debug code.
- Preserve correctness before speed. Do not keep a faster path with
  unexplained attention, KV cache, or logits drift.
- Make long local agent sessions practical through live KV reuse and disk
  KV checkpoints.
```

These are not vibes. Each shows up as a concrete piece of code:

- **Whole-model Metal graph inference.** `generate_metal_graph_raw_swa` (`ds4.c:15786`) is the production entry point on macOS. It allocates a single `ds4_gpu_graph`, encodes one Metal command buffer per layer, and reuses the same per-layer work tensors for every step. The CPU path (`generate_raw_swa_cpu`) exists in the same file but is not a release target.
- **mmap-backed loading.** `model_open` (`ds4.c:1217`) parses only the GGUF header, metadata table, and tensor directory. Tensor bytes are never copied; `tensor_data` (`ds4.c:1493`) returns a pointer into the mmap region.
- **CPU backend as reference.** `README.md:42` warns that running large CPU inference on macOS will crash the kernel due to a Darwin VM bug. The CPU code is kept as a readable spec for kernels and for diagnostics that the Metal/CUDA path can verify against.
- **Correctness before speed.** `tests/test-vectors/` holds official continuations against which `make test` validates output. `AGENT.md:12-13` explicitly forbids retaining a faster path that has unexplained logits drift.
- **Long agent sessions.** The `ds4_session` design splits work between a *live* checkpoint (in-RAM KV) and a *disk* checkpoint (`ds4_session_save_payload` and related, declared in `ds4.h:203-208`). The disk path is what makes a 100k-token coding-agent conversation survive restarts.

### 1.3 Why a model-specific engine

It is reasonable to ask: a perfectly good generic engine (llama.cpp) already runs DeepSeek V4 Flash. Why write a new one?

`README.md:21-41` answers in five points. The compressed ones:

- DeepSeek V4 Flash has unusual structural features — hyper-connections, ratio-4/128 compressed KV, indexer-driven sparse attention — that a generic engine must encode as configuration. ds4 encodes them as constants. The arithmetic does not have to dispatch through "if (use_hc) ...".
- A 284B-parameter model in 2-bit asymmetric quantization fits in 96-128 GB of unified memory on a MacBook Pro. The asymmetric quantization (`README.md:97-101`) only quantizes routed experts; the rest stays high precision. This is a model-specific decision that a generic loader would not make.
- The 1M-token context only works if KV cache becomes a "first-class disk citizen" (`README.md:40`). Implementing that policy outside the engine — at the HTTP boundary, say — requires the engine to expose serialization hooks the way `ds4.h:203-208` does. A generic engine would have to add this as an upstream feature.
- A narrow target lets `tests/test-vectors/` exist. The engine can be regression-tested against logits captured from the official DeepSeek reference implementation. A generic engine has no equivalent baseline.

The cost is honest: ds4 is one model at a time, and `README.md:38` admits the exact model may change as the landscape evolves. The architectural commitment is to **one local model, end-to-end, validated**, not to portability.

---

## 2. The Five Binaries

`make` on macOS produces five executables (`Makefile:39`):

```
all: ds4 ds4-server ds4-bench ds4-eval ds4-agent
```

Each is a thin C program that calls into the same `ds4.h` API.

| Binary | Source | main() | Role |
|--------|--------|--------|------|
| `ds4` | `ds4_cli.c` | `ds4_cli.c:1571` | Single-shot generation + interactive REPL with linenoise |
| `ds4-server` | `ds4_server.c` | `ds4_server.c:11524` | OpenAI/Anthropic-compatible HTTP API with SSE streaming + disk KV cache |
| `ds4-agent` | `ds4_agent.c` | `ds4_agent.c:9518` | Interactive coding-agent REPL with built-in tool calling |
| `ds4-bench` | `ds4_bench.c` | `ds4_bench.c:395` | Prefill + generation throughput benchmark; emits CSV |
| `ds4-eval` | `ds4_eval.c` | `ds4_eval.c:3681` | Embedded 92-question evaluation suite (GPQA / SuperGPQA / AIME / COMPSEC) |

Three of these (`ds4_cli`, `ds4_server`, `ds4_agent`) also have CPU-only builds via `make cpu`, compiled with `-DDS4_NO_GPU` to exclude the Metal/CUDA paths inside `ds4.c` (`Makefile:160-176`).

### 2.1 What each main() does

Open the five `main()` functions side by side and the pattern is identical:

```c
/* ds4_cli.c:1571 */
int main(int argc, char **argv) {
    cli_config cfg = parse_options(argc, argv);
    /* ... */
    ds4_engine *engine = NULL;
    if (ds4_engine_open(&engine, &cfg.engine) != 0) { /* ... */ }
    /* dispatch to run_repl(), run_generation(), or run_perplexity_file() */
    ds4_engine_close(engine);
    /* ... */
}
```

```c
/* ds4_server.c:11524 */
int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);
    /* install SIGINT/SIGTERM handlers */
    server_config cfg = parse_options(argc, argv);
    /* ... */
    ds4_engine *engine = NULL;
    if (ds4_engine_open(&engine, &cfg.engine) != 0) return 1;
    ds4_session *session = NULL;
    if (ds4_session_create(&session, engine, cfg.ctx_size) != 0) { /* ... */ }
    /* spin up workers, accept on listening socket, serve forever */
}
```

```c
/* ds4_bench.c:395 */
int main(int argc, char **argv) {
    bench_config cfg = parse_options(argc, argv);
    /* ... */
    ds4_engine_options opt = { .model_path = cfg.model_path, .backend = cfg.backend, /* ... */ };
    ds4_engine *engine = NULL;
    if (ds4_engine_open(&engine, &opt) != 0) return 1;
    /* prefill+decode loop measured at the context frontier */
}
```

Every entrypoint:

1. Parses argv into a config struct.
2. Calls `ds4_engine_open` with that config's `ds4_engine_options`.
3. For multi-turn entrypoints, creates one `ds4_session` per active context.
4. Drives `ds4_session_sync` / `ds4_session_eval` / `ds4_session_sample` (or the high-level `ds4_engine_generate_argmax`).
5. Calls `ds4_engine_close` on the way out.

This regularity is the payoff of the narrow `ds4.h` surface. Application logic — argv parsing, HTTP framing, tool-call routing, REPL editing, CSV emission — never crosses into tensor internals.

### 2.2 Why five binaries and not one with subcommands

Each binary is a separate program with its own `main()` rather than `ds4 server`, `ds4 bench`, etc. The reasons are practical:

- **Different dependencies.** `ds4-server` links `ds4_kvstore.o` and `rax.o` (Redis Radix Tree, used for tool-id replay tracking); `ds4-agent` additionally links `ds4_web.o` and `linenoise.o`. A subcommand layout would force every binary to link the union (`Makefile:48-61`).
- **Different signal models.** The server installs `SIGPIPE`/`SIGINT`/`SIGTERM` handlers immediately (`ds4_server.c:11525-11531`); the CLI installs no signal handlers because the REPL relies on linenoise's own Ctrl-C handling.
- **Different lifecycle.** `ds4-bench` runs once and exits. `ds4-server` runs forever. `ds4-agent` is interactive and stateful. Conflating them under one `main()` would mean adding subcommand dispatch into every shared path.

The cost is mild duplication of argv parsing helpers across files. The benefit is that each binary stays small and reads top-to-bottom.

---

## 3. The Four-Layer Architecture

ds4's runtime cleanly slices into four layers. Every code path you will read in later chapters lives in exactly one of them. Understanding the layers and the direction of traffic between them is the foundation for everything else.

### 3.1 Architecture diagram

<svg viewBox="0 0 780 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4 four-layer runtime architecture: entrypoint, engine and session, model forward, backend">
<defs>
<marker id="ar11" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="390" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">ds4 four-layer runtime architecture</text>
<rect x="20" y="36" width="740" height="92" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="390" y="54" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">L1 &middot; Entrypoint layer</text>
<rect x="36" y="62" width="138" height="22" fill="#ffffff" stroke="#ea580c" stroke-width="1" rx="3"/>
<text x="105" y="77" text-anchor="middle" font-size="10" fill="#ea580c">ds4_cli.c (REPL/CLI)</text>
<rect x="180" y="62" width="160" height="22" fill="#ffffff" stroke="#ea580c" stroke-width="1" rx="3"/>
<text x="260" y="77" text-anchor="middle" font-size="10" fill="#ea580c">ds4_server.c (HTTP API)</text>
<rect x="346" y="62" width="160" height="22" fill="#ffffff" stroke="#ea580c" stroke-width="1" rx="3"/>
<text x="426" y="77" text-anchor="middle" font-size="10" fill="#ea580c">ds4_agent.c (coding agent)</text>
<rect x="512" y="62" width="110" height="22" fill="#ffffff" stroke="#ea580c" stroke-width="1" rx="3"/>
<text x="567" y="77" text-anchor="middle" font-size="10" fill="#ea580c">ds4_bench.c</text>
<rect x="628" y="62" width="116" height="22" fill="#ffffff" stroke="#ea580c" stroke-width="1" rx="3"/>
<text x="686" y="77" text-anchor="middle" font-size="10" fill="#ea580c">ds4_eval.c</text>
<text x="390" y="108" text-anchor="middle" font-size="10" fill="#64748b">argv -&gt; tokens; loop ds4_session_eval + ds4_session_sample; stream tokens back out</text>
<text x="390" y="122" text-anchor="middle" font-size="10" fill="#64748b">may NOT include ds4_gpu.h; sees only ds4.h</text>
<line x1="390" y1="128" x2="390" y2="146" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11)"/>
<text x="556" y="140" font-size="10" font-style="italic" fill="#64748b">ds4.h (public engine boundary)</text>
<rect x="20" y="146" width="740" height="98" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
<text x="390" y="164" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">L2 &middot; Engine and Session</text>
<text x="200" y="184" text-anchor="middle" font-size="11" fill="#64748b">ds4_engine</text>
<text x="200" y="198" text-anchor="middle" font-size="10" fill="#64748b">immutable loaded model</text>
<text x="200" y="212" text-anchor="middle" font-size="10" fill="#64748b">mmap weights + vocab</text>
<text x="580" y="184" text-anchor="middle" font-size="11" fill="#64748b">ds4_session</text>
<text x="580" y="198" text-anchor="middle" font-size="10" fill="#64748b">mutable inference timeline</text>
<text x="580" y="212" text-anchor="middle" font-size="10" fill="#64748b">KV cache + logits + checkpoint</text>
<text x="390" y="232" text-anchor="middle" font-size="10" fill="#64748b">ds4_session_sync() &middot; ds4_session_eval() &middot; ds4_session_sample()</text>
<line x1="390" y1="244" x2="390" y2="262" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11)"/>
<rect x="20" y="262" width="740" height="98" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="390" y="280" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">L3 &middot; Model forward</text>
<text x="390" y="298" text-anchor="middle" font-size="10" fill="#64748b">ds4.c: prefill_layer_major_cpu / metal_graph_prefill_chunked</text>
<text x="160" y="320" text-anchor="middle" font-size="10" fill="#64748b">embed + HC init</text>
<text x="320" y="320" text-anchor="middle" font-size="10" fill="#64748b">43 layers</text>
<text x="320" y="334" text-anchor="middle" font-size="10" fill="#64748b">(attn + HC mix + MoE/FFN)</text>
<text x="500" y="320" text-anchor="middle" font-size="10" fill="#64748b">output HC head</text>
<text x="500" y="334" text-anchor="middle" font-size="10" fill="#64748b">RMSNorm + vocab proj</text>
<text x="650" y="320" text-anchor="middle" font-size="10" fill="#64748b">optional MTP</text>
<text x="650" y="334" text-anchor="middle" font-size="10" fill="#64748b">forward</text>
<line x1="390" y1="360" x2="390" y2="378" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11)"/>
<rect x="20" y="378" width="740" height="68" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.5" rx="6"/>
<text x="390" y="396" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">L4 &middot; Backend (build-time selected)</text>
<rect x="60" y="406" width="200" height="30" fill="#fed7aa" stroke="#ea580c" stroke-width="1" rx="4"/>
<text x="160" y="420" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">Metal</text>
<text x="160" y="432" text-anchor="middle" font-size="9" fill="#64748b">ds4_metal.m + metal/*.metal</text>
<rect x="290" y="406" width="200" height="30" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="4"/>
<text x="390" y="420" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">CUDA</text>
<text x="390" y="432" text-anchor="middle" font-size="9" fill="#64748b">ds4_cuda.cu + iq2_tables_cuda.inc</text>
<rect x="520" y="406" width="200" height="30" fill="#ffffff" stroke="#94a3b8" stroke-width="1" rx="4"/>
<text x="620" y="420" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">CPU (reference)</text>
<text x="620" y="432" text-anchor="middle" font-size="9" fill="#64748b">pure C / NEON inlines</text>
</svg>
<span class="figure-caption">Figure R1.1 | ds4's four-layer runtime: application code in L1 sees only ds4.h, hands prompts to L2 sessions, which drive L3's 43-layer forward pass on L4's build-time-selected backend.</span>

<details>
<summary>ASCII original</summary>

```
+------------------------------------------------------------------+
|                       Entrypoint layer                            |
|   ds4_cli.c — single-shot + REPL                                  |
|   ds4_server.c — OpenAI/Anthropic HTTP API                        |
|   ds4_agent.c — interactive coding agent                          |
|   ds4_bench.c — prefill + decode benchmark                        |
|   ds4_eval.c — embedded evaluation suite                          |
+----------------------------------+-------------------------------+
                                   |  ds4.h (public engine boundary)
                                   v
+------------------------------------------------------------------+
|                  Engine and Session layer                         |
|   ds4_engine — immutable loaded model (mmap weights + vocab)      |
|   ds4_session — mutable inference timeline (KV cache + logits)    |
|   ds4_session_sync()  — synchronize to a full token prefix        |
|   ds4_session_eval()  — single-token forward                      |
|   ds4_session_sample() — sample next token                        |
+----------------------------------+-------------------------------+
                                   |
                                   v
+------------------------------------------------------------------+
|                    Model forward layer                            |
|   ds4.c: prefill_layer_major_cpu / metal_graph_prefill_chunked    |
|   - embed + HC initialization                                     |
|   - 43 layers (attention + HC mix + MoE/FFN)                      |
|   - output HC head + RMSNorm + vocab projection                   |
|   - optional MTP forward                                          |
+----------------------------------+-------------------------------+
                                   |
                                   v
+------------------------------------------------------------------+
|                          Backend                                  |
|   Metal: ds4_metal.m + metal/*.metal                              |
|   CUDA:  ds4_cuda.cu + ds4_iq2_tables_cuda.inc                    |
|   CPU:   pure C / NEON inlines (reference path)                   |
+------------------------------------------------------------------+
```

</details>

### 3.2 L1: Entrypoint

The five binaries listed in section 2. Their job is to:

- Translate command-line flags or HTTP requests into `ds4_tokens` (a prompt) plus generation options (temperature, top_p, ctx_size, think mode).
- Loop on `ds4_session_eval` + `ds4_session_sample` and stream tokens back out (stdout, SSE, REPL).
- Handle peripheral concerns: tool-call detection (`ds4_server.c`, `ds4_agent.c`), disk KV checkpointing policy (`ds4_kvstore.c`), terminal coloring (`ds4_cli.c`).

L1 code may **not** include `ds4_gpu.h`; it sees only `ds4.h`. This boundary is what allows `ds4_server.c` to be 15348 lines without ever knowing what a tensor is.

### 3.3 L2: Engine and Session

The `ds4_engine` and `ds4_session` types are declared as opaque forward references in `ds4.h:57-58`:

```c
typedef struct ds4_engine ds4_engine;
typedef struct ds4_session ds4_session;
```

Their full struct definitions live inside `ds4.c` and are deliberately invisible to L1. `ds4_engine` (`ds4.c:14707-14724`) holds the immutable loaded model:

```c
struct ds4_engine {
    ds4_model model;            /* mmapped GGUF + parsed metadata */
    ds4_model mtp_model;        /* optional MTP draft model */
    ds4_vocab vocab;
    ds4_weights weights;        /* tensor-name -> pointer table */
    ds4_mtp_weights mtp_weights;
    ds4_backend backend;
    int mtp_draft_tokens;
    float mtp_margin;
    /* ... steering, power, readiness flags ... */
};
```

`ds4_session` (`ds4.c:16058-16079`) holds the mutable inference timeline:

```c
struct ds4_session {
    ds4_engine *engine;
#ifndef DS4_NO_GPU
    ds4_gpu_graph graph;        /* GPU-resident KV + scratch tensors */
#endif
    ds4_kv_cache cpu_cache;     /* CPU-only KV cache (reference path) */
    ds4_cpu_decode_scratch cpu_scratch;
    token_vec checkpoint;       /* tokens already computed into KV */
    float *logits;
    float *mtp_logits;
    /* ... progress callbacks, prefill_cap, ctx_size ... */
};
```

The key operation in L2 is **`ds4_session_sync`** (`ds4.c:17924`). Given a full prompt token vector, it asks: is the current checkpoint already a prefix of this prompt?

- If yes, evaluate only the new tokens at the tail (cheap).
- If no, throw away the live state and prefill from scratch (expensive).

`ds4-server` and `ds4-agent` use `ds4_session_sync` as their entire state-management strategy: every request resends the whole transcript, and the engine decides what to recompute. This is the architectural reason ds4 can be paired with stateless HTTP and stateful coding-agent flows without two implementations.

### 3.4 L3: Model forward

The forward pass has two paths.

**CPU reference path:** `prefill_layer_major_cpu` (`ds4.c:7784`) for the prompt and `forward_token_raw_swa_cpu_decode_scratch` for each subsequent decode. The structure is the same — layer 0 through layer 42, each layer doing HC pre, attention, HC post, HC pre, MoE/FFN, HC post — but the math is plain C with optional ARM NEON inlines.

**Graph path (Metal / CUDA):** `metal_graph_prefill_chunked` (`ds4.c:14001`) and `metal_graph_decode_one` (and related). These encode the same algorithm as a sequence of GPU kernels and reuse a fixed allocation of `ds4_gpu_tensor` work buffers across all 43 layers (`ds4.c:8242-8269` lists the per-layer work tensors by name). The graph path is the production target on Apple Silicon and CUDA hosts.

The bridge between L2 and L3 is `ds4_backend_uses_graph()` (`ds4.c:74-76`), which decides at runtime whether to dispatch through the GPU graph or the CPU reference based on `e->backend`.

### 3.5 L4: Backend

The backend is selected at **build time**, not runtime. The Makefile (`Makefile:19,31`) sets `CORE_OBJS` based on `uname -s`:

```makefile
# macOS:
CORE_OBJS = ds4.o ds4_metal.o
# Linux:
CORE_OBJS = ds4.o ds4_cuda.o
```

The CPU-only path uses `-DDS4_NO_GPU` (`Makefile:160`), which causes `ds4.c:40-42` to skip including `ds4_gpu.h`:

```c
#ifndef DS4_NO_GPU
#include "ds4_gpu.h"
#endif
```

`ds4_gpu.h` declares the GPU abstraction (function signatures only). Both `ds4_metal.m` and `ds4_cuda.cu` implement that contract; the linker decides which lives in the final binary. The 19 Metal kernels under `metal/*.metal` cover attention, MoE, HC, RoPE, quantization, normalization, and miscellaneous tensor ops.

### 3.6 Where each chapter of this wiki lives

| Layer | Reference chapters |
|-------|--------------------|
| L1 — Entrypoint | 09 (server), 14 (agent) |
| L2 — Engine and Session | 06 (engine and session lifecycle), 07 (disk KV) |
| L3 — Model forward | 02 (model architecture), 05 (forward pipelines), 08 (attention), 11 (MoE) |
| L4 — Backend | 04 (quantization), 10 (Metal/CUDA backends), 12 (MTP) |
| Cross-cutting | 01 (this), 03 (GGUF loading), 13 (tokenizer), 15 (glossary) |

The trace tour walks one CLI request from L1 down to L4 and back, end to end. Read the tour first if you have time; it builds the mental model the reference chapters fill in.

---

## 4. The Public Engine Boundary (`ds4.h`)

Open `ds4.h`. The whole header is 210 lines. The comment at the top is the design statement (`ds4.h:9-15`):

```c
/* Public engine boundary.
 *
 * The CLI and server should treat ds4_engine as the loaded model and
 * ds4_session as one mutable inference timeline.  A session owns the live
 * KV cache and logits; callers provide full token prefixes and let
 * ds4_session_sync() reuse, extend, or rebuild the graph state.  Keep this
 * header narrow so HTTP/CLI code does not depend on tensor internals. */
```

Everything exported falls into six groups:

| Group | Symbols | Where |
|-------|---------|-------|
| Backend / mode enums | `ds4_backend`, `ds4_think_mode`, `ds4_log_type` | `ds4.h:17-39` |
| Opaque handles | `ds4_engine *`, `ds4_session *` | `ds4.h:57-58` |
| Engine lifecycle | `ds4_engine_open`, `ds4_engine_close`, `ds4_engine_summary` | `ds4.h:96-99` |
| Session operations | `ds4_session_create`, `ds4_session_sync`, `ds4_session_eval`, `ds4_session_sample`, `ds4_session_free` | `ds4.h:155-194` |
| Tokenization and chat rendering | `ds4_tokenize_text`, `ds4_chat_append_message`, `ds4_encode_chat_prompt` | `ds4.h:137-153` |
| Disk KV serialization | `ds4_session_save_payload`, `ds4_session_load_payload`, `ds4_session_save_snapshot` | `ds4.h:203-208` |

There are also a handful of helpers exposed for callers who want to be smart:

- `ds4_context_memory_estimate` (`ds4.h:108`) lets callers print "this context size will need X GiB" before allocating a session.
- `ds4_think_mode_for_context` (`ds4.h:107`) lets the CLI and server auto-downgrade Think Max to High when the context is below 384k tokens.
- `ds4_log` and `ds4_log_is_tty` (`ds4.h:109-110`) give application code access to the engine's color-aware logger so all output formatting is consistent.

The four `ds4_engine_metal_graph_*_test` functions (`ds4.h:128-130`) are diagnostic backdoors, used by `ds4_cli.c` to validate the Metal path against the CPU reference. They are not part of the application surface; production code does not call them.

### 4.1 The `ds4_engine_options` struct

Everything that controls how the engine loads a model is in one struct (`ds4.h:62-75`):

```c
typedef struct {
    const char *model_path;
    const char *mtp_path;
    ds4_backend backend;
    int n_threads;
    int mtp_draft_tokens;
    float mtp_margin;
    const char *directional_steering_file;
    float directional_steering_attn;
    float directional_steering_ffn;
    int power_percent;
    bool warm_weights;
    bool quality;
} ds4_engine_options;
```

Three flags are worth flagging up front:

- **`warm_weights`** — if true, `ds4_engine_open` calls `model_warm_weights` (`ds4.c:1498`) to touch every page of the tensor data region after mmap. This eliminates the first-token latency spike at the cost of a startup delay.
- **`quality`** — if true, the GPU backend trades some throughput for precision. The default is false (fast path).
- **`power_percent`** — 1..100. A duty-cycle knob that throttles GPU work to manage thermals on MacBooks.

The five binaries each populate this struct from their own argv parsing.

---

## 5. The Boot Chain

This is the most hands-on part of the chapter. From a shell prompt to the first sampled token, control flows through six distinct stages for the CLI path. Other binaries diverge after stage 2, but stages 1-2 are identical.

### 5.1 Stage map

<svg viewBox="0 0 780 580" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4 CLI boot chain: six stages from shell to first sampled token">
<defs>
<marker id="ar12" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="390" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Boot chain: shell to first sampled token (six stages)</text>
<rect x="40" y="38" width="700" height="58" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.5" rx="6"/>
<text x="80" y="58" font-size="12" font-weight="700" fill="currentColor">1.</text>
<text x="160" y="58" font-size="12" font-weight="700" fill="currentColor">Process entry</text>
<text x="80" y="76" font-size="10" fill="#64748b">./ds4 -p "hello"</text>
<text x="320" y="58" font-size="10" fill="#64748b">dyld loads the statically-linked binary</text>
<text x="320" y="76" font-size="10" fill="#64748b">C runtime fills argv; control enters main</text>
<text x="700" y="82" text-anchor="end" font-size="10" fill="#94a3b8">ds4_cli.c:1571</text>
<line x1="390" y1="96" x2="390" y2="110" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar12)"/>
<rect x="40" y="110" width="700" height="58" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="80" y="130" font-size="12" font-weight="700" fill="#ea580c">2.</text>
<text x="160" y="130" font-size="12" font-weight="700" fill="#ea580c">argv -&gt; cli_config</text>
<text x="80" y="148" font-size="10" fill="#64748b">parse_options() walks flags linearly</text>
<text x="320" y="130" font-size="10" fill="#64748b">model_path, ctx_size, temperature, think_mode</text>
<text x="320" y="148" font-size="10" fill="#64748b">log_context_memory() prints KV footprint estimate</text>
<text x="700" y="154" text-anchor="end" font-size="10" fill="#94a3b8">ds4_cli.c:1409</text>
<line x1="390" y1="168" x2="390" y2="182" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar12)"/>
<rect x="40" y="182" width="700" height="140" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
<text x="80" y="202" font-size="12" font-weight="700" fill="#0d9488">3.</text>
<text x="160" y="202" font-size="12" font-weight="700" fill="#0d9488">ds4_engine_open() &mdash; load model</text>
<text x="60" y="222" font-size="10" fill="#64748b">a. ds4_acquire_instance_lock() &mdash; flock /tmp/ds4.lock (refuses second concurrent process)</text>
<text x="60" y="238" font-size="10" fill="#64748b">b. model_open() &mdash; mmap GGUF + parse_metadata + parse_tensors (no bytes copied)</text>
<text x="60" y="254" font-size="10" fill="#64748b">c. model_warm_weights() &mdash; optional page-prefetch (benchmarks only)</text>
<text x="60" y="270" font-size="10" fill="#64748b">d. vocab_load() + config_validate_model() &mdash; strict metadata equality</text>
<text x="60" y="286" font-size="10" fill="#64748b">e. weights_bind() &mdash; tensor name -&gt; pointer; weights_validate_layout()</text>
<text x="60" y="302" font-size="10" fill="#64748b">f. ds4_gpu_init() + ds4_gpu_set_model_map_range() (GPU only)</text>
<text x="700" y="318" text-anchor="end" font-size="10" fill="#94a3b8">ds4.c:17636</text>
<line x1="390" y1="322" x2="390" y2="336" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar12)"/>
<rect x="40" y="336" width="700" height="58" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="80" y="356" font-size="12" font-weight="700" fill="#7c3aed">4.</text>
<text x="160" y="356" font-size="12" font-weight="700" fill="#7c3aed">Dispatch</text>
<text x="80" y="374" font-size="10" fill="#64748b">run_generation() or run_repl()</text>
<text x="320" y="356" font-size="10" fill="#64748b">build_prompt() -&gt; ds4_tokens vector</text>
<text x="320" y="374" font-size="10" fill="#64748b">ds4_engine_generate_argmax() or ds4_session_sync() loop</text>
<text x="700" y="380" text-anchor="end" font-size="10" fill="#94a3b8">ds4_cli.c:902</text>
<line x1="390" y1="394" x2="390" y2="408" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar12)"/>
<rect x="40" y="408" width="700" height="110" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="80" y="428" font-size="12" font-weight="700" fill="#ea580c">5.</text>
<text x="160" y="428" font-size="12" font-weight="700" fill="#ea580c">generate_metal_graph_raw_swa() &mdash; prefill + decode loop</text>
<text x="60" y="448" font-size="10" fill="#64748b">a. metal_graph_alloc_raw_cap() &mdash; allocate one-shot GPU graph</text>
<text x="60" y="464" font-size="10" fill="#64748b">b. metal_graph_prefill_chunked() &mdash; prefill prompt in chunks bounded by prefill_cap</text>
<text x="60" y="480" font-size="10" fill="#64748b">c. for each new token: metal_graph_decode_one() -&gt; sample -&gt; emit_fn(token)</text>
<text x="60" y="496" font-size="10" fill="#64748b">d. stop on EOS or n_predict exhausted</text>
<text x="700" y="514" text-anchor="end" font-size="10" fill="#94a3b8">ds4.c:15786</text>
<line x1="390" y1="518" x2="390" y2="532" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar12)"/>
<rect x="40" y="532" width="700" height="42" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" rx="6"/>
<text x="80" y="552" font-size="12" font-weight="700" fill="#16a34a">6.</text>
<text x="160" y="552" font-size="12" font-weight="700" fill="#16a34a">ds4_engine_close() &mdash; shutdown</text>
<text x="320" y="552" font-size="10" fill="#64748b">free GPU graph + vocab; munmap; atexit releases the lock</text>
<text x="320" y="566" font-size="10" fill="#64748b">return code propagates from main</text>
</svg>
<span class="figure-caption">Figure R1.2 | The six-stage boot chain for `./ds4 -p "hello"`: process entry, argv parsing, engine open, dispatch, prefill+decode loop, shutdown. Other binaries diverge after stage 2.</span>

<details>
<summary>ASCII original</summary>

```
   ./ds4 -p "hello"                Stage 1: process entry
        |
        v
   ds4_cli.c:main()                Stage 2: argv -> cli_config
        |  parse_options()
        |  log_context_memory()
        |
        v
   ds4_engine_open()               Stage 3: load model
   ds4.c:17636
        |  ds4_acquire_instance_lock()
        |  model_open() -- mmap + parse_metadata + parse_tensors
        |  model_warm_weights() (optional)
        |  vocab_load()
        |  config_validate_model() -- strict metadata checks
        |  weights_bind() -- name -> pointer + weights_validate_layout
        |  ds4_gpu_init() + ds4_gpu_set_model_map_range() (GPU only)
        |
        v
   run_generation() or run_repl()  Stage 4: dispatch
        |  build_prompt() -> ds4_tokens
        |  ds4_engine_generate_argmax() or ds4_session_sync() loop
        |
        v
   generate_metal_graph_raw_swa()  Stage 5: prefill + decode loop
   ds4.c:15786
        |  metal_graph_alloc_raw_cap()  -- allocate GPU graph
        |  metal_graph_prefill_chunked() -- prefill prompt in chunks
        |  for each new token:
        |      metal_graph_decode_one()
        |      sample (argmax or top-k/top-p/min-p)
        |      emit_fn(token) -- back to CLI for printing
        |
        v
   ds4_engine_close()              Stage 6: shutdown
        |  munmap, free, release lock
```

</details>

### 5.2 Stage 1 — Process entry

When you type `./ds4 -p "hello"`, dyld brings up the process, the C runtime fills in argv, and execution enters `main` at `ds4_cli.c:1571`. There is no launcher script in front of this — the binary is statically linked against system libraries only. `Makefile:14` and `Makefile:18` show the link recipe is just `-lm -pthread` plus `-framework Foundation -framework Metal` on macOS.

### 5.3 Stage 2 — argv -> cli_config

`parse_options` (`ds4_cli.c:1409`) walks argv linearly, matching against a long list of flags. The defaults are spelled out at the top (`ds4_cli.c:1410-1428`):

```c
cli_config c = {
    .engine = {
        .model_path = "ds4flash.gguf",
        .backend = default_backend(),
        .mtp_draft_tokens = 1,
        .mtp_margin = 3.0f,
    },
    .gen = {
        .prompt = NULL,
        .system = "You are a helpful assistant",
        .n_predict = 50000,
        .ctx_size = 32768,
        .temperature = DS4_DEFAULT_TEMPERATURE,
        .top_p = DS4_DEFAULT_TOP_P,
        .min_p = DS4_DEFAULT_MIN_P,
        .dump_logprobs_top_k = 20,
        .think_mode = DS4_THINK_HIGH,
    },
};
```

Notable choices:

- `model_path = "ds4flash.gguf"` — the default looks for the file in the current working directory. `download_model.sh` makes this work by symlinking the selected quant to `./ds4flash.gguf`.
- `ctx_size = 32768` — a 32k window by default. The model itself supports up to 1M tokens, but a 1M-token KV cache would be enormous; the user opts in via `-c 1048576`.
- `think_mode = DS4_THINK_HIGH` — thinking is on by default. The user opts out with `--nothink`.

After `parse_options` returns, the CLI calls `log_context_memory` (`ds4_cli.c:1586`), which uses `ds4_context_memory_estimate` (`ds4.h:108`) to print the projected KV / scratch / compressed-cache footprint to stderr before allocation. This is the operator's last chance to abort with Ctrl-C before tens of GiB of memory get touched.

### 5.4 Stage 3 — `ds4_engine_open`

`ds4_engine_open` (`ds4.c:17636`) is the single entry point that owns every step of model bring-up. The function is sequential; reading it from top to bottom gives you the full load order.

**Step 3a — allocate and validate options.** Lines 17637-17660 fill in the engine struct, clamp `power_percent` and `mtp_draft_tokens`, copy the directional-steering filename, and set the global thread count.

**Step 3b — acquire instance lock.** Line 17661:

```c
ds4_acquire_instance_lock();
```

`ds4_acquire_instance_lock` (`ds4.c:16014-16056`) uses `flock()` on `/tmp/ds4.lock` (or `$DS4_LOCK_FILE`) to refuse a second concurrent ds4 process. The comment `AGENT.md:33` is unambiguous: "Do not run multiple huge model processes concurrently. The instance lock is intentional." The reason is memory: two 80 GiB mmap'ed processes will trash the page cache and trigger OS-level VM behaviour that is at best slow and at worst crashes the kernel on Darwin.

If the lock is held by someone else, the lock owner's PID is read from the file and printed (`ds4.c:16028-16036`), and the process exits with code 2.

**Step 3c — `model_open`.** Line 17664:

```c
const bool graph_backend = ds4_backend_uses_graph(opt->backend);
model_open(&e->model, opt->model_path, graph_backend, true);
```

`model_open` (`ds4.c:1217-1263`) is the GGUF mmap + parser. Chapter 03 details every step; for the boot chain, the relevant facts are:

- Metal/CUDA backends get a `MAP_SHARED` mapping so the kernel can hand the same physical pages to the GPU; the CPU backend gets `MAP_PRIVATE` to avoid a Darwin VM bug (`ds4.c:1241`).
- The header is validated (magic `GGUF`, version 3), the KV metadata table is indexed by offset, the tensor directory is parsed, and absolute file offsets are computed.
- No tensor bytes are read. The mmap is set up; the page cache will fill on first access.

**Step 3d — optional warm-up.** Line 17665:

```c
if (opt->warm_weights) model_warm_weights(&e->model);
```

`model_warm_weights` (`ds4.c:1498`) walks the tensor data region one page at a time, computing a volatile checksum to defeat dead-code elimination. The effect is to bring the file into the page cache before timing starts. This is useful for benchmarks; it is wasteful for interactive use because the conversation pattern will randomly fault pages anyway.

**Step 3e — `vocab_load`.** Line 17666 loads the tokenizer. The vocab is small (`DS4_N_VOCAB = 129280` entries) compared to the model, so this is fast.

**Step 3f — `config_validate_model`.** Line 17667:

```c
config_validate_model(&e->model);
```

`config_validate_model` (`ds4.c:2585-2667`) reads every architecture-relevant metadata key (`deepseek4.block_count`, `deepseek4.embedding_length`, `deepseek4.attention.head_count`, ...) and compares each against the compile-time constant. Any mismatch calls `exit(1)`. This is the safety net: a non-DeepSeek-V4-Flash GGUF, or a malformed one, dies here rather than producing garbage tokens. The same function also validates RoPE base, RoPE scaling factor, expert weight scale, and the per-layer compression-ratio array.

**Step 3g — `weights_bind`.** Line 17668:

```c
weights_bind(&e->weights, &e->model);
```

`weights_bind` (`ds4.c:2671-2729`) walks the GGUF tensor directory once, resolves each expected name (`token_embd.weight`, `blk.0.attn_q_a.weight`, ...) to a `ds4_tensor *`, and stores the pointer in `ds4_weights` / `ds4_layer_weights`. After this point the inference code never does a string lookup. The function ends with `weights_validate_layout(w)` (line 2728), which type- and shape-checks every bound tensor.

**Step 3h — optional MTP load.** Lines 17674-17681 repeat steps 3c-3g for the MTP draft model if `--mtp <path>` was passed.

**Step 3i — backend init.** Lines 17683-17745 initialise the GPU backend if `backend != CPU`. `ds4_gpu_init` brings up the Metal device or CUDA context; `ds4_gpu_set_model_map_range` registers the mmap'ed weight region with the backend so it can carve out non-copy MTLBuffers (Metal) or pinned/staged uploads (CUDA). On failure the engine is freed and `ds4_engine_open` returns 1.

When `ds4_engine_open` returns 0, every weight tensor is mapped into memory, every metadata key has been validated, every tensor pointer is resolved, and (on GPU backends) the device sees the mmap as a set of buffer views. The engine is ready to take a session.

### 5.5 Stage 4 — Dispatch

Control returns to `main` at `ds4_cli.c:1589`. The CLI inspects `cfg` and chooses a sub-path (`ds4_cli.c:1594-1610`):

- `cfg.inspect` → `ds4_engine_summary` and exit.
- `cfg.gen.imatrix_output_path` → `ds4_engine_collect_imatrix` (the imatrix calibration path used by GGUF quant tooling).
- `cfg.gen.perplexity_file_path` → `run_perplexity_file`.
- `cfg.gen.prompt == NULL` → `run_repl` (interactive linenoise loop).
- otherwise → `run_generation`.

For `run_generation` (`ds4_cli.c:902`), the path is:

1. `build_prompt` renders the system prompt + user prompt through `ds4_encode_chat_prompt` (`ds4.h:140-145`) into a `ds4_tokens` vector.
2. Depending on flags, dispatch to a diagnostic path (`metal_graph_test`, `head_test`, `first_token_test`, `dump_logits`, `dump_logprobs`) or to real generation.
3. Real generation goes through `ds4_engine_generate_argmax` (`ds4.h:111-117`, implemented at `ds4.c:17406`) for greedy decoding, or `run_sampled_generation` for temperature / top-p / min-p sampling.

### 5.6 Stage 5 — Prefill + decode

`ds4_engine_generate_argmax` (`ds4.c:17406-17448`) dispatches on backend:

```c
if (ds4_backend_uses_graph(e->backend)) {
    return generate_metal_graph_raw_swa(model, vocab, weights, prompt, ...);
}
return generate_raw_swa_cpu(model, vocab, weights, prompt, ...);
```

On Apple Silicon, `generate_metal_graph_raw_swa` (`ds4.c:15786`) is the production path. It:

1. Computes a `prefill_cap` and `raw_cap` from the prompt length and context size (`metal_graph_prefill_cap_for_prompt` at `ds4.c:14299`, `metal_graph_raw_cap_for_context` at `ds4.c:14263`).
2. Allocates a one-shot `ds4_gpu_graph` via `metal_graph_alloc_raw_cap` (`ds4.c:15819`).
3. Runs `metal_graph_prefill_chunked` (`ds4.c:14001`) over the prompt. If the prompt is longer than `prefill_cap`, it is processed in chunks; after each chunk the function reports progress via the user-supplied callback and writes finalized KV rows into the persistent compressed cache.
4. Enters the decode loop: for each new token, encode a layer-major Metal command buffer, sample the next token (argmax for `--temp 0`, otherwise from the sampling helpers), and call `emit_fn(token)`. The CLI's `print_generated_token` callback (`ds4_cli.c`) detokenizes and prints to stdout.
5. Stops on EOS or when `n_predict` runs out.

The interesting decision is the **chunked prefill**: rather than allocating room for an arbitrarily large prefill, ds4 caps each prefill batch at `prefill_cap` tokens (a few thousand, tuned to the GPU's command buffer and memory budget) and rolls the rest forward in chunks. The progress callback runs after every chunk so the CLI can print a progress bar; equally important, the KV write order matches what a cold prompt of the same length would produce, so a long mid-prefill chunk boundary is not a semantic divergence point.

### 5.7 Stage 6 — Shutdown

When generation finishes (EOS hit or n_predict exhausted), control returns up the stack. `ds4_engine_close` (`ds4.c`) tears down in reverse: the GPU graph is freed, the vocab is freed, the mmap is `munmap`'d, the lock file is released by the `atexit` handler installed in `ds4_acquire_instance_lock` (`ds4.c:16055`). The process exits with the return code propagated from `main`.

For `ds4-server`, stage 5 is replaced by a forever loop that calls `ds4_session_sync` + `ds4_session_eval` per request. Stage 6 happens on `SIGINT` / `SIGTERM`. The signal handlers installed at `ds4_server.c:11525-11531` set a stop flag; the main loop notices, drains in-flight requests, flushes any pending disk KV writes, and falls through to `ds4_engine_close`.

---

## 6. The Single-Engine, Single-Session Invariant

A practical consequence of the above design that surprises new readers:

**ds4-server holds exactly one `ds4_session`.** All HTTP requests are serialized through that one session. `README.md:299-301` confirms this is intentional.

The reason is simple: the GPU graph holds one set of KV tensors, one set of work buffers, one Metal command queue. Adding a second concurrent session would either double the memory footprint or require careful interleaving of attention reads/writes that the graph code is not designed to support. The throughput cost is the missed opportunity of batched decode across sessions; the simplicity payoff is enormous, and it lets `ds4_session_sync`'s prefix-reuse strategy do most of the work that a batched system would otherwise need.

If two clients send overlapping requests, the server processes them sequentially. The disk KV cache (Chapter 07) acts as a per-user persistence layer so this serialization does not lose context across sessions.

---

## 7. Build Topology and the GPU Abstraction

`ds4.c` includes `ds4_gpu.h` only when `DS4_NO_GPU` is undefined (`ds4.c:40-42`). `ds4_gpu.h` declares the cross-platform GPU API as plain C function signatures. Two implementations exist:

| Implementation | File | Toolchain | Selected when |
|----------------|------|-----------|---------------|
| Metal | `ds4_metal.m` | Objective-C / clang `-fobjc-arc` | `uname -s = Darwin` |
| CUDA | `ds4_cuda.cu` | NVCC `nvcc -O3` | `uname -s = Linux` |

The linker chooses one. `ds4.c` does not know which is in the binary because all GPU calls go through `ds4_gpu_*` function pointers declared in the header.

There is no runtime detection. An ARM Mac always uses Metal; a Linux box always uses CUDA (assuming the build target wanted CUDA). For Linux machines without CUDA, the only option is `make cpu`, which compiles every translation unit with `-DDS4_NO_GPU` to produce a CPU-only set of binaries.

`Makefile:84-95` exposes three CUDA build targets — `cuda-spark` (DGX Spark / GB10, no explicit `-arch`), `cuda-generic` (`-arch=native`), and `cuda CUDA_ARCH=<sm_NN>`. The default is `cuda-spark` because Spark is the primary CUDA target.

---

## 8. Reading the Boot Chain at the Code Level

If you want to trace the boot in your editor instead of reading prose, follow this table. Each row is one or two lines of code and a one-line action.

| Step | File:Line | What happens |
|------|-----------|--------------|
| 1 | `ds4_cli.c:1571` | `main(argc, argv)` |
| 2 | `ds4_cli.c:1572` | `parse_options(argc, argv)` returns `cli_config` |
| 3 | `ds4_cli.c:1586` | `log_context_memory()` prints expected KV footprint |
| 4 | `ds4_cli.c:1590` | `ds4_engine_open(&engine, &cfg.engine)` |
| 5 | `ds4.c:17661` | `ds4_acquire_instance_lock()` — `flock` on `/tmp/ds4.lock` |
| 6 | `ds4.c:17664` | `model_open()` — `open` + `fstat` + `mmap` + parse header |
| 7 | `ds4.c:1259-1260` | `parse_metadata()` + `parse_tensors()` |
| 8 | `ds4.c:17665` | `model_warm_weights()` — optional page-prefetch |
| 9 | `ds4.c:17666` | `vocab_load()` — read tokenizer |
| 10 | `ds4.c:17667` | `config_validate_model()` — strict metadata equality |
| 11 | `ds4.c:17668` | `weights_bind()` — tensor name -> pointer |
| 12 | `ds4.c:2728` | `weights_validate_layout()` — type/shape check |
| 13 | `ds4.c:17700-17723` | `ds4_gpu_init()` + `ds4_gpu_set_model_map_range()` (GPU only) |
| 14 | `ds4_cli.c:1607-1609` | dispatch to `run_repl` or `run_generation` |
| 15 | `ds4_cli.c:904` | `build_prompt()` — render chat tokens |
| 16 | `ds4_cli.c:967` | `ds4_engine_generate_argmax()` |
| 17 | `ds4.c:17427` | dispatch to `generate_metal_graph_raw_swa` |
| 18 | `ds4.c:15819` | `metal_graph_alloc_raw_cap()` |
| 19 | `ds4.c:15842` | `metal_graph_prefill_chunked()` — prefill prompt |
| 20 | inside | decode loop: encode + sample + `emit_fn(token)` |
| 21 | `ds4.c` | `ds4_engine_close` on exit; `atexit` releases the lock |

The line numbers will drift as the code changes; the structure will not.

---

## 9. A Worked Example: `./ds4 -p "Why is the sky blue?"`

To make the layers concrete, here is what happens for a one-line CLI invocation. Times are illustrative for an M3 Max 128 GB Mac.

1. **L1, ~0 ms.** dyld brings up the process. `main` runs. `parse_options` returns with `prompt = "Why is the sky blue?"`, `ctx_size = 32768`, `think_mode = HIGH`.
2. **L2, ~2 s.** `ds4_engine_open` runs the steps in section 5.4. mmap is instant; `parse_metadata` + `parse_tensors` walks the GGUF directory (~0.5 s on cold disk); `config_validate_model` + `weights_bind` are negligible; `ds4_gpu_init` + `ds4_gpu_set_model_map_range` register the mmap as a series of MTLBuffer views (~0.5 s); the first random page faults during initial GPU access account for the rest.
3. **L1 -> L2, ~1 ms.** `build_prompt` tokenizes `"Why is the sky blue?"` plus the default system prompt plus think-mode markers into a ~30-token `ds4_tokens` vector.
4. **L3, ~30 ms.** `generate_metal_graph_raw_swa` allocates the GPU graph and runs `metal_graph_prefill_chunked` over those 30 tokens. Since 30 < `prefill_cap`, it is a single chunk. The 43 layers execute on GPU.
5. **L4, per-token, ~10 ms each.** The decode loop runs `metal_graph_decode_one` per token. Each step pushes one row into the raw SWA cache, optionally finalizes a compressed row when the row count hits a layer's compress ratio, samples the next token (argmax since `--temp 0` by default), and calls `print_generated_token` which writes to stdout.
6. **Stop.** Generation ends on EOS or n_predict. `ds4_engine_close` munmaps and releases the lock. Process exits with 0.

The bulk of the time is in L2 (one-time, on engine open) and L4 (per-token, dominated by 256-expert top-6 MoE evaluation and the indexer scoring for ratio-4 layers). L1 and L3 contribute almost nothing.

---

## 10. Supporting Files and Why They Exist

`ds4.c` and the five entrypoint binaries are not the whole repo. A handful of auxiliary files contribute to specific binaries; reading them is useful when working on the corresponding feature.

### 10.1 `linenoise.c` / `linenoise.h`

Salvatore Sanfilippo's minimal line-editing library. ds4 links it into the CLI (`Makefile:48`) and the agent (`Makefile:60`) to provide tab completion, history, and arrow-key editing in interactive REPLs.

Why a separate library? Because writing a portable line editor with proper signal handling and history persistence is a non-trivial amount of code. Embedding linenoise (~3600 lines, no dependencies beyond libc) is much smaller than depending on GNU readline (which would also be GPL).

The CLI's `run_repl` (`ds4_cli.c:1240`) wires linenoise's `linenoise()` call to read user input, and `linenoiseHistoryAdd` / `linenoiseHistorySave` to persist `~/.ds4_history` (`ds4_cli.c:1009-1013`).

### 10.2 `rax.c` / `rax.h` / `rax_malloc.h`

Redis's Radix Tree, used exclusively by `ds4-server` (`Makefile:51`). The server uses it as a **bounded replay map**: when a client makes a tool call, the server assigns the tool a tool-id and stores the call's canonical DSML representation in the radix tree, keyed by the tool-id. On the next turn the client echoes back the tool-id and the server retrieves the original DSML to replay it byte-identical (preserving tokenization).

Why a radix tree rather than a hash map? Two reasons:

- The tool-id keys are short strings (UUID-like); radix trees handle this case efficiently and lookup is O(key length) without needing a hash.
- Bounded memory: the radix tree has a known upper bound (`s.tool_mem.max_entries` at `ds4_server.c:11559`); the server LRU-evicts when the bound is exceeded.

The radix tree is invisible to `ds4.c`; it lives entirely on the server side. This wiki covers it in Chapter 09.

### 10.3 `ds4_kvstore.c` / `ds4_kvstore.h`

The disk KV cache for `ds4-server` (`Makefile:51`) and `ds4-agent` (`Makefile:60`). Implements:

- File format for serialized session checkpoints (header, payload, validation).
- LRU eviction policy bounded by a configurable disk budget.
- Lookup by content hash (SHA-1 of the rendered chat text), not by token sequence, so different tokenizations of the same conversation can share a checkpoint (`README.md:599-605` describes the rationale).

The kvstore calls into the engine via `ds4_session_save_payload` and `ds4_session_load_payload` from `ds4.h:203-208`; the engine never knows the kvstore exists.

This is the wiring that makes `README.md:40`'s claim — "The KV cache is actually a first-class disk citizen" — concrete. Chapter 07 covers it.

### 10.4 `ds4_web.c` / `ds4_web.h`

A small HTTP client used only by `ds4-agent` (`Makefile:60`). It supports `GET` and `POST` over plain HTTP and HTTPS so the agent's web-fetch tool can grab documentation, API references, or test cases on demand. The web client is intentionally minimal — no cookies, no JavaScript, no redirects beyond N hops — to keep the agent's tool boundary clear.

### 10.5 `ds4_gpu.h`

The cross-platform GPU API declaration. Around 31 K of declarations: function prototypes for `ds4_gpu_init`, `ds4_gpu_set_model_map_range`, `ds4_gpu_begin_commands`, `ds4_gpu_end_commands`, plus the `ds4_gpu_tensor` type and a long list of per-kernel dispatch functions.

`ds4.c` includes this header only when `DS4_NO_GPU` is not defined. Both `ds4_metal.m` and `ds4_cuda.cu` implement the entire contract; the linker chooses one. This indirection is what lets `ds4.c` stay one file rather than three.

### 10.6 `ds4_iq2_tables_cuda.inc`

A static lookup-table data file included by `ds4_cuda.cu:1`. CUDA does not have a clean way to embed the IQ2_XXS dequantization codebook tables (256 entries of 8 bytes each) inside an Objective-C-like compilation unit; the `.inc` file is `#include`'d into the `.cu` translation unit. The same tables are computed inline in `ds4.c` for the CPU and Metal paths.

### 10.7 The metal kernels

The 19 files under `metal/*.metal` are GPU kernel source written in Apple's Metal Shading Language. They are compiled at build time (Metal AIR libraries) and linked into the Metal binary blob loaded by `ds4_metal.m`. Each file groups related kernels:

| File | Kernels |
|------|---------|
| `metal/dsv4_hc.metal` | HC pre / post / Sinkhorn split |
| `metal/dsv4_kv.metal` | KV push, compressor apply, indexer scoring |
| `metal/dsv4_rope.metal` | Tail-only RoPE rotation (per-layer base+scale) |
| `metal/dsv4_misc.metal` | Layer-specific glue |
| `metal/flash_attn.metal` | Sink-aware attention kernel |
| `metal/moe.metal` | Routed expert dispatch |
| `metal/glu.metal` | SwiGLU activation |
| `metal/dense.metal` | Q8_0 matvec |
| `metal/norm.metal` | RMSNorm |
| `metal/softmax.metal` | Numerically stable softmax |
| `metal/argsort.metal` | Top-k for sampling |
| Others | `bin.metal`, `concat.metal`, `cpy.metal`, `get_rows.metal`, `repeat.metal`, `set_rows.metal`, `sum_rows.metal`, `unary.metal` |

The shaders are parameterised on values like `n_hc`, `n_tokens`, `head_dim`; the C side always passes the values that match `DS4_N_*` constants. Chapter 10 covers the GPU layer.

---

## 11. Two More Worked Examples

### 11.1 `ds4-server` request handling

For a single OpenAI-format chat completion sent to `ds4-server`:

1. **L1 inbound.** The server's libmicrohttpd-style accept loop dequeues the connection. `parse_openai_chat_request` reads the JSON body, extracts `messages`, `temperature`, `max_tokens`, `stream`, and any `tools`. It renders the conversation through `ds4_encode_chat_prompt` (`ds4.h:140-145`) into a `ds4_tokens` vector.
2. **L1 -> L2.** The server consults its tool-replay map (rax-tree) to substitute any prior tool-call IDs with their stored canonical DSML, then re-tokenizes the resulting prompt text.
3. **L2.** The server holds the single `ds4_session` mutex, then calls `ds4_session_sync` (`ds4.c:17924`). Three outcomes are possible:
   - The live in-RAM checkpoint is already a prefix of the prompt → only evaluate the suffix. Fast.
   - The live checkpoint is *not* a prefix, but the disk KV cache holds a matching SHA-1 hash → restore the snapshot via `ds4_session_load_payload`, then evaluate the suffix.
   - Neither → full prefill from token 0.
4. **L3-L4.** Prefill (chunked if `prompt.len > prefill_cap`) populates the KV cache. The decode loop generates tokens, samples per the request's temperature/top-p/min-p, and detects tool-call markers in the output stream. Tool-call detection happens at the token level (the model emits specific tokens that bracket a tool call).
5. **L1 outbound.** Each token is appended to the SSE stream sent back to the client. On EOS or after `max_tokens`, the server flushes the final SSE event and (according to policy) saves the post-turn state to the disk KV cache via `ds4_session_save_payload`.
6. **Lock release.** The session mutex is released. The next pending request can take it.

The server's design serializes everything through one session by design. This is the trade-off for keeping the engine simple and the disk KV cache the source of inter-session sharing.

### 11.2 `ds4-bench` measurement

`ds4-bench` is the simplest of the five binaries. Its job is to produce a CSV row with prefill and decode throughput at a chosen context length. The `main()` skeleton at `ds4_bench.c:395-433`:

```c
int main(int argc, char **argv) {
    bench_config cfg = parse_options(argc, argv);
    log_context_memory(cfg.backend, cfg.ctx_alloc);

    ds4_engine_options opt = {
        .model_path = cfg.model_path,
        .backend = cfg.backend,
        .n_threads = cfg.threads,
        .power_percent = cfg.power_percent,
        .warm_weights = cfg.warm_weights,
        .quality = cfg.quality,
    };
    ds4_engine *engine = NULL;
    if (ds4_engine_open(&engine, &opt) != 0) return 1;
    /* ... read prompt file, tokenize, allocate session, prefill, time decode ... */
}
```

The relevant difference from the CLI is `warm_weights = true` (set from the `--warm` flag). Bench wants timings to start steady, so it pays the page-walk cost up front. The bench output is a CSV row with `model, backend, context, prefill_tokens_per_sec, decode_tokens_per_sec, peak_rss`; the project's `speed-bench/` directory collects these into a long-running performance log.

---

## 12. The Session-Sync Trick

Before closing this chapter, the most architecturally interesting decision in ds4 deserves its own section. The `ds4_session_sync` design (declared at `ds4.h:175` and implemented at `ds4.c:17924`) is the reason `ds4-server` and `ds4-agent` can both be stateless at the protocol layer and stateful at the engine layer.

The basic shape of `ds4_session_sync`:

```c
/* Bring the live backend state to exactly the supplied token prefix.
 *
 * ds4-server and the REPL are stateless at the text/API layer but stateful here:
 * they resend or rebuild the full transcript, and this function decides whether
 * the live checkpoint is a prefix.  A matching prefix is extended in one of two
 * ways:
 *
 *   - long suffix: batched layer-major prefill, aligned to absolute chunk
 *     boundaries so compressor/indexer rows finalize in the same order as a
 *     cold prompt;
 *   - short suffix: ordinary one-token decode, which is faster below the
 *     measured crossover and preserves exact autoregressive semantics.
 *
 * A non-matching prompt discards the checkpoint and prefills from token zero.
 */
int ds4_session_sync(ds4_session *s, const ds4_tokens *prompt, char *err, size_t errlen);
```

The caller's contract is: "Here is the full prompt token vector. Make the session's internal state exactly reflect having processed this prompt, and use whatever shortcuts you can." The engine inspects its current checkpoint, decides among three paths (extend, full prefill, or — when paired with disk KV — restore-and-extend), and updates the session accordingly.

Why this design wins:

- **Protocol simplicity.** The HTTP API does not need a "continue conversation" endpoint with session cookies. Every request sends the full conversation; the engine optimises away the redundancy.
- **No drift between client and server.** If the client and server disagree about session state — which is the source of nearly every conversation-engine bug — the resync is trivial: the client sends what it thinks the conversation is, and the engine just complies.
- **Multiple frontends, one engine.** `ds4-cli`'s REPL, `ds4-server`'s API endpoints, and `ds4-agent`'s tool-call loops all use the same `ds4_session_sync` contract. The engine has one mode; the frontends have many.
- **Disk KV becomes trivial to wire.** Once the engine can extend or rebuild from arbitrary checkpoints, "load a checkpoint from disk and continue" is just `ds4_session_load_payload` + `ds4_session_sync`. The disk KV doesn't need to model conversation history; it just persists snapshots.

The cost is that the engine has to maintain the checkpoint vector (`s->checkpoint`, a `token_vec` in `ds4.c:16065`) and keep it in sync with the actual KV cache contents. The checkpoint tracks exactly what tokens have been pushed into the KV; `ds4_tokens_starts_with` (`ds4.h:135`) is what lets the engine decide if a prompt extends the checkpoint or invalidates it.

The two extension paths — chunked layer-major prefill for long suffixes vs. one-at-a-time decode for short ones — are a per-call choice. The crossover point is measured against `prefill_cap` and small-batch thresholds; the goal is to use the fastest path for each suffix length without changing the resulting state.

---

## 13. Summary Card

- **ds4 is a model-specific engine.** It accepts only DeepSeek V4 Flash GGUFs that match the shape constants in `ds4.c:87-116`. Generic GGUFs will fail `config_validate_model`.
- **Five binaries, one library.** `ds4`, `ds4-server`, `ds4-agent`, `ds4-bench`, `ds4-eval` all link the same `ds4.o` / `ds4_metal.o` (or `ds4_cuda.o`) and use only `ds4.h`. Application logic never sees a tensor.
- **Four layers** flow top-down: entrypoint → engine + session → model forward → backend.
- **One mmap, one process.** A single `mmap()` covers the whole GGUF for the life of the engine; the instance lock at `/tmp/ds4.lock` enforces one ds4 process per host.
- **Stage order**: argv → `ds4_engine_open` → `ds4_session_create` → prompt token render → `ds4_session_sync` (or `ds4_engine_generate_argmax`) → decode loop → emit → `ds4_engine_close`.
- **CPU is reference, GPU is production.** Compile with `-DDS4_NO_GPU` for CPU-only; otherwise Metal on macOS and CUDA on Linux.
- **Single session in the server.** `ds4-server` has one `ds4_session` and serializes requests; per-user state persists through the disk KV cache.

If you remember just one diagram, make it the four-layer one in section 3.1. The rest of this wiki is structured around it.

A practical reading order for a first pass:

1. Finish this chapter, then read Chapter 02 (model architecture) — every later chapter assumes the model's specific shape and the rationale for it.
2. Read Chapter 03 (GGUF loading) next — it explains the mmap discipline that the entire engine relies on.
3. Walk the trace tour end-to-end. It follows a single CLI prompt through every layer.
4. Open the reference chapters in the order you actually care about — Chapter 06 (engine and session) for working on `ds4-server`; Chapter 11 (MoE) for working on quantization; Chapter 10 (Metal/CUDA) for working on kernels.

Welcome to the codebase.
