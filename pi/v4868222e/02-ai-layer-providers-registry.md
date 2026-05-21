# 第 02 章 AI 层：多 Provider 抽象与模型注册表

> 代码版本锁定:`earendil-works/pi@4868222e`(2026-05-20)。本章所有 `file:line` 引用均基于该 commit。

---

## 2.1 设计目标：为什么不直接用各家 SDK

`README.md:25` 把 `@earendil-works/pi-ai` 描述为：

> Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

"统一"两字背后有三层动机：

**一、接口标准化**。OpenAI SDK、Anthropic SDK、Google Generative AI SDK 的调用方式、流式事件格式、token 计费字段各不相同。agent-core 的工具调用循环不应关心当前连的是哪个 provider，它只需要迭代一个标准化的事件流。

**二、可替换性**。用户可以在同一个会话里用 `Ctrl+P` 在 claude-opus 和 gpt-5 之间切换（`main.ts:360-365` 的 `scopedModels` 机制），切换时不需要重写 context 格式。

**三、延迟加载与体积控制**。每家 provider SDK 都有自己的依赖树，如果静态 import 全部，初始化耗时和包体积都不可接受。pi-ai 通过 lazy 注册机制（见 2.4 节）只在第一次实际调用该 provider 时才动态加载对应模块。

`AGENTS.md:136-185` 用一整节详述了"添加新 provider 需要改哪些文件"，间接揭示了抽象层的组成部分：类型系统、provider 实现、注册表、模型生成脚本、测试矩阵。

---

## 2.2 三个公共入口的语义差异

`packages/ai/src/stream.ts` 导出了五个函数，其中核心的三个：

### 2.2.1 `stream()`

```typescript
// packages/ai/src/stream.ts:25-32
export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): AssistantMessageEventStream {
  const provider = resolveApiProvider(model.api);
  return provider.stream(model, context, options as StreamOptions);
}
```

**语义**：向具体 provider 发起流式请求，返回一个事件流对象。调用者可以迭代事件（text_delta、tool_call 等）或等待 `stream.result()` 拿到完整的 `AssistantMessage`。

**适用场景**：需要传递 provider 专属选项时（`ProviderStreamOptions = StreamOptions & Record<string, unknown>`），例如 Anthropic 的 `AnthropicOptions` 里有 `anthropicEffort`、`thinkingDisplay` 等字段，对其他 provider 无意义。

### 2.2.2 `streamSimple()`

```typescript
// packages/ai/src/stream.ts:43-49
export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const provider = resolveApiProvider(model.api);
  return provider.streamSimple(model, context, options);
}
```

**语义**：使用跨 provider 统一的 `SimpleStreamOptions`，只包含可以在所有 provider 间移植的选项（`temperature`、`maxTokens`、`reasoning?: ThinkingLevel` 等）。

**适用场景**：agent-core 的工具调用循环（`AgentSession` 里调用 `streamSimple`，`agent-session.ts:35`），以及 `complete()` 的场景。caller 不需要关心底层是哪个 API，只需要表达意图（"我需要 medium 级别的 thinking"），`streamSimple` 实现负责翻译成 provider 特定的参数（token budget、effort string 等）。

**为什么要拆这两个**：`stream()` 给 library consumer 最大灵活性，`streamSimple()` 给 agent 内部最大可移植性。两者共存避免了"为了移植性而阉割功能"的取舍。

### 2.2.3 `complete()` 与 `completeSimple()`

```typescript
// packages/ai/src/stream.ts:34-41
export async function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
  const s = stream(model, context, options);
  return s.result();
}
```

`complete()` 是 `stream()` 的 Promise 包装——消费完整个流然后返回最终的 `AssistantMessage`。适合不需要逐事件处理的场景（比如单轮 LLM 调用、批量测试）。`completeSimple()` 是对应的 `streamSimple()` 包装。

---

## 2.3 核心类型系统

`packages/ai/src/types.ts` 是整个 pi-ai 的类型宪法，565 行。以下逐一解析最关键的 8 个类型。

### 2.3.1 `Api`（第 17 行）

```typescript
// packages/ai/src/types.ts:6-17
export type KnownApi =
  | "openai-completions"
  | "mistral-conversations"
  | "openai-responses"
  | "azure-openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "bedrock-converse-stream"
  | "google-generative-ai"
  | "google-vertex";

export type Api = KnownApi | (string & {});
```

