# Chapter 02: Gateway Control Plane

Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## Why this chapter exists

OpenClaw runs as a long-lived local process. Its job is to:

- Listen on a port (default `18789`) for clients (TUI, web Control UI, native apps, sister CLIs).
- Translate every incoming request into one of: a state read, a config write, a channel command, or an agent turn.
- Drive scheduled work (cron, heartbeats) without any human in the loop.
- Forward agent events back to the right subset of connected clients.

Strip away the channel adapters (Telegram, Slack, Discord, IRC, mail, voice...) and the agent harness (Codex app-server, Pi embedded runner, ACP bridges) and what remains is a thin TCP-fronted JSON-RPC router with a singleton lock, an auth handshake, a method registry, and a graceful-shutdown choreographer. That thin layer is **the gateway control plane**, and it is what this chapter is about.

We use the term deliberately. Inside the source tree there is even a method-level marker `controlPlaneWrite: true` (see `src/gateway/methods/descriptor.ts:27`) that flags RPCs which mutate gateway-level state — config, plugin install, restart — versus the much larger set of RPCs that simply talk to or about a session. That distinction will come up again in Chapter 14 when we look at scope enforcement.

## Problem framing: the naive "just listen on a port" approach

The simplest possible gateway is fifteen lines of `ws.on("connection", (sock) => sock.on("message", dispatch))`. It is enough for a demo. It is not enough for OpenClaw, for reasons that justify every block of code we are about to read.

1. **Two processes will try to listen on the same port.** A power user double-clicks the menu-bar app while a `launchctl` service is already running. Without a singleton lock, `EADDRINUSE` is the only thing keeping the world consistent — and `EADDRINUSE` is not strong enough: socket reuse, PID recycling, and TIME_WAIT all break that invariant in subtle ways.
2. **The auth model has to survive cold-start.** A client connecting one millisecond after the HTTP server binds will get its frame before any agent runtime, plugin registry, or cron service has loaded. Either we delay binding (slow startup) or we accept connections and gate methods (the OpenClaw answer).
3. **Methods come from three owners.** Core gateway code, plugins (which can register new RPCs at install time), and channel adapters (which expose `<channel>.send`, etc.). Each owner has different trust assumptions. A single ad-hoc `if (method === ...)` switch will not survive.
4. **Shutdown is not "close the socket".** Live agent turns must be allowed to finalize so `session_end` plugin hooks fire, in-flight WebSocket replies must drain, cron must be paused, channel adapters must log out, and a TLS Tailscale funnel must be torn down — in a specific order. Anything else leaks ghost rows in stores.
5. **The process must restart itself.** Config writes, package updates, and explicit `gateway.restart.request` RPCs all need to leave the supervisor (launchd / systemd / pm2 / direct shell) in a consistent state, with the new child process able to grab the lock the parent is releasing.

Every section below corresponds to a real subsystem that exists because at least one of these five truths was learned the hard way.

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="control plane vs data plane">
<rect x="0" y="0" width="760" height="360" fill="#f1f5f9"/>
<rect x="20" y="20" width="720" height="320" fill="#ffffff" stroke="#cbd5e1"/>
<text x="380" y="46" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="700" fill="currentColor">OpenClaw process boundaries</text>
<rect x="40" y="70" width="300" height="250" fill="#fed7aa" stroke="#ea580c"/>
<text x="190" y="92" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="700" fill="#7c2d12">Control Plane (this chapter)</text>
<text x="60" y="118" font-family="sans-serif" font-size="12" fill="#7c2d12">- singleton lock</text>
<text x="60" y="138" font-family="sans-serif" font-size="12" fill="#7c2d12">- HTTP + WebSocket listener</text>
<text x="60" y="158" font-family="sans-serif" font-size="12" fill="#7c2d12">- auth handshake</text>
<text x="60" y="178" font-family="sans-serif" font-size="12" fill="#7c2d12">- method registry / dispatch</text>
<text x="60" y="198" font-family="sans-serif" font-size="12" fill="#7c2d12">- scope &amp; rate-limit gating</text>
<text x="60" y="218" font-family="sans-serif" font-size="12" fill="#7c2d12">- config reload &amp; restart</text>
<text x="60" y="238" font-family="sans-serif" font-size="12" fill="#7c2d12">- cron scheduler (Addendum 02a)</text>
<text x="60" y="258" font-family="sans-serif" font-size="12" fill="#7c2d12">- graceful shutdown</text>
<text x="60" y="278" font-family="sans-serif" font-size="12" fill="#7c2d12">- broadcast fan-out</text>
<text x="60" y="298" font-family="sans-serif" font-size="12" fill="#7c2d12">- presence/health</text>
<rect x="400" y="70" width="320" height="115" fill="#99f6e4" stroke="#0d9488"/>
<text x="560" y="92" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="700" fill="#134e4a">Data Plane: channels</text>
<text x="420" y="118" font-family="sans-serif" font-size="12" fill="#134e4a">Telegram, Slack, Discord, Email,</text>
<text x="420" y="138" font-family="sans-serif" font-size="12" fill="#134e4a">IRC, Mattermost, Webhook,</text>
<text x="420" y="158" font-family="sans-serif" font-size="12" fill="#134e4a">SMS, WhatsApp, Voice, Browser</text>
<rect x="400" y="205" width="320" height="115" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="560" y="227" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="700" fill="#4c1d95">Data Plane: agent runtime</text>
<text x="420" y="253" font-family="sans-serif" font-size="12" fill="#4c1d95">Codex app-server (child process),</text>
<text x="420" y="273" font-family="sans-serif" font-size="12" fill="#4c1d95">Pi embedded runner, ACP bridges,</text>
<text x="420" y="293" font-family="sans-serif" font-size="12" fill="#4c1d95">provider HTTP clients, MCP tools</text>
<line x1="340" y1="127" x2="400" y2="127" stroke="#64748b" stroke-width="2" marker-end="url(#arr2)"/>
<line x1="340" y1="262" x2="400" y2="262" stroke="#64748b" stroke-width="2" marker-end="url(#arr2)"/>
<line x1="400" y1="142" x2="340" y2="142" stroke="#94a3b8" stroke-dasharray="4 3"/>
<line x1="400" y1="278" x2="340" y2="278" stroke="#94a3b8" stroke-dasharray="4 3"/>
<defs>
<marker id="arr2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#64748b"/></marker>
</defs>
</svg>
<span class="figure-caption">Figure R2.0 | The gateway is a control plane: it issues commands to channels and to the agent runtime, and receives events back. Solid arrows are commands; dashed arrows are events.</span>
<details><summary>ASCII original</summary>

```
+-----------------------------+        +-------------------------+
|        Control Plane        | -----> |  Channels (data plane)  |
|  - singleton lock           | <----- |  Telegram, Slack, ...   |
|  - listener + auth          |        +-------------------------+
|  - method registry          |        +-------------------------+
|  - shutdown choreographer   | -----> |  Agent runtime (Codex,  |
|                             | <----- |  Pi, ACP, MCP, etc.)    |
+-----------------------------+        +-------------------------+
```

</details>

## Section 1. The shape of the codebase

A handful of files do almost all the control-plane work:

