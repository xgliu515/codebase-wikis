# Tour 16：投递回 WebChat 并广播

## 1. 当前情境

上一步（tour-15）结束时，我们手上有一个完整、已定稿的 `ReplyPayload`：

```
{ text: "你好！很高兴见到你，有什么可以帮你的吗？" }
```

它已经通过 `dispatcher.sendFinalReply(payload)` 入队到这一轮的 `ReplyDispatcher`，`dispatcher.markComplete()` 也已调用——投递层知道「本轮不会再有新回复了」。

但「入队」不等于「用户看见了」。这条 payload 现在还在 `ReplyDispatcher` 的 `sendChain` Promise 链上排着队。而且别忘了 trace 的起点：用户是在**浏览器的 WebChat 页面**敲的「你好」。WebChat 是 gateway 的内建渠道（`INTERNAL_MESSAGE_CHANNEL = "webchat"`），不是 Telegram 那种外部平台。回复要回到用户屏幕上，走的不是「上传到外部平台 API」，而是「通过那条早在 tour-03 建立的 WebSocket 连接，把事件帧推回浏览器」。

这一步要看的，就是从「payload 在 dispatcher 队列里」到「用户屏幕上『你好 → 你好！很高兴见到你…』真的出现」之间的全过程。

## 2. 问题

> 一个已定稿的 `ReplyPayload`，如何既被投递层送回 WebChat 这个内建渠道，又被广播给所有连接到这个会话的 WebSocket 客户端，让用户的浏览器实时渲染出回复？

## 3. 朴素思路

WebChat 既然是内建渠道，回复又是要进浏览器的——那最直接的做法：在 `dispatcher` 投递回调里，直接拿到那条 WebSocket 连接，把 `payload.text` 拼成一个帧 `socket.send(...)` 发出去。一个调用、一条连接、一次发送，回复就到了。WebChat 不像 Telegram 要外部 token、要 HTTP 往返，没必要套那么多层。

## 4. 为什么朴素思路会崩

「直接 `socket.send` 给那一条连接」在真实的 OpenClaw 部署里会以几种具体方式崩掉：

- **「那一条连接」不止一条**。同一个会话可能被多个客户端同时观察：用户在桌面浏览器开着 WebChat，手机上也开着，另外还有一个 Control UI 面板盯着同一个 session。回复只发给「发起 `chat.send` 的那条连接」，意味着另外两个屏幕永远看不到这条回复。回复是会话级的可见状态，不是「谁问谁看」的私货。

- **直接 `socket.send` 绕过了 scope 检查**。聊天记录属于 operator 级敏感数据。一条只有 pairing-scope 的握手连接、一条 node-role 的语音设备连接，也可能恰好连在那里——直接往 socket 写，等于把聊天内容泄露给无权读它的连接。鉴权在 tour-03 做过了，但「这条连接有没有权收这个事件」是**每次广播都要重新过的一道闸**。

- **慢客户端会把 gateway 拖垮**。某个浏览器标签页被切到后台、网络卡住，它的 WebSocket 发送缓冲（`bufferedAmount`）会越积越高。直接 `socket.send` 不检查这个，gateway 的内存就被一个卡死的客户端慢慢吃光。

- **投递路径和广播路径被搅成一团**。「把回复记进会话、保证可靠送达」（投递）和「把事件实时推给所有订阅者渲染」（广播）是两件语义完全不同的事。投递关心 durability、重试、回执；广播关心 scope 过滤、节流、慢消费者保护。一个 `socket.send` 把两者混在一起，意味着投递的可靠性逻辑和广播的扇出逻辑互相纠缠，任何一边改动都会波及另一边。

核心矛盾：**回复要抵达的是「一组有权观察该会话的连接」，而不是「发起请求的那一条」；而且「送达」和「广播」是两条语义不同、必须解耦的路径。** 一个裸 `socket.send` 同时违反了这两点。

## 5. OpenClaw 的做法

**先把问题钉死**：需要让定稿的 `ReplyPayload` 既经过投递层（保证它作为「一条回复」被正确处理），又经过广播层（让所有有权的 WebSocket 客户端实时看到它），并且这两条路径解耦、各管各的。

OpenClaw 的回答是**双轨**——投递路径和广播路径并行跑，第 1 步之后就彻底分头，唯一的「汇合」是用户视角。

**轨道一：投递路径——`ReplyDispatcher` → `routeReplyToOriginating` → WebChat。**

`ReplyDispatcher` 的 `sendChain` 是一条 Promise 链（`src/auto-reply/reply/reply-dispatcher.ts:124`），保证 `tool` / `block` / `final` 三类回复严格按入队顺序抵达 channel、永不乱序。轮到我们这条 final payload 时，`enqueue` 做归一化（前缀、心跳剥离、`transformReplyPayload`），final 类型不加人性化延迟（人性化延迟只对非首个 `block` 加），然后调 `options.deliver(payload, { kind: "final" })`。

