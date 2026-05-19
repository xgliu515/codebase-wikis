# Tour 14：流式事件发射与订阅

## 1. 当前情境

上一步（tour-13）结束时，OpenClaw 和 `api.anthropic.com` 之间建立起了一条**流式连接**：

- attempt 已经把 `activeSession.agent.streamFn` 装好（Anthropic 的 `StreamFn`，外面叠了一连串 wrapper）。
- 通用推理 loop 用 tour-12 的 `systemPrompt` + 归一化历史 + 「你好」组装成 `context`，调了 `streamFn`，发出了 `stream: true` 的请求。
- Anthropic 开始把模型生成的回复以 SSE 事件形式逐个回推——`message_start`、一串 `content_block_delta`（每个带一小段文本增量）、`message_delta`（带 `stop_reason` 和 `usage`）、`message_stop`。

现在 token 正在回流。但这些是 **Anthropic 的** SSE 事件，是底层 `@earendil-works/pi-agent-core` 引擎能消费的格式。OpenClaw 内部的下游——回复投递层、gateway 的 WebChat 状态机——不认识 Anthropic SSE。它们认的是 OpenClaw 自己的 **agent 事件**（`AgentEventPayload`）。

这一步要看的，是从「Anthropic SSE token 回流」到「一串 OpenClaw agent 事件流向订阅者」之间的转换与分发。

## 2. 问题

> 底层引擎从 Anthropic 流里解析出的原始 token / 文本增量 / 停止原因，如何被转成 OpenClaw 内部统一的 agent 事件并 emit 出去？谁在订阅这些事件，又各自拿它做什么？

两半：上半是「转换 + emit」，下半是「谁订阅 + 干什么」。

## 3. 朴素思路

attempt 拿到流之后，自己一边读一边直接干活：

```ts
for await (const chunk of anthropicStream) {
  const text = extractDelta(chunk);
  fullText += text;
  replyDispatcher.sendBlockReply({ text: fullText }); // 直接投递
  gatewayWebSocket.send({ type: "chat", text: fullText }); // 直接推 WebChat
}
```

读流、累积文本、顺手就把投递和 WebSocket 推送都做了。一个循环搞定。

## 4. 为什么朴素思路会崩

这个朴素思路会在五个具体的地方崩。

**第一，attempt 不该认识 `ReplyDispatcher` 和 WebSocket。** attempt 是 agent 执行的内核，`ReplyDispatcher` 是投递层、`gatewayWebSocket` 是 gateway 控制面——三者属于完全不同的子系统。让 attempt 的流循环直接 `import` 并调用它们，等于把投递、广播的实现细节焊死进 agent 运行时。换个投递目标、加一个新订阅者，都要改 attempt 的核心循环。这是典型的「内核知道了太多下游」。

**第二，订阅者不止两个，而且会动态来去。** 一个 agent run 的事件，订阅者有：gateway 的 WebChat 状态投影器、给 IM 渠道做流式回显的逻辑、Control UI 的实时渲染、诊断 timeline、OpenAI 兼容 HTTP 端点、agent-job 方法……而且它们各自的生命周期不同——一个 WebChat 客户端中途断开、一个诊断订阅随时挂上。朴素思路把「投递」和「WebSocket」硬编码进循环，第三个、第四个订阅者根本没地方接。

**第三，事件会乱序、会丢，朴素循环无从察觉。** 一个 run 内部，文本增量、工具相位、生命周期相位是并发产生的（embedded loop 里多处都会 emit）。下游需要一个**单调递增的序号**来检测「我是不是漏收了一个事件」。朴素循环里 `fullText += text` 完全没有序号概念——下游收到的就是一串裸文本，丢了一段也不知道。

**第四，「隐藏运行」会泄漏。** 不是每个 agent run 都该让它的助手文本实时刷进 Control UI——后台 heartbeat、某些隐藏渠道的运行不该泄漏聊天流量。但它的 `lifecycle`（开始/结束）事件下游又必须知道（好持久化终态）。朴素循环对所有运行一视同仁地 `gatewayWebSocket.send`，隐藏运行的内容直接漏出去。

