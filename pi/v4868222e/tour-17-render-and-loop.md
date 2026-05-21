# Tour 步骤 17:TUI 差分渲染 + 等待下一轮

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:UI 数据状态完整——`chatContainer` 已有 user 消息、工具卡片、两条 assistant 消息;`loadingAnimation` 已停止并从 `statusContainer` 移除;`footer.invalidate()` 已调用。`agent_end` 事件处理结束,最后一次 `requestRender()` 已排入队列。终端屏幕还停留在上一帧(最后一次差分更新时的状态)。

**下一步终态**:`doRender` 执行完毕,差分帧已写入 stdout,用户在终端看到最终回复。进程进入 `process.stdin` 事件等待,TUI raw mode 保持。AgentSession.messages 包含 4 条消息(user + assistant_1 + toolResult + assistant_2),JSONL 包含同步数据,usage 已更新。**整轮 trace 完成。**

---

## 1. 当前情境

`requestRender()` 不是同步渲染——它把渲染工作推迟到下一个 tick。调用栈此时是:

```
handleEvent(agent_end) 返回
  └─ this.ui.requestRender()     // interactive-mode.ts:2859
        └─ TUI.requestRender()   // tui.ts:495
             └─ process.nextTick(() => scheduleRender())
                  └─ setTimeout(doRender, max(0, 16 - elapsed))
```

`TUI.MIN_RENDER_INTERVAL_MS = 16`(`tui.ts:253`),确保渲染帧率不超过 60fps。`renderRequested` 标志保证多个并发 `requestRender` 调用只产生一次 `doRender`(`tui.ts:519-521`)。

---

## 2. 问题

本步需要回答三个问题:

1. **doRender 如何决定哪些行需要重写**,diff 算法的具体逻辑是什么,哪些情况会触发全量重绘。

2. **光标位置如何确定并发送给终端**,`CURSOR_MARKER` 在渲染管线中的角色是什么。

3. **渲染完成后进程进入什么状态**,下一次用户输入如何再次激活这整条链路。

---

## 3. 朴素思路

最简单的做法:每次渲染都清空整个终端(`\x1b[2J\x1b[H`),然后从上到下重新打印所有行。实现简单,但对于只有最后几行变化的情况(比如旋转器动画更新了一个字符),每帧都全量清屏会产生明显闪烁,在慢速终端(SSH 远程)上更加严重。

---

## 4. 为什么朴素思路会崩

pi 的 TUI 在 SSH 连接上也需要流畅运行。全量重绘在高延迟 SSH 链路下会产生每帧数百字节的写入,用户看到的是整个屏幕内容不断闪烁重排。此外,Kitty 图形协议的图片数据不能被随意覆盖——全量清屏必须先发送 "delete Kitty image" 序列,否则图片残影会留在屏幕上。

---

## 5. pi 的做法

**第一步:render() 生成新帧**

`TUI.doRender`(`tui.ts:953`) 首先调用继承自 `Container` 的 `render(width)`:

```typescript
// tui.ts:969-975
let newLines = this.render(width);

// Composite overlays into the rendered lines (before differential compare)
if (this.overlayStack.length > 0) {
    newLines = this.compositeOverlays(newLines, width, height);
}
```

`Container.render`(`tui.ts:224-233`) 递归调用所有子组件的 `render(width)`,拼接返回的字符串数组。对于本次 trace,组件树如下:

```
TUI (Container)
  headerContainer
  chatContainer
    UserMessageComponent
    AssistantMessageComponent (assistant_1,含 ToolExecutionComponent)
    ToolExecutionComponent (read 工具卡片,已完成)
    AssistantMessageComponent (assistant_2,最终文本)
  statusContainer  (已清空)
  widgetContainerAbove
  editorContainer  (InputComponent,含 CURSOR_MARKER)
  widgetContainerBelow
  FooterComponent
```

每个组件的 `render(width)` 返回该组件的行数组。`AssistantMessageComponent` 内的 `Markdown` 组件(`tui.ts 所在包 -> components/markdown.ts`)对文本做 markdown 解析并加 ANSI 颜色序列。

**第二步:提取光标标记**

在差分对比之前,`doRender` 先查找 `CURSOR_MARKER`(`tui.ts:978`):

```typescript
// tui.ts:978-980
const cursorPos = this.extractCursorPosition(newLines, height);
newLines = this.applyLineResets(newLines);
```

