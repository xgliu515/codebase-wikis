# Addendum 02a: Cron Scheduler Implementation

Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## The question

> "OpenClaw can run scheduled tasks — daily summaries, hourly weather pings, one-shot 'remind me in 20 minutes' jobs. How is that built? Is it cron-the-program, a CRON daemon hook, or something custom in-process?"

The answer is **none of the standard options**: there is no system `crond` involvement, no `node-cron` library, no external scheduler. Cron is a first-class subsystem owned by the gateway, living entirely in-process inside `src/cron/`. It uses the [`croner`](https://github.com/Hexagon/croner) library only as a *parser/iterator* for cron expressions; everything else — persistence, fire loop, drift handling, delivery, failure semantics — is OpenClaw code. Three job kinds are supported (`at`, `every`, `cron`), all of them are stored on disk, and the same `armTimer`/`onTimer` loop drives all of them.

This addendum walks the implementation in the order someone reading the code for the first time would want: where it lives, the schedule format, how it persists, the fire loop, dispatch into the agent, timezone and failure handling, and how to inspect it at runtime.

## Where it lives

```
src/cron/
  service.ts                   # public CronService class (thin facade)
  service-contract.ts          # interface
  schedule.ts                  # croner integration, next-fire math
  parse.ts                     # absolute-time parsing for `at` jobs
  store.ts                     # JSON persistence with state/config split
  types.ts                     # CronJob, CronSchedule, CronDelivery, ...
  persisted-shape.ts           # on-disk vs in-memory split
  delivery.ts, delivery-plan.ts, delivery-context.ts
  service/
    state.ts                   # CronServiceState (the mutable runtime)
    ops.ts                     # start/stop/list/add/update/remove/run
    timer.ts                   # armTimer, onTimer, executeJobCoreWithTimeout
    jobs.ts                    # nextWakeAtMs, createJob, recomputeNextRuns
    locked.ts                  # single-flight mutex around state
    normalize.ts, schedule-identity.ts, stagger.ts, ...
  isolated-agent/
    isolated-agent.ts          # runs an isolated agent turn for cron jobs
```

The CLI surface lives separately in `src/cli/cron-cli/` (the `openclaw cron` commands) and the WebSocket RPC surface in `src/gateway/server-methods/cron.ts`. Both are thin wrappers that delegate to the `CronService` API.

The gateway wires the service up *lazily* through `createLazyGatewayCronState` (`src/gateway/server-cron-lazy.ts:18`), so the in-memory state is constructed only when the first method that needs it is called. The service's actual start (loading the store, computing first nextRunAtMs values, arming the timer) happens during the post-attach phase of gateway startup (Chapter 02 §4) — never on the request hot path.

## The schedule expression format

`CronSchedule` is a tagged union (`src/cron/types.ts:7`):

```ts
// src/cron/types.ts:7
export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | {
      kind: "cron";
      expr: string;
      tz?: string;
      /** Optional deterministic stagger window in milliseconds (0 keeps exact schedule). */
      staggerMs?: number;
    };
```

Three job kinds:

1. **`at`** — fire once at an absolute time. `at` is a string parsed by `parseAbsoluteTimeMs`. Accepted shapes: `"1716528000000"` (epoch ms), `"2026-05-24"` (date → midnight UTC), `"2026-05-24T07:00:00"` (no zone → UTC), `"2026-05-24T07:00:00+09:00"` (explicit offset), `"2026-05-24T07:00:00Z"` (literal Z). The parser is `src/cron/parse.ts`:

```ts
// src/cron/parse.ts:18
export function parseAbsoluteTimeMs(input: string): number | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  const parsed = Date.parse(normalizeUtcIso(raw));
  return Number.isFinite(parsed) ? parsed : null;
}
```

2. **`every`** — fire every `everyMs`, optionally aligned to `anchorMs`. If the anchor is omitted, the job's creation time is used. This is the "remind me every 90 minutes" mode.

3. **`cron`** — a standard 5-field or 6-field-with-seconds cron expression, optionally pinned to a timezone. `croner` is used to evaluate it.

There is *no* parser-level support for human strings like "every 5 minutes" or "at 3pm" in the gateway — that's a CLI concern, handled by `src/cli/cron-cli/schedule-options.ts` before the schedule reaches `CronService.add`.

The `staggerMs` field on cron jobs is OpenClaw-specific: it spreads otherwise-identical hourly/daily schedules over a deterministic window to avoid a thundering herd at the top of the hour when many jobs run. The implementation lives in `src/cron/service/stagger.ts`.

## Persistence

The cron store is two files, not one. `src/cron/store.ts:35-40`:

```ts
function resolveStatePath(storePath: string): string {
  if (storePath.endsWith(".json")) {
    return storePath.replace(/\.json$/, "-state.json");
  }
  return `${storePath}-state.json`;
}
```

So the default `~/.openclaw/cron/jobs.json` is paired with `~/.openclaw/cron/jobs-state.json`. The split is intentional:

- `jobs.json` holds the **declarative** part: id, schedule, name, agent id, session target, payload, delivery target. Edited by hand or by `openclaw cron add/edit`.
- `jobs-state.json` holds the **runtime** part: `nextRunAtMs`, last run outcome, `runningAtMs` marker, last delivery status, last error.

If the schedule changes (detected via `scheduleIdentity`), the runtime entry is invalidated:

```ts
// src/cron/store.ts:200
function mergeStateFileEntry(job: CronStoreFile["jobs"][number], entry: unknown): void {
  if (!isRecord(entry)) {
    backfillMissingRuntimeFields(job);
    return;
  }
  job.updatedAtMs = resolveUpdatedAtMs(job, entry.updatedAtMs);
  job.state = isRecord(entry.state) ? (entry.state as never) : ({} as never);
  if (
    typeof entry.scheduleIdentity === "string" &&
    entry.scheduleIdentity !== tryCronScheduleIdentity(job as unknown as Record<string, unknown>)
  ) {
    ensureJobStateObject(job);
    job.state.nextRunAtMs = undefined;
  }
}
```

This is the on-disk equivalent of "if you change `every 5m` to `every 10m`, immediately recompute the next fire time from now, do not keep the stale schedule's countdown."

Both files are written through `replaceFileAtomic` (rename-into-place) so a crash mid-write cannot corrupt either file. `loadCronStore` and `loadCronStoreSync` both auto-migrate legacy inline-state job rows.

## The trigger loop

The scheduler is a single ref'd `setTimeout` rearmed after every tick. That timer lives in `state.timer` and is set by `armTimer` (`src/cron/service/timer.ts:1118`):

```ts
// src/cron/service/timer.ts:1118
export function armTimer(state: CronServiceState) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (!state.deps.cronEnabled) {
    state.deps.log.debug({}, "cron: armTimer skipped - scheduler disabled");
    return;
  }
  const nextAt = nextWakeAtMs(state);
  if (!nextAt) {
    // ... fall back to a 60s maintenance recheck if any jobs are enabled
    return;
  }
  const now = state.deps.nowMs();
  const delay = Math.max(nextAt - now, 0);
  // Floor: when the next wake time is in the past (delay === 0), enforce a
  // minimum delay to prevent a tight setTimeout(0) loop. ...
  const flooredDelay = delay === 0 ? MIN_REFIRE_GAP_MS : delay;
  // Wake at least once a minute to avoid schedule drift and recover quickly
  // when the process was paused or wall-clock time jumps.
  const clampedDelay = Math.min(flooredDelay, MAX_TIMER_DELAY_MS);
  state.timer = setTimeout(() => {
    void onTimer(state).catch((err) => {
      state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
    });
  }, clampedDelay);
}
```

Three constants drive the loop:

| Constant | Value | Purpose |
|----------|-------|---------|
| `MIN_REFIRE_GAP_MS` | `2_000` (line 81) | Floor for past-due jobs; prevents `setTimeout(0)` hot loops |
| `MAX_TIMER_DELAY_MS` | `60_000` (line 68) | Ceiling; re-evaluate at least every minute |
| `CRON_EVAL_CACHE_MAX` | `512` (`schedule.ts:6`) | Compiled-expression LRU cache size |

The 60-second ceiling is the drift fix. If wall-clock time jumps forward (NTP sync, laptop suspend/resume) the scheduler would otherwise sleep past its target. Re-evaluating every minute keeps drift bounded to roughly one minute.

The hot-loop floor (`MIN_REFIRE_GAP_MS = 2s`) is documented in a comment that is worth reading in full:

```ts
// src/cron/service/timer.ts:1150
// Floor: when the next wake time is in the past (delay === 0), enforce a
// minimum delay to prevent a tight setTimeout(0) loop. This can happen
// when a job has a stuck runningAtMs marker and a past-due nextRunAtMs:
// findDueJobs skips the job (blocked by runningAtMs), while
// recomputeNextRunsForMaintenance intentionally does not advance the
// past-due nextRunAtMs (per #13992). The finally block in onTimer then
// re-invokes armTimer with delay === 0, creating an infinite hot-loop
// that saturates the event loop and fills the log file to its size cap.
```

This is a recurring pattern in long-running daemons: any path where "no work to do this tick" rearms the timer at delay 0 will eventually meltdown. The 2 s floor is cheap insurance.

### `nextWakeAtMs`

The earliest pending fire is just a min-reduce over enabled jobs (`src/cron/service/jobs.ts:653`):

```ts
// src/cron/service/jobs.ts:653
export function nextWakeAtMs(state: CronServiceState) {
  const jobs = state.store?.jobs ?? [];
  const enabled = jobs.filter((j) => j.enabled && hasScheduledNextRunAtMs(j.state.nextRunAtMs));
  if (enabled.length === 0) return undefined;
  const first = enabled[0]?.state.nextRunAtMs;
  if (!hasScheduledNextRunAtMs(first)) return undefined;
  return enabled.reduce((min, j) => {
    const next = j.state.nextRunAtMs;
    return hasScheduledNextRunAtMs(next) ? Math.min(min, next) : min;
  }, first);
}
```

The `nextRunAtMs` itself is computed by `computeNextRunAtMs` (`src/cron/schedule.ts:68`), which is the only place all three schedule kinds meet:

```ts
// src/cron/schedule.ts:68
export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (schedule.kind === "at") {
    const sched = schedule as { at?: string; atMs?: number | string };
    const atMs = /* ... defensive parse ... */;
    if (atMs === null) return undefined;
    return atMs > nowMs ? atMs : undefined;
  }
  if (schedule.kind === "every") {
    const everyMsRaw = coerceFiniteScheduleNumber(schedule.everyMs);
    if (everyMsRaw === undefined) return undefined;
    const everyMs = Math.max(1, Math.floor(everyMsRaw));
    const anchorRaw = coerceFiniteScheduleNumber(schedule.anchorMs);
    const anchor = Math.max(0, Math.floor(anchorRaw ?? nowMs));
    if (nowMs < anchor) return anchor;
    const elapsed = nowMs - anchor;
    const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
    return anchor + steps * everyMs;
  }
  // schedule.kind === "cron":
  const cron = resolveCronFromSchedule(/* ... */);
  if (!cron) return undefined;
  let next = cron.nextRun(new Date(nowMs));
  if (!next) return undefined;
  let nextMs = next.getTime();
  if (!Number.isFinite(nextMs)) return undefined;
  // Workaround for croner year-rollback bug: some timezone/date combinations
  // (e.g. Asia/Shanghai) cause nextRun to return a timestamp in a past year.
  if (nextMs <= nowMs) {
    // ... two retries from a slightly later reference point ...
  }
  return nextMs;
}
```

The "croner year-rollback" workaround is the kind of bug-found-by-users you only learn about from production. The hint is that the comment names a specific timezone — that user filed an issue.

## Startup catch-up: jobs that missed their fire

If the gateway was down when a job was supposed to run, the missed fires need a policy. Naively "run them all immediately on startup" floods the model. `CronService.start` implements a controlled catch-up (`src/cron/service/ops.ts:163`):

```ts
// src/cron/service/ops.ts:163
export async function start(state: CronServiceState) {
  if (!state.deps.cronEnabled) {
    state.deps.log.info({ enabled: false }, "cron: disabled");
    return;
  }
  const interruptedJobIds = new Set<string>();
  const interruptedRuns: InterruptedStartupRun[] = [];
  let markedAnyInterruptedRun = false;
  await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    const jobs = state.store?.jobs ?? [];
    for (const job of jobs) {
      job.state ??= {};
      if (typeof job.state.runningAtMs === "number") {
        // The previous gateway died mid-run for this job.
        const interrupted = markInterruptedStartupRun({/* ... */});
        interruptedJobIds.add(job.id);
        interruptedRuns.push(interrupted);
        markedAnyInterruptedRun = true;
      }
    }
    // ... persist
  });
  await runMissedJobs(state, {
    skipJobIds: interruptedJobIds.size > 0 ? interruptedJobIds : undefined,
    deferAgentTurnJobs: true,
  });
  await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    const changed = recomputeNextRunsForMaintenance(state, { recomputeExpired: true });
    if (changed) await persist(state);
    // ... emit "finished" events for interrupted runs with STARTUP_INTERRUPTED_ERROR
    armTimer(state);
  });
}
```

Two policies meet here:

- **Interrupted runs** (jobs with a non-null `runningAtMs` on startup) are recorded as failed with reason `STARTUP_INTERRUPTED_ERROR`, not re-run. This prevents accidentally double-firing if the previous process died after running but before clearing the marker.
- **Missed-but-not-running jobs** go through `runMissedJobs`, which staggers them according to `missedJobStaggerMs` (defaults wired in `src/cron/service/state.ts:65-79`) and caps the immediate burst at `maxMissedJobsPerRestart`. Agent-turn jobs are *deferred* via `deferAgentTurnJobs: true` so the channel connect window is not crowded.

The dependency interface for those policies is in `src/cron/service/state.ts:50`. Defaults come from the gateway config (`config.cron.*`).

## Dispatching a fired job

When `onTimer` finds due jobs, each one runs through `executeJobCoreWithTimeout` (`src/cron/service/timer.ts:159`) which dispatches to one of three lanes depending on the job's payload kind:

- **`systemEvent`** — calls `enqueueSystemEvent` and `requestHeartbeat`, asking the heartbeat runner to wake the main session.
- **`message`** to a known session — same path, scoped to a specific `sessionKey`.
- **`agentTurn`** — calls `deps.runIsolatedAgentJob`, which the gateway wires up in `src/gateway/server-cron.ts:357`:

```ts
// src/gateway/server-cron.ts:357
runIsolatedAgentJob: async ({
  job, message, abortSignal, onExecutionStarted, onExecutionPhase,
}) => {
  const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
  const sessionKey = resolveCronSessionTargetSessionKey(job.sessionTarget) ?? `cron:${job.id}`;
  try {
    return await runCronIsolatedAgentTurn({
      cfg: runtimeConfig, deps: params.deps, job, message, abortSignal,
      onExecutionStarted, onExecutionPhase, agentId, sessionKey, lane: "cron",
    });
  } finally {
    await cleanupBrowserSessionsForLifecycleEnd({
      sessionKeys: [sessionKey],
      onWarn: (msg) => cronLogger.warn({ jobId: job.id }, msg),
    });
  }
},
```

That is the bridge from the cron orchestrator into agent execution (Chapter 07): a fresh isolated session keyed by `cron:<jobId>`, the message is the job's prompt, lane `"cron"` so the lane concurrency policy kicks in, and the entire session is torn down after the run completes (no browser/MCP leaks across cron fires).

After the agent finishes, the result is fed into `resolveDeliveryState` which decides whether to:

- emit an `announce` to the configured channel (telegram, slack, ...);
- POST a webhook with a signed payload;
- skip delivery entirely (`mode: "none"`).

The complete delivery surface is in `src/cron/delivery.ts` and `src/cron/service/timer.ts:598` (`resolveDeliveryState`).

## The dispatch flow

<svg viewBox="0 0 760 410" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="cron fire and dispatch flow">
<rect x="0" y="0" width="760" height="410" fill="#f1f5f9"/>
<rect x="20" y="20" width="720" height="370" fill="#ffffff" stroke="#cbd5e1"/>
<text x="380" y="46" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="700" fill="currentColor">Cron fire loop &amp; dispatch</text>
<rect x="40" y="70" width="240" height="44" fill="#fed7aa" stroke="#ea580c"/>
<text x="160" y="90" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="700" fill="#7c2d12">armTimer(state)</text>
<text x="160" y="106" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#7c2d12">delay = clamp(nextWakeAtMs - now)</text>
<line x1="280" y1="92" x2="320" y2="92" stroke="#64748b" stroke-width="2" marker-end="url(#aC)"/>
<rect x="320" y="70" width="180" height="44" fill="#fed7aa" stroke="#ea580c"/>
<text x="410" y="90" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="700" fill="#7c2d12">setTimeout fires</text>
<text x="410" y="106" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#7c2d12">-> onTimer(state)</text>
<line x1="500" y1="92" x2="540" y2="92" stroke="#64748b" stroke-width="2" marker-end="url(#aC)"/>
<rect x="540" y="70" width="180" height="44" fill="#fed7aa" stroke="#ea580c"/>
<text x="630" y="90" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="700" fill="#7c2d12">findDueJobs</text>
<text x="630" y="106" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#7c2d12">filter by nextRunAtMs &lt;= now</text>
<line x1="630" y1="114" x2="630" y2="135" stroke="#64748b" stroke-width="2" marker-end="url(#aC)"/>
<rect x="40" y="135" width="680" height="46" fill="#99f6e4" stroke="#0d9488"/>
<text x="60" y="156" font-family="sans-serif" font-size="12" font-weight="700" fill="#134e4a">for each due job: executeJobCoreWithTimeout(job)</text>
<text x="60" y="173" font-family="sans-serif" font-size="11" fill="#134e4a">- mark runningAtMs, persist  |  - resolve payload kind  |  - watchdog timeout per lane</text>
<line x1="160" y1="181" x2="160" y2="200" stroke="#64748b" stroke-width="2" marker-end="url(#aC)"/>
<line x1="380" y1="181" x2="380" y2="200" stroke="#64748b" stroke-width="2" marker-end="url(#aC)"/>
<line x1="600" y1="181" x2="600" y2="200" stroke="#64748b" stroke-width="2" marker-end="url(#aC)"/>
<rect x="40" y="200" width="220" height="50" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="150" y="220" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="700" fill="#4c1d95">systemEvent</text>
<text x="150" y="237" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#4c1d95">enqueueSystemEvent +</text>
<text x="150" y="250" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#4c1d95">requestHeartbeat</text>
<rect x="270" y="200" width="220" height="50" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="380" y="220" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="700" fill="#4c1d95">message</text>
<text x="380" y="237" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#4c1d95">scoped to sessionKey;</text>
<text x="380" y="250" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#4c1d95">deliver via channel</text>
<rect x="500" y="200" width="220" height="50" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="610" y="220" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="700" fill="#4c1d95">agentTurn</text>
<text x="610" y="237" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#4c1d95">runIsolatedAgentJob -&gt;</text>
<text x="610" y="250" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#4c1d95">isolated agent session</text>
<line x1="150" y1="250" x2="150" y2="275" stroke="#64748b" stroke-width="2" marker-end="url(#aC)"/>
<line x1="380" y1="250" x2="380" y2="275" stroke="#64748b" stroke-width="2" marker-end="url(#aC)"/>
<line x1="610" y1="250" x2="610" y2="275" stroke="#64748b" stroke-width="2" marker-end="url(#aC)"/>
<rect x="40" y="275" width="680" height="44" fill="#f0fdf4" stroke="#16a34a"/>
<text x="60" y="294" font-family="sans-serif" font-size="12" font-weight="700" fill="#14532d">resolveDeliveryState -&gt; announce / webhook / none; record outcome on job.state</text>
<text x="60" y="311" font-family="sans-serif" font-size="11" fill="#14532d">emitJobFinished -&gt; broadcast("cron", event) to subscribed clients; failure alert path on errors</text>
<line x1="380" y1="319" x2="380" y2="340" stroke="#64748b" stroke-width="2" marker-end="url(#aC)"/>
<rect x="40" y="340" width="680" height="36" fill="#fef2f2" stroke="#dc2626"/>
<text x="60" y="362" font-family="sans-serif" font-size="12" font-weight="700" fill="#991b1b">finally: clear runningAtMs, recompute nextRunAtMs, persist, armTimer() again</text>
<defs>
<marker id="aC" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#64748b"/></marker>
</defs>
</svg>
<span class="figure-caption">Figure R2a.1 | Cron's fire loop and three-way dispatch. The loop is a single ref'd setTimeout rearmed at the end of every tick.</span>
<details><summary>ASCII original</summary>

```
armTimer(state) -- delay = clamp(nextWakeAtMs - now)
   v
setTimeout fires -> onTimer(state) -> findDueJobs
   v
for each due job: executeJobCoreWithTimeout(job)
   |   - mark runningAtMs, persist
   |   - resolve payload kind: systemEvent | message | agentTurn
   |   - watchdog timeout per lane
   v
+--------+----------------+------------+
| sys ev | message scoped | agentTurn  |
+--------+----------------+------------+
            v
resolveDeliveryState -> announce / webhook / none
emitJobFinished -> broadcast("cron", event)
            v
finally: clear runningAtMs, recompute nextRunAtMs, persist, armTimer() again
```

</details>

## Timezone handling

Two layers handle TZ:

1. **`at` jobs**: parsed via `parseAbsoluteTimeMs`. A `Z` or explicit offset wins; a naked date/datetime defaults to UTC (`src/cron/parse.ts:5`). The store always holds an absolute ms epoch internally so the timezone is a CLI parsing concern, not a runtime concern.
2. **`cron` jobs**: the IANA tz string is passed straight through to `croner` via `resolveCronTimezone` (`src/cron/schedule.ts:9`):

```ts
// src/cron/schedule.ts:9
function resolveCronTimezone(tz?: string) {
  const trimmed = normalizeOptionalString(tz) ?? "";
  if (trimmed) return trimmed;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
```

If `tz` is omitted, the system's resolved timezone is used. The compiled `Cron` is then cached in an LRU keyed by `${tz} ${expr}` so a Daylight Saving boundary does not require recompiling expressions for the next year of fires.

## Failure semantics

The honest version: there is no automatic *retry* for a failed cron run. The job either succeeds, fails with `status: "error"`, or is skipped. What there *is* is:

- **Per-job timeout** (`executeJobCoreWithTimeout`, line 159). The watchdog (`createCronAgentWatchdog`, line 224) tracks the pre-execution and execution phases separately so a model bootstrap stall produces a different error message from a runaway turn.
- **Cleanup on timeout** (`cleanupTimedOutCronAgentRun`, line 338). The agent run is aborted, the session is force-cleared, and the next `nextRunAtMs` is computed normally. A daily job that times out today still fires tomorrow.
- **Failure-alert delivery** (line 717, `resolveFailureAlert` / `emitFailureAlert`). If the job's `delivery.failureDestination` is set, a structured failure message is sent to that alternate channel — for example, you can configure a "morning summary" cron to send its output to a Slack channel but its failure alerts to a DM.
- **Best-effort skip** (line 612, around `params.job.delivery?.bestEffort`). For best-effort deliveries, a transient channel error does not flip the run to `error` status.
- **Idempotent re-arm** (line 1049, the floor): even if every step of a job throws, the `finally` block rearms the timer at least `MIN_REFIRE_GAP_MS` later, so a single broken job cannot wedge the scheduler.

The full event stream — `added`, `updated`, `removed`, `started`, `finished` (with status, summary, delivery state) — is `CronEvent` (`src/cron/service/state.ts:21`). Every event also reaches connected clients via `broadcast("cron", evt, { dropIfSlow: true })` (`src/gateway/server-cron.ts:424`), which is how the web UI shows "next run in 4 minutes" without polling.

## Inspecting cron state at runtime

The CLI commands are `openclaw cron status | list | add | edit | remove | run`. They are not actually local — every command opens a WebSocket to the gateway and calls one of the `cron.*` RPCs, which are core methods declared in `src/gateway/server-methods/cron.ts`:

| RPC | Scope | Use |
|-----|-------|-----|
| `cron.status` (`cron.ts:237`) | `operator.read` | overall state, store path, jobs count, next wake at |
| `cron.list` (`cron.ts:198`) | `operator.read` | enumerate jobs (sorted by `nextRunAtMs`) |
| `cron.get` (`cron.ts:252`) | `operator.read` | one job by id |
| `cron.add` (`cron.ts:285`) | `operator.admin` | create |
| `cron.update` (`cron.ts:362`) | `operator.admin` | patch |
| `cron.remove` (`cron.ts:457`) | `operator.admin` | delete |
| `cron.run` (`cron.ts:485`) | `operator.write` | force-run a job now, regardless of due time |
| `cron.runs` (`cron.ts:519`) | `operator.read` | run history |

So the fastest path from a user question ("did my 7 AM weather brief actually fire?") to an answer is `openclaw cron status --json` followed by `openclaw cron list --json`; both return the live in-memory state. If the gateway is not running, the same data is in `~/.openclaw/cron/jobs.json` and `~/.openclaw/cron/jobs-state.json` — and the `nextRunAtMs` in the state file is exactly what `armTimer` was about to use when the process stopped.
