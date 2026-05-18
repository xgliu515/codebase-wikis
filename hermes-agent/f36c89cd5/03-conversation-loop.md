# 第 3 章 核心对话循环

第 2 章把入口层讲完了——所有前端最终都会构造一个 `AIAgent` 并调用它的对话接口。本章进入第二层：**Agent 核心**。这是整个项目的心脏，一个完全同步的工具调用 `while` 循环。

本章回答四个问题：`AIAgent` 这个类装了什么、它的两个公开接口（`chat()` 与 `run_conversation()`）有何区别、那个核心 `while` 循环逐阶段在做什么、以及为什么这个循环刻意做成同步而非异步。

代码版本：`NousResearch/hermes-agent@f36c89cd5`。

---

## 3.1 `AIAgent`：状态容器与薄接口

`run_agent.py:326` 定义了 `class AIAgent`。这个类有两个面孔：

- 对外，它是 agent 的**公开接口**——`chat()` 和 `run_conversation()` 两个方法。
- 对内，它是一个巨大的**状态容器**——provider、模型、工具集、会话 DB、记忆管理器、checkpoint 管理器、上下文压缩器、迭代预算、几十个回调、一堆 per-turn 的重试计数器，全都挂在 `self` 上。

但 `AIAgent` 类本身的代码出奇地"薄"。它的两个核心方法都是**转发器（forwarder）**——真正的实现被抽到了 `agent/` 下的独立模块。这是一个刻意的工程决策：`run_agent.py` 早已膨胀到难以维护，把大块逻辑外移能让文件保持可读。`run_agent.py:3823-3836` 这一段就是典型样貌：

```python
def _execute_tool_calls_concurrent(self, assistant_message, messages, effective_task_id, api_call_count=0):
    """Forwarder — see ``agent.tool_executor.execute_tool_calls_concurrent``."""
    from agent.tool_executor import execute_tool_calls_concurrent
    return execute_tool_calls_concurrent(self, assistant_message, messages, effective_task_id, api_call_count)
```

模式始终一致：方法体里 `from agent.xxx import yyy`，然后 `return yyy(self, ...)`，把 `self` 作为第一个参数传过去。被转发的函数通过属性访问读写 agent 状态。这意味着**`AIAgent` 的方法散落在 `agent/` 多个文件里**——读源码时遇到一个 forwarder，顺着它的 docstring 跳到真正的实现模块即可。

### `__init__`：~60 个参数转发到 `init_agent`

`AIAgent.__init__`（`run_agent.py:349`）的签名有约 60 个参数。`AGENTS.md:85` 直白地说："真正的 `__init__` 有 60+ 参数（凭证、路由、回调、会话上下文、预算、凭证池等）。" 把全部参数（`run_agent.py:349-414`）按职责分成七类，逐类看：

**(1) Provider / 模型 / 路由**——决定"调用哪个模型、走哪套协议、按什么策略路由"。

| 参数 | 作用 |
| --- | --- |
| `base_url` / `api_key` / `provider` | 端点 URL、凭证、provider 名（可省，由 `base_url` 主机名推断） |
| `api_mode` | 强制协议：`chat_completions` / `codex_responses` / `anthropic_messages` / `bedrock_converse` / `codex_app_server` |
| `model` / `fallback_model` | 主模型名 + 主模型不可用时的降级配置（dict） |
| `acp_command` / `acp_args` / `command` / `args` | ACP（Agent Client Protocol）子进程模式：用外部进程当 LLM runtime（如 Copilot ACP） |
| `providers_allowed` / `providers_ignored` / `providers_order` / `provider_sort` | OpenRouter 等聚合 provider 的路由白名单 / 黑名单 / 优先序 / 排序键 |
| `provider_require_parameters` / `provider_data_collection` / `openrouter_min_coding_score` | OpenRouter 路由约束：要求参数支持、数据收集策略、最低 coding 评分 |

**(2) 凭证池**——`credential_pool` 一个参数。传入一个 `CredentialPool` 对象，agent 在 401/429 时可轮换到池里的下一组凭证。详见 [第 4 章](04-provider-credentials.md)。

**(3) 推理 / 采样 / 请求覆盖**

| 参数 | 作用 |
| --- | --- |
| `reasoning_config` | 推理强度配置（`effort` 高/中/低、是否暴露 reasoning） |
| `service_tier` | OpenAI 服务等级（`auto` / `flex` / `priority`） |
| `max_tokens` | 单次响应输出上限 |
| `request_overrides` | 任意透传给底层 API 的 kwargs（`extra_body` 级别的逃生舱口） |
| `prefill_messages` | 在 system 之后、历史之前插入的 ephemeral 预填消息 |

**(4) 工具集 / 迭代预算**

| 参数 | 作用 |
| --- | --- |
| `enabled_toolsets` / `disabled_toolsets` | 显式开 / 关某些 toolset |
| `tool_delay` | 两次工具调用之间的节流间隔（默认 1.0 秒） |
| `max_iterations` | 单回合工具迭代上限，默认 **90**（与子 agent 共享语义，见 3.5 节） |
| `iteration_budget` | 直接传入一个已有 `IterationBudget` 实例；不传则按 `max_iterations` 新建 |

**(5) 会话上下文**——这一组在网关多平台场景下最密集，用来把一个 `AIAgent` 实例绑定到一条具体的聊天会话。

| 参数 | 作用 |
| --- | --- |
| `session_id` / `parent_session_id` | 本会话 ID、父会话 ID（子 agent 派发时回填） |
| `session_db` | `SessionDB` 实例；DB 行延迟到 `run_conversation()` 才插入 |
| `platform` | `"cli"` / `"telegram"` / `"discord"` / `"whatsapp"` 等来源平台 |
| `user_id` / `user_name` | 平台侧用户标识与昵称 |
| `chat_id` / `chat_name` / `chat_type` / `thread_id` | 聊天 / 频道 / 话题级标识 |
| `gateway_session_key` | 稳定的 per-chat 键，形如 `agent:main:telegram:dm:123` |

**(6) 回调（十二个）**——前端（CLI / 网关 / TUI）靠这些把 agent 内部事件渲染到各自的界面：`tool_progress_callback`、`tool_start_callback`、`tool_complete_callback`、`tool_gen_callback`（工具调用生命周期）、`thinking_callback`、`reasoning_callback`（推理流）、`stream_delta_callback`、`interim_assistant_callback`（增量文本）、`clarify_callback`（澄清提问）、`step_callback`（每次迭代触发，网关用它发 `agent:step` 事件）、`status_callback`（状态行）。回调全部是可选的——`None` 时对应事件静默丢弃。

**(7) 开关与 checkpoint**

| 参数 | 作用 |
| --- | --- |
| `quiet_mode` | 安静模式：抑制 verbose 终端输出，改用 spinner |
| `verbose_logging` / `log_prefix` / `log_prefix_chars` | 日志冗余度与前缀 |
| `skip_context_files` / `load_soul_identity` / `skip_memory` | 跳过上下文文件加载 / 加载 soul 身份 / 跳过记忆系统 |
| `save_trajectories` | 是否落盘轨迹文件 |
| `ephemeral_system_prompt` | 追加到 system prompt 末尾的 ephemeral 段（不进缓存前缀） |
| `pass_session_id` | 是否把 `session_id` 透传给工具 |
| `checkpoints_enabled` / `checkpoint_max_snapshots` / `checkpoint_max_total_size_mb` / `checkpoint_max_file_size_mb` | 文件 checkpoint 开关与配额 |

`__init__` 本身（`run_agent.py:415-484`）只做一件事——把全部 ~60 个参数原样转发给 `init_agent(self, ...)`：

```python
def __init__(self, base_url=None, api_key=None, provider=None, ...):
    """Forwarder — see ``agent.agent_init.init_agent``."""
    from agent.agent_init import init_agent
    init_agent(self, base_url=base_url, api_key=api_key, provider=provider, ...)
```

### `init_agent`：~1400 行的初始化

真正的初始化在 `agent/agent_init.py:74` 的 `init_agent()`。这个模块的 docstring 解释了为什么要抽出来：`AIAgent.__init__` 曾是代码库里最长的方法之一（60+ 参数、~1400 行属性初始化、provider 自动探测、凭证解析、context-engine 引导），把它留在 `run_agent.py` 里会让那个文件被"设置完就忘"的代码淹没。下一节把这 ~1400 行按执行顺序拆成八个步骤逐一讲。

### `init_agent` 逐步骤拆解

把 `init_agent` 的执行流程按代码顺序展开成八步，每一步对应一段实现：

**步骤 1 — 迭代预算落位（`agent_init.py:195`）。** 第一行实质性代码就是：

```python
agent.iteration_budget = iteration_budget or IterationBudget(max_iterations)
```

如果调用方传了现成的 `iteration_budget` 就直接复用，否则按 `max_iterations`（默认 90）新建。子 agent 派发时父 agent 会显式构造一个上限更小的预算传进来——见 3.5 节。

