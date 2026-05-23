# 第 12 章：插件系统

> 代码版本锁定：`anomalyco/opencode@d74d166ac`（tag `v1.15.10`，2026-05-23）。所有 `file:line` 引用均以仓库根 `packages/opencode/` 为相对起点（除非另注 `packages/plugin/`）。

## 0. 这一章要解决的问题

第 11 章讲了 MCP——跨进程协议、JSON-RPC、stdio/HTTP。这章讲**插件**，它是另一种扩展通道：**进程内的 JS/TS 模块**。MCP 和 plugin 看上去像同一件事的两种实现，但定位完全不同：

| 维度 | MCP server | Plugin |
| --- | --- | --- |
| 进程边界 | 跨进程 | 同进程（动态 import 到 opencode） |
| 协议 | JSON-RPC | TypeScript 函数调用 |
| 能访问的状态 | 无（只有自己暴露的状态） | opencode 的 Bus、Config、Bun.$、SDK client |
| 能 hook 的点 | 只能"被调" | session/chat/tool/permission/auth 全生命周期 |
| 安全 | 沙盒（另一进程） | 完全信任 |
| 适合场景 | 标准化外部工具 | 改 opencode 行为：自定义 provider 鉴权、改 prompt、加 tool |

opencode 的内建 provider 适配器（Codex / Copilot / Azure / xAI / Cloudflare / DigitalOcean / GitLab / Poe）**全部以插件形式实现**——它们要在 opencode 的鉴权流程里插一层（OAuth callback、token refresh），MCP 完全做不了这件事。

本章覆盖：

1. plugin 的入口签名（`@opencode-ai/plugin` SDK 提供的类型）
2. 内建 vs 外部插件的发现/加载/卸载
3. 19 个 lifecycle hook 各自的语义
4. provider 插件家族的统一形态（auth + provider + chat.* hooks）
5. 跟 skill 系统的对照
6. 安全模型（或者说：缺失）

<svg viewBox="0 0 760 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Plugin system overview: SDK, internal vs external plugin sources, loader, hooks, trigger and event broadcast">
  <defs>
    <marker id="ar121" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Plugin 系统全景</text>
  <rect x="100" y="32" width="560" height="58" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
  <text x="380" y="54" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">@opencode-ai/plugin（SDK）</text>
  <text x="380" y="72" text-anchor="middle" font-size="10.5" fill="#64748b">Plugin · PluginInput · Hooks · ToolDefinition</text>
  <text x="380" y="86" text-anchor="middle" font-size="10" fill="#94a3b8">类型定义在 packages/plugin/src/index.ts</text>
  <path d="M260,118 L260,98" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar121)"/>
  <path d="M500,118 L500,98" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar121)"/>
  <rect x="40" y="120" width="320" height="158" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.4"/>
  <text x="200" y="142" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">内建插件（打包进核心）</text>
  <text x="200" y="160" text-anchor="middle" font-size="10.5" fill="#64748b">INTERNAL_PLUGINS[] · 直接 import</text>
  <rect x="60" y="170" width="280" height="20" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="200" y="184" text-anchor="middle" font-size="10.5" fill="currentColor">CodexAuthPlugin</text>
  <rect x="60" y="192" width="280" height="20" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="200" y="206" text-anchor="middle" font-size="10.5" fill="currentColor">CopilotAuthPlugin</text>
  <rect x="60" y="214" width="280" height="20" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="200" y="228" text-anchor="middle" font-size="10.5" fill="currentColor">AzureAuthPlugin · XaiAuthPlugin</text>
  <rect x="60" y="236" width="280" height="20" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="200" y="250" text-anchor="middle" font-size="10.5" fill="currentColor">Cloudflare / DigitalOcean / GitLab / Poe</text>
  <text x="200" y="270" text-anchor="middle" font-size="9.5" fill="#94a3b8">RuntimeFlags.disableDefaultPlugins 可一刀全关</text>
  <rect x="400" y="120" width="320" height="158" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.4"/>
  <text x="560" y="142" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">外部插件（npm / file）</text>
  <text x="560" y="160" text-anchor="middle" font-size="10.5" fill="#64748b">config.plugin[] 用户声明</text>
  <rect x="420" y="170" width="280" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="560" y="185" text-anchor="middle" font-size="10.5" fill="currentColor">PluginLoader.resolve()</text>
  <rect x="420" y="194" width="280" height="20" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="434" y="208" font-size="10.5" fill="currentColor">stage 1 ｜ install（npm.add / 路径校验）</text>
  <rect x="420" y="216" width="280" height="20" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="434" y="230" font-size="10.5" fill="currentColor">stage 2 ｜ entry（./server / ./tui exports）</text>
  <rect x="420" y="238" width="280" height="20" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="434" y="252" font-size="10.5" fill="currentColor">stage 3 ｜ compatibility（engines.opencode）</text>
  <text x="560" y="270" text-anchor="middle" font-size="9.5" fill="#94a3b8">→ dynamic import</text>
  <path d="M200,278 L380,316" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar121)"/>
  <path d="M560,278 L380,316" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar121)"/>
  <rect x="180" y="320" width="400" height="60" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
  <text x="380" y="342" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Plugin.Service.layer</text>
  <text x="380" y="360" text-anchor="middle" font-size="11" fill="#64748b">Hooks[] 顺序注册 ｜ trigger / list / init</text>
  <text x="380" y="374" text-anchor="middle" font-size="10" fill="#94a3b8">internal 先 / external 后，同名 hook 多个插件按顺序调用</text>
  <path d="M280,382 L210,418" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar121)"/>
  <path d="M480,382 L550,418" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar121)"/>
  <rect x="40" y="420" width="340" height="100" rx="8" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="210" y="442" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">trigger(name, input, output)</text>
  <text x="210" y="460" text-anchor="middle" font-size="10.5" fill="#64748b">主动触发命名 hook</text>
  <text x="210" y="478" text-anchor="middle" font-size="10" fill="#64748b">chat.params / tool.execute.before / ...</text>
  <text x="210" y="495" text-anchor="middle" font-size="10" fill="#64748b">每个插件改 output；按引用串联</text>
  <text x="210" y="512" text-anchor="middle" font-size="9.5" fill="#94a3b8">顺序执行，throw 会冒泡到 chat</text>
  <rect x="400" y="420" width="320" height="100" rx="8" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="560" y="442" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">bus.subscribeAll()</text>
  <text x="560" y="460" text-anchor="middle" font-size="10.5" fill="#64748b">广播 event hook</text>
  <text x="560" y="478" text-anchor="middle" font-size="10" fill="#64748b">所有 Bus 事件 → 每个插件的 event(input)</text>
  <text x="560" y="495" text-anchor="middle" font-size="10" fill="#64748b">观察专用，返回值被丢弃</text>
  <text x="560" y="512" text-anchor="middle" font-size="9.5" fill="#94a3b8">日志 / 审计 / 外推</text>
