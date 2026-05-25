## 实体模型与权限

本章把 NanoClaw 的"谁是谁、谁能做什么"分解清楚。第 3 章定义了表结构，本章定义这些表上承载的**实体语义**和**访问控制规则**：用户身份怎么编码、wiring 怎么决定哪个 agent 接待哪条消息、isolation level 怎么影响 session 数量、未知发送者怎么走审批、CLI socket 凭什么直接认 owner。

> 本章的所有 access 决策都收敛到一个函数：`canAccessAgentGroup()`（`src/modules/permissions/access.ts:21`）。理解这条函数就理解了 NanoClaw 的权限模型。

---

### 4.1 设计问题：跨平台、多 agent、多用户的统一权限平面

NanoClaw 服务于的不是单一渠道。一台机器上的 host 可能同时挂着：

- 多个**平台**（Discord、Telegram、Slack、Teams、iMessage、Email、Matrix、CLI、Webhook、定时任务）。
- 多个**账号**：一个真人在 Telegram 上是 `tg:123`，在 Discord 上是 `discord:abc`，在 WhatsApp 上是 `phone:+1555...`——NanoClaw 不假定能跨平台 link 同一个人。
- 多个 **agent group**：dev agent（共享给 GitHub + Slack）、家用 agent（Telegram DM）、工作 agent（Slack channel）——每个 agent group 有自己的 workspace、CLAUDE.md、container 配置。
- 多种**身份**：owner（你自己）、global admin（可信合作伙伴）、scoped admin（只管某个 group）、unprivileged member（朋友/同事）、陌生人（路人/机器人）。

对每条入站消息，host 必须在 10ms 内决定：

1. 这条消息**进不进**？（路由出口）
2. 进了之后**送到哪个 session**？（session 解析）
3. session 处理之后**回到哪个 channel**？（reply routing）
4. agent 输出 `send_message(to=...)` / `create_agent(...)` 时**有没有权限**？
5. 用户发 `/clear`、`/compact` 等敏感命令时**算不算 admin**？
6. 看见陌生人时**给谁发审批卡片**？

这些问题不能交给容器决定（容器是 agent 跑的地方，不可信）；也不能完全 hardcode 进 channel adapter（每个 channel 不知道全局规则）。NanoClaw 把它们全部放在 **central DB + permissions 模块**里，由 host 在 router 阶段统一裁决。

---

### 4.2 核心实体

#### `users`：平台用户身份

```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,        -- 'tg:123', 'discord:456', 'phone:+1555...', 'email:a@x.com'
  kind         TEXT NOT NULL,           -- channel_type
  display_name TEXT,
  created_at   TEXT NOT NULL
);
```

要点：

- `id` 是 **namespaced**：`<channel_type>:<handle>`。一个真人在不同平台是不同 user 行，**目前没有跨平台 link**。
- 由 `extractAndUpsertUser()`（`src/modules/permissions/index.ts:67`）在 sender resolver hook 里 lazy 创建——第一次见到这个 sender 就 upsert 一行，display_name 用平台给的名字。
- 写入路径：`src/modules/permissions/db/users.ts:upsertUser`。

#### `user_roles`：用户级权限

```sql
CREATE TABLE user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,                       -- 'owner' | 'admin'
  agent_group_id TEXT REFERENCES agent_groups(id),    -- NULL = global
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
```

四种身份语义：

| 身份 | 行表示 | 能做什么 |
|------|--------|---------|
| **owner** | `(user, 'owner', NULL)` | 全部 agent group 的所有事；唯一可以授予 global admin / scoped admin 的人 |
| **global admin** | `(user, 'admin', NULL)` | 全部 agent group 的所有事；不能再授予 owner |
| **scoped admin** | `(user, 'admin', <agent_group_id>)` | 仅这一个 agent group 的所有事；隐式成员（不需要 `agent_group_members` 行） |
| **member（未特权）** | 无 user_roles 行，但 `agent_group_members` 有行 | 只能在该 agent group 内**收发消息**；不能跑 `/clear` 等 admin 命令 |

不变量（`src/modules/permissions/db/user-roles.ts:8`）：

```ts
export function grantRole(row: UserRole): void {
  if (row.role === 'owner' && row.agent_group_id !== null) {
    throw new Error('owner role must be global (agent_group_id = null)');
  }
  ...
}
```

owner 必须 global，不能 scope 到某个 agent group——"owner of agent group X" 这种身份在 NanoClaw 的模型里**不存在**，要表达"只管 X 的最高权限"用的是 **scoped admin**。

#### `agent_group_members`：未特权成员关系

```sql
CREATE TABLE agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);
```

- "我（owner / scoped admin）允许这个用户在这个 agent group 内说话"的显式表达。
- Owner / global admin / scoped admin **不需要这一行**——他们隐式是所有相关 group 的成员（见 `isMember()` 的实现）。
- 写入触发点：批准 unknown-sender 审批卡片时（`index.ts:251-257`）、批准 unknown-channel 审批卡片时（`index.ts:489-495`）、手动通过 admin tooling。

#### `user_dms`：cold-DM 缓存

```sql
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);
```

- 给一个 user 在某个 channel 上发**主动消息**（审批卡片、pairing 提示、host 通知）时，host 需要知道往哪个 messaging_group 投递。
- 由 `ensureUserDm()`（`src/modules/permissions/user-dm.ts:52`）lazy 填——cache miss 时根据 channel adapter 类型走两条路径之一：

