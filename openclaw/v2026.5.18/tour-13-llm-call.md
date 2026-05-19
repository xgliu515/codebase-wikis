# Tour 13：调用 LLM provider

## 1. 当前情境

上一步（tour-12）结束时，attempt 内部已经把 prompt 拼好了：

- 一个确定的 `systemPrompt` 字符串（`buildAttemptSystemPrompt` 现造，带 prompt 缓存边界标记）。
- 一个经 `normalizeMessagesForLlmBoundary` 归一化的历史 message 列表——对我们这条新 session 几乎是空的。
- 末尾那条「你好」user 消息。

这些东西即将组装成一次 LLM 请求的输入。但「请求」还没发出去。我们手上还有 tour-11 备好的三样东西没用上：`provider = "anthropic"`、某个 `model = claude-*`、以及一个 `authProfileId`（指向一份 Anthropic 凭证）。

这一步要看的，是 attempt 如何把「provider 标识 + 凭证 + prompt」变成一条**真实的、流式的 HTTP 连接**通向 `api.anthropic.com`。

## 2. 问题

> attempt 已经知道要用 `anthropic` 这个 provider、某个 `claude-*` 模型、某个 auth profile。它如何据此选定真正的传输实现、解析出可用的 API 凭证、并发起一次**流式**推理请求？

三个动词：选传输、解凭证、发请求。注意第三个是「流式」——不是发完等一个完整 JSON 回来，而是建立一条 SSE 连接让 token 逐步回流。

## 3. 朴素思路

`agent-command.ts` 已经算出 `provider === "anthropic"`，那就在 attempt 里写个分支：

```ts
if (provider === "anthropic") {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, system, messages, stream: true }),
  });
  return resp.body; // 流
}
```

provider 名做 `if`，凭证从环境变量拿，URL 和请求头写死，`stream: true` 开流。要加 OpenAI 就再加一个 `else if`。

## 4. 为什么朴素思路会崩

这个朴素思路会在五个具体的地方崩。

**第一，凭证不在环境变量里。** tour-11 选出的不是「环境变量名」，是一个 `authProfileId`——指向 auth store 里持久化的一份**具名凭证**。这份凭证可能是 API key，可能是 setup-token（bearer token），也可能是 OAuth（带 refresh token 和过期时间）。OAuth 凭证用之前必须先**刷新**（`refreshOAuthCredentialForRuntime`，见第 07 章 7.5.4），而且刷新要串行化避免 refresh token 被并发消费掉。`process.env.ANTHROPIC_API_KEY` 这一行：拿错了来源、漏了刷新、忽略了凭证类型分叉——三重错。

**第二，请求头不是写死的常量。** Anthropic 的请求需要按模型和认证方式动态拼 `anthropic-beta` 头。OAuth 认证和 API key 认证要发的 beta 组合不同（OAuth 要带 `oauth-2025-04-20`、`claude-code-20250219`）；`claude-opus-4` / `claude-sonnet-4` 系列要不要开 100 万 token 上下文 beta（`context-1m-2025-08-07`）也得现判。还有 thinking 模式下对 assistant prefill 的特殊 payload 约束。把这些写成固定 header 常量，要么 beta 头发错、要么 thinking 模式直接被 API 拒。

**第三，`if (provider === ...)` 不可扩展。** OpenClaw 的 `extensions/` 下有几十个 provider：anthropic、openai、google、ollama、lmstudio、groq、deepseek……每加一个都改 attempt 的核心代码，意味着 attempt 这个本就上千行的文件会被几十个 provider 分支撑爆，而且每个分支都要重写一遍「发请求 / 收流 / 重试」。provider 的差异应该被收敛进插件钩子，而不是散落成 `if`。

**第四，`fetch` 一把梭丢了流式语义。** 我们要的是**流式**——token 逐个回流，下游才能边收边渲染打字效果。裸 `fetch` 拿到 `resp.body` 只是个字节流，SSE 事件的解析（`message_start` / `content_block_delta` / `message_delta` / `message_stop`）、增量文本的累积、`tool_use` 块的检测、`usage` 与 `stop_reason` 的提取，全都得自己写。每个 provider 的流格式还不一样。

