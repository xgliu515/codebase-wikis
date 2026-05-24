# Chapter 07: KV Cache — Raw SWA + Compressed Indexer

> Code version locked to `dwarfstar/ds4@f91c12b` (DwarfStar 4 inference engine for DeepSeek V4 Flash). All `file:line` refs are repo-root-relative paths at this commit.

## 0. The problem this chapter solves

A standard transformer KV cache stores one K and one V vector per token per head per layer. For DeepSeek V4 Flash that would be 43 layers × 2 (K,V) × 128 KV-heads × 64 dim per head per token (in the original DeepSeek-V3 shape) — and the same problem applies even after V4 Flash's aggressive grouping (`DS4_N_HEAD_KV = 1`, one shared KV head per layer). At 64K tokens of context the cache is still tens of gigabytes; at 384K (the size DeepSeek recommends for Think Max, see `ds4.c:72`) the bytes per token become the dominant memory and bandwidth cost of every attention step.

Two compromises have been tried elsewhere:

1. **Strict sliding window attention (SWA)**: keep only the last N tokens. Cheap and bounded, but the model literally forgets anything older. For a coding assistant or a long-context summarizer this is a non-starter.
2. **Per-token KV quantization**: store FP8 or 4-bit KV. Halves or quarters the memory but every layer still scales linearly with sequence length.

DS4 picks a third option, the one the DeepSeek V4 graph encodes: **dual cache**. Each layer keeps a small, exact 128-row raw SWA cache *and* a long, lossy compressed cache built by streaming a learned summarizer over the KV stream. The two caches are read together by the attention sublayer (see Chapter 08); they are written in lockstep by every prefill and decode token.

The full design has six load-bearing pieces. This chapter walks them in the order a single token's KV update touches them:

- The raw SWA ring buffer (per-layer, capacity 128, F16-rounded floats).
- The streaming compressor that turns a window of `ratio` tokens into one compressed row.
- The per-layer compression ratio policy (ratio-0 / ratio-4 / ratio-128).
- The Absolute Position Embedding (APE) the compressor uses inside its window.
- The FP8 round-trip the compressor applies to non-RoPE dimensions before the row is committed.
- The auxiliary indexer (ratio-4 layers only): a second, parallel compressed stream that scores rows and picks the top-512 visible at attention time.

Plus the disk-cache file format (`ds4_server.c:8199-8244`) that persists the *whole* dual cache between server requests.

<svg viewBox="0 0 760 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Dual KV cache overview: raw sliding window and compressed history"><defs><marker id="r71ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">DS4 dual KV cache (per layer)</text><line x1="40" y1="60" x2="720" y2="60" stroke="#94a3b8" stroke-width="1.5"/><text x="40" y="50" font-size="10" fill="#64748b">old token</text><text x="720" y="50" font-size="10" fill="#64748b" text-anchor="end">current token</text><rect x="40" y="70" width="420" height="50" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="250" y="90" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">compressed cache (attn_comp_kv)</text><text x="250" y="105" text-anchor="middle" font-size="10" fill="#7c2d12">one row per `ratio` tokens · ratio-4 or ratio-128</text><text x="250" y="118" text-anchor="middle" font-size="10" fill="#7c2d12">FP8-quantized nope · RoPE-rotated tail</text><rect x="470" y="70" width="200" height="50" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="570" y="90" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">raw SWA (raw_kv)</text><text x="570" y="105" text-anchor="middle" font-size="10" fill="#064e3b">cap 128 rows · F16-rounded</text><text x="570" y="118" text-anchor="middle" font-size="10" fill="#064e3b">exact recent K/V</text><rect x="680" y="70" width="40" height="50" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="700" y="98" text-anchor="middle" font-size="10" font-weight="700" fill="#5b21b6">now</text><rect x="40" y="140" width="320" height="60" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="200" y="160" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">ratio-4 layers also keep an indexer cache</text><text x="200" y="175" text-anchor="middle" font-size="10" fill="#78350f">index_comp_kv: 128-wide rows (Hadamard+FP4 QAT)</text><text x="200" y="188" text-anchor="middle" font-size="10" fill="#78350f">→ top-512 mask handed to attention</text><rect x="380" y="140" width="340" height="60" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="550" y="160" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">ratio-128 layers have no indexer</text><text x="550" y="175" text-anchor="middle" font-size="10" fill="#78350f">few compressed rows; attention reads them all</text><text x="550" y="188" text-anchor="middle" font-size="10" fill="#78350f">layer 0 and 1 have ratio = 0 (raw only)</text><line x1="380" y1="225" x2="380" y2="245" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r71ar)"/><rect x="40" y="245" width="680" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="380" y="265" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">attention sublayer reads raw_kv ++ attn_comp_kv per token (Chapter 08)</text><text x="380" y="277" text-anchor="middle" font-size="10" fill="#5b21b6">sink-aware softmax; ratio-4 rows masked by indexer top-K</text><rect x="40" y="300" width="680" height="60" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/><text x="380" y="320" text-anchor="middle" font-size="11" font-weight="700" fill="#0369a1">writers</text><text x="380" y="335" text-anchor="middle" font-size="10" fill="#075985">prefill: layer_attention_raw_swa_batch streams tokens through both caches in order</text><text x="380" y="350" text-anchor="middle" font-size="10" fill="#075985">decode: layer_attention_raw_swa_one appends to raw + (maybe) compressed every token</text><rect x="40" y="375" width="680" height="60" rx="6" fill="#fde68a" stroke="#f59e0b" stroke-width="1.5"/><text x="380" y="395" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">disk persistence (ds4_server.c:8199-8244)</text><text x="380" y="410" text-anchor="middle" font-size="10" fill="#78350f">"KVC" file: header + tokens + cache payload + tool-id map</text><text x="380" y="425" text-anchor="middle" font-size="10" fill="#78350f">filename = SHA1(rendered text bytes); read/write I/O, never mmap</text></svg>
<span class="figure-caption">Figure R7.1 | The dual cache architecture. Every layer keeps a 128-row raw SWA plus, for layers 2-42, a compressed cache. Ratio-4 layers additionally maintain an indexer cache that produces a top-512 visibility mask for attention.</span>

## 1. Per-layer shape

The shape constants are fixed at compile time (`ds4.c:87-116`):

```c
// ds4.c:88-115
DS4_N_LAYER            = 43,
DS4_N_EMBD             = 4096,
DS4_N_HEAD             = 64,
DS4_N_HEAD_KV          = 1,
DS4_N_HEAD_DIM         = 512,
DS4_N_ROT              = 64,
DS4_N_SWA              = 128,
DS4_N_INDEXER_HEAD     = 64,
DS4_N_INDEXER_HEAD_DIM = 128,
DS4_N_INDEXER_TOP_K    = 512,
```

There is exactly **one** KV head per layer (`DS4_N_HEAD_KV = 1`). Every Q head reads the same 512-dim KV vector. This is the most aggressive form of grouped-query attention — every layer stores 1×512=512 floats of K/V per token (not 64×512). On top of that grouping, only `DS4_N_ROT=64` of the 512 dims are RoPE-rotated; the remaining 448 dims (the "nope" part) are the values DS4 will FP8-quantize.

A layer's cache is `ds4_layer_cache` (`ds4.c:6168-6191`):

| Field | Purpose | Capacity |
|-------|---------|----------|
| `raw_kv` | F16-rounded recent KV rows | `cap_raw` × 512 floats |
| `n_raw`, `cap_raw` | live count and capacity | scalar |
| `attn_comp_kv` | compressed KV rows | `comp_cap` × 512 floats |
| `n_comp`, `comp_cap` | live count and capacity | scalar |
| `attn_state_kv` | compressor rolling KV state | `coff·ratio × coff·512` floats |
| `attn_state_score` | compressor rolling score state | same shape |
| `index_comp_kv` | indexer compressed rows (ratio-4 only) | `comp_cap` × 128 floats |
| `index_state_kv` / `index_state_score` | indexer rolling state | similar |
| `compress_ratio` | 0, 4, or 128 | scalar |

The struct ends with one `head_dim` field on the parent `ds4_kv_cache` (`ds4.c:6193-6196`) so the rest of the engine doesn't hard-code 512 in tensor strides.

## 2. The compression-ratio policy

DS4 does not compress every layer the same way. `ds4_layer_compress_ratio` (`ds4.c:418-422`) is the single source of truth:

```c
// ds4.c:418-422
static uint32_t ds4_layer_compress_ratio(uint32_t il) {
    if (il >= DS4_N_LAYER) ds4_die("DeepSeek4 layer index is outside the fixed model layout");
    if (il < 2) return 0;
    return (il & 1u) == 0 ? 4u : 128u;
}
```

There are three regimes:

- **Layers 0 and 1 (ratio = 0)** — *no compressed cache*. Only the 128-row raw SWA exists. The model's first two layers see only the local window; the assumption is that the early embedding-level processing benefits more from exact recent context than from a lossy long-range summary.
- **Even-indexed layers 2, 4, 6, ..., 42 (ratio = 4)** — high-frequency compression. One compressed row emitted per four input tokens. At 64K context that is 16K compressed rows per layer — too many for direct attention, hence the indexer.
- **Odd-indexed layers 3, 5, 7, ..., 41 (ratio = 128)** — sparse global summary. One compressed row per 128 tokens. At 64K context this is 512 rows per layer — small enough that attention can read all of them.

DS4 validates this against GGUF metadata at boot: `validate_compress_ratio_metadata` (`ds4.c:2495-2527`) reads the `deepseek4.attention.compress_ratios` array out of the GGUF and refuses to start if the model file does not match the hardcoded pattern. The check is a defensive belt-and-braces: the engine knows it is the DeepSeek V4 Flash family and will not silently process a model with a different layer policy.

The interleaving (`& 1u == 0 ? 4 : 128`) is deliberate. Stacking ratio-4 and ratio-128 layers gives the network both a dense long-range index (the ratio-4 layers, mediated by the indexer) and a sparse long-range broadcast (the ratio-128 layers, read in full). The two streams converge through the hyper-connection residual carrier across layers (see Chapter 09 for HC), so even though a ratio-128 layer only sees coarse 128-token summaries, that information can still influence a downstream ratio-4 layer through the shared 4-stream HC state.

## 3. Allocation: `kv_cache_init`

A single allocator builds every layer's cache (`ds4.c:6354-6394`):

