# Tour 04：客户端发出 `chat.send`

## 1. 当前情境

上一步结束时，浏览器和 gateway 之间有了一条**已鉴权**的 WebSocket 连接。它在 `clients` 集合里登记在册，带着 `connId`、客户端身份、presence 和一组已授予的 scope。`GatewayBrowserClient`（`ui/src/ui/gateway.ts:438`）在前端这一侧持有这个 socket，`connected` getter 返回 `true`。

现在轮到 trace 里那条「你好」登场了。用户在 WebChat 的输入框（composer）里敲下「你好」，按下回车。我们这一步要看的，是从「用户按回车」到「一个 `chat.send` 请求帧被 `ws.send()` 写进 WebSocket」之间的全过程——纯前端这一侧。

注意：WebChat 是 gateway 的**内建渠道**，不是 `extensions/` 里的插件。它在 gateway 侧由常量 `INTERNAL_MESSAGE_CHANNEL = "webchat"` 标识、实现散落在 `src/gateway/`；它的浏览器前端就是 `ui/` 目录那个 Lit 应用。这一步全程在浏览器里，gateway 还没收到任何东西。

## 2. 问题

用户在输入框里敲的只是一段文本。但 gateway 那一侧是一套结构化的 RPC 协议——它认的是 `{ type:"req", id, method, params }` 这种判别式联合帧（tour-03 §7 的协议）。问题是：

> 一段裸文本，如何被前端封装成一个语义明确、能被 gateway 协议层校验、能把响应配对回来的 RPC 请求帧，并通过那条唯一的 WebSocket 发出去？

## 3. 朴素思路

最直接的做法：监听输入框的回车事件，拿到文本，直接 `ws.send(JSON.stringify({ text: "你好" }))`。gateway 收到后自己看着办。前端发完就不管了——反正回复会以别的消息推回来，到时候再渲染。

## 4. 为什么朴素思路会崩

这个朴素思路在真实的 WebChat 里会以几种具体方式崩掉：

- **没有 `method`，gateway 不知道这是要干什么**。同一条 WebSocket 上，前端会发 `chat.send`、`chat.abort`、`sessions.list`、`config.set` 等几十种请求（tour-02 §3 的方法注册表）。一个只有 `{ text }` 的帧，gateway 的分帧器（tour-03 §4.3）根本无从判断该路由到哪个 handler。帧必须带 `method` 字段。
- **没有请求 `id`，响应配不回来**。`chat.send` 是有返回值的——gateway 会回一个 `res` 帧告诉前端「这条消息收下了，runId 是 X」。WebSocket 是全双工的，前端可能同时有多个在途请求，回来的 `res` 帧靠 `id` 配对（tour-03 §7.2）。没有 `id`，前端拿到 `res` 帧不知道它对应哪次发送，`await` 永远悬着。
- **没有 `sessionKey`，消息落进哪个会话桶无从谈起**。「你好」要进入用户当前那个会话的上下文。前端必须把当前 session 的标识带上，否则 gateway 没有路由依据。
- **重连/重试会让消息发两遍**。WebSocket 会断线重连。如果用户点发送的瞬间连接抖动、前端做了重试，同一条「你好」可能被 gateway 当成两条独立消息处理，触发两次 LLM 调用、两条回复。需要一个幂等键让 gateway 能去重。
- **界面零反馈**。「发完就不管」意味着用户按下回车后，在 gateway 处理、LLM 生成、回复推回来之前，界面上什么都不会变。对一个聊天界面，几秒钟的「死寂」是糟糕的体验。

核心矛盾：输入框里的「你好」是非结构化的、一次性的；而 gateway 协议要求的是**带方法名、带请求 id、带会话路由、带幂等键**的结构化帧，前端还得为「请求在途」这段时间负责 UI 反馈。朴素的 `ws.send(text)` 在每一个维度上都漏。

## 5. OpenClaw 的做法

OpenClaw 把「发一条聊天消息」拆成三层职责分明的函数，每一层补上朴素思路漏掉的一块。

**第一层问题：回车键怎么变成一次「发送」意图。** `renderChat` 给 composer 的 textarea 挂了 `keydown` 处理器（`ui/src/ui/views/chat.ts:1298`）。它的判定很克制：`Enter` 且未按 `Shift`（Shift+Enter 是换行不是发送）、不在输入法合成态（`e.isComposing || e.keyCode === 229`——中文输入法选字时按的回车不算发送，这对「你好」这种中文输入恰恰关键）、连接为 `connected`。三个条件都满足，才 `e.preventDefault()` 并调用 `props.onSend()`（`ui/src/ui/views/chat.ts:1308`）。`onSend` 最终落到 `sendChatMessage`。

