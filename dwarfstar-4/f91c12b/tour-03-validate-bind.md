# Tour Step 03: Validate tensors & bind layer layout

Code version locked to `antirez/ds4@f91c12b` (main, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

Step 02 ended with the `ds4_model` populated:

```
e->model.fd              = open file descriptor
e->model.map             = mmap'd base pointer
e->model.size            = file size in bytes
e->model.version         = 3
e->model.n_kv            = number of metadata entries
e->model.n_tensors       = number of tensors
e->model.kv[]            = metadata index { key, type, value_pos }
e->model.tensors[]       = tensor directory { name, ndim, dim, type, abs_offset, bytes }
e->model.tensor_data_pos = absolute offset where the tensor payload region starts
```

The header magic was checked. The GGUF version is 3. The file is a syntactically valid GGUF. But ds4 still does not know whether the bytes behind this `ds4_model` are actually the DeepSeek-V4-Flash architecture the rest of the program is hardcoded for. GGUF is a generic container; the same file format can hold a LLaMA, a Mistral, a Qwen, or any other model. A misnamed tensor or a different head count would silently produce garbage tokens deep inside generation.

Continuing through `ds4_engine_open` at `ds4.c:17666-17668`, the next three calls are:

```c
vocab_load(&e->vocab, &e->model);
config_validate_model(&e->model);
weights_bind(&e->weights, &e->model);
```

This step covers the last two: **validate the semantic metadata** (`config_validate_model`) and **bind tensor names into the 43-layer fixed layout, then validate every tensor's shape and type** (`weights_bind`, which calls `weights_validate_layout` as its last line at `ds4.c:2728`). Tokenizer loading (`vocab_load`) is step 04. By the end of this step every `ds4_layer_weights` slot inside `e->weights` holds a `ds4_tensor *` pointing into the mmap, and every one of the DeepSeek-V4-Flash invariants has been cross-checked against the file's metadata. After this step, no string lookup ever happens on the inference hot path again.

## 2. The problem

The validation problem has three nested concerns. They are not the same problem; each needs its own check:

> **Tensor-name layer.** The 43-layer DeepSeek pipeline expects specific strings — `"blk.5.attn_q_a.weight"`, `"output_norm.weight"`, `"token_embd.weight"` — to be present in the directory. If a string is missing, the C pointer that the layer code reads to access that tensor would be a wild value. The hot path cannot afford a string lookup, but if it does not look up, it must trust the string was bound at startup.
>
> **Shape and type layer.** Even if every expected name is present, a tensor whose type or dimensions disagree with the inference code's hardcoded shape would have its bytes interpreted as the wrong layout. The kernel reads garbage, produces garbage, no error.
>
> **Semantic metadata layer.** Beyond tensor shapes, the GGUF stores knobs like `expert_count = 256`, `attention.sliding_window = 128`, `rope.freq_base`, `expert_weight_scale`. ds4's compute graph is built around fixed values for these. A file that hard-coded `expert_count = 128` would route through code expecting 256 experts and produce silent corruption.

These three layers happen in different functions because they answer different questions. ds4 runs them in a deliberate order: tensor-name binding first, then shape/type validation, then metadata validation — except in `ds4_engine_open` the metadata validation runs *before* the binding (`ds4.c:17667-17668`) so a model that is the wrong architecture fails before ds4 spends time finding tensor names.

## 3. Naive approach

Do the validation lazily, at the call site. Every time an inference kernel needs `blk.5.attn_q_a.weight`, look it up by name with `model_find_tensor`, check the dimensions, then use the bytes:

```c
const ds4_tensor *q_a = model_find_tensor(m, "blk.5.attn_q_a.weight");
if (!q_a) die(...);
if (q_a->type != Q8_0) die(...);
if (q_a->dim[0] != 4096 || q_a->dim[1] != 1024) die(...);
const void *bytes = m->map + q_a->abs_offset;
... use bytes ...
```

The check is done. It's not unsafe. The code is clear at each use site. For a small program reading a small number of tensors, this is perfectly reasonable.

## 4. Why the naive approach breaks

For a 43-layer transformer with twenty-plus tensors per layer the naive approach fails along three axes:

- **Hot-path cost.** 43 layers × roughly 20-25 tensors per layer = around 900 distinct named tensors that get touched every forward pass. `model_find_tensor` is a linear scan of `m->tensors[]`, which holds hundreds to thousands of entries (the DS4 Flash GGUF has well over 1 000 tensors). Per-forward-pass work would be on the order of 10^6 string comparisons. At a few CPU cycles per byte compared, this is measurable wall-clock time spent on bookkeeping, every single token, forever.
- **Late error detection.** If `blk.30.indexer.proj.weight` is missing or has the wrong dtype, the naive approach surfaces the problem only when layer 30 runs — well after step 09's prefill setup, deep inside a kernel call. The backtrace will show you a kernel-internal die-site, not "your GGUF is missing this tensor". Debugging such failures takes hours when it should take seconds.
- **Partial-binding hazard.** If validation is scattered across many call sites, it is easy to forget to check a newly added tensor. An unchecked pointer that happens to be a valid GGUF tensor of the wrong shape will read out-of-bounds bytes or interpret unrelated bytes as numbers. There is no central place that says "I have seen every tensor this pipeline depends on, and every one of them passed."

The summary: validation that runs at use-time, scattered across hundreds of call sites in a tight inner loop, is both expensive and incomplete.

## 5. ds4's approach

ds4's approach is to do all three validation layers **once, at engine open**, in a strict order, before any inference code is allowed to run. Each layer lives in its own function with a single responsibility. After they finish, the hot path is unleashed onto a known-good set of pointers and can stop checking anything.

<svg viewBox="0 0 700 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Three-stage validation pipeline at engine open: vocab load, then config_validate_model on semantic metadata, then weights_bind which binds tensor names and calls weights_validate_layout for type and shape">
  <defs>
    <marker id="t3arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
    <marker id="t3arrR" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#dc2626"/></marker>
  </defs>
  <text x="350" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">From mmap'd GGUF to a known-good engine in 3 stages</text>
  <rect x="160" y="42" width="380" height="62" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
  <text x="350" y="64" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">config_validate_model()</text>
  <text x="350" y="80" font-size="10" fill="#64748b" text-anchor="middle">ds4.c:2585</text>
  <text x="350" y="96" font-size="10" fill="#64748b" text-anchor="middle">Read every semantic metadata key, compare to DS4_N_* compile-time constants</text>
  <line x1="540" y1="73" x2="610" y2="73" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#t3arrR)"/>
  <text x="615" y="69" font-size="10" fill="#dc2626">exit(1)</text>
  <line x1="350" y1="104" x2="350" y2="124" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t3arr)"/>
  <rect x="160" y="124" width="380" height="80" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.4"/>
  <text x="350" y="146" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">weights_bind() — name → pointer</text>
  <text x="350" y="162" font-size="10" fill="#64748b" text-anchor="middle">ds4.c:2671</text>
  <text x="350" y="178" font-size="10" fill="#64748b" text-anchor="middle">required_tensor / required_tensorf walks m-&gt;tensors[]</text>
  <text x="350" y="194" font-size="10" fill="#64748b" text-anchor="middle">Fill ds4_layer_weights for all 43 layers; missing name → exit(1)</text>
  <line x1="540" y1="164" x2="610" y2="164" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#t3arrR)"/>
  <text x="615" y="160" font-size="10" fill="#dc2626">exit(1)</text>
  <line x1="350" y1="204" x2="350" y2="224" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t3arr)"/>
  <rect x="160" y="224" width="380" height="80" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.4"/>
  <text x="350" y="246" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">weights_validate_layout() — shape &amp; type</text>
  <text x="350" y="262" font-size="10" fill="#64748b" text-anchor="middle">ds4.c:2378  (last line of weights_bind: ds4.c:2728)</text>
  <text x="350" y="278" font-size="10" fill="#64748b" text-anchor="middle">tensor_expect_layout / tensor_expect_routed_expert on every bound pointer</text>
  <text x="350" y="294" font-size="10" fill="#64748b" text-anchor="middle">Wrong dim or wrong dtype → exit(1) with explicit message</text>
  <line x1="540" y1="264" x2="610" y2="264" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#t3arrR)"/>
  <text x="615" y="260" font-size="10" fill="#dc2626">exit(1)</text>
  <line x1="350" y1="304" x2="350" y2="324" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t3arr)"/>
  <rect x="190" y="324" width="320" height="50" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.4"/>
  <text x="350" y="346" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">3 stages passed → ready for inference</text>
  <text x="350" y="362" font-size="10" fill="#16a34a" text-anchor="middle">No string lookup in hot path, no shape check at use-time</text>
