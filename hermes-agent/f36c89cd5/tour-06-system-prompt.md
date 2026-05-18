# Trace 步骤 06 —— 这一大段文字是怎么拼出来的？

## 1. 当前情境

上一步结束时，`ToolRegistry` 已经被 AST 扫描填满了约 79 个工具条目，`agent.tools` 是一个能直接发给模型的 JSON Schema 列表，`agent.valid_tool_names` 是一个工具名集合。`AIAgent` 实例已经构造完毕，但它还从没跟模型说过一句话。

模型要工作，第一句话必须是**系统提示**——告诉它"你是谁、你能用哪些工具、有什么规矩、你记得什么、现在几点、你在什么机器上"。这一步要回答的问题是：这一大段动辄上万 token 的文本，是从哪些零件、按什么顺序拼出来的，以及为什么它必须**拼一次就再也不动**。

## 2. 问题

系统提示要同时满足几个互相拉扯的需求：

- **信息要全**：人格、工具定义、行为规则、长期记忆、技能清单、运行环境，缺一样模型就会犯错——比如不知道有 `read_file` 工具，就会编造文件内容。
- **要省钱**：上游 Anthropic / OpenRouter 的 prompt caching 能把重复前缀的输入 token 费用打到约 25%。但缓存命中的前提是**前缀字节完全一致**——系统提示哪怕变一个字符，缓存就整段失效。
- **多轮之间要稳定**：一次会话里会发很多次 API 请求（这条 trace 就有两次）。如果每一轮都重新渲染系统提示，把"当前时间"刷新一下、把刚写入的记忆塞进去，前缀就漂移了，缓存全废。
- **有些内容天生会变**：记忆会被本轮的 `memory` 工具改写，技能内容很长且只在被调用时才需要。把它们硬塞进系统提示，要么撑爆 context，要么破坏缓存。

核心矛盾：系统提示既要**装下一切**，又要**一个字节都不许动**。

## 3. 朴素思路

最直觉的写法：每轮对话开始时，调一个 `build_prompt()` 函数，把所有零件现拼一遍——

```python
def build_prompt(agent):
    s = IDENTITY
    s += "\n\n" + format_tools(agent.tools)
    s += "\n\n" + RULES
    s += "\n\n" + agent.memory.dump()
    s += "\n\n" + "Current time: " + now()
    s += "\n\n" + load_all_skills()   # 把每个技能的全文都拼进来
    return s
```

每轮都拼最新的——记忆是最新的，时间是最新的，技能全在手边。看起来既正确又简单。

## 4. 为什么朴素思路会崩

这个写法会在三个地方撞墙：

- **缓存永远 miss**。`Current time: ` 这一行每轮都不同，`agent.memory.dump()` 在模型调用 `memory` 工具后也变了。系统提示是请求的**最前缀**，前缀一变，后面所有 token 的缓存全部作废。一个 79 工具的系统提示轻松上万 token，每轮多付约 4 倍的钱。
- **技能全文撑爆 context**。`load_all_skills()` 把几十个技能的 SKILL.md 全文拼进系统提示，可能就是几万 token。但用户这一轮也许根本不碰任何技能——这些 token 纯属浪费，还把真正有用的对话历史挤出了窗口。
- **"模型已知"的记忆又被回灌**。模型这一轮用 `memory` 工具写了一条新记忆。如果下一轮把这条新记忆拼进系统提示，系统提示就变了——可模型**早就知道这条记忆**（是它自己写的）。结果是：白白破坏了缓存，换来零信息增量。

矛盾的根源是把"会变的东西"和"不变的东西"混在了一锅里。

## 5. Hermes 的做法

Hermes 的解法是**三层分桶 + 一次成型 + 缓存到实例**。

`build_system_prompt_parts()`（`agent/system_prompt.py:60`）把所有零件按"变化频率"分进三个桶：

