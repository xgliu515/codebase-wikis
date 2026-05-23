# Trace 步骤 05 —— 创建 Session 与首条消息

## 1. 当前情境

上一步把 SQLite 库点亮了：`opencode.db` 在 `~/.local/share/opencode/`，drizzle schema 已应用，9 张表（session / message / part / project / workspace / event / event_sequence / share / account ...）齐备且全空。CLI 进程现在已经持有 `Database`、`Bus`、`SyncEvent`、`Storage`、`Session` 这一串 Effect Service 的实例；`run` 子命令的 handler 也已经决定调 SDK 客户端的 `client.session.prompt({ parts: [{ type: "text", text: "What's in README.md?" }], ... })`。

请求顺着本地 HTTP 走进 `packages/opencode` 进程内嵌的 server，命中路由 `POST /session/{sessionID}/prompt`，处理函数是 `SessionHttpApi.prompt` (`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:286-300`)。

可见的状态：

- DB 中所有表存在但 session/message/part 三张表都是 0 行。
- 进程持有 InstanceContext（projectID、worktree、cwd、agent 默认值）。
- run 子命令并未先调 `client.session.create()` —— 因为 SDK 的 v2 prompt 路径会替你按需建会话；这一步要把"没有 Session 时怎么平滑建一个"也讲清楚。

## 2. 问题

要把"用户敲了一行字"变成 server 端可继续推进 agent loop 的状态，至少要落三类数据：

1. **一个 Session 行**：聚合后续所有消息、token 计数、cost、permission ruleset、agent / model 默认值；它是其他所有行的 `session_id` 外键起点。
2. **一条 user `MessageV2.User` 行**：携带这一轮的 agent / model 选择、`time.created`、可选的 system 覆盖 —— 它代表"是谁、用什么模型、在哪一刻发问"。
3. **至少一个 `MessageV2.Part`**：把 `"What's in README.md?"` 落成一个 `type: "text"` 的 Part；后续如果用户带了文件附件、@reference、agent 显式切换，每个语义片段都会是单独的 Part 行。

同时，落库不是"写完就完"。TUI / SSE 订阅者（步骤 14 / 15 会回到这里）必须**立刻**收到 `session.created`、`message.updated`、`message.part.updated` 三类事件——否则人坐在 `opencode run` 面前会看到几秒静默。

## 3. 朴素思路

如果你只盯着"建会话+收消息"四个字写代码，几乎一定会写出这样的版本：

```ts
const session = { id: ulid(), title: prompt.slice(0, 40), created: Date.now() }
db.exec("INSERT INTO session ...", session)

const msg = { id: ulid(), sessionID: session.id, role: "user", content: prompt }
db.exec("INSERT INTO message ...", msg)

bus.emit("session:created", session)
bus.emit("message:created", msg)
```

`content` 是个字符串，session 字段一把抓，bus 事件手写名字。三条 INSERT 走完，进 agent 循环。

## 4. 为什么朴素思路会崩

把这段写法放到 opencode 的需求上看，每一条都不顶用：

- **`content: string` 装不下后面的世界**。同一条 user message 可能携带：纯文本 + 一张截图 + `@README.md` reference + 一个显式 `@plan` agent 切换 + 一个 MCP resource 链接。等到 assistant 回来时，还会冒出 reasoning / tool-call / tool-result / step-start / step-finish / compaction / snapshot 等十多种 Part；其中 tool-call 还要分 pending / running / completed / error 四个状态。一个 `content` 字段表达不了，等想表达时再 schema 迁移就要动全表。
- **三条 INSERT 不在事务里**。session 行写成功了，message 行写失败，DB 留下孤儿；下次启动 `MessagesPage` 看见 sessionID 但拉不出消息，TUI 直接挂。
- **bus.emit 和 INSERT 两条码**。如果 INSERT 成功、emit 之前进程崩了，订阅者永远看不到这条消息；下次重启即使能从 DB 恢复，对实时观察者（一个开了 `opencode --print-logs` 调试的窗口）来说，那一刻的事件被吞了。
- **没有顺序号**。两个客户端（CLI 进程 + 旁边一个 TUI 窗口看同一个会话）拿到 bus 事件的时候，没法判断"我看到的 message.updated 是否漏过中间几个 part 更新"——分布式状态机重放就不可能。
- **slug 是手搓的 title 前缀**。下次 fork 一个会话，title 改了，slug 也跟着变，文件路径全乱。

