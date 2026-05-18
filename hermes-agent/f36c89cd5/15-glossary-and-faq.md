# 第 15 章 术语表与 FAQ

本章是整本 wiki 的速查层。第一部分是术语表——把前 14 章反复出现的类名、概念、缩写收拢成一张可检索的表，每条都附代码位置。第二部分是 FAQ，回答读源码时最常卡住的问题。第三部分是调试与开发速查。术语表中的条目会被网页版的术语解析器提取，正文里命中的术语会自动加下划线、点击弹出定义。

---

## Part 1：术语表

### ACP

- 英文原名：`Agent Client Protocol`
- 中文译名：Agent 客户端协议
- 定义：一种让 Hermes 作为 agent 后端接入 IDE（VS Code、Zed、JetBrains）的协议适配层。
- 代码位置：`acp_adapter/` 目录提供 ACP server 实现。

### AIAgent

- 英文原名：`AIAgent`
- 中文译名：AI 代理类
- 定义：Hermes 的核心类，承载一次会话的全部状态（凭证、工具集、消息历史、预算、回调），并驱动同步的工具调用循环。`__init__` 有约 60 个参数。
- 代码位置：`run_agent.py:326` 定义 `class AIAgent`，`run_agent.py:349` 是 `__init__`，转发到 `agent/agent_init.py:74` 的 `init_agent`。

### api_mode

- 英文原名：`api_mode`
- 中文译名：API 模式
- 定义：标识某个 provider 用哪种 API 形态——`chat_completions`（OpenAI 兼容）、`codex_responses`（OpenAI Responses API）、或各家原生 API。决定走哪个 adapter。
- 代码位置：`providers/base.py:38` 的 `ProviderProfile` 字段；各 adapter 见 `agent/*_adapter.py`。

### auxiliary client

- 英文原名：`auxiliary client`
- 中文译名：辅助 LLM 客户端
- 定义：为侧任务（标题生成、curator 审查、视觉分析、压缩摘要、session 搜索）服务的共享 LLM 客户端，可独立选 provider/model，带 402 额度耗尽 fallback 链，不污染主会话的 prompt 缓存。
- 代码位置：`agent/auxiliary_client.py` 的 `call_llm()`；配置在 `config.yaml` 的 `auxiliary.*`。

### BasePlatformAdapter

- 英文原名：`BasePlatformAdapter`
- 中文译名：平台适配器基类
- 定义：所有消息平台适配器（Telegram、Discord、Slack 等 40+ 平台）的通用异步接口，定义 `connect()` / `send()` / `send_image()` 等方法。
- 代码位置：`gateway/platforms/base.py:1268` 定义；`connect()` 在 `:1542`，`send()` 在 `:1556`。

### BaseEnvironment

- 英文原名：`BaseEnvironment`
- 中文译名：执行环境基类
- 定义：七种终端后端（local/docker/ssh/singularity/modal/daytona/vercel）的抽象基类。子类只需实现 `_run_bash()` 和 `cleanup()`，基类的 `execute()` 提供会话快照、CWD 跟踪、中断与超时。
- 代码位置：`tools/environments/base.py:288` 定义；`_run_bash()` 在 `:327`，`init_session()` 在 `:351`，`execute()` 在 `:776`。

### BatchRunner

- 英文原名：`BatchRunner`
- 中文译名：批量运行器
- 定义：用多 worker 并行处理 JSONL 数据集的运行器，每个样本起一个 `AIAgent`，用于批量轨迹生成。
- 代码位置：`batch_runner.py:527` 定义 `class BatchRunner`。

### COMMAND_REGISTRY

- 英文原名：`COMMAND_REGISTRY`
- 中文译名：命令注册表
- 定义：所有 slash 命令的中央定义列表（`CommandDef` 对象）。CLI 分发、网关分发、Telegram 菜单、Slack 子命令映射、自动补全、帮助文本全部从它派生。
- 代码位置：`hermes_cli/commands.py` 的 `COMMAND_REGISTRY`。

### ContextCompressor

- 英文原名：`ContextCompressor`
- 中文译名：上下文压缩器
- 定义：默认的 `ContextEngine` 实现。对话过长时保护头部（系统+前 N 条）和尾部（按 token 预算），用辅助 LLM 把中间消息压成结构化摘要。
- 代码位置：`agent/context_compressor.py:454` 定义 `class ContextCompressor`，`compress()` 在 `:1482`。

### ContextEngine

