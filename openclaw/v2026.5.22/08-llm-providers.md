# Chapter 08: LLM Provider Integration

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 8.1 The problem this chapter solves

The agent layer in Chapter 07 ended at `runAgentAttempt`, which called *some* stream function for *some* provider/model pair and got back assistant text, tool calls, and usage. That single line has to work for:

- **Native vendor APIs**: Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, Google Vertex (Anthropic-on-Vertex and Gemini), Amazon Bedrock (Converse stream), Azure OpenAI (Completions and Responses variants).
- **OAuth-subscription paths**: Claude CLI native auth, ChatGPT/Codex OAuth (see `README.md:91-93`), GitHub Copilot, OpenAI Codex device-code.
- **Local servers**: Ollama, llama.cpp, vLLM, LM Studio, LocalAI — all OpenAI-Completions-shaped but with subtle deviations (different `max_tokens` field, different reasoning effort handling, no streaming usage, no `tools: []`).
- **OpenAI-compatible vendors**: DeepSeek, Together, Cerebras, Chutes, Groq, Moonshot, xAI, OpenRouter, OpenCode, Mistral, Z.ai, Xiaomi, ModelStudio, Synthetic, Fireworks, HuggingFace, KiloCode, Kimi-Coding, Arcee, Venice, ByteDance/ByteFlux, Stepfun, Perplexity, NVIDIA, Cloudflare AI Gateway, DeepInfra, GitHub Copilot, etc.
- **Sidecars and proxies**: Copilot-Proxy, LiteLLM, Cloudflare AI Gateway.

The bundled `extensions/` directory has 135 entries (`ls extensions/` count) — not all of them providers, but more than 50 are. The naive approach — one `if/else` ladder per vendor — would not survive a single quarter. OpenClaw uses a plugin-extension model instead: providers ship as plugins that conform to a contract defined in `src/plugin-sdk/`, the host owns the transport (the actual HTTP/SSE plumbing) and the wire-event normalization, and each plugin contributes just the parts that are vendor-specific (auth methods, default models, payload tweaks).

This chapter walks four layers, top to bottom:

1. **The provider plugin contract** — what a provider plugin is and how it registers (`src/plugin-sdk/plugin-entry.ts`, `src/plugins/setup-registry.ts`, `extensions/anthropic/`, `extensions/openai/`).
2. **The model catalog** — how providers and models are discovered, normalized, and looked up (`src/model-catalog/`).
3. **The unified call shape** — the in-process types every provider call conforms to (`src/agents/anthropic-transport-stream.ts`, `src/agents/openai-transport-stream.ts`, `src/agents/transport-stream-shared.ts`).
4. **Operation retry** — backoff, idempotency, non-retryable classification (`src/provider-runtime/operation-retry.ts`, `src/agents/api-key-rotation.ts`).

It closes with the v2026.5.22 changes: the openai-responses family addition to the non-visible-turn retry guard and the empty-`tools` omission for proxy-like endpoints.

<svg viewBox="0 0 820 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="provider plugin architecture"><defs><marker id="r81arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><rect x="20" y="20" width="780" height="60" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="410" y="44" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">agent-command → runAgentAttempt → stream(model, context, options)</text><text x="410" y="62" text-anchor="middle" font-size="10" fill="#64748b">stream function chosen via model.api ("anthropic-messages" / "openai-completions" / "openai-responses" / ...)</text><line x1="410" y1="80" x2="410" y2="100" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r81arrow)"/><rect x="20" y="100" width="780" height="76" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="410" y="124" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">openclaw host (src/agents/*-transport-stream.ts)</text><text x="410" y="142" text-anchor="middle" font-size="10" fill="#64748b">— builds request payload, opens SSE, normalizes events to WritableTransportStream</text><text x="410" y="158" text-anchor="middle" font-size="10" fill="#64748b">— delegates payload mutation to provider plugin via wrapStreamFn / extra params</text><text x="410" y="172" text-anchor="middle" font-size="10" fill="#64748b">— sanitizes payload text, enforces guarded fetch (timeouts, abort)</text><line x1="410" y1="176" x2="410" y2="196" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r81arrow)"/><rect x="20" y="196" width="380" height="208" rx="8" fill="#bbf7d0" stroke="#16a34a" stroke-width="1.5"/><text x="210" y="220" text-anchor="middle" font-size="13" font-weight="700" fill="#166534">plugin-sdk (src/plugin-sdk/)</text><rect x="40" y="234" width="340" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="50" y="249" font-size="10" font-weight="600" fill="currentColor">plugin-entry.ts</text><text x="380" y="249" text-anchor="end" font-size="9" fill="#64748b">contract types</text><rect x="40" y="260" width="340" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="50" y="275" font-size="10" font-weight="600" fill="currentColor">provider-auth.ts / provider-auth-runtime.ts</text><text x="380" y="275" text-anchor="end" font-size="9" fill="#64748b">login flows</text><rect x="40" y="286" width="340" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="50" y="301" font-size="10" font-weight="600" fill="currentColor">provider-stream-shared.ts</text><text x="380" y="301" text-anchor="end" font-size="9" fill="#64748b">streamWithPayloadPatch</text><rect x="40" y="312" width="340" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="50" y="327" font-size="10" font-weight="600" fill="currentColor">provider-tools.ts</text><text x="380" y="327" text-anchor="end" font-size="9" fill="#64748b">tool-call compat hooks</text><rect x="40" y="338" width="340" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="50" y="353" font-size="10" font-weight="600" fill="currentColor">provider-catalog-shared.ts</text><text x="380" y="353" text-anchor="end" font-size="9" fill="#64748b">model catalog rows</text><rect x="40" y="364" width="340" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="50" y="379" font-size="10" font-weight="600" fill="currentColor">provider-model-shared.ts</text><text x="380" y="379" text-anchor="end" font-size="9" fill="#64748b">resolveClaudeThinkingProfile, ...</text><rect x="400" y="196" width="400" height="208" rx="8" fill="#fde68a" stroke="#f59e0b" stroke-width="1.5"/><text x="600" y="220" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">provider extension (extensions/&lt;provider&gt;/)</text><rect x="420" y="234" width="360" height="22" rx="3" fill="#fff7ed" stroke="#f59e0b"/><text x="430" y="249" font-size="10" font-weight="600" fill="currentColor">openclaw.plugin.json</text><text x="780" y="249" text-anchor="end" font-size="9" fill="#64748b">id, providers, prefixes, endpoints</text><rect x="420" y="260" width="360" height="22" rx="3" fill="#fff7ed" stroke="#f59e0b"/><text x="430" y="275" font-size="10" font-weight="600" fill="currentColor">index.ts</text><text x="780" y="275" text-anchor="end" font-size="9" fill="#64748b">definePluginEntry({ id, register })</text><rect x="420" y="286" width="360" height="22" rx="3" fill="#fff7ed" stroke="#f59e0b"/><text x="430" y="301" font-size="10" font-weight="600" fill="currentColor">register.runtime.ts</text><text x="780" y="301" text-anchor="end" font-size="9" fill="#64748b">api.registerProvider({...})</text><rect x="420" y="312" width="360" height="22" rx="3" fill="#fff7ed" stroke="#f59e0b"/><text x="430" y="327" font-size="10" font-weight="600" fill="currentColor">stream-wrappers.ts</text><text x="780" y="327" text-anchor="end" font-size="9" fill="#64748b">composeProviderStreamWrappers(...)</text><rect x="420" y="338" width="360" height="22" rx="3" fill="#fff7ed" stroke="#f59e0b"/><text x="430" y="353" font-size="10" font-weight="600" fill="currentColor">provider-discovery.ts</text><text x="780" y="353" text-anchor="end" font-size="9" fill="#64748b">augmentModelCatalog hook</text><rect x="420" y="364" width="360" height="22" rx="3" fill="#fff7ed" stroke="#f59e0b"/><text x="430" y="379" font-size="10" font-weight="600" fill="currentColor">config-defaults.ts</text><text x="780" y="379" text-anchor="end" font-size="9" fill="#64748b">applyConfigDefaults / normalizeConfig</text></svg>
<details><summary>ASCII original</summary>
```
agent-command → runAgentAttempt → stream(model, context, options)
       ↓ (model.api selects transport)
openclaw host (src/agents/*-transport-stream.ts)
  — builds request payload, opens SSE, normalizes events
  — delegates payload mutation to provider plugin via wrapStreamFn
       ↓
┌─ plugin-sdk (src/plugin-sdk/) ─────┐  ┌─ provider extension (extensions/<X>/) ──┐
│ plugin-entry.ts (contract types)   │  │ openclaw.plugin.json                    │
│ provider-auth.ts (login flows)     │  │ index.ts (definePluginEntry)            │
│ provider-stream-shared.ts          │  │ register.runtime.ts (api.registerProvider)│
│ provider-tools.ts (tool-call compat)│ │ stream-wrappers.ts (composeProviderStreamWrappers)│
│ provider-catalog-shared.ts         │  │ provider-discovery.ts                   │
│ provider-model-shared.ts           │  │ config-defaults.ts                      │
└────────────────────────────────────┘  └─────────────────────────────────────────┘
```
</details>
<span class="figure-caption">Figure R8.1 | Provider plugin architecture: the host owns transport; plugin-SDK defines the contract; each provider extension fills in vendor-specific hooks.</span>

