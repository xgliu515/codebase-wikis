# Tour 步骤 16:事件订阅者 -> InteractiveMode 更新 TUI

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:JSONL 已写,`phase = "idle"`。`AgentHarness` 发出 `agent_end` 事件,沿订阅链传播到 `InteractiveMode`。

**下一步起点**:UI 数据状态完整,终端像素尚未刷新。`TUI.requestRender()` 已被调用,渲染回调已排入 `process.nextTick` 队列,等待微任务执行。

---

## 1. 当前情境

事件传播路径如下:

```
AgentHarness.emitAny(agent_end)
  └─ AgentHarness.subscribe 回调 (agent-harness.ts:970-978)
       └─ AgentSession.subscribe 回调 (coding-agent/src/core/agent-session.ts)
            └─ InteractiveMode.subscribeToAgent -> handleEvent (interactive-mode.ts:2645-2648)
```

`InteractiveMode.subscribeToAgent`(`interactive-mode.ts:2645`) 在 `rebindCurrentSession` 时注册:

```typescript
// interactive-mode.ts:2645-2648
private subscribeToAgent(): void {
    this.unsubscribe = this.session.subscribe(async (event) => {
        await this.handleEvent(event);
    });
}
```

`handleEvent` 是整个 TUI 更新逻辑的核心分发函数,从 `agent_start` 到 `agent_end` 的所有中间事件都在这里消费。

---

## 2. 问题

本步需要回答四个问题:

1. **InteractiveMode 如何把 TextEvent(流式文本增量)实时追加到 assistant 消息组件**,UI 缓冲区的更新路径是什么。

2. **工具卡片的状态从"调用中"到"已完成"经历了哪几个事件**,每个事件触发什么样的视觉变化。

3. **UsageEvent 的 token 数字如何到达状态栏**,`FooterComponent` 如何感知到它。

4. **StopEvent(agent_end)到达后,UI 做了哪些清理**,InputComponent 的焦点如何恢复。

---

## 3. 朴素思路

最简单的做法:等 `agent_end` 发出后,把 `messages` 数组里的所有内容从零重新渲染一遍。这样逻辑最简单,但:

- 模型流式输出时用户看不到任何增量文本,直到整个 turn 完成才刷新——对话体验极差。
- 整屏重绘会产生肉眼可见的闪烁。

---

## 4. 为什么朴素思路会崩

流式响应的核心价值就是让用户实时看到模型生成的字符。等 `agent_end` 才渲染,整个流式 API 的意义就丧失了。此外,完整重绘每次都要重新计算所有组件的行宽并写入全部 ANSI 序列,造成不必要的 CPU 和 I/O 开销。

---

## 5. pi 的做法

**事件驱动的增量渲染模型**

`handleEvent`(`interactive-mode.ts:2651`) 对每类事件做专项处理,每次处理后调用 `this.ui.requestRender()`。`requestRender` 不立即渲染,而是把渲染调度到 `process.nextTick`(或最小 16ms 的 timer),多次连续调用只触发一次实际渲染(`tui.ts:519-521`)。

**agent_start 阶段**

```typescript
// interactive-mode.ts:2659-2683
case "agent_start":
    this.pendingTools.clear();
    this.stopWorkingLoader();
    if (this.workingVisible) {
        this.loadingAnimation = this.createWorkingLoader();
        this.statusContainer.addChild(this.loadingAnimation);
    }
    this.ui.requestRender();
    break;
```

`loadingAnimation`("Working..." 旋转器)挂到 `statusContainer`,用户看到 loading 指示符。

**message_start(assistant) 阶段**

