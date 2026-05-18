# Trace 步骤 08 —— 控制权是怎么沉到对话循环里的？

## 1. 当前情境

上一步结束时，`process_loop()` 已经从 `_pending_input` 取出了用户那行文本 `读取 README.md 并告诉我它的第一行是什么`，判定它是普通消息（不是斜杠命令），`_agent_running` 即将翻成 `True`，`self.chat(user_input)` 即将被调用。

此刻 `messages` 列表里概念上只有第一条 `[system]` 消息。这一步要回答的问题是：从 CLI 层的 `chat()` 开始，控制权要经过几次转发才落到真正的对话循环；这个循环在正式干活前要做哪些初始化；以及它的主 `while` 循环到底靠什么条件运转和退出。

## 2. 问题

"把一条消息交给 agent"这件事，要跨过一道**分层边界**：

- CLI 层（`cli.py` 里的 `HermesCLI`）管终端、队列、渲染、中途插话。
- Agent 核心层（`AIAgent` + `agent/conversation_loop.py`）管对话状态、工具调度、API 调用。

CLI 不该知道对话循环的内部细节，Agent 核心也不该知道终端长什么样。所以二者之间需要一个**清晰的转发链**，而不是 CLI 直接伸手进循环内部。

进了对话循环还有一串问题要先解决：这一轮要不要续接历史消息？上一轮如果创建了 Todo，要不要恢复？重试计数器、迭代预算要不要清零（否则上一轮 subagent 用掉的预算会吃掉这一轮）？还有最关键的——这个"想→调工具→再想"的循环，靠什么条件循环、靠什么条件停下来，才不会无限打转、不会烧光预算。

## 3. 朴素思路

最直觉的写法：CLI 直接调一个 agent 方法，方法里写个循环——

```python
# cli 层
self.agent.run(user_input)

# agent 里
def run(self, msg):
    self.messages.append({"role": "user", "content": msg})
    while True:                          # 想→调工具→再想
        resp = call_llm(self.messages)
        if not resp.tool_calls:
            return resp.text             # 没有工具调用 = 结束
        for tc in resp.tool_calls:
            self.messages.append(run_tool(tc))
```

一个 `while True`，没有 `tool_call` 就 `return`。这就是 agent 循环的本质，看起来对。

## 4. 为什么朴素思路会崩

这个写法埋了几颗雷：

- **`while True` 没有刹车**。模型可能陷进"调工具→看结果→再调同一个工具"的死循环，或者一个接一个无意义地调下去。没有上界的循环会一直烧 API 费用，直到撞上 provider 的限流或用户手动 Ctrl+C。Agent 必须有一个**硬性的迭代上界**。
- **状态不隔离**。`self.messages` 直接累加，上一轮的重试计数、subagent 预算消耗、Todo 状态全留在实例上。下一轮一开始预算就已经被吃掉一半，循环可能没几步就"预算耗尽"提前退出。
- **续接会话丢上下文**。gateway 每条消息新建一个 `AIAgent`，内存里的 Todo store、记忆 nudge 计数器全是空的。如果不从持久化历史里"水合"回来，agent 会忘掉自己几轮前建的 Todo。
- **CLI 和循环耦合死**。CLI 直接调循环方法，等于把终端逻辑和对话逻辑焊在一起——以后想从 gateway、batch、ACP 等别的入口复用这个循环就做不到了。

朴素思路把"循环逻辑"和"启动这个循环的上下文"混成了一坨。

## 5. Hermes 的做法

Hermes 用**三层转发 + 一段初始化 + 有界 while** 解决。

**转发链**——控制权从 CLI 沉到循环，要经过三次转发，每一跳都只做一件薄薄的事：

<svg viewBox="0 0 820 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Three-hop forwarding chain from CLI chat to conversation loop while loop">
  <defs>
    <marker id="ar8a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="180" y="20" width="460" height="50" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="410" y="40" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">HermesCLI.chat(message)</text>
  <text x="410" y="56" text-anchor="middle" font-size="10" fill="#64748b">cli.py:10739 — 确保凭证、按需 _init_agent、路由图片附件</text>
  <line x1="410" y1="70" x2="410" y2="92" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8a)"/>
  <text x="425" y="86" font-size="10" fill="#64748b">在 agent 线程里直连调用</text>
  <rect x="180" y="96" width="460" height="50" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.3"/>
  <text x="410" y="116" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">AIAgent.run_conversation(...)</text>
  <text x="410" y="132" text-anchor="middle" font-size="10" fill="#64748b">run_agent.py:3838 — 纯转发器，两行函数体</text>
  <rect x="660" y="96" width="140" height="50" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="730" y="115" text-anchor="middle" font-size="10" fill="#64748b">AIAgent.chat()</text>
  <text x="730" y="130" text-anchor="middle" font-size="9" fill="#94a3b8">便捷封装，只取</text>
  <text x="730" y="141" text-anchor="middle" font-size="9" fill="#94a3b8">final_response</text>
  <line x1="660" y1="121" x2="644" y2="121" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar8a)"/>
  <line x1="410" y1="146" x2="410" y2="168" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8a)"/>
  <text x="425" y="162" font-size="10" fill="#64748b">from agent.conversation_loop import run_conversation</text>
  <rect x="180" y="172" width="460" height="50" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="192" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">run_conversation(agent, user_message, ...)</text>
  <text x="410" y="208" text-anchor="middle" font-size="10" fill="#64748b">conversation_loop.py:85 — 真正的对话循环在这里</text>
  <line x1="410" y1="222" x2="410" y2="244" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8a)"/>
  <text x="425" y="238" font-size="10" fill="#64748b">初始化：DB 会话、计数器清零、IterationBudget 重置</text>
  <rect x="240" y="248" width="340" height="50" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="268" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">while 主循环</text>
  <text x="410" y="284" text-anchor="middle" font-size="10" fill="#64748b">conversation_loop.py:532 — 有界：api_call_count &lt; max_iterations</text>