## 8.2 What a provider plugin is

The user-facing concept is "a provider," but inside the codebase a provider extension is just a plugin that calls `api.registerProvider(...)` during setup. Look at the bundled Anthropic plugin's entry:

```ts
// extensions/anthropic/index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerAnthropicPlugin } from "./register.runtime.js";

export default definePluginEntry({
  id: "anthropic",
  name: "Anthropic Provider",
  description: "Bundled Anthropic provider plugin",
  register(api) {
    return registerAnthropicPlugin(api);
  },
});
```

The plugin id, package metadata, and capability flags come from a sibling JSON manifest:

```json5
// extensions/anthropic/openclaw.plugin.json (excerpt)
{
  "id": "anthropic",
  "activation": { "onStartup": false },
  "enabledByDefault": true,
  "providers": ["anthropic"],
  "providerCatalogEntry": "./provider-discovery.ts",
  "modelSupport": { "modelPrefixes": ["claude-"] },
  "modelIdNormalization": { "providers": { "anthropic": { "aliases": {
    "opus-4.6": "claude-opus-4-6", "opus-4.5": "claude-opus-4-5",
    "sonnet-4.6": "claude-sonnet-4-6", "sonnet-4.5": "claude-sonnet-4-5"
  } } } },
  "providerEndpoints": [
    { "endpointClass": "anthropic-public", "hosts": ["api.anthropic.com"] }
  ]
}
```

`extensions/openai/index.ts` is structurally the same:

```ts
// extensions/openai/index.ts:21-58 (abridged)
export default definePluginEntry({
  id: "openai",
  name: "OpenAI Provider",
  description: "Bundled OpenAI provider plugins",
  register(api) {
    ...
    api.registerProvider(buildProviderWithPromptContribution(buildOpenAIProvider()));
    api.registerProvider(buildProviderWithPromptContribution(buildOpenAICodexProviderPlugin()));
    api.registerMemoryEmbeddingProvider(openAiMemoryEmbeddingProviderAdapter);
    api.registerImageGenerationProvider(buildOpenAIImageGenerationProvider());
    api.registerRealtimeTranscriptionProvider(buildOpenAIRealtimeTranscriptionProvider());
    api.registerRealtimeVoiceProvider(buildOpenAIRealtimeVoiceProvider());
    api.registerSpeechProvider(buildOpenAISpeechProvider());
    api.registerMediaUnderstandingProvider(openaiMediaUnderstandingProvider);
    ...
  },
});
```

Two notes already worth taking:

1. **One plugin, many `registerProvider` calls.** OpenAI registers both the chat-completions/responses provider and the Codex (OAuth-on-ChatGPT-subscription) provider — they share auth helpers but expose different ids and different default models.
2. **A plugin can register more than providers.** The OpenAI plugin also registers an embedding provider, an image-generation provider, a realtime transcription provider, a realtime voice provider, a speech (TTS) provider, two media-understanding providers, and a video-generation provider. The provider-registration surface is the *biggest* in the SDK but not the only one.

The collected `ProviderPlugin` records are then made available to the rest of the host via `src/plugins/provider-runtime.ts`, which resolves "which plugin owns this `providerId`?" using the plugin's id, its aliases, and `hookAliases` (e.g. `claude-cli` is an alias of Anthropic — see `extensions/anthropic/register.runtime.ts:543`).

### 8.2.1 The `ProviderPlugin` shape

Look at the Anthropic provider's `buildAnthropicProvider` return value (`extensions/anthropic/register.runtime.ts:536-662`) — it's a long object literal but every field maps to a host call site:

```ts
return {
  id: providerId,                      // matched against model.provider
  label: "Anthropic",
  docsPath: "/providers/models",
  hookAliases: [CLAUDE_CLI_BACKEND_ID],  // 'claude-cli' resolves to this plugin too
  envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  oauthProfileIdRepairs: [{ legacyProfileId: "anthropic:default", promptLabel: "Anthropic" }],
  auth: [
    { id: "cli", label: "Claude CLI", kind: "custom", run, runNonInteractive, wizard: {...} },
    { id: "setup-token", label: "Anthropic setup-token", kind: "token", ... },
    createProviderApiKeyAuthMethod({ providerId, methodId: "api-key", ... }),
  ],
  normalizeConfig: ({ provider, providerConfig }) => normalizeAnthropicProviderConfigForProvider(...),
  applyConfigDefaults: ({ config, env }) => applyAnthropicConfigDefaults({ config, env }),
  resolveDynamicModel: (ctx) => { ... },   // forward-compat: 4.7 falls back to 4.6 template
  normalizeResolvedModel: (ctx) => normalizeAnthropicResolvedModel(ctx),
  resolveSyntheticAuth: ({ provider }) => ... ,  // synthesize an apiKey from Claude CLI native creds
  augmentModelCatalog: () => buildClaudeCliCatalogEntries(),
  buildReplayPolicy: buildAnthropicReplayPolicy,
  isModernModelRef: ({ modelId }) => matchesAnthropicModernModel(modelId),
  resolveReasoningOutputMode: () => "native",
  resolveThinkingProfile: ({ modelId }) => resolveClaudeThinkingProfile(modelId),
  wrapStreamFn: wrapAnthropicProviderStream,            // ← payload mutators applied to outbound payload
  resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
  fetchUsageSnapshot: async (ctx) => await fetchClaudeUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
  isCacheTtlEligible: () => true,
  buildAuthDoctorHint: (ctx) => buildAnthropicAuthDoctorHint({ ... }),
};
```

