# 第 11 章 TUI:组件库、键盘输入与编辑器

> 版本锁定：commit `4868222e`(2026-05-20)
> 源码路径：`packages/tui/src/`

---

## 11.1 组件库设计哲学

第 10 章说明了 `Component` 接口的最小契约：`render(width): string[]` 加可选的 `handleInput`/`invalidate`。组件库的目标不是提供"通用框架"，而是为 pi 代理交互会话提供刚好够用的十二个具体组件——它们共享三条核心设计原则：

**纯函数渲染**：`render()` 不应有副作用，也不应持有对 terminal/stdout 的引用。所有输出通过字符串数组返回，由 TUI 差分引擎决定何时写屏。

**结果导向缓存**：Text、Box、Image 都在实例内部做 `(text, width)` 级别的缓存，命中时直接返回上次结果。缓存失效由 `invalidate()` 显式触发，不依赖引用比较或响应式追踪。

**按需关注焦点**：只有需要光标的组件（`Input`、`Editor`）才实现 `Focusable` 接口；非焦点组件不污染 `focused` 状态机。

---

## 11.2 组件一览

| 类名 | 文件 | 交互 | 焦点 | 说明 |
|------|------|------|------|------|
| `Spacer` | `components/spacer.ts` | 否 | 否 | N 行空白 |
| `Text` | `components/text.ts` | 否 | 否 | 多行自动折行 |
| `TruncatedText` | `components/truncated-text.ts` | 否 | 否 | 单行截断 |
| `Box` | `components/box.ts` | 否 | 否 | 容器+内边距+背景 |
| `Markdown` | `components/markdown.ts` | 否 | 否 | Markdown 渲染 |
| `Image` | `components/image.ts` | 否 | 否 | Kitty/iTerm2 图像 |
| `Loader` | `components/loader.ts` | 否 | 否 | 自旋加载动画 |
| `CancellableLoader` | `components/cancellable-loader.ts` | 是 | 否 | Loader + 取消信号 |
| `SelectList` | `components/select-list.ts` | 是 | 否 | 单选列表 |
| `SettingsList` | `components/settings-list.ts` | 是 | 否 | 键值设置面板 |
| `Input` | `components/input.ts` | 是 | 是 | 单行输入 |
| `Editor` | `components/editor.ts` | 是 | 是 | 多行编辑器 |

---

## 11.3 Spacer

`Spacer` 是最轻量的组件，仅渲染固定数量的空行。

```typescript
// components/spacer.ts:6-28
export class Spacer implements Component {
    private lines: number;

    constructor(lines: number = 1) {
        this.lines = lines;
    }

    render(_width: number): string[] {
        const result: string[] = [];
        for (let i = 0; i < this.lines; i++) {
            result.push("");
        }
        return result;
    }
}
```

`_width` 参数被忽略——空行无需宽度感知。用于在组件之间插入视觉间隔，或在布局中"撑开"空间。

---

## 11.4 Text

`Text` 是最常用的只读组件。其核心依赖 `utils.ts` 中的 `wrapTextWithAnsi()`（见第 10 章 10.10 节），将任意含 ANSI 转义序列的文本按终端列宽折行，同时保持 SGR 状态跨行连续。

```typescript
// components/text.ts:45-88（节选）
render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
        return this.cachedLines;
    }

    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const wrappedLines = wrapTextWithAnsi(normalizedText, contentWidth);

    for (const line of wrappedLines) {
        const lineWithMargins = leftMargin + line + rightMargin;
        if (this.customBgFn) {
            contentLines.push(applyBackgroundToLine(lineWithMargins, width, this.customBgFn));
        } else {
            const paddingNeeded = Math.max(0, width - visibleWidth(lineWithMargins));
            contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
        }
    }
    // ...
}
```

**缓存策略**：三元组 `(text, width, cachedLines)` 严格比较——只要文本或宽度任一变化就重建。`invalidate()` 会清空这三个字段，`setText()` 也会清空。`customBgFn` 变化时同样清空，因为背景色影响每行的最终字节序列。

**`customBgFn` 的设计**：pi 主题中需要让某些区域显示背景色（例如工具调用块的灰色背景），但背景色函数本身是运行时注入的。`applyBackgroundToLine()` 负责将每一行补齐到 `width` 列并应用背景函数，避免终端因行末不足而"穿透"上一帧颜色。

---

## 11.5 TruncatedText

`TruncatedText` 是 `Text` 的单行变体：不折行，超出部分用 `truncateToWidth()` 截断并附加 `…`（或指定后缀）。适合展示路径、文件名等可能过长但不适合折行的内容。

```typescript
// components/truncated-text.ts:36-44
let singleLineText = this.text;
const newlineIndex = this.text.indexOf("\n");
if (newlineIndex !== -1) {
    singleLineText = this.text.substring(0, newlineIndex);
}
const displayText = truncateToWidth(singleLineText, availableWidth);
```

`truncateToWidth()` 内部使用 `visibleWidth()` 计算列宽，因此能正确处理含 ANSI 代码和双宽字符的字符串。

---

## 11.6 Box

`Box` 是唯一有 `children` 集合的容器组件。它为所有子组件统一添加水平和垂直内边距，并可选地应用背景色函数。

<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Box.render(width) 流程：五步渲染与三元组缓存">
  <defs>
    <marker id="arR111" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="40" y="10" width="560" height="210" rx="8" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="320" y="30" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">render(width) 流程</text>
  <rect x="60" y="40" width="520" height="28" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="320" y="59" text-anchor="middle" font-size="11" fill="#ea580c">1. 遍历 children → child.render(contentWidth)　　contentWidth = width − paddingX×2</text>
  <rect x="60" y="76" width="520" height="22" rx="5" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="91" text-anchor="middle" font-size="11" fill="#334155">2. 合并所有子行</text>
  <rect x="60" y="106" width="520" height="22" rx="5" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="121" text-anchor="middle" font-size="11" fill="#334155">3. 对每行：leftPad + bgFn?(line) + rightPad</text>
  <rect x="60" y="136" width="520" height="22" rx="5" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="151" text-anchor="middle" font-size="11" fill="#334155">4. 前后各插入 paddingY 行空白（同样应用 bgFn）</text>
  <rect x="60" y="166" width="520" height="40" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="320" y="183" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">5. 缓存检查：childLines + width + bgSample 三元组匹配</text>
  <text x="320" y="198" text-anchor="middle" font-size="10" fill="#64748b">命中 → 直接返回；未命中 → 重建并存储</text>
