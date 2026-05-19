# 第 08 章　LLM Provider 集成

> 代码版本锁定：`openclaw/openclaw@50a2481652`（tag `v2026.5.18`，2026-05-18）。本章所有 `file:line` 引用均基于该提交。

## 8.1 本章解决的问题

第 07 章里，`runAgentAttempt` 最终调到 `runEmbeddedPiAgent`，把 prompt、`provider`、`model`、`authProfileId` 等参数传了进去。但有一个关键问题被刻意推迟了：**OpenClaw 内核怎么知道 `claude-opus-4-7` 该往 `api.anthropic.com` 发请求、用什么 betas 头、按什么单价计费、流式响应怎么解析？**

OpenClaw 仓库的 `extensions/` 目录下有 100+ 个子目录，其中相当一部分是 LLM provider：`anthropic`、`openai`、`google`、`ollama`、`lmstudio`、`groq`、`mistral`、`deepseek`、`xai`、`vllm`、`sglang` 等等。如果每加一个 provider 就要改内核代码，这个系统会迅速无法维护。OpenClaw 的答案是一套**插件化的 provider 集成架构**：

- 每个 provider 是一个 **extension 插件**，住在自己的 `extensions/<id>/` 目录；
- 插件向内核**注册**一个 `ProviderPlugin` 对象，对象里全是**钩子函数**；
- 内核拥有一个**通用的推理 loop**（发请求、收流、跑工具、再发请求），provider 插件只提供"这个 provider 特有的部分"——认证方式、模型目录、传输细节、流处理包装；
- 模型目录（model catalog）是一份独立的数据，描述每个模型的能力、上下文窗口、定价。

本章以 **Anthropic 插件**为主线（导览 trace 也用 Anthropic），讲清这套架构，再对比 OpenAI 与自托管的 Ollama / LM Studio，看同一套接口如何容纳"云端商业 API"和"本地开源推理服务"两类差异巨大的后端。

整体结构：

