# 第 01 章 架构总览与启动流程

> 代码版本锁定：`openclaw/openclaw@50a2481652`（tag `v2026.5.18`，2026-05-18）。
> 本章所有 `file:line` 引用均基于该 commit，路径为仓库根相对路径。

本章面向已经熟悉 TypeScript / Node.js 的资深工程师，目标是在动手读任何子系统源码之前，先建立一张可靠的「全局地图」：OpenClaw 是什么、它的代码怎么分层、一个进程从命令行被敲下到 Gateway 监听端口之间究竟发生了什么。后续章节会逐层下钻；本章只负责把骨架和血管画清楚。

---

## 1. OpenClaw 是什么，解决什么问题

### 1.1 一句话定位

OpenClaw 是一个**自托管的个人 AI 助手网关**。它把用户已经在用的二十多种消息渠道统一接入，让一个 LLM 驱动的助手能在这些渠道上收发消息、进行语音对话、并渲染可交互的 Canvas。

README 的开篇定义非常精炼（`README.md:21-22`）：

```
OpenClaw is a personal AI assistant you run on your own devices.
It answers you on the channels you already use. ... The Gateway is just
the control plane — the product is the assistant.
```

这句话里有三个关键判断，值得逐个拆开：

1. **「run on your own devices」** —— OpenClaw 是单用户、自托管的。它不是一个 SaaS，也不假设有多租户。这个决定贯穿整个代码库：配置是单份 `openclaw.json`、Gateway 默认只绑 loopback、认证模型是「operator + 受信设备」而非「用户账户体系」。
2. **「the channels you already use」** —— 价值不在于又造一个聊天框，而在于复用用户既有的 IM。`README.md:26` 列出的支持渠道包括 WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、IRC、Microsoft Teams、Matrix、Feishu、LINE、Mattermost、Nextcloud Talk、Nostr、Synology Chat、Tlon、Twitch、Zalo、WeChat、QQ、WebChat 等。
3. **「the Gateway is just the control plane」** —— 这是理解整个架构的钥匙。Gateway 不是产品本身，它是**控制平面**：负责连接管理、RPC 分发、会话编排与插件加载。真正的「产品」是跑在它之上的 assistant（agent + LLM + tools）。

### 1.2 设计哲学：从 VISION.md 读出的约束

`VISION.md` 不是营销文案，而是一份**架构约束清单**。几条对读代码最有指导意义：

- **核心保持精简，能力尽量做成插件**（`VISION.md:54-57`）：「Core stays lean; optional capability should usually ship as plugins.」这解释了为什么 `extensions/` 目录下有 137 个子目录——渠道、provider、memory 等几乎都是插件。
- **为什么选 TypeScript**（`VISION.md:100-104`）：「OpenClaw is primarily an orchestration system: prompts, tools, protocols, and integrations.」OpenClaw 把自己定位为**编排系统**而非算法系统，所以选了易读易改的 TS，而非 Python/Rust。
- **安全是「有意的取舍」**（`VISION.md:43-44`）：强默认值 + 显式的高权限开关。`SECURITY.md` 是 34KB 的正式文档，这在同类开源项目里相当罕见。

`AGENTS.md` 进一步给出了硬性的架构边界（`AGENTS.md:28-31`）：

```
- Core stays plugin-agnostic. No bundled ids/defaults/policy in core ...
- Plugins cross into core only via openclaw/plugin-sdk/*, manifest metadata,
  injected runtime helpers, documented barrels (api.ts, runtime-api.ts).
```

也就是说：**core 不允许 import 任何插件的 `src/**`，插件也不允许 import core 的内部实现**。两者之间只能通过 `src/plugin-sdk/*`、manifest 元数据和注入的 runtime helper 通信。读 `src/` 时如果看到对 `extensions/` 的直接引用，那要么是 bug，要么是「内置 bundled 插件」的特例。

### 1.3 项目演化史

`VISION.md:13` 记录了项目的更名史：`Warelay -> Clawdbot -> Moltbot -> OpenClaw`。这段历史在读代码时偶尔会冒出来——某些环境变量、配置键仍带早期命名痕迹。当前所有面向用户的命名统一为 `openclaw`（`src/entry.ts:90` 把 `process.title` 设为 `"openclaw"`）。