## 5. opencode 的做法

opencode 把这三件事压进一个**事件溯源（event sourcing）模型**，并且把"建 Session 行"和"建 Message + Part 行"拆成两条命令：

### Session 行：`Session.create` → `createNext`

入口在 `packages/opencode/src/session/session.ts:657-677`：`create` 拿 `InstanceState.context` 拼一个 `directory` / `path` / `workspaceID` 出来，调内部的 `createNext` (`:523-569`)。`createNext` 做四件事：

1. **造 ID**：`SessionID.descending(input.id)`——这是个倒序 ULID（最新会话排在最前），所以列表查询零索引扫描。
2. **造 slug**：`Slug.create()`——和 title 解耦的随机 slug；title 可以被用户改 100 次，slug 永远是这个 session 在文件系统里的稳定 key。
3. **填默认值**：cost = 0，tokens 全 0（`EmptyTokens`），title 用 `createDefaultTitle()`（"New session - {ISO}"），permission 仅在用户显式传时落表（否则继承 agent ruleset）。
4. **`sync.run(Event.Created, { sessionID, info })`** —— 这是核心。

注意第 4 步：**它不是直接 INSERT 一行**。`sync.run` (`packages/opencode/src/sync/index.ts:136-171`) 跑的是这套流程：

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="sync.run atomic flow: transaction wraps projector plus event table plus seq update, bus publishes after commit">
  <defs>
    <marker id="art5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="260" y="16" width="240" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="34" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">sync.run(def, data)</text>
  <text x="380" y="50" text-anchor="middle" font-size="10" fill="#64748b">data = { sessionID, info }</text>
  <path d="M380,58 L380,80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#art5)"/>
  <rect x="60" y="84" width="640" height="200" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="80" y="106" font-size="12" font-weight="700" fill="currentColor">Database.transaction("immediate", tx =&gt; { ... })</text>
  <rect x="80" y="118" width="610" height="32" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="96" y="138" font-size="11" fill="currentColor">① seq = current_seq(aggregate_id) + 1</text>
  <text x="680" y="138" text-anchor="end" font-size="10" fill="#64748b">单调递增</text>
  <rect x="80" y="156" width="610" height="32" rx="4" fill="#fff" stroke="#0d9488" stroke-width="1.2"/>
  <text x="96" y="176" font-size="11" fill="currentColor">② projector(tx, data) — 真正写 SessionTable / MessageTable / PartTable</text>
  <rect x="80" y="194" width="610" height="32" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="96" y="214" font-size="11" fill="currentColor">③ INSERT INTO event_table(id, type, seq, aggregate_id, data)</text>
  <rect x="80" y="232" width="610" height="32" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="96" y="252" font-size="11" fill="currentColor">④ UPDATE event_sequence SET seq = new_seq</text>
  <path d="M380,288 L380,308" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#art5)"/>
  <text x="396" y="302" font-size="10" fill="#64748b">（事务成功提交后）</text>
  <rect x="220" y="312" width="320" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="330" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">bus.publish(def, data)</text>
  <text x="380" y="346" text-anchor="middle" font-size="10" fill="#64748b">TUI / SSE 订阅者立即收到</text>
</svg>
<span class="figure-caption">图 T5.1 ｜ sync.run 把"写表 + 写 event + 累加 seq"压进一个 immediate 事务，提交成功后才发 bus —— 订阅者据此可无条件信任事件载荷里的 ID。</span>

<details>
<summary>ASCII 原版</summary>

