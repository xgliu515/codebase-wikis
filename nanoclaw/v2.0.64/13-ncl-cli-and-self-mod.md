## ncl CLI 与 self-modification

NanoClaw 是一个长生命周期的多进程系统：一个 host 进程加上每个 session 一个容器。所有"管理面"的写操作都必须落到中央 DB `data/v2.db`，而这张 DB 只允许 host 进程作为唯一 writer。

那 admin 怎么在 shell 里直接 `list/get/create/update/delete` agent_groups、wirings、roles？容器里跑的 agent 怎么 `ncl groups config get` 看自己的配置、`ncl groups restart` 重启自己、甚至 `install_packages` 改造自己的镜像？

这一章把这两件事讲完：

1. **`ncl` CLI** ——`bin/ncl` 是 host shell 直接调用的入口；`container/agent-runner/src/cli/ncl.ts` 是容器内同名 binary，但走完全不同的 transport。两者用同一个 frame 协议、同一个 dispatcher、同一套 resource 定义。
2. **Self-modification** ——`install_packages` 和 `add_mcp_server` 两个 MCP tool 让 agent 可以请求装包 / 加 MCP server。审批由 admin 完成，应用动作（改 DB、rebuild 镜像、kill 容器、写 on_wake 消息、wakeContainer）全部在 host 侧的 approval handler 里发生。

两个特性放一章是因为：self-modification 实质上是 `ncl groups config` 的特殊形态（自动审批 + 自动 rebuild + 自动 restart），而 admin 用 `ncl groups restart --rebuild` 手动做的事，正是 self-mod approval handler 自动做的事。理解了 ncl 就理解了 self-mod。

---

### 1. 设计问题

admin 需要随时改这些东西：

| 资源 | 谁写、为何写 |
|------|------------|
| `agent_groups` | 加一个新 agent；改 personality、模型、effort |
| `messaging_groups` | 新接入一个 Telegram 群；改 `unknown_sender_policy` |
| `messaging_group_agents`（wirings） | 把一个 Discord channel 接到某个 agent，配 engage_mode |
| `users` + `user_roles` | 把某个 Telegram 用户标为 owner / admin |
| `agent_group_members` | 把某个用户加入"已知用户"白名单 |
| `agent_destinations` | 给 agent 加一个 send_message 目标 |
| `container_configs` | 改容器配置（provider、model、mcp_servers、packages_apt、cli_scope...） |

这些写操作必须满足三条硬约束：

**约束 A：唯一 writer**。整个系统对 `data/v2.db` 只许有一个 writer——host 进程。容器没挂这个文件、外部脚本不许直接打开。原因见第 4 章"两 DB 分离"。所以 admin 不能在 shell 里直接 `sqlite3 data/v2.db "INSERT INTO ..."`——会破坏 WAL 一致性、绕过缓存、绕过校验。

**约束 B：容器内可见**。容器里跑的 agent 也需要看（甚至改）自己的配置：
- "我现在的模型是什么？"——`ncl groups config get`
- "把我重启一下，我刚装好的工具应该生效"——`ncl groups restart`
- "我刚意识到需要 `ripgrep`"——通过 self-mod 走 admin approval
- "我有几个 sub-session 在跑？"——`ncl sessions list`

但容器没挂 `v2.db`。它能用的只有 inbound.db / outbound.db / outbox/ 三个挂载点。所以 transport 必须能用 session DB 做。

**约束 C：scope 与 audit**。
- 不是所有 admin 都能改所有 group——CLAUDE.md 里有 owner / global admin / scoped admin 三档。
- 容器里跑的 agent 默认只能看到自己的 group——一个 PR Review agent 不该能 `ncl groups list` 看到所有 group 的 ID，更不该能 update 别人的 wiring。
- 危险操作（create / update / delete）即使是 admin 走容器调用，也要走 approval 流程。

---

### 2. 几个直觉答案，逐一不够

#### 2.1 直觉一："让 admin 用 sqlite3 CLI 直接改 v2.db"

最朴素：装个 `sqlite3` 命令，admin 自己写 SQL。

为什么不够：
- 破坏唯一-writer 不变量：host 进程长时间持有 better-sqlite3 句柄，外部 writer 会和它 lock 竞争、损坏 WAL。
- 没有约束校验：插一行 `messaging_group_agents` 不会自动创建 destination；改 `cli_scope` 没有 enum 检查。
- 没法在容器里用：容器没挂 `v2.db`。
- 没有 audit / approval。

#### 2.2 直觉二："起一个 HTTP admin API"

让 host 暴露 `POST /admin/groups`，admin 用 `curl` 或前端调。

为什么不够：
- 攻击面：HTTP server 要 bind 端口，要做 auth（cookie? token? mTLS?），要做 rate limit。
- 容器内调用要解决"怎么发现 host 的地址" / 网络命名空间问题。
- 对 shell 工作流不友好：admin 要 `jq` + `curl` 拼。

#### 2.3 直觉三："admin 命令直接以子进程方式调 host 的 TS 代码"

`pnpm exec tsx scripts/list-groups.ts`——admin 跑一个独立的 Node 进程，它 `import` host 的 db 模块、直接调函数。

为什么不够：
- 还是会和 host 长持有的 DB 句柄打架。
- 启动慢：每次都要 tsx + 重建 better-sqlite3 native binding。
- 容器里没 Node、只有 Bun，import host 代码不可能。
- 没有 approval：admin 调用就直接 commit。

#### 2.4 直觉四（也是答案）："host 起一个本地 IPC server；ncl 是它的客户端"

让 host 进程：
- 监听一个 Unix socket，chmod 0600（同 UID 才能连）
- 接受 line-delimited JSON frame
- 一个 frame = 一次"调 dispatcher"
- dispatcher 查 registry 找命令、跑 handler、把结果序列化回写

`bin/ncl` 是 shell 工具，从 argv 拼出 frame，写 socket，读响应，formatHuman 后退出。

这样 host 仍然是唯一 writer——`ncl` 只是把 frame 推过去而已。socket 0600 + 同 UID 是天然 auth boundary。同 dispatcher 同 registry 同 handler 可以同时被："host 经 socket 调"和"容器经 session DB 调"两条路复用。

剩下的问题：**容器里怎么调？** 容器没法连 host 的 Unix socket（socket 没挂进来）。但容器有 outbound.db / inbound.db 可以写读。所以——

让 container 里的 `ncl` 把 frame 写进 outbound.db 当作一条 `kind='system'` 消息（`content.action = 'cli_request'`），轮询 inbound.db 等 host 投回来的 `cli_response`。

这就是最终方案。

---

### 3. 总体架构

<svg viewBox="0 0 860 560" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ncl architecture: admin shell uses unix socket; container uses outbound/inbound DB transport; both reach the same dispatcher and v2.db">
  <defs>
    <marker id="r13a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="20" y="14" width="820" height="296" rx="8" fill="#ecfeff" stroke="#0d9488" stroke-width="1.5"/>
  <text x="34" y="34" font-size="13" font-weight="700" fill="#0d9488">host process (Node, sole writer of v2.db)</text>
  <rect x="40" y="46" width="120" height="38" rx="5" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="100" y="62" font-size="11" font-weight="600" text-anchor="middle" fill="currentColor">admin shell</text>
  <text x="100" y="78" font-size="10" text-anchor="middle" fill="#64748b">bin/ncl</text>
  <rect x="200" y="46" width="160" height="38" rx="5" fill="#ffffff" stroke="#0d9488" stroke-width="1"/>
  <text x="280" y="62" font-size="11" font-weight="600" text-anchor="middle" fill="currentColor">data/ncl.sock</text>
  <text x="280" y="78" font-size="10" text-anchor="middle" fill="#dc2626">UDS, chmod 0600</text>
  <rect x="400" y="46" width="160" height="38" rx="5" fill="#ffffff" stroke="#0d9488" stroke-width="1"/>
  <text x="480" y="62" font-size="11" font-weight="600" text-anchor="middle" fill="currentColor">socket-server.ts</text>
  <text x="480" y="78" font-size="10" text-anchor="middle" fill="#64748b">ctx.caller = 'host'</text>
  <line x1="160" y1="65" x2="200" y2="65" stroke="#0ea5e9" stroke-width="1.5" marker-end="url(#r13a)"/>
  <line x1="360" y1="65" x2="400" y2="65" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13a)"/>
  <rect x="40" y="190" width="160" height="38" rx="5" fill="#ffffff" stroke="#0d9488" stroke-width="1"/>
  <text x="120" y="206" font-size="11" font-weight="600" text-anchor="middle" fill="currentColor">delivery.ts</text>
  <text x="120" y="222" font-size="10" text-anchor="middle" fill="#64748b">poll outbound.db</text>
  <rect x="40" y="240" width="160" height="38" rx="5" fill="#ffffff" stroke="#0d9488" stroke-width="1"/>
  <text x="120" y="256" font-size="11" font-weight="600" text-anchor="middle" fill="currentColor">cli_request action</text>
  <text x="120" y="272" font-size="10" text-anchor="middle" fill="#64748b">ctx.caller = 'agent'</text>
  <line x1="120" y1="228" x2="120" y2="240" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13a)"/>
  <rect x="280" y="118" width="280" height="46" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="420" y="138" font-size="13" font-weight="700" text-anchor="middle" fill="currentColor">dispatch.ts</text>
  <text x="420" y="155" font-size="10" text-anchor="middle" fill="#64748b">single router for both transports</text>
  <line x1="480" y1="84" x2="445" y2="118" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13a)"/>
  <line x1="200" y1="259" x2="395" y2="164" stroke="#ea580c" stroke-width="1.2" marker-end="url(#r13a)"/>
  <rect x="610" y="118" width="220" height="46" rx="6" fill="#ffffff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="720" y="138" font-size="11" font-weight="600" text-anchor="middle" fill="currentColor">registry</text>
  <text x="720" y="155" font-size="10" text-anchor="middle" fill="#64748b">CommandDef map</text>
  <line x1="560" y1="141" x2="610" y2="141" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13a)"/>
  <rect x="220" y="190" width="610" height="100" rx="6" fill="#fff7ed" stroke="#cbd5e1" stroke-width="1"/>
  <text x="234" y="208" font-size="11" font-weight="600" fill="currentColor">resources/ (each calls registerResource)</text>
  <text x="234" y="226" font-size="10" fill="#64748b">groups | wirings | users | roles | members | destinations | sessions | approvals | ...</text>
  <rect x="240" y="234" width="270" height="46" rx="5" fill="#ffffff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="375" y="252" font-size="11" font-weight="600" text-anchor="middle" fill="currentColor">crud.ts</text>
  <text x="375" y="268" font-size="10" text-anchor="middle" fill="#64748b">generic list/get/create/update/delete</text>
  <rect x="540" y="234" width="270" height="46" rx="5" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="675" y="252" font-size="11" font-weight="600" text-anchor="middle" fill="#7c3aed">data/v2.db (better-sqlite3)</text>
  <text x="675" y="268" font-size="10" text-anchor="middle" fill="#64748b">unique writer = host process</text>
  <line x1="510" y1="257" x2="540" y2="257" stroke="#7c3aed" stroke-width="1.2" marker-end="url(#r13a)"/>
  <rect x="20" y="324" width="820" height="50" rx="8" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="34" y="344" font-size="12" font-weight="700" fill="#7c3aed">data/v2-sessions/&lt;sid&gt;/</text>
  <text x="220" y="344" font-size="11" fill="currentColor">inbound.db (host → container)</text>
  <text x="500" y="344" font-size="11" fill="currentColor">outbound.db (container → host)</text>
  <text x="34" y="362" font-size="10" fill="#64748b">cross-mount transport; journal_mode = DELETE (no WAL)</text>
  <line x1="120" y1="278" x2="120" y2="324" stroke="#7c3aed" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r13a)"/>
  <text x="130" y="304" font-size="10" fill="#7c3aed">write cli_response to inbound.db (trigger=0)</text>
  <rect x="20" y="388" width="820" height="160" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/>
  <text x="34" y="408" font-size="13" font-weight="700" fill="#ea580c">container &lt;sid&gt; (Bun)</text>
  <rect x="40" y="420" width="380" height="62" rx="5" fill="#ffffff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="50" y="438" font-size="11" font-weight="600" fill="currentColor">ncl (bun, standalone)</text>
  <text x="50" y="454" font-size="10" fill="#64748b">write cli_request → outbound.db</text>
  <text x="50" y="468" font-size="10" fill="#64748b">poll inbound.db every 500ms (LIKE requestId)</text>
  <rect x="440" y="420" width="380" height="62" rx="5" fill="#ffffff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="450" y="438" font-size="11" font-weight="600" fill="currentColor">MCP tools self-mod</text>
  <text x="450" y="454" font-size="10" fill="#64748b">install_packages → outbound.db</text>
  <text x="450" y="468" font-size="10" fill="#64748b">add_mcp_server → outbound.db (fire-and-forget)</text>
  <line x1="230" y1="482" x2="230" y2="510" stroke="#ea580c" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r13a)"/>
  <line x1="630" y1="482" x2="630" y2="510" stroke="#ea580c" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r13a)"/>
  <text x="240" y="500" font-size="10" fill="#ea580c">write kind='system' frame</text>
  <text x="640" y="500" font-size="10" fill="#ea580c">write self-mod request</text>
  <text x="34" y="538" font-size="10" fill="#64748b">no v2.db mount — all admin-plane writes must round-trip via host</text>
