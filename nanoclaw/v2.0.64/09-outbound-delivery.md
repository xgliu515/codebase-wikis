## 出站投递与系统动作

容器把 agent 的回复写进自己的 `outbound.db`，但容器没有任何渠道凭证、没有 Discord/Slack/Telegram SDK 的句柄，也根本不在 host 的进程空间里。从 `messages_out` 一行 SQL 数据到"用户的 Discord 客户端看到一条新消息"，中间这段路径全部由 host 进程的 **delivery loop** 走完。

这一章拆掉 `src/delivery.ts` 的每一段：它怎么发现新行、怎么避免重复投递、怎么把不同 `kind` 的消息派发到不同 handler、怎么把"agent 想做一个系统级动作"的请求落到 inbound.db 上、怎么在失败时退避重试、以及怎么把用户对 question / approval 卡片的点击回到 agent。

---

### 1. 设计问题

容器写完一条 outbound 行之后，host 端要把这条行走完一整套流程：

1. **发现**：容器和 host 之间没有信号通道（第 7 章已经论证过为什么不用 socket / inotify）。host 必须主动轮询 outbound.db 来知道有新行。
2. **路由**：每行带 `channel_type` + `platform_id` + `thread_id`。host 要找到对应的 channel adapter（CLI、Discord、Slack 等），把内容交给它。
3. **payload 解析**：`kind` 字段决定怎么处理 —— `chat` 是普通回复，`chat-sdk` 是带按钮的卡片，`system` 是 agent 请求 host 帮忙做事（"安排一个定时任务"、"安装一个 npm 包"、"创建一个新 agent group"），`agent` channel_type 是 agent-to-agent 消息（直接路由到目标 session 的 inbound.db 而不进任何渠道）。
4. **附件**：消息可能带文件（agent 用了 `send_file` MCP 工具）。文件以二进制存在 `outbox/<msg-id>/<filename>`，host 必须把这些字节也喂给 adapter。
5. **标记 delivered**：投递成功后，把 `message_out_id → platform_message_id` 映射写到 inbound.db 的 `delivered` 表。后续 agent 要 edit / react 这条消息时，用这个映射找原消息。
6. **失败重试**：渠道 API 可能临时挂掉（Discord 限流、Slack 503）。失败时不能丢，要退避重试。但也不能无限重试 —— 用户已经看不到的消息再投也没意义。
7. **响应 inbound**：用户点击 question 卡片的"Approve"按钮、对 approval 卡片选"Reject"，这条响应不是普通聊天文本 —— 它要找到 pending_question / pending_approval 行，把答案路由回原 session 让 agent 看到。

这 7 件事全部由 `src/delivery.ts` 直接或间接负责。

第二层约束来自**两库分写**（详见第 6 章）：outbound.db 只能容器写、host 只读；inbound.db 只能 host 写、容器只读。这意味着：

- host 投递成功后**不能**回写 outbound.db 加一个 "delivered" 标记。
- host 必须找别的地方记"这条 outbound 已经投过了"。
- 这个地方就是 inbound.db 的 `delivered` 表 —— 一张纯 host 写、纯做去重用的小表。

下面这张图框出整个出站路径：

<svg viewBox="0 0 820 560" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="End-to-end outbound delivery pipeline: container writes outbound.db, host polls and dispatches by kind, channel adapter sends to platform"><defs><marker id="ar9a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="410" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">outbound 投递管道：container → host loop → channel adapter</text><g><rect x="60" y="50" width="700" height="80" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="410" y="72" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">容器 (per session, Bun)</text><text x="410" y="95" text-anchor="middle" font-size="11" fill="currentColor">agent  ─ SDK ─►  messages_out  (outbound.db, container-owned, RW)</text><text x="410" y="116" text-anchor="middle" font-size="10" fill="#94a3b8">写完即返回，从不主动通知 host</text></g><line x1="410" y1="130" x2="410" y2="160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9a)"/><text x="425" y="150" font-size="10" fill="#64748b">1s 轮询</text><g><rect x="30" y="160" width="760" height="280" rx="10" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.5"/><text x="410" y="180" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">host: src/delivery.ts</text><g><rect x="60" y="195" width="320" height="46" rx="6" fill="#ffffff" stroke="#0d9488" stroke-width="1"/><text x="220" y="213" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">pollActive (1s)</text><text x="220" y="230" text-anchor="middle" font-size="10" fill="#64748b">getRunningSessions() · running+idle</text></g><g><rect x="440" y="195" width="320" height="46" rx="6" fill="#ffffff" stroke="#0d9488" stroke-width="1"/><text x="600" y="213" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">pollSweep (60s)</text><text x="600" y="230" text-anchor="middle" font-size="10" fill="#64748b">getActiveSessions() · 兜底大集合</text></g><line x1="220" y1="241" x2="380" y2="260" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9a)"/><line x1="600" y1="241" x2="440" y2="260" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9a)"/><g><rect x="240" y="260" width="340" height="40" rx="6" fill="#ccfbf1" stroke="#0d9488" stroke-width="1"/><text x="410" y="284" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">deliverSessionMessages (inflight lock)</text></g><line x1="410" y1="300" x2="410" y2="316" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9a)"/><g><rect x="160" y="316" width="500" height="58" rx="6" fill="#ccfbf1" stroke="#0d9488" stroke-width="1"/><text x="410" y="334" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">drainSession</text><text x="410" y="350" text-anchor="middle" font-size="10" fill="#64748b">① getDueOutboundMessages  ② diff getDeliveredIds  ③ iterate</text><text x="410" y="365" text-anchor="middle" font-size="10" fill="#94a3b8">openOutboundDb (RO) + openInboundDb (RW)</text></g><line x1="410" y1="374" x2="410" y2="390" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9a)"/><g><rect x="100" y="390" width="620" height="42" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1"/><text x="410" y="408" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">deliverMessage  (kind 派发)</text><text x="410" y="423" text-anchor="middle" font-size="10" fill="#64748b">system | agent | ask_question | chat → deliveryAdapter.deliver</text></g></g><line x1="410" y1="440" x2="410" y2="470" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9a)"/><g><rect x="60" y="470" width="700" height="70" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/><text x="410" y="490" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">channel adapter  (CLI / Discord / Slack / ...)</text><text x="410" y="510" text-anchor="middle" font-size="11" fill="currentColor">deliver(platformId, threadId, OutboundMessage) → platform_message_id</text><text x="410" y="528" text-anchor="middle" font-size="10" fill="#94a3b8">回写 inbound.delivered (host 写) → 下次 drain 跳过</text></g></svg>
<span class="figure-caption">图 R9.1 ｜ outbound 投递全链路：容器写 → host 双 timer 轮询 → drainSession → deliverMessage 派发 → channel adapter → 平台。橙=容器、青=host、蓝=外部平台。</span>

<details>
<summary>ASCII 原版</summary>

```
┌──────────────────────────────────────────────────────────────────┐
│  容器 (per session)                                              │
│   agent ── SDK ──► messages_out  (outbound.db, container-owned) │
│                       │                                          │
└───────────────────────┼──────────────────────────────────────────┘
                        │
                        ▼  (1s 轮询)
┌──────────────────────────────────────────────────────────────────┐
│  host: src/delivery.ts                                           │
│                                                                  │
│  pollActive (1s)  ──► getRunningSessions()                       │
│  pollSweep  (60s) ──► getActiveSessions()                        │
│        │                                                         │
│        ▼                                                         │
│  deliverSessionMessages(session)                                 │
│        │                                                         │
│        ▼                                                         │
│  drainSession(session):                                          │
│   ① getDueOutboundMessages(outDb)                                │
│   ② diff against getDeliveredIds(inDb)   ──► undelivered list    │
│   ③ for each msg → deliverMessage(msg, session, inDb)            │
│                                                                  │
│  deliverMessage 分支：                                            │
│   ├─ kind === 'system'      → handleSystemAction (注册表派发)    │
│   ├─ channel_type==='agent' → routeAgentMessage (写目标 inbound) │
│   ├─ content.type==='ask_question' → 写 pending_questions        │
│   └─ 其它 → deliveryAdapter.deliver(channelType, ...)            │
│        │                                                         │
│        ▼                                                         │
│  markDelivered(inDb, msg.id, platform_message_id)                │
└──────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────────────┐
│  channel adapter (CLI / Discord / Slack / ...)                   │
│    deliver(platformId, threadId, OutboundMessage)                │
│       → 调用平台 SDK，返回 platform_message_id                    │
└──────────────────────────────────────────────────────────────────┘
```

</details>

每个箭头都是一个明确的边界，下面逐段解释。

---

### 2. 入口与生命周期

#### 2.1 两个 timer chain

`src/delivery.ts:107-149` 定义了两个独立的轮询循环：

```ts
const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;

export function startActiveDeliveryPoll(): void {
  if (activePolling) return;
  activePolling = true;
  pollActive();
}

export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  pollSweep();
}

async function pollActive(): Promise<void> {
  if (!activePolling) return;
  try {
    const sessions = getRunningSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Active delivery poll error', { err });
  }
  setTimeout(pollActive, ACTIVE_POLL_MS);
}

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;
  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }
  setTimeout(pollSweep, SWEEP_POLL_MS);
}
```

两条链分别扫描不同的 session 集合：

- **`pollActive`**：每 1s，扫 `container_status IN ('running', 'idle')` 的 session（`src/db/sessions.ts:70-72`）。这是"容器活着的"集合，正在产生 outbound 行，必须紧贴它。
- **`pollSweep`**：每 60s，扫 `status = 'active'` 的所有 session（`src/db/sessions.ts:66-68`）。这是兜底 —— 容器刚结束、`container_status` 还没及时更新成 stopped 的 race，或者 active poll 那一秒恰好 throw 了 —— 60s 的 sweep 会把这些落网的行捞起来。

