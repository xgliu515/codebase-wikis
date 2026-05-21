# 第 10 章 TUI:差分渲染引擎与终端控制

> **版本锁定**:本章内容基于 commit `4868222e`(2026-05-20),所有行号引用均对应该快照,后续提交可能造成偏移。

---

## 10.1 为什么自造 TUI 库

市面上已有 [ink](https://github.com/vadimdemedes/ink)、[blessed](https://github.com/chjj/blessed) 等成熟方案,pi 仍选择从零实现 `packages/tui`。理由如下:

**差分渲染性能**:ink 基于 React 虚拟 DOM,在频繁更新(streaming token、动画帧)时,reconciler 的开销在慢终端上是可感知的。pi 的差分算法直接操作字符串行数组,找出最小变更集后仅重绘变化行,避免全屏刷新。

**纯函数式组件契约**:`Component.render(width): string[]` 是无副作用的纯函数——给定宽度,返回字符串行数组。没有状态管理框架,没有 fiber,没有异步调度器。渲染完全同步,便于测试和推理。

**SSH 慢链路鲁棒**:慢速 SSH 下 escape sequence 可能被拆包跨多个 `data` 事件到达。`StdinBuffer` 层实现了完整性检测和超时 flush 机制,避免半截 escape 被误判为文本。

**Kitty 协议需求**:ink/blessed 均不支持 Kitty graphics protocol(终端内图片渲染)和 Kitty keyboard protocol(key release 事件)。pi 的图片渲染和键盘处理需要在 TUI 层原生支持这两个协议。

---

## 10.2 Component 接口:纯函数渲染契约

`tui.ts:39-63`

```typescript
export interface Component {
  render(width: number): string[];   // 核心:给定宽度,返回行字符串数组
  handleInput?(data: string): void;  // 可选:有焦点时接收键盘输入
  wantsKeyRelease?: boolean;         // 可选:是否接收 Kitty key release 事件
  invalidate(): void;                // 强制使缓存失效
}
```

**为什么是 `string[]` 而不是事件回调**:

字符串数组模型有以下优势:
1. **可组合**:父组件收集子组件的行数组,拼接后再整体处理(加边框、叠加 overlay)。
2. **可 diff**:上一帧和当前帧都是 `string[]`,逐行字符串比较是 O(n) 的,且利用 V8 的字符串内化(string interning)极快。
3. **无状态**:组件自身不驱动渲染计时,TUI 统一调度,避免多个组件各自 `setInterval` 造成写冲突。
4. **SSH 友好**:渲染结果在内存中组装成完整 buffer 后一次性写出,减少系统调用次数。

---

## 10.3 TUI 类核心

`tui.ts:239-1319`

`TUI` 继承 `Container`(一个简单的 `Component[]` 集合),持有一个 `Terminal` 引用,负责整个渲染生命周期。

### 10.3.1 核心状态

```typescript
class TUI extends Container {
  private previousLines: string[] = [];    // 上一帧行数组
  private previousWidth = 0;              // 上一帧终端宽度
  private previousHeight = 0;             // 上一帧终端高度
  private cursorRow = 0;                  // 逻辑光标行(内容末尾)
  private hardwareCursorRow = 0;          // 终端实际光标行(IME 定位用)
  private maxLinesRendered = 0;           // 历史最大渲染行数(高水位线)
  private previousViewportTop = 0;        // 上一帧 viewport 起始行
  private overlayStack: OverlayEntry[];   // 模态覆盖层堆栈
}
```

### 10.3.2 主循环结构

渲染由外部事件触发(输入、resize、组件主动调用 `requestRender()`),而非固定帧率轮询。

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="TUI 主循环结构：从事件触发到差分渲染">
  <defs>
    <marker id="arR101" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="60" y="10" width="580" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="350" y="30" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">stdin data / resize / component invalidate</text>
  <line x1="350" y1="40" x2="350" y2="60" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR101)"/>
  <rect x="200" y="62" width="300" height="28" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="350" y="81" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">requestRender()</text>
  <line x1="350" y1="90" x2="350" y2="110" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR101)"/>
  <rect x="160" y="112" width="380" height="44" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="350" y="131" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">scheduleRender()</text>
  <text x="350" y="149" text-anchor="middle" font-size="10" fill="#64748b">setTimeout(doRender, max(0, 16ms − elapsed))</text>
  <line x1="350" y1="156" x2="350" y2="176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR101)"/>
  <rect x="100" y="178" width="500" height="126" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="350" y="198" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">doRender()</text>
  <rect x="120" y="206" width="220" height="22" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="230" y="221" text-anchor="middle" font-size="10" fill="#7c3aed">render(width) ← 收集 string[]</text>
  <rect x="120" y="234" width="220" height="22" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="230" y="249" text-anchor="middle" font-size="10" fill="#7c3aed">compositeOverlays() ← overlay 叠加</text>
  <rect x="360" y="206" width="220" height="22" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="470" y="221" text-anchor="middle" font-size="10" fill="#7c3aed">extractCursorPosition() ← CURSOR_MARKER</text>
  <rect x="360" y="234" width="220" height="22" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="470" y="249" text-anchor="middle" font-size="10" fill="#7c3aed">applyLineResets() ← \x1b[0m 重置</text>
  <rect x="120" y="262" width="460" height="22" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="350" y="277" text-anchor="middle" font-size="10" fill="#0d9488">差分渲染算法 ← 见 10.3.3</text>
</svg>
<span class="figure-caption">图 R10.1 ｜ TUI 主循环结构——事件驱动触发、16ms 限速、doRender 五阶段</span>

<details>
<summary>ASCII 原版</summary>

```
stdin data / resize / component invalidate
          │
          ▼
requestRender()
  └── scheduleRender()
        └── setTimeout(doRender, max(0, 16ms - elapsed))
                  │
                  ▼
              doRender()
                ├── render(width)          ← 收集所有子组件的 string[]
                ├── compositeOverlays()    ← 将 overlay 内容叠加到基础行
                ├── extractCursorPosition() ← 找到 CURSOR_MARKER,记录位置
                ├── applyLineResets()      ← 每行末尾追加 \x1b[0m 重置
                └── 差分渲染算法          ← 见 10.3.3
```

</details>

**MIN_RENDER_INTERVAL_MS = 16ms** 的限速(`tui.ts:253`):防止在高频事件(streaming token)下过度重绘。`requestRender()` 是幂等的,多次调用只产生一次渲染。

### 10.3.3 差分渲染算法

`tui.ts:953-1280`

差分算法的核心逻辑在 `doRender()` 的后半部分。以下用伪代码描述关键分支:

```
doRender():
  newLines = render(width)          # 当前帧
  previousLines = this.previousLines  # 上一帧

  # --- 全量重绘条件 ---
  if 首次渲染:          fullRender(clear=false)
  if 终端宽度变化:       fullRender(clear=true)    # 宽度变化导致换行改变
  if 终端高度变化:       fullRender(clear=true)    # 高度变化导致 viewport 偏移
  if clearOnShrink && newLines < maxLinesRendered:
                         fullRender(clear=true)    # 内容缩短,清除多余行

  # --- 差分计算 ---
  firstChanged = -1
  lastChanged  = -1
  for i in range(max(len(newLines), len(previousLines))):
    if previousLines[i] != newLines[i]:
      if firstChanged == -1: firstChanged = i
      lastChanged = i

  if firstChanged == -1:
    # 内容完全相同,只需重新定位硬件光标
    positionHardwareCursor(cursorPos, newLines.length)
    return

  # --- 增量输出 ---
  buffer = "\x1b[?2026h"                        # 开始同步输出(防撕裂)
  buffer += deleteChangedKittyImages(...)       # 删除被修改行上的 Kitty 图片
  移动光标到 firstChanged 行 (cursor up/down)
  for i in [firstChanged .. lastChanged]:
    buffer += "\r\x1b[2K"                       # 移到行首,清除整行
    buffer += newLines[i]                       # 写入新内容
  if previousLines.length > newLines.length:
    # 内容行数减少:清除多余旧行
    for extra lines: "\r\n\x1b[2K"
    buffer += cursor up N lines
  buffer += "\x1b[?2026l"                       # 结束同步输出
  terminal.write(buffer)
  positionHardwareCursor(cursorPos, newLines.length)
```

**`maxLinesRendered` 高水位线**:记录历史上曾经渲染的最大行数。这解决了一个问题:当内容行数从 50 缩减到 30 时,第 31-50 行的旧内容仍留在终端屏幕上,需要主动清除。

**同步输出 (`?2026h`/`?2026l`)**:DEC private mode 2026,让终端在收到完整 buffer 后才刷新屏幕,消除增量写入时的闪烁。

**光标定位用绝对行移动**:`\x1b[NB`(向下 N 行)或 `\x1b[NA`(向上 N 行)。为了正确计算移动量,TUI 同时维护 `cursorRow`(逻辑内容末尾)和 `hardwareCursorRow`(终端实际光标位置)两个独立状态。

### 10.3.4 双缓冲与直接写的取舍

pi 选择"在内存中组装完整 buffer 后一次性 `write()`"(类似双缓冲的输出侧),而非逐行写出。原因:
- **减少系统调用**:每次 `write()` 是一次系统调用,合并写减少开销。
- **与同步输出配合**:整个 buffer 在 `?2026l` 之前发送,终端能作为一个整体处理。
- **无需真正的双缓冲**:帧间差异通过 `previousLines` 追踪,不需要额外的渲染缓冲区。

---

## 10.4 ProcessTerminal:raw mode 与终端控制

`terminal.ts:64-403`

`ProcessTerminal` 是 `Terminal` 接口的实现,封装了 `process.stdin`/`process.stdout` 的底层操作。

### 10.4.1 raw mode 切换

```typescript
// terminal.ts:96-100
this.wasRaw = process.stdin.isRaw || false;
if (process.stdin.setRawMode) {
  process.stdin.setRawMode(true);
}
process.stdin.setEncoding("utf8");
process.stdin.resume();
```

raw mode 下终端不再对输入做行缓冲和回显,每个按键立即触发 `data` 事件。`wasRaw` 记录进入前的状态,`stop()` 时恢复。

### 10.4.2 stdin/stdout 抽象

`Terminal` 接口提供了一套平台无关的操作:
- `write(data)`:写到 stdout,同时支持写入调试日志(`PI_TUI_WRITE_LOG` 环境变量)
- `hideCursor()`/`showCursor()`:ANSI `?25l`/`?25h`
- `clearLine()`/`clearFromCursor()`:ANSI `K`/`J` erase 序列
- `moveBy(lines)`:ANSI cursor up/down
- `setTitle(title)`:OSC 0 序列

### 10.4.3 resize 信号

```typescript
// terminal.ts:107-113
process.stdout.on("resize", this.resizeHandler);
if (process.platform !== "win32") {
  process.kill(process.pid, "SIGWINCH");  // 刷新尺寸
}
```

挂载 `stdout` 的 `"resize"` 事件;SIGWINCH 信号在 suspend/resume 后更新尺寸。

### 10.4.4 退出时还原

`stop()` 方法依次:
1. 清除进度条定时器
2. 禁用 bracketed paste mode(`?2004l`)
3. 禁用 Kitty keyboard protocol(`\x1b[<u`)
4. 销毁 StdinBuffer
5. 移除所有事件监听器
6. `process.stdin.pause()`(防止缓存输入泄漏到父 shell)
7. 恢复 raw mode 原始状态

---

## 10.5 StdinBuffer:慢链路 escape sequence 完整性保证

`stdin-buffer.ts:1-434`

### 10.5.1 问题背景

SSH 连接上,一个 escape sequence 可能被分拆到多个 TCP 包中,导致 `stdin` 的 `data` 事件分多次触发:

```
Event 1: "\x1b"
Event 2: "[<35"
Event 3: ";20;5m"   ← SGR mouse event 才完整
```

直接处理 `data` 事件会把 `"\x1b"` 误判为 Escape 键。

### 10.5.2 解决机制

`StdinBuffer` 维护一个内部 `buffer` 字符串,每次收到数据都追加进去,然后尝试从头部提取完整序列:

```typescript
// stdin-buffer.ts:192-254
function extractCompleteSequences(buffer: string): { sequences: string[]; remainder: string }
```

完整性判断函数 `isCompleteSequence()` 按序列类型检测:
- **CSI** (`\x1b[...`):以 `0x40-0x7E` 范围内的字节结尾(`@`-`~`)
- **OSC** (`\x1b]...`):以 `\x07`(BEL)或 `\x1b\\`(ST)结尾
- **APC** (`\x1b_...`):以 `\x1b\\` 结尾(Kitty graphics 响应)
- **DCS** (`\x1bP...`):以 `\x1b\\` 结尾

如果 buffer 末尾有不完整序列,设置一个 10ms 超时定时器(`timeout` 选项可配置)。超时触发时强制 flush,避免序列永远等待。

### 10.5.3 Bracketed paste 特殊处理

`\x1b[200~` 开始、`\x1b[201~` 结束的 paste 内容不走 escape sequence 解析逻辑,而是整体收集后作为 `"paste"` 事件发射(`stdin-buffer.ts:315-369`)。这避免 paste 内容中恰好含有 escape 字符时被误解析。

### 10.5.4 Kitty printable codepoint 去重

Kitty keyboard protocol 的 disambiguate 模式(flag 1)会为普通字符也发送 CSI-u 序列,但同时仍可能发送原始字符码。`StdinBuffer` 检测到 CSI-u 后记录 codepoint(`pendingKittyPrintableCodepoint`),下一个事件如果是对应的原始字符则跳过,避免重复触发。

---

## 10.6 Kitty 协议支持

### 10.6.1 终端能力探测

`terminal-image.ts:42-93`

```typescript
export function detectCapabilities(): TerminalCapabilities {
  const inTmuxOrScreen = !!process.env.TMUX || term.startsWith("tmux") || ...;
  if (inTmuxOrScreen) return { images: null, trueColor: ..., hyperlinks: false };

  if (process.env.KITTY_WINDOW_ID || termProgram === "kitty")
    return { images: "kitty", trueColor: true, hyperlinks: true };
  if (termProgram === "ghostty" || process.env.GHOSTTY_RESOURCES_DIR)
    return { images: "kitty", trueColor: true, hyperlinks: true };
  if (process.env.WEZTERM_PANE || termProgram === "wezterm")
    return { images: "kitty", trueColor: true, hyperlinks: true };
  if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app")
    return { images: "iterm2", trueColor: true, hyperlinks: true };
  // ...
}
```

探测通过环境变量(`KITTY_WINDOW_ID`、`TERM_PROGRAM`、`GHOSTTY_RESOURCES_DIR` 等)静态判断,无需发送探测序列。tmux/screen 下强制禁用图片和超链接——这两个复用器默认不透传 OSC/APC 序列。

### 10.6.2 图片渲染:Kitty Image Protocol

`terminal-image.ts:126-170`

Kitty image protocol 编码步骤:
1. 图片数据以 base64 编码
2. 分块传输,每块 ≤ 4096 字节(`CHUNK_SIZE`)
3. 每块包装在 `\x1b_G...;data\x1b\\` (APC) 中
4. 首块包含参数:`a=T`(传输动作)、`f=100`(PNG 格式)、`c=N`(列数)、`r=N`(行数)、`i=ID`(图片 ID)
5. 中间块:`\x1b_Gm=1;data\x1b\\`
6. 最后块:`\x1b_Gm=0;data\x1b\\`

```typescript
// terminal-image.ts:126-170
export function encodeKitty(base64Data: string, options): string {
  const params: string[] = ["a=T", "f=100", "q=2"];  // q=2=静默
  if (options.moveCursor === false) params.push("C=1");
  // ...
  if (base64Data.length <= CHUNK_SIZE) {
    return `\x1b_G${params.join(",")};${base64Data}\x1b\\`;
  }
  // 分块...
}
```

**图片 ID 管理**:每次渲染分配随机 ID(`allocateImageId()` 使用 `Math.random()`)。差分渲染时,若某行上的图片 ID 发生变化,先发送删除命令再重新传输:

```typescript
// terminal-image.ts:176-178
export function deleteKittyImage(imageId: number): string {
  return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;  // d=I 同时释放显存
}
```

**清屏注意**:图片行在 `isImageLine()` 检测为 true 后,差分算法绕过 `visibleWidth()` 检查(图片行的可见宽度无法准确测量),并确保相关行上的 Kitty 图片 ID 被删除(`expandLastChangedForKittyImages`,`tui.ts:850-858`)。

**iTerm2 兼容**:对 `images: "iterm2"` 使用 `encodeITerm2()`,格式为 `\x1b]1337;File=...;base64\x07`。由于 iTerm2 图片占多行但光标只前进一行,`Image` 组件需要发出额外的光标上移序列:

```typescript
// image.ts:105-111
const moveUp = rowOffset > 0 ? `\x1b[${rowOffset}A` : "";
lines.push(moveUp + result.sequence);
```

### 10.6.3 Key release 事件

`ProcessTerminal.start()` 启动后:
1. 向终端发送 `\x1b[?u`(查询当前 Kitty keyboard flags)
2. `StdinBuffer` 监听响应 `\x1b[?<flags>u`
3. 检测到响应后,发送 `\x1b[>7u`(push flags:1=消歧义 + 2=报告事件类型 + 4=alternate keys)
4. 此后 key release 事件以 `:3u`/`:3~`/`:3A` 等后缀标识

`TUI.handleInput()` 过滤 release 事件(`tui.ts:590-596`):

```typescript
if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
  return;
}
```

只有将 `wantsKeyRelease = true` 的组件(如 Doom Overlay 示例)才会收到 release 事件。

---

## 10.7 光标管理

### 10.7.1 硬件光标与 IME 定位

pi 默认隐藏硬件光标(`terminal.hideCursor()`),用组件自己渲染的"假光标"(反色字符)模拟可见光标效果。这样做的原因:每帧渲染时光标会高速移动,保持可见会产生明显闪烁。

但 IME(输候选框)需要知道真实光标位置。`CURSOR_MARKER` 机制解决了这个问题:

```typescript
// tui.ts:90
export const CURSOR_MARKER = "\x1b_pi:c\x07";  // APC 序列,零宽度
```

有焦点的 Input/Editor 组件在光标位置插入 `CURSOR_MARKER`。`TUI.doRender()` 在进行差分比较前扫描所有行,找到 marker 后计算其列位置,再从行内删除 marker。渲染完成后调用 `positionHardwareCursor()`:

```typescript
// tui.ts:1287-1318
private positionHardwareCursor(cursorPos, totalLines): void {
  if (!cursorPos || totalLines <= 0) {
    this.terminal.hideCursor();
    return;
  }
  // 用 cursor up/down + \x1b[NG 移到目标位置
  this.terminal.write(buffer);
  this.hardwareCursorRow = targetRow;
  if (this.showHardwareCursor) {
    this.terminal.showCursor();
  } else {
    this.terminal.hideCursor();
  }
}
```

`showHardwareCursor` 默认为 false(由 `PI_HARDWARE_CURSOR=1` 启用),但光标会被定位到正确位置以支持 IME。

### 10.7.2 焦点管理

`TUI.setFocus(component)` 设置当前焦点组件,同时更新 `Focusable.focused` 标志。组件检查 `this.focused` 决定是否在输出中插入 `CURSOR_MARKER`。

---

## 10.8 Overlay 系统

### 10.8.1 堆栈结构

`tui.ts:263-271`

```typescript
private overlayStack: {
  component: Component;
  options?: OverlayOptions;
  preFocus: Component | null;  // overlay 显示前的焦点组件
  hidden: boolean;
  focusOrder: number;           // 单调递增,越大越在视觉前景
}[]
```

### 10.8.2 compositeOverlays:叠加算法

`tui.ts:757-923`

叠加发生在每帧渲染管线中,在差分比较之前。算法:

1. 按 `focusOrder` 升序排列可见 overlay(焦点最高的在最上层)
2. 计算每个 overlay 的布局(位置、宽度、maxHeight)
3. 扩展基础内容行数组到 `max(内容行数, termHeight, 所有 overlay 最低行)`
4. 计算 `viewportStart = max(0, workingHeight - termHeight)`
5. 对每个 overlay,逐行调用 `compositeLineAt()` 将 overlay 内容"合成"到基础行对应位置

`compositeLineAt()` 的实现是单趟扫描(`tui.ts:874-923`):
- 将基础行切分为 overlay 覆盖区左侧、覆盖区、右侧三段
- 拼接时保留左侧的 ANSI 颜色状态(通过 `extractSegments()` 中的 `AnsiCodeTracker`)
- 最终用 `sliceByColumn()` 确保结果不超过终端宽度

### 10.8.3 焦点与回收

`showOverlay()` 返回 `OverlayHandle`(`tui.ts:329-396`):

```typescript
{
  hide()              // 永久移除
  setHidden(hidden)   // 临时隐藏/显示
  focus()             // 抢夺焦点
  unfocus()           // 释放焦点给下一个可见 overlay 或 preFocus
  isFocused()         // 查询
}
```

当 overlay 隐藏时,焦点回归 `preFocus`(overlay 显示前的组件)。多个 overlay 嵌套时,按 `focusOrder` 逆序查找下一个可见 overlay 来接收焦点。

---

## 10.9 ASCII 流程图:一帧的完整渲染流水线

<svg viewBox="0 0 880 680" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="一帧完整渲染流水线：从 stdin 到终端输出">
  <defs>
    <marker id="arR102" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="280" y="8" width="280" height="28" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="420" y="27" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">stdin chunk arrives</text>
  <line x1="420" y1="36" x2="420" y2="54" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR102)"/>
  <rect x="160" y="56" width="520" height="120" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="420" y="74" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">StdinBuffer.process(data)</text>
  <rect x="178" y="82" width="240" height="20" rx="3" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <text x="298" y="96" text-anchor="middle" font-size="10" fill="#334155">追加到 buffer</text>
  <rect x="178" y="108" width="240" height="34" rx="3" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <text x="298" y="122" text-anchor="middle" font-size="10" fill="#334155">extractCompleteSequences()</text>
  <text x="298" y="136" text-anchor="middle" font-size="10" fill="#64748b">isCompleteSequence() → 列表 + remainder</text>
  <rect x="432" y="82" width="230" height="34" rx="3" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <text x="547" y="96" text-anchor="middle" font-size="10" fill="#334155">emit("data", sequence)</text>
  <text x="547" y="110" text-anchor="middle" font-size="10" fill="#64748b">检测 \x1b[?&lt;N&gt;u → 发 \x1b[&gt;7u</text>
  <rect x="432" y="122" width="230" height="20" rx="3" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <text x="547" y="136" text-anchor="middle" font-size="10" fill="#64748b">buffer 非空 → 10ms flush 定时器</text>
  <line x1="420" y1="176" x2="420" y2="194" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR102)"/>
  <rect x="260" y="196" width="320" height="28" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="420" y="215" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">ProcessTerminal inputHandler(sequence)</text>
  <line x1="420" y1="224" x2="420" y2="242" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR102)"/>
  <rect x="140" y="244" width="560" height="100" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="420" y="262" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">TUI.handleInput(data)</text>
  <rect x="158" y="270" width="240" height="20" rx="3" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <text x="278" y="284" text-anchor="middle" font-size="10" fill="#334155">遍历 inputListeners（extension 拦截）</text>
  <rect x="158" y="296" width="240" height="20" rx="3" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <text x="278" y="310" text-anchor="middle" font-size="10" fill="#64748b">consumeCellSizeResponse() / onDebug()</text>
  <rect x="412" y="270" width="270" height="46" rx="3" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <text x="547" y="284" text-anchor="middle" font-size="10" fill="#334155">focusedComponent.handleInput(data)</text>
  <text x="547" y="298" text-anchor="middle" font-size="10" fill="#64748b">过滤 key release</text>
  <text x="547" y="312" text-anchor="middle" font-size="10" fill="#64748b">触发组件内部状态变更</text>
  <line x1="420" y1="344" x2="420" y2="362" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR102)"/>
  <text x="440" y="356" font-size="10" fill="#94a3b8">组件调用 tui.requestRender()</text>
  <rect x="240" y="364" width="360" height="28" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="420" y="383" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">TUI.requestRender() → scheduleRender()</text>
  <line x1="420" y1="392" x2="420" y2="410" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR102)"/>
  <rect x="100" y="412" width="660" height="256" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="420" y="432" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">TUI.doRender()</text>
  <rect x="118" y="440" width="290" height="34" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="263" y="454" text-anchor="middle" font-size="10" fill="#7c3aed">render(width) ← Container.render()</text>
  <text x="263" y="468" text-anchor="middle" font-size="10" fill="#64748b">for each child: child.render() → 收集 string[]</text>
  <rect x="422" y="440" width="320" height="34" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="582" y="454" text-anchor="middle" font-size="10" fill="#7c3aed">compositeOverlays(lines, w, h)</text>
  <text x="582" y="468" text-anchor="middle" font-size="10" fill="#64748b">overlay 叠加到基础行</text>
  <rect x="118" y="482" width="290" height="34" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="263" y="496" text-anchor="middle" font-size="10" fill="#7c3aed">extractCursorPosition(lines, height)</text>
  <text x="263" y="510" text-anchor="middle" font-size="10" fill="#64748b">查找 CURSOR_MARKER → {row, col}</text>
  <rect x="422" y="482" width="320" height="34" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="582" y="496" text-anchor="middle" font-size="10" fill="#7c3aed">applyLineResets(lines)</text>
  <text x="582" y="510" text-anchor="middle" font-size="10" fill="#64748b">每行末尾追加 \x1b[0m\x1b]8;;\x07</text>
  <rect x="118" y="524" width="290" height="34" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="263" y="538" text-anchor="middle" font-size="10" font-weight="600" fill="#0d9488">[全量重绘] 宽高变化 / 首次渲染</text>
  <text x="263" y="552" text-anchor="middle" font-size="10" fill="#64748b">terminal.write(clearSeq + all lines)</text>
  <rect x="422" y="524" width="320" height="34" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="582" y="538" text-anchor="middle" font-size="10" font-weight="600" fill="#0d9488">[差分渲染] firstChanged..lastChanged</text>
  <text x="582" y="552" text-anchor="middle" font-size="10" fill="#64748b">\x1b[?2026h + Kitty del + 逐行 \r\x1b[2K</text>
  <rect x="118" y="566" width="624" height="28" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="430" y="584" text-anchor="middle" font-size="10" font-weight="600" fill="#7c3aed">positionHardwareCursor(cursorPos, ...) → showCursor() / hideCursor()</text>
</svg>
<span class="figure-caption">图 R10.2 ｜ 一帧完整渲染流水线——stdin 输入经 StdinBuffer → handleInput → requestRender → doRender 六级处理</span>

<details>
<summary>ASCII 原版</summary>

```
stdin chunk arrives
       │
       ▼
StdinBuffer.process(data)
  ├── 追加到 buffer
  ├── extractCompleteSequences()
  │     ├── isCompleteSequence() 判断
  │     └── 提取完整序列列表,remainder 留在 buffer
  ├── emit("data", sequence)   ─ 对每个完整序列
  │     └── 检测 Kitty 协议响应 \x1b[?<N>u
  │           → 发送 \x1b[>7u 启用协议
  └── 若 buffer 非空,设置 10ms flush 定时器
       │
       ▼
ProcessTerminal inputHandler(sequence)
       │
       ▼
TUI.handleInput(data)
  ├── 遍历 inputListeners (可被 extension 拦截)
  ├── consumeCellSizeResponse()  ← \x1b[6;<h>;<w>t
  ├── Shift+Ctrl+D → onDebug()
  ├── 检查 focused overlay 是否仍可见
  └── focusedComponent.handleInput(data)
        ├── 过滤 key release (除非 wantsKeyRelease)
        └── 触发组件内部状态变更
       │
       ▼ (组件调用 tui.requestRender())
TUI.requestRender()
  └── scheduleRender() → setTimeout(doRender, delay)
       │
       ▼
TUI.doRender()
  ├── render(width)                          ← Container.render()
  │     └── for each child: child.render()  ← 收集 string[]
  ├── compositeOverlays(lines, w, h)
  │     └── 将 overlay 内容叠加到基础行
  ├── extractCursorPosition(lines, height)
  │     └── 查找 CURSOR_MARKER,返回 {row, col}
  ├── applyLineResets(lines)
  │     └── 每行末尾追加 \x1b[0m\x1b]8;;\x07
  │
  ├── [全量重绘] 若宽高变化 / 首次渲染
  │     └── terminal.write(clearSeq + all lines)
  │
  └── [差分渲染] 找 firstChanged..lastChanged
        ├── build buffer = \x1b[?2026h
        │     + deleteChangedKittyImages(...)
        │     + cursor move to firstChanged
        │     + for i in changed: \r\x1b[2K + newLines[i]
        │     + \x1b[?2026l
        ├── terminal.write(buffer)
        └── positionHardwareCursor(cursorPos, ...)
              ├── cursor move to target row/col
              └── showCursor() / hideCursor()
```

</details>

---

## 10.10 性能注意:utils.ts 对 diff 的影响

差分算法用 `previousLines[i] !== newLines[i]` 做字符串相等判断,这是 O(n) 字符串比较。`utils.ts` 中多个工具函数对性能有直接影响:

### 10.10.1 visibleWidth() 的 ASCII 快速路径

`utils.ts:201-256`

```typescript
export function visibleWidth(str: string): number {
  if (isPrintableAscii(str)) return str.length;  // O(n) 但无内存分配
  const cached = widthCache.get(str);
  if (cached !== undefined) return cached;
  // ...计算 + 缓存
}
```

- 纯 ASCII 字符串走快速路径,无分配,无缓存查找。
- 非 ASCII 字符串用 LRU 缓存(最多 512 条),相同字符串第二次调用 O(1)。
- 宽字符计算依赖 `get-east-asian-width` 库的 `eastAsianWidth()` 函数,以及 Intl.Segmenter 进行 grapheme 分割。

### 10.10.2 East Asian 宽字符在 diff 中的影响

如果一行含有全角字符(如中文、日文),其 `visibleWidth` 比 `.length` 大——同样的终端列数需要更少的 Unicode 字符。差分渲染假设 `newLines[i]` 的 `visibleWidth` 不超过终端宽度;如果超过,会触发崩溃日志并抛出错误(`tui.ts:1182-1207`)。

所有渲染宽字符的组件必须使用 `truncateToWidth()`/`sliceByColumn()` 而非简单的 `str.slice()`。

### 10.10.3 ANSI slicing:sliceByColumn()

`utils.ts:1009-1059`

overlay compositing 和 input 水平滚动都需要从含 ANSI 码的字符串中取出特定列范围。`sliceByColumn(line, startCol, length)` 在扫描时跳过 ANSI 序列,按可见列计数,正确处理宽字符边界(strict 模式下宽字符不跨边界截断)。

### 10.10.4 normalizeTerminalOutput() 的泰文/老挝语修正

`utils.ts:267-270`

泰文/老挝文的 AM 元音(`ำ`、`ຳ`)在部分终端渲染器的差分刷新下会产生留影。`applyLineResets()` 中每行都调用此函数进行规范化分解,以兼容性分解形式替换这两个字符,消除终端 bug。

---

## 10.11 OverlayOptions 详细规范

Overlay 的定位和尺寸由 `OverlayOptions`（`tui.ts:141-177`）控制。其设计兼顾了像素级精确定位和响应式百分比定位两种需求。

### 10.11.1 尺寸参数

```typescript
export interface OverlayOptions {
    width?: SizeValue;       // 宽度：列数 或 "50%"（终端宽度的百分比）
    minWidth?: number;       // 最小宽度（绝对列数）
    maxHeight?: SizeValue;   // 最大高度：行数 或 "80%"
    // ...
}
```

`SizeValue = number | \`${number}%\``（`tui.ts:119`）。`parseSizeValue(value, referenceSize)` 在 `compositeOverlays()` 中被调用，将百分比转换为当前终端尺寸下的绝对值。

### 10.11.2 定位参数（两种模式）

**锚点模式**（`anchor` + `offsetX`/`offsetY`）：

```
anchor 可选值：
  "center"        "top-left"      "top-right"
  "bottom-left"   "bottom-right"  "top-center"
  "bottom-center" "left-center"   "right-center"
```

例：`{ anchor: "bottom-center", offsetY: -2 }` 将 overlay 放在终端底部中央，向上偏移 2 行。这是自动补全列表的默认定位方式。

**绝对/百分比模式**（`row` + `col`）：直接指定 overlay 左上角的行列位置，支持绝对数字或百分比字符串。

### 10.11.3 可见性条件与 nonCapturing

```typescript
visible?: (termWidth: number, termHeight: number) => boolean;
nonCapturing?: boolean;
```

`visible` 回调在每帧渲染时被调用。若返回 `false`，overlay 的渲染输出被跳过，焦点不转移到该 overlay。当终端窗口过小时可用此机制自动隐藏复杂 overlay。

`nonCapturing: true` 让 overlay 显示时不抢占键盘焦点，用于非交互式的信息展示（如 Toast 通知）。

---

## 10.12 requestRender 的幂等性与 force 模式

`tui.ts:495-542`

### 10.12.1 常规请求（幂等）

```typescript
requestRender(force = false): void {
    if (force) { /* ... */ return; }
    if (this.renderRequested) return;     // 幂等：已有待处理渲染则忽略
    this.renderRequested = true;
    process.nextTick(() => this.scheduleRender());
}
```

`process.nextTick` 将 `scheduleRender()` 推入微任务队列（在当前事件循环轮次结束后立即执行），确保同一轮事件中的多次 `requestRender()` 调用只产生一次 `scheduleRender()`。

`scheduleRender()` 再根据距上次渲染的间隔决定是立即调用 `doRender()` 还是延迟最多 16ms。这个双重缓冲（nextTick + setTimeout 限速）的组合使得高频事件（streaming token 每隔几毫秒到达）不会造成 CPU 过载。

### 10.12.2 强制渲染（全量重绘）

`requestRender(true)` 清空所有缓存状态（`previousLines = []`、`previousWidth = -1`、`maxLinesRendered = 0`），并通过 `process.nextTick` **绕过限速**立即触发下一帧渲染。用于主题切换、配置重载等需要完整重绘的场景。

### 10.12.3 stopped 标志

`tui.stop()` 设置 `this.stopped = true`。所有渲染路径在开始前检查此标志，一旦 `stop()` 被调用，后续 `requestRender()` 不会产生任何渲染。这防止了异步渲染在 TUI 已销毁后继续写入 stdout 的问题。

---

## 10.13 handleInput 的完整分发链

`tui.ts:544-633`（`TUI.handleInput`）：

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="handleInput 完整分发链：从 inputListeners 到 focusedComponent">
  <defs>
    <marker id="arR103" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="80" y="8" width="560" height="50" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="360" y="27" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">inputListeners 集合</text>
  <text x="360" y="43" text-anchor="middle" font-size="10" fill="#64748b">consume: true → 立即返回 ｜ {data: newData} → 替换继续传递</text>
  <line x1="360" y1="58" x2="360" y2="76" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR103)"/>
  <rect x="80" y="78" width="560" height="46" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="360" y="96" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">consumeCellSizeResponse(data)</text>
  <text x="360" y="116" text-anchor="middle" font-size="10" fill="#64748b">识别 \x1b[6;&lt;rows&gt;;&lt;cols&gt;t → 更新 cell dimensions；命中则返回</text>
  <line x1="360" y1="124" x2="360" y2="142" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR103)"/>
  <rect x="80" y="144" width="560" height="28" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="360" y="163" text-anchor="middle" font-size="11" fill="#0d9488">matchesKey(data, "shift+ctrl+d") → onDebug() 调试钩子</text>
  <line x1="360" y1="172" x2="360" y2="190" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR103)"/>
  <rect x="80" y="192" width="560" height="46" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="360" y="210" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">focusedOverlay 可见性检查</text>
  <text x="360" y="230" text-anchor="middle" font-size="10" fill="#64748b">overlay 不再可见 → 转移焦点至 getTopmostVisibleOverlay()</text>
  <line x1="360" y1="238" x2="360" y2="256" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR103)"/>
  <rect x="80" y="258" width="560" height="46" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="360" y="276" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">isKeyRelease(data) &amp;&amp; !wantsKeyRelease</text>
  <text x="360" y="296" text-anchor="middle" font-size="10" fill="#64748b">→ 丢弃 key release 事件</text>
  <line x1="360" y1="304" x2="360" y2="322" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR103)"/>
  <rect x="80" y="324" width="560" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="360" y="343" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">focusedComponent.handleInput(data)</text>
  <text x="360" y="360" text-anchor="middle" font-size="10" fill="#64748b">组件内部处理 → 状态变更 → requestRender()</text>
