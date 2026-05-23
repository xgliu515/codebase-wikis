# 02. 配置与多提供商鉴权

opencode 要在同一台机器上同时支持几十种 LLM provider、四五种鉴权机制（裸 API key、OAuth token、ChatGPT/Claude.ai 订阅、企业 Vertex / Bedrock、device code、公共代理），还要让用户在项目目录和全局目录用不同配置覆盖。本章拆开它的解决方案：分层 JSON / JSONC 加载、Effect Schema 描述的 Config，和把鉴权抽象成 `Auth.Info union + Plugin.auth methods` 的组合机制。

## 2.1 配置文件加载顺序与合并语义

入口在 `packages/opencode/src/config/config.ts:510-790` 的 `loadInstanceState(ctx)`。一次 instance 启动（一次进入项目目录）会顺序执行 9 个合并步骤，每步都通过 `merge(source, next, scope)` 把新配置合到 `result` 里：

<svg viewBox="0 0 760 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Nine layer merge order from wellknown to MDM managed preferences">
  <defs>
    <marker id="r2ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">配置合并顺序（loadInstanceState）── 编号越大优先级越高</text>
  <text x="40" y="50" font-size="10.5" fill="#64748b">优先级低</text>
  <text x="720" y="50" text-anchor="end" font-size="10.5" fill="#64748b">优先级高（覆盖前者）</text>
  <line x1="40" y1="56" x2="720" y2="56" stroke="#cbd5e1" stroke-dasharray="4,3"/>
  <rect x="40" y="66" width="680" height="30" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="54" y="86" font-size="11" font-weight="600" fill="currentColor">① wellknown 远程配置</text>
  <text x="270" y="86" font-size="10" fill="#64748b">由 auth.json 里 wellknown 凭证 fetch &lt;url&gt;/.well-known/opencode</text>
  <rect x="40" y="100" width="680" height="30" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="54" y="120" font-size="11" font-weight="600" fill="currentColor">② global config</text>
  <text x="270" y="120" font-size="10" fill="#64748b">~/.config/opencode/{opencode.json, opencode.jsonc, config.json}</text>
  <rect x="40" y="134" width="680" height="30" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="54" y="154" font-size="11" font-weight="600" fill="currentColor">③ OPENCODE_CONFIG</text>
  <text x="270" y="154" font-size="10" fill="#64748b">env var 指向单个 JSON 文件</text>
  <rect x="40" y="168" width="680" height="30" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="54" y="188" font-size="11" font-weight="600" fill="currentColor">④ 项目级 opencode.json</text>
  <text x="270" y="188" font-size="10" fill="#64748b">从 cwd 向上找到 worktree 根，远者先合、近者后合</text>
  <rect x="40" y="202" width="680" height="30" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="54" y="222" font-size="11" font-weight="600" fill="currentColor">⑤ .opencode/ 子目录</text>
  <text x="270" y="222" font-size="10" fill="#64748b">ConfigPaths.directories 里每个 .opencode/opencode.json</text>
  <rect x="40" y="236" width="680" height="30" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="54" y="256" font-size="11" font-weight="600" fill="currentColor">⑥ OPENCODE_CONFIG_CONTENT</text>
  <text x="290" y="256" font-size="10" fill="#64748b">env var 里直接放整段 JSON</text>
  <rect x="40" y="270" width="680" height="30" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="54" y="290" font-size="11" font-weight="600" fill="currentColor">⑦ Account active org</text>
  <text x="270" y="290" font-size="10" fill="#64748b">opencode console 拉远端 org 配置</text>
  <rect x="40" y="304" width="680" height="30" rx="4" fill="#0ea5e9" stroke="#0ea5e9" stroke-width="1.2" fill-opacity="0.2"/>
  <text x="54" y="324" font-size="11" font-weight="600" fill="currentColor">⑧ ConfigManaged.managedConfigDir</text>
  <text x="320" y="324" font-size="10" fill="#64748b">/etc/opencode/ 系统管理员推送</text>
  <rect x="40" y="338" width="680" height="30" rx="4" fill="#0ea5e9" stroke="#0ea5e9" stroke-width="1.2" fill-opacity="0.2"/>
  <text x="54" y="358" font-size="11" font-weight="600" fill="currentColor">⑨ macOS managed preferences</text>
  <text x="320" y="358" font-size="10" fill="#64748b">MDM 下发 .mobileconfig，最高优先级</text>
  <path d="M380,380 L380,420" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r2ar1)"/>
  <rect x="240" y="422" width="280" height="30" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="442" text-anchor="middle" font-size="11" fill="currentColor">合并后的 Config.Info（缓存到 instance 结束）</text>
</svg>
<span class="figure-caption">图 R2.1 ｜ 9 层配置合并顺序：远程下发 / 全局 / env / 项目 / 子目录 / 远程账户 / 系统管理 / MDM 层层叠加，序号越大优先级越高，符合"项目优先于全局、管理员优先于个人"的直觉。</span>

<details>
<summary>ASCII 原版</summary>

```text
顺序（编号是 config.ts:552 之后的实际执行顺序）：
 ①  wellknown 远程配置 ── 来自 auth.json 里的 wellknown 凭证
 ②  global config       ── ~/.config/opencode/{opencode.json,opencode.jsonc,config.json}
 ③  OPENCODE_CONFIG     ── env var 指向单个文件
 ④  项目级 opencode.json ── 从 cwd 向上找，直到 worktree 根
 ⑤  ConfigPaths.directories 里所有 .opencode/ 目录的 opencode.json
 ⑥  OPENCODE_CONFIG_CONTENT ── 整个 JSON 直接放 env var 里
 ⑦  Account active org 远程 config ── opencode console 拉远端配置
 ⑧  ConfigManaged.managedConfigDir ── 系统管理员推送（/etc/opencode/）
 ⑨  macOS managed preferences ── MDM 下发的 .mobileconfig
```

