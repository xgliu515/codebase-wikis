# 第 15 章 术语表与 FAQ

> 代码版本锁定：`openclaw/openclaw@50a2481652`（tag `v2026.5.18`，2026-05-18）。
> 本章所有 `file:line` 引用均基于该 commit，路径为仓库根相对路径。

本章是整本 wiki 的收尾参考章，分三部分。**Part 1 术语表**把前 14 章反复出现的 40 余个核心概念集中收录，每条给出英文原名、中文译名、定义和代码位置，便于在阅读源码时随时回查。**Part 2 FAQ** 整理了读这套代码库时最常卡住的十余个问题——它们大多不是「某个函数怎么写」，而是「为什么这样分层」「一条消息走了哪条路」这类需要跨文件才能回答的问题。**Part 3 调试与开发速查**汇总环境变量、常用命令和关键目录三张表，是动手改代码时的工具页。

术语表条目按「自外向内」的阅读顺序排列：先是接入与控制平面，再是消息编排，然后是 agent 与 provider，最后是插件、安全、语音与 UI。FAQ 和速查表则按主题聚类。

---

## Part 1：术语表

### Gateway

- 英文原名：`Gateway`
- 中文译名：网关
- 定义：OpenClaw 的长驻进程与控制平面。它对外暴露一个 HTTP 服务和一个 WebSocket 服务，负责连接管理、RPC 分发、会话编排与插件加载。Gateway 本身不产生智能，是所有流量的咽喉——任何 CLI 命令、Control UI、原生 app、节点设备都通过 WebSocket 连到它，「the Gateway is just the control plane」。
- 代码位置：`src/gateway/server.impl.ts:532-535` 定义启动入口 `startGatewayServer`（默认端口 18789），`src/gateway/server.ts` 是其延迟加载薄壳，`src/gateway/server.impl.ts:460-462` 定义对外的 `GatewayServer` 句柄（只暴露 `close()`）。

### 控制平面

- 英文原名：`control plane`
- 中文译名：控制平面
- 定义：与「数据平面」相对的概念，指 Gateway 这一层。它管理连接、路由、会话与插件，但不是「产品」本身；真正的产品是跑在其上的 assistant（agent + LLM + 工具）。所有 CLI、Control UI、原生 app、节点设备都通过 WebSocket 连到控制平面。
- 代码位置：`README.md:21-22` 给出定义，`src/gateway/server.impl.ts` 是控制平面的完整实现（约 1687 行）。

### Channel

- 英文原名：`Channel` / `ChannelPlugin`
- 中文译名：渠道
- 定义：一种消息接入平台（WhatsApp、Telegram、Slack、Feishu、WebChat 等）。每个渠道是一个插件，封装该平台的 SDK，把平台原生消息归一化为 OpenClaw 内部的入站消息结构。core 只和「渠道契约」打交道，不认识任何具体渠道。
- 代码位置：`src/channels/plugins/types.ts` 定义 `ChannelPlugin` 契约，`src/channels/plugins/registry.ts:22-26` 是 core 侧渠道注册表与 docking 入口。

### MsgContext

- 英文原名：`MsgContext`
- 中文译名：入站消息上下文
- 定义：入站管线的统一「信封」。无论消息来自哪个渠道，进入 agent 执行层前都必须被规整成 `MsgContext`，使下游不必关心渠道差异，也不必担心字段缺失。经过 `finalizeInboundContext` 定稿后升级为 `FinalizedMsgContext`。
- 代码位置：`src/auto-reply/templating.ts:42` 定义 `MsgContext`，`:283` 定义 `FinalizedMsgContext`（在 `MsgContext` 基础上 `Omit` 掉 `CommandAuthorized` 并补派生字段）。

### SessionEntry

- 英文原名：`SessionEntry`
- 中文译名：会话条目
- 定义：一个会话的元数据记录，是会话存储 `sessions.json` 里 `sessionKey -> SessionEntry` 映射的值。它存放模型/provider/agent 路由、token 计数与成本、压缩标记、生命周期时间戳、行为开关、插件扩展槽等轻量元数据，通过 `sessionId` + `sessionFile` 指向真正的转录文件。
- 代码位置：`src/config/sessions/types.ts:174` 定义 `SessionEntry` 类型，`src/config/sessions/session-file.ts` 负责其读写。

### 会话存储

- 英文原名：`session store`
- 中文译名：会话存储
- 定义：保存所有会话元数据的单个 JSON 文件，路径形如 `<stateDir>/agents/<agentId>/sessions/sessions.json`。它扮演「目录/路由表」角色——小、需频繁随机读写、需整体加载做维护。与「会话转录」分两层物理存储。
- 代码位置：`src/config/sessions/session-file.ts` 实现加载/原子写；写串行化由 `store-writer` 负责（见第 06 章 §2）。

### 会话转录

- 英文原名：`session transcript`
- 中文译名：会话转录
- 定义：每个会话一个 JSONL 文件（`<...>/sessions/<sessionId>.jsonl`），逐行一个 JSON——一个 session 头加若干 message 条目。它是「正文」，存放完整对话历史，只追加、极少整体读取。条目间用父链接从线性日志构成树。
- 代码位置：转录格式与父链接见第 06 章 §3；`src/sessions/transcript-events.ts` 处理转录事件。

### ReplyDispatcher

- 英文原名：`ReplyDispatcher`
- 中文译名：回复分发器
- 定义：出站投递层的中枢。它接收 agent 产生的回复，按投递类型入队、做人性化延迟、追踪 in-flight 投递、发出 idle 信号，最终把回复送回原渠道。一个 dispatcher 对应一条投递队列。
- 代码位置：`src/auto-reply/reply/reply-dispatcher.types.ts:5` 定义 `ReplyDispatcher` 类型，`src/auto-reply/reply/reply-dispatcher.ts` 是运行时实现，`dispatcher-registry.js` 统计全局 pending 投递数。

### ReplyPayload

- 英文原名：`ReplyPayload`
- 中文译名：回复载荷
- 定义：一次回复的结构化内容，从 agent 事件累积而成，包含文本、媒体、元数据等。投递前会经过归一化再交给渠道发送。core 内部用带 `trustedLocalMedia` 的完整形态，暴露给插件 SDK 的是去掉该字段的安全子集。
- 代码位置：`src/auto-reply/reply-payload.ts:7` 定义内部 `ReplyPayload`，`src/plugin-sdk/reply-payload.ts:9` 定义对插件公开的子集。

