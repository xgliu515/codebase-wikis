# 第 02 章 Gateway 控制平面

> 代码版本锁定：`openclaw/openclaw@50a2481652`（tag `v2026.5.18`，2026-05-18）。
> 本章所有 `file:line` 引用均基于该 commit，路径为仓库根相对路径。

第 01 章的启动链在 `startGatewayServer` 处戛然而止。本章接着讲：Gateway 进程从这个函数被调用，到 HTTP/WebSocket 端口开始接客、再到一个客户端 RPC 请求被分发、最后到 agent 的回复被广播回去——控制平面内部的每一段都在这里展开。

读本章前，请先回到第 01 章 §3.1 的架构图，确认 Gateway 是「第②层」：它上面是渠道接入层，下面是消息编排与 AI 核心。Gateway 本身不产生智能，它是**枢纽**——管连接、管路由、管会话、管插件。

---

## 1. `server.impl.ts` 启动序列

`startGatewayServer`（`src/gateway/server.impl.ts:532-535`）是 Gateway 的真正入口，签名很简单：

```ts
export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
```

返回的 `GatewayServer`（`src/gateway/server.impl.ts:460-462`）只暴露一个 `close()`。也就是说：**Gateway 对调用方是一个黑盒**——你只能启动它、关闭它，中间的一切都封装在这个 1687 行的函数体内。

### 1.1 启动序列的十二个阶段

整个函数体被一连串 `startupTrace.measure("<阶段名>", ...)` 切成清晰的阶段。`createGatewayStartupTrace`（`src/gateway/server.impl.ts:223-419`）是本文件的「计时器」：它在 `OPENCLAW_GATEWAY_STARTUP_TRACE` 为真时往日志打 trace，同时把每段耗时记进 restart trace 和 diagnostics timeline。把所有 `measure`/`mark` 调用按顺序排出来，就是 Gateway 的启动序列：

```
startGatewayServer(port=18789, opts)
  │
  ├─ bootstrapGatewayNetworkRuntime()         网络运行时引导   :536-537
  ├─ resume restart trace (env / handoff)     续接重启 trace   :552-559
  │
  ├─ ① config.snapshot   读取 openclaw.json 快照               :570-580
  ├─ ② config.auth       解析/引导 gateway auth                :607-615
  ├─    control-ui.seed  为非 loopback 安装补 allowedOrigins   :640-650
  ├─ ③ plugins.bootstrap 插件 bootstrap（不加载 runtime 插件） :662-672
  ├─ ④ runtime.config    解析 bind/port/controlUi/auth 等      :726-739
  ├─    control-ui.root  解析 Control UI 静态资源根            :801-808
  ├─    tls.runtime      加载 TLS 运行时                       :816-818
  ├─ ⑤ runtime.state     创建 HTTP server + WS server + 共享态 :871-898
  ├─    node-session     创建节点会话 runtime                  :899-912
  │
  │   runtimeState = createGatewayServerLiveState(...)         :915-924
  │
  ├─ ⑥ runtime.early     早期 runtime（discovery、maintenance）:1038-1078
  ├─    startGatewayEventSubscriptions  注册 agent 事件订阅    :1083-1100
  ├─    startGatewayRuntimeServices     启动 runtime 服务      :1102-1110
  ├─ ⑦ 构建 method registry（core + plugin + aux 描述符）      :1129-1151
  ├─ ⑧ createGatewayRequestContext  构建请求上下文            :1325-1391
  ├─ ⑨ attachGatewayWsHandlers      挂载 WS 连接处理器         :1427-1452
  ├─ ⑩ startListening()             HTTP server 真正监听端口   :1453
  │       └─ mark "http.bound"                                 :1454
  ├─ ⑪ runtime.post-attach  启动 channels / plugin sidecars    :1486-1561
  │       └─ mark "ready"                                      :1563
  └─ ⑫ startManagedGatewayConfigReloader  启动配置热重载       :1568-1615
          └─ schedule post-ready maintenance                   :1620-1657
```

这个序列的**顺序本身就是设计**。几个关键约束：

- **config 必须最先**（阶段①②）：后续所有阶段——auth、bind、插件、TLS——都依赖配置快照。`loadGatewayStartupConfigSnapshot`（`src/gateway/server-startup-config.ts:74`）读取 `openclaw.json`；如果 CLI 预检阶段已经读过，`opts.startupConfigSnapshotRead`（`src/gateway/server.impl.ts:519-522`、`575-577`）会被复用以避免重复解析。
- **HTTP server 创建（阶段⑤）与监听（阶段⑩）是分开的**：`createGatewayRuntimeState` 创建了 `httpServer` 和 `wss`（WebSocket server），但 `startListening()` 要等到阶段⑩、WS 处理器都挂好之后才调用。**为什么**：如果端口先开、处理器后挂，中间窗口里到达的连接会无人应答。先挂处理器、再开端口，杜绝这个竞态。
- **`ready` 标记在 post-attach 之后**（`src/gateway/server.impl.ts:1563`）：`ready` 意味着 channels 和 plugin sidecars 都起来了。但注意——监听端口在阶段⑩就开了，`ready` 在阶段⑪。这中间有个「已监听但 sidecar 未就绪」的状态，由 `startupSidecarsReady` 标志位（`src/gateway/server.impl.ts:824`）追踪。

### 1.2 生命周期与资源管理

Gateway 是长驻进程，启动时会创建大量需要在关闭时释放的资源：HTTP server、WS server、定时器、插件服务、cron、channel 连接、节点 presence 计时器……`server.impl.ts` 用三个层次管理它们的生命周期。

