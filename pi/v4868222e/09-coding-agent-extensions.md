# 第 09 章 Coding Agent:扩展机制与自定义 Provider

> **版本锁定**:本章内容基于 commit `4868222e`(2026-05-20),所有行号引用均对应该快照,后续提交可能造成偏移。

---

## 9.1 扩展机制解决什么问题

pi 作为一个终端 agent harness,其核心功能(Anthropic provider、内置工具链、会话管理)被封装在 `packages/coding-agent` 内。但不同团队对 agent 的需求千差万别:

- 有人需要将请求路由到企业代理(GitLab Duo、自建 LLM 网关)
- 有人需要在每次工具调用前注入额外的审计日志
- 有人需要在 TUI 里展示自定义 Widget(状态栏、标题栏、覆盖层)
- 有人需要拦截 bash 命令并接入 OS 沙盒

最直接的做法是 fork 主仓库然后修改。但这会丢失上游更新,且每个团队的需求无法组合复用。

扩展机制提供的答案是:**在宿主进程内动态加载用户提供的 TypeScript 文件**,赋予它注册 hook、工具、命令、provider 的能力,同时保持主仓库代码不变。

关键设计约束:
1. 扩展文件是 `.ts` 源码,不需要预编译。宿主进程在运行时即时转译。
2. 扩展 `import` 宿主提供的模块(如 `@earendil-works/pi-ai`)时,解析到的是宿主进程内已加载的同一实例,而非 npm 中新安装的副本。
3. 扩展抛错时不应崩溃宿主进程;每个扩展独立隔离。
4. 扩展可带自己的 `node_modules` 依赖,只要这些依赖不与宿主模块冲突。

---

## 9.2 jiti 动态加载

### 9.2.1 为什么选 jiti 而不直接 `import()`

Node.js 的 `import()` 只能加载 `.js`/`.mjs` 文件,对 `.ts` 无能为力;若先用 `tsc` 编译再 `import`,则需要文件系统中存在 `tsconfig.json`、依赖包的 `d.ts` 文件,且编译时间对启动体验有负面影响。