### agentCommand

- 英文原名：`agentCommand`
- 中文译名：agent 命令协调器
- 定义：把一条归一化后的消息真正交给 agent 执行的中枢函数。它本身几乎不做业务，而是把「选哪个 agent / 哪个模型 / 哪份凭证 / 怎么拼 prompt / 失败怎么 fallback / 事件发给谁」逐项委托给专门模块再串起来。
- 代码位置：`src/agents/agent-command.ts:1568` 定义 `agentCommand`，`:1596` 定义 `agentCommandFromIngress`；文件约 1623 行，内部协调器为 `agentCommandInternal`。

### attempt

- 英文原名：`attempt` / `runAgentAttempt`
- 中文译名：单次尝试
- 定义：一次具体的 LLM 调用尝试。外层 `runWithModelFallback` 是 fallback 循环，内层 `runAgentAttempt` 执行单次 attempt，可走 embedded pi、CLI agent 或 ACP 三种 runner。模型在尝试间失败可切到 fallback 模型，session 也可中途 live model switch 重试。
- 代码位置：`runWithModelFallback` / `runAgentAttempt` 见第 07 章 §7.7；`runAgentAttempt` 最终调到 `runEmbeddedPiAgent`。

### AgentRuntimeProvider

- 英文原名：`AgentRuntimeProviderHandle`
- 中文译名：agent 运行时 provider 句柄
- 定义：agent 运行计划里指向具体 provider 运行时的句柄。它把「这次运行用哪个 provider 实现」从计划阶段解耦出来，由 runtime-plan 持有。
- 代码位置：`src/agents/runtime-plan/types.ts:73` 定义 `AgentRuntimeProviderHandle`，并在 `:390`、`:422`、`:444` 作为 `providerRuntimeHandle` 字段被引用。

### ProviderPlugin

- 英文原名：`ProviderPlugin`
- 中文译名：provider 插件对象
- 定义：LLM provider 插件向内核注册的对象，几乎全是钩子函数——认证方式、模型目录、传输细节、流处理包装。内核拥有通用推理 loop，provider 插件只提供「这个 provider 特有的部分」，于是同一套接口能容纳云端商业 API 和本地开源推理服务。
- 代码位置：`src/plugins/types.ts:1222` 定义 `ProviderPlugin` 类型，插件经 `plugins/registry.ts` 的 `registerProvider` 注册。

### auth profile

- 英文原名：`auth profile` / `AuthProfile`
- 中文译名：认证档案
- 定义：一份调用某 provider 的凭证及其元数据。同一个 provider 可配多个 auth profile，其中部分可能正在冷却；`agentCommand` 在执行前按 `resolveAuthProfileOrder` 选序，做 eligibility 检查、冷却轮换、OAuth 刷新与 fallback。
- 代码位置：auth profile 的选序与轮换见第 07 章 §7.5；session 级覆盖校验确认固定 profile 是否仍兼容当前 provider。

### model catalog

- 英文原名：`model catalog`
- 中文译名：模型目录
- 定义：一份独立于推理逻辑的数据，描述每个模型的能力、上下文窗口、定价等。它让内核知道某个模型该往哪个端点发请求、用什么 betas 头、按什么单价计费。目录可由 provider 插件贡献。
- 代码位置：`src/model-catalog/` 目录；`src/model-catalog/index.ts` 与 `provider-index/` 处理目录来源与 provider index，`authority.ts` 处理目录权威性。

### plugin SDK

- 英文原名：`plugin SDK` / `plugin-sdk`
- 中文译名：插件 SDK
- 定义：core 与插件之间唯一合法的契约层（seam）。插件只能通过 `src/plugin-sdk/*`、manifest 元数据、注入的 runtime helper 和文档化 barrel 跨入 core；core 不允许 import 任何插件的 `src/**`。`packages/plugin-sdk` 是其对外发布包。
- 代码位置：`src/plugin-sdk/`（core 内 seam），`packages/plugin-sdk/`（发布包）；架构边界由 `AGENTS.md:28-31` 规定。

### extension（插件）

- 英文原名：`extension` / `plugin`
- 中文译名：插件 / 扩展
- 定义：`extensions/` 目录下的一个独立包，承载渠道、provider、memory、工具等「能力」。仓库内部叫 `extensions/`，面向用户的文档/UI 统一叫「plugin/plugins」。当前约 134 个子目录。
- 代码位置：`extensions/` 目录（如 `extensions/telegram`、`extensions/anthropic`）；命名约定见 `AGENTS.md:17`，分类见第 10 章 §10.3。

### manifest

- 英文原名：`openclaw.plugin.json`
- 中文译名：插件清单
- 定义：每个插件包里的元数据文件，声明插件 id、类型、能力、贡献的 RPC 方法、钩子等。它是 core 感知插件而无需 import 其代码的关键——core 只读清单元数据。
- 代码位置：每个插件目录下的 `openclaw.plugin.json`（如 `extensions/telegram/openclaw.plugin.json`）；清单结构见第 10 章 §10.4.1。

### bundled 插件

- 英文原名：`bundled plugin`
- 中文译名：内置打包插件
- 定义：随主仓库一起发布、其依赖被列进根 `package.json` 的插件。它和「外部 official 插件」对立——后者是独立发布、按需安装的官方插件。bundled 插件的存在是 core「插件无关」原则的受控特例。
- 代码位置：bundled 与外部 official 插件的区别见第 10 章 §10.7；`src/channels/plugins/bundled.ts`、`bundled-ids.ts` 处理 bundled 渠道。

### hook（钩子）

- 英文原名：`hook`
- 中文译名：钩子
- 定义：插件在 OpenClaw 关键流程节点注入逻辑的机制。钩子事件是一个固定枚举，插件声明对哪些事件感兴趣，由 hook-runner 在对应时机触发。
- 代码位置：`src/plugins/hook-types.ts:84-127` 定义钩子事件枚举与列表，`src/hooks/` 目录实现钩子运行；hook-runner 见第 10 章 §10.8.3。

