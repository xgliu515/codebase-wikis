## 1. 当前情境

上一步走完，container 进程已经把这一轮回复落盘了。具体的现场是：

- `data/groups/<agent_group_id>/sessions/<session_id>/outbound.db` 里多了一行 `messages_out`：
  - `seq = N`（奇数 —— 第 3 章 §3.6 的奇偶约定，container 写奇数）
  - `kind = 'chat'`
  - `channel_type = 'cli'`，`platform_id = 'local'`，`thread_id = NULL`
  - `content = '{"text":"pong"}'`（JSON string，serialized 一次）
  - `timestamp = 2026-05-24T...`，`deliver_after = NULL`
- 同一个 session 的 `inbound.db.delivered` 表里**没有**对应行 —— 这是第 9 章 §"`delivered` 表"会反复强调的：`outbound.db` 自己不知道哪些行已经投递；投递状态写在 host 侧的 `inbound.db.delivered` 里，靠 `message_out_id` 关联。
- container 主循环（`container/agent-runner/src/poll-loop.ts`）已经把 `processing_ack` 解占用，回到下一个轮询周期，对这一行后续是否被投递既不感兴趣也不知情。
- host 端 `src/index.ts` 在启动末尾调用了 `startActiveDeliveryPoll()`（`src/delivery.ts:108`），从那一刻起 `pollActive` 函数就以 1 秒为间隔在 event loop 上自循环。这个定时器跟 step 09 启动的 container poll-loop **不在同一个进程**，也没有任何 IPC 协同。

读到这里你应该有一个心智图：outbound.db 像一个"已写入但还没人取走"的邮箱，container 是写信人，host 的 delivery 是邮差，邮差按固定节奏沿街扫所有邮箱。这一步就是邮差扫到我们这只邮箱、看到信、拿出信的那一下。

## 2. 这一步要解决什么

这一步在做一件听起来简单、实际上有四个独立约束的事：**host 进程要发现"某个 session 的 outbound.db 多了一行未投递消息"**。约束如下：

1. **没有事件源**。container 不会通知 host"我写好了"。host 必须自己去看。
2. **多 session 并发**。一个 NanoClaw daemon 同时可能挂着十几个 active session（不同 agent group、不同 messaging group）。delivery 不知道哪一个 session 这一秒有新消息。
3. **幂等**。host 自己可能因为 sweep poll（60s 一次，覆盖 all active sessions）跟 active poll（1s 一次，仅 running sessions）撞到同一行；同一个 session 的两次相邻 tick 也可能撞 —— 不能投递两遍。
4. **不能写 outbound.db**。第 3 章 §"单写者不变量"是整个三 DB 模型的脊柱：`outbound.db` 的唯一写者是 container。host 在 outbound.db 上**只能开只读连接**，所以"标记已投递"这件事必须发生在别的文件里。

这四条约束加起来，决定了 delivery 必须是：**周期性 + 多 session 遍历 + 双 DB 对账 + 单 session 串行**。再具体一点：每秒去 v2.db 拉一遍 running sessions 列表，对每个 session 开两个连接（outbound 只读、inbound 读写），SELECT outbound，左反连接 inbound.delivered，剩下的就是这一秒要投递的。

## 3. 朴素思路：container 写完直接通知 host

如果你完全没看过这个仓库，最自然的设计是 push：container 写完 outbound.db 那一刻，主动给 host 发个信号 —— 写一个 Unix socket、或者 SIGUSR1、或者一个共享的 `wake.sock`，host 端收到后立刻 query outbound.db 的新行。1 秒延迟没了，CPU 也省了，听起来全是好处。

更激进一点，你甚至可以让 container 直接把那条 outbound 消息**塞在通知 payload 里**——host 收到就能 dispatch，根本不用再读 outbound.db。本质上是把"消息队列"从 SQLite 升级成事件 bus，从 pull 改成 push。

这条思路有一个看似无懈可击的优势：**零 polling 浪费**。在 nanoclaw 的现实场景里 99% 的 tick 都没有新消息（agent 在沉思、在跑工具、或者根本就 idle），1 秒一次的 poll 听起来是在烧电。

## 4. 朴素思路在哪一档崩

push-based 的所有失效模式都集中在 **host 或 container 的生命周期不连续**这一点上。把场景列开就清楚了：