```
Direct-addressable          Resolution-required
(Telegram, WhatsApp,        (Discord, Slack, Teams,
 iMessage, email, Matrix)    Webex, gChat)
                             
  user handle == DM           需要 adapter.openDM(handle)
  chat id；直接                 platform API 返回一个新
  new messaging_group         channel id；缓存到 user_dms
  with platform_id=handle
```

- 缓存命中只是一次 DB 读；命中失败才走 API。platform 侧的 `openDM` 都是幂等的，所以重试安全。

#### `messaging_groups`：一个平台上的一个"聊天"

```sql
CREATE TABLE messaging_groups (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,                   -- 'discord', 'tg', 'slack', 'cli', ...
  platform_id           TEXT NOT NULL,                   -- 平台 chat id
  name                  TEXT,
  is_group              INTEGER DEFAULT 0,               -- 0=DM/单人, 1=多人 group
  unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',  -- 'strict'|'request_approval'|'public'
  denied_at             TEXT,                            -- owner 拒绝注册 → 永久不响应
  created_at            TEXT NOT NULL,
  UNIQUE(channel_type, platform_id)
);
```

一行 = 一个"位置"：一个 Discord 频道、一个 Telegram 群、一个 Slack 私聊、一个 WhatsApp 群。

#### `agent_groups`：agent workspace

```sql
CREATE TABLE agent_groups (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL UNIQUE,                -- groups/<folder>/
  agent_provider   TEXT,                                -- 'claude' | 'codex' | 'onecli' ...
  created_at       TEXT NOT NULL
);
```

一行 = 一个 `groups/<folder>/` 目录，里面是 CLAUDE.md、skills、（spawn 时序列化的）container.json。Container 运行时配置在 `container_configs`（per agent group）。

#### `messaging_group_agents`：wiring（多对多）

这是把"messaging_group（哪里说话）"和"agent_group（谁来回答）"连起来的关键表：

```sql
CREATE TABLE messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  engage_mode            TEXT NOT NULL DEFAULT 'mention',
                         -- 'pattern' | 'mention' | 'mention-sticky'
  engage_pattern         TEXT,    -- regex; 必须当 engage_mode='pattern'; '.' = 总匹配
  sender_scope           TEXT NOT NULL DEFAULT 'all',     -- 'all' | 'known'
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',    -- 'drop' | 'accumulate'
  session_mode           TEXT DEFAULT 'shared',           -- 'shared'|'per-thread'|'agent-shared'
  priority               INTEGER DEFAULT 0,
  created_at             TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);
```

每一行（叫 mga，"messaging-group-agent"）回答了一个具体问题：**这个聊天 + 这个 agent，组合起来用什么规则？**

- `engage_*`：触发规则（§4.6）。
- `sender_scope`：是否要求发件人是 known member（§4.7）。
- `ignored_message_policy`：触发不通过时，消息是 drop 还是 accumulate 进 context。
- `session_mode`：触发后落到哪个 session（§4.4）。
- `priority`：多 wiring 撞车时的 tiebreak（高 priority 先评估）。

注意 UNIQUE 在 `(messaging_group_id, agent_group_id)` 上——一对 (chat, agent) 只能有一条 wiring，但**同一个 chat 可以 wiring 到多个 agent**（fan-out）；**同一个 agent 也可以 wiring 到多个 chat**。

#### `sessions`：(agent_group, messaging_group, thread) 的运行时容器入口

```sql
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),    -- agent-shared 模式下可 NULL
  thread_id          TEXT,                                    -- per-thread 模式下设置
  agent_provider     TEXT,
  status             TEXT DEFAULT 'active',
  container_status   TEXT DEFAULT 'stopped',
  last_active        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup     ON sessions(messaging_group_id, thread_id);
```

每一行对应 `data/v2-sessions/<agent_group_id>/<session_id>/` 文件夹（含 inbound.db + outbound.db）。`session_mode` 决定 session 怎么被复用（§4.4）。

#### Entity 关系（ASCII ER 图）

```
                +----------------+
                |    users       |
                |  id (channel:  |
                |     handle)    |
                |  kind          |
                |  display_name  |
                +----------------+
                  |  |  |  |
              ----+  |  |  +-----------+
              |      |  +---------+    |
              v      v            v    v
       +-----------+ +-------------+ +-----------+
       | user_     | | agent_      | | user_dms  |
       | roles     | | group_      | | (channel  |
       | (user,    | | members     | |  cache)   |
       |  role,    | | (user, ag)  | +-----------+
       |  ag?)     | +-------------+
       +-----------+        |
              |             |
              v             v
       +----------------------------+         +-----------------+
       |        agent_groups        |<------->| container_      |
       |  id, folder, name          |         |   configs       |
       +----------------------------+         +-----------------+
              ^         ^         ^
              |         |         |
              |         |         +-----------+
              |         |                     |
              |   +------------------+        |
              |   | messaging_group_ |        |
              |   |   agents (M:N)   |        |
              |   |  engage_mode     |        |
              |   |  engage_pattern  |        |
              |   |  sender_scope    |        |
              |   |  session_mode    |        |
              |   |  priority        |        |
              |   +------------------+        |
              |         ^                     |
              |         |                     |
              |   +------------------+        |
              |   | messaging_groups |        |
              |   |  channel_type    |        |
              |   |  platform_id     |        |
              |   |  is_group        |        |
              |   |  unknown_sender_ |        |
              |   |    policy        |        |
              |   |  denied_at?      |        |
              |   +------------------+        |
              |         ^                     |
              |         |                     |
              |   +------------------+        |
              +-->|     sessions     |<-------+
                  |  (agent_group_id, agent group 决定文件夹根)
                  |   messaging_group_id?, thread_id?)
                  +------------------+
                          |
                          v
                  data/v2-sessions/<ag>/<sid>/
                    inbound.db / outbound.db / .heartbeat
```

