# Trace 步骤 17 —— 答案怎样一个字一个字地出现在屏幕上？

## 1. 当前情境

[Trace 步骤 16](tour-16-final-response.md) 里对话循环已经退出，`final_response` 字符串就位——一句给用户看的自然语言回答（「README.md 的第一行是一个居中的 `<p>` 标签……」）。`run_conversation` 返回的 dict 已经回到 CLI 层的 `chat()` 手里。

但其实用户在屏幕上**早就**开始看到字了。流式渲染不是「等循环结束才打印」——它在第二次 API 调用吐 token 的过程中就一路渲染。这一步回头看清楚：从第一次 API 调用开始到现在，CLI 是怎么把「正在思考」和「逐字回答」呈现给用户的。

## 2. 问题

CLI 要把 agent 的工作过程呈现给一个**坐在终端前等结果的人**。这要解决几个具体需求：

- **API 调用要几秒甚至几十秒**（两次 LLM 调用 + 一次工具执行）。这期间屏幕不能是死的——用户得知道「它在动，没卡」。
- **回答应当边生成边显示**。等整段 `final_response` 生成完再「啪」地贴出来，对一段几百字的回答意味着用户干等好几秒。
- **终端是个笨设备**。它只能逐行追加，不能像浏览器那样「重排」。可流式 token 是任意切碎的——一个 markdown 表格的一行可能分成五个 chunk 到达。

## 3. 朴素思路

最直接的：API 调用期间打一行 `Loading...`；调用返回后，把 `final_response` 整段 `print` 出来。

想「流式」一点？那就把每个 token chunk 到达时立刻 `print(chunk, end="")`——模型吐什么屏幕显示什么，逐字出现，不就行了？

## 4. 为什么朴素思路会崩

静态 `Loading...` 解决不了「它到底活着没有」——一个挂死的进程也会一直显示 `Loading...`。用户没有任何信号区分「在努力」和「卡死了」。

「token 到了立刻 print」这条看着对，实际会把输出搞得很难看：

- **token 边界不是行边界**。模型可能先吐 `"| 名"`，再吐 `"称 | 值 |"`。逐 chunk 直接打，markdown 渲染、对齐、宽字符处理全乱。中文字符宽度是 2、英文是 1——一个表格如果按 token 边界切着打，列对不齐。
- **思考内容和正式回答混在一起**。推理模型会先吐一大段 reasoning 再吐正式回答。原样逐字打，用户分不清哪些是「它在自言自语」、哪些是「给我的答案」。
- **spinner 和正文打架**。spinner 在终端某行不停重画，正文也要往终端写——两者不协调就会互相覆盖、留下残影。

核心矛盾：流式 token 的**到达节奏**和终端的**渲染需求**不是一回事。中间必须有一层缓冲和协调。

## 5. Hermes 的做法

### KawaiiSpinner：让「在动」可感知

API 调用期间，CLI 跑一个 `KawaiiSpinner`（`agent/display.py:559`）：

```python
class KawaiiSpinner:
    """Animated spinner with kawaii faces for CLI feedback during tool execution."""
```

它不是一个干巴巴的转圈——它从当前皮肤（skin，见[第 2 章](02-entrypoints.md)）取「表情脸谱」和「思考动词」轮播（`display.py:597` 的 `waiting_faces`、`:610` 的 `thinking_faces`、`:623` 的 `thinking_verbs`）。配合 `┊` 活动 feed，工具执行的进展（来自[第 6 章](06-terminal-environments.md)讲的活动回调，「已运行 N 秒」）也一行行喂到屏幕上。用户看到表情在变、秒数在涨，就知道「它在干活」。

### 行缓冲：在 token 流和终端之间架一层

CLI 不逐 token 打，而是逐**行**渲染。`HermesCLI` 上有一组流式状态字段（`cli.py:2601` 附近）：

```python
# Streaming display state
self._stream_buf = ""             # 半行缓冲：凑够一行再渲染
self._stream_started = False      # 第一个 delta 到了没
self._stream_box_opened = False   # 回答框的框头打了没
self._reasoning_preview_buf = ""  # 把细碎的 reasoning chunk 攒起来
```

token chunk 到达时不直接打印，先进 `_stream_buf`。攒到一个换行符，才把这一**整行**拿去渲染。这样 markdown、对齐、宽字符处理都在「完整的行」上做，不会被 token 边界切坏。

表格还要再特殊处理。同样在 `cli.py:2601` 附近：

```python
self._stream_table_buf: list[str] = []   # 疑似表格行先囤这里
self._in_stream_table = False
```

源码注释说得明白——当流式来的某一行看起来像 markdown 表格的一部分，就先囤进 `_stream_table_buf`，等整个表格块结束，再用 `wcwidth` 感知的宽度统一重新对齐（re-pad）。中文列因此能对齐。

### 推理与回答分流

`_reasoning_preview_buf` 把细碎的 reasoning chunk 单独攒起来，作为 `[thinking]` 预览输出——和正式回答区分开。`_stream_box_opened` 标志保证回答正文有一个明确的「框」：框头打一次，正文流式填进框里。用户一眼能分清「它在想」和「这是答案」。