**步骤 2 — 会话上下文字段落位（`agent_init.py:201-218`）。** `platform`、`_user_id`、`_chat_id`、`_thread_id`、`_gateway_session_key` 等会话标识被原样存到 `agent` 的私有属性上。这一步还把 `_print_fn` 置 `None`（CLI 后续会替换成自己的 `_cprint`，让 ANSI 状态行走 prompt_toolkit 的渲染器而不是裸 stdout），并存下 `_credential_pool`。

**步骤 3 — `api_mode` 决策（`agent_init.py:227-259`）。** 这是一棵决策树，优先级从高到低：

```python
if api_mode in {"chat_completions", "codex_responses", "anthropic_messages",
                 "bedrock_converse", "codex_app_server"}:
    agent.api_mode = api_mode                          # 显式指定，最高优先
elif agent.provider == "openai-codex":
    agent.api_mode = "codex_responses"
elif agent.provider in {"xai", "xai-oauth"}:
    agent.api_mode = "codex_responses"
elif provider_name is None and agent._base_url_hostname == "api.x.ai":
    agent.api_mode = "codex_responses"; agent.provider = "xai"
elif agent.provider == "anthropic" or (provider_name is None
        and agent._base_url_hostname == "api.anthropic.com"):
    agent.api_mode = "anthropic_messages"; agent.provider = "anthropic"
...
else:
    agent.api_mode = "chat_completions"                # 兜底
```

显式 `api_mode` 永远赢——注释（`agent_init.py:316`）说明理由："用户知道自己的端点支持什么"。否则按 provider 名、再按 `base_url` 主机名逐级推断。第三方 Anthropic 兼容端点（MiniMax、DashScope）用 URL 以 `/anthropic` 结尾的约定来自动识别。

**步骤 4 — transport 预热与模型名归一化（`agent_init.py:261-275`）。** 立刻调一次 `agent._get_transport()` 把 transport 缓存暖起来——这样 import 错误在 init 时就暴露，而不是对话进行到一半才炸。然后对非聚合 provider 调 `normalize_model_for_provider()` 把模型名归一化。

**步骤 5 — Responses API 自动升级（`agent_init.py:289-309`）。** 一个特例修正：GPT-5.x 系列通常需要 Responses API，所以当 `api_mode` 是兜底的 `chat_completions`、且 URL 是直连 OpenAI（`api.openai.com`）或模型需要 Responses API 时，自动把 `api_mode` 升级为 `codex_responses`，并清掉刚才预热的 transport 缓存。Azure OpenAI（`openai.azure.com`）和 Copilot ACP 被显式排除——它们在 `/chat/completions` 上提供 gpt-5.x。

**步骤 6 — OpenRouter 元数据后台预热（`agent_init.py:311-326`）。** 如果是 OpenRouter，在守护线程里后台跑 `fetch_model_metadata()`（缓存 1 小时），避免首次 API 响应时阻塞拉取定价数据。用一个进程级 `Event` 守护，保证只 spawn 一次——网关为每条消息建新 `AIAgent`，没有这个守护每条消息都会泄漏一个 OS 线程。

**步骤 7 — 客户端、工具、记忆、checkpoint（`agent_init.py:506-1038`）。** 经中心化的 provider router 创建 LLM client；调 `get_tool_definitions()` 填 `agent.tools` 并把工具名集合存进 `agent.valid_tool_names`；建 `CheckpointManager`；存下 `session_db`（DB 行延迟创建）；`MemoryStore.load_from_disk()` 加载磁盘记忆；构造 `MemoryManager` 并把记忆 provider（如 Honcho）贡献的工具 schema 动态追加到 `agent.tools`。

**步骤 8 — 上下文压缩器（`agent_init.py:1237-1312`）。** 选用 context engine 或回退到内建 `ContextCompressor`，并绑定模型的 `context_length`。

整体骨架如下：

<svg viewBox="0 0 780 560" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Skeleton of init_agent assembling AIAgent subsystems">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g font-size="11">
    <rect x="200" y="16" width="380" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
    <text x="390" y="38" font-weight="700" fill="currentColor" text-anchor="middle">agent/agent_init.py:74　init_agent(agent, ...)</text>
    <rect x="80" y="74" width="620" height="30" rx="5" fill="#f0fdfa" stroke="#cbd5e1"/>
    <text x="96" y="94" fill="currentColor">迭代预算　:195　iteration_budget or IterationBudget(max_iterations)　← 默认 90</text>
    <rect x="80" y="112" width="620" height="30" rx="5" fill="#f0fdfa" stroke="#cbd5e1"/>
    <text x="96" y="132" fill="currentColor">会话上下文　:201-218　platform / user / chat / thread / 凭证池</text>
    <rect x="80" y="150" width="620" height="30" rx="5" fill="#faf5ff" stroke="#cbd5e1"/>
    <text x="96" y="170" fill="currentColor">api_mode 决策　:227-259　显式 &gt; provider 名 &gt; base_url 主机名</text>
    <rect x="80" y="188" width="620" height="30" rx="5" fill="#faf5ff" stroke="#cbd5e1"/>
    <text x="96" y="208" fill="currentColor">transport 预热　:261-275　暖缓存 + 模型名归一化</text>
    <rect x="80" y="226" width="620" height="30" rx="5" fill="#faf5ff" stroke="#cbd5e1"/>
    <text x="96" y="246" fill="currentColor">Responses 升级　:289-309　GPT-5.x / 直连 OpenAI 自动升级</text>
    <rect x="80" y="264" width="620" height="30" rx="5" fill="#faf5ff" stroke="#cbd5e1"/>
    <text x="96" y="284" fill="currentColor">OpenRouter 预热　:311-326　后台线程拉模型元数据（进程级单次）</text>
    <rect x="80" y="302" width="620" height="30" rx="5" fill="#e0f2fe" stroke="#cbd5e1"/>
    <text x="96" y="322" fill="currentColor">LLM client　:506+　经中心化 provider router 创建客户端</text>
    <rect x="80" y="340" width="620" height="30" rx="5" fill="#e0f2fe" stroke="#cbd5e1"/>
    <text x="96" y="360" fill="currentColor">工具定义　:802　agent.tools = get_tool_definitions(...)；valid_tool_names</text>
    <rect x="80" y="378" width="620" height="30" rx="5" fill="#e0f2fe" stroke="#cbd5e1"/>
    <text x="96" y="398" fill="currentColor">Checkpoint　:889　CheckpointManager(...)</text>
    <rect x="80" y="416" width="620" height="30" rx="5" fill="#e0f2fe" stroke="#cbd5e1"/>
    <text x="96" y="436" fill="currentColor">SessionDB　:898　存下 session_db；DB 行延迟到 run_conversation() 才建</text>
    <rect x="80" y="454" width="620" height="30" rx="5" fill="#ddd6fe" stroke="#cbd5e1"/>
    <text x="96" y="474" fill="currentColor">记忆 store / manager　:932-1038　load_from_disk + MemoryManager，注入记忆工具 schema</text>
    <rect x="80" y="492" width="620" height="38" rx="5" fill="#ddd6fe" stroke="#cbd5e1"/>
    <text x="96" y="510" fill="currentColor">上下文压缩器　:1237-1312　选 context engine 或回退到内建</text>
    <text x="96" y="524" font-size="10" fill="#64748b">ContextCompressor，绑定模型的 context_length</text>
  </g>
  <line x1="390" y1="50" x2="390" y2="72" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar1)"/>
</svg>
<span class="figure-caption">图 R3.1 ｜ init_agent() 的装配骨架：从迭代预算到上下文压缩器，依次把十余个子系统填进 AIAgent 实例。</span>

<details>
<summary>ASCII 原版</summary>

```text
agent/agent_init.py:74  init_agent(agent, ...)
   │
   ├─ 迭代预算         agent.iteration_budget = iteration_budget
   │   :195               or IterationBudget(max_iterations)   ← 默认 90
   │
   ├─ 会话上下文       :201-218  platform / user / chat / thread / 凭证池
   │
   ├─ api_mode 决策    :227-259  显式 > provider 名 > base_url 主机名
   │
   ├─ transport 预热   :261-275  暖缓存 + 模型名归一化
   │
   ├─ Responses 升级   :289-309  GPT-5.x / 直连 OpenAI 自动升级
   │
   ├─ OpenRouter 预热  :311-326  后台线程拉模型元数据（进程级单次）
   │
   ├─ LLM client       :506+  经中心化 provider router 创建客户端
   │
   ├─ 工具定义         :802  agent.tools = get_tool_definitions(...)
   │   :809-812           agent.valid_tool_names = {工具名集合}
   │
   ├─ Checkpoint       :889  agent._checkpoint_mgr = CheckpointManager(...)
   │
   ├─ SessionDB        :898  agent._session_db = session_db
   │   :901               DB 行延迟到 run_conversation() 才建
   │
   ├─ 记忆 store        :932-956  MemoryStore.load_from_disk()
   │
   ├─ 记忆 manager      :958-1038  MemoryManager + provider，注入记忆工具 schema
   │
   └─ 上下文压缩器      :1237-1312  选 context engine 或回退到内建
                       ContextCompressor，绑定模型的 context_length
```