</svg>
<span class="figure-caption">Figure T3.1 | The three validation stages run at engine open in `ds4_engine_open` (`ds4.c:17667-17668`). Any failure exits with a one-line stderr message before inference begins.</span>

<details>
<summary>ASCII original</summary>

```
config_validate_model()                            ds4.c:2585
    Read all semantic metadata keys; compare to DS4_N_* constants
    Any mismatch → exit(1)
        │
        ▼
weights_bind()                                     ds4.c:2671
    For all 43 layers: required_tensorf(m, "blk.%u.<name>", il)
    Fill ds4_layer_weights pointers in ds4_weights
    Missing tensor → exit(1)
        │
        ▼
weights_validate_layout()  (called at ds4.c:2728)  ds4.c:2378
    For every bound pointer: tensor_expect_layout(t, type, ndim, d0, d1, d2)
    Wrong dtype or wrong dim → exit(1) with explicit message
```

</details>

**Stage 1: `config_validate_model` (`ds4.c:2585-2667`).** Reads roughly 30 semantic metadata keys from `m->kv[]` via `required_u32`, `required_u64`, `required_f32`, `required_bool`. Each value is compared to a compile-time constant: `config_expect_u32("attention.head_count", n_head, DS4_N_HEAD)`. The `DS4_N_*` constants are an `enum` at `ds4.c:87-116` — 43 layers, 4096 embedding, 64 attention heads, 256 experts, 6 used, 1 shared, 128 SWA window, 4 hyperconnection streams. `config_expect_u32` (`ds4.c:2557`) prints `ds4: expected <name>=<expected> for DeepSeek4 Flash, got <got>` and `exit(1)` on mismatch. Float comparison (`config_expect_f32`, `ds4.c:2564`) uses a relative tolerance of `1e-6` so different serializers do not trip on last-bit IEEE 754 differences. The compress-ratio sanity check is delegated to `validate_compress_ratio_metadata` (called at `ds4.c:2638`); the SwiGLU clamp values flow through `validate_swiglu_clamp_metadata` (`ds4.c:2640`).

