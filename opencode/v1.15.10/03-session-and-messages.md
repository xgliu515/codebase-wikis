# 03 会话与消息模型

opencode 的所有用户可见状态都挂在三层结构上：`Session → Message → Part`。这一章把这三层的 schema、运行时关系、流式语义、与 storage / bus 的耦合方式逐项拆开，并解释为什么作者要这样设计——而不是沿用 ChatGPT API 那种 `{role, content: string}` 的扁平形态。

代码版本：`anomalyco/opencode@d74d166ac`（tag `v1.15.10`）。所有 `file:line` 引用均锁定到这个 commit。

## Session 是什么

opencode 的 "会话"（Session）是一段连续的人机对话。它绑定一个 project、一个工作目录、一个 agent、一个模型；它持有这次对话累积出来的 token / cost / summary / revert 记录；它也是消息和工具结果的归属容器。

`Info` schema 定义在 `packages/opencode/src/session/session.ts:208-228`：

```ts
export const Info = Schema.Struct({
  id: SessionID,
  slug: Schema.String,
  projectID: ProjectID,
  workspaceID: optionalOmitUndefined(WorkspaceID),
  directory: Schema.String,
  path: optionalOmitUndefined(Schema.String),
  parentID: optionalOmitUndefined(SessionID),
  summary: optionalOmitUndefined(Summary),
  cost: optionalOmitUndefined(Schema.Finite),
  tokens: optionalOmitUndefined(Tokens),
  share: optionalOmitUndefined(Share),
  title: Schema.String,
  agent: optionalOmitUndefined(Schema.String),
  model: optionalOmitUndefined(Model),
  version: Schema.String,
  time: Time,
  permission: optionalOmitUndefined(Permission.Ruleset),
  revert: optionalOmitUndefined(Revert),
}).annotate({ identifier: "Session" })
```

几个关键字段值得逐个解释：

- **id**：`ses_` 前缀的 ULID 风格 ID。看 `session.ts:536` `SessionID.descending(input.id)`——session ID 是**降序**生成的（高位时间戳取反），这样列表查询 `ORDER BY id DESC` 就能直接按时间倒序返回最新会话，不需要二级索引。
- **slug**：一个短哈希（`Slug.create()`），用作分享 URL 和文件名片段。
- **projectID**：必填。每个 session 必属于某个 project（详见后文 "Project / Workspace / Directory"）。
- **workspaceID**：可选。`v1.15.10` 起支持的多 worktree 工作区，详见 `packages/opencode/src/control-plane/`。
- **directory**：session 创建时的 cwd，绝对路径。注意它**可以**是 project worktree 的某个子目录。
- **parentID**：若该 session 是 subagent 派生出来的子会话，这里指向父 session。subagent 的实现细节在第 04 章。
- **agent**：用哪一种 agent 配置（"build" / "plan" / "general" 等）。一旦写入，整个会话生命周期内对每条 user message 都会被独立读取（详见后文）。
- **model**：默认模型。每条 user message 也会独立携带 model 字段，所以**改 model 不影响历史**。
- **revert**：一个"回到这里"的指针 + 快照 ID。`SessionRevert` 服务用它在用户撤销时把工作树拉回到那个时间点。
- **summary**：自上次 compact 以来累计的代码 diff 统计（增/删/文件数）。
- **cost / tokens**：整个会话的累计成本和分桶 token 计数（input、output、reasoning、cache.read、cache.write）。
- **time.compacting / time.archived**：标志位时间戳。`time.archived` 用来软删除——`listGlobal` 默认会过滤掉 `time_archived IS NOT NULL` 的行（`session.ts:969-971`）。

### Session 的 SQLite schema

`packages/opencode/src/session/session.sql.ts:16-59` 用 drizzle-orm 把上面那个 Effect Schema 落到一张表上：

```ts
export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionID>().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceID>(),
    parent_id: text().$type<SessionID>(),
    slug: text().notNull(),
    directory: text().notNull(),
    path: text(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.FileDiff[]>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<{ messageID: MessageID; partID?: PartID; snapshot?: string; diff?: string }>(),
    permission: text({ mode: "json" }).$type<Permission.Ruleset>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{ id: string; providerID: string; variant?: string }>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
  ],
)
```

设计要点：

- **结构字段 vs JSON 字段**：可索引的查询字段（id、project_id、title、time_updated）是真正的列；复合对象（`summary_diffs`、`revert`、`permission`、`model`）则塞进 `text({ mode: "json" })`——drizzle 在读写时自动 `JSON.parse/stringify`。这避免了把 schema 拆成十几个小列，又保留了主要查询能力。
- **`Timestamps` 公用片段**（`packages/opencode/src/storage/schema.sql.ts:3-10`）：

  ```ts
  export const Timestamps = {
    time_created: integer().notNull().$default(() => Date.now()),
    time_updated: integer().notNull().$onUpdate(() => Date.now()),
  }
  ```

  注意 `time_updated` 用的是 `$onUpdate`——drizzle 在任何一次 UPDATE 上都会自动重写它。所以 `Session.touch()`（`session.ts:723-725`）实际上就是发一个空 patch，让 `$onUpdate` 把 `time_updated` 刷新到 `Date.now()`。
- **`onDelete: "cascade"`**：删除 project 会级联删 session；删除 session 又会级联删 message 和 part（见 `session.sql.ts:68, 82`）。再加上 `time_archived` 软删除，opencode 永远不会留下"孤儿" message。
- **`session_parent_idx`**：subagent 派生的子会话通过 `parent_id` 反查父会话；这条索引让 `children(parentID)` 查询拿成单次 b-tree 查找（`session.ts:584-593`）。

`fromRow` 函数（`session.ts:61-112`）负责把 SQL 行转回 `Info` 结构；`toRow`（`session.ts:114-145`）做反向转换。它们是 SQLite 物理表和 Effect Schema 之间唯一的胶水层——所以其他代码都不直接接触 SQL 行。

## MessageV2 与 Part：为什么要拆开

ChatGPT API 把一条消息建模为：

```text
{ role: "assistant", content: "Here is the file: ..." }
```

这种扁平模型在 agentic loop 里立刻就崩了，原因有四：

1. **工具调用穿插**：assistant 一条 turn 内可能先说一段话，再调工具 A，再调工具 B，再总结。content 是字符串容不下这种"穿插"。
2. **流式**：模型按 token 流式输出时，UI 必须能局部更新（"这段 reasoning 又长了 30 个字符"），而不是每 30 个字符 diff 整条字符串。
3. **多模态**：模型也能输出图片、文件 URL。tool 调用还可能附带 PDF / 图像作为附件。content 字段无法表达 "这一段是文本，那一段是图像，再下一段又是文本"。
4. **reasoning trace**：Claude / o1 / o3 这类模型有"思维链"，UI 上要单独折叠展示，且 reasoning 不能进入 user-visible "answer"。