[jiti](https://github.com/unjs/jiti) 是一个轻量的 TS/ESM 运行时加载器,在内部通过 `esbuild`(或 `oxc`)即时将 `.ts` 转译为 JS,然后通过 Node.js `vm` 模块执行。其核心优势:

- **零配置转译**:直接传文件路径,jiti 自动处理 TypeScript 语法。
- **模块路径别名**(`alias` 选项):将特定模块说明符重定向到宿主已解析的文件路径,而不触发 npm 解析。
- **Virtual modules**(`virtualModules` 选项):直接将内存中的对象映射到模块说明符,完全绕过文件系统。
- **moduleCache: false**:每次 `jiti.import()` 都从头加载,避免不同扩展之间的缓存污染。

### 9.2.2 jiti 如何执行 TS 源码

`loader.ts:357-368`

```typescript
async function loadExtensionModule(extensionPath: string) {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    ...(isBunBinary
      ? { virtualModules: VIRTUAL_MODULES, tryNative: false }
      : { alias: getAliases() }),
  });

  const module = await jiti.import(extensionPath, { default: true });
  const factory = module as ExtensionFactory;
  return typeof factory !== "function" ? undefined : factory;
}
```

调用路径:
1. `createJiti(baseUrl, options)` —— 创建一个 jiti 实例,`baseUrl` 用于解析相对路径。
2. `jiti.import(extensionPath, { default: true })` —— 读取 `.ts` 文件,用 esbuild 转译为 CommonJS(或 ESM),再执行。`{ default: true }` 表示返回默认导出。
3. 若返回值不是函数,则视为无效扩展返回 `undefined`。

### 9.2.3 require/import cache 隔离

`moduleCache: false` 的意义:jiti 内部维护一个模块缓存表,默认情况下第二次 `import` 同一路径直接返回缓存对象。对扩展系统而言,这是危险的——如果两个不同扩展都 `import` 了同一个第三方库的不同版本,缓存会使其中一个拿到错误版本。

设为 `false` 后,每次 `loadExtensionModule` 调用都产生一个全新的 jiti 实例,彼此间的模块缓存完全隔离。代价是相同模块会被多次解析,但对于"启动时加载少量扩展"的场景,性能影响可以接受。

### 9.2.4 Bun 二进制中的静态捆绑回退路径

当 pi 以 `bun build --compile` 打包为单一可执行二进制时,`node_modules` 不存在于文件系统。`isBunBinary`(来自 `config.ts`)检测当前是否在 Bun 编译产物中运行。

若是 Bun 二进制:
- **`virtualModules: VIRTUAL_MODULES`**:将宿主包的模块说明符映射到内存中已加载的导出对象(见第 9.3 节)。
- **`tryNative: false`**:禁止 jiti 尝试用 Node.js 原生 `require` 解析依赖,因为二进制中没有可解析的文件路径。

若是开发环境(Node.js):
- **`alias: getAliases()`**:将宿主包说明符重定向到工作区中实际的 `.js` 文件路径(`packages/agent/dist/index.js` 等),让 jiti 通过普通文件系统解析。

---

## 9.3 Virtual modules:宿主模块注入

`loader.ts:44-61`

```typescript
const VIRTUAL_MODULES: Record<string, unknown> = {
  typebox: _bundledTypebox,
  "typebox/compile": _bundledTypeboxCompile,
  "typebox/value": _bundledTypeboxValue,
  "@sinclair/typebox": _bundledTypebox,
  "@earendil-works/pi-agent-core": _bundledPiAgentCore,
  "@earendil-works/pi-tui": _bundledPiTui,
  "@earendil-works/pi-ai": _bundledPiAi,
  "@earendil-works/pi-ai/oauth": _bundledPiAiOauth,
  "@earendil-works/pi-coding-agent": _bundledPiCodingAgent,
  // 旧包名别名
  "@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
  // ...
};
```

`_bundledPiAi` 等变量是文件顶部的**静态导入**(`import * as _bundledPiAi from "@earendil-works/pi-ai"`):

```typescript
// loader.ts:11-20
import * as _bundledPiAgentCore from "@earendil-works/pi-agent-core";
import * as _bundledPiAi from "@earendil-works/pi-ai";
import * as _bundledPiAiOauth from "@earendil-works/pi-ai/oauth";
import * as _bundledPiTui from "@earendil-works/pi-tui";
import * as _bundledPiCodingAgent from "../../index.ts";
```

**为什么必须是静态导入**:注释写得很清楚:

> These MUST be static so Bun bundles them into the compiled binary.

动态 `import()` 在 Bun 打包时不会被识别为需要捆绑的依赖,会在运行时失败。静态导入确保 Bun 在编译阶段将这些包嵌入二进制。

**注入机制**:当扩展代码执行 `import { stream } from "@earendil-works/pi-ai"` 时,jiti 在解析该 import 之前先查询 `virtualModules` 表。如果命中,直接返回对应的内存对象,**不访问文件系统**。这意味着扩展与宿主进程共享同一份 `@earendil-works/pi-ai` 实例——状态、类型、单例都是统一的。

**本质**:这是一种受控的依赖注入(Dependency Injection),通过模块系统接口实现,而非通过函数参数传递。好处是扩展代码的 `import` 语句与正常 npm 包没有任何区别,对扩展开发者透明。

---

## 9.4 扩展类型契约

### 9.4.1 ExtensionFactory

`types.ts:1379`

```typescript
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

- **同步或异步均可**:返回 `void` 或 `Promise<void>`。加载器会 `await factory(api)`,所以异步初始化(如读取配置文件、建立网络连接)完全合法。
- **接收 `ExtensionAPI`**:这是扩展唯一的 "根" 接口,通过它完成所有注册和操作。

### 9.4.2 Extension 接口(内部载体)

`types.ts:1538-1548`

```typescript
export interface Extension {
  path: string;           // 扩展文件路径(用户提供的原始路径)
  resolvedPath: string;   // 解析后的绝对路径
  sourceInfo: SourceInfo; // 源信息(用于诊断和 UI 显示)
  handlers: Map<string, HandlerFn[]>;         // 事件名 -> 处理函数列表
  tools: Map<string, RegisteredTool>;         // 工具名 -> 工具定义
  messageRenderers: Map<string, MessageRenderer>; // 自定义消息类型渲染器
  commands: Map<string, RegisteredCommand>;   // 斜杠命令
  flags: Map<string, ExtensionFlag>;          // CLI flags
  shortcuts: Map<KeyId, ExtensionShortcut>;   // 键盘快捷键
}
```

这是扩展加载后在内存中的表示。`ExtensionAPI` 上的每个 `register*` 方法都会向对应的 Map 中插入条目。

### 9.4.3 注册自定义 Provider

`types.ts:1292`

```typescript
registerProvider(name: string, config: ProviderConfig): void;
```

`ProviderConfig` 的主要字段(`types.ts:1318-1348`):

| 字段 | 类型 | 用途 |
|------|------|------|
| `baseUrl` | `string` | API 端点 URL |
| `apiKey` | `string` | 环境变量名或字面值 |
| `api` | `Api` | API 类型(`"anthropic-messages"` / `"openai-responses"` / 自定义) |
| `models` | `ProviderModelConfig[]` | 模型列表,替换该 provider 的所有现有模型 |
| `streamSimple` | `(model, context, options) => Stream` | 自定义流式处理函数 |
| `oauth` | `{ name, login, refreshToken, getApiKey }` | OAuth 支持 |
| `headers` | `Record<string, string>` | 额外 HTTP 头 |

若只传 `baseUrl`(不传 `models`),则仅覆盖已有 provider 的 URL;若传 `models`,则替换该 provider 名下所有模型。

---

## 9.5 生命周期 Hooks

扩展通过 `pi.on(eventName, handler)` 注册事件。所有事件名及其语义来自 `types.ts:1084-1127`。

### 完整事件表

| 事件名 | 触发时机 | 返回值采纳方式 |
|--------|----------|----------------|
| `resources_discover` | `session_start` 之后,允许扩展提供额外资源路径 | 返回 `{ skillPaths, promptPaths, themePaths }` 追加到资源列表 |
| `session_start` | 会话启动/加载/重载 | 无返回值 |
| `session_before_switch` | 切换会话前 | 返回 `{ cancel: true }` 可中止切换 |
| `session_before_fork` | fork 会话前 | 返回 `{ cancel: true }` 可中止 fork |
| `session_before_compact` | context 压缩前 | 返回 `{ cancel: true }` 或提供自定义压缩结果 |
| `session_compact` | 压缩完成后 | 无返回值 |
| `session_shutdown` | 运行时销毁前(quit/reload/session 替换) | 无返回值 |
| `session_before_tree` | 会话树导航前 | 返回 `{ cancel: true }` 或自定义摘要 |
| `session_tree` | 会话树导航完成后 | 无返回值 |
| `context` | 每次 LLM 调用前 | 返回 `{ messages }` 替换消息列表 |
| `before_provider_request` | provider 请求发送前 | 返回值替换整个请求 payload |
| `after_provider_response` | provider 响应接收后、流消费前 | 无返回值(可检查 headers) |
| `before_agent_start` | 用户提交 prompt 后、agent 循环开始前 | 返回 `{ message, systemPrompt }` 注入系统消息或替换 system prompt |
| `agent_start` | agent 循环开始 | 无返回值 |
| `agent_end` | agent 循环结束 | 无返回值 |
| `turn_start` | 每个 turn 开始 | 无返回值 |
| `turn_end` | 每个 turn 结束 | 无返回值 |
| `message_start` | 消息开始(user/assistant/toolResult) | 无返回值 |
| `message_update` | assistant 消息 token-by-token 更新 | 无返回值 |
| `message_end` | 消息结束 | 返回 `{ message }` 替换最终消息(角色必须保持不变) |
| `tool_execution_start` | 工具开始执行 | 无返回值 |
| `tool_execution_update` | 工具执行期间流式输出 | 无返回值 |
| `tool_execution_end` | 工具执行结束 | 无返回值 |
| `model_select` | 新模型被选中 | 无返回值 |
| `thinking_level_select` | 思考级别变更 | 无返回值 |
| `tool_call` | 工具调用前 | 返回 `{ block: true }` 阻止执行;原地 mutate `event.input` 修改参数 |
| `tool_result` | 工具执行后 | 返回 `{ content, details, isError }` 修改结果 |
| `user_bash` | 用户 `!` 命令执行前 | 返回自定义 bash 操作或替代结果 |
| `input` | 用户输入处理前 | 返回 `{ action: "transform", text }` 修改输入,或 `{ action: "handled" }` 短路 |

### 关于返回值被采纳的规则

并非所有 hook 的返回值都有效。规则如下:
- `session_before_*` 事件:返回 `{ cancel: true }` 立即短路,后续 handler 不再执行(`runner.ts:694-696`)。
- `context`、`before_provider_request`、`tool_result`:链式传播——前一个 handler 的返回值作为下一个 handler 的输入(`runner.ts:868-888`)。
- `message_end`:链式消息替换,每个 handler 看到的是前一个 handler 修改后的消息(`runner.ts:724-753`)。
- `input`:`"handled"` 立即短路;`"transform"` 修改后继续传递给下一个 handler。
- 无返回值声明的事件:handler 的返回值被忽略。

---

## 9.6 Runner:执行模型与异常隔离

`ExtensionRunner` 类(`runner.ts:224-1068`)是所有已加载扩展的中央调度器。

### 9.6.1 串行执行

所有 hook 调用均为**串行**。`emit()` 方法的核心结构(`runner.ts:680-712`):

```typescript
async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
  const ctx = this.createContext();

  for (const ext of this.extensions) {          // 遍历每个扩展
    const handlers = ext.handlers.get(event.type);
    if (!handlers || handlers.length === 0) continue;

    for (const handler of handlers) {           // 遍历同一扩展内的 handler
      try {
        const handlerResult = await handler(event, ctx);
        // ... 处理返回值
      } catch (err) {
        this.emitError({ extensionPath: ext.path, event: event.type, ... });
        // 继续下一个 handler
      }
    }
  }
  return result as RunnerEmitResult<TEvent>;
}
```

扩展按加载顺序排列(先项目级,后全局级),同一扩展内的 handler 也按注册顺序执行。没有并发执行。这样设计的原因:
- **避免竞态**:多个 handler 修改同一个事件对象时,串行保证结果可预期。
- **`cancel` 语义**:`session_before_*` 事件需要立即中止,并行化会使这一保证失效。

### 9.6.2 异常隔离

每个 handler 调用都被 `try/catch` 包裹(`runner.ts:698-707`)。异常被转发给 `emitError()`,后者通知所有注册的错误监听器(通常是 TUI 的通知系统),然后**继续执行下一个 handler**。

例外情况:`emitToolCall` 没有 try/catch(`runner.ts:806-827`)——`tool_call` handler 的异常会向上抛出,因为工具调用阻塞决策必须可靠。

### 9.6.3 Runtime 两阶段初始化

**加载阶段**:调用 `loadExtensions()` 时创建 `ExtensionRuntime`,其中动作方法(`sendMessage`、`setModel` 等)都是抛错的桩函数。此时扩展工厂函数被执行,可以调用 `registerTool`、`on` 等注册方法,但调用动作方法会抛错。

**绑定阶段**:宿主调用 `runner.bindCore(actions, contextActions)`,将真实实现注入 runtime。此后动作方法生效。`pendingProviderRegistrations` 队列在此时被 flush(`runner.ts:301-318`)。

这种设计保证了加载期间的安全性——扩展工厂函数中不能意外触发副作用。

---

## 9.7 扩展目录约定

### 7.1 发现算法

`discoverAndLoadExtensions()` 按以下优先级顺序合并路径(`loader.ts:575-621`):

```
扩展来源优先级(先加载 = 先注册 = 名称冲突时优先)

