// 章节元数据。id 即文件 basename，title/desc 用于侧栏和首页卡片。

export const CHAPTERS = [
  { id: '01-architecture-overview', num: '01', title: '导论与全局架构',
    desc: 'Hermes Agent 是什么，分层架构，进程启动链与文件依赖关系',
    layers: [1, 2, 3, 4] },
  { id: '02-entrypoints', num: '02', title: '入口与进程引导',
    desc: 'hermes 脚本 → hermes_cli/main.py → cli.py，CLI / gateway / batch 三大入口',
    layers: [1] },
  { id: '03-conversation-loop', num: '03', title: '核心对话循环',
    desc: 'AIAgent、run_conversation、conversation_loop、迭代预算与中断机制',
    layers: [2] },
  { id: '04-system-prompt', num: '04', title: '系统提示与上下文构造',
    desc: 'system_prompt / prompt_builder、SOUL.md / HERMES.md、环境提示与 prompt caching',
    layers: [2, 3] },
  { id: '05-tool-system', num: '05', title: '工具系统：注册、工具集与分发',
    desc: 'tools/registry 自动发现、toolsets 分组、handle_function_call 与并发执行',
    layers: [4] },
  { id: '06-terminal-environments', num: '06', title: '终端后端：七种执行环境',
    desc: 'BaseEnvironment 抽象与 local / docker / ssh / modal / daytona / singularity / vercel',
    layers: [4] },
  { id: '07-model-providers', num: '07', title: '模型 Provider 适配与凭证池',
    desc: '多 provider 统一为 OpenAI 格式、api_mode、adapter、CredentialPool、辅助 LLM',
    layers: [3] },
  { id: '08-context-compression', num: '08', title: '上下文压缩与轨迹压缩',
    desc: 'ContextEngine / ContextCompressor 在线压缩与 trajectory_compressor 离线压缩',
    layers: [3] },
  { id: '09-session-storage', num: '09', title: '会话存储与全文搜索',
    desc: 'SessionDB、SQLite WAL、FTS5 全文搜索与 CJK 三元组检索',
    layers: [3] },
  { id: '10-memory-system', num: '10', title: '记忆系统与学习闭环',
    desc: 'MemoryManager、MEMORY.md / USER.md、记忆 nudge、Honcho 等记忆 provider',
    layers: [4] },
  { id: '11-skills-and-curator', num: '11', title: '技能系统与 Curator',
    desc: '技能发现、注入为 slash command、自创建 / 自改进，后台 Curator 维护',
    layers: [4] },
  { id: '12-mcp-and-plugins', num: '12', title: 'MCP 集成与插件系统',
    desc: 'MCP 客户端 / 服务端 / OAuth，以及四层插件发现与注册机制',
    layers: [4] },
  { id: '13-messaging-gateway', num: '13', title: '消息网关与多平台',
    desc: '单进程多平台网关、平台适配器、DM 配对安全与消息投递路由',
    layers: [1] },
  { id: '14-cron-delegate-batch', num: '14', title: 'Cron 调度、子 Agent 派发与批量运行',
    desc: 'cron 定时调度器、delegate_task 子 agent 隔离、batch_runner 批量轨迹生成',
    layers: [1, 2] },
  { id: '15-glossary-and-faq', num: '15', title: '术语表与 FAQ',
    desc: '术语表、FAQ、环境变量与命令速查',
    layers: [] },
];