### message_received

- 英文原名：`message_received`
- 中文译名：消息收到钩子
- 定义：一个钩子事件，在入站消息被接收时触发，让插件能观察或加工入站消息。与之配套的还有 `message_sending`（出站前）、`before_tool_call`（工具执行前）等事件。
- 代码位置：`src/plugins/hook-types.ts:84`（事件名）、`:951`（回调签名）；`message_received` 钩子说明见第 10 章 §10.8.2。

### scope

- 英文原名：`operator scope`
- 中文译名：操作权限范围
- 定义：Gateway 鉴权体系里的权限维度。共六种 operator scope，每个 RPC 方法映射到所需 scope，连接的 scope 决定它能调哪些方法。共享密钥鉴权一旦通过即授予全套 scope，这是 OpenClaw「operator + 受信设备」信任模型的落地。
- 代码位置：六种 scope 见第 14 章 §14.3.1，方法→scope 映射见 §14.3.2，检查函数 `authorizeOperatorScopesForMethod` 见 §14.3.3。

### pairing（配对）

- 英文原名：`pairing`
- 中文译名：配对
- 定义：把一台新设备纳入信任的流程。设备出示 pairing code 完成配对挑战后被加入 `allowFrom` 名单，此后即可连接 Gateway。OpenClaw 里「配对」有两种语义（设备配对与渠道账号配对）。
- 代码位置：pairing code 与配对挑战见第 14 章 §14.4.2，安全设计见 §14.4.3，`allowFrom` 名单见 §14.4.4；渠道侧配对见 `src/channels/plugins/pairing.ts`。

### SecretRef

- 英文原名：`SecretRef`
- 中文译名：机密引用
- 定义：配置文件里对一份机密的间接引用，而非明文。它指向某个 secret provider（文件 / 环境变量等），运行时再解析成真实值。文件 provider 有路径安全约束，环境变量 provider 有 allowlist。
- 代码位置：`SecretRef` 定义与解析见第 14 章 §14.5.2-14.5.3；`src/secrets/` 实现 secrets 子系统。

### durability

- 英文原名：`durability`
- 中文译名：投递持久化策略
- 定义：出站投递的可靠性档位。它决定一条回复在「能否被持久确认送达」上采取多强的保证，分三档；并通过 durable final delivery 能力协商决定渠道是否支持持久最终投递。
- 代码位置：durability 三档策略见第 11 章 §11.5.1；能力协商见第 04 章 §4.1（durable final delivery）。

### MessageReceipt

- 英文原名：`MessageReceipt`
- 中文译名：消息回执
- 定义：一次发送成功后渠道返回的确定性凭据。它记录消息在渠道侧的标识，使后续的编辑、删除操作能定位到原消息。它是渠道发送结果的「凭证」。
- 代码位置：`src/channels/message/receipt.ts` 实现回执；`MessageReceipt` 的形状与编辑/删除驱动见第 11 章 §11.4。

### compaction（压缩）

- 英文原名：`compaction`
- 中文译名：上下文压缩
- 定义：当对话转录变得过长、逼近模型上下文窗口时，把历史摘要化的过程。压缩在检查点（checkpoint）处进行，检查点会被持久化，旧转录可被归档。
- 代码位置：压缩动机、检查点与归档见第 06 章 §6；`src/context-engine/` 目录（`delegate.ts`、`registry.ts`、`types.ts`）实现上下文引擎。

### TTS

- 英文原名：`TTS`（Text-to-Speech）
- 中文译名：文本转语音
- 定义：把助手的文本回复合成为语音的能力。TTS provider 也是插件，遵循 `SpeechProviderPlugin` 契约；OpenClaw 提供 OpenAI 兼容 provider 工厂，支持多层配置合并与按 session 选音、内联 TTS 指令、长文本压缩。
- 代码位置：`src/tts/` 目录；`SpeechProviderPlugin` 契约见 `src/plugins/types.ts:1828` 与第 13 章 §13.2.3。

### RealtimeVoiceBridge

- 英文原名：`RealtimeVoiceBridge`
- 中文译名：实时语音桥
- 定义：实时语音通话（Talk）功能的 provider 契约。它把渠道侧音频流与 provider 的实时模型桥接起来，由 `createRealtimeVoiceBridgeSession` 建立会话，`TalkSessionController` 管回合，并处理音频编解码与 Mark 策略。
- 代码位置：`RealtimeVoiceBridge` 契约见第 13 章 §13.4.2；`createRealtimeVoiceBridgeSession` 见 §13.4.4，`src/talk/` 实现整套 Talk。

### Canvas

- 英文原名：`Canvas`
- 中文译名：画布
- 定义：Control UI 里可交互的富消息面板。除了纯文本与 Markdown，助手可以渲染代码块、图片、语音、结构化富面板。Canvas 是「产品是 assistant」这句定位在前端的体现。
- 代码位置：Canvas 富面板渲染见第 12 章 §12.5.4；Markdown 渲染与净化见 §12.5.1。

### INTERNAL_MESSAGE_CHANNEL

- 英文原名：`INTERNAL_MESSAGE_CHANNEL`
- 中文译名：内部消息渠道（WebChat）
- 定义：WebChat 这一内建渠道使用的渠道标识常量。WebChat 不是 `extensions/` 下的外置插件，而是由 Gateway 直接服务的内建渠道，因此它的 channel id 是一个内部常量而非插件 id。
- 代码位置：`src/infra/exec-approval-surface.ts:9` import 并在 `:23` 等处使用 `INTERNAL_MESSAGE_CHANNEL`；WebChat 为何内建见第 04 章 §7.1-7.2。

### WebChat

- 英文原名：`WebChat`
- 中文译名：网页聊天
- 定义：OpenClaw 自带的浏览器内聊天渠道。与其它二十余种渠道不同，它不依赖外部 IM 平台，直接由 Gateway 的 HTTP/WS 服务承载，并有自己的媒体路径。它是 Control UI 里直接和助手对话的入口。
- 代码位置：WebChat 渠道见第 04 章 §7；其媒体路径见 §7.3，渠道标识见 `INTERNAL_MESSAGE_CHANNEL`。

### RPC 方法注册表