`Api` 标识的是**底层 HTTP 协议/格式**，而不是商业 provider 名称。例如 `openai-completions` 这个 API 被 OpenAI、DeepSeek、Groq、Cerebras、Together 等十几个 provider 共同使用（它们都实现了 OpenAI 兼容的 chat completions 端点）。`(string & {})` 这个 trick 允许自定义 API 字符串同时保留 IDE 对 `KnownApi` 的类型补全。

### 2.3.2 `KnownProvider`（第 23-55 行）

```typescript
export type KnownProvider =
  | "amazon-bedrock"
  | "anthropic"
  | "google"
  | "openai"
  | "deepseek"
  | "github-copilot"
  | "openrouter"
  // ... 共 24 个
```

`Provider` 标识的是**商业服务**，一个 provider 使用固定的某个 `Api`（通过 `Model.api` 字段绑定）。Provider 的概念主要在认证、定价、模型发现三个地方出现。

**`Api` 与 `Provider` 的区分是这套类型系统最核心的设计决策**：同一个 API 协议可以由多个 provider 实现，这样注册一个 `openai-completions` provider 就能服务十几家厂商，而不是为每家厂商写一遍 HTTP 解析代码。

### 2.3.3 `Model<TApi>`（第 528-558 行）

```typescript
// packages/ai/src/types.ts:528-558
export interface Model<TApi extends Api> {
  id: string;         // provider 的原始 model ID，如 "claude-opus-4-7-20251201"
  name: string;       // 人类可读名称，如 "Claude Opus 4.7"
  api: TApi;          // 绑定的 API 协议
  provider: Provider; // 所属商业 provider
  baseUrl: string;    // API 端点，用于 provider 实现构造请求
  reasoning: boolean; // 是否支持扩展思考
  thinkingLevelMap?: ThinkingLevelMap; // pi thinking level -> provider 特定值
  input: ("text" | "image")[];
  cost: {
    input: number;    // $/百万 token
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>; // provider 专属请求头（如 Copilot 的 Editor-Version）
  compat?: TApi extends "openai-completions" ? OpenAICompletionsCompat : ...;
}
```

`Model` 是模型元数据的完整描述，同时携带了路由信息（`api`、`baseUrl`）和计费信息（`cost`）。`thinkingLevelMap` 是一个映射表，把 pi 的抽象 thinking level（`"low"/"medium"/"high"` 等）翻译为 provider 的具体参数值（token budget 数字、effort 字符串等）。

### 2.3.4 `ThinkingLevel` 与 `ThinkingLevelMap`（第 62-64 行）

```typescript
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
```

`null` 值表示"此 model 不支持该 thinking level"。当 `streamSimple` 收到 `reasoning: "low"` 但 model 的 `thinkingLevelMap["low"] === null` 时，provider 实现会向上或向下找最近的可用 level（`models.ts:61-80` 的 `clampThinkingLevel`）。

### 2.3.5 `StreamOptions`（第 84-145 行）

`StreamOptions` 是所有 provider-specific options interface 的基类，包含 14 个字段。几个非显然的字段：

- `onPayload`（第 109-110 行）：在 payload 发出之前拦截并可选地替换它，用于调试或定制（例如注入自定义字段）。
- `onResponse`（第 113-114 行）：HTTP 响应到达后、body 流消费前的钩子，用于检查响应头（如 rate limit 信息）。
- `cacheRetention`（第 98 行）：`"none" | "short" | "long"`，pi 的抽象缓存保留偏好，各 provider 映射到各自的具体机制。
- `sessionId`（第 104 行）：session 亲和性标识，部分 provider 用它做 prefix cache 路由（如 Fireworks 的 `x-session-affinity` header）。

### 2.3.6 `AssistantMessage`（第 277-290 行）

```typescript
// packages/ai/src/types.ts:277-290
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: Provider;
  model: string;          // 请求时的 model ID
  responseModel?: string; // 实际响应的 model ID（OpenRouter auto 路由时可能不同）
  responseId?: string;    // provider 的 message/response ID（Anthropic: message_id）
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: StopReason; // "stop" | "length" | "toolUse" | "error" | "aborted"
  errorMessage?: string;
  timestamp: number;
}
```

`responseModel` 和 `model` 可能不同——这在使用 OpenRouter `auto` 路由时尤其常见：请求发给 `openrouter/auto`，实际响应来自 `anthropic/claude-opus-4-7`。`diagnostics` 字段记录了 provider 层面的可恢复错误（如 Unicode 代理对修复、工具调用 JSON 修复），不直接抛出，而是附加在消息上供上层记录。

### 2.3.7 `Context`（第 333-337 行）

```typescript
export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
```

这是进入 `stream()` 调用的完整对话状态。`Message` 是 `UserMessage | AssistantMessage | ToolResultMessage` 的联合类型。每个 provider 实现负责把这个标准化的 `Context` 转换成 provider 特定的请求格式。

