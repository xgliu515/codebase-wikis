> 代码版本锁定在 `glifocat/nanoclaw@0683c6e`（tag `v2.0.64`, 2026-05-18）。下文所有 `file:line` 引用都是仓库根目录的相对路径，并落在这个 commit 上。

## 1. 当前情境

我们刚刚从 [步骤 06](./tour-single-cli-message-06-permission.md) 出来。Router 的 `deliverToAgent`（`src/router.ts:397`）已经把这条 CLI 消息走完了三道闸——messaging group `mg-cli-default` 解析出来了、wired agent group 是默认的 `ag-default`、`evaluateEngage()` 判定 `engage_mode='pattern'` 且 `engage_pattern='.'` 命中、access gate 没拒绝、`sender_scope` 没拒绝、`command-gate` 也放行。手里捏着的是一个 `(agent_group_id, messaging_group_id, threadId=null)` 三元组，外加 `event.message.content = '{"text":"ping","sender":"cli"}'`、`event.message.kind = 'chat'`、`userId = null`（CLI adapter 没注入 sender resolver hook，参见 [步骤 02](./tour-single-cli-message-02-cli-adapter.md)）。

现在到了 `deliverToAgent` 的第一行有意思的代码（`src/router.ts:410-415`）：

```ts
let effectiveSessionMode = agent.session_mode;
if (adapterSupportsThreads && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
  effectiveSessionMode = 'per-thread';
}

const { session, created } = resolveSession(agent.agent_group_id, mg.id, event.threadId, effectiveSessionMode);
```

CLI adapter 的 `supportsThreads` 是 `false`、`mg.is_group` 是 `0`（CLI 视为 DM），所以这条 if 不进。`agent.session_mode` 在默认 wiring 里是 `'shared'`，因此 `effectiveSessionMode = 'shared'`、`threadId = null` 顺势传入。`resolveSession()` 函数体在 `src/session-manager.ts:92-133`。

这一步要做的事是：**把"逻辑路由身份"（agent group + messaging group + thread）翻译成"物理运行时身份"（一个 `sessions` 行 + 一个磁盘目录 + 两个 SQLite 文件）**。三 DB 模型的 inbound/outbound 文件路径在这一步第一次出现实际值；后续所有步骤（08-17）都会在这个目录下面读写。

## 2. 这一步要解决的问题

> 给定 `(agent_group_id, messaging_group_id, thread_id)`，要么找到一个已经存在的 session 把这条消息接进去，要么开一个新的 session（包括磁盘目录、空 inbound.db、空 outbound.db、Central DB 里的 `sessions` 行）。两种情况下都返回同一种 `Session` 行——以便上层 `writeSessionMessage` 不用分支。

约束很多：

- **多 agent 共享一个 channel**：同一个 messaging group 可能被 wire 到好几个 agent group（fan-out）。Discord 的 `#general` 同时被 `support-bot` 和 `qa-bot` 接管，这两个 agent 必须各自有独立的 session、独立的 container、独立的对话状态——绝不能让 support 看到 qa 的历史。
- **threading 平台 vs DM 平台**：Slack/Discord 在群组里支持 thread；CLI/Telegram/WhatsApp 不支持。同一个 messaging group 在 thread 平台里要按 thread 切 session，在非 thread 平台里整个 channel 共一个 session。
- **agent-shared 跨平台拉直**：有些 agent（典型是 inbox-style 助手）希望"Slack 找我和 GitHub 找我都是同一个 session"——这样 agent 看到的对话历史是统一的。这种情况要让 messaging group 不参与 lookup。
- **首次出现 vs 复用**：CLI 第一条消息进来时 sessions 表是空的，需要 INSERT + mkdir + 建 SQLite 文件；之后所有消息都要复用同一个 session，否则每条 `ping` 都启一个新 container。
- **没有写 inbound.db 之前 sessions 行就必须 ready**：上层下一步（[步骤 08](./tour-single-cli-message-08-insert-messages-in.md)）要打开 `inbound.db` 写消息，所以 mkdir + `ensureSchema()` 必须在 `resolveSession` 返回之前完成。

整个函数同步执行、不开 transaction、不能 throw（throw 会让 CLI 消息丢失）。

## 3. 朴素方案

最直觉的实现：**用 `messaging_group_id` 当 session id**。

```ts
function resolveSession(_agentGroupId, messagingGroupId, _threadId, _mode) {
  let session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(messagingGroupId);
  if (!session) {
    db.prepare('INSERT INTO sessions VALUES (...)').run({ id: messagingGroupId, ... });
    fs.mkdirSync(sessionDir(messagingGroupId), { recursive: true });
    session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(messagingGroupId);
  }
  return { session };
}
```

写起来五行，CLI 第一条消息能跑通。