<svg viewBox="0 0 820 440" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Three-bucket system prompt structure: stable, context, volatile">
  <defs>
    <marker id="ar6a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="40" y="20" width="740" height="160" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="56" y="42" font-size="13" font-weight="700" fill="currentColor">stable</text>
  <text x="120" y="42" font-size="11" fill="#64748b">整个会话生命周期不变 — 缓存前缀</text>
  <text x="56" y="64" font-size="11" fill="currentColor">SOUL.md 人格 / DEFAULT_AGENT_IDENTITY</text>
  <text x="56" y="82" font-size="11" fill="currentColor">hermes-agent 帮助指引</text>
  <text x="56" y="100" font-size="11" fill="currentColor">工具行为指引（memory / session_search / skills ...）</text>
  <text x="56" y="118" font-size="11" fill="currentColor">computer-use 指引、Nous 订阅块</text>
  <text x="56" y="136" font-size="11" fill="currentColor">工具调用强制指引 + 按模型族的操作指引</text>
  <text x="56" y="154" font-size="11" fill="currentColor">技能索引（skills 清单，只有名字+一句话，不是全文）</text>
  <text x="56" y="172" font-size="11" fill="currentColor">环境提示（build_environment_hints）、平台提示</text>
  <rect x="40" y="192" width="740" height="84" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="56" y="214" font-size="13" font-weight="700" fill="currentColor">context</text>
  <text x="130" y="214" font-size="11" fill="#64748b">跨会话可能变（取决于 cwd）</text>
  <text x="56" y="238" font-size="11" fill="currentColor">调用方传入的 system_message</text>
  <text x="56" y="258" font-size="11" fill="currentColor">cwd 下发现的 AGENTS.md / CLAUDE.md / .cursorrules ...</text>
  <rect x="40" y="288" width="740" height="100" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="56" y="310" font-size="13" font-weight="700" fill="currentColor">volatile</text>
  <text x="140" y="310" font-size="11" fill="#64748b">每会话 / 每轮都变</text>
  <text x="56" y="334" font-size="11" fill="currentColor">记忆快照、USER.md 画像</text>
  <text x="56" y="354" font-size="11" fill="currentColor">外部记忆 provider 块</text>
  <text x="56" y="374" font-size="11" fill="currentColor">时间戳 / Session ID / Model / Provider 行</text>
  <line x1="410" y1="388" x2="410" y2="410" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6a)"/>
  <text x="410" y="428" text-anchor="middle" font-size="11" fill="#64748b">三桶各自 strip 后按 stable → context → volatile 用 \n\n 连接 → build_system_prompt()</text>
</svg>
<span class="figure-caption">图 T6.1 ｜ 系统提示按变化频率分三桶；最不变的 stable 放最前，使 prompt caching 前缀字节稳定。</span>

<details>
<summary>ASCII 原版</summary>

```text
  ┌─ stable   ── 整个会话生命周期不变 ──────────────────────┐
  │   SOUL.md 人格 / DEFAULT_AGENT_IDENTITY                  │
  │   hermes-agent 帮助指引                                  │
  │   工具行为指引（memory / session_search / skills ...）   │
  │   computer-use 指引、Nous 订阅块                         │
  │   工具调用强制指引 + 按模型族的操作指引                  │
  │   技能索引（skills 清单，只有名字+一句话，不是全文）     │
  │   环境提示（build_environment_hints）、平台提示          │
  ├─ context  ── 跨会话可能变（取决于 cwd）─────────────────┤
  │   调用方传入的 system_message                            │
  │   cwd 下发现的 AGENTS.md / CLAUDE.md / .cursorrules ...   │
  ├─ volatile ── 每会话/每轮都变 ────────────────────────────┤
  │   记忆快照、USER.md 画像                                 │
  │   外部记忆 provider 块                                   │
  │   时间戳 / Session ID / Model / Provider 行              │
  └──────────────────────────────────────────────────────────┘
        三桶各自 strip 后用 \n\n 连接 → build_system_prompt()
```

</details>

