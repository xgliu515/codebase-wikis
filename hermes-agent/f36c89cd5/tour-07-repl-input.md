# Trace 步骤 07 —— 那行字是怎么从键盘进到程序里的？

## 1. 当前情境

上一步结束时，系统提示字符串已经成型并缓存在 `agent._cached_system_prompt` 上。概念上，这一轮对话的 `messages` 列表里已经有了第一条 `[system]` 消息——但它还只是个待用的字符串，因为对话循环还没启动。

`HermesCLI` 实例完整，`AIAgent` 就绪，工具注册表满了，系统提示备好了。整台机器装配完毕，发动机却还没点火。点火的钥匙只有一把：**用户在终端里敲下的那行字**。这一步要回答的问题是——这台交互式 CLI 是怎么把控制权交给用户、又是怎么把用户那行字接进来、并决定它该走哪条路的。

## 2. 问题

`HermesCLI.run()` 要做的不是"读一行 `input()`"那么简单。它要撑起一个**长期运行的 REPL**，同时满足一串约束：

- **输入区常驻底部**：banner、历史回复、输入框要像现代终端 UI 一样，输入框钉在屏幕底部，agent 工作时还能继续打字（中途插话 / steer）。
- **多行输入**：用户可能粘贴一段代码、写一段多行需求，不能一按回车就提交。
- **斜杠命令补全**：输入 `/` 时要弹出 `/help`、`/model`、`/tools` 等命令的自动补全。
- **两条路要分清**：`/` 开头的是**斜杠命令**（改配置、切模型、看帮助），要走 `process_command()`；其它文本是**给 agent 的消息**，要走 `chat()`。两条路绝不能混。
- **不能阻塞**：agent 在跑一个长任务时，REPL 不能死。用户中途敲的字要进一个单独的队列。

我们这条 trace 里，用户敲的是一句普通消息——`读取 README.md 并告诉我它的第一行是什么`，不以 `/` 开头。

## 3. 朴素思路

最朴素的 REPL：一个 `while True` 配 `input()`——

```python
while True:
    line = input("你 ▸ ")
    if line.startswith("/"):
        handle_command(line)
    else:
        print(agent.chat(line))
```

读一行、判断首字符、分发、打印结果、循环。教科书式的 REPL，看起来够用了。

## 4. 为什么朴素思路会崩

`input()` 这条捷径在交互式 agent CLI 上会立刻露馅：

- **`input()` 是阻塞的单行读取**。它不能多行、不能补全、不能把输入框钉在底部、不能在 agent 工作时继续接受打字。粘贴一段 5 行代码进去，第一个换行就把输入提交了。
- **agent 工作时 REPL 整个冻住**。`agent.chat(line)` 是个同步调用，可能跑几十秒。这期间 `input()` 还没轮到执行，用户想"插一句话纠正方向"（steer）做不到，想按 Ctrl+C 优雅打断也接不住。
- **没有渲染分层**。`print(result)` 把回复直接冲进 stdout，和 spinner、状态栏、输入框抢同一片终端区域，输出会互相踩踏、错位。
- **命令与消息的边界太脆**。只看首字符 `/` 不够——拖进来的文件路径可能以 `/` 开头（`/Users/...`），那是文件不是命令；粘贴的文本里可能混着斜杠。判定逻辑需要比 `startswith("/")` 更聪明。

朴素 REPL 的根本问题：它假设"读输入"和"跑 agent"是严格串行的，而交互式 agent 要求二者**并发**。

## 5. Hermes 的做法

Hermes 用 `prompt_toolkit` 搭了一个**全屏 Application**，把"输入"和"agent 执行"拆成两个并发的角色，靠队列通信。

`HermesCLI.run()`（`cli.py:11604`）是这个 REPL 的主入口。它开头做一连串启动工作：

```python
def run(self):
    """Run the interactive CLI loop with persistent input at bottom."""
    _detect_light_mode()                 # 探测终端明暗主题
    print("\n" * (_term_lines - 1), ...) # 把 TUI 推到终端底部
    self.show_banner()                   # 画 banner
    self._show_security_advisories()     # 供应链安全公告
    if self._resumed:                    # 续接会话则回放历史
        if self._preload_resumed_session():
            self._display_resumed_history()
    self._console_print(_welcome_text)   # 欢迎语
    # ... 随机 tip、curator 后台启动 ...
```

接着它初始化一组**跨线程通信的队列和状态**（`cli.py:11719` 起）——这是整个并发模型的核心：

