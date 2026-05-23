# 第 06 章 LLM 提供商层与流式

「同一行 `streamText({ model, messages, tools, ... })` 怎么对 Anthropic、OpenAI、Azure、Bedrock、Gemini、DeepSeek、xAI、OpenRouter、Cloudflare AI、Cohere、Mistral、GitHub Copilot、自建 vLLM 全部生效？」——这一章回答这个问题。

opencode 的策略不是「在每个 provider 文件里硬编码 fetch / SSE / 错误码」，而是把任何 LLM 部署分解为四个互相正交的维度：协议（Protocol）、端点（Endpoint）、认证（Auth）、帧分割（Framing），再加可选的 `headers` 与 `defaults`。三十多个 provider 就靠组合这四个件儿拼出来。第 5 章看到的 `LLM.Service` 是 opencode 主包里给会话用的 Effect 包装；本章下沉到独立子包 `packages/llm`（即 `@opencode-ai/llm`），看一次 LLM 调用从「Effect Service」→「LLMRequest」→「provider 原生 body」→「HTTP/SSE」→「LLMEvent」是怎么走完的。

## 6.1 为什么把 packages/llm 拆成独立子包

`packages/llm/src/` 不依赖 `packages/opencode/src/`、不知道 session/agent/permission 的存在，只负责一件事：把统一的 `LLMRequest` 翻成各 provider 的原生请求并执行，把响应翻回统一的 `LLMEvent` 流。这样做的直接收益：

1. **可在 opencode 之外复用** — 任何 Bun/Node 项目可以独立 `import "@opencode-ai/llm"` 当作多 provider SDK 用。
2. **干净的责任边界** — 兼容性 / 限流 / 缓存 / 工具协议归一全在这里；session 循环、permission、agent 编排在外层。Sessoin 层报错的时候，要么是上层 Effect 报错，要么是 LLM 子包扔出来的 `LLMError`，stack trace 一眼看清。
3. **测试容易** — 协议测试用 fixture 直接灌 byte stream 验证 `LLMEvent`，不需要起 session/runner。
4. **可以同时有 ai-sdk 路径和 native 路径** — 这是 opencode 当前的状态（详见 6.3）。

包的外部出口（`packages/llm/src/index.ts:1-36`）只有寥寥几样：

```ts
export { LLMClient } from "./route/client"             // 主入口 Service
export { Auth } from "./route/auth"                    // 认证 DSL
export { Provider } from "./provider"
export * from "./schema"                               // LLMRequest / LLMEvent / Usage / ...
export { Tool, ToolFailure, tool, toDefinitions } from "./tool"
export * as LLM from "./llm"                           // request / stream / generate / generateObject 高阶 API
```

`packages/llm/src/route/index.ts:1-26` 还把更底层的零件暴露给「想自己造 provider」的人：`Route`、`Auth`、`Endpoint`、`Framing`、`Protocol`、`HttpTransport`、`WebSocketExecutor`、`AuthOptions` 等。

## 6.2 Vercel AI SDK 在哪儿，自研的 native 路径又在哪儿

opencode 既在用 AI SDK 又有一个自研路径，这点容易让读者困惑。看一眼 `packages/opencode/src/session/llm.ts:218-340`：

```ts
// Runtime seam: native is an opt-in adapter over @opencode-ai/llm.
if (flags.experimentalNativeLlm) {
  const native = LLMNativeRuntime.stream({ model, provider, auth, llmClient, ... })
  if (native.type === "supported") {
    return { type: "native" as const, stream: native.stream }
  }
  // 回落到 AI SDK
}

// Default runtime path: AI SDK owns provider execution and tool dispatch
return {
  type: "ai-sdk" as const,
  result: streamText({
    model: wrapLanguageModel({ model: language, middleware: [{...}] }),
    tools: prepared.tools,
    abortSignal, headers, messages, ...
  }),
}
```

| 路径 | 触发条件 | 谁负责 HTTP | 谁负责工具执行 | 适配回 LLMEvent |
|---|---|---|---|---|
| **ai-sdk（默认）** | 任何时候没有开 `OPENCODE_EXPERIMENTAL_NATIVE_LLM` | AI SDK + `@ai-sdk/anthropic` / `@ai-sdk/openai` / ... | AI SDK（`streamText` 内部自动 dispatch `tool.execute`） | `packages/opencode/src/session/llm/ai-sdk.ts:61-251` 的 `toLLMEvents` |
| **native（实验性）** | `experimentalNativeLlm=true` 且 provider 是 openai/opencode/anthropic 且 npm 是 `@ai-sdk/openai` / `@ai-sdk/openai-compatible` / `@ai-sdk/anthropic` 且 API key 在 | `@opencode-ai/llm` 的 `LLMClient.stream` | 仍然由 opencode 的 SessionTools 包装，但 tool 注册时通过 `nativeTool({ jsonSchema, execute })` 装回 LLM 子包，由 `ToolRuntime.stream` dispatch | LLMClient 直接吐 `LLMEvent`，不需要 adapter |

**两条路径对外的事件类型是一致的**（都是 `LLMEvent`）。AI SDK 路径走 `LLMAISDK.toLLMEvents` 把 AI SDK 的 `text-delta` / `tool-call` 翻成 `LLMEvent.textDelta` / `LLMEvent.toolCall`（见第 5 章 5.6 节）；native 路径直接从 LLMClient 拿到 `Stream<LLMEvent>`。

opencode "薄薄包了 AI SDK 一层"的部分：

- 中间件：`wrapLanguageModel({ model, middleware: [{ specificationVersion: "v3", transformParams }] })`（`session/llm.ts:311-329`）允许在 AI SDK 把请求发出去前，最后改一遍 `params.prompt`（`ProviderTransform.message` 会做 sanitize surrogate、role 折叠、image modality 过滤）。
- `experimental_repairToolCall`（`session/llm.ts:278-298`）：模型瞎传一个大写工具名 `Read`，opencode 把它修成 `read`；模型给出的 args 解析失败，rewrite 成 `tool: "invalid"`。
- `experimental_telemetry`：把整个 streamText 串入 OpenTelemetry tracer 并加上 `session.id` attribute。

GitLab Workflow 模型（`gitlab-ai-provider`）是个例外，它走 WebSocket 不是 HTTP，opencode 给它特殊路径：手动绑 `toolExecutor` 让模型在 WebSocket 协议里发出的工具调用通过 opencode 工具系统反执行（`session/llm.ts:118-200`）。

下文重点讲 native 路径（`@opencode-ai/llm`），因为：(a) 它代表 opencode 团队对"理想形态"的判断；(b) ai-sdk 路径里大部分协议适配本来就是 AI SDK 提供的，没什么独特结构。

## 6.3 Route：四件套加 defaults

`packages/llm/src/route/client.ts:38-55` 定义 `Route`：