</svg>
<span class="figure-caption">图 R10.3 ｜ handleInput 完整分发链——五级过滤后到达 focusedComponent</span>

<details>
<summary>ASCII 原版</summary>

```
inputListeners 集合
  （扩展可通过 pi.ui.onTerminalInput() 注册）
  若任一 listener 返回 { consume: true } → 立即返回
  若返回 { data: newData } → 替换 data 继续传递

  ↓
consumeCellSizeResponse(data)
  识别 \x1b[6;<rows>;<cols>t（终端尺寸响应）
  → 更新 cell dimensions（用于 Kitty 图像尺寸计算）
  → 若命中则返回 true，跳过后续处理

  ↓
matchesKey(data, "shift+ctrl+d") → onDebug() 调试钩子

  ↓
focusedOverlay 可见性检查
  若焦点所在 overlay 不再可见：
    → 转移焦点至 getTopmostVisibleOverlay()

  ↓
isKeyRelease(data) && !focusedComponent.wantsKeyRelease
  → 丢弃 key release 事件

  ↓
focusedComponent.handleInput(data)
```

</details>

`inputListeners` 允许扩展拦截、修改或消费任意键盘输入，早于组件处理。这是扩展实现全局快捷键的机制之一（另一个是通过 `registerShortcut` 注册到 `ExtensionRunner`）。