</details>

> 序号越大优先级越高（后者 mergeDeep 覆盖前者）。这与"项目优先于全局"的直觉相符。

### 2.1.1 项目级查找：从 cwd 向上爬

```ts
// packages/opencode/src/config/config.ts:602-606
for (const file of yield* ConfigPaths.files("opencode", ctx.directory, ctx.worktree)) {
  yield* merge(file, yield* loadFile(file, authEnv), "local")
}
```

`ConfigPaths.files` 实现（`packages/opencode/src/config/paths.ts:10-21`）：

```ts
export const files = Effect.fn("ConfigPaths.projectFiles")(function* (name, directory, worktree?) {
  const afs = yield* AppFileSystem.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})
```

`afs.up({ targets, start, stop })` 从 `start` 目录向上扫，停在 git worktree 根（`stop`），收集所有命中的 `opencode.jsonc` / `opencode.json`。结果用 `.toReversed()`——这样靠近 worktree 根的最先合并，靠近 cwd 的最后合并，cwd 附近的覆盖较远的，符合"近优先"语义。

ConfigPaths.directories 则收集所有 `.opencode/` 子目录（`packages/opencode/src/config/paths.ts:23-41`），用于读 agents、commands、plugins 这些"按目录拆分"的配置。这两套机制配合，允许 monorepo 在根放一份 base opencode.json，在 `packages/x/.opencode/opencode.json` 放针对性 override。

### 2.1.2 数组字段的特殊合并

remeda 的 `mergeDeep` 对数组的默认行为是"后者整个替换前者"。`instructions` 字段语义上是"额外指令文件列表"，应该累加。于是有 `mergeConfigConcatArrays`（`packages/opencode/src/config/config.ts:55-61`）：

```ts
function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}
```

只对 `instructions` 一个字段特殊处理，其它数组（如 `disabled_providers / enabled_providers / plugin`）保持"替换"语义。这避免了"一旦在项目里设了 disabled_providers，就再也清不空全局的禁用列表"这种 footgun——项目级直接覆盖列表，意图明确。

### 2.1.3 wellknown 远程配置

这是 enterprise 场景的关键路径。当 `auth.json` 里某条凭证 `type: "wellknown"` 时，会 fetch `<url>/.well-known/opencode` 拿 JSON，再把它合并到 config（`packages/opencode/src/config/config.ts:552-592`）。典型用例：公司内部 LLM 代理，提供一个 well-known endpoint 把团队默认的 model、provider URL、permission 一次性下发，员工只要 `opencode auth login <internal-url>` 就拿到完整配置。

`auth.command` 字段（见 `packages/opencode/src/cli/cmd/providers.ts:322-348`）允许这个 well-known 指定一条 shell 命令——`opencode auth login <url>` 会跑这条命令、把 stdout 当作 token 存进 `auth.json`，于是 token 刷新可以委托给企业自有工具链。

## 2.2 Config Schema：Effect Schema 描述的 Info

opencode 用 `effect/Schema`（不是 zod）描述所有 config 字段。顶层结构在 `packages/opencode/src/config/config.ts:134-306` 的 `export const Info = Schema.Struct({ ... })`。摘录骨架：

```ts
export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String),         // 用于 IDE 完成
  shell: Schema.optional(Schema.String),
  logLevel: Schema.optional(LogLevelRef),
  server: Schema.optional(ConfigServer.Server),
  command: Schema.optional(Schema.Record(Schema.String, ConfigCommand.Info)),
  skills: Schema.optional(ConfigSkills.Info),
  reference: Schema.optional(ConfigReference.Info),
  plugin: Schema.optional(Schema.mutable(Schema.Array(ConfigPlugin.Spec))),
  share: Schema.optional(Schema.Literals(["manual", "auto", "disabled"])),
  autoupdate: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("notify")])),
  disabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  enabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  model: Schema.optional(ConfigModelID),           // "anthropic/claude-sonnet-4-5"
  small_model: Schema.optional(ConfigModelID),
  default_agent: Schema.optional(Schema.String),
  agent: Schema.optional(...ConfigAgent.Info...),  // build / plan / general / explore / ...
  provider: Schema.optional(Schema.Record(Schema.String, ConfigProvider.Info)),
  mcp: Schema.optional(Schema.Record(Schema.String, ...)),
  formatter: Schema.optional(ConfigFormatter.Info),
  lsp: Schema.optional(ConfigLSP.Info),
  instructions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  permission: Schema.optional(ConfigPermission.Info),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  compaction: Schema.optional(...),
  experimental: Schema.optional(...),
})
```

每个字段都 `.annotate({ description: "..." })`。这些描述在两个地方派上用场：

1. 通过 `Server.openapi()`（`packages/opencode/src/cli/cmd/generate.ts:10`）生成 OpenAPI schema。
2. `https://opencode.ai/config.json` 的 JSON schema URL——`opencode.json` 顶部应该有 `"$schema": "https://opencode.ai/config.json"`，IDE 据此提供字段补全和 hover 文档。

如果用户写的 opencode.json 没有 `$schema`，loadConfig 会自动加上并回写文件（`packages/opencode/src/config/config.ts:428-432`）。这是用 jsonc-parser 的 `modify` 直接补一行 `"$schema": "..."`，保留原文件的注释和格式。

### 2.2.1 JSONC 与变量替换

opencode 配置文件可以是 `.json` 也可以是 `.jsonc`（JSON with comments）。`ConfigParse.jsonc(text, source)` 处理两种形式。