| Role | File |
|------|------|
| Singleton lock & process identity | `src/infra/gateway-lock.ts` |
| `openclaw gateway` CLI entry | `src/cli/gateway-cli/register.ts`, `src/cli/gateway-cli/run.ts`, `src/cli/gateway-cli/run-loop.ts` |
| Event loop "stay alive" helper | `src/cli/wait.ts` |
| Server bootstrap (the big one) | `src/gateway/server.impl.ts` |
| HTTP/WS listen with TIME_WAIT retry | `src/gateway/server/http-listen.ts` |
| Method descriptor type | `src/gateway/methods/descriptor.ts` |
| Method registry | `src/gateway/methods/registry.ts` |
| Core method catalogue (the table of every gateway RPC) | `src/gateway/methods/core-descriptors.ts` |
| Dispatch (auth/scope/rate-limit/handler) | `src/gateway/server-methods.ts` |
| Per-connection lifecycle | `src/gateway/server/ws-connection.ts` |
| Frame parser & router | `src/gateway/server/ws-connection/message-handler.ts` |
| Bind / listen retry | `src/gateway/server-runtime-state.ts` |
| Graceful shutdown | `src/gateway/server-close.ts` |
| Drain-active-sessions tracker | `src/gateway/active-sessions-shutdown-tracker.ts` |
| Auth surface (token, Tailscale, etc.) | `src/gateway/auth.ts` |
| Operator scopes | `src/gateway/operator-scopes.ts` |
| Bundled channel catalog (startup cache) | `src/channels/bundled-channel-catalog-read.ts` |
| Cron service entry | `src/cron/service.ts`, `src/cron/service/state.ts` |

Two files dominate by size: `server.impl.ts` (1710 lines) and `server-close.ts` (743 lines). Reading them top-to-bottom is unrewarding; in this chapter we treat `server.impl.ts` as a script we step through phase by phase.

## Section 2. The singleton lock

`openclaw gateway` must be a single-instance daemon per `config.json`. The lock file lives under a state directory hashed from the config path, so two parallel installs (e.g. a stable channel and a dev checkout each with its own config) can coexist:

```ts
// src/infra/gateway-lock.ts:238
function resolveGatewayLockPath(env: NodeJS.ProcessEnv, lockDir = resolveGatewayLockDir()) {
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  const hash = createHash("sha256").update(configPath).digest("hex").slice(0, 8);
  const lockPath = path.join(lockDir, `gateway.${hash}.lock`);
  return { lockPath, configPath };
}
```

The whole lock dance lives in `acquireGatewayLock` (`src/infra/gateway-lock.ts:246`). Three things make it more than `fs.writeFile`:

1. **Atomic create.** `await fs.open(lockPath, "wx")` (line 274) fails atomically with `EEXIST` if anyone has the file. If we win the race we write our payload (pid, ISO timestamp, optional Linux start-time, config path).
2. **Liveness probe of the existing owner.** If `EEXIST`, we read the payload and call `resolveGatewayOwnerStatus` (line 186). That function returns `"alive" | "dead" | "unknown"` after a cascading check: port-probe → `isPidAlive(pid)` → Linux `/proc` start-time → platform-specific `cmdline` read (`/proc/$pid/cmdline`, `wmic`, `ps`). The last step matters because PIDs get recycled; without it we'd refuse to start when a fresh process happens to have grabbed the same PID.

```ts
// src/infra/gateway-lock.ts:186
async function resolveGatewayOwnerStatus(
  pid: number,
  payload: LockPayload | null,
  platform: NodeJS.Platform,
  port: number | undefined,
  readCmdline?: (pid: number) => string[] | null,
): Promise<LockOwnerStatus> {
  if (port != null) {
    const portFree = await checkPortFree(port);
    if (portFree) {
      return "dead";
    }
  }
  if (!isPidAlive(pid)) {
    return "dead";
  }
  // ... start-time check on Linux, argv check elsewhere
}
```

3. **Stale-file fallback.** If the owner is `unknown` and the lockfile is older than `DEFAULT_STALE_MS = 30_000` (line 15), we forcibly remove it. The mtime check is wrapped in `try/catch` (line 322) because on Windows we may not even be able to `stat` a lock another gateway holds open — and the conservative choice in that case is "keep waiting", not "stomp the file".

Once we win, the returned `GatewayLockHandle.release()` closes the file descriptor and unlinks. The CLI loop owns when that happens — see Section 9 below.

### What about the `maxHoldMs` change in v2026.5.22?

The release notes mention `fix(session-lock): enforce maxHoldMs in shouldReclaim during lock acquisition (#85764)`. That fix lives in **`src/agents/session-write-lock.ts`**, not in `gateway-lock.ts`. It is a different lock: each session JSONL file has its own per-session write lock, separate from the gateway singleton. The relevant policy lines:

```ts
// src/agents/session-write-lock.ts:711-778
export async function acquireSessionWriteLock(params: {
  sessionFile: string;
  timeoutMs?: number;
  staleMs?: number;
  maxHoldMs?: number;
  allowReentrant?: boolean;
}): Promise<{ release: () => Promise<void> }> {
  // ...
  const maxHoldMs = resolvePositiveMs(params.maxHoldMs, defaultOptions.maxHoldMs);
  // ...
  shouldReclaim: async ({ payload, nowMs, heldByThisProcess }) => {
    const inspected = inspectLockPayloadForSession({
      payload: payload as LockFilePayload | null,
      staleMs,
      nowMs,
      heldByThisProcess,
      reclaimLockWithoutStarttime: true,
      readOwnerProcessArgs: readProcessArgsSync,
      respectMaxHold: !heldByThisProcess,         // <-- the v2026.5.22 fix
    });
    return await shouldReclaimContendedLockFile(lockPath, inspected, staleMs, nowMs);
  },
```

`respectMaxHold` makes `inspectLockPayload` mark a lock as stale once `ageMs > holderMaxHoldMs` even if the owner PID is still alive. Without it, a live but stuck process could pin a session lock for the full `staleMs = 30 min` window. The session-write-lock subsystem is covered in the agent chapters; we mention it here only to keep the two locks straight: **gateway lock = process singleton, session-write lock = per-session JSONL writer.**

## Section 3. From `openclaw gateway` to a listening socket

The CLI registration is mundane (`src/cli/gateway-cli/register.ts`); the interesting code is `runGatewayLoop` in `src/cli/gateway-cli/run-loop.ts`. Stripped to its skeleton:

```ts
// src/cli/gateway-cli/run-loop.ts:100
export async function runGatewayLoop(params: {
  start: (params?: { startupStartedAt?: number }) =>
    Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  runtime: RuntimeEnv;
  lockPort?: number;
  // ...
}) {
  const eagerLifecycleRuntime = await loadGatewayLifecycleRuntimeModule();
  let lock = await acquireGatewayLock({ port: params.lockPort });   // (a)
  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  // ...signal handlers, restart resolver, etc...
  while (true) {
    // (b) start the server, then wait for either close or restart
    server = await params.start({ startupStartedAt });
    await new Promise<void>((resolve) => { restartResolver = resolve; });
    // (c) one of: stop → exit, restart → loop with fresh lock
  }
}
```