---

## 2. Monorepo 顶层布局

OpenClaw 是一个 pnpm workspaces 管理的 monorepo。`pnpm-workspace.yaml:1-5` 定义了四类 workspace：

```yaml
packages:
  - .            # 根包 openclaw（核心）
  - ui           # 浏览器端 Control UI
  - packages/*   # 可复用 SDK
  - extensions/* # 渠道 / provider / memory 等插件
```

下表是顶层目录的职责分工，记住这张表，后面查代码不会迷路：

| 目录 | 职责 | 关键入口 |
|------|------|----------|
| `src/` | **核心**。Gateway、CLI、agent 编排、入站管线、插件加载器、协议定义 | `src/entry.ts`, `src/gateway/`, `src/cli/` |
| `apps/` | **原生伴生应用**。macOS / iOS / Android / Windows / Linux 客户端，以及 `macos-mlx-tts`、`swabble` | `apps/macos`, `apps/ios`, `apps/android` |
| `packages/` | **可复用 SDK**。对外发布的稳定包 | `packages/sdk`, `packages/plugin-sdk`, `packages/memory-host-sdk`, `packages/plugin-package-contract` |
| `extensions/` | **插件**。渠道、provider、memory、工具等。137 个子目录，几乎所有「能力」都在这里 | `extensions/telegram`, `extensions/whatsapp`, … |
| `ui/` | **浏览器端 Control UI**。Vite + 前端框架构建的单页应用 | `ui/index.html`, `ui/vite.config.ts`, `ui/src/` |
| `config/` | **构建期工具配置**。tsconfig 模板、lint、格式化、Swift 工具配置 | `config/tsconfig/`, `config/knip.config.ts` |
| `scripts/` | **构建与运维脚本**。338 个脚本，`build-all.mjs`、`tsdown-build.mjs`、测试 runner 等 | `scripts/build-all.mjs` |

值得注意的几点：

- `src/` 自身就有 106 个子目录，本身远大于一般「核心」。这是 OpenClaw 的现实——「核心精简」是方向（`VISION.md:56` 写「generally slimming down core」），而非现状。
- `extensions/` 在面向用户的文档里叫「plugins」，在仓库内部叫 `extensions/`（`AGENTS.md:17`：「Product/docs/UI/changelog wording: "plugin/plugins"; extensions/ is internal.」）。本 wiki 沿用「插件」一词。
- 根 `package.json` 高达 100KB（`package.json` 共约 1700 行 scripts），因为它同时承载核心代码的依赖和大量内置 bundled 插件的依赖。

---

## 3. 四层架构

OpenClaw 的运行时可以清晰地切成四层。理解这四层、以及它们之间「谁调用谁、数据往哪流」，是读懂整个代码库的核心。

### 3.1 整体架构图

```
                          外部世界
   ┌──────────┬──────────┬──────────┬──────────┬──────────┐
   │ WhatsApp │ Telegram │  Slack   │  Feishu  │ WebChat  │  ... 20+ 渠道
   └────┬─────┴────┬─────┴────┬─────┴────┬─────┴────┬─────┘
        │          │          │          │          │
══════════════════ ① 接入层 (channels) ═══════════════════
        │   extensions/<channel>/  +  src/channels/plugins/
        │   每个渠道是一个插件，把平台原生消息归一化为
        │   OpenClaw 内部的 inbound 消息结构
        ▼
══════════════ ② Gateway 控制平面 (control plane) ═══════════
        │   src/gateway/server.impl.ts
        │   - HTTP / WebSocket 监听器
        │   - RPC 方法注册表 (methods/registry)
        │   - WS 连接生命周期、auth、scope 鉴权
        │   - 内存注册表：chat run / session / 节点
        ▼
══════════════ ③ 消息编排 (orchestration) ═══════════════════
        │   src/auto-reply/   入站管线：去重、路由、节流
        │   src/sessions/     会话状态与历史
        │   src/auto-reply/reply/  出站投递（dispatcher）
        ▼
══════════════ ④ AI 核心 (assistant) ═══════════════════════
        │   src/agents/        agent harness、运行循环
        │   provider 插件      LLM provider（OpenAI/Anthropic/...）
        │   src/tools/         工具调用
        │   src/plugins/       插件加载与 runtime
        ▼
    LLM 推理 + 工具副作用（文件、shell、Canvas、节点设备）
        │
        └──► 回复沿 ③ → ② → ① 反向投递回原渠道
```

