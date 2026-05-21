// 章节元数据。id 即文件 basename，title/desc 用于侧栏和首页卡片。

export const CHAPTERS = [
  { id: '01-architecture-overview', num: '01', title: '架构总览与启动流程',
    desc: 'pi 是什么，四层架构，monorepo 布局，pi 命令从 bin 字段到 ready 接受 prompt 的引导链',
    layers: [1, 2, 3, 4] },
  { id: '02-ai-layer-providers-registry', num: '02', title: 'AI 层：Provider 抽象与模型注册表',
    desc: 'stream/streamSimple/complete 三个入口、apiProviderRegistry 懒加载、models.generated.ts 与生成脚本',
    layers: [4] },
  { id: '03-ai-provider-implementations', num: '03', title: 'AI 层：Provider 实现与统一事件流',
    desc: 'AssistantMessageEventStream、transform-messages、anthropic/google/openai/bedrock/mistral/cloudflare/faux 各家实现',
    layers: [4] },
  { id: '04-ai-auth-and-oauth', num: '04', title: 'AI 层：认证、OAuth 与 API key',
    desc: 'env-api-keys 自动检测、Anthropic / GitHub Copilot / OpenAI Codex 三家 OAuth、auth.json 凭据落地',
    layers: [4] },
  { id: '05-agent-runtime-loop', num: '05', title: 'Agent Runtime：核心 Loop 与工具执行',
    desc: 'agentLoop 状态机、AgentEvent 模型、tool_call 闭环、AbortSignal 取消、错误处理',
    layers: [3] },
  { id: '06-agent-runtime-sessions-compaction', num: '06', title: 'Agent Runtime：Session 持久化与 Compaction',
    desc: 'JsonlRepo / MemoryRepo、buildSessionContext、AgentHarness、system prompt、skill 块、compaction',
    layers: [3] },
  { id: '07-coding-agent-cli-startup', num: '07', title: 'Coding Agent：CLI 启动与运行时装配',
    desc: 'cli.ts 薄壳、main.ts 参数解析、AgentSessionRuntime 单例、四种运行模式、shutdown',
    layers: [2] },
  { id: '08-coding-agent-tools', num: '08', title: 'Coding Agent：内置工具系统',
    desc: 'bash / read / write / edit / find / grep / ls 七大工具，file-mutation-queue、path-utils、typebox schema、审批',
    layers: [2] },
  { id: '09-coding-agent-extensions', num: '09', title: 'Coding Agent：扩展机制与自定义 Provider',
    desc: 'jiti 动态加载、virtual modules、ExtensionFactory、生命周期 hooks、examples 解读',
    layers: [2] },
  { id: '10-tui-renderer', num: '10', title: 'TUI：差分渲染引擎与终端控制',
    desc: 'TUI 类主循环、差分渲染算法、ProcessTerminal、stdin-buffer、Kitty 协议（图片 + key release）',
    layers: [1] },
  { id: '11-tui-components-and-keys', num: '11', title: 'TUI：组件库、键盘输入与编辑器',
    desc: '12 个内置组件、keys.ts 解码状态机、KeybindingsManager、Editor 内部架构、East Asian width',
    layers: [1] },
  { id: '12-interactive-mode', num: '12', title: '交互模式：从输入到输出的完整闭环',
    desc: 'InteractiveMode 5562 行骨架、组件树、事件订阅、斜杠命令、取消机制、状态栏 / token 计数',
    layers: [1, 2] },
  { id: '13-config-and-sessions', num: '13', title: '配置、Session 文件与项目级定制',
    desc: '~/.pi/agent 目录布局、auth.json / settings.json 格式、session JSONL、环境变量速查',
    layers: [2] },
  { id: '14-tests-scripts-and-release', num: '14', title: '测试、脚本与发布工具',
    desc: 'test.sh / pi-test.sh、faux provider、回归测试约定、scripts/ 全员、biome、supply-chain hardening',
    layers: [2] },
  { id: '15-glossary-and-faq', num: '15', title: '术语表与 FAQ',
    desc: '46 个术语、15 条 FAQ、环境变量与常用命令速查、仓库目录树',
    layers: [] },
];

