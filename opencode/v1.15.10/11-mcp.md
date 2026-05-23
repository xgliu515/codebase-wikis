# 第 11 章：MCP 集成（Model Context Protocol）

> 代码版本锁定：`anomalyco/opencode@d74d166ac`（tag `v1.15.10`，2026-05-23）。所有 `file:line` 引用均以仓库根 `packages/opencode/` 为相对起点。

## 0. 这一章要解决的问题

opencode 是一个终端 AI 编码 Agent。"Agent"意味着它要让 LLM 调用工具。工具有两类：

1. **内建工具**（read / write / bash / glob / websearch / skill / agent / ...）。这些工具的实现代码住在 opencode 进程里，由 `Tool.define()` 注册，详见第 04 章。
2. **外部工具**。外部工具的实现住在别的进程里，按某种协议跟 opencode 通讯。这就是 MCP 要解决的事。

如果没有一个通用协议，每接入一种外部工具就要在 opencode 里写一段适配代码：连什么、怎么 spawn、怎么列工具、怎么调、怎么超时、怎么鉴权——每个工具都重写一遍，谁也维护不动。Anthropic 在 2024 年提出的 **Model Context Protocol（MCP）** 就是把"宿主"和"工具服务器"之间的接线规范化：服务器以 JSON-RPC 的方式暴露 `tools/list`、`tools/call`、`resources/list`、`prompts/list` 等几个标准方法，宿主只要会说这一套，就能接任何 MCP 服务器。

opencode 在这一层的角色是 **MCP 客户端**。它把 MCP 服务器暴露的工具混进自己的工具表，让 LLM 像调用内建工具一样调用它们。本章自上而下讲清楚：

- 配置怎么写、有几种 transport
- 客户端的连接生命周期与状态机
- 工具如何被列出、注册、调用
- OAuth 怎么走（本地起 callback server、token 怎么持久化）
- `opencode mcp` CLI 的所有子命令
- 一个特例：`mcp-websearch` 把 MCP 当 HTTP 调用对待，绕过完整客户端
- opencode 自己暴露 MCP server 吗？答：v1.15.10 不暴露

<svg viewBox="0 0 760 520" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="MCP integration architecture: tool registry, MCP service, SDK Client, stdio vs remote transports">
  <defs>
    <marker id="ar111" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="40" y="16" width="680" height="350" rx="10" fill="#fff7ed" stroke="#ea580c" stroke-width="1.4"/>
  <text x="60" y="36" font-size="12" font-weight="700" fill="#ea580c">opencode 进程</text>
  <rect x="80" y="48" width="600" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
  <text x="380" y="68" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Tool 注册表（内建 + MCP-derived）</text>
  <text x="380" y="86" text-anchor="middle" font-size="10.5" fill="#64748b">每轮喂给 LLM 的工具表</text>
  <path d="M380,108 L380,128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar111)"/>
  <text x="395" y="122" font-size="9.5" fill="#64748b">tools() → AI SDK Tool</text>
  <rect x="80" y="130" width="600" height="46" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.3"/>
  <text x="380" y="150" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">MCP.Service</text>
  <text x="380" y="166" text-anchor="middle" font-size="10.5" fill="#64748b">status / clients / tools / connect / disconnect / startAuth ...</text>
  <path d="M380,188 L380,208" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar111)"/>
  <text x="455" y="202" font-size="9.5" fill="#64748b">callTool / listTools / listResources</text>
  <rect x="80" y="210" width="600" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="380" y="230" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">@modelcontextprotocol/sdk Client</text>
  <text x="380" y="246" text-anchor="middle" font-size="10.5" fill="#64748b">JSON-RPC 2.0：initialize / tools.* / resources.* / prompts.*</text>
  <path d="M380,266 L380,290" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar111)"/>
  <rect x="80" y="292" width="290" height="62" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="225" y="312" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Stdio Transport</text>
  <text x="225" y="330" text-anchor="middle" font-size="10.5" fill="#64748b">spawn 子进程</text>
  <text x="225" y="345" text-anchor="middle" font-size="10" fill="#64748b">Content-Length 分帧 via stdin/stdout</text>
  <rect x="390" y="292" width="290" height="62" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="535" y="312" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">StreamableHTTP / SSE Transport</text>
  <text x="535" y="330" text-anchor="middle" font-size="10.5" fill="#64748b">远程 URL + OAuth</text>
  <text x="535" y="345" text-anchor="middle" font-size="10" fill="#64748b">先 StreamableHTTP，失败 fallback SSE</text>
  <path d="M225,366 L225,398" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar111)"/>
  <path d="M535,366 L535,398" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar111)"/>
  <rect x="80" y="400" width="290" height="80" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
  <text x="225" y="422" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">外部进程</text>
  <text x="225" y="440" text-anchor="middle" font-size="10.5" fill="#64748b">filesystem-mcp</text>
  <text x="225" y="456" text-anchor="middle" font-size="10.5" fill="#64748b">github-mcp</text>
  <text x="225" y="472" text-anchor="middle" font-size="10" fill="#94a3b8">opencode 进程持有 pid</text>
  <rect x="390" y="400" width="290" height="80" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.4"/>
  <text x="535" y="422" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">远程 HTTP 服务器</text>
  <text x="535" y="440" text-anchor="middle" font-size="10.5" fill="#64748b">https://mcp.exa.ai/mcp</text>
  <text x="535" y="456" text-anchor="middle" font-size="10.5" fill="#64748b">GitHub remote MCP</text>
  <text x="535" y="472" text-anchor="middle" font-size="10" fill="#94a3b8">OAuth token 持久化在本机</text>
</svg>
<span class="figure-caption">图 R11.1 ｜ MCP 子系统四层栈：Tool 注册表 → MCP.Service → SDK Client → stdio/HTTP transport，最后接到外部进程或远程服务器。</span>

<details>
<summary>ASCII 原版</summary>

```
                      opencode 进程
   ┌───────────────────────────────────────────────────────────┐
   │  Tool 注册表 (内建 + MCP-derived)                          │
   │     ▲                                                      │
   │     │ tools() 把 MCP 工具转成 AI SDK Tool                  │
   │  MCP.Service                                               │
   │     ▲                                                      │
   │     │ Client.callTool / listTools / listResources / ...    │
   │  @modelcontextprotocol/sdk Client                          │
   │     ▲                                                      │
   │  ┌──┴────────────────┬─────────────────────────────────┐   │
   │  │ Stdio Transport   │ StreamableHTTP / SSE Transport  │   │
   │  │  (spawn 子进程)   │  (远程 URL + OAuth)             │   │
   │  └──────────┬────────┴──────────────┬──────────────────┘   │
   └─────────────┼───────────────────────┼──────────────────────┘
                 ▼                       ▼
        ┌─────────────────┐    ┌────────────────────────┐
        │  外部进程         │    │  远程 HTTP 服务器        │
        │  filesystem-mcp  │    │  https://mcp.exa.ai/mcp│
        │  github-mcp      │    │  GitHub remote MCP     │
        └─────────────────┘    └────────────────────────┘
```

