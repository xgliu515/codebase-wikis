# 第 01 章 架构总览与启动流程

> 代码版本锁定:`earendil-works/pi@4868222e`(2026-05-20)。本章所有 `file:line` 引用均基于该 commit。

---

## 1.1 pi 是什么

pi 的自我定位出现在 `README.md:19-21`：

> This is the home of the pi agent harness project including our self extensible coding agent.

"agent harness mono-repo" 这个短语精准概括了项目的双重身份：它既是一个**具体的终端编码助手**（coding-agent CLI），也是一套**可复用的 agent 基础设施**（agent runtime + AI 抽象层）。README 第 25-55 行给出了四个 package 的定位：

- `@earendil-works/pi-coding-agent`：交互式编码 agent CLI
- `@earendil-works/pi-agent-core`：携带工具调用和状态管理的 agent runtime
- `@earendil-works/pi-ai`：统一的多 provider LLM API（OpenAI、Anthropic、Google 等）
- `@earendil-works/pi-tui`：差分渲染 Terminal UI 库

这种分层设计意味着 `pi-ai` 和 `pi-agent-core` 可以独立被第三方项目引用，而不必捆绑整个 coding-agent。`CONTRIBUTING.md:68-70` 也明确传达了这一设计哲学：

> pi's core is minimal. If your feature does not belong in the core, it should be an extension.

---

## 1.2 AGENTS.md / CONTRIBUTING.md 揭示的硬性架构约束

这两份文档是理解 pi 代码风格的关键，约束不是随意加上的，每一条背后都有工程理由。

### 1.2.1 TypeScript strip-only 限制

`AGENTS.md:19` 明确：

> Use only erasable TypeScript syntax compatible with Node strip-only mode in TypeScript checked by the root config…Do not use constructor parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other TypeScript constructs that require JavaScript emit.

**为什么**：Node.js 22+ 原生支持直接运行 `.ts` 文件（通过 `--strip-types` 旗），以及配套工具 `tsgo`（`@typescript/native-preview`）的更快类型检查。如果代码里有 `enum` 或参数属性，这类语法必须先经 tsc 转译才能成为有效 JS，破坏了 strip-only 的前提。这也解释了为什么整个代码库中你看到的全是 `const Enum = {...} as const` 对象字面量而非 `enum`，以及显式的字段声明和构造函数赋值。

**影响**：任何看到"为什么不用 enum？"的读者，答案就在这里。

### 1.2.2 禁止内联动态 import（用于类型位置）

`AGENTS.md:17`：

> NEVER use inline imports - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.

**为什么**：动态 import 在类型位置是 TypeScript 的一种特殊语法，strip-only 工具无法完整处理它。但注意这条规则的边界：`register-builtins.ts` 里 provider 的懒加载用的是**运行时**动态 import（加载实际 JS 模块），不是类型位置，所以合法。

### 1.2.3 禁止手改 `models.generated.ts`

`AGENTS.md:23`：

> NEVER modify `packages/ai/src/models.generated.ts` directly. Update `packages/ai/scripts/generate-models.ts` instead.

**为什么**：该文件超过 16,000 行，完全由脚本从多个上游 API（models.dev、OpenRouter、Vercel AI Gateway 等）抓取并生成。手改意味着下次重新生成时修改丢失，且无法追溯来源。详见第 02 章。

### 1.2.4 No emoji 政策

`AGENTS.md:6`：

> No emojis in commits, issues, PR comments, or code

**为什么**：这是一条可执行的"技术散文"纪律，不只是审美偏好。emoji 在不同终端渲染宽度不一致（东亚宽字符问题），在 diff 输出、日志和终端对齐场景中会破坏排版。pi 本身就是一个终端应用，自相矛盾地使用 emoji 会制造麻烦。

### 1.2.5 包间依赖单向约束

虽然 `AGENTS.md` 未用"依赖方向"字样，但从构建顺序脚本可以直接读出约束（`package.json:14`）：

```
cd packages/tui && npm run build && cd ../ai && npm run build &&
cd ../agent && npm run build && cd ../coding-agent && npm run build
```

tui 和 ai 先并行构建，agent 依赖 ai，coding-agent 依赖三者。这是单向 DAG，不允许循环。

### 1.2.6 供应链加固

