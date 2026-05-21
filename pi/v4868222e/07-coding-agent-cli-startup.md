# 第 07 章 Coding Agent:CLI 启动与运行时装配

> **版本锁**: 本章所有文件引用均锁定在 commit `4868222e`(2026-05-20)。
> 代码库路径: `packages/coding-agent/src/`

---

## 7.1 两层薄壳:为什么 `cli.ts` 只有 21 行

```
packages/coding-agent/src/cli.ts          <- 第一层:ESM 入口
packages/coding-agent/src/main.ts         <- 第二层:真正的引导逻辑
```

`cli.ts:1-20` 做的事极少:

```typescript
// cli.ts:1-20
#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();
main(process.argv.slice(2));
```

**为什么分两层?** 这是 Node.js ESM 生态的标准做法,原因如下:

1. **隔离 shebang 行**: `#!/usr/bin/env node` 是 POSIX 脚本头,放在单独文件里可以让 `main.ts` 以纯模块形式被第三方代码 `import { main }` 而无需处理脚本头。

2. **全局副作用隔离**: `process.title` 设置、环境变量注入、`emitWarning` 静音、HTTP dispatcher 配置 —— 这些操作在进程级只应执行一次,且必须在所有提供商 SDK import 之前执行。如果这些代码混入 `main.ts`,库作者 `import { main }` 后会触发预期之外的副作用。

3. **可测试性**: `main.ts` 导出的 `main(args: string[])` 函数接收参数数组,测试代码可以直接调用而不需要 fork 子进程。

4. **Bun 入口并存**: `packages/coding-agent/src/bun/cli.ts` 是另一套 Bun 运行时入口,复用同一个 `main.ts`,两套运行时共享引导逻辑不共享 shim。

**`process.emitWarning` 静音**的原因: undici(Node.js fetch 的底层实现)和部分提供商 SDK 在初始化时会发出 `ExperimentalWarning`。这些警告在终端会干扰 TUI 渲染,静音是 CLI 工具的常规做法。

**`PI_CODING_AGENT=true`** 的原因: 让子进程(bash 工具启动的 shell)能感知自己运行在 pi 内部,部分 shell 脚本或扩展会据此改变行为。

---

## 7.2 `main.ts` 引导链

`main.ts:425-723` 定义的 `export async function main(args: string[], options?: MainOptions)` 是整个 CLI 的控制流骨架。执行顺序如下:

<svg viewBox="0 0 760 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="main.ts bootstrap chain: from args parsing through runtime assembly to mode dispatch">
  <defs>
    <marker id="ar71" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="260" y="10" width="240" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="30" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">main(args)</text>
  <line x1="380" y1="40" x2="380" y2="58" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="120" y="58" width="520" height="56" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="140" y="76" font-size="11" font-weight="600" fill="currentColor">前置初始化</text>
  <text x="140" y="92" font-size="10" fill="#64748b">resetTimings()  |  handlePackageCommand(args) → 直接返回  |  handleConfigCommand(args) → 直接返回</text>
  <text x="140" y="106" font-size="10" fill="#64748b">parseArgs(args)  →  Args 对象  |  resolveAppMode(parsed, isTTY) → interactive / print / json / rpc</text>
  <line x1="380" y1="114" x2="380" y2="132" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="260" y="132" width="240" height="28" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="151" text-anchor="middle" font-size="10" fill="#64748b">--version / --export → 速出(process.exit)</text>
  <line x1="380" y1="160" x2="380" y2="178" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="120" y="178" width="520" height="28" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="197" text-anchor="middle" font-size="10" fill="#64748b">runMigrations(cwd)  →  旧配置迁移,收集 deprecation 警告</text>
  <line x1="380" y1="206" x2="380" y2="224" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="120" y="224" width="520" height="28" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="243" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">createSessionManager(parsed, ...)  →  解析 session 标志,打开/创建</text>
  <line x1="380" y1="252" x2="380" y2="270" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="120" y="270" width="520" height="28" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="289" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">createAgentSessionRuntime(...)  →  装配 runtime (核心,见 7.3)</text>
  <line x1="380" y1="298" x2="380" y2="316" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="120" y="316" width="520" height="44" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="335" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">准备入口消息</text>
  <text x="140" y="352" font-size="10" fill="#64748b">读取 piped stdin → print 模式  |  prepareInitialMessage()  |  initTheme()</text>
  <line x1="380" y1="360" x2="380" y2="378" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="120" y="378" width="520" height="30" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="398" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">分支到具体运行模式</text>
  <line x1="230" y1="408" x2="200" y2="430" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <line x1="380" y1="408" x2="380" y2="430" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <line x1="530" y1="408" x2="560" y2="430" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <rect x="80" y="430" width="240" height="30" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="200" y="450" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">rpc → runRpcMode(runtime)</text>
  <rect x="255" y="430" width="250" height="30" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="450" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">interactive → InteractiveMode.run()</text>
  <rect x="430" y="430" width="250" height="30" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="555" y="450" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">print/json → runPrintMode()</text>