Point (a) — `acquireGatewayLock({ port })` — is the entire reason the v2026.5.22 lock notes mention "during lock acquisition". The port is supplied so the liveness probe can short-circuit when nothing answers on the port (a fast "owner is dead" verdict).

Point (b) is what `params.start` actually does: it calls `startGatewayServer(port, opts)` from `src/gateway/server.impl.ts`. That function returns once the HTTP server is bound and post-attach sidecars have started; subsequent restart requests come through SIGUSR1, in-band `gateway.restart.request` RPCs, or supervisor signals, and re-enter the loop.

Point (c) deserves a closer look: a clean stop calls `releaseLockIfHeld()` and `exitProcess(0)`. A restart releases the lock **before** spawning the child (line 263 in `run-loop.ts`) so the child can grab it immediately, then exits.

### Why the CLI needs `waitForever`

There is one subtlety that bit a user in v2026.5.21. The CLI's `main()` style is `await runGatewayLoop(...)`, but `runGatewayLoop` settles when the gateway closes. Without anything else keeping the loop alive, Node 24 exits with code 13 (unsettled top-level await) the moment all timers are unrefed. The fix (`#85694`) is `waitForever`:

```ts
// src/cli/wait.ts:1
export function waitForever() {
  // Keep the event loop alive with a ref'd interval. A pending Promise is not
  // an active handle on its own, so without the interval, Node exits the
  // process with code 13 ("unsettled top-level await") as soon as nothing
  // else is keeping the loop open — defeating the "wait forever" contract.
  // The handle is intentionally not retained: there is no caller-visible way
  // to stop a "forever" wait, and the interval lives for the lifetime of the
  // process.
  setInterval(() => {}, 1_000_000);
  return new Promise<void>(() => {
    /* never resolve */
  });
}
```

Two design points worth absorbing: the interval is ref'd (no `.unref()`) on purpose, and the handle is intentionally not retained — there is no API surface to stop a "forever" wait. This is the cleanest possible illustration of how a one-line bug ("the interval should not be unref'd") can take a whole supervised install down.

## Section 4. Inside `startGatewayServer`

`startGatewayServer` (`src/gateway/server.impl.ts:531`) is 1180 lines from top to bottom. Reading it without a map is painful; reading it with the phase order is straightforward. Every phase passes through one of two helpers built at line 222:

```ts
// src/gateway/server.impl.ts:222
function createGatewayStartupTrace() {
  const logEnabled = isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE);
  // ...
  return {
    setConfig(config: OpenClawConfig) { /* ... */ },
    mark(name: string) { /* ... */ },
    detail(name: string, metrics: ReadonlyArray<readonly [string, number | string]>) { /* ... */ },
    async measure<T>(name: string, run: () => Promise<T> | T): Promise<T> { /* ... */ },
  };
}
```

That object is the timeline. `OPENCLAW_GATEWAY_STARTUP_TRACE=1` will log every phase boundary; diagnostics events emit even when the env flag is off, so the timeline is also visible through `openclaw diagnostics` after the fact. The phases in order:

| Trace name | Where |
|------------|-------|
| `config.snapshot` | read & parse `config.json` |
| `config.auth` | resolve auth mode (token / Tailscale / loopback / ...) |
| `control-ui.seed` | one-time `allowedOrigins` migration for upgraded installs |
| `control-ui.root` | locate the static asset directory for the browser UI |
| `tls.runtime` | enable TLS if configured |
| `runtime.state` | build HTTP/WS servers, registries, broadcast fns |
| `plugins.bootstrap` | resolve which plugins to load |
| `runtime.early` | bonjour discovery, presence subscriptions, etc. |
| `runtime.config` | resolve bind host/port |
| `http.bound` | the moment `httpServer.listen` resolved |
| `runtime.post-attach` | start cron, channels, plugin services |
| `ready` | the post-ready maintenance timer is armed |

Tying that to the source: phase names appear in `startupTrace.measure("config.snapshot", ...)` (line 570), `"config.auth"` (line 605), `"runtime.state"` (line 871), `"runtime.early"` (line 1048), `"runtime.post-attach"` (line 1497), and the final `startupTrace.mark("ready")` at line 1585.

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="startup phases">
<rect x="0" y="0" width="760" height="380" fill="#f1f5f9"/>
<rect x="20" y="20" width="720" height="340" fill="#ffffff" stroke="#cbd5e1"/>
<text x="380" y="46" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="700" fill="currentColor">Gateway startup phases (server.impl.ts)</text>
<rect x="40" y="70" width="160" height="38" fill="#fed7aa" stroke="#ea580c"/>
<text x="120" y="94" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#7c2d12">acquireGatewayLock</text>
<rect x="220" y="70" width="160" height="38" fill="#fed7aa" stroke="#ea580c"/>
<text x="300" y="94" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#7c2d12">config.snapshot</text>
<rect x="400" y="70" width="160" height="38" fill="#fed7aa" stroke="#ea580c"/>
<text x="480" y="94" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#7c2d12">config.auth</text>
<rect x="580" y="70" width="160" height="38" fill="#fed7aa" stroke="#ea580c"/>
<text x="660" y="94" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#7c2d12">tls.runtime</text>
<line x1="200" y1="89" x2="220" y2="89" stroke="#64748b" stroke-width="2" marker-end="url(#a3)"/>
<line x1="380" y1="89" x2="400" y2="89" stroke="#64748b" stroke-width="2" marker-end="url(#a3)"/>
<line x1="560" y1="89" x2="580" y2="89" stroke="#64748b" stroke-width="2" marker-end="url(#a3)"/>
<rect x="40" y="130" width="160" height="38" fill="#99f6e4" stroke="#0d9488"/>
<text x="120" y="154" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#134e4a">runtime.state</text>
<rect x="220" y="130" width="160" height="38" fill="#99f6e4" stroke="#0d9488"/>
<text x="300" y="154" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#134e4a">plugins.bootstrap</text>
<rect x="400" y="130" width="160" height="38" fill="#99f6e4" stroke="#0d9488"/>
<text x="480" y="154" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#134e4a">runtime.early</text>
<rect x="580" y="130" width="160" height="38" fill="#99f6e4" stroke="#0d9488"/>
<text x="660" y="154" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#134e4a">build method registry</text>
<line x1="660" y1="108" x2="120" y2="130" stroke="#64748b" stroke-width="1" stroke-dasharray="3 2"/>
<line x1="200" y1="149" x2="220" y2="149" stroke="#64748b" stroke-width="2" marker-end="url(#a3)"/>
<line x1="380" y1="149" x2="400" y2="149" stroke="#64748b" stroke-width="2" marker-end="url(#a3)"/>
<line x1="560" y1="149" x2="580" y2="149" stroke="#64748b" stroke-width="2" marker-end="url(#a3)"/>
<rect x="40" y="190" width="160" height="38" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="120" y="214" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#4c1d95">attach WS handlers</text>
<rect x="220" y="190" width="160" height="38" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="300" y="214" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#4c1d95">startListening</text>
<rect x="400" y="190" width="160" height="38" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="480" y="214" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#4c1d95">http.bound (mark)</text>
<rect x="580" y="190" width="160" height="38" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="660" y="214" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#4c1d95">runtime.post-attach</text>
<line x1="660" y1="168" x2="120" y2="190" stroke="#64748b" stroke-width="1" stroke-dasharray="3 2"/>
<line x1="200" y1="209" x2="220" y2="209" stroke="#64748b" stroke-width="2" marker-end="url(#a3)"/>
<line x1="380" y1="209" x2="400" y2="209" stroke="#64748b" stroke-width="2" marker-end="url(#a3)"/>
<line x1="560" y1="209" x2="580" y2="209" stroke="#64748b" stroke-width="2" marker-end="url(#a3)"/>
<rect x="40" y="250" width="220" height="38" fill="#f0fdf4" stroke="#16a34a"/>
<text x="150" y="274" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#14532d">start config reloader</text>
<rect x="280" y="250" width="220" height="38" fill="#f0fdf4" stroke="#16a34a"/>
<text x="390" y="274" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#14532d">post-ready maintenance timer</text>
<rect x="520" y="250" width="220" height="38" fill="#f0fdf4" stroke="#16a34a"/>
<text x="630" y="274" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#14532d">ready (mark)</text>
<line x1="660" y1="228" x2="150" y2="250" stroke="#64748b" stroke-width="1" stroke-dasharray="3 2"/>
<line x1="260" y1="269" x2="280" y2="269" stroke="#64748b" stroke-width="2" marker-end="url(#a3)"/>
<line x1="500" y1="269" x2="520" y2="269" stroke="#64748b" stroke-width="2" marker-end="url(#a3)"/>
<text x="40" y="320" font-family="sans-serif" font-size="11" fill="#64748b">All phase boundaries are tagged through startupTrace.measure / mark and</text>
<text x="40" y="338" font-family="sans-serif" font-size="11" fill="#64748b">logged when OPENCLAW_GATEWAY_STARTUP_TRACE=1.</text>
<defs>
<marker id="a3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#64748b"/></marker>
</defs>
</svg>
<span class="figure-caption">Figure R2.1 | Gateway startup, with the phase names that appear in startup-trace logs.</span>
<details><summary>ASCII original</summary>