opencode 的解决方法是把消息打散成多个 **Part**，每个 Part 有自己的类型 / 状态 / 元数据。`packages/opencode/src/session/message-v2.ts:352-378` 列出全部 12 种 Part：

```ts
export const Part = Schema.Union([
  TextPart,        // 普通文本
  SubtaskPart,     // 子任务调用（subagent task）
  ReasoningPart,   // 思维链
  FilePart,        // 文件 / 图片 / PDF 附件
  ToolPart,        // 工具调用 + 结果（含四态状态机）
  StepStartPart,   // 一个 step 开始的标记
  StepFinishPart,  // 一个 step 结束 + 该 step 的 token / cost
  SnapshotPart,    // 工作树快照引用（用于 revert）
  PatchPart,       // 文件 patch 引用
  AgentPart,       // @agent 提及
  RetryPart,       // 一次重试的记录
  CompactionPart,  // 一次自动压缩的边界标记
]).annotate({ discriminator: "type", identifier: "Part" })
```

每种 Part 都从 `partBase`（`message-v2.ts:76-80`）继承三个公共字段：

```ts
const partBase = {
  id: PartID,         // prt_xxx
  sessionID: SessionID,
  messageID: MessageID,
}
```

也就是说一个 Part 同时知道自己属于哪个 session、哪个 message、自己是谁。这种"自包含"让事件总线广播 `PartUpdated` 时不需要额外查表。

### Part 的几个关键类型展开

**TextPart**（`message-v2.ts:97-111`）有两个不太显眼但很重要的标志位：

```ts
export const TextPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: NonNegativeInt,
      end: Schema.optional(NonNegativeInt),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "TextPart" })
```

- `synthetic: true` —— 这条文本不是用户/模型真的输入的，而是 opencode 自己注入的（如 plan-mode 系统提醒、子任务结果回流）。TUI 一般不渲染它们，但 LLM 请求会带上。
- `ignored: true` —— 反过来，UI 渲染、但**不**发给 LLM。`message-v2.ts:704` 显式 `if (part.type === "text" && !part.ignored && part.text !== "")` 把 ignored 过滤掉。

**ToolPart**（`message-v2.ts:310-320`）封装的是一次工具调用的整段生命周期。它的 `state` 是一个 4-态判别联合（`message-v2.ts:299-308`）：

```ts
export const ToolState = Schema.Union([
  ToolStatePending,   // 模型刚发出调用，参数尚未完整
  ToolStateRunning,   // 参数已收完，工具正在执行
  ToolStateCompleted, // 工具返回，含 output / metadata / attachments
  ToolStateError,     // 工具失败或被中断
]).annotate({ discriminator: "status", identifier: "ToolState" })
```

为什么要四态？因为 opencode 是**流式**接收 tool_call：

1. `pending`：`tool-input-start` 到达，开始累积参数 JSON，但还没有完整结构。
2. `running`：`tool-input-end` + `tool-call` 都到了，参数合法，工具开始 spawn。
3. `completed`：工具 promise resolve，写入 `output` 字段。
4. `error`：工具 throw，或被 abort（`processor.ts` 在 abort 时也会把 pending/running 翻成 error，见 `message-v2.ts:849-858`）。

如此 UI 在每个时间点都能渲染"现在工具在跑、这是它已知的参数"，并在结束后切到"工具已完成、这是输出"。

**ReasoningPart**（`message-v2.ts:113-122`）和 TextPart 几乎一样，但 `time` 是必填的——reasoning 一定有起止时间，因为 UI 要算"思考了多少秒"。

**CompactionPart**（`message-v2.ts:184-191`）是一个边界标记，标记 "这条 user 消息触发了一次自动压缩，从这里开始的 history 已被替换为 summary"。`tail_start_id` 指向被保留的最早 message，`filterCompacted`（`message-v2.ts:1014-1065`）就靠它把"压缩前的历史尾巴 + 压缩后的 summary + 后续新对话"重新拼回正确顺序喂给 LLM。

### User 消息和 Assistant 消息

`Info` 是 User / Assistant 的判别联合（`message-v2.ts:492-493`）：

```ts
export const Info = Schema.Union([User, Assistant]).annotate({ discriminator: "role", identifier: "Message" })
```

**User**（`message-v2.ts:327-350`）：

```ts
export const User = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("user"),
  time: Schema.Struct({ created: NonNegativeInt }),
  format: Schema.optional(Format),
  summary: Schema.optional(/* title, body, diffs */),
  agent: Schema.String,
  model: Schema.Struct({ providerID, modelID, variant }),
  system: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
})
```

值得注意：**每条 user 消息都独立带 `agent` 和 `model`**。这不是冗余——因为 opencode 允许用户在同一个 session 内**切换 agent**（比如先 plan 再 build），也允许切模型。session 上的 `agent` 字段只是"默认值"；真正生效的是该 user turn 上写下的值。`format`（`OutputFormatText` / `OutputFormatJsonSchema`）允许这一条 user message 要求结构化输出。

**Assistant**（`message-v2.ts:452-490`）：

```ts
export const Assistant = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("assistant"),
  time: Schema.Struct({ created, completed }),
  error: Schema.optional(AssistantErrorSchema),
  parentID: MessageID,             // 关联到激发它的 user message
  modelID: ModelID,
  providerID: ProviderID,
  mode: Schema.String,              // @deprecated
  agent: Schema.String,
  path: Schema.Struct({ cwd, root }),
  summary: Schema.optional(Schema.Boolean),
  cost: Schema.Finite,
  tokens: /* 整条 turn 的 token 分桶 */,
  structured: Schema.optional(Schema.Any),  // 若用户要 JSON
  variant: Schema.optional(Schema.String),
  finish: Schema.optional(Schema.String),   // "stop" / "tool-calls" / "length" / ...
})
```

`parentID` 是一条 backref：assistant 永远指向触发自己的那条 user。`fork` 函数（`session.ts:679-719`）在复制消息时会重写这条引用——它维护一个 `idMap` 来把旧 ID 翻译到新 ID。

`AssistantErrorSchema`（`message-v2.ts:380-386`）汇集 5 种错误：`AbortedError`、`StructuredOutputError`、`ContextOverflowError`、`APIError`，以及 `MessageError.Shared` 里的认证 / 输出长度等通用错误。错误是一等公民——assistant turn 失败时，整条 message 仍然被保留下来，只是 `error` 字段非空。`fromError`（`message-v2.ts:1096-1201`）是把任意异常折叠到这 5 种之一的中央分类器。

## Part 单独成表的理由

把 Part 放进 Message 的 JSON column 里看上去更简单，但 opencode 没有这么做。`PartTable`（`session.sql.ts:75-91`）是一张独立表：

