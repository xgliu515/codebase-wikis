## 60 秒 Sweep

第 9 章讲了 delivery loop —— 每秒一次紧盯 outbound.db 的紧凑路径。但还有一类事件 delivery loop 不管：

- 容器今天早上 9 点该被 cron 拉起 —— 这个时间点没有任何 outbound 行触发它，需要某个东西**主动**扫一遍"该被唤醒的 session"。
- 容器在 SDK 调用中卡住、agent 转着圈调 Bash 没出来 —— 没有 outbound 写出来，delivery loop 看不到。
- 容器 crash 留下 `processing_ack` 行 status='processing' —— inbound.db 那条消息卡在 pending 状态没人接，需要被回退重试。
- recurring task（"每天 9 点提醒我喝水"）完成一次之后下一次该出现在 messages_in 里 —— 没人写就永远不会触发。

这些都需要一个**低频心跳**扫一遍所有 active session 兜底。`src/host-sweep.ts` 就是这个心跳：每 60s 一次，对每个 active session 跑一次 sweep。

---

### 1. 设计问题

把要解决的问题列出来：

1. **stuck container 检测**：container 是 per-session 短生命容器，会死、会卡。需要一个外部观察者发现"这个容器已经死透了 / 卡了 10 分钟没动"，把它 kill 掉、把它正在处理的消息回退到 pending 等下次 retry。
2. **due-message wake**：用户安排的"5 分钟后给我自己发条提醒"消息（schedule_task）通过 `process_after` 字段挂在 messages_in 里 —— 5 分钟后该被发现并触发 container wake。没有事件驱动，必须轮询。
3. **recurrence 调度**：`recurrence = '0 9 * * *'` 的 task 每完成一次，要算 `next_run` 并 INSERT 下一行。这件事必须有一个稳定的循环来做。
4. **processing_ack 同步**：容器写到 outbound.db 的 `processing_ack` 表说"消息 X 我处理完了"；host 这边的 messages_in.status 也得相应改成 `completed`。但 host **不能**让容器直接写自己（违反两库分写），所以 host 自己得有人拉数据过来。
5. **orphan processing claim 清理**：crash 留下的 `processing_ack` 行，下次 sweep 看到时把它清掉，否则会把新启动的容器误判为 stuck（参见 §4.4）。
6. **错误隔离**：单个 session 处理失败不能拖死整个 sweep loop —— sweep 是 host 的最后一道防线，挂了就没人收尾了。

第二个约束：sweep 和 delivery loop **并发**跑。两者都开同一个 session 的 inbound.db / outbound.db，必须遵守"正好一个 writer per file"的不变量 —— sweep 只能写 inbound.db，绝不能写 outbound.db（除非已经把容器先 kill 掉）。

---

### 2. 为什么是 60s

`src/host-sweep.ts:61`：

```ts
const SWEEP_INTERVAL_MS = 60_000;
```

这是经验值。考虑：

- **太短**：每次 sweep 要 open / close 几百个 session 的 inbound + outbound DB、跑 SELECT、解析 heartbeat 文件 mtime、可能调 wakeContainer。500 个 active session 跑一遍 sweep 大概要 1-2 秒磁盘 IO；用 1s 间隔 IO 永远饱和。
- **太长**：用户安排的"5 分钟后提醒我"实际触发时间是 [5min, 5min+sweep_interval]。60s 抖动用户能接受；5 分钟抖动就不行（一条"睡前提醒"延迟到第二天早上）。
- **对 stuck 检测**：30 分钟绝对 ceiling 用 60s tick 检测，最坏滞后 1 分钟，可接受。

注意还有第二个 sweep loop —— delivery.ts 里的 `pollSweep`（每 60s 扫所有 `active` session 投递 outbound）和这里的 host-sweep 是**两个独立的 timer chain**，跑在同一进程不同 setTimeout 上：

| Loop                         | 间隔 | 集合              | 职责                                            |
|------------------------------|------|------------------|------------------------------------------------|
| delivery `pollActive`        | 1s   | running          | 紧贴 outbound.db 投递                          |
| delivery `pollSweep`         | 60s  | active           | 兜底投递 + race 修复                           |
| **host-sweep `sweep`**       | 60s  | active           | processing_ack 同步、stuck 检测、due wake、recurrence |

它们不共享 setTimeout chain，也不共享锁。

<svg viewBox="0 0 820 260" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Three independent timer loops in the host process: delivery pollActive (1s), delivery pollSweep (60s), and host-sweep (60s)"><defs><marker id="ar10a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="410" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">同进程内三条独立 setTimeout 链</text><text x="410" y="40" text-anchor="middle" font-size="11" fill="#64748b">不共享 timer，不共享锁，读写区域不重叠</text><g><rect x="30" y="70" width="240" height="80" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="150" y="92" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">delivery pollActive</text><text x="150" y="110" text-anchor="middle" font-size="11" fill="#64748b">每 1 秒 · running 集合</text><text x="150" y="130" text-anchor="middle" font-size="11" fill="currentColor">紧贴 outbound.db 投递</text><text x="150" y="146" text-anchor="middle" font-size="10" fill="#94a3b8">read outbound · write inbound.delivered</text></g><g><rect x="290" y="70" width="240" height="80" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="410" y="92" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">delivery pollSweep</text><text x="410" y="110" text-anchor="middle" font-size="11" fill="#64748b">每 60 秒 · active 集合</text><text x="410" y="130" text-anchor="middle" font-size="11" fill="currentColor">兜底投递 + race 修复</text><text x="410" y="146" text-anchor="middle" font-size="10" fill="#94a3b8">read outbound · write inbound.delivered</text></g><g><rect x="550" y="70" width="240" height="80" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="670" y="92" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">host-sweep</text><text x="670" y="110" text-anchor="middle" font-size="11" fill="#64748b">每 60 秒 · active 集合</text><text x="670" y="130" text-anchor="middle" font-size="11" fill="currentColor">ack 同步 / stuck / due / recur</text><text x="670" y="146" text-anchor="middle" font-size="10" fill="#94a3b8">read+write inbound · read outbound</text></g><g><rect x="60" y="180" width="700" height="60" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-dasharray="4,3"/><text x="410" y="202" text-anchor="middle" font-size="11" fill="#64748b">不变量：outbound.db 只有 container 写 (host 在 kill 后短暂 RW)；inbound.db 只有 host 写</text><text x="410" y="222" text-anchor="middle" font-size="11" fill="#64748b">三条 loop 串行写 inbound (better-sqlite3 同步) · busy_timeout=5000 兜底跨 connection 抢锁</text></g></svg>
<span class="figure-caption">图 R10.1 ｜ host 进程内三条独立 timer loop 的频率、作用集合、读写区域；解释为何不共享锁也安全。</span>

<details>
<summary>ASCII 原版</summary>

```
| Loop                         | 间隔 | 集合              | 职责                                            |
|------------------------------|------|------------------|------------------------------------------------|
| delivery `pollActive`        | 1s   | running          | 紧贴 outbound.db 投递                          |
| delivery `pollSweep`         | 60s  | active           | 兜底投递 + race 修复                           |
| host-sweep `sweep`           | 60s  | active           | processing_ack 同步、stuck 检测、due wake、recurrence |
```

</details>

---

### 3. 入口结构

`src/host-sweep.ts:120-145`：

```ts
let running = false;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await sweepSession(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}
```

