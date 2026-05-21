# Tour 步骤 11:SSE → AssistantMessageEventStream 事件化

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:HTTP POST 已成功,Anthropic SSE 流已建立,首批 `event: message_start\ndata: {...}` 正在到达响应体的 `ReadableStream`。

**下一步起点**:agent-loop 正在消费事件流。已收到若干 `TextEvent`(模型可能先输出 "我来读一下" 之类的文字),接下来将收到一个完整的 `toolcall_end` 事件,其 `toolCall` 字段为 `{ type:"toolCall", name:"read", arguments:{path:"README.md"} }`。

---

## 1. 当前情境

SSE 流的字节在 `response.body`(一个 `ReadableStream<Uint8Array>`)中陆续到达。此时:

- 进程持有 `stream: AssistantMessageEventStream`,这是 `streamAnthropic` 同步返回的对象,agent-loop 已经在对它进行 `for await`。
- Anthropic 原生事件以 `event: <type>\ndata: <json>\n\n` 的格式交替到来,其中六种事件受关注:`message_start`、`content_block_start`、`content_block_delta`、`content_block_stop`、`message_delta`、`message_stop`。
- 对于本次 trace,模型响应结构为:thinking 块 → text 块 → tool_use 块,每种块各自经历 `_start`/`_delta*`/`_stop` 三阶段。

---

## 2. 问题

本步需要回答三个具体问题:

1. **字节流如何变成离散的 `ServerSentEvent` 对象**——SSE 是文本协议,字节可能跨越多个 `read()` 调用到达,必须有缓冲拼接逻辑。

2. **thinking 块、text 块、tool_use 块各自产生哪些 `AssistantMessageEvent`**——上层(agent-loop)只关心 pi 统一的事件类型,不关心 Anthropic 原生格式。

3. **`UsageEvent` 何时发射**——token 计数分两次到达:一次在 `message_start`,一次在 `message_delta`,两次必须都被捕获,否则缓存命中量会丢失。

---

## 3. 朴素思路

直接在请求处直接使用 Anthropic SDK 的高层迭代器(`stream.on("message", ...)`),由 SDK 完成 SSE 解析。优点是不用维护自己的 SSE 解析器。

---

## 4. 为什么朴素思路会崩

SDK 的高层流模式(`client.messages.stream()`)在请求层面隐藏了原始 HTTP 响应,导致三个问题:

1. **无法注入 `onResponse` 回调**:pi 需要在读取响应体之前检查 HTTP 响应头(session affinity、错误状态码)。`client.messages.create({stream:true}).asResponse()` 才能暴露原始 `Response` 对象(`anthropic.ts:498`)。

2. **无法复用同一 `Anthropic` 客户端实例跨请求**:pi 的 OAuth 路径需要在每次调用前动态刷新 token,必须持有裸客户端。

3. **SSE 解析器自实现**:pi 用了 `fine-grained-tool-streaming-2025-05-14` beta,某些代理服务器(Cloudflare AI Gateway、Fireworks)不支持这个 beta header,自实现解析器可以精确控制 beta 开关(`anthropic.ts:164,788-791`)。

---

## 5. pi 的做法

### 5.1 SSE 解析器三层管道

```
ReadableStream<Uint8Array>
       |
       | iterateSseMessages()          anthropic.ts:328-385
       |   TextDecoder + buffer + consumeLine()
       |   每遇到空行就 flushSseEvent()
       v
AsyncGenerator<ServerSentEvent>         { event, data, raw }
       |
       | iterateAnthropicEvents()       anthropic.ts:387-426
       |   过滤非 Anthropic 事件类型
       |   JSON.parse(sse.data)
       v
AsyncGenerator<RawMessageStreamEvent>   Anthropic SDK 类型
       |
       | streamAnthropic() 主循环       anthropic.ts:505-661
       |   按 event.type 分支处理
       v
AssistantMessageEventStream             event-stream.ts:69-83
```

**`consumeLine`**(`anthropic.ts:311-326`)处理 `\n`/`\r`/`\r\n` 三种换行,循环直到 buffer 中没有完整行为止,确保跨 chunk 的行被正确拼合。