1. 项目级:  <cwd>/.pi/extensions/
2. 全局级:  <agentDir>/extensions/
           (默认为 ~/.pi/agent/extensions/)
3. 显式配置: -e flag / config.extensions 字段
```

去重逻辑:已解析绝对路径相同的扩展只加载一次(`loader.ts:585-592`)。

### 7.2 目录内的发现规则

`discoverExtensionsInDir()` 对目录进行**单层**扫描(`loader.ts:538-570`):

```
extensions/
├── my-tool.ts              → 直接加载
├── my-tool.js              → 直接加载
├── suite/
│   ├── index.ts            → 加载 index.ts
│   └── helpers.ts          → (被 index.ts 内部 import,不单独加载)
└── with-deps/
    ├── package.json        → 读取 "pi.extensions" 字段
    └── index.ts
```

`package.json` 中的 `pi` 字段(`loader.ts:463-481`):

```json
{
  "pi": {
    "extensions": ["index.ts"],
    "skills": ["SKILL.md"],
    "prompts": ["prompts/"]
  }
}
```

### 7.3 命名约定

扩展没有强制命名约定,但社区惯例:
- 单文件扩展:`<feature>.ts`(如 `auto-commit-on-exit.ts`)
- 带依赖的包扩展:放在独立目录,目录名描述功能(`with-deps/`、`sandbox/`)
- 快捷键/命令用 `kebab-case` 命名

---

## 9.8 Examples 目录解读

`packages/coding-agent/examples/extensions/` 包含大量示例,以下重点介绍有代表性的几个。

### 9.8.1 `with-deps/`:带 npm 依赖的扩展

演示扩展可以有自己的 `node_modules`,jiti 会从扩展目录解析依赖而非宿主目录。

```typescript
// examples/extensions/with-deps/index.ts:1-32
import ms from "ms";        // 来自 with-deps/node_modules/
import { Type } from "typebox"; // 来自宿主 virtualModules

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "parse_duration",
    parameters: Type.Object({ duration: Type.String() }),
    execute: async (_id, params) => {
      const result = ms(params.duration as ms.StringValue);
      return { content: [{ type: "text", text: `${params.duration} = ${result} ms` }], details: {} };
    },
  });
}
```

关键点:`typebox` 来自宿主 virtualModules(保证类型兼容),`ms` 从扩展本地 `node_modules` 解析。需要在该目录先 `npm install`。

### 9.8.2 `custom-provider-anthropic/`:覆盖内置 Anthropic provider

演示如何用自定义 `streamSimple` 函数完全替换内置 Anthropic 流处理逻辑,同时支持 API key 和 OAuth 两种认证方式。

```typescript
// examples/extensions/custom-provider-anthropic/index.ts:568-604
export default function (pi: ExtensionAPI) {
  pi.registerProvider("custom-anthropic", {
    baseUrl: "https://api.anthropic.com",
    apiKey: "CUSTOM_ANTHROPIC_API_KEY",
    api: "custom-anthropic-api",
    models: [
      { id: "claude-opus-4-5", name: "Claude Opus 4.5 (Custom)", reasoning: true, ... },
    ],
    oauth: {
      name: "Custom Anthropic (Claude Pro/Max)",
      login: loginAnthropic,
      refreshToken: refreshAnthropicToken,
      getApiKey: (cred) => cred.access,
    },
    streamSimple: streamCustomAnthropic,
  });
}
```

`streamCustomAnthropic` 实现了完整的 Anthropic Streaming API 客户端,包括 OAuth token 检测、工具名称映射(Claude Code 兼容模式)、thinking block 处理。这展示了 `streamSimple` 的完整能力——它接收规范化的 `Model`、`Context`、`SimpleStreamOptions`,返回 `AssistantMessageEventStream`。

### 9.8.3 `custom-provider-gitlab-duo/`:接入第三方 IaaS LLM

演示如何通过 GitLab AI Gateway 接入 Claude 和 GPT 模型。

```typescript
// examples/extensions/custom-provider-gitlab-duo/index.ts:266-321
export function streamGitLabDuo(model, context, options) {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const directAccess = await getDirectAccessToken(gitlabAccessToken);
    const innerStream = cfg.backend === "anthropic"
      ? streamSimpleAnthropic(modelWithBaseUrl, context, streamOptions)
      : streamSimpleOpenAIResponses(modelWithBaseUrl, context, streamOptions);
    for await (const event of innerStream) stream.push(event);
    stream.end();
  })();
  return stream;
}
```

关键技术点:
- **Direct Access Token**:每次调用前先向 GitLab API 获取一个临时令牌,缓存 25 分钟。
- **委托内置 streaming**:后端是 Anthropic 时调用 `streamSimpleAnthropic`,OpenAI 时调用 `streamSimpleOpenAIResponses`——直接复用宿主的 streaming 实现,无需重新实现 SSE 解析。

### 9.8.4 `sandbox/`:OS 级沙盒

演示覆盖内置 `bash` 工具并接入 `@anthropic-ai/sandbox-runtime`。

```typescript
// examples/extensions/sandbox/index.ts:214-230
pi.registerTool({
  ...localBash,
  label: "bash (sandboxed)",
  async execute(id, params, signal, onUpdate, _ctx) {
    if (!sandboxEnabled || !sandboxInitialized) {
      return localBash.execute(id, params, signal, onUpdate);
    }
    const sandboxedBash = createBashTool(localCwd, {
      operations: createSandboxedBashOps(),
    });
    return sandboxedBash.execute(id, params, signal, onUpdate);
  },
});
```

几个值得注意的点:
- 通过 `registerFlag("no-sandbox", ...)` 暴露 `--no-sandbox` CLI flag,在 `session_start` handler 中读取(`pi.getFlag("no-sandbox")`)。
- 注册 `user_bash` handler 拦截用户 `!` 命令,为其也启用沙盒。
- 注册 `session_shutdown` handler 在退出时清理沙盒资源。

---

## 9.9 扩展失败时的降级

### 9.9.1 加载失败

`loadExtension()` 用 try/catch 包裹整个加载过程(`loader.ts:393-416`)。若工厂函数执行抛错,错误被收集到 `LoadExtensionsResult.errors` 数组中,**不影响其他扩展的加载**。主程序在启动后通过诊断系统向用户展示加载失败信息。

### 9.9.2 Hook 抛错

大多数 `emitXxx()` 方法用 try/catch 包裹每个 handler 调用(`runner.ts:698-707`)。异常被转发给 `emitError()`,通知错误监听器(通常显示为 TUI 通知),然后**继续执行下一个 handler**。

例外:`emitToolCall` 没有错误捕获——`tool_call` handler 的异常向上传播。

### 9.9.3 工具抛错

扩展工具的 `execute()` 函数抛出的异常在 `AgentSession` 层面被捕获,转换为错误类型的工具结果返回给 LLM(与内置工具行为一致)。

---

## 9.10 ASCII 流程图:一个扩展从磁盘到 runtime 的完整路径

<svg viewBox="0 0 880 680" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="扩展从磁盘到 runtime 的完整加载路径">
  <defs>
    <marker id="arR91" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">扩展从磁盘到 runtime 的完整路径</text>
  <rect x="80" y="34" width="720" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="440" y="50" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">磁盘文件  ~/.pi/agent/extensions/my-tool.ts</text>
  <text x="440" y="60" text-anchor="middle" font-size="10" fill="#64748b">(或 .pi/extensions/ 项目级)</text>
  <line x1="440" y1="64" x2="440" y2="84" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR91)"/>
  <rect x="80" y="86" width="720" height="46" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="440" y="104" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">discoverAndLoadExtensions()</text>
  <text x="440" y="118" text-anchor="middle" font-size="10" fill="#64748b">discoverExtensionsInDir(localExtDir)  +  discoverExtensionsInDir(globalExtDir)</text>
  <text x="440" y="130" text-anchor="middle" font-size="10" fill="#94a3b8">去重合并路径列表（已解析绝对路径相同只加载一次）</text>
  <line x1="440" y1="132" x2="440" y2="152" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR91)"/>
  <rect x="80" y="154" width="720" height="34" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="440" y="170" text-anchor="middle" font-size="11" fill="#64748b">loadExtensions(paths, cwd, eventBus)</text>
  <text x="440" y="184" text-anchor="middle" font-size="10" fill="#94a3b8">创建 ExtensionRuntime（动作方法 = 抛错桩）→ 对每个路径调用 loadExtension()</text>
  <line x1="440" y1="188" x2="440" y2="208" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR91)"/>
  <rect x="80" y="210" width="720" height="80" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="440" y="228" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">loadExtensionModule(resolvedPath)  via jiti</text>
  <rect x="100" y="236" width="340" height="40" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="270" y="250" text-anchor="middle" font-size="10" fill="#7c3aed">createJiti({ moduleCache: false,</text>
  <text x="270" y="262" text-anchor="middle" font-size="10" fill="#7c3aed">  virtualModules / alias })</text>
  <text x="270" y="274" text-anchor="middle" font-size="10" fill="#64748b">Bun: virtualModules ｜ Node.js: alias</text>
  <rect x="460" y="236" width="320" height="40" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="620" y="250" text-anchor="middle" font-size="10" fill="#7c3aed">jiti.import(extensionPath)</text>
  <text x="620" y="262" text-anchor="middle" font-size="10" fill="#64748b">esbuild 转译 .ts → JS</text>
  <text x="620" y="274" text-anchor="middle" font-size="10" fill="#64748b">virtualModules 命中 → 返回宿主内存对象</text>
  <line x1="440" y1="290" x2="440" y2="310" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR91)"/>
  <rect x="80" y="312" width="720" height="90" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="440" y="330" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">ExtensionFactory 函数执行</text>
  <text x="440" y="344" text-anchor="middle" font-size="10" fill="#64748b">createExtension() → Extension { handlers: Map, tools: Map, … }</text>
  <text x="440" y="358" text-anchor="middle" font-size="10" fill="#64748b">createExtensionAPI() → ExtensionAPI { on(), registerTool(), registerProvider(), … }</text>
  <text x="440" y="372" text-anchor="middle" font-size="10" fill="#64748b">await factory(api)  →  handlers.set / tools.set / pendingProviderRegistrations.push</text>
  <text x="440" y="386" text-anchor="middle" font-size="10" fill="#94a3b8">api.on("session_start", h) ｜ api.registerTool({name:"my_tool",…}) ｜ api.registerProvider("my-proxy",…)</text>
  <text x="440" y="398" text-anchor="middle" font-size="10" fill="#94a3b8">try/catch 包裹：失败收集到 errors[]，不影响其他扩展加载</text>
  <line x1="440" y1="402" x2="440" y2="422" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR91)"/>
  <rect x="80" y="424" width="720" height="30" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="440" y="444" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">LoadExtensionsResult { extensions, errors, runtime }</text>
  <line x1="440" y1="454" x2="440" y2="474" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR91)"/>
  <rect x="80" y="476" width="720" height="52" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="440" y="494" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">ExtensionRunner.bindCore(actions, contextActions)  ← 宿主绑定</text>
  <text x="440" y="508" text-anchor="middle" font-size="10" fill="#64748b">runtime.sendMessage = actions.sendMessage（真实实现替换抛错桩）</text>
  <text x="440" y="522" text-anchor="middle" font-size="10" fill="#64748b">flush pendingProviderRegistrations → modelRegistry.registerProvider("my-proxy", config)</text>
  <line x1="440" y1="528" x2="440" y2="548" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR91)"/>
  <rect x="80" y="550" width="720" height="52" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="440" y="568" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">ExtensionRunner.emit("session_start", event)  ← 运行时</text>
  <text x="440" y="582" text-anchor="middle" font-size="10" fill="#64748b">for each extension → for each handler in handlers.get("session_start")</text>
  <text x="440" y="596" text-anchor="middle" font-size="10" fill="#64748b">await handler(event, ctx)  ← ctx 含 ui, sessionManager, model 等</text>
  <rect x="80" y="618" width="720" height="46" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="440" y="636" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">关键约束</text>
  <text x="100" y="652" font-size="10" fill="#64748b">virtualModules 保证 typebox / pi-agent-core 等宿主类型与扩展类型完全一致，避免双实例问题</text>
  <text x="100" y="664" font-size="10" fill="#94a3b8">emitToolCall 无错误捕获，其余 emit 均 try/catch 每个 handler，异常 → emitError() → 继续下一个</text>
</svg>
<span class="figure-caption">图 R9.1 ｜ 扩展从磁盘到 runtime 的完整路径——发现、jiti 转译、工厂执行、宿主绑定到 session_start 触发</span>

<details>
<summary>ASCII 原版</summary>

```
磁盘文件
~/.pi/agent/extensions/my-tool.ts
         │
         ▼
