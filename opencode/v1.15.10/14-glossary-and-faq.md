# 14. 术语表与 FAQ

本章是回查工具：碰到术语不确定时来查；碰到具体场景不确定怎么办时翻 FAQ；想知道 CLI/env 怎么用就翻速查表。术语按英文首字母分组。

## 术语表

### A

#### AGENT.md
中文名：AGENT.md（项目说明文件）  
项目根目录可放一个 `AGENT.md`（或 `CLAUDE.md` 兼容），opencode 把它注入 system prompt，让 LLM 知道项目结构、约定。多文件场景按发现顺序拼接。  
代码位置：`packages/opencode/src/session/instruction.ts:1`

#### ACP (Agent Client Protocol)
中文名：Agent 客户端协议  
JSON-RPC 协议规范，让编辑器（如 Zed）通过 stdio 调用外部 AI agent。opencode 作为 ACP server 把协议消息翻译成内部 Session/Tool 调用。  
代码位置：`packages/opencode/src/acp/agent.ts:1`、`packages/opencode/src/cli/cmd/acp.ts:13`  
规范：详见 `packages/opencode/src/acp/README.md`

#### Agent
中文名：代理 / 智能体  
opencode 的 agent 是一份**配置**：包含 system prompt、可用工具集合、可选的 model 覆盖、可选的 permission ruleset。它不是一个对象实例，而是描述"以什么身份回答"的元数据。内置 agent 包括 `build`（默认）、`plan`、`compaction`、`general`（subagent）等。  
代码位置：`packages/opencode/src/agent/agent.ts:1`

#### Aggregate
中文名：聚合根  
sync 事件系统的概念，一个 aggregate 是事件流的归属对象（一般是 sessionID）。同一 aggregate 的事件有单调 seq 保证全序，不同 aggregate 之间无序。  
代码位置：`packages/opencode/src/sync/index.ts:24`

#### Apply Patch
中文名：补丁应用  
一个内置工具，输入一段统一 diff 文本，原子地把多个文件改动应用到 workspace。比 edit 工具更适合大范围、跨文件的修改。  
代码位置：`packages/opencode/src/tool/apply_patch.ts:1`

### B

#### Background Job
中文名：后台任务  
进程内的轻量 job runner，跑 summary 计算、share 同步、压缩续传等不阻塞用户的任务。每个 job 有 id、status（running/completed/error/cancelled）、可 wait / cancel。  
代码位置：`packages/opencode/src/background/job.ts:53`

#### Bus（事件总线）
中文名：事件总线  
进程内 pub/sub。Schema-typed，`Bus.publish(def, payload)` 发布，`Bus.subscribe(def, handler)` 订阅。是 session、UI、plugin 解耦的核心。Sync event 也会再 publish 到 Bus 以兼容旧订阅者。  
代码位置：`packages/opencode/src/bus/index.ts:1`、`packages/opencode/src/bus/bus-event.ts:1`

### C

#### Cache Hint
中文名：缓存提示  
请求里某 ContentPart 上挂的 `{ type: "ephemeral", ttlSeconds? }` 标记。Anthropic / Bedrock 协议看到这个标记会在该位置插 cache breakpoint。  
代码位置：`packages/llm/src/schema/options.ts`（CacheHint 类）、`packages/llm/src/cache-policy.ts:44`

#### Cache Policy
中文名：缓存策略  
决定 prompt cache 切点的策略：`auto`（默认：tools + system + 最后 user message）、`none`、或显式对象。只对支持 inline cache marker 的协议（anthropic-messages、bedrock-converse）生效。  
代码位置：`packages/llm/src/cache-policy.ts:18`

#### Compaction
中文名：压缩  
把早期消息总结成 Markdown 模板腾出 context 空间。触发方式：用户 `/compact` 手动，或 LLM 调用前检测 `isOverflow` 自动。压缩 agent 的 system prompt 强制固定结构（Goal / Constraints / Progress / Decisions / Next Steps / Critical Context / Relevant Files）。  
代码位置：`packages/opencode/src/session/compaction.ts:344`

#### CORS
中文名：跨域资源共享  
HTTP 头机制，控制浏览器是否允许跨源请求 opencode 本地 server。`opencode serve` 默认仅允许 localhost。  
代码位置：`packages/opencode/src/server/cors.ts:1`

### D

#### Drizzle
中文名：Drizzle ORM  
opencode 用的轻量 TypeScript ORM，schema 直接是 TS 对象，生成 SQL。SessionTable / MessageTable / PartTable 等都通过 Drizzle 定义。  
代码位置：`packages/opencode/src/session/session.sql.ts:1`

