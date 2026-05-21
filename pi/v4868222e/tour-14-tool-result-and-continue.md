# Tour 步骤 14:tool_result 回喂 -> 二次 stream -> 最终文本

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:`read` 工具已执行完毕,返回文件第一行内容。`executeToolCalls` 拿到 `FinalizedToolCallOutcome`,`createToolResultMessage` 构造出 `ToolResultMessage`,事件 `tool_execution_end` 与 `message_start`/`message_end` 已依次发出。

**下一步起点**:第二轮 `streamAssistantResponse` 完成,模型最终文本完整。`messages` 数组已经是 `[user, assistant_1(tool_use), toolResult, assistant_2(最终文本)]`,外层 `runLoop` 检测到 `hasMoreToolCalls = false` 且无挂起消息,准备发出 `agent_end`。

---

## 1. 当前情境

`read` 工具返回的那一刻,进程处于 `runLoop` 的内层循环(`packages/agent/src/agent-loop.ts:174`)。外层调用栈如下:

```
runLoop (agent-loop.ts:155)
  └─ streamAssistantResponse (第一次 LLM 调用,已完成)
  └─ executeToolCalls (已完成,返回 ToolResultMessage[])
  └─ 即将进入下一次 while 循环
```

`currentContext.messages` 此时已有四条:

| # | role | 内容 |
|---|------|------|
| 0 | `user` | "读一下 README.md 的第一行" |
| 1 | `assistant` | 含 `toolCall { name:"read", id:"tc_xxx" }` |
| 2 | `toolResult` | `{ toolCallId:"tc_xxx", content:[{type:"text",text:"..."}] }` |
| 3 | (未添加) | — |

---

## 2. 问题

本步需要回答三个相互关联的问题:

1. **tool_result 是如何从工具函数的返回值变成 `currentContext.messages` 里的一条记录的**,中间经历了哪些数据转换。

2. **`runLoop` 的外层 while 条件如何决定"要不要再发一次 LLM 请求"**,`hasMoreToolCalls` 与 `pendingMessages` 各自扮演什么角色。

3. **第二次 LLM 请求中,API 拿到什么格式的 tool_result**,`convertToLlm` 如何把内部 `ToolResultMessage` 翻译成 Anthropic 期望的格式。

---

## 3. 朴素思路

最简单的做法:每次工具执行完就直接拼一个字符串"工具返回了 XXX",追加到 user 消息后面,再用同一个 HTTP 连接发送。但这会破坏 Anthropic Messages API 对话格式的强约束(tool_use block 必须有对应的 tool_result block,且必须作为独立的 user-role 轮次出现),同时让消息历史无法被正确解析或重放。

---

## 4. 为什么朴素思路会崩

Anthropic Messages API 要求:

- 模型在 `assistant` 轮中输出了 `tool_use` block(含 `id`),则下一个 `user` 轮必须包含 `tool_result` block,且 `tool_use_id` 必须与之匹配。
- 任何一条 `assistant` 轮和下一条 `user` 轮之间不能插入额外 text。
- 如果模型在一次响应里输出了多个 `tool_use` block,所有 tool_result 必须在同一个 `user` 消息里打包。

因此,tool_result 不能是 text,不能附加到已有消息,必须独立成一条新消息并发给 API。

---

## 5. pi 的做法

**第一步:构造 ToolResultMessage**

`executeToolCallsSequential`(`packages/agent/src/agent-loop.ts:395-449`) 在工具执行完毕后调用 `createToolResultMessage`:

```typescript
// agent-loop.ts:727-737
function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
    return {
        role: "toolResult",
        toolCallId: finalized.toolCall.id,
        toolName: finalized.toolCall.name,
        content: finalized.result.content,
        details: finalized.result.details,
        isError: finalized.isError,
        timestamp: Date.now(),
    };
}
```

这条消息的 `role` 是 pi 内部专用的 `"toolResult"`,不是 Anthropic 的字段。

**第二步:追加到 currentContext.messages**

回到 `runLoop`(`agent-loop.ts:207-215`):

```typescript
// agent-loop.ts:207-215
for (const result of toolResults) {
    currentContext.messages.push(result);
    newMessages.push(result);
}
```

