# 第 03 章：配置系统

> 代码版本锁定：`openclaw/openclaw@50a2481652`（tag `v2026.5.18`，2026-05-18）。本章所有 `file:line` 引用均以仓库根为相对起点。

## 0. 这一章要解决的问题

OpenClaw 是一个长期驻留的网关进程（Gateway），它要同时接管二十余种消息渠道、十几种模型 provider、若干 Agent 绑定。这些东西的开关、密钥、限额、路由策略全部来自配置。配置系统因此面对一组互相冲突的需求：

1. **可读可写**：运营者用 `openclaw config set ...` 改配置，UI 也能改，但写回磁盘时不能把运行时补出来的默认值污染进文件。
2. **多来源**：同一个值可能来自 `openclaw.json`、来自 `${ENV}` 占位符、来自进程环境变量、来自 CLI flag、来自 session 级临时覆盖。必须有确定的优先级。
3. **热重载**：改了配置文件不应该强制重启网关，但有些改动（比如换监听端口）又确实必须重启。系统要能区分。
4. **抗损坏**：配置文件被半截写坏、被外部工具截断、被未来版本的二进制写过，进程不能直接崩。
5. **演进**：旧版本写的配置 key 会被废弃（retired），新版本读到要么迁移要么忽略，而不是报错。

本章从类型定义出发，逐层讲清楚 OpenClaw 怎么用一组分工明确的模块满足上述全部需求。

<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="配置系统六层分工全景">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="10" y="10" width="740" height="260" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="34" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">配置系统全景</text>
  <rect x="30" y="48" width="700" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="120" y="59" font-size="11" font-weight="600" fill="#ea580c">类型层</text>
  <text x="120" y="73" font-size="10" fill="#64748b">types.openclaw.ts  +  types.*.ts（按段拆分）</text>
  <rect x="30" y="88" width="700" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="120" y="99" font-size="11" font-weight="600" fill="#7c3aed">校验层</text>
  <text x="120" y="113" font-size="10" fill="#64748b">zod-schema.*.ts  →  schema.ts  →  validation.ts</text>
  <rect x="30" y="128" width="700" height="32" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="120" y="139" font-size="11" font-weight="600" fill="#0d9488">IO 层</text>
  <text x="120" y="153" font-size="10" fill="#64748b">io.ts（读 / 写 / 快照 / 恢复）  +  runtime-snapshot.ts</text>
  <rect x="30" y="168" width="700" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="120" y="179" font-size="11" font-weight="600" fill="#ea580c">覆盖层</text>
  <text x="120" y="193" font-size="10" fill="#64748b">runtime-overrides.ts（CLI / UI 运行时补丁）</text>
  <rect x="30" y="208" width="700" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="120" y="219" font-size="11" font-weight="600" fill="#7c3aed">重载层</text>
  <text x="120" y="233" font-size="10" fill="#64748b">gateway/config-reload.ts（chokidar 文件监听）</text>
  <rect x="30" y="248" width="700" height="16" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="120" y="259" font-size="10" fill="#64748b">元数据层  schema.help.ts / doc-baseline.ts / metadata</text>
  <text x="55" y="64" font-size="10" fill="#ea580c" font-weight="700">①</text>
  <text x="55" y="104" font-size="10" fill="#7c3aed" font-weight="700">②</text>
  <text x="55" y="144" font-size="10" fill="#0d9488" font-weight="700">③</text>
  <text x="55" y="184" font-size="10" fill="#ea580c" font-weight="700">④</text>
  <text x="55" y="224" font-size="10" fill="#7c3aed" font-weight="700">⑤</text>
  <text x="55" y="259" font-size="10" fill="#94a3b8" font-weight="700">⑥</text>
</svg>
<span class="figure-caption">图 R3.1 ｜ 配置系统六层分工全景——从类型定义到热重载</span>

<details>
<summary>ASCII 原版</summary>

```
                       配置系统全景
  ┌───────────────────────────────────────────────────────────┐
  │  类型层    types.openclaw.ts  +  types.*.ts (按段拆分)      │
  │  校验层    zod-schema.*.ts  →  schema.ts  →  validation.ts  │
  │  IO 层     io.ts (读/写/快照/恢复)  +  runtime-snapshot.ts  │
  │  覆盖层    runtime-overrides.ts (CLI/UI 运行时补丁)         │
  │  重载层    gateway/config-reload.ts (chokidar 文件监听)     │
  │  元数据层  schema.help.ts / doc-baseline.ts / metadata      │
  └───────────────────────────────────────────────────────────┘
```

</details>

---

## 1. `OpenClawConfig` 类型定义

### 1.1 顶层结构

整个配置树的根类型是 `OpenClawConfig`，定义在 `src/config/types.openclaw.ts:54-154`。它是一个**全部字段可选**的扁平对象：每个顶层段对应一个能力域。下面是节选（完整 30 余段）：

```ts
export type OpenClawConfig = {
  $schema?: string;
  meta?: { lastTouchedVersion?: string; lastTouchedAt?: string };
  auth?: AuthConfig;
  env?: { shellEnv?: {...}; vars?: Record<string,string>; [key: string]: ... };
  agents?: AgentsConfig;
  channels?: ChannelsConfig;
  models?: ModelsConfig;
  gateway?: GatewayConfig;
  plugins?: PluginsConfig;
  // ... 还有 secrets / skills / tools / hooks / cron / mcp / proxy 等
};
```

为什么所有字段都是可选的？因为 OpenClaw 的设计目标之一是「零配置可启动」——一个空的 `openclaw.json`（甚至文件不存在）也能让网关跑起来，缺省值由 schema 层在读取时补齐（见 §3.2）。把可选性放在类型层，意味着任何下游代码访问 `cfg.channels?.telegram` 时编译器都强制它处理 `undefined`，这是「配置随时可能缺段」这一事实在类型系统里的投影。

每个顶层段都被拆到独立文件里，由 `types.openclaw.ts:1-30` 的一组 `import type` 汇聚。这种「一段一文件」的拆分不是洁癖，而是为了**编译增量**与**插件隔离**：

