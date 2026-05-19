# Tour 06：构造 MsgContext

## 1. 当前情境

上一步结束时，`handleGatewayRequest` 走完五道关卡，把 `chat.send` 的 handler 函数调起来了。这个 handler 在 `src/gateway/server-methods/chat.ts:1969`——一个 `"chat.send": async ({ params, respond, context, client }) => { ... }`。

handler 拿到的 `params`，就是 tour-04 前端 `requestChatSend` 拼的那个对象：`{ sessionKey, message:"你好", deliver:false, idempotencyKey:<runId>, attachments }`。它还能从 `client` 上读到连接级信息（`client.connect.scopes`、`client.connect.client` 等），从 `context` 上读到 gateway 的运行时上下文。`respond` 是回 `res` 帧的回调。

我们这一步要看的，是 `chat.send` handler 如何把这袋 RPC 参数，规范化、构造成一个 **`MsgContext`**——OpenClaw 入站消息管线认的那个统一信封。

## 2. 问题

`params` 是一袋来自 WebChat 这个特定渠道、特定协议的字段。而 gateway 下游的入站消息管线（`src/auto-reply/`）只认一种数据结构——`MsgContext`，它是一个汇集了「围绕一条入站消息所能知道的一切事实」的扁平信封（第 05 章 §1）。问题是：

> `chat.send` 的 RPC 参数，如何被翻译、规范化、补全成一个 `MsgContext` 入站信封，使下游分发器完全不必关心「这条消息是从 WebChat 的 RPC 来的」？

## 3. 朴素思路

`chat.send` handler 直接拿 `params` 往下传。`message` 字段就是消息正文，`sessionKey` 就是会话路由——下游需要什么字段，让下游自己从 `params` 里取。反正 WebChat 是 gateway 内建渠道，handler 和下游都是自己人，约定好字段名就行。

## 4. 为什么朴素思路会崩

这个朴素思路在 OpenClaw 的多渠道架构里会以几种具体方式崩掉：

- **下游会被渠道差异撕碎**。OpenClaw 把二十余种渠道（Telegram、Slack、邮件、WhatsApp……）统一接入一个 LLM 助手。下游的 `dispatchInboundMessage`、会话解析、agent 执行层，是**所有渠道共用**的。如果 WebChat 直接把自己的 `chat.send` 参数往下传，Telegram 把自己的 `update` 往下传，下游就要为每种渠道写一套读取逻辑——每加一个渠道，核心逻辑改一遍，复杂度爆炸。第 05 章开篇讲的就是这个：入站管线必须是一道**收敛层**，所有渠道在进入 agent 执行层之前都被规整成同一种结构。
- **一条消息需要的「正文视图」不止一个**。`params.message` 是「你好」这一段裸文本。但下游对正文的需求是相互冲突的：**命令检测**需要绝对干净的文本（`/think` 必须在行首才算命令）；**提示词组装**却需要带上时间戳、结构上下文让 LLM 理解语境。一个 `message` 字段同时满足不了。`MsgContext` 因此有 `Body`/`BodyForAgent`/`BodyForCommands`/`RawBody`/`CommandBody` 五个正文字段（第 05 章 §1.2），各自「净度」不同。朴素地传 `params.message` 等于把这个分治问题甩给下游。
- **渠道身份字段缺失**。下游要知道「这条消息从哪个渠道来」（`Provider`/`Surface`）、「会话类型是什么」（`ChatType`：direct/group）、「是不是一条命令」（`CommandTurn`/`CommandAuthorized`）。这些 `params` 里根本没有——它们是 handler 根据「我是 WebChat handler」这个事实**派生**出来的。不派生，下游拿到的就是一袋残缺信息。
- **`sessionKey` 不等于规范会话键**。前端传的 `params.sessionKey` 是原始值，可能需要归一化、可能需要解析出 agent id。handler 这一层有 gateway 的配置和会话存储，是做这件归一化的正确位置；下游不该再为「键怎么归一」操心。

核心矛盾：`chat.send` 的 `params` 是 **WebChat 渠道专属、协议专属**的；而下游入站管线要的是一个**渠道无关、字段齐备、正文分治**的 `MsgContext` 信封。直接传 `params`，等于把收敛这件事漏掉，让渠道差异污染整个下游。

## 5. OpenClaw 的做法

OpenClaw 让 `chat.send` handler 承担「WebChat 渠道适配」的职责——它在调用下游之前，把 `params` 翻译成一个填好的 `MsgContext`。

**先回到问题：翻译 + 规范化 + 补全。** handler 在动手构造信封之前，先做了几步准备：