```
acquireGatewayLock -> config.snapshot -> config.auth -> tls.runtime
   |
   v
runtime.state -> plugins.bootstrap -> runtime.early -> build method registry
   |
   v
attach WS handlers -> startListening -> http.bound (mark) -> runtime.post-attach
   |
   v
start config reloader -> post-ready maintenance timer -> ready (mark)
```

</details>

The point of structuring code this way is that **each phase is observable**. When a user reports "gateway hangs on startup", you can ask "what was the last phase trace?" and immediately know whether to look at plugin loading, channel startup, or the bonjour announcer.

## Section 5. Binding the socket

`startListening` is constructed inside `createGatewayRuntimeState` and called at line 1464 of `server.impl.ts`. The bind logic itself:

```ts
// src/gateway/server-runtime-state.ts:281
startListeningPromise = (async () => {
  for (const [index, host] of bindHosts.entries()) {
    const server = httpServers[index];
    if (!server) {
      throw new Error(`Missing gateway HTTP server for bind host ${host}`);
    }
    try {
      await listenGatewayHttpServer({
        httpServer: server,
        bindHost: host,
        port: params.port,
      });
      httpBindHosts.push(host);
    } catch (err) {
      if (host === bindHosts[0]) {
        throw err;
      }
      params.log.warn(
        `gateway: failed to bind loopback alias ${host}:${params.port} (${String(err)})`,
      );
    }
  }
  if (httpBindHosts.length === 0) {
    throw new Error("Gateway HTTP server failed to start");
  }
})();
```

The primary bind host is mandatory. Loopback aliases (e.g. binding both `127.0.0.1` and `::1` so IPv6-preferring clients work locally) are best-effort.

`listenGatewayHttpServer` itself is short and worth quoting entirely because it solves a problem that bites supervised installs constantly:

```ts
// src/gateway/server/http-listen.ts:18
export async function listenGatewayHttpServer(params: {
  httpServer: HttpServer;
  bindHost: string;
  port: number;
}) {
  const { httpServer, bindHost, port } = params;
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          httpServer.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          resolve();
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port, bindHost);
      });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" && attempt < EADDRINUSE_MAX_RETRIES) {
        await closeServerQuietly(httpServer);
        await sleep(EADDRINUSE_RETRY_INTERVAL_MS);
        continue;
      }
      // ... wrap and rethrow as GatewayLockError
    }
  }
}
```

The TIME_WAIT retry is the point. When the supervisor restarts the gateway, the child has the lock (we released it first) but the OS may still hold the previous listening socket in TIME_WAIT for a few hundred milliseconds. Without this retry loop, every supervised restart would have a non-trivial chance of failing with `EADDRINUSE`. With it, we sleep 500 ms up to 20 times — 10 seconds of patience is more than enough for the kernel to free the socket.

## Section 6. The method registry

OpenClaw uses JSON frames over WebSocket. Every request frame has a `method` field naming an RPC; every method has a descriptor:

```ts
// src/gateway/methods/descriptor.ts:21
export type GatewayMethodDescriptor = {
  name: string;
  handler: GatewayMethodHandler;
  scope: GatewayMethodScope;
  owner: GatewayMethodOwner;
  startup?: GatewayMethodStartupAvailability;
  controlPlaneWrite?: boolean;
  advertise?: boolean;
  description?: string;
};
```

Descriptors carry far more than a handler. `scope` decides who is allowed to call them; `owner` tags whether the method is core, plugin, channel, or aux; `startup` flags whether the method should refuse calls during the gateway-startup window; `controlPlaneWrite` flags whether the method counts against a stricter write rate limiter; `advertise` hides internal methods from public listings.

The core method catalogue is the easiest thing in the codebase to read end-to-end. Here is a slice:

```ts
// src/gateway/methods/core-descriptors.ts:18
export const CORE_GATEWAY_METHOD_SPECS: readonly CoreGatewayMethodSpec[] = [
  { name: "health", scope: "operator.read" },
  { name: "channels.status", scope: "operator.read" },
  { name: "channels.start", scope: "operator.admin" },
  { name: "channels.stop", scope: "operator.admin" },
  { name: "config.get", scope: "operator.read" },
  { name: "config.set", scope: "operator.admin" },
  { name: "config.apply", scope: "operator.admin", controlPlaneWrite: true },
  { name: "config.patch", scope: "operator.admin", controlPlaneWrite: true },
  { name: "exec.approval.request", scope: "operator.approvals" },
  { name: "tools.invoke", scope: "operator.write" },
  // ...
  { name: "agent.wait", scope: "operator.write", startup: true },
  { name: "chat.history", scope: "operator.read", startup: true },
  { name: "chat.abort", scope: "operator.write" },
  { name: "chat.send", scope: "operator.write" },
  // ...
] as const;
```

`startup: true` on `chat.history` is the small but important asymmetry. Reading chat history requires the session catalogue, which is loaded as a "sidecar" *after* HTTP bind. Without this annotation, a client that reconnects in the half-second window between `http.bound` and `ready` would get either inconsistent results or `INVALID_REQUEST` errors from a half-built registry; with it, the request gets a structured "retry later" reply (`UNAVAILABLE` with `retryAfterMs`).