```c
// ds4.c:6354-6394 (abridged)
static void kv_cache_init(ds4_kv_cache *cache, uint32_t ctx_size, uint32_t raw_cap) {
    memset(cache, 0, sizeof(*cache));
    if (raw_cap == 0) raw_cap = ds4_default_raw_cap(ctx_size);
    if (raw_cap > ctx_size) raw_cap = ctx_size;
    if (raw_cap == 0) raw_cap = 1;
    cache->head_dim = DS4_N_HEAD_DIM;

    for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
        const uint32_t ratio = ds4_layer_compress_ratio(il);
        cache->layer[il].cap_raw = raw_cap;
        cache->layer[il].raw_kv = xmalloc_zeroed((size_t)raw_cap * DS4_N_HEAD_DIM, sizeof(float));
        cache->layer[il].compress_ratio = ratio;

        if (ratio != 0) {
            const uint32_t coff = ratio == 4 ? 2u : 1u;
            const uint32_t comp_cap = ctx_size / ratio + 2;
            const uint32_t attn_width = coff * DS4_N_HEAD_DIM;
            const uint32_t attn_rows = coff * ratio;

            cache->layer[il].comp_cap = comp_cap;
            cache->layer[il].attn_comp_kv = xmalloc_zeroed((size_t)comp_cap * DS4_N_HEAD_DIM, sizeof(float));
            cache->layer[il].attn_state_kv = xmalloc_zeroed((size_t)attn_width * attn_rows, sizeof(float));
            cache->layer[il].attn_state_score = xmalloc((size_t)attn_width * attn_rows * sizeof(float));
            for (uint64_t i = 0; i < (uint64_t)attn_width * attn_rows; i++) {
                cache->layer[il].attn_state_score[i] = DS4_NEG_INF;
            }

            if (ratio == 4) {
                /* analogous allocation for the indexer cache */
            }
        }
    }
}
```

Three details worth pausing on:

1. **`coff = ratio == 4 ? 2u : 1u`**. Ratio-4 layers double the compressor state width. The compressor has a rolling window of `ratio` rows; ratio-4 carries the *previous* window in the second half so the per-dimension softmax pool can include 8 rows worth of evidence (the current ratio-4 window plus the immediately prior one). Ratio-128 only carries the current window. See §5 for why.
2. **`comp_cap = ctx_size / ratio + 2`**. Reserved for `ctx_size` tokens plus a two-row safety margin so a token straddling a window boundary cannot overrun. `kv_cache_push_comp` dies if the cap is breached (`ds4.c:6427`).
3. **`attn_state_score` is initialized to `DS4_NEG_INF`, not 0**. The compressor's per-dimension softmax (`ds4.c:6480-6531`) treats each state row as a logit; an unfilled row needs to carry no weight in the softmax, which means its logit must be `−∞`. Zero would make a fresh slot contribute as much as a moderately scored real slot. This is a one-line invariant that prevents an entire class of "wrong attention at the start of a sequence" bugs.

The raw cap default is `DS4_N_SWA = 128` (`ds4.c:6198-6203`):

```c
// ds4.c:6198-6203
static uint32_t ds4_default_raw_cap(uint32_t ctx_size) {
    uint32_t raw_cap = DS4_N_SWA;
    if (raw_cap > ctx_size) raw_cap = ctx_size;
    if (raw_cap == 0) raw_cap = 1;
    return raw_cap;
}
```

On Metal the cap can be much larger during prefill — see §10.

## 4. Pushing to the raw SWA ring buffer

`kv_cache_push_raw` (`ds4.c:6411-6424`) is small enough to read in one breath:

```c
// ds4.c:6411-6424
static void kv_cache_push_raw(ds4_layer_cache *cache, const float *kv) {
    if (cache->n_raw < cache->cap_raw) {
        float *dst = cache->raw_kv + (uint64_t)cache->n_raw * DS4_N_HEAD_DIM;
        for (uint32_t i = 0; i < DS4_N_HEAD_DIM; i++) dst[i] = f16_to_f32(f32_to_f16(kv[i]));
        cache->n_raw++;
        return;
    }

    memmove(cache->raw_kv,
            cache->raw_kv + DS4_N_HEAD_DIM,
            (size_t)(cache->cap_raw - 1) * DS4_N_HEAD_DIM * sizeof(cache->raw_kv[0]));
    float *dst = cache->raw_kv + (uint64_t)(cache->cap_raw - 1) * DS4_N_HEAD_DIM;
    for (uint32_t i = 0; i < DS4_N_HEAD_DIM; i++) dst[i] = f16_to_f32(f32_to_f16(kv[i]));
}
```

Two design choices stand out:

1. **Every write is F16-round-tripped.** The CPU path keeps a float buffer for arithmetic precision but rounds each value through F16 before storing. This matches what the Metal and CUDA backends keep in `raw_cache` (also F16); it means the CPU reference path produces bit-comparable activations to the GPU paths and the test harness (`metal_graph_prompt_logits_test`, `ds4.c:14391-...`) can compare logits byte-for-byte.
2. **The "ring" is a sliding `memmove`, not a head pointer.** When the buffer is full the entire 127×512 float window slides one row forward and the new row lands at position 127. For `cap_raw=128` this is 128 × 512 × 4 = 256 KiB per call per layer; in decode (43 layers per token) that is roughly 11 MiB of moved bytes per token. That sounds expensive but at single-token decode rates (~tens of tokens/second on CPU) it is a tiny fraction of the cost, and the simpler layout pays back when attention reads the cache: rows are in chronological order, no wrap-around bookkeeping needed.

A separate helper `kv_cache_push_comp` (`ds4.c:6426-6431`) handles the compressed cache. It is append-only — the compressed cache is never evicted; it grows until `comp_cap` is exhausted (which a properly-sized `ctx_size` prevents) or the session ends.

## 5. The streaming compressor: APE, rolling state, and the pool

The compressor turns the stream of per-token KV-style projections into one compressed row every `ratio` tokens. It runs inside the attention sublayer: when the attention sublayer computes the normalized hidden state (`attn_norm` — see Chapter 08), the compressor projects that same vector with two extra weight matrices, accumulates into a small rolling window, and emits a pooled row on ratio boundaries.

The single-token API is `compressor_decode_one` (`ds4.c:6535-6630`):

```c
// ds4.c:6549-6583 (abridged)
const uint32_t coff = compress_ratio == 4 ? 2u : 1u;
const uint32_t width = coff * head_dim;
const uint32_t pos_mod = pos % compress_ratio;
const uint32_t row = compress_ratio == 4 ? compress_ratio + pos_mod : pos_mod;
const bool should_compress = ((pos + 1) % compress_ratio) == 0;

/* Project the hidden state into the compressor's KV and "score" lanes.
 * For Q8_0 weights, do a fused pair matmul that shares one Q8_K activation. */
quantize_q8_0_activation(x, xq, xscale, in_dim);
matvec_q8_0_pair_prequant(kv_cur, sc_cur, model, wkv, wgate, xq, xscale);

for (uint32_t j = 0; j < width; j++) {
    sc_cur[j] += tensor_2d_value(model, ape, j, pos_mod);
}

memcpy(state_kv + (uint64_t)row * width, kv_cur, (size_t)width * sizeof(kv_cur[0]));
memcpy(state_score + (uint64_t)row * width, sc_cur, (size_t)width * sizeof(sc_cur[0]));

if (!should_compress) return false;
```

Four things happen here.

**Project the hidden state twice.** `wkv` ("compressor kv" weight) projects the normalized hidden state into the candidate KV vector; `wgate` projects it into a parallel "score" vector. Both projections are Q8_0 matrices, and DS4 fuses them: one `quantize_q8_0_activation` over the input plus one `matvec_q8_0_pair_prequant` shared kernel scans both weight matrices in one pass over activations (`ds4.c:6567-6568`). For a 4096→512 (or 4096→1024 in the ratio-4 case where `coff=2`) projection, fusing halves the read traffic on the input. The CUDA and Metal backends have the same fused primitive — see `ds4_gpu_matmul_q8_0_tensor` and its pair variants in `ds4_gpu.h:137-180`.

**Add the absolute position embedding (APE).** Within a window of size `ratio`, every token contributes a score row. APE is a learned table of shape `(width, ratio)` indexed by `pos_mod = pos % ratio` (`ds4.c:6578`). It biases the score by where in the window each token sits. The compressor uses this to learn behaviors like "first-of-window weight more strongly" or "last-of-window weight more strongly" without ever needing a position-aware Q/K like RoPE — RoPE only enters when the compressed row is finished (see below).

**Write into the rolling state at row `pos_mod` (ratio-128) or `compress_ratio + pos_mod` (ratio-4).** Ratio-128 layers have a single window: rows 0..127 of `state_kv` are filled, then pooled, then cleared and refilled. Ratio-4 layers have two: rows 0..3 hold the *previous* window; rows 4..7 hold the *current* window. When the current window finishes, rows 4..7 are copied to rows 0..3 (`ds4.c:6609-6626`) so the pool that produces the next ratio-4 row has 8 score-rows to look at, doubling the effective window the per-dimension softmax sees.

**Decide whether to emit.** A compressed row is emitted only when `(pos + 1) % ratio == 0`. At every other position the compressor writes state and returns `false`.

When the window closes, `compressor_pool_decode_state` (`ds4.c:6480-6531`) collapses the rolling state into one row by per-dimension softmax:

```c
// ds4.c:6480-6531 (abridged for ratio-4)
for (uint32_t j = 0; j < head_dim; j++) {
    float max_score = DS4_NEG_INF;
    for (uint32_t r = 0; r < compress_ratio; r++) {
        const float sp = state_score[(uint64_t)r * width + j];
        const float sc = state_score[(uint64_t)(compress_ratio + r) * width + head_dim + j];
        if (sp > max_score) max_score = sp;
        if (sc > max_score) max_score = sc;
    }
    if (max_score <= DS4_NEG_INF * 0.5f) { out[j] = 0.0f; continue; }
    float denom = 0.0f, sum = 0.0f;
    for (uint32_t r = 0; r < compress_ratio; r++) {
        const float wp = expf(state_score[(uint64_t)r * width + j] - max_score);
        const float wc = expf(state_score[(uint64_t)(compress_ratio + r) * width + head_dim + j] - max_score);
        denom += wp + wc;
        sum += wp * state_kv[(uint64_t)r * width + j];
        sum += wc * state_kv[(uint64_t)(compress_ratio + r) * width + head_dim + j];
    }
    out[j] = denom > 0.0f ? sum / denom : 0.0f;
}
```