**第五，逐 token 直推会打爆 WebSocket。** Anthropic 流是逐 token 的，一句「你好」的回复可能有几十个 `content_block_delta`。每个 delta 都 `gatewayWebSocket.send` 一次，几十个连接 × 几十个 delta = 上千次 socket 写。朴素循环没有节流的位置。

核心矛盾：流事件的「产生」和「消费」必须**解耦**——产生方（attempt 的流 loop）只管把原始流转成带序号的标准事件并广播；消费方各自订阅、各自决定怎么用。中间需要一个**带序号、带可见性控制的事件总线**，而不是一个把投递和广播焊死进去的循环。

## 5. OpenClaw 的做法

**先把问题摆正**：流事件要解决两件事——(a) 把 provider 流里的原始增量转成 OpenClaw 统一的、带单调序号的 `AgentEventPayload`，并通过一个进程级事件总线 emit；(b) 让任意数量的订阅者各自挂上来、各取所需。OpenClaw 用 `src/infra/agent-events.ts` 这个事件总线把产生和消费彻底切开。

**转换：流回调 → agent 事件。** attempt 不自己读 Anthropic 流。它在 `src/agents/pi-embedded-runner/run/attempt.ts:3132` 调 `subscribeEmbeddedPiSession`（定义在 `src/agents/pi-embedded-subscribe.ts`），把一组回调挂到底层 pi session 上——`onPartialReply`、`onBlockReply`、`onAssistantMessageStart`、`onToolResult`、`onReasoningStream`，以及最关键的 `onAgentEvent`（`src/agents/pi-embedded-runner/run/attempt.ts:3154`，把 `params.onAgentEvent` 透传下去）。底层 `@earendil-works/pi-agent-core` 引擎消费 Anthropic SSE、解析出 `text_delta` / `tool_use` / `usage` / `stop_reason`，`pi-embedded-subscribe.ts` 这个**订阅层**就是把这些原始流事件翻译成 OpenClaw 概念的地方：累积 `assistantTexts`、切 block、并在该 emit agent 事件的节点调 `emitAgentEvent`（`src/agents/pi-embedded-subscribe.ts:7` 导入，`:913` 是 `thinking` 流的 emit 点）。

**emit：带序号的进程级总线。** `emitAgentEvent`（`src/infra/agent-events.ts:209`）是所有发射的底座。它做三件事（见第 07 章 7.8.2）：给该 `runId` 的 `seq` 加一——保证**同一 run 内事件严格有序**；刷新 `lastActiveAt`；`notifyListeners` 广播给所有订阅者。一个 agent 事件是 `AgentEventPayload`（`src/infra/agent-events.ts:102`）：`{ runId, seq, stream, ts, data, sessionKey }`。`stream` 是事件分类——`lifecycle` / `assistant` / `tool` / `item` / `thinking` / `error` 等。对我们这条「你好」trace，模型流式吐出的文本增量被翻成一串 `stream: "assistant"` 的事件，每个 `data` 里带 `text`（截至目前的累积全文）和 `delta`（本次增量）；run 开始/结束则是 `stream: "lifecycle"` 的事件，`data.phase` 区分 `"start"` / `"end"` / `"error"`。

> 命名要点：OpenClaw **没有** `chat_message_text` / `chat_tool_call` / `chat_done` 这种独立事件名。所谓「chat 事件」在 gateway 广播侧是 `stream` 字段加 `data.phase` 区分出来的——`stream === "tool"` 加 `data.phase` 取 `"start"` / `"update"` / `"result"`；`stream === "lifecycle"` 且 `data.phase === "end"` 才是「这一轮结束」。

**可见性控制。** 事件总线维护一个 `runContextById` 映射，每个 run 由 `registerAgentRunContext` 登记（`agentCommandInternal` 在运行开始时登记，`finally` 里清掉）。run context 里有 `isControlUiVisible` 字段。`emitAgentEvent` 用它决定**是否把 `sessionKey` 一并广播**（`src/infra/agent-events.ts:217-227`）：隐藏运行的 `assistant` / `tool` 流量不带 `sessionKey`（下游据此不刷进 Control UI），但 `lifecycle` 事件**始终保留** `sessionKey`——因为 gateway 监听器必须知道这个 session 何时结束才能持久化终态。这正是朴素思路「隐藏运行泄漏」问题的答案。