- 英文原名：`ContextEngine`
- 中文译名：上下文引擎
- 定义：上下文管理的抽象基类，定义 `should_compress()` / `compress()` / `update_from_response()` 等接口。可作为插件替换。
- 代码位置：`agent/context_engine.py:32` 定义 ABC。

### conversation_loop

- 英文原名：`conversation_loop`
- 中文译名：对话循环
- 定义：`AIAgent` 的核心同步循环所在模块。`run_conversation()` 的真正实现，包含 API 调用、工具执行、中断检查、预算消费。
- 代码位置：`agent/conversation_loop.py:85` 是 `run_conversation()`，`:532` 是 `while` 主循环。

### CredentialPool

- 英文原名：`CredentialPool`
- 中文译名：凭证池
- 定义：管理多个 API 凭证的轮换与故障转移。支持 fill_first/round_robin/random/least_used 策略，对 401/429/402 做差异化冷却，处理 OAuth token 刷新。
- 代码位置：`agent/credential_pool.py:387` 定义 `class CredentialPool`。

### Curator

- 英文原名：`Curator`
- 中文译名：技能维护器
- 定义：后台周期运行的技能生命周期维护器。基于时间戳自动归档陈旧技能、用辅助 LLM 审查技能质量。只触及 agent 创建的技能，永不自动删除（只归档）。
- 代码位置：`agent/curator.py`；`maybe_run_curator()` 在 `:1763`，`apply_automatic_transitions()` 在 `:256`。

### delegate_task

- 英文原名：`delegate_task`
- 中文译名：任务委托工具
- 定义：派发子 agent 的工具。子 agent 获得全新对话、独立 task_id、受限工具集、聚焦的系统提示。
- 代码位置：`tools/delegate_tool.py`。

### DELEGATE_BLOCKED_TOOLS

- 英文原名：`DELEGATE_BLOCKED_TOOLS`
- 中文译名：子 agent 禁用工具集
- 定义：子 agent 永远不可用的工具集合——`delegate_task`（禁递归）、`clarify`（无用户交互）、`memory`（不污染 MEMORY.md）、`send_message`（无跨平台副作用）、`execute_code`。
- 代码位置：`tools/delegate_tool.py:40`。

### discover_builtin_tools

- 英文原名：`discover_builtin_tools`
- 中文译名：内置工具自动发现
- 定义：用 AST 扫描 `tools/*.py`，找到包含顶级 `registry.register()` 调用的模块并 import，免去手写 import 列表。
- 代码位置：`tools/registry.py:57` 定义，`:29` 的 `_is_registry_register_call()` 是 AST 检查器。

### FastMCP

- 英文原名：`FastMCP`
- 中文译名：FastMCP 框架
- 定义：MCP SDK 提供的服务端框架。Hermes 用它把自己暴露为 MCP server，供 Claude Desktop、Cursor 等外部客户端连接。
- 代码位置：`mcp_serve.py:458` 用 `FastMCP(...)` 建 server，`create_mcp_server()` 在 `:450`。

### FTS5

- 英文原名：`FTS5`
- 中文译名：SQLite 全文搜索扩展
- 定义：SQLite 的全文索引扩展。Hermes 建了 `messages_fts`（unicode61 分词，英文用）和 `messages_fts_trigram`（三元组分词，CJK 子串用）两张虚拟表。
- 代码位置：`hermes_state.py:254` 建 `messages_fts`，`:283` 建 `messages_fts_trigram`，`search_messages()` 在 `:1880`。

### GatewayRunner

- 英文原名：`GatewayRunner`
- 中文译名：网关控制器
- 定义：消息网关的主控制器，单进程管理所有平台适配器的生命周期，为每个会话缓存一个 `AIAgent`。
- 代码位置：`gateway/run.py:1175` 定义，`start_gateway()` 在 `:16695`。

### handle_function_call

- 英文原名：`handle_function_call`
- 中文译名：工具调用分发器
- 定义：单个工具调用的主分发函数。做参数类型强转、pre/post 钩子、`registry.dispatch()` 路由、结果包装。
- 代码位置：`model_tools.py:731` 定义。

### HERMES.md

- 英文原名：`HERMES.md`
- 中文译名：项目上下文文件
- 定义：注入对话的项目级上下文文件，描述当前工作目录/项目的约定，塑造每次对话。
- 代码位置：`agent/prompt_builder.py:1332` 的 `_load_hermes_md()` 加载。

### HermesCLI

