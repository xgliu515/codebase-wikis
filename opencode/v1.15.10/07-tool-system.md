# 第 07 章：工具系统

> 代码版本：`anomalyco/opencode@d74d166a`（tag `v1.15.10`，2026-05-23）。
>
> 本章涉及目录：`packages/opencode/src/tool/`、`packages/opencode/src/session/tools.ts`。

## 7.1 工具：从 LLM 到 opencode 的两端视角

在一个 AI Agent 系统里，"工具"是一个有两副面孔的东西。

- **从 LLM 视角**，工具是一段 JSON Schema：一个名字 + 一段自然语言描述 + 一份参数 schema。Provider（Anthropic、OpenAI、…）把这段 schema 塞进模型的请求里，模型在某次生成时决定"我要调 `read` 工具，参数是 `{"filePath": "/x/y.ts"}`"，并把这段 JSON 嵌在响应里返回。
- **从 opencode 视角**，工具是一个本地对象：`{ id, description, parameters: <Schema>, jsonSchema?, execute(args, ctx) }`。`execute` 是一个 Effect，它真正去读文件、跑 shell、问用户、把结果序列化成字符串。

opencode 把两端粘起来的地方有两个：
- `packages/opencode/src/tool/tool.ts` 定义"opencode 端的工具"是什么样子。
- `packages/opencode/src/session/tools.ts` 把 opencode 工具翻译成 Vercel AI SDK 的 `Tool`，灌进模型请求里——见 `session/tools.ts:75-115`。

下面先看本地这一端的接口。

### 7.1.1 `Tool.Def` 与 `Tool.Context`

`packages/opencode/src/tool/tool.ts:46-63` 给出工具的核心类型：

```ts
export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
}

export interface Def<Parameters extends Schema.Decoder<unknown>, M extends Metadata = Metadata> {
  id: string
  description: string
  parameters: Parameters
  jsonSchema?: JSONSchema7
  execute(args: Schema.Schema.Type<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>>
  formatValidationError?(error: unknown): string
}
```

每个工具暴露的就是这五样东西：

- `id` —— 工具名，例如 `"read"`、`"bash"`、`"edit"`。这同时也是发给 LLM 的工具名，以及权限系统里的 permission key。
- `description` —— 给 LLM 看的自然语言说明，通常从同名 `.txt` 文件读出来（见 7.4 节）。
- `parameters` —— Effect Schema，用来对 LLM 返回的 JSON 做解码 + 校验。
- `jsonSchema` —— 可选的预先生成的 JSON Schema；若不给，由 `tool/json-schema.ts` 从 `parameters` 派生。
- `execute(args, ctx)` —— 真正干活。返回 `{ title, output, metadata, attachments? }`。

`ctx` 即 `Tool.Context`，定义在 `tool/tool.ts:34-44`：

```ts
export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  messages: MessageV2.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  ask(input: Omit<Permission.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>
}
```

注意三个能力：

1. `abort: AbortSignal` —— 用户在 TUI 里按 `Ctrl-C`、或者 session 被取消时，会触发这个信号，工具有义务在此时尽快收尾（典型用法见 `tool/shell.ts:533-538`）。
2. `metadata(...)` —— 工具运行中可以**流式**把"进行中"的状态（标题、当前输出快照）回传给 session processor。bash 工具每读到一段 stdout 就调一次（`tool/shell.ts:524-529`），TUI 因此能看到滚动的命令输出。
3. `ask(req)` —— 触发权限询问。工具不直接判断"能不能干"，而是声明"我现在要干 X，请检查"，交给权限系统。详见第 08 章。

### 7.1.2 `Tool.define` 构造器

`tool/tool.ts:149-167` 提供 `define(id, initEffect)`：

```ts
export function define<...>(id: ID, init: Effect.Effect<Init<Parameters, Result>, never, R>) {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* init
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      return { id, init: wrap(id, resolved, truncate, agents) }
    }),
    { id },
  )
}
```

这一层除了把构造延迟到运行时（很多工具构造时需要 LSP / Bus / FileSystem 等服务），还做了一件关键事情：在 `wrap()`（`tool/tool.ts:97-147`）里把每个 `execute` 包裹一层，统一处理两件事：

- **参数校验**：用 `Schema.decodeUnknownEffect(parameters)` 对 LLM 给的 JSON 做解码，失败时抛 `InvalidArgumentsError`（`tool/tool.ts:22-32`），消息回灌给模型让它"重写参数"。
- **输出截断**：如果工具自己没有给 `metadata.truncated`，统一调 `truncate.output(...)` 截到 50KB / 2000 行（见 7.6 节）。

所以工具作者只关心"我做什么"，不需要管"出错怎么告诉模型"和"输出太长怎么办"。

### 7.1.3 一个最小工具的样子

以最简单的 `invalid` 工具为例（`tool/invalid.ts`，21 行）：

```ts
export const InvalidTool = Tool.define(
  "invalid",
  Effect.succeed({
    description: "Do not use",
    parameters: Parameters,
    execute: (params: { tool: string; error: string }) =>
      Effect.succeed({
        title: "Invalid Tool",
        output: `The arguments provided to the tool are invalid: ${params.error}`,
        metadata: {},
      }),
  }),
)
```

它的存在是为了占据"工具名不在已知列表里"这种异常路径，使 session processor 在面对未知 tool_call 时也有一个合法返回。

---

## 7.2 工具注册表

`packages/opencode/src/tool/registry.ts`（481 行）把所有工具收拢成一个 `ToolRegistry` 服务。`Service` 接口（`registry.ts:75-80`）：

```ts
export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: { providerID; modelID; agent }) => Effect.Effect<Tool.Def[]>
}
```

