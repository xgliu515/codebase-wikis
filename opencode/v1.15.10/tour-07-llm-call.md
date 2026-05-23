# Trace 步骤 07 —— 第一次 LLM 流式请求

## 1. 当前情境

上一步把所有参数装齐了。现在 `processor.process(...)` 在 `prompt.ts:1428-1439` 被调用：

```ts
const result = yield* handle.process({
  user: lastUser,
  agent,
  permission: session.permission,
  sessionID,
  parentSessionID: session.parentID,
  system,                                   // ← 步骤 06 拼好
  messages: [...modelMsgs, ...(isLastStep ? [...] : [])],  // ← step=1，不附 MAX_STEPS 末尾消息
  tools,                                    // ← 步骤 06 装好
  model,
  toolChoice: format.type === "json_schema" ? "required" : undefined,
})
```

`processor.process` 内部很薄——它再把这堆参数原样转给 `LLM.stream(...)` (`packages/opencode/src/session/llm.ts:343-367`)。本步骤就是要看 `LLM.stream` 怎么把"opencode 视角的请求"变成"Anthropic Messages API 的 HTTP 流"，又怎么把回来的 SSE 字节流变成 opencode 内部的 `LLMEvent` 流。

可见的状态：
- `system: string[]`、`messages: ModelMessage[]`（含 1 条 user）、`tools: Record<string, AITool>` 全有。
- `model: Provider.Model` —— Anthropic `claude-sonnet-4-5`，`model.api.npm === "@ai-sdk/anthropic"`。
- 空的 `MessageV2.Assistant` 行已经在 MessageTable 里占位（步骤 06 提到的）。
- 还没有任何 Part 被写进 PartTable，也没有任何字节通过 HTTP 发出。

## 2. 问题

把这个请求变成实际的 HTTP 调用，至少要解决五件事：

1. **协议转换**：opencode 内部用的是 AI SDK 的 `ModelMessage` 形状（role / content parts），但 Anthropic Messages API 收的是 `{ system, messages: [{role, content}], tools, max_tokens, ... }`。两边字段名、嵌套层、tool 表达全不一样。
2. **鉴权注入**：要把 `auth.json` 里存的 API key 或 OAuth bearer 拼到正确 header（Anthropic 是 `x-api-key`，OpenAI OAuth 是 `Authorization: Bearer`，github-copilot 又不一样）。鉴权这步还要处理"凭证临时过期，refresh 一次再重试"。
3. **prompt cache 标记**：Anthropic Messages API 支持在 system / tool 定义 / 单条消息上加 `cache_control: { type: "ephemeral" }`，命中下次 5min 内的同前缀请求；不打，每次都是冷启动，成本暴涨。
4. **流式读取**：HTTP 响应是 SSE，逐行 `event: message_start / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop`，每行后跟一个 JSON。要边读边把字节解码、按事件边界切分、解出 JSON、按状态机推进；不能等响应完整收完。
5. **归一化成 opencode 内部事件**：不同 provider（Anthropic / OpenAI / Gemini / Bedrock）流出来的事件形状南辕北辙。下游的 `SessionProcessor` 只想见到统一的 `LLMEvent`（text-start / text-delta / text-end / tool-input-start / tool-input-delta / tool-input-end / finish-step / ...）。这道翻译层不能漏。

而且——**异步、边读边落 Part** 是硬性要求：用户在终端看着光标，他要的是"模型刚开始说话就有字往外蹦"，不是"30 秒后整段文本出现"。所有上述步骤都得在流式管道里完成，不能拼一个完整 response 再后处理。

## 3. 朴素思路

把每个 provider 看成一个独立函数，缺啥写啥：

```ts
async function callAnthropic(system, messages, tools, apiKey) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      system,
      messages: messages.map(...),  // 手写转换
      tools: Object.entries(tools).map(...),
      max_tokens: 4096,
      stream: true,
    }),
  })
  for await (const chunk of resp.body) {
    // 手写 SSE 切分 + JSON parse + 按事件分发回调
  }
}
```

每个 provider 一个这样的函数；流式状态机各自维护；prompt cache 想加再说。

