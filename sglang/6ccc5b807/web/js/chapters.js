// 章节元数据。id 即文件 basename，title/desc 用于侧栏和首页卡片。

export const CHAPTERS = [
  { id: '01-architecture-overview', num: '01', title: '架构总览与核心概念',
    desc: '前端语言与 SRT 运行时的协同设计、RadixAttention、连续批处理、四层架构与多进程模型',
    layers: [1, 2, 3, 4] },
  { id: '02-frontend-language', num: '02', title: '前端语言 SGLang DSL',
    desc: 'sgl.function / sgl.gen / sgl.select 的中间表示、解释器与后端运行时',
    layers: [1] },
  { id: '03-http-server', num: '03', title: 'HTTP 服务器与 OpenAI 兼容 API',
    desc: 'FastAPI 服务、/generate 与 /v1/* 路由、OpenAI/Anthropic 协议适配',
    layers: [1] },
  { id: '04-engine-and-processes', num: '04', title: 'Engine 入口与多进程编排',
    desc: 'Engine 离线推理入口、TokenizerManager/Scheduler/DetokenizerManager 三进程与 ZMQ IPC',
    layers: [1, 2] },
  { id: '05-request-data-structures', num: '05', title: '请求对象与核心数据结构',
    desc: 'GenerateReqInput / Req / ScheduleBatch / ForwardBatch 的字段与生命周期',
    layers: [2] },
  { id: '06-radix-cache', num: '06', title: 'RadixAttention 与前缀缓存',
    desc: 'radix tree 节点结构、match_prefix、lock ref 计数与缓存淘汰',
    layers: [2] },
  { id: '07-kv-cache-memory', num: '07', title: 'KV Cache 内存管理',
    desc: 'ReqToTokenPool、token-to-KV 分配器、分页布局与 HiCache 分级缓存',
    layers: [2] },
  { id: '08-scheduler', num: '08', title: '调度器与连续批处理',
    desc: 'Scheduler 事件循环、prefill/decode 调度策略、零开销 CPU 调度',
    layers: [2] },
  { id: '09-model-runner', num: '09', title: 'ModelRunner 与前向执行',
    desc: 'ScheduleBatch→ForwardBatch 转换、模型加载、CUDA graph 与 torch.compile',
    layers: [3] },
  { id: '10-attention-backends', num: '10', title: '注意力后端与 CUDA 内核',
    desc: 'FlashAttention/FlashInfer/FlashMLA 后端、sgl-kernel 自定义算子',
    layers: [3] },
  { id: '11-sampling-constrained', num: '11', title: '采样与约束解码',
    desc: 'SamplingBatchInfo、温度/top-p/惩罚项、xgrammar/outlines 约束解码',
    layers: [3, 4] },
  { id: '12-speculative-decoding', num: '12', title: '投机解码',
    desc: 'EAGLE 草稿-验证流水线、N-gram、MTP 与接受率统计',
    layers: [4] },
  { id: '13-distributed', num: '13', title: '分布式与并行执行',
    desc: 'TP/PP/DP/EP 并行组、parallel_state、PD 分离与数据并行控制器',
    layers: [4] },
  { id: '14-advanced-features', num: '14', title: '高级特性与模型网关',
    desc: 'LoRA、多模态、模型加载与量化、function call 与 Rust 模型网关',
    layers: [4] },
  { id: '15-glossary-and-faq', num: '15', title: '术语表与 FAQ',
    desc: '术语表、FAQ、环境变量与命令速查',
    layers: [] },
];