四层之间是**双向**的：入站消息自上而下穿过四层，agent 产生的回复再自下而上投递回去。Gateway（第②层）是所有流量的咽喉——任何 CLI 命令、浏览器 Control UI、原生 app、节点设备，都通过 WebSocket 连到它。

### 3.2 ① 接入层（channels）

接入层的职责是**把各平台五花八门的消息格式归一化**。它由两部分组成：

- `extensions/<channel>/` —— 每个渠道一个插件包，封装该平台的 SDK（如 Telegram 用 grammY、WhatsApp 用 baileys）。`AGENTS.md:24` 明确 `extensions/` 是插件目录。
- `src/channels/plugins/` —— core 侧的渠道插件契约与注册表。`src/gateway/server.impl.ts:5-8` import 了 `getLoadedChannelPluginEntryById`、`listLoadedChannelPlugins`，这是 Gateway 感知「当前加载了哪些渠道」的入口。

渠道插件在 Gateway 启动时由 `channelManager` 管理（`src/gateway/server.impl.ts:826-838` 的 `createChannelManager`）。每个渠道可以声明自己专属的 gateway RPC 方法（`src/gateway/server.impl.ts:714-723` 的 `listStartupChannelGatewayMethods` 会收集所有渠道插件的 `gatewayMethods`）。

### 3.3 ② Gateway 控制平面

这是第 02 章的主题，这里只给定位。Gateway 是一个长驻进程，对外暴露：

- 一个 **WebSocket 服务**：所有控制流量（RPC 请求、事件推送）都走它。
- 一个 **HTTP 服务**：承载 Control UI 静态资源、可选的 OpenAI 兼容端点（`/v1/chat/completions`、`/v1/responses`）、MCP loopback 等。

`src/gateway/server.impl.ts:460-462` 定义了 Gateway 对外的最小句柄类型——一个 `GatewayServer` 只暴露 `close()`：

```ts
export type GatewayServer = {
  close: (opts?: GatewayCloseOptions) => Promise<void>;
};
```

启动函数 `startGatewayServer`（`src/gateway/server.impl.ts:532-535`）默认监听端口 `18789`。

### 3.4 ③ 消息编排

入站消息到达 Gateway 后，并不直接丢给 LLM。它先经过 `src/auto-reply/` 的**入站管线**：去重、判断是否需要回复、路由到正确的 session、节流。`src/gateway/server.impl.ts:3` import 的 `getTotalPendingReplies` 来自 `auto-reply/reply/dispatcher-registry.js`——这是**出站投递**侧的注册表，统计当前还有多少条回复在排队等待发回渠道。

`src/sessions/` 负责会话状态：一个「session」对应一次对话上下文，有自己的历史、配置、所属 agent。Gateway 在内存里维护活跃 session 的注册表（见第 02 章 `server-chat-state.ts`）。

### 3.5 ④ AI 核心

最底层是真正干活的部分：

- `src/agents/` —— agent harness 与运行循环。`src/cli/run-main.ts:221-233` 的 `disposeCliAgentHarnesses` 引用了 `agents/harness/registry.js`，说明 agent harness 是可注册、可释放的资源。
- **provider 插件** —— LLM provider（OpenAI、Anthropic、Bedrock 等）也是插件。`pnpm-workspace.yaml:49` 在 overrides 里钉死了 `@anthropic-ai/sdk` 版本，侧面说明 provider 集成深度依赖各家 SDK。
- `src/tools/` —— 工具调用（文件读写、shell、web 搜索等）。
- `src/plugins/` —— 插件加载器与 runtime。它是连接 core 与 `extensions/` 的桥梁。

agent 产生的输出（流式 token、工具调用、最终文本）以**事件**的形式经 `server-chat.ts` 广播回 Gateway 的订阅者，再投递回原渠道——这条路径是第 02、03 章的重点。

---

## 4. 进程启动引导链

现在进入本章最硬核的部分：一个 `openclaw gateway run` 命令，从 shell 敲下回车到 Gateway 端口开始监听，进程内部到底跑了哪条链路。整条链有五个明确的阶段：

