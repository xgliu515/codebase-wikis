# 13. 进阶特性：分叉 / 压缩 / 成本 / 快照

opencode 不只是一个把 prompt 发给 LLM 的壳。围绕"长对话 + 真实文件修改"这两个核心需求，它在 session 之上叠加了一整套机制：会话分叉、消息压缩、上下文 overflow 降级、文件快照 / undo、成本统计、prompt cache 切点、后台任务、分享、多端同步、worktree、IDE / ACP 集成、JSON 导入导出。本章把这些"加料"一次性串起来，并指出它们的代码入口。

阅读建议：把这一章当作"机制速查表"。每节给一个 ASCII 图或代码片段，配上 file:line，知道在哪里看比记住每行更重要。

## 13.1 Session 分叉（fork）

opencode 的 session 是事件溯源的（参考第 6 章），所以"分叉"在概念上很简单：复制祖先消息到一个新的 session id 即可。

入口：`packages/opencode/src/session/session.ts:679` 的 `Session.fork`。

```ts
// session.ts:679
const fork = Effect.fn("Session.fork")(function* (input: {
  sessionID: SessionID
  messageID?: MessageID
}) {
  const ctx = yield* InstanceState.context
  const original = yield* get(input.sessionID)
  const title = getForkedTitle(original.title)              // "X (fork #1)"
  const session = yield* createNext({                       // 全新 sessionID
    directory: ctx.directory,
    path: sessionPath(ctx.worktree, ctx.directory),
    workspaceID: original.workspaceID,
    title,
  })
  const msgs = yield* messages({ sessionID: input.sessionID })
  const idMap = new Map<string, MessageID>()
  for (const msg of msgs) {
    if (input.messageID && msg.info.id >= input.messageID) break  // 截断点
    const newID = MessageID.ascending()
    idMap.set(msg.info.id, newID)
    // 重写 parentID（assistant → 它所回复的 user）
    const parentID = msg.info.role === "assistant" && msg.info.parentID
      ? idMap.get(msg.info.parentID) : undefined
    const cloned = yield* updateMessage({ ...msg.info, sessionID: session.id, id: newID, ...(parentID && { parentID }) })
    for (const part of msg.parts) {
      const p = { ...part, id: PartID.ascending(), messageID: cloned.id, sessionID: session.id }
      if (p.type === "compaction" && p.tail_start_id) {     // compaction part 的 id 也要重映射
        p.tail_start_id = idMap.get(p.tail_start_id)
      }
      yield* updatePart(p)
    }
  }
  return session
})
```

要点：

1. **fork 之后两个 session 完全独立**。fork 不写 `parentID` 字段；那个字段是给 subagent 用的（见 13.13）。所以 fork 出来的 session 是平级的，不是父子。
2. 复制的是消息内容，**所有 MessageID / PartID 都重新分配**。`idMap` 把旧 id 映射到新 id，需要时（比如 compaction part 的 `tail_start_id`）跟着改。
3. 截断点用 `input.messageID` 控制——`if (msg.info.id >= input.messageID) break`。MessageID 是 ULID-like 单调递增，所以"消息 id ≥ X"等价于"在 X 之后"。
4. title 用 `getForkedTitle` 自动加 `(fork #N)`，N 自动递增（`session.ts:147`）。

存储层面，session 表结构里 `parent_id` 列是给 subagent session 用的（`session.ts:215`），fork 不会填它，所以两个分叉在 SQL 层完全平级。要看父子关系用 `Session.children(parentID)`（`session.ts:584`）。

ASCII 图：fork 在一个长会话的某点切分，clone 出来的分支可以独立继续写。

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Session fork copies ancestor messages to a new session id at a chosen cut point">
  <defs>
    <marker id="ar131" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="160" y="24" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">原 session (s1)</text>
  <text x="560" y="24" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">fork 出来 (s2)</text>
  <rect x="80" y="40" width="160" height="240" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <rect x="96" y="56" width="128" height="26" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="160" y="73" text-anchor="middle" font-size="11" fill="currentColor">msg M1</text>
  <rect x="96" y="86" width="128" height="26" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="160" y="103" text-anchor="middle" font-size="11" fill="currentColor">msg M2</text>
  <rect x="96" y="116" width="128" height="26" rx="4" fill="#fff" stroke="#ea580c" stroke-width="1.5" stroke-dasharray="3,2"/>
  <text x="160" y="133" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">msg M3</text>
  <text x="252" y="133" font-size="10" fill="#64748b">← fork 点 (messageID)</text>
  <rect x="96" y="146" width="128" height="26" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="160" y="163" text-anchor="middle" font-size="11" fill="currentColor">msg M4</text>
  <rect x="96" y="176" width="128" height="26" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="160" y="193" text-anchor="middle" font-size="11" fill="currentColor">msg M5</text>
  <rect x="96" y="216" width="128" height="50" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-dasharray="3,2"/>
  <text x="160" y="234" text-anchor="middle" font-size="10" fill="#64748b">s1 继续独立写</text>
  <text x="160" y="250" text-anchor="middle" font-size="10" fill="#64748b">M6 / M7 / ...</text>
  <path d="M242,128 C320,128 360,128 440,76" stroke="#0d9488" stroke-width="1.3" fill="none" marker-end="url(#ar131)"/>
  <text x="345" y="98" text-anchor="middle" font-size="10" fill="#0d9488">clone（重新分配 ID）</text>
  <rect x="480" y="40" width="160" height="160" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <rect x="496" y="56" width="128" height="26" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="560" y="73" text-anchor="middle" font-size="11" fill="currentColor">msg M1′</text>
  <rect x="496" y="86" width="128" height="26" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="560" y="103" text-anchor="middle" font-size="11" fill="currentColor">msg M2′</text>
  <rect x="496" y="116" width="128" height="26" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="560" y="133" text-anchor="middle" font-size="11" fill="currentColor">msg M3′</text>
  <rect x="496" y="146" width="128" height="40" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-dasharray="3,2"/>
  <text x="560" y="170" text-anchor="middle" font-size="10" fill="#64748b">（后续独立写入）</text>
  <rect x="480" y="216" width="160" height="120" rx="6" fill="#fff" stroke="#94a3b8"/>
  <text x="560" y="234" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">关键映射</text>
  <text x="496" y="252" font-size="10" fill="#64748b">idMap: 旧ID → 新ID</text>
  <text x="496" y="268" font-size="10" fill="#64748b">parent_id 不填（fork 平级）</text>
  <text x="496" y="284" font-size="10" fill="#64748b">title += " (fork #N)"</text>
  <text x="496" y="300" font-size="10" fill="#64748b">compaction.tail_start_id</text>
  <text x="510" y="316" font-size="10" fill="#64748b">  跟着重映射</text>