更有意思的是变量替换。`ConfigVariable.substitute` 在解析前先扫一遍文本，把 `${env:FOO}`、`${file:./path}`、`${command:bash -c "..."}` 之类的占位符展开（`packages/opencode/src/config/variable.ts`）。这让你能写：

```jsonc
{
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "${env:MY_TEAM_ANTHROPIC_KEY}",
        "baseURL": "${env:LLM_PROXY_URL}"
      }
    }
  }
}
```

让 config 文件本身不再"硬编码秘密"——secret 仍然走 env var / 1Password CLI / vault 等。`authEnv` 在 wellknown 流程里会把 wellknown token 注入到这个替换的 env 里（`packages/opencode/src/config/config.ts:555, 587`），从而让远端 well-known 模板能引用 `${env:OPENCODE_WELLKNOWN_TOKEN}` 之类的注入变量。

### 2.2.2 已弃用字段与自动迁移

Schema 里有几处带 `@deprecated` 注释：

- `autoshare` → `share`（自动迁移：`packages/opencode/src/config/config.ts:767-769`）
- `mode` → `agent`（`config.ts:735-742`，所有 `mode.X` 在加载后被 hoisted 到 `agent.X` 并打上 `mode: "primary"`）
- `tools: { name: boolean }` → `permission`（`config.ts:752-763`，bool 转成 `"allow" / "deny"`）
- `maxSteps` → `steps`（在 ConfigAgent 层做 normalize：`packages/opencode/src/config/agent.ts:94-95`）

迁移在 `loadInstanceState` 的末尾统一做，不写回文件——schema 仍然接受旧字段，运行时已是新字段。这是一个比较克制的策略：不强行重写用户的 opencode.json，但 type system 和后续代码只看新字段。

### 2.2.3 子 schema 一览

```text
ConfigAgent     packages/opencode/src/config/agent.ts:21-50
                model, variant, prompt, tools, permission, mode, hidden, color, steps...
ConfigPermission packages/opencode/src/config/permission.ts:1-58
                每个工具一个 Action: "ask" | "allow" | "deny"
                shorthand 单 Action 等价 { "*": action }
ConfigProvider  packages/opencode/src/config/provider.ts:71-108
                api, name, env, npm, models, options.{apiKey, baseURL, timeout, chunkTimeout}
ConfigMCP       packages/opencode/src/config/mcp.ts:1-58
                local (command) / remote (url, oauth)
ConfigLSP       packages/opencode/src/config/lsp.ts
ConfigFormatter packages/opencode/src/config/formatter.ts
ConfigCommand   packages/opencode/src/config/command.ts (slash command 定义)
ConfigSkills    packages/opencode/src/config/skills.ts (Skill 文件夹路径)
ConfigPlugin    packages/opencode/src/config/plugin.ts (插件 spec)
ConfigReference packages/opencode/src/config/reference.ts (@alias 别名)
```

每个子文件都用 `Schema.StructWithRest(struct, [restRecord])` 模式：已知字段类型化，未知字段保留到 record。这给两端都留余地——schema 演化时旧字段会被静默丢弃，新字段在 IDE 里有提示；同时插件可以自定义未列出的 option。

## 2.3 鉴权三态：Api / Oauth / WellKnown

`packages/opencode/src/auth/index.ts:13-35` 把所有"已存储的凭证"抽象成一个 union：

```ts
export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({
  discriminator: "type", identifier: "Auth",
})
```

存储格式是 `~/.local/share/opencode/auth.json`，一个 `Record<providerID, Info>`。读写经过 `Auth.Service`（`packages/opencode/src/auth/index.ts:42-90`）。注意 `set` 用 `0o600` 权限（仅 owner 读写）写文件——`auth.json` 里包含真实凭证。

```text
~/.local/share/opencode/auth.json (0o600)
┌──────────────────────────────────────────┐
│ {                                        │
│   "anthropic":      { type: "oauth", ... },
│   "openai":         { type: "api", key },
│   "github-copilot": { type: "oauth", refresh, access, expires },
│   "https://team.internal/llm": {         │
│     type: "wellknown", key: "TEAM_TOKEN",│
│     token: "tk_abc..."                   │
│   }                                      │
│ }                                        │
└──────────────────────────────────────────┘
```

union 上还有 `OPENCODE_AUTH_CONTENT` 旁路（`packages/opencode/src/auth/index.ts:57-61`）：env var 里直接放整个 auth.json 的 JSON 文本。CI 场景下不想把 token 写到磁盘，直接 export 这个变量即可——配合 secret manager 用很顺手。

## 2.4 Provider 选择优先级

`Provider.Service` 启动时构建一张 `providers: Record<ProviderID, Info>` 表（`packages/opencode/src/provider/provider.ts:1201-1500`）。逻辑分阶段，每个阶段都用 `mergeProvider(id, partial)` 把数据塞进表里，覆盖前一阶段的字段。优先级从低到高：