## 4. 为什么朴素思路会崩

opencode 支持的 provider 路数：Anthropic / OpenAI Chat / OpenAI Responses / Google Gemini / Bedrock Converse / Bedrock EventStream / OpenAI-Compatible / Azure / OpenRouter / xAI / GitHub Copilot / Cloudflare / GitLab Workflow，加上各家的 OAuth / API key / Bedrock SigV4 / GCP Service Account 鉴权，还要让用户能自定义 model 通过 `opencode.json` 接到 OpenAI-Compatible 服务上。

朴素方案的代价：

- **N×M 爆炸**：N 个 provider × M 个鉴权方式 × K 种流式协议 = 几十种排列。每加一个 provider 就要写一遍流式状态机，bug 修十遍。
- **prompt cache 算法每家不同**：Anthropic 支持 inline `cache_control` 标记；OpenAI 是隐式 prefix cache，没法显式控制；Gemini 走 out-of-band 的 CachedContent API。同一个 LLM 调用，要根据 provider 决定"该不该插标记 / 插哪里 / 怎么插"。
- **AI SDK 已经做了一半**：直接用 vercel ai-sdk 的 `streamText` 能拿到统一的 `fullStream` —— 但它不管 prompt cache 标记策略、不管 opencode 自己的 rate-limit 退避、也不能让你在协议层级 patch（比如 Anthropic 的 `cache_control` 注入）。
- **流式重试是地雷**：HTTP 流读到一半 5xx，没有显式标记可重试 vs 不可重试的逻辑，结果就是要么不重试丢响应、要么重试导致重复执行 tool。
- **OAuth refresh 需要拦截 401**：传统 fetch 包装不识别"哎我 token 过期了，去 refresh 一下再来"——这就要走自定义 Auth runtime。

## 5. opencode 的做法

opencode 把 LLM 调用拆成三层。`packages/opencode/src/session/llm.ts` 是业务粘合层；中间是 ai-sdk 的 `streamText`；底层把"Anthropic Messages API 该怎么说话"的所有规则封装在协议层（默认走 `@ai-sdk/anthropic`，experimental 时走 `packages/llm/src/protocols/anthropic-messages.ts` 这条 native 路径）。两条路径产生的都是**同一种** `LLMEvent` 流。

### ai-sdk 路径（默认，本步骤主线）

`LLM.run` 在 `packages/opencode/src/session/llm.ts:81-340` 走以下顺序：

1. **拉资源**（`:95-103`）：并发 `provider.getLanguage(model)`（取 LanguageModel 实例）、`config.get()`、`provider.getProvider(...)`、`auth.get(model.providerID)`（取存好的 token）。

2. **prepare**（`:106-113`）：`LLMRequestPrep.prepare(...)` 把 system 二次组装、tools 用 `Permission.disabled` 最终过滤、算好 params 和 headers。

3. **构造 `streamText` 调用**（`:271-340`）：把 prepared 的内容喂给 ai-sdk 的 `streamText`。三个 opencode-specific 的关键点：

   - **`experimental_repairToolCall`**（`:278-298`）：模型偶尔会输出 `Read` 而非 `read`；先做大小写降级，再不行替换成 `invalid` 工具，让 LLM "再试一次"路径有落点。
   - **`maxRetries: input.retries ?? 0`**（`:309`）：opencode 把 retry 控制权抢回到自己手里（见 `packages/opencode/src/session/retry.ts`），ai-sdk 不重试。原因是 opencode 要区分"free-tier 触顶要弹 upsell"和"5xx 临时错误要退避"。
   - **`wrapLanguageModel` 中间件**（`:311-329`）：在 ai-sdk 把 prompt 交给底层 LanguageModel 之前，`transformParams` 注入 `ProviderTransform.message(...)` 做最后改写——修正 tool / user / assistant 顺序、加 anthropic / bedrock `cache_control`、补丢失的 reasoning 块（见 `provider/transform.ts:58-475`）。