这两条链都通过 `deliverSessionMessages(session)` 进入投递逻辑，**所以同一个 running session 在同一秒可能被两条链都调用**。

#### 2.2 用 `inflightDeliveries` 防双投

两条 timer chain 重叠，原始的实现会让同一个 session 被并发 drain：两个调用都看到同一条未投行、都调 adapter.deliver、用户看到同一条消息两次。`markDelivered` 用 `INSERT OR IGNORE` 保证 DB 层面只有一行 delivered，但 adapter 那次实际的网络调用已经发生过两次。

`src/delivery.ts:37-50` 注释解释了这个 race，`src/delivery.ts:151-162` 是去重锁：

```ts
const inflightDeliveries = new Set<string>();

export async function deliverSessionMessages(session: Session): Promise<void> {
  if (inflightDeliveries.has(session.id)) return;
  inflightDeliveries.add(session.id);
  try {
    await drainSession(session);
  } finally {
    inflightDeliveries.delete(session.id);
  }
}
```

注意是**跳过**不是**排队**：如果 sweep tick 跑进来发现 active tick 还在 drain，sweep 这次直接 return。漏掉的消息会在下一个 1s active tick 里被捞起来。这比排队简单得多，也避免了"一个慢 session 的两条 tick 在队列里互相等"的死锁。

#### 2.3 启动顺序

`src/index.ts:144-175` 显示 delivery 是 host 启动的第 5、6 步：

```ts
const deliveryAdapter = {
  async deliver(channelType, platformId, threadId, kind, content, files) {
    const adapter = getChannelAdapter(channelType);
    if (!adapter) {
      log.warn('No adapter for channel type', { channelType });
      return;
    }
    return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
  },
  async setTyping(channelType, platformId, threadId) {
    const adapter = getChannelAdapter(channelType);
    await adapter?.setTyping?.(platformId, threadId);
  },
};
setDeliveryAdapter(deliveryAdapter);
startActiveDeliveryPoll();
startSweepDeliveryPoll();
```

`setDeliveryAdapter` 不仅存住 adapter，还触发两类回调（`src/delivery.ts:85-105`）：

- 注入到 typing 模块（`setTypingAdapter`），让 typing refresh 能调 `setTyping`。
- 跑所有通过 `onDeliveryAdapterReady` 注册的回调（OneCLI approvals 就在这里挂自己的 long poll handler）。

把 adapter 注册和 poll 启动分开两步是关键：模块（如 approvals）在 import time 就会调 `onDeliveryAdapterReady(cb)`，但 adapter 还没设好。`setDeliveryAdapter` 一执行，所有挂在等待队列里的 callback 都会被一次性 fire（注释：`src/delivery.ts:85-93`）。

`stopDeliveryPolls()`（`src/delivery.ts:427-430`）只是把两个 boolean flag 置 false，**不立刻打断**正在 await 的 `drainSession`。当前正在跑的那条 timer chain 跑完最后一轮就退出，新的 `setTimeout` 因为 flag 是 false 不会再排队。

---

### 3. session 列表怎么来

`pollActive` 调 `getRunningSessions()`，`pollSweep` 调 `getActiveSessions()`：

```ts
// src/db/sessions.ts:66-72
export function getActiveSessions(): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE status = 'active'").all() as Session[];
}

export function getRunningSessions(): Session[] {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE container_status IN ('running', 'idle')")
    .all() as Session[];
}
```

为什么两个分别用？

- `status='active'`：session 行存在、用户没显式归档。这个集合可能很大（一年下来有 5000+ 历史 session）。
- `container_status IN ('running', 'idle')`：当前有 / 刚有容器进程的 session。这个集合通常 < 20。

active poll 走小集合，每秒扫 20 行 SQLite 几乎免费；sweep poll 每分钟扫 5000 行也还能接受。如果 active poll 用大集合，每秒 5000 次 sessionDir / openDb 会把 IO 撑爆。

`container_status` 由 `src/session-manager.ts` 里的 `markContainerRunning` / `markContainerStopped` 维护，container-runner spawn/exit 时同步更新（`src/container-runner.ts:160` + `:179`）。

---

### 4. drainSession：开 DB、过滤、迭代

`src/delivery.ts:164-232` 是 `drainSession`，逐行解释：

```ts
async function drainSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let outDb: Database.Database;
  let inDb: Database.Database;
  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return; // DBs might not exist yet
  }
```

`openOutboundDb` (`src/db/session-db.ts:29-33`) 以 **read-only** 模式打开：

```ts
export function openOutboundDb(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}
```

readonly 是 invariant 的物理强制 —— 哪怕 `drainSession` 写错代码想 INSERT，better-sqlite3 会直接抛错而不是真去抢容器的 write lock。

`openInboundDb` (`src/db/session-db.ts:21-26`) 是读写：

```ts
export function openInboundDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  return db;
}
```

`journal_mode = DELETE` 是关键 —— 不能用 WAL，因为 WAL 的 -shm 共享内存映射在容器和 host 跨挂载边界上不一致（参见第 1 章 §2.4）。容器读 inbound.db 时永远只看 DELETE 模式的 journal，看不到 WAL 帧。

接下来读所有候选行：

```ts
const allDue = getDueOutboundMessages(outDb);
if (allDue.length === 0) return;

const delivered = getDeliveredIds(inDb);
const undelivered = allDue.filter((m) => !delivered.has(m.id));
if (undelivered.length === 0) return;

migrateDeliveredTable(inDb);
```

`getDueOutboundMessages` (`src/db/session-db.ts:258-266`)：

```sql
SELECT * FROM messages_out
WHERE (deliver_after IS NULL OR deliver_after <= datetime('now'))
ORDER BY timestamp ASC
```

`deliver_after` 是容器自己加的延迟字段（用于"5 秒后再发"这种场景，由 `send_message` MCP 工具支持）。绝大多数行是 NULL —— 立刻可投。

`getDeliveredIds` (`src/db/session-db.ts:272-278`) 拉出 inbound.db 里 `delivered` 表的所有 `message_out_id`，用 `Set` 做 O(1) 查找。这就是去重 —— 容器写 outbound 之后从不删，host 投过的不再投。

`migrateDeliveredTable` (`src/db/session-db.ts:293-303`) 是 idempotent 的 schema 补丁，给旧 session DB 加上 `platform_message_id` 和 `status` 列。每次 drain 都跑 —— 它只是个 PRAGMA + 可选 ALTER TABLE，几微秒。

#### 4.1 迭代每条 undelivered

```ts
for (const msg of undelivered) {
  try {
    const platformMsgId = await deliverMessage(msg, session, inDb);
    markDelivered(inDb, msg.id, platformMsgId ?? null);
    deliveryAttempts.delete(msg.id);

    if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
      pauseTypingRefreshAfterDelivery(session.id);
    }
  } catch (err) {
    const attempts = (deliveryAttempts.get(msg.id) ?? 0) + 1;
    deliveryAttempts.set(msg.id, attempts);
    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      markDeliveryFailed(inDb, msg.id);
      deliveryAttempts.delete(msg.id);
    }
  }
}
```

两点细节：

1. `pauseTypingRefreshAfterDelivery` —— 真投到用户屏幕之后暂停 typing 指示器 10s，让用户的客户端有时间把"正在输入"动画清掉，否则下一次 typing tick 又把它点回来。system 消息和 agent-to-agent 消息不算用户可见 traffic，所以跳过 pause。
2. 重试计数器 `deliveryAttempts` 是个 in-memory `Map` —— 进程重启会重置。注释（`src/delivery.ts:34`）写：这是故意的，让 failed message 在重启后有第二次机会，因为 90% 的失败是"渠道 SDK 状态错乱"，重启 host 通常自带修复。

---

### 5. deliverMessage：kind 派发主逻辑

`src/delivery.ts:234-375` 是核心调度函数。流程图：

<svg viewBox="0 0 820 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="deliverMessage dispatch tree: short-circuit branches for system, agent-to-agent, and ask_question, then permission check, then adapter.deliver"><defs><marker id="ar9b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="410" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">deliverMessage 派发：三个短路分支 + 主路径</text><g><rect x="280" y="40" width="260" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="410" y="58" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">deliverMessage(msg, session, inDb)</text><text x="410" y="73" text-anchor="middle" font-size="10" fill="#64748b">content = JSON.parse(msg.content)</text></g><line x1="410" y1="80" x2="410" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9b)"/><g><path d="M 410 100 L 410 380" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="4,3" fill="none"/></g><g><line x1="410" y1="115" x2="200" y2="115" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9b)"/><rect x="30" y="100" width="170" height="40" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/><text x="115" y="118" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">kind === 'system'</text><text x="115" y="133" text-anchor="middle" font-size="10" fill="#64748b">→ handleSystemAction</text></g><g><line x1="410" y1="160" x2="620" y2="160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9b)"/><rect x="620" y="145" width="170" height="40" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/><text x="705" y="163" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">channel_type==='agent'</text><text x="705" y="178" text-anchor="middle" font-size="10" fill="#64748b">→ routeAgentMessage</text></g><g><line x1="410" y1="205" x2="200" y2="205" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar9b)"/><rect x="30" y="190" width="170" height="40" rx="5" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/><text x="115" y="208" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">permission check</text><text x="115" y="223" text-anchor="middle" font-size="10" fill="#64748b">throw on deny → retry</text></g><g><line x1="410" y1="250" x2="620" y2="250" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9b)"/><rect x="620" y="235" width="170" height="40" rx="5" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.2"/><text x="705" y="253" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">type='ask_question'</text><text x="705" y="268" text-anchor="middle" font-size="10" fill="#64748b">→ createPendingQuestion</text></g><g><line x1="410" y1="295" x2="200" y2="295" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9b)"/><rect x="30" y="280" width="170" height="40" rx="5" fill="#ffffff" stroke="#64748b" stroke-width="1"/><text x="115" y="298" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">readOutboxFiles</text><text x="115" y="313" text-anchor="middle" font-size="10" fill="#64748b">if content.files</text></g><g><rect x="290" y="335" width="240" height="48" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="410" y="354" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">deliveryAdapter.deliver(...)</text><text x="410" y="371" text-anchor="middle" font-size="10" fill="#64748b">→ platform_message_id</text></g><line x1="410" y1="383" x2="410" y2="403" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9b)"/><g><rect x="290" y="403" width="240" height="40" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/><text x="410" y="421" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">clearOutbox + markDelivered</text><text x="410" y="436" text-anchor="middle" font-size="10" fill="#64748b">写 inbound.delivered，去重锚</text></g></svg>
<span class="figure-caption">图 R9.2 ｜ deliverMessage 的派发树：紫=system 走注册表、橙=agent-to-agent 走目标 inbound、蓝=ask_question 落 pending_questions、红=权限拒绝走 retry，主路径汇到 adapter.deliver。</span>