对 WebChat 这条 trace，`deliver` 闭包最终落到 `routeReplyToOriginating`（`src/auto-reply/reply/dispatch-from-config.ts:631`）——它判定回复要送回的「源渠道」。因为入站消息的 surface 是 `webchat`（`INTERNAL_MESSAGE_CHANNEL`，判定见 `src/auto-reply/reply/dispatch-from-config.ts:570`），回复就路由回 WebChat 内建渠道，而不是去任何外部平台。注意：通用渠道的可靠投递入口是 `sendDurableMessageBatch`（`src/channels/message/send.ts:336`，render → send → commit/fail，产出 `MessageReceipt`）——代码库里**没有 `sendChannelMessage` 这个函数**。WebChat 作为内建渠道，回复内容由 gateway 自己持有、经 `chat-webchat-media.ts` 渲染成浏览器能直接显示的内容块（媒体场景），不需要外部平台往返。

**轨道二：广播路径——`server-chat.ts` 投影器 → `broadcast("chat" / "agent")` → WebSocket 客户端。**

与投递并行，`server-chat.ts` 里的事件投影器盯着同一串 agent 事件。它对外广播的事件**只有两个顶层名字**——这是要纠正的常见误解，代码库里没有 `chat_message_text` 这种事件名：

| 广播事件名 | 用途 | 关键字段 |
| --- | --- | --- |
| `"agent"` | 细粒度 agent 事件流（增量文本、工具相位、生命周期） | `stream`、`seq`、`data` |
| `"chat"` | 面向 WebChat 的高层对话状态 | `state`、`message` |

`"chat"` 事件的 `state` 字段才是细粒度类型，取值 `"delta"` / `"final"` / `"error"` / `"aborted"`：

- **流式增量**：模型每吐一段，投影器调 `emitChatDelta`（`src/gateway/server-chat.ts:471`）。它对 `assistant` 文本做 **150ms 节流**（`src/gateway/server-chat.ts:501` 的 `now - last < 150` 判定），合并增量后 `broadcast("chat", payload)`，payload 的 `state: "delta"`、带 `deltaText` 和当前累积 `message`。这就是用户在 WebChat 里看到的「打字机」效果——它来自广播路径，不是投递路径。
- **收尾**：模型流结束（`stream === "lifecycle"` 且 `data.phase === "end"`），投影器调 `emitChatFinal`（`src/gateway/server-chat.ts:602`）。它**先 flush 掉可能卡在 150ms 节流里的最后一个增量**（`flushBufferedChatDeltaIfNeeded`，`src/gateway/server-chat.ts:619`），再 `broadcast("chat", payload)`，payload 的 `state: "final"`，`message` 装着完整的助手文本（`src/gateway/server-chat.ts:644`）。

每次 `broadcast("chat", payload)` 之后都紧跟一个 `nodeSendToSession(sessionKey, "chat", payload)`（`src/gateway/server-chat.ts:645`）——前者推给 WebSocket 客户端，后者推给绑定到该 session 的 node（语音设备等）。两个分发目标，一份 payload。

**广播的三道保护，正是朴素思路缺的三样：**

真正把 frame 写进 socket 的是 `createGatewayBroadcaster`（`src/gateway/server-broadcast.ts:95`）。它做三件朴素 `socket.send` 不做的事：

1. **扇出给所有有权客户端**，不是只发给发起方——`broadcast` 遍历整个 `clients` 集合。这解决了「同一会话多个屏幕」的问题。
2. **scope 过滤**：`EVENT_SCOPE_GUARDS`（`src/gateway/server-broadcast.ts:21`）声明 `agent` 和 `chat` 事件都要 `READ_SCOPE`，`hasEventScope`（`src/gateway/server-broadcast.ts:62`）逐客户端检查——pairing-scope、node-role 连接收不到聊天广播。
3. **慢消费者保护**：`broadcastInternal` 检查每个连接的 `bufferedAmount`，超过 `MAX_BUFFERED_BYTES` 的客户端，可丢事件（`dropIfSlow`）就丢，否则直接 `socket.close(1008, "slow consumer")`。一个卡死的客户端不会拖垮 gateway。

**汇合点：用户屏幕。** WebChat 前端的 `GatewayBrowserClient` 收到 `"chat"` 帧，`handleChatEvent` 按 `state` 处理——`delta` 事件不断更新正在显示的那条助手气泡（打字机），`final` 事件把完整消息定格进 `chatMessages` 列表。用户屏幕上，「你好」下面，「你好！很高兴见到你，有什么可以帮你的吗？」逐字浮现、最终定格。

走完这一步，回复已经显示在 WebChat 界面上。投递路径（把回复作为「一条回复」处理完）和广播路径（把事件推给所有屏幕）都跑完了。

## 6. 代码位置

