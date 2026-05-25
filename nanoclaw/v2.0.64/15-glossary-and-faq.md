代码版本锁定到 nanocoai/nanoclaw@0683c6e（标签 v2.0.64，2026-05-18）。本章所有 `file:line` 引用都指向这一棵代码树。

本章是整本 wiki 反复回指的速查层。**第一部分**是术语表——把前 14 章里出现的"名词"（类名、表名、概念、缩写）收成可查的一张索引，每条都附代码位置，网页版的术语解析器会自动从正文里挑出这些词加下划线、点击弹定义。**第二部分**是 FAQ，挑了 15 个第一次读 NanoClaw 源码最容易卡住的问题；多数都需要跨文件的证据才能给出回答。**第三部分**是调试 / 开发 / 运维的速查附录：环境变量表、常用命令、关键路径、测试目录、故障锚点。

本章没有图。要看图请到第 1–14 章。要跳代码请直接点引用。

---

## Part 1：术语表

### NanoClaw

- 英文原名：`NanoClaw`
- 中文译名：NanoClaw（项目名，不译）
- 定义：个人 Claude 助手网关。一个 Node 单进程 host 同时挂在 Discord/Slack/Telegram/iMessage/WhatsApp/邮件/本地终端等若干渠道上，按"用户 → 消息组 → 智能体组 → session"四层实体模型把消息路由到对应 agent，再为每个 session 启动一个独立的 Bun 容器执行 Claude Agent SDK。host 与容器只通过 SQLite 文件通信，没有任何 IPC / 套接字 / stdin pipe。
- 代码位置：`src/index.ts:1` 是 host 入口；`CLAUDE.md:21` 给出一句话定义；项目根 `package.json:2` 的 `"name": "nanoclaw"`。

### Host（host 进程）

- 英文原名：`Host`
- 中文译名：宿主进程 / 主进程
- 定义：常驻的 Node 进程，跑在用户机器（macOS launchd 或 Linux systemd）上。职责：初始化中央 DB、运行迁移、加载所有 channel adapter、起 router / delivery / sweep / CLI socket / webhook server、生成 / 唤醒 / 杀掉 session 容器。Host 是所有持久状态的唯一权威来源——agent 容器是无状态的、可随时被杀。
- 代码位置：`src/index.ts:67` 的 `main()` 是启动序列；`src/index.ts:177` 起 `ncl` socket server；`src/host-core.test.ts` 验证启动顺序。

### Container（agent 容器）

- 英文原名：`Container` / `Agent Container`
- 中文译名：智能体容器 / session 容器
- 定义：per-session 的 Linux 容器（Docker 或 Apple Container），跑 Bun + Claude Agent SDK。每个 session 一个容器实例；同一个 agent group 的不同 session 是不同容器，但共享 image / workspace 文件挂载。容器内不持久任何状态——所有需要跨重启的东西都写进 `outbound.db` 或 `session_state` 表。
- 代码位置：`src/container-runner.ts:108` 的 `spawnContainer`；`container/Dockerfile:15` 定义镜像；`container/agent-runner/src/index.ts` 是容器内 entry。

### Agent Runner

- 英文原名：`agent-runner`
- 中文译名：智能体运行时
- 定义：容器内跑的 TypeScript 程序。轮询 `inbound.db` 拿用户消息，调用 provider（默认 ClaudeProvider）跑 Claude Agent SDK，把模型输出+工具调用写回 `outbound.db`。运行在 Bun 上，与 host 的 Node 进程是两套独立的依赖树（独立 `package.json` + 独立 lockfile）。
- 代码位置：`container/agent-runner/src/index.ts:1`；poll loop 在 `container/agent-runner/src/poll-loop.ts:1`；与 host 的 runtime 分割见 `docs/build-and-runtime.md:1`。

### Session

- 英文原名：`Session`
- 中文译名：会话
- 定义：一次 agent ↔ messaging group ↔ thread 的绑定。每个 session 在 `data/v2-sessions/<agent_group_id>/<session_id>/` 下有 `inbound.db` + `outbound.db` + `.heartbeat` + `.claude/` 持久化目录。session 行存在中央 DB 的 `sessions` 表；容器只在有未处理消息时才启动，IDLE_TIMEOUT 后会被 host-sweep 杀掉。
- 代码位置：`src/db/schema.ts:104` 的 `sessions` 表；`src/session-manager.ts` 负责解析 / 创建 session；`src/db/sessions.ts` CRUD。

### Messaging Group（消息组）

- 英文原名：`Messaging Group`
- 中文译名：消息组
- 定义：一个平台上的一个聊天对象——Discord 的某个 channel、Slack 的某个 DM、Telegram 的某个 group。由 `(channel_type, platform_id)` 唯一标识。`unknown_sender_policy` 决定陌生人发消息时怎么办（`strict` / `request_approval` / `public`）。
- 代码位置：`src/db/schema.ts:25` 定义表；`src/db/messaging-groups.ts` CRUD；`src/router.ts:151` 处理自动创建并硬编码 `request_approval`。

### Agent Group（智能体组）

- 英文原名：`Agent Group`
- 中文译名：智能体组 / agent 组
- 定义：一个 agent 工作空间。带独立的 `groups/<folder>/` 目录（`CLAUDE.md`、skills、`agent-runner-src/` overlay），独立的 container config（provider/model/包/MCP server/mounts）。一个 agent group 可派生多个并发 session。**特权不挂在 agent group 上**——挂在 user 上。
- 代码位置：`src/db/schema.ts:11` 定义表；`src/db/agent-groups.ts` CRUD；`src/group-init.ts:49` 的 `initGroupFilesystem` 搭目录。

### Wiring（连线）

- 英文原名：`Wiring` / `messaging_group_agents`
- 中文译名：连线 / 接线
- 定义：messaging group 与 agent group 之间的多对多关联表。一条 wiring 记录"哪个 agent 处理哪个聊天对象、用什么 session mode、什么 engage mode、什么触发模式、消息怎么落地"。一个聊天对象可以接多个 agent，按 `priority` 排序。
- 代码位置：`src/db/schema.ts:41` 的 `messaging_group_agents` 表；`ncl wirings list/create` 见 `src/cli/resources/`。

### Trigger Rules / Engage Mode

- 英文原名：`engage_mode` / `engage_pattern`
- 中文译名：唤起模式 / 触发模式
- 定义：决定 agent 何时认为"这条消息是给我的"。`engage_mode` 三档：`pattern`（正则匹配）/ `mention`（@me 命中即触发）/ `mention-sticky`（一次 @ 之后一段时间内黏住该用户的所有后续消息）。`engage_pattern` 是 `pattern` 模式下的正则；`.` 表示"匹配所有"，等于 v1 的 "always"。
- 代码位置：`src/db/schema.ts:45-48` 定义；`src/router.ts:410` 拿 effective session mode；engage 解析逻辑在 `src/router.ts` 内联。

### Session Mode

- 英文原名：`session_mode`
- 中文译名：session 模式
- 定义：决定 agent 在一个 messaging group 内开几条 session。两个值：`shared`（一个 messaging group + agent group 配对共用一个 session，不分 thread）或 `per-thread`（同一 messaging group 里每个 thread 一个独立 session）。Slack/Discord thread 多的场景用 per-thread；DM 用 shared。
- 代码位置：`src/db/schema.ts:51`；`src/router.ts:410` 的 `effectiveSessionMode`。

### Isolation Level（隔离级别）

- 英文原名：`Isolation Level`
- 中文译名：隔离级别
- 定义：决定多个 channel 接到同一个 agent 时的 workspace 共享策略。三档：`agent-shared`（多 channel 共一个 agent group，工作目录共享）/ `shared`（每个 channel 各一个 agent group，但 mount 同一份代码库）/ 分开 agent（完全独立的 group/folder）。文档详见 `docs/isolation-model.md`。
- 代码位置：`docs/isolation-model.md`；UI 层在 `/manage-channels` skill。

### Central DB（中央 DB）

- 英文原名：`Central DB` / `v2.db`
- 中文译名：中央数据库
- 定义：`data/v2.db`，host 进程独占的 SQLite 文件，`journal_mode=WAL`。存放一切跨 session 的状态：users、user_roles、agent_groups、messaging_groups、wirings、sessions、pending_approvals、user_dms、container_configs、chat_sdk_*、schema_version。host 进程是唯一 writer。
- 代码位置：`src/db/connection.ts:14` 的 `initDb`；schema 在 `src/db/schema.ts:7`；迁移在 `src/db/migrations/`。

### Inbound DB

- 英文原名：`inbound.db`
- 中文译名：入站数据库
- 定义：per-session SQLite 文件。**只由 host 写、container 只读**。表：`messages_in`（用户消息+调度任务）、`destinations`（agent 可发往的目的地）、`session_routing`（默认回复落地）、`delivered`（host 自己记的投递结果，避免写 outbound）。`journal_mode=DELETE` 而不是 WAL——WAL 的 `-shm` mmap 跨挂载边界不一致。
- 代码位置：`src/db/schema.ts:157` 的 `INBOUND_SCHEMA`；`src/db/session-db.ts:21` 的 `openInboundDb`；`container/agent-runner/src/db/connection.ts:12` 解释为何必须 DELETE。