---

## 10.14 Container 的组合层次

`TUI extends Container`（`tui.ts:200-233`），`Container.render(width)` 遍历 `children` 数组，依次调用每个子组件的 `render(width)` 并将结果行数组拼接：

```typescript
// tui.ts:224-233
render(width: number): string[] {
    const lines: string[] = [];
    for (const child of this.children) {
        const childLines = child.render(width);
        for (const line of childLines) {
            lines.push(line);
        }
    }
    return lines;
}
```

所有子组件共享同一 `width`——TUI 不做流式布局，不分配宽度。这简化了实现，但意味着子组件彼此不"知道"对方。若需要水平分栏，调用方需要自己计算宽度后传给各组件。

`Box`（`components/box.ts`）是唯一内建水平收缩的组件（通过 `paddingX`），其子组件接收的宽度是 `width - paddingX * 2`。

---

## 10.15 差分算法的边界情况处理

### 10.15.1 内容缩短时的行清除

当当前帧行数少于上一帧时，TUI 需要清除多余行。由于终端没有"删除行"操作，清除通过写入空白行实现：

```
cursor 移到 lastChanged 行的末尾
for 每个多余旧行:
    "\r\n\x1b[2K"    ← 换行 + 清除整行
cursor up N 行（回到内容末尾）
```

