# 第 10 章 记忆系统与学习闭环

## 10.1 问题：无状态模型如何"记住"

大型语言模型在 API 层面是无状态的。每一次 `chat/completions` 调用，模型只能看到这一次请求里携带的 messages 数组；上一次会话发生过什么、用户三周前纠正过的某个偏好、当前机器上装了什么工具——这些信息一旦不在请求体里，模型就完全不知道。

对一个普通的"问答机器人"，这没什么。但 Hermes Agent 的定位是一个**长期陪伴、跨会话工作的自我改进型 agent**：它今天帮你部署了一个服务，明天你回来希望它记得"我的项目用 uv 不用 pip"、"我在 macOS 上、终端是 zsh"、"我讨厌冗长的解释,直接给命令"。如果每个新会话都要从零开始重新解释这些,那它就不是 agent,只是一个无记忆的工具。

记忆系统要解决的就是这个鸿沟。它要回答三个具体问题:

1. **哪些信息值得跨会话保留?** 不是全部对话历史——那是 `session_search` 的职责(检索过往 transcript)。记忆只保留**稳定的、会反复用到的事实**:环境约定、用户画像、工具怪癖。
2. **保留的信息如何在不破坏 prompt 缓存的前提下被注入?** 系统提示一旦变化,整个前缀缓存失效,每一轮都要重新计费。记忆系统必须在"让模型看到记忆"和"保持系统提示稳定"之间取得平衡。
3. **如何在不阻塞主对话循环的前提下,把新学到的东西写回去?** 写记忆不能让用户等待。

Hermes 的答案分成两层:

- **内置文件记忆**(`tools/memory_tool.py`):零依赖、永远可用,两个 Markdown 文件 `MEMORY.md` / `USER.md`,采用"冻结快照"模式。
- **可插拔记忆 provider**(`agent/memory_provider.py` + `plugins/memory/`):外部后端(Honcho、Mem0、Hindsight 等),做语义检索、辩证式用户建模等高级能力。

两层由 **MemoryManager**(`agent/memory_manager.py:190`)统一编排。本章先讲编排器,再讲两层实现,最后把记忆放回更大的"学习闭环"全景里——技能自创建、curator、session_search 如何一起构成 Hermes 所说的"自我改进"。

<svg viewBox="0 0 780 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="MemoryManager orchestrates two layers: builtin and external providers">
  <defs>
    <marker id="r10ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="40" y="36" width="150" height="44" rx="8" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="115" y="63" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">run_agent.py</text>
  <line x1="190" y1="58" x2="268" y2="58" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar1)"/>
  <rect x="270" y="30" width="280" height="56" rx="10" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="54" font-size="13" font-weight="700" fill="currentColor" text-anchor="middle">MemoryManager（单一集成点）</text>
  <text x="410" y="72" font-size="10" fill="#64748b" text-anchor="middle">agent/memory_manager.py:190</text>
  <text x="430" y="112" font-size="10" fill="#64748b">委派给已注册 provider</text>
  <line x1="410" y1="86" x2="220" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar1)"/>
  <line x1="410" y1="86" x2="590" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar1)"/>
  <rect x="60" y="160" width="320" height="120" rx="10" fill="#99f6e4" stroke="#0d9488"/>
  <text x="220" y="184" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">builtin provider</text>
  <text x="220" y="206" font-size="11" fill="#64748b" text-anchor="middle">MEMORY.md / USER.md</text>
  <text x="220" y="226" font-size="11" fill="#64748b" text-anchor="middle">冻结快照 + memory 工具</text>
  <text x="220" y="252" font-size="10" fill="#94a3b8" text-anchor="middle">零依赖 · 永远第一个注册 · 永远存在</text>
  <rect x="440" y="160" width="300" height="120" rx="10" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="590" y="184" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">至多 1 个 external provider</text>
  <text x="590" y="206" font-size="11" fill="#64748b" text-anchor="middle">honcho / mem0 / hindsight …</text>
  <text x="590" y="226" font-size="11" fill="#64748b" text-anchor="middle">语义检索 / 辩证用户建模</text>
  <text x="590" y="252" font-size="10" fill="#94a3b8" text-anchor="middle">plugins/memory/&lt;name&gt;/</text>
</svg>
<span class="figure-caption">图 R10.1 ｜ 记忆系统两层结构：MemoryManager 作为单一集成点，扇出给 builtin 与至多一个 external provider。</span>

<details>
<summary>ASCII 原版</summary>

```text
                       ┌──────────────────────────────┐
   run_agent.py  ──────▶  MemoryManager  (单一集成点)   │
                       │  agent/memory_manager.py:190  │
                       └───────────┬──────────────────┘
                                   │ 委派给已注册 provider
                  ┌────────────────┼─────────────────────┐
                  ▼                                      ▼
        ┌───────────────────┐              ┌──────────────────────────┐
        │ builtin provider  │              │ 至多 1 个 external provider│
        │ MEMORY.md/USER.md │              │ honcho / mem0 / hindsight │
        │ 冻结快照 + memory  │              │ 语义检索 / 辩证用户建模    │
        │   工具            │              │ plugins/memory/<name>/    │
        └───────────────────┘              └──────────────────────────┘
```

</details>

---

## 10.2 MemoryManager:单一集成点

### 10.2.1 为什么要有一个编排器

在 MemoryManager 出现之前(见模块 docstring,`agent/memory_manager.py:3-8`),记忆能力是"散落在各个 backend 里的逐后端代码"。每接一个新的记忆后端,`run_agent.py` 就要多一段 if-else。MemoryManager 把这件事收敛成一个对象:`run_agent.py` 只跟它打交道,它再把调用扇出给所有已注册的 provider。

docstring 里给出的标准用法非常直白(`agent/memory_manager.py:10-23`):