- **消息文本净化**。`sanitizeChatSendMessageInput(p.message)`（`src/gateway/server-methods/chat.ts:2029`）清洗输入文本，得到 `inboundMessage`，后续赋给 `parsedMessage`（`src/gateway/server-methods/chat.ts:2096`）。
- **会话条目加载与键归一**。`loadSessionEntry(rawSessionKey)`（`src/gateway/server-methods/chat.ts:2064`）从会话存储里查出条目，并返回一个 **`canonicalKey`**——这就是规范化后的 `sessionKey`（`src/gateway/server-methods/chat.ts:2061`）。前端传的原始 `sessionKey` 在这里被归一成下游能直接用的规范键。
- **路由解析**。`resolveChatSendOriginatingRoute`（`src/gateway/server-methods/chat.ts:2163`）算出 `originatingChannel`/`originatingTo`/`explicitDeliverRoute` 等回复路由字段。我们 trace 走的是 `deliver:false` 的 WebChat 内部对话，这些字段大多空缺。
- **正文视图分治**。handler 算出几个不同净度的正文。`commandBody` 是命令检测用的（`src/gateway/server-methods/chat.ts:2348`，我们这条「你好」不是 `/think` 开头，所以 `commandBody` 就是 `parsedMessage` 本身）；`stampedMessage` 是给 agent 的——`injectTimestamp` 把当前时间戳注入进去（`src/gateway/server-methods/chat.ts:2363`），让 LLM 知道「现在几点」。注释（`src/gateway/server-methods/chat.ts:2361`）特别点明：**只有 `BodyForAgent` 带时间戳，`Body` 保持原始**供 UI 显示。这正是朴素思路漏掉的「一条消息需要多个正文视图」。

**然后构造信封。** `src/gateway/server-methods/chat.ts:2365` 处，handler 组装 `MsgContext`：

```ts
// src/gateway/server-methods/chat.ts:2365
const ctx: MsgContext = {
  Body: messageForAgent,
  BodyForAgent: stampedMessage,
  BodyForCommands: commandBody,
  RawBody: parsedMessage,
  CommandBody: commandBody,
  SessionKey: sessionKey,                  // 已归一的 canonicalKey
  Provider: INTERNAL_MESSAGE_CHANNEL,      // "webchat"
  Surface: INTERNAL_MESSAGE_CHANNEL,       // "webchat"
  OriginatingChannel: originatingChannel,
  OriginatingTo: originatingTo,
  ExplicitDeliverRoute: explicitDeliverRoute,
  ChatType: "direct",
  CommandAuthorized: true,
  CommandTurn: commandSource
    ? { kind: "text-slash", source: commandSource, authorized: true, body: commandBody }
    : { kind: "normal", source: "message", authorized: false, body: commandBody },
  MessageSid: clientRunId,
  // ... SenderId / SenderName（非操作员 UI 客户端时）
  GatewayClientScopes: client?.connect?.scopes ?? [],
};
```

逐组看这个信封怎么补上朴素思路漏掉的东西：

- **五个正文字段全部填好**。`Body`/`BodyForAgent`/`BodyForCommands`/`RawBody`/`CommandBody` 各就各位——下游的命令检测和提示词组装拿到的是各自需要的净度，不必再分治。
- **渠道身份显式标注**。`Provider` 和 `Surface` 都被设成 `INTERNAL_MESSAGE_CHANNEL`——这个常量值是 `"webchat"`。这就是 WebChat 作为 gateway 内建渠道在信封上的「身份证」：下游看到 `Surface === "webchat"` 就知道这条消息来自 WebChat，但它读的是一个**通用字段**，不是 WebChat 专属结构。
- **`ChatType: "direct"`**。WebChat 是一对一的助手对话，会话类型恒为 `direct`。这个字段下游用来决定静默回复策略等（群聊里未被提及的消息可能不回复，direct 则总回复）。
- **`CommandTurn` 命令回合**。我们这条「你好」不是斜杠命令（`commandSource` 为 `undefined`），所以 `CommandTurn` 走 `kind:"normal"` 分支——`authorized: false`，普通聊天消息恒不被当作授权命令（第 05 章 §5.2 的判别联合）。如果用户敲的是 `/think ...`，则走 `kind:"text-slash"` 分支。
- **`CommandAuthorized: true`** 与 `GatewayClientScopes`：前者是信封层面的命令授权标志，后者把连接的 scope 带进信封供下游策略判断。
- **`MessageSid: clientRunId`**：`clientRunId` 即前端传来的 `idempotencyKey`。它在信封里充当这条入站消息的消息 id。

注意一个事实：WebChat 这条路径**没有**走第 05 章 §2 那个通用的 `buildChannelInboundEventContext()`——那是给外部 IM 渠道用的「分组事实 → 信封」构造入口。`chat.send` handler 是 gateway 内建渠道，它直接手搓 `MsgContext`，因为它对 WebChat 的输入形态了如指掌。但产出的东西是同一种 `MsgContext`，下游一视同仁。

handler 把这个 `ctx` 攒好后，并不会立刻分发——它还会先 `respond` 一个 ack（带 `runId`）回前端、登记活跃 chat run、组装回复 dispatcher。这些是后续步骤的事。这一步的终点是：一个字段填好的 `MsgContext` 已经在 handler 的局部变量 `ctx` 里就位。