但这有一个性能问题：每次内容缩短都需要额外的 I/O。`clearOnShrink` 标志（`PI_CLEAR_ON_SHRINK=1`）控制此行为，默认关闭——默认情况下，内容缩短时 TUI 改用全量重绘（重置 `previousLines = []`）而非逐行清除。

### 10.15.2 maxLinesRendered 高水位线的必要性

考虑场景：TUI 渲染了 50 行内容，然后所有内容被清空（如清空会话历史），当前帧只有 5 行。差分算法只会更新前 5 行，但终端屏幕上第 6-50 行仍有旧内容可见。

`maxLinesRendered` 记录历史最大行数。全量重绘时，`clearOnShrink` 模式通过 `\x1b[J`（清除光标后所有内容）而非 `maxLinesRendered` 次清行来处理，更高效。

### 10.15.3 宽度变化的全量重绘

终端宽度变化（用户拖动窗口）会改变所有组件的折行结果，使得 `previousLines` 的每行内容都可能发生变化。差分算法会找到"从第 0 行到最后一行都不同"的情况，退化为全量重绘，消耗与全量相同的 I/O。

因此，`doRender()` 在检测到 `width !== previousWidth` 时直接进入全量重绘路径（而非先差分再写全部行），并附带终端清屏（`\x1b[2J`）避免旧行宽度不同时的视觉残留。