The contract is intentionally a *pile of optional hooks*. Each one corresponds to a question the host needs to ask at some point:

| Hook | Question the host needs answered |
|------|----------------------------------|
| `auth[]` | How does a user log in to this provider? |
| `normalizeConfig`, `applyConfigDefaults` | Should we rewrite the user's config for this provider? |
| `resolveDynamicModel` | The user typed `claude-opus-4-7`; we don't have a catalog entry — what should we synthesize? |
| `normalizeResolvedModel` | Given a resolved model, do you want to tweak `input`, `contextWindow`, etc.? |
| `resolveSyntheticAuth` | If no API key is configured but a sibling CLI is logged in, can we synthesize a credential? |
| `augmentModelCatalog` | Any extra rows to inject into the model catalog at runtime? |
| `isModernModelRef` | Does this model deserve modern-tier defaults (1M context, thinking on)? |
| `resolveReasoningOutputMode` | Native reasoning blocks, none, or formatted into text? |
| `resolveThinkingProfile` | Levels supported, budget tokens, default level. |
| `wrapStreamFn` | Apply payload mutations to the outbound request. |
| `resolveUsageAuth`, `fetchUsageSnapshot` | How do we read usage/billing info for the dashboard? |
| `isCacheTtlEligible` | Can we use long-TTL cache_control for this provider? |
| `buildAuthDoctorHint` | What should `openclaw doctor` say if auth is broken? |

Every hook is optional. A bare-minimum provider plugin (say, an OpenAI-compatible vendor that just needs an API key and a model list) ships maybe four hooks; Anthropic ships a dozen because it has CLI-OAuth quirks, modern-model upgrades, and a doctor experience.

## 8.3 Provider registration: from setup to runtime

Registration happens during plugin setup, not at runtime. `src/plugins/setup-registry.ts:472-513` builds a per-plugin `OpenClawPluginApi` whose `registerProvider` simply pushes into a host-managed array, deduplicating by `${pluginId}:${providerId}`:

```ts
// src/plugins/setup-registry.ts:472-499
const api = buildSetupPluginApi({
  record, setupSource: setupRegistration.setupSource,
  handlers: {
    registerProvider(provider) {
      const key = `${record.id}:${normalizeProviderId(provider.id)}`;
      if (providerKeys.has(key)) {
        return;  // already registered (idempotent reload)
      }
      providerKeys.add(key);
      providers.push({ pluginId: record.id, provider });
      recordProviders.push(provider);
    },
    registerCliBackend(backend) { ... },
    registerConfigMigration(migrate) { ... },
    registerAutoEnableProbe(probe) { ... },
  },
});
```

This separation matters: the runtime never mutates the provider registry. A provider is *static* once registration is complete; reloading the gateway re-runs the setup pass and rebuilds the registry from scratch. That makes Chapter 10's plugin-system reasoning much cleaner — the provider list is a pure function of the config snapshot.

The "find the plugin that owns this provider" lookup at agent-attempt time goes through `src/plugins/provider-runtime.ts:89-100`:

```ts
function matchesProviderPluginRef(provider: ProviderPlugin, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) return false;
  if (normalizeProviderId(provider.id) === normalized) return true;
  return [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
    (alias) => normalizeProviderId(alias) === normalized,
  );
}
```

The host also resolves *which model API* to use:

```ts
// src/plugins/provider-runtime.ts:102-109
function resolveProviderHookRefs(provider: string, providerConfig?: ModelProviderConfig, modelApi?: string): string[] {
  const refs = [provider];
  const apiRef = normalizeOptionalString(modelApi ?? providerConfig?.api);
  if (apiRef && normalizeProviderId(apiRef) !== normalizeProviderId(provider)) {
    refs.push(apiRef);
  }
  return [...new Set(refs)];
}
```

The `model.api` field is the routing key for the transport selection (§8.5). `"anthropic-messages"` → Anthropic transport; `"openai-completions"` → OpenAI completions transport; `"openai-responses"` / `"openai-codex-responses"` / `"azure-openai-responses"` → OpenAI Responses transport.

## 8.4 The model catalog

The catalog answers: *given the configured providers and plugins, which (provider, model) pairs exist, and what are their capabilities?* Capabilities matter because tool-call support, image input, reasoning effort, max-tokens semantics, and context window are not orthogonal — they all need to be available at attempt time.

The catalog lives in `src/model-catalog/`. Its public surface (`src/model-catalog/index.ts:1-33`) is small:

```ts
export { mergeModelCatalogRowsByAuthority } from "./authority.js";
export {
  buildModelCatalogMergeKey, buildModelCatalogRef, normalizeModelCatalogProviderId,
} from "./refs.js";
export { normalizeModelCatalog, normalizeModelCatalogRows } from "./normalize.js";
export { loadOpenClawProviderIndex } from "./provider-index/index.js";
export {
  planManifestModelCatalogRows, planManifestModelCatalogSuppressions,
} from "./manifest-planner.js";
export { planProviderIndexModelCatalogRows } from "./provider-index-planner.js";
export type {
  ModelCatalog, ModelCatalogAlias, ModelCatalogCost,
  ModelCatalogDiscovery, ModelCatalogInput, ModelCatalogModel,
  ModelCatalogProvider, ModelCatalogSource, ModelCatalogStatus,
  ModelCatalogSuppression, ModelCatalogTieredCost, NormalizedModelCatalogRow,
  UnifiedModelCatalogEntry, UnifiedModelCatalogKind, UnifiedModelCatalogSource,
} from "./types.js";
```

### 8.4.1 The model catalog row

```ts
// src/model-catalog/types.ts:61-86 (excerpt)
export type ModelCatalogModel = {
  id: string;
  name?: string;
  api?: ModelApi;
  baseUrl?: string;
  headers?: Record<string, string>;
  input?: ModelCatalogInput[];   // "text" | "image" | "document"
  reasoning?: boolean;
  contextWindow?: number;
  contextTokens?: number;
  maxTokens?: number;
  cost?: ModelCatalogCost;       // input/output/cache costs in $/M tokens
  compat?: ModelCompatConfig;
  status?: ModelCatalogStatus;
  statusReason?: string;
  replaces?: string[];
  replacedBy?: string;
  tags?: string[];
};

export type ModelCatalogProvider = {
  baseUrl?: string;
  api?: ModelApi;
  headers?: Record<string, string>;
  models: ModelCatalogModel[];
};
```