// 单请求 trace 导览：tour-00 是 overview + tour-01..17 是步骤
export const TOURS = [
  { id: 'tour-00-overview', num: '00', title: '导览总览',
    desc: '完整 trace 入口、8 段模板说明、17 步速览与状态变量表' },
  { id: 'tour-01-cli-startup', num: '01', title: 'pi 命令进入 main.ts',
    desc: 'npm bin → cli.ts 薄壳 → main.ts 参数解析与模式分支' },
  { id: 'tour-02-auth-and-models', num: '02', title: '加载认证与模型注册表',
    desc: '打开 auth.json 取 Anthropic API key、models.generated.ts 展平进内存' },
  { id: 'tour-03-runtime-assembly', num: '03', title: '装配 AgentSessionRuntime',
    desc: '扩展加载、内置工具注册、settings 合并、virtual modules 注入' },
  { id: 'tour-04-session-create', num: '04', title: '创建 AgentSession',
    desc: '新建 session 文件、初始 system message、绑定 runtime 资源' },
  { id: 'tour-05-interactive-mode-startup', num: '05', title: '进入 InteractiveMode + 初始化 TUI',
    desc: 'TUI 切 raw mode、组件树挂载、首次 render、等待键盘' },
  { id: 'tour-06-key-input-decode', num: '06', title: '用户敲入字符 → 键盘解码 → InputComponent',
    desc: 'stdin-buffer → keys.ts 解码 → InputComponent.handleInput，含中文 East Asian width' },
  { id: 'tour-07-submit-to-session', num: '07', title: '回车提交 → AgentSession.prompt 接管',
    desc: 'Enter 触发 submit handler，UserMessage 入 messages，调 prompt() 进 agent runtime' },
  { id: 'tour-08-build-context', num: '08', title: '构造 AgentContext',
    desc: '选模型、装配工具表、渲染 system prompt、生成 AbortController' },
  { id: 'tour-09-agentloop-start', num: '09', title: '进入 agentLoop → 调 streamSimple',
    desc: 'turn loop 启动，api-registry 命中 anthropic provider 的 stream 函数' },
  { id: 'tour-10-provider-http', num: '10', title: 'anthropic provider 翻译 + HTTP + SSE 开启',
    desc: 'transform-messages 翻译，POST /v1/messages，SSE 流建立' },
  { id: 'tour-11-sse-events', num: '11', title: 'SSE → AssistantMessageEventStream 事件化',
    desc: 'anthropic 自实现 SSE parser，规整成 pi 统一事件序列' },
  { id: 'tour-12-toolcall-event', num: '12', title: 'LLM 决定调用 read 工具 → ToolCallEvent',
    desc: 'tool_use 块完整组装为 ToolCallEvent，agent-loop 等 stop_reason 进入工具执行' },
  { id: 'tour-13-execute-read', num: '13', title: 'agent loop 执行 read 工具',
    desc: 'typebox 校验 → path-utils 解析 → fs.readFile → 行号格式化 → ToolResultEvent' },
  { id: 'tour-14-tool-result-and-continue', num: '14', title: 'tool_result 回喂 → 二次 stream → 最终文本',
    desc: '外层 turn loop 进入下一轮，模型这次直接生成最终回答，stop_reason = end_turn' },
  { id: 'tour-15-persist-and-usage', num: '15', title: '流结束 → JSONL 写盘 + usage 统计',
    desc: 'handleAgentEvent append 到 session 文件、usage 累积、shouldCompact 判断' },
  { id: 'tour-16-ui-update', num: '16', title: '事件订阅者 → InteractiveMode 更新 TUI',
    desc: 'InteractiveMode 把 TextEvent/工具事件/UsageEvent/StopEvent 投到组件树' },
  { id: 'tour-17-render-and-loop', num: '17', title: 'TUI 差分渲染 + 等待下一轮',
    desc: '差分算法发 ANSI cursor + erase + 新行，闭环回到 tour-06' },
];

export const TOUR_BY_ID = Object.fromEntries(TOURS.map(t => [t.id, t]));

// 所有文档（章节 + tour），用于路由查找和搜索
export const ALL_DOCS = [...CHAPTERS, ...TOURS];
export const CHAPTER_BY_ID = Object.fromEntries(ALL_DOCS.map(c => [c.id, c]));

// =========================================================
// 项目信息 —— 本文件是整个 web 查看器唯一需要按项目修改的 JS 文件。
// 其它 web/js/*.js 都从这里 import 这些常量，请勿在别处写死项目名。
// =========================================================
export const PROJECT_NAME = 'Pi';

// 分析的代码版本（升级版本时改这 4 个常量即可，所有 GitHub 跳转链接都会更新）
export const PROJECT_GITHUB_REPO = 'earendil-works/pi';
export const ANALYZED_COMMIT = '4868222e';
export const ANALYZED_TAG = '4868222e';
export const ANALYZED_DATE = '2026-05-20';

// 首页文案
export const PROJECT_TAGLINE = 'Pi 源码中文参考 Wiki —— earendil-works 的 agent harness mono-repo，含自扩展编码 agent、agent runtime、多 provider LLM 统一接口与差分渲染 Terminal UI 库。';
export const PROJECT_FOCUS = 'coding-agent 主路径与单条 prompt 全链路';
export const TRACE_TARGET = '在终端敲入「读一下 README.md 的第一行」，模型调用 read 工具回包';

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
