# Tour 步骤 10:anthropic provider 翻译 + HTTP + SSE 开启

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:控制流在 `streamSimpleAnthropic()` 的懒加载包装器内,anthropic 模块已动态加载完毕,`streamAnthropic()` 即将被调用,messages 尚未翻译为 Anthropic API schema。

**下一步起点**:SSE 流已建立,首批 `message_start` 与 `content_block_start` 事件即将到达。`AssistantMessageEventStream` 已 push 了首个 `start` 事件。AgentSession 的事件流还没收到任何文本。

---

## 1. 当前情境

`streamSimpleAnthropic()` 在 `packages/ai/src/providers/anthropic.ts:728` 被调用。此时进程状态:

- `model.api = "anthropic-messages"`,`model.provider = "anthropic"`,`model.id` 为具体模型字符串(如 `claude-sonnet-4-6-20251010`)。
- `context.messages` 是 pi 内部的 `Message[]`(已经过 `convertToLlm` 转换,不含 bashExecution 等 harness 专有类型)。
- `context.tools` = activeTools 数组(AgentTool[]),尚未转为 Anthropic API 的 `Tool[]` 格式。
- `context.systemPrompt` = 已渲染的 system prompt 字符串。
- `options.apiKey` = 有效 API key 或 OAuth token。
- `options.signal` = AbortController.signal。

---

## 2. 问题

本步需要解决三个紧密串联的问题:

1. **消息格式翻译**:pi 内部的 `Message[]` 格式(role/content 结构)与 Anthropic Messages API 要求的 `MessageParam[]` 格式不完全相同。孤儿 tool_use(有 tool_call 但没有对应 tool_result 的情况)会导致 API 400 错误,必须在翻译阶段插入合成结果。

2. **HTTP 请求构造**:需要把 model、max_tokens、system、messages、tools、thinking 等字段组装成符合 Anthropic API schema 的 request body,同时处理 OAuth 与 API key 两种认证路径的差异。

3. **SSE 解析**:Anthropic 用 HTTP chunked transfer 传输 SSE 格式的事件流。`@anthropic-ai/sdk` 提供了客户端,但 pi 自己实现了 SSE 解析器来绕过 SDK 的某些限制并直接处理 `Response` 对象。

---

## 3. 朴素思路

直接调用 `@anthropic-ai/sdk` 的 `client.messages.stream()`,用 SDK 提供的事件回调处理响应。

---

## 4. 为什么朴素思路会崩

**SDK 的 SSE 解析在某些代理场景下不可控**:Cloudflare AI Gateway、Fireworks 等中间代理会修改 SSE 格式或响应头,SDK 内部的解析逻辑有时会因意外格式而抛出无法捕获的异常。pi 自己实现 SSE 解析(`iterateSseMessages`,`anthropic.ts:328`) 让错误处理完全受控。

**`onPayload` hook 需要在 HTTP 之前注入**:`before_provider_payload` hook 允许调用方(扩展)在发出 HTTP 请求前修改 request body。SDK 的 stream 接口不暴露这个拦截点。pi 的做法是先 `buildParams()` 得到 body,执行 `options.onPayload?.()`,然后再调用 `client.messages.create({ ...params, stream: true }).asResponse()` 获取原始 `Response`(`anthropic.ts:488-498`)。

**孤儿 tool_use 处理**:multi-turn 对话中,如果某次 assistant 回复包含 tool_use block 但对应的 tool_result 从未出现(例如因为中断),重新发起请求时 Anthropic API 会拒绝这个格式。`transform-messages.ts` 的第二次 pass 专门处理这个问题。

---

## 5. pi 的做法

**第一阶段:`streamSimpleAnthropic` → `streamAnthropic` 桥接**

```typescript
// packages/ai/src/providers/anthropic.ts:728-769
export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
    model, context, options,
) => {
    const apiKey = options?.apiKey || getEnvApiKey(model.provider);
    if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);

    const base = buildBaseOptions(model, options, apiKey);
    if (!options?.reasoning) {
        return streamAnthropic(model, context,
            { ...base, thinkingEnabled: false } satisfies AnthropicOptions);
    }
    // 根据 model.id 判断是 adaptive thinking(Opus 4.6+) 还是 budget-based
    if (supportsAdaptiveThinking(model.id)) {
        const effort = mapThinkingLevelToEffort(model, options.reasoning);
        return streamAnthropic(model, context,
            { ...base, thinkingEnabled: true, effort } satisfies AnthropicOptions);
    }
    const adjusted = adjustMaxTokensForThinking(base.maxTokens, model.maxTokens, ...);
    return streamAnthropic(model, context,
        { ...base, thinkingEnabled: true,
          thinkingBudgetTokens: adjusted.thinkingBudget } satisfies AnthropicOptions);
};
```