- `src/config/types.channels.ts`、`types.telegram.ts`、`types.slack.ts` 等每个渠道一份，改一个渠道的类型不会触发其他渠道的重编译。
- 插件 SDK（`src/plugin-sdk/config-contracts.ts`）只 re-export 这些类型的一个子集，插件作者拿到的是「契约视图」而非整个内部树。

### 1.2 关键段落速览

| 段 | 类型 | 文件 | 作用 |
|---|---|---|---|
| `auth` | `AuthConfig` | `types.auth.ts` | 网关访问令牌 / 密码 / 配置档加密 |
| `agents` | `AgentsConfig` | `types.agents.ts` | 多 Agent 定义、agent 目录、模型引用 |
| `bindings` | `AgentBinding[]` | `types.agents.ts` | 渠道会话 → Agent 的路由绑定 |
| `channels` | `ChannelsConfig` | `types.channels.ts` | 各渠道账号、token、行为策略 |
| `models` | `ModelsConfig` | `types.models.ts` | provider 凭据、模型别名、默认模型 |
| `gateway` | `GatewayConfig` | `types.gateway.ts` | 监听地址、reload 策略、discovery |
| `plugins` | `PluginsConfig` | `types.plugins.ts` | 插件启用、installs 记录 |
| `secrets` | `SecretsConfig` | `types.secrets.ts` | SecretRef 解析、密钥来源 |
| `proxy` | `ProxyConfig` | `zod-schema.proxy.ts` | SSRF 防护用的前置代理 |

注意 `bindings` 直接是顶层数组（`types.openclaw.ts:129`），而不是放在 `agents` 下面。这是刻意的：绑定是「渠道与 Agent 的连接关系」，它跨越了 channels 段和 agents 段，放在任一段下都会造成耦合，所以提到顶层。

### 1.3 `env` 段的「双形态」设计

`env` 段有一个值得停下来看的类型（`types.openclaw.ts:65-80`）：

```ts
env?: {
  shellEnv?: { enabled?: boolean; timeoutMs?: number };
  vars?: Record<string, string>;
  [key: string]: string | Record<string,string> | {...} | undefined;
};
```

它同时支持两种写法：规范写法 `env.vars.FOO = "bar"`，和「糖写法」`env.FOO = "bar"`（直接把变量挂在 `env` 下）。索引签名 `[key: string]` 就是为糖写法服务的。为什么要忍受这种类型上不优雅的联合？因为运营者手写 JSON 时几乎总会写成 `env.FOO`，强制 `env.vars.FOO` 会制造大量「为什么我的变量没生效」的支持工单。类型层吞下这个复杂度，换取配置文件的人体工学。

### 1.4 配置状态的「品牌类型」

`types.openclaw.ts:156-164` 定义了一组品牌类型（branded types）：

```ts
declare const openClawConfigStateBrand: unique symbol;
type BrandedConfigState<T extends string> = OpenClawConfig & { readonly [openClawConfigStateBrand]?: T };

export type SourceConfig         = BrandedConfigState<"source">;
export type ResolvedSourceConfig = BrandedConfigState<"resolved-source">;
export type RuntimeConfig        = BrandedConfigState<"runtime">;
```

这三者**运行时是同一个 `OpenClawConfig` 形状**，但在类型上互不兼容。它们分别代表配置生命周期里的三个阶段：

- `SourceConfig`：磁盘上原样解析出来的，含 `$include` 指令和 `${ENV}` 占位符。
- `ResolvedSourceConfig`：`$include` 已展开、`${ENV}` 已替换，但**尚未补默认值**。
- `RuntimeConfig`：再叠加 schema 默认值后，给进程内读者用的最终形态。

为什么要在类型系统里区分这三者？因为「写回配置文件」必须用 `ResolvedSourceConfig`——如果误用 `RuntimeConfig` 去 `config set`，会把 schema 补出来的默认值固化进 `openclaw.json`，文件越写越胖，而且一旦默认值在未来版本变了，用户的文件还死死钉着旧默认值。品牌类型让这种误用变成**编译错误**而不是运行时事故。`src/config/io.ts:1212-1213` 的 `asResolvedSourceConfig` / `asRuntimeConfig` 是仅有的合法转换入口。

### 1.5 `ConfigFileSnapshot`：一次读取的完整产物

`types.openclaw.ts:178-203` 定义的 `ConfigFileSnapshot` 是配置读取的「一等公民返回值」：

```ts
export type ConfigFileSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;                  // 磁盘原文
  parsed: unknown;                     // JSON5 解析后、未做任何处理
  sourceConfig: ResolvedSourceConfig;  // $include + ${ENV} 已解析，未补默认值
  resolved: ResolvedSourceConfig;      // 同上，给 config set/unset 用
  valid: boolean;
  runtimeConfig: RuntimeConfig;        // 补完默认值，进程内读者用
  config: RuntimeConfig;               // @deprecated 别名
  hash?: string;
  issues: ConfigValidationIssue[];     // 致命错误
  warnings: ConfigValidationIssue[];   // 非致命警告
  legacyIssues: LegacyConfigIssue[];   // 旧 key 检测
};
```

一个 snapshot 同时携带「原文」「半解析」「全解析」「校验结果」四个层次，是因为不同消费者需要不同的层次：reload 比对要 `sourceConfig`，进程内业务逻辑要 `runtimeConfig`，`config set` 要 `resolved`，doctor 诊断要 `legacyIssues`。把它们打成一个不可变包，避免每个消费者各自重新解析一遍——配置解析包含 `$include` 文件 IO 和插件校验，并不便宜。

---

## 2. 配置层级与覆盖优先级

OpenClaw 的「同一个值有多个来源」分两条独立的链路，**不要混为一谈**：

### 2.1 环境变量来源链

`.env.example:8-12` 把它写得很明确：

```
# Env-source precedence for environment variables (highest -> lowest):
# process env, ./.env, ~/.openclaw/.env, then openclaw.json `env` block.
# Existing non-empty process env vars are not overridden by dotenv/config env loading.
```

