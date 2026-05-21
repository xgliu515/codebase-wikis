# 第 12 章 交互模式:从输入到输出的完整闭环

> **版本锁定**:本章所有 `file:line` 引用均基于 commit `4868222e`(2026-05-20)。

---

## 12.1 InteractiveMode 想解决的问题

终端 agent 天然面临一个多路复用难题:LLM 响应是流式的、工具执行是异步的、用户随时可能键入新内容,而终端渲染必须在同一帧内完成。这三路输入来自不同的时间轴,必须被统一到一个"下一帧该画什么"的决策里。

`interactive-mode.ts` 存在的核心理由正是承担这个协调角色,它不做业务逻辑(那是 `AgentSession` 的职责),只负责:

1. 将 `AgentSession` 发出的事件流翻译为 TUI 组件的增删改
2. 将用户在键盘上的操作翻译为 `AgentSession.prompt()` 或内建命令调用
3. 在两者之间维持一致的取消、等待、历史、多会话切换状态机

这种设计是经典的 MVC 分层:Model 是 `AgentSession`,View 是 `packages/tui`,Controller 是 `InteractiveMode`。5562 行的体量来自于它要处理的边界情况数量——扩展 UI 挂载、压缩过渡、重试计数器、信号处理、外部编辑器临时接管终端——而不是核心流程本身的复杂度。

---

## 12.2 顶层结构

```
interactive-mode.ts
├── 顶部辅助工具 (1-200)
│   ├── ExpandableText       折叠/展开的文本组件包装
│   ├── isDeadTerminalError  识别 EIO/EPIPE/ENOTCONN
│   └── 若干纯函数           isAnthropicSubscriptionAuthKey 等
│
├── InteractiveModeOptions   (222-235)  构造参数接口
│
├── class InteractiveMode    (237-末)
│   ├── 私有字段             (239-397)
│   │   ├── TUI 层           ui, chatContainer, statusContainer, editorContainer ...
│   │   ├── 流事件跟踪       streamingComponent, streamingMessage, pendingTools
│   │   ├── 功能状态         toolOutputExpanded, hideThinkingBlock, isBashMode
│   │   └── 扩展 UI 状态     extensionSelector, extensionInput, extensionWidgets*
│   │
│   ├── constructor          (359-398)  创建 TUI / 编辑器 / footer / keybindings
│   ├── async init()         (568-697)  注册信号、加载依赖工具、组装 UI 树、启动 TUI
│   ├── async run()          (716-789)  init → 初始消息 → 主循环 while(true)
│   │
│   ├── [Extension System]  (913-2370)  bindCurrentSessionExtensions / createExtensionUIContext
│   ├── [Key Handlers]      (2376-3511) setupKeyHandlers / setupEditorSubmitHandler
│   ├── [UI Helpers]        (3569-末)   showStatus / showError / addMessageToChat / renderSessionContext
│   └── stop()              TUI 终止
```

---

## 12.3 TUI 组件树

`init()` 在 `ui.start()` 之前按以下顺序将组件挂入 `TUI` 的根容器:

<svg viewBox="0 0 880 440" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="TUI 组件树结构图">
  <defs>
    <marker id="ar121" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">TUI 组件树（ProcessTerminal）</text>
  <rect x="330" y="32" width="220" height="28" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="440" y="51" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">TUI (ProcessTerminal)</text>
  <line x1="440" y1="60" x2="440" y2="72" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="120" y1="72" x2="760" y2="72" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="120" y1="72" x2="120" y2="84" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar121)"/>
  <line x1="300" y1="72" x2="300" y2="84" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar121)"/>
  <line x1="440" y1="72" x2="440" y2="84" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar121)"/>
  <line x1="580" y1="72" x2="580" y2="84" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar121)"/>
  <line x1="720" y1="72" x2="720" y2="84" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar121)"/>
  <rect x="30" y="84" width="180" height="28" rx="5" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="120" y="103" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">headerContainer</text>
  <rect x="210" y="84" width="180" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="300" y="103" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">chatContainer</text>
  <rect x="360" y="84" width="160" height="28" rx="5" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="440" y="99" text-anchor="middle" font-size="10" font-weight="600" fill="#0d9488">pendingMessages</text>
  <text x="440" y="111" text-anchor="middle" font-size="10" fill="#64748b">Container</text>
  <rect x="500" y="84" width="160" height="28" rx="5" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="580" y="103" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">statusContainer</text>
  <rect x="640" y="84" width="160" height="28" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="720" y="103" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">editorContainer</text>
  <line x1="120" y1="112" x2="120" y2="124" stroke="#94a3b8" stroke-width="1"/>
  <line x1="60" y1="124" x2="180" y2="124" stroke="#94a3b8" stroke-width="1"/>
  <line x1="60" y1="124" x2="60" y2="136" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar121)"/>
  <line x1="180" y1="124" x2="180" y2="136" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar121)"/>
  <rect x="8" y="136" width="105" height="20" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="60" y="150" text-anchor="middle" font-size="9" fill="#64748b">Spacer / builtInHeader</text>
  <rect x="128" y="136" width="105" height="20" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="180" y="150" text-anchor="middle" font-size="9" fill="#64748b">ExpandableText</text>
  <line x1="300" y1="112" x2="300" y2="124" stroke="#94a3b8" stroke-width="1"/>
  <line x1="210" y1="124" x2="390" y2="124" stroke="#94a3b8" stroke-width="1"/>
  <line x1="210" y1="124" x2="210" y2="136" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar121)"/>
  <line x1="255" y1="124" x2="255" y2="136" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar121)"/>
  <line x1="300" y1="124" x2="300" y2="136" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar121)"/>
  <line x1="345" y1="124" x2="345" y2="136" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar121)"/>
  <line x1="390" y1="124" x2="390" y2="136" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar121)"/>
  <rect x="160" y="136" width="100" height="20" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="210" y="150" text-anchor="middle" font-size="9" fill="#7c3aed">UserMessage</text>
  <rect x="203" y="136" width="104" height="20" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="255" y="150" text-anchor="middle" font-size="9" fill="#7c3aed">SkillInvocation</text>
  <rect x="248" y="136" width="104" height="20" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="300" y="150" text-anchor="middle" font-size="9" fill="#7c3aed">AssistantMsg</text>
  <rect x="293" y="136" width="104" height="20" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="345" y="150" text-anchor="middle" font-size="9" fill="#7c3aed">ToolExecution</text>
  <rect x="338" y="136" width="104" height="20" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="390" y="150" text-anchor="middle" font-size="9" fill="#7c3aed">BashExecution +…</text>
  <line x1="580" y1="112" x2="580" y2="136" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar121)"/>
  <rect x="510" y="136" width="140" height="20" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="580" y="150" text-anchor="middle" font-size="9" fill="#64748b">Loader / CountdownTimer</text>
  <line x1="720" y1="112" x2="720" y2="124" stroke="#94a3b8" stroke-width="1"/>
  <line x1="658" y1="124" x2="782" y2="124" stroke="#94a3b8" stroke-width="1"/>
  <line x1="658" y1="124" x2="658" y2="136" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar121)"/>
  <line x1="720" y1="124" x2="720" y2="136" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar121)"/>
  <line x1="782" y1="124" x2="782" y2="136" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar121)"/>
  <rect x="598" y="136" width="120" height="20" rx="3" fill="#fef3c7" stroke="#ea580c" stroke-width="1"/>
  <text x="658" y="150" text-anchor="middle" font-size="9" fill="#b45309">CustomEditor</text>
  <rect x="658" y="136" width="124" height="20" rx="3" fill="#fef3c7" stroke="#ea580c" stroke-width="1"/>
  <text x="720" y="150" text-anchor="middle" font-size="9" fill="#b45309">ExtensionSelector</text>
  <rect x="720" y="136" width="124" height="20" rx="3" fill="#fef3c7" stroke="#ea580c" stroke-width="1"/>
  <text x="782" y="150" text-anchor="middle" font-size="9" fill="#b45309">ExtensionEditor</text>
  <rect x="8" y="188" width="860" height="30" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="440" y="200" text-anchor="middle" font-size="10" font-weight="600" fill="#64748b">widgetContainerAbove</text>
  <text x="440" y="212" text-anchor="middle" font-size="10" fill="#94a3b8">Container → Text 扩展小组件（编辑器上方，MAX_WIDGET_LINES=10）</text>
  <rect x="8" y="228" width="860" height="30" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="440" y="240" text-anchor="middle" font-size="10" font-weight="600" fill="#64748b">widgetContainerBelow</text>
  <text x="440" y="252" text-anchor="middle" font-size="10" fill="#94a3b8">Container → Text 扩展小组件（编辑器下方）</text>
  <rect x="8" y="268" width="860" height="30" rx="5" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="440" y="280" text-anchor="middle" font-size="11" font-weight="600" fill="#0ea5e9">footer / customFooter</text>
  <text x="440" y="293" text-anchor="middle" font-size="10" fill="#64748b">FooterComponent → 单行：pwd | branch | 模型 | token 统计 | context%</text>
  <text x="8" y="322" font-size="10" fill="#94a3b8">代码位置：init() 组件挂载 interactive-mode.ts:596-668 ｜ 字段声明 interactive-mode.ts:237-398</text>
