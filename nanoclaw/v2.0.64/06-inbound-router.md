## 设计问题：从一条 InboundEvent 到"对的 session 收件箱"

第 5 章交代了 host 进程在启动阶段把所有 channel adapter 装好之后，每条新消息都会通过 `onInbound(...)` / `onInboundEvent(...)` 回调跳到 `routeInbound`。从那一刻起，整条链路上发生的事情可以浓缩为一个看似简单的问题：

> 已知 `(channelType, platformId, threadId, message, optional replyTo)`——
> 应该把这条消息写到 **哪一个** session 的 `inbound.db`，
> 是否要 **唤醒** 对应的容器，
> 以及——更重要的——**有没有正当理由直接丢掉**？

之所以"看似"简单，是因为 v2 的入站语义已经被几个看似无关的功能搅得相当复杂：

1. **fan-out 不是 first-wins**。同一个 messaging group 可以同时 wire 给多个 agent group——比如 Slack `#general` 同时给 `Andy`（通用助手）和 `OnCall`（监控）。每条消息要 **独立** 地为每个 agent 评估是否 engage、是否 accumulate、是否要 wake，结果是 0..N 个 session 都可能被命中。
2. **未注册 channel** 与 **未注册 sender** 是两套不同的 approval flow，前者在 messaging group 整体上还没 wire 时触发，后者在某个 agent 已经 wire 上但当前发件人不属于"已知"成员时触发。两个 flow 都要把原始 event 序列化保存以便审批通过后 **重放**。
3. **denied channel** 是 owner 主动拒绝过的频道，不能再继续往 owner 的 DM 里轰审批卡——必须静默 drop。
4. **mention-sticky** 模式要求一旦某个 thread 第一次被 @ 中以后，后续消息哪怕没 @ 也要被同一个 agent 接住——这意味着 engage 决策本身要 **查数据库**。
5. **agent-shared session** 横跨 messaging group——GitHub Issue 和 Slack 频道映射到 **同一个** session（让 agent 把两边的上下文混在一起处理），所以 `resolveSession` 不能简单按 `(mg, thread)` 索引。
6. **admin 命令** 必须在写入 session DB **之前** 截掉——比如 `/clear` 不应该被未授权用户当作普通文本写进 history，再让容器去判断"哎我刚才被人 reset 了"。
7. **附件** 是 base64 嵌在 JSON content 里送来的，得在写库之前先解 base64 并落盘到 `inbox/<msgId>/`——而落盘路径全部来源于不可信输入，必须挡住路径穿越和 symlink 攻击。
8. **`replyTo`** 让 admin transport（NCL CLI）可以"以频道身份发，但把回复路由到我的终端"。

`src/router.ts` 用 **不到 500 行** 把这 8 件事缝在一起。本章把这段缝合的每一处针脚——为什么这么扎、不这么扎会出什么事——拆开来讲。

---

## 角色清单：哪些组件参与一次入站

```
            +--------+        adapter.onInbound          +--------------------+
  消息平台→ |adapter | ────────────────────────────────→ | routeInbound(event)|
            +--------+                                   +---------┬----------+
                                                                   │
                       ┌───────── module hooks (4 个) ──────────────┤
                       │  setMessageInterceptor   ← permissions    │
                       │  setSenderResolver       ← permissions    │
                       │  setAccessGate           ← permissions    │
                       │  setSenderScopeGate      ← permissions    │
                       │  setChannelRequestGate   ← permissions    │
                       └────────────────────────────────────────────┤
                                                                   │
                          v2.db (central)              +-----------v-----------+
                   ┌──── messaging_groups        ←─────| getMessagingGroup-    |
                   │ messaging_group_agents      ←─────| WithAgentCount        |
                   │ sessions                    ←─────| evaluateEngage        |
                   │ users / user_roles          ←─────| resolveSession        |
                   │ agent_group_members        ←─────| canAccessAgentGroup   |
                   │ unregistered_senders       ←─────| recordDroppedMessage  |
                   │ pending_channel_approvals  ←─────| requestChannelApproval|
                   │ pending_sender_approvals   ←─────| requestSenderApproval |
                   └────────────────────────────       +-----------+-----------+
                                                                   │
                          inbound.db (per session)     +-----------v-----------+
                              messages_in        ←────| writeSessionMessage   |
                                                       +-----------+-----------+
                                                                   │
                                                       +-----------v-----------+
                                                       | wakeContainer (async) |
                                                       +-----------------------+
```

注意所有 module hook 都是 **运行时注册** 的（chapter 4 已经讲过 module system 的来由）。如果 permissions 模块没装，`routeInbound` 仍然能跑通——`accessGate` 默认 allow-all，`senderResolver` 返回 `null`，路由退化成"任何 channel 收到的任何消息直接写进每个 wire 的 session"。这是 v2 一贯的设计原则：**core 不假设 module 存在；module 失败要降级而不是 crash**。

---

## `routeInbound` 总入口

`src/router.ts:158-342` 是整个 host 进程入站路径的唯一入口。所有 channel adapter 的 `onInbound` 回调（`src/index.ts:90-117`）和审批通过后的 **replay**（`src/modules/permissions/index.ts:271` 与 `:500`）最终都汇流到这里。

入参：

```ts
// src/channels/adapter.ts:45-63
export interface InboundEvent {
  channelType: string;
  platformId: string;
  threadId: string | null;
  message: {
    id: string;
    kind: 'chat' | 'chat-sdk';
    content: string;     // JSON 字符串：{ text, sender, senderId, attachments... }
    timestamp: string;
    isMention?: boolean;  // 平台层确认的 @-mention（chat-sdk 桥负责标记）
    isGroup?: boolean;
  };
  replyTo?: DeliveryAddress;  // CLI admin transport 把回复重定向到操作员终端
}
```

返回值：`Promise<void>`。**`routeInbound` 几乎不会显式 throw**——这是 contract 上的约定：

