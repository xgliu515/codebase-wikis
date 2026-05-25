## 代码布局与构建拓扑

NanoClaw 表面上是一个 Node.js + TypeScript 仓库，但实际上是 **两个相互独立的代码树**：

- **`src/`** — host 进程，在用户机器上长期运行的 Node + pnpm 项目。
- **`container/agent-runner/`** — 每个 session 容器里跑的 Bun 项目，独立 lockfile、独立 tsconfig、独立测试 runner。

两者 **不共享任何 npm 模块**，**不 import 对方任何文件**。它们的唯一通信表面是上一章讲的两个 SQLite 文件。这种"双 runtime 单仓库"的结构是 NanoClaw 最容易让人迷惑的地方 — 看到 `container/agent-runner/package.json` 时，你必须意识到它是另一个项目，而不是 host 工程的一部分。

这一章给你一张完整的 **导航图**，让你以后能快速定位"我要改的逻辑在哪个文件、哪些其他文件会被影响"。

---

### 1. 顶层目录扫描

`ls /` 给出的内容：

| 路径 | 类型 | 一句话用途 |
|------|------|------------|
| `src/` | 目录 | host 进程源码（Node + pnpm + better-sqlite3） |
| `container/` | 目录 | agent-runner（Bun）+ container skills + Dockerfile + build.sh + entrypoint.sh |
| `scripts/` | 目录 | 一次性脚本：`chat.ts`（CLI client）、`q.ts`（SQLite 通用查询）、`init-first-agent.ts`、`test-v2-*.ts` 等 |
| `setup/` | 目录 | 安装向导（`setup/index.ts`）+ `add-*.sh` channel 安装器 + `install-*.sh` 平台依赖安装 + `migrate-v2/` 迁移辅助 |
| `docs/` | 目录 | 权威架构文档：`architecture.md`、`db*.md`、`agent-runner-details.md`、`build-and-runtime.md`、`isolation-model.md` 等 |
| `groups/` | 目录 | 每个 agent group 的工作空间：`groups/<folder>/CLAUDE.md` + skills + `container.json`。trunk 自带 `global/` 和 `main/` 两个 |
| `launchd/` | 目录 | macOS launchd plist 模板 (`com.nanoclaw.plist`)。Linux systemd unit 在 `setup/` 下生成 |
| `config-examples/` | 目录 | `mount-allowlist.json` 等示例配置文件 |
| `.claude/` | 目录 | host 自己用的 Claude 配置：`settings.json`、自定义 skills、`scheduled_tasks.lock` |
| `assets/` | 目录 | logo、favicon、splash 文本 |
| `bin/` | 目录 | 可执行 shell wrapper：`bin/ncl` — admin CLI 入口（实际逻辑在 `src/cli/`） |
| `repo-tokens/` | 目录 | repo-level token 缓存（GitHub workflow `update-tokens.yml` 维护） |
| `migrate-v2.sh` | 脚本 | v1→v2 迁移入口（**只在外部 shell 执行**，不要在 Claude Code 内跑） |
| `migrate-v2-reset.sh` | 脚本 | 迁移失败时的回滚 |
| `nanoclaw.sh` | 脚本 | 启动/停止/状态 wrapper（封装 launchd/systemd） |
| `setup.sh` | 脚本 | 首次安装入口 (`bash setup.sh` 跑 `setup/index.ts`) |
| `package.json` | 配置 | host 的 pnpm package；`packageManager: pnpm@10.33.0`；`type: module`（ESM） |
| `pnpm-workspace.yaml` | 配置 | **关键**：声明 `minimumReleaseAge: 4320` 和 `onlyBuiltDependencies` 白名单 |
| `pnpm-lock.yaml` | 锁文件 | host 依赖 lockfile，CI 用 `--frozen-lockfile` |
| `tsconfig.json` | 配置 | host TypeScript 配置 |
| `vitest.config.ts` | 配置 | host 测试 runner — **排除 `container/agent-runner/`** |
| `vitest.skills.config.ts` | 配置 | skill 内带测试时用的 vitest 配置 |
| `eslint.config.js` | 配置 | host ESLint flat config |
| `.prettierrc` | 配置 | 共享 prettier（120 字符宽） |
| `.husky/` | 目录 | git hook（pre-commit prettier check） |
| `.mcp.json` | 配置 | 本仓库本身作为 Claude Code 项目时用的 MCP 注册 |
| `.npmrc` | 配置 | npm 行为：禁 publish 之类 |
| `.nvmrc` | 配置 | 指定 Node 版本（`>=20`，实际推荐 22） |
| `.env.example` | 模板 | `.env` 模板（trunk 上是空文件，channel skill 安装后会追加内容） |
| `.github/` | 目录 | CI workflow、PR 模板、CODEOWNERS |
| `CLAUDE.md` | 文档 | **入口文档**。所有 Claude session 启动时都会读它，包含 Quick Context + Key Files + gotcha 索引 |
| `CHANGELOG.md` | 文档 | 每个版本的变更 |
| `CONTRIBUTING.md` | 文档 | 贡献规范，**写新 skill 前必读** |
| `README.md` / `README_zh.md` / `README_ja.md` | 文档 | 三语 README |
| `RELEASING.md` | 文档 | 发版流程 |
| `CODE_OF_CONDUCT.md` / `CONTRIBUTORS.md` / `LICENSE` | 文档 | 标准 OSS 文件 |