<svg viewBox="0 0 760 470" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Provider selection pipeline with eight layers low to high priority">
  <defs>
    <marker id="r2ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Provider 选择 8 阶段（mergeProvider 逐层覆盖）</text>
  <rect x="40" y="38" width="680" height="32" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="54" y="58" font-size="11" font-weight="600" fill="currentColor">① models.dev catalog</text>
  <text x="240" y="58" font-size="10" fill="#64748b">内置元数据：npm 包、env 列表、model 定义</text>
  <rect x="40" y="74" width="680" height="32" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="54" y="94" font-size="11" font-weight="600" fill="currentColor">② plugin.provider hook</text>
  <text x="240" y="94" font-size="10" fill="#64748b">插件重写 models 列表</text>
  <rect x="40" y="110" width="680" height="32" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="54" y="130" font-size="11" font-weight="600" fill="currentColor">③ config.provider</text>
  <text x="240" y="130" font-size="10" fill="#64748b">opencode.json 自定义 provider 字段</text>
  <rect x="40" y="146" width="680" height="32" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="54" y="166" font-size="11" font-weight="600" fill="currentColor">④ env var</text>
  <text x="240" y="166" font-size="10" fill="#64748b">ANTHROPIC_API_KEY / OPENAI_API_KEY ... 命中即启用</text>
  <rect x="40" y="182" width="680" height="32" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="54" y="202" font-size="11" font-weight="600" fill="currentColor">⑤ auth.json (type=api)</text>
  <text x="240" y="202" font-size="10" fill="#64748b">opencode auth login 存的 apiKey 凭证</text>
  <rect x="40" y="218" width="680" height="32" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="54" y="238" font-size="11" font-weight="600" fill="currentColor">⑥ plugin.auth.loader</text>
  <text x="240" y="238" font-size="10" fill="#64748b">插件 hook，可改 options（注入 Bearer 等）</text>
  <rect x="40" y="254" width="680" height="32" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="54" y="274" font-size="11" font-weight="600" fill="currentColor">⑦ custom(dep) 内置回调</text>
  <text x="240" y="274" font-size="10" fill="#64748b">anthropic / openai / bedrock 等 hardcoded headers</text>
  <rect x="40" y="290" width="680" height="32" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="54" y="310" font-size="11" font-weight="600" fill="currentColor">⑧ config.provider 再次覆盖</text>
  <text x="240" y="310" font-size="10" fill="#64748b">让 config 字段（name / env / options）成为最终权威</text>
  <path d="M380,332 L380,360" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r2ar2)"/>
  <rect x="160" y="362" width="440" height="44" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="382" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">providers[id] = { models, options, key, source, ... }</text>
  <text x="380" y="398" text-anchor="middle" font-size="10" fill="#64748b">再走 disabled/enabled 过滤，得到最终启用集合</text>
  <text x="40" y="430" font-size="10.5" fill="#64748b">读取 / 默认 / 协议</text>
  <text x="380" y="430" text-anchor="middle" font-size="10.5" fill="#64748b">凭证来源</text>
  <text x="720" y="430" text-anchor="end" font-size="10.5" fill="#64748b">用户最终拍板</text>
  <line x1="40" y1="440" x2="720" y2="440" stroke="#cbd5e1" stroke-dasharray="4,3"/>
  <text x="380" y="458" text-anchor="middle" font-size="10" fill="#94a3b8">先填默认，再让 config 拍板：⑧ 是为了把 ④~⑦ 覆盖的字段拉回用户意图</text>
</svg>
<span class="figure-caption">图 R2.2 ｜ Provider 选择 8 阶段流水线：从 models.dev 元数据开始，经 env / auth.json / plugin / custom 注入凭证与 headers，最后用 config.provider 再覆盖一次，确保用户配置永远是最终权威。</span>

<details>
<summary>ASCII 原版</summary>

```text
①  models.dev catalog          ── 内置元数据：每个 provider 的默认 npm 包、env 列表、model 定义
②  plugin.provider hook        ── 插件可以为 provider 重写 models 列表
③  config.provider             ── 用户在 opencode.json 里配的自定义 provider 字段
④  env var                     ── 环境变量里有 provider.env 列出的 key 之一就启用（source: "env"）
⑤  auth.json (type=api)        ── apiKey 凭证（source: "api"）
⑥  plugin.auth.loader          ── 插件加载器，能改 options（OAuth token 注入到 fetch header 等）
⑦  custom(dep) 内置回调        ── anthropic / openai / azure / amazon-bedrock 等的 hardcoded 钩子
⑧  config.provider 再覆盖一遍  ── 让 config 字段（如 name / env / options）成为最终权威
```

</details>

为什么 ⑧ 要再来一次？因为 ④⑤⑥⑦ 可能把 options 改回了 default，比如 ⑦ 里 anthropic 默认会塞 `anthropic-beta: interleaved-thinking-...` header。但如果用户在 config 里手工设了 `provider.anthropic.options.headers`，那应该被尊重。这种"先填默认，再让 config 最终拍板"的模式很常见。

### 2.4.1 默认 model 选择

`defaultModel`（`packages/opencode/src/provider/provider.ts:1814-1846`）在用户没显式 `--model` 时选哪个：

```ts
const defaultModel = Effect.fn("Provider.defaultModel")(function* () {
  const cfg = yield* config.get()
  if (cfg.model) return parseModel(cfg.model)              // ① opencode.json model 字段

  const recent = yield* fs.readJson(path.join(Global.Path.state, "model.json"))
  for (const entry of recent) {                            // ② 最近用过的（state/model.json）
    const provider = s.providers[entry.providerID]
    if (!provider) continue
    if (!provider.models[entry.modelID]) continue
    return { providerID: entry.providerID, modelID: entry.modelID }
  }

  const provider = Object.values(s.providers).find(...)    // ③ providers 字典里第一个可用
  if (!provider) return yield* new NoProvidersError()
  const [model] = sort(Object.values(provider.models))     // ④ 该 provider 里"最好的" model
  return { providerID: provider.id, modelID: model.id }
})
```

`sort` 用一个硬编码 priority 数组 `["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]`（`packages/opencode/src/provider/provider.ts:1864-1872`），把名字里含这些子串的排前面。冷启动+无 config+无历史时，opencode 试图给一个"合理的"默认 model 而不是死掉。