</svg>
<span class="figure-caption">图 R7.1 ｜ main.ts 引导链——从参数解析到 runtime 装配到模式分发</span>

<details>
<summary>ASCII 原版</summary>

```
main(args)
  │
  ├─ resetTimings()                          检测 --offline / PI_OFFLINE
  ├─ handlePackageCommand(args)              → 如果是 install/remove/update 等命令,直接返回
  ├─ handleConfigCommand(args)              → config 命令,直接返回
  │
  ├─ parseArgs(args)           args.ts      → 解析所有 CLI 参数,生成 Args 对象
  ├─ resolveAppMode(parsed, isTTY)          → 决定 "interactive/print/json/rpc"
  │
  ├─ 处理速出标志
  │   ├─ --version → 打印版本,process.exit(0)
  │   └─ --export  → 导出 HTML,process.exit(0)
  │
  ├─ runMigrations(cwd)                     → 旧配置迁移,收集 deprecation 警告
  │
  ├─ createSessionManager(parsed, ...)      → 解析 session 标志,打开/创建 SessionManager
  │
  ├─ createAgentSessionRuntime(...)         → 装配 runtime (核心,见 7.3)
  │
  ├─ 读取 piped stdin                       → 如果有管道输入,强制切换到 print 模式
  ├─ prepareInitialMessage(...)             → 处理 @file 参数和消息内容
  ├─ initTheme(...)                         → 初始化颜色主题
  │
  └─ 分支到具体模式
      ├─ rpc         → runRpcMode(runtime)
      ├─ interactive → new InteractiveMode(runtime).run()
      └─ print/json  → runPrintMode(runtime, { mode })
```

</details>

---

## 7.3 参数解析:`parseArgs` 的设计原则

`cli/args.ts:59-189` 实现了一个手写的单遍参数解析器(没有使用 `commander` 或 `yargs`)。

**为什么不用现成的参数解析库?**
- pi 的参数集包含**扩展自定义 flag**,这些 flag 在解析时还未知(扩展尚未加载)。手写解析器可以把未知 `--flag` 收集到 `unknownFlags: Map<string, boolean | string>`,扩展加载后再做二次验证。
- `yargs` / `commander` 对未知参数的处理是报错退出,无法支持这个"先收集后验证"的两阶段模式。

核心数据结构:

```typescript
// args.ts:12-51
export interface Args {
  provider?: string;
  model?: string;
  apiKey?: string;
  print?: boolean;
  mode?: Mode;          // "text" | "json" | "rpc"
  session?: string;
  fork?: string;
  resume?: boolean;
  continue?: boolean;
  noTools?: boolean;
  tools?: string[];
  thinking?: ThinkingLevel;
  messages: string[];       // positional args
  fileArgs: string[];       // @file.md 展开后的路径
  unknownFlags: Map<string, boolean | string>;  // 扩展 flag 暂存
  diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}
```

**模式解析逻辑** (`main.ts:100-111`):

```typescript
function resolveAppMode(parsed: Args, stdinIsTTY: boolean): AppMode {
  if (parsed.mode === "rpc") return "rpc";
  if (parsed.mode === "json") return "json";
  if (parsed.print || !stdinIsTTY) return "print";
  return "interactive";
}
```

当 stdin 不是 TTY(即管道输入)时,自动进入 print 模式。这使 `echo "foo" | pi` 与 `pi -p "foo"` 行为一致。

**全局 flags**:

| Flag | 类型 | 效果 |
|------|------|------|
| `--version` / `-v` | boolean | 打印版本号,立即退出 |
| `--help` / `-h` | boolean | 延迟处理,等扩展加载后打印(含扩展 flag 列表) |
| `--offline` | boolean | 设置 `PI_OFFLINE=1`,跳过版本检查网络请求 |
| `--verbose` | boolean | 强制显示启动信息,覆盖 `quietStartup` 设置 |