### E

#### Effect
中文名：Effect（库）  
opencode 整套后端基于 `effect` 库——一种类似 ZIO 的 Scala 风格函数式效果系统。所有 `Effect.fn(...)` 包出来的函数延迟求值，错误用 typed channel 表示。  
代码位置：到处可见，入口示例 `packages/opencode/src/session/session.ts:1`

#### EventV2 / Sync Event
中文名：事件源化事件  
比传统 bus event 多了 `version` + `aggregate` + `seq`，可被持久化到 EventTable 并跨设备 replay。  
代码位置：`packages/opencode/src/sync/index.ts:24`、`packages/core/src/event/`

### F

#### Fork
中文名：分叉  
把现有 session 复制成一个新独立 session。可指定 `messageID` 作为截断点，截断点之后的消息不复制。fork 出来的 session 与原 session 平级（不写 parentID）。  
代码位置：`packages/opencode/src/session/session.ts:679`

### G

#### Global Bus
中文名：全局总线  
跨 instance 的事件广播器，用于 Desktop / Cloud 模式下不同 opencode 进程之间通信。  
代码位置：`packages/opencode/src/bus/global.ts:1`

### H

#### Hono
中文名：Hono（Web 框架）  
opencode 内置 HTTP server 用的微框架，路由定义在 `server/routes/` 下。`opencode serve` / `opencode acp` 启动的都是 Hono server。  
代码位置：`packages/opencode/src/server/server.ts:1`

### I

#### IDE Integration
中文名：IDE 集成  
检测当前是不是在 VSCode 系编辑器内置终端运行，并通过 `code --install-extension sst-dev.opencode` 安装扩展。VSCode/Cursor/Windsurf/VSCodium 走这条；Zed 走 ACP。  
代码位置：`packages/opencode/src/ide/index.ts:1`

#### Instance
中文名：实例  
"一个 opencode 进程绑定到一个具体的项目目录"的运行时单元。Instance 持有 config、bus、storage、所有 service layer 的引用。多个 instance 通过 GlobalBus 通信。  
代码位置：`packages/opencode/src/project/instance-context.ts:1`、`packages/opencode/src/effect/instance-state.ts:1`

### L

#### LLM
中文名：大语言模型  
opencode 把所有 model 调用抽象在 `packages/llm` 里。`LLMRequest` 是协议无关的 schema，再由 protocol adapter（anthropic-messages、openai-chat-completions、bedrock-converse 等）翻译成 provider 的 wire format。  
代码位置：`packages/llm/src/llm.ts:1`

#### Layer (Effect)
中文名：Layer / 依赖注入层  
Effect 库里的 DI 单元。每个 service 暴露一个 `defaultLayer`，App 启动时 `Layer.provide(...)` 把它们拼起来。  
代码位置：示例 `packages/opencode/src/session/session.ts` 文件末尾的 `defaultLayer`

### M

#### MCP (Model Context Protocol)
中文名：模型上下文协议  
Anthropic 推动的协议，定义远程 server 暴露 tool / resource / prompt 的方式。opencode 既能做 MCP client（调外部 server 的工具），也能通过 SDK 暴露 MCP server。  
代码位置：`packages/opencode/src/mcp/index.ts:1`

#### Message
中文名：消息  
session 里的一条记录，role 是 `user` / `assistant` / `system` 之一。Message 包含元数据（time、agent、model、cost、tokens），不直接包含正文——正文在 Part 里。  
代码位置：`packages/opencode/src/session/message.ts:1`

#### MessageV2
中文名：MessageV2  
v2 消息 schema，从 v1（早期版本）迁移而来。Part 类型扩展、tool state 机制、step-start/finish 都是 v2 引入。当前所有 message 都按 v2 存储；v1 数据通过 `data-migration.ts` 升级。  
代码位置：`packages/opencode/src/session/message-v2.ts:1`、`packages/opencode/src/data-migration.ts:1`

### O

#### OpenTUI
中文名：OpenTUI  
opencode TUI 用的渲染引擎，基于 SolidJS + 自定义终端 backend。每个组件是 `.tsx` 文件，可用 reactive primitives 处理状态。  
代码位置：`packages/opencode/src/cli/cmd/tui/app.tsx:1`、外部依赖 `@opentui/*`

#### Overflow
中文名：溢出  
当前消息累计 token > `usable(model)` 时触发自动 compaction。计算公式：`usable = model.limit.input - reserved`，`reserved` 默认 20k 或 `maxOutputTokens` 的较小值。  
代码位置：`packages/opencode/src/session/overflow.ts:20`