</svg>
<span class="figure-caption">图 T8.1 ｜ 控制权经三跳转发从 CLI 的 chat() 沉到 conversation_loop 的有界 while 主循环，循环逻辑只有一份供各入口共用。</span>

<details>
<summary>ASCII 原版</summary>

```text
  cli.py:10739   HermesCLI.chat(message)
        │   确保凭证、按需 _init_agent、路由图片附件
        │   在 agent 线程里调：
        ▼
  run_agent.py:3851  AIAgent.chat()   ← 简单封装，返回 final_response
        │   （CLI 实际走的是下面这条直连）
  run_agent.py:3838  AIAgent.run_conversation(...)
        │   纯转发：from agent.conversation_loop import run_conversation
        ▼
  agent/conversation_loop.py:85  run_conversation(agent, user_message, ...)
        │   ← 真正的对话循环在这里
        ▼
  agent/conversation_loop.py:532  while 主循环
```

</details>

`AIAgent.run_conversation()`（`run_agent.py:3838`）的函数体只有两行——它就是个转发器：

```python
def run_conversation(self, user_message, system_message=None,
                     conversation_history=None, task_id=None,
                     stream_callback=None, persist_user_message=None):
    """Forwarder — see ``agent.conversation_loop.run_conversation``."""
    from agent.conversation_loop import run_conversation
    return run_conversation(self, user_message, system_message,
                            conversation_history, task_id, stream_callback,
                            persist_user_message)
```

`AIAgent.chat()`（`run_agent.py:3851`）是个更简单的便捷封装，调 `run_conversation` 后只取 `result["final_response"]`。注意 CLI 实际上**直接调 `self.agent.run_conversation()`**（`cli.py:10987`），因为它需要完整的结果字典（`messages`、`api_calls`、`completed` 等），不止 `final_response`。这条转发链的价值是：真正的循环逻辑只有一份，住在 `agent/conversation_loop.py`，CLI / gateway / batch / ACP 都通过同一个转发器进入它——循环和入口彻底解耦。

**初始化阶段**（`conversation_loop.py:115-256`）——进了 `run_conversation`，正式循环前要先把"地基"打好：

```python
agent._ensure_db_session()                    # 确保 SQLite 会话存在
set_session_context(agent.session_id)         # 给本线程日志打 session 标签
agent._restore_primary_runtime()              # 恢复上一轮 fallback 切走的 runtime
user_message = _sanitize_surrogates(user_message)   # 清掉粘贴带进的非法代理字符

# 重试计数器 / 各种 per-turn 状态清零（132-191）
agent._invalid_tool_retries = 0
agent._invalid_json_retries = 0
agent._empty_content_retries = 0
# ... 还有十几个 ...
agent.iteration_budget = IterationBudget(agent.max_iterations)  # 重置迭代预算

messages = list(conversation_history) if conversation_history else []

# Todo 恢复（231-235）：gateway 每条消息新建 AIAgent，内存 Todo 为空
if conversation_history and not agent._todo_store.has_items():
    agent._hydrate_todo_store(conversation_history)
```

第 231-235 行的 **Todo 恢复**正是第 4 段"续接丢上下文"的修法：续接会话时从历史里最后一条 todo 工具响应里把 Todo 状态水合回来。紧接着 237-256 行还会从历史里的用户轮数**水合记忆 nudge 计数器**——同理，gateway 新建的 agent 这些计数器都从 0 开始，不水合就永远触发不了记忆 review。

重试计数器**每轮清零**也是修"状态不隔离"：上一轮 subagent 用掉的预算不会吃进这一轮。

随后用户消息被追加进 `messages`，系统提示从缓存（或 SQLite 快照）取出（步骤 06 已详述这段）。

**有界 while 主循环**（`conversation_loop.py:532`）——这是对话的心跳：

```python
while (api_call_count < agent.max_iterations
       and agent.iteration_budget.remaining > 0) or agent._budget_grace_call:
    ...
    api_call_count += 1
    agent._api_call_count = api_call_count
    ...
```

