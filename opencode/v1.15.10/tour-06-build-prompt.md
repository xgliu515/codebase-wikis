# Trace 步骤 06 —— 装配 system prompt 与工具表

## 1. 当前情境

DB 里有 1 个 Session 行、1 条 `MessageV2.User` 行、1 个 `TextPart`。`SessionPrompt.prompt` 在 `:1228` 调 `loop({ sessionID })`，loop 经 `runLoop` (`packages/opencode/src/session/prompt.ts:1239-1482`) 进入第一轮迭代：`step = 1`。

进 loop 后立刻发生这些事（在第 07 步用到的）：

- 拉 `msgs = filterCompactedEffect(sessionID)` —— 这一刻就一条 user message + 一个 text part。
- 从中算 `lastUser`、`lastAssistant`、`lastFinished`、`tasks` —— `lastUser` 就是我们这条，`lastAssistant` / `lastFinished` 都 `undefined`，`tasks` 空。
- 不 break、不进 subtask、不进 compaction。
- 拉 agent：`agents.get(lastUser.agent)` —— 拿到 `build` agent 的 Info（默认 ruleset、`mode: "primary"`、`prompt: undefined`）。
- 调 `SessionReminders.apply(...)` 给 messages 注入提示 —— 我们这一轮 reminders 不出，跳过。
- 造一个空的 `MessageV2.Assistant` 行（id 已分配，但 cost/tokens 全 0，没 finish），先调 `sessions.updateMessage(msg)` 把它落库（projector 入 MessageTable）—— 这是占位，让后续 streaming 的 part 有 `messageID` 可挂。
- 创建 `processor` handle（`SessionProcessor`），负责消费 stream events 并 dispatch 成 part 写库。

现在 `processor.process(...)` 即将被调用。但调它之前还要装两件东西作为参数：**system 数组**和 **tools 字典**。

可见的状态：
- `lastUser`、`agent`、`model`、`session`、空的 `msg: Assistant` 已就绪。
- `system: string[]` / `tools: Record<string, Tool>` 还都没有。

## 2. 问题

`processor.process(...)` 最终会把请求喂给 `LLM.stream(...)`，后者要的入参（见 `packages/opencode/src/session/llm.ts:33-46`）包括 `system: string[]` 和 `tools: Record<string, Tool>`。要把这两件东西装配出来，得回答：

1. **system 里要塞什么**？至少要包含：模型 ID 字符串 + 工作目录 / 平台 / 日期 / git 状态 + 全局 / 项目级的 AGENTS.md / CLAUDE.md 文件内容 + 可用的 skills 一览。还要按当前 agent 选一份"风格 prompt"（不同模型家族有不同的引导话术）。
2. **tools 装什么**？每个内置工具（read / write / edit / bash / grep / glob / lsp / task / todo / question / webfetch / websearch / repo_clone / repo_overview / skill / plan_exit / apply_patch）+ 所有已连接 MCP server 暴露的工具，去掉这个 agent 没权限的，去掉这个 model 不需要的（比如 GPT 系列用 apply_patch 而不是 edit/write），最后变成模型能消化的 JSON Schema。
3. **不能写死成静态字符串**。同一个 opencode 二进制，跑在不同 cwd、连不同 model、用不同 agent，system 和 tools 都不一样；连同一个会话第 1 轮和第 2 轮，如果中间用户在另一个窗口编辑了 AGENTS.md，第 2 轮的 system 也要变。
4. **不能持久化**。这次 prompt 的最终 system 字符串可能上千行（环境信息 + 多个 AGENTS.md + skills 列表 + 模型风格 prompt）。把它落到 MessageTable 既浪费又会让 fork 的会话被绑死在旧的 system 上。

## 3. 朴素思路

把 system 和 tools 当成两个"常量"：

```ts
const SYSTEM = `You are a helpful coding agent. CWD is ${cwd}.`
const TOOLS = {
  read: { description: "Read a file", schema: {...} },
  write: { description: "Write a file", schema: {...} },
  // 全部硬编码
}
```

启动时初始化一次，整个进程生命周期复用。