</details>

几个值得强调的点：

- **provider 解析是推断式的**（`agent_init.py:223-274`）。如果调用方没显式给 `provider`，`init_agent` 会从 `base_url` 的主机名猜——`api.x.ai` → `xai`、`api.anthropic.com` → `anthropic`，等等。然后按 provider 把模型名归一化。这让"只给一个 base_url"也能工作。
- **`api_mode` 决定协议**（`agent_init.py:279-318`）。Hermes 支持三种 provider 协议：`chat_completions`（OpenAI 风格）、`codex_responses`（Codex）、`anthropic_messages`。这个决策结果会贯穿后面所有 API 调用。详见 [第 4 章](04-provider-credentials.md)。
- **SessionDB 的行延迟创建**（`agent_init.py:901`）。`init_agent` 里只是把传入的 `session_db` 存下来，真正在数据库里插入会话行要等到 `run_conversation()`——因为这时才知道会不会真的有一个回合发生。
- **记忆工具是动态注入的**（`agent_init.py:1025-1038`）。`MemoryManager` 的 provider（如 Honcho）会贡献自己的工具 schema，`init_agent` 把这些 schema 追加到 `agent.tools` 并把工具名加进 `valid_tool_names`。

`max_iterations` 默认 90。这个值同时被父 agent 和子 agent 共享语义——细节见 3.5 节。

---

## 3.2 两个接口：`chat()` 与 `run_conversation()`

`AIAgent` 对外只暴露两个对话方法，它们的关系是包装与被包装。

### `run_conversation()`：完整接口，返回 dict

`run_agent.py:3838` 的 `run_conversation()` 是完整接口。它也是一个 forwarder——转发到 `agent/conversation_loop.py:85`：

```python
def run_conversation(self, user_message, system_message=None,
                     conversation_history=None, task_id=None,
                     stream_callback=None, persist_user_message=None):
    """Forwarder — see ``agent.conversation_loop.run_conversation``."""
    from agent.conversation_loop import run_conversation
    return run_conversation(self, user_message, system_message,
                            conversation_history, task_id,
                            stream_callback, persist_user_message)
```

它返回一个**信息丰富的 dict**（`conversation_loop.py:3918`）：

```python
result = {
    "final_response": final_response,      # 最终文本回复
    "last_reasoning": last_reasoning,      # 最后一段推理
    "messages": messages,                  # 完整消息历史
    "api_calls": api_call_count,           # 这一回合用了几次 API 调用
    "completed": completed,                # 是否正常完成
    "turn_exit_reason": _turn_exit_reason, # 退出原因（调试用）
    "interrupted": interrupted,            # 是否被中断
    "input_tokens": ...,  "output_tokens": ...,   # 完整 token 计量
    "cache_read_tokens": ..., "cache_write_tokens": ...,
    ...
}
```

CLI、网关、批量 runner 都用这个接口，因为它们需要 `messages`（要持久化进 SessionDB）、`token` 计量（要算成本）、`turn_exit_reason`（要诊断）、`interrupted`（要决定后续行为）。

### `chat()`：简单接口，返回字符串

`run_agent.py:3851` 的 `chat()` 是 `run_conversation()` 的薄包装——它只取 dict 里的 `final_response`：

```python
def chat(self, message: str, stream_callback=None) -> str:
    result = self.run_conversation(message, stream_callback=stream_callback)
    return result["final_response"]
```

这个接口给"只关心最终回复"的调用方用——典型是单查询模式、子 agent 内部的简单调用。

设计上的取舍很清晰：**`run_conversation()` 是真相，`chat()` 是便利**。需要任何元信息就用前者，否则用后者图省事。

---

## 3.3 核心循环：逐阶段解剖

`run_conversation()` 在 `agent/conversation_loop.py` 里大约 4000 行——它是从 `run_agent.py` 里抽出的最大一块。它的骨架是这样一个 `while` 循环（`conversation_loop.py:532`）：

```python
while (api_call_count < agent.max_iterations
       and agent.iteration_budget.remaining > 0) or agent._budget_grace_call:
```

完整的回合数据流：

<svg viewBox="0 0 800 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Three-phase data flow of a conversation turn">
  <defs>
    <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g font-size="10.5">
    <rect x="160" y="14" width="480" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
    <text x="400" y="34" font-weight="700" fill="currentColor" text-anchor="middle">run_conversation(agent, user_message, conversation_history, ...)</text>
    <rect x="60" y="62" width="680" height="140" rx="8" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.3"/>
    <text x="76" y="82" font-size="12" font-weight="700" fill="currentColor">阶段 A：初始化　conversation_loop.py:115-300</text>
    <text x="76" y="102" fill="#64748b">_install_safe_stdio() 防 broken pipe；_ensure_db_session() 建会话 DB 行</text>
    <text x="76" y="120" fill="#64748b">set_runtime_main() / set_session_context() 标记主模型与 session 日志</text>
    <text x="76" y="138" fill="#64748b">重置 per-turn 重试计数器；重建 IterationBudget；messages = list(history) 拷贝</text>
    <text x="76" y="156" fill="#64748b">_hydrate_todo_store() / hydrate nudge 计数器（网关补水）</text>
    <text x="76" y="174" fill="#64748b">append user 消息；_should_review_memory 记忆 nudge 触发判定</text>
    <rect x="60" y="222" width="680" height="190" rx="8" fill="#faf5ff" stroke="#7c3aed" stroke-width="1.3" stroke-dasharray="5,3"/>
    <text x="76" y="242" font-size="12" font-weight="700" fill="currentColor">阶段 B：while 循环 — 每次迭代</text>
    <text x="76" y="262" fill="#64748b">:534 _checkpoint_mgr.new_turn() 重置 per-turn 去重</text>
    <text x="76" y="280" fill="#64748b">:537 中断检查 if agent._interrupt_requested: break</text>
    <text x="76" y="298" fill="#64748b">:544 api_call_count += 1；:551 迭代预算消费（grace call / consume()）</text>
    <text x="76" y="316" fill="#64748b">:560 step_callback(...) 发 agent:step 事件</text>
    <text x="76" y="334" fill="#64748b">:593 /steer 注入；:649 _sanitize_tool_call_arguments()</text>
    <text x="76" y="352" fill="#64748b">:668 _repair_message_sequence() 修角色交替</text>
    <text x="76" y="370" fill="#64748b">:676 构建 api_messages（注入记忆/插件 hook）+ API 调用</text>
    <text x="76" y="390" fill="currentColor">有 tool_calls → 执行工具，结果 append 回 messages，继续循环</text>
    <text x="76" y="406" fill="currentColor">无 tool_calls → final_response = content，准备退出</text>
    <rect x="60" y="432" width="680" height="92" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
    <text x="76" y="452" font-size="12" font-weight="700" fill="currentColor">阶段 C：收尾　conversation_loop.py:3721-3990</text>
    <text x="76" y="472" fill="#64748b">达到 max_iterations? → _handle_max_iterations() 注入收尾提示</text>
    <text x="76" y="490" fill="#64748b">post-response hook、footer 注入；记忆 / 技能 review nudge 触发</text>
    <text x="76" y="508" fill="#64748b">组装并返回 result dict（:3918）</text>
  </g>
  <line x1="400" y1="44" x2="400" y2="60" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar2)"/>
  <line x1="400" y1="202" x2="400" y2="220" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar2)"/>
  <text x="412" y="216" fill="#64748b" font-size="10">进入 while 循环</text>
  <line x1="400" y1="412" x2="400" y2="430" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar2)"/>
  <text x="412" y="426" fill="#64748b" font-size="10">循环退出后</text>
</svg>
<span class="figure-caption">图 R3.2 ｜ 一个回合的三阶段数据流：阶段 A 初始化、阶段 B 同步 while 循环迭代、阶段 C 收尾返回 result dict。</span>

<details>
<summary>ASCII 原版</summary>

