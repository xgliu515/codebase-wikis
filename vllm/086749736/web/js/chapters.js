// 章节元数据。id 即文件 basename，title/desc 用于侧栏和首页卡片。

export const CHAPTERS = [
  { id: '01-architecture-overview',  num: '01', title: '架构总览',
    desc: '四层架构、请求生命周期、V0 vs V1、进程模型、目录速查',
    layers: [1, 2, 3, 4] },
  { id: '02-core-concepts',          num: '02', title: '核心理论概念',
    desc: 'PagedAttention、continuous batching、prefix caching、spec decode、量化、CUDA graph、TP/PP/EP',
    layers: [] },
  { id: '03-entry-and-engine',       num: '03', title: '入口与引擎层',
    desc: 'LLM 类、OpenAI server、AsyncLLM、EngineCore busy loop、EngineCoreClient、IPC、I/O processor',
    layers: [1, 2] },
  { id: '04-scheduler',              num: '04', title: '调度器',
    desc: 'V1 Scheduler、schedule() 主流程、continuous batching、chunked prefill、抢占、prefix 命中链路',
    layers: [3] },
  { id: '05-kv-cache-manager',       num: '05', title: 'KV Cache 管理',
    desc: 'BlockPool、KVCacheManager、Coordinator、block table、prefix tree、hybrid KV',
    layers: [3] },
  { id: '06-worker-and-model-runner', num: '06', title: 'Worker 与 Model Runner',
    desc: 'WorkerBase、GPUWorker、GPUModelRunner、InputBatch、_prepare_inputs、cudagraph dispatch',
    layers: [4] },
  { id: '07-attention-backends',     num: '07', title: 'Attention Backends',
    desc: 'backend selector、AttentionMetadata、FlashAttn / FlashInfer / Triton / FlexAttn / MLA',
    layers: [4] },
  { id: '08-models-and-loading',     num: '08', title: '模型定义与加载',
    desc: 'registry、Llama 解读、ParallelLinear、RMSNorm/RoPE/VocabEmbedding、weight loader',
    layers: [4] },
  { id: '09-sampling',               num: '09', title: '采样',
    desc: 'SamplingParams、9 步 Sampler 流水线、logits processors、RejectionSampler、logprobs',
    layers: [4] },
  { id: '10-distributed',            num: '10', title: '分布式与并行',
    desc: 'GroupCoordinator、TP/PP/DP/EP、5D 网格、custom all-reduce、Ray vs multiproc',
    layers: [4] },
  { id: '11-advanced-features',      num: '11', title: '高级特性',
    desc: 'spec decode、量化、torch.compile、LoRA、多模态、structured output、KV connector、tracing、plugins',
    layers: [3, 4] },
  { id: '12-glossary-and-faq',       num: '12', title: '术语表与 FAQ',
    desc: '49 条术语、15 条 FAQ、环境变量、benchmark、测试目录速查',
    layers: [] },
];

