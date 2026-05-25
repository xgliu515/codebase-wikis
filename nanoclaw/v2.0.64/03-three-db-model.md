## 三 DB 数据模型

NanoClaw 在同一台机器上跨进程、跨 mount namespace、可能还跨文件系统层共享一份"运行时状态"。本章解释为什么共享状态被切成 **三个独立的 SQLite 文件**、每个文件的 schema 与所有者、以及那些"看起来很奇怪、其实不能动"的不变量（journal 模式、心跳文件、seq 奇偶）。

> 本章是数据层的参考章，**所有跨进程的 I/O 都要回到这张表**。后续章节（消息流、容器生命周期、审批）只会引用这里定义的字段与文件，不会再重复解释 schema 本身。

---

### 3.1 设计问题：跨边界的共享状态

NanoClaw 的运行时由两类进程组成：

- **Host**：一个长生命周期的 Node 进程，跑 channel adapter、router、delivery、host-sweep、CLI 服务器。Host 知道用户、权限、wiring，能写文件、能开启容器。
- **Container**：per-session 的 Bun 进程，跑 agent-runner，里面装了 Claude Agent SDK / Codex / OneCLI 与所有 MCP server。Container 不应该看到其它 session 的状态、不应该看到 admin plane 的表。

它们必须共享至少四类数据：

1. **入站消息**：host 把外部平台（Discord、Telegram、CLI、Webhook、定时任务）的事件投递给指定 session 的 container。
2. **出站消息**：container 产生的回复、edit、reaction、ask_question、agent-to-agent 调用，必须能让 host 拣起来并通过 channel adapter 发回平台。
3. **运行状态**：container 在跑哪条消息？是不是在等 Bash？是不是卡住？心跳是什么时候？
4. **持久状态**：Claude SDK 的 session id（用于 `--continue`）、container 自上次启动以来的 KV，要在 container 重启之后还能恢复。

而且这层 IPC 要满足下面这些工程约束：

- Container 跑在 Docker / Apple Container / Colima / Lima / Podman Machine 里，**host 与 container 看到的文件系统不是同一层**：要么走 OverlayFS、要么走 VirtioFS、要么走 NFS-like 的 bind mount。
- Host 与 container **不能共享内存**（不是同一个 mnt/PID namespace）。
- 容器随时会被 host 杀掉或自然退出；host 也会被 launchd 重启。**任何写到一半的状态都必须能被对端检测并恢复**。
- 整个系统要在没有 root、没有守护进程框架（比如 systemd-journald）、没有共享数据库服务器（PostgreSQL、Redis）的前提下，开箱即用。

这套约束把 IPC 选项压得很窄。

---

### 3.2 朴素方案与为什么它们都失败

#### 选项 A：一个共享 SQLite 文件，host 和 container 同时读写

让 host 和 container 都打开同一份 `session.db`，用 SQLite 自己的文件锁解决并发：

- **失败 1（致命）**：SQLite 文件锁依赖 `flock(2)` / POSIX 字节锁。跨 VirtioFS、NFS、9p 的实现要么不支持要么半残（macOS 上的 Apple Container 用的是 VirtioFS，guest 锁不会传给 host）。两边都拿不到独占锁，写一半就互相覆盖。
- **失败 2**：即使锁能工作，WAL 模式下的 `-shm` 是 `mmap` 段，跨 mount 的 mmap 一致性几乎肯定不成立（见 §3.7）。
- **失败 3**：DB 文件腐烂之后没有自动恢复路径——一次损坏，整个 session 的对话历史全部丢失。

#### 选项 B：共享内存（POSIX shm / tmpfs）

- 容器隔离的全部意义就是**进程 / 文件系统 / 网络空间分离**。把共享内存从 host 透传进 container 等于把 container 隔离打破一半。Apple Container 默认根本不允许 host shm。
- 即使打通了，shm 不持久——host 或 container 崩溃后状态就没了，而 NanoClaw 显式要求"消息和 session 状态跨重启存活"。

#### 选项 C：TCP socket / Unix socket / HTTP

- 多了一层故障面：序列化、连接 keepalive、缓冲区、重试、握手、版本协商。
- 容器侧的 Bun 进程要等 host 服务起来才能 connect；host 重启时所有 container 都断线、要重新握手。
- 没有现成的"持久化 + 原子提交"语义，需要在协议层重新实现 ACK、retry、去重——而 SQLite 已经把这些做完了。
- 完全无法在 host 没起来的时候让 container "暂存出站消息"——`outbound.db` 就是这种本地缓冲。

#### 选项 D：stdin/stdout pipe

- 行为像一根管道：单向、易堵、container 重启后全部丢失。
- 不能让 host 在 container 没启动时往里写消息（host 需要能"在 container 还没起来的时候记下定时任务"）。

---

### 3.3 NanoClaw 的方案：三 DB 拆分 + 单写者不变量

NanoClaw 把状态切成三份 SQLite 文件，**每份只允许一个写者**：