`build_system_prompt()`（`agent/system_prompt.py:274`）只是把三个桶按 `stable → context → volatile` 顺序用 `\n\n` 拼成一个字符串：

```python
def build_system_prompt(agent, system_message=None):
    parts = build_system_prompt_parts(agent, system_message=system_message)
    return "\n\n".join(p for p in (parts["stable"], parts["context"], parts["volatile"]) if p)
```

桶的顺序就是设计：**最不变的放最前**。这样即使 `volatile` 桶变了，前面 `stable + context` 那一大段前缀依然字节一致——缓存仍能在那个边界上命中。

**工具定义怎么进去**：`format_tools_for_system_message()`（`agent/system_prompt.py:304`）把 `agent.tools` 转成 trajectory 格式的 JSON 字符串：

```python
def format_tools_for_system_message(agent):
    if not agent.tools:
        return "[]"
    formatted_tools = []
    for tool in agent.tools:
        func = tool["function"]
        formatted_tools.append({
            "name": func["name"],
            "description": func.get("description", ""),
            "parameters": func.get("parameters", {}),
            "required": None,
        })
    return json.dumps(formatted_tools, ensure_ascii=False)
```

**人格怎么进去**：`load_soul_md()`（`agent/prompt_builder.py:1304`）从 `HERMES_HOME` 读 `SOUL.md`，作为系统提示的第一槽（identity）。读不到才回退到硬编码的 `DEFAULT_AGENT_IDENTITY`：

```python
_soul_loaded = False
if agent.load_soul_identity or not agent.skip_context_files:
    _soul_content = _r.load_soul_md()
    if _soul_content:
        stable_parts.append(_soul_content)
        _soul_loaded = True
if not _soul_loaded:
    stable_parts.append(DEFAULT_AGENT_IDENTITY)
```

注意 `_soul_loaded` 这个标志位：SOUL.md 一旦从 identity 槽加载，后面 `build_context_files_prompt(skip_soul=_soul_loaded)` 就会跳过它，避免同一份 SOUL.md 被注入两次。

**环境提示**：`build_environment_hints()`（`agent/prompt_builder.py:736`）发一段描述运行环境的文字——本地终端写明主机 OS、用户家目录、当前 cwd；远程 sandbox 后端（docker / modal / ssh 等）则**抑制主机信息**，改成实时探测 sandbox 里的 OS/用户/cwd，因为工具操作的是 sandbox 而非宿主机。

**技能为什么只放索引、不放全文**：`stable` 桶里只有 `build_skills_system_prompt()` 产出的**技能索引**——每个技能一行"名字 + 一句话描述"。技能的完整 SKILL.md 全文**不进系统提示**。等模型真的决定用某个技能时，技能全文才作为一条 **user message** 注入对话。理由有两条：(1) 把几十个技能全文塞进系统提示会撑爆 context，绝大多数都用不上；(2) 系统提示必须字节稳定，而技能内容是按需变化的——放进 user message 不碰前缀缓存。

**拼一次，缓存到实例**：`build_system_prompt()` 的产物会被存到 `agent._cached_system_prompt`，整个会话生命周期复用，**只有上下文压缩事件**才会通过 `invalidate_system_prompt()` 触发重建。下一步会看到 `run_conversation` 第一轮把它存进 SQLite，续接会话直接读回那份快照而不是重建——这样连 `volatile` 桶里的时间戳都不会漂。

**缓存断点**：`agent/prompt_caching.py` 的 `apply_anthropic_cache_control()` 用 `system_and_3` 策略——在系统提示 + 最后 3 条非系统消息上各打一个 `cache_control` 断点（共 4 个），多轮会话里输入 token 费用降约 75%。系统提示作为单一 content 字符串发送，确保字节稳定，断点才有意义。

到这一步结束，`agent._cached_system_prompt` 是一段成型的字符串，缓存在实例上，等着被塞进 `messages` 列表当第一条 `system` 消息。

## 6. 代码位置