discoverAndLoadExtensions()
  ├── discoverExtensionsInDir(localExtDir)   ← .pi/extensions/
  ├── discoverExtensionsInDir(globalExtDir)  ← ~/.pi/agent/extensions/
  └── 去重合并路径列表
         │
         ▼
loadExtensions(paths, cwd, eventBus)
  创建 ExtensionRuntime (动作方法 = 抛错桩)
         │
         ▼  [对每个路径]
loadExtension(extensionPath, cwd, eventBus, runtime)
  resolvePath()  →  绝对路径
         │
         ▼
loadExtensionModule(resolvedPath)
  createJiti({
    moduleCache: false,
    virtualModules: VIRTUAL_MODULES  ← Bun
    alias: getAliases()              ← Node.js
  })
  jiti.import(extensionPath)
    ├── esbuild 转译 .ts → JS
    ├── 解析 import "@earendil-works/pi-ai"
    │     └── 命中 virtualModules → 返回宿主内存对象
    └── 执行模块,返回 default export
         │
         ▼ ExtensionFactory 函数
createExtension(path, resolvedPath)
  → Extension { handlers: Map, tools: Map, ... }
createExtensionAPI(extension, runtime, cwd, eventBus)
  → ExtensionAPI { on(), registerTool(), registerProvider(), ... }