- **host 重启 / 升级**。NanoClaw daemon 偶尔会被 launchctl 拉起拉起拉起 —— 用户重启电脑、用户运行 `pnpm run dev` 切到 dev 版本、自动更新触发 self-restart。在 host **不 alive** 的窗口里，container 写完 outbound.db 之后 push 通知会失败（socket connect refused、信号无 receiver）。container 是否要 retry？retry 几次？retry 队列在哪里持久化？一旦你开始回答这些问题，你已经在重新实现 outbound.db。
- **container crash 后重启**。container 在写 outbound.db 之后、push 通知之前如果挂了（OOM、agent SDK 抛异常），下一次启动它怎么知道这条消息"还没通知"？它得在自己的 DB 里加一张 "notified" 表 —— 又是一份本可以省掉的状态。
- **host miss event**。哪怕双方都活着，TCP socket 或 signal 在内核 buffer 满了的极端情况下会丢通知。push 系统必须配 reconciliation —— 也就是说，**push 系统最后还是要带一个 pull fallback**，不然就不 robust。一旦你接受了 pull fallback，pull fallback 本身就够用了：直接干掉 push，留 pull。
- **多 host 单 session 的潜在路径**。nanoclaw 暂时没这个场景，但 `agent_destinations` 已经允许 cross-session 路由（第 9 章会拆）；push 模型在这种 fan-in 拓扑下需要 routing layer，pull 模型只需要每个 host 自己扫自己 own 的 session。

总结一句：push 在 happy path 更快，但 robustness 需要重写一份持久化和补偿。**pull 的代价就是 1 秒延迟**，对一个面向人类对话的网关来说，1 秒完全在感知阈值之内 —— 这笔账算下来，pull 是正解。

## 5. nanoclaw 的做法：两速 pull + 单 session 互斥锁

`src/delivery.ts` 跑两条独立的定时循环，速度差 60 倍：

```
ACTIVE_POLL_MS = 1000     // pollActive：只看 container_status IN ('running','idle') 的 session
SWEEP_POLL_MS  = 60_000   // pollSweep： 看所有 status='active' 的 session（即便 container 没在跑）
```

为什么要两条？因为"session active"≠"container running"。container 在没消息的时候会被回收（第 7 章），但 session 本身还是 active 的 —— 一个被回收的 container 在 shutdown 的最后一刻可能往 outbound.db 写了一条延迟消息，host 必须能扫到。sweep 的 60s 节奏是 robustness 兜底，active 的 1s 节奏是 happy path 性能。

两条循环的核心都是 `deliverSessionMessages(session)`，它一开头就做互斥锁：

```ts
// src/delivery.ts:50-50
const inflightDeliveries = new Set<string>();

// src/delivery.ts:151-162
export async function deliverSessionMessages(session: Session): Promise<void> {
  if (inflightDeliveries.has(session.id)) return;  // 已有 in-flight，直接丢弃这次调用
  inflightDeliveries.add(session.id);
  try {
    await drainSession(session);
  } finally {
    inflightDeliveries.delete(session.id);
  }
}
```

注释里写得很直白（`src/delivery.ts:37-49`）：active poll 和 sweep poll 的结果集会重叠 —— 一个 running session 同时在两个集合里。没有这把锁，两条循环同 tick 会**双投递**（用户在终端看到两遍 "pong"）。SQL 层的 `INSERT OR IGNORE` 只能保证 DB 状态幂等，不能阻止 adapter 已经把字节写出去了。这把锁的设计哲学是 **drop, don't queue**：第二次调用直接丢，下一秒的 tick 会捡起任何没投递完的。