## 4. 朴素方案哪里会塌

四个独立的反例，每一个都对应 NanoClaw 实际生产里见过的 bug。

**(a) 多 agent fan-out**。`messaging_groups` 是平台层身份（一个 Discord channel = 一行），但 `messaging_group_agents` 是 N:M wiring。如果 `support-bot` 和 `qa-bot` 都 wire 到 `#general`，按朴素方案两个 agent 共用 `id=mg-xxx` 的 session——support agent 第二轮回复的时候，container 里读到的对话历史里掺着 qa 上一轮的输出。**而且共用 session 意味着只有一个 container**——qa 在 Bash 的时候，support 的消息排队等待。NanoClaw 的 session id 必须把 agent group 也编进去：见 `findSessionForAgent`（`src/db/sessions.ts:36-53`）那条 SQL 的 `WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id = ?`——三键查找而不是单键。

**(b) Thread vs 非 thread 混淆**。Slack 群里同一个 channel 同时有 30 个 thread 在跑。如果 session 按 channel 切，30 个并行讨论会塞进一份 messages_in / 一个 container，互相污染上下文（agent 答 thread A 的时候看到 thread B 的内容）。所以 thread 平台必须按 `(channel, thread)` 切 session——这正是 `effectiveSessionMode` 在 `src/router.ts:411` 被强制改成 `'per-thread'` 的原因：threaded adapter + group chat → 一律 per-thread，**不管 wiring 写的是什么**。CLI 不在这一支，原样保留 `'shared'`。

**(c) `agent-shared` mode 被砍掉**。有的 agent 是"统一收件箱"型——希望 GitHub mention 和 Slack DM 都进同一个 session，让 agent 看到的对话是统一的时间线。这种情况下 `session_mode='agent-shared'`，lookup 必须**忽略 messaging_group**，只按 agent_group 找。朴素方案完全做不到这一点。NanoClaw 把这条分支放在 `resolveSession()` 的最前面（`src/session-manager.ts:99-103`），用 `findSessionByAgentGroup()`（`src/db/sessions.ts:56-60`）直接绕开 messaging_group 维度。

**(d) `is_group=0` 的 DM 走 `shared` 退化**。DM（一对一）在朴素方案里也能跑，但 messaging group id 是平台特有格式（Telegram 是 `tg:user:42`、CLI 是 `cli:default`），不带 agent 维度。同上 fan-out 反例——一旦同一个 DM 被两个 agent 监听，session 又串了。CLI 的 `is_group=0`、`thread_id=null`、`session_mode='shared'` 三件套就是用来让 `findSessionForAgent` 走 `thread_id IS NULL` 分支同时仍然按 agent 切。

四个反例叠起来就是：**session id 是平台维度（channel/thread/DM）与 NanoClaw 维度（agent group）的组合产物，不能简化成任一单一字段**。

## 5. NanoClaw 的方案

`src/session-manager.ts:92-133` 的 `resolveSession()` 实现这套规则一共 41 行，主线如下。

```ts
export function resolveSession(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: 'shared' | 'per-thread' | 'agent-shared',
): { session: Session; created: boolean } {
  if (sessionMode === 'agent-shared') {
    const existing = findSessionByAgentGroup(agentGroupId);
    if (existing) return { session: existing, created: false };
  } else if (messagingGroupId) {
    const lookupThreadId = sessionMode === 'shared' ? null : threadId;
    const existing = findSessionForAgent(agentGroupId, messagingGroupId, lookupThreadId);
    if (existing) return { session: existing, created: false };
  }

  const id = generateId();
  const lookupThreadId = sessionMode === 'per-thread' ? threadId : null;
  const session: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: lookupThreadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };

  createSession(session);
  initSessionFolder(agentGroupId, id);
  log.info('Session created', { id, agentGroupId, messagingGroupId, threadId: lookupThreadId, sessionMode });
  return { session, created: true };
}
```

可以拆成四件事。

**(1) 三种 mode 的 lookup**。`agent-shared` 走 `findSessionByAgentGroup()`，按 `agent_group_id` 找最近的 active 行（`ORDER BY created_at DESC LIMIT 1`，`src/db/sessions.ts:58`）。`shared` 与 `per-thread` 都走 `findSessionForAgent()`，区别只在传不传 `threadId`——`'shared'` 把 threadId 改成 `null`，让 SQL 走 `thread_id IS NULL` 分支（`src/db/sessions.ts:48-52`）；`'per-thread'` 把真的 threadId 传进去。两条 SQL 一定要绑定 `status='active'`——否则 close 掉的旧 session 会被误复用。

