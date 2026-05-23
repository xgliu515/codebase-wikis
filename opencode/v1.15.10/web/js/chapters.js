// 章节元数据。id 即文件 basename，title/desc 用于侧栏和首页卡片。

export const CHAPTERS = [
  { id: '01-entrypoints',          num: '01', title: '入口与命令分派',
    desc: 'opencode CLI 怎么启动，yargs 子命令地图，run / serve / tui 三条主路径',
    layers: [1] },
  { id: '02-config-and-auth',      num: '02', title: '配置与多提供商鉴权',
    desc: 'opencode.json / ~/.opencode 配置层级、env / OAuth / 官方代理多种 provider 鉴权',
    layers: [1, 3] },
  { id: '03-session-and-messages', num: '03', title: '会话与消息模型',
    desc: 'Session / MessageV2 / Part 三层数据结构，SQLite schema 与流式累积',
    layers: [2] },
  { id: '04-agents',               num: '04', title: 'Agent 抽象与模式',
    desc: 'agent 即配置，build / plan / general 三种内置形态与 subagent',
    layers: [2] },
  { id: '05-agent-loop',           num: '05', title: '核心 Agent 循环',
    desc: 'Session.chat / processor / run-state / retry，用户消息 → LLM → 工具 → LLM 收敛',
    layers: [2] },
  { id: '06-llm-provider',         num: '06', title: 'LLM 提供商层与流式',
    desc: 'packages/llm 抽象、Vercel AI SDK 之上的 30+ provider、protocol 解码与缓存策略',
    layers: [3] },
  { id: '07-tool-system',          num: '07', title: '工具系统',
    desc: 'tool registry、内置工具一览、execution pipeline、truncate 与 PTY shell',
    layers: [4] },
  { id: '08-permissions',          num: '08', title: '权限系统',
    desc: 'Rule / Ruleset / arity、ask / allow / deny、subagent 与 plan 模式的权限实现',
    layers: [4] },
  { id: '09-tui',                  num: '09', title: 'TUI 渲染',
    desc: 'SolidJS + @opentui/core，事件订阅 → 增量重绘、keymap 与 dialog 层',
    layers: [1] },
  { id: '10-server',               num: '10', title: '服务器模式与 HTTP API',
    desc: 'Hono server、SSE 实时事件、projectors、auth/CORS/mDNS 与多客户端共用',
    layers: [1, 2] },
  { id: '11-mcp',                  num: '11', title: 'MCP 集成',
    desc: 'opencode 作为 MCP 客户端：stdio / HTTP / SSE transport、OAuth、tools / resources',
    layers: [4] },
  { id: '12-plugins',              num: '12', title: '插件系统',
    desc: '@opencode-ai/plugin SDK、loader、provider 适配器、生命周期 hook 与 vs MCP',
    layers: [4] },
  { id: '13-advanced-features',    num: '13', title: '进阶特性：分叉 / 压缩 / 快照 / 成本',
    desc: 'Session fork、revert、snapshot、compaction、cost 统计、ACP / share / worktree',
    layers: [2, 3] },
  { id: '14-glossary-and-faq',     num: '14', title: '术语表与 FAQ',
    desc: '术语表、FAQ、环境变量与命令速查',
    layers: [] },
];

