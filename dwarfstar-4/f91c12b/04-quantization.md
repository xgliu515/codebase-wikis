# Chapter 04: Quantization: IQ2_XXS, Q2_K, FP8 KV

> Code version locked to `antirez/ds4@f91c12b` (2026-05-22). All `file:line` refs are repo-root-relative paths at this commit.

## 0. The problem this chapter solves

DeepSeek V4 Flash is a Mixture-of-Experts model with 43 transformer layers and 256 routed experts per layer, of which 6 are activated per token. The fixed shape is encoded directly in `ds4.c:87-116`:

```c
DS4_N_LAYER       = 43
DS4_N_EXPERT      = 256        /* routed experts */
DS4_N_EXPERT_USED = 6          /* per-token activations */
DS4_N_EMBD        = 4096
DS4_N_FF_EXP      = 2048       /* routed expert FFN width */
```

Each routed expert holds three weight matrices (gate, up, down), each of shape `[4096, 2048]` or `[2048, 4096]`. Multiply that out and the routed-expert pool alone is roughly 540 billion parameters. Stored as F16 this would be about 100 GiB, which is more than the entire RAM budget of a 96 GB Apple Silicon laptop, before counting KV cache, embeddings, attention projections, or the indexer.

ds4 is built around a single, deliberate gamble: **quantize only the routed experts, and only with the most aggressive 2-bit formats that GGUF/llama.cpp already ships**. Everything else — attention, the shared MLP, the output projection, the indexer, hyper-connection matrices — stays in Q8_0 or F16. The KV cache trades precision differently: its non-rotated part is squeezed through an E4M3FN round trip and the indexer KV through an E2M1FN round trip with a 128-wide Hadamard mixer.

This chapter walks the four numeric "languages" the engine actually reads:

1. **IQ2_XXS** — 2.0625 bits/weight, used for routed `gate` and `up` matrices, requires an importance matrix (imatrix).
2. **Q2_K** — 2.625 bits/weight, used for routed `down` matrices, no imatrix needed.
3. **Q4_K** — 4.5 bits/weight, optional high-memory variant for routed experts.
4. **Q8_K** — temporary 8-bit activation blocks used to feed the IQ2/Q2 dot kernels.
5. **E4M3FN / E2M1FN** — FP8/FP4-style quantization-aware training (QAT) round trips that simulate, at inference time, the compression the official DeepSeek graph applies to the compressed KV cache and indexer activations.

It also walks the offline tooling under `gguf-tools/` that produces those GGUF files in the first place, the imatrix collector inside the engine, and the official-continuation quality test that decides whether a given recipe is acceptable.

## 1. Why "asymmetric": only routed experts get quantized

Look at the layout validator at `ds4.c:2384-2389` and the per-layer block at `ds4.c:2395-2404`:

```c
tensor_expect_layout(w->token_embd,      DS4_TENSOR_F16,  2, DS4_N_EMBD, DS4_N_VOCAB, 0);
tensor_expect_layout(w->output_hc_base,  DS4_TENSOR_F32,  1, DS4_N_HC, 0, 0);
tensor_expect_layout(w->output_hc_fn,    DS4_TENSOR_F16,  2, hc_dim, DS4_N_HC, 0);
tensor_expect_layout(w->output_norm,     DS4_TENSOR_F32,  1, DS4_N_EMBD, 0, 0);
tensor_expect_layout(w->output,          DS4_TENSOR_Q8_0, 2, DS4_N_EMBD, DS4_N_VOCAB, 0);
...
tensor_expect_layout(l->attn_norm,       DS4_TENSOR_F32,  1, DS4_N_EMBD, 0, 0);
tensor_expect_layout(l->attn_q_a,        DS4_TENSOR_Q8_0, 2, DS4_N_EMBD, DS4_N_LORA_Q, 0);
tensor_expect_layout(l->attn_q_b,        DS4_TENSOR_Q8_0, 2, DS4_N_LORA_Q, q_dim, 0);
tensor_expect_layout(l->attn_kv,         DS4_TENSOR_Q8_0, 2, DS4_N_EMBD, DS4_N_HEAD_DIM, 0);
```

Notice what *isn't* there: no IQ2 or Q2 anywhere. Token embeddings (F16), RMSNorm scales (F32), hyper-connection mixers (F16), attention LoRA projections (Q8_0), the KV projection (Q8_0), and the output logits matrix (Q8_0) all stay at high or near-high precision. Only when we reach the routed-expert tensors does the type relax (configured per-recipe at GGUF generation time; the validator accepts IQ2_XXS, Q2_K, or Q4_K for those slots — see the helper `quant_type_for_routed_expert()` at `ds4.c:2317-2319`).

There are three reasons this asymmetry is the right shape:

1. **The routed pool dominates the parameter count.** 43 layers × 256 experts × ~16 M weights per expert is ~270 GiB worth of parameters at F32. Even halving F16 to 8-bit only takes that to ~67 GiB. Going to 2 bits drops it to ~17 GiB, which is the difference between "runs on a 96 GB MacBook" and "doesn't."
2. **Routed weights are statistically sparse in use.** Six experts out of 256 fire per token. Any given column of any given expert is hit far less often than, say, the `attn_kv` projection that runs every layer for every token. Sparse use means errors don't compound the same way.
3. **The other tensors are tiny and hot.** Token embeddings are 129280 × 4096 = 530 M weights, which is 1 GiB at F16 — cheap. The attention projections are matrices in the few-MB range, but they are hit every token every layer, so their quantization noise would directly attenuate generation quality.

So the recipe is: pay full price (F16/Q8) where it is cheap or critical; pay 2-bit prices only where the savings are enormous and the kernels can compensate with smarter formats. The rest of this chapter is what those smarter formats are.

<svg viewBox="0 0 800 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="DS4 tensor type contract: high-precision tensors stay F16 or Q8_0, only routed expert pool drops to 2-bit quantization">
<defs>
<pattern id="hatch41" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#fca5a5" stroke-width="2"/></pattern>
</defs>
<text x="400" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">DS4 type contract (ds4.c:2384-2515)</text>
<text x="400" y="42" text-anchor="middle" font-size="11" fill="#64748b">Asymmetric quantization: pay full price where cheap or critical; 2-bit only where the savings are enormous</text>
<rect x="40" y="58" width="720" height="178" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5" rx="6"/>
<text x="400" y="78" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">High-precision tier (F16 / F32 / Q8_0) - kept hot, not quantized</text>
<rect x="60" y="90" width="340" height="22" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="3"/>
<text x="70" y="106" font-size="11" font-weight="600" fill="#0d9488">token_embd</text>
<text x="270" y="106" text-anchor="end" font-size="10" fill="#64748b">F16</text>
<text x="390" y="106" text-anchor="end" font-size="10" fill="#64748b">~1 GiB</text>
<rect x="420" y="90" width="320" height="22" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="3"/>
<text x="430" y="106" font-size="11" font-weight="600" fill="#0d9488">output (logits proj)</text>
<text x="730" y="106" text-anchor="end" font-size="10" fill="#64748b">Q8_0 ~ 0.5 GiB</text>
<rect x="60" y="116" width="340" height="22" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="3"/>
<text x="70" y="132" font-size="11" font-weight="600" fill="#0d9488">attn_q_a / q_b / kv / output</text>
<text x="390" y="132" text-anchor="end" font-size="10" fill="#64748b">Q8_0 per-layer x43</text>
<rect x="420" y="116" width="320" height="22" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="3"/>
<text x="430" y="132" font-size="11" font-weight="600" fill="#0d9488">attn_norm, kv_a_norm</text>
<text x="730" y="132" text-anchor="end" font-size="10" fill="#64748b">F32</text>
<rect x="60" y="142" width="340" height="22" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="3"/>
<text x="70" y="158" font-size="11" font-weight="600" fill="#0d9488">hc_attn_fn, hc_ffn_fn</text>
<text x="390" y="158" text-anchor="end" font-size="10" fill="#64748b">F16</text>
<rect x="420" y="142" width="320" height="22" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="3"/>
<text x="430" y="158" font-size="11" font-weight="600" fill="#0d9488">ffn_gate_inp (routing logits)</text>
<text x="730" y="158" text-anchor="end" font-size="10" fill="#64748b">F16</text>
<rect x="60" y="168" width="340" height="22" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="3"/>
<text x="70" y="184" font-size="11" font-weight="600" fill="#0d9488">ffn_*_shexp (shared MLP)</text>
<text x="390" y="184" text-anchor="end" font-size="10" fill="#64748b">Q8_0</text>
<rect x="420" y="168" width="320" height="22" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="3"/>
<text x="430" y="184" font-size="11" font-weight="600" fill="#0d9488">indexer_*</text>
<text x="730" y="184" text-anchor="end" font-size="10" fill="#64748b">F16</text>
<rect x="60" y="194" width="680" height="22" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="3"/>
<text x="70" y="210" font-size="11" font-weight="600" fill="#0d9488">attn / indexer_compressor</text>
<text x="730" y="210" text-anchor="end" font-size="10" fill="#64748b">F16</text>
<rect x="40" y="252" width="720" height="130" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="400" y="272" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">Routed expert pool - THE BIG POOL (~270 GiB at F32)</text>
<text x="400" y="288" text-anchor="middle" font-size="10" fill="#64748b">43 layers x 256 experts x ~16M weights; only 6 fire per token; aggressive 2-bit shrinks to ~17 GiB</text>
<rect x="60" y="300" width="680" height="22" fill="url(#hatch41)" stroke="#ea580c" stroke-width="1" rx="3"/>
<rect x="60" y="300" width="680" height="22" fill="none" stroke="#ea580c" stroke-width="1" rx="3"/>
<text x="70" y="316" font-size="11" font-weight="700" fill="#ea580c">ffn_gate_exps (routed)</text>
<text x="730" y="316" text-anchor="end" font-size="10" fill="#ea580c">IQ2_XXS (needs imatrix) / Q4_K</text>
<rect x="60" y="326" width="680" height="22" fill="url(#hatch41)" stroke="#ea580c" stroke-width="1" rx="3"/>
<rect x="60" y="326" width="680" height="22" fill="none" stroke="#ea580c" stroke-width="1" rx="3"/>
<text x="70" y="342" font-size="11" font-weight="700" fill="#ea580c">ffn_up_exps (routed)</text>
<text x="730" y="342" text-anchor="end" font-size="10" fill="#ea580c">IQ2_XXS (needs imatrix) / Q4_K</text>
<rect x="60" y="352" width="680" height="22" fill="url(#hatch41)" stroke="#ea580c" stroke-width="1" rx="3"/>
<rect x="60" y="352" width="680" height="22" fill="none" stroke="#ea580c" stroke-width="1" rx="3"/>
<text x="70" y="368" font-size="11" font-weight="700" fill="#ea580c">ffn_down_exps (routed)</text>
<text x="730" y="368" text-anchor="end" font-size="10" fill="#ea580c">Q2_K (no imatrix) / Q4_K</text>
</svg>
<span class="figure-caption">Figure R4.1 | DS4 quantization is asymmetric: attention, embeddings, shared MLP, and output stay at F16/Q8_0; only the routed expert pool (gate, up, down) drops to 2-bit IQ2_XXS / Q2_K (or 4-bit Q4_K in the high-memory variant).</span>