注意 `--help` 的处理时机在 `main.ts:628-629` 而非参数解析完毕后立即处理,目的是等到 `resourceLoader` 加载完扩展,才能打印完整的扩展 flag 说明。

---

## 7.4 `AgentSessionServices`:cwd 绑定的运行时服务

`core/agent-session-services.ts` 定义了两个核心函数:

### `createAgentSessionServices`

```typescript
// agent-session-services.ts:129-170
export async function createAgentSessionServices(
  options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
  const authStorage = options.authStorage ?? AuthStorage.create(...);
  const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
  const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, ...);
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, ... });
  await resourceLoader.reload();
  // 处理扩展的 pending provider 注册
  // 处理 extension flag 值注入
  return { cwd, agentDir, authStorage, settingsManager, modelRegistry, resourceLoader, diagnostics };
}
```

**为什么要把 services 和 session 分开创建?**

`AgentSessionServices` 是"基础设施",`AgentSession` 是"业务实体"。当用户执行 `/resume` 切换到另一个 cwd 的 session 时,services 需要针对新 cwd 重新创建(路径解析、project-local settings、资源发现全部依赖 cwd),而这个过程需要在创建 session 之前发生。将两者分离使得切换流程能写成:

```
teardown old session
  → createAgentSessionServices({ cwd: newCwd })
  → createAgentSessionFromServices({ services, ... })
  → bind new session to runtime
```

**`AgentSessionServices` 包含**:

| 字段 | 类型 | 作用 |
|------|------|------|
| `cwd` | `string` | 当前工作目录(project-local 上下文) |
| `authStorage` | `AuthStorage` | 凭据读写(API key + OAuth token) |
| `settingsManager` | `SettingsManager` | 用户设置(全局 + 项目级合并) |
| `modelRegistry` | `ModelRegistry` | 模型注册表(含扩展注册的 provider) |
| `resourceLoader` | `ResourceLoader` | 扩展/技能/提示模板/主题/上下文文件 |
| `diagnostics` | `AgentSessionRuntimeDiagnostic[]` | 启动期收集的警告和错误 |

---

## 7.5 `AgentSessionRuntime`:可替换的 session 持有者

`core/agent-session-runtime.ts:67-384` 定义 `AgentSessionRuntime` 类。

**核心职责**: 它是 `AgentSession` 和 `AgentSessionServices` 的持有者,同时封装了 session 替换逻辑(`switchSession` / `newSession` / `fork` / `importFromJsonl`)。

**不是单例**: 每次 `createAgentSessionRuntime(factory, options)` 都返回一个新实例。但在一次 `pi` 进程生命周期内,只有一个 runtime 实例存在。session 替换发生时,runtime 对象不变,内部的 `_session` 和 `_services` 被原子替换。

**替换 session 的流程** (`agent-session-runtime.ts:186-208`):

```typescript
async switchSession(sessionPath, options?) {
  const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
  if (beforeResult.cancelled) return beforeResult;

  await this.teardownCurrent("resume", ...);  // 触发 session_shutdown 扩展事件
  this.apply(                                 // 原子更新内部引用
    await this.createRuntime({ cwd, agentDir, sessionManager, ... })
  );
  await this.finishSessionReplacement(...);   // 回调 UI 层绑定新 session
  return { cancelled: false };
}
```

`createRuntime` 是从外部传入的工厂函数(闭包捕获了 CLI 解析的所有参数),每次 session 切换都会重新执行完整的 services + session 创建流程,确保新 session 的 settings / 扩展 / 工具集与其 cwd 对应。

**`setRebindSession` 回调**:各个 mode 在初始化时通过 `runtime.setRebindSession(fn)` 注册一个回调。每当 session 被替换,runtime 就调用这个回调通知 mode 层重新绑定 session 引用、重新订阅事件。这是 runtime 与 mode 之间唯一的通信路径。

---

## 7.6 `AgentSession`:从构造到第一个 prompt

`core/agent-session.ts:251-342` 中 `AgentSession` 构造函数做了以下事情:

```typescript
constructor(config: AgentSessionConfig) {
  this.agent = config.agent;
  this.sessionManager = config.sessionManager;
  this._cwd = config.cwd;
  // ... 保存所有 config 字段
  this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
  this._installAgentToolHooks();
  this._buildRuntime({
    activeToolNames: this._initialActiveToolNames,
    includeAllExtensionTools: true,
  });
}
```