### Outbound DB

- 英文原名：`outbound.db`
- 中文译名：出站数据库
- 定义：per-session SQLite 文件。**只由 container 写、host 只读**。表：`messages_out`（agent 输出+系统动作请求）、`processing_ack`（处理状态）、`session_state`（SDK session id 等 KV 状态）、`container_state`（当前在跑的工具+开始时间）。也是 `journal_mode=DELETE`。
- 代码位置：`src/db/schema.ts:222` 的 `OUTBOUND_SCHEMA`；`src/db/session-db.ts:29` 的 `openOutboundDb`（默认 readonly）；`container/agent-runner/src/db/connection.ts:78` 容器侧打开。

### Seq Parity（seq 奇偶性）

- 英文原名：`Seq Parity`
- 中文译名：序号奇偶约定
- 定义：跨文件协商的"谁写哪种 seq"约定。**host 写 `messages_in` 用偶数 seq、container 写 `messages_out` 用奇数 seq**。这样把两个 DB 的事件 merge 起来按 seq 排序时，host 和 container 的事件不会冲突，且单靠看 seq 就能知道事件是谁产生的。
- 代码位置：`src/db/session-db.ts:89` 的 `nextEvenSeq`；CLAUDE.md 在 `host writes even seq, container writes odd` 一节有声明。

### Heartbeat File

- 英文原名：`Heartbeat File`
- 中文译名：心跳文件
- 定义：`data/v2-sessions/<group>/<session>/.heartbeat` 一个空文件。container 周期性 `touch` 它，mtime 是 liveness 指示。**heartbeat 走文件系统而不是 DB**——避免和 inbound/outbound 抢锁，也避免被打开 DB 的事务一卡就误判死亡。host-sweep 读 mtime，超过 30 分钟（`ABSOLUTE_CEILING_MS`）就强杀容器。
- 代码位置：`src/session-manager.ts:67` 的 `heartbeatPath`；`src/host-sweep.ts:65` 的 `ABSOLUTE_CEILING_MS`；`src/container-runner.ts:155` 启动前清陈旧 heartbeat。

### processing_ack

- 英文原名：`processing_ack`
- 中文译名：处理确认表
- 定义：`outbound.db` 里的小表。容器对每条 `messages_in` 行写一行进度（`processing` → `completed` / `failed`）。host 读这张表知道 agent 处理到哪了，**而不是去更新 `messages_in.status`**——因为 `messages_in` 是 host-only writer。容器启动时清掉所有遗留的 `processing` 行（崩溃恢复）。
- 代码位置：`src/db/schema.ts:240` 定义表；`container/agent-runner/src/db/messages-in.ts:104` 写 `processing`；`container/agent-runner/src/db/connection.ts:176` 启动清陈旧 claim。

### on_wake

- 英文原名：`on_wake`
- 中文译名：唤醒帧 / 仅首拉
- 定义：`messages_in` 的一列，`0` 或 `1`。值为 `1` 的消息**只被容器的第一次 poll 拿到**——后续 poll 即便看到也跳过。用途：避免"将死容器（已收到 SIGTERM 在 grace 期）偷走唤醒消息"的竞态。host 在容器重启 (`ncl groups restart --message`) 或 self-mod 之后写 `on_wake=1` 消息，保证只有新容器才会处理。
- 代码位置：`src/db/schema.ts:180` 列定义；`container/agent-runner/src/db/messages-in.ts:13` 缓存列存在性；`src/container-restart.ts:18` 解释竞态。

### process_after

- 英文原名：`process_after`
- 中文译名：延迟处理时间
- 定义：`messages_in` 的一列，ISO 时间字符串。如非空，host-sweep 只在 `now >= process_after` 时才把这条消息看作 due。两个用途：(1) 失败重试退避（`+30 seconds` 类的算式）(2) 调度任务（scheduling 模块写未来时间）。
- 代码位置：`src/db/schema.ts:164`；`src/db/session-db.ts:155` 写退避；`src/modules/scheduling/actions.ts:28` 调度写入。

### Recurrence（重复任务）

- 英文原名：`Recurrence`
- 中文译名：重复 / 循环
- 定义：`messages_in.recurrence` 列存 cron 表达式（例如 `0 9 * * *` 每天 9 点）。处理完一次后，scheduling 模块的 `handleRecurrence` 会克隆下一条带新 `process_after` 的行（recurrence 字段 **清空**，避免无限链克隆），由后续 sweep 拉起。
- 代码位置：`src/db/schema.ts:165`；`src/modules/scheduling/db.ts` 的 `insertRecurrence`；`src/modules/scheduling/db.test.ts:60` 解释 chain 设计。

### Migration / schema_version

- 英文原名：`Migration` / `schema_version`
- 中文译名：迁移 / schema 版本表
- 定义：中央 DB 的小表 `(version, name, applied)`。**唯一约束在 `name` 不在 `version`**——这让模块化迁移（install skill 后续追加）可以任挑 version 不冲突。启动时 `runMigrations` 遍历 `migrations` 数组按未应用的 name 跑一遍。
- 代码位置：`src/db/migrations/index.ts:18` `Migration` 接口；`:24` 数组；`:40` 的 `runMigrations`；`:50` 注释解释 name 唯一的设计。

### journal_mode=DELETE

- 英文原名：`journal_mode=DELETE`
- 中文译名：删除式日志模式
- 定义：SQLite 的 rollback journal 模式（默认）。NanoClaw 对所有跨挂载 session DB 强制使用——因为 WAL 的 `-shm` 共享内存映射在 host ↔ guest VirtioFS / 9P 之间不会一致更新，容器读 WAL 帧会读到陈旧 page cache。中央 DB（host 独占、不跨挂载）仍用 WAL。
- 代码位置：`src/db/session-db.ts:15` host 侧；`container/agent-runner/src/db/connection.ts:78` 容器侧；`container/agent-runner/src/db/connection.ts:12` 注释解释为什么。

### User

- 英文原名：`User`
- 中文译名：用户
- 定义：消息平台身份，命名空间格式 `<channel>:<handle>`（如 `phone:+1555...`、`tg:123`、`discord:456`、`email:a@x.com`）。一个真人可对应多个 user 行——目前没有链接机制。
- 代码位置：`src/db/schema.ts:60` 定义表；`ncl users list` 见 `src/cli/resources/`。

### User Role

- 英文原名：`User Role`
- 中文译名：用户角色
- 定义：用户级别的特权。两值：`owner`（总是 global，`agent_group_id IS NULL`）/ `admin`（`agent_group_id` 为 NULL 时是 global admin，否则是 scoped admin——只在该 agent group 内有权）。Owner 隐式拥有 Admin 的全部权限；scoped admin 隐式是该 group 的 member。**没有 `NANOCLAW_ADMIN_USER_IDS` 这种 env 变量**——角色只存在 `user_roles` 表里。
- 代码位置：`src/db/schema.ts:72` 的 `user_roles` 表；`src/modules/permissions/access.ts:21` 的 `canAccessAgentGroup`；CLAUDE.md "Entity Model" 一节。

### Agent Group Member

- 英文原名：`agent_group_members`
- 中文译名：智能体组成员
- 定义：非特权用户与 agent group 的"已知"关系。一个普通用户必须先是 member 才能和该 group 的 agent 对话。Admin@A 隐式是 A 的 member（无需显式行）。
- 代码位置：`src/db/schema.ts:84` 表；`src/modules/permissions/access.ts:21` 的 `canAccessAgentGroup` 中 member 判断；`ncl members add/remove` 见 `src/cli/resources/`。

### User DMs / Cold DM

- 英文原名：`user_dms` / `Cold DM`
- 中文译名：用户 DM 缓存 / 冷启动 DM
- 定义：`(user_id, channel_type) → messaging_group_id` 的懒填充缓存。让 host 能"冷启动"向某用户 DM（发 approval 卡片、pairing 邀请、welcome 消息）而不必每次都去 platform API 探一次。由 `ensureUserDm()` 懒填充。
- 代码位置：`src/db/schema.ts:95` 表定义；`src/user-dm.ts` 实现；CLAUDE.md "Cold-DM cache" 一节。

### Unknown Sender Policy

- 英文原名：`unknown_sender_policy`
- 中文译名：陌生人策略
- 定义：messaging group 上的字段，三档：`strict`（直接丢弃陌生人消息）/ `request_approval`（写 `pending_sender_approvals` 行 + 发卡片给 admin DM 让 ta 选"允许加入"）/ `public`（任何人都可加入聊天，无需审批）。
- 代码位置：`src/db/schema.ts:31` 列定义；`src/db/schema.ts:135` 的 `pending_sender_approvals` 表；migration `011-pending-sender-approvals.ts`。

### canAccessAgentGroup

- 英文原名：`canAccessAgentGroup`
- 中文译名：访问权限检查
- 定义：核心权限函数。给定 `(userId, agentGroupId)` 返回 `AccessDecision`，按优先级 owner → global admin → scoped admin → member 解析 `user_roles` + `agent_group_members`。Router 在路由前调用；CLI dispatch 在 ncl 命令前调用。
- 代码位置：`src/modules/permissions/access.ts:21`。

