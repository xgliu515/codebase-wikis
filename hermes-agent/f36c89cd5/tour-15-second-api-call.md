# Trace 步骤 15 —— 带着工具结果再问一次模型

## 1. 当前情境

上一步（[Trace 步骤 14](tour-14-tool-result.md)）把 `read_file` 的结果包成一条 `role="tool"` 消息 append 进了 `messages`，然后用 `continue` 把对话循环转回了 `while` 顶端。

此刻状态：

```text
messages = [
  system,                              # 步骤 06 的系统提示
  user,                                # "读取 README.md 并告诉我第一行"
  assistant(tool_calls=[read_file]),    # 步骤 11 模型要调工具
  tool(tool_call_id=call_abc123, content=<README.md 内容>),  # 步骤 14 回灌的结果
]
api_call_count = 1
```

循环计数器 `api_call_count` 还是 1（步骤 10 那次 API 调用留下的）。控制权站在 `conversation_loop.py:532` 的 `while` 行上，即将开始**第二次穿越循环体**。这一步就是看这第二趟和第一趟有什么不同——以及为什么"把工具结果回灌后再调一次模型"这件事，本身就是 agent 的定义。

## 2. 问题

第一次 API 调用（步骤 10）模型只说了一句"我要调 `read_file`"——那不是给用户的答案，那是一个**动作意图**。现在文件读出来了，结果也进了 `messages`。但 README.md 的内容此刻只有 Hermes 进程知道，模型还没看过。

要让用户拿到"第一行是什么"这个答案，必须再问模型一次——而且这次问，要带上它上次没有的东西。具体要解决：

- **怎么让模型看到工具结果**。模型是无状态的。第一次调用它返回 `tool_call` 之后，它的"记忆"就清零了。它不会"记得"自己点过 `read_file`。要让它据文件内容作答，唯一办法是把整段对话历史（含那条 tool 消息）**重新完整发一遍**。
- **循环顶部的检查不能跳过**。这是第二趟穿越循环体，不是从函数入口直奔 API。中断检查、迭代预算消费——这些循环顶部的关卡，第二趟必须**再走一遍**。
- **重复发送会不会很贵**。`messages` 里 `system` 那一大段提示、`user` 那行问题，第一次和第二次**一模一样**。把它们原封不动再发一遍，input token 翻倍——多轮对话下这是真金白银的浪费。

## 3. 朴素思路

最直觉的优化：既然模型上次已经"见过" system 和 user 了，第二次就别重发了，只发增量——把那条 tool 消息单独丢给模型。

```python
response2 = call_api(messages=[tool_result_only])   # 只发新东西
```

省 token、省带宽，听上去很合理。

或者退一步：全量重发，但反正每次都重发，那循环顶部的中断检查、预算消费"上次刚做过"，第二趟跳过就行——少几个 `if`。

## 4. 为什么朴素思路会崩

"只发增量"是对 LLM 工作方式的根本误解：

- **模型没有跨调用的记忆**。每一次 `/chat/completions` 请求都是**完全独立**的。服务端不存任何会话状态。你这次只发一条 `tool(content=...)`，模型收到的就是一条孤零零的工具结果——它不知道这是哪个工具调出来的、不知道用户原本问了什么、连自己的系统提示都没有。它会困惑，或者瞎编。要模型"接着上文想",**整段上文必须每次重发**。这不是冗余，这是协议。
- **跳过循环顶部检查会留下窟窿**。如果第一次 API 调用期间用户按了 Ctrl+C 或发了新消息，`_interrupt_requested` 会被置位。这个标志只在循环顶部检查（`conversation_loop.py:537`）。第二趟若跳过这个 `if`，用户的中断就被吞了——agent 继续埋头跑，像没听见。同理，迭代预算 `consume()` 若第二趟不调，预算永远扣不动，`max_iterations` 形同虚设。
- **"全量重发很贵"这个担忧是真的**——但解法不是"别发"，而是"发，但让上游缓存命中"。

朴素思路在"省 token"这个正确目标上，选错了手段。

## 5. Hermes 的做法

Hermes 的第二趟循环体，**结构上和第一趟完全相同**——这正是设计的优雅之处。循环体是无差别的：它不区分"这是第几次",每一趟都老老实实地走顶部检查、消费预算、重建 `api_messages`、发请求、解析响应。第一趟和第二趟唯一的不同，是 `messages` 这个**输入**变长了。

循环回绕到 `while` 顶部（`conversation_loop.py:532`）后，依次执行：

**第一关，中断检查**（`conversation_loop.py:537-542`）:

```python
# agent/conversation_loop.py:537-542
if agent._interrupt_requested:
    interrupted = True
    _turn_exit_reason = "interrupted_by_user"
    if not agent.quiet_mode:
        agent._safe_print("\n⚡ Breaking out of tool loop due to interrupt...")
    break
```

如果用户在第一次 API 调用 + 工具执行那段时间里插了话，这里立刻 `break` 出循环。第二趟单独走这关，意味着用户的"算了别查了"能在**每一次 API 调用之前**被听见。