**`decodeSseLine`**(`anthropic.ts:273-297`)解析单行:空行触发 `flushSseEvent`;以 `:` 开头的行是注释,直接忽略;否则按 `field: value` 格式填充 `SseDecoderState.event` 或 `.data`。

### 5.2 content_block_start 三种 block 类型

`content_block_start` 事件携带 `event.content_block.type`,pi 在 `anthropic.ts:518-558` 处理三种情况:

| `content_block.type` | 创建的 Block | 推送的 AssistantMessageEvent |
|---|---|---|
| `text` | `{type:"text", text:""}` | `text_start` |
| `thinking` | `{type:"thinking", thinking:"", thinkingSignature:""}` | `thinking_start` |
| `redacted_thinking` | `{type:"thinking", thinking:"[Reasoning redacted]", thinkingSignature: data, redacted:true}` | `thinking_start` |
| `tool_use` | `{type:"toolCall", id, name, arguments:{}, partialJson:""}` | `toolcall_start` |

### 5.3 thinking 块的三种模式

pi 支持三种 thinking 形态,均映射到同一个 `ThinkingContent` 类型(`types.ts:230-238`):

**(a) 普通 thinking**:模型返回可见的推理文本。`content_block_delta.delta.type === "thinking_delta"` 时,`block.thinking += event.delta.thinking`(`anthropic.ts:577`)。`signature_delta` 积累加密签名 `block.thinkingSignature`(`anthropic.ts:598-604`),用于后续多轮对话时原样回传 API。

**(b) 总结型 thinking(summarized)**:通过 `params.thinking = { type: "adaptive", display: "summarized" }` 请求(`anthropic.ts:951`),API 返回经过压缩的推理摘要。从解析角度与普通 thinking 完全相同,只是 `thinking` 字符串更短。

**(c) 已编辑 thinking(redacted)**:`content_block_start.content_block.type === "redacted_thinking"`,此时 pi 用 `data`(加密 payload)作为 `thinkingSignature`(`anthropic.ts:536-545`)。回传时,`convertMessages` 把它转换为 `{ type:"redacted_thinking", data: block.thinkingSignature }`(`anthropic.ts:1062`)。

### 5.4 tool_use 块的流式参数累积

tool_use 块的 JSON 参数分多个 `input_json_delta` delta 到来:

```
content_block_start  ->  partialJson = ""
input_json_delta     ->  partialJson += '{"pa'        anthropic.ts:589
input_json_delta     ->  partialJson += 'th":"RE'
input_json_delta     ->  partialJson += 'ADME.md"}'
content_block_stop   ->  parseStreamingJson(partialJson)  anthropic.ts:626
                         delete block.partialJson
                         push toolcall_end { toolCall }
```

`parseStreamingJson`(`utils/json-parse.ts`)在每次 delta 后都尝试解析不完整 JSON,对 agent-loop 的流式渲染有用,但 `toolcall_end` 才是最终权威(`anthropic.ts:626`)。`partialJson` 字段是流式暂存缓冲区,`content_block_stop` 处理后立即 `delete`(`anthropic.ts:629`),不会出现在最终 `AssistantMessage` 里。

### 5.5 UsageEvent 发射时机

pi 不单独发射 `UsageEvent`,而是把 token 计数内嵌在每个 `AssistantMessageEvent.partial`(即当前 `output` 对象)中。usage 分两次更新:

- **`message_start`**(`anthropic.ts:507-517`):写入 `output.usage.input`、`output.usage.cacheRead`、`output.usage.cacheWrite`。这是缓存命中数据的唯一来源——某些代理在 `message_delta` 中省略这些字段。
- **`message_delta`**(`anthropic.ts:638-659`):更新 `output.usage.output`(输出 token 数),仅在字段非 `null` 时覆盖,保留 `message_start` 中读取的输入/缓存字段。

最终在 `done` 事件里的 `message.usage` 包含完整的四项:input、output、cacheRead、cacheWrite。