**第五，没有韧性。** 网络抖动、503、限流、上下文溢出——朴素 `fetch` 对这些一律抛原始错误。OpenClaw 有四层重试机制（瞬时错误重试、auth profile 冷却轮换、模型 fallback、live switch，见第 08 章 8.7 的对比表），它们要能介入这次调用。一个裸 `fetch` 给不了任何介入点。

核心矛盾：「发一次 LLM 请求」不是一行 `fetch`，而是一条「**把 provider 无关的通用 loop** 和 **provider 特有的传输细节** 干净分离」的装配——通用部分（凭证解析框架、流式 loop、重试）归内核，特有部分（Anthropic 的 beta 头、流包装、底层传输）归 provider 插件钩子。

## 5. OpenClaw 的做法

**先把问题摆正**：发一次 LLM 调用要解决三件事——(a) 把 `authProfileId` 解析成一个能直接用的 API key/token，OAuth 还要先刷新；(b) 根据 provider/model 选出真正的流式传输函数 `StreamFn`，并叠加该 provider 特有的传输修饰；(c) 用这个 `StreamFn` 发起流式请求。OpenClaw 把这三件事拆开，且严格遵守「core 拥有通用 loop，provider 拥有钩子」的原则（见第 08 章 8.3.3）。

**provider 是插件，不是 `if` 分支。** `anthropic` 是 `extensions/anthropic/` 下的一个 extension 插件，它向内核注册了一个 `ProviderPlugin` 对象（`buildAnthropicProvider`，`extensions/anthropic/register.runtime.ts:490`），对象里全是钩子。attempt 不写 `if (provider === "anthropic")`——它调内核的通用封装层，由后者去找对的插件、调对的钩子。

**第一步：解析凭证。** tour-11 选出的 `authProfileId` 在 attempt 之前已经被 `buildAgentRuntimeAuthPlan` 处理（见第 07 章 7.7.3）。auth profile 子系统的 `resolveApiKeyForProfile`（`src/agents/auth-profiles/oauth.ts:330`）把任意类型的 profile 统一解析成一个可直接用的 key/token——如果是 OAuth profile，它会先触发 `refreshOAuthCredentialForRuntime` 刷新（per-profile 串行队列，避免并发消费 refresh token）。结果是一个 `resolvedApiKey` 字符串。我们这条 trace 用的是一份 Anthropic 凭证，解析出来就是发请求要用的那个 token。

**第二步：选定 `StreamFn`。** `StreamFn` 是底层 agent 引擎 `@earendil-works/pi-agent-core` 定义的函数类型——「给定 model + context + options，发起一次流式 LLM 请求并产出事件流」。attempt 在 `src/agents/pi-embedded-runner/run/attempt.ts:2557` 起做这件事，分三层：

1. `resolveEmbeddedAgentBaseStreamFn`（`src/agents/pi-embedded-runner/run/attempt.ts:2557`，定义在 `src/agents/pi-embedded-runner/stream-resolution.ts:11`）取 session 的「基础流函数」——每个 turn 从原始基线重建，避免上一轮的 wrapper 把传输行为钉死。
2. `registerProviderStreamForModel`（`src/agents/pi-embedded-runner/run/attempt.ts:2598`）拿到**该 provider 注册的流函数**——这正是 provider 插件介入的点。对 Anthropic，它最终落到内核里的传输流函数 `createAnthropicMessagesTransportStreamFn`（`src/agents/anthropic-transport-stream.ts:913`），并叠加 Anthropic 的 `wrapStreamFn`（`register.runtime.ts:598`，即 `wrapAnthropicProviderStream`）——后者负责 beta 头管理（`mergeAnthropicBetaHeader`）、thinking prefill 处理这些「Anthropic 传输怪癖」。注意：Anthropic 是**内置 provider**，传输实现深嵌在 `src/agents/anthropic-transport-stream.ts`，插件层（`extensions/anthropic/`）做的是注册、配置归一化、流包装。
3. `resolveEmbeddedAgentStreamFn`（`src/agents/pi-embedded-runner/run/attempt.ts:2609`，定义在 `src/agents/pi-embedded-runner/stream-resolution.ts:109`）把上面两者合成最终的 `streamFn`，装到 `activeSession.agent.streamFn`（`src/agents/pi-embedded-runner/run/attempt.ts:2609`）。`resolveEmbeddedAgentStreamFn` 内部用 `wrapEmbeddedAgentStreamFn` 包一层，注入 `runSignal`（中止信号）、`resolvedApiKey`、`authStorage`、`providerId`，并在 `transformContext` 里用 `stripSystemPromptCacheBoundary`（`src/agents/pi-embedded-runner/stream-resolution.ts:127`）把 tour-12 埋的 prompt 缓存边界标记在发出前处理掉。