```python
self._agent_running = False
self._pending_input = queue.Queue()     # 空闲时的输入（命令 + 新查询）
self._interrupt_queue = queue.Queue()   # agent 运行中打的字（中途插话）
```

两个队列对应两种状态：agent **空闲**时，输入进 `_pending_input`；agent **运行中**时，输入进 `_interrupt_queue`（由 `chat()` 监听，用于 steer / 打断）。这就解决了朴素思路里"REPL 冻住"的问题——打字永远不被阻塞。

然后 `run()` 用 `prompt_toolkit` 装配键绑定、多行输入区、斜杠命令补全器：

```python
_completer = SlashCommandCompleter(...)   # cli.py:12676
... Buffer(completer=_completer, ...) ... # cli.py:12688
```

`handle_enter`（`cli.py:12608` 附近）是回车键的处理器。它先看一连串模态状态（sudo 密码、审批选择、clarify 问答……），都不是才走普通提交。普通提交时按 agent 是否在跑，把文本投进对应队列。多行判定也在这里——非 `/` 开头且行数 ≥ 5 时不立即提交。

真正的"读一条、分发一条"发生在 `process_loop()`（`cli.py:13540`）这个后台循环里：

<svg viewBox="0 0 820 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="REPL input dispatch from prompt_toolkit through queue to process_loop branching">
  <defs>
    <marker id="ar7a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="220" y="20" width="380" height="44" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="410" y="40" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">prompt_toolkit Application</text>
  <text x="410" y="55" text-anchor="middle" font-size="10" fill="#64748b">前台：渲染 + 收键</text>
  <line x1="410" y1="64" x2="410" y2="90" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7a)"/>
  <text x="425" y="81" font-size="10" fill="#64748b">handle_enter 把文本 put 进队列</text>
  <rect x="270" y="94" width="280" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="410" y="119" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">_pending_input 队列</text>
  <line x1="410" y1="134" x2="410" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7a)"/>
  <text x="425" y="151" font-size="10" fill="#64748b">get(timeout=0.1)</text>
  <rect x="290" y="162" width="240" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="182" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">process_loop()</text>
  <text x="410" y="197" text-anchor="middle" font-size="10" fill="#64748b">_looks_like_slash_command(text)?</text>
  <line x1="410" y1="206" x2="410" y2="224" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="200" y1="224" x2="620" y2="224" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="200" y1="224" x2="200" y2="252" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7a)"/>
  <line x1="620" y1="224" x2="620" y2="252" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7a)"/>
  <text x="270" y="240" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">是（斜杠命令）</text>
  <text x="560" y="240" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">否（普通文本）</text>
  <rect x="60" y="256" width="280" height="56" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.3"/>
  <text x="200" y="278" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">process_command(text)</text>
  <text x="200" y="294" text-anchor="middle" font-size="10" fill="#64748b">cli.py:7683 — 改配置 / 切模型 / 看帮助</text>
  <rect x="480" y="256" width="280" height="56" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="620" y="278" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">self.chat(text)</text>
  <text x="620" y="294" text-anchor="middle" font-size="10" fill="#64748b">cli.py:10739 — 点火对话循环 → 步骤 08</text>
</svg>
<span class="figure-caption">图 T7.1 ｜ 用户文本经 prompt_toolkit 投入 _pending_input 队列，process_loop() 取出并按斜杠判定分发到 process_command 或 chat。</span>

<details>
<summary>ASCII 原版</summary>

```text
       prompt_toolkit Application（前台：渲染 + 收键）
              │  handle_enter 把文本 put 进队列
              ▼
       _pending_input  ──get(timeout=0.1)──►  process_loop()
                                                   │
                              ┌────────────────────┴────────────────────┐
                       _looks_like_slash_command(text)?            否（普通文本）
                              │ 是                                       │
                              ▼                                          ▼
                       process_command(text)   (cli.py:7683)        self.chat(text)  (cli.py:10739)
                       改配置 / 切模型 / 看帮助                     点火对话循环 → 步骤 08
```

</details>

`process_loop()` 的关键片段（`cli.py:13595`）：

```python
if not _file_drop and isinstance(user_input, str) and _looks_like_slash_command(user_input):
    _cprint(f"\n⚙️  {user_input}")
    if not self.process_command(user_input):   # 斜杠命令路径
        self._should_exit = True
    continue
...
self._agent_running = True
app.invalidate()
try:
    self.chat(user_input, images=submit_images or None)  # 普通消息路径
finally:
    self._agent_running = False
```

