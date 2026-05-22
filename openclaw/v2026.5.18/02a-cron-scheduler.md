## 1. 整体定位与对象模型

CronService 是 Gateway 内嵌的单进程定时调度器：父章节 §1-§3 已经讲过它作为 `runtimeState.cronState` 句柄被 Gateway 持有、并在 close handler 里被释放——本文只展开「定时这件事本身怎么算、怎么烧、怎么落地」。

实现代码集中在 `src/cron/` 目录：`service.ts` 是 `CronService` 类的薄壳（`src/cron/service.ts:13`），把所有方法委托给 `src/cron/service/ops.ts` 里的纯函数；调度核心在 `src/cron/service/timer.ts`；下次时间计算在 `src/cron/service/jobs.ts`；锁、加载、落盘各拆一个文件。Gateway 通过 `src/gateway/server-cron.ts:115` 的 `buildGatewayCronService` 把它与会话、心跳、广播等基础设施缝合。

一个 `CronJob` 由三个正交的轴组成（`src/cron/types.ts:7-19`）：

- **`schedule`** 三选一：`{kind: "at", at: <ISO 时间字符串>}` 一次性、`{kind: "every", everyMs, anchorMs?}` 等间隔、`{kind: "cron", expr, tz?, staggerMs?}` 标准 cron 表达式。
- **`sessionTarget`**：`"main"` / `"isolated"` / `"current"` / `` `session:<id>` `` 四种（`src/cron/types.ts:18`），决定任务落在哪个会话。`main` 是把任务作为 `systemEvent` 注入到默认 agent 的主会话，其它三种都开一个隔离 agent 子会话跑 `agentTurn`。
- **`wakeMode`**：`"now"` 立刻请一次 heartbeat 把消息消化掉、`"next-heartbeat"` 只把消息排队等下一次 heartbeat。

这三个轴在 `assertSupportedJobSpec`（`src/cron/service/jobs.ts:254`）里互相校验：`main + systemEvent`、`isolated/current/session: + agentTurn` 是仅有的两组合法组合；交叉传参直接抛 `Error`。

```ts
// src/cron/service/jobs.ts:267-272
if (job.sessionTarget === "main" && job.payload.kind !== "systemEvent") {
  throw new Error('main cron jobs require payload.kind="systemEvent"');
}
if (isIsolatedLike && job.payload.kind !== "agentTurn") {
  throw new Error('isolated/current/session cron jobs require payload.kind="agentTurn"');
}
```

之所以正交但要校验，是因为 `main` 走「往主会话喂一条系统提示」的轻路径，根本不需要新开 agent；而隔离任务必须是完整的 `agentTurn`（可带 model / fallbacks / tools allow-list），两条执行路径完全不同——见 §5。

## 2. 持久化：配置与运行时状态拆分

如果只用一个 `jobs.json` 把所有字段（含 `nextRunAtMs`、`runningAtMs`、`lastError` 等运行时计数）一起落盘，每次 timer 触发都改 `state`、都得重写整个文件，git 之类的外部工具看到的 diff 噪音特别大，配置审计形同虚设。Issue 历史里多次出现这个抱怨——于是 store 被拆成两份。

`src/cron/store.ts` 里的 `extractStateFile` 与 `stripRuntimeOnlyCronFields` 在落盘前把对象拆成两部分：

- **`jobs.json`**：配置部分（`id` / `schedule` / `payload` / `delivery` / `failureAlert` / `enabled` 等），写盘时 `state` 被替换为 `{}`、`updatedAtMs` 被去掉。
- **`jobs-state.json`**：以 `jobId` 为键的运行时状态（`updatedAtMs`、`state`、`scheduleIdentity`）。

加载时 `loadCronStore` 先读 `jobs.json` 得到一个空 state 的列表，再读 `jobs-state.json` 通过 `mergeStateFileEntry` 把状态合并回来；如果检测到 `jobs.json` 里还有内联 state（旧格式），就走 migration 模式继续工作但下次落盘会拆开。`scheduleIdentity`（`src/cron/schedule-identity.ts`）是 schedule 字段的指纹——它一变就把对应 job 的 `nextRunAtMs` 抹掉，避免「改了表达式还按旧时间触发」。

