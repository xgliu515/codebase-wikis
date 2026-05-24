# Chapter 03: Configuration System

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

A personal AI assistant gateway has an awkward configuration problem. The same settings need to be reachable from at least four different angles — a JSON file the operator edits, environment variables a systemd unit sets, CLI flags during interactive debugging, and runtime mutations a chat command pushes through — and **no one source can be treated as primary**, because an operator switching between modes will inevitably forget which one is "winning" right now. This chapter explains how `src/config/` solves that, layer by layer.

---

## 1. The Problem

Imagine three operators of the same gateway:

- Alice runs the production daemon. Her `~/.openclaw/openclaw.json` is authoritative; she does not pass CLI flags.
- Bob ships a container. His `openclaw.json` is baked in, but the port and the gateway token come from `OPENCLAW_GATEWAY_PORT` and `OPENCLAW_GATEWAY_TOKEN` set by Docker.
- Carol is debugging on her laptop. She launches with `openclaw gateway --port 19001 --verbose`, mid-session edits `~/.openclaw/openclaw.json` to add a new plugin, and expects the live process to notice.

A naive design would make one of these primary and the rest "overrides", but every choice loses one of the three workflows. The actual design declares a **layered resolution order**, makes the order observable, and ensures every layer can be expressed in terms of the same `OpenClawConfig` shape so they merge cleanly. It also guarantees that the **on-disk file remains the source of truth for persistence** — overrides are in-process unless explicitly written back.

The trade-off OpenClaw makes:

| Layer | When applied | Lifetime | Where it lives |
|-------|--------------|----------|----------------|
| Built-in defaults | Compiled in | Forever | `src/config/defaults.ts`, `src/config/schema.ts` |
| Config file (`openclaw.json`) | Each read | On disk | `~/.openclaw/openclaw.json` |
| `$include` directives | Resolution time | On disk | `src/config/includes.ts` |
| `${ENV}` substitutions | Resolution time | At read time | `src/config/env-substitution.ts` |
| Environment variables (`OPENCLAW_*`) | Each read | Process lifetime | `src/config/paths.ts`, `src/config/state-dir-dotenv.ts` |
| CLI flag overrides | Argument parse | Process lifetime | `src/cli/gateway-cli/run.ts`, `src/config/runtime-overrides.ts` |
| Runtime overrides | Mid-session | Process lifetime | `src/config/runtime-overrides.ts` |

Sections 2-7 walk this table top to bottom.

---

## 2. The `OpenClawConfig` Schema

The canonical type lives at `src/config/types.openclaw.ts:54`:

```ts
export type OpenClawConfig = {
  $schema?: string;
  meta?: { lastTouchedVersion?: string; lastTouchedAt?: string };
  auth?: AuthConfig;
  accessGroups?: AccessGroupsConfig;
  acp?: AcpConfig;
  env?: { shellEnv?: { ... }; vars?: Record<string, string>; [key: string]: ... };
  // ...
  channels?: ChannelsConfig;
  agents?: AgentsConfig;
  tools?: ToolsConfig;
  bindings?: AgentBinding[];
  plugins?: PluginsConfig;
  secrets?: SecretsConfig;
  // ...
  gateway?: GatewayConfig;
  memory?: MemoryConfig;
  mcp?: McpConfig;
  proxy?: ProxyConfig;
};
```

The file is intentionally a tree of `Partial`-style sections. Every section is `?`-optional and imported from a dedicated `types.<section>.ts` so that a section's full schema can be edited without ripping through the rest. The sub-types live in:

- `src/config/types.gateway.ts` — `GatewayConfig`, `DiscoveryConfig`, `TalkConfig`
- `src/config/types.channels.ts` — per-channel sub-config plus `dmPolicy`, `allowFrom`
- `src/config/types.agents.ts` — agent definitions, defaults, model bindings
- `src/config/types.tools.ts` — tool allowlist/denylist plus per-tool settings
- `src/config/types.plugins.ts` — plugin installs, registry config, allowlist
- `src/config/types.secrets.ts` — `SecretRef` indirection
- `src/config/types.skills.ts` — skill registry config
- `src/config/types.cron.ts`, `types.hooks.ts`, `types.mcp.ts`, `types.memory.ts`, `types.auth.ts`, ...

The `$schema` field at the top exists so editors can pick up a JSON Schema for autocompletion. The `meta` block (`src/config/types.openclaw.ts:56-61`) is purely informational — it records the last OpenClaw version that wrote the file and an ISO timestamp, used by `doctor` to spot configs written by a newer-than-installed version and refuse to start the gateway. `AGENTS.md:49` reinforces this: "Retired public keys stay retired; compat in raw migration/doctor only."

### 2.1 Three branded variants

A subtle but important detail at `src/config/types.openclaw.ts:160-168`:

```ts
declare const openClawConfigStateBrand: unique symbol;

type BrandedConfigState<TState extends string> = OpenClawConfig & {
  readonly [openClawConfigStateBrand]?: TState;
};

export type SourceConfig = BrandedConfigState<"source">;
export type ResolvedSourceConfig = BrandedConfigState<"resolved-source">;
export type RuntimeConfig = BrandedConfigState<"runtime">;
```

These three are the **same shape** but a phantom brand prevents confusing them at compile time.

- `SourceConfig` — exactly what is on disk, no `$include` or `${ENV}` resolution yet.
- `ResolvedSourceConfig` — after `$include` resolution and `${ENV}` substitution, **before** runtime defaults are applied.
- `RuntimeConfig` — after defaults have been merged in.

A `ConfigFileSnapshot` (`src/config/types.openclaw.ts:182-207`) carries all three plus the raw bytes and validation issues:

```ts
export type ConfigFileSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  sourceConfig: ResolvedSourceConfig;
  resolved: ResolvedSourceConfig;
  valid: boolean;
  runtimeConfig: RuntimeConfig;
  /** @deprecated Prefer runtimeConfig. */
  config: RuntimeConfig;
  hash?: string;
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
  legacyIssues: LegacyConfigIssue[];
};
```

