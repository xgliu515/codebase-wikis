// 章节元数据。id 即文件 basename，title/desc 用于侧栏和首页卡片。
//
// layers: 该章节主要涉及的架构层 [1=入口/工具, 2=libllama, 3=ggml 图/调度, 4=后端]

export const CHAPTERS = [
  { id: '01-architecture-overview',  num: '01', title: '系统架构总览',
    desc: '推理流水线全景、libllama 公共 API、各子系统如何串起来',
    layers: [1, 2, 3, 4] },
  { id: '02-gguf-and-model-loading', num: '02', title: 'GGUF 文件格式与模型加载',
    desc: 'GGUF 二进制布局、llama_model_loader、mmap 零拷贝张量加载',
    layers: [2] },
  { id: '03-model-arch-and-hparams', num: '03', title: '模型架构与超参数',
    desc: 'llm_arch 枚举、llama_hparams、llama_model 的张量布局与设备放置',
    layers: [2] },
  { id: '04-ggml-tensor-and-graph',  num: '04', title: 'GGML 张量库与计算图',
    desc: 'ggml_tensor、ggml_cgraph、算子节点、ggml-alloc 内存分配器',
    layers: [3] },
  { id: '05-graph-construction',     num: '05', title: '计算图构建与前向推理',
    desc: 'llm_graph_context、models/ 各架构 build、注意力与 KV 接线',
    layers: [2, 3] },
  { id: '06-tokenization',           num: '06', title: '分词与词表',
    desc: 'llama_vocab、SPM/BPE/WPM/UGM、特殊 token 与预分词',
    layers: [2] },
  { id: '07-context-and-batching',   num: '07', title: '推理上下文与批处理',
    desc: 'llama_context、llama_batch、ubatch 拆分、llama_decode 主循环',
    layers: [2] },
  { id: '08-kv-cache',               num: '08', title: 'KV 缓存与内存子系统',
    desc: 'llama_kv_cache、unified/recurrent/hybrid、多序列槽位分配',
    layers: [2, 3] },
  { id: '09-ggml-backend',           num: '09', title: 'GGML 后端系统与硬件加速',
    desc: 'ggml-backend 抽象、backend scheduler、CPU/Metal/CUDA、构建系统',
    layers: [4] },
  { id: '10-sampling',               num: '10', title: '采样与 token 生成',
    desc: 'llama_sampler 采样链、greedy/top-k/温度、grammar 约束',
    layers: [2] },
  { id: '11-common-and-chat',        num: '11', title: 'common 工具库与聊天模板',
    desc: 'arg 参数解析、chat/jinja 模板、common_sampler、json-schema-to-grammar',
    layers: [1] },
  { id: '12-cli-and-server',         num: '12', title: 'CLI 与 Server 架构',
    desc: 'llama-cli 交互循环、llama-server slot 与连续批处理、HTTP API',
    layers: [1] },
  { id: '13-quantization',           num: '13', title: '量化与模型压缩',
    desc: 'llama_quant、GGML 量化类型（Q4_K / IQ / MXFP4）、块量化原理',
    layers: [2, 4] },
  { id: '14-glossary-and-faq',       num: '14', title: '术语表与 FAQ',
    desc: '术语表、常见问题、环境变量与命令速查',
    layers: [] },
];

