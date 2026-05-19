# Tour 05：RPC 方法注册表分发

## 1. 当前情境

上一步结束时，前端把一个结构完整的请求帧——`{ type:"req", id:<协议UUID>, method:"chat.send", params:{ sessionKey, message:"你好", deliver:false, idempotencyKey:<runId> } }`——`JSON.stringify` 序列化后 `ws.send()` 写进了那条已鉴权的 WebSocket。

现在帧到了 gateway 这一侧。tour-03 讲过，握手成功后每条 WebSocket 消息都进 `attachGatewayWsMessageHandler`（`message-handler.ts`）。这一帧被 Ajv 用 `validateRequestFrame` 校验过结构（tour-02 §7 的协议第一道防线），确认是一个合法的 `req` 帧。消息处理器构造好 `respond` 回调，动态 import `server-methods.js`，调用 `handleGatewayRequest`。

我们这一步要看的，就是 `handleGatewayRequest` 内部：一个 `method` 字段值为 `"chat.send"` 的帧，如何被路由到那个真正处理聊天发送的 handler 函数。

## 2. 问题

gateway 通过这条 WebSocket 暴露了几十种 RPC 方法——`health`、`config.set`、`channels.start`、`sessions.list`、`chat.send`……每一种背后是一个不同的 handler 函数。现在手上是一个 `method:"chat.send"` 的帧。问题是：

> 如何按方法名把这个帧路由到正确的 handler 函数，并且在调用 handler 之前，确认这条连接**有权**调用 `chat.send`？

## 3. 朴素思路

写一个大 `switch`：

```ts
switch (req.method) {
  case "health": return handleHealth(req);
  case "chat.send": return handleChatSend(req);
  case "config.set": return handleConfigSet(req);
  // ... 几十个 case
}
```

鉴权？在每个需要鉴权的 `case` 里各自检查一下连接的 scope 就行。`chat.send` 这个 case 开头加一行「如果没有写权限就报错」。

## 4. 为什么朴素思路会崩

这个朴素思路在 OpenClaw 这种规模的控制面里会以几种具体方式崩掉：

- **插件方法进不了 `switch`**。OpenClaw 的方法不全是核心代码写死的——插件可以注册自己的 RPC 方法（tour-02 §3.2 的「三类方法来源」）。一个编译期写死的 `switch` 语句，没有任何办法在运行时塞进一个插件注册的新方法名。而插件还能**热重载**，`switch` 更是无能为力。
- **鉴权散落 = 漏一处就是一个绕过点**。如果鉴权在每个 `case` 里各做一遍，几十个方法就有几十处鉴权代码。新加一个方法时忘了写那行检查，它就完全没鉴权——一个 `operator.read` 的连接能调到本该 `operator.admin` 的方法。tour-03 §4 已经讲过这个矛盾：鉴权必须**集中**，不能散落。
- **方法名冲突静默覆盖**。两处代码不小心注册了同名方法，`switch` 里后一个 `case` 永远不会被执行，或者插件方法悄悄盖掉核心方法——没有任何报错，只有诡异的行为。
- **「方法 → 权限」不可审计**。安全审计想回答「哪些方法需要 admin 权限」，面对一个散落着鉴权检查的大 `switch`，只能逐个 `case` 读代码。权限策略应该是**数据**，能一眼看全。
- **缺乏统一的关卡**。除了 scope 鉴权，`chat.send` 这类请求还需要别的关卡：gateway 启动期某些方法尚不可用、控制面写操作要限流。朴素 `switch` 里这些只能东一处西一处地补。

核心矛盾：方法集合是**运行时可变**的（核心 + 插件 + 热重载），鉴权和各种关卡必须**集中且声明式**——一个编译期写死、鉴权散落的 `switch` 在每个维度都崩。

## 5. OpenClaw 的做法

OpenClaw 不用 `switch`，而是用一个**方法注册表**（method registry）+ 一条**固定的关卡管线**。

**先回到「问题」：路由 + 鉴权。** 路由那一半由注册表解决——注册表是一个 `Map<string, GatewayMethodDescriptor>`，把方法名映射到「描述符」，描述符里有 `handler`（处理函数）和 `scope`（所需权限）等字段（tour-02 §3.1）。`chat.send` 的核心描述符在静态规格表里声明（`methods/core-descriptors.ts:190`）：

```ts
{ name: "chat.send", scope: "operator.write" },
```

