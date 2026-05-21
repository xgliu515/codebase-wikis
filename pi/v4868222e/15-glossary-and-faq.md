# 第 15 章 词汇表与 FAQ

> 代码版本锁定：earendil-works/pi@4868222e（2026-05-20）。本章所有 file:line 引用均基于该 commit。

本章为 pi 代码阅读与二次开发的速查手册。术语表按英文字母序排列；FAQ 直接给出代码定位；附录列出常用环境变量、命令及目录结构。

---

## Part 1：术语表

### Agent
- 英文原名：`Agent`
- 中文译名：智能体对象
- 定义：`pi-agent-core` 包的顶层对象，持有 `AgentState`（系统提示、模型、工具列表、消息历史），并封装 `agentLoop`/`runAgentLoop` 调用。外部通过 `agent.prompt()`/`agent.continue()` 触发执行，通过 `agent.subscribe()` 监听 `AgentEvent` 事件流。
- 代码位置：`packages/agent/src/agent.ts:166` 定义 `class Agent`，`packages/agent/src/types.ts:317` 定义 `AgentState` 接口。

### AgentContext
- 英文原名：`AgentContext`
- 中文译名：智能体上下文快照
- 定义：传入低级 `agentLoop` 的只读快照，包含三个字段：`systemPrompt`（系统提示字符串）、`messages`（当前对话消息数组）、`tools`（本次执行可用工具列表）。与 `AgentState` 的区别在于它是单次请求边界处的不可变副本。
- 代码位置：`packages/agent/src/types.ts:386` 定义 `interface AgentContext`。