- 英文原名：`GatewayMethod registry`
- 中文译名：RPC 方法注册表
- 定义：Gateway 把所有可被 WebSocket 客户端调用的 RPC 方法集中登记的内存表。方法描述符 `GatewayMethodDescriptor` 描述每个方法的名字、scope、handler；方法有三类来源（core、渠道贡献、动态），统一进一个注册表，且注册表本身可替换。
- 代码位置：`src/gateway/methods/registry.ts` 实现注册表，`descriptor.ts` 定义 `GatewayMethodDescriptor`，`core-descriptors.ts` 是 core 方法；详见第 02 章 §3。

### stream 事件

- 英文原名：`stream event` / `agent event`
- 中文译名：流式事件
- 定义：agent 运行过程中产生的事件，分 lifecycle、assistant、tool、item 等类型。它们带序号、有可见性控制，经 `server-chat.ts` 投影并由 `createGatewayBroadcaster` 按 scope 过滤后广播给 WebSocket 订阅者，是 Control UI 实时渲染的数据源。
- 代码位置：事件模型与 emit 序号见第 07 章 §7.8；广播与 scope 过滤见第 11 章 §11.6，事件投影器为 `src/gateway/server-chat.ts`。

### chat 事件

- 英文原名：`chat event`
- 中文译名：聊天事件
- 定义：广播事件的两大类之一（另一类是 agent 事件）。chat 事件聚焦于「面向用户的最终聊天内容」，文本增量会被节流，最终通过 `emitChatFinal` 收尾。前端 `handleChatEvent` 据此做文本流式渲染。
- 代码位置：两类广播事件见第 11 章 §11.6.1，`emitChatFinal` 见 §11.6.4；前端 `handleChatEvent` 见第 12 章 §12.4.2。

### surface（鉴权面 / 审批面）

- 英文原名：`surface`
- 中文译名：面
- 定义：OpenClaw 用「surface」描述某个能力对外暴露的「面」。鉴权面（auth surface）区分不同入口的鉴权处理；exec 审批面（exec-approval-surface）区分某次工具审批落在哪个渠道上，从而决定审批 UI 形态。
- 代码位置：鉴权面区别见第 14 章 §14.2.3；`src/infra/exec-approval-surface.ts` 实现 exec 审批面（对 `INTERNAL_MESSAGE_CHANNEL`、`tui` 等做特判）。

### SessionKey

- 英文原名：`SessionKey`
- 中文译名：会话键
- 定义：把一条入站消息路由到唯一会话的键。入站管线用 `resolveSessionKey` / `deriveSessionKey` 计算它，再据此在会话存储里找到对应 `SessionEntry`。会话键与运行时策略键被刻意分离——前者标识「这是哪段对话」，后者标识「这次运行用什么策略」，二者不能混用。
- 代码位置：会话路由见第 05 章 §4，`resolveSessionKey` 见 §4.1，`deriveSessionKey` 见 §4.2，键结构与解析见 §4.3。

### dispatchInboundMessage

- 英文原名：`dispatchInboundMessage`
- 中文译名：入站分发总协调器
- 定义：入站管线的总入口函数。它在 `FinalizedMsgContext` 就位后协调静默回复策略、前台代次围栏（foreground reply fence）、`message_sending` 钩子，然后委派给 `dispatchReplyFromConfig` 完成会话解析、agent 执行与投递。
- 代码位置：`src/auto-reply/dispatch.ts`；主流程见第 05 章 §6.2，前台代次围栏见 §6.3。

### definePluginEntry

- 英文原名：`definePluginEntry`
- 中文译名：插件入口定义函数
- 定义：插件作者用来声明插件入口的契约函数。它把插件的注册逻辑包装成一个标准入口对象，由插件加载器发现并调用。provider 插件还有 `defineSingleProviderPluginEntry` 简化变体。
- 代码位置：`definePluginEntry` 见第 10 章 §10.5.2 与第 08 章 §8.2.2；`defineSingleProviderPluginEntry` 见第 08 章 §8.3.4。

### ToolDescriptor

- 英文原名：`ToolDescriptor`
- 中文译名：工具描述符
- 定义：工具在「声明层」的协议对象，描述工具的名字、参数 schema、可用性表达式等。可用性表达式让工具能根据信号动态「出现/消失」。`buildToolPlan` 把描述符编译成工具计划。
- 代码位置：`ToolDescriptor` 结构见第 09 章 §9.3.1，用 `defineToolDescriptor` 定义见 §9.3.2，`buildToolPlan` 见 §9.4.3。

### 审批门控

- 英文原名：`approval gate`
- 中文译名：审批门控
- 定义：高风险工具（如 exec）在执行前必须经过的人工审批环节。审批请求被构造并发到对应渠道，可走两阶段审批；exec 工具的描述还会随审批策略自适应。
- 代码位置：审批门控见第 09 章 §9.10；两阶段审批见 §9.10.3，`src/channels/plugins/approvals.ts` 与 `exec-approval-local.ts` 参与实现。

### skills（技能）

- 英文原名：`skills`
- 中文译名：技能
- 定义：一种轻量的、文件驱动的能力扩展。技能带元数据（含触发短语），由加载流程发现，支持热重载，并以技能快照形式参与 prompt 构建。技能与「工具」是两个不同概念。
- 代码位置：技能定义见第 09 章 §9.11，元数据见 §9.11.2，加载流程见 §9.11.3，热重载见 §9.11.4；技能快照参与 prompt 见第 07 章 §7.6.1。

### MCP

- 英文原名：`MCP`（Model Context Protocol）
- 中文译名：模型上下文协议
- 定义：一个让模型接入外部工具/数据的协议。OpenClaw 既能作为 MCP 服务端（把自身能力暴露给别的客户端），也能作为 MCP 客户端（接入外部 MCP 服务器的工具）。
- 代码位置：MCP 集成见第 09 章 §9.12；`src/mcp/` 目录实现服务端与客户端两侧。

### pi-embedded-runner