<details>
<summary>ASCII fallback</summary>

```
                  ds4.c:2384-2515 type contract
  ┌──────────────────────────────────────────────────────────────┐
  │ token_embd               F16     ~ 1 GiB                      │
  │ output (logits proj)     Q8_0    ~ 0.5 GiB                    │
  │ attn_q_a/q_b/kv/output   Q8_0    small per layer × 43         │
  │ attn_norm, kv_a_norm     F32                                  │
  │ hc_attn_fn, hc_ffn_fn    F16                                  │
  │ ffn_gate_inp             F16     routing logits               │
  │ ffn_*_shexp (shared MLP) Q8_0                                 │
  │ indexer_*                F16                                  │
  │ attn/indexer_compressor  F16                                  │
  ├──────────────────────────────────────────────────────────────┤
  │ ffn_gate_exps (routed)   IQ2_XXS / Q4_K                       │
  │ ffn_up_exps   (routed)   IQ2_XXS / Q4_K       ← THE BIG POOL │
  │ ffn_down_exps (routed)   Q2_K    / Q4_K                       │
  └──────────────────────────────────────────────────────────────┘
```

</details>

## 2. The GGUF type table and the engine's narrow accept-list

GGUF carries a single one-byte tensor-type code per tensor. ds4 declares the full table for diagnostic printing (`ds4.c:877-907`) but the inference paths handle only a tight subset (`ds4.c:909-917`):

```c
/* ds4.c:877 */
static const gguf_type_info gguf_types[] = {
    [0]  = {"f32",      1,   4},
    [1]  = {"f16",      1,   2},
    [8]  = {"q8_0",    32,  34},
    [10] = {"q2_k",   256,  84},
    [12] = {"q4_k",   256, 144},
    [15] = {"q8_k",   256, 292},
    [16] = {"iq2_xxs",256,  66},
    /* others printed for diagnostics, not used by inference */
};

/* ds4.c:909 */
enum {
    DS4_TENSOR_F32      = 0,
    DS4_TENSOR_F16      = 1,
    DS4_TENSOR_Q8_0     = 8,
    DS4_TENSOR_Q2_K     = 10,
    DS4_TENSOR_Q4_K     = 12,
    DS4_TENSOR_IQ2_XXS  = 16,
    DS4_TENSOR_I32      = 26,
};
```

`tensor_type_name()` (`ds4.c:1019`) is the only place the GGUF table is consulted at runtime; everywhere else the code dispatches on the enum above. Anything else in the GGUF file — `iq3_xxs`, `iq4_xs`, `q6_k`, etc. — would be rejected by `tensor_expect_layout()` (`ds4.c:2255-2262`).

This is intentional: ds4 commits to one model family, with one block layout per role. If you add a new format to the runtime, you also extend the validator, the dot-product kernel set, the Metal/CUDA shaders, and the activation quantizer. The narrow enum keeps that surface small.

The static asserts on block sizes (`ds4.c:165-168`) guarantee that the layout described in the source matches what the GGUF file actually stores:

```c
DS4_STATIC_ASSERT(ds4_block_q2_k_size, sizeof(block_q2_K) == 84);
DS4_STATIC_ASSERT(ds4_block_q4_k_size, sizeof(block_q4_K) == 144);
DS4_STATIC_ASSERT(ds4_block_q8_k_size, sizeof(block_q8_K) == 292);
DS4_STATIC_ASSERT(ds4_block_iq2_xxs_size, sizeof(block_iq2_xxs) == 66);
```

If any of those mismatches at compile time, the build fails immediately. The 256-element block size is held in `QK_K` (`ds4.c:137`).

## 3. IQ2_XXS in detail

### 3.1 Block layout

IQ2_XXS ("Importance Quantized 2-bit eXtra eXtra Small") is the most aggressive 2-bit format in the llama.cpp lineage. The block layout (`ds4.c:159-162`):

```c
/* ds4.c:159 */
typedef struct {
    uint16_t d;            /* F16 block scale */
    uint16_t qs[QK_K / 8]; /* 32 uint16 = 64 bytes of packed grid+sign indices */
} block_iq2_xxs;
/* sizeof == 66 bytes for 256 elements => 2.0625 bits per weight */
```

256 elements in 66 bytes, 2.0625 bits per weight. The trick is that each weight is not stored independently. Eight consecutive weights become *one* 8-byte word from a 256-entry codebook (`iq2xxs_grid[]`, `ds4.c:243-308`):

```c
static const uint64_t iq2xxs_grid[256] = {
    0x0808080808080808, 0x080808080808082b, 0x0808080808081919, ...
};
```

Each entry of `iq2xxs_grid` is a packed group of eight bytes; each byte is a small signed integer that, multiplied by the block scale, reconstructs the weight. The packing per block is:

- 4 codebook indices × 8 bits = 32 bits, looking up four 8-weight grid entries.
- 4 sign masks × 7 bits = 28 bits, choosing the sign pattern from `ksigns_iq2xs[128]` (`ds4.c:232-241`).
- 4 bits left over, used as a sub-block scale (`(aux32[1] >> 28)`).

`kmask_iq2xs[8]` (`ds4.c:228-230`) is just `1, 2, 4, ..., 128`: bit-pick into the sign mask.