### Command Gate

- 英文原名：`command-gate`
- 中文译名：命令门
- 定义：Router 侧的 admin 命令门。检查 inbound 消息是否是 admin 命令（如 `/restart`、`/migrate-from-v1`），如果是，直接查 `user_roles` 验证 caller 权限——**不走 container，不走 env 变量**。
- 代码位置：`src/command-gate.ts:23` 的 `gateCommand`。

### cli_scope

- 英文原名：`cli_scope`
- 中文译名：CLI 作用域
- 定义：container config 的字段，三档决定容器里 agent 能用 `ncl` 做什么。`disabled`：完全屏蔽 ncl，CLAUDE.md 不包含 ncl 指南，host dispatch 拒绝任何 `cli_request`。`group`（默认）：只能访问 `groups`/`sessions`/`destinations`/`members`，自动 scope 到自己的 agent group，跨组拒绝。`global`：无限制，只为 owner agent group 自动开（`init-first-agent` 设置）。
- 代码位置：`src/cli/dispatch.ts:44` 读取；`:46-75` 三档分支；`scripts/init-first-agent.ts:236` 为 owner 设 `global`；migration `015-cli-scope.ts`。

### Channel Adapter

- 英文原名：`ChannelAdapter`
- 中文译名：通道适配器
- 定义：把某个平台（Discord / Slack / Telegram / ...）的协议适配到 NanoClaw 的统一接口。一个 ChannelAdapter 必须实现 `subscribe`（订阅入站）、`send`（发出站）、`name` 等成员；可选 `supportsThreads`、`registration`、`setup`。
- 代码位置：`src/channels/adapter.ts:111` 的 `ChannelAdapter` 接口；`src/channels/adapter.ts:170` 的 `ChannelAdapterFactory`。

### Channel Registry

- 英文原名：`Channel Registry`
- 中文译名：通道注册表
- 定义：进程内的 channel 适配器 map。每个通道在自己的模块文件被 import 时调 `registerChannelAdapter(name, registration)` 自注册；host 启动时 `initChannelAdapters(setupFn)` 把每个 adapter 实例化并存入 `activeAdapters`。
- 代码位置：`src/channels/channel-registry.ts:22` 的 map；`:25` 的 `registerChannelAdapter`；`:53` 的 `initChannelAdapters`。

### CLI Channel

- 英文原名：`cli` (channel)
- 中文译名：本地终端通道
- 定义：内建通道。让你在 shell 里 `pnpm run chat "ping"` 直接和 agent 对话，绕过任何外部平台。entry 走 `data/cli.sock` 这个 Unix socket。开发/调试/试 prompt 时第一个会用到的通道。
- 代码位置：`src/channels/cli.ts:1`；`scripts/chat.ts:22` 连接 socket；`scripts/init-cli-agent.ts` 自动接线。

### Chat SDK Bridge

- 英文原名：`Chat SDK Bridge`
- 中文译名：Chat SDK 桥
- 定义：把 `@anthropic/chat-sdk` 风格的 channel SDK 包成一个 `ChannelAdapter`。许多 channel 实现（Discord、Slack 等）共享一套 chat-sdk 抽象，由 bridge 适配进 NanoClaw 自己的接口。中央 DB 的 `chat_sdk_*` 表保存 bridge 需要的会话/线程状态。
- 代码位置：`src/channels/chat-sdk-bridge.ts:48` 的 `ChatSdkBridgeConfig`；`:122` 的 `createChatSdkBridge`；migration `002-chat-sdk-state.ts`。

### ask-question

- 英文原名：`ask-question` / `ask_user_question`
- 中文译名：用户提问 / 交互问答
- 定义：通用的"问用户一个选项题"协议。agent 通过 MCP 工具 `ask_user_question` 调起；host 把 question 落到 `pending_questions` 表 + 通过 channel adapter 发卡片；用户点选项后回写 `messages_in`，container 端的 MCP 调用解除阻塞、返回选择。
- 代码位置：`src/channels/ask-question.ts:40` 的 `AskQuestionPayload`；`container/agent-runner/src/mcp-tools/interactive.ts:39` 的 MCP 工具定义；`src/db/schema.ts:119` 的 `pending_questions` 表。

### Channel Registration Approval

- 英文原名：`channel registration approval` / `pending_channel_approvals`
- 中文译名：通道注册审批
- 定义：当某个 channel adapter 在 inbound 消息时发现"这个 messaging group 还没被注册到 NanoClaw"——而通道配置了 `requestApproval` 模式时，写 `pending_channel_approvals` 行 + 发卡片到 admin DM 让 ta 决定"创建 / 接入 / 拒绝"。批准后 router 会 replay 这条 event。
- 代码位置：`src/router.ts:233` 注释；`src/db/sessions.ts:212` 查询；migration `012-channel-registration.ts`。

### channels branch

- 英文原名：`channels` branch
- 中文译名：channels 分支
- 定义：长期存活的 sibling git 分支。trunk **不**包含任何具体的 channel adapter。Discord/Slack/Telegram/WhatsApp/Teams/Linear/GitHub/iMessage/Webex/Resend/Matrix/Google Chat/WhatsApp Cloud 的源码全都住在这个分支，靠 `/add-<channel>` skill 复制进 trunk。这样核心仓库轻、用户只装他们要用的通道。
- 代码位置：CLAUDE.md "Channels and Providers (skill-installed)" 一节；`.claude/skills/add-*/` 是各通道的 install skill。

### providers branch

- 英文原名：`providers` branch
- 中文译名：providers 分支
- 定义：与 `channels` 平行的 sibling 分支。trunk 只内置 `claude` provider；OpenCode 及未来其他 agent provider 住这里，靠 `/add-opencode` skill 装。
- 代码位置：CLAUDE.md 同一节；`src/providers/` 是 trunk 端的注册基础设施。

### Platform ID

- 英文原名：`platform_id`
- 中文译名：平台 ID
- 定义：channel 内部的群/频道/聊天 ID。同一个 `(channel_type, platform_id)` 唯一标识一个 messaging group。Chat SDK 桥适配的通道会用"前缀化"格式，由 `namespacedPlatformId(channel, raw)` 生成。
- 代码位置：`src/platform-id.ts:19` 的 `namespacedPlatformId`；`:6` 注释解释为啥要区分 raw / namespaced。

### Channel Type

- 英文原名：`channel_type`
- 中文译名：通道类型
- 定义：channel adapter 注册时的 name，如 `"discord"` / `"slack"` / `"cli"` / `"telegram"`。messaging group / user id / session 的 `channel_type` 字段就是它，配合 `platform_id` 唯一定位一个平台对话。
- 代码位置：`src/channels/adapter.ts` 类型；`src/channels/channel-registry.ts:25` 注册时绑 name。

### Thread ID

- 英文原名：`thread_id`
- 中文译名：线程 ID
- 定义：平台内部的 thread / DM 标识。`messages_in` / `messages_out` / `pending_questions` / `sessions` 都有这一列。`session_mode='per-thread'` 时它参与 session 路由 key；`shared` 时它只是消息上的附带元数据。
- 代码位置：`src/db/schema.ts:108`、`:172`、`:233` 多处列定义；`src/router.ts` 路由时按 mode 决定是否参与 key。

### Container Runtime

- 英文原名：`Container Runtime`
- 中文译名：容器运行时
- 定义：底层容器引擎抽象——目前固定 `docker` CLI（Apple Container 通过 `docker` shim 兼容）。模块提供 `hostGatewayArgs()`（host.docker.internal 映射）、`readonlyMountArgs()`、`stopContainer()`、`ensureContainerRuntimeRunning()`、`cleanupOrphans()`（按 `INSTALL_SLUG` label 只收本 install 的孤儿）。
- 代码位置：`src/container-runtime.ts:12` 的 `CONTAINER_RUNTIME_BIN`；`:15-67` 各 helper。

### Container Config

- 英文原名：`container_configs`
- 中文译名：容器配置
- 定义：per-agent-group 的运行时配置：provider、model、effort、image_tag、`assistant_name`、`max_messages_per_prompt`、`cli_scope`、apt 包列表、MCP server 列表、额外 mount 列表。住中央 DB 的 `container_configs` 表，spawn 时 materialize 成 `groups/<folder>/container.json` 让 container-runner 读。
- 代码位置：`src/db/container-configs.ts:1`；`src/container-config.ts:83` 写出 JSON；migration `014-container-configs.ts`；`src/backfill-container-configs.ts` 把 v1 留下的 JSON 文件灌进表。

### Image Build

- 英文原名：`Image Build`
- 中文译名：镜像构建
- 定义：`./container/build.sh` 触发。读 `.env` 的 `INSTALL_CJK_FONTS` 作为 build-arg 透传给 `docker build`。镜像 tag 是 per-install 的（`getDefaultContainerImage(PROJECT_ROOT)` 派生），保证同一台机器上的多个 NanoClaw checkout 互不覆盖 `nanoclaw-agent:latest`。
- 代码位置：`container/build.sh`；`container/Dockerfile:18` 接 build-arg；`setup/container.ts:174-183` 解析 `.env`；`src/install-slug.ts` 派生 tag。

