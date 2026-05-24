# Tour Step 02: Gateway server starts listening

Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

The previous step ended with `runCli(argv)` about to be called from `src/entry.ts:154` → `src/entry.ts:294`. Inside `runCli`, the `gateway` argv shape is recognized by `isGatewayRunFastPathArgv` at `src/cli/run-main.ts:103`, the gateway fast path `tryRunGatewayRunFastPath` at `src/cli/run-main.ts:145` lazily imports `src/cli/gateway-cli/run-command.ts`, Commander matches the `gateway` (or `gateway run`) subcommand, and the `.action` callback awaits `runGatewayCommand` at `src/cli/gateway-cli/run.ts:472`.

What we hold in our hands at the start of this step: a live Node process; `process.title === "openclaw"`; parsed Commander options (`--port`, `--bind`, `--auth`, …); a `GatewayRunOpts` object; an empty event loop with nothing scheduled. What we **do not** hold: any open socket, any RPC registry, any plugin code loaded beyond the gateway entrypoints, any lock file on disk. This step is where all of that comes into existence.

By the end of this step the gateway is **listening on its bound port** (default `127.0.0.1:18789`), the gateway lock file is held in the pinned state directory, the RPC method registry has been constructed with `chat.send` registered at scope `operator.write`, all bundled-channel catalog entries have been read once, and the WebSocket connection handler is attached. No client is connected yet — that is the next step.

## 2. The problem

> Turn an empty Node process into a long-lived gateway that is **idempotent** (running `openclaw gateway` twice does the right thing instead of corrupting state), **crash-tolerant** (a previous gateway killed with `kill -9` left a lock file and possibly a port-in-use condition, both of which we must recover from), **deterministic about which state directory it owns** (the directory must be pinned at startup, not re-resolved on every read), and **kept alive by something more than a hanging promise** (Node otherwise exits with code 13 the instant the event loop becomes idle).

The problem is not "call `app.listen()`". The problem is that calling `app.listen()` at the wrong moment, with the wrong recovery semantics, breaks every operational property a gateway is expected to have.

## 3. Naive approach

Inline the boot inside `runGatewayCommand` as a straight line:

```js
const cfg = readConfigSync();
const server = http.createServer();
const wss = new WebSocketServer({ server });
wss.on("connection", handleConnection);
server.listen(cfg.port);
// keep alive
await new Promise(() => {});
```

One config read, one HTTP server, one WS server, one `listen`, one hanging promise to keep the process up. Maybe a `fs.writeFileSync(lockPath, String(process.pid))` to advertise that we own the port.

## 4. Why the naive approach breaks

Each of the simplifications collapses under a real operational scenario:

- **Second invocation races on the port.** The user starts a second `openclaw gateway` — by accident, or because they thought the first one was already dead. The naive entry calls `server.listen()` on a port the first instance owns. The error is `EADDRINUSE`, surfaced as a raw Node stack trace. The user has no idea another gateway is already on that port; they cannot tell whether to `kill` it, restart it, or wait. Worse, the second process has already spent a second or two loading config and plugins by the time `listen` fails; all that work is lost.
- **Stale lock zombies.** A previous gateway was killed with `kill -9`. The lock file remains, pointing at a PID that does not exist. The naive entry sees the file and refuses to start. The user has no way to recover except deleting the file manually — and they cannot tell the difference between "stale" and "actually running" without `ps`.
- **Partial-init wreckage on listen failure.** Even if `listen()` succeeds, what if loading a plugin throws right after? The HTTP socket is open, accepting connections, but no RPC registry is wired up. The first client to connect gets a `method not found` error for *every* RPC call, until the partial-init process eventually crashes. The naive entry has no concept of "the gateway is up but not ready".
- **Relative state directory breaks under `cd`.** State files (sessions, secrets, bindings, sentinels) live under `~/.openclaw` by default. The naive `resolveStateDir` is called on every read. If a subsystem or test changes `process.cwd()` after startup — common in plugin code that does `fs.readdirSync()` with relative paths — and `OPENCLAW_STATE_DIR` is relative, the state dir silently rebinds to a new location halfway through the process's life. Sessions vanish from one read to the next.
- **A pending top-level promise does not keep the loop alive.** A naive `await new Promise(() => {})` looks like a forever-wait but it is not. Node treats a pending Promise as inactive once nothing else is keeping the loop open. The process exits with code 13 — "unsettled top-level await" — the moment the HTTP server's last keepalive timer drops. The gateway dies for no observable reason.
- **Repeated bundled-channel filesystem scans.** Each `chat.send` and `channels.status` call wants to consult the catalog of bundled channels. A naive implementation re-stats `dist/channel-catalog.json` and walks the bundled-plugins directory on every call. With twenty channels in the catalog, this is twenty extra syscalls per RPC — pure waste, because the catalog cannot change without restarting the process.