</svg>
<span class="figure-caption">图 R13.1 ｜ ncl 双 transport 架构：admin shell 走 UDS、容器走 inbound/outbound DB，两条路汇到同一个 dispatch.ts + registry + v2.db。</span>

<details>
<summary>ASCII 原版</summary>

```
┌────────────────────────────────────────────────────────────────┐
│                     host process                                │
│                                                                  │
│   bin/ncl ──→ data/ncl.sock (UDS, 0600) ──→ socket-server.ts    │
│      ▲                                            │              │
│      │ shell                                      ▼              │
│ admin │                                       dispatch.ts        │
│      │                                            │              │
│      │                                            ▼              │
│      │                                       registry            │
│      │                                            │              │
│      │              ┌─────────────────────────────┼────────┐    │
│      │              │ resources/                  │        │    │
│      │              │ groups | wirings | users |  │        │    │
│      │              │ roles | members | dest |    │        │    │
│      │              │ sessions | approvals | ...  ▼        │    │
│      │              │           crud.ts (generic CRUD)     │    │
│      │              │           v2.db (better-sqlite3)     │    │
│      │              └──────────────────────────────────────┘    │
│      │                                            ▲              │
│      └─── delivery.ts polls outbound.db ──────────┤              │
│           sees cli_request → dispatcher           │              │
│           writes cli_response to inbound.db       │              │
└───────────────────────────────────────┬───────────┘              │
                                         │ host writes ▲           │
                                         ▼             │           │
                          ┌──────────────────────────────────┐    │
                          │  data/v2-sessions/<sid>/         │    │
                          │     inbound.db (host→container)  │    │
                          │     outbound.db (container→host) │    │
                          └──────────────────────────────────┘    │
                                         ▲ container reads/writes ▲
                                         │             │
┌────────────────────────────────────────────────────┐ │
│                container <sid>                      │ │
│                                                     │ │
│     ncl (bun) ──── writes cli_request to outbound.db│ │
│                  └─ polls inbound.db for response   │ │
│                                                     │ │
│  MCP tools install_packages / add_mcp_server        │ │
│       └── writes self_mod_request to outbound.db    │ │
└─────────────────────────────────────────────────────┘ │
                                                        │
```

</details>

两点关键：
- 同一个 `dispatch(req, ctx)` 函数被两种 transport 调。`ctx.caller` 是 `'host'`（来自 socket）或 `'agent'`（来自 delivery）——这是 dispatcher 唯一需要分辨的事。
- "agent 把 frame 写进 outbound.db" 这条路本身就走 NanoClaw 的标准消息表面（第 7 章 delivery loop）。delivery.ts 收到 `kind='system'` + `action='cli_request'` 的消息时，调注册过的 delivery action handler——也就是 `src/cli/delivery-action.ts`。

---

### 4. Host 侧：socket transport

#### 4.1 socket-server.ts

`src/cli/socket-server.ts:20` 启动监听。socket path 是 `path.join(DATA_DIR, 'ncl.sock')`——和聊天用的 `data/cli.sock`（admin 用聊天接口 DM agent 的那条 channel）是两个不同文件。

注意 chmod：

```ts
// src/cli/socket-server.ts:36-44
s.listen(socketPath, () => {
  try {
    fs.chmodSync(socketPath, 0o600);
  } catch (err) {
    log.warn('Failed to chmod ncl socket (continuing)', { socketPath, err });
  }
  log.info('ncl CLI server listening', { socketPath });
  resolve();
});
```

`0600` 表示只有 owner 能 read/write。host 进程跑在哪个 UID 下，shell 也必须以同 UID 启动才能连——这就是整个 auth 模型。`socket-server.ts:93` 把这个判断写得直白：

```ts
// Host caller — connecting to data/ncl.sock requires file-system access
// to a 0600 socket owned by the host user, so we treat the socket path
// itself as the auth boundary.
const ctx: CallerContext = { caller: 'host' };
```

收到一行就 JSON.parse，验证 frame 形状（`isRequestFrame`），调 `dispatch(req, ctx)`，把响应 frame 写回，end 连接。

stale socket 清理在 `socket-server.ts:23-30`——上次 host crash 留下的 socket file，启动时先 unlink，因为 `net.createServer.listen` 拒绝 bind 到已存在的 path。

#### 4.2 socket-client.ts

`src/cli/socket-client.ts:17` 是 `SocketTransport` class，给 `bin/ncl` 用：

```ts
// src/cli/socket-client.ts:38-42
client.on('connect', () => {
  client.write(JSON.stringify(req) + '\n');
});
```

一连接就写完整个 frame + `\n`，然后读响应、resolve。一连接一个 frame、一个响应。简单到极致。

#### 4.3 client.ts —— bin/ncl

`src/cli/client.ts` 是 `bin/ncl` 的实际入口。流程：

1. `argv` 分两部分：positional 和 `--key value` flag。`--json` 是特殊 flag，决定输出 human 还是 JSON。
2. positional 用 `-` 拼成 command：`ncl groups get abc123` → `"groups-get-abc123"`。dispatcher 那边会自动把尾巴 `abc123` 抽出来当作 `--id`（见 §5.1 fallback）。
3. 加 `randomUUID()` 作为 frame id。
4. `pickTransport()` 选 `SocketTransport`（容器里换成 DB transport，但 host 上永远是 socket）。
5. `transport.sendFrame(req)` 拿响应，`formatResponse(res, json ? 'json' : 'human')` 输出。
6. `process.exit(res.ok ? 0 : 1)`——失败的 frame 也是 exit 1，admin shell 脚本可以判断。

---

### 5. Dispatcher：唯一的"路由 + 鉴权"中心

`src/cli/dispatch.ts:17` 的 `dispatch(req, ctx)` 函数干六件事：

1. 在 registry 里查 `cmd = lookup(req.command)`。
2. 如果没查到，尝试 fallback：把最后一段 `-xxx` 抽出来当 id，再查一次。
3. 如果 caller 是 agent，跑 `cli_scope` 检查（见 §6）。
4. 如果命令的 `access === 'approval'` 且 caller 是 agent，发起 approval 流程，立即返回 `approval-pending` 错误。
5. 跑 `cmd.parseArgs(req.args)` 做参数校验。
6. 跑 `cmd.handler(parsed, ctx)`，结果裹进 `{ok: true, data}` 返回；异常裹进 `{ok: false, error}` 返回。

#### 5.1 Fallback：把 `groups get abc123` 当 `groups-get --id abc123`

```ts
// src/cli/dispatch.ts:23-36
if (!cmd) {
  const idx = req.command.lastIndexOf('-');
  if (idx > 0) {
    const shortened = req.command.slice(0, idx);
    const tail = req.command.slice(idx + 1);
    const fallback = lookup(shortened);
    if (fallback) {
      cmd = fallback;
      req = { ...req, command: shortened, args: { ...req.args, id: req.args.id ?? tail } };
    }
  }
}
```