模式和 delivery loop 一模一样：boolean flag + setTimeout chain + 顶层 try/catch。`getActiveSessions()` (`src/db/sessions.ts:66-68`) 返回所有 `status='active'` 的 session（同时被 delivery `pollSweep` 用）。

`stopHostSweep` 只置 flag false —— 当前正在跑的 sweep 跑完才退，新 tick 不会被排队（因为 `if (!running) return;`）。`src/index.ts:184-204` 的 shutdown 路径：

```ts
async function shutdown(signal: string): Promise<void> {
  ...
  stopDeliveryPolls();
  stopHostSweep();
  await stopCliServer();
  try {
    await teardownChannelAdapters();
  } finally {
    resetCircuitBreaker();
    process.exit(0);
  }
}
```

`stopHostSweep` 同步返回，不 await —— 还在跑的那一轮 sweep 在 setTimeout 自动 GC 时随着 process.exit 一起消失，没事，因为 sweep 写的都是 inbound.db 而 inbound.db 本身用 DELETE 模式 journal、单 statement 是原子的，进程被 kill 不会留半截事务。

---

### 4. sweepSession：7 个步骤

`src/host-sweep.ts:147-212` 是 per-session 主循环，按代码顺序拆解：

```ts
async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 2. Wake a container if work is due and nothing is running.
    const dueCount = countDueMessages(inDb);
    if (dueCount > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      await wakeContainer(session);
    }

    const alive = isContainerRunning(session.id);

    // 3. Running-container SLA: absolute ceiling + per-claim stuck rules.
    if (alive && outDb) {
      enforceRunningContainerSla(inDb, outDb, session, agentGroup.id);
    }

    // 4. Crashed-container cleanup: processing rows left behind get retried.
    if (!alive && outDb) {
      resetStuckProcessingRows(inDb, outDb, session, 'container not running');
    }

    // 5. Recurrence fanout for completed recurring tasks.
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(inDb, session);
  } finally {
    inDb.close();
    outDb?.close();
  }
}
```

这是 sweep 的全部主逻辑。下面把每一步详细解释。

#### 4.1 开 DB：inbound 必需、outbound 可选

```ts
if (!fs.existsSync(inPath)) return;
let inDb = openInboundDb(...);
try { outDb = openOutboundDb(...); } catch {}
```

为什么 inbound 不存在就 return？session 行可能刚 INSERT 完但 session 目录初始化失败（`initSessionFolder` 在 mkdir 失败时让 DB 文件不存在）—— 没什么可 sweep 的。

为什么 outbound 可能不存在？session 刚创建、容器从来没启动过 —— `initSessionFolder` (`src/session-manager.ts:135-` 范围内的 sibling 代码) 会建立 inbound.db 但 outbound.db 是 container 进程内 `ensureSchema` 第一次启动时创建的。fresh session 的 outbound.db 直到第一次 wake 才存在。

这种 fresh session 仍然要被 sweep —— 因为 §4.3 的 due-message wake 在 inbound.db 上跑，能触发 wake。outbound 不存在意味着 §4.2、§4.5、§4.6 都跳过。

`openInboundDb` 和 `openOutboundDb` 来自 `src/session-manager.ts:361-371`：

```ts
export function openInboundDb(agentGroupId: string, sessionId: string): Database.Database {
  const db = openInboundDbRaw(inboundDbPath(agentGroupId, sessionId));
  ...
  return db;
}

export function openOutboundDb(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbRaw(outboundDbPath(agentGroupId, sessionId));
}
```

inbound 是读写，outbound 是 readonly。这是 invariant 的物理强制。

#### 4.2 步骤 1：syncProcessingAcks

`src/db/session-db.ts:169-182`：

```ts
export function syncProcessingAcks(inDb: Database.Database, outDb: Database.Database): void {
  const completed = outDb
    .prepare("SELECT message_id FROM processing_ack WHERE status IN ('completed', 'failed')")
    .all() as Array<{ message_id: string }>;

  if (completed.length === 0) return;

  const updateStmt = inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ? AND status != 'completed'");
  inDb.transaction(() => {
    for (const { message_id } of completed) {
      updateStmt.run(message_id);
    }
  })();
}
```

这一步把容器写在 outbound.db `processing_ack` 表里的"已处理"标记同步到 inbound.db 的 messages_in.status。

为什么不能让容器直接更新 messages_in？因为 inbound.db 是 host-owned，容器没写权限（mount 是 readonly 或 ensureSchema 用 readonly open）。

延迟有多长？最坏 60s（一个 sweep tick）。但实际上 delivery `pollActive` 每秒也会 open inbound.db 看 delivered 表 —— 那个路径**不**调 syncProcessingAcks，所以状态同步真的就靠这里。

为什么 status 同步重要？sweep 自己的其它步骤（§4.3 的 dueCount、§4.6 的 recurrence）都读 messages_in.status。如果不同步，已完成的消息会被反复"due"。

把整个 update 包在一个 transaction 里：5000 行 active session 一个 tick 跑下来，多个 sync 一起提交比逐条快得多（每条 SQLite write fsync 是几 ms）。

#### 4.3 步骤 2：due-message wake

```ts
const dueCount = countDueMessages(inDb);
if (dueCount > 0 && !isContainerRunning(session.id)) {
  log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
  await wakeContainer(session);
}
```

`countDueMessages` (`src/db/session-db.ts:136-147`)：

```sql
SELECT COUNT(*) as count FROM messages_in
WHERE status = 'pending'
  AND trigger = 1
  AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
```

三个条件：

- `status='pending'`：还没处理。
- `trigger=1`：这条消息应当 wake agent（trigger=0 是"积累作为上下文，不要 wake"，用于 fire-and-forget 通知，详见 schema 注释 `src/db/schema.ts:168-169`）。
- `process_after IS NULL OR process_after <= now`：要么是普通消息（NULL）、要么是定时消息且到时间了。

如果 `dueCount > 0` 且容器没在跑，调 `wakeContainer(session)`。

`wakeContainer` (`src/container-runner.ts:85-106`) 是 **never throws** 契约：

```ts
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) return existing;
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}
```

`wakePromises` 去重并发 wake（router、sweep 和 a2a 都可能在 100ms 内同时调 wake）。失败时只 log warn 返回 false —— 不抛 —— 因为 sweep 60s 后会再试。

注意排序：**先 wake，再 stuck-detect**。注释 `src/host-sweep.ts:175-180`：

> Ordered before the crashed-container cleanup so a fresh container gets a chance to clean its own orphan processing_ack rows on startup. Otherwise the reset path would keep bumping process_after into the future, dueCount would stay 0, and the wake would never fire.

容器启动时自己会跑 `clearStaleProcessingAcks()`（容器端 `container/agent-runner/src/db/connection.ts`）—— 把 status='processing' 但其实自己刚启动还没在跑的行清掉。如果 sweep 先做 §4.5 的 reset（把 process_after 推到 5/10/20s 后做 backoff），那么 dueCount 一直是 0，wake 永远不触发，循环卡死。先 wake 给容器自我清理的机会。

#### 4.4 步骤 3：running-container SLA

```ts
const alive = isContainerRunning(session.id);

if (alive && outDb) {
  enforceRunningContainerSla(inDb, outDb, session, agentGroup.id);
}
```

`enforceRunningContainerSla` (`src/host-sweep.ts:228-262`) 是 stuck container 检测的主入口：

