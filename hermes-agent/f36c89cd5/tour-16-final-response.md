# Trace 步骤 16 —— 没有 tool_call，循环怎么结束？

## 1. 当前情境

上一步（[Trace 步骤 15](tour-15-second-api-call.md)）第二次 API 调用返回了 `response`。Hermes 把它解析成 `assistant_message`。本例里这个响应是**纯文本**——模型读完了回灌的 README.md 内容，直接给出了"第一行是什么"的回答，`assistant_message.tool_calls` 是空的。

此刻状态：

```text
messages = [
  system,
  user,
  assistant(tool_calls=[read_file]),
  tool(tool_call_id=call_abc123, content=<README.md 内容>),
]
api_call_count = 2
assistant_message.content = "README.md 的第一行是一个居中的 <p> 标签……"
assistant_message.tool_calls = []   ← 空！
```

控制权在 `conversation_loop.py:3025` 那个 `if assistant_message.tool_calls:` 判断上。前面几次穿越循环体，这个 `if` 都为真——模型每次都要求调工具，循环每次都 `continue` 转回去。这一次它为**假**。这一步就是看：循环怎么靠"没有 tool_call"这个信号收尾，`final_response` 怎么提取出来，`run_conversation` 最后返回什么。

## 2. 问题

对话循环是个 `while`，它必须有出口。否则模型每答一句就转一圈，永不停歇。问题是：

- **循环怎么知道"该停了"**。步骤 14、15 里循环每趟末尾都 `continue` 回顶——因为模型每次都要求调工具，活儿没干完。现在模型给出了纯文本答案。循环必须从这个事实里读出"任务完成,可以退出了"。
- **答案怎么从循环里捞出来交给上层**。`assistant_message.content` 是给用户的最终答案，但它现在只是循环体里的一个局部变量。`run_conversation` 这个函数得把它**变成返回值**，CLI 才拿得到。
- **退出不止一种**。"模型不再要求工具"是最理想的出口——任务自然完成。但循环还可能因为别的原因停：迭代预算耗尽、撞 `max_iterations`、用户中断、连续报错……这些"非自然"的出口产出的不是真正的答案,上层得能区分。

## 3. 朴素思路

最直觉的写法：循环跑固定圈数，或者干脆每次 API 调用后就无条件返回。

```python
for _ in range(max_iterations):
    response = call_api(messages)
    # ...执行工具...
return response.content   # 直接把最后一次的内容返回
```

或者更"省事":循环体最后无脑 `return assistant_message.content`——反正模型迟早会给出文本答案。

## 4. 为什么朴素思路会崩

"无条件返回最后一次内容"会在第一次工具调用就崩：

- **它会把"动作意图"当成答案返回**。步骤 10 里模型的第一次响应是 `tool_call`——它的 `content` 往往是空的，或者只有一句"我来读一下文件"。如果循环体末尾无脑 `return assistant_message.content`，用户拿到的就是这句中间过程话术，文件根本没读、问题根本没答。循环在第一圈就错误退出了。
- **"跑固定圈数"浪费且危险**。本例任务一次工具调用就完成了，跑满 `max_iterations` 圈纯属浪费 API 调用和钱。反过来，复杂任务可能需要的圈数超过固定值，到点强行退出，任务半途而废。
- **它分不清出口类型**。预算耗尽退出、撞 `max_iterations` 退出、模型自然给出答案退出——朴素 `return` 把它们全混成一个返回值。上层 CLI 没法知道"这是真答案还是被掐断的残局",自然也没法对用户说实话。

核心矛盾是：**"模型还想调工具" vs "模型给出了纯文本"** 是两种语义截然不同的响应,循环必须按这个区别决定 `continue` 还是 `break`——而不是按圈数或按"最后一次"。

## 5. Hermes 的做法

Hermes 把"有没有 `tool_call`"作为循环的**分岔点**。响应解析完，代码到达 `conversation_loop.py:3025` 的 `if assistant_message.tool_calls:`：

<svg viewBox="0 0 780 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="conversation loop branch on presence of tool_calls">
  <defs>
    <marker id="t16ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="270" y="20" width="240" height="36" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="390" y="43" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">response 解析出 assistant_message</text>
  <line x1="390" y1="56" x2="390" y2="78" stroke="#94a3b8" stroke-width="1.2"/>
  <path d="M260,100 L390,78 L520,100" fill="none" stroke="#94a3b8" stroke-width="1.2"/>
  <rect x="300" y="78" width="180" height="26" rx="13" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="390" y="95" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">有 tool_calls ?</text>
  <line x1="200" y1="100" x2="200" y2="128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t16ar)"/>
  <text x="214" y="118" font-size="11" font-weight="600" fill="#7c3aed">是</text>
  <line x1="580" y1="100" x2="580" y2="128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t16ar)"/>
  <text x="594" y="118" font-size="11" font-weight="600" fill="#0d9488">否</text>
  <rect x="50" y="130" width="300" height="150" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="200" y="154" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">append assistant + 执行工具</text>
  <text x="200" y="178" text-anchor="middle" font-size="11" fill="#64748b">append tool 结果</text>
  <text x="200" y="200" text-anchor="middle" font-size="11" fill="#64748b">continue → 回 while 顶</text>
  <text x="200" y="262" text-anchor="middle" font-size="10" fill="#94a3b8">（步骤 14 走的路）</text>
  <rect x="430" y="130" width="300" height="150" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="580" y="154" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">这就是最终答案</text>
  <text x="580" y="178" text-anchor="middle" font-size="11" fill="#64748b">final_response = content</text>
  <text x="580" y="200" text-anchor="middle" font-size="11" fill="#64748b">append final_msg</text>
  <text x="580" y="222" text-anchor="middle" font-size="11" fill="#64748b">break → 退出循环</text>
  <text x="580" y="262" text-anchor="middle" font-size="10" fill="#94a3b8">（本步走的路）</text>