落盘走 `replaceFileAtomic`（`src/infra/replace-file.ts`）：写 tmp → fsync → rename。文件权限 0o600、目录 0o700，仅 owner 可读，因为 cron 任务的 payload 可能含敏感指令。`jobs.json.bak` 只在 config 真改了的时候才更新，state-only 写入跳过备份。

存储位置默认在 `~/.config/openclaw/cron/jobs.json`（`resolveDefaultCronStorePath` in `src/cron/store.ts`），可被 `cfg.cron.store` 覆盖；`OPENCLAW_SKIP_CRON=1` 让 `cronEnabled` 直接为 `false`（`src/gateway/server-cron.ts:122`），整个 service 进入只读 stub 模式。

## 3. 单 timer 调度内核

**朴素方案：每个 job 一个 `setTimeout(fn, nextRunAtMs - now)`。**
跑十几个 job 没问题，但 OpenClaw 期望支持成百上千个任务、热加载、wallclock 跳变（笔记本休眠醒来）、还要在 process 崩了之后恢复。每 job 一个 timer 既泄漏（job 删了 timer 怎么清？）又脆（休眠几小时回来全部错过）。

实际做法是**一个进程级 timer，永远只指向"最近的下一次"**——`armTimer`（`src/cron/service/timer.ts:1063`）：

```ts
// src/cron/service/timer.ts:1063-1119（节选）
export function armTimer(state: CronServiceState) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (!state.deps.cronEnabled) return;
  const nextAt = nextWakeAtMs(state);
  if (!nextAt) {
    if (enabledCount > 0) armRunningRecheckTimer(state);  // 维护性兜底
    return;
  }
  const delay = Math.max(nextAt - state.deps.nowMs(), 0);
  const flooredDelay = delay === 0 ? MIN_REFIRE_GAP_MS : delay;        // ① 2 秒地板
  const clampedDelay = Math.min(flooredDelay, MAX_TIMER_DELAY_MS);     // ② 60 秒天花板
  state.timer = setTimeout(() => { void onTimer(state).catch(...); }, clampedDelay);
}
```

两个常量都有具体的事故背景（`src/cron/service/timer.ts:57`、`:70`）：

- **`MAX_TIMER_DELAY_MS = 60_000`（60 秒天花板）**：即使下次触发还有 12 小时，timer 也最多睡 60 秒。每分钟醒一次有两个用处——一是 wallclock 跳变后能在 60 秒内追上正确时间；二是 `recomputeNextRunsForMaintenance` 有机会修正中间被改坏的 `nextRunAtMs`（外部工具直接改 `jobs-state.json` 是被支持的）。
- **`MIN_REFIRE_GAP_MS = 2_000`（2 秒地板）**：当 `nextRunAtMs` 已经过期 (`delay === 0`) 而 `findDueJobs` 又因 stuck `runningAtMs` 跳过它时，朴素实现会 `setTimeout(0)` 进入热循环把 event loop 烧掉、把日志撑爆（issue #13992）。地板保证哪怕循环上界还在错状态里，CPU 也不会被烧。

`onTimer`（`src/cron/service/timer.ts:1132`）的关键不变量是「同一时刻只能有一个 tick 在跑」：进入时若 `state.running === true` 就直接 `armRunningRecheckTimer(state)` 再返回——长任务（一次 agentTurn 可以跑十分钟）期间 timer 也要继续 ping 60 秒兜底，否则一旦 60s clamp 在 running 状态下被早期 `return` 掉，scheduler 就死了（issue #12025）。

操作互斥靠 `src/cron/service/locked.ts:11` 的 `locked` 函数实现：以 `storePath` 为键挂一条 Promise 链，`add`/`update`/`remove`/`run`/`onTimer` 全部排队走它，避免文件并发写、内存状态错乱。

```ts
// src/cron/service/locked.ts:11-21
export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const storeOp = storeLocks.get(state.deps.storePath) ?? Promise.resolve();
  const next = Promise.all([resolveChain(state.op), resolveChain(storeOp)]).then(fn);
  const keepAlive = resolveChain(next);
  state.op = keepAlive;
  storeLocks.set(state.deps.storePath, keepAlive);
  return (await next) as T;
}
```

## 4. 下次触发时间：三种 schedule 的算法