```
data/
  v2.db                                       <- CENTRAL
                                                 owner: host (sole writer + reader)
  v2-sessions/
    <agent_group_id>/
      .claude-shared/                         <- per-agent-group Claude state
      agent-runner-src/                       <- per-group runtime overlay
      <session_id>/
        inbound.db                            <- writer: host
                                                 reader: host (sync) + container (read-only)
        outbound.db                           <- writer: container
                                                 reader: host (read-only) + container
        .heartbeat                            <- mtime touched by container
        inbox/<message_id>/                   <- user attachments
        outbox/<message_id>/                  <- agent attachments
```

| DB | 路径 | 写者 | 读者 | 用途 |
|----|------|------|------|------|
| **Central** | `data/v2.db` | host | host | 身份、权限、wiring、approvals、session 注册表（admin plane） |
| **Inbound** | `data/v2-sessions/<ag>/<sid>/inbound.db` | host | host + container（只读） | host → container 消息 + routing 投影 |
| **Outbound** | `data/v2-sessions/<ag>/<sid>/outbound.db` | container | container + host（只读） | container → host 消息 + 处理 ack + session 持久 KV |

文件路径计算函数都在 `src/session-manager.ts:52-77`：

```ts
export function sessionDir(agentGroupId: string, sessionId: string): string {
  return path.join(sessionsBaseDir(), agentGroupId, sessionId);
}
export function inboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'inbound.db');
}
export function outboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'outbound.db');
}
export function heartbeatPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), '.heartbeat');
}
```

#### 单写者不变量

这是整个三 DB 模型最核心的一句话：

> **每个 SQLite 文件最多一个写者**。Central 由 host 独占；每个 `inbound.db` 由 host 独占；每个 `outbound.db` 由 container 独占。**不存在任何一份"双向都能写"的 DB**。

这条不变量直接消灭了三类问题：

1. **跨 mount 的 SQLite 锁竞争**：DELETE 模式下的 journal 文件 unlink 在 VirtioFS 上不是原子的——两个写者竞争 unlink 同一个 `*.journal`，结果是 DB 损坏。单写者完全消除这个窗口。
2. **WAL `-shm` 跨边界不一致**：WAL 共享内存段映射的页号只在写者侧准确；只读读者直接读主数据文件就行，不需要 `-shm` 同步。
3. **写一半被对端读到**：DELETE 模式下 commit 即"主文件原子替换 + journal unlink"，读者再开连接就能读到完整数据；不存在"看到事务一半"的窗口（参考 §3.7）。

代价是要"反向"地解决两个问题：

- container 怎么把状态同步回 host？→ `outbound.db.processing_ack` 表（§3.5），host 轮询读，**不让 container 写 inbound.db**。
- container 心跳怎么放？→ 文件 `touch`，不是 DB（§3.6）。

---

### 3.4 Central DB：`data/v2.db`

Host 独占，跑在 host 进程的 better-sqlite3 上（`src/db/connection.ts:14`，`journal_mode = WAL`）。注意 central DB 是 **WAL 模式**——它不需要跨 mount，所以能享受 WAL 的并发读 + 单写性能。session DB 才用 DELETE。

下面这张总表覆盖了 v2.0.64 central DB 的所有 user-facing 表（不含 chat_sdk_*、不含已弃用的 `pending_credentials`）。

