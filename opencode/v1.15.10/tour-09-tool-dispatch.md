# Trace 步骤 09 —— 查表分派 `read` 工具

## 1. 当前情境

第 08 步走完，协议层吐出了一条干净的 `LLMEvent` 流。其中 text 部分已经流到 stdout（`Let me read README.md...`），流到 `tool-call` 这条事件时数据是：

```ts
{
  type: "tool-call",
  id: "toolu_01H7…",
  name: "read",
  input: { filePath: "README.md" }   // 已 parse 成对象
}
```

会话状态：
- `ctx.assistantMessage` 已经写下一个 text Part；
- `ctx.toolcalls["toolu_01H7…"]` 在 `tool-input-start` 时建好了占位（`pending` 状态）；
- `prepared.tools["read"]` 是之前 `SessionTools.resolve(...)` 时已经包好的 AI-SDK `Tool` 对象，里面挂着 `execute(args, opts)` handler 和 `inputSchema` JSON Schema；
- LLM 还在 SSE 长连接的另一头，但目前 `finishReason="tool-calls"`，等待我们执行完再回灌结果。

模型说了"我要 read README.md"。现在 opencode 要做的是：**找到 `read` 这个工具对象，验证 `{filePath: "README.md"}` 真的合法**。这是 trace 第一次从"流处理"切换到"工具运行"。

## 2. 问题

把模型说的工具名转成实际可执行的工具对象——表面上是一个哈希表查找。但要做对，几件事都得办：

1. **找到 tool 对象**：注册表里二十来个内置工具 + 用户自定义 + plugin tool + MCP tool，要按 id 精确命中。
2. **校验 args**：LLM 偶尔会写错——字段名拼错（`file_path` vs `filePath`）、类型错（offset 给字符串）、漏必填、多塞字段。把脏 args 直接送给 `fs.readFile()` 要么报一个非常隐晦的 Node 错误，要么悄悄读了不该读的路径。
3. **预备一个 `Tool.Context`**：handler 需要知道 sessionID、messageID、callID、当前 agent、消息历史、`abort` 信号、`metadata`/`ask` 这两个回调入口。这些数据散落在 session / processor / permission 各处，要在一处装配好。
4. **错误要可回灌**：如果 args 校验失败，我们**不能**直接抛出杀死整个回合——更优雅的做法是把错误格式化成"给模型看的纠正提示"，回灌成 `tool-result` 让模型自己改正再调一次。

## 3. 朴素思路

最直白的实现：

```ts
const toolName = event.name
const args = event.input
const tool = REGISTRY[toolName]
if (!tool) return { error: "unknown tool" }
const result = await tool.handler(args)
```

如果再细一点，加个 Zod 校验：

```ts
const parsed = tool.schema.parse(args)
const result = await tool.handler(parsed)
```

看起来已经覆盖了主要风险——找不到工具、args 不合法都会被挡住。

## 4. 为什么朴素思路会崩

- **运行时上下文从哪来？** `read` 工具要知道 cwd、要 `lsp.touchFile(filepath)`、要 `assertExternalDirectoryEffect(ctx, ...)` 检查路径是否在 workspace 外、要 `ctx.ask({permission: "read", patterns: [...]})` 触发权限询问。这些事都依赖一个完整的 `Tool.Context`——朴素 `tool.handler(args)` 把 ctx 给丢了，工具会立即崩。
- **Zod.parse 抛错的信息对模型没意义**。`ZodError` 序列化出来是一堆 path/issue 数组，模型读完一脸懵——下次 retry 还是错。需要一个**面向模型**的纠正提示，告诉它"这里期望的 schema 是 X，你的输入哪个字段错了，请改写"。
- **opencode 同时支持三种工具定义来源**：(a) `Tool.define` 内置（Effect Schema），(b) 用户 plugin tool / 仓库 `tools/*.ts`（Zod schema），(c) MCP server 暴露的工具（JSON Schema）。三套 schema 体系的校验入口要统一。
- **AI SDK 路径已经预解析**：默认运行时是 AI SDK，它在喂给 handler 之前**已经按 jsonSchema 校验过一次**——如果失败它会走 `experimental_repairToolCall` 自修复（`session/llm.ts:278-298`，比如把 `Read` 大小写改正成 `read`）。这种"两层防御"必须知道。
- **同样的 toolCall 可能并发**：`task` 工具会派生 subagent，subagent 也会调工具；compaction 工具可能跟主 stream 同时跑。每个工具调用要有自己的 `callID`、自己的 abort signal。