<svg viewBox="0 0 800 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="IQ2_XXS block memory layout: 2-byte F16 scale plus 64 bytes of packed grid indices, sign masks and sub-block scales encoding 256 weights">
<defs>
<marker id="ar44" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="400" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">block_iq2_xxs: 66 bytes encoding 256 weights (2.0625 bits/weight)</text>
<rect x="40" y="48" width="60" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="3"/>
<text x="70" y="68" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">d</text>
<text x="70" y="82" text-anchor="middle" font-size="10" fill="#64748b">F16 scale</text>
<text x="70" y="106" text-anchor="middle" font-size="9" fill="#94a3b8">2 bytes</text>
<rect x="100" y="48" width="660" height="44" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="3"/>
<text x="430" y="68" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">qs[32] (uint16) = 64 bytes packed grid + sign + sub-scale indices</text>
<text x="430" y="84" text-anchor="middle" font-size="10" fill="#64748b">eight 8-byte sub-blocks; each sub-block covers 32 weights</text>
<text x="430" y="106" text-anchor="middle" font-size="9" fill="#94a3b8">64 bytes</text>
<line x1="430" y1="120" x2="430" y2="140" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar44)"/>
<text x="400" y="155" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">One sub-block (8 bytes = 64 bits) covers 32 weights</text>
<rect x="60" y="170" width="280" height="48" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="3"/>
<text x="200" y="190" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">aux32[0]: 4 grid indices</text>
<text x="200" y="204" text-anchor="middle" font-size="10" fill="#64748b">4 x 8 bits = 32 bits</text>
<text x="200" y="232" text-anchor="middle" font-size="9" fill="#94a3b8">look up iq2xxs_grid[256] - eight int8 per entry</text>
<rect x="350" y="170" width="280" height="48" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="3"/>
<text x="490" y="190" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">aux32[1]: 4 signs + sub-scale</text>
<text x="490" y="204" text-anchor="middle" font-size="10" fill="#64748b">4 x 7 bits (signs) + 4 bits (sub-scale)</text>
<text x="490" y="232" text-anchor="middle" font-size="9" fill="#94a3b8">signs index ksigns_iq2xs[128]; sub-scale = (aux32[1]&gt;&gt;28)</text>
<line x1="200" y1="244" x2="200" y2="260" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar44)"/>
<line x1="490" y1="244" x2="490" y2="260" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar44)"/>
<text x="640" y="252" font-size="10" fill="#64748b" font-style="italic">combine via vmulq_s8</text>
<rect x="100" y="264" width="600" height="56" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" rx="6"/>
<text x="400" y="284" text-anchor="middle" font-size="11" font-weight="700" fill="#16a34a">32 weights = 4 groups of 8 int8s</text>
<text x="400" y="300" text-anchor="middle" font-size="10" fill="#64748b">weight_value = d * (0.5 + sub_scale) * signed_grid_byte</text>
<text x="400" y="316" text-anchor="middle" font-size="10" fill="#64748b">pre-expanded iq2xxs_signed_grid[256][128][8] (256 KiB, L2-resident)</text>
<text x="400" y="346" text-anchor="middle" font-size="11" fill="#64748b">Block total: 2 (d) + 8 sub-blocks x 8 bytes = 66 bytes</text>
<text x="400" y="362" text-anchor="middle" font-size="11" fill="#64748b">Weights total: 8 sub-blocks x 32 weights = 256</text>
</svg>
<span class="figure-caption">Figure R4.4 | The IQ2_XXS block packs 256 weights into 66 bytes via a 256-entry codebook of 8-weight grid groups plus per-sub-block sign masks and sub-scale; only the F16 block scale lives outside the packed payload.</span>

<details>
<summary>ASCII fallback</summary>

```
block_iq2_xxs (66 bytes, 256 weights, 2.0625 bits/weight)
+--------+----------------------------------------------------+
| d (2B) | qs[32] = 64 bytes packed payload                   |
| F16    | (8 sub-blocks, each 8 bytes covers 32 weights)     |
+--------+----------------------------------------------------+
                                |
                                v
One sub-block (64 bits / 32 weights):
+----------------------------+----------------------------+
| aux32[0]: 4 grid idx x 8b  | aux32[1]: 4 sign x 7b      |
|                            |          + sub_scale (4b)  |
+----------------------------+----------------------------+
        ->          ->
  iq2xxs_grid[256]      ksigns_iq2xs[128]
  (8 int8 per entry)    (8-bit sign mask per entry)

weight = d * (0.5 + sub_scale) * signed_grid_byte
```

</details>

### 3.2 The pre-expanded signed grid

The packed grid format is good for storage but expensive to decode in a hot loop, so `ds4.c:310-332` materializes a pre-signed grid the first time any IQ2 kernel runs:

```c
/* ds4.c:310 */
static int8_t iq2xxs_signed_grid[256][128][8];
static int8_t iq2xxs_signs[128][8];
static pthread_once_t iq2xxs_signed_grid_once = PTHREAD_ONCE_INIT;

static void iq2xxs_signed_grid_init(void) {
    for (uint32_t s = 0; s < 128; s++) {
        const uint8_t signs = ksigns_iq2xs[s];
        for (uint32_t j = 0; j < 8; j++) {
            iq2xxs_signs[s][j] = (int8_t)((signs & kmask_iq2xs[j]) ? -1 : 1);
        }
    }
    for (uint32_t g = 0; g < 256; g++) {
        const uint8_t *grid = (const uint8_t *)(iq2xxs_grid + g);
        for (uint32_t s = 0; s < 128; s++) {
            const uint8_t signs = ksigns_iq2xs[s];
            for (uint32_t j = 0; j < 8; j++) {
                const int v = (int)grid[j];
                iq2xxs_signed_grid[g][s][j] = (int8_t)((signs & kmask_iq2xs[j]) ? -v : v);
            }
        }
    }
}
```

`iq2xxs_signed_grid` is a 256 × 128 × 8 table of `int8_t` — 262144 bytes, 256 KiB, fits comfortably in L2 — that gives the dot kernel a single load: `grid_index + sign_index -> 8 signed int8s`. The cost of building it is paid once via `pthread_once`, called from `ds4_threads_init` (`ds4.c:702`).

### 3.3 The dot kernel and its NEON path

The CPU activation × IQ2_XXS-weight dot product lives at `ds4.c:1910-1997`. The fast path requires both `__ARM_NEON` and `__ARM_FEATURE_DOTPROD` (an M3-class Apple Silicon CPU has both). The structure is:

1. Load 64 int8 activation values via `vld1q_s8_x4`.
2. Read four packed `uint16_t` pairs from the block.
3. Decode each packed index into two 16-byte signed grid vectors (two 8-weight groups concatenated).
4. Look up the four sign vectors from `iq2xxs_signs`.
5. Multiply grid × sign with `vmulq_s8`, then accumulate via `vdotq_s32` against the activation.
6. Multiply by the sub-block scale `(0.5f + (aux32[i] >> 28))` and the block scale `d * y[i].d`.

```c
/* ds4.c:1955 */
const int32x4_t p1 = vdotq_s32(vdotq_s32(vdupq_n_s32(0), q2u0, q8b.val[0]),
                                q2u1, q8b.val[1]);
const int32x4_t p2 = vdotq_s32(vdotq_s32(vdupq_n_s32(0), q2u2, q8b.val[2]),
                                q2u3, q8b.val[3]);

sumf1 += (float)vaddvq_s32(p1) * (0.5f + (float)(aux32[1] >> 28));
sumf2 += (float)vaddvq_s32(p2) * (0.5f + (float)(aux32[3] >> 28));
```

The fallback portable path at `ds4.c:1966-1996` uses `dot_iq2_pair_16()` (`ds4.c:334-351`) which itself has three nested fallbacks: dotprod NEON, plain NEON, and scalar. Each step from scalar to dotprod is roughly a 4× speedup, so on commodity hardware without NEON+DOTPROD this kernel is what dominates the prefill time.

### 3.4 The "pair" variant for gate/up co-evaluation

Inside an expert the gate and up matrices have identical shape `[4096, 2048]`. They're always evaluated together — `swiglu(gate(x)) * up(x)` is one expression. `ds4_vec_dot_iq2_xxs_pair_q8_K()` (`ds4.c:1999-2077`) interleaves the two kernels so a single activation load (`vld1q_s8_x4`) feeds both blocks. This saves one quarter of the activation loads when running CPU expert routing (`ds4.c:3925`, `ds4.c:4140`).

### 3.5 Why IQ2_XXS *requires* an imatrix

Look at the quants traits table in `gguf-tools/quants.c:39-74`:

```c
[DS4Q_TYPE_IQ2_XXS] = { "iq2_xxs", QK_K,  66, true,  true  },
[DS4Q_TYPE_Q2_K]    = { "q2_K",  QK_K,  84, true,  false },
[DS4Q_TYPE_Q4_K]    = { "q4_K",  QK_K, 144, true,  false },
[DS4Q_TYPE_Q8_0]    = { "q8_0",    32,  34, true,  false },
```

The fifth field is `requires_imatrix`. IQ2_XXS is the only one of ds4's quantization targets where this is `true`. The reason is purely informational: IQ2_XXS has only 256 codebook entries; the search for the best (grid, sign) pair per group must trade off accuracy in *which* columns. Without imatrix, the quantizer minimizes uniform L2 error and tends to allocate codebook precision to whatever columns happen to be large in the offline weight, even if those columns receive low activations at inference. With imatrix, the per-column importance vector tells the search "spend your error budget here, not there."

When `--imatrix` is not provided but the target requires one, the quantizer in `gguf-tools/deepseek4-quantize.c:1115-1126` falls back to a synthetic weight-energy heuristic:

```c
/* deepseek4-quantize.c:1115 */
float *synthetic = NULL;
const float *im_ptr = imat;
if (!im_ptr && ds4q_requires_imatrix(type)) {
    synthetic = xcalloc((size_t)ncols, sizeof(float));
    for (int64_t r = 0; r < nrows; r++) {
        const float *row = src + (size_t)r * (size_t)ncols;
        for (int64_t c = 0; c < ncols; c++) synthetic[c] += row[c] * row[c];
    }
    im_ptr = synthetic;
}
size_t written = ds4q_quantize_chunk(type, src, out.data, 0, nrows, ncols, im_ptr);
```