// 单请求 trace 导览：tour-00 是 overview + tour-01..N 是步骤
export const TOURS = [
  { id: 'tour-00-overview', num: '00', title: '导览总览',
    desc: '完整 trace 入口、8 段模板说明、18 步速览与状态变量表' },
  { id: 'tour-01-engine-init', num: '01', title: 'Engine.__init__ 与 ServerArgs',
    desc: '参数解析、ServerArgs 落地与启动前的准备' },
  { id: 'tour-02-launch-processes', num: '02', title: '启动三个子进程',
    desc: 'TokenizerManager / Scheduler / DetokenizerManager 与 ZMQ 通道' },
  { id: 'tour-03-load-weights', num: '03', title: '加载模型权重',
    desc: 'ModelRunner 初始化与 model_loader 把权重搬上 GPU' },
  { id: 'tour-04-size-kv-pool', num: '04', title: '确定 KV cache 池大小',
    desc: '显存探测、计算可容纳的 token 数与分页布局' },
  { id: 'tour-05-capture-cuda-graph', num: '05', title: '捕获 CUDA graph',
    desc: '为常见 batch 形状预录前向图，消除内核启动开销' },
  { id: 'tour-06-generate-call', num: '06', title: 'Engine.generate() 与 GenerateReqInput',
    desc: '用户调用入口、请求对象构造与归一化' },
  { id: 'tour-07-tokenize', num: '07', title: 'TokenizerManager 分词',
    desc: '文本转 token id、生成 TokenizedGenerateReqInput' },
  { id: 'tour-08-enqueue', num: '08', title: 'ZMQ 发送与进入 waiting queue',
    desc: '请求跨进程传到 Scheduler 并排入等待队列' },
  { id: 'tour-09-scheduler-loop', num: '09', title: 'Scheduler 事件循环',
    desc: '调度器主循环如何收请求、组批、跑前向、回结果' },
  { id: 'tour-10-match-prefix', num: '10', title: 'RadixCache 前缀匹配',
    desc: 'match_prefix 在 radix tree 上查命中、复用已算好的 KV' },
  { id: 'tour-11-alloc-kv', num: '11', title: '分配 KV 索引',
    desc: 'ReqToTokenPool 与分配器为新 token 划出 KV 槽位' },
  { id: 'tour-12-build-batch', num: '12', title: '组建 prefill ScheduleBatch',
    desc: '调度策略挑请求、拼成一个 prefill 批次' },
  { id: 'tour-13-forward-batch', num: '13', title: 'ScheduleBatch → ForwardBatch',
    desc: 'CPU 调度数据转成 GPU 张量、构建注意力元数据' },
  { id: 'tour-14-model-forward', num: '14', title: 'ModelRunner 前向（prefill）',
    desc: '走一遍 Transformer、算出最后位置的 logits' },
  { id: 'tour-15-attention-kernel', num: '15', title: '注意力后端读 KV',
    desc: '注意力内核如何按页读非连续 KV 并写回新 KV' },
  { id: 'tour-16-sample-token', num: '16', title: '采样出第一个 token',
    desc: 'logits 经 SamplingBatchInfo 处理、采样得到首个 token' },
  { id: 'tour-17-decode-loop', num: '17', title: 'decode 单 token 循环',
    desc: '请求从 prefill 转入 decode、逐 token 自回归生成' },
  { id: 'tour-18-finish-return', num: '18', title: '结束判定、detokenize 与释放',
    desc: '命中停止条件、转回文本、释放 KV、把结果交还用户' },
];

export const TOUR_BY_ID = Object.fromEntries(TOURS.map(t => [t.id, t]));

// 所有文档（章节 + tour），用于路由查找和搜索
export const ALL_DOCS = [...CHAPTERS, ...TOURS];
export const CHAPTER_BY_ID = Object.fromEntries(ALL_DOCS.map(c => [c.id, c]));

// =========================================================
// 分析的代码版本（升级版本时改这 4 个常量即可，所有 GitHub 跳转链接都会更新）
// =========================================================
export const PROJECT_GITHUB_REPO = 'sgl-project/sglang';
export const ANALYZED_COMMIT = '6ccc5b807';
export const ANALYZED_TAG = 'gateway-v0.3.1-4034-g6ccc5b807';
export const ANALYZED_DATE = '2026-05-17';

// =========================================================
// file:line 跳转链接：默认走 GitHub（任何人可用），可切换成本地 VSCode
// localStorage 里有 path → 'local' 模式；没有 → 'github' 模式
// =========================================================
const REPO_ROOT_KEY = 'sglang-wiki-repo-root';

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
