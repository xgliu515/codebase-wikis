# Trace 导览总览：一条 `opencode run` 的完整旅程

参考手册的 14 章把 opencode 拆成一个个子系统讲清楚。但子系统之间是怎么咬合的、一条用户消息从命令行到屏幕到底流过哪些代码——靠翻参考手册是拼不出来的。这份 trace 导览就是为此存在：它选定**一个最小但真实的请求**，沿着调用栈一步步走完整条链路，每一步都回链到参考手册对应的小节。

读完参考手册你知道每个零件长什么样；走完这趟导览你知道这台机器是怎么转起来的。

---

## 选定的 trace 目标

我们追踪这样一次交互——它足够小（只触发一次工具调用），又足够真实（端到端真的能跑通），而且**穿过了全部四层架构**：

```text
$ opencode run "What's in README.md?"

（agent 调用 read 工具读 README.md，再组织一段总结）

opencode ▸ README.md 是 opencode 的项目说明：一个开源的、终端化的 AI
编码 agent，支持多种 LLM provider……
```

为什么选它：

- **最小复杂度**：`opencode run` 是单次非交互流（不走 TUI），只用到一个工具 `read`，不涉及 subagent、MCP、压缩、worktree 等高级特性——这些留给参考手册。
- **真实**：这是任何用户装好 opencode 后第一分钟就会做的事，不是为讲解硬造的场景。
- **穿透四层**：入口层（yargs CLI → `cmd/run.ts`）、Session / Agent 层（`Session.chat` 循环）、LLM 提供商层（`packages/llm` + provider 协议解码）、工具与权限层（`tool/read` + `Permission.evaluate`）——一层都不缺。如果选的目标让某一层"空转"，那一层的 trace 步骤就会写不出东西。

整条链路会触发**两次** LLM API 调用：第一次模型决定"我需要读 README.md"并返回一个 `tool_use`；工具执行后把结果回灌，第二次模型才生成给用户看的自然语言回答。这个"想 → 调工具 → 再想"的循环正是 agent 的本质，导览的第 07–13 步会把它拆到最细。

---

## 8 段式模板

从第 1 步起，每一步都用固定的 8 段结构写。这个结构的目的，是让每一个设计决策都显得**像是某个真实问题的逻辑结果**，而不是一句空降的结论。

| # | 段落 | 它负责什么 |
|---|------|-----------|
| 1 | 当前情境 | 锚定你在系统里的位置：上一步结束时什么数据结构成型了 |
| 2 | 问题 | 这一步必须解决的具体需求，带上利害关系 |
| 3 | 朴素思路 | 凭直觉你会怎么做——要让读者觉得"换我也这么写" |
| 4 | 为什么朴素思路会崩 | 具体的失败模式，不是"性能差"，而是"差在哪、错在哪" |
| 5 | opencode 的做法 | 此时真实设计读起来就像水到渠成的答案 |
| 6 | 代码位置 | 按阅读顺序列出的 `file:line` 引用 |
| 7 | 分支与延伸 | 链接回参考手册——把线性 trace 接进知识网络 |
| 8 | 走完这一步你脑子里应该多了什么 | 3–5 条以"新知识"措辞的收获 |

代码版本锁定在 `anomalyco/opencode@d74d166ac`（tag `v1.15.10`，2026-05-23）。所有 `file:line` 都基于这个 commit。

---

## 16 步速览