This is `importance[col] = sum(weight[col]^2)`. It is not as good as the real activation statistics but it is a stable, deterministic stand-in. The repo README (`gguf-tools/README.md:111-122`) calls it "good enough for the first working 2-bit GGUFs."

## 4. Q2_K in detail

### 4.1 Block layout

Q2_K is the K-quant family's 2-bit member. Block layout (`ds4.c:139-144`):

```c
/* ds4.c:139 */
typedef struct {
    uint8_t  scales[QK_K / 16]; /* 16 bytes: 4-bit scale + 4-bit min per sub-block */
    uint8_t  qs[QK_K / 4];      /* 64 bytes: 2 bits per element */
    uint16_t d;                  /* F16 global scale */
    uint16_t dmin;               /* F16 global min */
} block_q2_K;
/* sizeof = 84 bytes for 256 elements => 2.625 bits per weight */
```

The 256 elements are divided into 16 sub-blocks of 16 elements each. Each sub-block has a 4-bit scale and a 4-bit minimum, packed into 16 bytes. Each weight is reconstructed as roughly `scale * q - min`, where `scale = sub_scale * d` and `min = sub_min * dmin`.

Q2_K has more independent degrees of freedom per 256-element block than IQ2_XXS (16 sub-block scales and mins vs. one codebook index per 8 elements). That is why Q2_K does not require an imatrix: each sub-block can absorb local variation directly.

### 4.2 The dot kernel

The Q2_K × Q8_K kernel is at `ds4.c:1790-1908`. The NEON+DOTPROD path is dense; the structure to memorize is:

1. Load `mins_and_scales` (16 bytes), split into 4-bit scales and 4-bit mins.
2. Compute the `dmin * sum(q8) * sub_min` correction up front using the `y[i].bsums` table — these are the per-16-element pre-summed activations that were computed by `ds4_quantize_row_q8_K` (`ds4.c:1780`). This is exactly why Q8_K carries `bsums` and Q8_0 does not.
3. For each pair of 32 weights, unpack 2 bits at four different shifts (0, 2, 4, 6) and `vdotq_s32` against the activation.
4. Multiply by the per-sub-block scale, accumulate.
5. Final `sum = d * isum + dmin_correction`.

```c
/* ds4.c:1818 */
sum += dmin * (float)vaddvq_s32(vaddq_s32(s0, s1));
...
/* ds4.c:1866 */
sum += d * (float)isum;
```

The compactly named macros `DS4_Q2_DOT_NOSHIFT` and `DS4_Q2_DOT_SHIFT` (`ds4.c:1832-1854`) implement four-way `vdotq_s32` accumulation with one of the four 2-bit slots.

### 4.3 Why down uses Q2_K and gate/up use IQ2_XXS

The routed expert evaluates `swiglu(gate(x)) * up(x)`, then projects with `down`. The input to `gate` and `up` is the FFN-normalized embedding — full-range, structured signal. The input to `down` is the SwiGLU output — a non-linearly squashed product with naturally clipped tails.

Empirically, the smaller-codebook IQ2_XXS damage matters less on the more-uniform `down` input (which is bounded by SwiGLU clamp at `ds4.c:56`: `DS4_SWIGLU_CLAMP_EXP = 10.0`). And Q2_K's larger codebook per sub-block matters less when the input is wide and structured (gate/up). The recipe also lines up with imatrix economics: only IQ2_XXS *needs* imatrix, and gate/up are the matrices that benefit most from activation statistics. So the natural split is: imatrix-sensitive matrices get IQ2_XXS + imatrix, imatrix-insensitive matrices get Q2_K + no imatrix.

This pairing is what makes the typical 2-bit GGUF roughly 80-90 GB on disk — see `gguf-tools/README.md:63-66`.

## 5. Q4_K and the high-memory variant

Q4_K block layout (`ds4.c:146-151`):

```c
typedef struct {
    uint16_t d;
    uint16_t dmin;
    uint8_t  scales[12];
    uint8_t  qs[QK_K / 2];   /* 128 bytes: 4 bits per element */
} block_q4_K;
/* sizeof = 144 bytes => 4.5 bits per weight */
```

The "high-memory" GGUF builds (~150-170 GB, see `gguf-tools/README.md:64-66`) use Q4_K for all three routed matrices. Quality goes up; memory roughly doubles. Q4_K traits at `gguf-tools/quants.c:48` are `requires_imatrix=false`, so the high-memory variant does not need imatrix collection at all. The runtime treats Q4_K like Q2_K from a dispatching perspective: same activation format (Q8_K), different kernel, larger codebook.

Q4_K is also where you go when you want to A/B test imatrix quality without changing the storage footprint dramatically. The quality test in `gguf-tools/quality-testing/` (Section 11) is most often used to compare a Q4_K baseline against a Q2_K + imatrix candidate.

## 6. Q8_K: the activation block format

### 6.1 Why a separate activation format

The IQ2_XXS and Q2_K kernels above are *integer* dot products: `int8 × int8 -> int32`. To use them, the floating-point activation vector must first be converted to int8 with a per-block scale. That converted block is **Q8_K** (`ds4.c:153-157`):

```c
typedef struct {
    float   d;                   /* F32 block scale (note: not F16) */
    int8_t  qs[QK_K];            /* 256 signed 8-bit activations */
    int16_t bsums[QK_K / 16];    /* per-16-element pre-sums for Q2_K */
} block_q8_K;
/* sizeof = 292 bytes */
```

Three things to note:

1. **F32 scale**, not F16. Activations are computed at runtime, so there is no storage pressure to use F16; the slightly tighter scale precision pays off in the final result.
2. **256-element blocks** match QK_K, the same block size as IQ2_XXS and Q2_K. This is not an accident: a single Q8_K block is exactly one block's worth of co-aligned activation for one weight block.
3. **`bsums` is Q2_K-specific.** It is the sum of the 16 int8 quantized activations in each sub-block, pre-computed so Q2_K's `dmin * sum(q8) * sub_min` correction can be evaluated with one `vmull_s16` rather than re-summing the activations inside the dot kernel.

### 6.2 ds4_quantize_row_q8_K

The activation quantizer (`ds4.c:1750-1788`):

```c
/* ds4.c:1750 */
static void ds4_quantize_row_q8_K(const float *x, block_q8_K *y, int64_t k) {
    if (k % QK_K != 0) ds4_die("Q8_K quantization length is not QK_K aligned");
    const int64_t nb = k / QK_K;

    for (int64_t b = 0; b < nb; b++) {
        float max = 0.0f;
        float amax = 0.0f;
        for (int j = 0; j < QK_K; j++) {
            const float ax = fabsf(x[j]);
            if (ax > amax) { amax = ax; max = x[j]; }  /* signed value of the absmax */
        }
        if (amax == 0.0f) { /* zero block fast path */ ... continue; }

        const float iscale = -127.0f / max;            /* signed scale, see comment */
        for (int j = 0; j < QK_K; j++) {
            int v = (int)lrintf(iscale * x[j]);
            if (v > 127) v = 127;
            if (v < -128) v = -128;
            y[b].qs[j] = (int8_t)v;
        }
        for (int j = 0; j < QK_K / 16; j++) {
            int sum = 0;
            for (int i = 0; i < 16; i++) sum += y[b].qs[j * 16 + i];
            y[b].bsums[j] = (int16_t)sum;
        }
        y[b].d = 1.0f / iscale;
        x += QK_K;
    }
}
```

The `-127 / max` choice (vs. `127 / amax`) is what makes this a *signed* quantizer that preserves the sign of the maximum-magnitude element. Recovering the float value is `y[b].d * qs[j]` (where `d = 1/iscale = -max/127`).

`bsums[j]` is exactly what Q2_K's `dmin` correction needs (`ds4.c:1818-1824`). Computing it during quantization rather than during the dot product is a small but consistent win: each activation is read once during quantization and never during the per-expert dot loop.

### 6.3 Sharing the activation across experts

A single token activates six routed experts per layer. The activation vector is the same for all six. The CPU expert loop calls `ds4_quantize_row_q8_K` **once** per token, then reuses the same Q8_K blocks for all six expert dot products:

```c
/* ds4.c:4015 */
ds4_quantize_row_q8_K(x, xq, (int64_t)in_dim);
...
/* ds4.c:5406 */
ds4_quantize_row_q8_K(x, xq, (int64_t)expert_in_dim);
...
/* ds4.c:5425 */
ds4_quantize_row_q8_K(mid_all + (uint64_t)i * down_in_dim, ...);
```

The same shared-Q8K pattern applies to the down stage: the SwiGLU intermediate is quantized once and used across the six selected experts. This is one of the reasons the CPU path is not laughably slow despite using 2-bit weight kernels.

## 7. FP8 KV: E4M3FN and the indexer's E2M1FN + Hadamard

### 7.1 The official model's KV compression

DeepSeek V4 Flash's KV cache is itself partially quantized. The non-rotary part of each KV row is rounded through an FP8 (E4M3FN) format. The indexer compresses its per-row activations through an FP4 (E2M1FN) format *after* a 128-wide Hadamard rotation. The official inference graph emits cache values that have gone through this round trip, so the CPU reference path must do the same — otherwise its KV cache values would be slightly off, and any layer-by-layer GPU/CPU correctness check would diverge.