---

## 10.16 Kitty 图片行的差分特殊处理

包含 Kitty 图片序列的行（`isImageLine(line) === true`）在差分算法中有特殊路径：

**`expandLastChangedForKittyImages()`**（`tui.ts:850-858`）：若 `lastChanged` 行之后紧跟着图片行，自动扩展 `lastChanged` 包含这些图片行。原因：差分算法仅清除 `firstChanged..lastChanged` 范围内的行，若图片行在此范围之外，Kitty 终端不会自动清除旧图片。

**`deleteChangedKittyImages()`**：在差分写入前，对所有即将被重写的行，若其上有 Kitty 图片 ID（通过 `extractKittyImageIds()` 提取），先发送 `deleteKittyImage(id)` 序列。若不删除直接覆盖行文本，Kitty 图片会残留在屏幕上（因为图片数据存在 GPU 显存中，行文本替换不会自动清除它）。

`previousKittyImageIds`（`tui.ts:242`）是一个 `Set<number>`，跟踪上一帧所有已知的图片 ID。若某 ID 在本帧消失，同样需要发送删除序列。

---

## 10.17 Terminal 接口与可测试性

`ProcessTerminal` 实现了 `Terminal` 接口（`terminal.ts`）。`TUI` 构造函数接收 `Terminal` 接口而非具体类：