<svg viewBox="0 0 880 620" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Anthropic SSE 原生事件到 AssistantMessageEventStream 推送的完整时序">
  <defs>
    <marker id="arT11" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="880" height="620" fill="#f8fafc" rx="6"/>
  <text x="440" y="26" text-anchor="middle" font-size="14" font-weight="600" fill="#1e293b">SSE 事件时序:Anthropic 原生 → AssistantMessageEventStream</text>
  <rect x="20" y="40" width="390" height="30" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="215" y="59" text-anchor="middle" font-size="12" font-weight="600" fill="#9a3412">Anthropic SSE 原生事件</text>
  <rect x="470" y="40" width="390" height="30" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="665" y="59" text-anchor="middle" font-size="12" font-weight="600" fill="#134e4a">AssistantMessageEventStream 推送</text>
  <line x1="440" y1="40" x2="440" y2="620" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <rect x="20" y="82" width="370" height="28" rx="4" fill="#fef3c7" stroke="#f59e0b" stroke-width="1"/>
  <text x="205" y="100" text-anchor="middle" font-size="10" fill="#92400e">message_start {usage:{input:...}}</text>
  <line x1="390" y1="96" x2="460" y2="96" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT11)"/>
  <text x="465" y="91" font-size="9" fill="#64748b">output.usage.input 更新</text>
  <rect x="465" y="100" width="385" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="657" y="115" text-anchor="middle" font-size="9" fill="#0d9488">push { type:"start", partial:output }</text>
  <rect x="20" y="134" width="370" height="28" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="205" y="152" text-anchor="middle" font-size="10" fill="#4c1d95">content_block_start {type:thinking}</text>
  <line x1="390" y1="148" x2="460" y2="148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT11)"/>
  <rect x="465" y="136" width="385" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="657" y="151" text-anchor="middle" font-size="9" fill="#0d9488">push { type:"thinking_start", ... }</text>
  <rect x="20" y="166" width="370" height="22" rx="3" fill="#ede9fe" stroke="#a78bfa" stroke-width="1"/>
  <text x="205" y="181" text-anchor="middle" font-size="9" fill="#5b21b6">content_block_delta thinking_delta (×N)</text>
  <line x1="390" y1="177" x2="460" y2="177" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT11)"/>
  <rect x="465" y="166" width="385" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="657" y="181" text-anchor="middle" font-size="9" fill="#0d9488">push { type:"thinking_delta", delta }</text>
  <text x="205" y="204" text-anchor="middle" font-size="9" fill="#94a3b8">signature_delta → (积累 thinkingSignature,不推送)</text>
  <rect x="20" y="210" width="370" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="205" y="225" text-anchor="middle" font-size="9" fill="#4c1d95">content_block_stop</text>
  <line x1="390" y1="221" x2="460" y2="221" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT11)"/>
  <rect x="465" y="210" width="385" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="657" y="225" text-anchor="middle" font-size="9" fill="#0d9488">push { type:"thinking_end", content }</text>
  <line x1="440" y1="238" x2="440" y2="250" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="3,2"/>
  <rect x="20" y="252" width="370" height="28" rx="4" fill="#dbeafe" stroke="#3b82f6" stroke-width="1"/>
  <text x="205" y="270" text-anchor="middle" font-size="10" fill="#1e40af">content_block_start {type:text}</text>
  <line x1="390" y1="266" x2="460" y2="266" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT11)"/>
  <rect x="465" y="254" width="385" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="657" y="269" text-anchor="middle" font-size="9" fill="#0d9488">push { type:"text_start", ... }</text>
  <rect x="20" y="284" width="370" height="22" rx="3" fill="#eff6ff" stroke="#93c5fd" stroke-width="1"/>
  <text x="205" y="299" text-anchor="middle" font-size="9" fill="#1d4ed8">content_block_delta text_delta (×N)</text>
  <line x1="390" y1="295" x2="460" y2="295" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT11)"/>
  <rect x="465" y="284" width="385" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="657" y="299" text-anchor="middle" font-size="9" fill="#0d9488">push { type:"text_delta", delta }</text>
  <rect x="20" y="310" width="370" height="22" rx="3" fill="#dbeafe" stroke="#3b82f6" stroke-width="1"/>
  <text x="205" y="325" text-anchor="middle" font-size="9" fill="#1e40af">content_block_stop</text>
  <line x1="390" y1="321" x2="460" y2="321" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT11)"/>
  <rect x="465" y="310" width="385" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="657" y="325" text-anchor="middle" font-size="9" fill="#0d9488">push { type:"text_end", content }</text>
  <line x1="440" y1="338" x2="440" y2="350" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="3,2"/>
  <rect x="20" y="352" width="370" height="28" rx="4" fill="#d1fae5" stroke="#10b981" stroke-width="1"/>
  <text x="205" y="370" text-anchor="middle" font-size="10" fill="#065f46">content_block_start {type:tool_use}</text>
  <line x1="390" y1="366" x2="460" y2="366" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT11)"/>
  <rect x="465" y="354" width="385" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="657" y="369" text-anchor="middle" font-size="9" fill="#0d9488">push { type:"toolcall_start", ... }</text>
  <rect x="20" y="384" width="370" height="22" rx="3" fill="#ecfdf5" stroke="#6ee7b7" stroke-width="1"/>
  <text x="205" y="399" text-anchor="middle" font-size="9" fill="#065f46">content_block_delta input_json_delta (×N)</text>
  <line x1="390" y1="395" x2="460" y2="395" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT11)"/>
  <rect x="465" y="384" width="385" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="657" y="399" text-anchor="middle" font-size="9" fill="#0d9488">push { type:"toolcall_delta", delta }</text>
  <rect x="20" y="410" width="370" height="22" rx="3" fill="#d1fae5" stroke="#10b981" stroke-width="1"/>
  <text x="205" y="425" text-anchor="middle" font-size="9" fill="#065f46">content_block_stop</text>
  <line x1="390" y1="421" x2="460" y2="421" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT11)"/>
  <rect x="465" y="410" width="385" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="657" y="425" text-anchor="middle" font-size="9" fill="#0d9488">push { type:"toolcall_end", toolCall }</text>
  <line x1="440" y1="438" x2="440" y2="450" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="3,2"/>
  <rect x="20" y="452" width="370" height="28" rx="4" fill="#fef3c7" stroke="#f59e0b" stroke-width="1"/>
  <text x="205" y="470" text-anchor="middle" font-size="10" fill="#92400e">message_delta {stop_reason:tool_use}</text>
  <line x1="390" y1="466" x2="460" y2="466" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT11)"/>
  <text x="465" y="462" font-size="9" fill="#64748b">output.stopReason = "toolUse"</text>
  <text x="465" y="476" font-size="9" fill="#64748b">output.usage.output 更新</text>
  <rect x="20" y="484" width="370" height="22" rx="3" fill="#fef9c3" stroke="#fde047" stroke-width="1"/>
  <text x="205" y="499" text-anchor="middle" font-size="9" fill="#713f12">message_stop  → iterateAnthropicEvents 返回</text>
  <rect x="465" y="500" width="385" height="40" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="657" y="516" text-anchor="middle" font-size="9" fill="#134e4a">push { type:"done", reason:"toolUse",</text>
  <text x="657" y="530" text-anchor="middle" font-size="9" fill="#134e4a">message:output }  +  stream.end()</text>