- `src/auto-reply/reply/reply-dispatcher.ts:124` — `sendChain` Promise 链，保证回复严格有序抵达 channel。
- `src/auto-reply/reply/dispatch-from-config.ts:631` — `routeReplyToOriginating`，判定回复送回的源渠道。
- `src/auto-reply/reply/dispatch-from-config.ts:570` — 判定当前 surface 是不是 `INTERNAL_MESSAGE_CHANNEL`（webchat）。
- `src/auto-reply/reply/dispatch-from-config.ts:80` — `import { INTERNAL_MESSAGE_CHANNEL }`，WebChat 内建渠道常量。
- `src/channels/message/send.ts:336` — `sendDurableMessageBatch`，通用渠道的可靠投递入口（render → send → commit/fail）。代码库里没有 `sendChannelMessage`。
- `src/gateway/server-chat.ts:471` — `emitChatDelta`，构造 `state: "delta"` 的 `"chat"` 事件并广播。
- `src/gateway/server-chat.ts:501` — 增量文本的 150ms 节流判定。
- `src/gateway/server-chat.ts:529` — `broadcast("chat", payload, { dropIfSlow: true })` + `nodeSendToSession`，delta 的双目标分发。
- `src/gateway/server-chat.ts:602` — `emitChatFinal`，构造 `state: "final"` / `"error"` 的 `"chat"` 事件。
- `src/gateway/server-chat.ts:619` — `flushBufferedChatDeltaIfNeeded`，收尾前 flush 掉节流缓冲里的最后一个增量。
- `src/gateway/server-chat.ts:644` — final 路径的 `broadcast("chat", payload)`。
- `src/gateway/server-broadcast.ts:95` — `createGatewayBroadcaster`，真正把 frame 写进 socket，做 scope 过滤与慢消费者保护。
- `src/gateway/server-broadcast.ts:21` — `EVENT_SCOPE_GUARDS`，声明 `agent` / `chat` 事件需要 `READ_SCOPE`。
- `src/gateway/server-broadcast.ts:62` — `hasEventScope`，逐客户端的事件 scope 检查。
- `src/utils/message-channel-constants.ts:1` — `INTERNAL_MESSAGE_CHANNEL = "webchat"`。

## 7. 分支与延伸

我们这条 trace 走的是「单一会话、WebChat 内建渠道、回复就一条 final、广播给当前连接」。这一步上的岔路：

- **外部平台投递**：回复目标是 Telegram / Discord 时，`deliver` 闭包落到 `sendDurableMessageBatch`，走 render → send → commit，并产出 `MessageReceipt`——回执让 agent 后续能编辑/删除那条平台消息。
- **多 channel 并行投递**：一条回复要同时发到原渠道 + 抄送群，每个目标各持一个 `ReplyDispatcher` 实例，串行链互不阻塞。
- **`seq gap` 检测**：广播路径发现 agent 事件跳号，会广播一个 `stream: "error"` 事件告知客户端「丢事件了」。
- **`partial_failed`**：一批多条消息发出去一半失败，投递层单列这一态并保留回执，重试只针对没发出的那条，不重复发送。
- **typing 指示器**：Telegram 的「正在输入…」气泡由 `TypingController` 管理，等「模型推理完成」+「回复投递完成」两个信号都到齐才熄灭。

想系统理解投递层与事件流——`ReplyDispatcher` 的排队/节流、`MessageReceipt`、广播的 scope 过滤与 frame 复用优化——去读 [第 11 章](11-delivery-and-events.md)。想理解 WebChat 为什么是内建渠道、`INTERNAL_MESSAGE_CHANNEL` 在 core 里怎么被引用，去读 [第 4 章](04-channel-layer.md)。

## 8. 走完这一步你脑子里应该多了什么

- 回复抵达用户走的是**双轨**：**投递路径**（`ReplyDispatcher` → `routeReplyToOriginating` → WebChat，把回复作为「一条回复」可靠处理）和**广播路径**（`server-chat.ts` 投影器 → `broadcast` → WebSocket 客户端，让所有屏幕实时渲染）。两条路径并行解耦。
- WebSocket 广播**只有 `"agent"` 和 `"chat"` 两个顶层事件名**。`"chat"` 事件的 `state` 字段（`delta` / `final` / `error` / `aborted`）才是细粒度类型——代码库里没有 `chat_message_text` 这种事件名。
- 「打字机」效果来自广播路径的 `emitChatDelta`（150ms 节流的 `state: "delta"` 事件），收尾的完整消息来自 `emitChatFinal`（`state: "final"`，发前先 flush 节流缓冲）。
- 广播绝不是裸 `socket.send`：`createGatewayBroadcaster` 做**扇出给所有有权客户端**、**`READ_SCOPE` 过滤**（聊天记录是 operator 级敏感数据）、**慢消费者保护**（`1008` 关掉卡死连接）三件事。
- WebChat 是 gateway 的**内建渠道**（`INTERNAL_MESSAGE_CHANNEL = "webchat"`），回复不出网关进程；通用渠道的可靠投递入口是 `sendDurableMessageBatch`——代码库里没有 `sendChannelMessage` 函数。
- 这一步结束时，「你好 → 你好！很高兴见到你…」已经显示在用户的 WebChat 界面上。trace 只剩最后一件事：把这一轮对话写回会话存储。
