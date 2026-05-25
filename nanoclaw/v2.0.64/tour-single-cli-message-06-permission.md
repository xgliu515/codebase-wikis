## 1. 当前情境

[上一步](tour-single-cli-message-05-resolve-ag.md) router 在 fan-out 循环里迭代到 CLI 那唯一一条 wiring：

```ts
agent = {
  id: 'mga-...',
  messaging_group_id: 'mg-...-cli',
  agent_group_id:     'ag-...-cli-with-gavriel',
  engage_mode:        'pattern',
  engage_pattern:     '.',
  sender_scope:       'all',
  ignored_message_policy: 'drop',
  session_mode:       'shared',
  priority:           0,
}
```

`evaluateEngage` 已经返回 `true`（catch-all pattern）。在调 `deliverToAgent` 之前，router 还要过两道 gate：

```ts
// src/router.ts:283-284
const accessOk = engages && (!accessGate || accessGate(event, userId, mg, agent.agent_group_id).allowed);
const scopeOk  = engages && (!senderScopeGate || senderScopeGate(event, userId, mg, agent).allowed);
```

`accessGate` 和 `senderScopeGate` 都是 **可选 hook**——router core 不知道权限是什么，只在 hook 注册了的时候去调；没注册就当 allow-all。permissions 模块（`src/modules/permissions/index.ts:171,201`）启动时注册了这两个 hook 的实现。

这一步要拆的就是：**permissions 模块到底拿什么数据、按什么规则、决定 allow/deny**。CLI 这条 happy path 走得很快（mg 的 `unknown_sender_policy='public'` + wiring 的 `sender_scope='all'` 让两道 gate 都 short-circuit），但其它 channel 走的是同一段代码——CLI 的快是策略选得宽，不是机制不一样。

---

## 2. 问题

权限系统要解决的事情比"能不能访问"广得多：

- **owner 不应该被列在 ACL 里**。你是这台 NanoClaw 的主人，理论上你能访问每一个 agent group——但显式列举（"owner @ ag1, owner @ ag2, ... owner @ agN"）随着 agent 数量增长是 N 行 ACL，每新建一个 agent 都要补一行，删 owner 要删 N 行，灾难。
- **admin 有多种作用域**。"global admin"应该能管所有 agent；"scoped admin"只能管某一个 agent group。要能区分这两种，不能用同一个 `is_admin` 布尔。
- **"成员"和"管理员"是不同概念**。admin 隐式是成员（他都能配置这个 agent 了，当然能跟它说话），但成员不一定是 admin。这两层关系不能共用一张表。
- **未知发送者不能直接放行也不能直接拒绝**。三种策略要并存：strict（直接 drop）、request_approval（drop 这一条但发审批卡片）、public（任何人都能聊，比如公开 demo channel）。
- **CLI 的特殊地位**：socket 文件已经被 chmod 0600/0700 了，能连上 = 你坐在这台机器前面、有 fs 访问权。这是 OS 级别的认证，比任何应用层 ACL 都强。语义上"连上 CLI 的就是 owner"，但 NanoClaw 不能因此**显式给 `cli:local` 这个 user 颁 owner 角色**——它只是个 placeholder identity，真实 owner 是在 `init-first-agent` 时用真名（如 `slack:U0ABC`）注册的。所以 CLI 这条路必须**绕开 user-level 检查**，靠"channel 自己宣称 public"实现。

---

## 3. 朴素思路

最直觉的写法：建一张大 ACL 表：

```sql
CREATE TABLE access_control (
  user_id        TEXT,
  agent_group_id TEXT,
  permission     TEXT,    -- 'read' | 'write' | 'admin' | 'owner'
  PRIMARY KEY (user_id, agent_group_id, permission)
);
```

每次入站消息：`SELECT permission FROM access_control WHERE user_id = ? AND agent_group_id = ?`，没行就 deny。

这是 ACL 系统的"教科书写法"，看起来什么都覆盖到了。

---

## 4. 为什么朴素思路会崩

#### 失败 1：owner 在大 ACL 表里是 O(N) 行