请注意 **`dist/`、`node_modules/`、`logs/`、`data/`** 在 trunk 里都被 `.gitignore`，运行时才会出现。`data/` 下面就是上一章讲的中央 DB + session DB；`logs/` 下面是 `nanoclaw.log` / `nanoclaw.error.log` / `setup-steps/*.log`。

---

### 2. `src/` host 源码树

host 进程的所有 TypeScript 都在 `src/` 下面。一共约 40 多个顶层 `.ts` 文件 + 6 个子目录。

按职责分组（每个文件一两句话，加 `wc -l` 行数大致表示复杂度）：

#### 2.1 核心 orchestration

| 文件 | 行数 | 用途 |
|------|------|------|
| `src/index.ts` | 213 | host 入口。`main()` 按顺序：circuit breaker → init DB → run migrations → backfill → container runtime → channel adapters → delivery polls → host sweep → CLI socket server |
| `src/router.ts` | 496 | 入站路由的主体。`routeInbound()` 解析 messaging group、fan-out 到 wired agents、调 access gate、写 inbound.db、`wakeContainer()` |
| `src/delivery.ts` | 430 | 出站投递。`startActiveDeliveryPoll()` 1 秒一次、`startSweepDeliveryPoll()` 60 秒一次，把 outbound.db 里 undelivered 行交给 channel adapter |
| `src/host-sweep.ts` | 328 | 60 秒周期维护：sync processing_ack、stale 检测、due-message wake、recurrence 推进 |
| `src/session-manager.ts` | 543 | 解析/创建 session、管理 session folder、open/close 两个 session DB、写 destination/routing 投影 |
| `src/container-runner.ts` | 515 | 拼装 docker/apple-container 启动命令；mount 编排；`ensureAgent` 调 OneCLI；`killContainer` 带 `onExit` 回调 |
| `src/container-runtime.ts` | 116 | 运行时选择（Docker vs Apple Container）+ orphan 容器清理 |

这 7 个文件是 host 真正的脊柱。`src/index.ts` 是最薄的 — 它只 wire 不做业务。所有业务都在其他 6 个文件里。

#### 2.2 访问控制 / approvals / 用户管理

| 文件 | 行数 | 用途 |
|------|------|------|
| `src/command-gate.ts` | 73 | router 侧的 slash 命令分类器：whitelist / admin-only / filter。查 `user_roles` 判断 admin |
| `src/group-folder.ts` | 51 | agent group 目录名安全检查 |
| `src/group-init.ts` | 145 | 给新 agent group 创建 `groups/<folder>/` 骨架（CLAUDE.md、skills、agent-runner-src overlay） |
| `src/claude-md-compose.ts` | 234 | 把共享 base + 各模块 fragment + 用户 CLAUDE.md 合成最终注入 agent 的 system prompt |
| `src/install-slug.ts` | 56 | 派生 image tag slug（同机两个 install 不冲突） |

#### 2.3 工具 / 配置 / 类型

| 文件 | 行数 | 用途 |
|------|------|------|
| `src/config.ts` | 130 | `DATA_DIR`、`GROUPS_DIR`、`MAX_CONCURRENT_CONTAINERS` 等共享常量 |
| `src/env.ts` | 44 | `.env` 加载（dotenv 风格） |
| `src/log.ts` | 79 | 单行 JSON 日志器：`log.info(msg, fields)` |
| `src/types.ts` | 197 | 全 host TypeScript 接口集中地：`Session`、`AgentGroup`、`MessagingGroup`、`MessagingGroupAgent`、`InboundEvent` 等 |
| `src/container-config.ts` | 96 | 把 DB 里 `container_configs` 行转成 `ContainerConfig` 对象 |
| `src/backfill-container-configs.ts` | 84 | 启动时把 legacy `container.json` 文件迁进 `container_configs` 表 |
| `src/container-restart.ts` | 64 | `restartGroupContainers()`：kill + 可选 on_wake message + 通过 `onExit` 回调重启 |
| `src/response-registry.ts` | 51 | 跨模块的 response handler / shutdown callback 注册器。**单独抽出来是为了打破循环 import**（`src/index.ts` import modules，modules 调 register） |
| `src/circuit-breaker.ts` | 100 | 启动 backoff：发现近期 N 次启动都 crash 就退避，防止 launchd 拼命重启 |
| `src/attachment-naming.ts` + `.test.ts` | 99 + 97 | 决定附件落盘文件名（带 dedup） |
| `src/attachment-safety.ts` | 35 | 防 path traversal 的文件名校验 |
| `src/platform-id.ts` | 38 | platform_id 字符串拆解辅助 |
| `src/timezone.ts` + `.test.ts` | 30 + 79 | 时区解析与 ISO 时间戳格式化 |
| `src/state-sqlite.ts` | 213 | Chat SDK 的 `SqliteStateAdapter` 实现（中央 DB 里 `chat_sdk_*` 表的封装） |
| `src/webhook-server.ts` | 145 | 通用 webhook HTTP 服务器（被 channel adapter 用） |

#### 2.4 子目录