## 5. opencode 的做法

opencode 把这一步分成**两层**：

**第一层：`SessionTools.resolve()`（一次性装配）**。在每次 LLM 调用**之前**，session 层从 `ToolRegistry` 拉出当前 agent 可用的所有工具，给每个工具包一层 AI-SDK 兼容的 `tool({inputSchema, execute})`，把 sessionID / messageID / abort / ask / metadata 这些"per-call 但每次调用都一样"的东西通过闭包绑进 `execute`。装配出来的 `prepared.tools: Record<string, AITool>` 直接交给 `streamText({tools, …})`。

```ts
// packages/opencode/src/session/tools.ts:42-73 节选
const context = (args, options): Tool.Context => ({
  sessionID: input.session.id,
  abort: options.abortSignal!,
  messageID: input.processor.message.id,
  callID: options.toolCallId,
  agent: input.agent.name,
  messages: input.messages,
  metadata: (val) => input.processor.updateToolCall(options.toolCallId, ...),
  ask: (req) => permission.ask({ ...req, ruleset: Permission.merge(...) }),
})

for (const item of yield* registry.tools({...})) {
  tools[item.id] = tool({
    description: item.description,
    inputSchema: jsonSchema(schema),
    execute(args, options) {
      return run.promise(Effect.gen(function* () {
        const ctx = context(args, options)
        yield* plugin.trigger("tool.execute.before", ...)
        const result = yield* item.execute(args, ctx)   // ← 真正调用 ReadTool.execute
        yield* plugin.trigger("tool.execute.after", ...)
        return result
      }))
    },
  })
}
```

**第二层：`Tool.define` 的 wrapper（每次调用时的 Zod/Effect Schema 校验）**。`packages/opencode/src/tool/tool.ts:97-147` 的 `wrap()` 函数在 `Tool.define` 注册时给每个 tool 的 `execute` 套了一层装饰器：

```ts
// tool.ts:104-145 节选
return Effect.gen(function* () {
  const toolInfo = ...
  const decode = Schema.decodeUnknownEffect(toolInfo.parameters)   // 闭包外只编译一次
  const execute = toolInfo.execute
  toolInfo.execute = (args, ctx) =>
    Effect.gen(function* () {
      const decoded = yield* decode(args).pipe(
        Effect.mapError(
          (error) =>
            new InvalidArgumentsError({
              tool: id,
              detail: toolInfo.formatValidationError
                ? toolInfo.formatValidationError(error)
                : String(error),
            }),
        ),
      )
      const result = yield* execute(decoded, ctx)
      // ... 接下来还会跑 truncate
    })
})
```

几个关键设计：

- **`Schema.decodeUnknownEffect` 在闭包外编译一次**（`tool.ts:109`）。AI SDK 路径下，AI SDK 自己已经按 jsonSchema 校过一遍；这里再用 Effect Schema 校的好处是**类型安全的 decoded 对象**（`Schema.Schema.Type<Parameters>`）能直接喂给 handler。
- **失败时抛 `InvalidArgumentsError`**（`tool.ts:22-32`）。这个 typed error 的 `message` getter 拼出"The read tool was called with invalid arguments: …\nPlease rewrite the input so it satisfies the expected schema."——直接面向模型的纠正提示。后续 trace 步骤里这条 message 会回灌成 `tool-result`，模型读完就会自己重试。
- **`Schema.Decoder` 而不是固定 Zod**：opencode 内置工具用 Effect Schema（`packages/opencode/src/tool/read.ts:29-37` 的 `Parameters`），plugin tool 是 Zod，MCP tool 是 JSON Schema——三套都被注册表统一适配成 `Schema.Decoder<unknown>`：
  - 内置工具直接用 Effect Schema；
  - plugin 工具走 `registry.ts:155-156` 的 `Schema.declare<unknown>((u): u is unknown => zodParams.safeParse(u).success)`——把 Zod 套进一个最薄的 Effect Schema 适配器；
  - MCP 工具通过 `mcp.tools()` 返回 AI SDK 原生 `Tool`，校验在 AI SDK 层做。

