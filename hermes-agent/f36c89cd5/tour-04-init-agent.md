# Trace 步骤 04 —— 创建 AIAgent

## 1. 当前情境

上一步结束时，`HermesCLI` 实例化完成，`cli.config`（即 `CLI_CONFIG` 字典）就位，`HERMES_HOME`、`session_id` 都已确定。但 `cli.agent` 仍是 `None`——刚才的 `HermesCLI.__init__` 在 `cli.py:4332` 把它显式置空，留到「第一次真正需要时」再造。

这一步要回答的是：那个真正干活的核心对象 `AIAgent` 是怎么被造出来的？它的构造函数收了约 60 个参数，又把这些参数交给谁、做了哪些一次性的初始化。

## 2. 问题

`AIAgent` 是 Hermes 的发动机——对话循环、工具调度、Provider 调用、上下文管理全在它身上。要让它能跑，构造时必须一次性把一大堆相互关联的子系统装配到位：

- **Provider 解析**：用户给的 `model`/`provider`/`base_url` 可能不完整（只给了模型名没给 provider），需要从中推断出该用哪家推理后端、哪种 API 协议（OpenAI chat-completions？Anthropic messages？Codex responses？）。
- **工具集启停**：要根据 `enabled_toolsets`/`disabled_toolsets` 算出这个 agent 实际能用哪些工具，并拿到它们的 schema。
- **会话存储**：`SessionDB`（SQLite）连接要建立，消息才能落盘。
- **记忆管理**：长期记忆 provider 要初始化（若用户启用）。
- **checkpoint**：若开了 `--checkpoints`，破坏性文件操作前要能打快照。
- **迭代预算**：一次对话里工具调用不能无限循环，需要一个计数器。

利害关系：这些东西彼此有依赖（记忆要拿到 `session_db`、工具 schema 要拿到 `enabled_toolsets`），构造顺序错了就拿到 `None`；而且它们多到一个构造函数根本塞不下。

## 3. 朴素思路

最直觉的做法：把所有初始化逻辑直接写进 `AIAgent.__init__`。构造函数收下 60 个参数，函数体里挨个 `self.xxx = ...`，该建连接建连接、该解析 provider 解析 provider，一路写到底。

需要时 `cli` 直接 `self.agent = AIAgent(model=..., provider=..., ...)`，把 `HermesCLI` 上对应的字段一一对上。

## 4. 为什么朴素思路会崩

参数本身不是问题——60 个参数确实就是这台发动机要的输入。崩的是「把 1400 行初始化逻辑塞进 `__init__`」这件事：

- **`run_agent.py` 被撑爆**。`AIAgent.__init__` 的函数体是全代码库最长的方法之一——provider 自动探测、凭证解析、上下文引擎 bootstrap、工具装配……约 1400 行。这些代码大多是「设好状态然后就不再看」的一次性逻辑，塞在 `run_agent.py` 里会把这个本该聚焦「对话循环」的核心文件淹没。
- **`cli` 与 `agent` 的参数对接易漂移**。`HermesCLI` 上有 `self.reasoning_config`、`self._credential_pool`、`self.checkpoint_max_snapshots`…… 几十个字段要喂给 `AIAgent`。如果 `cli` 在调用点散着 `AIAgent(a=self.a, b=self.b, ...)` 手写，每加一个能力就要在调用点和构造函数两头改，迟早对不齐。
- **测试无法 patch**。测试常常要把 `run_agent.OpenAI`、`run_agent.cleanup_vm` 等符号 patch 掉。如果初始化逻辑深埋在 `__init__` 里、又混着大量 import，patch 点会变得脆弱。

核心矛盾：`AIAgent` 需要 60 个参数 + 1400 行初始化，这是本质复杂度；但「构造函数」这个位置承载不了它——**接口（`__init__`）和实现（初始化逻辑）必须分开**。

## 5. Hermes 的做法

Hermes 用三个动作化解：`HermesCLI` 侧的**惰性单点构造**、`AIAgent.__init__` 的**转发器化**、初始化逻辑**抽成独立模块函数 `init_agent`**。

### HermesCLI._init_agent —— 惰性、单点