</svg>
<span class="figure-caption">图 R13.1 ｜ Session.fork 在 messageID 截断点处把祖先消息克隆到新 sessionID，两个 session 在 SQL 层完全平级。</span>

<details>
<summary>ASCII 原版</summary>

```
原 session (s1)            fork 出来 (s2)
+---------+               +---------+
| msg M1  |  ---clone--→  | msg M1' |
| msg M2  |               | msg M2' |
| msg M3  | <-- fork 点    +---------+
| msg M4  |                 (后续独立写入)
| msg M5  |                  s2 写 M3'/M4'/...
+---------+                  s1 继续写 M6/M7/...
```

</details>

UI 层入口：TUI 里的 `/fork` 命令（详见第 8 章）；CLI 通过 SDK 直接调用 Session.fork。

### Fork 何时有用

实际工作场景：

- "刚才那个方案不对，但我想保留它做对比"——在分歧点 fork，原 session 留着，新 session 走另一路。
- "我要给同事演示这个 bug"——fork 一份用 `--sanitize` 导出。
- "Subagent 把仓库改乱了"——这是另一回事，应该用 revert（13.2），不要用 fork。

Fork 不会复制 `session.revert`、`session.cost`、`session.tokens` 等聚合字段。新 session 的统计从 0 开始累加（虽然消息里的 token 数还在），等下次 LLM 调用时会被 projector 重新算上。这点常被忽略——`opencode stats` 看到 fork 出来的 session "成本是 0" 不要奇怪。

## 13.2 Revert / Undo

`packages/opencode/src/session/revert.ts` 实现"回退到某条消息（或 part）之前"。它和文件快照协作，确保不仅消息能消失，磁盘上被工具改过的文件也能回到原样。

```ts
// revert.ts:41
const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
  yield* state.assertNotBusy(input.sessionID)              // 正在跑就不能 revert
  const all = yield* sessions.messages({ sessionID: input.sessionID })
  // ... 遍历找到 revert 点之后的所有消息和 patch part
  rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())  // 标记当前快照
  if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)  // 先恢复上次 revert 的快照
  yield* snap.revert(patches)                              // 按 patch 回滚文件
  if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)        // 计算 diff
  // ...
  yield* sessions.setRevert({ sessionID, revert: rev, summary: { ... } })
})
```

revert 不是"删消息"，而是给 session 打一个 `revert` 字段（`session.ts:226` 的 `Info.revert`）。被 revert 掉的消息**仍然存在于 DB**，只是渲染层会跳过它们（projector 处理）。这样设计有两个好处：

- **可 unrevert**：`SessionRevert.unrevert` (`revert.ts:93`) 把 `revert` 字段清空就回到原状态。
- **不丢历史**：用户改主意时不会丢上下文。

cleanup 阶段（`revert.ts:103`）才会真正调用 `MessageV2.Event.Removed` / `PartRemoved` 来从 DB 删消息——通常发生在用户在 revert 状态下输入了新消息时（"我要走另一条路了"），这时旧路彻底被砍掉。

回退点的精度：

- 只指定 `messageID`：回退到这条 user message 之前。
- 同时指定 `partID`：在同一条 user message 内部回退到某个 part 之前。

### 与 snapshot 的协作时序

```
当前状态: revert.snapshot = S_old (上次 revert 起点)，文件已 restore 到 S_old
用户再次 revert 到更早的位置:
  1. snap.track()                  → 拍当前 S_now (S_old + 之后变化)
  2. snap.restore(S_old)            → 先把文件回到上次 revert 起点
  3. snap.revert(patches[])         → 按补丁逐个文件回滚到更早状态
  4. rev.snapshot = S_old (不是 S_now！只记录最早保留点)
  5. rev.diff = snap.diff(rev.snapshot)
  6. session.setRevert({ revert: rev, summary })
```

注意第 4 步：`rev.snapshot` 仍保留上次 revert 起点而非当前 snapshot——这样多次嵌套 revert 时总能回到"最原始"的工作目录状态，避免每次 revert 都吃掉一层快照导致再也回不去。代码：`revert.ts:73-76`。

## 13.3 Snapshot 系统

`packages/opencode/src/snapshot/index.ts`（762 行）是"文件版本控制"的实现。它**用 git 做存储**，但与项目自身的 git 仓库**完全隔离**。

存储位置：`~/.local/share/opencode/snapshot/<projectID>/<worktree-hash>/`（`snapshot/index.ts:81`）。

```ts
// snapshot/index.ts:81
const state = {
  directory: ctx.directory,
  worktree: ctx.worktree,
  gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree)),
  vcs: ctx.project.vcs,
}
const args = (cmd) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]
```

每个项目 + worktree 一个独立的 `.git` 目录，但 `--work-tree` 指向用户的实际工作目录。所以 opencode 用 git 的索引能力跟踪文件，但**不会动用户自己的 .git**。

核心 API（`Snapshot.Interface`，`snapshot/index.ts:45`）：

| 方法 | 作用 | 何时调用 |
| --- | --- | --- |
| `track()` | 把当前 workspace 文件全部 stage，写 tree 拿 hash | 每次工具调用前/后（step-start/step-finish） |
| `patch(hash)` | 给定一个 tree hash，返回从那时起改过的文件列表 | 工具完成时记录在 `patch` part |
| `restore(snapshot)` | 用 `read-tree` + `checkout-index` 恢复整个 workspace | revert / unrevert |
| `revert(patches)` | 按文件粒度 checkout，文件原本不存在则删除 | revert 时回滚单文件 |
| `diff(hash)` | 与某 hash 的 diff 文本 | TUI 展示当前未提交改动 |
| `diffFull(from, to)` | 两 hash 间的逐文件 diff (`FileDiff[]`) | session summary 计算 |

被 ignore 的文件不参与 snapshot（`snapshot/index.ts:110` 的 `ignore`），大于 2MB 的新文件也被剔除（`limit = 2 * 1024 * 1024`，`snapshot/index.ts:33`）。这避免把数据集、构建产物全部塞进 snapshot。

清理：每小时跑一次 `git gc --prune=7.days`（`snapshot/index.ts:713`），保留近 7 天的 snapshot。