**Stage 2: `weights_bind` (`ds4.c:2671-2728`).** Walks every expected tensor name and fills a pointer slot. The non-layer-indexed tensors come first:

```c
w->token_embd      = required_tensor(m, "token_embd.weight");
w->output_hc_base  = required_tensor(m, "output_hc_base.weight");
w->output_hc_fn    = required_tensor(m, "output_hc_fn.weight");
w->output_hc_scale = required_tensor(m, "output_hc_scale.weight");
w->output_norm     = required_tensor(m, "output_norm.weight");
w->output          = required_tensor(m, "output.weight");
```

(`ds4.c:2673-2678`). Then the per-layer loop `for (uint32_t il = 0; il < DS4_N_LAYER; il++)` (`ds4.c:2680`) fills each `ds4_layer_weights` slot. The layer schema is conditional: every layer has the HC streams, attention norm, Q/KV projections, sinks, and output projections; **compressed layers** (those where `ds4_layer_compress_ratio(il) != 0`) additionally have `attn_compressor_*` tensors; **ratio-4 layers** additionally have the `indexer_*` family. The function `ds4_layer_compress_ratio` (`ds4.c:418`) returns `0` for layers 0-1, then alternates `4, 128, 4, 128, ...` from layer 2 onward — which is the DS4 attention compression schedule. The hash-routed FFN layers (the first `DS4_N_HASH_LAYER = 3` layers) additionally bind a `ffn_gate_tid2eid` lookup table (`ds4.c:2723-2725`); later layers route through a bias instead. The bias tensor `ffn_exp_probs_b` is loaded with `tensor_by_namef` (not `required_*`, `ds4.c:2715`) because it is optional — some quants ship without it.