- 英文原名：`HermesCLI`
- 中文译名：交互式 CLI 编排类
- 定义：交互式终端界面的编排类，管理 REPL 循环、配置、UI 状态、slash 命令分发，持有一个 `AIAgent`。
- 代码位置：`cli.py:2503` 定义 `class HermesCLI`，`run()` 在 `:11604`，`process_command()` 在 `:7683`。

### IterationBudget

- 英文原名：`IterationBudget`
- 中文译名：迭代预算
- 定义：控制对话循环总迭代次数的预算对象。与 `max_iterations`（默认 90）配合，支持子 agent 间共享预算与一次性 grace call。
- 代码位置：`agent/iteration_budget.py`。

### MCP

- 英文原名：`Model Context Protocol`
- 中文译名：模型上下文协议
- 定义：Anthropic 推动的开放协议，让工具 server 用标准协议暴露能力。Hermes 既是 MCP 客户端（连外部 server），也是 MCP 服务端。
- 代码位置：客户端 `tools/mcp_tool.py`，服务端 `mcp_serve.py`，OAuth `tools/mcp_oauth.py` / `tools/mcp_oauth_manager.py`。

### MemoryManager

- 英文原名：`MemoryManager`
- 中文译名：记忆管理器
- 定义：记忆 provider 的编排器。转折前 `prefetch_all()` 回忆、转折后 `sync_all()` 异步写，并把记忆拼进系统提示块。最多挂一个外部 provider。
- 代码位置：`agent/memory_manager.py:190` 定义，`prefetch_all()` 在 `:285`，`sync_all()` 在 `:317`。

### MemoryProvider

- 英文原名：`MemoryProvider`
- 中文译名：记忆提供者
- 定义：记忆后端的抽象基类，定义 `prefetch()` / `sync_turn()` 和一组生命周期钩子。具体实现有文件记忆、Honcho、mem0 等。
- 代码位置：`agent/memory_provider.py:42` 定义 ABC。

### prompt caching

- 英文原名：`prompt caching`
- 中文译名：提示缓存
- 定义：复用 LLM 请求中稳定前缀的缓存机制。Hermes 因此要求系统提示保持稳定，并把技能、记忆作为 user 消息注入而非塞进系统提示。
- 代码位置：`agent/prompt_caching.py`。

### ProviderProfile

- 英文原名：`ProviderProfile`
- 中文译名：Provider 配置档
- 定义：声明式描述一个模型 provider 的对象——name、api_mode、auth_type、base_url、温度策略，以及构造请求额外字段的钩子。
- 代码位置：`providers/base.py:38` 定义；各 provider 插件在 `plugins/model-providers/`。

### PairingStore

- 英文原名：`PairingStore`
- 中文译名：DM 配对存储
- 定义：网关的私信配对安全机制。生成 8 字符配对码、1 小时过期、带速率限制，防止陌生人直接 DM agent。
- 代码位置：`gateway/pairing.py:76` 定义。

### PluginContext

- 英文原名：`PluginContext`
- 中文译名：插件上下文
- 定义：交给每个插件 `register()` 函数的 API 对象，提供 `register_tool()` / `register_platform()` / hook 注册等能力。
- 代码位置：`hermes_cli/plugins.py:287` 定义，`register_tool()` 在 `:317`，`register_platform()` 在 `:645`。

### profile（HERMES_HOME）

- 英文原名：`profile / HERMES_HOME`
- 中文译名：配置档 / Hermes 主目录
- 定义：profile 机制让多套 Hermes 配置/状态隔离。`get_hermes_home()` 返回当前 profile 的根目录（默认 `~/.hermes`），所有状态文件都应基于它。
- 代码位置：`hermes_constants.py` 的 `get_hermes_home()` / `display_hermes_home()`。

### run_conversation

- 英文原名：`run_conversation`
- 中文译名：对话执行入口
- 定义：`AIAgent` 的完整对话接口，跑一轮（可能多次 API 调用 + 工具执行）并返回含 `final_response` 和 `messages` 的 dict。
- 代码位置：`run_agent.py:3838` 定义，转发到 `agent/conversation_loop.py:85`。

### SessionDB

- 英文原名：`SessionDB`
- 中文译名：会话数据库
- 定义：基于 SQLite 的会话存储层。WAL 模式支持并发读+单写，NFS 上回退 DELETE 模式，FTS5 提供全文搜索。
- 代码位置：`hermes_state.py:309` 定义 `class SessionDB`，`SCHEMA_VERSION` 在 `:36`。

### SessionSource