NanoClaw 默认单用户，你可能有 10 个 agent group。"我是 owner"应该是 1 行事实，不是 10 行 ACL。新增 agent 不应改 ACL 表；删 owner 不应扫大表。

#### 失败 2：admin 作用域装不进单一 `permission` 列

"global admin" vs "agent A 的 scoped admin"是两种语义。单条 ACL 行不能优雅表达 global——要么 NULL 占位 agent_group_id（污染 PK），要么每个 agent 复制一行（回到 O(N)）。

#### 失败 3：unknown_sender_policy 必须跟 channel 绑定

"public demo channel" vs "私人 DM" 跟 user 无关——是 **messaging_group 属性**。塞进 ACL 表要么变 per-user 黑名单（不可枚举），要么逻辑两处维护（每 channel 一条 deny-all + 例外 allow）。

#### 失败 4：CLI socket 的 OS 级信任表达不进 ACL

`cli:local` 是 **shared synthetic identity**——任何能连 socket 的人都用同一 id。当真实用户加进 ACL 表，颁 owner 与真实 owner 冲突，颁成员 CLI 断手断脚。OS-level 信任（chmod 0600）必须能从 **channel 层** 注入，不污染 user/role 系统。

---

## 5. NanoClaw 的做法

权限被切成 **3 张表 + 1 个 channel 属性**：

| 表 / 字段 | 角色 |
|---|---|
| `users` | 平台身份的注册表。一个真人在每个平台一行（`slack:U0ABC`、`discord:456`、`cli:local`）。NanoClaw 不做跨平台 linking。 |
| `user_roles` | 角色授予。`(user_id, role, agent_group_id)` PK，`role ∈ {owner, admin}`。owner 必须 `agent_group_id IS NULL`（全局），admin 可全局或 per-group。 |
| `agent_group_members` | 非特权成员名单。`(user_id, agent_group_id)` PK。owner / global admin / scoped admin **隐式是成员**，不需要这张表里的行。 |
| `messaging_groups.unknown_sender_policy` | channel 级的逃生口：`'public'` 整个绕过 user-level 检查；`'request_approval'` 触发审批；`'strict'` 静默 drop。 |

这套结构刻意把"owner / admin / member"的优先级硬编码进**查询顺序**而非 ACL 行，整套判定就一个函数：

```ts
// src/modules/permissions/access.ts:20-28
export function canAccessAgentGroup(userId: string, agentGroupId: string): AccessDecision {
  if (!getUser(userId)) return { allowed: false, reason: 'unknown_user' };
  if (isOwner(userId)) return { allowed: true, reason: 'owner' };
  if (isGlobalAdmin(userId)) return { allowed: true, reason: 'global_admin' };
  if (isAdminOfAgentGroup(userId, agentGroupId)) return { allowed: true, reason: 'admin_of_group' };
  if (isMember(userId, agentGroupId)) return { allowed: true, reason: 'member' };
  return { allowed: false, reason: 'not_member' };
}
```

5 个 `is*` 查询都是 indexed lookup（`user_roles.user_id` + `agent_group_members.PK` + `users.id` PK），全部 `LIMIT 1`（`src/modules/permissions/db/user-roles.ts:36-55`），最差情况 5 次 O(log n) 查询。owner 命中后立刻 short-circuit——你日常聊天每次消息只会查 1-2 次。

#### Access gate 在 router 里怎么用

permissions 模块在 `src/modules/permissions/index.ts:173-191` 注册的 gate 实现的执行序：

1. **channel 级开关优先**：`mg.unknown_sender_policy === 'public'` → 直接 `{ allowed: true }`，根本不调 `canAccessAgentGroup`。CLI 走这条。
2. **没有 userId**（sender resolver 没识别出来）→ 调 `handleUnknownSender(mg, null, ...)`：按 `unknown_sender_policy` 派发静默 drop（strict）或触发 sender approval（request_approval）。
3. **有 userId** → 跑上面的 5 级层次。allowed 直接 return；deny 时同样进 `handleUnknownSender` 写审计行 + 可能起 approval。

#### sender_scope：wiring 级的二次过滤