<details>
<summary>ASCII 原版</summary>

```
deliverMessage(msg, session, inDb)
   │
   ├─ deliveryAdapter == null?           ──► warn, drop
   │
   ├─ content = JSON.parse(msg.content)
   │
   ├─ kind === 'system'?                 ──► handleSystemAction → registered handler
   │
   ├─ channel_type === 'agent'?          ──► routeAgentMessage (写目标 inbound.db)
   │
   ├─ permission check
   │  ├─ getMessagingGroupByPlatform()
   │  ├─ isOriginChat?                   ──► allow
   │  └─ agent_destinations 有匹配行?    ──► allow, else throw
   │
   ├─ content.type === 'ask_question'?
   │  └─ createPendingQuestion (写 v2.db 的 pending_questions)
   │
   ├─ readOutboxFiles (如果 content.files 非空)
   │
   ├─ deliveryAdapter.deliver(...)       ──► platform_message_id
   │
   ├─ clearOutbox (删 outbox/<msg-id>/ 目录)
   │
   └─ return platform_message_id
```

</details>

#### 5.1 System action 分支

```ts
// src/delivery.ts:254-258
if (msg.kind === 'system') {
  await handleSystemAction(content, session, inDb);
  return;
}
```

`kind='system'` 的 outbound 不是给用户看的 —— 它是 agent 用 MCP 工具触发的"请 host 帮我做事"的请求。比如 agent 调 `schedule_task` MCP 工具时，container 端的 `agent-runner` 不会直接写 inbound（它没权限），它写一行 outbound：

```json
{
  "kind": "system",
  "content": "{\"action\": \"schedule_task\", \"taskId\": \"t-...\", \"prompt\": \"...\", \"processAfter\": \"2026-05-25T09:00:00Z\"}"
}
```

`handleSystemAction` (`src/delivery.ts:410-425`) 拿 `content.action` 字段查注册表：

```ts
async function handleSystemAction(content, session, inDb): Promise<void> {
  const action = content.action as string;
  log.info('System action from agent', { sessionId: session.id, action });

  const registered = actionHandlers.get(action);
  if (registered) {
    await registered(content, session, inDb);
    return;
  }
  log.warn('Unknown system action', { action });
}
```

注册表 (`src/delivery.ts:396-403`)：

```ts
const actionHandlers = new Map<string, DeliveryActionHandler>();

export function registerDeliveryAction(action: string, handler: DeliveryActionHandler): void {
  if (actionHandlers.has(action)) {
    log.warn('Delivery action handler overwritten', { action });
  }
  actionHandlers.set(action, handler);
}
```

各 module 在 import 时注册：

| Action               | 注册点                                                  | 说明                           |
|----------------------|--------------------------------------------------------|--------------------------------|
| `schedule_task`      | `src/modules/scheduling/index.ts:30`                   | 写 messages_in (kind='task')    |
| `cancel_task`        | `src/modules/scheduling/index.ts:31`                   | UPDATE messages_in status       |
| `pause_task`         | `src/modules/scheduling/index.ts:32`                   | 同上                            |
| `resume_task`        | `src/modules/scheduling/index.ts:33`                   | 同上                            |
| `update_task`        | `src/modules/scheduling/index.ts:34`                   | 改 prompt / processAfter        |
| `install_packages`   | `src/modules/self-mod/index.ts:26`                     | 需要 approval                  |
| `add_mcp_server`     | `src/modules/self-mod/index.ts:27`                     | 需要 approval                  |
| `create_agent`       | `src/modules/agent-to-agent/index.ts:22`               | 创建新 agent group              |
| `cli_request`        | `src/cli/delivery-action.ts:17`                        | `ncl` CLI 调用 agent            |

注册时机：所有模块都在 `src/modules/index.ts` 的 import barrel 里被引入，import side effect 触发注册。`src/index.ts:55` 在 `main()` 之前 import 这个 barrel，因此 register 在 `main` 跑到 `startActiveDeliveryPoll()` 之前就完成了 —— delivery loop 第一次跑就能查到所有 handler。

#### 5.2 Agent-to-agent 分支

```ts
// src/delivery.ts:264-271
if (msg.channel_type === 'agent') {
  if (!hasTable(getDb(), 'agent_destinations')) {
    throw new Error(`agent-to-agent module not installed — cannot route message ${msg.id}`);
  }
  const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');
  await routeAgentMessage(msg, session);
  return;
}
```

`channel_type='agent'`、`platform_id=<target_agent_group_id>` 是 agent-to-agent 消息的 wire format。container 端的 `send_message` MCP 工具在 destination 是 agent 而不是 channel 时写这种行。

注意三点：
- 动态 import (`await import(...)`) 而不是顶部 import —— core 不依赖 agent-to-agent module，没装也能跑（这时上面 `hasTable` 检查会直接 throw，落入 retry 路径）。
- `routeAgentMessage` 不调任何 channel adapter —— 它直接写目标 session 的 inbound.db。
- 第 11 章详细讲 a2a 路由的 return-path 解析（in_reply_to → source_session_id → 目标 session）。

#### 5.3 渠道权限校验

`src/delivery.ts:289-311`：

```ts
if (msg.channel_type && msg.platform_id) {
  const mg = getMessagingGroupByPlatform(msg.channel_type, msg.platform_id);
  if (!mg) {
    throw new Error(`unknown messaging group for ${msg.channel_type}/${msg.platform_id} (message ${msg.id})`);
  }
  const isOriginChat = session.messaging_group_id === mg.id;
  if (!isOriginChat && hasTable(getDb(), 'agent_destinations')) {
    const row = getDb().prepare(
      'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
    ).get(session.agent_group_id, 'channel', mg.id);
    if (!row) {
      throw new Error(
        `unauthorized channel destination: ${session.agent_group_id} cannot send to ${mg.channel_type}/${mg.platform_id}`,
      );
    }
  }
}
```

两条放行规则：

1. **origin chat 永远可发**：session 是从某个 messaging_group 触发的 —— 给那个 group 回话是天然合法的，不需要 ACL 行。
2. **其它 chat 必须有 `agent_destinations` 行**：`createMessagingGroupAgent()` 在用户用 `/wire` 命令把新 chat 接到 agent 时会自动 insert 这个行。

校验失败用 `throw new Error` 而不是 silent `return`。注释（`src/delivery.ts:285-288`）：silent return 会让外层 catch 不到、然后被错误地 `markDelivered`（明明没发任何东西）。throw 走 retry 路径，3 次后 `markDeliveryFailed`。

#### 5.4 ask_question → pending_questions

```ts
// src/delivery.ts:317-340
if (content.type === 'ask_question' && content.questionId && hasTable(getDb(), 'pending_questions')) {
  const title = content.title as string | undefined;
  const rawOptions = content.options as unknown;
  if (!title || !Array.isArray(rawOptions)) {
    log.error('ask_question missing required title/options — not persisting', { ... });
  } else {
    const inserted = createPendingQuestion({
      question_id: content.questionId,
      session_id: session.id,
      message_out_id: msg.id,
      platform_id: msg.platform_id,
      channel_type: msg.channel_type,
      thread_id: msg.thread_id,
      title,
      options: normalizeOptions(rawOptions as never),
      created_at: new Date().toISOString(),
    });
    ...
  }
}
```

`ask_question` 是 interactive module 提供的"问用户一个选择题"原语。container 那边 agent 调 `ask_user_question` MCP 工具时写 `kind='chat-sdk'` + `content={"type":"ask_question",...}` 的 outbound。

host 在投递这条卡片**之前**先把 `pending_questions` 行写到中心 v2.db（注意：不是 session 的 inbound.db）。这一行用 `questionId` 索引，用户点按钮回来时（§9）通过这个行找到 session 和 message_out_id，把答案系统消息写回到 inbound.db。

`hasTable` 守卫：interactive module 没装时这张表不存在，host 跳过持久化 —— 卡片仍然会发到用户那边，但点击之后没人接，会落到 `Unclaimed response` 警告。

#### 5.5 渠道字段守卫

```ts
// src/delivery.ts:343-346
if (!msg.channel_type || !msg.platform_id) {
  log.warn('Message missing routing fields', { id: msg.id });
  return;
}
```