## 4. 为什么朴素思路会崩

opencode 的需求把这条路堵得死死的：

- **agent 是运行时配置**。`.opencode/agent/foo.md` 用户随手写一个新 agent；启动后 watch 配置就要能用，硬编码的工具表没法响应。
- **agent permission 是 ruleset 不是黑名单**。`plan` agent 默认 `edit: "deny"`、但允许 `plan_enter` 和 `plan_exit`；`explore` agent 默认 `"*": "deny"` 但白名单 read/grep/glob/list/bash/webfetch/websearch；`general` agent 关掉 `todowrite`。同一个工具表，给不同 agent 是不同的子集。硬编码会让"切 agent"变成"重启进程"。
- **不同 model 工具集不一样**。GPT 系列在 `tool/registry.ts:322-334` 走 `apply_patch` 路径替代 `edit + write`；Anthropic 用 `edit + write`。同一份硬编码工具表，给 GPT 模型用直接对不上。
- **system 必须读到本地 AGENTS.md / CLAUDE.md**。这些文件每个项目都不一样、用户随时改；不在每次请求都重新读，就回到了"启动时拍快照"的老路。
- **JSON Schema 要按 model provider 做后处理**。Moonshot 不接受 `$ref` 的 sibling key，Gemini 要把 integer enum 转 string enum，Google 系不接受某些 anyOf 写法 —— 见 `packages/opencode/src/provider/transform.ts:1257+` 的 `schema()` 函数。同一个工具描述，给不同 provider 要变形。
- **MCP 工具是后接的**。MCP server 跑起来后才知道它有什么工具，用户随时可以加 server。MCP 工具表的发现-注册必须发生在请求路径上，而不是进程启动时。

## 5. opencode 的做法

opencode 把 system 字符串和 tools 表都**每轮 loop 重新装配**，用三类组件按需拼出来：

### system 数组

在 `runLoop` 里 (`packages/opencode/src/session/prompt.ts:1419-1427`)：

```ts
const [skills, env, instructions, modelMsgs] = yield* Effect.all([
  sys.skills(agent),
  sys.environment(model),
  instruction.system().pipe(Effect.orDie),
  MessageV2.toModelMessagesEffect(msgs, model),
])
const system = [...env, ...instructions, ...(skills ? [skills] : [])]
```

四件事并发：

1. **`sys.environment(model)`** (`packages/opencode/src/session/system.ts:48-63`) —— 拼出环境信息块：
   ```text
   You are powered by the model named claude-sonnet-4-5. The exact model ID is anthropic/claude-sonnet-4-5
   Here is some useful information about the environment you are running in:
   <env>
     Working directory: /Users/.../my-project
     Workspace root folder: /Users/.../my-project
     Is directory a git repo: yes
     Platform: darwin
     Today's date: Sat May 23 2026
   </env>
   ```
   这一段每次都重算，因为 model / cwd 都可能换。

2. **`instruction.system()`** (`packages/opencode/src/session/instruction.ts:154-168`) —— 把全局 + 项目级的指令文件读起来。流程：
   - `systemPaths()` 收集所有要读的路径：先看 `~/.config/opencode/AGENTS.md` 和 `~/.claude/CLAUDE.md`（全局），命中一个就停；然后从当前 directory 沿目录树向上找 `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md`，**第一次命中就停**（不堆所有祖先）；最后把 `config.instructions` 里用户配置的 glob 也算上。
   - URL 形式的指令走 HTTP fetch (`:94-102`)，加 5 秒超时。
   - 把每份内容包成 `"Instructions from: {path}\n{content}"`。
   并发度 8（本地）+ 4（远程）。

3. **`sys.skills(agent)`** (`packages/opencode/src/session/system.ts:65-76`) —— 如果这个 agent 有 `skill` 权限，把可用 skill 列表写成一段长描述（带 `verbose: true`，告诉模型每个 skill 干啥）。我们的 build agent 默认带 skill 权限，所以这段会出。

4. **`MessageV2.toModelMessagesEffect(msgs, model)`** —— 把存储的 `WithParts[]` 转成 AI SDK 期望的 `ModelMessage[]`（见步骤 07 实际使用）。