`computeJobNextRunAtMs`（`src/cron/service/jobs.ts:350`）按 `schedule.kind` 三路分发；底层 `computeNextRunAtMs`（`src/cron/schedule.ts:73`）只负责纯函数级别的时间数学。

**`every`** 最简单：`nextFromLastRun = floor(lastRunAtMs) + everyMs`，如果在未来直接返回；否则按 `anchorMs` 和向上取整算下一个槽（`src/cron/service/jobs.ts:354-373`）。`anchorMs` 在 `createJob` 时确定（`src/cron/service/jobs.ts:676`），所以重启后步长不会因为加载时间漂移。

**`at`** 一次性：解析时间字符串到 ms（兼容旧的数字字段 `atMs` 和新的 ISO 字符串 `at`，`src/cron/service/jobs.ts:375-396`）；任务跑完 `ok` 之后只有当用户改了 `at` 到一个比 `lastRunAtMs` 更晚的时间才会重新激活——否则 `at` 任务永远只触发一次。

**`cron`** 表达式走 croner 库。三个值得关注的细节：

1. **LRU 缓存 croner 实例**（`src/cron/schedule.ts:7-37`）。`new Cron(expr, {timezone})` 不便宜，512 条 LRU 让 hot path 几乎零成本；key 包含 timezone 避免跨时区污染。
2. **年份回滚 workaround**（`src/cron/schedule.ts:117-140`）。某些 timezone（注释里点名 `Asia/Shanghai`）下 croner `nextRun` 会偶发返回上一年的时间；代码先尝试用 `nextSecondMs` 重算，仍然过期就用 UTC 明天 00:00 作为参考点再试，三次都失败就返回 `undefined`。这种 workaround 本身就是 problem-first 注释的活样本。
3. **每作业散列错峰（stagger）**（`src/cron/service/jobs.ts:65-112`）。如果 500 个 `cron` 任务都写 `0 * * * *`，整点同时烧 500 个 agentTurn 会把 LLM provider 配额打爆。`resolveStableCronOffsetMs` 用 `sha256(jobId)` 截 32 位、模 `staggerMs` 得到一个稳定的 per-job 偏移，把触发时间打散到一个窗口里：

   ```ts
   // src/cron/service/jobs.ts:86-111（节选）
   const offsetMs = resolveStableCronOffsetMs(job.id, staggerMs);
   let cursorMs = Math.max(0, nowMs - offsetMs);
   for (let attempt = 0; attempt < 4; attempt += 1) {
     const baseNext = computeNextRunAtMs(job.schedule, cursorMs);
     const shifted = baseNext + offsetMs;
     if (shifted > nowMs) return shifted;
     cursorMs = Math.max(cursorMs + 1, baseNext + 1_000);
   }
   ```

   `createJob` 会按表达式自动选一个默认 `staggerMs`（如分钟级表达式默认 stagger 几秒、小时级 stagger 几分钟）；同 ID 同 stagger 永远落在同一个偏移上，跨重启可预测。

`recomputeNextRuns`（`src/cron/service/jobs.ts:587`）只重算「缺失或已过期」的 `nextRunAtMs`，保留仍然在未来的值——这避免重启时把一个本来五分钟后该烧的 job 错误地推到下一周期。`recomputeNextRunsForMaintenance`（`src/cron/service/jobs.ts:611`）是 onTimer 在「没有 due job」时的兜底变体，专门处理 disabled 标记和卡住的 `runningAtMs`，但**默认不前进**已经过期的 `nextRunAtMs`——否则一个 stuck job 会被沉默地跳过（issue #13992）。

## 5. 任务执行：main 与 detached 的两条路径

`executeJobCore`（`src/cron/service/timer.ts:1615`）按 `sessionTarget` 分两路：

```ts
// src/cron/service/timer.ts:1660-1664
if (job.sessionTarget === "main") {
  return await executeMainSessionCronJob(state, job, abortSignal, waitWithAbort);
}
return await executeDetachedCronJob(state, job, abortSignal, resolveAbortError, options);
```