走完这一步，那条「你好」不再是一袋 `chat.send` 协议参数，而是一个**渠道无关的 `MsgContext` 入站信封**——正文五视图齐备、渠道身份标注为 `webchat`、会话键已归一、命令回合已判定。下一步，这个 `ctx` 会被交给 `dispatchInboundMessage`。

## 6. 代码位置

- `src/gateway/server-methods/chat.ts:1969` — `chat.send` handler 入口。
- `src/gateway/server-methods/chat.ts:2029` — `sanitizeChatSendMessageInput(p.message)`，清洗输入文本。
- `src/gateway/server-methods/chat.ts:2064` — `loadSessionEntry(rawSessionKey)`，加载会话条目并归一会话键。
- `src/gateway/server-methods/chat.ts:2061` — 解构出 `canonicalKey` 作为规范 `sessionKey`。
- `src/gateway/server-methods/chat.ts:2163` — `resolveChatSendOriginatingRoute`，解析回复路由字段。
- `src/gateway/server-methods/chat.ts:2348` — `commandBody`：命令检测用的正文视图。
- `src/gateway/server-methods/chat.ts:2363` — `injectTimestamp` 给 `BodyForAgent` 注入时间戳（`Body` 保持原始）。
- `src/gateway/server-methods/chat.ts:2365` — 构造 `MsgContext`，本步的核心。
- `src/gateway/server-methods/chat.ts:2373`-`2374` — `Provider`/`Surface` 设为 `INTERNAL_MESSAGE_CHANNEL`（即 `"webchat"`）。
- `src/gateway/server-methods/chat.ts:2380` — `ChatType: "direct"`。
- `src/gateway/server-methods/chat.ts:2383` — `CommandTurn`：`text-slash`（斜杠命令）或 `normal`（普通消息）。
- `src/gateway/server-methods/chat.ts:2396` — `MessageSid: clientRunId`。
- `src/auto-reply/templating.ts:42` — `MsgContext` 类型定义（约 240 行字段）。

## 7. 分支与延伸

我们这条 trace 走的是「纯文本『你好』、`commandSource` 为空走 `normal` 回合、`deliver:false`、direct 会话」。这一步上的岔路：

- **斜杠命令**：用户敲 `/think ...` 时 `commandSource` 为 `"text"`，`CommandTurn` 走 `kind:"text-slash"` 分支、`authorized:true`，`commandBody` 还会被拼上 `/think` 前缀。
- **带附件**：`chat.send` 带 `attachments` 时，handler 会解析、暂存图片，并把 `MediaPath`/`MediaPaths`/`MediaTypes` 等媒体字段注入 `ctx`（`src/gateway/server-methods/chat.ts:2407`-`2418`）。
- **外部 IM 渠道的信封构造**：Telegram/Slack 等不手搓 `MsgContext`，而是先填分组事实再过 `buildChannelInboundEventContext()`（第 05 章 §2）。
- **跨渠道发送（`deliver:true`）**：`OriginatingChannel`/`OriginatingTo`/`ExplicitDeliverRoute` 这些此刻空缺的字段会被填上，把回复路由到外部渠道。
- **系统溯源字段**：`systemInputProvenance` / `systemProvenanceReceipt` 等需要 admin scope 的字段会改变 `Body` 的拼装。

想完整理解 `MsgContext` 这个信封（240 行字段的分组、五个正文字段为何如此分治、`FinalizedMsgContext` 的类型升级、命令回合判别联合），去读 [第 5 章](05-inbound-pipeline.md)。

## 8. 走完这一步你脑子里应该多了什么

- `chat.send` handler 的核心职责是**渠道适配**：把 WebChat 专属的 RPC `params` 翻译成一个**渠道无关的 `MsgContext` 入站信封**，让下游入站管线完全不必关心「这条消息是 WebChat 来的」。
- `MsgContext` 是一个**扁平的事实信封**，不是「一条消息」。一条「你好」在信封里有五个正文字段——`Body`/`BodyForAgent`/`BodyForCommands`/`RawBody`/`CommandBody`——因为命令检测要干净文本、提示词组装要带时间戳上下文，需求相反。
- WebChat 在信封上的「身份证」是 `Provider`/`Surface` 字段被设为 `INTERNAL_MESSAGE_CHANNEL`（值为 `"webchat"`）。WebChat 是 gateway 内建渠道——handler 直接手搓 `MsgContext`，不走外部渠道才用的 `buildChannelInboundEventContext()`，但产出同一种结构。
- `ChatType: "direct"`、`CommandTurn: { kind:"normal", authorized:false }`——这些字段不在 `params` 里，是 handler 根据「我是 WebChat handler、这条不是斜杠命令」**派生**出来的。
- 会话键在 handler 这一层就被 `loadSessionEntry` 归一成 `canonicalKey`——下游拿到的 `SessionKey` 是规范键，不必再操心归一化。
- 这一步结束时，handler 局部变量 `ctx` 里是一个字段填好的 `MsgContext`——下一步，它会被交给入站分发总协调器 `dispatchInboundMessage`。
