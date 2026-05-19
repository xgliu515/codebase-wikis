# Tour 15：组装 ReplyPayload

## 1. 当前情境

上一步（tour-14）结束时，模型的流式推理已经在跑。Anthropic 那边逐 token 吐字，每个 token 被 agent runner 包装成 `AgentEventPayload`——一个带 `runId` / `seq` / `stream` / `ts` / `data` 的事件对象。这些事件正源源不断地流向两类消费者：

- `dispatch-from-config.ts` 里的累积逻辑，盯着 `stream === "assistant"` 的事件，准备把文本变成要外发的回复。
- `server-chat.ts` 里的事件投影器，把同样的事件节流后广播给 WebSocket 客户端。

我们手上现在有的，是「一串正在流动的 agent 事件」。还没有「一条回复」。对「你好」这种短消息，模型大概会吐出「你好！很高兴见到你，有什么可以帮你的吗？」这样十几个 token，分成十几个 `stream === "assistant"` 事件，每个事件的 `data.text` 是「截至目前的累积全文」，`data.delta` 是「这一次新增的那几个字」。

这一步要回答的，是这堆事件怎么收束成一个**完整、定稿、可投递**的回复对象。

## 2. 问题

> 模型是流式产出的——回复一个 token 一个 token 地长出来。但「投递到 channel」这个动作需要的是一个**完整**的回复单元。如何把一串增量事件累积、整理、定稿成一个 channel 无关的 `ReplyPayload`，并且知道「什么时候算说完了」？

## 3. 朴素思路

最直接的想法：不要累积，逐 token 直接投递。模型每吐一个 `data.delta`，就立刻调一次 channel 的发送方法,把这几个字发出去。回复就这样一截一截地实时蹦到用户屏幕上,像打字机一样。这样既不用攒缓冲，也不用判断「说完了没有」——模型停了就自然停了。

## 4. 为什么朴素思路会崩

逐 token 直接投递在 OpenClaw 这个「网关接外部聊天平台」的语境里，会以几种很具体的方式崩掉：

- **平台消息条数爆炸**。Telegram、Discord 这类平台，一次 `sendMessage` 就是一条独立消息。「你好！很高兴见到你」如果按 token 拆成 15 次发送，用户的聊天窗口里就蹦出 15 条消息、手机震 15 下。这不是「实时感」，这是骚扰。平台的反垃圾限速也会立刻把这个 bot 掐掉。

- **没有「定稿」就没有归一化的机会**。回复在投递前要做一串加工：套上 response prefix 模板、剥掉心跳标记、跑插件的 `transformReplyPayload`、判定要不要 `[[reply_to]]` 引用原消息、判定是不是空回复要丢弃（见第 11 章 11.2.3）。这些加工的对象必须是**完整文本**——你没法对「你好！很高」这半句话决定它该不该引用原消息、该不该被当成空回复丢掉。

- **`stream` 字段被忽略会混入垃圾**。agent 事件的 `stream` 不只有 `"assistant"`，还有 `"thinking"`（思考过程）、`"tool"`（工具调用）、`"lifecycle"`（生命周期相位）。逐 token 直接发，意味着 thinking 的内容、工具的中间播报会原样灌进用户的聊天框。用户问「你好」，结果收到一大段模型的内心独白——这是把不该外露的东西外露了。

- **「说完了」这件事没人判定**。模型流结束的标志，是一个 `stream === "lifecycle"` 且 `data.phase === "end"` 的事件。逐 token 投递的模型里没有「收尾」这个动作，于是没有任何一处代码去触发「这一轮的转录持久化」「typing 气泡熄灭」「dispatcher 标记 idle」。整条 trace 的后半段（tour-16、tour-17）就失去了挂载点。

核心矛盾：**模型的产出是增量的、含多种 `stream` 的、无明确终点的；而投递层需要的是完整的、只含可见文本的、有明确「这是最后一条」标记的回复单元。** 这两者之间必须有一个「累积 + 定稿」的环节。

## 5. OpenClaw 的做法

**先把问题钉死**：需要一个东西，把 `stream === "assistant"` 的增量事件攒起来，在模型流结束时收束成一个 channel 无关的回复对象，并明确标记它是「本轮收尾」。

OpenClaw 的回答分三部分。