```typescript
// interactive-mode.ts:2710-2720
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

新建 `AssistantMessageComponent` 并插入 `chatContainer`。`AssistantMessageComponent` 内部持有 `Markdown` 组件用于渲染 markdown 格式的文本。

**message_update 阶段(流式文本增量)**

```typescript
// interactive-mode.ts:2724-2756
case "message_update":
    if (this.streamingComponent && event.message.role === "assistant") {
        this.streamingMessage = event.message;
        this.streamingComponent.updateContent(this.streamingMessage);

        for (const content of this.streamingMessage.content) {
            if (content.type === "toolCall") {
                if (!this.pendingTools.has(content.id)) {
                    const component = new ToolExecutionComponent(
                        content.name, content.id, content.arguments, ...
                    );
                    this.chatContainer.addChild(component);
                    this.pendingTools.set(content.id, component);
                } else {
                    this.pendingTools.get(content.id)?.updateArgs(content.arguments);
                }
            }
        }
        this.ui.requestRender();
    }
```

每次 `message_update`(来自 `text_delta` SSE 事件),`streamingMessage` 就是当前最新的 partial `AssistantMessage`。`updateContent` 把新文本交给 `Markdown` 组件,`requestRender` 触发下一帧差分渲染,用户在终端看到文字实时增长。

**工具卡片的生命周期**

| 事件 | ToolExecutionComponent 状态 | 视觉效果 |
|------|-----------------------------|----------|
| `message_update`(含 toolCall) | 新建组件,`isPartial=true` | 背景色 `toolPendingBg`,显示工具名 |
| `tool_execution_start` | `markExecutionStarted()` | "Reading README.md..." 提示 |
| `tool_execution_update` | `updateResult(..., isPartial=true)` | 实时显示部分输出 |
| `tool_execution_end` | `updateResult(..., isPartial=false)` | 背景切换为 `toolSuccessBg`,"Read README.md (N lines)" |

`ToolExecutionComponent.updateDisplay`(`tool-execution.ts:228-334`) 根据 `isPartial` 和 `result.isError` 选择背景色函数,调用 `callRenderer`/`resultRenderer` 生成渲染内容。

**message_end(assistant) 阶段**

```typescript
// interactive-mode.ts:2759-2795
case "message_end":
    if (this.streamingComponent && event.message.role === "assistant") {
        this.streamingMessage = event.message;
        this.streamingComponent.updateContent(this.streamingMessage);
        // ...
        for (const [, component] of this.pendingTools.entries()) {
            component.setArgsComplete();  // 触发 diff 计算(edit 工具)
        }
        this.streamingComponent = undefined;
        this.streamingMessage = undefined;
        this.footer.invalidate();
    }
    this.ui.requestRender();
```

`streamingComponent` 被置为 `undefined`,引用断开但组件仍在 `chatContainer.children` 中(静态展示)。`footer.invalidate()` 让状态栏在下一帧重新渲染以更新 token 计数。

**agent_end 阶段:清理与焦点恢复**

```typescript
// interactive-mode.ts:2841-2859
case "agent_end":
    if (this.loadingAnimation) {
        this.loadingAnimation.stop();
        this.loadingAnimation = undefined;
        this.statusContainer.clear();
    }
    if (this.streamingComponent) {
        this.chatContainer.removeChild(this.streamingComponent);
        this.streamingComponent = undefined;
        this.streamingMessage = undefined;
    }
    this.pendingTools.clear();
    await this.checkShutdownRequested();
    this.ui.requestRender();
    break;