```ts
export interface Route<Body, Prepared = unknown> {
  readonly id: string                  // 比如 "anthropic-messages"
  readonly provider?: ProviderID       // 比如 "anthropic"
  readonly protocol: ProtocolID
  readonly endpoint: Endpoint<Body>
  readonly auth: AuthDef
  readonly transport: Transport<Body, Prepared, unknown>
  readonly defaults: RouteDefaults
  readonly body: RouteBody<Body>
  readonly with: (patch: RoutePatch<Body, Prepared>) => Route<Body, Prepared>
  readonly model: (input: RouteMappedModelInput) => Model
  readonly prepareTransport: (body: Body, request: LLMRequest) => Effect.Effect<Prepared, LLMError>
  readonly streamPrepared: (prepared, request, runtime) => Stream<LLMEvent, LLMError>
}
```

Route 是 provider 暴露给上层的「即插即用」单元：拿到一个 `Route`，加上一个 model id，调 `route.model({ id })` 就得到一个能直接喂给 `LLMClient.stream` 的 `Model`。`route.with(patch)` 是一切配置（baseURL、headers、apiKey、超时、generation 默认值）的统一入口，patch 内含可覆盖的子集：

```ts
export interface RoutePatch<Body, Prepared> extends RouteDefaultsInput {
  readonly id?: string
  readonly provider?: string | ProviderID
  readonly auth?: AuthDef
  readonly transport?: Transport<Body, Prepared, unknown>
  readonly endpoint?: EndpointPatch<Body>
}
```

`Route.make`（`route/client.ts:318-336`）的两种重载：

```ts
// 简便版：协议 + 端点 + Framing + 可选 auth/headers/defaults → 自动用 HttpTransport.httpJson({ framing })
make<Body, Frame, Event, State>(input: MakeInput<Body, Frame, Event, State>): Route<Body, HttpPrepared<Frame>>

// 高级版：协议 + 端点 + 自定义 transport（WebSocket / 自定义 HTTP）
make<Body, Prepared, Frame, Event, State>(input: MakeTransportInput<...>): Route<Body, Prepared>
```

定义一个新 provider 协议的最小例子（参看 `protocols/anthropic-messages.ts` 末尾）：

```ts
export const route = Route.make({
  id: "anthropic-messages",
  provider: "anthropic",
  protocol,                              // 自己实现的 Protocol<Body, Frame, Event, State>
  endpoint: { baseURL: "https://api.anthropic.com/v1", path: "/messages" },
  framing: Framing.sse,
  headers: ({ request }) => ({ "anthropic-version": "2023-06-01", ... }),
  defaults: { /* generation / providerOptions / http / headers */ },
})
```

`Route.make` 会把 `protocol.body.from` 与 `protocol.body.schema` 嵌进 `RouteBody`、把 `protocol.stream.event/initial/step/onHalt/terminal` 嵌进 `streamPrepared` 的 mapAccum 状态机（`route/client.ts:276-292`）。

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Route.make composes protocol endpoint framing auth defaults into a unified stream pipeline">
  <defs>
    <marker id="ar61" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="270" y="14" width="220" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="36" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Route.make(input)</text>
  <path d="M380,50 L80,82" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  <path d="M380,50 L210,82" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  <path d="M380,50 L380,82" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  <path d="M380,50 L550,82" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  <path d="M380,50 L680,82" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  <rect x="20" y="84" width="120" height="74" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="80" y="103" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">protocol</text>
  <text x="80" y="121" text-anchor="middle" font-size="10" fill="currentColor">body.from</text>
  <text x="80" y="135" text-anchor="middle" font-size="10" fill="currentColor">body.schema</text>
  <text x="80" y="151" text-anchor="middle" font-size="10" fill="#64748b">stream.step</text>
  <rect x="148" y="84" width="124" height="74" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="210" y="103" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">endpoint</text>
  <text x="210" y="121" text-anchor="middle" font-size="10" fill="currentColor">baseURL</text>
  <text x="210" y="135" text-anchor="middle" font-size="10" fill="currentColor">path / query</text>
  <rect x="316" y="84" width="128" height="74" rx="6" fill="#fff" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="380" y="103" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">framing</text>
  <text x="380" y="121" text-anchor="middle" font-size="10" fill="currentColor">bytes → frames</text>
  <text x="380" y="135" text-anchor="middle" font-size="10" fill="#64748b">SSE / binary</text>
  <rect x="488" y="84" width="124" height="74" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="550" y="103" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">auth</text>
  <text x="550" y="121" text-anchor="middle" font-size="10" fill="currentColor">Credential</text>
  <text x="550" y="135" text-anchor="middle" font-size="10" fill="currentColor">apply() → headers</text>
  <rect x="620" y="84" width="120" height="74" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="680" y="103" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">defaults</text>
  <text x="680" y="121" text-anchor="middle" font-size="10" fill="currentColor">headers</text>
  <text x="680" y="135" text-anchor="middle" font-size="10" fill="currentColor">limits / gen</text>
  <path d="M380,162 L380,188" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  <rect x="80" y="190" width="600" height="48" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="208" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Route.body.from → schema → encodeBody → HTTP 请求</text>
  <text x="380" y="226" text-anchor="middle" font-size="10" fill="#64748b">request.body 候选体 → JSON → method/url/headers/body 固化</text>
  <path d="M380,238 L380,262" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  <rect x="80" y="264" width="600" height="48" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="380" y="282" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">framing → frame stream → protocol.stream.event 解码</text>
  <text x="380" y="300" text-anchor="middle" font-size="10" fill="#64748b">每帧 Schema.decode → step(state, event) 推进状态机</text>
  <path d="M380,312 L380,334" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  <rect x="220" y="336" width="320" height="20" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="351" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Stream&lt;LLMEvent&gt;</text>
</svg>
<span class="figure-caption">图 R6.1 ｜ Route.make 把五件套（protocol、endpoint、framing、auth、defaults）正交地组合，最终把字节流推进为统一的 LLMEvent 流。</span>

<details>
<summary>ASCII 原版</summary>

```text
                  Route.make(input)
                       │
       ┌───────────────┼───────────────┬─────────────┬──────────────┐
       │               │               │             │              │
   protocol         endpoint        framing         auth        defaults
       │               │               │             │              │
    body.from      baseURL/path     bytes→frames   apply()    headers/limits/...
    body.schema      ↓                   ↓             │
       │               │                              │
       └─→ Route.body.from → Route.body.schema → encodeBody → HTTP → frame stream
                                  → protocol.stream.event 解码
                                  → protocol.stream.step 翻 LLMEvent
                                  → Stream<LLMEvent>
```

</details>

## 6.4 Protocol：API 形状

`Protocol<Body, Frame, Event, State>`（`route/protocol.ts:36-43`）只描述「这个 API 长什么样」，不知 URL/auth/header：

