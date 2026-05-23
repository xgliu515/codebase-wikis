# 04 Agent 抽象与模式

opencode 里的 "agent" 不是一段代码，是一份**配置**。每个 agent 决定：能用哪些工具、对这些工具的默认许可怎么走、什么 system prompt、用哪个模型、是否对外可见、是 primary 还是 subagent。同一份 opencode 二进制里同时跑着十来种 agent；它们的差异完全是声明式的。

本章从 Agent 数据结构开始，逐层解释 build / plan / general 三种默认 agent 的对照，agent 加载链路（默认 + 配置 + 插件），system prompt 是怎么从 agent.prompt + 工作目录元信息 + skill + 用户规则拼出来的，最后讲 subagent / plan-build 双 agent 的特殊机制。

代码版本：`anomalyco/opencode@d74d166ac`（tag `v1.15.10`）。

## Agent 数据结构

`packages/opencode/src/agent/agent.ts:29-50`：

```ts
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: Permission.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelID,
      providerID: ProviderID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Agent" })
```

逐字段解释：

| 字段 | 作用 |
|------|------|
| `name` | 唯一标识，CLI / TUI / @ 提及都用这个 |
| `description` | 给**模型**看的"什么时候用这个 agent" 描述（subagent 路由必备） |
| `mode` | `primary`：用户可以直接选；`subagent`：只能被 task 工具调用；`all`：两者都行 |
| `native` | 内置 agent (`build` / `plan` / `general` / `explore` / `compaction` / `title` / `summary`) 为 `true` |
| `hidden` | 不在 TUI 列表 / @ 自动补全里出现（但仍可调用） |
| `temperature` / `topP` | 该 agent 强制覆盖的采样参数 |
| `color` | TUI 渲染该 agent 名字的颜色 |
| `permission` | 该 agent 允许 / 询问 / 拒绝哪些工具调用（Permission.Ruleset） |
| `model` | 该 agent 默认用什么模型；不设则继承 session model |
| `variant` | 该 agent 默认用模型的什么 variant（如 thinking / non-thinking） |
| `prompt` | 该 agent 的 system prompt 主体（覆盖 provider 默认 prompt） |
| `options` | provider-specific 选项，会 mergeDeep 到 LLM 请求 |
| `steps` | 这个 agent 一次 turn 最多跑多少 agentic step；超过强制收尾 |

`mode` 字段的三种取值是路由器的钥匙：

```text
mode = "primary"    → 出现在 TUI agent 选择菜单 + 顶部 status bar
                      可以作为 session.agent 持久化
                      不会被 task 工具调用
mode = "subagent"   → 不出现在选择菜单
                      只能由其他 agent 通过 task() 调用
                      派生独立 child session（parent_id = caller.sessionID）
mode = "all"        → 两者都行
```

`hidden: true` 是另一维度。`compaction` / `title` / `summary` 都是 `mode: "primary"` + `hidden: true`——它们是内部工作流（自动压缩历史、自动生成标题、自动总结 diff），不应该让用户看到选项，但确实是 primary（独立会话、独立模型调用），所以技术上不能放进 subagent 桶。

## 三种默认 agent 的差异