- 英文原名：`SessionSource`
- 中文译名：会话来源
- 定义：描述一条消息来自哪里的数据类——platform、chat_id、thread_id，并对 PII 做哈希。网关据它路由会话。
- 代码位置：`gateway/session.py:71` 定义。

### skin engine

- 英文原名：`skin engine`
- 中文译名：皮肤引擎
- 定义：数据驱动的 CLI 视觉定制引擎。皮肤是纯数据（YAML），定制 banner 颜色、spinner 脸谱/动词、工具前缀、response box 样式，无需改代码。
- 代码位置：`hermes_cli/skin_engine.py`。

### Skill

- 英文原名：`Skill`
- 中文译名：技能
- 定义：可复用的程序性记忆单元——一个目录 + frontmatter + 指令文件。被发现后注入为 slash 命令，作为 user 消息（非系统提示）注入以保留缓存。兼容 agentskills.io 标准。
- 代码位置：`agent/skill_commands.py`（发现与注入）、`skills/`（内置）、`optional-skills/`（默认不激活）。

### SOUL.md

- 英文原名：`SOUL.md`
- 中文译名：人格文件
- 定义：定义 agent 身份/人格的文件，注入系统提示，塑造 agent 的语气与行为风格。
- 代码位置：`agent/prompt_builder.py:1304` 的 `load_soul_md()` 加载。

### SUMMARY_PREFIX

- 英文原名：`SUMMARY_PREFIX`
- 中文译名：摘要前缀标记
- 定义：上下文压缩生成的摘要消息上的标记前缀，用于让模型识别「这是压缩摘要」、避免重复执行已完成的动作。
- 代码位置：`agent/context_compressor.py:37`。

### tool_executor

- 英文原名：`tool_executor`
- 中文译名：工具执行器
- 定义：负责执行一批工具调用的模块，决定并行还是串行执行，并做文件路径冲突检测。
- 代码位置：`agent/tool_executor.py:64` 的 `execute_tool_calls_concurrent()`，`:474` 的 `execute_tool_calls_sequential()`。

### ToolEntry

- 英文原名：`ToolEntry`
- 中文译名：工具条目
- 定义：注册表中单个工具的元数据容器——name、toolset、schema、handler、check_fn、requires_env、结果尺寸上限等。
- 代码位置：`tools/registry.py:77` 定义。

### ToolRegistry

- 英文原名：`ToolRegistry`
- 中文译名：工具注册表
- 定义：所有工具的中央单例注册表，负责 schema 收集、按名分发、可用性检查（带 TTL 缓存）、错误包装。
- 代码位置：`tools/registry.py:151` 定义，`register()` 在 `:234`。

### Toolset

- 英文原名：`Toolset`
- 中文译名：工具集
- 定义：工具的分组。一个工具即便已注册，也必须出现在某个 toolset 里、且该 toolset 对 agent 启用，才会真正暴露给模型。
- 代码位置：`toolsets.py:78` 起的 `TOOLSETS` 字典。

### TUI

- 英文原名：`TUI`
- 中文译名：终端用户界面
- 定义：基于 Ink（React）的全功能终端 UI，通过 `hermes --tui` 或 `HERMES_TUI=1` 启用。TypeScript 负责屏幕渲染，Python 后端负责会话/工具/模型。
- 代码位置：`ui-tui/`（Ink 前端），`tui_gateway/`（Python JSON-RPC 后端）。

### _HERMES_CORE_TOOLS

- 英文原名：`_HERMES_CORE_TOOLS`
- 中文译名：核心工具列表
- 定义：所有平台（CLI 与各消息平台）共享的默认工具名列表，是每个平台基础工具集的继承来源。
- 代码位置：`toolsets.py:31`。

### cron tick

- 英文原名：`cron tick`
- 中文译名：cron 周期检查
- 定义：cron 调度器每 60 秒执行一次的检查入口，找出到期作业并以非交互方式运行。用文件锁做进程级互斥。
- 代码位置：`cron/scheduler.py:1669` 的 `tick()`，`run_job()` 在 `:1024`。

---

## Part 2：FAQ

### 交互式 CLI 与消息网关有什么区别？

交互式 CLI（`hermes`）是单用户、单进程、有人实时盯着的终端 REPL，工作目录用进程 CWD。网关（`hermes gateway`）是单进程同时服务 Telegram/Discord/Slack 等多平台、为每会话缓存一个 `AIAgent`、工作目录用 `config.yaml` 的 `terminal.cwd`。两者共享同一套 `AIAgent` 核心和 slash 命令注册表（`hermes_cli/commands.py` 的 `COMMAND_REGISTRY`）。详见[第 2 章](02-entrypoints.md)、[第 13 章](13-messaging-gateway.md)。