`HermesCLI` 不在 `__init__` 里造 agent，而是给一个 `_init_agent()` 方法（`cli.py:4381`），第一次真正要用时才调，且自带幂等：

```python
# cli.py:4381
def _init_agent(self, *, model_override=None, runtime_override=None, request_overrides=None) -> bool:
    if self.agent is not None:
        return True
    if not self._ensure_runtime_credentials():
        return False
    # Initialize SQLite session store for CLI sessions
    if self._session_db is None:
        try:
            from hermes_state import SessionDB
            self._session_db = SessionDB()
        except Exception as e:
            logger.warning("SQLite session store not available ...: %s", e)
```

`SessionDB` 连接就在这里建立（`cli.py:4399`）。如果是 `--resume` 一个旧会话，`_init_agent` 还会在造 agent 之前先从 SQLite 把历史消息读回 `conversation_history`（`cli.py:4407` 起）。然后，它把 `HermesCLI` 上散落的几十个字段**集中在一处**喂给 `AIAgent`：

```python
# cli.py:4469
self.agent = AIAgent(
    model=effective_model,
    api_key=runtime.get("api_key"),
    base_url=runtime.get("base_url"),
    provider=runtime.get("provider"),
    ...
    max_iterations=self.max_turns,
    enabled_toolsets=self.enabled_toolsets,
    disabled_toolsets=self.disabled_toolsets,
    session_id=self.session_id,
    platform="cli",
    session_db=self._session_db,
    checkpoints_enabled=self.checkpoints_enabled,
    skip_context_files=self.ignore_rules,
    skip_memory=self.ignore_rules,
    ...
)
```

「`cli` → `agent` 的参数对接」只出现在这**一个调用点**，要审、要改都只看这里。

### AIAgent.__init__ —— 转发器

`AIAgent.__init__`（`run_agent.py:349`）声明了那 60 个参数，但函数体几乎是空的——它只做一件事：转发。

```python
# run_agent.py:415
    ):
        """Forwarder — see ``agent.agent_init.init_agent``."""
        from agent.agent_init import init_agent
        init_agent(
            self,
            base_url=base_url,
            api_key=api_key,
            provider=provider,
            ...
        )
```

`AIAgent` 这个类的「接口」（构造签名）留在 `run_agent.py`，而「实现」（1400 行初始化）搬去了 `agent/agent_init.py`。`agent_init.py` 开头的 docstring 把这个决定写得很直白：`__init__` 是全代码库最长的方法之一，「把它留在 `run_agent.py` 里会用大多是『设好状态就忘掉』的代码把那个文件撑爆」。它还提供 `_ra()`（`agent_init.py:65`）惰性引用回 `run_agent`，让测试 patch `run_agent.OpenAI` 之类的契约依然成立。

### init_agent —— 真正的初始化

`init_agent(agent, ...)`（`agent/agent_init.py:74`）在传入的 `agent` 对象上逐项装配。沿调用顺序看几个关键步骤：

**迭代预算**。最早被建好的之一：

```python
# agent/agent_init.py:195
agent.iteration_budget = iteration_budget or IterationBudget(max_iterations)
```

`IterationBudget`（`agent/iteration_budget.py:17`）是个线程安全的消费/退款计数器。父 agent 的上限是 `max_iterations`（默认 90），子 agent 各自独立、上限来自 `delegation.max_iterations`（默认 50）。它是「想 → 调工具 → 再想」这个循环不会失控的刹车——每个 LLM 轮次 `consume()` 一次，耗尽就停。

**Provider 解析**。`init_agent` 把 `provider` 规范化成小写（`agent_init.py:223`），然后一连串判断从 `provider` 名或 `base_url` 主机名推断出真实后端与 API 协议（`agent_init.py:227` 起）：base URL 是 `api.anthropic.com` → `provider="anthropic"`；是 `api.x.ai` → `xai`；据此还决定 `api_mode` 是 chat-completions 还是 anthropic-messages 还是 codex-responses。用户只给一半信息，这里补全另一半。

**工具集装配**。`init_agent` 调 `get_tool_definitions` 拿到这个 agent 实际可见的工具 schema 列表：

