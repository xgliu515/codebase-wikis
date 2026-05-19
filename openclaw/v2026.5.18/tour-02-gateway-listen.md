# Tour 02：Gateway server 启动监听

## 1. 当前情境

上一步结束时，命令路由已锁定 gateway 路径。Commander 的 `.action` 回调被触发，里面 `await import('./run.js')` 拿到了 `runGatewayCommand`，并把解析好的选项（`--port`、`--bind`、`--auth` 等）传了进去。

我们手上现在有：一个活着的 Node 进程、一份解析过的命令行选项。还**没有**：HTTP 监听器、WebSocket 服务、任何能接收连接的东西。这一步要把这些都造出来。

## 2. 问题

`runGatewayCommand` 要把一个空进程变成一个「就绪、等待连接」的网关。问题是：

> 一个网关启动时需要拼装一大堆相互依赖的子系统——网络监听、鉴权配置、RPC 方法注册表、插件、TLS……如何把它们按正确顺序装起来，既不阻塞太久，又保证「开始接受连接」时一切都已就位？

## 3. 朴素思路

写一个长长的 `startGatewayServer` 函数，从上到下顺序做：建 HTTP server、建 WebSocket server、读配置、配鉴权、把所有 RPC 方法 handler 塞进一个大对象、加载所有插件、然后 `server.listen()`。一条直线，谁先谁后看着办。

## 4. 为什么朴素思路会崩

这个朴素思路在 OpenClaw 这个体量的系统里会以几种具体方式崩掉：

- **端口冲突时报错不可读**。OpenClaw 默认监听 `18789`。如果用户已经有一个 gateway 在跑，朴素的 `server.listen()` 会抛一个 `EADDRINUSE`，堆栈里全是 Node 内部网络代码。用户看不出「哦是另一个实例占着端口」，更不知道可以用 `--force` 杀掉它。
- **启动顺序错位导致接收到一半成型的请求**。如果 `server.listen()` 排在「插件加载完成」之前，那么在插件还没注册完 RPC 方法时，一个抢跑的客户端连进来调一个插件方法，会得到「方法不存在」——一个本不该发生的假错误。监听必须是**最后**一步。
- **全量同步加载拖垮启动**。把所有插件、所有方法 handler、TLS 运行时在一条直线里同步装完，启动要好几秒。而其中很多东西（比如某些插件的 cron 服务）在「第一个连接到来」之前根本用不到。
- **方法注册表是个扁平大对象，无法表达权限**。朴素思路把 handler 塞进一个 `Record<string, handler>`。但 `chat.send` 需要 `operator.write` 权限、`chat.history` 只需 `operator.read`、有些方法在启动未完成时不可用。一个裸对象承载不了这些元信息。

核心矛盾：网关的子系统之间有真实的依赖顺序和权限语义，「一条直线顺序装」既无法保证正确性，也无法保证启动速度。

## 3+. 朴素思路的代价具象化

设想用户在已有 gateway 运行时，再敲一次 `openclaw gateway`。朴素版本：进程跑了两秒，加载完所有插件，最后一步 `listen()` 抛 `EADDRINUSE`，前两秒全白费，错误信息还看不懂。这就是「监听该早做还是晚做」之外的另一面——它也该被尽早探测。

## 5. OpenClaw 的做法

`runGatewayCommand` 解析完选项后，`await import` 拿到 `startGatewayServer` 并调用它。注意 `startGatewayServer` 本身也是分层懒加载的：`server.ts` 里的同名导出只是个薄包装，真正的实现 `import('./server.impl.js')` 是按需加载的——又一次「只为要跑的东西付加载成本」。

`server.impl.ts` 里真正的 `startGatewayServer` 不是一条直线，而是一连串带 `startupTrace.measure(...)` 包裹的**阶段**，每个阶段有名字、可计时。骨架是：

1. **配置快照**。`loadGatewayStartupConfigSnapshot` 读出配置，`prepareGatewayStartupConfig` 把鉴权配置（token/password/模式）准备好。鉴权在这里就定好了，远早于第一个连接。
2. **网络监听器**。建 HTTP server，并在其上挂 WebSocket server（`wss`）。监听用 `listenGatewayHttpServer` 完成——它把 `EADDRINUSE` 翻译成人话「另一个 gateway 实例已经在 `ws://host:port` 上监听」，正是为了堵上朴素思路那个不可读的错误。
3. **方法注册表**。这是关键设计。OpenClaw 不用扁平对象，而是用 `createGatewayMethodRegistry` 构建一个**方法注册表**：每个方法是一个 descriptor，带 `name`、`handler`、`scope`（权限范围）、`startup`（启动期是否可用）等元信息。注册表由三部分合并而成——核心方法描述符、插件方法描述符、以及额外 handler。`chat.send` 就是核心描述符之一，带着 `operator.write` 的 scope。这个注册表后面（tour-05）会被用来按名字查 handler 并校验权限。
4. **插件加载**。插件被加载、它们贡献的 channel/HTTP 路由/gateway 方法被注册进上面的注册表。
5. **挂上 WS 处理器**。最后 `attachGatewayWsHandlers` 把连接处理逻辑挂到 `wss` 上，并把方法注册表、鉴权、限流器等都传进去。