**main 路径**（`src/cron/service/timer.ts:1667`）只做两件事：(1) 用 `enqueueSystemEvent` 把 payload.text 注入主会话队列（带 `contextKey: "cron:<jobId>"` 便于审计去重）；(2) 视 `wakeMode` 触发 heartbeat。`wakeMode === "now"` 会**同步**调 `runHeartbeatOnce` 等结果——如果心跳因为 `requests-in-flight` 等可重试理由跳过，就以 `retryDelayMs` 间距重试、过 `wakeNowHeartbeatBusyMaxWaitMs`（默认 2 分钟）后降级为异步 `requestHeartbeat`：

```ts
// src/cron/service/timer.ts:1703-1751（节选）
for (;;) {
  heartbeatResult = await state.deps.runHeartbeatOnce({ source: "cron", intent: "immediate", ... });
  if (heartbeatResult.status !== "skipped"
      || !isRetryableHeartbeatBusySkipReason(heartbeatResult.reason)) break;
  if (heartbeatResult.reason === HEARTBEAT_SKIP_CRON_IN_PROGRESS) {
    // 主会话已有 cron 在跑——降级为异步请求避免互锁
    state.deps.requestHeartbeat({...}); return { status: "ok", summary: text };
  }
  if (state.deps.nowMs() - waitStartedAt > maxWaitMs) {
    state.deps.requestHeartbeat({...}); return { status: "ok", summary: text };
  }
  await waitWithAbort(retryDelayMs);
}
```

**detached 路径**（`src/cron/service/timer.ts:1777`）把任务全权委托给 `state.deps.runIsolatedAgentJob`——`buildGatewayCronService` 把它接到 `runCronIsolatedAgentTurn`（`src/cron/isolated-agent.ts` → `src/cron/isolated-agent/run.ts`）。它在 lane = `"cron"`、独立 sessionKey（`cron:<jobId>` 或 `session:<id>`）下跑一次完整 agent turn，支持 model override、fallbacks、tools allow-list、`lightContext` 等 payload 字段。返回值带 `summary` / `delivered` / `delivery` / `usage`，被 §7 的投递与广播消费。

两条路径都接 `AbortSignal`——它由 `executeJobCoreWithTimeout`（`src/cron/service/timer.ts:148`）持有的 `AbortController` 在 watchdog 触发或外层 timeout 到点时 abort。watchdog 比单一 wall-clock timeout 复杂，因为「整个 agent 没启动起来」（pre-execution）和「agent 在 model call 里卡住」（execution）应该用不同的容忍度，所以 watchdog 是个两阶段状态机（`waiting_for_runner` → `waiting_for_execution` → `executing`），不同阶段刷不同的截止时间：

- pre-execution 阶段（`CRON_AGENT_PRE_EXECUTION_WATCHDOG_MS = 60_000`）：等 runtime 起 agent。
- execution 阶段（`resolveCronAgentPreExecutionWatchdogMs`）：到 job 自带的 `timeoutSeconds`（payload 字段）或 `cronConfig.timeoutMs` 兜底。

超时触发后 `cleanupTimedOutCronAgentRun`（`src/cron/service/timer.ts:327`）调用 `state.deps.cleanupTimedOutAgentRun` 主动收口 embedded pi 子进程，避免「abort 了但 agent 还在跑」的资源泄漏。

## 6. 韧性：startup catchup、退避、自动 disable

cron 的故障模型有几个特定的坑，每个都对应代码里的一段防御。

**Startup 中断标记**：进程崩溃时若某 job 正在跑，磁盘上的 `runningAtMs` 是个非 `undefined` 值。`start`（`src/cron/service/ops.ts:163`）遍历所有 job，对这些「被中断」的运行调 `markInterruptedStartupRun` 写一条 `STARTUP_INTERRUPTED_ERROR` 历史进 state，并广播 `finished` 事件让 UI / 失败告警感知到。这避免「主进程 OOM 后 next cron tick 看见 runningAtMs 就永远跳过该 job」。

**Missed catchup 限流**：`runMissedJobs`（`src/cron/service/timer.ts:1412`）走 `planStartupCatchup` 收集所有 `nextRunAtMs <= now` 的 job，但**不全跑**：

- `DEFAULT_MAX_MISSED_JOBS_PER_RESTART = 5`（`:73`）只立刻跑前 5 个，其余打散到未来。
- `DEFAULT_MISSED_JOB_STAGGER_MS = 5_000`（`:72`）依次错峰，避免 5 个任务挤在同一毫秒。
- `deferAgentTurnJobs: true`（`:195` 的调用点）让 `agentTurn` 类型 missed job 至少推迟 `DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS = 120_000`（2 分钟，`:74`）——网关刚启动时各 channel 还在连接，立刻烧 model 容易抢资源。

