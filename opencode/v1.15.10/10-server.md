# 第 10 章　服务器模式与 HTTP API

> 代码版本锁定：`anomalyco/opencode@d74d166ac`（tag `v1.15.10`，2026-05-23）。本章所有 `file:line` 引用均基于该提交。

## 10.1 本章解决的问题

第 09 章末尾留了个伏笔：TUI 进程其实不直接跑 session 逻辑，它通过 fetch 或 SSE 跟一个 server 通信。这个 server 又是个什么东西？

事实是：**opencode 内部就是 client-server 架构。** 用户日常使用的所有形态——TUI、`opencode run`、桌面 app、网页 share viewer、IDE 插件、`@opencode-ai/sdk`——都是同一个 HTTP server 的客户端。把核心能力暴露成 HTTP，opencode 才能：

1. 让 TUI 和 logic 进程隔离（第 09 章）。
2. 让 `opencode serve` 起一个裸 server，远端 IDE / 浏览器 / 手机 / Docker 容器都连进来。
3. 用同一份 schema 自动生成 SDK（`@opencode-ai/sdk` 是 codegen 的产物）。
4. 用 SSE 让所有 client 实时拿 bus 事件，而无需自己实现一遍订阅协议。

本章拆开这个 server 的设计：Effect HttpApi 框架、路由分组、SSE 事件流、auth、CORS、mDNS、workspace 路由、projector 一致性、headless 模式。

整体结构：