权限相关的三张表（`user_roles`、`agent_group_members`、`user_dms`）**完全独立于 wiring**——切断哪个 channel 接哪个 agent 不影响一个用户是不是 owner。

---

### 4.3 权限是 user-level，不是 agent-group-level

NanoClaw 一个关键设计决策：**特权挂在用户身上，不是挂在 agent group 身上**。

`src/db/schema.ts:9-10` 的注释直说：

```
-- Agent workspaces: folder, skills, CLAUDE.md.
-- All workspaces are equal; privilege lives on users, not groups.
```

#### `canAccessAgentGroup()`：唯一的访问入口

`src/modules/permissions/access.ts:21-28`：

```ts
export function canAccessAgentGroup(userId: string, agentGroupId: string): AccessDecision {
  if (!getUser(userId)) return { allowed: false, reason: 'unknown_user' };
  if (isOwner(userId)) return { allowed: true, reason: 'owner' };
  if (isGlobalAdmin(userId)) return { allowed: true, reason: 'global_admin' };
  if (isAdminOfAgentGroup(userId, agentGroupId)) return { allowed: true, reason: 'admin_of_group' };
  if (isMember(userId, agentGroupId)) return { allowed: true, reason: 'member' };
  return { allowed: false, reason: 'not_member' };
}
```

短路顺序：

1. `users` 行不存在 → 拒绝（`unknown_user`）
2. `user_roles(role='owner', agent_group_id=NULL)` → 允许（`owner`）
3. `user_roles(role='admin', agent_group_id=NULL)` → 允许（`global_admin`）
4. `user_roles(role='admin', agent_group_id=<target>)` → 允许（`admin_of_group`）
5. `agent_group_members(user, target)` → 允许（`member`）
6. 都不行 → 拒绝（`not_member`）

`isMember()` 的实现（`src/modules/permissions/db/agent-group-members.ts:28-36`）也再次确认这个短路：

```ts
export function isMember(userId: string, agentGroupId: string): boolean {
  if (isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId)) {
    return true;
  }
  const row = getDb()
    .prepare('SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1')
    .get(userId, agentGroupId);
  return !!row;
}
```

"admin @ A 隐式是 A 的 member"——所以 admin 拿到 scoped 角色之后**不需要再 add member**。

#### 谁调 `canAccessAgentGroup`？

- `src/modules/permissions/index.ts:184`：access gate hook，在 router 的 fan-out 阶段评估每个 wired agent。
- `src/modules/permissions/index.ts:205`：sender-scope gate hook，per-wiring 的 `sender_scope='known'` 检查。
- `src/modules/permissions/index.ts:239`：审批卡片回调时校验"点击者有权决定"。

#### `hasAdminPrivilege()`：admin-or-higher 检查

```ts
// src/modules/permissions/db/user-roles.ts:58-60
export function hasAdminPrivilege(userId: string, agentGroupId: string): boolean {
  return isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId);
}
```

用在 admin 命令网关（§4.9）和审批卡片"谁能决定"校验（`index.ts:239`、`index.ts:320`）。

---

### 4.4 三种 isolation level

`docs/isolation-model.md` 把它们叫 Level 1/2/3。每种对应 `session_mode` 的一个取值，**直接决定 session 数量**。

#### Level 1：Shared Session（多 channel 进同一个 conversation）

- `session_mode = 'agent-shared'`
- 同一个 agent group 下的**所有**入站（不管来自哪个 messaging_group）落到**一个 session**。
- 例：GitHub webhook + Slack channel → 同一个 agent 同一个对话。Agent 在 Slack 里讨论的 feature，可以在 GitHub PR comment 触发时直接引用。

Session 解析代码（`src/session-manager.ts:99-103`）：

```ts
if (sessionMode === 'agent-shared') {
  const existing = findSessionByAgentGroup(agentGroupId);
  if (existing) {
    return { session: existing, created: false };
  }
}
```

注意它**完全忽略** `messagingGroupId`——同一个 agent group 只会有一个 agent-shared session。

#### Level 2：Same agent, separate sessions（同一 agent，各 channel 独立对话）

- `session_mode = 'shared'`（per messaging-group）或 `'per-thread'`（per messaging-group + thread）。
- 同一个 agent group 在不同 messaging_group 上各开一个 session。workspace、memory、CLAUDE.md 共享，**对话历史分开**。
- 例：你在 Telegram 上有三个聊（私聊 / 项目群 / 家人群），都连同一个 agent group，各自一个 session。Agent 学到的知识可以跨 session 复用，但不会把项目讨论泄到家人群。

```ts
} else if (messagingGroupId) {
  const lookupThreadId = sessionMode === 'shared' ? null : threadId;
  // Scope lookup by agent_group_id so fan-out to multiple agents in the
  // same chat doesn't accidentally deliver to the wrong agent's session.
  const existing = findSessionForAgent(agentGroupId, messagingGroupId, lookupThreadId);
  if (existing) {
    return { session: existing, created: false };
  }
}
```