**顺序的意义**：监听 socket 虽然在第 2 步就建立，但真正能处理业务请求的连接处理器是在第 5 步、插件全部就位之后才挂上的——`attachGatewayWsHandlers` 还带了一个 `isStartupPending` 回调，让早期连接能被告知「启动还没完成」。这就是朴素思路「抢跑请求拿到假错误」问题的答案。

走完这一步，gateway 在监听 `18789`，方法注册表已建好，插件已加载，但还没有任何客户端连进来。它在等。

## 6. 代码位置

- `src/cli/gateway-cli/run-command.ts:56` — `.action` 回调，懒加载 `./run.js`。
- `src/cli/gateway-cli/run.ts:466` — `runGatewayCommand`，gateway 命令的实现入口。
- `src/cli/gateway-cli/run.ts:508` — 懒加载 `startGatewayServer`。
- `src/cli/gateway-cli/run.ts:808` — 实际调用 `startGatewayServer(port, {...})`。
- `src/gateway/server.ts:24` — `startGatewayServer` 薄包装，按需 `import('./server.impl.js')`。
- `src/gateway/server.impl.ts:532` — 真正的 `startGatewayServer`，分阶段启动主函数。
- `src/gateway/server.impl.ts:570` — `config.snapshot` 阶段，加载配置快照。
- `src/gateway/server.impl.ts:607` — `config.auth` 阶段，`prepareGatewayStartupConfig` 准备鉴权。
- `src/gateway/server/http-listen.ts:18` — `listenGatewayHttpServer`，把 `EADDRINUSE` 翻成可读错误。
- `src/gateway/server/http-listen.ts:51` — 「another gateway instance is already listening」错误文案。
- `src/gateway/methods/registry.ts:51` — `createGatewayMethodRegistry`，构建带 scope 元信息的方法注册表。
- `src/gateway/server.impl.ts:1141` — `buildAttachedGatewayMethodRegistry`，合并核心/插件/额外方法描述符。
- `src/gateway/methods/core-descriptors.ts:190` — `chat.send` 核心方法描述符，`scope: "operator.write"`。
- `src/gateway/server.impl.ts:1423` — 懒加载并调用 `attachGatewayWsHandlers`。
- `src/gateway/server.impl.ts:1427` — `attachGatewayWsHandlers(...)`，把连接处理器挂上 `wss`，传入方法注册表、鉴权、`isStartupPending`。

## 7. 分支与延伸

我们这条 trace 走的是「干净启动、loopback 绑定、监听成功」。这一步上的岔路：

- **`--force`**：端口被占时，先杀掉旧监听者再启动。
- **TLS / Tailscale**：`--tailscale serve|funnel` 会把 gateway 暴露到 tailnet，`gatewayTls` 会改变监听 scheme。
- **`--bind lan|tailnet`**：改变绑定地址，触发不同的鉴权强制策略。
- **配置热重载**：gateway 运行期间配置文件变化会触发 `registerConfigWriteListener` 路径，重新加载部分子系统。
- **cron / 后台维护**：插件的定时服务、媒体清理等是「post-ready」延迟启动的。

想完整理解 gateway 控制面的结构——方法注册表、scope 权限模型、启动阶段编排，去读 [第 2 章](02-gateway-control-plane.md)。想理解插件如何贡献 channel、HTTP 路由和 gateway 方法，去读 [第 10 章](10-plugin-system.md)。

## 8. 走完这一步你脑子里应该多了什么

- `startGatewayServer` 不是一条直线，而是一串**带名字、可计时的启动阶段**（`startupTrace.measure`），子系统按真实依赖顺序拼装。
- 监听 socket 早建立，但**业务连接处理器最后才挂**——`attachGatewayWsHandlers` 配合 `isStartupPending`，保证插件全部就位前不会有请求拿到假错误。
- OpenClaw 的 RPC 方法不是扁平对象，而是一个**方法注册表**：每个方法带 `scope`（权限）和 `startup`（启动期可用性）等元信息。`chat.send` 的 scope 是 `operator.write`。
- 端口冲突被翻译成人话错误（`another gateway instance is already listening...`），而不是裸的 `EADDRINUSE`。
- 这一步结束时，gateway 在 `18789` 上监听、注册表和插件就位，但没有任何连接——下一步浏览器会连上来。