### P

#### Part
中文名：part / 片段  
Message 的最小内容单元，类型包括 `text` / `reasoning` / `file` / `tool` / `patch` / `snapshot` / `step-start` / `step-finish` / `compaction` / `agent` / `subtask`。一条 message 通常由多个 part 组成。  
代码位置：`packages/opencode/src/session/message-v2.ts`（Part union 定义处）

#### Permission
中文名：权限 / 权限规则  
opencode 在执行敏感工具（编辑文件、跑 shell）前查 permission。Ruleset 是一组 rule 的有序数组，按顺序匹配，第一个命中决定 allow / deny / ask。可以在 config、agent、session 三层叠加。  
代码位置：`packages/opencode/src/permission/index.ts:1`、`packages/opencode/src/permission/evaluate.ts:1`

#### Plugin
中文名：插件  
外部 npm 包或本地 JS 文件，通过 `experimental.*` hook 在 opencode 关键路径上插入逻辑（修改消息、注入 context、定制压缩 prompt、添加 provider 等）。  
代码位置：`packages/opencode/src/plugin/index.ts:1`、`packages/opencode/src/plugin/loader.ts:1`

#### Project
中文名：项目  
对应一个工作目录（worktree 根）。Project 有自己的 ID（持久化在全局 SQLite），下面挂多个 session。Project 的 VCS 检测决定能否用 snapshot 和 worktree。  
代码位置：`packages/opencode/src/project/project.ts:1`、`packages/opencode/src/project/vcs.ts:1`

#### Projector
中文名：投影器 / 投影函数  
Sync event 系统里，给定事件 data 把它落盘到 DB 的函数。Projector 是事件的"语义"——同一事件被不同 projector 处理可写到不同表。  
代码位置：`packages/opencode/src/server/projectors.ts:1`、`packages/opencode/src/sync/index.ts:281`

#### Provider
中文名：服务商  
LLM provider（anthropic、openai、bedrock、gemini、azure 等）的抽象。Provider 提供 model 列表、credentials、protocol 路由。  
代码位置：`packages/llm/src/provider.ts:1`、`packages/opencode/src/provider/provider.ts:1`

### R

#### Reasoning
中文名：推理 token  
模型在内部推理过程消耗但不直接显示的 token（Anthropic extended thinking、DeepSeek R1、o1 等）。opencode 单独统计 `tokens.reasoning`。  
代码位置：`packages/opencode/src/session/session.ts:171`

#### Reminder
中文名：提醒  
在最近一条 user message 上追加的 `synthetic: true` text part，用于注入"当前是 plan 模式"、"刚切到 build"、"plan 文件已存在"等元提示。LLM 看得到，UI 默认隐藏。  
代码位置：`packages/opencode/src/session/reminders.ts:14`

#### Revert
中文名：回退  
给 session 打 revert 标记，使某个 messageID（或 partID）之后的消息渲染时被跳过、对应文件被 snapshot 回滚。可 `unrevert` 取消。  
代码位置：`packages/opencode/src/session/revert.ts:41`

#### Rule (Permission Rule)
中文名：权限规则  
一条规则形如 `{ tool: "bash", pattern: "git *", action: "allow" }`。pattern 可用 glob。第一个匹配的 rule 决定最终 action。  
代码位置：`packages/opencode/src/permission/schema.ts:1`

#### Ruleset
中文名：规则集  
Rule 的数组。Session 持有当前生效的 ruleset，可由 config / agent / 用户在 TUI 手动叠加。  
代码位置：`packages/opencode/src/permission/schema.ts:1`

### S

#### Sandbox
中文名：沙箱  
Project 允许 opencode 在其下创建辅助目录的标记。Snapshot 的 git 目录、worktree 都注册为 sandbox，方便统一管理。  
代码位置：`packages/opencode/src/project/project.ts`（addSandbox / listSandboxes）

#### Session
中文名：会话  
一次对话单元。每个 session 有 id（ULID-like）、title、agent、model、token / cost 统计、可选的 parent（subagent 链）。Session 跨 process 持久化，可 fork / share / export。  
代码位置：`packages/opencode/src/session/session.ts:1`

#### Session Fork
中文名：会话分叉  
参见 Fork。等价术语，强调"从某 session 复制"。

#### Skill
中文名：技能  
项目或全局 `skill/<name>/SKILL.md` 文件定义的"复合操作技巧"。每个 SKILL.md 第一行 frontmatter 描述何时使用、之后是 markdown 内容。LLM 通过 skill 工具被加载内容。  
代码位置：`packages/opencode/src/skill/index.ts:1`

