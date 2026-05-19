# 第 10 章 插件系统与扩展 SDK

> 代码版本锁定：`openclaw/openclaw@50a2481652`（tag `v2026.5.18`，2026-05-18）。
> 本章所有 `file:line` 引用均为仓库根相对路径。

## 10.1 本章要解决的问题

OpenClaw 的 `extensions/` 目录里有 **134 个插件**。Telegram、Discord、WhatsApp 这些消息渠道是插件；OpenAI、Anthropic、Groq 这些 LLM provider 是插件；Brave、Exa 这些搜索引擎是插件；甚至 memory 后端、诊断导出器、Claude 配置迁移器都是插件。可以说 OpenClaw 的产品形态有一大半是由插件拼出来的，core 只是一个"通用主循环 + 插件运行时"。

本章要回答：

1. 这 134 个插件分成哪几类？一个插件包在磁盘上长什么样？
2. 一个插件怎样声明自己——manifest 清单（`openclaw.plugin.json`）、`package.json` 的 `openclaw` 块、`api.ts` / `runtime-api.ts` 这些 barrel 文件各自的职责。
3. 插件 SDK（`src/plugin-sdk/*` 与 `packages/plugin-sdk/`）暴露了什么——插件怎样注册 channel、provider、tool、hook。
4. 插件加载器（`src/plugins/`）怎样发现、加载、注册一个插件，catalog 是什么。
5. 内置 bundled 插件 与 外部 official 插件的区别——为什么有些插件在 core dist 里、有些在外面。
6. 钩子机制——`message_received` 等生命周期事件怎样让插件参与到运行流程里。
7. 架构边界——`AGENTS.md` 反复强调的"core 不准引用插件内部、插件不准引用 core `src/**`"到底是怎么落地的。

阅读本章前建议先读第 09 章（工具系统）——本章的"插件注册工具"是第 09 章工具来源的另一半。

## 10.2 为什么 OpenClaw 要做成插件架构

先理解动机，再看实现。OpenClaw 是一个自托管的个人 AI 助手网关。它面对的现实是：

- **渠道无穷无尽**——用户可能用 Telegram、可能用 Discord、可能用 iMessage、IRC、Matrix、企业微信、飞书。没有一个 core 能内建所有渠道。
- **provider 频繁变动**——LLM provider 几个月就冒出一批新的。OpenAI 改一次 API、新增一个 reasoning 参数，不该逼着 core 发版。
- **能力可选**——不是每个用户都需要图片生成、不是每个用户都需要 LanceDB 向量记忆。把这些做成可装可卸的插件，core 才能保持精简。

所以 `AGENTS.md:28` 把第一条架构原则写成：「**Core stays plugin-agnostic.** No bundled ids/defaults/policy in core when manifest/registry/capability contracts work.」——core 对插件保持无关。core 不知道有个叫 `telegram` 的插件，它只知道"有一种东西叫 channel 插件，它会通过某个契约注册进来"。

这条原则贯穿全章。理解了它，后面所有看起来繁琐的设计（manifest、barrel、facade、catalog）就都有了解释——它们全是为了在"core 不认识具体插件"的前提下，仍然能发现、加载、配置、运行插件。

## 10.3 extensions/ 目录：134 个插件的分类

`extensions/` 下每个子目录是一个插件包。`v2026.5.18` 共 134 个。按职责大致分四类：

### 10.3.1 channel 插件（消息渠道）

把 OpenClaw 接到一个消息平台。典型：`telegram`、`discord`、`slack`、`whatsapp`、`signal`、`imessage`、`matrix`、`irc`、`nostr`、`line`、`feishu`、`googlechat`、`msteams`、`mattermost`、`twitch`、`webhooks`、`voice-call`。

channel 插件的标志是 `package.json` 的 `openclaw` 块里有 `channel` 字段。看 `extensions/telegram/package.json`：

```json
"openclaw": {
  "extensions": ["./index.ts"],
  "setupEntry": "./setup-entry.ts",
  "channel": {
    "id": "telegram",
    "label": "Telegram",
    "docsPath": "/channels/telegram",
    "configuredState": { "env": { "allOf": ["TELEGRAM_BOT_TOKEN"] } },
    ...
  }
}
```

`channel` 块里的 `id`、`label`、`docsPath`、`configuredState` 这些元数据让 core **不执行任何插件代码**就知道"有个叫 Telegram 的渠道、它配好的标志是 `TELEGRAM_BOT_TOKEN` 环境变量存在"。这对 setup 向导、`openclaw doctor` 至关重要——它们需要列举/检查渠道但不想把每个 channel 插件都跑起来。

### 10.3.2 provider 插件（LLM / 媒体 provider）

提供模型推理或媒体能力。文本 provider：`openai`、`anthropic`、`groq`、`mistral`、`deepseek`、`moonshot`、`openrouter`、`xai`、`google`、`ollama`、`lmstudio`、`vllm`、`sglang`、`together`、`fireworks`、`cerebras` 等。媒体 provider：`fal`、`comfy`、`elevenlabs`、`runway`、`minimax`、`inworld`。语音/转写：`deepgram`、`azure-speech`、`senseaudio`。AI gateway 类：`vercel-ai-gateway`、`cloudflare-ai-gateway`、`litellm`、`copilot-proxy`。

`AGENTS.md:43` 给 provider 划了清晰职责：「**Providers own auth/catalog/runtime hooks; core owns generic loop.**」——provider 插件拥有自己的鉴权、模型目录、运行时钩子；core 只拥有通用的推理循环。

### 10.3.3 tool / capability 插件