**第二关，迭代计数与预算消费**（`conversation_loop.py:544-557`）:

```python
# agent/conversation_loop.py:544-557
api_call_count += 1                       # 1 → 2
agent._api_call_count = api_call_count
agent._touch_activity(f"starting API call #{api_call_count}")

if agent._budget_grace_call:
    agent._budget_grace_call = False
elif not agent.iteration_budget.consume():
    _turn_exit_reason = "budget_exhausted"
    if not agent.quiet_mode:
        agent._safe_print(f"\n⚠️  Iteration budget exhausted ...")
    break
```

`api_call_count` 从 1 变 2。`iteration_budget.consume()` 扣掉一格预算——若这是第 N 次而预算只够 N-1 次，这里 `break`，循环以 `budget_exhausted` 收尾。预算是"防止 agent 无限调工具烧钱"的硬闸，每一趟都必须过闸。

**第三关，重建 `api_messages`**（`conversation_loop.py:676` 起）。循环把 `messages` 整个拷一遍，注入 ephemeral 上下文、加上系统提示。**关键**：这次 `messages` 比第一趟多了 `assistant(tool_calls)` 和 `tool(content=...)` 两条。模型这次发出去的请求里，README.md 的内容就在其中——它"看得见"了。

那"全量重发很贵"怎么破？靠 **prompt caching**。`conversation_loop.py:755-760` 在请求组装末尾调用：

```python
# agent/conversation_loop.py:755-760
if agent._use_prompt_caching:
    api_messages = apply_anthropic_cache_control(
        api_messages,
        cache_ttl=agent._cache_ttl,
        native_anthropic=agent._use_native_cache_layout,
    )
```

`apply_anthropic_cache_control`（`agent/prompt_caching.py:49`）在消息里打 **4 个 `cache_control` 断点**：系统提示一个 + 最后 3 条非系统消息各一个。第二次 API 调用时，`system` 和 `user` 这段前缀**字节级完全没变**（Hermes 刻意保证系统提示每轮 byte-stable，见 `conversation_loop.py:731-735` 的注释）——上游 Anthropic 缓存据此命中，这段前缀的 input token 成本直降约 75%。"全量重发"的账单，被缓存吃掉了大头。

<svg viewBox="0 0 820 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="first vs second API call with prompt cache hit">
  <defs>
    <marker id="t15ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="210" y="28" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">第一次 API 调用（步骤 10）</text>
  <text x="610" y="28" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">第二次 API 调用（本步）</text>
  <rect x="60" y="44" width="300" height="78" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <rect x="74" y="58" width="272" height="24" rx="3" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
  <text x="86" y="74" font-size="11" fill="#64748b">system　← 缓存写入</text>
  <rect x="74" y="88" width="272" height="24" rx="3" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
  <text x="86" y="104" font-size="11" fill="#64748b">user　← 缓存写入</text>
  <rect x="460" y="44" width="300" height="160" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <rect x="474" y="58" width="272" height="24" rx="3" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="486" y="74" font-size="11" fill="#64748b">system　← 缓存命中 ★</text>
  <rect x="474" y="88" width="272" height="24" rx="3" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="486" y="104" font-size="11" fill="#64748b">user　← 缓存命中 ★</text>
  <rect x="474" y="118" width="272" height="24" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="486" y="134" font-size="11" fill="#64748b">assistant(tool_call)　新内容</text>
  <rect x="474" y="148" width="272" height="24" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="486" y="164" font-size="11" fill="#64748b">tool(README 内容)　新内容</text>
  <line x1="210" y1="122" x2="210" y2="166" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t15ar)"/>
  <text x="210" y="186" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">返回 tool_call</text>
  <line x1="610" y1="204" x2="610" y2="248" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t15ar)"/>
  <rect x="460" y="250" width="300" height="34" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="610" y="272" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">返回纯文本答案（无 tool_call）</text>
  <text x="410" y="328" text-anchor="middle" font-size="11" fill="#64748b">★ 前缀字节不变 → 上游缓存命中 → input token 成本 ~−75%</text>
</svg>
<span class="figure-caption">图 T15.1 ｜ 两次 API 调用对比：system/user 前缀字节不变，第二次缓存命中，input token 成本降约 75%。</span>

<details>
<summary>ASCII 原版</summary>

```text
第一次 API 调用 (步骤 10)            第二次 API 调用 (本步)
┌─────────────────────┐            ┌─────────────────────┐
│ system   ← 缓存写入  │            │ system   ← 缓存命中 ★│
│ user     ← 缓存写入  │            │ user     ← 缓存命中 ★│
└─────────────────────┘            │ assistant(tool_call) │  新内容
        │                          │ tool(README 内容)    │  新内容
        ▼                          └─────────────────────┘
   返回 tool_call                          │
                                           ▼
                                  返回纯文本答案（无 tool_call）

★ 前缀字节不变 → 上游缓存命中 → input token 成本 ~−75%
```

</details>