`required_tensorf` (`ds4.c:2240`) is just `snprintf` plus `required_tensor`, which (`ds4.c:2224`) does a linear scan via `model_find_tensor` and exits if not found. After the loop, every `ds4_layer_weights` field is a valid `ds4_tensor *`. The hot path is now allowed to read these pointers without checking them.

**Stage 3: `weights_validate_layout` (`ds4.c:2378-2447`, called as the last line of `weights_bind` at `ds4.c:2728`).** For every pointer just bound, calls `tensor_expect_layout(t, type, ndim, d0, d1, d2)`. This function (`ds4.c:2247`) checks `t->type == type`, `t->ndim == ndim`, and `t->dim[i] == want[i]` for each dimension. Failure prints the offending dimension and exits. Example asserts for layer 0:

```c
tensor_expect_layout(l->attn_q_a, DS4_TENSOR_Q8_0, 2, DS4_N_EMBD, DS4_N_LORA_Q, 0);
/* attn_q_a must be Q8_0, 2D, 4096 × 1024 */
```

(`ds4.c:2399`). Routed expert tensors get a separate validator — `tensor_expect_routed_expert` (`ds4.c:2337`) — because their dtype is **not fixed** to a single type: ds4 accepts `IQ2_XXS`, `Q2_K`, or `Q4_K` for routed gate/up/down experts (`ds4.c:2316-2320`). Different DS4 Flash quant builds ship different precisions for the experts while keeping attention and HC matrices at their fixed Q8_0/F16. The validator also asserts gate and up experts use the *same* type (`ds4.c:2436-2439`) — they are mathematically paired in the SwiGLU and must match.

For our trace, all three stages pass silently. `weights_bind` returns to `ds4_engine_open` and inference setup continues. The hot path that follows assumes the weights struct is fully populated and every pointer is layout-correct; it does not re-check.

## 6. Code locations

In suggested reading order:

- `ds4.c:87-116` — the `DS4_N_*` enum: 43 layers, 4096 embed, 129 280 vocab, 64 heads, 256 experts, etc.
- `ds4.c:418-422` — `ds4_layer_compress_ratio`: layer 0-1 = 0, then 4/128 alternating. Drives which compressor/indexer tensors are expected.
- `ds4.c:2224-2244` — `required_tensor`, `tensor_by_namef`, `required_tensorf`: tensor lookup helpers; the first dies on missing, the second returns NULL on missing (used for optional tensors).
- `ds4.c:2247-2286` — `tensor_expect_layout`: the canonical "type + ndim + per-dim" assertion. Print-and-exit on any mismatch.
- `ds4.c:2316-2320` — `tensor_is_routed_expert_type`: the "any of IQ2_XXS, Q2_K, Q4_K" predicate.
- `ds4.c:2337-2374` — `tensor_expect_routed_expert`: variant of `tensor_expect_layout` that allows a set of quant types.
- `ds4.c:2378-2447` — `weights_validate_layout`: the full shape/type check sheet. Reads naturally as the spec for "what DS4 Flash looks like".
- `ds4.c:2557-2577` — `config_expect_u32`, `config_expect_f32`, `config_expect_bool`: comparison helpers with explicit error messages.
- `ds4.c:2585-2667` — `config_validate_model`: ~30 metadata-vs-constant checks.
- `ds4.c:2671-2728` — `weights_bind`: name→pointer for global tensors and 43 layers; last line is `weights_validate_layout(w)`.
- `ds4.c:17666-17668` — the call site inside `ds4_engine_open`: `vocab_load`, `config_validate_model`, `weights_bind` in that order.

