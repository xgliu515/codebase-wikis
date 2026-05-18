# Trace 步骤 13 —— read_file 真的去读那个文件了吗？

## 1. 当前情境

上一步（[Trace 步骤 12](tour-12-tool-dispatch.md)）里，调度器已经认出这次 `tool_call` 要的是 `read_file`，从 `ToolRegistry` 里取出了对应的 `ToolEntry`，`handler` 已经在手，`task_id` 也确定了。`messages` 列表此刻是：

```text
[system, user, assistant(tool_call: read_file path=README.md)]
```

模型的「意图」已经表达完毕。现在到了整条 trace 里唯一一次真正触碰文件系统的时刻——`read_file` 这个工具要把 `README.md` 的内容从磁盘上捞出来。

## 2. 问题

调度器要调用 `read_file` 的 handler，把参数 `{"path": "README.md"}` 交给它，期望拿回文件内容。这一步要解决的具体需求有三个：

- **真的读到文件**：把相对路径 `README.md` 解析成绝对路径，读出内容。
- **结果要能塞回对话**：拿到的内容最终要变成一条 `tool` 消息回灌给模型（下一步的事），所以 handler 的返回值必须是模型和循环代码都能消费的统一形态。
- **不能让 agent 干坏事**：`read_file` 这次是读一个无害的 README，但工具系统不知道下一次 agent 会不会去读 `~/.ssh/id_rsa`、或者调 `terminal` 跑 `rm -rf`。执行工具的这条路径必须有一道安全闸。

## 3. 朴素思路

最直接的写法：handler 就是一个普通函数，`open(path).read()` 返回字符串。调度器拿到字符串，包一包丢回去。每个工具想返回什么类型就返回什么类型——`read_file` 返回 str，某个查天气的工具返回 dict，某个计数工具返回 int。

安全？跑之前 `if command in DANGEROUS_LIST: refuse`，维护一张黑名单。

## 4. 为什么朴素思路会崩

「每个工具返回自己喜欢的类型」会在循环代码里炸开。下一步要把工具结果包成 `tool` 消息追加进 `messages`——`tool` 消息的 `content` 字段必须是字符串。如果 handler 返回 dict、int、None、抛异常……循环代码就得为每种类型写分支，每加一个工具就可能多一种意外类型。而且工具结果常常不是「一个值」，而是「值 + 元信息」：读文件成功了吗？读了多少字符？被截断了吗？一个裸 str 装不下这些。

读文件还有具体的崩法：`README.md` 是相对路径，相对谁？相对 agent 进程的 CWD？相对会话配置的工作目录？解析错了就读到别的文件甚至 `FileNotFoundError`。文件可能有 500MB——整个读进内存再塞进对话，直接撑爆 context window。

黑名单式安全则是注定漏的：`rm -rf` 能拦，`rm  -rf`（两个空格）、`/bin/rm`、`python -c "import os;os.remove(...)"` 呢？危险命令的写法是无穷的，黑名单永远落后一步。

## 5. Hermes 的做法

### 所有 handler 统一返回 JSON 字符串

这是工具系统最硬的一条契约（见[第 5 章](05-tool-system.md)）：每个工具 handler 都返回一个 **JSON 字符串**。`read_file` 的实现 `read_file_tool()` 在 `tools/file_tools.py:447`，通篇可以看到它无论成功失败都 `json.dumps`：

```python
def read_file_tool(path: str, offset: int = 1, limit: int = 500,
                    task_id: str = "default") -> str:
    ...
    return json.dumps(result_dict, ensure_ascii=False)   # file_tools.py:654
```

成功返回 `{"content": ..., "lines": ..., "truncated": ...}` 这样的结构序列化成的字符串；出错也返回 `{"error": ...}`（`file_tools.py:456`、`469`、`480`……一连串错误出口）。循环代码因此只需面对一种类型——字符串——就够了。`ensure_ascii=False` 保证中文等非 ASCII 内容原样保留，不被转义成 `\uXXXX`。