</svg>
<span class="figure-caption">图 R12.1 ｜ TUI 组件树——init() 构建的完整 UI 层次结构</span>

<details>
<summary>ASCII 原版</summary>

```
TUI (ProcessTerminal)
├── headerContainer
│   ├── Spacer(1)
│   ├── builtInHeader / customHeader    ExpandableText  or  extension-supplied component
│   └── Spacer(1)
├── chatContainer                        对话历史区,动态增删
│   ├── UserMessageComponent             packages/…/components/user-message.ts
│   ├── SkillInvocationMessageComponent  packages/…/components/skill-invocation-message.ts
│   ├── AssistantMessageComponent        packages/…/components/assistant-message.ts
│   ├── ToolExecutionComponent           packages/…/components/tool-execution.ts
│   ├── CompactionSummaryMessageComponent  packages/…/components/compaction-summary-message.ts
│   ├── BranchSummaryMessageComponent    packages/…/components/branch-summary-message.ts
│   ├── BashExecutionComponent           packages/…/components/bash-execution.ts
│   ├── CustomMessageComponent           packages/…/components/custom-message.ts
│   └── Text / Spacer                    状态行、警告、错误
├── pendingMessagesContainer             排队中的 steer/followUp 消息预览
├── statusContainer                      "Working..." / "Auto-compacting..." 动画
│   └── Loader / CountdownTimer
├── widgetContainerAbove                 扩展小组件(编辑器上方)
│   └── Container > Text…               最多 MAX_WIDGET_LINES=10 行
├── editorContainer                      编辑器区,任何时刻只有一个子组件
│   └── CustomEditor / ExtensionSelectorComponent / ExtensionInputComponent / ExtensionEditorComponent
├── widgetContainerBelow                 扩展小组件(编辑器下方)
└── footer / customFooter                FooterComponent
    └── 单行:pwd | branch | 模型 | token 统计 | context%
```

</details>

代码位置:

- `interactive-mode.ts:596-668` — `init()` 中按序调用 `ui.addChild()`
- `interactive-mode.ts:237-398` — 字段声明与构造函数

---

## 12.4 AgentSession 事件订阅

`subscribeToAgent()` 在 `rebindCurrentSession()` 末尾调用,将 `handleEvent` 注册为 `AgentSession.subscribe()` 的回调:

```typescript
// interactive-mode.ts:2645-2649
private subscribeToAgent(): void {
    this.unsubscribe = this.session.subscribe(async (event) => {
        await this.handleEvent(event);
    });
}
```

`handleEvent` 是一个 `switch(event.type)` 语句,覆盖全部 `AgentSessionEvent` 分支:

| 事件类型 | UI 反应 | 代码位置 |
|---|---|---|
| `agent_start` | 清空 `pendingTools`,创建 `Loader` 动画("Working...") | `interactive-mode.ts:2659-2683` |
| `message_start(assistant)` | 创建 `AssistantMessageComponent`,挂入 `chatContainer`,设置 `streamingComponent` | `interactive-mode.ts:2710-2721` |
| `message_update(assistant)` | 调用 `streamingComponent.updateContent()`;按 toolCall 追加 `ToolExecutionComponent` | `interactive-mode.ts:2724-2756` |
| `message_end(assistant)` | 调用 `streamingComponent.updateContent(final)`;若 aborted/error 则在所有 `pendingTools` 上填写错误结果 | `interactive-mode.ts:2759-2796` |
| `tool_execution_start` | 在 `pendingTools` 中查找或新建 `ToolExecutionComponent`,调用 `markExecutionStarted()` | `interactive-mode.ts:2798-2819` |
| `tool_execution_update` | `component.updateResult(partial, true)` 实时刷新输出 | `interactive-mode.ts:2822-2828` |
| `tool_execution_end` | `component.updateResult(final)`,从 `pendingTools` 删除 | `interactive-mode.ts:2831-2839` |
| `agent_end` | 停止 `Loader`,清空 `pendingTools`,检查是否有 shutdown 请求 | `interactive-mode.ts:2841-2860` |
| `compaction_start` | 替换 ESC 键处理为 "取消压缩",启动 `autoCompactionLoader` | `interactive-mode.ts:2862-2886` |
| `compaction_end` | 恢复 ESC,重建 chat,追加压缩摘要组件,刷新 compactionQueue | `interactive-mode.ts:2888-2929` |
| `auto_retry_start` | 显示 `CountdownTimer` + `Loader`,ESC 改为 abort retry | `interactive-mode.ts:2931-2961` |
| `auto_retry_end` | 恢复 ESC,停止计时,失败时调用 `showError` | `interactive-mode.ts:2963-2985` |
| `queue_update` | 重绘 `pendingMessagesContainer` | `interactive-mode.ts:2686-2689` |
| `session_info_changed` | 更新终端标题 | `interactive-mode.ts:2691-2695` |

每个分支最后都调用 `this.ui.requestRender()` 通知 TUI 在下一帧重绘。

**三个代表性处理函数的细节:**

**`message_start` 创建流式组件:**

```typescript
// interactive-mode.ts:2710-2721
} else if (event.message.role === "assistant") {
    this.streamingComponent = new AssistantMessageComponent(
        undefined,
        this.hideThinkingBlock,
        this.getMarkdownThemeWithSettings(),
        this.hiddenThinkingLabel,
    );
    this.streamingMessage = event.message;
    this.chatContainer.addChild(this.streamingComponent);
    this.streamingComponent.updateContent(this.streamingMessage);
    this.ui.requestRender();
}
```

注意 `AssistantMessageComponent` 在 `message_start` 时以 `undefined` 消息初始化,代表"正在流入",每次 `message_update` 再调用 `updateContent` 刷新内容。这样 TUI 可以在第一个 token 抵达之前就预留出组件占位。

**`tool_execution_start` 的懒创建:**

```typescript
// interactive-mode.ts:2798-2818
case "tool_execution_start": {
    let component = this.pendingTools.get(event.toolCallId);
    if (!component) {
        component = new ToolExecutionComponent(
            event.toolName, event.toolCallId, event.args, ...
        );
        component.setExpanded(this.toolOutputExpanded);
        this.chatContainer.addChild(component);
        this.pendingTools.set(event.toolCallId, component);
    }
    component.markExecutionStarted();
    ...
}
```

`pendingTools` 是 `Map<string, ToolExecutionComponent>`,在 `message_update` 中也可能创建同一个工具的组件(因为 toolCall 先出现在 streaming assistant message 里),所以 `tool_execution_start` 做了 "如果已存在就不重建" 的保护。

**`compaction_end` 重建 chat:**

```typescript
// interactive-mode.ts:2905-2918
} else if (event.result) {
    this.chatContainer.clear();
    this.rebuildChatFromMessages();
    this.addMessageToChat(
        createCompactionSummaryMessage(
            event.result.summary,
            event.result.tokensBefore,
            new Date().toISOString(),
        ),
    );
    this.footer.invalidate();
}
```

压缩结束后整个 chat 历史需要重建,因为旧消息已被 summary 替换。`rebuildChatFromMessages()` 从 `sessionManager.buildSessionContext()` 重新构造消息列表再渲染。

---

## 12.5 用户输入路径

用户按下回车的完整调用链:

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="用户输入路径：从 stdin 到 session.prompt 的完整调用链">
  <defs>
    <marker id="ar122" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">用户输入路径</text>
  <rect x="220" y="30" width="320" height="28" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="49" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">ProcessTerminal（raw stdin）</text>
  <line x1="380" y1="58" x2="380" y2="76" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar122)"/>
  <text x="392" y="72" font-size="10" fill="#94a3b8">TUI.addInputListener</text>
  <rect x="220" y="78" width="320" height="28" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="93" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">CustomEditor.handleInput(data)</text>
  <text x="380" y="104" text-anchor="middle" font-size="9" fill="#64748b">packages/tui — 按键解码 / 光标移动 / history</text>
  <line x1="380" y1="106" x2="380" y2="124" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar122)"/>
  <rect x="220" y="126" width="320" height="28" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="141" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">defaultEditor.onSubmit(text)</text>
  <text x="380" y="152" text-anchor="middle" font-size="9" fill="#64748b">interactive-mode.ts:2464 — setupEditorSubmitHandler</text>
  <line x1="380" y1="154" x2="380" y2="172" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="100" y1="172" x2="660" y2="172" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="100" y1="172" x2="100" y2="184" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar122)"/>
  <line x1="270" y1="172" x2="270" y2="184" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar122)"/>
  <line x1="490" y1="172" x2="490" y2="184" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar122)"/>
  <line x1="660" y1="172" x2="660" y2="184" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar122)"/>
  <rect x="20" y="184" width="160" height="36" rx="5" fill="#f1f5f9" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="100" y="199" text-anchor="middle" font-size="10" font-weight="600" fill="#7c3aed">内建命令分派</text>
  <text x="100" y="211" text-anchor="middle" font-size="9" fill="#64748b">/settings /model …</text>
  <text x="100" y="221" text-anchor="middle" font-size="9" fill="#94a3b8">:2470-2591</text>
  <rect x="190" y="184" width="160" height="36" rx="5" fill="#f1f5f9" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="270" y="199" text-anchor="middle" font-size="10" font-weight="600" fill="#7c3aed">! bash 命令</text>
  <text x="270" y="213" text-anchor="middle" font-size="9" fill="#64748b">handleBashCommand()</text>
  <rect x="410" y="184" width="160" height="36" rx="5" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="490" y="199" text-anchor="middle" font-size="10" font-weight="600" fill="#0ea5e9">流式中提交</text>
  <text x="490" y="211" text-anchor="middle" font-size="9" fill="#64748b">prompt(steer)</text>
  <rect x="580" y="184" width="160" height="36" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="660" y="199" text-anchor="middle" font-size="10" font-weight="600" fill="#ea580c">普通提交</text>
  <text x="660" y="211" text-anchor="middle" font-size="9" fill="#64748b">onInputCallback(text)</text>
  <text x="660" y="221" text-anchor="middle" font-size="9" fill="#94a3b8">:2638-2641</text>
  <line x1="660" y1="220" x2="660" y2="238" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar122)"/>
  <rect x="540" y="240" width="240" height="28" rx="5" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="660" y="255" text-anchor="middle" font-size="10" font-weight="600" fill="#0d9488">run() 中 getUserInput() 返回</text>
  <text x="660" y="265" text-anchor="middle" font-size="9" fill="#64748b">await Promise resolve</text>
  <line x1="660" y1="268" x2="660" y2="286" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar122)"/>
  <rect x="540" y="288" width="240" height="28" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="660" y="303" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">session.prompt(userInput)</text>
  <text x="660" y="314" text-anchor="middle" font-size="9" fill="#64748b">agent-session.ts:961</text>