### 如何新增一个内置工具？

两步：(1) 在 `tools/your_tool.py` 里写 handler 并调 `registry.register(...)`（`tools/registry.py:234`）；(2) 把工具名加进 `toolsets.py` 的 `_HERMES_CORE_TOOLS` 或某个 toolset。第二步是必须的——自动发现只会 import 并注册，但工具只有出现在 toolset 里才会暴露给 agent。详见[第 5 章](05-tool-system.md)。

### 工具注册了为什么 agent 还是用不了？

注册（`registry.register()`）只是让工具进了注册表。工具要真正暴露给某个 agent，还得满足：它出现在某个 toolset 里（`toolsets.py`）、该 toolset 对当前平台/agent 启用、且它的 `check_fn` 通过（依赖、env 变量齐全）。「注册 ≠ 暴露」是工具系统最常见的坑。详见[第 5 章](05-tool-system.md)。

### 技能为什么作为 user 消息注入，而不是塞进系统提示？

为了保护 prompt caching。系统提示是 LLM 请求里被缓存的稳定前缀（见 `agent/prompt_caching.py`）；如果每激活一个技能就改系统提示，缓存就失效、成本上升。把技能内容作为 user 消息注入，系统提示保持不变，缓存命中。详见[第 4 章](04-system-prompt.md)、[第 11 章](11-skills-and-curator.md)。

### 什么是 profile / HERMES_HOME？

profile 让你在一台机器上跑多套互不干扰的 Hermes（不同配置、不同会话库、不同记忆）。`get_hermes_home()`（`hermes_constants.py`）返回当前 profile 的根目录，默认 `~/.hermes`。所有持久化状态都应基于它，而非硬编码 `~/.hermes`——否则不同 profile 会互相串。

### 如何切换模型 provider？

跑 `hermes model` 交互选择，或 `/model provider:model` 在对话中切。provider 由声明式的 `ProviderProfile`（`providers/base.py:38`）描述，绝大多数 provider 是 `plugins/model-providers/` 下的插件。切换不需要改代码。详见[第 7 章](07-model-providers.md)。

### 上下文什么时候触发压缩？

当已用 token 占比超过阈值（默认 `threshold_percent=0.75`）时，`ContextEngine.should_compress()` 返回真，`ContextCompressor.compress()`（`agent/context_compressor.py:1482`）被调用——保护头部和尾部、用辅助 LLM 把中间压成摘要。详见[第 8 章](08-context-compression.md)。

### 子 agent 为什么不能再 delegate？

`tools/delegate_tool.py:40` 的 `DELEGATE_BLOCKED_TOOLS` 把 `delegate_task` 列为子 agent 禁用工具——防止无限递归派发。同被禁的还有 `clarify`（子 agent 无用户交互）、`memory`（不污染 MEMORY.md）、`send_message`、`execute_code`。详见[第 14 章](14-cron-delegate-batch.md)。

### Curator 多久跑一次？

由 `config.yaml` 的 `curator` 配置控制——`interval_hours` 定周期、`min_idle_hours` 要求一段空闲后才跑。`should_run_now()`（`agent/curator.py:199`）做判定，`maybe_run_curator()`（`:1763`）是入口。它只归档不删除、只动 agent 创建的技能。详见[第 11 章](11-skills-and-curator.md)。

### 配置加载为什么有三条路径？

CLI 用 `load_cli_config()`（`cli.py:271`，合并 CLI 专属默认）、多数子命令用 `load_config()`（`hermes_cli/config.py`，合并 `DEFAULT_CONFIG`）、网关运行时直接读原始 YAML。三者服务不同运行上下文。如果你加了新配置项 CLI 能看到网关看不到（或反之），多半是用错了 loader。详见[第 2 章](02-entrypoints.md)。

### 中文全文搜索是怎么实现的？

SQLite FTS5 默认的 unicode61 分词不切中文词。Hermes 额外建了 `messages_fts_trigram`（`hermes_state.py:283`）——trigram 分词器把内容切成重叠的三字节序列，搜「防火墙」就能命中「配置防火墙」。`search_messages()` 据查询特征在两张表间路由。详见[第 9 章](09-session-storage.md)。

### TUI 和经典 CLI 是什么关系？