**`_buildRuntime`** 负责:
- 从 `createAllToolDefinitions(cwd)` 创建 7 个内置工具定义
- 从 `resourceLoader.getExtensions()` 收集扩展工具
- 合并工具列表,应用 `allowedToolNames` 过滤
- 构建 system prompt(调用 `buildSystemPrompt(...)`)
- 把工具注册到 `agent.state.tools`

**`prompt(text, options?)` 入口**(`agent-session.ts:~600+`):

<svg viewBox="0 0 640 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="session.prompt pipeline: skill parsing, template expansion, extension input hook, user message assembly, agent loop entry">
  <defs>
    <marker id="ar72" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="120" y="10" width="400" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="31" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">session.prompt("请帮我重构这个函数")</text>
  <line x1="320" y1="42" x2="320" y2="58" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <rect x="80" y="58" width="480" height="26" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="76" text-anchor="middle" font-size="11" fill="#64748b">解析 skill block（如果文本以 &lt;skill...&gt; 开头）</text>
  <line x1="320" y1="84" x2="320" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <rect x="80" y="100" width="480" height="26" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="118" text-anchor="middle" font-size="11" fill="#64748b">扩展 prompt template（如果文本匹配模板名）</text>
  <line x1="320" y1="126" x2="320" y2="142" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <rect x="80" y="142" width="480" height="26" rx="5" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="320" y="160" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">触发 input 扩展事件（允许扩展拦截/变换输入）</text>
  <line x1="320" y1="168" x2="320" y2="184" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <rect x="80" y="184" width="480" height="26" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="202" text-anchor="middle" font-size="11" fill="#64748b">组装 user message（含图片 ImageContent）</text>
  <line x1="320" y1="210" x2="320" y2="226" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <rect x="80" y="226" width="480" height="26" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="244" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">agent.prompt(userMessage)  →  进入 agent-core 的 loop</text>
  <line x1="320" y1="252" x2="320" y2="264" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)" stroke-dasharray="3,2"/>
  <text x="320" y="276" text-anchor="middle" font-size="10" fill="#94a3b8">流式事件通过 _handleAgentEvent 转发给 subscribers</text>
</svg>
<span class="figure-caption">图 R7.2 ｜ session.prompt() 管线——从输入文本到进入 agent-core loop</span>

<details>
<summary>ASCII 原版</summary>

```
session.prompt("请帮我重构这个函数")
  │
  ├─ 解析 skill block(如果文本以 <skill...> 开头)
  ├─ 扩展 prompt template(如果文本匹配模板名)
  ├─ 触发 input 扩展事件(允许扩展拦截/变换输入)
  ├─ 组装 user message(含图片 ImageContent)
  ├─ agent.prompt(userMessage)          → 进入 agent-core 的 loop
  └─ 流式事件通过 _handleAgentEvent 转发给 subscribers
```

</details>

**session 文件**:新 session 在第一条消息写入时创建 JSONL 文件。`SessionManager.create(cwd)` 只预分配了路径,实际写入由 `_handleAgentEvent` 监听 `message_end` 事件后触发 `sessionManager.appendMessage(...)` 完成。

---

## 7.7 四种运行模式

### 7.7.1 Interactive 模式

`modes/interactive/interactive-mode.ts` 实现了完整的 TUI 主循环。启动序列:

```typescript
// main.ts:683-707
const interactiveMode = new InteractiveMode(runtime, {
  migratedProviders,
  initialMessage,
  initialImages,
  ...
});
await interactiveMode.run();
```

TUI 使用 `@earendil-works/pi-tui` 包,基于 `TUI` + `ProcessTerminal` 构建。interactive 模式细节留给第 12 章展开。

### 7.7.2 Print 模式(`pi -p "prompt"`)

`modes/print-mode.ts` 实现单次响应模式:

```typescript
// print-mode.ts:32-158
export async function runPrintMode(runtimeHost, options): Promise<number> {
  await rebindSession();
  if (initialMessage) {
    await session.prompt(initialMessage, { images });
  }
  for (const message of messages) {
    await session.prompt(message);
  }
  // text 模式:从最后一条 assistant 消息提取文本打印
  // json 模式:所有 AgentSessionEvent 以 JSON 行格式写到 stdout
}
```