`'shared'` vs `'per-thread'` 的区别只在 `lookupThreadId` 是 `null` 还是 `threadId`——`shared` 把 thread 合并到一个 session，`per-thread` 每个 thread 一个 session。

#### Level 3：Separate agent groups（彻底隔离）

- 不是 `session_mode` 的事，而是 wiring 上**用不同 agent_group_id**。
- 每个 channel 接到自己专属的 agent group，folder / CLAUDE.md / memory / container 全部独立。
- 例：你和朋友的群 vs 你和团队的群——两个 agent group，朋友看不到团队聊什么。

#### Threaded adapter 的自动修正

Router 有一段微妙的逻辑（`src/router.ts:410-413`）：

```ts
let effectiveSessionMode = agent.session_mode;
if (adapterSupportsThreads && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
  effectiveSessionMode = 'per-thread';
}
```

如果 adapter 支持 thread（Slack、Discord）且这是一个 group chat：**强制 per-thread**，即使 wiring 写的是 `shared`。原因：threaded 平台上把所有 thread 塞进一个 session 会让 agent 的 context 失控。`agent-shared` 是显式的"跨 channel 共享"指令，要保留；DM（`is_group=0`）天然只有一个 thread 路径，不需要拆。

---

### 4.5 Session mode 与 session 解析全流程

把上一节的代码片段拼起来，`resolveSession()`（`src/session-manager.ts:92-133`）的完整决策树：

```
                    +-------------------+
                    | sessionMode = ?   |
                    +-------------------+
                       |        |        |
            agent-shared   shared    per-thread
                       |        |        |
                       v        v        v
        +-------------------+  +----------------------+  +-------------------+
        | findSessionByAg   |  | findSessionForAgent  |  | findSessionForAgent
        |   (agentGroupId)  |  |   (ag, mg, NULL)     |  |   (ag, mg,        |
        +-------------------+  +----------------------+  |    threadId)      |
                |                       |                +-------------------+
                v                       v                          |
              hit?                    hit?                         v
            yes / no                yes / no                     hit?
                                                              yes / no
                       \              |              /
                        v             v             v
                        如果命中： 返回 existing session
                        否则：    generateId() + createSession() + initSessionFolder()
```

`initSessionFolder()`（`session-manager.ts:136`）做三件事：

1. `mkdir -p` session 目录和 `outbox/`。
2. `ensureSchema(inboundDbPath, 'inbound')` —— 建 inbound.db 并写 DELETE journal mode。
3. `ensureSchema(outboundDbPath, 'outbound')` —— 同样建 outbound.db。

session 一旦建好，它的 `agent_group_id` 不变；后续每条入站消息只是往同一个 `inbound.db` 追加 row。

---

### 4.6 Trigger rules（engage_mode + engage_pattern）

哪些 wiring 在哪些消息上"激活"由 `evaluateEngage()`（`src/router.ts:364-395`）决定：

```ts
function evaluateEngage(
  agent: MessagingGroupAgent,
  text: string,
  isMention: boolean,
  mg: MessagingGroup,
  threadId: string | null,
): boolean {
  switch (agent.engage_mode) {
    case 'pattern': {
      const pat = agent.engage_pattern ?? '.';
      if (pat === '.') return true;
      try {
        return new RegExp(pat).test(text);
      } catch {
        // Bad regex: fail open so admin sees the agent responding + can fix.
        return true;
      }
    }
    case 'mention':
      return isMention;
    case 'mention-sticky': {
      if (isMention) return true;
      if (mg.is_group === 0) return false;   // DMs never use mention-sticky sensibly
      const existing = findSessionForAgent(agent.agent_group_id, mg.id, threadId);
      return existing !== undefined;
    }
    default:
      return false;
  }
}
```

三种模式：

| `engage_mode` | 触发条件 |
|---------------|---------|
| `pattern` | `engage_pattern` regex 匹配消息文本。`'.'`（默认）= 总触发，即 "catch-all"。Regex 解析失败时 **fail open**，让 admin 看到 agent 在回应并去修 |
| `mention` | 平台层 @ 提到 bot。`isMention` 由 channel adapter 在 SDK 层判定；agent 的 NanoClaw 显示名**无关**——用户是 @bot platform username，不是 @agent name |
| `mention-sticky` | 第一次必须被 @ 触发；之后**只要 session 已经存在**就继续触发（无需再 @）。DM 上不生效（DM 永远不会"忘记 sticky"） |

对 mention-sticky 的进一步逻辑（`src/router.ts:294-309`）：第一次触发时让 adapter `subscribe` 这个 thread，平台 push 的后续消息就直接带 subscribed 标志进来，省一次 @。

#### Fan-out 与 priority

Router 对每条入站消息**遍历所有 wired agent**（`src/router.ts:277-329`）：

```ts
for (const agent of agents) {
  const agentGroup = getAgentGroup(agent.agent_group_id);
  if (!agentGroup) continue;

  const engages = evaluateEngage(agent, messageText, isMention, mg, event.threadId);
  const accessOk = engages && (!accessGate || accessGate(event, userId, mg, agent.agent_group_id).allowed);
  const scopeOk = engages && (!senderScopeGate || senderScopeGate(event, userId, mg, agent).allowed);

  if (engages && accessOk && scopeOk) {
    await deliverToAgent(agent, agentGroup, mg, event, userId, adapter?.supportsThreads === true, true);
    engagedCount++;
    ...
  } else if (agent.ignored_message_policy === 'accumulate' && !(engages && (!accessOk || !scopeOk))) {
    // 不触发但要 accumulate context（trigger=0 写进 messages_in）
    await deliverToAgent(agent, agentGroup, mg, event, userId, adapter?.supportsThreads === true, false);
    accumulatedCount++;
  } else {
    log.debug('Message not engaged for agent (drop policy)', { ... });
  }
}
```