This is QAT applied at inference time: the format simulates the loss the official graph trained against, so the model sees what it expects.

### 7.2 E4M3FN dequantization

The E4M3FN value table (`ds4.c:1611-1624`):

```c
/* ds4.c:1611 */
static float dsv4_e4m3fn_value_cpu(int i) {
    static const float exp_scale[16] = {
        0.0f, 0.015625f, 0.03125f, 0.0625f,
        0.125f, 0.25f, 0.5f, 1.0f,
        2.0f, 4.0f, 8.0f, 16.0f,
        32.0f, 64.0f, 128.0f, 256.0f,
    };
    const int exp = (i >> 3) & 0x0f;
    const int mant = i & 0x07;
    return exp == 0
        ? (float)mant * 0.001953125f
        : (1.0f + (float)mant * 0.125f) * exp_scale[exp];
}
```

E4M3FN is "4 exponent bits, 3 mantissa bits, finite-only" — no infinities or NaNs. The encoder is at `ds4.c:1626-1651`: it clamps to ±448 (the max representable), binary-searches for the nearest representable value, applies banker's rounding on ties, and reapplies the sign. The per-block round-trip used for the actual KV scratch is `dsv4_fp8_kv_quantize_row_inplace_cpu` (`ds4.c:1656-1674`):

```c
/* ds4.c:1656 */
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

Three points:

- The function only touches `n_nope = head_dim - n_rot` elements. The rotary part of the KV row is left untouched — RoPE is sensitive to small phase rotations, so quantizing through it would degrade attention quality more than the storage savings justify.
- The scale is a power of two (`ldexpf(1.0f, ceilf(log2f(amax / 448.0f)))`), which means the quantization induces no extra rounding in the scale itself; the only loss is in the E4M3FN value table.
- Block size is 64. That is the "tile" the model was trained against.

This routine is called immediately after every K/V projection in the CPU reference path — see the call sites at `ds4.c:6604`, `6692`, `7128`, `7361`, `7610`, `7980`, `10561`, `10794`, `17533`.

### 7.3 E2M1FN values

```c
/* ds4.c:1676 */
static float dsv4_e2m1fn_value_cpu(int i) {
    static const float values[8] = {
        0.0f, 0.5f, 1.0f, 1.5f, 2.0f, 3.0f, 4.0f, 6.0f,
    };
    return values[i & 7];
}
```

E2M1FN is "2 exponent bits, 1 mantissa bit, finite-only" — a total of 8 representable nonnegative magnitudes. Combined with a sign bit it's a 4-bit FP4 format. The dequant routine (`ds4.c:1683-1696`) and per-32-element row round-trip (`dsv4_fp4_act_quantize_row_inplace_cpu`, `ds4.c:1712-1730`) follow the same pattern as E4M3FN.

### 7.4 The indexer QAT: Hadamard + FP4

```c
/* ds4.c:1698 */
static void dsv4_hadamard128_inplace_cpu(float *x) {
    for (uint32_t stride = 1; stride < 128; stride <<= 1) {
        for (uint32_t base = 0; base < 128; base += 2u * stride) {
            for (uint32_t i = 0; i < stride; i++) {
                const float a = x[base + i];
                const float b = x[base + stride + i];
                x[base + i] = a + b;
                x[base + stride + i] = a - b;
            }
        }
    }
    for (uint32_t i = 0; i < 128; i++) x[i] *= 0.08838834764831845f;
}
```

This is the Walsh-Hadamard transform applied in place. The factor `0.0883883...` is `1/sqrt(128)`, normalizing the transform. The Hadamard mixer + FP4 round trip is called as a pair (`ds4.c:1736-1740`):

```c
static void dsv4_indexer_qat_row_inplace_cpu(float *x, uint32_t head_dim) {
    if (head_dim != 128) ds4_die("DSV4 indexer QAT expects 128-wide indexer rows");
    dsv4_hadamard128_inplace_cpu(x);
    dsv4_fp4_act_quantize_row_inplace_cpu(x, head_dim);
}
```

Why Hadamard before FP4? FP4 has only 8 magnitudes, so naïve quantization of indexer activations would discard signal in directions where one or two channels dominate. The Hadamard transform spreads the row's energy across all 128 channels, making the FP4 buckets roughly uniform.

<svg viewBox="0 0 760 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Indexer QAT pipeline: Hadamard 128 transform then FP4 E2M1FN round trip before top-k selection">
<defs>
<marker id="ar42" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Indexer QAT pipeline (CPU reference path)</text>
<rect x="180" y="44" width="400" height="40" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" rx="6"/>
<text x="380" y="62" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">indexer Q / indexer compressor KV rows</text>
<text x="380" y="76" text-anchor="middle" font-size="10" fill="#64748b">128-wide float rows from the attention compressor stage</text>
<line x1="380" y1="84" x2="380" y2="100" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar42)"/>
<rect x="120" y="104" width="520" height="92" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="380" y="126" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">Hadamard 128 (inplace)</text>
<text x="630" y="126" text-anchor="end" font-size="10" fill="#94a3b8">ds4.c:1698</text>
<text x="380" y="146" text-anchor="middle" font-size="11" fill="#64748b">Walsh-Hadamard butterfly through 7 stages (stride 1, 2, 4, ..., 64)</text>
<text x="380" y="162" text-anchor="middle" font-size="11" fill="#64748b">spreads row energy across all 128 channels</text>
<text x="380" y="182" text-anchor="middle" font-size="11" fill="#64748b">final scale by 1/sqrt(128) = 0.0883883...</text>
<line x1="380" y1="196" x2="380" y2="212" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar42)"/>
<rect x="120" y="216" width="520" height="120" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="380" y="238" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">FP4 (E2M1FN) row round trip</text>
<text x="630" y="238" text-anchor="end" font-size="10" fill="#94a3b8">ds4.c:1712</text>
<text x="380" y="258" text-anchor="middle" font-size="11" fill="#64748b">32-element blocks; per-block amax</text>
<text x="380" y="274" text-anchor="middle" font-size="11" fill="#64748b">power-of-2 scale = ldexpf(1.0, ceilf(log2(amax / 6.0)))</text>
<text x="380" y="290" text-anchor="middle" font-size="11" fill="#64748b">clamp to +/-6.0; dequant via dsv4_e2m1fn_value_cpu()</text>
<text x="380" y="306" text-anchor="middle" font-size="11" fill="#64748b">8 nonneg magnitudes: 0, 0.5, 1, 1.5, 2, 3, 4, 6 + sign bit</text>
<text x="380" y="324" text-anchor="middle" font-size="10" fill="#ea580c">simulates inference-time loss the official graph trained against (QAT)</text>
<line x1="380" y1="336" x2="380" y2="352" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar42)"/>
<rect x="180" y="356" width="400" height="36" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" rx="6"/>
<text x="380" y="378" text-anchor="middle" font-size="12" font-weight="700" fill="#16a34a">sparse top-k selector input (uniform FP4 buckets)</text>
</svg>
<span class="figure-caption">Figure R4.2 | The indexer QAT pipeline: a 128-wide Hadamard mixer spreads row energy across channels so the subsequent FP4 round trip's 8 magnitudes are used uniformly.</span>

<details>
<summary>ASCII fallback</summary>

```
   indexer Q / indexer compressor KV rows
              │
              ▼
   ┌───────────────────────────────┐
   │ Hadamard 128 (inplace)        │  ds4.c:1698
   │   - butterfly through 7 stages│
   │   - scale by 1/sqrt(128)      │
   └───────────────────────────────┘
              │
              ▼
   ┌───────────────────────────────┐
   │ FP4 (E2M1FN) row round trip   │  ds4.c:1712
   │   - 32-element blocks         │
   │   - power-of-2 scale          │
   │   - clamp to ±6.0             │
   │   - dequant via dsv4_e2m1fn   │
   └───────────────────────────────┘
              │
              ▼
   sparse top-k selector input
```

</details>

Both rotations apply to **CPU-path activations**, not to stored weights. They make the CPU reference behave bit-equivalently to what the Metal/CUDA backend graphs produce (which apply the same QAT in shader code).

## 8. The IQ2 lookup tables shared with CUDA

`ds4_iq2_tables_cuda.inc` (77 lines, `ds4_iq2_tables_cuda.inc:1-77`) is a single-purpose include file: it re-exports `iq2xxs_grid` and `ksigns_iq2xs` with CUDA `__device__ __constant__` markers:

```c
/* ds4_iq2_tables_cuda.inc:1 */
__device__ __constant__ uint8_t cuda_ksigns_iq2xs[128] = {
    0, 129, 130,   3, ...
};