```text
sync.run(def, data)
  └─ Database.transaction("immediate", tx => {
        seq = current_seq(aggregate_id) + 1
        process(def, { id, seq, aggregateID, data }, { bus, publish })
          ├─ projector(tx, data)    // ← 真正写 SessionTable / MessageTable / PartTable
          ├─ INSERT INTO event_table(id, type, seq, aggregate_id, data)
          └─ UPDATE event_sequence SET seq = new_seq
     })
  └─ (事务成功后) bus.publish(def, data)
```

</details>

projector 在 `packages/opencode/src/session/projectors.ts:100-108`：

```ts
SyncEvent.project(Session.Event.Created, (db, data) => {
  db.insert(SessionTable).values(Session.toRow(data.info)).run()
  if (data.info.workspaceID) {
    db.update(WorkspaceTable).set({ time_used: Date.now() }).where(eq(WorkspaceTable.id, data.info.workspaceID)).run()
  }
})
```

写 SessionTable、写 event 表、bump seq、最后发 bus —— **同一个 immediate 事务**。事务回滚则四步全没。这把"写 + 发"原子化了。

### 用户消息：`SessionPrompt.createUserMessage`

route handler 拿到 `PromptInput` 后调 `promptSvc.prompt(input)` (`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:286-300` → `packages/opencode/src/session/prompt.ts:1210-1229`)。`prompt` 第一行就调 `createUserMessage(input)` (`:688-1208`)。

它造的是一个 `MessageV2.User` 实例（不是单纯的字符串）。Schema 在 `packages/opencode/src/session/message-v2.ts:327-350`：

```ts
export const User = Schema.Struct({
  id: MessageID,                  // "msg_<ULID>"
  sessionID: SessionID,
  role: Schema.Literal("user"),
  time: Schema.Struct({ created: NonNegativeInt }),
  agent: Schema.String,           // 必须解析出来 —— 用户没指定时落到 agent.defaultInfo()
  model: Schema.Struct({ providerID, modelID, variant? }),
  format: ...,                    // text / json_schema —— 决定后面是否注入 StructuredOutput 工具
  system: Schema.optional(String),// 单次请求级别的 system 覆盖
  tools: Schema.optional(Record<String, Boolean>),  // 单次请求级别的 tool 开关（已 deprecated 但仍兼容）
})
```

`createUserMessage` 解析步骤（`packages/opencode/src/session/prompt.ts:688-755`）：

1. **解析 agent**：`agents.get(input.agent)` 或 `agents.defaultInfo()`。找不到就抛错并发 `Session.Event.Error`。
2. **解析 model**：优先级 `input.model` > `agent.model` > `currentModel(sessionID)`（即 SessionTable 上次记录的模型）。
3. **解析 variant**：可被 agent 配置覆盖。
4. **构造 info**：填 `id = MessageID.ascending()`（这里反过来用**升序**ULID，因为消息按时间正序拉取）。
5. **触发"切换"事件**：如果 agent 或 model 跟上次不同，发 `SessionEvent.AgentSwitched` / `SessionEvent.ModelSwitched` —— TUI 可以画个状态条。
6. **写 info**：通过 `sessions.updateMessage(msg)` (`session.ts:618-622`) → `sync.run(MessageV2.Event.Updated, ...)` → projector 落 MessageTable。

注意 **Message 行先于 Part 行落表**，因为 PartTable 有外键 `message_id` 引用 MessageTable，倒过来就违反外键。

### 用户内容：Part 拆分

`createUserMessage` 接着循环 `input.parts`，对每个 part 调 `resolvePart` (`prompt.ts:787-1100+`)，根据 type 分发：

- `type: "text"` —— 直接转成 `MessageV2.TextPart`，可能扩展出额外的 reference text part（`@README.md` 这种 @ 提及会触发 `referenceTextPart`）。
- `type: "file"` —— 文件附件，可能转成 `FilePart` 或合成的 `TextPart`（依据 mime / 大小）。
- `type: "agent"` —— `AgentPart`，记录用户显式 mention 的 agent。
- `type: "subtask"` —— 转成 `SubtaskPart`，让 loop 走 subagent 分支。