**(2) `id` 不是 messaging group id**。新 session 用 `generateId()`（`src/session-manager.ts:79-81`）生成 `sess-<timestamp>-<rand>`。这步把"路由身份"和"运行时身份"彻底解耦——同一个 channel 可以历史上有很多个 session id（用户 `/clear` 之后会建新的，archived 之后也会建新的），lookup 三键不变而 id 在变。

**(3) `initSessionFolder()` 建目录 + 建两个 DB**。`src/session-manager.ts:136-143`：

```ts
export function initSessionFolder(agentGroupId: string, sessionId: string): void {
  const dir = sessionDir(agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });
  ensureSchema(inboundDbPath(agentGroupId, sessionId), 'inbound');
  ensureSchema(outboundDbPath(agentGroupId, sessionId), 'outbound');
}
```

`sessionDir()` 在 `src/session-manager.ts:52-54` 算的路径是 `<DATA_DIR>/v2-sessions/<agent_group_id>/<session_id>/`——对应到默认配置就是 `data/v2-sessions/ag-default/sess-1715...-abcdef/`。`ensureSchema()` 在 `src/db/session-db.ts:13-18` 是关键：它每次都 `db.pragma('journal_mode = DELETE')`、`db.exec(schema)`、`db.close()`——**写完立刻 close**，这是三 DB 跨 mount 不变量之一（见第 3 章 §3.7）。

**(4) `createSession()` 插 Central DB**。`src/db/sessions.ts:6-13` 一条 INSERT，事务由调用方（这里没开）决定——`better-sqlite3` 在 WAL 下单条 INSERT 默认 implicit transaction，足够。

**返回值有 `created: boolean`**。上层 `deliverToAgent` 拿到之后在 `src/router.ts:468` 把它写进 log 里，方便排查"为什么 container 突然冷启动"。

**Connection caching：故意没有**。注意 `resolveSession` 不打开也不缓存 inbound/outbound 连接，**只建文件**。理由有三：(a) 后面 `writeSessionMessage` 每次 open-write-close（`src/session-manager.ts:225-247`），这是跨 mount 一致性必需的（§3.7 不变量 2）；(b) connection cache 会让 host 重启后 stale 引用残留；(c) `better-sqlite3` 的连接打开开销在本地文件系统几百微秒，per-message overhead 不显著。Container 那边因为是只读 + 同进程长寿命，可以缓存，那是另一边的事。

对我们这条 CLI `ping`：CLI adapter 在 host 启动时自动创建了 mg `mg-cli-default`，但 `sessions` 表里此时**没有**对应 `ag-default + mg-cli-default + null` 的行。所以走 `findSessionForAgent` → 空 → INSERT 一条 `id=sess-1715-...` 的新行 → `mkdir -p data/v2-sessions/ag-default/sess-1715-.../`、`outbox/` → 建 `inbound.db` 和 `outbound.db` 两个空 schema 文件 → 返回 `{ session, created: true }`。

```
resolveSession()
       │
       ├── sessionMode === 'agent-shared' ?
       │       └── yes: findSessionByAgentGroup(ag)  ─── hit → 复用
       │
       ├── messagingGroupId != null ?
       │       └── yes: findSessionForAgent(ag, mg, threadId or null)  ─── hit → 复用
       │
       └── miss → generateId() → INSERT sessions
                 → mkdir sessionDir + outbox
                 → ensureSchema(inbound.db, 'inbound')
                 → ensureSchema(outbound.db, 'outbound')
                 → return { session, created: true }
```

注意整个函数没有 `try/catch`：`mkdirSync` / `ensureSchema` / `createSession` 一旦 throw（磁盘满、Central DB 锁住），异常会一路冒到 router → CLI adapter → CLI client，那边会显示 stack 给操作者。这是有意为之——session 建不出来就不能继续，container 也别 spawn，让人去修磁盘。

## 6. 代码位置

- `src/session-manager.ts:92-133` — `resolveSession()` 函数体，三种 mode 的分流。
- `src/session-manager.ts:136-143` — `initSessionFolder()`，mkdir + 建两个空 DB。
- `src/session-manager.ts:52-69` — `sessionDir` / `inboundDbPath` / `outboundDbPath` / `heartbeatPath` 路径计算辅助。
- `src/session-manager.ts:79-81` — `generateId()`，新 session id 格式 `sess-<ts>-<rand>`。
- `src/db/sessions.ts:6-13` — `createSession()` INSERT。
- `src/db/sessions.ts:36-53` — `findSessionForAgent()` 三键查找。
- `src/db/sessions.ts:56-60` — `findSessionByAgentGroup()` agent-shared 模式的 lookup。
- `src/db/session-db.ts:13-18` — `ensureSchema()` 建 DB + 设 `journal_mode=DELETE`。
- `src/router.ts:397-485` — `deliverToAgent()` 整个调用上下文，第 410-415 行算 `effectiveSessionMode`、第 415 行调 `resolveSession`。
- `src/types.ts:117` — `MessagingGroupAgent.session_mode` 字段定义，三种取值。
- `src/types.ts:122-132` — `Session` 行 schema。

