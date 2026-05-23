# Trace 步骤 02 —— `run` 子命令分派

## 1. 当前情境

上一步结束时，进程已经处于这样一个状态：

- Bun 解释器已经把 `packages/opencode/src/index.ts` 跑了一遍；
- yargs 的 `.middleware()` 副作用全部完成：`Log.init()` 已注册，`Heap.start()` 已挂钩，`process.env.OPENCODE / OPENCODE_PID` 已写入，首次启动迁移已完成（或检测到 `opencode.db` 已存在而跳过）；
- 25 个 `.command(...)` 已经全部注册到 yargs；
- yargs 根据 `process.argv` 路径匹配确定走 `RunCommand`，准备进入它的 builder。

可见的关键变量只有：

- `argv = ["run", "What's in README.md?"]`（未解析）。

session、provider、SQLite 连接、HTTP server、prompt——这些此刻都还不存在。

## 2. 问题

`RunCommand` 必须把"一行 shell 命令"翻译成"一次完整的 agent 调用"，它具体要拍板下面这些事：

1. **解析 argv**：把 `message` 位置参数、`--continue / --session / --fork / --interactive / --attach / --command / --format / --agent / --model / --file / --variant / --dir / --port / --thinking / --replay / --dangerously-skip-permissions / --demo` 这一长串 yargs option 全部拿出来；
2. **决定运行模式**：非交互流式（默认）/ 本地交互（`--interactive`）/ 远端 attach（`--interactive --attach <url>`）三选一——每种模式后续的事件源、stdin 处理、退出条件都不一样；
3. **解决 stdin pipe**：如果 stdin 不是 tty，要把 piped 内容读出来，跟 argv 里的 message 拼起来——`echo "..." | opencode run "..."` 这种用法必须支持；
4. **决定 cwd**：`--dir` flag 可能改 `process.cwd()`，并且要保证后续所有相对路径解析都基于这个新 cwd；
5. **装配 SDK 客户端**：handler 后续所有"业务调用"——创建 session、提交 prompt、订阅事件——都不能直接调内部模块；它必须经由 `@opencode-ai/sdk/v2` 的 `OpencodeClient`；
6. **管理 instance lifecycle**：项目配置、插件、LSP、文件监听等子系统都绑在一个 `InstanceContext` 上；handler 退出时必须把它 dispose 掉，否则 LSP 子进程会留下来。

`run` 干的事比看起来要重：它既是终端 UI 又是控制平面客户端。

## 3. 朴素思路

凭直觉，handler 大概会被写成这样：

```ts
export const RunCommand = {
  command: "run <message>",
  handler: async (args) => {
    const config = await loadConfig()
    const provider = await pickProvider(config, args.model)
    const session = await Session.create({ directory: process.cwd() })
    const reply = await provider.chat([{ role: "user", content: args.message }])
    process.stdout.write(reply.text)
  },
}
```

也就是说：handler 自己组装所有的依赖，自己调用 `Session.create`、自己跑 LLM、自己负责打印。每个子命令都这么写一份。

## 4. 为什么朴素思路会崩

朴素思路在 opencode 的实际场景下至少有四个落地难题：

- **opencode 同时是 CLI 和 server**：`opencode serve` / `opencode tui` / `opencode run` 全部对接同一份业务能力（Session、Message、Permission、Event、Share）。如果 `run` 自己组装一遍业务调用，TUI 就要再组装一遍，serve 也要再组装一遍——同一段"创建 session"代码会出现 N 份。
- **事件订阅必须流式**：用户 `opencode run "..."` 期望看到流式输出，包括工具开始/结束、reasoning、文本增量。这些事件天生是从 server side 推过来的——朴素的 `await provider.chat(...)` 拿到一个 string 是不够的。
- **`--attach <url>` 要求"内外同形"**：`run --attach http://192.168.1.5:4096` 让你连一台远端 opencode 实例。如果 handler 直接调 `Session.create`，attach 模式就没办法 reuse 任何代码；handler 要写两套：本地 vs 远程。
- **资源回收得自动**：handler 退出之前要把 LSP、文件监听、FileWatcher、Snapshot 等子系统全 dispose 掉。手写 `try/finally` 极易漏。

opencode 选了一条更彻底的路：**让 CLI 也走 SDK**。

## 5. opencode 的做法

`run.ts` 的最终形态是这样：

```text
RunCommand = effectCmd({
  command: "run [message..]",
  describe: "run opencode with a message",
  instance:  (args) => !args.attach,             ← 是否需要 InstanceContext
  directory: (args) => /* 决定 cwd */,
  builder:   (yargs) => yargs.positional(...).option(...) ...,
  handler:   Effect.fn("Cli.run")(function* (args) {
    // 1. 解析 / 校验 args
    // 2. 解出 message（可能拼上 stdin pipe）
    // 3. 起一个 fetch(...) 函数，路由到 Server.Default().app.fetch
    // 4. createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn })
    // 5. 进入 execute(sdk)：sdk.session.create + sdk.session.prompt + sdk.event.subscribe
  }),
})
```