### 2.3.8 `AssistantMessageEvent`（第 347-359 行）

```typescript
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: ...; message: AssistantMessage }
  | { type: "error"; reason: ...; error: AssistantMessage }
  // ... 共 12 个变体
```

流式事件协议以 `start` 开始，以 `done` 或 `error` 结束。每个事件都携带 `partial: AssistantMessage`——即当前时刻的消息快照——这允许 TUI 在不组装增量的情况下直接渲染当前状态。`toolcall_end` 只有在完整工具调用参数收到后才发出，保证下游不会处理半个 JSON。

---

## 2.4 Provider 注册表机制

### 2.4.1 `apiProviderRegistry` 的数据结构

`packages/ai/src/api-registry.ts:40`：

```typescript
const apiProviderRegistry = new Map<string, RegisteredApiProvider>();
```

这是一个模块级私有 Map，key 是 `api` 字符串（如 `"anthropic-messages"`），value 是包装过的 provider 实现。Map 的选择而非数组，意味着同一个 api 只能有一个注册的实现——后注册的覆盖先注册的。这为扩展提供了覆盖内置 provider 的能力。

`RegisteredApiProvider` 携带一个可选的 `sourceId`（`api-registry.ts:36-38`），用于批量注销某个扩展注册的所有 provider（`unregisterApiProviders(sourceId)`）。

### 2.4.2 注册 API

```typescript
// packages/ai/src/api-registry.ts:66-78
export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
  provider: ApiProvider<TApi, TOptions>,
  sourceId?: string,
): void {
  apiProviderRegistry.set(provider.api, {
    provider: {
      api: provider.api,
      stream: wrapStream(provider.api, provider.stream),
      streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
    },
    sourceId,
  });
}
```

`wrapStream` 和 `wrapStreamSimple` 在每次调用时做一次 `model.api !== api` 的检查（`api-registry.ts:42-52`），确保传入的 model 与注册的 api 匹配，提前捕获编程错误。

### 2.4.3 `register-builtins.ts` 的懒加载注册机制

`packages/ai/src/providers/register-builtins.ts:345-406` 在模块末尾立即调用 `registerBuiltInApiProviders()`：

```typescript
// register-builtins.ts:406
registerBuiltInApiProviders();
```

由于 `stream.ts:1` 静态 import 了 `register-builtins.ts`：

```typescript
// packages/ai/src/stream.ts:1
import "./providers/register-builtins.ts";
```

只要任何代码 import `stream.ts`（或整个 `pi-ai` 包），所有内置 provider 就自动注册。但注册的不是实际的 provider 模块，而是**懒加载包装函数**：

```typescript
// register-builtins.ts:162-180
function createLazyStream<TApi, TOptions, TSimpleOptions>(
  loadModule: () => Promise<LazyProviderModule<TApi, TOptions, TSimpleOptions>>,
): StreamFunction<TApi, TOptions> {
  return (model, context, options) => {
    const outer = new AssistantMessageEventStream();   // 立即返回空流

    loadModule()                                        // 异步加载真正的模块
      .then((module) => {
        const inner = module.stream(model, context, options);
        forwardStream(outer, inner);                   // 把真实事件转发到外层流
      })
      .catch((error) => {
        // 加载失败 -> 向外层流推送 error 事件
        outer.push({ type: "error", reason: "error", error: createLazyLoadErrorMessage(model, error) });
        outer.end(message);
      });

    return outer;  // 调用者立即拿到流对象，可以开始迭代
  };
}
```

这个设计的关键是**调用方立即得到 `AssistantMessageEventStream` 对象**，而模块加载在后台进行。调用者不需要等待 `import()` 完成，也不需要处理 Promise，外层流充当了缓冲区。加载失败时，错误通过流协议（`error` 事件）传递，而不是抛出 Promise rejection，与整体的"不抛出，用流协议传递错误"约定一致（`types.ts:200-210` 中的 `StreamFunction` 合约注释）。

### 2.4.4 为什么 lazy 而不 static import

**体积**：Anthropic SDK（`@anthropic-ai/sdk`）、Google Generative AI SDK 等都有各自的依赖树。static import 会让所有 SDK 在 Node.js 启动时就全部加载，增加几百毫秒冷启动时间。

**tree-shaking**：对于 Bun binary 编译场景（`packages/coding-agent/package.json:34` 的 `build:binary` 脚本），只用到的 provider 模块才会打包进二进制，未使用的 provider 完全剔除。