即环境变量的优先级（高 → 低）：

<svg viewBox="0 0 760 260" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="环境变量来源链优先级（高到低）">
  <defs>
    <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">环境变量来源链（优先级：高 → 低）</text>
  <rect x="200" y="36" width="360" height="38" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="54" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">进程环境变量 (process.env)</text>
  <text x="380" y="68" text-anchor="middle" font-size="10" fill="#64748b">最高优先级，已存在的非空值不被覆盖</text>
  <line x1="380" y1="74" x2="380" y2="94" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2)"/>
  <text x="400" y="88" font-size="10" fill="#94a3b8">覆盖</text>
  <rect x="200" y="96" width="360" height="38" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="114" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">./.env</text>
  <text x="380" y="128" text-anchor="middle" font-size="10" fill="#64748b">仓库本地运行</text>
  <line x1="380" y1="134" x2="380" y2="154" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2)"/>
  <text x="400" y="148" font-size="10" fill="#94a3b8">覆盖</text>
  <rect x="200" y="156" width="360" height="38" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="174" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">~/.openclaw/.env</text>
  <text x="380" y="188" text-anchor="middle" font-size="10" fill="#64748b">launchd / systemd 守护进程</text>
  <line x1="380" y1="194" x2="380" y2="214" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2)"/>
  <text x="400" y="208" font-size="10" fill="#94a3b8">覆盖</text>
  <rect x="200" y="216" width="360" height="38" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="234" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">openclaw.json 的 env 段</text>
  <text x="380" y="248" text-anchor="middle" font-size="10" fill="#64748b">配置文件内联，最低优先级</text>
</svg>
<span class="figure-caption">图 R3.2 ｜ 环境变量来源优先级链——进程 env 永远赢过文件</span>

<details>
<summary>ASCII 原版</summary>

```
  进程环境变量 (process.env)
        │  覆盖
  ./.env                          ← 仓库本地运行
        │  覆盖
  ~/.openclaw/.env                ← launchd/systemd 守护进程
        │  覆盖
  openclaw.json 的 env 段          ← 配置文件内联
```

</details>

关键规则：**已存在的非空 `process.env` 变量不会被 dotenv 或 config 的 env 加载覆盖**。这保证了「我在 shell 里临时 `export FOO=...` 跑一次」永远赢过文件。`env` 段的应用发生在 `src/config/io.ts:1170-1172` 的 `resolveConfigForRead`：

```ts
// Apply config.env to process.env BEFORE substitution so ${VAR} can reference config-defined vars.
if (resolvedIncludes && typeof resolvedIncludes === "object" && "env" in resolvedIncludes) {
  applyConfigEnvVars(resolvedIncludes as OpenClawConfig, env);
}
```

注释点出了顺序的原因：`env` 段必须在 `${VAR}` 替换**之前**应用，否则配置里 `${MY_OWN_VAR}` 引用 `env` 段自己定义的变量就会落空。

### 2.2 配置值来源链

配置文件里的「直接 key」（如 `gateway.auth.token`、渠道 token）走的是另一条链。`.env.example:11-12` 特别提醒：

> direct config keys ... are resolved separately from env loading and often take precedence over env fallbacks.

也就是说，如果你在 `openclaw.json` 里写死了 `channels.telegram.token`，它会盖过 `TELEGRAM_BOT_TOKEN` 环境变量。环境变量在这里只是「fallback」。

配置值本身的覆盖优先级（高 → 低）：

<svg viewBox="0 0 760 260" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="配置值来源链优先级（高到低）">
  <defs>
    <marker id="ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">配置值来源链（优先级：高 → 低）</text>
  <rect x="160" y="36" width="440" height="38" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="54" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">session 级覆盖</text>
  <text x="380" y="68" text-anchor="middle" font-size="10" fill="#64748b">单次会话内的临时配置（fork / 分叉）</text>
  <line x1="380" y1="74" x2="380" y2="94" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3)"/>
  <rect x="160" y="96" width="440" height="46" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="114" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">运行时覆盖</text>
  <text x="380" y="128" text-anchor="middle" font-size="10" fill="#64748b">CLI flag / UI 改动，存在 runtime-overrides.ts 的 overrides 树</text>
  <text x="380" y="140" text-anchor="middle" font-size="10" fill="#94a3b8">applyConfigOverrides()</text>
  <line x1="380" y1="142" x2="380" y2="162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3)"/>
  <rect x="160" y="164" width="440" height="38" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="380" y="182" text-anchor="middle" font-size="13" font-weight="600" fill="#0d9488">配置文件（解析 + 默认值后）</text>
  <text x="380" y="196" text-anchor="middle" font-size="10" fill="#64748b">openclaw.json 经 $include 展开、${ENV} 替换后</text>
  <line x1="380" y1="202" x2="380" y2="222" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3)"/>
  <rect x="160" y="224" width="440" height="30" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="244" text-anchor="middle" font-size="13" font-weight="600" fill="#64748b">schema 默认值</text>
</svg>
<span class="figure-caption">图 R3.3 ｜ 配置值来源优先级链——运行时覆盖永远是最后一层补丁</span>

<details>
<summary>ASCII 原版</summary>

```
  session 级覆盖   ← 单次会话内的临时配置（fork/分叉）
        │
  运行时覆盖       ← CLI flag / UI 改动，存在 runtime-overrides 的 overrides 树
        │  applyConfigOverrides()
  配置文件 (解析+默认值后)
        │
  schema 默认值
```

</details>

运行时覆盖的应用是 `src/config/io.ts:1303` `finalizeLoadedRuntimeConfig` 的最后一步：`return applyConfigOverrides(cfgWithOwnerDisplaySecret);`。这意味着无论配置文件怎么写，运行时覆盖永远是「最后一层补丁」。

### 2.3 `${ENV}` 占位符替换

`src/config/io.ts:1177-1184` 显示 `${VAR}` 替换的策略是**收集警告而非抛错**：