对本 trace 的 `read` 工具来说：

1. `read` 的 `Parameters` schema 在 `tool/read.ts:29-37`，要求 `filePath: string`，可选 `offset/limit: NonNegativeInt`。
2. LLM 给的 `input = {filePath: "README.md"}` 是合法的。
3. `Schema.decodeUnknownEffect` 走过，`decoded` 等于 `{filePath: "README.md"}`（Effect Schema 是结构性校验，多余字段会被剔除，缺少字段或类型错会失败）。
4. wrapper 接着调真实的 `run` handler（`tool/read.ts:200-280`），但 handler 第一行还没碰文件——它要先做权限询问。这就是第 10 步要做的事。

为什么 args 校验放在工具 wrapper 里、而不是 session 调度处？因为**工具是知识所有者**——只有 `read` 自己知道 `filePath` 是必填、`offset` 是 NonNegativeInt。调度处只负责"找到 tool 对象、给 ctx、调 execute"，校验责任下沉给工具自己。这也意味着想加新工具时，作者只要写 schema，不需要去 session 层登记任何东西。

`SessionTools.resolve` 的另一个职责是**过滤**——`registry.tools(...)` 入参带了 `{providerID, modelID, agent}`，过滤逻辑在 `registry.ts:322-334`：GPT-5 系列默认走 `apply_patch` 而非 `edit/write`；非 opencode/Exa/Parallel provider 关掉 web search；按 agent.permission 把 deny 掉的工具去掉。所以 LLM 看到的工具列表和 `prepared.tools` 是同一份。

## 6. 代码位置

按调用顺序：

- `packages/opencode/src/session/tools.ts:24-116` —— `SessionTools.resolve`：每次回合开始前装配 `prepared.tools`。`:42-73` 是 `Tool.Context` 工厂，`:75-116` 是按 registry 列表包成 AI SDK `Tool`。
- `packages/opencode/src/tool/registry.ts:75-82` —— `ToolRegistry` Service 接口（`ids` / `all` / `named` / `tools`）。
- `packages/opencode/src/tool/registry.ts:229-275` —— `Effect.all` 把 18 个内置工具一次性 init；`:251-275` 决定 `builtin` 数组的顺序（这个顺序最终决定 LLM 看到的工具列表顺序）。
- `packages/opencode/src/tool/registry.ts:322-367` —— `tools(input)`：按 model/agent 过滤，并跑 `plugin.trigger("tool.definition", ...)` 让插件 override description/schema。
- `packages/opencode/src/tool/registry.ts:145-201` —— `fromPlugin`：把 plugin tool 的 Zod schema 包成 `Schema.declare<unknown>`，让校验入口统一到 `Schema.decodeUnknownEffect`。
- `packages/opencode/src/tool/tool.ts:34-44` —— `Tool.Context` 类型：sessionID、messageID、agent、abort、ask、metadata、messages 等所有 handler 需要的字段。
- `packages/opencode/src/tool/tool.ts:53-67` —— `Tool.Def` 接口：`id` + `description` + `parameters`（Schema.Decoder）+ `jsonSchema` + `execute` + `formatValidationError`。
- `packages/opencode/src/tool/tool.ts:97-147` —— `wrap()`：给每个工具的 `execute` 套上 schema 校验 + truncate + telemetry。`:109` 编译 decoder；`:118-127` 是 Zod/Effect Schema 校验入口；`:122-126` 构造 `InvalidArgumentsError`。
- `packages/opencode/src/tool/tool.ts:22-32` —— `InvalidArgumentsError`：args 校验失败时给模型看的 prose。
- `packages/opencode/src/tool/tool.ts:149-167` —— `Tool.define(id, init)`：所有内置工具的注册入口（`Tool.define("read", Effect.gen(function*() {...}))`）。
- `packages/opencode/src/tool/read.ts:1-37` —— `ReadTool` 头部：常量、`Parameters` schema（`filePath` + 可选 `offset/limit`）。
- `packages/opencode/src/tool/read.ts:39-72` —— `Tool.define("read", ...)`：注入 `AppFileSystem` / `LSP` / `Instruction` / `Reference` 服务的 Effect 闭包；定义 `miss` / `list` / `warm` 等辅助。
- `packages/opencode/src/tool/read.ts:200-232` —— `run` handler 入口：参数解构、path 标准化、`reference.ensure`、stat 探测；权限询问在 `:227-232`。本步骤拿到 `decoded` 后下一步要进的就是这里。
- `packages/opencode/src/tool/schema.ts:1-14` —— `ToolID` newtype（"tool_…" 前缀）：当工具结果作为 Part 落盘时用的 id 类型。
- `packages/llm/src/tool-runtime.ts:280-317` —— native runtime 路径下的对偶实现：`dispatch` 按 `call.name` 查表，`decodeAndExecute` 做 schema 校验 + handler + 编码回流，失败包 `ToolFailure`（行为等价 `InvalidArgumentsError`）。
- `packages/opencode/src/session/llm.ts:278-298` —— `experimental_repairToolCall`：AI SDK 调度前的最后一道补救——大小写错改成全小写、其他校验失败包成 `invalid` 工具调用让模型自己看到错误。

