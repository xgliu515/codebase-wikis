# Trace 步骤 11 —— 模型回了一个 tool_call，怎么解析？

## 1. 当前情境

上一步（[步骤 10](tour-10-first-api-call.md)）结束时，第一次 LLM API 调用已经返回。对话循环手里握着一个 `response` 对象，并且已经通过了形状校验（`conversation_loop.py:1099-1110` 确认它有非空的 `choices`）。

`response` 里装的不是给用户看的文字。模型读到"读取 README.md 并告诉我它的第一行是什么"之后，判断自己需要先看文件内容才能回答——于是它返回的不是 `content`，而是一个**工具调用**。`response.choices[0].finish_reason` 是 `"tool_calls"`，`response.choices[0].message.tool_calls` 是一个非空列表。

此刻 `messages` 还停在 `[system, user]`。这一步要把 `response` 里的工具调用意图，翻译成对话循环能驱动的数据结构。

## 2. 问题

模型的"我想调工具"这个意图，必须被转成两样东西并正确落位：

- 一个**结构化的待执行清单**——工具名、参数，供下一步的调度器（[步骤 12](tour-12-tool-dispatch.md)）消费；
- 一条**追加进 `messages` 的 assistant 消息**——它必须忠实记录"模型在这一回合发起了哪些工具调用"，否则对话历史就断了。

这里有两个不显眼但致命的约束：

- **assistant 消息必须先于工具结果入列**。OpenAI / Anthropic 的协议都要求：一条带 `tool_calls` 的 assistant 消息，后面才能跟对应的 `tool` 角色消息。顺序反了、或者 assistant 消息缺失，下一次 API 调用就会 400。
- **reasoning 不能丢**。如果模型在调工具前还产出了一段思考（reasoning / `<think>` 块），这段思考必须随 assistant 消息一起保存——否则多轮对话里推理上下文断裂，思考型模型（DeepSeek、Kimi 的 thinking 模式）甚至会因为缺 `reasoning_content` 而拒绝重放历史。

## 3. 朴素思路

直觉做法：从 `response` 里把 `tool_calls` 抠出来，立刻开始执行第一个工具，执行完把结果塞回 `messages`，继续。assistant 消息？等工具都跑完了，把工具调用和结果一起补一条进去就行。

或者更省事：根本不存 assistant 消息，只往 `messages` 里追加 `tool` 结果消息——反正模型下一轮看到结果就够了。

## 4. 为什么朴素思路会崩

"先执行、后补 assistant 消息"会在好几个地方爆掉：

- **协议直接拒绝**。如果 `messages` 里出现了 `tool` 角色消息，却找不到它前面那条带对应 `tool_call_id` 的 assistant 消息，下一次 API 请求大概率被 provider 判为非法序列。`conversation_loop.py` 专门有一道 `_sanitize_api_messages`（`:766`）就是给"孤儿 tool 结果"擦屁股的——但这是安全网，不是借口让你一开始就把顺序写错。
- **崩溃即失忆**。工具执行可能很慢（读大文件、跑命令），中途进程被杀、用户 Ctrl-C，如果 assistant 消息还没入列，这一回合的"模型决定调什么工具"就彻底丢了，会话恢复时历史是断的。先入列 assistant 消息，等于先把"模型的决定"落定。
- **reasoning 被丢弃**。模型返回的 `message` 对象上，reasoning 可能在 `reasoning_content` 字段、`reasoning_details` 字段、或者直接以 `<think>...</think>` 内联在 `content` 里——三种来源。随手抠 `tool_calls` 而不管 reasoning，思考就没了。
- **参数是字符串不是字典**。`tool_call.function.arguments` 是一段 **JSON 字符串**，不是 Python dict。而且开放权重模型经常把数字写成字符串（`"42"`）、把数组写成裸标量。直接拿去用，工具要么类型错要么解析炸。

核心矛盾：解析 `tool_call` 不是"抠两个字段"，而是"把模型这一回合的完整状态——决定 + 推理 + 待办——原子地落定到对话历史里"。

## 5. Hermes 的做法

对话循环走的是严格的"**先固化 assistant 消息，再执行工具**"两段式。

**第一段：把 `response` 里的 assistant 消息标准化。** 校验通过后，对话循环先对 `tool_calls` 做两道清洗（`conversation_loop.py:3179-3184`）——`_cap_delegate_task_calls` 限制 `delegate_task` 的并发数，`_deduplicate_tool_calls` 去掉模型重复发出的同名同参调用——然后调一个统一的构造器：

