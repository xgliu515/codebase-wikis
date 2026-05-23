# Trace 步骤 03 —— 加载配置与鉴权

## 1. 当前情境

上一步结束时，`RunCommand` 的 handler 拿到了完整的 `args`：

```text
args.message     = ["What's", "in", "README.md?"]
args.interactive = false
args.attach      = undefined
args.model       = undefined          ← 没指定模型
args.agent       = undefined          ← 没指定 agent
args.format      = "default"
args.dir         = undefined
prompt = "What's in README.md?"       ← 已经 resolveRunInput 完成
```

handler 走到末尾 `run.ts:869-879` 这段：

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

只要 `fetchFn` 第一次被 SDK 调用——也就是 `execute(sdk)` 第一次发起 HTTP 请求——`Server.Default()` 就会触发整套 in-process server 装配，AppRuntime 同时拉起 50+ 个 layer。本步骤要把"AppRuntime 启动到 prompt 第一次进入 server 路由"这一段时间里**配置和鉴权**做了什么讲清楚。

`InstanceContext` 已经在 `effectCmd` 里通过 `InstanceStore.load({ directory })` 加载完毕——也就是说 `Config.Service` 这种 effect service 此刻已被 InstanceBootstrap 实例化，但用户的 `opencode.json` 还没被读、API key 还没决定。这是真正"打开钱包"的一步。

## 2. 问题

接下来 server 一旦真正接客（用户的 prompt 一进 `session.prompt` 路由），就要立刻回答这些问题：

1. **用哪个 provider？哪个 model？** —— 没传 `--model` 的话，默认走谁；
2. **API key 从哪儿来？** —— 是环境变量、`~/.opencode/auth.json`、OAuth refresh token，还是 anthropic 的公共 opencode 代理？
3. **项目有没有自定义 prompt / agent / 工具开关？** —— `opencode.json` 里可能写了 `instructions`、`agent.build.tools.read = false`、`provider.anthropic.options.apiKey`、`tools.read = "deny"` 等；
4. **远端账号有没有 push 下来的"被管理配置"？** —— 企业账号下，opencode 控制台可能下发一份 org 级 config 覆盖本地的；
5. **OAuth token 过期了怎么办？** —— 如果 `auth.json` 里是 OAuth 凭证、access 已过期，得 refresh。

这五件事每一件都得**在 server 收到 `session.prompt` 之前**就绪——不能等用户第一个工具开火的瞬间才去解析配置。

## 3. 朴素思路

最直白的写法：

```ts
function init() {
  const userConfig   = readJson("~/.opencode/opencode.json")
  const projectConfig = readJson(cwd + "/opencode.json")
  const config = { ...defaults, ...userConfig, ...projectConfig }

  const provider = config.provider ?? "anthropic"
  const model    = config.model    ?? "claude-sonnet-4-5"
  const apiKey   = process.env.ANTHROPIC_API_KEY
              ?? readJson("~/.opencode/auth.json")[provider]?.key

  return { config, provider, model, apiKey }
}
```

——配置是 JSON merge、apiKey 是 env > auth.json 的串行 fallback。听起来够用。

## 4. 为什么朴素思路会崩

opencode 的真实复杂度超过这五行远了：

- **配置至少有 8 个层**：默认 → user global (`~/.opencode/config.json`、`opencode.json`、`opencode.jsonc`、legacy TOML) → `$OPENCODE_CONFIG` → 项目目录 + 所有 `.opencode/` 父链上的 `opencode.json` → `$OPENCODE_CONFIG_CONTENT` → 远端账号下发 → `ConfigManaged`（macOS MDM）—— 加上 `result.tools` / `result.mode` 这类 deprecated 字段还要做 normalize。如果不分层，新增一种配置源就要重写 merge 算法。
- **provider 选择不能直接读 `config.model`**：用户没设的话，opencode 会回退到 `~/.opencode/state/model.json` 里**最近一次使用的模型**；再回退则按 `priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]` 排序在已认证的 provider 上挑第一个。把"上次用什么"也当成隐式偏好，是为了让"再来一次"的体验保持一致。
- **API key 有 3 种类型**：`type: "api"` / `type: "oauth"` / `type: "wellknown"`——后者是公共 opencode 代理用的；OAuth 还要做 refresh / token 刷新；env 优先级里 anthropic 有 `ANTHROPIC_API_KEY`，OpenAI 有 `OPENAI_API_KEY`，GitLab 有 `GITLAB_TOKEN`，每个 provider 有自己的环境名映射；
- **公共代理 fallback**：如果用户既没配 anthropic 凭证也没装 GitHub Copilot，opencode 仍要让人能 `run` 起来——它把 provider 的所有 paid 模型从可用列表里**删掉**，只保留 `cost.input === 0` 的免费模型，连到 `apiKey: "public"` 的公共 opencode 代理。
- **Plugin 可能改 config**：用户可以写 plugin 钩子在 InstanceBootstrap 阶段修改 config（注入新 provider、改 prompt 等）；plugin init 必须在 `config.get()` 第一次完整返回之前完成。