__device__ __constant__ uint64_t cuda_iq2xxs_grid[256] = {
    0x0808080808080808, 0x080808080808082b, ...
};
```

The byte-for-byte values are identical to those in `ds4.c:232-308`. Keeping them in a separate `.inc` lets `ds4_cuda.cu` `#include` them as constant memory while `ds4.c` declares them as `static const` arrays without any cross-cuda-from-c contamination of the C compilation unit.

The signed pre-expansion (`iq2xxs_signed_grid`) is *not* in the CUDA `.inc`: the CUDA kernels prefer to compute the sign on the fly using bit ops because constant memory is tight (64 KiB per device on most NVIDIA generations), and 256 × 128 × 8 = 256 KiB of pre-expanded grid would not fit.

## 9. gguf-tools/ — the offline quantizer

### 9.1 Directory map

```text
gguf-tools/
  deepseek4-quantize.c      HF safetensors → GGUF quantizer (1888 lines, pure C)
  quants.c                  quantization back-end (1109 lines)
  quants.h                  narrow API (75 lines)
  imatrix/
    dataset/
      build_ds4_imatrix_dataset.py   calibration dataset builder
  mixed/                     auxiliary mixed-precision recipes
  quality-testing/           NLL-based quality comparison vs. official API
    collect_official.py      pulls reference continuations
    score_official.c         scores a local GGUF against them
    compare_scores.py        diffs two .tsv result files
    prompts.jsonl            100 test prompts
  Makefile                   plain C, no GGML dependency
  README.md                  usage
```

### 9.2 quants.h API surface

```c
/* gguf-tools/quants.h:62 */
const char *ds4q_type_name(ds4q_type type);
bool   ds4q_can_quantize(ds4q_type type);
int64_t ds4q_block_size(ds4q_type type);
size_t ds4q_row_size(ds4q_type type, int64_t ne);
bool   ds4q_requires_imatrix(ds4q_type type);
void   ds4q_quantize_init(ds4q_type type);
size_t ds4q_quantize_chunk(ds4q_type type, const float *src, void *dst,
                           int64_t start, int64_t nrows, int64_t ncols,
                           const float *imatrix);
```

The enum (`gguf-tools/quants.h:18-55`) has values numerically equal to the GGUF type codes so the template GGUF metadata can be copied through without translation. Only four formats can be emitted as *output*: Q8_0, Q2_K, Q4_K, IQ2_XXS — the same four the ds4 runtime accepts. All other formats listed in the enum exist only for parsing input tensors that already happen to be in those types.

### 9.3 The HF safetensors path

The HF reference release of DeepSeek V4 Flash stores weights as a hybrid: dense weights in FP8 (E4M3), routed expert weights in FP4 (packed two-per-byte). `dequant_fp4_weight()` (`gguf-tools/deepseek4-quantize.c:709`) handles the routed pool: input is `(in_dim, out_dim/2)` packed bytes plus an E8M0 (8-bit exponent only) scale, output is F32 of the natural shape.

The CLI flags map directly to "which family of tensors gets which type" (`gguf-tools/deepseek4-quantize.c:1700-1710`):

```text
--experts TYPE          routed gate/up/down → TYPE
--routed-w1 TYPE        routed gate only
--routed-w2 TYPE        routed down only
--routed-w3 TYPE        routed up only
--attention-proj TYPE   attn_q/kv/output projections
--shared TYPE           shared expert tensors
--output TYPE           output.* family
--dense TYPE            remaining 2D+ non-routed tensors
--tensor-type PFX=TYPE  exact prefix override; may repeat
```

The template GGUF mechanism (`gguf-tools/deepseek4-quantize.c:11`) is critical: the quantizer doesn't synthesize GGUF metadata from scratch. Instead it reads an already-built GGUF and copies all metadata (tokenizer tables, tensor name order, shapes) into the output, replacing only the byte contents. This keeps the output bit-compatible with prior releases for everything except the quantized payload.

### 9.4 Imatrix file format

The legacy llama.cpp `.dat` binary format is the lingua franca:

```
int32 n_entries
  repeated n_entries times:
    int32 name_len
    char[] name
    int32 ncall
    int32 nval               ← n_expert × n_columns
    float32[nval] values
int32 n_chunks               ← optional footer
int32 dataset_len            ← optional footer
char[] dataset_path
```

The ds4 collector reads/writes this format (`ds4.c:13473-13501` for writing, `gguf-tools/deepseek4-quantize.c:759-810` for reading). For ds4, each tensor entry is a contiguous block of `n_expert * n_columns` floats — the quantizer slices the vector for each expert as it processes the routed pool (`gguf-tools/deepseek4-quantize.c:817-836`).

## 10. The in-engine imatrix collector

### 10.1 What it samples

`ds4_imatrix_collector` (`ds4.c:13360-13375`) keeps three arrays:

```c
typedef struct {
    float *gate_up_sum2;   /* [layer][expert][DS4_N_EMBD] = [43][256][4096]   */
    float *down_sum2;      /* [layer][expert][DS4_N_FF_EXP] = [43][256][2048] */
    uint32_t gate_up_count[DS4_N_LAYER][DS4_N_EXPERT];
    uint32_t down_count[DS4_N_LAYER][DS4_N_EXPERT];
    ...
} ds4_imatrix_collector;
```

`gate_up_sum2[il][e][c]` accumulates `sum_over_observed_tokens(activation[c]^2)` for layer `il`, expert `e`, column `c` — but only for tokens that were actually routed through expert `e`. `gate_up_count[il][e]` records how many tokens that was, so the final imatrix value is `sum2 / count` (`ds4.c:13494-13497`).

### 10.2 The per-layer batch

`imatrix_collect_layer_batch` (`ds4.c:13414-13467`) is called once per layer per prefill chunk, after the GPU graph has finished that layer's expert dispatch. It reads three GPU tensors into CPU buffers:

```c
/* ds4.c:13429 */
if (ds4_gpu_tensor_read(g->batch_ffn_norm, 0, c->ffn_norm_buf, norm_bytes) == 0 ||
    ds4_gpu_tensor_read(g->batch_routed_mid, 0, mid_dst, mid_bytes) == 0 ||
    ds4_gpu_tensor_read(g->batch_router_selected, 0, c->selected_buf, sel_bytes) == 0)
{
    return false;
}
```

`batch_ffn_norm` is the FFN-normalized embedding (input to gate/up); `batch_routed_mid` is the SwiGLU output (input to down); `batch_router_selected` is the chosen expert IDs. The loop at `ds4.c:13436-13463` then walks each token and each of its `DS4_N_EXPERT_USED = 6` slots, accumulating into the appropriate per-expert column statistics.

`batch_routed_mid_is_f16` (`ds4.c:13424`) selects the storage type of the intermediate; for the F16 path the values are dequantized into floats before squaring.

### 10.3 The CLI surface

```text
--imatrix-dataset FILE     calibration text in ds4 rendered format
--imatrix-out FILE         output .dat file path
--imatrix-max-prompts N    stop after N prompts
--imatrix-max-tokens N     stop after N tokens
```

CLI parsing at `ds4_cli.c:173-179` and `ds4_cli.c:1507-1517`. Both `--imatrix-dataset` and `--imatrix-out` must be specified together (`ds4_cli.c:1556-1561`); the public API call is `ds4_engine_collect_imatrix()` (`ds4.h:118-123`, implementation at `ds4.c:17259`).

The implementation currently requires Metal: `ds4.c:17276-17279` explicitly rejects CPU and CUDA backends because the GPU graph's `batch_*` intermediate tensors are only kept as separate readable buffers in the Metal graph path.

## 11. The quality test

### 11.1 Metric: target-token NLL

The quality test in `gguf-tools/quality-testing/` computes:

```
NLL(model, prompt) = mean over tokens t in official_continuation:
                       -log P_model(t | prompt + continuation[:t])
```

Lower is better. It is deterministic, reproducible, and has none of the variance problems of "ask once and judge."

### 11.2 Pipeline

1. **Collect official continuations** (`collect_official.py`, `quality-testing/README.md:11-22`): hits the DeepSeek API with 100 prompts from `prompts.jsonl`, asks for 24-token continuations, writes:
   ```
   data/prompts/case_*.txt
   data/continuations/case_*.txt
   data/responses/case_*.json
   data/manifest.tsv
   ```
2. **Build the local scorer** (`make -C gguf-tools quality-score`, `README:34-36`): compiles `score_official.c` linked against the DS4 runtime, defaulting to Metal.
3. **Score a GGUF** (`score_official MODEL.gguf manifest.tsv out.tsv 4096`): for each case, prefills the prompt, then walks the official continuation token by token, computing the log probability the model assigns. Output is one row per case in TSV.
4. **Compare two TSVs** (`compare_scores.py`): emits `avg_nll`, `delta_new_minus_old`, `case_wins_new_old_ties`, `first_token_matches`, `avg_greedy_lcp`.

The README is explicit about what each metric means (`quality-testing/README.md:62-71`):

- `avg_nll` — lower is better.
- `delta_new_minus_old` — negative means the new GGUF fits the official continuation better.
- `first_token_matches` — fraction of cases where the local greedy first token matches the official first token.
- `avg_greedy_lcp` — mean longest common prefix between the local greedy decode and the official continuation.

