# Trace 步骤 09 —— 发请求前，那份给模型看的消息列表是怎么攒出来的？

## 1. 当前情境

上一步结束时，控制权已经沉进 `run_conversation`，初始化做完，`api_call_count = 0`，内部的 `messages` 列表里有 `[system, user]` 两条——`system` 是步骤 06 缓存的系统提示，`user` 是这一轮用户那句 `读取 README.md 并告诉我它的第一行是什么`。

但 `messages` 是 Hermes **内部**的对话状态，它和真正要发给 LLM provider 的请求体并不是同一个东西。这一步要回答的问题是：在循环跑第一圈、真正发出第一次 API 调用之前，还要做哪些准备——为什么要在转折之前"回忆"一遍长期记忆，以及内部 `messages` 是怎么被加工成 provider 能吃的 `api_messages` 的。

## 2. 问题

"把 `messages` 发出去"这件事，中间隔着好几道工序：

- **内部表示 ≠ 线上格式**。内部 `messages` 里带着一堆 Hermes 自用的字段：`reasoning`（给 trajectory 存档用的思维痕迹）、`finish_reason`、`_thinking_prefill` 标记、Codex Responses API 的 `call_id` 字段……。严格的 provider（Mistral、Fireworks）见到不认识的字段会直接报错。这些字段必须在发出前剥掉。
- **历史可能是坏的**。续接会话的历史里，可能有损坏的 `tool_call` 参数（JSON 截断），可能有 `tool → user`、`user → user` 这种破坏角色交替的序列。多数 provider 碰到非法序列会返回空内容，把 agent 卡进"空响应重试"死循环。发出前必须修。
- **记忆要在对的时机注入**。Hermes 有长期记忆（外部记忆 provider）。模型回答"读 README"之前，也许该先回忆一下"这个用户偏好简短回答""这个项目的 README 之前聊过"。这份回忆该在**这一轮的转折点之前**就备好。
- **记忆注入不能碰系统提示**。系统提示是缓存前缀，动一个字节缓存全废（步骤 06）。所以 prefetch 来的记忆**不能**塞进系统提示。

## 3. 朴素思路

最直觉的写法：直接把内部 `messages` 发出去，记忆呢——干脆每次工具调用前都查一遍最新的：

```python
while ...:
    memory = memory_provider.prefetch(user_message)   # 每圈都查
    api_resp = call_llm(messages, system=system_prompt + memory)
```

把记忆拼进系统提示，循环每圈都刷新一次记忆——保证最新，简单直接。

## 4. 为什么朴素思路会崩

这个写法每一处都踩雷：

- **裸发 `messages` 会被 provider 拒**。内部字段（`reasoning`、`_thinking_prefill`、`call_id`）严格 provider 不认，直接 400。损坏的 `tool_call` 参数和破坏角色交替的序列会让 provider 返回空内容，触发无限重试。
- **每圈 prefetch = N 倍延迟和成本**。一次对话轮可能有 10 次工具调用 = 10 圈循环。每圈都 `prefetch()` 一次外部记忆 provider，就是 10 次额外的网络往返 + 10 次检索成本。而记忆对这一轮来说是**稳定**的——查一次就够。
- **记忆拼进系统提示 = 缓存全废**。记忆每圈都变，系统提示就每圈都变，prompt caching 的前缀彻底漂掉，步骤 06 攒下的省钱全吐回去。
- **用错查询文本**。如果拿带了 nudge / skill 注入内容的 `user_message` 去查记忆，检索查询会被噪声污染，召回质量下降。该用的是**干净的原始用户输入**。

朴素思路把"什么时候查记忆""查到的记忆放哪""发出去的消息长什么样"三件事全做错了。

## 5. Hermes 的做法

Hermes 的解法是：**记忆每轮 prefetch 一次并缓存、记忆注入进 user 消息而非系统提示、`messages` 经修复后逐条加工成 `api_messages`**。