</svg>
<span class="figure-caption">图 T16.1 ｜ 对话循环的分岔点：有 tool_calls 则执行工具并 continue 回顶，无则把 content 当最终答案 break 退出。</span>

<details>
<summary>ASCII 原版</summary>

```text
            response 解析出 assistant_message
                        │
          ┌─────────────┴─────────────┐
          │                           │
  有 tool_calls?  是                  否
          │                           │
          ▼                           ▼
  append assistant + 执行工具    这就是最终答案
  append tool 结果                final_response = content
  continue → 回 while 顶          append final_msg
  （步骤 14 走的路）              break → 退出循环
                                 （本步走的路）
```

</details>

`tool_calls` 非空的分支（`conversation_loop.py:3025-3336`）就是步骤 12-14 走过的路：append assistant 消息、执行工具、append tool 结果、`continue` 回顶。

`tool_calls` 为空时走 `else` 分支（`conversation_loop.py:3338` 起）。一句注释把意图说得很直白：

```python
# agent/conversation_loop.py:3338-3340
else:
    # No tool calls - this is the final response
    final_response = assistant_message.content or ""
```

中间一段处理空响应、`<think>` 块、截断恢复等边角情况——本例的纯文本响应不触发它们。一路向下到 `conversation_loop.py:3644-3668`，最终答案被定型并退出循环：

```python
# agent/conversation_loop.py:3644-3668
final_response = agent._strip_think_blocks(final_response).strip()

final_msg = agent._build_assistant_message(assistant_message, finish_reason)
# ...弹掉 thinking-prefill / 空响应恢复脚手架...
messages.append(final_msg)

_turn_exit_reason = f"text_response(finish_reason={finish_reason})"
if not agent.quiet_mode:
    agent._safe_print(f"🎉 Conversation completed after {api_call_count} ... API call(s)")
break
```

三个动作要看清：

1. `_strip_think_blocks` —— 把 `<think>...</think>` 推理块从答案里剥掉。模型的思考过程不该出现在给用户的文字里。
2. `messages.append(final_msg)` —— 把这条最终 assistant 消息追加进 `messages`，对话历史完整。
3. `_turn_exit_reason = "text_response(...)"` 然后 `break` —— 标记"这一轮因为模型给出文本答案而正常结束",然后**跳出 `while`**。这个 `break` 是本例对话循环的真正出口。`_turn_exit_reason` 是诊断字段，`agent.log` 会记下每一轮到底为什么结束。

`break` 之后,代码落到 `while` 循环**之后**。这里有一道关键判断（`conversation_loop.py:3721-3724`）——专门处理**另一类出口**:

```python
# agent/conversation_loop.py:3721-3724
if final_response is None and (
    api_call_count >= agent.max_iterations
    or agent.iteration_budget.remaining <= 0
):
    # 预算耗尽 —— 剥掉工具，再调一次模型让它做总结
    final_response = agent._handle_max_iterations(messages, api_call_count)
```

这就是循环的**第二种出口**：撞 `max_iterations` 或预算耗尽。这种情况下模型从没"自然给出答案",`final_response` 还是 `None`。Hermes 不直接返回空，而是剥掉所有工具、再调一次模型，让它根据已有进展做个总结——给用户一个交代，而不是一个空白。`completed` 字段据此判定（`conversation_loop.py:3775`）：

```python
# agent/conversation_loop.py:3775
completed = final_response is not None and api_call_count < agent.max_iterations
```

注意它把两类出口区分得清清楚楚：本例 `final_response` 非空且 `api_call_count`(2) < `max_iterations` → `completed = True`，真正完成。撞顶退出的 → `completed = False`，残局。

最后，`run_conversation` 把所有东西打包成一个 dict 返回（`conversation_loop.py:3918-3934`）：