### Container Restart

- 英文原名：`container-restart`
- 中文译名：容器重启
- 定义：`ncl groups restart --id <id> [--rebuild] [--message <txt>]` 的实现。`killContainer` 接 `onExit` 回调；`--message` 模式下回调里写 `on_wake=1` 消息并调 `wakeContainer`，保证旧容器完全退出后才生成新容器，且唤醒消息不会被将死容器偷走。
- 代码位置：`src/container-restart.ts:18` 注释；`:49` 的 onExit 回调；`src/container-runner.ts` 的 `killContainer` + `wakeContainer`。

### Circuit Breaker

- 英文原名：`Circuit Breaker`
- 中文译名：熔断器
- 定义：启动时熔断。NanoClaw 在 launchd / systemd 下会被监管器自动重启；如果 host 连续崩两次以上，写到 `data/circuit-breaker.json` 的状态会让下次启动先 sleep（指数退避），避免日志/CPU 雪崩。
- 代码位置：`src/circuit-breaker.ts:7` 路径；`:46` 的 `enforceStartupBackoff`；`src/index.ts:70` 启动序列里第一件事；`:202` 启动成功后 reset。

### Group Init

- 英文原名：`group-init`
- 中文译名：组目录脚手架
- 定义：第一次为某个 agent group 创建工作目录时跑的脚手架——`groups/<folder>/CLAUDE.md`、`skills/`、`agent-runner-src/` overlay。如果 group 已经存在则幂等。
- 代码位置：`src/group-init.ts:49` 的 `initGroupFilesystem`。

### Mount Security

- 英文原名：`mount-security`
- 中文译名：挂载安全 / 挂载白名单
- 定义：限制 agent 容器额外挂载主机路径的安全层。白名单 JSON 住 `~/.config/nanoclaw/mount-allowlist.json`——**故意放在项目根之外**，避免被 agent 自身挂进容器看到。每条 additional mount 必须匹配白名单的某条 spec 才允许 spawn。
- 代码位置：`src/config.ts:20` 路径常量；`src/modules/mount-security/index.ts:230` 的 `validateMount`；`:314` 的 `validateAdditionalMounts`。

### OneCLI

- 英文原名：`OneCLI`
- 中文译名：OneCLI（凭证网关，不译）
- 定义：本地 HTTPS 代理 + CA 证书 + 凭证保险箱。每个 agent 容器启动时 host 调 `onecli.applyContainerConfig(args, { agent })` 注入 HTTPS_PROXY env + 信任的 CA cert + 主机映射；之后容器内的 HTTP 调用都被代理拦截，按 agent 身份从 vault 拿凭证。**凭证从不进 env、从不进 chat context**。Web UI 在 `http://127.0.0.1:10254`。
- 代码位置：`src/container-runner.ts:10` 引入 `OneCLI`；`:50` 实例化；`:421-433` apply gateway；`@onecli-sh/sdk` 是 npm 包。

### OneCLI Agent

- 英文原名：`OneCLI Agent`
- 中文译名：OneCLI 内的 agent
- 定义：OneCLI vault 里登记的一个"agent 身份"。NanoClaw 用 agent group id 当 identifier，host 在 spawn 前调 `onecli.ensureAgent({ name, identifier })` 确保有这个 agent。该 agent 默认 `selective` secret mode——这就是"新 group 起来 agent 报 401"的常见原因（见 FAQ）。
- 代码位置：`src/container-runner.ts:427` 调用 `ensureAgent`；CLAUDE.md "Gotcha" 一节。

### Secret Mode

- 英文原名：`secret mode` (`selective` / `all`)
- 中文译名：凭证模式
- 定义：OneCLI agent 的两种凭证策略。`selective`（默认）：必须显式 `set-secrets --id <agent> --secret-ids ...` 才能拿到凭证。`all`：vault 里任何 host pattern 命中的凭证都自动注入。`onecli agents set-secret-mode --id <id> --mode all` 切换。
- 代码位置：CLAUDE.md 详尽说明；SDK 不暴露 `setSecretMode`，只能 CLI 或 web UI。

### Approval（审批的四种）

- 英文原名：`Approval`
- 中文译名：审批
- 定义：NanoClaw 有四类审批，注意不要混淆。**OneCLI Approval**：凭证调用要人工放行（`onecli-approvals.ts`，action=`onecli_credential`）。**MCP Approval**：agent 用 `install_packages` / `add_mcp_server` 等自修工具时（`src/modules/self-mod/apply.ts`）。**Channel Registration Approval**：未注册 messaging group 第一次发消息时（`pending_channel_approvals`）。**Unknown Sender Approval**：陌生用户在已知 messaging group 发消息时（`pending_sender_approvals`）。
- 代码位置：`src/modules/approvals/primitive.ts` 是统一基础；`src/modules/approvals/onecli-approvals.ts`、`src/modules/self-mod/apply.ts`、`src/db/schema.ts:135` 各种来源。

### pickApprover / pickApprovalDelivery

- 英文原名：`pickApprover` / `pickApprovalDelivery`
- 中文译名：审批人选择 / 审批投递选择
- 定义：审批基础设施的两步选人逻辑。`pickApprover(agentGroupId)` 按 scoped admin → global admin → owner 顺序返回候选 user id 列表。`pickApprovalDelivery(approvers, originChannelType)` 决定通过哪个 user + 哪个通道发卡片（优先和 incoming 同通道；否则 fallback 到 cold DM）。
- 代码位置：`src/modules/approvals/primitive.ts:76` 的 `pickApprover`；`:103` 的 `pickApprovalDelivery`；`:164` 的 `requestApproval` 统一入口。

### Router / routeInbound

- 英文原名：`router` / `routeInbound`
- 中文译名：路由 / 入站路由
- 定义：把 channel adapter 上来的 inbound event 翻译成 session 写入 `inbound.db` + wake 容器。流程：消息拦截器 → 解析 sender → 查 messaging group（必要时自动创建并发 channel-registration 审批）→ 查 wirings → 按 engage_mode 判定每个 wiring 是否触发 → 找/建 session → 写 `messages_in` → `wakeContainer`。
- 代码位置：`src/router.ts:158` 的 `routeInbound`；`:54-139` 各种 hook 注入点。

### Delivery Loop

- 英文原名：`Delivery Loop` / `startActiveDeliveryPoll` / `startSweepDeliveryPoll`
- 中文译名：投递循环
- 定义：host 的两条投递 polling 循环。Active poll：~1s 轮询所有 running 容器的 `outbound.db`，新消息即出。Sweep poll：60s 轮询全部 session（含停掉的），处理 agent 在容器关闭前最后一刻写出的、active poll 没赶上的消息。`messages_out` 拿出来后按 `kind` 分派：`channel` 走 adapter `send`、`system` 走 `delivery-action` 注册的处理器（schedule、approval、self-mod 等）。
- 代码位置：`src/delivery.ts:108` `startActiveDeliveryPoll`；`:115` `startSweepDeliveryPoll`；`:398` 的 `registerDeliveryAction`。

### Host Sweep

- 英文原名：`host-sweep`
- 中文译名：宿主清扫
- 定义：60s 周期的"全 session 维护"循环。职责：(1) 比对 `processing_ack`，发现完成 / 失败把对应 `messages_in.status` 同步；(2) heartbeat / claim 老化检测，决定 OK / 杀容器（`decideStuckAction`）；(3) 找 `process_after <= now` 的 due 消息 wake 对应 session；(4) recurrence 展开。
- 代码位置：`src/host-sweep.ts:82` 的 `decideStuckAction`；`:122` 的 `startHostSweep`；`:65` 的 `ABSOLUTE_CEILING_MS` (30 分钟)。

### Poll Loop（容器侧）

- 英文原名：`poll-loop`
- 中文译名：容器轮询循环
- 定义：容器内每秒拉 `inbound.db` 的循环。逻辑：(1) `getPendingMessages` 读未处理 + `process_after` 已到的 `messages_in`；(2) 把消息 batch 喂给 `formatter` 拼成一个 prompt；(3) provider 跑 Claude SDK；(4) 流式输出 + 工具调用一边产生一边写 `messages_out` + `processing_ack`；(5) PreToolUse / PostToolUse 钩子更新 `container_state`。
- 代码位置：`container/agent-runner/src/poll-loop.ts:1`；`container/agent-runner/src/db/messages-in.ts:56` 的 `getPendingMessages`。

### Push (streaming partial)

- 英文原名：`push partial` / mid-query message injection
- 中文译名：流式追加
- 定义：当 agent 正在跑一个 query（流式输出还没结束）、用户又发来新消息——把新消息插入到正在跑的 query 而不是排队等下次 poll。这样体感上像一个永远在线的对话。被关闭的 stream 不会被 push（"pushing into a closed stream is wasted work"）。
- 代码位置：`container/agent-runner/src/poll-loop.ts:341` 的 `Pushing N follow-up message(s) into active query`。

### wakeContainer