### 2.4.2 API key 解析顺序（单 provider 内）

对某个具体 provider（如 anthropic），调用时怎么决定用哪个 apiKey？看 `packages/opencode/src/provider/provider.ts:1380-1404`、`1585`：

```text
1. provider.options.apiKey          ── 用户在 opencode.json 显式写死
2. auth.json[providerID].key        ── opencode auth login 存进去的（source: "api"）
3. env[provider.env[0]]             ── 第一个匹配的环境变量（ANTHROPIC_API_KEY、OPENAI_API_KEY ...）
                                       provider.env 列表来自 models.dev catalog
4. （没有则）provider 不会被 autoload
```

对于 OAuth 类型（`auth.json[id]` 是 `{ type: "oauth", access, refresh, ... }`），不走上面这条路——plugin 的 `auth.loader` 会在 fetch hook 里把 `Authorization: Bearer <access>` 注入到 header（见 `packages/opencode/src/plugin/github-copilot/copilot.ts:155-169`）。expire 临近时由 plugin 自行刷新。

### 2.4.3 disabled_providers 与 enabled_providers

```jsonc
{
  "disabled_providers": ["amazon-bedrock", "google-vertex"],
  "enabled_providers": ["anthropic", "openai", "github-copilot"]
}
```

`isProviderAllowed`（`packages/opencode/src/provider/provider.ts:1252-1256`）：

```ts
function isProviderAllowed(providerID: ProviderID): boolean {
  if (enabled && !enabled.has(providerID)) return false
  if (disabled.has(providerID)) return false
  return true
}
```

只设 `disabled_providers` → 黑名单，其余全可用。
只设 `enabled_providers` → 白名单，列表外全部禁用。
两个都设 → 白名单基础上再去掉黑名单。

为什么需要 enabled_providers？默认 models.dev catalog 里有几十个 provider，TUI 的模型选择菜单会非常长。enterprise 用户可能只想让员工看到内部允许的几个 provider。这种"白名单优先"模式比挨个 disable 干净。

## 2.5 `opencode auth` 子命令的完整流程

`packages/opencode/src/cli/cmd/providers.ts:238-515` 实现了 `auth login / list / logout` 三个子命令（auth 是 providers 的 alias）。

### 2.5.1 list

`ProvidersListCommand`（`packages/opencode/src/cli/cmd/providers.ts:247-296`）做两件事：

1. 列 `auth.json` 里存的凭证及类型。
2. 扫一遍 models.dev catalog，对每个 provider 检查 `provider.env` 里的环境变量当前是否被设了，列出"环境变量来的 credential"。

第二步重要——因为很多用户会把 `ANTHROPIC_API_KEY` 设到 `~/.zshrc`，并不会显式 `opencode auth login`。让 `auth list` 能展示这部分，避免"为什么我设了 env 但 opencode 看不到"的困惑。

### 2.5.2 login 的两种路径

```text
opencode auth login <url>          ── wellknown 路径
opencode auth login                ── 交互式 provider 选择
opencode auth login -p anthropic   ── 跳过选择，直接 anthropic
```

**wellknown 路径**（`packages/opencode/src/cli/cmd/providers.ts:322-348`）：

```text
1. fetch <url>/.well-known/opencode           → { auth: { command, env } }
2. 提示 "Running `cmd...`"
3. spawn(command), 把 stdout 读进来作为 token
4. authSvc.set(url, { type: "wellknown", key, token: token.trim() })
```

**交互式路径**（`packages/opencode/src/cli/cmd/providers.ts:350-485`）：

1. 拉 models.dev catalog（`modelsDev.refresh(true)` 强制刷新）。
2. 过滤掉 disabled / not-in-enabled-list 的。
3. 加入 plugin 暴露的 provider（每个 plugin 可以声明 `hook.auth = { provider, methods }`）。
4. 用一个硬编码 priority 排序：opencode（自家）→ openai → github-copilot → google → anthropic → openrouter → vercel → 其它字母序（`packages/opencode/src/cli/cmd/providers.ts:368-377`）。
5. 弹 autocomplete 菜单让用户选；选 "Other" 时允许手输任意 provider id。

**选中的 provider 有 plugin 钩子？走 plugin.auth.methods**：

`handlePluginAuth`（`packages/opencode/src/cli/cmd/providers.ts:38-209`）。每个 plugin auth 暴露一组 `methods: [{ type: "oauth" | "api", label, prompts, authorize(), callback() }]`。流程：

```text
1. 若有多个 method，让用户挑（label 列表）
2. 对每个 prompt 弹 select/text 输入框（key/value 写到 inputs map）
3. method.authorize(inputs) → 返回 { url, method: "auto" | "code", callback() }
4. 如果 method=auto：
     a. 启动 oauth callback server (plugin 自己起，见 codex.ts:259-333)
     b. 显示 "Go to: <url>"，open url in browser
     c. callback() 阻塞等待 redirect_uri 命中
5. 如果 method=code：
     a. 用户在浏览器拿到 code 粘贴回来
     b. callback(code) 用 code 换 token
6. result.type === "success" 时，写到 auth.json（type: "oauth" 或 "api"）
```

**没有 plugin？走通用 api key 流**（`packages/opencode/src/cli/cmd/providers.ts:477-484`）：

```ts
const key = yield* Prompt.password({ message: "Enter your API key", validate: ... })
const apiKey = yield* promptValue(key)
yield* Effect.orDie(authSvc.set(provider, { type: "api", key: apiKey }))
```

### 2.5.3 OAuth callback server 的具体实现

以 codex（ChatGPT OAuth）为例（`packages/opencode/src/plugin/codex.ts:259-333`），核心代码：