- **不是"挑一个赢家"**，而是**每个 wiring 独立评估**——多个 agent 都触发就**都唤醒**（各自的 session 各自跑）。
- `priority` 现在只是 ordering hint（决定遍历顺序），不做"高 priority 抢断"。源码里 `getMessagingGroupAgents()` 会按 priority desc 排序。
- 触发不通过 + `ignored_message_policy='accumulate'`：消息以 `trigger=0` 写进 session，**不唤醒** container 但下次唤醒时它能读到（"silent context"）。
- 触发不通过 + `'drop'`：消息直接 drop，不进 session。
- 注意 `accumulate` **不接受 access/scope refusal**——如果 engage 通过但 gate 拒绝，那是"不可信发件人"的安全决策，silently 存他的消息（含 attachment 落盘）就违背了 gate 的初衷。

---

### 4.7 Sender scope

`sender_scope` 列在 wiring 级，比 `messaging_groups.unknown_sender_policy` **更严格**：

- `'all'`：no-op，gate hook 总返回 allowed。
- `'known'`：要求 `canAccessAgentGroup(userId, agent.agent_group_id).allowed === true`，否则 deny。

代码（`src/modules/permissions/index.ts:201-209`）：

```ts
setSenderScopeGate(
  (_event, userId, _mg, agent): AccessGateResult => {
    if (agent.sender_scope === 'all') return { allowed: true };
    if (!userId) return { allowed: false, reason: 'unknown_user_scope' };
    const decision = canAccessAgentGroup(userId, agent.agent_group_id);
    if (decision.allowed) return { allowed: true };
    return { allowed: false, reason: `sender_scope_${decision.reason}` };
  },
);
```

典型用法：

- public 频道（`unknown_sender_policy='public'`）+ 仅 known sender 触发 → `sender_scope='known'`。一个 admin agent 挂在公共频道里只回答"自己人"的话。
- `request_approval` channel 上，普通信息可以走审批路径；某些 wiring 想完全跳过审批（"只服务已知用户，路人直接 drop 不发卡片"）→ `sender_scope='known'`。

---

### 4.8 未知发送者策略（unknown_sender_policy）

`messaging_groups.unknown_sender_policy` 决定**当 access gate 判定发件人不在 access list 时**怎么办：

| Policy | 行为 |
|--------|------|
| `'strict'`（默认） | 静默 drop。`recordDroppedMessage()` 写一行 `unregistered_senders`，counter 自增 |
| `'request_approval'` | 同样写审计 + **触发 `requestSenderApproval` 流程**：选一个 approver（owner / agent group admin）+ ensureUserDm 拿到他的 DM channel + 发 ask_question 审批卡片 + 写 `pending_sender_approvals` 行 |
| `'public'` | 跳过 access gate，所有人都能发——只看 wiring 自己的 trigger/scope 规则 |

代码：`handleUnknownSender()`（`src/modules/permissions/index.ts:113-169`）和 `requestSenderApproval()`（`src/modules/permissions/sender-approval.ts:54-148`）。

#### `pending_sender_approvals` 的 in-flight dedup

```sql
CREATE TABLE pending_sender_approvals (
  id                 TEXT PRIMARY KEY,
  messaging_group_id TEXT NOT NULL,
  agent_group_id     TEXT NOT NULL,
  sender_identity    TEXT NOT NULL,          -- channel_type:handle
  sender_name        TEXT,
  original_message   TEXT NOT NULL,          -- JSON of the InboundEvent (重放用)
  approver_user_id   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  title              TEXT NOT NULL DEFAULT '',
  options_json       TEXT NOT NULL DEFAULT '[]',
  UNIQUE(messaging_group_id, sender_identity)
);
```

`UNIQUE(messaging_group_id, sender_identity)` 是关键——同一个陌生人在卡片还没决定之前再发一条消息，`hasInFlightSenderApproval()` 短路掉，**不发第二张卡片**（避免 admin 被刷屏）。

```ts
// src/modules/permissions/sender-approval.ts:58-65
if (hasInFlightSenderApproval(messagingGroupId, senderIdentity)) {
  log.debug('Unknown-sender approval already in flight — dropping retry', { ... });
  return;
}
```

#### 审批通过的回放

`handleSenderApprovalResponse()`（`src/modules/permissions/index.ts:225-286`）的批准分支：

1. 校验点击者：必须是原 approver 本人 **或** 对该 agent group 有 admin 特权。
2. `addMember()`：把 sender 加入 `agent_group_members`。
3. `deletePendingSenderApproval()`：**先**清掉 pending 行——这样下面 `routeInbound()` 的 gate 检查不会因为 in-flight dedup 短路。
4. `routeInbound(JSON.parse(row.original_message))`：把原始事件**重放**一次，这次 gate 因为 sender 已经是 member 而通过。

---

### 4.9 Command gate

`src/command-gate.ts` 是另一个独立的 gate，在消息送给 container **之前** 拦下"以 `/` 开头的命令"，对 admin 类做权限检查：