<svg viewBox="0 0 820 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Two delivery loops at 1s and 60s with inflight mutex preventing double delivery">
  <defs>
    <marker id="dp-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <text x="410" y="20" font-size="13" font-weight="700" fill="currentColor" text-anchor="middle">delivery.ts — two-rate pull + per-session mutex</text>
  <text x="60" y="48" font-size="10" fill="#94a3b8">t=</text>
  <line x1="80" y1="44" x2="780" y2="44" stroke="#cbd5e1"/>
  <text x="120" y="36" font-size="9" fill="#64748b">0s</text>
  <text x="260" y="36" font-size="9" fill="#64748b">1</text>
  <text x="400" y="36" font-size="9" fill="#64748b">2</text>
  <text x="540" y="36" font-size="9" fill="#64748b">…</text>
  <text x="680" y="36" font-size="9" fill="#64748b">60s</text>
  <rect x="20" y="62" width="780" height="80" rx="6" fill="#0ea5e9" opacity="0.10" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="30" y="80" font-size="11" font-weight="700" fill="#0369a1">pollActive — 1s · sessions WHERE container_status IN ('running','idle')</text>
  <line x1="120" y1="118" x2="780" y2="118" stroke="#0ea5e9" stroke-width="2"/>
  <circle cx="120" cy="118" r="6" fill="#0ea5e9"/>
  <circle cx="260" cy="118" r="6" fill="#0ea5e9"/>
  <circle cx="400" cy="118" r="6" fill="#0ea5e9"/>
  <circle cx="540" cy="118" r="6" fill="#0ea5e9"/>
  <text x="260" y="106" font-size="9" fill="#64748b" text-anchor="middle">happy path: scans every 1s</text>
  <text x="540" y="134" font-size="10" fill="#16a34a" text-anchor="middle" font-weight="600">finds our 'pong' row → enters drainSession</text>
  <rect x="20" y="156" width="780" height="80" rx="6" fill="#fef3c7" stroke="#ea580c" stroke-width="1.2"/>
  <text x="30" y="174" font-size="11" font-weight="700" fill="#9a3412">pollSweep — 60s · ALL sessions WHERE status='active'</text>
  <line x1="120" y1="212" x2="780" y2="212" stroke="#ea580c" stroke-width="2" stroke-dasharray="6,4"/>
  <circle cx="120" cy="212" r="6" fill="#ea580c"/>
  <circle cx="680" cy="212" r="8" fill="#ea580c"/>
  <text x="680" y="232" font-size="10" fill="#64748b" text-anchor="middle">robustness fallback</text>
  <text x="400" y="200" font-size="10" fill="#64748b" text-anchor="middle">covers reaped containers that wrote outbound at shutdown</text>
  <rect x="20" y="250" width="780" height="100" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="30" y="268" font-size="11" font-weight="700" fill="#5b21b6">overlap window — both loops would race on the same running session</text>
  <rect x="120" y="280" width="280" height="60" rx="4" fill="#ffffff" stroke="#a78bfa"/>
  <text x="260" y="298" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">inflightDeliveries: Set&lt;session_id&gt;</text>
  <text x="260" y="312" font-size="10" fill="#64748b" text-anchor="middle">if (has(id)) return;  // DROP, don't queue</text>
  <text x="260" y="326" font-size="10" fill="#64748b" text-anchor="middle">add → drainSession() → finally delete</text>
  <rect x="420" y="280" width="370" height="60" rx="4" fill="#ffffff" stroke="#a78bfa"/>
  <text x="605" y="298" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">layered idempotency (defence in depth)</text>
  <text x="605" y="312" font-size="10" fill="#64748b" text-anchor="middle">1. inflightDeliveries Set — JS-level lock</text>
  <text x="605" y="326" font-size="10" fill="#64748b" text-anchor="middle">2. inbound.delivered INSERT OR IGNORE — DB-level constraint</text>
  <line x1="540" y1="220" x2="540" y2="258" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#dp-ar)"/>
  <line x1="540" y1="124" x2="540" y2="252" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" opacity="0.5"/>
</svg>
<span class="figure-caption">图 T1.26 ｜ delivery 双速率 pull：蓝色 active loop 1s 扫 running session（happy path）+ 橙色 sweep loop 60s 扫所有 active session（robust 兜底）。两 loop 重叠靠 inflightDeliveries Set 互斥（drop, don't queue）+ DB INSERT OR IGNORE 防双投递。</span>

<details>
<summary>ASCII 原版</summary>

```
t = 0s    1     2     3    ...  60s
       ────●─────●─────●─────●─────●──────  pollActive (1s, running/idle sessions)
                                       finds 'pong' row → drainSession

       ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  pollSweep (60s, ALL active sessions)
                                                fallback for reaped containers

   overlap → inflightDeliveries: Set<session_id>  (drop, don't queue)
            └── drainSession ── INSERT OR IGNORE INTO delivered (DB constraint)
```

</details>

`drainSession` 的主体（`src/delivery.ts:164-232`）是一段非常对称的代码：

```ts
const outDb = openOutboundDb(agentGroup.id, session.id);   // 只读
const inDb  = openInboundDb (agentGroup.id, session.id);   // 读写
try {
  const allDue   = getDueOutboundMessages(outDb);          // SELECT * FROM messages_out
  const delivered = getDeliveredIds(inDb);                  // SELECT message_out_id FROM delivered
  const undelivered = allDue.filter(m => !delivered.has(m.id));
  migrateDeliveredTable(inDb);                              // 自适应 schema 演进
  for (const msg of undelivered) {
    const platformMsgId = await deliverMessage(msg, session, inDb);
    markDelivered(inDb, msg.id, platformMsgId ?? null);
    // ...
  }
} finally {
  outDb.close(); inDb.close();
}
```

注意三件事：

1. **每个 tick 都开/关 DB 连接**。这不是性能瑕疵，是 §3.7 "DELETE 模式与 open-write-close" 的不变量 —— 短连接才能安全地跨 Docker bind mount。
2. **`getDueOutboundMessages` 用 `deliver_after IS NULL OR deliver_after <= datetime('now')`**（`src/db/session-db.ts:258-266`）。这就是 scheduled message 用 outbound.db 实现的奥秘：写的时候 `deliver_after` 设到未来，pull loop 会自动跳过直到时间到。第 9 章 §"延迟投递" 会单独讲。
3. **`getDeliveredIds` 是把整张表读到内存的 Set**（`src/db/session-db.ts:272-278`）。`delivered` 表只长不删，session lifespan 内 cardinality 通常 < 1000，对于"对账"这个 hot path 来说，把它做成 Set 后再 filter 比 `LEFT JOIN ... WHERE x IS NULL` 在 cross-DB 场景下更简单（两个 DB 文件分开 attach 也行，但代码更复杂）。