## 7. Branches and extensions

- **The full DS4 Flash layer schema.** `ds4_weights`, `ds4_layer_weights`, every tensor field with its DS4_N_* dimensions, the compress-ratio choreography across layers 0..42, and why the first three layers use hash routing while later layers use a bias-corrected top-k router — these are spelled out in [02-model-architecture.md](./02-model-architecture.md).
- **GGUF metadata typing.** The `GGUF_VALUE_*` enum (`ds4.c:856`), how `required_u32` walks `m->kv[]`, and how `tensor_by_namef` differs from `required_tensorf` (optional vs required) all live in [03-gguf-loading.md](./03-gguf-loading.md).
- **The quant zoo.** Why `attn_q_a` is fixed to Q8_0 (high precision needed for the low-rank Q projection) while routed experts may be IQ2_XXS, Q2_K, or Q4_K (where dropping precision is cheap because of MoE redundancy), plus the bit-layout of each block format, is the subject of [04-quantization.md](./04-quantization.md).
- **MTP (speculative decoding) weights.** `mtp_weights_bind` (`ds4.c:2731`) is a parallel routine that binds the MTP support model when `--mtp` is given. It has its own `mtp_weights_validate_layout` (`ds4.c:2449`). Not exercised in this trace. See [12-speculative-mtp.md](./12-speculative-mtp.md).
- **Hash-routed layers.** Layers 0..2 use `ffn_gate_tid2eid` (`ds4.c:2724`) — a static token-id → expert-id lookup table — instead of a learned router. The reasons (early-layer router collapse, vocab-conditioned routing) are in [09-moe-hyperconnections.md](./09-moe-hyperconnections.md).
- **Hyper-connection metadata.** The HC streams (`DS4_N_HC = 4`) and the Sinkhorn iteration count (`DS4_N_HC_SINKHORN_ITER = 20`) appear here only as integers being checked. Why DS4 Flash has 4 HC streams instead of one residual stream, and what Sinkhorn iterations do, is covered in [09-moe-hyperconnections.md](./09-moe-hyperconnections.md).

## 8. What you should now have in your head

- Validation and binding are **completely lifted out of the hot path**. After this step, every weight access in inference is `ptr + offset`, no string lookup, no shape check. This is the single largest reason ds4 stays simple while still being fast.
- **Three independent layers of defense**, executed in order at engine open: (1) `config_validate_model` checks ~30 semantic metadata values against `DS4_N_*` compile-time constants; (2) `weights_bind` requires every expected tensor name to exist and stores the pointer; (3) `weights_validate_layout` checks the type and dimensions of each bound pointer.
- **Errors die at startup with a specific message**, not deep inside a kernel call. `tensor_expect_layout` prints exactly which tensor failed and on which dimension, and `config_expect_u32` prints the expected and observed values; both then `exit(1)`. Debugging a wrong-architecture GGUF takes one stderr line, not a gdb session.
- The **routed expert tensors are deliberately "multi-typed"** — `IQ2_XXS`, `Q2_K`, or `Q4_K` are all accepted by `tensor_expect_routed_expert` (`ds4.c:2337`). Attention and HC matrices, by contrast, are locked to Q8_0 or F16. The split lets quant builds trade expert precision for size without re-quantizing the rest of the model.
- The 43-layer compress-ratio schedule (`ds4_layer_compress_ratio` at `ds4.c:418`) controls *which* tensors `weights_bind` expects for which layer — dense layers (0-1) skip the compressor; ratio-4 layers (the indexer layers) get the full compressor + indexer tensor set; ratio-128 layers get only the compressor. The schema is encoded in the bind/validate functions; the inference graph below trusts it.