历史背景写在 `state.ts:65-72` 的 doc-comment 里直接点了 issue 18892。

**指数退避**：`DEFAULT_ERROR_BACKOFF_SCHEDULE_MS = [30s, 60s, 5min, 15min, 60min]`（`src/cron/service/jobs.ts:41-47`），由 `errorBackoffMs(consecutiveErrors)` 按下标返回；超过表长就稳定在 60 分钟。`applyJobResult`（`src/cron/service/timer.ts:791`）把 `consecutiveErrors` 在每次失败时自增、成功或 skipped 清零，并取「自然下次时间」与「`endedAt + backoff`」的较大值：

```ts
// src/cron/service/timer.ts:938-966（节选）
} else if (result.status === "error" && isJobEnabled(job)) {
  const backoff = errorBackoffMs(job.state.consecutiveErrors ?? 1);
  const normalNext = computeJobNextRunAtMs(job, result.endedAt);
  const backoffNext = result.endedAt + backoff;
  job.state.nextRunAtMs = normalNext !== undefined ? Math.max(normalNext, backoffNext) : backoffNext;
}
```

**One-shot `at` 任务**的处理特别小心（`src/cron/service/timer.ts:891-937`）：

- `status === "ok"` 且 `deleteAfterRun === true`：删 job。
- `status === "ok"` 或 `"skipped"`：`enabled = false`、`nextRunAtMs = undefined`——绝不重排，避免 issue #11452 描述的「`computeJobNextRunAtMs` 返回过期的 `atMs` 导致紧凑循环」。
- `status === "error"` 且**可重试错误**（由 `isTransientCronError` 判定，结合 `cronConfig.retry.retryOn`）且未超过 `maxAttempts`：用 backoff 排一次重试（issue #24355）。
- 其它失败：disable 但**保留** job，方便 UI 显示错误状态。

**Cron 槽位自旋保护**：cron 类任务成功后也走一次 `MIN_REFIRE_GAP_MS = 2_000` 下界（`:990-1001`），因为 `computeStaggeredCronNextRunAtMs` 在 timezone 边界上偶尔会落回当前秒，没有这个保护就成自旋（issue #17821）。

**调度表达式自坏**：`recordScheduleComputeError`（`src/cron/service/jobs.ts:417`）把 `computeJobNextRunAtMs` 抛出的异常计数；累积 `MAX_SCHEDULE_ERRORS = 3` 次（`:415`）后自动 `enabled = false`——避免一个写错的表达式持续触发并产出错误日志。

**Stale job 检测**：`STUCK_RUN_MS = 2 * 60 * 60 * 1000`（`src/cron/service/jobs.ts:38`），任何 `runningAtMs` 老于这个值的标记会在 maintenance 里被清掉，假设进程崩了但 state 没刷新的极端情况。

## 7. 投递、失败告警与事件广播

任务跑完之后，结果要不要、怎么、向谁回话，由 `delivery` 字段决定（`src/cron/types.ts:24-43`）。`resolveDeliveryState` / `resolveCronDeliveryPlan`（`src/cron/delivery-plan.ts`，结构在 `delivery.ts`）从 `job.delivery` + 全局 `cronConfig.failureDestination` 合成出本次运行的：

- 主结果投递目标（`mode: "announce" | "webhook" | "none"`、`channel` / `to` / `accountId` / `threadId`）。
- 失败告警单独路由（`failureDestination`）——允许把"出错信息推给值班 Slack"和"正常运行结果推给业务群"分开。
- "isolated agent 自己已经投递过"识别（`delivered` 字段，issue #15692）——避免 agent 用消息工具发了一次、cron 框架又 announce 一次造成重复。

失败告警有冷却：`resolveFailureAlert`（`src/cron/service/timer.ts:667`）和 `maybeEmitFailureAlert`（`:749`）按 `consecutiveErrors >= alertConfig.after`（默认 2）触发，`lastFailureAlertAtMs + cooldownMs`（默认 1 小时）内不重复推；`includeSkipped: true` 时连续 `skipped` 也计入计数。