`buildBaseOptions()` 在 `simple-options.ts` 中把 `SimpleStreamOptions` 展开为 `AnthropicOptions` 的基础字段(maxTokens、apiKey、headers 等)。thinking 参数由 `streamSimpleAnthropic` 决策,而不是由调用方决定——这是 `streamSimple` 接口的设计意图:调用方只说"我想要 medium 级别的 reasoning",provider 自行决定用哪种 API 参数实现。

**第二阶段:消息格式翻译(`transform-messages.ts`)**

`streamAnthropic` 内部的 `convertMessages()` 函数(`anthropic.ts:997-1158`) 调用 `transformMessages()`(`transform-messages.ts:64`) 作为第一步预处理:

```
transformMessages():
  第一次 pass:
    - downgradeUnsupportedImages():不支持 vision 的模型,图片替换为占位文本
    - 处理 assistant messages:
        * redacted thinking block -> 仅同模型保留
        * 无签名 thinking block -> 转为 text block(避免 API 拒绝)
        * cross-provider tool_use -> 删除 thoughtSignature
        * tool call ID 规范化(Anthropic 要求 ^[a-zA-Z0-9_-]+$, 最长 64 字符)
    - 构建 toolCallIdMap:原始 ID -> 规范化 ID
    - toolResult messages -> 用 toolCallIdMap 替换 toolCallId

  第二次 pass(孤儿修复):
    - 遍历所有 message
    - 跟踪 pendingToolCalls(当前 assistant 的 tool_use blocks)
    - 若遇到下一条 assistant 消息但 pendingToolCalls 未全部匹配 toolResult:
        -> 插入合成 ToolResultMessage { content: "No result provided", isError: true }
    - errored/aborted assistant message 整条跳过
    - 对话末尾仍有未处理 tool_use -> 补齐合成 toolResult
```

合成 toolResult 的插入(`transform-messages.ts:160-177`)让 Anthropic API 永远不会收到"只有 tool_use 没有 tool_result"的非法序列,即使会话被中断也能安全重试。

**第三阶段:构造 API request body(`buildParams`,`anthropic.ts:886-990`)**

```typescript
function buildParams(model, context, isOAuthToken, options): MessageCreateParamsStreaming {
    const { cacheControl } = getCacheControl(model, options?.cacheRetention);
    const params: MessageCreateParamsStreaming = {
        model: model.id,
        messages: convertMessages(context.messages, model, isOAuthToken, cacheControl),
        max_tokens: options?.maxTokens ?? model.maxTokens,
        stream: true,
    };

    // system prompt 处理:OAuth 需要插入 Claude Code 身份块
    if (isOAuthToken) {
        params.system = [
            { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.",
              ...(cacheControl ? { cache_control: cacheControl } : {}) },
            { type: "text", text: sanitizeSurrogates(context.systemPrompt), ... },
        ];
    } else if (context.systemPrompt) {
        params.system = [{ type: "text", text: sanitizeSurrogates(context.systemPrompt),
                           ...(cacheControl ? { cache_control: cacheControl } : {}) }];
    }

    // tools:convertTools() 把 AgentTool[] 转为 Anthropic.Messages.Tool[]
    if (context.tools && context.tools.length > 0) {
        params.tools = convertTools(context.tools, isOAuthToken,
            compat.supportsEagerToolInputStreaming,
            compat.supportsCacheControlOnTools ? cacheControl : undefined);
    }

    // thinking 配置:adaptive 或 budget-based
    if (model.reasoning && options?.thinkingEnabled) {
        if (supportsAdaptiveThinking(model.id)) {
            params.thinking = { type: "adaptive", display: options.thinkingDisplay ?? "summarized" };
            if (options.effort) params.output_config = { effort: options.effort };
        } else {
            params.thinking = { type: "enabled",
                                budget_tokens: options.thinkingBudgetTokens || 1024, ... };
        }
    }
    return params;
}
```