```python
# agent/conversation_loop.py:3918-3934
result = {
    "final_response": final_response,    # 给用户的答案字符串
    "last_reasoning": last_reasoning,
    "messages": messages,                # 完整对话历史（含 4 条消息）
    "api_calls": api_call_count,          # 2
    "completed": completed,               # True
    "turn_exit_reason": _turn_exit_reason,# "text_response(finish_reason=stop)"
    "partial": False,
    "interrupted": interrupted,
    ...
}
```

`messages` 一并返回——CLI 拿它做会话持久化（步骤 18）。`final_response` 则是 CLI 渲染给用户看的那段文字。`completed` / `turn_exit_reason` / `partial` / `interrupted` 让上层能精确知道这一轮是善终还是被掐断,据此决定要不要给用户提示。

`run_conversation` 由 `chat()` 调用（`run_agent.py:3838` 附近），`chat()` 从这个 dict 里取出 `final_response` 字段往上返回（`run_agent.py:3851` 附近）。一句答案就这样从循环体内的局部变量，一路冒泡成 CLI 手里的字符串。

到这一步结束：对话循环已退出，`final_response` 字符串就位（本例是 README.md 第一行的回答），`messages` 末尾是那条 `assistant(text)`，`run_conversation` 已返回完整 dict。剩下的只是把这段文字渲染到终端。

## 6. 代码位置

按阅读顺序：

- 分岔点：`agent/conversation_loop.py:3025` —— `if assistant_message.tool_calls:`，有工具 `continue`、无工具走 `else`。
- 工具分支末尾：`agent/conversation_loop.py:3336` —— `continue`，回 `while` 顶（步骤 14 走的路）。
- 无工具分支入口：`agent/conversation_loop.py:3338-3340` —— `else:` + `final_response = assistant_message.content`。
- 最终答案定型：`agent/conversation_loop.py:3644-3668` —— `_strip_think_blocks` 剥推理、`append(final_msg)`、设 `_turn_exit_reason`、`break`。
- 撞顶出口：`agent/conversation_loop.py:3721-3738` —— `final_response is None` 且预算耗尽时，`_handle_max_iterations` 剥工具再问一次做总结。
- 完成判定：`agent/conversation_loop.py:3775` —— `completed = final_response is not None and api_call_count < max_iterations`。
- 返回 dict：`agent/conversation_loop.py:3918-3934` —— `result` 字典，含 `final_response` / `messages` / `api_calls` / `completed` / `turn_exit_reason`。
- 调用方取值：`run_agent.py:3838` 附近 —— `chat()` 调 `run_conversation`；`run_agent.py:3851` 附近 —— `chat()` 取出 `final_response` 往上返回。

## 7. 分支与延伸

- `final_response` 就位后，CLI 层如何把它渲染成终端里的 response box → [Trace 步骤 17](tour-17-streaming-render.md)。
- 上一步第二次 API 调用如何带着工具结果产出这个纯文本响应 → [Trace 步骤 15](tour-15-second-api-call.md)。
- 对话循环的 `while` 条件、两类出口（无 tool_call 自然结束 vs 撞顶 / 预算耗尽）、`continue` / `break` 的完整设计 → [第 3 章 核心对话循环](03-conversation-loop.md)。
- `_handle_max_iterations` 撞顶后剥工具做总结的细节、`turn_exit_reason` 的全部取值 → [第 3 章 §循环退出与诊断](03-conversation-loop.md)。
- 空响应、`<think>` 块未闭合、`finish_reason=length` 截断恢复——本例没触发的边角分支 → [第 3 章 §异常响应恢复](03-conversation-loop.md)。
- `run_conversation` 返回的 dict 里 `messages` 字段如何被 CLI 拿去做会话持久化 → [Trace 步骤 18](tour-18-session-persist.md)。

## 8. 走完这一步你脑子里应该多了什么

1. 对话循环的分岔点是**"响应里有没有 `tool_call`"**：有就 `append` 工具结果并 `continue` 回顶，没有就把 `content` 当最终答案 `break` 退出。循环不靠圈数停，靠语义停。
2. 绝不能"无脑返回最后一次响应的 content"——`tool_call` 响应的 `content` 往往是空或中间话术,把它当答案会让循环在第一次工具调用就错误退出。
3. 循环有**两类出口**：模型给出纯文本答案的自然结束（`final_response` 非空、`completed=True`），与撞 `max_iterations` / 预算耗尽的非自然出口（`final_response` 一度为 `None`，Hermes 剥工具再问一次做总结，`completed=False`）。
4. 最终答案出循环前要 `_strip_think_blocks` 剥掉 `<think>` 推理块,并 append 进 `messages` 保持历史完整;`_turn_exit_reason` 记下退出原因供 `agent.log` 诊断。
5. `run_conversation` 返回的是一个 **dict**——`final_response` 是给用户的字符串，`messages` 给持久化用，`completed` / `partial` / `interrupted` 让上层能区分善终与残局。`chat()` 从中取出 `final_response` 往上冒泡。

---

下一步：[Trace 步骤 17 —— 答案怎样流式渲染到终端？](tour-17-streaming-render.md)