### Building the registry

Three sources contribute descriptors at startup, merged in this order (`server.impl.ts:1139`):

```ts
// src/gateway/server.impl.ts:1139
const buildAttachedGatewayMethodRegistry = (
  nextPluginRegistry: typeof pluginRegistry,
): GatewayMethodRegistry => {
  const coreDescriptorHandlers: GatewayRequestHandlers = { ...coreGatewayHandlers };
  const auxHandlers: GatewayRequestHandlers = {};
  for (const [method, handler] of Object.entries(extraHandlers)) {
    if (isCoreGatewayMethodClassified(method)) {
      coreDescriptorHandlers[method] = handler;
    } else {
      auxHandlers[method] = handler;
    }
  }
  return createGatewayMethodRegistry([
    ...createCoreGatewayMethodDescriptors(coreDescriptorHandlers),
    ...createPluginGatewayMethodDescriptors(nextPluginRegistry),
    ...createGatewayMethodDescriptorsFromHandlers({
      handlers: auxHandlers,
      owner: { kind: "aux", area: "gateway-extra" },
      defaultScope: ADMIN_SCOPE,
    }),
  ]);
};
```

There is also a strictness check: every handler key in the core handler map must correspond to a `CORE_GATEWAY_METHOD_SPECS` entry, or `createCoreGatewayMethodDescriptors` throws (`src/gateway/methods/core-descriptors.ts:274`). The whole point is that handlers cannot exist without a declared scope; the type system would never catch this on its own because handler maps are plain `Record<string, ...>`.

`createGatewayMethodRegistry` rejects duplicate names (`src/gateway/methods/registry.ts:56`):

```ts
// src/gateway/methods/registry.ts:51
export function createGatewayMethodRegistry(
  inputs: readonly GatewayMethodDescriptorInput[],
): GatewayMethodRegistry {
  const descriptors = inputs.map(normalizeDescriptor);
  const byName = new Map<string, GatewayMethodDescriptor>();
  for (const descriptor of descriptors) {
    if (byName.has(descriptor.name)) {
      throw new Error(`gateway method already registered: ${descriptor.name}`);
    }
    byName.set(descriptor.name, descriptor);
  }
  return {
    getHandler: (name) => byName.get(name)?.handler,
    listMethods: () => descriptors.map((descriptor) => descriptor.name),
    // ...
  };
}
```

A plugin that tries to register `chat.send` will fail loudly at gateway startup, not silently shadow the core handler.

### Dispatch

Once the registry exists, dispatch is a half-dozen guard clauses (`src/gateway/server-methods.ts:179`):

```ts
// src/gateway/server-methods.ts:179
export async function handleGatewayRequest(
  opts: GatewayRequestOptions & { extraHandlers?: GatewayRequestHandlers },
): Promise<void> {
  const { req, respond, client, isWebchatConnect, context } = opts;
  const methodRegistry =
    opts.methodRegistry ?? createRequestGatewayMethodRegistry(opts.extraHandlers);
  const authError = authorizeGatewayMethod(req.method, client, req.params);
  if (authError) { respond(false, undefined, authError); return; }

  if (context.unavailableGatewayMethods?.has(req.method)) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE,
      `${req.method} unavailable during gateway startup`,
      { retryable: true, retryAfterMs: GATEWAY_STARTUP_RETRY_AFTER_MS, /* ... */ }));
    return;
  }

  if (methodRegistry.isControlPlaneWrite(req.method)) {
    const budget = consumeControlPlaneWriteBudget({ client });
    if (!budget.allowed) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE,
        `rate limit exceeded for ${req.method}; retry after ${Math.ceil(budget.retryAfterMs / 1000)}s`,
        { retryable: true, retryAfterMs: budget.retryAfterMs, /* ... */ }));
      return;
    }
  }

  const handler = methodRegistry.getHandler(req.method) as GatewayRequestHandler | undefined;
  if (!handler) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST,
      `unknown method: ${req.method}`));
    return;
  }
  await withPluginRuntimeGatewayRequestScope(
    { context, client, isWebchatConnect },
    () => handler({ req, params: (req.params ?? {}) as Record<string, unknown>, client, isWebchatConnect, respond, context }),
  );
}
```

The order matters. **Auth before "unavailable" before rate-limit before "unknown method".** Each gate produces a different structured error code; the client can react accordingly (re-auth, retry-after, refuse to retry, log a bug).

The plugin-runtime scope wrapper at the bottom (`withPluginRuntimeGatewayRequestScope`) is what lets plugin code that runs inside a handler call back into the gateway to dispatch *another* RPC. Without it, a tool implementation that wants to fetch chat history during a turn would need its own client connection — a real performance footgun.

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="dispatch pipeline">
<rect x="0" y="0" width="760" height="380" fill="#f1f5f9"/>
<rect x="20" y="20" width="720" height="340" fill="#ffffff" stroke="#cbd5e1"/>
<text x="380" y="46" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="700" fill="currentColor">Dispatch: WebSocket frame -> handler</text>
<rect x="40" y="70" width="180" height="42" fill="#fed7aa" stroke="#ea580c"/>
<text x="130" y="96" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#7c2d12">socket.on("message")</text>
<line x1="220" y1="91" x2="260" y2="91" stroke="#64748b" stroke-width="2" marker-end="url(#a4)"/>
<rect x="260" y="70" width="180" height="42" fill="#fed7aa" stroke="#ea580c"/>
<text x="350" y="89" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#7c2d12">parse JSON frame,</text>
<text x="350" y="105" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#7c2d12">extract {id, method, params}</text>
<line x1="440" y1="91" x2="480" y2="91" stroke="#64748b" stroke-width="2" marker-end="url(#a4)"/>
<rect x="480" y="70" width="240" height="42" fill="#fed7aa" stroke="#ea580c"/>
<text x="600" y="96" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#7c2d12">handleGatewayRequest</text>
<line x1="600" y1="112" x2="600" y2="140" stroke="#64748b" stroke-width="2" marker-end="url(#a4)"/>
<rect x="480" y="140" width="240" height="36" fill="#fef2f2" stroke="#dc2626"/>
<text x="600" y="163" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#991b1b">1. authorizeGatewayMethod(method, client)</text>
<line x1="600" y1="176" x2="600" y2="190" stroke="#64748b" stroke-width="2" marker-end="url(#a4)"/>
<rect x="480" y="190" width="240" height="36" fill="#fef2f2" stroke="#dc2626"/>
<text x="600" y="213" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#991b1b">2. unavailableGatewayMethods.has(method)?</text>
<line x1="600" y1="226" x2="600" y2="240" stroke="#64748b" stroke-width="2" marker-end="url(#a4)"/>
<rect x="480" y="240" width="240" height="36" fill="#fef2f2" stroke="#dc2626"/>
<text x="600" y="263" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#991b1b">3. controlPlaneWrite -> rate limit budget</text>
<line x1="600" y1="276" x2="600" y2="290" stroke="#64748b" stroke-width="2" marker-end="url(#a4)"/>
<rect x="480" y="290" width="240" height="36" fill="#f0fdf4" stroke="#16a34a"/>
<text x="600" y="313" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#14532d">4. methodRegistry.getHandler(method)</text>
<rect x="40" y="140" width="380" height="186" fill="#ffffff" stroke="#cbd5e1"/>
<text x="60" y="160" font-family="sans-serif" font-size="12" font-weight="700" fill="currentColor">methodRegistry</text>
<text x="60" y="180" font-family="sans-serif" font-size="11" fill="#64748b">- core descriptors (CORE_GATEWAY_METHOD_SPECS)</text>
<text x="60" y="198" font-family="sans-serif" font-size="11" fill="#64748b">- plugin descriptors (per loaded plugin)</text>
<text x="60" y="216" font-family="sans-serif" font-size="11" fill="#64748b">- aux descriptors (gateway-extra handlers)</text>
<text x="60" y="240" font-family="sans-serif" font-size="11" font-weight="700" fill="currentColor">scope tags</text>
<text x="60" y="258" font-family="sans-serif" font-size="11" fill="#64748b">operator.read | operator.write | operator.admin</text>
<text x="60" y="276" font-family="sans-serif" font-size="11" fill="#64748b">operator.approvals | operator.pairing | dynamic</text>
<text x="60" y="300" font-family="sans-serif" font-size="11" font-weight="700" fill="currentColor">flags: startup, controlPlaneWrite, advertise</text>
<text x="60" y="318" font-family="sans-serif" font-size="11" fill="#64748b">used by guards 2 &amp; 3 above</text>
<line x1="420" y1="220" x2="480" y2="200" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 2"/>
<defs>
<marker id="a4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#64748b"/></marker>
</defs>
</svg>
<span class="figure-caption">Figure R2.2 | Every WebSocket frame walks four guards before reaching its handler. The registry on the left is built once per startup and replaced atomically on plugin reload.</span>
<details><summary>ASCII original</summary>