朴素思路全没考虑这些。

## 5. opencode 的做法

opencode 把这件事拆成三件清晰的 service，加上一个 InstanceBootstrap 触发器：

```text
   ┌─────────────────────────────────────────┐
   │ effectCmd 在 handler 入口调           │
   │   InstanceStore.load({ directory })    │   ← 同步
   └───────────────┬─────────────────────────┘
                   │
                   ▼  bootstrap.run pipe InstanceRef
   ┌─────────────────────────────────────────┐
   │ packages/opencode/src/project/bootstrap.ts:38-52 │
   │                                          │
   │   yield* config.get()         ← 1        │
   │   yield* plugin.init()        ← 2        │
   │   yield* [reference, lsp, shareNext,     │
   │           format, file, fileWatcher,     │
   │           vcs, snapshot, project]        │
   │      forEach concurrency: unbounded ← 3  │
   └─────────────────────────────────────────┘

   ┌─────────────────────────────────────────┐
   │ Server.Default() (run.ts:869-879 触发)  │   ← 4 第一次 SDK 调用
   │   handler = HttpApiApp.webHandler()     │
   │   →  路由表生效                          │
   └─────────────────────────────────────────┘
```

每一步的实际工作：

### 5.1 `Config.load` 的 8 层合并

`packages/opencode/src/config/config.ts:443-476` 是 `loadGlobal()`——只跑一次、被 `Effect.cachedInvalidateWithTTL(..., Duration.infinity)` 永久 cache。它按下面顺序合并：

1. `~/.opencode/config.json`
2. `~/.opencode/opencode.json`
3. `~/.opencode/opencode.jsonc`
4. 如果还存在 legacy TOML（`~/.opencode/config`），把它转成 JSON 并删除原文件。

接着 `loadInstanceState()`（`config.ts:510-740` 一大段）把 instance（项目）级别叠上去，按顺序：

5. `Flag.OPENCODE_CONFIG`（环境变量指向的某个具体文件）；
6. `ConfigPaths.files("opencode", ctx.directory, ctx.worktree)` 返回的项目 `opencode.json` 链（`config.ts:602-606`）——从 `ctx.directory` 沿父目录向上一直找到 worktree 根；
7. `Flag.OPENCODE_CONFIG_DIR` / `.opencode/opencode.{json,jsonc}`（每个目录里的）；
8. `process.env.OPENCODE_CONFIG_CONTENT`（一段内联 JSON）；
9. 已激活账号的远端 config：`account.config(accountID, orgID)` 拉回一份 JSON 注入；
10. `ConfigManaged`（macOS MDM）下发的内容——这一层走 `mergeConfigConcatArrays`，因为它要把 `instructions: string[]` 数组也合并而不是覆盖。

每一层都是 `mergeDeep` 风格（`config.ts:51-61`），但 `instructions` 字段特殊处理——拼接而不是替换，便于多个层各自加自己的 system 提示。

### 5.2 Provider + Model 选择三段瀑布

`packages/opencode/src/provider/provider.ts:1814-1846` 的 `defaultModel()` 把"用哪个模型"分成三段：

```ts
if (cfg.model) return parseModel(cfg.model)       // ← --model > config.model

const recent = readJson("~/.opencode/state/model.json")
                .map(parse).filter(p => providers[p.providerID]?.models[p.modelID])
if (recent.length) return recent[0]              // ← 上次用过的模型

const provider = first(Object.values(providers))
const [model]  = sort(provider.models, priority)
return { providerID: provider.id, modelID: model.id } // ← 兜底
```

兜底排序由 `priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]` 控制（`provider.ts:1864-1872`），文件名 含 `claude-sonnet-4-5` 的就会被排到前面。

由于我们 trace 的命令既没有 `--model` 也没有 config 里的 `model` 字段，最终被选中的就是 `anthropic/claude-sonnet-4-5`。

### 5.3 API key：env > auth.json > plugin loader > config

`Provider.layer` 的 `init` 阶段（`provider.ts:1380-1424`）做了三轮注入：

```text
1. env loop:    遍历 database[providerID].env → process.env[name] → mergeProvider({ source:"env", key })
2. auth loop:   遍历 auth.all()                → 类型 "api"          → mergeProvider({ source:"api", key })
3. plugin loop: 对带 hooks.auth.loader 的 provider → 调用 loader 拿 options
```

