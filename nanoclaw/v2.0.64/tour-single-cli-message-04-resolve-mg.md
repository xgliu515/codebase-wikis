## 1. 当前情境

[上一步](tour-single-cli-message-03-on-inbound.md)结束时，host 进程内部已经把"客户端在 CLI socket 上写了一行 `{"text":"ping"}`"这个事实翻译成了一个**结构化的 `InboundEvent` 对象**，并通过 channel-registry 注入的 `onInbound` 回调把它递给了 `routeInbound(event)`。此刻 event 的形状大致是：

```ts
{
  channelType: 'cli',
  platformId:  'local',
  threadId:    null,
  message: {
    id:        'cli-1747...-ab12cd',
    kind:      'chat',
    timestamp: '2026-05-18T09:14:02.001Z',
    content:   '{"text":"ping","sender":"cli","senderId":"cli:local"}',
  },
}
```

注意几件事：

- `channelType` 已经被 cli adapter 写死成 `'cli'`，**不可信任的客户端写不进这一格**——这是 adapter 给的"出厂铭牌"，router 后面会拿它当主键查表。
- `platformId='local'` 是 cli adapter 的常量（`src/channels/cli.ts:45`：`const PLATFORM_ID = 'local'`）——cli 只有一个虚拟 platform。
- `threadId: null`，因为 cli `supportsThreads: false`（`src/channels/cli.ts:58`）。router 在第 0 步还会再 enforce 一次这条策略（`src/router.ts:166-168`）。
- `message.content` 还是个 JSON 字符串，router 这一层不去解。文字到底是不是 `"ping"` 跟 router 没关系——它只关心 channel/platform 这一对。

进入 `routeInbound` 之后，router 要做的第一件大事是：**把这个 channel 上的这个聊天/频道/DM，对应到中央 DB 里的某一行**。这就是 messaging_group 解析。

---

## 2. 问题

具体地：

- 同一个用户可能在 5 个平台上各有若干"对话窗口"——iMessage 群、Telegram DM、Discord 频道、Slack thread、CLI 终端。每个窗口都要能被独立**记忆**（消息历史、参与者、上次活跃时间）和独立**配置**（这里 wired 哪个 agent、未知发送者怎么办）。
- "同一个窗口"必须能被**去重**：第二次 ping 不能新建一行；不然每条消息都成了"新对话"，下面 7-8 步要建的 session 也跟着失控。
- 这一层还要决定：**这个频道有没有被注册过**？如果没有，是 silently drop（被动旁观的群聊里的闲话），还是触发 channel-registration approval（owner 第一次看到机器人在新群里被 @）？
- 而且 router 是 **fast path**——CLI 每秒可能十几条、Telegram 每秒上百条 webhook、群聊里大量 plain chatter。**这一步必须便宜**：理想是一次 DB 读就能决定"继续路由 / 直接 drop"。

把这几件事放一起：router 必须找到一个**稳定的、可索引的、对 (平台, 聊天窗口) 唯一的键**，用它快速捞出一行配置，决定接下来走哪条路。

---

## 3. 朴素思路

最直觉的写法：**每条入站消息现起一个 messaging_group 行**——反正消息总要落 DB，那就消息里带着 `platform_id`，每次插入一行就完事。然后下游 fan-out 时再按 message id 关联。

这个写法甚至看起来很 functional：messaging_group 是消息的一部分元数据，没有跨消息的状态，多简单。

或者退一步：**用 `(channel_type, platform_id)` 当主键 INSERT OR IGNORE**——第一次插入新建一行，之后每次都 IGNORE，自然就 dedup 了。

---

## 4. 为什么朴素思路会崩

#### 失败 1：dedup 是 dedup 了，但失去了"未注册"的概念

`INSERT OR IGNORE` 写法把"我从来没见过这个 channel"和"这个 channel 我见过但还没被 wired"混成了同一件事。但这两种状态对 router 是天差地别的：

- **从未见过 + 不是 @bot**：用户在群里聊天，机器人甚至没被 cue，应该静默——`messaging_groups` 里 **根本不该有行**，连一次 DB 写都不该发生。
- **从未见过 + @bot**：owner 需要被打扰：要不要让这个机器人进这个群？这就是 channel-registration approval 流程。

`INSERT OR IGNORE` 会让"群聊闲话"也产生一堆零 wiring 的 messaging_groups 行，DB 变成噪声仓库，第 11 章的 channel 注册审批也就无从触发——因为 `messaging_groups` 已经存在了，approval gate 不知道这是"新 channel"。

#### 失败 2：messaging_group 不只是 message 的标签，它是**配置承载体**