`CURSOR_MARKER = "\x1b_pi:c\x07"` 是一个 APC 序列,终端会忽略它但 pi 会捕获它。`InputComponent`(`tui/src/components/input.ts`)在 `focused = true` 时把这个 marker 插入光标所在位置,`extractCursorPosition`(`tui.ts:933-951`) 扫描最后 `height` 行找到 marker,计算其视觉列号(用 `visibleWidth` 计算 ANSI-safe 宽度),然后把 marker 从字符串中剥除。

**第三步:差分算法**

`doRender` 的核心差分逻辑(`tui.ts:1053-1078`):

```typescript
let firstChanged = -1;
let lastChanged = -1;
const maxLines = Math.max(newLines.length, this.previousLines.length);
for (let i = 0; i < maxLines; i++) {
    const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
    const newLine = i < newLines.length ? newLines[i] : "";
    if (oldLine !== newLine) {
        if (firstChanged === -1) { firstChanged = i; }
        lastChanged = i;
    }
}
```

字符串直接比较(`===`),ANSI 序列包含在内。找到 `firstChanged` 和 `lastChanged` 后:

- 如果没有变化(`firstChanged === -1`),只更新硬件光标位置,不写任何内容。
- 如果变化行全部超过 `newLines.length`(内容缩短),只清除多余行。
- 否则渲染 `[firstChanged, lastChanged]` 区间内的所有行。

**第四步:发送 ANSI 序列**

差分渲染的 ANSI 写入(`tui.ts:1145-1209`):

```typescript
let buffer = "\x1b[?2026h";   // Begin synchronized output (防闪烁)
// 移动光标到 firstChanged 行
// 逐行: \x1b[2K (清行) + newLines[i]
buffer += "\x1b[?2026l";      // End synchronized output
this.terminal.write(buffer);
```

`\x1b[?2026h`/`\x1b[?2026l` 是"同步输出"扩展(BSU/ESU),支持它的终端会在接收完整个 buffer 后才刷新屏幕,彻底消除渲染中间状态的闪烁。

`terminal.write(buffer)`(`terminal.ts:326-335`) 直接调用 `process.stdout.write(data)`——所有 ANSI 序列一次性写入,由操作系统负责发给终端(或 SSH 的 PTY)。

**第五步:定位硬件光标**

```typescript
// tui.ts:1274
this.positionHardwareCursor(cursorPos, newLines.length);
```

`positionHardwareCursor`(`tui.ts:1287-1318`) 计算从当前 `hardwareCursorRow` 到目标光标行的行差,发送 `\x1b[NB`(向下 N 行)或 `\x1b[NA`(向上),再发 `\x1b[colG`(绝对列定位)。InputComponent 报告的光标列就是用户在编辑器中当前输入位置。

如果 `showHardwareCursor = false`(默认),最后发 `\x1b[?25l` 隐藏硬件光标,使用 pi 自己绘制的伪光标(反色字符)。

**第六步:状态更新**

```typescript
// tui.ts:1276-1280
this.previousLines = newLines;
this.previousKittyImageIds = this.collectKittyImageIds(newLines);
this.previousWidth = width;
this.previousHeight = height;
```

`previousLines` 是下一帧差分的"基线",所有状态字段随之更新。

**全量重绘的触发条件**

以下情况跳过差分,直接全量重绘:

- 首次渲染(`previousLines.length === 0`)
- 终端宽度变化(`widthChanged`)—— 换行位置全部改变
- 终端高度变化且非 Termux(`heightChanged`)
- `clearOnShrink = true` 且内容行数减少(`newLines.length < maxLinesRendered`)
- 变化行在当前 viewport 顶端以上(`firstChanged < prevViewportTop`)

**等待下一轮用户输入**

渲染完成后,进程回到 `ProcessTerminal` 的 stdin 事件监听。`process.stdin` 处于 raw mode,每个按键字节立即触发 `data` 事件 -> `TUI.handleInput` -> `focusedComponent.handleInput`(即 InputComponent)。

`InteractiveMode.run` 的主循环(`interactive-mode.ts:779-788`)此时停在 `await this.getUserInput()`:

```typescript
// interactive-mode.ts:779-788
while (true) {
    const userInput = await this.getUserInput();
    try {
        await this.session.prompt(userInput);
    } catch (error: unknown) { ... }
}
```

用户下一次按回车,`getUserInput()` resolve,`session.prompt(userInput)` 调用,整条 trace 链路从 **tour-06** 重新开始。