- 路由失败、agent 不存在、access 被拒、container 起不来——所有这些"业务上的失败"都是 **记一行 `dropped_messages` / `log.info('MESSAGE DROPPED', ...)` 然后正常返回**。
- 真正的 throw 只会在 unexpected exception（比如 DB 不可读、JSON.parse 抛了——`safeParseContent` 已经吃掉了——或者底层 sqlite 出错）时冒上来，由调用方 `.catch()` 兜底（`src/index.ts:105`）。

这个 contract 把可观察性集中在 **`unregistered_senders` 表 + 结构化日志** 上，让运维不用读 stack trace 就能知道"哪条消息为什么没到 agent"。

---

## Step 0：interceptor 与 thread 策略

```ts
// src/router.ts:158-168
export async function routeInbound(event: InboundEvent): Promise<void> {
  if (messageInterceptor && (await messageInterceptor(event))) return;

  const adapter = getChannelAdapter(event.channelType);
  if (adapter && !adapter.supportsThreads) {
    event = { ...event, threadId: null };
  }

  const isMention = event.message.isMention === true;
  ...
```

**`messageInterceptor`** 是 permissions 模块在 channel-approval 流程里的"自由文本捕获"用钩。当 owner 在 channel registration 卡里点了"Connect new agent"以后，下一条来自 owner DM 的消息应该被 **截留** 作为 agent 名字——而不是当成普通聊天去查 messaging group。`src/modules/permissions/index.ts:516-624` 是该 interceptor 的实现，它返回 `true` 表示"我消费了这条消息"，`routeInbound` 立刻 return。

**thread 策略**：`supportsThreads === false` 的 adapter（Telegram、WhatsApp、iMessage、Email）没有 thread 概念，platform_id 就是会话粒度。把 `threadId` 强制清成 `null` 是为了让下游所有按 `(mg, thread)` 索引的地方（`findSessionForAgent`、`resolveSession`）落到同一个 session，而不是因为 adapter 偶然在某条消息里塞了非空 thread 而创建出"幽灵 session"。

---

## Step 1：解析 messaging group + agent 计数（合并查询）

```ts
// src/router.ts:176-206
const found = getMessagingGroupWithAgentCount(event.channelType, event.platformId);

let mg: MessagingGroup;
let agentCount: number;
if (!found) {
  if (!isMention) return;
  const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mg = {
    id: mgId,
    channel_type: event.channelType,
    platform_id: event.platformId,
    name: null,
    is_group: event.message.isGroup ? 1 : 0,
    unknown_sender_policy: 'request_approval',
    denied_at: null,
    created_at: new Date().toISOString(),
  };
  createMessagingGroup(mg);
  log.info('Auto-created messaging group', { id: mgId, channelType: ..., platformId: ... });
  agentCount = 0;
} else {
  mg = found.mg;
  agentCount = found.agentCount;
}
```

这里有两处设计决定值得停下来看：

### 1.1 合并查询：`getMessagingGroupWithAgentCount`

`src/db/messaging-groups.ts:53-69` 把 messaging_group 行和 wired agent 数量 **塞进同一条 SQL**：

```sql
SELECT mg.*, COUNT(mga.id) AS agent_count
  FROM messaging_groups mg
  LEFT JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
 WHERE mg.channel_type = ? AND mg.platform_id = ?
 GROUP BY mg.id
```

为什么不分两次查？因为 **"channel 没 wire 任何 agent"是最常见的 case**——任何机器人加入 Slack workspace 都会潜伏在大量它根本不应该回话的频道里收消息（`@here`、`@channel`、bot mention 噪音）。这条 SQL 让 router 用 **一次 DB read** 就能短路这种 case，而不是 mg lookup → sender upsert → agents lookup → dropped_messages insert（4 次 round-trip）。两个 UNIQUE 索引（`(channel_type, platform_id)` 和 `(messaging_group_id, agent_group_id)`）让这条 JOIN 走 covered index，开销近似零。

### 1.2 auto-create 的 mention gating

只有 `isMention === true` 时才创建 messaging group。为什么？因为 v2 的 messaging_group 是一份"我们正在关注这个频道"的声明——光是 bot 被某个管理员拉进 100 人群但群里全在聊天与机器人无关的话题，没必要为每个这种频道写一行 DB。

`isMention` 是 **平台层确认** 的标志，由 chat-sdk 桥设置（`src/channels/adapter.ts:71-86`）：

- `onNewMention` / `onDirectMessage` → `isMention = true`
- `onSubscribedMessage` → 透传 `message.isMention`

注意它 **不是** "agent_group.name 出现在文本里" 这种 fragile heuristic——`@Andy` 在 Telegram 上根本不存在，那里只能 `@nanoclaw_v2_refactr_1_bot`。把"是否真的在叫机器人"的判断委托给平台 SDK，避免每个 adapter 都自己写一遍正则。

### 1.3 默认策略：`unknown_sender_policy = 'request_approval'`

auto-create 出来的 mg 默认走 approval flow。这选择不是无脑保守——而是因为这个时刻还没有任何 wiring，下一步马上要触发 channel-registration 流程，而 channel-registration 卡片在审批通过的时刻会 **同时** 把发件人 `addMember` 到新 agent group（`src/modules/permissions/index.ts:487-495`），所以审批后的 replay 不会因为 sender 仍然 unknown 而被拦截二次。

---

## Step 1b：未 wire 的 channel——drop 还是 escalate

```ts
// src/router.ts:210-247
if (agentCount === 0) {
  if (!isMention) return;
  if (mg.denied_at) {
    log.debug('Message dropped — channel was denied by owner', { ... });
    return;
  }

  const parsed = safeParseContent(event.message.content);
  recordDroppedMessage({
    channel_type: event.channelType,
    platform_id: event.platformId,
    user_id: null,
    sender_name: parsed.sender ?? null,
    reason: 'no_agent_wired',
    messaging_group_id: mg.id,
    agent_group_id: null,
  });

  if (channelRequestGate) {
    void channelRequestGate(mg, event).catch((err) =>
      log.error('Channel-request gate threw', { messagingGroupId: mg.id, err }),
    );
  } else {
    log.warn('MESSAGE DROPPED — no agent groups wired and no channel-request gate registered', { ... });
  }
  return;
}
```