这张表上挂着 `unknown_sender_policy`（strict / request_approval / public）、`denied_at`（owner 是否拒绝过这个 channel）、`name`（用户友好的显示名）、`is_group`（DM 还是群聊，影响 session_mode 决策）。每条消息现造一行=每次都丢配置，owner 在 Discord 上点过"reject 这个频道"也没用——下一条消息又来一行新的，`denied_at` 完全无意义。

#### 失败 3：fan-out 的 wiring 不是 per-message，是 per-channel

`messaging_group_agents` 表（M:N wiring）的主键里就有 `messaging_group_id`。如果每条消息一个 mg_id，wiring 表就要么按消息复制（行数爆炸）、要么不能 join——两种都是死路。

#### 失败 4：朴素方案下"不存在的 channel"代价是 4 次 DB 读

如果不做 fast-drop，标准流程是：mg 查一次、sender upsert 一次、wiring 列一次、`dropped_messages` 插一次。CLI 每秒一两条还行，Telegram bot 守在 500 人群里时 router 直接成为热点。

---

## 5. NanoClaw 的做法

`messaging_groups` 表用 `UNIQUE(channel_type, platform_id)`（`src/db/schema.ts:34`）作为主键意义上的去重维度——一个 channel 上的一个聊天/频道/DM **永远** 对应至多一行。`id` 列是 surrogate key（生成形如 `mg-1747...-ab12cd`），实际查表用 `(channel_type, platform_id)`。

router 第 1 步只发**一次** DB 读，但这一次读做两件事：

```ts
// src/router.ts:176
const found = getMessagingGroupWithAgentCount(event.channelType, event.platformId);
```

`getMessagingGroupWithAgentCount`（`src/db/messaging-groups.ts:53-69`）是个 `LEFT JOIN + COUNT` 的组合查询：

```sql
SELECT mg.*, COUNT(mga.id) AS agent_count
  FROM messaging_groups mg
  LEFT JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
 WHERE mg.channel_type = ? AND mg.platform_id = ?
 GROUP BY mg.id
```

返回值是 `{ mg, agentCount } | null`。三种状态对应三种走向：

1. **`null`（行不存在）** → 这个 channel 完全没见过。看 `isMention`：
   - 不是 @bot → `return`，**零 DB 写**（`src/router.ts:184`）。这就是闲话静默。
   - 是 @bot → 现造一行 `mg` 进 `messaging_groups`（`unknown_sender_policy='request_approval'`，`denied_at=null`），落到下面的 agentCount=0 分支。
2. **`{ mg, agentCount: 0 }`** → 行存在但没 wiring。还是看 `isMention`，不是就 `return`；是 @bot 但 `mg.denied_at` 非空（owner 之前 reject 过）也 `return`；否则记一行 `dropped_messages` 并触发 `channelRequestGate` 异步起 approval 卡片（`src/router.ts:210-247`）。
3. **`{ mg, agentCount: > 0 }`** → 正常路径，进入第 2 步 sender resolution，再进 5 步 wiring fan-out。

对 CLI 这条 tour——`init-cli-agent` 已经 seed 过 `(channel_type='cli', platform_id='local')` 的 messaging_group 行（`scripts/init-cli-agent.ts:128-141`，名字写死 `'Local CLI'`，`unknown_sender_policy='public'`），还顺手把这一行 wire 到一个 agent group（`init-cli-agent.ts:143-156`，engage 模式 `pattern + '.'`）。所以 CLI 的 ping 永远走第 3 种状态，直接落到 fan-out。

#### "Combined lookup" 的另一层意图

`getMessagingGroupWithAgentCount` 命名上叫"combined"，是因为它把"mg 行存在吗"和"它有 wiring 吗"压成一次 query。原本的 4-read 流程（mg lookup → sender resolve → list agents → record drop）现在变成：

- **闲话静默**：1 次 read，return。
- **未注册 channel @bot**：1 次 read + 1 次 INSERT + 1 次 dropped_messages INSERT + 1 次 approval kickoff。
- **正常 happy path**：1 次 read + 后续步骤。

router 的注释（`src/router.ts:172-176`）特意点出这个权衡："Cheap short-circuit for the common 'unwired channel' case — one DB read and we're out, no auto-create, no sender resolution, no log spam."

#### CLI 场景下的具体执行

对 `(channelType='cli', platformId='local')` 来说，combined lookup 命中：

```
mg = {
  id: 'mg-1747...-cli',
  channel_type: 'cli',
  platform_id:  'local',
  name:         'Local CLI',
  is_group:     0,
  unknown_sender_policy: 'public',
  denied_at:    null,
  created_at:   '2026-...',
}
agentCount = 1   // init-cli-agent 已 wire
```

`mg` 这个对象会被 router 一路带到 fan-out 循环里（`src/router.ts:286` 之后的每一次 `evaluateEngage` 和 access gate 调用都收它做参数）。`unknown_sender_policy='public'` 这一字段在 [step 06](tour-single-cli-message-06-permission.md) 会决定 access gate 短路返回 allow。