环境变量的名字来自 `models.dev` 的 provider database——比如 `anthropic` 对应 `["ANTHROPIC_API_KEY"]`，`openai` 对应 `["OPENAI_API_KEY"]`，`gitlab` 对应 `["GITLAB_TOKEN"]`。`provider.ts:1384-1390` 是这个 loop 的核心。

`auth.json` 由 `packages/opencode/src/auth/index.ts:51-91` 的 `Auth.Service` 管理。它是 `~/.opencode/data/auth.json` 一个文件，写入时强制 `0o600`（`auth/index.ts:78,87`），存的是 `{ [providerID]: Oauth | Api | WellKnown }` 映射。`provider.ts:1393-1403` 只把 `type === "api"` 的拉成 `key`；OAuth / WellKnown 由 plugin 钩子另行处理。

### 5.4 公共 opencode 代理

对于 `provider.id === "opencode"` 的特殊 fallback，看 `provider.ts:168-190`：

```ts
opencode: Effect.fnUntraced(function* (input: Info) {
  const env = yield* dep.env()
  const hasKey = input.env.some((item) => env[item])
  const ok = hasKey
    || Boolean(yield* dep.auth(input.id))
    || Boolean((yield* dep.config()).provider?.["opencode"]?.options?.apiKey)

  if (!ok) {
    for (const [key, value] of Object.entries(input.models)) {
      if (value.cost.input === 0) continue
      delete input.models[key]            // ← 删掉所有付费模型
    }
  }
  return {
    autoload: Object.keys(input.models).length > 0,
    options: ok ? {} : { apiKey: "public" },  // ← 没 key 时挂 "public" 假 key
  }
}),
```

也就是说，**裸跑 opencode 不配任何凭证**——你仍然能进入对话流，但模型列表只剩免费的，API 请求走 `apiKey: "public"` 经由公共 opencode 代理到达上游。这是"零配置启动"的核心保障。

### 5.5 Plugin 在 config 之后 init

`InstanceBootstrap.run`（`packages/opencode/src/project/bootstrap.ts:38-52`）的顺序很说明问题：

```ts
yield* config.get()              // 1. 物化 config（含全部 8 层合并）
yield* plugin.init()             // 2. 跑 plugin（可能 mutate config）
yield* Effect.forEach(
  [reference, lsp, shareNext, format, file, fileWatcher, vcs, snapshot, project],
  s => s.init(),
  { concurrency: "unbounded" },  // 3. 其它子系统并行
)
```

注释里说得很清楚："Plugin can mutate config so it has to be initialized before anything else." plugin 钩子可以注入新 provider、改默认 model、追加 instructions——这些必须在其它子系统（LSP / FileWatcher / Snapshot）开始读 config 之前生效。

### 5.6 Server.Default() 触发 in-process server

最后是 `packages/opencode/src/server/server.ts:58-67` 的 `Server.Default()`——这个 `lazy(() => ...)` 直到 `run.ts` 里 `fetchFn` 真正被 SDK 调用时才执行：

```ts
export const Default = lazy(() => {
  const handler = HttpApiApp.webHandler().handler
  const app: ServerApp = {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input, init) {
      return app.fetch(input instanceof Request ? input
                       : new Request(new URL(input, "http://localhost"), init))
    },
  }
  return { app }
})
```

`HttpApiApp` 是 effect platform 的 HTTP API；`webHandler()` 返回一个 `(req, ctx) => Promise<Response>` 函数。因为是 `lazy()`，它**只**在 `app.fetch` 第一次被调用那一瞬间装配——这跟 `Server.listen()` 启动真正的 TCP 监听走的是同一份 router，只是没有 socket 层。

## 6. 代码位置

按"配置 → provider → 鉴权 → 触发 server"的阅读顺序：