如果上面三个分支（system / agent / 渠道）都没匹配且行里又没渠道字段，只能 drop。

#### 5.6 读 outbox 文件

```ts
// src/delivery.ts:351-354
const files =
  Array.isArray(content.files) && content.files.length > 0
    ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
    : undefined;
```

`content.files` 是文件名数组（agent 用 `send_file` 工具写出来的）。实际字节存在 `<session_dir>/outbox/<msg_id>/<filename>`。`readOutboxFiles` (`src/session-manager.ts:444-496`) 把每个文件读进 `Buffer`，并做路径安全检查（拒绝 symlink、拒绝 `..` 逃逸）。

把 file I/O 放在 session-manager 里而不是 delivery，对称于 inbound 那边的 `extractAttachmentFiles` —— delivery 只负责把 buffer 数组喂给 adapter，不碰文件系统。

#### 5.7 实际投递

```ts
// src/delivery.ts:356-363
const platformMsgId = await deliveryAdapter.deliver(
  msg.channel_type,
  msg.platform_id,
  msg.thread_id,
  msg.kind,
  msg.content,
  files,
);
```

`deliveryAdapter` 是 `src/index.ts:145-165` 那个 thin wrapper，它根据 `channel_type` 查 channel registry 拿到具体 adapter 然后转交。这层间接性让 delivery.ts 不需要知道有哪些 channel 存在。

#### 5.8 清理 outbox

```ts
// src/delivery.ts:372
clearOutbox(session.agent_group_id, session.id, msg.id);
```

文件已经送到平台，本地副本删掉。`clearOutbox` (`src/session-manager.ts:504-`) 是 best-effort —— 失败只 log 不 throw，否则会触发 retry → 再次 deliver → 用户看到两条消息。

---

### 6. ChannelDeliveryAdapter 接口

`src/delivery.ts:52-62` 定义了 delivery loop 看到的 adapter 接口：

```ts
export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
  ): Promise<string | undefined>;
  setTyping?(channelType: string, platformId: string, threadId: string | null): Promise<void>;
}
```

注意这里第一个参数是 `channelType` —— 这是 thin wrapper 用来从 registry 找具体 adapter 的 key。具体的 `ChannelAdapter`（`src/channels/adapter.ts:111-167`）的 `deliver(platformId, threadId, OutboundMessage)` 不带 channelType。

具体 adapter 接口比 ChannelDeliveryAdapter 厚得多：

```ts
// src/channels/adapter.ts:111-167（精简）
export interface ChannelAdapter {
  name: string;
  channelType: string;
  supportsThreads: boolean;

  setup(config: ChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;

  deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined>;

  setTyping?(platformId: string, threadId: string | null): Promise<void>;
  syncConversations?(): Promise<ConversationInfo[]>;
  resolveChannelName?(platformId: string): Promise<string | null>;
  subscribe?(platformId: string, threadId: string): Promise<void>;
  openDM?(userHandle: string): Promise<string>;
}
```

CLI adapter 的 deliver 实现（`src/channels/cli.ts:119-135`）是最简单的参考样本：

```ts
async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
  if (platformId !== PLATFORM_ID) return undefined;
  if (!client) {
    // No live terminal — outbound row is already persisted, so this
    // isn't a data loss. User will see it on the next connect cycle.
    return undefined;
  }
  const text = extractText(message);
  if (text === null) return undefined;
  try {
    client.write(JSON.stringify({ text }) + '\n');
  } catch (err) {
    log.warn('Failed to write to CLI client', { err });
  }
  return undefined;
}
```

CLI 不返回 platform_message_id（一行 stdout 没有 id），所以 `delivered` 表的对应列写 NULL。Discord / Slack 等 adapter 会返回平台的 message id —— 后续 agent 想 edit 这条消息时通过 id 查回去。

`registerChannelAdapter` (`src/channels/cli.ts:276`) 在 import 时触发；`src/channels/index.ts:9` 的 `import './cli.js'` 把 CLI adapter 默认注册进 registry；其它 channel skill（discord / slack / telegram）通过 install skill 往 `channels/index.ts` 加新的 import 行。

`initChannelAdapters` (`src/channels/channel-registry.ts:53-94`) 在 `main()` 的第 3 步遍历 registry，调每个 adapter 的 `setup()`，并把成功的存到 `activeAdapters` —— delivery wrapper 后续靠 `getChannelAdapter(channelType)` 查这个表。

---

### 7. `delivered` 表的两个用途

```sql
-- src/db/schema.ts:186-193
CREATE TABLE IF NOT EXISTS delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',
  delivered_at        TEXT NOT NULL
);
```

四列两个用途：

1. **去重**：`drainSession` 用 PRIMARY KEY 的存在判断"这条已投过吗"。`getDeliveredIds` 拉出整个 column 做 Set。
2. **编辑 / reaction 回查**：`platform_message_id` 记录平台返回的 id。agent 后续要 edit 这条消息时，写一行 `kind='chat-sdk'` + `content={"operation":"edit","messageId":<这里填 message_out_id>,...}` 的 outbound；delivery → adapter → adapter 内部查 `delivered` 表把 message_out_id 翻译成 platform_message_id 再调 platform editMessage API。chat-sdk-bridge 里有这个翻译逻辑（`src/channels/chat-sdk-bridge.ts:374-` 的 `operation === 'edit'` 分支）。

`status` 有两个值：
- `'delivered'`：正常投递 OK。
- `'failed'`：3 次重试都失败，`markDeliveryFailed` (`src/db/session-db.ts:286-290`) 写这个 status 占位 —— 行还在，下次 drain 时 `getDeliveredIds` 仍然返回它，所以不会再重试。

`markDelivered` / `markDeliveryFailed` 都用 `INSERT OR IGNORE`。即便去重锁失效，多线程都跑到同一条，INSERT OR IGNORE 保证只有一行存在 —— 不会有"status='delivered' 和 status='failed' 各一行"的矛盾态。

---

### 8. 系统动作 handlers 详解

`handleSystemAction` 通过注册表派发，每个具体 handler 做的事不同。下面分四类讲。

#### 8.1 Schedule —— 写 messages_in 行

`src/modules/scheduling/actions.ts:19-40` 是 `handleScheduleTask`：

```ts
export async function handleScheduleTask(content, _session, inDb): Promise<void> {
  const taskId = content.taskId as string;
  const prompt = content.prompt as string;
  const script = content.script as string | null;
  const processAfter = content.processAfter as string;
  const recurrence = (content.recurrence as string) || null;

  insertTask(inDb, {
    id: taskId,
    processAfter,
    recurrence,
    platformId: (content.platformId as string) ?? null,
    channelType: (content.channelType as string) ?? null,
    threadId: (content.threadId as string) ?? null,
    content: JSON.stringify({ prompt, script }),
  });
  log.info('Scheduled task created', { taskId, processAfter, recurrence });
}
```

实质就是往 inbound.db 的 `messages_in` 写一行 `kind='task'`，带 `process_after = <future timestamp>`。这行不会立刻触发 wake —— `countDueMessages` 只数 `process_after <= now` 的行（`src/db/session-db.ts:136-147`）。

到了那个时间点，host-sweep 下一次扫描这个 session 时会发现 `dueCount > 0 && !isContainerRunning(session.id)`，调 `wakeContainer` 唤醒容器（详见第 10 章 §6）。

`cancel_task` / `pause_task` / `resume_task` / `update_task` 都是对同一行的不同 UPDATE，定义在 `src/modules/scheduling/db.ts`，逻辑直接：

```ts
// src/modules/scheduling/actions.ts:42-50
export async function handleCancelTask(content, _session, inDb): Promise<void> {
  const taskId = content.taskId as string;
  cancelTask(inDb, taskId);
  log.info('Task cancelled', { taskId });
}
```

`update_task` (`src/modules/scheduling/actions.ts:72-113`) 在 `touched === 0` 时还会写一条系统聊天回到 agent，告诉它 "no live task matched id" —— 这样 agent 不会以为更新成功了。

#### 8.2 Approval —— 通过 primitive 走

approval 的入口不是 delivery action，而是 module 内部 API。其它 module（self-mod 用得最多）在自己的 delivery action handler 里调 `requestApproval`：

```ts
// src/modules/approvals/primitive.ts:164-220 (简化)
export async function requestApproval(opts: RequestApprovalOptions): Promise<void> {
  const { session, action, payload, title, question, agentName } = opts;

  const approvers = pickApprover(session.agent_group_id);
  if (approvers.length === 0) {
    notifyAgent(session, `${action} failed: no owner or admin configured to approve.`);
    return;
  }

  const originChannelType = session.messaging_group_id
    ? (getMessagingGroup(session.messaging_group_id)?.channel_type ?? '')
    : '';

  const target = await pickApprovalDelivery(approvers, originChannelType);
  if (!target) {
    notifyAgent(session, `${action} failed: no DM channel found for any eligible approver.`);
    return;
  }

  const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedOptions = normalizeOptions(APPROVAL_OPTIONS);
  createPendingApproval({
    approval_id: approvalId, session_id: session.id, ...
    action, payload: JSON.stringify(payload), ...
  });

  const adapter = getDeliveryAdapter();
  if (adapter) {
    try {
      await adapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: approvalId,
          title,
          question,
          options: APPROVAL_OPTIONS,
        }),
      );
    } catch (err) {
      log.error('Failed to deliver approval card', { action, approvalId, err });
      notifyAgent(session, `${action} failed: could not deliver approval request to ${target.userId}.`);
      return;
    }
  }
  log.info('Approval requested', { action, approvalId, agentName, approver: target.userId });
}
```

三步：