```ts
export interface Protocol<Body, Frame, Event, State> {
  readonly id: ProtocolID
  readonly body: ProtocolBody<Body>           // schema + from(LLMRequest) → Body
  readonly stream: ProtocolStream<Frame, Event, State>
}

export interface ProtocolStream<Frame, Event, State> {
  readonly event: Schema.Codec<Event, Frame>  // 一帧 → 一个语义 Event
  readonly initial: () => State
  readonly step: (state, event) => Effect<[State, ReadonlyArray<LLMEvent>], LLMError>
  readonly terminal?: (event) => boolean       // SSE 看到此事件就关
  readonly onHalt?: (state) => ReadonlyArray<LLMEvent>  // 收尾刷盘
}
```

仓库里现存的协议（`packages/llm/src/protocols/`）：

| 协议 id | 文件 | 行数 | 用途 |
|---|---|---|---|
| `anthropic-messages` | `protocols/anthropic-messages.ts` | 767 | Anthropic Messages API + content blocks（含 thinking/server-tool-use） |
| `openai-chat` | `protocols/openai-chat.ts` | 410 | OpenAI Chat Completions（兼容 DeepSeek/xAI/Groq/Together/Cerebras 等） |
| `openai-compatible-chat` | `protocols/openai-compatible-chat.ts` | 24 | openai-chat 的 alias，纯标记 |
| `openai-responses` | `protocols/openai-responses.ts` | 759 | OpenAI Responses API（GPT-5 流式优先） |
| `gemini` | `protocols/gemini.ts` | 417 | Google generateContent SSE |
| `bedrock-converse` | `protocols/bedrock-converse.ts` | 616 | AWS Bedrock Converse |
| `bedrock-event-stream` | `protocols/bedrock-event-stream.ts` | 87 | AWS Bedrock 的二进制事件流 framing（仅 framing，不是 Protocol） |
| `shared.ts` | 244 | 公共工具：sseFraming、JsonObject、optionalArray、validateWith、encodeJson、eventError |

每个 Protocol 的核心是两件事：

**Body 一侧：`body.from(request: LLMRequest): Body`**。`anthropic-messages` 要拼 `{model, system: AnthropicSystemBlock[], messages: AnthropicAssistantBlock | AnthropicUserBlock[], tools: AnthropicToolDef[], tool_choice, max_tokens, ...}`；`openai-chat` 要拼 `{model, messages: [{role:"system"|"user"|"assistant"|"tool", content, tool_calls?, ...}], tools: [{type:"function", function:{...}}], tool_choice, stream:true, stream_options}`。两个 protocol 的 from 都从同一个 `LLMRequest` 取材，但展开为完全不同的 shape。

**Stream 一侧：`stream.event` + `stream.step`**。SSE 一帧（`data: {...}` 的 JSON 字符串）通过 `Schema.fromJsonString(eventSchema)` 解码为一个语义事件（比如 Anthropic 的 `{type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" }}`），然后 `step(state, event)` 翻成 0 个或多个 `LLMEvent`（比如 `[LLMEvent.textDelta({...})]`），同时把 `state` 推进（记录当前 block 是哪种类型、当前 tool input 累积到哪儿等）。

抽象的好处：DeepSeek/Together/Cerebras 之类一律走 `openai-chat` 协议，不需要每个 provider 重写一遍 SSE 解码。

## 6.5 Endpoint：URL 在哪里

`route/endpoint.ts:22-26`：

```ts
export interface Endpoint<Body> {
  readonly baseURL?: string
  readonly path: EndpointPart<Body>           // string 或 (input) => string
  readonly query?: Record<string, string>
}
```

`path` 之所以可以是函数，是为了支持 URL 里嵌请求体字段的 provider：Bedrock 是 `/model/{model}/invoke`、Gemini 是 `/v1beta/models/{model}:streamGenerateContent`。`Endpoint.render`（`endpoint.ts:47-51`）做最终拼接：

```ts
export const render = <Body>(endpoint: Endpoint<Body>, input: EndpointInput<Body>) => {
  const url = new URL(`${trimBaseUrl(endpoint.baseURL ?? "")}${renderPart(endpoint.path, input)}`)
  for (const [key, value] of Object.entries(endpoint.query ?? {})) url.searchParams.set(key, value)
  return url
}
```

## 6.6 Auth：声明式凭据 DSL

`route/auth.ts:25-103` 不是简单地存 API key，而是一组可组合的 `Credential` / `Auth`：

```ts
const auth = (options: ProviderAuthOption<"optional">) => {
  if ("auth" in options && options.auth) return options.auth
  return Auth.optional(options.apiKey, "apiKey")    // 第一个尝试: 用户传的 apiKey
    .orElse(Auth.config("ANTHROPIC_API_KEY"))       // 第二个尝试: 环境变量
    .pipe(Auth.header("x-api-key"))                 // 最后拼成 header
}
```

抽象上：

- `Credential` 是「一个可能失败的 redacted secret」；`load: Effect<Redacted, CredentialError>`。`Credential.orElse(other)` 是 fallback。
- `Auth` 是「给一份 AuthInput（请求方法/url/body/headers），返回新 headers」；`.andThen` 链式叠加、`.orElse` 替代回退。
- `Auth.none` 不动 headers；`Auth.bearer(secret)` 拼 `Authorization: Bearer ...`；`Auth.header(name, secret)` 拼任意 header；`Auth.bearerHeader(name, secret)` 拼非标准 `X-Foo: Bearer ...`。
- `Auth.custom(apply)` 是逃生口：写自定义 AWS SigV4 之类的，直接 plug 进 `apply: AuthInput → Effect<Headers, LLMError>`。

凭据失败会被 `toLLMError` 归一（`auth.ts:137-149`）成 `LLMError.Authentication` 或 `LLMError.InvalidRequest`，不会泄漏底层 Config error。`auth-options.ts` 进一步提供 `AuthOptions.bearer(opts, envVar)` 这类高阶组合，让每个 provider 文件保持十几行。

## 6.7 Framing：字节流到帧

`route/framing.ts:19-25`：

```ts
export interface Framing<Frame> {
  readonly id: string
  readonly frame: (bytes: Stream<Uint8Array, LLMError>) => Stream<Frame, LLMError>
}

export const sse: Framing<string> = { id: "sse", frame: ProviderShared.sseFraming }
```

SSE 是 95% 的 HTTP LLM provider 用的格式（`data: <json>\n\n` 一行行），`sseFraming`（在 `protocols/shared.ts` 里）做：UTF-8 解码 → 按行切分 → 拼接 multiline event → drop keep-alive / `[DONE]` → emit `data:` 后面的 JSON 字符串。Bedrock 的二进制 event stream 用另一份 framing（`protocols/bedrock-event-stream.ts:87`），AWS 用 1+12 字节头、CRC32 校验、可变 payload 的二进制帧。