</details>

---

## 1. MCP 是什么

MCP 是一个基于 JSON-RPC 2.0 的协议。客户端（host LLM 应用）和服务器（工具提供方）按约定交换以下消息：

| 客户端 → 服务器 | 用途 |
| --- | --- |
| `initialize` | 握手、协商协议版本与能力 |
| `tools/list` | 列出可调用工具及其 input JSON Schema |
| `tools/call` | 真正调用一个工具，传 arguments，拿回 `content[]` |
| `resources/list` | 列出可读资源（文件、文档、网页 URI） |
| `resources/read` | 按 URI 读资源 |
| `prompts/list` / `prompts/get` | 列出/获取服务端预定义的 prompt 模板 |

| 服务器 → 客户端 | 用途 |
| --- | --- |
| `notifications/tools/list_changed` | 告知客户端工具表变了，让它重新拉一次 |

opencode 用的是官方 SDK `@modelcontextprotocol/sdk`，所以协议细节（编码、超时、心跳）由 SDK 负责。opencode 写的是"调度层"：什么时候创建 Client、什么时候关闭、tools 怎么 mix 进自己的注册表、OAuth 怎么走。

---

## 2. 配置入口

### 2.1 `opencode.json` 里的 `mcp` 字段

opencode 的配置文件（`opencode.json` / `opencode.jsonc` / 全局 / 项目级，详见第 03 章）有一个顶层字段 `mcp`，类型是 `Record<string, ConfigMCP.Info>`，键是 MCP 服务器的逻辑名（用户起的），值是该服务器的连接信息：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "filesystem": {
      "type": "local",
      "command": ["bunx", "@modelcontextprotocol/server-filesystem", "/Users/me/code"],
      "environment": { "FOO": "bar" },
      "timeout": 30000
    },
    "github": {
      "type": "remote",
      "url": "https://api.githubcopilot.com/mcp",
      "oauth": { "clientId": "Iv1.xxx" }
    },
    "exa": {
      "type": "remote",
      "url": "https://mcp.exa.ai/mcp?exaApiKey=xxx",
      "oauth": false
    }
  }
}
```

### 2.2 Schema 定义：`packages/opencode/src/config/mcp.ts`

```ts
// packages/opencode/src/config/mcp.ts:4-18
export const Local = Schema.Struct({
  type: Schema.Literal("local"),
  command: Schema.mutable(Schema.Array(Schema.String)),  // argv，第一项是命令
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
  timeout: Schema.optional(PositiveInt),
})

// packages/opencode/src/config/mcp.ts:39-55
export const Remote = Schema.Struct({
  type: Schema.Literal("remote"),
  url: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  oauth: Schema.optional(Schema.Union([OAuth, Schema.Literal(false)])),
  timeout: Schema.optional(PositiveInt),
})