### AgentEvent
- 英文原名：`AgentEvent`
- 中文译名：智能体事件
- 定义：`agent.subscribe()` 发出的事件联合类型，涵盖 `agent_start`、`agent_end`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end` 共 10 种。`AgentHarness` 在此基础上叠加 `AgentHarnessOwnEvent`（包括 `before_provider_request`、`session_compact` 等）。
- 代码位置：`packages/agent/src/types.ts:403` 定义 `type AgentEvent`；`packages/agent/src/harness/types.ts:641` 定义 `type AgentHarnessEvent`。

### AgentHarness
- 英文原名：`AgentHarness`
- 中文译名：智能体线束
- 定义：`pi-agent-core` 包中位于 `Agent` 之上的高级封装，负责把 session 持久化、compaction、steering/follow-up 消息队列、provider 鉴权等横切关注点与核心 agent loop 解耦。`AgentHarness` 接受 `ExecutionEnv`（文件系统 + shell）和 `Session` 对象，通过 hook 系统向外暴露 `before_provider_request`、`tool_call` 等事件供外层修改。
- 代码位置：`packages/agent/src/harness/agent-harness.ts:164` 定义 `class AgentHarness`；`packages/agent/src/harness/types.ts:780` 定义 `AgentHarnessOptions`。

### AgentLoop / `agentLoop` / `runAgentLoop`
- 英文原名：`agentLoop` / `runAgentLoop`
- 中文译名：智能体循环
- 定义：pi 核心的"提示 → LLM → 工具调用 → 结果 → 下一轮"反复迭代逻辑。`agentLoop()` 是面向调用方的包装，返回 `EventStream<AgentEvent, AgentMessage[]>`；`runAgentLoop()` 是实际内部实现，负责调用 `streamSimple`、验证工具参数、执行工具、处理 `shouldStopAfterTurn` 回调。
- 代码位置：`packages/agent/src/agent-loop.ts:31` 定义 `agentLoop()`；`packages/agent/src/agent-loop.ts` 中 `runAgentLoop()` 为核心递归实现。

### AgentMessage
- 英文原名：`AgentMessage`
- 中文译名：智能体消息
- 定义：对话历史中的单条记录。默认等于 LLM 层的 `Message`（`UserMessage | AssistantMessage | ToolResultMessage`），但允许应用通过声明合并扩展 `CustomAgentMessages` 注入自定义角色（如 artifact、notification）。自定义消息通过 `convertToLlm` 回调在到达 LLM 边界前过滤或转换。
- 代码位置：`packages/agent/src/types.ts:309` 定义 `type AgentMessage`；`packages/agent/src/types.ts:300` 定义可扩展接口 `CustomAgentMessages`。

### AgentSession
- 英文原名：`AgentSession`
- 中文译名：编码智能体会话
- 定义：`pi-coding-agent` 包的核心抽象，共享于交互模式、打印模式和 RPC 模式。封装 agent 生命周期（提示、中断、compaction、分支切换）、扩展事件分发、bash 执行沙箱，以及对 `SessionManager` 的读写。各模式在其基础上叠加自己的 I/O 层。
- 代码位置：`packages/coding-agent/src/core/agent-session.ts:251` 定义 `class AgentSession`。

### AgentSessionRuntime
- 英文原名：`AgentSessionRuntime`
- 中文译名：会话运行时
- 定义：把 `AgentSession`（逻辑层）与具体 I/O 模式的渲染/通信层粘合在一起。Interactive、Print、RPC 模式分别通过 `createAgentSessionRuntime()` 工厂获取不同的运行时实例，该工厂注入 `ExtensionUIContext`、`ShutdownHandler` 等依赖。
- 代码位置：`packages/coding-agent/src/core/agent-session-runtime.ts:67` 定义 `class AgentSessionRuntime`。

### AgentTool / AgentToolCall
- 英文原名：`AgentTool` / `AgentToolCall`
- 中文译名：智能体工具 / 工具调用块
- 定义：`AgentTool` 是运行时工具描述，扩展 LLM 层的 `Tool`，额外包含 `label`（UI 展示名）、`prepareArguments`（参数预处理钩子）、`execute` 异步实现、`executionMode`（`sequential` | `parallel`）。`AgentToolCall` 是 `AssistantMessage.content` 中 `type: "toolCall"` 块的别名，由 agent loop 从助手消息中提取并调度执行。
- 代码位置：`packages/agent/src/types.ts:361` 定义 `AgentTool`；`packages/agent/src/types.ts:47` 定义 `AgentToolCall`。

### Api / KnownApi
- 英文原名：`Api` / `KnownApi`
- 中文译名：API 协议标识 / 已知协议
- 定义：标识后端使用的 HTTP/SDK 协议的字符串字面量类型。`KnownApi` 枚举 pi 内置的 8 个协议：`openai-completions`、`openai-responses`、`azure-openai-responses`、`openai-codex-responses`、`anthropic-messages`、`bedrock-converse-stream`、`google-generative-ai`、`google-vertex`。`Api = KnownApi | (string & {})` 允许扩展自定义协议。每个 `Model` 对象持有一个 `api` 字段，决定调用哪个 `ApiProvider`。
- 代码位置：`packages/ai/src/types.ts:6` 定义 `KnownApi`，`packages/ai/src/types.ts:17` 定义 `Api`。

### API Registry（`apiProviderRegistry`）
- 英文原名：`apiProviderRegistry`
- 中文译名：API 提供者注册表
- 定义：一个以 `Api` 字符串为键的 `Map`，存储已注册的 `ApiProvider`（含 `stream` 和 `streamSimple` 两个函数槽）。`registerApiProvider()` 向注册表写入，`stream()` / `streamSimple()` 在调用时从注册表查找对应实现。扩展可通过 `registerApiProvider()` 覆盖或新增协议实现。
- 代码位置：`packages/ai/src/api-registry.ts:40` 定义 `apiProviderRegistry`；`packages/ai/src/api-registry.ts:66` 定义 `registerApiProvider()`。

### AssistantMessage
- 英文原名：`AssistantMessage`
- 中文译名：助手消息
- 定义：LLM 一次完整响应的不可变结构，包含 `role: "assistant"`、`content`（`TextContent | ThinkingContent | ToolCall` 数组）、`api`、`provider`、`model`、`usage`（token 用量与费用）、`stopReason`、`timestamp` 等字段。由 `AssistantMessageEventStream.result()` 收集流式事件后返回。
- 代码位置：`packages/ai/src/types.ts:277` 定义 `interface AssistantMessage`。

### AssistantMessageEvent（及 5 类子事件）
- 英文原名：`AssistantMessageEvent`
- 中文译名：助手消息事件
- 定义：流式响应中每个增量事件的联合类型，分为以下 5 类：①生命周期事件（`start`）；②文本事件（`text_start` / `text_delta` / `text_end`）；③思考事件（`thinking_start` / `thinking_delta` / `thinking_end`）；④工具调用事件（`toolcall_start` / `toolcall_delta` / `toolcall_end`）；⑤终止事件（`done` 表成功，`error` 表失败）。每个事件都携带当前的 `partial: AssistantMessage` 快照。
- 代码位置：`packages/ai/src/types.ts:347` 定义 `type AssistantMessageEvent`（共 14 个变体）。

### AssistantMessageEventStream
- 英文原名：`AssistantMessageEventStream`
- 中文译名：助手消息事件流
- 定义：`EventStream<AssistantMessageEvent, AssistantMessage>` 的别名，是 `stream()` / `streamSimple()` 的返回类型。既可通过 `for await` 异步迭代消费每个事件，也可直接调用 `.result()` 等待最终 `AssistantMessage`。所有提供者实现必须保证以 `done` 或 `error` 事件终止。
- 代码位置：`packages/ai/src/utils/event-stream.ts:4` 定义 `EventStream` 泛型类；`packages/ai/src/types.ts:4` re-export `AssistantMessageEventStream`。

### Cache Retention（none / short / long）
- 英文原名：`CacheRetention`
- 中文译名：缓存保留策略
- 定义：`StreamOptions.cacheRetention` 字段，取值 `"none"`（禁用）、`"short"`（默认，Anthropic 5 min、OpenAI in-memory）、`"long"`（Anthropic 1 h、OpenAI 24 h）。各 provider 将此枚举映射到自身 API 的具体参数（Anthropic 的 `cache_control.ttl`、OpenAI Responses 的 `prompt_cache_retention`）。可通过环境变量 `PI_CACHE_RETENTION=long` 全局启用长缓存。
- 代码位置：`packages/ai/src/types.ts:75` 定义 `type CacheRetention`；`packages/ai/src/types.ts:98` 定义 `StreamOptions.cacheRetention` 字段。

### Compaction / `shouldCompact` / `compact`
- 英文原名：Compaction / `shouldCompact` / `compact`
- 中文译名：上下文压缩
- 定义：当估算的上下文 token 数超过 `contextWindow - reserveTokens`（默认保留 16 384 个 token）时自动触发。`shouldCompact()` 判断是否需要压缩；`compact()` 调用 LLM 对待压缩消息生成摘要，并将摘要作为新的会话起点写入 session。设置 `compaction.enabled: false` 可禁用自动压缩。
- 代码位置：`packages/coding-agent/src/core/compaction/compaction.ts:219` 定义 `shouldCompact()`；`packages/coding-agent/src/core/compaction/compaction.ts:747` 定义 `compact()`；`packages/coding-agent/src/core/settings-manager.ts:9` 定义 `CompactionSettings`。

### Component（`render(width): string[]`）
- 英文原名：`Component`
- 中文译名：TUI 组件
- 定义：`pi-tui` 中所有可渲染元素的统一接口，必须实现 `render(width: number): string[]`（返回每行 ANSI 字符串数组）和 `invalidate()`（清除缓存）。可选实现 `handleInput(data: string)` 接收键盘输入，或通过 `wantsKeyRelease: true` 请求 Kitty 协议的按键释放事件。
- 代码位置：`packages/tui/src/tui.ts:39` 定义 `interface Component`。

### Context
- 英文原名：`Context`
- 中文译名：LLM 请求上下文
- 定义：传递给底层 `stream()` / `streamSimple()` 的最小请求载荷，包含 `systemPrompt?`（系统提示）、`messages`（对话历史）、`tools?`（LLM 层工具描述数组）。注意与 `AgentContext` 的区别：`Context` 纯粹是 AI 层的 HTTP 请求参数，不含 agent 运行时元数据。
- 代码位置：`packages/ai/src/types.ts:333` 定义 `interface Context`。

### Differential Rendering
- 英文原名：Differential Rendering
- 中文译名：差异渲染
- 定义：`TUI` 类的核心渲染策略：每帧与上一帧对比，只向终端输出发生变化的行，避免全屏闪烁。实现时用 ANSI 光标定位序列跳转到 diff 行并覆写。调试时可设 `PI_DEBUG_REDRAW=1` 将每次整屏重绘标红，以可视化 diff 覆盖范围。
- 代码位置：`packages/tui/src/tui.ts:239` `class TUI extends Container`，渲染循环位于同文件约 1010 行处；`packages/tui/src/tui.ts:1013` 检查 `PI_DEBUG_REDRAW`。

### Editor Component / Editor API
- 英文原名：`EditorComponent`
- 中文译名：编辑器组件
- 定义：`pi-tui` 导出的扩展接口，允许替换主输入框的实现。必须实现 `getText()` / `setText()` / `handleInput()` 三个方法及 `onSubmit` / `onChange` 回调，可选实现历史导航（`addToHistory`）、光标插入（`insertTextAtCursor`）等。coding-agent 通过 `ctx.ui.setEditorComponent(factory)` 将自定义编辑器注入到交互模式。
- 代码位置：`packages/tui/src/editor-component.ts:11` 定义 `interface EditorComponent`。

### env-api-keys
- 英文原名：env-api-keys（`getEnvApiKey` / `findEnvKeys`）
- 中文译名：环境 API 密钥查找
- 定义：`packages/ai/src/env-api-keys.ts` 提供的工具函数集，维护 provider 名称到环境变量名的映射表（如 `anthropic` → `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`）。`getEnvApiKey(provider)` 返回当前进程可用的密钥字符串；对 AWS Bedrock、Google Vertex 等使用 SDK 认证的 provider，在凭证文件存在时返回 `"<authenticated>"`。
- 代码位置：`packages/ai/src/env-api-keys.ts:91` 定义 `getApiKeyEnvVars()`；`packages/ai/src/env-api-keys.ts:158` 定义 `getEnvApiKey()`。

### Extension / ExtensionFactory
- 英文原名：`Extension` / `ExtensionFactory`
- 中文译名：扩展 / 扩展工厂函数
- 定义：`pi-coding-agent` 扩展系统的核心概念。扩展是一个 TypeScript 模块，其默认导出为 `ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`，在加载时被调用一次。工厂函数通过 `pi.on(event, handler)` 订阅事件、通过 `pi.registerTool()` 注册工具、通过 `pi.registerCommand()` 注册命令。模块由 `jiti` 在运行时动态加载。
- 代码位置：`packages/coding-agent/src/core/extensions/types.ts:1379` 定义 `type ExtensionFactory`；`packages/coding-agent/src/core/extensions/types.ts:1539` 定义 `interface Extension`。

### Extension Hook
- 英文原名：Extension Hook（事件钩子）
- 中文译名：扩展钩子
- 定义：`ExtensionAPI.on()` 方法支持的全部事件名，分为：**资源事件**（`resources_discover`）；**会话事件**（`session_start` / `session_before_switch` / `session_before_fork` / `session_before_compact` / `session_compact` / `session_shutdown` / `session_before_tree` / `session_tree`）；**Agent 事件**（`before_agent_start` / `agent_start` / `agent_end` / `turn_start` / `turn_end`）；**消息事件**（`message_start` / `message_update` / `message_end`）；**工具事件**（`tool_execution_start` / `tool_execution_update` / `tool_execution_end` / `tool_call` / `tool_result`）；**模型事件**（`model_select` / `thinking_level_select`）；**输入事件**（`input` / `user_bash`）；**Provider 事件**（`before_provider_request` / `after_provider_response`）。
- 代码位置：`packages/coding-agent/src/core/extensions/types.ts:1084` 起 `ExtensionAPI.on()` 方法重载列表。

### Faux Provider
- 英文原名：Faux Provider
- 中文译名：伪造提供者
- 定义：仅用于测试的虚拟 LLM provider，注册 api 标识 `"faux"`。`registerFauxProvider()` 接受一个响应序列数组，每次 `stream()` 调用弹出下一个预设响应并以受控速度逐 token 流式发出，无需真实网络请求。常见用途：单元测试中验证 agent loop 行为。
- 代码位置：`packages/ai/src/providers/faux.ts:105` 定义 `RegisterFauxProviderOptions`；`packages/ai/src/providers/faux.ts:116` 定义 `FauxProviderRegistration`。

### File Mutation Queue
- 英文原名：File Mutation Queue（`withFileMutationQueue`）
- 中文译名：文件变更队列
- 定义：`edit` / `write` 工具在写同一文件时使用的序列化机制。`withFileMutationQueue(filePath, fn)` 保证针对同一规范路径的操作按提交顺序串行执行，消除并发 LLM 工具调用同时编辑同一文件引起的竞态条件。不同文件的操作仍可并行。
- 代码位置：`packages/coding-agent/src/core/tools/file-mutation-queue.ts:19` 定义 `withFileMutationQueue()`。

### Focusable
- 英文原名：`Focusable`
- 中文译名：可聚焦接口
- 定义：`pi-tui` 中组件可选实现的接口，通过 `focused: boolean` 属性接收焦点状态。焦点组件在 `render()` 输出中插入 `CURSOR_MARKER` 占位符，`TUI` 渲染后将其替换为实际的硬件光标 ANSI 序列，以确保 IME 候选词窗口显示在正确位置。
- 代码位置：`packages/tui/src/tui.ts:74` 定义 `interface Focusable`。

### Generated Models（`models.generated.ts`）
- 英文原名：Generated Models
- 中文译名：自动生成模型表
- 定义：`packages/ai/src/models.generated.ts` 是由 `packages/ai/scripts/generate-models.ts` 脚本从 models.dev API 拉取数据后自动生成的静态文件，包含所有 `KnownProvider` 下每个模型的完整 `Model<Api>` 对象（id、name、api、cost、contextWindow 等）。手动编辑无效，需运行 `npm run generate-models`（位于 `packages/ai/`）重新生成。
- 代码位置：`packages/ai/src/models.generated.ts:1` 注释说明来源；`packages/ai/scripts/generate-models.ts:1` 为生成脚本。

### Interactive Mode / Print Mode / JSON Mode / RPC Mode
- 英文原名：Interactive Mode / Print Mode / JSON Mode / RPC Mode
- 中文译名：交互模式 / 打印模式 / JSON 模式 / RPC 模式
- 定义：pi coding-agent 的四种运行模式。**交互模式**（默认）：全 TUI，支持多轮对话、会话树、快捷键；**打印模式**（`--print` 或 stdin 为非 TTY）：单次执行后退出，输出纯文本最终回复；**JSON 模式**（`--mode json`）：打印模式变体，以换行分隔的 JSON 事件行输出完整事件流；**RPC 模式**（`--mode rpc`）：通过 stdout/stdin JSON-Lines 协议接收命令，供宿主程序嵌入 pi（如 IDE 插件、pi-chat）。
- 代码位置：`packages/coding-agent/src/main.ts:98` 定义 `type AppMode`；`packages/coding-agent/src/modes/print-mode.ts:17` 定义 `PrintModeOptions`；`packages/coding-agent/src/modes/rpc/` 为 RPC 模式实现。

### jiti
- 英文原名：jiti
- 中文译名：即时 TypeScript 执行器（扩展加载器）
- 定义：pi 扩展系统使用 `jiti`（`jiti/static` 入口）在运行时加载 TypeScript 扩展文件，无需预编译。在 Node.js 开发模式下，jiti 通过 `alias` 选项将 `@earendil-works/pi-*` 包重定向到本地工作区路径；在 Bun 二进制模式下改用 `virtualModules` 将已打包的模块直接注入，避免文件系统查找失败。
- 代码位置：`packages/coding-agent/src/core/extensions/loader.ts:16` 导入 `createJiti`；`packages/coding-agent/src/core/extensions/loader.ts:357` 创建 jiti 实例并调用 `import(extensionPath)`。

### JsonlRepo / MemoryRepo / Session Repo
- 英文原名：`JsonlSessionRepo` / `InMemorySessionRepo` / `SessionRepo`
- 中文译名：JSONL 会话仓库 / 内存会话仓库 / 会话仓库接口
- 定义：`SessionRepo<TMetadata>` 定义创建、打开、列举、删除、fork session 的统一接口。`JsonlSessionRepo` 实现将每个 session 存储为目录下独立的 `.jsonl` 文件（默认 `~/.pi/agent/sessions/`），每行一条 `SessionTreeEntry`。`InMemorySessionRepo` 用内存 `Map` 保存，供测试使用。
- 代码位置：`packages/agent/src/harness/types.ts:463` 定义 `SessionRepo`；`packages/agent/src/harness/session/jsonl-repo.ts:38` 定义 `JsonlSessionRepo`；`packages/agent/src/harness/session/memory-repo.ts:4` 定义 `InMemorySessionRepo`。

### KeybindingsManager / DEFAULT 键绑定
- 英文原名：`KeybindingsManager` / `TUI_KEYBINDINGS` / `KEYBINDINGS`
- 中文译名：键绑定管理器 / 默认键绑定表
- 定义：`KeybindingsManager` 负责将逻辑动作名（如 `app.interrupt`、`editor.submit`）映射到终端按键序列，并支持用户通过 `~/.pi/agent/keybindings.json` 覆盖默认值。`TUI_KEYBINDINGS`（`packages/tui`）定义底层 TUI 键绑定；`KEYBINDINGS`（`packages/coding-agent/src/core/keybindings.ts:63`）在其基础上叠加应用层动作。
- 代码位置：`packages/tui/src/keybindings.ts:54` 定义 `TUI_KEYBINDINGS`；`packages/coding-agent/src/core/keybindings.ts:63` 定义 `KEYBINDINGS`；`packages/coding-agent/src/core/keybindings.ts:344` 定义 `KeybindingsManager` 类。

### Kitty Protocol
- 英文原名：Kitty Keyboard Protocol / Kitty Image Protocol
- 中文译名：Kitty 协议（键盘 + 图像）
- 定义：由 Kitty 终端引入的两项扩展：①**键盘协议**：通过 CSI 序列区分按键按下（1）、重复（2）、释放（3）三个阶段，使 pi 能可靠识别修饰键组合与同时按键。`setKittyProtocolActive(true)` 激活后，`TUI` 过滤掉释放事件以防误触发；②**图像协议**（APC `\x1b_G...`）：允许直接在终端单元格中渲染 PNG/JPEG。pi 检测终端能力后自动启用，`deleteKittyImage()` 用于清除内联图像。
- 代码位置：`packages/tui/src/keys.ts:5` 协议参考；`packages/tui/src/keys.ts:31` 定义 `setKittyProtocolActive()`；`packages/tui/src/terminal-image.ts` 实现图像协议。

### KnownProvider
- 英文原名：`KnownProvider`
- 中文译名：已知提供者
- 定义：`packages/ai/src/types.ts` 中枚举的全部内置 provider 字面量联合类型，当前包含 24 个值（`anthropic`、`openai`、`google`、`deepseek`、`github-copilot`、`openrouter` 等）。`Provider = KnownProvider | string` 允许自定义 provider。`getModel(provider, modelId)` 和 `getModels(provider)` 使用 `KnownProvider` 类型参数保证类型安全。
- 代码位置：`packages/ai/src/types.ts:23` 定义 `KnownProvider`。

### Model / Model Registry
- 英文原名：`Model` / Model Registry
- 中文译名：模型描述 / 模型注册表
- 定义：`Model<TApi>` 是描述单个 LLM 模型元数据的对象，包含 `id`、`name`、`api`、`provider`、`baseUrl`、`reasoning`、`input`、`cost`（$/M token）、`contextWindow`、`maxTokens` 以及可选的 `compat`（协议兼容覆盖）字段。模型注册表是 `models.ts` 内的 `Map<provider, Map<modelId, Model>>`，在模块加载时从 `models.generated.ts` 初始化，提供 `getModel()`、`getModels()`、`getProviders()` 查询接口。
- 代码位置：`packages/ai/src/types.ts:528` 定义 `interface Model`；`packages/ai/src/models.ts:4` 定义 `modelRegistry` 及查询函数。

### OAuth（Anthropic / Codex / Copilot）
- 英文原名：OAuth（Anthropic / OpenAI Codex / GitHub Copilot）
- 中文译名：OAuth 认证
- 定义：pi 为三个 provider 内置了 OAuth PKCE 流程：**Anthropic**（Claude Pro/Max 账户）、**OpenAI Codex**（ChatGPT Plus）、**GitHub Copilot**。统一通过 `packages/ai/src/utils/oauth/` 实现，`loginAnthropic()` 等函数启动本地回调服务器完成授权，凭证持久化到 `~/.pi/agent/auth.json`。`PI_OAUTH_CALLBACK_HOST` 可覆盖回调绑定地址（默认 `127.0.0.1`）。
- 代码位置：`packages/ai/src/utils/oauth/index.ts:1` 汇总导出；`packages/ai/src/utils/oauth/anthropic.ts:31` / `openai-codex.ts:24` 使用 `PI_OAUTH_CALLBACK_HOST`。

### Overlay
- 英文原名：`Overlay` / `OverlayHandle`
- 中文译名：悬浮层 / 悬浮层句柄
- 定义：`TUI.showOverlay(component, options)` 将一个 `Component` 推入悬浮层栈，渲染时覆盖在基础内容之上（支持锚点、尺寸、可见性控制）。返回 `OverlayHandle`（含 `isVisible` / `setVisible()` 方法），调用方通过句柄控制显隐，或调用 `TUI.hideOverlay()` 弹出顶层。用于实现模型选择器、会话树、确认对话框等浮动 UI。
- 代码位置：`packages/tui/src/tui.ts:180` 定义 `OverlayHandle`；`packages/tui/src/tui.ts:329` 定义 `showOverlay()`。

### ProcessTerminal
- 英文原名：`ProcessTerminal`
- 中文译名：进程终端适配器
- 定义：`Terminal` 接口的 Node.js / Bun 进程实现，管理 `process.stdin` 原始模式、`SIGWINCH` 窗口大小变更监听、`process.stdout` 写入，并在 Linux 上检测 Kitty 协议支持。`PI_TUI_WRITE_LOG` 可设置路径将所有 stdout ANSI 字节镜像写入日志文件（供调试）。
- 代码位置：`packages/tui/src/terminal.ts:64` 定义 `class ProcessTerminal`；`packages/tui/src/terminal.ts:74` 检查 `PI_TUI_WRITE_LOG`。

### Prompt Cache
- 英文原名：Prompt Cache
- 中文译名：提示缓存
- 定义：各 provider 对相同或相近系统提示 / 历史对话进行服务端缓存的机制，可显著降低重复内容的 token 费用和首 token 延迟。pi 将 `CacheRetention` 枚举映射到各 provider 的具体参数：Anthropic 使用 `cache_control` 标记（short=5 min，long=1 h）；OpenAI Responses 使用 `prompt_cache_retention`（short=in-memory，long=24 h）；Bedrock 通过 `AWS_BEDROCK_FORCE_CACHE` 强制启用。
- 代码位置：`packages/ai/src/types.ts:393` `cacheControlFormat` 字段；`packages/ai/src/providers/openai-prompt-cache.ts:3` OpenAI 缓存 key 工具函数；`packages/ai/src/providers/anthropic.ts` Anthropic cache_control 映射。

### Provider Plugin / `registerApiProvider`
- 英文原名：Provider Plugin / `registerApiProvider`
- 中文译名：提供者插件 / 注册 API 提供者
- 定义：实现新 `Api` 协议的最小单元：一个包含 `api` 字符串、`stream` 函数和 `streamSimple` 函数的对象，通过 `registerApiProvider(provider, sourceId?)` 写入全局注册表。`sourceId` 供 `unregisterApiProviders(sourceId)` 按来源批量卸载。在 coding-agent 层，扩展可通过 `pi.registerProvider()` 向注册表写入自定义 provider 及其模型。
- 代码位置：`packages/ai/src/api-registry.ts:23` 定义 `interface ApiProvider`；`packages/ai/src/api-registry.ts:66` 定义 `registerApiProvider()`。

### Session / Session Context
- 英文原名：`Session` / `SessionContext`
- 中文译名：会话对象 / 会话上下文
- 定义：`Session<TMetadata>` 封装对 `SessionStorage` 的读写，提供 `appendEntry()`、`buildContext()`、`fork()` 等操作。`buildContext()` 沿 session 树的叶-根路径重放所有 entry，最终返回 `SessionContext`（含 `messages`、`thinkingLevel`、`model`），这是 agent 启动时恢复对话状态的入口。
- 代码位置：`packages/agent/src/harness/session/session.ts:78` 定义 `class Session`；`packages/agent/src/harness/session/session.ts:110` 定义 `buildContext()`；`packages/agent/src/harness/types.ts:416` 定义 `interface SessionContext`。

### Settings（用户级 / 项目级）
- 英文原名：Settings（user-level / project-level）
- 中文译名：设置（全局 / 项目）
- 定义：`SettingsManager` 加载两层配置：①**全局设置**（`~/.pi/agent/settings.json`）存储默认模型、compaction 参数、主题、transport 等持久偏好；②**项目设置**（`<cwd>/.pi/settings.json`）以深度合并方式覆盖全局值，支持 `extensions`、`skills`、`prompts`、`tools` 数组。`Settings` 接口的字段全部可选，未设置字段使用代码内默认值。
- 代码位置：`packages/coding-agent/src/core/settings-manager.ts:77` 定义 `interface Settings`；`packages/coding-agent/src/core/settings-manager.ts:148` 定义 `type SettingsScope`。

### Skill（pi 的 skill 块）
- 英文原名：`Skill`
- 中文译名：技能（Skill 块）
- 定义：从 `SKILL.md`（或 `SKILL.yaml`）文件加载的结构化指令块，包含 `name`、`description`、`content`、`filePath` 字段。pi 在构建系统提示时将激活的 skill 以 XML 格式插入（按 agentskills.io 规范），供 LLM 识别并通过 `/skill:name` 命令显式调用。`disableModelInvocation: true` 可让 skill 仅供应用层调用而不出现在模型可见列表中。
- 代码位置：`packages/agent/src/harness/types.ts:46` 定义 `interface Skill`；`packages/agent/src/harness/skills.ts` 实现 `formatSkillInvocation()`。

### StdinBuffer
- 英文原名：`StdinBuffer`
- 中文译名：标准输入缓冲器
- 定义：`pi-tui` 中用于将 stdin 字节流重新装帧为完整终端转义序列的缓冲器。`stdin data` 事件可能将一条 CSI/APC 序列拆成多个 chunk；`StdinBuffer.process(chunk)` 积累字节直到检测到完整序列，再通过 `EventEmitter` 发出 `data` 事件。对括号粘贴（`\x1b[200~...201~`）有专门的累积逻辑。
- 代码位置：`packages/tui/src/stdin-buffer.ts:20` 定义 `class StdinBuffer`（继承 `EventEmitter`）。

### streamSimple / stream / complete
- 英文原名：`streamSimple` / `stream` / `complete`
- 中文译名：简化流 / 原始流 / 完成函数
- 定义：`packages/ai/src/stream.ts` 导出的三个核心调用入口。`stream(model, context, options?)` 直接调用 provider 的底层 `StreamFunction`，返回 `AssistantMessageEventStream`；`streamSimple()` 在调用前通过 `simple-options.ts` 将 `SimpleStreamOptions.reasoning` 映射为 provider 专属 thinking 参数；`complete()` / `completeSimple()` 是等待 `.result()` 的便利包装，返回 `Promise<AssistantMessage>`。
- 代码位置：`packages/ai/src/stream.ts:25` 定义 `stream()`；`packages/ai/src/stream.ts:43` 定义 `complete()`；`packages/ai/src/stream.ts:43` 定义 `streamSimple()`。

### System Prompt
- 英文原名：System Prompt
- 中文译名：系统提示
- 定义：pi 在每次 LLM 调用前动态构建的系统提示字符串。`buildSystemPrompt(options)` 组合：①可选自定义提示；②工具概要段（每个工具的 `promptSnippet`）；③指导方针段（`promptGuidelines`）；④上下文文件段（`AGENTS.md`、`CLAUDE.md` 等）；⑤技能块（已激活 skill 的 XML 块）；⑥追加文本。扩展通过 `before_agent_start` hook 的返回值可替换整个系统提示。
- 代码位置：`packages/coding-agent/src/core/system-prompt.ts:27` 定义 `buildSystemPrompt()`。

### Thinking / ThinkingLevel
- 英文原名：`Thinking` / `ThinkingLevel`
- 中文译名：扩展思考 / 思考等级
- 定义：LLM 在正式回复前输出内部推理链的能力。`ThinkingLevel` 在 AI 层取值 `"minimal" | "low" | "medium" | "high" | "xhigh"`，在 Agent 层额外有 `"off"`。`streamSimple()` 将 `ThinkingLevel` 通过 `thinkingLevelMap` 字段翻译为具体 provider 参数（Anthropic 的 `budget_tokens`、OpenAI 的 `reasoning_effort`、DeepSeek 的 `thinking.type` 等）。思考内容在 `AssistantMessage.content` 中以 `ThinkingContent` 块存在。
- 代码位置：`packages/ai/src/types.ts:62` 定义 `ThinkingLevel`；`packages/agent/src/types.ts:284` 定义 agent 层 `ThinkingLevel`（含 `"off"`）；`packages/ai/src/types.ts:64` 定义 `ThinkingLevelMap`。

### Tool Call / Tool Result（LLM 协议层）
- 英文原名：`ToolCall` / `ToolResultMessage`
- 中文译名：工具调用 / 工具结果（LLM 协议层）
- 定义：LLM 层的原始工具协议类型。`ToolCall`（`type: "toolCall"`）是 `AssistantMessage.content` 中的一个内容块，包含 `id`、`name`、`arguments`；`ToolResultMessage`（`role: "toolResult"`）是将执行结果返回给 LLM 的消息，包含 `toolCallId`、`toolName`、`content`（文本或图像数组）、`isError`。两者与 `AgentTool` / `AgentToolCall` 的区别在于后者位于 agent 运行时层。
- 代码位置：`packages/ai/src/types.ts:246` 定义 `ToolCall`；`packages/ai/src/types.ts:292` 定义 `ToolResultMessage`。

### Transform Messages
- 英文原名：Transform Messages（`transformMessages`）
- 中文译名：消息变换
- 定义：`packages/ai/src/providers/transform-messages.ts` 中的 `transformMessages()` 函数，在将上下文发送给 provider 前对消息列表做规范化处理：①将图像替换为文本占位符（视觉不支持的模型）；②透传 thinking 签名。`AgentLoopConfig.convertToLlm` 是更上层的等价扩展点，允许外层将自定义 `AgentMessage` 类型转换为标准 `Message`。
- 代码位置：`packages/ai/src/providers/transform-messages.ts:64` 定义 `transformMessages()`；`packages/agent/src/types.ts:163` 定义 `convertToLlm` 字段。

### TUI（类）
- 英文原名：`TUI`
- 中文译名：终端 UI 类
- 定义：`pi-tui` 的核心协调者，继承 `Container`。持有组件树根节点、悬浮层栈、`Terminal` 抽象（`ProcessTerminal` 或自定义）、聚焦组件指针。`TUI.render()` 触发差异渲染循环；`TUI.showOverlay()` 管理模态层；`TUI.setFocus()` 路由键盘输入。通过 `ProcessTerminal` 读取 `stdin`，渲染结果写入 `stdout`。
- 代码位置：`packages/tui/src/tui.ts:239` 定义 `class TUI extends Container`。

### Virtual Module
- 英文原名：Virtual Module
- 中文译名：虚拟模块
- 定义：Bun 编译二进制时，`jiti` 扩展加载器通过 `virtualModules` 配置项将已打包的 `@earendil-works/pi-*`、`typebox` 等包直接以内存对象形式提供给扩展，绕过文件系统模块解析。在 Node.js 开发模式下则改用 `alias` 选项将包名重定向到工作区路径。两种方式的最终效果相同：扩展 `import "@earendil-works/pi-ai"` 得到与宿主进程完全相同的模块实例。
- 代码位置：`packages/coding-agent/src/core/extensions/loader.ts:43` 定义 `VIRTUAL_MODULES`；`packages/coding-agent/src/core/extensions/loader.ts:357` 创建 jiti 实例。

### 内置工具：bash
- 英文原名：`bash` tool
- 中文译名：bash 工具
- 定义：在受控 shell（默认 `/bin/bash`）中执行任意命令，返回 stdout + stderr + 退出码。支持 `timeout`（秒）、`stdin` 注入。`BashToolDetails` 记录执行元数据，`OutputAccumulator` 对超长输出做截断。通过 `INTERACTIVE_COMMANDS` 环境变量可标记需要伪终端的命令，通过 `INTERACTIVE_EXCLUDE` 排除特定命令。
- 代码位置：`packages/coding-agent/src/core/tools/bash.ts:265` 定义 `createBashToolDefinition()`；`packages/coding-agent/src/core/tools/bash.ts:439` 定义 `createBashTool()`。

### 内置工具：edit
- 英文原名：`edit` tool
- 中文译名：edit 工具
- 定义：精确字符串替换工具，接受 `path`、`old_string`、`new_string` 参数，执行前通过 `withFileMutationQueue` 序列化写操作。`EditToolDetails` 包含 diff 元数据。pi 还实现了 diff-based edit（`edit-diff.ts`）以支持大块内容替换。
- 代码位置：`packages/coding-agent/src/core/tools/edit.ts` 定义 `createEditToolDefinition()` 及 `EditToolDetails`。

### 内置工具：find
- 英文原名：`find` tool
- 中文译名：find 工具
- 定义：在目录树中按文件名 glob 模式（及可选的内容 grep 模式）递归搜索，返回匹配路径列表。内部调用 Node.js `fs` API 实现，不依赖系统 `find` 命令，确保跨平台一致性。支持 `path`、`pattern`、`maxDepth` 参数。
- 代码位置：`packages/coding-agent/src/core/tools/find.ts` 定义 `createFindToolDefinition()`。

### 内置工具：grep
- 英文原名：`grep` tool
- 中文译名：grep 工具
- 定义：在文件或目录中正则搜索文本内容，返回匹配行及行号。支持 `path`（文件或目录）、`pattern`（正则字符串）、`include`（文件 glob 过滤）、`recursive`（默认 `true`）参数。`GrepToolDetails` 包含匹配计数与截断信息。
- 代码位置：`packages/coding-agent/src/core/tools/grep.ts` 定义 `createGrepToolDefinition()`。

### 内置工具：ls
- 英文原名：`ls` tool
- 中文译名：ls 工具
- 定义：列出指定目录下的文件和子目录，返回包含 `name`、`type`（file/directory）、`size`（字节）、`modified` 的条目数组。支持 `path` 和 `ignore`（glob 黑名单）参数。`LsToolDetails` 包含截断元数据。
- 代码位置：`packages/coding-agent/src/core/tools/ls.ts` 定义 `createLsToolDefinition()`。

### 内置工具：read
- 英文原名：`read` tool
- 中文译名：read 工具
- 定义：读取文件内容并以带行号的格式返回（`cat -n` 风格），支持 `path`、`offset`（起始行，1-based）、`limit`（最大行数）参数。对超长文件自动截断并报告总行数。通过 `ReadToolDetails` 暴露文件大小、实际读取行范围、是否截断等元数据。
- 代码位置：`packages/coding-agent/src/core/tools/read.ts:206` 定义 `createReadToolDefinition()`；`packages/coding-agent/src/core/tools/read.ts:361` 定义 `createReadTool()`。

### 内置工具：write
- 英文原名：`write` tool
- 中文译名：write 工具
- 定义：创建或完整覆写文件，自动创建所需父目录，通过 `withFileMutationQueue` 序列化写操作。接受 `path` 和 `content` 参数，不支持追加（追加场景需先 read 再 write 或使用 edit）。
- 代码位置：`packages/coding-agent/src/core/tools/write.ts` 定义 `createWriteToolDefinition()`。

---

## Part 2：FAQ

### Q1：怎么换默认模型？

在全局设置（`~/.pi/agent/settings.json`）中设置 `defaultProvider` 和 `defaultModel` 字段，例如：

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514"
}
```

也可通过 CLI flag 临时覆盖：`pi --model claude-opus-4-20250514` 或 `pi --provider anthropic --model claude-opus-4-20250514`。模型 ID 同时支持 provider 前缀格式（`anthropic:claude-...`）。

- `packages/coding-agent/src/core/settings-manager.ts:79` 定义 `Settings.defaultProvider` / `Settings.defaultModel`
- `packages/coding-agent/src/cli/args.ts:12` 定义 `Args.model` / `Args.provider`
- `packages/coding-agent/src/main.ts:307` 处理 `parsed.model`

---

### Q2：怎么禁用某个内置工具？

在 `settings.json` 中设置 `tools` 数组仅列出要启用的工具名称，或通过 CLI 传入 `--tools read,bash,grep`（只保留这三个）/ `--no-builtin-tools`（禁用全部内置工具）：

```json
{
  "tools": ["read", "grep", "find", "ls"]
}
```

也可在扩展的 `session_start` 钩子中调用 `pi.setActiveTools([...])` 动态修改可用工具集。

- `packages/coding-agent/src/cli/args.ts:28` 定义 `Args.tools` / `Args.noBuiltinTools`
- `packages/coding-agent/src/core/extensions/types.ts:1218` 定义 `ExtensionAPI.setActiveTools()`

---

### Q3：怎么写一个自定义工具扩展？

创建一个 TypeScript 文件，默认导出 `ExtensionFactory`：

```typescript
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi) {
  pi.registerTool(defineTool({
    name: "my_tool",
    label: "My Tool",
    description: "Does something useful.",
    parameters: Type.Object({ message: Type.String() }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return { content: [{ type: "text", text: params.message }], details: undefined };
    },
  }));
}
```

在 `settings.json` 中加入 `"extensions": ["./my-extension.ts"]`，重启 pi 即生效（或运行 `/reload`）。扩展在 Node.js 模式下由 jiti 动态编译，Bun 二进制模式下通过 virtualModules 解析。

- `packages/coding-agent/src/core/extensions/types.ts:426` 定义 `ToolDefinition`
- `packages/coding-agent/src/core/extensions/loader.ts:357` jiti 加载入口
- `packages/coding-agent/src/core/extensions/types.ts:1132` 定义 `registerTool()`

---

### Q4：我的 API key 存在哪里？怎么删？

OAuth 令牌（Anthropic、GitHub Copilot、OpenAI Codex）持久化于 `~/.pi/agent/auth.json`（可通过 `PI_CODING_AGENT_DIR` 覆盖数据目录）。普通 API key 只读取环境变量，不写入文件。删除 OAuth 凭证直接删除或清空 `auth.json` 对应 provider 的条目，或运行 `pi-ai logout --provider <name>`（若实现了 logout 命令）。

- `packages/coding-agent/src/config.ts:495` 定义 `getAuthPath()` 返回 `~/.pi/agent/auth.json`
- `packages/coding-agent/src/core/auth-storage.ts` 定义 `AuthStorage` 读写逻辑

---

### Q5：session 文件在哪？怎么导出？

Session 文件默认存储于 `~/.pi/agent/sessions/`，每个 session 一个 `.jsonl` 文件，每行一条 `SessionTreeEntry` JSON 记录。可通过 `PI_CODING_AGENT_DIR` 或 settings 中的 `sessionDir` 字段更改路径。导出为 HTML：`pi --export <session-file>.jsonl`，或在交互模式中运行 `/export`。

- `packages/coding-agent/src/config.ts:520` 定义 `getSessionsDir()` 返回 `~/.pi/agent/sessions`
- `packages/agent/src/harness/session/jsonl-repo.ts:38` 定义 `JsonlSessionRepo`
- `packages/coding-agent/src/core/export-html/index.ts` 实现 HTML 导出

---

### Q6：怎么从一个旧 session 继续聊？

两种方式：①`pi --continue`（`-c`）：自动恢复当前目录最近的 session；②`pi --resume`：显示 session 选择器，选定后恢复。也可以 `pi --session <path-to.jsonl>` 直接指定文件。在交互模式中按 `Ctrl+R`（默认键绑定 `app.session.resume`）也可打开 session 选择器。

- `packages/coding-agent/src/cli/args.ts:19` 定义 `Args.continue` / `Args.resume`
- `packages/coding-agent/src/main.ts:282` 处理 `parsed.continue`（调用 `SessionManager.continueRecent()`）
- `packages/coding-agent/src/main.ts:265` 处理 `parsed.resume`

---

### Q7：compaction 触发条件是什么？能关掉吗？

当估算的上下文 token 数满足 `contextTokens > contextWindow - reserveTokens`（默认 `reserveTokens = 16384`）时自动触发。可在 `settings.json` 的 `compaction` 字段关闭或调整：

```json
{
  "compaction": {
    "enabled": false
  }
}
```

扩展可通过订阅 `session_before_compact` 事件取消单次 compaction（返回 `{ cancel: true }`），或通过 `session_compact` 事件在完成后获知摘要内容。

- `packages/coding-agent/src/core/compaction/compaction.ts:219` 定义 `shouldCompact()`
- `packages/coding-agent/src/core/settings-manager.ts:9` 定义 `CompactionSettings`
- `packages/coding-agent/src/core/extensions/types.ts:1100` 定义 `session_before_compact` hook

---

### Q8：我能用 pi 跑 GPT-5 / Gemini / 自部署的 LLM 吗？

可以。pi 内置支持 24 个 provider（见 `KnownProvider` 枚举），包括 OpenAI、Google Gemini、DeepSeek、Groq、OpenRouter、Mistral 等。自部署 LLM（如 Ollama、LM Studio）可通过扩展的 `pi.registerProvider()` 注册，指定 `baseUrl`、`api`（通常为 `openai-completions`）和模型列表：

```typescript
pi.registerProvider("local-llm", {
  baseUrl: "http://localhost:11434/v1",
  api: "openai-completions",
  apiKey: "ollama",
  models: [{ id: "llama3", name: "Llama 3", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
});
```

- `packages/ai/src/types.ts:23` 定义 `KnownProvider`（全部 24 个）
- `packages/coding-agent/src/core/extensions/types.ts:1292` 定义 `registerProvider()` 及示例

---

### Q9：怎么调 verbose 日志？

pi 没有统一的 `--verbose` 全局开关，但提供若干专项环境变量：

| 目的 | 环境变量 |
|------|----------|
| 捕获 TUI stdout ANSI 流 | `PI_TUI_WRITE_LOG=/tmp/tui.log` |
| 可视化差异渲染范围 | `PI_DEBUG_REDRAW=1` |
| 测量启动耗时 | `PI_STARTUP_BENCHMARK=1` |
| 开启 TUI 调试模式 | `PI_TUI_DEBUG=1` |
| 输出详细内部时序 | `PI_TIMING=1` |

运行 `pi --verbose` 时，settings 加载器和模型解析器会向 stderr 输出诊断信息。

- `packages/tui/src/terminal.ts:74` `PI_TUI_WRITE_LOG`
- `packages/tui/src/tui.ts:1013` `PI_DEBUG_REDRAW`
- `packages/coding-agent/src/core/timings.ts:6` `PI_TIMING`

---

### Q10：怎么把 pi 嵌入到 Slack / Discord？

官方配套仓库 [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat) 实现了基于 pi RPC 模式（`--mode rpc`）的 Slack/Discord 机器人集成。pi RPC 模式在 stdout/stdin 以换行分隔的 JSON-Lines 格式接收命令并输出事件，宿主程序通过 `child_process` 驱动 pi 进程即可实现嵌入。

- `packages/coding-agent/README.md` 引用 `earendil-works/pi-chat`
- `packages/coding-agent/src/modes/rpc/` 实现 RPC 模式
- `packages/coding-agent/src/main.ts:98` `type AppMode = "interactive" | "print" | "json" | "rpc"`

---

### Q11：test.sh 跑不过怎么办？

`test.sh` 执行前会临时移开 `~/.pi/agent/auth.json`（防止测试使用真实 API），并设置 `PI_NO_LOCAL_LLM=1`（跳过本地 LLM 测试）和清空大部分 API key 环境变量。常见失败原因：

1. **供应链检查失败**：某直接依赖版本未精确锁定，运行 `npm run check:pins` 排查；
2. **shrinkwrap 不一致**：运行 `npm run shrinkwrap:coding-agent` 重新生成；
3. **TypeScript 类型错误**：运行 `npm run check` 定位；
4. **lockfile 脏**：运行 `npm ci` 重装后重试。

- `test.sh:1` 脚本入口
- `scripts/check-pinned-deps.mjs` 供应链检查
- `package.json:18` `check:shrinkwrap` 脚本

---

### Q12：怎么贡献代码？

新贡献者的 issue 和 PR 默认自动关闭，维护者每天审查并重新打开符合质量标准的条目。周五至周日提交的 issue 不进入周一审查队列。贡献前必须理解自己的代码修改——用 AI 生成代码后未经理解直接提交会被关闭。获得 `lgtmi` 标签后，该用户的 issue 不再自动关闭；获得 `lgtm` 标签后，该用户的 issue 和 PR 均不再自动关闭。

- `CONTRIBUTING.md:15` 自动关闭策略
- `CONTRIBUTING.md:1` 贡献门槛说明
- `.github/APPROVED_CONTRIBUTORS` 已审核贡献者列表

---

### Q13：pi 在 Windows 上跑得动吗？

可运行，提供 `pi-test.bat`（调用 PowerShell）和 `pi-test.ps1`（PowerShell 脚本）用于在 Windows 上从源码运行 pi。二进制发布包含 `windows-x64` 和 `windows-arm64` 目标（见 `scripts/build-binaries.sh`）。限制：Kitty 键盘协议及内联图像协议仅在支持该协议的终端（如 Windows Terminal 的部分版本）中有效；Cygwin 用户需在 settings 中设置 `shellPath` 指向 Cygwin bash。

- `pi-test.bat:1` Windows 测试入口
- `pi-test.ps1` PowerShell 测试脚本
- `scripts/build-binaries.sh:109` `bun build --target=bun-windows-x64` 编译命令

---

### Q14：怎么生成（更新）模型表？

模型元数据存储在自动生成的 `packages/ai/src/models.generated.ts`，由 `packages/ai/scripts/generate-models.ts` 从 models.dev API 拉取并生成。在 `packages/ai/` 目录下运行：

```bash
npm run generate-models
```

该脚本会覆写 `models.generated.ts` 并重建注册表；之后需运行 `npm run build` 重新编译 `pi-ai` 包。不要手工编辑 `models.generated.ts`——文件头有警告注释。

- `packages/ai/src/models.generated.ts:1` 自动生成警告注释
- `packages/ai/scripts/generate-models.ts:1` 生成脚本入口
- `packages/ai/package.json:63` `generate-models` npm 脚本

---

### Q15：Bun 二进制怎么编译？

pi 使用 Bun 的 `--compile` 功能将整个编码智能体打包成单一自包含可执行文件。本地完整构建流程：

```bash
cd packages/coding-agent
npm run build:bun          # 先将 TypeScript 打包为 dist/bun/cli.js
bun build --compile --target=bun-darwin-arm64 ./dist/bun/cli.js --outfile binaries/darwin-arm64/pi
```

`scripts/build-binaries.sh` 封装了全平台（darwin-arm64/x64、linux-x64/arm64、windows-x64/arm64）的编译流程，对应 CI 的 `.github/workflows/build-binaries.yml`。编译后扩展加载器通过 `VIRTUAL_MODULES` 提供内置包，无需外部 `node_modules`。

- `scripts/build-binaries.sh:109` `bun build --compile` 调用
- `packages/coding-agent/src/config.ts:18` `isBunBinary` 检测逻辑
- `packages/coding-agent/src/core/extensions/loader.ts:44` `VIRTUAL_MODULES` 定义

---

## Part 3：附录

### 3.1 环境变量速查表

| 变量 | 用途 | 影响范围 |
|------|------|----------|
| `ANTHROPIC_API_KEY` | Anthropic 直接 API 密钥 | `pi-ai` env-api-keys 自动注入 |
| `ANTHROPIC_OAUTH_TOKEN` | Anthropic OAuth 令牌（优先于 API key） | `pi-ai` env-api-keys 自动注入 |
| `OPENAI_API_KEY` | OpenAI API 密钥 | `pi-ai` env-api-keys 自动注入 |
| `GEMINI_API_KEY` | Google Gemini API 密钥 | `pi-ai` env-api-keys 自动注入 |
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 | `pi-ai` env-api-keys 自动注入 |
| `GROQ_API_KEY` | Groq API 密钥 | `pi-ai` env-api-keys 自动注入 |
| `OPENROUTER_API_KEY` | OpenRouter API 密钥 | `pi-ai` env-api-keys 自动注入 |
| `MISTRAL_API_KEY` | Mistral API 密钥 | `pi-ai` env-api-keys 自动注入 |
| `XAI_API_KEY` | xAI (Grok) API 密钥 | `pi-ai` env-api-keys 自动注入 |
| `CEREBRAS_API_KEY` | Cerebras API 密钥 | `pi-ai` env-api-keys 自动注入 |
| `FIREWORKS_API_KEY` | Fireworks AI 密钥 | `pi-ai` env-api-keys 自动注入 |
| `TOGETHER_API_KEY` | Together AI 密钥 | `pi-ai` env-api-keys 自动注入 |
| `HF_TOKEN` | Hugging Face 访问令牌 | `pi-ai` env-api-keys 自动注入 |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot 令牌（非 OAuth 路径） | `pi-ai` env-api-keys 自动注入 |
| `KIMI_API_KEY` | Kimi Coding API 密钥 | `pi-ai` env-api-keys 自动注入 |
| `ZAI_API_KEY` | z.ai API 密钥 | `pi-ai` env-api-keys 自动注入 |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway 密钥 | `pi-ai` env-api-keys 自动注入 |
| `CLOUDFLARE_API_KEY` | Cloudflare Workers AI / AI Gateway 密钥 | `pi-ai` env-api-keys 自动注入 |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI 密钥 | `pi-ai` Azure provider |
| `AZURE_OPENAI_BASE_URL` | Azure OpenAI 端点 URL | `pi-ai` Azure provider |
| `AZURE_OPENAI_API_VERSION` | Azure OpenAI API 版本 | `pi-ai` Azure provider |
| `GOOGLE_CLOUD_API_KEY` | Google Vertex AI API 密钥 | `pi-ai` Vertex provider |
| `GOOGLE_CLOUD_PROJECT` | Google Cloud 项目 ID | `pi-ai` Vertex ADC 认证 |
| `GOOGLE_CLOUD_LOCATION` | Google Cloud 区域 | `pi-ai` Vertex ADC 认证 |
| `GOOGLE_APPLICATION_CREDENTIALS` | Google ADC 凭证文件路径 | `pi-ai` Vertex ADC 认证 |
| `AWS_PROFILE` | AWS 命名配置 | `pi-ai` Bedrock provider |
| `AWS_ACCESS_KEY_ID` | AWS IAM 访问密钥 ID | `pi-ai` Bedrock provider |
| `AWS_SECRET_ACCESS_KEY` | AWS IAM 访问密钥 Secret | `pi-ai` Bedrock provider |
| `AWS_DEFAULT_REGION` / `AWS_REGION` | AWS 区域 | `pi-ai` Bedrock provider |
| `AWS_BEDROCK_FORCE_CACHE` | 强制启用 Bedrock prompt cache | `pi-ai` Bedrock provider |
| `PI_CODING_AGENT_DIR` | 覆盖配置目录（默认 `~/.pi/agent`） | coding-agent 全局 |
| `PI_CACHE_RETENTION` | 设置为 `long` 启用扩展 prompt 缓存（Anthropic 1h / OpenAI 24h） | coding-agent 全局 |
| `PI_OFFLINE` | 设置为 `1` 跳过版本检查和网络操作 | coding-agent 全局 |
| `PI_SKIP_VERSION_CHECK` | 跳过版本更新检查 | coding-agent 启动 |
| `PI_OAUTH_CALLBACK_HOST` | OAuth 本地回调服务器绑定地址（默认 `127.0.0.1`） | `pi-ai` OAuth 流程 |
| `PI_TUI_WRITE_LOG` | 将 TUI stdout ANSI 流镜像到日志文件 | `pi-tui` ProcessTerminal |
| `PI_TUI_DEBUG` | 设置为 `1` 输出 TUI 调试信息 | `pi-tui` TUI 类 |
| `PI_DEBUG_REDRAW` | 设置为 `1` 将每次全屏重绘标红 | `pi-tui` 差异渲染 |
| `PI_TIMING` | 设置为 `1` 输出内部时序统计 | coding-agent 时序模块 |
| `PI_STARTUP_BENCHMARK` | 设置为 `1` 测量启动耗时 | coding-agent 主入口 |
| `PI_HARDWARE_CURSOR` | 设置为 `1` 强制显示硬件光标 | coding-agent settings |
| `PI_CLEAR_ON_SHRINK` | 设置为 `1` 内容缩减时清除空行 | coding-agent settings |
| `PI_TELEMETRY` | 控制安装遥测（匿名版本 ping） | coding-agent telemetry |
| `PI_PACKAGE_DIR` | 覆盖 pi 包目录路径 | coding-agent config |
| `PI_SHARE_VIEWER_URL` | 覆盖 session 分享查看器 URL | coding-agent config |
| `PI_NO_LOCAL_LLM` | 设置为 `1` 跳过本地 LLM 测试（test.sh 使用） | `pi-ai` 测试套件 |
| `PI_ALLOW_LOCKFILE_CHANGE` | 设置为 `1` 允许 pre-commit 提交 lockfile | `scripts/check-lockfile-commit.mjs` |
| `INTERACTIVE_COMMANDS` | bash 工具需要伪终端的命令白名单 | coding-agent bash 工具 |
| `INTERACTIVE_EXCLUDE` | bash 工具排除伪终端的命令黑名单 | coding-agent bash 工具 |

### 3.2 常用命令速查

```bash
# 运行 pi
pi                                    # 进入交互模式
pi "prompt text"                      # 交互模式并附带初始消息
pi --print "prompt"                   # 一次性 print 模式（输出纯文本）
pi --mode json "prompt"               # JSON 行事件流模式
pi --mode rpc                         # RPC 模式（供宿主程序嵌入）
pi --continue                         # 恢复当前目录最近的 session
pi --resume                           # 显示 session 选择器后恢复
pi --session <path.jsonl>             # 直接打开指定 session
pi --fork <entryId>                   # 从指定条目分叉新 session
pi --model <id>                       # 指定使用的模型
pi --thinking <level>                 # 设置思考等级（off/minimal/.../xhigh）
pi --provider <name>                  # 指定 provider
pi --no-tools                         # 禁用全部工具
pi --tools read,bash                  # 只启用指定工具
pi --extensions <path>                # 加载指定扩展文件
pi --list-models                      # 列出所有可用模型
pi --export <session.jsonl>           # 将 session 导出为 HTML
pi --version                          # 显示版本号
pi --help                             # 显示帮助

# pi-ai CLI（OAuth 管理）
pi-ai login --provider anthropic      # 启动 Anthropic OAuth 登录
pi-ai login --provider github-copilot # 启动 GitHub Copilot OAuth 登录
pi-ai login --provider openai-codex   # 启动 OpenAI Codex OAuth 登录
pi-ai list                            # 列出已配置的 provider 和 API key 状态

# 开发与测试
npm install                           # 安装全部依赖
npm run build                         # 编译所有包
npm run check                         # lint + 类型检查 + supply chain 验证
./test.sh                             # 完整测试套件（自动移开 auth.json）
./pi-test.sh                          # 从源码运行 pi（可在任意目录调用）
pi-test.bat / pi-test.ps1             # Windows 等效脚本

# 生成与发布
cd packages/ai && npm run generate-models      # 从 models.dev 重新生成模型表
cd packages/ai && npm run generate-image-models # 重新生成图像模型表
node scripts/release.mjs              # 正式发布（慎用，需权限）
node scripts/local-release.mjs        # 本地测试发布打包
./scripts/build-binaries.sh           # 构建全平台 Bun 二进制
```

### 3.3 仓库目录速查

```
earendil-works/pi/
├── AGENTS.md                    # 给 AI agent 的项目规范（人机共用）
├── CONTRIBUTING.md              # 贡献指南与自动关闭策略说明
├── README.md                    # 项目概述与快速入门
├── biome.json                   # Biome lint / format 配置
├── tsconfig.json                # 根 TypeScript 配置
├── tsconfig.base.json           # 各包共用的基础 TS 配置
├── package.json                 # monorepo 根 package，定义 workspaces
├── package-lock.json            # 锁定全部依赖版本（supply chain 基准）
├── .npmrc                       # save-exact=true, min-release-age=2
├── pi-test.sh                   # Unix 从源码运行 pi 的脚本
├── pi-test.bat                  # Windows CMD 测试入口
├── pi-test.ps1                  # Windows PowerShell 测试脚本
├── test.sh                      # 完整测试套件（含 auth 安全处理）
├── scripts/
│   ├── build-binaries.sh        # 全平台 Bun 二进制编译脚本
│   ├── check-lockfile-commit.mjs# pre-commit 检查：防止意外提交 lockfile
│   ├── check-pinned-deps.mjs    # 验证直接依赖全部精确锁定
│   ├── check-ts-relative-imports.mjs # 验证 TS 相对导入使用 .ts 后缀
│   ├── generate-coding-agent-shrinkwrap.mjs # 生成 npm-shrinkwrap.json
│   ├── release.mjs              # 正式版本发布脚本
│   ├── local-release.mjs        # 本地打包 + 隔离安装冒烟测试
│   ├── sync-versions.js         # 同步各包 package.json 版本号
│   ├── session-context-stats.mjs# 统计 session 上下文 token 使用
│   ├── session-transcripts.ts   # 导出 session 对话文本
│   ├── cost.ts                  # 计算 API 调用费用
│   └── stats.ts                 # 综合统计工具
├── packages/
│   ├── ai/                      # @earendil-works/pi-ai：统一多 provider LLM API
│   │   ├── src/
│   │   │   ├── types.ts         # 全部核心类型（Model, Message, StreamOptions 等）
│   │   │   ├── stream.ts        # stream / streamSimple / complete 入口
│   │   │   ├── api-registry.ts  # ApiProvider 注册表
│   │   │   ├── models.ts        # 模型注册表查询接口
│   │   │   ├── models.generated.ts # 自动生成的全量模型定义（16000+ 行）
│   │   │   ├── env-api-keys.ts  # 环境变量 API key 查找
│   │   │   ├── oauth.ts         # OAuth 模块 re-export 入口
│   │   │   ├── session-resources.ts # 会话级资源清理
│   │   │   ├── providers/
│   │   │   │   ├── anthropic.ts         # Anthropic Messages API 实现
│   │   │   │   ├── openai-completions.ts# OpenAI Chat Completions 实现
│   │   │   │   ├── openai-responses.ts  # OpenAI Responses API 实现
│   │   │   │   ├── google.ts            # Google Generative AI 实现
│   │   │   │   ├── google-vertex.ts     # Google Vertex AI 实现
│   │   │   │   ├── amazon-bedrock.ts    # AWS Bedrock Converse 实现
│   │   │   │   ├── mistral.ts           # Mistral Conversations API 实现
│   │   │   │   ├── faux.ts              # 测试用伪造 provider
│   │   │   │   ├── transform-messages.ts# 消息格式标准化
│   │   │   │   ├── register-builtins.ts # 注册全部内置 provider
│   │   │   │   └── simple-options.ts    # ThinkingLevel → provider 参数映射
│   │   │   └── utils/
│   │   │       ├── event-stream.ts      # EventStream 泛型类实现
│   │   │       ├── oauth/               # OAuth PKCE 流程（Anthropic/Codex/Copilot）
│   │   │       └── ...                  # 其他工具函数
│   │   └── scripts/
│   │       ├── generate-models.ts       # 从 models.dev 生成模型表
│   │       └── generate-image-models.ts # 从 models.dev 生成图像模型表
│   ├── agent/                   # @earendil-works/pi-agent-core：agent 运行时
│   │   └── src/
│   │       ├── types.ts         # AgentTool, AgentMessage, AgentEvent 等核心类型
│   │       ├── agent.ts         # Agent 类（高级接口）
│   │       ├── agent-loop.ts    # agentLoop / runAgentLoop 核心实现
│   │       └── harness/
│   │           ├── agent-harness.ts     # AgentHarness（session + compaction 封装）
│   │           ├── types.ts             # 全部 Harness 类型（Session, SessionRepo 等）
│   │           ├── skills.ts            # Skill 系统格式化
│   │           ├── system-prompt.ts     # 系统提示构建
│   │           ├── compaction/          # compaction 算法与摘要生成
│   │           └── session/             # JsonlRepo, MemoryRepo, Session 对象
│   ├── coding-agent/            # @earendil-works/pi-coding-agent：编码智能体 CLI
│   │   ├── src/
│   │   │   ├── main.ts          # CLI 主入口（参数解析 → 模式路由）
│   │   │   ├── cli.ts           # 真正的可执行入口（设置 PI_CODING_AGENT=true）
│   │   │   ├── config.ts        # 目录路径、版本、安装方式检测
│   │   │   ├── migrations.ts    # 数据迁移逻辑
│   │   │   ├── core/
│   │   │   │   ├── agent-session.ts     # AgentSession（所有模式共享核心）
│   │   │   │   ├── agent-session-runtime.ts # AgentSessionRuntime（I/O 适配）
│   │   │   │   ├── settings-manager.ts  # 全局/项目 settings 加载与合并
│   │   │   │   ├── model-registry.ts    # ModelRegistry（含扩展注册 provider）
│   │   │   │   ├── keybindings.ts       # KeybindingsManager（含 APP 层绑定）
│   │   │   │   ├── system-prompt.ts     # buildSystemPrompt()
│   │   │   │   ├── compaction/          # coding-agent 层 compaction 实现
│   │   │   │   ├── extensions/          # 扩展加载器（jiti）、Runner、类型定义
│   │   │   │   └── tools/               # bash, read, write, edit, find, grep, ls
│   │   │   ├── cli/
│   │   │   │   ├── args.ts              # CLI 参数解析
│   │   │   │   ├── session-picker.ts    # session 选择器 UI
│   │   │   │   └── ...                  # 其他 CLI 辅助
│   │   │   ├── modes/
│   │   │   │   ├── interactive/         # 交互模式（TUI + 全功能）
│   │   │   │   ├── print-mode.ts        # 打印/JSON 模式
│   │   │   │   └── rpc/                 # RPC 模式（JSON-Lines 协议）
│   │   │   └── utils/                   # 路径、版本检查等工具
│   │   └── docs/                        # 开发文档（TUI 架构等）
│   └── tui/                     # @earendil-works/pi-tui：终端 UI 库
│       └── src/
│           ├── tui.ts           # TUI 类（差异渲染、悬浮层、焦点管理）
│           ├── terminal.ts      # Terminal 接口 + ProcessTerminal 实现
│           ├── stdin-buffer.ts  # 转义序列重装帧缓冲器
│           ├── keys.ts          # 键盘事件解析（含 Kitty 协议）
│           ├── keybindings.ts   # TUI_KEYBINDINGS + KeybindingsManager 基类
│           ├── editor-component.ts # EditorComponent 接口
│           ├── terminal-image.ts   # Kitty 图像协议实现
│           ├── autocomplete.ts     # 自动补全接口与实现
│           ├── components/         # 内置 TUI 组件（列表、输入框等）
│           └── utils.ts            # ANSI 宽度计算、字符串处理
```