```

- `loadingAnimation.stop()` 停止旋转器动画,`statusContainer.clear()` 移除旋转器组件。
- `pendingTools.clear()` 清空工具卡片追踪 Map(正常情况下已空,此处是防守性清理)。
- `this.ui.setFocus(this.editor)` 并不在这里显式调用——焦点从未离开 `editor`,整个 turn 期间 `TUI` 的 `focusedComponent` 一直是 InputComponent,因此 turn 结束后光标天然已在输入框。

**usage 到达状态栏的路径**

`FooterComponent` 通过 `FooterDataProvider` 读取 usage 数据。`AgentSession` 订阅 `agent_end` 后,从 `newMessages` 中找到最后一条 `AssistantMessage`,读取 `usage` 字段,更新 `footerDataProvider`。`footer.invalidate()` 在 `message_end` 时已调用,`doRender` 时 `FooterComponent.render()` 重新计算 token 行并输出新字符串。

<svg viewBox="0 0 760 720" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="UI 事件响应时序:从 agent_start 到 agent_end 的完整渲染驱动链">
  <defs>
    <marker id="arT16" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="720" fill="#f8fafc" rx="6"/>
  <text x="380" y="26" text-anchor="middle" font-size="14" font-weight="600" fill="#1e293b">UI 事件响应时序:agent_start → agent_end</text>
  <rect x="20" y="40" width="240" height="28" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="140" y="58" text-anchor="middle" font-size="11" font-weight="600" fill="#9a3412">agent_start</text>
  <rect x="280" y="40" width="460" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="510" y="58" text-anchor="middle" font-size="9" fill="#64748b">loadingAnimation 显示 "Working..."  →  requestRender</text>
  <line x1="140" y1="68" x2="140" y2="88" stroke="#94a3b8" stroke-width="1" marker-end="url(#arT16)"/>
  <rect x="20" y="88" width="240" height="28" rx="4" fill="#dbeafe" stroke="#3b82f6" stroke-width="1.2"/>
  <text x="140" y="106" text-anchor="middle" font-size="10" fill="#1e40af">message_start(user)</text>
  <rect x="280" y="88" width="460" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="510" y="106" text-anchor="middle" font-size="9" fill="#64748b">UserMessageComponent 加入 chatContainer  →  requestRender</text>
  <line x1="140" y1="116" x2="140" y2="136" stroke="#94a3b8" stroke-width="1" marker-end="url(#arT16)"/>
  <rect x="20" y="136" width="240" height="28" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="140" y="154" text-anchor="middle" font-size="10" fill="#4c1d95">message_start(assistant_1)</text>
  <rect x="280" y="136" width="460" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="510" y="154" text-anchor="middle" font-size="9" fill="#64748b">streamingComponent = new AssistantMessageComponent  →  requestRender</text>
  <line x1="140" y1="164" x2="140" y2="184" stroke="#94a3b8" stroke-width="1" marker-end="url(#arT16)"/>
  <rect x="20" y="184" width="240" height="46" rx="4" fill="#ede9fe" stroke="#a78bfa" stroke-width="1"/>
  <text x="140" y="202" text-anchor="middle" font-size="10" fill="#4c1d95">message_update ×N</text>
  <text x="140" y="218" text-anchor="middle" font-size="9" fill="#6d28d9">(text_delta / toolcall_delta)</text>
  <rect x="280" y="184" width="460" height="46" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="510" y="200" text-anchor="middle" font-size="9" fill="#64748b">streamingComponent.updateContent(partialMsg)</text>
  <text x="510" y="216" text-anchor="middle" font-size="9" fill="#64748b">ToolExecutionComponent 新建/更新  →  requestRender (每次)</text>
  <line x1="140" y1="230" x2="140" y2="250" stroke="#94a3b8" stroke-width="1" marker-end="url(#arT16)"/>
  <rect x="20" y="250" width="240" height="28" rx="4" fill="#d1fae5" stroke="#10b981" stroke-width="1.2"/>
  <text x="140" y="268" text-anchor="middle" font-size="10" fill="#065f46">tool_execution_start</text>
  <rect x="280" y="250" width="460" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="510" y="268" text-anchor="middle" font-size="9" fill="#64748b">pendingTools[id].markExecutionStarted  →  requestRender</text>
  <line x1="140" y1="278" x2="140" y2="298" stroke="#94a3b8" stroke-width="1" marker-end="url(#arT16)"/>
  <rect x="20" y="298" width="240" height="36" rx="4" fill="#d1fae5" stroke="#10b981" stroke-width="1.2"/>
  <text x="140" y="316" text-anchor="middle" font-size="10" fill="#065f46">tool_execution_end</text>
  <rect x="280" y="298" width="460" height="36" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="510" y="314" text-anchor="middle" font-size="9" fill="#64748b">pendingTools[id].updateResult (isPartial=false)</text>
  <text x="510" y="328" text-anchor="middle" font-size="9" fill="#64748b">背景色变 toolSuccessBg  →  requestRender</text>
  <line x1="140" y1="334" x2="140" y2="354" stroke="#94a3b8" stroke-width="1" marker-end="url(#arT16)"/>
  <rect x="20" y="354" width="240" height="46" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="140" y="372" text-anchor="middle" font-size="10" fill="#4c1d95">message_end(assistant_1)</text>
  <rect x="280" y="354" width="460" height="46" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="510" y="370" text-anchor="middle" font-size="9" fill="#64748b">streamingComponent.updateContent(finalMsg)</text>
  <text x="510" y="386" text-anchor="middle" font-size="9" fill="#64748b">streamingComponent = undefined  →  footer.invalidate</text>
  <line x1="140" y1="400" x2="140" y2="420" stroke="#94a3b8" stroke-width="1" marker-end="url(#arT16)"/>
  <rect x="20" y="420" width="240" height="28" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <text x="140" y="438" text-anchor="middle" font-size="9" fill="#94a3b8">message_start/end(toolResult)  [UI 不渲染]</text>
  <line x1="140" y1="448" x2="140" y2="468" stroke="#94a3b8" stroke-width="1" marker-end="url(#arT16)"/>
  <rect x="20" y="468" width="240" height="28" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="140" y="486" text-anchor="middle" font-size="10" fill="#4c1d95">message_start(assistant_2)</text>
  <rect x="280" y="468" width="460" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="510" y="486" text-anchor="middle" font-size="9" fill="#64748b">新 streamingComponent  →  requestRender</text>
  <line x1="140" y1="496" x2="140" y2="516" stroke="#94a3b8" stroke-width="1" marker-end="url(#arT16)"/>
  <rect x="20" y="516" width="240" height="36" rx="4" fill="#ede9fe" stroke="#a78bfa" stroke-width="1"/>
  <text x="140" y="534" text-anchor="middle" font-size="10" fill="#4c1d95">message_update ×N</text>
  <text x="140" y="548" text-anchor="middle" font-size="9" fill="#6d28d9">(最终文本流)</text>
  <rect x="280" y="516" width="460" height="36" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="510" y="534" text-anchor="middle" font-size="9" fill="#64748b">streamingComponent.updateContent</text>
  <text x="510" y="548" text-anchor="middle" font-size="9" fill="#64748b">requestRender</text>
  <line x1="140" y1="552" x2="140" y2="572" stroke="#94a3b8" stroke-width="1" marker-end="url(#arT16)"/>
  <rect x="20" y="572" width="240" height="28" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="140" y="590" text-anchor="middle" font-size="10" fill="#4c1d95">message_end(assistant_2)</text>
  <rect x="280" y="572" width="460" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="510" y="590" text-anchor="middle" font-size="9" fill="#64748b">footer.invalidate  →  requestRender</text>
  <line x1="140" y1="600" x2="140" y2="620" stroke="#94a3b8" stroke-width="1" marker-end="url(#arT16)"/>
  <rect x="20" y="620" width="240" height="46" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="140" y="638" text-anchor="middle" font-size="11" font-weight="600" fill="#134e4a">agent_end</text>
  <rect x="280" y="620" width="460" height="46" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="510" y="638" text-anchor="middle" font-size="9" fill="#64748b">loadingAnimation.stop, statusContainer.clear  →  requestRender</text>
  <text x="510" y="654" text-anchor="middle" font-size="9" fill="#64748b">输入框焦点天然在位,光标已可见</text>
</svg>
<span class="figure-caption">图 T16.1 ｜ InteractiveMode 处理全部 AgentEvent 并触发 requestRender 的完整时序</span>

<details>
<summary>ASCII 原版</summary>

```
agent_start
    -> loadingAnimation 显示 "Working..."
    -> requestRender