提供工具或某种能力。搜索：`brave`、`duckduckgo`、`exa`、`tavily`、`perplexity`、`firecrawl`、`searxng`。记忆：`memory-core`、`memory-lancedb`、`memory-wiki`、`active-memory`。媒体能力核心：`image-generation-core`、`video-generation-core`、`media-understanding-core`、`document-extract`、`web-readability`。还有 `browser`（浏览器控制）、`canvas`、`webhooks`、`llm-task`、`file-transfer`。

### 10.3.4 诊断 / 工具链 / 迁移类插件

辅助性插件：`diagnostics-otel`、`diagnostics-prometheus`（可观测性导出）、`migrate-claude`、`migrate-hermes`（从其他助手迁移配置）、`device-pair`、`phone-control`、`admin-http-rpc`、`test-support`、`qa-channel`、`qa-lab`、`qa-matrix`（测试支撑）、`skill-workshop`。

需要注意：上面这些分类不是代码里的硬枚举。代码里只有 `PluginKind`（`src/plugins/plugin-kind.types.ts:1`），而且它只有两个值：

```ts
export type PluginKind = "memory" | "context-engine";
```

为什么只有两个？因为绝大多数插件**不需要声明 kind**——它们的"类别"是由它们注册了什么能力隐式决定的。一个插件如果调了 `api.registerChannel()`，它就是 channel 插件；调了 `api.registerProvider()` 就是 provider 插件。`kind` 字段只为 `memory` 和 `context-engine` 这两种**互斥**的、需要在 metadata 阶段就知道类别的插件保留。这正是"core 对插件无关"的体现——core 不维护一张插件分类表，分类是注册行为的副产品。

## 10.4 一个插件包的结构

以 `extensions/telegram` 为例，一个完整插件包的文件构成：

```
extensions/telegram/
├── package.json              # npm 包定义 + openclaw 元数据块
├── openclaw.plugin.json      # 插件 manifest（清单）
├── index.ts                  # 插件入口
├── api.ts                    # 公共 barrel（给 core/其他插件用）
├── runtime-api.ts            # 运行时 barrel
├── channel-plugin-api.ts     # channel 能力 barrel
├── secret-contract-api.ts    # 密钥契约 barrel
├── setup-entry.ts            # setup 向导入口
├── tsconfig.json
└── src/                      # 私有实现（外界不准 deep-import）
    └── ...
```

### 10.4.1 manifest：openclaw.plugin.json

manifest 是插件的**声明文件**。文件名常量在 `src/plugins/manifest.ts:34`：

```ts
export const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
```

看 `extensions/telegram/openclaw.plugin.json`：

```json
{
  "id": "telegram",
  "activation": { "onStartup": false },
  "channels": ["telegram"],
  "channelEnvVars": { "telegram": ["TELEGRAM_BOT_TOKEN"] },
  "configSchema": { "type": "object", "additionalProperties": false, "properties": {} }
}
```

再看一个 provider 插件 `extensions/exa/openclaw.plugin.json`，信息更丰富：

```json
{
  "id": "exa",
  "activation": { "onStartup": false },
  "providerAuthEnvVars": { "exa": ["EXA_API_KEY"] },
  "uiHints": {
    "webSearch.apiKey": { "label": "Exa API Key", "sensitive": true, "placeholder": "exa-..." }
  },
  "contracts": { "webSearchProviders": ["exa"] },
  "configContracts": { "compatibilityRuntimePaths": ["tools.web.search.apiKey"] },
  "configSchema": { "type": "object", "properties": { "webSearch": { ... } } }
}
```

manifest 的设计意图是：**让 core 在不执行插件代码的情况下回答关于这个插件的所有元数据问题**。各字段：

- `id`：插件唯一标识。
- `activation.onStartup`：是否在网关启动时就激活。大多数插件是 `false`——按需激活，省内存。
- `channels` / `channelEnvVars`：声明这个插件提供哪些 channel、各 channel 的关键环境变量。
- `providerAuthEnvVars`：声明 provider 的鉴权环境变量。
- `contracts`：**契约声明**——`{ "webSearchProviders": ["exa"] }` 告诉 core「我会注册一个叫 `exa` 的 web search provider」。core 据此就能在 catalog 里登记这个能力，而无需加载插件。
- `configContracts.compatibilityRuntimePaths`：声明这个插件认哪些（可能是旧的）配置路径。
- `uiHints`：给 setup UI 用的字段标签、提示、占位符；`sensitive: true` 让 UI 知道这是密钥要打码。
- `configSchema`：JSON Schema，约束插件配置块的形状。

manifest 是 OpenClaw"core 无关"原则的**关键支柱**。没有 manifest，core 要想知道 exa 提供什么，就只能去 import 并执行 `extensions/exa/index.ts`——而那会触发插件运行时加载。有了 manifest，core 读一个 JSON 就够了。`extensions/AGENTS.md` 的边界规则也明说：「Keep plugin metadata accurate in `openclaw.plugin.json` and the package `openclaw` block so discovery and setup work **without executing plugin code**.」

### 10.4.2 package.json 的 openclaw 块

manifest 之外，`package.json` 里还有一个 `openclaw` 块（见 10.3.1 的 telegram 例子）。两者分工：

- `package.json` 的 `openclaw` 块：声明**入口文件**（`extensions`、`setupEntry`）和**包级别的、setup 阶段就需要的元数据**（channel 的 `label`、`docsPath`、`commands`、`configuredState`）。
- `openclaw.plugin.json`：声明**插件级别的契约与配置 schema**。

为什么拆成两个文件？历史与职责使然——`package.json` 是 npm 生态的标准文件，OpenClaw 借它放包发现需要的信息；`openclaw.plugin.json` 是 OpenClaw 专属的运行时契约文件。`exa` 的 `package.json` 里 `openclaw` 块极简（只有 `"extensions": ["./index.ts"]`），全部契约都在 `openclaw.plugin.json` 里。