**(1) `runtimeState` —— 可变运行时状态容器**。`createGatewayServerLiveState`（`src/gateway/server.impl.ts:915-924`）创建一个 `GatewayServerLiveState`，它是一个可变对象，承载所有「启动后才确定、关闭时要清理」的句柄：`bonjourStop`、`tailscaleCleanup`、`cronState`、`heartbeatRunner`、`pluginServices`、各种 interval 定时器、`configReloader` 等。整个启动过程中，各阶段不断 `Object.assign(runtimeState, ...)` 往里填句柄（如 `src/gateway/server.impl.ts:1087-1100`、`1102-1110`）。

**(2) `closeOnStartupFailure` —— 启动失败回滚**。整个阶段⑥到⑫被包在一个 `try { ... } catch (err) { await closeOnStartupFailure(); throw err; }` 里（`src/gateway/server.impl.ts:1037`、`1661-1664`）。`closeOnStartupFailure`（`src/gateway/server.impl.ts:1024-1032`）会停掉已注册的 post-ready sidecar、跑 close prelude、跑 close handler。**为什么**：启动到一半失败时，前面阶段已经开了端口、起了定时器；不回滚就会泄漏资源、占着端口。

**(3) `close()` —— 正常关闭**。返回的 `GatewayServer.close`（`src/gateway/server.impl.ts:1668-1686`）按顺序做：

```ts
close: async (opts) => {
  markClosePreludeStarted();              // 标记关闭开始，停掉 post-ready 定时器
  stopRegisteredPostReadySidecars();      // 停 post-ready sidecar
  await runGlobalGatewayStopSafely(...);  // 跑插件的 gateway_stop hook
  await runClosePrelude();                // 关闭 prelude（停 diagnostics/rate limiter/...）
  await close(opts);                      // 真正的 close handler
}
```

`createCloseHandler`（`src/gateway/server.impl.ts:983-1022`）把所有要释放的句柄——`bonjourStop`、`tailscaleCleanup`、`channelIds`、`pluginServices`、`cron`、各 interval、`wss`、`httpServer`——全交给 `createGatewayCloseHandler`，并通过 `drainActiveSessionsForShutdown` 优雅排空进行中的会话。

这里有个值得注意的细节：`setPreRestartDeferralCheck`（`src/gateway/server.impl.ts:631-637`）注册了一个「重启延迟检查」——只要还有命令队列、待发回复、活跃 embedded run 或活跃 task，重启就会被推迟：

```ts
setPreRestartDeferralCheck(() =>
  getTotalQueueSize() + getTotalPendingReplies() +
  getActiveEmbeddedRunCount() + getActiveTaskCount());
```

**为什么**：Gateway 经常因配置变更或更新而重启。如果重启时正有一个 agent 在跑、或有回复还没发出去，粗暴重启会丢消息。这个检查让重启等到「真正空闲」。

---

## 2. HTTP / WebSocket 监听器如何建立

### 2.1 两个 server，一个端口

Gateway 在**同一个端口**（默认 18789）上同时提供 HTTP 和 WebSocket 服务。这是标准的 Node 模式：WebSocket 借用 HTTP server 的 `upgrade` 事件完成协议升级。

`createGatewayRuntimeState`（在阶段⑤被调用，`src/gateway/server.impl.ts:871-898`）一次性创建并解构出一大批运行时句柄，其中和监听直接相关的是：

```ts
const {
  httpServer, httpServers, httpBindHosts, startListening, wss,
  preauthConnectionBudget, clients, broadcast, ...
} = await startupTrace.measure("runtime.state", () =>
  createGatewayRuntimeState({ cfg, bindHost, port, controlUiEnabled, ... }));
```

- `httpServer` / `httpServers` —— HTTP server（可能多个，对应多个 bind 地址）。
- `wss` —— WebSocket server（`ws` 库的 `WebSocketServer`），挂在 HTTP server 的 upgrade 上。
- `startListening` —— 一个延迟执行的函数：调用它才真正 `listen` 端口。
- `clients` —— 已连接 WS 客户端的集合（`Set<GatewayWsClient>`）。
- `broadcast` —— 向所有客户端广播事件的函数。
- `preauthConnectionBudget` —— 「未认证连接预算」，防止未认证连接洪泛。

### 2.2 `bind` 模式：绑哪个地址

`GatewayServerOptions.bind`（`src/gateway/server.impl.ts:464-477`）决定 server 绑到哪个网络接口，注释把四种模式说得很清楚：

| 模式 | 绑定地址 | 用途 |
|------|----------|------|
| `loopback` | `127.0.0.1` | 仅本机，默认最安全 |
| `lan` | `0.0.0.0` | 局域网可达 |
| `tailnet` | Tailscale IPv4（`100.64.0.0/10`） | 仅 Tailnet 可达 |
| `auto` | 优先 loopback，否则 LAN | 自适应 |

实际 bind 地址由阶段④的 `resolveGatewayRuntimeConfig`（`server-runtime-config.ts`，`src/gateway/server.impl.ts:726-739`）解析为 `bindHost`。如果 `bindHost` 不是 loopback，`gatewayDirectReachable` 为真（`src/gateway/server.impl.ts:1045`），会触发额外的安全措施——比如阶段「control-ui.seed」（`src/gateway/server.impl.ts:640-650`）就是专门为非 loopback 安装补 `gateway.controlUi.allowedOrigins`，防止跨站攻击。

### 2.3 真正监听：`startListening` 与端口冲突重试

阶段⑩的 `await startListening()`（`src/gateway/server.impl.ts:1453`）最终走到 `listenGatewayHttpServer`（`src/gateway/server/http-listen.ts:18-61`）。这个函数处理了一个常见的运维痛点——**端口还在 `TIME_WAIT`**：