#### Snapshot
中文名：快照  
对工作目录在某时刻全部文件的 git tree。每个 project+worktree 在 `~/.local/share/opencode/snapshot/<projectID>/<hash>/` 有独立 git 仓库。  
代码位置：`packages/opencode/src/snapshot/index.ts:279`（track）

#### SolidJS
中文名：Solid.js  
TUI 用的细粒度响应式 UI 库。`createSignal` / `createMemo` / JSX 都来自 Solid，但渲染目标是终端而不是 DOM。  
代码位置：`packages/opencode/src/cli/cmd/tui/`

#### SSE (Server-Sent Events)
中文名：服务器推送事件  
HTTP server → client 单向流。`opencode serve` 的 `/event` endpoint 用 SSE 把 bus 事件推给 SDK / TUI / Desktop。  
代码位置：`packages/opencode/src/server/event.ts:1`、`packages/opencode/src/server/routes/`

#### Step-start / Step-finish
中文名：步骤起 / 止 part  
一对特殊 part，分别在 LLM 一次 turn 开始和结束时插入，携带 snapshot hash。session summary 用它们界定"这一 turn 改了什么"。  
代码位置：`packages/opencode/src/session/message-v2.ts`（StepStartPart / StepFinishPart）

#### Storage
中文名：存储层  
对 SQLite + 文件系统的统一封装。提供 `read` / `write` / `remove` / `list` 等键值化 API，底层路由到 DB 或文件，根据数据类型决定。  
代码位置：`packages/opencode/src/storage/storage.ts:1`

#### Subagent
中文名：子代理 / 子任务 agent  
通过 `subtask` tool 启动的子 session。父 session 调用子 session 跑独立任务（如 web search），完成后返回总结。子 session 的 `parentID` 字段指向父。  
代码位置：`packages/opencode/src/session/session.ts:215`（parentID）、`packages/opencode/src/agent/subagent-permissions.ts:1`

#### Synthetic Part
中文名：合成 part  
`synthetic: true` 标记的 part，非用户实际输入，但参与 LLM 上下文。Reminder 系统、auto-compaction 续提示都是 synthetic part。UI 渲染时默认隐藏。  
代码位置：`packages/opencode/src/session/reminders.ts:33`

#### System Prompt
中文名：系统提示  
LLM 调用里 role=system 的内容。opencode 的 system prompt 由多段拼接：agent 默认 + project AGENT.md + 用户 system 段。  
代码位置：`packages/opencode/src/session/system.ts:1`、`packages/opencode/src/session/instruction.ts:1`

### T

#### Task / TodoWrite
中文名：任务 / TodoWrite  
LLM 在长任务里维护的 todo 列表。`todowrite` 工具让模型显式 add/update/done todo，session 持久化这些状态。UI 显示进度。  
代码位置：`packages/opencode/src/session/todo.ts:1`

#### Tool
中文名：工具  
LLM 可调用的函数。opencode 内置 read/edit/write/glob/grep/bash/lsp/apply_patch/plan/question/todowrite 等；MCP server 注册的工具也会进同一注册表。  
代码位置：`packages/opencode/src/tool/`（每个工具一个 `.ts` + `.txt` 描述）

#### Tool Call
中文名：工具调用  
模型返回的 `{ tool, input }`。在 part 里表现为 `MessageV2.ToolPart`，state 从 pending → running → completed/error 流转。  
代码位置：`packages/opencode/src/session/message-v2.ts`（ToolPart 定义）

#### Tool Result
中文名：工具结果  
工具执行完写回 ToolPart 的 `state.output`（文本）+ `state.metadata`（结构化数据）。LLM 在下一轮 input 里看到 output。  
代码位置：见 ToolPart.state（`packages/opencode/src/session/message-v2.ts`）

#### Transform
中文名：转换 / 变换  
provider 把通用 `LLMRequest` 翻译成 provider-specific wire format 的过程。每个 protocol 一个 transform。  
代码位置：`packages/opencode/src/provider/transform.ts:1`、`packages/llm/src/protocols/`

#### Truncate
中文名：截断  
当工具输出超过阈值时（如 `TOOL_OUTPUT_MAX_CHARS = 2000`，仅在压缩输入时），把中间部分省略掉再发给 LLM。  
代码位置：`packages/opencode/src/session/compaction.ts:37`

#### TUI
中文名：终端 UI  
`opencode` 不带参数运行时进入的 SolidJS + OpenTUI 终端界面。包含 prompt 输入、消息列表、diff viewer、status bar 等。  
代码位置：`packages/opencode/src/cli/cmd/tui/app.tsx:1`