### 10.4.3 入口文件 index.ts

`index.ts` 是插件的运行时入口。它的形态因插件类型而异。

**非 channel 插件**用 `definePluginEntry`。看 `extensions/exa/index.ts`：

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createExaWebSearchProvider } from "./src/exa-web-search-provider.js";

export default definePluginEntry({
  id: "exa",
  name: "Exa Plugin",
  description: "Bundled Exa web search plugin",
  register(api) {
    api.registerWebSearchProvider(createExaWebSearchProvider());
  },
});
```

整个 exa 插件就这么点代码：声明 id/name/description，然后在 `register(api)` 里调一次 `api.registerWebSearchProvider()`。所有真正的逻辑（怎么发 Exa HTTP 请求、怎么解析结果）都藏在 `./src/` 里。

**channel 插件**用 `defineBundledChannelEntry`。看 `extensions/telegram/index.ts`：

```ts
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "telegram",
  name: "Telegram",
  description: "Telegram channel plugin",
  importMetaUrl: import.meta.url,
  plugin: { specifier: "./channel-plugin-api.js", exportName: "telegramPlugin" },
  secrets: { specifier: "./secret-contract-api.js", exportName: "channelSecrets" },
  runtime: { specifier: "./runtime-setter-api.js", exportName: "setTelegramRuntime" },
  accountInspect: { specifier: "./account-inspect-api.js", exportName: "inspectTelegramReadOnlyAccount" },
});
```

注意 channel 入口不直接 `import` 实现，而是用 `{ specifier, exportName }` 这种**间接引用**——它声明"channel plugin 在 `./channel-plugin-api.js` 的 `telegramPlugin` 导出里"，但不立即加载。core 真正需要 channel 运行时时才按这些 specifier 动态 import。这是又一处"延迟加载"——一个没被用到的 channel 插件不会把它的运行时代码加载进内存。

### 10.4.4 barrel 文件：api.ts 与 runtime-api.ts

`extensions/telegram/` 下有一堆 `*-api.ts`：`api.ts`、`runtime-api.ts`、`channel-plugin-api.ts`、`secret-contract-api.ts`、`config-api.ts`、`contract-api.ts` 等。这些是 **barrel 文件**——纯 re-export，自己不含逻辑。看 `extensions/telegram/api.ts` 开头：

```ts
export { telegramPlugin } from "./src/channel.js";
export { telegramSetupPlugin } from "./src/channel.setup.js";
export { inspectTelegramAccount, ... } from "./src/account-inspect.js";
export { createTelegramActionGate, resolveTelegramAccount, ... } from "./src/accounts.js";
...
```

barrel 的存在理由直接来自架构边界。`extensions/AGENTS.md` 规定：「Treat files like `src/**` ... as **private** unless you intentionally promote them through `api.ts`.」「If core or core tests need a bundled plugin helper, **export it from `api.ts` first** instead of letting them deep-import extension internals.」

也就是说：插件的 `src/` 是私有的，外界（core、其他插件、测试）**不准 deep-import** `extensions/telegram/src/channel.ts`。如果 core 真的需要 `telegramPlugin`，插件作者必须先把它从 `api.ts` 显式导出，外界只能 import `extensions/telegram/api.ts`。`api.ts` 就是这个插件的"公共 ABI"——它明确划出了"哪些是承诺稳定的、哪些是随时可改的内部实现"。

`runtime-api.ts` 是同样的模式，专门收纳运行时相关的导出。这种分层 barrel 让插件能精确控制"什么时候暴露什么"。

## 10.5 插件 SDK

插件 SDK 是 core 和插件之间的**唯一合法接口**。`AGENTS.md:29` 写死了这一点：「Plugins cross into core only via `openclaw/plugin-sdk/*`, manifest metadata, injected runtime helpers, documented barrels (`api.ts`, `runtime-api.ts`).」

SDK 在代码库里有三个相关位置，要分清：

```
   packages/plugin-sdk/        ← 发布出去的 npm 包 @openclaw/plugin-sdk
        src/*.ts               ← 多数文件只是一行 re-export，转发到 ↓
        package.json exports   ← 一长串子路径映射
                │
                ▼
   src/plugin-sdk/             ← SDK 的真正实现（在 core 仓库里）
        index.ts               ← 极简根 surface
        plugin-entry.ts        ← definePluginEntry 等入口辅助
        core.ts / *-entry.ts   ← channel/provider 入口契约
        ... ~数百个文件
```

### 10.5.1 packages/plugin-sdk：发布包

`packages/plugin-sdk/` 是对外发布的 npm 包 `@openclaw/plugin-sdk`。它的 `src/` 下大多数文件只是 re-export。看 `packages/plugin-sdk/src/plugin-entry.ts` 全文：

```ts
export * from "../../../src/plugin-sdk/plugin-entry.js";
```

它整个就是一行——把 core 仓库里 `src/plugin-sdk/plugin-entry.ts` 的内容转发出来。`packages/plugin-sdk/package.json` 的 `exports` 字段把每个子路径（`./account-id`、`./acp-runtime`、`./browser-config`、`./time-runtime` ...）映射到对应文件，并且区分 `types`（指向 `dist/` 里的 `.d.ts`）和 `default`（源码路径）。

为什么 SDK 实现放在 `src/plugin-sdk/`、发布包却在 `packages/plugin-sdk/`？因为 SDK 的实现需要引用 core 的类型（`OpenClawConfig`、各种 `Provider*Context`），它天然属于 core 仓库；而 `packages/plugin-sdk/` 是一层薄薄的"打包外壳"，负责把这些实现以正确的子路径结构发布给外部插件作者。bundled 插件直接走源码路径，外部插件装 npm 包。

### 10.5.2 definePluginEntry：插件入口契约

`definePluginEntry()` 定义在 `src/plugin-sdk/plugin-entry.ts:283`。它的入参类型 `DefinePluginEntryOptions`（`src/plugin-sdk/plugin-entry.ts:259`）：

```ts
type DefinePluginEntryOptions = {
  id: string;
  name: string;
  description: string;
  /** @deprecated 在 openclaw.plugin.json 的 manifest kind 里声明 */
  kind?: OpenClawPluginDefinition["kind"];
  configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
  reload?: OpenClawPluginDefinition["reload"];
  nodeHostCommands?: OpenClawPluginDefinition["nodeHostCommands"];
  securityAuditCollectors?: OpenClawPluginDefinition["securityAuditCollectors"];
  register: (api: OpenClawPluginApi) => void;
};
```

`register: (api: OpenClawPluginApi) => void` 是核心——这就是插件"做事"的地方，`api` 就是 SDK 给插件的能力句柄。

一个值得注意的实现细节是 `configSchema` 可以是函数，`definePluginEntry` 内部用 `createCachedLazyValueGetter` 包成惰性 getter（`src/plugin-sdk/plugin-entry.ts:291`）：

```ts
const getConfigSchema = createCachedLazyValueGetter(configSchema);
return {
  id, name, description,
  ...(kind ? { kind } : {}),
  get configSchema() { return getConfigSchema(); },
  register,
};
```

为什么 schema 要惰性？因为构造 JSON Schema 可能涉及不便宜的计算，而 metadata-only 路径（doctor、catalog 扫描）可能根本不需要 schema。惰性 getter 让"加载插件入口"和"真正用到 schema"解耦。

注意 `kind` 字段标了 `@deprecated`——`src/plugin-sdk/plugin-entry.ts:262` 的注释要求把 kind 声明放进 manifest 而不是运行时入口。原因在 `src/plugins/types.ts:2308` 的注释里：运行时导出的 `kind` 会"在 metadata-only 命令路径上要求加载插件运行时"。把 kind 移进 manifest，core 读 JSON 就知道类别，不必加载代码。这是"core 无关"原则的又一次落地。

channel 插件不用 `definePluginEntry`，而用 `defineChannelPluginEntry`（来自 `openclaw/plugin-sdk/core`），因为它要继承 channel 能力的接线（`src/plugin-sdk/plugin-entry.ts:277` 的注释说明了这点）。

### 10.5.3 OpenClawPluginApi：插件能拿到的能力

`register(api)` 里那个 `api` 的类型是 `OpenClawPluginApi`（`src/plugins/types.ts`）。它是一个巨大的接口，是插件能力的全集。核心是一组 `register*` 方法（`src/plugins/types.ts:2576` 起）：

```ts
registerTool: (tool: AnyAgentTool | OpenClawPluginToolFactory, opts?) => void;
registerHook: (events: string | string[], handler: InternalHookHandler, opts?) => void;
registerHttpRoute: (params: OpenClawPluginHttpRouteParams) => void;
registerChannel: (registration: OpenClawPluginChannelRegistration | ChannelPlugin) => void;
registerGatewayMethod: (method: string, handler: GatewayRequestHandler, opts?) => void;
registerProvider: (provider: ProviderPlugin) => void;
registerCommand: (command: OpenClawPluginCommandDefinition) => void;
registerToolMetadata: (metadata: PluginToolMetadataRegistration) => void;
...
```

`api-builder.ts` 里 `BuildPluginApiParams.handlers` 的那串 `Pick<...>`（`src/plugins/api-builder.ts:18`–`84`）列出了完整的 `register*` 家族——超过 60 个。摘录一部分能力维度：

- **工具与钩子**：`registerTool`、`registerHook`、`registerToolMetadata`、`registerTrustedToolPolicy`、`registerAgentToolResultMiddleware`。
- **channel**：`registerChannel`。
- **provider**：`registerProvider`、`registerModelCatalogProvider`、`registerSpeechProvider`、`registerImageGenerationProvider`、`registerVideoGenerationProvider`、`registerMusicGenerationProvider`、`registerWebSearchProvider`、`registerWebFetchProvider`、`registerRealtimeTranscriptionProvider`、`registerMediaUnderstandingProvider`。
- **网关 / HTTP / CLI**：`registerHttpRoute`、`registerGatewayMethod`、`registerCli`、`registerCliBackend`、`registerCommand`、`registerNodeHostCommand`。
- **memory / context**：`registerMemoryCapability`、`registerMemoryRuntime`、`registerMemoryEmbeddingProvider`、`registerContextEngine`、`registerCompactionProvider`。
- **运行时杂项**：`registerService`、`registerReload`、`registerConfigMigration`、`registerMigrationProvider`、`registerSecurityAuditCollector`、`registerAutoEnableProbe`、`registerSessionExtension`、`registerInteractiveHandler`。

`registerGatewayMethod` 还有一个安全细节（`src/plugins/types.ts:2592` 的注释）：保留的 core 管理命名空间（`config.*`、`exec.approvals.*`、`wizard.*`、`update.*`）即使插件请求更窄的 scope，也会被强制归一到 `operator.admin`——插件不能借注册网关方法之名偷偷接管 core 的管理接口。

### 10.5.4 api-builder：怎样构造 api 对象

`buildPluginApi()`（`src/plugins/api-builder.ts`）负责为每个插件构造它的 `api` 对象。关键是 `BuildPluginApiParams` 里有个 `handlers` 字段——它是 `register*` 方法的**实际实现**的可选注入。`src/plugins/api-builder.ts:86` 起定义了一堆 `noopRegister*`（如 `noopRegisterTool = () => {}`）。

这种"handlers 可选注入 + noop 默认"的设计服务于不同的加载模式。回顾 `PluginRegistrationMode`（`src/plugins/types.ts:2340`）：`full` / `discovery` / `tool-discovery` / `setup-only` / `setup-runtime` / `cli-metadata`。在 `discovery` 模式下加载插件时，core 只想知道"这个插件会注册什么",并不想真的把工具/channel 接进运行系统——于是给它一个 `registerTool` 是 noop 的 `api`。插件的 `register(api)` 照常跑，但所有 `register*` 调用都打在 noop 上，core 通过别的方式（captured-registration）观察到注册意图却不产生副作用。`full` 模式才注入真正会落地的 handlers。

同一份 `register(api)` 代码，喂不同的 `api`，跑出不同强度的副作用——这是插件加载器实现多种加载模式的基石。

## 10.6 插件加载器

加载器在 `src/plugins/`，是 OpenClaw 代码量最大的子系统之一（200+ 文件）。它的职责是：发现磁盘上的插件 → 读 manifest → 按模式加载 → 调 `register` → 把注册结果登记进 registry。

### 10.6.1 发现（discovery）

`discoverOpenClawPlugins()`（`src/plugins/discovery.ts`）扫描磁盘找候选插件，产出 `PluginCandidate[]`（`src/plugins/discovery.ts:57`）。它做的事：

- 扫 `extensions/` 等插件根目录。`SCANNED_DIRECTORY_IGNORE_NAMES`（`src/plugins/discovery.ts:43`）排除 `.git`、`node_modules`、`dist`、`build`、`coverage` 等噪声目录。
- 识别两种插件格式（`PluginFormat`，`src/plugins/manifest-types.ts:11`）：`"openclaw"`（OpenClaw 原生插件）和 `"bundle"`（`PluginBundleFormat`：`codex` / `claude` / `cursor` 三种外来 bundle 格式，`src/plugins/manifest-types.ts:13`）。
- 一个目录被认作 OpenClaw 插件，要么有 `openclaw.plugin.json`（`src/plugins/discovery.ts:960`），要么 `package.json` 里有 `openclaw` 块。
- 找入口文件——`DEFAULT_PLUGIN_ENTRY_CANDIDATES`（`src/plugins/discovery.ts:911`、`1154`）列出候选入口名（`index.ts` 等）。
- 安全检查：`shouldRejectHardlinkedPluginFiles()`（`src/plugins/hardlink-policy.ts`）拒绝硬链接的插件文件——防止有人用硬链接绕过插件文件完整性检查。

发现阶段产出的是"候选"而非"已加载"——它只记录"这里有个看起来像插件的目录、它的 manifest 说了什么"，不执行任何插件代码。

### 10.6.2 加载（loading）

`src/plugins/loader.ts` 是加载主流程。一次完整加载的概念流程：

```
   discoverOpenClawPlugins()         ← 扫盘，得到候选
            │
   loadPluginManifestRegistry()      ← 读所有 manifest，得到 PluginManifestRegistry
            │
   resolveEffectiveEnableState()     ← 按配置/默认策略决定每个插件 启用/禁用
   resolveEffectivePluginActivationState()
            │
   对每个启用的插件：
     buildPluginApi(...) ─────────── 按 registrationMode 构造 api（注入真/假 handlers）
     动态 import 插件入口模块
     调 entry.register(api)  ──────── 插件执行注册
            │
   注册结果汇入 PluginRegistry
   initializeGlobalHookRunner(...)   ← 钩子运行器就绪