走到这里说明 messaging group 行存在（或刚 auto-create）但 `messaging_group_agents` 为 0。三条分支：

```
                        agentCount == 0
                              │
              ┌───────────────┼─────────────────┐
              │               │                 │
        !isMention        denied_at         else: escalate
        silent drop       silent drop       1) record drop row
        (无 DB 写)        (no re-escalate)  2) channelRequestGate(mg, event)
                                            (fire-and-forget,
                                             permissions module 接管：
                                             createPendingChannelApproval,
                                             投递 approval 卡到 owner)
```

`denied_at` 的存在解决一个具体的运营痛点：owner 已经明确说 "no, don't connect this channel"，但群里的其他人不知道这件事还在 @ 机器人——如果不挡一下，每条消息都会再次触发 channel approval flow，把 owner 的 DM 淹没。`src/db/messaging-groups.ts:113-115` 提供 `setMessagingGroupDeniedAt` 给 reject handler 写这个时间戳，`src/modules/permissions/index.ts:333` 在用户点 Reject 时调用。

`channelRequestGate` 是 fire-and-forget——它内部会自己投递卡片、自己处理失败、自己 log。router 永远不等审批回来；审批的"回路"是异步的：owner 一旦点击 Approve/Connect，handler 用 `JSON.parse(row.original_message)` 拿出原始 event，调 `routeInbound(event)` 重新走一遍（`src/modules/permissions/index.ts:500`）。第二次 router 看到 `agentCount > 0`，正常路由。

注意 **drop row 写在 escalate 之前**。如果 escalate 内部 throw 了，至少 `unregistered_senders` 表里还能看到这条消息的痕迹。

---

## Step 2：解析 sender

```ts
// src/router.ts:252
const userId: string | null = senderResolver ? senderResolver(event) : null;
```

`senderResolver` 由 permissions 模块在加载时注册（`src/modules/permissions/index.ts:171`），实现在 `extractAndUpsertUser`（同文件 `:67-103`）。三件事：

1. **从 content 里挖 sender handle**：依次试 `content.senderId`、`content.sender`、`content.author.userId`——三种格式覆盖 chat-sdk 桥、native adapter、legacy v1 adapter。
2. **namespacing**：如果 raw handle 里已经有 `:`（如 Teams 的 `29:xxx`）就原样用，否则拼成 `${channelType}:${rawHandle}`，得到一个 **跨平台不会撞** 的 user id（types.ts:56-66 注释解释了为什么单纯 phone 号会被 telegram numeric id 撞掉）。
3. **upsert users 表**：如果 row 不存在，写一条带 display_name 的新 row。**这是 side effect**——即使消息后面被 access gate 拒掉，user 也已经存在；admin 想看"谁试过给机器人发消息"可以直接查这张表。

router 把 sender 解析放在 **agent 解析之前**，正是为了这个 side effect——审计与统计永远完整。设计文档里这段在 `src/router.ts:9-14` 的 file header 注释里有原话。

`userId === null` 是合法的——比如 webhook 类 channel 没有"发件人"概念。downstream 的 access gate 会把这种情况单独走 `unknown_user` 分支（`src/modules/permissions/index.ts:179-182`）。

---

## Step 3：fan-out——一条消息 N 个 agent

```ts
// src/router.ts:256-329
const agents = getMessagingGroupAgents(mg.id);    // ORDER BY priority DESC
const parsed = safeParseContent(event.message.content);
const messageText = parsed.text ?? '';

let engagedCount = 0;
let accumulatedCount = 0;
let subscribed = false;

for (const agent of agents) {
  const agentGroup = getAgentGroup(agent.agent_group_id);
  if (!agentGroup) continue;

  const engages = evaluateEngage(agent, messageText, isMention, mg, event.threadId);
  const accessOk = engages && (!accessGate || accessGate(event, userId, mg, agent.agent_group_id).allowed);
  const scopeOk  = engages && (!senderScopeGate || senderScopeGate(event, userId, mg, agent).allowed);

  if (engages && accessOk && scopeOk) {
    await deliverToAgent(agent, agentGroup, mg, event, userId, adapter?.supportsThreads === true, /*wake=*/true);
    engagedCount++;
    // mention-sticky 的 thread subscribe（见 Step 5）
    ...
  } else if (agent.ignored_message_policy === 'accumulate' && !(engages && (!accessOk || !scopeOk))) {
    await deliverToAgent(agent, agentGroup, mg, event, userId, adapter?.supportsThreads === true, /*wake=*/false);
    accumulatedCount++;
  } else {
    log.debug('Message not engaged for agent (drop policy)', { ... });
  }
}

if (engagedCount + accumulatedCount === 0) {
  recordDroppedMessage({ reason: 'no_agent_engaged', ... });
}
```

理解这段循环的关键是把 **三个 boolean 的 8 种组合** 摊开来：

| engages | accessOk | scopeOk | ignored_policy | 结果 |
|---------|----------|---------|----------------|------|
| T | T | T | * | **engage**：写 inbound + wake |
| T | T | F | * | drop（gate 拒了，且 scope 也拒了——不 accumulate） |
| T | F | T | * | drop（gate 拒了） |
| T | F | F | * | drop |
| F | * | * | accumulate | **accumulate**：写 inbound 但 wake=0 |
| F | * | * | drop | silent drop |

**为什么 access 拒掉时绝不 accumulate？** 注释 `src/router.ts:310-317` 写得很清楚：

> Accumulate stores the message as silent context. We allow it when engagement simply didn't fire, but NOT when engagement fired and the access/scope gate refused — those refusals are security decisions about an untrusted sender, and silently storing their message (which also stages their attachments to disk via writeSessionMessage → extractAttachmentFiles) is exactly what the gate is meant to prevent.

把"不被允许"的人的附件落到 session inbox 里，再让那个 session 的容器某次 wake 时无意中读到——这就是把 access gate 拆掉。所以 accumulate **只在"engage 未触发"** 时启用，而不是"engage 触发但被拒"。