`convertTools()`(`anthropic.ts:1165-1188`) 把 pi 内部的 `Tool[]` 翻译成 Anthropic 格式:name(OAuth 模式下映射为 Claude Code 标准名,如 `read` → `Read`)、description、input_schema(TypeBox schema → JSON Schema object)。最后一个工具加 `cache_control`,让工具列表被缓存。

**cache_control 标注策略**:

- system prompt 最后一个 block 加 `cache_control: { type: "ephemeral" }`。
- messages 数组最后一条 user 消息的最后一个 block 加 `cache_control`。
- tools 数组最后一个工具加 `cache_control`。

三处标注让 Anthropic Prompt Caching 尽可能多地命中 prefix 缓存(system + tools + 历史消息),只有最新 user 消息是新增内容。

**第四阶段:HTTP 发出与 SSE 建立**

```typescript
// packages/ai/src/providers/anthropic.ts:488-500
let params = buildParams(model, context, isOAuth, options);
const nextParams = await options?.onPayload?.(params, model);  // before_provider_payload hook
if (nextParams !== undefined) params = nextParams as MessageCreateParamsStreaming;

const requestOptions = {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
};
const response = await client.messages.create(
    { ...params, stream: true }, requestOptions
).asResponse();
await options?.onResponse?.({ status: response.status, headers: ... }, model);
stream.push({ type: "start", partial: output });
```

`.asResponse()` 返回原始 `Response` 对象而不是 SDK 的 stream helper,这让 pi 自己控制 SSE 解析。`stream: true` 使 Anthropic 服务端以 chunked transfer encoding 返回 SSE 格式的响应体。

**第五阶段:自实现 SSE 解析器**

SSE 解析在三层中完成:

```
Response.body (ReadableStream<Uint8Array>)
  |
  v
iterateSseMessages()          anthropic.ts:328-385
  - TextDecoder 按 chunk 解码
  - consumeLine() 找 \r\n 或 \n 换行边界
  - decodeSseLine() 解析 event:/data: 字段
  - flushSseEvent() 在空行时产出 ServerSentEvent
  |
  v
iterateAnthropicEvents()      anthropic.ts:387-426
  - 过滤 ANTHROPIC_MESSAGE_EVENTS 集合以外的事件
  - parseJsonWithRepair() 解析 data 字段 JSON
  - 校验 message_start/message_stop 存在性
  |
  v
streamAnthropic 主循环        anthropic.ts:505-661
  - message_start -> 读取初始 token usage
  - content_block_start -> push text_start/thinking_start/toolcall_start
  - content_block_delta -> 累积 text/thinking/input_json,push *_delta
  - content_block_stop -> push text_end/thinking_end/toolcall_end
  - message_delta -> 更新 stop_reason 和 token counts
```

`ANTHROPIC_MESSAGE_EVENTS`(`anthropic.ts:248-255`) 是一个 `ReadonlySet`,只包含 6 种业务事件,其他 SSE 事件(如 `ping`)被 `iterateAnthropicEvents` 的 `continue` 跳过,不进入业务逻辑。

`parseJsonWithRepair()` 用于容错解析——某些代理可能截断 JSON,repair 逻辑尝试自动补全以避免整个流因单条坏数据崩溃。

**OAuth 工具名映射**:

OAuth 模式下,pi 将工具名映射为 Claude Code 标准大小写(`read` → `Read`,`bash` → `Bash`)。这是因为 OAuth token 绑定了 Claude Code 身份,API 端对工具名有白名单校验。`ccToolLookup`(`anthropic.ts:95`) 是大小写无关的映射表,`toClaudeCodeName()` 在 `convertTools()` 中使用,`fromClaudeCodeName()` 在解析响应时把 `Read` 还原回 `read`(`anthropic.ts:99-106`)。