按阅读顺序：

- 三桶装配：`agent/system_prompt.py:60` —— `build_system_prompt_parts()`，`stable` / `context` / `volatile` 三个 list 依次填充。
- SOUL.md 加载与去重标志：`agent/system_prompt.py:89-98` —— `_soul_loaded` 逻辑。
- 工具行为指引按工具名注入：`agent/system_prompt.py:104-118` —— `MEMORY_GUIDANCE` / `SESSION_SEARCH_GUIDANCE` / `SKILLS_GUIDANCE` 等。
- 技能索引注入：`agent/system_prompt.py:162-178` —— `build_skills_system_prompt()` 只产出清单。
- 环境提示与平台提示：`agent/system_prompt.py:194-212`。
- volatile 桶（记忆 / 时间戳）：`agent/system_prompt.py:233-265`。
- 三桶拼接成串：`agent/system_prompt.py:274` —— `build_system_prompt()`。
- 缓存失效：`agent/system_prompt.py:293` —— `invalidate_system_prompt()`，只有压缩才调。
- 工具定义格式化：`agent/system_prompt.py:304` —— `format_tools_for_system_message()`。
- 人格加载：`agent/prompt_builder.py:1304` —— `load_soul_md()`。
- 环境提示构造：`agent/prompt_builder.py:736` —— `build_environment_hints()`。
- 技能索引构造：`agent/prompt_builder.py:988` —— `build_skills_system_prompt()`，带两层缓存。
- 缓存断点策略：`agent/prompt_caching.py:49` —— `apply_anthropic_cache_control()`，`system_and_3` 布局。

## 7. 分支与延伸

- 系统提示三层结构、缓存不变式、context 文件发现的完整规则 → [第 4 章 系统提示与上下文构造](04-system-prompt.md)。
- 技能索引怎么扫描、技能全文何时作为 user message 注入、curator 如何维护技能 → [第 11 章 技能系统](11-skills-and-curator.md)。
- `agent.tools` 这个工具 Schema 列表是上一步 AST 扫描的产物 → [Trace 步骤 05 —— 工具自动发现](tour-05-tool-discovery.md)。
- 这段系统提示字符串在下一步会被存进 SQLite，并在 `run_conversation` 里成为 `messages` 的第一条 → [Trace 步骤 07 —— REPL 读取用户输入](tour-07-repl-input.md)。
- `volatile` 桶里的记忆块来自记忆系统的快照；记忆 prefetch 的另一条路径见 [Trace 步骤 09](tour-09-memory-prefetch.md)。
- 上下文压缩如何触发系统提示重建 → [第 4 章 §压缩与重建](04-system-prompt.md)。

## 8. 走完这一步你脑子里应该多了什么

1. 系统提示不是一锅乱炖，而是按**变化频率**分三桶——`stable`（会话内不变）、`context`（取决于 cwd）、`volatile`（每轮变），桶的拼接顺序"最不变的放最前"本身就是为缓存服务的设计。
2. 系统提示**拼一次就缓存在 `agent._cached_system_prompt`**，整个会话复用，只有上下文压缩才重建——这是 prompt caching 能命中的唯一前提，前缀漂一个字节缓存就全废。
3. 工具定义由 `format_tools_for_system_message()` 序列化进 `stable` 桶；人格由 `load_soul_md()` 从 `SOUL.md` 注入，读不到才回退硬编码 identity，`_soul_loaded` 标志防止 SOUL.md 被注入两次。
4. 技能在系统提示里**只有索引（名字+一句话）**，全文等到模型真要用时才作为 **user message** 注入——既不撑爆 context，也不碰系统提示的缓存前缀。
5. `apply_anthropic_cache_control` 用 `system_and_3` 策略打 4 个缓存断点，多轮会话输入费用降约 75%——这就是前面所有"字节稳定"努力的最终兑现处。

---

下一步：[Trace 步骤 07 —— REPL 读取用户输入](tour-07-repl-input.md)