```
socket.on("message")
  -> parse JSON frame
  -> handleGatewayRequest
       1. authorizeGatewayMethod(method, client)        [unauthorized -> close]
       2. unavailableGatewayMethods.has(method)?        [startup -> retry-after]
       3. controlPlaneWrite -> consume budget           [rate-limited -> retry-after]
       4. methodRegistry.getHandler(method)             [unknown -> INVALID_REQUEST]
       5. await handler(...)                            [happy path]
```

</details>

## Section 7. Connection lifecycle

Per-connection state lives in `src/gateway/server/ws-connection.ts`. `attachGatewayWsConnectionHandler` (line 202) is straightforward but careful — it builds a `connId`, sets up a preauth budget release, attaches handshake/ping timers, and arranges every cleanup path to release the budget exactly once:

```ts
// src/gateway/server/ws-connection.ts:233
wss.on("connection", (socket, upgradeReq) => {
  let client: GatewayWsClient | null = null;
  let closed = false;
  const openedAt = Date.now();
  const connId = randomUUID();
  // ...
  const send = (obj: unknown) => {
    try { socket.send(JSON.stringify(obj)); } catch { /* ignore */ }
  };
  const connectNonce = randomUUID();
  send({
    type: "event",
    event: "connect.challenge",
    payload: { nonce: connectNonce, ts: Date.now() },
  });
  // ... handshake timer, error/close listeners, ping interval ...
  attachGatewayWsMessageHandlerOnDemand({
    socket, upgradeReq, connId, /* lots of state */
    getMethodRegistry: () => attachedGatewayMethodRegistry,
    /* ... */
  });
});
```

The first frame sent on every accept is `connect.challenge` (line 313–318). The client must reply with a `connect` frame carrying an HMAC of the nonce — exactly the same nonce, signed with the shared secret. This is the auth handshake; it rules out replay attacks against captured tokens and lets the server tie a `connId` to a verified principal.

The `close` listener (line 358–431) does the bookkeeping nobody else can do:

- Sweep all session-event subscribers tied to this `connId`.
- If the client was registered as a node (a sister CLI / remote agent), unregister it.
- Update presence and broadcast the change so other connected clients see the disconnect.
- Clear node-wake state and remote node info.

The `client?.presenceKey` branch shows the design pattern that recurs throughout: every long-lived per-connection resource is owned by exactly one map keyed by `connId`, and the close listener iterates each map.

### Drain on shutdown

When the gateway closes, there is one more thing to do for any session that has emitted `session_start` but not yet `session_end` — typically a Codex turn that was midway when SIGTERM arrived. The module `src/gateway/active-sessions-shutdown-tracker.ts` exists exactly for this case, and it is short enough to quote in full:

```ts
// src/gateway/active-sessions-shutdown-tracker.ts:1
import type { OpenClawConfig } from "../config/types.openclaw.js";

// Module-level tracker of sessions that have received `session_start` but not
// yet a paired `session_end`. The close handler drains this set on gateway
// shutdown / restart so downstream `session_end` plugins (e.g. claude-mem)
// can finalize sessions that were active when the process stopped, instead
// of leaving ghost rows in `active` state across restarts (see #57790).

export type ActiveSessionForShutdown = {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId: string;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
};

const trackedSessions = new Map<string, ActiveSessionForShutdown>();

export function noteActiveSessionForShutdown(entry: ActiveSessionForShutdown): void {
  if (!entry.sessionId) { return; }
  trackedSessions.set(entry.sessionId, entry);
}

export function forgetActiveSessionForShutdown(sessionId: string | undefined): void {
  if (!sessionId) { return; }
  trackedSessions.delete(sessionId);
}

export function listActiveSessionsForShutdown(): ActiveSessionForShutdown[] {
  return Array.from(trackedSessions.values());
}

export function clearActiveSessionsForShutdownTracker(): void {
  trackedSessions.clear();
}
```