A normalized *row* (`NormalizedModelCatalogRow`) is one (provider, model) pair plus its `source` (where it came from):

```ts
// src/model-catalog/types.ts:6-11
export type ModelCatalogSource =
  | "manifest"        // declared in a plugin's openclaw.plugin.json
  | "provider-index"  // shipped via the central provider-index dataset
  | "cache"           // persisted snapshot of a runtime refresh
  | "config"          // user wrote it in the config file
  | "runtime-refresh"; // hit the provider's /models endpoint at runtime
```

### 8.4.2 The merge key and the authority order

Two plugins might declare overlapping models — e.g. an OpenRouter manifest entry and a runtime refresh from the actual OpenRouter `/models` endpoint. They collapse to one row via a merge key:

```ts
// src/model-catalog/refs.ts:7-12
export function buildModelCatalogRef(provider: string, modelId: string): string {
  return `${normalizeModelCatalogProviderId(provider)}/${modelId}`;
}
export function buildModelCatalogMergeKey(provider: string, modelId: string): string {
  return `${normalizeModelCatalogProviderId(provider)}::${normalizeLowercaseStringOrEmpty(modelId)}`;
}
```

The merge key is lowercased on the model id (so `claude-opus-4-7` and `Claude-Opus-4-7` collide), the *ref* preserves case for display.

When two sources contribute the same merge key, the lower authority number wins:

```ts
// src/model-catalog/authority.ts:1-30 (abridged)
const MODEL_CATALOG_SOURCE_AUTHORITY: Readonly<Record<ModelCatalogSource, number>> = {
  config: 0,
  manifest: 1,
  cache: 2,
  "runtime-refresh": 2,
  "provider-index": 3,
};

export function mergeModelCatalogRowsByAuthority(rows): NormalizedModelCatalogRow[] {
  const byMergeKey = new Map<string, NormalizedModelCatalogRow>();
  for (const row of rows) {
    const existing = byMergeKey.get(row.mergeKey);
    if (!existing || compareModelCatalogSourceAuthority(row.source, existing.source) < 0) {
      byMergeKey.set(row.mergeKey, row);
    }
  }
  ...
}
```

Configuration the user wrote beats anything bundled. Manifest declarations beat cached/refreshed data. Both beat the central provider-index dataset. The provider-index is the *fallback*, not the source of truth.

### 8.4.3 The manifest planner and conflict detection

When two plugins both claim ownership of `(provider, model)`, the manifest planner records it as a conflict instead of silently letting one win:

```ts
// src/model-catalog/manifest-planner.ts:28-41
type ManifestModelCatalogConflict = {
  mergeKey: string;
  ref: string;
  provider: string;
  modelId: string;
  firstPluginId: string;
  secondPluginId: string;
};

type ManifestModelCatalogPlan = {
  rows: readonly NormalizedModelCatalogRow[];
  entries: readonly ManifestModelCatalogPlanEntry[];
  conflicts: readonly ManifestModelCatalogConflict[];
};
```

`openclaw doctor` surfaces these. The wider design is "bundled plugins should not overlap on provider models — if they do, that's a packaging bug." Runtime-refresh and provider-index entries are not part of this conflict pass because their authority is *lower* than the manifest, so manifest entries win without anyone arguing.

### 8.4.4 Building the catalog at runtime

The agent-command consults the catalog only when there is an allowlist to apply:

```ts
// src/agents/agent-command.ts:856-878 (abridged)
const needsModelCatalog = Boolean(hasAllowlist);
let allowedModelCatalog: ReturnType<typeof loadManifestModelCatalog> = [];
let modelCatalog: ReturnType<typeof loadManifestModelCatalog> | null = null;
let visibilityPolicy: ModelVisibilityPolicy = createModelVisibilityPolicy({
  cfg, catalog: [], defaultProvider, defaultModel, ...modelManifestContext,
});

if (needsModelCatalog) {
  modelCatalog = loadManifestModelCatalog({ config: cfg, workspaceDir });
  visibilityPolicy = createModelVisibilityPolicy({
    cfg, catalog: modelCatalog, defaultProvider, defaultModel,
    agentId: sessionAgentId, ...modelManifestContext,
  });
  allowedModelCatalog = visibilityPolicy.allowedCatalog;
}
```

`loadManifestModelCatalog` reads only manifest+config sources (no I/O). The runtime-refresh path runs through a separate `src/gateway/server-model-catalog.ts` endpoint that hits provider `/models` endpoints on a configured cadence and persists the result to disk under the cache source.

## 8.5 The unified call shape

Every provider call lands in one of three transport functions:

```ts
// src/agents/anthropic-transport-stream.ts:918
export function createAnthropicMessagesTransportStreamFn(): StreamFn { ... }

// src/agents/openai-transport-stream.ts:1721, 2125, 2366
export function createOpenAIResponsesTransportStreamFn(): StreamFn { ... }
export function createAzureOpenAIResponsesTransportStreamFn(): StreamFn { ... }
export function createOpenAICompletionsTransportStreamFn(): StreamFn { ... }
```

All four return a `StreamFn` from `@earendil-works/pi-agent-core` with the shape `(model, context, options) => StreamEventIterable`. The events are normalized; the SSE-parsing differences between Anthropic and OpenAI are confined to the transport implementation.

### 8.5.1 The writable event stream

The shared scaffold is `createWritableTransportEventStream` (`src/agents/transport-stream-shared.ts:104-125`). Both transports build an `AssistantOutput` accumulator (the eventual return value) plus a writable event stream that consumers iterate:

```ts
// src/agents/anthropic-transport-stream.ts:918-955 (abridged)
export function createAnthropicMessagesTransportStreamFn(): StreamFn {
  return (rawModel, context, rawOptions) => {
    const model = rawModel as AnthropicTransportModel;
    const options = rawOptions as AnthropicTransportOptions | undefined;
    const { eventStream, stream } = createWritableTransportEventStream();
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant", content: [], api: "anthropic-messages",
        provider: model.provider, model: model.id,
        usage: createEmptyTransportUsage(), stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
        if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
        const transportOptions = resolveAnthropicTransportOptions(model, options, apiKey);
        const { client, isOAuthToken } = createAnthropicTransportClient({...});
        let params = buildAnthropicParams(model, context, isOAuthToken, transportOptions);
        const nextParams = await transportOptions.onPayload?.(params, model);
        if (nextParams !== undefined) params = nextParams as Record<string, unknown>;
        const anthropicStream = client.messages.stream(
          { ...params, stream: true },
          transportOptions.signal ? { signal: transportOptions.signal } : undefined,
        );
        stream.push({ type: "start", partial: output as never });
        ...
```

