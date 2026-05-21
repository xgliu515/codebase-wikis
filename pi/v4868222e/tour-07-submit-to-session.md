# Tour 步骤 07:回车提交 → AgentSession.prompt 接管

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:CustomEditor 持有完整 prompt 字符串"读一下 README.md 的第一行",光标在末尾,刚从 `TUI.handleInput()` 收到 Enter 键的 `data` 事件。

**下一步起点**:`AgentSession.prompt()` 已被调用,栈帧已进入 `_runAgentPrompt`,UserMessage 已追加到 `agent.state.messages`,但 AgentContext 还没构造,agentLoop 还没启动。UI 上用户消息行已渲染,状态栏显示 "Working..." 加载动画。

---

## 1. 当前情境

此刻进程状态:

- `TUI.focusedComponent` = `CustomEditor`,`Editor.state.lines[0]` = `"读一下 README.md 的第一行"`,cursorCol 在末尾。
- `InteractiveMode.onInputCallback` 持有 `getUserInput()` 返回的 Promise 的 `resolve` 函数——`run()` 主循环正 `await this.getUserInput()` 阻塞在那里。
- `AgentSession._eventListeners` 里有一个 InteractiveMode 注册的监听器(`subscribeToAgent` 于 `init()` 结束时通过 `rebindCurrentSession` 注册)。
- `AgentSession.isStreaming` = false,没有正在进行的 LLM 调用。

用户的 Enter 键到达 stdin。

---

## 2. 问题

本步需要解释两个紧密相关的问题:

1. **Enter 键如何从 `Editor.handleInput` 触发 `onSubmit`**——`matchesKey(data, "tui.input.submit")` 命中之后,`Editor.submitValue()` 做了什么:清空编辑器状态,然后调 `onSubmit(text)`。`onSubmit` 是 `InteractiveMode.setupEditorSubmitHandler()` 设置的闭包。

2. **InteractiveMode 的 submitHandler 和 `run()` 主循环如何协作把 prompt 送达 `AgentSession.prompt()`**——这里有一个 Promise 解链:submit 调 `onInputCallback(text)` → resolve `getUserInput()` 返回的 Promise → `run()` 主循环拿到 text → 调 `session.prompt(text)`。搞清楚这条链上谁是生产者、谁是消费者,以及 UI 更新在哪个时机发生。

---

## 3. 朴素思路

最直接的做法:在 `onSubmit` 回调里直接调 `session.prompt(text)`,不经过任何中间人。

---

## 4. 为什么朴素思路会崩

**异步递归问题**:`onSubmit` 被 `Editor.submitValue()` 同步调用,而 `session.prompt()` 是异步的。如果 `onSubmit` 直接 `await session.prompt()`,它会在 `submitValue()` 返回之后才 resume,但 `submitValue()` 需要在调用 `onSubmit` 之后立即完成(清空编辑器状态已在 `onSubmit` 调用前发生,见 `editor.ts:1192-1198`)。这不是递归死锁问题,但它让 `onSubmit` 承担了不属于它的职责——管理 prompt 生命周期。

**`run()` 主循环是职责边界**:`InteractiveMode.run()` 的主循环(`interactive-mode.ts:780-788`)是唯一负责"等待用户输入 → 调 prompt → 等待完成 → 再等下一次输入"这个顺序的地方。把 `session.prompt()` 放进 `onSubmit` 会破坏这个职责归属,让 submit handler 同时管理 UI 和 agent 生命周期。

**斜杠命令需要提前返回**:`setupEditorSubmitHandler()`(交互模式.ts:2464-2642)里有大量 `if (text === "/settings") { ... return; }` 这样的早期返回。如果 `onSubmit` 直接调 `prompt`,就必须在每个斜杠命令分支里都 `return` 且不调 `prompt`,而正常消息路径才调——等价于两段逻辑合并在一处,可读性很差。现在的做法是:斜杠命令分支直接 return(不触发 `onInputCallback`),`run()` 的 `await getUserInput()` 继续等待下一次普通输入。

---

## 5. pi 的做法

整条链路分四段。