### U

#### ULID
中文名：ULID（lexicographically sortable id）  
opencode 的 SessionID / MessageID / PartID 都是 ULID-like：前缀是毫秒时间戳的 base32，后缀是随机熵。这样按字典序排就是时间序，方便"找早于 X 的消息"。  
代码位置：`packages/opencode/src/id/id.ts:1`

### W

#### Worktree
中文名：工作树  
git 的 worktree 概念——同一仓库 checkout 到多个独立目录、各自一条分支。opencode 用它让 subagent 在隔离目录跑工具，避免与主 agent 互相覆盖。  
代码位置：`packages/opencode/src/worktree/index.ts:299`

#### Workspace
中文名：工作区  
实验性概念，把多个 instance 编入一个共享 workspaceID 下，用于跨实例 sync。开关：`OPENCODE_EXPERIMENTAL_WORKSPACES`。  
代码位置：`packages/core/src/flag/flag.ts:45`、`packages/opencode/src/effect/instance-state.ts`

### V

#### VCS
中文名：版本控制系统  
opencode 检测项目根目录用的是哪种 VCS（git / jj / 无）。VCS 类型决定 snapshot 和 worktree 是否可用。  
代码位置：`packages/opencode/src/project/vcs.ts:1`

### Y

#### Yargs
中文名：yargs（CLI 解析库）  
所有 `opencode <cmd>` 的命令解析都基于 yargs。每个 subcommand 在 `packages/opencode/src/cli/cmd/<name>.ts` 定义 `command` / `describe` / `builder` / `handler`。  
代码位置：`packages/opencode/src/cli/effect-cmd.ts:1`、`packages/opencode/src/cli/cmd/stats.ts:49`

### Z

#### Zod / Effect Schema
中文名：Schema 校验  
opencode 用 `effect/Schema` 做运行时类型校验（导入导出、API 边界）。早期某些地方还残留 zod，但主线在迁移到 effect/Schema。  
代码位置：`packages/opencode/src/session/schema.ts:1`、`packages/opencode/src/session/session.ts:1`（Schema.Struct 等）

---

## 常见问题 FAQ

### Q1：为什么 `opencode run` 和 TUI 能共享同一个 session？

因为 session 是持久化的，存在 SQLite 里。`opencode run "do X"` 启动一个 instance，建一个新 session 跑完一轮就退出；下次 `opencode`（TUI）启动时如果显式 `opencode --continue` 或在 TUI 里选这条 session，就能继续。Instance 不持有"用户态"，所有状态都在 storage 里。

代码：`packages/opencode/src/cli/cmd/run.ts:1`、`packages/opencode/src/cli/cmd/run/footer.prompt.tsx:1`。

### Q2：改完 `opencode.json` 要重启吗？

绝大多数 config 字段不需要——`Config.Service` 在大多数读取点都重新 load。但有几类例外：

- 改 `provider` / 新增 model：可能要重启让 LLM 层缓存重建。
- 改 `compaction.tail_turns` 等：下次压缩生效，不用重启。
- 改 `share: "auto"`：只影响新 session。
- 实验性 flag（`experimental.*`）：建议重启。

参考：`packages/opencode/src/config/config.ts:1`。

### Q3：怎么自定义一个内置 tool？

不要直接改 `packages/opencode/src/tool/*.ts`。推荐两条路径：

1. **MCP server**：起一个本地 MCP server 暴露你的 tool，在 `opencode.json` 的 `mcp` 配置里注册。MCP tool 自动加入工具注册表。
2. **Plugin hook**：用 `experimental.tool.execute.before` / `.after` 钩子改写现有 tool 行为，或在 `experimental.session.compacting` 等 hook 里注入 context。

参考：`packages/opencode/src/mcp/index.ts:1`、`packages/opencode/src/plugin/index.ts:1`。

### Q4：subagent 能调用 subagent 吗？

可以，但 opencode 默认限制嵌套深度防递归爆炸。每次 subagent session 创建时检查父链长度，超过限制拒绝。同时 subagent 的工具集和 permission 是子集而非父集（防止子任务越权）。

代码：`packages/opencode/src/agent/subagent-permissions.ts:1`。

### Q5：LLM 不停调工具陷死循环怎么破？

几种处理：

- **硬限制**：每个 turn 内的工具调用数上限可在 config 里设。
- **手动中断**：TUI 里 `Ctrl-C` 中断当前 turn。
- **revert**：等它跑完后 `/revert` 回到死循环前。
- **看 stats**：`opencode stats --tools` 显示哪些工具被滥用，调 permission 把它们设成 `ask`。

