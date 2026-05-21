# Tour 步骤 05:进入 InteractiveMode + 初始化 TUI

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:AgentSession 已建,session 文件落盘且仅有 system message,AgentSessionRuntime 单例就绪。终端仍在普通(cooked)模式,没有任何 UI 在渲染。

**下一步起点**:TUI 在 raw mode 渲染中,焦点在 CustomEditor,stdin 监听器已挂,event loop 等待键盘事件;AgentSession.messages 还是 `[system]`。

---

## 1. 当前情境

`main.ts` 中 `appMode = "interactive"` 分支已确定,`AgentSessionRuntime` 工厂刚刚完成。此刻进程状态:

- `process.stdin.isRaw` 为 `false`——Node.js 默认的 cooked 模式,内核缓冲行输入,回车才送达进程。
- `process.stdout` 还没有任何 TUI 内容。
- `AgentSessionRuntime` 持有 `AgentSession`、`Agent`、`SessionManager`、`SettingsManager` 的引用。
- 代码执行位置:准备调用 `new InteractiveMode(runtime, options).run()`(`packages/coding-agent/src/main.ts`)。

---

## 2. 问题

本步需要回答三个紧密相关的具体问题:

1. **`InteractiveMode` 构造函数里做了什么**——哪些对象是在构造期建立的,哪些推迟到 `init()` 里?
2. **TUI 如何从"什么都没有"变成"一个可以接收键盘输入的活跃 UI"**——`TUI.start()` 、`ProcessTerminal.start()`、raw mode 这三者之间的因果链是什么?
3. **组件树是怎么组装起来的**——`headerContainer`、`chatContainer`、`editorContainer`、`footer` 这些组件按什么顺序挂到 `TUI`?

---

## 3. 朴素思路

最直接的做法:在一个函数里顺序执行——`process.stdin.setRawMode(true)` → 建组件 → 渲染循环。所有东西写在同一个 `start()` 里。

---

## 4. 为什么朴素思路会崩

**副作用时序**:`process.stdin.setRawMode(true)` 一旦执行,任何后续的 `console.log` 都会被 raw 模式影响,字符不再自动回显。如果扩展初始化(extension `session_start` 事件)在 raw mode 之前还没完成,它们向 stdout 写的文本会破坏终端状态。

**扩展需要交互对话**:`interactive-mode.ts:673` 处注释明确写道:"Start the UI before initializing extensions so session_start handlers can use interactive dialogs"。扩展的 `session_start` 可能弹出 OAuth 选择框或警告对话框,这些都需要 TUI 已经处于 raw mode 并可以渲染 overlay。

**模型/工具加载后才显示**:资源显示(`renderInitialMessages`)必须在扩展加载之后才执行,否则 CLAUDE.md、已加载技能等信息会在扩展注册工具之前就渲染,显示内容不完整。

---

## 5. pi 的做法

pi 用两段式初始化:`constructor` 只建对象引用,`init()` 负责有副作用的操作,两者由 `run()` 串联。

**第一段:`constructor`(359-398 行)**

```
InteractiveMode.constructor(runtimeHost, options)
  |
  +-- this.runtimeHost = runtimeHost
  +-- this.ui = new TUI(new ProcessTerminal(), showHardwareCursor)
  |     ProcessTerminal 此刻只是一个对象,stdin 还未进入 raw mode
  |
  +-- this.headerContainer = new Container()
  +-- this.chatContainer   = new Container()
  +-- this.pendingMessagesContainer = new Container()
  +-- this.statusContainer = new Container()
  +-- this.widgetContainerAbove / Below = new Container()
  |
  +-- this.keybindings = KeybindingsManager.create()
  +-- setKeybindings(this.keybindings)          // 全局注入,tui 组件读此单例
  |
  +-- this.defaultEditor = new CustomEditor(ui, editorTheme, keybindings, opts)
  +-- this.editor = this.defaultEditor
  +-- this.editorContainer = new Container()
  +-- this.editorContainer.addChild(this.editor)
  |
  +-- this.footerDataProvider = new FooterDataProvider(cwd)
  +-- this.footer = new FooterComponent(session, footerDataProvider)
  |
  +-- setRegisteredThemes(...); initTheme(settingsManager.getTheme(), true)
```