```ts
const envWarnings: EnvSubstitutionWarning[] = [];
return {
  resolvedConfigRaw: resolveConfigEnvVars(resolvedIncludes, env, {
    onMissing: (w) => envWarnings.push(w),
  }),
  envSnapshotForRestore: { ...env } as Record<string, string | undefined>,
  envWarnings,
};
```

缺失的 `${VAR}` 不会让网关崩溃——某个非关键段落引用了未设置的变量，不应该拖垮整个进程。同时这里抓拍了一份 `envSnapshotForRestore`：写回配置时（§3.3）要靠它判断「磁盘上的 `${VAR}` 占位符是否应该恢复」。

---

## 3. `io.ts`：配置 IO 的核心

`src/config/io.ts` 是 2561 行的大文件，但结构清晰：一个工厂函数 `createConfigIO()`（`src/config/io.ts:1253`）封装了所有依赖（fs、homedir、env、json5、logger），返回一组方法；文件末尾再导出一批「模块级便捷函数」（`src/config/io.ts:2385` 起）供普通调用方使用。

### 3.1 依赖注入的工厂模式

`createConfigIO(overrides)` 接收一个 `ConfigIoDeps` 对象（`src/config/io.ts:886-896`），`normalizeDeps()` 把缺省的依赖填上真实实现。为什么不直接调 `fs`？因为配置 IO 的几乎每条路径都需要被测试：损坏文件恢复、EACCES 处理、原子写入、快照比对——这些场景靠注入假 fs 才测得动。`src/config/` 目录里 `io.eacces.test.ts`、`io.invalid-config.test.ts`、`io.clobber-snapshot.test.ts` 等一长串测试文件就是这个设计的回报。

### 3.2 读取路径：从磁盘到 `RuntimeConfig`

读取的主链路是 `createConfigIO().readConfigFileSnapshot()`，公开入口是 `src/config/io.ts:2404` 的同名模块函数。整条流水线：

<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="配置读取流水线：从磁盘到 RuntimeConfig">
  <defs>
    <marker id="ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="ar4h" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#0ea5e9"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">配置读取流水线：磁盘 → RuntimeConfig</text>
  <rect x="60" y="32" width="200" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="160" y="52" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">磁盘 openclaw.json</text>
  <line x1="160" y1="62" x2="160" y2="82" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <text x="172" y="76" font-size="10" fill="#94a3b8">fs.readFile</text>
  <rect x="60" y="84" width="200" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="160" y="103" text-anchor="middle" font-size="11" fill="currentColor">raw 文本</text>
  <line x1="260" y1="98" x2="480" y2="68" stroke="#0ea5e9" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar4h)"/>
  <rect x="484" y="54" width="220" height="26" rx="5" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1"/>
  <text x="594" y="71" text-anchor="middle" font-size="11" fill="#0369a1">→ snapshot.raw</text>
  <line x1="160" y1="112" x2="160" y2="132" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <text x="172" y="126" font-size="10" fill="#94a3b8">parseConfigJson5() :975</text>
  <rect x="60" y="134" width="200" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="160" y="153" text-anchor="middle" font-size="11" fill="currentColor">parsed</text>
  <line x1="260" y1="148" x2="480" y2="98" stroke="#0ea5e9" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar4h)"/>
  <rect x="484" y="84" width="220" height="26" rx="5" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1"/>
  <text x="594" y="101" text-anchor="middle" font-size="11" fill="#0369a1">→ snapshot.parsed</text>
  <line x1="160" y1="162" x2="160" y2="182" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <text x="172" y="176" font-size="10" fill="#94a3b8">resolveConfigIncludesForRead() :1143</text>
  <rect x="60" y="184" width="200" height="36" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="160" y="200" text-anchor="middle" font-size="11" fill="currentColor">$include 展开</text>
  <text x="160" y="214" text-anchor="middle" font-size="10" fill="#94a3b8">受 OPENCLAW_INCLUDE_ROOTS 限制</text>
  <line x1="160" y1="220" x2="160" y2="240" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <text x="172" y="234" font-size="10" fill="#94a3b8">resolveConfigForRead() :1166</text>
  <rect x="60" y="242" width="200" height="36" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="160" y="258" text-anchor="middle" font-size="11" fill="currentColor">applyConfigEnvVars</text>
  <text x="160" y="272" text-anchor="middle" font-size="11" fill="currentColor">+ ${"{"}ENV{"}"} 替换</text>
  <line x1="260" y1="260" x2="480" y2="144" stroke="#0ea5e9" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar4h)"/>
  <rect x="484" y="130" width="220" height="28" rx="5" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1"/>
  <text x="594" y="149" text-anchor="middle" font-size="10" fill="#0369a1">→ snapshot.sourceConfig (ResolvedSourceConfig)</text>
  <line x1="160" y1="278" x2="160" y2="298" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <text x="172" y="292" font-size="10" fill="#94a3b8">schema 校验 + 补默认值</text>
  <rect x="60" y="300" width="200" height="28" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="160" y="319" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">runtimeConfig</text>
  <line x1="260" y1="314" x2="480" y2="194" stroke="#0ea5e9" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar4h)"/>
  <rect x="484" y="180" width="220" height="28" rx="5" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1"/>
  <text x="594" y="199" text-anchor="middle" font-size="10" fill="#0369a1">→ snapshot.runtimeConfig (RuntimeConfig)</text>
  <line x1="160" y1="328" x2="160" y2="348" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <text x="172" y="342" font-size="10" fill="#94a3b8">observeConfigSnapshot() :636 ← 健康检查</text>
  <rect x="60" y="350" width="200" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="160" y="370" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">ConfigFileSnapshot</text>
</svg>
<span class="figure-caption">图 R3.4 ｜ 配置读取流水线——从磁盘到 RuntimeConfig 的六级处理链</span>

<details>
<summary>ASCII 原版</summary>