**第二层问题：文本怎么变成结构化消息 + 界面怎么立刻有反馈。** `sendChatMessage`（`ui/src/ui/controllers/chat.ts:483`）做四件事：

1. **组装 content blocks**。「你好」被 `trim()` 后包成一个 `{ type:"text", text:"你好" }` block（`ui/src/ui/controllers/chat.ts:516`）。我们这条 trace 没有附件，所以 content 只有这一个 block。
2. **乐观渲染**。在 RPC 还没发出之前，就把一条 `{ role:"user", content, timestamp }` 追加进 `state.chatMessages`（`ui/src/ui/controllers/chat.ts:549`）。因为 `chatMessages` 是 `@state()`，Lit 立刻重渲染——用户按下回车的同一帧，「你好」就出现在聊天记录里。这就是朴素思路「界面零反馈」问题的答案。
3. **生成客户端 runId**。`runId = generateUUID()`（`ui/src/ui/controllers/chat.ts:563`），写进 `state.chatRunId`。这个 UUID 一身兼两职：它既是本次「发送回合」的本地标识，下一步又会作为**幂等键**发给 gateway。
4. **置位流式接收状态**。`state.chatSending = true`、`state.chatStream = ""`（`ui/src/ui/controllers/chat.ts:558`、`:565`）——为即将到来的流式回复准备好缓冲。`chatSending` 为真时再次调用 `sendChatMessage` 会直接早退（`ui/src/ui/controllers/chat.ts:496`），天然防连点。

**第三层问题：结构化消息怎么变成合规的 RPC 帧。** `sendChatMessage` 调用 `requestChatSend`（`ui/src/ui/controllers/chat.ts:416`），它构造 `chat.send` 的 `params` 并发请求：

```ts
// ui/src/ui/controllers/chat.ts:424
await state.client!.request("chat.send", {
  sessionKey: state.sessionKey,
  ...(sessionId ? { sessionId } : {}),
  message: params.message,
  deliver: false,
  idempotencyKey: params.runId,
  attachments: buildApiAttachments(params.attachments),
});
```

每个字段对应朴素思路的一个漏洞：`sessionKey` 是会话路由依据（消息落进哪个桶）；`message` 是文本「你好」；`idempotencyKey` 就是上一步那个 `runId`——gateway 用它去重，重发不会触发两次 LLM；`deliver: false` 是一个关键标志，意思是「这是 WebChat 内部的对话，回复**不要**自动投递回某个外部 IM 渠道，只通过事件流推回来给我」（trace 走的是最简的「无跨渠道」路径，所以是 `false`）。

`request` 把方法名和 params 交给 `GatewayBrowserClient`，真正发帧的是 `requestOnSocket`（`ui/src/ui/gateway.ts:876`）。它补上朴素思路漏掉的最后两块——`method` 和 `id`：

```ts
// ui/src/ui/gateway.ts:876
const id = generateUUID();
const frame = { type: "req", id, method, params };
const p = new Promise<T>((resolve, reject) => {
  this.pending.set(id, { resolve, reject, method, startedAtMs });
});
ws.send(JSON.stringify(frame));
return p;
```

注意这里的 `id` 是**又一个新 UUID**，和上面的 `idempotencyKey`（业务幂等键）是两个不同的东西：`id` 是**协议层**的请求-响应配对键，`idempotencyKey` 是**业务层**的去重键。`requestOnSocket` 把 `{ resolve, reject }` 存进 `pending` Map 按 `id` 索引——等 gateway 回 `res` 帧时，`handleMessage`（`ui/src/ui/gateway.ts:809`）按 `id` 找到这个 Promise 并 resolve。

走完这一步，一个结构完整的请求帧——`{ type:"req", id:<协议UUID>, method:"chat.send", params:{ sessionKey, message:"你好", deliver:false, idempotencyKey:<runId> } }`——被 `JSON.stringify` 序列化、`ws.send()` 写进了 WebSocket。它正沿着 tour-03 建立的那条已鉴权连接飞向 gateway。前端这一侧：「你好」已乐观显示，`chatSending` 为真，`pending` Map 里挂着一个等 `res` 的 Promise。

## 6. 代码位置