此时 stdin 还在 cooked 模式——构造函数内没有任何 I/O 副作用。

**第二段:`init()`(568-697 行)**

`run()` 的第一行就是 `await this.init()`。`init()` 按以下顺序执行:

```
init()
  |
  +-- registerSignalHandlers()        SIGINT/SIGTERM/SIGHUP
  +-- ensureTool("fd"), ensureTool("rg")  并行下载缺失工具(若需要)
  |
  +-- [构建 header 组件]
  |     ExpandableText(logo + 快捷键提示)
  |
  +-- ui.addChild(headerContainer)
  +-- ui.addChild(chatContainer)
  +-- ui.addChild(pendingMessagesContainer)
  +-- ui.addChild(statusContainer)
  +-- ui.addChild(widgetContainerAbove)
  +-- ui.addChild(editorContainer)   <- CustomEditor 在这里
  +-- ui.addChild(widgetContainerBelow)
  +-- ui.addChild(footer)
  |
  +-- ui.setFocus(this.editor)       <- 焦点给 CustomEditor
  +-- setupKeyHandlers()             <- Ctrl+C/D/Z 等 app 级快捷键
  +-- setupEditorSubmitHandler()     <- onSubmit 回调注册
  |
  +-- ui.start()                     <- [关键] 此刻 stdin 进入 raw mode
  +-- isInitialized = true
  |
  +-- await rebindCurrentSession()   <- 扩展初始化(可弹对话框)
  +-- renderInitialMessages()        <- 渲染历史消息
```

**`ui.start()` 内部的 raw mode 切换链**(`packages/tui/src/tui.ts:441-450`):

```
TUI.start()
  |
  +-- terminal.start(onInput, onResize)    <- ProcessTerminal.start()
  |     |
  |     +-- process.stdin.setRawMode(true)    [raw mode 激活]
  |     +-- process.stdin.setEncoding("utf8")
  |     +-- process.stdin.resume()
  |     +-- process.stdout.write("\x1b[?2004h")  [bracketed paste 开启]
  |     +-- process.stdout.on("resize", resizeHandler)
  |     +-- queryAndEnableKittyProtocol()
  |           |
  |           +-- setupStdinBuffer()         <- StdinBuffer 实例化
  |           +-- process.stdin.on("data", stdinDataHandler)
  |           +-- process.stdout.write("\x1b[?u")  [探测 Kitty 协议]
  |
  +-- terminal.hideCursor()               <- \x1b[?25l 隐藏光标
  +-- queryCellSize()                     <- \x1b[16t 查询像素尺寸
  +-- requestRender()                     <- 触发首次渲染
```

首次 `requestRender()` 通过 `process.nextTick` 调度 `doRender()`。`doRender()` 遍历组件树调用每个子组件的 `render(width)`,输出为字符串数组,再逐行与 `previousLines` 差分比较,只写变化行到 `process.stdout`。

**组件树(初始化完成后)**:

```
TUI (Container)
 +-- headerContainer (Container)
 |     +-- Spacer(1)
 |     +-- ExpandableText (logo + 快捷键提示)
 |     +-- Spacer(1)
 +-- chatContainer (Container)          [空,等待消息]
 +-- pendingMessagesContainer (Container) [空]
 +-- statusContainer (Container)        [空]
 +-- widgetContainerAbove (Container)   [默认 Spacer]
 +-- editorContainer (Container)
 |     +-- CustomEditor [焦点在此]
 +-- widgetContainerBelow (Container)   [默认 Spacer]
 +-- FooterComponent
```