```ts
const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files']);

export function gateCommand(content: string, userId: string | null, agentGroupId: string): GateResult {
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
  } catch {
    text = content.trim();
  }

  if (!text.startsWith('/')) return { action: 'pass' };

  const command = text.split(/\s/)[0].toLowerCase();

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (ADMIN_COMMANDS.has(command)) {
    if (isAdmin(userId, agentGroupId)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
  return { action: 'pass' };
}
```

三个 outcome：

- `filter`：silently drop（`/help`、`/login` 这些是给 CLI 客户端用的，不该到达 container）。
- `deny`：admin 命令但发件人不是 admin → router 直接往 outbound 写一条 "Permission denied" 回复（`src/router.ts:436-447`），**不唤醒 container**。
- `pass`：放行，正常写 inbound + wake container。

#### 不走 `canAccessAgentGroup` 的路径

注意 `isAdmin()` 是**直接查 `user_roles`** 的，没经过 `canAccessAgentGroup`：

```ts
// src/command-gate.ts:49-63
function isAdmin(userId: string | null, agentGroupId: string): boolean {
  if (!userId) return false;
  if (!hasTable(getDb(), 'user_roles')) return true; // no permissions module = allow all
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND (role = 'owner' OR role = 'admin')
         AND (agent_group_id IS NULL OR agent_group_id = ?)
       LIMIT 1`,
    )
    .get(userId, agentGroupId);
  return row != null;
}
```

要点：

- 与 `hasAdminPrivilege()`（§4.3）语义等价（owner / global admin / scoped admin），但本地 SQL 实现，避免重复 `getUser()` 调用。
- `hasTable('user_roles')`：如果 permissions 模块没装（admin plane 表不存在），**fail open**（一切都 pass）——本地单用户安装的开发场景。
- `userId === null`：在 access gate 之前进入 command gate 的路径（CLI 等不需要 sender resolution 的通道）会带 null userId。null + admin 命令 → deny。

---

### 4.10 CLI socket 与"owner-implied"权限简化

`src/channels/cli.ts:74-90` 把 CLI socket 绑到 `data/cli.sock` 之后立刻 `chmod 0600`：

```ts
server!.listen(sock, () => {
  // Tighten perms so only the owner can connect. Unix socket files
  // obey filesystem perms — 0700 on the socket means other local
  // users can't send into this agent.
  try {
    fs.chmodSync(sock, 0o600);
  } catch (err) {
    log.warn('Failed to chmod CLI socket (continuing)', { sock, err });
  }
  log.info('CLI channel listening', { sock });
  resolve();
});
```

注释里有句关键话（行 25）：

> the socket is chmod 0600, so "connected to this socket" ≈ "is the owner"

这就是 CLI 通道为什么能搞特殊操作（比如 `to=...` 路由覆盖、`reply_to=...` 回复地址重定向）的依据——文件权限已经把"能 connect 上"等价于"是 host 进程的 owner"，host 进程在 launchd / 用户 shell 下跑的就是 owner 本人，所以**不再需要在协议层做身份认证**。

实际效果（`src/channels/cli.ts:12-25`）：

```
Wire format: one JSON object per line.

  Client → server:
    { "text": "user message" }                          # default — talk to cli/local
    { "text": "...", "to": {"channelType": "discord",
                            "platformId": "discord:@me:149...",
                            "threadId": null} }         # route to a specific mg
    { "text": "...", "to": {...}, "reply_to": {...} }   # + redirect replies