ASCII 图：snapshot 与会话的关系

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Snapshot timeline pairs step-start hash with step-finish hash for revert">
  <defs>
    <marker id="ar132" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <line x1="60" y1="60" x2="700" y2="60" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="44" text-anchor="middle" font-size="11" fill="#64748b">时间线（一次 user message 的生命周期）</text>
  <rect x="80" y="76" width="150" height="46" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="155" y="94" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">用户输入</text>
  <text x="155" y="112" text-anchor="middle" font-size="10" fill="#64748b">step-start (H0)</text>
  <rect x="305" y="76" width="150" height="46" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="94" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">LLM 调 edit 工具</text>
  <text x="380" y="112" text-anchor="middle" font-size="10" fill="#64748b">tool.state.running</text>
  <rect x="530" y="76" width="150" height="46" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="605" y="94" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">工具完成</text>
  <text x="605" y="112" text-anchor="middle" font-size="10" fill="#64748b">step-finish (H1)</text>
  <path d="M230,99 L300,99" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar132)"/>
  <path d="M455,99 L525,99" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar132)"/>
  <path d="M155,128 L155,160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar132)"/>
  <path d="M605,128 L605,160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar132)"/>
  <rect x="80" y="166" width="150" height="44" rx="6" fill="#fff" stroke="#cbd5e1"/>
  <text x="155" y="184" text-anchor="middle" font-size="11" fill="currentColor">snapshot = H0</text>
  <text x="155" y="200" text-anchor="middle" font-size="10" fill="#64748b">所有文件 tree-hash</text>
  <rect x="530" y="166" width="150" height="44" rx="6" fill="#fff" stroke="#cbd5e1"/>
  <text x="605" y="184" text-anchor="middle" font-size="11" fill="currentColor">snapshot = H1</text>
  <text x="605" y="200" text-anchor="middle" font-size="10" fill="#64748b">所有文件 tree-hash</text>
  <path d="M605,212 L605,236" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar132)"/>
  <rect x="510" y="240" width="190" height="60" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="605" y="258" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">patch part</text>
  <text x="525" y="274" font-size="10" fill="#64748b">hash = H0</text>
  <text x="525" y="288" font-size="10" fill="#64748b">files = [a.ts, b.ts]</text>
  <path d="M155,212 C155,260 280,290 500,272" stroke="#0d9488" stroke-width="1.3" stroke-dasharray="4,3" fill="none" marker-end="url(#ar132)"/>
  <text x="320" y="300" text-anchor="middle" font-size="10" fill="#0d9488">revert 时：Snapshot.revert(patches) 还原 a.ts、b.ts 到 H0</text>
</svg>
<span class="figure-caption">图 R13.2 ｜ 每次工具调用前后各拍一次 snapshot，patch part 持有起点 hash 与改动文件，revert 时按 patch 单文件回滚。</span>

<details>
<summary>ASCII 原版</summary>

```
  用户输入                LLM 调用 edit 工具         工具完成
     │                          │                       │
     ▼                          ▼                       ▼
 [step-start]          [tool.state.running]      [step-finish]
   snapshot=H0                                    snapshot=H1
       │                                              │
       │                                              ▼
       │                                  patch.hash=H0
       │                                  patch.files=[a.ts, b.ts]
       │
       └────────── revert 时 →  Snapshot.revert(patches)
                                 把 a.ts、b.ts 还原到 H0
```

</details>

step-start / step-finish 是 part 类型（`MessageV2.StepStartPart`、`MessageV2.StepFinishPart`），里面带 `snapshot` 字段。`SessionSummary.computeDiff` 就是用这两个 hash 算"这条 user message 期间一共改了什么"。

## 13.4 消息压缩（compaction）

`packages/opencode/src/session/compaction.ts`（639 行）。长会话装不下模型 context 时，压缩把早期消息总结成 Markdown 模板，腾出空间。

### 触发时机

- **手动**：用户在 TUI 执行 `/compact`。
- **自动 overflow**：每次 LLM 调用前检查 `isOverflow`，超出阈值就插入一条 `compaction` user message 触发压缩流程。

```ts
// session/overflow.ts:20
export function isOverflow(input: {
  cfg: Config.Info; tokens; model; outputTokenMax?
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false
  const count = input.tokens.total
    || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}

// usable() 留出 reserved 给输出：
// usable = model.limit.input - reserved
//   reserved 默认 min(20_000, maxOutputTokens(model))
```

可以通过 `OPENCODE_DISABLE_AUTOCOMPACT=1` 或 config 里 `compaction.auto: false` 关掉自动压缩。

### 压缩流程

1. `SessionCompaction.create`（`compaction.ts:584`）写一条 user message 带 `compaction` part 占位，触发处理。
2. `processCompaction`（`compaction.ts:344`）选出"待压缩区间"——`select`（`compaction.ts:245`）决定 head（要压缩的）和 tail（保留的最近若干 turn）。
3. tail 预算来自 `preserveRecentBudget`（`compaction.ts:136`）：默认占可用上下文 25%，clamp 在 2k–8k token。
4. 用一个 hard-coded 的 Markdown 模板（`compaction.ts:42` 的 `SUMMARY_TEMPLATE`）做 prompt，模型必须按 `## Goal / Constraints / Progress / Decisions / Next Steps / Critical Context / Relevant Files` 的固定结构输出。
5. 压缩 agent 用专门的 `agent: "compaction"` 配置（`compaction.ts:383`），模型可在 config 中自定义。
6. 压缩完成后，发布 `Event.Compacted` 事件（`compaction.ts:579`）让 UI 刷新；如果是 auto 触发，还会自动接一条 "Continue if you have next steps..." 让主对话续上。

### tail 切分细节