```ts
async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) return { ... }                           // 单例

  oauthServer = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${OAUTH_PORT}`)

    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      // CSRF 检查：state 必须与发起时存的一致
      if (!pendingOAuth || state !== pendingOAuth.state) {
        res.end(HTML_ERROR("Invalid state - potential CSRF attack"))
        return
      }
      exchangeCodeForTokens(code, ..., pendingOAuth.pkce)
        .then(pendingOAuth.resolve)
      res.end(HTML_SUCCESS)
    }
  })
  oauthServer.listen(OAUTH_PORT)
  return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}
```

`waitForOAuthCallback`（`packages/opencode/src/plugin/codex.ts:344+`）返回一个 5 分钟超时的 Promise，store pkce + state + resolve/reject。流程是 "callback server 起来 → 浏览器跳转 → resolve Promise"。

为什么 plugin 自己起 server 而不是复用主 server？两个原因：
1. 端口冲突：每个 plugin 各自的 OAuth redirect_uri 已经在 provider 后台注册死了（如 codex 注册了 `http://localhost:1455/auth/callback`，github-copilot 用 device code 不需要 callback），不能强制走同一个端口。
2. Provider 隔离：codex 的 callback server 写代码是浏览器风格 HTML 成功/失败页，github copilot 用 device flow 根本不需要 server——抽象层级让 plugin 自定义这一切最干净。

### 2.5.4 logout

`ProvidersLogoutCommand`（`packages/opencode/src/cli/cmd/providers.ts:488-515`）：列出 auth.json 已有项，让用户选一项调 `authSvc.remove(key)`。**不**主动 revoke token——OAuth refresh token 仍然在 provider 那边有效，opencode 只是删除本地引用。如果用户想完全 revoke，需要去 provider 的 web 控制台。

## 2.6 Provider transform 与 variants

不同 LLM provider 的 API 参数体系差异巨大。Claude 用 `system`、OpenAI Responses 用 `instructions`、Gemini 用 `systemInstruction`；Anthropic 的 thinking 需要 `thinking: { type: "enabled", budget }`，OpenAI 的 reasoning effort 是 `reasoning: { effort: "high" }`；Bedrock 在不同区域要加 `us.` / `eu.` 前缀；Azure 用 deployment id 不是 model id……

opencode 的策略是把这一切收敛到两个地方：

1. **`packages/llm/src/protocols/*`**：每个"协议"（不是 provider，是一组共享的 wire 格式）一个文件。`anthropic-messages.ts`、`openai-chat.ts`、`openai-responses.ts`、`gemini.ts`、`bedrock-converse.ts` 等。这些是真正发出去的 JSON 结构。
2. **`packages/opencode/src/provider/transform.ts`**：把内部统一的 `MessageV2` 和 tool definition 转换成各协议需要的格式；把 model variants 展开成 provider-specific options。

`transform.ts:24-44` 的 `sdkKey(npm)` 把 npm 包名映射到 AI SDK 的 `providerOptions.<key>`：

```ts
function sdkKey(npm: string): string | undefined {
  switch (npm) {
    case "@ai-sdk/github-copilot": return "copilot"
    case "@ai-sdk/azure":          return "azure"
    case "@ai-sdk/openai":         return "openai"
    case "@ai-sdk/amazon-bedrock": return "bedrock"
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google-vertex/anthropic": return "anthropic"
    case "@ai-sdk/google-vertex":  return "vertex"
    case "@ai-sdk/google":         ...
  }
}
```

这是 AI SDK 把"通用 stream 调用"和"provider 私有 options"通过 `providerOptions: { anthropic: {...}, openai: {...} }` 字段分流，opencode 在这里把内部模型选项分发到正确的子键下。

### 2.6.1 为什么不能直接用 Vercel AI SDK 默认值

Vercel AI SDK 是 LLM 抽象层，但它的"默认值"经常不符合 agent loop 需求：

- AI SDK 默认不开 Anthropic 的 prompt caching；opencode 全程要开。
- AI SDK 默认不传 `anthropic-beta` headers；opencode 需要 `interleaved-thinking-2025-05-14`、`fine-grained-tool-streaming-2025-05-14`（见 `packages/opencode/src/provider/provider.ts:159-167` 的 anthropic custom 钩子）。
- AI SDK 对 OpenAI 默认走 chat completions endpoint，但 opencode 想走 responses API（`packages/opencode/src/provider/provider.ts:191-196`）。
- AI SDK 对 GitHub Copilot 没有直接支持，必须用一个 OpenAI-compatible adapter（`packages/opencode/src/provider/provider.ts:207-215`）。

这些都在 `provider.ts:custom(dep)` 工厂函数里（`packages/opencode/src/provider/provider.ts:157-820`）。每个 provider 一个 entry，返回 `{ autoload, getModel, vars, options, discoverModels }`。`getModel(sdk, modelID, options)` 是核心——它决定 `sdk.responses(modelID)` 还是 `sdk.chat(modelID)` 还是 `sdk.languageModel(modelID)`，给 AI SDK 选对路径。

### 2.6.2 Model variants

很多 model 有"调强度"维度：reasoning effort（minimal/low/medium/high）、temperature 预设、context size override。opencode 在 Model schema 里用 `variants` 字段表达（`packages/opencode/src/config/provider.ts:58-68`）：

```ts
variants: Schema.optional(
  Schema.Record(
    Schema.String,                  // variant 名（"high" / "minimal" / "max" / "concise"）
    Schema.StructWithRest(
      Schema.Struct({ disabled: Schema.optional(Schema.Boolean) }),
      [Schema.Record(Schema.String, Schema.Any)],  // 任意 provider-specific 字段
    ),
  ),
),
```

