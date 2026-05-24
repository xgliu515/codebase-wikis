# Tour Step 12: Ratio-4 compressor and the indexer

Code version locked to `ds4@f91c12b50a` (2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

Tour steps 10 and 11 ran the attention and FFN sublayers for one layer. They wrote into a raw sliding-window KV cache (`raw_kv` of width `DS4_N_SWA = 128`, `ds4.c:104`). But many of DS4's 43 layers are **not** dense-attention layers: they are compressed-cache layers, and for them the attention step is only half the cache update. The other half is the **compressor** and, on ratio-4 layers, the **indexer**.

The layer compression ratio is decided by `ds4_layer_compress_ratio()` at `ds4.c:418-422`:

```c
static uint32_t ds4_layer_compress_ratio(uint32_t il) {
    if (il < 2) return 0;                       // dense early layers
    return (il & 1u) == 0 ? 4u : 128u;          // alternating 4 / 128
}
```

So layers 0 and 1 are dense (`ratio = 0`), even-numbered layers `2, 4, 6, ...` are ratio-4 (a compressed row every 4 tokens, plus an indexer), and odd-numbered layers `3, 5, 7, ...` are ratio-128 (a compressed row every 128 tokens, no indexer). For our trace target `./ds4 -m DS4.gguf -p "hello" -n 3` the prompt is only one or two tokens, so the compressor frontier never reaches a flush — but the code still **runs the streaming update** at every position, and we need to understand it because it dominates long context.

By the end of this step every compressor on every layer has updated its rolling state, ratio-4 layers have also updated their indexer cache, and the indexer's top-K row mask is ready to be passed into attention on the next position.

## 2. The problem

A 1 M-token context window times 43 layers times 512 floats of KV per layer in plain F32 is **92 GiB** just for K and V — bigger than any consumer GPU and a large fraction of unified memory on M-class Macs. And even if the storage fit, scanning a million rows for every decode step is `O(N)` per layer per step, blowing the decode budget. We need two things:

1. **Storage compression**: a way to keep the KV cache small enough that long context is actually affordable.
2. **Compute compression**: a way to attend only to the rows that matter for a given position, in `O(K)` for some `K << N`.

The compressor solves (1) by pooling every `ratio` raw KV rows into a single compressed row that lives forever in `attn_comp_kv`. The indexer solves (2) by learning a per-position scoring of compressed rows, and only the top-`DS4_N_INDEXER_TOP_K = 512` (`ds4.c:113`) compressed rows are exposed to attention.

The "hello" trace barely exercises either, but at long context the compressor cache is 4× / 128× smaller than the raw cache, and the indexer mask makes attention's row count constant in context length.

## 3. Naive approach

The naive long-context solution is to scale the existing dense KV cache. Two flavors:

- **Linear-in-N attention scoring over a non-compressed cache.** Keep every raw KV row, and at attention time scan them all. This is what plain transformer inference does. It is conceptually simple and exact: every row is available, gradients flow cleanly, and the only cost is time and memory.
- **Pure sliding-window attention.** Keep only the last `W` rows; throw away anything older. This bounds memory and time at `W`, but the model literally cannot see anything older than `W` tokens — every long-range dependency is severed.

## 4. Why the naive approach breaks

- **Memory.** `1,048,576 × 43 × 512 × 4 = 92 GiB`. Even at FP16 that is 46 GiB just for cache, on top of model weights. Loading model + cache exceeds any consumer device's unified memory budget.
- **Decode time.** Attention is `O(N)` per layer per step. At `N = 1 M`, each decode token does `1 M × 512 × 43 ≈ 22 G` multiply-adds inside attention alone; without further structure the wall-clock per token is seconds.
- **Pure SWA loses information.** A `W = 128` sliding window means anything beyond 128 tokens is invisible. Document-level reasoning, retrieval augmentation, and long conversations all break.
- **A flat KV-row downsampler (e.g. "drop every other row") doesn't work either.** Information density is non-uniform; some early tokens are document anchors, others are filler. A learned per-window pooling is required, and it needs to *learn* what's important per layer.
- **Attention over a downsampled cache still has to score every kept row.** Even if compression cuts the cache by 4× or 128×, a 1 M context still leaves 8 K or 250 K rows. We need a learned, fast selector — the indexer.

## 5. ds4's approach

ds4's approach is to pair every compressed layer with a **streaming softmax-weighted compressor** (`compressor_decode_one`, `ds4.c:6535-6630`) that maintains a small rolling window of partial rows in `state_kv` / `state_score`, flushes a pooled+normalized+RoPE'd compressed row into `attn_comp_kv` on every ratio boundary, and — on ratio-4 layers only — runs a parallel indexer compressor that produces a separate `index_comp_kv`. At read time, `indexer_allowed_decode_one` (`ds4.c:6964-7024`) builds a top-K mask over compressed rows so attention only scores the K most relevant ones.

The layer cache layout is fixed at `ds4.c:6175-6191`:

```c
typedef struct {
    float *raw_kv;                          // raw SWA, all layers
    uint32_t n_raw, cap_raw;
    uint32_t compress_ratio;                // 0 / 4 / 128
    uint32_t comp_cap, n_comp;
    float *attn_comp_kv;                    // compressed attention rows
    float *attn_state_kv, *attn_state_score;// compressor frontier (ring)
    uint32_t n_index_comp;                  // ratio-4 only
    float *index_comp_kv;                   // compressed indexer rows
    float *index_state_kv, *index_state_score;
} ds4_layer_cache;
```

Capacities: `comp_cap = ctx_size / ratio + 2` (`ds4.c:6370`); the `+2` gives slack for the rolling frontier. Ratio-4 layers double the state width via `coff = 2` (`ds4.c:6369, 6443-6447`) because the compressor keeps both a primary and a carry lane.

**Update path on each token at one layer (`ds4.c:7130-7172`).** After the raw KV row has been pushed (`kv_cache_push_raw` at `ds4.c:7130`), if `ratio != 0` the code runs `compressor_decode_one` against `attn_compressor_kv` / `_gate` / `_ape` / `_norm`:

```c
const uint32_t ratio = cache->compress_ratio;
if (ratio != 0) {
    if (compressor_decode_one(comp, model,
                              layer->attn_compressor_kv,
                              layer->attn_compressor_gate,
                              layer->attn_compressor_ape,
                              layer->attn_compressor_norm,
                              attn_norm,
                              cache->attn_state_kv,
                              cache->attn_state_score,
                              DS4_N_HEAD_DIM, ratio, il, pos)) {
        kv_cache_push_comp(cache->attn_comp_kv, &cache->n_comp,
                           cache->comp_cap, DS4_N_HEAD_DIM, comp);
    }
    if (ratio == 4) {
        if (compressor_decode_one(index_comp, ...,
                                  layer->indexer_compressor_*, ...,
                                  DS4_N_INDEXER_HEAD_DIM, ratio, il, pos)) {
            kv_cache_push_comp(cache->index_comp_kv, &cache->n_index_comp, ...);
        }
        comp_allowed = indexer_allowed_decode_one(model, layer,
                                                  cur, qr_norm,
                                                  cache->index_comp_kv,
                                                  cache->n_index_comp, il, pos);
    }
}
```

**Step A. Compressor update (`compressor_decode_one`, `ds4.c:6535-6630`).** Per call:

1. Project the layer-normed activation `x` through `wkv` and `wgate` (`F16`) into `kv_cur` and `sc_cur` of width `coff * head_dim`. The pair is computed by `matvec_q8_0_pair_prequant` when both weights are Q8_0 (`ds4.c:6557-6571`), otherwise generic `matvec_any` (`ds4.c:6572-6575`).
2. Add the per-window positional encoding `ape[:, pos_mod]` to `sc_cur` (`ds4.c:6577-6579`). `pos_mod = pos % ratio` (`ds4.c:6551`).
3. Write `kv_cur` / `sc_cur` into the rolling state at row `row = compress_ratio + pos_mod` for ratio-4, else `row = pos_mod` (`ds4.c:6552, 6581-6582`).
4. If `(pos + 1) % ratio != 0`, return `false` — no compressed row flushed this token.
5. Otherwise call `compressor_pool_decode_state` (`ds4.c:6480-6531`): for each output dimension `j`, take a softmax over the per-dimension score row, weighted-sum the kv rows. Ratio-4 layers pool over both primary and carry lanes (`ds4.c:6492-6520`).
6. RMSNorm the pooled vector with the per-dim `norm` weight (`ds4.c:6594-6598`).
7. RoPE the pooled vector at the compressed position `pos + 1 - ratio` (`ds4.c:6601-6602`).
8. FP8-quantize for attention rows (`dsv4_fp8_kv_quantize_row_inplace_cpu`, `ds4.c:6603-6604`) or apply indexer QAT for indexer rows (`dsv4_indexer_qat_row_inplace_cpu`, `ds4.c:6605-6607`).
9. For ratio-4: rotate the rolling buffer — primary lane becomes the "old" copy, carry lane is duplicated forward (`ds4.c:6609-6626`).
10. Return `true`; caller appends `out_comp` to the compressed cache.

For our `pos = 0` "hello" trace, the `(pos + 1) % ratio == 0` check fails on every compressed layer (1 % 4 = 1, 1 % 128 = 1), so step 4 returns and no compressed row is flushed. The frontier still gets the new row at row 0, but the cache stays empty. This is exactly what `compressor_finish_prefill_state_cpu` at `ds4.c:6435-6455` will clean up at the end of prefill: it zeros the unused frontier rows so streaming decode resumes from a consistent state.

**Step B. Indexer scoring on ratio-4 layers (`indexer_allowed_decode_one`, `ds4.c:6964-7024`).** When the indexer has nonzero compressed rows:

1. If `top_k >= n_comp`, mark all rows allowed and return (`ds4.c:6977-6980`).
2. Otherwise compute a 64-head, 128-wide indexer query: `matvec_any(q, indexer_attn_q_b, qr_norm)`, RoPE it, apply the indexer QAT rotation (`ds4.c:6988-6990`).
3. Compute per-head weights: `matvec_any(weights, indexer_proj, cur)`, scaled by `1/sqrt(head_dim*n_head) = 1/sqrt(128*64)` (`ds4.c:6992-6994`).
4. For each compressed row `c`, score it as `sum_h max(0, q_h . index_kv_c) * weights[h]` — a per-head ReLU'd dot product, head-weighted sum (`ds4.c:6996-7006`).
5. Repeat-`top_k` argmax to select the highest-scoring `top_k = min(512, n_comp)` rows (`ds4.c:7008-7018`). The returned `allowed[]` is the mask attention will use.

This score function is the model's learned per-position selector: it tells attention "for this query, these are the 512 compressed rows you should bother looking at". On long context the indexer-allowed list is the only thing keeping attention `O(K)` instead of `O(comp_cap)`.

**Step C. Indexer QAT row rotation (`dsv4_indexer_qat_row_inplace_cpu`, `ds4.c:1736-1741`).** Both `q` and the indexer compressed rows are rotated by a 128-wide round trip that matches DeepSeek V4's training-time QAT. Without it, the dot products in step B don't match the model graph. The compressor does the same QAT on the indexer compressed rows at `ds4.c:6605-6606`.

**For the "hello" trace at prompt length 1.** No compressor on any compressed layer flushes — `n_comp = 0` and `n_index_comp = 0` on every layer at end-of-prefill. The indexer's `top_k >= n_comp` shortcut returns `allowed = NULL` (`ds4.c:6973`). Attention falls back to raw-only scoring against `n_raw = 1` row. The compressor exists; it just produced no work yet. On a 4096-token prompt, ratio-4 layers would flush 1024 compressed rows; ratio-128 layers would flush 32. At 1 M tokens, ratio-4 layers carry 262144 rows but attention sees only 512 of them per position thanks to the indexer.

## 6. Code locations

- `ds4.c:418-422` — `ds4_layer_compress_ratio`: alternating 4 / 128, first 2 layers dense.
- `ds4.c:104-113` — `DS4_N_SWA = 128`, `DS4_N_INDEXER_HEAD = 64`, `DS4_N_INDEXER_HEAD_DIM = 128`, `DS4_N_INDEXER_TOP_K = 512`.
- `ds4.c:1736-1744` — `dsv4_indexer_qat_row_inplace_cpu` and the 128-wide round-trip QAT used on both indexer Q and indexer compressed rows.
- `ds4.c:2393-2424` — Compressor / indexer tensor expectations: `attn_compressor_ape/kv/gate/norm`, `indexer_attn_q_b`, `indexer_proj`, `indexer_compressor_*`.
- `ds4.c:2495-2545` — `validate_compress_ratio_metadata`: GGUF check against the hardcoded `[0,0,4,128,4,128,...]` schedule.
- `ds4.c:6175-6196` — `ds4_layer_cache` / `ds4_kv_cache` structures.
- `ds4.c:6354-6394` — `kv_cache_init`: per-layer raw/comp/state allocation, `comp_cap = ctx_size / ratio + 2`.
- `ds4.c:6435-6476` — `compressor_finish_prefill_state_cpu` and `kv_cache_finish_prefill_states`: clear unused frontier rows at end of prefill.
- `ds4.c:6480-6531` — `compressor_pool_decode_state`: per-dimension softmax-weighted pool over the rolling window. Ratio-4 dual-lane case at lines 6492-6520.
- `ds4.c:6535-6630` — `compressor_decode_one`: full streaming update; `kv_cur`/`sc_cur` projection, APE add, ring write, ratio-boundary flush with RMSNorm + RoPE + FP8/QAT quant.
- `ds4.c:6632-6716` — `compressor_decode_one_decode_scratch`: scratch-arena version used by decode hot path.
- `ds4.c:6960-7024` — `indexer_allowed_decode_one`: 64-head dot scoring, top-K argmax over compressed rows.
- `ds4.c:7026-7087` — `indexer_allowed_decode_one_decode_scratch`: scratch-arena variant.
- `ds4.c:7130-7172` — Single-token attention sublayer's compressor/indexer wiring inside `layer_attention_raw_swa_one`.
- `ds4.c:7369-7416` — Same wiring inside `layer_forward_raw_swa_one`.
- `ds4.c:7617-7666` — Decode-scratch wiring inside `layer_forward_raw_swa_one_decode_scratch`.
- `ds4_gpu.h:308-419` — Metal compressor/indexer signatures: `ds4_gpu_compressor_update_tensor`, `_store_batch_tensor`, `_prefill_tensor`, `_prefill_ratio4_replay_tensor`, `_prefill_state_ratio4_tensor`.
- `metal/dsv4_misc.metal:139-326` — Decode-only Metal kernels: `kernel_dsv4_indexer_score_one_direct`, `kernel_dsv4_router_weights_one`, `kernel_dsv4_router_finalize_one`, `kernel_dsv4_topk_mask`, `kernel_dsv4_sort_i32_rows_asc`.
- `metal/dsv4_misc.metal:841-1267` — Prefill Metal kernels: `kernel_dsv4_indexer_scores_tiled_f32`, `_tiled`, `_nax`, `_weighted_sum`, `_softmax_pool`.

## 7. Branches and extensions

- **Prefill batched compressor.** Decode runs `compressor_decode_one` per position. Prefill batches via `ds4_gpu_compressor_prefill_tensor` (`ds4_gpu.h:356-381`) and its ratio-4 replay variant (`_prefill_ratio4_replay_tensor`, `ds4_gpu.h:383-407`), which materialize the entire compressed cache from a contiguous KV/score batch in one Metal command buffer. Chapter 07 §3 in [07-kv-cache.md](./07-kv-cache.md) covers when each path runs.
- **Compressor state recovery at prefill boundary.** `kv_cache_finish_prefill_states` (`ds4.c:6457-6476`) clears the *unused* part of the frontier so that the first decode token starts from a state equivalent to what streaming decode would have produced. The clear range differs by ratio (lines 6443-6453). Chapter 07 §4 in [07-kv-cache.md](./07-kv-cache.md) explains why the clear regions are asymmetric for ratio-4 vs ratio-128.
- **FP8 KV storage.** Compressed rows for attention are FP8-quantized at flush time (`dsv4_fp8_kv_quantize_row_inplace_cpu`, `ds4.c:1655-1731`); on Metal the storage type is F16 to keep the GPU read path simple (`DS4_GPU_ATTN_COMP_CACHE_F16` at `ds4.c:8165`). See Chapter 04 §6 in [04-quantization.md](./04-quantization.md) for the FP8 encoding details.
- **Top-K = 512.** The comment at `ds4.c:107-112` explicitly warns this is an algorithmic parameter, not a perf knob; lowering it changes which rows attend and degrades model behavior. Chapter 08 §5 in [08-attention.md](./08-attention.md) covers the top-K rationale and how the mask is consumed by the indexed-mixed-attention kernel.
- **Indexer compressor QAT on indexer rows specifically.** Standard attention rows get an FP8 round-trip; indexer rows get a different 128-wide round-trip that matches the training-time QAT (`ds4.c:6605-6607`). Skipping this changes dot products by ~10% and silently breaks ranking.
- **No indexer on ratio-128 layers.** They keep only the attention compressor and pay no top-K scoring cost. The trade-off: ratio-128 layers compress 32× more aggressively but expose every compressed row to attention. Discussion in Chapter 08 §6 of [08-attention.md](./08-attention.md).

## 8. What you should now have in your head

- Layers `0, 1` are dense (`ratio = 0`); even-numbered layers `>= 2` are ratio-4 with an indexer; odd-numbered layers `>= 3` are ratio-128 with no indexer. Source of truth: `ds4_layer_compress_ratio` at `ds4.c:418-422`. The GGUF must match (`validate_compress_ratio_metadata`, `ds4.c:2495-2545`).
- Each compressed layer keeps a rolling `state_kv` / `state_score` of width `coff * head_dim`, projects every position through `attn_compressor_kv`/`_gate` and adds `_ape`, and **flushes one compressed row exactly when `(pos + 1) % ratio == 0`** (`compressor_decode_one`, `ds4.c:6553`). The flush does pool + RMSNorm + RoPE + FP8/QAT.
- Ratio-4 layers run a **second** compressor against `indexer_compressor_*` of width `2 * DS4_N_INDEXER_HEAD_DIM = 256` (`ds4.c:2418-2424`). It produces a separate `index_comp_kv` cache with FP8/QAT-rotated entries.
- The indexer (`indexer_allowed_decode_one`, `ds4.c:6964`) scores every compressed row against a 64-head query, applies `1/sqrt(head_dim*n_head)` scaling, takes a per-head ReLU dot, sums by head, and picks the top `DS4_N_INDEXER_TOP_K = 512` rows. Attention sees only the allowed rows.
- For `./ds4 -m DS4.gguf -p "hello" -n 3` the compressor and indexer run but never flush — `n_comp = n_index_comp = 0` everywhere at end-of-prefill. The whole apparatus is paid for because it dominates the cost model at long context, where it converts `O(N)` attention into `O(min(N/ratio, top_k))`.
