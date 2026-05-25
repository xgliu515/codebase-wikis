> 代码版本锁定在 `glifocat/nanoclaw@0683c6e`（tag `v2.0.64`, 2026-05-18）。下文所有 `file:line` 引用都是仓库根目录的相对路径，并落在这个 commit 上。

## 1. 当前情境

[步骤 07](./tour-single-cli-message-07-resolve-session.md) 刚返回。Router 现在握着一个新鲜的 `Session` 行：

```
id:                 sess-1715290000-abc123
agent_group_id:     ag-default
messaging_group_id: mg-cli-default
thread_id:          null
container_status:   stopped
last_active:        null
```

磁盘上 `data/v2-sessions/ag-default/sess-1715290000-abc123/` 这个目录已经建好，里面有：

- `inbound.db` —— 空表（已经 `ensureSchema('inbound')`，DELETE journal 模式）
- `outbound.db` —— 空表
- `outbox/` —— 空目录

`deliverToAgent` 现在跑到 `src/router.ts:450-459`：

```ts
writeSessionMessage(session.agent_group_id, session.id, {
  id: messageIdForAgent(event.message.id, agent.agent_group_id),
  kind: event.message.kind,
  timestamp: event.message.timestamp,
  platformId: deliveryAddr.platformId,
  channelType: deliveryAddr.channelType,
  threadId: deliveryAddr.threadId,
  content: event.message.content,
  trigger: wake ? 1 : 0,
});
```

`wake` 在我们这条路径是 `true`（engage + accessOk + scopeOk 都过了，走的是 engaged 分支），所以 `trigger=1`。`messageIdForAgent` 在 `src/router.ts:493-496` 把原始消息 id 后缀加上 `:<agentGroupId>` 防止 fan-out 撞 PK——具体值在 CLI 里大致是 `msg-1715290000-xxxxxx:ag-default`。

`writeSessionMessage` 立即调 `src/session-manager.ts:225-247`，再下钻到 `insertMessage`（`src/db/session-db.ts:94-134`）。我们这一步要把这条 `ping` 物化进 `inbound.db.messages_in`，然后 router 调 `wakeContainer(session)` 触发后续容器拉起。

## 2. 这一步要解决的问题

> 把一条**已经被路由+权限+命令闸**全部放行的入站消息，**完整且原子地**写进 `inbound.db.messages_in`，并保证 container 在下一次 poll 时**一定**能看到，同时不让 channel adapter 的回应被阻塞超过几毫秒。

约束一条比一条难：