**`priority` 在哪里 tiebreak？** `getMessagingGroupAgents` 用 `ORDER BY priority DESC`（`src/db/messaging-groups.ts:195`）控制遍历顺序，但 fan-out 本身 **不是** first-wins——所有 agent 都要被遍历。priority 在两个地方起作用：

1. mention-sticky 的 `subscribed` 标志只让 **第一个** 触发的 mention-sticky agent 去 subscribe 平台 thread（即使后面也有 mention-sticky wire 的 agent，第二次 subscribe 是多余的）。
2. 当多个 agent 都要回话时，priority 高的 agent 的 `deliverToAgent` 先 await，container 也先被 wake——这会影响"谁先把回复送出去"的视觉顺序，不影响是否送。

**`getAgentGroup` 失败的 continue**：理论上不应该发生（FK 约束），但如果 admin 在 router 跑到一半时 `deleteAgentGroup`，`continue` 而不是 throw 是 robust 选择。

---

## evaluateEngage：三种引擎决策模式

```ts
// src/router.ts:364-395
function evaluateEngage(agent, text, isMention, mg, threadId): boolean {
  switch (agent.engage_mode) {
    case 'pattern': {
      const pat = agent.engage_pattern ?? '.';
      if (pat === '.') return true;
      try { return new RegExp(pat).test(text); }
      catch { return true; }   // bad regex: fail open
    }
    case 'mention':
      return isMention;
    case 'mention-sticky': {
      if (isMention) return true;
      if (mg.is_group === 0) return false;  // DMs never use sticky
      const existing = findSessionForAgent(agent.agent_group_id, mg.id, threadId);
      return existing !== undefined;
    }
    default: return false;
  }
}
```

三个细节决定了 v2 的"用户体验"长什么样：

### `pattern` + `'.'` 是 "always-on"

router 没有专门的 `'always'` engage mode；用 `engage_mode='pattern' + engage_pattern='.'` 当哨兵。`'.'` 不是正则的 "任意字符"，而是字符串等价比较——快路径直接 return true 避免每条消息都创建一个 RegExp 对象。

### 正则错误 → fail open

`new RegExp(badPattern)` 在配置错的时候会 throw。设计选择是 **fail open**——agent 仍然 engage——目的是让 owner 立刻在聊天里看到"咦机器人 always 回话了，我去检查 pattern"。fail closed 会变成"机器人静默死亡，owner 看不到任何信号"，运维上更糟。

### mention-sticky：用 session 存在性当 "subscription" state

`mention-sticky` 的语义是"thread 里只要被 @ 过一次，后续消息不用再 @ 也要接住"。问题是这个 "@ 过一次" 的状态存哪？

v2 的选择是：**用 `findSessionForAgent` 的返回值——session 本身就是 subscription state**。第一次 @ 的时候 engage → `resolveSession` 创建 session → 下一条消息 evaluate 时 `findSessionForAgent` 找到这个 session 就返回 true。

这套设计意味着：

- 不需要单独的 `thread_subscriptions` 表。
- session 被 admin 删除 == subscription 失效（自动一致）。
- DM (`is_group === 0`) 短路返回 false 因为 DM 永远只有一个 thread，sticky 无意义。

成本：每条 mention-sticky 的非 mention 消息都要查一次 sessions 表。索引在 `(agent_group_id, messaging_group_id, thread_id, status)`，常数时间。

---

## Step 4：access gate 与 sender scope gate

```ts
// src/router.ts:283-284
const accessOk = engages && (!accessGate || accessGate(event, userId, mg, agent.agent_group_id).allowed);
const scopeOk  = engages && (!senderScopeGate || senderScopeGate(event, userId, mg, agent).allowed);
```

**两道门，分别由两个 hook 控制**：

### accessGate（messaging-group 维度）

`src/modules/permissions/index.ts:173-191`：

```ts
setAccessGate((event, userId, mg, agentGroupId) => {
  if (mg.unknown_sender_policy === 'public') return { allowed: true };
  if (!userId) { handleUnknownSender(mg, null, agentGroupId, 'unknown_user', event); return { allowed: false, ... }; }
  const decision = canAccessAgentGroup(userId, agentGroupId);
  if (decision.allowed) return { allowed: true };
  handleUnknownSender(mg, userId, agentGroupId, decision.reason, event);
  return { allowed: false, reason: decision.reason };
});
```

`canAccessAgentGroup`（`src/modules/permissions/access.ts:21-28`）的判定层级：

```
                ┌────────────────────┐
                │ user 存在于 users? │ no → unknown_user
                └─────────┬──────────┘
                          │ yes
                          ▼
                ┌────────────────────┐
                │   isOwner(userId)? │ yes → allow (reason='owner')
                └─────────┬──────────┘
                          │ no
                          ▼
                ┌────────────────────────┐
                │ isGlobalAdmin(userId)? │ yes → allow (reason='global_admin')
                └─────────┬──────────────┘
                          │ no
                          ▼
                ┌──────────────────────────────────────┐
                │ isAdminOfAgentGroup(userId, agId)?   │ yes → allow (reason='admin_of_group')
                └─────────┬────────────────────────────┘
                          │ no
                          ▼
                ┌──────────────────────────┐
                │ isMember(userId, agId)?  │ yes → allow (reason='member')
                └─────────┬────────────────┘
                          │ no
                          ▼
                      deny: not_member
```

被拒后 `handleUnknownSender` 根据 `mg.unknown_sender_policy` 分流：

- `'strict'` → 只记 `dropped_messages`，啥都不做。
- `'request_approval'` → 记 + 触发 `requestSenderApproval`（fire-and-forget）。
- `'public'` → 在 gate 入口就 return allowed=true，根本不会走到这里。

### senderScopeGate（wiring 维度）

`src/modules/permissions/index.ts:201-209`：

```ts
setSenderScopeGate((_event, userId, _mg, agent) => {
  if (agent.sender_scope === 'all') return { allowed: true };
  if (!userId) return { allowed: false, reason: 'unknown_user_scope' };
  const decision = canAccessAgentGroup(userId, agent.agent_group_id);
  if (decision.allowed) return { allowed: true };
  return { allowed: false, reason: `sender_scope_${decision.reason}` };
});
```