This is **per-dimension softmax**, not cross-token softmax. For each of the 512 output dimensions independently:

- Read the `ratio` (or `2·ratio` for ratio-4) score values at that dimension.
- max-shift, exp, normalize.
- Weighted-sum the KV values at that dimension.

It is, in effect, a 1-D attention computed *inside* the window for each output channel. Each compressed dimension has its own learned attention over the window — the network decides per-channel which tokens in the window contributed.

Two safety details:

- `if (max_score <= DS4_NEG_INF * 0.5f) { out[j] = 0.0f; ... }` — if the entire window is `−∞` (because `attn_state_score` was initialized to `−∞` and no real token has landed in this position yet) the dimension is set to 0. This is the rare "compressor flushed but window was empty" case.
- The `attn_state_score` initialization to `−∞` (§3) is what makes the early prefill correct: until a window has been visited at least once, its slots are inert in the softmax.

After pooling, the compressed row gets the rest of its treatment in `compressor_decode_one` (`ds4.c:6592-6607`):

```c
// ds4.c:6592-6607
compressor_pool_decode_state(pooled, state_kv, state_score, head_dim, compress_ratio);

double ss = 0.0;
for (uint32_t i = 0; i < head_dim; i++) ss += (double)pooled[i] * pooled[i];
const float rms = 1.0f / sqrtf((float)(ss / (double)head_dim) + DS4_RMS_EPS);
for (uint32_t i = 0; i < head_dim; i++) {
    out_comp[i] = pooled[i] * rms * tensor_1d_value(model, norm, i);
}

const uint32_t comp_pos = pos + 1 - compress_ratio;
rope_tail_layer_inplace(out_comp, 1, head_dim, DS4_N_ROT, comp_pos, il, false);
if (head_dim == DS4_N_HEAD_DIM) {
    dsv4_fp8_kv_quantize_row_inplace_cpu(out_comp, head_dim, DS4_N_ROT);
} else if (head_dim == DS4_N_INDEXER_HEAD_DIM) {
    dsv4_indexer_qat_row_inplace_cpu(out_comp, head_dim);
}
```

1. **RMSNorm with a learned per-channel scale** (`norm`). The compressor has its own learned norm vector — this is what stabilizes the pooled output to a usable scale.
2. **RoPE the tail at the compressed position `comp_pos = pos + 1 - ratio`**. The compressed row inherits the position of the *first* token in its window (the one that started the window). The compressed cache is thus position-indexed in original-token coordinates.
3. **FP8 quantize the non-RoPE part**. For the attention compressor (`head_dim == DS4_N_HEAD_DIM == 512`), the 448 "nope" dimensions go through `dsv4_fp8_kv_quantize_row_inplace_cpu`. For the indexer compressor (`head_dim == 128`), all 128 dims go through Hadamard + FP4 — see §7.

After the pool emits, the ratio-4 layer also does the shift "rows 4..7 → rows 0..3" (`ds4.c:6609-6626`) so the next pool can see the previous window.

The decode-scratch variant (`compressor_decode_one_decode_scratch`, `ds4.c:6632-6717`) is byte-identical in math; it just borrows the temporary buffers from a per-context scratch arena (`ds4.c:6228-6301`) so the hot decode loop performs zero `malloc`. Every long-lived ds4 process uses the scratch path; the non-scratch path is the reference implementation for diagnostics and tests.

## 6. FP8 round-trip: aligning CPU and GPU bit-for-bit

The CPU path is the reference for what the GPU path stores. The GPU stores compressed KV in either F16 (`DS4_GPU_ATTN_COMP_CACHE_F16 == 1`, the default — see `ds4.c:8165-8167`) or F32, but DS4 still wants the CPU and GPU caches to give equal attention scores. That requires the CPU path to *simulate* the FP8 quantization that the Metal/CUDA pipeline performs on the non-RoPE dims.

`dsv4_fp8_kv_quantize_row_inplace_cpu` (`ds4.c:1656-1674`):

```c
// ds4.c:1656-1674
static void dsv4_fp8_kv_quantize_row_inplace_cpu(float *x, uint32_t head_dim, uint32_t n_rot) {
    const uint32_t n_nope = head_dim - n_rot;
    for (uint32_t off = 0; off < n_nope; off += 64) {
        float amax = 0.0f;
        for (uint32_t i = 0; i < 64; i++) {
            const float av = fabsf(x[off + i]);
            if (av > amax) amax = av;
        }
        if (amax < 1.0e-4f) amax = 1.0e-4f;
        const float scale = ldexpf(1.0f, (int)ceilf(log2f(amax / 448.0f)));
        for (uint32_t i = 0; i < 64; i++) {
            float v = x[off + i] / scale;
            if (v > 448.0f) v = 448.0f;
            if (v < -448.0f) v = -448.0f;
            x[off + i] = dsv4_e4m3fn_dequant_cpu(v) * scale;
        }
    }
}
```

The format is **E4M3FN** (4-bit exponent, 3-bit mantissa, finite no-NaN). The 448 nope-dims are grouped into 7 blocks of 64. For each block:

- Find absolute max.
- Pick a scale that is a power-of-two exponent: `2^ceil(log2(amax/448))`. The maximum representable value in E4M3FN is 448, so the scale aligns `amax` to that ceiling.
- For each value: divide by scale, clamp to ±448, round to the nearest E4M3FN code (`dsv4_e4m3fn_dequant_cpu`, `ds4.c:1626-1651`), multiply by scale.

The dequant helper does a binary search over the 127 representable E4M3FN magnitudes (`dsv4_e4m3fn_value_cpu`, `ds4.c:1611-1624`) with a banker's-style tie break (`(best+1) & 1 == 0 && (best & 1) != 0`, line 1645) so it matches the rounding mode used by Apple's Metal half-to-FP8 conversion. The RoPE tail (`n_rot=64` dims at the end) is left alone — its precision matters more for the attention math than for memory, so it stays in F16 inside the compressed cache.

For the *indexer* compressed cache the format is different. `dsv4_indexer_qat_row_inplace_cpu` (`ds4.c:1736-1740`):

```c
// ds4.c:1736-1740
static void dsv4_indexer_qat_row_inplace_cpu(float *x, uint32_t head_dim) {
    if (head_dim != 128) ds4_die("DSV4 indexer QAT expects 128-wide indexer rows");
    dsv4_hadamard128_inplace_cpu(x);
    dsv4_fp4_act_quantize_row_inplace_cpu(x, head_dim);
}
```

The indexer rotates the whole 128-dim vector through a **128-wide Walsh-Hadamard transform** (`ds4.c:1698-1710`), then quantizes to **E2M1FN** (4-bit total: 2-bit exponent, 1-bit mantissa, finite no-NaN) in groups of 32 (`ds4.c:1712-1730`). The Hadamard is essential — by spreading information uniformly across all 128 dims it makes the very-low-precision E2M1FN tolerable. Without it the FP4 round-trip would lose too much per-channel signal. After the Hadamard each FP4 cell now encodes a linear combination of the original dimensions, and the matched product structure of the indexer Q-projection (also Hadamard-rotated; see §8) recovers most of the lost precision when the scores are computed.

Why two different quantizations? Memory. The indexer cache exists *in addition to* the attention compressed cache, and even at 128 dims per row × 4 bytes (FP4 packed into a byte) the indexer's per-layer footprint is substantial. Ratio-4 layers (21 of them) each carry an indexer; at 64K context that is 21 × 16384 rows × 64 bytes = 22 MB just for the indexer caches if they stayed at F32. The Hadamard+FP4 path simulates the model's quantization-aware-training; the model was trained knowing this would happen, so the loss is contained.

## 7. The indexer: how ratio-4 layers pick which compressed rows to read

A ratio-4 layer at 64K context has 16384 compressed rows. Attention cannot read them all every token. The indexer's job is to pick the most relevant 512.

The indexer is a *separate* small attention computed alongside the main one. It has its own weights:

- `indexer_compressor_kv`, `indexer_compressor_gate`, `indexer_compressor_ape`, `indexer_compressor_norm`: the streaming compressor for the indexer (same shape API as the attention compressor, but produces 128-dim rows instead of 512).
- `indexer_attn_q_b`: a Q-style projection that maps the *Q low-rank vector* (the 1024-dim intermediate that the main Q projection produces — see Chapter 08) into the indexer's query space.
- `indexer_proj`: a small projection that maps the normalized hidden state into a 64-head weight vector.

Single-token logic (`indexer_allowed_decode_one`, `ds4.c:6964-7024`):

```c
// ds4.c:6982-7018 (abridged)
const uint32_t head_dim = DS4_N_INDEXER_HEAD_DIM;   // 128
const uint32_t n_head   = DS4_N_INDEXER_HEAD;       // 64

matvec_any(q, model, layer->indexer_attn_q_b, qr_norm);
rope_tail_layer_inplace(q, n_head, head_dim, DS4_N_ROT, pos, il, false);
dsv4_indexer_qat_rows_inplace_cpu(q, n_head, head_dim);

matvec_any(weights, model, layer->indexer_proj, cur);
const float scale = 1.0f / sqrtf((float)(head_dim * n_head));
for (uint32_t h = 0; h < n_head; h++) weights[h] *= scale;

for (uint32_t c = 0; c < n_comp; c++) {
    const float *kv = index_comp + (uint64_t)c * head_dim;
    float s = 0.0f;
    for (uint32_t h = 0; h < n_head; h++) {
        const float *qh = q + (uint64_t)h * head_dim;
        float dot = dot_f32(kv, qh, head_dim);
        if (dot < 0.0f) dot = 0.0f;
        s += dot * weights[h];
    }
    scores[c] = s;
}

for (uint32_t k = 0; k < top_k; k++) {
    /* incremental top-k pick: O(top_k · n_comp) but n_comp is the bottleneck */
}
```

The flow:

1. **Project the Q low-rank vector** (`qr_norm`, 1024 dims) into 64 heads × 128 dims with `indexer_attn_q_b`.
2. **RoPE the tail** of each head (just like main attention).
3. **Hadamard + FP4 quantize** each head row (`dsv4_indexer_qat_rows_inplace_cpu`), so the query is in the same encoded space as the indexer cache.
4. **Compute a 64-dim per-head weight vector** from the current normalized hidden state via `indexer_proj`. This is the "how much should each indexer head matter for this token?" decision.
5. **Score each of the `n_comp` indexer cache rows**: for each head, dot-product the head's query with the cache row, **ReLU (drop negative similarity)**, multiply by the head's learned weight, sum across heads.
6. **Top-K select** (`DS4_N_INDEXER_TOP_K = 512`, `ds4.c:113`): the 512 indices with the highest aggregated scores become the visible set.