一行数据就说清了「`chat.send` 这个方法需要 `operator.write` scope」。注册表合并三类来源——core、plugin、aux——的描述符（`src/gateway/server-methods.ts:168` 的 `createRequestGatewayMethodRegistry`），并强制「方法名全局唯一、每个方法必有 scope」两个不变量（重复注册直接抛错）。插件方法和热重载因此都能进同一个注册表，朴素 `switch` 进不去的方法在这里都有位置。

**鉴权那一半钉死在管线第一关。** `handleGatewayRequest`（`src/gateway/server-methods.ts:179`）是请求分发的真正入口。它不是直接查表调 handler，而是让请求依次穿过**五道关卡**，`chat.send` 这一帧逐关走下去：

**关卡 1 — scope 鉴权（`src/gateway/server-methods.ts:185`）。** `authorizeGatewayMethod(req.method, client, req.params)` 决定这条连接能不能调 `chat.send`。它的逻辑（`src/gateway/server-methods.ts:66`）：

```ts
// src/gateway/server-methods.ts:82
const scopes = client.connect.scopes ?? [];
// ...
if (scopes.includes(ADMIN_SCOPE)) {
  return null;                       // admin 通吃，放行
}
const scopeAuth = authorizeOperatorScopesForMethod(method, scopes, params);
if (!scopeAuth.allowed) {
  return errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${scopeAuth.missingScope}`);
}
```

关键点：`client.connect.scopes` 就是 **tour-03 握手时一次性确定、附着在 `GatewayWsClient` 上的那组 scope**。这里**不重新鉴权**——连接级身份早已验明，这一关只是拿已知的 scope 去比对 `chat.send` 描述符声明的 `operator.write`。这正是 tour-03 §5「鉴权一次、scope 复用」承诺的兑现点。`authorizeOperatorScopesForMethod`（来自 `method-scopes.ts`）里还有两条规则：`operator.admin` 是超级 scope 一律放行；`operator.write` 隐含 `operator.read`。我们这条 trace 里，WebChat 连接握手时拿到了包含 `operator.write` 的 scope，所以 `chat.send`（需 `operator.write`）这一关通过。鉴权失败的话，这里就 `respond(false, ..., authError)` 直接返回，handler 根本不会被调到。

**关卡 2 — 启动期可用性（`src/gateway/server-methods.ts:190`）。** `context.unavailableGatewayMethods` 是「sidecar 就绪前不可用」的方法集合。若 `chat.send` 在内，返回带 `retryable:true`、`retryAfterMs` 的 `UNAVAILABLE` 错误，让客户端稍后重试。我们 trace 里 gateway 早已 `ready`，这一关空过。

**关卡 3 — 控制面写限流（`src/gateway/server-methods.ts:202`）。** `methodRegistry.isControlPlaneWrite(req.method)` 为真的方法（如 `config.apply`）受 `3 per 60s` 限流。`chat.send` 不是控制面写方法，这一关空过。

**关卡 4 — 方法解析（`src/gateway/server-methods.ts:228`）。** 这才是路由本身：

```ts
// src/gateway/server-methods.ts:228
const handler = methodRegistry.getHandler(req.method) as GatewayRequestHandler | undefined;
if (!handler) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unknown method: ${req.method}`));
  return;
}
```

`getHandler("chat.send")` 在注册表的 `Map` 里 O(1) 查到 `chat.send` 描述符的 `handler`——它来自 `chatHandlers`（`coreGatewayHandlers` 的一员，`src/gateway/server-methods.ts:106`），实现在 `src/gateway/server-methods/chat.ts`。注册表里找不到的方法就是「未知方法」，报错返回。这一步把朴素 `switch` 的 `case` 派发，换成了一次 `Map` 查找。

**关卡 5 — 请求作用域（`src/gateway/server-methods.ts:237`）。** handler 不是裸调用，而是包在 `withPluginRuntimeGatewayRequestScope` 里。注释（`src/gateway/server-methods.ts:246`）说明原因：插件 runtime 的 subagent 方法在执行时可能需要**反向 dispatch 回 gateway**，请求作用域提供这个能力。包好之后，`invokeHandler()` 真正调用 `chat.send` 的 handler，并把 `{ req, params, client, respond, context }` 传进去。

走完这五关，`chat.send` 的 handler 函数（`server-methods/chat.ts:1969` 那个 `"chat.send": async (...)`）被调用了，参数都已就位。trace 正式从「gateway 控制面分发层」迈进「`chat.send` 业务 handler」。下一步，这个 handler 会开始处理 `params`。