`splitTurn`（`compaction.ts:161`）允许把一个 turn 的尾部拆分进 tail，避免单个超大 turn 把 tail 撑爆。

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Compaction splits history into head and tail with budget constraints">
  <defs>
    <marker id="ar133" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="60" y="34" font-size="12" font-weight="600" fill="currentColor">原会话：</text>
  <g font-size="11" fill="currentColor">
    <rect x="140" y="20" width="60" height="28" rx="4" fill="#fff" stroke="#cbd5e1"/><text x="170" y="38" text-anchor="middle">T1</text>
    <rect x="205" y="20" width="60" height="28" rx="4" fill="#fff" stroke="#cbd5e1"/><text x="235" y="38" text-anchor="middle">T2</text>
    <rect x="270" y="20" width="60" height="28" rx="4" fill="#fff" stroke="#cbd5e1"/><text x="300" y="38" text-anchor="middle">T3</text>
    <rect x="335" y="20" width="60" height="28" rx="4" fill="#fff" stroke="#cbd5e1"/><text x="365" y="38" text-anchor="middle">T4</text>
    <rect x="400" y="20" width="60" height="28" rx="4" fill="#fff" stroke="#cbd5e1"/><text x="430" y="38" text-anchor="middle">T5</text>
    <rect x="465" y="20" width="60" height="28" rx="4" fill="#fff" stroke="#cbd5e1"/><text x="495" y="38" text-anchor="middle">T6</text>
    <rect x="530" y="20" width="60" height="28" rx="4" fill="#fed7aa" stroke="#ea580c"/><text x="560" y="38" text-anchor="middle">T7</text>
    <rect x="595" y="20" width="60" height="28" rx="4" fill="#fed7aa" stroke="#ea580c"/><text x="625" y="38" text-anchor="middle">T8</text>
  </g>
  <path d="M560,52 L560,68" stroke="#ea580c" stroke-width="1.2"/>
  <text x="592" y="80" font-size="10" fill="#ea580c">tail_turns = 2</text>
  <text x="60" y="110" font-size="11" font-weight="600" fill="currentColor">情形 ①  预算够：</text>
  <rect x="140" y="120" width="385" height="34" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="332" y="141" text-anchor="middle" font-size="11" fill="currentColor">head = [T1..T6]   →  压缩成 Markdown summary</text>
  <rect x="530" y="120" width="125" height="34" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="592" y="141" text-anchor="middle" font-size="11" fill="currentColor">tail = [T7, T8]</text>
  <text x="60" y="180" font-size="11" font-weight="600" fill="currentColor">情形 ②  T7+T8 超预算 (splitTurn)：</text>
  <rect x="140" y="190" width="385" height="34" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="332" y="211" text-anchor="middle" font-size="11" fill="currentColor">head = [T1..T6 + T7 前半]</text>
  <rect x="530" y="190" width="125" height="34" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2"/>
  <text x="592" y="211" text-anchor="middle" font-size="11" fill="currentColor">tail = [T7 后半, T8]</text>
  <text x="60" y="250" font-size="11" font-weight="600" fill="currentColor">情形 ③  仍装不下：</text>
  <rect x="140" y="260" width="515" height="34" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="397" y="281" text-anchor="middle" font-size="11" fill="currentColor">tail_fallback (log warn) / overflow 模式：单独 replay 最近一条 user message</text>
  <text x="60" y="324" font-size="10" fill="#64748b">预算来源：preserveRecentBudget = clamp(usable × 25%, 2k, 8k) token</text>
  <text x="60" y="340" font-size="10" fill="#64748b">触发：手动 /compact，或自动 isOverflow（count ≥ usable）</text>
</svg>
<span class="figure-caption">图 R13.3 ｜ compaction 把会话切成 head（要总结）+ tail（保留最近若干 turn），三种情形：预算够、拆 turn、彻底装不下走 overflow 兜底。</span>

<details>
<summary>ASCII 原版</summary>

```
原会话:  T1 T2 T3 T4 T5 T6 T7 T8
                              ↑tail_turns=2
预算够 → head=[T1..T6], tail=[T7,T8]
T7+T8 超预算? → 尝试拆分 T7 (只保留后半段) 或更激进
完全装不下? → tail_fallback (log warn)
```

</details>

### prune：粗粒度修剪

`SessionCompaction.prune`（`compaction.ts:298`）是另一条不那么激烈的路径——只清空老旧 **tool 调用输出**，不动消息本身。

```ts
// compaction.ts:298
for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
  const msg = msgs[msgIndex]
  if (msg.info.role === "user") turns++
  if (turns < 2) continue                           // 最近 2 轮完全保留
  if (msg.info.role === "assistant" && msg.info.summary) break  // 撞到上次压缩点停
  for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
    const part = msg.parts[partIndex]
    if (part.type !== "tool" || part.state.status !== "completed") continue
    if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue       // skill 不剪
    const estimate = Token.estimate(part.state.output)
    total += estimate
    if (total <= PRUNE_PROTECT) continue          // 近 40k token 保护期
    pruned += estimate
    toPrune.push(part)                            // 标记修剪
  }
}
if (pruned > PRUNE_MINIMUM) {                     // 收益 > 20k 才真执行
  for (const part of toPrune) part.state.time.compacted = Date.now()
}
```

被 prune 的 tool 输出在 `state.time.compacted` 上打时间戳，渲染时显示成 "[output compacted]"，并且发给 LLM 时会被替换为空。

## 13.5 Overflow 降级策略

`packages/opencode/src/session/overflow.ts` 只有 32 行，但定义了关键阈值：

```ts
// overflow.ts:6
const COMPACTION_BUFFER = 20_000

export function usable(input) {
  const context = input.model.limit.context
  if (context === 0) return 0
  const reserved = input.cfg.compaction?.reserved
    ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}
```

要点：

- 优先用 `model.limit.input`（如果 provider 给了独立的输入上限）。
- 否则 `context - maxOutputTokens` 作为可用窗口。
- 再扣 20k token（或模型 maxOutputTokens 的较小值）作为压缩缓冲，避免压缩本身又装不下。

进一步降级：当压缩本身都装不下时，`processCompaction` 会切到"overflow 模式"（`compaction.ts:365`）——找到最近一条非 compaction 的 user message，把它**单独拎出来作为"replay"**，剩余消息按当前可用窗口压。如果连这都不行，标记 `ContextOverflowError`（`compaction.ts:460`）让用户感知。

## 13.6 Summary 生成

`packages/opencode/src/session/summary.ts`（164 行）负责两件事：

1. **diff 摘要**：每条 user message 期间改了哪些文件、加减多少行。
2. **session-level diff**：整个 session 改了什么。

```ts
// summary.ts:81
const computeDiff = Effect.fn(...)(function* (input: { messages }) {
  let from, to
  for (const item of input.messages) {
    if (!from) for (const part of item.parts) {
      if (part.type === "step-start" && part.snapshot) { from = part.snapshot; break }
    }
    for (const part of item.parts) {
      if (part.type === "step-finish" && part.snapshot) to = part.snapshot
    }
  }
  if (from && to) return yield* snapshot.diffFull(from, to)
  return []
})
```

从消息流里第一个 step-start 找到 `from` 快照，最后一个 step-finish 找到 `to` 快照，调 `Snapshot.diffFull` 得到逐文件 diff。

存储：摘要写在 `storage["session_diff", sessionID]`（`summary.ts:117`）；也广播 `Session.Event.Diff` 给订阅者。

## 13.7 成本统计

session 级累计：每条 assistant message 自带 `tokens` 和 `cost` 字段（schema 在 `session.ts:168`、`session.ts:178`）。

```
Tokens = {
  input,
  output,
  reasoning,
  cache: { read, write }
}
```

`cost` 是 USD，按 provider 模型单价折算（在 `packages/llm` 里聚合，每次 LLM 调用结束后更新）。

session 表（`session.sql.ts`）里 `tokens_input`、`tokens_output`、`tokens_reasoning`、`tokens_cache_read`、`tokens_cache_write`、`cost` 分别存储。这些都是从消息聚合上来的（projector 在 `MessageV2.Event.PartUpdated` 时累加）。