Note the `onPayload` hook on `transportOptions`. This is the seam through which provider plugins inject their tweaks (e.g. Anthropic's `service_tier`, cache-control TTL, beta headers). The plugin's `wrapStreamFn` returns a function that wraps the host's transport `StreamFn` and routes the payload through `streamWithPayloadPatch` (`src/plugin-sdk/provider-stream-shared.ts:36-61`):

```ts
// src/plugin-sdk/provider-stream-shared.ts:36-61
export function createPayloadPatchStreamWrapper(
  baseStreamFn: StreamFn | undefined,
  patchPayload: (params: {
    payload: Record<string, unknown>;
    model: Parameters<StreamFn>[0];
    context: Parameters<StreamFn>[1];
    options: Parameters<StreamFn>[2];
  }) => void,
  wrapperOptions?: { shouldPatch?: (params) => boolean },
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (wrapperOptions?.shouldPatch && !wrapperOptions.shouldPatch({ model, context, options })) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payload) =>
      patchPayload({ payload, model, context, options }),
    );
  };
}
```

`streamWithPayloadPatch` (re-exported at `src/plugin-sdk/provider-stream-shared.ts:693`) calls the underlying stream with an `onPayload` callback that lets the plugin mutate the params dict before it goes on the wire. This is how `extensions/anthropic/stream-wrappers.ts` adds the `anthropic-beta` header for 1M-context Claude models and applies the service-tier policy without the host having to know what either is.

### 8.5.2 The event types

Both transports emit the same in-process events: `start`, `text_start`/`text_delta`/`text_end`, `thinking_start`/`thinking_delta`/`thinking_end`, `tool_use_start`/`tool_use_input_delta`/`tool_use_end`, `done`, and `error`. The Anthropic side maps from Anthropic's SSE event names (`message_start`, `content_block_start`, `content_block_delta`, `message_delta`, `message_stop`); the OpenAI side maps from OpenAI's `chat.completion.chunk` deltas (`choices[].delta.content`, `tool_calls`, `finish_reason`).

The Anthropic transport's mapping of *reasoning content* into both a `thinking` block and a sidecar `text` block (the dual maps `reasoningContentThinkingBlocks` and `reasoningContentTextBlocks`, `src/agents/anthropic-transport-stream.ts:958-1066`) is a particularly thorny piece. Some Anthropic API variants emit reasoning as separate `thinking` content blocks; some emit it inline inside `text` blocks with a special `thinkingSignature`. The transport normalizes both so consumers see one shape regardless of which variant the upstream API is using.

<svg viewBox="0 0 820 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="streaming events normalization"><defs><marker id="r82arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><rect x="20" y="20" width="240" height="180" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="140" y="44" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">Anthropic SSE</text><text x="140" y="64" text-anchor="start" font-size="10" fill="currentColor">  message_start</text><text x="40" y="80" text-anchor="start" font-size="10" fill="currentColor">  content_block_start (text/thinking/tool_use)</text><text x="40" y="96" text-anchor="start" font-size="10" fill="currentColor">  content_block_delta</text><text x="40" y="112" text-anchor="start" font-size="10" fill="currentColor">  content_block_stop</text><text x="40" y="128" text-anchor="start" font-size="10" fill="currentColor">  message_delta { stop_reason, usage }</text><text x="40" y="144" text-anchor="start" font-size="10" fill="currentColor">  message_stop</text><text x="40" y="166" text-anchor="start" font-size="9" fill="#64748b">anthropic-transport-stream.ts:1067+</text><text x="40" y="180" text-anchor="start" font-size="9" fill="#64748b">+ reasoning_content sidecar mapping</text><rect x="290" y="20" width="240" height="180" rx="8" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="410" y="44" text-anchor="middle" font-size="12" font-weight="700" fill="#92400e">OpenAI Chat Completions SSE</text><text x="310" y="64" text-anchor="start" font-size="10" fill="currentColor">  data: { choices[0].delta.content }</text><text x="310" y="80" text-anchor="start" font-size="10" fill="currentColor">  data: { choices[0].delta.tool_calls }</text><text x="310" y="96" text-anchor="start" font-size="10" fill="currentColor">  data: { choices[0].delta.reasoning }</text><text x="310" y="112" text-anchor="start" font-size="10" fill="currentColor">  data: { choices[0].finish_reason }</text><text x="310" y="128" text-anchor="start" font-size="10" fill="currentColor">  data: { usage }</text><text x="310" y="144" text-anchor="start" font-size="10" fill="currentColor">  data: [DONE]</text><text x="310" y="170" text-anchor="start" font-size="9" fill="#64748b">openai-transport-stream.ts:2366+</text><text x="310" y="184" text-anchor="start" font-size="9" fill="#64748b">+ deepseek/openrouter compat layers</text><rect x="560" y="20" width="240" height="180" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="680" y="44" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">OpenAI Responses SSE</text><text x="580" y="64" text-anchor="start" font-size="10" fill="currentColor">  response.created</text><text x="580" y="80" text-anchor="start" font-size="10" fill="currentColor">  response.output_item.added</text><text x="580" y="96" text-anchor="start" font-size="10" fill="currentColor">  response.output_text.delta</text><text x="580" y="112" text-anchor="start" font-size="10" fill="currentColor">  response.reasoning_summary_text.delta</text><text x="580" y="128" text-anchor="start" font-size="10" fill="currentColor">  response.function_call_arguments.delta</text><text x="580" y="144" text-anchor="start" font-size="10" fill="currentColor">  response.completed { usage }</text><text x="580" y="170" text-anchor="start" font-size="9" fill="#64748b">openai-transport-stream.ts:1721+</text><text x="580" y="184" text-anchor="start" font-size="9" fill="#64748b">+ codex-responses variants</text><line x1="140" y1="200" x2="140" y2="240" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r82arrow)"/><line x1="410" y1="200" x2="410" y2="240" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r82arrow)"/><line x1="680" y1="200" x2="680" y2="240" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r82arrow)"/><rect x="20" y="240" width="780" height="120" rx="8" fill="#bbf7d0" stroke="#16a34a" stroke-width="1.5"/><text x="410" y="262" text-anchor="middle" font-size="13" font-weight="700" fill="#166534">unified WritableTransportEventStream (transport-stream-shared.ts:104)</text><rect x="40" y="276" width="240" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="160" y="291" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">{ type: "start", partial }</text><rect x="40" y="300" width="240" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="160" y="315" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">{ type: "text_delta", contentIndex, delta, partial }</text><rect x="40" y="324" width="240" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="160" y="339" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">{ type: "thinking_delta", ... }</text><rect x="290" y="276" width="240" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="410" y="291" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">{ type: "tool_use_start", ... }</text><rect x="290" y="300" width="240" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="410" y="315" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">{ type: "tool_use_input_delta", ... }</text><rect x="290" y="324" width="240" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="410" y="339" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">{ type: "tool_use_end", ... }</text><rect x="540" y="276" width="240" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="660" y="291" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">{ type: "done", reason, message }</text><rect x="540" y="300" width="240" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="660" y="315" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">{ type: "error", reason, error }</text><rect x="540" y="324" width="240" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="660" y="339" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">output.usage = { input, output, cache* }</text></svg>
<details><summary>ASCII original</summary>
```
Anthropic SSE          OpenAI Completions SSE      OpenAI Responses SSE
─────────────          ──────────────────────      ────────────────────
message_start          chat.completion.chunk       response.created
content_block_start    (delta.content / tool_calls) response.output_item.added
content_block_delta    finish_reason               response.output_text.delta
message_delta          usage / [DONE]              response.reasoning_summary_text.delta
message_stop                                       response.completed
       ↓                       ↓                          ↓
       ─────── unified WritableTransportEventStream ──────
       { start } { text_delta } { thinking_delta }
       { tool_use_start } { tool_use_input_delta } { tool_use_end }
       { done, reason, message } { error, reason, error }
       output.usage = { input, output, cacheRead, cacheWrite }
```
</details>
<span class="figure-caption">Figure R8.2 | Three SSE wire formats are normalized to a single event stream consumed by pi-agent-core.</span>

### 8.5.3 The OpenAI Completions payload builder

`buildOpenAICompletionsParams` (`src/agents/openai-transport-stream.ts:3332-3457`) is the canonical seam for OpenAI-shaped payloads. It is structured around compat flags from `detectOpenAICompletionsCompat`:

```ts
// src/agents/openai-transport-stream.ts:3332-3390 (abridged)
export function buildOpenAICompletionsParams(model, context, options) {
  const compat = getCompat(model);
  const compatDetection = detectOpenAICompletionsCompat(model);
  const completionsContext = context.systemPrompt
    ? { ...context, systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt) }
    : context;
  let messages = convertMessages(model as never, completionsContext, compat as never);
  injectToolCallThoughtSignatures(messages as unknown[], context, model);
  sanitizeCompletionsReasoningReplayFields(messages, { ... });
  if (compat.strictMessageKeys) {
    messages = stripCompletionMessagesToRoleContent(messages) as typeof messages;
  }
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const params: Record<string, unknown> = {
    model: model.id,
    messages: compat.requiresStringContent
      ? flattenCompletionMessagesToStringContent(messages)
      : messages,
    stream: true,
  };
  if (compat.supportsUsageInStreaming) params.stream_options = { include_usage: true };
  if (compat.supportsStore) params.store = false;
  if (compat.supportsPromptCacheKey && cacheRetention !== "none" && options?.sessionId) {
    params.prompt_cache_key = options.sessionId;
  }
  ...
```

The `compat` object (from `detectOpenAICompletionsCompat`, see `src/agents/openai-completions-compat.ts:35-116`) is the dense knob panel that lets one builder serve OpenAI, OpenRouter, DeepSeek, Together, Cerebras, Chutes, Moonshot, Z.ai, Xiaomi, Mistral, xAI, OpenCode, and local endpoints:

```ts
// src/agents/openai-completions-compat.ts:85-115 (excerpt)
return {
  supportsStore: !isNonStandard && knownProviderFamily !== "mistral" && !usesExplicitProxyLikeEndpoint,
  supportsDeveloperRole: !isNonStandard && !isMoonshotLike && !usesConfiguredNonOpenAIEndpoint,
  supportsReasoningEffort:
    !isZai && !isTogether && knownProviderFamily !== "mistral" &&
    endpointClass !== "xai-native" && !usesExplicitProxyLikeEndpoint,
  supportsUsageInStreaming:
    supportsOpenAICompletionsStreamingUsageCompat ||
    (!isNonStandard &&
      (isLocalEndpoint || !usesConfiguredNonOpenAIEndpoint || supportsNativeStreamingUsageCompat)),
  maxTokensField: usesMaxTokens ? "max_tokens" : "max_completion_tokens",
  thinkingFormat: isDeepSeek || isXiaomi ? "deepseek"
                : isZai ? "zai"
                : isTogether ? "together"
                : isOpenRouterLike ? "openrouter"
                : "openai",
  visibleReasoningDetailTypes: isOpenRouterLike ? ["response.output_text", "response.text"] : [],
  supportsStrictMode: !isZai && !usesConfiguredNonOpenAIEndpoint,
  requiresReasoningContentOnAssistantMessages: isDeepSeek || isXiaomi,
};
```

Every flag is one boolean that flips one piece of payload behavior. Adding a new OpenAI-compat vendor mostly means: register a `providerEndpoints[]` entry pointing at the right `endpointClass`, and verify that the flag matrix produces the right output. Sometimes it means adding a new flag (e.g. `usesExplicitProxyLikeEndpoint` was added when proxy-like servers started rejecting `tools: []`, §8.10).

### 8.5.4 Tool-call normalization

Anthropic and OpenAI describe tools differently on the wire:

- **Anthropic** emits `content[]` items of `type: "tool_use"` with `id`, `name`, and `input` (a JSON object). Tool results come back as `content[]` items of `type: "tool_result"` with `tool_use_id` and `content`.
- **OpenAI Chat Completions** emits `choices[0].delta.tool_calls[]` with `id`, `function: { name, arguments }` (arguments is a stringified JSON). Tool results come back as messages with `role: "tool"`, `tool_call_id`, and `content`.
- **OpenAI Responses** emits `output[]` items of `type: "function_call"` with `name`, `arguments`, `call_id`. Tool results come back as `function_call_output` items.

The transports map all three to the same `tool_use_start` / `tool_use_input_delta` / `tool_use_end` event sequence with the same shape. Downstream consumers (the tool loop in `runAgentAttempt`, the trajectory recorder, the TUI renderer) never see the wire differences.

The plugin-SDK side of this is `provider-tools.ts`:

```ts
// extensions/openai/index.ts:26-46 (abridged, focusing on tool compat)
const openAIToolCompatHooks = buildProviderToolCompatFamilyHooks("openai");
const buildProviderWithPromptContribution = <T>(provider: T): T => ({
  ...provider,
  ...openAIToolCompatHooks,
  resolveSystemPromptContribution: (ctx) => { ... },
});
```

`buildProviderToolCompatFamilyHooks` returns hooks that ensure tool *schemas* conform to OpenAI's strict-mode constraints (no unsupported JSON Schema features, no `additionalProperties: true` at the top level, etc.). This runs at *prompt build* time, not transport time — the schemas are normalized before they enter the request payload.

## 8.6 Credential management and rotation

§7.6 introduced auth profiles from the agent-command's point of view. From the provider-plugin point of view, credentials are produced by the plugin's `auth[]` array and consumed by the host through three call paths:

1. **`getEnvApiKey(provider)`** (from `@earendil-works/pi-ai`) reads `OPENAI_API_KEY`-style env vars. The provider plugin's `envVars` field tells the host which keys to honor (see Anthropic's `["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]` at `extensions/anthropic/register.runtime.ts:544`).