</svg>
<span class="figure-caption">图 R12.1 ｜ Plugin 全景：SDK 类型 → 内建/外部双来源 → 三阶段 loader → Plugin.Service → trigger 与 event 两条调用路径。</span>

<details>
<summary>ASCII 原版</summary>

```
                       Plugin 系统全景
   ┌─────────────────────────────────────────────────────────┐
   │  @opencode-ai/plugin (SDK)                              │
   │     Plugin, PluginInput, Hooks, ToolDefinition           │
   └─────────────────────────────────────────────────────────┘
                              ▲
            ┌─────────────────┴───────────────────┐
            │                                       │
   ┌────────────────────┐                ┌─────────────────────┐
   │  内建插件 (打包进核心) │                │  外部插件 (npm/file) │
   │  CodexAuthPlugin     │                │  config.plugin[]     │
   │  CopilotAuthPlugin   │                │  ↓                   │
   │  AzureAuthPlugin     │                │  PluginLoader        │
   │  XaiAuthPlugin       │                │  ├ npm 安装           │
   │  ...                  │                │  ├ 兼容性检查         │
   │                       │                │  └ dynamic import    │
   └────────────────────┘                └─────────────────────┘
            └──────────────────┬────────────────────┘
                               ▼
                       Plugin.Service.layer
                       注册到 hooks[]
                               │
                       ┌───────┴────────┐
                       ▼                ▼
              trigger("...")      bus.subscribeAll()
              event(name,in,out)   广播给所有插件
```

</details>

---

## 1. 插件 vs MCP：何时选哪个

回到引子里那张对照表。具体的决策树：

- **要新加一个 LLM 厂商支持**？→ Plugin。因为要 hook auth 流和 fetch override。
- **要给 LLM 暴露公司内部的搜索/工单 API**？→ MCP。因为它跟 opencode 进程逻辑无关，只是个工具。
- **要在用户每发一条消息前注入额外 system prompt**？→ Plugin。MCP 看不到 chat 阶段。
- **要做"会话归档到 S3"这种 hook**？→ Plugin。监听 `event` hook，写存储。
- **要把一段长字符串放进消息附件**？→ MCP resource。
- **要在工具调用前做 lint/policy**？→ Plugin。`tool.execute.before` hook 可以改 args 甚至 throw 拒绝。

简言之：**MCP 解决"工具/资源"的标准化外部接入；插件解决"opencode 行为的本地定制"**。两者是补充关系，不替代。

---

## 2. `@opencode-ai/plugin` SDK

包路径：`packages/plugin/`。`package.json` 顶层声明 `"name": "@opencode-ai/plugin"`，`exports`：

```jsonc
"exports": {
  ".": "./src/index.ts",
  "./tool": "./src/tool.ts",
  "./tui": "./src/tui.ts"
}
```

三个公开入口：

| 入口 | 干什么 |
| --- | --- |
| `.` | 主类型：`Plugin`, `PluginInput`, `PluginModule`, `Hooks`, `AuthHook`, `ProviderHook`, `WorkspaceAdapter` |
| `./tool` | `tool()` 工厂 + `ToolDefinition`/`ToolContext`/`ToolResult` 类型 |
| `./tui` | TUI 扩展接口（用于 opentui 集成，本章不展开） |

### 2.1 PluginInput：插件能拿到什么

`packages/plugin/src/index.ts:56-66`：

```ts
export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>       // 完整的 opencode HTTP SDK
  project: Project                                      // 当前项目元信息
  directory: string                                     // 项目目录
  worktree: string                                      // 项目 worktree 根
  experimental_workspace: {
    register(type: string, adapter: WorkspaceAdapter): void
  }
  serverUrl: URL                                        // opencode 自身 HTTP server URL
  $: BunShell                                           // Bun.$ shell（如果在 Bun 下运行）
}
```

注意两点：

- **`client` 是 opencode 自己的 SDK**。插件可以反过来调 opencode 的 API：拿当前 session、改 auth 凭据、列模型——这是为什么 provider 插件能持久化 OAuth 凭据（见 §6）。
- **`$` 是 Bun.$ shell**。如果运行在 Node 而非 Bun 下，这个字段是 undefined。`packages/opencode/src/plugin/index.ts:150-151`：

```ts
// @ts-expect-error
$: typeof Bun === "undefined" ? undefined : Bun.$,
```

### 2.2 Plugin 签名

```ts
// packages/plugin/src/index.ts:74
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>

// packages/plugin/src/index.ts:76-80
export type PluginModule = {
  id?: string
  server: Plugin
  tui?: never
}
```