注意这里**没有**包含 agent 风格 prompt（如 anthropic.txt / gpt.txt）—— 那是在更下游的 `LLMRequestPrep.prepare` 里组装的。`prompt.ts` 这一层先把"agent-agnostic"的 system 段拼出来；prepare 阶段才把它们与 model-specific 引导语合并：

```ts
// packages/opencode/src/session/llm/request.ts:55-64
const system = [
  [
    ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
    ...input.system,
    ...(input.user.system ? [input.user.system] : []),
  ].filter((x) => x).join("\n"),
]
```

`SystemPrompt.provider(model)` (`packages/opencode/src/session/system.ts:19-33`) 按 model.api.id 分发：
- `gpt-4 / o1 / o3` → `PROMPT_BEAST`
- `gpt` (非 codex) → `PROMPT_GPT`，`gpt-codex` → `PROMPT_CODEX`
- `gemini-` → `PROMPT_GEMINI`
- `claude` → `PROMPT_ANTHROPIC`
- 其他 → `PROMPT_DEFAULT`

我们的 trace 用 `claude-sonnet-4-5`，所以 `PROMPT_ANTHROPIC` 入选。但如果 agent 自己带 `prompt`（比如 `plan` / `explore` / `compaction` agent 都有自定义 prompt），就用 agent 自己的，跳过 provider 风格 prompt——这是"专门 agent 拒绝被默认风格干扰"的逃生口。

`system` 数组最终在 `request.ts:72-76` 被压成两段：第一段是"agent prompt + env + instructions + skills + user override"全合并的字符串；第二段（如果有的话）是 plugin 钩子 `experimental.chat.system.transform` 加的额外行——这是为了让 plugin 可以在不破坏第一段缓存指纹的前提下追加内容。

### tools 字典

入口在 `prompt.ts:1371-1385`：`SessionTools.resolve(...)` (`packages/opencode/src/session/tools.ts:24-206`) 串起四段流水线：

1. **registry 候选过滤** (`packages/opencode/src/tool/registry.ts:322-367`)：先按 model 取舍——`WebSearchTool` 只在 provider 是 opencode 或 flag 开了 exa / parallel 时出（`:323-326`）；`ApplyPatchTool` 只在 GPT 系（且非 `gpt-4` / `oss`）出，对应 `EditTool` / `WriteTool` 在 GPT 系下不出，二选一（`:328-331`）。再跑 `plugin.trigger("tool.definition", ...)` 让 plugin 改 description / parameters / jsonSchema。最后对 `TaskTool` 和 `SkillTool` 的 description 做动态拼装：TaskTool 描述里塞"该 agent 能调用的 subagent 列表"（`describeTask`，`:307-320`），SkillTool 描述里塞可用 skill 简介（`describeSkill`，`:296-305`）。
2. **schema 兼容化 + AI SDK 包装** (`tools.ts:75-116`)：对每个工具跑 `ProviderTransform.schema(model, ...)` 按 provider 修补 JSON Schema（Moonshot / Gemini / Google 的怪癖），再用 AI SDK 的 `tool({ description, inputSchema, execute })` 包成 AI SDK 工具。execute 闭包里准备 `Tool.Context`（sessionID / messageID / abort / messages / metadata callback / ask callback），夹上 `plugin.trigger("tool.execute.before/after", ...)` 钩子。
3. **MCP 工具混入** (`tools.ts:118-203`)：`mcp.tools()` 拉每个已连接 server 的工具，同样跑 schema 兼容化；execute 闭包里强制 `ctx.ask({ permission: key, ... })`——MCP 工具一律按 ask 处理，不像内置 `read` 默认 allow；解析 content（text / image / resource），image 转 `data:` URL 的 `FilePart` attachment；跑 `truncate.output(...)` 截断长输出。
4. **ruleset 终审** (`request.ts:188-194`)：`LLMRequestPrep.prepare` 调 `resolveTools`，用 `Permission.disabled(toolNames, Permission.merge(agent.permission, session.permission))` 算出被 deny 的工具名集合，从字典里删掉；同时尊重 user message 上的 `tools` 字段（已 deprecated 但兼容）。