```ts
const EADDRINUSE_MAX_RETRIES = 20;
const EADDRINUSE_RETRY_INTERVAL_MS = 500;
...
if (code === "EADDRINUSE" && attempt < EADDRINUSE_MAX_RETRIES) {
  // Port may still be in TIME_WAIT after a recent process exit; retry.
  await closeServerQuietly(httpServer);
  await sleep(EADDRINUSE_RETRY_INTERVAL_MS);
  continue;
}
```

逻辑是：遇到 `EADDRINUSE` 时，最多重试 20 次、每次间隔 500ms（共 10 秒）。**为什么**：Gateway 重启时，旧进程刚退出，端口可能还在 `TIME_WAIT`。直接报错对用户太不友好——稍等几秒端口就释放了。重试 20 次仍失败，才抛 `GatewayLockError`，并区分两种语义：「另一个 Gateway 实例正在监听」vs「绑定失败」（`src/gateway/server/http-listen.ts:48-59`）。`GatewayLockError` 这个专门的错误类型让上层 CLI（`gateway-cli/run.ts:26`）能给出「已有 Gateway 在运行」的友好提示，而非裸异常栈。

监听成功后，`startupTrace.mark("http.bound")`（`src/gateway/server.impl.ts:1454`）。此后端口已开，但 `startupSidecarsReady` 仍为 false——见 §4。

---

## 3. RPC 方法注册表

Gateway 通过 WebSocket 暴露的所有能力，都是「RPC 方法」：`health`、`config.set`、`channels.start`、`chat.send`……客户端发一个 `req` 帧带上 `method` 字段，Gateway 找到对应 handler 执行。这套「方法如何注册、命名、分发」的机制集中在 `src/gateway/methods/`。

### 3.1 方法描述符：`GatewayMethodDescriptor`

注册表的基本单元是「方法描述符」，定义在 `methods/descriptor.ts:21-30`：

```ts
export type GatewayMethodDescriptor = {
  name: string;
  handler: GatewayMethodHandler;
  scope: GatewayMethodScope;          // 鉴权 scope
  owner: GatewayMethodOwner;          // 谁注册的：core / plugin / channel / aux
  startup?: GatewayMethodStartupAvailability;  // 是否「sidecar 就绪前不可用」
  controlPlaneWrite?: boolean;        // 是否计入控制平面写入限流
  advertise?: boolean;                // 是否在 hello-ok 里对外公布
};
```

每个字段都承载一个设计意图：

- **`scope`** —— 鉴权。`GatewayMethodScope`（`src/gateway/methods/descriptor.ts:6-9`）是 operator scope（如 `operator.read`、`operator.write`、`operator.admin`、`operator.approvals`）或两个特殊值 `node`、`dynamic` 之一。每个方法声明自己需要的最小权限。
- **`owner`** —— 来源。`GatewayMethodOwner`（`src/gateway/methods/descriptor.ts:11-15`）有四种 `kind`：`core`、`plugin`、`channel`、`aux`。这让注册表能区分「核心方法」和「插件注册的方法」，并施加不同策略（插件方法的 scope 会被 `normalizePluginGatewayMethodScope` 归一化，见下文）。
- **`startup`** —— 启动期可用性。值为 `"unavailable-until-sidecars"` 的方法，在 sidecar 就绪前调用会返回可重试错误（见 §4.3）。
- **`advertise`** —— 是否公布。`advertise: false` 的方法不会出现在握手的 `hello-ok.features.methods` 列表里——它存在但不对外宣传。

### 3.2 三类方法来源，统一进一个注册表

`src/gateway/server.impl.ts:1129-1151` 的 `buildAttachedGatewayMethodRegistry` 把**三类来源**的描述符合并成一个注册表：

```ts
return createGatewayMethodRegistry([
  ...createCoreGatewayMethodDescriptors(coreDescriptorHandlers),      // ① core
  ...createPluginGatewayMethodDescriptors(nextPluginRegistry),        // ② plugin
  ...createGatewayMethodDescriptorsFromHandlers({                     // ③ aux
    handlers: auxHandlers,
    owner: { kind: "aux", area: "gateway-extra" },
    defaultScope: ADMIN_SCOPE,
  }),
]);
```

- **① core 方法**：`createCoreGatewayMethodDescriptors`（`methods/registry.ts:19` re-export 自 `core-descriptors.ts`）。核心方法的「规格表」`CORE_GATEWAY_METHOD_SPECS`（`methods/core-descriptors.ts:18` 起）是一张静态声明式列表，每行一个方法名 + scope，例如：

  ```ts
  { name: "health", scope: "operator.read" },
  { name: "config.set", scope: "operator.admin" },
  { name: "config.apply", scope: "operator.admin", controlPlaneWrite: true },
  { name: "exec.approval.resolve", scope: "operator.approvals" },
  ```

  这张表把「方法名 → 权限」用数据而非代码表达，审计起来一目了然。
- **② plugin 方法**：`createPluginGatewayMethodDescriptors`（`methods/registry.ts:112-125`）从插件注册表取 `gatewayMethodDescriptors`（若有）或从 `gatewayHandlers` 现造。插件方法的 scope 强制经过 `normalizePluginGatewayMethodScope`（`src/gateway/methods/registry.ts:33-34`）归一化——**插件不能自己随便声明高权限 scope**，这是安全边界。
- **③ aux 方法**：core 启动期通过 `createGatewayAuxHandlers`（`src/gateway/server.impl.ts:1112-1123`）产生的「额外 handler」，owner 为 `aux`，默认 `ADMIN_SCOPE`。