- 英文原名：`pi-embedded-runner` / `runEmbeddedPiAgent`
- 中文译名：内嵌 pi 运行器
- 定义：真正执行推理 loop 的运行时——发 HTTP 请求、收流、跑工具、再发请求。`runAgentAttempt` 在 embedded 分支里调 `runEmbeddedPiAgent`，把 prompt、provider、model、authProfileId 等参数传入。
- 代码位置：`pi-embedded-runner/` 拥有推理 loop（见第 08 章架构图）；`runEmbeddedPiAgent` 由 `runAgentAttempt` 调用（第 07 章 §7.7.3）。

### config snapshot

- 英文原名：`ConfigFileSnapshot` / `config snapshot`
- 中文译名：配置快照
- 定义：一次配置读取的完整产物，是某一时刻 `openclaw.json` 经解析、`${ENV}` 替换、校验后的不可变结果。Gateway 启动的第一阶段就是拍配置快照。配置系统据此实现「读时固定语义」与损坏恢复。
- 代码位置：`ConfigFileSnapshot` 见第 03 章 §1.5；快照与 `loadConfig` 语义见 §3.4，`src/config/io.ts` 实现 IO。

### 热重载

- 英文原名：`hot reload` / `config-reload`
- 中文译名：热重载
- 定义：改了配置文件不强制重启 Gateway 的能力。文件监听用 chokidar，改动经去抖动后排队处理；系统区分「可热重载」与「必须重启」的改动（如换监听端口），并用「写者意图」避免自反馈。
- 代码位置：`src/gateway/config-reload.ts`；chokidar 监听见第 03 章 §5.1，热重载 vs 重启见 §5.4。技能也支持热重载（第 09 章 §9.11.4）。

### startup trace

- 英文原名：`startup trace`
- 中文译名：启动追踪
- 定义：贯穿整条启动链的计时工具。当环境变量 `OPENCLAW_GATEWAY_STARTUP_TRACE` 为真时，`entry.ts`、`run-main.ts`、`server.impl.ts` 各阶段都会往日志打耗时，是排查启动慢的利器。
- 代码位置：`createGatewayEntryStartupTrace` 见 `src/entry.ts:35-66`，`createGatewayStartupTrace` 见 `src/gateway/server.impl.ts:223-419`。

### profile（配置档）

- 英文原名：`profile` / `--profile`
- 中文译名：配置档
- 定义：用 `--profile` / `--dev` 选择的一份隔离配置，让同一台机器跑多份互不干扰的 OpenClaw 实例。`--profile` 与 `--container` 互斥，组合使用会直接退出。
- 代码位置：`parseCliProfileArgs` + `applyCliProfileEnv` 见 `src/entry.ts:120-146`；`--profile` 与 `--container` 互斥见 `src/entry.ts:136-140`。

### gateway run fast-path

- 英文原名：`gateway run fast-path`
- 中文译名：网关启动快速通道
- 定义：CLI 路由里的一个分支。当检测到调用是「纯粹的 `openclaw gateway run` + 已知选项」时，只构建极简 Commander 程序，跳过整个插件 CLI 注册流程，以压缩 Gateway 这一最高频命令的冷启动延迟。
- 代码位置：`isGatewayRunFastPathArgv` 见 `src/cli/run-main.ts:94-134`，`tryRunGatewayRunFastPath` 见 `:148-205`。

### bind 模式

- 英文原名：`bind`
- 中文译名：绑定模式
- 定义：Gateway 监听器绑定哪个网络地址的设定。默认只绑 loopback（单用户、自托管的安全默认）；绑超出 loopback 时必须配置鉴权 token，否则 Gateway 拒绝启动。
- 代码位置：bind 模式见第 02 章 §2.2；非 loopback 时的鉴权要求见 `.env.example` 关于 `OPENCLAW_GATEWAY_TOKEN` 的注释。

### compile cache

- 英文原名：`compile cache`
- 中文译名：编译缓存
- 定义：Node 22 的 `module.enableCompileCache` 把 V8 编译产物缓存到磁盘以加快冷启动。OpenClaw 区分源码 checkout（禁用，避免用旧产物）和打包安装（按版本算稳定缓存目录）。
- 代码位置：compile cache 决策见 `openclaw.mjs:48-85`、`206-248`；`resolvePackagedCompileCacheDirectory` 见 `openclaw.mjs:66-85`。

### node / 节点设备

- 英文原名：`node`
- 中文译名：节点设备
- 定义：连到 Gateway 的受信设备（如 macOS / iOS / Android 原生 app）。它们通过 WebSocket 接入控制平面，可承载工具副作用（如设备本地操作）。Gateway 在内存里维护节点注册表。
- 代码位置：节点注册表是 Gateway 内存注册表之一（第 01 章 §3.1 架构图）；`src/node-host/` 处理节点宿主。

### trusted-proxy 模式

- 英文原名：`trusted-proxy`
- 中文译名：受信代理模式
- 定义：三种鉴权模式之一。当 Gateway 部署在受信反向代理之后时，由代理负责鉴权，Gateway 信任代理注入的身份头。与之并列的还有 token/password 鉴权与 Tailscale 头鉴权。
- 代码位置：trusted-proxy 模式见第 14 章 §14.2.5；Tailscale 头鉴权见 §14.2.6。

### Talk

- 英文原名：`Talk`
- 中文译名：实时语音通话
- 定义：OpenClaw 的实时双向语音对话功能，让用户能像打电话一样和助手交谈。它由 `RealtimeVoiceBridge` provider 契约支撑，`TalkSessionController` 负责回合管理。
- 代码位置：Talk 解决的问题见第 13 章 §13.4.1；`TalkSessionController` 见 §13.4.5，`src/talk/` 是实现目录。

### media understanding

- 英文原名：`media understanding`
- 中文译名：媒体理解
- 定义：让模型「看懂、听懂」图片、音频等媒体的能力。统一管线 `runMediaUnderstandingFile` 处理本地文件与远程 URL，按渠道 scope 决定是否理解媒体，并支持结构化抽取。
- 代码位置：媒体理解见第 13 章 §13.5；统一管线 `runMediaUnderstandingFile` 见 §13.5.2，`src/media-understanding/` 是实现目录。

---

## Part 2：FAQ

### Q1：为什么 core（`src/`）对插件保持「无关」（plugin-agnostic）？