// 单请求 trace 导览：tour-00 是 overview + tour-01..N 是步骤
export const TOURS = [
  { id: 'tour-00-overview',          num: '00', title: '导览总览',
    desc: '完整 trace 入口、8 段模板说明、16 步速览与状态变量表' },
  { id: 'tour-01-shell-entry',       num: '01', title: '敲下 opencode run 之后',
    desc: 'bun 启动 packages/opencode/src/index.ts，yargs middleware 链' },
  { id: 'tour-02-run-dispatch',      num: '02', title: 'run 子命令分派',
    desc: 'cli/cmd/run.ts 接管：参数解析、stdin pipe 检测、临时 session 准备' },
  { id: 'tour-03-config-load',       num: '03', title: '加载配置与鉴权',
    desc: 'opencode.json + auth.json + env 合并出当前 provider + model' },
  { id: 'tour-04-db-init',           num: '04', title: '数据库初始化与 JSON 迁移',
    desc: 'SQLite 开库、schema 应用、首跑 JSON 数据迁移' },
  { id: 'tour-05-session-create',    num: '05', title: '创建 Session 与首条消息',
    desc: 'Session.create / Storage.write，user MessageV2 落表与 bus 广播' },
  { id: 'tour-06-build-prompt',      num: '06', title: '装配 system prompt 与工具表',
    desc: 'agent prompt + workspace 提示 + 内置工具 schema 序列化' },
  { id: 'tour-07-llm-call',          num: '07', title: '第一次 LLM 流式请求',
    desc: 'session/llm.ts → packages/llm → provider 适配 → SSE 流读取' },
  { id: 'tour-08-parse-tool-call',   num: '08', title: '解码 tool_use 片段',
    desc: '协议层把 Anthropic tool_use / OpenAI function_call 归一为 Part(toolCall)' },
  { id: 'tour-09-tool-dispatch',     num: '09', title: '查表分派 read 工具',
    desc: 'Tool registry 命中 + Zod 校验 + arity 计算' },
  { id: 'tour-10-permission-check',  num: '10', title: '权限评估',
    desc: 'Permission.evaluate 跑 ruleset，read 命中 allow / 默认放行' },
  { id: 'tour-11-tool-execute',      num: '11', title: '执行 read("README.md")',
    desc: 'fs.readFile → truncate → ToolResult Part 入库' },
  { id: 'tour-12-result-loopback',   num: '12', title: '工具结果回灌',
    desc: '把 ToolResult 拼成 assistant turn 输入再调一次 LLM' },
  { id: 'tour-13-final-text',        num: '13', title: '生成最终文本响应',
    desc: '模型只产 text → text Part 累积 + isStreaming 翻转' },
  { id: 'tour-14-persist-and-bus',   num: '14', title: '持久化与事件广播',
    desc: 'Part 写入 SQLite + 每次写触发 MessagePartUpdated SSE' },
  { id: 'tour-15-stream-render',     num: '15', title: '渲染到终端 / stdout',
    desc: 'run 命令 / TUI 订阅 SSE，流式打印 / 增量重绘' },
  { id: 'tour-16-idle-and-exit',     num: '16', title: '会话 idle 与进程退出',
    desc: 'SessionIdle 事件、cost 累计、进程退出码' },
];

export const TOUR_BY_ID = Object.fromEntries(TOURS.map(t => [t.id, t]));

// 所有文档（章节 + addenda + tour），用于路由查找和搜索。
// addenda 被平铺进 ALL_DOCS，每个 addendum 项额外带 parentId，便于内容渲染时回链。
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
// 项目信息 —— 本文件是整个 web 查看器唯一需要按项目修改的 JS 文件。
// =========================================================
export const PROJECT_NAME = 'opencode';

// 分析的代码版本
export const PROJECT_GITHUB_REPO = 'anomalyco/opencode';
export const ANALYZED_COMMIT = 'd74d166ac';
export const ANALYZED_TAG = 'v1.15.10';
export const ANALYZED_DATE = '2026-05-23';

// 首页文案
export const PROJECT_TAGLINE = 'opencode 源码中文参考 Wiki —— 开源的终端 AI 编码 Agent，TypeScript + Bun monorepo。';
export const PROJECT_FOCUS = '';
export const TRACE_TARGET = 'opencode run "What\'s in README.md?"';

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

export const STORAGE_PREFIX = (() => {
  const base = (PROJECT_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'codebase') + '-wiki';
  const ver = getCurrentVersionDir();
  return ver ? `${base}-${ver}` : base;
})();

// =========================================================
// file:line 跳转链接：默认走 GitHub（任何人可用），可切换成本地 VSCode
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