// packages/opencode/src/config/mcp.ts:57
export const Info = Schema.Union([Local, Remote]).annotate({ discriminator: "type" })
```

`OAuth` 子结构在同文件 `:21-36`：

```ts
export const OAuth = Schema.Struct({
  clientId: Schema.optional(Schema.String),        // 没填则尝试 RFC 7591 动态注册
  clientSecret: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  callbackPort: Schema.optional(Schema.Int...),    // 简写：只改回调端口
  redirectUri: Schema.optional(Schema.String),     // 完整重写回调 URL
})
```

`type` 字段是 discriminator。Effect Schema 校验时按 `type` 分支选 `Local` 或 `Remote`，错配类型会被 Config 服务拒掉，启动失败。

### 2.3 字段含义

| 字段 | 适用 | 含义 |
| --- | --- | --- |
| `type` | 两者 | `"local"` 走 stdio 子进程，`"remote"` 走 HTTP |
| `command` | local | `argv` 数组。例：`["bunx", "@modelcontextprotocol/server-filesystem", "/path"]` |
| `environment` | local | 子进程环境变量，会合进 `process.env` |
| `url` | remote | 服务器 URL，opencode 会先尝试 StreamableHTTP，失败 fallback 到 SSE |
| `headers` | remote | 注入到每次请求 |
| `oauth` | remote | `false` 显式关掉自动 OAuth；对象表示用 OAuth；未填表示遇到 401 时自动触发 |
| `enabled` | 两者 | 默认 true；false 表示加载到状态机里但不实际连接 |
| `timeout` | 两者 | 单次请求超时，默认 30s（见 `mcp/index.ts:36`） |

---

## 3. MCP.Service：服务实例化

整个 MCP 子系统的核心是 `packages/opencode/src/mcp/index.ts`，是 opencode 里第二大的单文件（971 行）。它对外暴露 `MCP.Service`，一个 Effect Context Service，接口签名见 `mcp/index.ts:242-269`：

```ts
export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  readonly tools: () => Effect.Effect<Record<string, Tool>>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: () => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly add: (name, mcp) => Effect.Effect<{ status: ... }>
  readonly connect: (name) => Effect.Effect<void, NotFoundError>
  readonly disconnect: (name) => Effect.Effect<void, NotFoundError>
  readonly getPrompt: (clientName, name, args?) => Effect.Effect<...>
  readonly readResource: (clientName, resourceUri) => Effect.Effect<...>
  readonly startAuth: (mcpName) => Effect.Effect<{ authorizationUrl, oauthState }, ...>
  readonly authenticate: (mcpName) => Effect.Effect<Status, ...>
  readonly finishAuth: (mcpName, authorizationCode) => Effect.Effect<Status, ...>
  readonly removeAuth: (mcpName) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName) => Effect.Effect<boolean, ...>
  readonly hasStoredTokens: (mcpName) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName) => Effect.Effect<AuthStatus>
}
```

服务内部 state（`mcp/index.ts:236-240`）：

```ts
interface State {
  status: Record<string, Status>      // 每个服务器的当前状态
  clients: Record<string, MCPClient>  // 已连接的 SDK Client 实例
  defs: Record<string, MCPToolDef[]>  // 缓存的工具定义（避免每次都重拉）
}
```

`Status` 是个有 5 个分支的判别联合（`mcp/index.ts:76-99`）：

```
connected | disabled | failed{error} | needs_auth | needs_client_registration{error}
```

为什么把 `defs` 单独缓存？因为 `tools()` 会被 chat loop 频繁调，每次都跨进程跑 `tools/list` 是不可接受的。MCP 服务器要变更工具表的时候，会通过 `notifications/tools/list_changed` 主动通知，opencode 在那时再刷新缓存（见 §7）。

### 3.1 layer：服务的初始化时序

`MCP.layer`（`mcp/index.ts:275-957`）做了下面这些事：

1. 拿到 `ChildProcessSpawner`（用来 spawn stdio 服务器和找子进程后裔做清理）。
2. 拿到 `McpAuth.Service` 和 `Bus.Service`。
3. 注册一个 `InstanceState`（每个 opencode 实例一份），它的初始化函数会读 `cfg.mcp`，并发地为每个 enabled 的服务器调 `create()`：

```ts
// mcp/index.ts:533-558
yield* Effect.forEach(
  Object.entries(config),
  ([key, mcp]) =>
    Effect.gen(function* () {
      if (!isMcpConfigured(mcp)) { /* 跳过非法配置 */ return }
      if (mcp.enabled === false) { s.status[key] = { status: "disabled" }; return }
      const result = yield* create(key, mcp).pipe(Effect.catch(() => Effect.void))
      if (!result) return
      s.status[key] = result.status
      if (result.mcpClient) {
        s.clients[key] = result.mcpClient
        s.defs[key] = result.defs!
        watch(s, key, result.mcpClient, bridge, mcp.timeout)
      }
    }),
  { concurrency: "unbounded" },  // 并发拉起，单台卡住不影响其他
)
```

4. 注册一个 finalizer（`mcp/index.ts:560-581`）：进程退出时遍历所有 stdio client，先 `pgrep -P` 找出子进程的整棵后裔树发 SIGTERM，再调 `client.close()`。这是避免 MCP 服务器自己 spawn 的孙子进程在 opencode 退出后变成孤儿。

---

## 4. Stdio transport：本地 MCP 服务器

### 4.1 connectLocal 流程

`connectLocal`（`mcp/index.ts:421-454`）做的事：

```ts
const connectLocal = Effect.fn("MCP.connectLocal")(function* (key, mcp) {
  const [cmd, ...args] = mcp.command
  const cwd = yield* InstanceState.directory
  const transport = new StdioClientTransport({
    stderr: "pipe",
    command: cmd,
    args,
    cwd,
    env: {
      ...process.env,
      ...(cmd === "opencode" ? { BUN_BE_BUN: "1" } : {}),
      ...mcp.environment,
    },
  })
  transport.stderr?.on("data", (chunk) => {
    log.info(`mcp stderr: ${chunk.toString()}`, { key })
  })
  return yield* connectTransport(transport, mcp.timeout ?? DEFAULT_TIMEOUT).pipe(...)
})
```

几个值得注意的点：

- **cwd 来自 InstanceState.directory**：opencode 启动时绑定的项目目录，这样 MCP filesystem server 默认根目录跟用户当前工程一致。
- **`BUN_BE_BUN=1`**：当用户把另一个 opencode 进程当 MCP server 用时（`command: ["opencode", ...]`），子进程要走 Bun 而不是 Node 路径。
- **stderr 重定向**：子进程的 stderr 不会污染 opencode 自己的 TTY，而是按行打到日志里。
- **JSON-RPC 走 stdin/stdout**：SDK 的 `StdioClientTransport` 内部用 LSP 风格的分帧（Content-Length 头），opencode 不直接接触。

### 4.2 子进程清理：descendants() 函数

stdio MCP 服务器可能会自己 fork 出辅助进程。直接 `client.close()` 只会发关闭消息给入口进程，孙子辈进程可能继续运行。`mcp/index.ts:484-506` 的 `descendants()` 用 `pgrep -P` 递归找出整棵后裔树：

```ts
const descendants = Effect.fnUntraced(function* (pid: number) {
  if (process.platform === "win32") return [] as number[]
  const pids: number[] = []
  const queue = [pid]
  while (queue.length > 0) {
    const current = queue.shift()!
    const handle = yield* spawner.spawn(
      ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" })
    )
    const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
    yield* handle.exitCode
    for (const tok of text.split("\n")) {
      const cpid = parseInt(tok, 10)
      if (!isNaN(cpid) && !pids.includes(cpid)) { pids.push(cpid); queue.push(cpid) }
    }
  }
  return pids
})
```

退出时（`mcp/index.ts:561-581`）：

```ts
yield* Effect.addFinalizer(() =>
  Effect.gen(function* () {
    yield* Effect.forEach(Object.values(s.clients), (client) =>
      Effect.gen(function* () {
        const pid = client.transport instanceof StdioClientTransport ? client.transport.pid : null
        if (typeof pid === "number") {
          const pids = yield* descendants(pid)
          for (const dpid of pids) {
            try { process.kill(dpid, "SIGTERM") } catch {}
          }
        }
        yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
      }),
      { concurrency: "unbounded" },
    )
  }),
)
```

Windows 上没有 `pgrep`，直接跳过——这里是已知的清理短板。

---

## 5. Remote transport：StreamableHTTP / SSE

### 5.1 双 transport fallback

MCP 远程协议有两个版本：早期的 SSE（Server-Sent Events，单向 push）和新的 StreamableHTTP（双向流）。同一个服务器可能只支持其中一种，所以 opencode 顺序试两次（`mcp/index.ts:339-413`）：

```ts
const transports: Array<{ name: string; transport: TransportWithAuth }> = [
  {
    name: "StreamableHTTP",
    transport: new StreamableHTTPClientTransport(url, {
      authProvider,
      requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
    }),
  },
  {
    name: "SSE",
    transport: new SSEClientTransport(url, {
      authProvider,
      requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
    }),
  },
]