**记忆 nudge 判定**（`conversation_loop.py:286-292`）——这是"要不要提醒模型整理记忆"的周期性触发，发生在循环之前：

```python
_should_review_memory = False
if (agent._memory_nudge_interval > 0
        and "memory" in agent.valid_tool_names
        and agent._memory_store):
    agent._turns_since_memory += 1
    if agent._turns_since_memory >= agent._memory_nudge_interval:
        _should_review_memory = True
        agent._turns_since_memory = 0
```

这是基于"轮数"的判定——每 N 轮提醒一次模型 review 记忆。它只是设个标志 `_should_review_memory`，真正的记忆 review 在本轮回复交付之后才在后台跑（`conversation_loop.py:3979` 附近）。

**记忆 prefetch——每轮一次，缓存复用**（`conversation_loop.py:505-516`）：

```python
# External memory provider: prefetch once before the tool loop.
# Reuse the cached result on every iteration to avoid re-calling
# prefetch_all() on each tool call (10 tool calls = 10x latency + cost).
_ext_prefetch_cache = ""
if agent._memory_manager:
    try:
        _query = original_user_message if isinstance(original_user_message, str) else ""
        _ext_prefetch_cache = agent._memory_manager.prefetch_all(_query) or ""
    except Exception:
        pass
```

这正是第 4 段"每圈 prefetch = N 倍成本"的修法：`prefetch_all()` 在进 while 循环**之前**调一次，结果存进 `_ext_prefetch_cache`，循环里每一圈复用同一份。查询文本用的是 `original_user_message`——**干净的原始输入**，不带 nudge / skill 注入的噪声。

`prefetch_all()`（`agent/memory_manager.py:285`）遍历所有已注册的记忆 provider，逐个调 `prefetch()`，把非空结果按 provider 标签拼起来；某个 provider 失败不影响其它：

```python
def prefetch_all(self, query, *, session_id=""):
    parts = []
    for provider in self._providers:
        try:
            result = provider.prefetch(query, session_id=session_id)
            if result and result.strip():
                parts.append(result)
        except Exception as e:
            logger.debug("Memory provider '%s' prefetch failed (non-fatal): %s",
                         provider.name, e)
    return "\n\n".join(parts)
```

**为什么转折前要 prefetch**：模型马上要决定"我该调什么工具、怎么回答"——这是这一轮的认知转折点。长期记忆（用户偏好、项目背景、过往结论）正是这个决策最该参考的上下文。在转折点之前一次性备好，模型从第一次 API 调用就能用上；备晚了，模型已经决定完了。

**消息修复 / sanitize**（`conversation_loop.py:649-674`）——发请求前给 `messages` 做体检：

```python
repaired_tool_calls = agent._sanitize_tool_call_arguments(
    messages, logger=request_logger, session_id=agent.session_id)
if repaired_tool_calls > 0:
    request_logger.info("Sanitized %s corrupted tool_call arguments ...", ...)

repaired_seq = agent._repair_message_sequence(messages)
if repaired_seq > 0:
    request_logger.info("Repaired %s message-alternation violations ...", ...)
```

`_sanitize_tool_call_arguments` 修损坏的 `tool_call` 参数（JSON 截断等），`_repair_message_sequence` 修被弄坏的角色交替序列（`tool → user`、`user → user` 这种）。相关的 surrogate 字符清洗、各种消息净化逻辑集中在 `agent/message_sanitization.py`。这就是第 4 段"历史可能是坏的"的修法。

**从 `messages` 加工出 `api_messages`**（`conversation_loop.py:676` 起）——逐条 `copy()` 后加工：

