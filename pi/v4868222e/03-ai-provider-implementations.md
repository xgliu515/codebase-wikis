# 第 03 章 AI 层:Provider 实现与统一事件流

> **版本锁定**: 本章内容基于 commit `4868222e`(2026-05-20),
> 所有 `file:line` 引用均指向该快照,后续变更不在本章讨论范围内。

---

## 目录

1. [统一事件流模型](#1-统一事件流模型)
2. [消息格式转换层 transform-messages.ts](#2-消息格式转换层)
3. [Anthropic 家族](#3-anthropic-家族)
4. [Google 家族](#4-google-家族)
5. [OpenAI 家族:三种 API 模式](#5-openai-家族三种-api-模式)
6. [Bedrock / Mistral / Cloudflare](#6-bedrock--mistral--cloudflare)
7. [Faux Provider:测试隔离](#7-faux-provider测试隔离)
8. [GitHub Copilot Headers](#8-github-copilot-headers)
9. [simple-options.ts:选项分层](#9-simple-optionsts选项分层)
10. [多 Provider 分派总览](#10-多-provider-分派总览)

---

## 1 统一事件流模型

### 1.1 设计出发点

各家 LLM API 的流式协议差异极大:Anthropic 用 Server-Sent Events 加自定义事件类型;OpenAI Chat Completions 用 `data:` 前缀的 JSON 行;Gemini 用 SDK 封装的异步迭代器;Bedrock 用 AWS SDK 的 `AsyncIterable`。若上层 agent 逻辑直接消费这些异构流,任何一家 API 的格式变化都会波及全部业务代码。

pi 的解法是在 `packages/ai/src/utils/event-stream.ts` 定义一个与 provider 无关的通道类,所有 provider 的 `stream()` 函数都只负责把原生流翻译进这个通道。

### 1.2 EventStream 核心结构

```typescript
// packages/ai/src/utils/event-stream.ts:4-67
export class EventStream<T, R = T> implements AsyncIterable<T> {
    private queue: T[] = [];
    private waiting: ((value: IteratorResult<T>) => void)[] = [];
    private done = false;
    private finalResultPromise: Promise<R>;
    private resolveFinalResult!: (result: R) => void;

    constructor(
        private isComplete: (event: T) => boolean,
        private extractResult: (event: T) => R,
    ) { ... }

    push(event: T): void { ... }  // provider 侧写入
    end(result?: R): void { ... } // 发送 done 信号
    result(): Promise<R> { ... }  // 等待最终结果
    async *[Symbol.asyncIterator](): AsyncIterator<T> { ... }
}
```

关键设计决策:

- **背压通过微任务实现**:消费者慢时 `push` 入 `queue`;消费者等待时注册 `waiting` callback,`push` 直接 dispatch。这避免了独立协程或 Transform Stream 的额外复杂度。
- **finalResultPromise 双轨**:调用方既可以 `for await` 消费每个事件,也可以直接 `await stream.result()` 跳过中间事件只拿最终 `AssistantMessage`。

### 1.3 AssistantMessageEventStream

```typescript
// packages/ai/src/utils/event-stream.ts:69-83
export class AssistantMessageEventStream
    extends EventStream<AssistantMessageEvent, AssistantMessage>
{
    constructor() {
        super(
            (event) => event.type === "done" || event.type === "error",
            (event) => {
                if (event.type === "done") return event.message;
                if (event.type === "error") return event.error;
                throw new Error("Unexpected event type for final result");
            },
        );
    }
}
```

`AssistantMessageEvent` 是联合类型(`packages/ai/src/types.ts:347-359`),包含 13 种变体:

```
start
text_start / text_delta / text_end
thinking_start / thinking_delta / thinking_end
toolcall_start / toolcall_delta / toolcall_end
done
error
```

### 1.4 一次响应的事件时间线

下图展示一次含 thinking + 文本 + 工具调用的完整响应序列:

```
caller                provider impl             EventStream
  |                        |                        |
  |---stream(model,ctx)--->|                        |
  |                        |--new AMES()----------->|
  |<---AMES(stream)--------|                        |
  |                        |  (HTTP / SDK request)  |
  |                        |<==== SSE / chunk =====)|
  |                        |                        |
  |                        |--push(start)---------->|
  |<==for await============|                        |
  |<---{type:"start"}------|                        |
  |                        |--push(thinking_start)->|
  |<---{type:"thinking_start"}-|                    |
  |                        |--push(thinking_delta)->| (N 次)
  |                        |--push(thinking_end}--->|
  |                        |--push(text_start}----->|
  |                        |--push(text_delta}----->| (M 次)
  |                        |--push(text_end}------->|
  |                        |--push(toolcall_start)->|
  |                        |--push(toolcall_delta)->| (K 次)
  |                        |--push(toolcall_end}--->|
  |                        |--push(done}----------->|
  |                        |--end()---------------->|
  |<---{type:"done",message}---|                    |
  |
  | (stream.result() resolves with final AssistantMessage)
```

**错误路径**:provider 侧 catch 块会 push `{type:"error", reason, error: partialMsg}` 再调用 `end()`,`result()` promise 同样 resolve(不是 reject),上层通过检查 `stopReason === "error"` 来处理失败。

---

## 2 消息格式转换层

### 2.1 职责

`packages/ai/src/providers/transform-messages.ts` 是所有 provider 共享的前处理管道,在每次调用各 provider 专属转换函数之前统一执行以下操作:

1. **视觉降级**:若模型 `input` 不含 `"image"`,把用户消息和工具结果中的图片替换为占位文本(第 35-57 行)。
2. **thinking 块规范化**:跨 provider/model 回放时,把 thinking 块转为普通文本;同 provider 同 model 时保留原始块(第 97-113 行)。
3. **工具调用 ID 规范化**:通过可选 `normalizeToolCallId` 回调按各 provider 规则截断或净化 ID(第 130-139 行)。
4. **孤儿 tool call 修复**:若某次 assistant 消息有 tool call 但后续缺少对应 tool result,自动插入合成的 error result(第 155-218 行)。
5. **跳过错误 assistant 消息**:stopReason 为 `"error"` 或 `"aborted"` 的消息整条丢弃,避免向 API 回放不完整的 turn(第 188-194 行)。

### 2.2 Anthropic vs OpenAI-Completions 消息格式对比

**Anthropic 格式** (转换发生在 `anthropic.ts:convertMessages`):

```typescript
// 工具结果合并到同一个 user 消息
{
    role: "user",
    content: [
        { type: "tool_result", tool_use_id: "...", content: "..." },
        { type: "tool_result", tool_use_id: "...", content: "..." },  // 多个合并
    ]
}
```

**OpenAI Chat Completions 格式** (转换发生在 `openai-completions.ts:convertMessages`):

```typescript
// 工具结果是独立的 tool role 消息,不合并
{ role: "tool", tool_call_id: "...", content: "..." }
{ role: "tool", tool_call_id: "...", content: "..." }
```

**thinking 块的差异**:

| 情况 | Anthropic | OpenAI Completions |
|------|-----------|---------------------|
| 同 model 回放,有 signature | `{type:"thinking", signature}` | `reasoning_content` 字段 |
| 同 model 回放,无 signature | 转为 `{type:"text"}` | 同左 |
| 跨 model | 转为 `{type:"text"}` | 同左,或直接丢弃 |
| 被 redacted | `{type:"redacted_thinking", data}` | 不支持 |

**工具 ID 长度限制**:

| Provider | 最大长度 | 允许字符 |
|----------|----------|----------|
| Anthropic | 64 | `[a-zA-Z0-9_-]` |
| OpenAI Chat Completions | 40 (OpenAI) | `[a-zA-Z0-9_-]` |
| Mistral | 9 | hash 截断 |
| Google | 64 | `[a-zA-Z0-9_-]` (部分模型) |

---

## 3 Anthropic 家族

文件:`packages/ai/src/providers/anthropic.ts`

### 3.1 stream() 骨架

`streamAnthropic` 是 `StreamFunction<"anthropic-messages", AnthropicOptions>` 的实现(`anthropic.ts:428-687`)。核心结构是:

1. 同步创建 `AssistantMessageEventStream` 并立即返回。
2. 启动一个 IIFE async 函数(不阻塞调用方)。
3. 用 `createClient` 构建 Anthropic SDK 客户端(考虑 OAuth / Copilot / Cloudflare 差异)。
4. 调用 `buildParams` 组装 `MessageCreateParamsStreaming`。
5. `client.messages.create({ ...params, stream: true }).asResponse()` 拿到 `Response` 对象。
6. 调用 `iterateAnthropicEvents` 自实现的 SSE 解析器(不使用 SDK 的高层封装,以便精确控制 header 和 beta feature)。
7. 按事件类型 push 到 stream。

```typescript
// anthropic.ts:498-506 (简化)
const response = await client.messages
    .create({ ...params, stream: true }, requestOptions)
    .asResponse();
stream.push({ type: "start", partial: output });

for await (const event of iterateAnthropicEvents(response, options?.signal)) {
    // 按 event.type 分发 ...
}
```

### 3.2 自实现 SSE 解析器

pi 没有使用 Anthropic SDK 的 `stream()` 高层 API,而是调用 `.asResponse()` 拿到原始 `Response`,再自己实现 `iterateSseMessages` 和 `iterateAnthropicEvents`(`anthropic.ts:328-426`)。

原因:需要在 Copilot / Cloudflare AI Gateway 等非官方端点使用 Anthropic 消息协议,这些端点往往不支持 SDK 层的某些 beta header 或要求特定的认证头;直接操作 `Response` 流允许按需注入任意 header,而无需 hack SDK 内部状态。

### 3.3 工具调用与 thinking 支持

**工具调用流式接收**:

Anthropic 流的 `content_block_start`(type=`tool_use`)创建工具块;`content_block_delta`(type=`input_json_delta`)流式追加 JSON 片段;`content_block_stop` 触发 `parseStreamingJson` 完成 JSON 解析。

`eager_input_streaming`(2025-05-14 beta):当 provider 支持时,在工具调用 delta 阶段就推送 `toolcall_delta` 事件,使上层可以实时渲染工具参数;不支持时退回到 `fine-grained-tool-streaming` beta 头(`anthropic.ts:164,787-791`)。

**thinking 的三种 API 模式**:

```typescript
// anthropic.ts:948-965 (简化)
if (supportsAdaptiveThinking(model.id)) {
    // Opus 4.6+, Sonnet 4.6: adaptive thinking
    params.thinking = { type: "adaptive", display };
    if (options.effort) {
        params.output_config = { effort: options.effort };
    }
} else {
    // 旧模型: budget-based
    params.thinking = {
        type: "enabled",
        budget_tokens: options.thinkingBudgetTokens || 1024,
        display,
    };
}
```

`thinking_delta` 携带 thinking 文本;`signature_delta` 携带不透明的加密签名,用于跨 turn 传递 thinking 上下文(`anthropic.ts:598-605`)。被 safety filter redact 的 thinking 以 `redacted_thinking` content block 形式返回,signature 存入 `thinkingSignature` 字段,replay 时原样回传(`anthropic.ts:536-545`)。

### 3.4 Prompt Caching

```typescript
// anthropic.ts:54-67
function getCacheControl(model, cacheRetention?) {
    const retention = resolveCacheRetention(cacheRetention);
    if (retention === "none") return { retention };
    const ttl = retention === "long" && compat.supportsLongCacheRetention
        ? "1h"
        : undefined;
    return {
        retention,
        cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
    };
}
```

`cache_control: { type: "ephemeral" }` 被标注在三个位置:
1. `system` 提示词的最后一个文本块(`anthropic.ts:908-924`)。
2. `tools` 数组的最后一个工具定义(`anthropic.ts:1185`)。
3. `messages` 数组的最后一条 user 消息的最后一个 block(`anthropic.ts:1134-1156`)。

这三点覆盖了 Anthropic 缓存的三个"锚点",满足官方关于"缓存可以在这三处截断的最大前缀"的要求。

**`cacheRetention`**(`types.ts:75`):

| 值 | Anthropic TTL | 说明 |
|----|---------------|------|
| `"none"` | 不添加 cache_control | 禁用缓存 |
| `"short"` | 默认(5 分钟) | 适合低频 session |
| `"long"` | `ttl: "1h"` (支持时) | 适合长 agent 循环 |

### 3.5 OAuth 模式的特殊处理

当 `apiKey` 包含 `sk-ant-oat` 时,视为 OAuth token(`anthropic.ts:771-773`),会:

1. 使用 `authToken` 而非 `apiKey` 初始化 Anthropic 客户端(OAuth 用 `Authorization: Bearer`)。
2. 在 beta header 中追加 `claude-code-20250219` 和 `oauth-2025-04-20`。
3. 设置 `user-agent: claude-cli/2.1.75` 和 `x-app: cli`,伪装为 Claude Code 客户端(`anthropic.ts:848-861`)。
4. 工具名称转换为 Claude Code 的 canonical casing(`anthropic.ts:95-98`)。

---

## 4 Google 家族

### 4.1 三个文件的分工

```
providers/
  google-shared.ts    -- 消息转换 + 工具转换 + 辅助函数(两端共用)
  google.ts           -- Gemini API (ai.google.dev) 实现
  google-vertex.ts    -- Vertex AI 实现(GCP 部署)
```

`google-shared.ts` 输出 `convertMessages`、`convertTools`、`isThinkingPart`、`mapStopReason` 等函数,两端直接 import 使用(`google.ts:28-33`,`google-vertex.ts:29-35`)。这个分层使 Vertex 端的主体代码只需处理认证和 URL 差异,不需要重复消息格式逻辑。

### 4.2 Gemini 流式响应特点

Gemini 不像 Anthropic 那样用 `content_block_start/stop` 定界:每个 chunk 直接包含完整的 `parts` 数组。pi 需要自行检测内容类型切换:

```typescript
// google.ts:96-127 (简化)
for (const part of candidate.content.parts) {
    const isThinking = isThinkingPart(part);
    if (!currentBlock ||
        (isThinking && currentBlock.type !== "thinking") ||
        (!isThinking && currentBlock.type !== "text"))
    {
        // 类型切换:先 end 旧块,再 start 新块
        if (currentBlock) { /* push *_end */ }
        currentBlock = isThinking
            ? { type: "thinking", thinking: "" }
            : { type: "text", text: "" };
        /* push *_start */
    }
    // 追加到 currentBlock
}
```

**`thought: true` 标志**(`google-shared.ts:33`):Gemini 通过 `part.thought === true` 标记 thinking 内容;`thoughtSignature` 是不透明字节串,用于跨 turn 保留推理上下文,可出现在任意 part 类型上(文本、工具调用),不代表该 part 是 thinking 内容本身(`google-shared.ts:18-34`)。

**工具调用 ID**:Gemini 对大多数原生模型不要求 tool call ID;但通过 Cloud Code Assist 路由 Claude/GPT 模型时需要(`google-shared.ts:70-72`)。

### 4.3 thinking 控制:thinkingBudget vs thinkingLevel

| 模型 | 控制方式 | 说明 |
|------|----------|------|
| Gemini 2.x | `thinkingBudget` (整数 token 上限) | 0 = 禁用,−1 = 动态 |
| Gemini 3 Flash/Lite | `thinkingLevel` enum | `MINIMAL/LOW/MEDIUM/HIGH` |
| Gemini 3.1 Pro | `thinkingLevel` enum | 无法完全禁用,最低 `LOW` |
| Gemma 4 | `thinkingLevel` enum | 同 Flash |

`getDisabledThinkingConfig`(`google.ts:410-426`)按模型 ID 选择正确的禁用策略。

### 4.4 Vertex AI 差异

**认证**:`google-vertex.ts` 优先使用 `GOOGLE_CLOUD_API_KEY`,次用 ADC(`createClientWithApiKey` vs `createClient`)。`createClient` 需要 `project` 和 `location` 参数,分别从 `GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION` 读取(`google-vertex.ts:409-425`)。

**URL**:通过 `buildHttpOptions` 处理 baseUrl 模板替换(`google-vertex.ts:359-378`);若 baseUrl 已含版本路径(`/v1` 等),将 `apiVersion` 置空以避免重复追加。

**工具格式**:对 Claude/GPT 模型使用 `useParameters=true`(OpenAPI 3.03 Schema);原生 Gemini 使用 `parametersJsonSchema`(full JSON Schema,含 `anyOf/oneOf/const` 等)(`google-shared.ts:272-288`)。

---

## 5 OpenAI 家族:三种 API 模式

### 5.1 openai-completions.ts:传统 Chat Completions

对应 API:`POST /v1/chat/completions`(OpenAI 及大量兼容端点)。

**`getCompat`**:根据 `model.baseUrl` 自动检测兼容性开关,如 `supportsDeveloperRole`(仅 OpenAI 官方端点)、`maxTokensField`(旧版 `max_tokens` vs 新版 `max_completion_tokens`)、`thinkingFormat`(openai / openrouter / deepseek / together / zai / qwen)。`model.compat` 可覆盖自动检测结果(`types.ts:365-400`)。

**reasoning 格式分发** (`openai-completions.ts:563-605`):

```typescript
if (compat.thinkingFormat === "deepseek") {
    params.thinking = { type: options.reasoningEffort ? "enabled" : "disabled" };
    params.reasoning_effort = ...;
} else if (compat.thinkingFormat === "openrouter") {
    params.reasoning = { effort: ... };
} else if (compat.supportsReasoningEffort) {
    params.reasoning_effort = ...;
}
```

不同 provider 对 reasoning 参数字段命名不一致,这里做了统一映射。

**Anthropic-style cache_control 支持**(`openai-completions.ts:638-684`):对设置了 `cacheControlFormat: "anthropic"` 的 compat provider(如通过 LiteLLM 代理的 Anthropic),在消息数组上应用 Anthropic 风格的 `cache_control` 标注。

### 5.2 openai-responses.ts / openai-responses-shared.ts:Responses API

对应 API:`POST /v1/responses`(OpenAI 新 API,2025 年上线)。

主要差异:
- 输入字段为 `input` 而非 `messages`。
- 系统提示词用 `developer` role(推理模型)或 `system` role。
- 工具调用 ID 格式:`{call_id}|{item_id}`,item_id 可达 450+ 字符含特殊符号。
- 支持 `prompt_cache_key` + `prompt_cache_retention` 控制缓存。

`processResponsesStream`(`openai-responses-shared.ts`)是两个 Responses API provider(openai-responses 和 azure-openai-responses)共享的流处理函数,避免重复实现。

**textSignature** 机制:Responses API 回传的 reasoning item 携带 ID,pi 将其编码为 `TextSignatureV1 JSON` 存入 `textContent.textSignature`,多 turn replay 时用于关联 previous_response_id(`openai-responses-shared.ts:40-64`)。

### 5.3 openai-prompt-cache.ts

```typescript
// openai-prompt-cache.ts:1-8
export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function clampOpenAIPromptCacheKey(
    key: string | undefined,
): string | undefined {
    if (key === undefined) return undefined;
    const chars = Array.from(key);
    if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
    return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
```

OpenAI 的 `prompt_cache_key` 上限 64 个 Unicode 码点(非 UTF-8 字节),`Array.from` 保证按 code point 截断。该 key 通常来自 `options.sessionId`,使 OpenAI 将同一 session 的请求路由到相同缓存副本。

### 5.4 azure-openai-responses.ts

在 `openai-responses.ts` 基础上使用 `AzureOpenAI` 客户端,需额外参数:

| 参数 | 来源 |
|------|------|
| `azureApiVersion` | 选项 / `DEFAULT_AZURE_API_VERSION="v1"` |
| `azureResourceName` | 选项 / `AZURE_OPENAI_RESOURCE_NAME` |
| `azureDeploymentName` | 选项 / `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 映射 / model.id |

Deployment Name Map 格式:`model-a=deploy-1,model-b=deploy-2`,允许同一 registry 中的多个模型映射到不同的 Azure 部署(`azure-openai-responses.ts:23-35`)。

### 5.5 openai-codex-responses.ts

Codex provider 连接 `https://chatgpt.com/backend-api`,使用 WebSocket 传输(也支持 SSE fallback)。特有配置:

- `textVerbosity`:`"low" | "medium" | "high"`,控制响应的详细程度。
- `serviceTier`:控制调度优先级。
- `WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009`:WS 关闭时的特殊错误处理。
- JWT 解析:token 的 `https://api.openai.com/auth` claim 中携带 `chatgpt_account_id`。
- 内置重试:最多 3 次,基础延迟 1s 指数退避(`openai-codex-responses.ts:50-55`)。

---

## 6 Bedrock / Mistral / Cloudflare

### 6.1 Amazon Bedrock

文件:`packages/ai/src/providers/amazon-bedrock.ts`

使用 `@aws-sdk/client-bedrock-runtime` 的 `ConverseStreamCommand`。认证通过 AWS SDK 的 credential chain 自动处理(不是 API key):

- IAM 角色(EC2/ECS task role)
- `~/.aws/credentials` profile
- 环境变量 `AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY`
- Bearer token(`AWS_BEARER_TOKEN_BEDROCK`,需 `bedrock:CallWithBearerToken` 权限)

`NodeHttpHandler` 用于代理支持(`amazon-bedrock.ts:46`),通过 `createHttpProxyAgentsForTarget` 注入。

Bedrock 的 `CachePointType` 和 `CacheTTL` 直接映射 pi 的 `CacheRetention`。`ConverseStream` 事件类型(`ContentBlockStartEvent`、`ContentBlockDeltaEvent`等)与 Anthropic SSE 事件近似,因为 Bedrock Converse 底层路由到 Claude。

**企业考量**:Bedrock 不暴露原始 HTTP response headers,因此 `onResponse` 回调收到的 headers 是空对象;`requestMetadata` 字段支持 AWS Cost Explorer 成本分摊标签。

### 6.2 Mistral

文件:`packages/ai/src/providers/mistral.ts`

使用 `@mistralai/mistralai` 官方 SDK。特殊点:
- Mistral tool call ID 最大 9 字符,通过 `shortHash` 截断(`mistral.ts:32`)。
- SDK 每次请求创建新实例以避免并发时的共享状态问题(`mistral.ts:66`)。
- `reasoningEffort: "none" | "high"` 对应 Mistral 的两档思考模式;`promptMode: "reasoning"` 切换到推理模式。

### 6.3 Cloudflare

文件:`packages/ai/src/providers/cloudflare.ts`

这个文件本身只定义 URL 常量和工具函数,没有独立的 stream 实现:

```typescript
// cloudflare.ts:24-35
export function resolveCloudflareBaseUrl(model: Model<Api>): string {
    return url.replace(/\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name) => {
        const value = process.env[name];
        if (!value) throw new Error(`${name} is required...`);
        return value;
    });
}
```

`{CLOUDFLARE_ACCOUNT_ID}`、`{CLOUDFLARE_GATEWAY_ID}` 等占位符在运行时从环境变量展开。Cloudflare Workers AI 走 `openai-completions` API;Cloudflare AI Gateway 根据后端 provider 选择对应实现(Anthropic 后端走 `anthropic.ts`,OpenAI 后端走 `openai-responses.ts`)。

---

## 7 Faux Provider:测试隔离

文件:`packages/ai/src/providers/faux.ts`

### 7.1 存在的理由

pi 的 agent 循环可能执行数十轮 tool call。集成测试如果真实调用 LLM API:

1. 耗时 + 费用高。
2. 响应内容不确定,断言难以稳定。
3. 无法轻易模拟错误、重试、中断等边界情况。

Faux provider 提供一个完整实现了 `StreamFunction` 协议的"假" provider,支持预设响应队列、控制流速、模拟缓存命中。

### 7.2 注册与使用

```typescript
// faux.ts:391-499 (核心结构)
export function registerFauxProvider(options = {}): FauxProviderRegistration {
    const api = options.api ?? randomId("faux");
    let pendingResponses: FauxResponseStep[] = [];

    const stream: StreamFunction = (model, context, streamOptions) => {
        const outer = createAssistantMessageEventStream();
        const step = pendingResponses.shift();

        queueMicrotask(async () => {
            const resolved = typeof step === "function"
                ? await step(context, streamOptions, state, model)
                : step;
            await streamWithDeltas(outer, resolved, minTokenSize, maxTokenSize, ...);
        });

        return outer;
    };

    registerApiProvider({ api, stream, streamSimple }, sourceId);
    return { getModel, setResponses, appendResponses, unregister, ... };
}
```

`FauxResponseStep` 是 `AssistantMessage | FauxResponseFactory`,工厂函数允许根据上下文动态生成响应,用于测试 agent 状态机的条件分支。

### 7.3 流速控制

`streamWithDeltas` 把 `AssistantMessage` 的 content blocks 拆成随机大小(min/max token size)的 chunk,通过 `scheduleChunk` 模拟流速:

```typescript
// faux.ts:288-294
function scheduleChunk(chunk: string, tokensPerSecond: number | undefined): Promise<void> {
    if (!tokensPerSecond || tokensPerSecond <= 0) {
        return new Promise((resolve) => queueMicrotask(resolve));
    }
    const delayMs = (estimateTokens(chunk) / tokensPerSecond) * 1000;
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
```

### 7.4 缓存命中模拟

`withUsageEstimate` 维护一个 `Map<sessionId, promptText>`,对比当前 prompt 与缓存 prompt 的公共前缀长度,估算 `cacheRead` / `cacheWrite` token 数,使上层的缓存命中逻辑可以在纯离线测试中得到验证。

---

## 8 GitHub Copilot Headers

文件:`packages/ai/src/providers/github-copilot-headers.ts`

GitHub Copilot API 要求特定 HTTP header 才能正常路由请求:

```typescript
// github-copilot-headers.ts:23-37
export function buildCopilotDynamicHeaders(params: {
    messages: Message[];
    hasImages: boolean;
}): Record<string, string> {
    return {
        "X-Initiator": inferCopilotInitiator(params.messages),
        "Openai-Intent": "conversation-edits",
        ...(params.hasImages ? { "Copilot-Vision-Request": "true" } : {}),
    };
}
```

**`X-Initiator`**:最后一条消息不是 user 时值为 `"agent"`,否则为 `"user"`。这告诉 Copilot 后端请求是 agent 主动发起(如工具结果后续)还是用户输入触发。

**`Copilot-Vision-Request: true`**:只在消息链中存在图片时发送。Copilot 需要这个 header 才会将请求路由到具备视觉能力的模型端点。

这两个 header 在 `anthropic.ts:466-471` 和 `openai-completions.ts:466-472` / `openai-responses.ts:197-204` 中分别被调用,即 Copilot 可以走 Anthropic API 协议也可以走 OpenAI 协议。

---

## 9 simple-options.ts:选项分层

文件:`packages/ai/src/providers/simple-options.ts`

### 9.1 设计意图

每个 provider 有自己的 `XxxOptions`(如 `AnthropicOptions`、`GoogleOptions`),包含 provider 专属字段。但上层 agent 往往只关心通用参数(temperature、maxTokens、signal 等)加上一个抽象的 `reasoning?: ThinkingLevel`。

`SimpleStreamOptions`(`types.ts:192-196`)是面向 agent 层的统一接口;各 provider 的 `streamSimpleXxx` 函数把它翻译到 provider 专属选项。

### 9.2 buildBaseOptions

```typescript
// simple-options.ts:3-20
export function buildBaseOptions(
    _model: Model<Api>,
    options?: SimpleStreamOptions,
    apiKey?: string,
): StreamOptions {
    return {
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        signal: options?.signal,
        apiKey: apiKey || options?.apiKey,
        transport: options?.transport,
        cacheRetention: options?.cacheRetention,
        sessionId: options?.sessionId,
        headers: options?.headers,
        onPayload: options?.onPayload,
        onResponse: options?.onResponse,
        timeoutMs: options?.timeoutMs,
        maxRetries: options?.maxRetries,
        maxRetryDelayMs: options?.maxRetryDelayMs,
        metadata: options?.metadata,
    };
}
```

这个函数把所有通用字段原样透传,屏蔽了 provider 专属字段(`reasoning`、`thinkingBudgets` 等)。

### 9.3 adjustMaxTokensForThinking

旧版 Anthropic 模型的 thinking 占用 `max_tokens` 预算:

```typescript
// simple-options.ts:26-52
export function adjustMaxTokensForThinking(
    baseMaxTokens: number | undefined,
    modelMaxTokens: number,
    reasoningLevel: ThinkingLevel,
    customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
    const budgets = { minimal:1024, low:2048, medium:8192, high:16384 };
    let thinkingBudget = budgets[level];
    const maxTokens = baseMaxTokens === undefined
        ? modelMaxTokens
        : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);
    if (maxTokens <= thinkingBudget) {
        thinkingBudget = Math.max(0, maxTokens - 1024);
    }
    return { maxTokens, thinkingBudget };
}
```

调用方(如 `streamSimpleAnthropic`)只需传入 `reasoning level`,不需要手动计算 token budget,分层设计让 budget 策略集中维护。

---

## 10 多 Provider 分派总览

```
调用方 (agent / user code)
    |
    | stream(model, context, options?)
    v
packages/ai/src/stream.ts
    |
    | 查 api-registry: model.api -> StreamFunction
    |
    +--[anthropic-messages]------> streamAnthropic()
    |                                   |
    |                                   +-- createClient() [Anthropic SDK]
    |                                   +-- buildParams()
    |                                   +-- iterateAnthropicEvents()  <-- 自实现 SSE
    |                                   +-- push events to AMES
    |
    +--[openai-completions]------> streamOpenAICompletions()
    |                                   |
    |                                   +-- createClient() [OpenAI SDK]
    |                                   +-- buildParams() + getCompat()
    |                                   +-- client.chat.completions.create()
    |                                   +-- push events to AMES
    |
    +--[openai-responses]--------> streamOpenAIResponses()
    |                                   |
    |                                   +-- client.responses.create()
    |                                   +-- processResponsesStream() [shared]
    |
    +--[azure-openai-responses]--> streamAzureOpenAIResponses()
    |                                   |
    |                                   +-- AzureOpenAI SDK
    |                                   +-- processResponsesStream() [shared]
    |
    +--[openai-codex-responses]--> streamOpenAICodexResponses()
    |                                   |
    |                                   +-- WebSocket / SSE  <-- chatgpt.com
    |                                   +-- processResponsesStream() [shared]
    |
    +--[google-generative-ai]----> streamGoogle()
    |                                   |
    |                                   +-- GoogleGenAI SDK
    |                                   +-- generateContentStream()
    |                                   +-- isThinkingPart() [shared]
    |
    +--[google-vertex]-----------> streamGoogleVertex()
    |                                   |
    |                                   +-- GoogleGenAI(vertexai:true)
    |                                   +-- ADC / API key auth
    |                                   +-- isThinkingPart() [shared]
    |
    +--[bedrock-converse-stream]-> streamBedrock()
    |                                   |
    |                                   +-- BedrockRuntimeClient
    |                                   +-- ConverseStreamCommand
    |                                   +-- SigV4 / Bearer token auth
    |
    +--[mistral-conversations]---> streamMistral()
    |                                   |
    |                                   +-- Mistral SDK
    |                                   +-- chat.stream()
    |
    +--[faux]--------------------> stream() [in-memory]
                                        |
                                        +-- pendingResponses queue
                                        +-- streamWithDeltas()

每条路径的终点都是同一个 AssistantMessageEventStream (AMES),
向上层暴露统一的 AsyncIterable<AssistantMessageEvent> 接口。
```

**共享基础设施**:

| 组件 | 被哪些 Provider 使用 |
|------|----------------------|
| `transform-messages.ts` | 全部 provider |
| `openai-responses-shared.ts` | openai-responses, azure-openai-responses, openai-codex-responses |
| `google-shared.ts` | google, google-vertex |
| `simple-options.ts` | 全部 provider 的 `streamSimpleXxx` |
| `github-copilot-headers.ts` | anthropic, openai-completions, openai-responses |
| `cloudflare.ts` | anthropic, openai-completions, openai-responses |
| `openai-prompt-cache.ts` | openai-completions, openai-responses, azure-openai-responses, openai-codex-responses |