for (const { name, transport } of transports) {
  const result = yield* connectTransport(transport, connectTimeout).pipe(
    Effect.map((client) => ({ client, transportName: name })),
    Effect.catch((error) => { /* 分情况设 lastStatus，可能是 needs_auth/failed */ }),
  )
  if (result) {
    log.info("connected", { key, transport: result.transportName })
    return { client: result.client, status: { status: "connected" } }
  }
  if (lastStatus?.status === "needs_auth" || lastStatus?.status === "needs_client_registration") break
}
```

如果 StreamableHTTP 返回的不是 auth 错误（比如直接 4xx），就尝试 SSE；如果是 auth 错误，两个 transport 都需要 OAuth，没必要再试 SSE，直接跳出。

### 5.2 错误分类

`connectTransport` 抛出来的错误经过 `mcp/index.ts:362-405` 的 `Effect.catch` 分类：

```ts
const isAuthError = error instanceof UnauthorizedError
                    || (authProvider && lastError.message.includes("OAuth"))

if (isAuthError) {
  if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
    lastStatus = {
      status: "needs_client_registration",
      error: "Server does not support dynamic client registration. Please provide clientId in config.",
    }
    return bus.publish(TuiEvent.ToastShow, {
      title: "MCP Authentication Required",
      message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
      variant: "warning",
      duration: 8000,
    })
  } else {
    pendingOAuthTransports.set(key, transport)  // 留着备用
    lastStatus = { status: "needs_auth" }
    return bus.publish(TuiEvent.ToastShow, {
      title: "MCP Authentication Required",
      message: `Server "${key}" requires authentication. Run: opencode mcp auth ${key}`,
      variant: "warning",
      duration: 8000,
    })
  }
}
```

关键点：

- **needs_auth** 状态下，transport 实例会被存进 `pendingOAuthTransports` map。之后 `opencode mcp auth <name>` 走 OAuth 流程拿到 token 时，会取出同一个 transport 调 `.finishAuth(code)`——SDK 内部已经记下了 code_verifier 等 PKCE 状态。
- **needs_client_registration** 表示动态注册（RFC 7591）失败，必须人工填 clientId。opencode 直接 toast 提示用户改配置。
- TUI 通过 `TuiEvent.ToastShow` 事件订阅这些通知，弹出非阻塞 toast。

### 5.3 headers 注入

用户可以在 `mcp.headers` 里塞任意 HTTP 头（比如自定义鉴权）：

```jsonc
"github": {
  "type": "remote",
  "url": "https://...",
  "headers": { "X-API-Key": "...", "User-Agent": "..." }
}
```

`mcp/index.ts:343-352` 直接把它当 `requestInit.headers` 传给 transport 构造函数。这是非 OAuth 场景的鉴权出口。

---

## 6. OAuth 全流程

OAuth 是远程 MCP 最复杂的部分。涉及三个文件：

| 文件 | 职责 |
| --- | --- |
| `mcp/auth.ts` | token / clientInfo / codeVerifier / oauthState 的持久化 |
| `mcp/oauth-provider.ts` | 实现 SDK 的 `OAuthClientProvider` 接口，把 SDK 的 callback 接到 opencode 的存储 |
| `mcp/oauth-callback.ts` | 本地 HTTP server，接收授权服务器的 redirect 回调 |

### 6.1 凭据存储：mcp-auth.json

`mcp/auth.ts:35` 定义存储路径：

```ts
const filepath = path.join(Global.Path.data, "mcp-auth.json")  // ~/.local/share/opencode/mcp-auth.json
```

`Entry` schema（`mcp/auth.ts:23-29`）：

```ts
export const Entry = Schema.Struct({
  tokens: Schema.mutableKey(Schema.optional(Tokens)),          // accessToken/refreshToken/expiresAt/scope
  clientInfo: Schema.mutableKey(Schema.optional(ClientInfo)),  // 动态注册得到的 clientId/clientSecret
  codeVerifier: Schema.mutableKey(Schema.optional(Schema.String)),  // PKCE
  oauthState: Schema.mutableKey(Schema.optional(Schema.String)),    // CSRF
  serverUrl: Schema.mutableKey(Schema.optional(Schema.String)),     // 关键：用来识别 URL 是否变了
})
```

**为什么存 `serverUrl`？** 同一个 MCP name 的 URL 可能被改了。如果用旧 URL 拿到的 token 用在新 URL 上是危险的，所以 `getForUrl()`（`mcp/auth.ts:74-80`）会比对 URL，不匹配就当成无凭据，触发重新授权：

```ts
const getForUrl = Effect.fn("McpAuth.getForUrl")(function* (mcpName, serverUrl) {
  const entry = yield* get(mcpName)
  if (!entry) return undefined
  if (!entry.serverUrl) return undefined
  if (entry.serverUrl !== serverUrl) return undefined
  return entry
})
```

文件权限是 `0o600`（`mcp/auth.ts:85`），只让当前用户读。

### 6.2 McpOAuthProvider

`mcp/oauth-provider.ts` 实现 SDK 要求的 `OAuthClientProvider` 接口。SDK 内部触发各种回调时，这个类把它们桥到 opencode 的存储：

| SDK 调它 | 做什么 |
| --- | --- |
| `get redirectUrl` | 返回本地回调 URL：`http://127.0.0.1:19876/mcp/oauth/callback` |
| `get clientMetadata` | 返回客户端元数据（用于动态注册），name="OpenCode"，PKCE 走 S256 |
| `clientInformation()` | 先看 config 里有没有写死的 clientId；没有再看本地存的动态注册结果；都没有→返回 undefined 触发动态注册 |
| `saveClientInformation()` | SDK 完成动态注册后，把得到的 clientId/clientSecret 存回 mcp-auth.json |
| `tokens()` | 读出已存的 tokens（同 URL 才返回，否则 undefined） |
| `saveTokens()` | token refresh 完成后存回去 |
| `redirectToAuthorization(url)` | SDK 让宿主把用户带去授权页——opencode 这里只是 callback 给上层 |
| `saveCodeVerifier()` / `codeVerifier()` | PKCE verifier 的持久化 |
| `saveState()` / `state()` | CSRF state |
| `invalidateCredentials(type)` | SDK 检测到 token 失效时清掉对应字段 |

注意 `state()`（`mcp/oauth-provider.ts:158-173`）的特殊处理：

```ts
async state(): Promise<string> {
  const entry = await Effect.runPromise(this.auth.get(this.mcpName))
  if (entry?.oauthState) return entry.oauthState
  // SDK 把 state() 当 generator 用，没现成的就生成新值并存下
  const newState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0")).join("")
  await Effect.runPromise(this.auth.updateOAuthState(this.mcpName, newState))
  return newState
}
```

### 6.3 本地 callback server

授权服务器把用户重定向回 opencode 时，得有人接住这个请求。`mcp/oauth-callback.ts` 起一个 Node http server 监听 `127.0.0.1:19876`（可改）。