<svg viewBox="0 0 760 600" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="opencode server overall architecture: clients, listener, router tree, middleware chain, effect layers">
  <defs>
    <marker id="ar101" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="40" y="16" width="320" height="86" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
  <text x="200" y="36" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">TUI 进程</text>
  <text x="200" y="54" text-anchor="middle" font-size="11" fill="#64748b">in-process fetch handler</text>
  <text x="200" y="70" text-anchor="middle" font-size="10" fill="#64748b">request → app.fetch(req) → response</text>
  <text x="200" y="88" text-anchor="middle" font-size="10" fill="#64748b">零 socket 开销</text>
  <rect x="400" y="16" width="320" height="86" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.4"/>
  <text x="560" y="36" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">外部客户端</text>
  <text x="560" y="54" text-anchor="middle" font-size="10.5" fill="#64748b">• opencode-web ｜ • desktop</text>
  <text x="560" y="70" text-anchor="middle" font-size="10.5" fill="#64748b">• IDE plugin ｜ • SDK consumers</text>
  <text x="560" y="88" text-anchor="middle" font-size="10" fill="#64748b">走 HTTP / WS</text>
  <path d="M200,102 L200,138" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar101)"/>
  <path d="M560,102 L560,138" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar101)"/>
  <rect x="40" y="140" width="680" height="60" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="162" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">server.ts ｜ Hono/Effect HttpApi listener</text>
  <text x="380" y="180" text-anchor="middle" font-size="11" fill="#64748b">127.0.0.1:4096（默认，端口冲突顺延）</text>
  <text x="380" y="194" text-anchor="middle" font-size="10" fill="#64748b">NodeHttpServer 底层</text>
  <path d="M380,200 L380,224" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar101)"/>
  <rect x="40" y="226" width="680" height="118" rx="8" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="60" y="246" font-size="12" font-weight="700" fill="currentColor">Router 树</text>
  <rect x="60" y="254" width="660" height="22" rx="4" fill="#fed7aa" stroke="#ea580c"/>
  <text x="74" y="270" font-size="11" fill="currentColor">rootApiRoutes ｜ /global/*, /auth/:providerID, /log</text>
  <rect x="60" y="278" width="660" height="22" rx="4" fill="#99f6e4" stroke="#0d9488"/>
  <text x="74" y="294" font-size="11" fill="currentColor">eventApiRoutes ｜ /event (SSE) — 与 bus 实时桥接</text>
  <rect x="60" y="302" width="660" height="22" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="74" y="318" font-size="11" fill="currentColor">instanceApiRoutes ｜ /session/* /file/* /project/* /mcp/* /tui/* ...</text>
  <rect x="60" y="326" width="660" height="14" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="74" y="337" font-size="10" fill="#64748b">+ docRoute（/doc, OpenAPI）  + uiRoute（/*, Web UI 静态资源 / 代理）</text>
  <path d="M380,344 L380,368" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar101)"/>
  <rect x="40" y="370" width="680" height="120" rx="8" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="60" y="390" font-size="12" font-weight="700" fill="currentColor">Middleware 链（按顺序）</text>
  <rect x="60" y="398" width="160" height="22" rx="4" fill="#fed7aa" stroke="#ea580c"/>
  <text x="140" y="414" text-anchor="middle" font-size="10.5" fill="currentColor">authorization</text>
  <rect x="226" y="398" width="160" height="22" rx="4" fill="#fed7aa" stroke="#ea580c"/>
  <text x="306" y="414" text-anchor="middle" font-size="10.5" fill="currentColor">workspace-routing</text>
  <rect x="392" y="398" width="160" height="22" rx="4" fill="#fed7aa" stroke="#ea580c"/>
  <text x="472" y="414" text-anchor="middle" font-size="10.5" fill="currentColor">instance-context</text>
  <rect x="558" y="398" width="162" height="22" rx="4" fill="#fff" stroke="#94a3b8"/>
  <text x="639" y="414" text-anchor="middle" font-size="10.5" fill="currentColor">cors / compression</text>
  <rect x="60" y="424" width="220" height="22" rx="4" fill="#fff" stroke="#94a3b8"/>
  <text x="170" y="440" text-anchor="middle" font-size="10.5" fill="currentColor">fence / error / schema-error</text>
  <text x="60" y="464" font-size="10" fill="#64748b">前 3 个橙色为业务关键：先鉴权、再按 directory 路由、再 provide InstanceContext</text>
  <text x="60" y="480" font-size="10" fill="#64748b">后段是通用 HTTP 处理（CORS、压缩、错误映射）</text>
  <path d="M380,490 L380,514" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar101)"/>
  <rect x="40" y="516" width="680" height="68" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.4"/>
  <text x="380" y="538" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Effect Layer 依赖图</text>
  <text x="380" y="556" text-anchor="middle" font-size="11" fill="#64748b">Session · Tool · Provider · MCP · LSP · Permission · Bus · InstanceStore ...</text>
  <text x="380" y="572" text-anchor="middle" font-size="10" fill="#64748b">所有服务以 Layer 注入；handler 拿 Service 一气呵成</text>
</svg>
<span class="figure-caption">图 R10.1 ｜ 从 TUI / 外部客户端到 listener、router 树、middleware 链、Effect Layer 的完整请求路径分层。</span>

<details>
<summary>ASCII 原版</summary>

```
                      ┌────────── HTTP / WS ──────────┐
                      │                                │
              ┌───────┴────────┐               ┌───────┴────────┐
              │  TUI 进程       │               │ 外部客户端       │
              │  in-process     │               │ • opencode-web │
              │  fetch handler  │               │ • desktop      │
              └───────┬────────┘               │ • IDE plugin   │
                      │                         │ • SDK consumers │
                      ▼                         └───────┬────────┘
              Worker (Effect runtime)                   │
              ┌─────────────────────────────────────────┘
              ▼
   ┌───────────── server.ts ──────────────┐
   │  Hono/Effect HttpApi listener         │
   │  127.0.0.1:4096 (默认；冲突顺延)       │
   └──────────────┬───────────────────────┘
                  │
   ┌──────────────┴───────────────────────┐
   │ Router 树                             │
   │  • rootApiRoutes     /global, /auth   │
   │  • eventApiRoutes    /event (SSE)     │
   │  • instanceApiRoutes /session, ...    │
   │  • docRoute          /doc (OpenAPI)   │
   │  • uiRoute           /*  (Web UI)     │
   └───────────────────────────────────────┘
                  │
   ┌──────────────┴───────────────────────┐
   │ Middleware 链                         │
   │  authorization, instance-context,     │
   │  workspace-routing, cors, compression,│
   │  fence, error, schema-error           │
   └──────────────┬───────────────────────┘
                  │
   ┌──────────────┴───────────────────────┐
   │ Effect Layer 依赖：Session, Tool,     │
   │ Provider, MCP, LSP, Permission, ...   │
   └───────────────────────────────────────┘
```

</details>

---

## 10.2 为什么 Effect + HttpApi 而不是裸 Hono

`packages/opencode/src/server/server.ts` 第一眼让人困惑——它没有 `app.get(...)` 也没有 `app.post(...)`，全是 `Effect.gen`、`Layer.mergeAll`、`HttpApiBuilder.layer`。

opencode 选的不是裸 Hono，而是 **effect-smol 框架内的 `HttpApi` 系统**（基于 `effect/unstable/http` 和 `effect/unstable/httpapi`）。底层运行时是 `@effect/platform-node` 的 `NodeHttpServer`，里头封装了 node `createServer()`。这种选择带来几个明显好处：

1. **schema 驱动**：每个 endpoint 用 `Schema.Struct({...})` 声明 params/query/payload/success/error，自动生成 OpenAPI spec（见 `/doc` 路由）、自动生成 SDK 类型、自动做请求校验。
2. **Effect 错误模型**：endpoint 失败抛 typed error（`PermissionNotFoundError` / `SessionBusyError` / ...），中间件统一映射到 HTTP status code。
3. **Layer 依赖注入**：Session/Permission/Provider/LSP/MCP 这些服务全部以 Layer 形式注入，测试时 mock 一个 Layer 就行。
4. **路由组合**：`RootHttpApi` / `InstanceHttpApi` / `EventApi` / `PtyConnectApi` 通过 `HttpApi.make(...).addHttpApi(...)` 拼起来，每组可独立加 middleware。

代价是阅读门槛比 Hono 高很多。不过模式一致：每个 endpoint 都在 `groups/<name>.ts` 声明 schema，在 `handlers/<name>.ts` 实现 handler。

---

## 10.3 server 启动

`packages/opencode/src/server/server.ts` 入口函数 `listen(opts)`（75-83 行）：

```ts
export async function listen(opts: ListenOptions): Promise<Listener> {
  const listener = await Effect.runPromise(listenEffect(opts))
  return {
    hostname: listener.hostname,
    port: listener.port,
    url: listener.url,
    stop: (close?: boolean) => Effect.runPromiseExit(listener.stop(close)).then(() => undefined),
  }
}
```

实际效果：在 `opts.hostname:opts.port` 上起 HTTP 服务，返回一个能优雅 stop 的 `Listener`。

### 10.3.1 端口回退

```ts
// server.ts:120-125
function startWithPortFallback(opts: ListenOptions) {
  if (opts.port !== 0) return startListener(opts, opts.port)
  return startListener(opts, 4096).pipe(Effect.catch(() => startListener(opts, 0)))
}
```

调用者传 `port: 0` 时，先尝试 4096（opencode 历来的默认端口），失败再让系统分配任意空闲端口。给定端口不会回退——明确指定 5000 就在 5000 跑。

### 10.3.2 in-process Default()

除了真起 socket 的 `listen(...)`，还有一个 `Default()`（58-67 行）：

```ts
export const Default = lazy(() => {
  const handler = HttpApiApp.webHandler().handler
  const app: ServerApp = {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input, init) { ... },
  }
  return { app }
})
```

它不绑端口，只提供一个 `app.fetch(Request) → Response` 的纯函数。第 09 章讲过 worker 内的 `rpc.fetch` 就是直接调它：TUI 进程发出的 fetch 全部走这条路，零 socket 开销。

### 10.3.3 ConfigProvider 隔离

```ts
// server.ts:111-117
Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
```

注释解释得很清楚：`Config.string("OPENCODE_SERVER_PASSWORD")` 这种 env 读取在 Effect 的 default `ConfigProvider` 里只在首次访问时**快照** `process.env`，后续 listener 都看不到新值。手动 install 一个 fresh 的 ConfigProvider 让每个 `listen()` 都读当前 env。这是个真实跑出来的 bug fix。

### 10.3.4 优雅停机

`makeStop`（173-185 行）按顺序：
1. unpublish mDNS（如果开了）。
2. 如果用户要 `close=true`，强制断开所有 HTTP 连接（解决 SSE 长连不松手的问题）。
3. 关闭 Effect Scope，触发所有 finalizer 释放资源。

---

## 10.4 路由结构

`packages/opencode/src/server/routes/instance/httpapi/server.ts:111-153` 把整个路由树拼起来：

```ts
const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, globalHandlers]),
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)
const eventApiRoutes = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers),
  Layer.provide(instanceRouterLayer),
)
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    configHandlers, experimentalHandlers, fileHandlers,
    instanceHandlers, mcpHandlers, projectHandlers,
    ptyHandlers, questionHandlers, permissionHandlers,
    providerHandlers, sessionHandlers, syncHandlers,
    v2Handlers, tuiHandlers, workspaceHandlers,
  ]),
)
```

`RootHttpApi` / `InstanceHttpApi` 来自 `api.ts:30-52`：

```ts
export const RootHttpApi = HttpApi.make("opencode-root")
  .addHttpApi(ControlApi)
  .addHttpApi(GlobalApi)
  .middleware(SchemaErrorMiddleware)
  .middleware(Authorization)

export const InstanceHttpApi = HttpApi.make("opencode-instance")
  .addHttpApi(ConfigApi).addHttpApi(ExperimentalApi).addHttpApi(FileApi)
  .addHttpApi(InstanceApi).addHttpApi(McpApi).addHttpApi(ProjectApi)
  .addHttpApi(PtyApi).addHttpApi(QuestionApi).addHttpApi(PermissionApi)
  .addHttpApi(ProviderApi).addHttpApi(SessionApi).addHttpApi(SyncApi)
  .addHttpApi(V2Api).addHttpApi(TuiApi).addHttpApi(WorkspaceApi)
  .middleware(SchemaErrorMiddleware)
```

### 10.4.1 三类路由

注释（`server.ts:103-107`）讲得很清楚：

| 路由 | 例子 | 鉴权 | workspace 路由 |
| --- | --- | --- | --- |
| Root | `/global/health`, `/global/event`, `/auth/:providerID`, `/log` | 在 `RootHttpApi.middleware(Authorization)` 上声明 | 不需要 |
| Event | `/event` (SSE) | router middleware | 通过 `WorkspaceRoutingQuery` 走 instance ctx |
| Instance | `/session/*`, `/file/*`, `/project/*`, `/mcp/*`, `/tui/*`, ... | 每组 group 上声明 `Authorization` | router middleware |
| Raw | `/pty/connect/:ticket` (WebSocket) | router middleware | router middleware |
| Doc / UI | `/doc`, `/*` 静态资源 | router middleware（允许 public path 跳过） | 不需要 |

### 10.4.2 endpoint 声明示例

打开 `groups/permission.ts:21-40` 看典型形态：

```ts
HttpApiEndpoint.get("list", root, {
  query: WorkspaceRoutingQuery,
  success: described(Schema.Array(Permission.Request), "List of pending permissions"),
}),
HttpApiEndpoint.post("reply", `${root}/:requestID/reply`, {
  params: { requestID: PermissionID },
  query: WorkspaceRoutingQuery,
  payload: ReplyPayload,
  success: described(Schema.Boolean, "Permission processed successfully"),
  error: [HttpApiError.BadRequest, PermissionNotFoundError],
})
```

`Permission.Request`、`PermissionID`、`Permission.Reply` 都是 `@/permission` 里定义的 effect schema。schema 同时决定：

- 客户端发啥能解析、解析失败 400。
- response 是啥、OpenAPI 文档自动生成。
- SDK 那边 `client.permission.reply({ params: { requestID }, body: { reply, message } })` 的类型签名。

handler 在 `handlers/permission.ts`，签名是 typed effect，错误必须是 `HttpApiError.BadRequest` 或 `PermissionNotFoundError`，否则编译报错。

### 10.4.3 endpoint 全景

不一一列举，按 group 看下来：

| Group | 关注的资源 | 主要 endpoint |
| --- | --- | --- |
| `control` | 控制平面 | `/auth/:providerID` (set/remove)、`/log` |
| `global` | 全局 | `/global/health`, `/global/config`, `/global/event` (SSE), `/global/dispose`, `/global/upgrade` |
| `event` | bus 事件流 | `GET /event` (SSE) |
| `session` | session 主体 | list / get / fork / abort / prompt / command / shell / share / init / summarize / revert / unrevert / messages / parts / permissions |
| `project` | 项目元数据 | list/get、当前 directory 解析 |
| `workspace` | worktree / workspace 抽象 | list / create / dispose |
| `provider` | LLM provider | list / models / auth methods |
| `file` | 工作区文件 | read / search / glob / watch |
| `mcp` | MCP server 控制 | list / enable / disable / resources |
| `permission` | 权限请求 | list / reply |
| `question` | QuestionTool 请求 | list / reply |
| `pty` | 子终端 | open / list / kill, WebSocket connect |
| `tui` | 给外部触发 TUI 动作 | publish / appendPrompt / executeCommand |
| `config` | opencode config | get / get-schema |
| `experimental` | 不稳定 API | snapshot / share v2 / ... |
| `sync` | workspace 同步事件 | start / event |
| `v2` | 新版 schema 端点 | message v2 / part v2 |
| `instance` | 当前 instance 元信息 | info / dispose |

打开 `groups/session.ts:74-110` 可以看到所有 session path：

```ts
export const SessionPaths = {
  list: "/session",
  status: "/session/status",
  get: "/session/:sessionID",
  children: "/session/:sessionID/children",
  todo: "/session/:sessionID/todo",
  diff: "/session/:sessionID/diff",
  messages: "/session/:sessionID/message",
  message: "/session/:sessionID/message/:messageID",
  create: "/session",
  remove: "/session/:sessionID",
  fork: "/session/:sessionID/fork",
  abort: "/session/:sessionID/abort",
  share: "/session/:sessionID/share",
  init: "/session/:sessionID/init",
  summarize: "/session/:sessionID/summarize",
  prompt: "/session/:sessionID/message",     // POST
  promptAsync: "/session/:sessionID/prompt_async",
  command: "/session/:sessionID/command",
  shell: "/session/:sessionID/shell",
  revert: "/session/:sessionID/revert",
  unrevert: "/session/:sessionID/unrevert",
  permissions: "/session/:sessionID/permissions/:permissionID",
  ...
}
```

---

## 10.5 SSE：实时事件流

整个 client-server 体系能存活的关键是 **bus 事件实时推送**。每个 client 启动后做的第一件事就是订阅 `/event`：

### 10.5.1 endpoint 声明

`packages/opencode/src/server/routes/instance/httpapi/groups/event.ts`（25 行）：

```ts
export const EventApi = HttpApi.make("event").add(
  HttpApiGroup.make("event").add(
    HttpApiEndpoint.get("subscribe", EventPaths.event, {
      query: WorkspaceRoutingQuery,
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
    })
  )
)
```

`contentType: "text/event-stream"` 是 SSE 协议的关键 header。

### 10.5.2 handler：bus → SSE

`handlers/event.ts:21-54` 的核心：

```ts
function eventResponse(bus: Bus.Interface) {
  return Effect.gen(function* () {
    const events = (yield* bus.subscribeAll()).pipe(
      Stream.takeUntil((event) => event.type === Bus.InstanceDisposed.type),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ id: Bus.createID(), type: "server.heartbeat", properties: {} })),
    )

    return HttpServerResponse.stream(
      Stream.make({ id: Bus.createID(), type: "server.connected", properties: {} }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.sync(() => log.info("event disconnected"))),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}
```

拆解：

1. **`bus.subscribeAll()`**：bus（见第 03 章）是个内存事件总线，订阅它就拿到一个 `Stream<BusEvent>`。
2. **`takeUntil(InstanceDisposed)`**：instance dispose 时 SSE 主动关。
3. **server.connected**：流头部插一个 hello 事件，让 client 知道订阅成功。
4. **heartbeat**：每 10 秒发个心跳，防止中间代理（nginx / cloudflare）超时断 keep-alive。
5. **`Sse.encode()`**：把 `{ id, event, data }` 编码成 `id: ...\nevent: ...\ndata: ...\n\n` 这样的 SSE wire format。
6. **`Stream.ensuring(log)`**：finalizer，断开时打日志。

注释（25-27 行）特别说明了订阅时机：

> Subscribe eagerly: the bus subscription is acquired in the request scope at this yield, so any publish from now on is queued for the body-pump fiber to drain — closing the race where Stream.concat(server.connected, lazy-subscribe) used to drop publishes in the prefix-consume window.

也就是早期版本是先 emit hello、再订阅，那个窗口里发生的 bus event 会丢；新版本同步 subscribe 后再 emit hello，bus queue 已经在收。

### 10.5.3 客户端消费

SDK `client.global.event()` 返回的 `events.stream` 在 `context/sdk.tsx` 里被 `for await ... of` 消费（第 09 章 §9.5）。

`X-Accel-Buffering: no` 提示 nginx 别缓冲（SSE 必须立即下发）。`X-Content-Type-Options: nosniff` 是基础安全 header。

### 10.5.4 `event.ts`：bus 事件定义

`packages/opencode/src/server/event.ts`（7 行）只是声明了两个 server 自己的 bus 事件：

```ts
export const Event = {
  Connected: BusEvent.define("server.connected", Schema.Struct({})),
  Disposed: BusEvent.define("global.disposed", Schema.Struct({})),
}
```

`server.connected` 不在 bus 里 publish——它是 SSE handler 自造的合成事件。`global.disposed` 由 `global-lifecycle.ts` 的 `emitGlobalDisposed` 在所有 instance dispose 完后 emit，让 client 知道整个 server 要退出了。

---

## 10.6 Projector：CQRS 风的读模型

`packages/opencode/src/server/init-projectors.ts`（3 行）：

```ts
import { initProjectors } from "./projectors"
initProjectors()
```

`server.ts:1` 顶部 `import "./init-projectors"`——server 模块加载就触发 projector 初始化。

`packages/opencode/src/server/projectors.ts`（26 行）：

```ts
import sessionProjectors from "../session/projectors"
import { SyncEvent } from "@/sync"
import { Session } from "@/session/session"
import { SessionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"

export function initProjectors() {
  SyncEvent.init({
    projectors: sessionProjectors,
    convertEvent: (type, data) => {
      if (type === "session.updated") {
        const id = (data as SyncEvent.Event<typeof Session.Event.Updated>["data"]).sessionID
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
        if (!row) return data
        return {
          sessionID: id,
          info: Session.fromRow(row),
        }
      }
      return data
    },
  })
}
```

### 10.6.1 这是什么

opencode 的 storage 用的是 **event sourcing + projection** 模式（详见第 03 章）：

1. 任何状态变化都先以 `SyncEvent`（带版本的、序列化好的事件）写进事件日志。
2. **projector** 函数订阅事件，把它"投影"成 sqlite 表里可查的行——`session`、`message`、`part`、`todo`...
3. 读路径直接从 sql 查；写路径只 emit event。这是经典 CQRS。

`SyncEvent.init({...})` 在 `@/sync` 模块全局注册一组 projector。`sessionProjectors` 来自 `session/projectors.ts`，里头处理 `session.created` / `session.updated` / `message.added` / `part.updated` 等事件，把数据写进 drizzle 表。

### 10.6.2 `convertEvent` 干嘛

某些事件的"被 bus 推给 client 的 payload"和"projector 处理时的 payload"形状不同。`session.updated` 是个典型例子：

- bus 上发出来的事件只带 `{ sessionID, partial }`（避免每个小改动都序列化整个 session）。
- 但 client 期望收到完整的 `Session.Info`（不然就得每次自己拼出来）。

`convertEvent` 的作用：projector 处理完后，server 在通过 SSE 推出去**之前**，把事件 payload 转成"完整 session info"形态。这里它直接查 sql 拿当前最新行 `Session.fromRow(row)`，塞回去给 client。

### 10.6.3 为什么 server.ts 顶部就 import

```ts
// server.ts:1
import "./init-projectors"
```

这是**进程级初始化**：projector 只能注册一次（全局 map），而 server 模块是所有可能进入路径里最早被加载的。放在 module top-level 保证不会重复也不会遗漏。

---

## 10.7 Auth 中间件

`packages/opencode/src/server/auth.ts` 处理的是**HTTP API 自身的鉴权**，**和 LLM provider 的 auth 完全无关**（后者在 `@/provider/auth`）。

### 10.7.1 配置

```ts
// auth.ts:17-20
export class Config extends ConfigService.Service<Config>()("@opencode/ServerAuthConfig", {
  password: EffectConfig.string("OPENCODE_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.string("OPENCODE_SERVER_USERNAME").pipe(EffectConfig.withDefault("opencode")),
}) {}
```

读 env：
- `OPENCODE_SERVER_PASSWORD`：可选；没设就是 open server（仅本地默认场景）。
- `OPENCODE_SERVER_USERNAME`：默认 `opencode`。

### 10.7.2 触发条件

```ts
// auth.ts:24-26
export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}
```

只有 password 显式设了才启用鉴权。这是为了"本地 dev 默认不鉴权、`opencode serve` 暴露公网时必须设密码"的实用主义。

### 10.7.3 协议

Basic Auth（`auth.ts:36-42`）：

```ts
export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = credentials?.username ?? Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}
```

服务器端 `middleware/authorization.ts:70-80` 解码：

```ts
function credentialFromURL(url: URL, request: HttpServerRequest.HttpServerRequest) {
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)         // ?auth_token=<base64>
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}
```

支持两种位置：标准 `Authorization: Basic ...` header，或者 `?auth_token=` query 参数（给浏览器 EventSource 用——它没法发自定义 header）。

### 10.7.4 失败响应

```ts
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'
```

返回 401 + `www-authenticate: Basic realm="Secure Area"`，浏览器看到这个就弹原生登录框。

### 10.7.5 public 跳过

```ts
// authorization.ts:107-108
if (isPublicUIPath(request.method, url.pathname)) return yield* effect
if (hasPtyConnectTicketURL(url)) return yield* effect
```

两个例外：
- public UI 静态资源不要求 auth（`/share/...`、`/_next/...` 之类）。
- pty WebSocket 连接走 ticket（`packages/opencode/src/server/shared/pty-ticket.ts`），主请求拿短 ticket，连 WS 时传 ticket 而不是密码。

### 10.7.6 两个 layer

- `authorizationLayer` 给 `HttpApi` 用，错误是 `HttpApiError.UnauthorizedNoContent`（避免被覆盖成 `NotFound`，见注释 13-15 行）。
- `authorizationRouterMiddleware` 给 raw router 用（pty connect、`/*` UI），错误响应直接返回 raw response。
- `v2AuthorizationLayer` 是 v2 schema 端点的鉴权，错误类型不同（`UnauthorizedError` 带 message）。

---

## 10.8 CORS

`packages/opencode/src/server/cors.ts`（34 行）：

```ts
const opencodeOrigin = /^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/

export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (input.startsWith("http://localhost:")) return true
  if (input.startsWith("http://127.0.0.1:")) return true
  if (input.startsWith("oc://renderer")) return true
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  if (opencodeOrigin.test(input)) return true
  return opts?.cors?.includes(input) ?? false
}
```

允许白名单：

- 任意 localhost / 127.0.0.1 端口（dev 场景）。
- `oc://renderer`（Electron 渲染进程的 custom protocol）。
- Tauri 三种 localhost（Tauri 是 desktop app 的桌面框架）。
- `*.opencode.ai`（产品域名）。
- 用户在 CLI 传 `--cors=https://my.tool` 显式追加。

server.ts:94-101 把它包成 Hono middleware：

```ts
HttpMiddleware.cors({
  allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
  maxAge: 86_400,
})
```

`maxAge: 86400` 把 preflight 缓存 24 小时。

---

## 10.9 mDNS：局域网发现

`packages/opencode/src/server/mdns.ts`（60 行）封装 `bonjour-service`。

### 10.9.1 publish

```ts
// mdns.ts:9-44
export function publish(port: number, domain?: string) {
  if (currentPort === port) return
  if (bonjour) unpublish()

  const host = domain ?? "opencode.local"
  const name = `opencode-${port}`
  bonjour = new Bonjour()
  const service = bonjour.publish({ name, type: "http", host, port, txt: { path: "/" } })
  // ...
}
```

服务名 `opencode-4096`，type `_http._tcp.local`。同一台机器开多个 server 会有 `opencode-4096`、`opencode-4097` 区分。

### 10.9.2 触发条件

```ts
// server.ts:158-171
function setupMdns(opts, port, scope) {
  return Effect.gen(function* () {
    const publish =
      opts.mdns && port && opts.hostname !== "127.0.0.1" && opts.hostname !== "localhost" && opts.hostname !== "::1"
    if (publish) {
      yield* Effect.sync(() => MDNS.publish(port, opts.mdnsDomain))
      // ...
    }
    if (opts.mdns) log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
    return Effect.void
  })
}
```

- 必须传 `--mdns`。
- 必须监听非 loopback（不然广播个 `127.0.0.1:4096` 没意义）。
- 否则警告并跳过。

### 10.9.3 使用场景

`opencode serve --hostname 0.0.0.0 --mdns` 后，同一 wifi 的桌面 app 自动列出 "Found 1 server: opencode-4096.local"，一键连接。手机端 app 同理。

---

## 10.10 Workspace 路由（中间件）

`packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts` 是个会让人困惑的中间件——其实它做了**两件**不同的事：

### 10.10.1 把 directory / workspace 从 URL 提取出来

```ts
export const WorkspaceRoutingQueryFields = {
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
}
```

所有 instance-级 endpoint 的 query schema 都 spread 这两个字段。SDK 客户端会把 `x-opencode-directory` header 也转写到 query：

```ts
// packages/sdk/js/src/v2/client.ts:24-44
for (const [name, key] of [
  ["x-opencode-directory", "directory"],
  ["x-opencode-workspace", "workspace"],
] as const) {
  // ... 把 header 复制到 url.searchParams
}
```

为啥要两套？因为 EventSource（SSE 客户端）和 GET 请求只能用 query；非 GET 用 header 更干净。代码在两边都接受。

### 10.10.2 远程 workspace 走 HTTP 代理

`workspace-routing.ts:31-46` 定义 `RequestPlan` 是 ADT，有 `Local` / `Remote` 两种主要形态：

- `Local`：当前 instance 直接处理，把 `WorkspaceRouteContext` provide 进去。
- `Remote`：通过 `HttpApiProxy` 把整个请求**转发**到远端 workspace 的 server。

这是为了 experimental 的"远程 workspace"——用户的代码不在本机，而在某个云端 worktree 上。本机 opencode 起一个 server 但实际不持有代码，请求经 workspace adapter 转发。`packages/opencode/src/server/shared/workspace-routing.ts` 实现这套寻址。

`instance-context.ts` 配合：

```ts
// instance-context.ts:25-35
function provideInstanceContext<E>(effect, store) {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const ctx = yield* store.load({ directory: decode(route.directory) })
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}
```

`InstanceStore.load({ directory })` 按 directory 维度 load/get 一个 `InstanceContext`。同一个 directory 多次请求复用同一个 instance（包括 sqlite 连接、agent、provider 实例）。这就是为啥 server 是无状态前端但可以处理多个并发 project：每个 request 自带 directory，instance store 做 keying。

---

## 10.11 proxy-util

`packages/opencode/src/server/proxy-util.ts`（48 行）是个通用的"反向代理工具集"，主要供两个地方用：

1. **Web UI 代理**：`server/shared/ui.ts` 处理 `/*` 时如果用户没禁 embedded web UI，会把请求转给 opencode.ai 的 web UI upstream（生产环境）或本地 dev server（开发环境）。
2. **Remote workspace 代理**：上面提到的转发到云端 workspace server。

工具函数：

```ts
// proxy-util.ts:1-12
const hop = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host",
])

function sanitize(out: Headers) {
  for (const key of hop) out.delete(key)
  out.delete("accept-encoding")
  out.delete("x-opencode-directory")
  out.delete("x-opencode-workspace")
}
```

转发前剔除 hop-by-hop 头（RFC 7230 要求），还顺手剔掉 opencode 内部 routing header 避免泄露给 upstream。

```ts
// proxy-util.ts:32-39
export function websocketProtocols(input: Request | Record<string, ...>) {
  // 从 sec-websocket-protocol 拆出 token 列表
}
export function websocketTargetURL(url: string | URL) {
  // 把 http:// → ws://, https:// → wss://
}
```

WebSocket 代理（pty connect）用到这两个。

---

## 10.12 global-lifecycle

`packages/opencode/src/server/global-lifecycle.ts`（37 行）处理"server 整体退出"的协调。

```ts
export const emitGlobalDisposed = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Disposed.type,
      properties: {},
    },
  }),
)

export const disposeAllInstancesAndEmitGlobalDisposed = Effect.fn(
  "Server.disposeAllInstancesAndEmitGlobalDisposed",
)(function* (options?) {
  const store = yield* InstanceStore.Service
  yield* Effect.gen(function* () {
    yield* options?.swallowErrors
      ? store.disposeAll().pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.warn("global disposal failed", { cause })),
          ),
        )
      : store.disposeAll()
    yield* emitGlobalDisposed
  }).pipe(Effect.uninterruptible)
})
```

这两个 effect 的调用点：
- 用户 `Ctrl+C` 或发 SIGTERM 触发 worker.ts 的 shutdown RPC。
- worker.ts:82-90 的 `reload` 也调（reload = dispose 所有 instance + 重读 config + 重启）。
- 把 `Disposed` 事件先经 bus 推给所有 SSE client，再真销毁——给前端一个机会清理。

`Effect.uninterruptible` 保证 dispose 流程跑完，不被中途中断。

---

## 10.13 客户端 SDK：`@opencode-ai/sdk`

`packages/sdk/js/` 是从 server 的 OpenAPI spec **自动生成**的 client。生成流程：

1. server 运行时通过 `/doc` 暴露 OpenAPI spec（`server.ts:69-71` 的 `openapi()` 函数）。
2. SDK 仓库的 `script/build.ts` 拉 spec，跑 `@hey-api/openapi-ts` 生成 `src/gen/client.gen.ts` / `types.gen.ts` / `sdk.gen.ts`。
3. 在生成代码外面包 `createOpencodeClient`（`packages/sdk/js/src/v2/client.ts:47`），加上 directory / workspace header 自动注入、`x-opencode-*` → query 重写（10.10.1 提到的）。

最终用户写：

```ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2"

const client = createOpencodeClient({
  baseUrl: "http://localhost:4096",
  directory: "/path/to/project",
})

const sessions = await client.session.list({})
const events = await client.global.event({})
for await (const evt of events.stream) console.log(evt.payload)
```

第 09 章 TUI 就是这个 SDK 最大的用户——它通过 `createOpencodeClient({ baseUrl, fetch, ... })` 创建 client，但传了**自定义 fetch**（in-process worker fetch），所以"看起来在调 HTTP 实际上没出进程"。

### 10.13.1 同一份 schema 跨语言

代码版本里只看到 `packages/sdk/js/`（TypeScript）。但 OpenAPI spec 是中性的——Go / Python / Rust 都能从 `/doc` 拿 spec 自动 codegen。anomalyco 的 IDE 插件（VS Code / Zed）目前用 TypeScript SDK，但其他语言生态有人贡献也能跑起来。

---

## 10.14 Headless：`opencode serve`

`packages/opencode/src/cli/cmd/serve.ts`（23 行）是裸 server 模式：

```ts
export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    yield* Effect.never
  }),
})
```

几个关键点：

1. **`instance: false`**：注释说"Server loads instances per-request via x-opencode-directory header — no need for an ambient project InstanceContext at startup." 即不需要在启动时绑死某个 project；每个请求自带 directory，instance store 现场 load。
2. **password 警告**：开放 server 但没设密码就告警。
3. **`Effect.never`**：永不退出，等待 ctrl+c。

### 10.14.1 典型使用

```bash
# 远端机器（云开发盒子）
$ export OPENCODE_SERVER_PASSWORD=hunter2
$ opencode serve --hostname 0.0.0.0 --port 4096 --mdns
opencode server listening on http://0.0.0.0:4096

# 本地终端
$ opencode --url http://remote-host:4096 --password hunter2
# 或者本地 desktop / web app 直接连
```

也是 docker 部署的主路径：

```dockerfile
ENV OPENCODE_SERVER_PASSWORD=...
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
```

---

## 10.15 一图回顾

<svg viewBox="0 0 760 600" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="opencode serve end-to-end: command, listener, middleware layer, router groups, bus SSE, clients">
  <defs>
    <marker id="ar102" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="160" y="16" width="440" height="38" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="34" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">opencode serve --hostname 0.0.0.0 --port 4096</text>
  <text x="380" y="49" text-anchor="middle" font-size="10" fill="#64748b">CLI 入口</text>
  <path d="M380,54 L380,78" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar102)"/>
  <rect x="160" y="80" width="440" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.4"/>
  <text x="380" y="100" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">server.ts ::listen()</text>
  <text x="380" y="116" text-anchor="middle" font-size="10.5" fill="#64748b">Effect runtime + NodeHttpServer</text>
  <path d="M380,124 L380,148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar102)"/>
  <rect x="40" y="150" width="680" height="118" rx="8" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="60" y="170" font-size="12" font-weight="700" fill="currentColor">Middleware 链（Layer 顺序）</text>
  <rect x="60" y="178" width="155" height="24" rx="4" fill="#fff" stroke="#94a3b8"/>
  <text x="138" y="194" text-anchor="middle" font-size="10.5" fill="currentColor">errorLayer</text>
  <rect x="220" y="178" width="155" height="24" rx="4" fill="#fff" stroke="#94a3b8"/>
  <text x="298" y="194" text-anchor="middle" font-size="10.5" fill="currentColor">compressionLayer</text>
  <rect x="380" y="178" width="155" height="24" rx="4" fill="#fff" stroke="#94a3b8"/>
  <text x="458" y="194" text-anchor="middle" font-size="10.5" fill="currentColor">corsVaryFix</text>
  <rect x="540" y="178" width="160" height="24" rx="4" fill="#fff" stroke="#94a3b8"/>
  <text x="620" y="194" text-anchor="middle" font-size="10.5" fill="currentColor">fenceLayer</text>
  <rect x="60" y="206" width="155" height="24" rx="4" fill="#fed7aa" stroke="#ea580c"/>
  <text x="138" y="222" text-anchor="middle" font-size="10.5" fill="currentColor">cors（白名单）</text>
  <rect x="220" y="206" width="480" height="24" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="460" y="222" text-anchor="middle" font-size="10.5" fill="currentColor">InstanceLayer ｜ Auth · Bus · Session · Provider · Permission · Tool · MCP · LSP ...</text>
  <text x="60" y="252" font-size="10" fill="#64748b">所有 Service 经 Layer 注入；handler 在 effect.gen 里 yield* Service.Type 即可拿到</text>
  <path d="M380,268 L380,290" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar102)"/>
  <rect x="40" y="292" width="680" height="166" rx="8" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="60" y="312" font-size="12" font-weight="700" fill="currentColor">Router</text>
  <rect x="60" y="320" width="660" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="74" y="336" font-size="11" fill="currentColor">Authorization middleware → 401 或 continue（public 路径跳过）</text>
  <rect x="60" y="344" width="660" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="74" y="360" font-size="11" fill="currentColor">workspace-routing → Local（本机 InstanceStore）｜ Remote（proxy 转发）</text>
  <rect x="60" y="368" width="660" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="74" y="384" font-size="11" fill="currentColor">instance-context → 把 InstanceRef provide 进 handler effect</text>
  <line x1="60" y1="394" x2="720" y2="394" stroke="#cbd5e1" stroke-dasharray="3,2"/>
  <rect x="60" y="398" width="155" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="138" y="413" text-anchor="middle" font-size="10.5" fill="currentColor">RootHttpApi</text>
  <rect x="220" y="398" width="155" height="22" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="298" y="413" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">EventApi（SSE）</text>
  <rect x="380" y="398" width="155" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="458" y="413" text-anchor="middle" font-size="10.5" fill="currentColor">InstanceHttpApi</text>
  <rect x="540" y="398" width="160" height="22" rx="3" fill="#fff" stroke="#94a3b8"/>
  <text x="620" y="413" text-anchor="middle" font-size="10.5" fill="currentColor">PtyConnectApi (WS)</text>
  <rect x="60" y="424" width="320" height="22" rx="3" fill="#fff" stroke="#94a3b8"/>
  <text x="220" y="439" text-anchor="middle" font-size="10.5" fill="currentColor">docRoute ｜ /doc OpenAPI spec</text>
  <rect x="385" y="424" width="315" height="22" rx="3" fill="#fff" stroke="#94a3b8"/>
  <text x="542" y="439" text-anchor="middle" font-size="10.5" fill="currentColor">uiRoute ｜ /* Web UI proxy</text>
  <path d="M298,458 L298,482" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar102)"/>
  <rect x="190" y="484" width="380" height="42" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.4"/>
  <text x="380" y="504" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">bus ｜ GlobalBus + project bus</text>
  <text x="380" y="520" text-anchor="middle" font-size="10.5" fill="#64748b">SSE 把 bus 事件以 text/event-stream 推给所有订阅者</text>
  <path d="M380,526 L380,548" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar102)"/>
  <rect x="40" y="550" width="680" height="40" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
  <text x="380" y="572" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Client ｜ TUI · desktop · web · IDE · SDK · curl</text>
  <text x="380" y="585" text-anchor="middle" font-size="10" fill="#64748b">同一份 SDK schema，所有形态都消费 /event 流</text>
</svg>
<span class="figure-caption">图 R10.2 ｜ opencode serve 启动后请求穿过 listener → middleware → router → bus，最终经 SSE 复制给所有 client。</span>

<details>
<summary>ASCII 原版</summary>

```
            opencode serve --hostname 0.0.0.0 --port 4096
                              │
                              ▼
              ┌──────── server.ts listen() ──────────┐
              │  Effect runtime + NodeHttpServer     │
              └──────────────┬──────────────────────┘
                              │
                              ▼
   ┌────────────── Middleware 链（Layer） ────────────────┐
   │  errorLayer                                          │
   │  compressionLayer                                    │
   │  corsVaryFix                                         │
   │  fenceLayer                                          │
   │  cors (isAllowedCorsOrigin)                          │
   │  + InstanceLayer.layer (Account/Auth/Bus/Session/   │
   │    Session*/Provider/Permission/Tool/MCP/LSP/...)   │
   └──────────────────────┬──────────────────────────────┘
                          │
   ┌──────────────────────┴──────────────────────────────┐
   │ Router                                              │
   │  • Authorization middleware ──→ 401 / continue      │
   │  • workspace-routing ──→ Local | Remote (proxy)     │
   │  • instance-context ──→ InstanceRef provided       │
   ├─────────────────────────────────────────────────────┤
   │  RootHttpApi      /global/*, /auth/*, /log         │
   │  EventApi         /event (SSE)                      │
   │  InstanceHttpApi  /session/* /file/* /tui/* ...    │
   │  PtyConnectApi    /pty/connect/:ticket (WebSocket)  │
   │  docRoute         /doc (OpenAPI spec)               │
   │  uiRoute          /* (Web UI proxy)                 │
   └──────────────────────┬──────────────────────────────┘
                          │
                          ▼
            ┌─── bus (SSE/event 推送) ───┐
            │  GlobalBus + project bus    │
            └─────────────────────────────┘
                          │
                          ▼ SSE
   ┌──────────────────────────────────────────────────────┐
   │  Client：TUI / desktop / web / IDE / SDK / curl     │
   └──────────────────────────────────────────────────────┘
```

</details>

---

## 10.16 小结

opencode 把所有产品形态都收敛到 client-server：

- **Effect HttpApi**：schema → handler → OpenAPI → SDK 全自动。
- **路由分三层**：root（无 instance 上下文）、event（仅 SSE）、instance（按 directory 路由到 InstanceContext）。
- **SSE 是 bus → 客户端的唯一桥**：bus 是真理之源，SSE 让事件实时复制到所有 client。
- **Auth**：Basic Auth + 可选 query token；本地 dev 默认开放、远程暴露必设密码。
- **mDNS**：局域网零配置发现。
- **Projector**：CQRS 读模型由 server 模块顶层 import 触发初始化，保证事件→sqlite 投影注册早于任何请求。
- **`opencode serve`**：无 ambient project 的 headless 模式，按 directory 现场 load instance。

读完本章和第 09 章，整个 opencode 的运行时图景就完整了：TUI 进程渲染、worker 内 server 处理、bus 事件双向流转、sqlite 持久化、外部客户端通过同一套 HTTP/SSE 接入。