**第一，`ReplyPayload` 这个 channel 无关的回复单元。** 类型定义在 `src/auto-reply/reply-payload.ts:7`。它故意不认识任何具体平台——`text` 是可见文本，`mediaUrl` / `mediaUrls` 是媒体，`presentation` 描述「想要的富展示」（由各 channel 渲染器去 map 或降级），`channelData` 才是逐 channel 的逃生舱口。还有一组布尔位 `isReasoning` / `isError` / `isCompactionNotice` 让下游能精准决定「这条要不要进 TTS」「web 端要不要显示」。对「你好」这条 trace，最终的 `ReplyPayload` 极简：只有一个 `text` 字段，装着「你好！很高兴见到你，有什么可以帮你的吗？」，没有媒体、没有 presentation。

**第二，累积逻辑在 `dispatch-from-config.ts` 里，没有 `finalizeReply` 这个函数。** 这是一个要纠正的常见误解——代码库里**不存在**名叫 `finalizeReply` 的函数。回复的累积逻辑是分散在 `src/auto-reply/reply/dispatch-from-config.ts` 里的。整体流程是：

1. agent runner 流式吐出 `AgentEventPayload`，`stream === "assistant"` 的事件携带 `data.text`（累积全文）和 `data.delta`（本次增量）。
2. `dispatch-from-config.ts` 监听这些事件，按 agent 显式的切段标记（`[[block]]`）或长度阈值决定要不要把累积文本切成中间段。「你好」这条短回复不会触发任何切段——它从头到尾就是一段。
3. 本轮结束时，把累积文本构造成最终的 `ReplyPayload`，调用 `dispatcher.sendFinalReply(payload)`。这个调用点在 `src/auto-reply/reply/dispatch-from-config.ts:1091`（`sendFinalPayload` 里）以及 `:704`、`:1025` 等几处，分别对应不同的收尾分支。
4. `dispatcher.sendFinalReply` 返回一个 `boolean`：`true` 表示成功入队，`false` 表示这条 payload 在归一化阶段被丢弃（例如 `NO_REPLY` 静默回复、空内容）。调用方需要这个返回值来决定要不要触发兜底逻辑。

**第三，「说完了」由 lifecycle 相位判定，定稿后才投递。** `stream === "assistant"` 的事件只是「又长了一段」，它不代表结束。真正的结束信号是 `stream === "lifecycle"` 且 `data.phase === "end"`——这就是任务里常被误称为 `chat_done` 的东西在本代码库的真实对应（见第 11 章 11.6.1）。`dispatch-from-config.ts` 等到这个相位事件，才知道「模型不会再吐字了」，于是用累积到此刻的全文构造 final `ReplyPayload`，调 `sendFinalReply`，再调 `dispatcher.markComplete()`（告知投递层「本轮不会再有新回复」）。

为什么必须等定稿、而不是逐 token 投递？因为「定稿」这个时刻是后面一连串动作的唯一锚点：

- 只有完整文本才能跑完归一化（response prefix、心跳剥离、`transformReplyPayload`、可渲染性过滤）。
- 只有 final 这个 `ReplyDispatchKind` 才让投递层知道「这是最后一条，可以收尾了」。
- typing 气泡的熄灭、转录的持久化，全都挂在「收尾」这个语义点上。

注意区分：**投递路径**等定稿（攒成完整 `ReplyPayload` 再发到 channel），但**广播路径**不等——`server-chat.ts` 的投影器会把增量事件经 150ms 节流后实时 `broadcast` 给 WebSocket 客户端，让 WebChat 前端看到「打字机」效果（tour-16 详述）。「逐 token 实时感」是靠广播路径给的，不是靠投递路径。两条路径并行解耦，这是理解 OpenClaw 投递层的钥匙。

走完这一步，我们手上有一个**完整、已定稿的 `ReplyPayload`**：`{ text: "你好！很高兴见到你，有什么可以帮你的吗？" }`，已经通过 `sendFinalReply` 入队到 `ReplyDispatcher`，等待被投递。

## 6. 代码位置

