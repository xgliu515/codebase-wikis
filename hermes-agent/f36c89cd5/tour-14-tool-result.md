# Trace 步骤 14 —— 工具结果怎样回灌进对话？

## 1. 当前情境

上一步（[Trace 步骤 13](tour-13-read-file-exec.md)）里 `read_file` 真的把 README.md 读了出来。`tool_executor` 拿到的 `function_result` 是一个 JSON 字符串——里面装着文件全文、行号、可能还有截断标记。

但这个字符串现在只是一个**局部变量**，飘在 `execute_tool_calls_sequential` 的栈上。它还不在 `messages` 里。而 `messages` 才是下一次 API 调用真正要发出去的东西。

此刻状态盘点：

```text
messages = [
  system,                       # 步骤 06 拼好的系统提示
  user,                         # "读取 README.md 并告诉我第一行"
  assistant(tool_calls=[read_file]),  # 步骤 11 模型返回的工具调用
]
function_result = '{"content": "<p align=\\"center\\">...", ...}'  # 步骤 13 的产物，还在栈上
api_call_count = 1               # 第一次 API 调用已计数
```

这一步要做的，是把 `function_result` **变成 `messages` 里的一条消息**，然后让对话循环回绕到顶部，准备第二次 API 调用。听起来只是一次 `list.append`——但 append 成什么形状、append 之前要不要动它、append 完循环怎么转，每一个都是设计点。

## 2. 问题

工具执行完了，模型在等结果。要把结果送回模型，必须解决三件事：

- **结果要变成模型听得懂的消息**。OpenAI 兼容的对话协议里，工具产出不是普通文本，而是一种专门的 `role="tool"` 消息，并且必须用 `tool_call_id` 和上一条 assistant 消息里的某个 `tool_call` **精确配对**。配错或漏掉，下一次 API 调用直接 400。
- **结果可能大到撑爆上下文**。`read_file` 读一个小 README 没问题，但同一个工具读一个 5 MB 的日志文件呢？把 5 MB 原样塞进 `messages`，下一次 API 调用的输入就爆了上下文窗口——要么报错，要么烧掉天文数字的 token。
- **回灌完，循环必须自己转回去**。append 一条 tool 消息不是终点。对话还没结束——模型还没说出给用户看的答案。循环必须知道"工具回合结束了，回去再问一次模型"。

## 3. 朴素思路

最直觉的写法：工具一返回，就把结果当成一条普通用户消息塞进去。

```python
result = read_file(path="README.md")
messages.append({"role": "user", "content": f"工具返回了：{result}"})
response2 = call_api(messages)   # 再问一次
```

看上去能跑：模型确实会读到文件内容，也确实会据此回答。而且"用 user 消息伪装工具结果"这招在没有 function calling 的老式 prompt 里就是标准做法。

至于大结果——朴素思路会说"那就 `result[:10000]` 截一刀呗"。

## 4. 为什么朴素思路会崩

把工具结果伪装成 user 消息，会在三个地方崩：

- **角色交替被破坏**。OpenAI 协议要求消息大致按 `user → assistant → user → assistant` 交替。上一条已经是 `assistant(tool_calls=...)`，紧接着塞一条 `user`，序列变成 `...assistant(tool_calls) → user`——而协议规定带 `tool_calls` 的 assistant 消息**后面必须跟 `role="tool"` 的结果**，每个 `tool_call` 对应一条。少了它，Anthropic 直接报 `400`，OpenAI 多半返回空内容触发重试循环。Hermes 甚至专门有 `_repair_message_sequence`（`conversation_loop.py:668`）来兜底这种被弄坏的序列。
- **`tool_call_id` 丢了，并行工具就乱套**。一个 assistant 回合可以同时发出 3 个 `tool_call`。如果工具结果不带 `tool_call_id`，模型根本没法知道哪条结果对应哪个调用。伪装成 user 消息的方案里这个 id 字段无处安放。
- **粗暴 `[:10000]` 截断会切坏 JSON**。`read_file` 返回的是 JSON 字符串，从中间一刀切下去，剩下的就是非法 JSON——模型读到半截括号，要么困惑要么报错。而且固定 10000 这个数字对每种工具都不合适：`read_file` 想多给点、`search_files` 想少给点。

核心矛盾是：工具结果是**协议里的一等公民**，有自己的 role、有强制的配对约束、有按工具区分的体量上限——把它当普通文本糊弄过去，迟早在某个回合炸开。

## 5. Hermes 的做法

Hermes 把工具结果当成协议一等公民来处理。`execute_tool_calls_sequential` 在工具返回后，构造一条**结构完整的 `role="tool"` 消息**并 append 进 `messages`：

```python
# agent/tool_executor.py:862-869
_tool_content = agent._tool_result_content_for_active_model(function_name, function_result)
tool_msg = {
    "role": "tool",
    "name": function_name,        # "read_file"
    "content": _tool_content,     # 文件内容（或它的预览 + 落盘引用）
    "tool_call_id": tool_call.id, # ← 与步骤 11 的 tool_call 精确配对
}
messages.append(tool_msg)
```

