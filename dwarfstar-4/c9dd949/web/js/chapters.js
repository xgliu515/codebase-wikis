// 章节元数据。id 即文件 basename，title/desc 用于侧栏和首页卡片。

export const CHAPTERS = [
  { id: '01-architecture-overview', num: '01', title: '架构总览',
    desc: '项目定位、三大后端、engine/session 边界、文件布局与构建',
    layers: [1, 2, 3, 4] },
  { id: '02-model-architecture', num: '02', title: 'DeepSeek V4 Flash 模型结构',
    desc: '43 层结构、超连接、压缩 KV、MoE、MTP——这个模型到底特殊在哪',
    layers: [3, 4] },
  { id: '03-gguf-loading', num: '03', title: 'GGUF 加载与模型初始化',
    desc: 'mmap 零拷贝加载、张量目录、元数据校验、绑定到固定层布局',
    layers: [2] },
  { id: '04-quantization', num: '04', title: '特化 2-bit 量化与 imatrix',
    desc: 'IQ2_XXS / Q2_K 专用量化、deepseek4-quantize、imatrix 采集与质量测试',
    layers: [2] },
  { id: '05-tokenizer-chat', num: '05', title: '分词器与对话提示渲染',
    desc: 'byte-level BPE、DeepSeek 预分词、对话模板、thinking 模式',
    layers: [1, 2] },
  { id: '06-engine-session', num: '06', title: '引擎、会话与增量推理',
    desc: 'ds4_engine / ds4_session、session_sync、公共前缀复用、CPU 参考路径',
    layers: [2, 3] },
  { id: '07-kv-cache', num: '07', title: 'KV 缓存：压缩与原始滑动窗口',
    desc: 'raw SWA 缓存、流式压缩器、ratio-4 层、indexer 选择',
    layers: [3, 4] },
  { id: '08-attention', num: '08', title: '注意力子层',
    desc: '低秩 Q/KV 投影、仅尾部 RoPE、sink 注意力、压缩行读取',
    layers: [4] },
  { id: '09-moe-hyperconnections', num: '09', title: '超连接与 MoE 前向计算',
    desc: 'HC 多流、早层哈希路由、偏置 top-k、IQ2_XXS 专家、共享专家',
    layers: [4] },
  { id: '10-metal-backend', num: '10', title: 'Metal 后端',
    desc: '整模型图、kernel 封装、prefill/decode 编码、metal/*.metal',
    layers: [4] },
  { id: '11-cuda-backend', num: '11', title: 'CUDA 后端',
    desc: 'DGX Spark 目标、CUDA kernel、与 Metal 路径的差异',
    layers: [4] },
  { id: '12-speculative-mtp', num: '12', title: '推测解码与 MTP',
    desc: 'MTP draft tokens、推测解码状态机、目标模型验证',
    layers: [3, 4] },
  { id: '13-http-server-api', num: '13', title: 'HTTP 服务器与 Agent API',
    desc: 'OpenAI/Anthropic/Responses 兼容、流式状态机、DSML 工具调用',
    layers: [1] },
  { id: '14-disk-kv-cache', num: '14', title: '磁盘 KV 缓存与会话持久化',
    desc: 'payload 序列化、snapshot、服务器 KVC 文件策略与命中复用',
    layers: [1, 3] },
  { id: '15-glossary-and-faq', num: '15', title: '术语表、FAQ 与速查',
    desc: '术语、FAQ、环境变量、命令速查',
    layers: [] },
];

