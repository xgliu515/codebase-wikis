# Chapter 10 — Plugin System and Extension SDK

Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

OpenClaw's architecture decision that shapes everything else is "core stays lean; optional capability ships as a plugin." This chapter walks the layer that makes that real: how plugins are bounded, what shape they must take, how they are discovered, loaded, run, and unloaded, and what testing apparatus guarantees the boundary holds.

A reader who finishes this chapter should be able to look at any `extensions/<name>/` directory and predict where its tools land, which hooks it might register, why it's enabled (or hidden), and what would happen if it crashed mid-turn.

## 1. The architectural bet: why plugins

OpenClaw's `VISION.md` is unusually direct about this:

> OpenClaw has an extensive plugin API. Core stays lean; optional capability should usually ship as plugins. We are generally slimming down core while expanding what plugins can do.
> (`VISION.md:60-65`)

The vision splits plugins into two styles (`VISION.md:67-73`):

- **Code plugins** — run in-process OpenClaw plugin code. Used for deeper runtime extension (tools, providers, channels, hooks).
- **Bundle-style plugins** — package external surfaces (skills, MCP servers, configuration) with a smaller, more stable interface.

The preference order is explicit: prefer bundle-style when expressible; use code plugins when the capability needs runtime hooks. The bar for landing optional plugins in core is "intentionally high." Plugin discovery, official-publisher status, provenance, and security review live in [ClawHub](https://clawhub.ai/), not in this repo.

The *anti-list* from `VISION.md:121-130` is just as informative — things OpenClaw will not merge:

- New core skills that can live on ClawHub.
- Wrapper channels around already-supported channels.
- MCP work that duplicates existing MCP, ACPX, plugin, or ClawHub paths.
- Agent-hierarchy frameworks as default architecture.
- Heavy orchestration layers that duplicate existing infrastructure.

Reading this list reveals the *function* of the plugin system: it exists so that the things on the anti-list don't have to land in core. Channels, providers, voice, memory, tools — every plug-in plug-out integration goes through this boundary.

## 2. The boundary contract: four channels, no shortcuts

Plugins talk to core via exactly four channels. Anything else is a guard-rail violation. The rule is stated tersely in `AGENTS.md:31-40`:

> Plugins cross into core only via `openclaw/plugin-sdk/*`, manifest metadata, injected runtime helpers, documented barrels (`api.ts`, `runtime-api.ts`).
>
> Plugin prod code: no core `src/**`, `src/plugin-sdk-internal/**`, other plugin `src/**`, or relative outside package.
>
> Core/tests: no deep plugin internals (`extensions/*/src/**`, `onboard.js`). Use public barrels, SDK facade, generic contracts.

The four channels are:

1. **`packages/plugin-sdk/*`** — the published SDK with versioned subpath exports. External plugins import from `@openclaw/plugin-sdk/<subpath>`.
2. **`src/plugin-sdk/*`** — the in-tree barrel for bundled plugins. The published SDK is a thin re-export layer; the actual implementations live here.
3. **Manifest metadata** (`openclaw.plugin.json` + `package.json`'s `openclaw` block). Cheap, source-of-truth data the host can read *without executing plugin code*.
4. **Injected runtime helpers** — the `OpenClawPluginApi` object passed to `register()` at plugin activation. The `*-api.ts` and `*-runtime-api.ts` files on the plugin side are the documented seams between the plugin's internal modules and what the host injects.

Channel 4 — runtime helpers via injection — is the lever that allows clean dependency inversion. The host *injects* the API the plugin calls. The plugin never reaches *into* the host. This is the same pattern that keeps unit tests of plugins straightforward: the test rig provides a stub `OpenClawPluginApi`, the plugin runs, the test asserts which `registerX` methods were called with which arguments.

### Why not just expose all of `src/`?

A naive design would simply export everything `src/` defines and let plugins import what they want. Three reasons OpenClaw rejected that:

- **Forward compatibility.** Plugins live outside the repo; their releases are scheduled differently. A flat export forces every internal refactor to be a breaking change.
- **Capability minimization.** Plugin authors should see the smallest API that lets them do their job. Random core internals are not part of that API.
- **Auditability.** When a plugin says `import { ... } from "@openclaw/plugin-sdk/provider-tools"`, both the plugin and a security reviewer know exactly what surface it touches. `import { ... } from "openclaw/src/some-internal"` is a black box.

The `packages/plugin-sdk/package.json` `exports` map is the explicit allowlist. At v2026.5.22 it lists roughly 100 subpaths (e.g., `./plugin-entry`, `./provider-auth-runtime`, `./channel-runtime`, `./gateway-method-runtime`). Anything not in that map is internal.

<svg viewBox="0 0 920 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="plugin boundary architecture"><defs><marker id="r101arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#64748b"/></marker></defs><rect x="0" y="0" width="920" height="460" fill="#f1f5f9"/><rect x="40" y="30" width="240" height="380" rx="10" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/><text x="160" y="60" text-anchor="middle" font-family="ui-sans-serif" font-size="16" font-weight="700" fill="#ea580c">OpenClaw core</text><rect x="60" y="80" width="200" height="50" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="160" y="100" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">src/gateway/</text><text x="160" y="116" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">src/agents/, src/channels/</text><rect x="60" y="140" width="200" height="50" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="160" y="160" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">src/plugins/</text><text x="160" y="176" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">(loader, registry)</text><rect x="60" y="200" width="200" height="50" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="160" y="220" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">src/hooks/</text><text x="160" y="236" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">internal hook dispatch</text><rect x="60" y="260" width="200" height="50" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="160" y="280" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">api-builder + api-facades</text><text x="160" y="296" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">build OpenClawPluginApi</text><rect x="60" y="320" width="200" height="50" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="160" y="340" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">manifest-registry</text><text x="160" y="356" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">control-plane (cheap)</text><rect x="320" y="30" width="280" height="380" rx="10" fill="#ddd6fe" stroke="#7c3aed" stroke-width="2"/><text x="460" y="60" text-anchor="middle" font-family="ui-sans-serif" font-size="16" font-weight="700" fill="#7c3aed">four boundary channels</text><rect x="340" y="80" width="240" height="60" rx="4" fill="#ffffff" stroke="#7c3aed"/><text x="460" y="100" text-anchor="middle" font-family="ui-sans-serif" font-size="12" font-weight="700" fill="#1e293b">1. packages/plugin-sdk/*</text><text x="460" y="116" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">subpath exports (typed)</text><text x="460" y="131" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#475569">"@openclaw/plugin-sdk/&lt;sub&gt;"</text><rect x="340" y="150" width="240" height="60" rx="4" fill="#ffffff" stroke="#7c3aed"/><text x="460" y="170" text-anchor="middle" font-family="ui-sans-serif" font-size="12" font-weight="700" fill="#1e293b">2. src/plugin-sdk/* (in-tree)</text><text x="460" y="186" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">bundled plugin barrels</text><text x="460" y="201" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#475569">re-exported by /packages</text><rect x="340" y="220" width="240" height="60" rx="4" fill="#ffffff" stroke="#7c3aed"/><text x="460" y="240" text-anchor="middle" font-family="ui-sans-serif" font-size="12" font-weight="700" fill="#1e293b">3. manifest metadata</text><text x="460" y="256" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">openclaw.plugin.json</text><text x="460" y="271" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#475569">package.json openclaw block</text><rect x="340" y="290" width="240" height="60" rx="4" fill="#ffffff" stroke="#7c3aed"/><text x="460" y="310" text-anchor="middle" font-family="ui-sans-serif" font-size="12" font-weight="700" fill="#1e293b">4. injected runtime helpers</text><text x="460" y="326" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">OpenClawPluginApi @ register</text><text x="460" y="341" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#475569">api.ts / runtime-api.ts seams</text><rect x="340" y="360" width="240" height="40" rx="4" fill="#fee2e2" stroke="#dc2626"/><text x="460" y="380" text-anchor="middle" font-family="ui-sans-serif" font-size="11" font-weight="700" fill="#dc2626">no other channel allowed</text><text x="460" y="395" text-anchor="middle" font-family="ui-sans-serif" font-size="10" fill="#dc2626">no deep src/** import, no relative escape</text><rect x="640" y="30" width="240" height="380" rx="10" fill="#99f6e4" stroke="#0d9488" stroke-width="2"/><text x="760" y="60" text-anchor="middle" font-family="ui-sans-serif" font-size="16" font-weight="700" fill="#0d9488">plugin</text><rect x="660" y="80" width="200" height="50" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="760" y="100" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">extensions/&lt;id&gt;/index.ts</text><text x="760" y="116" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">defineBundledChannelEntry</text><rect x="660" y="140" width="200" height="50" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="760" y="160" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">api.ts</text><text x="760" y="176" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">public barrel</text><rect x="660" y="200" width="200" height="50" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="760" y="220" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">runtime-api.ts</text><text x="760" y="236" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">heavy runtime</text><rect x="660" y="260" width="200" height="50" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="760" y="280" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">openclaw.plugin.json</text><text x="760" y="296" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">+ package.json openclaw</text><rect x="660" y="320" width="200" height="50" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="760" y="340" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">src/** (private)</text><text x="760" y="356" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">never imported by core</text><path d="M 280 105 L 336 105" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r101arrow)"/><path d="M 280 285 L 336 285" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r101arrow)"/><path d="M 280 345 L 336 345" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r101arrow)"/><path d="M 584 105 L 660 105" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r101arrow)"/><path d="M 584 175 L 660 175" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r101arrow)"/><path d="M 584 250 L 660 285" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r101arrow)"/><path d="M 584 320 L 660 220" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r101arrow)"/></svg>
<span class="figure-caption">Figure R10.1 | Plugin boundary: core and plugin code never touch each other directly; every interaction crosses one of the four named channels.</span>
<details><summary>ASCII original</summary>
```
+--------------+  +----------------------+  +-------------+
| OpenClaw core|  | four channels         | | plugin       |
| src/gateway  |--| 1 packages/plugin-sdk |--| index.ts    |
| src/plugins  |--| 2 src/plugin-sdk      |--| api.ts      |
| src/hooks    |  | 3 manifest metadata  |  | runtime-api |
| api-builder  |--| 4 injected runtime    |--| manifest    |
| manifest-reg.|  +----------------------+  | src/** priv. |
+--------------+    no other channel        +-------------+
```
</details>

## 3. The `extensions/` directory and the manifest

`extensions/` is the bundled-plugin tree. At v2026.5.22 the tree contains roughly 70 directories. A representative slice (`git ls-tree a374c3a5bf extensions/`):

- **Providers**: `anthropic`, `google`, `groq`, `cerebras`, `chutes`, `deepseek`, `deepinfra`, `fireworks`, `huggingface`, `alibaba`, `byteplus`, `amazon-bedrock`, `anthropic-vertex`, `gradium`.
- **Channels**: `discord`, `feishu`, `googlechat`, `googlemeet`, `device-pair`, `bonjour`.
- **Tool sources**: `brave`, `duckduckgo`, `exa`, `firecrawl`, `browser`, `comfy`, `canvas`, `document-extract`.
- **Voice / speech / media**: `elevenlabs`, `deepgram`, `azure-speech`, `fal`.
- **Infrastructure**: `acpx`, `codex`, `admin-http-rpc`, `diagnostics-otel`, `diagnostics-prometheus`, `cloudflare-ai-gateway`.
- **Memory / active**: `active-memory`.
- **Misc UX**: `clickclack`, `diffs`, `file-transfer`.

Each directory has the same fingerprint: `openclaw.plugin.json` (manifest), `package.json` (npm metadata with an `openclaw` block), `index.ts` (entry point), and one or more `*-api.ts` files that act as the plugin's public barrel.

A minimal manifest, from `extensions/discord/openclaw.plugin.json`:

```json
{
  "id": "discord",
  "activation": { "onStartup": false },
  "channels": ["discord"],
  "channelEnvVars": { "discord": ["DISCORD_BOT_TOKEN"] },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Three things to note. `activation.onStartup: false` says the plugin should not be loaded during gateway startup — it activates on demand when its channel is configured. `channels: ["discord"]` is the manifest-side declaration that this plugin owns the `discord` channel id. `channelEnvVars` lists the env vars that count as "configured evidence" for this channel — they let the loader decide whether the channel is statically configured *without* executing plugin code.

The corresponding plugin entry at `extensions/discord/index.ts:1-25` is a single object built by `defineBundledChannelEntry`:

```ts
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerDiscordSubagentHooks } from "./subagent-hooks-api.js";

export default defineBundledChannelEntry({
  id: "discord",
  name: "Discord",
  description: "Discord channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "discordPlugin",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setDiscordRuntime",
  },
  accountInspect: {
    specifier: "./account-inspect-api.js",
    exportName: "inspectDiscordReadOnlyAccount",
  },
  registerFull(api) {
    registerDiscordSubagentHooks(api);
  },
});
```

Notice the pattern: `specifier` + `exportName` pairs. The entry doesn't *import* the heavy modules — it names them so the loader can import lazily when they're actually needed. `accountInspect` is needed for setup-time inspection; the loader can resolve it without bringing in the full channel runtime. `runtime` is only loaded when the plugin actually has to start listening. `plugin` is the registration object the API builder consumes during `register()`.

This split between control-plane (cheap, manifest-driven) and runtime-plane (heavy, lazy) is the same pattern chapter 09 saw in the tool catalog's visible/hidden split. It's the consistent theme of OpenClaw's plugin work.

## 4. The plugin loader

`src/plugins/` is large (around 490 files at v2026.5.22). The pieces relevant to lifecycle:

- `discovery.ts` — finds plugin candidates on disk (`PluginCandidate`).
- `manifest.ts` / `manifest-registry.ts` — parses `openclaw.plugin.json` files and validates them against the schema.
- `loader.ts` — orchestrates load: resolves dependencies, builds the plugin API, calls `register()`.
- `registry.ts` / `registry-empty.ts` — holds the post-load state (registered tools, hooks, providers, channels).
- `api-builder.ts` / `api-facades.ts` — constructs the `OpenClawPluginApi` object that `register()` receives.
- `api-lifecycle.ts` — declares which API methods are runtime-callable vs. registration-only.
- `hook-runner-global.ts` / `hooks.ts` — the hook dispatch engine.
- `runtime/runtime-plugin-boundary.ts` — runtime helpers for resolving plugin module paths.

### Discovery

`discoverOpenClawPlugins` (signature in `src/plugins/loader.ts:55-58`, implementation in `src/plugins/discovery.ts:51-77`) walks the bundled extensions, the user's installed plugin index, and any extra plugin roots configured by the operator. Each candidate becomes a `PluginCandidate` record:

```ts
export type PluginCandidate = {
  idHint: string;
  source: string;
  setupSource?: string;
  rootDir: string;
  origin: PluginOrigin;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  workspaceDir?: string;
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  packageDir?: string;
  packageManifest?: OpenClawPackageManifest;
  packageDependencies?: PluginDependencySpecMap;
  packageOptionalDependencies?: PluginDependencySpecMap;
  bundledManifest?: PluginManifest;
  bundledManifestPath?: string;
  rawPackageManifest?: PackageManifest;
};
```
(`src/plugins/discovery.ts:55-76`)

`idHint` is the working name before manifest validation confirms `id`. `origin` distinguishes `bundled` (in-tree under `extensions/`) from `installed` (via npm install). `format` is `package` or `directory`. `setupSource` is the optional lightweight entry that setup/onboarding can load without bringing up the full runtime.

Discovery is intentionally cheap. It reads filesystem metadata and JSON; it never imports plugin code. This lets `openclaw doctor` and the setup wizard probe plugin state without paying the activation cost.

### Manifest validation

`loadPluginManifestRegistry` (`src/plugins/manifest-registry.ts`, used at `src/plugins/runtime/runtime-plugin-boundary.ts:30-32`) merges all the manifests into a single registry. The validation enforces JSON-schema-style constraints from `src/plugins/manifest.ts:30-95`:

```ts
export const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
export const PLUGIN_MANIFEST_FILENAMES = [PLUGIN_MANIFEST_FILENAME] as const;
export const MAX_PLUGIN_MANIFEST_BYTES = 256 * 1024;
```

The 256 KB cap is the *static-analysis budget*. Manifests must be small enough to be cheap to read on every startup; if a plugin author wants to ship a giant model catalog, they should ship it as runtime data, not as manifest content.

The manifest schema covers (`src/plugins/manifest.ts:117-130`, `:196-225`):

- `id`, `name`, `version` — identity.
- `channels`, `channelEnvVars`, `channelConfig` — channel-side bindings.
- `providers`, `modelCatalog`, `modelPrefixes`, `modelPatterns`, `modelIdNormalization` — provider-side bindings.
- `tools`, `webSearchProviders`, `webFetchProviders` — tool surface.
- `hooks` — declared hook handlers (cheap metadata; actual handlers register at runtime).
- `skills` — skill bundles owned by this plugin.
- `activation` — when to load (`onStartup`, `onProviders`, `onChannels`, `onCommands`, `onCapabilities`).
- `setup` — cheap setup metadata (`providers`, `cliBackends`, `configMigrations`, `requiresRuntime`).
- `configSchema`, `dangerousConfigFlags` — config validation.

The split between *what the manifest declares* and *what the runtime registers* is the core/control-plane vs. runtime-plane separation. Everything cheap is in the manifest; everything heavy needs runtime activation.

### Lifecycle phases

The lifecycle has four phases:

1. **Discovery** (cheap, no code execution): walk disk, parse manifests, build `PluginCandidate` and `PluginManifestRecord` lists.
2. **Activation planning** (cheap): given runtime context (configured channels, configured providers, requested commands), decide which plugins must load. The `activation.on*` fields in the manifest drive this.
3. **Load** (expensive, plugin code runs): for each plugin that must activate, the loader imports the entry module, builds the `OpenClawPluginApi`, and calls the plugin's `register(api)`.
4. **Run** (steady state): the registered hooks, tools, providers, channels are alive. The host calls into them through the registry.

The `PluginLoadOptions` type at `src/plugins/loader.ts:165-200` is where the wiring is most visible:

```ts
export type PluginLoadOptions = {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  autoEnabledReasons?: Readonly<Record<string, string[]>>;
  workspaceDir?: string;
  installRecords?: Record<string, PluginInstallRecord>;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  coreGatewayMethodNames?: readonly string[];
  hostServices?: PluginRegistryParams["hostServices"];
  runtimeOptions?: CreatePluginRuntimeOptions;
  startupTrace?: { detail: (...) => void };
  pluginSdkResolution?: PluginSdkResolutionPreference;
  cache?: boolean;
  mode?: "full" | "validate";
  onlyPluginIds?: string[];
  ...
};
```

The `mode: "validate"` switch is the lever that lets `openclaw doctor` run the loader for validation without actually starting plugins. `onlyPluginIds` restricts load to a subset (used by activation planner when only some plugins are needed). The clear-and-restore functions on the registry (e.g., `clearAgentHarnesses` / `restoreRegisteredAgentHarnesses` at `src/plugins/loader.ts:5-9`) exist so that hot-reload can swap a plugin without restarting the gateway.

<svg viewBox="0 0 920 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="plugin lifecycle state machine"><defs><marker id="r102arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#64748b"/></marker></defs><rect x="0" y="0" width="920" height="460" fill="#f1f5f9"/><rect x="60" y="40" width="180" height="80" rx="10" fill="#e2e8f0" stroke="#475569" stroke-width="2"/><text x="150" y="74" text-anchor="middle" font-family="ui-sans-serif" font-size="14" font-weight="700" fill="#1e293b">unknown</text><text x="150" y="94" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">(not yet discovered)</text><rect x="320" y="40" width="180" height="80" rx="10" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/><text x="410" y="74" text-anchor="middle" font-family="ui-sans-serif" font-size="14" font-weight="700" fill="#ea580c">discovered</text><text x="410" y="94" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">manifest read, validated</text><rect x="580" y="40" width="180" height="80" rx="10" fill="#ddd6fe" stroke="#7c3aed" stroke-width="2"/><text x="670" y="74" text-anchor="middle" font-family="ui-sans-serif" font-size="14" font-weight="700" fill="#7c3aed">planned</text><text x="670" y="94" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">activation decided</text><rect x="60" y="180" width="180" height="80" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/><text x="150" y="214" text-anchor="middle" font-family="ui-sans-serif" font-size="14" font-weight="700" fill="#dc2626">load-failed</text><text x="150" y="234" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">error recorded</text><text x="150" y="250" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">(quarantine)</text><rect x="320" y="180" width="180" height="80" rx="10" fill="#bae6fd" stroke="#0ea5e9" stroke-width="2"/><text x="410" y="214" text-anchor="middle" font-family="ui-sans-serif" font-size="14" font-weight="700" fill="#0ea5e9">loading</text><text x="410" y="234" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">register(api) running</text><rect x="580" y="180" width="180" height="80" rx="10" fill="#99f6e4" stroke="#0d9488" stroke-width="2"/><text x="670" y="214" text-anchor="middle" font-family="ui-sans-serif" font-size="14" font-weight="700" fill="#0d9488">active</text><text x="670" y="234" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">hooks live, tools live</text><rect x="320" y="320" width="180" height="80" rx="10" fill="#e2e8f0" stroke="#475569" stroke-width="2"/><text x="410" y="354" text-anchor="middle" font-family="ui-sans-serif" font-size="14" font-weight="700" fill="#1e293b">unloaded</text><text x="410" y="374" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">cleanup hooks ran</text><path d="M 240 80 L 316 80" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r102arrow)"/><text x="278" y="72" text-anchor="middle" font-family="ui-sans-serif" font-size="10" fill="#475569">discovery</text><path d="M 500 80 L 576 80" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r102arrow)"/><text x="538" y="72" text-anchor="middle" font-family="ui-sans-serif" font-size="10" fill="#475569">planner</text><path d="M 670 120 L 670 178" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r102arrow)"/><text x="700" y="155" text-anchor="middle" font-family="ui-sans-serif" font-size="10" fill="#475569">load</text><path d="M 408 220 L 320 220" stroke="#dc2626" stroke-width="2" fill="none" marker-end="url(#r102arrow)"/><text x="364" y="212" text-anchor="middle" font-family="ui-sans-serif" font-size="10" fill="#dc2626">throw</text><path d="M 500 220 L 576 220" stroke="#0d9488" stroke-width="2" fill="none" marker-end="url(#r102arrow)"/><text x="538" y="212" text-anchor="middle" font-family="ui-sans-serif" font-size="10" fill="#0d9488">return</text><path d="M 670 260 L 500 320" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r102arrow)"/><text x="610" y="295" text-anchor="middle" font-family="ui-sans-serif" font-size="10" fill="#475569">gateway_stop</text><path d="M 320 358 L 244 218" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r102arrow)" stroke-dasharray="3,3"/><text x="265" y="295" text-anchor="middle" font-family="ui-sans-serif" font-size="10" fill="#475569">hot-reload retry</text><text x="60" y="430" font-family="ui-sans-serif" font-size="11" fill="#64748b">src/plugins/loader.ts, src/plugins/api-lifecycle.ts, src/plugins/hook-runner-global.ts</text></svg>
<span class="figure-caption">Figure R10.2 | Plugin lifecycle: from manifest-only discovery through planned activation, loading, and a quarantine state for failures. Hot-reload returns from `unloaded` back to `loading`.</span>
<details><summary>ASCII original</summary>
```
unknown --discovery--> discovered --planner--> planned
                                                    |
                                                    v
                          load-failed <--throw-- loading --return--> active
                              ^                                        |
                              +------ retry --- unloaded <--gateway_stop