// 单请求 trace 导览：tour-00 是 overview + tour-01..N 是步骤
export const TOURS = [
  { id: 'tour-00-overview', num: '00', title: '导览总览',
    desc: '完整 trace 入口、8 段模板说明、20 步速览与状态变量表' },
  { id: 'tour-01-shell-entry', num: '01', title: '敲下 hermes 之后', desc: 'shell 脚本入口与进程引导' },
  { id: 'tour-02-arg-dispatch', num: '02', title: '参数解析与子命令分发', desc: 'hermes_cli/main.py 路由到 cmd_chat' },
  { id: 'tour-03-cli-construct', num: '03', title: '构造 HermesCLI', desc: 'cli.py::main 与配置加载' },
  { id: 'tour-04-init-agent', num: '04', title: '创建 AIAgent', desc: '_init_agent 与 agent_init' },
  { id: 'tour-05-tool-discovery', num: '05', title: '工具自动发现', desc: 'discover_builtin_tools 与 registry' },
  { id: 'tour-06-system-prompt', num: '06', title: '拼装系统提示', desc: 'build_system_prompt 与 SOUL.md' },
  { id: 'tour-07-repl-input', num: '07', title: 'REPL 读取用户输入', desc: 'HermesCLI.run 主循环' },
  { id: 'tour-08-enter-run-conversation', num: '08', title: '进入 run_conversation', desc: 'chat 调用与对话循环启动' },
  { id: 'tour-09-memory-prefetch', num: '09', title: '记忆 prefetch 与消息构造', desc: '转折前回忆与 api_messages' },
  { id: 'tour-10-first-api-call', num: '10', title: '第一次 LLM API 调用', desc: 'provider adapter 与凭证池' },
  { id: 'tour-11-parse-tool-call', num: '11', title: '解析 tool_call', desc: '模型返回 read_file 调用' },
  { id: 'tour-12-tool-dispatch', num: '12', title: '工具调度', desc: 'tool_executor 与 handle_function_call' },
  { id: 'tour-13-tool-execute', num: '13', title: 'read_file 实际执行', desc: 'file_tools 与审批检查' },
  { id: 'tour-14-tool-result', num: '14', title: '工具结果回灌', desc: 'tool 消息追加与循环回绕' },
  { id: 'tour-15-second-api-call', num: '15', title: '第二次 LLM API 调用', desc: '带工具结果再次请求模型' },
  { id: 'tour-16-final-response', num: '16', title: '纯文本响应与循环退出', desc: '无 tool_call 时退出循环' },
  { id: 'tour-17-streaming-render', num: '17', title: '流式渲染输出', desc: 'spinner 与 response box' },
  { id: 'tour-18-session-persist', num: '18', title: '会话持久化', desc: 'SessionDB 写入 messages' },
  { id: 'tour-19-post-turn', num: '19', title: '收尾：标题生成与记忆 sync', desc: '后台辅助任务' },
  { id: 'tour-20-back-to-repl', num: '20', title: '回到 REPL', desc: '一轮完成，等待下一条输入' },
];

export const TOUR_BY_ID = Object.fromEntries(TOURS.map(t => [t.id, t]));

// 所有文档（章节 + tour），用于路由查找和搜索
export const ALL_DOCS = [...CHAPTERS, ...TOURS];
export const CHAPTER_BY_ID = Object.fromEntries(ALL_DOCS.map(c => [c.id, c]));

// =========================================================
// 分析的代码版本（升级版本时改这 4 个常量即可，所有 GitHub 跳转链接都会更新）
// =========================================================
export const PROJECT_GITHUB_REPO = 'NousResearch/hermes-agent';
export const ANALYZED_COMMIT = 'f36c89cd5';
export const ANALYZED_TAG = 'f36c89cd5';
export const ANALYZED_DATE = '2026-05-17';

// 旧名兼容（部分早期文件仍引用这两个名字）
export const VLLM_GITHUB_REPO = PROJECT_GITHUB_REPO;
export const VLLM_ANALYZED_COMMIT = ANALYZED_COMMIT;
export const VLLM_ANALYZED_TAG = ANALYZED_TAG;
export const VLLM_ANALYZED_DATE = ANALYZED_DATE;

// =========================================================
// file:line 跳转链接：默认走 GitHub（任何人可用），可切换成本地 VSCode
// localStorage 里有 path → 'local' 模式；没有 → 'github' 模式
// =========================================================
const REPO_ROOT_KEY = 'hermes-agent-wiki-repo-root';

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