```
  磁盘 openclaw.json
        │  fs.readFile
   raw 文本 ─────────────────────────────────► snapshot.raw
        │  parseConfigJson5()  (io.ts:975)
   parsed ─────────────────────────────────► snapshot.parsed
        │  resolveConfigIncludesForRead()  (io.ts:1143)
   $include 展开（受 OPENCLAW_INCLUDE_ROOTS 限制）
        │  resolveConfigForRead()  (io.ts:1166)
   applyConfigEnvVars + ${ENV} 替换
   resolvedConfigRaw ──────────────────────► snapshot.sourceConfig (ResolvedSourceConfig)
        │  schema 校验 + 补默认值
   runtimeConfig ──────────────────────────► snapshot.runtimeConfig (RuntimeConfig)
        │  observeConfigSnapshot()  (io.ts:636) ← 健康检查
   ConfigFileSnapshot
```

</details>

JSON5 而非纯 JSON 是刻意的：`parseConfigJson5` 允许注释和尾逗号，配置文件是给人手写的。`$include` 解析受 `resolveIncludeRoots`（`src/config/io.ts:1162`）约束——默认只允许从 `openclaw.json` 所在目录引用文件，扩展目录要靠 `OPENCLAW_INCLUDE_ROOTS` 环境变量显式开（`.env.example:36-39`）。这是一道路径穿越防线：`$include` 本质是「读任意文件」，不加白名单就是任意文件读取漏洞。`readConfigIncludeFileWithGuards`（`src/config/io.ts:1153`）做实际的路径守卫。

`finalizeLoadedRuntimeConfig`（`src/config/io.ts:1267-1304`）是读取的收尾，它依次做：

1. `findDuplicateAgentDirs` —— 多 Agent 共用同一工作目录会破坏会话隔离，直接抛 `DuplicateAgentDirError`（`src/config/io.ts:1272-1274`）。
2. `applyConfigEnvVars` —— 再把 `config.env` 应用到 `process.env`。
3. shell env fallback —— 若 `env.shellEnv.enabled` 或 `OPENCLAW_LOAD_SHELL_ENV` 为真，执行 `$SHELL -l -c 'env -0'` 导入登录 shell 的变量（`src/config/io.ts:1278-1287`）。这是为 macOS GUI 启动场景设计的：launchd 起的进程拿不到用户 shell profile 里的 API key。
4. `ensureOwnerDisplaySecret` —— 自动生成 owner 显示密钥（`src/config/io.ts:1290-1293`）。
5. `applyConfigOverrides` —— 叠加运行时覆盖（`src/config/io.ts:1303`）。

### 3.3 写入路径与 `${VAR}` 还原

写入入口是 `src/config/io.ts:2460` 的 `writeConfigFile(cfg, options)`。它做的第一件不显然的事在 `src/config/io.ts:2477-2483`：

```ts
const runtimeConfigSnapshot = getRuntimeConfigSnapshotState();
const runtimeConfigSourceSnapshot = getRuntimeConfigSourceSnapshotState();
if (hadBothSnapshots) {
  const runtimePatch = createMergePatch(runtimeConfigSnapshot!, cfg);
  nextCfg = coerceConfig(applyMergePatch(runtimeConfigSourceSnapshot!, runtimePatch));
}
```

调用方手里通常拿的是 `RuntimeConfig`（含默认值）。直接写回会把默认值固化进文件。所以这里：计算「运行时快照 → 调用方修改后」的 merge-patch（**只包含真正改动的路径**），再把这个 patch 应用到 `sourceConfig`（不含默认值的那份）上。结果就是「只把用户真正改的东西写回文件」。这正是 §1.4 品牌类型想保护的不变量，在 IO 层的具体兑现。

写入还有 `${VAR}` 还原逻辑（`src/config/io.ts:2089` 附近）：如果某个值在磁盘上原本是 `${API_KEY}`，运行时被替换成了实际密钥，写回时不能把明文密钥落盘——要靠 `envSnapshotForRestore`（§2.3 抓拍的那份）判断「这个值是否等于某个环境变量的当前值」，是则还原成 `${VAR}` 占位符。`ConfigWriteOptions` 的 `envSnapshotForRestore` 和 `expectedConfigPath`（`src/config/io.ts:186-200`）就是为这个安全检查服务的——只有写的是产出该快照的同一个文件路径时才用它。

实际落盘走 `replaceConfigFileSync`（`src/config/io.ts:1349-1359`）→ `replaceFileAtomicSync`：写临时文件再原子 rename，`mode: 0o600`、目录 `0o700`。原子写保证「半截写坏」永远不会发生在真正的 `openclaw.json` 上。

### 3.4 快照（snapshot）与 `loadConfig` 的固定语义

注意区分两种「snapshot」：
- `ConfigFileSnapshot` —— 上面讲的「一次读取的完整产物」。
- **runtime config snapshot** —— 进程级的「当前生效配置」，由 `runtime-snapshot.ts` 管理。

`loadConfig()`（`src/config/io.ts:2385-2388`）的注释点出了关键设计：

```ts
export function loadConfig(): OpenClawConfig {
  // First successful load becomes the process snapshot. Long-lived runtimes
  // should swap this snapshot via explicit reload/watcher paths instead of
  // reparsing openclaw.json on hot code paths.
  return loadPinnedRuntimeConfig(() => createConfigIO().loadConfig());
}
```

`loadConfig()` 不是每次都去读磁盘。**第一次成功读取的结果被「钉」成进程快照**，之后所有 `loadConfig()` / `getRuntimeConfig()` 调用都返回这份钉住的快照。为什么？因为业务代码里 `getRuntimeConfig()` 是热路径——每条入站消息都会调几次。如果每次都重新解析 `openclaw.json`（含 `$include` 文件 IO、插件校验），网关在高消息量下会被配置解析拖垮。

那配置改了怎么办？答案是「显式换快照」：只有 reload 流程（§5）或写入流程才有权调 `setRuntimeConfigSnapshot`（`src/config/runtime-snapshot.ts:132`）替换这份钉住的快照。`runtime-snapshot.ts` 还维护两份：`getRuntimeConfigSnapshot()`（runtime 形态）和 `getRuntimeConfigSourceSnapshot()`（source 形态），后者就是 §3.3 写回时要用的「不含默认值」的基底。