`coreGatewayHandlers`（`src/gateway/server.impl.ts:1113`）来自 `server-methods.ts`，是核心方法的实际实现。注意 `src/gateway/server.impl.ts:1134-1140` 的小逻辑：aux handler 里那些「实际上属于核心方法」的（`isCoreGatewayMethodClassified`），会被并进 core 描述符——这是因为某些核心方法的 handler 需要 runtime 才能构造，所以以 aux 形式注入、再认领回 core 身份。

### 3.3 注册表的创建与不变量

`createGatewayMethodRegistry`（`methods/registry.ts:51-74`）做两件事：归一化每个描述符（`normalizeDescriptor`，`src/gateway/methods/registry.ts:25-49`），然后建一个 `Map<string, GatewayMethodDescriptor>` 按名索引。它强制两个不变量：

```ts
if (byName.has(descriptor.name)) {
  throw new Error(`gateway method already registered: ${descriptor.name}`);
}
```

—— **方法名全局唯一**，重复注册直接抛错（`src/gateway/methods/registry.ts:57-59`）。以及每个方法**必须有 scope**，缺 scope 抛错（`src/gateway/methods/registry.ts:36-38`）。**为什么这么严**：方法名冲突会导致一个方法静默覆盖另一个；缺 scope 意味着一个方法可能完全没鉴权。Gateway 选择「启动直接崩」而非「带病运行」。

注册表对外是一个 `GatewayMethodRegistryView`（`src/gateway/methods/descriptor.ts:36-44`），只暴露查询能力：`getHandler`、`getScope`、`isStartupUnavailable`、`isControlPlaneWrite`、`listMethods`、`listAdvertisedMethods`。

### 3.4 注册表是可替换的

`src/gateway/server.impl.ts:1151` 的 `attachedGatewayMethodRegistry` 是一个 `let`，不是 `const`。原因是**插件可以热重载**。`replaceAttachedPluginRuntime`（`src/gateway/server.impl.ts:1162-1181`）在插件 runtime 被替换时，会重建整个 method registry：

```ts
attachedGatewayMethodRegistry = buildAttachedGatewayMethodRegistry(pluginRegistry);
runtimeState.gatewayMethods.splice(0, runtimeState.gatewayMethods.length,
  ...listAttachedGatewayMethods());
```

WS 连接处理器拿到的不是注册表实例，而是一个 `getMethodRegistry: () => attachedGatewayMethodRegistry` 闭包（`src/gateway/server.impl.ts:1449`）。这样插件热重载后，新连接和新请求自动用上新注册表，**无需重启 Gateway**。

---

## 4. WebSocket 连接生命周期

一个 WS 连接从 TCP 握手到断开，由 `attachGatewayWsConnectionHandler`（`src/gateway/server/ws-connection.ts:202`）管理。它在阶段⑨经由薄封装 `attachGatewayWsHandlers`（`src/gateway/server-ws-runtime.ts:26-52`）挂到 `wss` 上。

### 4.1 连接到达：每连接一份状态

`wss.on("connection", (socket, upgradeReq) => { ... })`（`src/gateway/server/ws-connection.ts:233`）的回调里，**每个连接**都有自己的一组闭包变量（`src/gateway/server/ws-connection.ts:234-278`）：

```ts
let client: GatewayWsClient | null = null;   // 握手成功后才有
let closed = false;
const connId = randomUUID();                  // 连接唯一 id
let handshakeState: "pending" | "connected" | "failed" = "pending";
let holdsPreauthBudget = true;
let lastFrameType / lastFrameMethod / lastFrameId;  // 用于断开诊断
```

`connId` 是这个连接的身份证——后续日志、订阅、节点注册都用它。`client` 初始为 `null`，只有握手成功后才被 `setClient`（`src/gateway/server/ws-connection.ts:483-498`）填上。

连接一建立，Gateway **立即主动发一个挑战帧**（`src/gateway/server/ws-connection.ts:313-318`）：

```ts
const connectNonce = randomUUID();
send({ type: "event", event: "connect.challenge",
       payload: { nonce: connectNonce, ts: Date.now() } });
```

这个 `nonce` 用于设备签名认证——客户端要用私钥对它签名，防重放。

### 4.2 握手与超时

连接建立后处于 `handshakeState: "pending"`。Gateway 启动一个**握手超时定时器**（`src/gateway/server/ws-connection.ts:436-448`）：

```ts
const handshakeTimer = setTimeout(() => {
  if (!client) {
    handshakeState = "failed";
    setCloseCause("handshake-timeout", { handshakeMs: Date.now() - openedAt, endpoint });
    close();
  }
}, handshakeTimeoutMs);
```

超时时间由 `resolvePreauthHandshakeTimeoutMs`（`src/gateway/server/ws-connection.ts:433-435`）解析。**为什么需要**：一个连上来却不发 `connect` 请求的 socket，会一直占着 `preauthConnectionBudget`。超时强制关闭，防止未认证连接堆积。

第一个请求帧**必须**是 `{ type:"req", method:"connect", params: ConnectParams }`——`src/gateway/server/ws-connection/message-handler.ts:447-455` 的注释和检查明确了这一点。`connect` 请求经过 auth、scope、协议版本协商后，Gateway 回 `hello-ok` 帧（schema 见 §6.2），并调用 `setClient` 把连接升格为「已认证」：

```ts
setClient: (next) => {
  if (closed) return false;
  releasePreauthBudget();          // 释放未认证预算
  client = next;
  clients.add(next);               // 加入全局客户端集合
  pingTimer = setInterval(() => { socket.ping(); }, 25_000);  // 启动心跳
  return true;
}
```