Framing 的 `Frame` 是不透明的（string for SSE，object for binary），下游用 `protocol.stream.event: Schema.Codec<Event, Frame>` 解码。

## 6.8 Transport：去发请求

`route/client.ts:38-55` 里 `Route.transport` 是真正发请求的组件。两个内置实现：

- **HttpTransport.httpJson({ framing })**（`route/transport/http.ts`）：拼 URL、走 `RequestExecutor.execute(HttpClientRequest)`、把响应 body 喂给 framing。`RequestExecutor` 见下节。
- **WebSocketExecutor / WebSocketTransport**：用于 OpenAI Responses 的 WebSocket 路径（`OpenAIResponses.webSocketRoute`），双向通信、自动重连。layer 可选，没注入时 LLMClient 直接当不存在。

`Transport` 通过 `prepare(body, request, endpoint, auth, encodeBody, headers)` 把所有材料拼成 `Prepared`（一个把 method / url / headers / body 全部固化好的轻对象），再 `frames(prepared, request, runtime)` 真正打开 socket 流回字节。LLMClient 的 streamPrepared 在拿到字节流后 `framing → decodeEventEffect → protocol.stream.step` 完成翻译。

## 6.9 RequestExecutor：HTTP 重试、redact、错误归一

`packages/llm/src/route/executor.ts:1-374` 是 HTTP 客户端那层最重要的组件。关键设计：

```ts
const SENSITIVE_NAME = /authorization|api[-_]?key|access[-_]?token|...|signature|x-amz-signature/i
const SHORT_QUERY_NAME = /^(key|sig)$/i
const SENSITIVE_BODY_FIELD = /authorization|api[-_]?key|.../i
```

任何错误日志、追踪、HttpContext 里看到敏感字段都会自动 redact（包括 URL query、headers、body 字段）。`redactJsonField` / `redactQueryField` 是正则替换：把 `"api_key":"sk-..."` 中的 `"sk-..."` 换成 `"<redacted>"`。

退避（`executor.ts:90-100`，下面只是片段）：

```ts
const retryableStatus = (status) => status === 429 || status === 503 || status === 504 || status === 529
const retryAfterMs = (headers) => {
  const millis = Number(headers["retry-after-ms"])
  if (Number.isFinite(millis)) return Math.max(0, millis)
  const value = headers["retry-after"]
  if (Number.isFinite(Number(value))) return Math.max(0, Number(value) * 1000)
  // 否则尝试 HTTP-date 解析
}
const MAX_RETRIES = 2
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 10_000
```

executor 内部至多重试两次，但 session 层还有更外面一层重试（第 5 章 5.7 节的 `SessionRetry.policy`），两者目的不同：executor 是「网络抖动 / 短时限流」，session 是「业务级限流 / 5xx / GoUsageLimit 升级提示」。

错误归一（`executor.ts` 后半）：把 fetch 抛出的 timeout/abort/dns/connection-refused 等归一为 `TransportReason`；把 4xx/5xx 按 status code 归一为 `RateLimitReason` / `QuotaExceededReason` / `AuthenticationReason` / `ProviderInternalReason` / `InvalidRequestReason` / `UnknownProviderReason`（都在 `schema/errors.ts` 里）。每个 reason 都带 `retryable: boolean` 静态属性（`schema/errors.ts:30-100`），调用方 `if (reason.retryable) ...` 决定。

## 6.10 Schema：内部规范化格式

`packages/llm/src/schema/` 是整个子包的核心数据结构。所有 provider 的输入输出在这一层统一，上层不需要关心 Anthropic 的 content blocks 和 OpenAI 的 messages array 谁是谁。

主要文件：

| 文件 | 行数 | 内容 |
|---|---|---|
| `ids.ts` | 43 | `ContentBlockID`, `FinishReason`, `ProtocolID`, `ProviderMetadata`, `RouteID`, `ToolCallID`, `MessageRole` |
| `messages.ts` | 269 | `Message`, `TextPart`, `MediaPart`, `ToolCallPart`, `ToolResultPart`, `ToolResultValue`, `LLMRequest`, `ToolDefinition` |
| `events.ts` | 364 | `Usage`, `LLMEvent`（`step-start`/`text-*`/`reasoning-*`/`tool-*`/`step-finish`/`finish`/`provider-error`） |
| `options.ts` | 221 | `GenerationOptions`, `HttpOptions`, `ProviderOptions`, `CacheHint`, `CachePolicy`, `ModelLimits`, `Model` |
| `errors.ts` | 203 | `LLMError`、各 `*Reason` 子类、`HttpContext` |

`LLMRequest` 是这个子包的「上层入参」：

```ts
new LLMRequest({
  id?: string,
  model: Model,                    // 含 ProviderID + ModelID + route
  system: ReadonlyArray<SystemPart>,
  messages: ReadonlyArray<Message>,
  tools: ReadonlyArray<ToolDefinition>,
  toolChoice?: ToolChoice,
  generation?: GenerationOptions,  // temperature/topP/topK/maxOutputTokens/stop/seed
  providerOptions?: ProviderOptions,
  http?: HttpOptions,              // headers/timeout/abortSignal
  cache?: CachePolicy,             // "auto" | "none" | { tools, system, messages, ttlSeconds }
})
```

`LLM.request({ ... })`（`llm.ts:55-77`）是高阶友好版：

```ts
export const request = (input: RequestInput) => {
  const { system: requestSystem, prompt, messages, tools, toolChoice, generation, providerOptions, http, ...rest } = input
  return new LLMRequest({
    ...rest,
    system: SystemPart.content(requestSystem),                  // string | SystemPart | SystemPart[] → SystemPart[]
    messages: [...(messages?.map(Message.make) ?? []),
               ...(prompt === undefined ? [] : [Message.user(prompt)])],
    tools: tools?.map(ToolDefinition.make) ?? [],
    toolChoice: requestToolChoice ? ToolChoice.make(requestToolChoice) : undefined,
    generation: requestGeneration ? GenerationOptions.make(requestGeneration) : undefined,
    providerOptions,
    http: requestHttp ? HttpOptions.make(requestHttp) : undefined,
  })
}
```

`LLMEvent`（`events.ts:206-280`）是 stream 的统一帧。第 5 章已经讲过它的 16 种 type；它的「构造器」全部是 `LLMEvent.textDelta(...)` 这种 camelCase 静态函数，由 `Schema.toTaggedUnion` 自动生成 `guards`，再 mapped 到 `is.textDelta` 这种 camelCase 谓词。

```ts
// 示例：anthropic-messages.ts 内部解码到的事件，最终翻成 LLMEvent
case "content_block_start" when content_block.type === "text":
  return [state.next, [LLMEvent.textStart({ id: blockID })]]
case "content_block_delta" when delta.type === "text_delta":
  return [state.next, [LLMEvent.textDelta({ id: blockID, text: delta.text })]]
case "content_block_start" when content_block.type === "tool_use":
  return [state.next, [LLMEvent.toolInputStart({ id: tool_use.id, name: tool_use.name })]]
```