四个方法承担不同职责：

- `ids()` / `all()` —— 列出全部已注册工具（内置 + 自定义）。
- `named()` —— 拿出几个"被框架本身引用"的特殊工具（目前是 `task` 和 `read`）。
- `tools(model)` —— **针对一次具体请求**返回工具列表，会按 provider / model / agent 做过滤。这是 session processor 真正消费的接口。

注册表的初始化发生在 `registry.ts:141-277` 的 `InstanceState.make<State>` 里。流程大致是：

```text
                  ┌─────────────────────────────┐
                  │ ToolRegistry layer Effect   │
                  └──────────────┬──────────────┘
                                 │
              ┌──────────────────┴───────────────────┐
              ▼                                      ▼
     yield* ShellTool, ReadTool, …          plugin.list() / dirs.flatMap
     (内置 18 个工具 init Effects)            (扫描用户自定义工具)
              │                                      │
              └──────────────┬───────────────────────┘
                             ▼
                  Tool.init(...) → Def
                             │
                             ▼
                      state.builtin / state.custom
                             │
                             ▼
                  tools(model) 过滤 → AI SDK Tool 列表
```

### 7.2.1 内置工具列表

`registry.ts:229-275` 拼出 `state.builtin`：

```ts
const tool = yield* Effect.all({
  invalid, shell, read, glob, grep, edit, write,
  task, task_status, fetch, todo, search,
  repo_clone, repo_overview, skill, patch, question, lsp, plan,
})

return {
  custom,
  builtin: [
    tool.invalid,
    ...(questionEnabled ? [tool.question] : []),
    tool.shell, tool.read, tool.glob, tool.grep, tool.edit, tool.write,
    tool.task,
    ...(flags.experimentalBackgroundSubagents ? [tool.task_status] : []),
    tool.fetch, tool.todo, tool.search,
    ...(flags.experimentalScout ? [tool.repo_clone, tool.repo_overview] : []),
    tool.skill, tool.patch,
    ...(flags.experimentalLspTool ? [tool.lsp] : []),
    ...(flags.experimentalPlanMode && flags.client === "cli" ? [tool.plan] : []),
  ],
  task: tool.task,
  read: tool.read,
}
```

可以看到 `question` / `task_status` / `repo_clone` / `repo_overview` / `lsp` / `plan` 这几个都是由 `RuntimeFlags` 决定开关的——见 `effect/runtime-flags.ts`。常驻内置的是十几个核心工具。

### 7.2.2 自定义工具：插件 + `tools/*.ts`

`registry.ts:144-224` 还会从两个地方加载用户自定义工具：

- 配置中声明的目录下扫描 `{tool,tools}/*.{js,ts}`（`registry.ts:203-217`），每个文件 import 进来。
- 加载所有已注册的 `Plugin`（`registry.ts:219-224`），把 `plugin.tool` 字段里的 `ToolDefinition` 拿过来。

每个自定义工具走 `fromPlugin(id, def)`（`registry.ts:145-201`）做适配：

- 插件 `args` 字段还是基于 Zod 的（兼容老版本）；这里把 Zod 转 JSON Schema（`registry.ts:428-435`），生成 `Schema.declare<unknown>(...)` 这种"宽容"的 Effect Schema 作为 `parameters`。
- 把插件 `ask` 接口（Promise）通过 `EffectBridge` 桥接到 Effect 的 `ctx.ask`（`registry.ts:166-174`）。
- 复用同一套 truncate 逻辑。

### 7.2.3 按 agent / model 过滤

`tools(model)`（`registry.ts:322-367`）拿到 `all()` 后做了两件事：

1. **websearch 工具仅对支持的 provider 暴露**：`registry.ts:324`。
2. **edit/write vs apply_patch 互斥**：`registry.ts:328-331`——只有 GPT 系列模型用 `apply_patch`，其它模型用 `edit/write`。

```ts
const usePatch = input.modelID.includes("gpt-") &&
                 !input.modelID.includes("oss") &&
                 !input.modelID.includes("gpt-4")
if (tool.id === ApplyPatchTool.id) return usePatch
if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch
```

为什么？因为 GPT 训练数据里大量用了 `*** Begin Patch / *** End Patch` 这种统一 diff 格式，让它直接生成 patch 比让它用 `oldString/newString` 更准确。其它模型反过来。

3. **运行时让插件改 description / schema**：`registry.ts:345-347` 调 `plugin.trigger("tool.definition", ...)`，插件可以重写工具描述、参数 schema。这是 opencode 的核心可扩展点之一。

4. **`task` / `skill` 工具的描述要列出可用项**：`registry.ts:288-320` 给 `task` 工具的 description 附加"可用 subagent 列表"，给 `skill` 工具附加"可用 skill 列表"，让 LLM 知道有哪些 subagent / skill 可调。

注意 `describeTask`（`registry.ts:307-320`）会用 `Permission.evaluate("task", item.name, agent.permission)` 过滤掉**被当前 agent 禁用的 subagent**——一个 `review` agent 不希望让 LLM "看到"自己其实可以调用 `build` agent。

---

## 7.3 内置工具一览

下面按用途归类，每个工具给出关键文件、参数 schema、和它要触发的 permission key。

### 7.3.1 文件读取与搜索

**`read`**（`tool/read.ts`，341 行）—— 读文件或目录。