`currentContext.messages` 现在长度为 3(含 toolResult),`newMessages` 也同步更新。

**第三步:内层 while 条件重新求值**

`agent-loop.ts:174` 的条件是 `while (hasMoreToolCalls || pendingMessages.length > 0)`。工具执行完后:

- `hasMoreToolCalls = !executedToolBatch.terminate`
- `read` 工具的结果没有 `terminate: true`,所以 `hasMoreToolCalls = true`
- 内层 while 继续,进入下一次 `streamAssistantResponse`

**第四步:convertToLlm 将 ToolResultMessage 转换为 API 格式**

`streamAssistantResponse`(`agent-loop.ts:289`) 调用 `config.convertToLlm(messages)`,最终走到 `packages/agent/src/harness/messages.ts:120`:

```typescript
// messages.ts:156-158
case "user":
case "assistant":
case "toolResult":
    return m;
```

`toolResult` 类型的 `AgentMessage` 直接透传到 LLM 消息数组——它已经符合 pi-ai 层的 `Message` 接口。pi-ai 层再由 Anthropic provider 的 `transform-messages.ts` 将其转成 API 所需的 JSON(把 `role:"toolResult"` 翻译为 Anthropic 的 `tool_result` block)。

**第五步:第二次 LLM 调用**

`streamSimple` 发出第二次 HTTP 请求。请求体的 `messages` 数组此时有三条:

```
[user, assistant(含 tool_use block), user(含 tool_result block)]
```

模型收到完整上下文后,决定不再调用工具,直接生成文字回复,例如:"README.md 的第一行是 `<p align="center">`。"

**第六步:第二次 stream 处理**

`streamAssistantResponse` 再次循环消费 SSE 事件流:
- `start` -> 把新的 `partialMessage`(role: assistant)推入 `context.messages`
- `text_delta` x N -> 更新 `partialMessage`,发出 `message_update`
- `done` -> `response.result()` 拿到最终 `AssistantMessage`,其中 `stopReason: "end_turn"`

**第七步:runLoop 检测 stopReason**

`streamAssistantResponse` 返回后:

```typescript
// agent-loop.ts:203-210
const toolCalls = message.content.filter((c) => c.type === "toolCall");
// toolCalls.length === 0, 因为最终回复只有 text block
hasMoreToolCalls = false;
```

内层 while 退出,发出 `turn_end`。

<svg viewBox="0 0 760 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="runLoop 内层 while 第二次迭代:工具结果回传 LLM 并结束循环">
  <defs>
    <marker id="arT14" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="400" fill="#f8fafc" rx="6"/>
  <text x="380" y="26" text-anchor="middle" font-size="14" font-weight="600" fill="#1e293b">runLoop 内层 while 第二次迭代</text>
  <rect x="220" y="44" width="320" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="58" text-anchor="middle" font-size="10" fill="#9a3412">currentContext.messages =</text>
  <text x="380" y="72" text-anchor="middle" font-size="10" fill="#c2410c">[user, assistant_1, toolResult]</text>
  <line x1="380" y1="76" x2="380" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT14)"/>
  <rect x="100" y="100" width="560" height="90" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="380" y="118" text-anchor="middle" font-size="11" font-weight="600" fill="#4c1d95">streamAssistantResponse()</text>
  <text x="120" y="136" font-size="9" fill="#64748b">convertToLlm → [user, assistant_1, user(tool_result)]</text>
  <text x="120" y="152" font-size="9" fill="#64748b">streamSimple → HTTP POST /messages</text>
  <text x="120" y="168" font-size="9" fill="#64748b">SSE: text_delta ×N, done</text>
  <text x="120" y="184" font-size="9" fill="#0d9488">返回 AssistantMessage { stopReason:"end_turn", content:[{type:"text"}] }</text>
  <line x1="380" y1="190" x2="380" y2="214" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT14)"/>
  <rect x="140" y="214" width="480" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="232" text-anchor="middle" font-size="10" fill="#475569">toolCalls.length === 0  →  hasMoreToolCalls = false</text>
  <line x1="380" y1="242" x2="380" y2="266" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT14)"/>
  <rect x="180" y="266" width="400" height="28" rx="5" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.2"/>
  <text x="380" y="284" text-anchor="middle" font-size="10" fill="#92400e">emit: turn_end</text>
  <line x1="380" y1="294" x2="380" y2="316" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT14)"/>
  <rect x="100" y="316" width="560" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="334" text-anchor="middle" font-size="9" fill="#475569">currentContext.messages = [user, assistant_1, toolResult, assistant_2]</text>
  <line x1="380" y1="344" x2="380" y2="366" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT14)"/>
  <rect x="220" y="366" width="320" height="28" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="384" text-anchor="middle" font-size="11" font-weight="600" fill="#134e4a">内层 while 退出</text>