Why three variants? Because **write-back has to use `ResolvedSourceConfig`** (writing `runtimeConfig` would leak runtime defaults into the on-disk file), but **read paths want `runtimeConfig`** (which has defaults filled in). The brand makes mixing them up a type error rather than a runtime puzzle.

### 2.2 Defaults

Built-in defaults live in `src/config/defaults.ts` and `src/config/schema.ts` (a Zod-based schema in `zod-schema.*.ts` files). The defaults function is invoked late, when materialising a snapshot to `RuntimeConfig` (`src/config/materialize.ts`'s `materializeRuntimeConfig`). Defaults are not constants — they depend on context. A few examples from `src/config/defaults.ts`:

- `DEFAULT_MODEL_MAX_TOKENS = 8192` (`src/config/defaults.ts:49`) is the cap an unset model gets.
- `DEFAULT_AGENT_MAX_CONCURRENT` and `DEFAULT_SUBAGENT_MAX_CONCURRENT` (`src/config/defaults.ts:6-8`, imported from `agents/defaults.js`) are filled in only when `agents.defaults.maxConcurrent` is unset (`src/config/defaults.ts:411-417`).
- Channel defaults plug in per-channel — `dmPolicy="pairing"` for Telegram/WhatsApp/Slack/Discord/etc. so an unconfigured DM never reaches the agent.

The merge is *not* a deep `Object.assign`. It is a curated function per section because shapes vary — `bindings` is an array (matched by binding key, not index), `agents.defaults.models` has fallback chains, `channels.<id>.allowFrom` is a set, etc.

---

## 3. Config File Loading

### 3.1 Where the file lives

`src/config/paths.ts:22-24` declares the filenames:

```ts
const NEW_STATE_DIRNAME = ".openclaw";
const CONFIG_FILENAME = "openclaw.json";
const LEGACY_CONFIG_FILENAMES = ["clawdbot.json"] as const;
```

The canonical config path is **derived from the state directory**: `~/.openclaw/openclaw.json` by default, or `$OPENCLAW_STATE_DIR/openclaw.json`. `src/config/paths.ts:154-163` is the resolver:

```ts
export function resolveCanonicalConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
): string {
  const override = env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env, envHomedir(env));
  }
  return path.join(stateDir, CONFIG_FILENAME);
}
```

A separate function — `resolveConfigPathCandidate` (`src/config/paths.ts:169-188`) — searches across multiple candidate locations (current state dir, legacy `.clawdbot` dir, legacy filename `clawdbot.json`) and picks the first existing file. This is the rename-tolerance layer: an upgrade from the pre-rebrand `clawdbot` tool still works without forcing the operator to move files.

### 3.2 Parse with JSON5

Despite the `.json` suffix, the parser is **JSON5** (`src/config/io.ts:5`, `src/config/io.ts:982`):

```ts
export function parseConfigJson5(
  raw: string,
  json5: { parse: (value: string) => unknown } = JSON5,
): ParseConfigJson5Result {
  try {
    return { ok: true, parsed: json5.parse(raw) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
```

JSON5 permits **comments** and **trailing commas**, which matter when humans edit configs. The compromise is that strict JSON tools (jq filtering, GitHub schema validators) will complain — so the convention is to keep the file JSON5-compatible-but-JSON-like in practice. The header comment in `src/config/includes.ts:7-10` demonstrates the style:

```json5
{
  "$include": "./base.json5",           // single file
  "$include": ["./a.json5", "./b.json5"] // merge multiple
}
```

### 3.3 `$include` directives

A config can split itself into multiple files. `src/config/includes.ts:21-23` defines the bounds:

```ts
export const INCLUDE_KEY = "$include";
export const MAX_INCLUDE_DEPTH = 10;
export const MAX_INCLUDE_FILE_BYTES = 2 * 1024 * 1024;
```

The `$include` key may appear at any object level; values can be a single string or an array of strings. Default scope is **the directory containing `openclaw.json`** — `$include` cannot reach outside it unless `OPENCLAW_INCLUDE_ROOTS` is set (`src/config/paths.ts:119-145`). Allowed roots are tilde-expanded, resolved to absolute paths, deduplicated, and filtered down to absolute-only entries. This is a small but real security boundary: a config that arrived from an untrusted source cannot silently pull `/etc/shadow` into itself.

The actual include resolver (`resolveConfigIncludes`, called at `src/config/io.ts:1756-1758`) walks the tree, reads referenced files via `readConfigIncludeFileWithGuards` (which honours the size cap and the path containment check), and merges them. Cycles up to 10 levels are detected; the 11th level throws `CircularIncludeError` (re-exported as `src/config/io.ts:127`).

### 3.4 Validation

Once the raw object is parsed and `$include`-resolved, validation runs. `src/config/validation.ts:913` exposes `validateConfigObjectWithPlugins`:

```ts
export function validateConfigObjectWithPlugins(
  raw: unknown,
  // ...
): ValidationResult {
  return validateConfigObjectWithPluginsBase(raw, { ... });
}
```

There are two flavours: one with plugin metadata (validates plugin-extension config sections against the manifest's declared schema) and one without (for early-startup contexts before plugins are loaded). Validation returns a list of `ConfigValidationIssue` (`src/config/types.openclaw.ts:170-175`):

```ts
export type ConfigValidationIssue = {
  path: string;
  message: string;
  allowedValues?: string[];
  allowedValuesHiddenCount?: number;
};
```

Issues are split into `issues` (fatal), `warnings` (non-fatal but logged), and `legacyIssues` (config keys that were valid in a previous version but should be migrated). The startup snapshot exposes all three; `openclaw doctor --fix` knows how to act on legacy issues without touching the rest of the file.

### 3.5 Schema migration

OpenClaw does **not** do load-time migrations on the live config. `AGENTS.md:37` is explicit: "Legacy config repair belongs in `openclaw doctor --fix`, not startup/load-time core migrations. Runtime paths use canonical contracts."

That means startup will surface a legacy key as a `legacyIssue` rather than silently rewriting the file. The user (or `doctor --fix`) is the one who promotes the file forward. The benefit is auditability: a daemon restart will never silently mutate the file on disk.

The only migration that *does* happen at read time is plugin-install-record migration (`migrateAndStripShippedPluginInstallConfigRecords`, called at `src/config/io.ts:1794-1801`) — that is moving plugin install records out of the main config and into a sibling index file. It returns an in-memory altered config but does not persist unless told to.

---

## 4. Environment Variable Overrides

OpenClaw distinguishes two roles for env vars:

1. **Path/bootstrap vars** — `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_HOME`, `OPENCLAW_PROFILE`. These are read **before** the config file is parsed because they decide *where* the file is.
2. **Value vars** — `OPENCLAW_GATEWAY_PORT`, `OPENCLAW_GATEWAY_TOKEN`, etc. These are read alongside the config file and override specific fields.

### 4.1 Path/bootstrap vars

These all live in `src/config/paths.ts` and `src/infra/home-dir.ts`. The full chain:

- `OPENCLAW_HOME` (`src/infra/home-dir.ts:25`) — overrides `os.homedir()` for everything else. Used by tests, devcontainers, and `--profile`.
- `OPENCLAW_STATE_DIR` (`src/config/paths.ts:65-89`) — the state directory; defaults to `~/.openclaw`, with `.clawdbot` fallback if the new dir does not exist but the legacy one does.
- `OPENCLAW_CONFIG_PATH` (`src/config/paths.ts:158-162`) — explicit override for the config file path.
- `OPENCLAW_PROFILE` (`src/cli/profile.ts:99`) — set by `--profile <name>` to retarget state-dir and gateway port at once.
- `OPENCLAW_NIX_MODE=1` (`src/config/paths.ts:14-16`) — declares the install is under Nix, which disables auto-install flows and refuses load-time config writes.
- `OPENCLAW_INCLUDE_ROOTS` (`src/config/paths.ts:119-145`) — colon/semicolon-separated extra dirs `$include` can resolve into.

The state-dir-pinning logic at `src/config/paths.ts:91-97` is small but consequential:

```ts
export function normalizeStateDirEnv(env: NodeJS.ProcessEnv = process.env): void {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, envHomedir(env));
  const openclawOverride = env.OPENCLAW_STATE_DIR?.trim();
  if (openclawOverride) {
    env.OPENCLAW_STATE_DIR = resolveUserPath(openclawOverride, env, effectiveHomedir);
  }
}
```

This function is called from `src/cli/gateway-cli/run.ts:473` as the very first line of `runGatewayCommand`. The reason is the **v2026.5.22 fix #52264**: "Gateway/config: pin relative `OPENCLAW_STATE_DIR` overrides to an absolute path at startup so later working-directory changes cannot retarget gateway state." Before the fix, a `cd /tmp` later in the same process could move where session storage lives — which would silently re-target session DB, secrets, and per-channel state mid-run. After the fix, the path is absolute by the time the rest of the boot pipeline reads it.

### 4.2 Value vars

A representative subset, sorted by where they are read:

| Variable | Read at | Effect |
|----------|---------|--------|
| `OPENCLAW_GATEWAY_PORT` | `src/config/paths.ts:333-349` | Overrides `gateway.port`; supports both `18789` and `127.0.0.1:18789` shapes |
| `OPENCLAW_GATEWAY_TOKEN` | `src/cli/gateway-cli/run.ts:645-649` (CLI) and `src/gateway/auth-*.ts` | Bearer token for the WS handshake |
| `OPENCLAW_GATEWAY_PASSWORD` | `src/cli/gateway-cli/run.ts:186-197` | Alternative to token; resolved via password file |
| `OPENCLAW_OAUTH_DIR` | `src/config/paths.ts:284-293` | Overrides `$stateDir/credentials/` for OAuth tokens |
| `OPENCLAW_GATEWAY_STARTUP_TRACE` | `src/entry.ts:39-70` plus stages 3-5 | Emits boot timing breakdown to stderr |
| `OPENCLAW_RAW_STREAM` | `src/cli/gateway-cli/run.ts:505-511` | Captures raw provider streams to disk for replay |
| `OPENCLAW_LIVE_TEST` | `AGENTS.md:136` | Switches Vitest into live-API mode |
| `OPENCLAW_DISABLE_BUNDLED_PLUGINS` | Bundled plugin loader | Skips loading any bundled plugin (used by tests) |
| `OPENCLAW_BUNDLED_PLUGINS_DIR` | Same loader | Points the bundled-plugin discovery at a custom dir |
| `OPENCLAW_TEST_FAST=1` | `src/config/paths.ts:70-72`, `src/config/paths.ts:173` | Skip filesystem checks during tests |

The variable naming convention is rigorously **`OPENCLAW_<SECTION>_<NAME>`**. The full list is enforced by lint (`src/config/env-vars.ts:1-7` re-exports `collectConfigRuntimeEnvVars` and `readStateDirDotEnvVars`, and `src/config/host-env-security.ts` maintains a blocklist of dangerous host env vars that may never be set from config).

### 4.3 The state-dir `.env` file

`src/config/state-dir-dotenv.ts:46-55` allows the state directory to carry its own `.env` file:

```ts
export function readStateDirDotEnvVars(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const stateDir = resolveStateDir(env as NodeJS.ProcessEnv);
  return readStateDirDotEnvVarsFromStateDir(stateDir);
}
```

This is how `~/.openclaw/.env` becomes a stable, **operator-controlled** environment source. The contents are parsed by `dotenv.parse`, then filtered through `isDangerousHostEnvVarName`/`isDangerousHostEnvOverrideVarName` (`src/config/state-dir-dotenv.ts:13-15`) to block keys that could compromise the host (PATH, LD_PRELOAD, NODE_OPTIONS, etc.). This file survives operator shells, systemd restarts, and reboots — it is the durable env-source counterpart to `openclaw.json`'s durable config-source.

The matching CLI loader is at `src/cli/run-main.ts:281-286`:

```ts
function shouldLoadCliDotEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (existsSync(path.join(process.cwd(), ".env"))) {
    return true;
  }
  return existsSync(path.join(resolveStateDir(env), ".env"));
}
```

`cwd`-local `.env` wins for interactive shells, state-dir `.env` is the fallback for daemons where `cwd` is `/` or `/tmp`.

### 4.4 `${VAR}` substitution inside the config file

The config file itself can reference env vars in string values. `src/config/env-substitution.ts:3-21` documents the rules:

```
- Supports `${VAR_NAME}` syntax in string values, substituted at config load time
- Only uppercase env vars are matched: `[A-Z_][A-Z0-9_]*`
- Escape with `$${}` to output literal `${}`
- Missing env vars throw `MissingEnvVarError` with context
```

Example use:

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}"
      }
    }
  }
}
```

A failed substitution does *not* abort the gateway — it becomes a snapshot warning ("Missing env var "X" - feature using this value will be unavailable", `src/config/io.ts:1788-1791`), which lets the gateway start in degraded mode for optional providers but still surfaces the failure prominently.

One pitfall noted in `src/config/config-env-vars.ts:82-90`: when the in-config `env.vars` writes a process env var, values containing an unresolved `${VAR}` reference are **skipped** rather than copied literally. Without the skip, downstream auth resolution might see `OPENCLAW_GATEWAY_TOKEN="${VAULT_TOKEN}"` and accept it as a credential. The comment is honest: "skip values containing unresolved `${VAR}` references — `applyConfigEnvVars` runs before env substitution, so these would pollute `process.env` with literal placeholders ... which downstream auth resolution would accept as valid credentials."

---

## 5. CLI Runtime Overrides

CLI flags fall into two groups: **structured flags** that map to a specific config field (`--port`, `--bind`, `--auth`), and **generic overrides** that touch any path.

### 5.1 Structured flags

`runGatewayCommand` (`src/cli/gateway-cli/run.ts:472-810`) parses the structured flags and applies them in a deliberate order. The relevant chain for the port:

```ts
const portOverride = parsePort(opts.port);
if (opts.port !== undefined && portOverride === null) {
  defaultRuntime.error(formatInvalidPortOption("--port"));
  defaultRuntime.exit(1);
  return;
}
const port = portOverride ?? resolveGatewayPort(cfg);
```

Three sources are considered: CLI `--port`, env `OPENCLAW_GATEWAY_PORT` (inside `resolveGatewayPort`), and `cfg.gateway.port` from the config file. The order matters: CLI > env > config > default. The same precedence is applied for `--bind`, `--auth`, `--tailscale`, `--token`, `--password`, `--password-file`, and `--ws-log`.

For `--token` and `--password`, the values are pushed back into `process.env` (`src/cli/gateway-cli/run.ts:645-649`):

```ts
if (opts.token) {
  const token = toOptionString(opts.token);
  if (token) {
    process.env.OPENCLAW_GATEWAY_TOKEN = token;
  }
}
```

This keeps the rest of the code dealing in only one input shape (env vars) — a small but important uniformity.

### 5.2 Generic runtime overrides

Anything that does not have a dedicated CLI flag can still be overridden. `src/config/runtime-overrides.ts:54-67` is the API:

```ts
export function setConfigOverride(
  pathRaw: string,
  value: unknown,
): { ok: boolean; error?: string } {
  const parsed = parseConfigPath(pathRaw);
  if (!parsed.ok || !parsed.path) {
    return { ok: false, error: parsed.error ?? "Invalid path." };
  }
  setConfigValueAtPath(overrides, parsed.path, sanitizeOverrideValue(value));
  return { ok: true };
}
```

Overrides live in module-scoped `overrides: OverrideTree` state. When `prepareGatewayStartupConfig` runs (`src/gateway/server-startup-config.ts:348-350`), it calls `applyConfigOverrides`:

```ts
const runtimeConfig = await measure("config.auth.runtime-overrides", () =>
  applyConfigOverrides(params.configSnapshot.config),
);
```

`applyConfigOverrides` (`src/config/runtime-overrides.ts:86-91`) is a deep merge: object-typed override values are merged key-by-key into the base config; non-object override values replace. Two safeguards are baked in:

- `sanitizeOverrideValue` (`src/config/runtime-overrides.ts:10-30`) strips `undefined` values and drops blocked object keys (`__proto__`, `constructor`, `prototype` via `isBlockedObjectKey`). This prevents prototype-pollution exploits if an override path comes from a user surface.
- Recursive overrides use a `WeakSet` for cycle detection (`src/config/runtime-overrides.ts:14-29`).

Crucially, **runtime overrides are not written back to disk**. They live only in the process; a daemon restart re-reads the file fresh. To persist a change, `src/cli/config-cli.ts` provides `openclaw config set`, which calls into `replaceConfigFile` (re-exported through `src/config/config.js`).

### 5.3 The chat command bridge

`src/auto-reply/reply/commands-config.ts:10` imports the same `runtime-overrides` module, so chat-command commands like `/option key=value` can mutate runtime config without persisting. Chapter 11 covers this path; the relevant point for now is that the same `setConfigOverride` API services CLI, chat command, and (programmatically) the Control UI.

---

## 6. Hot Reload

Operators expect to edit `openclaw.json` and see the change take effect without restarting the gateway. `src/gateway/config-reload.ts:86-119` starts a `chokidar`-based watcher on the config file:

```ts
export function startGatewayConfigReloader(opts: {
  initialConfig: OpenClawConfig;
  // ...
  readSnapshot: () => Promise<ConfigFileSnapshot>;
  onHotReload: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => Promise<void>;
  onRestart: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>;
  // ...
  watchPath: string;
}): GatewayConfigReloader { ... }
```

When the file changes, the reloader debounces (`settings.debounceMs`), reads a fresh snapshot, computes the diff against the in-memory snapshot, and builds a `GatewayReloadPlan` (`src/gateway/config-reload-plan.ts:11-25`):

```ts
export type GatewayReloadPlan = {
  changedPaths: string[];
  restartGateway: boolean;
  restartReasons: string[];
  hotReasons: string[];
  reloadHooks: boolean;
  restartGmailWatcher: boolean;
  restartCron: boolean;
  restartHeartbeat: boolean;
  restartHealthMonitor: boolean;
  reloadPlugins: boolean;
  restartChannels: Set<ChannelKind>;
  disposeMcpRuntimes: boolean;
  noopPaths: string[];
};
```

The plan is built from a table of reload rules (`src/gateway/config-reload-plan.ts:52-100+`). Each rule says: "for keys under this prefix, the change is either a no-op, a hot-reload (do `actions[]`), or a restart." Selected examples:

- `gateway.remote.*` and `gateway.reload.*` → `none` (metadata about reload itself, no action needed).
- `hooks.gmail` → hot, triggers `restart-gmail-watcher`.
- `hooks.*` → hot, triggers `reload-hooks`.
- `agents.defaults.models` → hot, triggers `restart-heartbeat`.
- `models.pricing` → `restart` (changing pricing live would break running cost reports).
- `models.*` (anything else) → hot, triggers `restart-heartbeat`.
- `skills.*` → invalidates the skills snapshot (`src/gateway/config-reload.ts:41-55`), so sessions rebuild their snapshot on the next turn.
- `channels.<id>.*` → restart channel `<id>` only.

Two safety nets in the reloader:

1. **Missing snapshots retry briefly.** `handleMissingSnapshot` (`src/gateway/config-reload.ts:156-171`) tolerates up to `MISSING_CONFIG_MAX_RETRIES` (2) misses before warning. This rides through editors that delete-and-rename when saving (vim, VS Code, etc.).
2. **Invalid snapshots are dropped, not applied.** `handleInvalidSnapshot` (`src/gateway/config-reload.ts:173-180`) logs the issues and leaves the running config intact. The daemon never silently degrades because of a half-saved file.

When `restartGateway` is true the plan goes to `onRestart` (`src/gateway/config-reload.ts:139-153`), which schedules a supervised restart. Hot-reload changes flow through `onHotReload`, which selectively reissues startup work — restart cron, reload hooks, etc. — without re-binding the listener or losing active WebSocket connections.

A simple mental model: the watcher converts a file diff into a **list of subsystem actions**, and the actions are scoped narrowly enough that no operator ever has to choose between "edit a config" and "drop their inbound channel connections."

---

## 7. State Directory & Data Layout

The state directory is the **persistence root** for everything that lives between gateway restarts. By default it is `~/.openclaw` (`src/config/paths.ts:39-41`).

### 7.1 Resolution order

`resolveStateDir` (`src/config/paths.ts:60-89`) walks this chain:

```ts
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, effectiveHomedir);
  }
  const newDir = newStateDir(effectiveHomedir);
  if (env.OPENCLAW_TEST_FAST === "1") {
    return newDir;
  }
  const legacyDirs = legacyStateDirs(effectiveHomedir);
  const hasNew = fs.existsSync(newDir);
  if (hasNew) {
    return newDir;
  }
  const existingLegacy = legacyDirs.find((dir) => { ... });
  if (existingLegacy) {
    return existingLegacy;
  }
  return newDir;
}
```

In plain English: explicit override > new dir if it exists > legacy `.clawdbot` if it exists > new dir as the fallback. This sequence is exactly what an upgrade-from-Clawdbot user needs: their `~/.clawdbot/` keeps being read until they move it forward.

### 7.2 What lives in the state dir

By convention everything under the state dir is structured:

| Path | What |
|------|------|
| `openclaw.json` | The config file itself (`src/config/paths.ts:23`). |
| `.env` | Durable env var source (`src/config/state-dir-dotenv.ts:46`). |
| `credentials/` | OAuth tokens; layout `oauth.json` per provider (`src/config/paths.ts:275`, `:295-300`). |
| `agents/<agentId>/agent/auth-profiles.json` | Per-agent model auth profiles (referenced by `AGENTS.md:162`). |
| `sessions/<agentId>/sessions.json` | Per-agent session store (`src/config/sessions/paths.ts`, `src/config/sessions/store.ts`). |
| `logs/` | Subsystem log files; rotation policies in `src/config/logging.ts`. |
| `cache/` | Plugin metadata snapshots, model catalog caches, control-ui build artifacts. |
| `runtime/` | Atomic-write staging area used by `replaceFileAtomic` for snapshot writes. |
| `audit/` | Config-write audit records (`src/config/io.audit.ts`). |
| `health/` | Last-known-good config fingerprints (`src/config/io.ts:159-183`). |

The audit and health subdirectories deserve a moment. Every config write produces a **before/after audit record** (`appendConfigAuditRecord`, `src/config/io.ts:46-52`) so that the next startup can see what changed and who changed it. The `config-health.json` file tracks the last known good fingerprint per config path — `lastKnownGood` and `lastPromotedGood` — and lets a startup that finds a corrupt or shrunk config attempt to recover from the last fingerprint rather than refusing to start.

`maintainConfigBackups` (`src/config/backup-rotation.ts`) rotates timestamped backups of `openclaw.json` itself on each successful write. The exact rotation policy is operator-configurable through `cli/backup-rotation` options, but the default is "keep some, prune the rest", scoped per state directory.

### 7.3 The gateway lock

One more piece lives **outside** the state dir for a deliberate reason. `src/config/paths.ts:268-273`:

```ts
export function resolveGatewayLockDir(tmpdir: () => string = os.tmpdir): string {
  const base = tmpdir();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const suffix = uid != null ? `openclaw-${uid}` : "openclaw";
  return path.join(base, suffix);
}
```

The gateway port lock file lives in `os.tmpdir()/openclaw-<uid>/` because it must be **ephemeral**. State that survives reboots is a liability for port-coordination — you do not want a stale lockfile after a hard crash blocking the next startup. The uid suffix isolates lock dirs per Linux user on a shared host.

### 7.4 Multi-profile layout

When `--profile dev` is passed, `applyCliProfileEnv` (`src/cli/profile.ts:86-114`) sets `OPENCLAW_STATE_DIR=$HOME/.openclaw-dev` and `OPENCLAW_CONFIG_PATH=$HOME/.openclaw-dev/openclaw.json`. The two state dirs are **siblings**, fully isolated. A developer can run a `dev` gateway on port 19001 while their production gateway runs from `~/.openclaw/` on 18789, and the two share nothing — separate sessions, separate logs, separate credentials.

The profile name is sanitised by `isValidProfileName` (`src/cli/profile-utils.ts`, called at `src/cli/profile.ts:58-63`) — alphanumerics, `-`, `_` only. This both prevents path-traversal (`--profile ../../etc`) and constrains the state-dir name to filesystem-safe characters cross-platform.

---

## 8. Write Path and SecretRef Indirection

So far this chapter has been about **reading** config. Two more pieces are worth knowing: how configs are written safely, and how secrets stay out of the file.

### 8.1 Atomic writes with audit

`replaceConfigFile` (in `src/config/io.ts`, exported via `src/config/config.js`) is the only blessed write path. Internally it calls `replaceFileAtomic` (`src/infra/replace-file.ts`) which uses the classic write-temp-then-rename pattern so a crash mid-write cannot leave a half-written `openclaw.json`. Before the rename, it produces a `ConfigWriteAuditResult`:

- A diff between the on-disk file and the proposed file.
- The caller's identity (CLI command name, chat command sender, runtime override origin).
- A snapshot of the process info — pid, command line, env subset relevant to config.

These records land in the audit directory (`src/config/io.audit.ts`'s `appendConfigAuditRecord`) and are how `openclaw doctor --fix` knows what previous repairs have happened.

There are also two safety nets specifically for "the file we just read looks wrong":

- `persistBoundedClobberedConfigSnapshot` (`src/config/io.clobber-snapshot.ts`) captures the bad content into a sibling file so the operator can recover. This activates when validation says the file is structurally invalid but the bytes look intentional rather than random.
- `recoverConfigFromLastKnownGood` (`src/config/io.observe-recovery.ts`) consults the `config-health.json` fingerprint and offers to restore the last known good version when the current file fails validation in a way that suggests external corruption.

The write-back logic also strips runtime-only defaults so the file does not bloat with mostly-redundant filled-in values. `projectSourceOntoRuntimeShape` and `applyUnsetPathsForWrite` (both in `src/config/io.write-prepare.ts`) drive this: paths that match the default tree are pruned; paths the caller explicitly set are preserved.

### 8.2 SecretRef indirection

Plaintext secrets in `openclaw.json` are a no-go (and `doctor` will warn loudly). The pattern is `SecretRef` — an opaque indirection that resolves to a real secret at use time. `src/config/types.secrets.ts` defines:

```ts
export type SecretRef = {
  /* discriminated union: alias, env, exec, file, oauth */
  ...
};
```

A config value that needs a secret stores a `SecretRef`, not the secret itself. Resolution happens through `resolveSecretRefValue` (`src/secrets/resolve.ts`) inside the gateway, with three notable behaviours:

- **Read-only by default during audit**: `secrets audit` forces `OPENCLAW_AUTH_STORE_READONLY=1` (`src/entry.ts:29-37`, called from `src/entry.ts:104-106`) so a stale audit run cannot accidentally write tokens.
- **File-source secrets refuse symlinks** when called with `rejectSymlink: true`. This is the v2026.5.22 fix described in the changelog as "restore the fail-closed contract for `tryReadSecretFileSync`."
- **Env-source secrets** are validated against `isValidEnvSecretRefId` (`src/secrets/ref-contract.ts`) so a config cannot ask for `${PATH}` as a secret.

The credentials store layout under `$stateDir/credentials/` exists exactly so the file you commit (`openclaw.json`) can reference `oauth:openai` without ever leaving plaintext on disk. Chapter 14 covers the secrets boundary in detail.

---

## 9. Debugging Config

When a gateway behaves like it is reading the wrong config, walk this list:

| Symptom | First check |
|---------|-------------|
| Port not what you expect | `echo $OPENCLAW_GATEWAY_PORT` then `cfg.gateway.port` |
| State dir not where you think | `echo $OPENCLAW_STATE_DIR` then run `openclaw doctor`, which prints the resolved state dir |
| Plugin not loading | `cfg.plugins.installs` plus `OPENCLAW_DISABLE_BUNDLED_PLUGINS` |
| Channel uses old credentials | The state dir contains a `credentials/` subdir; check `$stateDir/credentials/oauth.json` modification time |
| Hot reload not picking changes | `chokidar` cannot watch certain mount types; logs show "config reload skipped" |
| File rewritten unexpectedly | `audit/` log under the state dir shows every config write with timestamp + caller |
| Mysterious "${VAR}" appearing as literal | A `${VAR}` reference reached `applyConfigEnvVars` without resolution — set the env var or remove the reference |

`openclaw doctor` (and `openclaw doctor --fix`) is the operator-facing entry into the config system's self-diagnosis. It will:

1. Resolve and print the active state dir + config path.
2. Read the config and surface `issues`, `warnings`, and `legacyIssues`.
3. Validate plugin install records against the `installed-plugin-index` store.
4. Spot-check known dangerous defaults (open DM policy, plaintext secret-bearing fields).
5. Optionally migrate retired keys forward (the `--fix` flag).

The `doctor.warns-state-directory-is-missing.e2e.test.ts` end-to-end test (`src/commands/`) shows the worst-case path — a missing state dir is loud and explicit, never silent.

---

## 10. Three Patterns To Internalise

A useful summary list:

1. **Order of layers is fixed: defaults → file → env → CLI → runtime.** If two sources disagree, the rightmost wins. There is no "magic" override priority; the merge is mechanical.
2. **State dir is the persistence root, and it is pinned absolute at startup.** Anything that lives between restarts is under `$stateDir/`. Anything ephemeral is under `os.tmpdir()`. The pin happens in `normalizeStateDirEnv` (`src/config/paths.ts:91-97`) and is called from `runGatewayCommand` (`src/cli/gateway-cli/run.ts:473`) as the very first line.
3. **Writes are atomic and audited; reads are tolerant.** A corrupt or half-written file does not crash the gateway — it surfaces as a snapshot issue and a recovery offer. A bad env reference becomes a warning, not a hard failure. The contract is "do the right thing for production, fail loudly when you cannot."

<svg viewBox="0 0 720 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="State directory layout and the write pipeline">
<defs>
<marker id="ar5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="360" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">State directory layout (default $HOME/.openclaw)</text>
<rect x="40" y="36" width="640" height="60" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="200" y="56" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">openclaw.json</text>
<text x="200" y="72" text-anchor="middle" font-size="10" fill="#64748b">JSON5 source of truth</text>
<text x="200" y="88" text-anchor="middle" font-size="10" fill="#64748b">Atomic write + audit</text>
<text x="520" y="56" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">.env</text>
<text x="520" y="72" text-anchor="middle" font-size="10" fill="#64748b">Durable env var source</text>
<text x="520" y="88" text-anchor="middle" font-size="10" fill="#64748b">Filtered for safety</text>
<rect x="40" y="108" width="200" height="60" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="6"/>
<text x="140" y="128" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">sessions/&lt;agentId&gt;/</text>
<text x="140" y="144" text-anchor="middle" font-size="10" fill="#64748b">sessions.json</text>
<text x="140" y="160" text-anchor="middle" font-size="10" fill="#64748b">per-agent state</text>
<rect x="260" y="108" width="200" height="60" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="6"/>
<text x="360" y="128" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">credentials/</text>
<text x="360" y="144" text-anchor="middle" font-size="10" fill="#64748b">oauth.json per provider</text>
<text x="360" y="160" text-anchor="middle" font-size="10" fill="#64748b">SecretRef targets</text>
<rect x="480" y="108" width="200" height="60" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="6"/>
<text x="580" y="128" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">agents/&lt;agentId&gt;/</text>
<text x="580" y="144" text-anchor="middle" font-size="10" fill="#64748b">agent/auth-profiles.json</text>
<text x="580" y="160" text-anchor="middle" font-size="10" fill="#64748b">model auth per agent</text>
<rect x="40" y="180" width="200" height="50" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="6"/>
<text x="140" y="200" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">logs/</text>
<text x="140" y="216" text-anchor="middle" font-size="10" fill="#64748b">Rotated log files</text>
<rect x="260" y="180" width="200" height="50" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="6"/>
<text x="360" y="200" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">cache/</text>
<text x="360" y="216" text-anchor="middle" font-size="10" fill="#64748b">Plugin metadata, model catalog</text>
<rect x="480" y="180" width="200" height="50" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="6"/>
<text x="580" y="200" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">audit/</text>
<text x="580" y="216" text-anchor="middle" font-size="10" fill="#64748b">Config write records</text>
<rect x="40" y="240" width="200" height="50" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" rx="6"/>
<text x="140" y="260" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">runtime/</text>
<text x="140" y="276" text-anchor="middle" font-size="10" fill="#64748b">Atomic-write staging</text>
<rect x="260" y="240" width="200" height="50" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" rx="6"/>
<text x="360" y="260" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">health/</text>
<text x="360" y="276" text-anchor="middle" font-size="10" fill="#64748b">Last-known-good fingerprints</text>
<rect x="480" y="240" width="200" height="50" fill="#fef2f2" stroke="#dc2626" stroke-width="1" rx="6"/>
<text x="580" y="260" text-anchor="middle" font-size="11" font-weight="700" fill="#dc2626">os.tmpdir()/openclaw-&lt;uid&gt;/</text>
<text x="580" y="276" text-anchor="middle" font-size="10" fill="#64748b">Gateway port lock (ephemeral)</text>
<line x1="360" y1="300" x2="360" y2="316" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar5)"/>
<rect x="40" y="316" width="640" height="50" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" rx="6"/>
<text x="360" y="336" text-anchor="middle" font-size="11" font-weight="700" fill="#16a34a">openclaw doctor</text>
<text x="360" y="352" text-anchor="middle" font-size="10" fill="#64748b">resolves state dir, surfaces issues/warnings/legacy, optionally migrates with --fix</text>
</svg>
<span class="figure-caption">Figure R3.2 | Default state directory layout; the gateway lock sits outside in tmp by design because it must not survive a hard crash.</span>

<details>
<summary>ASCII original</summary>

```
$HOME/.openclaw/
├── openclaw.json           # source of truth (atomic write + audit)
├── .env                    # durable env var source (filtered)
├── sessions/<agentId>/     # per-agent session state
├── credentials/            # SecretRef targets, oauth.json per provider
├── agents/<agentId>/       # agent/auth-profiles.json (model auth)
├── logs/                   # rotated log files
├── cache/                  # plugin metadata, model catalog
├── audit/                  # config write records
├── runtime/                # atomic-write staging area
└── health/                 # last-known-good fingerprints