```ts
function enforceRunningContainerSla(inDb, outDb, session, agentGroupId): void {
  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerState: getContainerState(outDb),
    claims: getProcessingClaims(outDb),
  });

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', { ... });
    killContainer(session.id, 'absolute-ceiling');
    resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling');
    return;
  }

  log.warn('Killing container — message claimed then silent', { ... });
  killContainer(session.id, 'claim-stuck');
  resetStuckProcessingRows(inDb, outDb, session, 'claim-stuck');
}
```

这一步是 sweep 最复杂的部分。展开讲。

##### 4.4.1 三个输入

`decideStuckAction` 接收 4 个输入：

- `now`：当前 epoch ms。
- `heartbeatMtimeMs`：`.heartbeat` 文件的 mtime（不存在时 0）。容器内每个 SDK 事件都 touch 一次这个文件 —— 它代表"agent 还在动"。
- `containerState`：outbound.db 里 `container_state` 表的当前行，包含 `current_tool`（agent 当前在调哪个工具）和 `tool_declared_timeout_ms`（如果是 Bash，agent 声明了多久超时）。
- `claims`：所有 status='processing' 的 processing_ack 行，带 `status_changed` 时间戳。这是"容器认领了哪些消息正在处理"。

##### 4.4.2 heartbeatPath 与 mtime

`src/session-manager.ts:67-69`：

```ts
export function heartbeatPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), '.heartbeat');
}
```

`src/host-sweep.ts:214-221`：

```ts
function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}
```

`mtimeMs = 0` 表示文件不存在（容器从来没 touch 过）。container 端的 SDK callback 在每个事件里 `fs.utimesSync(heartbeatPath, now, now)` —— 任何一点 SDK 活动都更新 mtime。

为什么用文件 mtime 而不是 DB 行？
- mtime 更新极快（不需要 SQLite 锁、不走 journal）。
- 不污染 outbound.db 的 schema 和 single-writer invariant（mtime 不是写 SQLite 数据）。
- 跨挂载 fstat 在所有 runtime 上都可靠（不像 inotify）。

#### 4.4.3 decideStuckAction 决策逻辑

`src/host-sweep.ts:82-118`：

```ts
export function decideStuckAction(args): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims } = args;
  const declaredBashMs = bashTimeoutMs(containerState);

  // Ceiling check only applies when we have an actual heartbeat timestamp.
  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0);
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
  for (const claim of claims) {
    const claimedAt = parseSqliteUtc(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}
```

两条 rule 串行检查：

**Rule 1：绝对 ceiling**

`ABSOLUTE_CEILING_MS = 30 * 60 * 1000`（30 分钟，`src/host-sweep.ts:65`）。

如果有 heartbeat 文件且 mtime 距今超过 ceiling：kill。这覆盖"容器活着但 30 分钟没干任何事"的 case。

ceiling 在 agent 声明了长 Bash timeout 时会被放宽：`Math.max(ABSOLUTE_CEILING_MS, declaredBashMs)`。比如 agent 调 `Bash(...)` 时声明 timeout=2 小时（rare 但合法），sweep 不应该在 30 分钟时 kill 它。

**Heartbeat 不存在时跳过 ceiling**：注释 `src/host-sweep.ts:90-99` 解释：

> A freshly-spawned container hasn't had any SDK activity yet so no heartbeat file exists — if we treated that as infinitely stale we'd kill every container within seconds of spawn. Genuinely-dead containers that never wrote a heartbeat are caught by the separate "container process not running" cleanup path, not here. If a fresh container is hanging at the gate (claimed a message but never did anything) the claim-stuck check below handles it.

而且容器 spawn 时（`src/container-runner.ts:155`）：

```ts
fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });
```

主动删旧文件。这样新容器在 touch 第一次之前 `statSync` 返回不存在，sweep 给 grace。如果不删，旧文件 mtime 可能就是 30 分钟前，新容器一启动就被立刻 kill。

**Rule 2：claim-stuck**

`CLAIM_STUCK_MS = 60 * 1000`（60s，`src/host-sweep.ts:68`）。

对每条 status='processing' 的 claim 检查：
- claim age > tolerance（默认 60s，agent 声明的 Bash timeout 时放宽）
- AND heartbeat mtime <= claim 时间（即 claim 之后没有任何心跳）

如果两者都满足：kill。这覆盖"容器接了消息但接完就 hang 死"的 case。

逻辑细节：`heartbeatMtimeMs > claimedAt`（注意是 `>`）表示 claim 之后心跳更新过 —— 哪怕只是一次 SDK callback fire 都算 "在动"，跳过这条 claim。

##### 4.4.4 kill 与 reset 的两步

```ts
killContainer(session.id, 'absolute-ceiling');
resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling');
```

`killContainer` (`src/container-runner.ts:193-207`)：

```ts
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}
```

`stopContainer` (`src/container-runtime.ts:29-34`) 调 `docker stop -t 1 <name>` —— SIGTERM 1 秒宽限期再 SIGKILL。如果 docker stop 抛错（runtime 挂了），fallback 到直接 SIGKILL spawned process。

容器进程死，`spawn` 的 `close` event 触发 `activeContainers.delete + markContainerStopped + stopTypingRefresh`（`src/container-runner.ts:177-182`）。

**注意 killContainer 不 await 死掉**。后面立刻调 `resetStuckProcessingRows` 这时候 close 事件可能还没触发 —— `activeContainers.has(session.id)` 可能还返回 true。但 resetStuckProcessingRows **不**检查 isContainerRunning，它直接读 outbound.db 的 processing_ack 行去做 reset，不需要等容器真死透才操作。

##### 4.4.5 resetStuckProcessingRows

`src/host-sweep.ts:273-328`：

```ts
function resetStuckProcessingRows(inDb, outDb, session, reason, writableOutDb?): void {
  const claims = getProcessingClaims(outDb);
  const now = Date.now();
  for (const { message_id } of claims) {
    const msg = getMessageForRetry(inDb, message_id, 'pending');
    if (!msg) continue;

    // Already rescheduled for a future retry — don't bump tries again.
    if (msg.processAfter && parseSqliteUtc(msg.processAfter) > now) continue;

    if (msg.tries >= MAX_TRIES) {
      markMessageFailed(inDb, msg.id);
      log.warn('Message marked as failed after max retries', { ... });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      retryWithBackoff(inDb, msg.id, backoffSec);
      log.info('Reset stale message with backoff', { ... });
    }
  }

  // Drop the orphan 'processing' rows.
  const ownsDb = !writableOutDb;
  let useDb: Database.Database | null = writableOutDb ?? null;
  try {
    if (!useDb) useDb = openOutboundDbRw(session.agent_group_id, session.id);
    const cleared = deleteOrphanProcessingClaims(useDb);
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  } finally {
    if (ownsDb) useDb?.close();
  }
}
```

三件事：

1. **回退 messages_in.status**：每条 stuck claim 对应的 messages_in 行（如果 status='pending'，被容器拿走但状态没改 —— 注意：能 claim 但 status 没改是因为 status 是 host 改的，容器只在自己的 processing_ack 表里登记 claim）—— 用 `retryWithBackoff` 把 `tries++` 并把 `process_after` 推到 backoff 后。
2. **MAX_TRIES (5) 之后 mark failed**：彻底放弃，写 status='failed'，不再尝试。
3. **删 orphan processing_ack 行**：用 `openOutboundDbRw` 重新以 RW 模式开 outbound.db（注意：sweepSession 主路径用的是 readonly），调 `deleteOrphanProcessingClaims`。