| 表 | 主要列 | 用途 | 主写入位置 |
|----|--------|------|----------|
| `agent_groups` | `id`, `name`, `folder` (UNIQUE), `agent_provider` | Agent workspace 注册表。1:1 对应 `groups/<folder>/` 目录（CLAUDE.md + skills） | `src/db/agent-groups.ts` |
| `messaging_groups` | `id`, `channel_type`, `platform_id` (UNIQUE), `name`, `is_group`, `unknown_sender_policy`, `denied_at` | 一个平台上的一个聊天/频道/DM | `src/db/messaging-groups.ts`，`src/router.ts:185` 自动创建 |
| `messaging_group_agents` | `id`, `messaging_group_id`, `agent_group_id` (UNIQUE 联合), `engage_mode`, `engage_pattern`, `sender_scope`, `ignored_message_policy`, `session_mode`, `priority` | 多对多 wiring：哪个 agent 处理哪个 channel | `src/db/messaging-groups.ts` |
| `users` | `id` (`channel:handle`), `kind`, `display_name` | 平台用户身份。一个真人可能有多行（每个平台一个） | `src/modules/permissions/db/users.ts` |
| `user_roles` | `(user_id, role, agent_group_id)` PK, `granted_by`, `granted_at` | 角色授予。`role ∈ {owner, admin}`；`owner` 必须 global | `src/modules/permissions/db/user-roles.ts` |
| `agent_group_members` | `(user_id, agent_group_id)` PK | 非特权用户的 "known" 成员关系。owner/admin 隐式成员 | `src/modules/permissions/db/agent-group-members.ts` |
| `user_dms` | `(user_id, channel_type)` PK → `messaging_group_id` | DM channel 缓存。让 host 发审批卡片不用每次都调 `openDM` | `src/modules/permissions/user-dm.ts:ensureUserDm` |
| `sessions` | `id`, `agent_group_id`, `messaging_group_id`, `thread_id`, `status`, `container_status`, `last_active` | Session 注册表。一行 = 一个文件夹 = 一个 container（运行时） | `src/db/sessions.ts`, `src/session-manager.ts:128` |
| `pending_questions` | `question_id` PK, `session_id`, `message_out_id`, `title`, `options_json` | `ask_user_question` MCP tool 暂存交互问题 | `src/db/sessions.ts` |
| `agent_destinations` | `(agent_group_id, local_name)` PK, `target_type` (channel/agent), `target_id` | Per-agent 出站目标地图 + ACL；详见 §3.4.2 | `src/db/agent-destinations.ts` |
| `pending_approvals` | `approval_id` PK, `session_id?`, `action`, `payload`, `agent_group_id?`, `channel_type?`, `platform_id?`, `platform_message_id?`, `status`, `title`, `options_json`, `expires_at?` | 两种工作流共享：session 内 MCP approval（install_packages / add_mcp_server）+ OneCLI credential approval | `src/db/sessions.ts`, `src/onecli-approvals.ts` |
| `pending_sender_approvals` | `id`, `messaging_group_id`, `agent_group_id`, `sender_identity`, `approver_user_id`, `original_message`, `title`, `options_json`. UNIQUE(messaging_group_id, sender_identity) | unknown sender 审批的 in-flight dedup + 原消息存档 | `src/modules/permissions/db/pending-sender-approvals.ts` |
| `pending_channel_approvals` | `messaging_group_id` PK, `agent_group_id`, `approver_user_id`, `original_message`, `title`, `options_json` | 未知 channel 注册请求（owner 决定是否启用 + 选哪个 agent） | `src/modules/permissions/db/pending-channel-approvals.ts` |
| `unregistered_senders` | `(channel_type, platform_id)` PK, `user_id?`, `sender_name?`, `reason`, `message_count`, `first_seen`, `last_seen` | 被 drop 消息的审计计数器；同一来源累加 | `src/db/dropped-messages.ts:recordDroppedMessage` |
| `container_configs` | `agent_group_id` PK, `provider`, `model`, `effort`, `image_tag`, `assistant_name`, `max_messages_per_prompt`, `skills`, `mcp_servers`, `packages_apt`, `packages_npm`, `additional_mounts`, `cli_scope` | Per-agent-group container 运行时配置。spawn 时序列化成 `groups/<folder>/container.json` | `src/db/container-configs.ts`, `src/modules/self-mod/apply.ts` |
| `chat_sdk_kv` | `key` PK, `value`, `expires_at?` | Chat SDK state adapter 的 KV 后端 | `src/state-sqlite.ts` |
| `chat_sdk_subscriptions` | `thread_id` PK, `subscribed_at` | Chat SDK 订阅状态 | `src/state-sqlite.ts` |
| `chat_sdk_locks` | `thread_id` PK, `token`, `expires_at` | Chat SDK 分布式锁（虽然只有一个 host，但 SDK 要求） | `src/state-sqlite.ts` |
| `chat_sdk_lists` | `(key, idx)` PK, `value`, `expires_at?` | Chat SDK list KV | `src/state-sqlite.ts` |
| `schema_version` | `version` PK, `name` UNIQUE, `applied` | Migration ledger | `src/db/migrations/index.ts` |

#### 3.4.1 entity 关系总览（central DB）

```
                +----------------+        +-------------------+
                | agent_groups   |        | messaging_groups  |
                |  id (PK)       |        |  id (PK)          |
                |  folder UNIQ   |        |  channel_type     |
                +----------------+        |  platform_id      |
                  ^   ^   ^               |  unknown_sender_  |
                  |   |   |               |    policy         |
                  |   |   |               |  denied_at?       |
       +----------+   |   |               +-------------------+
       |              |   |                        ^
       |              |   |                        |
+----------------+    |   |                +-------------------+
| sessions       |----+   |                | messaging_group_  |
|  id (PK)       |        |                | agents (M:N)      |
|  agent_group_  |        |                |  id (PK)          |
|    id          |        |                |  messaging_group_ |
|  messaging_    |--------+                |    id             |
|    group_id?   |                         |  agent_group_id   |
|  thread_id?    |                         |  engage_mode      |
|  container_    |                         |  engage_pattern?  |
|    status      |                         |  sender_scope     |
+----------------+                         |  session_mode     |
       |                                   |  priority         |
       |                                   +-------------------+
       v                                            |
+----------------+         +----------------+       |
| pending_       |         | agent_         |<------+
|   questions    |         |   destinations |  (host必须保持
|  question_id   |         |  (ag_id,       |   两表同步)
|  session_id    |         |   local_name)  |
+----------------+         |  target_type   |
                           |  target_id     |
                           +----------------+

       +----------+      +---------------+        +-----------------+
       | users    |<---->| user_roles    |        | agent_group_    |
       |  id      |      |  (user, role, |        |   members       |
       |  kind    |      |   ag_id?)     |        |  (user, ag_id)  |
       +----------+      +---------------+        +-----------------+
            |                                              ^
            |   +----------+                               |
            +-->| user_dms |   pending_sender_approvals ---+
                | (user,   |   pending_channel_approvals
                |  channel)|
                +----------+
```

#### 3.4.2 `agent_destinations`：投影到 session inbound 的 ACL

这张表既是**路由表**也是**权限表**。