参数（`tool/read.ts:29-37`）：`filePath`、`offset`（行号，1-based）、`limit`（默认 2000 行）。
行为：
- 行被 cap 在 2000 字符；总输出 cap 在 50KB（`MAX_BYTES = 50 * 1024`，`read.ts:18`）。
- 触发 `permission: "read"`，pattern 是相对 worktree 的路径；`always: ["*"]` 表示用户选"以后都允许"时直接放行所有读。
- 如果文件是图片 / PDF，作为 `attachment` 返回 base64 内容。
- 启动 LSP `touchFile` 预热（`read.ts:89-91`），后续 `edit` 工具的 diagnostics 可以立刻拿到。
- 二进制文件检测：非可打印字符占比 > 30% 拒绝（`read.ts:188-198`）。

**`grep`**（`tool/grep.ts`，156 行）—— 调 ripgrep 搜内容。

参数：`pattern`（regex）、`path`（默认 cwd）、`include`（glob）。
- 调 `Ripgrep.Service.search`（`file/ripgrep.ts`）。
- 结果按 mtime 降序排，cap 100 条（`grep.ts:113-117`）。
- 触发 `permission: "grep"`。

**`glob`**（`tool/glob.ts`，103 行）—— 模式匹配文件名。

参数：`pattern`、`path`。`rg.files({ cwd, glob: [pattern] })` 是底层；按 mtime 降序，cap 100 文件。

### 7.3.2 文件修改

**`edit`**（`tool/edit.ts`，711 行）—— 串字符串替换。

参数（`tool/edit.ts:47-56`）：`filePath`、`oldString`、`newString`、`replaceAll?`。
- 触发 `permission: "edit"`。
- 内部串了 9 种 replacer（详见 7.8 节）。
- 自动跑 `Format.Service` 格式化文件（`edit.ts:108`）。
- 跑完调 LSP `touchFile` + `diagnostics`，把诊断信息附在输出末尾告诉 LLM"刚改完出现了什么错"。

**`write`**（`tool/write.ts`，104 行）—— 整文件覆盖写。

参数：`filePath`、`content`。和 `edit` 共用 `permission: "edit"`。一样会 format + LSP diagnostics。多了一个对"项目里其它文件的诊断"也最多报告 5 条的特性（`MAX_PROJECT_DIAGNOSTICS_FILES`，`write.ts:18`）。

**`apply_patch`**（`tool/apply_patch.ts`，313 行）—— 应用 OpenAI 风格的 `*** Begin Patch / *** Update File / *** End Patch` 统一 diff。

参数：`patchText`。
- 调 `Patch.parsePatch`（`packages/opencode/src/patch/`）解析 hunks。
- 每个 hunk 支持 add / update / delete / move 四种 type。
- 触发 `permission: "edit"`。
- 仅对 `gpt-*`（非 4、非 oss）模型暴露（见 7.2.3）。

### 7.3.3 Shell 执行

**`shell`**（`tool/shell.ts`，647 行）—— 跑 shell 命令。它对外的工具 id 仍然叫 `"bash"`（`tool/shell/id.ts:16`，保持向后兼容），但内部支持 bash / pwsh / powershell / cmd。详见 7.7 节。

参数（`tool/shell/prompt.ts:22-31`）：`command`、`timeout?`、`workdir?`、`description`。
- 触发 `permission: "bash"`（pattern 是命令本身），如有路径还触发 `permission: "external_directory"`。
- 默认超时 2 分钟（`shell.ts:343`），可以被 `OPENCODE_BASH_DEFAULT_TIMEOUT_MS` 环境变量覆盖。
- 输出大于阈值时**边跑边写文件**（`shell.ts:497-521`），不堆在内存里。

### 7.3.4 LSP 集成

**`lsp`**（`tool/lsp.ts`，113 行）—— 把 LSP 操作暴露给 LLM。

支持 9 种操作（`tool/lsp.ts:11-21`）：`goToDefinition`、`findReferences`、`hover`、`documentSymbol`、`workspaceSymbol`、`goToImplementation`、`prepareCallHierarchy`、`incomingCalls`、`outgoingCalls`。

参数：`operation`、`filePath`、`line`（1-based）、`character`（1-based）、`query?`（workspaceSymbol 用）。
- 触发 `permission: "lsp"`。
- 当前由 flag `OPENCODE_EXPERIMENTAL_LSP_TOOL` 控制（`registry.ts:270`）。

### 7.3.5 子任务与流程控制

**`task`**（`tool/task.ts`，345 行）—— 启动一个 subagent。