### `opencode stats` 命令

`packages/opencode/src/cli/cmd/stats.ts:49` 定义 `StatsCommand`，扫所有 session（默认全时间，可 `--days N` 过滤），聚合：

- 总 session / message 数
- 总 token / 总 cost / 日均 cost
- 按工具名分组的调用次数（带 ASCII bar）
- `--models` 选项按 `providerID/modelID` 分组展示用量与成本
- 每 session token 数的均值、中位数

```ts
// stats.ts:182
for (const message of messages) {
  if (message.info.role === "assistant") {
    const modelKey = `${message.info.providerID}/${message.info.modelID}`
    sessionModelUsage[modelKey].cost += message.info.cost || 0
    sessionModelUsage[modelKey].tokens.input  += message.info.tokens.input  || 0
    sessionModelUsage[modelKey].tokens.output += (message.info.tokens.output || 0)
                                              + (message.info.tokens.reasoning || 0)
    sessionModelUsage[modelKey].tokens.cache.read  += message.info.tokens.cache?.read  || 0
    sessionModelUsage[modelKey].tokens.cache.write += message.info.tokens.cache?.write || 0
  }
  for (const part of message.parts) {
    if (part.type === "tool" && part.tool) sessionToolUsage[part.tool] = (sessionToolUsage[part.tool] || 0) + 1
  }
}
```

输出形如：

```
┌────────────────────────────────────────────────────────┐
│                       OVERVIEW                         │
├────────────────────────────────────────────────────────┤
│Sessions                                            123 │
│Messages                                          4,567 │
│Days                                                 30 │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                    COST & TOKENS                       │
├────────────────────────────────────────────────────────┤
│Total Cost                                       $12.34 │
│Cache Read                                         1.2M │
└────────────────────────────────────────────────────────┘
```

## 13.8 Prompt Caching 支持

只在支持 inline cache marker 的协议上工作（`packages/llm/src/cache-policy.ts:42`）：

```ts
const RESPECTS_INLINE_HINTS = new Set(["anthropic-messages", "bedrock-converse"])
```

OpenAI、Gemini 等用隐式 prefix caching 或带外 cache API，opencode 不主动插标记。

### 默认 `auto` 策略

```ts
// cache-policy.ts:18
const AUTO: CachePolicyObject = {
  tools: true,                  // 最后一个 tool definition
  system: true,                 // 最后一个 system part
  messages: "latest-user-message",  // 最后一条 user message
}
```

为什么是这三个切点？因为"工具循环"模式下，一条 user message 经常炸成 N 个 assistant/tool round-trip——把切点放在最新 user message 之前，能让循环里每次 API call 都命中前缀缓存。

注释里点明：Anthropic 的 5m cache write 是基价 1.25x、read 是 0.1x，**单次重用就回本**，所以默认 ON 是经济上合理的。

### 实现细节

```ts
// cache-policy.ts:99
export const applyCachePolicy = (request: LLMRequest): LLMRequest => {
  if (!RESPECTS_INLINE_HINTS.has(request.model.route.id)) return request
  const policy = resolve(request.cache)
  if (!policy.tools && !policy.system && !policy.messages) return request
  const hint = makeHint(policy.ttlSeconds)
  const tools = policy.tools ? markLastTool(request.tools, hint) : request.tools
  const system = policy.system ? markLastSystem(request.system, hint) : request.system
  const messages = policy.messages ? markMessages(request.messages, policy.messages, hint) : request.messages
  // ... 返回新 request
}
```

`markLastTool` / `markLastSystem` / `markMessageAt` 都遵守"保留用户手动放置的 `CacheHint`，只填空"的规则（`cache-policy.ts:50, 57, 74`）。

命中率统计：`assistant.tokens.cache.read` / `cache.write` 由 provider 返回，opencode 把它们累计到 session.tokens 上，可以在 `opencode stats` 里看到（13.7）。

## 13.9 Reminder 系统

`packages/opencode/src/session/reminders.ts`（91 行）在合适时机往最近一条 user message 里追加 `synthetic` text part。这些 part 不是用户输入，但在发给 LLM 时混进上下文。

主要场景（`reminders.ts:25` 起）：

- 当前 agent 是 `plan`：注入 `PROMPT_PLAN` 提醒模型走计划模式。
- 上一条 assistant 消息是 `plan`，现在切到 `build`：注入 `BUILD_SWITCH` 说"刚才在规划，现在开干"。
- 实验性 plan-mode 开启时：检查 `.opencode/plan/<session>.md` 是否已存在，注入对应文案让模型知道要 read 还是 create。

```ts
// reminders.ts:14
export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: MessageV2.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  // ...
  if (input.agent.name === "plan") {
    userMessage.parts.push({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: PROMPT_PLAN,
      synthetic: true,                          // 渲染时可隐藏
    })
  }
  // ...
})
```

`synthetic: true` 是关键——TUI 渲染会跳过这些 part，但发给 LLM 时它们正常参与上下文（参考第 7 章的 `MessageV2.toModelMessagesEffect`）。

## 13.10 Background 任务

`packages/opencode/src/background/job.ts`（200 行）提供一个轻量级 in-process job runner，用于后台跑 summary 计算、分享 sync、压缩续传等耗时但用户不需要等待的任务。

API（`background/job.ts:53`）：

```ts
interface Interface {
  list:   () => Effect.Effect<Info[]>
  get:    (id: string) => Effect.Effect<Info | undefined>
  start:  (input: StartInput) => Effect.Effect<Info>      // 启动并 fork 进 scope
  wait:   (input: WaitInput) => Effect.Effect<WaitResult> // 可带 timeout
  cancel: (id: string) => Effect.Effect<Info | undefined>
}
```

每个 job 用一个 `SynchronizedRef<Map<string, Active>>` 维护，状态机：

```
running → completed
running → error
running → cancelled
```

`start` 内部用 `Effect.forkIn(scope, { startImmediately: true })`（`job.ts:150`），cancel 调 `Fiber.interrupt`，结束时 `Cause.hasInterruptsOnly` 判断是否真的是 cancellation。

调用方典型代码：

```ts
yield* job.start({
  type: "summary",
  title: "Generating session summary",
  metadata: { sessionID },
  run: Effect.gen(function* () {
    yield* summary.summarize({ sessionID, messageID })
    return "ok"
  }),
})
```

job 信息也可以通过 SDK 列出来，UI 显示"后台进行中"指示器。

## 13.11 Share：分享 session 给他人

两个文件协作：

- `packages/opencode/src/share/session.ts`：高级 API（`SessionShare.share` / `unshare`）
- `packages/opencode/src/share/share-next.ts`：底层 HTTP 客户端 + bus 订阅器

### 流程