</svg>
<span class="figure-caption">图 R12.2 ｜ 用户输入路径——从 raw stdin 经 CustomEditor 到 AgentSession.prompt() 的完整调用链</span>

<details>
<summary>ASCII 原版</summary>

```
ProcessTerminal (raw stdin)
  |
  v  TUI.addInputListener / terminal 事件
  |
  v  CustomEditor.handleInput(data)       packages/tui/src/components/
  |  (内置按键解码、光标移动、history 等)
  |
  v  defaultEditor.onSubmit(text)         interactive-mode.ts:2464
  |  setupEditorSubmitHandler 中注册
  |
  ├─ 内建命令分派  (/settings /model /export ... /quit)
  |  interactive-mode.ts:2470-2591
  |
  ├─ ! bash 命令  handleBashCommand()
  |
  ├─ 流式中提交 → session.prompt(text, {streamingBehavior:"steer"})
  |
  └─ 普通提交 → onInputCallback(text)     interactive-mode.ts:2638-2641
               |
               v  run() 中 await getUserInput() 返回
               |
               v  session.prompt(userInput) agent-session.ts:961
```

</details>

`getUserInput()` 是一个裸 Promise,在 `run()` 的 `while(true)` 循环里 `await`,等待 `onInputCallback` 被 `onSubmit` 触发:

```typescript
// interactive-mode.ts:3210-3216
async getUserInput(): Promise<string> {
    return new Promise((resolve) => {
        this.onInputCallback = (text: string) => {
            this.onInputCallback = undefined;
            resolve(text);
        };
    });
}
```

这意味着 `run()` 本身是一个单线程的 event-loop-friendly 循环,每次 `await session.prompt()` 会阻塞到 agent 完成,期间 TUI 的渲染回调仍在正常触发(因为 Node.js 事件循环未被阻塞)。

---

## 12.6 斜杠命令

内建命令在 `interactive-mode.ts:2464` 的 `setupEditorSubmitHandler` 内部以 `if(text === "/xxx")` 形式逐一分派;同时 `slash-commands.ts` 导出 `BUILTIN_SLASH_COMMANDS` 数组供自动完成使用。

全部内建命令(`packages/coding-agent/src/core/slash-commands.ts:18-40`):

| 命令 | 说明 |
|---|---|
| `/settings` | 打开设置菜单 |
| `/model [搜索词]` | 模型选择器 |
| `/scoped-models` | 管理 Ctrl+P 循环的模型列表 |
| `/export [路径]` | 导出会话(默认 HTML,支持 .jsonl) |
| `/import <路径>` | 从 JSONL 文件恢复会话 |
| `/share` | 分享为 GitHub secret gist |
| `/copy` | 复制最后一条 agent 消息到剪贴板 |
| `/name [名称]` | 设置会话显示名 |
| `/session` | 显示会话统计信息 |
| `/changelog` | 查看更新日志 |
| `/hotkeys` | 显示所有快捷键 |
| `/fork` | 从历史用户消息创建分叉 |
| `/clone` | 克隆当前会话到当前位置 |
| `/tree` | 会话树导航 |
| `/login [provider]` | 配置提供商认证 |
| `/logout [provider]` | 移除提供商认证 |
| `/new` | 新建会话 |
| `/compact [指令]` | 手动压缩上下文 |
| `/resume` | 恢复其他会话 |
| `/reload` | 重载 keybindings/extensions/skills/prompts/themes |
| `/quit` | 退出 pi |

此外还有两个非文档化的隐藏命令:`/arminsayshi` 和 `/dementedelves`。

**扩展命令**通过 `AgentSession._tryExecuteExtensionCommand()` 分派,在 `session.prompt()` 入口处优先处理(`agent-session.ts:969-975`),因此扩展命令在流式进行中也可立即执行。

**技能命令**(`/skill:<name>`)由 `_expandSkillCommand()` 展开为技能文件内容后正常发送给 LLM,代码位置 `agent-session.ts:1147`。

---

## 12.7 键盘快捷键

快捷键系统分两层:

- **TUI 层**:由 `@earendil-works/pi-tui` 的 `TuiKeybindingsManager` 处理光标移动、输入等编辑器级操作
- **App 层**:`KeybindingsManager extends TuiKeybindingsManager`,在 `packages/coding-agent/src/core/keybindings.ts:340-368` 定义

`KEYBINDINGS` 常量(`keybindings.ts:63-202`)包含全部应用级绑定:

| 绑定 ID | 默认键 | 说明 |
|---|---|---|
| `app.interrupt` | `Escape` | 取消/中断 |
| `app.clear` | `Ctrl+C` | 清空编辑器 |
| `app.exit` | `Ctrl+D` | 退出(编辑器为空时) |
| `app.suspend` | `Ctrl+Z` | 挂起到后台 |
| `app.thinking.cycle` | `Shift+Tab` | 循环 thinking level |
| `app.model.cycleForward` | `Ctrl+P` | 切换到下一个模型 |
| `app.model.cycleBackward` | `Shift+Ctrl+P` | 切换到上一个模型 |
| `app.model.select` | `Ctrl+L` | 打开模型选择器 |
| `app.tools.expand` | `Ctrl+O` | 折叠/展开工具输出 |
| `app.thinking.toggle` | `Ctrl+T` | 显示/隐藏 thinking blocks |
| `app.editor.external` | `Ctrl+G` | 打开外部编辑器 |
| `app.message.followUp` | `Alt+Enter` | 排队 follow-up 消息 |
| `app.message.dequeue` | `Alt+Up` | 恢复排队消息到编辑器 |
| `app.clipboard.pasteImage` | `Ctrl+V` (Win) / `Ctrl+V` (Unix) | 粘贴剪贴板图片 |