## 6.11 流式解码全景

把上面所有零件拼起来，一次 `LLMClient.stream(request)` 的全路径：

<svg viewBox="0 0 760 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Full streaming pipeline from LLMRequest compile to Stream of LLMEvent">
  <defs>
    <marker id="ar62" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="260" y="14" width="240" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="36" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">streamRequest(request)</text>
  <path d="M380,50 L380,72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <rect x="80" y="74" width="600" height="156" rx="8" fill="#ddd6fe" fill-opacity="0.35" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="94" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">compile(request)  ｜  route/client.ts:341-356</text>
  <rect x="100" y="104" width="560" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="119" font-size="10.5" fill="currentColor">① resolveRequestOptions  合并 route.defaults + request 局部</text>
  <rect x="100" y="128" width="560" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="143" font-size="10.5" fill="currentColor">② applyCachePolicy  注入 Anthropic CacheHint（6.12）</text>
  <rect x="100" y="152" width="560" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="167" font-size="10.5" fill="currentColor">③ route.body.from(request) → decodeUnknownEffect(Body schema)</text>
  <rect x="100" y="176" width="560" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="191" font-size="10.5" fill="currentColor">④ prepareTransport: Endpoint.render → encodeBody → auth.apply → headers</text>
  <rect x="100" y="200" width="560" height="22" rx="3" fill="#99f6e4" stroke="#0d9488"/>
  <text x="380" y="215" text-anchor="middle" font-size="10.5" fill="currentColor">Prepared { method, url, headers, body }</text>
  <path d="M380,230 L380,254" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <rect x="80" y="256" width="600" height="174" rx="8" fill="#fed7aa" fill-opacity="0.35" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="276" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">route.streamPrepared(prepared, request, runtime)</text>
  <rect x="100" y="286" width="560" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="301" font-size="10.5" fill="currentColor">⑤ runtime.http.execute(HttpClientRequest) → fetch → bytes Stream</text>
  <rect x="100" y="310" width="560" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="325" font-size="10.5" fill="currentColor">⑥ framing.frame(bytes) → string frame (SSE) 或 binary frame</text>
  <rect x="100" y="334" width="560" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="349" font-size="10.5" fill="currentColor">⑦ decodeEvent(frame) ← Schema.decodeUnknownEffect(stream.event)</text>
  <rect x="100" y="358" width="560" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="373" font-size="10.5" fill="currentColor">⑧ stream.step(state, event) → [state', LLMEvent[]] （mapAccumEffect）</text>
  <rect x="100" y="382" width="560" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="397" font-size="10.5" fill="currentColor">⑨ stream.terminal? takeUntil ｜ onHalt 收尾</text>
  <rect x="100" y="406" width="560" height="20" rx="3" fill="#fff" stroke="#dc2626"/>
  <text x="380" y="420" text-anchor="middle" font-size="10.5" fill="currentColor">Stream.catchCause → 所有 cause 归一为 LLMError</text>
  <path d="M380,430 L380,454" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <rect x="220" y="456" width="320" height="38" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="480" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Stream&lt;LLMEvent, LLMError&gt;</text>
</svg>
<span class="figure-caption">图 R6.2 ｜ LLMClient.stream 的完整管线：compile 段把请求固化为 Prepared，streamPrepared 段把字节流喂给 framing → decode → step 的纯函数式状态机。</span>

<details>
<summary>ASCII 原版</summary>

```text
streamRequest(request)
    │
    │   compile(request)             route/client.ts:341-356
    │     resolveRequestOptions      合并 route.defaults + request 局部
    │     applyCachePolicy           注入 CacheHint (见 6.12)
    │     route.body.from(request)   provider 原生 body 候选
    │     decodeUnknownEffect(body)  → Body schema 校验
    │     route.prepareTransport(body, request)
    │       Endpoint.render(...)     拼 URL
    │       encodeBody → JSON string
    │       auth.apply(...)          → 加 header
    │       headers(...)             → 静态 + 动态 header 合并
    │     → Prepared { method, url, headers, body }
    │
    │   route.streamPrepared(prepared, request, runtime)
    │     runtime.http.execute(HttpClientRequest)
    │       fetch → SSE bytes Stream
    │     framing.frame(bytes)       byte → string frame (SSE) or binary frame
    │     decodeEvent(frame)         Schema.decodeUnknownEffect(protocol.stream.event)
    │     stream.terminal? takeUntil
    │     stream.step(state, event)  → [state', LLMEvent[]]
    │       mapAccumEffect 累积
    │     stream.onHalt 收尾
    │
    │   Stream.catchCause(streamError) 把任何 cause 归一为 LLMError
    │
    ▼
Stream<LLMEvent, LLMError>
```

</details>

值得读两遍的是 `streamPrepared` 用 `Stream.mapAccumEffect` 把 `decode → step` 串成纯函数式状态机：每帧解码 → step 拿当前 state 算新 state 与若干输出事件 → 串到下游。整个解码路径没有可变全局、没有 callback；解码错误自动转成 stream failure。

## 6.12 Cache policy：Anthropic prompt caching

`packages/llm/src/cache-policy.ts:99-111`：

```ts
export const applyCachePolicy = (request: LLMRequest): LLMRequest => {
  if (!RESPECTS_INLINE_HINTS.has(request.model.route.id)) return request  // 只 anthropic-messages / bedrock-converse 接 inline hint
  const policy = resolve(request.cache)
  if (!policy.tools && !policy.system && !policy.messages) return request

  const hint = makeHint(policy.ttlSeconds)
  const tools = policy.tools ? markLastTool(request.tools, hint) : request.tools
  const system = policy.system ? markLastSystem(request.system, hint) : request.system
  const messages = policy.messages ? markMessages(request.messages, policy.messages, hint) : request.messages

  if (tools === request.tools && system === request.system && messages === request.messages) return request
  return LLMRequest.update(request, { tools, system, messages })
}
```

默认 policy（`cache-policy.ts:18-37`）：

```ts
const AUTO: CachePolicyObject = {
  tools: true,
  system: true,
  messages: "latest-user-message",
}
```

注释里直接解释了「为什么 auto 是这套配方」：Anthropic 5m-cache write 1.25× 基价、read 0.1×，一个 turn 里反复工具调用，把最新用户消息打 cache 标记，所有 intra-turn 调用都能命中 prefix。这就是为什么 opencode 默认 cache 开着。

实现的关键细节：

- `markLastTool`：在最后一个 `ToolDefinition` 上塞 `cache: CacheHint`。模型从 system → tools → messages 的 prefix 顺序看 cache，只要最后一个 tool 上有 hint，前面所有 tool 自动同 cache 段。
- `markMessageAt`：从目标 message 的 content 里找 `findLastIndex(part.type === "text")`，把 hint 塞到那个 text part 上；没有 text part 就塞到最后一个 part 上。要注意 manual 标记不会被覆盖：`if ("cache" in existing && existing.cache) return messages`。
- `RESPECTS_INLINE_HINTS = new Set(["anthropic-messages", "bedrock-converse"])` — OpenAI 的隐式 prefix caching 和 Gemini 的 out-of-band CachedContent 都不需要 inline marker，policy pass 跳过。

命中率统计走 `Usage.cacheReadInputTokens` 与 `Usage.cacheWriteInputTokens`，由 `Usage` schema（`schema/events.ts:50-72`）建立非重叠的分解口径，下游计费在 `packages/opencode/src/session/session.ts:378-443` 的 `getUsage` 里用 model.cost.cache.read/write 计入 cost。

## 6.13 Tool runtime：模型工具协议的归一

`packages/llm/src/tool-runtime.ts` 是 native 路径里的工具循环。回顾对外的 `LLMClient.stream` 签名（`route/client.ts:159-167`）：

```ts
export interface StreamMethod {
  (request: LLMRequest): Stream<LLMEvent, LLMError>
  <T extends Tools>(options: ToolRuntime.RunOptions<T>): Stream<LLMEvent, LLMError>
}
```

两种用法：

```ts
// 只是发请求，工具结果给调用方自己 dispatch
const events = LLMClient.stream(request)

// 把工具 + dispatch 也交出去
const events = LLMClient.stream({
  request,
  tools: { read: readTool, edit: editTool, ... },
  toolExecution: "auto",                  // "none" 则只通告 schema 不执行
  stopWhen: ToolRuntime.stepCountIs(10),  // 步数上限
  concurrency: 10,                        // 并发执行 tool
})
```

实现（`tool-runtime.ts:65-200`）非常直白的一个 `loop(request, step, usage, providerMetadata)` 递归 stream：

```text
loop(request, step):
  state = { assistantContent: [], toolCalls: [], finishReason, usage, providerMetadata }
  events = options.stream(request)
    .map(indexStep with step)
    .tap(accumulate into state)
    .filter(e => e.type !== "finish")    // finish 在 continuation 里发

  yield events

  continuation =
    if state.finishReason !== "tool-calls" || toolCalls.length === 0 || toolExecution === "none":
      emit LLMEvent.finish(state.finishReason, totalUsage)
    else:
      dispatched = forEach(toolCalls) { call → dispatch(tools, call) }
      build resultStream of LLMEvent.toolResult / toolError
      nextRequest = request + assistant + tool-results
      yield resultStream
      if stopWhen(state) → emit finish, end
      else recurse loop(nextRequest, step+1)

  return merge(events, continuation)
```

`stopWhen` 默认是 `stepCountIs(Infinity)`（即不停），用户调 `LLM.stepCountIs(10)` 把它限到 10。这里和第 5 章里 SessionPrompt.runLoop 的 maxSteps 是两个不同层级的限制，本子包内的是「单个 LLMClient.stream 内部」的循环。

opencode 主包里通常 ai-sdk 路径不会到这层，因为 `streamText` 自己已经做了类似的事。native 路径下，session/llm 里 `LLMNativeRuntime.nativeTools` 把 AI SDK Tool 包成 `nativeTool({ jsonSchema, execute })`（`session/llm/native-runtime.ts:117-141`），传给 `LLMClient.stream`，ToolRuntime 负责调度。

## 6.14 模型层工具协议的归一

模型那一侧的 tool 协议每个 provider 都不同：

| Provider | Tool 调用部分长这样（请求 body） | Tool 结果回灌长这样 |
|---|---|---|
| Anthropic | `{role:"assistant", content:[{type:"tool_use", id, name, input}]}` | `{role:"user", content:[{type:"tool_result", tool_use_id, content}]}` |
| OpenAI Chat | `{role:"assistant", tool_calls:[{id, type:"function", function:{name, arguments}}]}` | `{role:"tool", tool_call_id, content}` |
| OpenAI Responses | `{type:"function_call", call_id, name, arguments}` / `{type:"function_call_output", call_id, output}` | 同左 |
| Gemini | `{role:"model", parts:[{functionCall:{name, args}}]}` | `{role:"user", parts:[{functionResponse:{name, response}}]}` |

Protocol 把这套差异在 `body.from` 里编码、在 `stream.step` 里解码。统一后的 `LLMEvent.toolCall` / `LLMEvent.toolResult` 在 LLMEvent 视角下毫无差异：

```ts
LLMEvent.toolCall({ id, name, input, providerExecuted?, providerMetadata? })
LLMEvent.toolResult({ id, name, result: ToolResultValue, providerExecuted?, providerMetadata? })
```

`ToolResultValue`（`schema/messages.ts:59-87`）是 union：

```ts
{ type: "json",  value: unknown }            // 任意可序列化 JSON
{ type: "text",  value: unknown }            // 通常是 string
{ type: "error", value: unknown }            // 工具失败
{ type: "content", value: ToolResultContentPart[] }  // 多模态结果（text + media）
```

`providerExecuted: true` 表示这个工具是 provider 自己执行的（例如 Anthropic 的 server_tool_use：web_search、code_execution、web_fetch），不需要 opencode 反执行。在 session processor 里这个标志被记到 ToolPart.metadata.providerExecuted，runLoop 终止判定时显式跳过这种 tool：

```ts
// prompt.ts:1263-1265
const hasToolCalls =
  lastAssistantMsg?.parts.some((part) => part.type === "tool" && !part.metadata?.providerExecuted) ?? false
```

## 6.15 错误分类的两层视图

LLM 子包的错误模型（`schema/errors.ts:1-203`）以 `LLMError` 为壳，里面带一个 `reason: Reason`，Reason 是 tagged union：

```text
LLMError.reason
  ├── InvalidRequest          retryable=false
  ├── NoRoute                 retryable=false
  ├── Authentication          retryable=false        kind: missing/invalid/expired/...
  ├── RateLimit               retryable=true         retryAfterMs?
  ├── QuotaExceeded           retryable=false
  ├── ContentPolicy           retryable=false
  ├── ProviderInternal        retryable=true         5xx
  ├── Transport               retryable=true         网络抖动
  ├── InvalidProviderOutput   retryable=false        响应解码失败
  ├── UnknownProvider         retryable=?            兜底
```

每个 reason 都带 `HttpContext`（请求 method/url/headers + 响应 status/headers + 截断 body），可以直接日志或上报，且 SENSITIVE redact 都在 RequestExecutor 那层做完。

opencode 主包对这套并不直接使用——它接的是 AI SDK 的 `APICallError`，通过 `packages/opencode/src/provider/error.ts:118-202` 的 `parseAPICallError` / `parseStreamError` 自己重新归一：

```text
APICallError
  ├── isOverflow(message) || statusCode === 413 || error.code === "context_length_exceeded"
  │      → ParsedAPICallError { type: "context_overflow", message, responseBody }
  └── 否则
         → ParsedAPICallError {
             type: "api_error",
             message: extracted from body.error.message / body.message / status text,
             statusCode,
             isRetryable: provider==="openai" ? isOpenAiErrorRetryable(e) : e.isRetryable,
             responseHeaders, responseBody, metadata
           }
```

`isOverflow`（`provider/error.ts:39-46`）的 patterns 覆盖了 25+ 种 provider 的"上下文超长"错误信息 regex：

```text
/prompt is too long/i,                      // Anthropic
/input is too long for requested model/i,   // Amazon Bedrock
/exceeds the context window/i,              // OpenAI
/input token count.*exceeds the maximum/i,  // Google
/maximum prompt length is \d+/i,            // xAI
/reduce the length of the messages/i,       // Groq
/maximum context length is \d+ tokens/i,    // OpenRouter, DeepSeek, vLLM
/exceeds the limit of \d+/i,                // GitHub Copilot
/exceeds the available context size/i,      // llama.cpp server
/greater than the context length/i,         // LM Studio
/context window exceeds limit/i,            // MiniMax
/exceeded model token limit/i,              // Kimi
/context[_ ]length[_ ]exceeded/i,           // 通用兜底
/request entity too large/i,                // HTTP 413
/too large for model with \d+ maximum context length/i, // Mistral
...
```

Cerebras 和 Mistral 经常返回 "400 (no body)" / "413 (no body)"，没有 message，这里用一个特殊正则 `/^4(00|13)\s*(status code)?\s*\(no body\)/i` 兜底。

`parseStreamError`（`provider/error.ts:118-163`）则是「错误出现在 SSE event stream 里而不是 HTTP 状态码里」的场景：解析 body.error.code，识别 `context_length_exceeded` / `insufficient_quota` / `usage_not_included` / `invalid_prompt` / `server_is_overloaded` / `server_error` 等 Codex/OpenAI 风格的 stream-side 错误。

为什么 opencode 主包不直接用 LLM 子包的 LLMError？因为现在的默认路径是 AI SDK，AI SDK 已经把错误归一为 `APICallError`，opencode 在它上面再做一层「上下文超长 vs API 错误」的二分；native 路径才走 LLMError → opencode 错误归一会等到 LLMError 抛到上层后再 parse。两套现在并存。

## 6.16 模型状态与列表

`packages/opencode/src/provider/model-status.ts:1-9` 极简：

```ts
export { CatalogModelStatus } from "@opencode-ai/core/models-dev"
export const ModelStatus = Schema.Literals(["alpha", "beta", "deprecated", "active"])
export type ModelStatus = typeof ModelStatus.Type
```

`ModelStatus` 用于标记模型在 `models.dev` catalog 里的成熟度等级；TUI 显示模型选择器时会把 alpha/beta 用不同颜色标。`CatalogModelStatus` 从 `@opencode-ai/core` 转出来，主要是 enum 复用。

更复杂的「provider 是否可用」状态实际由 `Provider.Service`（`packages/opencode/src/provider/provider.ts:1014-1036`）维护：

- `provider.getProvider(id)` 拿到 `Info`（含 `key`、`options`、`models` map、`type: "api"|"local"|"plugin"`、`api: { npm, ... }`）。
- `provider.getModel(providerID, modelID)` 拿到具体 `Model`（含 `id, cost: { input, output, cache, tiers, experimentalOver200K }, limit: { input, context, output }, capabilities: { temperature, ... }, modalities, variants, ...`）。
- `provider.defaultModel()` 按 `defaultModelIDs` 排序优先。
- `provider.getSmallModel(providerID)` 拿小模型给 title 生成、summary 用。

模型限流时 opencode 不维护「全局禁用 5 分钟」这种状态——直接靠 `SessionRetry` 的退避 + `status.set({type:"retry", next})`，让 UI 显示重试倒计时。一直限流也不切换 model，等用户手动改。

## 6.17 Transform：消息再次归一

`packages/opencode/src/provider/transform.ts`（1376 行）是 opencode 主包的另一层 transform，处于 ai-sdk 路径上。它处理 LLM 子包不知道的事：

- `ProviderTransform.message(messages, model, options)`：根据 model 的 modalities 过滤多模态 part（不支持 image 的模型把 image 删掉换文本说明），sanitize surrogate pairs，role 折叠（连续 system/user 合并），injection 一些 provider 特有 marker。
- `ProviderTransform.providerOptions(model, options)`：根据 `sdkKey(npm)` 把 opencode 内部配置塞到 AI SDK 的 `providerOptions.openai / .anthropic / .gateway / ...` 下面。
- `ProviderTransform.options({model, sessionID, providerOptions})` / `smallOptions(model)`：每次请求构造 provider-specific options，比如 Anthropic 的 thinking budget、OpenAI 的 reasoning_effort。
- `ProviderTransform.temperature(model)` / `topP` / `topK` / `maxOutputTokens(model, outputTokenMax)`：从 model.capabilities 决定哪些参数生效。
- `ProviderTransform.schema(model, jsonSchema)`：根据 model 的 jsonSchema 约束（如 OpenAI 严格模式需要 `additionalProperties: false`）调整工具 schema。
- `ProviderTransform.OUTPUT_TOKEN_MAX = 32_000`：内置上限。

这层只在 ai-sdk 路径用；native 路径上类似归一发生在 LLM 子包的 protocol 内部。

## 6.18 一次完整调用的"代码地图"

为了不让上文显得抽象，这里把第 5 章 5.12 节那次模拟调用，落到 LLM 子包：

```text
[opencode session] handle.process(streamInput)
       │
       ▼
LLM.stream(input)  packages/opencode/src/session/llm.ts:343-367
   │ run(input)    llm.ts:81-341
   │   LLMRequestPrep.prepare(...)   session/llm/request.ts:54-186
   │     拼 system / messages / tools / params / headers
   │   if experimentalNativeLlm:
   │     LLMNativeRuntime.stream(...) → LLMNative.request → LLMClient.stream
   │   else:
   │     streamText({...})            ai-sdk
   │     adapter LLMAISDK.toLLMEvents
   ▼
Stream<LLMEvent, unknown>
```

走 native 时：

```text
LLMNativeRuntime.stream
   │
   │   LLMNative.request({ model, apiKey, baseURL, messages, tools, ... })
   │     → 构造 LLM.request({...})
   │     → 返回 LLMRequest 对象
   │
   │   LLMClient.stream({ request, tools, toolExecution: "auto" })
   │     ToolRuntime.stream(...)         tool-runtime.ts:65-200
   │       streamRequest(request)        route/client.ts:371-386
   │         compile(request)
   │           applyCachePolicy          cache-policy.ts:99
   │           route.body.from(request)
   │           Schema.decodeUnknownEffect(schema) 验证
   │           route.prepareTransport
   │             Endpoint.render → URL
   │             encodeBody → JSON
   │             auth.apply → headers
   │         route.streamPrepared(prepared, request, runtime)
   │           transport.frames(prepared, request, runtime)
   │             RequestExecutor.execute(httpReq) → bytes
   │             framing.frame(bytes) → string frames (SSE)
   │           Schema.decodeUnknownEffect(protocol.stream.event) → typed event
   │           protocol.stream.step → LLMEvent[]
   │
   ▼
Stream<LLMEvent, LLMError>
   │
   │ (ToolRuntime accumulates state, dispatches tool execute, recurses for next step)
   ▼
session processor handleEvent(event)  packages/opencode/src/session/processor.ts:305
```

## 6.19 几个容易踩的坑

**1. Provider 三层概念。** opencode 主包里有 `Provider.Info`（一个 provider 的元数据，含 model map）；LLM 子包里有 `provider.Definition`（注册式的工厂）；LLM 子包还有 `ProviderID`（一个 `Brand<string>`）。不要混。session/llm.ts 里 `provider.getProvider(model.providerID)` 拿的是前者。

**2. Route vs Protocol vs Provider 的关系。** Provider 是「认证 + baseURL + 一些路由的捆绑」，Route 是「(协议, 端点, 认证, framing, defaults) 的具体绑定」，Protocol 是「请求 body shape + 响应解码状态机」。OpenAI 一个 Provider 包含 3 个 Route（`responses`, `responsesWebSocket`, `chat`），分别绑两个 Protocol（`openai-responses`、`openai-chat`）。

**3. CachePolicy 的 inline hint 只对 anthropic/bedrock 生效。** 别把 `"auto"` 当作 OpenAI 也启用了 cache——OpenAI 的 prefix cache 是隐式的，不需要 marker；这里 policy pass 直接 return（`cache-policy.ts:100`）。

**4. ToolResultValue 是 union。** 工具返回的是 `{type: "json", value: {output, title, metadata}}` 还是 `{type:"text", value:"plain string"}` 取决于 ToolResultPart.make 的构造。第 5 章 processor.toolResultOutput（`processor.ts:282-301`）专门兜底 union 解构，要看清。

**5. AbortSignal 链。** session/llm.ts 用 `Effect.acquireRelease` 持有一个 AbortController，scope 结束自动 abort（`llm.ts:347-350`）；这个 signal 被 AI SDK 透传给 fetch；native 路径下用户传给 LLMNative.request 的 headers 里的 abort 才有效。

**6. RequestExecutor 的 redact 也覆盖 metadata。** 任何写到 OpenTelemetry / log 的 HttpContext 都已经 redacted；但是如果你绕过 executor 自己用 raw fetch，就得自己做 redact。

**7. ProviderMetadata 是逃生口。** 任何 provider 特有的字段（Anthropic 的 cache write/read 子项、OpenAI 的 logprobs、Google 的 safetyRatings 之类）都塞到 `providerMetadata: { anthropic: {...}, openai: {...} }` 下，按 provider name 键。LLM 子包不强行 normalize，上层想用就 `event.providerMetadata?.["anthropic"]?.["cacheCreationInputTokens"]`，opencode 在 `session.ts:378-443` 的 `getUsage` 里就是这样取的。

## 6.20 一份 provider 的最少代码量

按 `providers/anthropic.ts` 看，加一个新 provider 只需要 35 行：

```ts
export const id = ProviderID.make("anthropic")
export const routes = [AnthropicMessages.route]

export type Config = RouteDefaultsInput & ProviderAuthOption<"optional"> & { readonly baseURL?: string }

const auth = (options) =>
  Auth.optional(options.apiKey, "apiKey").orElse(Auth.config("ANTHROPIC_API_KEY")).pipe(Auth.header("x-api-key"))

const configuredRoute = (input) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return AnthropicMessages.route.with({ ...rest, endpoint: { baseURL }, auth: auth(input) })
}

export const configure = (input = {}) => {
  const route = configuredRoute(input)
  return {
    id,
    model: (modelID) => route.model({ id: modelID }),
    configure,
  }
}

export const provider = configure()
export const model = provider.model
```

每个新增 provider 只关心：

1. **provider id** — 字符串。
2. **routes** — 列出所有可用 route（一个或多个）。
3. **auth** — 用 `Auth.optional + orElse + config + header/bearer` 拼出来。
4. **baseURL 默认值** — 通常协议里给了，provider 这里 override。
5. **可选默认值** — `RouteDefaultsInput` 里 generation / providerOptions / headers / limits。

OpenRouter（98 行）、Azure（110 行）、Cloudflare（127 行）多出来的代码是「endpoint path 动态拼」「workspace id 校验」之类的 provider-specific 处理，但骨架始终不变。

加一个新 **protocol**（即新的 API 形状）成本要高得多——`anthropic-messages.ts` 是 767 行，因为它要管 content blocks、thinking、server tool use、cache control、tool_result 多模态 content、Usage 分解、所有 SSE event 类型的状态机。但好处是 protocol 一旦写完，无穷多个 provider 可以共享：DeepSeek/Together/Cerebras/Groq/Mistral/Qwen 全都共享 `openai-chat`。

## 6.21 复习清单

- 子包 `@opencode-ai/llm` 与主包 `opencode` 解耦；主包默认走 AI SDK 路径，可选 native 路径走子包。
- Route = (Protocol, Endpoint, Auth, Framing, defaults) 四件套；Protocol 决定 body 与 stream 形状，与部署无关。
- Schema 层（`LLMRequest`、`LLMEvent`、`Usage`、`Model`、`Tool*`）是子包内的通用数据契约。
- `applyCachePolicy` 用默认 `"auto"` 在 Anthropic/Bedrock 上自动注入 cache marker；其他 provider 的隐式 cache 不需要 marker。
- `ToolRuntime.stream` 在 native 路径里负责模型工具循环；ai-sdk 路径由 `streamText` 自己做。
- 每个 provider 的工具协议差异（tool_use / function_call / functionCall）都被压平为统一的 `LLMEvent.toolCall` / `LLMEvent.toolResult`，下游不需要分支。
- 错误归一两层：子包 `LLMError.reason`（tagged union with `retryable`），主包 `provider/error.ts` 把 AI SDK 的 `APICallError` 再归一为 `context_overflow` vs `api_error`，第 5 章的 `MessageV2.fromError` 是再上一层。
- `RequestExecutor` 给所有 HTTP 流量加 redact、限流响应解析、5xx 自动短重试；`Auth` 提供组合式凭据 DSL。
- `Provider.Service`（主包）维护可用 provider 与 model 元数据；`ModelStatus` 只是 alpha/beta/deprecated/active 标签。