### 11.3 Why this metric beats spot-sampling

Asking "is this output good?" requires a human or a strong reference model in the loop. The NLL metric requires only that the official DeepSeek API can give a continuation. Two GGUF variants of the same model can be ranked numerically and reproducibly. If `delta_new_minus_old` is negative across 100 cases, the new recipe is closer to the official model. This is how the project decides whether a new imatrix or quantization mix is worth shipping.

The same pipeline is also what catches regressions in the runtime: if the Metal backend ever drifts numerically, the NLL would jump even with the same GGUF.

## 12. Quick reference

```text
GGUF tensor       Type     bits/w    imatrix    Where in ds4
─────────────────────────────────────────────────────────────────────
ffn_gate_exps     IQ2_XXS   2.06      required   ds4.c:1910 (NEON kernel)
ffn_up_exps       IQ2_XXS   2.06      required   ds4.c:1910
ffn_down_exps     Q2_K      2.63      none       ds4.c:1790 (NEON kernel)
                  (or Q4_K  4.5       none, hi-mem variant)

attn_q_a/q_b      Q8_0      8.5       none       ds4.c:2399-2401
attn_kv           Q8_0      8.5       none       ds4.c:2402
attn_output_a/b   Q8_0      8.5       none
ffn_*_shexp       Q8_0      8.5       none       (shared MLP)
output            Q8_0      8.5       none       ds4.c:2389

token_embd        F16      16         —          ds4.c:2384
hc_attn_fn, etc.  F16      16         —          ds4.c:2386
ffn_gate_inp      F16      16         —          routing logits
attn/indexer_compressor F16  16       —
attn_norm, ...    F32      32         —          RMSNorm scales

activations:      Q8_K     9.13       —          ds4.c:1750 (built at runtime)
KV cache (nope):  E4M3FN   8          —          ds4.c:1656 (CPU QAT round trip)
Indexer activations: E2M1FN+Hadamard 4 (rotated) — ds4.c:1736
```

Block bytes (`ds4.c:165-168`):

```
block_q2_K:       84 bytes / 256 elements
block_q4_K:      144 bytes / 256 elements
block_q8_K:      292 bytes / 256 elements   (activation only)
block_iq2_xxs:    66 bytes / 256 elements
block_q8_0:       34 bytes /  32 elements   (no struct; via gguf_types[8])
```

## 13. Per-tensor type expectations in detail

Section 1 listed the validator calls. They are scattered across `ds4.c:2384-2515` because each tensor role gets one call. The pattern is the same throughout: `tensor_expect_layout` takes the bound `ds4_tensor *`, the expected type code, the number of dimensions, and the dimensions themselves.

For the routed pool, the validator allows three types (`ds4.c:2317-2319`):

```c
/* ds4.c:2317 */
return type == DS4_TENSOR_IQ2_XXS ||
       type == DS4_TENSOR_Q2_K ||
       type == DS4_TENSOR_Q4_K;
```

This is the only place in `ds4.c` where a type accept-set is broader than a single type — every other tensor must be exactly the type declared in `tensor_expect_layout`. The flexibility is necessary because a single ds4 binary needs to handle both the 2-bit recipes (IQ2_XXS + Q2_K) and the 4-bit recipes (Q4_K everywhere on routed). The Metal/CUDA shaders dispatch on the runtime type read from the GGUF.

```c
/* ds4.c:2322 */
static size_t tensor_block_bytes_routed(uint32_t type) {
    switch (type) {
    case DS4_TENSOR_IQ2_XXS: return sizeof(block_iq2_xxs);
    case DS4_TENSOR_Q2_K:    return sizeof(block_q2_K);
    case DS4_TENSOR_Q4_K:    return sizeof(block_q4_K);
    /* default ds4_die */
    }
}
```

`tensor_expect_layout` itself (`ds4.c:2255-2271`) builds a friendly error containing the GGUF name and both expected and actual types:

```c
fprintf(stderr, "ds4: tensor '%.*s' has type %s but expected %s\n",
        (int)t->name.len, t->name.ptr,
        tensor_type_name(t->type), tensor_type_name(type));
ds4_die("tensor type mismatch");
```

The cost of a one-time validation pass is well worth it: a single misnamed tensor in the GGUF would otherwise manifest as silent garbage output much later in the pipeline.

## 14. Caching the activation block across experts in detail

Look at the expert routing code at `ds4.c:5500-5520`:

```c
/* ds4.c:5500 */
ds4_quantize_row_q8_K(x, xq, (int64_t)expert_in_dim);
/* xq is now a Q8_K-quantized snapshot of the FFN-normed activation */

/* ... within a routed-expert loop that runs DS4_N_EXPERT_USED times ... */
for (uint32_t slot = 0; slot < n_expert_active; slot++) {
    const uint32_t expert = selected[slot];
    /* gate row × xq → gate value */
    /* up row × xq → up value */
    /* combine via SwiGLU, write into mid_all */
}

ds4_quantize_row_q8_K(mid_all + (uint64_t)i * down_in_dim,
                      midq + (uint64_t)i * (down_in_dim / QK_K),
                      (int64_t)down_in_dim);
/* midq is now Q8_K-quantized snapshot of the SwiGLU intermediate */

for (uint32_t slot = 0; slot < n_expert_active; slot++) {
    /* down row × midq → contribution; accumulate */
}
```

This is the cost-savings trick that makes the CPU path tolerable. Without it, each expert would re-quantize the same activation, paying the `~4 KiB → ~1.5 KiB` quantization cost six times per token per layer (43 layers × 6 experts × 2 stages = 516 redundant Q8_K conversions per token, all of identical data). With shared `xq` and `midq`, that becomes 2 × 43 = 86 conversions, each shared across 6 experts.

The Q8_K block format described in Section 6 was designed with this sharing in mind: the `bsums` field is constant across all consumers, so computing it once during the shared quantization is a strict win.

## 15. End-to-end quantization data flow

<svg viewBox="0 0 880 580" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="End-to-end quantization flow: HF safetensors to GGUF via offline quantizer, runtime dequantization, then NLL quality test">
<defs>
<marker id="ar43" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="440" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">End-to-end quantization data flow</text>
<rect x="280" y="40" width="320" height="36" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5" rx="6"/>
<text x="440" y="60" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">HF safetensors</text>
<text x="440" y="72" text-anchor="middle" font-size="10" fill="#64748b">FP8 (E4M3) dense + FP4 (packed) routed experts</text>
<line x1="440" y1="76" x2="440" y2="92" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar43)"/>
<text x="600" y="88" font-size="10" fill="#64748b">gguf-tools/deepseek4-quantize.c</text>
<rect x="40" y="96" width="800" height="124" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="440" y="116" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">Offline quantizer (gguf-tools/)</text>
<text x="60" y="138" font-size="11" font-weight="600" fill="currentColor">1. Read template GGUF</text>
<text x="60" y="152" font-size="10" fill="#64748b">metadata, tensor name order, shapes</text>
<text x="320" y="138" font-size="11" font-weight="600" fill="currentColor">2. Per tensor</text>
<text x="320" y="152" font-size="10" fill="#64748b">target type from --experts, --attention-proj, ...</text>
<text x="320" y="166" font-size="10" fill="#64748b">dequant_fp8 / dequant_fp4 -&gt; F32</text>
<text x="320" y="180" font-size="10" fill="#64748b">requires_imatrix? synthesize = sum(row^2) if missing</text>
<text x="320" y="194" font-size="10" fill="#64748b">ds4q_quantize_chunk -&gt; packed bytes</text>
<text x="320" y="208" font-size="10" fill="#64748b">routed pool: pthreads across experts</text>
<text x="60" y="180" font-size="11" font-weight="600" fill="currentColor">3. Write output GGUF</text>
<text x="60" y="194" font-size="10" fill="#64748b">header copied; bodies replaced</text>
<text x="60" y="208" font-size="10" fill="#64748b">bit-compatible w/ prior releases</text>
<line x1="440" y1="220" x2="440" y2="236" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar43)"/>
<text x="600" y="232" font-size="10" fill="#64748b">./ds4 -m model.gguf</text>
<rect x="40" y="240" width="800" height="200" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="440" y="260" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">Runtime (ds4)</text>
<text x="60" y="282" font-size="11" font-weight="600" fill="currentColor">4. ds4_engine_open</text>
<text x="60" y="298" font-size="10" fill="#64748b">model_open: mmap GGUF</text>
<text x="60" y="312" font-size="10" fill="#64748b">config_validate_model: shape + type checks</text>
<text x="60" y="326" font-size="10" fill="#64748b">weights_bind: point ds4_layer_weights at mmap</text>
<text x="440" y="282" font-size="11" font-weight="600" fill="currentColor">5. ds4_session_sync (per token, per layer)</text>
<text x="440" y="298" font-size="10" fill="#64748b">ds4_quantize_row_q8_K(x, xq) once</text>
<text x="440" y="312" font-size="10" fill="#64748b">for each of 6 routed experts:</text>
<text x="440" y="326" font-size="10" fill="#64748b">  ds4_vec_dot_iq2_xxs_pair_q8_K(gate, up, xq)</text>
<text x="440" y="340" font-size="10" fill="#64748b">ds4_quantize_row_q8_K(swiglu_mid, midq) once</text>
<text x="440" y="354" font-size="10" fill="#64748b">for each routed expert: ds4_vec_dot_q2_K_q8_K(down, midq)</text>
<text x="440" y="368" font-size="10" fill="#64748b">KV after attn: dsv4_fp8_kv_quantize (E4M3FN)</text>
<text x="440" y="382" font-size="10" fill="#64748b">Indexer Q/K rows: Hadamard128 + FP4 (E2M1FN)</text>
<text x="60" y="408" font-size="10" fill="#0d9488" font-weight="600">Q8_K activation shared across 6 experts; bsums prepaid once.</text>
<text x="60" y="424" font-size="10" fill="#0d9488" font-weight="600">Total: 2 x 43 = 86 conversions/token (vs 516 naive).</text>
<line x1="440" y1="440" x2="440" y2="456" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar43)"/>
<text x="600" y="452" font-size="10" fill="#64748b">gguf-tools/quality-testing/score_official</text>
<rect x="40" y="460" width="800" height="108" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" rx="6"/>
<text x="440" y="480" text-anchor="middle" font-size="12" font-weight="700" fill="#16a34a">6. NLL quality test</text>
<text x="60" y="502" font-size="10" fill="#64748b">prompts.jsonl (100 cases) + collect_official.py -&gt; manifest.tsv</text>
<text x="60" y="518" font-size="10" fill="#64748b">score_official MODEL.gguf manifest.tsv out.tsv 4096</text>
<text x="60" y="534" font-size="10" fill="#64748b">compare_scores.py old.tsv new.tsv -&gt; delta_new_minus_old</text>
<text x="60" y="558" font-size="11" font-weight="700" fill="#16a34a">Ship if delta is negative and case_wins favors the new recipe.</text>
</svg>
<span class="figure-caption">Figure R4.3 | The full pipeline: offline quantizer rewrites tensor bodies from HF safetensors into a GGUF the runtime reads with shared-Q8K activation quantization; the NLL test gates which recipes ship.</span>