TUI（`hermes --tui`）是经典 prompt_toolkit CLI 的完整替代品——Ink/React 前端（`ui-tui/`）负责屏幕，Python 后端（`tui_gateway/`）负责会话/工具/模型，二者用 stdio 上的 JSON-RPC 通信。两者共用同一个 `AIAgent` 核心。`hermes dashboard` 的网页聊天面板内嵌的就是真正的 `hermes --tui`。详见[第 2 章](02-entrypoints.md)。

### AIAgent 为什么用同步循环，不用 async？

对话循环（`agent/conversation_loop.py:532`）是纯同步的。同步循环更易中断（一个标志位即可）、更易调试（栈是直的）、状态可见性好。MCP 这类必须 async 的部分被隔离在后台 event loop 线程里，不侵入主循环。详见[第 3 章](03-conversation-loop.md)。

### 一次对话会调用几次模型？

至少一次。若模型返回 `tool_call`，工具执行后结果回灌、再调一次模型——如此循环，直到模型返回纯文本（无 tool_call）或触顶 `max_iterations`（默认 90）/ 迭代预算耗尽。本 wiki 的 trace 导览追踪的就是「两次 API 调用夹一次工具执行」的最小案例。

---

## Part 3：调试与开发速查

### 常用命令

```bash
hermes                  # 启动交互式 CLI
hermes model            # 选择 provider 与默认模型
hermes tools            # 配置启用哪些工具
hermes config set       # 设置单个配置项
hermes gateway setup    # 配置消息网关
hermes gateway start    # 启动消息网关
hermes setup            # 完整安装向导
hermes doctor           # 诊断环境问题
hermes update           # 更新到最新版
hermes logs --follow    # 实时跟踪日志
hermes --tui            # 启动 Ink TUI
hermes -q "问题"        # 单次查询模式（非交互）

scripts/run_tests.sh    # 跑测试套件（先探测 .venv → venv）
```

### 关键环境变量

| 变量 | 作用 |
|------|------|
| `HERMES_HOME` | 覆盖 Hermes 主目录（profile 机制基础） |
| `HERMES_TUI` | 设为 `1` 等价于 `--tui` |
| `TERMINAL_ENV` | 选终端后端：`local`（默认）/`docker`/`ssh`/`singularity`/`modal`/`daytona`/`vercel_sandbox` |
| `HERMES_BUNDLED_PLUGINS` | 覆盖内置插件目录（Nix 打包用） |

注意：API key、token、密码这类**密钥**放 `~/.hermes/.env`；超时、阈值、开关、路径这类**非密钥设置**放 `config.yaml`。新增密钥变量要登记进 `hermes_cli/config.py` 的 `OPTIONAL_ENV_VARS`。完整环境变量见项目根的 `.env.example`。

### 用户配置与状态布局

| 路径 | 内容 |
|------|------|
| `~/.hermes/config.yaml` | 所有非密钥设置 |
| `~/.hermes/.env` | API key 等密钥 |
| `~/.hermes/logs/agent.log` | INFO 及以上日志 |
| `~/.hermes/logs/errors.log` | WARNING 及以上 |
| `~/.hermes/logs/gateway.log` | 网关运行时日志 |
| `~/.hermes/skills/` | 用户技能 |
| `~/.hermes/plugins/` | 用户插件 |
| `~/.hermes/cron/` | cron 作业定义与输出 |
| `~/.hermes/state.db` | SessionDB 的 SQLite 库 |

以上路径均 profile-aware——实际位置由 `get_hermes_home()` 决定。

### 代码目录速查

| 目录 | 内容 |
|------|------|
| `agent/` | agent 内部实现（adapter、记忆、压缩、提示构造、curator 等） |
| `tools/` | 工具实现，`tools/registry.py` 自动发现 |
| `tools/environments/` | 七种终端后端 |
| `gateway/` | 消息网关，`gateway/platforms/` 是各平台适配器 |
| `hermes_cli/` | CLI 子命令、安装向导、插件加载、皮肤引擎 |
| `plugins/` | 插件（记忆 / 上下文引擎 / model-provider / kanban 等） |
| `skills/` | 内置技能；`optional-skills/` 是默认不激活的 |
| `cron/` | cron 调度器 |
| `tests/` | pytest 测试套件 |
| `ui-tui/` + `tui_gateway/` | TUI 前端与后端 |

---

至此参考手册全部 15 章完结。建议配合 [trace 导览](tour-00-overview.md) 把子系统知识串成一条完整链路。