The core mismatch: a gateway is not "a long-running HTTP server"; it is "a long-running HTTP server **plus** the contracts that make it safe to be the only owner of a state directory and port". The contracts must be set up before, during, and just after `listen`, in that order.

## 5. OpenClaw's approach

OpenClaw's approach is to **pin the state directory once at startup, acquire a file-based gateway lock that knows how to reclaim its own zombies, then run a supervised loop where each iteration starts the server in named, traceable stages, with the event loop deliberately kept alive by a ref'd handle, not a hanging Promise**.

The choreography:

**1. State directory is pinned at startup.** `resolveStateDir` from `src/config/paths.ts:60` is evaluated once, very early, and the resulting absolute path is what every subsystem closes over. After the v2026.5.22 changes that reuse process-stable channel catalog reads, the bundled channel catalog is also resolved once and cached per package-root in `bundledPackageCatalogCache` and `officialCatalogFileCache` at `src/channels/bundled-channel-catalog-read.ts:22-23`. Twenty channels means one stat, not twenty, and the cache key is stable for the life of the process.

**2. Gateway lock is acquired before `listen`.** `runGatewayLoop` at `src/cli/gateway-cli/run-loop.ts:100` opens with `await acquireGatewayLock({ port: params.lockPort })` at `src/cli/gateway-cli/run-loop.ts:124`. The lock implementation, `acquireGatewayLock` at `src/infra/gateway-lock.ts:246`, computes the lock path from `resolveGatewayLockPath` at `src/infra/gateway-lock.ts:238-244` — hashing the pinned `configPath` so a different config means a different lock file, intentionally allowing parallel gateways for parallel configs. The lock is `fs.open(path, "wx")` (exclusive create). On `EEXIST`, the existing lock payload is read at `src/infra/gateway-lock.ts:299`, the owner PID is inspected with `resolveGatewayOwnerStatus`, and ownership is decided by:
   - liveness (`isPidAlive`)
   - Linux process start-time match (catches PID recycling), `src/infra/gateway-lock.ts:206-215`
   - argv shape (`isGatewayArgv`)
   - and age (`staleMs`, default 30 s, `src/infra/gateway-lock.ts:15`)
   
   If the owner is "dead", the lock is removed and the loop retries. Inside the configured timeout (default 5 s, `src/infra/gateway-lock.ts:13`) the lock is either ours or we exit with a readable error. This is exactly the "stale-lock zombie" recovery the naive approach does not have.

**3. `listen` is wrapped to translate `EADDRINUSE` into a sentence.** `listenGatewayHttpServer` at `src/gateway/server/http-listen.ts:18` calls `server.listen()` and on `EADDRINUSE` retries up to 20 times with a 500 ms gap (`src/gateway/server/http-listen.ts:5-6`), then throws an error whose message is literally `another gateway instance is already listening on ws://${bindHost}:${port}` (`src/gateway/server/http-listen.ts:51`). No raw Node stack.

**4. The server boots in named, lazy-loaded stages.** `startGatewayServer` at `src/cli/gateway-cli/run.ts:518` is itself lazy-loaded (`startupTrace.measure("cli.server-import", () => import("../../gateway/server.js"))`). The real `startGatewayServer` lives at `src/gateway/server.impl.ts:531` and proceeds as a sequence of stages, each wrapped in `startupTrace.measure(...)` so it can be timed and logged:
   - `config.snapshot` (`src/gateway/server.impl.ts:568`) loads `loadGatewayStartupConfigSnapshot`.
   - `config.auth` (`src/gateway/server.impl.ts:604`) calls `prepareGatewayStartupConfig` to resolve token / password / scope policy.
   - HTTP and WebSocket servers are constructed, with `listenGatewayHttpServer` performing the bind.
   - The method registry is built with `createGatewayMethodRegistry` (`src/gateway/methods/registry.ts:51`) from three sources merged inside `buildAttachedGatewayMethodRegistry` at `src/gateway/server.impl.ts:1139-1161` — core descriptors (including `chat.send`), plugin descriptors, and ad-hoc handlers. `chat.send` is one entry, with scope `operator.write`, declared at `src/gateway/methods/core-descriptors.ts:190`.
   - WS handlers are attached **last**, by `attachGatewayWsHandlers` at `src/gateway/server.impl.ts:1434-1438`. Until then connections are accepted but not yet wired into the registry. The handler is constructed with `isStartupPending: () => !startupSidecarsReady` at `src/gateway/server.impl.ts:1453`, so a client that races in before the sidecars are up gets a deterministic "startup pending" response, not a fake "method not found".