</svg>
<span class="figure-caption">图 R11.1 ｜ Box.render(width) 五步流程与三元组缓存策略</span>

<details>
<summary>ASCII 原版</summary>

```
render(width) 流程：
┌─────────────────────────────────────────────────────────┐
│  1. 遍历 children，依次调用 child.render(contentWidth)    │
│     contentWidth = width - paddingX*2                    │
│  2. 合并所有子行                                           │
│  3. 对每行：leftPad + bgFn?(line) + rightPad             │
│  4. 前后各插入 paddingY 行空白（同样应用 bgFn）             │
│  5. 与缓存比较：childLines + width + bgSample 三元组匹配  │
│     才命中缓存                                             │
└─────────────────────────────────────────────────────────┘
```

</details>

**bgSample 机制**（`components/box.ts:56-65`）：`bgFn` 本身是函数引用，无法直接比较。`Box` 在缓存时对空字符串调用一次 `bgFn("")`，取其返回值作为 `bgSample`。若 `bgSample` 发生变化（主题切换），缓存自动失效。这是一个轻量而实用的函数身份代理技术。

---

## 11.7 Markdown

`Markdown` 使用 `marked` 库（v5 token API）将 Markdown 文本转换为带 ANSI 色彩的终端字符串数组。

**StrictStrikethroughTokenizer**（`components/markdown.ts:8-23`）：覆盖 `marked` 默认的删除线解析器，要求 `~~` 两侧不能有空白，与 GitHub Flavored Markdown 的实际渲染保持一致。默认 `marked` 会匹配 `~~ text ~~`，在 pi 的输出场景中会造成误渲染。

**MarkdownTheme 接口**（`components/markdown.ts:53-71`）：

```typescript
export interface MarkdownTheme {
    heading: (text: string) => string;
    link: (text: string) => string;
    linkUrl: (text: string) => string;
    code: (text: string) => string;
    codeBlock: (text: string) => string;
    codeBlockBorder: (text: string) => string;
    quote: (text: string) => string;
    quoteBorder: (text: string) => string;
    hr: (text: string) => string;
    listBullet: (text: string) => string;
    bold: (text: string) => string;
    italic: (text: string) => string;
    strikethrough: (text: string) => string;
    underline: (text: string) => string;
    highlightCode?: (code: string, lang?: string) => string[];
    codeBlockIndent?: string;
}
```

每个主题函数是 `(text: string) => string` 的颜色装饰器，与 `chalk` 或 `kleur` 的 API 完全兼容。`highlightCode` 是可选的语法高亮钩子，返回已着色的行数组；`Markdown` 在渲染代码块时优先调用此钩子，若不存在则直接用 `codeBlock` 函数。

`Markdown` 不实现缓存，因为其渲染成本较低（大多数 Markdown 块为静态内容，由外部通过 `Text` 的 `cachedLines` 缓存），且主题函数可能随时切换。

---

## 11.8 Image

`Image` 组件封装了 Kitty/iTerm2 图像协议，其核心功能在 `terminal-image.ts` 中实现（见第 10 章 10.6 节）。组件层面的关键设计：

**Kitty 图像 ID 分配**（`components/image.ts:74`）：
```typescript
if (caps.images === "kitty" && this.imageId === undefined) {
    this.imageId = allocateImageId();
}
```
每个 `Image` 实例在首次渲染时获取唯一 ID，后续渲染复用同一 ID——Kitty 协议会在终端内部用 ID 去重，避免重传大量像素数据。通过 `options.imageId` 可显式传入 ID，用于动画帧更新场景（覆盖旧图）。

**iTerm2 多行处理**（`components/image.ts:100-111`）：iTerm2 图像序列不支持 `C=1`（无游标移动），因此需要先渲染 `rows-1` 行空行，再在最后一行用 `\x1b[{rowOffset}A` 将光标上移，输出图像序列后继续。这样 TUI 的行计数逻辑不会出错。

**缓存策略**：`(base64Data, width)` 两元组，`invalidate()` 清空。

---

## 11.9 Loader 与 CancellableLoader

`Loader` 继承自 `Text`，通过 `setInterval` 驱动帧动画：

```typescript
// components/loader.ts:72-88
private restartAnimation(): void {
    this.stop();
    if (this.frames.length <= 1) { return; }
    this.intervalId = setInterval(() => {
        this.currentFrame = (this.currentFrame + 1) % this.frames.length;
        this.updateDisplay();
    }, this.intervalMs);
}

private updateDisplay(): void {
    const frame = this.frames[this.currentFrame] ?? "";
    const renderedFrame = this.renderIndicatorVerbatim ? frame : this.spinnerColorFn(frame);
    const indicator = frame.length > 0 ? `${renderedFrame} ` : "";
    this.setText(`${indicator}${this.messageColorFn(this.message)}`);
    if (this.ui) { this.ui.requestRender(); }
}
```

每帧更新时调用继承自 `Text` 的 `setText()`（触发缓存失效），并立刻通过 `tui.requestRender()` 申请重绘（受 16ms 节流保护，参见第 10 章 10.3 节）。`render()` 在 `Text` 的结果前额外插入一行空白，用于视觉分隔。

`CancellableLoader`（`components/cancellable-loader.ts`）在 `handleInput()` 中检测 `tui.select.cancel` 键（Escape 或 Ctrl+C），调用 `AbortController.abort()`。调用方通过 `.signal` 属性将 `AbortSignal` 传入异步操作；调用方注册 `.onAbort` 回调处理 UI 层清理。这是"可取消 Promise"的标准 Web API 模式——`CancellableLoader` 不需要知道具体业务，只负责触发取消。

---

## 11.10 SelectList

`SelectList` 是 pi 所有弹出列表的基础，也被 `Editor` 内联用于自动补全。

**数据模型**（`components/select-list.ts:12-16`）：
```typescript
export interface SelectItem {
    value: string;     // 筛选匹配键（前缀匹配）
    label: string;     // 主列显示文本
    description?: string; // 可选次列说明
}
```