我们的 trace 里 `parts = [{ type: "text", text: "What's in README.md?" }]`，所以只出一个 `TextPart`：

```ts
{
  id: PartID.ascending(),      // "prt_<ULID>"
  sessionID, messageID,
  type: "text",
  text: "What's in README.md?",
  // synthetic? ignored? time? metadata? 都 undefined
}
```

每个 Part 通过 `sessions.updatePart(p)` (`session.ts:624-632`) → `sync.run(MessageV2.Event.PartUpdated, { sessionID, part, time })` → projector (`projectors.ts:173-196`) 写 PartTable。projector 还顺手做 `applyUsage` —— assistant 的 tool 部分会带 token 计数，user text 不带，这里跳过。

### 为什么 Part 拆开而不是嵌进 Message

把消息按"语义片段（part）"拆成独立行的回报：

- **流式增量更新**：assistant 回包时，模型先吐一段文字、然后 tool_use 头、然后 tool_use 输入 JSON 增量、然后又一段文字。这些会落成多个 Part，每个 Part 独立 `PartUpdated` 事件流出去——TUI 不用等整条 message 拼完就能逐字符渲染。
- **状态机粒度**：tool Part 有 pending → running → completed/error 四态（`message-v2.ts:248-308`）；如果 tool 整在 message JSON 里，每次状态改要重写整段 message。
- **跨 message 引用**：CompactionPart 的 `tail_start_id` 直接指向另一条 message 的 id —— 这种引用在嵌套 JSON 里几乎不可能维护。
- **查询性价比**：拉一个会话最近 50 条 message 时，可以先只查 MessageTable（一行一条 messageID + time），按需 hydrate Parts；分页和总览界面不用把全部 tool 输出拉回来。

## 6. 代码位置

按本步骤实际调用顺序：

- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:286-300` —— HTTP `prompt` handler，路由把 payload 喂给 `promptSvc.prompt`。
- `packages/opencode/src/session/prompt.ts:1210-1229` —— `prompt` 的顶层实现：`sessions.get` → `revert.cleanup` → `createUserMessage` → 进 `loop`。
- `packages/opencode/src/session/session.ts:657-677` —— `Session.create` 包装（注入 directory / path）。
- `packages/opencode/src/session/session.ts:523-569` —— `createNext`：造 ID / slug / default title / 调 `sync.run(Event.Created, ...)`。
- `packages/opencode/src/session/session.ts:114-145` —— `toRow`：把 `Info` 平摊成 SessionTable 行。
- `packages/opencode/src/session/projectors.ts:100-108` —— Session.Created projector：INSERT SessionTable + 更新 WorkspaceTable.time_used。
- `packages/opencode/src/session/prompt.ts:688-755` —— `createUserMessage` 前半段：解析 agent / model / variant、造 `MessageV2.User`、发 AgentSwitched / ModelSwitched。
- `packages/opencode/src/session/message-v2.ts:327-350` —— `MessageV2.User` Schema 定义。
- `packages/opencode/src/session/message-v2.ts:97-111` —— `TextPart` Schema 定义。
- `packages/opencode/src/session/message-v2.ts:352-378` —— `Part` 判别联合（13 种 part 类型）。
- `packages/opencode/src/session/message-v2.ts:517-552` —— Event 表：`Updated` / `PartUpdated` / `PartDelta` / `Removed` / `PartRemoved`。
- `packages/opencode/src/session/session.ts:618-632` —— `updateMessage` / `updatePart`：唯一允许的写入入口，都走 `sync.run`。
- `packages/opencode/src/session/projectors.ts:125-196` —— Message.Updated / PartUpdated projector：upsert MessageTable / PartTable，PartUpdated 还顺便累加 `applyUsage`。
- `packages/opencode/src/sync/index.ts:136-171` —— `SyncEvent.run`：immediate 事务 + projector + event 表 + bus.publish 一把抓。
- `packages/opencode/src/session/session.sql.ts:16-91` —— SessionTable / MessageTable / PartTable 的 drizzle schema；注意 `MessageTable.data` 和 `PartTable.data` 是 JSON 列（discriminator 在 JSON 内）。
- `packages/opencode/src/storage/schema.sql.ts:1-10` —— `Timestamps`：所有表的 `time_created` / `time_updated` 默认值。
- `packages/opencode/src/bus/index.ts:100-121` —— `publish`：发到 typed PubSub + wildcard PubSub + GlobalBus。

## 7. 分支与延伸

- **Session 是什么 / 状态模型** —— 参见 [第 03 章 §Session 是什么](03-session-and-messages.md#session-是什么)。
- **MessageV2 与 Part** —— part 类型全集和 ToolState 四态见 [第 03 章 §MessageV2 与 Part](03-session-and-messages.md#messagev2-与-part)；流式 part 怎么逐字符更新见 [第 03 章 §流式 Part](03-session-and-messages.md#流式-part)。
- **SSE 实时事件流** —— `Bus.publish` 之后这些事件怎么穿出 server / TUI / web 客户端，见 [第 10 章 §SSE 实时事件流](10-runtime.md#sse-实时事件流)。
- **Event sourcing & projector 模式** —— `sync.run` / projector / event 表的整体设计，见 [第 11 章 §事件溯源与 projector](11-storage.md#事件溯源与-projector)。
- **Fork 一个会话** —— `Session.fork` (`session.ts:679-719`) 怎么把整条 message 链复制到新 sessionID，是同一套写入路径，参见 [第 03 章 §Fork 与 Revert](03-session-and-messages.md#fork-与-revert)。
- **MessageID 升序 vs SessionID 降序** —— ULID 朝向决定查询效率，见 `packages/opencode/src/id/id.ts`。

## 8. 走完这一步你脑子里应该多了什么

1. **opencode 的会话状态是事件溯源的**。任何对 SessionTable / MessageTable / PartTable 的写都不是裸 INSERT，而是 `sync.run(Event, data)` → 在一个 immediate 事务里跑 projector + 写 event 表 + bus.publish。读边到 `INSERT INTO message_table` 的代码片段时，你知道它一定在某个 projector 里。
2. **消息按 Part 拆开，是为了流式渲染和状态机**——不是为了好看。assistant 回来 10 个 part，10 次 `PartUpdated` 事件，TUI 同步增量画。Tool Part 还有自己 4 态的 ToolState 子状态机。
3. **Session 行用降序 ID，Message 行用升序 ID**。前者让"最近会话排第一"零成本；后者让"按时间正序拉消息"零成本。这是数据库层面的免费午餐。
4. **slug ≠ title**。slug 是稳定的内部 key，title 是可改的人类显示；fork 一个会话时 title 会带 "(fork #N)"，slug 重新生成。
5. **`Session.create` 并不在 run 命令里被显式调一次**。CLI / SDK 的 v2 prompt 路径要么命中已有 sessionID，要么由 server 端为这个请求按需建一个；用户视角"突然就有了 session"是这个流程的产物。
6. **bus.publish 在事务成功后才发**。你不会看到一个事件而对应的行还没落库——这是构造时刻意的顺序，订阅者据此可以无条件信任事件载荷里的 ID。

走完这一步：DB 里有 1 个 Session 行（slug 已定、cost=0、tokens 全 0、agent=`"build"`、model=`{anthropic, claude-sonnet-4.5}`、title 是默认日期串）、1 条 `MessageV2.User` 行（agent / model / format=text）、1 个 `TextPart` 行（text="What's in README.md?"）。Bus 上已经发出 `session.created`、`message.updated`、`message.part.updated` 三条事件。

下一步：[Trace 步骤 06 —— 装配 system prompt 与工具表](tour-06-build-prompt.md)