因为这是 OpenClaw 的硬性架构边界：`AGENTS.md:28-31` 规定「Core stays plugin-agnostic. No bundled ids/defaults/policy in core」，core 不允许 import 任何插件的 `src/**`。这样做的收益是渠道、provider、工具能独立开发、独立加载、独立测试，甚至第三方也能写。`src/channels/registry.ts:22-26` 的注释把这条原则写得很直白。读 `src/` 时若看到对 `extensions/` 的直接引用，要么是 bug，要么是「内置 bundled 插件」的受控特例。

### Q2：bundled 插件和外部 official 插件有什么区别？

bundled 插件随主仓库一起发布，其依赖被列进根 `package.json`（这也是根 `package.json` 高达 100KB 的原因之一）；外部 official 插件是独立发布、按需安装的官方插件。两者在加载器看来都是合法插件，区别在分发方式和是否默认在场。详见第 10 章 §10.7。`src/channels/plugins/bundled.ts` 与 `bundled-ids.ts` 处理 bundled 渠道。

### Q3：一条消息从渠道进来到回复发出，完整走了哪条路？

五段：① 渠道插件把平台原生载荷装进 `MsgContext`；② `finalizeInboundContext` 定稿成 `FinalizedMsgContext`；③ `dispatchInboundMessage`（`src/auto-reply/dispatch.ts`）做静默回复策略、前台代次围栏、`message_sending` 钩子；④ `dispatchReplyFromConfig` 解析会话并调 `agentCommand`（`src/agents/agent-command.ts:1568`）执行 agent；⑤ agent 产生的 `ReplyPayload` 经 `ReplyDispatcher` 投递回原渠道。这条链是第 05、07、11 章的主线。

### Q4：如何加一个新渠道？

写一个 `extensions/<channel>/` 插件包，提供 `openclaw.plugin.json` 清单和 `definePluginEntry` 入口，实现 `ChannelPlugin` 契约（`src/channels/plugins/types.ts`），把平台消息归一化为入站结构、把 `ReplyPayload` 渲染成平台发送。core 不需要改动——它只通过清单元数据和注入的 runtime helper 感知新渠道。Telegram 是一个完整范例（第 04 章 §6）。

### Q5：如何加一个新 LLM provider？

写一个 `extensions/<id>/` 插件，向内核 `registerProvider` 注册一个 `ProviderPlugin` 对象（`src/plugins/types.ts:1222`），对象里提供 provider 特有的钩子——认证方式、模型目录、传输细节、流处理包装。内核的通用推理 loop（`pi-embedded-runner/`）保持不变。还要贡献 model catalog 数据描述模型能力与定价。Anthropic 是范例（第 08 章 §8.9.1）。

### Q6：会话状态存在哪里、是什么格式？

分两层物理存储。元数据存在 `<stateDir>/agents/<agentId>/sessions/sessions.json`，是一个 `sessionKey -> SessionEntry` 的 JSON 映射（`SessionEntry` 定义在 `src/config/sessions/types.ts:174`）。对话正文存在每会话一个的 `<sessionId>.jsonl` 文件，逐行 JSON、只追加。分两层是因为元数据小而需频繁随机读写，正文大而只追加。详见第 06 章 §0。

### Q7：WebChat 和其它渠道有什么不同？

其它二十余种渠道都是 `extensions/` 下的外置插件，封装某个外部 IM 的 SDK；WebChat 是内建渠道，不依赖任何外部平台，直接由 Gateway 的 HTTP/WS 服务承载，有自己的媒体路径。它的 channel id 是内部常量 `INTERNAL_MESSAGE_CHANNEL`（`src/infra/exec-approval-surface.ts:9`）而非插件 id。WebChat 为何内建见第 04 章 §7.1。

### Q8：Gateway 鉴权有哪几种模式？

主要有三类（第 14 章 §14.2）：① token / password 鉴权——共享密钥，做时序安全比较，一旦通过即授予全套 scope；② trusted-proxy 模式——部署在受信反向代理后由代理鉴权；③ Tailscale 头鉴权——信任 Tailscale 注入的身份头。Gateway 默认只绑 loopback，绑超出 loopback 时必须配置 `OPENCLAW_GATEWAY_TOKEN`，否则拒绝启动。

### Q9：配置热重载是怎么工作的？为什么有些改动还要重启？

`src/gateway/config-reload.ts` 用 chokidar 监听 `openclaw.json`，改动经去抖动后排队，重新拍配置快照并应用。但有些改动（典型如换监听端口、换 bind 地址）无法在不重建监听器的情况下生效，系统因此会产出一份「重载计划」区分「可热重载」与「必须重启」。它还用「写者意图」避免 OpenClaw 自己写配置又触发自己的重载。详见第 03 章 §5。

### Q10：为什么 prompt 缓存需要确定性的拼装顺序？

LLM provider 的 prompt 缓存按前缀匹配命中——只有当本次请求的 prompt 前缀与上次逐字节相同才能复用缓存。OpenClaw 因此要求聊天历史、工具、技能快照、上下文等元素以确定的顺序拼装；任何顺序抖动都会让缓存前缀失配、白白付全价。这一约束贯穿第 07 章 §7.6 的 prompt 构建。

### Q11：广播事件里 agent 事件和 chat 事件如何区分阶段？

广播分两类（第 11 章 §11.6.1）：agent 事件细粒度，覆盖 lifecycle / assistant / tool / item 各阶段，带序号和可见性，主要喂给工具流渲染（前端 `handleAgentEvent`）；chat 事件聚焦面向用户的最终聊天文本，增量被节流，最终用 `emitChatFinal` 收尾（前端 `handleChatEvent`，第 12 章 §12.4.2）。两者都经 `server-chat.ts` 投影、由 `createGatewayBroadcaster` 按 scope 过滤。

### Q12：agent attempt 的三种 runner 是什么、什么时候用哪个？

`runAgentAttempt`（第 07 章 §7.7.3）按 agent 配置选 runner：embedded pi（`runEmbeddedPiAgent`，内核自带推理 loop，最常用）、CLI agent（`runCliAgent`，把执行委托给外部 CLI agent）、ACP（走 ACP 协议的有状态目标）。外层 `runWithModelFallback` 在 attempt 失败时切到 fallback 模型，session 中途换模型则触发 live model switch 重试。