```sql
CREATE TABLE agent_destinations (
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  local_name     TEXT NOT NULL,
  target_type    TEXT NOT NULL,   -- 'channel' | 'agent'
  target_id      TEXT NOT NULL,   -- messaging_group_id | agent_group_id
  created_at     TEXT NOT NULL,
  PRIMARY KEY (agent_group_id, local_name)
);
```

- agent 调 `send_message(to="dev-channel")` → container 在自己的 `inbound.db.destinations` 里查 `name='dev-channel'`。
- 行存在 = 允许；行不存在 = `unknown destination` 拒绝。
- Per-agent 命名空间：agent A 可以叫某 channel "parent"，同一个 channel 在 agent B 那里叫 "worker-1"，互不冲突。

**投影不变量**：central 的 `agent_destinations` 是 source of truth；container 实际读的是 session 自己的 `inbound.db.destinations`。任何修改 central 表的代码都必须同时调 `writeDestinations()`（`src/session-manager.ts` 的注释指明），否则 container 用的就是旧 ACL。已知调用点：

- `src/container-runner.ts:119-120`：每次 container wake 都重新投影。
- `src/db/messaging-groups.ts:163-166`：新增 wiring 时。
- `src/modules/agent-to-agent/create-agent.ts:116`：动态创建 child agent 时。

---

### 3.5 Session DBs：`inbound.db` 与 `outbound.db`

Session DB 是真正跨 mount 的那一对。Schema 常量在 `src/db/schema.ts`（`INBOUND_SCHEMA` 和 `OUTBOUND_SCHEMA`），写盘走 `ensureSchema()`（`src/db/session-db.ts:13`）：

```ts
export function ensureSchema(dbPath: string, schema: 'inbound' | 'outbound'): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');         // 不是 WAL —— 见 §3.7
  db.exec(schema === 'inbound' ? INBOUND_SCHEMA : OUTBOUND_SCHEMA);
  db.close();
}
```

#### 3.5.1 `inbound.db`：host → container

表结构（来自 `src/db/schema.ts:157-219`）：

```sql
CREATE TABLE IF NOT EXISTS messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,                  -- EVEN（host 分配）
  kind           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',          -- pending|completed|failed|paused
  process_after  TEXT,                            -- 调度延迟
  recurrence     TEXT,                            -- cron 表达式
  series_id      TEXT,                            -- 把同一系列的复发任务串起来
  tries          INTEGER DEFAULT 0,
  trigger        INTEGER NOT NULL DEFAULT 1,      -- 0=纯上下文不唤醒, 1=唤醒 agent
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL,                   -- JSON，按 kind 不同
  source_session_id TEXT,                         -- agent-to-agent 的反向路由
  on_wake        INTEGER NOT NULL DEFAULT 0       -- 仅在 container 首次 poll 时投递
);
CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id);

CREATE TABLE IF NOT EXISTS delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,                       -- 平台上的真实消息 id
  status              TEXT NOT NULL DEFAULT 'delivered',
  delivered_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS destinations (
  name            TEXT PRIMARY KEY,
  display_name    TEXT,
  type            TEXT NOT NULL,                  -- 'channel' | 'agent'
  channel_type    TEXT,
  platform_id     TEXT,
  agent_group_id  TEXT
);

CREATE TABLE IF NOT EXISTS session_routing (
  id           INTEGER PRIMARY KEY CHECK (id = 1), -- 单行表
  channel_type TEXT,
  platform_id  TEXT,
  thread_id    TEXT
);
```

四张表的角色分工：

- `messages_in`：每条入站消息一行。Container 轮询 `status='pending' AND (process_after IS NULL OR process_after <= now)`。
- `delivered`：host 把出站消息投递到平台之后写一行，记下 `platform_message_id`。**container 读它**用于做 `edit_message(seq=N)` 和 `add_reaction(seq=N)`——agent 需要知道"我刚才那条 chat 消息在 Discord 上对应哪个 message id"。
- `destinations`：§3.4.2 提到的 ACL/路由投影。Container 解析 `send_message(to="...")` 时直接查这张表。`writeDestinations()` 在 container 每次 wake 时整表 DELETE + INSERT。
- `session_routing`：单行（`id=1`）默认路由。Agent 不指定 `to` 的时候，回复落到这一行指定的 `(channel_type, platform_id, thread_id)`。Container wake 时由 `writeSessionRouting()`（`src/session-manager.ts:156`）覆盖。

**写者（host）**：`insertMessage()` / `insertTask()` / `insertRecurrence()`（`src/db/session-db.ts:94-134`）。每次调 `nextEvenSeq()` 分配偶数 seq。

**读者（container）**：`container/agent-runner/src/db/messages-in.ts` 的轮询，以及前面提到的 `delivered` / `destinations` / `session_routing` 三张表的查询。

#### 3.5.2 `outbound.db`：container → host

表结构（来自 `src/db/schema.ts:222-266`）：