插件作者写一个 default export，要么是 v0 风格（直接 export 函数）要么是 v1 风格（export `{ id, server }` 对象）。loader 两种都接受（见 §4）。

### 2.3 Hooks：19 个生命周期挂钩

`Hooks` 接口（`packages/plugin/src/index.ts:222-333`）是插件能挂载的所有锚点。完整列表：

| Hook 名 | 触发时机 | 主要用途 |
| --- | --- | --- |
| `event` | 任何 bus 事件 | 通用监听器 |
| `config` | 初始化后或配置变更 | 接收最终 Config 做记账 |
| `tool` | 注册阶段 | 暴露 `{ [name]: ToolDefinition }` 给 LLM |
| `auth` | 鉴权 | 见 §6.1 |
| `provider` | provider 列举模型时 | 见 §6.2 |
| `chat.message` | 收到一条用户消息后 | 改/补 parts |
| `chat.params` | 即将发请求给 LLM 前 | 改 temperature/topP/maxOutputTokens/options |
| `chat.headers` | 即将发请求给 LLM 前 | 改 HTTP headers |
| `permission.ask` | 工具/命令要权限时 | 自动 allow/deny |
| `command.execute.before` | slash command 执行前 | 改 parts |
| `tool.execute.before` | 工具调用前 | 改 args 或 throw 拒绝 |
| `tool.execute.after` | 工具调用后 | 改 title/output/metadata |
| `tool.definition` | 工具 def 给 LLM 前 | 改 description/parameters |
| `shell.env` | shell 工具调用前 | 注入环境变量 |
| `experimental.chat.messages.transform` | 发给 LLM 前 | 改整个消息列表 |
| `experimental.chat.system.transform` | 发给 LLM 前 | 改 system prompt 数组 |
| `experimental.session.compacting` | 即将 compact session 前 | 改 compaction prompt |
| `experimental.compaction.autocontinue` | compact 后 | 控制是否自动 continue |
| `experimental.text.complete` | 文本片段完成 | 改最终文本 |

所有 trigger hook（除 `event` / `config` / `tool` / `auth` / `provider`）的签名都是 `(input, output) => Promise<void>`。插件**通过修改 `output` 对象的字段来改变行为**——返回值无意义。这是为了让多个插件都能挂同一个 hook、按顺序修改、互不冲突。

例：一个改默认 temperature 的插件可以这样写：

```ts
const ColdPlugin: Plugin = async () => ({
  "chat.params": async (input, output) => {
    if (input.agent === "code") output.temperature = 0
  },
})
```

### 2.4 ToolDefinition

`packages/plugin/src/tool.ts:45-51`：

```ts
export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) { return input }
tool.schema = z
```

`ToolContext`（`packages/plugin/src/tool.ts:3-20`）给插件工具的 sandbox：

```ts
export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  directory: string         // session-scoped
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: { [key: string]: any } }): void
  ask(input: AskInput): Promise<void>   // 权限确认
}
```

最简单的插件工具示例（`packages/plugin/src/example.ts`，整文件）：

```ts
import { Plugin } from "./index.js"
import { tool } from "./tool.js"

export const ExamplePlugin: Plugin = async (_ctx) => {
  return {
    tool: {
      mytool: tool({
        description: "This is a custom tool",
        args: { foo: tool.schema.string().describe("foo") },
        async execute(args) { return `Hello ${args.foo}!` },
      }),
    },
  }
}
```

10 行就完成了"给 LLM 加一个工具"，对比 MCP 写一个 server 至少几十行外加依赖一个跑起来的进程。

---

## 3. 内建插件：直接 import

`packages/opencode/src/plugin/index.ts:61-71` 列出了所有打包进核心的内建插件：

```ts
const INTERNAL_PLUGINS: PluginInstance[] = [
  CodexAuthPlugin,            // ./codex.ts
  CopilotAuthPlugin,          // ./github-copilot/copilot.ts
  GitlabAuthPlugin,           // npm: opencode-gitlab-auth
  PoeAuthPlugin,              // npm: opencode-poe-auth
  CloudflareWorkersAuthPlugin,
  CloudflareAIGatewayAuthPlugin,
  AzureAuthPlugin,
  DigitalOceanAuthPlugin,
  XaiAuthPlugin,
]
```

这些插件**直接 import 进 opencode 二进制**，不走 npm 解析。两个 npm 包（`opencode-gitlab-auth` / `opencode-poe-auth`）也被锁在 `package.json` 里作为运行时依赖。

为什么这些不做成外部插件？因为它们是"基础设施级"：缺了 GitHub Copilot 鉴权，对应 provider 就没法用。这些插件没必要让用户去 install——它们应该默认就在。

但是！可以通过 `RuntimeFlags.disableDefaultPlugins`（`packages/opencode/src/plugin/index.ts:154`）一刀全关：

```ts
for (const plugin of flags.disableDefaultPlugins ? [] : INTERNAL_PLUGINS) {
  log.info("loading internal plugin", { name: plugin.name })
  const init = yield* Effect.tryPromise({
    try: () => plugin(input),
    catch: (err) => log.error("failed to load internal plugin", { name: plugin.name, error: err }),
  }).pipe(Effect.option)
  if (init._tag === "Some") hooks.push(init.value)
}
```

每个插件都被 wrap 在 `Effect.option`——单个内建插件失败不会拖垮整个 opencode。

---

## 4. 外部插件加载：PluginLoader

外部插件来源由用户在 `opencode.json` 里写：

```jsonc
{
  "plugin": [
    "my-plugin-from-npm",
    ["my-plugin-with-opts", { "foo": "bar" }],
    "file:///Users/me/projects/local-plugin",
    "./relative/local-plugin"
  ]
}
```