The whole point is that `session-reset-service.ts` calls `forgetActiveSessionForShutdown` whenever a session ends through *any* path — normal completion, replace, compaction — so when shutdown drains the set, only truly active sessions remain. The drain itself is in `server-close.ts` (line 502 — see Section 9 below).

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="connection lifecycle">
<rect x="0" y="0" width="760" height="360" fill="#f1f5f9"/>
<rect x="20" y="20" width="720" height="320" fill="#ffffff" stroke="#cbd5e1"/>
<text x="380" y="46" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="700" fill="currentColor">WebSocket connection lifecycle</text>
<rect x="40" y="70" width="190" height="40" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="135" y="88" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#4c1d95">WS accept</text>
<text x="135" y="103" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#4c1d95">claim preauth budget</text>
<line x1="230" y1="90" x2="265" y2="90" stroke="#64748b" stroke-width="2" marker-end="url(#a5)"/>
<rect x="265" y="70" width="200" height="40" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="365" y="88" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#4c1d95">send connect.challenge</text>
<text x="365" y="103" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#4c1d95">start handshake timer</text>
<line x1="465" y1="90" x2="500" y2="90" stroke="#64748b" stroke-width="2" marker-end="url(#a5)"/>
<rect x="500" y="70" width="220" height="40" fill="#fed7aa" stroke="#ea580c"/>
<text x="610" y="88" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#7c2d12">recv connect frame</text>
<text x="610" y="103" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#7c2d12">verify HMAC, build client</text>
<line x1="610" y1="110" x2="610" y2="135" stroke="#64748b" stroke-width="2" marker-end="url(#a5)"/>
<rect x="500" y="135" width="220" height="40" fill="#fed7aa" stroke="#ea580c"/>
<text x="610" y="153" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#7c2d12">release preauth budget,</text>
<text x="610" y="168" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#7c2d12">register in clients set, arm ping</text>
<line x1="500" y1="155" x2="465" y2="155" stroke="#94a3b8" stroke-dasharray="3 2"/>
<rect x="265" y="135" width="200" height="40" fill="#99f6e4" stroke="#0d9488"/>
<text x="365" y="158" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#134e4a">dispatch loop (req frames)</text>
<line x1="365" y1="175" x2="365" y2="200" stroke="#64748b" stroke-width="2" marker-end="url(#a5)"/>
<rect x="265" y="200" width="200" height="40" fill="#99f6e4" stroke="#0d9488"/>
<text x="365" y="223" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#134e4a">broadcast events back</text>
<line x1="365" y1="240" x2="365" y2="265" stroke="#64748b" stroke-width="2" marker-end="url(#a5)"/>
<rect x="40" y="265" width="680" height="60" fill="#fef2f2" stroke="#dc2626"/>
<text x="60" y="285" font-family="sans-serif" font-size="12" font-weight="700" fill="#991b1b">close listener (any cause):</text>
<text x="60" y="303" font-family="sans-serif" font-size="11" fill="#991b1b">unsubscribe session events &middot; unregister node &middot; clear node-wake state</text>
<text x="60" y="319" font-family="sans-serif" font-size="11" fill="#991b1b">drop presence &middot; broadcast presence change &middot; release preauth budget if still held</text>
<line x1="40" y1="155" x2="40" y2="265" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 2"/>
<line x1="40" y1="90" x2="40" y2="265" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 2"/>
<text x="32" y="180" font-family="sans-serif" font-size="10" fill="#64748b" transform="rotate(-90 32 180)">handshake timeout</text>
<defs>
<marker id="a5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#64748b"/></marker>
</defs>
</svg>
<span class="figure-caption">Figure R2.3 | Connection lifecycle. The dashed line on the left shows that any failure between accept and connect short-circuits straight to the close listener.</span>
<details><summary>ASCII original</summary>

```
WS accept (preauth budget claimed)
   v
send connect.challenge, arm handshake timer
   v
recv connect frame -> verify HMAC -> build client -> release preauth budget
   v
dispatch loop:  req frame -> handleGatewayRequest -> res frame
                event       <- broadcast            -> event frame
   v
close listener (always):
  - unsubscribe session events
  - unregister node
  - clear node-wake / remote node info
  - drop presence, broadcast change
  - release preauth budget if still held
```

</details>

## Section 8. Lifecycle errors and the v2026.5.22 chat-state fix

