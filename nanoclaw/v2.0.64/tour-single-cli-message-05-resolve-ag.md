## 1. 当前情境

[上一步](tour-single-cli-message-04-resolve-mg.md) router 拿到了 messaging_group + 它的 wired agent 计数（`{ mg, agentCount=1 }`，CLI 那一行 + 1 条 wiring）。`agentCount > 0` 推进到 happy path。router 紧接着做一次 sender resolution（`src/router.ts:252`，CLI 客户端给的 `senderId='cli:local'` 被 namespaced 成 `users.id='cli:local'`），然后在 `src/router.ts:256` 调：

```ts
const agents = getMessagingGroupAgents(mg.id);
```

把这条 mg 上所有的 wiring 一次性捞出来。问题不是"有没有 agent 处理这条消息"——上一步已经答了——而是**"哪些 agent、按什么规则、各自决定要不要接"**。

CLI 这一行只有 1 个 wiring。但 router 写的是通用 fan-out，所以这一步要把通用机制讲清，再回到 CLI 这条简单链路。

---

## 2. 问题

`messaging_group_agents`（M:N wiring 表）描述的是"哪个 agent 处理哪个 channel"。一个 channel 可以挂多个 agent，一个 agent 也可以挂多个 channel。Router 在这一步必须解决一组并不显然的子问题：

- **多 wiring 怎么并发**？比如同一个 Slack channel wired 了 "Reviewer" 和 "Planner" 两个 agent，Reviewer 只响应包含 `review:` 前缀的消息，Planner 响应所有消息。一条 `review: PR #123` 是只给 Reviewer 还是两个都给？给的话谁先？
- **"@提及"算什么**？平台原生的 @mention（Telegram 的 `/cmd@bot_name`、Slack 的 `<@U0123>`、Discord 的 `<@!456>`）和 NanoClaw 的 agent display name 是两回事——同一个 agent 在 Slack 上叫"Andy"，在 Discord 上可能叫"Helper"。"被提及"应该按平台 ID 还是按 agent name？
- **沉默上下文怎么处理**？一个 PR Review agent 不响应群里的闲聊，但你希望它**看见**那些闲聊——下次有人 @它做 review 时，它能引用早先的讨论。这种"我不响应，但我要存"的状态怎么表达？
- **"线程粘性"是 channel 级还是 wiring 级**？一旦某条 thread 被 agent 接管，后续的回复**不用再 @bot** 也应该继续走到这个 agent——但这个语义只对支持线程的平台（Discord/Slack）有意义，对 Telegram/iMessage 这种没线程的平台是 nonsense。
- **priority 是什么**？多 wiring 命中时怎么排序？

每个子问题都暗藏一个"朴素答案 + 它崩在哪"的故事，下面会逐条拆。

---

## 3. 朴素思路

把它写成最直觉的伪代码：

```ts
const wirings = SELECT * FROM messaging_group_agents WHERE mg_id = ?;
const winner  = wirings[0];   // first wiring wins
deliverTo(winner.agent_group_id, message);
```

或者轻度优化版："对每条消息检查所有 wiring 的关键词，第一个 match 的赢"。

trigger 规则放哪？最简单是塞一个 `trigger_rules` JSON 列：

```json
{"keyword": "review:", "mention_required": true}
```

每次入站消息把 JSON 拉出来 parse，逐条字段 if/else 判定。

---

## 4. 为什么朴素思路会崩

#### 失败 1：first-wiring-wins 直接砸碎多 agent 协作

"同一个 channel 挂多个 agent"是 NanoClaw 显式支持的场景（[第 1 章 §6](01-overview.md) 提到"PR Reviewer + Planner + 私人助手"是用户的典型配置）。如果总是第一条 wiring 赢：

- 添加新 agent 的相对顺序变成隐式行为——`createMessagingGroupAgent` 的插入时间决定路由结果。
- @bot1 永远走不到，因为 @bot2 wiring 排在它前面、`engage_pattern='.'`（catch-all）截胡。
- 用户无法表达"两个 agent 都该响应"的意图（典型场景：admin agent 和工作 agent 同时存在）。

#### 失败 2：把"@提及"和"agent display name"绑死

直觉：用户输入 `@Andy ping`，router 提取 `@Andy` 匹配 `agent_groups.name = 'Andy'`。崩点：平台的 @mention **不是字符串匹配**，是 SDK 给的结构化字段（Discord `<@!UUID>` / Slack `<@U0123>` / Telegram entity offset+length）。同一 agent 在不同平台 bot username 各不相同。想给两个 agent 区分 @ 得设独立 bot account——这是平台资源，NanoClaw 管不到。正确语义是 **SDK 给 `isMention=true` 就是被提及**（adapter 责任），区分多 bot 让用户在 `engage_pattern` 里写 regex。

#### 失败 3：drop vs accumulate 不能合一