- **seq 命名空间必须分给 host**：messages_in.seq 必须是偶数（见 [第 3 章 §Seq 奇偶约定](./03-three-db-model.md#36-seq-奇偶约定)），container 写 messages_out 用奇数。两边都从 `MAX(seq)` 算下一个，但奇偶不能撞。
- **跨 mount 可见性**：写完之后，container 那边的 `agent-runner` 进程要能立刻看到这一行。SQLite 默认的 WAL 在 VirtioFS/9p 上跨 host/guest 不能可靠传播——必须 DELETE 模式 + 写后立刻 close 连接（[第 3 章 §3.7](./03-three-db-model.md#37-跨-mount-不变量delete-模式与-open-write-close)）。
- **channel adapter 的延迟预算很小**：CLI 这条无所谓，但同一个 `routeInbound` 路径还要服务 Discord/Slack webhook。Discord webhook 必须在 3 秒内回 200，否则平台会重试——再加重试 dedup 的难题。所以"写完 inbound 之后等 container 起来再回应"是不可接受的。
- **container 可能根本没在跑**：CLI 第一条消息时 `container_status='stopped'`。需要触发 spawn——但又不能 await spawn（spawn 可能 5-10 秒），所以 wake 必须 fire-and-forget。
- **attachment 安全**：messages_in.content 是 JSON，里面可能带 base64 `data`。`writeSessionMessage` 在写盘之前会把 base64 抽到 `inbox/<msgId>/<filename>`，把 content 里的 `data` 换成 `localPath`——CLI ping 没有 attachment，但这一步的安全代码每次都会跑（详见 §5）。

## 3. 朴素方案

```ts
function writeAndWake(session, message) {
  const db = openInbound(session);
  db.exec("INSERT INTO messages_in (id, kind, content) VALUES (...)");
  await spawnContainerAndWaitReady(session);   // 等 container 起来 + poll 一轮 ack
  return;
}
```

写一条记录，spawn 容器，等容器 ready。从 channel adapter 看就是"消息已处理，回 200 OK"。

## 4. 朴素方案哪里会塌

**(a) 没分配 seq，container 一边的 `edit_message(seq=N)` 工具直接错乱**。messages_in 和 messages_out 共享 `seq` 命名空间是 agent 视角的核心约定——`edit(5)` 反查需要凭奇偶就能确定查哪张表。朴素方案让 SQLite 自动 ROWID 或者忘了管 seq，那 agent 改第 5 条消息时根本不知道是改自己说的还是改用户说的。

**(b) 没设 `journal_mode=DELETE`**。SQLite 默认是 DELETE，但 `ensureSchema()` 在 [步骤 07](./tour-single-cli-message-07-resolve-session.md) 已经显式设过一次——朴素方案如果换一种 open（比如 `Database(path, { wal: true })`）会把模式翻成 WAL，container 那边的只读连接立刻看不到新数据。container_agent_runner 起来 poll 一辈子也 poll 不到 `ping`。

**(c) `await spawnContainerAndWaitReady` 把 channel adapter 阻塞 5-10 秒**。Discord 给 webhook 的回应窗口是 3 秒——超时它会重试同一个 event。重试又会进 routeInbound 写第二条 messages_in（不同 message id）——container 起来时看到两条一模一样的 `ping`，回复两次。

**(d) 写完没 close 连接**。如果 host 这边 cache 长连接，container 那边 page cache 永远停在第一次 read 时的快照（[第 3 章 §3.7 不变量 2](./03-three-db-model.md#不变量-2host-必须-open-write-close)）。这条约束写在 `src/session-manager.ts:189-192` 的注释里："Opens and closes the DB on every call. Do not refactor to reuse a long-lived connection"。

**(e) Container spawn 失败时整条 inbound 消息丢了**。朴素方案把 spawn 当成"写入的一部分"——但 OneCLI gateway 临时不可达、docker daemon 重启时，spawn throw 出去，messages_in 也回滚（如果在 transaction 里）或者悬挂（如果没 transaction）。两者都坏。

正确的姿势是：**inbound 写盘和 container spawn 是两件独立的事**。前者必须完成，后者失败可重试（host-sweep 会兜底）。

## 5. NanoClaw 的方案

`writeSessionMessage` + `wakeContainer` 这两步的拆分就是为了应对上面五条全部。

**(1) `writeSessionMessage` 的 attachment 抽取**（`src/session-manager.ts:227-247`）：

```ts
const content = extractAttachmentFiles(agentGroupId, sessionId, message.id, message.content);

const db = openInboundDb(agentGroupId, sessionId);
try {
  insertMessage(db, {
    id: message.id,
    kind: message.kind,
    timestamp: message.timestamp,
    platformId: message.platformId ?? null,
    channelType: message.channelType ?? null,
    threadId: message.threadId ?? null,
    content,
    processAfter: message.processAfter ?? null,
    recurrence: message.recurrence ?? null,
    trigger: message.trigger ?? 1,
    sourceSessionId: message.sourceSessionId ?? null,
    onWake: message.onWake ?? 0,
  });
} finally {
  db.close();
}

updateSession(sessionId, { last_active: new Date().toISOString() });
```

`extractAttachmentFiles`（`src/session-manager.ts:270-358`）做的事：试 `JSON.parse(content)`，挑出 `attachments[].data` 是 base64 的项，写到 `inbox/<messageId>/<filename>`，把 content 里的 `data` 字段删了换成 `localPath: "inbox/.../foo.png"`。安全防御五条：(i) `isSafeAttachmentName` 校验 message id 和 filename 拒绝 `../` / 绝对路径；(ii) `lstat` 拒绝 symlink；(iii) `realpath` 保证目标在 inbox 根下；(iv) `writeFileSync` 的 `wx` flag 拒绝覆盖；(v) 失败只丢这一个附件，不让整条 message 写不进去。CLI `ping` 没有 attachment，JSON.parse 之后 `attachments` 是 undefined，函数原样返回 content。

**(2) `insertMessage` 分配 seq + 一条 INSERT**（`src/db/session-db.ts:94-134`）：

```ts
export function insertMessage(db: Database.Database, message: { ... }): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after, recurrence, series_id, trigger, source_session_id, on_wake)
     VALUES (@id, @seq, @kind, @timestamp, 'pending', @platformId, @channelType, @threadId, @content, @processAfter, @recurrence, @id, @trigger, @sourceSessionId, @onWake)`,
  ).run({
    ...message,
    trigger: message.trigger ?? 1,
    onWake: message.onWake ?? 0,
    sourceSessionId: message.sourceSessionId ?? null,
    seq: nextEvenSeq(db),
  });
}
```

`nextEvenSeq`（`src/db/session-db.ts:89-92`）：

```ts
export function nextEvenSeq(db: Database.Database): number {
  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  return maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);
}
```

空表上 `MAX(seq) = 0`，返回 2。所以 CLI 这条 `ping` 写入后是 `seq=2`。注意只看 `messages_in` 表——不看 `messages_out`——因为 host 只管偶数；奇偶各管各的命名空间，container 那边的 `messages-out.ts` 第 54 行额外做了 `Math.max(maxIn, maxOut)` 跨表取 max 来防止倒退（见[第 3 章 §3.6](./03-three-db-model.md#36-seq-奇偶约定)），host 这边一边走偶数序列自增就够了。

注意几个 NULL 字段的默认值：`process_after = null`（立即可处理）、`recurrence = null`（不是 cron）、`series_id = @id`（自己就是 series 头）、`trigger = 1`（要唤醒）、`on_wake = 0`（不是 wake-only 消息）、`source_session_id = null`（不是 a2a 调用）、`status = 'pending'`（hard-coded 在 SQL 字面里）。

**(3) open-write-close 不变量**。`openInboundDb` 在 `src/session-manager.ts:361-365` 调 `openInboundDbRaw`（`src/db/session-db.ts:21-26`）：

```ts
export function openInboundDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  return db;
}
```

`journal_mode = DELETE` 每次重申一次（idempotent）；`busy_timeout` 5 秒兜底——理论上 host 是 inbound 单写者不会撞锁，但万一 lazy migration（`migrateMessagesInTable` 加 column）和 insert 撞到一起，5 秒里能等过去。

`try { insertMessage } finally { db.close() }`——**关连接是 finally**，throw 也会 close。这保证 container 那边再 poll 时（`PRAGMA mmap_size = 0` 强制磁盘 read，见[第 3 章 §3.7 不变量 2](./03-three-db-model.md#不变量-2host-必须-open-write-close)）拿到的 page cache 是写完的状态而不是空的。

**(4) `updateSession(sessionId, { last_active: ... })`**（`src/session-manager.ts:249`）。Central DB 里 `sessions.last_active` 更新——不是 session DB。这一列被 host-sweep 用来识别"闲置 session"，被 admin 命令 `/sessions list` 用来排序。注意这不是 container 心跳，container 心跳走 `.heartbeat` 文件（[第 3 章 §3.8](./03-three-db-model.md#38-心跳文件-touch-而不是-db-写)）。

**(5) Router 回 `deliverToAgent` 之后**（`src/router.ts:472-484`）：

```ts
if (wake) {
  startTypingRefresh(session.id, session.agent_group_id, event.channelType, event.platformId, event.threadId);
  const freshSession = getSession(session.id);
  if (freshSession) {
    const woke = await wakeContainer(freshSession);
    if (!woke) stopTypingRefresh(freshSession.id);
  }
}
```

`startTypingRefresh` 给 channel 发"正在输入"指示器（CLI 无视）。然后 `wakeContainer(freshSession)`——**有 `await`，但 `wakeContainer` 自己几乎不阻塞**。`wakeContainer` 内部（`src/container-runner.ts:85-106`）会做：(a) 检查 active container map，已经在跑就 return true；(b) 检查 wakePromises map，已经在 spawn 就 join 那个 promise；(c) 调 `spawnContainer(session)` 并把返回 promise 存进 wakePromises。CLI 第一次 `ping` 走 (c)，spawnContainer 本身是 async 但**router 的 await 只等到 spawn 函数返回**——而 spawn 函数发出 `child_process.spawn` 之后立刻 return（见 [步骤 09](./tour-single-cli-message-09-spawn-container.md)），不等 container 内部 boot。所以 router 的整条 `routeInbound` 在毫秒级内 return 给 CLI adapter。

`woke` 返回 `false` 只有在 OneCLI gateway 不可达这种瞬态错误下发生。这时 inbound row 已经写进去了、status 还是 pending，host-sweep 下一轮（默认 30s）会再尝试 wake。这就是把 write 和 wake 拆开的价值——失败不丢消息。

**整条时序**：

```
router.deliverToAgent
   │
   ├─ writeSessionMessage(...)                            ────  毫秒级
   │     │
   │     ├─ extractAttachmentFiles  (无 attachment 走过场)
   │     ├─ openInboundDb
   │     ├─ insertMessage  → seq=2, status='pending', trigger=1
   │     ├─ db.close()                                   ←  跨 mount 可见性触发点
   │     └─ updateSession(last_active)
   │
   ├─ startTypingRefresh   (CLI no-op)
   │
   └─ wakeContainer(session)                              ────  ~10ms (spawn 同步部分)
         │
         ├─ activeContainers.has?  no
         ├─ wakePromises.get?  none
         └─ spawnContainer(session)  → 同步部分 return → promise pending
                                                          ↓
                                                  (后台异步)
                                                  docker run → container boots → poll messages_in