```python
assistant_message.tool_calls = agent._cap_delegate_task_calls(assistant_message.tool_calls)   # :3179
assistant_message.tool_calls = agent._deduplicate_tool_calls(assistant_message.tool_calls)    # :3182

assistant_msg = agent._build_assistant_message(assistant_message, finish_reason)              # :3186
```

`_build_assistant_message`（实现在 `chat_completion_helpers.py:456`）是工具调用路径和纯文本路径**共用的一个构造器**。它干三件事：

1. **提取 reasoning**——先试结构化字段（`_extract_reasoning`），失败再退回扫 `content` 里的内联 `<think>...</think>` 块（`chat_completion_helpers.py:469-474`）。
2. **清洗 content**——剥掉 surrogate 字符、把已被捕获的 `<think>` 标签从存储的 content 里删掉（`:515-517`），避免推理泄漏到下游。
3. **组装统一格式的 dict**：

```python
msg = {
    "role": "assistant",
    "content": _san_content,
    "reasoning": reasoning_text,         # ← reasoning 存这里
    "finish_reason": finish_reason,
}
```

注意 `reasoning` 存在 `assistant_msg["reasoning"]` 这个键里——它是**轨迹存储用**的；后续要发回 API 时，[步骤 10](tour-10-first-api-call.md) 描述过的 `_copy_reasoning_content_for_api`（`conversation_loop.py:700`）会把它复制成 provider 需要的 `reasoning_content`。对带 `tool_calls` 的消息，`build_assistant_message` 还会在思考型模型下补一个 `reasoning_content`（`chat_completion_helpers.py` 的 `_needs_thinking_reasoning_pad` 分支），否则 DeepSeek-v4 / Kimi 重放历史会 400。

**第二段：assistant 消息先入列，工具才执行。** 构造好的 `assistant_msg` 立刻追加进 `messages`，并发出一个 interim 事件让 UI 看到，然后才调用工具执行：

```python
messages.append(assistant_msg)                                          # :3241
agent._emit_interim_assistant_message(assistant_msg)
# ...
agent._execute_tool_calls(assistant_message, messages, effective_task_id, api_call_count)  # :3256
```

`messages.append` 在 `_execute_tool_calls` **之前**——这就是"先固化决定、再执行"。哪怕工具执行中途崩了，`messages` 里也已经有了这条带 `tool_calls` 的 assistant 消息，会话历史完整。

**OpenAI 风格的 tool_call 结构。** 不管底层 provider 是谁，transport 在 normalize 时已经把工具调用统一成了 OpenAI 风格。一个 `tool_call` 长这样：

```python
{
    "id": "call_abc123",
    "type": "function",
    "function": {
        "name": "read_file",
        "arguments": '{"path": "README.md"}',   # ← 注意：JSON 字符串，不是 dict
    },
}
```

`arguments` 是字符串。真正把它变成 dict、并把字符串数字 / 裸标量纠正回 schema 声明的类型，是在调度阶段由 `model_tools.py:535` 的 `coerce_tool_args` 完成的——下一步会讲。

整段流程：

<svg viewBox="0 0 820 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Two-stage parse: normalize assistant message then append before executing tools">
  <defs>
    <marker id="ar11a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="220" y="20" width="380" height="44" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="410" y="40" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">response</text>
  <text x="410" y="55" text-anchor="middle" font-size="10" fill="#64748b">含 tool_calls，finish_reason="tool_calls"</text>
  <line x1="410" y1="64" x2="410" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11a)"/>
  <rect x="220" y="90" width="380" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.3"/>
  <text x="410" y="110" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">_cap_delegate_task_calls / _deduplicate_tool_calls</text>
  <text x="410" y="125" text-anchor="middle" font-size="10" fill="#64748b">:3179-3184 — 清洗 tool_calls</text>
  <line x1="410" y1="134" x2="410" y2="156" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11a)"/>
  <rect x="220" y="160" width="380" height="50" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="410" y="180" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">_build_assistant_message(assistant_message, finish_reason)</text>
  <text x="410" y="196" text-anchor="middle" font-size="10" fill="#64748b">:3186 — 提取 reasoning，剥 &lt;think&gt; 标签、洗 surrogate</text>
  <line x1="410" y1="210" x2="410" y2="232" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11a)"/>
  <rect x="160" y="236" width="500" height="40" rx="6" fill="#fffbeb" stroke="#cbd5e1" stroke-width="1"/>
  <text x="410" y="261" text-anchor="middle" font-size="11" fill="currentColor">assistant_msg = {role:"assistant", content:..., reasoning:..., tool_calls:[...]}</text>
  <line x1="410" y1="276" x2="410" y2="298" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11a)"/>
  <rect x="220" y="302" width="380" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="322" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">messages.append(assistant_msg)</text>
  <text x="410" y="337" text-anchor="middle" font-size="10" fill="#64748b">:3241 — 先固化决定</text>
  <line x1="410" y1="346" x2="410" y2="368" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11a)"/>
  <rect x="220" y="372" width="380" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="397" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">_execute_tool_calls(...)　:3256 — 再执行工具</text>
