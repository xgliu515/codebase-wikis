# Tour Step 01: After typing `openclaw gateway`

Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

There is no OpenClaw process. There is a shell, a user, and a Node binary somewhere on the `PATH`. The user types:

```
openclaw gateway
```

and presses Enter. The shell resolves `openclaw` to the executable shipped with the npm package — that is the file `openclaw.mjs` at the repository root (`openclaw.mjs:1` has the `#!/usr/bin/env node` shebang). Node starts evaluating it.

Our job in this step is to follow the bytes from "Node has begun executing `openclaw.mjs`" to "the gateway command handler is one stack frame away from running". By the end of the step the process is alive, its `argv` has been normalized for Windows quirks and `--no-color` / `--profile` flags, the title has been set to `"openclaw"`, the warning filter is installed, and `runCli` inside `src/cli/run-main.ts` is about to route `gateway` to its command handler. **No port is bound yet. No socket exists.** That is the next step's job.

## 2. The problem

Starting a long-lived gateway looks trivial — read `argv`, dispatch to a handler. In practice, OpenClaw's entry point is the single binary that ships to every user's machine, run on Windows / macOS / Linux, often via `nvm`, sometimes from a source checkout, sometimes from a global npm install. The problem the entry sequence must solve is:

> Cleanly transition from "an arbitrary Node process started by a CLI shim" to "the gateway command handler is about to execute", while (a) refusing unsupported Node versions with a readable error, (b) serving `openclaw --version` and `openclaw --help` in tens of milliseconds without paying any heavy import cost, (c) not double-running when `entry.js` happens to be imported as a shared library, (d) honoring profile / container env overrides **before** any module side effect can read the wrong env, (e) gracefully respawning itself when the Node `compile-cache` configuration is wrong, and (f) forwarding Unix signals to a respawned child so `Ctrl+C` actually stops what the user thinks they are stopping.

## 3. Naive approach

`node entry.ts`. Or, equivalently, a one-line `bin/openclaw` script that just imports `dist/entry.js` and lets a CLI library (Commander, yargs, etc.) parse `process.argv`. The user typed `gateway`, Commander finds the `gateway` subcommand, calls its action. Done.

## 4. Why the naive approach breaks

The single-line entry breaks in concrete, observable ways:

- **`openclaw --version` becomes slow and noisy.** A naive entry imports the whole CLI tree at top level. `--version` then pays for parsing every Commander subcommand, loading every plugin, touching `package.json` files for each one. What should be a 30 ms answer becomes a 1–3 second tax on every shell prompt that calls it.
- **Unsupported Node versions crash deep inside a stranger's stack.** OpenClaw requires Node 22.19 or newer (`openclaw.mjs:11-13`). A user on Node 18 with the naive entry will get a `SyntaxError: Unexpected token` from some random ESM dependency twelve frames deep. They have no way to map that to "upgrade Node".
- **`entry.js` is also imported by `dist/index.js`** in the bundler's output graph. If `entry.ts` runs its top-level side effects unconditionally (start gateway, install signal handlers, set `process.title`), then anything that ever imports the package as a library boots a *second* gateway in the same process. The second startup fails on the lock or port, but the wreckage is left in a half-initialized state.
- **Windows argv quirks corrupt arguments silently.** `cmd.exe` and PowerShell do their own quoting; `process.argv` arrives subtly different than on Unix. A naive parser sees `--profile=foo` as the literal string ` --profile=foo` (with a leading space) and the flag silently fails to match.
- **Profile env must mutate `process.env` before modules read it.** Subsystems read `process.env.OPENCLAW_*` at module top-level. If `--profile dev` is honored only after Commander dispatches, the wrong env has already been latched into closures.
- **Wrong compile-cache directory wastes startup on every invocation.** When OpenClaw is installed as a packaged tarball, Node's `module.enableCompileCache` should point at a versioned, per-install directory so that subsequent boots reuse the V8 byte-compilation. The naive entry has no notion of "this is a packaged install vs a source checkout", and the cache either is not used at all or is shared incorrectly.
- **`Ctrl+C` orphans a respawn child.** When OpenClaw needs to respawn itself with corrected `NODE_OPTIONS`, the launcher becomes a parent of the child gateway. A naive `process.on('SIGINT', () => process.exit())` exits the parent immediately; the child becomes an orphan, still bound to the port, with nobody watching it.

The core tension: business code (command parsing) **must** be strictly later than environment governance (Node check, env normalization, respawn decisions). The naive entry inverts the order, and every one of the above failures is a symptom of that inversion.

## 5. OpenClaw's approach

OpenClaw's approach is to split the entry into **two layers that execute in strict order, environment governance first, business code second**, and within each layer to do every expensive thing lazily.

**Layer one: the `openclaw.mjs` launcher.** This file is deliberately pure ESM JavaScript (not TypeScript) because it must run before any TS compilation pipeline exists. From top to bottom:

1. `ensureSupportedNodeVersion()` runs at `openclaw.mjs:42`, **before any other import**, and prints a `nvm install 22` message followed by `process.exit(1)` if the Node version is below 22.19. The user gets one human sentence, not a stack trace.
2. Compile-cache decision logic at `openclaw.mjs:44-85` decides whether this is a source checkout (presence of `.git` or `src/entry.ts`) or a packaged install, and which compile-cache directory is correct.
3. `respawnWithoutCompileCacheIfNeeded` and `respawnWithPackagedCompileCacheIfNeeded` at `openclaw.mjs:183-231` re-`spawn` the launcher with corrected env when needed. The spawning happens through `runRespawnedChild` at `openclaw.mjs:94`, which installs signal listeners for `SIGTERM`/`SIGINT`/`SIGHUP`/`SIGQUIT` (Unix) or `SIGTERM`/`SIGINT`/`SIGBREAK` (Windows) and forwards them to the child with a 1 second grace, then a SIGKILL — solving the orphan problem.
4. **Fast paths.** If `--help` or a precomputed command help text applies, the launcher writes the precomputed text from `dist/cli-startup-metadata.json` and returns without ever loading the TypeScript runtime (`openclaw.mjs:427-470`).
5. Only when nothing has short-circuited does the launcher `await tryImport("./dist/entry.js")` at `openclaw.mjs:479`, handing control to layer two.

**Layer two: `src/entry.ts`.** The very first thing it does, before any side effect, is gate on `isMainModule` at `src/entry.ts:79-86`. If `entry.js` is being imported as a dependency (the bundler-graph case), every side effect below is skipped. Only when this file is the actual entry point do we proceed.

Inside the `isMainModule` branch:

- Compile-cache respawn is reconsidered from the TS side at `src/entry.ts:88-92` (`respawnWithoutOpenClawCompileCacheIfNeeded` in `src/entry.compile-cache.ts`). If a respawn is needed, this process exits and the new one re-enters here.
- `process.title = "openclaw"` at `src/entry.ts:94` so `ps` / Activity Monitor identify the process.
- `installProcessWarningFilter()` and `normalizeEnv()` at `src/entry.ts:96-97` install the same warning filter the launcher already tried (idempotent) and normalize `process.env` (e.g. collapse empty-string values).
- `--no-color` is translated to `NO_COLOR=1` and `FORCE_COLOR=0` at `src/entry.ts:108-111`.
- `process.argv = normalizeWindowsArgv(process.argv)` at `src/entry.ts:124` repairs the cmd.exe quoting issue.
- `ensureCliRespawnReady()` at `src/entry.ts:113-122` may respawn one more time to fix `NODE_OPTIONS` (e.g. add `--disable-warning=ExperimentalWarning`).
- `parseCliContainerArgs` / `parseCliProfileArgs` / `applyCliProfileEnv` at `src/entry.ts:127-150` parse and apply `--container` and `--profile` / `--dev`, mutating `process.env` **before** `runMainOrRootHelp` is called, which is **before** any business module evaluates env-dependent constants.
- `tryHandleRootVersionFastPath` at `src/entry.ts:153` handles `openclaw --version` without loading `run-main.ts` at all.
- Finally, `runMainOrRootHelp(process.argv)` at `src/entry.ts:154` is invoked. Inside it, `src/entry.ts:282-306`, after also trying root-help and precomputed command-help fast paths, the function does `await import("./cli/run-main.js")` and calls `runCli(argv)` at `src/cli/run-main.ts:452`.

This is where this step ends. `runCli` will detect the `gateway` argv via `isGatewayRunFastPathArgv` at `src/cli/run-main.ts:103` and route through `tryRunGatewayRunFastPath` at `src/cli/run-main.ts:145` to the `gateway` command handler — but that handler's body is the next step.

The whole sequence is one long argument against the naive approach: every check above (Node version, isMainModule, compile-cache, signal forwarding, Windows argv, profile env timing, fast paths) corresponds to one of the failure modes from section 4.

## 6. Code locations