```
   openclaw.mjs        ① 启动器（纯 .mjs，无构建依赖）
        │  - Node 版本检查
        │  - compile cache 决策 / respawn
        │  - import dist/entry.js
        ▼
   src/entry.ts        ② 入口（编译后为 dist/entry.js）
        │  - isMainModule 守卫
        │  - 参数规范化（Windows argv / profile / container）
        │  - 启动 trace
        ▼
   src/cli/run-main.ts ③ 命令路由
        │  - 容器 / profile / dotenv
        │  - gateway run fast-path
        │  - Commander 程序构建
        ▼
   gateway 命令         ④ src/cli/gateway-cli/run.ts
        │  - 解析端口、bind、auth 选项
        ▼
   server.ts → server.impl.ts  ⑤ 真正启动 Gateway
```

下面逐阶段拆。

### 4.1 阶段一：`openclaw.mjs` 启动器

`openclaw.mjs` 是 `package.json` 的 `start` 脚本入口（`package.json:1580`：`"start": "node openclaw.mjs"`），也是全局安装后的 `bin`。它**故意写成纯 `.mjs`、不经过任何构建步骤**——因为它要在「dist 还没构建出来」时也能给出有意义的报错。

它做四件事：

**(1) Node 版本检查**（`openclaw.mjs:11-42`）。要求 Node ≥ 22.16：

```js
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 16;
...
ensureSupportedNodeVersion();
```

版本不够时直接 `process.exit(1)`，并打印 nvm 升级指引。**为什么放在最前面**：后续代码大量使用 Node 22 的新 API（如 `module.enableCompileCache`），不先卡版本会得到难以诊断的崩溃。

**(2) compile cache 决策**（`openclaw.mjs:48-85`、`206-248`）。Node 22 的 `module.enableCompileCache` 能把 V8 编译产物缓存到磁盘，显著加快冷启动。但 OpenClaw 区分两种安装形态：

- **源码 checkout**（`isSourceCheckoutLauncher`，`openclaw.mjs:44-46`，靠 `.git` 或 `src/entry.ts` 是否存在判断）：源码会频繁变动，compile cache 反而可能用旧产物，所以 `respawnWithoutCompileCacheIfNeeded`（`openclaw.mjs:183-204`）会**带 `NODE_DISABLE_COMPILE_CACHE=1` 重启自己**。
- **打包安装**：`resolvePackagedCompileCacheDirectory`（`openclaw.mjs:66-85`）按「包版本 + package.json 的 mtime/size」算出一个稳定的缓存目录，确保升级后缓存自动失效。

**(3) respawn（重新拉起子进程）**（`openclaw.mjs:94-181`）。`runRespawnedChild` 用 `spawn` 起一个继承 stdio 的子进程，然后做**信号转发与优雅退出**：

```js
const respawnSignals = process.platform === "win32"
  ? ["SIGTERM", "SIGINT", "SIGBREAK"]
  : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];
```

父进程收到信号后转发给子进程，并启动两级定时器（`respawnSignalExitGraceMs` / `respawnSignalForceKillGraceMs`，各 1 秒，`openclaw.mjs:91-92`）。**为什么要这样**：如果子进程忽略 `SIGTERM`，父进程不能被它永久拖住——宽限期过后强杀（`forceKillChild`，`openclaw.mjs:120-126`）。这段逻辑和 `src/entry.compile-cache.ts` 是有意重复的（`openclaw.mjs:100-102` 的注释明说），因为启动器还不能 import TS 代码。

**(4) 加载真正入口**（`openclaw.mjs:386-401`）。在确认不需要 respawn 后，它尝试 `import("./dist/entry.js")`，失败再试 `.mjs`，都失败就抛出一段精心写的错误（`buildMissingEntryErrorMessage`，`openclaw.mjs:311-326`）——告诉用户「你装的是未构建的源码树，请 `pnpm build`」。

启动器还内置了一条 **help fast-path**（`openclaw.mjs:328-384`）：`openclaw --help` 这种纯求助调用，会直接读预计算好的 `dist/cli-startup-metadata.json` 把 help 文本打出来，**完全跳过整个 TS 运行时的加载**。这是 OpenClaw 对启动性能的极致优化之一。

