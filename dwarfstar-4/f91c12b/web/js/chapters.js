// Chapter metadata. id is the filename basename; title/desc drive the sidebar and home page cards.

export const CHAPTERS = [
  { id: '01-architecture-overview', num: '01', title: 'Architecture Overview & Boot Flow',
    desc: 'What ds4 is, the four-layer architecture (entrypoint / engine / model / backend), the five binaries, and the boot chain from main() to a running session',
    layers: [1, 2, 3, 4] },
  { id: '02-model-architecture', num: '02', title: 'DeepSeek V4 Flash Model Architecture',
    desc: '43 transformer layers, low-rank Q/KV projections, the four-way hyper-connection residual, the MoE block, and how the model shape is baked into the engine',
    layers: [3] },
  { id: '03-gguf-loading', num: '03', title: 'GGUF Loading, mmap & Tensor Binding',
    desc: 'Single-mmap of the model file, tensor directory parsing, fixed-shape validation, layer binding, and CPU preload / GPU warm-up',
    layers: [3] },
  { id: '04-quantization', num: '04', title: 'Quantization: IQ2_XXS, Q2_K, FP8 KV',
    desc: 'Asymmetric quantization (routed experts only), the IQ2_XXS / Q2_K layouts, FP8 (E4M3FN / E2M1FN) for KV rows, and the dequantization paths',
    layers: [3] },
  { id: '05-tokenizer-chat', num: '05', title: 'Tokenizer & Chat Template',
    desc: 'Byte-level BPE encoder/decoder, the GGUF-embedded vocab and merges, special tokens, the DeepSeek chat template, and thinking-mode prefixes',
    layers: [1] },
  { id: '06-engine-session', num: '06', title: 'Engine, Session & session_sync',
    desc: 'ds4_engine_open lifecycle, ds4_session prefix matching, the full-vs-incremental prefill decision, rewind boundaries, and the public API',
    layers: [2] },
  { id: '07-kv-cache', num: '07', title: 'KV Cache: Raw SWA + Compressed Indexer',
    desc: 'The dual cache design — 128-token raw sliding window plus the ratio-4 / ratio-8 compressed indexer, FP8 row storage, and per-layer compression ratios',
    layers: [3] },
  { id: '08-attention', num: '08', title: 'Attention Sublayer & RoPE',
    desc: 'Low-rank Q/K/V matmuls, tail-only RoPE (64/512 dims), sink + local SWA path, indexer-driven top-K compressed path, and flash attention',
    layers: [3] },
  { id: '09-moe-hyperconnections', num: '09', title: 'MoE, Hyper-Connection & FFN',
    desc: 'Hash vs learned-bias routing, top-6 of 256 experts, IQ2_XXS expert matmul, the four-way HC reduce/expand with sinkhorn balancing, and the shared SwiGLU MLP',
    layers: [3] },
  { id: '10-metal-backend', num: '10', title: 'Metal Backend & Kernels',
    desc: 'ds4_metal.m graph builder, command-buffer batching, the ~19 Metal shaders (flash_attn, moe, dsv4_hc, dsv4_misc), and the GPU resource cache',
    layers: [4] },
  { id: '11-cuda-backend', num: '11', title: 'CUDA Backend (DGX Spark)',
    desc: 'ds4_cuda.cu kernel inventory, stream + event sync, the IQ2 lookup tables, and the differences from the Metal path',
    layers: [4] },
  { id: '12-speculative-mtp', num: '12', title: 'Speculative Decoding & MTP',
    desc: 'The Multi-Token-Prediction draft head, draft-then-verify loop, accept/reject bookkeeping, and KV rewind on rejection',
    layers: [4] },
  { id: '13-http-server-api', num: '13', title: 'HTTP Server & OpenAI/Anthropic API',
    desc: 'ds4_server.c endpoints, the serial graph-worker queue, SSE streaming, DSML tool-call canonicalization, and the multi-client connection lifecycle',
    layers: [1, 2] },
  { id: '14-disk-kv-cache', num: '14', title: 'Disk KV Cache & Replay',
    desc: 'KVC file format, SHA1 prefix keys, cold save vs continued save, eviction policy, and the rax-backed tool-call replay map',
    layers: [2] },
  { id: '15-glossary-and-faq', num: '15', title: 'Glossary & FAQ',
    desc: 'Glossary, FAQ, and a quick reference of environment variables and CLI flags',
    layers: [] },
];