1. **pickApprover** (`src/modules/approvals/primitive.ts:76-93`)：返回一个候选 user_id 列表，优先级 `agent group admin → global admin → owner`。
2. **pickApprovalDelivery** (`src/modules/approvals/primitive.ts:103-119`)：遍历候选，第一个能 reach 到的（有 DM messaging_group）就选 —— 并且优先用和 origin chat 同 channel_type 的（让 Discord 用户在 Discord 收到 approval，而不是切到 Slack）。
3. **createPendingApproval + adapter.deliver**：写中心 v2.db 的 `pending_approvals` 行，然后用 `getDeliveryAdapter()` 拿到 adapter 直接发卡片（不走 outbound.db —— 这是 host 主动行为，不是 agent 写出来的）。

注意 `requestApproval` 在 host 进程内同步调，**不经过** delivery loop —— 它复用同一个 `deliveryAdapter`，但绕过 polling 那一层。原因：approval 卡片是 host 主动行为（"agent 申请装个 npm 包，请管理员批准"），不是某个 session outbound 的副产品。

approval 反向（用户点击）走的是 response handler 路径，详见 §10。

#### 8.3 Question —— 走 delivery loop 的 ask_question 路径

普通的 `ask_user_question`（不是 approval）是 agent 主动发起的，所以走 delivery loop。container 端写 outbound：

```json
{
  "kind": "chat-sdk",
  "channel_type": "discord",
  "platform_id": "discord:...",
  "content": "{\"type\":\"ask_question\",\"questionId\":\"q-...\",\"title\":\"Pick one\",\"options\":[...]}"
}
```

delivery `deliverMessage` 走到 §5.4 的 `ask_question` 分支，写 `pending_questions` 行，然后照常调 `adapter.deliver` 把卡片送到用户。

为什么 approval 不走这条路？因为 approval 是 **host 替 agent 问别人**（不是问 agent 自己 wire 的 chat 的用户），目标 channel 通常和 agent 的 origin chat 完全不相关 —— 让 agent 自己写 outbound 然后由 delivery loop 投递的话，权限校验（§5.3）会拒绝它，因为 agent 没有 destination 行指向 admin 的 DM。primitive 那条路径在 host 进程内直接发，绕过 ACL。

#### 8.4 Agent-to-agent —— 不进 channel

`channel_type === 'agent'` 在 `deliverMessage` 第二个分支被截获（§5.2）。`routeAgentMessage` (`src/modules/agent-to-agent/agent-route.ts:162-207`) 关键代码：

```ts
export async function routeAgentMessage(msg, session): Promise<void> {
  const targetAgentGroupId = msg.platform_id;
  if (!targetAgentGroupId) {
    throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
  }
  if (
    targetAgentGroupId !== session.agent_group_id &&
    !hasDestination(session.agent_group_id, 'agent', targetAgentGroupId)
  ) {
    throw new Error(
      `unauthorized agent-to-agent: ${session.agent_group_id} has no destination for ${targetAgentGroupId}`,
    );
  }
  if (!getAgentGroup(targetAgentGroupId)) {
    throw new Error(`target agent group ${targetAgentGroupId} not found for message ${msg.id}`);
  }
  const targetSession = resolveTargetSession(msg, session, targetAgentGroupId);
  const a2aMsgId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const forwardedContent = forwardFileAttachments(msg, a2aMsgId, session, targetAgentGroupId, targetSession.id);

  writeSessionMessage(targetAgentGroupId, targetSession.id, {
    id: a2aMsgId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: forwardedContent,
    sourceSessionId: session.id,
  });
  ...
  const fresh = getSession(targetSession.id);
  if (fresh) await wakeContainer(fresh);
}
```

四步：

1. ACL：要么是自己发给自己（self-message，常用于"approval 通过后回个系统消息给原 session"），要么必须有 `agent_destinations` 行。
2. `resolveTargetSession`：根据 `in_reply_to` → 看 source agent inbound 里的 `source_session_id` → fallback 到"最近从这个 peer 来的 a2a 行的 source_session_id" → fallback 到"target agent 最新 active session"。这层是为了让 reply 落回原始对话 session，不串错。
3. 复制文件附件 —— 把 source outbox 里的字节 copy 到 target inbox 里，让目标 agent 也能读到。
4. `writeSessionMessage` 写目标 session 的 inbound.db。带 `channel_type='agent'`、`platform_id=源 agent_group_id` 让目标 agent 知道这是 a2a 消息（formatter 会展示成"FROM @SourceAgent"）。
5. `wakeContainer` 唤醒目标 session 的容器（如果还没醒）。

注意这条路径完全绕过 channel adapter —— a2a 消息**不进任何聊天平台**，纯进 SQLite。

第 11 章会详细讲 a2a 的 return-path 怎么算的。

---

### 9. Typing 指示器与 delivery 的耦合

```ts
// src/delivery.ts:202-204
if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
  pauseTypingRefreshAfterDelivery(session.id);
}
```

`pauseTypingRefreshAfterDelivery` (`src/modules/typing/index.ts:154-158`)：

```ts
export function pauseTypingRefreshAfterDelivery(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  entry.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
}
```

`POST_DELIVERY_PAUSE_MS = 10000`，按 Discord 最长 typing TTL 调的。背景：

- 用户发消息触发 typing —— router 在 inbound 处理时调 `startTypingRefresh`，typing 模块每 4s 重发一次 `setTyping`（`src/modules/typing/index.ts:24-30`）。
- agent 思考完毕，第一条回复落到用户屏幕。
- 客户端要显示"对方正在输入"动画的消失需要时间。如果下一个 4s tick 立刻又发 typing，动画从来不消失，用户感觉很奇怪。
- pause 10s 后再续 typing tick，给客户端足够时间清动画。

system / agent 消息不算用户可见 traffic，跳过 pause（用户看不到这些）。

`setTypingAdapter` 怎么和 delivery 串起来：`src/delivery.ts:95-105`：

```ts
export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  deliveryAdapter = adapter;
  setTypingAdapter(adapter);
  ...
}
```

`setDeliveryAdapter` 调一次就把 typing 模块也接进同一个 adapter —— 这是直接调用（不是注册表），因为 typing 是 default module 一定存在。

---

### 10. 响应处理（用户点击按钮）

用户在 Discord / Slack 上点 question 卡片的某个 option 按钮，这个事件**反向**回到 host。完整路径：

<svg viewBox="0 0 860 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Reverse response path from user button click through chat-sdk-bridge, dispatchResponse chain, to interactive or approvals handlers"><defs><marker id="ar9c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="430" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">用户点击按钮 → response 反向回流</text><g><rect x="280" y="40" width="300" height="44" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/><text x="430" y="60" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Discord / Slack 客户端点击</text><text x="430" y="76" text-anchor="middle" font-size="10" fill="#64748b">用户选某个 option 按钮</text></g><line x1="430" y1="84" x2="430" y2="106" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9c)"/><g><rect x="220" y="106" width="420" height="44" rx="6" fill="#ccfbf1" stroke="#0d9488" stroke-width="1.2"/><text x="430" y="125" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">chat-sdk-bridge.onAction</text><text x="430" y="142" text-anchor="middle" font-size="10" fill="#64748b">先 editMessage 回显"✅ Approved"，再调 host onAction</text></g><line x1="430" y1="150" x2="430" y2="172" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9c)"/><g><rect x="220" y="172" width="420" height="44" rx="6" fill="#ccfbf1" stroke="#0d9488" stroke-width="1.2"/><text x="430" y="190" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">dispatchResponse(ResponsePayload)</text><text x="430" y="207" text-anchor="middle" font-size="10" fill="#64748b">遍历 getResponseHandlers()，第一个 return true 的认领</text></g><line x1="320" y1="216" x2="200" y2="246" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9c)"/><line x1="540" y1="216" x2="660" y2="246" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9c)"/><text x="290" y="234" font-size="10" fill="#64748b">先 try (import order)</text><text x="540" y="234" font-size="10" fill="#64748b">未认领则 fall through</text><g><rect x="20" y="246" width="380" height="190" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/><text x="210" y="266" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">handleApprovalsResponse</text><text x="210" y="290" text-anchor="middle" font-size="11" fill="currentColor">1. resolveOneCLIApproval (in-mem Promise)</text><text x="210" y="310" text-anchor="middle" font-size="11" fill="currentColor">2. 查 pending_approvals 行</text><text x="210" y="334" text-anchor="middle" font-size="11" fill="currentColor">3a. approve → approvalHandlers 注册表</text><text x="210" y="354" text-anchor="middle" font-size="11" fill="currentColor">       → install_packages / add_mcp / ...</text><text x="210" y="378" text-anchor="middle" font-size="11" fill="#dc2626">3b. reject → notify agent</text><text x="210" y="400" text-anchor="middle" font-size="10" fill="#64748b">命中即 return true · 否则 false 让下家接</text><text x="210" y="420" text-anchor="middle" font-size="10" fill="#94a3b8">approval 卡片是 host 主动发，不走 delivery loop</text></g><g><rect x="460" y="246" width="380" height="190" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="650" y="266" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">handleInteractiveResponse</text><text x="650" y="290" text-anchor="middle" font-size="11" fill="currentColor">1. hasTable(pending_questions)?</text><text x="650" y="310" text-anchor="middle" font-size="11" fill="currentColor">2. getPendingQuestion(questionId)</text><text x="650" y="334" text-anchor="middle" font-size="11" fill="currentColor">3. writeSessionMessage</text><text x="650" y="354" text-anchor="middle" font-size="11" fill="currentColor">       kind='system' · question_response</text><text x="650" y="378" text-anchor="middle" font-size="11" fill="currentColor">4. wakeContainer(session)</text><text x="650" y="400" text-anchor="middle" font-size="10" fill="#64748b">写到 session 的 inbound.db</text><text x="650" y="420" text-anchor="middle" font-size="10" fill="#94a3b8">container 的 ask_user_question 工具 resolve Promise</text></g></svg>
<span class="figure-caption">图 R9.3 ｜ 反向 response 链：蓝=平台事件、青=入口处理、橙=approvals handler（含 OneCLI in-memory 短路）、紫=interactive handler 写回 inbound.db 唤醒容器。</span>