```sql
CREATE TABLE IF NOT EXISTS messages_out (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,                  -- ODD（container 分配）
  in_reply_to    TEXT,                            -- messages_in.id（agent 在回复哪条）
  timestamp      TEXT NOT NULL,
  deliver_after  TEXT,
  recurrence     TEXT,
  kind           TEXT NOT NULL,                   -- chat|chat-sdk|system|...
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL                    -- JSON；edit/reaction/card/... 都在 content 里
);

CREATE TABLE IF NOT EXISTS processing_ack (
  message_id     TEXT PRIMARY KEY,                -- 对应 messages_in.id
  status         TEXT NOT NULL,                   -- processing|completed|failed
  status_changed TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS container_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  current_tool             TEXT,
  tool_declared_timeout_ms INTEGER,               -- 比如 Bash 自带的 timeout 提示
  tool_started_at          TEXT,
  updated_at               TEXT NOT NULL
);
```

四张表的角色分工：

- `messages_out`：所有 agent 产生的东西——chat 回复、edit、reaction、card、ask_question、agent-to-agent 调用、system action。Host 轮询 `getDueOutboundMessages()`（`src/db/session-db.ts:258`）拣出 `deliver_after IS NULL OR deliver_after <= now` 的行去投递。
- `processing_ack`：**container 不能写 `inbound.db`**，所以"这条 in 我开始处理了 / 处理完了 / 失败了"必须走这里。Host 的 `syncProcessingAcks()`（`src/db/session-db.ts:169`）轮询读出 completed/failed 的行，把对应的 `messages_in.status` 也设成 completed。
- `session_state`：Container 持久 KV。最主要的 key 是 Claude SDK 的 session id——存这里之后，container 重启就能 `--continue` 接着上次的对话。`/clear` 会清这张表。
- `container_state`：单行（`id=1`）"当前在跑哪个 tool"。Container 在 PreToolUse hook 写、PostToolUse hook 清。Host sweep 读它来**扩大 stuck 容忍窗口**——比如 Bash 声明了 `timeout=600s`，host 就不应该把这个 container 当成卡死。

**写者（container）**：`container/agent-runner/src/db/messages-out.ts:writeMessageOut`、`messages-in.ts` 写 `processing_ack`、`session-state.ts` 写 `session_state`、`connection.ts` 的 `setContainerToolInFlight` / `clearContainerToolInFlight` 写 `container_state`。

**读者（host）**：`src/delivery.ts` 拣 `messages_out`；`src/host-sweep.ts` 拣 `processing_ack` 和 `container_state`。

> 注：`session_state` 与 `container_state` 是 lazy 添加的——`container/agent-runner/src/db/connection.ts:86-110` 用 `CREATE TABLE IF NOT EXISTS` 在每次打开 outbound DB 时按需创建，老 session 文件夹也能用。

---

### 3.6 Seq 奇偶约定

`messages_in.seq` 和 `messages_out.seq` 都是 SQLite `INTEGER UNIQUE`，但 **它们的命名空间被故意拆成"偶数全归 host"和"奇数全归 container"**：

```
inbound  | outbound
---------|-----------
seq=2    | seq=1
seq=4    | seq=3
seq=6    | seq=5
seq=8    | seq=7
...      | ...
```

#### Host 侧（`src/db/session-db.ts:75-92`）

```ts
export function nextEvenSeq(db: Database.Database): number {
  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  return maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);
}
```

`insertMessage()` 第 132 行 `seq: nextEvenSeq(db)`——每次 host 插入新入站消息都先取下一个偶数。

#### Container 侧（`container/agent-runner/src/db/messages-out.ts:54`）

```ts
const maxOut = (outbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
const maxIn  = (inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
const max = Math.max(maxOut, maxIn);
const nextSeq = max % 2 === 0 ? max + 1 : max + 2;   // 下一个奇数
```

注意 container 在算 `max` 的时候是**跨两个表**取 max——这保证 seq 是**全局单调递增**的，不会出现 host 写了 seq=8，container 才写到 seq=3 的倒退。

#### 为什么要这样？

`seq` 是 **agent 视角下的消息 id**。Agent 调用 `edit_message(5)` / `add_reaction(6)` 的时候，runtime 用 `getMessageIdBySeq(seq)` 反查具体 row。**只看奇偶就能知道这条 seq 属于哪张表**——奇数 → `messages_out`，偶数 → `messages_in`——不用 join 就能消歧。

如果两张表共享命名空间，host 写了 seq=5、container 也写了 seq=5，那 agent 的"edit 第 5 条"就成了俄罗斯轮盘。

这个不变量**不是数据库约束**，只靠 `nextEvenSeq()` 和 `writeMessageOut()` 这两个函数维护。`src/modules/scheduling/db.ts` 的定时任务插入路径之所以 export 了 `nextEvenSeq`，就是为了让它在不走 `insertMessage()` 的情况下仍然保持偶数。任何新写者必须沿用这个约定。

---

### 3.7 跨 mount 不变量：DELETE 模式与 open-write-close

`container/agent-runner/src/db/connection.ts` 顶部有一段触目惊心的注释（第 1-19 行），值得逐字读：

