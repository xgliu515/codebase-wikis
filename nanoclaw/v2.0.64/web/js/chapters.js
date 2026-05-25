// 章节元数据。id 即文件 basename，title/desc 用于侧栏和首页卡片。
// NanoClaw v2.0.64 wiki — 15 章 + 单条 CLI 消息 trace 导览（19 步）

export const CHAPTERS = [
  { id: '01-overview', num: '01', title: '总览：一切皆消息',
    desc: '为什么 host 与 container 之间只用两个 SQLite 文件，而不是 IPC / 共享内存 / 文件监听',
    layers: [1, 2, 3, 4] },
  { id: '02-codebase-layout', num: '02', title: '代码布局与构建拓扑',
    desc: 'Node host（pnpm）+ Bun 容器内 agent-runner 的双 runtime；channels / providers 跑在 sibling branch',
    layers: [1, 2, 3, 4] },
  { id: '03-three-db-model', num: '03', title: '三 DB 数据模型',
    desc: '中央 v2.db + 每 session 的 inbound.db / outbound.db；seq 奇偶、心跳文件、journal_mode=DELETE',
    layers: [4] },
  { id: '04-entity-model-and-permissions', num: '04', title: '实体模型与权限',
    desc: 'users / agent_groups / messaging_groups / sessions / wirings；owner/admin/member 与 canAccessAgentGroup',
    layers: [2, 4] },
  { id: '05-host-entrypoint', num: '05', title: 'Host 入口与生命周期',
    desc: 'src/index.ts 的启动顺序：env → DB → migrations → channel 注册 → delivery/sweep loop → ncl socket → shutdown',
    layers: [2] },
  { id: '06-inbound-router', num: '06', title: '入站路由 (router.ts)',
    desc: 'channel event → messaging_group → agent_group fan-out → 权限 → session → 写 inbound.db → wake container',
    layers: [1, 2] },
  { id: '07-session-container-lifecycle', num: '07', title: '会话与容器生命周期',
    desc: 'session-manager + container-runner / restart / circuit-breaker；on_wake 列怎么防止 dying container 偷消息',
    layers: [2, 3] },
  { id: '08-agent-runner-poll-loop', num: '08', title: 'Agent-runner：容器内的轮询循环',
    desc: 'poll-loop 主循环、formatter、provider 抽象、Claude SDK 调用、processing_ack 三信号区分活/慢/死',
    layers: [3] },
  { id: '09-outbound-delivery', num: '09', title: '出站投递与系统动作',
    desc: 'delivery 1s pull-based 轮询 outbound.db；chat / schedule / approval / question / agent-to-agent 多 kind 派发',
    layers: [1, 2] },
  { id: '10-host-sweep', num: '10', title: '60 秒 Sweep',
    desc: 'processing_ack 同步、stale 检测、due-message wake、recurrence、OneCLI long-poll、orphan 清理',
    layers: [2] },
  { id: '11-channels-and-chat-sdk-bridge', num: '11', title: '通道适配器与 Chat SDK 桥',
    desc: '内置 CLI adapter 完整 walkthrough、Chat SDK bridge、ask-question 跨平台原语、skill-install 七步模板',
    layers: [1] },
  { id: '12-approvals-and-onecli', num: '12', title: '审批与凭证：OneCLI 网关',
    desc: '凭证不落 env / chat、双侧 approval、ensureAgent + selective secret mode、四类 approval kind',
    layers: [2, 4] },
  { id: '13-ncl-cli-and-self-mod', num: '13', title: 'ncl CLI 与 self-modification',
    desc: 'host socket + container DB transport、cli_scope 三档、install_packages 与 add_mcp_server 重启流程',
    layers: [2, 3] },
  { id: '14-v1-to-v2-migration', num: '14', title: 'v1 → v2 迁移',
    desc: 'migrate-v2.sh 阶段化、STOP banner 怎么拦 Claude 的 merge 本能、handoff.json + /migrate-from-v1',
    layers: [] },
  { id: '15-glossary-and-faq', num: '15', title: '术语表 + FAQ + 速查',
    desc: '77 个术语、15 个 FAQ、环境变量 / 命令 / 路径 / 故障排查速查表',
    layers: [] },
];