**和 accessGate 的区别**：同一个 messaging group 可以同时 wire 给两个 agent，一个 `sender_scope='all'`（公共助手，谁都能用），另一个 `sender_scope='known'`（机密助手，只有 member 能用）。messaging-group 层的 `unknown_sender_policy` 是公共默认，wiring 层的 `sender_scope` 是更严的覆盖。

值得注意的一点：senderScopeGate 在 **public mg** 上仍然会执行——`unknown_sender_policy='public'` 让 accessGate 放行，但 `sender_scope='known'` 仍然可以单独拦下来。这是设计意图，不是 bug。

---

## Step 4b：channel-approval flow——为什么"被拒"是 N 重身份

走到 access gate refusal 的消息有一条 **后续轨迹**：

```
dropped_messages 行（reason='unknown_sender_request_approval'）
   +
requestSenderApproval(event)
   ├── pickApprover(agentGroupId)  → 找到 owner / admin 列表
   ├── pickApprovalDelivery(approvers, originChannelType)
   │     → 选一个 reachable DM
   ├── createPendingSenderApproval({ original_message: JSON.stringify(event), ... })
   └── adapter.deliver(ownerChannel, 'chat-sdk', JSON.stringify({type:'ask_question', ...}))

owner 点 Approve →
   handleSenderApprovalResponse →
   addMember(sender → agent_group_members) →
   deletePendingSenderApproval →
   routeInbound(parsedOriginalEvent)  // 第二次走 router，gate 通过
```

注意 **同一条 `routeInbound` 入口承担"首次"和"replay"两种身份**——permissions 模块 deliberately 不绕开 router 直接写 inbound.db，因为这样可以保证 fan-out、attachment 校验、command gate 等所有后续步骤都被同等执行。

唯一的 cost 是 dedup：`pending_sender_approvals` 的 UNIQUE(messaging_group_id, sender_identity) 让同一个 unknown sender 在审批 in-flight 期间发的第二条消息被静默丢掉（`src/modules/permissions/sender-approval.ts:58-64`），避免向 owner 投递重复卡。

---

## Step 5：resolveSession——三种 session_mode

```ts
// src/router.ts:410-415
let effectiveSessionMode = agent.session_mode;
if (adapterSupportsThreads && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
  effectiveSessionMode = 'per-thread';
}

const { session, created } = resolveSession(agent.agent_group_id, mg.id, event.threadId, effectiveSessionMode);
```

**"effective session mode" 的覆盖逻辑**：threaded adapter（Discord/Slack/GitHub）在 group chat 里 **无视** wiring 的 `session_mode='shared'`，强制变成 `per-thread`。为什么？因为 Slack thread 是用户心智里的"独立对话单位"——把多个 thread 的消息全塞进同一个 session 会让 agent 上下文混乱，回到 thread A 时看到 thread B 的发言。`agent-shared` 不被覆盖，因为它是 **跨 channel** 的显式声明（GitHub Issue + Slack 共享一个 agent state），admin 是知道自己在干什么的。

DM (`is_group === 0`) 走 shared，因为 DM 里的"thread"是平台 artifact（比如 Slack DM 里偶尔会有 reply-in-thread），用户期望是连续对话。

### resolveSession 的三个分支

`src/session-manager.ts:92-133`：

```ts
export function resolveSession(agentGroupId, messagingGroupId, threadId, sessionMode):
  { session: Session; created: boolean }
{
  if (sessionMode === 'agent-shared') {
    const existing = findSessionByAgentGroup(agentGroupId);   // 任意 mg、最新 active
    if (existing) return { session: existing, created: false };
  } else if (messagingGroupId) {
    const lookupThreadId = sessionMode === 'shared' ? null : threadId;
    const existing = findSessionForAgent(agentGroupId, messagingGroupId, lookupThreadId);
    if (existing) return { session: existing, created: false };
  }

  const id = generateId();
  const lookupThreadId = sessionMode === 'per-thread' ? threadId : null;
  const session: Session = { id, agent_group_id, messaging_group_id, thread_id: lookupThreadId, ... };

  createSession(session);
  initSessionFolder(agentGroupId, id);    // mkdir + ensureSchema(inbound) + ensureSchema(outbound)
  return { session, created: true };
}
```

|              | `agent-shared` | `shared` | `per-thread` |
|--------------|----------------|----------|---------------|
| lookup 索引  | `agent_group_id` | `(agent, mg, NULL)` | `(agent, mg, thread)` |
| 一个 agent → ? session | 1 | N（每 mg 一个） | M（每 mg×thread 一个） |
| 新建 session 时存的 thread_id | NULL | NULL | event.threadId |
| 典型用法 | 跨频道 unified agent | DM、单线程平台 | Slack/Discord thread |

`findSessionForAgent` 用 `agent_group_id` scope 是 fan-out 必需的：如果用更宽的 `findSession`，两个 agent wire 到同一个 channel 时第二个 agent 会"捡到"第一个 agent 的 session，把消息送错容器（`src/db/sessions.ts:30-53` 注释明确点出这是 fan-out 修过的 bug）。

`initSessionFolder` 在 session 行刚 INSERT 后立即创建文件系统结构：

```
DATA_DIR/v2-sessions/<agent_group_id>/<session_id>/
  ├── inbound.db    (ensureSchema: messages_in, session_routing, ...)
  ├── outbound.db   (ensureSchema: messages_out, processing_ack, ...)
  └── outbox/       (用于附件读出)
```

`inbox/` 不在这里创建——它由 `extractAttachmentFiles` 在 **第一次有附件时** lazily 创建。

---

## Step 6：deliverToAgent——写库 + 命令网关 + 附件抽取