```
Two-DB connection layer.

The session uses two SQLite files to eliminate write contention across
the host-container mount boundary:

  inbound.db  — host writes new messages here; container opens READ-ONLY
  outbound.db — container writes responses + acks here; host opens read-only

Each file has exactly one writer, so no cross-process lock contention.

⚠ Cross-mount visibility: inbound.db MUST be journal_mode=DELETE (set by
the host when the file is created). WAL's `-shm` is memory-mapped and
VirtioFS does not propagate mmap coherency from host to guest, so a
WAL-mode inbound.db would leave this reader frozen on an early snapshot
and it would silently never see new host messages. See
src/session-manager.ts for the full set of cross-mount invariants and
scripts/sanity-live-poll.ts for the empirical validation.
```

`src/session-manager.ts:1-12` 同样把三条不变量列出来：

```
Two-DB split — inbound.db (host writes) + outbound.db (container writes).
Three cross-mount invariants are load-bearing:
  1. journal_mode=DELETE — WAL's mmapped -shm doesn't refresh host→guest;
     the container would silently miss every new message.
  2. Host opens-writes-CLOSES per op — close invalidates the container's
     page cache; a long-lived connection freezes its view at first read.
  3. One writer per file — DELETE-mode journal-unlink isn't atomic across
     the mount; concurrent writers corrupt the DB.
```

#### 不变量 1：`journal_mode = DELETE`

- WAL 模式下，**所有写入先进入 `-wal` 文件**，读者依赖 `-shm`（共享内存 mmap 段）里的页号定位 wal 中的数据。
- VirtioFS / NFS / 9p 都不可靠地传递 mmap 一致性——host 写入 `-wal` 之后，container 侧的 mmap 拿到的是旧 snapshot。
- DELETE 模式下，commit 等价于 "把脏页写回主文件，原子 unlink journal"。读者重新打开连接就能看到最新内容，**不依赖 mmap**。

`ensureSchema()` 第 15 行 `db.pragma('journal_mode = DELETE')`、container 侧 `getOutboundDb()` 第 78 行 `_outbound.exec('PRAGMA journal_mode = DELETE')` 都在严格遵守这条。

#### 不变量 2：Host 必须 open-write-close

`src/session-manager.ts:189-192` 在 `writeSessionMessage` 上挂着大字告警：

```
⚠ Opens and closes the DB on every call. Do not refactor to reuse a
long-lived connection — see the "Cross-mount visibility invariants" note
at the top of this file.
```

原因：SQLite 的写入只有在**连接 close 时**才会把所有页 flush 到 OS page cache（DELETE 模式更是 commit 即 flush）。如果 host 用长连接，container 侧的 page cache 永远停在第一次读到的 snapshot。

Container 侧也有对应处理：`openInboundDb()`（`container/agent-runner/src/db/connection.ts:45-57`）每次都 `new Database(..., {readonly: true})` 且 `PRAGMA mmap_size = 0`，**禁用 mmap 缓存**——这样每次查询都强制从磁盘读，跨 mount 一致性才能保证。

#### 不变量 3：每个文件一个写者

DELETE 模式下，commit 包含 journal 文件 unlink。VirtioFS 不保证 unlink 跨 host/guest 是原子的——两个写者同时 commit 会出现一个 unlink 成功、另一个看到"journal 还在"的状态，结果 DB 损坏。

所以 host 永远不写 outbound，container 永远不写 inbound。`openOutboundDbRw()`（`src/db/session-db.ts:36`）注释说："Only safe to call when no container is running"——这是 host 杀掉 container 之后做清理的逃生口，正常 happy path 上 host 只用 `openOutboundDb()`（只读）。

#### 为什么不能用 WAL（再说一遍）

```
WAL writer 视角                  WAL reader 视角（container）
  +-----------+                    +-----------+
  | main.db   |                    | main.db   |
  +-----------+                    +-----------+
  | -wal      |  <- 新 commit      | -wal      |  <- mmap 可能停在旧版本
  +-----------+                    +-----------+
  | -shm      |  <- mmap 索引      | -shm      |  <- mmap 不一致
  +-----------+                    +-----------+

DELETE writer 视角               DELETE reader 视角
  +-----------+                    +-----------+
  | main.db   |  <- 直接更新       | main.db   |  <- 每次开连接重读
  +-----------+                    +-----------+
  | -journal  |  <- commit 时 unlink
  +-----------+
```

WAL 在共享文件系统、单机多进程里很优秀；但在 host↔guest 之间，"共享 mmap 段"这个前提不成立，所以只能 DELETE。

---

### 3.8 心跳：文件 `touch` 而不是 DB 写

Container 每隔几秒要告诉 host"我还活着"。最直觉的做法是 update 一行 `processing_ack` 或者插入一条心跳消息，但 NanoClaw 选择了**文件 mtime**：

```ts
// container/agent-runner/src/db/connection.ts:156-168
export function touchHeartbeat(): void {
  const p = _heartbeatPath;
  const now = new Date();
  try {
    fs.utimesSync(p, now, now);
  } catch {
    try {
      fs.writeFileSync(p, '');
    } catch {
      // Silently ignore — parent dir may not exist (e.g., in-memory test DBs)
    }
  }
}
```

路径是 `/workspace/.heartbeat`（container 视角；host 侧由 `heartbeatPath()` 计算）。Host 用 `fs.statSync(p).mtimeMs` 判断"是不是太久没动了"。

**为什么不用 DB？**