<svg viewBox="0 0 820 470" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Pipeline transforming internal messages into provider-ready api_messages">
  <defs>
    <marker id="ar9a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="240" y="20" width="340" height="44" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="410" y="40" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">内部 messages（[system, user]）</text>
  <text x="410" y="55" text-anchor="middle" font-size="10" fill="#64748b">Hermes 内部对话状态</text>
  <line x1="410" y1="64" x2="410" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9a)"/>
  <text x="425" y="80" font-size="10" fill="#64748b">逐条 msg.copy() → api_msg</text>
  <rect x="60" y="90" width="700" height="146" rx="8" fill="#fffbeb" stroke="#cbd5e1" stroke-width="1"/>
  <text x="76" y="110" font-size="11" font-weight="600" fill="#64748b">逐条加工</text>
  <rect x="76" y="118" width="668" height="26" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
  <text x="90" y="135" font-size="11" fill="currentColor">本轮 user 消息：_ext_prefetch_cache 经 build_memory_context_block() 围栏后追加进 content（不碰系统提示）</text>
  <rect x="76" y="148" width="668" height="26" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="90" y="165" font-size="11" fill="currentColor">拷贝 reasoning → reasoning_content（多轮推理上下文）</text>
  <rect x="76" y="178" width="668" height="26" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="90" y="195" font-size="11" fill="currentColor">剥掉 reasoning / finish_reason / _thinking_prefill</text>
  <rect x="76" y="208" width="668" height="26" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
  <text x="90" y="225" font-size="11" fill="currentColor">严格 provider：剥掉 Codex Responses 的 call_id 等字段</text>
  <line x1="410" y1="236" x2="410" y2="258" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9a)"/>
  <rect x="200" y="262" width="420" height="86" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="410" y="284" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">api_messages（加工后的副本）</text>
  <text x="410" y="304" text-anchor="middle" font-size="10" fill="#64748b">最前面插入 {"role":"system", content: 系统提示}</text>
  <text x="410" y="320" text-anchor="middle" font-size="10" fill="#64748b">插入 prefill few-shot 消息（若有）</text>
  <text x="410" y="336" text-anchor="middle" font-size="10" fill="#64748b">Claude 模型：apply_anthropic_cache_control 打缓存断点</text>
  <line x1="410" y1="348" x2="410" y2="370" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar9a)"/>
  <rect x="270" y="374" width="280" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="400" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">发给 provider 的最终请求体</text>
</svg>
<span class="figure-caption">图 T9.1 ｜ 内部 messages 经逐条 copy 加工成 api_messages：记忆注入 user 副本、剥内部字段、插系统提示与缓存断点。</span>

<details>
<summary>ASCII 原版</summary>

```text
  内部 messages（[system, user]）
        │  逐条 msg.copy() → api_msg
        │
        ├─ 若是本轮 user 消息 ──► 把 _ext_prefetch_cache 用
        │   build_memory_context_block() 围栏后追加进 content
        │   （记忆注入 user 消息，不碰系统提示！）
        ├─ 拷贝 reasoning → reasoning_content（多轮推理上下文）
        ├─ 剥掉 reasoning / finish_reason / _thinking_prefill
        ├─ 严格 provider：剥掉 Codex Responses 的 call_id 等字段
        ▼
  api_messages（加工后的副本）
        │  最前面插入 {"role":"system", "content": 系统提示}
        │  插入 prefill few-shot 消息（若有）
        │  Claude 模型：apply_anthropic_cache_control 打缓存断点
        ▼
  发给 provider 的最终请求体
```

</details>

关键的记忆注入片段（`conversation_loop.py:680-695`）——记忆**注入进本轮 user 消息**，不碰系统提示：

```python
if idx == current_turn_user_idx and msg.get("role") == "user":
    _injections = []
    if _ext_prefetch_cache:
        _fenced = build_memory_context_block(_ext_prefetch_cache)
        if _fenced:
            _injections.append(_fenced)
    ...
    if _injections:
        _base = api_msg.get("content", "")
        if isinstance(_base, str):
            api_msg["content"] = _base + "\n\n" + "\n\n".join(_injections)
```

注意它改的是 `api_msg`（副本），内部 `messages` 里的原始 user 消息**不动**——所以记忆注入既不会污染会话持久化，也不会破坏系统提示的缓存前缀。这正是第 4 段"记忆不能碰系统提示"的修法。系统提示作为单一 content 字符串在 `conversation_loop.py:734` 附近被插到 `api_messages` 最前面，字节稳定。