<svg viewBox="0 0 880 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="LLM provider 架构：内核 plugin-sdk 与 extension 插件的关系，以及注册路径">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="10" width="380" height="350" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="210" y="36" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">内核 (src/)</text>
  <rect x="40" y="48" width="340" height="80" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="210" y="68" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">plugin-sdk/</text>
  <text x="210" y="86" text-anchor="middle" font-size="10" fill="#64748b">provider-auth</text>
  <text x="210" y="100" text-anchor="middle" font-size="10" fill="#64748b">provider-stream</text>
  <text x="210" y="114" text-anchor="middle" font-size="10" fill="#64748b">provider-model-shared, ...</text>
  <rect x="40" y="148" width="160" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="120" y="162" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">plugins/registry.ts</text>
  <text x="120" y="176" text-anchor="middle" font-size="10" fill="#64748b">registerProvider</text>
  <rect x="220" y="148" width="160" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="300" y="162" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">plugins/types.ts</text>
  <text x="300" y="176" text-anchor="middle" font-size="10" fill="#64748b">ProviderPlugin 定义</text>
  <rect x="40" y="204" width="340" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="210" y="225" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">model-catalog/  ← 模型目录：能力 / 定价 / 上下文窗口</text>
  <rect x="40" y="248" width="340" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="210" y="269" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">provider-runtime/  ← core 拥有的通用重试 / loop 工具</text>
  <rect x="40" y="292" width="340" height="46" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="210" y="311" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">pi-embedded-runner/</text>
  <text x="210" y="328" text-anchor="middle" font-size="10" fill="#64748b">真正的推理 loop</text>
  <text x="210" y="341" text-anchor="middle" font-size="10" fill="#64748b">（调钩子、发 HTTP、收流、跑工具）</text>
  <rect x="480" y="10" width="380" height="350" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="670" y="36" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">extension 插件 (extensions/&lt;id&gt;/)</text>
  <rect x="500" y="48" width="340" height="140" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="670" y="68" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">index.ts  definePluginEntry</text>
  <text x="670" y="88" text-anchor="middle" font-size="11" fill="#64748b">register.runtime.ts</text>
  <text x="670" y="104" text-anchor="middle" font-size="10" fill="#64748b">└─ buildXxxProvider() : ProviderPlugin</text>
  <text x="670" y="122" text-anchor="middle" font-size="11" fill="#64748b">provider-discovery.ts</text>
  <text x="670" y="140" text-anchor="middle" font-size="11" fill="#64748b">openclaw.plugin.json  (清单)</text>
  <text x="670" y="156" text-anchor="middle" font-size="10" fill="#94a3b8">stream-wrappers.ts / cli-backend.ts / ...</text>
  <line x1="500" y1="116" x2="420" y2="116" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4,2" marker-end="url(#ar1)"/>
  <text x="460" y="110" text-anchor="middle" font-size="10" fill="#64748b">import</text>
  <line x1="500" y1="156" x2="380" y2="156" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <text x="440" y="148" text-anchor="middle" font-size="10" fill="#64748b">registerProvider</text>
</svg>
<span class="figure-caption">图 R8.1 ｜ LLM provider 整体架构：内核 plugin-sdk 暴露公共接口，extension 插件通过 import SDK 实现 ProviderPlugin 并向 registry 注册</span>

<details>
<summary>ASCII 原版</summary>

```
内核 (src/)                          extension 插件 (extensions/<id>/)
─────────────────────────           ──────────────────────────────────
plugin-sdk/         ←── import ───   index.ts        definePluginEntry
  (provider-auth,                    register.runtime.ts
   provider-stream,                    └─ buildXxxProvider() : ProviderPlugin
   provider-model-shared, ...)        provider-discovery.ts
                                      openclaw.plugin.json (清单)
plugins/registry.ts ──registerProvider──┐
plugins/types.ts (ProviderPlugin 定义)   │
                                         ▼
model-catalog/      ← 模型目录：能力 / 定价 / 上下文窗口
provider-runtime/   ← core 拥有的通用重试 / loop 工具
pi-embedded-runner/ ← 真正的推理 loop（调钩子、发 HTTP、收流、跑工具）
```

</details>

---

## 8.2 provider 作为 extension 插件

### 8.2.1 一个 provider 一个目录

打开 `extensions/anthropic/`，关键文件：

| 文件 | 职责 |
| --- | --- |
| `openclaw.plugin.json` | 插件清单（manifest）：声明 id、provider、模型前缀、别名、定价、auth choices |
| `index.ts` | 插件入口，`definePluginEntry` |
| `register.runtime.ts` | 真正的注册逻辑，构造 `ProviderPlugin` |
| `api.ts` | 对外 re-export 表面 |
| `provider-discovery.ts` | 离线模型目录入口 |
| `stream-wrappers.ts` | Anthropic 特有的流处理包装 |
| `cli-backend.ts` / `cli-auth-seam.ts` / `cli-catalog.ts` | Claude CLI 作为 backend 的支持 |
| `package.json` / `tsconfig.json` | 独立的包边界 |

`extensions/openai/`、`extensions/ollama/`、`extensions/lmstudio/` 结构同构。每个插件是一个**独立的 npm 包边界**——`extensions/` 下有 `tsconfig.package-boundary.base.json` / `tsconfig.package-boundary.paths.json` 强制插件之间、插件与内核之间的导入边界，插件只能通过 `openclaw/plugin-sdk/*` 这个公共 SDK 表面访问内核（见 8.4）。

### 8.2.2 插件入口：`definePluginEntry`

`extensions/anthropic/index.ts` 全文只有 12 行：

```ts
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

`register(api)` 在插件激活时被调用，`api` 是 `OpenClawPluginApi`——内核提供的注册门面。`registerAnthropicPlugin`（`extensions/anthropic/register.runtime.ts:613-617`）用它注册三样东西：

```ts
export function registerAnthropicPlugin(api: OpenClawPluginApi): void {
  api.registerCliBackend(buildAnthropicCliBackend());
  api.registerProvider(buildAnthropicProvider());
  api.registerMediaUnderstandingProvider(anthropicMediaUnderstandingProvider);
}
```

`OpenClawPluginApi` 上有一大批 `register*` 方法（`src/plugins/types.ts:2640-2700`）：`registerProvider`、`registerModelCatalogProvider`、`registerSpeechProvider`、`registerImageGenerationProvider`、`registerWebSearchProvider`、`registerAgentHarness` 等等。每个对应一种"能力（capability）"。一个插件可以注册多种能力——比如 OpenAI 插件（`extensions/openai/index.ts:24-58`）一口气注册了 provider、codex provider、memory embedding、image generation、realtime transcription、realtime voice、speech、media understanding、video generation 共 9 项。

本章只关注**文本推理能力**，即 `registerProvider`（`src/plugins/types.ts:2647`）：

```ts
registerProvider: (provider: ProviderPlugin) => void;
```

### 8.2.3 插件清单 `openclaw.plugin.json`

清单是**声明式**的，内核在插件运行时代码加载之前就能读它。`extensions/anthropic/openclaw.plugin.json` 节选：

```json
{
  "id": "anthropic",
  "activation": { "onStartup": false },
  "enabledByDefault": true,
  "providers": ["anthropic"],
  "modelSupport": { "modelPrefixes": ["claude-"] },
  "modelIdNormalization": {
    "providers": { "anthropic": { "aliases": {
      "opus-4.6": "claude-opus-4-6", "sonnet-4.6": "claude-sonnet-4-6" } } }
  },
  "providerEndpoints": [
    { "endpointClass": "anthropic-public", "hosts": ["api.anthropic.com"] }
  ],
  "providerAuthEnvVars": { "anthropic": ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] },
  "providerAuthChoices": [ /* cli / setup-token / api-key */ ]
}
```

**为什么清单和运行时代码分离**：很多决策必须在插件代码加载**之前**就能做——比如"用户输入了 `opus-4.6`，应该归一化成 `claude-opus-4-6`"（`modelIdNormalization`），"`claude-*` 前缀的模型归 anthropic 管"（`modelSupport.modelPrefixes`），"setup 向导里 anthropic 提供哪几种登录方式"（`providerAuthChoices`）。如果这些都要 import 运行时代码才能知道，启动成本和耦合度都会爆炸。清单是"插件的静态名片"，运行时代码是"插件的行为"。第 07 章 7.3.2 里 `loadManifestMetadataSnapshot` 加载的就是这些清单，`normalizeModelRef` 用清单里的 `aliases` 做归一化。

`activation.onStartup: false` 表示这个 provider 插件不在启动时激活，而是按需——只有真的要用 anthropic 模型时才加载它的运行时代码。

---

## 8.3 统一抽象：`ProviderPlugin` 与 provider-owned 钩子

### 8.3.1 `ProviderPlugin` 的形态

`ProviderPlugin` 定义在 `src/plugins/types.ts:1222`，是一个**全是可选钩子的对象**。`buildAnthropicProvider`（`extensions/anthropic/register.runtime.ts:490-559`）构造它，结构如下：

```ts
export function buildAnthropicProvider(): ProviderPlugin {
  return {
    id: "anthropic",
    label: "Anthropic",
    hookAliases: [CLAUDE_CLI_BACKEND_ID],
    envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    auth: [ /* cli / setup-token / api-key 三种 ProviderAuthMethod */ ],
    normalizeConfig: ({ provider, providerConfig }) => ...,
    applyConfigDefaults: ({ config, env }) => ...,
    resolveDynamicModel: (ctx) => ...,
    normalizeResolvedModel: (ctx) => applyAnthropicOpus47ContextWindow(ctx),
    resolveSyntheticAuth: ({ provider }) => ...,
    augmentModelCatalog: () => buildClaudeCliCatalogEntries(),
    buildReplayPolicy: buildAnthropicReplayPolicy,
    isModernModelRef: ({ modelId }) => matchesAnthropicModernModel(modelId),
    resolveReasoningOutputMode: () => "native",
    resolveThinkingProfile: ({ modelId }) => resolveClaudeThinkingProfile(modelId),
    wrapStreamFn: wrapAnthropicProviderStream,
    resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
    fetchUsageSnapshot: async (ctx) => await fetchClaudeUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
    isCacheTtlEligible: () => true,
    buildAuthDoctorHint: (ctx) => buildAnthropicAuthDoctorHint({ ... }),
  };
}
```

每个字段都是内核在某个执行节点会调用的"扩展点"。下面按职责归类。

### 8.3.2 钩子分类

**身份与配置类**

| 钩子 | 作用 |
| --- | --- |
| `id` / `label` / `aliases` / `hookAliases` | provider 标识；`hookAliases`（`src/plugins/types.ts:1228-1235`）是仅用于运行时/配置 hook 查找的内部别名，不当作用户可见的 provider id |
| `auth` | `ProviderAuthMethod[]`，本 provider 支持的登录方式 |
| `envVars` | setup/help 界面展示的环境变量 |
| `normalizeConfig` / `applyConfigDefaults` | 归一化 `models.providers.<id>` 配置、补默认值 |

**模型解析类**（`src/plugins/types.ts:1252-1349`）

| 钩子 | 作用 |
| --- | --- |
| `catalog` / `staticCatalog` / `discovery` | 旧版文本 provider 模型目录钩子（已标 `@deprecated`，新代码用 `registerModelCatalogProvider`） |
| `resolveDynamicModel` | 同步钩子，解析本地目录里没有的模型 id（pass-through provider 用） |
| `prepareDynamicModel` | 异步预取，为 `resolveDynamicModel` 准备数据 |
| `normalizeResolvedModel` | provider 自有的传输归一化——改 API id、base URL、compat 标志 |
| `normalizeModelId` | 模型 id 归一化（别名清理） |
| `augmentModelCatalog` | 模型目录的最终增补钩子 |

`src/plugins/types.ts:1284-1295` 注释明确写出了模型解析的钩子顺序：

```
1. discovered/static 模型查找
2. 插件 resolveDynamicModel
3. core fallback 启发式
4. 通用 provider-config fallback
```

Anthropic 用 `resolveDynamicModel`（`extensions/anthropic/register.runtime.ts:574-587`）处理"前向兼容模型"——比清单更新的 Claude 模型 id 也能跑；用 `normalizeResolvedModel`（`extensions/anthropic/register.runtime.ts:588`）调用 `applyAnthropicOpus47ContextWindow` 给 opus-4.7 打上正确的上下文窗口。

**传输与流处理类**

| 钩子 | 作用 |
| --- | --- |
| `createStreamFn` | 创建本 provider 的流式调用函数 `StreamFn` |
| `wrapStreamFn` | 包装/装饰一个已有的 `StreamFn` |
| `buildReplayPolicy` | 构造"历史回放策略"（怎么把 transcript 喂回模型） |
| `resolveReasoningOutputMode` | reasoning 输出模式（anthropic 返回 `"native"`） |
| `resolveThinkingProfile` | 该模型支持的 thinking 档位 |

`StreamFn` 来自 `@earendil-works/pi-agent-core`——这是 OpenClaw 依赖的底层 agent 引擎。`StreamFn` 就是"给定 model + context + options，发起一次流式 LLM 请求并产出事件流"的函数类型。**provider 插件的核心工作之一就是提供或包装这个 `StreamFn`**（详见 8.5）。

**认证运行时类**

| 钩子 | 作用 |
| --- | --- |
| `resolveSyntheticAuth` | 合成认证——某些 provider（如本地 Ollama）不需要真凭证，给一个占位 key |
| `resolveUsageAuth` / `fetchUsageSnapshot` | 拉取用量/配额快照 |
| `buildAuthDoctorHint` | `openclaw doctor` 里的认证诊断提示 |

### 8.3.3 为什么是"core 拥有 loop，provider 拥有钩子"

这是整个架构的设计核心，`src/plugins/types.ts:756-760` 的一段注释点明了演进方向：

> Core replay/runtime ownership now lives on explicit provider hooks such as `buildReplayPolicy`, `normalizeToolSchemas`, and `wrapStreamFn`. OpenClaw no longer reads [the legacy] bag at runtime ...

也就是说：**通用的推理 loop 永远是内核的**——发请求、解析流、检测工具调用、执行工具、把工具结果拼回去、再发请求，直到 `end_turn`。这套 loop 对所有 provider 一模一样。provider 之间的差异被收敛到一组**明确命名的钩子**里：

- Anthropic 需要发 `anthropic-beta` 头、需要 thinking prefill 处理 → 用 `wrapStreamFn`；
- OpenAI 需要不同的工具 schema 格式 → 用 `normalizeToolSchemas`；
- Ollama 是 OpenAI-compatible 但模型是动态发现的 → 用 `prepareDynamicModel` + `resolveDynamicModel`。

**好处**：加一个新 provider 不改内核 loop，只填几个钩子；钩子是显式的，类型系统能检查；旧的"配置袋子"式扩展点（不透明的 `Record`）被淘汰，行为变得可追踪。

### 8.3.4 `definePluginEntry` 与 `defineSingleProviderPluginEntry`

`extensions/anthropic` 和 `extensions/openai` 用通用的 `definePluginEntry`，因为它们注册多种能力、有复杂自定义逻辑。对于"只注册一个 provider、用标准 API key 认证"的简单 provider，plugin-sdk 提供了 `defineSingleProviderPluginEntry`（`src/plugin-sdk/provider-entry.ts:154`）：

```ts
export function defineSingleProviderPluginEntry(options: SingleProviderPluginOptions)
```

它接收 `SingleProviderPluginApiKeyAuthOptions`、`SingleProviderPluginCatalogOptions`（`src/plugin-sdk/provider-entry.ts:22`、`:30`），把样板代码全部封装掉。许多简单 provider（`groq`、`deepseek`、`mistral` 之类）就走这条捷径。

---

## 8.4 plugin-sdk：内核与插件的契约层

`src/plugin-sdk/` 是内核暴露给所有 extension 的**公共 API 表面**。插件代码里所有 `import ... from "openclaw/plugin-sdk/..."` 都解析到这里。它本质上是一组 re-export 模块，把内核内部实现重新打包成稳定的对外接口。

provider 插件常用的 plugin-sdk 模块（从 anthropic / ollama 的 import 可见）：

| plugin-sdk 模块 | 内容 |
| --- | --- |
| `plugin-entry` | `definePluginEntry`、`OpenClawPluginApi`、各种 `Provider*Context` 类型 |
| `provider-auth` | `createProviderApiKeyAuthMethod`、`buildApiKeyCredential` 等认证构件 |
| `provider-stream` / `provider-stream-shared` | 流处理工具：`composeProviderStreamWrappers`、`streamWithPayloadPatch` |
| `provider-model-shared` | `buildOpenAICompatibleReplayPolicy`、`OPENAI_COMPATIBLE_REPLAY_HOOKS`、模型类型 |
| `provider-catalog-runtime` / `provider-catalog-shared` | 模型目录运行时 |
| `cli-runtime` | CLI 辅助（`formatCliCommand`、`parseDurationMs`） |
| `config-contracts` | `OpenClawConfig` 等配置类型 |

注意 `src/plugin-sdk/agent-runtime.ts` 这个文件——它 re-export 了 `agent-command.js`、`model-catalog.js`、`model-selection.js` 等一大批 agent 子系统（`src/plugin-sdk/agent-runtime.ts:6-32`）。**为什么 plugin-sdk 不直接定义这些类型，而是 re-export**：内核的真实实现住在 `src/agents/`、`src/plugins/`、`src/model-catalog/`；plugin-sdk 只是给它们套一个**稳定的公共门面**。插件依赖 `openclaw/plugin-sdk/*`（稳定契约），不直接依赖 `src/agents/*`（内部实现），这样内核重构内部文件结构时不会震动到 100+ 个插件。`tsconfig.package-boundary.*` 在编译期强制这条边界。

`ProviderPlugin` 本体定义在 `src/plugins/types.ts`，通过 plugin-sdk 的 `plugin-entry` re-export 给插件用。

---

## 8.5 流式响应处理与 tool use

### 8.5.1 通用 loop 视角

把第 07 章和本章拼起来，一次推理的完整数据流是：

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="推理完整数据流：runEmbeddedPiAgent 组装消息→推理 loop 调 StreamFn→HTTP 请求 provider 端点→解析流→tool_use 分支循环或 end_turn 结束">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#0d9488"/>
    </marker>
  </defs>
  <rect x="80" y="10" width="600" height="56" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="32" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">runEmbeddedPiAgent  (pi-embedded-runner，内核)</text>
  <text x="380" y="52" text-anchor="middle" font-size="11" fill="#64748b">组装 system prompt + 历史 transcript + 工具 schema + 当前消息</text>
  <line x1="380" y1="66" x2="380" y2="90" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="80" y="90" width="600" height="36" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="113" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">通用推理 loop  (@earendil-works/pi-agent-core + pi-embedded-runner)</text>
  <line x1="380" y1="126" x2="380" y2="148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="80" y="148" width="340" height="36" rx="6" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="250" y="162" text-anchor="middle" font-size="11" font-weight="600" fill="#0ea5e9">调 provider 的 StreamFn</text>
  <text x="250" y="176" text-anchor="middle" font-size="10" fill="#64748b">plugin 提供或包装</text>
  <line x1="420" y1="166" x2="540" y2="166" stroke="#0ea5e9" stroke-width="1.5" marker-end="url(#ar1)"/>
  <text x="480" y="158" text-anchor="middle" font-size="10" fill="#0ea5e9">HTTP</text>
  <rect x="540" y="148" width="200" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="640" y="162" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">provider 端点</text>
  <text x="640" y="176" text-anchor="middle" font-size="10" fill="#64748b">api.anthropic.com / localhost:11434</text>
  <path d="M 540 180 L 430 180 L 430 184" fill="none" stroke="#0ea5e9" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar1)"/>
  <text x="485" y="194" text-anchor="middle" font-size="10" fill="#0ea5e9">SSE / 流式响应</text>
  <rect x="80" y="200" width="340" height="56" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="250" y="220" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">解析流</text>
  <text x="250" y="236" text-anchor="middle" font-size="10" fill="#64748b">text delta / thinking / tool_use</text>
  <text x="250" y="250" text-anchor="middle" font-size="10" fill="#64748b">usage / stop_reason</text>
  <line x1="250" y1="256" x2="250" y2="280" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="80" y="280" width="155" height="52" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="158" y="300" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">有 tool_use?</text>
  <text x="158" y="316" text-anchor="middle" font-size="10" fill="#64748b">执行工具</text>
  <text x="158" y="330" text-anchor="middle" font-size="10" fill="#64748b">拼回 tool_result → 回 loop 顶</text>
  <path d="M 158 332 L 158 360 L 380 360 L 380 108" fill="none" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="4,2" marker-end="url(#ar2)"/>
  <rect x="255" y="280" width="165" height="52" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="338" y="300" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">stop_reason = end_turn</text>
  <text x="338" y="316" text-anchor="middle" font-size="10" fill="#64748b">结束</text>
  <line x1="450" y1="256" x2="450" y2="310" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar1)"/>
  <text x="460" y="288" font-size="10" fill="#94a3b8">沿途 emit</text>
  <rect x="466" y="280" width="214" height="52" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="573" y="300" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">assistant / tool / item 事件</text>
  <text x="573" y="316" text-anchor="middle" font-size="10" fill="#64748b">第 07 章 7.8</text>
</svg>
<span class="figure-caption">图 R8.2 ｜ 一次推理的完整数据流：loop 通过 StreamFn 发 HTTP 请求、接收 SSE 流，有 tool_use 则执行工具并回到 loop 顶，收到 end_turn 则结束</span>

<details>
<summary>ASCII 原版</summary>

```
runEmbeddedPiAgent (pi-embedded-runner，内核)
   │  组装 system prompt + 历史 transcript + 工具 schema + 当前消息
   ▼
通用推理 loop (@earendil-works/pi-agent-core + pi-embedded-runner)
   │
   ├─→ 调 provider 的 StreamFn ──HTTP──▶ provider 端点 (api.anthropic.com / localhost:11434 ...)
   │        ◀── SSE / 流式响应 ──┘
   │   解析流：text delta / thinking / tool_use / usage / stop_reason
   │        │
   │        ├─ 有 tool_use？ → 执行工具 → 把 tool_result 拼回 messages → 回到 loop 顶
   │        └─ stop_reason = end_turn？ → 结束
   │
   └─→ 沿途 emit assistant / tool / item 事件 (第 07 章 7.8)
```

</details>

loop 本身是 provider 无关的。provider 插件介入的点是那个 `StreamFn`——它决定"一次 HTTP 请求长什么样、流怎么解析"。

### 8.5.2 `StreamFn`：provider 提供或包装

provider 通过两个钩子参与流处理：

- `createStreamFn(ctx)`（`src/plugins/types.ts:1460`）：**从零创建**一个 `StreamFn`；
- `wrapStreamFn(ctx)`（`src/plugins/types.ts:1468`）：**包装**一个内核已经准备好的 `StreamFn`。

Ollama 用 `createStreamFn`（`extensions/ollama/index.ts`），因为它要指定自己的 base URL：

```ts
createStreamFn: ({ config, model, provider }) =>
  createConfiguredOllamaStreamFn({
    model,
    providerBaseUrl: readProviderBaseUrl(resolveConfiguredOllamaProviderConfig({ config, providerId: provider })),
  }),
```

Anthropic 用 `wrapStreamFn`（`extensions/anthropic/register.runtime.ts:598`，`wrapStreamFn: wrapAnthropicProviderStream`），因为 Anthropic 的传输基本是标准的，但需要在请求外面叠一层"Anthropic 特有的修饰"。

### 8.5.3 Anthropic 的流包装

`extensions/anthropic/stream-wrappers.ts` 是看清"为什么需要 `wrapStreamFn`"的最好样本。Anthropic 的请求需要一系列特殊处理：

**beta 头管理**（`extensions/anthropic/stream-wrappers.ts:21-30`）：

```ts
const ANTHROPIC_CONTEXT_1M_BETA = "context-1m-2025-08-07";
const ANTHROPIC_1M_MODEL_PREFIXES = ["claude-opus-4", "claude-sonnet-4"];
const PI_AI_DEFAULT_ANTHROPIC_BETAS = [
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
];
const PI_AI_OAUTH_ANTHROPIC_BETAS = [
  "claude-code-20250219", "oauth-2025-04-20", ...PI_AI_DEFAULT_ANTHROPIC_BETAS,
];
```

不同模型、不同认证方式（OAuth vs API key）要发不同的 `anthropic-beta` 头组合。`isAnthropic1MModel`（`extensions/anthropic/stream-wrappers.ts:32-35`）判断是否启用 100 万 token 上下文 beta。`mergeAnthropicBetaHeader`（`extensions/anthropic/stream-wrappers.ts:48`）把这些合并进请求头。

**payload policy**（`extensions/anthropic/stream-wrappers.ts:4-10` 的 import）：`applyAnthropicPayloadPolicyToParams`、`createAnthropicThinkingPrefillPayloadWrapper`、`stripTrailingAnthropicAssistantPrefillWhenThinking` 处理 Anthropic 在 thinking 模式下对 assistant prefill 的特殊约束。`composeProviderStreamWrappers` 把多个 wrapper 串成一个。

这些全部是 Anthropic 专有的"传输怪癖"。把它们塞进内核 loop 会让 loop 被 provider 细节污染；放进 `wrapStreamFn` 钩子，则它们只在跑 Anthropic 时生效，内核 loop 保持干净。

底层真正发 HTTP 的传输流函数是 `createAnthropicMessagesTransportStreamFn`（`src/agents/anthropic-transport-stream.ts:913`），它创建 Anthropic Messages API 客户端、处理 OAuth vs API key 的差异（`src/agents/anthropic-transport-stream.ts:935`，`isOAuthToken`）。注意这个文件在 `src/agents/` 而非 `extensions/anthropic/`——因为 Anthropic 是**内置 provider**，它的部分传输实现深嵌在内核里，插件层（`extensions/anthropic/`）做的是注册、配置归一化、流包装。这也解释了为什么 `extensions/anthropic/stream-wrappers.ts` 是"wrapper"——它包装的正是内核里的 `createAnthropicMessagesTransportStreamFn`。

### 8.5.4 tool use / function calling

工具调用是通用 loop 的一部分，但 provider 之间工具 schema 格式不同。`ProviderPlugin` 上有 `normalizeToolSchemas`（在 `src/plugins/types.ts:756-760` 注释里被点名为 provider-owned 钩子之一）与 `inspectProviderToolSchemasWithPlugin`（`src/plugins/provider-runtime.ts:572`）。OpenAI 插件在 `extensions/openai/index.ts:25` 用 `buildProviderToolCompatFamilyHooks("openai")` 一次性构造一组工具兼容钩子并 spread 进 provider 对象。

loop 检测到流里的 `tool_use` 块后，执行工具（exec、文件操作、web fetch 等——这些工具本身也可以来自插件），把结果作为 `tool_result` 消息拼回对话，再发起下一轮请求。`buildReplayPolicy` 钩子决定历史里的 tool 消息怎么回放给模型——Anthropic 用 `buildAnthropicReplayPolicy`（`extensions/anthropic/register.runtime.ts:594`），Ollama 用通用的 `buildOpenAICompatibleReplayPolicy`（`extensions/ollama/index.ts`）。

---

## 8.6 model catalog：模型目录

`src/model-catalog/` 是与 provider 插件并行的另一套数据：它回答"某个模型有什么能力、多大上下文、什么价格"。

### 8.6.1 两套目录类型

代码里有两组 model catalog 类型，反映了一次架构演进：

**旧版 `ModelCatalogEntry`**（`src/agents/model-catalog.types.ts:5`）——文本 provider 用，结构简单：

```ts
export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  alias?: string;
  contextWindow?: number;
  contextTokens?: number;
  reasoning?: boolean;
  input?: ModelInputType[];          // "text" | "image" | "audio" | "video" | "document"
  compat?: ModelCompatConfig;
};
```

**新版 `UnifiedModelCatalogEntry`**（`src/model-catalog/types.ts:28`）——统一目录，覆盖文本/图像/视频/语音等多种 `UnifiedModelCatalogKind`（`src/model-catalog/types.ts:13`），并带 `ModelCatalogCost` 定价（`src/model-catalog/types.ts:53`，含分层定价 `ModelCatalogTieredCost`，`src/model-catalog/types.ts:45`）、`ModelCatalogStatus`（`available`/`preview`/`deprecated`/`disabled`，`src/model-catalog/types.ts:5`）、`ModelCatalogDiscovery`（`static`/`refreshable`/`runtime`，`src/model-catalog/types.ts:4`）。

第 07 章 7.4 里 `agentCommandInternal` 用的 `loadManifestModelCatalog`、`buildConfiguredModelCatalog` 产出的是旧版 `ModelCatalogEntry[]`——它服务于"这次运行允许哪些模型、thinking 档位是什么"的判断。

### 8.6.2 provider index 与目录来源

`src/model-catalog/` 目录文件：

| 文件 | 作用 |
| --- | --- |
| `index.ts` | 门面，re-export |
| `types.ts` | `UnifiedModelCatalog*` 类型定义 |
| `normalize.ts` | `normalizeModelCatalog` / `normalizeModelCatalogRows` |
| `authority.ts` | `mergeModelCatalogRowsByAuthority`——多来源冲突时按权威性合并 |
| `provider-index/` | `loadOpenClawProviderIndex`——加载 provider 索引 |
| `provider-index-planner.ts` | `planProviderIndexModelCatalogRows` |
| `manifest-planner.ts` | 从插件清单规划目录行 |

`provider-index/types.ts` 定义 `OpenClawProviderIndex`（`:45`）、`OpenClawProviderIndexProvider`（`:35`）、`OpenClawProviderIndexProviderAuthChoice`（`:18`）——这是一份"所有已知 provider 及其元数据"的索引。

模型目录的数据来源是多路的，最后被 `mergeModelCatalogRowsByAuthority` 按"权威性"合并：

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="模型目录五路数据来源汇合后经 mergeModelCatalogRowsByAuthority 合并为最终目录">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="10" width="280" height="32" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="160" y="31" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">插件清单 (openclaw.plugin.json)</text>
  <rect x="20" y="56" width="280" height="32" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="160" y="77" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">provider index（内置 provider 索引）</text>
  <rect x="20" y="102" width="280" height="44" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="160" y="120" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">provider 插件钩子</text>
  <text x="160" y="138" text-anchor="middle" font-size="10" fill="#64748b">catalog / staticCatalog / augmentModelCatalog</text>
  <rect x="20" y="160" width="280" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="160" y="178" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">liveCatalog（动态发现）</text>
  <text x="160" y="196" text-anchor="middle" font-size="10" fill="#64748b">如 Ollama 运行时拉本地模型列表</text>
  <rect x="20" y="218" width="280" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="160" y="239" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">用户配置 (models.providers.&lt;id&gt;.models)</text>
  <line x1="300" y1="26" x2="400" y2="150" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="300" y1="72" x2="400" y2="152" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="300" y1="124" x2="400" y2="155" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="300" y1="182" x2="400" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="300" y1="234" x2="400" y2="162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="400" y="124" width="240" height="56" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="520" y="146" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">mergeModelCatalogRowsByAuthority</text>
  <text x="520" y="164" text-anchor="middle" font-size="10" fill="#64748b">+ normalizeModelCatalog</text>
  <line x1="520" y1="180" x2="520" y2="218" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="400" y="218" width="240" height="40" rx="8" fill="#0d9488"/>
  <text x="520" y="243" text-anchor="middle" font-size="13" font-weight="700" fill="white">最终模型目录</text>
</svg>
<span class="figure-caption">图 R8.3 ｜ 模型目录五路数据来源汇合：清单、内置索引、插件钩子、动态发现、用户配置经权威性合并为唯一最终目录</span>

<details>
<summary>ASCII 原版</summary>

```
插件清单 (openclaw.plugin.json: modelPricing / modelSupport)
provider index (内置 provider 索引)
provider 插件的 catalog / staticCatalog / augmentModelCatalog 钩子
provider 的 liveCatalog (动态发现，如 Ollama 拉本地模型列表)
用户配置 (models.providers.<id>.models)
              │
              ▼  mergeModelCatalogRowsByAuthority + normalizeModelCatalog
        最终模型目录
```

</details>

**为什么定价和能力不写死在内核**：模型迭代极快（每月都有新模型、调价）。定价放在插件清单的 `modelPricing` 字段（anthropic 清单里有 `openRouter.modelIdTransforms`），能力放在目录行里，更新一个 provider 不动内核。`ModelCatalogDiscovery` 的 `runtime` 档位专门给 Ollama 这种"模型清单只能在运行时从服务端问出来"的 provider。

### 8.6.3 注册目录 provider

新代码用 `api.registerModelCatalogProvider`（`src/plugins/types.ts:2648`）注册一个 `UnifiedModelCatalogProviderPlugin`（`src/plugins/types.ts:467`）：

```ts
export type UnifiedModelCatalogProviderPlugin = {
  provider: string;
  kinds: readonly UnifiedModelCatalogKind[];
  staticCatalog?: (ctx) => ... UnifiedModelCatalogEntry[] ...;   // 离线、无需凭证
  liveCatalog?: (ctx) => ... UnifiedModelCatalogEntry[] ...;     // 在线、可能要凭证
};
```

`staticCatalog` 与 `liveCatalog` 的分工对应 `src/plugins/types.ts:1254-1262` 注释：`staticCatalog` **不得做网络 I/O、不需要真凭证**，用于"还没配认证就能展示"的 bundled 行；`liveCatalog` 则可以联网拉真实模型列表。

---

## 8.7 provider-runtime：core 拥有的通用逻辑

`src/provider-runtime/` 目录在 v2026.5.18 里只有一个文件：`operation-retry.ts`。它体现了"core 拥有通用 loop / 通用韧性逻辑"的原则。

`operation-retry.ts` 导出 `ProviderOperationRetryStage`（`"read" | "poll" | "download" | "create"`）和 `TransientProviderRetryParams` / `TransientProviderRetryOptions`：

```ts
export type TransientProviderRetryParams = {
  error: unknown;
  message: string;
  provider: string;
  apiKeyIndex: number;
  attemptNumber: number;
  stage?: ProviderOperationRetryStage;
};
export type TransientProviderRetryOptions = {
  // 总执行次数，含首次。attempts: 2 = 一次初始调用 + 一次重试。
  attempts: number;
  ...
};
```

它依赖 `src/infra/backoff.js` 的 `sleepWithAbort` 实现可中断退避。**这是"瞬时错误重试"**——网络抖动、503 之类，对任何 provider 都一样，所以归内核所有，不让每个插件各写一遍。

注意区分本章和第 07 章里的几层"重试/fallback"：

| 机制 | 归属 | 处理什么 |
| --- | --- | --- |
| `operation-retry`（本章 8.7） | `src/provider-runtime/` 内核 | 单个 provider 操作的瞬时错误（网络抖动） |
| auth profile 冷却轮换（第 07 章 7.5） | `src/agents/auth-profiles/` 内核 | 某份凭证限流/失败，换下一份凭证 |
| `runWithModelFallback`（第 07 章 7.7.2） | `src/agents/model-fallback.ts` 内核 | 某个模型不可用，换 fallback 模型 |
| live model switch（第 07 章 7.7.4） | `agent-command.ts` 内核 | 会话被人为切换模型 |

四层都在内核，provider 插件不实现任何重试逻辑——它只通过钩子（如 `matchesContextOverflowError`）告诉内核"这个错误是什么性质"，由内核的通用逻辑决定怎么应对。

更广义的"provider runtime 工具集"散落在 `src/plugins/provider-runtime.ts`（700+ 行），里面是一组 `*WithPlugin` 函数（`src/plugins/provider-runtime.ts:295` 起）：`normalizeProviderResolvedModelWithPlugin`、`resolveProviderStreamFn`、`prepareProviderRuntimeAuth`、`resolveProviderUsageSnapshotWithPlugin`、`matchesProviderContextOverflowWithPlugin` 等。它们是"内核调用 provider 钩子"的统一封装层——内核 loop 不直接调 `provider.normalizeResolvedModel`，而是调 `normalizeProviderResolvedModelWithPlugin`，由后者负责"找到对的插件、安全调用、处理插件没实现该钩子的情况"。

---

## 8.8 凭证轮换、限流与 fallback（provider 视角）

第 07 章 7.5 从 agent 执行视角讲了 auth profile。这里补充 provider 插件这一侧的对应物。

### 8.8.1 provider 声明认证方式

`ProviderPlugin.auth` 是 `ProviderAuthMethod[]`。Anthropic 声明三种（`extensions/anthropic/register.runtime.ts:504-569`）：

- `cli`（`kind: "custom"`）：复用本机 Claude CLI 登录；
- `setup-token`（`kind: "token"`）：手动 bearer token；
- `api-key`：用 `createProviderApiKeyAuthMethod`（来自 `plugin-sdk/provider-auth`）构造的标准 API key 方式。

每种方式带一个 `wizard` 描述（`choiceId`、`choiceLabel`、`groupId` 等），驱动 `openclaw configure` 向导和清单里的 `providerAuthChoices`。`run` / `runNonInteractive` 是实际执行登录的函数。

### 8.8.2 合成认证：本地 provider 的特例

`resolveSyntheticAuth` 钩子是"自托管 provider 不需要真凭证"的解法。Ollama 的实现（`extensions/ollama/index.ts`）：

```ts
resolveSyntheticAuth: ({ provider, providerConfig }) => {
  if (!shouldUseSyntheticOllamaAuth(providerConfig)) return undefined;
  return {
    apiKey: OLLAMA_DEFAULT_API_KEY,                    // "ollama-local"
    source: `models.providers.${provider} (synthetic local key)`,
    mode: "api-key",
  };
},
shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
  resolvedApiKey?.trim() === OLLAMA_DEFAULT_API_KEY,
```

本地 Ollama 跑在 `localhost`，没有真正的 API key 概念。`resolveSyntheticAuth` 返回一个**占位 key** `"ollama-local"`，让内核 auth 子系统的"必须有凭证才能用"约束得到满足，而不用真把它当秘密对待。Ollama 清单里 `"nonSecretAuthMarkers": ["ollama-local"]`（`openclaw.plugin.json`）就是告诉内核"这个值不是秘密，不用进 keychain、不用脱敏"。LM Studio 同理（清单里 `"nonSecretAuthMarkers": ["lmstudio-local"]`）。

### 8.8.3 用量与限流

`resolveUsageAuth` + `fetchUsageSnapshot` 让 provider 暴露配额信息。Anthropic 的实现：

```ts
resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
fetchUsageSnapshot: async (ctx) => await fetchClaudeUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
```

`src/infra/provider-usage.*` 一族文件（`provider-usage.fetch.claude.ts`、`provider-usage.fetch.codex.ts` 等）是这些用量抓取的具体实现。当 provider 返回限流（subscription_limit）时，auth profile 子系统把对应 profile 标记成 `AuthProfileBlockedReason: "subscription_limit"`（`src/agents/auth-profiles/types.ts:79`），冷却逻辑（第 07 章 7.5.3）随即绕开它。

`matchesContextOverflowError` 钩子让 provider 识别"上下文溢出"错误。Ollama 的实现（`extensions/ollama/index.ts`）用正则匹配 Ollama 特有的错误文本：

```ts
matchesContextOverflowError: ({ errorMessage }) =>
  /\bollama\b.*(?:context length|too many tokens|context window)/i.test(errorMessage) || ...,
```

内核识别出上下文溢出后，会触发压缩（compaction）或 fallback，而不是把原始错误直接抛给用户。

---

## 8.9 对比：Anthropic vs OpenAI vs 自托管

把三类 provider 并排，能看清同一套 `ProviderPlugin` 接口如何容纳差异。

### 8.9.1 Anthropic：内置云端商业 provider

- **认证**：三方式（CLI / setup-token / API key），OAuth 与 token 并存。
- **传输**：基本标准，但用 `wrapStreamFn` 叠加 beta 头管理、thinking prefill 处理；底层 `StreamFn` 是内核里的 `createAnthropicMessagesTransportStreamFn`。
- **目录**：`augmentModelCatalog` 增补 Claude CLI 行；模型 id 归一化靠清单 `aliases`。
- **特殊性**：作为内置 provider，传输实现深嵌 `src/agents/anthropic-transport-stream.ts`，插件层做注册和包装。还注册了 CLI backend（`registerCliBackend`）让 Claude CLI 能当 runner（呼应第 07 章 7.7.3 的 CLI 路径）。

### 8.9.2 OpenAI：多能力 provider

`extensions/openai/index.ts` 一个插件注册两个 provider——`buildOpenAIProvider()` 和 `buildOpenAICodexProviderPlugin()`——前者是标准 OpenAI API，后者是 Codex（OpenAI 的 agent 产品，带自己的 OAuth 设备码流程，见 `openai-codex-oauth.runtime.ts`、`openai-codex-device-code.ts`）。两个 provider 都被 `buildProviderWithPromptContribution` 包一层，注入 OpenAI 特有的 system prompt 贡献和工具兼容钩子（`buildProviderToolCompatFamilyHooks("openai")`，`extensions/openai/index.ts:25`）。此外还注册了 7 种非文本能力。这说明一个 extension 目录可以是"一个 vendor 的全部能力集合"。

### 8.9.3 Ollama / LM Studio：自托管 provider

自托管 provider 的核心差异：**没有云端、没有真凭证、模型在本地动态发现**。Ollama 插件（`extensions/ollama/index.ts`）的应对：

- **OpenAI-compatible 传输**：直接复用 `OPENAI_COMPATIBLE_REPLAY_HOOKS`、`buildOpenAICompatibleReplayPolicy`（来自 `plugin-sdk/provider-model-shared`），不自己写传输——Ollama 暴露 OpenAI 兼容端点。
- **动态模型发现**：`prepareDynamicModel`（异步从 `localhost:11434` 拉模型列表，写进 `dynamicModelCache`）+ `resolveDynamicModel`（从 cache 同步取）。`catalog.order: "late"` 让它的目录在最后合并。`buildDynamicCacheKey` 按 `provider + baseUrl` 缓存。
- **合成认证**：`resolveSyntheticAuth` 返回 `"ollama-local"`（见 8.8.2）。
- **本地特有行为**：`onModelSelected` 在用户选了某模型后自动 `ensureOllamaModelPulled`（本地没有就 `ollama pull`）；`buildUnknownModelHint` 给出"设 `OLLAMA_API_KEY` 或跑 `openclaw configure`"的提示；`checkWsl2CrashLoopRisk`（`index.ts` register 开头）甚至检查 WSL2 崩溃循环风险。
- **base URL 可配**：`createStreamFn` 用 `readProviderBaseUrl` 读用户配置的本地地址。

LM Studio（`extensions/lmstudio/`）几乎同构——同样 OpenAI-compatible、同样 `nonSecretAuthMarkers: ["lmstudio-local"]`，清单里 `providerRequest.lmstudio.openAICompletions.supportsStreamingUsage: true` 声明它的流式响应带 usage。

**结论**：`ProviderPlugin` 的钩子集足够宽，以至于"一个需要 OAuth、有计费、有 beta 头怪癖的云端商业 API"和"一个跑在 localhost、模型现场发现、没有凭证概念的开源推理服务"能填进同一个接口。云端 provider 重点用 `auth` / `wrapStreamFn` / `fetchUsageSnapshot`；自托管 provider 重点用 `resolveSyntheticAuth` / `prepareDynamicModel` / `createStreamFn`。内核 loop 对两者一视同仁。

---

## 8.10 小结

本章拆解了 OpenClaw 的 LLM provider 集成架构：

- **插件化**：每个 provider 是 `extensions/<id>/` 下的独立包，通过 `definePluginEntry` + `api.registerProvider` 注册一个 `ProviderPlugin`；`openclaw.plugin.json` 清单提供"加载运行时代码之前就能用"的静态元数据。
- **统一抽象**：`ProviderPlugin`（`src/plugins/types.ts:1222`）是一个全是可选钩子的对象，按身份/模型解析/传输/认证分类。设计原则是"core 拥有通用推理 loop，provider 只拥有显式命名的钩子"。
- **plugin-sdk**：`src/plugin-sdk/` 是内核与 100+ 插件之间的稳定契约层，re-export 内核实现，配合包边界 tsconfig 把插件与内核内部结构解耦。
- **model catalog**：`src/model-catalog/` 独立描述模型能力、定价、状态；多来源经 `mergeModelCatalogRowsByAuthority` 合并；定价随插件清单更新而不动内核。
- **流处理与 tool use**：通用 loop 调 provider 的 `StreamFn`（`createStreamFn` 创建或 `wrapStreamFn` 包装）；Anthropic 用流包装处理 beta 头、thinking prefill 等传输怪癖；工具 schema 差异由 `normalizeToolSchemas` 一类钩子吸收。
- **凭证与韧性**：`operation-retry`（瞬时错误）、auth profile 冷却轮换、`runWithModelFallback`（模型 fallback）、live switch 四层重试机制全在内核；provider 插件只通过钩子（`resolveSyntheticAuth`、`matchesContextOverflowError`、`fetchUsageSnapshot`）声明自己的特性。
- **三类 provider 对比**：同一套接口容纳了 Anthropic（内置云端、OAuth、beta 头）、OpenAI（多能力、双 provider）、Ollama/LM Studio（自托管、合成认证、动态发现），证明了这套钩子抽象的覆盖力。