```ts
// share/session.ts:27
const share = Effect.fn(...)(function* (sessionID: SessionID) {
  const conf = yield* cfg.get()
  if (conf.share === "disabled") throw new Error("Sharing is disabled in configuration")
  const result = yield* shareNext.create(sessionID)               // POST /api/shares
  yield* sync.run(Session.Event.Updated, { sessionID, info: { share: { url: result.url } } })
  return result
})
```

`shareNext.create`（`share-next.ts:314`）：

1. POST 到 `${baseUrl}/api/shares`（或 enterprise 的 `legacyApi` `/api/share`），拿回 `{ id, url, secret }`。
2. 写本地 `SessionShareTable`（`share/share.sql.ts`）持久化分享凭据。
3. 把整个 session 全量推送（`full(sessionID)`，`share-next.ts:278`）：session 信息 + 所有 message + 所有 part + diff + 模型列表。
4. 之后通过订阅 bus（`watch(...)`，`share-next.ts:190`），每次 message/part/diff 变化都把增量 push 到 shares 端点的 `/sync` 接口（debounce 1s）。

### 配置

```jsonc
// opencode.json
{
  "share": "manual"  // 默认；也支持 "auto" 或 "disabled"
}
```

`auto` 时新建 session 自动分享（`session.ts` 调 `share`）。环境变量 `OPENCODE_DISABLE_SHARE=1` 全局关闭。

### Console vs Legacy

- 没登录 / 没 active org：用 `legacyApi`（`/api/share`），baseUrl = `https://opncd.ai`（或配置里 `enterprise.url`）。
- 登录到 Console：用 `consoleApi`（`/api/shares`），baseUrl 来自 active account。

## 13.12 Sync：多端同步 session

`packages/opencode/src/sync/index.ts`（411 行）。Sync 不是给 share 用的，是给"同一用户多个 opencode 实例"用的——比如桌面端 Desktop App + 终端 TUI 同时打开同一个项目。

详见 `packages/opencode/src/sync/README.md`，核心思想：

> 事件溯源 + 单写者 + 单调 seq。一个设备拥有写权（`owner_id`），其他设备只读，通过拉事件流 replay 同步状态。

### Sync event vs Bus event

```ts
// sync/index.ts:24
export type Definition<...> = {
  type: string
  version: number
  aggregate: string                       // 聚合根字段名，如 "sessionID"
  schema: EffectSchema                    // 事件数据 schema
  properties: EffectSchema                // bus payload schema（默认 = schema）
}
```

`SyncEvent.run(def, data)`（`sync/index.ts:136`）：

1. 在 `immediate` 事务里读 `EventSequenceTable` 取 `seq+1`。
2. 调用 projector（在 `server/projectors.ts` 里注册）写 DB。
3. 实验性 workspaces 开启时，把事件存入 `EventTable` 供 replay。
4. 同时往本地 `Bus` 和 `GlobalBus` publish，UI 立即收到。

`SyncEvent.replay`（`sync/index.ts:75`）保证幂等：检查 seq 顺序，老于已知的事件直接丢弃；中间空洞抛错。

`claim(aggregateID, ownerID)`（`sync/index.ts:180`）让某个设备声称对 aggregate（一般是 session）有写权。

### 向后兼容

所有原本 `Bus.publish` 走的 session 突变事件（`Updated` / `Created` / `Deleted` / `MessageV2.Updated` / `PartUpdated`...）都升级成 sync event，但 bus 订阅 API 保持不变。sync 事件**自动**再以 bus event 的形式发布（`sync/index.ts:340`），让旧代码无感知。

少数事件（如 `session.updated`）的 `busSchema` 与 `schema` 不同——sync 只存增量字段，bus 需要完整对象，靠 `convertEvent` 回填。

## 13.13 Worktree：subagent 隔离

`packages/opencode/src/worktree/index.ts`（620 行）封装 git worktree 创建/列出/删除。

主要场景：subagent（子任务）要在隔离环境里跑——避免和主 agent 编辑同一个文件互相覆盖。

### create 流程

```ts
// worktree/index.ts:299
const create = Effect.fn(...)(function* (input?: CreateInput) {
  const info = yield* makeWorktreeInfo({ name: input?.name })    // 生成唯一目录名 + 分支名
  yield* createFromInfo(info, input?.startCommand)               // setup + boot
  return info
})
```

子步骤：

1. `makeWorktreeInfo`（`worktree/index.ts:209`）：在 `~/.local/share/opencode/worktree/<projectID>/<slug>` 下找一个不存在的目录、确保 `refs/heads/opencode/<slug>` 也不存在，最多试 26 次。
2. `setup`（`worktree/index.ts:224`）：跑 `git worktree add --no-checkout -b opencode/<slug> <directory>`。
3. `project.addSandbox(...)`：把这个目录注册为该 project 的 sandbox。
4. `boot`（`worktree/index.ts:241`）：异步 `git reset --hard` 填充文件，然后 `InstanceStore.load` 让这个目录作为新的 opencode instance 运行，最后跑 `runStartScripts` 执行项目自定义启动脚本。

事件：boot 完成发 `worktree.ready`，失败发 `worktree.failed`（`worktree/index.ts:25, 33`）。

非 git 项目（`ctx.project.vcs !== "git"`）会拒绝创建，抛 `NotGitError`。

### 与 subagent 的配合

主 agent 在调用 `subtask` 工具时，可以指定 `worktree: true`。这种情况下：

1. 主 agent 上下文里调 `Worktree.create({ name: "<sub-task-slug>" })`。
2. 拿到 `info.directory` 后，启动新 instance 绑定到这个目录。
3. 在新 instance 下创建 subagent session（`parentID` 指向主 session）。
4. subagent 跑完后通过返回文本告诉主 agent 结果；worktree 目录默认保留供查看。
5. 主 agent 可在后续手动 `Worktree.remove` 或合并改动。

清理：`Worktree.remove`（`worktree/index.ts:142`）跑 `git worktree remove`；失败时 `failedRemoves` 解析 stderr 列出哪些文件占用。`Worktree.reset` 把目录 reset 到 HEAD 但不删除目录，方便复用。

## 13.14 ACP：Agent Client Protocol

`packages/opencode/src/acp/`：opencode 作为 ACP server，给 Zed、Neovim 等编辑器接入。

详见 `packages/opencode/src/acp/README.md`。

### 启动

CLI：`opencode acp`（`packages/opencode/src/cli/cmd/acp.ts:13`）。