```

`to` 和 `reply_to` 是 **router-layer 概念**，agent 那边的 `send_message` MCP tool **不能**触发它们；只有从 CLI socket 进来的 inbound event 能携带——因为 CLI 客户端已经被文件权限校验过是 owner。

这套简化让 bootstrap script（`bin/nanoclaw-cli` 之类）可以直接通过 CLI socket "以 owner 身份"代发消息到任意 channel——比如 `nanoclaw chat --to slack:dev-channel "deploy successful"` 实际上是 owner 在借用 NanoClaw 把消息推到 Slack。

---

### 4.11 一次完整的链路：A 在 Discord 上 @ bot

把本章涉及的所有表和函数串起来，跟一条具体的消息走一次。

**前提**：

- agent group `ag-dev` 已经存在（folder = `groups/dev/`）。
- Discord channel `discord:1234567890` 已经在 `messaging_groups` 有一行：`id=mg-discord-dev`，`unknown_sender_policy='request_approval'`，`denied_at=NULL`。
- wiring 已经存在：`messaging_group_agents` 一行，`mg-discord-dev` ↔ `ag-dev`，`engage_mode='mention'`，`sender_scope='all'`，`session_mode='per-thread'`。
- 用户 A 在 Discord 上的 user_id 是 `discord:user-A-handle`。
- A 之前被 owner 通过审批加进了 `agent_group_members`：行 `(user_id='discord:user-A-handle', agent_group_id='ag-dev')`。
- A **不是** admin，**不是** owner。

**事件**：A 在 Discord channel 里发"@bot 帮我看一下 #42 PR"。

#### 步骤 1：channel adapter 解析

Discord adapter 解出 `InboundEvent`：
- `channelType: 'discord'`
- `platformId: '1234567890'`（discord channel id）
- `threadId: null`（不是 thread 内）
- `message.isMention: true`（adapter SDK 层识别出 bot 被 @）
- `message.content: '{"text":"@bot 帮我看一下 #42 PR","senderId":"user-A-handle","senderName":"Alice"}'`

调用 `routeInbound(event)`（`src/router.ts:158`）。

#### 步骤 2：messaging-group lookup

`getMessagingGroupWithAgentCount('discord', '1234567890')` → 一次 query 返回 `(mg, agentCount)` = `(mg-discord-dev row, 1)`。

走 happy path（`router.ts:204-206`）：`mg` 取已有行，`agentCount=1`。

#### 步骤 3：sender resolver hook

`senderResolver = extractAndUpsertUser`（`src/modules/permissions/index.ts:171`）。它：

1. 解析 `content`，拿到 `senderId='user-A-handle'`、`senderName='Alice'`。
2. 命名空间化：`userId = 'discord:user-A-handle'`。
3. `getUser('discord:user-A-handle')` → 已存在（之前的审批已经 upsert 了），不重复 insert。
4. 返回 `'discord:user-A-handle'`。

回到 router，`userId = 'discord:user-A-handle'`。

#### 步骤 4：fan-out 评估每个 wired agent

只有一个 wiring。对它：

**4a. evaluateEngage**（`router.ts:281`）：

```
engage_mode = 'mention'
isMention = true
→ engages = true
```

**4b. access gate**（`router.ts:283`）：

调用 `setAccessGate` 注册的 hook（`index.ts:173-191`）。`unknown_sender_policy='request_approval'`，不是 `'public'`，所以走 `canAccessAgentGroup('discord:user-A-handle', 'ag-dev')`：

1. `getUser('discord:user-A-handle')` → 存在 ✓
2. `isOwner` → false
3. `isGlobalAdmin` → false
4. `isAdminOfAgentGroup` → false
5. `isMember` → `agent_group_members` 命中 → **true**，返回 `{ allowed: true, reason: 'member' }`

access gate 返回 `{ allowed: true }`。

**4c. senderScopeGate**（`router.ts:284`）：

wiring 的 `sender_scope='all'`，hook（`index.ts:201-209`）直接 `return { allowed: true }`。

**4d. 都通过 → `deliverToAgent`**（`router.ts:286-309`）。

#### 步骤 5：deliverToAgent

`router.ts:397-485`：

1. **effective session mode**：adapter `supportsThreads=true`，`mg.is_group=1`（group chat），`session_mode='per-thread'`——已经是 per-thread，不变。
2. **resolveSession('ag-dev', 'mg-discord-dev', null, 'per-thread')**（`session-manager.ts:92`）：
   - `threadId=null`（顶层消息）
   - lookup → `findSessionForAgent('ag-dev', 'mg-discord-dev', null)`
   - 如果有 existing session → 直接复用
   - 否则 generate `sess-<ts>-<rand>`，`createSession()` 写 `sessions` 行，`initSessionFolder()` 建 `data/v2-sessions/ag-dev/sess-.../inbound.db` + `outbound.db`
3. **deliveryAddr**：没有 `event.replyTo`（不是 CLI 路由覆盖），所以用 `(channelType='discord', platformId='1234567890', threadId=null)`。
4. **command gate**（`router.ts:430-447`）：消息以 `@bot ...` 开头，不以 `/` 开头 → `gate.action='pass'`。
5. **writeSessionMessage**（`router.ts:450-459`）：往 `inbound.db.messages_in` 插一行，`trigger=1`（要唤醒），`seq` 由 `nextEvenSeq()` 算出（偶数）。`id` 是 `messageIdForAgent(event.message.id, 'ag-dev')`——namespace 加上 agent group id 避免 fan-out 撞 PK。
6. **typing indicator + wakeContainer**（`router.ts:472-484`）：先开 typing 刷新，再 `wakeContainer(freshSession)` 把 container 拉起来。

#### 步骤 6：container 拣到消息

container 启动后，agent-runner 进 poll loop，从 `inbound.db.messages_in` 拣到 `status='pending' AND trigger=1` 的行，写一条 `processing_ack(message_id=..., status='processing')` 到 `outbound.db`，开始让 agent 跑。

agent 跑完写 `messages_out` 一行（odd seq），content 是回复 JSON；再把 `processing_ack.status='completed'`。

#### 步骤 7：host delivery

host 的 `src/delivery.ts` 轮询 `messages_out`，拣出新行，调 Discord adapter `deliver(channelType='discord', platformId='1234567890', threadId=null, kind='chat', content=...)`，拿到 platform 返回的 message id，往 `inbound.db.delivered` 写 `(message_out_id, platform_message_id, 'delivered', now)`。

host-sweep 在另一个 tick 里跑 `syncProcessingAcks()`，把 `messages_out.processing_ack.status='completed'` 同步到 `messages_in.status='completed'`。

整个链路涉及的表：

```
users → sender resolver upsert
agent_group_members → access gate 命中
messaging_groups → mg lookup + unknown_sender_policy
messaging_group_agents → wiring fan-out
sessions → resolveSession
agent_groups → 找 folder
inbound.db.messages_in → writeSessionMessage
outbound.db.processing_ack → container 标记 processing
outbound.db.messages_out → agent 输出
inbound.db.delivered → host 投递成功后回写
```

#### 反例：如果 A 是个陌生人（不在 agent_group_members）

第 4b 步 `isMember` 返回 false，`canAccessAgentGroup` 返回 `{ allowed: false, reason: 'not_member' }`。

`handleUnknownSender()`（`index.ts:113`）触发：

1. `recordDroppedMessage({ reason: 'unknown_sender_request_approval', ... })` 写 `unregistered_senders`。
2. `unknown_sender_policy === 'request_approval'` → 调 `requestSenderApproval()`。
3. `pickApprover('ag-dev')` 找到 owner 或 admin，`pickApprovalDelivery()` 选一个能 DM 到 approver 的 channel（先看 `user_dms` 缓存，miss 则 ensureUserDm 调 platform openDM）。
4. 写 `pending_sender_approvals` 一行（UNIQUE 保证不重复发卡）。
5. delivery adapter 推 ask_question chat-sdk 卡片到 approver 的 DM。
6. approver 点 Allow → `handleSenderApprovalResponse()` 把 A 加进 `agent_group_members`，**delete pending row**，**`routeInbound(原 event)` 重放一次**——这次走通到步骤 6。

如果 approver 点 Deny → 删 pending row（**不写"拒绝持久化"**——下次 A 再发消息会触发新的卡片）。

#### 反例：如果 wiring 是 `engage_mode='pattern'`、`engage_pattern='^!'`

第 4a 步 `evaluateEngage` 用 regex `^!` 测 `'@bot 帮我看一下 #42 PR'`——不匹配 → `engages=false`。如果 wiring 的 `ignored_message_policy='accumulate'`，消息以 `trigger=0` 写进 session（agent 不被唤醒，但下次唤醒时可读）；如果 `'drop'`，消息直接 drop，counter 写 `unregistered_senders.reason='no_agent_engaged'`。

---

### 4.12 配置示范速查

#### 私聊 + admin 唯一可用

```sql
INSERT INTO messaging_groups VALUES
  ('mg-dm-alice', 'tg', '12345', 'Alice DM', 0, 'strict', NULL, now);