The ReLU on negative dot products (`if (dot < 0.0f) dot = 0.0f`) is the most unusual line. Standard cross-attention has no such clip. The indexer is treating each head as a one-sided detector: a head can vote *for* a row but never *against*. The aggregation over heads then becomes a strictly non-negative ensemble; heads that disagree about a row simply have one of them contribute and the other stay silent.

The output is a `bool *allowed` array of size `n_comp`. The downstream attention reads this mask (`comp_allowed` in `layer_attention_mixed_one`, `ds4.c:6748`) and treats forbidden rows as `−∞` in the softmax, neutralizing them.

A decode-scratch variant (`indexer_allowed_decode_one_decode_scratch`, `ds4.c:7027-7086`) uses pre-allocated buffers for the same logic. On the GPU paths the same primitive is exposed as four kernels declared in `ds4_gpu.h:80-127`: `ds4_gpu_indexer_score_one_tensor` (one query position), `ds4_gpu_indexer_scores_prefill_tensor` (whole prompt at once), `ds4_gpu_indexer_scores_decode_batch_tensor` (one batch of decode positions), and `ds4_gpu_indexer_topk_tensor` (the K-selection step). The Metal implementation lives in `metal/dsv4_misc.metal` (`kernel_dsv4_indexer_scores_tiled` line 974, `kernel_dsv4_topk_mask` line 284).

The top-K constant has a comment in the header (`ds4.c:107-113`):

> This is part of the DeepSeek-V4 attention semantics. Do not lower it for Metal4/M5 speed: selecting fewer compressed rows changes which memory the model attends to, so it is an algorithmic approximation rather than local numerical drift from a different kernel implementation.

That is the most explicit rule in the file. K=512 is a model property, not a tuning parameter. Lowering it would silently degrade quality on long-context tasks where the model has learned to use specific older rows; the engine deliberately refuses that tradeoff.

## 8. Single-token cache update walked end to end

Putting §4-§7 together, here is what happens to a layer's KV state when one new token is decoded (excerpts from `layer_attention_raw_swa_one`, `ds4.c:7090-7198`):

```c
// ds4.c:7122-7174 (abridged)
layer_attn_norm_one(attn_norm, model, layer, attn_cur);
layer_q_projection_with_lora_one(model, layer, attn_norm, q, qr_norm);
layer_kv_projection_normed_one(model, layer, attn_norm, kv);

rope_tail_layer_inplace(q, DS4_N_HEAD, DS4_N_HEAD_DIM, DS4_N_ROT, pos, il, false);
rope_tail_layer_inplace(kv, DS4_N_HEAD_KV, DS4_N_HEAD_DIM, DS4_N_ROT, pos, il, false);
dsv4_fp8_kv_quantize_row_inplace_cpu(kv, DS4_N_HEAD_DIM, DS4_N_ROT);

kv_cache_push_raw(cache, kv);

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
        if (compressor_decode_one(index_comp, model,
                                  layer->indexer_compressor_kv, ...,
                                  cache->index_state_kv, cache->index_state_score,
                                  DS4_N_INDEXER_HEAD_DIM, ratio, il, pos)) {
            kv_cache_push_comp(cache->index_comp_kv, &cache->n_index_comp,
                               cache->comp_cap, DS4_N_INDEXER_HEAD_DIM, index_comp);
        }
        comp_allowed = indexer_allowed_decode_one(model, layer,
                                                   attn_norm, qr_norm,
                                                   cache->index_comp_kv,
                                                   cache->n_index_comp,
                                                   il, pos);
    }

    layer_attention_mixed_one(heads, model, layer, q,
                              cache->raw_kv, cache->n_raw,
                              cache->attn_comp_kv, cache->n_comp,
                              comp_allowed);
}
```

Reading the calls in order:

1. `layer_attn_norm_one` — attention RMSNorm of the HC-collapsed hidden state.
2. `layer_q_projection_with_lora_one` — Q low-rank projection (Chapter 08, §1).
3. `layer_kv_projection_normed_one` — the one shared KV projection. **This is the KV vector that will land in the cache.**
4. RoPE the tails of Q and KV (last 64 of 512 dims).
5. **FP8 quantize the KV vector's nope part**. The CPU path simulates what the GPU stores.
6. `kv_cache_push_raw` — append (or slide-and-append) to the raw 128-row ring.
7. If the layer has compression: feed `attn_norm` through the attention compressor; on a ratio boundary, append the emitted compressed row.
8. If the layer is ratio-4: same again for the indexer compressor; then run the indexer to compute the visibility mask.
9. Attention (Chapter 08) reads `raw_kv[0..n_raw]` and the masked `attn_comp_kv[0..n_comp]`.

The KV vector and the compressed row both come from `attn_norm`, not from `kv`. That is important: the compressor sees the *pre-projection* hidden state and learns its own projection to a 512-dim "KV-like" space. The compressor and the main KV are two parallel views of the same hidden state. They share the position information (RoPE) but their weights and learned summarization are independent.

The decode-scratch version `layer_attention_raw_swa_one_decode_scratch` (around `ds4.c:7567+`, called from the main decode loop) does the same dance with pre-allocated buffers so a 43-layer decode of one token allocates zero bytes from `malloc`.

## 9. Prefill: filling both caches in one shot

Decode is one token at a time. Prefill is the *initial* fill, where every token of a prompt traverses every layer. The shape is the same — raw push, compressor write, compressor pool on boundaries, indexer write — but the implementation is batched.

The batched path is `layer_attention_raw_swa_batch` (`ds4.c:7202+`). It projects Q and KV for the entire token batch (`matmul_q8_0_batch`, `ds4.c:7261, 7269, 7279`), RoPEs them in bulk, then enters a per-token loop (`ds4.c:7355+`) where each iteration:

```c
// ds4.c:7361-7405 (sketch, abridged)
dsv4_fp8_kv_quantize_row_inplace_cpu(kv_t, DS4_N_HEAD_DIM, DS4_N_ROT);
kv_cache_push_raw(cache, kv_t);
if (ratio != 0) {
    if (compressor_decode_one(comp, ..., pos)) {
        kv_cache_push_comp(cache->attn_comp_kv, &cache->n_comp, ..., comp);
    }
    if (ratio == 4) {
        if (compressor_decode_one(index_comp, ...)) {
            kv_cache_push_comp(cache->index_comp_kv, &cache->n_index_comp, ..., index_comp);
        }
        comp_allowed = indexer_allowed_decode_one(...);
    }
}
```

The token-by-token loop **cannot be parallelized**: the compressor's rolling state is sequential. This is the single largest source of prefill latency on the CPU path. The Metal and CUDA backends solve it differently: the GPU has `ds4_gpu_compressor_prefill_tensor` (`ds4_gpu.h:356-381`) which performs the entire prefill compression in one kernel by analytically reconstructing every window's pool, since the pool only needs `state_kv` and `state_score` and those depend only on `kv_cur, sc_cur, ape` which can be batched. The ratio-4 layer has a specialized `ds4_gpu_compressor_prefill_ratio4_replay_tensor` (`ds4_gpu.h:383-407`) that replays both windows.

After all tokens are pushed, prefill calls `kv_cache_finish_prefill_states` (`ds4.c:6457-6476`) to clear any *unused* rows in the rolling state. The reason is subtle: if the prompt length is not a multiple of `ratio`, the compressor's state buffer ends prefill with `n_tokens % ratio` rows of valid data and `ratio - (n_tokens % ratio)` rows of stale data from earlier windows. Decode starts at `pos = n_tokens` and would fill from `pos_mod = 0`; if the stale rows are not cleared the first decode token's pool would erroneously include them.

```c
// ds4.c:6435-6455
static void compressor_finish_prefill_state_cpu(
        float *state_kv, float *state_score,
        uint32_t head_dim, uint32_t compress_ratio, uint32_t n_tokens) {
    if (!state_kv || !state_score || head_dim == 0 || compress_ratio == 0) return;
    const uint32_t coff = compress_ratio == 4 ? 2u : 1u;
    const uint32_t width = coff * head_dim;
    const uint32_t rem = n_tokens % compress_ratio;
    const uint32_t clear_start = compress_ratio == 4 ? compress_ratio + rem : rem;
    const uint32_t clear_end   = compress_ratio == 4 ? 2u * compress_ratio : compress_ratio;

    for (uint32_t row = clear_start; row < clear_end; row++) {
        float *kv = state_kv + (uint64_t)row * width;
        float *score = state_score + (uint64_t)row * width;
        memset(kv, 0, (size_t)width * sizeof(kv[0]));
        for (uint32_t i = 0; i < width; i++) score[i] = DS4_NEG_INF;
    }
}
```

Note again the `−∞` initialization — same invariant as allocation (§3), now applied per partial-window after prefill.

`kv_cache_finish_prefill_states` (`ds4.c:6457-6476`) walks all 43 layers and calls this cleaner for both the attention compressor state and (for ratio-4 layers) the indexer compressor state.

## 9.5. Why prefill stays sequential on the compressor

A naive reader of `layer_attention_raw_swa_batch` might ask: if we have the entire prompt's Q/KV in batched memory at line `ds4.c:7355`, why does the token-by-token loop exist at all? Couldn't every pos's `state_kv[row * width + j]` write be vectorized across all tokens?

The answer is that the *pool* and the *cache push* are state-mutating. Pos 7 writes to `state_kv[(4+3)*width:...]`; pos 8 starts a new window where the pool from pos 7 has just emitted, the rows have been shifted, and pos 8 now writes to `state_kv[(4+0)*width:...]`. The state at pos 8 depends on the pool at pos 7, which depends on writes at pos 4,5,6,7 — a chain.

The GPU path breaks the chain via *replay*. `ds4_gpu_compressor_prefill_tensor` (`ds4_gpu.h:356-381`) takes the *whole* sequence's `kv` and `sc` projections and reconstructs every window's pool analytically: for each output compressed-row index `c`, the kernel knows exactly which `ratio` input positions feed it, fetches those score-rows and KV-rows directly from the batched inputs, computes the pool independently per output row, and writes them in parallel. The state-rolling step is implicit in this indexing scheme; there is no state buffer between input projections and output rows when the entire prompt is known up front.