4. **拿到 stream**：`streamText` 返回含 `fullStream` 的 result。`fullStream` 事件类型有 `start / start-step / text-start / text-delta / text-end / tool-input-start / tool-input-delta / tool-input-end / tool-call / tool-result / reasoning-start / reasoning-delta / reasoning-end / finish-step / finish`。

5. **翻译成 LLMEvent**（`:355-365`）：用 `LLMAISDK.toLLMEvents(state, event)` (`session/llm/ai-sdk.ts:61+`) 在一个大 switch 里把 ai-sdk 事件归一成 opencode `LLMEvent`，每条带足 `messageID / partID` 让下游知道挂到哪。返回给 `processor.process` 的就是这条 `Stream<LLMEvent>`。

### packages/llm native 路径（experimental，旁路）

`LLMClient.stream(request)` (`packages/llm/src/route/client.ts:407-415`) 的核心是 `compile` (`:341-356`) + `streamPrepared` (`:276-292`)：

- `compile` 跑 `resolveRequestOptions` → `applyCachePolicy` → `route.body.from(resolved)`（protocol 层把 `LLMRequest` 翻译成 Anthropic body schema 实例，见 `packages/llm/src/protocols/anthropic-messages.ts:744-755`）→ `route.prepareTransport`（加 headers / auth）。
- `streamPrepared` 跑 `transport.frames`（HTTP + SSE framing，见 `packages/llm/src/route/framing.ts`）→ `Stream.mapEffect(decodeEvent)`（按 protocol 的 event schema 解 JSON）→ `Stream.mapAccumEffect(protocol.stream.initial, protocol.stream.step, ...)`（状态机推进，Anthropic 的 `step` 在 `anthropic-messages.ts:462+`，处理 `content_block_start / content_block_delta / message_delta / message_stop`）。最后 `Stream.catchCause` 把任何抛出包成 `LLMError`。

### Anthropic 协议层 + 鉴权

`packages/llm/src/protocols/anthropic-messages.ts:744-765` 是整个 Anthropic 协议的对外面：`protocol` 绑定 body schema + from + stream 状态机；`route` 绑定 protocol + `Endpoint.path("/messages", { baseURL: "https://api.anthropic.com/v1" })` + `Framing.sse` + `headers: () => ({ "anthropic-version": "2023-06-01" })`。

`packages/llm/src/providers/anthropic.ts:13-23` 的 `auth(options)` 是一条 Effect chain：`Auth.optional(apiKey, "apiKey").orElse(Auth.config("ANTHROPIC_API_KEY")).pipe(Auth.header("x-api-key"))` —— 配置优先、回退 env、最终注入 header。这是 native 路径的鉴权；ai-sdk 路径走 `@ai-sdk/anthropic` 内部那套。

### prompt cache 策略

`packages/llm/src/cache-policy.ts:99-111` 是 native 路径的 cache 注入器。默认策略 `AUTO`（`:18-22`）：在**最后一个 tool 定义**、**最后一段 system**、**最后一条 user message** 上各打一个 `cache_control: ephemeral` 标记。这刚好覆盖 Anthropic agent harness 的典型 tool-use loop 形状——前缀（system + tools）整轮稳定，最后一条 user msg 在多轮 tool-call 之间也稳定，5 分钟内的同会话二次调用能整体命中缓存。

只有 `RESPECTS_INLINE_HINTS = { "anthropic-messages", "bedrock-converse" }` 中的 protocol 会被打标（`:42-43`），OpenAI / Gemini 走隐式或带外缓存。ai-sdk 路径同样有 cache 注入，但走在 `ProviderTransform.message` 里（`packages/opencode/src/provider/transform.ts:344-385`）。

### 错误退避：`session/retry.ts`

`packages/opencode/src/session/retry.ts:34-65` 的 `delay(attempt, error)` 优先读 `retry-after-ms` (Anthropic 风格) / `retry-after`（秒数 or HTTP-date），都没有就指数退避（initial 2s, factor 2, cap 30s）。`retryable(error, provider)` (`:67+`) 决定该不该重试：`ContextOverflowError` 永不重试；`APIError` 看 `isRetryable` 或 status≥500；`responseBody` 命中 `FreeUsageLimitError` 时返回带 `GO_UPSELL_MESSAGE` / `GO_UPSELL_URL` 的 action 让 TUI 弹给用户。这套退避不在快乐路径上跑，但任何 5xx 都会触发它。

