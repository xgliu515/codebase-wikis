# Tour Step 00: Overview

Code version locked to `antirez/ds4@f91c12b` (main, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## Why a narrative trace?

The 15 reference chapters in this wiki cover DwarfStar 4 in **breadth**: GGUF loading, the fixed model architecture, quantization formats, the tokenizer, the engine/session boundary, the KV cache, attention and MoE, the Metal and CUDA backends, the HTTP server, disk persistence — subsystem by subsystem, design choice by design choice. That is the right shape for the second pass, when you already know which subsystem you want to deepen. It is the wrong shape for the first pass. On a first read you do not yet know what `ds4_engine` holds, why `ds4_session` is a separate object, where a token becomes a Metal buffer, or what a "ratio-4 compressed layer" actually is. You need a thread to pull, not a map of every room.

This narrative trace is that thread. It picks one tiny, real request — typing `./ds4 -m DS4.gguf -p "hello" -n 3` and getting three tokens of output — and walks it end-to-end through the entire stack. From `int main()` in `ds4_cli.c` to the final detokenized bytes printed on stdout, every step appears, in order, with the actual `file:line` references at commit f91c12b. Nothing skipped, nothing reordered.

The pedagogical bet is that **one dimensional thread, fully traced, teaches the system better than fifteen subsystem chapters read cold**. After this tour you will know the shape of the river. After the reference chapters you will know the depth of each pool. Read the tour first.

A related claim: tracing one *real* command beats tracing a toy or composed-up example, because every line of code the trace touches is code that runs in production for every other invocation. Nothing in this trace is hypothetical. The same `parse_options` runs for every CLI call. The same `model_open` mmap path runs whether you give it a 25 GiB DeepSeek-V4-Flash or a 7 B test model. The same prefill kernels execute whether the prompt is `"hello"` or a 10 000-token document. Coverage of the spine is therefore real coverage of the architecture, not coverage of a contrived path that exists only in the wiki.

## The chosen trace target

The single command we trace, in plain words:

> A user has built ds4 on a MacBook (Apple Silicon, Metal-capable build). The model file `DS4.gguf` — the DeepSeek-V4-Flash weight pack, around 24 GiB — sits next to the binary. The user types
>
> ```
> ./ds4 -m DS4.gguf -p "hello" -n 3
> ```
>
> and presses Enter. ds4 opens the model, loads the tokenizer, renders `"hello"` into the DeepSeek-V4 Flash chat template (system + user message + assistant prefix), evaluates that prompt through the full 43-layer network, and then greedily emits 3 generated tokens to stdout. The process exits cleanly.

We deliberately keep the example minimum-viable. Everything else stays out of scope:

- **No thinking mode in the prompt rendering**. The trace assumes the small prompt + `-n 3` does not produce a `<think>` block worth tracing. We point at `--think` and `--think-max` only in branch sections.
- **No tool calls**. The CLI binary `./ds4` does not contain the agent's tool-use loop; that lives in `ds4_agent.c`. The trace never enters it.
- **No server, no HTTP**. The CLI path is `int main()` in `ds4_cli.c` → `run_generation()`. The 500 000-line `ds4_server.c` is irrelevant to this trace.
- **No chunked prefill**. The string `"hello"` tokenizes to a single-digit number of tokens, which fits in one prefill micro-batch. We never exercise the chunk loop.
- **No multi-turn**. One prompt, one generation, exit. No REPL, no follow-up turn, no session re-use.
- **No disk KV cache hit**. Cold start, empty session. The full prompt walks every layer once.
- **No speculative decoding / MTP**. `--mtp` is not given; the draft model is not loaded.
- **No CUDA path**. Metal only. CUDA differences are mentioned in branches; their code is `#ifdef`-fenced and does not execute in this trace.

These omissions are intentional. They turn a 50-step labyrinth into a 17-step spine. The spine teaches the architecture; the omitted branches are pointed at in each step's section 7, so you know where to look once you want depth.

One more honest framing point: this trace is not a benchmark or a worst-case. It is the *cleanest possible* end-to-end run. The interesting design decisions ds4 makes appear even on this path — the explicit-default config struct, the mmap-with-distinct-flags-per-backend strategy, the bind-then-validate-then-run discipline, the layer-major prefill loop, the ratio-4 compressed-layer indexer, the HC (hyper-connection) multi-stream, the Q8_0/IQ2_XXS quant zoo, the engine vs session boundary, the layer-by-layer compute graph. Each of those would be just as visible on a more complex request, plus extra branches. Reading those branches first would hide the spine; reading the spine first makes them legible.

## The 8-section template

Steps 01 through 17 every use the same eight-section structure. The structure is not cosmetic — it forces each step to build tension before resolution, so you learn **why** ds4 is shaped the way it is, not just **what** the code looks like.

1. **Current situation** — what the system holds in its hands at the end of the previous step.
2. **The problem** — the one question this step must answer, stated in a sentence.
3. **Naive approach** — what a competent engineer who had never read this code would try first.
4. **Why the naive approach breaks** — the specific failure modes, in concrete terms, that force a better design.
5. **ds4's approach** — the actual solution. Always opens with "ds4's approach is to...".
6. **Code locations** — a compact bulleted list of the most important `file:line` references for this step.
7. **Branches and extensions** — the paths we did not take here, with cross-links into reference chapters. This is the knowledge net.
8. **What you should now have in your head** — three to five concrete takeaways. If you cannot restate them, the step did not land.

Sections 2, 4, and 5 are the load-bearing trio. Section 6 is the index for verification against source. Section 8 is the self-check.

Why this template, and not just "narrative"? Because pure narrative makes it too easy to nod along without absorbing. Forcing each step to articulate the problem before the solution, and to name the naive design that breaks before showing the real one, produces a sequence of small "oh, *that* is why" moments. Those moments are what make the design choices stick. By the end of 17 steps you should be able to predict roughly how ds4 would handle a feature you have not yet read about — because the same problem-then-solution structure recurs at every layer.

The "naive approach" section is not a strawman. It is what a competent C engineer who had read no ds4 source would draft on a whiteboard. Reading what is wrong with it is half the lesson.

## 17-step preview

| Step | Title | Key code | Output state after this step |
|------|-------|----------|------------------------------|
| 01 | CLI parsing & backend selection | `ds4_cli.c:1409` `parse_options`, `ds4_cli.c:246` `default_backend` | `cli_config` filled with model path, backend (Metal on Apple), `n_predict=3`, defaults populated |
| 02 | Open & mmap the GGUF file | `ds4.c:1217` `model_open`, `ds4.c:1134` `parse_metadata`, `ds4.c:1164` `parse_tensors` | File mmap'd `MAP_SHARED`, metadata index built, tensor directory walked with absolute offsets |
| 03 | Validate tensors & bind layer layout | `ds4.c:2585` `config_validate_model`, `ds4.c:2671` `weights_bind`, `ds4.c:2378` `weights_validate_layout` | Every 43-layer weight slot points into the mmap; all DS4-V4-Flash invariants checked |
| 04 | Load the tokenizer | `vocab_load` (called at `ds4.c:17666`) | Vocabulary, BPE merges, special tokens loaded into `ds4_vocab` |
| 05 | Create the engine and graph state | `ds4_engine_open` (`ds4.c:17636`), Metal init at `ds4.c:17700` | `ds4_engine` complete: backend ready, model bound, graph buffers allocated |
| 06 | Render the chat prompt into tokens | `ds4_encode_chat_prompt`, `build_prompt` (`ds4_cli.c:902` calls into it) | `ds4_tokens prompt[]` holds BOS + system + `"hello"` + assistant prefix |
| 07 | Create the session and sync | `ds4_session_create`, `ds4_session_sync` | `ds4_session` allocated with empty KV; sync decides "full prefill" |
| 08 | Prefill setup | Prefill chunk sizing, HC stream seeding | Prefill chunk size chosen; HC streams initialized from token embeddings |
| 09 | Layer-major prefill | Layer loop in the prefill graph | All prompt tokens processed through layers 0..42 in lockstep; KV rows filled |
| 10 | One attention sublayer | Attention compute in the layer graph | Per-layer attention output mixed into the HC streams |
| 11 | One FFN + MoE sublayer | Router + IQ2 expert kernels + shared expert | Per-layer FFN output mixed into the HC streams |
| 12 | Ratio-4 layer compressor & indexer | Compressor + indexer for ratio-4 layers | Compressed KV rows + indexer-selected attention rows ready |
| 13 | Prefill-tail logits head | HC collapse + RMSNorm + Q8_0 vocab projection | `logits[]` over 129 280 vocab entries for the last prompt token |
| 14 | Sample the first token | Argmax / min-p sample on the last logits | First generated `token_0` chosen; `session.pos` advances |
| 15 | One decode step | `ds4_session_eval` single-token graph | KV cache appended with one row; logits for the next token ready |
| 16 | Decode loop to n=3 | Loop body in `run_argmax_generation` / `run_sampled_generation` | Three tokens produced (or EOS encountered earlier) |
| 17 | Detokenize, output & cleanup | `ds4_token_text`, `ds4_session_free`, `ds4_engine_close` | Bytes printed to stdout; all resources released; `main` returns 0 |

A quick way to read the table: the first column is your linear position, the second is the action of the step, the third is where to look in source if the description is not enough, and the fourth is the state object the step produces. If you find yourself wondering "wait, where did the `ds4_session` come from?", jump to its first appearance — step 07 — and the prior steps will not have hidden it from you, because it does not exist before step 07.

<svg viewBox="0 0 880 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4 trace tour 17 steps grouped by phase">
  <defs>
    <marker id="t0arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">The 17-step trace, grouped by request lifecycle phase</text>
  <rect x="30" y="48" width="820" height="62" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="48" y="70" font-size="12" font-weight="700" fill="#ea580c">Phase A: Initialization (once-per-process)</text>
  <text x="48" y="92" font-size="11" fill="#64748b">CLI parse, mmap GGUF, validate &amp; bind, load tokenizer, build engine</text>
  <g font-size="11" fill="currentColor"><circle cx="620" cy="78" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="620" y="82" text-anchor="middle" font-weight="600">01</text><circle cx="655" cy="78" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="655" y="82" text-anchor="middle" font-weight="600">02</text><circle cx="690" cy="78" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="690" y="82" text-anchor="middle" font-weight="600">03</text><circle cx="725" cy="78" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="725" y="82" text-anchor="middle" font-weight="600">04</text><circle cx="760" cy="78" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="760" y="82" text-anchor="middle" font-weight="600">05</text></g>
  <rect x="30" y="128" width="820" height="62" rx="8" fill="#fdba74" stroke="#f97316" stroke-width="1.2"/>
  <text x="48" y="150" font-size="12" font-weight="700" fill="#9a3412">Phase B: Request setup</text>
  <text x="48" y="172" font-size="11" fill="#64748b">tokenize chat prompt, create session, choose sync strategy</text>
  <g font-size="11" fill="currentColor"><circle cx="725" cy="158" r="14" fill="#fff" stroke="#f97316" stroke-width="1.2"/><text x="725" y="162" text-anchor="middle" font-weight="600">06</text><circle cx="760" cy="158" r="14" fill="#fff" stroke="#f97316" stroke-width="1.2"/><text x="760" y="162" text-anchor="middle" font-weight="600">07</text></g>
  <rect x="30" y="208" width="820" height="62" rx="8" fill="#fb923c" stroke="#ea580c" stroke-width="1.2"/>
  <text x="48" y="230" font-size="12" font-weight="700" fill="#ffffff">Phase C: Prefill (compute prompt KV in one big sweep)</text>
  <text x="48" y="252" font-size="11" fill="#fef3c7">layer-major loop: attention + FFN/MoE + compressor &amp; indexer per layer</text>
  <g font-size="11" fill="currentColor"><circle cx="620" cy="238" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="620" y="242" text-anchor="middle" font-weight="600">08</text><circle cx="655" cy="238" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="655" y="242" text-anchor="middle" font-weight="600">09</text><circle cx="690" cy="238" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="690" y="242" text-anchor="middle" font-weight="600">10</text><circle cx="725" cy="238" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="725" y="242" text-anchor="middle" font-weight="600">11</text><circle cx="760" cy="238" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="760" y="242" text-anchor="middle" font-weight="600">12</text></g>
  <rect x="30" y="288" width="820" height="62" rx="8" fill="#c2410c" stroke="#9a3412" stroke-width="1.2"/>
  <text x="48" y="310" font-size="12" font-weight="700" fill="#ffffff">Phase D: Output (logits head, sample, decode loop)</text>
  <text x="48" y="332" font-size="11" fill="#fed7aa">final-token head, first sample, then decode + sample × n</text>
  <g font-size="11" fill="currentColor"><circle cx="620" cy="318" r="14" fill="#fff" stroke="#c2410c" stroke-width="1.2"/><text x="620" y="322" text-anchor="middle" font-weight="600">13</text><circle cx="655" cy="318" r="14" fill="#fff" stroke="#c2410c" stroke-width="1.2"/><text x="655" y="322" text-anchor="middle" font-weight="600">14</text><circle cx="690" cy="318" r="14" fill="#fff" stroke="#c2410c" stroke-width="1.2"/><text x="690" y="322" text-anchor="middle" font-weight="600">15</text><circle cx="725" cy="318" r="14" fill="#fff" stroke="#c2410c" stroke-width="1.2"/><text x="725" y="322" text-anchor="middle" font-weight="600">16</text><circle cx="790" cy="318" r="14" fill="#fff" stroke="#c2410c" stroke-width="1.2"/><text x="790" y="322" text-anchor="middle" font-weight="600">17</text></g>
  <text x="30" y="384" font-size="11" font-style="italic" fill="#64748b">Reading order: 01 → 17 (initialization once, then setup, then a single prefill sweep, then decode-and-sample three times).</text>
</svg>
<span class="figure-caption">Figure T0.1 | The 17 trace steps mapped onto the four phases of one CLI invocation.</span>

<details>
<summary>ASCII original</summary>

```
Phase A Initialization      01 02 03 04 05 .................
Phase B Request setup       ............... 06 07 ..........
Phase C Prefill             ................... 08 09 10 11 12
Phase D Output              .............................. 13 14 15 16 17
                            time --------->
```

</details>

## State variables across the 17 steps

This is the map you should keep open in a second window while reading the steps. Each row is one step; each column is a state variable that lives some span of the trace. A `·` means unchanged from the row above. The earliest cell where a variable becomes meaningful is where it is born.

| Step | cli_config | mmap'd model | weights bound | tokenizer | engine | tokens[] | session | kv_filled_to | logits[] | last_token | tokens_emitted |
|------|------------|--------------|---------------|-----------|--------|----------|---------|--------------|----------|------------|---------------|
| 01   | filled     | —            | —             | —         | —      | —        | —       | —            | —        | —          | 0 |
| 02   | ·          | mmap'd       | —             | —         | —      | —        | —       | —            | —        | —          | 0 |
| 03   | ·          | ·            | bound+validated| —        | —      | —        | —       | —            | —        | —          | 0 |
| 04   | ·          | ·            | ·             | loaded    | —      | —        | —       | —            | —        | —          | 0 |
| 05   | ·          | ·            | ·             | ·         | open   | —        | —       | —            | —        | —          | 0 |
| 06   | ·          | ·            | ·             | ·         | ·      | rendered | —       | —            | —        | —          | 0 |
| 07   | ·          | ·            | ·             | ·         | ·      | ·        | created | 0            | —        | —          | 0 |
| 08   | ·          | ·            | ·             | ·         | ·      | ·        | ·       | 0            | —        | —          | 0 |
| 09   | ·          | ·            | ·             | ·         | ·      | ·        | ·       | n_prompt-1   | —        | —          | 0 |
| 10   | ·          | ·            | ·             | ·         | ·      | ·        | ·       | (mid-layer)  | —        | —          | 0 |
| 11   | ·          | ·            | ·             | ·         | ·      | ·        | ·       | (mid-layer)  | —        | —          | 0 |
| 12   | ·          | ·            | ·             | ·         | ·      | ·        | ·       | (mid-layer)  | —        | —          | 0 |
| 13   | ·          | ·            | ·             | ·         | ·      | ·        | ·       | n_prompt     | filled   | —          | 0 |
| 14   | ·          | ·            | ·             | ·         | ·      | appended | ·       | n_prompt     | ·        | t0         | 0 |
| 15   | ·          | ·            | ·             | ·         | ·      | ·        | ·       | n_prompt+1   | refreshed| ·          | 1 |
| 16   | ·          | ·            | ·             | ·         | ·      | appended ×2 | ·    | n_prompt+3   | refreshed| t2         | 3 |
| 17   | discarded  | munmap'd     | ·             | freed     | closed | freed    | freed   | —            | —        | —          | 3 emitted |

Read it horizontally to track one object's life: `ds4_session` is born in step 07, holds the live KV through steps 08-16, and is freed in step 17 — a ten-step lifespan covering the entire compute half of the trace. Read it vertically to see what holds state at any moment: at step 13 we hold a parsed `cli_config`, an mmap'd model, bound weights, a tokenizer, an open engine, the prompt tokens, the session with full prompt KV filled, and the first set of logits — and nothing about the generated text exists yet.

The point of the table is not to memorize it. It is a cheap lookup whenever you lose the thread. If a step talks about a variable and you cannot place when it appeared, the table tells you. If you want to know what objects exist at the moment the very first generated token is decided, scan row 14. If you want to know the half-life of the tokenizer (born step 04, freed step 17), scan its column.

A subtle but important property of the table: the variables move in waves. Steps 01-05 are dominated by *loading state* (config, mmap, weights, tokenizer, engine). Steps 06-09 introduce *request state* (tokens, session, KV). Steps 13-16 introduce *output state* (logits, generated token, emit counter). Step 17 collapses everything. These waves match the four-phase lifecycle from Figure T0.1.

## A note on the engine vs session boundary

One concept worth flagging up front, because steps 05/07 lean on it: ds4 splits the runtime into two C types:

- `ds4_engine` — the **loaded model**. It owns the mmap'd GGUF, the bound weight pointers, the tokenizer, and the backend's graph compile state. It is read-only with respect to inference. One engine can be shared across many inference timelines.
- `ds4_session` — **one mutable inference timeline**. It owns the live KV cache and the logits buffer, knows the current position `pos`, and is what you sync to a prompt or step forward one token. Multiple sessions can coexist against one engine.

This split is visible in the public header `ds4.h:96-99`. It is also why step 05 (engine) and step 07 (session) are different steps. The CLI builds exactly one session, but in the server path the same engine serves many sessions concurrently — and the trace structure mirrors that future generalization even though we do not exercise it here.

## Conventions and vocabulary used throughout the trace

A few terms appear repeatedly across the 17 steps. Defining them once here avoids re-explaining at every site:

- **GGUF.** The file format ds4 reads: a small header, a typed key-value metadata table, a tensor directory, and a long aligned tensor data section. The same format is shared with llama.cpp and several other engines. ds4 supports GGUF version 3 only (`ds4.c:1257`).
- **Quant types.** `F32`/`F16` are floating-point storage; `Q8_0` is 8-bit symmetric quantization with one scale per 32-element block; `Q2_K`, `Q4_K` are K-quants — block-structured 2/4-bit with super-block scales (`ds4.c:139-162`). `IQ2_XXS` is an exotic 2.06-bit quant using a code-book of 256 8-element patterns. The quant-block C structs are at `ds4.c:139-168`.
- **HC stream.** A "hyperconnection" stream. DS4 Flash maintains four parallel residual streams (`DS4_N_HC = 4`) that mix into and out of every sublayer. Each layer has `hc_attn_*` and `hc_ffn_*` mixing matrices that gate the contribution of each stream.
- **Sublayer.** One of the two sub-blocks inside a transformer layer: the attention sublayer or the FFN sublayer. Each sublayer reads from the HC streams, computes its operation, and writes back into the HC streams.
- **Compressed layer.** A layer where `ds4_layer_compress_ratio(il) != 0`. Such layers maintain compressed KV rows in addition to or instead of raw KV rows. Ratio-4 layers compress every 4 raw rows into one compressed row; ratio-128 compress every 128.
- **Indexer.** A small attention computed at ratio-4 layers that scores compressed rows and selects the top `DS4_N_INDEXER_TOP_K = 512` rows to attend to. It is a per-token learned selector, not a heuristic.
- **Prefill vs decode.** Prefill is the first pass: many prompt tokens evaluated together to fill the KV cache. Decode is the subsequent per-token passes that emit one new token each. The graphs are different; step 09 (prefill) and step 15 (decode) trace each separately.
- **`ubatch` / micro-batch.** A unit of work inside prefill: a contiguous chunk of prompt tokens processed together by the compute graph. For our `"hello"` prompt the whole prefill is one ubatch; longer prompts get chopped into multiple ubatches.
- **Token-major vs layer-major.** A computation that processes one token through all layers before starting the next is token-major; one that processes all (current-batch) tokens through layer 0 before any starts layer 1 is layer-major. ds4 prefill is layer-major. Step 09 explains why.

Most of these terms also appear in the [glossary chapter](./15-glossary-and-faq.md), which you can browse independently.

## DS4 Flash architecture in one paragraph

To follow the deeper steps (08-13) it helps to know what DeepSeek-V4-Flash actually is in shape, even at a sketch level. The numerical invariants are all in `ds4.c:87-116`:

- **43 transformer layers**. Layer 0 and 1 are dense (no compression); from layer 2 onward, even-index layers use ratio-4 compressed attention with an indexer head, and odd-index layers use ratio-128 compression. Both even and odd compressed layers share the basic compressor pipeline; only the ratio-4 layers carry an indexer.
- **4096 model dim, 64 attention heads × 512 head dim, 1 KV head**. The attention block uses a low-rank Q decomposition (Q8_0 quantized) with a 1024-rank LoRA factorization (`DS4_N_LORA_Q = 1024`). The output projection is similarly factorized (`DS4_N_OUT_GROUP = 8`).
- **256 routed experts, 6 active per token, 1 shared expert per layer**. Routed experts use IQ2_XXS / Q2_K / Q4_K quants; the shared expert is Q8_0. Expert FFN width is `DS4_N_FF_EXP = 2048`. The first three layers use hash-table routing (`DS4_N_HASH_LAYER = 3`); from layer 3 onward, a learned router with a bias term picks the top-k.
- **4 hyperconnection streams** with 20 Sinkhorn iterations during routing. The HC machinery replaces a single residual stream with four parallel streams that mix into and out of each sublayer.
- **128-window SWA + ratio-4 compressed memory + indexer top-512**. The attention "sees" a 128-token sliding window of raw KV plus a much larger horizon of compressed rows; the indexer selects up to 512 compressed rows to attend to per token at ratio-4 layers.
- **129 280-token vocabulary**, 64-dim RoPE on the last 64 dims of Q/K only (the rest are NoPE), YaRN scaling.

You do not need to memorize this. Steps 03 (validate), 10 (attention), 11 (FFN/MoE), and 12 (compressor + indexer) re-introduce each shape as it becomes relevant. The trace is the assembly; this paragraph is the parts list.

## Cross-reference table: tour step → reference chapter

The reference chapters cover everything in breadth; the tour steps cover one path in depth. The links below show which chapter to open after each step if you want more depth on a topic the step only sketched.

| Step | Primary reference chapter(s) |
|------|-------------------------------|
| 01   | [01-architecture-overview.md](./01-architecture-overview.md) |
| 02   | [03-gguf-loading.md](./03-gguf-loading.md), [10-metal-backend.md](./10-metal-backend.md) |
| 03   | [02-model-architecture.md](./02-model-architecture.md), [03-gguf-loading.md](./03-gguf-loading.md), [04-quantization.md](./04-quantization.md) |
| 04   | [05-tokenizer-chat.md](./05-tokenizer-chat.md) |
| 05   | [06-engine-session.md](./06-engine-session.md), [10-metal-backend.md](./10-metal-backend.md) |
| 06   | [05-tokenizer-chat.md](./05-tokenizer-chat.md) |
| 07   | [06-engine-session.md](./06-engine-session.md), [14-disk-kv-cache.md](./14-disk-kv-cache.md) |
| 08   | [09-moe-hyperconnections.md](./09-moe-hyperconnections.md), [10-metal-backend.md](./10-metal-backend.md) |
| 09   | [06-engine-session.md](./06-engine-session.md), [10-metal-backend.md](./10-metal-backend.md) |
| 10   | [08-attention.md](./08-attention.md), [07-kv-cache.md](./07-kv-cache.md) |
| 11   | [09-moe-hyperconnections.md](./09-moe-hyperconnections.md), [04-quantization.md](./04-quantization.md) |
| 12   | [07-kv-cache.md](./07-kv-cache.md), [08-attention.md](./08-attention.md) |
| 13   | [02-model-architecture.md](./02-model-architecture.md), [09-moe-hyperconnections.md](./09-moe-hyperconnections.md) |
| 14   | [06-engine-session.md](./06-engine-session.md) |
| 15   | [10-metal-backend.md](./10-metal-backend.md), [07-kv-cache.md](./07-kv-cache.md) |
| 16   | [12-speculative-mtp.md](./12-speculative-mtp.md) |
| 17   | [05-tokenizer-chat.md](./05-tokenizer-chat.md), [01-architecture-overview.md](./01-architecture-overview.md) |

## Things this trace will teach you that are not obvious from the README

Reading the trace end-to-end gives you a handful of insights that no individual reference chapter quite captures, because they are statements about the **shape of the whole program** rather than any one subsystem:

1. **ds4 does almost no work at runtime that is not directly producing tokens.** All the bookkeeping — argument parsing, file mapping, name-to-pointer binding, shape validation, semantic invariants — is concentrated in the first five steps and never repeats. The hot path (steps 09-16) consists of straight-line tensor operations on pre-bound pointers. No string lookups, no hash maps, no virtual dispatch.

2. **The engine/session split is what makes one binary serve both CLI and server.** The CLI builds one engine and one session and exits. The server (`ds4_server.c`) builds one engine and many sessions, one per request. The exact same engine code, the exact same `ds4_session_sync` and `ds4_session_eval`, run in both. Step 05 and step 07 introduce this split; the rest of the trace exploits it without realizing it.

3. **mmap is load-bearing in ways that go beyond "fast file read".** Steps 02 and 05 together show that the GGUF file backs the model weights directly, the Metal driver wraps slices of the mapping as zero-copy `MTLBuffer`s (`ds4.c:17711`), and on Apple Silicon's unified memory the GPU and CPU see the same physical pages. The 24 GiB model never "loads" in the usual sense; it just becomes addressable.

4. **DS4 Flash's compute graph is layer-major, not token-major.** Step 09 makes this explicit: during prefill, all prompt tokens advance through layer 0 together, then all of them advance through layer 1, and so on. Decode (step 15) is the degenerate case where the token batch is size 1. The same code paths handle both because of this layout choice.

5. **The "hyperconnection" residual is not the usual residual.** Most transformer code adds a sublayer's output to a single residual stream. DS4 Flash maintains four parallel streams that mix in and out at each sublayer entry/exit (`DS4_N_HC = 4`). Steps 08, 10, and 11 each show how the HC machinery wraps the underlying attention/FFN computation.

6. **Quantization is heterogeneous on purpose.** Step 03 reveals that ds4 accepts three different routed-expert quants (`IQ2_XXS`, `Q2_K`, `Q4_K`) while keeping attention matrices at Q8_0 and HC weights at F16. The same model architecture has multiple precision profiles; the choice is per-tensor-class, not per-model.

7. **There is no "model class hierarchy".** ds4 hardcodes the DS4 Flash architecture as compile-time constants (`ds4.c:87-116`). Loading a non-DS4 GGUF is rejected at startup by `config_validate_model`. The simplicity comes from refusing the multi-architecture generality that, for example, llama.cpp embraces — a deliberate tradeoff in favor of a smaller, more readable codebase.

These takeaways are scattered across the steps but they crystallize once you have read all 17. If you remember nothing else, remember these seven.

## How to read the trace

- Read the steps in order, 01 through 17. Each step opens by accepting whatever state the previous step ended on; reading out of order means filling state in by hand.
- Every step is self-contained: it does not rely on memory of step 03 by the time you reach step 13. The state table above is the bridge — keep it open in a second window.
- Sections 2, 4, and 5 of each step are the load-bearing trio. Sections 6 and 8 are auxiliary: section 6 is the index back into the source, section 8 is the self-check. If you are short on time, read 1-2-4-5-8 and skim 3, 6, 7.
- Section 7 of each step links back into the reference chapters. When something in section 7 looks more interesting than the main thread, follow the link — but come back, because the spine matters more than any one branch on the first read.
- The trace is **intentionally minimal**. No thinking mode, no tools, no chunked prefill, no MTP, no server. The reference chapters cover those once you have the spine. The deliberately-skipped branches are listed in the "chosen trace target" section above so there is no surprise about what you will *not* see.
- All `file:line` references in section 6 of every step are resolvable at the locked commit `f91c12b`. If you are reading the source at a different commit, the line numbers will drift — the wiki is locked, not chasing main.

One last note on scope: the trace deliberately treats the Metal driver and the Apple Silicon GPU as black boxes at their outer edges. We do not trace how `MTLBuffer` actually pages from unified memory, or how Apple's compiler lowers a Metal kernel. The trace covers everything between `int main()` accepting `argv` and `ds4_engine_close` returning — the ds4 process is the universe of this trace.

Begin at [tour-01-cli-parse.md](./tour-01-cli-parse.md).