参数（`tool/task.ts:47-59`）：`description`、`prompt`、`subagent_type`、`task_id?`（用于 resume）、`command?`、`background?`。
- 触发 `permission: "task"`（pattern 是 `subagent_type`）。
- 内部 `sessions.create(...)`（`task.ts:152-169`）新建子 session；继承父 agent / session 的权限（`deriveSubagentSessionPermission`，见第 08 章）。
- `background=true` 时立即返回 `task_id`，后台跑（需 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`）。
- 跑完返回子 session 最后一段 text。

**`task_status`**（`tool/task_status.ts`）—— 轮询后台 subagent 的状态。

**`todowrite`**（`tool/todo.ts`，57 行）—— 让 LLM 维护任务列表。

参数：`todos`（数组）。每项 `{ content, status: pending | in_progress | completed | cancelled, priority }`。
- 触发 `permission: "todowrite"`。
- 数据存到 `Todo.Service`（`session/todo.ts`），TUI 会读出来在侧边栏显示。

**`skill`**（`tool/skill.ts`，72 行）—— 加载预设 skill 的内容。

参数：`name`。从 `Skill.Service` 拿到内容，并附上 skill 目录下的文件列表。skill 是一种"按需加载的 prompt 片段 + 配套脚本"机制。

**`question`**（`tool/question.ts`，44 行）—— 反向问用户问题。

参数：`questions`（数组）。每个问题有 `question`、`header`、`custom`（是否允许自由文本）、`options`。
- 调 `Question.Service.ask`，会通过 bus 推送一个事件给前端，前端展示一个交互框，用户的答案再回到 LLM。
- 仅在 client 是 `app/cli/desktop` 时启用（`registry.ts:227`）。

**`plan`** / `PlanExitTool`（`tool/plan.ts`，78 行）—— Plan 模式的退出钩子。

- Plan 模式是一种"只允许阅读和思考，写入要再确认"的 agent 模式。
- `plan_exit` 工具被调时，会问用户"是否切到 build agent 执行计划"，确认后插入一条 synthetic user message 触发后续执行（`plan.ts:52-67`）。
- 入口模板 `plan-enter.txt` 是用于 build agent 主动建议"我们先规划一下"的提示，由对应工具读取。

### 7.3.6 外部访问

**`webfetch`**（`tool/webfetch.ts`，192 行）—— 抓 URL。

参数：`url`、`format`（text/markdown/html，默认 markdown）、`timeout?`。
- 触发 `permission: "webfetch"`（pattern 是 URL）。
- 5MB 响应大小上限（`MAX_RESPONSE_SIZE`，`webfetch.ts:9`），30 秒默认超时，最大 120 秒。
- HTML 用 `turndown` 转 markdown；图片以 `attachment` 返回。
- 被 Cloudflare 403 拦截时，会换一个老实的 `User-Agent: opencode` 重试一次（`webfetch.ts:79-91`）。

**`websearch`**（`tool/websearch.ts`，143 行）—— 网络搜索。

参数：`query`、`numResults?`、`livecrawl?`、`type?`、`contextMaxCharacters?`。
- 调外部 MCP 服务，目前接两个 provider：Exa 和 Parallel（`mcp-websearch.ts`）。
- 没启用任何专门 provider 时，按 sessionID 的 checksum 在两者之间均匀分配（`websearch.ts:30-37`）。
- 只对 `providerID === "opencode"` 或开启了对应 flag 时暴露（`registry.ts:61-63`）。

**`mcp-websearch`**（`tool/mcp-websearch.ts`，96 行）—— 上面 websearch 工具的底层 HTTP 调用器，不直接暴露为工具。

**`repo_clone`** / **`repo_overview`**（`tool/repo_clone.ts`、`tool/repo_overview.ts`）—— 实验性的"scout"功能：把外部仓库克隆到 cache 目录，再概览其结构。当前由 `OPENCODE_EXPERIMENTAL_SCOUT` 控制。

### 7.3.7 辅助工具

**`invalid`**（`tool/invalid.ts`，21 行）—— 占位。LLM 用错工具时框架会替换成它，避免崩。

**`external-directory`**（`tool/external-directory.ts`，49 行）—— 不是工具，而是被几乎所有路径相关工具共用的"工作区外路径检查"。`assertExternalDirectoryEffect(ctx, filepath)` 检查 `filepath` 是否在 instance directory 之内，若不在，触发 `permission: "external_directory"` 让用户决定。

---

## 7.4 工具 prompt 模板：同名 `.txt`

每个工具旁都有一个同名 `.txt` 文件，里面是给 LLM 看的 description。文件清单：

```text
apply_patch.txt   edit.txt        glob.txt        grep.txt
lsp.txt           plan-enter.txt  plan-exit.txt   question.txt
read.txt          repo_clone.txt  repo_overview.txt   skill.txt
task.txt          task_status.txt todowrite.txt   webfetch.txt
websearch.txt     write.txt
shell/shell.txt
```

加载方式很简单——直接 import：

```ts
// tool/read.ts:7
import DESCRIPTION from "./read.txt"
// ...
return {
  description: DESCRIPTION,
  parameters: Parameters,
  execute: ...,
}
```

这依赖 Bun 的 `import` 行为：对 `.txt` 后缀，import 直接拿到文件内容字符串。这样的设计有两个好处：

1. **prompt 是源代码的一部分**：不会和代码分散，diff 时一目了然。
2. **可以在编辑器里舒服地写多行 markdown**：不会被字符串字面量的转义搞乱。

某些工具的 description 会被运行时再加工：

- `task` 工具：`describeTask`（`registry.ts:307-320`）在末尾拼上 "Available agent types:" 列表。
- `skill` 工具：`describeSkill`（`registry.ts:288-305`）末尾拼"可用 skill 列表"。
- `websearch` 工具：`{{year}}` 占位符在 `tools(model)` 阶段被替换为当年年份（`websearch.ts:107`）。
- 插件可以 hook `tool.definition` 事件改写任何工具的描述（`registry.ts:345-347`）。

---

## 7.5 Execution Pipeline：从 tool_call 到 ToolResult

把所有环节串起来看：

<svg viewBox="0 0 760 600" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Tool execution pipeline from LLM stream chunk to ToolResult Part">
  <defs>
    <marker id="ar71" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="240" y="14" width="280" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="36" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">LLM stream chunk: tool_call</text>
  <text x="380" y="50" text-anchor="middle" font-size="9.5" fill="#64748b">{ name, args, callID }</text>
  <path d="M380,58 L380,74" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="240" y="76" width="280" height="32" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="96" text-anchor="middle" font-size="11" fill="currentColor">session/tools.ts:84-114  execute(args, options)</text>
  <path d="M380,108 L380,126" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="160" y="128" width="440" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="176" y="143" font-size="10.5" fill="currentColor">① plugin.trigger("tool.execute.before")</text>
  <path d="M380,150 L380,162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="160" y="164" width="440" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="176" y="179" font-size="10.5" fill="currentColor">② decodeUnknownEffect(parameters)(args)  参数校验</text>
  <text x="618" y="179" font-size="9.5" fill="#dc2626">↘ InvalidArgumentsError</text>
  <path d="M380,186 L380,198" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="160" y="200" width="440" height="22" rx="3" fill="#99f6e4" stroke="#0d9488"/>
  <text x="176" y="215" font-size="10.5" fill="currentColor">③ tool.execute(decoded, ctx)</text>
  <path d="M380,222 L380,238" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="80" y="240" width="600" height="100" rx="6" fill="#fed7aa" fill-opacity="0.45" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="258" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">ctx.ask({ permission, patterns, always, metadata })  权限检查</text>
  <rect x="100" y="266" width="180" height="64" rx="4" fill="#fff" stroke="#0d9488"/>
  <text x="190" y="282" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">allow</text>
  <text x="190" y="299" text-anchor="middle" font-size="10" fill="#64748b">命中 allow 规则</text>
  <text x="190" y="315" text-anchor="middle" font-size="10" fill="currentColor">→ 立即放行</text>
  <rect x="290" y="266" width="180" height="64" rx="4" fill="#fff" stroke="#0ea5e9"/>
  <text x="380" y="282" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">ask</text>
  <text x="380" y="299" text-anchor="middle" font-size="10" fill="#64748b">bus.publish Asked</text>
  <text x="380" y="315" text-anchor="middle" font-size="10" fill="currentColor">→ 等用户回应</text>
  <rect x="480" y="266" width="180" height="64" rx="4" fill="#fff" stroke="#dc2626"/>
  <text x="570" y="282" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">deny</text>
  <text x="570" y="299" text-anchor="middle" font-size="10" fill="#64748b">throw RejectedError</text>
  <text x="570" y="315" text-anchor="middle" font-size="10" fill="currentColor">→ 错误回灌给 LLM</text>
  <path d="M380,340 L380,358" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="160" y="360" width="440" height="22" rx="3" fill="#99f6e4" stroke="#0d9488"/>
  <text x="176" y="375" font-size="10.5" fill="currentColor">④ 真正副作用：spawn / fs.write / fetch / ...</text>
  <path d="M380,382 L380,394" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="160" y="396" width="440" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="176" y="411" font-size="10.5" fill="currentColor">⑤ output 超 50KB → truncate.output() + 全文写盘</text>
  <path d="M380,418 L380,430" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="160" y="432" width="440" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="176" y="447" font-size="10.5" fill="currentColor">⑥ plugin.trigger("tool.execute.after")</text>
  <path d="M380,454 L380,466" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="160" y="468" width="440" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="176" y="483" font-size="10.5" fill="currentColor">⑦ processor.completeToolCall(callID, output)</text>
  <path d="M380,490 L380,502" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="160" y="504" width="440" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="176" y="519" font-size="10.5" fill="currentColor">⑧ 持久化为 MessageV2.ToolPart（写 SQLite）</text>
  <path d="M380,526 L380,540" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="220" y="544" width="320" height="38" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="568" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">下一轮 toolResult 回灌给 LLM</text>
</svg>
<span class="figure-caption">图 R7.1 ｜ 一次 tool_call 从 stream chunk 到 ToolPart 落库的八步管线：plugin 钩子、Schema 校验、ctx.ask 三路裁决、truncate 兜底、processor 持久化。</span>

<details>
<summary>ASCII 原版</summary>

```text
LLM 返回 stream chunk
        │
        ▼  含 tool_call: { name, args, callID }