**为什么这里**能写 outbound.db？因为容器**刚被 kill**，没有 writer 在抢锁。container 端的 `clearStaleProcessingAcks` 也只在 startup 时跑 —— 当前没有 writer。这个例外是有意的，注释 `src/db/session-db.ts:203-215`：

> Delete orphan 'processing' rows. Called by the host after killing a container so the leftover claim doesn't trip claim-stuck on the next sweep tick (which would kill the freshly respawned container before its agent-runner can run its own startup cleanup).
> Safe because the host only writes to outbound.db when no container is running (we just killed it).

不删的话，下个 60s tick：
- 新容器已经被某次 wake spawn 起来了。
- 旧 claim 还在 processing_ack 表里，`status_changed` 是 X 分钟前。
- decideStuckAction 看到 claim age 远超 tolerance，立刻 kill 新容器。
- 循环到容器跑 startup 自清理之前永远 stuck。

`backoff`：`BACKOFF_BASE_MS * 2^tries` = 5s / 10s / 20s / 40s / 80s（tries=0..4），第 5 次失败 mark failed。指数退避避免 hot-loop"容器一直 crash 一直 wake 一直 crash"。

##### 4.4.6 retryWithBackoff

`src/db/session-db.ts:153-157`：

```ts
export function retryWithBackoff(db: Database.Database, messageId: string, backoffSec: number): void {
  db.prepare(
    `UPDATE messages_in SET tries = tries + 1, process_after = datetime('now', '+${backoffSec} seconds') WHERE id = ?`,
  ).run(messageId);
}
```

更新 `tries` 和 `process_after` 一起。下次 sweep 看到 `process_after > now`，§4.3 的 dueCount 不算这条，wake 不触发，让消息歇 5/10/20s。

#### 4.5 步骤 4：crashed-container cleanup

```ts
if (!alive && outDb) {
  resetStuckProcessingRows(inDb, outDb, session, 'container not running');
}
```

走的是同一个 reset 函数，但触发条件不同：容器**自然死亡**（OOM、container runtime 重启、用户手动 `docker kill`），不是被 sweep 主动 kill 的。

`!alive` 来自 `isContainerRunning(session.id)`（`src/container-runner.ts:69-71`）：

```ts
export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}
```

`activeContainers` 在 spawn 时 add（`src/container-runner.ts:159`），在 close / error event 触发时 delete（`src/container-runner.ts:178-188`）。所以 `!alive` 表示 spawn 进程已经 close。

这步是 idempotent —— 如果上一个 sweep tick 已经 reset 过、`process_after` 已经被推到未来，§4.5 这次 reset 看到 `msg.processAfter > now` 直接 continue，不会重复 bump tries。

#### 4.6 步骤 5：recurrence fanout

```ts
const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
await handleRecurrence(inDb, session);
```

动态 import —— scheduling module 没装时 host-sweep 应当跳过这一步。但实际上 scheduling 是 default module (`src/modules/index.ts` 默认包含它)，import 一定能成功。`MODULE-HOOK:scheduling-recurrence` 标记 (`src/host-sweep.ts:204-207`) 是给 install skill 用的 marker，如果将来 scheduling 移到 channels 分支，install skill 会按 marker 自动 patch 这一段。

`handleRecurrence` (`src/modules/scheduling/recurrence.ts:21-54`)：

```ts
export async function handleRecurrence(inDb, session): Promise<void> {
  const recurring = getCompletedRecurring(inDb);

  for (const msg of recurring) {
    try {
      const { CronExpressionParser } = await import('cron-parser');
      const interval = CronExpressionParser.parse(msg.recurrence, { tz: TIMEZONE });
      const nextRun = interval.next().toISOString();
      const prefix = msg.kind === 'task' ? 'task' : 'msg';
      const newId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      insertRecurrence(inDb, msg, newId, nextRun);
      clearRecurrence(inDb, msg.id);

      log.info('Inserted next recurrence', { ... });
    } catch (err) {
      log.error('Failed to compute next recurrence', { ... });
    }
  }
}
```

逻辑：
- 拉所有"已完成的 + 有 recurrence"行（`getCompletedRecurring`，`src/modules/scheduling/db.ts:122-126`）。这是上一次执行已经完成、但还有 cron 表达式没处理的行。
- 解析 cron（按用户时区）算出下一次时间。
- 插入一条新行（同 series_id、新 id、`process_after = next_run`），状态 pending。
- 清掉原行的 recurrence 字段 —— 这样下次 sweep 不会再把原行算进来。

为什么用 series_id？因为 `cancel_task` / `update_task` 等 action 需要找"这条 cron task 的下一次实例"。每个 occurrence 是独立的 messages_in 行，但通过 `series_id` 串起来。`series_id = 原 task_id`（`src/modules/scheduling/db.ts:31` 的 `series_id` 字段用 `@id`）—— 所以 agent 调度 task 时拿到的 id 永远能找到"这个系列的活实例"。

注意 TIMEZONE 来自 `src/config.ts`：

```ts
const interval = CronExpressionParser.parse(msg.recurrence, { tz: TIMEZONE });
```

用户时区，不是 UTC。"`0 9 * * *`" 在用户的 9 点触发，不是 UTC 9 点。这是 v1 就有的设计，注释 `src/modules/scheduling/recurrence.ts:28-30` 解释：

> Interpret the cron expression in the user's timezone. v1 did this (src/v1/task-scheduler.ts:20-49); without it, a task written "0 9 * * *" by an agent running in a user's local TZ fires at 09:00 UTC instead of 09:00 user-local.

#### 4.7 finally：关 DB

```ts
} finally {
  inDb.close();
  outDb?.close();
}
```

每个 session 处理完关 DB —— better-sqlite3 的 connection 不是无限便宜的资源（每个占一个 fd + 内存）。500 个 session 跑一遍如果不关，fd 用量会爆。开关 DB 每次 < 1ms，可以接受。

---

### 5. 几个常见情景的完整 trace

#### 5.1 OOM 之后的恢复

1. agent 跑 `Bash(npm install -g <huge-package>)`，container 进程 OOM 被 kernel 杀。
2. container 进程 close event 触发 `markContainerStopped + activeContainers.delete`。
3. 当时 outbound.db 里 `processing_ack` 表有一行 `{message_id:'msg-A', status:'processing'}`。
4. 几秒后 sweep tick 进 sweepSession：
   - syncProcessingAcks：那行 status 是 'processing' 不是 'completed/failed'，不同步。
   - countDueMessages：msg-A 还是 pending，process_after 是 NULL，**dueCount = 1**。
   - `!isContainerRunning`，调 wakeContainer → spawn 新容器。
   - alive 现在重新是 true（spawn 同步把 activeContainers add 了）。
   - `enforceRunningContainerSla`：heartbeat 不存在（spawn 时被 rm 了），ceiling 跳过。claims 里有那行旧 claim，但是 status_changed 是 5 秒前 < tolerance 60s，跳过。`decision = 'ok'`。
   - alive==true，跳过 §4.5 reset。
   - handleRecurrence：没 recurring task，no-op。
5. 新容器 startup：跑 `clearStaleProcessingAcks` 把旧的 processing_ack 行清掉（容器侧自清理，参见 §4.3 注释链接到的 connection.ts）。
6. 新容器读 inbound.db 找 msg-A status='pending'，开始重新处理。
7. 处理完写 processing_ack(status='completed') + 写 outbound 回复。
8. 下个 sweep tick：syncProcessingAcks 把 msg-A 改成 completed。