- DB 写要走 SQLite 的写锁。即使是单写者文件，每次心跳都触发一次 `BEGIN/COMMIT`，要 fsync 一次，要 unlink 一次 journal——白白增加 IO。
- 心跳和正常工作（messages_out 写入）会**互相排队**——container 一边 ack 处理状态、一边写心跳，两者抢同一个 SQLite 写锁，会拖慢真正的工作。
- 文件 `utimes(2)` 是一个 inode 元数据更新，单系统调用，**不用走 SQLite 也不用走 page cache flush**。host 侧 `stat(2)` 同样是一个系统调用。

代价：心跳不是 transaction 的一部分，意味着"心跳活着但 DB 卡住"是可能发生的——所以 host sweep 还会读 `container_state.tool_started_at` 来综合判断，而不是只看心跳（详见 host-sweep 章节）。

---

### 3.9 Migration 系统

#### 调度器

入口：`src/db/migrations/index.ts:40-77`。流程：

1. 创建 `schema_version` 表（如果不存在）和 `idx_schema_version_name` 唯一索引。
2. 读取**已应用 migration 的 `name` 集合**（不是 version！见下文）。
3. 对 `migrations` 数组里**没有出现过的 name** 依次执行，每个跑在自己的 transaction 里：
   - 运行 `m.up(db)`。
   - 计算新的 version = `MAX(version) + 1`（**applied-order 编号，不是 m.version**）。
   - 插入 `schema_version (version, name, applied)`。

```ts
// src/db/migrations/index.ts:50-58 摘录
const applied = new Set<string>(
  (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((r) => r.name),
);
const pending = migrations.filter((m) => !applied.has(m.name));
```

唯一性是 **按 `name` 而不是按 `version`**——这是有意为之，让"模块化 migration"（install skill 时塞进来的 `module-*.ts`）可以任意挑 version 号，不用跟 core 协调。`version` 字段只在 `migrations` 数组里当作 ordering hint；落表的 version 列是按"我是第几个被 apply 的"自增。

#### 命名约定

- `NNN-<name>.ts`：core migration，按顺序号编排。比如 `001-initial.ts`、`014-container-configs.ts`。
- `module-<name>.ts`：模块化 migration，原本是 `003-pending-approvals.ts` / `004-agent-destinations.ts` / `007-pending-approvals-title-options.ts`，**已经被 install 在用户机器上了**。后来这些代码被拆进可选模块，要避免重复 apply——所以 `name` 字段保持原值（`pending-approvals` / `agent-destinations` / `pending-approvals-title-options`），只把文件名加 `module-` 前缀。
- 编号 005、006 是**有意空缺的**——早期开发时被重新编号过。

#### 全部 migration 文件清单（v2.0.64）

`src/db/migrations/` 目录在这个版本下面：

| 文件 | name | 引入的内容 |
|------|------|----------|
| `001-initial.ts` | `initial-v2-schema` | 9 张核心表：`agent_groups`、`messaging_groups`、`messaging_group_agents`、`users`、`user_roles`、`agent_group_members`、`user_dms`、`sessions`、`pending_questions` |
| `002-chat-sdk-state.ts` | `chat-sdk-state` | Chat SDK 4 张支撑表：`chat_sdk_kv`、`chat_sdk_subscriptions`、`chat_sdk_locks`、`chat_sdk_lists` |
| `module-approvals-pending-approvals.ts` | `pending-approvals` | `pending_approvals` 表 + `idx_pending_approvals_action_status` 索引；OneCLI credential approval + session-bound MCP approval 共享 |
| `module-agent-to-agent-destinations.ts` | `agent-destinations` | `agent_destinations` 表 + backfill：把现有 `messaging_group_agents` wiring 投影出来，per-agent 命名空间避免冲突 |
| `module-approvals-title-options.ts` | `pending-approvals-title-options` | 给 `pending_approvals` 追加 `title` + `options_json`（针对编号 003 在野外被改过的修复） |
| `008-dropped-messages.ts` | `dropped-messages` | `unregistered_senders` 审计计数器表 |
| `009-drop-pending-credentials.ts` | `drop-pending-credentials` | 干掉废弃的 `pending_credentials` 表 |
| `010-engage-modes.ts` | `engage-modes` | 拆 `trigger_rules` JSON 为四列：`engage_mode` / `engage_pattern` / `sender_scope` / `ignored_message_policy`；JS 端 row-by-row backfill，最后 DROP 旧两列 |
| `011-pending-sender-approvals.ts` | `pending-sender-approvals` | `pending_sender_approvals` 表（unknown sender 审批 in-flight dedup） |
| `012-channel-registration.ts` | `channel-registration` | `messaging_groups.denied_at` 列 + `pending_channel_approvals` 表（owner 注册未知 channel 的审批） |
| `013-approval-render-metadata.ts` | `approval-render-metadata` | 给两张 pending_*_approvals 表追加 `title` + `options_json` |
| `014-container-configs.ts` | `container-configs` | `container_configs` 表（per-agent-group container 运行时配置） |
| `015-cli-scope.ts` | `cli-scope` | `container_configs.cli_scope` 列（CLI 工具的可见范围：disabled / group / global） |

注意有几条 migration **本身就在示范不变量**：

