# Tour 步骤 08:构造 AgentContext

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:`AgentSession.prompt()` 已被调用,UserMessage 进入 messages 数组,UI 显示 "thinking..."。`AgentHarness.prompt()` 已进入,phase 已设为 `"turn"`,但 agentLoop 还没启动。

**下一步起点**:`AgentContext` 完整,持有 `systemPrompt`、`messages`、`tools`,`AbortController` 已创建并绑定到 `harness.runAbortController`,`runAgentLoop()` 即将被调用但还没进入第一次 stream。

---

## 1. 当前情境

`AgentHarness.prompt()` 在 `packages/agent/src/harness/agent-harness.ts:603` 被调用。此时进程状态如下:

- `this.phase` 已从 `"idle"` 切换为 `"turn"`(`agent-harness.ts:605`)。
- `this.model` 持有已选定的 `Model<"anthropic-messages">` 对象(包含 id、provider、maxTokens、reasoning 等元数据)。
- `this.tools` 是一个 `Map<string, AgentTool>`,存放全部已注册工具。
- `this.activeToolNames` 是允许本次 session 使用的工具名称列表。
- `this.systemPrompt` 是一个回调函数,尚未执行。
- `this.streamOptions` 持有 transport、timeoutMs、headers 等请求参数。
- session 持有历史消息,但 `AgentContext.messages` 还未组装。

这一步需要在实际调用 LLM 之前,把所有分散的状态拼装成一个不可变快照 `AgentContext`。

---

## 2. 问题

本步需要解决三个相互独立但顺序依赖的问题:

1. **模型选择**:用哪个 model 发请求?用户可以通过 `--model` 覆盖默认值,session 内也可以用 `setModel()` 动态切换——这些变化都已经写入 `this.model`,在这里只需读取,不需要重新决策。但 `thinkingLevel` 是否激活 reasoning 同样写在这里,需要同步读取。

2. **工具清单**:发给模型的 `tools[]` 应该包含哪些工具?全局注册的工具可能比本次 session 实际启用的要多,需要从 `this.tools` 中按 `this.activeToolNames` 过滤。

3. **system prompt 渲染**:system prompt 包含动态内容(cwd、git 状态、available skills 列表),必须在每次 turn 开始时重新渲染,而不是缓存旧值。

---

## 3. 朴素思路

最简单的做法:在 `runAgentLoop()` 调用处直接用 `this.*` 字段,不做任何快照,让 loop 内每次读取都拿最新值。

---

## 4. 为什么朴素思路会崩

**并发写入问题**:agentLoop 执行期间,外部调用 `setModel()` 或 `setActiveTools()` 写入 `this.model`、`this.activeToolNames`。如果 loop 内直接读 `this.*`,mid-turn 的写入会影响当前 turn 的工具清单,导致 tool call 时找不到工具。

**system prompt 渲染时机**:system prompt 回调可能是 async 的(需要执行 `git status` 或读取 cwd),如果在 loop 内每次调用都重新渲染,会把 IO 延迟叠加进 stream 的关键路径。正确做法是 turn 开始前渲染一次,然后用快照。

**prepareNextTurn 的刷新需求**:当 agent loop 执行完一轮工具调用准备发起第二次 LLM 请求时,模型可能已通过 hook 切换(`prepareNextTurn` 返回新的 context)。因此需要区分"turn 开始时的快照"和"turn 内可以刷新的能力",`createTurnState()` + 闭包引用解决了这个问题。

---

## 5. pi 的做法

`AgentHarness.prompt()` 调用 `createTurnState()` 生成快照,然后调用 `executeTurn()`,后者组装 `AgentContext` 并启动 loop。

**第一阶段:生成 turn 快照(`createTurnState`)**