```ts
// src/router.ts:397-485（节选关键路径）
async function deliverToAgent(agent, agentGroup, mg, event, userId, adapterSupportsThreads, wake) {
  let effectiveSessionMode = ...; // 见 Step 5
  const { session, created } = resolveSession(agent.agent_group_id, mg.id, event.threadId, effectiveSessionMode);

  const deliveryAddr = event.replyTo ?? {
    channelType: event.channelType, platformId: event.platformId, threadId: event.threadId,
  };

  // Step 6a: command gate
  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    const gate = gateCommand(event.message.content, userId, agent.agent_group_id);
    if (gate.action === 'filter') return;
    if (gate.action === 'deny') {
      writeOutboundDirect(session.agent_group_id, session.id, {
        id: `deny-${...}`,
        kind: 'chat',
        platformId: deliveryAddr.platformId,
        channelType: deliveryAddr.channelType,
        threadId: deliveryAddr.threadId,
        content: JSON.stringify({ text: `Permission denied: ${gate.command} requires admin access.` }),
      });
      return;
    }
  }

  // Step 6b: 写入 inbound.db（附件抽取在内部）
  writeSessionMessage(session.agent_group_id, session.id, {
    id: messageIdForAgent(event.message.id, agent.agent_group_id),
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: deliveryAddr.platformId,
    channelType: deliveryAddr.channelType,
    threadId: deliveryAddr.threadId,
    content: event.message.content,
    trigger: wake ? 1 : 0,
  });

  // Step 6c: 唤醒容器（仅 engaged 分支）
  if (wake) {
    startTypingRefresh(session.id, session.agent_group_id, event.channelType, event.platformId, event.threadId);
    const freshSession = getSession(session.id);
    if (freshSession) {
      const woke = await wakeContainer(freshSession);
      if (!woke) stopTypingRefresh(freshSession.id);
    }
  }
}
```

### 6a · 命令网关 (command-gate.ts)

`src/command-gate.ts:23-63` 区分三类 slash command：

```
text 开头不是 '/' → pass

text 开头是 '/'：
  command in FILTERED_COMMANDS  → action: 'filter'
    {'/help','/login','/logout','/doctor','/config','/remote-control'}
    （这些是 Claude CLI 自带的命令，不应该穿透到 agent；filter 后静默 drop）

  command in ADMIN_COMMANDS     → 查 user_roles
    {'/clear','/compact','/context','/cost','/files'}
    isAdmin(userId, agentGroupId)
      → true:  pass
      → false: deny  + 直接 writeOutboundDirect 把 "Permission denied" 写到
               messages_out，让正常 delivery loop 把它发回给用户。

  其他 '/xxx' → pass（agent / SDK 自己处理 custom command）
```

为什么 `/clear`、`/compact` 这些算 admin？因为它们会 **修改 agent state**——`/clear` 抹掉对话历史。让群里的随便谁都能 reset 机器人是灾难。

`isAdmin` 的 fallback：如果 `user_roles` 表不存在（permissions 模块没装），返回 true——allow-all，保持模块缺席时的 "no security" 一致性。

`writeOutboundDirect`（`src/session-manager.ts:382-403`）跳过容器直接写 messages_out 是个有意思的选择。如果走"唤醒容器，让 agent 自己生成 deny 回复"会让 deny 消息消耗 LLM token 又慢——直接写 outbound 让 delivery loop 在下一 tick 把它送出去，零成本零延迟。

### 6b · writeSessionMessage 与附件抽取

`writeSessionMessage`（`src/session-manager.ts:193-250`）做两件事：

1. **抽附件**：调用 `extractAttachmentFiles`，把 base64 嵌在 content JSON 里的 `attachments[*].data` 解码并落盘到 `inbox/<msgId>/<filename>`，replace 为 `{ localPath, name }`。
2. **写库**：调用 `insertMessage`（`src/db/session-db.ts:94-134`），一条 prepared SQL INSERT 到 messages_in，seq 由 `nextEvenSeq` 计算（host 写偶数、container 写奇数，避免冲突，详情见 chapter 3）。

**`messageIdForAgent` 的 namespacing**：

```ts
// src/router.ts:493-496
function messageIdForAgent(baseId: string | undefined, agentGroupId: string): string {
  const id = baseId && baseId.length > 0 ? baseId : generateId();
  return `${id}:${agentGroupId}`;
}
```

为什么要拼 agent_group_id 当 id 后缀？因为 fan-out 让 **同一条** platform 消息散到 N 个 session 的 messages_in，而 `messages_in.id` 是 PRIMARY KEY。原始 message.id 在多个 session 里 reuse 不会 collide（每个 session 一个独立 DB），但同一个 session 在审批通过后被 replay 时就会撞 PK——拼 agent_group_id 同时解决"session 内 PK 唯一"和"运维诊断时一眼看出消息属于哪个 agent"。

### 6c · wakeContainer

`wakeContainer`（`src/container-runner.ts:85-106`）的 contract 是 **永不 throw**：

```ts
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) return Promise.resolve(true);
  const existing = wakePromises.get(session.id);
  if (existing) return existing;
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => { wakePromises.delete(session.id); });
  wakePromises.set(session.id, promise);
  return promise;
}
```

设计要点：

- **dedup**：`wakePromises` 防止并发 wake 时第二个调用绕过 `activeContainers.has` 检查再 spawn 一个容器（chapter 7 详细讲为什么会有 race window）。
- **never throws**：如果 spawn 失败，inbound row 仍然 `status='pending'`，host-sweep（chapter 10）在下一轮 tick 会重试 wakeContainer。router 不需要做任何回滚。
- **typing indicator 配对**：`startTypingRefresh` 在 wake 之前启动，`stopTypingRefresh` 只在 wake 失败时立即停（成功 wake 后由容器自己负责 stop）。如果 wake 失败但 typing 还在转圈，用户会看到"机器人正在打字..."永久挂起，所以这个配对绝对不能漏。

**为什么 wakeContainer 是 fire-and-forget**（router 不等容器真正起好）？两个原因：

1. **channel adapter timeout**：Discord webhook 必须 3 秒内回 200，否则 Discord 认为 webhook 挂了会重发。容器 cold start 可能 5-10 秒。等不起。
2. **container 起好 != 消息会被处理**：容器起好后会 **自己** 去 poll inbound.db（chapter 8 详述），消息已经在那儿——所以 router 的责任到"消息在 DB" 即结束。