```
</details>

### Registration phase vs. runtime phase

Not every API method is callable at every time. `api-lifecycle.ts` makes this explicit:

```ts
const PLUGIN_API_METHOD_POLICIES: Partial<Record<PluginApiMethodName, PluginApiLifecyclePolicy>> = {
  emitAgentEvent: { phase: "runtime", lateCallable: true },
  sendSessionAttachment: { phase: "runtime", lateCallable: true },
  scheduleSessionTurn: { phase: "runtime", lateCallable: true },
  unscheduleSessionTurnsByTag: { phase: "runtime", lateCallable: true },
};

export function isLateCallablePluginApiMethod(methodName: string): methodName is PluginApiMethodName {
  return getPluginApiMethodLifecyclePolicy(methodName)?.lateCallable === true;
}
```
(`src/plugins/api-lifecycle.ts:16-32`)

Methods marked `phase: "registration"` (the default for everything not explicitly listed) can only be called during `register()`. Methods marked `phase: "runtime"` can be called later — for example, a plugin that needs to push an attachment into a live session uses `sendSessionAttachment`, and that has to be callable from a hook handler that fires hours after registration.

`lateCallable: true` is the explicit opt-in. Anything else has its `register`-time identity captured and won't fire if called later.

### The API surface

`buildPluginApi` (`src/plugins/api-builder.ts:18-95`) is the assembly point. The `handlers` parameter list is a near-complete catalog of plugin extension points:

```ts
handlers?: Partial<Pick<OpenClawPluginApi,
  | "registerTool" | "registerHook" | "registerHttpRoute"
  | "registerHostedMediaResolver" | "registerChannel" | "registerGatewayMethod"
  | "registerCli" | "registerReload" | "registerNodeHostCommand"
  | "registerNodeInvokePolicy" | "registerSecurityAuditCollector" | "registerService"
  | "registerGatewayDiscoveryService" | "registerCliBackend" | "registerTextTransforms"
  | "registerConfigMigration" | "registerMigrationProvider" | "registerAutoEnableProbe"
  | "registerProvider" | "registerModelCatalogProvider" | "registerEmbeddingProvider"
  | "registerSpeechProvider" | "registerRealtimeTranscriptionProvider"
  | "registerRealtimeVoiceProvider" | "registerMediaUnderstandingProvider"
  | "registerImageGenerationProvider" | "registerVideoGenerationProvider"
  | "registerMusicGenerationProvider" | "registerWebFetchProvider"
  | "registerWebSearchProvider" | "registerInteractiveHandler"
  | "onConversationBindingResolved" | "registerCommand" | "registerContextEngine"
  | "registerCompactionProvider" | "registerAgentHarness"
  | "registerCodexAppServerExtensionFactory"
  | "registerAgentToolResultMiddleware" | "registerSessionExtension"
  ...