await factory(api)
  ├── api.on("session_start", handler)
  │     → extension.handlers.set("session_start", [handler])
  ├── api.registerTool({ name: "my_tool", execute: ... })
  │     → extension.tools.set("my_tool", { definition, sourceInfo })
  └── api.registerProvider("my-proxy", config)
        → runtime.pendingProviderRegistrations.push(...)
         │
         ▼
LoadExtensionsResult { extensions, errors, runtime }
         │
         ▼ 宿主绑定
ExtensionRunner.bindCore(actions, contextActions)
  ├── runtime.sendMessage = actions.sendMessage  (真实实现)
  ├── ... 其他动作方法
  └── flush pendingProviderRegistrations
        → modelRegistry.registerProvider("my-proxy", config)
         │
         ▼ 运行时
ExtensionRunner.emit("session_start", event)
  for each extension:
    for each handler in extension.handlers.get("session_start"):
      await handler(event, ctx)   ← ctx 含 ui, sessionManager, model 等
```

</details>

---

## 9.11 附录:CONFIG_DIR_NAME 与 agentDir

- `CONFIG_DIR_NAME` = `".pi"`,即项目目录下的配置子目录名(`packages/coding-agent/src/config.ts`)。
- `getAgentDir()` 默认返回 `~/.pi/agent`,可通过 `PI_AGENT_DIR` 环境变量覆盖。
- 项目级扩展路径:`<cwd>/.pi/extensions/`
- 全局扩展路径:`~/.pi/agent/extensions/`

---

## 9.12 ExtensionAPI:完整注册接口

`ExtensionAPI`（`types.ts:1084-1311`）是扩展工厂函数的唯一入口。下面按功能分类列出所有注册方法。

### 9.12.1 工具注册

```typescript
// types.ts:1132-1135
registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
    tool: ToolDefinition<TParams, TDetails, TState>,
): void;
```

`ToolDefinition` 需要提供：
- `name`：工具名称（必须唯一；覆盖内置工具时名称与内置相同）
- `parameters`：`TypeBox` Schema，用于 JSON Schema 验证和 LLM function calling 声明
- `execute(id, params, signal, onUpdate, ctx)`：工具执行函数，返回 `ToolResult`
- `label?`：在 TUI 中显示的工具名（允许与 `name` 不同）
- `description?`：提供给 LLM 的自然语言描述

`ctx` 参数携带当前会话上下文（`agent_cwd`、环境变量等），`signal` 是 `AbortSignal`，`onUpdate` 是流式更新回调。

### 9.12.2 命令注册

```typescript
// types.ts:1142
registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
```

注册斜杠命令（如 `/my-cmd`）。`options` 包括：
- `description`：用于自动补全和帮助文本
- `handler(ctx: ExtensionCommandContext)`：命令处理函数
- `parameters?`：命令参数的 TypeBox schema

命令在 TUI 的输入框自动补全中可见。

### 9.12.3 快捷键注册

```typescript
// types.ts:1145-1152
registerShortcut(
    shortcut: KeyId,
    options: {
        description?: string;
        handler: (ctx: ExtensionContext) => Promise<void> | void;
    },
): void;
```

`KeyId` 与 `keys.ts` 中定义的类型完全兼容。扩展快捷键与内置快捷键会做冲突检测：

`runner.ts:62-80` 定义了一批**保留快捷键**（`RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS`），包括 `app.interrupt`、`app.exit`、`tui.input.submit`、`tui.input.copy`、`tui.editor.deleteToLineEnd` 等核心操作。若扩展尝试绑定这些快捷键，会生成诊断警告（`shortcutDiagnostics`），但不会阻止加载。

### 9.12.4 Flag 注册与读取

```typescript
// types.ts:1154-1164
registerFlag(name: string, options: {
    description?: string;
    type: "boolean" | "string";
    default?: boolean | string;
}): void;