```ts
export const PartTable = sqliteTable(
  "part",
  {
    id: text().$type<PartID>().primaryKey(),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionID>().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<PartData>(),
  },
  (table) => [
    index("part_message_id_id_idx").on(table.message_id, table.id),
    index("part_session_idx").on(table.session_id),
  ],
)
```

理由有三：

1. **增量写入**：流式输出每次新增 token 都要 `UPDATE` part。如果 part 嵌在 message 的 JSON 里，每次都得读出整条 message、修改、再写回——开销随历史长度 O(n)。独立表后变成单行 UPDATE，恒定开销。
2. **部分加载**：分享页面、压缩流程只需要某些 part 类型（比如只看 text，过滤掉 step-start / snapshot）。独立表允许 `WHERE type = ...` 这种查询，而不是先 fetch 整条再 in-memory filter。
3. **PartID 单调递增**：`PartID.ascending()`（`schema.ts:21-23`）保证 part 在表内按创建顺序排序。`hydrate` 函数（`message-v2.ts:598-622`）的 `orderBy(PartTable.message_id, PartTable.id)` 直接靠这条索引拿到一条消息的全部 part，并保留生成顺序。

`PartData` 是 `Omit<MessageV2.Part, "id" | "sessionID" | "messageID">`（`session.sql.ts:12`）——即去掉 partBase 三个字段。这三个字段已经在 SQL 列里了，没必要在 JSON payload 里再存一份。

## Session / Message / Part 三层关系

<svg viewBox="0 0 820 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Four level cascade table relationship Project Session Message Part">
  <defs>
    <marker id="r3ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="260" y="16" width="300" height="68" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="410" y="36" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">ProjectTable</text>
  <line x1="280" y1="44" x2="540" y2="44" stroke="#cbd5e1"/>
  <text x="280" y="60" font-size="10" fill="currentColor">id (PK)　worktree　vcs</text>
  <text x="280" y="76" font-size="10" fill="#64748b">name　icon　time　sandboxes</text>
  <path d="M410,84 L410,114" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r3ar1)"/>
  <text x="420" y="104" font-size="9.5" fill="#94a3b8">ON DELETE CASCADE（project_id）</text>
  <rect x="200" y="116" width="420" height="100" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="136" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">SessionTable</text>
  <line x1="220" y1="144" x2="600" y2="144" stroke="#cbd5e1"/>
  <text x="220" y="162" font-size="10" fill="currentColor">id (PK)　project_id (FK)　parent_id (FK self)</text>
  <text x="220" y="178" font-size="10" fill="currentColor">workspace_id　agent　model</text>
  <text x="220" y="194" font-size="10" fill="#64748b">cost　tokens_*　revert (JSON)　permission (JSON)</text>
  <text x="220" y="210" font-size="10" fill="#94a3b8">time_created / time_updated / time_archived</text>
  <path d="M410,216 L410,246" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r3ar1)"/>
  <text x="420" y="236" font-size="9.5" fill="#94a3b8">ON DELETE CASCADE（session_id）</text>
  <rect x="200" y="248" width="420" height="84" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="410" y="268" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">MessageTable</text>
  <line x1="220" y1="276" x2="600" y2="276" stroke="#cbd5e1"/>
  <text x="220" y="294" font-size="10" fill="currentColor">id (PK)　session_id (FK)</text>
  <text x="220" y="310" font-size="10" fill="currentColor">data (JSON: User | Assistant)</text>
  <text x="220" y="326" font-size="10" fill="#94a3b8">time_created / time_updated</text>
  <path d="M410,332 L410,362" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r3ar1)"/>
  <text x="420" y="352" font-size="9.5" fill="#94a3b8">ON DELETE CASCADE（message_id）</text>
  <rect x="200" y="364" width="420" height="90" rx="6" fill="#0ea5e9" stroke="#0ea5e9" stroke-width="1.5" fill-opacity="0.18"/>
  <text x="410" y="384" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">PartTable</text>
  <line x1="220" y1="392" x2="600" y2="392" stroke="#cbd5e1"/>
  <text x="220" y="410" font-size="10" fill="currentColor">id (PK)　message_id (FK)</text>
  <text x="220" y="426" font-size="10" fill="currentColor">session_id（去规范化，加速 by-session 查询）</text>
  <text x="220" y="442" font-size="10" fill="#64748b">data (JSON: 12 种 Part)</text>
  <rect x="40" y="470" width="740" height="56" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4,3"/>
  <text x="60" y="490" font-size="11" font-weight="600" fill="currentColor">运行时形态 ── WithParts</text>
  <text x="60" y="506" font-size="10" fill="#64748b">WithParts = &#123; info: Message.Info, parts: Part[] &#125;</text>
  <text x="60" y="520" font-size="10" fill="#64748b">hydrate(rows) 用 2 次 SELECT 把 MessageTable + PartTable JOIN 拼回 WithParts[]</text>
</svg>
<span class="figure-caption">图 R3.1 ｜ Session / Message / Part 三层加上 Project 父表的级联关系；写到底层都靠 ON DELETE CASCADE，读时由 hydrate 用 2 次 SELECT 把 Message + Part 拼成运行态 WithParts。</span>

<details>
<summary>ASCII 原版</summary>

```text
ProjectTable                                      project_id 引用
  id (PK)  ─────────────────────────────┐
  worktree                              │
  ...                                   │ ON DELETE CASCADE
                                        ▼
                              SessionTable
                                id (PK)     ─────────────┐
                                project_id (FK)          │
                                parent_id (FK self)      │
                                workspace_id             │ ON DELETE CASCADE
                                agent / model            │
                                cost / tokens            │
                                ...                      │
                                                         ▼
                                                MessageTable
                                                  id (PK)       ─────────┐
                                                  session_id (FK)        │
                                                  time_created, time_updated
                                                  data (JSON: User | Assistant) │ CASCADE
                                                                                ▼
                                                                         PartTable
                                                                           id (PK)
                                                                           message_id (FK)
                                                                           session_id (denormalized)
                                                                           data (JSON: 12 种 Part)

WithParts 视图（运行时形态）:
  WithParts = { info: Message.Info, parts: Part[] }
  hydrate(rows) 把 MessageTable + PartTable JOIN 拼回 WithParts[]
```

</details>

几条不显眼但重要的链接：

- **PartTable.session_id 是冗余字段**：理论上 part → message → session 已经能反查，但 `part_session_idx`（`session.sql.ts:89`）让 "拉这个 session 所有 part" 是一次索引查找，不需要先 SELECT message。
- **MessageTable 没有 `parent_id`**：assistant 的 parentID 不通过 SQL 索引——它存在 `data` 这个 JSON 里。因为 message tree 通常很浅、按时间顺序遍历就够，没必要建一棵真索引树。
- **`message_session_time_created_id_idx`**（`session.sql.ts:72`）：复合索引 `(session_id, time_created, id)`——用于分页查询。`MessageV2.page`（`message-v2.ts:923-962`）用 `(time_created, id)` 二元组作为光标，单调降序遍历整个会话，避免 `OFFSET` 的全扫描。