整套流程从 OOM 到恢复 < 2 个 sweep tick = < 120s。

<svg viewBox="0 0 880 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="OOM recovery timeline showing how sweep wakes a new container and clears stale processing_ack rows within two ticks"><defs><marker id="ar10d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="440" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">OOM 之后的恢复：&lt; 2 个 sweep tick (&lt; 120s)</text><line x1="40" y1="60" x2="840" y2="60" stroke="#cbd5e1" stroke-width="1"/><text x="40" y="50" font-size="10" fill="#94a3b8">t=0</text><text x="440" y="50" font-size="10" fill="#94a3b8">t=60s</text><text x="840" y="50" text-anchor="end" font-size="10" fill="#94a3b8">t≤120s</text><g><circle cx="60" cy="60" r="5" fill="#dc2626"/><rect x="40" y="80" width="200" height="60" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/><text x="140" y="100" text-anchor="middle" font-size="11" font-weight="700" fill="#dc2626">OOM</text><text x="140" y="118" text-anchor="middle" font-size="10" fill="#64748b">Bash 进程被 kernel 杀</text><text x="140" y="132" text-anchor="middle" font-size="10" fill="#64748b">activeContainers.delete</text></g><g><rect x="40" y="160" width="200" height="50" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/><text x="140" y="180" text-anchor="middle" font-size="11" fill="currentColor">outbound 残留</text><text x="140" y="196" text-anchor="middle" font-size="10" fill="#64748b">processing_ack(msg-A, processing)</text></g><line x1="240" y1="120" x2="290" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10d)"/><g><circle cx="320" cy="60" r="5" fill="#7c3aed"/><rect x="300" y="80" width="280" height="220" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="440" y="100" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">sweep tick #1</text><text x="312" y="120" font-size="10" fill="#64748b">§1 syncAck: skip (status=processing)</text><text x="312" y="138" font-size="10" fill="#64748b">§2 dueCount=1 &amp;&amp; !alive</text><text x="312" y="156" font-size="10" font-weight="700" fill="#16a34a">     → wakeContainer ← 新容器 spawn</text><text x="312" y="174" font-size="10" fill="#64748b">§3 alive=true 再次</text><text x="312" y="192" font-size="10" fill="#64748b">     ceiling: heartbeat 不存在 → skip</text><text x="312" y="210" font-size="10" fill="#64748b">     claims age=5s &lt; 60s → skip</text><text x="312" y="228" font-size="10" fill="#64748b">     decision = ok</text><text x="312" y="246" font-size="10" fill="#64748b">§4 alive → skip reset</text><text x="312" y="264" font-size="10" fill="#64748b">§5 recurrence: no-op</text><text x="312" y="286" font-size="10" font-weight="600" fill="#7c3aed">新容器 startup: clearStaleProcessingAcks</text></g><line x1="580" y1="190" x2="630" y2="190" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10d)"/><g><circle cx="660" cy="60" r="5" fill="#0d9488"/><rect x="640" y="80" width="200" height="220" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="740" y="100" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">sweep tick #2</text><text x="652" y="120" font-size="10" fill="#64748b">新容器读 msg-A</text><text x="652" y="136" font-size="10" fill="#64748b">重新处理</text><text x="652" y="156" font-size="10" fill="#64748b">写 processing_ack</text><text x="652" y="172" font-size="10" fill="#64748b">     (status=completed)</text><text x="652" y="192" font-size="10" fill="#64748b">写 outbound 回复</text><text x="652" y="216" font-size="10" font-weight="700" fill="#16a34a">§1 syncAck: messages_in</text><text x="652" y="232" font-size="10" font-weight="700" fill="#16a34a">     → status=completed</text><text x="740" y="278" text-anchor="middle" font-size="11" font-weight="700" fill="#16a34a">恢复完成</text></g><g><rect x="40" y="320" width="800" height="30" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-dasharray="4,3"/><text x="440" y="340" text-anchor="middle" font-size="11" fill="#64748b">关键顺序：先 wake 再 reset — 让容器自己 startup 清理 orphan，否则 process_after 被 bump 死循环</text></g></svg>
<span class="figure-caption">图 R10.4 ｜ OOM 之后的两 tick 恢复时间线：tick#1 wake 新容器并由容器自清理，tick#2 同步 ack 完成恢复，最坏 120 秒。</span>

<details>
<summary>ASCII 原版</summary>

```
t=0       OOM (container killed by kernel)
          outbound.processing_ack(msg-A, processing) 残留
t≤60s     sweep tick #1
          §1 syncAck: skip (status=processing)
          §2 dueCount=1 && !alive → wakeContainer (新容器 spawn)
          §3 alive=true: ceiling 跳过 (heartbeat 不存在), claim age<60s → ok
          新容器 startup: clearStaleProcessingAcks 清掉旧 claim
t≤120s    sweep tick #2
          新容器读 msg-A 重处理, 写 processing_ack(completed) + outbound 回复
          §1 syncAck: messages_in → completed  ✓
```

</details>

#### 5.2 schedule_task 5 分钟提醒

1. agent 调 `schedule_task({prompt:'喝水', processAfter:'5 分钟后'})`。
2. container 写 outbound (`kind='system', content={action:'schedule_task',...,processAfter:'2026-05-24T10:05:00Z'}`)。
3. delivery loop 1s 内拉到，进 handleSystemAction → handleScheduleTask → insertTask 写 messages_in (`kind='task', status='pending', process_after='2026-05-24T10:05:00Z'`)。
4. 几分钟内每次 sweep tick：
   - countDueMessages 不算这条（process_after > now）。
   - dueCount 是 0（假如没别的 pending message），不 wake。容器自然空闲、自然 stop。
5. 10:05 UTC 之后第一个 sweep tick：
   - countDueMessages 数到了，dueCount = 1。
   - `!isContainerRunning`，wakeContainer。
6. 容器 wake 之后读 messages_in，看到 kind='task' 行，按 task 模式处理（运行 prompt "喝水"）。
7. 处理完写 outbound 回复给用户，写 processing_ack(status='completed')。
8. 下个 sweep tick syncProcessingAcks 把 messages_in.status 改成 completed。

延迟：最坏 60s。

#### 5.3 recurring task "每天 9 点"

1. agent 调 `schedule_task({prompt:'check email', processAfter:'今晚 21:00', recurrence:'0 9 * * *'})`。
2. delivery → handleScheduleTask → insertTask（带 recurrence）。
3. 21:00 sweep wake 容器，执行 prompt。
4. 容器完成、写 processing_ack。
5. 下个 sweep tick：
   - syncProcessingAcks 把 status 改成 completed。
   - countDueMessages 是 0。
   - handleRecurrence：`getCompletedRecurring` 拉到这条（status='completed' AND recurrence='0 9 * * *'）。
   - 算 nextRun = 第二天 09:00（用户时区）。
   - INSERT 新行（同 series_id，新 id，processAfter=nextRun，status='pending'，recurrence='0 9 * * *'）。
   - UPDATE 原行 recurrence=NULL。
6. 第二天 9 点 sweep wake，循环重复。