```python
# agent/agent_init.py:802
agent.tools = _ra().get_tool_definitions(
    enabled_toolsets=enabled_toolsets,
    disabled_toolsets=disabled_toolsets,
    ...
)
```

注意：此处 `get_tool_definitions` 能返回东西，前提是工具**注册表**已经装满——那是下一步（步骤 05）的 `discover_builtin_tools` 干的活，发生在 `model_tools` 模块导入时。这里只是「按 toolset 过滤注册表、取出 schema」。

**SessionDB 与 checkpoint**。`agent._session_db = session_db`（`agent_init.py:898`）接住 `HermesCLI` 传来的连接（注意 DB 行的写入推迟到 `run_conversation()`，`agent_init.py:901`）；`CheckpointManager`（`agent_init.py:889`）按 `checkpoints_enabled` 等参数建好——它是个透明组件，不作为工具暴露给模型。

**记忆管理器**。`agent._memory_manager` 先置 `None`（`agent_init.py:958`），仅当用户配置了记忆 provider 才实例化 `MemoryManager`、`add_provider`、`initialize_all`（`agent_init.py:964` 起）；记忆工具的 schema 随后并进 `agent.tools`（`agent_init.py:1025`）。

<svg viewBox="0 0 780 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="AIAgent initialization call chain and init_agent steps">
  <defs>
    <marker id="t4ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="170" y="14" width="440" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="390" y="34" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">HermesCLI._init_agent() ── 惰性、幂等、单一调用点</text>
  <text x="390" y="51" text-anchor="middle" font-size="10" fill="#64748b">建 SessionDB 连接（--resume 时先读回历史）</text>
  <path d="M390,62 L390,80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t4ar)"/>
  <rect x="170" y="82" width="440" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="390" y="102" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">AIAgent.__init__(60 个参数) ── 纯转发器</text>
  <text x="390" y="118" text-anchor="middle" font-size="10" fill="#64748b">from agent.agent_init import init_agent</text>
  <path d="M390,126 L390,144" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t4ar)"/>
  <rect x="120" y="146" width="540" height="234" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="390" y="168" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">init_agent(agent, …) ── 1400 行实现，独立模块</text>
  <g font-size="10">
    <rect x="146" y="180" width="488" height="28" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="160" y="198" fill="currentColor">IterationBudget(max_iterations)</text>
    <text x="624" y="198" text-anchor="end" fill="#64748b">刹车计数器</text>
    <rect x="146" y="212" width="488" height="28" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="160" y="230" fill="currentColor">provider / api_mode 解析</text>
    <text x="624" y="230" text-anchor="end" fill="#64748b">补全后端与协议</text>
    <rect x="146" y="244" width="488" height="28" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="160" y="262" fill="currentColor">get_tool_definitions(enabled_toolsets)</text>
    <text x="624" y="262" text-anchor="end" fill="#64748b">取工具 schema</text>
    <rect x="146" y="276" width="488" height="28" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="160" y="294" fill="currentColor">agent._session_db = session_db</text>
    <text x="624" y="294" text-anchor="end" fill="#64748b">接住 SQLite 连接</text>
    <rect x="146" y="308" width="488" height="28" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="160" y="326" fill="currentColor">CheckpointManager(…)</text>
    <text x="624" y="326" text-anchor="end" fill="#64748b">透明快照组件</text>
    <rect x="146" y="340" width="488" height="28" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="160" y="358" fill="currentColor">MemoryManager（若启用）</text>
    <text x="624" y="358" text-anchor="end" fill="#64748b">长期记忆</text>
  </g>
</svg>
<span class="figure-caption">图 T4.1 ｜ AIAgent 初始化调用链：_init_agent 建连接、__init__ 纯转发、init_agent 六步装配预算/provider/工具/DB/checkpoint/记忆。</span>

<details>
<summary>ASCII 原版</summary>