关键设计有三：

### 5.1 `effectCmd` 把 yargs handler 包成 Effect

`packages/opencode/src/cli/effect-cmd.ts:70-94` 把一个 yargs `CommandModule` 包成 Effect 化的形态：handler body 在 `AppRuntime.runPromise` 下跑，可以 yield 任何 `AppServices`（Config / Provider / Session / Tool / ...）。`instance` 字段决定要不要顺手加载 `InstanceContext`——`true`（默认）会先 `InstanceStore.load({ directory })`，在 `try/finally` 里负责 `store.dispose(ctx)`；`false` 跳过整个 InstanceBootstrap，省下加载 plugin / LSP / 文件监听的开销。

`RunCommand` 设的是 `instance: (args) => !args.attach`——只有连远端 server 时才不需要本地实例；否则 effectCmd 会自动加载并销毁。

### 5.2 in-process HTTP server + SDK 客户端

handler 最末尾这段是整个分派的核心（`packages/opencode/src/cli/cmd/run.ts:869-879`）：

```ts
const fetchFn = (async (input, init) => {
  const { Server } = await import("@/server/server")
  const request = new Request(input, init)
  return Server.Default().app.fetch(request)
}) as typeof globalThis.fetch

const sdk = createOpencodeClient({
  baseUrl: "http://opencode.internal",
  fetch: fetchFn,
  directory,
})
await execute(sdk)
```

注意这里发生了什么——`baseUrl` 是一个**字符串占位 URL**，因为 `fetchFn` 把请求直接路由到 `Server.Default().app.fetch(request)`，**没有任何 HTTP socket 打开**。SDK 生成的请求对象被本地 handler 消费，回包再被 SDK 解码。这就让 `opencode run` 内部跟 `opencode serve + 远端 client` 形态完全对齐：

- 本地非 attach：`fetch` 是函数指针 `Server.Default().app.fetch`；
- attach 远端：`fetch` 是 `globalThis.fetch`，请求经 TCP 飞向 `args.attach`；
- 业务代码（`execute()`）拿到的都是 `OpencodeClient`——同一个接口。

### 5.3 stdin pipe 与 message 合并

`packages/opencode/src/cli/cmd/run/runtime.stdin.ts` 提供两个东西：`INTERACTIVE_INPUT_ERROR` 常量和 `resolveInteractiveStdin()` helper。后者用于交互模式下，当 `process.stdin` 不是 tty（比如被 piped），它会尝试 `open("/dev/tty")` 或 win32 `CONIN$` 把控制权重新拿回来；如果连 `/dev/tty` 都打不开（无 TTY 环境），就抛 `INTERACTIVE_INPUT_ERROR`。

非交互模式更直接：`packages/opencode/src/cli/cmd/run.ts:356-357` 做两件事——

```ts
const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
message = resolveRunInput(message, piped) ?? ""
```

`resolveRunInput()` 在 `run.ts:43-53`，规则是：argv message 在前，pipe 内容在后，中间换行。这样 `echo "extra context" | opencode run "summarize this"` 实际跑出来的 prompt 是：

```
summarize this
extra context
```

为什么 message 在前？因为它通常是"指令"，pipe 内容是"被处理的对象"——指令先于对象更符合自然语言。

### 5.4 三种模式的最终路由

`run.ts:832-879` 是三个 if-else 分支：

| 条件 | 落脚 |
|------|------|
| `args.interactive && !args.attach && !args.session && !args.continue` | `runInteractiveLocalMode(...)`（split-footer 直连本地 in-process server） |
| `args.attach` | `attachSDK(directory)` + `execute(sdk)`（HTTP 客户端飞远端） |
| 其他（默认非交互） | in-process `fetchFn` + `createOpencodeClient` + `execute(sdk)` |

对于我们 trace 的 `opencode run "What's in README.md?"`——没有任何 flag，走最后一条。

## 6. 代码位置

按阅读顺序：