### 3.5 损坏恢复与「最后已知良好」基线

`src/config/io.ts:636` 的 `observeConfigSnapshot` 在每次读取后做健康检查，把指纹（hash、字节数、是否有 meta、gateway mode）记进 `~/.openclaw` 下的 health state 文件。`resolveConfigObserveSuspiciousReasons`（`src/config/io.ts:534-558`）拿当前指纹和「最后已知良好」基线比对，触发告警的条件包括：

```ts
// io.ts:546-555 节选
if (baseline.bytes >= 512 && params.bytes < Math.floor(baseline.bytes * 0.5)) {
  reasons.push(`size-drop-vs-last-good:${baseline.bytes}->${params.bytes}`);
}
if (baseline.hasMeta && !params.hasMeta) { reasons.push(...); }
if (baseline.gatewayMode && !params.gatewayMode) { reasons.push(...); }
```

「文件突然缩水一半以上」「原本有 meta 段现在没了」「原本有 gateway mode 现在没了」都是配置被外部工具误截断的典型特征。检测到异常后：
- `persistBoundedClobberedConfigSnapshot`（`io.clobber-snapshot.ts`）把可疑的损坏内容存一份取证副本。
- `recoverConfigFromLastKnownGood`（`src/config/io.ts:2431`）/ `recoverConfigFromJsonRootSuffix`（`src/config/io.ts:2438`）尝试从备份或 `.bak` 文件恢复。
- `promoteConfigSnapshotToLastKnownGood`（`src/config/io.ts:2425`）在配置确认有效时把它提升为新基线。

配置有效时才提升基线（`src/config/io.ts:672` `if (snapshot.valid)`），保证基线永远是「曾经被验证过能用」的版本。

### 3.6 未来版本守卫

`src/config/future-version-guard.ts` 处理一个跨版本场景：用户用新版 OpenClaw 写过配置后，又用旧版二进制启动。配置的 `meta.lastTouchedVersion`（`types.openclaw.ts:57-58`）记录了「上次写它的版本」。如果旧二进制读到一个「来自未来」的配置就贸然执行破坏性操作（比如重写它），会把新版本引入的字段悄悄抹掉。

`src/config/future-version-guard.ts:5-6` 定义了逃生阀：

```ts
export const ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV =
  "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS";
```

默认情况下，旧二进制对「未来配置」的破坏性操作会被 `FutureConfigActionBlock` 拦截并给出提示，只有显式设置 `OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1` 才放行。`src/config/io.ts:924` 的 `warnIfConfigFromFuture` 在普通读取路径上发出非阻塞警告。

---

## 4. `runtime-overrides.ts`：运行时补丁

`src/config/runtime-overrides.ts` 只有 91 行，是配置系统里最小的模块，但承担了「CLI flag 和 UI 改动如何不落盘地影响生效配置」这件事。

### 4.1 模块级的覆盖树

```ts
// runtime-overrides.ts:6-8
type OverrideTree = Record<string, unknown>;
let overrides: OverrideTree = {};
```

它是一个**进程级单例**——一棵稀疏的「路径 → 值」树。`setConfigOverride(path, value)`（`src/config/runtime-overrides.ts:54-67`）把一个点分路径（如 `gateway.reload.mode`）解析后写进这棵树；`unsetConfigOverride`（`src/config/runtime-overrides.ts:69-84`）删除；`applyConfigOverrides(cfg)`（`src/config/runtime-overrides.ts:86-91`）把整棵树深度合并到一份配置上。

为什么用单例而不是把覆盖塞进配置对象？因为覆盖的生命周期和配置文件无关——它是「这次进程运行期间」的临时状态。CLI 启动时 `--set gateway.discovery.enabled=false` 设一个覆盖，UI 临时切换某个开关也设覆盖，这些都不该写回 `openclaw.json`。把它们隔离在一个独立单例里，`loadConfig()` 每次返回钉住快照时顺手 `applyConfigOverrides` 一遍（§3.2），覆盖就「透明地」生效了。

### 4.2 三道安全栏

这个小模块塞进了三个防御措施，因为覆盖值的来源（CLI 参数、UI 输入）是不可信的：

1. **原型污染防护**：`mergeOverrides` 和 `sanitizeOverrideValue` 都调用 `isBlockedObjectKey(key)`（`src/config/runtime-overrides.ts:23,38`），拒绝 `__proto__` / `constructor` / `prototype` 这类键。`merge-patch.proto-pollution.test.ts` 专测这条。
2. **循环引用防护**：`sanitizeOverrideValue` 用 `WeakSet` 跟踪已访问对象（`src/config/runtime-overrides.ts:10-29`），遇到循环引用返回 `{}` 而不是栈溢出。
3. **`undefined` 剔除**：合并时跳过值为 `undefined` 的键（`src/config/runtime-overrides.ts:23,38`），避免把字段「合并成 undefined」这种含混语义。

`mergeOverrides`（`src/config/runtime-overrides.ts:32-44`）是标准的递归深合并：两边都是 plain object 才递归，否则覆盖值直接取胜。这意味着覆盖一个对象段的子字段不会丢掉同段的其他字段。

---

## 5. 热重载：文件监听 + 重载处理

配置改了不重启进程就能生效，这件事由 `src/gateway/config-reload.ts`（418 行）实现。

### 5.1 chokidar 文件监听

`startGatewayConfigReloader`（`src/gateway/config-reload.ts:84`）启动时用 `chokidar` 监听配置文件（`src/gateway/config-reload.ts:368`）：

```ts
const watcher = chokidar.watch(opts.watchPath, { ... });
watcher.on("add", scheduleFromWatcher);
watcher.on("change", scheduleFromWatcher);
watcher.on("unlink", scheduleFromWatcher);
```

三个事件——新增、修改、删除——都触发 `scheduleFromWatcher`。`watcher.on("error", ...)`（`src/gateway/config-reload.ts:397-404`）保证监听器自身出错（比如文件系统句柄耗尽）不会把进程带崩，只是 warn 一句然后关闭 watcher。