2. **Auth profiles in the store** — managed under `src/agents/auth-profiles/`. Each profile has a `type` (`api-key`, `oauth`, `token`), a `provider`, and credentials. `resolveApiKeyForProfile` (`src/agents/auth-profiles.ts:21`) converts a profile id to an API key string, refreshing OAuth tokens when needed. `markAuthProfileFailure`, `markAuthProfileCooldown`, `clearAuthProfileCooldown` (`src/agents/auth-profiles.ts:79-90`) track per-profile rate-limit state.

3. **Synthetic auth from sibling CLIs** — the provider plugin's `resolveSyntheticAuth` hook returns a credential synthesized from an external CLI (e.g. Claude CLI's `~/.config/claude-cli/credentials.json`). This is the path that makes ChatGPT/Codex OAuth and Claude CLI OAuth work without the user re-pasting a token (see Anthropic's `resolveClaudeCliSyntheticAuth` at `extensions/anthropic/register.runtime.ts:454-472`).

### 8.6.1 Per-key rotation inside an attempt

When the chosen credential fails with a rate-limit error, the host rotates to the next credential for the *same provider* before falling through to a fallback model. This is `src/agents/api-key-rotation.ts`:

```ts
// src/agents/api-key-rotation.ts (top, abridged)
import { sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  resolveTransientProviderAttempts,
  resolveTransientProviderDelayMs,
  resolveTransientProviderRetryOptions,
  shouldRetrySameKeyProviderOperation,
  type TransientProviderRetryConfig,
} from "../provider-runtime/operation-retry.js";
import { collectProviderApiKeys, isApiKeyRateLimitError } from "./live-auth-keys.js";

type ExecuteWithApiKeyRotationOptions<T> = {
  provider: string;
  apiKeys: string[];
  execute: (apiKey: string) => Promise<T>;
  shouldRetry?: ...;
  onRetry?: ...;
  transientRetry?: TransientProviderRetryConfig;
};
```

The strategy is: try the first key, on a non-retryable error give up; on a rate-limit error rotate to the next key; on a transient error retry the *same* key up to `attempts` times with exponential backoff. The retry inside one key uses the provider-runtime classifier (§8.7); the rotation across keys uses `isApiKeyRateLimitError` (`src/agents/live-auth-keys.ts`) to recognize provider-specific rate-limit signals.

## 8.7 Operation retry

`src/provider-runtime/operation-retry.ts` is the provider-agnostic transient-failure retry primitive. It exposes:

- **`isTransientProviderOperationError(error, message)`** — the classifier (`src/provider-runtime/operation-retry.ts:145-171`). Status codes 500/502/503/504 are transient; 400/401/403/404 and signals like `invalid api key`, `permission denied`, `model not found`, `validation`, `unsupported model` are *non-retryable* and short-circuit. Network signals (`ECONNRESET`/`ECONNREFUSED`/`ETIMEDOUT`/`EAI_AGAIN`) are transient. Timeouts (`TimeoutError`, `RequestTimeoutError`, or messages containing `timed out`/`timeout`) are transient. `fetch failed` is transient *only* if it has a transient cause — otherwise it might be a DNS misconfiguration that retrying can't help.

  ```ts
  // src/provider-runtime/operation-retry.ts:145-171
  export function isTransientProviderOperationError(error: unknown, message: string): boolean {
    const status = readErrorStatus(error);
    if (status !== undefined) {
      return status === 500 || status === 502 || status === 503 || status === 504;
    }
    if (
      /\b(?:HTTP\s*)?(?:400|401|403|404)\b/i.test(message) ||
      /\b(?:invalid api key|permission denied|model not found|validation|unsupported model)\b/i.test(message)
    ) return false;
    if (/\b(?:HTTP\s*)?(?:500|502|503|504)\b/i.test(message)) return true;
    if (hasTransientNetworkSignal(error, message)) return true;
    if (hasTimeoutSignal(error, message)) return true;
    if (/\bfetch failed\b/i.test(message)) return hasTransientNetworkSignal(error, message);
    return false;
  }
  ```

- **`executeProviderOperationWithRetry`** (`src/provider-runtime/operation-retry.ts:226-266`) — the loop. Resolves attempt count, base delay, max delay from `TransientProviderRetryOptions`; runs the operation; on failure either re-throws non-retryable errors or computes a backoff delay and tries again.

  ```ts
  // src/provider-runtime/operation-retry.ts:226-266 (abridged)
  export async function executeProviderOperationWithRetry<T>(params: {
    provider: string;
    stage: ProviderOperationRetryStage;  // "read" | "poll" | "download" | "create"
    operation: () => Promise<T>;
    retry?: TransientProviderRetryConfig;
  }): Promise<T> {
    const retryConfig = providerOperationRetryConfig(params.stage, params.retry);
    const retryOptions = resolveTransientProviderRetryOptions(retryConfig);
    const maxAttempts = resolveTransientProviderAttempts(retryOptions);
    let lastError: unknown;
    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      try { return await params.operation(); }
      catch (error) {
        lastError = error;
        const message = formatErrorMessage(error);
        if (!retryOptions || !shouldRetrySameKeyProviderOperation({ ... })) throw error;
        const delayMs = resolveTransientProviderDelayMs(retryOptions, attemptNumber);
        const sleep = retryOptions.sleep ?? sleepWithAbort;
        await sleep(delayMs, retryOptions.signal);
      }
    }
    throw lastError;
  }
  ```

- **Stage-aware defaults.** `defaultTransientProviderRetryForStage(stage)` returns `undefined` for the `create` stage (don't retry creation operations like provisioning a new conversation thread — they're not idempotent) and `true` for `read`/`poll`/`download` (which are idempotent or designed to be poll-safe). This is a small but important policy choice: the retry layer doesn't have to know the operation's semantics if the caller picks the right stage label.

  ```ts
  // src/provider-runtime/operation-retry.ts:48-52
  export function defaultTransientProviderRetryForStage(
    stage: ProviderOperationRetryStage,
  ): TransientProviderRetryConfig | undefined {
    return stage === "create" ? undefined : true;
  }
  ```

The defaults are conservative: `attempts: 2` (one initial call plus one retry), `baseDelayMs: 250`, `maxDelayMs: 1000`. Exponential growth uses `baseDelayMs * 2^(attemptNumber - 1)` clamped to `maxDelayMs`. This is fine for transient hiccups but won't survive a long outage — for that you want model fallback (Chapter 07) or a higher-level circuit breaker.

## 8.8 The two narrow v2026.5.22 changes — viewed from the provider side

Two production fixes shipped between v2026.5.18 and v2026.5.22 touch the provider boundary. Chapter 07 explains them from the agent-command's perspective; this chapter explains them from the provider-integration perspective.

### 8.8.1 PR #85603 — openai-responses family in the retry guard

Commit `49e9c3eb13` (`fix(agents): add openai-responses family to non-visible turn retry guard (#85603)`) widens `RETRY_GUARD_MODEL_APIS` in `src/agents/pi-embedded-runner/run/incomplete-turn.ts`:

```ts
// src/agents/pi-embedded-runner/run/incomplete-turn.ts:136-148
// Model APIs eligible for the non-visible turn retry guard.  OpenAI Responses
// family can produce reasoning-only turns where usage.output > 0 but no visible
// text is emitted; without the guard these pass through as successful. (#85364)
const RETRY_GUARD_MODEL_APIS = new Set([
  "openai-completions",
  "anthropic-messages",
  "bedrock-converse-stream",
  "openai-responses",                          // ← added
  "openai-codex-responses",                    // ← added
  "azure-openai-responses",                    // ← added
  "openclaw-openai-responses-transport",       // ← added
  "openclaw-azure-openai-responses-transport", // ← added
]);
```

The relevant provider-integration angle: **the entries are *API* ids, not *provider* ids**. A single provider (say "openai") can expose models on multiple APIs (`openai-completions` for `gpt-5.4`, `openai-responses` for `o1`, `openai-codex-responses` for Codex models). The retry guard cuts at the API boundary because the misbehavior — emitting tokens billed as `usage.output_tokens` but no visible content — is an API-level behavior, not a provider-level one. The five entries collectively cover both first-party APIs and the two `openclaw-*-transport` aliases that internal proxy plugins use.

The PR also adds tests at `src/agents/pi-embedded-runner/run.incomplete-turn.test.ts` (+48 lines per the commit stat). The behavior under test is straightforward: an attempt that returns `usage.output > 0` and empty `assistantTexts` should request a continuation retry when the model API is one of the listed entries, and should *not* request retry when the model API is something else (e.g. an unknown vendor that the host doesn't have a continuation prompt strategy for).

### 8.8.2 Empty-tools omission for proxy-like endpoints

Commit `75081569b0` (`fix(agents): omit empty tools array for proxy-like openai-completions endpoints`) modifies `buildOpenAICompletionsParams`:

```ts
// src/agents/openai-transport-stream.ts:3406-3413
if (
  compatDetection.capabilities.usesExplicitProxyLikeEndpoint &&
  Array.isArray(params.tools) &&
  params.tools.length === 0
) {
  delete params.tools;
  delete params.tool_choice;
}
```

The flag `usesExplicitProxyLikeEndpoint` is set by `detectOpenAICompletionsCompat` for endpoint classes that have been declared "proxy-like" — i.e. servers that re-host OpenAI-shape APIs without exactly matching OpenAI's input grammar. The bundled examples include vLLM, LocalAI, llama.cpp, LM Studio, and the consumer plugins (zai, xiaomi, deepseek) that declare themselves proxy-like in their plugin manifest.

Three things make this fix interesting from the provider-integration perspective:

1. **Three call paths get fixed for the price of one.** The gateway HTTP handler calls `buildOpenAICompletionsParams`. The embedded pi runner calls `buildOpenAICompletionsParams`. The public plugin-SDK consumers (third-party plugins built against `openclaw/plugin-sdk`) call `buildOpenAICompletionsParams`. The commit message calls this "the canonical payload builder seam" — fixing it once means everyone gets it. The earlier patch (`#70790`) only fixed the gateway path; this supersedes it.

2. **`tool_choice` follows `tools`.** The earlier code only set `tool_choice = "auto"` when `tools` was non-empty (`src/agents/openai-transport-stream.ts:3396-3402`). The new strip removes both in lockstep so the request never has `tool_choice` without `tools`, which proxy-like endpoints also reject.

3. **The commit specifically calls out byte-identical behavior for native paths.** Native OpenAI, Azure OpenAI, OpenRouter — they all have `usesExplicitProxyLikeEndpoint: false`, so the strip is skipped and the payload is unchanged. The fix is genuinely safe to deploy because the only code path that flips behavior is the one that was already broken for proxy-like endpoints.

A test pair lives at `src/agents/openai-transport-stream.test.ts` (+136 lines per the commit stat) verifying both cases.

These two fixes together illustrate a pattern: provider-integration bugs typically live not in the provider plugin but in the *host-side compat layer* that translates between unified intent and vendor-specific wire format. Both fixes are inside `src/agents/`, not inside `extensions/`. The plugin contract is stable; the host's interpretation of it evolves.

## 8.9 The OpenAI Responses payload policy

One more host-side seam worth pointing at, because it explains why the openai-responses family needed its own retry-guard entry. `src/agents/openai-responses-payload-policy.ts:1-40` declares the endpoint classes that the Responses transport recognizes:

```ts
// src/agents/openai-responses-payload-policy.ts:20-40 (excerpt)
type OpenAIResponsesEndpointClass =
  | "default" | "anthropic-public" | "cerebras-native" | "chutes-native"
  | "deepseek-native" | "github-copilot-native" | "groq-native" | "mistral-public"
  | "moonshot-native" | "modelstudio-native" | "openai-public" | "openai-codex"
  | "opencode-native" | "azure-openai" | "openrouter" | "xai-native" | "zai-native"
  | "google-generative-ai" | "google-vertex" | "local" ...
```

Each of these classes corresponds to an entry in the `providerEndpoints[]` array of one or more provider plugins (e.g. `extensions/anthropic/openclaw.plugin.json` declares `endpointClass: "anthropic-public"` for `api.anthropic.com`). The mapping is provider-plugin-driven; the host's only job is to *route* model traffic through the policy that matches the resolved endpoint class.

The Responses payload policy then decides per-class:

- `storeMode` — should we set `store: false` to disable conversation persistence?
- `enablePromptCacheStripping` — should we strip the system-prompt cache boundary marker?
- `enableServerCompaction` — should we let the server do its own context compaction?
- Plus a long tail of per-class quirks (parameter name differences, header tweaks).

The retry-guard fix (§8.8.1) doesn't change anything in this policy — it just makes the agent-attempt-level retry actually trigger for `openai-codex-responses` traffic. Without it, the policy would happily run and the model could happily return `usage.output > 0` with no visible content, and the user would see a "successful" run with nothing in it.

## 8.10 What we left for later

Three big topics in provider integration sit just outside this chapter's scope:

- **Tool schemas and strict mode.** `src/agents/openai-tool-schema.ts` and `src/plugin-sdk/provider-tools.ts` decide how tools are presented to the model and how strict-mode JSON-Schema validation interacts with provider-specific limits. Chapter 09 (tools and skills) covers the host-side; the plugin contract is stable and lives in `provider-tools.ts`.
- **Auth profile lifecycle.** Login wizards, OAuth refresh, cooldown clocks, doctor hints, and the per-vendor `auth[]` arrays are extensive (Anthropic alone defines three auth methods at `extensions/anthropic/register.runtime.ts:551-616`). Chapter 14 (auth and security) walks them.
- **Image/video/voice generation, embeddings, realtime transcription.** Same registration surface as text providers (`api.registerImageGenerationProvider`, etc.), different unified call shapes. These ship through the OpenAI plugin and the various vendor plugins; their transport adapters live under `src/media-generation/`, `src/image-generation/`, `src/realtime-transcription/`. Chapter 13 (voice and media) covers them.

The throughline of this chapter is: **OpenClaw treats every LLM vendor as a plugin that contributes hooks, while keeping the SSE transport and the unified event shape host-owned.** That separation is why a 50-vendor codebase has a tractable agent-command (Chapter 07) and a fixable bug surface (the two PRs in §8.8 are each ~10-20 LoC of meaningful change).