`README.md:74-85` 列出了一套严格的依赖管理策略：直接依赖固定版本（`save-exact=true`）、`npm-shrinkwrap.json` 锁定传递依赖、pre-commit 阻断意外 lockfile 变更等。这些约束在 `AGENTS.md:40-45` 中以操作指令的形式重申，目的是让"加依赖"这个动作和"改代码"一样需要审查。

---

## 1.3 Monorepo 顶层布局

根目录 `package.json:5-10` 声明了 npm workspaces：

```json
"workspaces": [
  "packages/*",
  "packages/coding-agent/examples/extensions/with-deps",
  "packages/coding-agent/examples/extensions/custom-provider-anthropic",
  "packages/coding-agent/examples/extensions/custom-provider-gitlab-duo",
  "packages/coding-agent/examples/extensions/sandbox"
]
```

`packages/*` 覆盖四个核心 package，example extensions 也作为独立 workspace 参与构建，以便在 CI 中验证扩展 API 的兼容性。

### 四个 package 的角色与依赖关系图

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="pi monorepo 四个 package 的单向依赖关系图">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">pi Monorepo：四 package 依赖关系</text>
  <rect x="30" y="44" width="200" height="44" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="130" y="61" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">pi-tui</text>
  <text x="130" y="78" text-anchor="middle" font-size="10" fill="#64748b">@earendil-works/pi-tui</text>
  <rect x="30" y="116" width="200" height="44" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="130" y="133" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">pi-ai</text>
  <text x="130" y="150" text-anchor="middle" font-size="10" fill="#64748b">@earendil-works/pi-ai</text>
  <rect x="30" y="188" width="200" height="44" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="130" y="205" text-anchor="middle" font-size="13" font-weight="600" fill="#0d9488">pi-agent-core</text>
  <text x="130" y="222" text-anchor="middle" font-size="10" fill="#64748b">@earendil-works/pi-agent-core</text>
  <text x="130" y="237" text-anchor="middle" font-size="9" fill="#94a3b8">depends on: pi-ai</text>
  <rect x="460" y="116" width="260" height="72" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="590" y="141" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">pi-coding-agent</text>
  <text x="590" y="158" text-anchor="middle" font-size="10" fill="#64748b">@earendil-works/pi-coding-agent</text>
  <text x="590" y="174" text-anchor="middle" font-size="9" fill="#94a3b8">depends on: pi-tui, pi-ai, pi-agent-core</text>
  <line x1="230" y1="66" x2="460" y2="145" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="230" y1="138" x2="460" y2="152" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="230" y1="210" x2="460" y2="162" stroke="#0d9488" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="350" y1="210" x2="390" y2="138" stroke="#0d9488" stroke-width="1" stroke-dasharray="3,2"/>
  <text x="355" y="173" font-size="9" fill="#94a3b8">depends on</text>
  <text x="30" y="285" font-size="10" fill="#64748b">单向 DAG：tui / ai 是叶节点，agent-core 依赖 ai，coding-agent 依赖三者</text>
</svg>
<span class="figure-caption">图 R1.1 ｜ pi monorepo 四个 package 的单向依赖关系（从被依赖方指向依赖方）</span>

<details>
<summary>ASCII 原版</summary>

```
packages/
  tui/          @earendil-works/pi-tui
  ai/           @earendil-works/pi-ai
  agent/        @earendil-works/pi-agent-core
  coding-agent/ @earendil-works/pi-coding-agent

依赖关系（单向，从被依赖方指向依赖方）:

  pi-tui  ──────────────────────────────────┐
                                            |
  pi-ai  ───────────────────────────────────┤
            \                               |
  pi-agent-core  (depends on: pi-ai) ───────┤
                                            v
                              pi-coding-agent
                        (depends on: pi-tui, pi-ai,
                                     pi-agent-core)
```

</details>

各 package 的 `package.json` 版本号通过根脚本 `scripts/sync-versions.js` 保持同步（`package.json:23-26`），发版时四个包总是同一个版本号（README:62 提及 "lockstep versioning"，详见 `AGENTS.md:190`）。

**具体依赖声明来源**：
- `packages/agent/package.json:31`：`"@earendil-works/pi-ai": "^0.75.4"`
- `packages/coding-agent/package.json:41-44`：同时依赖 pi-agent-core、pi-ai、pi-tui

tui 没有依赖其他三者（`packages/tui/package.json` 仅有 `get-east-asian-width` 和 `marked` 两个外部依赖），是整个依赖树的叶节点。