字符串 = npm 名（或 file: URI / 相对路径）；元组 = `[spec, options]`，options 在加载时传给插件 `(input, options)`。

### 4.1 Spec 分类：file vs npm

`packages/opencode/src/plugin/shared.ts:171-173`：

```ts
export function isPathPluginSpec(spec: string) {
  return spec.startsWith("file://") || spec.startsWith(".") || isAbsolutePath(spec)
}
```

`pluginSource(spec)` 返回 `"file"` 或 `"npm"`。这个判断决定了后续流程：

- **file**：直接 `pathToFileURL()` + `import()`，本地路径直接走。
- **npm**：先调 `Npm.add(pkg)`（`packages/opencode/src/plugin/shared.ts:212`）确保包已经安装到本地缓存，再走相同的 import 流程。

### 4.2 PluginLoader.resolve：三阶段

`packages/opencode/src/plugin/loader.ts:85-132` 的 `resolve()` 把一个 spec 转成可 import 的入口路径，三阶段：

```ts
export async function resolve(plan: Plan, kind: PluginKind):
  Promise<{ ok: true; value: Resolved }
        | { ok: false; stage: "missing"; value: Missing }
        | { ok: false; stage: "install" | "entry" | "compatibility"; error: unknown }> {

  // Stage 1: install（npm 安装 / file 路径校验）
  let target = ""
  try { target = await resolvePluginTarget(plan.spec) }
  catch (error) { return { ok: false, stage: "install", error } }

  // Stage 2: entry（找到 ./server 或 ./tui 入口）
  let base
  try { base = await createPluginEntry(plan.spec, target, kind) }
  catch (error) { return { ok: false, stage: "entry", error } }
  if (!base.entry) return { ok: false, stage: "missing", value: {...} }

  // Stage 3: compatibility（package.json 的 engines.opencode 校验）
  if (base.source === "npm") {
    try { await checkPluginCompatibility(base.target, InstallationVersion, base.pkg) }
    catch (error) { return { ok: false, stage: "compatibility", error } }
  }

  return { ok: true, value: {...} }
}
```

三阶段分离的好处：报错时能给出准确的失败类型，CLI 和 UI 不需要解析错误字符串。

### 4.3 入口选择规则

`packages/opencode/src/plugin/shared.ts:99-114`：

```ts
function resolvePackageEntrypoint(spec, kind, pkg) {
  const exports = pkg.json.exports
  if (isRecord(exports)) {
    const raw = extractExportValue(exports[`./${kind}`])  // 看 "./server" 或 "./tui"
    if (raw) return resolvePackagePath(spec, raw, kind, pkg)
  }
  if (kind !== "server") return
  const main = packageMain(pkg)
  if (!main) return
  return resolvePackagePath(spec, main, kind, pkg)  // server kind 兜底用 main
}
```

约定：**插件包应该在 `package.json` 的 `exports["./server"]`（或 `./tui`）声明对应入口**。如果只声明了 `main`，opencode 把它当成 server 入口。tui 没有兜底——TUI 插件必须显式 export。

### 4.4 兼容性检查

`packages/opencode/src/plugin/shared.ts:194-205`：

```ts
export async function checkPluginCompatibility(target, opencodeVersion, pkg?) {
  if (!semver.valid(opencodeVersion) || semver.major(opencodeVersion) === 0) return
  const hit = pkg ?? (await readPluginPackage(target).catch(() => undefined))
  if (!hit) return
  const engines = hit.json.engines
  if (!isRecord(engines)) return
  const range = engines.opencode
  if (typeof range !== "string") return
  if (!semver.satisfies(opencodeVersion, range)) {
    throw new Error(`Plugin requires opencode ${range} but running ${opencodeVersion}`)
  }
}
```

npm 插件可以在 `package.json` 写：

```json
{ "engines": { "opencode": ">=1.10.0 <2.0.0" } }
```

不满足版本范围就拒绝加载。File 插件跳过这个检查（开发者本地代码不要拦自己）。注意 v0.x.y 也跳过——early-stage 阶段大家都频繁改。

### 4.5 默认模式与 v1 探测

`packages/opencode/src/plugin/index.ts:99-110`：

```ts
async function applyPlugin(load: PluginLoader.Loaded, input: PluginInput, hooks: Hooks[]) {
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    hooks.push(await (plugin as PluginModule).server(input, load.options))
    return
  }

  for (const server of getLegacyPlugins(load.mod)) {
    hooks.push(await server(input, load.options))
  }
}
```

`readV1Plugin(mod, spec, "server", "detect")`（`packages/opencode/src/plugin/shared.ts:272-304`）：

```ts
const value = mod.default
if (!isRecord(value)) {
  if (mode === "detect") return  // 探测模式下找不到不报错，回落到 legacy
  throw new TypeError(`Plugin ${spec} must default export an object with ${kind}()`)
}
if (mode === "detect" && !("id" in value) && !("server" in value) && !("tui" in value)) return
// ... 校验 server/tui 是函数
return value
```

两种插件形态都接受：

- **v0 legacy**：`export const MyPlugin: Plugin = async (input) => { ... }`（顶层命名 export 是函数）
- **v1**：`export default { id: "my-plugin", server: async (input) => { ... } }`

v1 形态允许声明 `id`，loader 用它做去重和元数据存储（见 §5）。

### 4.6 并发加载与依赖等待

`packages/opencode/src/plugin/loader.ts:207-235` 的 `loadExternal()`：