我们这个 trace 里 build agent + Anthropic 模型 + 没有 MCP server，最终 tools 字典大致包含 `read / write / edit / bash / grep / glob / lsp / task / task_status / todowrite / question / webfetch / plan_exit / skill` 等键；`repo_clone` / `repo_overview` 因为 build agent 默认 deny（`agent.ts:116-117`）被第 4 步过滤掉。

### 为什么不持久化 system

- **指纹漂移**：AGENTS.md 改了一个字符，下一轮 system 就该跟着变。落表然后每次比对意义不大。
- **fork 友好**：fork 一个会话到新分支时，directory 可能变（worktree），system 重新拼出来才对，落表的旧 system 会带毒。
- **prompt cache 是按 prefix 算的**：fresh 拼出来的 system 第一段如果稳定，prompt cache 自然命中（步骤 07 会用到）；不需要把字符串存数据库再读出来。

## 6. 代码位置

按装配顺序：

- `packages/opencode/src/session/prompt.ts:1419-1427` —— system 数组的并发装配（4 件事一起跑）。
- `packages/opencode/src/session/system.ts:48-63` —— `environment(model)`：env 块。
- `packages/opencode/src/session/system.ts:19-33` —— `provider(model)`：选模型风格 prompt。
- `packages/opencode/src/session/system.ts:65-76` —— `skills(agent)`：skill 列表段。
- `packages/opencode/src/session/instruction.ts:154-168` —— `system()`：读 AGENTS.md / CLAUDE.md / instruction URL。
- `packages/opencode/src/session/instruction.ts:14-18` —— `files(disableClaudeCodePrompt)`：候选文件名列表。
- `packages/opencode/src/session/instruction.ts:109-152` —— `systemPaths()`：路径收集策略（first match wins）。
- `packages/opencode/src/agent/prompt/explore.txt` / `scout.txt` / `compaction.txt` / `summary.txt` / `title.txt` —— 内置非默认 agent 的 prompt（build / plan 没自带 prompt，走 provider 风格）。
- `packages/opencode/src/session/prompt/anthropic.txt` / `default.txt` / `beast.txt` / `gemini.txt` / `gpt.txt` / `kimi.txt` / `codex.txt` / `trinity.txt` —— provider 风格 prompt 文件。
- `packages/opencode/src/agent/agent.ts:129-281` —— 内置 agent 一览（build / plan / general / explore / compaction / title / summary 共 7 个；scout 在 experimentalScout flag 下出）。
- `packages/opencode/src/agent/agent.ts:106-125` —— `defaults` ruleset：把"哪些工具默认 allow / ask / deny"的全局基准定下来。
- `packages/opencode/src/session/prompt.ts:1371-1385` —— `SessionTools.resolve` 的调用点。
- `packages/opencode/src/session/tools.ts:24-116` —— 内置工具装配：registry 取 → schema 兼容化 → AI SDK tool 包装 → plugin hook。
- `packages/opencode/src/session/tools.ts:118-203` —— MCP 工具装配：强制 ask 权限 + content 拆分 + truncate。
- `packages/opencode/src/tool/registry.ts:322-367` —— `tools()`：按 model / provider / agent 过滤候选 + dynamic description（TaskTool / SkillTool）。
- `packages/opencode/src/tool/tool.ts:53-67` —— `Tool.Def` 接口：每个工具实现要满足 `id + description + parameters + execute`。
- `packages/opencode/src/tool/tool.ts:97-147` —— `wrap(...)`：execute 闭包里加 Schema 校验、truncate、span 注解。
- `packages/opencode/src/tool/read.ts:29-37` —— `Parameters` Schema（filePath / offset / limit）。
- `packages/opencode/src/tool/read.txt` —— `read` 工具的 description 模板，最终拼进 LLM 看到的工具描述。
- `packages/opencode/src/session/llm/request.ts:55-76` —— `LLMRequestPrep.prepare` 里的 system 二次合并（注入 agent.prompt / provider prompt / user system 覆盖）。
- `packages/opencode/src/session/llm/request.ts:188-194` —— `resolveTools` 最后一道权限过滤。
- `packages/opencode/src/provider/transform.ts:1257+` —— `schema(model, jsonSchema)`：按 provider 修补 JSON Schema 的兼容性。
- `packages/llm/src/tool-runtime.ts:18` —— `toDefinitions(tools)`：把 AI SDK 工具收敛成 LLM 包要的 `ToolDefinition[]`。