getFlag(name: string): boolean | string | undefined;
```

Flag 对应 CLI 的 `--<name>` 参数。布尔型 flag 在命令行传 `--no-<name>` 反转。扩展在 `session_start` handler 中通过 `pi.getFlag("flag-name")` 读取。

### 9.12.5 消息渲染器注册

```typescript
// types.ts:1171
registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
```

用于在会话历史中渲染 `customType` 类型的自定义消息。`renderer` 接收消息内容和主题对象，返回 TUI 渲染所需的行数组或组件。

### 9.12.6 动作方法（Actions）

`ExtensionAPI` 上还有大量**动作方法**（不是注册方法，而是在运行时主动调用的功能）：

```typescript
// 消息操作
sendMessage(message, options?)    // 向会话发送自定义消息
sendUserMessage(text)             // 模拟用户消息（触发 turn）
appendEntry(entry)                // 向会话历史追加条目

// 会话元数据
setSessionName(name)
getSessionName(): string
setLabel(label)

// 工具管理
getActiveTools(): string[]
setActiveTools(tools: string[])
refreshTools()

// 模型控制
setModel(modelId: string)
getThinkingLevel(): ThinkingLevel
setThinkingLevel(level: ThinkingLevel)

// UI 操作（绑定后生效）
pi.ui.notify(message)
pi.ui.select(prompt, options)
pi.ui.confirm(prompt)
pi.ui.setStatus(status)
pi.ui.setWidget(component)
pi.ui.pasteToEditor(text)
```

这些动作方法在加载期（`bindCore()` 之前）调用会抛出错误。这是有意的防护机制——工厂函数执行期间只应做注册，不应有副作用。

---

## 9.13 ExtensionContext:handler 调用上下文

每次调用 `emit()` 时，`runner.ts` 创建一个 `ExtensionContext` 对象传给每个 handler：

```typescript
// runner.ts(节选)
private createContext(): ExtensionContext {
    return {
        ui: this.uiContext,
        sessionManager: this.sessionManager,
        model: this.getModel(),
        isIdle: this.isIdleFn,
        getSignal: this.getSignalFn,
        abort: this.abortFn,
        hasPendingMessages: this.hasPendingMessagesFn,
        getContextUsage: this.getContextUsageFn,
        compact: this.compactFn,
        getSystemPrompt: this.getSystemPromptFn,
    };
}
```

关键字段：

| 字段 | 类型 | 用途 |
|------|------|------|
| `ui` | `ExtensionUIContext` | 显示通知、对话框、设置 Widget |
| `sessionManager` | `SessionManager` | 访问当前会话 |
| `model` | `Model<any>` | 当前选中的 LLM |
| `isIdle()` | `() => boolean` | 查询 agent 是否空闲 |
| `getSignal()` | `() => AbortSignal` | 当前请求的取消信号 |
| `abort()` | `() => void` | 中止当前请求 |
| `compact(options?)` | `(options?) => void` | 触发 context 压缩 |
| `getSystemPrompt()` | `() => string` | 获取已解析的 system prompt |

`noOpUIContext`（`runner.ts:191-222`）是 `uiContext` 在非交互模式（如 `--non-interactive` flag 或单元测试）下的空实现，所有方法均为无操作或返回空值/false。

---

## 9.14 ExtensionRuntime 的两阶段初始化详解

### 9.14.1 桩函数阶段

`createExtensionRuntime()`（`loader.ts`）创建 runtime 时，所有动作方法都是桩函数：

```typescript
// 伪代码示意（基于 loader.ts 中 createExtensionRuntime 的模式）
function createExtensionRuntime(): ExtensionRuntime {
    const throwStub = (name: string) => () => {
        throw new Error(`${name} called before bindCore()`);
    };

    return {
        sendMessage: throwStub("sendMessage"),
        sendUserMessage: throwStub("sendUserMessage"),
        setModel: throwStub("setModel"),
        // ...
        pendingProviderRegistrations: [],
    };
}
```

### 9.14.2 Provider 注册延迟队列

`registerProvider()` 是一个特殊情况——它在加载阶段被调用（工厂函数中），但 `modelRegistry` 还未就绪：

```typescript
// loader.ts(基于 createExtensionAPI 中的模式)
registerProvider(name, config) {
    runtime.pendingProviderRegistrations.push({ name, config, extensionPath: ext.path });
}
```

当 `bindCore()` 被调用时，flush 这个队列：

```typescript
// runner.ts:301-318
for (const { name, config, extensionPath } of this.runtime.pendingProviderRegistrations) {
    try {
        if (providerActions?.registerProvider) {
            providerActions.registerProvider(name, config);
        }
    } catch (err) {
        // 收集到 errors 列表但继续加载
    }
}
this.runtime.pendingProviderRegistrations = [];
```

### 9.14.3 共享 runtime 实例

注意：所有扩展共享**同一个** `ExtensionRuntime` 实例。这意味着：
- 一个扩展通过 `runtime.sendMessage` 发送的消息对所有扩展都可见
- `pendingProviderRegistrations` 是所有扩展的 provider 注册的共同队列
- `bindCore()` 调用一次即对所有扩展生效

`createExtensionAPI(extension, runtime, ...)` 为每个扩展创建独立的 `ExtensionAPI` 实例，但它们内部引用同一个 `runtime` 对象。

---

## 9.15 hook 的链式传播机制详解

### 9.15.1 context hook:消息列表替换链

`emitContext()`（`runner.ts:858-888`）实现了消息列表的链式替换：

```typescript
// runner.ts:858-888（节选）
async emitContext(event: ContextEvent): Promise<ContextEventResult> {
    let messages = event.messages;
    for (const ext of this.extensions) {
        const handlers = ext.handlers.get("context");
        for (const handler of handlers) {
            try {
                const result = await handler({ ...event, messages }, ctx);
                if (result?.messages) {
                    messages = result.messages;   // 下一个 handler 看到的是已替换的列表
                }
            } catch (err) { /* ... */ }
        }
    }
    return { messages };
}
```

场景示例：扩展 A 插入 `role: "user"` 的摘要消息；扩展 B 过滤 `role: "tool"` 的结果消息。两者串行组合，最终返回的 `messages` 同时满足两个条件。

### 9.15.2 tool_result hook:工具结果修改链

`emitToolResult()`（`runner.ts`）类似于 `emitContext`，将 `{ content, details, isError }` 作为可替换的状态在 handler 链中传递。一个 handler 修改了结果后，下一个 handler 看到的是已修改的版本。

### 9.15.3 input hook:双模式分发

`emitInput()`（`runner.ts:1039-1067`）的"handled"模式会立即短路：

```typescript
async emitInput(event: InputEvent): Promise<InputEventResult> {
    let text = event.text;
    for (const ext of this.extensions) {
        for (const handler of handlers) {
            const result = await handler({ ...event, text }, ctx);
            if (result?.action === "handled") {
                return { action: "handled" };   // 立即返回，不执行后续 handler
            }
            if (result?.action === "transform") {
                text = result.text;             // 继续链式处理
            }
        }
    }
    return text !== event.text ? { action: "transform", text } : {};
}
```

"transform" 类似于 `context`——累积式修改；"handled" 类似于 `session_before_*`——立即短路。`input` hook 是唯一同时支持两种模式的 hook。

---

## 9.16 快捷键冲突检测机制

`ExtensionRunner.bindCore()` 后会调用 `buildBuiltinKeybindings(resolvedKeybindings)` 构建内置快捷键表，然后在 `registerShortcutsForExtensions()` 中检测冲突：

```typescript
// runner.ts:62-80（节选）
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = [
    "app.interrupt",
    "app.clear",
    "app.exit",
    "tui.input.submit",
    "tui.select.confirm",
    "tui.select.cancel",
    "tui.input.copy",
    "tui.editor.deleteToLineEnd",
    // ...
] as const;
```

若扩展注册的 `KeyId` 与保留快捷键冲突，生成 `shortcutDiagnostics` 条目（包含冲突的 keybinding 名称和快捷键值），在诊断面板中显示。冲突检测不阻塞加载——扩展快捷键仍然注册，但用户可以在诊断中看到问题。

---

## 9.17 noOpUIContext 与交互模式

`noOpUIContext`（`runner.ts:191-222`）是 pi 在非交互模式下的安全后备：

```typescript
const noOpUIContext: ExtensionUIContext = {
    select: async () => undefined,       // 对话框 → 返回 undefined（取消）
    confirm: async () => false,          // 确认框 → 返回 false
    input: async () => undefined,        // 输入框 → 返回 undefined
    notify: () => {},                    // 通知 → 静默
    setStatus: () => {},
    setWidget: () => {},
    setTitle: () => {},
    // ...
};
```

扩展代码不需要显式检测是否在交互模式——`pi.ui.select()` 在非交互模式下静默返回 `undefined`，扩展应始终处理 `undefined` 返回值。

实际的 UI 实现由 `coding-agent` 的交互模式（`packages/coding-agent/src/modes/interactive/`）通过 `runner.setUIContext(uiContext)` 注入，在 `bindCore()` 同一阶段完成。

---

## 9.18 事件总线（EventBus）

`loader.ts` 中的 `EventBus` 是扩展加载过程中的内部通知机制：

```typescript
// loader.ts(节选)
interface EventBus {
    emit(event: string, ...args: unknown[]): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
    off(event: string, handler: (...args: unknown[]) => void): void;
}
```

目前 `EventBus` 主要用于 Kitty 协议响应通知（`StdinBuffer` 探测到终端响应后通知加载器）。与 `ExtensionRunner.emit()` 是完全不同的机制——前者是内部技术性通知，后者是扩展生命周期事件分发。

---

## 9.19 附录:完整的 ExtensionAPI.on 重载列表

以下是 `types.ts:1086-1126` 中所有 `on()` 重载，按类别整理：

**资源**
- `on("resources_discover", handler)` → 发现时机：`session_start` 之后

**会话生命周期**
- `on("session_start", handler)`
- `on("session_before_switch", handler)` → 可返回 `{ cancel: true }`
- `on("session_before_fork", handler)` → 可返回 `{ cancel: true }`
- `on("session_before_compact", handler)` → 可返回 `{ cancel: true }` 或提供替代压缩结果
- `on("session_compact", handler)`
- `on("session_shutdown", handler)`
- `on("session_before_tree", handler)` → 可返回 `{ cancel: true }` 或自定义摘要
- `on("session_tree", handler)`

**Provider 与 Agent**
- `on("context", handler)` → 链式替换消息列表
- `on("before_provider_request", handler)` → 修改请求 payload
- `on("after_provider_response", handler)` → 检查响应 headers
- `on("before_agent_start", handler)` → 注入 system message 或替换 system prompt
- `on("agent_start", handler)`
- `on("agent_end", handler)`

**Turn 与消息**
- `on("turn_start", handler)`
- `on("turn_end", handler)`
- `on("message_start", handler)`
- `on("message_update", handler)`
- `on("message_end", handler)` → 链式替换最终消息

**工具执行**
- `on("tool_execution_start", handler)`
- `on("tool_execution_update", handler)`
- `on("tool_execution_end", handler)`
- `on("tool_call", handler)` → 可返回 `{ block: true }` 或修改 `event.input`
- `on("tool_result", handler)` → 链式修改工具结果

**模型与输入**
- `on("model_select", handler)`
- `on("thinking_level_select", handler)`
- `on("user_bash", handler)` → 用户 `!bash` 命令拦截
- `on("input", handler)` → 输入文本拦截/转换