```ts
// cli/cmd/acp.ts:23
handler: Effect.fn(...)(function* (args) {
  process.env.OPENCODE_CLIENT = "acp"
  const opts = yield* resolveNetworkOptions(args)
  const server = yield* Effect.promise(() => Server.listen(opts))      // 内部 HTTP server
  const sdk = createOpencodeClient({
    baseUrl: `http://${server.hostname}:${server.port}`,
    headers: ServerAuth.headers(),
  })
  // 在 stdio 上跑 JSON-RPC，把 ACP 请求翻译成 opencode HTTP API
  const stream = ndJsonStream(input, output)
  const agent = ACP.init({ sdk })
  new AgentSideConnection((conn) => agent.create(conn, { sdk }), stream)
  // ...
})
```

ACP 客户端（如 Zed）spawn 这个进程，通过 stdin/stdout 发 ND-JSON-RPC。opencode 内部把 ACP session 映射到 opencode session（`acp/session.ts`），调用现有 `SessionPrompt`、`ToolRegistry`。

支持：

- `initialize` / capability 协商
- `session/new` / `session/load`
- `session/prompt`（处理用户消息）
- `readTextFile` / `writeTextFile`（文件操作请求回客户端）
- 权限请求（暂时全部 auto-approve）

不支持（README 自承）：流式响应、tool call 进度、session mode 切换、真实持久化。

### Zed 集成

```jsonc
// ~/.config/zed/settings.json
{
  "agent_servers": {
    "OpenCode": {
      "command": "opencode",
      "args": ["acp"]
    }
  }
}
```

### Question tool

ACP 默认排除 `QuestionTool`（避免在不支持交互的客户端里卡死）。`OPENCODE_ENABLE_QUESTION_TOOL=1` 强制启用。

## 13.15 IDE 集成

`packages/opencode/src/ide/index.ts`（71 行）—— 主要是检测当前是不是在 VSCode 系编辑器的内置终端里，并提供"装扩展"功能。

```ts
// ide/index.ts:7
const SUPPORTED_IDES = [
  { name: "Windsurf", cmd: "windsurf" },
  { name: "Visual Studio Code - Insiders", cmd: "code-insiders" },
  { name: "Visual Studio Code", cmd: "code" },
  { name: "Cursor", cmd: "cursor" },
  { name: "VSCodium", cmd: "codium" },
]

export function ide() {
  if (process.env["TERM_PROGRAM"] === "vscode") {
    const v = process.env["GIT_ASKPASS"]
    for (const ide of SUPPORTED_IDES) if (v?.includes(ide.name)) return ide.name
  }
  return "unknown"
}
```

通过 `GIT_ASKPASS` 路径里编辑器名字反推具体是哪个 fork。

`install(ide)`（`ide/index.ts:46`）执行 `<cmd> --install-extension sst-dev.opencode`，装上 opencode 的 VSCode 扩展。`alreadyInstalled()` 检查 `OPENCODE_CALLER` 是否被扩展设置过。

事件：`Event.Installed` 在装好时广播（`ide/index.ts:18`），UI 可以提示用户重启。

Zed 走 ACP（13.14），不走这条路径。

## 13.16 导入 / 导出

### export

`packages/opencode/src/cli/cmd/export.ts`：

```bash
opencode export                    # 交互选 session
opencode export <sessionID>        # 直接导出
opencode export <sessionID> --sanitize    # 把敏感内容 redact 成 [redacted:...]
```

输出格式：`{ info: Session.Info, messages: MessageV2.WithParts[] }`，到 stdout。

`--sanitize` 时遍历所有 part，把文本、文件路径、tool 输入/输出、metadata 替换成 `[redacted:<kind>:<id>]`（`export.ts:10, 162`）。用于"我想分享一个 bug repro 但不想泄露代码"。

### import

`packages/opencode/src/cli/cmd/import.ts`：

```bash
opencode import session.json                       # 从本地 JSON
opencode import https://opncd.ai/share/abcXYZ      # 从分享 URL
```

URL 模式：

1. `parseShareUrl(url)`（`import.ts:27`）提取 slug。
2. GET `/api/shares/<slug>/data`（或 legacy `/api/share/<slug>/data`，`import.ts:131` 兜底）。
3. 服务端返回**扁平数组** `[session, message, part, ...]`，`transformShareData`（`import.ts:48`）按 messageID 把 part 重组回嵌套结构。

无论本地还是 URL，最终都用 `Schema.decodeUnknownSync(Session.Info)` 校验，然后 `INSERT ... ON CONFLICT DO NOTHING` 写到当前 instance 的 SessionTable / MessageTable / PartTable（`import.ts:178` 起）。

注意：

- `projectID` / `directory` / `path` 字段会被改写成**当前**项目（`import.ts:171`），导入到自己的工作区。
- `ON CONFLICT DO NOTHING` 让消息和 part 不会被覆盖，但 session 会用新的 project/directory 字段 update。

## 13.17 这一章的脑图

<svg viewBox="0 0 880 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Mind map of advanced features by category">
  <defs>
    <marker id="ar134" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="20" width="200" height="190" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="120" y="40" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">长会话管理</text>
  <g font-size="10" fill="currentColor">
    <text x="32" y="62">Fork</text><text x="100" y="62" fill="#64748b">session.ts:679</text>
    <text x="32" y="80">Revert</text><text x="100" y="80" fill="#64748b">revert.ts</text>
    <text x="32" y="98">Compaction</text><text x="100" y="98" fill="#64748b">compaction.ts</text>
    <text x="32" y="116">Overflow</text><text x="100" y="116" fill="#64748b">overflow.ts</text>
    <text x="32" y="134">Summary</text><text x="100" y="134" fill="#64748b">summary.ts</text>
  </g>
  <text x="32" y="160" font-size="10" fill="#64748b">复制 / 回滚 / 摘要</text>
  <text x="32" y="176" font-size="10" fill="#64748b">overflow 时自动压缩</text>
  <text x="32" y="192" font-size="10" fill="#64748b">summary 触发 snapshot diff</text>
  <rect x="240" y="20" width="200" height="100" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="340" y="40" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">文件状态</text>
  <text x="252" y="62" font-size="10" fill="currentColor">Snapshot</text>
  <text x="320" y="62" font-size="10" fill="#64748b">snapshot/index.ts</text>
  <text x="252" y="82" font-size="10" fill="#64748b">隐藏 git 仓库</text>
  <text x="252" y="98" font-size="10" fill="#64748b">track / restore / revert / diff</text>
  <rect x="460" y="20" width="200" height="190" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="560" y="40" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">成本可观测</text>
  <g font-size="10" fill="currentColor">
    <text x="472" y="62">tokens</text><text x="540" y="62" fill="#64748b">session schema</text>
    <text x="472" y="80">cost</text><text x="540" y="80" fill="#64748b">USD / call</text>
    <text x="472" y="98">stats CLI</text><text x="540" y="98" fill="#64748b">cli/cmd/stats.ts</text>
    <text x="472" y="116">cache hint</text><text x="540" y="116" fill="#64748b">cache-policy.ts</text>
  </g>
  <text x="472" y="142" font-size="10" fill="#64748b">cache: { read, write }</text>
  <text x="472" y="158" font-size="10" fill="#64748b">RESPECTS_INLINE_HINTS:</text>
  <text x="472" y="174" font-size="10" fill="#64748b">anthropic / bedrock-converse</text>
  <text x="472" y="192" font-size="10" fill="#64748b">default policy = auto</text>
  <rect x="680" y="20" width="180" height="100" rx="8" fill="#fff" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="770" y="40" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">辅助注入</text>
  <text x="692" y="62" font-size="10" fill="currentColor">Reminders</text>
  <text x="692" y="78" font-size="10" fill="#64748b">synthetic text part</text>
  <text x="692" y="98" font-size="10" fill="currentColor">Background Job</text>
  <text x="692" y="114" font-size="10" fill="#64748b">in-process runner</text>
  <rect x="20" y="240" width="840" height="160" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="440" y="262" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">异步与外部集成</text>
  <g font-size="10" fill="currentColor">
    <rect x="36" y="278" width="190" height="48" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="44" y="295">Share</text><text x="120" y="295" fill="#64748b">share-next.ts</text>
    <text x="44" y="311" fill="#64748b">HTTP push opncd.ai / console</text>
    <rect x="236" y="278" width="190" height="48" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="244" y="295">Sync</text><text x="320" y="295" fill="#64748b">sync/index.ts</text>
    <text x="244" y="311" fill="#64748b">event sourcing 跨设备</text>
    <rect x="436" y="278" width="190" height="48" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="444" y="295">Worktree</text><text x="520" y="295" fill="#64748b">worktree/index.ts</text>
    <text x="444" y="311" fill="#64748b">git worktree subagent 隔离</text>
    <rect x="636" y="278" width="208" height="48" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="644" y="295">ACP / IDE</text><text x="720" y="295" fill="#64748b">acp/ + ide/index.ts</text>
    <text x="644" y="311" fill="#64748b">Zed / VSCode / Cursor 接入</text>
    <rect x="36" y="338" width="290" height="48" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="44" y="355">Export</text><text x="120" y="355" fill="#64748b">cli/cmd/export.ts (--sanitize)</text>
    <text x="44" y="371" fill="#64748b">Import：本地 JSON 或 share URL</text>
    <rect x="336" y="338" width="508" height="48" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="344" y="355" fill="currentColor">配合典型链路</text>
    <text x="344" y="371" fill="#64748b">CI 重放 / 定时压缩 / 拉高 prompt cache 命中率 / subagent diff 汇总</text>
  </g>
</svg>
<span class="figure-caption">图 R13.4 ｜ 第 13 章脑图：长会话管理 / 文件状态 / 成本 / 辅助注入 / 异步与外部集成五大簇与各自代码入口。</span>

<details>
<summary>ASCII 原版</summary>

```
[长会话管理]
  ├── Fork        session.ts:679    （复制消息，新 sessionID）
  ├── Revert      revert.ts         （标记 + 配合 snapshot 回滚文件）
  ├── Compaction  compaction.ts     （摘要 + tail 保留 + prune）
  ├── Overflow    overflow.ts       （usable / isOverflow）
  └── Summary     summary.ts        （diff 摘要，diffFull 调 snapshot）