**5. The event loop is held open by a ref'd interval.** When `runGatewayCommand` reaches the "now wait until something tells us to stop" state, it does **not** `await new Promise(() => {})`. It calls `waitForever()` from `src/cli/wait.ts:1`, which sets up `setInterval(() => {}, 1_000_000)` and returns a never-resolving Promise. The setInterval handle is ref'd (the default), so Node's event-loop liveness check sees an active handle and refuses to exit with the dreaded code 13. The comment at `src/cli/wait.ts:1-9` is explicit about this being the fix that "defeats the unsettled top-level await exit". The interval handle is intentionally not retained anywhere — a forever wait has no caller-visible way to stop.

**6. The bundled-channel catalog is read once.** Per the v2026.5.22 perf change ("reuse process-stable channel catalog reads"), `readBundledExtensionCatalogEntriesSync` and `tryReadJsonSync` inside `src/channels/bundled-channel-catalog-read.ts:22-50` cache by package root. Subsequent reads from any code path hit the cache. Subsystems that depend on "what channels exist" no longer pay a filesystem round-trip on every call.

By the end of this stage choreography we have: a port bound, a lock held, a registry with `chat.send` ready to dispatch, sidecars still warming up (with a `startupPendingReason` of `"startup-sidecars"`), the event loop kept alive by `waitForever`, and a supervised `runGatewayLoop` ready to handle SIGUSR1 restarts, in-place upgrade respawns, and graceful shutdown. We are idle, waiting for the first WebSocket.

## 6. Code locations

- `src/cli/gateway-cli/run.ts:472` — `runGatewayCommand`, the command-handler entry point.
- `src/cli/gateway-cli/run.ts:518` — lazy import of `startGatewayServer` wrapped in `startupTrace.measure`.
- `src/cli/gateway-cli/run.ts:811-833` — dispatch to `runGatewayLoop` (or the supervised variant).
- `src/cli/gateway-cli/run-loop.ts:100` — `runGatewayLoop`, supervises the iteration.
- `src/cli/gateway-cli/run-loop.ts:124` — `acquireGatewayLock` called before any server work.
- `src/cli/gateway-cli/run-loop.ts:162-172` — `reacquireLockForInProcessRestart` after an in-process restart.
- `src/infra/gateway-lock.ts:13-15` — defaults: 5 s timeout, 100 ms poll, 30 s stale threshold.
- `src/infra/gateway-lock.ts:238-244` — `resolveGatewayLockPath`; per-config hashed lock path.
- `src/infra/gateway-lock.ts:246` — `acquireGatewayLock` with `wx` exclusive create.
- `src/infra/gateway-lock.ts:200-227` — `resolveGatewayOwnerStatus`; the `alive` / `dead` / `unknown` decision incorporating Linux start-time.
- `src/infra/gateway-lock.ts:299-313` — read existing lock payload and possibly reclaim it.
- `src/gateway/server.ts:24-29` — thin `startGatewayServer` wrapper that dynamically imports `server.impl.ts`.
- `src/gateway/server.impl.ts:531` — real `startGatewayServer`.
- `src/gateway/server.impl.ts:568-571` — `config.snapshot` stage.
- `src/gateway/server.impl.ts:604-606` — `config.auth` stage.
- `src/gateway/server.impl.ts:1139-1161` — `buildAttachedGatewayMethodRegistry` merging core + plugin + extra descriptors.
- `src/gateway/server.impl.ts:1434-1438` — `attachGatewayWsHandlers` invocation, last in the boot.
- `src/gateway/server.impl.ts:1453` — `isStartupPending` predicate handed to the WS handler.
- `src/gateway/methods/registry.ts:51` — `createGatewayMethodRegistry`.
- `src/gateway/methods/core-descriptors.ts:190` — `chat.send` core descriptor with `scope: "operator.write"`.
- `src/gateway/server/http-listen.ts:5-6` — EADDRINUSE retry budget: 20 tries, 500 ms apart.
- `src/gateway/server/http-listen.ts:18` — `listenGatewayHttpServer`.
- `src/gateway/server/http-listen.ts:43-51` — EADDRINUSE retry then readable error.
- `src/cli/wait.ts:1` — `waitForever` with its ref'd `setInterval` keepalive.
- `src/channels/bundled-channel-catalog-read.ts:22-23` — `officialCatalogFileCache` / `bundledPackageCatalogCache`, the v2026.5.22 process-stable cache.
- `src/channels/bundled-channel-catalog-read.ts:33-50` — `readBundledExtensionCatalogEntriesSync` using those caches.