<details>
<summary>ASCII fallback</summary>

```
   HF safetensors (FP8 / FP4 packed)
         │
         ▼   gguf-tools/deepseek4-quantize.c
   ┌──────────────────────────────────────────────────────────────┐
   │ 1. Read template GGUF: metadata, tensor name order, shapes   │
   │                                                              │
   │ 2. For each tensor:                                          │
   │      - Decide target type from CLI flags (--experts, etc.)   │
   │      - dequant_fp8_weight() or dequant_fp4_weight() → F32    │
   │      - If type requires_imatrix and no imatrix given:        │
   │            synthesize importance = sum(row^2)                │
   │      - ds4q_quantize_chunk() → packed bytes                  │
   │      - Routed pool: parallelize across experts via pthreads  │
   │                                                              │
   │ 3. Write output GGUF: header copied from template, bodies    │
   │    replaced.                                                 │
   └──────────────────────────────────────────────────────────────┘
         │
         ▼   ds4 ./ds4 -m model.gguf
   ┌──────────────────────────────────────────────────────────────┐
   │ 4. ds4_engine_open                                           │
   │      - model_open: mmap GGUF                                 │
   │      - config_validate_model: shape and type checks          │
   │      - weights_bind: point ds4_layer_weights at mmap         │
   │                                                              │
   │ 5. ds4_session_sync                                          │
   │      - For each token, for each layer:                       │
   │          ds4_quantize_row_q8_K(x, xq) once                   │
   │          for each routed expert in DS4_N_EXPERT_USED:        │
   │              ds4_vec_dot_iq2_xxs_pair_q8_K(gate, up, xq)    │
   │          ds4_quantize_row_q8_K(swiglu_mid, midq) once        │
   │          for each routed expert:                             │
   │              ds4_vec_dot_q2_K_q8_K(down, midq)               │
   │          KV after attn projection:                           │
   │              dsv4_fp8_kv_quantize_row_inplace_cpu (E4M3FN)   │
   │          Indexer Q/K rows:                                   │
   │              dsv4_hadamard128_inplace_cpu + FP4 (E2M1FN)     │
   └──────────────────────────────────────────────────────────────┘
         │
         ▼   gguf-tools/quality-testing/score_official
   ┌──────────────────────────────────────────────────────────────┐
   │ 6. NLL evaluation against DeepSeek API continuations         │
   │      - prompts.jsonl + collect_official.py → manifest.tsv    │
   │      - score_official MODEL.gguf manifest.tsv out.tsv 4096   │
   │      - compare_scores.py old.tsv new.tsv → delta_new_minus_old│
   │                                                              │
   │    Decision: ship if delta is negative and case_wins favors  │
   │    the new recipe.                                           │
   └──────────────────────────────────────────────────────────────┘
```

</details>

## 16. Why FP8 for KV but Q8_0 for projections

A natural question: if FP8 is more accurate per byte than Q8_0 (4-bit exponent gives a wider dynamic range), why not use FP8 for `attn_q_a`, `attn_kv`, etc.? Two reasons:

1. **The format must match the dot-kernel hardware.** Q8_0 multiplies into `int32` via `vdotq_s32`, the same kernel family used by Q2_K and IQ2_XXS. FP8 multiplication into a float accumulator is an entirely different instruction class. ds4's CPU path doesn't have an FP8 fused multiply-add path because the only consumer of FP8 (the KV cache QAT) reads and writes float around an FP8 round trip — it doesn't actually multiply FP8 by anything.
2. **Q8_0 quantization noise is symmetric and centered.** Activation × Q8_0 weight produces an unbiased estimator of activation × float weight. The model was trained against essentially this exact behavior. FP8 weight quantization would introduce a bias near zero that the model has not seen.

The asymmetry is precisely "weights are static numerical objects amenable to integer quantization; activations are dynamic and live in float; the KV cache is the unusual middle case that mixes both."

## 17. Block sizes and alignment

QK_K=256 is the universal block size for the K-family and the IQ family. Several invariants follow:

- A row of weights must be a multiple of 256 wide for any K-family or IQ-family type. The runtime checks this via `tensor_expect_layout` indirectly; the validator at `ds4.c:2255-2271` ensures the shape declared in the GGUF matches the fixed dimensions.
- Q8_0's 32-element blocks are smaller — used because Q8_0 is "the simplest serializer" and 32 elements is enough for accurate per-block scale recovery.
- Q8_K's 256-element blocks pair with K/IQ weight blocks one-to-one.
- The activation row width inside a routed expert is `DS4_N_EMBD = 4096` for gate/up (16 Q8_K blocks per row) and `DS4_N_FF_EXP = 2048` for down (8 Q8_K blocks per row). Both are multiples of 256.

When you read code like `ds4.c:4163`:

```c
ds4_quantize_row_q8_K(ctx->mid + p * ctx->down_in_dim,
                      midq + p * ctx->down_blocks_per_row,
                      (int64_t)ctx->down_in_dim);
```

`down_blocks_per_row` is `down_in_dim / QK_K = 2048 / 256 = 8`. Every `block_q8_K` index is `p * 8 + b` for prompt position p and block b within the row.

This sounds pedantic but it's the kind of detail that makes the kernels work: a kernel that loads "8 Q8_K blocks" can be hard-coded to that constant rather than carrying the value as a runtime parameter, which makes loop unrolling effective.

## 18. The expert routing context struct

The CPU expert routing carries a few precomputed pointers and counts as a `routed_expert_ctx`-shaped struct so the inner loop is a tight set of pointer increments. The relevant call sites are at `ds4.c:3925`, `ds4.c:4046`, `ds4.c:4140`, `ds4.c:4196`, `ds4.c:4239`. Each call passes:

- `ctx->in_dim` — the column count of the matrix being evaluated.
- `ctx->out0`/`out1` — destination float pointers for gate/up (or pure `out` for down).
- The block pointers (`br0`, `br1`, `br`) which were prepared by the routing dispatcher.
- The Q8_K activation snapshot `xq`.

The structure is the same whether the dot kernel is IQ2_XXS pair or Q2_K — only the format of the weight blocks differs, and the kernel knows.

## 19. Cross-references

- The actual prefill/decode call sites that consume the kernels described here are in Chapter 6 (`ds4_session_sync`, `forward_token_raw_swa_cpu_decode_scratch`, `prefill_layer_major_cpu`).
- The Metal/CUDA shader implementations that mirror these CPU kernels live in `metal/` and `ds4_cuda.cu`, walked in a later chapter.
- The KV cache the FP8/FP4 round trips populate is the subject of Chapter 7.
- The disk KV cache that persists post-prefill state is Chapter 14.
- The GGUF loader and `tensor_expect_layout` machinery is Chapter 3.