**渲染逻辑**：两列布局，主列宽由 `getPrimaryColumnWidth()` 在 `[minPrimaryColumnWidth, maxPrimaryColumnWidth]` 范围内计算；次列获得剩余宽度（至少 `MIN_DESCRIPTION_WIDTH = 10` 列）。当描述过长时，`normalizeToSingleLine()` 将其折叠为单行，再用 `truncateToWidth()` 截断。

**滚动**：视口以选中项为中心（`selectedIndex - floor(maxVisible/2)`），底部显示 `(当前/总数)` 滚动提示。

**筛选**（`setFilter`）：简单前缀匹配（`value.startsWith(filter)`），非模糊匹配。模糊匹配由 `SettingsList` 通过 `fuzzyFilter` 单独提供。

**事件回调**：
- `onSelect(item)` — 用户按 Enter
- `onCancel()` — 用户按 Escape/Ctrl+C
- `onSelectionChange(item)` — 选中行变化时（用于联动预览）

`SelectList` 通过 `handleInput()` 自主消费方向键和确认/取消键，不需要外层组件转发。

---

## 11.11 SettingsList

`SettingsList` 是更丰富的键值编辑面板，支持两种交互模式：

**循环切值**（`values` 数组）：按 Enter/Space 在枚举值间循环，通过 `onChange(id, newValue)` 通知外层。

**子菜单**（`submenu` 函数）：按 Enter 调用 `submenu(currentValue, done)` 工厂，工厂返回任意 `Component`（通常是另一个 `SelectList`）。`SettingsList` 将 `submenuComponent` 设为该组件，在 `render()` 和 `handleInput()` 中全权代理给子菜单，直到 `done()` 被调用。这是一种简单的"栈式导航"——不维护历史栈，直接覆盖渲染层。

**可选模糊搜索**（`enableSearch: true`）：顶部嵌入一个 `Input` 组件，其值通过 `fuzzyFilter(items, query)` 过滤列表（`fuzzy.ts`，不在本章覆盖范围内）。

<svg viewBox="0 0 640 310" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="SettingsList 渲染决策树：submenu 优先，否则走主列表分支">
  <defs>
    <marker id="arR112" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="arR112g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#0d9488"/>
    </marker>
  </defs>
  <text x="320" y="18" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">SettingsList 渲染决策树</text>
  <rect x="180" y="28" width="280" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="46" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">submenuComponent !== null?</text>
  <text x="320" y="58" text-anchor="middle" font-size="10" fill="#64748b">render() / handleInput() 全权代理</text>
  <line x1="220" y1="62" x2="120" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR112)"/>
  <text x="158" y="87" font-size="10" fill="#0d9488">是</text>
  <rect x="40" y="102" width="160" height="28" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="120" y="121" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">render(submenu, width)</text>
  <line x1="420" y1="62" x2="500" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR112)"/>
  <text x="464" y="87" font-size="10" fill="#64748b">否</text>
  <rect x="400" y="102" width="200" height="28" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="500" y="121" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">renderMainList(width)</text>
  <line x1="500" y1="130" x2="500" y2="150" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR112)"/>
  <rect x="360" y="152" width="280" height="34" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="500" y="170" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">searchEnabled?</text>
  <text x="500" y="181" text-anchor="middle" font-size="10" fill="#64748b">enableSearch: true</text>
  <line x1="400" y1="169" x2="320" y2="196" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR112)"/>
  <text x="351" y="190" font-size="10" fill="#0d9488">是</text>
  <rect x="200" y="198" width="120" height="24" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="260" y="214" text-anchor="middle" font-size="10" fill="#7c3aed">searchInput（嵌入 Input）</text>
  <line x1="600" y1="169" x2="600" y2="198" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR112)"/>
  <text x="609" y="190" font-size="10" fill="#64748b">否</text>
  <rect x="490" y="200" width="210" height="34" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="595" y="218" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">filteredItems.length?</text>
  <line x1="540" y1="234" x2="500" y2="260" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR112)"/>
  <text x="512" y="256" font-size="10" fill="#64748b">0</text>
  <rect x="420" y="262" width="80" height="24" rx="4" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <text x="460" y="278" text-anchor="middle" font-size="10" fill="#64748b">hint（空提示）</text>
  <line x1="650" y1="234" x2="680" y2="260" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR112)"/>
  <text x="660" y="256" font-size="10" fill="#0d9488">n</text>
  <rect x="580" y="262" width="120" height="24" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="640" y="278" text-anchor="middle" font-size="10" fill="#7c3aed">rows + cursor</text>
</svg>
<span class="figure-caption">图 R11.2 ｜ SettingsList 渲染决策树——submenu 优先；主列表分支含搜索框与空状态</span>

<details>
<summary>ASCII 原版</summary>

```
SettingsList 渲染决策树：
┌─────────────────────────────────┐
│  submenuComponent !== null?      │
│    是 → render(submenu, width)   │
│    否 → renderMainList(width)    │
│          searchEnabled?          │
│            是 → searchInput      │
│          filteredItems.length?   │
│            0 → hint              │
│            n → rows + cursor     │
└─────────────────────────────────┘
```

</details>

---

## 11.12 Input

`Input` 是单行文本输入组件，实现了 Emacs 风格的编辑快捷键集合。

### 11.12.1 状态模型

```typescript
// components/input.ts:10-13
interface InputState {
    value: string;
    cursor: number;  // 字节偏移，非列偏移
}
```

`cursor` 是字节偏移（`value.slice(0, cursor)`），而光标的视觉列位置在渲染时由 `visibleWidth(value.slice(0, cursor))` 动态计算。

### 11.12.2 水平滚动

当 `visibleWidth(value)` 超过可用宽度时触发水平滚动：

```typescript
// components/input.ts:456-477（节选）
const cursorCol = visibleWidth(this.value.slice(0, this.cursor));
const halfWidth = Math.floor(scrollWidth / 2);
let startCol = 0;

if (cursorCol < halfWidth) {
    startCol = 0;
} else if (cursorCol > totalWidth - halfWidth) {
    startCol = Math.max(0, totalWidth - scrollWidth);
} else {
    startCol = Math.max(0, cursorCol - halfWidth);
}

visibleText = sliceByColumn(this.value, startCol, scrollWidth, true);
```

"中心对齐"算法：光标尽量保持在可见窗口的水平中央。`sliceByColumn()` 是列宽感知的字符串切片，能正确处理双宽字符（不会在字符中间截断）。