- 010 用 JS 而不是 SQL 做 backfill——因为 SQL 端解 JSON 太痛苦。
- 011 故意**不重建** `messaging_groups` 来翻 DEFAULT，因为 FK 在 implicit transaction 里关不掉，DROP+CREATE 会触发引用完整性错误。改成在调用方（`src/router.ts:192`）硬编码 `'request_approval'`。
- 013 的 `addIfMissing()` 用 try/catch 吞掉 "duplicate column"，让新装机器跑 003 的最新定义之后，再跑 007 也安全。

#### Session DB 没有 numbered migration

`INBOUND_SCHEMA` / `OUTBOUND_SCHEMA` 全部用 `CREATE TABLE IF NOT EXISTS`，新建 session 直接就是当前最新 schema。**老 session 文件夹**靠 lazy migration 补救：

- `migrateDeliveredTable()`（`src/db/session-db.ts:293`）：给老 session 的 `delivered` 加 `platform_message_id`、`status`。
- `migrateMessagesInTable()`（`src/db/session-db.ts:308`）：给老 session 的 `messages_in` 加 `series_id`、`trigger`、`source_session_id`、`on_wake`，并 backfill 默认值。
- container 侧 `getOutboundDb()` 在 §3.5.2 的代码片段里也做了类似的 `session_state.updated_at` 和 `container_state` 的 lazy add。

新增 session DB 列时**必须**写对应的 lazy migration，且**默认值要让旧数据语义不变**（trigger 默认 1 而不是 0，等等）。

---

### 3.10 运维工具：`scripts/q.ts`

NanoClaw 默认不假设 host 上装了 `sqlite3` CLI（fresh Ubuntu 通常没装），所以 skill 文本里所有的 SQL 操作都走一个统一的 wrapper：

```bash
pnpm exec tsx scripts/q.ts <db-path> "<sql>"
```

实现非常薄（`scripts/q.ts`，全 59 行）：

```ts
const db = new Database(dbPath);
try {
  try {
    const stmt = db.prepare(sql);
    if (stmt.reader) {
      // SELECT / WITH...SELECT — 打印 pipe 分隔的 list 格式（兼容 sqlite3 CLI 默认）
      const rows = stmt.all() as Record<string, unknown>[];
      for (const row of rows) {
        console.log(Object.values(row).map((v) => (v === null ? '' : String(v))).join('|'));
      }
    } else {
      stmt.run();
    }
  } catch (e: unknown) {
    // better-sqlite3 不允许单语句 prepare 含多条；compound mutation 走 exec
    if (e instanceof Error && /more than one statement/i.test(e.message)) {
      db.exec(sql);
    } else { throw e; }
  }
} finally {
  db.close();
}
```

要点：

- **输出格式跟 `sqlite3` CLI 一致**（管道分隔、无表头），让 skill 文本不用改写就能复用。
- 用 `stmt.reader` 区分 query vs mutation——SELECT 走 `stmt.all()`，其余走 `stmt.run()`。
- compound mutation（`DELETE ...; INSERT ...;`）触发 better-sqlite3 的 "more than one statement" 错误，fallback 到 `db.exec()`。

常见用法：

```bash
# 看所有 session
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, agent_group_id, container_status FROM sessions"

# 看某个 session 的 inbound 消息
pnpm exec tsx scripts/q.ts data/v2-sessions/<ag>/<sid>/inbound.db \
  "SELECT seq, status, trigger, kind FROM messages_in ORDER BY seq"

# 看某个 session 的 outbound + ack 联表
pnpm exec tsx scripts/q.ts data/v2-sessions/<ag>/<sid>/outbound.db \
  "SELECT m.seq, m.kind, a.status FROM messages_out m
     LEFT JOIN processing_ack a ON a.message_id = m.in_reply_to
     ORDER BY m.seq"
```

这个 wrapper 同时也是**调试三 DB 状态的最直接路径**：当 container 卡住、消息没发出去、approval 没触发的时候，先用 `q.ts` 把三张 DB 的相关行打出来——绝大多数 bug 在数据层就能定位。

---

### 3.11 设计模式速查

| 模式 | 出现位置 | 一句话总结 |
|------|---------|----------|
| 两 DB session 拆分 | `inbound.db` + `outbound.db` | 每个文件一个写者，消除跨 mount 锁竞争 |
| Seq 奇偶 | `nextEvenSeq` / `writeMessageOut` | 双 writer 不会撞 id，agent 可以单凭 seq 定位 row |
| Projection 投影 | `agent_destinations` → session `destinations` / `session_routing` | central 是真值，session 是 fast local |
| Reverse-channel ack | `outbound.db.processing_ack` | container 永远不写 inbound；状态走出站表 |
| Heartbeat 出 band | `.heartbeat` 文件 mtime | 心跳不抢 SQLite 写锁 |
| Lazy session migration | `migrateDeliveredTable` / `migrateMessagesInTable` | session DB 不走 numbered migration，按需补列 |
| ACL = 行存在 | `agent_destinations` row 即权限 | 没有独立的 permissions 表 |
| Name-based migration ledger | `schema_version.name` UNIQUE | 模块化 migration 可以任挑 version 号 |

后续章节会大量使用这些表名和列名，本章是回查点。