```

CLI adapter 收到 routeInbound 的 resolved Promise，整条消息从 stdin 到 router return 全程 <50ms（不算 container boot）。spawn 失败不影响这条返回——`wakeContainer` 把内部 throw 转成 `return false`（`src/container-runner.ts:97-100`）：

```ts
const promise = spawnContainer(session)
  .then(() => true)
  .catch((err) => {
    log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
    return false;
  })
  .finally(() => {
    wakePromises.delete(session.id);
  });
```

contract：`wakeContainer` 永不 throw、永不阻塞超过 spawn 同步段的时间。

## 6. 代码位置

- `src/router.ts:450-459` — `deliverToAgent` 里的 `writeSessionMessage` 调用点。
- `src/router.ts:472-484` — `wake` 分支：typing indicator + `wakeContainer(freshSession)`。
- `src/router.ts:493-496` — `messageIdForAgent`，fan-out 时给消息 id 加 `:agent_group_id` 后缀避免 PK 撞车。
- `src/session-manager.ts:193-250` — `writeSessionMessage` 全文，含 attachment 抽取 + open-write-close + last_active 更新。
- `src/session-manager.ts:189-192` — 不要把连接 cache 化的告警注释。
- `src/session-manager.ts:270-358` — `extractAttachmentFiles` 五重防御。
- `src/session-manager.ts:361-370` — `openInboundDb` / `openOutboundDb` 的薄包装（含 `migrateMessagesInTable`）。
- `src/db/session-db.ts:21-26` — `openInboundDbRaw` 设 `journal_mode=DELETE` + `busy_timeout=5000`。
- `src/db/session-db.ts:89-92` — `nextEvenSeq` 算下一个偶数 seq。
- `src/db/session-db.ts:94-134` — `insertMessage` SQL 字面 + 默认值兜底。
- `src/db/session-db.ts:308-332` — `migrateMessagesInTable` lazy 补列：`series_id` / `trigger` / `source_session_id` / `on_wake`，老 session 文件夹也能用最新代码。
- `src/container-runner.ts:85-106` — `wakeContainer` 入口 + 去重 + try/catch 转 boolean。
- `src/db/sessions.ts:74-92` — `updateSession`，被 `writeSessionMessage` 调用更新 `last_active`。

## 7. 分支与扩展

继续 trace：

- **下一步** [步骤 09：container-runner 拉起容器](./tour-single-cli-message-09-spawn-container.md) 详细拆 `spawnContainer` 内部的 mount、OneCLI gateway 注入、docker run 调用。
- [第 3 章 §3.5 Inbound DB schema](./03-three-db-model.md#351-inbounddbhost--container) 列出了 `messages_in` 所有列、`destinations` / `session_routing` / `delivered` 三张姊妹表，以及每张表谁读谁写。
- [第 3 章 §3.6 Seq 奇偶约定](./03-three-db-model.md#36-seq-奇偶约定) 给出 host/container 怎么各自维护命名空间，包括 container 那边 `Math.max(maxIn, maxOut)` 跨表取 max 的细节。
- [第 6 章 §Step 6 — insertMessage](./06-host-message-flow.md#step-6-insertmessage) 是这一步的纵向回顾，把 router → writeSessionMessage → insertMessage 这条链路在 host 消息流大图里定位。

横向：

- **`trigger=0` 的 accumulate 路径**：同一个 channel 的另一条 wiring 没 engage 但 `ignored_message_policy='accumulate'` 时，messages_in 也写一行但 `trigger=0`，container poll 时 `countDueMessages`（`src/db/session-db.ts:136-147`）的 SQL `trigger = 1` 把它过滤掉——agent 不会被唤醒，但 container 真的需要发言时可以读到作为上下文。CLI 这条 trigger 永远是 1。
- **`on_wake=1` 的 wake-only 消息**：上层 admin 路径写"重启提示"时设 `on_wake=1`，container 第一轮 poll 后这一行就会被 skip（详细见 [第 6 章](./06-host-message-flow.md)）。
- **`process_after` 调度**：定时任务（`src/modules/scheduling/`）插入 `messages_in` 时设 `process_after = datetime('now', '+N seconds')`，`countDueMessages` 的 SQL `(process_after IS NULL OR process_after <= datetime('now'))` 把未到期的过滤掉。scheduling 模块 export `nextEvenSeq` 就是为了在自己的插入路径保持偶数不变量。
- **`source_session_id` 与 agent-to-agent**：a2a 模块用这个字段记录"是哪个 source session 调过来的"，container 回复时用作 return 路径。CLI 这条永远是 null。
- **`writeOutboundDirect`** (`src/session-manager.ts:382-403`)：command-gate（[步骤 06](./tour-single-cli-message-06-permission.md)）拒绝 admin 命令时**绕过 container 直接写 outbound**——只在容器没跑的时候安全（用了 `openOutboundDb` 的只读 path 是 bug，但 schema 上能 INSERT，因为 sqlite readonly 是 pragma 不是 OS flag——这是该函数的已知小裂缝，详细在 [第 7 章](./07-host-architecture.md)）。
- **lazy migration 是 idempotent 但有代价**：`migrateMessagesInTable` 每次 open inbound 都会跑一遍 `PRAGMA table_info`、加 column / 不加 column。一次 open 多大概几百微秒额外开销。如果哪天觉得 inbound write 路径太慢，第一刀就该砍这里——但**砍之前先把所有 alpha 用户的 session DB 升级到最新 schema**。

## 8. 看完这一步你脑子里要装的

1. host 写 inbound = **一条 INSERT + 一次 close**。`writeSessionMessage` 函数体短得很，但每一步都对应一条跨 mount 不变量：DELETE journal、open-write-close、奇偶 seq、attachment 抽到磁盘。
2. seq 不是 SQLite 自动 ROWID——是 `nextEvenSeq` 显式算出来的下一个偶数。奇偶切分是 agent 视角 `edit_message(seq)` 工具能不联表定位行的根因。
3. `db.close()` 在 finally 里——这条比 INSERT 本身还重要。少了这一句 container 那边 mmap page cache 卡死，poll 一千年也看不到新消息。
4. write 和 wake 是两件独立事。write 不能 throw（throw 就丢消息），wake 可以失败但失败被 catch 转成 false，host-sweep 兜底重试。channel adapter 因此能在毫秒级回应平台 webhook 不超时。
5. router 的 `await wakeContainer(...)` 是看似阻塞实则不阻塞——wakeContainer 的 spawn 内部用 `child_process.spawn` fire-and-forget 之后立刻 return，container 真正 boot 是后台的事。整条 routeInbound 从 stdin 到 return 在普通硬件上 <50ms。
6. `last_active` 在这一步更新——但**只更新 Central DB 的 sessions 行**，不动 session DB。心跳走文件 mtime（不是这里写）。两个时间戳来源不同，host-sweep 综合看。