`canAccessAgentGroup` 是"channel 上能不能跟这个 agent 说话"。`sender_scope` 是 wiring 层的进一步收紧：哪怕 channel 是 `public`，某个 wiring 可以要求 `sender_scope='known'`，只让 owner/admin/member 触发它。

```ts
// src/modules/permissions/index.ts:201-209
setSenderScopeGate((_event, userId, _mg, agent): AccessGateResult => {
  if (agent.sender_scope === 'all') return { allowed: true };
  if (!userId) return { allowed: false, reason: 'unknown_user_scope' };
  const decision = canAccessAgentGroup(userId, agent.agent_group_id);
  if (decision.allowed) return { allowed: true };
  return { allowed: false, reason: `sender_scope_${decision.reason}` };
});
```

注意 `sender_scope='all'` 是直接 allow——CLI wiring 用的就是这个值。所以这道 gate 也是 short-circuit。

#### CLI 这条路径的实际执行

进入 fan-out 第 1 轮，`accessOk` / `scopeOk` 的计算：

```
accessGate(event, userId='cli:local', mg, ag_id):
  → mg.unknown_sender_policy === 'public' → return { allowed: true }    ← 这里就出去了
senderScopeGate(event, userId='cli:local', mg, agent):
  → agent.sender_scope === 'all' → return { allowed: true }              ← 这里也出去了
```

两道 gate 都没真的查 `user_roles` 或 `agent_group_members`。`cli:local` 这个 user 行虽然 `init-cli-agent.ts:92-97` 已经 upsert 进 `users` 表了，但它的 `user_roles` 是空——CLI 永远不会走到那条路径，所以也不需要颁角色。

#### CLI 安全模型：OS-level 信任

CLI 的安全完全依赖 `src/channels/cli.ts:78-84` 的 `fs.chmodSync(sock, 0o600)`。文件头注释（`src/channels/cli.ts:20-31`）把语义点透："connected to this socket ≈ is the owner"。**判定不在 NanoClaw 代码里，在 Unix 文件系统里**。`unknown_sender_policy='public'` 敢这么开放，是因为 channel 已被 OS 拦了一层。换到 Discord/Slack 这种公网 channel，mg 自动创建时由 `src/router.ts:192` 写成 `'request_approval'`。

#### 拒绝时发生什么

`canAccessAgentGroup` 返回 `not_member` 后，gate 走 `handleUnknownSender`（`src/modules/permissions/index.ts:113-169`）按 policy 派发：strict 写 `dropped_messages` 静默；request_approval 写 `dropped_messages` + 调 `requestSenderApproval`（选 approver → 选 DM → 投 Allow/Deny 卡片 → 写 `pending_sender_approvals`，PK `UNIQUE(mg_id, sender_identity)` in-flight dedup）。owner 点 Allow → `addMember` 加 sender 进 `agent_group_members` → 用存的原 event 调 `routeInbound` 重放，这次直接放行。核心不变量：**unknown sender 的消息在 owner 决断前不被任何 agent 看见**，原文存在 `pending_sender_approvals.original_message`。

---

## 6. 代码位置

按调用顺序：

