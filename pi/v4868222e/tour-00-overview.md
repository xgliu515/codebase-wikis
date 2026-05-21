# Trace Tour 总览

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本 tour 所有 `file:line` 引用均基于该 commit。

---

## 本次旅程的请求是什么

用户在终端运行 `pi` 进入交互模式,在输入框中键入「读一下 README.md 的第一行」后按回车。模型决定调用 `read` 工具读取文件,得到第一行内容后输出文字回复。

**前提条件**:
- 用户终端 cwd 为某个包含 `README.md` 的目录(例如 pi 仓库根目录)。
- `pi` 已通过 `npm i -g @earendil-works/pi-coding-agent` 安装,`pi` 命令可从 PATH 找到。
- `ANTHROPIC_API_KEY` 已经在环境变量里,默认使用 Anthropic provider。
- 运行 Node.js 22+,无 `--print`/`--mode` 覆盖,stdin 是 TTY。

---

## 为什么挑这个 trace

可选的请求从「你好」到「帮我重构整个项目」跨度极大。选「读一下 README.md 的第一行」是因为它同时满足三个条件:

1. **最简但完整**:正好触发一次工具调用闭环(用户消息 → 模型决策 → 工具执行 → 结果回传 → 最终回复),不会因多轮工具调用增加干扰。

2. **覆盖全部四层**:请求从 TUI 键盘捕获出发,经过 coding-agent 的 AgentSession,下钻到 agent-core 的工具调用状态机,再穿越 pi-ai 的 Anthropic provider,最后由工具层真实读取文件。四层全程参与,没有短路。

3. **工具调用是 pi 的核心差异化特性**:区别于纯问答 chatbot,`read` 工具让 pi 能操作本地文件系统。这条 trace 能直观展示「agent 怎么从一个文本指令变成一次系统调用」。

相比之下,「问 hello 世界」不触发任何工具调用,无法展示 agent loop;「写一个完整网站」会触发几十次工具调用,步骤之间的因果关系难以在 17 步内清楚呈现。

---

## 17 步路线图

| # | 标题 | 本步关注什么 |
|---|------|------------|
| 01 | pi 命令进入 main.ts | shell 找到 `pi` 二进制,ESM 入口 `cli.ts` 转发 `main.ts`,完成参数解析与模式分支确认进入 interactive mode |
| 02 | AgentSessionRuntime 装配 | `main.ts` 调用工厂闭包,依次创建 AuthStorage、SettingsManager、ModelRegistry、ResourceLoader,最终构造 AgentSessionRuntime |
| 03 | AgentSession 与 Agent 构建 | `createAgentSessionFromServices` 如何创建 Agent 与 AgentSession,内置工具如何注册,system prompt 如何组装 |
| 04 | InteractiveMode 与 TUI 启动 | InteractiveMode.run() 拉起 TUI,ProcessTerminal 进入原始模式,首屏渲染 |
| 05 | 用户输入被捕获 | TUI 的键盘事件循环如何接收字符序列,InputComponent 如何积累文本,回车如何触发 submit |
| 06 | 消息从 TUI 到 AgentSession | InteractiveMode 拿到用户文本后调用 `session.prompt()`,消息如何经 extension input 事件钩子流入 agent |
| 07 | AgentSession 调用 Agent.prompt | AgentSession 如何组装 user message、追加到 state.messages,然后调用 `agent.prompt()` 进入 agent-core |
| 08 | agent-core 的 agentic loop | Agent 工具调用状态机进入第一次迭代,构造请求上下文,调用 `ai.stream()` |
| 09 | pi-ai 发起 Anthropic streaming 请求 | AnthropicProvider 如何把 AgentState 转换为 Anthropic Messages API 请求,建立 SSE 流 |
| 10 | 模型返回 tool_use block | SSE 流解析,AssistantMessage 中包含 tool_use 块,agent loop 识别并退出第一次 LLM 迭代 |
| 11 | AgentSession 转发流式事件到 TUI | agent 事件通过订阅链传到 AgentSession,AgentSession 再传到 InteractiveMode,TUI 实时渲染 thinking/text |
| 12 | read 工具被调度执行 | agent loop 解析 tool_use 块,查找 `read` 工具定义,调用工具 handler 读取文件 |
| 13 | read 工具读取文件第一行 | `read` 工具 handler 内部如何打开文件、截取行范围、做安全路径检查 |
| 14 | tool result 写回 agent state | 工具返回结果封装为 `tool_result` 消息,追加到 state.messages,JSONL 持久化 |
| 15 | 第二次 LLM 调用(含 tool result) | agent loop 携带 tool result 再次调用 `ai.stream()`,模型生成最终文字回复 |
| 16 | 最终回复流式渲染到 TUI | AssistantMessage 文本块经 delta 事件逐字推送,TUI 差分更新终端 |
| 17 | turn 结束与状态归位 | agent loop 退出,AbortController 释放,JSONL 写完,TUI 恢复输入框,等待下一条用户输入 |

---

## 状态演化表

下表追踪每步结束时进程内最关键的状态量。"—" 表示该步骤不改变此变量。