One of the v2026.5.22 fixes (#85256) is small but illustrative of how the control plane talks to the data plane: "preserve deferred lifecycle-error cleanup across later non-terminal events". The change is in `src/gateway/server-chat.ts` and the test file `server-chat.agent-events.test.ts` describes the bug:

> Without the fix, if an agent run hit a provider timeout (which produces a deferred-cleanup lifecycle error event), and the run then emitted any *later* non-terminal event (e.g. another stream chunk before the final terminator), the deferred error cleanup was canceled — leaving the session stuck in `running` state forever.

The fix is to keep the deferred cleanup armed until the run truly terminates, not just until the next event. The reason this matters for the control plane is that the gateway's view of "which sessions are still active" feeds directly into the shutdown drain we just looked at: if sessions are stuck `running` because of mis-cleared lifecycle errors, the next graceful shutdown will spend its full timeout budget waiting for them.

This is also a reminder that the boundary between the control plane and the agent runtime is not just request/response — the runtime streams a high-volume event flow that the gateway must reduce to "is this session still alive?". The deferred-lifecycle-error logic is part of that reduction.

## Section 9. Graceful shutdown

`createGatewayCloseHandler` is the largest single function in the close module (`src/gateway/server-close.ts:364`). The pieces called in order, with one line each:

1. **`gateway:pre-restart` plugin hook** (lines 451–476): only if this is a restart, fire the hook and warn if it times out.
2. **Reply drain** (lines 478–500): wait for in-flight pending replies up to a configurable budget so messages already heading out to channels are not cut off mid-send.
3. **`session-end-drain`** (lines 502–522): walk the `active-sessions-shutdown-tracker` set and emit synthetic `session_end` events so memory plugins can finalize.
4. **Bonjour stop** (524): tear down mDNS advertisement.
5. **Tailscale cleanup** (527): optionally pull the funnel down so the gateway disappears from the tailnet.
6. **Channel stops** (530–535): tell every channel adapter to disconnect cleanly. This is where Telegram closes its long-poll, Slack its socket-mode connection, etc.
7. **Agent harnesses dispose** (536): cancel and drain any embedded harnesses that are still wired.
8. **Bundle runtimes** (537–552): stop MCP server processes and LSP children with a grace period each.
9. **Plugin services stop** (553–557): plugin lifetime sidecars.
10. **Plugin state store close** (558).
11. **Config reloader stop** (559–561): the chokidar watcher.
12. **Misc external watchers** (562–564): Gmail watcher and friends.
13. **Cron stop, heartbeat stop** (565–566): the gateway-owned schedulers (see Addendum 02a).
14. **Task registry maintenance stop** (567–569).
15. *…and many more — WebSocket close, HTTP close, dedupe timers, media cleanup, etc.*

The whole choreography is wrapped in `measureCloseStep` (every step records its duration) and `shutdownStep` (every step catches its own exception and records it as a warning). A failure anywhere does not abort the rest; we keep going so a Telegram socket error does not leave the Mac app dangling on its WebSocket.

The two key takeaways:

- **Reply drain comes before channel stop.** If we stopped Telegram first, replies in flight would never reach the user.
- **Cron and heartbeat stop late, but the *config reloader stops first*.** Why? Because a config reload during shutdown could re-arm everything we're trying to tear down.

## Section 10. The agent app-server channel

The agent runtime is its own world (Chapter 11), but the gateway has to forward events between agents and clients. The most common runtime is Codex's app-server protocol; you can see the relevant glue in `src/agents/harness/codex-app-server-extensions.ts` and `src/agents/cli-runner/bundle-mcp-codex.ts`. From the gateway's perspective:

- An agent run is spawned via the agent harness (a long-lived child process, e.g. `codex app-server`).
- The child speaks a streaming JSON protocol over stdio.
- A subscriber pipeline inside `server.impl.ts` (`startGatewayEventSubscriptions` at line 1093) converts those events into `broadcast(...)` calls that fan out to the right subset of WebSocket clients.
- When the gateway needs to abort a run, it goes through `chatAbortControllers` (see line 1369 for where they're wired into the request context).

For a complete trace of the agent forwarding pipeline, see the narrative tour (Chapter 14 in the tour index) — chasing it down through `server-chat.ts`, `agent-event-assistant-text.ts`, and `pi-embedded-runner/run/*` would balloon this chapter. The point of mentioning it here is that **the broadcast registry is the only path agent events take to the outside world**. If a Telegram user sees no reply, the bug is in one of: the agent harness, the broadcast subscriber, the channel adapter — and chapter 7 (channel architecture) tells you how to find which.

## Section 11. Startup performance: the catalog cache simplification

The CHANGELOG mentions two startup-perf items: "reduce gateway benchmark filesystem churn" and the channel-catalog-cache simplification (commit `cefea04b9e`).

The cache lives in `src/channels/bundled-channel-catalog-read.ts`:

```ts
// src/channels/bundled-channel-catalog-read.ts:23
const officialCatalogFileCache = new Map<string, ChannelCatalogEntryLike[] | null>();
const bundledPackageCatalogCache = new Map<string, ChannelCatalogEntryLike[] | null>();
```

Both maps cache by absolute file path. The `| null` sentinel records "we already tried, the file does not exist", so the second call does not even hit the filesystem. Then `listBundledChannelCatalogEntries` (line 119) merges the two sources into a deterministic ordered list. The startup hot path used to re-do the directory walk and JSON parse every time a different module asked for the bundled catalog; with these process-stable caches, the per-call cost drops to a Map lookup.

The complementary change `perf(gateway): reduce startup filesystem probes` (`555cc66a37`) is similar: `src/infra/path-env.ts` no longer probes likely-missing macOS Linuxbrew paths during startup, because every miss costs a `stat` round-trip. Across plugins and channels these saved probes add up to hundreds of milliseconds on a cold start.

## Section 12. The layered call graph

The complete read-stack from a TCP byte to a side effect:

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="layered call graph">
<rect x="0" y="0" width="760" height="380" fill="#f1f5f9"/>
<rect x="20" y="20" width="720" height="340" fill="#ffffff" stroke="#cbd5e1"/>
<text x="380" y="46" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="700" fill="currentColor">Gateway control plane: layered call graph</text>
<rect x="40" y="70" width="680" height="40" fill="#fed7aa" stroke="#ea580c"/>
<text x="60" y="92" font-family="sans-serif" font-size="12" font-weight="700" fill="#7c2d12">Transport</text>
<text x="60" y="105" font-family="sans-serif" font-size="11" fill="#7c2d12">node:http + ws WebSocketServer (http-listen.ts, server-runtime-state.ts)</text>
<line x1="380" y1="110" x2="380" y2="125" stroke="#64748b" stroke-width="2" marker-end="url(#a6)"/>
<rect x="40" y="125" width="680" height="40" fill="#99f6e4" stroke="#0d9488"/>
<text x="60" y="147" font-family="sans-serif" font-size="12" font-weight="700" fill="#134e4a">Connection layer</text>
<text x="60" y="160" font-family="sans-serif" font-size="11" fill="#134e4a">handshake + auth + ping + frame parse (ws-connection.ts, ws-connection/message-handler.ts)</text>
<line x1="380" y1="165" x2="380" y2="180" stroke="#64748b" stroke-width="2" marker-end="url(#a6)"/>
<rect x="40" y="180" width="680" height="40" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="60" y="202" font-family="sans-serif" font-size="12" font-weight="700" fill="#4c1d95">Router / guards</text>
<text x="60" y="215" font-family="sans-serif" font-size="11" fill="#4c1d95">scope auth + startup gate + rate limit + handler lookup (server-methods.ts)</text>
<line x1="380" y1="220" x2="380" y2="235" stroke="#64748b" stroke-width="2" marker-end="url(#a6)"/>
<rect x="40" y="235" width="335" height="40" fill="#f0fdf4" stroke="#16a34a"/>
<text x="60" y="257" font-family="sans-serif" font-size="12" font-weight="700" fill="#14532d">Handlers (core)</text>
<text x="60" y="270" font-family="sans-serif" font-size="11" fill="#14532d">server-methods/*.ts &middot; chat, channels, cron, agents, ...</text>
<rect x="385" y="235" width="335" height="40" fill="#f0fdf4" stroke="#16a34a"/>
<text x="405" y="257" font-family="sans-serif" font-size="12" font-weight="700" fill="#14532d">Handlers (plugins / aux)</text>
<text x="405" y="270" font-family="sans-serif" font-size="11" fill="#14532d">plugin gatewayHandlers + aux extraHandlers</text>
<line x1="200" y1="275" x2="200" y2="290" stroke="#64748b" stroke-width="2" marker-end="url(#a6)"/>
<line x1="560" y1="275" x2="560" y2="290" stroke="#64748b" stroke-width="2" marker-end="url(#a6)"/>
<rect x="40" y="290" width="680" height="50" fill="#fef2f2" stroke="#dc2626"/>
<text x="60" y="310" font-family="sans-serif" font-size="12" font-weight="700" fill="#991b1b">Orchestrators (cross-cutting state)</text>
<text x="60" y="325" font-family="sans-serif" font-size="11" fill="#991b1b">cron service &middot; heartbeat runner &middot; broadcast registry &middot; channelManager &middot;</text>
<text x="60" y="338" font-family="sans-serif" font-size="11" fill="#991b1b">configReloader &middot; pluginServices &middot; chatRunState &middot; nodeRegistry</text>
<defs>
<marker id="a6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#64748b"/></marker>
</defs>
</svg>
<span class="figure-caption">Figure R2.3 (alt) | Read the file from top to bottom: each layer only sees the API of the layer above it.</span>
<details><summary>ASCII original</summary>

```
[Transport]   node:http + ws.WebSocketServer
     v
[Connection]  handshake + auth + ping + parse frame
     v
[Router]      authorize + startup-gate + rate-limit + getHandler
     v
[Handlers]    core handlers / plugin handlers / aux handlers
     v
[Orchestrator] cron, heartbeat, broadcast, channelManager, configReloader, ...
```

</details>

This layering is enforced by imports: handlers do not import `ws-connection.ts`, the connection layer does not import `cron`, and the cron service does not import the WebSocket types. The few cross-cutting things that *do* need to talk to the connection layer (e.g. broadcasting an event to all connected clients) go through `broadcast(event, payload, opts)` — a function provided to handlers via the `GatewayRequestContext`, never as a direct import of a connection map.

## Recap

The control plane is the gateway when you erase the channel adapters and the agent runtime. Reading the gateway is reading three movements that recur:

1. **Win the singleton.** `acquireGatewayLock` + the keep-alive `setInterval` in `waitForever` are how a daemon stays a daemon.
2. **Bind, then build the registry.** `listenGatewayHttpServer` retries TIME_WAIT, and a single typed registry merges core + plugin + aux descriptors with no duplicate-name backdoor.
3. **Dispatch, then clean up.** Every frame walks the four guards in `handleGatewayRequest`; every disconnect runs the `close` listener; every shutdown walks `createGatewayCloseHandler` in a deterministic order.

The cron scheduler is one of the orchestrators that sits at the bottom of the figure above. Because it has its own state machine, its own persistence format, and its own delivery story, we cover it separately in Addendum 02a.

Chapter 03 picks up where this chapter stops: how plugins extend the method registry, how channel adapters plug into `channelManager`, and how the `gateway.restart.request` RPC kicks off a full restart cycle that lands us back at Section 2.