The CPU path cannot do this without duplicating the entire compressor's state machine in a parallel form, which would mean two sources of truth (the streaming path and the parallel path). The C reference keeps the streaming path as the single definition; the GPU paths can diverge into different implementations as long as their final compressed rows match.

After the per-token loop fills the compressed cache rows, the batched prefix attention (`layer_attention_prefix_batch`, `ds4.c:6929-6960`) runs the attention pass over the whole batch in parallel. Prefix attention is naturally parallel: every position's attention is over a different (causal) prefix of the same cache, with row counts per token captured in `comp_counts[t]` (line 6936).

## 10. Metal prefill: a larger raw cache

The CPU raw cache is fixed at `DS4_N_SWA = 128`. The Metal backend deliberately uses a larger buffer during prefill because batched FlashAttention wants the previous SWA window plus the current ubatch in one contiguous tensor.

`metal_graph_raw_cap_for_context` (`ds4.c:14263-14295`):

```c
// ds4.c:14263-14295 (abridged)
static uint32_t metal_graph_raw_cap_for_context(int ctx_size, uint32_t prefill_cap) {
    uint32_t raw_window = DS4_N_SWA;
    if (raw_window > (uint32_t)ctx_size) raw_window = (uint32_t)ctx_size;
    if (raw_window == 0) raw_window = 1;

    uint64_t wanted = (uint64_t)raw_window + prefill_cap;
    if (wanted > (uint32_t)ctx_size) wanted = (uint32_t)ctx_size;
    wanted = align_up(wanted, 256u);
    if (wanted > 8192u) wanted = 8192u;
    uint32_t raw_cap = (uint32_t)wanted;
    if (raw_cap < raw_window) raw_cap = raw_window;
    /* ... DS4_METAL_GRAPH_RAW_CAP env override ... */
    return raw_cap;
}
```

Three rules:

- The cap must cover the previous SWA window *plus* the current ubatch. A ubatch is the chunk of prompt tokens processed in one graph encode; the default is up to 4096 (`ds4_default_prefill_cap_for_prompt`, `ds4.c:6205-6224`).
- The cap is **rounded up to a multiple of 256**. FlashAttention tile sizes assume the raw cache is 256-aligned; without this padding the GPU and CPU paths would partition the cache differently and produce divergent attention scores.
- The cap is **clamped to 8192**. Beyond that the prefill graph would build oversized command buffers; very long prompts are instead chunked into multiple ubatches.

After prefill on the Metal path, the engine snapshots the cache (raw + compressed + indexer) into the engine's serializable session format and, in server mode, may write the whole thing to disk via the KV-cache subsystem (§11).

## 11. Disk persistence: the KVC file

A long-running ds4 server (`ds4_server.c`) sees many requests with shared prompt prefixes — the same system prompt, the same conversation history. Re-running prefill from scratch every time is wasteful. The disk KV cache (`kv_disk_cache`, declared at `ds4_server.c:7609`) persists session checkpoints between requests.

The file format is documented inline (`ds4_server.c:8199-8244`):

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="KVC disk cache file layout"><defs><marker id="r73ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">KVC file layout (one persisted cache checkpoint)</text><rect x="180" y="44" width="400" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="380" y="62" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">magic "KVC" + version</text><text x="380" y="74" text-anchor="middle" font-size="10" fill="#5b21b6">fixed header bytes</text><rect x="180" y="92" width="400" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="380" y="110" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">descriptor fields</text><text x="380" y="124" text-anchor="middle" font-size="10" fill="#7c2d12">quant_bits | save_reason | token_count | hit_count | context_size</text><text x="380" y="136" text-anchor="middle" font-size="10" fill="#7c2d12">creation_time | last_used_time | payload_bytes</text><rect x="180" y="152" width="400" height="40" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="380" y="170" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">rendered text byte count + rendered text</text><text x="380" y="184" text-anchor="middle" font-size="10" fill="#78350f">human-readable prompt for inspection</text><rect x="180" y="204" width="400" height="60" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="380" y="222" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">DS4 engine payload</text><text x="380" y="238" text-anchor="middle" font-size="10" fill="#064e3b">per layer: raw_kv | attn_comp_kv | attn_state_kv | attn_state_score</text><text x="380" y="252" text-anchor="middle" font-size="10" fill="#064e3b">ratio-4 only: index_comp_kv | indexer state buffers</text><rect x="180" y="276" width="400" height="36" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5" stroke-dasharray="4,3"/><text x="380" y="294" text-anchor="middle" font-size="11" font-weight="700" fill="#0369a1">optional KV_EXT_TOOL_MAP section</text><text x="380" y="306" text-anchor="middle" font-size="10" fill="#075985">DSML tool_call id → bytes table (for tool-result replay)</text><text x="40" y="326" font-size="10" fill="#64748b">filename = SHA1(rendered_text)</text><text x="720" y="326" text-anchor="end" font-size="10" fill="#64748b">read/write I/O · never mmap</text><line x1="380" y1="80" x2="380" y2="90" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r73ar)"/><line x1="380" y1="140" x2="380" y2="150" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r73ar)"/><line x1="380" y1="192" x2="380" y2="202" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r73ar)"/><line x1="380" y1="264" x2="380" y2="274" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r73ar)"/></svg>
<span class="figure-caption">Figure R7.3 | KVC file layout: a self-contained snapshot of one session's dual-cache state, plus the rendered text for human inspection and an optional tool-id replay map.</span>

<details>
<summary>ASCII fallback</summary>

```
File layout:
  "KVC" version
  quant bits, save reason, token count, hit count, context size
  creation time, last-used time, payload byte count
  rendered text byte count + rendered text for human inspection
  DS4 engine payload written by ds4_session_save_payload()
  optional tool-id map section
```

</details>

The payload is what `ds4_session_save_payload` produces — the *entire* dual cache: per-layer raw_kv, attn_comp_kv, attn_state_kv, attn_state_score, plus index_comp_kv and indexer state for ratio-4 layers. The cache file is fully self-contained: drop one onto a freshly started server and the live graph can be restored exactly without any model-side recomputation.

Key design choices:

- **Filename = SHA1(rendered text bytes)**, not SHA1(token ids) (`ds4_server.c:8229-8233`). The cache is keyed by the *bytes the user sent*, so a client can replay after a restart without remembering tokenization details. The payload still contains exact token ids — the filename is only the lookup.
- **Read/write I/O, never `mmap`** (`ds4_server.c:8210-8212`). The process already maps a huge GGUF; adding another mapping per cache file would multiply VM bookkeeping. Cache reads land directly into the existing graph tensors.
- **Stores are emitted only when the live graph is already at the checkpoint we want to persist** (`ds4_server.c:8213-8218`). The server never re-prefills purely to build a cache; the cache is a byproduct of prefill that the server happened to do anyway.
- **Reasons are tracked** (`KV_REASON_COLD`, `KV_REASON_CONTINUED`, `KV_REASON_EVICT`, `KV_REASON_SHUTDOWN`; `ds4_server.c:8251-8257`). A cold cache (fresh prompt) and an eviction cache (live session displaced by a new one) are persisted differently — eviction caches get priority in the budget because they represent the live state of an active conversation.

The kvstore module (`ds4_kvstore.c`/`ds4_kvstore.h`, 1.5K lines combined) is the lower-level building block; the server wraps it with its own `kv_cache_*` helpers (`ds4_server.c:8557-8762`) that handle eviction, file-size budgets (`kv_cache_file_size_fits`, `ds4_server.c:8630`), and replay/continuation logic (`kv_cache_continued_store_target`, `ds4_server.c:8618`).

This persistence is what makes the dual cache pay for itself in a server context. Without persistence, the compressed cache would be discarded at the end of each request and the next request would re-pay the full compressor cost. With persistence, prefill for a continuation request is `O(new tokens)` instead of `O(total tokens)`.

## 11.5. The kvstore module: what gets persisted

The `ds4_kvstore.h`/`ds4_kvstore.c` files provide the byte-level layout for KVC files. The headers are 8KB and 47KB respectively; here is what matters for understanding the persisted dual cache:

- `DS4_KVSTORE_FIXED_HEADER` (referenced from `ds4_server.c:8240`) is the literal `"KVC"` magic plus version. The version is bumped if the on-disk layout changes incompatibly.
- The payload section is opaque to the kvstore; it is whatever the engine's `ds4_session_save_payload` writes. For the dual cache that means: per layer, the raw_kv buffer (raw_cap × 512 floats), the attn_comp_kv buffer (n_comp × 512 floats), the attn_state_kv and attn_state_score buffers (the rolling state — yes, even partial windows mid-decode are saved), and for ratio-4 layers the index_comp_kv plus indexer state.
- The `quant_bits` field in the header (`ds4_server.c:8222-8223`) records what quantization was used for the *model*, not for the cache. If a server restarts with a different model, the kvstore refuses to load mismatched checkpoints.
- The save reason (`KV_REASON_*` enum at `ds4_server.c:8251-8257`) lets eviction policy prioritize differently. An `EVICT` save (the live session was just displaced) is biased toward retention because it represents a session a user might resume; a `COLD` save (one-off prompt prefix) is easier to evict because it can be re-prefilled.
- `KV_EXT_TOOL_MAP` (`ds4_server.c:8242`) is an extension block carrying the DSML tool-id memory: when a checkpoint contains tool-call blocks in its rendered text, the corresponding `id → DSML bytes` table is saved alongside so a continuation request can render its `tool_result` messages with the IDs the model expects to see. This is the only piece of the persisted state that is *not* part of the KV cache proper but ships with it for correctness.

The result: a KVC file is a self-contained bundle that lets the server resume a session as if no time had passed — model state, cache state, tool memory, all in one file keyed by what the client sent.

## 12. Sizing: how big is the cache?

`ds4_context_memory_estimate` (`ds4.c:14320-14389`) computes the per-context byte cost. For the CPU backend at ctx=4096:

- **Raw cache**: 43 layers × 128 rows × 512 floats × 4 bytes = ~11.0 MiB.
- **Ratio-4 compressed**: 21 layers × (4096/4 + 2) × 512 × 4 bytes ≈ 42 MiB.
- **Ratio-128 compressed**: 21 layers × (4096/128 + 2) × 512 × 4 bytes ≈ 1.4 MiB.
- **Ratio-4 indexer**: 21 layers × (4096/4 + 2) × 128 × 4 bytes ≈ 10.5 MiB.
- **Scratch**: a handful of MiB for the attention score buffer and the indexer scratch.