session/processor 拿到 chunk
        │
        ▼
session/tools.ts:84-114  execute(args, options)
        │
        ▼
1) plugin.trigger("tool.execute.before")
        │
        ▼
2) decodeUnknownEffect(parameters)(args)            ← 参数校验
        │
        ▼  失败 → InvalidArgumentsError → 回灌给 LLM
3) tool.execute(decoded, ctx)
        │
        ▼
   ctx.ask({permission, patterns, always, metadata})  ← 权限检查
        │       │
        │       ▼ 命中 allow 规则 → 立即放行
        │       ▼ 命中 deny       → throw RejectedError
        │       ▼ ask             → bus 推 Permission.Event.Asked → 等用户
        │
        ▼
   真正的副作用（spawn / fs.write / fetch）
        │
        ▼  result.output 太长 → truncate.output() → 50KB 截断 + 全文写盘
4) plugin.trigger("tool.execute.after")
        │
        ▼
5) processor.completeToolCall(callID, output)
        │
        ▼
   持久化为 ToolResult Part（写 SQLite）
        │
        ▼
   下次给 LLM 喂消息时，作为 toolResult 消息回灌
        │
        ▼
LLM 继续生成下一段
```

</details>

关键文件：

- `session/tools.ts:84-114` —— `execute` 的包装，调 `plugin.trigger` + `item.execute`。
- `tool/tool.ts:111-144` —— `wrap` 包装，做参数校验和输出截断。
- `session/processor.ts` —— 把工具返回结果序列化成 `MessageV2.ToolPart` 并存 DB。

值得指出的细节：

- **abort 时也要 completeToolCall**：`session/tools.ts:108-110`，如果用户在工具运行中按了取消，框架仍然把已有结果落盘，以便重启后能看到现场。
- **MCP 工具走另一条腿**：`session/tools.ts:118-203` 处理 MCP server 暴露的工具，它们没有本地 `Tool.Def`，但走同一个 `ctx.ask` / `plugin.trigger` 流程。

---

## 7.6 输出截断：`truncate.ts` 与 `truncation-dir.ts`

工具输出的"上限"由两个常量定义（`tool/truncate.ts:16-19`）：

```ts
export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")
```

50KB / 2000 行的设定是经验值：足够装下一份中等大小的文件读取或命令输出，又不会一次把模型 context 填爆。

`Truncate.Service.output(text, options, agent)`（`tool/truncate.ts:86-142`）：

1. 读取 limits（默认 50KB / 2000 行，可被配置覆盖）。
2. 如果文本符合限制，原样返回，`truncated: false`。
3. 否则按 `direction`（默认 `"head"`，保留前面；可选 `"tail"` 保留后面）截。
4. 调 `write(text)` 把完整内容写进 `~/.local/share/opencode/tool-output/tool_<id>`（`truncation-dir.ts:4`）。
5. 返回截断后的预览 + 一段提示："Full output saved to: /xxx；用 grep/read 工具取剩下的，或者把任务委派给探索 agent"。
6. `hasTaskTool(agent)`（`truncate.ts:29-32`）判断当前 agent 是否能调用 `task`，决定提示文本里建议委派还是建议自己 grep。

为什么要存全文到磁盘？因为：

- LLM 可以再发一次 `read` / `grep` 把目标段落"取回来"，避免"我要看 5000-6000 行，把 2-1000 截掉就够了"这种情况手足无措。
- 调试时人类也可以 `cat /xxx/tool_...` 看到工具到底产出了什么。

`cleanup()`（`truncate.ts:55-67`）每小时跑一次，删 7 天前的旧文件。

---

## 7.7 Shell 工具子系统：`tool/shell/`

`shell.ts`（647 行）是 opencode 里最复杂的工具之一。它需要解决：

1. **命令解析**：把 `git status && rm -rf foo/` 拆成两个命令，分别检查权限。
2. **路径影响分析**：识别哪些参数是路径，哪些路径在工作区外，触发 `external_directory` 询问。
3. **流式输出**：长输出要边跑边给 TUI 更新，并且超大时落盘。
4. **超时 / 取消**：默认 2 分钟，可被工具参数覆盖；用户取消时 3 秒内强杀。
5. **跨 shell**：bash / pwsh / powershell / cmd 四种。

### 7.7.1 命令解析：tree-sitter-bash / tree-sitter-powershell

`shell.ts:307-332` 用 `web-tree-sitter` 加载 bash 和 powershell 的 wasm 语法定义，构建一个 `Parser`。

```ts
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  // ...加载 tree-sitter.wasm、tree-sitter-bash.wasm、tree-sitter-powershell.wasm
  return { bash, ps }
})
```

为什么不直接 `command.split(' ')`？因为：

- `git commit -m "feat: add foo && bar"` 不能在 `&&` 处拆。
- `cat file.txt | grep foo` 是两个命令。
- PowerShell 的 `$(...)`、`@(...)` 子表达式需要特殊处理。

走语法树解析能拿到所有 "命令节点"（`commands()`，`shell.ts:126-128`），每个节点对应一次需要权限的执行单元。

### 7.7.2 `collect`：扫描每条命令影响的路径

`shell.ts:374-410` 的 `collect`：

```ts
for (const node of commands(root)) {
  const command = parts(node)
  const tokens = command.map((item) => item.text)
  const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

  if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
    for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
      const resolved = yield* argPath(arg, cwd, ps, shell)
      if (!resolved || containsPath(resolved, instance)) continue
      const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
      scan.dirs.add(dir)
    }
  }

  if (tokens.length && (!cmd || !CWD.has(cmd))) {
    scan.patterns.add(source(node))
    scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
  }
}
```

`FILES` / `CMD_FILES`（`shell.ts:30-65`）是"会动文件系统"的命令白名单：`rm`、`cp`、`mv`、`mkdir`、`touch`、`chmod`、`chown`、`cat`、`copy-item`、`del`、`dir`、…。对这些命令的路径参数，若解析出的绝对路径在 instance 之外，加入 `scan.dirs`，最后触发 `external_directory` 询问。

对所有命令（除了 `cd` 这种纯 cwd 改变），加入 `scan.patterns` —— 命令原文。同时 `BashArity.prefix(tokens)` 把命令缩到"人类能理解的前缀"（见 7.7.4），拼上 `" *"` 作为 always 模式。

### 7.7.3 跑命令：`ChildProcess` + 流式

`shell.ts:289-306` 的 `cmd()` 构造 `ChildProcess.make`：

- POSIX shell 用 `ChildProcess.make(command, [], { shell, cwd, env, detached: true })`，让 shell 自己解释 `&&`、`|` 等。
- PowerShell 在 Windows 上要用 `-NoLogo -NoProfile -NonInteractive -Command` 切到非交互模式。

`run()`（`shell.ts:424-596`）干这些事：

1. `Stream.runForEach(handle.all, chunk => ...)` 流式消费 stdout/stderr 合流。
2. 维护一个 ring buffer（`list[]` + `used`），保留最近 100KB（2 倍 maxBytes）。
3. 同时把整段累积到 `full`；一旦 `full` 超过 maxBytes，就切到"落盘模式"——`trunc.write(full)` 把已有的写到文件，新数据继续 append。
4. 每收一段就 `ctx.metadata({ output: last, description })` 把"最近 30KB"快照给 TUI。
5. `Effect.raceAll([handle.exitCode, abort, timeout])` 三路赛跑：
   - 进程退出 → 拿 exit code。
   - 用户 abort → `handle.kill({ forceKillAfter: "3 seconds" })`。
   - 超时 → 同上 kill。
6. 最后用 `tail(raw, maxLines, maxBytes)` 做尾部截断（默认 head 不行因为有些命令最关键的输出在末尾），拼上 `<shell_metadata>` 段告诉 LLM "超时了" / "用户中止了"。

注意它**没**用 PTY。早期版本曾依赖 `bun-pty` / `@lydell/node-pty`，但 v1.15 切回了纯 `ChildProcess`：原因是 PTY 跨平台维护成本高（特别是 Windows），而流式 + abort 已能覆盖绝大多数交互需求。需要真正的 PTY（如 vim / less）时，用户应通过 `pty` 服务（`server/routes/.../pty.ts`）单独走，而不是 shell 工具。

### 7.7.4 `BashArity`：把命令"缩"到人能理解的前缀

`packages/opencode/src/permission/arity.ts` 维护一张 `ARITY` 表，记录每个常见命令"前缀的 token 数"。例：

```ts
const ARITY: Record<string, number> = {
  cat: 1,         // cat file.txt → "cat"
  git: 2,         // git checkout main → "git checkout"
  "git config": 3, // git config user.name → "git config user.name"
  npm: 2,         // npm install → "npm install"
  "npm run": 3,   // npm run dev → "npm run dev"
  docker: 2,
  "docker compose": 3,
  ...
}
```

`prefix(tokens)`（`arity.ts:1-9`）取最长匹配前缀。当用户在权限对话框里选"以后总是允许"时，框架给出的"always 模式"就是这个前缀拼 ` *`——`git status --porcelain` 会变成 `git status *`，足够宽到能放过同类调用，但不会变成"`git`什么都允许"。

这是一个**很重要的 UX 设计**：

- 太严：每次 `git status` 都问，烦死人。
- 太松：`git` 一答应，模型就能 `git push --force`。
- 这张表的精度恰好。

---

## 7.8 Edit 工具的复杂度：9 种 replacer

`edit.ts` 有 711 行，其中六七百行都在解决一个看似简单的问题："`oldString` 在文件里能不能匹配到？"

为什么这么难？因为 LLM **不会精确复刻空白和缩进**——它可能记错 tab vs 4 空格，或多/少一个尾随空行。如果只用 `content.replace(oldString, newString)`，失败率会非常高。

`replace()` 函数（`edit.ts:674-711`）按顺序串了 9 种 replacer，每一种代表一种"放宽匹配"的策略：

| Replacer | 思路 | 文件位置 |
|---|---|---|
| `SimpleReplacer` | 精确字符串匹配 | `edit.ts:240-242` |
| `LineTrimmedReplacer` | 每行去首尾空格后逐行比 | `edit.ts:244-282` |
| `BlockAnchorReplacer` | 取首行+尾行做"锚点"，中间用 Levenshtein 距离打分 | `edit.ts:284-417` |
| `WhitespaceNormalizedReplacer` | 所有空白序列归一为单空格 | `edit.ts:419-461` |
| `IndentationFlexibleReplacer` | 把每行最小公共缩进剥掉再比 | `edit.ts:463-489` |
| `EscapeNormalizedReplacer` | 把 `\n` / `\t` / `\"` 等转义先 unescape 再比（针对 LLM 输出带转义的情况） | `edit.ts:491-538` |
| `MultiOccurrenceReplacer` | 找所有出现位置（配合 `replaceAll: true`） | `edit.ts:540-552` |
| `TrimmedBoundaryReplacer` | 整体 trim 后再找 | `edit.ts:554-578` |
| `ContextAwareReplacer` | 类似 BlockAnchor，但用 50% 中间行匹配率做阈值 | `edit.ts:580-636` |