INSERT INTO messaging_group_agents VALUES
  ('mga-1', 'mg-dm-alice', 'ag-personal',
   'pattern', '.', 'known', 'drop', 'shared', 0, now);
INSERT INTO user_roles VALUES
  ('tg:12345', 'admin', 'ag-personal', 'tg:OWNER', now);
```

效果：每条 Alice 发的消息都触发（`pattern '.'`）；非 Alice 的人（如果有）由 `sender_scope='known'` + `unknown_sender_policy='strict'` 双重拒绝。

#### Public 频道 + 仅 mention 触发

```sql
INSERT INTO messaging_groups VALUES
  ('mg-public', 'slack', 'C0PUB', '#general', 1, 'public', NULL, now);
INSERT INTO messaging_group_agents VALUES
  ('mga-2', 'mg-public', 'ag-helpbot',
   'mention-sticky', NULL, 'all', 'drop', 'shared', 0, now);
```

效果：陌生人在 Slack #general 里 @ helpbot 也能用（`public` 跳过 access gate），后续 thread 内的消息靠 mention-sticky 持续生效。

#### GitHub webhook + Slack 共享 session

```sql
INSERT INTO messaging_groups VALUES
  ('mg-gh', 'github', 'repo/x', 'github:repo/x', 1, 'public', NULL, now),
  ('mg-slack', 'slack', 'C0DEV', '#dev', 1, 'request_approval', NULL, now);
INSERT INTO messaging_group_agents VALUES
  ('mga-3', 'mg-gh',    'ag-dev', 'pattern', '.', 'all', 'accumulate', 'agent-shared', 0, now),
  ('mga-4', 'mg-slack', 'ag-dev', 'mention-sticky', NULL, 'known', 'accumulate', 'agent-shared', 0, now);
```

效果：GitHub webhook 触发 `ag-dev` 的 single session（`agent-shared`），同一个 session 也接 Slack 上对 dev bot 的 @ —— agent 能在 Slack 里讨论刚收到的 PR comment。

---

### 4.13 关键引用一览

| 主题 | 文件 | 起始行 |
|------|------|--------|
| `canAccessAgentGroup` | `src/modules/permissions/access.ts` | 21 |
| `isOwner` / `isGlobalAdmin` / `isAdminOfAgentGroup` / `hasAdminPrivilege` | `src/modules/permissions/db/user-roles.ts` | 36, 43, 50, 58 |
| `isMember`（含 admin 隐式成员逻辑） | `src/modules/permissions/db/agent-group-members.ts` | 28 |
| `ensureUserDm` | `src/modules/permissions/user-dm.ts` | 52 |
| `extractAndUpsertUser`（sender resolver） | `src/modules/permissions/index.ts` | 67 |
| `setAccessGate` hook 实现 | `src/modules/permissions/index.ts` | 173 |
| `setSenderScopeGate` hook 实现 | `src/modules/permissions/index.ts` | 201 |
| `handleUnknownSender`（drop / approval 分支） | `src/modules/permissions/index.ts` | 113 |
| `requestSenderApproval`（pick + deliver + persist） | `src/modules/permissions/sender-approval.ts` | 54 |
| `handleSenderApprovalResponse`（批准回放） | `src/modules/permissions/index.ts` | 225 |
| `gateCommand` | `src/command-gate.ts` | 23 |
| `routeInbound`（router 主循环） | `src/router.ts` | 158 |
| `evaluateEngage`（trigger rules） | `src/router.ts` | 364 |
| `deliverToAgent`（含 effective session mode） | `src/router.ts` | 397 |
| `resolveSession`（session mode 分支） | `src/session-manager.ts` | 92 |
| CLI socket chmod 0600 | `src/channels/cli.ts` | 78 |
| `isolation-model.md`（三 level 设计文档） | `docs/isolation-model.md` | 1 |

后续章节（消息流、container 生命周期、审批流）都会在这套实体模型上展开，本章是回查权限和路由意图的参考。
