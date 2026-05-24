# Tour Step 08: Inside session_sync, before any layer runs

> Code version locked to `ds4@f91c12b` (2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

Step 07 left us inside `ds4_session_sync` at `ds4.c:17924`. The session struct exists, the engine is alive, and a freshly tokenized `prompt` was just handed in. We walked the CPU branch and the GPU branch enough to know which one we are taking — for `./ds4 -m DS4.gguf -p "hello" -n 3` on macOS that is the Metal branch starting at `ds4.c:17974`. We have decided we have **no usable checkpoint**: `s->checkpoint_valid` is false (or the checkpoint does not prefix the new prompt), so `metal_graph_reset_prefill_state` is called at `ds4.c:18039` and the engine commits to a **full prefill from token zero**.

Memory snapshot at this moment:

```
s->checkpoint_valid = false
s->prefill_cap      = (chosen at session_create, see below)
s->graph.raw_cap    = (chosen at session_create, see below)
prompt->v[0..]      = [BOS, "hello", <|Assistant|>, ...]   // ~6-15 tokens
```

Before the first layer can be dispatched the engine must answer two questions:

1. **How many tokens go into one ubatch?** A ubatch is the unit the GPU graph operates on per pass: every Q/KV projection, RoPE, attention, MoE FFN inside one layer is sized to it.
2. **What seeds the HC (hyperconnection) state at layer 0?** DS4 carries 4 parallel residual streams per token (`DS4_N_HC = 4`, `ds4.c:114`), each 4096-wide. The first layer needs something to read.

Both answers are produced before the layer loop in step 09 ever begins.

## 2. The problem

> The prefill driver must size a single GPU pass to "the largest batch the device can take without exploding memory or tripping the macOS GPU watchdog", and it must initialize four parallel residual streams per token from an information source that is deterministic, lossless, and aligned with what the network was trained to consume.

Both halves are coupled to model constants the file commits to early: `DS4_N_EMBD = 4096`, `DS4_N_HC = 4`, `DS4_N_LAYER = 43`, `DS4_N_SWA = 128` (`ds4.c:88-114`). Every later choice — raw SWA cache rows, scratch tensor sizes, RoPE positions — flows from these two answers.

## 3. Naive approach

Pick `prefill_cap = ctx_size`. The user passed `--ctx 32768` (the default); a 32k cap fits any prompt one will ever see, so partial-batch logic is never needed. Seed the four HC streams with zeros, or with four independent random vectors, or with the embedding placed only in stream 0 (and zeros elsewhere). Or: do not even allocate four streams — start with one residual and "broadcast" lazily inside layer 0.

## 4. Why the naive approach breaks

**`prefill_cap = ctx_size` blows the unified-memory budget.** `s->prefill_cap` directly sizes `batch_cur_hc` and `batch_next_hc` in the GPU graph, each of shape `[prefill_cap, DS4_N_HC, DS4_N_EMBD]` in F32. At `ctx_size = 32768`:

```
32768 × 4 × 4096 × 4 bytes = 2 GiB per buffer × 2 buffers = 4 GiB
```

That is just the HC ping-pong pair, before raw KV, before compressed KV, before Q/KV scratch. A 36 GiB M3 Max would burn a third of unified memory on temporaries while typical prompts use a few hundred tokens. The author calls out this exact concern in the `metal_graph_raw_cap_for_context` comment at `ds4.c:14265-14272`: the raw SWA cap is padded to a 256-row multiple and bounded at 8192 rows, with the prefill cap setting the per-ubatch slack on top of one SWA window.

**A 32k ubatch trips macOS WindowServer.** A single Metal command buffer that keeps the GPU busy for hundreds of milliseconds can fire the WindowServer watchdog and kill the process. The author's mitigation lives in `metal_graph_prefill_layer_major` at `ds4.c:13624-13628`: any prefill `n_tokens > 2048` (or any throttled / callback-driven prefill) is split into per-layer command buffers. But the split path itself only helps if the per-pass cap is bounded; a 32k ubatch fed through the split path still creates 32k-row encoded layer commands.

**Zero-seeded HC streams discard the input embedding.** The HC post step (`hc_post_one`, `ds4.c:4458-4480`) mixes the new sublayer block output through a learned combine matrix into the existing residual streams. If every stream starts as zeros, the very first attention sublayer reads `attn_norm` from an all-zero context, the model loses access to the token identity, and the output is garbage. The HC mechanism's whole point is that all four streams carry token-conditioned state from layer 0 onwards.

**Random or independent-stream init kills determinism.** The same prompt would yield different logits on re-run. There is no reason to add randomness here — the streams are supposed to diverge through learned `hc_attn_fn` / `hc_ffn_fn` transforms, not through entropy at the entry point.

**Embedding only in stream 0 destroys symmetry.** The HC combine matrix is initialized assuming all four streams carry comparable signal at layer 0. Placing data in only one stream collapses the effective HC rank by 4× for the first few layers until the combine matrix has a chance to redistribute information.

## 5. ds4's approach

ds4's approach is to **adapt the ubatch cap to the actual prompt length at session creation**, and to **seed all four HC streams with the same F16 token embedding**, leaving divergence to the learned per-layer combine matrices.

### A. Adaptive `prefill_cap`

`ds4_default_prefill_cap_for_prompt` at `ds4.c:6205` is the single source of truth:

```c
uint32_t cap = (uint32_t)prompt_len;
const char *env = getenv("DS4_METAL_PREFILL_CHUNK");
if (env && env[0]) { /* explicit override */ }
else if (prompt_len > 4096) {
    cap = 4096u;
}
```

The threshold is **4096 tokens**, not the older 2048 — long-context tuning at f91c12b raised it after measurement on M3-class hardware. The env knob `DS4_METAL_PREFILL_CHUNK` remains for retuning. The Metal-specific wrapper `metal_graph_prefill_cap_for_prompt` at `ds4.c:14300` just defers to the same function.

For our trace, `prompt_len` is well under 4096, so `s->prefill_cap = prompt_len` exactly — **one ubatch covers the whole prompt**, and step 09 will take the single-command-buffer fast path at `ds4.c:13634-13705` rather than the per-layer split path.

The raw SWA cache size is bound to the ubatch cap at `metal_graph_raw_cap_for_context` (`ds4.c:14263-14296`):

```
raw_cap = align_up(min(DS4_N_SWA + prefill_cap, ctx_size), 256)
clamped to [raw_window, 8192]
env override: DS4_METAL_GRAPH_RAW_CAP
```

Both values are committed in `ds4_session_create` at `ds4.c:17817-17818` and never recomputed. That gives the GPU graph a single, immutable size budget the rest of the pipeline can assume.

### B. HC seeding from the token embedding

The CPU reference is `prefill_layer_major_cpu` at `ds4.c:7811-7815`:

```c
for (uint64_t t = 0; t < n_tok; t++) {
    embed_token_f16(model, weights, prompt->v[t], plain);
    hc_from_plain_embedding(cur + t * hc_dim, plain, DS4_N_EMBD, DS4_N_HC);
}
```

`hc_from_plain_embedding` (`ds4.c:4451-4455`) is three lines: it `memcpy`s the same 4096-wide F16 embedding (dequantized to F32 in `plain`) into all four HC slots of one token. Every HC stream starts as the same vector; their later divergence is entirely the work of `hc_post_one` (`ds4.c:4458-4480`) mixing each sublayer's block output through the learned `comb` matrix indexed as `[dst_hc, src_hc]`.

On the Metal path the equivalent is `metal_graph_upload_prompt_embeddings_hc` at `ds4.c:11310`. It chooses between two implementations:

- **CPU fallback** (`metal_graph_upload_prompt_embeddings_hc_cpu`, `ds4.c:11278-11304`): build a host-side `[n_tokens, DS4_N_HC, DS4_N_EMBD]` tensor with the same `memcpy` loop, then `ds4_gpu_tensor_write` it. This is the path for tiny batches.
- **GPU kernel** (`ds4_gpu_embed_tokens_hc_tensor`, called at `ds4.c:11329-11338`): combine the F16 embedding-table lookup and the 4-way repeat into one Metal kernel, avoiding the host roundtrip.

The crossover is `gpu_min = 512` tokens (`ds4.c:11322`), overridable via `DS4_METAL_GPU_BATCH_EMBED_MIN`. For our `"hello"` trace `n_tokens` is well under 512, so we take the CPU fallback path, build the HC buffer on the host, and write it once.

The seeding is invoked inside `metal_graph_prefill_layer_major` at `ds4.c:13635` (single-command path) or `ds4.c:13712` (split path). It is the **first** thing that happens after token IDs are uploaded and before any layer is encoded.

### Why this composition holds

The cap is conservative-by-default: short prompts get exact-fit allocation; long prompts are capped at a measured-safe ubatch size; debug overrides exist. The HC seed is information-preserving: each stream gets the maximum signal the model could ask for, and divergence is learned not handcrafted. Both choices commit at `ds4_session_create` (cap) or first layer encode (seed) and never change mid-flight — the layer loop in step 09 can assume them.

## 6. Code locations

- `ds4.c:6205-6232` — `ds4_default_prefill_cap_for_prompt`: 4096-token threshold and `DS4_METAL_PREFILL_CHUNK` override.
- `ds4.c:14263-14296` — `metal_graph_raw_cap_for_context`: raw SWA cache sized as `align_up(SWA + prefill_cap, 256)`, capped at 8192 rows.
- `ds4.c:14300` — `metal_graph_prefill_cap_for_prompt`: Metal-specific wrapper that defers to the default function.
- `ds4.c:17796-17848` — `ds4_session_create`: where both `s->prefill_cap` (line 17817) and `s->graph.raw_cap` (line 17818) are committed.
- `ds4.c:4451-4455` — `hc_from_plain_embedding`: the 3-line core that copies one embedding into four HC streams.
- `ds4.c:4458-4480` — `hc_post_one`: the matching learned mixer that lets streams diverge.
- `ds4.c:11278-11304` — `metal_graph_upload_prompt_embeddings_hc_cpu`: host-side fallback.
- `ds4.c:11310-11342` — `metal_graph_upload_prompt_embeddings_hc`: 512-token crossover between CPU fallback and GPU kernel.
- `ds4.c:13593-13635` — `metal_graph_prefill_layer_major`: token upload and HC seed call site (single-command path).
- `ds4.c:13705-13715` — same function's split-command HC seed call site.
- `ds4.c:7784-7815` — `prefill_layer_major_cpu`: CPU reference for the whole prefill, useful as semantic ground truth.
- `ds4.c:88-114` — `DS4_N_EMBD`, `DS4_N_HC`, `DS4_N_LAYER`, `DS4_N_SWA`: the model constants every cap above is computed from.

## 7. Branches and extensions

- For the **HC architecture** — what the four streams mean, how `hc_attn_fn` / `hc_ffn_fn` reshape them at each sublayer, and why the rank-4 design exists — see [Chapter 09 Hyperconnections and MoE](./09-moe-hyperconnections.md).
- For the **raw SWA cache layout** — why `raw_cap` is aligned to 256 rows, how rows are recycled during decode, and how compressed-KV rows interleave — see [Chapter 07 KV Cache](./07-kv-cache.md).
- For the **Metal GPU graph memory budget** — how `prefill_cap` propagates through every scratch tensor, and the `ds4_context_memory_estimate` interface — see [Chapter 10 Metal Backend](./10-metal-backend.md).
- For the **chunked prefill** path triggered when `prefill_cap < prompt_len`, see [Chapter 10 §chunked prefill](./10-metal-backend.md). Our trace does not exercise it.
- For the **resumed-prefill** branch that skips this whole step when `s->checkpoint_valid` is true and the new prompt prefixes the old one, see [Chapter 07 §disk checkpoint](./07-kv-cache.md). It hands off directly to incremental decode at `ds4.c:17996-18017`.

## 8. What you should now have in your head

- **`prefill_cap` is not `ctx_size`**. For prompts under 4096 tokens it equals the prompt length exactly; otherwise it is capped at 4096. This single number sizes the HC ping-pong pair, the per-ubatch Q/KV scratch, and (together with the 128-row SWA window) the raw KV cache rounded to 256.
- **`raw_cap` is `align_up(SWA + prefill_cap, 256)`**, hard-capped at 8192. Both are committed in `ds4_session_create` and immutable for the session's life.
- **All four HC streams start as four copies of the same F16 embedding** — not zero, not random, not "one stream gets it". Stream divergence is the learned job of `hc_post_one` reading the per-layer `comb` matrix.
- **The Metal path crosses over from CPU-built HC seed to a GPU kernel at 512 tokens**, controllable via `DS4_METAL_GPU_BATCH_EMBED_MIN`. Our short trace stays on the CPU fallback.
- After this step, the GPU has token IDs uploaded, has `[n_tok, 4, 4096]` HC state seeded into `batch_cur_hc`, and is one call away from encoding layer 0. The next step opens the layer loop.