| 步 | 标题 | 一句话 | 主要落在 |
|----|------|--------|---------|
| 01 | 敲下 opencode run 之后 | bun 启动 packages/opencode 入口，yargs middleware 链 | 入口层 |
| 02 | run 子命令分派 | `cli/cmd/run.ts` 接管：参数解析、stdin 检测 | 入口层 |
| 03 | 加载配置与鉴权 | opencode.json + auth.json + env 合并出 provider + model | 入口层 / LLM 层 |
| 04 | 数据库初始化与 JSON 迁移 | SQLite 开库，首跑时把 JSON 旧数据迁过来 | Session 层 |
| 05 | 创建 Session 与首条消息 | `Session.create` + 写入 user `MessageV2` | Session 层 |
| 06 | 装配 system prompt 与工具表 | agent prompt + workspace 提示 + 内置工具 schema | Session 层 |
| 07 | 第一次 LLM 流式请求 | `session/llm.ts` → `packages/llm` → provider 适配 | LLM 层 |
| 08 | 解码 tool_use 片段 | 协议层把 Anthropic `tool_use` 归一为 Part(toolCall) | LLM 层 |
| 09 | 查表分派 read 工具 | `tool/registry` 命中 + Zod 校验 | 工具与权限 |
| 10 | 权限评估 | `Permission.evaluate` 跑 ruleset，read 默认放行 | 工具与权限 |
| 11 | 执行 `read("README.md")` | `fs.readFile` → truncate → ToolResult Part 入库 | 工具与权限 |
| 12 | 工具结果回灌 | 把 ToolResult 拼回 messages 再调一次 LLM | Session 层 |
| 13 | 生成最终文本响应 | 模型只产 text，无新 tool_call | LLM 层 |
| 14 | 持久化与事件广播 | Part 写入 SQLite + 每次写触发 SSE | Session 层 |
| 15 | 渲染到终端 / stdout | run 命令订阅 SSE，按 token 增量打印 | 入口层 |
| 16 | 会话 idle 与进程退出 | `SessionIdle` 事件、cost 累计、退出码 | 入口层 |

---

## 状态演化表

trace 的精髓是看**状态如何随每一步累积**。下面这张表记录关键变量在每一步结束时的样子——相邻步骤的 agent 用它对齐，不会互相矛盾或重复背景。

| 步 | 进程/对象状态 | `messages` 列表 | 关键新增变量 |
|----|--------------|----------------|-------------|
| 01 | Bun 解释器启动，`packages/opencode/src/index.ts` 已导入 | — | `argv` |
| 02 | yargs 命中 `run` builder，参数解析完毕 | — | `prompt`, `cwd` |
| 03 | `Config.load` / provider + model 选定，鉴权拿到 | — | `config`, `provider`, `model` |
| 04 | SQLite 连接就绪，schema 应用 / 迁移完成 | — | `db` |
| 05 | `Session` 行落表，user `MessageV2`+ text Part 入库 | `[user]` | `sessionID`, `userMsg` |
| 06 | system prompt 字符串成型，tool schema 列表序列化好 | `[system, user]`（运行时拼出，未落表） | `systemPrompt`, `tools[]` |
| 07 | 第一次 LLM 调用进入流式状态 | 同上 | `stream` |
| 08 | 流式输出已解出 1 个 `tool_use` 片段：read | `[system, user, assistant(tool_use)]` | `toolCallPart` |
| 09 | Tool registry 命中 `read`，args Zod 校验通过 | 同上 | `tool`, `args` |
| 10 | Permission.evaluate → `{ action: 'allow' }` | 同上 | `permission` |
| 11 | `read` 返回 README.md 文本（truncate 后）；ToolResult Part 入库 | `[..., toolResult]` | `toolResult` |
| 12 | 第二次 LLM 调用进入流式 | 同上 | `stream2` |
| 13 | 第二次流式只产 text Part，无 tool_call | `[..., assistant(text)]` | `finalText` |
| 14 | 所有 Part 已写库，最后 `MessagePartUpdated` 已发 | 同上（已落盘） | — |
| 15 | run 进程把累计 text 打印到 stdout | — | — |
| 16 | `SessionIdle` 事件发出，cost 累计入 SessionTable | — | `tokens.*`, `cost` |

---

## 怎么用这份导览

- **顺着读**：从第 1 步走到第 16 步，你会建立起对整条链路的肌肉记忆。
- **跳着读**：每一步的第 6 段给了精确 `file:line`，第 7 段链回参考手册——遇到想深挖的子系统，顺着链接跳进对应章节。
- **对照源码读**：导览锁定了 commit `d74d166ac`，所有行号可在 GitHub 上一键跳转验证。

下一步：[Trace 步骤 01 —— 敲下 opencode run 之后，谁在跑？](tour-01-shell-entry.md)