opencode 出厂时定义在 `agent.ts:129-281` 的 `agents` 字典里。最重要的是这三种：

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Agent      │ mode     │ permission base    │ prompt 来源              │
├────────────┼──────────┼────────────────────┼──────────────────────────┤
│ build      │ primary  │ defaults + question│ provider 默认 prompt     │
│            │          │ : allow,           │ (anthropic / gpt / ...)  │
│            │          │ plan_enter: allow  │                          │
├────────────┼──────────┼────────────────────┼──────────────────────────┤
│ plan       │ primary  │ edit/*: deny       │ provider 默认 prompt +   │
│            │          │ edit/<plan>: allow │ PLAN_MODE 系统提醒注入   │
│            │          │ plan_exit: allow   │ (synthetic part)         │
├────────────┼──────────┼────────────────────┼──────────────────────────┤
│ general    │ subagent │ defaults +         │ provider 默认 prompt     │
│            │          │ todowrite: deny    │                          │
└────────────────────────────────────────────────────────────────────────┘
```

### build：默认全权 agent

源码（`agent.ts:130-144`）：

```ts
build: {
  name: "build",
  description: "The default agent. Executes tools based on configured permissions.",
  options: {},
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      question: "allow",
      plan_enter: "allow",
    }),
    user,
  ),
  mode: "primary",
  native: true,
},
```

`build` 的特点：

- 没有自己的 `prompt` 字段——这意味着 LLM 请求构造时会 fallback 到 `SystemPrompt.provider(model)`（`session/llm/request.ts:58`），即按模型 family 拿一份默认 prompt。
- 权限上叠加了 `question: allow`（允许问 LLM 反问用户）和 `plan_enter: allow`（允许 LLM 在判断"这事儿需要先规划"时主动切到 plan agent）。
- `defaults` 已经包含 `"*": "allow"`，所以 build 可以使用几乎所有工具。
- 唯一不能用的是 `question`（在 defaults 里被设为 `deny`，但被 build 自己的覆盖项打回 `allow`）和 `plan_enter` / `plan_exit`（同理）。

### plan：只读 + 强制写计划

源码（`agent.ts:145-167`）：

```ts
plan: {
  name: "plan",
  description: "Plan mode. Disallows all edit tools.",
  options: {},
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      question: "allow",
      plan_exit: "allow",
      external_directory: {
        [path.join(Global.Path.data, "plans", "*")]: "allow",
      },
      edit: {
        "*": "deny",
        [path.join(".opencode", "plans", "*.md")]: "allow",
        [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
      },
    }),
    user,
  ),
  mode: "primary",
  native: true,
},
```

plan 模式的精髓：

- **edit 全局 deny**，但**仅对 plan 文件 allow**：`.opencode/plans/*.md` 和 `~/.local/share/opencode/plans/*.md` 是白名单。这是个**反模式的妥协**——理论上 plan agent 应该完全只读，但实际它必须能把它写的计划文件落盘。
- **external_directory 也给 plans 目录 allow**：因为 plan 文件可能写到全局的 `~/.local/share/opencode/plans/`（vcs=git 时写到 `.opencode/plans`，否则写全局，见 `session.ts:371-376` 的 `Session.plan`）。
- **plan_exit: allow**：plan agent 完成规划后必须主动调 `plan_exit` 工具来让用户切回 build。这个工具的实现细节稍后讲。
- **plan_enter: 不给**——plan agent 显然不应该再切到 plan 自己。

但**这些权限只是底层防线**。plan agent 真正的灵魂是注入到 user message 上的 `PLAN_MODE` 文本（`session/prompt/plan-mode.txt`），把"你现在是只读模式，违反就是 critical violation"用大写英文吼到 LLM 脸上。光靠 permission 不够——LLM 还是会尝试调 bash 来 `tee` 或 `sed`，permission 层会拒，但 turn 就废了。注入 system reminder 让 LLM 一开始就走对路。

### general：subagent 用于多步调研

源码（`agent.ts:168-181`）：

```ts
general: {
  name: "general",
  description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      todowrite: "deny",
    }),
    user,
  ),
  options: {},
  mode: "subagent",
  native: true,
},
```

`general` 是真正意义上的 subagent：

- `mode: "subagent"` → 用户在 TUI 选不到它，只能由 build / plan 通过 `task(subagent_type: "general", ...)` 工具调用。
- 唯一被限制的工具是 `todowrite`——subagent 写不了 TODO 列表（todo 是全局共享的、属于父 session）。
- 没有 `prompt` 字段，沿用 provider 默认（subagent 不需要专门的 prompt，因为它接收的是父 agent 写的 task 描述）。

`general` 的用途：复杂调研，"找出所有用了 deprecated API 的文件并报告"、"在多个候选实现里选一个"——这种任务可以在父 session 里串行做，但拆给 subagent 有好处：**子任务的中间 token 不污染主 session 历史**。subagent 跑完返回的只是最终文本，主 session 看到的就是一个简短的 tool result。

`description` 字段非常关键——它是给**调用方 LLM** 看的路由提示。`task` 工具的 description（`tool/task.txt`）列出可选 subagent 类型，附带每个 agent 的 description。模型读到这段后才知道该把任务派给 `general` 还是 `explore`。

### 还有哪些 native agent

完整列表（`agent.ts:129-281`）：

| name | mode | hidden | 用途 |
|------|------|--------|------|
| build | primary | false | 默认主 agent |
| plan | primary | false | 规划模式 |
| general | subagent | false | 通用多步任务 |
| explore | subagent | false | 文件 + grep 调研专用 |
| scout | subagent | false | 外部依赖 / 文档（experimental） |
| compaction | primary | true | 自动压缩历史 |
| title | primary | true | 自动生成会话标题 |
| summary | primary | true | 自动总结 diff |

`scout` 只有在 `experimentalScout` flag 开时才注册（`agent.ts:205-234`）。

### explore：极度受限的快搜 subagent

源码（`agent.ts:182-204`）：

```ts
explore: {
  name: "explore",
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      "*": "deny",
      grep: "allow",
      glob: "allow",
      list: "allow",
      bash: "allow",
      webfetch: "allow",
      websearch: "allow",
      read: "allow",
      external_directory: readonlyExternalDirectory,
    }),
    user,
  ),
  description: `Fast agent specialized for exploring codebases. ...`,
  prompt: PROMPT_EXPLORE,
  options: {},
  mode: "subagent",
  native: true,
},
```

注意 `"*": "deny"`——先把所有工具关掉，再单独放行 grep / glob / list / read / bash / webfetch / websearch。`bash` 允许是为了 `ls / cat / find` 这类 shell 命令；写文件 / 改 git 都做不到。

`prompt: PROMPT_EXPLORE`（`agent/prompt/explore.txt`）告诉 LLM 自己是文件搜索专家，明确禁止"创建任何文件"。

## Agent 配置加载链路

`agent.ts:92-369` 的 `state` 函数描述完整加载顺序：

```text
1. defaults  ← 从代码硬编码出来的基础 ruleset
                "*": "allow", question: "deny", plan_enter: "deny",
                plan_exit: "deny", read.*.env: "ask", ...
2. user      ← 从 config.permission 读，Permission.fromConfig 转 Ruleset
3. agents 字典（build / plan / ...）  ← 每个 entry 自己再 merge 一遍
4. for-each cfg.agent[key]:
     - 若 value.disable → 删掉这个 agent
     - 若不存在 → 新建一个空 agent
     - 应用 model / variant / prompt / description / temperature / topP /
       mode / color / hidden / name / steps / options / permission
5. 给每个 agent 强制 allow truncate dir（除非用户显式禁用）
```

整套 merge 用的是 `Permission.merge`（`packages/opencode/src/permission/index.ts:302-304`）——它委托给 `PermissionV2.merge`。语义是"后面的覆盖前面的同 key"，所以 `defaults < native agent override < user config` 的优先级链很清晰。

`Permission.fromConfig`（`permission/index.ts:288-300`）把人类友好的配置格式：

```ts
{
  "*": "allow",
  read: { "*": "allow", "*.env": "ask" },
}
```

展开成 ruleset 数组：

```ts
[
  { permission: "*", pattern: "*", action: "allow" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "read", pattern: "*.env", action: "ask" },
]
```

`expand()` 还顺手把 `~/` 和 `$HOME/` 替换成 home 目录绝对路径（`permission/index.ts:280-286`）。

### 配置文件里怎么定义自定义 agent

`packages/opencode/src/config/agent.ts:21-50`：

```ts
const AgentSchema = Schema.StructWithRest(
  Schema.Struct({
    model: Schema.optional(ConfigModelID),
    variant: Schema.optional(Schema.String),
    temperature: Schema.optional(Schema.Finite),
    top_p: Schema.optional(Schema.Finite),
    prompt: Schema.optional(Schema.String),
    tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
      description: "@deprecated Use 'permission' field instead",
    }),
    disable: Schema.optional(Schema.Boolean),
    description: Schema.optional(Schema.String),
    mode: Schema.optional(Schema.Literals(["subagent", "primary", "all"])),
    hidden: Schema.optional(Schema.Boolean),
    options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
    color: Schema.optional(Color),
    steps: Schema.optional(PositiveInt),
    maxSteps: Schema.optional(PositiveInt),
    permission: Schema.optional(ConfigPermission.Info),
  }),
  [Schema.Record(Schema.String, Schema.Any)],
)
```

`tools: { name: boolean }` 是已弃用的形式，但 `normalize`（`config/agent.ts:77-96`）会自动翻译成 `permission`：

```ts
for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
  const action = enabled ? "allow" : "deny"
  if (tool === "write" || tool === "edit" || tool === "patch") {
    permission.edit = action
    continue
  }
  permission[tool] = action
}
```

即 `tools: { write: false }` 等价 `permission: { edit: "deny" }`——三种编辑型工具被合并成单一权限。

`StructWithRest` 加 `[Schema.Record(Schema.String, Schema.Any)]` 允许配置里出现未声明的额外字段；它们会被 `normalize` 收编到 `options` 字段里（`config/agent.ts:78-81`）：

```ts
const options: Record<string, unknown> = { ...agent.options }
for (const [key, value] of Object.entries(agent)) {
  if (!KNOWN_KEYS.has(key)) options[key] = value
}
```

也就是配置随便加键，opencode 都会保留下来传到 provider 侧。

### Markdown 形式的 agent

除了 `opencode.json` 里的 `agent: {...}`，agent 还可以是一个独立的 Markdown 文件——前置 frontmatter 是配置，正文是 prompt。`config/agent.ts:106-130`：

```ts
export async function load(dir: string) {
  const result: Record<string, Info> = {}
  for (const item of await Glob.scan("{agent,agents}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch((err) => { ... })
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["agent/", "agents/"])
    const config = {
      name,
      ...md.data,
      prompt: md.content.trim(),
    }
    result[config.name] = ConfigParse.schema(Info, config, item)
  }
  return result
}
```

`{agent,agents}/**/*.md` 同时支持单数和复数子目录名。`md.data` 是 YAML frontmatter，`md.content` 是正文 markdown——后者直接成为 `prompt` 字段。这意味着用户可以这样定义一个 agent：

```markdown
---
mode: subagent
description: Review TypeScript code for type safety
permission:
  edit: deny
  bash: deny