用户自定义绑定写入 `~/.pi/agent/keybindings.json`。`KeybindingsManager.create()` 在构造时读取该文件,`reload()` 方法在 `/reload` 命令时刷新。旧键名通过 `KEYBINDING_NAME_MIGRATIONS` 表(`keybindings.ts:204-263`)自动迁移。

---

## 12.8 取消机制

ESC 键的行为随上下文变化:

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ESC 键取消机制状态机：根据当前状态分支到不同的取消行为">
  <defs>
    <marker id="ar123" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">ESC 键取消机制</text>
  <rect x="280" y="30" width="200" height="30" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/>
  <text x="380" y="50" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">按下 ESC</text>
  <line x1="380" y1="60" x2="380" y2="76" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="60" y1="76" x2="700" y2="76" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="60" y1="76" x2="60" y2="88" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar123)"/>
  <line x1="180" y1="76" x2="180" y2="88" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar123)"/>
  <line x1="300" y1="76" x2="300" y2="88" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar123)"/>
  <line x1="430" y1="76" x2="430" y2="88" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar123)"/>
  <line x1="570" y1="76" x2="570" y2="88" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar123)"/>
  <line x1="700" y1="76" x2="700" y2="88" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar123)"/>
  <rect x="4" y="88" width="112" height="32" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="60" y="101" text-anchor="middle" font-size="9" font-weight="600" fill="#7c3aed">正在流式</text>
  <text x="60" y="113" text-anchor="middle" font-size="9" fill="#64748b">isStreaming</text>
  <rect x="124" y="88" width="112" height="32" rx="5" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="180" y="101" text-anchor="middle" font-size="9" font-weight="600" fill="#0d9488">执行 bash</text>
  <text x="180" y="113" text-anchor="middle" font-size="9" fill="#64748b">isBashRunning</text>
  <rect x="244" y="88" width="112" height="32" rx="5" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="300" y="101" text-anchor="middle" font-size="9" font-weight="600" fill="#0ea5e9">正在压缩</text>
  <text x="300" y="113" text-anchor="middle" font-size="9" fill="#64748b">compaction_start</text>
  <rect x="374" y="88" width="112" height="32" rx="5" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="430" y="101" text-anchor="middle" font-size="9" font-weight="600" fill="#0ea5e9">正在重试</text>
  <text x="430" y="113" text-anchor="middle" font-size="9" fill="#64748b">auto_retry_start</text>
  <rect x="514" y="88" width="112" height="32" rx="5" fill="#f1f5f9" stroke="#64748b" stroke-width="1.5"/>
  <text x="570" y="101" text-anchor="middle" font-size="9" font-weight="600" fill="#64748b">bash 模式</text>
  <text x="570" y="113" text-anchor="middle" font-size="9" fill="#64748b">isBashMode</text>
  <rect x="644" y="88" width="112" height="32" rx="5" fill="#f1f5f9" stroke="#64748b" stroke-width="1.5"/>
  <text x="700" y="101" text-anchor="middle" font-size="9" font-weight="600" fill="#64748b">双击 ESC</text>
  <text x="700" y="113" text-anchor="middle" font-size="9" fill="#64748b">编辑器为空</text>
  <line x1="60" y1="120" x2="60" y2="140" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar123)"/>
  <line x1="180" y1="120" x2="180" y2="140" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar123)"/>
  <line x1="300" y1="120" x2="300" y2="140" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar123)"/>
  <line x1="430" y1="120" x2="430" y2="140" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar123)"/>
  <line x1="570" y1="120" x2="570" y2="140" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar123)"/>
  <line x1="700" y1="120" x2="700" y2="140" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar123)"/>
  <rect x="4" y="140" width="112" height="52" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="60" y="155" text-anchor="middle" font-size="9" fill="#7c3aed">restoreQueued</text>
  <text x="60" y="167" text-anchor="middle" font-size="9" fill="#7c3aed">MessagesToEditor</text>
  <text x="60" y="179" text-anchor="middle" font-size="9" fill="#64748b">abort LLM stream</text>
  <text x="60" y="188" text-anchor="middle" font-size="9" fill="#94a3b8">排队消息退还编辑器</text>
  <rect x="124" y="140" width="112" height="52" rx="4" fill="#f0fdf4" stroke="#0d9488" stroke-width="1"/>
  <text x="180" y="161" text-anchor="middle" font-size="9" fill="#0d9488">session</text>
  <text x="180" y="175" text-anchor="middle" font-size="9" fill="#0d9488">.abortBash()</text>
  <rect x="244" y="140" width="112" height="52" rx="4" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1"/>
  <text x="300" y="161" text-anchor="middle" font-size="9" fill="#0ea5e9">session</text>
  <text x="300" y="175" text-anchor="middle" font-size="9" fill="#0ea5e9">.abortCompaction()</text>
  <rect x="374" y="140" width="112" height="52" rx="4" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1"/>
  <text x="430" y="161" text-anchor="middle" font-size="9" fill="#0ea5e9">session</text>
  <text x="430" y="175" text-anchor="middle" font-size="9" fill="#0ea5e9">.abortRetry()</text>
  <rect x="514" y="140" width="112" height="52" rx="4" fill="#f8fafc" stroke="#94a3b8" stroke-width="1"/>
  <text x="570" y="157" text-anchor="middle" font-size="9" fill="#64748b">editor.setText("")</text>
  <text x="570" y="171" text-anchor="middle" font-size="9" fill="#64748b">isBashMode</text>
  <text x="570" y="183" text-anchor="middle" font-size="9" fill="#64748b">= false</text>
  <rect x="644" y="140" width="112" height="52" rx="4" fill="#f8fafc" stroke="#94a3b8" stroke-width="1"/>
  <text x="700" y="157" text-anchor="middle" font-size="9" fill="#64748b">doubleEscape</text>
  <text x="700" y="169" text-anchor="middle" font-size="9" fill="#64748b">Action 设置</text>
  <text x="700" y="182" text-anchor="middle" font-size="9" fill="#94a3b8">/tree 或 /fork</text>
  <text x="8" y="220" font-size="10" fill="#94a3b8">代码位置：interactive-mode.ts:2376-2405（ESC 处理逻辑）</text>