全部 drop 丢上下文（PR Review 第一次被 @ 时前 50 条闲聊它没看见，回复就是"我没有上下文"）；全部 accumulate 有安全漏洞（unknown sender 的消息也存进去，对应 [step 06](tour-single-cli-message-06-permission.md) 的 `sender_scope`）。"被忽略时该怎么处理"必须是 wiring 的**独立列**。

#### 失败 4：单一 JSON `trigger_rules` 不可索引不可演化

v1 nanoclaw 就栽过：一个 `trigger_rules` JSON 列 + 一个 `response_scope` 枚举，每加一个维度就要在 JSON 发明新键、router 加新 case，schema 没法约束、索引没法建。v2 migration 010 把它拆成 4 个正交列：`engage_mode ∈ {pattern, mention, mention-sticky}` + `engage_pattern` regex + `sender_scope ∈ {all, known}` + `ignored_message_policy ∈ {drop, accumulate}`。

#### 失败 5：mention-sticky 不能 store 在 wiring 表本身

"已被 @ 过的 thread 后续不用再 @" 听起来是 wiring 属性，实际是 **per-(agent, mg, thread) 三元组瞬时状态**。存 wiring 表重启丢；建独立 sticky 表要 GC、UNIQUE、写额外数据。router 选了精明的做法：**用 session 的存在性当 sticky 信号**——能查到 session = 已激活过，sticky 自动延续；session 被 `/clear` 删了 sticky 自然失效，零额外存储。

---

## 5. NanoClaw 的做法

#### 4 个正交列 + priority + session_mode

`messaging_group_agents` 的 schema（`src/db/schema.ts:41-55`）：

```sql
CREATE TABLE messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  engage_mode            TEXT NOT NULL DEFAULT 'mention',
                         -- 'pattern' | 'mention' | 'mention-sticky'
  engage_pattern         TEXT,   -- regex when engage_mode='pattern'; '.' = always
  sender_scope           TEXT NOT NULL DEFAULT 'all',    -- 'all' | 'known'
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',   -- 'drop' | 'accumulate'
  session_mode           TEXT DEFAULT 'shared',
  priority               INTEGER DEFAULT 0,
  created_at             TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);
```

`UNIQUE(messaging_group_id, agent_group_id)` 保证：**同一对 (channel, agent) 只能存在一条 wiring**——你不能在同一个 channel 上挂两条不同规则的同一 agent。要不同行为，就开新 agent group。

#### Fan-out：**所有 wiring 各自独立判定，不互相干扰**

`src/router.ts:277-329` 是一个 `for (const agent of agents)` 循环，**循环里没有 break**——每条 wiring 都独立跑 `evaluateEngage` + accessGate + scopeGate，三条都过就 `deliverToAgent(..., wake=true)`，engage 失败但 `ignored_message_policy='accumulate'` 就 `deliverToAgent(..., wake=false)`，其它情况静默 drop。多 agent 真的能同时响应同一条消息——各自写自己的 inbound.db、各自唤起自己的容器。

`getMessagingGroupAgents` 的 SQL（`src/db/messaging-groups.ts:193-197`）按 `ORDER BY priority DESC`。但因为没有 break，priority 实际上**只影响日志顺序和 mention-sticky subscribe 的 first-wins**（`src/router.ts:294-309`，第一条 mention-sticky engaged 触发 adapter.subscribe）。"priority + first wins" 是给未来留的口子，比如 "fallback agent"（priority=-1，其它全拒时才接）。

#### evaluateEngage：3 种 engage_mode

`src/router.ts:364-395` 的 switch：

| 模式 | 判定 | 典型用法 |
|------|------|---------|
| `pattern` | `engage_pattern ?? '.'` 当 regex 测 text；regex 报错时 fail open（让 admin 看见 agent 响应再去修） | DM / CLI / catch-all wiring |
| `mention` | `isMention === true`，由 adapter/SDK 给 | 多 agent 群聊 |
| `mention-sticky` | `isMention || (mg.is_group !== 0 && findSessionForAgent(...))` | 群聊主对话：第一次 @ 之后整条 thread 都归这个 agent |

CLI wiring 是 `pattern + '.'`（`scripts/init-cli-agent.ts:149-150`）——catch-all 一切。

#### CLI 这条 tour 的具体执行

`getMessagingGroupAgents('mg-...-cli')` 返回长度 1 的数组：

```ts
[{
  id: 'mga-...',
  messaging_group_id: 'mg-...-cli',
  agent_group_id:     'ag-...-cli-with-gavriel',   // init-cli-agent 创建的
  engage_mode:        'pattern',
  engage_pattern:     '.',
  sender_scope:       'all',
  ignored_message_policy: 'drop',
  session_mode:       'shared',
  priority:           0,
  created_at:         '...',
}]
```

router 进入 fan-out 循环（迭代 1 次）：