```typescript
// tui.ts:239
export class TUI extends Container {
    public terminal: Terminal;
    // ...
    constructor(terminal: Terminal, showHardwareCursor?: boolean) {
```

这使得测试可以注入 `MockTerminal`：记录所有 `write()` 调用，模拟 `resize` 事件，断言渲染输出内容。`packages/tui/src/__tests__/` 目录下的测试文件利用了这一设计。

### Terminal 接口关键方法

```typescript
interface Terminal {
    readonly rows: number;              // 终端行数
    readonly cols: number;              // 终端列数
    write(data: string): void;          // 写入 stdout
    hideCursor(): void;                 // \x1b[?25l
    showCursor(): void;                 // \x1b[?25h
    moveBy(lines: number): void;        // 光标上移/下移 N 行
    clearLine(): void;                  // \x1b[2K
    clearFromCursor(): void;            // \x1b[J
    setTitle(title: string): void;      // OSC 0
    stop(): void;                       // 还原 raw mode
    on(event: "resize", handler): void; // resize 事件
    on(event: "data", handler): void;   // 输入数据事件
}
```

---

## 10.18 调试辅助：PI_TUI_WRITE_LOG

`terminal.ts` 支持通过环境变量 `PI_TUI_WRITE_LOG=/tmp/pi-tui.log` 将所有 `write()` 调用记录到文件。记录格式包括时间戳和原始字节（含 escape 序列的人可读表示）。