</svg>
<span class="figure-caption">图 T11.1 ｜ 典型一次 tool_use 响应的 SSE 事件时序(含 thinking / text / toolcall 三段)</span>

<details>
<summary>ASCII 原版</summary>

```
Anthropic SSE 原生事件                    AssistantMessageEventStream 推送
─────────────────────────────────────    ─────────────────────────────────
message_start {usage:{input:...}}   -->  (output.usage.input 更新)
                                         push { type:"start", partial:output }

content_block_start {type:thinking} -->  push { type:"thinking_start", ... }
content_block_delta thinking_delta  -->  push { type:"thinking_delta", delta }
  ...更多 thinking_delta...
signature_delta                     -->  (block.thinkingSignature 积累,不推送)
content_block_stop                  -->  push { type:"thinking_end", content }

content_block_start {type:text}     -->  push { type:"text_start", ... }
content_block_delta text_delta      -->  push { type:"text_delta", delta }
  ...更多 text_delta...
content_block_stop                  -->  push { type:"text_end", content }

content_block_start {type:tool_use} -->  push { type:"toolcall_start", ... }
content_block_delta input_json_delta-->  push { type:"toolcall_delta", delta }
  ...更多 input_json_delta...
content_block_stop                  -->  push { type:"toolcall_end", toolCall }

message_delta {stop_reason:tool_use}-->  (output.stopReason = "toolUse")
                                         (output.usage.output 更新)
message_stop                        -->  (iterateAnthropicEvents 返回)

                                         push { type:"done", reason:"toolUse",
                                                message:output }
                                         stream.end()
```