---

You are a TypeScript code reviewer. ...
```

文件名（不含扩展名）就是 agent name。`loadMode` 函数（`config/agent.ts:132-160`）是同样的机制但扫 `{mode,modes}/*.md`——这是为了向后兼容（早期 opencode 把这个概念叫 "mode" 而不是 "agent"）。所有 mode 都强制 `mode: "primary"`。

## Agent 加载与切换

### CLI: `--agent <name>`

`packages/opencode/src/cli/cmd/run.ts:171-174`：

```ts
.option("agent", {
  type: "string",
  describe: "agent to use",
})
```

CLI 直接把名字塞进 session 创建参数（`run.ts:492` 附近）。`Session.create({ agent })`（`session.ts:657-677`）把它写到 `SessionTable.agent` 列。

### TUI: Tab 切换

TUI 在 prompt 组件里维护当前 agent。`packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:395` 附近的注释 "Keep command line --agent if specified" 表明：

- 如果 CLI 启动时指定了 `--agent`，TUI 不允许在 session 内切换（防止覆盖用户意图）。
- 否则 Tab 键在 primary agent 之间循环（subagent 和 hidden agent 跳过）。

但**注意**：切 agent 不是切 session。同一个 session 可以在不同 turn 用不同 agent——`MessageV2.User.agent` 是 user message 自己的字段（`session/message-v2.ts:341`），每条 turn 都独立携带。`SessionTable.agent` 只是默认值。

所以"session 的 agent 是否可变？"答案是：

- 数据库层：`SessionTable.agent` 字段可以被 update（没人显式做这件事，但没有约束阻止）。
- 实际运行：每条 user message 上的 agent 才是生效值。改 session.agent 不影响已有消息，只影响下一条新消息的默认值。

这种"per-turn agent" 设计的好处是 plan→build 这种切换非常自然：plan agent 写完计划，下一条 user message 就 agent="build"，同一个 session 继续走。

### Default agent

`Agent.defaultInfo`（`agent.ts:344-356`）：

```ts
const defaultInfo = Effect.fnUntraced(function* () {
  const c = yield* config.get()
  if (c.default_agent) {
    const agent = agents[c.default_agent]
    if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
    if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
    if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
    return agent
  }
  const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
  if (!visible) throw new Error("no primary visible agent found")
  return visible
})
```

逻辑：

1. 配置里有 `default_agent` → 用它，但拒绝 subagent / hidden。
2. 否则取第一个 `mode !== "subagent" && hidden !== true` 的 agent。
3. 一个都没有 → 报错（理论不可能，build 永远在）。

`Agent.list`（`agent.ts:332-342`）的排序规则把 default agent 放在最前面、其余按 name 字典序：

```ts
sortBy(
  [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
  [(x) => x.name, "asc"],
)
```

## System prompt 装配

LLM 一次请求的 system 字段不是单个字符串，而是多段拼接起来的。`session/prompt.ts:1419-1427` 是装配点：

```ts
const [skills, env, instructions, modelMsgs] = yield* Effect.all([
  sys.skills(agent),
  sys.environment(model),
  instruction.system().pipe(Effect.orDie),
  MessageV2.toModelMessagesEffect(msgs, model),
])
const system = [...env, ...instructions, ...(skills ? [skills] : [])]
const format = lastUser.format ?? { type: "text" as const }
if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
```

而 `system` 数组进 `handle.process({ ..., system, ... })` 后，最终被 `session/llm/request.ts:54-77` 的 `prepare` 再做一层拼接：

```ts
const system = [
  [
    ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
    ...input.system,
    ...(input.user.system ? [input.user.system] : []),
  ]
    .filter((x) => x)
    .join("\n"),
]
```

整个拼接顺序（从前到后）：

```text
1. agent.prompt          ← 若 agent 自己定义了 prompt，用它；
                            否则用 SystemPrompt.provider(model)（按模型族选默认）
2. environment           ← "你叫 X 模型，cwd=Y, vcs=git, 平台=darwin, 日期=Z"
3. instructions          ← 拼接 AGENTS.md / CLAUDE.md / CONTEXT.md 内容
4. skills (可选)         ← 该 agent 可用的 skill 列表（详见 skill 章）
5. structured prompt     ← 若 user.format.type === "json_schema"
6. user.system (可选)    ← user message 自己附带的额外 system
```

### `SystemPrompt.provider(model)` 按模型选默认

`session/system.ts:19-33`：

```ts
export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}
```

不同模型对 prompt 的"个性"不同——Anthropic 用 Markdown 风格、GPT 系列要简洁明确、Gemini 喜欢分点。`packages/opencode/src/session/prompt/` 下每个 `.txt` 文件长度都在 80–155 行，是这些模型的"驯化"prompt（详细介绍工具调用规则、风格要求等）。

### `environment(model)` 注入工作环境信息

`session/system.ts:48-63`：

```ts
environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
  const ctx = yield* InstanceState.context
  return [
    [
      `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
      `Here is some useful information about the environment you are running in:`,
      `<env>`,
      `  Working directory: ${ctx.directory}`,
      `  Workspace root folder: ${ctx.worktree}`,
      `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${new Date().toDateString()}`,
      `</env>`,
    ].join("\n"),
  ]
}),
```

注意三件事：

1. **是字符串数组**：`environment` 返回 `string[]`，调用方做 join。允许将来按需把 env 拆成多段。
2. **不含敏感字段**：没有 username / hostname / 环境变量等。
3. **vcs 字段没法骗**：直接看 `ctx.project.vcs === "git"`——若 project 不是 git repo 这里就是 false，LLM 不会被误导调用 git 命令。

### `instructions` 读取 AGENTS.md / CLAUDE.md

`session/instruction.ts:14-18`：

```ts
const files = (disableClaudeCodePrompt: boolean) => [
  "AGENTS.md",
  ...(disableClaudeCodePrompt ? [] : ["CLAUDE.md"]),
  "CONTEXT.md", // deprecated
]
```

`AGENTS.md` 是 opencode 的原生约定；`CLAUDE.md` 是 Anthropic Claude Code 的约定，默认也读（除非用户在 RuntimeFlags 里关掉）；`CONTEXT.md` 是历史遗留兼容。`Instruction.system()` 走 `relative()` 沿目录树往上找这些文件，加上 global 配置目录下的同名文件，全部拼起来（详见 `instruction.ts` 完整实现）。

### `skills` 装配

`session/system.ts:65-77`：

```ts
skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
  if (Permission.disabled(["skill"], agent.permission).has("skill")) return

  const list = yield* skill.available(agent)

  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    Skill.fmt(list, { verbose: true }),
  ].join("\n")
}),
```

如果当前 agent 的 permission 禁用了 `skill` 工具，就完全不注入这段——LLM 看不到任何 skill。否则枚举该 agent 可用的 skill 列表（按 description 注释），LLM 自行判断什么时候要 `skill(name)` 来加载特定 workflow。

### `agent.prompt` 字段的最终去向

回到 `session/llm/request.ts:58`：

```ts
...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
```

注意是**互斥的**——agent 一旦定义了自己的 prompt，provider 默认 prompt 就不再用。所以一份用户 markdown agent 完全有能力替换掉 opencode 内置的 Anthropic / GPT 风格 prompt，但代价是要自己写完整的工具调用约定。

build agent **故意**不设 `prompt`，就是为了让 provider prompt 生效。plan agent 也不设 `prompt`，因为 plan 模式不靠 system prompt 约束行为，而是靠每次都在 user message 上 append `PLAN_MODE` 文本（见下文 reminders）。

## Subagent：task 工具的实现

subagent 不是被 "切换" 来的，是被父 agent 通过 `task` 工具**调用**的。父 turn 在跑 LLM 流时如果发起 `task(subagent_type, prompt, ...)`，opencode 会：

1. 创建一个新 session（`parentID = parent.sessionID`）。
2. 拷贝/派生 permission ruleset。
3. 在新 session 里跑一遍完整的 prompt 循环。
4. 把子 session 最后一条 assistant text part 当作 tool result 塞回父 turn。

`packages/opencode/src/tool/task.ts:152-211` 是核心：

```ts
const nextSession =
  session ??
  (yield* sessions.create({
    parentID: ctx.sessionID,
    title: params.description + ` (@${next.name} subagent)`,
    permission: [
      ...deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        parentAgent,
        subagent: next,
      }),
      ...(cfg.experimental?.primary_tools?.map((item) => ({
        pattern: "*",
        action: "allow" as const,
        permission: item,
      })) ?? []),
    ],
  }))

// ...

const runTask = Effect.fn("TaskTool.runTask")(function* () {
  const parts = yield* ops.resolvePromptParts(params.prompt)
  const result = yield* ops.prompt({
    messageID: MessageID.ascending(),
    sessionID: nextSession.id,
    model: { modelID: model.modelID, providerID: model.providerID },
    agent: next.name,
    tools: {
      ...(next.permission.some((rule) => rule.permission === "todowrite") ? {} : { todowrite: false }),
      ...(next.permission.some((rule) => rule.permission === id) ? {} : { task: false }),
      ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
    },
    parts,
  })
  return result.parts.findLast((item) => item.type === "text")?.text ?? ""
})
```

要点：

- **独立 session**：subagent 不共享主 session 的 message 历史。从父 session 看到的只是一条 ToolPart（type=task），其 output 是子 session 最后的 text。subagent 自己的中间过程（reasoning、其他 tool calls、step-start/finish）全在子 session 里、对父 LLM 不可见。
- **`task_id` 复用**：参数 `task_id` 允许复用之前的 subagent session 继续对话，而不是每次新建——这样 subagent 可以"记得"之前查过什么。
- **`background` 模式**：`background=true` 时 subagent 异步跑，工具立即返回 `task_id`，父 agent 用 `task_status(task_id)` 轮询。后台 subagent 完成时通过 `inject("completed", text)` 把结果作为 synthetic user message 塞回父 session，并触发 `loop` 让父 agent 继续。这个能力受 `experimentalBackgroundSubagents` 控制（`task.ts:121-125`）。
- **`task` 默认不允许递归**：除非 subagent 自己的 permission 显式包含 `task: allow`，否则 `tools.task = false`——subagent 不能再调 task。这是为了避免无限派生。
- **`todowrite` 默认禁**：同上理由，TODO 列表是全局共享、属于主 session 的。

返回值（`task.ts:61-69`）：

```ts
function output(sessionID: SessionID, text: string) {
  return [
    `task_id: ${sessionID} (for resuming to continue this task if needed)`,
    "",
    "<task_result>",
    text,
    "</task_result>",
  ].join("\n")
}
```

`task_id` 放在 result 里，方便父 LLM 想"再追问"时直接复用。

### `deriveSubagentSessionPermission`：父子权限合成

`packages/opencode/src/agent/subagent-permissions.ts:17-34`：

```ts
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: Permission.Ruleset
  parentAgent: Agent.Info | undefined
  subagent: Agent.Info
}): Permission.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  const parentAgentDenies =
    input.parentAgent?.permission.filter((rule) => rule.action === "deny" && rule.permission === "edit") ?? []
  return [
    ...parentAgentDenies,
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
```

合成规则（按优先级写入 ruleset 头部，所以前面的覆盖后面的）：

1. **父 agent 的 edit-deny 规则全部继承**——这是关键修复（注释提到 `#26514`）。plan 模式的 edit-deny 写在 agent 上、不在 session 上；如果只继承 session permission，subagent 就可以绕过 plan 模式去写文件。所以这里**显式从父 agent ruleset 抓 edit-deny**。
2. **父 session 的 external_directory 规则 + 所有 deny 规则**继承。允许进的目录还是要限制（防止 subagent 偷偷读 `/etc`），明确禁的工具也必须禁。
3. **subagent 自己不显式允许 `todowrite` / `task`**，则补一条 `deny`。
4. **subagent 自己的 permission**（已经在 session.create 后续 merge 进来）作为基线。

返回的 ruleset 替换 subagent session 的 `permission` 字段。**所以子 session 持有的是父 + 子合成出来的最终规则集**——并不是"子 agent 自己的 ruleset 原样照搬"。

### Subagent 怎么终结

`tool/task.ts:311-334`：

```ts
return yield* Effect.acquireUseRelease(
  Effect.sync(() => {
    ctx.abort.addEventListener("abort", onAbort)
  }),
  () =>
    Effect.gen(function* () {
      const text = yield* runTask()
      return {
        title: params.description,
        metadata,
        output: output(nextSession.id, text),
      }
    }),
  (_, exit) =>
    Effect.gen(function* () {
      if (Exit.hasInterrupts(exit)) yield* cancel
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          ctx.abort.removeEventListener("abort", onAbort)
        }),
      ),
    ),
)
```

`Effect.acquireUseRelease` 模式：

- acquire：注册一个 abort listener，若父 turn 被取消则同步取消 subagent。
- use：等 `runTask` 跑完，把最后一条 text 作为 output 返回。
- release：清理 abort listener；如果是被中断的，调一次 `cancel` 把 subagent session 停掉。

这样无论父 turn 怎么结束（正常 / 取消 / 错误），subagent 都会被妥善清理，不会留下 dangling 任务。

## Plan vs Build 的特殊机制

plan 模式的"只读"行为来自三层叠加：

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Plan mode three layer defense permission prompt and exit tool">
  <defs>
    <marker id="r4ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">plan 模式三层防御</text>
  <text x="380" y="40" text-anchor="middle" font-size="10" fill="#64748b">从底层强制 → 中层引导 → 上层出口</text>
  <rect x="60" y="56" width="640" height="84" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="80" y="76" font-size="12" font-weight="700" fill="currentColor">Layer 1　agent.permission（hard stop）</text>
  <line x1="80" y1="84" x2="680" y2="84" stroke="#cbd5e1"/>
  <text x="80" y="100" font-size="10.5" fill="currentColor">edit/* : deny　　edit/&lt;plan_path&gt; : allow　　plan_exit : allow</text>
  <text x="80" y="118" font-size="10" fill="#64748b">Permission.evaluate 在 Tool.run 入口直接 throw DeniedError</text>
  <text x="80" y="132" font-size="10" fill="#94a3b8">底线：LLM 即使想 bash tee/sed 改文件，工具调用一进就被拒</text>
  <path d="M380,140 L380,160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar1)"/>
  <rect x="60" y="162" width="640" height="84" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="80" y="182" font-size="12" font-weight="700" fill="currentColor">Layer 2　PLAN_MODE 系统提醒（synthetic text part）</text>
  <line x1="80" y1="190" x2="680" y2="190" stroke="#cbd5e1"/>
  <text x="80" y="206" font-size="10.5" fill="currentColor">SessionReminders.apply 在每次 plan agent 的 user turn 注入</text>
  <text x="80" y="224" font-size="10" fill="#64748b">大写英文吼："READ-ONLY phase. STRICTLY FORBIDDEN: ANY file edits..."</text>
  <text x="80" y="238" font-size="10" fill="#94a3b8">引导 LLM 主动配合，省掉一堆"试探—被拒—重试"的无效 turn</text>
  <path d="M380,246 L380,266" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar1)"/>
  <rect x="60" y="268" width="640" height="80" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="80" y="288" font-size="12" font-weight="700" fill="currentColor">Layer 3　plan_exit 工具（唯一出口）</text>
  <line x1="80" y1="296" x2="680" y2="296" stroke="#cbd5e1"/>
  <text x="80" y="312" font-size="10.5" fill="currentColor">plan agent 完成规划 → 调 plan_exit → 弹 question 让用户确认</text>
  <text x="80" y="330" font-size="10" fill="#64748b">同意：写一条 agent=&quot;build&quot; 的 synthetic user msg，自然进入 build 流</text>
</svg>
<span class="figure-caption">图 R4.1 ｜ plan 模式三层防御：底层 permission 是 hard stop，中层 system reminder 引导 LLM 主动配合，上层 plan_exit 工具提供唯一受控出口。光靠任意一层都不够。</span>

<details>
<summary>ASCII 原版</summary>

```text
┌────────────────────────────────────────────────────────────────────┐
│ Layer 1: agent.permission                                          │
│   edit/*: deny, edit/<plan>: allow, plan_exit: allow              │
│   →  Permission.evaluate(...) 在 Tool.run 入口拦住 edit            │
├────────────────────────────────────────────────────────────────────┤
│ Layer 2: PLAN_MODE 系统提醒 (synthetic text part)                  │
│   每次 plan agent 的 user turn 都注入                              │
│   告诉 LLM "你处于 plan mode，违反就是 critical violation"         │
├────────────────────────────────────────────────────────────────────┤
│ Layer 3: plan_exit 工具                                            │
│   plan agent 完成规划后唯一的"退出"出口                            │
│   弹 question 让用户确认切到 build agent                           │
└────────────────────────────────────────────────────────────────────┘
```

</details>

### 第 1 层：permission

已在前面 plan agent 那节解释过。这是 hard stop——即使 LLM 想绕过，Tool.run 入口的 permission 检查会直接 throw `DeniedError`，整个工具调用变成 error。

### 第 2 层：plan-mode 注入

`session/reminders.ts:14-89`：

```ts
export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: MessageV2.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* AppFileSystem.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  if (!flags.experimentalPlanMode) {
    if (input.agent.name === "plan") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: PROMPT_PLAN,
        synthetic: true,
      })
    }
    const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
    if (wasPlan && input.agent.name === "build") {
      userMessage.parts.push({ /* BUILD_SWITCH ... synthetic: true */ })
    }
    return input.messages
  }
  // ... experimentalPlanMode 分支 ...
})
```

逻辑：

- 当前 agent 是 plan → 在最新 user message 上 append `PROMPT_PLAN`（`session/prompt/plan.txt`）作为 synthetic text part。LLM 看到这段大写英文吼："Plan mode ACTIVE - you are in READ-ONLY phase. STRICTLY FORBIDDEN: ANY file edits..."
- 历史里出现过 plan agent，且当前 agent 是 build → append `BUILD_SWITCH`（`session/prompt/build-switch.txt`）：

  ```text
  Your operational mode has changed from plan to build.
  You are no longer in read-only mode.
  ```

  这一段是给 LLM 看的"模式切换通知"——告诉它之前的 plan-mode 系统提醒**不再适用**，可以写文件了。

`experimentalPlanMode` 走另一条分支（`reminders.ts:50-87`）：用更详细的 `PLAN_MODE` 文本（`session/prompt/plan-mode.txt`），并把 plan 文件路径 / 是否已存在的信息插值进去：

```ts
text: PLAN_MODE.replace("${planInfo}", () =>
  exists
    ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
    : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
),
```

`session/prompt/plan-mode.txt` 是一个完整的"五阶段 plan workflow" 文档（70 行），告诉 LLM 怎么用 explore subagent 调研、怎么调 question 工具问用户、什么时候调 plan_exit。

### 第 3 层：plan_exit 工具

`packages/opencode/src/tool/plan.ts:14-78`：

```ts
export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const plan = path.relative(instance.worktree, Session.plan(info, instance))
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
                header: "Build Agent",
                custom: false,
                options: [
                  { label: "Yes", description: "Switch to build agent and start implementing the plan" },
                  { label: "No", description: "Stay with plan agent to continue refining the plan" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          if (answers[0]?.[0] === "No") yield* new Question.RejectedError()

          const messages = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
          const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
          const model =
            lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()

          const msg: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model,
          }
          yield* session.updateMessage(msg)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text",
            text: `The plan at ${plan} has been approved, you can now edit files. Execute the plan`,
            synthetic: true,
          } satisfies MessageV2.TextPart)

          return {
            title: "Switching to build agent",
            output: "User approved switching to build agent. Wait for further instructions.",
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
```

`plan_exit` 调用流：

1. 弹一个 yes/no 问题让用户确认（走 `Question.Service`，会在 TUI 上展示）。
2. 用户拒绝 → `Question.RejectedError`，工具失败。LLM 在父 turn 看到 error，继续待在 plan 模式（也许再问用户调整方向）。
3. 用户同意 → 创建一条新 user message，`agent: "build"`，**synthetic text** 是 `"The plan at <path> has been approved, you can now edit files. Execute the plan"`。
4. 返回工具结果：`"User approved switching to build agent. Wait for further instructions."`

注意 **`updateMessage` / `updatePart` 写的是一条 user message**——也就是说 plan_exit 在当前 assistant turn 的中间塞了一条新的 user turn。下次 LLM 收到这条 user message 时：

- `agent="build"` → `SessionReminders.apply` 检测到"先前是 plan、现在是 build"，注入 `BUILD_SWITCH` 提醒。
- text 已经告诉它"plan 批准了，去执行"。

整个切换不需要用户多输任何东西。

`plan_enter` 工具（`session/prompt.ts` 未单独列在 `tool/` 下，但用 `plan-enter.txt` 描述）是对称设计：build agent 主动询问要不要切到 plan。逻辑类似——弹 question，确认后改下一条 user message 的 agent 为 plan。

### Session.plan：计划文件位置

`session.ts:371-376`：

```ts
export function plan(input: { slug: string; time: { created: number } }, instance: InstanceContext) {
  const base = instance.project.vcs
    ? path.join(instance.worktree, ".opencode", "plans")
    : path.join(Global.Path.data, "plans")
  return path.join(base, [input.time.created, input.slug].join("-") + ".md")
}
```

- 项目是 git repo：写到 `.opencode/plans/<created>-<slug>.md`，可以提交到仓库。
- 不是 git repo：写到 global `$DATA/plans/<created>-<slug>.md`，跨项目存放。

`<created>` 是 session 创建的 unix 时间戳，`<slug>` 是 session 的 slug。这样文件名天然带时间序、不冲突。

## 几张总览图

### Agent 工厂的完整加载链

<svg viewBox="0 0 820 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Agent factory loading pipeline from sources to agents dictionary">
  <defs>
    <marker id="r4ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="410" y="22" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Agent 工厂加载链路</text>
  <rect x="40" y="44" width="200" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="140" y="64" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">config.get()</text>
  <text x="140" y="80" text-anchor="middle" font-size="9.5" fill="#64748b">permission / agent / default_agent</text>
  <rect x="40" y="100" width="200" height="38" rx="6" fill="#fff" stroke="#cbd5e1"/>
  <text x="140" y="124" text-anchor="middle" font-size="11" fill="currentColor">defaults（hardcoded）</text>
  <rect x="40" y="146" width="200" height="38" rx="6" fill="#fff" stroke="#cbd5e1"/>
  <text x="140" y="170" text-anchor="middle" font-size="11" fill="currentColor">user perm（fromConfig）</text>
  <rect x="40" y="192" width="200" height="38" rx="6" fill="#fff" stroke="#cbd5e1"/>
  <text x="140" y="216" text-anchor="middle" font-size="11" fill="currentColor">markdown agents</text>
  <path d="M240,68 L300,140" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar2)"/>
  <path d="M240,120 L300,140" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar2)"/>
  <path d="M240,166 L300,160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar2)"/>
  <path d="M240,212 L300,180" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar2)"/>
  <rect x="300" y="120" width="320" height="60" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="460" y="140" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">native agents（build / plan / general / ...）</text>
  <text x="460" y="158" text-anchor="middle" font-size="9.5" fill="#64748b">每个 entry 自己做 Permission.merge</text>
  <text x="460" y="172" text-anchor="middle" font-size="9.5" fill="#94a3b8">defaults &lt; native override &lt; user config</text>
  <path d="M460,180 L460,212" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar2)"/>
  <rect x="280" y="214" width="360" height="80" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="460" y="234" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">for-each cfg.agent[name]</text>
  <text x="460" y="252" text-anchor="middle" font-size="10" fill="currentColor">disable = true　→ 删掉这个 agent</text>
  <text x="460" y="270" text-anchor="middle" font-size="10" fill="currentColor">else 用 cfg 覆盖 model / prompt / perm / mode / ...</text>
  <text x="460" y="286" text-anchor="middle" font-size="9.5" fill="#94a3b8">未声明字段收编进 options，传给 provider</text>
  <path d="M460,294 L460,316" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar2)"/>
  <rect x="280" y="318" width="360" height="36" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="460" y="340" text-anchor="middle" font-size="10.5" fill="currentColor">强制 allow Truncate.GLOB（除非用户显式禁用）</text>
  <path d="M460,354 L460,376" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar2)"/>
  <rect x="260" y="378" width="400" height="46" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="460" y="398" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">agents 字典（最终态）</text>
  <text x="460" y="414" text-anchor="middle" font-size="10" fill="#64748b">每个 agent 是 declarative 的 capability bag</text>
  <path d="M460,424 L460,452" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="180" y1="452" x2="740" y2="452" stroke="#94a3b8" stroke-width="1.2"/>
  <path d="M200,452 L200,472" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar2)"/>
  <path d="M460,452 L460,472" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar2)"/>
  <path d="M720,452 L720,472" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar2)"/>
  <rect x="100" y="474" width="200" height="40" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="200" y="498" text-anchor="middle" font-size="11" fill="currentColor">Agent.get(name)</text>
  <rect x="360" y="474" width="200" height="40" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="460" y="498" text-anchor="middle" font-size="11" fill="currentColor">Agent.list()</text>
  <rect x="620" y="474" width="200" height="40" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="720" y="498" text-anchor="middle" font-size="11" fill="currentColor">Agent.defaultInfo()</text>
</svg>
<span class="figure-caption">图 R4.2 ｜ Agent 工厂加载链：config + defaults + user perm + markdown 文件四源汇合，再被 cfg.agent 逐项覆盖、强制 truncate.allow，最终落到 agents 字典，供 get / list / defaultInfo 三种查询使用。</span>

<details>
<summary>ASCII 原版</summary>

```text
config.get() ──► cfg.permission, cfg.agent[name], cfg.default_agent
                                   │
defaults (hardcoded) ──────────────┤
                                   ├──► native agents (build/plan/general/...)
user perm (fromConfig) ────────────┤    每个 agent 自己做 Permission.merge
                                   │
markdown agents (config.load) ─────┤
                                   ▼
                          for-each cfg.agent[name]:
                            disable=true → 删
                            else → 用 cfg 覆盖 model/prompt/perm/...
                                   │
                                   ▼
                          force allow Truncate.GLOB
                                   │
                                   ▼
                            agents 字典（最终态）
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
           Agent.get(n)        Agent.list()    Agent.defaultInfo()
```

</details>

### LLM 请求 system 字段的拼接

<svg viewBox="0 0 820 480" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="System prompt assembly from agent prompt to environment to instructions to skills">
  <defs>
    <marker id="r4ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="410" y="22" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">LLM 请求 system 字段拼接顺序</text>
  <rect x="40" y="42" width="320" height="50" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="200" y="62" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">① agent.prompt 或 provider 默认</text>
  <text x="200" y="80" text-anchor="middle" font-size="10" fill="#64748b">二者互斥；user 自定义优先</text>
  <path d="M200,92 L200,116" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar3)"/>
  <rect x="40" y="118" width="320" height="50" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="200" y="138" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">② SystemPrompt.environment(model)</text>
  <text x="200" y="156" text-anchor="middle" font-size="10" fill="#64748b">cwd / worktree / vcs / platform / date</text>
  <path d="M200,168 L200,192" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar3)"/>
  <rect x="40" y="194" width="320" height="50" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="200" y="214" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">③ Instruction.system()</text>
  <text x="200" y="232" text-anchor="middle" font-size="10" fill="#64748b">AGENTS.md / CLAUDE.md / CONTEXT.md</text>
  <path d="M200,244 L200,268" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar3)"/>
  <rect x="40" y="270" width="320" height="50" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="200" y="290" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">④ SystemPrompt.skills(agent)</text>
  <text x="200" y="308" text-anchor="middle" font-size="10" fill="#64748b">permission 没禁 skill 才注入</text>
  <path d="M200,320 L200,344" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar3)"/>
  <rect x="40" y="346" width="320" height="44" rx="6" fill="#fff" stroke="#cbd5e1"/>
  <text x="200" y="366" text-anchor="middle" font-size="11" fill="currentColor">⑤ StructuredOutputPrompt（可选）</text>
  <text x="200" y="380" text-anchor="middle" font-size="9.5" fill="#94a3b8">仅当 user.format = json_schema</text>
  <path d="M200,390 L200,414" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar3)"/>
  <rect x="40" y="416" width="320" height="44" rx="6" fill="#fff" stroke="#cbd5e1"/>
  <text x="200" y="436" text-anchor="middle" font-size="11" fill="currentColor">⑥ user.system（per-turn 自定义）</text>
  <text x="200" y="450" text-anchor="middle" font-size="9.5" fill="#94a3b8">user message 自带的 system 字段</text>
  <path d="M380,250 L460,250" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r4ar3)"/>
  <text x="420" y="244" text-anchor="middle" font-size="9.5" fill="#94a3b8">join("\n")</text>
  <rect x="470" y="180" width="320" height="160" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="630" y="204" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">prepare()</text>
  <text x="630" y="222" text-anchor="middle" font-size="10" fill="#64748b">filter empty + join("\n")</text>
  <line x1="490" y1="234" x2="770" y2="234" stroke="#cbd5e1"/>
  <text x="490" y="252" font-size="10" fill="currentColor">最终 system: string[]</text>
  <text x="490" y="270" font-size="10" fill="#64748b">合并为 ModelMessage[0]，role = "system"</text>
  <text x="490" y="296" font-size="10" fill="currentColor">送给 streamText(...)</text>
  <text x="490" y="314" font-size="10" fill="#94a3b8">Vercel AI SDK 调 LanguageModelV3</text>
  <text x="490" y="332" font-size="9.5" fill="#94a3b8">每条 user turn 重新装配，agent 切换立即生效</text>
</svg>
<span class="figure-caption">图 R4.3 ｜ LLM 请求 system 字段的 6 段拼接：agent.prompt → environment → instructions → skills → structured-output → user.system，经 prepare() 合并成单条 system message 送入 AI SDK；每条 user turn 重新装配，agent 切换立即生效。</span>

<details>
<summary>ASCII 原版</summary>

```text
agent.prompt 或
SystemPrompt.provider(model)
       │
       ▼  ── join("\n") ──────►  prepare() ── filter empty ── join("\n")
SystemPrompt.environment(model)            │
       │                                   │
       ▼                                   │
Instruction.system()                       ▼
(AGENTS.md/CLAUDE.md/CONTEXT.md)        最终 system: string[]
       │                                   │
       ▼                                   ▼
SystemPrompt.skills(agent)         发到 LLM 的 ModelMessage[]
       │                          （第一条 role="system"）
       ▼
[StructuredOutputPrompt 若 format=json_schema]
       │
       ▼
user.system (per-turn 自定义)
```

</details>

### plan ↔ build 切换的双向流

```text
                     ┌───── 用户启动 opencode --agent build ─────┐
                     ▼                                              │
              build agent active                                    │
                     │                                              │
                     │  LLM 判断任务复杂 → 调 plan_enter            │
                     ▼                                              │
              question "切到 plan?" ── 拒 ──► 继续 build            │
                     │                                              │
                     │ 同意                                         │
                     ▼                                              │
              新 user msg: agent="plan", synthetic 提醒              │
                     │                                              │
                     ▼                                              │
              plan agent active                                     │
              SessionReminders 注入 PLAN_MODE                       │
                     │                                              │
                     │  explore subagent / read / question 调研     │
                     │  写 plan 文件（唯一允许的 edit）             │
                     │                                              │
                     │  调 plan_exit                                │
                     ▼                                              │
              question "切到 build?" ── 拒 ──► 继续 plan            │
                     │                                              │
                     │ 同意                                         │
                     ▼                                              │
              新 user msg: agent="build", synthetic                 │
              "plan 已批准，去执行"                                 │
                     │                                              │
                     ▼                                              │
              build agent active                                    │
              SessionReminders 注入 BUILD_SWITCH                     │
                     │                                              │
                     └──────────────────────────────────────────────┘
```

## 设计回顾

| 设计选择 | 替代方案 | 为什么这个 |
|----------|----------|------------|
| Agent 是配置而非代码 | 每个 agent 一个类 | 用户能用 markdown 定义自己的 agent；零 boilerplate |
| Permission 在 agent 上，不在 session 上 | 全在 session | 同 session 切 agent 时，权限随之变化 |
| Subagent 走独立 session | 共享父 session 历史 | 子任务 token 不污染主历史 |
| `deriveSubagentSessionPermission` 显式继承父 agent edit-deny | 仅继承父 session | 修复 #26514：plan 的 edit-deny 必须传递 |
| Plan 模式三层防御（perm + prompt + tool） | 只靠 permission | LLM 仍会尝试绕路，注入 prompt 让它"主动配合" |
| `plan_exit` 写一条 user message 而非改 session.agent | 直接改 session | per-turn agent 自洽；历史 turn 仍可追溯 |
| `agent.prompt` 与 `SystemPrompt.provider` 互斥 | 二者拼接 | 用户自定义 prompt 时不混入 provider 默认（防止矛盾指令） |
| `task` 工具默认禁止 subagent 递归调 task | 允许嵌套 | 防止无限派生爆栈 |
| SessionReminders 用 synthetic part 而非系统消息 | 把 PLAN_MODE 进 system 字段 | 每条 user turn 单独控制；agent 切换时下一条立即换 reminder |

整体哲学：**agent 是 declarative 的 capability bag，运行时的实际行为由"该 agent 在这条 user message 上的 permission + prompt"瞬时决定**。不存在"持久化的 agent state"，session 只是承载消息流的容器。这让多 agent 协作（plan→build、build→general→explore）几乎不需要状态机——每条 turn 重新计算所有约束即可。
