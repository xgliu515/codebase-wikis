# Tour Step 09: Why "all tokens through layer 0", not "one token through all layers"

> Code version locked to `ds4@f91c12b` (2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

Step 08 sized the ubatch and seeded the HC state. At entry to this step:

```
s->prefill_cap = prompt_len    // hello is short, one ubatch covers it
s->graph.raw_cap               // committed, holds SWA window + ubatch
batch_cur_hc[n_tok, 4, 4096]   // 4 HC streams, all copies of the token embedding
```

`ds4_session_sync` (`ds4.c:18053`) compares `s->prefill_cap` to `prompt->len` and picks one of two backend calls. Because `prefill_cap >= prompt->len`, the raw-SWA whole-batch path wins:

```c
ok = metal_graph_prefill_raw_swa(&s->graph, &e->model, &e->weights,
                                 prompt, prompt->len, s->logits, false,
                                 s->display_progress, s->display_progress_ud);
```

`metal_graph_prefill_raw_swa` at `ds4.c:13882-13905` is a thin validator that hands off to `metal_graph_prefill_layer_major` at `ds4.c:13593` with `start = 0` and `n_tokens = prompt->len`. This is where prefill actually runs.

By the end of this step every prompt token will have passed through all 43 layers (`DS4_N_LAYER = 43`, `ds4.c:88`), the raw SWA cache will hold KV rows for every (layer, token) pair, the compressor states will be updated, and the output head will have produced one logits vector from the **last** token's residual at layer 42.

## 2. The problem

> A prefill must push N prompt tokens through L = 43 layers. The (token, layer) plane can be traversed in two orders: token-major (one token through all 43 layers, repeat for next token) or layer-major (all N tokens through layer 0, then all N through layer 1, etc). The two are mathematically equivalent in prefill because causal masking can be applied to a packed [N, N] attention matrix once per layer, but their hardware behavior diverges by an order of magnitude.

Pick the wrong order and you either pay 43 times the weight-load cost or you fall off the GEMM-vs-GEMV cliff. Either way you are leaving an order of magnitude on the floor.

## 3. Naive approach

Iterate tokens on the outside, layers on the inside:

<svg viewBox="0 0 800 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Token-major prefill traversal order"><defs><marker id="t91ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#dc2626"/></marker></defs><text x="400" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Token-major prefill (naive)  —  outer token, inner layer</text><text x="40" y="58" font-size="11" font-weight="700" fill="#dc2626">for t in 0..N:</text><text x="60" y="76" font-size="11" fill="currentColor">x = embed(prompt[t])</text><text x="60" y="92" font-size="11" font-weight="700" fill="#dc2626">for il in 0..43:</text><text x="80" y="108" font-size="11" fill="currentColor">x = layer[il].forward(x)        // attention + FFN</text><text x="80" y="124" font-size="11" fill="currentColor">kv_cache[il].push(x.kv)</text><text x="60" y="142" font-size="11" font-weight="700" fill="#dc2626">if t == N - 1: logits = output_head(x)</text><text x="40" y="180" font-size="11" font-weight="700" fill="currentColor">visit order on the (token, layer) plane:</text><g><rect x="40" y="190" width="40" height="20" rx="2" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/><text x="60" y="205" text-anchor="middle" font-size="10" font-weight="600" fill="#dc2626">t0,l0</text><rect x="82" y="190" width="40" height="20" rx="2" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/><text x="102" y="205" text-anchor="middle" font-size="10" font-weight="600" fill="#dc2626">t0,l1</text><rect x="124" y="190" width="60" height="20" rx="2" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/><text x="154" y="205" text-anchor="middle" font-size="10" font-weight="600" fill="#dc2626">... t0,l42</text><line x1="184" y1="200" x2="206" y2="200" stroke="#dc2626" stroke-width="1.5" marker-end="url(#t91ar)"/><rect x="208" y="190" width="40" height="20" rx="2" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/><text x="228" y="205" text-anchor="middle" font-size="10" font-weight="600" fill="#dc2626">t1,l0</text><rect x="250" y="190" width="40" height="20" rx="2" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/><text x="270" y="205" text-anchor="middle" font-size="10" font-weight="600" fill="#dc2626">t1,l1</text><rect x="292" y="190" width="60" height="20" rx="2" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/><text x="322" y="205" text-anchor="middle" font-size="10" font-weight="600" fill="#dc2626">... t1,l42</text><line x1="352" y1="200" x2="374" y2="200" stroke="#dc2626" stroke-width="1.5" marker-end="url(#t91ar)"/><rect x="376" y="190" width="60" height="20" rx="2" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/><text x="406" y="205" text-anchor="middle" font-size="10" font-weight="600" fill="#dc2626">t2,l0..</text><rect x="438" y="190" width="80" height="20" rx="2" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/><text x="478" y="205" text-anchor="middle" font-size="10" font-weight="600" fill="#dc2626">repeat N times</text></g><rect x="40" y="234" width="720" height="100" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/><text x="50" y="252" font-size="11" font-weight="700" fill="#dc2626">Why this fails on hardware</text><text x="50" y="270" font-size="10" fill="#7f1d1d">• weights for each layer re-read from DRAM N times — gigabytes of bandwidth wasted on a 1k-token prompt</text><text x="50" y="284" font-size="10" fill="#7f1d1d">• every projection becomes GEMV not GEMM → 10× throughput loss on Metal SIMD/SIMT lanes</text><text x="50" y="298" font-size="10" fill="#7f1d1d">• 44k GPU command dispatches instead of ~90 (N × 43 vs 43 × 2)</text><text x="50" y="312" font-size="10" fill="#7f1d1d">• KV cache writes scatter across 43 buffers per token — no write coalescing</text><text x="50" y="326" font-size="10" fill="#7f1d1d">same shape as decode — but decode has only 1 token, so the cost never appears</text></svg>
<span class="figure-caption">Figure T9.1 | Token-major prefill walks the (token, layer) plane row-by-row. Every iteration re-streams the inner layer's weights from DRAM, turns every projection into a GEMV, and issues a fresh GPU dispatch per layer per token.</span>

<details>
<summary>ASCII fallback</summary>

```
for t in 0..N:
    x = embed(prompt[t])
    for il in 0..43:
        x = layer[il].forward(x)        // attention + FFN
        kv_cache[il].push(x.kv)
    if t == N - 1:
        logits = output_head(x)
```

</details>

This is also exactly how decode (single-token generation, step 15) works, so it feels natural to reuse the shape for prefill.

## 4. Why the naive approach breaks

**Weights get read N times instead of once.** DeepSeek V4 Flash is a 256-expert MoE (`DS4_N_EXPERT = 256`, `ds4.c:99`). Each MoE layer holds gate/up/down expert tensors of tens of MB even after Q8_0 quantization. Token-major prefill must stream layer 0's weights into compute units for token 0, then again for token 1, then again for token 2 — N cold reads per layer. L2/L3 cache cannot hold expert blocks of this size, so every iteration is a full DRAM (or unified-memory) walk. With Q8_0 attention weights of ~135 MB per layer alone, a 1000-token prompt would re-stream ~135 GB of attention weights from RAM. The Metal scheduler cannot recover from that.

**GEMV instead of GEMM.** With one token per layer call, every projection (`attn_q_a`, `attn_q_b`, `attn_kv`, FFN gate/up/down) becomes a matrix-vector multiply. The Metal SIMD/SIMT hardware is built for matrix-matrix multiply: GEMM with batch dimension 8 already gives an order-of-magnitude throughput win over 8 GEMV calls. `matmul_q8_0_batch` (called throughout `layer_attention_raw_swa_batch` at `ds4.c:7263-7272`) exists precisely so a single matrix-matrix kernel can amortize one weight load over all N rows.

**Command-buffer overhead.** Even on the GPU path, each `ds4_gpu_*` dispatch carries per-call overhead. Token-major prefill issues `N × 43 × (matmuls + RoPE + attention + MoE)` commands; layer-major issues `43 × (one batched attention + one batched FFN)` commands. For 1024 tokens × 43 layers, that is the difference between ~44k dispatches and ~90.

**Compressor and KV cache writes lose locality.** Each layer's raw SWA buffer is a contiguous strided region of GPU memory. Layer-major prefill writes N consecutive KV rows into that buffer in one pass (`metal_graph_encode_layer_attention_batch`, `ds4.c:11456-11472`); token-major would scatter writes across 43 buffers for every token, defeating any write-coalescing the driver could perform.

The four problems all reduce to one root cause: **token-major prefill cannot batch any of the work that benefits from batching**, while layer-major batches every projection, every attention call, every FFN, every KV write.

## 5. ds4's approach

ds4's approach is to **iterate layers on the outside and tokens on the inside**, with a ping-pong pair of HC buffers (`batch_cur_hc` / `batch_next_hc`) that lets each layer read the previous layer's output without copies.

The driver lives in `metal_graph_prefill_layer_major` at `ds4.c:13593-13705` (whole-batch fast path; the split-command path at `ds4.c:13708-13881` does the same work but per-layer command-buffer commits).

Skeleton of the whole-batch path:

<svg viewBox="0 0 820 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Layer-major prefill with HC ping-pong buffers"><defs><marker id="t92ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="410" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Layer-major prefill (DS4)  —  outer layer, inner all tokens batched</text><rect x="40" y="40" width="320" height="34" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/><text x="200" y="58" text-anchor="middle" font-size="11" font-weight="700" fill="#0369a1">upload token IDs · warmup kernels</text><text x="200" y="70" text-anchor="middle" font-size="10" fill="#075985">ds4.c:13612-13614</text><rect x="380" y="40" width="380" height="34" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/><text x="570" y="58" text-anchor="middle" font-size="11" font-weight="700" fill="#0369a1">upload prompt embeddings → batch_cur_hc</text><text x="570" y="70" text-anchor="middle" font-size="10" fill="#075985">step 08 · ds4.c:13635</text><line x1="410" y1="74" x2="410" y2="84" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t92ar)"/><rect x="40" y="84" width="740" height="20" rx="4" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.2"/><text x="410" y="98" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">ds4_gpu_begin_commands (ds4.c:13641)</text><rect x="40" y="114" width="740" height="200" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="410" y="132" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">for il in [0, 43):  encode_layer_batch(il, all N tokens)</text><rect x="80" y="146" width="320" height="60" rx="4" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/><text x="240" y="164" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">batch_cur_hc  (input)</text><text x="240" y="180" text-anchor="middle" font-size="10" fill="#7c2d12">[N tokens × 4 HC × 4096]</text><text x="240" y="194" text-anchor="middle" font-size="10" fill="#7c2d12">read by attention + FFN GEMM</text><rect x="420" y="146" width="320" height="60" rx="4" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/><text x="580" y="164" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">batch_next_hc  (output)</text><text x="580" y="180" text-anchor="middle" font-size="10" fill="#7c2d12">written by FFN HC-post</text><text x="580" y="194" text-anchor="middle" font-size="10" fill="#7c2d12">[N × 4 × 4096]</text><line x1="400" y1="176" x2="420" y2="176" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#t92ar)"/><text x="50" y="226" font-size="10" fill="#7c2d12">encode_layer_attention_batch(il)  — packs all N kv rows · prefill attention kernel</text><text x="50" y="240" font-size="10" fill="#7c2d12">encode_layer_ffn_batch(il)         — HC pre + MoE + shared expert + HC post (all N)</text><path d="M 240 254 L 240 274 L 580 274 L 580 254" stroke="#0d9488" stroke-width="1.5" fill="none" stroke-dasharray="4,3" marker-end="url(#t92ar)"/><text x="410" y="290" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">swap(batch_cur_hc, batch_next_hc)  — pointer swap, zero copy</text><text x="410" y="304" text-anchor="middle" font-size="10" fill="#115e59">ds4.c:13117-13121 · after 43 swaps, batch_cur_hc holds the final HC state</text><line x1="410" y1="314" x2="410" y2="324" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t92ar)"/><rect x="40" y="324" width="740" height="50" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="410" y="342" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">view = last_row(batch_cur_hc) · encode_output_head(view)</text><text x="410" y="356" text-anchor="middle" font-size="10" fill="#064e3b">zero-copy row view onto token N-1 → HC collapse + vocabulary projection only on that row</text><text x="410" y="368" text-anchor="middle" font-size="10" fill="#064e3b">ds4.c:13673-13678 · other N-1 logits never computed (waste for sampling)</text><rect x="40" y="384" width="740" height="20" rx="4" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.2"/><text x="410" y="398" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">ds4_gpu_end_commands + read_logits (ds4.c:13688-13697)</text><rect x="40" y="414" width="740" height="40" rx="6" fill="#bbf7d0" stroke="#16a34a" stroke-width="1.5"/><text x="410" y="432" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">result: every layer's weights read once · matmuls are GEMM not GEMV · ~90 dispatches not 44k</text><text x="410" y="446" text-anchor="middle" font-size="10" fill="#166534">raw SWA cache + compressor + indexer states fully populated for decode (step 15)</text></svg>
<span class="figure-caption">Figure T9.2 | Layer-major prefill batches all N prompt tokens through one layer at a time. Two HC buffers ping-pong as input/output so the layer loop is a pointer-swap, every projection is GEMM, and each layer's weights stream from DRAM exactly once.</span>

<details>
<summary>ASCII fallback</summary>

```
upload token IDs                              // ds4.c:13612
warmup prefill kernels                        // ds4.c:13614
upload_prompt_embeddings_hc → batch_cur_hc    // ds4.c:13635   (step 08)
begin_commands                                // ds4.c:13641
for il in [0, 43):
    encode_layer_batch(il, all tokens)        // ds4.c:13644-13649
        encode_layer_attention_batch(il)      // → ds4.c:13109-13122
        encode_layer_ffn_batch(il)
        swap(batch_cur_hc, batch_next_hc)
view = last_row(batch_cur_hc)                 // ds4.c:13673
encode_output_head(view)                      // ds4.c:13678
end_commands                                  // ds4.c:13688
read_logits                                   // ds4.c:13697
```

</details>

The per-layer helper `metal_graph_encode_layer_batch` at `ds4.c:13109-13123` is twelve lines and does exactly two things: encode batched attention, encode batched FFN, then swap the HC buffers.

```c
bool ok = metal_graph_encode_layer_attention_batch(g, model, layer, il, pos0, n_tokens);
if (ok) ok = metal_graph_encode_layer_ffn_batch(g, model, layer, il, pos0, n_tokens);
if (ok) {
    ds4_gpu_tensor *tmp = g->batch_cur_hc;
    g->batch_cur_hc = g->batch_next_hc;
    g->batch_next_hc = tmp;
}
```

Two consequences worth pinning down:

**(a) Ping-pong eliminates copies.** `batch_cur_hc` always holds the input HC state for the next sublayer to read; `batch_next_hc` is the output target. After the swap on line 13120, the buffer that was just written becomes the input for the next layer. Across 43 layers the engine never copies activations — only pointer swaps.

**(b) Each layer's attention step writes KV rows for all tokens at once.** `metal_graph_encode_layer_attention_batch` at `ds4.c:11456` packs `n_tokens` rows of `kv` into `g->layer_raw_kv` for layer `il`, then runs the prefill-flavored attention kernel that consumes all N rows. Compressor and indexer states (`g->layer_attn_state_kv`, `g->layer_attn_state_score`) are updated in the same pass for compressed layers (those with `ds4_layer_compress_ratio(il) != 0`). When the loop exits, the raw SWA cache and compressor states are exactly in the same state they would be in if decode had been run token-by-token — but they got there in 43 batched passes.

**Why short prompts skip command-buffer splitting.** The `split_commands` flag at `ds4.c:13628` reads:

```c
const bool split_commands = split_profile || throttle || callback_split ||
                            n_tokens > 2048 || imatrix != NULL;
```

For our `"hello"` trace `n_tokens` is single digits, no power-throttle, no display callback at this scale, no imatrix collection — so `split_commands` is false and the whole 43-layer graph runs inside one command buffer (`ds4_gpu_begin_commands` at line 13641, `ds4_gpu_end_commands` at line 13688). That is the cheapest possible scheduling. Long prompts (>2048) or progress-callback-driven runs fall into the per-layer split path at `ds4.c:13708-13881`, which trades a little overhead for explicit per-layer scheduling points so macOS can intervene before WindowServer's watchdog fires.

**Output head reads exactly one row.** After all 43 layers, `batch_cur_hc` holds the final HC state for every prompt token. Only the **last** token's HC state matters for sampling (the model needs to predict what follows the prompt). `metal_graph_tensor_row_view` at `ds4.c:13673` builds a zero-copy view onto row `n_tokens - 1` (or whatever `DS4_METAL_GRAPH_OUTPUT_ROW` overrides to), and `metal_graph_encode_output_head` at `ds4.c:13678` runs the HC-collapse plus vocabulary projection only on that view. Logits for the other N-1 positions are never computed — they would be wasted work for sampling, though they would matter for training, which `ds4` is not doing.

**CPU reference** at `ds4.c:7784-7815` (`prefill_layer_major_cpu`) implements the same loop in plain C, including the same `cur/next` pointer swap pattern. It is the cleanest way to read the abstract algorithm without the GPU-graph plumbing.

## 6. Code locations

- `ds4.c:18053-18057` — `ds4_session_sync` branch that picks raw-SWA whole-batch prefill when `prefill_cap >= prompt->len`.
- `ds4.c:13882-13905` — `metal_graph_prefill_raw_swa`: thin validator that defers to layer-major with `start = 0`.
- `ds4.c:13593-13705` — `metal_graph_prefill_layer_major` whole-batch fast path: token upload, HC seed, layer loop, output head, logits read.
- `ds4.c:13628` — the `split_commands` predicate; `n_tokens > 2048` is the macOS-watchdog escape hatch.
- `ds4.c:13641-13688` — single `ds4_gpu_begin_commands` / `ds4_gpu_end_commands` pair wrapping the whole 43-layer prefill.
- `ds4.c:13109-13123` — `metal_graph_encode_layer_batch`: attention + FFN + HC ping-pong swap for one layer.
- `ds4.c:11456-11472` — `metal_graph_encode_layer_attention_batch` entry; writes raw KV rows, updates compressor and indexer states.
- `ds4.c:12834` — `metal_graph_encode_layer_ffn_batch`: batched HC pre/norm, shared expert, routed experts, HC post.
- `ds4.c:13673-13688` — output-head row view and encode for the last prompt token.
- `ds4.c:7784-7847` — `prefill_layer_major_cpu`: pure-C reference for the layer-major loop with `cur`/`next`/`attn` swap pattern.
- `ds4.c:13915-13981` — `metal_graph_prefill_chunked_range`: the split-command sibling path for long prompts (each chunk is itself a layer-major prefill).

## 7. Branches and extensions

- For the **inside of one layer's attention sublayer** — Q low-rank projection, KV single-head projection, tail-only RoPE, sink-aware softmax — see [Tour Step 10](./tour-10-attention-sublayer.md) and [Chapter 08 Attention](./08-attention.md).
- For the **inside of one layer's MoE FFN** — HC pre-norm, Sinkhorn routing vs bias top-k, shared expert, IQ2_XXS routed experts — see [Chapter 09 Hyperconnections and MoE](./09-moe-hyperconnections.md).
- For **how the raw SWA cache filled here is consumed by decode** — row recycling, KV row offsets, compressor frontier promotion — see [Chapter 07 KV Cache](./07-kv-cache.md).
- For the **chunked-prefill** path that kicks in when `prefill_cap < prompt_len` (each chunk still runs a layer-major sweep, with chunk boundaries aligned to compressor windows), see [Chapter 10 Metal Backend §chunked prefill](./10-metal-backend.md) and the resumed-checkpoint branch at `ds4.c:17996-18017`.
- For **why short prompts get one command buffer but long prompts get one per layer**, see [Chapter 10 Metal Backend §command buffer scheduling](./10-metal-backend.md). The split-flag predicate at `ds4.c:13624-13628` is the policy.

## 8. What you should now have in your head

- **Layer-major is the only sensible order for prefill** because it batches every weight-bound operation (matmul, attention, FFN) over all N tokens, turning GEMV into GEMM and reading each layer's weights from memory exactly once. Token-major would re-stream 43 layers of weights per token.
- **Two HC buffers in ping-pong** (`batch_cur_hc`, `batch_next_hc`) is the data plumbing that makes the layer loop a pointer-swap rather than a copy. After 43 swaps, `batch_cur_hc` holds the final HC state for the whole prompt.
- **Raw SWA cache and compressor state are completely populated by the time the layer loop exits.** Decode (step 15) appends one row per step; nothing about the prompt's history is recomputed.
- **Only the last token's logits are produced.** `encode_output_head` is run on a single-row view (`ds4.c:13673`) — the prompt-internal HC state at layer 42 stays as activations in `batch_cur_hc` but never reaches the vocabulary projection.
- **Short prompts (≤ 2048 tokens, no progress callback, no throttle) run in one Metal command buffer.** Long prompts split per-layer to give macOS scheduling slack and avoid the WindowServer watchdog. The selector is the `split_commands` flag at `ds4.c:13628`.