- 英文原名：`wakeContainer`
- 中文译名：容器唤醒
- 定义：host 端的"确保容器在跑"的幂等入口。已经 running 直接返回；否则启动 spawn 流程。被 router、host-sweep（due message）、container-restart 三处调用。promise 复用避免并发重复 spawn。
- 代码位置：`src/container-runner.ts:85` 的 `wakeContainer`；`:108` 的 `spawnContainer`。

### Provider（claude / opencode / mock）

- 英文原名：`AgentProvider` / `claude` / `opencode` / `mock`
- 中文译名：智能体提供商
- 定义：把"agent 怎么思考 / 怎么调工具"抽成接口。trunk 内建 `claude`（Claude Agent SDK）+ `mock`（确定性 stub，单测用）；`opencode` 来自 `providers` 分支用 `/add-opencode` 装。Provider 注册自己的 factory，container config 的 `provider` 字段决定 spawn 时用谁。
- 代码位置：`container/agent-runner/src/providers/types.ts:1` 的 `AgentProvider`；`provider-registry.ts:15` 的 `registerProvider`；`claude.ts:253` `ClaudeProvider`；`mock.ts:8` `MockProvider`。

### Formatter

- 英文原名：`formatter`
- 中文译名：格式化器
- 定义：容器侧把 `messages_in` batch 拼成给 SDK 的 prompt。识别 `kind`（user/system/scheduled）、剥掉内部标签（`<noreply>` 等）、抽取路由上下文。`isClearCommand` / `isRunnerCommand` 等 helper 拣出特殊命令旁路。
- 代码位置：`container/agent-runner/src/formatter.ts:35` `categorizeMessage`；`:129` `formatMessages`；`:277` `stripInternalTags`。

### Destinations

- 英文原名：`destinations`
- 中文译名：目的地表
- 定义：当前 session 允许发往的对象表。两类：`channel`（具体平台对话）和 `agent`（agent-to-agent）。host 在容器每次唤醒时根据 wirings + agent_destinations 重写。容器调 `send_message` 时按 `name` / `routing` 查这张表。改 wiring **不用** 重启容器，下次查表立即生效。
- 代码位置：`src/db/schema.ts:199` 表定义；`src/db/session-db.ts:66` 的 `replaceDestinations`；`container/agent-runner/src/destinations.ts:44` 的 `getAllDestinations`。

### MCP Tools

- 英文原名：`MCP Tools` (`@modelcontextprotocol/sdk`)
- 中文译名：MCP 工具集
- 定义：agent-runner 暴露给 Claude SDK 的工具集，按文件分四组：`core`（`send_message` / `send_file` / `edit_message` / `add_reaction`）、`interactive`（`ask_user_question` / `send_card`）、`scheduling`（`schedule_task` 等）、`self-mod`（`install_packages` / `add_mcp_server`）、`agents`（agent-to-agent）。Server 通过 `@modelcontextprotocol/sdk` 协议暴露。
- 代码位置：`container/agent-runner/src/mcp-tools/index.ts`；`core.ts:95` 的 `sendMessage`；`interactive.ts:39` 的 `ask_user_question`；`self-mod.ts`、`scheduling.ts`、`agents.ts`。

### session_state

- 英文原名：`session_state`
- 中文译名：会话状态表
- 定义：`outbound.db` 的 KV 表，container-only writer。最重要的一行是 SDK 的 session id——存这个让 Claude SDK 在容器重启后能续上同一个 conversation（agent 不会忘记之前聊了什么）。被 `/clear` 清空。
- 代码位置：`src/db/schema.ts:249` 表定义；`container/agent-runner/src/db/session-state.ts` CRUD；`container/agent-runner/src/db/connection.ts:103` 还定义了 `container_state` 表（工具进行中）。

### ncl

- 英文原名：`ncl` (NanoClaw CLI)
- 中文译名：nanoclaw 命令行
- 定义：操作中央 DB 的 CLI——agent groups、messaging groups、wirings、users、roles、members、destinations、sessions、user-dms、dropped-messages、approvals。**两种 transport，同一个命令面**：host 上跑时连 `data/ncl.sock`（Unix socket）；容器内跑时检测到 `/workspace/inbound.db` 存在，自动改走 DB transport（写 `cli_request` 系统消息到 `outbound.db`，从 `inbound.db` 拉响应）。
- 代码位置：`src/cli/socket-server.ts:6` host 服务器；`src/cli/socket-client.ts:15` 路径；`container/agent-runner/src/cli/ncl.ts:1` 容器侧；`src/cli/dispatch.ts` 共用 dispatcher。

### Self-Modification

- 英文原名：`self-mod` (`install_packages` / `add_mcp_server`)
- 中文译名：自修
- 定义：agent 通过 MCP 工具请求"改自己"的能力。两个工具走"DB 改 → admin 审批 → host 应用 → kill container → on_wake 重启"的同一流程。`install_packages` 会触发镜像 rebuild。**源代码级别的自改**（draft/activate）规划中但未实现。
- 代码位置：`container/agent-runner/src/mcp-tools/self-mod.ts` agent 侧工具；`src/modules/self-mod/request.ts` host 接请求；`src/modules/self-mod/apply.ts` 审批后应用。

### @anthropic-ai/claude-agent-sdk

- 英文原名：`@anthropic-ai/claude-agent-sdk`
- 中文译名：Claude Agent SDK
- 定义：Anthropic 官方 agent SDK。容器内默认 ClaudeProvider 调用它跑模型 + 工具循环。NanoClaw 只用它的 SDK 接口，并不依赖它的 channel adapter。
- 代码位置：`container/agent-runner/package.json:12` 锁版本 `^0.2.128`；`container/agent-runner/src/providers/claude.ts:253` 的 ClaudeProvider。

### @modelcontextprotocol/sdk

- 英文原名：`@modelcontextprotocol/sdk`
- 中文译名：MCP SDK
- 定义：Anthropic 的 Model Context Protocol SDK。NanoClaw 用它把自家 MCP 工具（`send_message` 等）暴露给 Claude SDK。Schema、回调、Server transport 都来自这个包。
- 代码位置：`container/agent-runner/package.json:13` 锁 `^1.12.1`；`container/agent-runner/src/mcp-tools/server.ts`。

### bun:sqlite

- 英文原名：`bun:sqlite`
- 中文译名：Bun 内置 SQLite
- 定义：Bun runtime 内置的 SQLite binding。容器内 agent-runner 用它而不是 `better-sqlite3`——避免容器镜像里再装 node + native build chain。
- 代码位置：`container/agent-runner/src/cli/ncl.ts:12` 的 `import { Database } from 'bun:sqlite'`；`container/agent-runner/src/db/connection.ts` 大部分使用。

### better-sqlite3

- 英文原名：`better-sqlite3`
- 中文译名：better-sqlite3 (host 侧 SQLite)
- 定义：host 进程用的 Node SQLite binding，同步 API + 极快。版本被 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 列表显式允许 build script 执行——build script 默认是禁止的（供应链安全）。
- 代码位置：`package.json:34` 锁 `11.10.0`；`src/db/connection.ts:1` 引入；`pnpm-workspace.yaml:2`。

### minimumReleaseAge

- 英文原名：`minimumReleaseAge`
- 中文译名：最小发布年龄
- 定义：pnpm 的供应链安全机制。NanoClaw 在 `pnpm-workspace.yaml` 设 `4320`（分钟 = 3 天）——任何新版本必须在 npm 注册表上活满 3 天 pnpm 才会 resolve。防御新发布的恶意版本（typosquat、被劫持的维护者账号）。**禁止未经 human 审批往 `minimumReleaseAgeExclude` 加条目**。
- 代码位置：`pnpm-workspace.yaml:8` 设值；CLAUDE.md "Supply Chain Security (pnpm)" 一节。

### INSTALL_SLUG

- 英文原名：`INSTALL_SLUG`
- 中文译名：安装唯一标识
- 定义：从 `PROJECT_ROOT` 派生的本机短哈希，盖到每个 spawn 容器的 `--label nanoclaw-install=<slug>`。`cleanupOrphans` 只杀本 slug 的孤儿——保证同一台机上多个 NanoClaw checkout 互不干扰。
- 代码位置：`src/config.ts:32` 的 `INSTALL_SLUG`；`:33` `CONTAINER_INSTALL_LABEL`；`src/install-slug.ts`；`src/container-runtime.ts:67` 的 `cleanupOrphans`。

---

## Part 2：FAQ

### 为什么 host 与 container 不直接用 stdin / IPC 通信，非要走 SQLite？

简短答案：跨容器边界没有任何 IPC 同时满足 NanoClaw 的四个硬性要求——**对断电安全**、**双向**、**支持 agent 主动发起系统动作**、**heart-beat 不抢锁**。SQLite 文件 + "每个文件正好一个 writer"是唯一同时打勾的方案。详细推导见第 1 章。stdin/pipe 会因为容器死亡丢消息、PTY buffer 受限、没法"agent 主动请求 host 帮忙"；socket 需要心跳 + 重连 + 一个本来零收益的 24h 活体连接；inotify 跨 VirtioFS 不可靠。代码层验证见 `src/db/session-db.ts:1` 的 file header 与 `container/agent-runner/src/db/connection.ts:12` 的注释。