## 6. 代码位置

- `src/gateway/methods/core-descriptors.ts:190` — `{ name: "chat.send", scope: "operator.write" }`，`chat.send` 的核心方法描述符（声明式的「方法名 → 权限」）。
- `src/gateway/server-methods.ts:179` — `handleGatewayRequest`，请求分发的入口，五道关卡的主体。
- `src/gateway/server-methods.ts:142` — `createRequestGatewayMethodRegistry`，合并 core/plugin/aux 三类描述符建注册表。
- `src/gateway/server-methods.ts:185` — 关卡 1：`authorizeGatewayMethod` scope 鉴权。
- `src/gateway/server-methods.ts:66` — `authorizeGatewayMethod` 定义；`src/gateway/server-methods.ts:82` 读取 `client.connect.scopes`（tour-03 握手附着的 scope）。
- `src/gateway/server-methods.ts:190` — 关卡 2：启动期不可用方法检查。
- `src/gateway/server-methods.ts:202` — 关卡 3：控制面写限流（`3 per 60s`）。
- `src/gateway/server-methods.ts:228` — 关卡 4：`methodRegistry.getHandler(req.method)`，按方法名查 handler。
- `src/gateway/server-methods.ts:99` — `coreGatewayHandlers`，`chatHandlers` 即在其中（`src/gateway/server-methods.ts:106`）。
- `src/gateway/server-methods.ts:237` — 关卡 5：`withPluginRuntimeGatewayRequestScope` 包裹后调用 handler。
- `src/gateway/server-methods/chat.ts:1969` — `chat.send` handler 的实现入口（下一步的起点）。

## 7. 分支与延伸

我们这条 trace 走的是「已鉴权的 WebChat 连接、持有 `operator.write`、gateway 已 ready、`chat.send` 五关全过」。这一步上的岔路：

- **scope 不足**：一个只有 `operator.read` 的连接调 `chat.send`，关卡 1 直接 `missing scope: operator.write` 返回。
- **node 角色连接**：`role === "node"` 的连接走 `isRoleAuthorizedForMethod` 的另一条分支（`src/gateway/server-methods.ts:83`-`88`）。
- **插件注册的方法**：插件可注册自己的 RPC 方法和描述符，其 scope 经 `normalizePluginGatewayMethodScope` 归一化后进同一注册表；插件热重载会整体重建注册表。
- **未授权洪泛防护**：一个连接反复触发未授权错误，`respond` 里的 `unauthorizedFloodGuard` 会 `close(1008)` 掉它（tour-03 §4.3）。
- **启动期窗口**：端口已开但 sidecar 未就绪时，关卡 2 让部分方法返回可重试错误。

想完整理解方法注册表（描述符结构、三类来源、不变量、可替换性）和五道关卡的全貌，去读 [第 2 章](02-gateway-control-plane.md)。想系统理解 scope 权限体系（六种 operator scope、`admin` 超级 scope、`write` 隐含 `read`、共享密钥与全套 scope 的关系），去读 [第 14 章](14-auth-and-security.md)。

## 8. 走完这一步你脑子里应该多了什么

- gateway 不用 `switch` 派发 RPC，而是用一个**方法注册表**（`Map<方法名, 描述符>`）。描述符把 `handler` 和所需 `scope` 用数据声明出来——`chat.send` 的描述符就一行：`{ name:"chat.send", scope:"operator.write" }`。注册表能容纳核心 + 插件 + 热重载的方法，`switch` 做不到。
- `handleGatewayRequest` 让每个请求穿过**五道固定关卡**：scope 鉴权 → 启动期可用性 → 控制面写限流 → 方法解析 → 请求作用域。`chat.send` 逐关走过，关卡 4 才是真正的「按名查 handler」。
- **scope 检查就卡在关卡 1**，比对的是 tour-03 握手时附着在连接上的 `client.connect.scopes`——这里**不重新鉴权**，只是复用已验明的身份。鉴权失败时 handler 根本不会被调用。
- 鉴权是**集中**的（一处 `authorizeGatewayMethod`），不是散落在每个 handler 里——新增方法时忘了分类，default-deny 会兜底成「需要 admin」，不会意外开放。
- 这一步结束时，`chat.send` 的 handler 函数已被调用、`{ req, params, client, respond, context }` 已传入——下一步，handler 开始处理 `params` 里那条「你好」。