发请求的代码和第一趟是同一段——`conversation_loop.py:1007-1012` 的 `_interruptible_streaming_api_call` / `_interruptible_api_call`，外面套着同一个重试循环（`conversation_loop.py:870` 的 `while retry_count < max_retries`）。第二次返回的 `response`，本例里是**纯文本**——模型读了 README.md，直接给出"第一行是什么"的回答，**不再有 `tool_call`**。

这就是 agent 循环的本质，可以浓缩成一句话：**模型决定一个动作 → Hermes 执行它 → 把结果回灌 → 再问模型**。第一趟模型"想",产出动作；工具"做",产出结果；第二趟模型"再想",这次产出答案。如果第二趟模型又返回一个 `tool_call`（比如它想再读一个文件），循环就再转一圈——这个"想-做-想-做"的链条想转多少圈转多少圈，直到模型不再要求动作，或者撞上预算闸。"自主性"不是什么神秘特性，它就是这个循环。

到这一步结束：第二次 API 调用已返回 `response`（本例为纯文本，无 `tool_call`），`api_call_count = 2`，控制权落在循环体里的响应解析段，准备判定"这是不是最终答案"。

## 6. 代码位置

按阅读顺序：

- 循环回绕点：`agent/conversation_loop.py:532` —— `while (api_call_count < max_iterations and ...)`，第二趟从这里重新进入。
- 中断检查：`agent/conversation_loop.py:537-542` —— `if agent._interrupt_requested` 则 `break`，每趟都查。
- 迭代计数：`agent/conversation_loop.py:544-546` —— `api_call_count += 1`（1 → 2）+ `_touch_activity`。
- 预算消费：`agent/conversation_loop.py:551-557` —— `iteration_budget.consume()`，扣不动就以 `budget_exhausted` 收尾。
- 重建 api_messages：`agent/conversation_loop.py:676` 起 —— 把变长后的 `messages` 整理成 API 请求。
- 系统提示 byte-stable 不变量：`agent/conversation_loop.py:731-735` —— 注释说明系统提示每轮逐字重放以保缓存命中。
- prompt caching 注入：`agent/conversation_loop.py:755-760` —— 调 `apply_anthropic_cache_control`。
- 缓存断点算法：`agent/prompt_caching.py:49-79` —— `system_and_3` 策略，系统提示 + 最后 3 条消息共 4 个断点。
- 第二次 API 调用本体：`agent/conversation_loop.py:1007-1012` —— `_interruptible_streaming_api_call` / `_interruptible_api_call`，与第一趟同一段代码。

## 7. 分支与延伸

- 第二次返回纯文本后，循环如何判定"这是最终答案"并退出 → [Trace 步骤 16](tour-16-final-response.md)。
- 上一步工具结果是怎么包成 tool 消息回灌的 → [Trace 步骤 14](tour-14-tool-result.md)。
- 对话循环的 `while` 条件、`continue` / `break` 出口、迭代预算的完整设计 → [第 3 章 核心对话循环](03-conversation-loop.md)。
- prompt caching 在哪些 provider 上生效、`5m` vs `1h` TTL 怎么选、本地推理服务器（llama.cpp / vLLM）的 KV 缓存复用 → [第 7 章 模型与 Provider 抽象](07-model-providers.md)。
- 如果第二趟模型又返回 `tool_call`（多轮工具调用），循环会再转一圈——这正是步骤 14 → 15 的重复 → [第 3 章 §多轮工具循环](03-conversation-loop.md)。
- 第二次调用若撞上 provider 限流 / 网络错误，重试循环（`conversation_loop.py:870`）如何处理、何时切 fallback provider → [第 7 章 §重试与 fallback](07-model-providers.md)。

## 8. 走完这一步你脑子里应该多了什么

1. LLM 没有跨调用记忆——每次 `/chat/completions` 请求都是完全独立的，服务端不存会话状态。要模型"接着上文想",**整段 `messages` 必须每次重发**，这是协议而非冗余。
2. 对话循环的循环体是**无差别**的：第一趟、第二趟走的是同一段代码，唯一不同是 `messages` 这个输入变长了。每趟都重走中断检查、迭代计数、预算消费——顶部的关卡一个都不能跳。
3. "全量重发很贵"的解法不是"别发",而是 **prompt caching**：在系统提示 + 最后 3 条消息打 4 个 `cache_control` 断点，前缀字节不变就让上游缓存命中，input token 成本降约 75%。前提是系统提示每轮 byte-stable。
4. agent 的本质就是一句话的循环——**模型想出动作 → Hermes 执行 → 结果回灌 → 再问模型**。第一趟产出动作、第二趟产出答案；要转多少圈转多少圈，直到模型不再要求动作或撞上预算闸。
5. 本例第二次 API 调用返回的是**纯文本、无 `tool_call`**——模型读完 README.md 直接作答。这个"没有 tool_call"的信号，就是下一步循环退出的触发条件。

---

下一步：[Trace 步骤 16 —— 没有 tool_call，循环怎么结束？](tour-16-final-response.md)