```

`loader.ts` 顶部 import 了一长串 `clear* / list* / restore*` 三元组（`src/plugins/loader.ts:4`–`23` 起）——`clearPluginCommands` / `listRegisteredPluginCommands` / `restorePluginCommands`、`clearCompactionProviders` / ... / `restoreRegisteredCompactionProviders` 等等。这个模式说明加载器支持**插件热重载**：重载一个插件时，先把它之前注册的东西 `clear` 掉，加载新版本，失败时 `restore` 回旧版本。一个插件重载失败不会让系统进入"半注册"的坏状态。

`PluginLoaderCacheState`（`src/plugins/loader-cache-state.ts`）缓存加载结果，避免重复扫盘和重复 import。

### 10.6.3 注册与 registry

`src/plugins/registry.ts` 是插件注册中心。所有 `register*` 调用最终落进这里的数据结构。`registry.ts` 顶部的 import 揭示了它要把注册结果分发到多少个子系统：`registerContextEngineForOwner`（context-engine 注册）、`createPluginGatewayMethodDescriptor`（网关方法）、`registerInternalHook`（钩子）、`registerPluginCommand`（CLI 命令）、`registerAgentHarness`（agent harness）……（`src/plugins/registry.ts:14`–`56`）。

`registry.ts` 还引入了 `getPluginCompatRecord`（`src/plugins/registry.ts:53`，来自 `compat/registry.ts`）——插件兼容记录。这服务于 `AGENTS.md:41` 的"Public plugin SDK/API is the compat exception"原则：SDK 的旧路径只能通过带名的 compat/deprecation 元数据保留。

### 10.6.4 catalog

"catalog"在加载器里指**插件能力目录**——一份"系统里有哪些插件能力"的清单，且能在不加载插件的前提下构建。

`src/plugins/official-external-plugin-catalog.ts:1`–`3` import 了三个 JSON 目录文件：

```ts
import officialExternalChannelCatalog  from "../../scripts/lib/official-external-channel-catalog.json"  ...;
import officialExternalPluginCatalog   from "../../scripts/lib/official-external-plugin-catalog.json"   ...;
import officialExternalProviderCatalog from "../../scripts/lib/official-external-provider-catalog.json" ...;
```

这三个 JSON 文件是"官方外部插件"的静态目录——记录了所有官方维护、但不打进 core dist 的插件（channel/provider/通用三类）。每条记录带 `id`、`name`、`docs`、`categories`、provider 还带 `authChoices`（`OfficialExternalProviderCatalogProvider`，`src/plugins/official-external-plugin-catalog.ts:31`；web search provider 是 `OfficialExternalWebSearchProvider`，`src/plugins/official-external-plugin-catalog.ts:40`）。

catalog 的用途：当用户在 setup 向导里选"我要用 Exa 搜索"，OpenClaw 即使本地还没装 Exa 插件，也能从 catalog 里查到"Exa 是个 web search provider、装包名是什么、需要 `EXA_API_KEY`"——然后引导用户安装。catalog 让"插件市场"体验成为可能，而 core 仍对具体插件无关——它读的是数据，不是代码。

bundled 插件这边的 catalog 由 `resolveBundledPluginSources()`（`src/plugins/bundled-sources.ts:37`）构建——它对 `discoverOpenClawPlugins()` 的结果再读 manifest，产出 `Map<pluginId, BundledPluginSource>`（`BundledPluginSource`，`src/plugins/bundled-sources.ts:5`）。

## 10.7 bundled 插件 vs 外部 official 插件

OpenClaw 把插件分成两个发布层级，这是初读代码时最容易困惑的点之一。

```
   ┌──────────────────────────────┐    ┌──────────────────────────────┐
   │  内置 bundled 插件             │    │  外部 official 插件            │
   │                              │    │                              │
   │  随 core dist 一起打包发布     │    │  独立 npm 包，不进 core dist   │
   │  例如 core 必备的能力插件      │    │  例如可选 channel/provider     │
   │                              │    │                              │
   │  可用"bundled-only facade     │    │  core 用 registry-aware       │
   │  loader"                     │    │  facade-runtime 或通用契约     │
   └──────────────────────────────┘    └──────────────────────────────┘