```ts
export async function loadExternal<R = Loaded>(input: Input<R>): Promise<R[]> {
  const candidates = input.items.map((origin) => ({ origin, plan: plan(origin.spec) }))
  const list: Array<Promise<AttemptResult<R>>> = []
  for (const candidate of candidates) {
    list.push(attempt(candidate, input.kind, false, input.finish, input.missing, input.report))
  }
  const out = await Promise.all(list)
  if (input.wait) {
    let deps: Promise<void> | undefined
    for (let i = 0; i < candidates.length; i++) {
      const previous = out[i]
      if (previous?.value !== undefined) continue
      if (previous?.retry !== true) continue
      const candidate = candidates[i]
      if (!candidate || pluginSource(candidate.plan.spec) !== "file") continue
      deps ??= input.wait()
      await deps
      out[i] = await attempt(candidate, input.kind, true, input.finish, input.missing, input.report)
    }
  }
  const ready: R[] = []
  for (const item of out) if (item.value !== undefined) ready.push(item.value)
  return ready
}
```

两阶段：

1. **并发跑一遍**所有候选插件的 attempt。
2. **失败的 file 插件**，如果 `isRetryableResolveError`（错误消息含 "missing package.json or index file"），等 `input.wait()` 解决（一般是 config 加载完依赖），再 retry 一次。

为什么只 retry 文件类型且只 retry 一次？因为 Bun 缓存失败的 dynamic import——同一个路径第二次也会失败。所以一旦 import 失败这条路径就废了，只能在导入前的早期阶段（路径找不到）retry。

### 4.7 错误分类与上报

`packages/opencode/src/plugin/index.ts:171-211` 的 `report` 回调把不同阶段的错误差异化处理：

```ts
report: {
  start(candidate) { log.info("loading plugin", { path: candidate.plan.spec }) },
  missing(candidate, _retry, message) {
    log.warn("plugin has no server entrypoint", { path: candidate.plan.spec, message })
  },
  error(candidate, _retry, stage, error, resolved) {
    const spec = candidate.plan.spec
    const cause = error instanceof Error ? (error.cause ?? error) : error
    const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

    if (stage === "install") {
      const parsed = parsePluginSpecifier(spec)
      log.error("failed to install plugin", { pkg: parsed.pkg, version: parsed.version, error: message })
      publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
      return
    }
    if (stage === "compatibility") {
      log.warn("plugin incompatible", { path: spec, error: message })
      publishPluginError(`Plugin ${spec} skipped: ${message}`)
      return
    }
    if (stage === "entry") {
      log.error("failed to resolve plugin server entry", { path: spec, error: message })
      publishPluginError(`Failed to load plugin ${spec}: ${message}`)
      return
    }
    log.error("failed to load plugin", { path: spec, target: resolved?.entry, error: message })
    publishPluginError(`Failed to load plugin ${spec}: ${message}`)
  },
}
```

`publishPluginError` 把错误发到 `Session.Event.Error`，TUI 能在状态栏看到——而不是让 opencode 启动失败。

---

## 5. 插件元数据：plugin-meta.json

`packages/opencode/src/plugin/meta.ts` 把每个插件的"加载指纹"持久化到 `${Global.Path.state}/plugin-meta.json`。条目（`meta.ts:20-34`）：

```ts
export type Entry = {
  id: string                              // plugin id
  source: "file" | "npm"
  spec: string                            // 用户配置里的 spec
  target: string                          // 解析到的具体路径
  requested?: string                      // npm spec 的版本部分（latest / "1.2.3" / ...）
  version?: string                        // 实际 package.json 里的 version
  modified?: number                       // file 类型的 mtime
  first_time: number                      // 首次加载时间
  last_time: number                       // 最近加载时间
  time_changed: number                    // 最近指纹变化时间
  load_count: number                      // 累计加载次数
  fingerprint: string                     // 用于变化检测
  themes?: Record<string, Theme>          // TUI 主题
}
```

`fingerprint`（`meta.ts:108-111`）的算法：

```ts
function fingerprint(value: Core) {
  if (value.source === "file") return [value.target, value.modified ?? ""].join("|")
  return [value.target, value.requested ?? "", value.version ?? ""].join("|")
}
```

文件插件指纹 = 路径 + mtime；npm 插件指纹 = 路径 + requested + actual version。`touchMany()` 在每次加载时用 Flock（文件锁）原子读写，对比指纹得出 state：

```
first   ← 第一次见到这个 id
updated ← 指纹变了（升级 / 文件改了 / 切换了版本）
same    ← 指纹相同
```

这些元数据当前只被 plugin 自己用——例如主题文件刷新（`setTheme()`，`meta.ts:169-181`）依赖 entry 的 themes 字段。未来可以用来给"插件升级提示"或者"自动迁移"做依据。

---

## 6. 插件类别详解

### 6.1 Auth 插件：AuthHook

`AuthHook`（`packages/plugin/src/index.ts:88-163`）让插件接管一个 provider 的鉴权流程：

```ts
export type AuthHook = {
  provider: string                                      // provider id
  loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, any>>
  methods: (AuthMethod | ApiKeyMethod)[]
}
```

`methods` 是用户在 `opencode auth login` 里能选的鉴权方式列表。每种方式定义：

- `label`：UI 显示
- `prompts`：交互式输入（text / select）
- `authorize`：异步实现，返回 OAuth URL + 回调 / API key

`loader` 是关键：它返回 `{ apiKey, fetch }` 让 opencode 的 LLM 请求层走这个自定义 fetch。**provider 插件的 fetch override 是它们能拦截和改写 LLM 请求/响应的入口**。

#### 例 1：Azure（API key only）

`packages/opencode/src/plugin/azure.ts:3-26`，全文 26 行：

```ts
export async function AzureAuthPlugin(_input: PluginInput): Promise<Hooks> {
  const prompts = []
  if (!process.env.AZURE_RESOURCE_NAME) {
    prompts.push({
      type: "text" as const,
      key: "resourceName",
      message: "Enter Azure Resource Name",
      placeholder: "e.g. my-models",
    })
  }
  return {
    auth: {
      provider: "azure",
      methods: [{ type: "api", label: "API key", prompts }],
    },
  }
}
```