### 5.2 去抖动与排队

文件保存往往触发多个 fs 事件（编辑器写临时文件、rename、truncate）。`src/gateway/config-reload.ts:123-136` 的 `scheduleAfter` / `schedule` 用 `setTimeout` 去抖动，窗口由 `settings.debounceMs`（`resolveGatewayReloadSettings` 从配置读出）决定：

```ts
const scheduleAfter = (wait: number) => {
  if (stopped) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { void runReload(); }, wait);
};
```

`src/gateway/config-reload.ts:106-110` 一组布尔状态（`pending` / `running` / `restartQueued`）保证同一时刻只跑一个 reload，新事件在 reload 进行中只是置 `pending`，结束后再补跑一次。

### 5.3 缺失文件与无效配置的容错

reload 触发后不会盲目应用。`handleMissingSnapshot`（`src/gateway/config-reload.ts:154-169`）：配置文件暂时读不到（可能编辑器正在原子替换的中间窗口），不立刻报错——重试 `MISSING_CONFIG_MAX_RETRIES` 次，每次间隔 `MISSING_CONFIG_RETRY_DELAY_MS`：

```ts
if (missingConfigRetries < MISSING_CONFIG_MAX_RETRIES) {
  missingConfigRetries += 1;
  opts.log.info(`config reload retry (${missingConfigRetries}/${MISSING_CONFIG_MAX_RETRIES}): config file not found`);
  scheduleAfter(MISSING_CONFIG_RETRY_DELAY_MS);
  return true;
}
```

`handleInvalidSnapshot`（`src/gateway/config-reload.ts:171-178`）：配置语法错误或校验失败时，**跳过 reload 但保留旧配置继续运行**，只 warn 出 issue 列表。运营者改坏了配置不会让网关挂掉——这是「抗损坏」需求在重载层的体现。

### 5.4 热重载 vs 重启：重载计划

不是所有改动都能热重载。`applySnapshot`（`src/gateway/config-reload.ts:180`）先用 `diffConfigPaths` 算出新旧配置真正变了哪些路径，再生成一个 `GatewayReloadPlan`（`config-reload-plan.ts`）。计划是一组布尔标志（`src/gateway/config-reload.ts:55-64` 的 `isNoopReloadPlan` 反向列举了它们）：`reloadHooks`、`restartGmailWatcher`、`reloadPlugins` 等。

`src/gateway/config-reload.ts:255` 之后的逻辑根据 `gateway.reload.mode` 决策：
- `mode=off` —— 完全不重载（`src/gateway/config-reload.ts:255` `config reload disabled`）。
- `hot` 模式 —— 能热重载的走 `onHotReload(plan, nextConfig)`；遇到「需要重启才能生效」的改动（如换监听端口），`src/gateway/config-reload.ts:276` 会 `hot mode ignoring`，把这些改动按下不表直到下次手动重启。

这种「计划」的设计让重载粒度精确到子系统：改个 hook 只重载 hook，不会顺带重连所有渠道。

### 5.5 写者意图：避免自反馈

一个微妙问题：网关自己调 `writeConfigFile` 写配置后，文件监听器也会被自己的写入触发，造成「写 → 监听到 → reload」的多余循环。`src/gateway/config-reload.ts:117` 的 `lastAppliedWriteHash` 和 §3 的 `RuntimeConfigWriteNotification` 机制配合解决：写入流程会附带「reload 意图」（`src/config/io.ts:238-239` 注释），`src/gateway/config-reload.ts:244` 的 `config reload skipped by writer intent` 就是命中了这条短路。`src/config/io.ts:2509-2515` 那段长注释解释了为什么写入后要 re-read 一次磁盘——为了让「写入路径发布的 `sourceConfig`」和「监听路径将来读到的 `sourceConfig`」完全一致，否则 `currentCompareConfig` 会永久漂移、每次保存都误判出 `plugins` 段变动而触发整网关重启。

---

## 6. Schema、help、metadata 与基线

### 6.1 Zod schema 与默认值

配置的运行时校验由一组 `zod-schema.*.ts` 文件提供：`zod-schema.core.ts`、`zod-schema.channels.ts`、`zod-schema.agents.ts`、`zod-schema.providers-core.ts` 等，每段一份，最后由 `zod-schema.ts` 汇总。Zod 在这里身兼三职：**类型校验**、**补默认值**（`SourceConfig` → `RuntimeConfig` 的默认值就来自 schema 的 `.default()`）、**生成 JSON Schema**（`$schema` 字段指向的就是从 Zod 导出的 JSON Schema）。

校验逻辑的封装在 `src/config/validation.ts`，校验失败产出的 `ConfigValidationIssue`（`types.openclaw.ts:166-171`）带 `path` / `message` / `allowedValues` —— `allowedValues` 让错误信息能直接告诉用户「这个枚举字段合法值是哪些」。

### 6.2 `schema.help.ts`：人读的字段说明

`src/config/schema.help.ts` 给每个配置路径挂上人类可读的帮助文本，`openclaw config` 的交互式 UI、`doctor` 诊断、文档生成都消费它。`schema.help.quality.test.ts` 是一道质量栏：强制每个字段都有非空、达标的说明，防止新增配置项时漏写 help。配套的还有 `schema.hints.ts`（输入提示）、`schema.labels.ts`（短标签）、`schema.tags.ts`（分类标签，如 `sensitive`）。

### 6.3 `doc-baseline.ts`：配置文档基线

`src/config/doc-baseline.ts` 实现了一个有意思的机制：把整个配置 schema「拍平」成一份 `ConfigDocBaselineEntry` 列表（`src/config/doc-baseline.ts:29-40`），每条记录一个路径的 `type` / `required` / `enumValues` / `defaultValue` / `deprecated` / `sensitive` / `tags`：

```ts
export type ConfigDocBaselineEntry = {
  path: string;
  kind: "core" | "channel" | "plugin";
  type?: string | string[];
  required: boolean;
  enumValues?: JsonValue[];
  defaultValue?: JsonValue;
  deprecated: boolean;
  sensitive: boolean;
  tags: string[];
  // ...
};
```