## 7. 分支与延伸

- **System prompt 装配** —— 完整段段拼接顺序与四种 prompt 文件对应关系，参见 [第 04 章 §System prompt 装配](04-agent-system.md#system-prompt-装配)。
- **三种默认 agent** —— `build` / `plan` / `general` / `explore` 等内置 agent 的 ruleset 细节，参见 [第 04 章 §三种默认 agent](04-agent-system.md#三种默认-agent)。
- **工具是什么 / 内置工具一览** —— 16 个内置工具的语义和参数模型，参见 [第 07 章 §工具是什么](07-tools.md#工具是什么) / [第 07 章 §内置工具一览](07-tools.md#内置工具一览)。
- **JSON Schema 与 model 兼容化** —— `ProviderTransform.schema` 的 provider-specific patch，参见 [第 06 章 §schema 兼容化](06-llm.md#schema-兼容化)。
- **MCP 工具发现与权限** —— `mcp.tools()` 怎么从已连接 server 拉表，以及为什么默认 ask，参见 [第 13 章 §MCP 工具](13-mcp.md#mcp-工具)。
- **skills 是什么** —— `Skill.available` / `Skill.fmt` 的工作方式，参见 [第 08 章 §skills](08-skills.md#skills)。
- **AGENTS.md / CLAUDE.md 的发现规则** —— first-match-wins、向上目录树扫描、glob 模式，参见 [第 02 章 §项目级指令文件](02-config.md#项目级指令文件)。

## 8. 走完这一步你脑子里应该多了什么

1. **system 数组每轮 loop 现拼**。它不是 session 的属性，不进数据库，每次 LLM 调用前重新跑环境探测 + AGENTS.md 读盘 + skills 枚举。这让 fork / 跨 cwd / 切 model 全部"零迁移"。
2. **system 的拼装分两层**。`prompt.ts` 层拼 agent-agnostic 部分（env + instructions + skills）；`request.ts` 层把 agent 风格 prompt（agent.prompt 或 SystemPrompt.provider）合到最前——这样 plugin 在中间层 hook 时不容易破坏 cache 指纹。
3. **tools 字典是"工具集 × agent ruleset × model 兼容化 × MCP 发现"的笛卡尔积过滤**。任何工具到达 LLM 前都经过：registry 候选过滤 → provider/model 选择性出现 → JSON Schema 兼容化 → plugin hook 改写 → AI SDK 包装 → 最后用 agent + session permission ruleset 二次过滤。
4. **每个工具的描述是动态的**。TaskTool 的描述里嵌着"我能调哪些 subagent"，SkillTool 的描述里嵌着"我能开哪些 skill"——动态描述让模型 zero-shot 看到的工具表里就有元信息，不用再来回问。
5. **MCP 工具一律 ask**。和 read 默认 allow 形成对比；这一道关把第三方接入的副作用风险锁死在用户授权后面。
6. **prompt 文件是 import 进来的**。`anthropic.txt` / `gpt.txt` / `read.txt` 都用 bun 的 text-import 在编译期吃到 string，不在运行时读文件——零 I/O，零路径解析。

走完这一步：`system: string[]` 拼好（两个元素：agent-agnostic 段 + 留给 plugin 可能追加的段），`tools: Record<string, AITool>` 装好（十多个内置 + 0 个 MCP），`params`（temperature / topP / topK / maxOutputTokens / providerOptions）算好，`headers`（User-Agent / x-session-affinity / x-opencode-* 之类）准备好。万事俱备，下一步把这堆喂进 `streamText`。

下一步：[Trace 步骤 07 —— 第一次 LLM 流式请求](tour-07-llm-call.md)