---

## 附件安全：路径穿越 / symlink / TOCTOU

`extractAttachmentFiles`（`src/session-manager.ts:270-358`）是 router 路径上 **唯一** 把不可信输入写进文件系统的地方，所以它的防御层次值得逐条拆。

威胁模型：

- `messageId` 来自客户端（WhatsApp 把 `msg.key.id` 透传，peer 可伪造）。
- `att.name` 完全攻击者可控。
- 容器对 session 目录有 **写权限**（mount 是 rw）——所以攻击者控制的容器可以在 host 写文件 **之前** 在目标路径预放 symlink。

防御层次（5 道）：

```
1. isSafeAttachmentName(messageId)
   → 拒 '..' '.' 含 '/' '\' NUL，basename(name) !== name
   → 失败：return contentStr 不做任何写操作

2. isSafeAttachmentName(deriveAttachmentName(att))
   → 同上。攻击者无 explicit name 时由 MIME → ext 自动构造（attachment-naming.ts），
     这些是静态值，无法构造穿越 payload。
   → 失败：替换为 'attachment-<ts>' 并 log.warn

3. inboxDir 已存在 → lstat 拒 symlink / 非目录
   → fs.mkdirSync(inboxDir, { recursive: true }) 会 silently no-op symlink，
     接下来的 writeFileSync 会 follow symlink。所以必须先 lstat 一次。

4. realpath 校验 inboxDir 仍在 inbox root 之下
   → 即使过了上面三道，攻击者仍可能在祖先目录玩 symlink trick；
     realpath 把所有 symlink 解开后跟 inbox root 比较。

5. fs.writeFileSync(filePath, ..., { flag: 'wx' })
   → 'wx' = exclusive create. 文件已存在（无论是 symlink、普通文件还是目录）
     都 EEXIST。失败 → log.warn 跳过这个 attachment，不抛。
```

任一道失败，**这个附件** 被跳过，message 仍然写库——附件只是"丢了"，不影响 agent 收到文本。这是 graceful degradation：在保证安全的前提下不阻断消息流。

`attachment-naming.ts:60-69` 的 `deriveAttachmentName` 用 MIME 和 `att.type` 两层 fallback 给没有显式 filename 的附件生成 `attachment-<ts>.<ext>`——extension 重要因为容器里的工具（image viewer、exiftool）通常按 extension dispatch。Telegram GIF 的 `att.type='animation'` 映射到 `mp4`，因为 Telegram 内部就是 MP4，这种 platform-specific 知识被集中在这一张表里。

---

## 一图总览：从 InboundEvent 到 session

```
                            ┌─────────────────────────┐
                            │   routeInbound(event)   │
                            └────────────┬────────────┘
                                         │
                              messageInterceptor?
                                  │       │
                                  │       ▼ yes
                                  │     return (consumed)
                                  ▼
                       supportsThreads === false?
                         → event.threadId = null
                                  │
              getMessagingGroupWithAgentCount(channelType, platformId)
                                  │
              ┌───── found === null ──────┴────── found !== null ──────┐
              │                                                         │
        !isMention?                                                     │
            │ │                                                         │
            │ └─ yes → return (silent)                                  │
            │                                                           │
            └─ no  → createMessagingGroup(default request_approval) ────┤
                     agentCount = 0                                     │
                                                                        │
                              agentCount === 0?
                              ┌───┴──────────────────────────────┐
                              │ yes                              │ no
                              │                                  │
                       !isMention → return                       │
                       denied_at  → return                       │
                       else:                                     │
                         recordDroppedMessage('no_agent_wired')  │
                         channelRequestGate (fire-and-forget) ───┤
                         return                                  │
                                                                 ▼
                                      senderResolver(event) → userId | null
                                                                 │
                                      getMessagingGroupAgents(mg.id)
                                      ORDER BY priority DESC
                                                                 │
                          ┌─────────── for each agent ───────────┘
                          │
                          ▼
                evaluateEngage(agent, text, isMention, mg, threadId)
                          │
                 ┌──── engages? ────┐
                 │                  │
                 │ true             │ false
                 │                  │
        accessGate(...)         ignored_message_policy === 'accumulate'
                 │                          │
        senderScopeGate(...)        ┌── yes ┴── no ──┐
                 │                  │                │
        ┌── both allowed? ──┐       │           silent drop
        │ yes               │ no    │
        ▼                   │       ▼
  deliverToAgent(wake=true) │  deliverToAgent(wake=false)
        │                   │
        │             handleUnknownSender →
        │             dropped_messages +
        │             requestSenderApproval (if 'request_approval')
        │
        ▼
  ┌─────────────────────────────────────────────────┐
  │ deliverToAgent:                                 │
  │   effectiveSessionMode = ... (per-thread coerc) │
  │   resolveSession(...)                           │
  │   gateCommand(content, userId, agentGroupId):  │
  │     'filter' → return                           │
  │     'deny'   → writeOutboundDirect; return      │
  │   writeSessionMessage:                          │
  │     extractAttachmentFiles (5-layer defense)    │
  │     insertMessage(inbound.db, seq=even)         │
  │   if wake:                                      │
  │     startTypingRefresh                          │
  │     wakeContainer (fire-and-forget; never throws)│
  │     if !woke: stopTypingRefresh                 │
  └─────────────────────────────────────────────────┘

  循环结束：
  if (engagedCount + accumulatedCount === 0)
      recordDroppedMessage('no_agent_engaged')
```

---

## 错误处理 / 可观察性

`routeInbound` 路径上 **失败的 sink 是结构化日志 + `unregistered_senders` 表**，从来不是 throw。具体到每一步：