这就是为什么 `ncl groups get abc123` 能 work。client 把 `["groups","get","abc123"]` 用 `-` 拼成 `"groups-get-abc123"`，registry 里只有 `groups-get`，fallback 把尾巴 `abc123` 当作 `--id` 注入。简单粗暴。

#### 5.2 Frame 协议

`src/cli/frame.ts` 定义请求/响应：

```ts
// src/cli/frame.ts:11-18
export type RequestFrame = {
  /** Correlation key set by the client. */
  id: string;
  /** Registry name, e.g. "list-groups". */
  command: string;
  /** Command-specific. Each command's parseArgs validates. */
  args: Record<string, unknown>;
};

// src/cli/frame.ts:20-22
export type ResponseFrame =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { code: ErrorCode; message: string } };
```

错误码（`src/cli/frame.ts:24-32`）：

| code | 何时返回 |
|------|---------|
| `unknown-command` | registry 里没有这个 command 名 |
| `invalid-args` | parseArgs throw（missing required / enum 不匹配） |
| `permission-denied` | 预留，目前未使用 |
| `forbidden` | cli_scope 拒绝（agent 越权访问其他 group / 改 cli_scope） |
| `approval-pending` | agent 调用了 access='approval' 命令，已发审批卡 |
| `not-found` | 当前预留 |
| `handler-error` | handler throw（DB 错误、找不到记录） |
| `transport-error` | frame 解析失败 |

`CallerContext`（`frame.ts:38-45`）很关键——它是 dispatcher 唯一拿来分辨 caller 的依据，**不携带在 frame 里**：

```ts
export type CallerContext =
  | { caller: 'host' }
  | {
      caller: 'agent';
      sessionId: string;
      agentGroupId: string;
      messagingGroupId: string;
    };
```

host 调时由 socket-server 注入 `{caller:'host'}`；agent 调时由 delivery-action 注入完整身份。客户端伪造 caller 不可能——因为 caller 字段不来自 frame。

---

### 6. cli_scope：容器内 agent 的三档限制

`container_configs.cli_scope` 是个 string 列，三个合法值：

| 值 | 行为 |
|----|------|
| `disabled` | agent 完全看不到 ncl。CLAUDE.md 里不合成 `cli.instructions.md` 指引，host dispatch 主动拒绝 `cli_request` |
| `group`（默认） | agent 只能访问 `groups` / `sessions` / `destinations` / `members` 四个 resource，且强制 scope 到自己的 agent_group |
| `global` | 无限制。由 `init-first-agent` 自动给 owner agent group 设置 |

#### 6.1 `disabled`：从 CLAUDE.md 移除指引

`src/claude-md-compose.ts:82-90`：

```ts
// Skip cli.instructions.md when cli_scope is disabled.
const cliDisabled = configRow?.cli_scope === 'disabled';
const mcpToolsHostDir = path.join(process.cwd(), MCP_TOOLS_HOST_SUBPATH);
if (fs.existsSync(mcpToolsHostDir)) {
  for (const entry of fs.readdirSync(mcpToolsHostDir)) {
    const match = entry.match(/^(.+)\.instructions\.md$/);
    if (!match) continue;
    const moduleName = match[1];
    if (moduleName === 'cli' && cliDisabled) continue;
    // ...
```

`cli.instructions.md` 是教 agent "怎么用 ncl"的指引。当 `cli_scope=disabled` 时根本不合进 CLAUDE.md——agent 没读过这套指引，自然不会主动调。即便它"碰巧"知道存在 ncl 工具想试一下，host 端 dispatcher 也会拒绝（见 §6.3）。这是 belt-and-suspenders。

#### 6.2 `group`：四 resource 白名单 + 自动 scope

dispatcher 里的完整检查链（`src/cli/dispatch.ts:42-101`）：

```ts
if (ctx.caller === 'agent') {
  const configRow = getContainerConfig(ctx.agentGroupId);
  const cliScope = configRow?.cli_scope ?? 'group';

  if (cliScope === 'disabled') {
    return err(req.id, 'forbidden', 'CLI access is disabled for this agent group.');
  }

  if (cliScope === 'group') {
    const allowed = new Set(['groups', 'sessions', 'destinations', 'members']);
    if (cmd.resource && !allowed.has(cmd.resource)) {
      return err(req.id, 'forbidden', `CLI access is scoped to this agent group. Cannot access "${cmd.resource}".`);
    }
    // ... 见后续
  }
}
```

白名单四个 resource 是 group-scoped agent 唯一能碰的：
- `groups`：看 / 改自己的 agent group 配置
- `sessions`：看自己 agent group 里有哪些 session（不能看 messaging-group 信息，因为那是其他用户的 ID）
- `destinations`：看 / 加自己 agent group 的 send_message 目标（实际加要 approval）
- `members`：看 / 加自己 agent group 的 member（实际加要 approval）

**自动 scope**：

```ts
// src/cli/dispatch.ts:80-90
const fill: Record<string, unknown> = {
  agent_group_id: req.args.agent_group_id ?? ctx.agentGroupId,
  group: req.args.group ?? ctx.agentGroupId,
};
if (cmd.resource === 'groups' || cmd.resource === 'destinations') {
  fill.id = req.args.id ?? ctx.agentGroupId;
}
req = { ...req, args: { ...req.args, ...fill } };
```

agent 不用写 `--id`、`--group`、`--agent-group-id`——dispatcher 自动填成 caller 自己的 `agentGroupId`。所以 agent 一句 `ncl groups config get` 就能拿到自己的配置；要拿别人的它会被前面那段 cross-group 检查（`dispatch.ts:65-72`）挡掉。

**阻断 cli_scope 自提权**：

```ts
// src/cli/dispatch.ts:75-77
if (req.args.cli_scope !== undefined || req.args['cli-scope'] !== undefined) {
  return err(req.id, 'forbidden', 'Cannot change cli_scope from a group-scoped agent.');
}
```

group-scoped agent 不能把自己改成 `global`——这是 fail-closed 的最后一道闸。

**Post-handler 二次过滤**：generic 的 list / get handler 返回原始 DB 行，但 group-scoped agent 不能看到属于其他 group 的行。`dispatch.ts:150-173` 做后置过滤：

```ts
if (ctx.caller === 'agent' && cmd.resource && cmd.generic) {
  const configRow = getContainerConfig(ctx.agentGroupId);
  if ((configRow?.cli_scope ?? 'group') === 'group') {
    const def = getResource(cmd.resource);
    const groupField = def?.scopeField;
    if (!groupField) {
      return err(req.id, 'forbidden', `"${cmd.resource}" is not available in group scope.`);
    }
    if (Array.isArray(data)) {
      data = data.filter(
        (row) =>
          typeof row === 'object' &&
          row !== null &&
          (row as Record<string, unknown>)[groupField] === ctx.agentGroupId,
      );
    } else if (data && typeof data === 'object') {
      if ((data as Record<string, unknown>)[groupField] !== ctx.agentGroupId) {
        return err(req.id, 'forbidden', 'Resource belongs to a different agent group.');
      }
    }
  }
}
```

每个 ResourceDef 必须声明 `scopeField`：`groups` 的是 `id`、`sessions` 的是 `agent_group_id`、`members` 的是 `agent_group_id`、`destinations` 的是 `agent_group_id`。`scopeField` 没声明就 fail-closed。

**Existence-oracle 防护**：sessions-get 单独做了 pre-handler 检查（`dispatch.ts:96-100`），防止"通过返回的错误信息区分'session 不存在' vs 'session 存在但属于别人'"。统一返回 `not found`。

#### 6.3 `global`：仅限 owner

只有 `scripts/init-first-agent.ts` 在创建 owner agent group 时自动设这个值：

```ts
// scripts/init-first-agent.ts:235-236
// Owner's agent group gets global CLI access
updateContainerConfigScalars(ag.id, { cli_scope: 'global' });
```

global agent 跳过所有 cli_scope 检查（`dispatch.ts:42-102` 的整个 `if (cliScope === 'group')` 块）。它仍然受 `access === 'approval'` 限制——危险写操作还是要 approval。

---

### 7. Approval gate：access 等级

每个 CommandDef 有 `access: 'open' | 'approval' | 'hidden'`：

- `open`：直接跑。list / get 都是 open。
- `approval`：host caller 直接跑；agent caller 触发 approval 流程，立刻返回 `approval-pending`。
- `hidden`：保留，未使用。

approval 路径（`src/cli/dispatch.ts:104-126`）：

```ts
if (ctx.caller !== 'host' && cmd.access === 'approval') {
  const session = getSession(ctx.sessionId);
  if (!session) {
    return err(req.id, 'handler-error', 'Session not found.');
  }
  const agentGroup = getAgentGroup(ctx.agentGroupId);
  const agentName = agentGroup?.name ?? ctx.agentGroupId;

  const argSummary = Object.entries(req.args)
    .map(([k, v]) => `--${k} ${v}`)
    .join(' ');

  await requestApproval({
    session,
    agentName,
    action: 'cli_command',
    payload: { frame: { id: req.id, command: req.command, args: req.args } },
    title: `CLI: ${req.command}`,
    question: `Agent "${agentName}" wants to run:\n\`ncl ${req.command}${argSummary ? ' ' + argSummary : ''}\``,
  });

  return err(req.id, 'approval-pending', 'Approval request sent to admin. You will be notified of the result.');
}
```

agent 看到的是 `approval-pending` 错误——它的 `ncl ...` 命令"失败"了。但 dispatch.ts 末尾注册了一个 `cli_command` 的 approval handler：

```ts
// src/cli/dispatch.ts:181-191
registerApprovalHandler('cli_command', async ({ session, payload, userId, notify }) => {
  const frame = payload.frame as RequestFrame;
  const response = await dispatch(frame, { caller: 'host' });

  if (response.ok) {
    const data = typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2);
    notify(`Your \`ncl ${frame.command}\` request was approved and executed.\n\n${data}`);
  } else {
    notify(`Your \`ncl ${frame.command}\` request was approved but failed: ${response.error.message}`);
  }
});
```

admin 点 Approve 后，handler 用 `{caller:'host'}` 重新调一次 dispatch——这次绕过所有 `caller !== 'host'` 的检查、直接落到 handler——然后 `notify(...)` 把结果作为新消息写进 agent 的 inbound，告诉 agent "你的请求批了，结果是 ..."。

这就是为什么 dispatcher 是真正的"枢纽"：socket / DB transport 调它一次（拿到 approval-pending），admin 批准后 approval handler **再以 host 身份** 调它一次（拿到真结果）。

---

### 8. Resource 注册：registry + crud

#### 8.1 `registry.ts`

```ts
// src/cli/registry.ts:30-37
const registry = new Map<string, CommandDef>();