</svg>
<span class="figure-caption">图 R12.3 ｜ ESC 取消状态机——六种上下文对应六种取消行为</span>

<details>
<summary>ASCII 原版</summary>

```
按下 ESC
  ├─ 正在流式 (session.isStreaming)
  │    └─ restoreQueuedMessagesToEditor({abort:true})
  │         → session.abortRetry() + session 内部 AbortController.abort()
  │         → agent.abort() → LLM 请求中止,stream 关闭
  │         → 已排队的 steer/followUp 消息退还到编辑器
  │
  ├─ 正在执行 bash (session.isBashRunning)
  │    └─ session.abortBash()
  │
  ├─ 正在压缩 (compaction_start 期间)
  │    └─ session.abortCompaction()
  │
  ├─ 正在重试 (auto_retry_start 期间)
  │    └─ session.abortRetry()
  │
  ├─ 处于 bash 模式 (isBashMode)
  │    └─ editor.setText(""),isBashMode=false
  │
  └─ 编辑器为空时双击 ESC
       └─ 根据 doubleEscapeAction 设置打开 /tree 或 /fork
```

</details>

代码位置:`interactive-mode.ts:2376-2405`(ESC 处理逻辑)

中断后状态恢复:`restoreQueuedMessagesToEditor()` 将 `session._steeringMessages` 和 `_followUpMessages` 合并后放回编辑器,保证用户键入的内容不丢失。

`Ctrl+C` 的行为不同:双击 500ms 内触发关闭(`handleCtrlC`,`interactive-mode.ts:3229`)。单击仅清空编辑器。

---

## 12.9 会话切换与历史浏览

**历史浏览(消息级)**:

编辑器通过 `editor.addToHistory?.(text)` 在每次提交时记录历史,Up/Down 键在编辑器内导航,这是 TUI 层的内置功能。

**历史浏览(会话内 tree)**:

`/tree` 命令打开 `TreeSelectorComponent`(`interactive-mode.ts:2537`),渲染当前会话的消息树(支持分叉)。导航到某个节点后调用 `session.navigateTree(targetId)`,AgentSession 内部执行 branch summarization 并切换 `SessionManager` 的头指针。

**会话切换**:

`/resume` 或 `showSessionSelector()` 打开 `SessionSelectorComponent`,选中后调用 `runtimeHost.resumeSession(path)`,完成后 `rebindCurrentSession()` 重绑事件订阅、重渲染整个聊天记录。

```typescript
// interactive-mode.ts:1587-1596
private async rebindCurrentSession(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.applyRuntimeSettings();
    await this.bindCurrentSessionExtensions();
    this.subscribeToAgent();
    ...
}
```

`rebindCurrentSession` 是会话切换、`/reload`、fork 之后的统一重建入口,它依次:
1. 取消旧会话的事件订阅
2. 重新应用运行时设置(HTTP 超时、编辑器 padding 等)
3. 重新绑定扩展(扩展的 `session_start` handler 在此触发)
4. 重新订阅 agent 事件

---

## 12.10 状态栏、token 计数与成本显示

`FooterComponent.render()` 在每次 `footer.invalidate()` 被调用时重算:

```typescript
// components/footer.ts:77-84
for (const entry of this.session.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
        totalInput += entry.message.usage.input;
        totalOutput += entry.message.usage.output;
        totalCacheRead += entry.message.usage.cacheRead;
        totalCacheWrite += entry.message.usage.cacheWrite;
        totalCost += entry.message.usage.cost.total;
    }
}
```

重要设计决策:统计遍历的是 `sessionManager.getEntries()`(所有 JSONL 条目),而不是 agent 内存中的 `messages`。这样即使在压缩之后,历史所有轮次的累计消耗也能正确显示。

Context 使用率来自 `session.getContextUsage()`,它返回当前上下文占 context window 的百分比:

```
footer 单行格式:
~/.../project  main  claude-sonnet-4-5  in: 12k  out: 3.5k  $0.042  ctx: 34.2%
```

`formatTokens()` 函数(`footer.ts:21-27`)负责将原始 token 数格式化为 `k`/`M` 单位。

`FooterDataProvider`(`core/footer-data-provider.ts`)异步维护 git branch(文件系统 watcher,支持 worktree),以及扩展注入的状态文本 `setExtensionStatus(key, text)`。

---

## 12.11 错误展示

三种错误来源各有不同的展示方式:

**LLM 报错**(`stopReason === "error"`):

`message_end` 事件处理时(`interactive-mode.ts:2774-2784`),若 `streamingMessage.stopReason === "error"`,`AssistantMessageComponent.updateContent()` 接收含错误信息的消息并用红色渲染;所有 `pendingTools` 被标记为错误状态。

**工具报错**(`tool_execution_end` 的 `isError: true`):

`ToolExecutionComponent.updateResult({ isError: true })` 会以红色边框渲染工具结果,`interactive-mode.ts:2831-2839`。

**网络断开/全局错误**:

`showError()` 方法(`interactive-mode.ts:3577-3582`)将错误以红色 `Text` 组件追加到 `chatContainer`:

```typescript
showError(errorMessage: string): void {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(
        new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0)
    );
    this.chatContainer.addChild(new Spacer(1));
    this.ui.requestRender();
}
```

扩展的错误(`showExtensionError`)额外渲染堆栈跟踪(`interactive-mode.ts:2354-2370`)。

EIO/EPIPE 等致命终端错误由 `isDeadTerminalError` 识别(`interactive-mode.ts:178-185`),触发 `emergencyTerminalExit()`,不执行正常 TUI 清理以避免写入已死的终端进一步触发错误。

---

## 12.12 时序图:完整事件流示例

用户键入"读一下 README.md 的第一行"后按回车,到模型调用 Read 工具再输出最终文本的全过程:

<svg viewBox="0 0 880 700" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="完整时序图：从用户按下回车到 agent_end 的全事件流">
  <defs>
    <marker id="ar124f" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="ar124b" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M10,0 L0,5 L10,10 z" fill="#0d9488"/>
    </marker>
  </defs>
  <text x="440" y="18" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">完整时序图：用户输入 → Read 工具 → 最终输出</text>
  <rect x="20" y="28" width="90" height="24" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="65" y="44" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">用户</text>
  <rect x="230" y="28" width="160" height="24" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="310" y="44" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">InteractiveMode</text>
  <rect x="490" y="28" width="120" height="24" rx="4" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="550" y="44" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">AgentSession</text>
  <rect x="720" y="28" width="140" height="24" rx="4" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="790" y="44" text-anchor="middle" font-size="11" font-weight="600" fill="#0ea5e9">Agent (core)</text>
  <line x1="65" y1="52" x2="65" y2="690" stroke="#ea580c" stroke-width="1" stroke-dasharray="4,3" opacity="0.4"/>
  <line x1="310" y1="52" x2="310" y2="690" stroke="#7c3aed" stroke-width="1" stroke-dasharray="4,3" opacity="0.4"/>
  <line x1="550" y1="52" x2="550" y2="690" stroke="#0d9488" stroke-width="1" stroke-dasharray="4,3" opacity="0.4"/>
  <line x1="790" y1="52" x2="790" y2="690" stroke="#0ea5e9" stroke-width="1" stroke-dasharray="4,3" opacity="0.4"/>
  <line x1="65" y1="72" x2="306" y2="72" stroke="#ea580c" stroke-width="1.2" marker-end="url(#ar124f)"/>
  <text x="185" y="68" text-anchor="middle" font-size="9" fill="#ea580c">按 Enter → onSubmit(text)</text>
  <line x1="310" y1="88" x2="546" y2="88" stroke="#7c3aed" stroke-width="1.2" marker-end="url(#ar124f)"/>
  <text x="428" y="84" text-anchor="middle" font-size="9" fill="#7c3aed">session.prompt(text)</text>
  <line x1="550" y1="104" x2="786" y2="104" stroke="#0d9488" stroke-width="1.2" marker-end="url(#ar124f)"/>
  <text x="670" y="100" text-anchor="middle" font-size="9" fill="#0d9488">_runAgentPrompt → agent.prompt()</text>
  <line x1="786" y1="120" x2="70" y2="120" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar124b)"/>
  <text x="430" y="116" text-anchor="middle" font-size="9" fill="#0d9488">emit: agent_start</text>
  <rect x="70" y="124" width="236" height="16" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="0.8"/>
  <text x="188" y="135" text-anchor="middle" font-size="9" fill="#7c3aed">创建 Loader("Working…") · requestRender()</text>
  <line x1="786" y1="148" x2="70" y2="148" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar124b)"/>
  <text x="430" y="144" text-anchor="middle" font-size="9" fill="#0d9488">emit: message_start (role: user)</text>
  <rect x="70" y="152" width="236" height="16" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="0.8"/>
  <text x="188" y="163" text-anchor="middle" font-size="9" fill="#7c3aed">new UserMessageComponent → chatContainer.addChild</text>
  <line x1="786" y1="176" x2="70" y2="176" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar124b)"/>
  <text x="430" y="172" text-anchor="middle" font-size="9" fill="#0d9488">emit: turn_start</text>
  <line x1="786" y1="192" x2="70" y2="192" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar124b)"/>
  <text x="430" y="188" text-anchor="middle" font-size="9" fill="#0d9488">emit: message_start (role: assistant)</text>
  <rect x="70" y="196" width="236" height="16" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="0.8"/>
  <text x="188" y="207" text-anchor="middle" font-size="9" fill="#7c3aed">new AssistantMessageComponent → chatContainer.addChild</text>
  <line x1="786" y1="220" x2="70" y2="220" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar124b)"/>
  <text x="430" y="216" text-anchor="middle" font-size="9" fill="#0d9488">emit: message_update (toolCall: read)</text>
  <rect x="70" y="224" width="236" height="16" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="0.8"/>
  <text x="188" y="235" text-anchor="middle" font-size="9" fill="#7c3aed">new ToolExecutionComponent → pendingTools.set</text>
  <line x1="786" y1="248" x2="70" y2="248" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar124b)"/>
  <text x="430" y="244" text-anchor="middle" font-size="9" fill="#0d9488">emit: message_end (stopReason: "tool_use")</text>
  <rect x="70" y="252" width="236" height="16" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="0.8"/>
  <text x="188" y="263" text-anchor="middle" font-size="9" fill="#7c3aed">streamComp.updateContent() · toolComp.setArgsComplete()</text>
  <line x1="786" y1="276" x2="70" y2="276" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar124b)"/>
  <text x="430" y="272" text-anchor="middle" font-size="9" fill="#0d9488">emit: tool_execution_start</text>
  <rect x="70" y="280" width="236" height="16" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="0.8"/>
  <text x="188" y="291" text-anchor="middle" font-size="9" fill="#7c3aed">toolComp.markExecutionStarted()</text>
  <line x1="786" y1="304" x2="70" y2="304" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar124b)"/>
  <text x="430" y="300" text-anchor="middle" font-size="9" fill="#0d9488">emit: tool_execution_update (partial)</text>
  <rect x="70" y="308" width="236" height="16" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="0.8"/>
  <text x="188" y="319" text-anchor="middle" font-size="9" fill="#7c3aed">toolComp.updateResult(partial, true)</text>
  <line x1="786" y1="332" x2="70" y2="332" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar124b)"/>
  <text x="430" y="328" text-anchor="middle" font-size="9" fill="#0d9488">emit: tool_execution_end</text>
  <rect x="70" y="336" width="236" height="16" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="0.8"/>
  <text x="188" y="347" text-anchor="middle" font-size="9" fill="#7c3aed">toolComp.updateResult(final) · pendingTools.delete</text>
  <line x1="786" y1="360" x2="70" y2="360" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar124b)"/>
  <text x="430" y="356" text-anchor="middle" font-size="9" fill="#0d9488">emit: turn_end</text>
  <rect x="60" y="368" width="820" height="14" rx="3" fill="#f8fafc" stroke="#cbd5e1" stroke-width="0.8"/>
  <text x="440" y="379" text-anchor="middle" font-size="9" fill="#94a3b8">第二轮 turn_start → message_start(assistant)：LLM 读取 Read 结果，生成最终文本</text>
  <line x1="786" y1="390" x2="70" y2="390" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar124b)"/>
  <text x="430" y="386" text-anchor="middle" font-size="9" fill="#0d9488">emit: message_update (text streaming)</text>
  <rect x="70" y="394" width="236" height="16" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="0.8"/>
  <text x="188" y="405" text-anchor="middle" font-size="9" fill="#7c3aed">streamComp2.updateContent(partial) · requestRender()</text>
  <line x1="786" y1="418" x2="70" y2="418" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar124b)"/>
  <text x="430" y="414" text-anchor="middle" font-size="9" fill="#0d9488">emit: message_end</text>
  <rect x="70" y="422" width="236" height="16" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="0.8"/>
  <text x="188" y="433" text-anchor="middle" font-size="9" fill="#7c3aed">streamComp2.updateContent(final) · footer.invalidate()</text>
  <line x1="786" y1="446" x2="70" y2="446" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar124b)"/>
  <text x="430" y="442" text-anchor="middle" font-size="9" fill="#0d9488">emit: agent_end</text>
  <rect x="70" y="450" width="236" height="16" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="0.8"/>
  <text x="188" y="461" text-anchor="middle" font-size="9" fill="#7c3aed">Loader.stop() · statusContainer.clear() · requestRender()</text>
  <line x1="546" y1="474" x2="314" y2="474" stroke="#7c3aed" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar124b)"/>
  <text x="428" y="470" text-anchor="middle" font-size="9" fill="#7c3aed">session.prompt() 返回</text>
  <rect x="70" y="480" width="236" height="16" rx="3" fill="#ede9fe" stroke="#7c3aed" stroke-width="0.8"/>
  <text x="188" y="491" text-anchor="middle" font-size="9" fill="#7c3aed">run() → 下一轮 getUserInput()</text>
  <text x="440" y="514" text-anchor="middle" font-size="10" fill="#94a3b8">TUI 以 60fps 渲染，每次 requestRender() 调度下一帧，Node.js 事件循环不阻塞 LLM 流接收</text>
