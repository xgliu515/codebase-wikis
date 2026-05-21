# Tour 步骤 03:装配 AgentSessionRuntime

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:`AuthStorage` 已从 `~/.pi/agent/auth.json` 读取凭证到内存;`ModelRegistry` 已将内置模型与自定义模型合并进内存。但 `AgentSessionRuntime` 主对象还没有构造——扩展、工具、settings、system prompt 上下文都还没有准备好。

**下一步起点**:`createAgentSessionRuntime()` 返回,`AgentSessionRuntime` 实例持有 `_session`、`_services`、`createRuntime` 工厂引用。`AgentSession`(包含 7 个内置工具、扩展绑定、system prompt)已经构造完毕。InteractiveMode 还没有启动。

---

## 1. 当前情境

`main.ts:614` 调用 `createAgentSessionRuntime(createRuntime, {...})`,这是整个启动流程里最"重"的一步:

```
main.ts:614  await createAgentSessionRuntime(createRuntime, {cwd, agentDir, sessionManager})
              |
              | -> agent-session-runtime.ts:392
              v
createAgentSessionRuntime()
    assertSessionCwdExists(sessionManager, cwd)
    result = await createRuntime({cwd, agentDir, sessionManager})   <- 工厂闭包执行
    return new AgentSessionRuntime(result.session, result.services, createRuntime, ...)
```

工厂闭包(`main.ts:528-612`)是 `createRuntime` 的真正实现。它在 `await createAgentSessionServices()` 之后继续执行,把 services 传给 `createAgentSessionFromServices()`,后者最终调用 `createAgentSession()` 构造 `AgentSession`。

---

## 2. 问题

本步需要解决三个相互关联的问题:

1. **扩展加载放在哪个阶段**:扩展可能注册自定义 provider、自定义工具、自定义 flag。如果扩展在 `AgentSession` 构造之后才加载,provider 注册会晚于 `ModelRegistry` 的初始化;如果在 `parseArgs` 之前加载,未知 flag 验证又没有参照。

2. **为什么 `AgentSessionRuntime` 设计为单例式**:进程里同时只有一个 `cwd`、一个 model、一组工具。切换 session(`/new`、`/resume`)时,runtime 不销毁,而是原地把内部 `_session` 和 `_services` 替换成新实例。

3. **7 个内置工具如何注册到 `AgentSession`**:`read/bash/edit/write/grep/find/ls` 的默认激活状态与工具的 `AgentTool<T>` 实例怎么绑进 agent state。

---

## 3. 朴素思路

在 `AgentSession` 构造函数里直接 `require` 所有扩展,把工具硬编码成全局列表。每次创建新 session 就销毁旧进程里的所有状态,重新初始化。

---

## 4. 为什么朴素思路会崩

**扩展必须在 provider 注册之前完成加载**:扩展可能声明自定义 AI provider(调用 `pi.registerProvider()`),这个注册必须在 `ModelRegistry` 完成初始化后才能发生,但又要在 model 选择之前完成,否则用户在 settings 里配置的默认 model 指向自定义 provider 时,`findInitialModel()` 找不到它。`createAgentSessionServices()`(`agent-session-services.ts:129`) 的调用顺序保证了这一点:先 `resourceLoader.reload()`(加载扩展),再 flush `pendingProviderRegistrations` 到 `modelRegistry`。

**进程内重新初始化成本极高**:如果 `/new` 意味着销毁并重建整个进程状态,用户会感知到数百毫秒的停顿。`AgentSessionRuntime` 存储 `createRuntime` 工厂引用,`/new` 和 `/resume` 时只调用工厂重新构造 `_session` 和 `_services`,保留已加载的扩展模块缓存和 HTTP dispatcher 配置。

**工具与 session 生命周期绑定而非进程绑定**:工具的 `cwd`(用于路径安全检查)必须与 session 的 `cwd` 保持一致。如果工具是进程级全局的,cwd 切换后路径检查会失效。`createAllToolDefinitions(cwd, options)` 在每次 session 构造时被调用,把当前 cwd 闭包进每个工具的处理函数。

---

## 5. pi 的做法

**装配时序**:

```
createAgentSessionServices()           [agent-session-services.ts:129]
    authStorage  = AuthStorage.create()
    settingsManager = SettingsManager.create(cwd, agentDir)
    modelRegistry = ModelRegistry.create(authStorage, models.json)
    resourceLoader = new DefaultResourceLoader({cwd, agentDir, settingsManager})
    await resourceLoader.reload()
        |
        +-- discoverAndLoadExtensions(configuredPaths, cwd, agentDir)
        |     [loader.ts:575]
        |     1. cwd/.pi/extensions/  <- 项目级扩展
        |     2. agentDir/extensions/ <- 全局扩展
        |     3. configuredPaths      <- --extensions 指定的额外路径
        |     4. npm packages 里的 pi.extensions 字段
        |
        |     对每个 .ts/.js 文件:
        |     createJiti({...aliases, virtualModules})  [loader.ts:16]
        |     jiti(extPath) -> module.default(api)      <- 执行扩展工厂函数
        |
        +-- 扩展工厂执行期间:
              pi.registerProvider(name, config) -> pendingProviderRegistrations.push(...)
              pi.registerTool(tool)             -> extension.tools.set(...)
              pi.on('session_start', handler)   -> extension.handlers.set(...)
    |
    +-- flush pendingProviderRegistrations -> modelRegistry.registerProvider()
    |     [agent-session-services.ts:147-157]
    |
    return services: AgentSessionServices

createAgentSessionFromServices()       [agent-session-services.ts:179]
    -> createAgentSession(options)     [sdk.ts:193]
         |
         +-- sessionManager.buildSessionContext()  <- 读 JSONL,恢复消息(若有)
         +-- findInitialModel()                    <- 选择初始模型
         +-- new Agent({model, thinkingLevel, ...}) <- agent-core Agent
         +-- new AgentSession({agent, ...})
               |
               +-- this._buildRuntime({activeToolNames: ['read','bash','edit','write']})
                     |
                     +-- createAllToolDefinitions(cwd, options)
                     |     [tools/index.ts] 构造全部 7 个工具定义
                     |
                     +-- 过滤 activeToolNames -> agent.state.tools = [4 个]
                     +-- buildSystemPrompt(options) -> agent.state.systemPrompt
                     +-- bindExtensions(extensionRunner)
```

**jiti 的作用**(`loader.ts:17`):

```typescript
import { createJiti } from "jiti/static";
// ...
const jiti = createJiti(import.meta.url, {
    alias: getAliases(),          // Node.js 模式:把包名映射到本地 dist 路径
    moduleCache: jitiCache,       // 缓存已解析的模块
    // Bun 编译二进制模式:
    // virtualModules: VIRTUAL_MODULES  // 把包注入为虚拟模块
});
```

jiti 让扩展可以写 TypeScript,不需要用户手动编译。它在运行时用 Babel 转译 `.ts` 文件,并通过 `alias`/`virtualModules` 把 `@earendil-works/pi-coding-agent` 等包重定向到进程内已加载的版本,避免版本冲突。

**7 个内置工具的注册**(`tools/index.ts:83-84`):

```typescript
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export const allToolNames: Set<ToolName> = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
```

`createAllToolDefinitions(cwd, options)` 依次调用 7 个工具工厂函数,每个返回 `ToolDefinition<Input, Details>`,包含 JSON Schema 形式的参数说明和 `execute(input)` 处理函数。`AgentSession._buildRuntime()` 把其中 `initialActiveToolNames`(默认 `["read","bash","edit","write"]`)对应的工具转成 `AgentTool[]` 传给 `agent.state.tools`。

**为什么单例式**(`agent-session-runtime.ts:67-88`):

`AgentSessionRuntime` 只有一个构造函数参数 `createRuntime: CreateAgentSessionRuntimeFactory`,这个工厂引用被保存在 `this.createRuntime`。`switchSession()`、`newSession()`、`fork()` 等方法都调用 `this.createRuntime(...)` 重新生成 `_session` 和 `_services`,用 `this.apply(result)` 原地替换。`InteractiveMode` 拿到 runtime 引用后始终不变,它通过 `runtime.session` getter 访问当前 session。

**settings 合并**(`settings-manager.ts`):

`SettingsManager.create(cwd, agentDir)` 按优先级合并三层 settings:

```
优先级(高 -> 低):
  1. cwd/.pi/settings.json      <- 项目级
  2. agentDir/settings.json     <- 全局(~/.pi/agent/settings.json)
  3. 内置默认值
```