| 子目录 | 文件数 | 内容 |
|--------|--------|------|
| `src/db/` | 12 | DB 访问层：每个 entity 一个文件（`agent-groups.ts`、`messaging-groups.ts`、`sessions.ts`、`container-configs.ts`、`session-db.ts`、`dropped-messages.ts`），`schema.ts` 是当前 schema 的权威 reference，`connection.ts` 是中央 DB 单例 |
| `src/db/migrations/` | 14 | numbered migration 文件 + `index.ts` runner。详见第 3 章 |
| `src/channels/` | 8 | channel framework（**不是** Discord/Slack 等具体 adapter）：`adapter.ts`（接口）、`channel-registry.ts`（self-registration 注册表）、`chat-sdk-bridge.ts`（Chat SDK 通用桥）、`cli.ts`（trunk 自带的本地 CLI channel）、`ask-question.ts` |
| `src/providers/` | 3 | host 侧的 provider 容器配置注册器：`claude.ts`（trunk 自带）、`index.ts` barrel、`provider-container-registry.ts` |
| `src/modules/` | 9 子目录 | 可插拔模块：`typing/`、`approvals/`、`permissions/`、`self-mod/`、`scheduling/`、`agent-to-agent/`、`interactive/`、`mount-security/`。每个有自己的 `index.ts` 完成 self-registration |
| `src/cli/` | 15 文件 + 2 子目录 | `ncl` admin CLI 实现：`socket-server.ts`（host 侧 Unix socket）、`socket-client.ts`、`client.ts`（pnpm exec 入口）、`dispatch.ts`（命令分发 + 容器侧 transport）、`crud.ts`（generic CRUD registrar）、`resources/`（每种 resource 一个文件）、`commands/`（slash 命令实现） |

#### 2.5 测试文件

host 的测试文件和被测代码 **同目录同前缀**，约定为 `<file>.test.ts`：

- `src/host-core.test.ts`（1100 行）— 整合测试。**这个文件最适合用来逆向理解 host 行为**：每个测试用 in-memory DB + mock adapter 描述一个完整场景。
- `src/host-sweep.test.ts`、`src/delivery.test.ts`、`src/container-runner.test.ts` 等单元测试散布在各处。
- `src/db/db-v2.test.ts`、`src/db/session-db.test.ts` — DB 层测试。

测试 runner 用 vitest，由根目录 `vitest.config.ts` 配置 — **关键**它的 `include` glob 不含 `container/agent-runner/`，否则会因为 `bun:sqlite` 导入失败而炸。

---

### 3. `container/` 树

容器侧的所有东西：

| 路径 | 用途 |
|------|------|
| `container/Dockerfile` | 单阶段 build，基于 `node:22-slim`。装系统包（chromium、tini、git）、Bun、agent-runner 依赖、pnpm + global Node CLI（`@anthropic-ai/claude-code`、`agent-browser`、`vercel`）、entrypoint。**不烤代码** — 代码在运行时由 host 把 `container/agent-runner/src/` bind-mount 到 `/app/src` |
| `container/build.sh` | `docker build`（或 `container build`）的 wrapper。读 `.env` 里 `INSTALL_CJK_FONTS`，传成 build-arg。image tag 由 `install-slug.sh` 派生避免同机冲突 |
| `container/entrypoint.sh` | 容器 PID 1。`cat > /tmp/input.json` 吸收 stdin（host 用 v1 的 stdin pipe 启动时用，v2 host-spawned session 用 `--entrypoint bash` 绕过），然后 `exec bun run /app/src/index.ts < /tmp/input.json` |
| `container/CLAUDE.md` | 容器侧的 system prompt 共享 base，会被 mount 到 `/app/CLAUDE.md` |
| `container/.dockerignore` | 排除 `node_modules` 等 |

#### 3.1 `container/agent-runner/` — Bun 独立项目

| 路径 | 用途 |
|------|------|
| `container/agent-runner/package.json` | Bun 项目：`@anthropic-ai/claude-agent-sdk@^0.2.128`、`@modelcontextprotocol/sdk@^1.12.1`、`cron-parser`、`zod`。devDeps: `@types/bun`、TypeScript。**只在 `cd container/agent-runner && bun install` 时维护，不要在根目录跑 pnpm install** |
| `container/agent-runner/bun.lock` | Bun lockfile，独立于 host 的 `pnpm-lock.yaml` |
| `container/agent-runner/tsconfig.json` | 独立 tsconfig：`target: ES2022`、`module: NodeNext`、`types: ['bun']`、`rootDir: ./src` |
| `container/agent-runner/scripts/sdk-signal-probe.ts` | 调试用 — 检查 Claude SDK 信号处理 |

`container/agent-runner/src/` 下面（约 20 个 ts 文件 + 4 个子目录）：

| 文件 | 行数 | 用途 |
|------|------|------|
| `src/index.ts` | 109 | 容器入口。`loadConfig()` → `createProvider()` → `runPollLoop()` |
| `src/config.ts` | 49 | 从 `/workspace/agent/container.json` 读 per-group config |
| `src/poll-loop.ts` | 518 | **核心循环**。每秒 SELECT pending messages_in，转 processing，调 provider，写 messages_out，touch heartbeat |
| `src/formatter.ts` | 279 | 把 messages_in 多条行合并成一个 `<messages>` XML block；按 kind 分别格式化 |
| `src/current-batch.ts` | 30 | 当前批次状态 |
| `src/destinations.ts` | 137 | 从本地 inbound.db 投影读取 destinations，建 system prompt addendum |
| `src/compact-instructions.ts` | 41 | PreCompact hook 用的 archive instructions |
| `src/timezone.ts` | 95 | 容器侧时区辅助 |
| `src/db/` | 7 文件 | 容器侧 DB 访问层。`connection.ts`（两个 Database 单例 + heartbeat）、`messages-in.ts`、`messages-out.ts`、`session-routing.ts`、`session-state.ts` |
| `src/mcp-tools/` | 14 文件 | MCP server + 工具实现：`server.ts`（stdio MCP server）、`core.ts`（send_message、send_file、edit、reaction）、`scheduling.ts`、`interactive.ts`、`agents.ts`、`self-mod.ts`、`cli.ts`。每个 tool 类别有对应的 `.instructions.md` 让 agent 知道怎么用 |
| `src/providers/` | 7 文件 | provider 抽象：`types.ts`（接口）、`factory.ts`、`provider-registry.ts`、`claude.ts`（唯一在 trunk 的真 provider）、`mock.ts`（测试用）、`index.ts` barrel |
| `src/scheduling/` | 1 文件 | recurring task 的 cron 调度辅助 |
| `src/cli/` | 1 文件 | 容器内的 `ncl` 客户端 — 通过 session DB transport 和 host CLI server 通信 |