### 11.12.3 词粒度移动

`moveWordBackwards()`/`moveWordForwards()` 使用 `Intl.Segmenter` 遍历字素簇，按"空白→标点→词"三种边界跳跃：

1. 跳过尾部空白
2. 若当前字符为标点，跳过整个标点连续段
3. 否则跳过整个词（非空白、非标点）连续段

这与 Emacs `M-b`/`M-f` 的语义完全一致。

### 11.12.4 undo 合并

```typescript
// components/input.ts:213-217
private insertCharacter(char: string): void {
    if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
        this.pushUndo();
    }
    this.lastAction = "type-word";
    // ...
}
```

连续输入字母/数字时不推送 undo 快照，直到遇到空白字符或操作类型改变（kill/yank）。这使得 `Ctrl+-` 以词粒度回退，而非逐字符。

### 11.12.5 括号粘贴

`\x1b[200~` 触发粘贴缓冲，`\x1b[201~` 结束。粘贴内容中的换行符、制表符被 `handlePaste()` 规范化（Tab → 4 空格，换行删除），因为 `Input` 是单行组件，不支持多行。

---

## 11.13 Editor

`Editor` 是 pi 最复杂的组件，实现多行、可滚动、带自动补全的代码/提示编辑器。

### 11.13.1 状态模型

```typescript
// components/editor.ts:188-192
interface EditorState {
    lines: string[];       // 每个逻辑行的内容（不含换行符）
    cursorLine: number;    // 当前逻辑行索引
    cursorCol: number;     // 当前字节偏移（在该逻辑行内）
}
```

`Editor` 没有使用 gap buffer 或 piece table——所有行存储为普通字符串数组。对于终端 agent 的使用场景（提示词通常不超过几千行），这个模型的性能完全足够，且实现简单可靠。undo/redo 通过 `UndoStack<EditorState>` 实现深拷贝快照（见 11.14 节）。

### 11.13.2 视觉行布局（Visual Line Map）

```
逻辑行（logical lines）            视觉行（visual lines / layout lines）
  lines[0]: "Hello world ..."  ->  "Hello world "  (VL 0)
                                   "..."           (VL 1)
  lines[1]: "Short line"       ->  "Short line"    (VL 2)
  lines[2]: ""                 ->  ""              (VL 3)
```

`buildVisualLineMap()` 对每个逻辑行调用 `wordWrapLine()`，将结果展平为 `LayoutLine[]`（含 `text`、`hasCursor`、`cursorPos` 字段）。`findCurrentVisualLine()` 定位光标所在视觉行索引。

`wordWrapLine()`（`components/editor.ts:101-185`）的折行规则（见 11.13.3 节）。

### 11.13.3 wordWrapLine 算法

```
for each segment (grapheme 或 paste marker):
    if currentWidth + gWidth > maxWidth:
        if 有回退点 且 剩余宽度够:
            在回退点处断行
        else:
            强制在当前位置断行
    
    if 当前是空白且下一个是非空白:
        记录回退点 = 下一个字符的起始字节位置
    
    累加 currentWidth
```

关键细节：回退点（wrap opportunity）是"最后一个空白字符之后的字符位置"，而不是空白字符本身——这确保折行后行首不会有多余空白。对宽度超过 `maxWidth` 的单个原子段（如跨行粘贴标记），递归调用 `wordWrapLine(grapheme, maxWidth)` 做次级视觉拆分，但逻辑上仍视为原子单元。

### 11.13.4 粘贴标记（Paste Markers）

当用户粘贴较大内容（括号粘贴协议触发），`Editor` 不直接插入原始文本，而是：

1. 将粘贴内容存储在 `pastes: Map<number, string>` 中
2. 在文本中插入形如 `[paste #1 +3 lines]` 或 `[paste #2 123 chars]` 的标记
3. `segmentWithMarkers()` 将标记作为单个原子字素段处理

这一设计的意图是：对于大型粘贴，光标移动、词删除、折行等操作都将整个粘贴块视为原子单元，不会意外在粘贴内容中间定位。删除粘贴标记时，整个对应内容被替换恢复。

```typescript
// components/editor.ts:12-13
const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;
const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;
```

### 11.13.5 垂直滚动

```typescript
// components/editor.ts:427-443（节选）
const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));

if (cursorLineIndex < this.scrollOffset) {
    this.scrollOffset = cursorLineIndex;
} else if (cursorLineIndex >= this.scrollOffset + maxVisibleLines) {
    this.scrollOffset = cursorLineIndex - maxVisibleLines + 1;
}
```

Editor 最多显示终端高度的 30%（最少 5 行），超出部分垂直滚动。滚动偏移量（`scrollOffset`）在每次 `render()` 时动态调整，保证光标行始终在视口内。超出视口的内容通过顶/底边框上的滚动指示器提示（`─── ↑ N more ─`）。

### 11.13.6 光标渲染与 CURSOR_MARKER