用户用 `--variant high` 或 TUI 的 variant 切换器，把 variant record 整个 mergeDeep 到 model.options 上。`ProviderTransform.variants(parsedModel)`（`packages/opencode/src/provider/provider.ts:1369`）从 base model 推断出默认 variants（比如 gpt-5 自动有 minimal/low/medium/high），user config 里写的 variants 再合并/覆盖。

`disabled: true` 让某个 variant 在 UI 里不可见（`provider.ts:1370-1373`）。

## 2.7 MCP / Plugin / Skills 在配置里的位置

opencode 的扩展点都通过 opencode.json 配置：

### 2.7.1 MCP server

```jsonc
{
  "mcp": {
    "fs-tools": {
      "type": "local",
      "command": ["bun", "run", "./mcp-server.ts"],
      "environment": { "ROOT": "/data" },
      "timeout": 10000,
      "enabled": true
    },
    "linear": {
      "type": "remote",
      "url": "https://mcp.linear.app/v1",
      "headers": { "Authorization": "Bearer ..." },
      "oauth": {
        "clientId": "...",
        "scope": "read:issues",
        "callbackPort": 19876
      }
    }
  }
}
```

schema 见 `packages/opencode/src/config/mcp.ts:1-58`。`Local` 表示 spawn 子进程跑 MCP server（走 stdio JSON-RPC），`Remote` 走 HTTP（+ 可选 OAuth）。两者都 lazy 启动：实际只有 agent 在某次 prompt 里调到该 server 暴露的 tool 时才发 connect。`enabled: false` 可以临时关闭某个 server 而不删配置。

### 2.7.2 Plugin spec

```jsonc
{
  "plugin": [
    "opencode-plugin-myteam@latest",        // npm 包
    "./plugin/local-hook.ts",                // 本地文件
    { "module": "opencode-plugin-x", "version": "1.2.3", "options": { "k": "v" } }
  ]
}
```

schema 见 `packages/opencode/src/config/plugin.ts`。后处理在 `resolveLoadedPlugins`（`packages/opencode/src/config/config.ts:117-125`）：把所有相对路径 normalize 成 "相对于声明它的 config 文件"——这样把 plugin 写在项目 opencode.json 里，路径是相对于项目根，全局 opencode.json 里则相对于 `~/.config/opencode`。

### 2.7.3 Skills

```jsonc
{
  "skills": {
    "paths": ["./skills", "/usr/share/opencode-skills"],
    "urls": ["https://example.com/.well-known/skills/"]
  }
}
```

schema 见 `packages/opencode/src/config/skills.ts:1-12`。Skill 是 opencode 的"prompt + 元数据"包，用于 RAG-style 任务，在 agent 启动时按名字注入。这一节只是约定路径列表，加载逻辑在另一处。

## 2.8 配置热加载与运行时变更

opencode 的配置不是完全静态的——但热加载支持有限。看 `Config.Service` 的接口（`packages/opencode/src/config/config.ts:324-333`）：

```ts
export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly update: (config: Info) => Effect.Effect<void>            // 写项目级
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}
```

`get()` 返回当前 instance 的合并结果，缓存在 `InstanceState` 里（`config.ts:792-796`）；`getGlobal()` 是 `cachedInvalidateWithTTL` 的 thunk（`config.ts:478-486`），但 TTL 是 `Duration.infinity`——一旦读过就缓存到进程结束。

热加载点：

1. **`Config.updateGlobal(patch)`** （`config.ts:829-852`）：写 `~/.config/opencode/{opencode,config}.json`，写完调 `invalidate()` 清缓存。下次 `getGlobal()` 会重新读盘。但 **`get()` 仍然返回缓存的 instance 合并结果**——instance 级配置一启动就定型。
2. **`opencode auth login` 之后**：往 `auth.json` 写了新凭证，但当前进程的 Provider.Service 已经构建好了 providers 表。要让新 provider 生效，**需要重新进 instance**——TUI 里通常通过命令 palette 触发 reload，run/serve 命令本身是短命周期，重启即可。
3. **TUI 内的 model / agent / variant 切换**：这些是 _session_ 级，不是 config 级。切换不写 opencode.json，只更新 `state/model.json` 这种 runtime state（参见 1.4.1 提到的 KVProvider）。

为什么不全自动热加载？因为 Config 关联了大量 derived state：plugin 实例、provider 缓存、MCP 长连接、LSP 子进程……一旦 config 变了，理论上要全部 invalidate + rebuild，复杂度爆炸。opencode 的策略是：**把热加载范围限定到"用户主动写文件 / 自己点 reload"**，避免 file watch 引入的不确定性。

config 文件的 file watch 确实存在（在 chokidar 上，见 `packages/opencode/src/cli/cmd/tui/...` 里的 watcher 代码），但只用于 TUI 的"主动提示用户：配置已变更，按 R 重新加载" UX，不做自动 swap。

## 2.9 一张图把整个鉴权链路串起来