只声明"这个 provider 接受 API key"，外加一个引导用户填 resource name 的 prompt。没有 OAuth、没有 fetch override——Azure 的 LLM 请求层直接用 API key 走标准 OpenAI 兼容路径。

#### 例 2：Codex（OAuth + fetch 重写）

`packages/opencode/src/plugin/codex.ts:371-648` 是个 280 行的完整例子。框架：

```ts
export async function CodexAuthPlugin(input: PluginInput, options = {}): Promise<Hooks> {
  return {
    provider: {
      id: "openai",
      async models(provider, ctx) {
        if (ctx.auth?.type !== "oauth") return provider.models
        // OAuth 模式下过滤模型列表，只保留 ChatGPT Pro/Plus 能访问的 gpt-5.x
        return Object.fromEntries(
          Object.entries(provider.models)
            .filter(([, model]) => ALLOWED_MODELS.has(model.api.id) || /^gpt-(\d+\.\d+)/.test(model.api.id))
            .map(([id, model]) => [id, { ...model, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }]),
        )
      },
    },
    auth: {
      provider: "openai",
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}
        let refreshPromise: Promise<...> | undefined
        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput, init) {
            // 1. 清掉 SDK 默认设的 authorization header
            // 2. 拿当前 auth，必要时 refresh
            // 3. 设新 authorization + ChatGPT-Account-Id headers
            // 4. 重写 URL：/v1/responses 或 /chat/completions → CODEX_API_ENDPOINT
            return fetch(url, { ...init, headers })
          },
        }
      },
      methods: [
        { label: "ChatGPT Pro/Plus (browser)", type: "oauth", authorize: async () => {...} },
        { label: "ChatGPT Pro/Plus (headless)", type: "oauth", authorize: async () => {...} },
        { label: "Manually enter API Key", type: "api" },
      ],
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== "openai") return
      output.headers.originator = "opencode"
      output.headers["User-Agent"] = `opencode/${InstallationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers.session_id = input.sessionID
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "openai") return
      output.maxOutputTokens = undefined  // Codex CLI 风格
    },
  }
}
```

要点：

- `OAUTH_DUMMY_KEY` 是个假 API key 仅为通过 `@ai-sdk/openai` 的"apiKey 必填"校验，真正的鉴权头由 `fetch` override 设置。
- **单飞 refresh**：`refreshPromise` 用 closure 变量去重，防止并发请求同时各发一个 refresh，rotating refresh_token 会被服务端撤销。
- 端点重写：`/v1/responses` 和 `/chat/completions` 一律改写到 `https://chatgpt.com/backend-api/codex/responses`——ChatGPT 后端不在标准 OpenAI 路径上。
- `ChatGPT-Account-Id` header：组织订阅必填，从 JWT 解析得到。

#### 例 3：xAI（device code + loopback）

`packages/opencode/src/plugin/xai.ts:571+` 是 742 行的最长例子，覆盖：

- OAuth Authorization Code 流（loopback `127.0.0.1:56121/callback`）
- RFC 8628 Device Authorization Grant（headless 场景，VPS/容器无浏览器）
- Refresh-token 轮换 + JWT exp 解析
- Single-flight refresh
- xAI 公开 Grok-CLI 的 client_id 复用（自注册 desktop client）

完整流程跟 Codex 类似，差别在两个 OAuth 路径并存，让用户根据环境选。

#### Provider 插件家族的共同结构

把 Codex / Copilot / GitLab / Poe / Cloudflare / Azure / DigitalOcean / xAI 摊开看，公共骨架：

```ts
export async function XxxAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    provider: {                       // 改模型列表（可选）
      id: "xxx",
      async models(provider, ctx) { ... },
    },
    auth: {
      provider: "xxx",                // 鉴权
      async loader(getAuth) {         // fetch override
        return { apiKey: ..., fetch: async (req, init) => { ... } }
      },
      methods: [                      // 鉴权方式
        { type: "oauth", ... },
        { type: "api", ... },
      ],
    },
    "chat.headers": async (i, o) => { ... },  // 加自定义 headers
    "chat.params": async (i, o) => { ... },   // 改 LLM 参数
  }
}
```

差异主要在：

- **OAuth 流细节**：loopback / device code / browser / token endpoint。
- **fetch override 的复杂度**：从纯透传（Cloudflare Workers，只接 API key）到完整重写（Codex / Copilot 改 URL、改 headers、注入 vision 处理）。
- **provider.models 的策略**：有的过滤、有的补字段（Copilot 给每个模型加 `npm: "@ai-sdk/github-copilot"` 触发对应 SDK 加载——见 `github-copilot/copilot.ts:46-55`）。

### 6.2 ProviderHook：模型清单

`ProviderHook`（`packages/plugin/src/index.ts:214-217`）：

```ts
export type ProviderHook = {
  id: string
  models?: (provider: ProviderV2, ctx: ProviderHookContext) => Promise<Record<string, ModelV2>>
}
```

opencode 的 provider 注册中心列举模型时会调每个匹配 `id` 的插件 `models()`。插件可以：

- 返回空对象 = 隐藏所有模型
- 过滤掉某些（如 Codex 只保留 gpt-5.x）
- 增加新模型（Copilot 动态从 GitHub Copilot API 拉取用户可用的模型列表）
- 修改已有模型字段（cost / limit / api.url / api.npm）

### 6.3 WorkspaceAdapter：experimental_workspace

`packages/plugin/src/index.ts:47-54`：

```ts
export type WorkspaceAdapter = {
  name: string
  description: string
  configure(config: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>
  create(config, env, from?): Promise<void>
  remove(config): Promise<void>
  target(config: WorkspaceInfo): WorkspaceTarget | Promise<WorkspaceTarget>
}
```