```python
self._memory_manager = MemoryManager()
self._memory_manager.add_provider(plugin_provider)         # 只注册其中之一

prompt_parts.append(self._memory_manager.build_system_prompt())   # 系统提示
context = self._memory_manager.prefetch_all(user_message)         # 转折前
self._memory_manager.sync_all(user_msg, assistant_response)       # 转折后
self._memory_manager.queue_prefetch_all(user_msg)                 # 排队下一轮
```

MemoryManager 的内部状态只有三个字段(`agent/memory_manager.py:197-200`):

```python
self._providers: List[MemoryProvider] = []
self._tool_to_provider: Dict[str, MemoryProvider] = {}
self._has_external: bool = False  # 一旦注册了非 builtin provider 就为 True
```

`_providers` 是按注册顺序排列的列表;`_tool_to_provider` 是工具名到 provider 的路由表;`_has_external` 用来强制"至多一个外部 provider"的不变式。

### 10.2.2 `add_provider()`:为什么外部 provider 只能有一个

`add_provider()`(`agent/memory_manager.py:204`)是注册入口。它的核心约束写在 docstring 里(`agent/memory_manager.py:6-8`):**至多注册一个外部 provider,第二个会被带警告地拒绝**。

```python
def add_provider(self, provider: MemoryProvider) -> None:
    is_builtin = provider.name == "builtin"

    if not is_builtin:
        if self._has_external:
            existing = next(
                (p.name for p in self._providers if p.name != "builtin"), "unknown"
            )
            logger.warning(
                "Rejected memory provider '%s' — external provider '%s' is "
                "already registered. Only one external memory provider is "
                "allowed at a time. ...", provider.name, existing,
            )
            return
        self._has_external = True

    self._providers.append(provider)
```

为什么是"至多一个"?docstring 给了两个理由(`agent/memory_manager.py:7-8`):

1. **避免工具 schema 膨胀**。每个 provider 通过 `get_tool_schemas()` 向模型暴露自己的工具。如果同时挂三个外部记忆后端,模型的工具列表里就会冒出三套互相竞争的"记忆工具",既消耗 token 又让模型困惑。
2. **避免冲突的记忆后端**。两个后端各自维护一份"用户画像",模型不知道该信哪个,写入也会分裂。

注意 builtin provider **不受此限制**——它永远第一个注册,永远存在。所以实际形态总是"1 个 builtin + 0 或 1 个 external"。

注册之后,`add_provider()` 还会把该 provider 的每个工具名索引进 `_tool_to_provider`(`agent/memory_manager.py:231-242`)。如果两个 provider 撞了同一个工具名,后者的会被忽略并打警告——这是路由表的去重。

### 10.2.3 `build_system_prompt()`:静态块的收集

`build_system_prompt()`(`agent/memory_manager.py:264`)在系统提示组装阶段被调用。它遍历所有 provider,收集各自的 `system_prompt_block()`,用双换行拼接:

```python
def build_system_prompt(self) -> str:
    blocks = []
    for provider in self._providers:
        try:
            block = provider.system_prompt_block()
            if block and block.strip():
                blocks.append(block)
        except Exception as e:
            logger.warning("Memory provider '%s' system_prompt_block() failed: %s",
                            provider.name, e)
    return "\n\n".join(blocks)
```

注意这里收集的是 **静态信息**——provider 的使用说明、状态描述。**召回的具体记忆内容不走这条路**,它由 `prefetch()` 单独注入到 user message(见 10.2.4)。这个区分是整个记忆系统能保住 prompt 缓存的关键。

还要注意每个 provider 调用都包在 `try/except` 里:一个 provider 抛异常,绝不能拖垮系统提示组装。这是 MemoryManager 贯穿全文件的设计原则——**provider 隔离**。

### 10.2.4 `prefetch_all()`:转折前的召回

`prefetch_all()`(`agent/memory_manager.py:285`)在每次 API 调用**之前**被调用,参数是即将发送的用户消息。它让每个 provider 有机会"回想起"与本轮相关的上下文:

```python
def prefetch_all(self, query: str, *, session_id: str = "") -> str:
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

`prefetch()` 返回的文本不会进系统提示,而是被包进一个**带围栏的块**注入到 user message。这个包装由 `build_memory_context_block()` 完成(`agent/memory_manager.py:173`):

```python
def build_memory_context_block(raw_context: str) -> str:
    if not raw_context or not raw_context.strip():
        return ""
    clean = sanitize_context(raw_context)
    if clean != raw_context:
        logger.warning("memory provider returned pre-wrapped context; stripped")
    return (
        "<memory-context>\n"
        "[System note: The following is recalled memory context, "
        "NOT new user input. Treat as authoritative reference data — "
        "this is the agent's persistent memory and should inform all responses.]\n\n"
        f"{clean}\n"
        "</memory-context>"
    )
```

这里有两个值得说的设计:

**(a) 围栏标签与系统注记。** 召回的记忆被包在 `<memory-context>...</memory-context>` 标签里,并加一条系统注记说明"这是召回的记忆,不是新的用户输入"。为什么?因为召回内容是注入到 user message 的——如果不加标记,模型可能把它当成用户刚刚说的话。围栏标签让模型(和后续处理代码)能清楚区分"真正的用户输入"和"系统注入的背景数据"。

**(b) 流式擦除器。** 召回内容被包在标签里,但**绝不能泄漏到 UI**——用户不该在屏幕上看到 `<memory-context>` 这种内部标签。一次性的正则 `sanitize_context()`(`agent/memory_manager.py:54`)对完整字符串有效,但对**流式输出**无能为力:一个 `<memory-context>` 开标签可能落在一个 delta 里,闭标签落在好几个 delta 之后,非贪婪正则需要两个标签同时出现在一个字符串里才能匹配。

于是有了 `StreamingContextScrubber`(`agent/memory_manager.py:62`)——一个跨 delta 的状态机:

```python
class StreamingContextScrubber:
    _OPEN_TAG = "<memory-context>"
    _CLOSE_TAG = "</memory-context>"

    def feed(self, text: str) -> str:
        # 在 span 内:丢弃内容,直到找到闭标签
        # 在 span 外:正常输出,但握住可能是开标签前缀的尾部字节