到 `deliverMessage` 内部，按 kind dispatch（`src/delivery.ts:234-258`）：

```ts
if (msg.kind === 'system')  return handleSystemAction(content, session, inDb);
if (msg.channel_type === 'agent')  return routeAgentMessage(msg, session);   // agent-to-agent module
// otherwise: channel adapter
```

我们这一行 `kind='chat'`、`channel_type='cli'`，所以会走到 channel adapter 分支 —— **正是 step 17 要拆的代码路径**。

## 6. 代码位置（按读这一步源码的顺序）

| 顺序 | 文件:行 | 是什么 |
|------|---------|--------|
| 1 | `src/index.ts:113` 附近 | `startActiveDeliveryPoll()` 的调用点（host 启动尾声） |
| 2 | `src/delivery.ts:108-119` | `startActiveDeliveryPoll` / `startSweepDeliveryPoll`：单次 guard + 进入循环 |
| 3 | `src/delivery.ts:121-149` | `pollActive` / `pollSweep`：try-catch 包裹的 `setTimeout` 自循环 |
| 4 | `src/db/sessions.ts:66-72` | `getActiveSessions` / `getRunningSessions`：v2.db 上的 status 过滤 |
| 5 | `src/delivery.ts:37-50` | `inflightDeliveries` Set 与设计注释 |
| 6 | `src/delivery.ts:151-162` | `deliverSessionMessages`：互斥锁 acquire/release |
| 7 | `src/delivery.ts:164-232` | `drainSession`：开 DB → diff → 遍历投递 → close |
| 8 | `src/session-manager.ts:361-372` | `openOutboundDb` / `openInboundDb`：拼路径并 open |
| 9 | `src/db/session-db.ts:258-266` | `getDueOutboundMessages`：SELECT + `deliver_after` 过滤 |
| 10 | `src/db/session-db.ts:272-278` | `getDeliveredIds`：把已投递 ID 拉成 Set |
| 11 | `src/db/session-db.ts:293-303` | `migrateDeliveredTable`：补 `platform_message_id` / `status` 列 |
| 12 | `src/delivery.ts:234-271` | `deliverMessage`：按 kind dispatch（system / agent / channel） |

## 7. 分支与延伸

- 想看 delivery loop 全貌（含 retry 三次、`MAX_DELIVERY_ATTEMPTS` 语义、`deliveryAttempts` 在进程重启时为何故意清零）：跳第 9 章 [`src/delivery.ts` 总入口](09-outbound-delivery.md#srcdeliveryts-总入口)。
- 想看 `kind` 字段还能取哪些值（`chat` / `system` / `ask_question` / agent-to-agent）、各自走哪条 dispatch 分支：跳第 9 章 [Message kind dispatch](09-outbound-delivery.md#message-kind-dispatch)。
- 想看 `messages_out` 表所有字段、`delivered` 表为什么放在 inbound.db 而不是 outbound.db：跳第 3 章 [Outbound DB schema](03-three-db-model.md#352-outbounddbcontainer--host) 和 [§3.5.1 inbound.db](03-three-db-model.md#351-inbounddbhost--container) 里的 `delivered` 部分。

## 8. 走完这一步你脑子里应该多了什么

1. **delivery 是 pull-based、双速率、单 session 互斥**。1s active loop + 60s sweep loop，靠 `inflightDeliveries: Set<session_id>` 防止两条 loop 撞同一行。
2. **active sessions 的来源是 v2.db.sessions 表**，不是任何 in-memory cache —— `getRunningSessions` 按 `container_status IN ('running','idle')` 直接 SELECT。这意味着 host 重启后 delivery 立刻能恢复，不需要任何 warm-up 状态。
3. **"已投递"状态写在 inbound.db.delivered**，不在 outbound.db —— 单写者不变量决定了 host 永远不写 outbound.db，所以投递 bookkeeping 必须挪窝。
4. **dispatch 按 `kind` 三向分流**：`system` 走 host 内部 action handler、`channel_type='agent'` 走 agent-to-agent module、其余走 channel adapter。我们这一行进入的是第三条路。
5. **pull 的 1 秒延迟是有意识的权衡**。push-based 听起来更快，但 host 重启 / container crash / 内核 buffer 满都会让 push 漏事件，最后还是要写 reconciliation —— 与其加一层补偿，不如直接 pull。