**谁订阅。** 订阅者通过 `onAgentEvent(listener)`（`src/infra/agent-events.ts:302`）注册到总线。对我们这条 trace，两个订阅者最关键：

- **gateway chat state（事件投影器）**。`src/gateway/server-runtime-subscriptions.ts:85` 用 `onAgentEvent` 挂上一个 handler，每个 agent 事件流经 `server-chat.ts` 的投影器。它做 runId 重映射（引擎内部 `runId` ↔ 客户端 `clientRunId`）、`seq` gap 检测（跳号就广播一个 `stream: "error"` 告知丢事件）、文本增量 **150ms 节流**（`assistant` / `thinking` 攒批合并 `delta`，而不是逐 token 直推——这正是朴素思路「打爆 WebSocket」的答案），最后 `broadcast("agent", ...)` 把事件推给所有有 `READ_SCOPE` 的 WebSocket 客户端。run 结束时还会 `emitChatFinal` 发一个 `broadcast("chat", { state: "final", message })`——我们这条 trace 的「你好」回复，正是这条 `chat` 事件最终把它送到 WebChat 前端。

- **ReplyDispatcher（投递路径）**。`dispatch-from-config.ts` 监听 `stream: "assistant"` 事件，按 `[[block]]` 标记或长度阈值把累积文本切段，调 `dispatcher.sendBlockReply` / `sendFinalReply`。tour-10 创建的那个 `ReplyDispatcher` 在这里开始真正接收事件。

**为什么是总线而不是直连。** `emitAgentEvent` 通过 `notifyListeners` 一次广播给**所有** listener，产生方完全不知道有几个订阅者、它们是谁。加一个新订阅者（诊断 timeline、OpenAI 兼容端点、agent-job 方法——`server-methods/agent-job.ts:161` 和 `:328` 也各挂了一个 `onAgentEvent`）只需 `onAgentEvent(...)` 挂上来，attempt 的流 loop 一行不改。事件总线用 `resolveGlobalSingleton` 保证整个进程共享同一份 listener 集合与 seq 表——它是进程级单例。

走完这一步，模型流式产出的每一段「你好…」文本，都已经变成一串带 `runId` + 单调 `seq` 的 `AgentEventPayload`，正经由 `emitAgentEvent` 广播出去，流向 gateway 的事件投影器和 `ReplyDispatcher` 两个订阅者。

## 6. 代码位置

- `src/infra/agent-events.ts:102-109` — `AgentEventPayload` 类型：`{ runId, seq, stream, ts, data, sessionKey }`。
- `src/infra/agent-events.ts:209-235` — `emitAgentEvent`，所有发射的底座：seq +1、刷新 `lastActiveAt`、`notifyListeners` 广播。
- `src/infra/agent-events.ts:217-227` — 用 `isControlUiVisible` 决定是否保留 `sessionKey`，`lifecycle` 事件始终保留。
- `src/infra/agent-events.ts:302-305` — `onAgentEvent(listener)`，订阅者注册入口。
- `src/agents/pi-embedded-runner/run/attempt.ts:3132-3169` — `subscribeEmbeddedPiSession`，attempt 把回调（含 `onAgentEvent`）挂到底层 pi session。
- `src/agents/pi-embedded-runner/run/attempt.ts:3154` — `onAgentEvent: params.onAgentEvent` 透传。
- `src/agents/pi-embedded-subscribe.ts:7` — 导入 `emitAgentEvent`。
- `src/agents/pi-embedded-subscribe.ts:913-915` — `emitAgentEvent({ stream: "thinking", ... })`，订阅层把原始流翻成 agent 事件的 emit 点之一。
- `src/agents/pi-embedded-subscribe.ts:330-361` — 累积 `assistantTexts`、处理 reasoning 文本的逻辑。
- `src/gateway/server-runtime-subscriptions.ts:85-87` — `onAgentEvent` 挂上 gateway 的 agent 事件 handler。
- `src/gateway/server-chat.ts:805` — agent 事件投影器主函数（`return (evt) => { ... }`）。
- `src/gateway/server-chat.ts:751-761` — `sendOrBufferAgentTextEvent`，`assistant` / `thinking` 文本 150ms 节流。
- `src/gateway/server-chat.ts:856-861` — `seq` gap 检测，跳号广播 `stream: "error"`。
- `src/gateway/server-chat.ts:602-637` — `emitChatFinal`，run 结束发 `broadcast("chat", { state: "final" })`。
- `src/gateway/server-methods/agent-job.ts:161`、`:328` — agent-job 方法的额外 `onAgentEvent` 订阅。
- `src/auto-reply/reply/dispatch-from-config.ts` — 监听 `assistant` 事件、切段、调 `ReplyDispatcher` 的投递路径。