- `ui/src/ui/views/chat.ts:1298` — composer textarea 的回车判定：`Enter` 且非 `Shift`。
- `ui/src/ui/views/chat.ts:1300` — 跳过输入法合成态（`isComposing` / `keyCode 229`），对中文输入关键。
- `ui/src/ui/views/chat.ts:1308` — 条件满足后调用 `props.onSend()`。
- `ui/src/ui/controllers/chat.ts:483` — `sendChatMessage`，发送的总入口。
- `ui/src/ui/controllers/chat.ts:496` — `chatSending` 为真时早退，防连点重发。
- `ui/src/ui/controllers/chat.ts:516` — 把「你好」包成 `{ type:"text", text }` content block。
- `ui/src/ui/controllers/chat.ts:549` — 乐观渲染：用户消息立刻进 `chatMessages`。
- `ui/src/ui/controllers/chat.ts:563` — `generateUUID()` 生成客户端 `runId`。
- `ui/src/ui/controllers/chat.ts:558`、`:565` — 置 `chatSending=true`、`chatStream=""` 准备接收流式回复。
- `ui/src/ui/controllers/chat.ts:416` — `requestChatSend`，构造 `chat.send` 的 `params`。
- `ui/src/ui/controllers/chat.ts:424` — `request("chat.send", { sessionKey, message, deliver:false, idempotencyKey, attachments })`。
- `ui/src/ui/gateway.ts:876` — `requestOnSocket`：生成协议层 `id`、组装 `req` 帧、`ws.send`、登记 `pending`。
- `ui/src/ui/gateway.ts:809` — `res` 帧回来时按 `id` 在 `pending` Map 里配对。

## 7. 分支与延伸

我们这条 trace 走的是「纯文本『你好』、无附件、WebChat 内部对话（`deliver:false`）」。这一步上的岔路：

- **带附件发送**：`attachments` 非空时，`sendChatMessage` 会为图片生成 `image` block、为音频/文件生成 `attachment` block（`ui/src/ui/controllers/chat.ts:519`-`546`），`buildApiAttachments` 把它们转成 RPC 形态。
- **斜杠命令**：如果用户敲的是 `/status` 而非「你好」，文本进入命令检测路径——这条岔路在 tour-06 构造 `MsgContext` 时与 `CommandTurn` 汇合。
- **`deliver:true` 的跨渠道发送**：从 WebChat 发一条要投递回某个外部 IM 渠道的消息时 `deliver` 为真，并带 `originatingChannel` 等路由字段。
- **重连时的在途请求**：连接断开时 `flushPending`（`ui/src/ui/gateway.ts:558`）把所有 `pending` 的 RPC 用 `CLIENT_CLOSED` reject 掉，不让它们永久悬挂。
- **请求耗时遥测**：`requestOnSocket` 记的 `startedAtMs` 用于 `onRequestTiming`，前端能统计每个 RPC 方法的耗时。

想完整理解 WebChat 前端（Lit 架构、`GatewayBrowserClient`、三种帧、乐观渲染与流式渲染），去读 [第 12 章](12-web-ui-canvas.md)。想系统理解 gateway 协议帧格式（`req`/`res`/`event` 的 TypeBox schema、协议版本协商），去读 [第 2 章](02-gateway-control-plane.md)。

## 8. 走完这一步你脑子里应该多了什么

- 「发一条聊天消息」在 WebChat 里是**三层函数**：回车键处理器（`ui/src/ui/views/chat.ts:1298`）判定发送意图 → `sendChatMessage` 把文本结构化并做乐观渲染 → `requestChatSend` + `requestOnSocket` 组装并发出 RPC 帧。
- 一个 `chat.send` 请求帧的形状是 `{ type:"req", id, method:"chat.send", params }`。`method` 让 gateway 知道路由到哪个 handler，`id` 让 `res` 响应能配对回来——这两个字段由 `requestOnSocket` 补上。
- 一次发送里有**两个不同的 UUID**：协议层的请求 `id`（请求-响应配对）和业务层的 `idempotencyKey`（即客户端 `runId`，gateway 用它去重，防重发触发两次 LLM）。
- **乐观渲染**：用户消息在 RPC 发出之前就进 `chatMessages` 显示出来——`@state()` 变化驱动 Lit 重渲染，界面零延迟有反馈。`chatSending` 标志同时充当防连点闸门。
- `params` 里的 `deliver:false` 标明这是 WebChat 内部对话，回复不投递回外部渠道——这是我们这条「最简路径」trace 的关键前提。
- 这一步结束时，一个合规的 `chat.send` 请求帧已被 `ws.send()` 写进 WebSocket——下一步，gateway 的方法注册表会收到它并把它路由到 `chat.send` handler。