- `src/router.ts:283-284` —— `accessOk` / `scopeOk` 计算，gate 的调用点。
- `src/router.ts:70-86` —— `setAccessGate` 注册接口（core 默认 allow-all）。
- `src/router.ts:95-109` —— `setSenderScopeGate` 注册接口。
- `src/modules/permissions/index.ts:171` —— `setSenderResolver(extractAndUpsertUser)`。
- `src/modules/permissions/index.ts:173-191` —— access gate 实现，**`unknown_sender_policy === 'public'` 第一行 short-circuit**。
- `src/modules/permissions/index.ts:201-209` —— sender_scope gate 实现，**`sender_scope === 'all'` 第一行 short-circuit**。
- `src/modules/permissions/access.ts:21-28` —— **本步主函数 `canAccessAgentGroup`**，5 级层次。
- `src/modules/permissions/db/user-roles.ts:36-55` —— `isOwner` / `isGlobalAdmin` / `isAdminOfAgentGroup` 的 SQL（每个都是 `LIMIT 1` 的 `SELECT 1`）。
- `src/modules/permissions/db/agent-group-members.ts:28-36` —— `isMember`，自带 owner/admin 隐式短路。
- `src/db/schema.ts:60-90` —— `users` / `user_roles` / `agent_group_members` 三张表 schema；注意 `user_roles` PK 包含 `agent_group_id`，能区分 global 和 scoped admin。
- `src/modules/permissions/index.ts:113-169` —— `handleUnknownSender`，根据 `unknown_sender_policy` 派发 strict / request_approval。
- `src/modules/permissions/sender-approval.ts:54-120` —— `requestSenderApproval` 完整流程（pick approver、pick DM、deliver 卡片、写 pending row）。
- `src/channels/cli.ts:20-31,78-84` —— CLI socket 的 OS-level 信任说明 + chmod 0600。
- `scripts/init-cli-agent.ts:92-101` —— `cli:local` 这个 synthetic user 的 upsert（无 owner 授予）；注释 `cli:local is a scratch identity, not the operator`。
- `scripts/init-cli-agent.ts:136` —— CLI mg 的 `unknown_sender_policy: 'public'` seed（**这一行让 access gate short-circuit**）。

---

## 7. 分支与延伸

- 权限为什么不挂在 agent group 上：[第 4 章 §"权限是 user-level 而非 agent-group-level"](04-entity-model.md)（解释 owner / admin / member 的层次本来就跨 group，挂 user 才能 1 行表达"我是这台机的 owner"）。
- 未知发送者三种策略详细对比：[第 4 章 §"未知发送者策略"](04-entity-model.md) + [第 11 章 §"Sender 审批流"](11-self-mod-restart.md)（pending_sender_approvals 的卡片渲染、重放流程）。
- access gate 在 router 里的位置和职责边界：[第 6 章 §"Step 4 — 权限检查"](06-routing.md#step-4--权限检查)，并对比 step 1（messaging_group resolve）和 step 3（wiring fan-out）。
- CLI socket 的安全模型为什么够用：[第 5 章 §"CLI channel 范例"](05-channel-adapter.md) + 第 11 章关于 admin transport 的小节（`to` / `reply_to` 字段只有能连 socket 的进程能设）。
- 接下来 [step 07](tour-single-cli-message-07-resolve-session.md) 会用 `agent.session_mode` 和 mg 的 `is_group` 决定 session 是 shared / per-thread / agent-shared，这是另一条独立轴线。

---

## 8. 走完这一步你脑子里应该多了什么

1. **权限是 user-level，不是 (user, agent) ACL 表**。`user_roles` + `agent_group_members` 两张表 + 5 级层次（owner → global admin → scoped admin → member → not_member）替代了一张大 ACL，owner 状态 1 行表达，新增 agent 不用补行。
2. **`canAccessAgentGroup` 是 5 个 indexed `LIMIT 1` 查询的串行**，每个都是 O(log n)。owner 命中后立刻 return，日常路径只查 1-2 次。这是为热路径优化过的——router fan-out 每条 wiring 都会调一次。
3. **`unknown_sender_policy='public'` 是 channel 级开关**，写在 `messaging_groups` 行上，access gate 第一行就检查它并 short-circuit。CLI 这条 tour 路径**完全不查 `user_roles`**——不是因为权限系统不工作，而是因为 channel 主动宣称"这里不需要验身"。
4. **CLI 的安全是 OS 给的**，不是 NanoClaw 给的。socket chmod 0600 意味着"能连上 = 你坐在这台机器前面"。`cli:local` 这个 user 行存在但没角色——它是 placeholder identity，OS 那层认证已经替代了角色判定。
5. **拒绝路径不只是 return false**：`handleUnknownSender` 根据 channel 策略派发到 strict（静默 drop + 审计行）/ request_approval（drop 这一条 + 起 sender-approval 卡片）/ public（永远不到这一步）。原消息会被存进 `pending_sender_approvals.original_message`，owner 点 Allow 时 `routeInbound` 用存的 event 重放，这次直接通过——这就是"approval 通过=自动重试"的实现方式。