### 4.2 阶段二：`src/entry.ts`

编译后是 `dist/entry.js`，由启动器 import 进来。它的顶层代码有一个**关键守卫**（`src/entry.ts:75-82`）：

```ts
if (!isMainModule({ currentFile: ..., wrapperEntryPairs: [...] })) {
  // Imported as a dependency — skip all entry-point side effects.
} else {
  ...
}
```

**为什么需要**：bundler 可能把 `entry.js` 当作 `dist/index.js` 的共享依赖再次 import；没有这个守卫，顶层代码会第二次调用 `runCli`，启动一个重复的 Gateway，撞锁/撞端口导致进程崩溃（注释 `src/entry.ts:71-74` 把这个坑写得很清楚）。

确认是主模块后，`entry.ts` 依次做：

1. `process.title = "openclaw"`（`src/entry.ts:90`）—— 让 `ps` 里能认出进程。
2. `ensureOpenClawExecMarkerOnProcess()` / `installProcessWarningFilter()` / `normalizeEnv()`（`src/entry.ts:91-93`）—— 环境标记、警告过滤、环境变量规范化。
3. `enableOpenClawCompileCache()`（`src/entry.ts:95-97`）—— 打包形态下启用 compile cache（与启动器配合）。
4. **CLI respawn 计划**（`src/entry.ts:109-118` 的 `ensureCliRespawnReady`）—— `buildCliRespawnPlan` 可能因为某些选项（如内存上限、`--node-options`）需要带新参数重启自己。
5. **参数规范化三连**（`src/entry.ts:120-146`）：
   - `normalizeWindowsArgv` —— 修正 Windows 上的 argv 怪异行为。
   - `parseCliContainerArgs` —— 解析 `--container`（在容器里跑命令）。
   - `parseCliProfileArgs` + `applyCliProfileEnv` —— 解析 `--profile` / `--dev`（多份隔离配置）。
   - 注意 `src/entry.ts:136-140`：`--container` 与 `--profile` **互斥**，组合使用直接 `exit(2)`。
6. **version fast-path**（`src/entry.ts:149`）：`openclaw --version` 类似 help，走 `tryHandleRootVersionFastPath` 快速返回。
7. 最后调用 `runMainOrRootHelp(process.argv)`（`src/entry.ts:151`）。

`entry.ts` 还埋了一个 **gateway 专用启动 trace**（`src/entry.ts:35-66` 的 `createGatewayEntryStartupTrace`）：当环境变量 `OPENCLAW_GATEWAY_STARTUP_TRACE` 为真且参数里有 `gateway` 时，每个阶段往 stderr 打 `[gateway] startup trace: entry.<name> <ms>`。这条 trace 会一路贯穿到 `server.impl.ts`（见第 02 章），是排查启动慢的利器。

`runMainOrRootHelp`（`src/entry.ts:199-220`）先尝试 root-help fast-path，否则 `import("./cli/run-main.js")` 并调用 `runCli`。注意 import 是**动态的**——这是 OpenClaw 的普遍模式：尽量延迟加载，只在真正需要时才把模块拉进来，以压缩冷启动时间。

### 4.3 阶段三：`src/cli/run-main.ts` —— 命令路由

`runCli`（`src/cli/run-main.ts:430-820`）是 CLI 的总调度器，近 400 行。它的核心职责是**判断这次调用是「普通 CLI 命令」还是「跑 Gateway」，并尽量为常见路径走快速通道**。关键节点：

**(1) 容器与 profile**（`src/cli/run-main.ts:433-456`）。再次解析容器/profile（与 `entry.ts` 重复，因为 `runCli` 也可能被测试或 SDK 直接调用）。`maybeRunCliInContainer` 若命中容器目标，会把命令丢进容器执行并直接返回。

**(2) dotenv 与 runtime 守卫**（`src/cli/run-main.ts:462-474`）。非 help/version 调用会加载 `.env`（`shouldLoadCliDotEnv` 检查 cwd 和 state 目录），然后 `assertSupportedRuntime()` 再次确认运行时。

**(3) 代理引导**（`src/cli/run-main.ts:479-533`）。对「网络型命令」启动 operator 管理的代理；本地 Gateway/控制平面命令保持直连 loopback。这里还注册了 `SIGTERM`/`SIGINT` 处理器，确保退出时关掉代理。