主循环（`edit.ts:681-703`）：

```ts
for (const replacer of [SimpleReplacer, LineTrimmedReplacer, ..., MultiOccurrenceReplacer]) {
  for (const search of replacer(content, oldString)) {
    const index = content.indexOf(search)
    if (index === -1) continue
    notFound = false
    if (replaceAll) return content.replaceAll(search, newString)
    const lastIndex = content.lastIndexOf(search)
    if (index !== lastIndex) continue  // 多次出现 → 这个 replacer 不够独一，换下一个
    return content.substring(0, index) + newString + content.substring(index + search.length)
  }
}
```

逻辑要点：

- **顺序从严到宽**：先试精确匹配，逐步放宽，使大多数调用走到 `SimpleReplacer` 就返回。
- **唯一性守护**：除了 `replaceAll`，每个 replacer 都要求"匹配到的字符串只出现一次"，避免错改其它位置。
- **找不到 vs 找到多次**：两种失败被区分（`edit.ts:705-710`），错误消息不同——前者要 LLM 提供准确 oldString，后者要它提供更多上下文。

这种"levenshtein + 锚点"的思路源自 cline 项目，文件头部有注释明确说出处（`edit.ts:1-4`）。

为什么不直接走 LSP / AST？因为：

- AST 只对有 LSP 的语言可用，opencode 要支持 markdown / 日志 / 配置文件等纯文本。
- AST 改动语义更安全，但 LLM 已经按字符思考了，把它强行抬到 AST 反而不自然。