## 6. 代码位置

按数据流向：

- `packages/opencode/src/session/llm.ts:33-46` —— `StreamInput` 接口：定义 `LLM.stream` 的入参形状。
- `packages/opencode/src/session/llm.ts:81-103` —— `run` 函数前段：log 标签 + 并发拉 language / config / provider / auth。
- `packages/opencode/src/session/llm.ts:106-113` —— 调 `LLMRequestPrep.prepare(...)`。
- `packages/opencode/src/session/llm/request.ts:54-186` —— `prepare`：合 system / 跑 plugin hook / 算 params / 算 headers / 过滤 tools。
- `packages/opencode/src/session/llm.ts:220-259` —— native 路径分支（experimentalNativeLlm flag）。
- `packages/opencode/src/session/llm.ts:271-340` —— ai-sdk 路径主体：构造 `streamText({...})`。
- `packages/opencode/src/session/llm.ts:278-298` —— `experimental_repairToolCall`：大小写修复 + `invalid` 兜底。
- `packages/opencode/src/session/llm.ts:311-329` —— `wrapLanguageModel` middleware：注入 `ProviderTransform.message`。
- `packages/opencode/src/session/llm.ts:343-367` —— `stream`：用 AbortController acquireRelease，把 `fullStream` 用 `LLMAISDK.toLLMEvents` 翻译成 `LLMEvent` 流。
- `packages/opencode/src/session/llm/ai-sdk.ts:1-254` —— ai-sdk `fullStream` → `LLMEvent` 的状态机。
- `packages/opencode/src/provider/transform.ts:429-475` —— `message(msgs, model, options)`：消息列表的 provider-specific 改写入口。
- `packages/opencode/src/provider/transform.ts:1203-1252` —— `providerOptions(model, options)`：providerOptions key 重映射（npm → SDK 接受的 key）。
- `packages/opencode/src/provider/transform.ts:1257+` —— `schema(model, jsonSchema)`：tool schema 的 provider-specific 改写（步骤 06 提过）。
- `packages/llm/src/llm.ts:47` —— `stream = LLMClient.stream` 的 re-export，是 native 路径的入口符号。
- `packages/llm/src/route/client.ts:341-356` —— `compile`：cache policy + body.from + prepareTransport。
- `packages/llm/src/route/client.ts:276-292` —— `streamPrepared`：transport.frames → decodeEvent → stream.step。
- `packages/llm/src/route/client.ts:407-415` —— `LLMClient.stream` 顶层签名。
- `packages/llm/src/cache-policy.ts:18-37` —— `AUTO` / `NONE` 策略与 `resolve()`。
- `packages/llm/src/cache-policy.ts:42-43` —— `RESPECTS_INLINE_HINTS = {"anthropic-messages", "bedrock-converse"}`。
- `packages/llm/src/cache-policy.ts:99-111` —— `applyCachePolicy`：cache marker 注入实现。
- `packages/llm/src/protocols/anthropic-messages.ts:744-755` —— Anthropic protocol 定义（body + stream state machine）。
- `packages/llm/src/protocols/anthropic-messages.ts:757-765` —— Anthropic route：endpoint / auth / SSE framing / `anthropic-version` header。
- `packages/llm/src/providers/anthropic.ts:13-23` —— `auth(options)`：apiKey > ANTHROPIC_API_KEY env，注入 `x-api-key`。
- `packages/llm/src/provider.ts:19-29` —— `Provider.Definition` 抽象。
- `packages/llm/src/route/client.ts:300-336` —— `Route.make(...)` 的总入口（接四个核心拼图：Protocol / Endpoint / Auth / Framing）。
- `packages/opencode/src/session/retry.ts:34-65` —— retry delay 计算。
- `packages/opencode/src/session/retry.ts:67-200` —— retryable 错误识别 + upsell 消息。
- `packages/opencode/src/session/llm/native-runtime.ts` —— native 路径的 stream 实现（experimental flag 下走）。