#### ensureRunning：单例 + 端口动态调整

```ts
// mcp/oauth-callback.ts:141-170
export async function ensureRunning(redirectUri?: string): Promise<void> {
  const { port, path } = parseRedirectUri(redirectUri)
  if (server && (currentPort !== port || currentPath !== path)) {
    log.info("stopping oauth callback server to reconfigure", { oldPort: currentPort, newPort: port })
    await stop()
  }
  if (server) return
  const running = await isPortInUse(port)
  if (running) {
    log.info("oauth callback server already running on another instance", { port })
    return
  }
  currentPort = port
  currentPath = path
  server = createServer(handleRequest)
  await new Promise<void>((resolve, reject) => {
    server!.listen(currentPort, () => { log.info("oauth callback server started"); resolve() })
    server!.on("error", reject)
  })
}
```

幂等。如果同一台机器上另一个 opencode 实例已经占了端口，这里直接返回——浏览器会把回调发到那个实例，但因为 OAuth state 不匹配会被拒掉。这是已知的多实例边界情况。

#### handleRequest：CSRF 防御

```ts
// mcp/oauth-callback.ts:76-139
function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://localhost:${currentPort}`)
  if (url.pathname !== currentPath) { res.writeHead(404); res.end("Not found"); return }

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")

  if (!state) { /* 400 Missing state - potential CSRF attack */ return }
  if (error) { /* reject pending, show HTML_ERROR */ return }
  if (!code) { /* 400 No code */ return }
  if (!pendingAuths.has(state)) { /* 400 Invalid state - potential CSRF attack */ return }

  const pending = pendingAuths.get(state)!
  clearTimeout(pending.timeout)
  pendingAuths.delete(state)
  cleanupStateIndex(state)
  pending.resolve(code)

  res.writeHead(200, { "Content-Type": "text/html" })
  res.end(HTML_SUCCESS)
}
```

`pendingAuths: Map<oauthState, PendingAuth>` 是回调跟等待者的接力站。`mcp/index.ts:853` 在浏览器打开前调 `McpOAuthCallback.waitForCallback(oauthState, mcpName)`，注册一个 promise；浏览器回调到达后这个 promise 被 resolve 出 code。超时 5 分钟（`mcp/oauth-callback.ts:65`）。

### 6.4 完整 authenticate() 时序

把 `mcp/index.ts:832-886` 的 `authenticate()` 拆开看：

<svg viewBox="0 0 760 560" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="MCP OAuth four phases: startAuth, browser redirect, state validation, finishAuth">
  <defs>
    <marker id="ar112" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="40" y="16" width="680" height="120" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
  <text x="60" y="36" font-size="12" font-weight="700" fill="#ea580c">① startAuth(mcpName) ｜ mcp/index.ts:771-830</text>
  <rect x="60" y="44" width="660" height="20" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="74" y="58" font-size="10.5" fill="currentColor">校验 mcp 为 remote 且未禁 OAuth</text>
  <rect x="60" y="66" width="660" height="20" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="74" y="80" font-size="10.5" fill="currentColor">ensureRunning(redirectUri) ｜ 起本地回调 server 127.0.0.1:19876</text>
  <rect x="60" y="88" width="660" height="20" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="74" y="102" font-size="10.5" fill="currentColor">生成 oauthState（32B 随机）写入 mcp-auth.json</text>
  <rect x="60" y="110" width="660" height="20" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="74" y="124" font-size="10.5" fill="currentColor">client.connect(transport) 期望抛 UnauthorizedError 拿到 authorizationUrl ｜ pendingOAuthTransports.set(name, transport)</text>
  <path d="M380,138 L380,158" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar112)"/>
  <rect x="40" y="160" width="680" height="116" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.4"/>
  <text x="60" y="180" font-size="12" font-weight="700" fill="#7c3aed">② 浏览器授权回路</text>
  <rect x="60" y="188" width="660" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="74" y="203" font-size="10.5" fill="currentColor">McpOAuthCallback.waitForCallback(oauthState, mcpName) ｜ 注册 promise 等回调</text>
  <rect x="60" y="212" width="660" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="74" y="227" font-size="10.5" fill="currentColor">open(authorizationUrl) 跨平台打开浏览器（失败 → bus.publish BrowserOpenFailed，CLI 提示手动复制 URL）</text>
  <rect x="60" y="236" width="660" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="74" y="251" font-size="10.5" fill="currentColor">本地 server 接住 /mcp/oauth/callback?code=...&amp;state=... ｜ resolve callbackPromise(code)</text>
  <path d="M380,278 L380,298" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar112)"/>
  <rect x="40" y="300" width="680" height="86" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="1.4"/>
  <text x="60" y="320" font-size="12" font-weight="700" fill="#dc2626">③ CSRF state 校验</text>
  <rect x="60" y="328" width="660" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="74" y="343" font-size="10.5" fill="currentColor">if (storedState !== result.oauthState) throw "OAuth state mismatch"</text>
  <rect x="60" y="352" width="660" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="74" y="367" font-size="10.5" fill="currentColor">yield* auth.clearOAuthState(mcpName) ｜ 防止 state 重放</text>
  <path d="M380,388 L380,408" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar112)"/>
  <rect x="40" y="410" width="680" height="118" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.4"/>
  <text x="60" y="430" font-size="12" font-weight="700" fill="#0d9488">④ finishAuth(mcpName, code) ｜ mcp/index.ts:888-911</text>
  <rect x="60" y="438" width="660" height="20" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="74" y="452" font-size="10.5" fill="currentColor">pendingOAuthTransports.get(mcpName) 取回带 code_verifier 的 transport</text>
  <rect x="60" y="460" width="660" height="20" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="74" y="474" font-size="10.5" fill="currentColor">transport.finishAuth(code) ｜ SDK 内部用 PKCE 交换 access/refresh token</text>
  <rect x="60" y="482" width="660" height="20" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="74" y="496" font-size="10.5" fill="currentColor">provider.saveTokens 写回 mcp-auth.json（权限 0o600） ｜ auth.clearCodeVerifier(mcpName)</text>
  <rect x="60" y="504" width="660" height="20" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="74" y="518" font-size="10.5" fill="currentColor">createAndStore(mcpName, mcpConfig) 重新连接并把 status 翻成 connected</text>
  <text x="380" y="548" text-anchor="middle" font-size="10" fill="#64748b">橙=入口握手 ｜ 紫=浏览器外回路 ｜ 红=CSRF 防御 ｜ 青=token 落盘与重连</text>
</svg>
<span class="figure-caption">图 R11.2 ｜ MCP OAuth 四阶段：startAuth 起回调 → 浏览器授权 → state 校验 → finishAuth 交换 token 并重连。</span>

<details>
<summary>ASCII 原版</summary>

```
1. startAuth(mcpName)             ← mcp/index.ts:771-830
   ├─ 校验 mcp 是 remote 且未禁 OAuth
   ├─ ensureRunning(redirectUri)  ← 起本地回调 server
   ├─ 生成 oauthState（32 字节随机）并存 mcp-auth.json
   ├─ 新建 McpOAuthProvider（onRedirect 捕获授权 URL）
   ├─ 新建 StreamableHTTPClientTransport，client.connect(transport)
   ├─ 期望抛出 UnauthorizedError，把 capturedUrl 返回
   └─ pendingOAuthTransports.set(mcpName, transport)