**(4) gateway run fast-path**（`src/cli/run-main.ts:94-205` + `608-624`）。这是最值得关注的分支。`isGatewayRunFastPathArgv`（`src/cli/run-main.ts:94-134`）用一个小状态机扫描 argv，判断这次调用是不是「纯粹的 `openclaw gateway` 或 `openclaw gateway run` + 若干已知选项」。如果是，`tryRunGatewayRunFastPath`（`src/cli/run-main.ts:148-205`）会**只构建一个极简的 Commander 程序**——只挂 `gateway` 和 `gateway run` 两个命令，跳过整个插件 CLI 注册流程：

```ts
const gateway = addGatewayRunCommand(
  program.command("gateway").description("Run, inspect, and query the WebSocket Gateway"),
);
addGatewayRunCommand(
  gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
);
```

**为什么这么做**：Gateway 是最高频、最在意启动延迟的命令。普通 CLI 路径要注册所有内置命令 + 扫描所有插件 CLI，开销大。fast-path 把这一切跳过。

**(5) 完整 CLI 路径**（`src/cli/run-main.ts:626-804`）。如果不是 gateway fast-path，才走完整流程：`tryRouteCli`（子 CLI 路由）→ `buildProgram()`（构建完整 Commander 程序）→ 注册全局错误处理器（`uncaughtException`/`unhandledRejection`）→ 按需注册 primary 命令和插件 CLI 命令 → `program.parseAsync()`。

`runCli` 的 `finally` 块（`src/cli/run-main.ts:805-819`）做收尾：停代理、释放 agent harness（`disposeCliAgentHarnesses`）、关闭 memory manager（`closeCliMemoryManagers`）、暂停非 TTY stdin。这些都是**为短命的 CLI 进程**准备的清理——CLI 命令跑完就退，不能留下悬挂的子进程或 SQLite 句柄。

### 4.4 阶段四与五：gateway 命令 → `server.impl.ts`

无论走 fast-path 还是完整路径，最终都进入 `src/cli/gateway-cli/run.ts`（`addGatewayRunCommand` 注册的命令处理函数）。它负责：

- 解析 `--port`（默认由 `resolveGatewayPort` 决定，`gateway-cli/run.ts:12`）、`--bind`、`--auth` 等选项。
- 设置 WS 日志风格（`setGatewayWsLogStyle`，`gateway-cli/run.ts:21-22`）、verbose 等运行期开关。
- 处理 `GatewayLockError`（`gateway-cli/run.ts:26`）——如果已有 Gateway 在跑，给出友好提示而非裸异常。

然后调用 `src/gateway/server.ts` 的 `startGatewayServer`。`server.ts` 本身极薄（仅 35 行），它的存在是为了**延迟加载** `server.impl.ts`（`src/gateway/server.ts:13-22` 的 `loadServerImpl`）：

```ts
async function loadServerImpl() {
  ...
  return await import("./server.impl.js");
}

export async function startGatewayServer(...args) {
  const mod = await loadServerImpl();
  return await mod.startGatewayServer(...args);
}
```

`server.impl.ts` 是一个 1687 行的大文件，包含全部 Gateway 启动逻辑。把它从 `server.ts` 拆出来、用动态 import 延迟加载，意味着「只是想查 Gateway 协议常量」的代码不必把整个启动实现拖进内存。`src/gateway/server.ts:4-11` 还在 import 边界打了一条 `gateway.server-impl-import` trace span——这条 span 经常是启动 trace 里最显眼的一段。

`server.impl.ts` 内部的完整启动序列（config 快照 → auth → 插件 bootstrap → runtime state → HTTP/WS 监听 → post-attach sidecars → ready）是**第 02 章**的核心内容，这里不展开。

### 4.5 启动链小结

把五个阶段串起来，一条 `openclaw gateway run` 的完整调用链是：