$TMPDIR/openclaw-<uid>/     # gateway port lock (ephemeral, not under state dir)

   openclaw doctor          # resolves state dir, prints issues + offers --fix
```

</details>

---

## 11. Putting It All Together

<svg viewBox="0 0 740 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Layered config resolution: defaults to file to env to CLI to runtime override">
<defs>
<marker id="ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="370" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Layered config resolution (lower layer wins on conflict)</text>
<rect x="40" y="40" width="660" height="44" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5" rx="6"/>
<text x="180" y="60" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">1. Built-in defaults</text>
<text x="180" y="76" text-anchor="middle" font-size="10" fill="#64748b">src/config/defaults.ts</text>
<text x="510" y="60" text-anchor="middle" font-size="10" fill="#64748b">Always present; merged in at materialise time</text>
<text x="510" y="76" text-anchor="middle" font-size="10" fill="#64748b">Bottom of the stack</text>
<line x1="370" y1="84" x2="370" y2="96" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar4)"/>
<rect x="40" y="96" width="660" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1" rx="6"/>
<text x="180" y="116" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">2. Config file (openclaw.json)</text>
<text x="180" y="132" text-anchor="middle" font-size="10" fill="#64748b">JSON5; supports comments + trailing commas</text>
<text x="510" y="116" text-anchor="middle" font-size="10" fill="#64748b">$include resolution -&gt; ${ENV} substitution</text>
<text x="510" y="132" text-anchor="middle" font-size="10" fill="#64748b">Validate (issues / warnings / legacyIssues)</text>
<line x1="370" y1="140" x2="370" y2="152" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar4)"/>
<rect x="40" y="152" width="660" height="56" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="6"/>
<text x="180" y="172" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">3. Environment variables</text>
<text x="180" y="188" text-anchor="middle" font-size="10" fill="#64748b">Bootstrap: OPENCLAW_HOME, _STATE_DIR, _CONFIG_PATH, _PROFILE</text>
<text x="180" y="204" text-anchor="middle" font-size="10" fill="#64748b">Value: _GATEWAY_PORT, _GATEWAY_TOKEN, _OAUTH_DIR, ...</text>
<text x="510" y="172" text-anchor="middle" font-size="10" fill="#64748b">State-dir .env adds durable env source</text>
<text x="510" y="188" text-anchor="middle" font-size="10" fill="#64748b">cwd .env wins over state-dir .env for CLI</text>
<text x="510" y="204" text-anchor="middle" font-size="10" fill="#64748b">Dangerous host vars filtered</text>
<line x1="370" y1="208" x2="370" y2="220" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar4)"/>
<rect x="40" y="220" width="660" height="56" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="6"/>
<text x="180" y="240" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">4. CLI flag overrides</text>
<text x="180" y="256" text-anchor="middle" font-size="10" fill="#64748b">Structured: --port / --bind / --auth / --tailscale</text>
<text x="180" y="272" text-anchor="middle" font-size="10" fill="#64748b">Generic: setConfigOverride(path, value)</text>
<text x="510" y="240" text-anchor="middle" font-size="10" fill="#64748b">--token / --password pushed back into env</text>
<text x="510" y="256" text-anchor="middle" font-size="10" fill="#64748b">sanitizeOverrideValue blocks proto-pollution</text>
<text x="510" y="272" text-anchor="middle" font-size="10" fill="#64748b">Not persisted to disk</text>
<line x1="370" y1="276" x2="370" y2="288" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar4)"/>
<rect x="40" y="288" width="660" height="44" fill="#fef2f2" stroke="#dc2626" stroke-width="1" rx="6"/>
<text x="180" y="308" text-anchor="middle" font-size="12" font-weight="700" fill="#dc2626">5. Runtime mutations</text>
<text x="180" y="324" text-anchor="middle" font-size="10" fill="#64748b">Chat /option, Control UI, programmatic</text>
<text x="510" y="308" text-anchor="middle" font-size="10" fill="#64748b">Goes through same setConfigOverride path</text>
<text x="510" y="324" text-anchor="middle" font-size="10" fill="#64748b">Top of the stack, ephemeral</text>
<rect x="40" y="350" width="660" height="44" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" rx="6"/>
<text x="370" y="368" text-anchor="middle" font-size="11" font-weight="700" fill="#16a34a">Hot reload watcher (chokidar) sees file changes mid-run</text>
<text x="370" y="384" text-anchor="middle" font-size="10" fill="#64748b">diffConfigPaths -&gt; GatewayReloadPlan -&gt; restart only what is necessary</text>
<text x="370" y="416" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">All paths normalised relative to state dir, pinned absolute at startup (v2026.5.22 #52264)</text>
<text x="370" y="438" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">State dir is the persistence root; gateway lock is in tmp by design</text>
</svg>
<span class="figure-caption">Figure R3.1 | The five resolution layers, top to bottom: defaults, file, env, CLI, runtime; the chokidar watcher reads new file snapshots and selectively restarts subsystems.</span>

<details>
<summary>ASCII original</summary>

```
       [1. Built-in defaults]
              ▼  merged at materialise time
    [2. openclaw.json (JSON5)]
              ▼  $include resolution -> ${ENV} substitution -> validation
       [3. Environment vars]
              │  Bootstrap: OPENCLAW_HOME/_STATE_DIR/_CONFIG_PATH/_PROFILE
              │  Value:     _GATEWAY_PORT/_TOKEN/_OAUTH_DIR/...
              │  State-dir .env adds a durable source
              ▼  cwd .env wins for CLI sessions
        [4. CLI overrides]
              │  Structured: --port/--bind/--auth/--tailscale
              │  Generic:    setConfigOverride(path, value)
              ▼  Not persisted; CLI sets env vars when needed
       [5. Runtime mutations]
              │  Chat /option, Control UI, programmatic
              ▼  Same setConfigOverride path, ephemeral

   Hot reload (chokidar):
      File change -> diffConfigPaths -> GatewayReloadPlan
                  -> restart only the affected subsystem
                     (channels / hooks / cron / heartbeat / plugins / ...)

   State directory = persistence root; gateway lock = tmp (ephemeral).
   v2026.5.22 fix #52264: OPENCLAW_STATE_DIR is pinned absolute at startup.