```typescript
// packages/agent/src/harness/agent-harness.ts:313-345
private async createTurnState(): Promise<AgentHarnessTurnState<...>> {
    const context = await this.session.buildContext();           // 读取历史消息
    const resources = this.getResources();                      // skills、promptTemplates
    const sessionMetadata = await this.session.getMetadata();
    const tools = [...this.tools.values()];                     // 全量工具
    const activeTools = this.activeToolNames
        .map((name) => this.tools.get(name))
        .filter((tool): tool is TTool => tool !== undefined);   // 过滤为启用工具
    let systemPrompt = "You are a helpful assistant.";
    if (typeof this.systemPrompt === "string") {
        systemPrompt = this.systemPrompt;
    } else if (this.systemPrompt) {
        systemPrompt = await this.systemPrompt({               // async 渲染
            env: this.env, session: this.session,
            model: this.model, thinkingLevel: this.thinkingLevel,
            activeTools, resources,
        });
    }
    return { messages: context.messages, resources, streamOptions: ...,
             sessionId, systemPrompt, model: this.model,
             thinkingLevel: this.thinkingLevel, tools, activeTools };
}
```

`this.activeToolNames` 按顺序映射,缺失的工具名被 `filter` 过滤掉而不报错,这样即使工具注册顺序与 `activeToolNames` 不同也能正常工作(`agent-harness.ts:318-321`)。

**第二阶段:system prompt 渲染**

system prompt 回调由上层 coding-agent 传入,其实现在 `packages/coding-agent/src/` 中。它读取:

- `process.cwd()`:当前工作目录。
- `git status --short`:本地 git 状态(若不在 git repo 内则跳过)。
- `env.platform` / `env.shell`:环境信息。
- `resources.skills`:available skills 块(由 `packages/agent/src/harness/system-prompt.ts:3` 的 `formatSkillsForSystemPrompt()` 格式化为 `<available_skills>` XML 块)。

渲染结果是一个纯字符串,存入 `turnState.systemPrompt`,后续不再执行 IO。

**第三阶段:组装 AgentContext**

```typescript
// packages/agent/src/harness/agent-harness.ts:347-356
private createContext(
    turnState: AgentHarnessTurnState<...>,
    systemPrompt?: string,
): AgentContext {
    return {
        systemPrompt: systemPrompt ?? turnState.systemPrompt,
        messages: turnState.messages.slice(),   // 浅拷贝,防止 loop 内 push 影响 turnState
        tools: turnState.activeTools.slice(),   // 只包含 activeTools
    };
}
```

`AgentContext` 是一个扁平接口(`packages/agent/src/types.ts:387-394`):

```typescript
export interface AgentContext {
    systemPrompt: string;
    messages: AgentMessage[];
    tools?: AgentTool<any>[];
}
```

tools 只有 `activeTools`(已过滤),而不是 `tools`(全量)。这是权限边界:loop 只能看到本次 session 被允许使用的工具。

**第四阶段:创建 AbortController 并启动 loop**

```typescript
// packages/agent/src/harness/agent-harness.ts:552-567
const abortController = new AbortController();
const getTurnState = () => activeTurnState;         // 闭包引用,可被 prepareNextTurn 替换
const setTurnState = (next) => { activeTurnState = next; };
this.runAbortController = abortController;          // 暴露给 abort() 调用
const runResultPromise = (async () => {
    return await runAgentLoop(
        messages,
        this.createContext(turnState, beforeResult?.systemPrompt),
        this.createLoopConfig(getTurnState, setTurnState),
        (event) => this.handleAgentEvent(event, abortController.signal),
        abortController.signal,
        this.createStreamFn(getTurnState),
    );
})();
```

`abortController.signal` 以三种方式注入:直接传给 `runAgentLoop`、通过 `createStreamFn` 传给每次 stream 调用、通过 `handleAgentEvent` 传给事件监听器。任意一处调用 `abort()` 都会透过同一个 signal 传播到所有路径。

**ASCII 流程图**:

```
prompt(text)
  |
  +--> createTurnState()
  |      |
  |      +--> session.buildContext()  -> messages[]
  |      +--> getResources()          -> skills, promptTemplates
  |      +--> filter activeToolNames  -> activeTools[]
  |      +--> systemPrompt callback   -> string (async, 含 git/cwd IO)
  |      -> AgentHarnessTurnState
  |
  +--> executeTurn(turnState, text)
         |
         +--> createUserMessage(text) -> UserMessage
         +--> emitHook("before_agent_start") (可注入额外 messages)
         |
         +--> new AbortController()
         |    this.runAbortController = abortController
         |
         +--> createContext(turnState)
         |    -> AgentContext { systemPrompt, messages, tools: activeTools }
         |
         +--> createLoopConfig(getTurnState, setTurnState)
         +--> createStreamFn(getTurnState)
         |
         +--> runAgentLoop(messages, context, config, emit, signal, streamFn)
              <-- 本步结束,下一步开始
```

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/agent/src/harness/agent-harness.ts` | 313-345 | `createTurnState()`:快照生成,含工具过滤与 system prompt 渲染 |
| `packages/agent/src/harness/agent-harness.ts` | 347-356 | `createContext()`:组装 `AgentContext`,浅拷贝 messages 和 tools |
| `packages/agent/src/harness/agent-harness.ts` | 403-452 | `createLoopConfig()`:构造 `AgentLoopConfig`,含 transformContext、beforeToolCall、afterToolCall 等 hook |
| `packages/agent/src/harness/agent-harness.ts` | 526-600 | `executeTurn()`:AbortController 创建、`runAgentLoop` 调用入口 |
| `packages/agent/src/harness/agent-harness.ts` | 603-616 | `prompt()`:phase 切换、调用 `createTurnState` 和 `executeTurn` |
| `packages/agent/src/harness/system-prompt.ts` | 3-24 | `formatSkillsForSystemPrompt()`:skills 渲染为 XML 块 |
| `packages/agent/src/harness/messages.ts` | 120-164 | `convertToLlm()`:AgentMessage[] 转 Message[]，注入到 `AgentLoopConfig.convertToLlm` |
| `packages/agent/src/types.ts` | 387-394 | `AgentContext` 接口定义 |
| `packages/agent/src/types.ts` | 134-277 | `AgentLoopConfig` 接口:loop 所有可配置 hook 的签名 |

---

## 7. 分支与延伸

- **AgentHarness 完整生命周期与 phase 状态机**:见 [第 06 章 §4.2「AgentHarnessPhase 状态机」](./06-agent-runtime-sessions-compaction.md#42-agentharnesssphase-状态机)。

- **createLoopConfig 桥接 harness 与 loop 的详细 hook 语义**:见 [第 06 章 §4.4「createLoopConfig:桥接 harness 与 agent-loop」](./06-agent-runtime-sessions-compaction.md#44-createloopconfig桥接-harness-与-agent-loop)。

- **system prompt 渲染的完整内容与动态部分**:见 [第 06 章 §5「System Prompt 渲染」](./06-agent-runtime-sessions-compaction.md#5-system-prompt-渲染)。

- **工具注册流程(七大内置工具如何进入 this.tools)**:见 [第 08 章 §8.5「工具注册流程」](./08-coding-agent-tools.md#85-工具注册流程)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **`createTurnState()` 是 turn 的不可变快照起点**:tools 过滤、system prompt 渲染、历史消息读取都在这里完成,loop 内读到的永远是 turn 开始时的状态。`prepareNextTurn` hook 可以用 `setTurnState` 替换 `activeTurnState`,这是 turn 内刷新的唯一合法路径。

2. **`AgentContext.tools` 只有 `activeTools` 而非全量工具**:全量 `this.tools` 在 harness 层面管理,loop 层面只看 `activeTools`。这是权限边界——即使注册了 20 个工具,本次 session 禁用了其中的 5 个,loop 就只能调用剩余 15 个。

3. **AbortController 三路注入**:同一个 `abortController` 的 signal 传入 `runAgentLoop`(控制 loop 生命周期)、`createStreamFn`(控制 HTTP 请求)、`handleAgentEvent`(传给事件监听器)。调用 `harness.abort()` 的唯一效果是 `this.runAbortController.abort()`,这一行触发三路取消。

4. **messages 数组是浅拷贝**:`createContext` 的 `turnState.messages.slice()` 保证了 loop 内的 `push` 操作不会写回 `turnState`。loop 维护自己的 `currentContext.messages`,harness 的 session 通过 `appendMessage` 事件独立持久化,两者不共享同一个引用。