1. `evaluateEngage` → `pattern + '.'` → `true`。
2. accessGate 检查（[step 06](tour-single-cli-message-06-permission.md) 详解）：mg 的 `unknown_sender_policy='public'` → 直接 `{ allowed: true }`，根本不查 user_roles。
3. senderScopeGate：`sender_scope='all'` → `{ allowed: true }`。
4. 三条都过 → 进 `deliverToAgent(..., wake=true)`，下一步去解析 session。

至此，"agent group ID" 已经确定（`ag-...-cli-with-gavriel`），下一步 [step 06](tour-single-cli-message-06-permission.md) 会聚焦于"权限"这一段的具体语义（虽然 CLI 这条路径里它会 short-circuit）。

---

## 6. 代码位置

- `src/router.ts:256` —— `getMessagingGroupAgents(mg.id)` 调用点。
- `src/db/messaging-groups.ts:193-197` —— SQL：`ORDER BY priority DESC`，无 LIMIT。
- `src/db/schema.ts:41-55` —— wiring 表 schema 与 4 列正交语义。
- `src/router.ts:277-329` —— fan-out 循环，**关键是无 break**。
- `src/router.ts:364-395` —— `evaluateEngage`，3 种 engage_mode 的判定逻辑。
- `src/router.ts:283-284` —— `accessOk` / `scopeOk` 计算（hook 注册见 `src/modules/permissions/index.ts:173,201`）。
- `src/router.ts:310-319` —— accumulate 分支：engage 失败但 `ignored_message_policy='accumulate'`，仍写 inbound row 但 `trigger=0` 不唤醒容器。
- `src/router.ts:294-309` —— mention-sticky 第一次 engage 触发 `adapter.subscribe`（subscribed flag 保证整条消息只 subscribe 一次）。
- `scripts/init-cli-agent.ts:143-156` —— CLI wiring 的 seed 内容（catch-all、sender_scope=all、shared session）。
- `src/modules/agent-to-agent/db/agent-destinations.ts` —— wiring 写入时会同步 `agent_destinations`（[第 3 章 §3.4.2](03-three-db-model.md#342-agent_destinations投影到-session-inbound-的-acl)），让 agent 能按 local name 发回这个 channel。

---

## 7. 分支与延伸

- 4 个正交列的设计背景、v1→v2 migration 010 怎么把 JSON 拆开：[第 4 章 §"Trigger rules"](04-entity-model.md) + [第 3 章 §3.9 Migration 系统](03-three-db-model.md#39-migration-系统)。
- `session_mode` 的三个值（shared / per-thread / agent-shared）怎么影响 session 解析：[第 4 章 §"Session mode"](04-entity-model.md) + [step 07](tour-single-cli-message-07-resolve-session.md) 的 `resolveSession` 调用。
- 多 agent fan-out 的真实例子（admin agent + 工作 agent 并存）：[第 6 章 §"Step 3 — 选 agent_group"](06-routing.md#step-3--选-agent_group)。
- `mention-sticky` 的 subscribe 机制：[第 5 章 §"adapter.subscribe"](05-channel-adapter.md) + [第 6 章 §"Mention-sticky"](06-routing.md)。
- `ignored_message_policy='accumulate'` 的 trigger=0 行如何在容器里被读到：[step 11](tour-single-cli-message-11-poll-loop.md) 的 poll SQL（`trigger=0` 行**不唤醒**但**会被下一次 poll 看到**当上下文）+ [第 8 章 §"poll loop 与 trigger 列"](08-agent-runner.md)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **NanoClaw 没有"first wiring wins"**——所有 wiring 在 fan-out 循环里独立判定，多 agent 真的能并发响应同一条消息。priority 的实际作用很弱，主要是日志顺序和 mention-sticky 的 subscribe tiebreak。
2. **"@提及"是 adapter / SDK 给的 boolean，不是字符串匹配**。区分多 bot 的责任在用户写 `engage_pattern` regex，不在 NanoClaw 给 agent 派 platform-side bot account。
3. **4 列正交是 v1 的血泪教训**：从一个 JSON `trigger_rules` 拆出来后，每个轴可以独立配（"catch-all 但只对 known 用户"、"mention-only 但被忽略时累积"），组合空间变成可推理的 3×2×2=12 种，没有 JSON 加新键导致的 silent 行为变化。
4. **session 存在性 = mention-sticky 状态**。NanoClaw 没单独的 sticky 表，靠 `findSessionForAgent(...)` 查 sessions 表来推断"这 thread 是否已激活过"。/clear 删 session = sticky 自然失效，零额外 GC。
5. **`ignored_message_policy='accumulate'` 让"沉默旁观"成为一等公民**：消息写进 inbound.db 但 `trigger=0`，容器不被唤醒，但下一次真正 wake 时这些行作为上下文被一并读到。这是 PR Review agent / 群聊辅助 agent 真正能"看见全场"的机制。