**特性**:
- `takeOverStdout()` 将 `console.log` 重定向到 stderr,保证 stdout 只有工具输出(便于管道)
- 注册 `SIGTERM` / `SIGHUP` 信号处理,确保 session 文件被正确关闭

### 7.7.3 JSON 模式(`--mode json`)

与 print 模式共用 `runPrintMode`,通过 `mode: "json"` 参数切换输出格式。每个 `AgentSessionEvent` 被序列化为一行 JSON 写到 stdout:

```typescript
// print-mode.ts:103-106
unsubscribe = session.subscribe((event) => {
  if (mode === "json") {
    writeRawStdout(`${JSON.stringify(event)}\n`);
  }
});
```

第一行输出是 session header(包含 session ID、cwd、版本等元数据)。这个格式为机器消费设计:外部工具可以流式解析 AgentSession 的全部事件,包括 tool call、tool result、思考块等。

### 7.7.4 RPC 模式(`--mode rpc`)

`modes/rpc/rpc-mode.ts` 实现双向 JSON-RPC over stdio:

```
stdin  → 逐行读取 JSON command 对象
stdout → 流式输出 AgentSessionEvent 对象 + response 对象
```

RPC 模式与 print/json 模式的核心区别:

| 维度 | Print/JSON | RPC |
|------|-----------|-----|
| 输入来源 | CLI 参数一次性 | stdin 持续读取 |
| 生命周期 | 单次响应后退出 | 长连接,直到 stdin 关闭 |
| session 控制 | 不支持 | 支持 `new_session`/`switch_session`/`fork` |
| 扩展 UI | 不支持 | 通过 `extension_ui_request` 事件代理 |

RPC 命令处理 (`rpc-mode.ts:371-659`) 覆盖了完整的 session 控制面:

```typescript
case "prompt":    void session.prompt(command.message, ...)
case "abort":     await session.abort()
case "new_session": await runtimeHost.newSession(...)
case "compact":   await session.compact(...)
case "set_model": await session.setModel(model)
case "bash":      await session.executeBash(command.command)
// ... 共 20+ 个命令
```

**进程退出条件**:
- stdin 关闭 (`onInputEnd`) → `shutdown(0)`
- `SIGTERM` → `shutdown(143)`
- `SIGHUP` → `shutdown(129)`
- 扩展调用 `ctx.shutdown()` → `shutdownRequested = true` → 下次命令处理后退出

---

## 7.8 信号与 Shutdown 路径

### Ctrl+C (SIGINT)

Interactive 模式:TUI 的 `ProcessTerminal` 捕获 `ctrl+c` 键序列 `\x03`。如果当前有 agent 在流式响应,发送 abort 信号;如果 agent 已空闲,触发退出确认对话框。

Print/JSON 模式:不注册 SIGINT 处理。Node.js 默认行为是立即退出(exit code 130)。

RPC 模式:不注册 SIGINT 处理,由宿主进程负责管理。

### SIGTERM / SIGHUP

Print 和 RPC 模式都显式注册:

```typescript
// print-mode.ts:47-64
const signals: NodeJS.Signals[] = ["SIGTERM"];
if (process.platform !== "win32") signals.push("SIGHUP");
for (const signal of signals) {
  const handler = () => {
    killTrackedDetachedChildren();
    void disposeRuntime().finally(() => {
      process.exit(signal === "SIGHUP" ? 129 : 143);
    });
  };
  process.on(signal, handler);
}
```

`killTrackedDetachedChildren()` 确保 bash 工具启动的分离子进程(detached process group)不会成为孤儿进程。

### Ctrl+D (stdin EOF)

RPC 模式: `process.stdin.on("end", onInputEnd)` → `shutdown(0)`。

Interactive 模式:TUI 将 `ctrl+d` 解释为"清空编辑器内容",如果编辑器已空则触发退出确认。

### `runtime.dispose()`

所有路径最终都调用 `runtime.dispose()`:

```typescript
// agent-session-runtime.ts:376-383
async dispose(): Promise<void> {
  await emitSessionShutdownEvent(this.session.extensionRunner, {
    type: "session_shutdown",
    reason: "quit",
  });
  this.beforeSessionInvalidate?.();
  this.session.dispose();
}
```

`session_shutdown` 事件让扩展有机会做清理(关闭文件句柄、保存状态等),`session.dispose()` 取消 agent 事件订阅并释放内部资源。

---

## 7.9 启动时间线:从敲下 `pi` 到第一条 prompt 就绪