## 7. 分支与延伸

- **Vercel AI SDK 作底座** —— 为什么 opencode 既用 ai-sdk 又自己写一套 `packages/llm`、两者的迁移计划，参见 [第 06 章 §Vercel AI SDK 作底座](06-llm.md#vercel-ai-sdk-作底座)。
- **provider 注册** —— 13 个内置 provider 怎么发现、怎么配置，参见 [第 06 章 §provider 注册](06-llm.md#provider-注册)。
- **Protocols 层** —— anthropic-messages / openai-chat / openai-responses / gemini / bedrock-converse / bedrock-event-stream / openai-compatible-chat 七个协议的形状差异，参见 [第 06 章 §Protocols 层](06-llm.md#protocols-层)。
- **cache policy** —— `AUTO` / `NONE` / 自定义对象 三种形式，参见 [第 06 章 §cache policy](06-llm.md#cache-policy)。
- **错误与重试** —— 何时退避、何时弹 upsell、何时直接 fail，参见 [第 05 章 §错误与重试](05-prompt-loop.md#错误与重试)。
- **OAuth refresh** —— Anthropic / OpenAI / Copilot OAuth 凭证过期检测与刷新链，参见 `packages/opencode/src/auth` 和 `packages/llm/src/route/auth*.ts`。
- **streamText 入参全表** —— 包括 `experimental_telemetry`、`activeTools`、`toolChoice` 等冷僻字段，参见 [第 06 章 §streamText 与 opencode 的接缝](06-llm.md#streamtext-与-opencode-的接缝)。

## 8. 走完这一步你脑子里应该多了什么

1. **opencode 的 LLM 层是三层夹心**：opencode/session/llm.ts 是业务粘合层，ai-sdk 是当前默认底座，`packages/llm` 是 opencode 自己写的 native 运行时（experimentalNativeLlm 切换）。三层都流向同一种 `LLMEvent`。
2. **同步执行不存在于这个流程**：从 `streamText(...)` 返回到 `processor.process` 拿到 stream 是即时的；HTTP 还没真正发出，但 stream pipeline 已经搭好。每条事件来一条处理一条，是这套设计的底色。
3. **opencode 自己控制 retry**：`maxRetries: 0` 显式关掉 ai-sdk 的重试；`session/retry.ts` 负责区分 free-tier 触顶 / rate limit / 5xx，给出不同的退避和 UI 文案。
4. **wrapLanguageModel 中间件是协议层 patch 的最后一道**：所有"按 provider 修消息格式"的活儿都在 `ProviderTransform.message` 里，被 `transformParams` middleware 在 ai-sdk 把请求发出去前最后一秒注入——这把"opencode 视角的消息"和"provider 看的消息"完全解耦。
5. **prompt cache 不是开关，是策略**：默认 `AUTO` 在 tools / system / latest-user-message 三处打标。手动 `cache: CacheHint` 仍能放在任意 part 上做精细化。Anthropic / Bedrock-converse 支持 inline 标记；OpenAI / Gemini 走隐式或带外缓存——cache policy 系统会按 protocol id 决定是否启用 inline 注入。
6. **provider 的四大拼图**：每个 route 由 `protocol`（body + stream 状态机）+ `endpoint`（URL）+ `auth`（鉴权 chain）+ `framing`（SSE / line / NDJSON）四件组成。这是 `Route.make` 的契约，新接 provider 也只需要补齐这四块。

走完这一步：`Stream<LLMEvent>` 在手，对底层来说 HTTP 已经建连、SSE 前导握手已完成、tokens 开始往返。我们的 trace 里第一波 events 已经在到来：`step-start`、`text-start`（assistant 内心独白："Let me check the README")、`tool-input-start`（id=toolu_*, toolName="read"）—— 下一步要把这个流式 tool_use 片段从 events 里解出来。

下一步：[Trace 步骤 08 —— 解码 tool_use 片段](tour-08-tool-decode.md)