**扩展可后注册**：`AGENTS.md:161-162` 要求新 provider 在 `register-builtins.ts` 里用懒加载方式注册，而不是静态 import。这意味着第三方扩展也可以用同样的模式后注册自己的 provider（通过 `registerApiProvider`），不需要修改内置代码。

**Bedrock 的特殊处理**（`register-builtins.ts:89-90`）：

```typescript
const importNodeOnlyProvider = (specifier: string): Promise<unknown> => {
  const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
  return import(runtimeSpecifier);
};
```

Bedrock 使用 AWS SDK，不能在浏览器环境运行。`importNodeOnlyProvider` 这个包装函数名字本身就是文档——"仅 Node 环境的 provider"，在构建时可以被 tree-shaking 排除，或在浏览器打包时替换为 no-op。

---

## 2.5 模型注册表

### 2.5.1 `models.generated.ts` 的组织结构

`packages/ai/src/models.generated.ts`（16,405 行）是一个单一的 `MODELS` 对象导出：

```typescript
// models.generated.ts:1-6
// This file is auto-generated by scripts/generate-models.ts
// Do not edit manually - run 'npm run generate-models' to update

export const MODELS = {
  "amazon-bedrock": {
    "amazon.nova-2-lite-v1:0": { ... } satisfies Model<"bedrock-converse-stream">,
    // ...
  },
  "anthropic": { ... },
  "openai": { ... },
  // ... 共 24 个 provider 分组
}
```

结构是 `provider -> modelId -> Model<TApi>` 的两层嵌套对象。每个 model 对象后面跟 `satisfies Model<"...">` 断言——这是 TypeScript 4.9+ 的 `satisfies` 操作符，在保留对象字面量类型的同时验证它满足 `Model` 接口，允许后续代码从具体 model 对象推断 `api` 类型（而不是被类型宽化为 `Model<Api>`）。

### 2.5.2 `generate-models.ts` 的生成流程

`packages/ai/scripts/generate-models.ts` 从多个来源拉取数据：

```
生成流程:

  fetch("https://models.dev/api.json")          -> 亚马逊 Bedrock、部分 Google 模型
  fetch("https://openrouter.ai/api/v1/models")  -> OpenRouter 全量模型列表
  fetch("https://ai-gateway.vercel.sh/v1")      -> Vercel AI Gateway 模型
  fetch("https://api.together.ai/v1/models")    -> Together AI 模型
  [静态定义]                                     -> OpenAI、Anthropic、GitHub Copilot、
                                                    DeepSeek、XAI、Groq、Cerebras 等

        |
        v
  dedupe: 跨来源合并，同一 modelId 的 model 只保留一份
  thinkingLevelMap 注入: applyThinkingLevelMetadata()
        |
        v
  writeFileSync("src/models.generated.ts")
```

去重逻辑（`generate-models.ts:145-147`）：对于需要特殊处理的模型（如 `thinkingLevelMap`），代码通过 `mergeThinkingLevelMap()` 把多个来源的映射信息合并到同一个 model 对象，而不是覆盖。

`applyThinkingLevelMetadata()`（`generate-models.ts:193-244`）是一个大型 if-else 链，处理每个 provider/model 组合的 thinking level 特殊情况：例如 `gemini-3-pro` 不支持 `off`（必须有思考），`mercury-2` 的 `off` 模式禁用工具调用所以标记为 `null`（不可用）。

### 2.5.3 `models.ts` 提供的查询 API

`packages/ai/src/models.ts` 把 `MODELS` 对象包装成一个运行时 Map，提供三个查询函数：

```typescript
// packages/ai/src/models.ts:20-37
export function getModel<TProvider, TModelId>(
  provider: TProvider,
  modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>>
```

`getModel` 的返回类型是 `Model<ModelApi<TProvider, TModelId>>`——TypeScript 会从 `MODELS[provider][modelId].api` 推断出具体的 TApi，使得调用方在编译期就能得到正确类型的 `Model`，不需要类型断言。

```typescript
export function getModels<TProvider>(provider: TProvider): Model<...>[]
export function getProviders(): KnownProvider[]
```

此外 `models.ts` 还提供 `calculateCost()`（`models.ts:39-46`）——根据 `model.cost` 定价和 `usage` 的实际 token 数计算费用——以及 `clampThinkingLevel()`（`models.ts:61-80`）处理 thinking level 降级。

### 2.5.4 为什么 AGENTS.md 禁止手改 `models.generated.ts`

`AGENTS.md:23` 的禁令有三个工程理由：