<svg viewBox="0 0 780 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="streaming token render pipeline from API call to terminal box">
  <defs>
    <marker id="t17ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="60" y="24" width="200" height="30" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="160" y="44" text-anchor="middle" font-size="11" fill="#64748b">第一次 API 调用</text>
  <rect x="60" y="62" width="200" height="30" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="160" y="82" text-anchor="middle" font-size="11" fill="#64748b">工具执行</text>
  <rect x="60" y="100" width="200" height="30" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="160" y="120" text-anchor="middle" font-size="11" fill="#64748b">第二次 API 调用</text>
  <rect x="320" y="36" width="380" height="58" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="338" y="58" font-size="11" fill="#64748b">KawaiiSpinner 转动（表情/动词轮播）</text>
  <text x="338" y="78" font-size="11" fill="#64748b">┊ 活动 feed：read_file… (3s elapsed)</text>
  <line x1="260" y1="115" x2="370" y2="115" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="370" y1="115" x2="370" y2="136" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t17ar)"/>
  <text x="380" y="130" font-size="10" fill="#94a3b8">token chunk 流式到达</text>
  <rect x="220" y="138" width="300" height="38" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="370" y="162" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">_stream_buf 半行缓冲 → 凑够一行</text>
  <line x1="290" y1="176" x2="290" y2="216" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t17ar)"/>
  <text x="200" y="200" font-size="10" fill="#94a3b8">疑似表格行</text>
  <line x1="490" y1="176" x2="490" y2="216" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t17ar)"/>
  <text x="500" y="200" font-size="10" fill="#94a3b8">普通行</text>
  <rect x="100" y="218" width="290" height="56" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="245" y="240" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">_stream_table_buf</text>
  <text x="245" y="260" text-anchor="middle" font-size="10" fill="#64748b">块结束后 wcwidth 重对齐</text>
  <rect x="420" y="218" width="260" height="56" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="550" y="250" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">渲染进 response box</text>
  <line x1="245" y1="274" x2="245" y2="320" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="550" y1="274" x2="550" y2="320" stroke="#94a3b8" stroke-width="1.2"/>
  <path d="M245,320 L390,348" fill="none" stroke="#94a3b8" stroke-width="1.2"/>
  <path d="M550,320 L390,348" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t17ar)"/>
  <rect x="200" y="350" width="380" height="40" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="390" y="375" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">终端打印出对齐良好的 response box</text>
</svg>
<span class="figure-caption">图 T17.1 ｜ 流式渲染管线：token chunk 经半行缓冲攒成完整行，表格行额外缓冲重对齐，最终进 response box。</span>

<details>
<summary>ASCII 原版</summary>

```text
   第一次 API 调用 ──┐
                     │  KawaiiSpinner 转动（表情/动词轮播）
   工具执行 ─────────┤  ┊ 活动 feed：read_file… (3s elapsed)
                     │
   第二次 API 调用 ──┘  token chunk 流式到达
        │
        ▼
   _stream_buf 半行缓冲 ──► 凑够一行
        │                      │
        │  疑似表格行?          │ 普通行
        ▼                      ▼
   _stream_table_buf       渲染进 response box
   （块结束后 wcwidth 重对齐）
        │
        ▼
   终端打印出对齐良好的 response box
```

</details>

到这一步结束，spinner 已收起，`README.md` 第一行的回答以一个排版整齐的 response box 出现在终端上——用户看完了答案。

## 6. 代码位置

按阅读顺序：

- spinner：`agent/display.py:559` —— `class KawaiiSpinner`；`display.py:630` `__init__`；脸谱/动词取自皮肤 `display.py:597`、`:610`、`:623`。
- 流式状态字段：`cli.py:2601` 附近 —— `_stream_buf` / `_stream_started` / `_stream_box_opened` / `_reasoning_preview_buf`。
- 表格缓冲：`cli.py:2608` 附近 —— `_stream_table_buf` / `_in_stream_table`。
- 流式回调入口：`cli.py:10739` —— CLI 层 `chat()`，流式 delta 的回调在这里接进渲染。
- 皮肤：`hermes_cli/skin_engine.py` —— spinner 脸谱/动词、response box 样式的数据来源。

## 7. 分支与延伸

- spinner 脸谱、response box 样式如何由皮肤（skin）数据驱动 → [第 2 章 入口与进程引导](02-entrypoints.md)
- `┊` 活动 feed 里「已运行 N 秒」从哪来——执行环境的活动回调 → [第 6 章 终端后端：七种执行环境](06-terminal-environments.md)
- 这段流式回答的内容是怎么生成的（上一步） → [Trace 步骤 16](tour-16-final-response.md)
- 用户看完答案后，这一轮如何落盘（下一步） → [Trace 步骤 18](tour-18-session-persist.md)
- 如果跑的是 `hermes --tui` 或网关，渲染层完全不同（Ink / 平台适配器），但 agent 核心不变 → [第 2 章 §TUI](02-entrypoints.md)、[第 13 章 消息网关与多平台](13-messaging-gateway.md)

## 8. 走完这一步你脑子里应该多了什么

1. 流式渲染**不等循环结束**——第二次 API 调用吐 token 的过程中，回答就一路渲染到屏幕了。
2. CLI 逐**行**渲染而非逐 token：`_stream_buf` 把碎 token 攒成完整行，markdown/对齐/宽字符处理都在完整行上做。
3. 表格要再缓冲一层（`_stream_table_buf`），整块结束后用 `wcwidth` 感知宽度重新对齐——这是中文列能对齐的原因。
4. `KawaiiSpinner` 的价值是「让活着可感知」——变化的表情 + 涨动的秒数，把「在努力」和「卡死了」区分开。
5. 推理内容和正式回答被分流（`_reasoning_preview_buf` vs response box），用户一眼能分清「它在想」和「这是答案」。

---

下一步：[Trace 步骤 18 —— 这一轮对话怎样落进 SQLite？](tour-18-session-persist.md)