## 流式 Part 与增量更新

opencode 的流式策略很直接：**每个流式片段是同一个 Part 的累积**，不是新建 Part。

以 text 流为例，`processor.ts:619-680` 处理三种 AI SDK 事件：

```ts
case "text-start":
  ctx.currentText = {
    id: PartID.ascending(),
    messageID: ctx.assistantMessage.id,
    sessionID: ctx.assistantMessage.sessionID,
    type: "text",
    text: "",
    time: { start: Date.now() },
    metadata: value.providerMetadata,
  }
  yield* session.updatePart(ctx.currentText)
  return

case "text-delta":
  if (!ctx.currentText) return
  ctx.currentText.text += value.text
  if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
  yield* session.updatePartDelta({
    sessionID: ctx.currentText.sessionID,
    messageID: ctx.currentText.messageID,
    partID: ctx.currentText.id,
    field: "text",
    delta: value.text,
  })
  return

case "text-end":
  if (!ctx.currentText) return
  // ... 触发 experimental.text.complete 插件 ...
  ctx.currentText.time = { start: ..., end: Date.now() }
  // 最终落库（updatePart 走 SyncEvent，会写 SQLite）
```

`reasoning-start` / `reasoning-delta` / `reasoning-end` 是同构的（`processor.ts:307-348`），但用一张 `ctx.reasoningMap` 索引——因为 reasoning 流可能多个 ID 交错（不同的 reasoning 块），不能用单一 `currentText` 指针。

### 两个事件：`PartUpdated` vs `PartDelta`

`packages/opencode/src/session/message-v2.ts:530-545` 定义了这两个不同事件：

```ts
PartUpdated: SyncEvent.define({
  type: "message.part.updated",
  version: 1,
  aggregate: "sessionID",
  schema: PartUpdatedEventSchema,
}),
PartDelta: BusEvent.define(
  "message.part.delta",
  Schema.Struct({
    sessionID, messageID, partID,
    field: Schema.String,
    delta: Schema.String,
  }),
),
```

- `PartUpdated` 是 **SyncEvent**——它持久化到 SQLite（`time_created` 单调递增、可重放），客户端订阅它就能"补齐落下的状态"。每次 `Session.updatePart` 都写一次完整 Part snapshot。
- `PartDelta` 是 **BusEvent**——纯内存广播，不入库。它只携带 "field X 追加 N 字节"，TUI 拿到后做字符串追加。

这种"全量 + 增量"的双轨设计是为了同时满足：

1. **追赶**：客户端刚连上时拿到完整 Part 即可（一次 `PartUpdated` 就够了）。
2. **低延迟流式**：稳态下每个 token 只走 `PartDelta`（payload 很小、不写盘），UI 立刻显示。
3. **结束态收敛**：流结束时再发一次 `PartUpdated`（带上 `time.end`、最终 metadata），客户端把它当作"权威快照"。

`Session.updatePartDelta` 实现（`session.ts:812-820`）：

```ts
const updatePartDelta = Effect.fnUntraced(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  partID: PartID
  field: string
  delta: string
}) {
  yield* bus.publish(MessageV2.Event.PartDelta, input)
})
```

注意只 `publish` 到 bus，**没有** `sync.run`——所以 delta 不入 SQLite 也不写 SyncEvent 日志。`Session.updatePart`（`session.ts:624-632`）相反，走 `sync.run`，会落库。

### 为什么没有 `isStreaming` 标志

读者可能注意到 Part schema **没有** `isStreaming: boolean` 字段。这是有意为之：流式状态是通过 `time.end` 是否存在来推断的。`TextPart.time.end` 可选（`message-v2.ts:103-108`），ReasoningPart 类似（`message-v2.ts:118-121`），ToolPart 则用 `state.status` 区分。TUI 渲染时：

- `time.end === undefined` → 渲染光标 / 加载动画
- `time.end != null` → 渲染为终态

把"是否在流"和"何时结束"合并成一个时间戳，省了一个状态字段，且时间本身就是有用信息。

## Project / Workspace / Directory

每个 session 必须挂在某个 project 下。Project 的定义在 `packages/opencode/src/project/project.ts:46-56`：

```ts
export const Info = Schema.Struct({
  id: ProjectID,
  worktree: Schema.String,
  vcs: optionalOmitUndefined(ProjectVcs),    // "git" 或 undefined
  name: optionalOmitUndefined(Schema.String),
  icon: optionalOmitUndefined(ProjectIcon),
  commands: optionalOmitUndefined(ProjectCommands),
  time: ProjectTime,
  sandboxes: Schema.Array(Schema.String),
})
```

### ProjectID 是怎么生成的

opencode 不用本地路径作 project key——那不稳定（用户可以移动目录、checkout 不同 worktree 到不同位置）。它用 git 仓库的**根 commit ID**：

```ts
// project.ts:248-258
const revList = yield* git(["rev-list", "--max-parents=0", "HEAD"], { cwd: sandbox })
const roots = revList.text.split("\n").filter(Boolean).map((x) => x.trim()).toSorted()
id = roots[0] ? ProjectID.make(roots[0]) : undefined
if (id) {
  yield* fs.writeFileString(pathSvc.join(common, "opencode"), id).pipe(Effect.ignore)
}
```

`--max-parents=0` 找到的就是无父节点的 root commit（创世提交）。如果仓库有多个独立 root（罕见但合法），按字典序排序取第一个。这个 ID 写入 `.git/opencode` 文件作为缓存，下次直接读 `readCachedProjectId`（`project.ts:189-195`）省一次 `git rev-list`。

不在 git repo 里？project ID 退化为常量 `ProjectID.global`（`project/schema.ts`）：

```ts
export const ProjectID = projectIdSchema.pipe(
  withStatics((schema) => ({
    global: schema.make("global"),
  })),
)
```

也就是说，**所有非 git 环境的 session 共享一个虚拟的 "global" project**。

### Worktree vs Directory vs Sandbox

三个相关字段经常混淆，按 `project.ts` 的语义：

- **worktree**：git 命令 `rev-parse --show-toplevel` 的结果——这个 worktree 的根（普通 worktree 是工作树根，bare repo 是 git 目录本身）。
- **sandbox**：用户实际 cd 进去并启动 opencode 的目录（可能是 worktree 的某个子目录）。
- **directory** / `Session.directory`：sandbox 同义词；session 创建时的 cwd。

`project.ts:241` 给出 worktree 的判定规则：

```ts
const worktree = common === sandbox ? sandbox : isBareRepo ? common : pathSvc.dirname(common)
```

`session.path`（可选）则是 `path.relative(worktree, directory)`，用 `/` 做分隔符（`session.ts:157-159`）——它的用途是"在这个 worktree 内、相对路径是什么"，TUI 列表可以用它分组。

### 同时存在多个 session