// Trace 导览组：每个 group 是一条独立的 tour，跟一个最小请求穿过 NanoClaw 全栈。
export const TOURS = [
  {
    slug: 'single-cli-message',
    title: '单条 CLI 消息 Trace 导览',
    target: 'pnpm run chat "ping"',
    steps: [
      { id: 'tour-single-cli-message-00-overview', num: '00', title: '导览总览',
        desc: '完整 trace 入口、8 段模板说明、18 步速览' },
      { id: 'tour-single-cli-message-01-chat-script', num: '01', title: '客户端连上 CLI socket',
        desc: 'scripts/chat.ts 通过 net.connect(data/cli.sock) 写一行 JSON' },
      { id: 'tour-single-cli-message-02-cli-adapter', num: '02', title: 'CLI adapter 收到字节',
        desc: 'src/channels/cli.ts handleConnection 按行解析 JSON 并构造 InboundEvent' },
      { id: 'tour-single-cli-message-03-on-inbound', num: '03', title: 'onInbound 进入 channel-registry',
        desc: 'adapter 把事件交给 setup 时注入的闭包 wrapper，进入 router' },
      { id: 'tour-single-cli-message-04-resolve-mg', num: '04', title: 'router 解析 messaging_group',
        desc: '按 (channel_type=cli, platform_id=local) 在 v2.db 查 messaging_groups' },
      { id: 'tour-single-cli-message-05-resolve-ag', num: '05', title: 'router 解析 agent_group',
        desc: '按 messaging_group_agents 的 engage_mode / pattern / priority 选 agent_group（fan-out）' },
      { id: 'tour-single-cli-message-06-permission', num: '06', title: '权限检查 canAccessAgentGroup',
        desc: '查 user_roles + agent_group_members；CLI 走 unknown_sender_policy=public 短路' },
      { id: 'tour-single-cli-message-07-resolve-session', num: '07', title: 'session-manager 解析/创建 session',
        desc: '按 (ag, mg, thread_id) 找或新建 session 行，算出 inbound/outbound.db 路径并 lazy open' },
      { id: 'tour-single-cli-message-08-insert-messages-in', num: '08', title: '写 messages_in 并发出 wake',
        desc: '用 even seq INSERT 一行 messages_in；fire-and-forget wakeContainer' },
      { id: 'tour-single-cli-message-09-spawn-container', num: '09', title: 'container-runner 拉起容器',
        desc: '没有 running container 时 docker run 一个，挂载 session + agent group，OneCLI ensureAgent 注入凭证 proxy' },
      { id: 'tour-single-cli-message-10-container-boot', num: '10', title: '容器内 agent-runner 启动',
        desc: 'bun 启动 index.ts → 加载 container.json → 注册 providers → 组装系统 prompt → 启 poll loop' },
      { id: 'tour-single-cli-message-11-poll-loop', num: '11', title: 'poll-loop 拿到 messages_in',
        desc: 'poll inbound.db；写 processing_ack 占用；三信号区分活/慢/死' },
      { id: 'tour-single-cli-message-12-formatter', num: '12', title: 'formatter 组装 prompt',
        desc: '把 system prompt + 当前消息组装成 <message> XML；历史委托给 SDK continuation 不重塞' },
      { id: 'tour-single-cli-message-13-provider-query', num: '13', title: 'provider.query() 调用 Claude',
        desc: 'ClaudeProvider.query() 调 @anthropic-ai/claude-agent-sdk 的 query()，传 tools / system / model' },
      { id: 'tour-single-cli-message-14-streaming-push', num: '14', title: '流式 push() 中途更新',
        desc: 'processQuery 双轨：主 await SDK events + 500ms setInterval 副轨 push 用户后续消息；每事件 touchHeartbeat' },
      { id: 'tour-single-cli-message-15-write-final', num: '15', title: '写入最终 messages_out',
        desc: 'markCompleted + dispatchResultText 正则解析 + writeMessageOut 跨 DB 取下一奇数 seq' },
      { id: 'tour-single-cli-message-16-delivery-poll', num: '16', title: 'host delivery 轮询发现新行',
        desc: '每 1s 扫所有 active session 的 outbound.db，找未投递的 messages_out 行；inflightDeliveries 防双投' },
      { id: 'tour-single-cli-message-17-adapter-deliver', num: '17', title: 'adapter.deliver 写回 CLI client',
        desc: 'cli.ts deliver() 把 {text:"pong"} 写回 client socket；no client 时 silent no-op 不丢消息' },
      { id: 'tour-single-cli-message-18-client-print-exit', num: '18', title: '客户端打印并退出',
        desc: 'chat.ts 收到 JSON 行、stdout 打印、silence timer 2s 触发 process.exit(0)；整条 18 步闭环复盘' },
    ],
  },
];

// =========================================================
// 项目信息 —— 本文件是整个 web 查看器唯一需要按项目修改的 JS 文件。
// 其它 web/js/*.js 都从这里 import 这些常量，请勿在别处写死项目名。
// =========================================================
export const PROJECT_NAME = 'NanoClaw';

export const PROJECT_GITHUB_REPO = 'nanocoai/nanoclaw';
export const ANALYZED_COMMIT = '0683c6e';
export const ANALYZED_TAG = 'v2.0.64';
export const ANALYZED_DATE = '2026-05-18';

export const PROJECT_TAGLINE = 'NanoClaw 源码中文参考 Wiki —— 个人 Claude 助手网关；Node host + per-session Bun 容器，仅通过 SQLite 文件通信。';
export const PROJECT_FOCUS = 'V2 架构';
export const TRACE_TARGET = 'pnpm run chat "ping"';

// =========================================================
// ⚠️ DO NOT REMOVE OR REWRITE BELOW THIS LINE
// The viewer's other JS files (utils.js / app.js / sidebar.js / glossary.js etc.)
// import these helpers. If you delete or alter them the viewer breaks at module load
// with `does not provide an export named 'getRepoMode'`-style errors.
// =========================================================

export function normalizeTours(tours) {
  if (tours.length === 0 || (tours[0] && typeof tours[0].steps !== 'undefined')) return tours;
  return [{ slug: 'main', title: null, target: TRACE_TARGET || '', steps: tours }];
}

const _NORMALIZED_TOURS = normalizeTours(TOURS);
const _FLATTENED_TOUR_STEPS = _NORMALIZED_TOURS.flatMap(g => g.steps);
export const TOUR_BY_ID = Object.fromEntries(_FLATTENED_TOUR_STEPS.map(s => [s.id, s]));

const _FLATTENED_CHAPTERS = CHAPTERS.flatMap(c => {
  const entries = [c];
  if (Array.isArray(c.addenda)) {
    for (const a of c.addenda) {
      entries.push({ ...a, parentId: c.id, num: a.id.match(/^(\d+[a-z]?)/)?.[1] ?? c.num });
    }
  }
  return entries;
});
export const ALL_DOCS = [..._FLATTENED_CHAPTERS, ..._FLATTENED_TOUR_STEPS];
export const CHAPTER_BY_ID = Object.fromEntries(ALL_DOCS.map(c => [c.id, c]));

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