```text
run_conversation(agent, user_message, conversation_history, ...)
   │
   ┌─────────────── 阶段 A: 初始化 (conversation_loop.py:115-300) ──────────┐
   │  _install_safe_stdio()  防 broken pipe 崩溃                            │
   │  agent._ensure_db_session()  建会话 DB 行                               │
   │  set_runtime_main()  告诉 auxiliary_client 当前主模型                    │
   │  set_session_context()  给本线程的日志打 session 标签                    │
   │  重置 per-turn 重试计数器（_invalid_tool_retries 等）                    │
   │  iteration_budget = IterationBudget(max_iterations)  重建预算            │
   │  messages = list(conversation_history)  拷贝历史（不改调用方的 list）     │
   │  _hydrate_todo_store()  从历史恢复 todo（:234）                          │
   │  hydrate nudge 计数器  从历史恢复记忆 nudge 计数（:246-256）              │
   │  user_msg = {"role": "user", "content": user_message}; messages.append   │
   │  _should_review_memory = ...  记忆 nudge 触发判定（:286-291）             │
   └────────────────────────────────────────────────────────────────────────┘
   │
   ▼  进入 while 循环 ─────────────────────────────────────────────────────
   │
   │  ┌── 阶段 B: 每次迭代 ──────────────────────────────────────────────┐
   │  │  :534  _checkpoint_mgr.new_turn()  重置 per-turn checkpoint 去重    │
   │  │  :537  中断检查  if agent._interrupt_requested: break              │
   │  │  :544  api_call_count += 1                                        │
   │  │  :551  迭代预算消费  grace call / iteration_budget.consume()       │
   │  │  :560  step_callback(...)  给网关 hook 发 agent:step 事件          │
   │  │  :593  /steer 注入  _drain_pending_steer() → 注入到 tool 消息       │
   │  │  :649  消息修复  _sanitize_tool_call_arguments()                   │
   │  │  :668  _repair_message_sequence()  修角色交替                       │
   │  │  :676  构建 api_messages  注入 ephemeral 上下文（记忆/插件 hook）    │
   │  │  :676+ API 调用  client.chat.completions.create(...)              │
   │  │        ├─ 有 tool_calls → 执行工具，结果 append 回 messages，继续   │
   │  │        └─ 无 tool_calls → final_response = content，准备退出       │
   │  └────────────────────────────────────────────────────────────────┘
   │
   ▼  循环退出后 ──────────────────────────────────────────────────────────
   │
   ┌─────────────── 阶段 C: 收尾 (conversation_loop.py:3721-3990) ──────────┐
   │  达到 max_iterations? → _handle_max_iterations() 注入收尾提示           │
   │  post-response hook、footer 注入                                       │
   │  记忆 / 技能 review nudge 触发（:3967-3990）                            │
   │  组装并返回 result dict（:3918）                                        │
   └────────────────────────────────────────────────────────────────────────┘
```

</details>

下面逐阶段展开。

### 阶段 A：初始化（`conversation_loop.py:115-300`）

回合一开始有一长串"重置"动作。最关键的几个：

- **`_install_safe_stdio()`**（`:115`）——给 stdio 套一层 broken-pipe 保护。在 systemd / headless / daemon 环境下，stdout 可能随时断开，没有这层保护一次 `write` 就会让进程崩溃。
- **per-turn 计数器重置**（`:174-191`）——`_invalid_tool_retries`、`_invalid_json_retries`、`_empty_content_retries` 等一连串重试计数器全部归零。原因（`:172` 注释）：上一回合子 agent 用掉的重试额度不能吃进这一回合。
- **`iteration_budget = IterationBudget(agent.max_iterations)`**（`:215`）——每个回合重建一个全新的迭代预算。
- **`messages = list(conversation_history)`**（`:229`）——拷贝历史。`run_conversation()` 绝不直接改调用方传进来的 list。
- **nudge 计数器有意不重置**（`:212` 注释）——`_turns_since_memory` 和 `_iters_since_skill` 在 `__init__` 里初始化，必须跨 `run_conversation()` 调用持续累加，否则 CLI 模式下 nudge 逻辑永远累计不到阈值。

阶段 A 还有两段为**网关场景**专门写的"补水（hydrate）"逻辑（`:231-256`）。网关为每条入站消息构造一个全新的 `AIAgent`，所以 in-memory 的 todo store 和 nudge 计数器每次都是空的。`_hydrate_todo_store()`（`:234`）从历史里最近的 todo 工具响应里恢复 todo 状态；nudge 计数器补水（`:246-256`）则数一遍历史里有多少个 user 回合，把 `_user_turn_count` 和 `_turns_since_memory` 重建出来——用取模 `% nudge_interval` 而不是直接置 0，是为了保持原本 1-in-N 的节奏，不会因为恰好 resume 就立刻触发一次 review。这些细节属于记忆与学习循环，[第 10 章](10-memory-learning.md) 会展开。

### 阶段 B：循环内的每次迭代

**中断检查**（`:537-542`）放在循环体最顶端：

```python
if agent._interrupt_requested:
    interrupted = True
    _turn_exit_reason = "interrupted_by_user"
    if not agent.quiet_mode:
        agent._safe_print("\n⚡ Breaking out of tool loop due to interrupt...")
    break
```

每次迭代开始先看中断标志——这是同步循环最优雅的地方，下文 3.6 节专门讲。

**迭代预算消费**（`:551-557`）：

```python
if agent._budget_grace_call:
    agent._budget_grace_call = False
elif not agent.iteration_budget.consume():
    _turn_exit_reason = "budget_exhausted"
    break
```

正常情况下 `iteration_budget.consume()` 消耗一个名额，返回 `False`（预算耗尽）就退出。grace call 是个例外机制，见 3.5 节。

**`/steer` 注入**（`:593-641`）——这是一个交互性设计。用户在模型"思考"（API 调用进行中）时通过 `/steer` 发来的引导文本，会被暂存。下一次迭代开始时 `_drain_pending_steer()` 把它取出来，**反向扫描 messages 找到最后一个 `role == "tool"` 的消息，把引导文本追加进它的 content**。为什么要塞进 tool 消息而不是新建 user 消息？因为新建 user 消息会破坏 `tool → user` 的角色交替规则，而 tool 消息天然是可以追加内容的载体。如果当前还没有任何 tool 消息（第一次迭代），steer 就保持 pending 等下一批 tool 输出。

**消息修复**（`:649-674`）有两道防线。`_sanitize_tool_call_arguments()`（`:649`）修复被损坏的 tool_call 参数（issue #15236——某些会话里 tool call 参数会损坏，直接丢弃它们保住会话存活）。`_repair_message_sequence()`（`:668`）修复角色交替违规——历史可能被弄成 `tool → user` 或 `user → user` 这样的畸形尾巴，大多数 provider 对畸形序列会返回空 content，不修就会无限触发空响应重试。

**构建 `api_messages`**（`conversation_loop.py:676-820`）。这一步绝不直接发 `messages`，而是逐条 `msg.copy()` 出一份 `api_messages`，在拷贝上做所有改写。这个"拷贝再改"的纪律保证原始 `messages`（要进 SessionDB 持久化）永远干净。改写动作按顺序有这么几道：

- **ephemeral 上下文注入**（`:680-689`）——只对当前回合那条 user 消息（`idx == current_turn_user_idx`），把记忆管理器预取结果（`build_memory_context_block`）和插件 `pre_llm_call` hook 产出的文本追加到 content 末尾。**ephemeral** 是关键词：注入只活在 API 调用瞬间。
- **reasoning 字段搬运**（`:700-704`）——`_copy_reasoning_content_for_api()` 把内部的 `reasoning` 字段转成 provider 需要的形态，然后从 `api_msg` 删掉 `reasoning`、`finish_reason`、`_thinking_prefill` 这些内部字段——严格的 API（Mistral）会因为未知字段返回 422。
- **system prompt 拼接**（`:721-739`）——`api_messages` 最前面插入 `{"role": "system", ...}`。Hermes 不变量：system prompt 每个会话只构建一次（缓存在 `_cached_system_prompt`），逐回合逐字节重放，保持上游 prompt 缓存命中。
- **prompt caching 断点**（`:745-755`）——Claude 模型走 Anthropic 缓存时，`apply_anthropic_cache_control()` 注入 `cache_control` 断点（system + 最后 3 条消息），多轮对话输入 token 成本降约 75%。
- **孤儿工具结果清理**（`:760`）——`_sanitize_api_messages()` 无条件运行，给丢失 parent 的 tool 结果补 stub 或剥掉，防 API 报 "No tool call found"。
- **thinking-only 回合丢弃**（`:773`）——`_drop_thinking_only_and_merge_users()` 丢掉"只有推理、没有可见输出也没有 tool_calls"的 assistant 回合，避免 Anthropic 报 "The final block in an assistant message cannot be `thinking`"。
- **whitespace / JSON 归一化 + surrogate 剥离**（`:780-816`）——content `strip()`、tool_call 参数按 `sort_keys` 重排序列化，让前缀逐字节稳定（本地推理服务器 llama.cpp / vLLM / Ollama 的 KV 缓存复用靠这个）；最后 `_sanitize_messages_surrogates()` 剥掉孤立 surrogate 字符，防 OpenAI SDK 的 `json.dumps()` 崩溃。

**发起 API 调用。** `api_messages` 备好后调 provider client（`chat_completions` 模式下是 `client.chat.completions.create(...)`）。`codex_responses` / `anthropic_messages` / `bedrock_converse` 走各自 adapter，详见 [第 4 章](04-provider-credentials.md)。安静模式下此处启动一个 spinner。

**解析响应**（`conversation_loop.py:3035-3256`）。拿到 `assistant_message` 后：

- 检查 `tool_calls`。无效工具名会被先挑出来（`:3041-3070`，`invalid_tool_calls`），触发一次"提示模型工具名写错了"的重试。
- `finish_reason == "length"` 但确实带了 `tool_calls` 时，把 `finish_reason` 改写成 `"tool_calls"`（`:3108-3114`）——某些 provider 会错误地报 length。
- `_cap_delegate_task_calls()` 和 `_deduplicate_tool_calls()`（`:3179-3183`）给一批工具调用去重、给子 agent 派发调用数量封顶。
- **如果这一回合同时有 content 和 tool_calls**（`:3188-3205`），content 会被作为"中途文本"捕获——某些模型会边说话边调工具。

