# Tour 步骤 06:用户敲入字符 → 键盘解码 → InputComponent

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:TUI 在 raw mode 渲染中,焦点在 CustomEditor,stdin 监听器已挂,event loop 等待键盘事件。

**下一步起点**:用户继续敲完整句"读一下 README.md 的第一行"并按下回车前的瞬间。Editor 的 `state.lines[0]` 已存有完整 prompt 字符串,但还没提交。

---

## 1. 当前情境

TUI 进入稳态等待。此刻调用栈完全空白——Node.js event loop 阻塞在 `libuv` 的 I/O 轮询上。stdin 被 `process.stdin.resume()` 激活并保持可读。进程内的数据链路已就位:

```
OS kernel  ->  stdin fd  ->  process.stdin  ->  stdinDataHandler
  -> StdinBuffer  ->  TUI.handleInput  ->  CustomEditor.handleInput
```

用户现在按下「读」字的第一个键(以 macOS 日本语输入法/拼音输入法场景为例,键盘实际产生的是对应汉字的 UTF-8 字节序列 `\xe8\xaf\xbb`,即 `读` 的 UTF-8 三字节编码)。

---

## 2. 问题

本步需要解释从键盘按下到字符显示在屏幕上的全链路:

1. **OS 把哪些字节送到 stdin,Node.js 如何接收**——raw mode 下字节如何到达 `process.stdin` 的 `data` 事件?
2. **`StdinBuffer` 如何判断一个字节序列已经完整**——`读` 字(3 字节 UTF-8)和 `\x1b[A`(上箭头,3 字节 escape sequence)字节数相同,如何区分?
3. **`keys.ts` 如何把原始字节串变成可以 pattern-match 的逻辑键名**——"读"字是普通可打印字符,`\x1b[A` 是功能键,解码路径有何不同?
4. **East Asian 宽字符的二倍宽如何影响光标渲染**——「读」占 2 列,`Input.render()` 如何保证光标位置正确?

---

## 3. 朴素思路

最直接的做法:在 `process.stdin.on("data", ...)` 里直接判断字节值——如果 `>= 32` 就是可打印字符,插入文本缓冲区;如果是 `\x1b` 开头就是 escape sequence,查表匹配功能键。

---

## 4. 为什么朴素思路会崩

**字节分片问题**:raw mode 下 Node.js `data` 事件触发的时机由内核和 libuv 决定。escape sequence `\x1b[A` 在慢速 SSH 链路上可能被拆成三次 `data` 事件:`\x1b`、`[`、`A`。直接在 `data` 回调里解析会把孤立的 `\x1b` 误判为 Escape 键。

**Kitty 协议与 legacy 序列共存**:现代终端(Kitty、WezTerm、Ghostty)用 CSI-u 格式编码按键,例如普通 `a` 键被编码为 `\x1b[97u`。`97` 是 `a` 的 ASCII 码。同一按键在不同终端下编码完全不同,需要统一的解码层。

**中文输入法 IME 候选字**:输入法开启时,按下字母键先产生 IME 候选序列,确认汉字后才发送最终 UTF-8 字节。如果按字节简单判断,会把 IME 中间状态的字节当成输入。(pi 的处理策略是依赖终端本身的 IME 集成,进程只看到最终确认的 UTF-8 字符——对于 `读` 字就是三字节 `\xe8\xaf\xbb`。)

---

## 5. pi 的做法

pi 用三层过滤器串联处理键盘输入。

**第一层:`StdinBuffer`——escape sequence 完整性保证**

`StdinBuffer`(`packages/tui/src/stdin-buffer.ts:274`)是一个带超时的状态缓冲区。`ProcessTerminal.setupStdinBuffer()` 在 `start()` 内实例化它(`terminal.ts:137`),并把 `process.stdin.on("data", ...)` 的回调替换为 `stdinDataHandler`,后者调用 `stdinBuffer.process(data)`。

`StdinBuffer.process()` 的核心逻辑(`stdin-buffer.ts:287-387`):

```
StdinBuffer.process(data)
  |
  +-- [Bracketed paste 检测]:
  |     发现 \x1b[200~ -> 进入 pasteMode, 积累到 \x1b[201~ 再 emit "paste"
  |
  +-- extractCompleteSequences(buffer)
  |     逐字符扫描:
  |     - 若遇到 \x1b -> 调用 isCompleteSequence(candidate) 判断完整性
  |       "complete" -> 推入 sequences
  |       "incomplete" -> 继续累积字节, 超时后强制 flush
  |     - 若是普通字节 -> 直接推入 sequences (一个字符一个)
  |
  +-- 对每个 sequence: emitDataSequence(sequence)
        |
        +-- [Kitty printable 去重]: 若上一个 sequence 是 Kitty CSI-u
        |    且当前 sequence 是对应的 raw UTF-8 codepoint -> 丢弃 raw
        +-- emit "data", sequence
```

