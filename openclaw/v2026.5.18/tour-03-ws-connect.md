# Tour 03：WebChat 建立连接

## 1. 当前情境

上一步结束时，gateway 在 `18789` 上监听，方法注册表和插件都已就位，`attachGatewayWsHandlers` 已经把连接处理器挂到了 WebSocket server（`wss`）上。它在等。

现在用户打开浏览器，访问 WebChat 页面。页面上的 JavaScript 做的第一件事，就是向 gateway 发起一个 WebSocket 连接。我们这一步要看的，是从「浏览器发起 WebSocket upgrade」到「一条已鉴权、连接级状态已登记的 WebSocket 通道就绪」之间的全过程。

注意一个关键事实：trace 里那条「你好」消息还没出现。WebSocket 连接的建立和「发消息」是两件事——必须先有一条可信的通道，消息才有地方走。

## 2. 问题

WebSocket 连接一旦建立就是长驻的，而且能调用 `chat.send` 这种会驱动 LLM、产生真实开销的方法。问题是：

> 一个面向公网（或至少面向局域网/tailnet）的网关，如何在 WebSocket 连接建立的那一刻，就确认对端有权调用方法，并为这条连接登记起干净的连接级状态？

## 3. 朴素思路

让 `wss` 接受任何 WebSocket 连接，连上就算数。鉴权？等客户端真的调 `chat.send` 时，在那个 handler 里检查一下 token 就行。连接本身不带状态，每个请求自带身份。

## 4. 为什么朴素思路会崩

这个朴素思路在真实部署里会以几种具体方式崩掉：

- **未鉴权连接白占资源**。WebSocket 是长连接。如果连上就算数、鉴权推迟到第一个业务请求，那么一个恶意客户端可以连上来、什么都不发，就这么挂着。开 1 万条这样的连接，gateway 的文件描述符和内存就被耗光了——它们从未通过鉴权，却一直占着坑。
- **慢速握手攻击无人拦截**。客户端连上后迟迟不发 `connect` 帧。没有握手超时的话，这些「半开」连接会无限堆积。
- **「每个请求自带身份」放大攻击面**。如果鉴权在每个方法 handler 里各做一遍，那么二十几个方法就有二十几处鉴权代码，漏一处就是一个绕过点。而且暴力破解 token 没有统一的限流——攻击者可以高速试 token。
- **连接级状态无处安放**。这条连接是哪个客户端？是 WebChat 还是某个 node 设备？它的 presence（在线状态）、它已鉴权的 scope——这些信息天然属于「连接」这个生命周期。塞进每个请求里，既冗余又容易不一致。

核心矛盾：WebSocket 连接是长驻且有状态的，鉴权必须发生在「连接刚建立」这个唯一的早期时刻，并且要集中、带限流、带超时——推迟到业务请求里做，每一个维度都会漏。

## 5. OpenClaw 的做法

OpenClaw 把鉴权钉死在连接生命周期的最前端，并明确区分「preauth（未鉴权）」和「已鉴权」两个阶段。

当浏览器发起 WebSocket upgrade，`wss` 触发 `connection` 事件，`attachGatewayWsConnectionHandler` 里注册的回调接管这条新 socket。它立刻做几件事：

1. **分配连接身份与预算**。给连接一个 `connId`（`randomUUID()`），从 `preauthConnectionBudget` 里占一个「未鉴权连接」名额——这正是朴素思路「未鉴权连接白占资源」问题的答案：未鉴权连接的总数有上限。
2. **要求第一帧必须是 `connect`**。连接进入 preauth 阶段。消息处理器强制规定：这条连接发来的**第一个请求帧**必须是 `{ type:"req", method:"connect", params: ConnectParams }`。不是 `connect`、或者 `connect` 参数校验不过，连接直接被关。在 preauth 阶段，单帧的字节上限也被压得很低（`MAX_PREAUTH_PAYLOAD_BYTES`），不给攻击者发大 payload 的机会。
3. **握手超时**。`resolvePreauthHandshakeTimeoutMs` 给 preauth 阶段设了一个计时器。客户端连上却不及时发 `connect`，连接会被超时关掉——堵上「慢速握手」那个洞。
4. **校验 `connect` 帧里的鉴权凭据**。`connect` 的 `params.auth` 里带着 `token` 或 `password`（取决于 gateway 的 `--auth` 模式，那是 tour-02 第 1 阶段就定好的）。`resolveConnectAuthDecision` / `resolveConnectAuthState` 用上一步准备好的 `resolvedAuth` 来判定。鉴权失败时，`authRateLimiter` 介入——这是统一的暴力破解限流，不是散落在各个 handler 里。对于浏览器来源还有单独的 `browserRateLimiter`。
5. **登记连接级状态**。鉴权通过后，这条连接才从 preauth「毕业」成一个真正的 `GatewayWsClient`：释放掉 preauth 预算名额、记录它的 `client` 信息（包括它是不是 WebChat 客户端，由 `isWebchatClient` 判定）、登记 presence。连接级的 scope 也在此确定——`chat.send` 需要的 `operator.write` 是否被授予，取决于这次鉴权的结果。