<svg viewBox="0 0 760 580" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="TUI 渲染管线:requestRender → doRender → ANSI diff 写终端">
  <defs>
    <marker id="arT17" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="580" fill="#f8fafc" rx="6"/>
  <text x="380" y="26" text-anchor="middle" font-size="14" font-weight="600" fill="#1e293b">TUI 渲染管线:requestRender → doRender → 终端输出</text>
  <rect x="240" y="44" width="280" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="66" text-anchor="middle" font-size="12" font-weight="600" fill="#9a3412">requestRender()</text>
  <line x1="380" y1="76" x2="380" y2="98" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT17)"/>
  <rect x="100" y="98" width="560" height="44" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="116" text-anchor="middle" font-size="10" fill="#475569">process.nextTick  →  scheduleRender</text>
  <text x="380" y="132" text-anchor="middle" font-size="10" fill="#475569">setTimeout 16ms  →  doRender()</text>
  <line x1="380" y1="142" x2="380" y2="164" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT17)"/>
  <rect x="240" y="164" width="280" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="186" text-anchor="middle" font-size="12" font-weight="600" fill="#4c1d95">doRender()</text>
  <line x1="380" y1="196" x2="380" y2="218" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT17)"/>
  <rect x="60" y="218" width="640" height="100" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="80" y="238" font-size="10" font-weight="600" fill="#475569">组件树 → 字符串数组</text>
  <text x="80" y="256" font-size="9" fill="#64748b">render(width)          → newLines[]  (组件树渲染)</text>
  <text x="80" y="272" font-size="9" fill="#64748b">compositeOverlays      → overlay 合成 (本次无 overlay)</text>
  <text x="80" y="288" font-size="9" fill="#64748b">extractCursorPosition  → cursorPos { row, col }</text>
  <text x="80" y="304" font-size="9" fill="#64748b">applyLineResets        → 每行末尾 \x1b[0m\x1b]8;;\x07</text>
  <line x1="380" y1="318" x2="380" y2="340" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT17)"/>
  <rect x="60" y="340" width="640" height="110" rx="6" fill="#dbeafe" stroke="#3b82f6" stroke-width="1.2"/>
  <text x="80" y="360" font-size="10" font-weight="600" fill="#1e40af">diff + build ANSI buffer</text>
  <text x="80" y="378" font-size="9" fill="#64748b">diff(previousLines, newLines)  → firstChanged=X, lastChanged=Y</text>
  <text x="80" y="396" font-size="9" fill="#1d4ed8">\x1b[?2026h           BSU 开始(Synchronized Update)</text>
  <text x="80" y="412" font-size="9" fill="#64748b">\x1b[NA / \x1b[NB     光标移到 firstChanged 行</text>
  <text x="80" y="428" font-size="9" fill="#64748b">for i in [X..Y]:  \x1b[2K 清行  +  newLines[i] 写内容</text>
  <text x="80" y="444" font-size="9" fill="#1d4ed8">\x1b[?2026l           BSU 结束</text>
  <line x1="380" y1="450" x2="380" y2="472" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT17)"/>
  <rect x="60" y="472" width="640" height="54" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="80" y="492" font-size="9" fill="#64748b">terminal.write(buffer)  →  process.stdout.write</text>
  <text x="80" y="508" font-size="9" fill="#64748b">positionHardwareCursor: \x1b[NA/NB  \x1b[colG  \x1b[?25l</text>
  <text x="80" y="522" font-size="9" fill="#64748b">previousLines = newLines</text>
  <line x1="380" y1="526" x2="380" y2="548" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT17)"/>
  <rect x="140" y="548" width="480" height="26" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="565" text-anchor="middle" font-size="10" font-weight="600" fill="#134e4a">用户看见最终回复  →  stdin 等待  →  下一次回车 → tour-06</text>
</svg>
<span class="figure-caption">图 T17.1 ｜ TUI 渲染管线:requestRender 节流调度 → doRender diff → BSU ANSI buffer → 终端写出</span>

<details>
<summary>ASCII 原版</summary>

```
requestRender()
    |
    +--[process.nextTick] scheduleRender
    +--[setTimeout 16ms]  doRender
    |
doRender:
    |
    +--[render(width)]         -> newLines[]   (组件树->字符串数组)
    +--[compositeOverlays]     -> overlay 合成 (本次无 overlay)
    +--[extractCursorPosition] -> cursorPos { row, col }
    +--[applyLineResets]       -> 每行末尾 \x1b[0m\x1b]8;;\x07
    |
    +--[diff: firstChanged=X, lastChanged=Y]
    |
    +--[build ANSI buffer]
    |    \x1b[?2026h           BSU 开始
    |    \x1b[NA / \x1b[NB     光标移到 firstChanged
    |    for i in [X..Y]:
    |        \x1b[2K           清当前行
    |        newLines[i]       写新行内容
    |    \x1b[?2026l           BSU 结束
    |
    +--[terminal.write(buffer)]  -> process.stdout.write
    |
    +--[positionHardwareCursor]
    |    \x1b[NA / \x1b[NB     移到光标行
    |    \x1b[colG              绝对列
    |    \x1b[?25l              隐藏硬件光标
    |
    +--[previousLines = newLines]
    |
    v
用户在终端看见最终回复
进程进入 stdin 等待 (raw mode)
    |
    v
下一次按键 -> TUI.handleInput -> InputComponent -> ...
下一次回车 -> session.prompt -> tour-06 起点
```

</details>

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/tui/src/tui.ts` | 495-521 | `requestRender`:调度与节流 |
| `packages/tui/src/tui.ts` | 524-541 | `scheduleRender`:16ms 最小间隔 timer |
| `packages/tui/src/tui.ts` | 953-1319 | `doRender`:完整差分渲染实现 |
| `packages/tui/src/tui.ts` | 933-951 | `extractCursorPosition`:查找并剥除 CURSOR_MARKER |
| `packages/tui/src/tui.ts` | 1053-1086 | 差分算法:遍历行找 firstChanged/lastChanged |
| `packages/tui/src/tui.ts` | 1144-1230 | 差分渲染 ANSI buffer 构建与写入 |
| `packages/tui/src/tui.ts` | 1287-1318 | `positionHardwareCursor`:光标定位 ANSI 序列 |
| `packages/tui/src/terminal.ts` | 326-335 | `ProcessTerminal.write`:stdout 写入 + 可选日志 |
| `packages/tui/src/utils.ts` | (全文) | `visibleWidth`、`sliceByColumn`:宽度计算工具 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 779-788 | 主循环:getUserInput + session.prompt |

---

## 7. 分支与延伸

- **差分渲染算法的完整说明与边界情况**:见 [第 10 章 §10.3「差分渲染算法」](./10-tui-renderer.md#103-差分渲染算法)。

- **光标管理:CURSOR_MARKER 协议与硬件光标定位**:见 [第 10 章 §10.4「光标管理」](./10-tui-renderer.md#104-光标管理)。

- **InteractiveMode 完整时序图**:见 [第 12 章 §12.6「完整时序图」](./12-interactive-mode.md#126-完整时序图)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **差分算法是字符串级别的逐行比较**:不是 virtual DOM、不是 React fiber,就是 `oldLine !== newLine` 的字符串比较。ANSI 序列包含在字符串里,颜色或格式变化同样触发行更新。这个简单算法在大多数场景下已经足够高效。

2. **BSU/ESU 序列是防闪烁的关键**:`\x1b[?2026h`(Begin Synchronized Update)告诉终端在收到 `\x1b[?2026l`(End)之前不要刷新显示。如果终端支持此扩展,用户完全看不到渲染中间状态;不支持的终端退化为普通写入。

3. **CURSOR_MARKER 是零宽度的位置锚**:它不占可见宽度,不影响行内容的可视比较,只在渲染管线的最后一步被提取和剥除。InputComponent 通过在 focused 时插入它来"告诉"TUI 光标位置,而不需要任何全局状态。

4. **进程"等待输入"是完全被动的**:渲染完成后没有轮询、没有定时器,进程的 Node.js event loop 只监听 `process.stdin` 的 `data` 事件和可能的 resize 事件。这是标准的事件驱动 I/O,CPU 占用为零。

5. **整轮 trace 完成后的状态**:JSONL 文件包含 5 行(1 header + 4 messages),`AgentSession.messages` 在内存中有 4 条,token usage 已更新到 footer,终端显示完整的对话历史。下一条用户消息将使 messages 变为 5 条,重走这条链路。你现在已经完整地走过了"键盘输入 -> 模型调用 -> 工具执行 -> 结果回传 -> 终端渲染"的全部 17 步。