注意三件事：(1) 握手成功才 `releasePreauthBudget`——预算只约束未认证连接；(2) 此时连接才被加入 `clients` 集合，开始能收到 `broadcast`；(3) 启动 25 秒一次的 ping 心跳保活。

### 4.3 消息分帧与分发

握手后每条 WS 消息都进 `handleMessage`（`message-handler.ts`，由 `attachGatewayWsMessageHandlerOnDemand` 在 `src/gateway/server/ws-connection.ts:450-505` 按需挂载）。`socket.on("message", ...)` 把每条消息包在一个 diagnostic trace 上下文里执行（`src/gateway/server/ws-connection/message-handler.ts:1707-1709`）。

消息处理流程：

```
socket "message"
  → 解析 JSON
  → 用 validateRequestFrame (Ajv) 校验帧结构          message-handler.ts:1614-1620
  → logWs("in","req",{connId,id,method})              :1622
  → 若 usesSharedGatewayAuth：检查 auth generation     :1623-1637
  →     (auth 已轮换 → close(4001))
  → 构造 respond(ok, payload, error) 回调              :1638-1681
  → 动态 import server-methods.js
  → handleGatewayRequest({ req, respond, client,
        methodRegistry: getMethodRegistry(), context }) :1683-1697
```

真正的分发在 `handleGatewayRequest`（`src/gateway/server-methods.ts:179-250`）。它是一个**五道关卡**的管线：

```
handleGatewayRequest(req)
  │
  ├─ 关卡1  authorizeGatewayMethod(method, client, params)   :185-189
  │           scope 鉴权失败 → respond(false, authError)
  │
  ├─ 关卡2  unavailableGatewayMethods.has(method) ?           :190-201
  │           启动期不可用 → respond(false, UNAVAILABLE, retryable)
  │
  ├─ 关卡3  methodRegistry.isControlPlaneWrite(method) ?      :202-227
  │           控制平面写限流（3 次 / 60 秒）超限 → respond(false)
  │
  ├─ 关卡4  handler = methodRegistry.getHandler(method)       :228-236
  │           未知方法 → respond(false, INVALID_REQUEST)
  │
  └─ 关卡5  withPluginRuntimeGatewayRequestScope(            :237-249
              () => handler({ req, params, client, respond, context }))
```

每道关卡都对应一个真实威胁：

- **关卡1（scope 鉴权）**：方法描述符声明的 `scope` 在这里被强制执行。一个 `operator.read` 的连接调 `config.set`（需要 `operator.admin`）会被挡。
- **关卡2（启动期不可用）**：`context.unavailableGatewayMethods`（在 `src/gateway/server.impl.ts:1322-1324` 初始化为 `STARTUP_UNAVAILABLE_GATEWAY_METHODS`）。这就是 §1.1 提到的「端口已开但 sidecar 未就绪」窗口的处理——某些方法在 sidecar 就绪前调用，返回带 `retryable: true` 和 `retryAfterMs` 的错误，让客户端稍后重试，而非失败。
- **关卡3（控制平面写限流）**：标了 `controlPlaneWrite: true` 的方法（如 `config.apply`、`config.patch`）有限流——`3 per 60s`（`src/gateway/server-methods.ts:220`）。**为什么**：配置写入会触发热重载，频繁写入会把 Gateway 拖垮。限流是一道保护。
- **关卡4（方法解析）**：注册表里找不到就是「未知方法」。
- **关卡5（请求作用域）**：handler 不是裸调用，而是包在 `withPluginRuntimeGatewayRequestScope` 里。注释（`src/gateway/server-methods.ts:246-248`）说明原因：插件 runtime 的 subagent 方法（如 context engine 工具在执行时 spawn 子 agent）需要能**反向 dispatch 回 Gateway**——请求作用域提供了这个能力。

handler 执行后通过 `respond` 回一个 `res` 帧。`respond`（`src/gateway/server/ws-connection/message-handler.ts:1638-1681`）里还藏了一个**未授权洪泛防护**（`unauthorizedFloodGuard`）：如果一个连接反复触发未授权错误，超过阈值就 `close(1008, "repeated unauthorized calls")`（`src/gateway/server/ws-connection/message-handler.ts:1658-1663`）——防止恶意客户端用错误请求刷日志、探测权限。

### 4.4 连接断开：清理与广播

`socket.once("close", (code, reason) => { ... })`（`src/gateway/server/ws-connection.ts:358-431`）处理断开。它做的事远不止「关 socket」：

1. **拼装关闭诊断上下文**（`src/gateway/server/ws-connection.ts:365-382`）：把 `closeCause`、`handshakeState`、`lastFrameType/Method/Id`、远端地址等打包进日志。这让「连接为什么断」可追溯——`lastFrameMethod` 经常能直接指出是哪个 RPC 调用导致的断开。
2. **取消所有会话订阅**（`src/gateway/server/ws-connection.ts:400-401`）：`context.unsubscribeAllSessionEvents(connId)`——这个连接订阅的 session 事件全部解绑（订阅注册表见 §5）。
3. **节点注销**（`src/gateway/server/ws-connection.ts:403-417`）：如果这是个 `role === "node"` 的连接（原生设备），从 `nodeRegistry` 注销，清理 remote node info、节点订阅、wake state。
4. **presence 广播**（`src/gateway/server/ws-connection.ts:406-412`）：如果连接有 `presenceKey`，标记为 `disconnect` 并 `broadcastPresenceSnapshot`——让其他客户端知道「这个设备下线了」。