```typescript
// components/editor.ts:476-499（节选）
if (after.length > 0) {
    const firstGrapheme = afterGraphemes[0]?.segment || "";
    const restAfter = after.slice(firstGrapheme.length);
    const cursor = `\x1b[7m${firstGrapheme}\x1b[0m`;
    displayText = before + marker + cursor + restAfter;
} else {
    const cursor = "\x1b[7m \x1b[0m";
    displayText = before + marker + cursor;
}
```

光标用反显（`\x1b[7m`）渲染，`CURSOR_MARKER`（APC 零宽标记 `\x1b_pi:c\x07`）在光标字符前插入，让 TUI 引擎通过字符串扫描定位光标的终端坐标，用于 IME 候选窗定位（详见第 10 章 10.7 节）。

### 11.13.7 自动补全

自动补全通过 Overlay 机制实现（第 10 章 10.8 节）：

```
触发时机：
  输入字符时，延迟 20ms 调用 autocompleteProvider
  autocompleteProvider 返回 AutocompleteSuggestions
  创建 SelectList 作为 overlay 组件

触发键：
  Tab     — 强制触发 (autocompleteState = "force")
  字符输入 — 普通触发 (autocompleteState = "regular")

消费键（由 SelectList.handleInput 处理）：
  Enter   — 确认，替换当前 token
  Escape  — 取消
  方向键  — SelectList 内部导航
```

每次用户修改文本后，先取消正在进行的补全请求（`autocompleteAbort?.abort()`），再启动新的防抖计时器（20ms，`ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS`）。补全结果通过 `tui.showOverlay()` 以 overlay 形式叠加在 Editor 正下方。

### 11.13.8 提示词历史

```typescript
// components/editor.ts:342-351
addToHistory(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.history.length > 0 && this.history[0] === trimmed) return;
    this.history.unshift(trimmed);
    if (this.history.length > 100) { this.history.pop(); }
}
```

- 最多 100 条，最新在前
- 不保存连续重复项
- 上箭头（`isOnFirstVisualLine()` 时）进入历史浏览模式
- 下箭头回到最新状态
- 进入历史浏览时会先推一次 undo 快照，保留未提交的当前文本

---

## 11.14 UndoStack 与 KillRing

这两个辅助类被 `Input` 和 `Editor` 共同使用。

### UndoStack

```typescript
// undo-stack.ts:7-28
export class UndoStack<S> {
    private stack: S[] = [];

    push(state: S): void {
        this.stack.push(structuredClone(state));  // 深拷贝快照
    }

    pop(): S | undefined {
        return this.stack.pop();  // 弹出时不再拷贝
    }
}
```

使用 `structuredClone()` 而非自定义序列化，保证任意可序列化的状态对象都能正确深拷贝。由于 `EditorState` 仅包含普通字符串数组和数字，`structuredClone` 的成本可以接受。弹出时直接返回已有快照（不重新克隆），因为弹出后该引用不再存在于栈中。

### KillRing

```typescript
// kill-ring.ts:19-28
push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
    if (opts.accumulate && this.ring.length > 0) {
        const last = this.ring.pop()!;
        this.ring.push(opts.prepend ? text + last : last + text);
    } else {
        this.ring.push(text);
    }
}
```

- `accumulate: true` + `prepend: true`：向前删除时将新内容拼接到上一次 kill 的**前面**（Emacs `Ctrl+W` 连续调用语义）
- `accumulate: true` + `prepend: false`：向后删除时拼接到**后面**（`Ctrl+K` 连续调用）
- `rotate()`：yank-pop（`Alt+Y`）循环，将队尾移至队首，下次 `peek()` 返回下一个较旧的 kill

---

## 11.15 keys.ts 键盘解码状态机

`keys.ts`（1400 行）是整个键盘输入系统的核心，将终端的原始字节序列映射为类型安全的 `KeyId` 字符串。

### 11.15.1 为什么需要专门的解码器

终端键盘协议的历史包袱极重：

- 1970 年代 VT100 定义的控制字符（`\x01`-`\x1a` = Ctrl+A-Z）
- ANSI/VT 逃逸序列（`\x1b[A` = 上箭头）
- SS3 序列（`\x1bOA` = 某些终端的上箭头）
- xterm modifyOtherKeys（`\x1b[27;5;65~` = Ctrl+A）
- Kitty 键盘协议（`\x1b[97;5u` = Ctrl+a，CSI-u 格式）

同一个逻辑按键可能有 3-6 种字节表示，且不同终端不一致。`matchesKey()` 通过分层匹配隐藏了这一复杂性。

### 11.15.2 KeyId 类型系统

```typescript
// keys.ts:152
export type KeyId = BaseKey | ModifiedKeyId<BaseKey>;
```

`BaseKey` = `Letter | Digit | SymbolKey | SpecialKey`，覆盖所有可打印键和特殊键。`ModifiedKeyId<BaseKey>` 是递归展开的修饰键组合类型：

```typescript
type ModifiedKeyId<Key, Remaining = ModifierName> = {
    [M in Remaining]: `${M}+${Key}` | `${M}+${ModifiedKeyId<Key, Exclude<Remaining, M>>}`
}[Remaining]
```

这确保 `"ctrl+shift+p"` 是合法的 `KeyId`，而 `"ctrls+p"` 或 `"ctrl+shfit+p"` 会在编译期报错。

### 11.15.3 全局 Kitty 协议状态

```typescript
// keys.ts:25-40
let _kittyProtocolActive = false;

export function setKittyProtocolActive(active: boolean): void { ... }
export function isKittyProtocolActive(): boolean { ... }
```

这个全局标志由 `ProcessTerminal.queryAndEnableKittyProtocol()` 在终端初始化时设置。`matchesKey()` 中多处逻辑依赖此标志区分"Kitty 模式"与"legacy 模式"的歧义序列：

- `\x1b\r`：legacy 模式 = Alt+Enter，Kitty 模式 = Shift+Enter（terminal 用户映射）
- `\x1b[200~` 后的 `:3F`：粘贴内容中不应被识别为 key release，需特殊豁免

### 11.15.4 legacy 序列表

```
LEGACY_KEY_SEQUENCES      基础功能键（上下左右、Home/End、Insert/Delete、PgUp/PgDn、F1-F12）
LEGACY_SHIFT_SEQUENCES    Shift 修饰的功能键
LEGACY_CTRL_SEQUENCES     Ctrl 修饰的功能键
LEGACY_SEQUENCE_KEY_IDS   直查表：序列字符串 → KeyId（约 60 条）
```

`LEGACY_SEQUENCE_KEY_IDS` 是最高性能的路径——常见序列（如箭头键 `\x1bOA`）由哈希查找直接返回 `KeyId`，无需进入 `matchesKey` 的分支逻辑。

### 11.15.5 parseKittySequence

```
CSI-u 格式（示例）：
  \x1b[97u          = a（无修饰，无事件类型）
  \x1b[97;5u        = Ctrl+a（modifier = 5-1 = 4 = CTRL）
  \x1b[97;5:3u      = Ctrl+a 按键释放（eventType = 3）
  \x1b[97:65;2u     = shift+a（a=97，shifted=65=A）
  \x1b[1;3:2A       = alt+up 重复事件

modifier 编码（1-indexed，需 -1 还原）：
  bit 0 (1): shift
  bit 1 (2): alt
  bit 2 (4): ctrl
  bit 3 (8): super
  bit 6 (64): Caps Lock（LOCK_MASK 过滤）
  bit 7 (128): Num Lock（LOCK_MASK 过滤）
```

`normalizeKittyFunctionalCodepoint()` 将数字小键盘键码（57399-57426）映射回标准键码，使得 `KP_Enter` 可以匹配 `enter`，`KP_Left` 可以匹配 `left`。

`normalizeShiftedLetterIdentityCodepoint()` 处理 Kitty 报告大写字母（`A=65`）时，将其还原为小写（`a=97`），然后 modifier 中 shift=1 表示大写，避免大小写混淆匹配。

### 11.15.6 matchesKey 分支结构

```
matchesKey(data, keyId):
  1. parseKeyId(keyId) 分解修饰键 + 基础键名
  2. 计算 modifier 位掩码
  3. switch(key):
     特殊键（escape/space/tab/enter/backspace/insert/delete/clear/
             home/end/pageUp/pageDown/up/down/left/right/f1-f12）:
       - 各键独立处理 legacy + Kitty + modifyOtherKeys 三种形式
       - 部分键在 !_kittyProtocolActive 时额外处理 legacy 变体
     
     字母/数字/符号（length===1）:
       - ctrl: rawCtrlChar() 生成控制字符 + Kitty + modifyOtherKeys
       - shift: 大写字母 + Kitty + modifyOtherKeys
       - alt (legacy): \x1b + key
       - 其他组合: 仅 Kitty + modifyOtherKeys
       - 无修饰: data === key || Kitty(codepoint, 0)
```

`rawCtrlChar()` 使用 `code & 0x1f` 公式，将字母/符号映射到控制字符范围（ASCII 1-31）。`-` 被特殊处理为与 `_` 同一物理按键（`\x1f`），这就是为何 `Ctrl+-` 是有效的 undo 快捷键（`tui.editor.undo` 的默认绑定）。

### 11.15.7 isKeyRelease 与 isKeyRepeat

```typescript
// keys.ts:527-551（节选）
export function isKeyRelease(data: string): boolean {
    if (data.includes("\x1b[200~")) { return false; }
    if (
        data.includes(":3u") ||
        data.includes(":3~") ||
        data.includes(":3A") || // ...
    ) { return true; }
    return false;
}
```

Kitty 协议的事件类型编码在 modifier 字段后（`:<eventType>`）：1=press，2=repeat，3=release。`isKeyRelease()` 通过字符串包含检查快速判断，无需完整解析。粘贴内容（如 MAC 地址 `90:62:3F:A5`）中的 `:3F` 会被 `\x1b[200~` 检测豁免。

`Component.wantsKeyRelease?: boolean` 标志（定义于 `tui.ts:53`）让组件声明自己需要接收释放事件。TUI 主输入循环在 `isKeyRelease(data) && !focusedComponent.wantsKeyRelease` 时跳过分发。

### 11.15.8 parseKey 与 decodePrintableKey

`parseKey(data)`（`keys.ts:1251`）是 `matchesKey` 的逆操作：将原始字节序列反解析为 `KeyId` 字符串（如 `"ctrl+a"`）。用于调试输出和 Editor 中的字符跳转模式（`jumpToChar`）。

`decodePrintableKey(data)` 从 Kitty CSI-u 序列提取可打印字符（通过 `shiftedKey` 字段），用于 `Editor.handleInput` 的字符跳转功能：用户先按 `Ctrl+]`，再按任意字符，光标跳至该字符的下一次出现位置。

---

## 11.16 keybindings.ts 键绑定管理

### 11.16.1 设计目标

直接在组件中写 `if (data === "\x1b[A")` 有两个问题：一是硬编码了一种序列表示，二是用户无法重映射。`keybindings.ts` 引入了一层名称→键序列的间接映射：

```typescript
// keybindings.ts:7-42（节选）
export interface Keybindings {
    "tui.editor.cursorUp": true;
    "tui.editor.cursorLeft": true;
    "tui.editor.deleteWordBackward": true;
    "tui.editor.yank": true;
    // ... 共 26 个具名绑定
}
```

接口声明（而非 `string` 字段名）使得键绑定名称具有编译时类型检查；下游包通过 TypeScript 声明合并扩展此接口，添加新键绑定名称。

### 11.16.2 TUI_KEYBINDINGS 默认值

```
名称                          默认键
tui.editor.cursorUp           up
tui.editor.cursorLeft         left, ctrl+b
tui.editor.cursorWordLeft     alt+left, ctrl+left, alt+b
tui.editor.cursorLineStart    home, ctrl+a
tui.editor.deleteWordBackward ctrl+w, alt+backspace
tui.editor.deleteToLineEnd    ctrl+k
tui.editor.yank               ctrl+y
tui.editor.yankPop            alt+y
tui.editor.undo               ctrl+-
tui.input.submit              enter
tui.input.newLine             shift+enter
tui.input.tab                 tab
tui.input.copy                ctrl+c
tui.select.cancel             escape, ctrl+c
tui.select.confirm            enter
```

多个默认键（如 `cursorLeft` 有 `left` 和 `ctrl+b`）在内部被规范化为 `KeyId[]` 数组，`matches()` 遍历该数组调用 `matchesKey()`。

### 11.16.3 KeybindingsManager

```typescript
// keybindings.ts:155-200（节选）
export class KeybindingsManager {
    matches(data: string, keybinding: Keybinding): boolean {
        const keys = this.keysById.get(keybinding) ?? [];
        for (const key of keys) {
            if (matchesKey(data, key)) return true;
        }
        return false;
    }
}
```

`rebuild()` 在构造时和 `setUserBindings()` 时重建 `keysById` 映射，并检测用户配置中的键冲突（同一 `KeyId` 被多个 keybinding 声明）。用户绑定完全覆盖默认值（非追加）：`userBindings[id] === undefined` 时使用默认值，否则使用用户值（可以设为空数组 `[]` 禁用某绑定）。

全局实例通过 `getKeybindings()` 懒初始化，`setKeybindings()` 允许测试或扩展替换。

---

## 11.17 焦点与事件路由

### 11.17.1 焦点状态机

TUI 维护一个 `focusedComponent: (Component & Focusable) | null`。焦点转移通过 `tui.setFocus(component)` 完成：

```
setFocus(newComponent):
  1. 若当前有焦点组件，设 focused = false
  2. 设 newComponent.focused = true（如果实现 Focusable）
  3. 更新 focusedComponent
  4. requestRender()
```

输入数据的分发顺序：

<svg viewBox="0 0 640 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="键盘输入分发顺序：从 stdin 到 focusedComponent">
  <defs>
    <marker id="arR113" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="160" y="8" width="300" height="28" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="310" y="27" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">stdin 数据到达</text>
  <line x1="310" y1="36" x2="310" y2="54" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR113)"/>
  <rect x="100" y="56" width="420" height="28" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="310" y="75" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">ProcessTerminal 原始模式接收</text>
  <line x1="310" y1="84" x2="310" y2="102" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR113)"/>
  <rect x="100" y="104" width="420" height="28" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="310" y="123" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">StdinBuffer 序列完整性检测</text>
  <line x1="310" y1="132" x2="310" y2="150" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR113)"/>
  <rect x="100" y="152" width="420" height="28" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="310" y="171" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">TUI.handleInput(data)</text>
  <line x1="310" y1="180" x2="310" y2="198" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR113)"/>
  <rect x="60" y="200" width="500" height="36" rx="5" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <text x="310" y="218" text-anchor="middle" font-size="11" font-weight="600" fill="#334155">1. isKeyRelease &amp;&amp; !wantsKeyRelease → 丢弃</text>
  <text x="310" y="230" text-anchor="middle" font-size="10" fill="#64748b">过滤 Kitty key release 事件</text>
  <line x1="310" y1="236" x2="310" y2="254" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR113)"/>
  <rect x="60" y="256" width="500" height="46" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="310" y="274" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">2. 检查活跃 overlay 栈（栈顶优先）</text>
  <text x="310" y="288" text-anchor="middle" font-size="10" fill="#64748b">overlay.component.handleInput(data)　若消费 → 停止</text>
  <line x1="310" y1="302" x2="310" y2="320" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR113)"/>
  <rect x="60" y="322" width="500" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="310" y="341" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">3. focusedComponent?.handleInput(data)</text>
  <line x1="310" y1="350" x2="310" y2="368" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR113)"/>
  <rect x="60" y="370" width="500" height="28" rx="5" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <text x="310" y="389" text-anchor="middle" font-size="11" fill="#334155">4. TUI 自身注册的 inputHandlers</text>