1. **单向性**：文件完全由脚本生成，手改会在下次 `npm run generate-models` 时被覆盖。
2. **可追溯性**：模型数据的来源（哪个 API、哪个版本）只有脚本知道。手改的数据无法溯源，也无法自动更新。
3. **规模**：16,000 行的手动维护是不现实的，且容易引入不一致（如 thinkingLevelMap 的格式错误）。

正确做法：在 `generate-models.ts` 里修改生成逻辑，然后重跑生成脚本。

---

## 2.6 CLI 工具 `pi-ai`

`packages/ai/src/cli.ts` 是一个独立的 CLI，通过 `npx @earendil-works/pi-ai` 调用，主要用于管理 OAuth 认证：

```
用法:
  npx @earendil-works/pi-ai login [provider]  # OAuth 登录（如 GitHub Copilot）
  npx @earendil-works/pi-ai list              # 列出支持 OAuth 的 provider

支持的 provider 示例:
  github-copilot        GitHub Copilot
  anthropic             Anthropic (beta OAuth)
```

`packages/ai/src/cli.ts:62-80` 的 `main()` 函数解析子命令，调用 `getOAuthProvider()` 和 `provider.login()`。登录结果写入当前目录的 `auth.json`（注意：这是 pi-ai 作为 library 独立使用时的路径，coding-agent 有自己的 `AuthStorage` 写入 `.pi/auth.json`）。

该 CLI 的典型使用场景是在没有 API Key 的环境下（如企业 SSO），通过 OAuth 拿到访问 token。

---

## 2.7 `stream()` 调用的完整路径

从调用 `stream(model, context, options)` 到 provider 实现接收请求的完整路径：

```
调用方
  stream(model, context, options)
    |
    +-- packages/ai/src/stream.ts:25
    |
    v
  resolveApiProvider(model.api)
    |
    +-- packages/ai/src/api-registry.ts:80
    |   apiProviderRegistry.get(model.api)
    |
    v
  ApiProviderInternal.stream(model, context, options)
    |
    +-- api-registry.ts:46 (wrapStream 返回的包装函数)
    |   检查 model.api === 注册的 api
    |
    v
  懒加载包装 (register-builtins.ts:164-180, createLazyStream)
    |
    +-- 创建 AssistantMessageEventStream outer
    |
    +-- [async] loadModule() -> import("./anthropic.ts" 等)
    |     第一次调用才实际加载模块
    |     后续调用复用 modulePromise（||= 赋值）
    |
    v
  真实 provider 实现 (e.g. streamAnthropic)
    |
    +-- 构造 Anthropic API 请求
    +-- 处理 Context -> anthropic.Messages.Param[]
    +-- 发起 HTTP 请求 (via Anthropic SDK 或 undici)
    +-- 解析 SSE 流 -> AssistantMessageEvent
    +-- forwardStream(outer, inner)
          把真实 events 推送到外层 AssistantMessageEventStream
    |
    v
调用方迭代 AssistantMessageEventStream
  for await (const event of stream) { ... }
  或
  const message = await stream.result();
```

路径关键点：

1. **同步返回**：`stream()` 本身是同步的，立即返回 `AssistantMessageEventStream` 对象，不需要 `await`。
2. **懒加载透明**：outer stream 作为缓冲，在模块加载期间调用方可以提前开始迭代（会阻塞等待第一个事件）。
3. **模块缓存**：`anthropicProviderModulePromise ||= import(...)` 确保同一个 provider 模块只加载一次，后续调用直接复用（`register-builtins.ts:209-217`）。
4. **错误路径**：加载失败时通过流协议返回 `error` 事件，`stopReason = "error"`，调用方通过 `message.stopReason` 而非 try/catch 处理错误。

---

## 参考文件速查

| 文件 | 行数 | 核心职责 |
|------|------|---------|
| `packages/ai/src/index.ts` | 46 | 聚合导出，决定公共 API 边界 |
| `packages/ai/src/stream.ts` | 60 | 三个公共流入口 |
| `packages/ai/src/types.ts` | 565 | 所有核心类型定义 |
| `packages/ai/src/api-registry.ts` | 99 | Provider Map、注册/注销 API |
| `packages/ai/src/providers/register-builtins.ts` | 407 | 内置 provider 懒加载注册 |
| `packages/ai/src/models.ts` | 93 | 模型查询 API、成本计算、thinking level 夹紧 |
| `packages/ai/src/models.generated.ts` | 16405 | 全量模型元数据（禁止手改） |
| `packages/ai/scripts/generate-models.ts` | ~700 | 模型数据生成脚本 |
| `packages/ai/src/cli.ts` | ~140 | OAuth 管理 CLI |