**第一段:Enter 键触发 `Editor.submitValue()`**

`TUI.handleInput()` 把 Enter 的 `data`(如 `"\r"`)路由到 `CustomEditor.handleInput()`,后者调 `super.handleInput(data)` 即 `Editor.handleInput()`。在 `editor.ts:735`:

```typescript
if (kb.matches(data, "tui.input.submit")) {
    // ...
    this.submitValue();
    return;
}
```

`submitValue()`(`editor.ts:1188-1202`):

```typescript
private submitValue(): void {
    this.cancelAutocomplete();
    const result = this.expandPasteMarkers(
        this.state.lines.join("\n")
    ).trim();                       // <- 获取文本并 trim
    this.state = {                  // <- 编辑器状态清空
        lines: [""], cursorLine: 0, cursorCol: 0
    };
    this.pastes.clear();
    this.scrollOffset = 0;
    this.undoStack.clear();
    // ...
    if (this.onSubmit) this.onSubmit(result);  // <- 调 onSubmit
}
```

此时 `Editor.state` 已清空,下一次 `render()` 会输出空的 `> ` 提示符。

**第二段:onSubmit 闭包 → `onInputCallback` → resolve `getUserInput()`**

`setupEditorSubmitHandler()`(`interactive-mode.ts:2464`) 设置了 `defaultEditor.onSubmit` 为一个异步闭包。对于普通消息(不是斜杠命令),执行到:

```typescript
// Normal message submission
this.flushPendingBashComponents();

if (this.onInputCallback) {
    this.onInputCallback(text);      // <- resolve getUserInput() 的 Promise
}
this.editor.addToHistory?.(text);   // <- 把文本加入历史记录
```

`this.onInputCallback` 是 `getUserInput()` 在创建 Promise 时存入的:

```typescript
async getUserInput(): Promise<string> {
    return new Promise((resolve) => {
        this.onInputCallback = (text: string) => {
            this.onInputCallback = undefined;
            resolve(text);           // <- 这里 resolve
        };
    });
}
```

`onInputCallback(text)` 执行后,`run()` 主循环里 `await this.getUserInput()` 解除阻塞,`userInput` = `"读一下 README.md 的第一行"`。

**第三段:`run()` 主循环调 `session.prompt()`**

```typescript
// interactive-mode.ts:780-788
while (true) {
    const userInput = await this.getUserInput();
    try {
        await this.session.prompt(userInput);    // <- 进入 AgentSession
    } catch (error: unknown) {
        const errorMessage = error instanceof Error
            ? error.message : "Unknown error occurred";
        this.showError(errorMessage);
    }
}
```

`session.prompt(userInput)` 调用(`agent-session.ts:961`)按顺序执行:

```
session.prompt("读一下 README.md 的第一行")
  |
  +-- 不是 /命令, expandPromptTemplates = true
  +-- extensionRunner.hasHandlers("input")? -> emit input 事件
  |     无 input handler registered -> currentText 不变
  |
  +-- expandSkillCommand() -> 不是 /skill:*, 原样返回
  +-- expandPromptTemplate() -> 不匹配任何模板, 原样返回
  |
  +-- isStreaming? -> false, 继续
  +-- flushPendingBashMessages()
  |
  +-- model 存在? -> 是
  +-- modelRegistry.hasConfiguredAuth(model)? -> 是 (ANTHROPIC_API_KEY 已设)
  |
  +-- [检查是否需要 compact] -> lastAssistant = undefined (新会话), 跳过
  |
  +-- messages = []
  +-- messages.push({
  |     role: "user",
  |     content: [{ type: "text", text: "读一下 README.md 的第一行" }],
  |     timestamp: Date.now()
  |   })
  |
  +-- _pendingNextTurnMessages = [] -> 跳过
  |
  +-- extensionRunner.emitBeforeAgentStart(...) -> 无 before_agent_start 钩子
  +-- agent.state.systemPrompt = _baseSystemPrompt (重置为 base)
  |
  +-- preflightResult?.(true)
  +-- await _runAgentPrompt(messages)
```

**第四段:`_runAgentPrompt` → `agent.prompt()` 与事件回流**