### 三个 DB 分别由谁写谁读？为什么 journal_mode 是 DELETE 而不是 WAL？

`data/v2.db`（中央 DB）：host 进程独占，**WAL 模式**——不跨挂载，可以放心用 WAL（`src/db/connection.ts:17`）。`inbound.db`：host 写、container 只读，**DELETE 模式**（`src/db/session-db.ts:15`）。`outbound.db`：container 写、host 只读，**DELETE 模式**（`container/agent-runner/src/db/connection.ts:78`）。WAL 的 `-shm` 是 mmap 共享内存映射，Docker bind mount / Apple Container VirtioFS / 9P 都不保证 host ↔ guest 之间 mmap page 一致——容器读到的 WAL 帧可能是 host 旧版本的 page cache。DELETE 模式靠 rollback journal 文件，跨挂载语义可预测。详细见 `container/agent-runner/src/db/connection.ts:12-15` 的 header 注释。

### seq 奇偶约定是干嘛的？

`messages_in` 的 seq 列由 host 写偶数（`src/db/session-db.ts:89` `nextEvenSeq`），`messages_out` 的 seq 列由 container 写奇数。这样把两个 DB 的事件按 seq merge 起来排时间序，host 事件和 container 事件**永远不会撞 seq**——不需要额外的 source 字段就能区分。任何工具（如 `pnpm exec tsx scripts/q.ts`）想看一个 session 的完整时间线，UNION 后按 seq ORDER BY 即可。

### 我装好了一个新 channel skill 但没生效，怎么排查？

按这个顺序：(1) `git status` 看 trunk 是否真把代码复制进来了——install skill 失败时 trunk 可能没改。(2) 看 `src/channels/index.ts` 是否多了那条 self-registration import——adapter 靠 import side-effect 注册自己（`src/channels/channel-registry.ts:25`）。(3) `pnpm install` 检查 channel 的 SDK 依赖是否真装上了。(4) `pnpm run build` 看有没有 TS 错。(5) 重启 host 后 `logs/nanoclaw.log` grep `init channel adapters`——`initChannelAdapters` 会日志每个被实例化的 adapter 名（`src/channels/channel-registry.ts:53`）。(6) 在 `.env` 检查这个 channel 需要的凭证 / Bot token 字段——很多 adapter 在没拿到凭证时 `factory()` 返回 `null`，被认作"未配置"静默跳过。

### 新建一个 agent group 后 agent 跑起来报 401 是为什么？

**Gotcha**：OneCLI 的 `POST /api/agents` 默认把新 agent 创建为 `selective` secret mode（CLAUDE.md "Gotcha: auto-created agents start in selective secret mode"）——即便 vault 里有匹配 host pattern 的凭证，也**不会**自动注入到这个 agent。修复：`onecli agents set-secret-mode --id <agent-id> --mode all`（或 `set-secrets --secret-ids <id1>,<id2>` 显式分配）。改完不用重启容器——gateway 是 per-request 查 vault，下次 API 调用立即生效。`src/container-runner.ts:427` 是 `ensureAgent` 调用点。

### `cli_scope` 三档分别有什么区别？什么时候需要 global？

`disabled`：agent 完全不知道 ncl 存在——`CLAUDE.md` 里 `ncl` 指南被剥掉、host dispatch 直接拒绝任何 `cli_request`（`src/cli/dispatch.ts:46`）。安全敏感的 group（如对接外部用户）可以选这档。`group`（默认）：agent 能用 ncl 看/改自己的 `groups`、`sessions`、`destinations`、`members`，但**只能 scope 到自己**——`--id` 和 group 参数自动填、跨组拒绝（`src/cli/dispatch.ts:50-75`），也禁止改 `cli_scope` 自身（防止提权）。`global`：无限制。**只为 owner agent group 自动设**——`scripts/init-first-agent.ts:236` 在 bootstrap 时调用。手动设需要 ncl 在 host shell 上跑。

### v1 → v2 我应该怎么迁？为什么不能 git merge？

CLAUDE.md 的第一行就是大红字：v2 是 ground-up rewrite，schema 全改、目录结构全改，**不能 merge**。强行 merge 会 corrupt 用户的 install。流程：先 `git merge --abort`，然后**退出 Claude Code**（在另一个 terminal），跑 `bash migrate-v2.sh`（项目根，`migrate-v2.sh:1`）。脚本会 seed DB、复制 groups/sessions、装 channels、build 容器、问要不要切 service，然后让你回到 Claude Code 跑 `/migrate-from-v1` skill 完成 owner 设置和 `CLAUDE.md` 清理。详细 dev 流程见 `docs/migration-dev.md`。

### 我能不能让 agent 自己修改源代码？

当前**不能**修改源码本身。能做的：通过 MCP 工具 `install_packages`（加 apt / npm 依赖）或 `add_mcp_server`（接 MCP server）——两个都走 admin 审批 → host 改 DB → kill container → 写 `on_wake=1` 消息 → 新容器拉起（`src/modules/self-mod/apply.ts`，`container/agent-runner/src/mcp-tools/self-mod.ts`）。源代码级别的 self-edit（draft / activate flow）在 roadmap 上但 v2.0.64 未实现——见 CLAUDE.md "Self-Modification" 一节 "A second tier ... is planned but not yet implemented"。

### Recurrence（每天 9 点提醒）是怎么实现的？

agent 调 `schedule_task` MCP 工具，host 端 `src/modules/scheduling/actions.ts:28` 接 action 写一行 `messages_in`：`process_after = '2026-05-25T09:00:00Z'`、`recurrence = '0 9 * * *'`。`host-sweep`（60s 一次）每轮挑 `process_after <= now AND status = 'pending'` 的行 wake 对应 session（`src/host-sweep.ts:122`）。Agent 处理完后 scheduling 模块的 `handleRecurrence` 克隆一条新行，`process_after` 设为 cron 计算的下一个时刻——**新行的 `recurrence` 清空**，避免一行膨胀成无限链（`src/modules/scheduling/db.test.ts:60-98`）。撤销订阅 = 删原行。

### host 进程崩了，container 还在跑，会怎么样？

短期：container 继续轮 `inbound.db`，但 host 不再写新消息进来（也不再 deliver `outbound.db` 的输出），用户体感"agent 收不到也不回了"。launchd/systemd 检测到 host 退出会自动重启它（`launchd/com.nanoclaw.plist`、`launchd/com.nanoclaw.error.log`）。`src/circuit-breaker.ts:46` 的 `enforceStartupBackoff` 会按崩溃次数做指数退避避免日志雪崩。重启后 host 重新打 outbound 投递、host-sweep 也会发现 heartbeat 早被 touch 过即活的容器，按部就班把积压的消息发出去。如果 host 崩在投递过程中、卡在中间的 `messages_out` 行不会丢——`delivered` 表是按 message id 幂等的，重启后接着投。

### 我想加一个新的 channel adapter，要碰哪些文件？

只在 `channels` branch 上加。一个 channel adapter 至少要：(1) `src/channels/<name>.ts` 实现 `ChannelAdapter` 接口（`src/channels/adapter.ts:111`）+ 顶层调一次 `registerChannelAdapter('<name>', { factory, ... })`。(2) `src/channels/index.ts` 加一行 `import './<name>.js'`（不需要导出任何东西——纯 side-effect import）。(3) 在 `package.json` 加 SDK 依赖。(4) 在 `.claude/skills/add-<name>/SKILL.md` 写好"copy 哪些文件、加哪行 import、装哪个包" 的复制清单——必须幂等（`git fetch origin channels` → 复制 → append import → `pnpm install <pkg>@<pinned>` → build）。trunk 不接受具体 adapter；trunk 改动只在 `src/channels/adapter.ts` / `channel-registry.ts` / `chat-sdk-bridge.ts` 这些基础设施层。

### OneCLI 是必须的吗？没装会怎样？

**必须**。`src/container-runner.ts:430` `if (!onecliApplied) { throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials'); }`——没拿到 gateway 直接拒绝 spawn。原因：NanoClaw 的安全模型把所有凭证管理收口到 OneCLI，没有它就回到 v1 那种"把 API key 塞 env 然后祈祷 agent 不打印"的不安全模式。`/init-onecli` skill 装 OneCLI Agent Vault + 把现有 `.env` 凭证迁过来。可选：用 `use-native-credential-proxy` skill 走另一种"native credential proxy"（参考 `.claude/skills/use-native-credential-proxy/SKILL.md`），但仍然走代理模式而不是裸 env。

### Apple Container 和 Docker 在 NanoClaw 里有什么区别？

代码层面差异很小——`src/container-runtime.ts:12` 的 `CONTAINER_RUNTIME_BIN` 硬写 `'docker'`，Apple Container 在 macOS 上是通过提供 `docker` CLI shim 兼容的（命令面一致）。差异在底层：Apple Container 在 Apple Silicon 上靠 macOS 的 Virtualization.framework 启 LinuxKit VM，比 Docker Desktop 内存占用低、启动快。但 mount 性能 Docker Desktop 用 VirtioFS、Apple Container 也是 VirtioFS——所以"两种 runtime 都跨 VirtioFS"是 SQLite 必须 `journal_mode=DELETE` 的根因（`container/agent-runner/src/db/connection.ts:12`）。CJK 字体、`--label`、`--rm`、`--read-only` mount 语义在两者上都相同。