`close()` 函数本身（`src/gateway/server/ws-connection.ts:322-340`）做底层清理：清握手定时器、清 ping 定时器、释放 preauth budget、从 `clients` 集合移除、`socket.close()`。`closed` 标志位防止重复执行。

---

## 5. `server-chat-state`：活跃 chat run 的内存注册表

Gateway 需要在内存里追踪「现在有哪些 agent 正在跑、流式输出到哪了、谁在订阅」。这些**内存注册表**集中在 `src/gateway/server-chat-state.ts`。它们都是纯内存结构——Gateway 重启即清空，不持久化。

### 5.1 `ChatRunRegistry`：每 session 的运行队列

`createChatRunRegistry`（`src/gateway/server-chat-state.ts:21-71`）维护 `Map<sessionId, ChatRunEntry[]>`——每个 session 一个 chat run 队列。`ChatRunEntry`（`src/gateway/server-chat-state.ts:3-6`）只有两个字段：

```ts
export type ChatRunEntry = { sessionKey: string; clientRunId: string };
```

队列语义（`add` / `peek` / `shift` / `remove`）说明：**同一个 session 可以有多个排队的 chat run**。`peek` 取队首（当前正在跑的），`shift` 弹出队首（当前 run 结束、下一个上位），`remove` 按 `clientRunId` 精确移除（某个 run 被中止）。空队列会自动从 Map 删除（`src/gateway/server-chat-state.ts:41-43`），避免内存泄漏。

### 5.2 `ChatRunState`：流式输出的缓冲与节流

`createChatRunState`（`src/gateway/server-chat-state.ts:87-122`）是更大的状态容器，除了 `registry`，还有一堆 `Map` 服务于**流式 token 输出**：

```ts
export type ChatRunState = {
  registry: ChatRunRegistry;
  rawBuffers / buffers: Map<string, string>;        // 累积的文本缓冲
  deltaSentAt: Map<string, number>;                 // 上次发 delta 的时间戳（节流）
  deltaLastBroadcastLen: Map<string, number>;       // 上次广播时的文本长度（去重）
  deltaLastBroadcastText: Map<string, string>;
  agentDeltaSentAt: Map<string, number>;
  bufferedAgentEvents: Map<string, BufferedAgentEvent>;
  abortedRuns: Map<string, number>;                 // 已中止的 run
  clear: () => void;
};
```

这些结构存在的核心原因是**节流**。LLM 流式输出 token 速率很高，如果每个 token 都向所有订阅者广播一个事件，会把 WS 连接和下游渠道淹掉。`deltaSentAt` 记录上次广播时间、`deltaLastBroadcastLen` 记录上次广播的文本长度——`server-chat.ts` 据此决定「这次 delta 是否值得广播」。`src/gateway/server-chat.ts:180-196` 的 `resolveBroadcastDelta` 就是这个逻辑：算出相对上次广播的增量文本，没有增量就返回 `undefined`（跳过广播）。

### 5.3 三个订阅者注册表

谁能收到一个 session 的事件？三个注册表回答这个问题：

- **`SessionEventSubscriberRegistry`**（`src/gateway/server-chat-state.ts:154-178`）：一个 `Set<connId>`——订阅「所有 session 事件」的连接。订阅/退订就是 `connId` 进出集合。
- **`SessionMessageSubscriberRegistry`**（`src/gateway/server-chat-state.ts:180-256`）：双向 `Map`——`sessionToConnIds`（某 session → 哪些连接订阅）和 `connToSessionKeys`（某连接 → 订阅了哪些 session）。双向索引让「连接断开时退订它的全部订阅」（`unsubscribeAll`，`src/gateway/server-chat-state.ts:223-243`）能 O(订阅数) 完成——这正是 §4.4 连接断开时调用的。
- **`ToolEventRecipientRegistry`**（`src/gateway/server-chat-state.ts:258-314`）：`Map<runId, { connIds, updatedAt, finalizedAt? }>`——某个 agent run 的工具事件该发给哪些连接。它带 **TTL 自清理**：普通条目 10 分钟 TTL，已 finalize 的条目 30 秒宽限（`src/gateway/server-chat-state.ts:151-152`）。每次 `add`/`get` 都触发 `prune`（`src/gateway/server-chat-state.ts:261-274`）。**为什么要 TTL**：工具事件接收者绑定的是临时的 agent run，run 结束后这些条目就是垃圾；没有 TTL 它们会无限堆积。

这三个注册表在 `server.impl.ts` 阶段⑤由 `createGatewayRuntimeState` 创建，并在阶段⑧通过 `createGatewayRequestContext`（`src/gateway/server.impl.ts:1368-1377`）把它们的 `subscribe`/`unsubscribe` 方法注入请求上下文——这样 RPC handler 才能处理客户端的「订阅 session 事件」请求。

---

## 6. `server-chat`：协调 agent 响应与 channel 投递

`src/gateway/server-chat.ts`（998 行）是控制平面里**消息分发**的核心。它的职责一句话概括：**把 agent 产生的事件（流式 token、工具调用、生命周期事件）翻译成 Gateway 事件，广播给该收到的人**。

### 6.1 `createAgentEventHandler`：agent 事件的翻译器

核心导出是 `createAgentEventHandler`（`src/gateway/server-chat.ts:218-231`）。它接收一大组依赖（`AgentEventHandlerOptions`，`src/gateway/server-chat.ts:198-216`）：

```ts
export type AgentEventHandlerOptions = {
  broadcast: ChatEventBroadcast;                  // 广播给所有/订阅者
  broadcastToConnIds: (...);                      // 广播给指定连接
  nodeSendToSession: NodeSendToSession;           // 发给某 session 关联的节点设备
  agentRunSeq: Map<string, number>;               // run 的事件序号
  chatRunState: ChatRunState;                     // §5 的节流状态
  resolveSessionKeyForRun: (runId) => string?;    // runId → sessionKey
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  ...
};
```