```
Request flow:
  AgentTool[].name = "read"
      |
      | convertTools() isOAuth=true -> toClaudeCodeName("read") = "Read"
      v
  Anthropic API: tool.name = "Read"
      |
      | content_block_start.content_block.name = "Read"
      v
  fromClaudeCodeName("Read", context.tools) -> "read"
      |
  output.content.push({ type: "toolCall", name: "read", ... })
```

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/ai/src/providers/anthropic.ts` | 428-687 | `streamAnthropic()`:stream 主实现,包含 HTTP 发送与全部 SSE 事件处理 |
| `packages/ai/src/providers/anthropic.ts` | 728-769 | `streamSimpleAnthropic()`:reasoning 参数决策,桥接到 `streamAnthropic` |
| `packages/ai/src/providers/anthropic.ts` | 775-884 | `createClient()`:根据 provider/auth 类型创建 Anthropic SDK 实例 |
| `packages/ai/src/providers/anthropic.ts` | 886-990 | `buildParams()`:组装完整 request body |
| `packages/ai/src/providers/anthropic.ts` | 997-1158 | `convertMessages()`:调用 `transformMessages` + 翻译每条 message |
| `packages/ai/src/providers/anthropic.ts` | 1165-1188 | `convertTools()`:AgentTool[] -> Anthropic.Messages.Tool[] |
| `packages/ai/src/providers/anthropic.ts` | 248-255 | `ANTHROPIC_MESSAGE_EVENTS`:过滤集合 |
| `packages/ai/src/providers/anthropic.ts` | 257-297 | `flushSseEvent()` / `decodeSseLine()`:SSE 字段解析 |
| `packages/ai/src/providers/anthropic.ts` | 328-385 | `iterateSseMessages()`:chunk 解码与行切割 |
| `packages/ai/src/providers/anthropic.ts` | 387-426 | `iterateAnthropicEvents()`:过滤、JSON 解析、完整性校验 |
| `packages/ai/src/providers/transform-messages.ts` | 64-220 | `transformMessages()`:两次 pass——格式规范化 + 孤儿修复 |
| `packages/ai/src/providers/transform-messages.ts` | 155-177 | 合成 ToolResultMessage 插入逻辑 |
| `packages/ai/src/utils/event-stream.ts` | 69-83 | `AssistantMessageEventStream`:done/error 终止信号 |

---

## 7. 分支与延伸

- **Anthropic provider 的完整 stream 骨架与事件时间线**:见 [第 03 章 §3.1「stream() 骨架」](./03-ai-provider-implementations.md#31-stream-骨架)。

- **自实现 SSE 解析器的设计原因**:见 [第 03 章 §3.2「自实现 SSE 解析器」](./03-ai-provider-implementations.md#32-自实现-sse-解析器)。

- **消息格式转换层(`transform-messages.ts`)的完整职责**:见 [第 03 章 §2「消息格式转换层」](./03-ai-provider-implementations.md#2-消息格式转换层)。

- **OAuth 模式的特殊处理(Claude Code 身份、Bearer token)**:见 [第 03 章 §3.5「OAuth 模式的特殊处理」](./03-ai-provider-implementations.md#35-oauth-模式的特殊处理)。

- **Prompt Caching 的 cache_control 标注策略**:见 [第 03 章 §3.4「Prompt Caching」](./03-ai-provider-implementations.md#34-prompt-caching)。

- **API key 的来源优先级(环境变量、OAuth token 刷新)**:见 [第 04 章 §2「环境变量自动检测」](./04-ai-auth-and-oauth.md#2-环境变量自动检测)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **翻译分两层,职责不同**:`transformMessages()`(transform-messages.ts) 处理跨 provider 兼容性问题(图片降级、ID 规范化、孤儿修复),`convertMessages()`(anthropic.ts) 处理 Anthropic API 格式映射。第一层是通用逻辑,第二层是 provider 专属逻辑。

2. **孤儿 tool_use 的合成修复是防御性设计**:对话树中可能存在"assistant 发出了 tool_call 但 tool_result 从未写入"的情况(中断、切换分支)。`insertSyntheticToolResults` 确保重试时 API 不会拒绝。

3. **pi 自己解析 SSE 而不是依赖 SDK**:`client.messages.create(...).asResponse()` 只获取原始 `Response`,SSE 字节流的切割、字段解析、JSON 解析、完整性校验全在 `iterateSseMessages` + `iterateAnthropicEvents` 里,pi 完全掌控错误边界。

4. **cache_control 的三点标注策略**:system + tools + last user message 最后一个 block 各加一个 `cache_control: { type: "ephemeral" }`。Anthropic 的 prefix caching 按最长公共前缀命中,三点标注让三段内容都有机会被缓存,最大化 cache hit rate。

5. **OAuth 工具名双向映射是协议约束**:OAuth token 绑定 Claude Code 身份,API 端对工具名有白名单。`toClaudeCodeName`/`fromClaudeCodeName` 在请求和响应之间维护双向映射,上层 agentLoop 永远看到的是小写工具名(与注册时一致),翻译层完全透明。