- `src/auto-reply/reply-payload.ts:7` — `ReplyPayload` 类型定义，channel 无关的回复单元。
- `src/auto-reply/reply/dispatch-from-config.ts:32` — `import { appendAssistantMessageToSessionTranscript }`，累积逻辑所在文件的依赖。
- `src/auto-reply/reply/dispatch-from-config.ts:1091` — `sendFinalPayload` 里 `dispatcher.sendFinalReply(normalizedPayload)`，把定稿 payload 入队，返回 `queuedFinal`。
- `src/auto-reply/reply/dispatch-from-config.ts:1025` — abort 分支里另一处 `dispatcher.sendFinalReply(payload)`。
- `src/auto-reply/reply/dispatch-from-config.ts:704` — 简单路径的 `dispatcher.sendFinalReply(payload)`。
- `src/auto-reply/reply/reply-dispatcher.types.ts:3` — `ReplyDispatchKind = "tool" | "block" | "final"`，回复只有这三类。
- `src/auto-reply/reply/reply-dispatcher.ts:107` — `normalizeReplyPayloadInternal`，定稿后投递前的归一化（response prefix、心跳剥离、`transformReplyPayload`）。
- `src/auto-reply/reply/reply-payloads-base.ts:90` — `applyReplyThreading`，决定回复要不要引用原消息。
- `src/auto-reply/reply/reply-payloads-base.ts:82` — `isRenderablePayload`，空 payload 在这里被过滤掉。
- `src/gateway/protocol/schema/agent.ts:41` — `AgentEventSchema`，agent 事件的协议形状，`stream` 字段是真正的事件类型。

## 7. 分支与延伸

我们这条 trace 走的是「一条短文本，无切段、无工具、无媒体，一次 `sendFinalReply` 收尾」。这一步上的岔路：

- **多段回复（`block`）**：agent 在文本里写 `[[block]]`，或长文超长度阈值，累积逻辑会切出多个中间段，每段走 `dispatcher.sendBlockReply`（`src/auto-reply/reply/dispatch-from-config.ts:1585`）。
- **工具调用播报（`tool`）**：`stream === "tool"` 的事件被整理成播报文本，走 `dispatcher.sendToolResult`——`data.phase` 的 `start` / `update` / `result` 区分工具的三个阶段。
- **媒体回复**：模型产出图片/语音时，`ReplyPayload` 的 `mediaUrl` / `mediaUrls` 被填充，并触发 `presentation` 的渲染降级。
- **静默回复（`NO_REPLY`）**：模型决定「这次不回」，归一化阶段把 payload 丢弃，`sendFinalReply` 返回 `false`。
- **思考流（`stream === "thinking"`）**：reasoning 内容默认不进外发回复，`shouldSuppressReasoningPayload` 在没有专门 reasoning 通道的 channel 上抑制它。

想系统理解投递层与事件流的全貌——`ReplyDispatcher` 的排队/节流、`ReplyPayload` 的归一化、广播路径与投递路径如何分头跑——去读 [第 11 章](11-delivery-and-events.md)。想了解 agent runtime 如何产出这些事件，回看 [tour-14](tour-14-stream-events.md)。

## 8. 走完这一步你脑子里应该多了什么

- `ReplyPayload`（`src/auto-reply/reply-payload.ts:7`）是 OpenClaw 投递层的「通用货币」——一个 **channel 无关**的回复单元，它故意不认识任何具体平台。
- 代码库里**没有 `finalizeReply` 这个函数**。流式 agent 事件的累积逻辑分散在 `dispatch-from-config.ts` 里：监听 `stream === "assistant"` 事件、累积 `data.text`、本轮结束时构造 final `ReplyPayload` 调 `sendFinalReply`。
- 回复**必须等定稿再投递、不能逐 token 直发**——因为只有完整文本才能跑完归一化（前缀、心跳剥离、线程化、空回复过滤），也因为「final」这个 kind 是后续收尾动作（typing 熄灭、持久化）的唯一锚点。
- 「说完了」的判定不靠 `assistant` 事件，而靠 `stream === "lifecycle"` 且 `data.phase === "end"` 这个相位事件——它是 trace 里常被误称为 `chat_done` 的东西的真实对应。
- 「实时打字感」由**广播路径**（WebSocket 增量推送）提供，「完整回复送达平台」由**投递路径**（攒成 `ReplyPayload`）提供——两条路径并行解耦，这一步只关心投递路径的定稿。
- 这一步结束时，我们手上有一个完整的 final `ReplyPayload`，已通过 `sendFinalReply` 入队到 `ReplyDispatcher`——下一步，它会被真正投递回 WebChat 并广播给所有 WebSocket 客户端。