`tool_call_id` 是这条消息的**身份绑定**。步骤 11 模型返回的 `tool_call` 自带一个 `id`（形如 `call_abc123`）。这条 tool 消息把同一个 `id` 抄回来——下一次 API 调用时，模型据此把"我点名要调用的 read_file"和"这就是 read_file 的结果"对上号。一个回合发了 3 个 `tool_call`，就 append 3 条 tool 消息，靠 3 个不同的 `id` 各自归位。

大结果的问题，Hermes 不靠粗暴切片，而用**三级防御**（见 `tools/tool_result_storage.py` 文件头注释）：

<svg viewBox="0 0 780 392" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="three-tier defense against oversized tool results">
  <defs>
    <marker id="t14ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="390" y="26" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">工具结果体量防御的三道闸</text>
  <rect x="90" y="44" width="600" height="80" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="108" y="68" font-size="13" font-weight="600" fill="currentColor">① 工具自截断</text>
  <text x="108" y="90" font-size="11" fill="#64748b">search_files 等工具在 return 之前自己先截</text>
  <text x="108" y="110" font-size="10" fill="#94a3b8">工具作者唯一能控制的一道</text>
  <line x1="390" y1="124" x2="390" y2="148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t14ar)"/>
  <rect x="90" y="150" width="600" height="108" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="108" y="174" font-size="13" font-weight="600" fill="currentColor">② 单结果落盘 — maybe_persist_tool_result()</text>
  <text x="108" y="196" font-size="11" fill="#64748b">结果 &gt; registry.get_max_result_size(tool_name)</text>
  <text x="108" y="216" font-size="11" fill="#64748b">→ 全文写进沙箱临时目录 /tmp/hermes-results/{id}.txt</text>
  <text x="108" y="234" font-size="11" fill="#64748b">→ messages 里只留「预览 + 文件路径」</text>
  <text x="108" y="250" font-size="11" fill="#64748b">→ 模型想看全文，自己再 read_file</text>
  <line x1="390" y1="258" x2="390" y2="282" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t14ar)"/>
  <rect x="90" y="284" width="600" height="86" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="108" y="308" font-size="13" font-weight="600" fill="currentColor">③ 整回合预算 — enforce_turn_budget()</text>
  <text x="108" y="330" font-size="11" fill="#64748b">一个 assistant 回合所有 tool 结果加起来 &gt; 200K 字符</text>
  <text x="108" y="350" font-size="11" fill="#64748b">→ 把最大的几个溢出到磁盘，直到总量回到预算内</text>
</svg>
<span class="figure-caption">图 T14.1 ｜ 过大工具结果的三级防御：工具自截断 → 单结果落盘 → 整回合 200K 预算。</span>

<details>
<summary>ASCII 原版</summary>

```text
工具结果体量防御的三道闸

  ① 工具自截断    ── search_files 等工具在 return 之前自己先截
                     （工具作者唯一能控制的一道）
        │
        ▼
  ② 单结果落盘    ── maybe_persist_tool_result()
     结果 > registry.get_max_result_size(tool_name)
        → 全文写进沙箱临时目录 /tmp/hermes-results/{id}.txt
        → messages 里只留「预览 + 文件路径」
        → 模型想看全文，自己再 read_file
        │
        ▼
  ③ 整回合预算    ── enforce_turn_budget()
     一个 assistant 回合所有 tool 结果加起来 > 200K 字符
        → 把最大的几个溢出到磁盘，直到总量回到预算内
```

</details>

关键就在 `tool_executor.py:845-850`：append 之前先过一道 `maybe_persist_tool_result`：

```python
# agent/tool_executor.py:845-850
function_result = maybe_persist_tool_result(
    content=function_result,
    tool_name=function_name,
    tool_use_id=tool_call.id,
    env=get_active_env(effective_task_id),
) if not _is_multimodal_tool_result(function_result) else function_result
```

`max_result_size_chars` 是**按工具注册**的（`tools/registry.py:88` 的 `ToolEntry` 字段，`registry.py:422` 的 `get_max_result_size` 读取它）。某个工具没单独配，就回落到全局默认 `DEFAULT_RESULT_SIZE_CHARS = 100_000`（`tools/budget_config.py:17`）。本例 README.md 才几 KB，远低于阈值——`maybe_persist_tool_result` 原样放行，`messages` 里就是文件全文。但同一行代码换成读 5 MB 日志，结果就会被换成「预览 + `/tmp/hermes-results/<id>.txt`」，上下文安然无恙。

tool 消息 append 完，控制权回到 `run_conversation` 的对话循环。注意一个时序细节——`api_call_count` 的递增**不在这里**，而在循环顶部：

```python
# agent/conversation_loop.py:544-546
api_call_count += 1
agent._api_call_count = api_call_count
agent._touch_activity(f"starting API call #{api_call_count}")
```

