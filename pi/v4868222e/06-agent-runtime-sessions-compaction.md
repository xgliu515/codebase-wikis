# 第 06 章 Agent Runtime:Session 持久化与 Compaction

> 版本锁定:commit `4868222e`(2026-05-20),`packages/agent` v\*。本章所有 `file:line` 引用均基于该 commit,后续变更不在覆盖范围内。

---

## 目录

1. [Session 是什么及为什么由 agent runtime 管理](#1-session-是什么)
2. [存储抽象:JSONL 与内存两种实现](#2-存储抽象)
3. [buildSessionContext:从存储恢复会话](#3-buildsessioncontext)
4. [AgentHarness:agent-loop 之上的高层 API](#4-agentharness)
5. [System Prompt 渲染](#5-system-prompt-渲染)
6. [Skill 块](#6-skill-块)
7. [Compaction:上下文压缩机制](#7-compaction)
8. [端到端流程图](#8-端到端流程图)

---

## 1 Session 是什么

在 pi 里,**Session** 是一次对话的完整持久化记录,包含:

- 消息历史(`MessageEntry` 序列)
- 元数据:模型变更记录、thinking level 变更记录
- 分支树结构:每个 entry 持有 `parentId`,允许非线性历史(分支跳转)
- 压缩检查点(`CompactionEntry`)
- 分支摘要(`BranchSummaryEntry`)
- 标签(`LabelEntry`)

Session 在设计上对应"一个工作目录里的一次对话流"。`JsonlSessionMetadata.cwd` 字段把 session 和文件系统工作目录绑定。

### 1.1 为什么由 agent runtime 直接管理

**不交给 coding-agent 管理的原因**:

1. **持久化时机需要贴近事件流**:消息在 `message_end` 事件触发时立即写入(`agent-harness.ts:484`),而不是在整个 turn 完成后批量写入。如果持久化逻辑在 coding-agent 层,它需要订阅 AgentEvent 流并精确把握写入时机——本质上是复制 `AgentHarness.handleAgentEvent` 的逻辑。
2. **压缩需要了解完整的消息历史树结构**:`shouldCompact`、`findCutPoint`、`buildSessionContext` 这些函数操作 `SessionTreeEntry[]`——这是底层存储对象,不是 LLM 消息对象。coding-agent 使用的是高层 `AgentMessage[]`,它不感知历史树中的 `compaction`、`branch_summary` 等元数据节点。
3. **模型切换需要被持久化**:用户在会话中切换模型后,下次恢复会话时需要用同一个模型(或者至少知道之前用的是哪个)。这个逻辑放在 runtime 层比应用层更合适。
4. **token usage 累积**:`estimateContextTokens` 依赖 provider 在 `AssistantMessage.usage` 中返回的 token 计数,只有 runtime 层在 streaming 结束时才能拿到这个值。

---

## 2 存储抽象

`SessionStorage<TMetadata>` 接口(`harness/types.ts:433-447`)定义了存储后端的最小操作集:

```typescript
interface SessionStorage<TMetadata extends SessionMetadata> {
  getMetadata(): Promise<TMetadata>;
  getLeafId(): Promise<string | null>;
  setLeafId(leafId: string | null): Promise<void>;
  createEntryId(): Promise<string>;
  appendEntry(entry: SessionTreeEntry): Promise<void>;
  getEntry(id: string): Promise<SessionTreeEntry | undefined>;
  findEntries<TType>(type: TType): Promise<Array<...>>;
  getLabel(id: string): Promise<string | undefined>;
  getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]>;
  getEntries(): Promise<SessionTreeEntry[]>;
}
```

`SessionRepo` 接口在 `SessionStorage` 之上提供 CRUD + fork 操作:

```typescript
interface SessionRepo<TMetadata, TCreateOptions, TListOptions> {
  create(options): Promise<Session<TMetadata>>;
  open(metadata): Promise<Session<TMetadata>>;
  list(options?): Promise<TMetadata[]>;
  delete(metadata): Promise<void>;
  fork(source, options): Promise<Session<TMetadata>>;
}
```

### 2.1 JSONL 文件格式

`JsonlSessionStorage`(`harness/session/jsonl-storage.ts`) 把一个 session 存为一个 `.jsonl` 文件。文件格式:

```
第 1 行: SessionHeader (JSON)
第 2+ 行: SessionTreeEntry (每行一个 JSON 对象)
```

**SessionHeader** 示例:
```json
{"type":"session","version":3,"id":"01970000","timestamp":"2026-05-20T10:00:00.000Z","cwd":"/Users/user/project"}
```

**SessionTreeEntry** 示例(消息 entry):
```json
{"type":"message","id":"01970001","parentId":"01970000","timestamp":"2026-05-20T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hello"}],"timestamp":1716199201000}}
```

**LeafEntry**(记录当前活跃分支末端):
```json
{"type":"leaf","id":"01970010","parentId":"01970009","timestamp":"...","targetId":"01970009"}
```

**设计要点**:

- **只追加(append-only)**:所有写操作都是 `appendFile`,文件内容只增不删(`jsonl-storage.ts:250-258`)。分支跳转通过追加新 `LeafEntry` 实现,不修改已有行。
- **内存缓存**:所有 entry 在 open/create 时全量加载到 `this.entries` 数组和 `this.byId: Map<id, entry>` 字典中。后续读操作走内存,写操作先追加到文件再更新内存缓存。
- **leafId 追踪**:文件加载时,通过线性扫描计算最终 `leafId`(每行调用 `leafIdAfterEntry`,leaf entry 取 `targetId`,其他 entry 取 `id`)(`jsonl-storage.ts:153-157`)。
- **并发冲突**:`JsonlSessionStorage` 没有进程间锁。每个进程打开自己的实例,维护自己的内存缓存。同一文件多进程并发写是未定义行为——pi 的设计假设是单进程访问同一 session 文件。
- **短 ID**:entry ID 使用 `uuidv7().slice(0, 8)` 生成 8 字符前缀(`jsonl-storage.ts:35-41`)。冲突时自动重试,实在冲突才用完整 UUID。这是为了减少文件大小。

**文件命名规则**(`jsonl-repo.ts:65-72`):

```
<sessions-root>/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
```

`encodeCwd` 把工作目录路径编码为 `--path-to-project--` 形式(去掉前导 `/`,把 `/`、`:` 换成 `-`),用于目录名。不同工作目录的 session 存在不同子目录,`list(cwd)` 只扫描对应子目录。

### 2.2 内存实现

`InMemorySessionStorage`(`harness/session/memory-storage.ts`) 是 `SessionStorage` 的完整内存实现,结构与 JSONL 实现相同但不涉及文件系统。用于单元测试和不需要持久化的场景。

`InMemorySessionRepo`(`harness/session/memory-repo.ts`) 在内存 Map 中管理多个 `InMemorySessionStorage`,实现 CRUD + fork 操作。

### 2.3 getPathToRoot:树遍历

`getPathToRoot(leafId)` 是 `SessionStorage` 的核心查询,返回从 `leafId` 到根的路径(包含两端,根在前),用于重建线性消息历史:

```typescript
// jsonl-storage.ts:275-288
async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
  if (leafId === null) return [];
  const path: SessionTreeEntry[] = [];
  let current = this.byId.get(leafId);
  while (current) {
    path.unshift(current);  // 前插保证根在最前
    if (!current.parentId) break;
    current = this.byId.get(current.parentId);
  }
  return path;
}
```

`Session.getBranch()` 封装了 `getPathToRoot(currentLeafId)` 调用(`session.ts:105-108`)。

---

## 3 buildSessionContext

`buildSessionContext(pathEntries: SessionTreeEntry[]): SessionContext` 是从存储树路径重建内存消息列表的核心函数,定义在 `harness/session/session.ts:21-76`。

### 3.1 两阶段处理

**第一阶段**:线性扫描提取元数据(`session.ts:27-35`):

```typescript
for (const entry of pathEntries) {
  if (entry.type === "thinking_level_change") {
    thinkingLevel = entry.thinkingLevel;
  } else if (entry.type === "model_change") {
    model = { provider: entry.provider, modelId: entry.modelId };
  } else if (entry.type === "message" && entry.message.role === "assistant") {
    model = { provider: entry.message.provider, modelId: entry.message.model };
  } else if (entry.type === "compaction") {
    compaction = entry;
  }
}
```

模型信息同时从 `model_change` entry 和 `assistant` 消息中提取。后者保证了即使没有显式的 `model_change` 记录,也能从对话历史恢复模型信息。

**第二阶段**:构建消息列表(`session.ts:38-75`),分有无压缩两种情况:

**无压缩**:顺序遍历所有 entry,对 `message`、`custom_message`、`branch_summary` 类型的 entry 转换为 `AgentMessage` 追加到列表。其他类型(model_change、thinking_level_change 等)不产生消息。

**有压缩**:

```typescript
if (compaction) {
  // 1. 先放入压缩摘要作为第一条消息
  messages.push(createCompactionSummaryMessage(compaction.summary, ...));

  // 2. 找到 compaction entry 在路径中的位置
  const compactionIdx = pathEntries.findIndex(e => e.type === "compaction" && e.id === compaction.id);

  // 3. 在 compactionIdx 之前,只保留从 firstKeptEntryId 开始的 entry
  let foundFirstKept = false;
  for (let i = 0; i < compactionIdx; i++) {
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) appendMessage(entry);
  }

  // 4. compactionIdx 之后的 entry 全部保留
  for (let i = compactionIdx + 1; i < pathEntries.length; i++) {
    appendMessage(pathEntries[i]);
  }
}
```

这个逻辑的语义:compaction 之前的历史被摘要替代,只有 `firstKeptEntryId` 之后的部分被保留(作为"近期历史窗口"),compaction 之后追加的新消息完整保留。

### 3.2 tool_result 与 tool_call 对齐

pi 不做任何特殊的 tool_result/tool_call 配对验证。每个消息 entry 独立存储和读取,`buildSessionContext` 按历史顺序追加——对齐是由写入时的顺序保证的(先写 assistant 消息,再写 tool_result 消息)。

但 `getPathToRoot` 返回的是**线性有序路径**,分支树结构保证了父子顺序——子 entry 始终在父 entry 之后。结合 `runLoop` 中 "先 push assistant 消息,再 push tool_result 消息" 的写入顺序,`buildSessionContext` 恢复出的消息列表中 assistant 消息必然先于对应的 tool_result 消息。

---

## 4 AgentHarness

`AgentHarness`(`harness/agent-harness.ts`) 是 `runAgentLoop` 之上的高层 API,在 agent-loop 层面做了三件事:

1. **消息构造**:把用户输入、技能调用、模板调用统一转换为 `AgentMessage[]` 传给 `runAgentLoop`
2. **持久化桥**:把 `AgentEvent` 中的消息写入 Session 存储
3. **事件桥**:把 `AgentEvent` 和 harness 自有事件合并,通过 `subscribe`/`on` API 暴露给上层

### 4.1 典型 harness 用法

```typescript
const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv(cwd), sessionsRoot });
const session = await repo.create({ cwd });

const harness = new AgentHarness({
  env: new NodeExecutionEnv(cwd),
  session,
  model: anthropicClaude4,
  tools: [readFileTool, editFileTool, bashTool],
  systemPrompt: async ({ env, model, activeTools, resources }) => {
    return buildSystemPrompt({ env, model, tools: activeTools, skills: resources.skills });
  },
  getApiKeyAndHeaders: async (model) => ({
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  }),
});

// 订阅所有事件(AgentEvent + AgentHarnessOwnEvent)
const unsubscribe = harness.subscribe(async (event, signal) => {
  if (event.type === "message_end" && event.message.role === "assistant") {
    tui.renderMessage(event.message);
  }
  if (event.type === "session_compact") {
    tui.showNotification("会话历史已压缩");
  }
});

// 发送 prompt(同步等待 agent 完成)
const response = await harness.prompt("请重构 src/index.ts");

// 运行时中途注入(agent 正在执行工具时调用)
await harness.steer("请不要修改测试文件");

// agent 完成后追加后续消息
await harness.followUp("完成后请运行 npm test");

// 手动触发压缩(通常由外层自动调用)
await harness.compact("重点关注文件修改历史");
```

### 4.2 AgentHarnessPhase 状态机

`AgentHarness` 有四种阶段,防止并发操作冲突:

<svg viewBox="0 0 640 200" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="AgentHarnessPhase state machine: idle transitions to turn, compaction, branch_summary, all returning to idle">
  <defs>
    <marker id="ar61" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="80" width="80" height="36" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="60" y="103" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">idle</text>
  <rect x="200" y="20" width="110" height="36" rx="8" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="255" y="43" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">turn</text>
  <rect x="200" y="80" width="110" height="36" rx="8" fill="#f1f5f9" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="255" y="103" text-anchor="middle" font-size="12" font-weight="600" fill="#7c3aed">compaction</text>
  <rect x="200" y="140" width="130" height="36" rx="8" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="265" y="163" text-anchor="middle" font-size="12" font-weight="600" fill="#0ea5e9">branch_summary</text>
  <line x1="100" y1="52" x2="200" y2="38" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  <line x1="100" y1="98" x2="200" y2="98" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  <line x1="100" y1="144" x2="200" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  <rect x="450" y="80" width="80" height="36" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="490" y="103" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">idle</text>
  <line x1="310" y1="38" x2="490" y2="80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  <line x1="310" y1="98" x2="450" y2="98" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  <line x1="330" y1="158" x2="490" y2="116" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  <text x="145" y="32" text-anchor="middle" font-size="10" fill="#64748b">prompt/skill</text>
  <text x="145" y="94" text-anchor="middle" font-size="10" fill="#64748b">compact</text>
  <text x="145" y="154" text-anchor="middle" font-size="10" fill="#64748b">branch_summary</text>
</svg>
<span class="figure-caption">图 R6.1 ｜ AgentHarnessPhase 状态机——四种阶段及迁移路径</span>

<details>
<summary>ASCII 原版</summary>

```
idle ──► turn ──► idle
     ──► compaction ──► idle
     ──► branch_summary ──► idle
```

</details>

`prompt()`、`skill()`、`promptFromTemplate()` 都需要 `phase === "idle"`,否则抛 `AgentHarnessError("busy")`;`compact()` 同理。

`steer()` 和 `followUp()` 要求 `phase !== "idle"`(agent 必须正在运行才能注入)。

### 4.3 handleAgentEvent:持久化 + 事件转发

`handleAgentEvent`(`agent-harness.ts:483-510`) 是 harness 内部的事件处理核心:

```typescript
private async handleAgentEvent(event: AgentEvent, signal?: AbortSignal) {
  if (event.type === "message_end") {
    // 立即持久化消息到 session
    await this.session.appendMessage(event.message);
    await this.emitAny(event, signal);
    return;
  }
  if (event.type === "turn_end") {
    await this.emitAny(event, signal);
    // flush 所有待写入(模型切换、thinking level 切换等)
    await this.flushPendingSessionWrites();
    await this.emitOwn({ type: "save_point", hadPendingMutations });
    return;
  }
  if (event.type === "agent_end") {
    await this.flushPendingSessionWrites();
    this.phase = "idle";
    await this.emitAny(event, signal);
    await this.emitOwn({ type: "settled", nextTurnCount: ... });
    return;
  }
  await this.emitAny(event, signal);
}
```

**写入顺序**:`message_end` 触发立即写入(单条消息)。`turn_end` 触发批量 flush(模型切换等低频变更)。这个分离设计的原因:消息写入是高频且时序关键的(不能丢),而模型切换等在 turn 内可能多次发生(如果上层在工具 hook 里调用 `setModel`),flush 到 turn 结束时写入可以合并。

**pendingSessionWrites**:在 agent 运行期间(`phase="turn"`),对 Session 的修改请求(模型切换、添加标签等)被追加到 `this.pendingSessionWrites` 队列而不是立即写入。每个 `turn_end` 和 `agent_end` 时调用 `flushPendingSessionWrites` 批量提交(`agent-harness.ts:459-481`)。

### 4.4 createLoopConfig:桥接 harness 与 agent-loop

`createLoopConfig`(`agent-harness.ts:403-451`) 把 harness 的钩子接口适配为 `AgentLoopConfig`:

```typescript
return {
  model: turnState.model,
  convertToLlm,    // 来自 harness/messages.ts
  transformContext: async (messages) => {
    // 挂入 "context" hook,允许应用层截断/注入消息
    const result = await this.emitHook({ type: "context", messages });
    return result?.messages ?? messages;
  },
  beforeToolCall: async ({ toolCall, args }) => {
    // 挂入 "tool_call" hook
    const result = await this.emitHook({ type: "tool_call", ... });
    return result ? { block: result.block, reason: result.reason } : undefined;
  },
  afterToolCall: async ({ toolCall, result, isError }) => {
    // 挂入 "tool_result" hook
    const patch = await this.emitHook({ type: "tool_result", ... });
    return patch ? { ...patch } : undefined;
  },
  prepareNextTurn: async () => {
    // 每个 turn 结束后:flush 写入 → 重建 TurnState → 返回新 context
    await this.flushPendingSessionWrites();
    const nextTurnState = await this.createTurnState();
    setTurnState(nextTurnState);
    return { context: ..., model: ..., thinkingLevel: ... };
  },
  getSteeringMessages: async () => this.drainQueuedMessages(this.steerQueue, ...),
  getFollowUpMessages: async () => this.drainQueuedMessages(this.followUpQueue, ...),
};
```

`prepareNextTurn` 的设计是 harness 的关键差异点:每个 turn 结束后都会重新调用 `createTurnState()`(包括重建 systemPrompt 和 context),保证模型变更、工具变更在下一个 turn 立即生效,而不需要重新发起整个 `agentLoop`。

---

## 5 System Prompt 渲染

`AgentHarnessOptions.systemPrompt` 支持两种形式:

1. **静态字符串**:直接使用
2. **动态函数**:每个 turn 开始时调用,接收 `{ env, session, model, thinkingLevel, activeTools, resources }` 上下文

```typescript
// agent-harness.ts:324-332
if (typeof this.systemPrompt === "string") {
  systemPrompt = this.systemPrompt;
} else if (this.systemPrompt) {
  systemPrompt = await this.systemPrompt({
    env: this.env,
    session: this.session,
    model: this.model,
    thinkingLevel: this.thinkingLevel,
    activeTools,
    resources,
  });
}
```

**为什么把 system prompt 生成放在 harness 而不是 coding-agent**:

1. **每个 turn 都重新渲染**:coding-agent 如果管理 system prompt,它需要在每个 turn 前注入——这和 `prepareNextTurn` 的时机绑定。把这个逻辑放在 harness 避免了两个层级之间的时序协调。
2. **system prompt 需要访问 session 和 env**:完整的 system prompt 通常包含当前工作目录、已加载技能列表、活跃工具列表等信息。这些信息只有在 harness 层才能完整获取。
3. **before_agent_start hook 可以覆盖**:harness 在 `executeTurn` 中触发 `before_agent_start` hook,允许应用层在最终消息发送前替换 systemPrompt(`agent-harness.ts:543-549`)。

`formatSkillsForSystemPrompt`(`harness/system-prompt.ts`) 把技能列表转换为 XML 格式的系统提示片段:

```typescript
// system-prompt.ts:3-25
export function formatSkillsForSystemPrompt(skills: Skill[]): string {
  const visibleSkills = skills.filter(s => !s.disableModelInvocation);
  // 生成:
  // <available_skills>
  //   <skill>
  //     <name>skill-name</name>
  //     <description>...</description>
  //     <location>/path/to/SKILL.md</location>
  //   </skill>
  // </available_skills>
}
```

这个格式参考了 agentskills.io 规范,让 LLM 能解析技能列表并在需要时主动读取对应的 SKILL.md 文件。

---

## 6 Skill 块

### 6.1 什么是 Skill

在 pi 里,**Skill** 是一个带有结构化元数据的 Markdown 文件,向 LLM 提供特定任务的"执行手册"。它不是可执行代码,也不是 API 端点——它是注入到 prompt 中的结构化文本指令。

`Skill` 接口(`harness/types.ts:46-57`):

```typescript
export interface Skill {
  name: string;         // 稳定标识符,用于查找和模型可见列表
  description: string;  // 简短的"何时使用"说明(模型可见)
  content: string;      // 完整技能指令(调用时注入)
  filePath: string;     // 技能文件的绝对路径
  disableModelInvocation?: boolean;  // 只允许应用层显式调用,不出现在模型可见列表
}
```

### 6.2 与其他框架的 skill/tool 概念比较

| 概念 | pi Skill | OpenAI Tool | Anthropic Tool |
|------|----------|-------------|----------------|
| 执行方式 | 注入到 prompt 文本 | 结构化 function call | 结构化 tool_use |
| 定义方式 | Markdown 文件 | JSON schema | JSON schema |
| 触发时机 | 应用层显式调用 / LLM 读取文件 | LLM 输出 tool_use | LLM 输出 tool_use |
| 返回值 | 无(指令文本) | 结构化 JSON | 结构化 JSON |

pi 的 Skill 更接近"提示模板"而不是"工具"。LLM 在 system prompt 里看到技能列表后,可以主动使用 `read` 工具读取对应的 SKILL.md 文件获取完整指令。这种"懒加载"设计避免了把所有技能内容都放进 system prompt 导致 context 膨胀。

应用层也可以通过 `harness.skill(name)` 显式调用,此时 harness 格式化技能内容并作为 user prompt 发送:

```typescript
// agent-harness.ts:618-632
async skill(name: string, additionalInstructions?: string): Promise<AssistantMessage> {
  const skill = turnState.resources.skills.find(s => s.name === name);
  return await this.executeTurn(turnState, formatSkillInvocation(skill, additionalInstructions));
}
```

`formatSkillInvocation` 把技能包裹在 `<skill name="..." location="...">` XML 标签中(`harness/skills.ts:38-41`):

```typescript
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
  const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\n` +
    `References are relative to ${dirnameEnvPath(skill.filePath)}.\n\n` +
    `${skill.content}\n</skill>`;
  return additionalInstructions ? `${skillBlock}\n\n${additionalInstructions}` : skillBlock;
}
```

### 6.3 技能加载机制

`loadSkills(env, dirs)` 递归遍历目录(`harness/skills.ts:49-75`):

- 优先查找 `SKILL.md`——找到则该目录视为单个技能,不再递归子目录
- 没有 `SKILL.md` 则把根目录下的 `.md` 文件各自作为技能加载
- 遵守 `.gitignore`、`.ignore`、`.fdignore` 规则
- 技能名称从 frontmatter `name` 字段提取,不存在则用父目录名
- 必须有 `description` 字段,否则技能文件被忽略(只产生诊断警告)

Frontmatter 解析使用 YAML,`---` 分隔符之前的内容为 frontmatter,之后为 content。

---

## 7 Compaction

### 7.1 为什么需要压缩

LLM 有上下文窗口限制(Claude 3.7 典型为 200k tokens)。长对话的 token 数会线性增长,最终超出窗口导致 provider 报错。更重要的是,即使没有超出硬限制,过长的 context 也会:

- 增加每次 LLM 调用的成本(按 token 计费)
- 降低 LLM 关注近期内容的能力
- 使 prompt caching 失效(cache key 包含完整历史)

Compaction 的策略是:用 LLM 生成一份结构化摘要替换历史消息,只保留最近一段历史窗口。

### 7.2 shouldCompact:阈值判断

`shouldCompact`(`harness/compaction/compaction.ts:196-199`):

```typescript
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}
```

**默认阈值**(`DEFAULT_COMPACTION_SETTINGS`,`compaction.ts:112-116`):

```typescript
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,   // 为摘要 prompt 和输出预留的 token 数
  keepRecentTokens: 20000, // 保留最近约 20k tokens 的历史
};
```

触发条件:`contextTokens > contextWindow - 16384`。

**token 估算策略**:`estimateContextTokens`(`compaction.ts:165-193`) 结合两种方法:

1. 如果有最近的 `AssistantMessage.usage`,以其 `totalTokens` 作为基准(精确)
2. 用 `estimateTokens`(字符数/4 的启发式)估算基准之后的消息(近似)

`estimateTokens`(`compaction.ts:202-260`) 按消息角色分别处理:user 消息用文本字符数,assistant 消息累计 text/thinking/toolCall 的字符数,image 块固定估算 4800 tokens,工具结果字符数等。这是保守估算——实际 token 数通常比估算值稍低。

`AgentHarness.compact()` 的调用时机由应用层决定(通常是 coding-agent 在 `turn_end` 事件后检查 token 数)。harness 提供 `session_before_compact` hook 允许应用层在压缩前取消或提供自定义摘要(`agent-harness.ts:695-728`)。

### 7.3 prepareCompaction:准备压缩

`prepareCompaction`(`compaction.ts:541-606`) 分析 session 路径,确定要压缩哪段历史:

1. **找到上一个 compaction entry**(`prevCompactionIndex`):确定本次压缩的起始边界
2. **估算当前 token 数**:调用 `estimateContextTokens`
3. **调用 findCutPoint**:确定保留边界

`findCutPoint`(`compaction.ts:327-376`) 从末尾往前累计 token 数,找到第一个使"已累计 token >= keepRecentTokens"的位置,然后选择该位置之后的第一个合法切割点:

```
entries: [e0, e1, e2, ..., e_cut, ..., e_last]
                              ^
                              firstKeptEntryIndex
              |<-- 摘要 -->|  |<-- 保留 -->|
```

合法切割点(`findValidCutPoints`)只在以下 entry 类型处切割:
- `message` 角色为 `user`、`assistant`、`bashExecution`、`custom`、`branchSummary`、`compactionSummary`
- `branch_summary` entry
- `custom_message` entry

**注意**:`toolResult` 消息不是合法切割点,因为孤立的 toolResult(没有对应 assistant 消息)会导致 LLM 解析历史时出错。切割点回退逻辑确保不在 toolResult 前切割。

**split turn 处理**:如果切割点落在某个 turn 的中间(既不是 user 消息开头,也不在 turn 起始位置),则识别该 turn 的起始索引(`findTurnStartIndex`),对该 turn 的前半部分单独生成一份"turn prefix summary",后半部分保留。这保证了不会把一个 turn 的"前半段工作"和"后半段结果"割裂。

### 7.4 compact:执行压缩

`compact`(`compaction.ts:626-705`)根据 `CompactionPreparation` 调用 LLM 生成摘要:

**正常情况**(非 split turn):

```typescript
const summaryResult = await generateSummary(
  messagesToSummarize,  // 要被摘要替换的消息
  model,
  settings.reserveTokens,
  apiKey,
  headers,
  signal,
  customInstructions,   // 可选的自定义关注点
  previousSummary,      // 上一次摘要(用于迭代更新)
  thinkingLevel,
);
```

**split turn 情况**:并行生成两个摘要,然后合并:

```typescript
const [historyResult, turnPrefixResult] = await Promise.all([
  generateSummary(messagesToSummarize, ...),         // 历史摘要
  generateTurnPrefixSummary(turnPrefixMessages, ...) // turn 前缀摘要
]);
summary = `${historyResult.value}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.value}`;
```

压缩结果还附加文件操作列表(`formatFileOperations`):

```
<read-files>
src/index.ts
src/utils.ts
</read-files>

<modified-files>
src/index.ts
</modified-files>
```

这些信息来自对摘要消息中的 `read`、`write`、`edit` 工具调用的提取(`compaction/utils.ts:24-51`)。

### 7.5 generateSummary:LLM 摘要 prompt

`generateSummary`(`compaction.ts:454-518`) 使用 `completeSimple`(非 streaming 单次调用)。Prompt 结构:

```
<conversation>
[User]: 用户消息文本
[Assistant thinking]: 思考块(如果有)
[Assistant]: 助理回复文本
[Assistant tool calls]: read(path="src/index.ts"); edit(path="src/index.ts", ...)
[Tool result]: 工具返回内容(超过 2000 字符截断)
...
</conversation>

[SUMMARIZATION_PROMPT 或 UPDATE_SUMMARIZATION_PROMPT]
```

生成的摘要格式固定,包含以下段落:
- `## Goal`:用户目标
- `## Constraints & Preferences`:约束和偏好
- `## Progress`(Done / In Progress / Blocked)
- `## Key Decisions`
- `## Next Steps`
- `## Critical Context`

**迭代摘要**:如果 `previousSummary` 非空,使用 `UPDATE_SUMMARIZATION_PROMPT` 而非 `SUMMARIZATION_PROMPT`。更新 prompt 要求 LLM 在保留既有摘要的基础上合并新消息的信息,避免多次压缩后摘要质量退化。

**maxTokens 计算**:`Math.min(0.8 * reserveTokens, model.maxTokens)`——最多使用 `reserveTokens` 的 80%(默认约 13000 tokens),保留 20% 给其他开销(`compaction.ts:468-470`)。

### 7.6 压缩后的不可逆性

**没有原始消息备份**。压缩操作在 Session 存储层面是"追加一个 CompactionEntry",原始消息 entry 仍然在 JSONL 文件中(append-only 格式不删除),但 `buildSessionContext` 会忽略 `firstKeptEntryId` 之前的消息,只使用 compaction 摘要替代。

这是有意为之的设计:
- 文件不变大(技术上原始行仍存在),但从消息历史视角来看不可见
- 需要回溯原始历史的场景可以通过解析 JSONL 原始文件实现(pi 不提供这个 API)
- 如果用户通过 `navigateTree` 跳转到压缩点之前的历史节点,`getPathToRoot` 会返回包含压缩前消息的路径,`buildSessionContext` 会正常重建(此时路径中没有对应的 compaction entry)

因此,对于当前活跃分支的用户来说,compaction 是不可逆的。对于 JSONL 文件的原始数据来说,历史记录是完整保留的。

---

## 8 端到端流程图

以下流程图展示一条新用户消息从进入到触发 compaction 的完整路径:

<svg viewBox="0 0 760 900" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="End-to-end flow: user input through AgentHarness, agent loop, JSONL persistence, to compaction">
  <defs>
    <marker id="ar62" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="220" y="10" width="320" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="31" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">用户输入 "请帮我重构代码"</text>
  <line x1="380" y1="42" x2="380" y2="62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <rect x="160" y="62" width="440" height="80" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="80" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">AgentHarness.prompt(text)</text>
  <text x="180" y="96" font-size="10" fill="#64748b">phase: idle → turn</text>
  <text x="180" y="110" font-size="10" fill="#64748b">createTurnState() → session.buildContext() → renderSystemPrompt()</text>
  <text x="180" y="124" font-size="10" fill="#94a3b8">  ← session.getBranch() + buildSessionContext() 重建 AgentMessage[]</text>
  <line x1="380" y1="142" x2="380" y2="162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <rect x="160" y="162" width="440" height="50" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="182" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">executeTurn(turnState, text)</text>
  <text x="180" y="200" font-size="10" fill="#64748b">createUserMessage(text)  |  emitHook("before_agent_start")</text>
  <line x1="380" y1="212" x2="380" y2="232" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <rect x="100" y="232" width="560" height="190" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="252" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">runAgentLoop(messages, context, loopConfig, ...)</text>
  <text x="120" y="272" font-size="10" fill="#64748b">emit agent_start / turn_start / message_start/end [user]</text>
  <text x="120" y="288" font-size="10" fill="#64748b">streamAssistantResponse() ← LLM API 调用</text>
  <text x="120" y="304" font-size="10" fill="#64748b">emit message_start / message_update×N [streaming] / message_end</text>
  <rect x="120" y="312" width="520" height="22" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="380" y="328" text-anchor="middle" font-size="10" font-weight="600" fill="#7c3aed">handleAgentEvent("message_end") → session.appendMessage(assistantMsg) ← 写入 JSONL</text>
  <text x="120" y="352" font-size="10" fill="#64748b">executeToolCalls() → tool.execute() → createToolResultMessage()</text>
  <text x="120" y="368" font-size="10" fill="#64748b">emit tool_execution_start / end / message_start/end [toolResult]</text>
  <rect x="120" y="376" width="520" height="22" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="380" y="392" text-anchor="middle" font-size="10" font-weight="600" fill="#7c3aed">handleAgentEvent("message_end") → session.appendMessage(toolResultMsg) ← 写入 JSONL</text>
  <text x="120" y="416" font-size="10" fill="#64748b">emit turn_end → handleAgentEvent("turn_end")</text>
  <line x1="380" y1="422" x2="380" y2="442" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <rect x="160" y="442" width="440" height="60" rx="6" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="380" y="462" text-anchor="middle" font-size="12" font-weight="700" fill="#0ea5e9">turn 结束 / prepareNextTurn</text>
  <text x="180" y="480" font-size="10" fill="#64748b">flushPendingSessionWrites() ← 写入模型切换等  |  emit "save_point"</text>
  <text x="180" y="494" font-size="10" fill="#64748b">loopConfig.prepareNextTurn() → createTurnState() ← 重建 context</text>
  <line x1="380" y1="502" x2="380" y2="522" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <rect x="160" y="522" width="440" height="50" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="542" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">agent_end</text>
  <text x="180" y="560" font-size="10" fill="#64748b">phase: turn → idle  |  emit "settled"</text>
  <line x1="380" y1="572" x2="380" y2="592" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <rect x="100" y="592" width="560" height="90" rx="6" fill="#f1f5f9" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="612" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">AgentHarness.compact()  (外层调用, phase=idle)</text>
  <text x="120" y="630" font-size="10" fill="#64748b">prepareCompaction(entries, settings)</text>
  <text x="120" y="644" font-size="10" fill="#64748b">  estimateContextTokens() / findCutPoint() ← 确定保留边界</text>
  <text x="120" y="658" font-size="10" fill="#64748b">  提取 messagesToSummarize + fileOps</text>
  <text x="120" y="672" font-size="10" fill="#94a3b8">  emitHook("session_before_compact") ← 应用层可取消/提供自定义摘要</text>
  <line x1="380" y1="682" x2="380" y2="702" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <rect x="160" y="702" width="440" height="60" rx="6" fill="#f1f5f9" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="722" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">compact(preparation, model, apiKey, ...)</text>
  <text x="180" y="740" font-size="10" fill="#64748b">generateSummary() ← LLM 调用 / formatFileOperations()</text>
  <text x="180" y="754" font-size="10" fill="#94a3b8">→ 返回结构化 Markdown 摘要</text>
  <line x1="380" y1="762" x2="380" y2="782" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <rect x="100" y="782" width="560" height="42" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="800" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">session.appendCompaction(summary, firstKeptEntryId, ...)</text>
  <text x="380" y="816" text-anchor="middle" font-size="10" fill="#64748b">追加 CompactionEntry 到 JSONL  |  storage.setLeafId(newLeafId)</text>
  <line x1="380" y1="824" x2="380" y2="844" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <rect x="220" y="844" width="320" height="44" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="862" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">下次 buildContext() 时</text>
  <text x="380" y="878" text-anchor="middle" font-size="10" fill="#64748b">摘要替代旧消息 | 只保留 firstKeptEntryId 之后的历史</text>
</svg>
<span class="figure-caption">图 R6.2 ｜ 端到端流程——用户输入经 AgentHarness / agent-loop / JSONL 持久化到 compaction 全链路</span>

<details>
<summary>ASCII 原版</summary>

```
用户输入 "请帮我重构代码"
        │
        v
AgentHarness.prompt(text)
        │ phase: idle → turn
        │ createTurnState()
        │   session.buildContext()
        │     session.getBranch()        ← getPathToRoot(leafId)
        │     buildSessionContext(entries)
        │       ← 重建 AgentMessage[]
        │   renderSystemPrompt()
        │
        v
executeTurn(turnState, text)
        │
        │  createUserMessage(text)
        │  emitHook("before_agent_start")
        │
        v
runAgentLoop(messages, context, loopConfig, ...)
        │
        │  emit agent_start
        │  emit turn_start
        │  emit message_start/end  [user]
        │
        │  streamAssistantResponse()
        │    ← LLM API 调用
        │  emit message_start
        │  emit message_update * N  [streaming]
        │  emit message_end
        │
        ▼  [handleAgentEvent("message_end")]
        │  session.appendMessage(assistantMsg)    ← 写入 JSONL
        │
        │  executeToolCalls()
        │    emit tool_execution_start
        │    tool.execute(...)
        │    emit tool_execution_end
        │    createToolResultMessage()
        │    emit message_start/end  [toolResult]
        │
        ▼  [handleAgentEvent("message_end")]
        │  session.appendMessage(toolResultMsg)   ← 写入 JSONL
        │
        │  emit turn_end
        │
        ▼  [handleAgentEvent("turn_end")]
        │  flushPendingSessionWrites()            ← 写入模型切换等
        │  emit "save_point"
        │
        │  loopConfig.prepareNextTurn()
        │    flushPendingSessionWrites()
        │    createTurnState()                    ← 重建 context
        │
        │  [继续下一 turn 或退出]
        │
        │  emit agent_end
        │  phase: turn → idle
        │  emit "settled"
        │
        v
AgentHarness.compact() (外层调用,phase=idle 时)
        │
        │  session.getBranch()
        │  prepareCompaction(entries, settings)
        │    estimateContextTokens()
        │    findCutPoint()                       ← 确定保留边界
        │    提取 messagesToSummarize
        │    提取 fileOps
        │
        │  emitHook("session_before_compact")     ← 应用层可取消/提供自定义摘要
        │
        v
compact(preparation, model, apiKey, ...)
        │
        │  generateSummary(messagesToSummarize)   ← LLM 调用(completeSimple)
        │    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT
        │    userPrompt: <conversation>...</conversation> + SUMMARIZATION_PROMPT
        │    → 返回结构化 Markdown 摘要
        │
        │  formatFileOperations(readFiles, modifiedFiles)
        │  summary += <read-files>...</read-files>
        │
        v
session.appendCompaction(summary, firstKeptEntryId, tokensBefore, details)
        │  ← 追加 CompactionEntry 到 JSONL
        │  ← session.storage.setLeafId(newLeafId) [更新 leaf]
        │
        v
emit "session_compact"
        │
        v
下次 buildContext() 时:
        buildSessionContext(pathEntries)
          ← 找到 compaction entry
          ← 摘要作为第一条 compactionSummary 消息
          ← 只保留 firstKeptEntryId 之后的历史
          ← 之前的消息被摘要替代
```

</details>

---

## 附录:关键类型速查

| 类型 | 定义位置 | 用途 |
|------|----------|------|
| `SessionStorage<T>` | `harness/types.ts:433` | 存储后端接口 |
| `SessionRepo<T>` | `harness/types.ts:461` | 仓库接口(CRUD+fork) |
| `SessionTreeEntry` | `harness/types.ts:404` | 所有 entry 的联合类型 |
| `SessionContext` | `harness/types.ts:416` | buildSessionContext 返回值 |
| `Session<T>` | `harness/session/session.ts:78` | 高层 session 操作封装 |
| `AgentHarness<T>` | `harness/agent-harness.ts:164` | 高层 agent API |
| `AgentHarnessEvent` | `harness/types.ts:641` | AgentEvent + harness 自有事件 |
| `CompactionSettings` | `harness/compaction/compaction.ts:102` | 压缩阈值配置 |
| `CompactionPreparation` | `harness/compaction/compaction.ts:521` | prepareCompaction 返回值 |
| `CompactionResult` | `harness/compaction/compaction.ts:90` | compact 返回值 |
| `Skill` | `harness/types.ts:46` | 技能定义接口 |
| `JsonlSessionRepo` | `harness/session/jsonl-repo.ts:38` | JSONL 文件仓库实现 |
| `InMemorySessionRepo` | `harness/session/memory-repo.ts:5` | 内存仓库实现(测试) |