`_runAgentPrompt(messages)`(`agent-session.ts:917-925`):

```typescript
private async _runAgentPrompt(
    messages: AgentMessage | AgentMessage[]
): Promise<void> {
    try {
        await this.agent.prompt(messages);    // <- 进入 agent-core
        while (await this._handlePostAgentRun()) {
            await this.agent.continue();
        }
    } finally {
        this._flushPendingBashMessages();
    }
}
```

`this.agent.prompt(messages)` 是 agent-core 的入口。在它返回之前,agent-core 会同步调用 `this.agent.subscribe(...)` 注册的回调(即 `_handleAgentEvent`)传递事件。`_handleAgentEvent` 在收到 `message_start`(user role)事件时:

1. 调用 `this._emit(event)` → 通知所有 `_eventListeners`
2. InteractiveMode 的监听器(`subscribeToAgent` 注册)收到事件 → `handleEvent(event)`
3. `handleEvent` 的 `case "message_start"`: `event.message.role === "user"` → `addMessageToChat(event.message)` → 用户消息行追加到 `chatContainer` → `ui.requestRender()`
4. 收到 `agent_start` 事件 → 创建 `Loader`("Working...") → 追加到 `statusContainer` → `ui.requestRender()`

UI 上的变化:编辑器清空(`> ` 空提示符)+ 用户消息行 + "Working..." 动画,全部通过 `requestRender()` 在下一个 `nextTick` 渲染到终端。

完整事件序列 ASCII 图:

```
Enter 键到达 stdin
  |
  v
Editor.handleInput("\r")
  matchesKey(data, "tui.input.submit") = true
  submitValue()
    state = {lines:[""], ...}  <- 编辑器清空
    onSubmit("读一下 README.md 的第一行")
  |
  v
InteractiveMode.setupEditorSubmitHandler 闭包
  text = "读一下 README.md 的第一行"
  [斜杠命令检测: 全部不匹配]
  flushPendingBashComponents()  <- 无 pending bash
  onInputCallback(text)
    onInputCallback = undefined
    resolve("读一下 README.md 的第一行")
  editor.addToHistory(text)
  |
  v (Promise 解链)
run() 主循环: userInput = "读一下 README.md 的第一行"
  await session.prompt(userInput)
    |
    v
AgentSession.prompt()
  [扩展 input 事件: 无 handler]
  [skill/template 展开: 不匹配]
  [streaming 检查: false]
  messages = [{ role:"user", content:[...], timestamp:... }]
  [before_agent_start 扩展钩子: 无]
  await _runAgentPrompt(messages)
    await agent.prompt(messages)
      |                        事件回流:
      |  <-- message_start (user) -- _handleAgentEvent
      |         _emit -> InteractiveMode listener
      |           addMessageToChat(userMsg)
      |           ui.requestRender()
      |  <-- agent_start            _handleAgentEvent
      |         _emit -> InteractiveMode listener
      |           createWorkingLoader()
      |           statusContainer.addChild(loader)
      |           ui.requestRender()
      |
      | [agent-core 开始构建 AgentContext, agentLoop...]
      v (本步结束点: agentLoop 尚未启动)
```