---

## 1.4 四层架构总览图

从用户输入到 LLM 回包，整条调用链跨越四层：

```
  用户
    |
    | 键盘输入 / stdin / CLI args
    v
+---------+
|   TUI   |  @earendil-works/pi-tui
|         |  差分渲染、按键分发、ProcessTerminal
+---------+
    |
    | UI 事件 / 用户消息
    v
+------------------+
|  coding-agent    |  @earendil-works/pi-coding-agent
|  InteractiveMode |  模式分支、系统提示构建、工具注册
|  AgentSession    |  会话生命周期、compaction、扩展 runner
+------------------+
    |
    | AgentState.messages, tools, systemPrompt
    v
+------------------+
|   agent-core     |  @earendil-works/pi-agent-core
|   Agent          |  工具调用循环、agentic turn 状态机
+------------------+
    |
    | stream(model, context, options)
    v
+------------------+
|   pi-ai          |  @earendil-works/pi-ai
|   Provider impl  |  Anthropic / OpenAI / Google / Bedrock ...
+------------------+
    |
    | SSE / WebSocket / HTTP
    v
  LLM Provider API
```

---

## 1.5 CLI 启动引导链

### 1.5.1 `bin` 字段与 shebang

`packages/coding-agent/package.json:9-11`：

```json
"bin": {
  "pi": "dist/cli.js"
}
```

npm 全局安装后，`pi` 命令指向 `dist/cli.js`。构建脚本（`package.json:32`）在编译完成后自动执行 `shx chmod +x dist/cli.js`，确保可执行权限。

`cli.ts` 文件头部声明了 shebang（`packages/coding-agent/src/cli.ts:1`）：

```
#!/usr/bin/env node
```

### 1.5.2 cli.ts 的薄壳职责

`packages/coding-agent/src/cli.ts`（20 行）只做三件事：

```typescript
process.title = APP_NAME;                    // 设置进程标题（ps/top 显示为 "pi"）
process.env.PI_CODING_AGENT = "true";        // 环境标记，用于区分直接调用还是嵌入
process.emitWarning = (() => {}) as ...;     // 静默 Node.js 内部警告，避免污染 TUI 输出
configureHttpDispatcher();                   // 配置 undici 全局 dispatcher
main(process.argv.slice(2));                 // 转交给 main.ts
```

`configureHttpDispatcher()` 在 provider SDK 发出第一个请求之前就完成了配置，原因是某些 SDK（如 OpenAI SDK）在 import 时就初始化 HTTP 客户端（`packages/coding-agent/src/cli.ts:14-19`）。

### 1.5.3 main.ts 的参数解析与模式分支

`main.ts:425-456` 展示了启动顺序的顶层逻辑：

```typescript
export async function main(args: string[], options?: MainOptions) {
  resetTimings();
  // 1. 离线模式检测
  const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
  // 2. 平台特定处理（Windows 自更新隔离清理）
  // 3. 包管理子命令处理（pi config、pi install 等）
  if (await handlePackageCommand(args)) return;
  if (await handleConfigCommand(args)) return;
  // 4. 参数解析
  const parsed = parseArgs(args);
  // 5. 模式判定
  let appMode = resolveAppMode(parsed, process.stdin.isTTY);
```

`resolveAppMode`（`main.ts:100-111`）的判断优先级：

```typescript
function resolveAppMode(parsed: Args, stdinIsTTY: boolean): AppMode {
  if (parsed.mode === "rpc")  return "rpc";
  if (parsed.mode === "json") return "json";
  if (parsed.print || !stdinIsTTY) return "print";
  return "interactive";
}
```

注意 `!stdinIsTTY` 这个条件：当 stdin 不是终端（例如 `echo "fix the bug" | pi`），自动降级到 print 模式，不会尝试启动 TUI。

### 1.5.4 AgentSessionServices 装配

模式确定后，`main.ts:527-612` 构建了一个 `CreateAgentSessionRuntimeFactory` 闭包，将所有进程级固定输入（CLI 路径、authStorage、extension paths）捕获进去：

```typescript
const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd, agentDir, sessionManager, sessionStartEvent,
}) => {
  const services = await createAgentSessionServices({ cwd, agentDir, authStorage, ... });
  // services 包含: settingsManager, modelRegistry, resourceLoader
  const created = await createAgentSessionFromServices({ services, sessionManager, ... });
  return { ...created, services, diagnostics };
};
```