</svg>
<span class="figure-caption">图 R12.4 ｜ 完整时序图——用户按回车到 agent_end 的全事件流（含 Read 工具调用）</span>

<details>
<summary>ASCII 原版</summary>

```
用户                 InteractiveMode          AgentSession           Agent (pi-agent-core)
 |                          |                      |                        |
 | 按 Enter                 |                      |                        |
 |------------------------->|                      |                        |
 |                  onSubmit(text)                 |                        |
 |                  (interactive-mode.ts:2465)     |                        |
 |                          |                      |                        |
 |                  run() 中 onInputCallback        |                        |
 |                  返回给 getUserInput Promise     |                        |
 |                          |                      |                        |
 |                  session.prompt(text)           |                        |
 |                          |-------------------->|                        |
 |                          |         展开 prompt template                  |
 |                          |         构建 user message                     |
 |                          |         _runAgentPrompt([userMsg])           |
 |                          |                      |-------------------->  |
 |                          |                      |    agent.prompt()     |
 |                          |                      |                        |
 |   事件: agent_start      |                      |                        |
 |<------------------------------------------------------- emit ----------|
 |             创建 Loader("Working...")           |                        |
 |             ui.requestRender()                  |                        |
 |                          |                      |                        |
 |   事件: message_start    |                      |                        |
 |   (role: user)           |                      |                        |
 |<------------------------------------------------------- emit ----------|
 |             addMessageToChat(userMsg)           |                        |
 |             → new UserMessageComponent          |                        |
 |             chatContainer.addChild(comp)        |                        |
 |                          |                      |                        |
 |   事件: turn_start       |                      |                        |
 |<------------------------------------------------------- emit ----------|
 |                          |                      |                        |
 |   事件: message_start    |                      |                        |
 |   (role: assistant)      |                      |                        |
 |<------------------------------------------------------- emit ----------|
 |             new AssistantMessageComponent       |                        |
 |             chatContainer.addChild(streamComp)  |                        |
 |                          |                      |                        |
 |   事件: message_update   | (LLM 决定调用工具)  |                        |
 |   (toolCall: read)       |                      |                        |
 |<------------------------------------------------------- emit ----------|
 |             new ToolExecutionComponent          |                        |
 |             pendingTools.set(toolCallId, comp)  |                        |
 |             chatContainer.addChild(toolComp)    |                        |
 |                          |                      |                        |
 |   事件: message_end      |                      |                        |
 |   (stopReason:"tool_use")|                      |                        |
 |<------------------------------------------------------- emit ----------|
 |             streamingComponent.updateContent()  |                        |
 |             toolComp.setArgsComplete()          |                        |
 |                          |                      |                        |
 |   事件: tool_execution_start                    |                        |
 |<------------------------------------------------------- emit ----------|
 |             toolComp.markExecutionStarted()     |                        |
 |                          |                      |                        |
 |   事件: tool_execution_update (partial output)  |                        |
 |<------------------------------------------------------- emit ----------|
 |             toolComp.updateResult(partial,true) |                        |
 |                          |                      |                        |
 |   事件: tool_execution_end                      |                        |
 |<------------------------------------------------------- emit ----------|
 |             toolComp.updateResult(final)        |                        |
 |             pendingTools.delete(toolCallId)     |                        |
 |                          |                      |                        |
 |   事件: turn_end         |                      |                        |
 |<------------------------------------------------------- emit ----------|
 |                          |                      |                        |
 |   (第二轮 turn_start → message_start assistant) |                        |
 |   LLM 读取到 Read 结果,生成最终文本回复        |                        |
 |                          |                      |                        |
 |   事件: message_update(text streaming)          |                        |
 |<------------------------------------------------------- emit ----------|
 |             streamComp2.updateContent(partial)  |                        |
 |             ui.requestRender()                  |                        |
 |                          |                      |                        |
 |   事件: message_end      |                      |                        |
 |<------------------------------------------------------- emit ----------|
 |             streamComp2.updateContent(final)    |                        |
 |             footer.invalidate()                 |                        |
 |                          |                      |                        |
 |   事件: agent_end        |                      |                        |
 |<------------------------------------------------------- emit ----------|
 |             Loader.stop()                       |                        |
 |             statusContainer.clear()             |                        |
 |             ui.requestRender()                  |                        |
 |                          |                      |                        |
 |             session.prompt() 返回              |                        |
 |             run() 继续下一轮 getUserInput()     |                        |
 |                          |                      |                        |
```

</details>

整个流程期间 TUI 以 60fps 刷新率渲染,每次 `ui.requestRender()` 调度下一帧,Node.js 的事件循环保证渲染回调不会阻塞 LLM 流接收。