</svg>
<span class="figure-caption">图 R11.3 ｜ 键盘输入分发顺序——四级路由，overlay 优先于 focusedComponent</span>

<details>
<summary>ASCII 原版</summary>

```
stdin 数据到达
    ↓
ProcessTerminal 原始模式接收
    ↓
StdinBuffer 序列完整性检测
    ↓
TUI.handleInput(data)
    ↓
1. 检查 isKeyRelease && !wantsKeyRelease → 丢弃
    ↓
2. 检查活跃 overlay 栈（从栈顶开始）
   overlay.component.handleInput(data)
   若 overlay 消费了输入 → 停止
    ↓
3. 转发给 focusedComponent?.handleInput(data)
    ↓
4. 转发给 TUI 自身注册的 inputHandlers
```

</details>

Overlay 的优先级高于 focusedComponent，这确保模态对话框（SelectList overlay）能正确拦截所有键盘输入，不会"穿透"到下层的 Editor。

### 11.17.2 Focusable 接口的渲染含义

```typescript
// tui.ts:74（根据第10章摘录）
export interface Focusable {
    focused: boolean;
}
```

`focused` 标志由组件自行在 `render()` 中检查——当 `focused === true` 时，输出 `CURSOR_MARKER` 以及光标高亮（反显字符）；当 `focused === false` 时，不输出 `CURSOR_MARKER`，光标位置对 TUI 不可见。这意味着同一时刻最多只有一个组件的 `CURSOR_MARKER` 出现在渲染输出中，TUI 的 `positionHardwareCursor()` 扫描一次即可。