</svg>
<span class="figure-caption">图 T14.1 ｜ 工具结果回传 LLM、第二次 stream 完成后 while 循环正常退出</span>

<details>
<summary>ASCII 原版</summary>

```
runLoop: 内层 while 第二次迭代
    |
    | currentContext.messages = [user, assistant_1, toolResult]
    |
    +--[streamAssistantResponse]
    |    convertToLlm -> [user, assistant_1, user(tool_result)]
    |    streamSimple -> HTTP POST /messages
    |    SSE: text_delta x N, done
    |    返回 AssistantMessage { stopReason:"end_turn", content:[{type:"text"}] }
    |
    +--[toolCalls.length === 0]  hasMoreToolCalls = false
    |
    +--[emit turn_end]
    |
    | currentContext.messages = [user, assistant_1, toolResult, assistant_2]
    |
    +--[hasMoreToolCalls=false, pendingMessages=[]]
    v
    内层 while 退出
```

</details>

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/agent/src/agent-loop.ts` | 170-268 | `runLoop` 外层/内层 while,tool_result 追加逻辑 |
| `packages/agent/src/agent-loop.ts` | 275-368 | `streamAssistantResponse`,消费 SSE,构建最终消息 |
| `packages/agent/src/agent-loop.ts` | 727-737 | `createToolResultMessage` 构造函数 |
| `packages/agent/src/agent-loop.ts` | 739-742 | `emitToolResultMessage` 发出 message_start/message_end |
| `packages/agent/src/harness/messages.ts` | 120-164 | `convertToLlm`:toolResult 透传逻辑 |
| `packages/agent/src/agent-loop.ts` | 196-218 | tool_result 追加到 currentContext.messages 与 newMessages |

---

## 7. 分支与延伸

- **runLoop 完整状态机图与双层 while 设计**:见 [第 05 章 §5.3「双层循环:外层 turn 与内层 tool-call」](./05-agent-runtime-loop.md#53-双层循环外层-turn-与内层-tool-call)。

- **工具调用完整闭环(从 tool_use 到 tool_result)**:见 [第 05 章 §5.4「工具调用闭环」](./05-agent-runtime-loop.md#54-工具调用闭环)。

- **convertToLlm 与消息格式转换层**:见 [第 05 章 §5.5「消息格式:AgentMessage vs Message」](./05-agent-runtime-loop.md#55-消息格式agentmessage-vs-message)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **tool_result 是独立的 user-role 消息**:它不是追加到已有 user 消息,而是作为新的 `ToolResultMessage` 独立插入 `messages`,这是 Anthropic Messages API 协议的强制要求。

2. **`hasMoreToolCalls` 由工具的 `terminate` 字段决定**:默认 `terminate` 为 `undefined/false`,所以工具执行完后会立即触发第二次 LLM 调用。只有当工具明确返回 `{ terminate: true }` 时,agent loop 才会跳过第二次调用直接退出。

3. **convertToLlm 是透明通道**:对于 `user`、`assistant`、`toolResult` 三种内置 role,`messages.ts:156-158` 直接 return,不做任何转换。真正的 Anthropic API 格式转换发生在 pi-ai 层的 `transform-messages.ts`,agent 层对此无感知。

4. **第二次 LLM 流与第一次结构完全相同**:同一个 `streamSimple` 函数,同一套 SSE 解析,差异只在于请求 body 多了一条 tool_result,以及模型这次返回的 `content` 只有 `text` block 而没有 `toolCall` block。

5. **messages 数组此时长度为 4**:这与 tour-00 状态表中步骤 15 结束后的"4(+final assistant)"一致。后续步骤 15 的持久化和步骤 16 的渲染都以这个完整的 messages 数组为基础。