这份基线被序列化存档。`doc-baseline.test.ts` / `doc-baseline.integration.test.ts` 在 CI 里拿当前 schema 重新拍平，和存档基线比对：**任何配置 schema 的改动都会让基线测试失败**，强制开发者有意识地更新基线（并因此意识到自己在改公开配置契约）。这是把「配置 API 的稳定性」交给测试守卫，而不是靠 code review 凭记忆。`kind` 字段把核心配置、渠道配置、插件配置分开追踪。

### 6.4 retired key 处理

配置字段会被废弃。OpenClaw 区分两种废弃程度：

- **deprecated** —— schema 节点带 `deprecated: true`（`doc-baseline.ts` 的 `JsonSchemaObject` 类型有这个字段），仍然可用但 doctor 会提示迁移。
- **legacy / retired** —— 整个 key 形状已经不被接受。`src/config/io.ts:1241-1250` 的 `collectInvalidConfigLegacyIssues` 调 `findDoctorLegacyConfigIssues`，把旧 key 产出成 `LegacyConfigIssue`（`types.openclaw.ts:173-176`），放进 snapshot 的 `legacyIssues`。

旧 key 不会让配置直接 `invalid`——`legacyIssues` 和 `issues` 是分开的字段。这样一个含旧 key 的配置仍能加载运行，只是 doctor 会专门报告这些旧 key 该怎么改。`src/config/channel-compat-normalization.ts` 负责把一部分旧渠道配置形状**自动归一化**成新形状（例如旧的 `routing.allowFrom` → 新的字段位置），相关测试 `config.legacy-config-detection.rejects-routing-allowfrom.test.ts` / `config.legacy-config-detection.accepts-imessage-dmpolicy.test.ts` 验证「哪些旧形状自动迁移、哪些必须报错」的边界。`createConfigIO` 的 `preservedLegacyRootKeys` 参数（`src/config/io.ts:1256`）让特定调用方在写回时保留一部分尚未迁移完的旧根 key，避免写入过程中误删。

`src/config/config-env-vars.ts` 维护配置 key 与环境变量名的映射，`src/config/io.ts:905` 的 `warnOnConfigMiskeys` 在读取时对常见的拼错 key（如 `chanels` 写成 `channels`）发出警告——这是给手写 JSON 的运营者的又一道护栏。

---

## 7. `.env.example` 关键配置项

`.env.example`（95 行）是新用户的起点。它本身不被代码读取——`.env` 才是。文件头部（`.env.example:1-12`）讲清楚了拷贝去向（`./​.env` 用于仓库本地运行，`~/.openclaw/.env` 用于守护进程）和环境变量优先级。关键项分类：

### 7.1 网关认证与路径

```
OPENCLAW_GATEWAY_TOKEN=             # 网关绑定到 loopback 之外时必填
OPENCLAW_STATE_DIR=~/.openclaw      # 状态目录
OPENCLAW_CONFIG_PATH=~/.openclaw/openclaw.json
OPENCLAW_INCLUDE_ROOTS=...          # $include 允许的额外目录白名单
OPENCLAW_LOAD_SHELL_ENV=1           # 从登录 shell profile 导入缺失变量
```

`.env.example:17-21` 有一条重要的安全规则：网关**拒绝以文档里的示例占位符值启动**。这防止用户直接复制粘贴教程里的 token。留空则首次启动自动生成。`OPENCLAW_LOAD_SHELL_ENV` 对应 §3.2 第 3 步的 shell env fallback。

### 7.2 模型 provider 密钥

`.env.example:46-69` 列出 provider key，设计上支持多种形态：
- 单 key：`OPENAI_API_KEY=sk-...`
- 编号 key（多账号轮换）：`OPENAI_API_KEY_1=...`
- 逗号分隔列表：`OPENAI_API_KEYS=sk-1,sk-2`

为什么三种都支持？因为不同部署规模诉求不同：个人单 key，多账号轮换用编号或列表分散速率限制。`OPENCLAW_LIVE_*` 前缀的变量（`.env.example:52-54`）专供 live 集成测试使用，和生产 key 隔离。

### 7.3 渠道与工具

`.env.example:73-96` 列出渠道 token（`TELEGRAM_BOT_TOKEN`、`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` 等）和工具/语音密钥（`BRAVE_API_KEY`、`ELEVENLABS_API_KEY` 等）。注释「only set what you enable」呼应了 §1.1 的「全字段可选」哲学：你只填你用到的渠道，其余保持注释状态。`.env.example` 里这些 token 出现的环境变量名，正是各渠道插件 `openclaw.plugin.json` 的 `channelEnvVars` 声明的（见第 04 章 §6），二者必须对得上。

---

## 8. 小结

OpenClaw 的配置系统用一组分工明确的模块兑现了开篇列出的五个需求：

| 需求 | 兑现机制 | 关键文件 |
|---|---|---|
| 可读可写不污染 | 品牌类型 + merge-patch 写回 | `types.openclaw.ts:156-164`、`src/config/io.ts:2477-2483` |
| 多来源优先级 | 环境链 + 配置链 + 运行时覆盖 | `.env.example:8-12`、`runtime-overrides.ts` |
| 热重载 | chokidar 监听 + 重载计划 | `config-reload.ts` |
| 抗损坏 | 健康检查 + 最后已知良好基线 + 原子写 | `src/config/io.ts:534-558`、`src/config/io.ts:2431` |
| 演进 | retired key 检测 + 未来版本守卫 + doc-baseline | `future-version-guard.ts`、`doc-baseline.ts` |

贯穿全章的核心权衡是：**把复杂度集中在配置系统内部，换取配置文件对人的友好和进程对故障的健壮**。`env` 段的双形态、`${VAR}` 还原、shell env fallback、损坏恢复、未来版本守卫——每一个都是「替运营者吞掉一类麻烦」。下一章进入 Channel 抽象层，配置树里的 `channels` 段将在那里被真正消费。