**两条分支汇合到循环**：

- 有 `tool_calls` → 调 `agent._execute_tool_calls(assistant_message, messages, ...)`（`:3256`，forwarder 转发到 `tool_executor`），工具结果 `append` 回 `messages`，`while` 继续下一次迭代。并发 vs 顺序由 `agent/tool_executor.py` 决定，详见 [第 5 章](05-tool-system.md)。
- 无 `tool_calls` → `assistant_message.content` 成为 `final_response`，循环自然结束（条件不再满足或直接 `break`）。

**per-turn 重试计数器。** 阶段 B 里穿插着一组"坏响应重试"的逻辑。模型不总是返回干净的响应——可能调了不存在的工具、可能返回的 tool_call 参数不是合法 JSON、可能返回空 content。Hermes 不会一遇到坏响应就放弃，而是给每种坏响应一个有限的重试额度，靠一组计数器追踪：

| 计数器 | 计什么 |
| --- | --- |
| `_invalid_tool_retries` | 模型调用了不在 `valid_tool_names` 里的工具名 |
| `_invalid_json_retries` | tool_call 的 `arguments` 不是合法 JSON |
| `_empty_content_retries` | assistant 响应既无 content 也无 tool_calls |

这些计数器在阶段 A 被显式重置为 0（`conversation_loop.py:174-191`）。重置的理由很关键（`:172` 注释）：上一回合——尤其是上一回合里某个子 agent——用掉的重试额度，绝不能吃进这一回合。如果不重置，一个长会话跑到后面这些额度会被慢慢耗光，导致一个本可恢复的坏响应被误判为"重试已用尽"而直接放弃。重置后每个新回合都拿到一份满额的"容错预算"。

### 阶段 C：收尾（`conversation_loop.py:3721-3990`）

循环退出后，如果是因为撞到 `max_iterations`，`_handle_max_iterations()`（forwarder 在 `run_agent.py:3833`）会做最后一次"剥掉工具"的 API 调用，逼模型给一个纯文本收尾。然后是 post-response hook、footer 注入，以及**记忆/技能 review nudge 的触发**（`:3967-3990`）——记忆 nudge 是回合级的（在阶段 A 就判好了 `_should_review_memory`），技能 nudge 是迭代级的（要等循环跑完才知道这一回合用了多少次工具迭代）。最后组装 result dict 返回。

`_turn_exit_reason` 这个局部变量在循环的每个退出分支都会被赋一个有诊断意义的字符串，最终原样进 result dict。把它当作"这一回合是怎么结束的"的速查表：

| `_turn_exit_reason` 取值 | 含义 | 赋值位置 |
| --- | --- | --- |
| （无后缀，正常返回 content） | 模型给出最终文本回复，自然退出 | 循环条件不满足 |
| `interrupted_by_user` | 用户中断，`break` 出循环 | `conversation_loop.py:539` |
| `budget_exhausted` | `iteration_budget.consume()` 返回 `False` | `:553` |
| `max_iterations_reached(N/M)` | `final_response is None` 且撞顶，走 `_handle_max_iterations` | `:3728` |
| `error_near_max_iterations(...)` | 接近上限时反复报错，提前 `break` | `:3713` |

诊断一个"回合行为异常"的问题时，第一件事就是看 result dict 里的 `turn_exit_reason`——它直接告诉你循环从哪个分支退出的。

---

## 3.4 为什么是同步循环

在一个到处是网络 I/O 的系统里，把核心循环写成同步的 `while` 而不是 `async`，是一个反直觉但深思熟虑的决定。`AGENTS.md:121` 直接点明："核心循环在 `run_conversation()` 内部——完全同步，带中断检查、预算追踪和一次单回合 grace call。"

同步带来三个具体好处：

1. **中断简单。** 异步代码里取消一个进行中的任务需要 `asyncio.CancelledError` 的传播，要小心处理清理。同步循环里中断就是"在循环顶端检查一个布尔标志"——`if agent._interrupt_requested: break`，没有任何隐藏的控制流。

2. **调试简单。** 同步循环的栈帧是线性的。在 `conversation_loop.py` 任何一行下断点，你看到的调用栈就是真实的执行路径。异步代码的栈帧被事件循环切碎，排查"为什么这个回合卡住了"会困难得多。

3. **状态可见。** 整个回合的状态都在 `agent` 实例的属性上和循环的局部变量里（`messages`、`api_call_count`、`final_response`）。任意时刻你都能完整地"看见"agent 在哪。异步并发会让"现在的状态是什么"变成一个需要推理的问题。

代价是：单个 `run_conversation()` 调用会阻塞它所在的线程。Hermes 用**多线程**而非 `async` 来解决并发——工具在 worker 线程里执行（这就是为什么中断要 fan-out 到 worker 线程，见 3.6 节），网关用 asyncio 管理多平台 I/O 但每个会话的 `run_conversation()` 跑在自己的线程里。这是一个清晰的分工：**asyncio 管 I/O 多路复用，同步循环管单个回合的逻辑**。

---

## 3.5 迭代预算与 grace call

`max_iterations`（默认 90）是一个回合内允许的工具调用迭代上限。但循环条件里出现的不是 `max_iterations` 一个东西，而是三个：

```python
while (api_call_count < agent.max_iterations
       and agent.iteration_budget.remaining > 0) or agent._budget_grace_call:
```

为什么需要 `IterationBudget` 这个独立对象，而不是只用 `api_call_count < max_iterations`？

`agent/iteration_budget.py` 给出了答案。`IterationBudget`（`iteration_budget.py:17`）是一个**线程安全的可消费/可退还计数器**：

```python
class IterationBudget:
    def __init__(self, max_total: int):
        self.max_total = max_total
        self._used = 0
        self._lock = threading.Lock()

    def consume(self) -> bool:        # 消费一个名额，成功返回 True
        with self._lock:
            if self._used >= self.max_total:
                return False
            self._used += 1
            return True

    def refund(self) -> None:         # 退还一个名额
        with self._lock:
            if self._used > 0:
                self._used -= 1
```

关键在 **`refund()`**。`iteration_budget.py:28` 的注释说明：`execute_code`（程序化工具调用——模型写一段 Python 脚本通过 RPC 批量调工具）的迭代会被 `refund()` 退还，不计入预算。这就是为什么需要一个有状态的预算对象而不是裸计数器——裸计数器无法"退还"。`execute_code` 把多步流水线压缩成一个零上下文成本的回合，退还机制保证它不会白白吃掉迭代额度。

### `remaining` / `consume` / `refund` 三个动作

`IterationBudget` 只有三个对外动作，全部加锁：

- **`consume()`**（`iteration_budget.py:37`）——尝试占一个名额。`_used >= max_total` 时返回 `False`（额度耗尽），否则 `_used += 1` 返回 `True`。循环体每次迭代调一次。
- **`refund()`**（`iteration_budget.py:45`）——退还一个名额，`_used > 0` 时 `_used -= 1`。
- **`remaining`**（`iteration_budget.py:56`）——只读属性，`max(0, max_total - _used)`。循环条件里读的就是它。

`_lock` 是一把 `threading.Lock`。为什么需要锁？因为父 agent 和它派发出去的子 agent 跑在不同线程上——虽然父子各持独立预算对象（见下文），但 `execute_code` 的 RPC 工具调用同样可能在 worker 线程里触发 `refund()`，裸的 `+= / -=` 在多线程下不是原子操作。

### `refund()` 为什么必须存在

`iteration_budget.py:28` 的注释点出唯一用途：`execute_code`（程序化工具调用——模型写一段 Python 脚本通过 RPC 批量调工具）的迭代会被 `refund()` 退还。设想模型用 `execute_code` 在一个脚本里串了 8 个工具调用：如果每个 RPC 调用都吃掉一格预算，一次 `execute_code` 就烧掉 8 格，模型很快撞顶。`refund()` 让 `execute_code` 把多步流水线压缩成"零预算成本"的一个回合。这正是为什么需要一个**有状态对象**而不是裸的 `api_call_count` 整数——整数只能加，没法退。

### 父 agent 与子 agent 间的预算共享

`IterationBudget` 区分了**父 agent 与子 agent**（`iteration_budget.py:20-26`）：

- 父 agent 的预算上限是 `max_iterations`，默认 **90**。
- 每个子 agent 拿一个**独立的** `IterationBudget`，上限是 config 里 `delegation.max_iterations`，默认 **50**。

注意"独立"二字——父和子不是共享同一个计数器。这意味着父 + 子 agent 的总迭代数**可以超过**父的 90：父跑 90 格、它派发的 3 个子 agent 各跑 50 格，理论总量 240 格。这是有意设计——子 agent 的工作不应该挤占父 agent 解决主任务的额度。用户通过 config 的 `delegation.max_iterations` 控制每个子 agent 的封顶。子 agent 派发详见 [第 12 章](12-subagents-cron.md)。