```

`AGENTS.md:34`–`36` 把规则写得很清楚：

- 「**Internal bundled plugins ship in core dist**; bundled-only facade loader ok only for them.」——内置插件随 core dist 发布，它们可以用一种"只对 bundled 插件可用"的 facade loader。
- 「**External official plugins own package/deps and are excluded from core dist**; core uses registry-aware `facade-runtime` or generic contracts.」——外部官方插件自带 package 与依赖、被排除在 core dist 之外；core 通过 registry-aware 的 `facade-runtime` 或通用契约访问它们。

为什么要分两层？是一个**体积 vs 便利**的权衡：

- 如果所有 134 个插件都打进 core dist，core 会非常臃肿——一个只用 Telegram 的用户没必要带上 Discord、Slack、IRC 的代码和依赖。
- 但如果所有插件都外置，core 就连最基本的能力都没有，开箱即不可用。

所以策略是：少数 core 运行必需的能力插件做成 bundled，随 core 发布；其余大量可选的 channel/provider 做成外部 official 插件,按需安装。

`AGENTS.md:33` 还规定了依赖归属：「Dependency ownership follows runtime ownership: plugin-only deps stay plugin-local; root deps only for core imports or intentionally internalized bundled plugin runtime.」——外部插件的依赖留在插件自己的 `package.json`（telegram 的 `grammy`、exa 的 HTTP 客户端都在各自包里），只有 core 自己用的、或被有意"内化"的 bundled 插件运行时依赖才进根 `package.json`。`extensions/AGENTS.md` 也复述了这条。

"把一个 bundled 插件外部化"是有完整 checklist 的（`AGENTS.md:36`）：更新 package excludes、官方 catalog、文档、测试，并且要**先证明 core 运行时路径能解析到已安装插件根**，才能从根依赖里移除。这种迁移有专门的契约测试（`src/plugins/contracts/` 下 `extension-package-project-boundaries.test.ts`、`extension-runtime-dependencies.contract.test.ts`）守着。

`src/plugins/contracts/` 下还有一大批 `plugin-registration.*.contract.test.ts`——`plugin-registration.brave.contract.test.ts`、`plugin-registration.exa.contract.test.ts`、`plugin-registration.openai.contract.test.ts` 等等，每个官方插件一份。这些契约测试断言"这个插件在 manifest 里声明的契约、和它实际 `register` 时注册的能力是一致的"——manifest 不能撒谎。

## 10.8 钩子机制

钩子（hook）是插件**参与到运行流程**的方式。`register*` 让插件"提供能力"，钩子让插件"在关键时刻插一脚"。

### 10.8.1 钩子事件清单

钩子事件名定义在 `src/plugins/hook-types.ts:68`，`PluginHookName` 联合类型,完整列表（`src/plugins/hook-types.ts:68`–`106`）：

```
before_model_resolve   agent_turn_prepare      before_prompt_build
before_agent_start     before_agent_reply      model_call_started
model_call_ended       llm_input               llm_output
before_agent_finalize  agent_end               before_compaction
after_compaction       before_reset            inbound_claim
message_received       message_sending         message_sent
before_tool_call       after_tool_call         tool_result_persist
before_message_write   session_start           session_end
subagent_spawning      subagent_delivery_target subagent_spawned
subagent_ended         deactivate(@deprecated) gateway_start
gateway_stop           heartbeat_prompt_contribution                cron_changed
before_dispatch        reply_dispatch          before_install
before_agent_run
```

`PLUGIN_HOOK_NAMES`（`src/plugins/hook-types.ts:108`）是同一份清单的 `as const` 数组形式，紧接着 `src/plugins/hook-types.ts:148`–`150` 有一段类型断言：

```ts
type MissingPluginHookNames = Exclude<PluginHookName, (typeof PLUGIN_HOOK_NAMES)[number]>;
type AssertAllPluginHookNamesListed = MissingPluginHookNames extends never ? true : never;
const assertAllPluginHookNamesListed: AssertAllPluginHookNamesListed = true;
```

这是一个编译期断言——如果 `PluginHookName` 联合里新增了一个名字但忘了加进 `PLUGIN_HOOK_NAMES` 数组，`MissingPluginHookNames` 就不是 `never`，`assertAllPluginHookNamesListed` 那行会编译失败。一个小技巧保证"类型联合"和"运行时数组"永远同步。

按生命周期阶段归类钩子：

- **消息进出**：`inbound_claim`（认领入站消息）、`message_received`、`message_sending`、`message_sent`、`before_dispatch`、`reply_dispatch`、`before_message_write`。
- **agent 运行**：`before_agent_run`、`before_agent_start`、`agent_turn_prepare`、`before_prompt_build`、`before_agent_reply`、`before_agent_finalize`、`agent_end`。
- **模型调用**：`before_model_resolve`、`model_call_started`、`model_call_ended`、`llm_input`、`llm_output`。
- **工具**：`before_tool_call`、`after_tool_call`、`tool_result_persist`（第 09 章 9.8 已详述 `before_tool_call`）。
- **会话与子 agent**：`session_start`、`session_end`、`subagent_spawning`、`subagent_spawned`、`subagent_ended`、`subagent_delivery_target`。
- **上下文压缩**：`before_compaction`、`after_compaction`、`before_reset`。
- **网关与系统**：`gateway_start`、`gateway_stop`、`heartbeat_prompt_contribution`、`cron_changed`、`before_install`。

### 10.8.2 message_received 钩子

以 `message_received` 为例。当 OpenClaw 从某个 channel 收到一条用户消息，运行流程会触发 `message_received` 钩子,把消息上下文交给所有注册了该钩子的插件。插件可以借此：

- 给消息打标签 / 做内容审查；
- 决定要不要让 agent 处理这条消息；
- 注入额外上下文。

`inbound_claim` 与它配对——决定"这条入站消息归谁处理"。`thread-ownership` 插件就靠 `inbound_claim` 类钩子实现"一个对话线程归一个 agent 所有"。

### 10.8.3 hook-runner：钩子运行器

钩子的执行由 `HookRunner` 负责，`createHookRunner()`（`src/plugins/hooks.ts`）创建。它有一个全局单例版本——`hook-runner-global.ts`。`initializeGlobalHookRunner()`（`src/plugins/hook-runner-global.ts:31`）在插件加载完成后被调一次：

```ts
export function initializeGlobalHookRunner(registry: GlobalHookRunnerRegistry): void {
  const state = getState();
  state.registry = registry;
  state.hookRunner = createHookRunner(registry, {
    logger: { ... },
    catchErrors: true,
    failurePolicyByHook: {
      before_agent_run: "fail-closed",
      before_tool_call: "fail-closed",
      ...
    },
  });
}
```

几个关键设计点：

1. **全局单例**——`src/plugins/hook-runner-global.ts:19` 用 `Symbol.for("openclaw.plugins.hook-runner-global-state")` 加 `resolveGlobalSingleton` 实现进程级单例。这样代码库任何地方都能 `getGlobalHookRunner()` 拿到它，无需层层传参（第 09 章工具执行就是这么用的）。
2. **`catchErrors: true`**——一个插件的钩子抛异常不会把整个运行流程带崩。
3. **`failurePolicyByHook`**——按钩子区分失败策略。`before_agent_run`、`before_tool_call` 是 `"fail-closed"`——它们是安全门，钩子失败时默认**拦截**而非放行。其他钩子大多是 fail-open（失败就跳过）。安全相关的钩子必须保守。

钩子还分**同步钩子**和**异步钩子**。一些钩子（如 `message_received` 的某些用途）走 fire-and-forget（`src/hooks/fire-and-forget.ts`）——触发后不等待结果，避免拖慢主流程。`hooks.sync-only.test.ts` 守着"哪些钩子必须同步"的契约。

### 10.8.4 bundled 钩子

除了插件注册的钩子，OpenClaw 自身也有几个**内置钩子处理器**，在 `src/hooks/bundled/` 下：`boot-md`（启动时读 BOOT.md）、`bootstrap-extra-files`、`command-logger`（命令日志）、`compaction-notifier`（压缩通知）、`session-memory`（会话记忆）。每个目录有一个 `handler.ts` 和一个 `HOOK.md`（钩子的文档）。这些是 core 用钩子机制实现自己功能的例子——钩子不只给插件用,core 自己也吃自己的狗粮。

`src/hooks/` 下还有用户级钩子的加载逻辑（`loader.ts`、`module-loader.ts`、`frontmatter.ts`）——用户可以在配置目录里写自己的钩子脚本,带 frontmatter,被加载进同一套 `HookRunner`。

## 10.9 架构边界：如何被强制执行

`AGENTS.md` 的 Architecture 段反复强调两个方向的边界。把它们汇总并说明落地手段。

**边界 1：插件生产代码不准引用 core `src/**`。**

`AGENTS.md:30`：「Plugin prod code: no core `src/**`, `src/plugin-sdk-internal/**`, other plugin `src/**`, or relative outside package.」

插件只能 import `openclaw/plugin-sdk/*`（SDK 公共子路径）和自己包内的相对路径。它不能 `import "../../src/agents/..."`,不能 import 别的插件的 `src/`。

落地手段：
- `extensions/tsconfig.package-boundary.base.json` 和 `tsconfig.package-boundary.paths.json` 用 TypeScript 项目边界限制每个 extension 包能 import 什么。
- `src/plugins/contracts/` 下的契约测试：`extension-package-project-boundaries.test.ts`、`core-extension-facade-boundary.test.ts`、`plugin-entry-guardrails.test.ts`、`plugin-sdk-runtime-api-guardrails.test.ts`。
- `src/plugins/loader-sdk-import-guardrails.test.ts` 专门守 SDK import 边界。

**边界 2：core / core 测试不准 deep-import 插件内部。**

`AGENTS.md:31`：「Core/tests: no deep plugin internals (`extensions/*/src/**`, `onboard.js`). Use public barrels, SDK facade, generic contracts.」

core 不能 `import "../../extensions/telegram/src/channel.ts"`。如果 core 真需要 telegram 的某个 helper,telegram 必须先从 `api.ts` 导出,core 只能 import `extensions/telegram/api.ts`(10.4.4 讲过)。

**为什么这两个边界这么重要？**

因为它们让 core 和插件可以**独立演进**。core 重构 `src/agents/` 的内部结构,不会弄坏任何插件——插件根本看不到那里。一个插件改它的 `src/`,不会影响 core 和别的插件——只要 `api.ts` 的导出形状不变。SDK(`openclaw/plugin-sdk/*`)和 barrel(`api.ts`)是两边唯一的接触面,只要这层接口稳定,两边就解耦。

这也是为什么 `AGENTS.md:41` 把"Public plugin SDK/API"列为**唯一的兼容性例外**——core 内部可以随便改、删旧代码,但 SDK 的旧路径必须按"新 API 先行、旧路径带 deprecation 元数据保留、新旧都有测试、有计划的移除"这套流程走。SDK 是对外承诺,core 内部不是。

`AGENTS.md:32` 的 owner boundary 是这条原则的延伸:"owner 专属的修复/检测/onboarding/鉴权/默认值/provider 行为"必须住在 owner 插件里,core 和共享层只拿"通用的接缝(generic seams)"。core 不该为了某个具体插件的需求长出特例分支。

## 10.10 全章总览

把发现、SDK、加载、注册、钩子串成一张图:

```
   磁盘 extensions/*/                 (134 个插件包)
   ├── openclaw.plugin.json  ─────┐
   ├── package.json (openclaw 块) ─┤  manifest 元数据(不执行代码即可读)
   ├── index.ts (definePluginEntry)│
   ├── api.ts / runtime-api.ts ────┘  公共 barrel(唯一对外 ABI)
   └── src/  (私有实现)
              │
              ▼  discoverOpenClawPlugins() —— 扫盘,得候选
   ┌──────────────────────────────────────────────┐
   │  插件加载器 src/plugins/                       │
   │   loadPluginManifestRegistry()  读 manifest    │
   │   resolveEffectiveEnableState() 决定启用/禁用  │
   │   buildPluginApi(mode)          按模式造 api   │
   │   import 入口 + entry.register(api)            │
   └───────────────────┬──────────────────────────┘
                       │ api.registerTool/Channel/Provider/Hook...
                       ▼
   ┌──────────────────────────────────────────────┐
   │  PluginRegistry  src/plugins/registry.ts       │
   │   工具 → agent 工具表    channel → 渠道运行时   │
   │   provider → 推理循环    hook → HookRunner      │
   │   gatewayMethod / command / httpRoute → ...    │
   └───────────────────┬──────────────────────────┘
                       │ initializeGlobalHookRunner()
                       ▼
   运行时:HookRunner 在 message_received / before_tool_call /
          agent_end / gateway_start ... 等 36 个生命周期点触发插件钩子

   catalog:scripts/lib/official-external-*-catalog.json
           让 core 在不装插件的前提下知道"有哪些可选插件"

   边界:插件 prod 代码 ─只能→ openclaw/plugin-sdk/* + 自己 barrel
        core/测试      ─只能→ 插件 api.ts(不准 deep-import src/**)
        契约测试 src/plugins/contracts/ 强制执行
```

## 10.11 小结与延伸

本章要点:

1. OpenClaw 的产品形态大半由 134 个 `extensions/` 插件拼成,核心原则是 **core 对插件无关**(`AGENTS.md:28`)。
2. 一个插件包靠 **manifest**(`openclaw.plugin.json`)+ **package.json 的 openclaw 块** 声明元数据,让 core **不执行插件代码**就能发现、配置、引导安装它。
3. **barrel 文件**(`api.ts` / `runtime-api.ts`)是插件的公共 ABI,`src/` 是私有的,外界不准 deep-import。
4. **插件 SDK**(`packages/plugin-sdk/` 发布壳 + `src/plugin-sdk/` 实现)是 core 与插件唯一合法接口;`definePluginEntry` 的 `register(api)` 里,`OpenClawPluginApi` 的 60+ 个 `register*` 方法是插件能力全集。
5. **加载器**(`src/plugins/`)分发现、按 `PluginRegistrationMode` 加载、注册三步;`buildPluginApi` 的 handlers 可注入真/noop,实现多种加载模式;`clear/list/restore` 三元组支持安全热重载。
6. **bundled 插件**随 core dist 发布(少数必需能力),**外部 official 插件**独立成 npm 包(大量可选 channel/provider);**catalog** 让 core 在不装插件时也能列举可选插件。
7. **钩子**有 36 个生命周期事件,由全局单例 `HookRunner` 执行,安全门钩子 fail-closed。
8. **架构边界**靠 TypeScript 项目边界 + `src/plugins/contracts/` 大量契约测试强制执行,让 core 与插件能独立演进。

延伸阅读:第 09 章——本章插件注册的工具/web search provider 是第 09 章工具系统的来源之一,`before_tool_call` 钩子在 9.8 详述。第 06 章——`before_agent_start` / `agent_end` 等钩子嵌在 agent 运行循环里。第 08 章——channel 插件的运行时如何接入会话系统。