最终的 `activeSession.agent.streamFn` 之后还会被一连串 wrapper 继续包装（`src/agents/pi-embedded-runner/run/attempt.ts:2624` 起）：文本变换、诊断事件、工具调用参数修复、idle 超时——每一层都是「在不污染核心 loop 的前提下加一种横切能力」。

**第三步：发起流式请求。** prompt 缓存边界 strip 完、`streamFn` 装好，真正的请求由 embedded pi 的通用推理 loop 发起——它把 tour-12 的 `systemPrompt` + 归一化历史 + 「你好」组装成 `context`，调 `activeSession.agent.streamFn(model, context, options)`。`StreamFn` 内部（对 Anthropic 是 `createAnthropicMessagesTransportStreamFn`）创建 Anthropic Messages API 客户端、根据 `isOAuthToken`（`src/agents/anthropic-transport-stream.ts:935`）区分 OAuth 与 API key 的发法、拼好 beta 头，向 `api.anthropic.com` 发出一个 `stream: true` 的 POST。返回的不是完整响应，是一个**事件流**。

**韧性是内核的，不是这次调用的。** 这次调用本身只管「发出去」。瞬时错误重试（`src/provider-runtime/operation-retry.ts`）、auth profile 冷却轮换、`runWithModelFallback` 的模型 fallback——四层重试全在内核（见第 08 章 8.7 对比表）。provider 插件只通过钩子（如 `matchesContextOverflowError`）告诉内核「这个错误是什么性质」，由内核决定怎么应对。attempt 这一层把 `runAbortController.signal` 透传进 `streamFn`，保证这条流随时可被中止。

走完这一步，OpenClaw 和 `api.anthropic.com` 之间建立起了一条**流式连接**：请求已发出，Anthropic 开始把模型生成的 token 以 SSE 事件形式逐个回推。

## 6. 代码位置

- `src/agents/auth-profiles/oauth.ts:330` — `resolveApiKeyForProfile`，把任意类型 auth profile 统一解析成可用 key/token，OAuth 先刷新。
- `src/agents/auth-profiles/oauth.ts:204-235` — `refreshOAuthCredentialForRuntime`，OAuth 凭证运行时刷新，per-profile 串行队列。
- `src/agents/pi-embedded-runner/run/attempt.ts:2557` — `resolveEmbeddedAgentBaseStreamFn`，取 session 的基础流函数。
- `src/agents/pi-embedded-runner/run/attempt.ts:2598` — `registerProviderStreamForModel`，拿到该 provider 注册的流函数。
- `src/agents/pi-embedded-runner/run/attempt.ts:2609-2617` — `resolveEmbeddedAgentStreamFn`，合成最终 `streamFn` 并装到 `activeSession.agent.streamFn`。
- `src/agents/pi-embedded-runner/stream-resolution.ts:11` — `resolveEmbeddedAgentBaseStreamFn` 定义。
- `src/agents/pi-embedded-runner/stream-resolution.ts:109` — `resolveEmbeddedAgentStreamFn` 定义，内部 `wrapEmbeddedAgentStreamFn` 注入信号/凭证。
- `src/agents/pi-embedded-runner/stream-resolution.ts:127` — `stripSystemPromptCacheBoundary`，发请求前处理掉 prompt 缓存边界标记。
- `src/agents/pi-embedded-runner/run/attempt.ts:2624-2790` — `streamFn` 之上一连串 wrapper（文本变换、诊断事件、工具调用修复、idle 超时）。
- `extensions/anthropic/register.runtime.ts:490` — `buildAnthropicProvider`，构造 Anthropic 的 `ProviderPlugin`。
- `extensions/anthropic/register.runtime.ts:598` — `wrapStreamFn: wrapAnthropicProviderStream`，Anthropic 流包装钩子。
- `extensions/anthropic/stream-wrappers.ts:21-48` — Anthropic 的 beta 头管理（`mergeAnthropicBetaHeader`、`ANTHROPIC_CONTEXT_1M_BETA`）。
- `src/agents/anthropic-transport-stream.ts:913` — `createAnthropicMessagesTransportStreamFn`，真正发 HTTP 的底层传输流函数。
- `src/agents/anthropic-transport-stream.ts:935` — `isOAuthToken`，区分 OAuth 与 API key 的发法。
- `src/provider-runtime/operation-retry.ts` — 内核拥有的瞬时错误重试。