### grace call 机制

**grace call** 是循环条件里的 `or agent._budget_grace_call`。`_budget_grace_call` 在 `agent_init.py:431` 初始化为 `False`，是一个"绕过预算检查再跑一次"的逃生舱口。预算耗尽时，Hermes 不会硬生生在工具调用中间砍断——可以把这个标志置 `True`，让模型**最后一次机会**再发一次 API 调用（通常用于产出一个收尾性的文本回复）。

循环体里的处理（`conversation_loop.py:549-557`）：

```python
if agent._budget_grace_call:
    agent._budget_grace_call = False           # 立刻消费，保证只生效一次
elif not agent.iteration_budget.consume():
    _turn_exit_reason = "budget_exhausted"
    break
```

一旦进入 grace call 分支就立刻把 `_budget_grace_call` 置 `False`——这保证这一次迭代之后无论结果如何，下一轮循环条件 `or agent._budget_grace_call` 就不再为真，循环必然退出。这是一个"礼貌收尾"机制：与其留给用户一个半截的工具调用序列，不如让模型说一句"我用完了迭代额度，目前的进展是……"。

### 两个退出路径对比：grace call vs `_handle_max_iterations`

预算耗尽实际上有**两个**收尾路径，容易混淆，这里并排对比：

| 维度 | grace call | `_handle_max_iterations` |
| --- | --- | --- |
| 触发条件 | `_budget_grace_call` 被置 `True`（外部 / 派发逻辑设置） | 循环退出后 `final_response is None` 且 `api_call_count >= max_iterations`（`conversation_loop.py:3721`） |
| 发生位置 | **循环内**，作为额外一次迭代 | **循环外**，收尾阶段 C |
| 工具是否可用 | 是——仍是正常迭代，模型可继续调工具 | 否——`_handle_max_iterations` 剥掉所有工具 |
| 注入的消息 | 无额外注入，照常迭代 | 注入一条 user 消息："你已达到迭代上限，请总结，不要再调工具"（`chat_completion_helpers.py:888-892`） |
| API 调用次数 | 1 次（普通迭代） | 1 次（toolless summary 请求） |
| 典型用途 | 给模型一次"自己决定怎么收尾"的机会 | 强制模型交出纯文本总结 |

实现上，`_handle_max_iterations`（`run_agent.py:3833` forwarder → `chat_completion_helpers.py:883`）会重建一份 `api_messages`、剥掉内部字段、做和主循环一样的 `_sanitize_api_messages` / `_drop_thinking_only_and_merge_users` 安全网，然后发一次没有 `tools` 参数的请求。如果 agent 是 kanban worker（环境变量 `HERMES_KANBAN_TASK` 存在），还会替模型调一次 `kanban_block` 把任务标记为阻塞——因为工具已被剥掉，模型自己没法调（`conversation_loop.py:3743-3760`）。

---

## 3.6 中断机制

中断让用户能在 agent 干活干到一半时打断它——`Ctrl+C`、或者在交互模式下直接敲新消息、或者网关收到新的入站消息。

### `_interrupt_requested` 从哪来

`_interrupt_requested` 这个布尔标志本身不会自己变 `True`——它只能被 `AIAgent.interrupt()` 设置。`interrupt()` 的调用方有几处：

- **CLI `Ctrl+C`**——交互模式下捕获 `SIGINT`，调当前 agent 的 `interrupt()`。
- **网关收到新消息**——`gateway/run.py` 里多处（`:2657`、`:6402`、`:14058`、`:16007`）。用户在 agent 还在干活时又发了一条消息，网关把这条新消息的文本作为 `message` 参数传进 `running_agent.interrupt(event.text)`，agent 当前回合优雅退出后，这条文本作为下一回合的输入。这就是交互式"插话"的实现。
- **网关的 interrupt monitor**——`gateway/run.py:15977` 的 `monitor_for_interrupt()` 是一个 asyncio 任务，专门盯着是否有 pending 的入站文本，有就调 `interrupt()`。
- **子 agent 级联**——父 agent 被中断时递归调用每个子的 `interrupt()`（见下文第 4 层）。

入口是 `AIAgent.interrupt()`（`run_agent.py:1573`）。它被设计成**从另一个线程调用**——输入处理线程、消息接收线程、asyncio monitor 任务。它做的事远不止设一个标志：

```python
def interrupt(self, message: str = None) -> None:
    self._interrupt_requested = True              # ① 主标志
    self._interrupt_message = message
    if self._execution_thread_id is not None:     # ② 信号工具层中断
        _set_interrupt(True, self._execution_thread_id)
    # ③ fan-out 到并发工具的 worker 线程
    for _wtid in worker_tids:
        _set_interrupt(True, _wtid)
    # ④ 传播到子 agent
    for child in children_copy:
        child.interrupt(message)
```

四个层次：

1. **主标志 `_interrupt_requested`**——循环顶端检查的就是它（`conversation_loop.py:537`）。它让**正在进行的工具批次结束后**循环优雅退出。
2. **工具层中断信号**——`tools/interrupt.py` 的 `_set_interrupt()`，按线程 id 设。长跑的工具（终端命令等）会每隔约 200ms 轮询 `is_interrupted()`，看到自己的 tid 在中断集合里就提前终止。注意它**按线程 id 限定作用域**——网关里同进程跑着多个 agent，不能一个中断把所有 agent 都打断。
3. **fan-out 到 worker 线程**（`run_agent.py:1620-1629`）——并发执行的工具跑在 `ThreadPoolExecutor` 的 worker 线程上，每个有自己的 tid。`is_interrupted()` 只看调用线程自己的 tid，所以中断必须显式扩散到每个 worker tid，否则一个卡在网络 I/O 上的并发工具永远不会注意到中断、只能跑到自己的超时。
4. **传播到子 agent**（`run_agent.py:1630-1637`）——子 agent 是独立的 `AIAgent` 实例，父的中断要递归调用每个子的 `interrupt()`。

还有一个时序边界情况（`run_agent.py:1605-1610`）：如果中断在 `run_conversation()` 还没把 agent 绑定到执行线程之前就到了，`_execution_thread_id` 是 `None`，这时不能盲目对调用线程发工具中断信号（那是错的线程）——而是设一个 `_interrupt_thread_signal_pending` 标志，等启动完成再补发。

`clear_interrupt()`（`run_agent.py:1641`）是反操作，把所有标志清干净。

中断机制的整体效果：**用户中途发新消息 → 当前回合的工具批次结束后循环退出 → 新消息作为下一回合开始**。同步循环让这个"在两个回合之间干净地切换"变得几乎不需要特殊代码——这正是 3.4 节所说的"中断简单"。

### 优雅退出 vs 硬中断

注意四层机制都是**优雅退出**，没有任何一层会强杀线程或抛 `KeyboardInterrupt` 进 worker：

- 主标志让循环在**当前工具批次完整跑完之后**才退出——不会留下半执行的工具。
- 工具层信号让长跑工具**在下一个轮询点**自己提前 `return`——终端命令会停在一个干净的边界，而不是进程被 kill。
- `clear_interrupt()`（`run_agent.py:1641`）是反操作，把 `_interrupt_requested`、`_interrupt_message`、各线程的中断信号集合全部清空，为下一回合重置。

代价是中断不是"瞬时"的——一个卡在 30 秒网络超时里的工具，最坏要等它超时才会注意到中断。网关里有一个更激进的兜底（`gateway/run.py:6119` 附近的注释提到）：软中断不够时还有更硬的路径。但回合循环本身坚持优雅退出，因为它要保证 `messages` 列表在退出时永远是一个角色交替合法、可持久化、可 resume 的状态。

---

## 3.7 OpenAI 消息格式与 reasoning 字段

Hermes 内部统一用 **OpenAI chat completions 格式**表示消息——无论底层 provider 是不是 OpenAI。`init_agent` 里选定的 `api_mode` 对应的 adapter（`anthropic_adapter.py`、`codex_responses_adapter.py`、`bedrock_adapter.py` 等）负责在 API 边界把这套统一格式翻译成各 provider 的原生格式，再把响应翻译回来。

每条消息是一个 dict：`{"role": "system" | "user" | "assistant" | "tool", "content": ...}`。回合里 `messages` list 的演化：