### 大文件防御

`tools/file_tools.py:35` 定义了 `_DEFAULT_MAX_READ_CHARS = 100_000`。读文件不会无脑全读——超过上限就截断，并在返回的 JSON 里带上 `truncated` 标志告诉模型「这只是一部分」。`read_file_tool` 还接受 `offset`/`limit` 参数，让模型能分页读大文件。

注册时这条契约又被加固了一道（`file_tools.py:1169`）：

```python
registry.register(name="read_file", toolset="file", schema=READ_FILE_SCHEMA,
                   handler=_handle_read_file, check_fn=_check_file_reqs,
                   emoji="📖", max_result_size_chars=100_000)
```

`max_result_size_chars=100_000` 是注册表层面的结果尺寸上限——即使 handler 自己没截断，注册表也会兜底裁剪，绝不让一个超大结果回灌进对话。注意 `toolset="file"`：这个工具只有同时出现在 `file` 工具集里、且该工具集对当前 agent 启用，才会真正暴露给模型（见 [Trace 步骤 05](tour-05-tool-discovery.md)）。

### 审批闸：不是黑名单，是分级拦截

执行危险操作前要过 `tools/approval.py` 这道闸。它不是一张静态黑名单，而是分级检测：`detect_dangerous_command()`（`approval.py:470`）识别危险命令、`detect_hardline_command()`（`approval.py:269`）识别绝不放行的「硬红线」操作。命令在执行前会先 `_normalize_command_for_detection()`（`approval.py:452`）归一化——把多余空格、路径变体折叠掉，再做检测，正是为了对抗「`rm  -rf`」这种黑名单绕过。匹配到危险操作时，会向用户发起审批请求；用户批准过的模式会被记成 `_ApprovalEntry`（`approval.py:503`）缓存，下次同类操作不再打扰。

对 `read_file` 读一个项目内的 README 而言，这次它平稳通过——读取项目文件是无害操作，不触发审批。但同一道闸，在 agent 下一次想 `terminal` 跑 `sudo rm` 时就会拦下来。安全的边界是「这个动作危不危险」，不是「这个工具名在不在名单里」。

<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="read_file tool execution flow through approval gate">
  <defs>
    <marker id="t13ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="270" y="20" width="220" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="44" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">handler 选定（read_file）</text>
  <line x1="380" y1="60" x2="380" y2="92" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar)"/>
  <rect x="120" y="94" width="520" height="124" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="138" y="116" font-size="13" font-weight="600" fill="currentColor">审批闸　tools/approval.py</text>
  <rect x="138" y="128" width="484" height="26" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
  <text x="150" y="145" font-size="11" fill="#64748b">detect_hardline_command　→　命中：直接拒绝</text>
  <rect x="138" y="158" width="484" height="26" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
  <text x="150" y="175" font-size="11" fill="#64748b">detect_dangerous_command　→　命中：向用户发起审批</text>
  <rect x="138" y="188" width="484" height="26" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/>
  <text x="150" y="205" font-size="11" fill="#64748b">读项目内文件：无害，放行 ✓</text>
  <line x1="380" y1="218" x2="380" y2="250" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar)"/>
  <rect x="120" y="252" width="520" height="106" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="138" y="274" font-size="13" font-weight="600" fill="currentColor">read_file_tool(path="README.md")</text>
  <text x="540" y="274" text-anchor="end" font-size="10" fill="#64748b">file_tools.py:447</text>
  <text x="150" y="298" font-size="11" fill="#64748b">解析路径 → 绝对路径</text>
  <text x="150" y="318" font-size="11" fill="#64748b">读取内容（受 _DEFAULT_MAX_READ_CHARS=100_000 限制）</text>
  <text x="150" y="338" font-size="11" fill="#64748b">json.dumps({content, lines, truncated})</text>
  <text x="540" y="338" text-anchor="end" font-size="10" fill="#94a3b8">file_tools.py:654</text>
  <line x1="380" y1="358" x2="380" y2="386" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar)"/>
  <rect x="270" y="388" width="220" height="30" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="408" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">返回 JSON 字符串</text>