### processing_ack 是干嘛的？为什么不直接用 messages_in.status？

`messages_in` 在 `inbound.db`，**host 是 only writer**——这是双 DB 隔离的核心约束。container 想报告进度，不能去碰 `inbound.db`。所以 container 改在自己 owns 的 `outbound.db` 写一个旁路表 `processing_ack(message_id, status, status_changed)`（`src/db/schema.ts:240`）。host-sweep 60s 一次 join 两表（`src/host-sweep.ts`）把 `processing_ack` 里 `completed/failed` 的行同步到 `messages_in.status`。好处：(a) 不破坏单 writer 不变量；(b) 容器崩溃后启动时 `DELETE FROM processing_ack WHERE status = 'processing'` 一行就能复位（`container/agent-runner/src/db/connection.ts:176`）。

### 容器死亡了我的对话历史会丢吗？

**不会**——只要你的 SDK session 状态在 `outbound.db.session_state` 里被持久化（默认 yes，`src/db/schema.ts:249`）。container 用 Claude Agent SDK 时把每个 query 返回的 session id 写进 `session_state` KV 表。下次容器启动，ClaudeProvider 把这个 id 读出来作为 `resume_session` 传回 SDK，Claude 会接着上次的 conversation 继续——agent 不会忘记你们之前聊了啥。`/clear` 命令显式清掉 `session_state` 那一行，是唯一让"忘记"发生的方式。**注意**：container 的本地文件 / `/tmp` 内容会丢（`--rm` 容器、`docker logs` 也丢——CLAUDE.md "Troubleshooting" 一节明示）。

---

## Part 3：速查附录

### 环境变量

`.env` 与 `process.env` 的合并由 `src/env.ts:11` 的 `readEnvFile()` + `src/config.ts:9-40` 决定。下表覆盖最常用的：

| 变量 | 默认值 | 作用 | 代码位置 |
|------|--------|------|----------|
| `ASSISTANT_NAME` | `Andy` | agent 的"自称"，决定默认 trigger（`@Andy`） | `src/config.ts:11` |
| `ASSISTANT_HAS_OWN_NUMBER` | `false` | iMessage / WhatsApp 类通道：agent 是否有独立号码 | `src/config.ts:12` |
| `ONECLI_URL` | （必填） | OneCLI gateway 地址，通常 `http://127.0.0.1:10254` | `src/config.ts:36` |
| `ONECLI_API_KEY` | （必填） | OneCLI gateway 的 admin token | `src/config.ts:37` |
| `TZ` | 系统时区 | 调度、消息时间戳的时区；IANA 标识符（如 `Asia/Shanghai`） | `src/config.ts:61` |
| `INSTALL_CJK_FONTS` | `false` | 镜像 build 时是否装 fonts-noto-cjk（+200MB） | `container/Dockerfile:18`、`setup/container.ts:181` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` | `src/log.ts:16` |
| `CONTAINER_IMAGE` | per-checkout 派生 | 容器镜像名 / tag | `src/config.ts:29` |
| `CONTAINER_IMAGE_BASE` | per-checkout 派生 | 镜像名前缀 | `src/config.ts:28` |
| `CONTAINER_TIMEOUT` | `1800000` (30m) | 单个 prompt 容器 wait 上限 (ms) | `src/config.ts:34` |
| `CONTAINER_MAX_OUTPUT_SIZE` | `10485760` (10MB) | container 单次输出 byte 上限 | `src/config.ts:35` |
| `IDLE_TIMEOUT` | `1800000` (30m) | agent 最后一次输出之后 container 还保活多久 (ms) | `src/config.ts:39` |
| `MAX_CONCURRENT_CONTAINERS` | `5` | 同时跑的 container 上限 | `src/config.ts:40` |
| `MAX_MESSAGES_PER_PROMPT` | `10` | 一次 batch 最多塞多少 `messages_in` 行 | `src/config.ts:38` |
| `WEBHOOK_PORT` | `3000` | webhook server 端口（GitHub / 邮件等 inbound） | `src/webhook-server.ts:82` |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` | — | Claude API 凭证（OneCLI 接管前的迁移 hint） | `setup/verify.ts:142` |
| `HOME` | — | 用作 `~/.config/nanoclaw/mount-allowlist.json` 等的 base | `src/config.ts:17` |

`DATA_DIR` / `GROUPS_DIR` / `STORE_DIR` / `MOUNT_ALLOWLIST_PATH` 等**不**是 env 变量——是从 `process.cwd()` + `os.homedir()` 派生的常量，见 `src/config.ts:20-24`。

### 常用命令速查

```bash
# Host 开发
pnpm run dev                              # host with hot reload
pnpm run build                            # 编译 TS (src/)
pnpm test                                 # vitest，host 侧测试
./container/build.sh                      # rebuild agent container image
pnpm run lint                             # eslint
pnpm exec tsc --noEmit                    # host typecheck

# Container（在 container/agent-runner/ 下）
cd container/agent-runner && bun install  # 改了 agent-runner 依赖后
cd container/agent-runner && bun test     # bun:test，容器侧测试
cd container/agent-runner && bun run typecheck

# 容器 typecheck 也可从根目录跑
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit

# 运维（CLI channel + ncl）
pnpm run chat "ping"                      # 走 CLI channel 试 agent
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, name FROM agent_groups"
pnpm exec tsx scripts/q.ts data/v2-sessions/<g>/<s>/inbound.db "SELECT id, status FROM messages_in"

ncl groups list                           # 列 agent groups
ncl groups get <id>                       # 详细信息
ncl groups restart --id <id>              # kill + 等新消息触发
ncl groups restart --id <id> --rebuild --message "rebuilt"
ncl groups config get --id <id>           # 看 container config
ncl groups config update --id <id> --cli-scope global
ncl groups config add-package --id <id> --pkg jq
ncl groups config add-mcp-server --id <id> --name github --url ...

ncl messaging-groups list
ncl wirings list
ncl wirings create --messaging-group <mg> --agent-group <ag> --session-mode per-thread

ncl users list
ncl roles list
ncl roles grant --user <uid> --role admin [--agent-group <ag>]
ncl members add --user <uid> --agent-group <ag>

ncl destinations list --agent-group <ag>
ncl sessions list
ncl approvals list                        # 待审批
ncl approvals get <id>
ncl user-dms list
ncl dropped-messages list                 # 被 unknown_sender_policy 丢的

# macOS 服务管理
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # 重启

# Linux 服务管理
systemctl --user start nanoclaw
systemctl --user restart nanoclaw
systemctl --user status nanoclaw

# OneCLI 操作
onecli agents list
onecli agents set-secret-mode --id <agent-id> --mode all
onecli agents set-secrets --id <agent-id> --secret-ids <id1>,<id2>
onecli agents secrets --id <agent-id>
onecli secrets list
onecli --help

# Git / 升级
git fetch upstream
git log upstream/main..HEAD --oneline
git diff upstream/main --stat HEAD
bash migrate-v2.sh                         # v1 → v2 迁移
```

### 关键文件路径速查