`SessionTable.parent_id` 是 nullable 自引用——根 session 的 `parent_id` 为 NULL。`listByProject`（`session.ts:891-941`）支持多种过滤：

```ts
if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
if (input.path !== undefined) /* path 前缀匹配 */
else if (input.scope !== "project" && !input.experimentalWorkspaces) {
  if (input.directory) conditions.push(eq(SessionTable.directory, input.directory))
}
if (input.roots) conditions.push(isNull(SessionTable.parent_id))
if (input.start) conditions.push(gte(SessionTable.time_updated, input.start))
if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
```

`roots: true` 就是只要根 session（过滤掉 subagent 子会话）。结合 `time_updated DESC` 排序，TUI 的 "Recent sessions" 列表用一条查询就拿到。

## Storage 抽象

`packages/opencode/src/storage/storage.ts:59-66` 定义了 façade 接口：

```ts
export interface Interface {
  readonly remove: (key: string[]) => Effect.Effect<void, AppFileSystem.Error>
  readonly read: <T>(key: string[]) => Effect.Effect<T, Error>
  readonly update: <T>(key: string[], fn: (draft: T) => void) => Effect.Effect<T, Error>
  readonly write: <T>(key: string[], content: T) => Effect.Effect<void, AppFileSystem.Error>
  readonly list: (prefix: string[]) => Effect.Effect<string[][], AppFileSystem.Error>
}
```

注意——这个 façade **不是** SQLite 的入口。`Storage.Service` 操作的是 `$DATA/storage/<key>.json` 这种文件，主要用来存"不进 SQLite 的边角资料"：会话 diff（`Session.diff` 走 `["session_diff", sessionID]`，见 `session.ts:761-765`）、分享元数据、临时 blob 等。

主存储是 drizzle + SQLite，入口是 `packages/opencode/src/storage/db.ts`，被 `Session.create / list / get` 等直接调用（`session.ts:507-508`）：

```ts
const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
  Effect.sync(() => Database.use(fn))
```

### 每次写都发事件

Session / Message / Part 的写操作都通过 `SyncEvent` 服务发事件。看 `Session.createNext`（`session.ts:557`）：

```ts
yield* sync.run(Event.Created, { sessionID: result.id, info: result })
```

`SyncEvent.run` 同时做两件事：

1. 把事件追加到 `session_message` 表（事件日志）；
2. 在 bus 上 publish 该事件（订阅者立即收到）。

为什么这么设计？因为 opencode 是 **客户端 / 服务端架构**——TUI 是独立进程，通过 HTTP/SSE 连到 `opencode serve` 进程。客户端要能：

- 一次性拿到当前快照（`SELECT * FROM message WHERE session_id = ?`）；
- 然后从某个 sync 序号开始**增量订阅后续变化**（事件日志重放）。

没有事件日志就无法 reconnect 后追赶；没有 bus 就无法低延迟推送。`SyncEvent` 把两者合一。后续章节会专门讲 sync / bus / event 协议。

### Storage façade 上仍然有事件层吗？

`Storage.write/read` 自身不发事件——它纯粹是文件 IO + 读写锁（`TxReentrantLock`，`storage.ts:286-300`）。但调用者通常会同时调用一次 `bus.publish` 或 `sync.run` 来通告变更。

`Storage.update` 的写法值得注意（`storage.ts:286-300`）：

```ts
const update: Interface["update"] = <T>(key: string[], fn: (draft: T) => void) =>
  Effect.gen(function* () {
    const value = yield* withResolved(key, (target, rw) =>
      TxReentrantLock.withWriteLock(
        rw,
        Effect.gen(function* () {
          const content = yield* wrap(target, fs.readJson(target))
          fn(content as T)
          yield* writeJson(target, content)
          return content
        }),
      ),
    )
    return value as T
  })
```

`fn(content)` 直接 mutate `content`，然后 `writeJson` 写回——这是 immer 风格但没有 immer 库。配合 `TxReentrantLock.withWriteLock` 保证读-改-写原子。

## JSON → SQLite 一次性迁移

opencode 早期版本把每条 message / part 都存成单独的 `.json` 文件。`v1.x` 切到 SQLite 之后，`packages/opencode/src/storage/json-migration.ts` 负责把老数据搬过去。它在 `Database` 首次 open 时被调用一次，幂等。

### 为什么放弃 JSON 文件

1. **写放大**：每条流式 delta 都要重写整个 part 文件——一个长 reasoning 块可能触发上千次 fsync。
2. **查询能力**：列出某 project 下所有 session、按 `time_updated DESC` 排序，对文件树是 O(n) 全扫描。
3. **跨字段查询**：搜索标题、过滤未归档、按 workspace 筛选——这些在文件 + 文件名前缀的模型里实现起来都很扭。
4. **关系完整性**：项目删除时级联清理 session/message/part，文件系统没有原生支持。
5. **打包尺寸**：百万级小文件对 macOS / NTFS 都不友好。

切到 SQLite 后这些问题全部交给数据库处理，opencode 自身的代码量也变小。

### 迁移脚本骨架

`json-migration.ts:25-435` 流程：

```text
1. 检测 $DATA/storage/ 是否存在；不存在直接返回。
2. PRAGMA journal_mode=WAL / synchronous=OFF（极速插入设置）
3. glob 一次性预扫所有文件路径（不读内容）：
     project/*.json, session/*/*.json, message/*/*.json,
     part/*/*.json, todo/*.json, permission/*.json, session_share/*.json
4. BEGIN TRANSACTION
5. 按依赖顺序分批 INSERT ... ON CONFLICT DO NOTHING：
     projects → sessions → messages → parts → todos → permissions → shares
6. COMMIT
7. 记录 stats（每类多少条、孤儿多少条、错误列表）
```

关键设计：

- **ID 来自路径，不来自 JSON 内容**（`json-migration.ts:163, 198, 262, 293`）：

  ```ts
  const id = path.basename(projectFiles[i + j], ".json")
  ```

  因为先前的 migration 可能已经把 session 文件移动到其他目录但没改 JSON 里的 ID 字段；路径才是真值。

- **批量插入 + `onConflictDoNothing`**（`json-migration.ts:101`）：

  ```ts
  db.insert(table).values(values).onConflictDoNothing().run()
  ```

  迁移可重入：即使中途崩掉，下次重跑只会跳过已迁过的行。

- **孤儿过滤**（`json-migration.ts:200-203, 247, 330-333`）：找不到父行（session/project）的 child 直接跳过并计数，避免 FK 约束失败。

- **`Promise.allSettled` + 预分配数组**（`json-migration.ts:77-96`）：用 `new Array(count)` 预分配批次缓冲，然后 `Promise.allSettled` 并发读 JSON 文件。失败项只记日志、不中断。