```

它的精妙之处在 `_max_partial_suffix()`(`agent/memory_manager.py:158`):如果一个 delta 以 `<memory-c` 结尾,这可能是开标签的前缀,也可能只是普通文本。擦除器会**握住**这段尾巴,等下一个 delta 到来再判断。`flush()`(`agent/memory_manager.py:142`)在流结束时收尾——如果还停在未闭合的 span 里,剩余内容**直接丢弃**(注释 `agent/memory_manager.py:144-148` 说明理由:泄漏部分记忆上下文比截断答案更糟)。

### 10.2.5 `sync_all()`:转折后的异步写

`sync_all()`(`agent/memory_manager.py:317`)在一轮对话完成后被调用,把这一轮的 user/assistant 内容交给每个 provider 持久化:

```python
def sync_all(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
    for provider in self._providers:
        try:
            provider.sync_turn(user_content, assistant_content, session_id=session_id)
        except Exception as e:
            logger.warning("Memory provider '%s' sync_turn failed: %s", provider.name, e)
```

`MemoryProvider.sync_turn()` 的契约(`agent/memory_provider.py:114-119`)明确要求实现**非阻塞**——如果后端有延迟,应该排进后台队列处理。配套的 `queue_prefetch_all()`(`agent/memory_manager.py:304`)则在转折后为**下一轮**排一个后台召回:provider 在后台线程里把召回算好缓存起来,下一轮的 `prefetch()` 直接返回缓存结果,不卡主循环。

<svg viewBox="0 0 780 250" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="prefetch and async sync timing across two conversation turns">
  <defs>
    <marker id="r10ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="200" y="24" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">转折 N</text>
  <line x1="40" y1="32" x2="360" y2="32" stroke="#cbd5e1"/>
  <rect x="40" y="44" width="150" height="40" rx="6" fill="#0d9488" fill-opacity="0.18" stroke="#0d9488"/>
  <text x="115" y="68" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">prefetch_all()</text>
  <line x1="190" y1="64" x2="218" y2="64" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar2)"/>
  <rect x="220" y="44" width="130" height="40" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="285" y="68" font-size="11" fill="currentColor" text-anchor="middle">用消息发起调用</text>
  <line x1="350" y1="64" x2="430" y2="64" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar2)"/>
  <text x="580" y="24" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">转折 N+1</text>
  <line x1="430" y1="32" x2="760" y2="32" stroke="#cbd5e1"/>
  <rect x="430" y="44" width="120" height="40" rx="6" fill="#fed7aa" stroke="#ea580c"/>
  <text x="490" y="68" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">API 调用</text>
  <line x1="550" y1="64" x2="578" y2="64" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar2)"/>
  <rect x="580" y="44" width="110" height="40" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="635" y="68" font-size="11" fill="currentColor" text-anchor="middle">响应</text>
  <line x1="635" y1="84" x2="635" y2="118" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar2)"/>
  <rect x="500" y="120" width="270" height="40" rx="6" fill="#7c3aed" fill-opacity="0.15" stroke="#7c3aed"/>
  <text x="635" y="144" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">sync_all()  ── 异步写后端</text>
  <line x1="500" y1="140" x2="120" y2="140" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r10ar2)"/>
  <rect x="40" y="178" width="320" height="44" rx="6" fill="#7c3aed" fill-opacity="0.15" stroke="#7c3aed"/>
  <text x="200" y="200" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">queue_prefetch_all()</text>
  <text x="200" y="215" font-size="10" fill="#64748b" text-anchor="middle">后台算好下一轮召回并缓存</text>
  <path d="M115,178 C100,150 100,110 115,86" fill="none" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r10ar2)"/>
  <text x="40" y="130" font-size="9" fill="#0d9488">下轮 prefetch 直接返回缓存</text>
</svg>
<span class="figure-caption">图 R10.2 ｜ 转折间的记忆流水：prefetch 直接返回上轮后台算好的缓存，sync 与下轮召回都在响应后异步进行，不卡主循环。</span>

<details>
<summary>ASCII 原版</summary>

```text
  转折 N            转折 N+1
  ───────           ─────────
  prefetch_all() ─▶ 用消息  ── API 调用 ──▶ 响应
       ▲                                     │
       │ 返回缓存                            ▼
       │                            sync_all()  (异步写后端)
       └──────────── queue_prefetch_all()  (后台算好下一轮召回)
```

</details>

### 10.2.6 生命周期钩子

MemoryProvider 除了核心生命周期,还定义了一组**可选钩子**(`agent/memory_provider.py:142-225`),provider 按需 override。MemoryManager 为每个钩子都提供了扇出方法:

| 钩子 | MemoryManager 方法 | 触发时机 | 用途 |
|---|---|---|---|
| `on_turn_start` | `:378` | 每轮开始 | 计数、周期维护;kwargs 带 `remaining_tokens`/`model`/`platform` |
| `on_session_end` | `:392` | 会话结束(退出、超时) | 会话级事实抽取、总结 |
| `on_session_switch` | `:403` | session_id 中途轮换 | `/resume` `/branch` `/reset` `/new` 与上下文压缩 |
| `on_pre_compress` | `:438` | 上下文压缩前 | 从将被丢弃的消息里抽取洞见,返回文本进压缩摘要 |
| `on_memory_write` | `:483` | 内置 memory 工具写入时 | 把内置写入镜像到外部后端 |
| `on_delegation` | `:513` | 子 agent 完成时 | 父 agent 观察被委派任务及其结果 |

几个钩子值得展开:

**`on_session_switch`** 处理一个隐蔽的 bug 类。provider 在 `initialize()` 时会缓存"当前 session 状态"(`_session_id`、`_document_id`、累积的 turn buffer)。但 `/resume`、`/branch`、`/reset`、上下文压缩这些路径都会**重新赋值 `AIAgent.session_id` 而不销毁 provider**。如果不通知 provider,后续的写入就会落到错误 session 的记录里。`on_session_switch` 就是让 provider 刷新这份缓存的钩子。`reset` 参数尤其关键(`agent/memory_provider.py:191-198`):`/reset`/`/new` 是真正的新对话,provider 应该 flush 累积的 buffer;`/resume`/`/branch`/压缩 则是逻辑上同一对话的延续,`reset=False`。

**`on_memory_write`** 实现了"内置 + 外部"两层之间的桥接。当内置 memory 工具写入一条记忆,MemoryManager 通过 `on_memory_write()`(`agent/memory_manager.py:483`)通知**外部** provider(跳过 builtin 自己,因为它就是写入源)。这让外部后端可以把内置文件记忆的写入镜像进自己的存储。这里还有一段有意思的兼容代码——`_provider_memory_write_metadata_mode()`(`agent/memory_manager.py:457`)用 `inspect.signature` 探测 provider 的 `on_memory_write` 能接受几个参数,决定用 `keyword`/`positional`/`legacy` 三种方式之一传 metadata。这是为了让老版本的 provider(签名里没有 `metadata` 参数)仍能工作。

**`on_delegation`**(`agent/memory_provider.py:214-225`)体现了一个细节:子 agent 自己**没有 provider 会话**(`skip_memory=True`),所以子 agent 做了什么不会直接写进记忆。取而代之,父 agent 的记忆 provider 在子 agent 完成时收到 `(task, result)` 这对观察——记忆从父 agent 的视角看待委派,而不是从子 agent 内部。

最后,所有钩子方法在 MemoryManager 里都包了 `try/except`,失败只打 debug 日志(`on_turn_start` 等)或 warning(`sync_turn`)。**一个 provider 永远不能阻塞另一个 provider,更不能阻塞主对话循环**——这是贯穿 MemoryManager 的铁律。

---

## 10.3 MemoryProvider 抽象基类

`MemoryProvider`(`agent/memory_provider.py:42`)是一个 ABC,定义了所有记忆后端必须遵守的契约。它把方法分成两组。

### 10.3.1 核心生命周期(必须实现)

```text
  is_available()          —— 配置/凭证就绪检查(纯本地,不发网络请求)
  initialize(session_id)   —— 连接、建资源、暖机、起后台线程
  system_prompt_block()    —— 系统提示里的静态文本
  prefetch(query)          —— 转折前召回
  sync_turn(user, asst)    —— 转折后异步写
  get_tool_schemas()       —— 暴露给模型的工具 schema
  handle_tool_call()       —— 分派工具调用
  shutdown()               —— 干净退出
```

`@abstractmethod` 标的有 `name`、`is_available`、`initialize`、`get_tool_schemas`(`agent/memory_provider.py:46/52/60/121`)——这四个必须实现。其余有默认实现:`system_prompt_block` 默认返回空串,`prefetch` 默认返回空串,`sync_turn` 默认 no-op。

`is_available()` 的契约值得注意(`agent/memory_provider.py:53-58`):它在 agent 初始化时被调用,决定要不要激活这个 provider,**但不允许发网络请求**——只检查配置和已装依赖。真正的连接留给 `initialize()`。这个区分让 agent 启动快:能不能用是廉价检查,真正连后端才慢。

`initialize()` 的 kwargs 契约(`agent/memory_provider.py:67-81`)也写得很细。其中 `agent_context` 这个参数尤其重要:它的值是 `"primary"`/`"subagent"`/`"cron"`/`"flush"`,文档明确要求 **provider 应该对非 primary 上下文跳过写入**——因为 cron 的系统提示会污染用户画像表征。

### 10.3.2 可选钩子(override 才生效)

10.2.6 已列出。它们都有空的默认实现,这是**向后兼容**的考虑:新增钩子不会破坏老 provider。`get_config_schema()`(`agent/memory_provider.py:227`)和 `save_config()`(`agent/memory_provider.py:245`)则服务于 `hermes memory setup` 命令行向导——provider 声明自己需要哪些配置字段(api_key、mode 等),向导据此引导用户填写。

---

## 10.4 内置文件记忆:冻结快照模式

内置记忆在 `tools/memory_tool.py`。它是**零依赖、永远可用**的——`check_memory_requirements()`(`tools/memory_tool.py:503`)直接返回 `True`。

### 10.4.1 两个文件,两种记忆

`get_memory_dir()`(`tools/memory_tool.py:55`)返回 profile 作用域的 `memories/` 目录:

```python
def get_memory_dir() -> Path:
    return get_hermes_home() / "memories"
```

注意它是**函数而非模块级常量**——注释(`tools/memory_tool.py:51-54`)解释:旧的模块级常量在 import 时被缓存,profile 切换(`HERMES_HOME` 改变)后就会指向错误目录。改成函数每次动态解析,profile 覆盖永远生效。

目录里有两个文件,语义截然不同(`tools/memory_tool.py:5-9`):

- **`MEMORY.md`** —— agent 的个人笔记。环境事实(OS、装了什么工具、项目结构)、项目约定、工具怪癖、踩过的坑。
- **`USER.md`** —— agent 对用户的画像。偏好、沟通风格、期望、工作流习惯、雷区。

memory 工具的 schema 描述(`tools/memory_tool.py:530-532`)把这个区分讲得很清楚,还给了优先级(`tools/memory_tool.py:524-525`):**用户偏好和纠正 > 环境事实 > 程序性知识**——"最有价值的记忆是让用户不必重复自己"。schema 描述还明确划清了和别的子系统的边界(`tools/memory_tool.py:526-529`):任务进度、会话结果、TODO 状态**不要**写记忆(那是 `session_search` 的事);发现了新方法,**存成技能**(那是 skill 工具的事)。

### 10.4.2 冻结快照:为什么 mid-session 写入不动系统提示

这是内置记忆最重要的设计。`MemoryStore`(`tools/memory_tool.py:107`)同时维护**两份平行状态**(`tools/memory_tool.py:112-115`):

```python
# _system_prompt_snapshot: 在 load 时冻结,用于系统提示注入,会话中绝不变动
# memory_entries / user_entries: 实时状态,被工具调用修改,持久化到磁盘
```

`load_from_disk()`(`tools/memory_tool.py:126`)在会话开始时读文件,然后**拍一张快照**:

```python
self._system_prompt_snapshot = {
    "memory": self._render_block("memory", self.memory_entries),
    "user": self._render_block("user", self.user_entries),
}
```

`format_for_system_prompt()`(`tools/memory_tool.py:358`)返回的永远是这张**冻结的快照**,不是实时状态:

```python
def format_for_system_prompt(self, target: str) -> Optional[str]:
    """返回冻结快照用于系统提示注入。
    返回的是 load_from_disk() 时刻的状态,不是实时状态。
    会话中的写入不影响这里。系统提示在所有 turn 上保持稳定,保住前缀缓存。"""
    block = self._system_prompt_snapshot.get(target, "")
    return block if block else None
```

为什么这么设计?核心是 **prompt 前缀缓存**。LLM provider 对相同前缀的 token 提供缓存折扣。如果记忆写入会实时改写系统提示,那么每次 agent 在会话中调用一次 `memory` 工具,整个系统提示就变了,前缀缓存全部失效,后续每一轮都要按全价重算系统提示的 token。

冻结快照模式打破了这个困境:

<svg viewBox="0 0 780 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Frozen-snapshot model: mid-session writes hit disk but never change the system prompt">
  <defs>
    <marker id="r10ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="30" y="20" width="240" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="150" y="38" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">会话开始 ── load_from_disk()</text>
  <text x="150" y="53" font-size="10" fill="#64748b" text-anchor="middle">拍快照</text>
  <line x1="270" y1="40" x2="320" y2="40" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar3)"/>
  <rect x="322" y="20" width="430" height="40" rx="6" fill="#0d9488" fill-opacity="0.15" stroke="#0d9488"/>
  <text x="537" y="44" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">系统提示用快照 → 整个会话稳定不变（保住前缀缓存）</text>
  <line x1="150" y1="60" x2="150" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar3)"/>
  <rect x="30" y="88" width="280" height="40" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="170" y="112" font-size="11" fill="currentColor" text-anchor="middle">turn 1: memory.add(…)</text>
  <rect x="30" y="138" width="280" height="40" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="170" y="162" font-size="11" fill="currentColor" text-anchor="middle">turn 2: memory.replace(…)</text>
  <line x1="310" y1="108" x2="358" y2="108" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar3)"/>
  <line x1="310" y1="158" x2="358" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar3)"/>
  <rect x="360" y="88" width="170" height="90" rx="8" fill="#99f6e4" stroke="#0d9488"/>
  <text x="445" y="128" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">写磁盘</text>
  <text x="445" y="146" font-size="10" fill="#64748b" text-anchor="middle">立即持久</text>
  <line x1="530" y1="133" x2="578" y2="133" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar3)"/>
  <rect x="580" y="88" width="170" height="90" rx="8" fill="#0ea5e9" fill-opacity="0.12" stroke="#0ea5e9"/>
  <text x="665" y="128" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">工具响应</text>
  <text x="665" y="146" font-size="10" fill="#64748b" text-anchor="middle">显示实时状态</text>
  <line x1="445" y1="178" x2="445" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar3)"/>
  <text x="455" y="200" font-size="10" fill="#64748b">会话结束</text>
  <rect x="200" y="212" width="490" height="44" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="445" y="232" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">下次会话开始 ── load_from_disk()</text>
  <text x="445" y="248" font-size="10" fill="#64748b" text-anchor="middle">快照刷新（包含本次所有写入）</text>
</svg>
<span class="figure-caption">图 R10.3 ｜ 冻结快照模式：会话中写入立即落盘并经工具响应反馈给模型，但系统提示始终用启动时的快照，下次会话才刷新。</span>

<details>
<summary>ASCII 原版</summary>

```text
会话开始 ── load_from_disk() ── 拍快照 ──┐
                                        │  系统提示用快照 → 整个会话稳定不变
  turn 1: memory.add(...) ──▶ 写磁盘(立即持久) ──▶ 工具响应显示实时状态
  turn 2: memory.replace(...) ─▶ 写磁盘 ──────────▶ 工具响应显示实时状态
                                        │
会话结束                                ▼
下次会话开始 ── load_from_disk() ── 快照刷新(包含本次所有写入)
```

</details>

会话中的写入**立即落盘**(持久、不丢),但**不改系统提示**——它们通过**工具响应**反映给模型。`_success_response()`(`tools/memory_tool.py:373`)在每次 add/replace/remove 后返回完整的 `entries` 列表和 `usage` 占用比。所以模型在会话中拥有"实时记忆视图"(通过工具响应),而系统提示保持"冻结视图"(保住缓存)。快照在下次会话启动时自然刷新,把这次的所有写入纳入。

### 10.4.3 `§` 入口分隔符与字符上限

记忆文件是纯文本,多条记忆用 `§`(section sign)分隔。`ENTRY_DELIMITER`(`tools/memory_tool.py:59`)实际是 `"\n§\n"`——首尾带换行,确保不会和正文里出现的 `§` 混淆。`_read_file()`(`tools/memory_tool.py:408`)读文件时用完整的 `ENTRY_DELIMITER` 切分,注释(`tools/memory_tool.py:425-426`)特意说明:只按 `§` 切会错误地切碎正文里含 `§` 的条目。

记忆有**字符上限**而非 token 上限(`MemoryStore.__init__`,`tools/memory_tool.py:118`):默认 `memory` 2200 字符、`user` 1375 字符。注释(`tools/memory_tool.py:18`)解释:用字符数因为它与模型无关——token 数随分词器变化,字符数则是确定的。`add()`(`tools/memory_tool.py:221`)在写入前会算"加上这条会不会超限",超了就拒绝并提示"先 replace 或 remove 现有条目"。这个有界性是有意的:记忆不是日志,它强迫 agent 持续做"什么值得留"的取舍。

### 10.4.4 单工具多 action 与子串匹配

记忆只暴露**一个工具** `memory`(`MEMORY_SCHEMA`,`tools/memory_tool.py:512`),用 `action` 参数区分 add / replace / remove。这是有意的极简——少一个工具就少一份 schema token,模型也更不容易混淆。

`replace` 和 `remove` **不用 ID、不用全文匹配,而是用短的唯一子串匹配**(`tools/memory_tool.py:284`、`:334`)。模型只要给一段足以唯一定位某条记忆的子串即可。如果子串匹配到多条且它们内容不同,工具会拒绝并返回各条预览,要求模型"说得更具体"(`tools/memory_tool.py:289-298`);如果匹配到的多条**完全相同**(精确重复),则安全地操作第一条。这个设计的好处:模型不需要记住或复述完整记忆内容,也不需要维护 ID 体系。

### 10.4.5 并发安全:文件锁 + 原子替换

记忆文件可能被多个会话(多个进程)同时读写。`MemoryStore` 用两套机制保证安全:

1. **写时文件锁**。`_file_lock()`(`tools/memory_tool.py:145`)用一个独立的 `.lock` 文件加排他锁(Unix 用 `fcntl`,Windows 用 `msvcrt`)。注意它锁的是 `.lock` 而非记忆文件本身——这样记忆文件还能被原子替换。每次 add/replace/remove 都在锁内先 `_reload_target()`(`tools/memory_tool.py:185`)从磁盘重读,拿到其他会话的最新写入,再做修改。这是经典的"锁内 read-modify-write"。

2. **原子写**。`_write_file()`(`tools/memory_tool.py:430`)写临时文件 + `os.fsync` + 原子 rename。注释(`tools/memory_tool.py:433-438`)解释为什么不能用 `open("w")`:`"w"` 在拿到锁**之前**就截断文件,产生一个竞态窗口——并发的读者会看到空文件。原子 rename 消除这个窗口:读者永远看到"旧的完整文件"或"新的完整文件"。正因为写是原子的,`_read_file()` 才能不加锁(`tools/memory_tool.py:411-413`)。

### 10.4.6 注入/泄漏扫描:记忆是攻击面

记忆内容会被注入系统提示,所以它是一个**攻击面**。如果一条恶意记忆写进去,它就在每个会话里影响模型。`_scan_memory_content()`(`tools/memory_tool.py:92`)在 `add` 和 `replace` 接受内容之前做轻量扫描:

```python
_MEMORY_THREAT_PATTERNS = [
    (r'ignore\s+(previous|all|above|prior)\s+instructions', "prompt_injection"),
    (r'you\s+are\s+now\s+', "role_hijack"),
    (r'do\s+not\s+tell\s+the\s+user', "deception_hide"),
    (r'curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|...)', "exfil_curl"),
    (r'cat\s+[^\n]*(\.env|credentials|\.netrc|...)', "read_secrets"),
    (r'authorized_keys', "ssh_backdoor"),
    ...
]
```

它检测三类威胁:**提示注入**(覆盖指令、角色劫持、要求对用户隐瞒)、**凭证外泄**(用 curl/wget 带 secret、cat 读 `.env`)、**持久化后门**(写 `authorized_keys`、动 `~/.ssh`)。还检测一组**不可见 unicode 字符**(`_INVISIBLE_CHARS`,`tools/memory_tool.py:86`)——零宽空格、双向覆盖字符等常被用来藏注入载荷。命中任何一项,写入被拒绝并返回明确错误(`tools/memory_tool.py:101-102`)。

---

## 10.5 记忆 nudge:周期性提醒

### 10.5.1 问题:模型会"忘记"主动存记忆

memory 工具的 schema 描述里反复强调"主动存,别等人要求"(`tools/memory_tool.py:518`)。但实践中,模型在一段长对话里会**沉浸于任务本身**,即使发生了值得记的事(用户纠正了它、透露了偏好),它也常常忘记调用 `memory` 工具。schema 描述是静态的,提醒力度会随对话变长而衰减。

解决办法是 **nudge**——对话循环周期性地、主动地提醒模型"该回顾一下要不要更新记忆了"。

### 10.5.2 turn 计数与触发

nudge 逻辑在 `agent/conversation_loop.py`。两个字段(`AIAgent` 上)驱动它:

- `_memory_nudge_interval` —— 每隔多少个用户 turn nudge 一次(0 表示禁用)。
- `_turns_since_memory` —— 距上次 nudge 过了几个 turn。

核心触发在 `conversation_loop.py:286-292`:

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

每个用户 turn 把计数器 +1;到达阈值就置 `_should_review_memory = True` 并清零计数器。当这个标志为真,对话循环会在本轮往模型那里注入一段"回顾记忆"的提醒。注意三个前置条件:nudge 间隔 > 0、`memory` 工具确实可用、`_memory_store` 存在——任一不满足就不 nudge。

### 10.5.3 网关场景的计数器水合

有一个棘手的边界:**网关每条入站消息都新建一个 `AIAgent`**(缓存未命中、1 小时空闲驱逐、配置签名不匹配、进程重启都会触发)。新建的 agent 里 `_turns_since_memory` 和 `_user_turn_count` 都从 0 开始,于是 `memory.nudge_interval` 触发器**永远到不了阈值**——nudge 实际上失效了(见注释 `conversation_loop.py:238-245`,issue #22357)。

修复方式是**从持久化的对话历史里水合计数器**(`conversation_loop.py:246-256`):

```python
if conversation_history and agent._user_turn_count == 0:
    prior_user_turns = sum(
        1 for m in conversation_history if m.get("role") == "user"
    )
    if prior_user_turns > 0:
        agent._user_turn_count = prior_user_turns
        if agent._memory_nudge_interval > 0 and agent._turns_since_memory == 0:
            # 用取模保留原本 1-in-N 的节奏,而不是 resume 后立刻触发
            agent._turns_since_memory = prior_user_turns % agent._memory_nudge_interval
```

它数对话历史里有多少个 user 消息,反推出一个等效计数。用 `%` 取模(`conversation_loop.py:253-256`)是为了**保留原本的 1-in-N 节奏**——直接把计数设成 `prior_user_turns` 会导致 resume 后立刻 nudge 一次,让恰好落在 N 的倍数附近的用户被打扰。这个水合是幂等的:已经累积了计数的缓存 agent 保留自己的计数,只有刚建好、内存状态为空的 agent 才水合。

值得一提的是,`_turns_since_memory` 和技能的 `_iters_since_skill` 在 `run_conversation` 之间**不重置**(`conversation_loop.py:212-214`)——它们在 `__init__` 里初始化,必须跨多次 `run_conversation` 调用累积,这样 CLI 模式下的 nudge 节奏才正确。

---

## 10.6 记忆 provider 插件

外部记忆 provider 以插件形式发布在 `plugins/memory/<name>/`。截至本 commit,内置的 provider 目录有:`byterover`、`hindsight`、`holographic`、`honcho`、`mem0`、`openviking`、`retaindb`、`supermemory`。

### 10.6.1 发现机制

发现逻辑在 `plugins/memory/__init__.py`。`_iter_provider_dirs()`(`plugins/memory/__init__.py:67`)扫两个目录:

```python
def _iter_provider_dirs() -> List[Tuple[str, Path]]:
    seen: set = set()
    dirs: List[Tuple[str, Path]] = []

    # 1. 内置 provider (plugins/memory/<name>/)
    if _MEMORY_PLUGINS_DIR.is_dir():
        for child in sorted(_MEMORY_PLUGINS_DIR.iterdir()):
            if not child.is_dir() or child.name.startswith(("_", ".")):
                continue
            if not (child / "__init__.py").exists():
                continue
            seen.add(child.name)
            dirs.append((child.name, child))

    # 2. 用户安装的 provider ($HERMES_HOME/plugins/<name>/)
    user_dir = _get_user_plugins_dir()
    if user_dir:
        for child in sorted(user_dir.iterdir()):
            ...
            if child.name in seen:
                continue  # 内置优先
            if not _is_memory_provider_dir(child):
                continue  # 跳过非记忆插件
            dirs.append((child.name, child))
    return dirs
```

两条规则:**内置先扫,内置优先**(名字撞车时 `seen` 集合让先扫到的赢);用户目录里要靠 `_is_memory_provider_dir()`(`plugins/memory/__init__.py:51`)区分——它做一次廉价的文本扫描,看 `__init__.py` 源码里有没有 `register_memory_provider` 或 `MemoryProvider` 字样,免得把别的插件误判成记忆 provider。

### 10.6.2 激活:只能有一个

虽然能"发现"多个 provider,**激活的只有一个**——由 `config.yaml` 的 `memory.provider` 键选定。`_get_active_memory_provider()`(`plugins/memory/__init__.py:308`)读这个键。`load_memory_provider(name)`(`plugins/memory/__init__.py:160`)按名字加载:`find_provider_dir()` 先查内置再查用户目录,`_load_provider_from_dir()`(`plugins/memory/__init__.py:185`)负责把模块 import 进来并提取出 `MemoryProvider` 实例。

`_load_provider_from_dir()` 支持两种插件写法:有 `register(ctx)` 函数的(插件式,用一个假的 `_ProviderCollector` 上下文捕获 `register_memory_provider` 调用)、或有顶层 `MemoryProvider` 子类的(直接实例化)。它还小心地用独立命名空间隔离用户插件(`module_name = "_hermes_user_memory.{name}"`,`plugins/memory/__init__.py:196`),避免和内置 provider 在 `sys.modules` 里撞名。

激活后的 provider 通过 `MemoryManager.add_provider()` 注册——而 10.2.2 讲过,MemoryManager 强制至多一个外部 provider,和这里"`memory.provider` 只能填一个"在两层各自把关。

### 10.6.3 几个代表性 provider

虽然各 provider 的实现细节超出本章范围,值得知道它们各自补强了内置记忆的哪一块短板:

- **honcho** —— **辩证式(dialectic)用户建模**。内置 `USER.md` 是 agent 自己写的扁平笔记;honcho 在后台对对话做持续的用户表征推理,能回答"这个用户在这种情况下倾向于怎样"这类需要推断的问题,而不只是检索写死的事实。
- **hindsight** —— 事后回顾式记忆,从会话历史里抽取经验。
- **mem0** —— 通用语义记忆层,向量检索召回。
- **supermemory** —— 托管的记忆服务后端。

内置文件记忆的强项是**确定性、零依赖、可被用户直接 `cat` 查看和手改**;外部 provider 的强项是**语义检索和推理式建模**。`memory.provider` 让用户按需选其一。

---

## 10.7 学习闭环全景

记忆系统不是孤立的。它是 Hermes "自我改进"叙事的一块拼图。把四块放在一起看:

<svg viewBox="0 0 780 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="The learning loop: four subsystems each handling one class of information">
  <defs>
    <marker id="r10ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="290" y="14" width="200" height="34" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="390" y="35" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">一次会话发生的事</text>
  <line x1="390" y1="48" x2="110" y2="74" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar4)"/>
  <line x1="390" y1="48" x2="297" y2="74" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar4)"/>
  <line x1="390" y1="48" x2="483" y2="74" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar4)"/>
  <line x1="390" y1="48" x2="670" y2="74" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar4)"/>
  <text x="110" y="92" font-size="11" font-weight="600" fill="#64748b" text-anchor="middle">稳定事实</text>
  <text x="297" y="92" font-size="11" font-weight="600" fill="#64748b" text-anchor="middle">一次性经验</text>
  <text x="483" y="92" font-size="11" font-weight="600" fill="#64748b" text-anchor="middle">完整 transcript</text>
  <text x="670" y="92" font-size="11" font-weight="600" fill="#64748b" text-anchor="middle">技能演化</text>
  <line x1="110" y1="100" x2="110" y2="116" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar4)"/>
  <line x1="297" y1="100" x2="297" y2="116" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar4)"/>
  <line x1="483" y1="100" x2="483" y2="116" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar4)"/>
  <line x1="670" y1="100" x2="670" y2="116" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r10ar4)"/>
  <rect x="30" y="118" width="160" height="92" rx="10" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="110" y="142" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">记忆</text>
  <text x="110" y="164" font-size="10" fill="#64748b" text-anchor="middle">MEMORY.md / USER.md</text>
  <text x="110" y="182" font-size="10" fill="#64748b" text-anchor="middle">冻结快照注入</text>
  <text x="110" y="198" font-size="10" fill="#64748b" text-anchor="middle">周期 nudge 提醒</text>
  <rect x="217" y="118" width="160" height="92" rx="10" fill="#99f6e4" stroke="#0d9488"/>
  <text x="297" y="142" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">技能自创建</text>
  <text x="297" y="164" font-size="10" fill="#64748b" text-anchor="middle">skill_manage</text>
  <text x="297" y="182" font-size="10" fill="#64748b" text-anchor="middle">沉淀成技能目录</text>
  <text x="297" y="198" font-size="10" fill="#64748b" text-anchor="middle">程序性记忆</text>
  <rect x="403" y="118" width="160" height="92" rx="10" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="483" y="142" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">session_search</text>
  <text x="483" y="164" font-size="10" fill="#64748b" text-anchor="middle">检索过往会话</text>
  <text x="483" y="182" font-size="10" fill="#64748b" text-anchor="middle">transcript</text>
  <text x="483" y="198" font-size="10" fill="#64748b" text-anchor="middle">FTS5 全文索引</text>
  <rect x="590" y="118" width="160" height="92" rx="10" fill="#0ea5e9" fill-opacity="0.12" stroke="#0ea5e9"/>
  <text x="670" y="142" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">后台 Curator</text>
  <text x="670" y="164" font-size="10" fill="#64748b" text-anchor="middle">周期审查技能</text>
  <text x="670" y="182" font-size="10" fill="#64748b" text-anchor="middle">归并 / 归档</text>
  <text x="670" y="198" font-size="10" fill="#64748b" text-anchor="middle">防技能库退化</text>
  <rect x="150" y="270" width="480" height="44" rx="8" fill="#16a34a" fill-opacity="0.1" stroke="#16a34a"/>
  <text x="390" y="297" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">下个会话：都被注入 / 可被检索 → 比上个会话更聪明</text>
  <path d="M110,210 C110,250 130,270 200,278" fill="none" stroke="#16a34a" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r10ar4)"/>
  <path d="M670,210 C670,250 650,270 580,278" fill="none" stroke="#16a34a" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r10ar4)"/>
</svg>
<span class="figure-caption">图 R10.4 ｜ 学习闭环全景：四个子系统各管一类信息，下个会话都被注入或可被检索，构成"自我改进"。</span>

<details>
<summary>ASCII 原版</summary>

```text
              一次会话发生的事
                    │
   ┌────────────────┼────────────────────┬──────────────────┐
   ▼                ▼                    ▼                  ▼
 稳定事实         一次性经验           完整 transcript      技能演化
   │                │                    │                  │
   ▼                ▼                    ▼                  ▼
┌────────┐   ┌──────────────┐   ┌────────────────┐   ┌──────────────┐
│ 记忆    │   │ 技能自创建    │   │ session_search │   │ 后台 Curator  │
│MEMORY/ │   │ skill_manage  │   │ 检索过往会话    │   │ 周期审查技能  │
│USER.md │   │ 沉淀成技能    │   │ transcript     │   │ 归并/归档    │
└────────┘   └──────────────┘   └────────────────┘   └──────────────┘
   ▲                                                         │
   └─────────────── 下个会话:都被注入/可被检索 ◀─────────────┘
```

</details>

四块各管一类信息,边界清晰(memory 工具的 schema 描述 `tools/memory_tool.py:526-529` 明确划过):

1. **记忆(本章)** 管**稳定的、会反复用到的事实**——环境约定、用户画像。冻结快照注入,周期 nudge 提醒补写。
2. **技能自创建(第 11 章)** 管**程序性知识**——"我发现了一种做某事的新方法"。agent 用 `skill_manage` 把一次性经验沉淀成可复用的技能目录。这是"声明性记忆"之外的"程序性记忆"。
3. **session_search** 管**完整对话 transcript**——任务进度、会话结果、做过的工作。这些**不该**进记忆(太多、太易过时),需要时从过往 transcript 检索。
4. **后台 Curator(第 11 章)** 管**技能集合的演化**——周期性审查 agent 创建的技能,把碎片化的窄技能归并成"伞形"的类级技能,把陈旧的归档。它防止技能库随时间退化成"几百个一次性技能"的垃圾堆。

把这四块连起来,"自我改进"就有了具体含义:agent **从经验中创建技能**(技能自创建),**在使用中改进它们**(curator 归并),**跨会话构建用户模型**(记忆 provider),并且能**回看自己做过什么**(session_search)。每一类信息都有一个专门的子系统,各自有专门的注入/检索通道,共同让下一个会话比上一个会话更聪明。

记忆系统在这个全景里的位置很明确:它是**声明性、长期、有界**的那一层——它不存"做了什么",存"是什么";它不无限增长,它强迫取舍;它在每个会话开始时无条件被注入,确保 agent 永远以"知道你是谁、知道这台机器长什么样"的状态开局。

---

## 延伸阅读

- [第 11 章 技能系统与 Curator](./11-skills-and-curator.md) —— 程序性记忆如何沉淀,后台 Curator 如何维护技能库
- [第 12 章 MCP 集成与插件系统](./12-mcp-and-plugins.md) —— 记忆 provider 插件所属的更广插件体系