如果用户在中间用 cancel_task：
1. agent 调 cancel_task(taskId=原 id)。
2. handleCancelTask → `cancelTask(inDb, taskId)` → `UPDATE messages_in SET status='completed', recurrence=NULL WHERE (id=? OR series_id=?) AND kind='task' AND status IN ('pending','paused')`。
3. 注意它匹配 `id OR series_id` —— 原 id 已经被改成 completed 了 §5.3 步骤 5，但活的下一次 occurrence 的 series_id 仍然是原 id，所以 UPDATE 会命中那条活实例，把它也 completed 掉。注释 `src/modules/scheduling/db.ts:8-11`：
   > cancel/pause/resume match any live row in the series, not just the exact id. Recurring tasks get a new row per occurrence (see handleRecurrence), all sharing series_id. Matching by id alone would only hit the completed row the agent remembers, missing the live next occurrence.

#### 5.4 30 分钟 idle ceiling

1. agent 正在跟用户聊天，对话进入安静期。容器还在跑（没有 stop）。
2. 容器 30 分钟没收新 inbound 也没主动跑工具。heartbeat 文件 mtime 是 30 分钟前。
3. sweep tick 进 enforceRunningContainerSla：
   - heartbeatMtimeMs = 30 分钟前。
   - declaredBashMs = null（没在跑工具）。
   - ceiling = max(30min, 0) = 30min。
   - heartbeatAge > 30min → `kill-ceiling`。
4. killContainer + resetStuckProcessingRows。这时候没有 active claim，reset 是 no-op。但 deleteOrphanProcessingClaims 还是会清掉那些已经过期的 claim 行。
5. 容器 close。
6. 下个 sweep tick：countDueMessages 没有 pending，dueCount = 0，不 wake。session 自然 idle。
7. 用户下一次发消息，router wakeContainer 重启容器。

这意味着：用户不发消息 30 分钟之后容器自动停掉省资源；用户重新发消息又自动起来。

#### 5.5 长 Bash 命令

1. agent 调 `Bash('long-running-script.sh', timeout_ms=5*60*1000)`（5 分钟）。
2. container 把 container_state 表更新成 `{current_tool:'Bash', tool_declared_timeout_ms:300000, tool_started_at:'now'}`。
3. 4 分钟时 sweep tick：
   - getContainerState 返回 `{current_tool:'Bash', tool_declared_timeout_ms:300000}`。
   - bashTimeoutMs = 300000。
   - heartbeat 假设 1 分钟前更新过（SDK 偶尔 fire 事件）：heartbeatAge = 60s，ceiling = max(30min, 5min) = 30min → no kill.
   - claims 里有当前消息那行，age = 4min, tolerance = max(60s, 5min) = 5min → no kill.
   - decision='ok'。
4. 5 分 30s 时 Bash 还没结束：sweep tick 看到 heartbeatAge < 30min（heartbeat 可能在 Bash output stream 时 fire），但 claim age > 5min ceiling → kill-claim。
5. resetStuckProcessingRows 把消息回退、tries++。
6. 下次 wake 时容器重新尝试这条消息。

这设计有点 conservative —— agent 声明 5 分钟 timeout，sweep 给 5 分钟整 grace，但 5 分钟过了立刻 kill 容易让一些刚好运行 5min1s 的脚本被 kill。在实际中 agent 不会调用恰好 5 分钟的命令（Claude 会留 buffer），所以不是问题。

<svg viewBox="0 0 820 440" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="decideStuckAction decision tree: heartbeat ceiling rule then per-claim stuck rule"><defs><marker id="ar10c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="410" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">decideStuckAction — 三信号判活逻辑</text><g><rect x="40" y="50" width="220" height="70" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="150" y="72" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">heartbeat mtime</text><text x="150" y="90" text-anchor="middle" font-size="10" fill="#64748b">.heartbeat 文件</text><text x="150" y="106" text-anchor="middle" font-size="10" fill="#64748b">每次 SDK 事件 touch</text></g><g><rect x="300" y="50" width="220" height="70" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="410" y="72" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">container_state</text><text x="410" y="90" text-anchor="middle" font-size="10" fill="#64748b">current_tool, declared</text><text x="410" y="106" text-anchor="middle" font-size="10" fill="#64748b">tool_declared_timeout_ms</text></g><g><rect x="560" y="50" width="220" height="70" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="670" y="72" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">processing_ack 表</text><text x="670" y="90" text-anchor="middle" font-size="10" fill="#64748b">status=processing 行</text><text x="670" y="106" text-anchor="middle" font-size="10" fill="#64748b">status_changed 时间戳</text></g><line x1="150" y1="120" x2="280" y2="155" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10c)"/><line x1="410" y1="120" x2="410" y2="155" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10c)"/><line x1="670" y1="120" x2="540" y2="155" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10c)"/><g><rect x="240" y="160" width="340" height="40" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/><text x="410" y="184" text-anchor="middle" font-size="12" font-weight="700" fill="#dc2626">Rule 1: 绝对 ceiling (30min, 放宽到 declaredBashMs)</text></g><g><rect x="80" y="220" width="280" height="50" rx="6" fill="#f0fdf4" stroke="#16a34a"/><text x="220" y="240" text-anchor="middle" font-size="11" fill="currentColor">heartbeat 不存在 → 跳过 ceiling</text><text x="220" y="258" text-anchor="middle" font-size="10" fill="#64748b">新容器 spawn 时 rm 文件给 grace</text></g><g><rect x="460" y="220" width="280" height="50" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/><text x="600" y="240" text-anchor="middle" font-size="11" font-weight="700" fill="#dc2626">heartbeatAge &gt; ceiling → kill-ceiling</text><text x="600" y="258" text-anchor="middle" font-size="10" fill="#64748b">容器 30 分钟没动</text></g><line x1="320" y1="200" x2="220" y2="220" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10c)"/><line x1="500" y1="200" x2="600" y2="220" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10c)"/><g><rect x="240" y="290" width="340" height="40" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/><text x="410" y="314" text-anchor="middle" font-size="12" font-weight="700" fill="#dc2626">Rule 2: claim-stuck (60s, 放宽到 declaredBashMs)</text></g><line x1="410" y1="270" x2="410" y2="290" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10c)"/><g><rect x="80" y="350" width="280" height="50" rx="6" fill="#f0fdf4" stroke="#16a34a"/><text x="220" y="370" text-anchor="middle" font-size="11" fill="currentColor">claim 后心跳更新过 → 跳过</text><text x="220" y="388" text-anchor="middle" font-size="10" fill="#64748b">heartbeatMtimeMs &gt; claimedAt</text></g><g><rect x="460" y="350" width="280" height="50" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/><text x="600" y="370" text-anchor="middle" font-size="11" font-weight="700" fill="#dc2626">claimAge &gt; tolerance &amp;&amp; 无心跳 → kill-claim</text><text x="600" y="388" text-anchor="middle" font-size="10" fill="#64748b">接消息后立刻卡死</text></g><line x1="320" y1="330" x2="220" y2="350" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10c)"/><line x1="500" y1="330" x2="600" y2="350" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10c)"/></svg>
<span class="figure-caption">图 R10.3 ｜ decideStuckAction 用三个信号 (heartbeat / container_state / claims) 串行跑两条 rule：绝对 ceiling + per-claim stuck；右侧红色路径触发 kill。</span>

<details>
<summary>ASCII 原版</summary>