export function register<TArgs, TData>(def: CommandDef<TArgs, TData>): void {
  if (registry.has(def.name)) {
    throw new Error(`CLI command "${def.name}" already registered`);
  }
  registry.set(def.name, def as CommandDef);
}
```

进程启动时，`src/cli/resources/index.ts` import 每个 resource 文件，每个文件顶层调 `registerResource(...)`——所以 registry 在 host 接受第一个 ncl 连接之前就填好了。

`CommandDef` 关键字段：

```ts
// src/cli/registry.ts:12-28
export type CommandDef<TArgs = unknown, TData = unknown> = {
  name: string;
  description: string;
  access: Access;
  resource?: string;                            // 用于 help 分组、scope 检查
  generic?: 'list' | 'get';                     // generic 的会跑 post-handler 过滤
  parseArgs: (raw: Record<string, unknown>) => TArgs;
  handler: (args: TArgs, ctx: CallerContext) => Promise<TData>;
};
```

#### 8.2 `crud.ts`：一份声明，五个 generic verb

`registerResource(def)` 接受一个 `ResourceDef`，自动注册 `list` / `get` / `create` / `update` / `delete` 五个 generic CRUD command，外加 `customOperations` 里自定义的 verb。

```ts
// src/cli/crud.ts:44-72
export interface ResourceDef {
  name: string;        // 单数: 'group'
  plural: string;      // 复数: 'groups'
  table: string;
  description: string;
  idColumn: string;
  scopeField?: string;
  columns: ColumnDef[];
  operations: {
    list?: Access;
    get?: Access;
    create?: Access;
    update?: Access;
    delete?: Access;
  };
  customOperations?: Record<string, CustomOperation>;
}
```

每个 `ColumnDef` 描述一列：`type` / `description` / `generated`（自动生成，create 时不收用户输入）/ `required` / `updatable` / `default` / `enum`。这些 metadata 一身二用——既驱动 generic handler 的行为，也作为 `ncl <resource> help` 输出的文档来源。

`genericCreate` 的逻辑（`crud.ts:129-163`）：

```ts
for (const col of def.columns) {
  if (col.generated) {
    if (col.name === def.idColumn) {
      values[col.name] = randomUUID();
    } else if (col.name.endsWith('_at')) {
      values[col.name] = new Date().toISOString();
    }
    continue;
  }
  const v = args[col.name];
  if (v !== undefined) {
    if (col.enum && !col.enum.includes(String(v))) {
      throw new Error(`${col.name} must be one of: ${col.enum.join(', ')}`);
    }
    values[col.name] = col.type === 'number' ? Number(v) : v;
  } else if (col.required) {
    throw new Error(`--${col.name.replace(/_/g, '-')} is required`);
  } else if (col.default !== undefined) {
    values[col.name] = col.default;
  }
}
```

generated id 自动用 `randomUUID()`，`*_at` 列自动用当前时间，required 列缺了报错，enum 列校验值合法。然后拼 SQL `INSERT INTO ${def.table} ...` 执行。

`genericList` / `genericGet` / `genericUpdate` / `genericDelete` 同样从 metadata 派生，全在 `crud.ts:96-208`。

`normalizeArgs`（`crud.ts:214-220`）把 `--cli-scope` 转成 `cli_scope`、`--platform-id` 转成 `platform_id`——这样 admin 可以用 kebab-case flag，DB 列名保持 snake_case。

---

### 9. Resource verb 总表

CLAUDE.md "Admin CLI" 节给了简表，下面是从每个 `src/cli/resources/*.ts` 里读出来的完整 verb 集合。

| Resource | 标准 verbs | Custom verbs | 涉及表 |
|----------|------------|--------------|--------|
| `groups` | list / get / create(approval) / update(approval) / delete(approval) | `restart` / `config get` / `config update` / `config add-mcp-server` / `config remove-mcp-server` / `config add-package` / `config remove-package` | `agent_groups` + `container_configs` |
| `messaging-groups` | list / get / create(approval) / update(approval) / delete(approval) | — | `messaging_groups` |
| `wirings` | list / get / create(approval) / update(approval) / delete(approval) | — | `messaging_group_agents` |
| `users` | list / get / create(approval) / update(approval) | — | `users` |
| `roles` | list | `grant` / `revoke`（都 approval） | `user_roles` |
| `members` | list | `add` / `remove`（都 approval） | `agent_group_members` |
| `destinations` | list | `add` / `remove`（都 approval） | `agent_destinations` |
| `sessions` | list / get | — | `sessions` |
| `user-dms` | list | — | `user_dms` |
| `dropped-messages` | list | — | `dropped_messages` |
| `approvals` | list / get | — | `pending_approvals` |

所有 list / get 都是 open（host caller 直接跑、agent caller 受 cli_scope 过滤）。所有写操作（create/update/delete/restart/grant/revoke/add/remove/config update/config add-/remove-mcp-server/config add-/remove-package）都是 approval——host caller 直接执行，agent caller 走 approval 流程。

#### 9.1 `groups` 的 custom verbs

`src/cli/resources/groups.ts` 是最复杂的 resource，因为 `agent_groups` 行只是"逻辑标识"，真正的运行时配置在 `container_configs` 表里：

| verb | 干什么 | 后续动作 |
|------|--------|----------|
| `restart` | kill 容器，可选 `--rebuild` 先 rebuild image，可选 `--message` 写一条 on_wake 消息 | 见 §11 race-free restart |
| `config get` | 读 `container_configs` 行 + 反序列化 JSON 列 | 单纯查询 |
| `config update` | 改 scalar 列（provider/model/effort/image_tag/assistant_name/max_messages_per_prompt/cli_scope） | 仅写 DB，需 `ncl groups restart` 才生效 |
| `config add-mcp-server` | 往 mcp_servers JSON 加一项 | 写 DB，需 `restart` |
| `config remove-mcp-server` | 从 mcp_servers JSON 删一项 | 写 DB，需 `restart` |
| `config add-package` | 往 packages_apt 或 packages_npm 加一个 | 写 DB，需 `restart --rebuild` |
| `config remove-package` | 从 packages_apt 或 packages_npm 删一个 | 写 DB，需 `restart --rebuild` |

`config update --cli-scope` 在 `groups.ts:146-152` 做 enum 校验：

```ts
if (args['cli-scope'] !== undefined || args.cli_scope !== undefined) {
  const scope = (args['cli-scope'] ?? args.cli_scope) as string;
  if (!['disabled', 'group', 'global'].includes(scope)) {
    throw new Error('--cli-scope must be one of: disabled, group, global');
  }
  updates.cli_scope = scope;
}
```

注意：这是 admin 走 host 路径的 cli_scope 调整——agent 走容器路径会被 dispatcher 在更早一层拦掉（§6.2 阻断自提权）。

`config add-package` 的 note（`groups.ts:244-247`）很重要：

```ts
return {
  added: { apt: apt || null, npm: npm || null },
  note: 'Image rebuild required for packages to take effect. Use install_packages from the agent or rebuild manually.',
};
```

admin 加了 package 不会自动 rebuild——必须显式 `ncl groups restart --rebuild --id <gid>`。但 agent 走 self-mod `install_packages` 流程则自动 rebuild（§13）。这是设计差异：admin 是"明示性 + 多步"，agent 是"封装 + 一步搞定 + 强制审批"。

---

### 10. Container 侧 ncl：DB transport

`container/agent-runner/src/cli/ncl.ts` 是容器里的同名 binary（用 Bun 跑，shebang `#!/usr/bin/env bun`）。它和 host 的 `bin/ncl` 走同一套 frame 协议，但 transport 完全不同。

#### 10.1 写 cli_request

```ts
// container/agent-runner/src/cli/ncl.ts:49-85
function writeRequest(req: RequestFrame): void {
  const db = new Database(OUTBOUND_DB);
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA busy_timeout = 5000');

  const inDb = new Database(INBOUND_DB, { readonly: true });
  inDb.exec('PRAGMA busy_timeout = 5000');

  try {
    db.exec('BEGIN IMMEDIATE');
    const maxOut = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
    const maxIn = (inDb.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
    const max = Math.max(maxOut, maxIn);
    const nextSeq = max % 2 === 0 ? max + 1 : max + 2;

    db.prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, content)
       VALUES ($id, $seq, datetime('now'), 'system', $content)`,
    ).run({
      $id: req.id,
      $seq: nextSeq,
      $content: JSON.stringify({
        action: 'cli_request',
        requestId: req.id,
        command: req.command,
        args: req.args,
      }),
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    inDb.close();
    db.close();
  }
}
```

几个细节：

- `journal_mode = DELETE`：第 4 章讲过——跨挂载边界 WAL 不可见。
- `BEGIN IMMEDIATE`：先抢写锁、再读 max(seq)，否则可能和 agent-runner 主进程并发写时 seq 撞车。
- seq parity：host 用偶数、container 用奇数（第 4 章）。`max % 2 === 0 ? max + 1 : max + 2` 拿到下一个奇数。
- frame 内容裹在 `content` 列的 JSON 里：`{action: 'cli_request', requestId, command, args}`——`action` 字段是 delivery 模块用来分发 system action 的 discriminator。

注意 `ncl.ts` **完全不 import agent-runner 的其他模块**——它是一个 standalone Bun 脚本，自己开 DB、自己写、自己读。Dockerfile 把它放在 PATH 上、起名 `ncl`。这保证 agent 进程崩溃不影响 admin 在容器 shell 里手动调 ncl。

#### 10.2 Host 侧 delivery-action

host 的 delivery loop 不断 poll 每个 session 的 outbound.db；看到 `kind='system'` 的消息会走 `registerDeliveryAction(action, handler)` 注册过的分发表。`src/cli/delivery-action.ts:17` 注册了 `cli_request`：

```ts
registerDeliveryAction('cli_request', async (content, session, inDb) => {
  const requestId = content.requestId as string;
  const command = content.command as string;
  const args = (content.args as Record<string, unknown>) ?? {};

  if (!requestId || !command) {
    log.warn('cli_request missing requestId or command', { sessionId: session.id });
    return;
  }

  const req: RequestFrame = { id: requestId, command, args };
  const ctx = {
    caller: 'agent' as const,
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    messagingGroupId: session.messaging_group_id ?? '',
  };

  log.info('CLI request from agent', { requestId, command, sessionId: session.id });

  const response = await dispatch(req, ctx);

  // Write response to inbound.db so the container can read it.
  // trigger=0: don't wake the agent — this is an inline response to a tool call.
  insertMessage(inDb, {
    id: `cli-resp-${requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({
      type: 'cli_response',
      requestId,
      frame: response,
    }),
    processAfter: null,
    recurrence: null,
    trigger: 0,
  });

  log.info('CLI response written', { requestId, ok: response.ok, sessionId: session.id });
});
```

注意三点：

- caller 是 `'agent'`，session/agentGroup/messagingGroup 全填——dispatcher 据此做 cli_scope 过滤。
- 响应直接 `insertMessage(inDb, ...)` 写进 inbound.db，content 是 `{type: 'cli_response', requestId, frame: response}`。
- `trigger: 0`——这是关键。`trigger=0` 表示"不要唤醒 agent"。这是 inline 响应，agent 已经被它自己刚发的 cli_request 唤醒过、当前 prompt 还没结束，下次 prompt 自然会读到 inbound.db 新消息。如果设 `trigger=1` 会引发额外 wake、白白多跑一轮 prompt。

#### 10.3 容器侧轮询响应

```ts
// container/agent-runner/src/cli/ncl.ts:91-127
function pollResponse(requestId: string, timeoutMs: number): ResponseFrame | null {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const inDb = new Database(INBOUND_DB, { readonly: true });
    inDb.exec('PRAGMA busy_timeout = 5000');
    inDb.exec('PRAGMA mmap_size = 0');

    try {
      const row = inDb
        .prepare("SELECT id, content FROM messages_in WHERE status = 'pending' AND content LIKE ?")
        .get(`%"requestId":"${requestId}"%`) as { id: string; content: string } | null;

      if (row) {
        // Mark as completed via processing_ack so agent-runner skips it
        const outDb = new Database(OUTBOUND_DB);
        outDb.exec('PRAGMA journal_mode = DELETE');
        outDb.exec('PRAGMA busy_timeout = 5000');
        outDb
          .prepare(
            "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', datetime('now'))",
          )
          .run(row.id);
        outDb.close();

        const parsed = JSON.parse(row.content);
        return parsed.frame as ResponseFrame;
      }
    } finally {
      inDb.close();
    }

    Bun.sleepSync(500);
  }

  return null;
}
```

每 500ms 重开一次 DB（`mmap_size = 0` 保证跨挂载可见），用 `LIKE '%"requestId":"<id>"%'` 找到对应响应行；拿到之后**立即** `INSERT OR REPLACE INTO processing_ack ... 'completed'`——这告诉 agent-runner 主循环"这条消息不要再处理"，否则它会把 `cli_response` 当普通系统消息塞进下一轮 prompt 里给 Claude 看。

超时 30s（`ncl.ts:238`）。这是 admin 在容器 shell 里手动跑 `ncl` 的超时；如果是 agent 自己通过 MCP tool 调（理论上可以这样，但实践中 self-mod 走另一条路），超时也是同样的 30s。

#### 10.4 完整双向 flow

<svg viewBox="0 0 880 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Container ncl round-trip: write cli_request to outbound.db, host delivery dispatches, write cli_response to inbound.db, container polls and ACKs">
  <defs>
    <marker id="r13b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <line x1="130" y1="44" x2="130" y2="520" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="370" y1="44" x2="370" y2="520" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="540" y1="44" x2="540" y2="520" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="750" y1="44" x2="750" y2="520" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3,2"/>
  <rect x="40" y="14" width="180" height="24" rx="4" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/>
  <text x="130" y="30" font-size="11" font-weight="600" text-anchor="middle" fill="#ea580c">container shell (ncl bun)</text>
  <rect x="280" y="14" width="180" height="24" rx="4" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="370" y="30" font-size="11" font-weight="600" text-anchor="middle" fill="#7c3aed">outbound.db</text>
  <rect x="450" y="14" width="180" height="24" rx="4" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="540" y="30" font-size="11" font-weight="600" text-anchor="middle" fill="#7c3aed">inbound.db</text>
  <rect x="660" y="14" width="180" height="24" rx="4" fill="#ecfeff" stroke="#0d9488" stroke-width="1.5"/>
  <text x="750" y="30" font-size="11" font-weight="600" text-anchor="middle" fill="#0d9488">host (delivery + dispatch)</text>
  <rect x="40" y="50" width="180" height="60" rx="5" fill="#ffffff" stroke="#ea580c" stroke-width="1"/>
  <text x="50" y="68" font-size="11" font-weight="600" fill="currentColor">ncl groups list</text>
  <text x="50" y="84" font-size="10" fill="#64748b">parseArgv → req {id, command,</text>
  <text x="50" y="98" font-size="10" fill="#64748b">args:{}}</text>
  <line x1="220" y1="80" x2="280" y2="80" stroke="#ea580c" stroke-width="1.5" marker-end="url(#r13b)"/>
  <text x="225" y="74" font-size="10" fill="#ea580c">writeRequest</text>
  <rect x="280" y="50" width="180" height="60" rx="5" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1"/>
  <text x="290" y="66" font-size="10" font-weight="600" fill="currentColor">BEGIN IMMEDIATE</text>
  <text x="290" y="80" font-size="10" fill="#64748b">INSERT messages_out</text>
  <text x="290" y="92" font-size="10" fill="#64748b">kind='system'</text>
  <text x="290" y="104" font-size="10" fill="#64748b">action=cli_request, ...</text>
  <line x1="460" y1="80" x2="660" y2="160" stroke="#7c3aed" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r13b)"/>
  <text x="500" y="120" font-size="10" fill="#7c3aed">delivery loop polls</text>
  <rect x="610" y="130" width="240" height="116" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="620" y="148" font-size="11" font-weight="600" fill="currentColor">dispatch(req, {caller:'agent', ...})</text>
  <text x="620" y="166" font-size="10" fill="#64748b">cli_scope='group' filter:</text>
  <text x="620" y="180" font-size="10" fill="#64748b">  • "groups" in whitelist ✓</text>
  <text x="620" y="194" font-size="10" fill="#64748b">  • auto-fill id = ctx.agentGroupId</text>
  <text x="620" y="212" font-size="10" fill="#64748b">handler: SELECT * FROM agent_groups</text>
  <text x="620" y="226" font-size="10" fill="#64748b">post-filter: scopeField='id'</text>
  <text x="620" y="240" font-size="10" fill="#64748b">→ {ok:true, data:[...]}</text>
  <line x1="660" y1="260" x2="540" y2="290" stroke="#0d9488" stroke-width="1.5" stroke-dasharray="3,2" marker-end="url(#r13b)"/>
  <text x="500" y="280" font-size="10" fill="#0d9488">insertMessage trigger=0</text>
  <rect x="450" y="290" width="180" height="64" rx="5" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1"/>
  <text x="460" y="306" font-size="10" font-weight="600" fill="currentColor">INSERT messages_in</text>
  <text x="460" y="320" font-size="10" fill="#64748b">kind='system'</text>
  <text x="460" y="334" font-size="10" fill="#64748b">type=cli_response</text>
  <text x="460" y="348" font-size="10" fill="#dc2626">trigger=0 — do NOT wake</text>
  <rect x="40" y="378" width="180" height="86" rx="5" fill="#ffffff" stroke="#ea580c" stroke-width="1"/>
  <text x="50" y="394" font-size="11" font-weight="600" fill="currentColor">pollResponse loop</text>
  <text x="50" y="408" font-size="10" fill="#64748b">every 500ms re-open inDb</text>
  <text x="50" y="422" font-size="10" fill="#64748b">SELECT ... LIKE '%requestId%'</text>
  <text x="50" y="436" font-size="10" fill="#64748b">found → INSERT processing_ack</text>
  <text x="50" y="450" font-size="10" fill="#64748b">       'completed' (agent skip)</text>
  <text x="50" y="464" font-size="10" fill="#64748b">return frame</text>
  <line x1="450" y1="334" x2="220" y2="410" stroke="#7c3aed" stroke-width="1.5" stroke-dasharray="3,2" marker-end="url(#r13b)"/>
  <text x="280" y="380" font-size="10" fill="#7c3aed">poll finds row</text>
  <rect x="40" y="482" width="240" height="34" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="50" y="498" font-size="11" font-weight="600" fill="currentColor">formatHuman(frame)</text>
  <text x="50" y="510" font-size="10" fill="#64748b">stdout table → exit(ok ? 0 : 1)</text>
  <line x1="130" y1="464" x2="130" y2="482" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13b)"/>
  <text x="490" y="500" font-size="10" fill="#64748b">round-trip = 0.5–1.5 s</text>
  <text x="490" y="514" font-size="10" fill="#64748b">trigger=0 avoids extra agent wake</text>
</svg>
<span class="figure-caption">图 R13.2 ｜ 容器内 ncl 完整双向 round-trip：通过 outbound/inbound DB 跨挂载传送 frame，trigger=0 保证不触发额外 agent wake。</span>

<details>
<summary>ASCII 原版</summary>

```
container shell                      outbound.db        inbound.db        host
─────────────────────────────────────────────────────────────────────────────
ncl groups list
  └─ parseArgv → req {id:cli-..., command:"groups-list", args:{}}
  └─ writeRequest:
       BEGIN IMMEDIATE
       INSERT messages_out (id, seq, kind='system',
            content='{"action":"cli_request","requestId":"cli-...",
                      "command":"groups-list","args":{}}')
       COMMIT
                                       ▼
                                                          delivery loop polls
                                                          ↓
                                                          看到 action='cli_request'
                                                          ↓
                                                          dispatch(req, {caller:'agent', sessionId, agentGroupId})
                                                          ↓
                                                          cli_scope='group' filter:
                                                            "groups" 在白名单 ✓
                                                            auto-fill id=ctx.agentGroupId
                                                          ↓
                                                          handler: SELECT * FROM agent_groups ...
                                                          ↓
                                                          post-handler filter:
                                                            scopeField='id'，只保留 id===ctx.agentGroupId 的行
                                                          ↓
                                                          response = {id, ok:true, data: [...]}
                                                                                  ▼
                                                                       insertMessage(inDb, {
                                                                         kind:'system',
                                                                         content:'{"type":"cli_response","requestId":"cli-...",
                                                                                   "frame":{...}}',
                                                                         trigger:0
                                                                       })
                                                                       ▲
pollResponse loop (every 500ms):
  SELECT * FROM messages_in
   WHERE content LIKE '%"requestId":"cli-..."%'
  → 拿到行
  → INSERT processing_ack 'completed'
  → return frame
└─ formatHuman(frame)
└─ stdout 打印表格
└─ exit
```

</details>

整个 round-trip 通常 0.5-1.5 秒（取决于 delivery loop 周期、container poll 周期）。

---

### 11. Race-free container restart

`ncl groups restart` 是个 custom verb（`src/cli/resources/groups.ts:62-110`），它把"安全重启容器"这件事封装好。两个调用路径：

**Path A：admin 走 host socket 调** `ncl groups restart --id <gid>`
- `ctx.caller === 'host'`
- 跑 `restartAgentGroupContainers(id, 'restarted via ncl', message)`
- 这个函数遍历 group 下所有 running session，每个写一条 `on_wake` 消息（如果有 `--message`）然后 kill 容器，注册 onExit 回调，回调里 `wakeContainer`

**Path B：agent 在容器里调** `ncl groups restart [--message "..."]`
- `ctx.caller === 'agent'`，id 被 auto-fill 成 `ctx.agentGroupId`
- 只重启 caller 自己这个 session（`groups.ts:80-104`），不影响 group 里其他 session
- 因为 access='approval'，这条命令会先被 dispatcher 拦下走 approval（除非是 owner / global cli_scope）

`src/container-restart.ts:21-59` 是 host 端的实现：

```ts
export function restartAgentGroupContainers(agentGroupId: string, reason: string, wakeMessage?: string): number {
  const sessions = getSessionsByAgentGroup(agentGroupId).filter(
    (s) => s.status === 'active' && isContainerRunning(s.id),
  );

  for (const session of sessions) {
    if (wakeMessage) {
      writeSessionMessage(agentGroupId, session.id, {
        id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: agentGroupId,
        channelType: 'agent',
        threadId: null,
        content: JSON.stringify({
          text: wakeMessage,
          sender: 'system',
          senderId: 'system',
        }),
        onWake: 1,
      });
    }
    killContainer(
      session.id,
      reason,
      wakeMessage
        ? () => {
            const s = getSession(session.id);
            if (s) wakeContainer(s);
          }
        : undefined,
    );
  }

  if (sessions.length > 0) {
    log.info('Restarting agent group containers', { agentGroupId, reason, count: sessions.length });
  }
  return sessions.length;
}
```

关键是 `onWake: 1`。这是 `messages_in` 表的一个列（v2.0.48 加的，见 `messages-in.ts:13-24` 的兼容代码）：

```ts
// container/agent-runner/src/db/messages-in.ts:13-24
let _hasOnWake: boolean | null = null;
function hasOnWakeColumn(db: ReturnType<typeof openInboundDb>): boolean {
  if (_hasOnWake !== null) return _hasOnWake;
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  _hasOnWake = cols.has('on_wake');
  return _hasOnWake;
}
```

容器侧 `getPendingMessages(isFirstPoll)`：

```ts
// container/agent-runner/src/db/messages-in.ts:65-97
export function getPendingMessages(isFirstPoll = false): MessageInRow[] {
  const inbound = openInboundDb();
  const outbound = getOutboundDb();

  try {
    const onWakeFilter = hasOnWakeColumn(inbound) ? 'AND (on_wake = 0 OR ?1 = 1)' : '';
    const pending = inbound
      .prepare(
        `SELECT * FROM messages_in
         WHERE status = 'pending'
           AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
           ${onWakeFilter}
         ORDER BY seq DESC
         LIMIT ?2`,
      )
      .all(isFirstPoll ? 1 : 0, getMaxMessagesPerPrompt()) as MessageInRow[];
    // ...
  }
}
```

`on_wake = 1` 的消息只在 **`isFirstPoll === true`** 的查询里被取出来——这正是新容器启动后第一次 poll 的标志。所以：

1. host 写一条 `on_wake = 1` 消息
2. host 调 `killContainer(sessionId, reason, onExit)`——发 SIGTERM
3. 旧容器在 grace period 里继续 poll（最后几次），但 `isFirstPoll = false`，看不到 on_wake 消息 → 不会偷走
4. 旧容器 exit → `onExit` 回调跑 → `wakeContainer(session)` 拉起新容器
5. 新容器第一次 poll，`isFirstPoll = true`，读到 on_wake 消息，开始处理

这就是 "**dying container 不能偷 wake 消息**" 的硬保证。没有 on_wake 列时（v2.0.48 之前），dying container 在 grace period 内偶发性地把 wake 消息读走、然后立即死、消息永远丢失——这就是 v2.0.48 加这个列的原因。

旧版本兼容：`hasOnWakeColumn` 返回 false 时，整个 WHERE 条件没有 `on_wake` filter，行为退化成"所有人都能拿"——这是 graceful degradation，新代码跑老 session DB 不会崩，只是失去 race-free 保证。

---

### 12. Self-modification：tier 1（install_packages / add_mcp_server）

设计意图：agent 干活时发现自己缺工具——比如要做 PDF 处理但没装 `poppler-utils`，或者想用 GitHub MCP server 但没接——它应该能 **请求** 装包/接 MCP server，但**必须经过 admin 同意**才生效，并且生效过程要自动完成（admin 不应该手动去 ssh、改 container.json、重启服务）。

这是个 4 步流程：agent 请求 → admin 看到卡片 → admin 批准 → host 自动应用并重启容器。

#### 12.1 Agent 侧：MCP tool

`container/agent-runner/src/mcp-tools/self-mod.ts` 注册两个 MCP tool。

**`install_packages`**：

```ts
// container/agent-runner/src/mcp-tools/self-mod.ts:39-79
export const installPackages: McpToolDefinition = {
  tool: {
    name: 'install_packages',
    description:
      'Install apt and/or npm packages into YOUR per-agent container image. Requires admin approval; fire-and-forget. On approval, the image is rebuilt and the container is restarted automatically.',
    // ... inputSchema
  },
  async handler(args) {
    const apt = (args.apt as string[]) || [];
    const npm = (args.npm as string[]) || [];
    if (apt.length === 0 && npm.length === 0) return err('At least one apt or npm package is required');
    if (apt.length + npm.length > MAX_PACKAGES) return err(`Maximum ${MAX_PACKAGES} packages per request`);

    const invalidApt = apt.find((p) => !APT_RE.test(p));
    if (invalidApt) return err(`Invalid apt package name: "${invalidApt}". Only lowercase letters, digits, and ._+- allowed.`);
    const invalidNpm = npm.find((p) => !NPM_RE.test(p));
    if (invalidNpm) return err(`Invalid npm package name: "${invalidNpm}". No version specs or shell characters.`);

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'install_packages',
        apt,
        npm,
        reason: (args.reason as string) || '',
      }),
    });

    log(`install_packages: ${requestId} → apt=[${apt.join(',')}] npm=[${npm.join(',')}]`);
    return ok(`Package install request submitted. You will be notified when admin approves or rejects.`);
  },
};
```

包名 sanitize 用两条正则：

```ts
const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGES = 20;
```

不允许版本号、shell 字符。`@scope/pkg` 形式允许。最多 20 个包/请求。

`writeMessageOut(...)` 写一条 `kind='system'` 消息到 outbound.db，content 是 `{action:'install_packages', apt, npm, reason}`。tool 立即返回——这是 fire-and-forget，agent 拿到 "submitted" 文本，结束这一轮 tool call、继续 prompt，去做别的事或者结束 turn。

**`add_mcp_server`**：

```ts
// container/agent-runner/src/mcp-tools/self-mod.ts:81-118
export const addMcpServer: McpToolDefinition = {
  tool: {
    name: 'add_mcp_server',
    description:
      'Wire an EXISTING third-party MCP server into YOUR per-agent runtime config — you must already know the exact `command` + `args` to invoke it (e.g. `npx @modelcontextprotocol/server-github`). Requires admin approval; fire-and-forget.',
    // ...
  },
  async handler(args) {
    const name = args.name as string;
    const command = args.command as string;
    if (!name || !command) return err('name and command are required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'add_mcp_server',
        name,
        command,
        args: (args.args as string[]) || [],
        env: (args.env as Record<string, string>) || {},
      }),
    });

    log(`add_mcp_server: ${requestId} → "${name}" (${command})`);
    return ok(`MCP server request submitted. You will be notified when admin approves or rejects.`);
  },
};
```

`add_mcp_server` 只是写 `mcp_servers` JSON 列，不 rebuild 镜像——纯粹的 runtime 配置变化。

#### 12.2 Host delivery：触发 approval

`src/modules/self-mod/request.ts` 是 delivery 拿到 `action='install_packages'` 或 `action='add_mcp_server'` 时跑的 handler。

`handleInstallPackages`：

```ts
// src/modules/self-mod/request.ts:20-64
export async function handleInstallPackages(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'install_packages failed: agent group not found.');
    return;
  }

  const apt = (content.apt as string[]) || [];
  const npm = (content.npm as string[]) || [];
  const reason = (content.reason as string) || '';

  // 重做一遍 sanitize —— defense in depth
  const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
  const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  const MAX_PACKAGES = 20;
  if (apt.length + npm.length === 0) {
    notifyAgent(session, 'install_packages failed: at least one apt or npm package is required.');
    return;
  }
  if (apt.length + npm.length > MAX_PACKAGES) {
    notifyAgent(session, `install_packages failed: max ${MAX_PACKAGES} packages per request.`);
    return;
  }
  // ... apt/npm 各扫一遍正则

  const packageList = [...apt.map((p) => `apt: ${p}`), ...npm.map((p) => `npm: ${p}`)].join(', ');
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'install_packages',
    payload: { apt, npm, reason },
    title: 'Install Packages Request',
    question: `Agent "${agentGroup.name}" is attempting to install a package + rebuild container:\n${packageList}${reason ? `\nReason: ${reason}` : ''}`,
  });
}
```

注意 host 侧**重做一遍 sanitize**——container 的 MCP tool 已经校验过了，host 这边也校验。Defense in depth：DB 行（agent 写的）携带的 payload 最终会进 shell exec（apt-get install / pnpm install），任何 sanitize 漏洞都不能依赖单层防御。

`handleAddMcpServer` 类似但简单（`request.ts:66-91`）——只校验 name/command 非空、然后 `requestApproval`。

`requestApproval(...)` 来自 approvals primitive（CLAUDE.md 提到的 `src/modules/approvals/primitive.ts`）：它做四件事：
1. 选一个 approver（preference 顺序：scoped admin → global admin → owner，且优先选和 agent 同 channel 的）
2. 选一个 delivery channel（approver 的某个 DM）
3. 把 `pending_approvals` 行 INSERT 到中央 DB
4. 把 approval card（带 Approve / Reject 按钮）作为消息发到 approver 的 DM

#### 12.3 Approval handler：apply

admin 点 Approve 之后，approvals 模块查 `pending_approvals.action` 找到注册过的 handler，调它。

`src/modules/self-mod/apply.ts:22-83` 是 `install_packages` handler：

```ts
export const applyInstallPackages: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('install_packages approved but agent group missing.');
    return;
  }

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) {
    notify('install_packages approved but container config missing.');
    return;
  }

  // Append new packages to existing lists in the DB (deduplicated)
  if (payload.apt) {
    const existing = JSON.parse(configRow.packages_apt) as string[];
    for (const pkg of payload.apt as string[]) {
      if (!existing.includes(pkg)) existing.push(pkg);
    }
    updateContainerConfigJson(agentGroup.id, 'packages_apt', existing);
  }
  if (payload.npm) {
    const existing = JSON.parse(configRow.packages_npm) as string[];
    for (const pkg of payload.npm as string[]) {
      if (!existing.includes(pkg)) existing.push(pkg);
    }
    updateContainerConfigJson(agentGroup.id, 'packages_npm', existing);
  }

  const pkgs = [
    ...((payload.apt as string[] | undefined) || []),
    ...((payload.npm as string[] | undefined) || []),
  ].join(', ');
  log.info('Package install approved', { agentGroupId: session.agent_group_id, userId });
  try {
    await buildAgentGroupImage(session.agent_group_id);
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `Packages installed (${pkgs}) and container rebuilt. Verify the new packages are available (e.g. run them or check versions) and report the result to the user.`,
        sender: 'system',
        senderId: 'system',
      }),
      onWake: 1,
    });
    killContainer(session.id, 'rebuild applied', () => {
      const s = getSession(session.id);
      if (s) wakeContainer(s);
    });
    log.info('Container rebuild completed (bundled with install)', { agentGroupId: session.agent_group_id });
  } catch (e) {
    notify(
      `Packages added to config (${pkgs}) but rebuild failed: ${e instanceof Error ? e.message : String(e)}. Tell the user — an admin will need to retry the install_packages request or inspect the build logs.`,
    );
    log.error('Bundled rebuild failed after install approval', { agentGroupId: session.agent_group_id, err: e });
  }
};
```

干五件事：

1. **更新 DB**：读 `packages_apt` JSON 列、append（dedup）、写回。npm 同理。
2. **Rebuild 镜像**：`buildAgentGroupImage(agentGroupId)`——这是同步等的，可能要 30s-2min。`container/build.sh` 用 docker buildx 重建 `nanoclaw-agent-<gid>:latest`。
3. **写 on_wake 消息**：告诉新容器 "你刚被 rebuilt 了，验证一下新装的工具能不能跑、然后告诉用户结果"。
4. **kill 旧容器**：发 SIGTERM，注册 onExit 回调拉新容器。
5. **wakeContainer in onExit**：新容器启动，第一次 poll 拿到 on_wake 消息，开始处理。

注意 `try/catch`：rebuild 失败时，**DB 已经改了**（packages 加到 JSON 列了），但容器没重启。这是故意的——admin 知道 "我批了你的请求，但 build 出问题"，可以查日志、修 Dockerfile、再 `ncl groups restart --rebuild` 手动 retry，包名已经在 DB 里了不会丢。

`applyAddMcpServer`（`apply.ts:85-126`）类似但简单——只更新 `mcp_servers` JSON 列、写 on_wake、kill+wake。不 rebuild，因为 MCP server 是 runtime spawn（容器启动时按 `mcp_servers` map 起进程），不需要镜像层变化。

#### 12.4 完整 self-mod flow

<svg viewBox="0 0 880 620" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Self-mod install_packages end-to-end: agent request, host approval, image rebuild, race-free container restart with on_wake message handoff">
  <defs>
    <marker id="r13c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="20" y="14" width="840" height="90" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/>
  <text x="34" y="34" font-size="13" font-weight="700" fill="#ea580c">1. agent (in container)</text>
  <text x="40" y="54" font-size="11" fill="currentColor">install_packages({apt:['ripgrep'], reason:'grep PDFs'})</text>
  <text x="40" y="70" font-size="10" fill="#64748b">→ writeMessageOut({kind:'system', content:{action:'install_packages', apt, npm, reason}})</text>
  <text x="40" y="84" font-size="10" fill="#64748b">→ return ok("Package install request submitted...") — fire-and-forget, agent continues</text>
  <text x="40" y="98" font-size="10" fill="#64748b">sanitize: APT_RE / NPM_RE / MAX_PACKAGES=20 (defense in depth)</text>
  <rect x="20" y="118" width="840" height="78" rx="8" fill="#ecfeff" stroke="#0d9488" stroke-width="1.5"/>
  <text x="34" y="138" font-size="13" font-weight="700" fill="#0d9488">2. host delivery loop</text>
  <text x="40" y="158" font-size="11" fill="currentColor">poll outbound.db → see action='install_packages'</text>
  <text x="40" y="174" font-size="10" fill="#64748b">handleInstallPackages: re-sanitize apt/npm (defense in depth)</text>
  <text x="40" y="188" font-size="10" fill="#64748b">requestApproval → pickApprover → INSERT pending_approvals → deliver card via Telegram/Discord</text>
  <rect x="20" y="210" width="840" height="78" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="34" y="230" font-size="13" font-weight="700" fill="#0ea5e9">3. owner DM</text>
  <text x="40" y="250" font-size="11" fill="currentColor">"Agent 'gavriel' wants to install + rebuild: apt: ripgrep — reason: grep PDFs"</text>
  <text x="40" y="266" font-size="11" font-weight="700" fill="#16a34a">[ Approve ]  [ Reject ]</text>
  <text x="40" y="282" font-size="10" fill="#64748b">click → router → approval delivery → DELETE pending_approvals → lookup('install_packages')</text>
  <rect x="20" y="302" width="840" height="120" rx="8" fill="#ecfeff" stroke="#0d9488" stroke-width="1.5"/>
  <text x="34" y="322" font-size="13" font-weight="700" fill="#0d9488">4. applyInstallPackages (host)</text>
  <text x="40" y="342" font-size="11" fill="currentColor">read container_configs.packages_apt JSON → append 'ripgrep' (dedup) → write back</text>
  <text x="40" y="358" font-size="11" fill="#ea580c">buildAgentGroupImage(gid)  — docker build ~30s</text>
  <text x="40" y="374" font-size="11" fill="#dc2626">writeSessionMessage(on_wake=1, "Packages installed (ripgrep)...")</text>
  <text x="40" y="390" font-size="11" fill="currentColor">killContainer(sid, 'rebuild applied', onExit = wakeContainer)</text>
  <text x="40" y="408" font-size="10" fill="#64748b">try/catch: if build fails, DB already updated — admin can retry via ncl groups restart --rebuild</text>
  <rect x="20" y="436" width="410" height="84" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="34" y="456" font-size="12" font-weight="700" fill="#dc2626">5a. old container — SIGTERM grace period</text>
  <text x="34" y="476" font-size="10" fill="#64748b">still polls inbound.db, but isFirstPoll=false</text>
  <text x="34" y="490" font-size="10" fill="#dc2626">→ on_wake=1 row is FILTERED OUT (cannot steal)</text>
  <text x="34" y="506" font-size="10" fill="#64748b">exit → onExit fires → wakeContainer(session)</text>
  <rect x="450" y="436" width="410" height="84" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="464" y="456" font-size="12" font-weight="700" fill="#16a34a">5b. new container — first poll</text>
  <text x="464" y="476" font-size="10" fill="#64748b">isFirstPoll=true → on_wake=1 row included</text>
  <text x="464" y="490" font-size="10" fill="currentColor">agent reads "Packages installed (ripgrep)..."</text>
  <text x="464" y="506" font-size="10" fill="#64748b">runs ripgrep --version, replies to user</text>
  <rect x="20" y="540" width="840" height="64" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/>
  <text x="34" y="560" font-size="13" font-weight="700" fill="#ea580c">6. agent → user</text>
  <text x="40" y="580" font-size="11" fill="currentColor">"Done, ripgrep is installed. Now back to grepping your PDFs..."</text>
  <text x="40" y="596" font-size="10" fill="#64748b">admin clicked Approve once — DB write + image rebuild + restart + handoff all automatic</text>
  <line x1="440" y1="104" x2="440" y2="118" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13c)"/>
  <line x1="440" y1="196" x2="440" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13c)"/>
  <line x1="440" y1="288" x2="440" y2="302" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13c)"/>
  <line x1="225" y1="422" x2="225" y2="436" stroke="#dc2626" stroke-width="1.2" marker-end="url(#r13c)"/>
  <line x1="655" y1="422" x2="655" y2="436" stroke="#16a34a" stroke-width="1.2" marker-end="url(#r13c)"/>
  <line x1="430" y1="478" x2="450" y2="478" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r13c)"/>
  <text x="436" y="472" font-size="9" fill="#64748b">onExit</text>
  <line x1="655" y1="520" x2="655" y2="540" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13c)"/>
</svg>
<span class="figure-caption">图 R13.3 ｜ install_packages 端到端：agent fire-and-forget → admin 一键 Approve → host 自动改 DB + rebuild + race-free 容器交接 (on_wake 双层 race 防御)。</span>

<details>
<summary>ASCII 原版</summary>

```
agent (in container):
  install_packages({apt: ['ripgrep']})
       ↓
  writeMessageOut({kind:'system', content:'{"action":"install_packages","apt":["ripgrep"],...}'})
       ↓
  return ok("Package install request submitted...")
       ↓
  (agent 这轮 tool call 结束，继续做别的事)

host delivery loop:
  poll outbound.db → see action='install_packages'
       ↓
  handleInstallPackages(content, session):
    re-sanitize apt/npm
    requestApproval(...):
      pickApprover() → owner DM channel
      INSERT pending_approvals
      send approval card to owner via Telegram/Discord/etc.

owner sees card on Telegram:
  "Agent 'gavriel' is attempting to install a package + rebuild container:
    apt: ripgrep
    Reason: I need to grep PDFs"
  [Approve] [Reject]
       ↓
  owner clicks Approve
       ↓
  inbound from Telegram → router → approval delivery → 找到 pending_approvals 行
       ↓
  approvals dispatch:
    DELETE pending_approvals row
    cb = lookup('install_packages')  → applyInstallPackages

applyInstallPackages:
  read container_configs.packages_apt JSON
  append 'ripgrep', write back
  buildAgentGroupImage(gid)  ← docker build, ~30s
  writeSessionMessage(on_wake=1, "Packages installed (ripgrep)...")
  killContainer(sid, 'rebuild applied', onExit=wakeContainer)

旧 container in grace period:
  poll inbound.db → isFirstPoll=false → on_wake msg 被过滤掉
  exit (SIGTERM grace period passed)
       ↓
  onExit fires → wakeContainer(session)

new container starts:
  poll inbound.db → isFirstPoll=true → on_wake=1 msg 被取出
  agent 看到 system message: "Packages installed (ripgrep)..."
  agent runs `ripgrep --version`, OK
  agent replies to user: "Done, ripgrep is installed. Now back to grepping your PDFs..."
```

</details>

整个流程 admin 只点了一下 Approve，其余全部自动。这是 self-mod 的核心 UX 价值。

#### 12.5 未来 tier 2：源码 self-edit

CLAUDE.md 明确说了：

> A second tier (direct source-level self-edits via a draft/activate flow) is planned but not yet implemented.

意思是有计划让 agent 可以 draft 一些源代码变更（比如改自己的 skill、加一个新的 MCP tool），admin approval → activate（写文件 + rebuild + 重启）。但目前 v2.0.64 没实现，只有 tier 1。

---

### 13. 实战：常用 ncl 例子

```bash
# 看所有 agent group
ncl groups list

# 看某个 group 的详情
ncl groups get a1b2c3d4

# 创建一个 agent group（写 SQL + 初始化 group 目录）
ncl groups create --name "PR Reviewer" --folder pr-reviewer

# 重启某个 group 的所有容器
ncl groups restart --id a1b2c3d4

# 重启 + rebuild image（装包后必须）
ncl groups restart --id a1b2c3d4 --rebuild

# 重启 + 投一条系统消息让 agent 醒来后做特定的事
ncl groups restart --id a1b2c3d4 --message "你刚被重启了，确认 ripgrep 可用，然后告诉用户"

# 看某个 group 当前 container config
ncl groups config get --id a1b2c3d4

# 改 group 的模型 + max_messages_per_prompt
ncl groups config update --id a1b2c3d4 --model claude-opus-4-5 --max-messages-per-prompt 20

# 给 group 加一个 MCP server
ncl groups config add-mcp-server --id a1b2c3d4 --name github --command "npx" --args '["@modelcontextprotocol/server-github"]'

# 给某个用户加 admin role（scoped to 一个 group）
ncl roles grant --user telegram:6037840640 --role admin --group a1b2c3d4

# 给某个用户加 owner role（global）
ncl roles grant --user discord:1470183333427675709 --role owner

# 看 pending approvals
ncl approvals list

# 看 dropped messages（来自未注册用户的）
ncl dropped-messages list

# 看 sessions
ncl sessions list

# JSON 输出（适合 jq）
ncl groups list --json | jq '.[] | {id, name}'

# 帮助
ncl help
ncl groups help
```

容器里的 agent 调用看起来一样，但 dispatcher 会：
- 自动 auto-fill `--id` / `--group` / `--agent-group-id` 为它自己的 agentGroupId
- 拒绝跨 group 操作
- 把写操作走 approval

所以 agent 一句 `ncl groups config get` 就能拿自己的配置；一句 `ncl groups restart --message "新装的工具搞定了，告诉用户"` 就能自我重启（前提是 owner / global cli_scope，否则会触发 approval）。

---

### 14. Bootstrap：`init-first-agent` 和 `init-cli-agent`

NanoClaw 安装好之后，central DB 是空的——没有 user、没有 agent_group、没有 wiring。第一个 agent 怎么诞生？

`scripts/init-first-agent.ts` 是答案：一个独立的 tsx 脚本，**和 service 同时跑**（依靠 WAL + ncl socket IPC，不冲突）。它做的事其实就是程序化地用 ncl + 直连 DB 把第一个 agent 拼起来：

1. **创建 user**（`upsertUser`）：`{channel}:{handle}`
2. **抢 owner role**（如果当前没人是 owner，且 `--role owner`）：`grantRole(... role='owner', agent_group_id=null)`
3. **创建 agent group**（`createAgentGroup`）+ 初始化 group 目录（`initGroupFilesystem`）
4. **给 owner 的 group 设 `cli_scope='global'`**：
   ```ts
   // scripts/init-first-agent.ts:235-236
   // Owner's agent group gets global CLI access
   updateContainerConfigScalars(ag.id, { cli_scope: 'global' });
   ```
5. **加成员行**（`addMember`）：让 access gate 有明确 yes/no
6. **创建 messaging group**（`createMessagingGroup`）：默认 `unknown_sender_policy='strict'`、`is_group=0`
7. **创建 wiring**（`createMessagingGroupAgent`）：`engage_mode='pattern'`、`engage_pattern='.'`（DM 永远响应）
8. **投递 welcome 消息**：经 `data/cli.sock`（这是 chat-style cli adapter 的 socket，**不是** `data/ncl.sock`）把 "/welcome" 命令丢进 router，router 进 inbound.db，唤醒新容器

第 8 步用 cli.sock 而不是 ncl.sock，是因为它要走 message router（创建一条入站聊天消息），而不是走 ncl dispatcher（操作 DB 行）。这两条 socket 是不同的 admin 表面：`data/ncl.sock` 是 "改 DB 行"，`data/cli.sock` 是 "投递一条聊天消息"。

`scripts/init-cli-agent.ts` 类似，但是给本地终端 channel（CLI channel adapter）创建第一个 agent，不需要外部 channel adapter。

`scripts/delete-cli-agent.ts` 反向操作：清理掉本地 CLI agent。

---

### 15. 重要 trade-off

#### 15.1 为什么 cli_scope 默认 group 而不是 disabled

默认 disabled 会更安全。但 group-scope 提供 agent 一个有用的 "自我感知" 能力：它能看到自己的 model / mcp_servers / packages、能 list 自己的 sessions、能改自己的 destinations（经 approval）。这对 agent 自我调试 / 自我重启 / 协调子 agent 非常关键。

disabled 是给 "完全不信任，纯执行" 的 agent 用的——比如一个跑在 sandboxed 环境里只允许做单一任务的 agent。

global 严格限定 owner。任何其他 agent 想要 global cli_scope，admin 必须 explicit `ncl groups config update --id <gid> --cli-scope global`（这本身需要 approval）。

#### 15.2 为什么 ncl 不直接重启容器、而是写 on_wake + kill + onExit

最朴素的实现：`killContainer; spawnContainer`。但这有 race：
- spawnContainer 在 killContainer 之前完成？双容器同时跑、抢同一 inbound.db。
- killContainer 是同步等的，但 grace period 默认 10s——dying 容器在 grace 内还在 poll inbound.db。如果 wake message 没有 on_wake 列保护，会被它偷走。

`onExit` 回调 + `on_wake=1` 是双保险：onExit 保证新容器在旧容器死后才起；on_wake 保证 wake message 即便被 dying 容器看到也不会被消化（因为 isFirstPoll=false 不查 on_wake 行）。两层独立的 race 防御。

#### 15.3 为什么 install_packages 自动 rebuild、而 admin 手动 `ncl groups config add-package` 不 rebuild

设计意图差异：
- agent 走 self-mod：意图是 "我现在就要用这个工具"——自然应该一步到位。
- admin 走 `ncl groups config add-package`：可能是批量配置中的一步，admin 可能还要加 mcp_server、改 cli_scope、加 destination 等等再统一 rebuild。如果每加一个 package 就自动 rebuild，会浪费大量时间在重复 build 上。

所以 admin 路径是 "明示性多步"，`ncl groups restart --rebuild` 由 admin 主动触发；agent 路径是 "封装一步"，因为 agent 一次只做一件事。

#### 15.4 为什么不直接让 admin 在 ncl 命令里写 `--auto-rebuild`

可以加，但目前没有——admin 路径强调"看得见每个步骤"，让 admin 明确知道 "我现在在改 config" 和 "我现在在 rebuild + 重启" 是两件不同的事。这能避免 admin 在生产环境中误改一个 config 字段然后被自动 rebuild 拖几分钟。

---

### 16. 一句话总结

`ncl` 是个本地 RPC 客户端，把 admin 的 shell 命令和 agent 的 MCP 调用通过同一套 dispatcher + registry + resource 定义路由到 host 的 v2.db；Self-modification 是这条路上的特殊形态——agent 通过 MCP 工具发起一个写操作请求，host 走标准 approval 流程拿到 admin 同意，然后自动完成 "改 DB + rebuild image + write on_wake + kill + wakeContainer" 五步动作。整套机制的 invariant 是：唯一 writer（host）、显式 caller context（不在 frame 里）、显式 cli_scope 三档分级、显式 access 等级 + approval 强制、race-free restart（onExit + on_wake）。