此时 LLM 调用还没有发出。`agent.prompt()` 内部还在构造 AgentContext——这是下一步(tour-08)的内容。

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/tui/src/components/editor.ts` | 735-748 | `kb.matches(data, "tui.input.submit")` → `submitValue()` |
| `packages/tui/src/components/editor.ts` | 1188-1202 | `submitValue()`:清空状态、调 `onSubmit(result)` |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 2464-2642 | `setupEditorSubmitHandler()`:闭包定义,斜杠命令路径 + 普通消息路径 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 2634-2641 | `flushPendingBashComponents()` + `onInputCallback(text)` + `addToHistory` |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 3210-3217 | `getUserInput()`:Promise + `onInputCallback` 模式 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 780-788 | `run()` 主循环:`await getUserInput()` + `await session.prompt()` |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 2645-2648 | `subscribeToAgent()`:注册 `handleEvent` 到 `session._eventListeners` |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 2702-2722 | `handleEvent case "message_start"`:用户消息追加到 `chatContainer` |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 2659-2683 | `handleEvent case "agent_start"`:创建 Working... Loader |
| `packages/coding-agent/src/core/agent-session.ts` | 961-1111 | `AgentSession.prompt()`:扩展钩子、消息构建、`_runAgentPrompt` |
| `packages/coding-agent/src/core/agent-session.ts` | 1054-1065 | `messages.push({ role:"user", content, timestamp })` |
| `packages/coding-agent/src/core/agent-session.ts` | 917-925 | `_runAgentPrompt()`:调 `agent.prompt()` + `_handlePostAgentRun` 循环 |
| `packages/coding-agent/src/core/agent-session.ts` | 450-453 | `_emit()`:遍历 `_eventListeners` 同步通知 |
| `packages/coding-agent/src/core/agent-session.ts` | 468-538 | `_handleAgentEvent`:内部 agent 事件处理 + 转发给外部 listeners |
| `packages/coding-agent/src/core/agent-session.ts` | 672-682 | `subscribe()`:注册外部 listener,返回 unsubscribe 函数 |

---

## 7. 分支与延伸

- **InteractiveMode 完整用户输入路径(包含斜杠命令和 bash 模式分支)**:见 [第 12 章 §12.5「用户输入路径」](./12-interactive-mode.md#125-用户输入路径)。
- **`AgentSession` 事件订阅模型与双层事件链(agent → AgentSession → InteractiveMode)**:见 [第 12 章 §12.4「AgentSession 事件订阅」](./12-interactive-mode.md#124-agentsession-事件订阅)。
- **AgentHarness 与 `agent.prompt()` 内部结构(AgentContext 构造、agentLoop 启动)**:见 [第 06 章 §4「AgentHarness」](./06-agent-runtime-sessions-compaction.md#4-agentharness)。
- **`before_agent_start` 扩展钩子的完整语义**:见 [第 12 章 §12.4「AgentSession 事件订阅」](./12-interactive-mode.md#124-agentsession-事件订阅)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **`getUserInput()` 的 Promise 模式是 TUI 事件驱动与 async/await 主循环之间的桥梁**:`onInputCallback` 把 Promise 的 `resolve` 函数存为实例变量,让同步的 `onSubmit` 回调能够解除一个 async 等待。这是 Node.js 单线程中"把回调世界桥接到 Promise 世界"的标准手法。

2. **`submitValue()` 在调 `onSubmit` 之前就已经清空了编辑器状态**:这意味着 `onSubmit` 回调被调用时,编辑器 UI 已经恢复到空白状态。下一个 `requestRender()` 会立即把空编辑器画到屏幕——用户能看到输入框被清空,这发生在 agent 开始处理之前。

3. **事件回流是同步的,但 UI 刷新是异步的**:`_emit()` 遍历 `_eventListeners` 是同步调用,`InteractiveMode.handleEvent` 也同步执行。但 `addMessageToChat` 只是把组件加入容器的 `children` 数组;`ui.requestRender()` 通过 `process.nextTick` 调度,屏幕更新在当前调用栈退出后才发生。所以"用户消息行出现在屏幕"这个视觉效果,实际上在 `agent.prompt()` 调用栈之外的下一个微任务里完成。

4. **`session.prompt()` 的职责不包括启动 LLM 调用**:它的边界是把用户文本包装成 `UserMessage`、做扩展 hook 的 preflight、验证 model 和 API key,然后调 `_runAgentPrompt(messages)`。真正的 LLM 调用在 `agent.prompt(messages)` 内部的 agentLoop 里发生——那是下一步的领域。

5. **斜杠命令是 `setupEditorSubmitHandler` 的一等公民**:任何 `/` 开头的文本都在 `onSubmit` 闭包里被分流处理——要么走内置命令分支(直接操作 TUI 状态,不调 `onInputCallback`),要么走扩展命令路径(在 `session.prompt` 里由 `_tryExecuteExtensionCommand` 处理)。两者都不会把 `/xxx` 文本当普通消息送给 LLM——`run()` 的主循环对此完全透明。