注意它不是裸 `startswith("/")`：先用 `_detect_file_drop()` 排除拖入的文件路径（那些也以 `/` 开头但不是命令），再用 `_looks_like_slash_command()` 做更稳的判定。这正是第 4 段那个"边界太脆"问题的修法。

- **斜杠命令路径**：`process_command()`（`cli.py:7683`）先把命令小写化做分发匹配，经 `resolve_command()` 解析别名得到 canonical 名字，再走一条 `elif` 链分发到 `quit` / `help` / `tools` / `config` 等处理器。它返回 `bool`——`False` 表示要退出 REPL。
- **普通消息路径**：`chat()`（`cli.py:10739`）才是点火键。它会确保凭证、按需初始化 agent，然后把控制权交给对话循环。

agent 工作期间，屏幕上转的是 `KawaiiSpinner`（`agent/display.py`）——一个表情动画 spinner，配合状态栏告诉用户 agent 在干什么、跑了多久。它是渲染层，跟输入层各管各的，不会互相踩踏。

我们这条 trace：用户敲下 `读取 README.md 并告诉我它的第一行是什么`，回车，`handle_enter` 把它（agent 空闲）投进 `_pending_input`；`process_loop()` `get()` 到它，`_looks_like_slash_command()` 判为否，于是走 `self.chat(user_input)`——下一步就从这里开始。

到这一步结束，REPL 已经收到那行文本，判定它是普通消息，`_agent_running` 即将翻成 `True`，`chat()` 即将被调用。

## 6. 代码位置

按阅读顺序：

- REPL 主入口：`cli.py:11604` —— `def run()`，banner、续接回放、欢迎语、curator 启动。
- 并发队列初始化：`cli.py:11719-11727` —— `_pending_input` / `_interrupt_queue` / `_agent_running`。
- 斜杠命令补全器：`cli.py:12676` —— `SlashCommandCompleter`。
- 回车处理器：`cli.py:12608` 附近 —— `handle_enter`，模态状态优先、多行判定。
- 输入分发循环：`cli.py:13540` —— `process_loop()`，从 `_pending_input` 取、判定、分发。
- 斜杠命令 / 普通消息分叉：`cli.py:13595-13622`。
- 斜杠命令处理：`cli.py:7683` —— `process_command()`，别名解析 + `elif` 分发链。
- 普通消息入口：`cli.py:10739` —— `chat()`，下一步详解。
- 工作中 spinner：`agent/display.py` —— `KawaiiSpinner`。

## 7. 分支与延伸

- `run()` / `process_command()` / `chat()` 在入口体系里的位置、TUI 模式（`HERMES_TUI=1`）的另一条 REPL → [第 2 章 入口与进程引导](02-entrypoints.md)。
- 系统提示在上一步已成型缓存，这一步只是把它待命 → [Trace 步骤 06 —— 拼装系统提示](tour-06-system-prompt.md)。
- 这行文本马上要进 `chat()` 并下沉到对话循环 → [Trace 步骤 08 —— 进入 run_conversation](tour-08-enter-run-conversation.md)。
- agent 运行中打字会进 `_interrupt_queue`，触发 steer / 打断 → [第 3 章 §中途插话与打断](03-conversation-loop.md)。
- 如果用户敲的是 `/model` 之类斜杠命令，走的是 `process_command()` 那条岔路，不在本 trace 主线上 → [第 2 章 §斜杠命令](02-entrypoints.md)。

## 8. 走完这一步你脑子里应该多了什么

1. Hermes 的 REPL 不是 `while + input()`，而是一个 `prompt_toolkit` 全屏 Application——支持多行输入、底部常驻输入框、斜杠命令补全，由 `run()`（`cli.py:11604`）撑起。
2. "收输入"和"跑 agent"是**两个并发角色**，靠两个队列通信：空闲时输入进 `_pending_input`，agent 运行中打的字进 `_interrupt_queue`——打字永远不被阻塞。
3. 输入分发的真正现场是后台的 `process_loop()`（`cli.py:13540`）：它 `get()` 出文本，用 `_looks_like_slash_command()`（而非裸 `startswith("/")`，因为拖入的文件路径也以 `/` 开头）判定走 `process_command()` 还是 `chat()`。
4. `process_command()` 返回 `bool` 控制 REPL 生死；`chat()` 是把普通消息送进对话循环的点火键。
5. 走完这一步，那行用户文本已经在程序手里、已被判为普通消息，`chat()` 即将被调用——但对话循环还没启动，`messages` 列表里仍只有概念上的 `[system]`。