```
3 inputs                  Rule 1: ceiling (30min)        Rule 2: claim-stuck (60s)
┌─────────────────┐       ┌──────────────────────┐       ┌─────────────────────────┐
│ heartbeat mtime │──┐    │ if hbAge > ceiling   │       │ for claim in claims:    │
├─────────────────┤  ├──→ │   → kill-ceiling     │  ──→  │   if age > tol          │
│ container_state │──┤    │ else if no hb → skip │       │      && no hb after     │
├─────────────────┤  │    └──────────────────────┘       │      → kill-claim       │
│ claims (proc.)  │──┘                                   └─────────────────────────┘
└─────────────────┘
   ceiling = max(30min, declaredBashMs)
   tolerance = max(60s,  declaredBashMs)
```

</details>

---

### 6. 并发性：sweep × delivery × container

三个东西可能同时碰 inbound.db / outbound.db：

|                       | inbound.db        | outbound.db        |
|-----------------------|-------------------|--------------------|
| host delivery loop    | read + write delivered | read-only         |
| host-sweep            | read + write (status, recurrence, retry) | read-only (除 reset 时 RW) |
| container agent-runner | read-only         | write             |

不变量：

1. **outbound.db 的 writer 永远只有 container**（除非 host 已经 kill 了容器才用 openOutboundDbRw）。
2. **inbound.db 的 writer 永远只有 host**（delivery + sweep + router 全在同 process）。

host 进程内多个路径写 inbound.db 怎么不冲突？better-sqlite3 是 synchronous，所有写都顺序执行。busy_timeout=5000 兜底跨 connection（每个 sweepSession 自己 openInboundDb 新 connection）。

`syncProcessingAcks` 的 transaction 把多条 UPDATE 包成一个 fsync，性能合理。

容器同时往 outbound.db 写 + host 读 outbound.db：DELETE journal 模式下 SQLite 用 file lock + busy_timeout。host 读 (`getDueOutboundMessages` / `getProcessingClaims`) 可能短暂 busy（容器在 commit），retry 几次就成功。5000ms timeout 给得很宽松。

---

### 7. 错误隔离

sweep 的容错策略层层包裹：

```
sweep()                              # 顶层 try/catch — 整个 sweep tick
  for session of getActiveSessions():
    try:
      await sweepSession(session)    # 单个 session 失败不影响其它
    except (理论上 sweepSession 不抛，看下面):
      log
```

但 `sweep()` 自己没把 for loop 里的 await 包 try/catch！看 `src/host-sweep.ts:132-145`：

```ts
async function sweep(): Promise<void> {
  if (!running) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await sweepSession(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}
```

只有一个外层 try/catch。这意味着 sweepSession 抛错会让**剩下的 session 这一 tick 不被处理**。下一个 tick 会从头扫所有 session，所以最坏每个 session 60s 跑一次没事，但**这一个 tick 的剩余 session** 全跳过了。

实际上 sweepSession 内部已经做了很多保护：
- agentGroup not found → return（不抛）。
- inboundDbPath 不存在 → return。
- openInboundDb fail → return。
- openOutboundDb fail → 继续（outDb 留 null）。

主要 try 块在 §4.1-4.6 之外有 finally 关 DB —— 但**没有** catch。这是有意的：如果某一步真出问题（比如 SQL 抛错），最好让 sweep 整个 tick 失败、让外层 catch log 出来、下一个 tick 重试。在中间吃掉错误反而会让真问题沉默。

`setTimeout(sweep, SWEEP_INTERVAL_MS)` 在 try 块**外面**，所以即使中间抛错，下一个 tick 也一定被排队 —— 不会因为一次错误让整个 sweep loop 永久挂掉。

`enforceRunningContainerSla` / `handleRecurrence` 内部的 try/catch (`src/modules/scheduling/recurrence.ts:46-52`)：

```ts
} catch (err) {
  log.error('Failed to compute next recurrence', {
    messageId: msg.id,
    recurrence: msg.recurrence,
    err,
  });
}
```

单条 recurrence 解析失败（比如 cron 表达式语法错），只 log 不抛，继续下一条。

---

### 8. 边界与陷阱

#### 8.1 sweep 和 delivery 共享 active session 但**不共享锁**

delivery 的 `inflightDeliveries` 锁只防 delivery 自己内部的双投。sweep 不参与那把锁。如果 sweep 调 wakeContainer 的同时 delivery 也在 drain 同一个 session 怎么办？

- wakeContainer 是 idempotent + 去重的（wakePromises）。
- sweep 不写 outbound.db（readonly），不影响 delivery 的 drainSession。
- sweep 写 inbound.db 的 syncProcessingAcks 把 status 改成 completed —— delivery 不读 status，只读 delivered 表。无冲突。

两者完全正交，所以不需要共享锁。

#### 8.2 sweep 内部串行

sweepSession 是 `for...await`，**串行**处理每个 session。500 个 session 每个平均 20ms 也要 10s 才跑完一轮。下个 tick 等 60s 之后再开始，不是 60s 间隔精准的 —— 实际间隔是 `60s + 上一轮总耗时`。

为什么不并行？
- inbound.db 的写虽然由 host 独占，但跨 session 的并行写会让 SQLite busy timeout 路径更复杂。
- wakeContainer 内部已经有 wakePromises 防并发，但启动一堆容器同时 spawn 会让 OneCLI gateway register 接 burst 请求。
- 当 active session 数变大时，问题更多体现在每个 session 自己的逻辑慢上，并行解决不了根本问题。

实际部署 active session 数通常 < 50，串行 sweep 完全够。

#### 8.3 process_after 用 SQLite 时间不是 JS Date.now

注意 `process_after` 字段用 SQLite 的 `datetime('now', '+N seconds')` (`src/db/session-db.ts:155`) 计算，对比也用 `datetime(process_after) <= datetime('now')` (`src/db/session-db.ts:142`)。这避免了 host 系统时钟 vs SQLite 时间的偏移问题 —— 都在 DB 上下文里完成。

但 sweep 里的 ceiling 检查 (`now - heartbeatMtimeMs`) 用的是 JS `Date.now()` 对比文件 mtimeMs。这两个都来自同一个 OS 时间源，不存在 DB vs JS 时间偏移问题。

`parseSqliteUtc` (`src/host-sweep.ts:57-59`) 处理 SQLite TIMESTAMP 列读出来时的时区：

```ts
export function parseSqliteUtc(s: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}
```

SQLite 的 `datetime('now')` 返回 "2026-05-24 10:00:00" 没时区标记。`Date.parse` 在 non-UTC host 上会当本地时间解释 → 计算的 age 偏移 N 小时（取决于 TZ）。手动补 `'Z'` 强制按 UTC 解释。

这个 bug fix 来自之前一次 UTC+8 上 sweep 把刚 claim 1 秒的消息算成 28800s old 然后立刻 kill 容器的事故。`src/host-sweep.ts:50-56` 注释明确写了：

> SQLite TIMESTAMP columns store UTC without a timezone marker. Date.parse treats timezoneless ISO strings as local time, so on non-UTC hosts every timestamp looks (TZ offset) hours stale — leading to spurious kill-claim decisions on freshly-claimed messages.

#### 8.4 ABSOLUTE_CEILING 和 declaredBashMs 的 `Math.max`

```ts
const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0);
```

只**放宽**，不**收紧**。Bash 声明 10s timeout 不会让 ceiling 变成 10s —— 即使 Bash 早就该结束了，30 分钟仍然是底线。

理由：Bash timeout 是 agent 的提示，不是真的运行时上限。脚本可能在 setTimeout 之外的事件里完成（比如 background process detach）。host 不该比 agent 自己声明的更严格。

#### 8.5 OneCLI long poll 不是 sweep 的事