// 单请求 trace 导览：18 个文件（00 overview + 01-17 步骤），problem-first 风格
export const TOURS = [
  { id: 'tour-00-overview',                  num: '00', title: '导览总览',          desc: '完整 trace 入口、8 段模板说明、17 步速览' },
  { id: 'tour-01-kv-cache-sizing',           num: '01', title: 'KV cache 池能塞多少？', desc: 'profile_run 与 gpu_memory_utilization 的含义' },
  { id: 'tour-02-cudagraph-capture',         num: '02', title: 'CUDA graph capture',  desc: '为什么要 capture、piecewise vs full、bucket 选择' },
  { id: 'tour-03-weight-loading',            num: '03', title: 'HF → vllm 权重映射',  desc: 'stacked_params_mapping、流式加载、KV scale remap' },
  { id: 'tour-04-tokenize-and-enqueue',      num: '04', title: 'tokenize + 入队',     desc: 'EngineCoreRequest、为何 LLM/EngineCore 分离' },
  { id: 'tour-05-scheduler-prefill-decision', num: '05', title: 'Scheduler 决定 prefill', desc: 'token budget、何时 chunked prefill' },
  { id: 'tour-06-kv-allocation',             num: '06', title: 'KV blocks 分配',      desc: 'allocate_slots、chain hash、ref_cnt' },
  { id: 'tour-07-input-batch-assembly',      num: '07', title: 'Input batch 组装',    desc: 'packed tensors、cu_seqlens、slot_mapping' },
  { id: 'tour-08-attention-metadata',        num: '08', title: 'AttentionMetadata',   desc: '为何每个 backend 一份、CudagraphDispatcher 选 graph' },
  { id: 'tour-09-embedding-and-layers',      num: '09', title: 'embedding + decoder layer', desc: 'VocabParallelEmbedding、fused RMSNorm + residual' },
  { id: 'tour-10-paged-attention-kernel',    num: '10', title: 'PagedAttention kernel', desc: '一次 attention 内部全流程' },
  { id: 'tour-11-layers-to-logits',          num: '11', title: 'final norm → logits', desc: 'logits_indices、tied embedding' },
  { id: 'tour-12-sampler-greedy',            num: '12', title: 'Sampler 为何不是 argmax', desc: '异构 SamplingParams 的批处理' },
  { id: 'tour-13-token-back-to-engine',      num: '13', title: 'token 回流 EngineCore', desc: '停止检查、prefill→decode 状态切换' },
  { id: 'tour-14-continuous-batching',       num: '14', title: 'continuous batching 登场', desc: 'iteration-level scheduling 的核心' },
  { id: 'tour-15-decode-forward',            num: '15', title: 'decode forward 与 prefill 的差异', desc: 'query=1 / kv=已有、CUDA graph 命中' },
  { id: 'tour-16-stop-and-cleanup',          num: '16', title: 'max_tokens 命中 + KV 回收', desc: 'finish_requests、ref_cnt 释放、LRU 复用' },
  { id: 'tour-17-detokenize-and-return',     num: '17', title: 'detokenize + 返回',   desc: 'IncrementalDetokenizer、RequestOutput' },
];

export const TOUR_BY_ID = Object.fromEntries(TOURS.map(t => [t.id, t]));

// 所有文档（章节 + tour），用于路由查找和搜索
export const ALL_DOCS = [...CHAPTERS, ...TOURS];
export const CHAPTER_BY_ID = Object.fromEntries(ALL_DOCS.map(c => [c.id, c]));

// =========================================================
// 分析的 vllm 版本（升级版本时改这里一处即可，所有 GitHub 跳转链接都会更新）
// =========================================================
export const VLLM_GITHUB_REPO = 'vllm-project/vllm';
export const VLLM_ANALYZED_COMMIT = '086749736';
export const VLLM_ANALYZED_TAG = 'v0.21.1rc0+35';
export const VLLM_ANALYZED_DATE = '2026-05-17';

// =========================================================
// file:line 跳转链接：默认走 GitHub（任何人可用），可切换成本地 VSCode
// localStorage 里有 path → 'local' 模式；没有 → 'github' 模式
// =========================================================
const REPO_ROOT_KEY = 'vllm-wiki-repo-root';

export function getRepoMode() {
  return getRepoRoot() ? 'local' : 'github';
}

export function getRepoRoot() {
  try { return localStorage.getItem(REPO_ROOT_KEY) || ''; }
  catch { return ''; }
}

export function setRepoRoot(path) {
  try {
    if (path && path.trim()) localStorage.setItem(REPO_ROOT_KEY, path.trim());
    else localStorage.removeItem(REPO_ROOT_KEY);
  } catch {}
}

// 旧名兼容
export const VLLM_REPO_ROOT = '';

// ===== mono-repo 导航辅助（codebase-wikis 导入时追加）=====
export function getCurrentVersionDir() {
  const segs = location.pathname.split('/').filter(Boolean);
  if (segs.length && /\.html?$/i.test(segs[segs.length - 1])) segs.pop();
  return segs.length ? segs[segs.length - 1] : '';
}
export function getCurrentProjectDir() {
  const segs = location.pathname.split('/').filter(Boolean);
  if (segs.length && /\.html?$/i.test(segs[segs.length - 1])) segs.pop();
  return segs.length >= 2 ? segs[segs.length - 2] : '';
}