**为什么是「连接级」**：鉴权和 scope 一次确定、附着在 `GatewayWsClient` 上，之后这条连接发的每一个请求帧都复用这个已验明的身份。tour-05 里 `chat.send` 被分发时，不需要重新鉴权——它只需检查「这条连接的 scope 是否覆盖 `chat.send` 要求的 `operator.write`」。这就是朴素思路「每个 handler 各做一遍鉴权」问题的答案：鉴权一次，scope 复用。

走完这一步，浏览器和 gateway 之间有了一条**已鉴权**的 WebSocket 连接，它在 `clients` 集合里登记在册，带着 `connId`、客户端身份、presence 和一组已授予的 scope。

## 6. 代码位置

- `src/gateway/server.impl.ts:1427` — `attachGatewayWsHandlers` 把鉴权、限流器、`resolvedAuth` 传入连接层。
- `src/gateway/server/ws-connection.ts:202` — `attachGatewayWsConnectionHandler`，连接处理器主函数。
- `src/gateway/server/ws-connection.ts:233` — `wss.on("connection", ...)`，每条新 socket 的入口。
- `src/gateway/server/ws-connection.ts:237` — 为连接分配 `connId`。
- `src/gateway/server/ws-connection.ts:239` — 从 `preauthConnectionBudget` 占用未鉴权连接名额。
- `src/gateway/server/ws-connection.ts:433` — `resolvePreauthHandshakeTimeoutMs`，preauth 握手超时。
- `src/gateway/server/ws-connection.ts:178` — 把 message handler 挂到 socket 的 `"message"` 事件。
- `src/gateway/server/ws-connection/message-handler.ts:278` — `attachGatewayWsMessageHandler`，逐帧处理。
- `src/gateway/server/ws-connection/message-handler.ts:403` — preauth 阶段单帧字节上限校验（`MAX_PREAUTH_PAYLOAD_BYTES`）。
- `src/gateway/server/ws-connection/message-handler.ts:451` — 强制第一帧必须是 `connect`，否则报「first request must be connect」。
- `src/gateway/server/ws-connection/message-handler.ts:634` — 读取 `connect.params.auth` 里的 `token`/`password`。
- `src/gateway/server/ws-connection/auth-context.ts` — `resolveConnectAuthDecision` / `resolveConnectAuthState`，判定连接鉴权。
- `src/gateway/auth.ts:36` — `GatewayAuthResult`，鉴权结果类型（`token`/`password`/`device-token` 等方法）。
- `src/gateway/auth.ts:222` — `assertGatewayAuthConfigured`，启动期校验 auth 模式与凭据是否匹配。
- `src/gateway/auth-rate-limit.ts` — `createAuthRateLimiter`，暴力破解统一限流。
- `src/utils/message-channel.ts` — `isWebchatClient`，判定连接是不是 WebChat 客户端。

## 7. 分支与延伸

我们这条 trace 走的是「浏览器 WebChat、token 模式鉴权、握手成功」。这一步上的岔路：

- **`auth` 模式差异**：`none`（loopback 信任）、`password`、`trusted-proxy`（靠反代头）会走不同的判定分支。
- **node 设备连接**：`connect.role === "node"` 的连接是物理设备配对，走 `reconcileNodePairingOnConnect`，presence 语义也不同。
- **device-token / bootstrap-token**：除了共享 token，还有设备级和引导级令牌。
- **鉴权失败**：触发 `UnauthorizedFloodGuard`，把反复失败的来源挡在外面。
- **Control UI 的 tokenless 登录**：受信主机上的浏览器有专门的免 token 路径。

想完整理解 gateway 控制面与连接层的结构，去读 [第 2 章](02-gateway-control-plane.md)。想系统理解鉴权模式、scope 模型、限流与防爆破，去读 [第 14 章](14-auth-and-security.md)。想了解 WebChat 前端这一侧（页面如何发起连接、维持会话），去读 [第 12 章](12-web-ui-canvas.md)。

## 8. 走完这一步你脑子里应该多了什么

- WebSocket 连接有明确的两个阶段：**preauth（未鉴权）** 和 **已鉴权**。连接的第一帧被强制要求是 `connect`，鉴权就在这一帧里完成。
- 鉴权钉死在连接生命周期最前端，配套有三道防线：**preauth 连接预算**（限未鉴权连接总数）、**握手超时**（拦慢速握手）、**统一限流器**（拦 token 爆破）。
- 鉴权**一次完成、附着在 `GatewayWsClient` 上**，连接的 scope 随之确定。之后每个请求帧复用这个身份，不再重新鉴权——这是 tour-05 权限检查的前提。
- gateway 知道一条连接是不是 WebChat 客户端（`isWebchatClient`），这个判定会影响后续 presence 和回复投递。
- 这一步结束时，我们手上有一条**已鉴权的 WebSocket 连接**，登记在 `clients` 里——下一步，WebChat 前端会通过它发出那条 `chat.send`。