通过 `input.experimental_workspace.register(type, adapter)` 注册（`packages/opencode/src/plugin/index.ts:142-146`）。控制平面（`packages/opencode/src/control-plane/`）会用注册的 adapter 创建 / 配置 / 销毁会话所属的 workspace（可能是本地目录、可能是远程容器）。

示例（`packages/plugin/src/example-workspace.ts`，34 行）：

```ts
export const FolderWorkspacePlugin: Plugin = async ({ experimental_workspace }) => {
  experimental_workspace.register("folder", {
    name: "Folder",
    description: "Create a blank folder",
    configure(config) {
      const rand = "" + Math.random()
      return { ...config, directory: `/tmp/folder/folder-${rand}` }
    },
    async create(config) {
      if (!config.directory) return
      await mkdir(config.directory, { recursive: true })
    },
    async remove(config) { await rm(config.directory!, { recursive: true, force: true }) },
    target(config) { return { type: "local", directory: config.directory! } },
  })
  return {}
}
```

10 行就把"会话 = 一个临时空目录"这个 workspace 类型加进 opencode。

---

## 7. trigger 与 event：插件如何被调用

`Plugin.Service` 对外只暴露 3 个方法（`packages/opencode/src/plugin/index.ts:44-56`）：

```ts
export interface Interface {
  readonly trigger: <Name, Input, Output>(name: Name, input: Input, output: Output) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
}
```

### 7.1 trigger：顺序调所有挂了同名 hook 的插件

`packages/opencode/src/plugin/index.ts:263-276`：

```ts
const trigger = Effect.fn("Plugin.trigger")(function* <Name>(name, input, output) {
  if (!name) return output
  const s = yield* InstanceState.get(state)
  for (const hook of s.hooks) {
    const fn = hook[name] as any
    if (!fn) continue
    yield* Effect.promise(async () => fn(input, output))
  }
  return output
})
```

注意：

- **顺序**而非并行——这样多个插件改同一个 output 的顺序确定。
- **不捕获 throw**——`Effect.promise` 失败会沿用 effect 错误链向上抛。一个插件的 hook crash 会让本次 chat 失败，不会静默吞。
- **input 也是按引用传**——插件理论上能改 input，但语义上不该（input 是观察）。

调用方比如 chat 模块（详见第 06 章）：

```ts
const params = yield* plugin.trigger("chat.params", { sessionID, agent, model, ... }, defaultParams)
// 现在 params 已经被所有 chat.params hook 修改过
```

### 7.2 event：所有 bus 事件广播给插件

`packages/opencode/src/plugin/index.ts:248-257`：

```ts
yield* (yield* bus.subscribeAll()).pipe(
  Stream.runForEach((input) =>
    Effect.sync(() => {
      for (const hook of hooks) {
        void hook["event"]?.({ event: input as any })
      }
    }),
  ),
  Effect.forkScoped,
)
```

opencode 内部所有 Bus 事件（详见第 02 章）——session 创建、消息变更、tool 执行、MCP 状态——都会被同步推给每个挂了 `event` hook 的插件。`void` 表示忽略返回——event hook 不能改任何东西，只能观察。这是"插件做日志/审计/外推到第三方系统"的钩子。

---

## 8. Plugin vs Skill：另一个对照

opencode 还有第三种扩展机制——**Skill**（`packages/opencode/src/skill/`，对应 SKILL.md 文件）。三者的对比：

| 维度 | MCP server | Plugin | Skill |
| --- | --- | --- | --- |
| 内容 | 二进制/脚本程序 | JS/TS 代码 | 一段 Markdown |
| 谁执行 | 外部进程 | opencode 进程 | LLM 自己读 |
| 触发 | LLM 调用 tool | opencode 调 hook | LLM 调 `skill` tool |
| 状态 | 自维护 | 共享 opencode | 无 |
| 例 | filesystem-mcp、github-mcp | XaiAuthPlugin | customize-opencode skill |

`packages/opencode/src/skill/index.ts:32-34` 定义了内建的 `customize-opencode` skill：

> Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. ...

当 LLM 决定"用户在编辑 opencode 配置"时，它会调 `skill` 工具（`packages/opencode/src/tool/skill.ts:14`）传 name=`customize-opencode`，工具实现：

1. 从 `Skill.Service` 取出 SKILL.md 的全文
2. 列出 skill 目录下的相关文件（用 ripgrep）
3. 把 skill 内容、base directory、文件列表打包进结果丢回给 LLM

Skill 的实质是**让 LLM 自己 RAG 一段精心设计的提示**。它跟 plugin 完全不同维度：plugin 改宿主行为，skill 改 LLM 的上下文。

为什么这么分？因为它们的成本和受众不同：

- 写一个 skill = 写 Markdown，谁都行
- 写一个 plugin = 写 TS、配 npm、理解 hook 时机、调试 Effect
- 写一个 MCP server = 配独立进程、维护协议、做发布

Skill 是**面向运营者/用户的扩展**；plugin 是**面向 SDK 开发者**；MCP 是**面向工具厂商**。

---

## 9. 安全模型

简单粗暴的现实：**v1.15.10 没有插件 sandbox**。

插件代码会被直接 `import()` 进 opencode 主进程。一旦导入：

- 它可以读写文件系统（opencode 进程权限范围内）
- 它可以发任意网络请求
- 它可以读取 `process.env`（包含 OAuth tokens）
- 它可以调用 `input.client` 改 opencode 的 auth / sessions / config
- 它可以 hook `tool.execute.before` 拦截并修改用户工具调用的参数

设计取舍：opencode 的扩展点设计是**给鉴权流程留接口**——provider 插件 *必须* 拿到 fetch override 才能工作，*必须* 持久化 tokens 才能 refresh。这种能力跟 sandbox 是矛盾的。