</svg>
<span class="figure-caption">图 T13.1 ｜ read_file 执行路径：handler 选定后先过 approval.py 审批闸，再读文件并统一返回 JSON 字符串。</span>

<details>
<summary>ASCII 原版</summary>

```text
   handler 选定（read_file）
        │
        ▼
   审批闸 tools/approval.py
   ├─ detect_hardline_command  → 命中：直接拒绝
   ├─ detect_dangerous_command → 命中：向用户发起审批
   └─ 读项目内文件：无害，放行
        │
        ▼
   read_file_tool(path="README.md")   file_tools.py:447
   ├─ 解析路径 → 绝对路径
   ├─ 读取内容（受 _DEFAULT_MAX_READ_CHARS=100_000 限制）
   └─ json.dumps({content, lines, truncated})   file_tools.py:654
        │
        ▼
   返回 JSON 字符串
```

</details>

到这一步结束，`read_file` 已经把 `README.md` 的内容读出来，包成一个 JSON 字符串（里面的 `content` 字段是文件正文，第一行就是那个居中的 `<p>` banner 标签）。这个字符串就握在循环代码手里，等着被包成 `tool` 消息。

## 6. 代码位置

按阅读顺序：

- 工具实现：`tools/file_tools.py:447` —— `read_file_tool()`，读文件主体。
- 统一返回：`tools/file_tools.py:654` —— `json.dumps(result_dict, ensure_ascii=False)`。
- 大小上限：`tools/file_tools.py:35` —— `_DEFAULT_MAX_READ_CHARS = 100_000`。
- 注册：`tools/file_tools.py:1169` —— `registry.register(name="read_file", toolset="file", ..., max_result_size_chars=100_000)`。
- 审批检测：`tools/approval.py:470` `detect_dangerous_command()`、`tools/approval.py:269` `detect_hardline_command()`、`tools/approval.py:452` `_normalize_command_for_detection()`。

## 7. 分支与延伸

- 「所有 handler 返回 JSON 字符串」这条契约的全貌、以及注册表如何收口 → [第 5 章 工具系统](05-tool-system.md)
- 如果这次调用的是 `terminal` 而非 `read_file`，命令会进入某个执行环境（local/docker/ssh……），审批闸的作用更关键 → [第 6 章 终端后端：七种执行环境](06-terminal-environments.md)
- 工具是怎样被选中、handler 是怎样被取出来的（上一步） → [Trace 步骤 12](tour-12-tool-dispatch.md)
- 拿到的 JSON 字符串怎样变成 `tool` 消息回灌（下一步） → [Trace 步骤 14](tour-14-tool-result.md)
- `read_file` 只是 `file` 工具集的一员，它为何要在工具集里才生效 → [Trace 步骤 05](tour-05-tool-discovery.md)

## 8. 走完这一步你脑子里应该多了什么

1. **每个工具 handler 都返回一个 JSON 字符串**——这条契约让对话循环只需面对一种类型，是工具系统能保持简单的根本原因。
2. 工具结果不是「一个值」，而是「值 + 元信息」——`read_file` 的 JSON 里带着 `truncated`、行数等字段，让模型知道自己拿到的是不是完整内容。
3. Hermes 有**两道大小防线**：handler 自己受 `_DEFAULT_MAX_READ_CHARS` 约束，注册表再用 `max_result_size_chars` 兜底——大文件绝不会撑爆 context window。
4. 安全闸 `approval.py` 的判据是「这个动作危不危险」，不是「工具名在不在黑名单」；命令会先归一化再检测，专门对抗空格/路径变体的绕过。
5. 整条 trace 里，**这一步是唯一真正触碰外部世界（文件系统）的时刻**——前面都在准备，后面都在消费这个结果。

---

下一步：[Trace 步骤 14 —— 工具结果怎样变回模型能读的消息？](tour-14-tool-result.md)