<svg viewBox="0 0 820 600" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="End to end auth chain from CLI flag to LanguageModelV3 instance">
  <defs>
    <marker id="r2ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="180" y="16" width="460" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="34" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">opencode run --model anthropic/claude-sonnet-4-5</text>
  <text x="410" y="50" text-anchor="middle" font-size="10" fill="#64748b">CLI 入口</text>
  <path d="M410,56 L410,76" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r2ar3)"/>
  <rect x="250" y="78" width="320" height="32" rx="5" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="410" y="98" text-anchor="middle" font-size="11" fill="currentColor">Provider.Service.list()</text>
  <path d="M410,110 L410,128" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="80" y1="128" x2="740" y2="128" stroke="#94a3b8" stroke-width="1.2"/>
  <path d="M170,128 L170,148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r2ar3)"/>
  <path d="M650,128 L650,148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r2ar3)"/>
  <rect x="60" y="150" width="220" height="48" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="170" y="172" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">models.dev catalog</text>
  <text x="170" y="188" text-anchor="middle" font-size="9.5" fill="#64748b">Global.Path.cache/models.json</text>
  <rect x="540" y="150" width="220" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="650" y="172" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">cfg.provider</text>
  <text x="650" y="188" text-anchor="middle" font-size="9.5" fill="#64748b">opencode.json</text>
  <path d="M170,198 L170,222" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r2ar3)"/>
  <text x="180" y="216" font-size="9.5" fill="#94a3b8">plugin.provider.models() 重写</text>
  <rect x="60" y="224" width="220" height="32" rx="5" fill="#fff" stroke="#cbd5e1"/>
  <text x="170" y="244" text-anchor="middle" font-size="11" fill="currentColor">database 表</text>
  <path d="M170,256 L170,278" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r2ar3)"/>
  <text x="180" y="272" font-size="9.5" fill="#94a3b8">disabled / enabled 过滤</text>
  <rect x="60" y="280" width="700" height="180" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="410" y="300" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">循环 mergeProvider（按优先级覆盖）</text>
  <rect x="80" y="310" width="660" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="100" y="325" font-size="10" fill="currentColor">① env var (ANTHROPIC_API_KEY)</text>
  <text x="430" y="325" font-size="10" fill="#64748b">→ providers[anthropic].key</text>
  <rect x="80" y="336" width="660" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="100" y="351" font-size="10" fill="currentColor">② auth.json (type=api)</text>
  <text x="430" y="351" font-size="10" fill="#64748b">→ providers[anthropic].key</text>
  <rect x="80" y="362" width="660" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="100" y="377" font-size="10" fill="currentColor">③ plugin.auth.loader</text>
  <text x="430" y="377" font-size="10" fill="#64748b">→ options.fetch = injectBearer</text>
  <rect x="80" y="388" width="660" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="100" y="403" font-size="10" fill="currentColor">④ custom(dep).anthropic</text>
  <text x="430" y="403" font-size="10" fill="#64748b">→ headers["anthropic-beta"] = ...</text>
  <rect x="80" y="414" width="660" height="22" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="100" y="429" font-size="10" fill="currentColor">⑤ cfg.provider.anthropic（最终权威）</text>
  <text x="430" y="429" font-size="10" fill="#64748b">→ 覆盖以上任何字段</text>
  <text x="410" y="452" text-anchor="middle" font-size="10" fill="#94a3b8">env / auth.json / plugin / custom / config 五段轮流写</text>
  <path d="M410,460 L410,484" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r2ar3)"/>
  <rect x="100" y="486" width="620" height="34" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="410" y="508" text-anchor="middle" font-size="11" fill="currentColor">providers[anthropic] = { id, models, options, key, source, ... }</text>
  <path d="M410,520 L410,540" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r2ar3)"/>
  <rect x="160" y="542" width="500" height="46" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="562" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">getLanguage(model) → bundledLoader(npm)(options)</text>
  <text x="410" y="578" text-anchor="middle" font-size="10" fill="#64748b">LanguageModelV3 实例，被 Session.prompt 调用</text>
</svg>
<span class="figure-caption">图 R2.3 ｜ 一次 LLM 请求的完整鉴权链路：从 CLI 入口出发，经 models.dev 元数据 + opencode.json 双源构建 provider 表，再用 env / auth.json / plugin / custom / config 五段覆盖，最终拿到 AI SDK 的 LanguageModelV3 实例。</span>

<details>
<summary>ASCII 原版</summary>

```text
                    用户调用 opencode run --model anthropic/claude-sonnet-4-5
                                          │
                                          ▼
                              Provider.Service.list()
                                          │
        ┌────────────── State 构建 (provider.ts:1201+) ───────────────┐
        │                                                              │
        ▼                                                              ▼
   models.dev catalog                                              cfg.provider
   (Global.Path.cache/models.json)                            (opencode.json)
        │                                                              │
        ├── plugin.provider.models() 重写 models 列表 ──────────────────┤
        │                                                              │
        ▼                                                              ▼
    database 表                                                  configProviders
        │                                                              │
        ▼                                                              │
   按 disabled/enabled 过滤                                              │
        │                                                              │
        ▼                                                              │
   循环 mergeProvider:                                                  │
     ① env var (ANTHROPIC_API_KEY) ──────────────► providers[anthropic].key
     ② auth.json (type=api)        ──────────────► providers[anthropic].key
     ③ plugin.auth.loader          ──────────────► providers[anthropic].options.fetch = injectBearer
     ④ custom(dep).anthropic       ──────────────► providers[anthropic].options.headers["anthropic-beta"]=...
     ⑤ cfg.provider.anthropic      ──────────────► override 上面任何字段
        │                                                              │
        └──────────────────────────────┬───────────────────────────────┘
                                       ▼
                          providers[anthropic] = { id, models, options, key, source, ... }
                                       │
                                       ▼
                          getLanguage(model) → bundledLoader("@ai-sdk/anthropic")(options)
                                       │
                                       ▼
                          LanguageModelV3 实例，被 Session.prompt 调用
```

</details>

这张图覆盖了从 env var、auth.json、opencode.json、plugin hook、custom callback 到最终发出 HTTP 请求的全过程。下一章会从 Session 开始往里走——Provider 拿到 LanguageModelV3 后，Agent 怎么用它跑 loop。