```text
   HermesCLI._init_agent()           ← 惰性、幂等、单一调用点
        │  建 SessionDB 连接
        │  （--resume 时先读回历史）
        ▼
   AIAgent.__init__(60 个参数)        ← 纯转发器，函数体只有一句
        │  from agent.agent_init import init_agent
        ▼
   init_agent(agent, ...)            ← 1400 行实现，独立模块
        ├─ IterationBudget(max_iterations)      刹车计数器
        ├─ provider / api_mode 解析              补全后端与协议
        ├─ get_tool_definitions(enabled_toolsets) 取工具 schema
        ├─ agent._session_db = session_db        接住 SQLite 连接
        ├─ CheckpointManager(...)                透明快照组件
        └─ MemoryManager（若启用）               长期记忆
```

</details>

到这一步结束，`AIAgent` 实例化完成，`SessionDB` 连接已建立，provider/api_mode 已解析，`agent.tools` 已填好一份 schema 列表。但**工具注册表**是上一段被动用到的——它本身怎么被装满，是下一步的事；系统提示也还没拼。

## 6. 代码位置

按阅读顺序：

- 惰性构造入口：`cli.py:4381` —— `def _init_agent`；`cli.py:4389` 幂等检查；`cli.py:4399` 建 `SessionDB`。
- `--resume` 历史回读：`cli.py:4407-4456`。
- 单一调用点：`cli.py:4469` —— `self.agent = AIAgent(...)`。
- 转发器：`run_agent.py:326` `class AIAgent`；`run_agent.py:349` `def __init__`；`run_agent.py:417-418` 转发给 `init_agent`。
- 初始化实现：`agent/agent_init.py:74` —— `def init_agent(agent, ...)`；模块 docstring `agent_init.py:1-18` 解释抽取动机；`_ra()` 在 `agent_init.py:65`。
- 迭代预算：`agent/agent_init.py:195`；`IterationBudget` 类在 `agent/iteration_budget.py:17`。
- provider/api_mode 解析：`agent/agent_init.py:223-318`。
- 工具 schema 装配：`agent/agent_init.py:802`。
- SessionDB / checkpoint / 记忆：`agent_init.py:898`、`agent_init.py:889`、`agent_init.py:958-1031`。

## 7. 分支与延伸

- `agent.tools` 能拿到东西，靠的是工具注册表已被 `discover_builtin_tools` 装满 → 见 [Trace 步骤 05](tour-05-tool-discovery.md)。
- 上一步 `HermesCLI` 与配置如何就位 → [Trace 步骤 03](tour-03-cli-construct.md)。
- `AIAgent` 装好后如何驱动「想 → 调工具 → 再想」的对话循环、`IterationBudget` 在循环里怎么被消费 → [第 3 章 核心对话循环](03-conversation-loop.md)。
- `SessionDB` 的表结构、消息何时真正落盘、压缩链如何 resolve → [第 9 章 会话存储](09-session-storage.md)。
- provider/api_mode 解析背后的 Provider 适配层、凭证池 → [第 3 章 核心对话循环](03-conversation-loop.md)。

## 8. 走完这一步你脑子里应该多了什么

1. `HermesCLI` 不在 `__init__` 里造 agent——`_init_agent()` 是**惰性 + 幂等**的，第一次真正要用时才造，且「`cli` → `agent` 的 60 个参数对接」只出现在**一个调用点**，避免漂移。
2. `AIAgent.__init__` 是一个**纯转发器**：接口（60 个参数的签名）留在 `run_agent.py`，1400 行实现搬到独立模块 `agent/agent_init.py` 的 `init_agent` 函数——这是「接口与实现分离」对付超长构造函数的标准手法。
3. `init_agent` 一次性装配了所有子系统：`IterationBudget`（工具循环的刹车）、provider/api_mode 解析（补全用户没给全的后端信息）、工具 schema 过滤、`SessionDB` 连接接管、`CheckpointManager`、`MemoryManager`。
4. `init_agent` 里 `get_tool_definitions` 之所以能返回工具，是因为工具**注册表**已在别处被装满——构造 agent 只是「按 toolset 过滤已注册的工具」，注册本身是下一步的事。
5. 走完这一步，`AIAgent` 实例和 `SessionDB` 连接就位，但系统提示还没拼、消息列表还空着。

---

下一步：[Trace 步骤 05 —— 工具自动发现](tour-05-tool-discovery.md)