2. 拿到 authorizationUrl
   ├─ McpOAuthCallback.waitForCallback(oauthState, mcpName)
   ├─ open(authorizationUrl)      ← 用 `open` 包跨平台开浏览器
   │  ├─ 失败 → bus.publish(BrowserOpenFailed)  让 CLI 改成提示用户手动复制
   └─ 等 callbackPromise resolve 出 code

3. 校验 state（防 CSRF）
   if (storedState !== result.oauthState) throw "OAuth state mismatch"
   yield* auth.clearOAuthState(mcpName)

4. finishAuth(mcpName, code)      ← mcp/index.ts:888-911
   ├─ pendingOAuthTransports.get(mcpName) 拿回保留的 transport
   ├─ transport.finishAuth(code) ← SDK 内部交换 token 并通过 provider.saveTokens 落盘
   ├─ auth.clearCodeVerifier(mcpName)
   └─ createAndStore(mcpName, mcpConfig)  ← 重新建立带 token 的连接
```

</details>

### 6.5 浏览器开不起来的兜底

某些环境（容器、无 X11、SSH 终端）`open` 起不来浏览器。`mcp/index.ts:855-875`：

```ts
yield* Effect.tryPromise(() => open(result.authorizationUrl)).pipe(
  Effect.flatMap((subprocess) =>
    Effect.callback<void, Error>((resume) => {
      const timer = setTimeout(() => resume(Effect.void), 500)
      subprocess.on("error", (err) => { clearTimeout(timer); resume(Effect.fail(err)) })
      subprocess.on("exit", (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timer)
          resume(Effect.fail(new Error(`Browser open failed with exit code ${code}`)))
        }
      })
    }),
  ),
  Effect.catch(() => {
    log.warn("failed to open browser, user must open URL manually", { mcpName })
    return bus.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)
  }),
)
```

`opencode mcp auth` CLI 订阅 `MCP.BrowserOpenFailed`（`cli/cmd/mcp.ts:259-266`），收到时打印 URL 让用户手动复制。

---

## 7. MCP tools 注入

### 7.1 listTools 容错

`mcp/index.ts:128-155` 的 `listTools()` 做了一件预先没料到的事：

```ts
function listTools(key, client, timeout) {
  return Effect.tryPromise({ try: () => client.listTools(undefined, { timeout }) }).pipe(
    Effect.map((result) => result.tools),
    Effect.catch((error) => {
      if (!isOutputSchemaValidationError(error)) return Effect.fail(error)
      log.warn("failed to validate MCP tool output schemas, retrying without output schema validation", { key })
      return Effect.tryPromise({
        try: () => client.request({ method: "tools/list" }, TolerantListToolsResultSchema, { timeout }),
      }).pipe(Effect.map((result) => result.tools.map((tool) => ({
        name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
      }))))
    }),
  )
}
```

`isOutputSchemaValidationError`（`mcp/index.ts:122-126`）通过正则识别 SDK 抛的"无法解析的 outputSchema"——某些服务器声明的 outputSchema 引用了无法解析的 JSON Schema $ref。这种情况下 opencode 不直接放弃这个服务器，而是用 `TolerantListToolsResultSchema`（`mcp/index.ts:38-40`，去掉 outputSchema 校验）重试，让工具能用但不校验输出 schema。这是真实野外环境里碰到的容错。

### 7.2 convertMcpTool：转给 AI SDK

每个 MCP tool 要变成 AI SDK 的 `Tool` 对象，才能传给 LLM 厂商 SDK。`mcp/index.ts:158-186`：

```ts
function convertMcpTool(mcpTool: MCPToolDef, client: MCPClient, timeout?: number): Tool {
  const inputSchema = mcpTool.inputSchema
  const schema: JSONSchema7 = {
    ...(inputSchema as JSONSchema7),
    type: "object",
    properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,  // 拒绝模型乱传未定义参数
  }
  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(schema),
    execute: async (args: unknown) => {
      return client.callTool(
        { name: mcpTool.name, arguments: (args || {}) as Record<string, unknown> },
        CallToolResultSchema,
        { resetTimeoutOnProgress: true, timeout },
      )
    },
  })
}
```

`dynamicTool()` 是 AI SDK 提供的工厂，让一个跟 LLM 厂商无关的 tool 在 SDK 内被转成各厂商对应的 function-calling schema。`resetTimeoutOnProgress: true` 表示 MCP 服务器只要发出进度通知就重置超时计时器——长任务（爬虫、大文件分析）需要这个。

### 7.3 命名空间防冲突

两个不同的 MCP 服务器都有一个叫 `search` 的工具怎么办？`mcp/index.ts:115` + `:690`：

```ts
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")

// 在 tools() 中:
result[sanitize(clientName) + "_" + sanitize(mcpTool.name)] = convertMcpTool(mcpTool, client, timeout)
```

所有 MCP 工具都加上 `<server>_` 前缀，LLM 看到的工具名是 `github_create_issue`、`filesystem_read_file` 这种形式。`sanitize` 把任何非 `[a-zA-Z0-9_-]` 字符替换成下划线——服务器名里有冒号、点也无碍。

### 7.4 跟内建工具混合

`tools()` 返回的 `Record<string, Tool>` 不直接喂给 LLM。Tool registry（详见第 04 章）会把它跟 ToolRegistry 自己的内建工具合并：

```
Tool Registry
   ├─ 内建：read, write, edit, bash, glob, grep, websearch, agent, skill, ...
   └─ MCP-derived：filesystem_read_file, github_create_issue, ...
                   ↑ MCP.Service.tools() 拿到的所有