```

</details>

A single mental rule that survives every corner case in this chapter: **the value used at runtime is the deep-merge of layers 1-5 in that order, and the on-disk file is only ever rewritten by `openclaw config set` or `replaceConfigFile`**. Everything else is in-memory.

Two operator workflows fall out of this rule cleanly:

- **"Make this gateway permanent."** Edit `openclaw.json`, save. The watcher applies as much as it can hot, and if it needs a restart it asks `onRestart` for one. Everything you edited persists.
- **"Try this for one run."** Pass a CLI flag or run `/option` from chat. The change applies for this process; a restart returns to the file. No surprise persistence.

The same principle holds for state: **the state directory is the persistence root, the gateway lock is ephemeral by design**, and `OPENCLAW_STATE_DIR` is resolved to an absolute path before anything else looks at it. The next chapter (Chapter 04 Channel Layer) builds on this — channel plugins read their state from `$stateDir/channels/<id>/`, and the per-channel hot-reload action restarts only the affected channel rather than the whole gateway.

If you remember three lines from this chapter:

1. The on-disk file is the only persistent source. Env vars, CLI flags, and runtime overrides are merged on top in that order, but never written back unless the operator runs `openclaw config set` or a similar explicit command.
2. `$stateDir` is pinned absolute at `runGatewayCommand`'s first line (`src/cli/gateway-cli/run.ts:473`). Without that pin, a working-directory change later in the same process could redirect session and credentials storage — that is exactly what fix #52264 prevents in v2026.5.22.
3. Hot reload is action-scoped. The watcher reads a fresh snapshot, diffs against the in-memory snapshot, and builds a plan that lists *exactly* which subsystems to restart. Channel plugins, hooks, cron, heartbeat, and the gateway as a whole are each separate restart targets.