代码：`packages/opencode/src/session/llm.ts:1`（循环主体）、`packages/opencode/src/session/run-state.ts:1`（中断标志）。

### Q6：prompt cache 在 opencode 里怎么命中？

只对 Anthropic / Bedrock 协议自动加 marker（`packages/llm/src/cache-policy.ts:42`）。命中关键：**前缀稳定**。具体注意：

- system prompt 别每次变（避免随机 UUID、当前时间）。
- 工具定义稳定（不要每次重排顺序）。
- 最后一条 user message 后续如果只是追加 assistant + tool 循环，前缀缓存能持续命中。

看命中率：`opencode stats` 的 cache read/write 比例。read 高 = 命中好。

### Q7：subagent 在 worktree 里跑的文件改动会被 main agent 看到吗？

不会自动看到。Subagent 用 worktree 是为了隔离——它的 edit 工具改的是 worktree 目录下的文件，main agent 在主 worktree 里看不到。subagent 退出后，main agent 通过 subagent 返回的文本（如"我改了 a.ts, b.ts"）感知变更；要 merge 需要显式调 git 操作或 apply_patch。

代码：`packages/opencode/src/worktree/index.ts:299`。

### Q8：导出的 session JSON 我可以直接 `cat` 看吗？

可以。`opencode export <sessionID>` 输出标准 JSON 到 stdout。结构是 `{ info: Session.Info, messages: [{ info, parts }] }`。可以管道到 `jq`、保存为文件、版本控制。如果含敏感数据加 `--sanitize` 会把文本字段替换成 `[redacted:...]` 占位符。

代码：`packages/opencode/src/cli/cmd/export.ts:221`。

### Q9：分享 URL 给别人，他能看见我的 API key 吗？

不会。Share 只 push session 数据（messages、parts、diff、模型 ID）到 opncd.ai（或企业自部署），不上传任何 credential。模型只上传 `providerID/modelID` 字符串。Provider 的 API key 始终在你本地。

代码：`packages/opencode/src/share/share-next.ts:278`（full 同步内容）。

### Q10：压缩是把所有早期消息都丢了吗？

不是。Compaction 把 **head**（早期）消息总结成结构化 Markdown，然后插入一条 assistant `summary` message 替代它们；**tail**（最近若干 turn，默认 2 个 turn）保留原样。压缩点之前的原始消息**仍在 DB 里**，只是发给 LLM 时不再带。如果想回看完整历史，TUI 提供"展开 compaction"的视图。

代码：`packages/opencode/src/session/compaction.ts:245`（select）、`compaction.ts:344`（process）。

### Q11：我能完全禁用 snapshot 吗？

可以。两种方式：

1. config：`{ "snapshot": false }`（顶层）。
2. 项目不是 git 仓库时（VCS 检测 ≠ git）自动禁用。

但禁用后 revert 不能恢复文件，只能"删消息"。强烈建议保留。

代码：`packages/opencode/src/snapshot/index.ts:168`（enabled）。

### Q12：我能换默认的压缩 prompt 模板吗？

代码里 `SUMMARY_TEMPLATE` 是 hard-coded（`compaction.ts:42`），但有 plugin hook：`experimental.session.compacting` 允许返回 `{ prompt, context }` 完全替换压缩 prompt。也可以 fork 项目改字符串。

参考：`packages/opencode/src/session/compaction.ts:397`（plugin trigger）。

### Q13：能不能离线跑 opencode？

部分可以：

- TUI / CLI 启动、stats、export、import 都纯本地。
- LLM 调用需要 provider API（OpenAI / Anthropic / 等），这个绕不开。
- 用本地模型：通过 `ollama` 或自部署 OpenAI-compatible endpoint，把 baseUrl 指到 localhost，可以完全离线。
- 模型 catalog 默认在线拉，`OPENCODE_DISABLE_MODELS_FETCH=1` 或 `OPENCODE_MODELS_PATH` 指向本地文件可离线。
- Share 是可选的，离线 OK。

参考：`packages/core/src/flag/flag.ts:25`。

### Q14：sync 和 share 是同一个东西吗？

不是。

- **Share**（13.11）：你把 session 推给**别人**看（或公开），有 URL，单向只读快照 + 增量同步。
- **Sync**（13.12）：你**自己**多台设备之间同步同一 session 状态，双向（但同时只有一个 writer），实验性。

它们都依赖事件流，但 endpoint 和权限模型完全不同。

### Q15：MCP 工具调用失败为什么不报错给我？