</details>

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/ai/src/providers/anthropic.ts` | 248-255 | `ANTHROPIC_MESSAGE_EVENTS` 白名单 |
| `packages/ai/src/providers/anthropic.ts` | 257-297 | `flushSseEvent` / `decodeSseLine` |
| `packages/ai/src/providers/anthropic.ts` | 299-326 | `nextLineBreakIndex` / `consumeLine` |
| `packages/ai/src/providers/anthropic.ts` | 328-385 | `iterateSseMessages`:字节流→`ServerSentEvent` |
| `packages/ai/src/providers/anthropic.ts` | 387-426 | `iterateAnthropicEvents`:SSE→`RawMessageStreamEvent` |
| `packages/ai/src/providers/anthropic.ts` | 428-687 | `streamAnthropic`:主 IIFE,原生事件→`AssistantMessageEvent` |
| `packages/ai/src/providers/anthropic.ts` | 505-517 | `message_start` 处理,初始 usage 写入 |
| `packages/ai/src/providers/anthropic.ts` | 518-558 | `content_block_start` 三种 block 类型 |
| `packages/ai/src/providers/anthropic.ts` | 560-605 | `content_block_delta`:text/thinking/tool_use/signature |
| `packages/ai/src/providers/anthropic.ts` | 606-637 | `content_block_stop`:终态推送,`partialJson` 清理 |
| `packages/ai/src/providers/anthropic.ts` | 638-660 | `message_delta`:stop_reason + output usage |
| `packages/ai/src/utils/event-stream.ts` | 4-67 | `EventStream` 泛型:push/end/异步迭代 |
| `packages/ai/src/utils/event-stream.ts` | 69-83 | `AssistantMessageEventStream`:isComplete 判定 |
| `packages/ai/src/types.ts` | 347-359 | `AssistantMessageEvent` 联合类型定义 |

---

## 7. 分支与延伸

- **`AssistantMessageEvent` 联合类型与 `EventStream` 的泛型设计**:见 [第 03 章 §1「统一事件流模型」](./03-ai-provider-implementations.md#1-统一事件流模型)。
- **`streamAnthropic` 整体骨架与 SSE 解析器详细实现**:见 [第 03 章 §3「Anthropic 家族」](./03-ai-provider-implementations.md#3-anthropic-家族)。
- **agent-loop 如何消费 `AssistantMessageEvent` 并发射 `AgentEvent`**:见 [第 05 章 §3「AgentEvent 模型」](./05-agent-runtime-loop.md#3-agentevent-模型)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **SSE 解析是 pi 自实现的,不依赖 SDK 高层流**:三层管道(`iterateSseMessages` → `iterateAnthropicEvents` → 主循环)完全在 `anthropic.ts` 内部,给 pi 保留了注入 `onResponse`、控制 beta header、支持代理兼容性的灵活性。

2. **thinking 块三种形态共用同一个 `ThinkingContent` 类型**:普通/summarized 形态通过 `thinking_delta` 流式到来,redacted 形态在 `content_block_start` 时就已完整(加密 payload 在 `data` 字段)。`thinkingSignature` 是多轮对话的关键——丢失它会导致下一轮 API 请求被拒绝。

3. **tool_use 参数的完整性由 `content_block_stop` 保证**:`partialJson` 是流式暂存,每次 delta 后虽然调用 `parseStreamingJson` 更新 `block.arguments` 以供 UI 实时渲染,但 `toolcall_end` 中才做最终 `parseStreamingJson` 并删除 `partialJson`。agent-loop 只在收到 `toolcall_end` 后才获得完整的 `ToolCall` 对象。

4. **usage 分两次写入,缺一不可**:`message_start` 携带 cacheRead/cacheWrite(某些代理在 `message_delta` 省略),`message_delta` 携带最终 output token 数。`calculateCost` 在每次更新后重新计算,确保任何时刻中断都不会丢失已到达的计费数据。