---

## 11.18 East Asian 宽度在组件中的应用

所有需要列宽计算的组件最终都调用 `visibleWidth()`（`utils.ts:201`）。该函数的核心是字素级别的宽度计算（`graphemeWidth()`，`utils.ts:156`），其规则：

```
graphemeWidth(grapheme):
  1. 若 length === 1 且 charCode <= 127：返回 1（ASCII 快速路径）
  2. 若 charCode === 0 或 category 为 Mn/Me/Cf（零宽格式字符）：返回 0
  3. 若含 emoji 标量值（预检查）：返回 2
  4. 调用 eastAsianWidth(grapheme) → 'W'/'F' 返回 2，其他返回 1
```

`visibleWidth()` 在此基础上增加 512 条目 LRU 缓存（以字符串为键），对频繁出现的短字符串（如行尾标点、ASCII 词）直接命中缓存。

在 `Editor.render()` 中，光标所在视觉行的 `cursorPos` 是字节偏移，而 `contentWidth - lineVisibleWidth` 计算右侧填充空格数量。若光标位于行末，插入的空格（倒显）将占用一列宽度——对于双宽字符行可能导致右侧只剩 0 列，此时 `cursorInPadding = true`，`rightPadding` 减少一列（`slice(1)`），避免视觉行溢出。

---

## 11.19 组件间关系总结