| 路径 | 用途 |
|------|------|
| `data/v2.db` | 中央 DB（users / agent_groups / wirings / …） |
| `data/v2-sessions/<agent_group_id>/<session_id>/inbound.db` | per-session 入站 DB（host 写） |
| `data/v2-sessions/<agent_group_id>/<session_id>/outbound.db` | per-session 出站 DB（container 写） |
| `data/v2-sessions/<agent_group_id>/<session_id>/.heartbeat` | container liveness 心跳文件 |
| `data/v2-sessions/<agent_group_id>/.claude-shared/` | agent group 内多 session 共享的 `.claude/` 目录 |
| `data/cli.sock` | CLI channel 的 Unix socket（`scripts/chat.ts` 连这里） |
| `data/ncl.sock` | `ncl` 命令的 Unix socket（host 监听） |
| `data/circuit-breaker.json` | 启动熔断状态 |
| `data/Dockerfile.<agentGroupId>` | spawn 时临时写的 Dockerfile（按 group 定制） |
| `logs/nanoclaw.log` | host 标准日志（全量 routing chain） |
| `logs/nanoclaw.error.log` | host 错误日志（delivery 失败 / 崩溃回溯 / warning） |
| `logs/setup.log` | setup 顶层日志 |
| `logs/setup-steps/*.log` | setup 分步日志（bootstrap / environment / container / onecli / mounts / service） |
| `groups/<folder>/CLAUDE.md` | 该 agent group 的系统提示组成 |
| `groups/<folder>/skills/` | agent-side skills 目录 |
| `groups/<folder>/agent-runner-src/` | per-group 覆盖 `container/agent-runner/src` 的 overlay（罕用） |
| `groups/<folder>/container.json` | 从中央 DB materialize 出来给 container-runner 看 |
| `groups/global/` | 全部 agent group 共享的 group |
| `container/Dockerfile` | agent 容器镜像定义 |
| `container/build.sh` | 镜像 build 入口（读 `.env` 的 build-arg） |
| `container/agent-runner/` | 容器内 TS 代码（独立 lockfile） |
| `container/skills/` | 内嵌到每个容器的 skills（`onecli-gateway` / `welcome` / `self-customize` / `agent-browser` / `slack-formatting`） |
| `.env` | host + build 共享的本地配置（不入 git） |
| `~/.config/nanoclaw/mount-allowlist.json` | 容器额外 mount 的白名单（**故意放仓库外**） |
| `~/.config/nanoclaw/sender-allowlist.json` | 平台账号白名单 |
| `pnpm-workspace.yaml` | pnpm 工作区 + `minimumReleaseAge: 4320` 供应链门 |
| `vitest.config.ts` | host vitest 配置 |
| `vitest.skills.config.ts` | skill 测试单独的 vitest 配置 |
| `eslint.config.js` | flat ESLint 配置 |
| `tsconfig.json` | host TS 配置 |
| `container/agent-runner/tsconfig.json` | container TS 配置（独立） |
| `launchd/com.nanoclaw.plist` | macOS launchd 服务定义 |
| `bin/ncl` | host 侧 ncl CLI 入口（连 `data/ncl.sock`） |
| `setup/` | `/setup` skill 调用的 TS 实现 |
| `scripts/q.ts` | 即席 SQL（`pnpm exec tsx scripts/q.ts <db> "<sql>"`） |
| `scripts/init-first-agent.ts` | bootstrap 第一个 DM-wired agent |
| `scripts/sanity-live-poll.ts` | live poll e2e 健康检查 |
| `scripts/test-v2-*.ts` | v2 各层 e2e 脚本 |
| `migrate-v2.sh` | v1 → v2 standalone 迁移脚本 |
| `migrate-v2-reset.sh` | v2 重置（开发用） |

### 测试目录速查

| 目录 / 文件 | 内容 | 怎么跑 |
|-------------|------|--------|
| `src/**/*.test.ts` | host 单元 + 集成测试（vitest） | `pnpm test` |
| `vitest.config.ts` | vitest 主配置 | — |
| `vitest.skills.config.ts` | skill 测试单独配置 | `pnpm test:skills` |
| `src/host-core.test.ts` | host 启动序列、shutdown 顺序 | vitest |
| `src/host-sweep.test.ts` | sweep 60s 循环、`decideStuckAction` 表格 | vitest |
| `src/delivery.test.ts` | delivery loop + system action 分派 | vitest |
| `src/circuit-breaker.test.ts` | 启动熔断 + 退避 | vitest |
| `src/container-runtime.test.ts` | runtime probe / orphan cleanup | vitest |
| `src/container-restart.test.ts` | kill + on_wake 重启 race | vitest |
| `src/container-runner.test.ts` | spawn / wakeContainer 路径 | vitest |
| `src/db/db-v2.test.ts` | 中央 DB schema、迁移 idempotency | vitest |
| `src/db/session-db.test.ts` | 两 DB 文件、seq parity、insert 路径 | vitest |
| `src/channels/channel-registry.test.ts` | 注册 / init / readyCallback | vitest |
| `src/channels/chat-sdk-bridge.test.ts` | Chat SDK 桥适配 | vitest |
| `src/cli/dispatch.test.ts` | dispatcher 三档 cli_scope 行为 | vitest |
| `src/cli/transport-errors.test.ts` | 客户端 transport 错误格式 | vitest |
| `src/modules/scheduling/db.test.ts` | recurrence 链不无限克隆 | vitest |
| `src/modules/agent-to-agent/agent-route.test.ts` | a2a 权限 + 返回路径 | vitest |
| `container/agent-runner/src/**/*.test.ts` | 容器侧 bun:test | `cd container/agent-runner && bun test` |
| `container/agent-runner/src/poll-loop.test.ts` | 轮询主循环 | bun test |
| `container/agent-runner/src/formatter.test.ts` | 消息批量格式化 | bun test |
| `container/agent-runner/src/destinations.test.ts` | destinations 查询 | bun test |
| `container/agent-runner/src/integration.test.ts` | 容器侧端到端 | bun test |
| `container/agent-runner/src/providers/factory.test.ts` | provider 注册 / 实例化 | bun test |
| `container/agent-runner/src/mcp-tools/core.test.ts` | core 工具 send_message 路径 | bun test |
| `scripts/sanity-live-poll.ts` | 真容器 + 真 SQLite live poll | `pnpm exec tsx scripts/sanity-live-poll.ts` |
| `scripts/test-v2-host.ts` | host 启动 / 路由 / 投递 e2e | `pnpm exec tsx scripts/test-v2-host.ts` |
| `scripts/test-v2-agent.ts` | 单 agent 端到端 | tsx 同上 |
| `scripts/test-v2-channel-e2e.ts` | channel adapter e2e | tsx 同上 |
| `scripts/q.test.ts` | q.ts 自身的回归 | vitest |

### 故障排查锚点（搬 + 扩 CLAUDE.md "Troubleshooting"）

| 症状 | 第一时间看哪里 |
|------|----------------|
| Agent 不回任何消息 | `logs/nanoclaw.error.log`（delivery 失败 / spawn 失败 / OneCLI 401）→ `logs/nanoclaw.log` 看 `routeInbound` 是否触发 |
| Agent 收到消息但卡住 | `pnpm exec tsx scripts/q.ts data/v2-sessions/<g>/<s>/inbound.db "SELECT id, status, tries, process_after FROM messages_in ORDER BY seq DESC LIMIT 10"` → 看是否 stuck 在 `processing` |
| 容器一直 spawn 失败 | `logs/nanoclaw.error.log` 找 `OneCLI gateway not applied`（`src/container-runner.ts:430`） |
| 401 from APIs in container | OneCLI agent 的 secret mode 是 `selective`，跑 `onecli agents set-secret-mode --id <agent-id> --mode all`（FAQ #5） |
| 容器频繁被杀 | `logs/nanoclaw.log` 找 `decideStuckAction`，看 heartbeat 是否 stale；`ABSOLUTE_CEILING_MS = 30min`（`src/host-sweep.ts:65`） |
| `processing_ack` 卡 `processing` 一直没动 | 容器还在跑（健康）→ 等；容器死了（heartbeat stale）→ sweep 会复位 `processing` claim，重启后 `DELETE FROM processing_ack WHERE status='processing'` |
| 改了 wiring agent 没变行为 | wiring 改动**不要重启容器**——`destinations` 表是 live 查的（`src/db/schema.ts:199`）。换了 trigger / engage_mode 才需要 restart |
| `add-discord` skill 装完没生效 | 看 `src/channels/index.ts` 有没有 import 那一行；`pnpm install` 是否真装 SDK；`pnpm run build` 通不通过；重启 host 后日志 `init channel adapters` 是否列了它（FAQ #4） |
| `pnpm install` 报 `minimumReleaseAge` 拒绝 | 包发布不满 3 天。**不要** 加 `minimumReleaseAgeExclude`，等 3 天 / 选老版本（CLAUDE.md "Supply Chain Security"） |
| `ncl groups restart --message` 后旧消息被处理了两遍 | 不可能——`on_wake=1` 列保证只在新容器第一次 poll 时拿（`src/container-restart.ts:18`）。如果真发生，看 `messages_in.on_wake` 列是否真写了 `1` |
| 容器内 `ncl` 卡住 | 容器侧 ncl 走 DB transport（`container/agent-runner/src/cli/ncl.ts`）。如果 host 进程不在，写到 outbound 的 `cli_request` 永远等不到响应。先 `ps` 看 host 在不在 |
| 镜像 rebuild 后还是旧的 | buildkit cache。`docker builder prune` 后再 `./container/build.sh`（CLAUDE.md "Container Build Cache" 一节） |
| CJK 文字截图变方块 | `.env` 设 `INSTALL_CJK_FONTS=true`，`./container/build.sh` 重 build（CLAUDE.md "CJK font support"） |
| v1 → v2 merge 冲突 | `git merge --abort`，**不要手解冲突**，跑 `bash migrate-v2.sh`（FAQ #7） |
| OneCLI approval 卡片不发出来 | `src/modules/approvals/onecli-approvals.ts` 注册了吗？`pickApprover` 找到候选 user 吗？`pickApprovalDelivery` 解析出可达 channel 吗？这三步逐一日志（`src/modules/approvals/primitive.ts:164`） |
| `pending_sender_approvals` 同一陌生人被审批多次 | 不会——表上有 `UNIQUE(messaging_group_id, sender_identity)`（`src/db/schema.ts:144`）作 in-flight dedup |
| host 启动一直被熔断挡住 | `data/circuit-breaker.json` 删掉重启，或修真正的崩溃原因（`src/circuit-breaker.ts:39` 的 `resetCircuitBreaker`）。**不要** 把熔断逻辑去掉 |
| 容器 stdout / stderr 看不到 | 是 `--rm` 容器，退出后 docker logs 也丢。在 agent-runner 改成 `log()` 写文件，或 docker run 时去掉 `--rm` 看一次 |