对于「读」字(`\xe8\xaf\xbb`):它不以 `\x1b` 开头,`isCompleteSequence` 返回 `"not-escape"`,`extractCompleteSequences` 把它作为一个完整单元直接 emit。对于 `\x1b[A`:以 `\x1b[` 开头走 CSI 路径,最后一字节 `A` 落在 `0x40-0x7e` 范围,`isCompleteCsiSequence` 返回 `"complete"`。

**第二层:`TUI.handleInput()`——全局拦截 + 焦点路由**

`StdinBuffer` 的 `data` 事件最终调用 `ProcessTerminal` 里注册的 `inputHandler`(`terminal.ts:161`),即 `TUI.start()` 时传入的 `(data) => this.handleInput(data)`。

`TUI.handleInput()`(`tui.ts:544-596`) 按顺序:

1. 遍历 `inputListeners`(全局拦截器,可 consume 或变换 data)
2. 消费终端 cell size 响应(`\x1b[6;...t`)
3. 检测全局调试快捷键 `shift+ctrl+d`
4. 确认 focusedComponent 是否为可见 overlay
5. 调用 `focusedComponent.handleInput(data)` —— 此时 focused = CustomEditor

**第三层:`CustomEditor.handleInput()` + `Editor.handleInput()` + `Input.handleInput()`**

CustomEditor 先检查 app 级快捷键(`app.interrupt`、`app.exit` 等),都不匹配则调 `super.handleInput(data)` 即 `Editor.handleInput()`。

Editor 的解码路径(`packages/tui/src/components/editor.ts:735`):

```
Editor.handleInput(data)
  |
  +-- [tui.input.submit?] Enter -> submitValue()      不匹配
  +-- [tui.editor.cursorUp/Down?]                     不匹配
  +-- [decodeKittyPrintable(data)]
  |     若 Kitty 协议激活: data = "\x1b[35835u" 这类 CSI-u 序列
  |     提取 codepoint -> String.fromCodePoint() -> "读"
  |     若 Kitty 未激活: data = "\xe8\xaf\xbb" (原始 UTF-8)
  |     decodeKittyPrintable 返回 undefined
  |
  +-- [控制字符过滤]:
  |     code < 32 || code === 0x7f || (0x80 <= code <= 0x9f) -> 丢弃
  |     "读" 的 codepoint = 35835 >= 32, 通过过滤
  |
  +-- insertText("读")
        -> state.lines[cursorLine] 插入字符
        -> cursorCol += "读".length (UTF-16 单位 = 1, 但视觉宽 = 2)
```

**East Asian 宽字符的二倍宽处理**

`visibleWidth("读")`(`packages/tui/src/utils.ts:201`) 的执行路径:

- `isPrintableAscii("读")` = false,跳过快速路径
- 调 `eastAsianWidth(35835)`——来自 npm 包 `get-east-asian-width`
- 返回 `2`(W,全宽字符)

`Input.render()` 在计算水平滚动窗口时(`input.ts:434-501`)用 `visibleWidth(value)` 计算总视觉宽度,用 `visibleWidth(value.slice(0, cursor))` 计算光标视觉列位置。对于「读」插入后光标在末尾:

```
value = "读"
totalWidth = visibleWidth("读") = 2
cursorCol  = visibleWidth("读") = 2  (光标在视觉第 2 列之后)
```

渲染时,光标位置字符(即光标右侧的空格或下一个字符)用 `\x1b[7m ... \x1b[27m` 反色高亮显示(`input.ts:493`),看起来就是「块光标」停在「读」字右侧。

完整数据流 ASCII 图:

```
用户按 "读" 字
  |
  | OS 送到 stdin fd (UTF-8: \xe8\xaf\xbb)
  v
process.stdin "data" event -> stdinDataHandler
  |
  v
StdinBuffer.process("\xe8\xaf\xbb")
  extractCompleteSequences -> ["\xe8\xaf\xbb"]  (非 ESC, 直接完整)
  emitDataSequence("\xe8\xaf\xbb")
  emit("data", "\xe8\xaf\xbb")
  |
  v
TUI.handleInput("\xe8\xaf\xbb")
  inputListeners: 无 consume
  focusedComponent = CustomEditor
  CustomEditor.handleInput("\xe8\xaf\xbb")
    app keybindings: 不匹配
    Editor.handleInput("\xe8\xaf\xbb")
      decodeKittyPrintable -> undefined  (非 Kitty 序列)
      控制字符检查: \xe8 = 0xe8 > 0x9f, 不是 C1 控制字符, 通过
      insertText("读")
        state.lines[0] = "读"
        cursorCol = 3  (UTF-16 字节偏移)
  |
  v
TUI.requestRender()
  nextTick -> scheduleRender() -> doRender()
  差分比较: > 输入框行变化
  process.stdout.write(新的输入框行)
  屏幕显示: "> 读|" (| = 反色空格块光标)
```

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/tui/src/stdin-buffer.ts` | 287-387 | `StdinBuffer.process()`:escape sequence 完整性判断主体 |
| `packages/tui/src/stdin-buffer.ts` | 29-78 | `isCompleteSequence()`:区分 ESC/CSI/OSC/APC/SS3/普通字符 |
| `packages/tui/src/stdin-buffer.ts` | 192-255 | `extractCompleteSequences()`:扫描并切分完整序列 |
| `packages/tui/src/stdin-buffer.ts` | 389-398 | `emitDataSequence()`:Kitty printable 去重后 emit |
| `packages/tui/src/terminal.ts` | 136-177 | `setupStdinBuffer()`:实例化 StdinBuffer,挂 data 监听 |
| `packages/tui/src/terminal.ts` | 160-164 | `inputHandler(sequence)`:StdinBuffer 结果送 TUI |
| `packages/tui/src/tui.ts` | 544-596 | `TUI.handleInput()`:全局拦截 + 焦点路由 |
| `packages/tui/src/tui.ts` | 589-595 | `focusedComponent.handleInput(data)` 调用点 |
| `packages/tui/src/keys.ts` | 820-930 | `matchesKey()` 中 `enter` 分支:legacy + Kitty + modifyOtherKeys 三路 |
| `packages/tui/src/keys.ts` | 1349-1382 | `decodeKittyPrintable()`:CSI-u 序列提取 codepoint |
| `packages/tui/src/components/input.ts` | 47-210 | `Input.handleInput()`:submit / backspace / cursor / 字符插入 |
| `packages/tui/src/components/input.ts` | 191-209 | `decodeKittyPrintable` + 控制字符过滤 + `insertCharacter` |
| `packages/tui/src/components/input.ts` | 434-501 | `Input.render()`:水平滚动 + `visibleWidth` + 反色光标 |
| `packages/tui/src/utils.ts` | 1 | `import { eastAsianWidth } from "get-east-asian-width"` |
| `packages/tui/src/utils.ts` | 181 | `let width = eastAsianWidth(cp)` |
| `packages/tui/src/utils.ts` | 201-215 | `visibleWidth()`:ASCII 快速路径 + 缓存 + ANSI 剥离 |

---

## 7. 分支与延伸

- **`keys.ts` 键盘解码完整状态机(matchesKey 各 case、Kitty vs legacy vs modifyOtherKeys)**:见 [第 11 章 §11.15「keys.ts 键盘解码状态机」](./11-tui-components-and-keys.md#1115-keyts-键盘解码状态机)。
- **Input 组件的水平滚动算法与 undo 合并机制**:见 [第 11 章 §11.12「Input」](./11-tui-components-and-keys.md#1112-input)。
- **StdinBuffer 的 `extractCompleteSequences` 算法与 10ms 超时 flush**:见 [第 10 章 §10.5「StdinBuffer」](./10-tui-renderer.md#105-stdinbuffer慢链路-escape-sequence-完整性保证)。
- **`ProcessTerminal` 的 stdin/stdout 抽象**:见 [第 10 章 §10.4「ProcessTerminal」](./10-tui-renderer.md#104-processterminal-raw-mode-与终端控制)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **`StdinBuffer` 存在的唯一理由是 escape sequence 的字节分片**:普通 UTF-8 字符(`读`)不需要它也能正确传递;但 `\x1b[A` 在慢速 SSH 下可能三次 `data` 事件到达,没有 `StdinBuffer` 就会被误判为 Escape + `[` + `A` 三个独立输入。

2. **Kitty 协议激活与否决定了"读"字的编码格式**:Kitty 激活时,终端把 `读`(U+8BFB)编码为 `\x1b[35835u`,进程收到的不是原始 UTF-8。`decodeKittyPrintable` 负责把 `35835` 转回 `String.fromCodePoint(35835)` = `"读"`。未激活时,进程直接收到 `\xe8\xaf\xbb`,控制字符过滤(`code >= 0x80 && code <= 0x9f` 为 C1 控制字符)不会命中它,直接 `insertCharacter`。

3. **`visibleWidth` 是渲染正确性的基础**:`Input.render()` 完全依赖 `visibleWidth` 决定光标在哪一列。`读` 占 2 列,如果用 `"读".length = 1` 计算宽度,光标列会少 1,显示错位。East Asian 宽字符的正确处理靠的就是 `get-east-asian-width` 这个 npm 包里的 Unicode 数据表。

4. **从 `TUI.handleInput` 到字符插入全程同步**:没有 await,没有 Promise。这段路径在单个 `data` 事件回调里同步完成。完成后 `TUI.requestRender()` 用 `process.nextTick` 异步调度渲染——这意味着每次按键后的"屏幕刷新"至少要等到当前调用栈清空。在用户快速连续输入时,多次按键可能共享同一次 `doRender()`。

5. **CustomEditor 是 app 级快捷键的第一道防线**:所有 `app.*` keybinding(Ctrl+C、Ctrl+D 等)在 `CustomEditor.handleInput` 里被拦截,不会传到 `Editor`。Editor 只处理编辑操作(光标移动、字符插入、删除)和 submit。这个分层让 app 层和 TUI 层的快捷键逻辑完全解耦。