## 7. Branches and extensions

The trace takes the clean path: loopback bind, no port collision, no stale lock, no in-place upgrade in flight. The branches we skipped here:

- **Supervised lock recovery.** `runGatewayLoopWithSupervisedLockRecovery` at `src/cli/gateway-cli/run.ts:398` wraps the loop in an outer recovery driver that handles the case where a lock owner exits between our liveness check and our open. The full lifecycle of restart tokens, SIGUSR1 in-place restarts, and update.run respawns lives in `loadGatewayLifecycleRuntimeModule` and the run-loop file. See Chapter 02 §2 in [02-gateway-control-plane.md](./02-gateway-control-plane.md#2-http-websocket-listeners) for the listener startup including TLS and Tailscale variants.
- **Method registry layering.** The fact that core, plugin, and ad-hoc descriptors merge into one registry — and that the registry is rebuilt when plugins reload — is a design pattern that recurs across the gateway. See Chapter 02 §3 in [02-gateway-control-plane.md](./02-gateway-control-plane.md#3-the-rpc-method-registry) for descriptor shape, scope semantics, and how `chat.send` differs from `operator.admin` methods like `channels.start`.
- **State directory under `--container` / `OPENCLAW_STATE_DIR`.** The pin happens once, but the choice of which directory to pin can be steered by env. See Chapter 03 §7 in [03-config-system.md](./03-config-system.md#7-state-directory-resolution) for the resolution chain and the `~`/relative-path handling.
- **Lock semantics under PID recycling on Linux.** The `payload.startTime` comparison at `src/infra/gateway-lock.ts:206-215` is what stops a recycled PID from confusing us into believing a dead gateway is still alive. macOS and Windows fall back to argv shape inspection.
- **`OPENCLAW_ALLOW_MULTI_GATEWAY=1`.** Tests and some advanced scenarios bypass locking entirely (`src/infra/gateway-lock.ts:251-256`). We do not exercise that path.
- **Startup sidecars.** Cron, channel-health monitor, background plugin tasks come up *after* the listener is open, gated by `startupPendingReason = "startup-sidecars"`. The lazy-load v2026.5.22 changes ("lazy-load startup-idle plugin work") delay these until first need.

## 8. What you should now have in your head

- The first thing the gateway does is **acquire a file lock** keyed by the hashed config path, not by port. Two gateways pointed at two different configs are allowed to coexist; two gateways pointed at the same config compete for the lock.
- The lock has **active recovery**: dead PIDs are reclaimed, PID recycling on Linux is caught via start-time, and the worst case is a 30-second stale fallback. The user does not delete lock files by hand.
- `listen` is never called raw — it goes through `listenGatewayHttpServer`, which retries `EADDRINUSE` up to 20 × 500 ms and then throws an error with the literal text "another gateway instance is already listening on ws://…". The naive `EADDRINUSE` stack trace is impossible to reach.
- **WS handlers attach last.** The HTTP socket may be open earlier in the sequence, but `attachGatewayWsHandlers` only runs after the registry is built and `isStartupPending` is wired. Early connections get a deterministic "startup pending" response.
- The event loop is kept alive by `waitForever()` — a ref'd `setInterval`, not a hanging Promise. The comment in `src/cli/wait.ts` exists because the Promise-only approach made the process exit with code 13. Read it once and you understand a class of "why is my Node service dying with no error" bugs.
- The state directory and the bundled-channel catalog are both **pinned once at startup** as a v2026.5.22 perf and correctness improvement, so hot paths do not pay filesystem costs on every RPC.