在诊断差分算法问题（如重绘频率异常高、特定字符触发全量重绘）时，分析此日志文件可以看到每帧的实际输出序列，验证 `?2026h/l` 同步输出的范围是否正确，以及光标移动序列是否符合预期。

类似地，`PI_HARDWARE_CURSOR=1` 可以让 TUI 显示真实硬件光标（默认仅定位不显示），用于调试 IME 候选框定位问题。

---

## 10.19 参考文件索引

| 文件 | 关键位置 | 说明 |
|------|---------|------|
| `tui.ts:39-63` | `Component` 接口 | 核心渲染契约 |
| `tui.ts:74-82` | `Focusable` 接口 | 光标管理 |
| `tui.ts:90` | `CURSOR_MARKER` | APC 零宽标记 |
| `tui.ts:119-177` | `SizeValue`；`OverlayOptions` | 覆盖层定位 |
| `tui.ts:182-195` | `OverlayHandle` | 覆盖层控制 API |
| `tui.ts:200-233` | `Container` | 组合层次 |
| `tui.ts:239-280` | `TUI` 状态字段 | 渲染器核心状态 |
| `tui.ts:311-396` | `showOverlay()` | Overlay 显示/焦点 |
| `tui.ts:495-542` | `requestRender()` | 渲染调度 |
| `tui.ts:544-633` | `handleInput()` | 输入分发链 |
| `tui.ts:757-923` | `compositeOverlays()` | Overlay 叠加算法 |
| `tui.ts:953-1280` | `doRender()` | 差分渲染主体 |
| `tui.ts:1287-1318` | `positionHardwareCursor()` | IME 光标定位 |
| `terminal.ts:64-403` | `ProcessTerminal` | 终端 raw mode |
| `terminal.ts:193-240` | `queryAndEnableKittyProtocol()` | Kitty 键盘探测 |
| `terminal.ts:241-278` | `drainInput()` | 退出时清空输入 |
| `stdin-buffer.ts:29-191` | `isCompleteSequence()` | 序列完整性判断 |
| `stdin-buffer.ts:192-254` | `extractCompleteSequences()` | 序列提取主循环 |
| `stdin-buffer.ts:287-434` | `StdinBuffer.process()` | 缓冲区处理 |
| `terminal-image.ts:42-93` | `detectCapabilities()` | 终端能力探测 |
| `terminal-image.ts:126-170` | `encodeKitty()` | Kitty 图像编码 |
| `terminal-image.ts:176-178` | `deleteKittyImage()` | Kitty 图像删除 |
| `utils.ts:156-199` | `graphemeWidth()` | 字素宽度计算 |
| `utils.ts:201-256` | `visibleWidth()` | 可见宽度（含 LRU 缓存）|
| `utils.ts:267-270` | `normalizeTerminalOutput()` | 泰/老挝文修正 |
| `utils.ts:354-500` | `AnsiCodeTracker` | ANSI 状态追踪 |
| `utils.ts:651-900` | `wrapTextWithAnsi()` | ANSI 折行 |
| `utils.ts:1009-1059` | `sliceByColumn()` | 列宽感知切片 |