<svg viewBox="0 0 880 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="组件层次与键盘输入链路总览">
  <defs>
    <marker id="arR114" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="arR114o" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/>
    </marker>
  </defs>
  <text x="440" y="16" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">组件层次与键盘输入链路</text>
  <rect x="20" y="24" width="500" height="280" rx="8" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="270" y="42" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">TUI（第 10 章）</text>
  <rect x="40" y="50" width="460" height="240" rx="6" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <text x="270" y="68" text-anchor="middle" font-size="11" font-weight="600" fill="#334155">Container（直接子组件列表）</text>
  <rect x="58" y="76" width="200" height="60" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="158" y="92" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">Box</text>
  <text x="158" y="106" text-anchor="middle" font-size="10" fill="#64748b">Text / TruncatedText</text>
  <text x="158" y="120" text-anchor="middle" font-size="10" fill="#64748b">Markdown / Image / Loader</text>
  <rect x="270" y="76" width="80" height="30" rx="5" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <text x="310" y="95" text-anchor="middle" font-size="10" fill="#334155">Spacer</text>
  <rect x="362" y="76" width="120" height="30" rx="5" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <text x="422" y="95" text-anchor="middle" font-size="10" fill="#334155">SelectList / SettingsList</text>
  <rect x="58" y="148" width="180" height="54" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="148" y="166" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">Input（焦点）</text>
  <text x="148" y="180" text-anchor="middle" font-size="10" fill="#64748b">单行编辑 + Emacs 快捷键</text>
  <text x="148" y="193" text-anchor="middle" font-size="10" fill="#64748b">UndoStack + KillRing</text>
  <rect x="256" y="148" width="224" height="54" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="368" y="166" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">Editor（焦点）</text>
  <text x="368" y="180" text-anchor="middle" font-size="10" fill="#64748b">多行 + wordWrap + 滚动 + 补全</text>
  <rect x="268" y="210" width="200" height="24" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="368" y="226" text-anchor="middle" font-size="10" fill="#7c3aed">SelectList（autocomplete overlay）</text>
  <rect x="58" y="218" width="180" height="50" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="148" y="236" text-anchor="middle" font-size="10" font-weight="600" fill="#0d9488">Overlay 栈</text>
  <text x="148" y="250" text-anchor="middle" font-size="10" fill="#64748b">任意 Component</text>
  <text x="148" y="263" text-anchor="middle" font-size="10" fill="#64748b">（SelectList / SettingsList）</text>
  <rect x="540" y="24" width="320" height="280" rx="8" fill="#f1f5f9" stroke="#ea580c" stroke-width="1.5"/>
  <text x="700" y="42" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">键盘输入链路</text>
  <rect x="580" y="52" width="240" height="28" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="700" y="71" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">stdin → StdinBuffer</text>
  <line x1="700" y1="80" x2="700" y2="98" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR114)"/>
  <rect x="580" y="100" width="240" height="28" rx="5" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="700" y="119" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">TUI.handleInput</text>
  <line x1="700" y1="128" x2="700" y2="146" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR114)"/>
  <rect x="560" y="148" width="280" height="36" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="700" y="164" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">overlay.handleInput</text>
  <text x="700" y="178" text-anchor="middle" font-size="10" fill="#64748b">若有活跃 overlay</text>
  <line x1="700" y1="184" x2="700" y2="202" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR114)"/>
  <rect x="560" y="204" width="280" height="36" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="700" y="220" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">focusedComponent.handleInput</text>
  <text x="700" y="234" text-anchor="middle" font-size="10" fill="#64748b">Input 或 Editor</text>
  <line x1="700" y1="240" x2="700" y2="258" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR114)"/>
  <rect x="560" y="260" width="280" height="36" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="700" y="276" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">keybindings.matches(data, "tui.*")</text>
  <text x="700" y="290" text-anchor="middle" font-size="10" fill="#64748b">→ matchesKey(data, keyId)</text>
  <line x1="270" y1="164" x2="540" y2="210" stroke="#ea580c" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#arR114o)"/>
  <text x="400" y="196" font-size="10" fill="#ea580c">焦点路由</text>
  <text x="100" y="320" font-size="10" fill="#94a3b8">组件树（渲染层）</text>
  <text x="660" y="320" font-size="10" fill="#94a3b8">输入链路（事件层）</text>
</svg>
<span class="figure-caption">图 R11.4 ｜ 组件层次与键盘输入链路总览——渲染树与事件路由的双视角</span>

<details>
<summary>ASCII 原版</summary>

```
TUI（第10章）
├── Container（直接子组件列表）
│   ├── Box
│   │   └── Text / TruncatedText / Markdown / Image / Loader
│   ├── Spacer
│   ├── SelectList / SettingsList（当作顶层组件使用）
│   ├── Input（获得焦点）
│   └── Editor（获得焦点）
│       └── SelectList（autocomplete overlay，通过 tui.showOverlay 注册）
│
└── Overlay 栈
    └── 任意 Component（通常是 SelectList 或 SettingsList）

键盘输入链路：
  stdin -> StdinBuffer -> TUI.handleInput
    -> overlay.handleInput（若有活跃 overlay）
    -> focusedComponent.handleInput（Input 或 Editor）
      -> keybindings.matches(data, "tui.*") -> matchesKey(data, keyId)
```

</details>

---

## 参考文件索引

| 文件 | 关键位置 |
|------|---------|
| `components/spacer.ts` | 全文 |
| `components/text.ts` | 全文；`render()` 缓存逻辑 |
| `components/truncated-text.ts` | 全文；`truncateToWidth()` 调用 |
| `components/box.ts` | `bgSample` 缓存机制 |
| `components/markdown.ts:8-71` | `StrictStrikethroughTokenizer`；`MarkdownTheme` |
| `components/image.ts:60-125` | Kitty/iTerm2 分支；ID 分配 |
| `components/loader.ts:72-92` | 动画帧驱动；`updateDisplay()` |
| `components/cancellable-loader.ts` | 全文；`AbortController` 集成 |
| `components/select-list.ts:12-58` | 数据模型；构造；`setFilter()` |
| `components/settings-list.ts:7-67` | `SettingItem`；`submenu` 回调 |
| `components/input.ts:10-13` | `InputState` |
| `components/input.ts:434-502` | 水平滚动渲染 |
| `components/editor.ts:1-78` | `segmentWithMarkers()`；粘贴标记正则 |
| `components/editor.ts:101-185` | `wordWrapLine()` 完整实现 |
| `components/editor.ts:188-295` | `EditorState`；所有私有字段 |
| `components/editor.ts:409-532` | `render()`；滚动；光标渲染 |
| `components/editor.ts:534-599` | `handleInput()` 顶层分发 |
| `undo-stack.ts` | 全文；`structuredClone` |
| `kill-ring.ts` | 全文；`accumulate`/`prepend` 语义 |
| `keys.ts:152-162` | `KeyId` 类型定义 |
| `keys.ts:292-354` | `MODIFIERS`；`CODEPOINTS`；`KITTY_FUNCTIONAL_KEY_EQUIVALENTS` |
| `keys.ts:368-481` | 所有 legacy 序列表 |
| `keys.ts:587-651` | `parseKittySequence()` |
| `keys.ts:820-1204` | `matchesKey()` 完整实现 |
| `keys.ts:527-577` | `isKeyRelease()`；`isKeyRepeat()` |
| `keybindings.ts:7-134` | `Keybindings` 接口；`TUI_KEYBINDINGS` 定义 |
| `keybindings.ts:155-231` | `KeybindingsManager` 实现 |