- `packages/opencode/src/cli/cmd/run.ts:1-30` —— 文件顶部 doc comment、import；
- `packages/opencode/src/cli/cmd/run.ts:31` —— `const runtimeTask = import("./run/runtime")`，**延迟 import** 交互模式 runtime（避免非交互场景加载大型 React tree）；
- `packages/opencode/src/cli/cmd/run.ts:32-41` —— `pick(value)` helper：把 `--model "anthropic/claude-sonnet-4-5"` 拆成 `{ providerID, modelID }`；
- `packages/opencode/src/cli/cmd/run.ts:43-53` —— `resolveRunInput()`：argv + pipe 合并；
- `packages/opencode/src/cli/cmd/run.ts:127-135` —— `RunCommand = effectCmd({...})` 的 5 个元字段：`command / describe / instance / directory / builder / handler`；
- `packages/opencode/src/cli/cmd/run.ts:136-245` —— `builder`：完整的 option 声明；
- `packages/opencode/src/cli/cmd/run.ts:246-263` —— handler 入口：`yield* Agent.Service`、`yield* RuntimeFlags.Service`、`yield* InstanceRef` 拿到三个 effect service；
- `packages/opencode/src/cli/cmd/run.ts:265-308` —— flag 互斥校验（`--interactive` ⊥ `--command`、`--demo` 要求 `--interactive`、`--replay` 要求 `--interactive`...）；
- `packages/opencode/src/cli/cmd/run.ts:310-333` —— `cwd` 决定：`process.env.PWD` 优先，遇 `--dir` 调 `process.chdir`；attach 模式下 `--dir` 是远端目录字符串；
- `packages/opencode/src/cli/cmd/run.ts:334-368` —— `--file` 解析（构造 `FilePart`）、stdin pipe 读入、message 空校验；
- `packages/opencode/src/cli/cmd/run.ts:370-388` —— 非交互模式的 `Permission.Ruleset`：默认 deny `question / plan_enter / plan_exit` 三个 permission——交互式才允许这些；
- `packages/opencode/src/cli/cmd/run.ts:396-473` —— `session(sdk)`：返回 session 信息，支持 `--session`/`--continue`/`--fork` 与新建；
- `packages/opencode/src/cli/cmd/run.ts:610-830` —— `execute(sdk)` 主体：调 `sdk.session.prompt` 或 `sdk.session.command`，并跑 `loop(client, events)` 消费 SSE；
- `packages/opencode/src/cli/cmd/run.ts:832-879` —— 顶层三个 if-else 路由，落到对应入口；
- `packages/opencode/src/cli/effect-cmd.ts:14-19` —— `CliError`、`fail(msg)` helper；
- `packages/opencode/src/cli/effect-cmd.ts:70-94` —— `effectCmd()` 工厂；
- `packages/opencode/src/cli/cmd/run/runtime.stdin.ts:11-37` —— `resolveInteractiveStdin()`。

## 7. 分支与延伸

- **25 个子命令的角色映射**：本步只展开了 `RunCommand`；全表见 [第 01 章 §1.4 子命令地图](01-entrypoints.md#14-子命令地图)。
- **run 子命令的事件循环**：第 15 步会展开 `execute()` 里的 `loop()`，它消费 `client.event.subscribe()` 流，是用户看到流式输出的源头。已有的[第 01 章 §1.6 run 子命令深挖](01-entrypoints.md#16-run-子命令深挖)对它做了一份独立俯瞰。
- **in-process server 的诡异点**：为什么 `run` 不直接调 `Session.create` 而要走一遍 HTTP 抽象？见[第 01 章 §1.6.4 进程内嵌 server 的诡异点](01-entrypoints.md#164-进程内嵌-server-的诡异点)；下一步（第 03 步）会顺着这条线进入 server 启动；第 10 章会把整个 server 拓扑画出来。
- **`effectCmd` 与 Effect runtime**：本质上是把 yargs handler 嫁接到 `AppRuntime`，让 handler 可以 yield 任何 `AppServices`。看明白这一点之后，所有其他子命令（`ServeCommand`、`McpCommand`、`AgentCommand` ...）就是同模板的填空题。
- **`--attach` 远端模式**：完整流程见[第 01 章 §1.9 attach：连远端 server 跑 TUI](01-entrypoints.md#19-attach连远端-server-跑-tui)——它在 `run` 也复用。

## 8. 走完这一步你脑子里应该多了什么

1. **`RunCommand` 是个 yargs `CommandModule`，但 handler body 被 `effectCmd` 包成 Effect**——所以它可以 yield 任何 AppServices，并自动在退出时 dispose 项目实例。这是 opencode 命令体的统一模板。
2. **`run` 不直接调业务模块**——它启动一个 in-process opencode server，再用 `@opencode-ai/sdk/v2` 客户端跟自己说话。`fetchFn` 这个函数把 SDK 的 HTTP 调用短路成函数调用，没有真正的 socket。这让 `run` / `tui` / `attach` / `serve` 共用一份业务层。
3. **stdin pipe 与 argv message 通过 `resolveRunInput()` 合并**——message 在前、pipe 在后；交互模式则用 `resolveInteractiveStdin()` 重新打开 `/dev/tty`。
4. **`instance: (args) => !args.attach`**——`attach` 模式跳过本地 InstanceBootstrap，省下 plugin/LSP/文件监听加载；本地模式默认全套加载，handler 退出时 effectCmd 自动 dispose。
5. **走完这一步**：`prompt = "What's in README.md?"`、`directory = process.cwd()`、`files = []`、`agent = undefined`、`model = undefined`、`format = "default"` 都已确定；handler 即将调用 `Server.Default()` 触发 in-process server 的延迟初始化——这就是下一步的舞台。

下一步：[Trace 步骤 03 —— 加载配置与鉴权](tour-03-config-load.md)