// 单请求 trace 导览：tour-00 是 overview + tour-01..N 是步骤
export const TOURS = [
  { id: 'tour-00-overview', num: '00', title: '导览总览',
    desc: '完整 trace 入口、8 段模板说明、17 步速览、状态变量表' },
  { id: 'tour-01-cli-parse', num: '01', title: 'CLI 解析与后端选择',
    desc: '命令行参数解析、默认后端判定、生成选项收集' },
  { id: 'tour-02-mmap-gguf', num: '02', title: '打开并 mmap GGUF',
    desc: '一次 mmap、读取张量目录、相对偏移转绝对偏移' },
  { id: 'tour-03-validate-bind', num: '03', title: '校验张量与绑定层布局',
    desc: '张量类型/形状校验、语义元数据校验、绑定到 43 层固定布局' },
  { id: 'tour-04-load-tokenizer', num: '04', title: '加载分词器',
    desc: 'token 字符串、special token、BPE merge ranks' },
  { id: 'tour-05-create-engine', num: '05', title: '创建引擎与图状态',
    desc: 'ds4_engine_open、Metal 图状态分配、raw 缓存容量决策' },
  { id: 'tour-06-render-prompt', num: '06', title: '渲染对话提示为 token',
    desc: 'BOS + 用户文本 + assistant 前缀、byte-level BPE 编码' },
  { id: 'tour-07-create-session', num: '07', title: '创建会话并 sync',
    desc: 'ds4_session_create、session_sync 判定全量 prefill' },
  { id: 'tour-08-prefill-setup', num: '08', title: 'Prefill 准备',
    desc: 'ubatch 大小选择、HC 状态从 token 嵌入种子' },
  { id: 'tour-09-prefill-layermajor', num: '09', title: '层主序 Prefill',
    desc: '所有 prompt token 逐层推进、raw SWA 与压缩器状态填充' },
  { id: 'tour-10-attention-sublayer', num: '10', title: '一层注意力',
    desc: '低秩 Q/KV、仅尾部 RoPE、sink 注意力计算' },
  { id: 'tour-11-ffn-moe', num: '11', title: '一层 FFN 与 MoE',
    desc: 'HC pre、哈希路由 vs 偏置 top-k、IQ2_XXS 专家、共享专家' },
  { id: 'tour-12-ratio4-compressor', num: '12', title: 'ratio-4 层的压缩器与 indexer',
    desc: '压缩窗口池化、indexer 选择哪些压缩行参与注意力' },
  { id: 'tour-13-logits-head', num: '13', title: 'Prefill 末尾 logits head',
    desc: 'HC collapse、输出 RMSNorm、Q8_0 词表投影' },
  { id: 'tour-14-argmax-sample', num: '14', title: '采样首 token',
    desc: '默认 min-p 过滤 + 采样，从 logits 得到生成的第一个 token' },
  { id: 'tour-15-decode-step', num: '15', title: '单步 decode',
    desc: '单 token Metal 图、追加 raw SWA、流式压缩器更新' },
  { id: 'tour-16-decode-loop', num: '16', title: 'decode 循环到 n=3',
    desc: '重复 decode、EOS 检测、停止条件' },
  { id: 'tour-17-output-cleanup', num: '17', title: 'token 解码输出与清理',
    desc: 'token 转文本、流式打印、释放 session 与 engine' },
];

export const TOUR_BY_ID = Object.fromEntries(TOURS.map(t => [t.id, t]));

// 所有文档（章节 + tour），用于路由查找和搜索
export const ALL_DOCS = [...CHAPTERS, ...TOURS];
export const CHAPTER_BY_ID = Object.fromEntries(ALL_DOCS.map(c => [c.id, c]));

// =========================================================
// 项目信息 —— 本文件是整个 web 查看器唯一需要按项目修改的 JS 文件。
// =========================================================
export const PROJECT_NAME = 'DwarfStar 4';

// 分析的代码版本（升级版本时改这 4 个常量即可）
export const PROJECT_GITHUB_REPO = 'antirez/ds4';
export const ANALYZED_COMMIT = 'c9dd949';
export const ANALYZED_TAG = 'c9dd949';
export const ANALYZED_DATE = '2026-05-18';

// 首页文案
export const PROJECT_TAGLINE = '为深入学习 DwarfStar 4（ds4）源码而写的可查询中文参考文档——一个专为 DeepSeek V4 Flash 打造的独立推理引擎。';
export const PROJECT_FOCUS = 'Metal / CUDA 主路径';
export const TRACE_TARGET = './ds4 -m DS4.gguf -p "你好" -n 3';

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
// file:line 跳转链接：默认走 GitHub，可切换成本地 VSCode
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