So ~65 MiB for a 4K context. At 64K context that climbs to nearly 1 GiB; at 384K (Think Max minimum), several GiB. The compressed cache is the dominant cost — that's the price DS4 pays for keeping a memory of older tokens.

The Metal backend stores `attn_comp_kv` as F16 by default (`DS4_GPU_ATTN_COMP_CACHE_F16 = 1` in `ds4.c:8165`), cutting the compressed-cache footprint in half. The CPU path stays in F32 because the FP8 round-trip in §6 already does the precision reduction; storing the same values in F16 would round twice with no quality gain.

## 13. Putting it together: one decode step's data flow

<svg viewBox="0 0 780 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Single decode token KV cache update flow"><defs><marker id="r712ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="390" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">One decode token, one layer (ratio-4 case)</text><rect x="290" y="40" width="200" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="390" y="58" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">attn_norm (4096 dims)</text><text x="390" y="72" text-anchor="middle" font-size="10" fill="#5b21b6">post HC-pre · RMSNorm</text><line x1="200" y1="80" x2="200" y2="110" stroke="#94a3b8" stroke-width="1.2"/><line x1="390" y1="80" x2="390" y2="110" stroke="#94a3b8" stroke-width="1.2"/><line x1="580" y1="80" x2="580" y2="110" stroke="#94a3b8" stroke-width="1.2"/><line x1="200" y1="80" x2="580" y2="80" stroke="#94a3b8" stroke-width="1.2"/><line x1="200" y1="110" x2="200" y2="130" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r712ar)"/><line x1="390" y1="110" x2="390" y2="130" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r712ar)"/><line x1="580" y1="110" x2="580" y2="130" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r712ar)"/><rect x="80" y="130" width="240" height="60" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="200" y="148" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">main KV path</text><text x="200" y="163" text-anchor="middle" font-size="10" fill="#064e3b">attn_kv Q8_0 matmul → 512</text><text x="200" y="176" text-anchor="middle" font-size="10" fill="#064e3b">RMSNorm + RoPE tail + FP8 nope</text><rect x="350" y="130" width="240" height="60" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="470" y="148" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">compressor (attn lane)</text><text x="470" y="163" text-anchor="middle" font-size="10" fill="#7c2d12">compressor_kv, _gate, +APE</text><text x="470" y="176" text-anchor="middle" font-size="10" fill="#7c2d12">write state row [4 + pos_mod]</text><rect x="620" y="130" width="140" height="60" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="690" y="148" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">indexer compressor</text><text x="690" y="163" text-anchor="middle" font-size="10" fill="#78350f">128-dim row</text><text x="690" y="176" text-anchor="middle" font-size="10" fill="#78350f">Hadamard + FP4 QAT</text><line x1="200" y1="190" x2="200" y2="220" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r712ar)"/><line x1="470" y1="190" x2="470" y2="220" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r712ar)"/><line x1="690" y1="190" x2="690" y2="220" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r712ar)"/><rect x="80" y="220" width="240" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="200" y="238" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">kv_cache_push_raw</text><text x="200" y="254" text-anchor="middle" font-size="10" fill="#064e3b">raw_kv[n_raw] · slide if full</text><rect x="350" y="220" width="240" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="470" y="238" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">if (pos+1) % 4 == 0: pool</text><text x="470" y="254" text-anchor="middle" font-size="10" fill="#7c2d12">per-dim softmax · norm · RoPE · FP8</text><rect x="620" y="220" width="140" height="44" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="690" y="238" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">if (pos+1) % 4 == 0: pool</text><text x="690" y="254" text-anchor="middle" font-size="10" fill="#78350f">push 128-dim row</text><line x1="470" y1="264" x2="470" y2="294" stroke="#ea580c" stroke-width="1.2" marker-end="url(#r712ar)"/><line x1="690" y1="264" x2="690" y2="294" stroke="#f59e0b" stroke-width="1.2" marker-end="url(#r712ar)"/><rect x="350" y="294" width="240" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="470" y="313" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">kv_cache_push_comp (attn)</text><text x="470" y="325" text-anchor="middle" font-size="10" fill="#7c2d12">attn_comp_kv[n_comp++]</text><rect x="620" y="294" width="140" height="36" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="690" y="313" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">indexer rows ready</text><text x="690" y="325" text-anchor="middle" font-size="10" fill="#78350f">index_comp_kv[n_idx++]</text><line x1="690" y1="330" x2="690" y2="360" stroke="#f59e0b" stroke-width="1.2" marker-end="url(#r712ar)"/><rect x="540" y="360" width="220" height="44" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="650" y="378" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">indexer scoring + top-K</text><text x="650" y="394" text-anchor="middle" font-size="10" fill="#78350f">→ comp_allowed[0..n_comp]</text><line x1="200" y1="264" x2="200" y2="430" stroke="#0d9488" stroke-width="1.2" marker-end="url(#r712ar)"/><line x1="470" y1="330" x2="470" y2="430" stroke="#ea580c" stroke-width="1.2" marker-end="url(#r712ar)"/><line x1="650" y1="404" x2="500" y2="430" stroke="#f59e0b" stroke-width="1.2" marker-end="url(#r712ar)"/><rect x="160" y="430" width="460" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="390" y="450" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">layer_attention_mixed_one(q, raw_kv, attn_comp_kv, comp_allowed)</text><text x="390" y="464" text-anchor="middle" font-size="10" fill="#5b21b6">sink-aware softmax · masked compressed rows · 64 Q heads share 1 KV</text><line x1="390" y1="474" x2="390" y2="500" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r712ar)"/><rect x="240" y="500" width="300" height="32" rx="6" fill="#bbf7d0" stroke="#16a34a" stroke-width="1.5"/><text x="390" y="520" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">heads (64 × 512) → output projection → HC post</text></svg>
<span class="figure-caption">Figure R7.2 | One decode token's path through the dual cache (ratio-4 layer). The same hidden state forks into the main KV projection, the attention compressor, and (for ratio-4) the indexer compressor. The raw cache slides every step; the compressed caches grow on ratio boundaries; the indexer picks the visible compressed rows.</span>

## 13.4. The ratio-4 double-window in close-up

The most non-obvious shape in the dual cache is the "double window" the ratio-4 compressor maintains. Section 5 sketched it; let's trace through three consecutive ratio-4 windows to see exactly what `state_kv` and `state_score` carry.

Initial state (after `kv_cache_init`): `state_kv` is zero, `state_score` is `−∞` everywhere. Shape is `(coff·ratio) × (coff·head_dim) = 8 × 1024` floats.

Conceptually the layout is two halves:

<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Ratio-4 compressor double-window buffer layout"><defs><marker id="r74ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">state_kv / state_score buffer for ratio-4 layers (8 rows × 1024 floats)</text><rect x="160" y="50" width="440" height="80" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="170" y="68" font-size="11" font-weight="700" fill="#5b21b6">rows 0..3 — "previous window"</text><text x="170" y="84" font-size="10" fill="#5b21b6">duplicate of prior window's current half</text><text x="170" y="100" font-size="10" fill="#5b21b6">read by pool to extend the per-dim softmax</text><text x="170" y="118" font-size="10" fill="#5b21b6">over 8 score rows per dimension</text><rect x="160" y="140" width="440" height="80" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="170" y="158" font-size="11" font-weight="700" fill="#9a3412">rows 4..7 — "current window"</text><text x="170" y="174" font-size="10" fill="#7c2d12">accumulates new tokens at row = 4 + (pos % 4)</text><text x="170" y="190" font-size="10" fill="#7c2d12">on window close → pool emits one compressed row,</text><text x="170" y="206" font-size="10" fill="#7c2d12">then rows 4..7 shift down to rows 0..3</text><text x="40" y="90" font-size="10" fill="#64748b">row 0</text><text x="40" y="106" font-size="10" fill="#64748b">row 1</text><text x="40" y="122" font-size="10" fill="#64748b">rows 2-3</text><text x="40" y="180" font-size="10" fill="#64748b">row 4</text><text x="40" y="196" font-size="10" fill="#64748b">row 5</text><text x="40" y="212" font-size="10" fill="#64748b">rows 6-7</text><line x1="380" y1="222" x2="380" y2="252" stroke="#ea580c" stroke-width="1.2" marker-end="url(#r74ar)" stroke-dasharray="3,2"/><text x="395" y="240" font-size="10" fill="#64748b">shift after pool</text><rect x="200" y="252" width="360" height="20" rx="4" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.2"/><text x="380" y="266" text-anchor="middle" font-size="10" font-weight="600" fill="#92400e">rows 4..7 are also duplicated back into rows 4..7 as carry-lane prior</text></svg>
<span class="figure-caption">Figure R7.4 | The ratio-4 compressor keeps a "double window" — previous + current — so its per-dimension softmax pool can see 8 score rows worth of evidence per output dimension.</span>

<details>
<summary>ASCII fallback</summary>

```
rows 0..3   ("previous window"):  carries pooled-source data from the prior window
rows 4..7   ("current window"):   accumulates the in-progress window
```

</details>

Within each row, the 1024-float width is also split:

<svg viewBox="0 0 760 200" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Per-row column split into primary and carry lanes"><text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Per-row column layout (1024 floats = 2 × head_dim)</text><rect x="40" y="50" width="340" height="100" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="210" y="74" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">primary lane</text><text x="210" y="92" text-anchor="middle" font-size="10" fill="#064e3b">cols 0..511 (head_dim floats)</text><text x="210" y="108" text-anchor="middle" font-size="10" fill="#064e3b">main projection of the token's hidden state</text><text x="210" y="124" text-anchor="middle" font-size="10" fill="#064e3b">read by pool as state_kv[r·width + j]</text><text x="210" y="140" text-anchor="middle" font-size="10" fill="#064e3b">paired with current-half row r+4</text><rect x="400" y="50" width="320" height="100" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/><text x="560" y="74" text-anchor="middle" font-size="11" font-weight="700" fill="#0369a1">carry lane</text><text x="560" y="92" text-anchor="middle" font-size="10" fill="#075985">cols 512..1023 (head_dim floats)</text><text x="560" y="108" text-anchor="middle" font-size="10" fill="#075985">only meaningful in current-half rows (4..7)</text><text x="560" y="124" text-anchor="middle" font-size="10" fill="#075985">seeded by shift from previous window</text><text x="560" y="140" text-anchor="middle" font-size="10" fill="#075985">"remember my immediate neighbor"</text><text x="380" y="172" text-anchor="middle" font-size="10" fill="#64748b">pool reads (state_score[r·width + j], state_score[(4+r)·width + head_dim + j]) pairs → 8 logits per dim</text></svg>
<span class="figure-caption">Figure R7.5 | The 1024-float row width splits into a 512-wide primary lane and a 512-wide carry lane. The pool's pair-scan over both lanes is what turns 4 row positions into 8 effective score entries per output dimension.</span>