也就是说，第一次进循环 `api_call_count` 从 0 变 1（步骤 10 那次 API 调用）；工具执行、结果回灌之后，循环用 `continue`（`conversation_loop.py:3336`）跳回 `while` 顶部（`conversation_loop.py:532`），`api_call_count` 再从 1 变 2。**一次 API 调用算一次迭代**——`api_call_count` 数的是"问了模型几次"，不是"调了几个工具"。一个回合并行调 5 个工具，`api_call_count` 只 +1。这个定义让 `max_iterations` 这个预算约束的是真正烧钱的东西（LLM 调用），而不是几乎免费的本地工具执行。

`_touch_activity` 则是给"卡死检测"喂的心跳——它记下"现在在干 API call #N"，看门狗据此判断 agent 是真在工作还是挂死了。

到这一步结束，`messages` 长这样，循环正站在 `while` 顶端，准备消费下一次迭代预算：

```text
messages = [
  system,
  user,
  assistant(tool_calls=[read_file]),
  tool(tool_call_id=call_abc123, content=<README.md 内容>),  ← 本步新增
]
api_call_count = 1   （循环回顶后，下一步会 +1 变 2）
```

## 6. 代码位置

按阅读顺序：

- 工具结果落盘检查：`agent/tool_executor.py:845-850` —— `maybe_persist_tool_result`，超阈值则把全文写进沙箱。
- 构造 tool 消息：`agent/tool_executor.py:862-869` —— `role="tool"` + `name` + `content` + `tool_call_id`。
- append 进 messages：`agent/tool_executor.py:869` —— `messages.append(tool_msg)`。
- 并行执行路径的等价代码：`agent/tool_executor.py:447-452` —— `execute_tool_calls_concurrent` 里相同形状的 tool 消息。
- 体量阈值定义：`tools/registry.py:422-430` —— `get_max_result_size`，按工具取 `max_result_size_chars`，回落 `DEFAULT_RESULT_SIZE_CHARS`。
- 全局默认值：`tools/budget_config.py:17` —— `DEFAULT_RESULT_SIZE_CHARS = 100_000`。
- 三级防御说明：`tools/tool_result_storage.py:1-24` —— 文件头注释完整描述工具自截断 / 单结果落盘 / 整回合预算。
- 循环回绕：`agent/conversation_loop.py:3336` —— 工具回合末尾的 `continue`，跳回 `conversation_loop.py:532` 的 `while`。
- 迭代计数：`agent/conversation_loop.py:544-546` —— `api_call_count += 1` 与 `_touch_activity`，发生在循环顶部。

## 7. 分支与延伸

- 这条 tool 消息回灌后循环如何转回去、再发第二次请求 → [Trace 步骤 15](tour-15-second-api-call.md)。
- 上一步工具究竟怎么读出 README.md 内容、审批怎么过的 → [Trace 步骤 13](tour-13-read-file-exec.md)。
- 对话循环的整体骨架——`while` 条件、`continue` / `break` 两类出口、迭代预算 → [第 3 章 核心对话循环](03-conversation-loop.md)。
- 工具结果落盘后模型如何"自己再 read_file 取全文"、沙箱临时目录在不同后端（Docker / SSH / Modal）的路径差异 → [第 3 章 §工具结果持久化](03-conversation-loop.md)。
- 一个回合并行发多个 `tool_call` 时的并发执行与结果归位 → [第 3 章 §并行工具执行](03-conversation-loop.md)。
- `/steer`：用户在工具执行间隙插话，会被 `_apply_pending_steer_to_tool_results`（`tool_executor.py:875`）追加进 tool 消息 → [第 3 章 §运行中转向](03-conversation-loop.md)。

## 8. 走完这一步你脑子里应该多了什么

1. 工具结果不是普通文本，而是协议里的一等公民——一条 `role="tool"` 消息，必须带 `tool_call_id` 和上一条 assistant 的某个 `tool_call` **精确配对**；并行调多个工具就靠多个 `id` 各自归位。
2. 带 `tool_calls` 的 assistant 消息后面**必须**跟齐对应的 tool 结果消息，否则下一次 API 调用直接 400 或触发空响应重试——Hermes 还有 `_repair_message_sequence` 兜底坏掉的序列。
3. 过大的工具结果不靠粗暴切片，而是**三级防御**：工具自截断、单结果落盘（超 `max_result_size_chars` 就写进沙箱、上下文里只留预览+路径）、整回合 200K 预算溢出。阈值按工具注册，默认 100K 字符。
4. `api_call_count` 数的是"问了模型几次"，不是"调了几个工具"——一次 API 调用算一次迭代，并行调 5 个工具也只 +1。它在循环**顶部**递增，`max_iterations` 因此约束的是真正烧钱的 LLM 调用。
5. 工具回合用 `continue` 把循环转回 `while` 顶端——append tool 消息不是终点，模型还没说出给用户的答案，必须回去再问一次。

---

下一步：[Trace 步骤 15 —— 带着工具结果再问一次模型](tour-15-second-api-call.md)