用户看到:logo 行 + 快捷键提示行 + 空白聊天区 + `> ` 输入提示符(光标闪烁由终端自身 IME cursor 完成,TUI 用 `\x1b[?25l` 隐藏了硬件光标,而 CustomEditor render 输出用反色 `\x1b[7m` 模拟软光标)。

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 359-398 | `constructor`:对象建立,无 I/O 副作用 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 369 | `new TUI(new ProcessTerminal(), ...)` |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 568-697 | `init()`:信号注册、组件树挂载、`ui.start()`、扩展初始化 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 660-668 | `ui.addChild` 链 + `ui.setFocus` |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 674 | `ui.start()` 调用位置 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 716-789 | `run()`:调 `init()` + 启动 interactive loop |
| `packages/tui/src/tui.ts` | 239-279 | `TUI` 类构造函数,`focusedComponent`、`previousLines` 等核心字段 |
| `packages/tui/src/tui.ts` | 311-326 | `setFocus()`:设置 `focusedComponent`,更新 `Focusable.focused` |
| `packages/tui/src/tui.ts` | 441-450 | `TUI.start()`:调 `terminal.start()`、`hideCursor()`、`requestRender()` |
| `packages/tui/src/terminal.ts` | 92-126 | `ProcessTerminal.start()`:raw mode、bracketed paste、Kitty 探测 |
| `packages/tui/src/terminal.ts` | 136-177 | `setupStdinBuffer()`:挂 StdinBuffer,数据经 StdinBuffer 再转发 |
| `packages/tui/src/terminal.ts` | 193-203 | `queryAndEnableKittyProtocol()`:发 `\x1b[?u`、150ms 后 fallback |

---

## 7. 分支与延伸

- **TUI 差分渲染算法(doRender)的完整细节**:见 [第 10 章 §10.3「TUI 类核心」](./10-tui-renderer.md#103-tui-类核心)。
- **ProcessTerminal raw mode 切换与 stop() 还原**:见 [第 10 章 §10.4「ProcessTerminal:raw mode 与终端控制」](./10-tui-renderer.md#104-processterminal-raw-mode-与终端控制)。
- **Kitty 协议探测与 fallback 到 modifyOtherKeys**:见 [第 10 章 §10.6「Kitty 协议支持」](./10-tui-renderer.md#106-kitty-协议支持)。
- **InteractiveMode 完整顶层结构与 TUI 组件树图示**:见 [第 12 章 §12.2「顶层结构」](./12-interactive-mode.md#122-顶层结构)。
- **扩展 `session_start` 事件与 `rebindCurrentSession`**:见 [第 12 章 §12.4「AgentSession 事件订阅」](./12-interactive-mode.md#124-agentsession-事件订阅)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **`constructor` 和 `init()` 的分工是刻意设计的**:构造函数只建引用,不碰 stdin/stdout;`init()` 才做有副作用的 raw mode 切换。这个分离让扩展的 `session_start` 处理器能安全地弹交互对话框——因为 TUI 已经在 raw mode 里运行了。

2. **`ui.start()` 是单向阀**:调用之后 stdin 进入 raw mode,终端进入 TUI 控制。`start()` 之前,任何写到 stdout 的内容(如 `console.log`)都是正常的行缓冲输出;之后,所有输出都由 TUI 的差分渲染管理。

3. **`setFocus(this.editor)` 是输入路由的核心**:`TUI.handleInput()` 只把收到的字节串转发给 `focusedComponent`。从这一刻起,所有 stdin 字节都会流向 `CustomEditor.handleInput()`——除非 overlay 或 inputListeners 先拦截。

4. **`StdinBuffer` 是在 raw mode 激活的同时开始工作的**:它在 `setupStdinBuffer()` 里被实例化,然后 `process.stdin.on("data", stdinDataHandler)` 挂上监听器。此后每一个 stdin 数据事件都先经过 StdinBuffer 的 escape sequence 状态机,再作为完整序列发给 TUI 的 `handleInput`。

5. **首次渲染是 `requestRender()` 触发的**:它通过 `process.nextTick` 调度,意味着 `ui.start()` 返回时屏幕还没有内容;内容在当前调用栈返回后、下一个微任务执行时才真正写到终端。这就是为什么 `init()` 后面的 `rebindCurrentSession()` 和 `renderInitialMessages()` 能安全地修改组件树——修改完成后,下一个 nextTick 统一渲染。