<details>
<summary>ASCII 原版</summary>

```
Discord client click
  ↓
Discord adapter（chat-sdk-bridge.ts）的 onAction 回调
  ↓
src/index.ts:126-140 → dispatchResponse(ResponsePayload)
  ↓
src/index.ts:37-47 → 遍历 getResponseHandlers()，第一个 return true 的"认领"
  ↓
两个候选 handler：
  ├─ src/modules/interactive/index.ts: handleInteractiveResponse
  │   ├─ 查 pending_questions
  │   └─ 写 messages_in (kind='system', content={"type":"question_response",...})
  │   └─ wakeContainer
  └─ src/modules/approvals/response-handler.ts: handleApprovalsResponse
      ├─ 先试 resolveOneCLIApproval (in-memory Promise)
      ├─ 否则查 pending_approvals
      ├─ approve → 查 approval handler 注册表 → 调
      └─ reject → notify agent
```

</details>

#### 10.1 dispatchResponse

`src/index.ts:37-47`：

```ts
async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}
```

`ResponsePayload` (`src/response-registry.ts:15-22`)：

```ts
export interface ResponsePayload {
  questionId: string;
  value: string;
  userId: string | null;
  channelType: string;
  platformId: string;
  threadId: string | null;
}
```

`getResponseHandlers()` 返回所有 module 通过 `registerResponseHandler` 注册的 handler。第一个返回 `true` 的 handler 认领这个 questionId（"认领"意味着这个 questionId 在我管的表里有匹配行，我已经处理完了）。

注册顺序由 import 顺序决定。`src/modules/index.ts` 控制 import 顺序：

```ts
// src/modules/index.ts (简化)
import './typing/index.js';
import './approvals/index.js';
import './interactive/index.js';
...
```

approvals 在 interactive 前面，所以 approvals 先 try。一个 questionId 不会同时在 pending_approvals 和 pending_questions 里（两边都用全局唯一的 questionId 前缀），所以谁先谁后实际上不影响。

#### 10.2 Interactive response handler

`src/modules/interactive/index.ts:20-57` 的 `handleInteractiveResponse`：

```ts
async function handleInteractiveResponse(payload: ResponsePayload): Promise<boolean> {
  if (!hasTable(getDb(), 'pending_questions')) return false;

  const pq = getPendingQuestion(payload.questionId);
  if (!pq) return false;

  const session = getSession(pq.session_id);
  if (!session) {
    log.warn('Session not found for pending question', { ... });
    deletePendingQuestion(payload.questionId);
    return true;
  }

  writeSessionMessage(session.agent_group_id, session.id, {
    id: `qr-${payload.questionId}-${Date.now()}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: pq.platform_id,
    channelType: pq.channel_type,
    threadId: pq.thread_id,
    content: JSON.stringify({
      type: 'question_response',
      questionId: payload.questionId,
      selectedOption: payload.value,
      userId: payload.userId ?? '',
    }),
  });

  deletePendingQuestion(payload.questionId);
  log.info('Question response routed', { ... });

  await wakeContainer(session);
  return true;
}
```

写到 inbound.db 的是 `kind='system'` 行 —— container 端的 `ask_user_question` MCP 工具看到这种行就 resolve 它的 promise 把答案返给 agent 代码。

注意三点：
- `pending_questions` 表不存在直接返 false —— interactive module 没装。下一个 handler 接力。
- `session_id` 找不到对应 session（session 被删了）—— 仍然认领 (`return true`) 并删除 pending row。否则这个 questionId 会被反复尝试。
- 写完立刻 `wakeContainer` —— container 可能 idle，要叫醒它读这条响应。

#### 10.3 Approval response handler

`src/modules/approvals/response-handler.ts:24-43`：

```ts
export async function handleApprovalsResponse(payload: ResponsePayload): Promise<boolean> {
  // OneCLI credential approvals — resolved via in-memory Promise first.
  if (resolveOneCLIApproval(payload.questionId, payload.value)) {
    return true;
  }

  const approval = getPendingApproval(payload.questionId);
  if (!approval) return false;

  if (approval.action === ONECLI_ACTION) {
    deletePendingApproval(payload.questionId);
    return true;
  }

  await handleRegisteredApproval(approval, payload.value, payload.userId ?? '');
  return true;
}
```

两类：

1. **OneCLI 凭证**：`resolveOneCLIApproval` (`src/modules/approvals/onecli-approvals.ts:68-83`) 查内存里的 `pending` Map，找到了就 resolve 那个 Promise，OneCLI gateway 的 long poll 回调就返回 `'approve'` / `'deny'`，gateway 放行 HTTP 请求。
2. **Module-initiated 行动**：`handleRegisteredApproval` (`src/modules/approvals/response-handler.ts:45-106`)：
   - 拒绝：`notify` agent "your request was rejected"。
   - 同意：从 `approvalHandlers` map 查这个 action 的注册 handler，调它。handler 是各 module 自己的（self-mod 装包、agent-to-agent 创建新 agent group 等）。handler 可以做实际的副作用（exec shell、改 DB、apply 设置），用 `notify` 回 agent 报告结果。

`approvalHandlers` 注册表 (`src/modules/approvals/primitive.ts:57-65`)：

```ts
const approvalHandlers = new Map<string, ApprovalHandler>();

