# 第 05 章 Agent Runtime:核心 Loop 与工具执行

> 版本锁定:commit `4868222e`(2026-05-20),`packages/agent` v\*。本章所有 `file:line` 引用均基于该 commit,后续变更不在覆盖范围内。

---

## 目录

1. [问题背景:为什么需要一个 Loop](#1-问题背景)
2. [模块布局与对外入口](#2-模块布局与对外入口)
3. [AgentEvent 模型](#3-agentevent-模型)
4. [核心 Loop 状态机](#4-核心-loop-状态机)
5. [工具调用闭环](#5-工具调用闭环)
6. [取消与超时](#6-取消与超时)
7. [错误处理策略](#7-错误处理策略)
8. [Agent 类:有状态封装](#8-agent-类有状态封装)
9. [多 Agent / 子 Agent](#9-多-agent--子-agent)
10. [与上层的契约:coding-agent 如何消费事件流](#10-与上层的契约)

---

## 1 问题背景

LLM 的单次响应(一次 HTTP 流)可能包含多个 `toolCall` 块。工具执行完毕后,模型需要看到工具结果才能继续推理,因此必须再次调用 LLM——如此往复,直到模型输出纯文本回复或会话被外部中断。

在没有专门 runtime 的情况下,调用者需要手动管理:

- 把 `AssistantMessage` 追加到历史
- 提取所有 `toolCall`,逐个执行
- 把 `ToolResultMessage` 追加到历史
- 再次调用 `streamSimple`,在流中监听下一个 `done` 或 `toolUse`
- 处理并发、顺序执行模式切换
- 中途用户打断（`AbortSignal`）
- provider 报错或 context 超限后的状态保护

`packages/agent` 把上述职责封装成一个有限状态机,对外只暴露一条事件流（`AgentEvent`）和几个控制 API。这是它存在的核心理由。

---

## 2 模块布局与对外入口

```
packages/agent/src/
  index.ts              -- 公共导出聚合
  node.ts               -- Node.js 附加导出(NodeExecutionEnv)
  types.ts              -- 所有核心类型定义
  agent-loop.ts         -- 低层无状态 loop(742 行)
  agent.ts              -- 有状态 Agent 类
  proxy.ts              -- 代理 streamFn 实现
  harness/              -- 高层 AgentHarness(第 06 章)
```

### 2.1 低层入口函数

`packages/agent/src/agent-loop.ts` 暴露四个函数:

| 函数 | 描述 |
|------|------|
| `agentLoop` | 携带新 prompt 启动 loop,返回 `EventStream<AgentEvent, AgentMessage[]>` |
| `agentLoopContinue` | 不添加新消息,从当前 context 继续 |
| `runAgentLoop` | 与 `agentLoop` 相同但接受 `emit` 回调而非返回 stream |
| `runAgentLoopContinue` | 与 `agentLoopContinue` 相同但接受 `emit` 回调 |

`agentLoop` 是最常用的外部入口,`agentLoopContinue` 用于重试场景(context 最后一条必须是 `user` 或 `toolResult`):

```typescript
// agent-loop.ts:31-54
export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = createAgentStream();
  void runAgentLoop(prompts, context, config,
    async (event) => { stream.push(event); },
    signal, streamFn,
  ).then((messages) => { stream.end(messages); });
  return stream;
}
```

返回的 `EventStream` 在收到 `agent_end` 事件后自动关闭,调用者可以用 `for await` 消费:

```typescript
// agent-loop.ts:145-150
function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStream<AgentEvent, AgentMessage[]>(
    (event) => event.type === "agent_end",
    (event) => (event.type === "agent_end" ? event.messages : []),
  );
}
```

`EventStream` 本身来自 `@earendil-works/pi-ai`,负责把 push-based 事件适配成 async-iterable。

### 2.2 AgentLoopConfig 参数语义

`types.ts:135-277` 定义的 `AgentLoopConfig` 是 loop 的核心配置接口,关键字段:

| 字段 | 类型 | 含义 |
|------|------|------|
| `model` | `Model<any>` | 当前 turn 使用的模型 |
| `convertToLlm` | `(msgs) => Message[]` | 把 `AgentMessage[]` 转换成 LLM 可理解的 `Message[]` |
| `transformContext` | `async (msgs, signal) => AgentMessage[]` | 在 `convertToLlm` 之前对消息做窗口裁剪、注入等 |
| `beforeToolCall` | hook | 工具执行前拦截,可返回 `{block:true}` 阻止执行 |
| `afterToolCall` | hook | 工具执行后改写结果 |
| `shouldStopAfterTurn` | `(ctx) => boolean` | 每个 turn 结束后决定是否退出 loop |
| `prepareNextTurn` | hook | 返回替换 context/model/thinking 的快照 |
| `getSteeringMessages` | `() => AgentMessage[]` | 拉取用户在 agent 运行中途注入的消息 |
| `getFollowUpMessages` | `() => AgentMessage[]` | agent 将要停止时拉取后续消息 |
| `toolExecution` | `"sequential" \| "parallel"` | 工具批执行模式,默认 `"parallel"` |
| `getApiKey` | hook | 动态获取 API key(适用于短期 OAuth token) |

`convertToLlm` 的契约特别重要:自定义消息类型(如 `bashExecution`、`compactionSummary`)必须在此转为标准 `Message` 或被过滤掉。该函数必须不抛异常,否则低层 loop 会在没有正常事件序列的情况下中断。

---

## 3 AgentEvent 模型

`types.ts:403-418` 定义了 `AgentEvent` 联合类型:

```typescript
export type AgentEvent =
  // Agent 生命周期
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn 生命周期(一个 turn = 一次助理响应 + 其工具调用/结果)
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // 消息生命周期(user、assistant、toolResult 消息均触发)
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // 工具执行生命周期
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

**设计原则**:`message_update` 只对助理消息在 streaming 期间发射,`message_start`/`message_end` 对三种角色(user、assistant、toolResult)都发射。这让 UI 层可以对三种消息统一处理"显示 → 更新 → 确认"逻辑,同时只对 assistant 消息显示打字机效果。

### 3.1 典型响应内事件发射顺序

下图展示一次含两个工具调用的 turn 内事件发射顺序(并发模式):

```
agent_start
  turn_start
    message_start          <-- user prompt
    message_end

    message_start          <-- assistant streaming begins
      message_update (text_start)
      message_update (text_delta) x N
      message_update (toolcall_start)
      message_update (toolcall_delta) x N
      message_update (toolcall_end)
      message_update (toolcall_start)  [second tool]
      message_update (toolcall_delta) x N
      message_update (toolcall_end)
    message_end            <-- assistant streaming done

    tool_execution_start   [tool A]
    tool_execution_start   [tool B]    (并发开始)
    tool_execution_update  [tool A]    (streaming partial results)
    tool_execution_end     [tool B]    (B 先完成)
    tool_execution_end     [tool A]

    message_start          <-- toolResult for A (按助理消息中的顺序)
    message_end
    message_start          <-- toolResult for B
    message_end

  turn_end

  turn_start               <-- 下一个 turn(LLM 继续推理)
    ...
  turn_end

agent_end
```

`tool_execution_end` 按工具完成顺序发射(B 先完成就先发),但 `message_start/end` (toolResult) 按助理消息中 toolCall 的原始顺序发射。这一差异由 `executeToolCallsParallel` 在 `agent-loop.ts:451-516` 实现:先并发执行,再按顺序 emit message 事件。

---

## 4 核心 Loop 状态机

`runLoop`(`agent-loop.ts:155-269`)是实际的 loop 主体,包含一个外层循环和一个内层循环。以下 ASCII 状态图描述控制流:

<svg viewBox="0 0 760 620" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="runLoop 核心状态机：外层循环包含内层循环，INIT→STREAMING→EXECUTING TOOLS→turn_end/agent_end">
  <defs>
    <marker id="s1ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="s1ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/>
    </marker>
    <marker id="s1ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#0d9488"/>
    </marker>
  </defs>
  <rect x="8" y="8" width="744" height="604" rx="10" fill="none" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="380" y="30" text-anchor="middle" font-size="12" font-weight="600" fill="#94a3b8">OUTER LOOP</text>
  <rect x="200" y="44" width="520" height="380" rx="8" fill="none" stroke="#cbd5e1" stroke-width="1.2" stroke-dasharray="6,3"/>
  <text x="460" y="62" text-anchor="middle" font-size="11" font-weight="600" fill="#94a3b8">INNER LOOP</text>
  <rect x="20" y="60" width="120" height="56" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="80" y="83" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">INIT</text>
  <text x="80" y="98" text-anchor="middle" font-size="9" fill="#64748b">check steering</text>
  <text x="80" y="50" text-anchor="middle" font-size="10" fill="#94a3b8">start</text>
  <line x1="80" y1="56" x2="80" y2="60" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s1ar1)"/>
  <line x1="140" y1="88" x2="216" y2="88" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s1ar1)"/>
  <rect x="216" y="70" width="204" height="56" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="318" y="93" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">inject pendingMessages</text>
  <text x="318" y="109" text-anchor="middle" font-size="9" fill="#64748b">steering injected here</text>
  <line x1="318" y1="126" x2="318" y2="142" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s1ar1)"/>
  <rect x="216" y="142" width="204" height="56" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="318" y="165" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">STREAMING</text>
  <text x="318" y="181" text-anchor="middle" font-size="9" fill="#64748b">streamAssistantResponse</text>
  <line x1="318" y1="198" x2="318" y2="214" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s1ar1)"/>
  <text x="318" y="228" text-anchor="middle" font-size="10" fill="#64748b">stopReason=error/aborted?</text>
  <line x1="260" y1="232" x2="216" y2="252" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s1ar1)"/>
  <text x="228" y="248" font-size="9" fill="#64748b">yes</text>
  <rect x="160" y="252" width="90" height="64" rx="6" fill="#fef2f2" stroke="#ea580c" stroke-width="1.5"/>
  <text x="205" y="274" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">STOPPED</text>
  <text x="205" y="289" text-anchor="middle" font-size="9" fill="#64748b">emit</text>
  <text x="205" y="302" text-anchor="middle" font-size="9" fill="#64748b">agent_end</text>
  <line x1="376" y1="232" x2="420" y2="252" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s1ar1)"/>
  <text x="400" y="248" font-size="9" fill="#64748b">no</text>
  <rect x="390" y="252" width="160" height="48" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="470" y="272" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">has tool calls?</text>
  <line x1="430" y1="300" x2="380" y2="330" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s1ar1)"/>
  <text x="386" y="322" font-size="9" fill="#64748b">yes</text>
  <rect x="300" y="330" width="160" height="56" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="353" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">EXECUTING</text>
  <text x="380" y="368" text-anchor="middle" font-size="10" font-weight="600" fill="#ea580c">TOOLS</text>
  <line x1="510" y1="300" x2="560" y2="300" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s1ar1)"/>
  <text x="514" y="295" font-size="9" fill="#64748b">no</text>
  <rect x="560" y="278" width="90" height="44" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="605" y="300" text-anchor="middle" font-size="9" fill="#64748b">no tools →</text>
  <text x="605" y="313" text-anchor="middle" font-size="9" fill="#64748b">continue</text>
  <line x1="380" y1="386" x2="380" y2="406" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s1ar1)"/>
  <text x="380" y="420" text-anchor="middle" font-size="10" fill="#64748b">all tools terminate=true?</text>
  <line x1="318" y1="424" x2="270" y2="444" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s1ar1)"/>
  <text x="274" y="440" font-size="9" fill="#64748b">yes</text>
  <text x="248" y="460" font-size="9" fill="#64748b">hasMoreToolCalls=false</text>
  <line x1="442" y1="424" x2="490" y2="444" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s1ar1)"/>
  <text x="446" y="440" font-size="9" fill="#64748b">no</text>
  <text x="460" y="460" font-size="9" fill="#64748b">hasMoreToolCalls=true</text>
  <line x1="380" y1="428" x2="380" y2="462" stroke="#94a3b8" stroke-width="1.2"/>
  <rect x="240" y="462" width="300" height="72" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="390" y="480" text-anchor="middle" font-size="10" fill="#64748b">emit turn_end</text>
  <text x="390" y="494" text-anchor="middle" font-size="10" fill="#64748b">prepareNextTurn? · shouldStopAfterTurn?</text>
  <text x="390" y="510" text-anchor="middle" font-size="10" font-weight="600" fill="#ea580c">→ yes: emit agent_end + return</text>
  <line x1="600" y1="300" x2="660" y2="300" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="660" y1="300" x2="660" y2="498" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="660" y1="498" x2="540" y2="498" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s1ar1)"/>
  <line x1="240" y1="498" x2="210" y2="498" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="210" y1="498" x2="210" y2="88" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="210" y1="88" x2="216" y2="88" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s1ar1)"/>
  <text x="180" y="303" font-size="9" fill="#94a3b8" transform="rotate(-90,180,303)">poll getSteeringMessages → loop back</text>
  <rect x="200" y="546" width="360" height="44" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="564" text-anchor="middle" font-size="10" fill="#64748b">poll getFollowUpMessages</text>
  <text x="380" y="580" text-anchor="middle" font-size="10" fill="#64748b">has items → re-enter INNER LOOP ↑</text>
  <line x1="380" y1="534" x2="380" y2="546" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s1ar1)"/>
  <text x="380" y="542" text-anchor="middle" font-size="9" fill="#94a3b8">inner loop exited</text>
  <line x1="680" y1="498" x2="710" y2="498" stroke="#ea580c" stroke-width="1" stroke-dasharray="3,2"/>
  <text x="688" y="494" font-size="8" fill="#ea580c">agent_end</text>
</svg>
<span class="figure-caption">图 R5.1 ｜ runLoop 核心状态机：外层驱动 followUp 重入，内层管理 steering 注入与工具调用轮次</span>

<details>
<summary>ASCII 原版</summary>

```
                    ┌──────────────────────────────────────────┐
                    │              OUTER LOOP                  │
                    │                                          │
     start          │   ┌───────────────────────────────┐     │
       │            │   │         INNER LOOP            │     │
       v            │   │                               │     │
  ┌─────────┐       │   │  ┌──────────────────────────┐ │     │
  │  INIT   │       │   │  │  inject pendingMessages  │ │     │
  │ (check  │       │   │  │  (steering injected here)│ │     │
  │steering)│───────┼──►│  └──────────┬───────────────┘ │     │
  └─────────┘       │   │             │                  │     │
                    │   │             v                  │     │
                    │   │  ┌──────────────────────────┐ │     │
                    │   │  │   STREAMING              │ │     │
                    │   │  │ streamAssistantResponse  │ │     │
                    │   │  └──────────┬───────────────┘ │     │
                    │   │             │                  │     │
                    │   │   stopReason=error/aborted?    │     │
                    │   │      │ yes           │ no      │     │
                    │   │      v               v         │     │
                    │   │  ┌────────┐  ┌──────────────┐ │     │
                    │   │  │STOPPED │  │  has tool     │ │     │
                    │   │  │emit    │  │  calls?       │ │     │
                    │   │  │agent   │  └──┬────────────┘ │     │
                    │   │  │_end    │     │ yes    │ no   │     │
                    │   │  └────────┘     v        v      │     │
                    │   │           ┌──────────┐ ┌──────┐ │     │
                    │   │           │EXECUTING │ │      │ │     │
                    │   │           │TOOLS     │ │      │ │     │
                    │   │           └────┬─────┘ │      │ │     │
                    │   │                │       │      │ │     │
                    │   │    all tools   │       │      │ │     │
                    │   │    terminate=true?     │      │ │     │
                    │   │      │ yes     │ no    │      │ │     │
                    │   │      v         v       │      │ │     │
                    │   │  hasMoreToolCalls=false │      │ │     │
                    │   │  hasMoreToolCalls=true  │      │ │     │
                    │   │                        │      │ │     │
                    │   │   emit turn_end        │      │ │     │
                    │   │   prepareNextTurn?     │      │ │     │
                    │   │   shouldStopAfterTurn? │      │ │     │
                    │   │      │ yes             │      │ │     │
                    │   │      v                 │      │ │     │
                    │   │  emit agent_end        │      │ │     │
                    │   │  return                │      │ │     │
                    │   │                        │      │ │     │
                    │   │   poll getSteeringMessages     │ │     │
                    │   │                        └──────►│ │     │
                    │   └───────────────────────────────┘ │     │
                    │                                      │     │
                    │   inner loop exited (no more tools   │     │
                    │   and no steering)                   │     │
                    │                                      │     │
                    │   poll getFollowUpMessages           │     │
                    │     has items? ─────────────────────►│     │
                    │     empty?                           │     │
                    │       │                              │     │
                    │       v                              │     │
                    │   emit agent_end                     │     │
                    │   return                             │     │
                    └──────────────────────────────────────┘
```

</details>

**外层循环**的存在原因:agent 完成所有工具调用准备停止时,`getFollowUpMessages` 可能返回新消息(用户在等待完成后提的追问)。外层循环把这些消息重新注入内层循环,避免开启全新的 `agentLoop` 调用,保持同一 `agent_start/agent_end` 语义边界。

**内层循环**的条件:`hasMoreToolCalls || pendingMessages.length > 0`。`hasMoreToolCalls` 在上一次 turn 有工具调用且这些工具没有全部返回 `terminate:true` 时为 `true`。

---

## 5 工具调用闭环

### 5.1 从 LLM 发出 toolCall 到回喂的完整路径

<svg viewBox="0 0 760 560" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="toolCall 完整调用路径：从 streamAssistantResponse 到 runLoop 回喂历史">
  <defs>
    <marker id="s2ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="s2ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#0d9488"/>
    </marker>
    <marker id="s2ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/>
    </marker>
  </defs>
  <rect x="40" y="10" width="350" height="68" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="215" y="33" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">streamAssistantResponse</text>
  <text x="215" y="50" text-anchor="middle" font-size="10" fill="#64748b">agent-loop.ts:275 — LLM stream 事件循环</text>
  <text x="215" y="66" text-anchor="middle" font-size="9" fill="#64748b">emit message_update(toolcall_*) · emit message_end · return finalMessage</text>
  <line x1="215" y1="78" x2="215" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s2ar1)"/>
  <rect x="40" y="100" width="350" height="52" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="215" y="121" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">runLoop</text>
  <text x="215" y="138" text-anchor="middle" font-size="10" fill="#64748b">agent-loop.ts:203 — filter toolCalls from message.content</text>
  <line x1="215" y1="152" x2="215" y2="172" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s2ar1)"/>
  <rect x="40" y="172" width="350" height="68" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="215" y="192" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">executeToolCalls</text>
  <text x="215" y="208" text-anchor="middle" font-size="10" fill="#64748b">agent-loop.ts:373</text>
  <line x1="100" y1="228" x2="100" y2="248" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s2ar1)"/>
  <text x="100" y="244" text-anchor="end" font-size="9" fill="#ea580c">Sequential</text>
  <line x1="330" y1="228" x2="330" y2="248" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s2ar1)"/>
  <text x="264" y="244" font-size="9" fill="#0d9488">Parallel</text>
  <rect x="40" y="248" width="160" height="36" rx="6" fill="#fef2f2" stroke="#ea580c" stroke-width="1.2"/>
  <text x="120" y="261" text-anchor="middle" font-size="9" font-weight="600" fill="#ea580c">executeToolCallsSequential</text>
  <text x="120" y="274" text-anchor="middle" font-size="8" fill="#64748b">agent-loop.ts:395</text>
  <rect x="240" y="248" width="150" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="315" y="261" text-anchor="middle" font-size="9" font-weight="600" fill="#7c3aed">executeToolCallsParallel</text>
  <text x="315" y="274" text-anchor="middle" font-size="8" fill="#64748b">agent-loop.ts:451</text>
  <line x1="120" y1="284" x2="120" y2="300" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="120" y1="300" x2="215" y2="300" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="315" y1="284" x2="315" y2="300" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="315" y1="300" x2="215" y2="300" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s2ar1)"/>
  <line x1="215" y1="300" x2="215" y2="316" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s2ar1)"/>
  <rect x="40" y="316" width="350" height="72" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="215" y="336" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">prepareToolCall</text>
  <text x="215" y="352" text-anchor="middle" font-size="9" fill="#64748b">agent-loop.ts:562</text>
  <text x="60" y="368" font-size="9" fill="#64748b">├ 找到工具? 否→ImmediateToolCallOutcome(error)</text>
  <text x="60" y="381" font-size="9" fill="#64748b">└ beforeToolCall hook (可 block) · validateToolArguments</text>
  <line x1="215" y1="388" x2="215" y2="408" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s2ar1)"/>
  <rect x="40" y="408" width="350" height="52" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="215" y="428" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">executePreparedToolCall</text>
  <text x="215" y="445" text-anchor="middle" font-size="9" fill="#64748b">agent-loop.ts:628 — tool.execute() · onUpdate→emit tool_execution_update</text>
  <line x1="215" y1="460" x2="215" y2="480" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s2ar1)"/>
  <rect x="40" y="480" width="350" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="215" y="498" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">finalizeExecutedToolCall</text>
  <text x="215" y="512" text-anchor="middle" font-size="9" fill="#64748b">agent-loop.ts:665 — afterToolCall hook · emit tool_execution_end</text>
  <line x1="430" y1="36" x2="460" y2="36" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s2ar1)"/>
  <rect x="460" y="14" width="280" height="68" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="600" y="36" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">createToolResultMessage</text>
  <text x="600" y="52" text-anchor="middle" font-size="9" fill="#64748b">agent-loop.ts:727</text>
  <text x="600" y="66" text-anchor="middle" font-size="9" fill="#64748b">emit message_start/end (toolResult)</text>
  <line x1="600" y1="82" x2="600" y2="420" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <rect x="460" y="420" width="280" height="68" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="600" y="442" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">回喂 runLoop</text>
  <text x="600" y="458" text-anchor="middle" font-size="9" fill="#64748b">agent-loop.ts:212-215</text>
  <text x="600" y="473" text-anchor="middle" font-size="9" fill="#64748b">context.messages.push(result) ← 回喂历史</text>
  <text x="600" y="486" text-anchor="middle" font-size="9" fill="#7c3aed">emit turn_end → 内层循环下一轮</text>
  <line x1="390" y1="498" x2="460" y2="454" stroke="#7c3aed" stroke-width="1.2" marker-end="url(#s2ar3)"/>
</svg>
<span class="figure-caption">图 R5.2 ｜ toolCall 完整闭环路径：LLM 流 → 工具调度（顺序/并发）→ 准备/执行/收尾 → 回喂历史</span>

<details>
<summary>ASCII 原版</summary>

```
streamAssistantResponse (agent-loop.ts:275)
    │
    │  LLM stream 事件循环
    │  case "toolcall_start/delta/end":
    │    partialMessage 更新
    │    emit message_update (agent-loop.ts:328-339)
    │
    │  case "done":
    │    finalMessage = await response.result()
    │    emit message_end (agent-loop.ts:353)
    │    return finalMessage
    │
    v
runLoop (agent-loop.ts:203)
    const toolCalls = message.content.filter(c => c.type === "toolCall")
    │
    v
executeToolCalls (agent-loop.ts:373)
    │
    ├── hasSequentialToolCall?  (任意工具 executionMode="sequential")
    │       或 config.toolExecution="sequential"?
    │       ─► executeToolCallsSequential (agent-loop.ts:395)
    │
    └── 否则
            ─► executeToolCallsParallel (agent-loop.ts:451)
    │
    v
prepareToolCall (agent-loop.ts:562)
    ├── 找到工具? 否 → ImmediateToolCallOutcome(error)
    ├── prepareArguments (可选 shim)
    ├── validateToolArguments (schema 验证)
    └── beforeToolCall hook (可 block)
    │
    v
executePreparedToolCall (agent-loop.ts:628)
    │  tool.execute(id, args, signal, onUpdate)
    │  onUpdate → emit tool_execution_update
    │
    v
finalizeExecutedToolCall (agent-loop.ts:665)
    │  afterToolCall hook (可改写结果)
    │
    v
emitToolExecutionEnd → emit tool_execution_end (agent-loop.ts:717)
createToolResultMessage (agent-loop.ts:727)
emitToolResultMessage:
    emit message_start (toolResult)
    emit message_end (toolResult)
    │
    v
回到 runLoop (agent-loop.ts:212-215):
    currentContext.messages.push(result)  ← 回喂历史
    newMessages.push(result)
    │
    emit turn_end
    内层循环下一轮 → 再次 streamAssistantResponse
```

</details>

### 5.2 并发与顺序执行的设计差异

**顺序模式**(`executeToolCallsSequential`):`prepare → execute → finalize → emit` 串行,每个工具执行完才开始下一个。适用于需要访问共享状态的工具(如文件系统写入)。

**并发模式**(`executeToolCallsParallel`):`prepareToolCall` 仍然串行(因为 `beforeToolCall` hook 需要顺序语义),但实际执行被收集为 Promise:

```typescript
// agent-loop.ts:484-499
finalizedCalls.push(async () => {
  const executed = await executePreparedToolCall(preparation, signal, emit);
  const finalized = await finalizeExecutedToolCall(...);
  await emitToolExecutionEnd(finalized, emit);
  return finalized;
});
```

然后用 `Promise.all` 同时执行所有函数,`tool_execution_end` 按完成顺序发射。最后按原始助理消息顺序 emit `message_start/message_end`(toolResult),保证模型收到的工具结果顺序和工具调用顺序一致。

**单工具顺序覆盖**:即使全局 `toolExecution="parallel"`,如果某个具体工具的 `executionMode="sequential"`,当该工具出现在批次中时,整个批次退化为顺序执行(`agent-loop.ts:381-387`)。这是"工具级别的互斥锁"语义。

### 5.3 terminate 早停机制

`AgentToolResult.terminate?: boolean` 是工具提示 loop 提前退出的方式:

```typescript
// agent-loop.ts:544-546
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
  return finalizedCalls.length > 0 &&
    finalizedCalls.every((f) => f.result.terminate === true);
}
```

**语义**:只有当批次中每一个工具都返回 `terminate:true` 时,loop 才停止。单个工具返回 `terminate:true` 而其他不返回,loop 仍然继续。这防止了一个工具的"完成"信号误杀同批执行的其他工具的后续推理。

---

## 6 取消与超时

### 6.1 AbortSignal 传播路径

<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="AbortSignal 从 agentLoop 传播到每一个异步边界的调用树">
  <defs>
    <marker id="s3ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="12" width="200" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="120" y="35" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">agentLoop(signal)</text>
  <line x1="40" y1="48" x2="40" y2="68" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="40" y1="68" x2="55" y2="68" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s3ar1)"/>
  <rect x="55" y="56" width="200" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="155" y="79" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">runAgentLoop(signal)</text>
  <line x1="75" y1="92" x2="75" y2="112" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="75" y1="112" x2="90" y2="112" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s3ar1)"/>
  <rect x="90" y="100" width="180" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="180" y="123" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">runLoop(signal)</text>
  <line x1="110" y1="136" x2="110" y2="160" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="110" y1="148" x2="125" y2="148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s3ar1)"/>
  <rect x="125" y="136" width="230" height="36" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="240" y="159" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">streamAssistantResponse(signal)</text>
  <line x1="145" y1="172" x2="160" y2="172" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s3ar1)"/>
  <rect x="160" y="160" width="280" height="32" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="300" y="181" text-anchor="middle" font-size="10" fill="#64748b">streamSimple(model, ctx, { signal })  [provider 层取消]</text>
  <line x1="110" y1="160" x2="125" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s3ar1)"/>
  <rect x="125" y="198" width="200" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="225" y="221" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">executeToolCalls(signal)</text>
  <line x1="145" y1="234" x2="160" y2="234" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s3ar1)"/>
  <rect x="160" y="222" width="180" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="250" y="240" text-anchor="middle" font-size="10" fill="#64748b">prepareToolCall(signal)</text>
  <line x1="175" y1="250" x2="190" y2="250" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s3ar1)"/>
  <rect x="190" y="240" width="230" height="22" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="305" y="255" text-anchor="middle" font-size="9" fill="#64748b">beforeToolCall(ctx, signal)</text>
  <line x1="145" y1="250" x2="160" y2="264" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s3ar1)"/>
  <rect x="160" y="254" width="210" height="22" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="265" y="269" text-anchor="middle" font-size="10" fill="#64748b">executePreparedToolCall(signal)</text>
  <line x1="200" y1="276" x2="215" y2="276" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s3ar1)"/>
  <rect x="215" y="264" width="260" height="22" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="345" y="279" text-anchor="middle" font-size="9" fill="#64748b">tool.execute(id, args, signal, onUpdate)</text>
</svg>
<span class="figure-caption">图 R5.3 ｜ AbortSignal 传播树：signal 跨越每个异步边界，直达 provider 层和工具执行层</span>

<details>
<summary>ASCII 原版</summary>

```
agentLoop(signal)
  └─► runAgentLoop(signal)
        └─► runLoop(signal)
              ├─► streamAssistantResponse(signal)
              │     └─► streamSimple(model, ctx, { signal })  [provider 层取消]
              └─► executeToolCalls(signal)
                    ├─► prepareToolCall(signal)
                    │     └─► beforeToolCall(ctx, signal)
                    └─► executePreparedToolCall(signal)
                          └─► tool.execute(id, args, signal, onUpdate)
```

</details>

`signal` 被传递到每一个异步边界。工具实现者需要自行检查 `signal.aborted` 或把 `signal` 传给内部 `fetch`/`exec`。

### 6.2 中断检查点

`prepareToolCall` 在调用 `beforeToolCall` 前后各检查一次 `signal.aborted`(`agent-loop.ts:591-612`):

```typescript
if (signal?.aborted) {
  return {
    kind: "immediate",
    result: createErrorToolResult("Operation aborted"),
    isError: true,
  };
}
```

在顺序模式的工具批次循环末尾也有一次检查(`agent-loop.ts:440-442`):

```typescript
if (signal?.aborted) {
  break;  // 停止执行剩余工具
}
```

并发模式的 `prepareToolCall` 循环里同样有 `signal.aborted` 检查(`agent-loop.ts:497-499`)。这意味着并发模式下,已经发起的工具执行不会被强制中断,但新工具的 prepare 会停止。

### 6.3 中断后的状态保护

当 `streamAssistantResponse` 返回 `stopReason="aborted"` 时,`runLoop` 立即发射 `turn_end` 和 `agent_end` 然后 `return`(`agent-loop.ts:196-200`):

```typescript
if (message.stopReason === "error" || message.stopReason === "aborted") {
  await emit({ type: "turn_end", message, toolResults: [] });
  await emit({ type: "agent_end", messages: newMessages });
  return;
}
```

此时 context 里的消息处于一致状态——历史消息已追加(streaming 中途 `partialMessage` 就被推入 `context.messages`),但工具结果不会被追加,loop 干净退出。

---

## 7 错误处理策略

### 7.1 provider 报错

LLM provider 错误被编码在 `AssistantMessage.stopReason = "error"` 和 `errorMessage` 字段中,而不是作为 exception 抛出——这是 `StreamFn` 的合约要求(`types.ts:19-26`):

> Contract: Must not throw or return a rejected promise for request/model/runtime failures.

`streamAssistantResponse` 在 `case "error"` 分支调用 `response.result()` 取最终消息(`agent-loop.ts:343-354`),然后发射 `message_end`,把错误消息追加进历史。`runLoop` 检测到 `stopReason="error"` 后终止 loop。

没有重试机制在 `agent-loop.ts` 层面,重试由上层(`Agent`/`AgentHarness`)决定——它们可以通过 `agentLoopContinue` 重新发起。

### 7.2 工具抛异常

`executePreparedToolCall` 用 try-catch 包裹 `tool.execute` 调用(`agent-loop.ts:636-663`):

```typescript
try {
  const result = await prepared.tool.execute(...);
  return { result, isError: false };
} catch (error) {
  return {
    result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
    isError: true,
  };
}
```

工具异常被转化为 `isError:true` 的 `ToolResultMessage`,回喂给 LLM。LLM 通常会在看到错误消息后选择不同策略或向用户报告失败。这样 loop 不会因为单个工具崩溃而中断整个会话。

`afterToolCall` hook 内的异常同样被 try-catch 捕获并转化为错误结果(`agent-loop.ts:697-700`)。

### 7.3 context 超限

`agent-loop.ts` 层面没有直接处理 context 超限。provider 通常会返回 `stopReason="error"` 并附上描述性错误消息。上层(`AgentHarness.compact()`)在每个 turn 结束后判断是否需要压缩历史——见第 06 章。

`AgentLoopConfig.transformContext` 提供了在每次 LLM 调用前裁剪 context 的钩子。`AgentHarness` 正是在这里挂入 `context` hook,让应用层有机会在 loop 内部截断过长的历史。

### 7.4 convertToLlm 约定

`convertToLlm` 必须不抛异常(`types.ts:146-147`)。如果它抛出,`streamAssistantResponse` 中的 await 会把异常传播到 `runLoop`,导致 loop 在没有正常 `agent_end` 事件序列的情况下退出。`Agent.runWithLifecycle` 用 try-catch 捕获这种情况并合成一个 failure 消息序列(`agent.ts:476-492`)。

---

## 8 Agent 类:有状态封装

`agent.ts` 中的 `Agent` 类是 `runAgentLoop`/`runAgentLoopContinue` 的有状态封装。它管理:

- 消息历史(`_state.messages`)
- 流式状态(`isStreaming`, `streamingMessage`)
- 工具集合(`_state.tools`)
- 两个消息队列(`steeringQueue`, `followUpQueue`)
- 当前运行的 `AbortController`(`activeRun`)
- 事件订阅者列表(`listeners`)

### 8.1 核心 API

```typescript
// 发起新 prompt(文本、单条消息或批次)
await agent.prompt("请帮我重构这段代码");

// 在 agent 运行时注入消息(turn 结束后注入)
agent.steer("请先处理 TypeScript 类型错误");

// agent 即将停止时追加后续消息
agent.followUp("完成后运行测试");

// 等待当前运行完成
await agent.waitForIdle();

// 中断当前运行
agent.abort();

// 订阅所有事件
const unsubscribe = agent.subscribe(async (event, signal) => {
  if (event.type === "message_end") {
    console.log("新消息:", event.message);
  }
});
```

### 8.2 runWithLifecycle 生命周期

每次 `prompt()` 或 `continue()` 都通过 `runWithLifecycle` 执行(`agent.ts:451-474`):

```typescript
private async runWithLifecycle(
  executor: (signal: AbortSignal) => Promise<void>
): Promise<void> {
  const abortController = new AbortController();
  let resolvePromise = () => {};
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  this.activeRun = { promise, resolve: resolvePromise, abortController };
  this._state.isStreaming = true;
  try {
    await executor(abortController.signal);
  } catch (error) {
    await this.handleRunFailure(error, abortController.signal.aborted);
  } finally {
    this.finishRun();
  }
}
```

`activeRun.promise` 被 `waitForIdle()` 返回——注意它在 `agent_end` 监听者全部 settle 之后才 resolve,而不是在 `agent_end` 事件发射后立即 resolve(`agent.ts:308-311`)。

### 8.3 processEvents:状态归约

`Agent.processEvents` 相当于一个 event reducer,根据事件类型更新内部状态(`agent.ts:509-556`):

<svg viewBox="0 0 760 240" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="processEvents 状态归约表：事件类型到 AgentState 字段的映射">
  <defs>
    <marker id="s4ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">processEvents — Event Reducer</text>
  <rect x="20" y="34" width="280" height="190" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="160" y="52" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">AgentEvent (输入)</text>
  <rect x="36" y="60" width="248" height="24" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="160" y="77" text-anchor="middle" font-size="10" fill="#0d9488">message_start</text>
  <rect x="36" y="90" width="248" height="24" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="160" y="107" text-anchor="middle" font-size="10" fill="#0d9488">message_update</text>
  <rect x="36" y="120" width="248" height="24" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="160" y="137" text-anchor="middle" font-size="10" fill="#0d9488">message_end</text>
  <rect x="36" y="150" width="248" height="24" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="160" y="167" text-anchor="middle" font-size="10" fill="#7c3aed">tool_execution_start</text>
  <rect x="36" y="180" width="248" height="24" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="160" y="197" text-anchor="middle" font-size="10" fill="#7c3aed">tool_execution_end</text>
  <rect x="36" y="210" width="112" height="24" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="92" y="227" text-anchor="middle" font-size="10" fill="#64748b">turn_end</text>
  <rect x="172" y="210" width="112" height="24" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="228" y="227" text-anchor="middle" font-size="10" fill="#ea580c">agent_end</text>
  <line x1="300" y1="72" x2="360" y2="72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s4ar1)"/>
  <line x1="300" y1="102" x2="360" y2="102" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s4ar1)"/>
  <line x1="300" y1="132" x2="360" y2="132" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s4ar1)"/>
  <line x1="300" y1="162" x2="360" y2="162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s4ar1)"/>
  <line x1="300" y1="192" x2="360" y2="192" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s4ar1)"/>
  <line x1="300" y1="222" x2="360" y2="222" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#s4ar1)"/>
  <rect x="360" y="34" width="380" height="190" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="550" y="52" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">state 更新 (输出)</text>
  <text x="376" y="77" font-size="10" fill="#64748b">state.streamingMessage = event.message</text>
  <text x="376" y="107" font-size="10" fill="#64748b">state.streamingMessage = event.message</text>
  <text x="376" y="127" font-size="10" fill="#64748b">state.streamingMessage = undefined</text>
  <text x="376" y="141" font-size="10" fill="#64748b">state.messages.push(event.message)</text>
  <text x="376" y="162" font-size="10" fill="#7c3aed">state.pendingToolCalls.add(event.toolCallId)</text>
  <text x="376" y="192" font-size="10" fill="#7c3aed">state.pendingToolCalls.delete(event.toolCallId)</text>
  <text x="376" y="222" font-size="10" fill="#64748b">errorMessage? → update state.errorMessage</text>
  <text x="560" y="222" font-size="10" fill="#ea580c">streamingMessage=undefined</text>
</svg>
<span class="figure-caption">图 R5.4 ｜ processEvents 状态归约：AgentEvent 到 AgentState 字段的确定性映射</span>

<details>
<summary>ASCII 原版</summary>

```
message_start  → state.streamingMessage = event.message
message_update → state.streamingMessage = event.message
message_end    → state.streamingMessage = undefined; state.messages.push(event.message)
tool_execution_start → state.pendingToolCalls.add(event.toolCallId)
tool_execution_end   → state.pendingToolCalls.delete(event.toolCallId)
turn_end       → 如果有 errorMessage 则更新 state.errorMessage
agent_end      → state.streamingMessage = undefined
```

</details>

`state.messages` 是由 `message_end` 事件驱动追加的,而不是直接由 loop 函数写入。这保证了"你看到的 `state.messages` 就是已发射完 `message_end` 的消息集合"。

### 8.4 PendingMessageQueue 与队列模式

```typescript
// agent.ts:118-152
class PendingMessageQueue {
  constructor(mode: QueueMode) { ... }
  drain(): AgentMessage[] {
    if (this.mode === "all") {
      return this.messages.splice(0);  // 一次性取走全部
    }
    return this.messages.splice(0, 1); // 每次只取一条
  }
}
```

`steeringMode="one-at-a-time"` 保证用户中途注入的每条 steering 消息都能让 agent 看到并响应一次,而不是被批量注入后 agent 只响应最后一条。`followUpMode` 同理。

### 8.5 扩展点

`Agent` 的字段大多是 `public`,调用者可以在任何时候替换:

- `agent.convertToLlm` — 自定义消息转换逻辑
- `agent.transformContext` — 每次 LLM 调用前的消息裁剪钩子
- `agent.beforeToolCall` / `agent.afterToolCall` — 工具拦截
- `agent.streamFn` — 替换为 `streamProxy` 走代理服务器
- `agent.prepareNextTurn` — 每个 turn 结束后动态切换模型或 context

---

## 9 多 Agent / 子 Agent

`packages/agent` 的设计是**单一对话视角**:一个 `Agent` 实例管理一条消息历史线。代码库中没有内置的"sub-agent 触发新 loop"机制。

但框架通过工具系统天然支持子 agent 模式:

1. 定义一个工具(如 `delegate_task`),其 `execute` 函数内部创建新的 `Agent`/`AgentHarness` 实例,发起独立的 `agentLoop` 调用,等待 `agent_end`,把结果作为工具结果返回给父 agent。
2. 父 agent 的 `AbortSignal` 应该传递给子 `agentLoop` 的 `signal` 参数,保证父 agent 中断时子 agent 也能被取消。

这种"工具即子 agent"的模式与 OpenAI Agents SDK 的 handoff 机制和 LangGraph 的 subgraph 节点在语义上类似,但在 pi 里完全由工具实现者决定——框架不强制任何特定的子 agent 协议。

---

## 10 与上层的契约

### 10.1 coding-agent 怎么消费 AgentEvent 流

`packages/coding-agent` 通过 `AgentHarness`(见第 06 章)间接消费 `AgentEvent`。`AgentHarness` 在内部调用 `runAgentLoop`,把所有事件通过 `handleAgentEvent` 路由,然后用自己的 `subscribe`/`on` API 暴露给 `coding-agent`。

`coding-agent` 的 TUI 层订阅 `AgentHarnessEvent`(= `AgentEvent` | `AgentHarnessOwnEvent`),每种事件更新对应的 UI 状态:

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="AgentEvent 到 TUI UI 动作的映射表">
  <text x="380" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">AgentEvent → TUI UI 动作映射</text>
  <rect x="20" y="34" width="340" height="254" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="190" y="54" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">AgentEvent</text>
  <rect x="36" y="62" width="308" height="30" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="190" y="82" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">agent_start</text>
  <rect x="36" y="98" width="308" height="30" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="190" y="118" text-anchor="middle" font-size="11" fill="#0d9488">message_start (assistant)</text>
  <rect x="36" y="134" width="308" height="30" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="190" y="154" text-anchor="middle" font-size="11" fill="#0d9488">message_update</text>
  <rect x="36" y="170" width="308" height="30" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="190" y="190" text-anchor="middle" font-size="11" fill="#0d9488">message_end (assistant)</text>
  <rect x="36" y="206" width="308" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="190" y="226" text-anchor="middle" font-size="11" fill="#7c3aed">tool_execution_start</text>
  <rect x="36" y="242" width="308" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="190" y="262" text-anchor="middle" font-size="11" fill="#7c3aed">tool_execution_update</text>
  <rect x="36" y="242" width="308" height="30" rx="5" fill="none"/>
  <rect x="36" y="278" width="144" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="108" y="298" text-anchor="middle" font-size="11" fill="#7c3aed">tool_execution_end</text>
  <rect x="200" y="278" width="144" height="30" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="272" y="298" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">agent_end</text>
  <rect x="400" y="34" width="340" height="254" rx="8" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="570" y="54" text-anchor="middle" font-size="11" font-weight="600" fill="#0ea5e9">TUI UI 动作</text>
  <text x="416" y="82" font-size="10" fill="#64748b">显示"运行中"指示器</text>
  <text x="416" y="118" font-size="10" fill="#64748b">在消息列表中创建占位气泡</text>
  <text x="416" y="154" font-size="10" fill="#64748b">更新气泡文本（打字机效果）</text>
  <text x="416" y="190" font-size="10" fill="#64748b">气泡标记为完成</text>
  <text x="416" y="226" font-size="10" fill="#64748b">显示工具名和参数</text>
  <text x="416" y="262" font-size="10" fill="#64748b">显示工具进度</text>
  <text x="416" y="290" font-size="10" fill="#64748b">显示工具结果/错误</text>
  <text x="416" y="298" font-size="10" fill="#ea580c">隐藏指示器，解锁输入框</text>
  <line x1="360" y1="77" x2="400" y2="77" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="360" y1="113" x2="400" y2="113" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="360" y1="149" x2="400" y2="149" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="360" y1="185" x2="400" y2="185" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="360" y1="221" x2="400" y2="221" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="360" y1="257" x2="400" y2="257" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="360" y1="283" x2="400" y2="283" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="360" y1="293" x2="400" y2="293" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
</svg>
<span class="figure-caption">图 R5.5 ｜ AgentEvent → TUI 动作映射：每种事件对应的界面响应行为</span>

<details>
<summary>ASCII 原版</summary>

```
AgentEvent                   → UI 动作
─────────────────────────────────────────────────────
agent_start                  → 显示"运行中"指示器
message_start (assistant)    → 在消息列表中创建占位气泡
message_update               → 更新气泡文本(打字机效果)
message_end (assistant)      → 气泡标记为完成
tool_execution_start         → 显示工具名和参数
tool_execution_update        → 显示工具进度
tool_execution_end           → 显示工具结果/错误
agent_end                    → 隐藏"运行中"指示器,解锁输入框
```

</details>

### 10.2 事件流的消费模式

低层 `agentLoop` 返回 `EventStream`,可以用 `for await` 消费:

```typescript
const stream = agentLoop(prompts, context, config, signal);
for await (const event of stream) {
  switch (event.type) {
    case "message_update":
      tui.updateStreamingMessage(event.message);
      break;
    case "agent_end":
      tui.showFinalMessages(event.messages);
      break;
  }
}
const finalMessages = await stream.result();
```

高层 `Agent` 类用 `subscribe` 回调模式,更适合 TUI 这种长期运行的订阅场景:

```typescript
const agent = new Agent({ ... });
agent.subscribe(async (event, signal) => {
  // event 是 AgentEvent 联合类型
  // signal 是当前运行的 AbortSignal
});
await agent.prompt("用户输入");
await agent.waitForIdle();
```

`AgentHarness` 的 `subscribe` 进一步扩展,接收 `AgentHarnessEvent`(包含 `session_compact`、`model_select` 等 harness 自有事件),这是 `coding-agent` 实际使用的 API 接口。

---

## 附录:关键类型速查

| 类型 | 定义位置 | 用途 |
|------|----------|------|
| `AgentEvent` | `types.ts:403` | loop 发射的所有事件 |
| `AgentLoopConfig` | `types.ts:135` | loop 配置 |
| `AgentContext` | `types.ts:387` | 单次 loop 的 context 快照 |
| `AgentMessage` | `types.ts:309` | 消息联合类型(含自定义) |
| `AgentTool` | `types.ts:361` | 工具定义接口 |
| `AgentToolResult` | `types.ts:346` | 工具执行结果 |
| `AgentState` | `types.ts:317` | `Agent` 对外暴露的状态 |
| `StreamFn` | `types.ts:24` | 流函数签名约定 |
| `ToolExecutionMode` | `types.ts:36` | `"sequential" \| "parallel"` |
| `QueueMode` | `types.ts:44` | `"all" \| "one-at-a-time"` |