message_start(user)
    -> UserMessageComponent 加入 chatContainer
    -> requestRender

message_start(assistant_1)
    -> streamingComponent = new AssistantMessageComponent
    -> requestRender

message_update x N (text_delta / toolcall_delta)
    -> streamingComponent.updateContent(partialMsg)
    -> ToolExecutionComponent 新建/更新
    -> requestRender (每次)

tool_execution_start
    -> pendingTools[id].markExecutionStarted
    -> requestRender

tool_execution_end
    -> pendingTools[id].updateResult (isPartial=false)
    -> 背景色变 toolSuccessBg
    -> requestRender

message_end(assistant_1)
    -> streamingComponent.updateContent(finalMsg)
    -> streamingComponent = undefined
    -> footer.invalidate

message_start/end(toolResult) [UI 不渲染 toolResult 角色]

message_start(assistant_2)
    -> 新 streamingComponent
    -> requestRender

message_update x N (最终文本流)
    -> streamingComponent.updateContent
    -> requestRender

message_end(assistant_2)
    -> footer.invalidate
    -> requestRender

agent_end
    -> loadingAnimation.stop, statusContainer.clear
    -> requestRender
    -> 输入框焦点天然在位,光标已可见
```

</details>

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 2645-2648 | `subscribeToAgent`:注册事件回调 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 2651-2929 | `handleEvent`:所有事件分支 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 2702-2720 | `message_start` 分支:创建流式组件 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 2724-2756 | `message_update` 分支:增量更新文本与工具卡片 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 2798-2819 | `tool_execution_start` 分支 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 2831-2838 | `tool_execution_end` 分支:结果落入卡片 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 2841-2860 | `agent_end` 分支:清理与焦点归位 |
| `packages/coding-agent/src/modes/interactive/components/tool-execution.ts` | 228-334 | `updateDisplay`:工具卡片内容更新 |

---

## 7. 分支与延伸

- **AgentSession.subscribe 与事件总线架构**:见 [第 12 章 §12.3「AgentSession 事件订阅」](./12-interactive-mode.md#123-agentsession-事件订阅)。

- **状态栏 / usage / token 计数的 FooterComponent**:见 [第 12 章 §12.5「状态栏与 token 计数」](./12-interactive-mode.md#125-状态栏与-token-计数)。

- **Markdown 组件与流式渲染**:见 [第 11 章 §11.3「Markdown 组件」](./11-tui-components-and-keys.md#113-markdown-组件)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **handleEvent 是一个事件分发表,不是状态机**:它不维护内部状态(状态在 `streamingComponent`、`pendingTools`、`loadingAnimation` 这些字段上),每个 case 只做"根据事件更新 UI 对象 + 调用 requestRender"。

2. **requestRender 是幂等的限速调用**:同一个 Node.js tick 内多次调用 `requestRender` 只产生一次实际渲染,最小间隔 16ms,这避免了每个 SSE delta 都触发一次全量 ANSI 写入。

3. **工具卡片有四个视觉状态**:pending(灰色)-> started(灰色+"Reading...")-> partial(灰色+部分输出)-> complete(绿色+完整输出)。背景色由 `ToolExecutionComponent.updateDisplay` 根据 `isPartial` 和 `isError` 动态选择。

4. **焦点从未离开 InputComponent**:`TUI.setFocus` 在 `init` 时调用一次指向 editor,整个 turn 期间不变。用户任何时候按 Ctrl+C 都会传到 editor 的 `handleInput`,agent_end 后光标也天然在输入框——不需要显式"恢复焦点"。

5. **toolResult 消息不触发任何 UI 渲染**:`message_start(toolResult)` 在 `handleEvent` 里不匹配任何 case(只匹配 `user`、`assistant`、`custom`),因此跳过。工具结果的可视化完全由 `tool_execution_end` 事件承担。