广播是 `onEvent` 回调（`src/cron/service/state.ts:145`）：每次 `added` / `updated` / `removed` / `started` / `finished` 都 emit 一个 `CronEvent`（`src/cron/service/state.ts:20-40`），含 `runId` / `model` / `provider` / `usage` / `diagnostics` / `delivery` trace。Gateway 在 `buildGatewayCronService` 把 `onEvent` 接到 `params.broadcast("cron", evt, { dropIfSlow: true })`——WebChat / TUI 通过 WS 订阅；同时 `finished` 事件追加到 `<storePath>/<jobId>.runs.jsonl`（`appendCronRunLog`，`src/cron/run-log.ts`），按 `runLog` 配置定期裁剪。

## 8. 接入面：Gateway 桥接、RPC、Tool、Plugin Hook

- **Gateway 桥接（`src/gateway/server-cron.ts:115` `buildGatewayCronService`）**：把 `CronService` 的依赖（heartbeat / enqueueSystemEvent / runIsolatedAgentJob / sendCronFailureAlert / cleanupTimedOutAgentRun）从 Gateway 现成的 helper 装配出来，并把 cron 事件接到 broadcast。它还把 `cron_changed` plugin hook（`PluginHookCronChangedEvent`）挂到 `add` / `update` / `remove` 的回调链上——外部插件可以监听任务变更（`runCronChangedHook`，`:272`）。
- **RPC**（`src/gateway/server-methods/cron.ts`）：把 `list` / `add` / `update` / `remove` / `run` / `status` / `wake` 暴露成 WS RPC，由 `src/gateway/protocol/schema/cron.ts` 定义 schema。Web UI（章节 12）的 `controllers/cron.ts` 和 `views/cron.ts` 就是这些方法的消费者。
- **Agent 工具 `cron`**（`src/agents/tools/cron-tool.ts`）：让 agent 自己创建/管理定时任务（典型用法：用户说"提醒我下午 3 点开会"，agent 调 `cron.add` 而不是 `sleep`）。tool prompt 注入里有一句强约束："Do not use exec sleep or delay loops for reminders or deferred follow-ups; use cron instead."（章节 09 §9.7）。tool 把 RPC 转给 Gateway，结果回流到当前 session。
- **CLI**（`src/cli/cron-cli.ts` + `src/cli/cron-cli/`）：`openclaw cron add` / `list` / `run` 等命令，背后还是同一套 RPC。
- **Plugin hook `cron_changed`**（父章节 §10.8.1 列举过的 hook 之一）：插件可以监听 cron 任务的增改删，用来做诸如「同步到外部日历」之类的集成。

## 9. 边角细节

- **`active-jobs.ts`**（`src/cron/active-jobs.ts`）：用 `Symbol.for("openclaw.cron.activeJobs")` 在 global 单例上挂一个 `Set<jobId>`，跑任务前 `markCronJobActive`、跑完 `clearCronJobActive`。`hasActiveCronJobs()` 被 §1 提过的 `setPreRestartDeferralCheck`（父章节 §2 提到）调用——只要还有 cron 在跑，gateway 热重启就会等它。
- **Session reaper 搭车**：`onTimer` 的 finally 里调 `sweepCronRunSessions`（`src/cron/session-reaper.ts`），自节流到每 5 分钟一次，把过期的 cron run sessions（`cron:<jobId>` / `session:<id>`）清掉，避免 isolated 任务的会话文件越攒越多。
- **`enqueueRun` 与 `run` 的区别**（`src/cron/service/ops.ts:840`、`:854`）：`run` 是同步阻塞跑到底（用于 `openclaw cron run --force` 之类），`enqueueRun` 把执行 enqueue 到 task runtime 并立即返回 `runId`（用于 Web UI 的"立刻执行"按钮，避免 RPC 长连接挂着等十分钟）。
- **`wake` 方法**（`src/cron/service.ts:75`、底层 `src/cron/service/timer.ts:1935`）：不是定时触发用的，而是给 agent 工具一条「直接往主会话喂一句系统消息并叫醒」的捷径——`cron` 工具的 `wake` action 就是它。语义和创建一个立即到期的 `at` job 等价但开销小、不落 store。