<svg viewBox="0 0 780 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Evolution of the messages list across a turn">
  <g font-size="11">
    <rect x="40" y="20" width="500" height="44" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.2"/>
    <text x="56" y="40" font-weight="600" fill="currentColor">role: system</text>
    <text x="56" y="56" font-size="10" fill="#64748b">content: &lt;system prompt&gt;</text>
    <text x="560" y="46" font-size="10" fill="#94a3b8">阶段 A 之前已就位</text>
    <rect x="40" y="76" width="500" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
    <text x="56" y="96" font-weight="600" fill="currentColor">role: user</text>
    <text x="56" y="112" font-size="10" fill="#64748b">content: &lt;用户消息&gt;</text>
    <text x="560" y="102" font-size="10" fill="#94a3b8">阶段 A 追加 (:295)</text>
    <rect x="40" y="132" width="500" height="60" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
    <text x="56" y="152" font-weight="600" fill="currentColor">role: assistant</text>
    <text x="56" y="168" font-size="10" fill="#64748b">content: "..."　tool_calls: [...]</text>
    <text x="56" y="184" font-size="10" fill="#64748b">reasoning: &lt;推理内容&gt;</text>
    <text x="560" y="166" font-size="10" fill="#94a3b8">API 响应</text>
    <rect x="40" y="204" width="500" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="56" y="228" font-weight="600" fill="currentColor">role: tool　tool_call_id: ...　content: &lt;工具结果&gt;</text>
    <rect x="40" y="256" width="500" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="56" y="280" font-weight="600" fill="currentColor">role: tool　tool_call_id: ...　content: "..."</text>
    <rect x="40" y="308" width="500" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
    <text x="56" y="332" font-weight="600" fill="currentColor">role: assistant　content: &lt;最终文本回复&gt;</text>
    <text x="560" y="332" font-size="10" fill="#94a3b8">无 tool_calls，退出</text>
  </g>
</svg>
<span class="figure-caption">图 R3.3 ｜ 一个回合中 messages 列表的演化：system / user / assistant(带 tool_calls) / tool / 最终 assistant 依次堆叠。</span>

<details>
<summary>ASCII 原版</summary>

```text
[
  {"role": "system",    "content": "<system prompt>"},      ← 阶段 A 之前已就位
  {"role": "user",      "content": "<用户消息>"},            ← 阶段 A 追加 (:295)
  {"role": "assistant", "content": "...", "tool_calls": [...],
                        "reasoning": "<推理内容>"},           ← API 响应
  {"role": "tool",      "tool_call_id": "...", "content": "<工具结果>"},
  {"role": "tool",      "tool_call_id": "...", "content": "..."},
  {"role": "assistant", "content": "<最终文本回复>"}          ← 无 tool_calls，退出
]
```

</details>

### reasoning 字段的多形态

推理（reasoning）内容是 Hermes 处理得最细的一块，因为不同 provider 把 reasoning 放在完全不同的位置：

| Provider 形态 | reasoning 存放位置 |
| --- | --- |
| Hermes 内部统一约定 | `assistant_msg["reasoning"]` 字段 |
| 轨迹 / 会话持久化 | 内嵌进 content 的 `<think>...</think>` 标签 |
| Moonshot（Kimi） | 带 `tool_calls` 的 assistant 消息要附独立的 `reasoning_content` 字段 |
| OpenRouter | 用 `reasoning_details`（带 signature，维持多轮推理连续性） |
| Anthropic | 独立的 `thinking` block；thinking-only 回合会被 400 拒绝 |

回合逻辑的处理纪律是：**内部统一从 `assistant_msg["reasoning"]` 读**，发 API 前才由 `_copy_reasoning_content_for_api()`（`conversation_loop.py:700`）翻译成目标 provider 需要的形态。翻译完成后，`reasoning` 字段会从 `api_msg` 里被删掉（`:702-704`）——它只用于轨迹存储，发给严格 API 会触发 422。`reasoning_details` 是个例外，会被保留（`:717`），因为 OpenRouter 靠它维持多轮推理上下文。

收尾阶段 C 从最后一条 assistant 消息的 `reasoning` 字段提取 `last_reasoning`（`conversation_loop.py:3479-3480` 同时尝试 `reasoning` / `reasoning_content` / `reasoning_details` 三个来源），放进 result dict 返回。

构建 `api_messages` 时还会做一系列 `_sanitize_*`（`conversation_loop.py:37-47` import 的那组函数）——剥离 surrogate 字符、非 ASCII 清理、按需剥离图片等。这些应对真实世界的脏输入：富文本粘贴注入的孤立 surrogate 会让 OpenAI SDK 的 JSON 序列化崩溃。原始 `messages` 不受影响，sanitize 只作用在发出去的拷贝上。

---

## 3.8 一轮对话的完整时序

把前面所有阶段串起来——下面是一轮"用户提问 → 模型调两批工具 → 给出最终回复"的完整时序，含中断检查点：

<svg viewBox="0 0 820 600" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Sequence diagram of one conversation turn across five lanes">
  <defs>
    <marker id="ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g font-size="10.5" font-weight="700">
    <rect x="20" y="14" width="90" height="26" rx="5" fill="#fed7aa" stroke="#ea580c"/><text x="65" y="31" fill="currentColor" text-anchor="middle">用户</text>
    <rect x="150" y="14" width="130" height="26" rx="5" fill="#99f6e4" stroke="#0d9488"/><text x="215" y="31" fill="currentColor" text-anchor="middle">run_conversation</text>
    <rect x="330" y="14" width="120" height="26" rx="5" fill="#ddd6fe" stroke="#7c3aed"/><text x="390" y="31" fill="currentColor" text-anchor="middle">while 循环</text>
    <rect x="510" y="14" width="120" height="26" rx="5" fill="#e0f2fe" stroke="#0ea5e9"/><text x="570" y="31" fill="currentColor" text-anchor="middle">provider API</text>
    <rect x="680" y="14" width="120" height="26" rx="5" fill="#fff7ed" stroke="#ea580c"/><text x="740" y="31" fill="currentColor" text-anchor="middle">工具执行</text>
  </g>
  <g stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3,3">
    <line x1="65" y1="40" x2="65" y2="580"/>
    <line x1="215" y1="40" x2="215" y2="580"/>
    <line x1="390" y1="40" x2="390" y2="580"/>
    <line x1="570" y1="40" x2="570" y2="580"/>
    <line x1="740" y1="40" x2="740" y2="580"/>
  </g>
  <g font-size="10">
    <line x1="65" y1="58" x2="213" y2="58" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar3)"/>
    <text x="130" y="52" fill="#64748b">user_message</text>
    <rect x="150" y="68" width="130" height="80" rx="4" fill="#f0fdfa" stroke="#0d9488"/>
    <text x="215" y="84" fill="currentColor" text-anchor="middle" font-weight="600">阶段 A 初始化</text>
    <text x="215" y="100" fill="#64748b" text-anchor="middle">safe_stdio · DB session</text>
    <text x="215" y="114" fill="#64748b" text-anchor="middle">重置计数器 · 拷贝 hist</text>
    <text x="215" y="128" fill="#64748b" text-anchor="middle">hydrate · append user</text>
    <text x="215" y="142" fill="#64748b" text-anchor="middle">判定 _should_review</text>
    <line x1="280" y1="158" x2="388" y2="158" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar3)"/>
    <text x="334" y="152" fill="#64748b">进入 while</text>
    <rect x="320" y="172" width="140" height="78" rx="4" fill="#faf5ff" stroke="#7c3aed"/>
    <text x="390" y="188" fill="currentColor" text-anchor="middle" font-weight="600">迭代 1</text>
    <text x="390" y="202" fill="#64748b" text-anchor="middle">new_turn · 中断✗</text>
    <text x="390" y="216" fill="#64748b" text-anchor="middle">consume 预算 -1</text>
    <text x="390" y="230" fill="#64748b" text-anchor="middle">sanitize + repair</text>
    <text x="390" y="244" fill="#64748b" text-anchor="middle">构建 api_messages</text>
    <line x1="460" y1="262" x2="568" y2="262" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar3)"/>
    <text x="514" y="256" fill="#64748b">API 请求</text>
    <line x1="568" y1="278" x2="462" y2="278" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar3)"/>
    <text x="514" y="272" fill="#64748b">tool_calls[2]</text>
    <line x1="460" y1="296" x2="738" y2="296" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar3)"/>
    <text x="600" y="290" fill="#64748b">_execute_tool_calls（并发）</text>
    <line x1="738" y1="312" x2="462" y2="312" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar3)"/>
    <text x="600" y="306" fill="#64748b">2 个 tool 结果 append 回</text>
    <line x1="65" y1="332" x2="318" y2="332" stroke="#7c3aed" stroke-width="1.2" stroke-dasharray="4,2" marker-end="url(#ar3)"/>
    <text x="170" y="326" fill="#7c3aed">/steer "..."（pending）</text>
    <rect x="320" y="344" width="140" height="62" rx="4" fill="#faf5ff" stroke="#7c3aed"/>
    <text x="390" y="360" fill="currentColor" text-anchor="middle" font-weight="600">迭代 2</text>
    <text x="390" y="374" fill="#64748b" text-anchor="middle">中断✗ · consume -1</text>
    <text x="390" y="388" fill="#64748b" text-anchor="middle">drain /steer 注入</text>
    <text x="390" y="402" fill="#64748b" text-anchor="middle">构建 api_messages</text>
    <line x1="460" y1="420" x2="568" y2="420" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar3)"/>
    <text x="514" y="414" fill="#64748b">API 请求</text>
    <line x1="568" y1="436" x2="462" y2="436" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar3)"/>
    <text x="514" y="430" fill="#64748b">tool_calls[1]</text>
    <line x1="460" y1="452" x2="738" y2="452" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar3)"/>
    <line x1="738" y1="468" x2="462" y2="468" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar3)"/>
    <text x="600" y="462" fill="#64748b">1 个 tool 结果</text>
    <rect x="320" y="480" width="140" height="48" rx="4" fill="#faf5ff" stroke="#7c3aed"/>
    <text x="390" y="496" fill="currentColor" text-anchor="middle" font-weight="600">迭代 3</text>
    <text x="390" y="510" fill="#64748b" text-anchor="middle">consume -1 · API 请求</text>
    <text x="390" y="522" fill="#64748b" text-anchor="middle">无工具 → 退出</text>
    <line x1="460" y1="500" x2="568" y2="500" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar3)"/>
    <line x1="568" y1="516" x2="462" y2="516" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar3)"/>
    <rect x="150" y="538" width="130" height="34" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="215" y="552" fill="currentColor" text-anchor="middle" font-weight="600">阶段 C 收尾</text>
    <text x="215" y="566" fill="#64748b" text-anchor="middle">hook · nudge · result</text>
    <line x1="213" y1="570" x2="67" y2="570" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar3)"/>
    <text x="135" y="564" fill="#64748b">result dict</text>
  </g>