实际的安全靠以下三层：

1. **npm 安装时的人工审计**：用户在 `opencode plugin install <pkg>` 时是知情的。
2. **internal vs external 区分**：内建插件直接 import 来源是 opencode 源码本身，发布流程可控；外部插件来源是配置里写明的 spec。
3. **engines.opencode 兼容性范围**：插件升级 opencode 版本变了，至少能拦下不兼容版本。

`packages/opencode/src/plugin/shared.ts:10-14` 还有一个反向兼容机制：

```ts
export const DEPRECATED_PLUGIN_PACKAGES = ["opencode-openai-codex-auth", "opencode-copilot-auth"]
export function isDeprecatedPlugin(spec: string) {
  return DEPRECATED_PLUGIN_PACKAGES.some((pkg) => spec.includes(pkg))
}
```

这些旧 npm 包已被吸收进内建插件。`loader.ts:160-162` 看到 deprecated 直接跳过：

```ts
if (plan.deprecated) return { retry: false }
```

避免一台机器同时跑两份 Codex 鉴权插件互相覆盖。

---

## 10. `opencode plugin <module>` CLI

`packages/opencode/src/cli/cmd/plug.ts:178-230`：

```ts
export const PluginCommand = effectCmd({
  command: "plugin <module>",
  aliases: ["plug"],
  describe: "install plugin and update config",
  builder: (yargs) =>
    yargs
      .positional("module", { type: "string", describe: "npm module name" })
      .option("global", { alias: ["g"], type: "boolean", default: false })
      .option("force", { alias: ["f"], type: "boolean", default: false }),
  handler: Effect.fn("Cli.plug")(function* (args) {
    const mod = String(args.module ?? "").trim()
    if (!mod) { UI.error("module is required"); process.exitCode = 1; return }
    intro(`Install plugin ${mod}`)
    const run = createPlugTask({ mod, global: Boolean(args.global), force: Boolean(args.force) })
    const ctx = yield* InstanceRef
    if (!ctx) return
    const ok = yield* Effect.promise(() =>
      run({ vcs: ctx.project.vcs, worktree: ctx.worktree, directory: ctx.directory })
    )
    outro("Done")
    if (!ok) process.exitCode = 1
  }),
})
```

实际任务流（`packages/opencode/src/cli/cmd/plug.ts:70-176`）：

1. `installPlugin(mod)` 调 `resolvePluginTarget(spec)`——对 npm spec 触发 `Npm.add()` 实际安装到本地缓存。
2. `readPluginManifest(target)` 读 package.json，识别有哪些 `exports["./server"]` / `exports["./tui"]`，得到 `Target[]`。
3. `patchPluginConfig(...)` 把 `[spec, options?]` 插进 `.opencode/opencode.json`（项目级）或 `~/.config/opencode/opencode.json`（`--global`）的 `plugin` 数组——用 jsonc-parser 保留注释。
4. 如果包同时声明了 `./server` 和 `./tui`，会被分别 patch 到 `opencode.json` 和 `tui.json`。
5. 默认重复检测：如果配置里已经有同 pkg 的插件，noop；`--force` 强制覆盖最旧的，删剩余的。

注意：`opencode plugin` 安装完不会重启正在运行的 opencode 实例——下次启动才生效。这跟 `opencode mcp connect/disconnect`（运行时即时生效）不同，因为插件 import 之后就嵌进 V8 模块缓存，干净卸载需要重启进程。

---

## 11. 一些边界与坑

| 问题 | 现状 | 备注 |
| --- | --- | --- |
| 插件运行时重载 | 不支持 | Bun module cache 不允许重新 import 同路径 |
| Plugin throw 会咋样 | 拖垮当前 chat | 没有 per-hook try/catch |
| 多个插件改同个 output | 按 `INTERNAL_PLUGINS` 顺序 + 外部 `plugin[]` 顺序 | 最后一个赢 |
| Plugin 互访 | 没有协议 | 想互相通信只能通过 Bus 事件 |
| Skill vs Plugin 命名冲突 | 不冲突 | Skill 是 LLM tool 的参数；Plugin 是宿主代码 |
| Plugin tool 命名冲突 | 跟内建/MCP tool | 没有 namespace，谁先注册谁赢（不推荐自定义工具名跟内建撞） |
| `experimental_workspace` 的语义 | 还在迭代 | 前缀已经写了 experimental |
| `engines.opencode` < v1.0.0 | 跳过版本检查 | 当前 v1.15.10 之后会强制 |

---

## 12. 跟其他章节的关系

- 第 02 章 Bus：插件 `event` hook 是 Bus 全订阅的消费者。
- 第 03 章 配置：`plugin` 字段、`plugin_origins` 衍生字段、jsonc 写回的细节。
- 第 04 章 工具系统：插件 `tool` hook 注入的工具如何混进 Tool registry。
- 第 06 章 Chat 主循环：`chat.params`/`chat.headers`/`chat.message` 几个 hook 的精确触发点。
- 第 11 章 MCP：跨进程协议 vs 进程内插件。
- 第 13 章 鉴权：provider 插件家族的 OAuth 状态如何沉淀到 `auth.json`。

---

## 13. 一句话总结

opencode 的插件 = "默认 export 一个 `(input, options) => Promise<Hooks>` 函数的 npm/file 模块"，被 `PluginLoader` 三阶段解析（install / entry / compatibility）后动态 import 到主进程，hooks 注册到 `Plugin.Service`，由 `trigger(name, input, output)` 顺序调用、由 Bus 全订阅广播 `event` 事件；它跟 MCP 互补——MCP 标准化外部工具，插件定制宿主行为；跟 Skill 互补——Skill 改 LLM 上下文，插件改宿主代码。