</svg>
<span class="figure-caption">图 T11.1 ｜ 两段式解析：先把 response 标准化为 assistant 消息并入列固化决定，再执行工具。</span>

<details>
<summary>ASCII 原版</summary>

```text
        response（含 tool_calls，finish_reason="tool_calls"）
              │
              ▼
        _cap_delegate_task_calls / _deduplicate_tool_calls   (:3179-3184)
              │   清洗 tool_calls
              ▼
        _build_assistant_message(assistant_message, finish_reason)   (:3186)
              │   提取 reasoning → msg["reasoning"]
              │   剥 <think> 标签、洗 surrogate
              ▼
        assistant_msg = {role:"assistant", content:..., reasoning:..., tool_calls:[...]}
              │
              ▼
        messages.append(assistant_msg)   (:3241)  ← 先固化决定
              │
              ▼
        _execute_tool_calls(...)         (:3256)  ← 再执行工具
```

</details>

走到这一步，本例的解析结果是：`tool_calls = [{id, type:"function", function:{name:"read_file", arguments:'{"path":"README.md"}'}}]`，`messages` 变成了 `[system, user, assistant(tool_call)]`。`assistant` 消息里 `content` 大概率是空字符串（模型这回合只调工具没说话），`reasoning` 视模型而定。一切就绪，准备交给调度器。

## 6. 代码位置

按阅读顺序：

- `tool_calls` 清洗：`agent/conversation_loop.py:3179-3184` —— `_cap_delegate_task_calls` + `_deduplicate_tool_calls`。
- assistant 消息构造调用点：`agent/conversation_loop.py:3186` —— `agent._build_assistant_message(...)`。
- 构造器实现：`agent/chat_completion_helpers.py:456` —— `build_assistant_message`；reasoning 提取与内联 `<think>` 回退在 `:462-474`，`reasoning` 键写入在 `:517-522` 附近。
- assistant 消息入列：`agent/conversation_loop.py:3241` —— `messages.append(assistant_msg)`。
- 工具执行入口：`agent/conversation_loop.py:3256` —— `agent._execute_tool_calls(...)`。
- 参数类型强转（下一步用到）：`model_tools.py:535` —— `coerce_tool_args`。

## 7. 分支与延伸

- 对话循环的整体回合结构——"API 调用 → 解析 → 执行 → 回灌 → 再调用"如何成环 → [第 3 章 对话循环](03-conversation-loop.md)。
- 工具调用的数据结构、`tool_call_id` 配对规则、工具注册表如何提供 schema → [第 5 章 工具系统](05-tool-system.md)。
- 上一步：`response` 是怎么发请求拿回来的 → [Trace 步骤 10](tour-10-first-api-call.md)。
- 下一步：`tool_calls` 清单交给调度器，决定并行还是串行、选定 handler → [Trace 步骤 12](tour-12-tool-dispatch.md)。
- 如果模型这一回合既有 `content` 又有 `tool_calls`（边说话边调工具），`content` 会被存进 `_last_content_with_tools` 作为兜底回答（`conversation_loop.py:3192-3194`）→ [第 3 章 §混合回合](03-conversation-loop.md)。

## 8. 走完这一步你脑子里应该多了什么

1. 对话循环走的是**先固化 assistant 消息、再执行工具**的两段式：`messages.append(assistant_msg)`（`:3241`）严格早于 `_execute_tool_calls`（`:3256`）——这既满足协议的消息顺序要求，又保证崩溃时历史不丢。
2. `_build_assistant_message`（`chat_completion_helpers.py:456`）是工具调用路径和纯文本路径**共用的构造器**——它统一负责 reasoning 提取、`<think>` 标签清洗、surrogate 净化。
3. reasoning 存在 `assistant_msg["reasoning"]` 键里，用于轨迹存储；发回 API 时另有 `_copy_reasoning_content_for_api` 把它映射成 provider 要的 `reasoning_content`。
4. 一个 OpenAI 风格 `tool_call` 的 `function.arguments` 是一段 **JSON 字符串**，不是 dict；变 dict + 类型纠正是下一步 `coerce_tool_args` 的活。
5. 本例解析出：`name=read_file`、`arguments={"path": "README.md"}`，`messages` 推进到 `[system, user, assistant(tool_call)]`。

---

下一步：[Trace 步骤 12 —— 一个工具调用，怎么调度到 handler？](tour-12-tool-dispatch.md)