| 步骤结束后 | 进程位置 | AgentSessionRuntime | session.messages 长度 | TUI 是否渲染 | 当前 AbortController | AssistantMessageEventStream | 当前 tool call 数 | 已写入 JSONL 消息数 |
|-----------|---------|--------------------|-----------------------|-------------|--------------------|-----------------------------|-------------------|-------------------|
| 步骤 00(起点) | shell 等待用户输入 `pi` | 未创建 | 0 | 否 | 无 | 未建立 | 0 | 0 |
| 步骤 01 结束 | `main()` 已返回 `appMode="interactive"`,等待装配 | 未创建 | 0 | 否 | 无 | 未建立 | 0 | 0 |
| 步骤 02 结束 | runtime 工厂执行完毕,services 已就绪 | 已 ready | 0 | 否 | 无 | 未建立 | 0 | 0 |
| 步骤 03 结束 | AgentSession+Agent 已构造,工具已注册 | 已 ready | 0 | 否 | 无 | 未建立 | 0 | 0 |
| 步骤 04 结束 | ProcessTerminal 原始模式,首屏已渲染 | 已 ready | 0 | 是 | 无 | 未建立 | 0 | 0 |
| 步骤 05 结束 | TUI 输入框已收到全部字符+回车 | 已 ready | 0 | 是 | 无 | 未建立 | 0 | 0 |
| 步骤 06 结束 | `session.prompt()` 已调用 | 已 ready | 1(user) | 是 | 新建 | 未建立 | 0 | 1 |
| 步骤 07 结束 | `agent.prompt()` 已调用,进入 agent loop | 已 ready | 1(user) | 是 | 已注册 | 未建立 | 0 | 1 |
| 步骤 08 结束 | agent loop 第 1 次迭代,`ai.stream()` 调用发出 | 已 ready | 1(user) | 是 | 已注册 | 建立中(HTTP 已发送) | 0 | 1 |
| 步骤 09 结束 | Anthropic SSE 流已建立,首个 delta 到达 | 已 ready | 1(user) | 是 | 已注册 | streaming | 0 | 1 |
| 步骤 10 结束 | SSE 流关闭,tool_use block 完整解析 | 已 ready | 2(user+assistant) | 是 | 已注册 | closed | 1 | 2 |
| 步骤 11 结束 | TUI 渲染了 assistant thinking/text | 已 ready | 2(user+assistant) | 是 | 已注册 | closed | 1 | 2 |
| 步骤 12 结束 | read 工具 handler 被调用,文件 I/O 进行中 | 已 ready | 2(user+assistant) | 是 | 已注册 | 未建立 | 1 | 2 |
| 步骤 13 结束 | read 工具返回第一行文本 | 已 ready | 2(user+assistant) | 是 | 已注册 | 未建立 | 1 | 2 |
| 步骤 14 结束 | tool result 追加到 messages,JSONL 写入 | 已 ready | 3(user+assistant+tool_result) | 是 | 已注册 | 未建立 | 1 | 3 |
| 步骤 15 结束 | agent loop 第 2 次迭代,第二次 `ai.stream()` 已完成 | 已 ready | 4(+final assistant) | 是 | 已注册 | closed | 0 | 4 |
| 步骤 16 结束 | TUI 渲染了最终回复文本 | 已 ready | 4 | 是 | 已注册 | closed | 0 | 4 |
| 步骤 17 结束 | agent loop 已退出,TUI 等待下一条输入 | 已 ready | 4 | 是 | 已释放 | 未建立 | 0 | 4 |

---

## 跨章引用提示

阅读 tour 步骤时,以下几个参考章节会被高频跳转,建议在浏览器或编辑器中同时打开:

- **[第 01 章 架构总览](./01-architecture-overview.md)**:四层架构图、CLI 引导链、AppMode 分支逻辑。tour-01、tour-02、tour-04 会密集引用。

- **[第 07 章 Coding Agent CLI 启动](./07-coding-agent-cli-startup.md)**:cli.ts/main.ts 详解、参数解析、AgentSessionRuntime 工厂模式、runTime 装配时序图。tour-01、tour-02、tour-03 的"分支与延伸"均指向此章。

- **[第 05 章 Agent Runtime 循环](./05-agent-runtime-loop.md)**:agent-core 的工具调用状态机、agentic loop 迭代逻辑。tour-08、tour-10、tour-14、tour-15 的核心参考。

- **[第 06 章 Agent Runtime 会话与 Compaction](./06-agent-runtime-sessions-compaction.md)**:AgentSession 生命周期、message 追加、JSONL 持久化。tour-06、tour-07、tour-14、tour-17 的参考。

- **[第 08 章 Coding Agent 工具系统](./08-coding-agent-tools.md)**:内置工具(read/write/edit/bash)定义、路径安全、调度逻辑。tour-12、tour-13 的核心参考。

- **[第 12 章 InteractiveMode 与 TUI 架构](./12-interactive-mode.md)**:TUI 渲染、键盘事件、差分更新。tour-04、tour-05、tour-11、tour-16 的参考。

- **[第 02 章 AI 层:多 Provider 抽象与模型注册表](./02-ai-layer-providers-registry.md)**:Provider 抽象、Anthropic 实现、stream 方法签名。tour-09 的参考。