opencode 默认对 MCP tool 的失败做 "soft fail"——把错误转成 tool result 的文本回给 LLM，让模型自己决定怎么处理（重试、换工具、放弃）。这避免单个工具崩溃就让整轮 turn 失败。要看真实错误：

```
opencode mcp logs        # 查看 MCP server 调用日志
```

或者在 plugin 的 `experimental.tool.execute.after` 钩子里读 `result.error`。

### Q16：怎么 debug "为什么我的工具调用被拒绝了"？

permission 决策路径：

1. session.permission（用户在 TUI 临时设置）
2. agent.permission（agent 配置自带）
3. config.permission（项目 / 全局 config）
4. 默认（`bash` / `edit` / `write` 等敏感工具默认 `ask`）

按顺序匹配，第一个命中的 rule 决定。debug：

- `opencode session show <id>` 看当前 session 的 ruleset。
- 在 TUI 里改 permission 立即生效，不用重启。
- 看 `packages/opencode/src/permission/evaluate.ts:1` 知道匹配算法。

### Q17：opencode 怎么和 git hook 互动？

opencode 本身不装 git hook。但：

- 工具 `bash` 调 git 命令时正常触发用户已装的 hook。
- snapshot 用的是**隐藏 git 仓库**（`Global.Path.data/snapshot/...`），不会触发用户的 hook。
- worktree 创建新分支后正常受用户 git config / hook 影响。

参考：`packages/opencode/src/snapshot/index.ts:81`、`packages/opencode/src/worktree/index.ts:224`。

---