export function registerApprovalHandler(action: string, handler: ApprovalHandler): void {
  if (approvalHandlers.has(action)) {
    log.warn('Approval handler re-registered (overwriting)', { action });
  }
  approvalHandlers.set(action, handler);
}
```

例如 self-mod 在 `src/modules/self-mod/index.ts` 注册 `registerApprovalHandler('install_packages', ...)` —— 当 admin 批准了 `install_packages` 类型的 pending_approval 时，这个 handler 被 fire，去真正执行 `apt install` / `npm install` 在 container 里。

#### 10.4 chat-sdk-bridge 的 onAction

实际的 callback 链路从 chat-sdk-bridge 进 host：`src/channels/chat-sdk-bridge.ts:269-297`：

```ts
chat.onAction(async (event) => {
  ...
  await adapter.editMessage(tid, event.messageId, { ... });
  ...
  setupConfig.onAction(questionId, selectedOption, userId);
});
```

bridge 拿到 platform 的 action 事件后：
1. **先 edit 卡片**：把按钮换成"✅ Approved"等状态文字，让用户立刻看到点击结果。
2. **再调 host 的 onAction**：即 `src/index.ts:126-140` 那个 callback，它构造 `ResponsePayload` 调 `dispatchResponse`。

注意 chat-sdk-bridge 已经自己处理了卡片回显（"Approved" 文本），所以 onecli-approvals 不需要再 deliver 一次 edit (`src/modules/approvals/onecli-approvals.ts:75-77` 注释明确说"Card is auto-edited by chat-sdk-bridge's onAction handler"）。

---

### 11. Edit 与 reaction

agent 写一行 outbound：

```json
{
  "kind": "chat-sdk",
  "channel_type": "discord",
  "content": "{\"operation\":\"edit\",\"messageId\":\"<原 message_out_id>\",\"text\":\"updated\"}"
}
```

delivery 走完普通路径，调 `adapter.deliver(...)`。chat-sdk-bridge 看到 `content.operation === 'edit'`（`src/channels/chat-sdk-bridge.ts:374-`）：

```ts
if (content.operation === 'edit' && content.messageId) {
  await adapter.editMessage(tid, content.messageId as string, { ... });
  return ...;
}
```

`content.messageId` 在这里实际上是 host 这边的 message_out_id（agent 写出来时只知道这个 id，不知道平台 id）。bridge / adapter 内部需要把它翻译成 platform_message_id —— 通过 inbound.db 的 `delivered` 表查（虽然这一段的 SQL 翻译细节在 chat-sdk-bridge 里直接用 `messageId` 做参数，因为 chat sdk 已经接受 channel-internal id）。

Reaction 走同样的 mechanism —— `content.operation === 'react'` 或专门的 `kind='reaction'` 行（具体看具体 adapter 支持）。

---

### 12. 失败处理与退避

#### 12.1 deliveryAttempts

`src/delivery.ts:34-35`：

```ts
const deliveryAttempts = new Map<string, number>();
```

per-message-id 的 in-memory 计数器。`src/delivery.ts:205-226`：

```ts
} catch (err) {
  const attempts = (deliveryAttempts.get(msg.id) ?? 0) + 1;
  deliveryAttempts.set(msg.id, attempts);
  if (attempts >= MAX_DELIVERY_ATTEMPTS) {
    log.error('Message delivery failed permanently, giving up', { ... });
    markDeliveryFailed(inDb, msg.id);
    deliveryAttempts.delete(msg.id);
  } else {
    log.warn('Message delivery failed, will retry', { ... });
  }
}
```

`MAX_DELIVERY_ATTEMPTS = 3` (`src/delivery.ts:32`)。第 3 次失败：

- 写 `delivered` 表行 status='failed'。
- 后续 drain 看到这个 id 在 delivered 集合里，跳过。
- 进程重启会清空 `deliveryAttempts` —— 但 `delivered` 表里那个 status='failed' 行还在，重启后**也不会**重试。

如果想让 failed 消息复活，需要 admin 手动 DELETE inbound.db 里的对应 delivered 行。这是有意保守的设计：自动复活意味着同一条消息可能在 host 重启后突然投递（用户已经不知道上下文了），对用户体验更糟。

#### 12.2 没有退避间隔

注意代码里没有"等 X 秒再重试"的逻辑。两次重试的间隔就是两次 poll tick 的间隔（1s active 或 60s sweep）。

为什么不加 backoff？因为：
- 失败种类有限：渠道临时挂、网络抖。绝大多数 1s 后就好了。
- backoff 需要在 inbound.db 加一个 `retry_after` 字段，额外 schema 复杂度。
- 加 backoff 又得算何时清零 —— 一条新消息和一条重试消息一起 due 怎么排队？复杂度爆炸。

接受了"小概率连发 3 次失败 message"这个权衡：3 次连发都失败，渠道大概率是死了 10 秒以上，下一条消息也会失败 —— 用户那边什么都看不到，不会有"快速重复打扰"的问题。

#### 12.3 Adapter 不可用

如果整个 channel adapter 下线（Discord SDK 重连中），`deliveryAdapter` 的 wrapper (`src/index.ts:154-158`) 会 log warn 返回 undefined：

```ts
const adapter = getChannelAdapter(channelType);
if (!adapter) {
  log.warn('No adapter for channel type', { channelType });
  return;
}
```

注意这里返回 undefined 而不是 throw —— delivery 层会把它当成"投递成功，platform_message_id 是 undefined"，写一行 delivered（status='delivered'），消息**不会重试**。这是一个有意识的权衡：adapter 缺失通常意味着 channel 永久不可用（用户删了 Discord 集成），重试也没用。如果是临时下线，应该由 adapter 自己内部用队列 hold 住。

CLI adapter 走的就是这条路：用户终端没连接时，`deliver` 直接 `if (!client) return undefined`（`src/channels/cli.ts:121-126`），消息标 delivered，下次用户连进来就**看不到**之前那些消息了。这是 CLI 的限制 —— 没有 scroll-back。其它 adapter（Discord）不会这样，平台自己有 message log。

#### 12.4 与 circuit-breaker 的关系

`src/circuit-breaker.ts` 是 **process 启动级**的退避机制 —— host 进程连续 crash 5 次会在第 6 次启动时 sleep 300s，第 7 次 sleep 900s。这和单条消息的 delivery retry 完全分离 —— circuit-breaker 是为了保护"host 不停 crash 不停拉起"这种循环把数据库写花，**不**用来管单条消息失败。

---

### 13. 完整 trace：CLI channel 的简单回复

用 CLI channel 走一条端到端 reply 作为本章锚点。假设：

- agent group `andy` 用 CLI channel，PLATFORM_ID = `local`。
- session `sess-xxx` 已经存在，container 正在 idle。
- 用户在终端打字："Hi"。

<svg viewBox="0 0 880 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Sequence diagram of full CLI delivery trace: user types Hi, router writes inbound, container generates Hello, pollActive picks it up, CLI adapter writes to socket"><defs><marker id="ar9e" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="440" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">CLI 端到端 trace：用户键入 "Hi" → 用户看到 "Hello!"</text><g><rect x="20" y="44" width="130" height="28" rx="5" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.2"/><text x="85" y="62" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">用户终端</text></g><g><rect x="180" y="44" width="130" height="28" rx="5" fill="#ccfbf1" stroke="#0d9488" stroke-width="1.2"/><text x="245" y="62" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">host router</text></g><g><rect x="340" y="44" width="130" height="28" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/><text x="405" y="62" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">container agent</text></g><g><rect x="500" y="44" width="130" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/><text x="565" y="62" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">outbound.db</text></g><g><rect x="660" y="44" width="130" height="28" rx="5" fill="#ccfbf1" stroke="#0d9488" stroke-width="1.2"/><text x="725" y="62" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">delivery loop</text></g><line x1="85" y1="72" x2="85" y2="370" stroke="#cbd5e1" stroke-dasharray="4,3"/><line x1="245" y1="72" x2="245" y2="370" stroke="#cbd5e1" stroke-dasharray="4,3"/><line x1="405" y1="72" x2="405" y2="370" stroke="#cbd5e1" stroke-dasharray="4,3"/><line x1="565" y1="72" x2="565" y2="370" stroke="#cbd5e1" stroke-dasharray="4,3"/><line x1="725" y1="72" x2="725" y2="370" stroke="#cbd5e1" stroke-dasharray="4,3"/><g><line x1="85" y1="92" x2="245" y2="92" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9e)"/><text x="165" y="86" text-anchor="middle" font-size="10" fill="#64748b">{"text":"Hi"} via cli.sock</text></g><g><line x1="245" y1="118" x2="405" y2="118" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9e)"/><text x="325" y="112" text-anchor="middle" font-size="10" fill="#64748b">写 inbound.db + wakeContainer</text></g><g><rect x="370" y="135" width="70" height="65" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/><text x="405" y="155" text-anchor="middle" font-size="10" fill="currentColor">SDK</text><text x="405" y="170" text-anchor="middle" font-size="10" fill="currentColor">query</text><text x="405" y="187" text-anchor="middle" font-size="10" fill="currentColor">"Hello!"</text></g><g><line x1="405" y1="215" x2="565" y2="215" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9e)"/><text x="485" y="209" text-anchor="middle" font-size="10" fill="#64748b">INSERT msg-out-yyy (kind=chat)</text></g><g><line x1="725" y1="242" x2="565" y2="242" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar9e)"/><text x="645" y="236" text-anchor="middle" font-size="10" fill="#64748b">pollActive (≤1s 后): SELECT due</text></g><g><line x1="725" y1="268" x2="725" y2="285" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9e)"/><text x="800" y="278" text-anchor="end" font-size="10" fill="#64748b">drainSession · deliverMessage</text></g><g><rect x="690" y="285" width="70" height="40" rx="3" fill="#ccfbf1" stroke="#0d9488" stroke-width="1"/><text x="725" y="302" text-anchor="middle" font-size="10" fill="currentColor">权限+kind</text><text x="725" y="316" text-anchor="middle" font-size="10" fill="currentColor">派发</text></g><g><line x1="725" y1="340" x2="85" y2="340" stroke="#0d9488" stroke-width="1.5" marker-end="url(#ar9e)"/><text x="405" y="334" text-anchor="middle" font-size="10" font-weight="600" fill="#0d9488">CLI adapter: client.write('{"text":"Hello!"}\n')</text></g><g><line x1="245" y1="362" x2="565" y2="362" stroke="#16a34a" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar9e)"/><text x="405" y="356" text-anchor="middle" font-size="10" fill="#16a34a">markDelivered → inbound.delivered (去重锚)</text></g></svg>
<span class="figure-caption">图 R9.4 ｜ CLI 端到端 trace 时序图：纵线是 5 个参与者，箭头按时间从上到下；橙=容器侧动作、青=host 侧、绿虚线=最后的去重持久化。</span>

#### Step 1：inbound

`scripts/chat.ts` 客户端连到 `data/cli.sock`，写：

```json
{"text": "Hi"}
```

CLI adapter `handleConnection` → `handleLine` (`src/channels/cli.ts:181-244`) 解析，没 `to` 字段，走 plain chat 路径，claim chat slot，调 `config.onInbound(PLATFORM_ID, null, { id, kind:'chat', content:{text:'Hi',...} })`。

`src/index.ts:92-107` 的 `onInbound` callback → `routeInbound(...)`（第 8 章）。router 找到 session、写 messages_in、wake container。

#### Step 2：container 处理

container 端 agent-runner 被 wake，读 messages_in、调 Claude SDK、agent 决定回 "Hello!"。SDK 的 message 走 send_message MCP 工具，写一行 messages_out：

```sql
INSERT INTO messages_out (id, seq, kind, platform_id, channel_type, thread_id, content)
VALUES ('msg-out-yyy', 4, 'chat', 'local', 'cli', NULL, '{"text":"Hello!"}');
```

同时容器写 processing_ack：`{message_id:'<inbound msg id>', status:'completed'}`。

#### Step 3：host pollActive tick

1s 内的下一个 pollActive tick：

1. `getRunningSessions()` 返回 [sess-xxx]（container_status='running'）。
2. `deliverSessionMessages(sess-xxx)` → 没在 inflight 集合 → 进 drainSession。
3. `openOutboundDb` + `openInboundDb`。
4. `getDueOutboundMessages` 返回 [msg-out-yyy]（还有更早的旧行但都在 delivered 集合里）。
5. `getDeliveredIds` 返回 `Set(...)` 包含所有过去的 id 但不含 msg-out-yyy。
6. `migrateDeliveredTable` no-op。
7. 迭代 [msg-out-yyy]，进 `deliverMessage`。

#### Step 4：deliverMessage 分支

- `deliveryAdapter` 非空，继续。
- `content = JSON.parse('{"text":"Hello!"}')` = `{text:'Hello!'}`。
- `kind === 'system'`? no（'chat'）。
- `channel_type === 'agent'`? no（'cli'）。
- 权限校验：`getMessagingGroupByPlatform('cli', 'local')` → mg 对象 → `session.messaging_group_id === mg.id`? yes（origin chat）→ pass。
- `content.type === 'ask_question'`? no。
- `content.files`? 没有 → `files = undefined`。
- 调 `deliveryAdapter.deliver('cli', 'local', null, 'chat', '{"text":"Hello!"}', undefined)`。

#### Step 5：CLI adapter deliver

`src/index.ts:154` 的 wrapper：

```ts
const adapter = getChannelAdapter('cli');  // 拿到 CLI adapter
return adapter.deliver('local', null, { kind:'chat', content:{text:'Hello!'}, files:undefined });
```

CLI adapter `deliver` (`src/channels/cli.ts:119-135`)：

- `platformId === 'local'` ✓。
- `client` 是当前连接的 socket，不是 null。
- `extractText` 从 content 里抽 'Hello!'。
- `client.write('{"text":"Hello!"}\n')`。
- 返回 undefined（CLI 不返回 platform_message_id）。

#### Step 6：用户终端

`scripts/chat.ts` 客户端 readline 读到 `{"text":"Hello!"}`，打印到 stdout：

```
Agent: Hello!
```

#### Step 7：delivery 后续

回到 `deliverMessage`：

- `platformMsgId = undefined`。
- `clearOutbox(...)` —— msg-out-yyy 没有 files 目录，no-op。
- return undefined。

回到 `drainSession` 循环体：

- `markDelivered(inDb, 'msg-out-yyy', null)` —— INSERT INTO delivered。
- `deliveryAttempts.delete('msg-out-yyy')` —— 计数器清零（虽然这次没失败也无所谓）。
- `pauseTypingRefreshAfterDelivery(sess-xxx)` —— typing 暂停 10s。
- continue 到下一条 undelivered（没了）。

`finally` 块：`outDb.close()` + `inDb.close()` + `inflightDeliveries.delete(sess-xxx)`。

#### Step 8：下一个 tick

1s 后 `pollActive` 再来：

- 同样进 drainSession。
- `getDueOutboundMessages` 仍然返回 [msg-out-yyy]（容器不会删 outbound 行）。
- `getDeliveredIds` 现在包含 msg-out-yyy。
- `undelivered = []` → return。

每秒做一次"开 DB → 比对 → 关 DB"，开销 < 1ms。

---

### 14. 边界与陷阱

#### 14.1 inflightDeliveries 不是持久锁

`inflightDeliveries` 是 in-process Set。如果 host 进程崩溃，重启后这个 set 是空的 —— 但 `delivered` 表还在 DB 里，第一次 drain 会拉所有未投行做 diff，重复投递不会发生（因为 INSERT OR IGNORE）。

如果两个 host 进程同时跑同一份 data 目录（不该这么干，但有人会试），inflightDeliveries 是 per-process 的，两个进程并发 drain 会都看到 undelivered 集合、都 deliver、都 INSERT OR IGNORE 写 delivered —— 用户看到两条消息。结论：**不要并发跑两个 host 进程**。container-runtime 启动检查（第 4 章）会防 host 双实例。

#### 14.2 deliveryAttempts 内存泄漏

`deliveryAttempts` 在 success 时 delete，在 max attempts 时 delete。但如果 outbound 行被外部手动删了 / DB 被 reset 了，对应 id 的计数永远留在 Map 里。这是 acceptable，因为：

- 每条 message 最多占 8 字节 + map overhead ~32 字节。
- 一个 session 一天 N 条消息，外部删 DB 通常一年一次。
- 进程重启清零。

#### 14.3 ask_question 在不装 interactive module 时

`pending_questions` 表只在 interactive module installed 时存在。如果没装，§5.4 的 `hasTable` 守卫返回 false，跳过 createPendingQuestion。

卡片仍然 deliver 出去（用户能看到按钮），但用户点了按钮：

- response 到达 dispatchResponse。
- interactive handler `hasTable` 返回 false，return false（不认领）。
- approvals handler 查 pending_approvals 也没有，return false。
- 落到 `log.warn('Unclaimed response', ...)`。

这不是 bug 是设计 —— 没装 module 不该用这个能力，但万一 agent 写了这种 outbound（错误的配置），host 不应该 crash，只应该 log warn。

#### 14.4 origin chat 判定的细节

§5.3 的 `isOriginChat = session.messaging_group_id === mg.id` 在 agent-shared session 模式下需要小心 —— 这种 session `messaging_group_id` 是 NULL，所以 `isOriginChat` 永远 false，必须有 `agent_destinations` 行才能发。这是对的：agent-shared 没有 origin chat 概念。

#### 14.5 system action 注册表的覆盖警告

```ts
// src/delivery.ts:399-401
if (actionHandlers.has(action)) {
  log.warn('Delivery action handler overwritten', { action });
}
actionHandlers.set(action, handler);
```

只 warn 不抛。后注册的胜出。这在两个 module 都想注册同一个 action 时是潜在 bug —— 但实际上每个 action 都属于明确的一个 module，不会冲突。如果将来有第三方 module 想 register 已存在的 action，会得到一个 warning（在 install 时通过 lint script 可以检查）。

#### 14.6 OneCLI long poll 与 sweep 兜底

OneCLI approval 是 host-pulled 的 —— `onecli.configureManualApproval` (`src/modules/approvals/onecli-approvals.ts:92-100`) 是 long poll，OneCLI server 主动 push 给 host。但 long poll 有可能断线、有可能 host 起得比 OneCLI 晚。

兜底是启动时的 `sweepStaleApprovals` (`src/modules/approvals/onecli-approvals.ts:247-255`)：

```ts
async function sweepStaleApprovals(): Promise<void> {
  const rows = getPendingApprovalsByAction(ONECLI_ACTION);
  if (rows.length === 0) return;
  log.info('Sweeping stale OneCLI approvals from previous process', { count: rows.length });
  for (const row of rows) {
    await editCardExpired(row, 'host restarted');
    deletePendingApproval(row.approval_id);
  }
}
```

启动时把上一个进程留下的 OneCLI pending 全部"过期"掉（edit 卡片成 "Expired (host restarted)"），让那些 long poll 都自然超时。OneCLI server 端那条请求也已经按自己的 TTL 超时了，HTTP 连接早断了 —— 这次清理只是把 DB 和卡片 UI 拉回一致状态。

注意这是 **startup sweep**，不是 60s host-sweep 做的事 —— host-sweep 的职责详见第 10 章。

---

### 15. 总结

`src/delivery.ts` 是 host 端最热的循环之一（每秒一次），但代码结构非常窄：

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Five-layer call hierarchy of delivery.ts from timer chains down to action registry"><defs><marker id="ar9d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">delivery.ts 五层调用链（每层职责单一）</text><g><rect x="60" y="44" width="640" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="80" y="68" font-size="12" font-weight="700" fill="currentColor">L1</text><text x="380" y="68" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">pollActive / pollSweep</text><text x="680" y="68" text-anchor="end" font-size="10" fill="#64748b">setTimeout 链</text></g><line x1="380" y1="84" x2="380" y2="98" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9d)"/><g><rect x="80" y="98" width="600" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="100" y="122" font-size="12" font-weight="700" fill="currentColor">L2</text><text x="380" y="122" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">deliverSessionMessages</text><text x="660" y="122" text-anchor="end" font-size="10" fill="#64748b">inflight Set 去重</text></g><line x1="380" y1="138" x2="380" y2="152" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9d)"/><g><rect x="100" y="152" width="560" height="40" rx="6" fill="#ccfbf1" stroke="#0d9488" stroke-width="1"/><text x="120" y="176" font-size="12" font-weight="700" fill="currentColor">L3</text><text x="380" y="176" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">drainSession</text><text x="640" y="176" text-anchor="end" font-size="10" fill="#64748b">open DBs · diff · iterate</text></g><line x1="380" y1="192" x2="380" y2="206" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9d)"/><g><rect x="120" y="206" width="520" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/><text x="140" y="230" font-size="12" font-weight="700" fill="currentColor">L4</text><text x="380" y="230" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">deliverMessage</text><text x="620" y="230" text-anchor="end" font-size="10" fill="#64748b">kind 派发 · 权限 · adapter</text></g><line x1="380" y1="246" x2="380" y2="260" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9d)"/><g><rect x="140" y="260" width="480" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/><text x="160" y="282" font-size="12" font-weight="700" fill="currentColor">L5</text><text x="380" y="282" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">handleSystemAction → actionHandlers 注册表</text></g></svg>
<span class="figure-caption">图 R9.5 ｜ delivery.ts 的五层调用骨架：每层只多一个职责（timer → 锁 → DB → kind → action），从上到下宽度收敛体现每层过滤掉的消息比例。</span>

<details>
<summary>ASCII 原版</summary>

```
pollActive / pollSweep
  → deliverSessionMessages (per-session lock)
    → drainSession (open DBs, diff against delivered, iterate)
      → deliverMessage (kind 派发 + 权限 + adapter)
        → handleSystemAction (action 派发到 module 注册表)
```

</details>

设计的几个不变量：

1. **永远不写 outbound.db**（readonly open 强制）。
2. **delivered 表是唯一的去重源**（in-memory inflight 锁只是性能优化）。
3. **System action 通过注册表派发**（core 不知道有哪些 module）。
4. **失败 3 次永久失败**（不存复活路径，避免重启时打扰用户）。
5. **a2a 不走 channel**（直接写目标 inbound.db + wakeContainer）。
6. **approval 不走 delivery loop**（host 主动行为，直接调 adapter）。
7. **response handler 是 chain**（第一个 return true 的认领，落空 log warn）。

延伸阅读：

- 第 6 章：两库分写的不变量与跨挂载约束。
- 第 7 章：消息流总览，从 inbound 到 outbound 全链路。
- 第 10 章：60s host-sweep 怎么补 delivery 不能管的事（stuck container 检测、due-message wake、recurrence 调度）。
- 第 11 章：agent-to-agent 路由的 return-path 解析细节。
- 第 13 章：approval primitive 的完整生命周期（含 OneCLI 凭证 long poll）。