我们这条 trace 此刻的状态：`_ext_prefetch_cache` 已备好（可能为空，取决于是否配了外部记忆 provider），`messages` 经过修复体检，`api_messages` 组装完成——`[system, user(可能带记忆围栏)]`，Claude 模型还打上了缓存断点。

到这一步结束，`api_messages` 是一个能直接发给 provider 的请求体，第一次 LLM API 调用一触即发。

## 6. 代码位置

按阅读顺序：

- 记忆 nudge 判定：`agent/conversation_loop.py:286-292` —— 基于轮数设 `_should_review_memory` 标志。
- 记忆 prefetch（每轮一次、缓存复用）：`agent/conversation_loop.py:505-516` —— `_ext_prefetch_cache`。
- prefetch 实现：`agent/memory_manager.py:285` —— `prefetch_all()`，遍历所有 provider。
- `tool_call` 参数修复：`agent/conversation_loop.py:649` —— `_sanitize_tool_call_arguments()`。
- 角色交替序列修复：`agent/conversation_loop.py:668` —— `_repair_message_sequence()`。
- 消息净化逻辑集中地：`agent/message_sanitization.py`。
- `messages → api_messages` 逐条加工：`agent/conversation_loop.py:676` 起。
- 记忆注入进本轮 user 消息：`agent/conversation_loop.py:680-695`。
- 系统提示插到 `api_messages` 最前：`agent/conversation_loop.py:734` 附近。
- Claude 缓存断点：`agent/conversation_loop.py:752` 附近 —— `apply_anthropic_cache_control()`。

## 7. 分支与延伸

- 记忆系统全貌——provider 抽象、prefetch / recall / sync、记忆 nudge 与后台 review → [第 10 章 记忆系统](10-memory-system.md)。
- 对话循环每轮的完整工序、`api_messages` 加工的全部细节、prefill few-shot 注入 → [第 3 章 核心对话循环](03-conversation-loop.md)。
- 控制权沉进 `run_conversation` 并初始化的过程在上一步 → [Trace 步骤 08 —— 进入 run_conversation](tour-08-enter-run-conversation.md)。
- `api_messages` 组装完成后，下一步就是真正发出第一次 API 调用 → [Trace 步骤 10 —— 第一次 LLM API 调用](tour-10-first-api-call.md)。
- `_should_review_memory` 标志触发的后台记忆 review 发生在本轮回复交付之后 → [第 10 章 §记忆 review](10-memory-system.md)。

## 8. 走完这一步你脑子里应该多了什么

1. 内部 `messages` 不等于线上请求体——它带着 `reasoning`、`finish_reason`、`_thinking_prefill`、Codex `call_id` 等 Hermes 自用字段，发出前要逐条 `copy()` 成 `api_messages` 并剥掉严格 provider 不认的字段。
2. 记忆 prefetch 在进 while 循环**之前**只跑一次（`conversation_loop.py:505`），结果缓存进 `_ext_prefetch_cache`，循环每圈复用——10 次工具调用不会变成 10 次记忆检索；查询文本用干净的 `original_user_message`，避免噪声污染召回。
3. prefetch 来的记忆**注入进本轮 user 消息的副本**（`api_msg`），不碰系统提示也不碰内部 `messages`——既不破坏 prompt caching 的前缀，也不污染会话持久化。
4. 发请求前 `messages` 要先过体检：`_sanitize_tool_call_arguments` 修损坏的 `tool_call` 参数，`_repair_message_sequence` 修被弄坏的角色交替序列，否则 provider 会返回空内容把 agent 卡进重试死循环。
5. "转折前 prefetch 记忆"是个时机设计：模型马上要在第一次 API 调用里决定调什么工具、怎么回答，长期记忆必须在那个决策点之前就备好——备晚了模型已经决定完了。