- **PRAGMA 关 fsync**（`json-migration.ts:48-51`）：迁移期间允许丢数据（反正源数据还在 JSON 里），换得几个数量级的 INSERT 速度。迁移完成后下次启动 PRAGMA 自动恢复成默认值。

迁移完成后 JSON 文件**不**被删除——opencode 不主动 GC 老文件。用户可以手动 `rm -rf $DATA/storage/` 回收。这是有意保守：万一 SQLite 数据损坏，回退到 JSON 还有救。

## 把这些零件连起来：一次 user prompt 的写入路径

把上面这些抽象组合起来，看一次 user 输入消息后整个写入链是什么样的：

<svg viewBox="0 0 820 600" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Write path of a user prompt from TUI to SQLite plus bus plus SSE">
  <defs>
    <marker id="r3ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="260" y="16" width="300" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="40" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">TUI / CLI 收到用户回车</text>
  <path d="M410,56 L410,76" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r3ar2)"/>
  <rect x="160" y="78" width="500" height="68" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="410" y="98" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">SessionPrompt.prompt(input)　// session/prompt.ts</text>
  <text x="180" y="120" font-size="10" fill="currentColor">① Session.updateMessage(user)　→ 写 MessageTable，发 message.updated</text>
  <text x="180" y="138" font-size="10" fill="currentColor">② Session.updatePart(textPart) 　→ 写 PartTable，发 message.part.updated</text>
  <path d="M410,146 L410,166" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r3ar2)"/>
  <rect x="80" y="168" width="660" height="232" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="410" y="188" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">processor.process({ user, agent, ... })　// session/processor.ts</text>
  <text x="410" y="206" text-anchor="middle" font-size="10.5" fill="#64748b">for await (event of llmStream) { ... }</text>
  <rect x="100" y="218" width="620" height="24" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="234" font-size="10" fill="currentColor">case &quot;text-start&quot;　 →　session.updatePart(emptyText)</text>
  <text x="500" y="234" font-size="10" fill="#94a3b8">发 PartUpdated（入库）</text>
  <rect x="100" y="246" width="620" height="24" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="262" font-size="10" fill="currentColor">case &quot;text-delta&quot; 　→　session.updatePartDelta(...)</text>
  <text x="500" y="262" font-size="10" fill="#dc2626">只发 PartDelta（不落库）</text>
  <rect x="100" y="274" width="620" height="24" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="290" font-size="10" fill="currentColor">case &quot;text-end&quot;　 　→　session.updatePart(finalText)</text>
  <text x="500" y="290" font-size="10" fill="#94a3b8">落库最终态</text>
  <rect x="100" y="302" width="620" height="24" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="318" font-size="10" fill="currentColor">case &quot;tool-call&quot;　 　→　updatePart(toolPart, state=running)</text>
  <rect x="100" y="330" width="620" height="24" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="346" font-size="10" fill="currentColor">case &quot;tool-result&quot;　→　updatePart(toolPart, state=completed)</text>
  <rect x="100" y="358" width="620" height="24" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="116" y="374" font-size="10" fill="currentColor">case &quot;finish&quot;　　 　→　updateMessage(assistant)</text>
  <text x="500" y="374" font-size="10" fill="#64748b">写 token / cost / finish</text>
  <path d="M410,400 L410,420" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r3ar2)"/>
  <rect x="80" y="422" width="660" height="48" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="410" y="442" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">SQLite 持久化 ＋ bus 推送 ＋ sync event 入日志</text>
  <text x="410" y="458" text-anchor="middle" font-size="10" fill="#64748b">PartUpdated 入库且发 bus；PartDelta 只走 bus 不入库</text>
  <path d="M410,470 L410,490" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r3ar2)"/>
  <rect x="160" y="492" width="500" height="50" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="512" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">TUI 通过 SSE 订阅事件流</text>
  <text x="410" y="528" text-anchor="middle" font-size="10" fill="#64748b">PartDelta 累加 → 即时刷新；PartUpdated → 收敛为权威快照</text>
</svg>
<span class="figure-caption">图 R3.2 ｜ 一次 user prompt 的写入路径：先写 user message / part，processor 在 LLM 流事件循环里反复 updatePart / updatePartDelta，最终通过 SQLite + bus + SyncEvent 三轨同时落地，TUI 在 SSE 订阅端按 delta 增量、按 PartUpdated 收敛。</span>

<details>
<summary>ASCII 原版</summary>

```text
TUI/CLI 收到用户回车
   │
   ▼
SessionPrompt.prompt(input)              ← session/prompt.ts
   │  1) Session.updateMessage(user)     ← 写 MessageTable，发 message.updated
   │  2) Session.updatePart(textPart)    ← 写 PartTable，发 message.part.updated
   │
   ▼
processor.process({ user, agent, ... })  ← session/processor.ts
   │  for await (event of llmStream) {
   │    case "text-start":
   │      session.updatePart(emptyText)  ← 新建 part，发 PartUpdated
   │    case "text-delta":
   │      currentText.text += value.text
   │      session.updatePartDelta(...)   ← 只发 PartDelta，不落库
   │    case "text-end":
   │      session.updatePart(finalText)  ← 落库最终态
   │    case "tool-call":
   │      session.updatePart(toolPart)   ← 工具 part 进 running 态
   │    case "tool-result":
   │      session.updatePart(toolPart)   ← 进 completed 态
   │    case "finish":
   │      session.updateMessage(assistant) ← 写最终 token/cost/finish
   │  }
   │
   ▼
SQLite 持久化 + bus 推送 + sync event 入日志
   │
   ▼
TUI 通过 SSE 订阅，看到事件流，增量更新视图
```

</details>

`Session.updateMessage`（`session.ts:618-622`）和 `Session.updatePart`（`session.ts:624-632`）的实现非常简洁——它们都只是 wrap 一个 `sync.run`：

```ts
const updateMessage = <T extends MessageV2.Info>(msg: T): Effect.Effect<T> =>
  Effect.gen(function* () {
    yield* sync.run(MessageV2.Event.Updated, { sessionID: msg.sessionID, info: msg })
    return msg
  }).pipe(Effect.withSpan("Session.updateMessage"))

const updatePart = <T extends MessageV2.Part>(part: T): Effect.Effect<T> =>
  Effect.gen(function* () {
    yield* sync.run(MessageV2.Event.PartUpdated, {
      sessionID: part.sessionID,
      part: structuredClone(part),
      time: Date.now(),
    })
    return part
  }).pipe(Effect.withSpan("Session.updatePart"))
```

注意 `structuredClone(part)`——因为后续 processor 还会继续 mutate `ctx.currentText`，事件里需要一个**当前快照**而非引用。否则订阅者 await 处理事件时，part.text 可能已经被 processor 改过了。

## Fork：复制一段历史到新会话

`Session.fork`（`session.ts:679-719`）允许用户从某条 message 处分叉出一个新 session——保留分叉点之前的所有消息和 part，但 ID 全部重写：