注意 OneCLI approval long poll 不进 host-sweep。它在 `src/modules/approvals/onecli-approvals.ts:92-100` 直接挂在 OneCLI SDK 的 `configureManualApproval` 上，是一个独立的 push 流。host-sweep 不轮询 OneCLI 状态。

OneCLI 兜底的 sweep 是 startup 时 `sweepStaleApprovals` (`src/modules/approvals/onecli-approvals.ts:247-255`)，只跑一次清掉前一进程残留。后续 OneCLI 那条链路全靠 long poll + in-memory Promise 跑（参见第 9 章 §10.3）。

#### 8.6 没有 orphan session dir cleanup

第 1 章设计要求里提过 "长时间无活动的 session 目录、确认 container 已 stop、关闭 DB 连接"。但实际代码里 host-sweep **没有这个步骤**。session 目录长时间堆积是用户/admin 责任 —— 提供了 `ncl session archive` CLI 命令让用户主动归档，不会自动清。

这是有意的：自动清理 session 数据风险很高（万一用户漏归档了三个月前的对话，自动清掉就丢了对话历史）。把决定权留给用户。

#### 8.7 reload after config change

agent 用 self-mod 调过 `install_packages` / `add_mcp_server` 后，新配置在下一次容器 wake 时通过 `materializeContainerJson` (`src/container-runner.ts:127`) 重新生成 container.json 来 pickup —— **不依赖** sweep。

sweep 在这种情况下的作用：on-wake message（kind=on_wake 的 messages_in 行，trigger=0 不主动 wake，但 wake 时 container 看到）会在下次 wake 时被读到。sweep 不需要做任何额外的事 —— 它只是让 wake 在 due 时按时发生。

---

### 9. 测试入口

`src/host-sweep.test.ts` 是 sweep 的测试集。重点：

- `decideStuckAction` 是 pure function (`src/host-sweep.ts:82-118`) —— 测试时直接 mock 4 个输入跑各种边界。
- `_resetStuckProcessingRowsForTesting` (`src/host-sweep.ts:264-271`) 暴露内部函数允许测试时绕过 openOutboundDbRw 路径（测试环境的 DB 句柄已经是 RW）。

测出来的 bug 历史包括：
- `parseSqliteUtc` 时区 fix（§8.3）。
- ceiling 跳过 heartbeat 不存在 case（避免新容器立刻被 kill）。
- 先 wake 再 reset 顺序（避免 dueCount 永远 0 卡死）。
- deleteOrphanProcessingClaims 必须紧跟 killContainer（避免新容器被旧 claim 误判）。

---

### 10. 总结

<svg viewBox="0 0 820 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="sweepSession five-step pipeline running every 60 seconds per active session"><defs><marker id="ar10b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="410" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">sweepSession(session) — 60 秒一轮的 5 步流水线</text><g><rect x="40" y="50" width="200" height="60" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="140" y="72" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">open inbound.db (RW)</text><text x="140" y="92" text-anchor="middle" font-size="10" fill="#64748b">不存在则 return — 兜底</text></g><g><rect x="580" y="50" width="200" height="60" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="680" y="72" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">open outbound.db (RO)</text><text x="680" y="92" text-anchor="middle" font-size="10" fill="#64748b">不存在则跳过 §1/3/4/5</text></g><g><rect x="40" y="135" width="740" height="50" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/><text x="60" y="155" font-size="12" font-weight="700" fill="#7c3aed">1. syncProcessingAcks</text><text x="60" y="172" font-size="11" fill="#64748b">读 outbound.processing_ack(status=completed/failed) → UPDATE inbound.messages_in.status</text><text x="760" y="164" text-anchor="end" font-size="10" fill="#94a3b8">事务批量提交</text></g><g><rect x="40" y="195" width="740" height="50" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/><text x="60" y="215" font-size="12" font-weight="700" fill="#16a34a">2. dueCount &gt; 0 &amp;&amp; !alive → wakeContainer</text><text x="60" y="232" font-size="11" fill="#64748b">countDueMessages: pending AND trigger=1 AND process_after &lt;= now — 先 wake 再 stuck</text></g><g><rect x="40" y="255" width="740" height="50" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/><text x="60" y="275" font-size="12" font-weight="700" fill="#dc2626">3. alive → enforceRunningContainerSla</text><text x="60" y="292" font-size="11" fill="#64748b">heartbeat mtime + claim age + container_state.bash_timeout → kill-ceiling / kill-claim</text></g><g><rect x="40" y="315" width="740" height="50" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/><text x="60" y="335" font-size="12" font-weight="700" fill="#dc2626">4. !alive → resetStuckProcessingRows</text><text x="60" y="352" font-size="11" fill="#64748b">crashed container 留下的 claim：retryWithBackoff (5/10/20/40/80s) · MAX_TRIES=5 后 failed</text></g><g><rect x="40" y="375" width="740" height="50" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="60" y="395" font-size="12" font-weight="700" fill="#7c3aed">5. handleRecurrence (dynamic import)</text><text x="60" y="412" font-size="11" fill="#64748b">完成的 recurring task → cron-parser 算 next_run → INSERT 新行 (series_id 串起来)</text></g><g><rect x="220" y="430" width="380" height="22" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/><text x="410" y="446" text-anchor="middle" font-size="11" fill="#64748b">finally: inDb.close() · outDb?.close()</text></g><line x1="140" y1="110" x2="140" y2="135" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10b)"/><line x1="680" y1="110" x2="680" y2="135" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar10b)"/></svg>
<span class="figure-caption">图 R10.2 ｜ sweepSession 每 60 秒一轮的 5 步流水线：ack 同步 → wake → stuck 检测 → crashed cleanup → recurrence；颜色对应 §4 的源代码段。</span>

<details>
<summary>ASCII 原版</summary>

```
host-sweep (60s)
  for session in getActiveSessions():
    sweepSession(session):
      open inDb (writable)
      open outDb (readonly, optional)
      ┌────────────────────────────────────────────────────┐
      │ 1. syncProcessingAcks                              │ 把 container 写的 ack 同步到 inbound.status
      │ 2. dueCount > 0 && !alive → wakeContainer          │ schedule 落地、用户回复落地
      │ 3. alive → enforceRunningContainerSla              │ ceiling + claim-stuck → kill + reset
      │ 4. !alive → resetStuckProcessingRows               │ crashed-container backoff/fail
      │ 5. handleRecurrence                                │ cron 下一次实例
      └────────────────────────────────────────────────────┘
      close DBs
```

</details>

5 个步骤 60s 跑一遍，覆盖所有"非事件驱动"的兜底逻辑：
- container 死活监控
- 定时 / 周期任务的触发
- ack 状态同步
- 失败重试 + backoff
- orphan claim 清理

不变量：
1. 永远不写 outbound.db，除非刚 kill 容器（用 openOutboundDbRw 临时）。
2. wake 先于 reset，让 container 有机会自清理。
3. 内部错误隔离到 session 级，sweep loop 不挂。
4. 与 delivery loop 完全解耦：不共享锁、读写区域不重叠。

延伸阅读：
- 第 4 章：container-runner 的 spawn / kill 细节。
- 第 6 章：两库分写不变量。
- 第 7 章：消息流总览（inbound → container → outbound → delivery → user）。
- 第 9 章：delivery loop 的并发模型（pollActive 1s + pollSweep 60s）。
- 第 12 章：scheduling 模块的 task DB 设计 + cron 解析。