---

## 7.9 Tool runtime（`packages/llm`）：协议层 vs 执行层

opencode 的 monorepo 里，与工具相关的代码分布在两处：

- `packages/opencode/src/tool/`：**执行层**，定义"工具具体怎么干"，是我们这一章的主角。
- `packages/llm/src/`：**协议层**，是底层 LLM client（一个轻量的 Anthropic / OpenAI / Gemini 调用器）。

`packages/llm/src/tool-runtime.ts` 处理的是 stream chunk 里的工具调用解析——把 SSE 的 `tool_use_block_start`、`input_json_delta`、`tool_use_block_stop` 等事件累积成"完成的 tool_call"对象，再发出。它不知道"`bash` 是干嘛的"，也不会去 spawn 进程；它只负责"把模型说的话翻译成结构"。

往上一层，`packages/opencode/src/session/tools.ts` 调 `registry.tools(...)` 拿到本地工具列表，再用 Vercel AI SDK 的 `tool({...})` 包装一次（`session/tools.ts:81-115`），最后塞给 AI SDK 的 `streamText`。AI SDK 看见模型生成 tool_call 就会自动 invoke 我们传进去的 `execute`——也就是回到了 7.5 节的 pipeline。

所以两层的分工：

<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Protocol layer vs execution layer separation for tools">
  <defs>
    <marker id="ar72" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="40" y="20" width="680" height="86" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="60" y="42" font-size="13" font-weight="700" fill="currentColor">协议层 ｜ Vercel AI SDK + packages/llm</text>
  <text x="60" y="62" font-size="11" fill="currentColor">• 把 schema 嵌入 LLM 请求</text>
  <text x="60" y="78" font-size="11" fill="currentColor">• 解析 stream chunk → tool_call 对象</text>
  <text x="60" y="94" font-size="11" fill="currentColor">• 调用注入的 execute(args, options)</text>
  <path d="M380,108 L380,158" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar72)"/>
  <text x="396" y="138" font-size="10.5" fill="#64748b">execute(args, options)</text>
  <rect x="40" y="160" width="680" height="100" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="60" y="182" font-size="13" font-weight="700" fill="currentColor">执行层 ｜ packages/opencode/src/tool/</text>
  <text x="60" y="202" font-size="11" fill="currentColor">• 工具定义 (Tool.define)</text>
  <text x="60" y="218" font-size="11" fill="currentColor">• 工具注册表 (ToolRegistry)</text>
  <text x="60" y="234" font-size="11" fill="currentColor">• 真正干活：spawn / fs / fetch / ctx.ask</text>
  <text x="60" y="250" font-size="11" fill="#64748b">• 输出截断、LSP 诊断回灌、format 集成</text>