### Q13：工具审批门控是怎么触发的？谁来批？

高风险工具（典型是 exec）在执行前必须经过审批（第 09 章 §9.10）。`before_tool_call` 钩子时机会构造审批请求，按发起会话所在渠道决定审批面（`src/infra/exec-approval-surface.ts` 对 `INTERNAL_MESSAGE_CHANNEL`、`tui` 等做特判），可走两阶段审批。operator 在对应渠道/UI 上批准或拒绝，exec 工具的描述文本也会随当前审批策略自适应。

### Q14：启动那么多 `await import(...)` 是为什么？

为了压缩冷启动。OpenClaw 的普遍模式是延迟加载——只在真正需要时才把模块拉进内存。典型例子是 `src/gateway/server.ts` 这个仅 35 行的薄壳，它用动态 import 延迟加载 1687 行的 `server.impl.ts`，这样「只想查 Gateway 协议常量」的代码不必把整个启动实现拖进内存。`run-main.ts` 里也有几十处动态 import。配合 help / version / gateway run fast-path，这是 OpenClaw 对启动性能的一贯追求（第 01 章 §4.5）。

### Q15：为什么 `openclaw.mjs` 启动器是纯 `.mjs`、不经过构建？

因为它要在「`dist/` 还没构建出来」时也能给出有意义的报错。启动器负责 Node 版本检查、compile cache 决策、信号转发与 respawn，最后才 `import("./dist/entry.js")`；如果 dist 缺失，它能精确告诉用户「你装的是未构建的源码树，请 `pnpm build`」（`openclaw.mjs:311-326`）。它的信号处理逻辑和 `src/entry.compile-cache.ts` 是有意重复的——因为启动器还不能 import TS 代码。

### Q16：测试为什么不能直接跑 `vitest`？

`AGENTS.md:60` 明确「never raw `vitest`」。普通源码 checkout 用 `pnpm test <path-or-filter>`；Codex worktree 或链接/稀疏 checkout 里应避免直接 `pnpm test*`，改用 `node scripts/run-vitest.mjs`。原因是 Vitest 的文件系统缓存会在并发或特殊 checkout 下竞争，导致 `ENOTEMPTY` 等错误；OpenClaw 的 `scripts/` 包装器统一了 worker 数、缓存路径等约束。

---

## Part 3：调试与开发速查

### 3.1 环境变量表

下表从 `.env.example` 提炼。环境变量优先级（高到低）：进程环境 > `./.env` > `~/.openclaw/.env` > `openclaw.json` 的 `env` 块；已存在的非空进程环境变量不会被 dotenv 覆盖。

| 变量 | 默认 / 示例 | 作用 |
|------|------------|------|
| `OPENCLAW_GATEWAY_TOKEN` | 空（首启自动生成） | Gateway 鉴权 token。绑定超出 loopback 时必填。设为文档里的示例占位符会被拒绝启动 |
| `OPENCLAW_GATEWAY_PASSWORD` | 未设置 | 可选的替代鉴权模式（token 与 password 二选一） |
| `OPENCLAW_STATE_DIR` | `~/.openclaw` | 状态目录（会话、auth profile 等） |
| `OPENCLAW_CONFIG_PATH` | `~/.openclaw/openclaw.json` | 配置文件路径 |
| `OPENCLAW_HOME` | `~` | OpenClaw 的 home 基准目录 |
| `OPENCLAW_AUTH_PROFILE_SECRET_DIR` | 未设置 | auth profile 加密密钥材料目录（Docker 下挂在 state dir 之外） |
| `OPENCLAW_INCLUDE_ROOTS` | 未设置 | `openclaw.json` 里 `$include` 指令可解析文件的额外目录 allowlist（路径分隔） |
| `OPENCLAW_LOAD_SHELL_ENV` | 未设置 | 设为 `1` 时从登录 shell profile 导入缺失的 env key |
| `OPENCLAW_SHELL_ENV_TIMEOUT_MS` | `15000` | 读取 shell env 的超时（毫秒） |
| `OPENCLAW_GATEWAY_STARTUP_TRACE` | 未设置 | 为真时打印 Gateway 启动各阶段耗时（排查启动慢） |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | 未设置 | 对应 provider 的 API key（至少设一个）。另有 `_1` 后缀、`_KEYS` 复数等多 key 形态 |
| `OPENROUTER_API_KEY` / `GOOGLE_API_KEY` / `ZAI_API_KEY` 等 | 未设置 | 其它 provider 的可选 key |
| `OPENCLAW_LIVE_OPENAI_KEY` / `OPENCLAW_LIVE_ANTHROPIC_KEY` 等 | 未设置 | live 测试专用 provider key |
| `TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN` / `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` | 未设置 | 对应渠道的接入凭证（只设你启用的） |
| `MATTERMOST_BOT_TOKEN` / `MATTERMOST_URL` / `ZALO_BOT_TOKEN` / `OPENCLAW_TWITCH_ACCESS_TOKEN` | 未设置 | 其它渠道的 env 回退 |
| `BRAVE_API_KEY` / `PERPLEXITY_API_KEY` / `FIRECRAWL_API_KEY` | 未设置 | web 搜索/抓取工具的 key |
| `ELEVENLABS_API_KEY` / `XI_API_KEY` / `INWORLD_API_KEY` / `DEEPGRAM_API_KEY` | 未设置 | 语音/媒体 provider 的 key（`XI_API_KEY` 是 ElevenLabs 别名） |
| `OPENCLAW_LIVE_TEST` | 未设置 | 设为 `1` 时启用 live 测试（`pnpm test:live`），见 `AGENTS.md:130` |
| `OPENCLAW_VITEST_MAX_WORKERS` | 未设置 | 限制 Vitest worker 数，内存吃紧时设 `1`，见 `AGENTS.md:129` |
| `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH` | 未设置 | 为并发的多个测试命令指定不同 Vitest 缓存路径，避免缓存竞争 |
| `NODE_DISABLE_COMPILE_CACHE` | 未设置 | 源码 checkout 下启动器会带此变量 respawn 自己（`openclaw.mjs:183-204`） |

### 3.2 常用命令表