这组依赖正好把 §5 的三个注册表和 §2 的 `broadcast` 串了起来。`createAgentEventHandler` 返回一个事件处理器，它在 `server.impl.ts` 阶段⑥由 `startGatewayEventSubscriptions`（`src/gateway/server-runtime-subscriptions.ts:30-37`）创建并订阅到 agent 事件流上。

### 6.2 分发如何「协调」agent 与 channel

「协调 agent 响应与 channel 投递」这句话的含义，体现在 `server-chat.ts` 处理一个 agent 事件时同时面向**两类下游**：

```
              agent 产生事件 (delta / tool / lifecycle)
                          │
              createAgentEventHandler 处理
                          │
        ┌─────────────────┼──────────────────────┐
        │                 │                      │
   节流判断           确定接收者              翻译事件
   resolveBroadcast  resolveSessionKeyForRun  AgentEvent → Gateway event
   Delta             + 三个订阅注册表
        │                 │                      │
        └─────────────────┴──────────────────────┘
                          │
            ┌─────────────┴──────────────┐
            ▼                            ▼
   broadcast / broadcastToConnIds   nodeSendToSession
   （发给 WS 客户端：Control UI、    （发给 session 关联的
     CLI、原生 app）                  节点设备）
                                          │
                                   下游：渠道投递 (auto-reply/reply)
                                   把最终回复发回原 IM 渠道
```

关键点：

- **runId ↔ sessionKey 的转换**：agent 事件带的是 `runId`，但订阅是按 `sessionKey` 组织的。`resolveSessionKeyForRun`（`src/gateway/server-chat.ts:209`）做这个映射。`src/gateway/server-chat.ts:270-275` 的注释还揭示了一个优化——只有 subagent/acp 类型的 run 会携带 `spawnedBy` 血缘信息，普通高频 chat 流会短路掉这个查询，避免触碰 session store。
- **节流防淹**：每个 delta 事件先过 `resolveBroadcastDelta`（`src/gateway/server-chat.ts:180-196`）算增量，配合 `chatRunState` 的 `deltaSentAt`/`deltaLastBroadcastText` 判断是否真的广播。`src/gateway/server-chat.ts:234-243` 还按 `assistant` / `thinking` 两种流分别维护节流 key——思考流和回答流独立节流。
- **精确投递**：工具事件用 `broadcastToConnIds` 只发给 `toolEventRecipients` 里登记的连接，而非全员广播——因为不是每个客户端都关心工具执行细节。
- **生命周期错误的宽限**：`src/gateway/server-chat.ts:232` 的 `pendingTerminalLifecycleErrors` + `AGENT_LIFECYCLE_ERROR_RETRY_GRACE_MS`（`src/gateway/server-chat.ts:229`）说明终态错误事件不会立即广播——留一个宽限期，防止可重试的瞬时错误被当成终态报给用户。

`server-chat` 把 agent 世界（runId、AgentEvent、流式 token）和 Gateway 世界（connId、Gateway event、订阅）做了**双向翻译与协调**。它是第 01 章架构图里第④层（AI 核心）和第②层（控制平面）之间的接缝。

---

## 7. Gateway 协议

控制平面所有通信遵循一套定义在 `src/gateway/protocol/` 的协议。它基于 **TypeBox** 定义 schema、用 **Ajv** 做运行时校验（`protocol/index.ts:1`、`protocol/schema/frames.ts:1`）。

### 7.1 协议版本

`src/gateway/protocol/version.ts` 全文只有三行，但每行都重要：

```ts
export const PROTOCOL_VERSION = 4 as const;
export const MIN_CLIENT_PROTOCOL_VERSION = 4 as const;
export const MIN_PROBE_PROTOCOL_VERSION = 4 as const;
```

- `PROTOCOL_VERSION` —— Gateway 当前实现的协议版本。
- `MIN_CLIENT_PROTOCOL_VERSION` —— Gateway 能接受的最低客户端协议版本。客户端在 `connect` 请求里带 `minProtocol`/`maxProtocol`（`src/gateway/protocol/schema/frames.ts:22-23`），Gateway 据此做版本协商；协商不出公共版本就拒绝连接。
- `MIN_PROBE_PROTOCOL_VERSION` —— 探测连接（probe）的最低版本。

当前三者都是 `4`，意味着 v2026.5.18 不向后兼容更老的客户端协议。

### 7.2 三种帧格式

`protocol/schema/frames.ts` 定义了在 WebSocket 上流动的所有帧。所有帧由顶层 `type` 字段区分，`GatewayFrameSchema`（`src/gateway/protocol/schema/frames.ts:173-176`）是它们的判别式联合：

```ts
export const GatewayFrameSchema = Type.Union(
  [RequestFrameSchema, ResponseFrameSchema, EventFrameSchema],
  { discriminator: "type" },
);
```

注释（`src/gateway/protocol/schema/frames.ts:170-172`）说明用 `discriminator` 的原因：让下游 codegen（quicktype）能生成更紧凑的类型，而非「所有字段都可选」的松散 blob。

**请求帧 `req`**（`src/gateway/protocol/schema/frames.ts:138-146`）—— 客户端 → Gateway：

```ts
{ type: "req", id: string, method: string, params?: unknown }
```

`id` 用于把响应配回请求；`method` 是 §3 注册表里的方法名。

**响应帧 `res`**（`src/gateway/protocol/schema/frames.ts:148-157`）—— Gateway → 客户端：