</svg>
<span class="figure-caption">图 R7.2 ｜ 工具系统的两层切分：协议层只关心结构与编解码，执行层只关心副作用与策略；换 LLM 不动工具、加工具不动协议。</span>

<details>
<summary>ASCII 原版</summary>

```text
┌────────────────────────────────────────────────────┐
│ Vercel AI SDK + packages/llm                       │  协议层
│  - 把 schema 嵌入 LLM 请求                          │
│  - 解析 stream chunk → tool_call 对象              │
│  - 调用注入的 execute(args, options)               │
└────────────────────────────────────────────────────┘
                       ↓ execute(args, options)
┌────────────────────────────────────────────────────┐
│ packages/opencode/src/tool/                        │  执行层
│  - 工具定义 (Tool.define)                          │
│  - 工具注册表 (ToolRegistry)                       │
│  - 真正干活：spawn / fs / fetch / ask              │
└────────────────────────────────────────────────────┘
```

</details>

这样切分的好处：换 LLM 协议（Anthropic ↔ OpenAI）时只动协议层；加新工具时只动执行层。

---

## 7.10 小结：设计上的几条原则

把这一章铺过来的细节抽出来，opencode 的工具系统体现了几条一致的设计原则：

1. **schema 优先，描述次之**：每个工具 `parameters` 是机器可读的 Effect Schema，由它派生 JSON Schema 给 LLM，由它做参数校验，源是唯一的。
2. **副作用必声明 ctx.ask**：所有真正动手的工具都要先 `yield* ctx.ask(...)`，权限系统统一裁决——工具自己不做策略判断。
3. **统一 truncate / format / diagnostics**：50KB 截断、自动 prettier、LSP 诊断回灌，都从 Tool 抽象的公共边界统一处理，工具作者写最少代码。
4. **prompt 与代码共置**：同名 `.txt` 文件，import 进来就是 description，避免 prompt 漂移到外部仓库。
5. **协议层与执行层分离**：换 LLM 不动工具，加工具不动协议。
6. **复杂度集中在易变的边界**：shell（解析 + 路径分析）和 edit（模糊匹配）才是真正长的文件，因为它们直接对接 LLM 的不确定行为。

下一章将进入第 08 章——工具系统时时刻刻在调用、但本章只点到为止的**权限系统**。

---

## 参考文件清单

- `packages/opencode/src/tool/tool.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/tool/schema.ts`
- `packages/opencode/src/tool/json-schema.ts`
- `packages/opencode/src/tool/truncate.ts`
- `packages/opencode/src/tool/truncation-dir.ts`
- `packages/opencode/src/tool/read.ts`
- `packages/opencode/src/tool/write.ts`
- `packages/opencode/src/tool/edit.ts`
- `packages/opencode/src/tool/apply_patch.ts`
- `packages/opencode/src/tool/grep.ts`
- `packages/opencode/src/tool/glob.ts`
- `packages/opencode/src/tool/lsp.ts`
- `packages/opencode/src/tool/shell.ts`
- `packages/opencode/src/tool/shell/id.ts`
- `packages/opencode/src/tool/shell/prompt.ts`
- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/tool/task_status.ts`
- `packages/opencode/src/tool/todo.ts`
- `packages/opencode/src/tool/skill.ts`
- `packages/opencode/src/tool/question.ts`
- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/tool/webfetch.ts`
- `packages/opencode/src/tool/websearch.ts`
- `packages/opencode/src/tool/mcp-websearch.ts`
- `packages/opencode/src/tool/repo_clone.ts`
- `packages/opencode/src/tool/repo_overview.ts`
- `packages/opencode/src/tool/invalid.ts`
- `packages/opencode/src/tool/external-directory.ts`
- `packages/opencode/src/session/tools.ts`
- `packages/opencode/src/permission/arity.ts`
- `packages/llm/src/tool-runtime.ts`