```

Agent runner 每轮把 registry 序列化进 LLM 请求，工具的 `execute()` 已经被 closure 绑到对应 `MCPClient.callTool` 上，调用一气呵成。

---

## 8. ToolsChanged 事件：动态工具表

MCP 协议允许服务器在线增删工具（典型场景：MCP 服务器后端有动态插件，加载/卸载时通知客户端）。`mcp/index.ts:508-520` 的 `watch()` 订阅 SDK 的通知：

```ts
function watch(s: State, name: string, client: MCPClient, bridge, timeout?: number) {
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    log.info("tools list changed notification received", { server: name })
    if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

    const listed = await bridge.promise(defs(name, client, timeout))
    if (!listed) return
    if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

    s.defs[name] = listed
    await bridge.promise(bus.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
  })
}
```

注意两次"client 是否还是同一个"的检查——这是防止重连过程中老 client 的延迟通知污染新 client 的状态。

`ToolsChanged` 事件（`mcp/index.ts:51-56`）通过 Bus 发出去，TUI 侧的 MCP 边栏（`packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/mcp.tsx`）订阅它来刷新展示。

---

## 9. `opencode mcp` CLI

`packages/opencode/src/cli/cmd/mcp.ts` 提供五个子命令：

```
opencode mcp
  ├─ add       新增 MCP server 到配置文件（交互式问询）
  ├─ list      列出已配置的 MCP server 及连接状态
  ├─ auth      启动 OAuth 授权流（子命令 list 列已支持 OAuth 的 server）
  ├─ logout    删除某个 server 存储的 OAuth 凭据
  └─ debug     不连 SDK，直接 fetch 测试，输出 HTTP/OAuth 诊断信息
```

### 9.1 add：交互式向导

`McpAddCommand`（`cli/cmd/mcp.ts:433-595`）用 `@clack/prompts` 跟用户交互。流程：

1. 决定写到哪里（项目级 `.opencode/opencode.json` vs 全局 `~/.config/opencode/opencode.json`，依据当前是不是 git 仓库决定要不要问）
2. 服务器名
3. 类型：local / remote
4. local: 命令行
5. remote: URL → 是否 OAuth → 是否已有 clientId → clientSecret
6. 用 `jsonc-parser` 的 `modify()` 把新条目插进配置文件，保留注释和格式

写盘后不会自动重启连接——下次 opencode 进程重起或者 `opencode mcp connect <name>` 才生效。

### 9.2 list：状态总览

`McpListCommand`（`cli/cmd/mcp.ts:108-167`）的输出例子：

```
MCP Servers
│  ✓ github         connected (OAuth)
│      https://api.githubcopilot.com/mcp
│  ✗ filesystem     failed
│      ENOENT: command not found: @modelcontextprotocol/server-filesystem
│      bunx @modelcontextprotocol/server-filesystem /Users/me/code
│  ⚠ jira           needs authentication
│      https://jira.example.com/mcp
│  ○ exa            disabled
│      https://mcp.exa.ai/mcp
3 server(s)
```

`Status.status` 五个分支对应五种符号：`✓ ✗ ⚠ ○ ○`。`(OAuth)` 后缀表示用了 OAuth 且 token 已存。

### 9.3 auth：OAuth 流

`McpAuthCommand`（`cli/cmd/mcp.ts:169-308`）的关键代码：

```ts
const spinner = prompts.spinner()
spinner.start("Starting OAuth flow...")

const unsubscribe = Bus.subscribe(MCP.BrowserOpenFailed, (evt) => {
  if (evt.properties.mcpName === serverName) {
    spinner.stop("Could not open browser automatically")
    prompts.log.warn("Please open this URL in your browser to authenticate:")
    prompts.log.info(evt.properties.url)
    spinner.start("Waiting for authorization...")
  }
})

yield* MCP.Service.use((mcp) => mcp.authenticate(serverName)).pipe(
  Effect.tap((status) => Effect.sync(() => {
    if (status.status === "connected") spinner.stop("Authentication successful!")
    else if (status.status === "needs_client_registration") {
      spinner.stop("Authentication failed", 1)
      prompts.log.error(status.error)
      prompts.log.info("Add clientId to your MCP server config:")
      // ... 打印示例
    } else if (status.status === "failed") {
      spinner.stop("Authentication failed", 1)
      prompts.log.error(status.error)
    }
  })),
  Effect.catchCause((cause) => /* ... */),
  Effect.ensuring(Effect.sync(() => unsubscribe())),
)
```

`Bus.subscribe(MCP.BrowserOpenFailed, ...)` 是浏览器开不起来时的逃生路径——CLI 收到事件就把 URL 直接打到 stdout 给用户复制。

### 9.4 debug：低层诊断

`McpDebugCommand`（`cli/cmd/mcp.ts:597-774`）跳过 SDK 直接发 `initialize` JSON-RPC：

```ts
const response = await fetch(serverConfig.url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "opencode-debug", version: InstallationVersion },
    },
    id: 1,
  }),
})
```

然后报告：HTTP 状态码、`WWW-Authenticate` 头（OAuth metadata 发现端点）、是否需要动态注册、已有 token 是否还能用。这是在 SDK 自带错误消息让人看不懂时的最后求救通道。

### 9.5 logout

`McpLogoutCommand`（`cli/cmd/mcp.ts:340-396`）调 `MCP.Service.removeAuth(name)`：

```ts
const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName) {
  yield* auth.remove(mcpName)              // mcp-auth.json 里删条目
  McpOAuthCallback.cancelPending(mcpName)  // 如果还有进行中的回调等待，取消掉
  pendingOAuthTransports.delete(mcpName)
})
```

不会重新连接服务器——logout 之后服务器进入 `needs_auth` 状态等下次 auth。

---

## 10. MCP resources

MCP 的 resources 跟 tools 不同：tools 是 LLM 主动调，resources 是用户**预先附加到消息**的内容（一个文档、一个数据库表、一段 wiki）。`Resource` schema（`mcp/index.ts:42-49`）：

```ts
export const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
})
```

`MCP.Service.resources()`（`mcp/index.ts:716-719`）从所有 connected client 收集资源列表：

```ts
const resources = Effect.fn("MCP.resources")(function* () {
  const s = yield* InstanceState.get(state)
  return yield* collectFromConnected(s, (c) => c.listResources().then((r) => r.resources), "resources")
})
```

`collectFromConnected`（`mcp/index.ts:698-709`）会给资源加上 `<sanitized_client>:<sanitized_resource_name>` 前缀键。这跟 attachment（用户拖入聊天的本地文件）走的是另一条路——attachment 走 session/message 的 file part，MCP resource 走 `readResource(clientName, uri)` 实时从服务器拉。

`prompts` 同理（`mcp/index.ts:711-714`）。MCP server 暴露的 prompt 模板可以被 TUI 当成 slash command 暴露给用户，让用户一键拼一段含 LLM 上下文的 prompt。

---

## 11. mcp-websearch：协议复用的特例

`packages/opencode/src/tool/mcp-websearch.ts` 是一个有趣的 outlier：opencode 的内建 `websearch` 工具底下用的是 Exa 和 Parallel 提供的 MCP 服务器，但它不走完整 `MCP.Service` 那一套——它**手搓 HTTP 请求按 MCP 协议格式发**。

为什么？因为这两个搜索 API 本来就被官方包装成了 MCP server，但只用来做一件事（搜），没必要走完整的 client lifecycle。直接构造 JSON-RPC `tools/call`：

```ts
// tool/mcp-websearch.ts:58-67
const McpRequest = <F extends Schema.Struct.Fields>(args: Schema.Struct<F>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Literal(1),
    method: Schema.Literal("tools/call"),
    params: Schema.Struct({
      name: Schema.String,
      arguments: args,
    }),
  })