- `openclaw.mjs:11-13` — `MIN_NODE_MAJOR=22`, `MIN_NODE_MINOR=19`. The version gate threshold.
- `openclaw.mjs:27-40` — `ensureSupportedNodeVersion`, the human-readable error with `nvm` instructions.
- `openclaw.mjs:42` — version gate invoked before any other top-level statement.
- `openclaw.mjs:87-90` — platform-specific `respawnSignals` list.
- `openclaw.mjs:94-181` — `runRespawnedChild`, the parent-side signal forwarder with grace-then-kill semantics.
- `openclaw.mjs:148-163` — signal listener registration that forwards to the child.
- `openclaw.mjs:183-231` — `respawnWithoutCompileCacheIfNeeded` and `respawnWithPackagedCompileCacheIfNeeded`.
- `openclaw.mjs:233-234` — `waitingForCompileCacheRespawn` flag.
- `openclaw.mjs:427-470` — root-help and precomputed-command-help fast paths.
- `openclaw.mjs:472-487` — final dispatch into `./dist/entry.js`.
- `src/entry.ts:21-24` — `ENTRY_WRAPPER_PAIRS`, the wrapper/entry basename pairs recognized by the `isMainModule` check.
- `src/entry.ts:79-86` — `isMainModule` guard preventing double-run.
- `src/entry.ts:88-92` — TS-side compile-cache respawn check.
- `src/entry.ts:94` — `process.title = "openclaw"`.
- `src/entry.ts:96-97` — warning filter installation, env normalization.
- `src/entry.ts:108-111` — `--no-color` → `NO_COLOR`/`FORCE_COLOR`.
- `src/entry.ts:113-122` — `ensureCliRespawnReady`, third-tier respawn for `NODE_OPTIONS`.
- `src/entry.ts:124` — `normalizeWindowsArgv` repairs Windows argv quoting.
- `src/entry.ts:127-150` — container and profile argv parsing, profile env applied.
- `src/entry.ts:153` — `tryHandleRootVersionFastPath`.
- `src/entry.ts:154` — `runMainOrRootHelp(process.argv)`.
- `src/entry.ts:282-306` — `runMainOrRootHelp` implementation; dynamic `import("./cli/run-main.js")` and `await runCli(argv)`.
- `src/entry.compile-cache.ts` — `enableOpenClawCompileCache`, `resolveEntryInstallRoot`, `respawnWithoutOpenClawCompileCacheIfNeeded`.
- `src/entry.respawn.ts:34-130` — `resolveCliRespawnCommand`, `buildCliRespawnPlan`, `runCliRespawnPlan`.
- `src/entry.version-fast-path.ts:4` — `tryHandleRootVersionFastPath`.
- `src/infra/is-main.ts:36` — `isMainModule` resolver with wrapper-pair awareness.
- `src/cli/run-main.ts:452` — `runCli`, where this step hands off to the next.

## 7. Branches and extensions

We followed only the clean `openclaw gateway` happy path. The branches we deliberately skipped here:

- **Root help / version fast paths.** `openclaw --help` and `openclaw --version` short-circuit before `runCli` is ever called. The mechanism — precomputed text written to `dist/cli-startup-metadata.json` at build time, plus a live fallback — is the kind of perf tax-the-common-case-pays-nothing pattern that recurs throughout OpenClaw. See Chapter 01 §4 in [01-architecture-overview.md](./01-architecture-overview.md#4-process-startup-chain) for the full launcher chain and where the fast paths sit.
- **`--profile` and `--container`.** These rewrite `process.env` and `process.argv` *before* business modules read them. The mechanics — why it must be timed this way and how `applyCliProfileEnv` interacts with subsystem env reads — are covered in Chapter 03 §5 of [03-config-system.md](./03-config-system.md#5-cli-overrides-and-profile-env).
- **Read-only auth store for `secrets audit`.** `shouldForceReadOnlyAuthStore` at `src/entry.ts:29-37` flips `OPENCLAW_AUTH_STORE_READONLY` when the argv path is `secrets audit`. That guarantees the audit command cannot accidentally mutate the secrets file. See Chapter 14 §2 in [14-auth-and-security.md](./14-auth-and-security.md#2-the-read-only-auth-store-path) for the security boundary it protects.
- **Respawn for `NODE_OPTIONS`.** If `NODE_OPTIONS` is missing the experimental-warning suppression, `buildCliRespawnPlan` returns a plan and `runCliRespawnPlan` re-execs. The whole respawn graph (compile-cache respawn × profile respawn × NODE_OPTIONS respawn) is sequenced so they converge in at most a fixed number of generations.
- **Plugin CLI commands.** Anything that is not a known built-in subcommand triggers plugin command registration further down `runCli`. That is a long path we ignore here.

## 8. What you should now have in your head

- OpenClaw's boot is **strictly two-layered**: the pure-JS `openclaw.mjs` launcher does environment governance (Node version, compile cache, respawn, signal forwarding, fast paths), and only then hands off to TypeScript `src/entry.ts`, which does another round of environment work (`isMainModule`, `process.title`, env normalization, Windows argv repair, profile env, `--version` fast path) before invoking `runCli`. Business code is *always* later than environment governance.
- The `isMainModule` guard at `src/entry.ts:79` is what prevents a second gateway from booting when `entry.js` is imported as a library — a real, observed failure mode that the comment in the file calls out by name.
- The launcher forwards Unix signals to its respawn child with a **1 second grace then SIGKILL** (`openclaw.mjs:91-92`, `127-147`). The child cannot ignore `Ctrl+C` to outlive its parent.
- `--version` and `--help` pay nothing for OpenClaw's plugin / runtime weight: the launcher reads precomputed text from `dist/cli-startup-metadata.json` and exits. The CLI's perf strategy is "fast paths first, everything else lazy".
- This step ends with `runCli(argv)` about to enter `src/cli/run-main.ts:452`. Nothing is listening on a port; nothing is bound; nothing on disk has been touched. The next step is where the gateway actually starts.