---

## 6. 代码位置

按 router 在这一步的执行顺序：

- `src/router.ts:158-168` —— `routeInbound` 入口；interceptor 钩子（permissions 模块多步审批用）；adapter thread 策略 enforcement（cli 这里把 `threadId` 收敛成 `null`，但本来就是 null，no-op）。
- `src/router.ts:170` —— `const isMention = event.message.isMention === true;`。CLI 客户端不设 `isMention` 字段，所以这里恒为 `false`——但因为 mg 已存在且有 wiring，根本不会走到 isMention 分支。
- `src/router.ts:176` —— **本步主语句**：`const found = getMessagingGroupWithAgentCount(...)`。
- `src/db/messaging-groups.ts:53-69` —— combined lookup 的 SQL 实现，`LEFT JOIN` + `COUNT` + `GROUP BY`。
- `src/db/schema.ts:25-35` —— `messaging_groups` 表定义，注意 `UNIQUE(channel_type, platform_id)` 这条约束本身就给 SQLite 自动建了 covering index。
- `src/router.ts:180-206` —— 三种状态的分支决策树。
- `src/router.ts:210-247` —— `agentCount === 0` 的两个子分支：denied channel 静默 / 触发 channel-registration approval。
- `src/modules/permissions/channel-approval.ts:128-237` —— `requestChannelApproval` 实现，作为 `channelRequestGate` 钩子注册（`src/modules/permissions/index.ts:292-294`）。
- `scripts/init-cli-agent.ts:128-156` —— CLI 场景下 mg + wiring 的 seed 路径，**这是为什么 happy path 不会触发 channel approval**。
- `src/db/messaging-groups.ts:21-28` —— `createMessagingGroup`，未注册 channel + @bot 触发时由 `src/router.ts:185-196` 调用。

---

## 7. 分支与延伸

- 这张表本身的所有列、它在中央 DB 里的位置、它和 wiring 表/destinations 表的关系：[第 3 章 §3.4 Central DB](03-three-db-model.md#34-central-dbdatav2db) 的 entity 关系图。
- "未知 channel 怎么变成 approval 卡片"那条分支：第 11 章 §"Channel 注册审批"（fan-out 之外的另一条路径，对照 `src/modules/permissions/channel-approval.ts`）。
- 后面 fan-out 循环用 mg 做什么：[第 6 章 §"Step 3 — 选 agent_group"](06-routing.md#step-3--选-agent_group) + [step 05](tour-single-cli-message-05-resolve-ag.md)（接着用同一个 mg 在 `messaging_group_agents` 里找 wiring）。
- mg 的 `unknown_sender_policy` 字段如何影响 access gate：第 4 章 §"未知发送者策略" + [step 06](tour-single-cli-message-06-permission.md) 的 short-circuit 分支。
- `is_group` 字段在 session 解析时怎么影响 session_mode 决策：[第 7 章 §"adapter thread 策略与 session_mode"](07-session-container.md) + [step 07](tour-single-cli-message-07-resolve-session.md)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **`(channel_type, platform_id)` 是 messaging_group 的逻辑主键**，`id` 是 surrogate。这一对永远去重一行——同一个 channel 上的同一个聊天窗口，无论生命周期多长、消息多少条，只对应这一行。
2. **`messaging_groups` 行的存在与否本身就承载语义**：行不存在 = 完全新 channel；行存在 + agentCount=0 = 见过但没 wiring；行存在 + agentCount>0 = happy path。router 的快速 drop 决策直接由"行是否存在"+"isMention 是否成立"两位 bit 决定。
3. **combined query 是为热路径优化的**：闲话静默只发 1 次 DB read 就返回，整个 fan-out + sender resolve 都被绕过。这套设计假设"被旁观的群聊"会是入站事件的大头，而 wiki 第 6 章的实测 wiring 表里典型 owner 也就十几个真实 channel。
4. **CLI 不走 channel-registration approval**，因为 `init-cli-agent` 在 `/new-setup` 时已 seed 过 mg + wiring。`pnpm run chat` 永远落到 happy path——这就是 trunk 选择 cli 当永远内置 channel 的理由（第 11 章 §"Trunk only 内置 cli/claude"）。
5. **`unknown_sender_policy` 的默认值已经从 schema-level 移到 router-level**：`schema.ts:31` 写的是 `DEFAULT 'strict'`，但 `src/router.ts:192` 手工创造 mg 行时硬编码成 `'request_approval'`——这是 migration 011 故意为之，因为 SQLite 在 FK 引用 implicit transaction 里不能 DROP+CREATE 翻 default。下一次你看到"明明 schema 写 strict 怎么实际是 request_approval"，答案在这里。