## 7. 分支与延伸

- **工具注册表全图**：见 [第 07 章 §工具注册表](07-tool-system.md#工具注册表) / [§内置工具一览](07-tool-system.md#内置工具一览) / [§Execution Pipeline](07-tool-system.md#execution-pipeline从-tool_call-到-toolresult)。
- **Tool runtime 抽象**：参考 [第 06 章 §Tool runtime](06-llm-providers.md#tool-runtime)。native 路径下整个分派/校验/执行在 `packages/llm/tool-runtime.ts` 里，是本步骤的 mirror 实现。
- **`task` 工具的特殊性**：`task` 派 subagent，会复用本步骤的全套机制但跑在另一个 session 里——见 [第 04 章 §Subagent permissions](04-agents.md#agent-数据结构)。
- **MCP 工具的差异**：MCP tool 的 schema 是 JSON Schema、`execute` 是 IPC 调用、权限询问要走 `ctx.ask({permission: key, patterns: ["*"], always: ["*"]})`——见 `session/tools.ts:118-203`。
- **插件 tool 的 Zod 适配**：`registry.ts:145-201` 的 `fromPlugin` 把 Zod 套进 `Schema.declare<unknown>` 适配器；JSON Schema 生成在 `:428-461`。

## 8. 走完这一步你脑子里应该多了什么

1. **opencode 把"分派 + 校验"分成两段**：注册表 + `SessionTools.resolve` 负责装配（一次性），`Tool.define` 的 wrapper 负责每次调用的 schema 校验和上下文注入。
2. **`InvalidArgumentsError` 不是异常——它是给模型的纠错信号**。失败 message 会以 `tool-result` 回灌，模型读完会自己改写 args 重试。这是 "LLM agent 容错" 的关键技巧之一。
3. **`Schema.decodeUnknownEffect` 在 `wrap()` 闭包外只编译一次**——这种"先编译 once、再到处复用"的模式在 hot path（每个 tool 调用都跑）上能省下可观的时间和 GC。
4. **三套 schema（Effect / Zod / JSON Schema）统一到 `Schema.Decoder<unknown>` 这个内部抽象**——这让注册表只需要管一种"工具长什么样"。
5. **`Tool.Context` 是工具看到世界的窗户**——所有 per-call 数据从这里来。看一个工具能干什么，先看它在 ctx 上调了什么字段（`ctx.ask`/`ctx.metadata`/`ctx.messages`/`ctx.extra`）。
6. **走完这一步**：`tool` 引用已经指向 `ReadTool.execute`，`decoded.filePath === "README.md"`。下一步要进的是 `read` handler 内部、还没碰 fs 之前的那一行——`ctx.ask({permission: "read", patterns: [...]})`。

下一步：[Trace 步骤 10 —— 权限评估](tour-10-permission-check.md)