合并后的 `settingsManager` 会被查询用于:选择默认 provider/model、获取 compaction 阈值、HTTP timeout 配置等。

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/coding-agent/src/main.ts` | 528-612 | `createRuntime` 工厂闭包 |
| `packages/coding-agent/src/main.ts` | 614-618 | `createAgentSessionRuntime()` 调用 |
| `packages/coding-agent/src/core/agent-session-runtime.ts` | 67-88 | `AgentSessionRuntime` 构造函数 |
| `packages/coding-agent/src/core/agent-session-runtime.ts` | 170-176 | `apply()` — 原地替换 session/services |
| `packages/coding-agent/src/core/agent-session-runtime.ts` | 392-410 | `createAgentSessionRuntime()` — 初始构造 |
| `packages/coding-agent/src/core/agent-session-services.ts` | 129-170 | `createAgentSessionServices()` — 服务装配 |
| `packages/coding-agent/src/core/agent-session-services.ts` | 145-157 | flush `pendingProviderRegistrations` |
| `packages/coding-agent/src/core/agent-session-services.ts` | 179-198 | `createAgentSessionFromServices()` |
| `packages/coding-agent/src/core/extensions/loader.ts` | 16-17 | `createJiti` 导入 |
| `packages/coding-agent/src/core/extensions/loader.ts` | 44-61 | `VIRTUAL_MODULES` — Bun 二进制虚拟模块表 |
| `packages/coding-agent/src/core/extensions/loader.ts` | 69-116 | `getAliases()` — Node.js 模式别名表 |
| `packages/coding-agent/src/core/extensions/loader.ts` | 437-461 | `loadExtensions()` — 核心加载循环 |
| `packages/coding-agent/src/core/extensions/loader.ts` | 538-570 | `discoverExtensionsInDir()` — 发现扩展文件 |
| `packages/coding-agent/src/core/extensions/loader.ts` | 575-621` | `discoverAndLoadExtensions()` — 标准位置扫描 |
| `packages/coding-agent/src/core/tools/index.ts` | 83-84 | `ToolName` 类型与 `allToolNames` |
| `packages/coding-agent/src/core/tools/index.ts` | 96-130 | `createToolDefinition()` — 按名创建单个工具 |

---

## 7. 分支与延伸

- **`AgentSessionRuntime` 完整生命周期(新建/恢复/fork)**:见 [第 07 章 §7.4「AgentSessionRuntime 的会话替换机制」](./07-coding-agent-cli-startup.md#74-agentsessionruntime-的会话替换机制)。`switchSession()`、`newSession()`、`fork()` 的 before/after 事件钩子均在此章有详述。

- **7 个工具的 JSON Schema 定义和路径安全策略**:见 [第 08 章 §8.1「内置工具注册」](./08-coding-agent-tools.md#81-内置工具注册) 和 [第 08 章 §8.3「路径安全检查」](./08-coding-agent-tools.md#83-路径安全检查)。`read` 工具的 `allowedPaths` 过滤和行范围截断在此章有完整说明。

- **jiti 动态加载 TypeScript 扩展的机制**:见 [第 09 章 §9.1「jiti 加载原理」](./09-coding-agent-extensions.md#91-jiti-加载原理)。`alias` 与 `virtualModules` 的区别(Node.js vs Bun 编译二进制)、模块缓存策略、扩展隔离保证均在此章详述。

---

## 8. 走完这一步你脑子里应该多了什么

1. **服务装配的顺序是有因果关系的**:`resourceLoader.reload()`(加载扩展)必须在 `ModelRegistry` 初始化之后,又必须在 `findInitialModel()` 之前。这是因为扩展可能通过 `registerProvider()` 向 `modelRegistry` 注入新 provider,而 `findInitialModel()` 需要看到完整的 provider 列表才能找到正确的默认模型。

2. **`pendingProviderRegistrations` 是一个延迟队列**:扩展工厂函数执行期间,`registerProvider()` 调用只是把配置压入 `runtime.pendingProviderRegistrations` 数组,并不立即调用 `modelRegistry.registerProvider()`。等扩展全部加载完毕,`createAgentSessionServices()` 统一 flush,确保注册顺序可控且错误可捕获。

3. **jiti 是扩展的"隐形编译器"**:用户的扩展文件是 `.ts`,jiti 在首次加载时用 Babel 完成 TypeScript 到 JS 的转译并缓存结果。`alias`/`virtualModules` 保证扩展里 `import { Agent } from '@earendil-works/pi-agent-core'` 拿到的是进程内已有的同一份模块,不会出现双重实例或版本不匹配。

4. **`AgentSessionRuntime` 不是 session 的容器,而是 session 的管理者**:它保存 `createRuntime` 工厂,在 `/new`/`/resume`/`/fork` 时用工厂重新生成内部状态。`InteractiveMode` 通过 `runtime.session` 访问当前 session,这个 getter 返回的是当前时刻的 `_session`,切换后自动指向新 session。

5. **工具的 `cwd` 在每次 session 构造时重新绑定**:每次 `createAllToolDefinitions(cwd, ...)` 被调用时,`cwd` 都会被闭包进各工具的 `execute` 函数。这意味着如果用户 `/resume` 了一个在不同目录启动的 session,`read`/`bash` 等工具的路径基准点会切换到那个目录,而不是进程启动时的目录。