| 失败点 | 反应 | 日志 / 持久化 |
|--------|------|----------------|
| messageInterceptor 抛 | catch 在 interceptor 内部 | permissions 模块自己 `log.error` |
| getMessagingGroupWithAgentCount 失败 | 让 promise reject 冒泡 | `src/index.ts:105` 的 catch |
| agentCount === 0 + !isMention | 不做任何事 | 无日志（避免噪音） |
| denied channel | 不做任何事 | `log.debug('Message dropped — channel was denied by owner')` |
| no agent wired | 不 escalate（无 gate） | `log.warn('MESSAGE DROPPED — no agent groups wired ...')` + `unregistered_senders` |
| no agent wired + has gate | escalate fire-and-forget | `log.info` 'Channel registration card delivered' / `log.error` on failure |
| sender 解析失败 | userId = null，继续 | 无日志（合法情况） |
| evaluateEngage 正则错 | fail open（engage） | 无日志（debug 级也没有） |
| accessGate 拒 | drop | `log.info('MESSAGE DROPPED — unknown sender (strict policy)' / '(approval requested)')` + `unregistered_senders`(reason='unknown_sender_<policy>') |
| senderScopeGate 拒 | drop | `log.debug('Message not engaged for agent (drop policy)')` |
| command-gate filter | drop | `log.debug('Filtered command dropped by gate')` |
| command-gate deny | 直接写 outbound deny 文本 | `log.info('Admin command denied by gate', { command, userId, agentGroupId })` |
| attachment 任一防御失败 | 跳过 **这个** 附件 | `log.warn(...)` 5 种不同 message 视防御层 |
| writeSessionMessage SQL 错 | 抛到 router | catch 在 caller |
| wakeContainer spawn 失败 | 返回 false | `log.warn('wakeContainer failed — host-sweep will retry')` |
| 0 engaged + 0 accumulated | drop | `recordDroppedMessage('no_agent_engaged')` |

`log.ts` 输出的格式（`src/log.ts:42-46`）：

```
[HH:MM:SS.mmm] INFO   Message routed sessionId="sess-..." agentGroup="ag-..." engage_mode="mention-sticky" kind="chat" userId="slack:U0ABC" wake=true created=false agentGroupName="Andy"
```

所有跨步骤都用同一组字段名（`channelType`、`platformId`、`messagingGroupId`、`agentGroupId`、`sessionId`、`userId`），用 `grep` 一条命令就能拉出一条消息从入站到 wake 的全链路。

`unregistered_senders` 表（`src/db/dropped-messages.ts:3-44`）的 ON CONFLICT 把同一个 `(channel_type, platform_id)` 的多次 drop **聚合** 成一行 + 计数器，避免大量噪音重复行——运维查表时看到的是"channel X 已经被 drop 了 42 次，最近一次 reason='unknown_sender_strict'"。

---

## 测试入口

`src/host-core.test.ts:360-705` 是 router 的主战场。值得读的几个用例：

| 行号 | 用例 | 验证点 |
|------|------|---------|
| `src/host-core.test.ts:394` | should route a message end-to-end | 最小 happy path，写 inbound + session 创建 |
| `src/host-core.test.ts:429` | auto-creates messaging group only when the bot is addressed | Step 1 的 mention gating |
| `src/host-core.test.ts:467` | route multiple messages to the same session | resolveSession 复用 |
| `src/host-core.test.ts:499` | fans out to every matching agent, each in its own session | Step 3 fan-out + 每个 agent 一个 session |
| `src/host-core.test.ts:540` | accumulates without waking when engage fails + ignored_message_policy=accumulate | accumulate 分支 |
| `src/host-core.test.ts:579` | drops silently when engage fails + ignored_message_policy=drop | drop 分支 |
| `src/host-core.test.ts:632` | routed message carries platformId, channelType, threadId on messages_in | deliveryAddr 写入正确 |
| `src/host-core.test.ts:658` | fan-out gives each agent its own routing, not leaked from sibling | replyTo / 路由隔离 |
| `src/host-core.test.ts:707` | writeSessionRouting populates session_routing | wakeContainer 内部的 session_routing 刷新 |
| `src/host-core.test.ts:811` | agent-shared session resolution | session_mode='agent-shared' |
| `src/host-core.test.ts:843` | agent-to-agent routing (A2A return path) | router 作为 A2A 投递的目标 |

permissions 模块的两个相关测试：

- `src/modules/permissions/channel-approval.test.ts:144` — 验证未 wire channel 触发 `requestChannelApproval` 并能 replay。
- `src/modules/permissions/permissions.test.ts:88` — `canAccessAgentGroup` 各种身份组合。

scripts 里两个手动观测路径：

- `scripts/test-v2-channel-e2e.ts` — 启 host + mock channel adapter + 喂入站消息，端到端走一遍 routeInbound → container spawn → outbound delivery。
- `scripts/sanity-live-poll.ts` — 连接真实 channel（Slack/Discord），实时 poll 一段时间观察 router 日志和 unregistered_senders 表的增量。

---

## 关键不变量

读完上面所有节再回头看，router 守护的不变量可以浓缩为五条：

1. **永不丢失审计**：任何被 drop 的消息要么 `unregistered_senders` 表里有行，要么 `log.warn('MESSAGE DROPPED ...')` 有条目（fan-out 全部 drop 的情况两者都有）。运维 grep `MESSAGE DROPPED` 必能定位。
2. **fan-out 隔离**：N 个 agent 在同一条消息上的处理结果互相独立——一个被 access 拒不影响另一个 engage；每个写到自己的 session inbound.db；message id 加 agent_group_id 后缀保证 PK 不撞。
3. **gate 失败不静默存攻击者数据**：accumulate 只在 engage 未触发时启用，access/scope 拒绝时绝不 accumulate（否则把附件落盘就破坏安全）。
4. **router 不阻塞 channel adapter**：channelRequestGate、wakeContainer、adapter.subscribe 都是 fire-and-forget；router 在 inbound row 写入后立即 return，让 webhook 在 3 秒 timeout 内拿到 200。
5. **module 缺席降级而非崩溃**：四个 hook 都允许未注册；未注册时 router 行为 = "allow-all、no upsert、no escalate"，仍然能正常工作（适合 minimal install / CI 测试）。

下一章（chapter 7）接着讲 `wakeContainer` 之后发生什么——session 文件夹结构、容器 spawn 的 mount 拼装、heartbeat 与 idle timeout。