最重要的两条不变量（详见 `container/agent-runner/src/db/connection.ts` 顶部 19 行注释）：

1. **inbound.db 必须是 `journal_mode = DELETE`**。WAL 的 `-shm` 不跨 VirtioFS。容器开的 readonly handle 会冻在第一次读到的快照，永远看不到 host 新写的消息。
2. **bun:sqlite 的 named param 不去前缀**。`db.prepare("INSERT ... VALUES ($id)").run({ $id: msg.id })` — JS key 上的 `$` 不能省。better-sqlite3 在 host 上是自动剥的，bun:sqlite 不是。

#### 3.2 `container/skills/` — 容器内 mounted skills

这些 skill **不是** host 的 `/add-discord` 那种安装 skill，它们是 **agent 在容器内执行时可以加载的 skill**，每个 session 容器都会 bind-mount 整个 `container/skills/`。

| Skill 目录 | 作用 |
|------------|------|
| `container/skills/onecli-gateway/` | 教 agent 如何通过 OneCLI proxy 使用凭证；如何处理 401 错误；何时不要问用户要 raw token |
| `container/skills/welcome/` | 第一次启动新 agent group 时的欢迎流程 |
| `container/skills/self-customize/` | 引导 agent 修改自己的 CLAUDE.md / skills |
| `container/skills/agent-browser/` | `agent-browser` CLI 工具的使用指南 |
| `container/skills/slack-formatting/` | Slack mrkdwn / Block Kit 格式化规则 |
| `container/skills/vercel-cli/` | `vercel` CLI 使用指南 |
| `container/skills/frontend-engineer/` | 前端工程辅助 |

每个 skill 目录里有 `SKILL.md`（agent 看的指令）+ 可能的代码文件。

---

### 4. 构建拓扑 — 双 runtime 的运作方式

`docs/build-and-runtime.md` 是这部分的权威文档。摘要：

#### 4.1 为什么 host 用 Node，container 用 Bun？

- **host 留在 Node**：因为 Baileys（WhatsApp adapter）依赖 `libsignal-node` 的原生绑定，加上一个成熟的 WebSocket/HTTP 栈。Bun 的 Node-API 兼容近年改善很多，但 host 不是冒险的好地方。
- **container 用 Bun**：
  - `bun:sqlite` 是 built-in，不用每次 image rebuild 编译 `better-sqlite3` 的原生模块；
  - Bun 直接跑 TypeScript，不需要 `tsc` build step（v1 时代每次 session wake 要花 200-500ms 编译）；
  - `bun install` 比 `npm install` 快 5-10 倍 — agent-runner deps 改动后镜像 rebuild 明显快；
  - **同时 image 里也有 pnpm + Node**，因为 `@anthropic-ai/claude-code`、`agent-browser`、`vercel` 是 Node CLI，要 pnpm global install 保持 supply chain 政策。

#### 4.2 两份 lockfile，井水不犯河水