```
shell
  └─ node openclaw.mjs                    [纯 .mjs 启动器]
       │  Node 版本检查 + compile cache + (可能 respawn)
       └─ import dist/entry.js            [src/entry.ts]
            │  isMainModule 守卫 + argv 规范化 + profile/container
            └─ runMainOrRootHelp
                 └─ import dist/cli/run-main.js   [src/cli/run-main.ts]
                      │  runCli: 容器/profile/dotenv/代理
                      └─ gateway run fast-path  (或完整 Commander 路径)
                           └─ src/cli/gateway-cli/run.ts
                                │  解析 --port/--bind/--auth
                                └─ startGatewayServer  [src/gateway/server.ts]
                                     └─ import server.impl.js
                                          └─ startGatewayServer 实现
                                               [src/gateway/server.impl.ts]
                                               → HTTP/WS 监听端口 18789
```

整条链有三个反复出现的设计主题，记住它们能让你预测 OpenClaw 的代码风格：

1. **快速通道无处不在**：help、version、gateway run 都有专门的 fast-path，目的是压缩冷启动。
2. **动态 import 是常态**：`server.ts → server.impl.ts`、`run-main.ts` 里几十处 `await import(...)`，都是为了延迟加载。
3. **启动 trace 贯穿全链**：`entry.ts`、`run-main.ts`、`server.impl.ts` 各有一份 trace 工具，由 `OPENCLAW_GATEWAY_STARTUP_TRACE` 统一开关。

---

## 5. 技术栈

| 维度 | 选型 | 出处 / 说明 |
|------|------|------------|
| 运行时 | Node.js ≥ 22.16 | `openclaw.mjs:11-13`；用到 compile cache 等 Node 22 新 API |
| 语言 | TypeScript | `VISION.md:100-104` 解释「编排系统选 TS」；`tsconfig.json` 等多份 tsconfig |
| 包管理 | pnpm workspaces | `pnpm-workspace.yaml`；`nodeLinker: hoisted`（`:45`） |
| 核心构建 | tsdown | `tsdown.config.ts`；`package.json:1367` 的 `tsdown-build.mjs` |
| UI 构建 | Vite | `ui/vite.config.ts` |
| 测试 | Vitest | `vitest.config.ts`；`package.json` 里有 `test:fast`、`test:gateway`、`test:e2e` 等几十个分片配置 |
| 代码检查 | oxlint + oxfmt | `.oxlintrc.json`、`.oxfmtrc.jsonc` |
| 协议 schema | TypeBox + Ajv | `src/gateway/protocol/schema/frames.ts:1`（`import { Type } from "typebox"`）；`protocol/index.ts:1`（Ajv） |

几个值得展开的点：

- **pnpm 的 `minimumReleaseAge: 2880`**（`pnpm-workspace.yaml:7`）：依赖发布后至少 2880 分钟（48 小时）才允许被装，这是一道**供应链安全防线**——防止刚发布的恶意版本被立即引入。`minimumReleaseAgeExclude`（`:9-43`）列出豁免包。
- **大量 `overrides`**（`pnpm-workspace.yaml:48-73`）：钉死 `@anthropic-ai/sdk`、`hono`、`axios`、`tar` 等关键依赖的精确版本。对一个安全敏感、深度集成多家 SDK 的项目，这是必要的纪律。
- **`build` 脚本是一长串步骤**（`package.json:1367`）：`tsdown-build` → 检查 CLI bootstrap import → runtime postbuild → 构建插件资源 → 写各种元数据（其中就包括启动器要读的 `cli-startup-metadata.json`）。构建产物的 `dist/` 是启动器的加载目标。

---

## 6. 后续章节导读

本章画的是骨架，接下来的章节逐层下钻：

- **第 02 章 Gateway 控制平面**：`server.impl.ts` 的完整启动序列、HTTP/WS 监听器如何建立、RPC 方法注册表（`methods/registry`）、WebSocket 连接生命周期、`server-chat-state` 内存注册表、`server-chat` 消息分发、`gateway/protocol/` 帧格式与协议版本。本章 §4.4 戛然而止的地方，第 02 章接着讲。
- **第 03 章及之后**：入站管线（`auto-reply/`）、会话与历史（`sessions/`）、出站投递（`auto-reply/reply/`）、agent harness 与运行循环（`agents/`）、插件加载器（`plugins/`）、渠道插件契约（`channels/`）等。

读后续章节时，随时回到本章 §3.1 的架构图和 §4.5 的启动链，确认自己「站在哪一层」。OpenClaw 代码量大、动态 import 多，但只要分层清晰，每个文件都能归位。