下表从 `AGENTS.md:59-65` 与根 `package.json` scripts 提炼。Codex worktree / 链接 checkout 里要避免直接 `pnpm test*` / `pnpm check*`，改用 `node` 包装器或 Crabbox/Testbox。

| 命令 | package.json 行 | 作用 |
|------|-----------------|------|
| `pnpm openclaw ...` | `package.json:1516` | 在源码树里运行 OpenClaw CLI（`node scripts/run-node.mjs`） |
| `pnpm dev` | `package.json:1434` | 开发模式运行（`node scripts/run-node.mjs`） |
| `pnpm build` | `package.json:1365` | 全量构建（`node scripts/build-all.mjs`）：tsdown 构建 + 元数据 + 插件资源 |
| `pnpm test <path-or-filter>` | `package.json:1581` | 跑测试（`node scripts/test-projects.mjs`）；从不直接 `vitest` |
| `pnpm test:fast` | `package.json:1679` | 跑单元测试快速分片 |
| `pnpm test:changed` / `test:serial` / `test:coverage` | — | 只测改动 / 串行跑 / 带覆盖率 |
| `pnpm test:extensions` / `pnpm test extensions/<id>` | — | 跑插件测试 / 单个插件测试 |
| `pnpm test:live` | — | live 测试（需 `OPENCLAW_LIVE_TEST=1`） |
| `pnpm check` | `package.json:1373` | 全量检查（`node scripts/check.mjs`） |
| `pnpm check:changed` / `--staged` | — | 只检查改动 / 暂存区 |
| `pnpm changed:lanes --json` | — | 列出受影响的检查 lane |
| `pnpm lint` | `package.json:1473` | oxlint 分片检查（`node scripts/run-oxlint-shards.mjs`） |
| `pnpm format` | `package.json:1447` | oxfmt 格式化（`oxfmt --write`） |
| `pnpm tsgo*` / `pnpm check:test-types` | — | 类型检查 lane（用 `tsgo`，从不加 `tsc --noEmit`） |
| `pnpm check:import-cycles` | — | 检查导入环（保持与架构/madge 一致） |
| `node scripts/run-vitest.mjs <path>` | — | worktree / 稀疏 checkout 下的测试代理入口 |
| `node openclaw.mjs` | `package.json` `start` | 直接运行启动器（全局安装后的 `bin`） |

### 3.3 关键目录速查表

| 目录 | 职责 |
|------|------|
| `src/entry.ts` | 进程入口：`isMainModule` 守卫、argv 规范化、profile/container、启动 trace |
| `src/cli/` | CLI 命令路由（`run-main.ts` 总调度，`gateway-cli/` 是 gateway 命令） |
| `src/gateway/` | Gateway 控制平面：`server.impl.ts`（启动序列）、`methods/`（RPC 注册表）、`protocol/`（帧格式）、`server-chat.ts`（事件投影）、`config-reload.ts`（热重载） |
| `src/channels/` | 渠道抽象层：`plugins/`（`ChannelPlugin` 契约与注册表）、`message/`（消息类型契约与发送运行时） |
| `src/auto-reply/` | 入站管线与出站投递：`dispatch.ts`（分发协调）、`templating.ts`（`MsgContext`）、`reply/`（`ReplyDispatcher`） |
| `src/sessions/` 与 `src/config/sessions/` | 会话状态：`SessionEntry` 类型、会话存储与转录的读写、生命周期 |
| `src/agents/` | agent 编排：`agent-command.ts`（`agentCommand` 协调器）、`runtime-plan/`、attempt 与 fallback |
| `src/plugins/` | 插件加载器与 runtime：`types.ts`（`ProviderPlugin` 等）、`registry.ts`、`hook-types.ts`、`api-builder` |
| `src/plugin-sdk/` | core 内的插件 SDK seam（插件跨入 core 的唯一合法边界） |
| `src/model-catalog/` | 模型目录：能力 / 定价 / 上下文窗口、provider index |
| `src/provider-runtime/` 与 `pi-embedded-runner` | core 拥有的通用重试逻辑 / 真正的推理 loop |
| `src/tools/` | 工具：`ToolDescriptor` 协议、工具装配与执行、审批门控 |
| `src/mcp/` | MCP 集成（服务端 + 客户端两侧） |
| `src/secrets/` 与 `src/security/` | `SecretRef` 解析、secrets 审计 / 安全审计与危险配置标识 |
| `src/pairing/` 与 `src/channels/plugins/pairing.ts` | 设备配对与渠道账号配对 |
| `src/tts/` / `src/realtime-transcription/` / `src/talk/` | 文本转语音 / 实时转写 / 实时语音通话（`RealtimeVoiceBridge`） |
| `src/media/` / `src/media-understanding/` / `src/media-generation/` | 媒体存储与 TTL 清理 / 媒体理解 / 媒体生成 |
| `src/hooks/` | 钩子运行（hook-runner、bundled 钩子、配置化钩子） |
| `src/context-engine/` | 上下文压缩（compaction）与上下文引擎 |
| `extensions/` | 约 134 个插件：渠道、provider、memory、工具、诊断等（`extensions/telegram`、`extensions/anthropic` …） |
| `ui/` | 浏览器端 Control UI：Vite + 自定义元素，`ui/src/` 是源码，承载 WebChat 与 Canvas |
| `packages/sdk` | 对外发布的稳定 SDK |
| `packages/plugin-sdk` | 对外发布的插件 SDK 包（与 `src/plugin-sdk/` 配套） |
| `packages/memory-host-sdk` | memory host 的 SDK 包 |
| `packages/plugin-package-contract` | 插件包格式契约 |
| `apps/` | 原生伴生应用：macOS / iOS / Android / Windows / Linux 客户端 |
| `scripts/` | 构建与运维脚本（`build-all.mjs`、`run-vitest.mjs`、`check.mjs` …） |
| `config/` | 构建期工具配置（tsconfig 模板、knip、lint） |

---

读到这里，整本 wiki 的 15 章已经走完一遍。建议把本章的术语表当作长期工具页：阅读任何一段源码遇到不认识的概念，先回查 Part 1 的「代码位置」一栏定位到定义文件，再到对应章节看上下文。FAQ 则适合在「明明每个文件都看懂了、却拼不出全局」时翻阅——它回答的正是那些跨文件的「为什么」。