- `packages/opencode/src/config/config.ts:381-486` —— `Config.layer`：`loadConfig` / `loadFile` / `loadGlobal` 三段、`cachedGlobal` 缓存；
- `packages/opencode/src/config/config.ts:443-476` —— `loadGlobal()` 全部 4 个 user global 文件位置与 legacy TOML 转换；
- `packages/opencode/src/config/config.ts:510-740` —— `loadInstanceState(ctx)`：项目层、`OPENCODE_CONFIG`、`.opencode/`、远端账号、ConfigManaged 一条龙；
- `packages/opencode/src/config/config.ts:602-606` —— `ConfigPaths.files("opencode", ctx.directory, ctx.worktree)` 沿父目录向上拼 `opencode.json` 链；
- `packages/opencode/src/config/provider.ts:1-109` —— `ProviderConfig.Info` schema：每个 provider 的 `env / npm / options.apiKey / options.baseURL / options.timeout / models` 字段定义；
- `packages/opencode/src/auth/index.ts:7-49` —— `Oauth / Api / WellKnown` 三种 auth schema + `~/.opencode/data/auth.json` 文件位置；
- `packages/opencode/src/auth/index.ts:51-91` —— `Auth.Service` 的 `all / get / set / remove` 实现，文件强制 `0o600`；
- `packages/opencode/src/provider/provider.ts:99-110` —— `BUNDLED_PROVIDERS` 列表（amazon-bedrock / anthropic / openai / xai / google / ...）；
- `packages/opencode/src/provider/provider.ts:168-190` —— "opencode" provider 的免费模型 fallback 逻辑；
- `packages/opencode/src/provider/provider.ts:1380-1424` —— env / auth.json / plugin loader 三轮 key 注入；
- `packages/opencode/src/provider/provider.ts:1814-1872` —— `defaultModel()` 三段瀑布 + `priority` 兜底排序；
- `packages/opencode/src/provider/auth.ts:108-222` —— `ProviderAuth.Service`：OAuth methods / authorize / callback 实现；
- `packages/opencode/src/project/bootstrap.ts:20-56` —— `InstanceBootstrap`：先 `config.get()`、再 `plugin.init()`、再并行起其它子系统；
- `packages/opencode/src/effect/app-runtime.ts:62-117` —— `AppLayer` 把 50+ 个 service `Layer.mergeAll` 在一起；
- `packages/opencode/src/server/server.ts:58-67` —— `Server.Default()` 的 lazy 装配。

## 7. 分支与延伸

- **配置层级与优先级表**：第 2 章对 8 层合并、`mergeConfigConcatArrays` 的特殊数组拼接、`OPENCODE_CONFIG_*` 三个变量做了一张完整对照表（参考手册待写：02 章）；本步只解释了"为什么这么做"。
- **provider 注册详解**：`provider.ts` 1882 行的 `Provider.layer.init` 是 opencode 最重的一段——它要 normalize 来自 models.dev、`opencode.json`、auth、plugin 四个源的 provider 信息。展开见参考手册 06 章 §provider 注册 / Protocols 层（待写）。
- **API key / OAuth / 公共代理**：参考手册 02 章会展开 OAuth flow（`provider/auth.ts:162-218` 的 authorize/callback）、enterprise GitHub Copilot 的特殊 baseURL、`wellknown` 类型如何对接公共代理。
- **server 启动**：本步用到的 `Server.Default()` 与 `Server.listen()` 是同一份 router 的两条出路。参考手册 [第 01 章 §1.6.4 进程内嵌 server 的诡异点](01-entrypoints.md#164-进程内嵌-server-的诡异点) 已经粗讲一遍；详细拓扑见参考手册 10 章 §server 启动（待写）。
- **plugin 加载**：见 [第 12 章 §插件发现与加载]（参考手册占位）；plugin 钩子能改 config 是本步骤里没展开的一个"魔法"。

## 8. 走完这一步你脑子里应该多了什么

1. **配置不是一份 JSON，是 8 层 merge**——defaults → 4 个 user global → `OPENCODE_CONFIG` → 项目链 → `.opencode/` → `OPENCODE_CONFIG_CONTENT` → 远端账号 → macOS MDM。`mergeDeep` 是基础策略，`instructions: string[]` 走拼接特例。
2. **provider/model 选择是三段瀑布**：`config.model` > `~/.opencode/state/model.json` 最近使用 > `priority = ["gpt-5", "claude-sonnet-4", ...]` 排序的兜底。最后一段同时受 "哪些 provider 装好了 key" 限制。
3. **API key 来源是 env → auth.json → plugin loader → config**——四种渠道任一拿到就停；都没有的话，对 `provider.id === "opencode"` 删掉付费模型，连公共代理；对其它 provider 直接 `autoload: false` 不出现在选项里。
4. **InstanceBootstrap.run 强制顺序**：`config.get()` → `plugin.init()` → `[reference, lsp, shareNext, format, file, fileWatcher, vcs, snapshot, project]` 并发。plugin 可以修改 config，必须在其它 service 启动之前完成。
5. **Server.Default() 是 lazy 的**——直到 `fetchFn` 被 SDK 第一次调用才装配。这把 in-process server 的成本压到 0，直到真的有请求。走完这一步：`config / provider / model / apiKey` 全部就位；下一步要解决 SQLite 连接和"史前 JSON 数据"的迁移。

下一步：[Trace 步骤 04 —— 数据库初始化与 JSON 迁移](tour-04-db-init.md)
