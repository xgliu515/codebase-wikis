# Tour 步骤 12:LLM 决定调用 read 工具 → ToolCallEvent

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:事件流已发射若干 `text_delta` / `thinking_delta`,`toolcall_end` 事件刚刚发射,`toolCall = { type:"toolCall", id:"toolu_01...", name:"read", arguments:{ path:"README.md" } }` 已完整。`done` 事件随即推入流,`stopReason = "toolUse"`。

**下一步起点**:agent-loop 进入工具执行阶段,持有 `AssistantMessage`,其 `content` 数组包含一个 `toolCall` 块 `{ name:"read", arguments:{path:"README.md"} }`。agent-loop 即将查 `currentContext.tools` 找到 `read` 工具实例,调用其 `execute` 方法。

---

## 1. 当前情境

`streamAssistantResponse`(`agent-loop.ts:275-368`)中的 `for await` 循环刚处理完 `done` 事件,调用 `response.result()` 拿到最终 `AssistantMessage`,将其写回 `context.messages`(`agent-loop.ts:346-347`),并发射 `message_end` 事件。函数返回 `finalMessage`。

此时:
- `finalMessage.stopReason === "toolUse"`。
- `finalMessage.content` 含至少一个 `{ type:"toolCall" }` 块。
- `newMessages` 数组已追加 `finalMessage`。
- agent-loop 回到 `runLoop` 的 `while(hasMoreToolCalls)` 分支,进入工具调度路径。

---

## 2. 问题

本步需要回答四个具体问题:

1. **`toolcall_end` 中的 `ToolCall` 对象如何与 agent-loop 的 `AgentToolCall` 类型对应**——两者定义在不同包,确认它们实际上是同一个 `Extract<AssistantMessage["content"][number], {type:"toolCall"}>` 切片。

2. **agent-loop 为什么不在收到 `toolcall_end` 时就立即执行工具**——必须等 `done` 事件后才能进入工具执行阶段。

3. **工具参数的 TypeBox 校验在哪里做,校验失败怎么走**——校验和错误回包路径在 `prepareToolCall` 内部,不在 agent-loop 主循环。

4. **并行 vs 顺序执行的分支判断逻辑**——`read` 工具没有声明 `executionMode: "sequential"`,默认走并行路径。

---

## 3. 朴素思路

每收到一个 `toolcall_end` 事件立即启动工具执行,不等流结束。这样延迟最低:工具 I/O 与后续 delta 事件重叠进行。

---

## 4. 为什么朴素思路会崩

Anthropic Messages API 允许模型在**同一个 `AssistantMessage`** 中发出多个 `tool_use` 块(并行工具调用)。例如模型可能同时发出 `read README.md` 和 `read package.json`。如果在第一个 `toolcall_end` 就启动执行:

- 工具 A 可能在第二个 `tool_use` 块到达之前完成并触发下一轮 LLM 调用。
- 下一轮 LLM 请求的 `messages` 数组只包含工具 A 的结果,缺少工具 B 的结果——这会导致 API 报错(`tool_use` 块和 `tool_result` 块必须一一对应)。

因此 agent-loop 必须等 `stopReason === "toolUse"` 的 `done` 事件到达,确认整个 `AssistantMessage` 已完整,再批量调度所有 `toolCall` 块。

---

## 5. pi 的做法

### 5.1 ToolCallEvent 的身份

`AgentToolCall` 类型定义在 `packages/agent/src/types.ts:47`:

```typescript
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
```

即 `ToolCall`(`types.ts:246-253`):

```typescript
export interface ToolCall {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, any>;
    thoughtSignature?: string;
}
```

`toolcall_end` 事件的 `toolCall` 字段直接是 `AssistantMessage.content` 中的同一个对象引用(`anthropic.ts:631`),不做复制。agent-loop 用 `message.content.filter(c => c.type === "toolCall")` 提取所有 toolCall 块(`agent-loop.ts:203`)。

### 5.2 agent-loop 等流结束后批量调度

```
streamAssistantResponse() 返回 finalMessage
        |
        | message.content.filter(c => c.type === "toolCall")
        v
toolCalls = [ {name:"read", arguments:{path:"README.md"}} ]
        |
        | executeToolCalls()            agent-loop.ts:373-388
        |   检查任一 tool.executionMode === "sequential"?
        |   read 工具未设置 executionMode -> 走 parallel 路径
        v
executeToolCallsParallel()             agent-loop.ts:451-516
```

`read` 工具的 `AgentTool` 定义里没有设置 `executionMode`(`types.ts:383`),因此 `hasSequentialToolCall === false`,走 `executeToolCallsParallel`。本次 trace 只有一个 tool call,并行路径等同于顺序路径。

### 5.3 prepareToolCall:查表 + 参数校验

`prepareToolCall`(`agent-loop.ts:562-626`)完成两件事:

**(a) 查 tools 表**:

```typescript
const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
// agent-loop.ts:569
```

`currentContext.tools` 是在 `AgentContext` 初始化时传入的工具数组,包含所有已注册的 `AgentTool` 实例。`read` 工具以小写 `"read"` 注册(`read.ts:213`)。如果 `name` 不匹配任何工具,立即返回 `ImmediateToolCallOutcome { isError: true, result: "Tool not found" }`(`agent-loop.ts:571-576`)。

**(b) TypeBox 校验**:

```typescript
const validatedArgs = validateToolArguments(tool, preparedToolCall);
// agent-loop.ts:580
```

`validateToolArguments`(来自 `@earendil-works/pi-ai`)用 TypeBox 对 `toolCall.arguments` 做 schema 验证。`readSchema` 定义为(`read.ts:20-24`):

```typescript
const readSchema = Type.Object({
    path:   Type.String(...),
    offset: Type.Optional(Type.Number(...)),
    limit:  Type.Optional(Type.Number(...)),
});
```

本次 trace `arguments = { path:"README.md" }` 满足 schema——`path` 是字符串,`offset`/`limit` 可选。校验通过,返回 `PreparedToolCall { kind:"prepared", toolCall, tool, args }`,进入 `executePreparedToolCall`。

**校验失败路径**:若 `validateToolArguments` 抛出异常(例如 `path` 字段缺失),`prepareToolCall` 的 `catch` 块在 `agent-loop.ts:619-624` 将错误包装为 `ImmediateToolCallOutcome`,emit `tool_execution_end { isError:true }`,生成内容为错误信息的 `ToolResultMessage`,然后正常进入下一轮 LLM 调用——模型会根据错误消息决定下一步。

### 5.4 beforeToolCall 钩子

`validateToolArguments` 通过后,`prepareToolCall` 检查 `config.beforeToolCall`(`agent-loop.ts:581-605`)。如果返回 `{ block:true }`,工具执行被拦截,产生 `ImmediateToolCallOutcome { isError:true }`。`read` 工具在 coding-agent 的 `beforeToolCall` 实现中不会被拦截(只读操作不需要权限审批)。

### 5.5 并行调度的实际流程(单 tool call 简化版)

```
executeToolCallsParallel()
 |
 +-- emit tool_execution_start { toolName:"read", args:{path:"README.md"} }
 |
 +-- prepareToolCall()  -> PreparedToolCall { kind:"prepared" }
 |
 +-- push lambda: () => executePreparedToolCall(preparation)  finalizedCalls.push(fn)
 |
 +-- Promise.all([fn()])  -> 并发执行(此处只有一个)
 |
 +-- emitToolExecutionEnd(finalized)
 |
 +-- createToolResultMessage(finalized)  ->  ToolResultMessage
 +-- emitToolResultMessage(...)          ->  emit message_start + message_end
```

<svg viewBox="0 0 760 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="executeToolCallsParallel 事件时序:agent-loop 到 AgentEventSink">
  <defs>
    <marker id="arT12" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="400" fill="#f8fafc" rx="6"/>
  <text x="380" y="26" text-anchor="middle" font-size="14" font-weight="600" fill="#1e293b">executeToolCallsParallel 事件时序</text>
  <rect x="20" y="40" width="330" height="28" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="185" y="58" text-anchor="middle" font-size="12" font-weight="600" fill="#9a3412">agent-loop</text>
  <rect x="410" y="40" width="330" height="28" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="575" y="58" text-anchor="middle" font-size="12" font-weight="600" fill="#134e4a">AgentEventSink (emit)</text>
  <line x1="380" y1="40" x2="380" y2="400" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <rect x="20" y="80" width="330" height="40" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="185" y="97" text-anchor="middle" font-size="10" fill="#475569">streamAssistantResponse() 返回</text>
  <text x="185" y="113" text-anchor="middle" font-size="10" fill="#ea580c">message.stopReason === "toolUse"</text>
  <rect x="20" y="130" width="330" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="185" y="148" text-anchor="middle" font-size="10" fill="#475569">toolCalls = [ {name:"read", ...} ]</text>
  <rect x="20" y="170" width="330" height="28" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="185" y="188" text-anchor="middle" font-size="10" font-weight="600" fill="#4c1d95">executeToolCallsParallel() 开始</text>
  <rect x="40" y="208" width="290" height="80" rx="4" fill="#ede9fe" stroke="#a78bfa" stroke-width="1"/>
  <text x="185" y="224" text-anchor="middle" font-size="10" font-weight="600" fill="#4c1d95">prepareToolCall("read")</text>
  <text x="55" y="242" font-size="9" fill="#64748b">find tool             OK</text>
  <text x="55" y="257" font-size="9" fill="#64748b">validateToolArguments OK</text>
  <text x="55" y="272" font-size="9" fill="#64748b">beforeToolCall → undefined (不拦截)</text>
  <line x1="330" y1="214" x2="400" y2="214" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT12)"/>
  <rect x="405" y="200" width="335" height="36" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="572" y="218" text-anchor="middle" font-size="10" fill="#134e4a">emit: tool_execution_start</text>
  <text x="572" y="232" text-anchor="middle" font-size="9" fill="#0f766e">{ toolName:"read", args:{path:"README.md"} }</text>
  <rect x="40" y="298" width="290" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="185" y="316" text-anchor="middle" font-size="9" fill="#475569">finalizedCalls.push(async fn)  → PreparedToolCall</text>
  <rect x="40" y="336" width="290" height="40" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="185" y="352" text-anchor="middle" font-size="10" font-weight="600" fill="#4c1d95">Promise.all([fn()])</text>
  <text x="185" y="368" text-anchor="middle" font-size="9" fill="#6d28d9">并发执行(此处单 tool)</text>
  <line x1="330" y1="352" x2="400" y2="352" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#arT12)"/>
  <rect x="405" y="336" width="335" height="36" rx="4" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.2"/>
  <text x="572" y="352" text-anchor="middle" font-size="10" fill="#92400e">进入 executePreparedToolCall</text>
  <text x="572" y="368" text-anchor="middle" font-size="9" fill="#b45309">(见步骤 13)</text>