这个工厂设计（`agent-session-runtime.ts:29-34`）的关键在于**同一个工厂可以被多次调用**：每次用户执行 `/new`、`/resume` 或 `/fork` 时，`AgentSessionRuntime` 都会重新调用它来创建新的 session，从而复用所有进程级配置，但重建 cwd 绑定的服务。

`createAgentSessionRuntime`（`agent-session-runtime.ts:392-410`）把工厂返回的结果包装成一个 `AgentSessionRuntime` 实例：

```typescript
export async function createAgentSessionRuntime(
  createRuntime: CreateAgentSessionRuntimeFactory,
  options: { cwd, agentDir, sessionManager },
): Promise<AgentSessionRuntime> {
  assertSessionCwdExists(options.sessionManager, options.cwd);
  const result = await createRuntime(options);
  return new AgentSessionRuntime(
    result.session, result.services, createRuntime, result.diagnostics
  );
}
```

### 1.5.5 四种模式的最终分发

`main.ts:679-722`：

```typescript
if (appMode === "rpc") {
  await runRpcMode(runtime);
} else if (appMode === "interactive") {
  const interactiveMode = new InteractiveMode(runtime, { ... });
  await interactiveMode.run();
} else {
  // "print" or "json"
  const exitCode = await runPrintMode(runtime, { mode: toPrintOutputMode(appMode), ... });
}
```

---

## 1.6 四种运行模式

### 1.6.1 interactive（默认）

当 stdin 是 TTY 且没有传 `--print` 时激活。启动完整的 TUI：差分渲染的聊天界面、侧边面板、模型切换、session 管理等。这是 `pi` 的主体用法。

`InteractiveMode` 持有 `AgentSessionRuntime` 引用，通过 `runtime.session` 访问 `AgentSession`，通过 `runtime.services` 访问 settings、model registry 等。

### 1.6.2 print / text

通过 `--print` 或 stdin pipe 激活，也可以是 `pi "fix the bug"` 这类一次性调用。输出是纯文本流，方便脚本捕获。适合自动化场景：

```
pi --print "summarize this PR"
echo "explain this error" | pi
```

### 1.6.3 json

`--mode json`，与 print 相同但输出是 JSON 格式的 event stream，便于程序消费。每个事件对应 `AgentMessage` 的一个片段。

### 1.6.4 rpc

`--mode rpc`，通过 stdin/stdout 交换 JSON-RPC 消息，供 IDE 插件或其他进程控制 pi。RPC 模式禁止 `@file` 参数（`main.ts:481-484`），因为 stdin 已被 JSON-RPC 协议占用。

---

## 1.7 运行时内存对象拓扑

启动一个完整的 `pi` 进程后，内存中的核心对象及其关系如下：

```
process
  |
  +--[main.ts]---> AgentSessionRuntime (agent-session-runtime.ts:67)
                     |
                     +-- _session: AgentSession (agent-session.ts)
                     |     |
                     |     +-- agent: Agent           (pi-agent-core)
                     |     |     +-- state: AgentState
                     |     |           +-- messages: Message[]
                     |     |           +-- tools: AgentTool[]
                     |     |
                     |     +-- sessionManager: SessionManager
                     |     +-- extensionRunner: ExtensionRunner
                     |     +-- modelRegistry: ModelRegistry (引用自 services)
                     |     +-- settingsManager: SettingsManager (引用自 services)
                     |
                     +-- _services: AgentSessionServices
                     |     +-- cwd: string
                     |     +-- authStorage: AuthStorage   (auth.json / env API keys)
                     |     +-- settingsManager: SettingsManager
                     |     +-- modelRegistry: ModelRegistry
                     |     |     +-- (wraps pi-ai MODELS map)
                     |     |     +-- (holds custom models from models.json)
                     |     +-- resourceLoader: ResourceLoader
                     |           +-- extensions: Extension[]
                     |           +-- skills: Skill[]
                     |           +-- promptTemplates: PromptTemplate[]
                     |
                     +-- createRuntime: CreateAgentSessionRuntimeFactory
                           (闭包，捕获进程级 CLI 配置)

[interactive mode only]
  InteractiveMode
    +-- runtime: AgentSessionRuntime  (指针，非拷贝)
    +-- TUI (pi-tui)
          +-- ProcessTerminal
          +-- child components (ChatComponent, SidebarComponent ...)
```