<svg viewBox="0 0 820 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Two runtimes two lockfiles split between host (Node + pnpm) and container (Bun)">
  <defs>
    <marker id="ar-r21" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="20" y="30" width="380" height="270" rx="8" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.5"/>
  <text x="210" y="56" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">HOST · Node 22 + pnpm 10.33.0</text>
  <text x="210" y="74" text-anchor="middle" font-size="10" fill="#64748b">long-running daemon · launchd / systemd</text>
  <rect x="40" y="90" width="340" height="46" rx="4" fill="#ffffff" stroke="#0d9488" stroke-width="1"/>
  <text x="55" y="110" font-size="11" font-weight="600" fill="currentColor">package.json</text>
  <text x="55" y="126" font-size="10" fill="#64748b">host pkg definition (root)</text>
  <rect x="40" y="146" width="340" height="46" rx="4" fill="#ffffff" stroke="#0d9488" stroke-width="1"/>
  <text x="55" y="166" font-size="11" font-weight="600" fill="currentColor">pnpm-lock.yaml</text>
  <text x="55" y="182" font-size="10" fill="#64748b">better-sqlite3 · chat-sdk · @onecli-sh/sdk · @clack/*</text>
  <rect x="40" y="202" width="340" height="46" rx="4" fill="#ffffff" stroke="#0d9488" stroke-width="1"/>
  <text x="55" y="222" font-size="11" font-weight="600" fill="currentColor">pnpm-workspace.yaml</text>
  <text x="55" y="238" font-size="10" fill="#64748b">minimumReleaseAge: 4320 · onlyBuiltDependencies</text>
  <text x="210" y="278" text-anchor="middle" font-size="10" fill="#64748b">cmd: pnpm install --frozen-lockfile</text>
  <rect x="420" y="30" width="380" height="270" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/>
  <text x="610" y="56" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">CONTAINER · Bun 1.3.12</text>
  <text x="610" y="74" text-anchor="middle" font-size="10" fill="#64748b">per-session ephemeral · runs TS directly</text>
  <rect x="440" y="90" width="340" height="46" rx="4" fill="#ffffff" stroke="#ea580c" stroke-width="1"/>
  <text x="455" y="110" font-size="11" font-weight="600" fill="currentColor">package.json</text>
  <text x="455" y="126" font-size="10" fill="#64748b">container/agent-runner/ pkg definition</text>
  <rect x="440" y="146" width="340" height="46" rx="4" fill="#ffffff" stroke="#ea580c" stroke-width="1"/>
  <text x="455" y="166" font-size="11" font-weight="600" fill="currentColor">bun.lock</text>
  <text x="455" y="182" font-size="10" fill="#64748b">claude-agent-sdk · mcp/sdk · zod · cron-parser</text>
  <rect x="440" y="202" width="340" height="46" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <text x="455" y="222" font-size="11" font-weight="600" fill="#64748b">(no workspace file)</text>
  <text x="455" y="238" font-size="10" fill="#94a3b8">Bun has no minimumReleaseAge — manual review required</text>
  <text x="610" y="278" text-anchor="middle" font-size="10" fill="#64748b">cmd: cd container/agent-runner &amp;&amp; bun install --frozen-lockfile</text>
  <text x="410" y="316" text-anchor="middle" font-size="10" fill="#94a3b8">two lockfiles · zero shared modules · no cross-import</text>
</svg>
<span class="figure-caption">图 R2.1 ｜ host 与 container 两套独立 runtime + lockfile：井水不犯河水</span>

<details>
<summary>ASCII 原版</summary>

```
/                                                Node 22 + pnpm 10.33.0
  package.json                                   host pkg 定义
  pnpm-lock.yaml                                 host deps（better-sqlite3、chat、cron-parser、@onecli-sh/sdk、@clack/* 等）
  pnpm-workspace.yaml                            supply chain 政策（见 §5）

/container/agent-runner/                         Bun 1.3.12
  package.json                                   agent-runner pkg 定义
  bun.lock                                       agent-runner runtime deps（claude-agent-sdk、mcp/sdk、zod、cron-parser）
```

</details>

| 变更场景 | 操作 |
|----------|------|
| 改 host 依赖 | 根目录跑 `pnpm install`（更新 `pnpm-lock.yaml`） |
| 改 agent-runner 依赖 | `cd container/agent-runner && bun install`（更新 `bun.lock`） |
| 升 `@anthropic-ai/claude-agent-sdk` | 改 `container/agent-runner/package.json`，跑 `bun install`，**手工查发布日期再选版本**（Bun 没有 minimumReleaseAge） |
| 升 host 上的 `better-sqlite3` | 改根 `package.json`，跑 `pnpm install`；**注意要进 `onlyBuiltDependencies` 白名单才会跑 native build** |

CI 和 Dockerfile 都用 `--frozen-lockfile`，lockfile 漂移会 fail build。

#### 4.3 Image build surface

`container/Dockerfile` 是单阶段 build。要点：

- **pinned ARGs**：`BUN_VERSION=1.3.12`、`CLAUDE_CODE_VERSION=2.1.128`、`AGENT_BROWSER_VERSION=latest`、`VERCEL_VERSION=52.2.1`、`PNPM_VERSION=10.33.0`。任何升级都要在 PR 里显式 bump。
- **`ARG INSTALL_CJK_FONTS=false`**：默认不装 CJK 字体省 ~200MB。`container/build.sh` 从 `.env` 读这个变量传 build-arg。需要中文/日文/韩文渲染（截图、PDF、抓网页）时打开。
- **BuildKit cache mounts**：`/var/cache/apt`、`/var/lib/apt`、`/root/.bun/install/cache`、`/root/.cache/pnpm` 都 cache 了。增量 build 很快。
- **`tini` 是 PID 1**：reap chromium 僵尸进程；SIGTERM 时正确转发，让 in-flight 的 outbound.db 写有时间 finalize。
- **没有 `/app/dist`**：Bun 直接跑 TS。**永远不要重新引入 tsc build step**。
- **source code 是运行时 mount 进来的**：`src/container-runner.ts:314` 把 host 的 `container/agent-runner/src` bind-mount 到容器的 `/app/src` (RO)。**改 host 源代码不需要 rebuild image**，下次 session wake 就生效。

#### 4.4 Session wake 的两条路径

镜像 ENTRYPOINT 是 `tini -- /app/entrypoint.sh`，而 `entrypoint.sh` 干的是 `cat > /tmp/input.json` 再 `exec bun run /app/src/index.ts < /tmp/input.json`。这条路只在用 stdin 给镜像喂 prompt 时用（`container/build.sh` 末尾的测试样例），实战中 host 启 session 不走它。

`src/container-runner.ts:~301` 调 `docker run --entrypoint bash ... -c 'exec bun run /app/src/index.ts'`，**绕开 tini 和 entrypoint.sh**。stdin 完全不用 — 一切走 mount 进来的 inbound.db / outbound.db。

两条路最终都到 `bun run /app/src/index.ts`。

---

### 5. pnpm supply chain 政策

`pnpm-workspace.yaml` 全文 7 行，但每行都有故事：

```yaml
onlyBuiltDependencies:
  - better-sqlite3
  - esbuild
  - protobufjs
  - sharp

pnpm:
  minimumReleaseAge: 4320
```

#### 5.1 `minimumReleaseAge: 4320`

单位是 **分钟**。`4320 / 60 = 72 小时 = 3 天`。意思是：**任何新发布的 npm 包版本，要在 registry 上呆够 3 天 pnpm 才会 resolve 它**。

为什么 3 天？

- 大部分供应链攻击（恶意 maintainer 发版、被入侵账号发版、typosquatting）在 72 小时内会被发现、被 deprecated 或被 unpublish。
- 给 npm registry 团队和社区一个反应窗口。
- 对开发体验影响很小 — 你正常升包不会想升昨天才发布的版本。

`CLAUDE.md:270-273` 明确写了 **rules**：

> **`minimumReleaseAgeExclude`**: Never add entries without human sign-off. If a package must bypass the release age gate, the human must approve and the entry must pin the exact version being excluded (e.g. `package@1.2.3`), never a range.
> **`onlyBuiltDependencies`**: Never add packages to this list without human approval — build scripts execute arbitrary code during install.

意思：

- **永远不要绕 minimumReleaseAge**，除非有非常具体的版本号绑定且有人 approve。
- **永远不要往 `onlyBuiltDependencies` 加包**，除非有人 approve — postinstall script 是可以跑任意代码的入口。

#### 5.2 `onlyBuiltDependencies` 白名单

pnpm 默认 **拒绝执行任何包的 postinstall script**，除非显式列入这个白名单。当前只有 4 个：

- `better-sqlite3` — 要编译原生 `.node` 文件
- `esbuild` — 要安装平台二进制
- `protobufjs` — 要生成代码
- `sharp` — 要编译图像处理库

任何其他试图跑 postinstall 的依赖都会被 pnpm 静默跳过；如果包真的需要 postinstall 才能工作（如 puppeteer 下载 Chromium），它会在运行时报错，**而不是在安装时偷偷跑代码**。

这是 NanoClaw 比一般 Node 项目更保守的地方。

#### 5.3 在 CI 和容器 build 里用 `--frozen-lockfile`

任何自动化（CI、Dockerfile、setup script）都不能跑裸 `pnpm install` — 必须 `pnpm install --frozen-lockfile`，否则 lockfile 漂移就藏过去了。

Bun 这边没有 minimumReleaseAge 等价物。`docs/build-and-runtime.md:35` 明确说：**升 agent-runner deps 要手动看发布日期，不要 `bun update`**。

---

### 6. Sibling branches — channels 和 providers

第 1 章提到 trunk 里没有 Discord、Slack 等具体 channel adapter，也没有 OpenCode provider。它们住在两个长存的 sibling branch：

<svg viewBox="0 0 860 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Trunk vs channels and providers sibling branches: idempotent skill checkout into trunk">
  <defs>
    <marker id="ar-r22" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="20" y="30" width="240" height="320" rx="8" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.5"/>
  <text x="140" y="54" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">trunk (main)</text>
  <text x="140" y="72" text-anchor="middle" font-size="10" fill="#64748b">framework only</text>
  <rect x="36" y="86" width="208" height="120" rx="4" fill="#ffffff" stroke="#0d9488" stroke-width="1"/>
  <text x="46" y="104" font-size="10" font-weight="600" fill="currentColor">src/channels/</text>
  <text x="56" y="122" font-size="10" fill="#64748b">adapter.ts</text>
  <text x="56" y="138" font-size="10" fill="#64748b">channel-registry.ts</text>
  <text x="56" y="154" font-size="10" fill="#64748b">chat-sdk-bridge.ts</text>
  <text x="56" y="170" font-size="10" fill="#ea580c">cli.ts</text>
  <text x="56" y="186" font-size="10" fill="#64748b">index.ts → import './cli.js'</text>
  <rect x="36" y="218" width="208" height="80" rx="4" fill="#ffffff" stroke="#0d9488" stroke-width="1"/>
  <text x="46" y="236" font-size="10" font-weight="600" fill="currentColor">container/agent-runner/</text>
  <text x="46" y="252" font-size="10" font-weight="600" fill="currentColor">src/providers/</text>
  <text x="56" y="268" font-size="10" fill="#ea580c">claude.ts (sole)</text>
  <text x="56" y="284" font-size="10" fill="#64748b">factory.ts · registry.ts</text>
  <text x="140" y="328" text-anchor="middle" font-size="10" fill="#64748b">trunk ships:</text>
  <text x="140" y="343" text-anchor="middle" font-size="10" fill="#64748b">1 channel · 1 provider</text>
  <rect x="310" y="30" width="240" height="320" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/>
  <text x="430" y="54" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">channels branch</text>
  <text x="430" y="72" text-anchor="middle" font-size="10" fill="#64748b">channel adapters</text>
  <rect x="326" y="86" width="208" height="240" rx="4" fill="#ffffff" stroke="#ea580c" stroke-width="1"/>
  <text x="336" y="104" font-size="10" font-weight="600" fill="currentColor">src/channels/</text>
  <text x="346" y="120" font-size="10" fill="#64748b">discord.ts</text>
  <text x="346" y="136" font-size="10" fill="#64748b">slack.ts</text>
  <text x="346" y="152" font-size="10" fill="#64748b">telegram.ts</text>
  <text x="346" y="168" font-size="10" fill="#64748b">whatsapp.ts</text>
  <text x="346" y="184" font-size="10" fill="#64748b">teams.ts · linear.ts</text>
  <text x="346" y="200" font-size="10" fill="#64748b">github.ts · imessage.ts</text>
  <text x="346" y="216" font-size="10" fill="#64748b">webex.ts · resend.ts</text>
  <text x="346" y="232" font-size="10" fill="#64748b">matrix.ts · google-chat.ts</text>
  <text x="346" y="248" font-size="10" fill="#64748b">whatsapp-cloud.ts</text>
  <text x="346" y="270" font-size="10" fill="#94a3b8">+ helpers · tests</text>
  <text x="430" y="316" text-anchor="middle" font-size="10" fill="#94a3b8">/add-discord · /add-slack · ...</text>
  <rect x="600" y="30" width="240" height="320" rx="8" fill="#f3e8ff" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="720" y="54" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">providers branch</text>
  <text x="720" y="72" text-anchor="middle" font-size="10" fill="#64748b">non-default providers</text>
  <rect x="616" y="86" width="208" height="80" rx="4" fill="#ffffff" stroke="#7c3aed" stroke-width="1"/>
  <text x="626" y="104" font-size="10" font-weight="600" fill="currentColor">container/agent-runner/</text>
  <text x="626" y="120" font-size="10" font-weight="600" fill="currentColor">src/providers/</text>
  <text x="636" y="136" font-size="10" fill="#64748b">opencode.ts</text>
  <text x="636" y="152" font-size="10" fill="#94a3b8">+= import './opencode.js'</text>
  <rect x="616" y="178" width="208" height="60" rx="4" fill="#ffffff" stroke="#7c3aed" stroke-width="1"/>
  <text x="626" y="196" font-size="10" font-weight="600" fill="currentColor">src/providers/</text>
  <text x="636" y="214" font-size="10" fill="#64748b">opencode.ts</text>
  <text x="636" y="228" font-size="10" fill="#94a3b8">host-side container config</text>
  <text x="720" y="316" text-anchor="middle" font-size="10" fill="#94a3b8">/add-opencode</text>
  <line x1="430" y1="350" x2="260" y2="280" stroke="#ea580c" stroke-width="1.2" stroke-dasharray="4,3" marker-end="url(#ar-r22)"/>
  <text x="345" y="370" text-anchor="middle" font-size="10" fill="#ea580c">git checkout (idempotent)</text>
  <line x1="720" y1="350" x2="260" y2="300" stroke="#7c3aed" stroke-width="1.2" stroke-dasharray="4,3" marker-end="url(#ar-r22)"/>
</svg>
<span class="figure-caption">图 R2.2 ｜ trunk 只含 framework + 默认实现；channel/provider 住 sibling 分支，/add-X skill 幂等 checkout 进 trunk</span>

<details>
<summary>ASCII 原版</summary>

```
trunk (main)             channels branch                  providers branch
  src/channels/            src/channels/                    container/agent-runner/src/providers/
    adapter.ts               discord.ts                       opencode.ts
    channel-registry.ts      slack.ts                       container/agent-runner/src/providers/index.ts
    chat-sdk-bridge.ts       telegram.ts                       += import './opencode.js';
    cli.ts                   whatsapp.ts                    src/providers/
    index.ts                 teams.ts                         opencode.ts (container-side host config)
                             linear.ts
                             github.ts
                             imessage.ts
                             webex.ts
                             resend.ts
                             matrix.ts
                             google-chat.ts
                             whatsapp-cloud.ts
                             ... + helpers, tests
```

</details>

每个 `/add-<name>` skill 是 **幂等** 的 5 步：

1. `git fetch origin channels`（或 `providers`）
2. `git checkout origin/channels -- src/channels/<name>.ts`（+ 相关 helper）
3. 在 `src/channels/index.ts` 末尾追加一行 `import './<name>.js';`
4. `pnpm install <pkg>@<pinned-version>`（往 `package.json` + lockfile 加运行时依赖）
5. `pnpm run build`（host）和/或 `./container/build.sh`（如果改了容器）

幂等是关键 — 重复跑同一个 skill 不会出错。`src/channels/index.ts` 的追加行用 grep 检测是否已存在；`pnpm install` 自然幂等；`git checkout` 重覆盖不报错。

这种结构带来的实际效果：**在 trunk 上做修改不需要担心冲突所有 channel adapter**。修 `src/channels/adapter.ts` 接口才会影响所有 adapter；修单个 adapter（如要在 `discord.ts` 里加 button 支持）就在 `channels` 分支上做。

---

### 7. 测试拓扑

| 项目 | 测试 runner | 命令 | 测试位置 |
|------|-------------|------|----------|
| host (`src/`、`setup/`、`scripts/`) | vitest 4 | `pnpm test` 或 `pnpm exec vitest run` | `**/*.test.ts`（include glob 见 `vitest.config.ts`） |
| container (`container/agent-runner/src/`) | **bun:test** | `cd container/agent-runner && bun test` | 同目录 `**/*.test.ts` |
| host typecheck | tsc | `pnpm exec tsc --noEmit` | `tsconfig.json` |
| container typecheck | tsc | `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` | `container/agent-runner/tsconfig.json` |
| 格式 | prettier | `pnpm run format:check` | `.prettierrc` |

**关键**：`vitest.config.ts:7` 的 `include` glob 只匹配 `src/`、`setup/`、`scripts/` — **不进 `container/agent-runner/`**。否则 vitest 跑 Node 加载不动 `bun:sqlite`，会爆 "Cannot find module 'bun:sqlite'"。

`container/agent-runner/` 下的 `*.test.ts` 必须 `import { test, expect } from 'bun:test'`，不要 `import { test } from 'vitest'`。

`.github/workflows/ci.yml` 把这套依次跑一遍：

```yaml
- run: pnpm install --frozen-lockfile
- run: bun install --frozen-lockfile          # in container/agent-runner
- run: pnpm run format:check
- run: pnpm exec tsc --noEmit                  # host typecheck
- run: pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
- run: pnpm exec vitest run                    # host tests
- run: bun test                                 # container tests (in container/agent-runner)
```

任何一步 fail 都阻挡 merge。

---

### 8. 服务管理

NanoClaw 不是 daemon — 它是个 long-running Node 进程，需要 OS 级 service manager 看着。

#### 8.1 macOS — launchd

模板 `launchd/com.nanoclaw.plist`：

```xml
<key>ProgramArguments</key>
<array>
  <string>{{NODE_PATH}}</string>
  <string>{{PROJECT_ROOT}}/dist/index.js</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>{{PROJECT_ROOT}}/logs/nanoclaw.log</string>
<key>StandardErrorPath</key><string>{{PROJECT_ROOT}}/logs/nanoclaw.error.log</string>
```

`{{NODE_PATH}}` / `{{PROJECT_ROOT}}` / `{{HOME}}` 是占位符，由 `setup/service.ts` 替换后写到 `~/Library/LaunchAgents/com.nanoclaw.plist`。

操作命令：

```bash
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart
```

#### 8.2 Linux — systemd user unit

在 `setup/` 下面通过 `install-*.sh` 派生（不在 trunk 当模板存）。操作：

```bash
systemctl --user start|stop|restart nanoclaw
```

#### 8.3 `nanoclaw.sh` wrapper

`nanoclaw.sh`（443 行）是个跨平台 wrapper，封装 launchd 和 systemd 的差异。常用子命令：

```
./nanoclaw.sh start          # 启动服务
./nanoclaw.sh stop
./nanoclaw.sh restart
./nanoclaw.sh status         # 检查 PID + heartbeat
./nanoclaw.sh logs           # tail -f logs/nanoclaw.log
./nanoclaw.sh logs error     # tail -f logs/nanoclaw.error.log
```

#### 8.4 service 与开发的关系

平时开发不需要走 launchd/systemd。直接：

```bash
pnpm run dev    # tsx src/index.ts，hot reload
```

只有发版给用户、或者 staging 自己 dogfood 时才装 service。`/setup` skill 引导用户走完这一切。

---

### 9. 一张定位地图

最后，给出一个"我要找 X，去哪个文件"的速查表：

| 我要... | 去这里 |
|---------|--------|
| 改入站路由逻辑（fan-out、engage_mode） | `src/router.ts` |
| 改出站投递逻辑（轮询、重试、typing） | `src/delivery.ts` |
| 改 stale 检测、heartbeat 判定 | `src/host-sweep.ts` |
| 改容器启动命令（mount、env、docker args） | `src/container-runner.ts` |
| 改 session 创建/folder 布局 | `src/session-manager.ts` |
| 改中央 DB schema | 加 `src/db/migrations/NNN-<name>.ts` 文件，更新 `src/db/schema.ts` |
| 改 session DB schema | 改 `src/db/schema.ts` 的 `INBOUND_SCHEMA` / `OUTBOUND_SCHEMA`，加一个 lazy migration helper |
| 改 agent 看到的 system prompt | `src/claude-md-compose.ts`（host 侧编排）+ `container/CLAUDE.md`（共享 base）+ `container/agent-runner/src/destinations.ts`（运行时 addendum） |
| 加 MCP tool | `container/agent-runner/src/mcp-tools/<category>.ts` + 同目录 `.instructions.md` |
| 加 channel adapter | **不要在 trunk 改**。去 `channels` 分支加 `src/channels/<name>.ts` 文件 |
| 加 provider | 去 `providers` 分支 |
| 加 module | `src/modules/<name>/index.ts`（注册钩子）+ `src/modules/index.ts` import 它 |
| 加 ncl resource | `src/cli/resources/<resource>.ts` + `src/cli/registry.ts` 注册 |
| 改 Dockerfile | `container/Dockerfile` + 必要时 `container/build.sh` |
| 改容器内的 poll loop / formatter | `container/agent-runner/src/poll-loop.ts` / `formatter.ts` |
| 改运行的 Bun 版本 | `container/Dockerfile` `ARG BUN_VERSION` |

---

### 10. 一句话总结

NanoClaw 是 **两个项目放在一个仓库**：

- `src/` 是 Node + pnpm 写的 host，长期运行，看 OS service manager 守着，包管理保守（3 天 release age + onlyBuiltDependencies 白名单），channel adapter 和 non-default provider 不在 trunk 而在 sibling branch，通过幂等 skill 安装。
- `container/agent-runner/` 是 Bun + 独立 lockfile 写的容器进程，直接跑 TS（不要 tsc），用 `bun:sqlite` 打开 host bind-mount 进来的 `/workspace/inbound.db`（RO）和 `/workspace/outbound.db`（RW）。

两者唯一的桥梁是上一章讲的两个 SQLite 文件，再加一个 `.heartbeat` 文件的 mtime。整个仓库就是为这条不变量服务的。
