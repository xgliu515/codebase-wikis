// 章节元数据。id 即文件 basename，title/desc 用于侧栏和首页卡片。

export const CHAPTERS = [
  { id: '01-architecture-overview', num: '01', title: '架构总览与启动流程',
    desc: 'OpenClaw 是什么，四层架构，monorepo 布局，从 openclaw.mjs 到 Gateway 启动的引导链',
    layers: [1, 2, 3, 4] },
  { id: '02-gateway-control-plane', num: '02', title: 'Gateway 控制平面',
    desc: 'server.impl 启动、HTTP/WebSocket 监听、RPC 方法注册表与连接生命周期',
    layers: [2],
    addenda: [
      { id: '02a-cron-scheduler', title: 'Cron 定时任务实现',
        question: 'openclaw 的定时任务是如何实现的',
        asked_at: '2026-05-21',
        classification: 'matched' },
    ] },
  { id: '03-config-system', num: '03', title: '配置系统',
    desc: 'OpenClawConfig schema、配置文件加载、环境变量与运行时覆盖、热重载',
    layers: [2] },
  { id: '04-channel-layer', num: '04', title: 'Channel 抽象与传输层',
    desc: '多平台 channel 插件模型、消息类型契约、send/receive 运行时与投递策略',
    layers: [1] },
  { id: '05-inbound-pipeline', num: '05', title: '入站消息管线',
    desc: 'MsgContext 构造、dispatchInboundMessage、会话路由与命令解析',
    layers: [3] },
  { id: '06-sessions', num: '06', title: '会话与对话状态',
    desc: 'SessionEntry、转录文本、agent run 记录、上下文压缩与会话持久化',
    layers: [3] },
  { id: '07-agent-execution', num: '07', title: 'Agent 命令执行',
    desc: 'runAgentCommand、模型选择、auth profile、attempt 执行与事件发射',
    layers: [4] },
  { id: '08-llm-providers', num: '08', title: 'LLM Provider 集成',
    desc: 'provider 扩展模型、Anthropic/OpenAI 统一抽象、模型目录、流式与凭证轮换',
    layers: [4] },
  { id: '09-tools-and-skills', num: '09', title: '工具与技能系统',
    desc: '工具目录、工具解析与调用、技能加载、审批门控与 MCP 集成',
    layers: [4] },
  { id: '10-plugin-system', num: '10', title: '插件系统与扩展 SDK',
    desc: 'extensions/ 目录、plugin-sdk barrel、插件加载器、清单元数据与钩子机制',
    layers: [4] },
  { id: '11-delivery-and-events', num: '11', title: '消息投递与事件流',
    desc: 'ReplyDispatcher、ReplyPayload 组装、投递回执、agent 事件广播与重试',
    layers: [3, 1] },
  { id: '12-web-ui-canvas', num: '12', title: 'Web UI 与 Canvas',
    desc: 'ui/ React 前端、WebSocket 协议、实时渲染与 Canvas 富消息',
    layers: [1] },
  { id: '13-voice-and-media', num: '13', title: '语音与媒体',
    desc: 'TTS、实时转写、媒体理解、图像/视频生成的扩展集成',
    layers: [4] },
  { id: '14-auth-and-security', num: '14', title: '认证与安全',
    desc: 'token/session 鉴权、scope 权限、配对流程、secrets 存储与审计',
    layers: [2] },
  { id: '15-glossary-and-faq', num: '15', title: '术语表与 FAQ',
    desc: '术语表、FAQ、环境变量与命令速查',
    layers: [] },
];

// 单请求 trace 导览：tour-00 是 overview + tour-01..N 是步骤
export const TOURS = [
  { id: 'tour-00-overview', num: '00', title: '导览总览',
    desc: '完整 trace 入口、8 段模板说明、17 步速览与状态变量表' },
  { id: 'tour-01-cli-boot', num: '01', title: '敲下 openclaw gateway 之后', desc: 'openclaw.mjs 启动器与 entry.ts 引导' },
  { id: 'tour-02-gateway-listen', num: '02', title: 'Gateway server 启动监听', desc: 'server.impl 启动 HTTP/WebSocket' },
  { id: 'tour-03-ws-connect', num: '03', title: 'WebChat 建立连接', desc: 'WebSocket 握手与连接鉴权' },
  { id: 'tour-04-chat-send-rpc', num: '04', title: '客户端发出 chat.send', desc: '前端把"你好"封装成 RPC 帧' },
  { id: 'tour-05-method-dispatch', num: '05', title: 'RPC 方法注册表分发', desc: 'registry 路由到 handleChatSend' },
  { id: 'tour-06-build-msgcontext', num: '06', title: '构造 MsgContext', desc: '把 RPC 参数变成入站消息上下文' },
  { id: 'tour-07-dispatch-inbound', num: '07', title: 'dispatchInboundMessage', desc: '入站分发的总协调器' },
  { id: 'tour-08-session-resolve', num: '08', title: '会话解析与加载', desc: '定位 session、agent、model' },
  { id: 'tour-09-message-received-hook', num: '09', title: 'message_received 钩子', desc: '插件在分发前介入' },
  { id: 'tour-10-reply-dispatcher', num: '10', title: '创建 ReplyDispatcher', desc: '投递、重试与打字指示器协调器' },
  { id: 'tour-11-agent-command', num: '11', title: '进入 agent command', desc: 'runAgentCommand 解析运行时' },
  { id: 'tour-12-build-prompt', num: '12', title: '构建 prompt 与上下文', desc: '历史 + 系统提示 + 当前消息' },
  { id: 'tour-13-llm-call', num: '13', title: '调用 LLM provider', desc: 'Anthropic 流式推理调用' },
  { id: 'tour-14-stream-events', num: '14', title: '流式事件发射与订阅', desc: 'agent 事件如何被消费' },
  { id: 'tour-15-finalize-reply', num: '15', title: '组装 ReplyPayload', desc: '事件累积成最终回复' },
  { id: 'tour-16-channel-deliver', num: '16', title: '投递回 WebChat 并广播', desc: 'channel send 与事件广播' },
  { id: 'tour-17-session-persist', num: '17', title: '会话持久化', desc: '转录文本写回 session 存储' },
];

export const TOUR_BY_ID = Object.fromEntries(TOURS.map(t => [t.id, t]));

// 所有文档（章节 + tour），用于路由查找和搜索
export const ALL_DOCS = [...CHAPTERS, ...TOURS];
export const CHAPTER_BY_ID = Object.fromEntries(ALL_DOCS.map(c => [c.id, c]));

// =========================================================
// 项目信息 —— 本文件是整个 web 查看器唯一需要按项目修改的 JS 文件。
// 其它 web/js/*.js 都从这里 import 这些常量，请勿在别处写死项目名。
// =========================================================
export const PROJECT_NAME = 'OpenClaw';

// 分析的代码版本（升级版本时改这 4 个常量即可，所有 GitHub 跳转链接都会更新）
export const PROJECT_GITHUB_REPO = 'openclaw/openclaw';
export const ANALYZED_COMMIT = '50a2481652';
export const ANALYZED_TAG = 'v2026.5.18';
export const ANALYZED_DATE = '2026-05-18';

// 首页文案
export const PROJECT_TAGLINE = 'OpenClaw 源码中文参考 Wiki —— 自托管的个人 AI 助手网关，统一接入二十余种消息渠道。';
export const PROJECT_FOCUS = 'Gateway 控制平面与单条消息全链路';
export const TRACE_TARGET = 'WebChat 发送一条"你好"，助手回复';

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