[文件状态]
  └── Snapshot    snapshot/index.ts (隐藏 git 仓库，track/restore/revert/diff)

[成本可观测]
  ├── tokens      session schema: input/output/reasoning/cache.{read,write}
  ├── cost        每次 LLM 调用累加
  ├── stats CLI   cli/cmd/stats.ts
  └── cache hint  packages/llm/src/cache-policy.ts

[异步与外部]
  ├── Background  background/job.ts (in-process job runner)
  ├── Reminders   session/reminders.ts (synthetic parts)
  ├── Share       share/share-next.ts (HTTP push to opncd.ai/console)
  ├── Sync        sync/index.ts (event sourcing 跨设备)
  ├── Worktree    worktree/index.ts (git worktree subagent 隔离)
  ├── ACP         acp/ + cli/cmd/acp.ts (Zed/IDE 协议)
  ├── IDE         ide/index.ts (VSCode 扩展安装)
  └── Export/Import  cli/cmd/export.ts / import.ts
```

</details>

## 13.18 配合使用的几个典型链路

### 13.18.1 "我要把这个 session 给 CI 跑一遍"

```
本地:  opencode export <id> --sanitize > repro.json
CI:    opencode import repro.json  (在干净 worktree 里)
       opencode run "请按照这个 session 的最后一步重做"
       opencode export <new-id> > result.json
```

注意 `--sanitize` 会把 tool 输出替换掉，CI 拿到的是消息骨架而非真实文件内容。如果要带文件内容请先脱敏到 fork 出来的 session 再导出，或干脆不加 `--sanitize`。

### 13.18.2 "Long-running session 每天压缩一次"

```
每天定时（cron 或 daemon）:
  1. SDK 调 Session.list 过滤 time.updated 在 24h 内的
  2. 对每个 session 调 SessionCompaction.create({ auto: true })
  3. 等 background job 完成
  4. SessionSummary.summarize 重新算 diff
```

实际很少有人手动跑——绝大多数情况依赖 overflow 触发足够。但企业部署的 Desktop 模式下，IT 可能想定时压缩控制成本。

### 13.18.3 "把 prompt cache 命中率提上去"

观察：

```
opencode stats --models    # 看 cache read / total tokens 比例
```

调优策略：

1. **稳定 system prompt**：不要在 system 里塞当前时间、随机 UUID。
2. **稳定工具集**：每次 turn 用同一组 tools，顺序也别变。
3. **缩短 user message**：最后一条 user message 是 cache 分界，越短越能让前缀缓存覆盖更多。冷起步前几次 user message 别太长。
4. **手动 CacheHint**：长 system prompt 末尾不加，opencode 自动加；中间的 reference 文档可以手动加多个 hint 切多段（高级用法）。

### 13.18.4 "Subagent 改了文件不知道改了什么"

主 agent 拿 subagent 返回文本后，可以让它自己调 `git diff` 看，或者用：

```
SessionSummary.computeDiff({ messages: [subagent session 的消息] })
```

但更实际的做法：subagent 在自己 session 末尾的 assistant message 里就明确列出"我改了哪些文件"。这靠 system prompt 里加约定（例如 `agent/general` 的 prompt 里写"完成后必须列出所有改动文件"）。

---

下一章把这些机制涉及的术语集中收编为术语表，并答几个高频问题。