## 环境变量速查

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `OPENCODE_CONFIG` | 额外加载一个 config 文件 | 未设 |
| `OPENCODE_CONFIG_CONTENT` | 直接传 JSON 内容做 config | 未设 |
| `OPENCODE_CONFIG_DIR` | 覆盖 config 搜索目录 | 未设 |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | 跳过项目本地 `opencode.json` | 0 |
| `OPENCODE_DISABLE_AUTOUPDATE` | 关闭自动检查更新 | 0 |
| `OPENCODE_DISABLE_AUTOCOMPACT` | 关闭自动压缩 | 0 |
| `OPENCODE_DISABLE_MODELS_FETCH` | 不从网络拉 model catalog | 0 |
| `OPENCODE_DISABLE_MOUSE` | TUI 禁用鼠标 | 0 |
| `OPENCODE_DISABLE_PRUNE` | 禁用工具输出 prune | 0 |
| `OPENCODE_DISABLE_TERMINAL_TITLE` | 不修改终端标题栏 | 0 |
| `OPENCODE_DISABLE_SHARE` | 全局禁用 share 子系统 | 0 |
| `OPENCODE_PURE` | 跳过所有外部插件 | 0 |
| `OPENCODE_PERMISSION` | 覆盖 permission ruleset | 未设 |
| `OPENCODE_CLIENT` | 当前客户端类型（cli / tui / acp / vscode） | `cli` |
| `OPENCODE_DB` | SQLite 路径 | `~/.local/share/opencode/storage.db` |
| `OPENCODE_MODELS_URL` | 自定义 model catalog 远端 URL | 官方 |
| `OPENCODE_MODELS_PATH` | 自定义 model catalog 本地路径 | 未设 |
| `OPENCODE_GIT_BASH_PATH` | Windows 上 git bash 路径 | 自动 |
| `OPENCODE_FAKE_VCS` | 测试用，伪造 vcs 类型 | 未设 |
| `OPENCODE_SERVER_PASSWORD` | server 鉴权密码 | 未设 |
| `OPENCODE_SERVER_USERNAME` | server 鉴权用户名 | 未设 |
| `OPENCODE_WORKSPACE_ID` | 显式指定 workspace id（实验性） | 自动 |
| `OPENCODE_EXPERIMENTAL` | 打开所有实验性 flag | 0 |
| `OPENCODE_EXPERIMENTAL_WORKSPACES` | 单独打开 workspaces | 0 |
| `OPENCODE_EXPERIMENTAL_FILEWATCHER` | 单独打开实验性 filewatcher | 0 |
| `OPENCODE_AUTO_HEAP_SNAPSHOT` | 启动时打 V8 heap snapshot（debug） | 0 |
| `OPENCODE_SHOW_TTFD` | 显示 time-to-first-draw | 0 |
| `OPENCODE_ALWAYS_NOTIFY_UPDATE` | 即使无更新也提示 | 0 |
| `OPENCODE_ENABLE_QUESTION_TOOL` | ACP 模式下启用 QuestionTool | 0 |
| `OPENCODE_DISABLE_EXTERNAL_SKILLS` | 不扫外部 skill 目录 | 0 |
| `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` | 不扫 claude-code skill 目录 | 0 |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS` | 不加载默认插件集 | 0 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry 上报地址 | 未设 |
| `OTEL_EXPORTER_OTLP_HEADERS` | OpenTelemetry headers | 未设 |
| `ANTHROPIC_API_KEY` | Anthropic provider key | 未设 |
| `OPENAI_API_KEY` | OpenAI provider key | 未设 |

代码参考：`packages/core/src/flag/flag.ts:1`。

## 命令速查

| 命令 | 作用 | 相关章节 |
| --- | --- | --- |
| `opencode` | 启动 TUI（默认） | [第 8 章](08-tui.md) |
| `opencode run "<prompt>"` | 一次性跑一个 prompt，stdout 输出 | [第 8 章](08-tui.md) |
| `opencode serve` | 启动 HTTP server（给 SDK / Desktop / Web 用） | [第 9 章](09-server.md) |
| `opencode acp` | 启动 ACP server（给 Zed 用） | [§13.14](13-advanced-features.md#1314-acpagent-client-protocol) |
| `opencode session list` | 列出所有 session | [第 6 章](06-session-storage.md) |
| `opencode session new` | 新建一个空 session | [第 6 章](06-session-storage.md) |
| `opencode stats [--days N] [--tools N] [--models]` | token / cost / 工具用量统计 | [§13.7](13-advanced-features.md#137-成本统计) |
| `opencode export [sessionID] [--sanitize]` | 导出 session JSON | [§13.16](13-advanced-features.md#1316-导入--导出) |
| `opencode import <file-or-url>` | 从 JSON 或 share URL 导入 | [§13.16](13-advanced-features.md#1316-导入--导出) |
| `opencode auth login` / `auth status` | provider 登录管理 | [第 5 章](05-provider-llm.md) |
| `opencode providers` | 列出可用 provider | [第 5 章](05-provider-llm.md) |
| `opencode models` | 列出可用 model（带 context limit、单价） | [第 5 章](05-provider-llm.md) |
| `opencode mcp` | MCP server 调试 | [§13](13-advanced-features.md) |
| `opencode github` | GitHub 集成命令（PR review 等） | — |
| `opencode pr` | 创建 / 操作 PR 的 helper | — |
| `opencode generate` | 用 LLM 生成内容到 stdout | — |
| `opencode plug` | plugin 管理（install / list / ...） | [§13](13-advanced-features.md) |
| `opencode db` | DB 调试子命令 | [第 6 章](06-session-storage.md) |
| `opencode debug …` | 各种内部 debug 子命令 | — |
| `opencode upgrade` | 自更新到最新版 | — |
| `opencode uninstall` | 清理本地数据 / 卸载 | — |
| `opencode web` | 启动本地 Web UI（实验性） | [第 9 章](09-server.md) |

TUI 内常用命令（输入栏以 `/` 开头）：

| TUI 命令 | 作用 |
| --- | --- |
| `/help` | 显示帮助 |
| `/compact` | 立即压缩当前 session |
| `/fork` | 在当前光标处分叉 session |
| `/revert` | 回退到选中消息之前 |
| `/share` | 分享当前 session 拿 URL |
| `/unshare` | 取消分享 |
| `/agent <name>` | 切换 agent |
| `/model <provider/model>` | 切换 model |
| `/permission` | 编辑权限规则 |
| `/clear` | 清屏（不删 session） |
| `/exit` | 退出 TUI |
| `/sessions` | 切换 session |

实际可用的 TUI 命令清单见 `packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx` 的命令注册。

---

至此 14 章 wiki 完成。建议阅读路径：

1. 第一次接触 → [第 1 章总览](01-overview.md) → [第 2 章架构](02-architecture.md) → [第 8 章 TUI](08-tui.md) 跑起来。
2. 想加 provider / 模型 → [第 5 章](05-provider-llm.md) + [§13.8 cache](13-advanced-features.md#138-prompt-caching-支持)。
3. 想加 tool / plugin → [第 7 章](07-tools-permissions.md) + [§13](13-advanced-features.md) plugin 节。
4. 想理解为什么这么慢 / 这么贵 → [§13.4 compaction](13-advanced-features.md#134-消息压缩compaction) + [§13.7 stats](13-advanced-features.md#137-成本统计)。
5. 想做集成（Zed / VSCode / Desktop）→ [§13.14 ACP](13-advanced-features.md#1314-acpagent-client-protocol) + [第 9 章 server](09-server.md)。