</svg>
<span class="figure-caption">图 R3.4 ｜ 一轮"用户提问 → 模型调两批工具 → 最终回复"的完整时序：迭代 1 期间发的 /steer 在迭代 2 开头才被注入。</span>

<details>
<summary>ASCII 原版</summary>

```text
用户                run_conversation        while 循环              provider API      工具执行
 │                       │                     │                       │              │
 │── user_message ──────▶│                     │                       │              │
 │                       │ 阶段A: 初始化         │                       │              │
 │                       │  _install_safe_stdio │                       │              │
 │                       │  _ensure_db_session  │                       │              │
 │                       │  重置 per-turn 计数器  │                       │              │
 │                       │  messages=list(hist) │                       │              │
 │                       │  _hydrate_todo_store  │                       │              │
 │                       │  append user 消息     │                       │              │
 │                       │  判定 _should_review  │                       │              │
 │                       │─────────────────────▶│ 进入 while             │              │
 │                       │                      │                       │              │
 │                       │           ┌─ 迭代 1 ─┤                       │              │
 │                       │           │ new_turn()                       │              │
 │                       │           │ 检查 _interrupt_requested ✗       │              │
 │                       │           │ consume() 预算 -1                 │              │
 │                       │           │ step_callback(1, ...)             │              │
 │                       │           │ drain /steer（无）                │              │
 │                       │           │ sanitize + repair messages        │              │
 │                       │           │ 构建 api_messages（注入记忆）       │              │
 │                       │           │──── API 请求 ───────────────────▶│              │
 │                       │           │◀─── assistant + tool_calls[2] ───│              │
 │                       │           │ 解析: 有 tool_calls               │              │
 │                       │           │──── _execute_tool_calls ─────────┼─────────────▶│
 │   ┌── /steer "..." ───┼───────────┼─ (pending) ──────────────────────┼── 并发执行 ──│
 │   │                   │           │◀─── 2 个 tool 结果 append 回 ─────┼──────────────│
 │   │                   │           └─ append tool msgs to messages    │              │
 │   │                   │           ┌─ 迭代 2 ─┐                       │              │
 │   │                   │           │ 检查 _interrupt_requested ✗       │              │
 │   │                   │           │ consume() 预算 -1                 │              │
 │   └───────────────────┼───────────┤ drain /steer → 注入最后一条 tool 消息             │
 │                       │           │ 构建 api_messages                 │              │
 │                       │           │──── API 请求 ───────────────────▶│              │
 │                       │           │◀─── assistant + tool_calls[1] ───│              │
 │                       │           │──── _execute_tool_calls ─────────┼─────────────▶│
 │                       │           │◀─── 1 个 tool 结果 ───────────────┼──────────────│
 │                       │           ┌─ 迭代 3 ─┐                       │              │
 │                       │           │ consume() 预算 -1                 │              │
 │                       │           │──── API 请求 ───────────────────▶│              │
 │                       │           │◀─── assistant, content, 无工具 ──│              │
 │                       │           │ final_response = content          │              │
 │                       │           └─ while 条件不满足，退出            │              │
 │                       │ 阶段C: 收尾           │                       │              │
 │                       │  post-response hook  │                       │              │
 │                       │  footer 注入          │                       │              │
 │                       │  触发记忆/技能 nudge   │                       │              │
 │                       │  组装 result dict     │                       │              │
 │◀── result dict ───────│                      │                       │              │
```

</details>

要点：迭代 1 期间用户发的 `/steer` 在迭代 2 开头才被 drain 并注入到最后一条 tool 消息（3.3 节解释过原因）；中断检查在每次迭代开头，所以一次中断最晚在"当前工具批次完成 + 一次迭代边界"后生效。

---

## 3.9 非交互模式共用此循环

`run_conversation()` 不是只给交互式前端用的——批量与定时任务这两种**非交互**模式也直接复用它，一个字节的循环代码都不改：

- **批量 runner**（`batch_runner.py:325-349`）。批量模式给一个 prompt 列表逐个跑：构造 `AIAgent`，对每个 prompt 调 `agent.run_conversation(prompt, task_id=task_id)`，从返回的 result dict 里取 `final_response` 和 token 计量写结果文件。它需要完整 dict 而不是 `chat()`，因为要记录每个任务的 `api_calls`、token 用量、`completed` 状态。

- **cron 调度器**（`cron/scheduler.py:1437-1561`）。定时任务到点时构造 `AIAgent`，把任务 prompt 投进线程池：`_cron_pool.submit(_cron_context.run, agent.run_conversation, prompt)`（`:1497`）。注意它仍然走 `run_conversation`——cron 任务和交互回合走的是同一个同步 `while` 循环、同样的迭代预算、同样的中断检查。调度器还对返回值做防御性检查（`:1558-1561`），因为错误条件下 `run_conversation` 可能返回非 dict。

这正是 3.4 节"同步循环管单个回合的逻辑"的直接收益：循环对"谁在调它、是不是有人在交互"完全无感。交互前端、批量 runner、cron 调度器的差异全部在**循环之外**——前端负责构造 `AIAgent`（传不同的回调、`quiet_mode`、`session_db`）、负责决定调几次、负责处理 result dict。循环本身只认一件事：给我一个 `user_message`，我还你一个 result dict。非交互模式下回调通常为 `None`、`quiet_mode` 通常为 `True`，但循环的控制流一模一样。

---

## 3.10 Todo 恢复与记忆 nudge 在循环里的位置

最后定位两个机制在回合里的"坐标"——它们的完整实现属于 [第 10 章 记忆与学习循环](10-memory-learning.md)，这里只说它们插在循环的哪个缝里。

**Todo 恢复**（`conversation_loop.py:231-235`）在阶段 A，循环开始**之前**：

```python
if conversation_history and not agent._todo_store.has_items():
    agent._hydrate_todo_store(conversation_history)
```

agent 有一个 in-memory 的 todo store。网关为每条消息建新 `AIAgent`，这个 store 每次都是空的，所以要从历史里最近一条 todo 工具响应把 todo 状态恢复回来。放在循环前，是因为模型在第一次 API 调用时就需要看到当前的 todo 状态。

**记忆 nudge**（`conversation_loop.py:286-291`）也在阶段 A：

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

这里只是**判定**——记忆 nudge 是回合级的，每个回合 `_turns_since_memory` 加一，到阈值就把 `_should_review_memory` 置 `True` 并清零计数。真正的 review 动作在阶段 C 收尾时触发（`conversation_loop.py:3981-3990`），因为它要在最终回复产出之后、作为一次后台 review 来做。技能 nudge 与此不同——它是迭代级的，在循环体内累加 `_iters_since_skill`（`:589-591`），同样在阶段 C 才触发。

之所以判定和触发分离，是因为 nudge 的本质是"在不打断用户的前提下，让 agent 周期性地自省并把知识沉淀下来"——判定必须在回合早期（要计数），触发必须在回合末尾（要等回复完成）。这个"判定/触发分离"的模式贯穿 Hermes 的整个学习循环。

---

## 延伸阅读

- [第 2 章 入口与进程引导](02-entrypoints.md)——`AIAgent` 是被哪些入口、用什么参数构造出来的。
- [第 4 章 Provider 适配与凭证池](04-provider-credentials.md)——`init_agent` 里的 provider 解析、`api_mode` 决策、凭证池的完整机制。
- [第 5 章 工具系统](05-tool-system.md)——循环里"执行工具"那一步的细节：`tool_executor`、并发 vs 顺序、`handle_function_call()`。
- [第 6 章 上下文压缩与会话存储](06-context-session.md)——`ContextCompressor`、`SessionDB`、回合结束后历史如何持久化。
- [第 10 章 记忆与学习循环](10-memory-learning.md)——todo 恢复、记忆/技能 nudge 的完整实现。
- [第 12 章 子 agent 派发与 cron 调度](12-subagents-cron.md)——子 agent 的独立 `IterationBudget` 与中断传播。