---

## 10.20 关键设计决策回顾

本章涉及的每个主要设计选择背后都有具体的工程约束：

**`string[]` 而非 DOM 树**：终端只有行的概念，没有盒子模型。字符串行数组是与终端最直接的 isomorphic 表示，差分算法是逐行比较而非虚拟 DOM reconciliation，复杂度更低。

**推事件的 `requestRender()` 而非拉模式的渲染循环**：拉模式（如游戏引擎的 `requestAnimationFrame`）在组件无变化时仍然每帧调用 `render()`，浪费 CPU。pi 的组件大多是静态内容（工具调用结果），只有输入框和加载动画需要持续更新，推模式更节能。

**APC 序列作为 CURSOR_MARKER**：使用 APC（`\x1b_...\x07`）而非自定义 SGR（如特殊颜色组合）的原因是：APC 在所有标准终端中都是零宽度且不可见的，不影响 `visibleWidth()` 计算，也不影响差分比较（两帧中 CURSOR_MARKER 位置可能变化，但 TUI 在差分前已将其从行字符串中移除）。

**`LOCK_MASK` 屏蔽 Caps Lock/Num Lock**：修饰键位掩码中的第 6、7 位对应 Caps Lock 和 Num Lock。若不屏蔽，`Ctrl+C`（modifier=4）和 Caps Lock + `Ctrl+C`（modifier=68）会被认为是不同的键。对终端应用来说，锁定键不应影响功能键绑定，因此 `matchesKittySequence()` 使用 `actualMod & ~LOCK_MASK` 比较。

**`applyLineResets()` 行末重置**：差分算法写入每一行后，不立即追加 `\x1b[0m`（重置颜色），而是由 `applyLineResets()` 在差分比较前对所有行统一处理。这样做的好处是：`previousLines` 中存储的是"未加重置"的行（便于正确比较），而实际写到 terminal 的是"加了重置"的行（防止 ANSI 颜色状态泄漏到下一行）。OSC 8 超链接同理：每行末尾追加 `\x1b]8;;\x07`（关闭超链接），避免超链接范围意外跨行。

**`fullRedrawCount` 诊断计数器**：`tui.fullRedraws` 属性（`tui.ts:281-283`）统计触发全量重绘的次数。在调试渲染性能时，若此数值持续增长，表明某些条件频繁触发 `widthChanged` 或 `heightChanged`，需要检查终端 resize 事件是否异常频繁，或组件是否错误地改变了行计数。

这三条设计决策共同构成了 pi TUI 的性能合同：静默时零开销、有变化时最小开销、宽高变化时安全回退。