```ts
{ type: "res", id: string, ok: boolean, payload?: unknown, error?: ErrorShape }
```

`id` 回填请求的 `id`；`ok` 区分成功失败；失败时 `error` 是 `ErrorShapeSchema`（`src/gateway/protocol/schema/frames.ts:127-136`），含 `code`、`message`、可选的 `retryable`/`retryAfterMs`——§4.3 关卡2、3 返回的就是这种带重试提示的错误。

**事件帧 `event`**（`src/gateway/protocol/schema/frames.ts:159-168`）—— Gateway → 客户端（无需请求）：

```ts
{ type: "event", event: string, payload?: unknown,
  seq?: number, stateVersion?: StateVersion }
```

§4.1 的 `connect.challenge`、§6 `server-chat` 广播的流式 token、presence 变更等都是事件帧。`seq` 是事件序号（用于检测丢帧）；`stateVersion` 携带 presence/health 版本号，让客户端能判断本地状态是否陈旧。

### 7.3 握手帧：`connect` 与 `hello-ok`

握手不走普通帧，有专门的 schema。

`ConnectParamsSchema`（`src/gateway/protocol/schema/frames.ts:20-71`）是 `connect` 请求的 `params`，字段相当丰富：`minProtocol`/`maxProtocol`（版本协商）、`client`（id、版本、平台、`mode`、可选 `instanceId`）、`caps`（客户端能力）、`commands`、`permissions`、`role`、`scopes`、`device`（设备公钥 + 对 §4.1 nonce 的签名 + nonce）、`auth`（token / bootstrapToken / deviceToken / password / approvalRuntimeToken 多种凭证）。这些字段共同完成「你是谁、你能做什么、你怎么证明」。

`HelloOkSchema`（`src/gateway/protocol/schema/frames.ts:73-126`）是握手成功后 Gateway 的回应：

```ts
{ type: "hello-ok", protocol: number,
  server: { version, connId },
  features: { methods: string[], events: string[] },   // 能力公布
  snapshot: Snapshot,                                   // 初始状态快照
  auth: { role, scopes, deviceToken?, ... },            // 协商出的权限
  policy: { maxPayload, maxBufferedBytes, tickIntervalMs } }
```

几个字段的设计意图：

- **`features.methods` / `features.events`** —— Gateway 把「我支持哪些方法、哪些事件」直接告诉客户端。这就是 §3.1 `advertise` 字段的去向：`advertise: false` 的方法不进这个列表。客户端据此做能力发现，无需硬编码。
- **`snapshot`** —— 握手即附带一份初始状态快照，客户端连上就有完整状态，不必再单独拉取。
- **`auth.scopes`** —— Gateway 协商出的最终 scope。后续每个 RPC 请求的 §4.3 关卡1 鉴权，比对的就是这里的 scope。
- **`policy`** —— Gateway 把自己的限制（最大帧、最大缓冲、tick 间隔）告诉客户端，让客户端自我约束。

`protocol/` 目录下还有大量按领域拆分的 schema（`protocol/schema.ts:1-24` re-export 了 agent、channels、cron、sessions、nodes、plugins、wizard 等二十多个 schema 文件）——每个 RPC 方法的 `params` 和 `payload` 都有对应的 TypeBox schema。校验在帧入口由 Ajv 完成（`src/gateway/server/ws-connection/message-handler.ts:1614` 的 `validateRequestFrame`）：**不合法的帧在到达任何 handler 之前就被拒绝**。这是控制平面的第一道输入防线。

---

## 8. 本章小结

把本章串起来，一个客户端与 Gateway 交互的完整图景是：

```
启动：startGatewayServer → 十二阶段 → http.bound → ready

连接：TCP 握手 → connect.challenge(nonce)
      → 客户端发 req{method:"connect", ConnectParams}
      → 版本协商 + auth + scope → hello-ok(features/auth/policy)

请求：客户端发 req{method, params}
      → Ajv 校验帧
      → handleGatewayRequest 五道关卡
        (scope / 启动期可用 / 写限流 / 方法解析 / 请求作用域)
      → method registry.getHandler → handler 执行
      → res{ok, payload|error}

事件：agent 产生事件
      → server-chat: createAgentEventHandler 翻译 + 节流
      → 按 sessionKey 查三个订阅注册表
      → broadcast / broadcastToConnIds / nodeSendToSession
      → event 帧推给该收到的客户端

关闭：close() → stop sidecars → gateway_stop hook
      → close prelude → drain sessions → 释放全部句柄
```

Gateway 控制平面的核心设计思想可以归纳为四点：

1. **声明式的方法注册表**：方法名、scope、启动期可用性、写限流、是否公布——全部用描述符数据声明，注册表强制「名唯一、必有 scope」，可随插件热重载整体替换。
2. **分阶段、可回滚的启动**：十二个 trace 阶段，先挂处理器再开端口，启动失败自动回滚资源。
3. **每连接一份隔离状态 + 严格的输入防线**：每个 WS 连接独立的闭包状态、握手超时、未授权洪泛防护；每个帧先过 Ajv 校验，每个请求过五道关卡。
4. **内存注册表 + 节流的事件分发**：`server-chat-state` 的注册表都是纯内存、带 TTL 自清理；`server-chat` 在 agent 世界和 Gateway 世界之间做双向翻译，并用节流防止流式输出淹没下游。

下一章将进入第①层与第③层的交界——入站消息管线（`auto-reply/`）：一条 IM 消息到达渠道插件后，如何被去重、路由、节流，最终触发一次 agent run。本章 §6 `server-chat` 负责把 agent 的输出送回去，第 03 章则讲清楚输入是怎么进来的。