关键设计决策：**`AgentSessionRuntime` 是 session 的所有者，而不是 InteractiveMode**。InteractiveMode 只持有 `runtime` 的引用。当用户执行 `/new` 时，InteractiveMode 调用 `runtime.newSession()`，runtime 内部完成 session 替换，然后通过 `rebindSession` 回调通知 InteractiveMode 重新绑定 UI 组件。这避免了 UI 层直接管理 session 生命周期，符合单一职责原则。

---

## 1.8 关键对象的初始化时序

```
npm run pi (or global pi)
  |
  cli.ts
    configureHttpDispatcher()   <-- undici 全局配置
    main(argv)
      |
      handlePackageCommand()    <-- 如果是包管理命令，提前返回
      parseArgs()
      resolveAppMode()
      |
      runMigrations()           <-- 读写 .pi/ 目录里的迁移状态
      |
      SettingsManager.create()  <-- 加载 global + project settings
      createSessionManager()    <-- 新建 / 打开 / fork session 文件
      |
      createAgentSessionRuntime(createRuntime, ...)
        |
        createRuntime(...)      <-- 调用工厂闭包
          createAgentSessionServices(...)
            ModelRegistry.create()     <-- 加载内置模型 + models.json 自定义模型
            DefaultResourceLoader()    <-- 扫描并加载 extensions, skills, themes
          createAgentSessionFromServices(...)
            createAgentSession(...)    <-- 创建 AgentSession + Agent
        |
        return AgentSessionRuntime
      |
      listModels() or printHelp()  <-- 如果是辅助命令，提前返回
      |
      switch(appMode)
        "interactive" -> InteractiveMode.run()
        "rpc"         -> runRpcMode()
        "print/json"  -> runPrintMode()
```

---

## 1.9 章节导读

后续章节与本章的对应关系：

| 章 | 主题 | 与本章的关联 |
|----|------|-------------|
| 02 | AI 层：多 Provider 抽象与模型注册表 | 深入 1.4 中 pi-ai 层 |
| 03 | agent-core：工具调用循环与状态机 | 深入 1.4 中 agent-core 层 |
| 04 | AgentSession：会话生命周期 | 深入 1.7 中 AgentSession 对象 |
| 05 | AgentSessionRuntime 与 session 替换 | 深入 1.7 中 AgentSessionRuntime |
| 06 | 扩展系统：Extension Runner 与事件协议 | 深入 1.7 中 extensionRunner |
| 07 | 工具系统：内置工具与自定义工具 | 深入 1.4 中工具注册路径 |
| 08 | 系统提示构建与 compaction | AgentSession 内部机制 |
| 09 | SessionManager：会话持久化与分支 | 深入 1.5.4 中 sessionManager |
| 10 | SettingsManager 与配置层次 | 深入 1.7 中 services.settingsManager |
| 11 | ModelRegistry 与 auth 存储 | 深入 1.7 中 services.modelRegistry |
| 12 | InteractiveMode 与 TUI 架构 | 深入 1.4 中 TUI 层 |
| 13 | Print 模式与 RPC 模式 | 深入 1.6.2-1.6.4 |
| 14 | 供应链加固与发版流程 | 深入 1.2.6 约束的实现细节 |

---

## 参考文件速查

| 文件 | 行数 | 核心职责 |
|------|------|---------|
| `README.md` | 90 | 项目定位、package 列表、开发命令 |
| `AGENTS.md` | 280 | 代码规范、架构约束、操作禁令 |
| `CONTRIBUTING.md` | 94 | 贡献门槛、哲学声明 |
| `package.json` | 59 | workspace 声明、构建脚本、版本 |
| `packages/coding-agent/package.json` | 98 | bin 字段、依赖声明 |
| `packages/coding-agent/src/cli.ts` | 20 | CLI shebang、转交 main |
| `packages/coding-agent/src/main.ts` | 723 | 参数解析、模式分支、runtime 装配 |
| `packages/coding-agent/src/core/agent-session-runtime.ts` | 419 | AgentSessionRuntime 类、session 替换 |
| `packages/coding-agent/src/core/agent-session-services.ts` | ~150 | cwd 绑定服务的创建 |
| `packages/coding-agent/src/core/agent-session.ts` | 3085 | AgentSession 完整实现 |