## 7. 分支与延伸

我们这条 trace 走的是「embedded pi、Anthropic、纯文本、无工具」。这一步上没走的岔路：

- **工具事件**：有工具调用时会 emit `stream: "tool"` 事件，`data.phase` 取 `"start"` / `"update"` / `"result"`——这才是「`chat_tool_call`」在本代码库的真实对应。
- **ACP 路径**：走 ACP 通道时事件由 `attempt-execution.ts` 的一组 `emitAcp*` 函数发射（`emitAcpAssistantDelta`、`emitAcpLifecycleEnd` 等），把 ACP 协议事件转译成 agent 事件。
- **reasoning / thinking 流**：thinking 模式下 `stream: "thinking"` 事件单独成路，部分 channel 会抑制它。
- **隐藏运行**：`isControlUiVisible` 为 false 的运行，`assistant` / `tool` 事件不带 `sessionKey`，不刷进 Control UI。
- **慢消费者**：某个 WebSocket 客户端发送缓冲超限会被 `1008 slow consumer` 关闭，不拖垮其他订阅者。
- **孤儿 run context**：`sweepStaleRunContexts` 按 TTL 清理 lifecycle end 丢失导致的泄漏。

想系统理解 agent 事件模型、`emitAgentEvent`、run context 与可见性、谁发射谁订阅，去读 [第 07 章](07-agent-execution.md)（7.8「事件发射」）。想理解事件如何分两路（投递路径走 `ReplyDispatcher`、广播路径走 `broadcast("agent")` / `broadcast("chat")`）、150ms 节流、scope 过滤、慢消费者保护，去读 [第 11 章](11-delivery-and-events.md)。

## 8. 走完这一步你脑子里应该多了什么

- **产生和消费彻底解耦**。attempt 的流 loop 不认识 `ReplyDispatcher`、不认识 WebSocket——它只把原始流转成标准 agent 事件、`emitAgentEvent` 广播。订阅者各自 `onAgentEvent(...)` 挂上来，加一个订阅者不动 attempt 一行。
- **`emitAgentEvent` 给每个事件打单调 `seq`**。同一 run 内事件严格有序；下游靠 `seq` gap 检测来发现「丢了事件」（`server-chat.ts` 会广播一个 `stream: "error"`）。
- **没有 `chat_message_text` / `chat_tool_call` 这种事件名**。事件分类靠 `AgentEventPayload.stream` 字段（`assistant` / `tool` / `lifecycle` / `thinking` …），工具相位再靠 `data.phase`（`start` / `update` / `result`）细分，「这一轮结束」是 `stream === "lifecycle"` 且 `data.phase === "end"`。
- **可见性由 `isControlUiVisible` 控制**。隐藏运行的 `assistant` / `tool` 事件不带 `sessionKey`、不刷进 Control UI；但 `lifecycle` 事件始终保留 `sessionKey`,好让 gateway 持久化终态。
- **逐 token 不直推**。`server-chat.ts` 的投影器对 `assistant` / `thinking` 做 150ms 节流、攒批合并 `delta`,避免几十个连接 × 几十个 delta 打爆 WebSocket。
- 这一步结束时,一串带 `runId` + `seq` 的 agent 事件正流向两个订阅者——gateway 事件投影器和 `ReplyDispatcher`。下一步,这些事件将被累积、整理成一条最终的 `ReplyPayload`。