<details>
<summary>ASCII fallback</summary>

```
cols   0..511 : "primary" lane
cols 512..1023: "carry" lane (only meaningful in the current half)
```

</details>

The way `compressor_decode_one` reads these (`ds4.c:6549-6553`) is:

```c
const uint32_t coff = compress_ratio == 4 ? 2u : 1u;
const uint32_t width = coff * head_dim;    // 1024 for ratio-4
const uint32_t pos_mod = pos % compress_ratio;
const uint32_t row = compress_ratio == 4 ? compress_ratio + pos_mod : pos_mod;
```

So for ratio-4 the current token always writes to row `4 + pos_mod` (i.e. rows 4, 5, 6, 7 for pos_mod 0, 1, 2, 3). The pool step (`compressor_pool_decode_state`, `ds4.c:6480-6531`) reads the *whole* 8×1024 buffer in a specific pattern: for the ratio-4 branch (line 6492-6498) it max-scans pairs `(state_score[r * width + j], state_score[(ratio+r) * width + head_dim + j])` — pairing row `r` (a prior-window row) at offset `j` with row `r+4` (a current-window row) at offset `head_dim + j`. This double-pairing means each dimension `j` is pooled over 8 score values, not 4.

After the pool emits a compressed row, the shift logic copies rows 4..7 down to rows 0..3 (`ds4.c:6609-6616`):

```c
// ds4.c:6609-6617
for (uint32_t r = 0; r < compress_ratio; r++) {
    memcpy(state_kv + (uint64_t)r * width,
           state_kv + (uint64_t)(compress_ratio + r) * width,
           (size_t)width * sizeof(state_kv[0]));
    memcpy(state_score + (uint64_t)r * width,
           state_score + (uint64_t)(compress_ratio + r) * width,
           (size_t)width * sizeof(state_score[0]));
}
```

And then immediately copies rows 0..3 back into rows 4..7 (lines 6618-6626) — duplicating the previous window into the current-window half. This duplication is deliberate: the *next* window will overwrite rows 4..7 as new tokens arrive (the writes at `row = compress_ratio + pos_mod` land squarely on top of the duplicate), and during that overwrite the *primary lane* of each new row replaces what was duplicated. The duplication ensures the carry lane of the current window starts with a sensible neighbor value rather than zero. (Effectively a "remember what came right before me" prior on the carry lane.)

The net effect: ratio-4 pools have access to **8 score-rows per dimension**, double what ratio-128 layers see. The DeepSeek design uses this extra width to keep the smaller windows more semantically informative — at ratio-128 the window itself is large enough that 128 score-rows suffice; at ratio-4 the window is too small without the previous-window blend.

For ratio-128 the layout collapses: `coff = 1`, `row = pos_mod`, single 128×512 buffer, no shift logic, no double-pairing in the pool. The simpler ratio-128 path is also faster — its pool runs at 128/4 = 32× lower frequency than ratio-4 but does a single-window per-dim softmax.

## 13.5. Scratch buffers and the decode hot loop

A common operational concern for any inference engine is the malloc/free traffic in the per-token hot loop. DS4 sidesteps this by pre-allocating *one* scratch struct per CPU context (`ds4_cpu_decode_scratch`, declared at `ds4.c:170-...`) and threading it through every decode-time function as the last argument. The struct holds every temporary buffer the layer-step needs:

```c
// ds4.c:6228-6301 (excerpted from cpu_decode_scratch_init)
scratch->cur = xmalloc((size_t)hc_dim * sizeof(float));               // 4 × 4096 hidden state
scratch->attn_cur = xmalloc((size_t)DS4_N_EMBD * sizeof(float));      // 4096 collapsed
scratch->attn_norm = xmalloc((size_t)DS4_N_EMBD * sizeof(float));
scratch->q = xmalloc((size_t)q_dim * sizeof(float));                  // 64 × 512 Q
scratch->qr = xmalloc(1024 * sizeof(float));                          // low-rank Q intermediate
scratch->qr_norm = xmalloc(1024 * sizeof(float));
scratch->kv = xmalloc((size_t)DS4_N_HEAD_DIM * sizeof(float));        // 512 KV
scratch->attn_score = xmalloc((size_t)attn_score_cap * sizeof(float));
scratch->comp = xmalloc((size_t)DS4_N_HEAD_DIM * sizeof(float));
scratch->index_comp = xmalloc((size_t)DS4_N_INDEXER_HEAD_DIM * sizeof(float));
scratch->comp_kv_cur = xmalloc((size_t)2u * DS4_N_HEAD_DIM * sizeof(float));   // ratio-4 doubled width
scratch->comp_sc_cur = xmalloc((size_t)2u * DS4_N_HEAD_DIM * sizeof(float));
scratch->comp_pooled = xmalloc((size_t)DS4_N_HEAD_DIM * sizeof(float));
scratch->index_allowed = xmalloc((size_t)comp_cap * sizeof(bool));
scratch->index_q = xmalloc((size_t)DS4_N_INDEXER_HEAD * DS4_N_INDEXER_HEAD_DIM * sizeof(float));
scratch->index_weights = xmalloc((size_t)DS4_N_INDEXER_HEAD * sizeof(float));
scratch->index_scores = xmalloc((size_t)comp_cap * sizeof(float));
/* ... and more for the FFN sublayer (see Chapter 09) ... */
```

These buffers stay alive for the lifetime of the context. A 43-layer decode of one token touches all of them, every layer, but allocates exactly zero bytes. The comment in `cpu_decode_scratch_init` (`ds4.c:6239-6245`) spells out why this matters:

> The CPU decode path used to malloc/free dozens of medium-sized buffers for every layer of every generated token. On macOS this can drive the VM system through repeated map/unmap bookkeeping while the huge model mmap is also being streamed, and we have observed kernel panics in VM accounting. Keep decode scratch resident for the whole generation instead.

A 671B-parameter model mmaps gigabytes; every malloc touches the allocator's internal data structures which can interact with mmap bookkeeping in pathological ways under memory pressure. The scratch arena lifts the entire hot loop out of that interaction.

Two arena sizings deserve note:

- `scratch->attn_score_cap = raw_cap + comp_cap` (`ds4.c:6233`). This is the maximum number of KV rows attention can score in one head (raw plus all compressed). `layer_attention_mixed_one_decode_scratch` (`ds4.c:6783`) explicitly checks `if (n_total > scratch->attn_score_cap) ds4_die(...)` (`ds4.c:6797`) to catch any drift between the cap sizing and the actual cache growth.
- `scratch->comp_cap = ctx_size / 4 + 2`. Sized for the *worst case* (ratio-4 — the highest-density compressed cache); ratio-128 layers leave most of the indexer scratch unused, which is fine.

The non-scratch variants (`compressor_decode_one`, `indexer_allowed_decode_one`, `layer_attention_mixed_one`) still exist and are used by reference-path tests and by diagnostic tracing (`-DDS4_DECODE_PROFILE_DETAIL`). They allocate freely; their job is to be obviously correct, not fast.

## 13.6. Cache lifecycle: from boot to disk

The cache's lifetime spans more than just one request. Reading the server (`ds4_server.c`) end to end, a single conversation flows through these stages:

1. **Boot**. The graph allocates raw cache buffers (sized for prefill on Metal; the standard 128 rows on CPU) and zeroed compressed buffers. `n_raw = 0`, `n_comp = 0` everywhere.
2. **First request, cold prompt**. The server checks the disk cache for a prefix match (`kv_cache_find_text_prefix`, `ds4_server.c:8758`). If miss, it runs full prefill — every prompt token traverses §9's batched path; the raw window fills, the compressors emit on every ratio boundary, and the indexer caches grow.
3. **End of prefill**. `kv_cache_finish_prefill_states` clears unused state-rolling buffer rows (§9). The cache is now exactly as decode expects.
4. **Decode**. Each generated token goes through §8's single-token path. Raw window slides at 128 rows; compressed caches grow one row per `ratio` tokens.
5. **Checkpoint**. At deliberate boundaries (end of an assistant turn; mid-conversation if the prefix is long enough to be worth persisting), the server packages the entire dual cache into the KVC file format (§11). The file is named SHA1(rendered text bytes).
6. **Next request**. If the next prompt shares a prefix with the persisted cache, the server reads the KVC file directly into the graph tensors (no mmap; `ds4_server.c:8210-8212`) and prefill skips the cached prefix entirely.
7. **Eviction**. When the disk cache budget is exceeded, oldest-and-least-hit entries are evicted (`kv_cache_evict`, `ds4_server.c:8557`). The hit count decays with a half-life (`KV_CACHE_HIT_HALF_LIFE_SECONDS`, `ds4_server.c:8241`) so a once-popular checkpoint slowly loses priority to fresher state.

The decision to write a cache is gated by `kv_cache_file_size_fits` (`ds4_server.c:8630`), which estimates the file size against the budget before any I/O. Stores are also classified by `kv_cache_reason` (cold / continued / evict / shutdown — `ds4_server.c:8251-8257`); the server reports the reason so operators can see whether their workload is producing cold-fill traffic (many distinct prompts) or continued-conversation traffic (long sessions getting checkpointed periodically).

## 13.7. Initialization invariants worth memorizing

Several pieces of the dual cache depend on subtle initialization choices. Collected in one place:

- **`attn_state_score = DS4_NEG_INF`** (`ds4.c:6378-6380`, `ds4.c:6388-6390`). Unfilled compressor state rows must be inert in the softmax. Initializing to 0 would silently corrupt the very first compressed row produced.
- **`raw_kv = zeroed`** (`xmalloc_zeroed` at `ds4.c:6365`). The raw cache's unfilled rows are never read (attention only scans `[0..n_raw)`), but zeroing means a stray read is a tractable bug rather than reading whatever the allocator had.
- **`compress_ratio` per layer set at init** (`ds4.c:6366`). The compress ratio is a layer property, not a runtime decision; the cache struct duplicates it for fast access during attention (`cache->compress_ratio`, `ds4.c:7132`).
- **`head_dim = DS4_N_HEAD_DIM` on the parent** (`ds4.c:6360`). The whole engine assumes 512-wide rows for the attention cache and 128-wide for the indexer, but having `head_dim` on the cache struct makes it possible to detect a corrupted cache load early.
- **`kv_cache_finish_prefill_states` clears unused state but not `n_comp` or `n_raw`** (`ds4.c:6457-6476`). The live row counts are preserved; only the rolling state's stale partial-window rows are zapped.

## 13.8. The compressor's weight perspective

A confusing point when reading the code for the first time: each compressed layer has *two* sets of compressor weights — the attention compressor (`attn_compressor_*` family) and, on ratio-4 layers, the indexer compressor (`indexer_compressor_*` family). Both run on the *same* input (the attention RMSNorm output `attn_norm`); they differ in output width and downstream consumer.

Comparing the two compressor weight schemas:

| Tensor (per layer) | Attention compressor | Indexer compressor |
|--------------------|----------------------|--------------------|
| `_kv` (projects to KV lane) | 4096 → 1024 (Q8_0, ratio-4) / 4096 → 512 (Q8_0, ratio-128) | 4096 → 256 (Q8_0) |
| `_gate` (projects to score lane) | same shape as `_kv` | same shape as `_kv` |
| `_ape` | width × ratio learned table | width × ratio learned table (smaller width) |
| `_norm` | per-channel RMSNorm scale at `head_dim` | per-channel RMSNorm scale at 128 |

Both compressors use the *fused pair matmul* (`matvec_q8_0_pair_prequant`, line 6568) so KV and gate share an activation quantization. This is meaningful for the indexer because the indexer compressor's projection is 4096→256 — small enough that the activation-quantization cost dominates if not amortized. The fused pair halves it.

After the pool emits, the divergence becomes more visible:

- Attention compressor's output (`out_comp[i]`) is `head_dim = 512` wide. It is RMSNormed, RoPE'd at the *first window position*, and FP8-quantized on its nope tail (lines 6596-6604). This row becomes a regular KV cache entry that attention will dot-product with Q vectors.
- Indexer compressor's output (`out_comp[i]`) is `head_dim = 128` wide. After RMSNorm and RoPE it goes through `dsv4_indexer_qat_row_inplace_cpu` (line 6605-6606): Hadamard followed by FP4. This row is *only* used by the indexer scorer, not by attention directly.

The same `compressor_decode_one` function services both because the shape is parameterized by `head_dim`, `wkv`, `wgate`, `ape`, `norm`, and the rolling state buffers — every per-compressor knob is an argument. The function checks `head_dim == DS4_N_HEAD_DIM` versus `head_dim == DS4_N_INDEXER_HEAD_DIM` only to decide which quantization to apply at the end (line 6603-6607); everything else is shape-driven.

The indexer compressor's `head_dim = 128` is a careful choice. Smaller than the main 512 means cheaper indexer scoring (the indexer scorer in §7 does `n_comp × n_head × head_dim` dot products, so cutting head_dim by 4× cuts scoring cost by 4×). At the same time the indexer has *64 heads* (`DS4_N_INDEXER_HEAD`, `ds4.c:105`), more than the 8 the indexer compressor's projection produces per row — the indexer's Q projection (`indexer_attn_q_b`, see §7) is what fans out the 1024-dim Q low-rank vector into 64 × 128 head queries that meet the cache.

## 13.9. The compressor's relationship to attention

A subtle point worth making explicit: the compressed cache rows live in the **same dot-product space as the main attention's KV rows**. Attention reads `raw_kv` and `attn_comp_kv` through the *same* sink-aware softmax (`layer_attention_mixed_one`, `ds4.c:6721-6781`) with the same `kq_scale = 1 / sqrt(head_dim)`. The model treats raw and compressed rows as interchangeable from the attention math's point of view; only the indexer mask distinguishes which compressed rows are visible.

This is why the compressor's RMSNorm uses a *learned per-channel scale* (`norm`) and the post-pool RoPE uses the *first-token position* of the window. Both choices align the compressed rows with what a real KV row at that position would look like. The model can attend to a compressed row representing positions 100-103 the same way it would attend to the actual KV at position 100: dot-product Q with the row, weight in softmax, accumulate.

The FP8 quantization on the compressed nope (and the F16 round-trip on raw KV) further harmonize the two: every cache row, raw or compressed, has gone through a similar precision pass. Attention sees a uniform precision distribution across the time axis.

This uniformity is the architectural payoff of the dual cache. The model does not need a special "compressed-row attention" code path; it just attends. The compressor is purely a *write-side* mechanism — the read-side is plain attention.

## 14. Why this design

Stepping back from the code, three claims summarize the dual-cache architecture:

**Raw cache for local fidelity, compressed cache for distant memory.** No single representation works well for both: the raw cache spends bandwidth on recent positions where small differences matter most; the compressed cache pools positions where coarse semantic content is enough. The interleaving of ratio-4 and ratio-128 layers gives the network two resolutions of compressed memory in alternating layers — fine-grained for layers that need it, sparse for layers that don't.

**FP8 (and FP4) as part of the model definition, not an inference optimization.** The CPU reference path simulates the GPU's FP8/FP4 quantization explicitly (`dsv4_fp8_kv_quantize_row_inplace_cpu`, `dsv4_indexer_qat_row_inplace_cpu`) because the model was *trained* knowing those quantizations would happen. Skipping them on the CPU path would not produce "more accurate" outputs; it would produce *different* outputs than the model was trained to produce.

**The indexer makes the compressed cache scale.** Without top-K filtering, ratio-4 cache rows would either need to be small (limiting representation) or attention would blow up linearly in context. The indexer cap of 512 rows is the algorithmic ceiling DeepSeek V4 Flash chose; the engine respects it as a hard model property (`ds4.c:107-113`).

## 14.5. Comparison with single-cache designs

To see what the dual cache buys, compare with three alternative designs:

**Pure SWA (Mistral-style sliding window).** Keep only the last 4096 raw tokens. At ctx=4096 the cache is identical to DS4's raw cache (just larger). Cheap; the model literally forgets older tokens. DS4's compressed cache is what makes the difference at any reasonable context length: it lets the model attend to *something* from positions older than 128.

**KV quantization.** Store the full KV cache in FP8 instead of F16. Saves ~2× memory but every position still costs O(1) per token, so 64K context is still ~half a gigabyte. DS4 picks a much more aggressive sparsity (compressed cache stores ~1/4 the rows for ratio-4 layers, ~1/128 for ratio-128 layers) — saving 4× to 128× more memory than naive quantization.

**Hierarchical SWA (multi-scale sliding windows).** Some designs use several SWAs at different scales (e.g., 128 raw + 512 every other / 2048 every fourth). Conceptually similar to DS4's ratio-4/ratio-128 pattern, but without the learned compressor: just subsampling. The compressed cache differs in two key ways: (1) every "subsampled" position is a learned pool of `ratio` original positions, not just a copy of one of them; (2) the indexer dynamically picks which compressed positions matter for the current token, instead of using all of them.

The DS4 design is closer to a *learned compressed memory* than to any subsampling scheme. The compressor is trained jointly with the rest of the model, so the compressed rows contain whatever the model has learned to be useful — not necessarily what a fixed heuristic (every Nth token, or only certain dimensions, or only certain heads) would have picked.

## 14.6. Cross-references

For readers tracing the cache from end to end:

- **Allocation** at engine init: `kv_cache_init` (`ds4.c:6354-6394`), called by the session bring-up.
- **Push paths** during prefill and decode: `kv_cache_push_raw` (`ds4.c:6411-6424`), `kv_cache_push_comp` (`ds4.c:6426-6431`), `compressor_decode_one` (`ds4.c:6535-6630`).
- **Read paths** during attention: `layer_attention_mixed_one` (`ds4.c:6721-6781`), `layer_attention_rows_one` (`ds4.c:4990-5028`), `layer_attention_prefix_batch` (`ds4.c:6929-6960`). Detailed in Chapter 08.
- **Indexer**: `indexer_allowed_decode_one` (`ds4.c:6964-7024`) and its scratch variant.
- **Prefill cleanup**: `kv_cache_finish_prefill_states` (`ds4.c:6457-6476`).
- **Disk persistence**: `ds4_server.c:8199-8762` (the entire KV cache management block) plus `ds4_kvstore.c`/`.h` for the file format.
- **Memory accounting**: `ds4_context_memory_estimate` (`ds4.c:14320-14389`), reported by the CLI and the HTTP server's `/health` endpoint.
- **Free**: `kv_cache_free` (`ds4.c:6396-6408`), called on context teardown.

## 15. Summary table: every per-layer cache structure

| Field | Shape (per layer) | When written | When read |
|-------|-------------------|--------------|-----------|
| `raw_kv` | `cap_raw × 512` floats (F16-rounded) | every token by `kv_cache_push_raw` | every attention step |
| `attn_comp_kv` | `comp_cap × 512` floats | every `ratio` tokens by compressor pool | every attention step |
| `attn_state_kv` | `(coff·ratio) × (coff·512)` floats | every token (rolling state) | only by compressor pool |
| `attn_state_score` | same shape | every token | only by compressor pool |
| `index_comp_kv` | `comp_cap × 128` floats (ratio-4 only) | every 4 tokens by indexer compressor | every indexer scoring |
| `index_state_kv`/`_score` | `(coff·ratio) × (coff·128)` floats | every token (rolling state) | only by indexer compressor pool |

Plus per-context scratch arenas (`ds4_cpu_decode_scratch`, see §13.5) for hot-loop temporaries and per-server disk persistence (KVC files, see §11).

Chapter 08 picks up here: with the dual cache populated, how does the attention sublayer actually consume it? The mixed attention kernel that combines `raw_kv` and `attn_comp_kv` lives at `ds4.c:6721-6781`, and the sink-aware softmax over both is the subject of the next chapter. The grouped low-rank Q/KV projections that produce the input to this cache (`ds4.c:4689-4739`) and the tail-only RoPE that handles position information (`ds4.c:4787-4882`) are detailed there as well.