```

调用入口 `call()`（`tool/mcp-websearch.ts:69-96`）：

```ts
export const call = <F>(http, url, tool, args, value, timeout, headers?) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.accept("application/json, text/event-stream"),
      HttpClientRequest.setHeaders(headers ?? {}),
      HttpClientRequest.schemaBodyJson(McpRequest(args))({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: tool, arguments: value },
      }),
    )
    const response = yield* HttpClient.filterStatusOk(http).execute(request).pipe(
      Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(...) }),
    )
    const body = yield* response.text
    return yield* parseResponse(body)
  })
```

`parseResponse`（同文件 `:30-41`）处理两种回包：纯 JSON 或 SSE 流。SSE 那条线扫描每一行 `data: { ... }` 直到拿到含 `text` 的 content。

`tool/websearch.ts:60-97` 的 `callProvider()` 调用这个工厂：

```ts
function callProvider(http, provider, params, ctx) {
  if (provider === "parallel") {
    return McpWebSearch.call(http, McpWebSearch.PARALLEL_URL, "web_search",
      McpWebSearch.ParallelSearchArgs,
      { objective: params.query, search_queries: [params.query], session_id: ctx.sessionID, model_name: ... },
      "25 seconds", parallelAuthHeaders())
  }
  return McpWebSearch.call(http, McpWebSearch.EXA_URL, "web_search_exa",
    McpWebSearch.SearchArgs,
    { query: params.query, type: params.type || "auto", numResults: ..., livecrawl: ..., contextMaxCharacters: ... },
    "25 seconds")
}
```

这是 MCP 作为协议被理解为"调用约定"的好处：服务端不在意你怎么实现客户端，只要请求长得像 MCP。opencode 在这里选择了轻量 HTTP，因为这个工具不需要保持长连接也不需要订阅工具变更通知。

---

## 12. opencode 作为 MCP server？

简短答：**v1.15.10 不暴露自己作为 MCP server**。

证据：

```
$ grep -rn '@modelcontextprotocol/sdk/server' /Users/xgliu/git/opencode/packages 2>/dev/null
# 无结果
```

`packages/extensions/` 和 `packages/console/` 都没有引入 MCP server SDK。`sdk/js/src/v2/gen/types.gen.ts` 里出现的 `McpServerNotFoundError` 是 **opencode HTTP API 在 MCP 客户端那一侧的错误码**——表示"在 opencode 配置里找不到名为 X 的 MCP server"，不是"opencode 自己作为服务器找不到"。

为什么不做？合理的设计取舍：opencode 已经通过自己的 HTTP API（`packages/opencode/src/server/`）和 `@opencode-ai/sdk` 暴露完整能力，外部 LLM 客户端如果要"调用 opencode"已经有更直接的 SDK 路径。MCP server 多一层协议适配，没有立竿见影的好处。

唯一接近 MCP server 角色的场景是 `command: ["opencode", ...]` 当 local MCP 服务器跑——但这里 opencode 子进程的角色是被另一个 opencode 实例当 worker，不是真把 MCP server SDK 起起来。`mcp/index.ts:434` 的 `BUN_BE_BUN=1` 暗示了这个使用模式，但具体怎么 spawn 取决于子命令实现。

---

## 13. 边界与限制

| 限制 | 现状 | 设计取舍 |
| --- | --- | --- |
| stdio 子进程清理 | Windows 下不杀孙子进程 | `pgrep -P` 只在 unix 用 |
| 多 opencode 实例 | 共享同一台机器的 OAuth 回调端口 | 第二实例如果端口被占就跳过自起，但回调可能误投递到错的实例 |
| OAuth scope 默认空 | 由服务器决定 | 用户可在 `oauth.scope` 显式声明 |
| token 加密 | 文件权限 0o600 但不加密 | 系统级权限隔离 |
| MCP server 反向暴露 | 不支持 | opencode 已有 HTTP API/SDK 替代 |
| tools/list_changed 频次 | 由服务器决定 | 客户端只刷新 defs，不广播给 chat loop 中途 |
| resource MIME | 透传 | 实际渲染由消息附件层决定 |

---

## 14. 跟其他章节的关系

- 第 03 章 配置系统：`mcp` 字段在 Config schema 中的位置，以及 Schema 校验流程。
- 第 04 章 工具系统：MCP tools 如何被 Tool registry 合并、传给 LLM。
- 第 05 章 Agent 主循环：tools() 何时被调用、`ToolsChanged` 事件如何被消费。
- 第 12 章 插件系统：插件是进程内 JS，MCP 是跨进程协议——本章末尾对比的反面。
- 第 13 章 鉴权：MCP OAuth 跟 opencode 主鉴权机制（`auth.ts`）是独立的两套，但凭据存储路径都在 `Global.Path.data`。

---

## 15. 一句话总结

opencode 把 MCP 当成"工具来源"用：每个 server 是一个 `MCPClient` 实例，启动时按状态机管理（connected / needs_auth / failed / disabled / needs_client_registration），工具按 `<server>_<tool>` 命名空间注入到全局 Tool 表；OAuth 用本地 callback server 接住 redirect，凭据按 server name + url 双键存于 `~/.local/share/opencode/mcp-auth.json`；`websearch` 工具是协议复用的极简特例。