```
[shell]  $ pi "帮我写一个单测"
    |
    v
[Node.js bootstrap]
    process.title = "pi"
    process.env.PI_CODING_AGENT = "true"
    configureHttpDispatcher()        <- 配置 undici global dispatcher
    main(process.argv.slice(2))
    |
    v
[main() phase 1: 快速路径]
    resetTimings()
    parseArgs(["帮我写一个单测"])
      -> Args { messages: ["帮我写一个单测"], ... }
    resolveAppMode() -> "interactive"  (stdin 是 TTY)
    handlePackageCommand()   -> false (不是 install 等命令)
    handleConfigCommand()    -> false
    |
    v
[main() phase 2: session 选择]
    runMigrations(cwd)               <- 旧配置迁移
    SettingsManager.create(cwd)      <- 加载 global + project settings
    createSessionManager(parsed, ...) <- parsed.continue/resume/session 决定路径
      -> SessionManager.create(cwd)  (新 session)
    |
    v
[main() phase 3: runtime 装配]
    createAgentSessionRuntime(factory, ...)
      |
      +-> factory({cwd, agentDir, sessionManager})
            createAgentSessionServices({...})
              AuthStorage.create()
              SettingsManager.create()
              ModelRegistry.create()
              DefaultResourceLoader.reload()  <- 发现扩展/技能/主题
              [apply extension provider registrations]
            buildSessionOptions()    <- 解析 --model --thinking --tools
            createAgentSessionFromServices()
              createAgentSession()
                new Agent(...)       <- 创建 pi-agent-core Agent
                new AgentSession(...)
                  _buildRuntime()   <- 注册 7 个内置工具 + 扩展工具
                  buildSystemPrompt() <- 组装 system prompt
    |
    v
[main() phase 4: 模式准备]
    configureHttpDispatcher(idleTimeoutMs)
    readPipedStdin()   <- stdin 是 TTY,立即返回 undefined
    prepareInitialMessage()  <- "帮我写一个单测" 直接用
    initTheme(settingsManager.getTheme(), true)
    |
    v
[InteractiveMode 启动]
    new InteractiveMode(runtime, { initialMessage: "帮我写一个单测", ... })
    interactiveMode.run()
      new TUI(new ProcessTerminal(), ...)
      [渲染首屏: 模型信息、会话信息、输入框]
      [如果有 initialMessage: 自动提交第一条 prompt]
    |
    v
[用户看到 TUI 界面, agent 开始处理]
```

整个流程中 `time("...")` 调用会在 `PI_STARTUP_BENCHMARK=1` 时打印各阶段耗时(参见 `main.ts:673-703`)。

---

## 7.10 `CreateAgentSessionRuntimeFactory`:为什么用工厂而非直接构建

`agent-session-runtime.ts:29-34` 定义了工厂类型:

```typescript
export type CreateAgentSessionRuntimeFactory = (options: {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
  sessionStartEvent?: SessionStartEvent;
}) => Promise<CreateAgentSessionRuntimeResult>;
```

工厂的作用是**捕获 CLI 参数的闭包**。`main.ts:528-613` 的 `createRuntime` 闭包捕获了 `parsed`(CLI 解析结果)、`authStorage`、`resolvedExtensionPaths` 等只需要在进程启动时解析一次的值。后续每次 session 切换调用这个工厂时,这些值自动可用,不需要重新传递。

这个设计的关键优势:session 切换路径(`AgentSessionRuntime.switchSession`)只需要传入新的 `cwd` 和 `sessionManager`,工厂会自动用正确的 CLI 参数装配新 session。

---

## 参考文件索引

| 文件 | 关键内容 |
|------|---------|
| `src/cli.ts:1-20` | ESM 入口,process 全局配置 |
| `src/main.ts:98-115` | `resolveAppMode` 模式判定 |
| `src/main.ts:425-723` | `main()` 完整引导流程 |
| `src/cli/args.ts:12-51` | `Args` 接口定义 |
| `src/cli/args.ts:59-189` | `parseArgs` 实现 |
| `src/core/agent-session-services.ts:64-170` | services 创建 |
| `src/core/agent-session-runtime.ts:67-384` | `AgentSessionRuntime` 类 |
| `src/core/sdk.ts:193-413` | `createAgentSession` 完整实现 |
| `src/modes/print-mode.ts:32-158` | print/json 模式 |
| `src/modes/rpc/rpc-mode.ts:48-754` | RPC 模式 |
