# Tour 步骤 04:创建 / 恢复 AgentSession

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:`AgentSessionRuntime` 已就绪,持有 `_session`(含 7 个工具、扩展绑定、system prompt)、`_services`(auth/models/settings/resourceLoader)和 `createRuntime` 工厂引用。InteractiveMode 还没有启动。

**下一步起点**:`AgentSession` 已构造完毕,初始 `agent.state.messages = []`(新建场景)或从 JSONL 文件恢复的历史消息(`--continue` 场景),session JSONL 文件路径已确定但尚未写入第一行(懒写入策略)。InteractiveMode 即将拿到 runtime 引用并调用 `init()`。

---

## 1. 当前情境

`createAgentSession()`(`sdk.ts:193`) 在 `createAgentSessionFromServices()` 的委托下执行。此时:

- `sessionManager` 已在 `main.ts:507` 由 `createSessionManager()` 创建,它的工厂模式决定了是新建还是恢复:

```
main.ts:282  parsed.continue -> SessionManager.continueRecent(cwd, sessionDir)
main.ts:265  parsed.resume   -> SessionManager.open(selectedPath, sessionDir)
main.ts:286  默认             -> SessionManager.create(cwd, sessionDir)
```

- `SessionManager.create()` 此时只分配了 session ID、构建了文件路径字符串,但还没有向磁盘写入任何字节。
- `AgentSession` 构造函数准备运行,它需要初始化工具注册表、system prompt、扩展 runner。

---

## 2. 问题

本步需要解决三个相关问题:

1. **session 文件路径如何命名**:文件名需要全局唯一,且在恢复时可以按时间排序找到最近的那个。

2. **`--continue` 和新建 session 的分叉点在哪里**:两条路径都到达同一个 `createAgentSession()` 函数,区别在 `sessionManager.buildSessionContext()` 返回的消息列表是否为空。

3. **初始 system prompt 如何构建**:`AgentSession` 里的 system prompt 不是一个固定字符串,而是每个 turn 开始时动态重建的(扩展可以 `append` 内容)。但在 session 构造阶段,需要有一个初始值写入 `agent.state.systemPrompt`。

---

## 3. 朴素思路

session 文件用 `session_{uuid}.jsonl` 命名,启动时立即写入文件头 JSON 行,然后追加消息。system prompt 是一个在启动时计算好、此后不变的字符串常量。

---

## 4. 为什么朴素思路会崩

**UUID 文件名无法排序**:用户运行 `pi --continue` 时需要找到最近使用的 session。UUID 本身没有时序信息,`findMostRecentSession()` 必须对所有文件调用 `stat()` 获取 mtime 才能排序——这在 session 数量多时很慢。实际实现用时间戳前缀(`2026-05-20T10-30-00_<uuidv7>.jsonl`)让文件名自然可排序,且 uuidv7 本身也包含时间戳。

**立即写入文件头会留下大量空文件**:每次用户打开 `pi` 但没有发送任何消息就退出,都会留下一个只有文件头的空 JSONL 文件,污染 session 列表。`SessionManager._persist()` 实现了懒写入:`session_manager.ts:838-856` 显示只有在第一条 assistant 消息到达时,才把所有已缓存的条目(包括 header)一次性写入磁盘。

**固定 system prompt 无法支持扩展动态注入**:扩展可能在每个 turn 开始时向 system prompt 追加内容(如当前 git 状态、打开文件列表)。如果 system prompt 是构造时固定的字符串,扩展就没有机会更新它。实际上 `AgentSession._baseSystemPrompt` 是每次 `_buildRuntime()` 时重新计算的基础 prompt,每个 turn 开始时再由扩展的 `context` 钩子 append 额外内容。

---

## 5. pi 的做法

**session 文件命名策略**(`session-manager.ts:767-789`):

```typescript
newSession(options?: NewSessionOptions): string | undefined {
    this.sessionId = options?.id ?? createSessionId();  // uuidv7()
    const timestamp = new Date().toISOString();
    const header: SessionHeader = {
        type: "session", version: CURRENT_SESSION_VERSION,
        id: this.sessionId, timestamp, cwd: this.cwd,
        parentSession: options?.parentSession,
    };
    this.fileEntries = [header];
    // ...
    if (this.persist) {
        const fileTimestamp = timestamp.replace(/[:.]/g, "-");
        // 例: 2026-05-20T10-30-00-000Z_01933abc....jsonl
        this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
    }
}
```