退出条件就是第 4 段那个"刹车"。它有两道独立的闸：

- `api_call_count < agent.max_iterations` —— API 调用次数的硬上界。`api_call_count` 在 `conversation_loop.py:461` 初始化为 `0`。
- `agent.iteration_budget.remaining > 0` —— `IterationBudget` 是一套更细的预算，subagent 的递归调用也从这里扣，防止子 agent 把预算挖空。
- `_budget_grace_call` —— 预算刚耗尽时给模型的"最后一次机会"宽限标志。

**为什么是同步循环**：这个 `while` 是彻底同步、单线程的——一轮 API 调用、一批工具执行、再一轮，严格串行。Agent 的语义本来就是因果链条：模型必须先看到上一批工具的结果，才能决定下一步。强行异步并发只会制造竞态，而拿不到任何收益（瓶颈是 LLM 的网络往返，不是 CPU）。中途插话 / 打断不靠并发实现，而是循环每轮顶部检查 `agent._interrupt_requested` 标志（`conversation_loop.py:537`）——一个协作式的检查点，干净利落。

我们这条 trace 此刻的状态：控制权已经沉到 `run_conversation`，初始化做完，`api_call_count = 0`，`messages = [system, user]`，循环马上要跑第一圈。

到这一步结束，对话循环已经启动，计数器归零，`messages` 里有了 `system` 和 `user` 两条，下一步就是循环体内"发第一次 API 调用前"的准备工作。

## 6. 代码位置

按阅读顺序：

- CLI 层入口：`cli.py:10739` —— `HermesCLI.chat()`，确保凭证、`_init_agent`、图片路由。
- CLI 直连循环：`cli.py:10987` —— `self.agent.run_conversation(...)` 实际调用点。
- 便捷封装：`run_agent.py:3851` —— `AIAgent.chat()`，只取 `final_response`。
- 转发器：`run_agent.py:3838` —— `AIAgent.run_conversation()`，两行转发到 `conversation_loop`。
- 真正的对话循环：`agent/conversation_loop.py:85` —— `run_conversation()`。
- 初始化与计数器清零：`agent/conversation_loop.py:115-191`。
- 迭代预算重置：`agent/conversation_loop.py:215` —— `IterationBudget(agent.max_iterations)`。
- Todo 恢复：`agent/conversation_loop.py:231-235` —— `_hydrate_todo_store()`。
- 记忆 nudge 计数器水合：`agent/conversation_loop.py:237-256`。
- `api_call_count` 初始化：`agent/conversation_loop.py:461`。
- 有界 while 主循环：`agent/conversation_loop.py:532`。
- 每轮顶部的打断检查点：`agent/conversation_loop.py:537`。

## 7. 分支与延伸

- 对话循环的完整结构——每轮的 API 调用、工具调度、压缩、退出原因、post-turn hook → [第 3 章 核心对话循环](03-conversation-loop.md)。
- `chat()` 把那行文本交进来的全过程在上一步 → [Trace 步骤 07 —— REPL 读取用户输入](tour-07-repl-input.md)。
- 循环跑第一圈前还要做记忆 prefetch 和 `api_messages` 组装 → [Trace 步骤 09 —— 记忆 prefetch 与消息构造](tour-09-memory-prefetch.md)。
- `IterationBudget` 如何被 subagent 递归扣减、预算耗尽后的宽限机制 → [第 3 章 §迭代预算](03-conversation-loop.md)。
- 上下文压缩在 preflight 阶段（循环之前）和循环之中各有一次触发 → [第 3 章 §上下文压缩](03-conversation-loop.md)。

## 8. 走完这一步你脑子里应该多了什么

1. 从 CLI 到对话循环是一条**三跳转发链**：`cli.py` 的 `chat()` → `run_agent.py:3838` 的 `run_conversation()`（纯转发）→ `agent/conversation_loop.py:85` 的真正循环。转发的意义是循环逻辑只有一份，CLI / gateway / batch 共用。
2. 进循环前有一段必做的**初始化**：DB 会话、surrogate 清洗、十几个重试计数器清零、`IterationBudget` 重置——每轮清零是为了让上一轮 subagent 的预算消耗不污染这一轮。
3. **续接会话要"水合"**：gateway 每条消息新建 `AIAgent`，内存里的 Todo store（`conversation_loop.py:231-235`）和记忆 nudge 计数器都是空的，必须从持久化历史里重建，否则 agent 会忘掉几轮前的 Todo。
4. 主 `while` 循环（`conversation_loop.py:532`）的退出条件是 `api_call_count < max_iterations and iteration_budget.remaining > 0`——两道独立的刹车，外加 `_budget_grace_call` 宽限标志，杜绝无限烧钱的死循环。
5. 这个循环是**同步单线程**的——因为 agent 的"想→调工具→再想"本质是因果链，模型必须先看到工具结果才能继续；中途插话靠每轮顶部检查 `_interrupt_requested` 这个协作式检查点实现，而非并发。