// Single-request trace tour: tour-00 is the overview, tour-01..N are the steps.
export const TOURS = [
  { id: 'tour-00-overview', num: '00', title: 'Trace Tour Overview',
    desc: 'Entry point for the full trace, the 8-section template, a 17-step preview, and the state-variable table' },
  { id: 'tour-01-cli-parse', num: '01', title: 'CLI parsing & backend selection',
    desc: 'Command-line argument parsing, default backend pick, generation options collection' },
  { id: 'tour-02-mmap-gguf', num: '02', title: 'Open & mmap the GGUF file',
    desc: 'One mmap, read the tensor directory, convert relative offsets to absolute' },
  { id: 'tour-03-validate-bind', num: '03', title: 'Validate tensors & bind layer layout',
    desc: 'Tensor type/shape validation, semantic metadata checks, binding to the 43-layer fixed layout' },
  { id: 'tour-04-load-tokenizer', num: '04', title: 'Load the tokenizer',
    desc: 'Token strings, special tokens, BPE merge ranks' },
  { id: 'tour-05-create-engine', num: '05', title: 'Create the engine and graph state',
    desc: 'ds4_engine_open, Metal graph state allocation, raw cache capacity decision' },
  { id: 'tour-06-render-prompt', num: '06', title: 'Render the chat prompt into tokens',
    desc: 'BOS + user text + assistant prefix, byte-level BPE encoding' },
  { id: 'tour-07-create-session', num: '07', title: 'Create the session and sync',
    desc: 'ds4_session_create, session_sync decides full prefill' },
  { id: 'tour-08-prefill-setup', num: '08', title: 'Prefill setup',
    desc: 'ubatch size choice, HC state seeded from token embedding' },
  { id: 'tour-09-prefill-layermajor', num: '09', title: 'Layer-major prefill',
    desc: 'All prompt tokens advance layer-by-layer, raw SWA and compressor state fill in' },
  { id: 'tour-10-attention-sublayer', num: '10', title: 'One attention sublayer',
    desc: 'Low-rank Q/KV, tail-only RoPE, sink-attention compute' },
  { id: 'tour-11-ffn-moe', num: '11', title: 'One FFN + MoE sublayer',
    desc: 'HC pre, hash routing vs biased top-k, IQ2_XXS experts, shared expert' },
  { id: 'tour-12-ratio4-compressor', num: '12', title: 'Ratio-4 layer compressor & indexer',
    desc: 'Compression-window pooling, indexer selects which compressed rows join attention' },
  { id: 'tour-13-logits-head', num: '13', title: 'Prefill-tail logits head',
    desc: 'HC collapse, output RMSNorm, Q8_0 vocab projection' },
  { id: 'tour-14-argmax-sample', num: '14', title: 'Sample the first token',
    desc: 'Default min-p filter + sampling, from logits to the first generated token' },
  { id: 'tour-15-decode-step', num: '15', title: 'One decode step',
    desc: 'Single-token Metal graph, append raw SWA, streaming compressor update' },
  { id: 'tour-16-decode-loop', num: '16', title: 'Decode loop to n=3',
    desc: 'Repeat decode, EOS detection, stop conditions' },
  { id: 'tour-17-output-cleanup', num: '17', title: 'Detokenize, output & cleanup',
    desc: 'Token → text, stream printing, free the session and engine' },
];

export const TOUR_BY_ID = Object.fromEntries(TOURS.map(t => [t.id, t]));

// All docs (chapters + addenda + tour), used for routing and search.
// addenda is flattened into ALL_DOCS; each addendum carries a parentId so content rendering can back-link.
const FLATTENED_CHAPTERS = CHAPTERS.flatMap(c => {
  const entries = [c];
  if (Array.isArray(c.addenda)) {
    for (const a of c.addenda) {
      entries.push({ ...a, parentId: c.id, num: a.id.match(/^(\d+[a-z]?)/)?.[1] ?? c.num });
    }
  }
  return entries;
});
export const ALL_DOCS = [...FLATTENED_CHAPTERS, ...TOURS];
export const CHAPTER_BY_ID = Object.fromEntries(ALL_DOCS.map(c => [c.id, c]));

// =========================================================
// Project info — this file is the ONLY per-project JS file the viewer needs.
// Every other web/js/*.js imports these constants; do not hardcode the project name elsewhere.
// =========================================================
export const PROJECT_NAME = 'DwarfStar 4';

// Analyzed code version (bump these 4 constants when re-running; all GitHub deep-links update).
export const PROJECT_GITHUB_REPO = 'antirez/ds4';
export const ANALYZED_COMMIT = 'f91c12b';
export const ANALYZED_TAG = 'main';
export const ANALYZED_DATE = '2026-05-24';

// Home page strings
export const PROJECT_TAGLINE = 'DwarfStar 4 source-code reference Wiki — a standalone inference engine purpose-built for DeepSeek V4 Flash, written in C with Metal and CUDA backends.';
export const PROJECT_FOCUS = 'Metal / CUDA main path';
export const TRACE_TARGET = './ds4 -m DS4.gguf -p "hello" -n 3';

// Current version directory name: the last non-.html path segment, e.g.
//   /xxx-wiki/v0.22.0/index.html  →  'v0.22.0'
// Used by the version dropdown and localStorage isolation. Returns '' if empty.
export function getCurrentVersionDir() {
  const segs = location.pathname.split('/').filter(Boolean);
  if (segs.length && /\.html?$/i.test(segs[segs.length - 1])) segs.pop();
  return segs.length ? segs[segs.length - 1] : '';
}

// Storage prefix auto-derived from PROJECT_NAME (used for theme/source-mode localStorage keys).
export const STORAGE_PREFIX = PROJECT_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