## 7. 分支与扩展

继续这条 CLI trace 必读：

- **下一步** [步骤 08：写 messages_in 并发出 wake](./tour-single-cli-message-08-insert-messages-in.md) 会用刚拿到的 `session` 调 `writeSessionMessage`，那里第一次真正打开 `inbound.db` 写盘。
- 第 7 章 §"[src/session-manager.ts](./07-host-architecture.md#sessionmanager-ts)" 列了模块全部 export，包括 `writeOutboundDirect` / `writeSystemResponse` 这些 router 不走但 command-gate 和 admin 路径走的接口。
- 第 7 章 §"[Session 生命周期](./07-host-architecture.md#session-lifecycle)" 是这一节的纵向视角：session 从 create → active → container running → idle → stopped → close 的状态机，`markContainerRunning` / `markContainerIdle` / `markContainerStopped` 这三组 setter 分别在哪里被调。
- 第 4 章 §"[Session mode](./04-routing-model.md#session-mode)" 给出 `session_mode` 三个取值在不同 channel 下的真值表（Discord/Slack/Telegram/CLI 各自落在哪一支），以及 admin 怎么在 `messaging_group_agents` 里改这个字段。

横向分支：

- **archived/closed session**：`status='closed'` 的行不会被 lookup 命中，所以下一条同 channel 消息会建新 session。closing 由 admin 调 `/sessions close <id>` 触发，路径在 `src/cli/commands/sessions.ts`。
- **`agent-shared` 模式的危险**：`findSessionByAgentGroup` 用 `ORDER BY created_at DESC LIMIT 1` 选"最新一条"。如果同 agent 有多条 active session（不该出现但理论上可能），这条 SQL 不报错只选最近的，会有静默路由。社区 PR #1124 提议加 `UNIQUE(agent_group_id) WHERE session_mode='agent-shared'` 但因为 session 表本身不存 session_mode（mode 来自 wiring），暂时只能靠运维约束。
- **thread 重活化**：threaded adapter 在 `mention-sticky` mode 下用 session 存在与否作为"thread 已订阅"的信号（`src/router.ts:384-390`）——也就是说**session 行本身就是订阅状态**，没有独立的 `subscriptions` 表。
- **CLI 的 `mg-cli-default`**：CLI adapter 在启动时（参见 [步骤 02](./tour-single-cli-message-02-cli-adapter.md)）一定会创建这个 messaging group，并自动 wire 到默认 agent。所以 CLI 永远不会走 `routeInbound` 第 184 行的 "auto-create mg" 路径，也永远不会被 `recordDroppedMessage` 'no_agent_wired' 拦下。
- **`writeSessionRouting` 不在这一步**：这条 session 的"默认回信地址"是在容器 wake 时（[步骤 09](./tour-single-cli-message-09-spawn-container.md)）由 `writeSessionRouting()` 写进 `inbound.db.session_routing` 表的，**不是**在 resolve 时。`resolveSession` 只建 schema 不写数据。

## 8. 看完这一步你脑子里要装的

1. session id ≠ messaging group id ≠ agent group id。session id 是新生成的 `sess-<ts>-<rand>`，但 lookup 的"指纹"是 `(agent_group_id, messaging_group_id, thread_id)` + session_mode 这套组合，丢任何一维都会串。
2. `session_mode` 有三档：`shared`（按 messaging group 聚合，忽略 thread）、`per-thread`（按 (mg, thread) 切）、`agent-shared`（按 agent group 聚合，忽略 mg）。threaded adapter 在群聊里会**强制**升级到 `per-thread`，CLI/DM 保留原值。
3. `initSessionFolder` 同步建出 `<DATA_DIR>/v2-sessions/<ag>/<sid>/`、`outbox/`、空 `inbound.db`、空 `outbound.db`——这四样在 `resolveSession` 返回前必须 ready，因为下一步立刻要写 inbound。
4. `ensureSchema` 每次都 open-write-close 并强制 `journal_mode=DELETE`——这是跨 mount 不变量的保障，**不要重构成 connection cache**。
5. `resolveSession` 不开 transaction、不 catch 异常、不缓存连接。三个"不"是有意的：throw 让磁盘问题立刻被看到、close 让 container 侧能看到最新数据、单条 INSERT 在 WAL 下足够安全。
6. 返回的 `{ session, created }` 里 `created` 是观察值——上层只用来打 log，不用来分支。后续步骤（08、09）按 `session.container_status` 决定是否要 spawn。