// 单请求 trace 导览：tour-00 是 overview + tour-01..N 是步骤
export const TOURS = [
  { id: 'tour-00-overview',        num: '00', title: '导览总览',
    desc: '完整 trace 入口、8 段模板说明、17 步速览与状态演进表' },
  { id: 'tour-01-backend-load',    num: '01', title: '加载动态后端',
    desc: 'ggml_backend_load_all：运行时发现 CPU/Metal/CUDA 后端' },
  { id: 'tour-02-open-gguf',       num: '02', title: '打开 GGUF 文件',
    desc: '读 magic、解析元数据键值、建立张量索引' },
  { id: 'tour-03-tensor-mmap',     num: '03', title: 'mmap 权重进内存',
    desc: '把几个 GB 的权重映射进地址空间，零拷贝填充张量' },
  { id: 'tour-04-arch-detect',     num: '04', title: '识别模型架构',
    desc: '从元数据判定 llm_arch、填充 hparams、决定层数与维度' },
  { id: 'tour-05-create-context',  num: '05', title: '创建推理上下文',
    desc: 'llama_init_from_model：算 n_ctx、建后端、分配计算缓冲' },
  { id: 'tour-06-kv-alloc',        num: '06', title: '分配 KV 缓存',
    desc: '按上下文长度与层数预留 K/V 张量,准备槽位' },
  { id: 'tour-07-graph-reserve',   num: '07', title: '预留计算图与调度器',
    desc: '用最大尺寸 dry-run 一遍图,确定显存峰值并固化分配' },
  { id: 'tour-08-sampler-init',    num: '08', title: '初始化采样器链',
    desc: 'llama_sampler_chain + greedy:确定怎么从 logits 选 token' },
  { id: 'tour-09-tokenize',        num: '09', title: '把 prompt 切成 token',
    desc: 'llama_tokenize:"你好" 经词表变成整数 id 序列' },
  { id: 'tour-10-batch',           num: '10', title: '构造 llama_batch',
    desc: 'llama_batch_get_one:token 序列包装成一次 decode 的输入' },
  { id: 'tour-11-decode-entry',    num: '11', title: '进入 llama_decode',
    desc: 'decode 入口:校验 batch、拆 ubatch、找 KV 槽位' },
  { id: 'tour-12-graph-build',     num: '12', title: '构建本次的计算图',
    desc: 'llm_graph_context 按 ubatch 拼出 embed→层→输出的算子图' },
  { id: 'tour-13-backend-compute', num: '13', title: '后端执行前向计算',
    desc: 'backend scheduler 把图派给 CPU/GPU,跑注意力与 FFN' },
  { id: 'tour-14-logits',          num: '14', title: '取出 logits',
    desc: '从输出张量拷回 logits,得到下一 token 的概率分布原料' },
  { id: 'tour-15-sample',          num: '15', title: '采样下一个 token',
    desc: 'llama_sampler_sample:greedy 取 argmax 选出 new_token_id' },
  { id: 'tour-16-detokenize-loop', num: '16', title: '解码并进入下一轮',
    desc: 'token_to_piece 还原文字、写回 KV、把新 token 当下一个 batch' },
  { id: 'tour-17-eog-cleanup',     num: '17', title: 'EOG 判定与收尾',
    desc: '判断生成结束、打印性能计数、释放 context/model' },
];

export const TOUR_BY_ID = Object.fromEntries(TOURS.map(t => [t.id, t]));

// 所有文档（章节 + tour），用于路由查找和搜索
export const ALL_DOCS = [...CHAPTERS, ...TOURS];
export const CHAPTER_BY_ID = Object.fromEntries(ALL_DOCS.map(c => [c.id, c]));

// =========================================================
// 项目信息 —— 本文件是整个 web 查看器唯一需要按项目修改的 JS 文件。
// =========================================================
export const PROJECT_NAME = 'llama.cpp';

// 分析的代码版本（升级版本时改这 4 个常量即可，所有 GitHub 跳转链接都会更新）
export const PROJECT_GITHUB_REPO = 'ggml-org/llama.cpp';
export const ANALYZED_COMMIT = '45b455e66';
export const ANALYZED_TAG = 'b9209';
export const ANALYZED_DATE = '2026-05-18';

// 首页文案
export const PROJECT_TAGLINE = '为深入学习 llama.cpp 源码而写的可查询中文参考文档：从一次最简推理请求出发，逐层走完 C/C++ LLM 推理引擎。';
export const PROJECT_FOCUS = 'libllama + ggml 推理路径';
export const TRACE_TARGET = 'llama-simple -m qwen2.5-0.5b.gguf -n 4 "你好"';

// 当前版本目录名：取 URL 路径里最后一个非 .html 段，例如
//   /xxx-wiki/v0.22.0/index.html  →  'v0.22.0'
// 用于版本切换下拉与 localStorage 隔离。返回 URL 路径的最后一段，路径为空时返回空串。
export function getCurrentVersionDir() {
  const segs = location.pathname.split('/').filter(Boolean);
  if (segs.length && /\.html?$/i.test(segs[segs.length - 1])) segs.pop();
  return segs.length ? segs[segs.length - 1] : '';
}

// 当前项目目录名：mono-repo 下版本目录的上一级，例如
//   /wikis/vllm/v0.22.0/index.html  →  'vllm'
// 用于项目切换下拉。路径不足两段时返回空串。
export function getCurrentProjectDir() {
  const segs = location.pathname.split('/').filter(Boolean);
  if (segs.length && /\.html?$/i.test(segs[segs.length - 1])) segs.pop();
  return segs.length >= 2 ? segs[segs.length - 2] : '';
}

// localStorage key 前缀：由 PROJECT_NAME 派生，并追加版本目录名做隔离，
// 避免同源下多个版本的查看器互相覆盖阅读状态。
export const STORAGE_PREFIX = (() => {
  const base = (PROJECT_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'codebase') + '-wiki';
  const ver = getCurrentVersionDir();
  return ver ? `${base}-${ver}` : base;
})();

// =========================================================
// file:line 跳转链接：默认走 GitHub（任何人可用），可切换成本地 VSCode
// localStorage 里有 path → 'local' 模式；没有 → 'github' 模式
// =========================================================
const REPO_ROOT_KEY = STORAGE_PREFIX + '-repo-root';

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