`sessionDir` 的路径规则(`session-manager.ts:427-434`):

```typescript
export function getDefaultSessionDir(cwd: string, agentDir: string): string {
    // cwd=/Users/alice/myproject -> sessions/--Users-alice-myproject--/
    const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return join(agentDir, "sessions", safePath);
}
```

每个项目的 session 文件存在自己的子目录,`--continue` 只在当前项目的子目录里找最近 session。

**懒写入策略**(`session-manager.ts:838-856`):

```
appendMessage(userMsg) -> _appendEntry -> _persist:
    hasAssistant = false  -> flushed = false, return (不写文件)

appendMessage(assistantMsg) -> _appendEntry -> _persist:
    hasAssistant = true
    if !flushed:
        fileEntries.forEach -> appendFileSync  <- 一次性把 header + user + assistant 全写进去
        flushed = true
    else:
        appendFileSync(entry)                  <- 后续条目逐行追加
```

这确保了如果用户打开 `pi` 但只发了一条消息、模型开始回复前就 Ctrl+C,session 文件不会留在磁盘上(或者只有 header,会被 `isValidSessionFile()` 过滤掉)。

**`--continue` 的恢复路径**(`sdk.ts:213-230`):

```
createAgentSession():
    existingSession = sessionManager.buildSessionContext()
    hasExistingSession = existingSession.messages.length > 0

    if hasExistingSession && existingSession.model:
        restoredModel = modelRegistry.find(provider, modelId)
        model = restoredModel (若 auth 已配置)

    if hasExistingSession:
        agent.state.messages = existingSession.messages  <- 恢复历史
        if !hasThinkingEntry:
            sessionManager.appendThinkingLevelChange(thinkingLevel)
    else:
        sessionManager.appendModelChange(model.provider, model.id)
        sessionManager.appendThinkingLevelChange(thinkingLevel)  <- 新 session 写入元数据
```

`buildSessionContext()` 从 JSONL 文件里的有向树结构(每个 entry 有 `id` 和 `parentId`)中,沿着 leafId 向根回溯,收集路径上的所有 message/custom_message/branch_summary 条目,构成 LLM 上下文所需的 `AgentMessage[]`(`session-manager.ts:314-421`)。

**system prompt 的初始化**(`agent-session.ts:338-342`):

`AgentSession` 构造函数末尾调用 `this._buildRuntime({activeToolNames, includeAllExtensionTools: true})`。它调用 `createAllToolDefinitions(cwd)` 构造全部 7 个工具定义,过滤出 `activeToolNames` 对应的工具写入 `agent.state.tools`,再调用 `buildSystemPrompt(options)`(`system-prompt.ts:28`)把 cwd、当前日期、工具说明、`AGENTS.md`/`CLAUDE.md` 等 context files 拼成初始 system prompt。

**ASCII 状态演化图**:

```
main.ts:507  SessionManager.create(cwd, sessionDir)
                 newSession() -> header 仅内存,sessionFile 路径已确定,flushed=false

sdk.ts:193  createAgentSession()
                 buildSessionContext() -> {messages:[], model:null}  (新建)
                 findInitialModel()    -> anthropic/claude-opus-4-5
                 new Agent({model, thinkingLevel:"medium", tools:[]})
                 new AgentSession({agent, sessionManager, ...})
                     _buildRuntime()
                         createAllToolDefinitions(cwd) -> 7 个 ToolDef
                         filter activeToolNames        -> [read,bash,edit,write]
                         agent.state.tools = [4 AgentTool]
                         buildSystemPrompt({cwd,...})  -> agent.state.systemPrompt
                         bindExtensions()             -> extensionRunner ready
                 返回 { session, extensionsResult }

main.ts:619  runtime 构造完毕,等待 InteractiveMode 启动
```

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/coding-agent/src/main.ts` | 216-287 | `createSessionManager()` — 四种 session 模式分支 |
| `packages/coding-agent/src/main.ts` | 282-283 | `--continue` 调用 `SessionManager.continueRecent()` |
| `packages/coding-agent/src/core/session-manager.ts` | 427-434 | `getDefaultSessionDir()` — cwd 编码为目录名 |
| `packages/coding-agent/src/core/session-manager.ts` | 706-732 | `SessionManager` 构造函数 |
| `packages/coding-agent/src/core/session-manager.ts` | 767-789 | `newSession()` — 文件名生成(时间戳+uuidv7) |
| `packages/coding-agent/src/core/session-manager.ts` | 838-856 | `_persist()` — 懒写入策略 |
| `packages/coding-agent/src/core/session-manager.ts` | 1306-1309 | `SessionManager.create()` |
| `packages/coding-agent/src/core/session-manager.ts` | 1317-1325 | `SessionManager.open()` — 从文件恢复 |
| `packages/coding-agent/src/core/session-manager.ts` | 1332-1339 | `SessionManager.continueRecent()` |
| `packages/coding-agent/src/core/session-manager.ts` | 314-421 | `buildSessionContext()` — JSONL 树遍历还原消息 |
| `packages/coding-agent/src/core/sdk.ts` | 193-413 | `createAgentSession()` 全文 |
| `packages/coding-agent/src/core/sdk.ts` | 213-230 | 从 JSONL 恢复 model/消息 |
| `packages/coding-agent/src/core/sdk.ts` | 378-405 | 构造 `AgentSession` 并返回 |
| `packages/coding-agent/src/core/agent-session.ts` | 318-342 | `AgentSession` 构造函数 |
| `packages/coding-agent/src/core/system-prompt.ts` | 28-80 | `buildSystemPrompt()` — 拼接 cwd/日期/tools/context files |

---

## 7. 分支与延伸

- **JSONL 文件的树状结构与 `id`/`parentId` 设计**:见 [第 13 章 §13.2「session 文件格式」](./13-config-and-sessions.md#132-session-文件格式)。`parentId` 字段支持非线性历史(branching/forking),`buildSessionContext()` 的树遍历算法也在此章有详述。

- **session 持久化、compaction 与 branch summary 的关系**:见 [第 06 章 §6.2「Session 持久化」](./06-agent-runtime-sessions-compaction.md#62-session-持久化)。懒写入策略、`appendMessage` 与 `appendCompaction` 的区别、JSONL 迁移(`v1→v2→v3`)均在此章说明。

- **`AgentSession` 完整生命周期(prompt/compaction/dispose)**:见 [第 07 章 §7.5「AgentSession 创建」](./07-coding-agent-cli-startup.md#75-agentsession-创建)。`_buildRuntime()` 在每次工具集变化时被重新调用,system prompt 也随之重建。

---

## 8. 走完这一步你脑子里应该多了什么

1. **session 文件在第一条 assistant 消息到达之前不存在于磁盘**:`newSession()` 只生成了文件路径字符串,header 还在内存里等待刷盘。`_persist()` 检查到第一条 assistant 消息时,才把所有积压条目一次性追加进文件。这就是为什么进程崩溃或用户 Ctrl+C 太早时不会留下空 session 文件。

2. **`--continue` 和新建共用同一个 `createAgentSession()` 入口**:分叉点是 `buildSessionContext().messages.length > 0`。非零意味着有历史消息,`createAgentSession()` 把它们赋给 `agent.state.messages`,model 和 thinkingLevel 也从 JSONL 里的 `model_change`/`thinking_level_change` 条目恢复。新建则 messages 为空,model 由 `findInitialModel()` 从 settings 和环境变量重新决定。

3. **sessionDir 编码了 cwd**:`~/.pi/agent/sessions/--Users-alice-myproject--/` 这种目录结构让同一用户在不同项目里的 session 自然隔离。`--continue` 只在当前 cwd 的子目录里找 mtime 最新的 `.jsonl` 文件,不会把其他项目的 session 混进来。

4. **system prompt 是构造时快照,但可被扩展动态 append**:`_buildRuntime()` 结束时 `_baseSystemPrompt` 就固定了,但每次 `agent.prompt()` 调用前,`AgentSession` 会调用扩展 runner 的 `context` 钩子,允许扩展向当前 turn 的 system prompt 追加内容(如 git status、文件树)。基础部分不变,追加部分每 turn 重新生成。

5. **`AgentSession` 构造完成时 messages 已就位**:无论是新建(空数组)还是恢复(历史数组),`agent.state.messages` 在 `AgentSession` 构造完成时就已经是最终状态。InteractiveMode 拿到 session 后不需要做任何初始化,可以直接渲染 UI 并等待用户输入。