```
(`src/plugins/api-builder.ts:26-60`)

Each `registerX` accepts a typed payload and stores it in the registry. The API is the inventory of what core *expects* plugins to register.

`api-facades.ts` (`src/plugins/api-facades.ts:23-65`) groups these flat methods into nested namespaces (`api.session.state.registerSessionExtension`, `api.agent.events.emitAgentEvent`, `api.runContext.setRunContext`, etc.) so that plugin code reads more cleanly. The flat methods stay available; the facades are sugar.

## 5. Plugin SDK shape: what plugin authors actually import

The package `@openclaw/plugin-sdk` exposes many subpaths (`packages/plugin-sdk/package.json:6-200+`). They divide into rough families:

**Plugin entry / runtime entry** — the two main entry points:

- `./plugin-entry` — `defineOpenClawPlugin`, plugin definition types (`packages/plugin-sdk/src/plugin-entry.ts:1` is a one-liner re-exporting `src/plugin-sdk/plugin-entry.ts`).
- `./plugin-runtime` — runtime contract types.

**Provider plumbing** — what a model provider plugin needs:

- `./provider-entry` — `defineProvider`, provider config types.
- `./provider-auth` and `./provider-auth-runtime` — auth profile shapes, `ProviderAuthMethod`.
- `./provider-http` — HTTP helpers tuned for provider clients (retry, redaction).
- `./provider-tools` — tool-schema rewriting (`normalizeToolSchemas`, `inspectToolSchemas`).
- `./provider-stream-shared` — stream wrapper composers (`wrapStreamFn`).
- `./provider-model-types`, `./provider-model-shared` — model id, catalog entry, modern-model policy.

**Channel plumbing**:

- `./channel-runtime` — channel lifecycle helpers.
- `./channel-streaming` — outbound stream draft helpers.
- `./channel-secret-runtime` — secret resolution.
- `./channel-activity-runtime` — activity heartbeat helpers.

**Infrastructure helpers**:

- `./runtime-env`, `./runtime-doctor` — env probes, doctor scaffolding.
- `./async-lock-runtime`, `./dedupe-runtime`, `./concurrency-runtime`, `./heartbeat-runtime` — small concurrency primitives.
- `./secret-ref-runtime`, `./ssrf-runtime`, `./security-runtime` — security boundaries.
- `./file-access-runtime` — sandboxed file access.
- `./system-event-runtime`, `./time-runtime`, `./secure-random-runtime`, `./number-runtime` — small abstractions over things plugins shouldn't reach directly.
- `./infra-runtime` — generic infra (logging, errors).
- `./testing` — the test rig stubs.

**Config / contract**:

- `./config-runtime`, `./config-types`, `./config-mutation`, `./config-contracts`.
- `./plugin-config-runtime` — plugin's own config validation.

**Misc capability seams**:

- `./browser-config`, `./tts-runtime`, `./video-generation`, `./provider-web-search`, etc.

The published SDK at `packages/plugin-sdk/src/*.ts` is mostly thin re-export wrappers. For example, `packages/plugin-sdk/src/plugin-entry.ts:1` is one line:

```ts
export * from "../../../src/plugin-sdk/plugin-entry.js";
```

The implementations live in `src/plugin-sdk/`. The published package is a versioned, audited *re-export* layer. This lets the v2026.5.22 release pin the exact set of subpaths plugins can rely on while still keeping the implementations alongside core for fast iteration.

The picked-list of meaningful exports a new plugin author should learn:

- `defineOpenClawPlugin(...)` — the entry-point definition.
- `OpenClawPluginApi` — the injected API type (full surface).
- `defineProvider(...)` — for model provider plugins.
- `defineBundledChannelEntry(...)` — for channel plugins.
- `PluginHookName` and the per-hook event types — for hook handlers.
- `runtime-doctor` helpers — for shipping a working `openclaw doctor` panel for the plugin.
- `testing` — for unit tests against a stubbed API.

## 6. The plugin package contract

`packages/plugin-package-contract/src/index.ts` defines what an externally-distributed code plugin must declare in its `package.json`. Two required field paths (`packages/plugin-package-contract/src/index.ts:21-24`):

```ts
export const EXTERNAL_CODE_PLUGIN_REQUIRED_FIELD_PATHS = [
  "openclaw.compat.pluginApi",
  "openclaw.build.openclawVersion",
] as const;
```

`openclaw.compat.pluginApi` declares which plugin-API semver range the plugin supports; `openclaw.build.openclawVersion` records the OpenClaw version the plugin was built against. These are the host's compatibility gate.

The normalization function picks more fields when present (`packages/plugin-package-contract/src/index.ts:46-76`):

```ts
const pluginApi = normalizeOptionalString(compat?.pluginApi);
if (pluginApi) compatibility.pluginApiRange = pluginApi;
const minGatewayVersion = normalizeOptionalString(compat?.minGatewayVersion) ?? minHostVersion;
if (minGatewayVersion) compatibility.minGatewayVersion = minGatewayVersion;
const builtWithOpenClawVersion = normalizeOptionalString(build?.openclawVersion) ?? version;
if (builtWithOpenClawVersion) compatibility.builtWithOpenClawVersion = builtWithOpenClawVersion;
const pluginSdkVersion = normalizeOptionalString(build?.pluginSdkVersion);
if (pluginSdkVersion) compatibility.pluginSdkVersion = pluginSdkVersion;
```

The `ExternalCodePluginValidationResult` (`packages/plugin-package-contract/src/index.ts:14-19`) shape returns `compatibility` and `issues`. `validateExternalCodePluginPackageJson` is what `openclaw doctor` calls before letting an external plugin load. A missing required field produces a *human-readable issue* rather than a cryptic load error.

This package is small (about 100 lines), but it is the cleanest example of "metadata as security boundary" in OpenClaw. A plugin without these fields is rejected before its code runs.

## 7. The memory host SDK

Memory is unusual: it's the one slot where exactly one plugin can be active at a time. `packages/memory-host-sdk` is the specialized contract for those plugins.

`packages/memory-host-sdk/package.json:6-19` exports thirteen subpaths covering engine primitives, runtime helpers, queries, and the multimodal/status surfaces:

```json
"exports": {
  "./runtime": "./src/runtime.ts",
  "./runtime-core": "./src/runtime-core.ts",
  "./runtime-cli": "./src/runtime-cli.ts",
  "./runtime-files": "./src/runtime-files.ts",
  "./engine": "./src/engine.ts",
  "./engine-foundation": "./src/engine-foundation.ts",
  "./engine-storage": "./src/engine-storage.ts",
  "./engine-embeddings": "./src/engine-embeddings.ts",
  "./engine-qmd": "./src/engine-qmd.ts",
  "./multimodal": "./src/multimodal.ts",
  "./query": "./src/query.ts",
  "./secret": "./src/secret.ts",
  "./status": "./src/status.ts"
}
```

The aggregate `runtime` barrel is a single file:

```ts
// Aggregate workspace contract for memory runtime/helper seams.
// Keep focused subpaths preferred for new code.
export * from "./runtime-core.js";
export * from "./runtime-cli.js";
export * from "./runtime-files.js";
```
(`packages/memory-host-sdk/src/runtime.ts:1-5`)

The "Keep focused subpaths preferred for new code" comment matches the broader plugin-sdk discipline: prefer the narrowest subpath; only use the aggregate in legacy code.

The runtime-core barrel (`packages/memory-host-sdk/src/runtime-core.ts:1-40`) shows what memory plugins need from core: agent runtime primitives (`resolveCronStyleNow`, `resolveSessionAgentId`, `resolveMemorySearchConfig`, the tool param helpers), config loading (`getRuntimeConfig`, `resolveStateDir`, `resolveSessionTranscriptsDirForAgent`), and the memory-specific types (`MemoryFlushPlan`, `MemoryPluginCapability`, `MemoryPluginPublicArtifact`, `MemoryPluginRuntime`).

The fact that memory has its own host SDK — separate from the general plugin SDK — is the architectural acknowledgment that memory plugins are special. They sit in a slot, they own a capability registration, they need a stricter contract than a typical provider or channel plugin.

## 8. The hook system

Plugins extend OpenClaw mostly through hooks. The hook names are a closed enum (`src/plugins/hook-types.ts:64-103`):

```ts
export type PluginHookName =
  | "before_model_resolve"
  | "agent_turn_prepare"
  | "before_prompt_build"
  | "before_agent_start"
  | "before_agent_reply"
  | "model_call_started"
  | "model_call_ended"
  | "llm_input"
  | "llm_output"
  | "before_agent_finalize"
  | "agent_end"
  | "before_compaction"
  | "after_compaction"
  | "before_reset"
  | "inbound_claim"
  | "message_received"
  | "message_sending"
  | "message_sent"
  | "before_tool_call"
  | "after_tool_call"
  | "tool_result_persist"
  | "before_message_write"
  | "session_start"
  | "session_end"
  | "subagent_spawning"
  | "subagent_delivery_target"
  | "subagent_spawned"
  | "subagent_ended"
  | "deactivate"  // @deprecated, use gateway_stop
  | "gateway_start"
  | "gateway_stop"
  | "heartbeat_prompt_contribution"
  | "cron_changed"
  | "before_dispatch"
  | "reply_dispatch"
  | "before_install"
  | "before_agent_run";
```

The `PLUGIN_HOOK_NAMES` array immediately below mirrors the union, and a compile-time guard ensures the two stay in lock-step:

```ts
type MissingPluginHookNames = Exclude<PluginHookName, (typeof PLUGIN_HOOK_NAMES)[number]>;
type AssertAllPluginHookNamesListed = MissingPluginHookNames extends never ? true : never;
const assertAllPluginHookNamesListed: AssertAllPluginHookNamesListed = true;
void assertAllPluginHookNamesListed;
```
(`src/plugins/hook-types.ts:146-150`)

This is a *self-checking enum*: if a developer adds a new hook name to the union but forgets the array, the file fails to type-check. The guard is invisible at runtime but invaluable for keeping the registry consistent.

### Subsets

The closed set decomposes into useful subsets:

- `PROMPT_INJECTION_HOOK_NAMES` (`src/plugins/hook-types.ts:155-162`) — hooks that can inject content into the system prompt or turn prompt. Only `agent_turn_prepare`, `before_prompt_build`, `before_agent_start`, `heartbeat_prompt_contribution` are allowed to mutate prompts.
- `CONVERSATION_HOOK_NAMES` (`src/plugins/hook-types.ts:171-...`) — hooks that fire in the main conversation loop (input, output, finalize).

Reads of "what plugin can do X?" boil down to "which hook names is plugin X registered for?"

### Dispatch

The global hook runner is a singleton (`src/plugins/hook-runner-global.ts:14-36`):

```ts
type HookRunnerGlobalState = {
  hookRunner: HookRunner | null;
  registry: GlobalHookRunnerRegistry | null;
};

const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");
const getState = () =>
  resolveGlobalSingleton<HookRunnerGlobalState>(hookRunnerGlobalStateKey, () => ({
    hookRunner: null,
    registry: null,
  }));

export function initializeGlobalHookRunner(registry: GlobalHookRunnerRegistry): void {
  const state = getState();
  state.registry = registry;
  state.hookRunner = createHookRunner(registry, {
    logger: { debug, warn, error },
    catchErrors: true,
    failurePolicyByHook: {
      before_agent_run: "fail-closed",
      before_tool_call: "fail-closed",
    },
  });
  ...
}
```

The `failurePolicyByHook` defaults are the bedrock safety setting. `before_agent_run` and `before_tool_call` are *fail-closed*: if a plugin's handler throws, the agent run or tool call is aborted. Every other hook is *fail-open* by default: if a plugin handler throws, the runner logs the error and proceeds.

The asymmetry is intentional. `before_tool_call` is the approval gate; a buggy gate must not silently let dangerous calls through. `before_agent_run` is the agent's entry guard. The other hooks (e.g., `message_received`, `after_tool_call`) are notification surfaces where a failing plugin shouldn't break the user's session.

Timeouts are also defaulted to keep an unresponsive plugin from freezing a turn (`src/plugins/hooks.ts:194-220`):

```ts
const DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK: Partial<Record<PluginHookName, number>> = {
  agent_end: 30_000,
  // ... 30 second budget for compaction lifecycle hooks
  before_compaction: 30_000,
  after_compaction: 30_000,
};
const DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK: Partial<Record<PluginHookName, number>> = {
  before_agent_run: 15_000,
  // before_agent_start (legacy compat) and before_prompt_build also bounded
  before_agent_start: 15_000,
  before_prompt_build: 15_000,
};
```

The comments name the bugs that motivated the budgets. The `before_agent_start` comment references issue #48534 — a memory plugin waiting on a hung subprocess blocked the entire pipeline. The compaction-hook comment notes that the codex agent harness serializes these on the notification queue, so a hung handler freezes every later notification.

### Internal hooks vs. plugin hooks

OpenClaw has two hook systems:

- **Internal hooks** (`src/hooks/internal-hooks.ts`) — a lighter-weight, registered-by-key map used by core for events like `message:received`, `command:new`, `session:patch`. Handlers are pushed into a global `Map<string, InternalHookHandler[]>`. The runner fires both the type-level handlers (e.g., `message`) and the specific `type:action` handlers (e.g., `message:received`) in registration order.
- **Plugin hooks** (`src/plugins/hooks.ts`) — the richer system covered above, with priority, fail-policy, timeouts, and per-event typed contexts.

Both systems use a global singleton pattern (`Symbol.for(...)`) for the same reason (`src/hooks/internal-hooks.ts:175-195`):

```ts
const INTERNAL_HOOK_HANDLERS_KEY = Symbol.for("openclaw.internalHookHandlers");
const handlers = resolveGlobalSingleton<Map<string, InternalHookHandler[]>>(
  INTERNAL_HOOK_HANDLERS_KEY,
  () => new Map<string, InternalHookHandler[]>(),
);
```

The comment above explains the bug class:

> Uses a globalThis singleton so that registerInternalHook and triggerInternalHook always share the same Map even when the bundler emits multiple copies of this module into separate chunks (bundle splitting). Without the singleton, handlers registered in one chunk are invisible to triggerInternalHook in another chunk, causing hooks to silently fire with zero handlers.
> (`src/hooks/internal-hooks.ts:180-188`)

This is a real bundling hazard. The fix is the same `Symbol.for` pattern in both systems.

<svg viewBox="0 0 920 440" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="hook dispatch fan out and short circuit"><defs><marker id="r103arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#64748b"/></marker></defs><rect x="0" y="0" width="920" height="440" fill="#f1f5f9"/><rect x="40" y="40" width="240" height="80" rx="10" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/><text x="160" y="68" text-anchor="middle" font-family="ui-sans-serif" font-size="14" font-weight="700" fill="#ea580c">core fires hook</text><text x="160" y="88" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">e.g. before_tool_call</text><text x="160" y="106" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#475569">(event, ctx)</text><rect x="360" y="40" width="240" height="80" rx="10" fill="#ddd6fe" stroke="#7c3aed" stroke-width="2"/><text x="480" y="68" text-anchor="middle" font-family="ui-sans-serif" font-size="14" font-weight="700" fill="#7c3aed">hook runner</text><text x="480" y="88" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">sort registrations by priority</text><text x="480" y="106" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#475569">apply timeout + fail-policy</text><rect x="680" y="40" width="220" height="80" rx="10" fill="#bae6fd" stroke="#0ea5e9" stroke-width="2"/><text x="790" y="68" text-anchor="middle" font-family="ui-sans-serif" font-size="14" font-weight="700" fill="#0ea5e9">global registry</text><text x="790" y="88" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">Symbol.for singleton</text><text x="790" y="106" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#475569">survives bundle chunks</text><path d="M 280 80 L 356 80" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r103arrow)"/><path d="M 600 80 L 676 80" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r103arrow)"/><rect x="40" y="170" width="160" height="60" rx="6" fill="#ffffff" stroke="#0d9488"/><text x="120" y="195" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">plugin A (prio 100)</text><text x="120" y="213" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#475569">memory injection</text><rect x="220" y="170" width="160" height="60" rx="6" fill="#ffffff" stroke="#0d9488"/><text x="300" y="195" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">plugin B (prio 50)</text><text x="300" y="213" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#475569">policy rewrite</text><rect x="400" y="170" width="160" height="60" rx="6" fill="#ffffff" stroke="#dc2626"/><text x="480" y="195" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">plugin C (prio 25)</text><text x="480" y="213" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#dc2626">returns { deny: true }</text><rect x="580" y="170" width="160" height="60" rx="6" fill="#ffffff" stroke="#94a3b8"/><text x="660" y="195" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#94a3b8">plugin D (prio 10)</text><text x="660" y="213" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#94a3b8">skipped (short-circuit)</text><rect x="760" y="170" width="140" height="60" rx="6" fill="#ffffff" stroke="#94a3b8"/><text x="830" y="195" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#94a3b8">plugin E (prio 5)</text><text x="830" y="213" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#94a3b8">skipped</text><path d="M 480 140 L 120 168" stroke="#64748b" stroke-width="1.5" fill="none" marker-end="url(#r103arrow)"/><path d="M 480 140 L 300 168" stroke="#64748b" stroke-width="1.5" fill="none" marker-end="url(#r103arrow)"/><path d="M 480 140 L 480 168" stroke="#64748b" stroke-width="1.5" fill="none" marker-end="url(#r103arrow)"/><path d="M 480 140 L 660 168" stroke="#94a3b8" stroke-width="1" fill="none" stroke-dasharray="3,3"/><path d="M 480 140 L 830 168" stroke="#94a3b8" stroke-width="1" fill="none" stroke-dasharray="3,3"/><rect x="40" y="280" width="860" height="130" rx="8" fill="#ffffff" stroke="#cbd5e1"/><text x="60" y="310" font-family="ui-sans-serif" font-size="13" font-weight="700" fill="#7c3aed">policy fan-out:</text><text x="60" y="336" font-family="ui-mono,monospace" font-size="12" fill="#1e293b">• highest priority runs first; results merge via per-hook policy</text><text x="60" y="356" font-family="ui-mono,monospace" font-size="12" fill="#1e293b">• shouldStop(result) → later handlers skipped (modifying hooks)</text><text x="60" y="376" font-family="ui-mono,monospace" font-size="12" fill="#1e293b">• fail-closed hook + handler throws → core treats as deny</text><text x="60" y="396" font-family="ui-mono,monospace" font-size="12" fill="#1e293b">• timeout → log + skip handler, run continues (fail-open) or aborts (fail-closed)</text></svg>
<span class="figure-caption">Figure R10.3 | Hook dispatch fan-out: handlers run in priority order, results merge or short-circuit, and per-hook fail-policy decides what happens on errors.</span>
<details><summary>ASCII original</summary>
```
core fires hook ----> hook runner ----> global registry (Symbol.for)
                       |
                       v sort by priority
   +-------+ +-------+ +-------+ +-------+ +-------+
   | A 100 | | B 50  | | C 25  | | D 10  | | E 5   |
   | mem   | | policy| | deny  | |skipped| |skipped|
   +-------+ +-------+ +-------+ +-------+ +-------+

  shouldStop(result) -> skip remaining (modifying hooks)
  fail-closed throw -> deny
  fail-open throw   -> log + continue
  timeout           -> log + skip handler
```
</details>

## 9. The plugin activation boundary test

`src/plugin-activation-boundary.test.ts` is a guard-rail test that codifies the boundary rule: cheap control-plane probes must not pull heavy plugin runtime modules into memory.

Setup (`src/plugin-activation-boundary.test.ts:6-22`):

```ts
const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() =>
  vi.fn((params: { artifactBasename: string }) => {
    if (params.artifactBasename === "browser-host-inspection.js") {
      return { parseBrowserMajorVersion: ..., readBrowserVersion: ..., ... };
    }
    throw new Error(`unexpected public surface load: ${params.artifactBasename}`);
  }),
);
```

The mock *throws* for any artifact load it didn't expect. The test then invokes generic core boundaries — channel-configured checks, model-ref normalization — and asserts that none of them caused a plugin public-surface load (`src/plugin-activation-boundary.test.ts:117-126`):

```ts
expect(isStaticallyChannelConfigured({}, "telegram", { TELEGRAM_BOT_TOKEN: "token" })).toBe(true);
expect(isStaticallyChannelConfigured({}, "discord", { DISCORD_BOT_TOKEN: "token" })).toBe(true);
expect(normalizeModelRef("google", "gemini-3.1-pro", staticNormalize)).toEqual({
  provider: "google",
  model: "gemini-3.1-pro-preview",
});
expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
```

Then it makes one call that *is* allowed to load a public surface — browser version parsing — and verifies that only that one artifact loaded (`src/plugin-activation-boundary.test.ts:129-135`):

```ts
expect(parseBrowserMajorVersion("Google Chrome 144.0.7534.0")).toBe(144);
expect(
  loadBundledPluginPublicSurfaceModuleSync.mock.calls.map(
    ([params]) => params.artifactBasename,
  ),
).toEqual(["browser-host-inspection.js"]);
```

The test reads as a contract: "channel configuration checks and model-id normalization use manifest data; browser inspection legitimately needs a public surface; nothing else loads plugin runtime on a control-plane path." If a future refactor accidentally pulls a plugin runtime module into the channel-config code path, this test fails with a precise error pointing at the artifact name.

This is the same pattern as `src/plugins/runtime-plugin-boundary.whatsapp.test.ts` and `scripts/plugin-boundary-report.ts`: explicit guardrails so the boundary can't drift accidentally.

## 10. The v2026.5.22 plugin SDK baseline refresh

The release commits in v2026.5.22 fall into three buckets. None of them changes plugin-author-facing semantics, but each tells you something about how the project ships:

### Commit `24c7911cfd chore(release): refresh plugin SDK baseline`

A two-line update to `docs/.generated/plugin-sdk-api-baseline.sha256`. The baseline file fingerprints the entire exported SDK surface. When the actual SDK changes (intentionally), this file changes too. The pre-merge gate checks that the baseline matches; an accidental SDK change without a corresponding baseline refresh fails the gate. The refresh commit is the maintainer's signal that "yes, the SDK surface changed as intended."

For plugin authors, this commit is mostly a heartbeat. The interesting question for any version bump is *what changed in the SDK surface*, and the baseline diff plus git history near it is where to look.

### Commit `df3cadc4ad chore(release): sync plugin versions for 2026.5.22`

A version bump in every `extensions/*/package.json`. Roughly 70 files touched; each just bumps the `version` field (and in many cases a `dependencies` reference to `@openclaw/plugin-sdk` or `openclaw` itself).

This is the discipline that keeps the published-plugin world consistent. The bundled plugins live in the same repo as core, so the release sequence is: tag core, bump every bundled plugin's version to match, then publish. Plugin authors of external plugins should usually align with this version when they publish a release that depends on a specific OpenClaw version.

### Commit `89c69c4264 chore(release): sync plugin shrinkwraps for 2026.5.22`

Updates the `npm-shrinkwrap.json` files of every bundled plugin to point to the v2026.5.22 dependencies. `AGENTS.md:175-180` states that lockfiles/shrinkwraps are a security surface:

> Lockfiles/shrinkwrap are security surface: review `pnpm-lock.yaml`, `npm-shrinkwrap.json`, `package-lock.json`; root/plugin npm packages ship shrinkwrap, not package-lock.

Plugin authors of external plugins should note: ship `npm-shrinkwrap.json` (not `package-lock.json`). The repo's plugins do, and the release sync keeps them aligned.

### What this means for plugin authors

For a plugin author working against v2026.5.22, the implications are:

1. **No SDK behavior change.** The baseline refresh is mechanical. The runtime SDK is the same as v2026.5.21.
2. **Version alignment.** If your plugin's `package.json` declares `"@openclaw/plugin-sdk": "*"` (typical for repo plugins), no action is needed. If you pin a specific version, bump it to `2026.5.22`.
3. **Shrinkwrap.** Run your own shrinkwrap-update flow against the new SDK version so your distributed plugin's transitive deps stay consistent.

If your plugin uses `runtime-doctor` to report version compatibility, the version it should report against v2026.5.22 is the one in `compat.pluginApi` of your `package.json`'s `openclaw` block, normalized through `normalizeExternalPluginCompatibility` (`packages/plugin-package-contract/src/index.ts:46-76`).

## 11. Putting it together

A walk through a representative plugin life. The plugin is `extensions/discord/`.

**Discovery (cheap).** Gateway startup invokes `discoverOpenClawPlugins`. It walks `extensions/` and finds `extensions/discord/openclaw.plugin.json`, builds a `PluginCandidate{ idHint: "discord", rootDir: ".../discord", origin: "bundled" }`. The manifest is parsed and validated.

**Activation planning.** The runtime checks the manifest. `activation.onStartup: false`, so discord is not auto-loaded on startup. Then it checks: is `DISCORD_BOT_TOKEN` set, or does the config configure a discord channel? If yes (the manifest's `channelEnvVars` lists it as evidence), discord is in the activation plan.

**Load.** The loader imports `extensions/discord/index.ts`, which exports a `defineBundledChannelEntry(...)` descriptor naming three lazy specifiers (`channel-plugin-api.js`, `runtime-setter-api.js`, `account-inspect-api.js`). The loader imports `channel-plugin-api.js`, gets `discordPlugin`, and constructs an `OpenClawPluginApi` via `buildPluginApi`. `discordPlugin.register(api)` runs, calling `api.registerChannel(...)`, `api.registerHook("message_received", ...)`, etc.

**Run.** When a Discord message arrives, the discord channel runtime delivers it to OpenClaw. Core fires `inbound_claim` then `message_received` against the hook registry. Plugins that registered handlers (discord itself, memory, the heartbeat plugin) run in priority order. The agent runs, possibly calling `before_tool_call` (chapter 09) which itself may go through approval (chapter 09). The agent reply goes through `before_dispatch` then `reply_dispatch`; the discord channel runtime is the dispatcher. `message_sent` fires.

**Hot-reload / unload.** If the operator disables discord, the runtime fires `gateway_stop` (or the deprecated `deactivate`) for any hooks that registered cleanup. The clear-and-restore functions in the loader reset registries: `clearAgentHarnesses`, `clearPluginCommands`, etc. The plugin's runtime references can be garbage-collected; on re-enable, the cycle restarts at planning.

## 12. The seven things to remember

1. **Plugins talk to core through four channels only:** `packages/plugin-sdk/*`, `src/plugin-sdk/*` (in-tree), manifest metadata, injected runtime helpers.
2. **`AGENTS.md` enumerates the rule and the violations.** "Plugin prod code: no core `src/**`, `src/plugin-sdk-internal/**`, other plugin `src/**`, or relative outside package."
3. **Manifests are the control plane.** Discovery, validation, activation planning, and config probes all work off manifest data without executing plugin code.
4. **`defineBundledChannelEntry` and `defineOpenClawPlugin` are the entry contracts.** They name lazy specifiers rather than importing heavy modules.
5. **`OpenClawPluginApi` is built per-plugin via `buildPluginApi` and dressed up with facades.** Registration-phase methods can only be called during `register()`; runtime-callable methods are explicitly opted in via `api-lifecycle.ts`.
6. **Hooks are a closed enum with per-name policy.** `before_agent_run` and `before_tool_call` are fail-closed; everything else is fail-open. Timeouts cap unresponsive handlers.
7. **`plugin-activation-boundary.test.ts` and the package-contract validator are the guardrails.** Boundary violations fail builds before they ship; missing required `package.json` fields fail load.

The plugin system is the lever OpenClaw uses to stay small. The next chapter walks the runtime layers that this lever activates: how the gateway dispatches calls into the live plugin registry that this chapter has just walked through.