## 7. 分支与延伸

我们这条 trace 走的是「Anthropic、内置 provider、`wrapStreamFn` 包装、有凭证」。这一步上没走的岔路：

- **自托管 provider**：Ollama / LM Studio 用 `createStreamFn` 从零造流函数、用 `resolveSyntheticAuth` 给一个占位 key（没有真凭证概念），模型还要动态发现。
- **CLI backend**：Anthropic 也注册了 CLI backend，让本机 Claude CLI 当 runner（走 `runCliAgent` 而非 `runEmbeddedPiAgent`）。
- **OpenAI Codex**：`isOpenAICodexResponsesModel` 走专门的 `resolvePiNativeCodexResponsesStreamFn` 分支。
- **anthropic-vertex**：`createAnthropicVertexStreamFnForModel` 是另一条传输路径。
- **凭证全部冷却**：auth profile 选序里所有 profile 都在冷却时的 fallback 行为。
- **模型 fallback**：primary 模型挂了，`runWithModelFallback` 切到备用模型重发。

想系统理解 provider 插件架构、`ProviderPlugin` 钩子、`StreamFn` 的创建与包装、四层重试机制，去读 [第 08 章](08-llm-providers.md)。想理解 auth profile 的选序、冷却、OAuth 刷新如何在 agent 执行里串起来，去读 [第 07 章](07-agent-execution.md)（7.5「auth profile」与 7.7「attempt 执行」）。

## 8. 走完这一步你脑子里应该多了什么

- **provider 是插件，不是 `if` 分支**。attempt 不写 `if (provider === "anthropic")`；`anthropic` 是 `extensions/anthropic/` 下注册的一个 `ProviderPlugin`，全是钩子。加一个 provider 不动核心 loop。
- **凭证来自 auth profile，不是环境变量**。`resolveApiKeyForProfile` 把 `authProfileId` 解析成可用 key/token；OAuth 凭证用前必须 `refreshOAuthCredentialForRuntime` 刷新，且刷新串行化避免 refresh token 被并发消费。
- **`StreamFn` 是流式传输的统一抽象**。attempt 分三层选定它：取基础流函数 → `registerProviderStreamForModel` 拿 provider 注册的流函数 → `resolveEmbeddedAgentStreamFn` 合成并注入中止信号/凭证。Anthropic 用 `wrapStreamFn` 在标准传输外叠加 beta 头、thinking prefill 等怪癖。
- **「core 拥有 loop，provider 拥有钩子」**。通用推理 loop、四层重试全在内核；provider 插件只填钩子声明自己的传输细节和错误性质。Anthropic 因是内置 provider，传输实现深嵌 `src/agents/anthropic-transport-stream.ts`。
- **请求是流式的**。发出去的是 `stream: true` 的 POST，返回的不是完整 JSON 而是一个 SSE 事件流——`runAbortController.signal` 透传进去保证随时可中止。
- 这一步结束时，与 `api.anthropic.com` 的流式连接已建立，token 开始回流——下一步要看这些原始流事件怎么被转成 OpenClaw 内部的 agent 事件。