```ts
const fork = Effect.fn("Session.fork")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
  const ctx = yield* InstanceState.context
  const original = yield* get(input.sessionID)
  const title = getForkedTitle(original.title)
  const session = yield* createNext({
    directory: ctx.directory,
    path: sessionPath(ctx.worktree, ctx.directory),
    workspaceID: original.workspaceID,
    title,
  })
  const msgs = yield* messages({ sessionID: input.sessionID })
  const idMap = new Map<string, MessageID>()

  for (const msg of msgs) {
    if (input.messageID && msg.info.id >= input.messageID) break
    const newID = MessageID.ascending()
    idMap.set(msg.info.id, newID)

    const parentID = msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
    const cloned = yield* updateMessage({
      ...msg.info,
      sessionID: session.id,
      id: newID,
      ...(parentID && { parentID }),
    })

    for (const part of msg.parts) {
      const p: MessageV2.Part = {
        ...part,
        id: PartID.ascending(),
        messageID: cloned.id,
        sessionID: session.id,
      }
      if (p.type === "compaction" && p.tail_start_id) {
        p.tail_start_id = idMap.get(p.tail_start_id)
      }
      yield* updatePart(p)
    }
  }
  return session
})
```

几处细节：

- **新会话不继承 agent/model/cost**：`createNext` 只填了 directory/path/title/workspaceID。新 session 的 agent 字段为 undefined，accumulated cost 为 0。这是有意的——fork 表示"从这个状态开始重走一遍"，不应该带上原 session 的成本统计。
- **`idMap` 重写 parentID 引用**：assistant 消息的 `parentID` 指向触发自己的 user message。fork 时如果 user message 也被复制了，新 assistant 的 `parentID` 必须指向**新**的 user message ID。`idMap` 记录旧 → 新映射，复制 assistant 时查表替换。
- **`tail_start_id` 同样要重写**：CompactionPart 的 `tail_start_id` 引用某条被保留下来的尾部 message。fork 时也要走 idMap（`session.ts:712-714`）。
- **`getForkedTitle`**（`session.ts:147-155`）：基于原标题加 `(fork #N)`，N 自动累加：

  ```ts
  function getForkedTitle(title: string): string {
    const match = title.match(/^(.+) \(fork #(\d+)\)$/)
    if (match) {
      const base = match[1]
      const num = parseInt(match[2], 10)
      return `${base} (fork #${num + 1})`
    }
    return `${title} (fork #1)`
  }
  ```

  这样 "My session (fork #3)" fork 一次会变成 "My session (fork #4)"，不会无限嵌套 `(fork #1 (fork #1))`。

fork 的典型用法：用户对最后几条 turn 不满意，但又不想完全丢掉前面的工作——分叉出来，新 session 继续探索另一条路径，老 session 保留作"对照组"。

## Pagination：基于 (time_created, id) 的 cursor

`MessageV2.page`（`message-v2.ts:923-962`）是消息分页的核心：

```ts
export const page = Effect.fn("MessageV2.page")(function* (input: {
  sessionID: SessionID
  limit: number
  before?: string
}) {
  const before = input.before ? cursor.decode(input.before) : undefined
  const where = before
    ? and(eq(MessageTable.session_id, input.sessionID), older(before))
    : eq(MessageTable.session_id, input.sessionID)
  const rows = Database.use((db) =>
    db
      .select()
      .from(MessageTable)
      .where(where)
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(input.limit + 1)
      .all(),
  )
  // ... 处理空结果 / NotFound ...
  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  const items = hydrate(slice)
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
  }
})
```

`older` 是一个复合比较（`message-v2.ts:595-596`）：

```ts
const older = (row: Cursor) =>
  or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))
```

即"严格早于 cursor"——同毫秒内按 id 二级排序。

**为什么用 `(time_created, id)` 而不是单纯 `id`？**

- ID 是 ascending 单调，理论上和 time 严格同序——但 ID 生成方依赖客户端时钟。`MessageID.ascending()` 用 `Identifier.ascending("message", id)` 生成 ULID-like 字符串，前缀是时间戳。
- 如果只用 id 排序，跨进程 / 跨机时钟漂移会导致顺序"颠倒"。`time_created` 是 SQLite 自己写的（`Timestamps.$default(() => Date.now())`），是服务端时钟，更可靠。
- 把两者复合后，主排序按 time，破并列时按 id——这是经典的 "lexicographic cursor pagination"。

`cursor.encode/decode`（`message-v2.ts:571-578`）就是 `JSON.stringify` + base64url。它返回的是不透明的 token——客户端只 round-trip，不能解析。

`limit + 1` 的 trick：多取 1 行用来判断"还有更多"。如果返回了 `limit+1` 条，`more=true`，丢掉第 `limit+1` 条但用 slice 的最后一条做 cursor。否则 `more=false`，没有 cursor。

`Session.messages`（`session.ts:767-786`）在不指定 limit 时会自动循环 page，把整个会话的 message 都吐出来（按时间从早到晚返回）：

```ts
const messages: Interface["messages"] = Effect.fn("Session.messages")(function* (input) {
  if (input.limit) {
    return (yield* MessageV2.page({ sessionID: input.sessionID, limit: input.limit })).items
  }

  const size = 50
  const result = [] as MessageV2.WithParts[]
  let before: string | undefined
  while (true) {
    const page = yield* MessageV2.page({ sessionID: input.sessionID, limit: size, before })
    if (page.items.length === 0) break
    for (let i = page.items.length - 1; i >= 0; i--) {
      const item = page.items[i]
      if (item) result.push(item)
    }
    if (!page.more || !page.cursor) break
    before = page.cursor
  }
  return result.reverse()
})
```

注意循环里 `for (let i = page.items.length - 1; i >= 0; i--)`——`page` 内部 reversed 一次，外层再 reverse 一次，最后 `result.reverse()` 才得到正向时间序。这看上去绕，是因为分页是从最新往老翻、但整体结果想要按时间正序返回。

## Hydrate：JOIN message 与 part 的批量加载

`hydrate`（`message-v2.ts:598-622`）：

```ts
function hydrate(rows: (typeof MessageTable.$inferSelect)[]) {
  const ids = rows.map((row) => row.id)
  const partByMessage = new Map<string, Part[]>()
  if (ids.length > 0) {
    const partRows = Database.use((db) =>
      db
        .select()
        .from(PartTable)
        .where(inArray(PartTable.message_id, ids))
        .orderBy(PartTable.message_id, PartTable.id)
        .all(),
    )
    for (const row of partRows) {
      const next = part(row)
      const list = partByMessage.get(row.message_id)
      if (list) list.push(next)
      else partByMessage.set(row.message_id, [next])
    }
  }

  return rows.map((row) => ({
    info: info(row),
    parts: partByMessage.get(row.id) ?? [],
  }))
}
```

它做的事情就是把"N 条 message + 它们所有的 part"用 **2 次 SELECT** 拿到：

1. `SELECT * FROM message WHERE session_id = ? AND ...`（在 page 函数里完成）。
2. `SELECT * FROM part WHERE message_id IN (...)`（这里）。

而不是 N+1 次（每条 message 单独查它的 part）。`orderBy(PartTable.message_id, PartTable.id)` 保证同一 message 的 part 在结果里连续且按生成顺序排，所以可以直接 `Map.get / push`。

这种 batch loading 是 ORM 入门题，但对会话长度敏感的应用至关重要——一个有几百条 message 的 session，分页 50 条只走 2 次 SQL，不是 50 次。

## 删除与级联

`Session.remove`（`session.ts:595-616`）：

```ts
const remove: Interface["remove"] = Effect.fnUntraced(function* (sessionID: SessionID) {
  const session = yield* get(sessionID)
  try {
    const hasInstance = yield* InstanceState.directory.pipe(
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false)),
    )

    if (hasInstance) yield* cancelBackgroundJobs(background, sessionID)
    const kids = yield* children(sessionID)
    for (const child of kids) {
      yield* remove(child.id)
    }

    yield* sync.run(Event.Deleted, { sessionID, info: session }, { publish: hasInstance })
    yield* sync.remove(sessionID)
  } catch (e) {
    log.error(e)
  }
})
```

删除流程：

1. 先取出 session info（如果不存在直接 fail，但被外层 try 吞掉）。
2. 检查是否有 InstanceState——`Session.remove` 设计上要能在"没有运行时上下文"时也工作（比如清理脚本批量删除老会话）。
3. 有 instance 才取消该 session 关联的后台任务（如 background subagent）。
4. **递归删除所有 child session**——因为 `parent_id` 是软关系（不是 FK，所以 SQLite 不会自动级联），手动递归确保 subagent 派生的子会话不留下。
5. `sync.run(Event.Deleted, ...)`——这是真正的删除动作，写 sync event 并 publish。
6. `sync.remove(sessionID)`——sync 服务自己的清理。

SQLite 层面的级联在 `session.sql.ts` 已经声明（`references(() => ProjectTable.id, { onDelete: "cascade" })` 等）：

```text
Project DELETE → Session CASCADE → Message CASCADE → Part CASCADE
                                                  → Todo CASCADE
                              → SessionShare CASCADE
                              → SessionMessage CASCADE（事件日志）
```

但 `parent_id` 自引用**没有**声明 cascade（看 `session.sql.ts:25`），所以 child session 必须由应用代码主动删。这是有道理的——级联删 child 通常不是你想要的（父被归档不代表 child 也归档）；`Session.remove` 显式选择递归。

### `BusyError` 防并发删

`session.ts:445-447`：

```ts
export class BusyError extends Schema.TaggedErrorClass<BusyError>()("SessionBusyError", {
  sessionID: SessionID,
}) {}
```

这个错误在 session 正处于 LLM 推理时被抛出（具体抛出点在 `SessionRunState` 服务里）。删除 / 归档 / fork 一个正在运行的 session 都会失败——必须先 `cancel` 它。

## 翻译到 LLM 的输入

LLM 需要的是 `ModelMessage[]`（Vercel AI SDK 的标准格式），而不是 opencode 自己的 `WithParts[]`。`toModelMessagesEffect`（`message-v2.ts:630-913`）做这个转换。它要解决几件事：

1. **去掉 opencode 自己的元 Part**：step-start / step-finish / snapshot / patch / compaction / agent / retry 都不发给模型。
2. **媒体类型适配**：不是所有 provider 都支持 PDF / 图像在 tool result 里。`supportsMediaInToolResult(model.api.npm)` 决定是直接塞 attachment 还是分裂成额外的 user message（`message-v2.ts:646-657`、`878-897`）。
3. **dangling tool_use 修复**（`message-v2.ts:849-858`）：Anthropic 强约束"每个 tool_use 都要有 tool_result"。如果 assistant 在调工具过程中被打断（pending / running），转换器**伪造**一个 `output-error` tool result，否则下一次调用 API 会被服务器拒绝。
4. **reasoning 跨模型剥离**（`message-v2.ts:860-873`）：如果当前模型 ≠ 生成该 reasoning 时的模型，reasoning 退化为普通 text（不能跨模型 replay 思维链 signature）。
5. **空 text part 的特殊处理**（`message-v2.ts:760-781`）：Anthropic adaptive thinking 在 turn 中会出现空 `text` 段作为 reasoning 块的分隔符。转换器用 " "（单空格）替换空字符串，否则会被 AI SDK 过滤掉、签名错位。

这些 corner case 都是真实生产环境踩出来的（注释里频繁出现 "Anthropic" / "Bedrock" / "Vertex" 的具体行为差异）。这也解释了为什么这个 file 会有 1200+ 行——大部分是 provider 适配。

转换的入口点用得很简单（`session/prompt.ts:1423`）：

```ts
const [skills, env, instructions, modelMsgs] = yield* Effect.all([
  sys.skills(agent),
  sys.environment(model),
  instruction.system().pipe(Effect.orDie),
  MessageV2.toModelMessagesEffect(msgs, model),
])
```

`modelMsgs` 出来就是可以直接喂给 `streamText` 的 `ModelMessage[]`。

## 设计回顾

回看这整套 Session / Message / Part 模型，几个核心权衡：

| 设计选择 | 替代方案 | 为什么这个 |
|----------|----------|------------|
| Part 是独立表 | 嵌在 Message JSON 里 | 流式增量写、按类型查询、压缩历史 |
| ID 内嵌时间戳（descending/ascending） | UUID v4 | 列表查询无需 ORDER BY time、partID 排序就是发生顺序 |
| 写操作走 SyncEvent | 直接写 SQL | 客户端可断线重连追赶、原生支持远端镜像 |
| Delta 不入库，只走 bus | 每个 delta 也持久化 | 流式期间 SQLite 不被 IOPS 淹没 |
| ProjectID 是 git root commit | 路径或 UUID | 跨机器、跨 checkout、跨 worktree 仍然唯一 |
| Storage façade 与 SQLite 分离 | 全走 SQLite | 文件型数据（diff / blob）不污染数据库 schema |
| 错误是 message 的字段 | 抛异常丢消息 | 失败 turn 仍可见、可重试 / 调试 |
| 12 种 Part 类型 | 通用 content blocks | 类型携带语义、便于 UI 渲染、便于压缩取舍 |

这套模型的代价是 schema 复杂、所有变更都要同步改 6 处（schema.ts / session.sql.ts / message-v2.ts / projectors / TUI 渲染 / SSE 协议）。但因为流式 + 工具调用 + 多模态 + 错误恢复 这四个需求是 opencode 的本质功能，所以这个复杂度是不可压缩的。把它表达清楚比把它压扁成 `{role, content}` 更重要。