</svg>
<span class="figure-caption">图 T12.1 ｜ executeToolCallsParallel() 内部事件时序:prepareToolCall → tool_execution_start → Promise.all</span>

<details>
<summary>ASCII 原版</summary>

```
agent-loop                             AgentEventSink(emit)
──────────────────────────────────     ────────────────────────
streamAssistantResponse() 返回
message.stopReason === "toolUse"

toolCalls = [ {name:"read",...} ]

executeToolCallsParallel() 开始
  prepareToolCall("read")        -->   tool_execution_start
    find tool OK
    validateToolArguments OK
    beforeToolCall -> undefined (不拦截)
    return PreparedToolCall

  finalizedCalls.push(async fn)

  Promise.all([fn()])            -->   (进入 executePreparedToolCall,见步骤 13)
```

</details>

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/agent/src/types.ts` | 47 | `AgentToolCall` 类型定义(`Extract` 切片) |
| `packages/agent/src/types.ts` | 403-418 | `AgentEvent` 联合类型,含 `tool_execution_start/end` |
| `packages/agent/src/agent-loop.ts` | 203 | `toolCalls = message.content.filter(c => c.type === "toolCall")` |
| `packages/agent/src/agent-loop.ts` | 207-215 | 工具调度与 `toolResults` 收集 |
| `packages/agent/src/agent-loop.ts` | 373-388 | `executeToolCalls`:parallel/sequential 分支判断 |
| `packages/agent/src/agent-loop.ts` | 451-516 | `executeToolCallsParallel` 实现 |
| `packages/agent/src/agent-loop.ts` | 562-626 | `prepareToolCall`:查表 + schema 校验 + beforeToolCall |
| `packages/ai/src/types.ts` | 246-253 | `ToolCall` 接口 |

---

## 7. 分支与延伸

- **`AgentEvent` 完整联合类型与 `tool_execution_start/end` 的语义**:见 [第 05 章 §3「AgentEvent 模型」](./05-agent-runtime-loop.md#3-agentevent-模型)。
- **工具调用状态机的完整路径(prepare → execute → finalize → result)**:见 [第 05 章 §5「工具调用闭环」](./05-agent-runtime-loop.md#5-工具调用闭环)。
- **`AssistantMessageEvent` 协议中 `toolcall_start/delta/end` 的发射时机**:见 [第 03 章 §1「统一事件流模型」](./03-ai-provider-implementations.md#1-统一事件流模型)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **`AgentToolCall` 就是 `ToolCall`**:两个类型名在不同包出现,但 `AgentToolCall` 是通过 `Extract` 从 `AssistantMessage["content"][number]` 切片得到的,和 `ToolCall` 接口完全一致。理解这一点消除了跨包阅读时的类型困惑。

2. **"等流结束再执行工具"是正确性保证**:模型一次 response 里可能发出多个并行 tool_use 块,所有块必须在同一个 `user`-role 消息里以 `tool_result` 回包。只有等 `done` 事件(即 `message_stop`)到达后,`message.content` 才完整,才能安全批量调度。

3. **TypeBox 校验失败不崩溃**:`prepareToolCall` 的 catch 块把异常转换为错误 `ToolResultMessage`,模型收到错误内容后可以自行决策(重试、换参数或放弃)。这是 agent-loop 的容错设计——工具层的任何单点失败都不会终止整个 session。

4. **`read` 工具不走 sequential 路径**:`AgentTool.executionMode` 字段缺省时走 parallel。只有 `bash` 这类有副作用、顺序敏感的工具才会声明 `executionMode:"sequential"`。read 是只读的,与其他并发工具调用不存在竞争条件。
