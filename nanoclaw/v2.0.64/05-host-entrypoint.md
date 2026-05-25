本章把 `src/index.ts` 当作一份"启动剧本"来精读。Host 进程是 NanoClaw 的"心脏"——所有 channel 入站事件、所有 container 生命周期、所有 outbound 投递都从它的 `main()` 出发，又在它的 `shutdown()` 收束。理解这个文件就理解了 NanoClaw 的整体节奏。

## 5.1 这一章要回答的问题

读完本章你应该能够独立回答：

1. **`pnpm run dev` 之后到底发生了什么？** 进程从启动到 `NanoClaw running` 日志，依次跑了哪些步骤？
2. **为什么是这个顺序？** 比如 `runMigrations` 必须放在哪一步之前，又必须放在哪一步之后？换个位置会出什么事？
3. **DATA_DIR / GROUPS_DIR / 容器镜像 tag 这些路径与命名是怎么来的？** 一台机器上两份 NanoClaw 安装如何共存？
4. **`response-registry.ts` 为什么从 `index.ts` 里"剥"出来？** 它解决了什么循环 import 问题？
5. **SIGTERM 收到之后，host 是按什么顺序关掉自己的？** 哪些资源必须保证关闭？
6. **崩溃后再启动，host 怎么把上一次留下的"野" container 回收掉？**

整章的硬性参照锚点就是 [`src/index.ts:1-213`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/index.ts) 的 213 行——你可以把它当成一份目录，本章的每一节都对应它中的某几行。

## 5.2 启动顺序总图

先给一张 ASCII 概览，把 `main()` 的 7 个编号步骤画在时间轴上：

```
                          (process spawn)
                                 │
                                 ▼
   src/index.ts:67   ┌──────────────────────────┐
                     │ log.info('NanoClaw       │
                     │   starting')             │
                     └──────────────┬───────────┘
                                    │
   index.ts:70  0.   enforceStartupBackoff()        ── 崩溃回路熔断器
                                    │
                                    ▼
   index.ts:73  1.   initDb(v2.db) + runMigrations() ── 中央 DB 就绪
                                    │
                                    ▼
   index.ts:80  1b.  backfillContainerConfigs()      ── 把旧 container.json 迁进 DB
                                    │
                                    ▼
   index.ts:83  1c.  migrateGroupsToClaudeLocal()    ── 一次性 FS 切换
                                    │
                                    ▼
   index.ts:86  2.   ensureContainerRuntimeRunning() ── docker info 探活
                                    │
                cleanupOrphans()  ── 用 install slug 标签回收上次的 container
                                    │
                                    ▼
   index.ts:90  3.   initChannelAdapters(...)        ── 加载 cli / 已安装的 channel skill
                                    │
                                    ▼
   index.ts:166 4.   setDeliveryAdapter(deliveryAdapter)
                                    │
                                    ▼
   index.ts:169 5.   startActiveDeliveryPoll()       ── outbound.db 轮询
                index.ts:170      + startSweepDeliveryPoll()
                                    │
                                    ▼
   index.ts:174 6.   startHostSweep()                ── 60s 周期 maintenance
                                    │
                                    ▼
   index.ts:178 7.   startCliServer()                ── 暴露 ncl Unix socket
                                    │
                                    ▼
   index.ts:180     log.info('NanoClaw running')
```

注意每一步的副作用范围：第 0 步**只读/写一个文件**（`data/circuit-breaker.json`），第 1 步开始接触中央 DB，第 2 步开始接触 Docker，第 3 步开始接触外部网络（channel adapter 连接 Discord/Slack/Telegram 等），第 5 步开始向**用户**投递消息，第 7 步开始接受**操作员**命令。`NanoClaw running` 这一行是承诺：这之后进入稳态，所有外部副作用通道都已上线。

下面逐节解释这条编号清单上每一行的代码与"为什么"。

## 5.3 第 0 步：circuit breaker（崩溃回路熔断器）

入口：[`src/index.ts:70`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/index.ts#L70) → `enforceStartupBackoff()`。

实现：[`src/circuit-breaker.ts:46-84`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/circuit-breaker.ts#L46)。

设计目的是当 host 在短时间内被 launchd / systemd 反复拉起（比如某个 migration 必崩，或一个常量 typo），不要把宿主 CPU/日志/容器创建全速烧穿。状态以一个 JSON 文件 `data/circuit-breaker.json` 持久化：

```ts
// src/circuit-breaker.ts:11
const BACKOFF_SCHEDULE_S = [0, 0, 10, 30, 120, 300, 900];
```

退避表：第 1 次、第 2 次启动立即开始；第 3 次延 10s；第 4 次延 30s；第 5 次延 120s；第 6 次延 300s；第 7 次及之后封顶 900s（15 分钟）。

关键判断：

```ts
// src/circuit-breaker.ts:50-69
if (!prev) {
  attempt = 1;
} else {
  const elapsedMs = now.getTime() - new Date(prev.timestamp).getTime();
  if (elapsedMs < RESET_WINDOW_MS) {
    attempt = prev.attempt + 1;
    log.warn('Previous startup was not a clean shutdown', { ... });
  } else {
    attempt = 1;
    log.info('Circuit breaker reset — last startup was over 1h ago');
  }
}
```

`RESET_WINDOW_MS = 60 * 60 * 1000`：上一次启动在 1 小时之内就算"刚崩过"，attempt 自增；超过 1 小时就视作正常运行了很久才崩，attempt 归 1。

熔断器只在两个地方被"清零"：

- **干净 shutdown**：[`src/index.ts:202`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/index.ts#L202) `resetCircuitBreaker()`——见 5.10 节 shutdown 流程。
- **自然超过 1 小时**：上一段那段判断。

为什么放在第 0 步——也就是 `initDb` 之前？因为：

1. 如果 DB migration 本身就是导致崩溃的原因，那么 `initDb()` 还没成功就 process.exit(1)；如果熔断器放在 `initDb()` 之后，永远跑不到。
2. 熔断器需要的只是 `DATA_DIR`，而 `DATA_DIR` 在 `config.ts` 顶层就解析完了，零依赖。
3. `write(state)` 里 [`src/circuit-breaker.ts:30`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/circuit-breaker.ts#L30) `fs.mkdirSync(DATA_DIR, { recursive: true })` 确保了第一次启动时 `data/` 目录被创建——这意味着第 1 步 `initDb` 拿到的路径一定存在了。

也就是说，**熔断器的副作用之一就是"提前 mkdir DATA_DIR"**，让后面的步骤可以无脑写文件。

## 5.4 第 1 步：中央 DB 与 migrations

入口：[`src/index.ts:73-76`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/index.ts#L73)。

```ts
const dbPath = path.join(DATA_DIR, 'v2.db');
const db = initDb(dbPath);
runMigrations(db);
log.info('Central DB ready', { path: dbPath });
```

中央 DB 是除"会话 DB"以外**唯一**的 SQLite 文件，承载所有非会话状态：agent_groups、messaging_groups、wirings、user_roles、agent_group_members、user_dms、container_configs、pending_*。它是整个 host 进程内大部分模块的隐式单例。

`initDb` ([`src/db/connection.ts:14-21`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/db/connection.ts#L14)) 做三件事：

```ts
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
_db = new Database(dbPath);
_db.pragma('journal_mode = WAL');
_db.pragma('foreign_keys = ON');
```

WAL 模式与会话 DB 的 DELETE 模式形成鲜明对比——中央 DB 不跨进程边界、不跨 mount，所以可以放心走 WAL；会话 DB 必须用 DELETE 模式，因为 WAL 的 mmap `-shm` 文件无法在 host↔container 之间正确刷新（这是第 7 章会展开的关键不变量）。

`runMigrations` ([`src/db/migrations/index.ts:40-77`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/db/migrations/index.ts#L40)) 的迭代逻辑：

```ts
const applied = new Set<string>(
  (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((r) => r.name),
);
const pending = migrations.filter((m) => !applied.has(m.name));
...
for (const m of pending) {
  db.transaction(() => {
    m.up(db);
    const next = (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version').get() as { v: number }).v;
    db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
      next, m.name, new Date().toISOString(),
    );
  })();
}
```

注意 `schema_version` 的唯一约束是 `name` 而不是 `version`（[`src/db/migrations/index.ts:47`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/db/migrations/index.ts#L47)），这让 module-owned migration（譬如 `module-agent-to-agent-destinations`、`module-approvals-pending-approvals`）可以选任意 version 号，不必和核心 migration 协调编号——`version` 列只用来记录"实际应用顺序"。

为什么 migrations 必须在所有 DB 写之前？看注释 [`src/db/migrations/index.ts:51-55`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/db/migrations/index.ts#L51)：

> Uniqueness is keyed on `name`, not `version`. This lets module migrations (added later by install skills) pick arbitrary version numbers without coordinating across modules.

更本质的原因——下一步 `backfillContainerConfigs` 就要读 `agent_groups` 和写 `container_configs`；如果 migration 014（[`src/db/migrations/014-container-configs.ts`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/db/migrations/014-container-configs.ts)）没跑，`container_configs` 表压根不存在，backfill 必崩。

## 5.5 第 1b 步：backfillContainerConfigs

入口：[`src/index.ts:80`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/index.ts#L80)。
实现：[`src/backfill-container-configs.ts:29-78`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/backfill-container-configs.ts#L29)。

这是一个**一次性、幂等**的迁移函数：v2 早期版本把每个 agent group 的 container 配置（apt 包、npm 包、MCP servers、镜像 tag 等）落在 `groups/<folder>/container.json` 文件里；后来挪进了 `container_configs` 表。`backfill` 把还没被迁移过的 group 一次性读盘 → 写表，写完之后下一次启动就直接命中 `getContainerConfig(group.id)` 短路返回。

核心循环：

```ts
// src/backfill-container-configs.ts:33-73
for (const group of groups) {
  // Skip if already has a config row
  if (getContainerConfig(group.id)) continue;

  // Read legacy container.json from disk
  const filePath = path.join(GROUPS_DIR, group.folder, 'container.json');
  let legacy: LegacyContainerJson = {};
  if (fs.existsSync(filePath)) {
    try {
      legacy = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LegacyContainerJson;
    } catch (err) {
      log.warn('Backfill: failed to parse container.json, using defaults', { ... });
    }
  }

  // DB agent_provider wins over file provider (matches old cascade)
  const provider = group.agent_provider || legacy.provider || null;

  const row: ContainerConfigRow = {
    agent_group_id: group.id,
    provider,
    model: null,
    effort: null,
    image_tag: legacy.imageTag ?? null,
    assistant_name: legacy.assistantName ?? null,
    max_messages_per_prompt: legacy.maxMessagesPerPrompt ?? null,
    skills: JSON.stringify(legacy.skills ?? 'all'),
    mcp_servers: JSON.stringify(legacy.mcpServers ?? {}),
    packages_apt: JSON.stringify(legacy.packages?.apt ?? []),
    packages_npm: JSON.stringify(legacy.packages?.npm ?? []),
    additional_mounts: JSON.stringify(legacy.additionalMounts ?? []),
    cli_scope: 'group',
    updated_at: new Date().toISOString(),
  };

  createContainerConfig(row);
  backfilled++;
}
```

几条值得读三遍的细节：

- **优先级**：`agent_groups.agent_provider`（DB 列）**优先于** `container.json.provider`（文件字段）——保留了 v1→v2 时代的 cascade 语义。注意 `agent_groups.agent_provider` 在 `types.ts:7` 已经标 `@deprecated`，未来会被完全移除，但 backfill 流程仍然尊重它。
- **`cli_scope: 'group'`**：所有 backfill 出来的配置都默认 `group` scope（agent 只能操作自己 group 内的 ncl 资源），不是 `global`——这是个**安全默认**。Owner 的 init agent 由 `/init-first-agent` skill 显式设为 `global`。
- **JSON.stringify all the things**：`container_configs` 表里几乎所有"集合"字段都是 JSON-encoded TEXT 列——`skills`、`mcp_servers`、`packages_apt` 等。读出来后由 `container-config.ts` 反序列化。

为什么放在第 1b（migrations 之后、channel adapter 之前）？

- 必须在 migrations 之后：依赖 `container_configs` 表本身。
- 必须在 channel adapter 之前：channel adapter 一旦上线，第一条入站消息就会触发 `wakeContainer`，后者会去查 `getContainerConfig(group.id)`。如果 backfill 还没完成，那条入站消息看到的 config 会是空 row，启动出来的 container 就缺包/缺 MCP server——**用户感知到的是"agent 第一次启动正常，第二次启动突然丢失能力"** 这种灵异。

## 5.6 第 1c 步：migrateGroupsToClaudeLocal

入口：[`src/index.ts:83`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/index.ts#L83)，实现在 `src/claude-md-compose.ts`。

这一步与 backfill 同性质：把旧的 `groups/<folder>/CLAUDE.md` 切换到 `groups/<folder>/.claude/CLAUDE.md` 这套新布局——同样是幂等 no-op，跑第二次就什么都不做。本章不展开（它属于 group filesystem 演进，不影响主流程），只需要知道**它是 1b 之后、容器运行时探活之前的最后一个一次性 FS migration**。

## 5.7 第 2 步：container runtime 探活与孤儿回收

入口：[`src/index.ts:86-87`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/index.ts#L86)。

```ts
ensureContainerRuntimeRunning();
cleanupOrphans();
```

### 5.7.1 `ensureContainerRuntimeRunning`

[`src/container-runtime.ts:37-58`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/container-runtime.ts#L37)：

```ts
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, { stdio: 'pipe', timeout: 10000 });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔══════ FATAL: Container runtime failed to start ══════╗');
    console.error('║  Agents cannot run without a container runtime. To fix: ║');
    console.error('║  1. Ensure Docker is installed and running              ║');
    console.error('║  2. Run: docker info                                    ║');
    console.error('║  3. Restart NanoClaw                                    ║');
    console.error('╚════════════════════════════════════════════════════════╝');
    throw new Error('Container runtime is required but failed to start', { cause: err });
  }
}
```

`CONTAINER_RUNTIME_BIN` 在 [`src/container-runtime.ts:12`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/container-runtime.ts#L12) 直接硬编码为 `'docker'`。注释也很直白：**所有 runtime-specific 逻辑只在这一个文件里**——以后想换成 podman、apple containers、containerd 之类，只动这一个文件即可。

行为：跑 `docker info`，10 秒 timeout；失败就抛 fatal，host 进程退出（被 `main().catch` 接住，见 [`src/index.ts:210`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/index.ts#L210)）。然后 launchd/systemd 会把进程拉起，circuit breaker 接管退避。

### 5.7.2 `cleanupOrphans`——崩溃恢复的核心

[`src/container-runtime.ts:67-90`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/container-runtime.ts#L67)：

```ts
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try { stopContainer(name); } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
```

要点：

- **只清自己**：`--filter label=${CONTAINER_INSTALL_LABEL}` 用 install slug 作为 label key（值是 `nanoclaw-install=<slug>`，见 [`src/config.ts:33`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/config.ts#L33)）。这意味着同一台机器跑了两份 NanoClaw（dev + prod），互不干涉——一个进程的 cleanup 不会误杀另一个的 container。
- **失败容忍**：每个 `stopContainer(name)` 单独 try/catch（"already stopped" 是常见，比如 docker daemon 自己刚 kill 了）；整个 `cleanupOrphans` 外层也 try/catch（即使 `docker ps` 本身失败，host 也要继续启动）。

为什么 `cleanupOrphans` 在 channel adapter 之前？答案是**避免会话 DB 双写者**：上次启动留下的 container 还在跑、还在轮询某个 session 的 inbound.db；新的 host 启动后只要又往这个 inbound.db 写消息、并且不知道有个旧 container 也在读它，就会出现"消息被两次响应"。`cleanupOrphans` 必须发生在新 host 接受任何新入站之前。

## 5.8 第 3 步：channel adapter 注册与启动

入口：[`src/index.ts:90-142`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/index.ts#L90)。

`initChannelAdapters` 之前还有两条关键的 side-effect import：

```ts
// src/index.ts:51, 55
import './channels/index.js';     // channel barrel — self-register
import './modules/index.js';      // modules barrel — self-register
```

`src/channels/index.ts` 本身极简：

```ts
// src/channels/index.ts:9
import './cli.js';
```

main 默认只有 `cli` 这一个 channel。其他平台（Discord/Slack/Telegram/WhatsApp 等）通过 `/add-<channel>` skill 安装时**append** 一行 import 到这个 barrel。同理 `src/modules/index.ts:19-24` import 了 `approvals`、`interactive`、`scheduling`、`permissions`、`agent-to-agent`、`self-mod`——这些 module 的 init 全是 import 时的 top-level 副作用（往 registry 注册回调）。

正因为这种"top-level 副作用注册"模式，`response-registry.ts` 必须独立于 `index.ts`（见 5.11 节）。

### 5.8.1 注册中心 `channel-registry.ts`

[`src/channels/channel-registry.ts:21-27`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/channels/channel-registry.ts#L21)：

```ts
const registry = new Map<string, ChannelRegistration>();
const activeAdapters = new Map<string, ChannelAdapter>();

export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}
```

`registry` 是"工厂表"，channel 模块在 import 时调用 `registerChannelAdapter('discord', { factory: () => makeDiscordAdapter() })`；`activeAdapters` 是"已 setup 完毕的 live 实例"。两阶段分离让"凭据缺失的 channel skip 掉、不影响其他 channel"成为可能：

```ts
// src/channels/channel-registry.ts:53-94
export async function initChannelAdapters(setupFn: (adapter: ChannelAdapter) => ChannelSetup): Promise<void> {
  for (const [name, registration] of registry) {
    try {
      const adapter = await registration.factory();
      if (!adapter) {
        log.warn('Channel credentials missing, skipping', { channel: name });
        continue;
      }
      const setup = setupFn(adapter);
      // ... NetworkError retry loop (2s, 5s, 10s backoff) ...
      let attempt = 0;
      while (true) {
        try {
          await adapter.setup(setup);
          break;
        } catch (err) {
          if (isNetworkError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
            const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
            log.warn('Channel adapter setup failed with network error, retrying', { ... });
            await sleep(delay);
            attempt += 1;
            continue;
          }
          throw err;
        }
      }
      activeAdapters.set(adapter.channelType, adapter);
      log.info('Channel adapter started', { channel: name, type: adapter.channelType });
    } catch (err) {
      log.error('Failed to start channel adapter', { channel: name, err });
    }
  }
}
```

要点：

- 工厂返回 `null` ⇒ skip（凭据没设置就跳过，不让整个 host 失败）。
- 工厂返回 adapter ⇒ 调用 `adapter.setup(setup)`，失败只对 `NetworkError`（duck-typed by `err.name === 'NetworkError'`）做 2s/5s/10s 重试，其他错误（如 401 token 失效）立即抛——避免把一个错配置的 channel 永远卡在重试里。
- 外层 try/catch：单个 channel setup 抛出只 log，不影响其他 channel——**"一个 channel 挂了，别的还能用"** 是 NanoClaw 多 channel 部署的核心容错策略。

### 5.8.2 `setupFn` 桥到 router

`src/index.ts:90-142` 这段长达 50 行的 lambda 就是把 channel adapter 的回调转接到 router 的 `routeInbound`。最关键的：

```ts
// src/index.ts:92-108
onInbound(platformId, threadId, message) {
  routeInbound({
    channelType: adapter.channelType,
    platformId,
    threadId,
    message: {
      id: message.id,
      kind: message.kind,
      content: JSON.stringify(message.content),
      timestamp: message.timestamp,
      isMention: message.isMention,
      isGroup: message.isGroup,
    },
  }).catch((err) => {
    log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
  });
},
```

四个回调：

- `onInbound(platformId, threadId, message)`：channel 收到来自平台的消息——adapter 不知道 router 长什么样，只用回调通知。
- `onInboundEvent(event)`：admin transport 用（譬如 CLI），可以指定任意 `channelType`，不像 `onInbound` 强制使用 adapter 本身的 channelType。
- `onMetadata(platformId, name, isGroup)`：adapter 顺带把"我刚发现这个 channel 名字叫 #general"汇报给 host，主要为后续 channel-approval 卡片提供人类可读名字。
- `onAction(questionId, selectedOption, userId)`：用户点了 card 按钮，转发给 `dispatchResponse` → `getResponseHandlers()` 依次试着 claim。

`routeInbound` 的实现是第 6 章主题，这里只关心 host 是怎么把 adapter 接到 router 上。

## 5.9 第 4-7 步：delivery / sweep / CLI

```ts
// src/index.ts:144-180
const deliveryAdapter = {
  async deliver(channelType, platformId, threadId, kind, content, files?) {
    const adapter = getChannelAdapter(channelType);
    if (!adapter) {
      log.warn('No adapter for channel type', { channelType });
      return;
    }
    return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
  },
  async setTyping(channelType, platformId, threadId) {
    const adapter = getChannelAdapter(channelType);
    await adapter?.setTyping?.(platformId, threadId);
  },
};
setDeliveryAdapter(deliveryAdapter);

// 5. Start delivery polls
startActiveDeliveryPoll();
startSweepDeliveryPoll();

// 6. Start host sweep
startHostSweep();

// 7. Start the `ncl` CLI socket server
await startCliServer();
```

### 5.9.1 `setDeliveryAdapter`（第 4 步）

`setDeliveryAdapter` 让 `delivery.ts` 持有一个"按 channelType 反向查 adapter 然后投递"的代理对象。把"如何投递"从 delivery loop 里解耦——delivery loop 只关心 message_out 行，"具体怎么把它丢给 Discord/Slack" 由这个 adapter 决定。

为什么放在第 3 步（initChannelAdapters）之后？因为这个代理对象捕获的是 `getChannelAdapter(channelType)`——必须先有 active adapter 才能反查。

### 5.9.2 delivery poll（第 5 步）

`startActiveDeliveryPoll`：100ms 间隔轮询所有 active session 的 outbound.db，把 `messages_out` 投递出去。
`startSweepDeliveryPoll`：60s 间隔轮询所有 session（包括非 active 的），兜底捡漏。

为什么放在 channel adapter 之后？因为 delivery 一开就会调 `deliveryAdapter.deliver(...)`，必须有 adapter 才不会 `log.warn('No adapter for channel type')` 满地。

为什么放在 host-sweep 之前？两者其实独立——但 delivery 在前可以让"shutdown 期间还残留 outbound 行被处理掉"的概率更高，毕竟 user 视角 outbound 比 maintenance 重要。

### 5.9.3 `startHostSweep`（第 6 步）

[`src/host-sweep.ts:61`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/host-sweep.ts#L61) `SWEEP_INTERVAL_MS = 60_000`。

60 秒一轮的 maintenance：

- 同步 `processing_ack`（container 写的）→ `messages_in.status='completed'`（host 写的）
- 检测卡死的 container（heartbeat 超过 30 分钟）→ kill 并重置 `processing` 行
- 检测某条消息卡在 processing 太久（≥60s 且 heartbeat 早于 status_changed）→ kill + 这条消息 tries++
- 处理 `recurrence`（定时任务到点了，复制一份新的 messages_in）
- 唤醒"该被叫醒但还没醒"的 container（process_after 到期等）

为什么放在 delivery 之后？因为 host-sweep 会调 `wakeContainer`，而 wakeContainer 启动出来的 container 会写 outbound——如果 delivery 还没启动，container 的回复就会堆在 outbound.db 里没人投递。先 delivery 后 sweep 让"sweep 拉起来的 container 立刻能被 deliver"成为可能。

### 5.9.4 `startCliServer`（第 7 步）

[`src/cli/socket-server.ts:20-46`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/cli/socket-server.ts#L20)：

```ts
export async function startCliServer(socketPath: string = DEFAULT_SOCKET_PATH): Promise<void> {
  // Stale-socket cleanup — a previous run that crashed may have left the
  // file behind, and net.createServer refuses to bind to an existing path.
  try { fs.unlinkSync(socketPath); } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      log.warn('Failed to unlink stale ncl socket', { socketPath, err });
    }
  }

  const s = net.createServer((conn) => handleConnection(conn));
  server = s;
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch (err) {
        log.warn('Failed to chmod ncl socket (continuing)', { socketPath, err });
      }
      log.info('ncl CLI server listening', { socketPath });
      resolve();
    });
  });
}
```

要点：

- **Stale socket 清理**：上次崩溃留下的 socket 文件不会自动消失，`fs.unlinkSync(socketPath)` 主动删；只忽略 `ENOENT`（文件不存在是正常情况，第一次启动）。
- **`chmod 0600`**：socket 文件只允许 owner 读写——auth boundary 就是文件系统权限。dispatch 里 `caller: 'host'` ([`src/cli/socket-server.ts:93`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/cli/socket-server.ts#L93)) 没做任何"再次鉴权"——能连上 socket 就视为可信。

`ncl` socket **必须放在最后**，原因写在 `src/index.ts:177` 的注释里：

> Start the `ncl` CLI socket server (data/ncl.sock).

潜台词是：socket 一启，任何 `ncl` 命令就可能改 DB、操作 container、加 wiring；如果此时 host-sweep / delivery / channel adapter 还没就绪，操作员的命令会跑进未初始化的状态。把 socket server 放在最后，是一个**"NanoClaw 已经稳态运行了，再开门接受人工指令"** 的承诺。

## 5.10 `src/config.ts`：环境与路径

[`src/config.ts:1-69`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/config.ts) 是所有路径常量与可调参数的来源。

```ts
// src/config.ts:9-13
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'ONECLI_URL', 'ONECLI_API_KEY', 'TZ']);

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
```

读 `.env` 的方式与众不同——见 5.12 节解释。

### 5.10.1 三个根路径

```ts
// src/config.ts:16-24
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
```

- `STORE_DIR` = `<cwd>/store`：长期持久化（v1 时代术语，v2 用得少）。
- `GROUPS_DIR` = `<cwd>/groups`：每个 agent group 的 filesystem（CLAUDE.md、skills、agent-runner-src overlay 等）。
- `DATA_DIR` = `<cwd>/data`：所有 SQLite DB（v2.db、v2-sessions/*）、ncl.sock、circuit-breaker.json 等运行时文件。
- `MOUNT_ALLOWLIST_PATH` / `SENDER_ALLOWLIST_PATH`：故意放在 `$HOME/.config/nanoclaw/` **之外** 项目目录——这两份文件**永远不会被挂进 container**，保护"哪些 host 路径可以被 mount"这种安全决策。

### 5.10.2 Install slug 衍生镜像名

```ts
// src/config.ts:28-33
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
```

`getInstallSlug` ([`src/install-slug.ts:11`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/install-slug.ts#L11)) 是 `sha1(projectRoot).slice(0, 8)`——比如 `/Users/alice/work/nanoclaw` 算出来是 `ab12cd34`，那这个 install 的 docker image 就是 `nanoclaw-agent-v2-ab12cd34:latest`，systemd unit 是 `nanoclaw-v2-ab12cd34.service`，launchd label 是 `com.nanoclaw-v2-ab12cd34`。

两份 NanoClaw 装在不同目录就拥有完全不同的命名空间——这就是 `cleanupOrphans` 可以放心用 label 过滤的根本原因。

### 5.10.3 行为参数

```ts
// src/config.ts:34-40
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);
```

| 常量 | 默认 | 含义 |
|------|------|------|
| `CONTAINER_TIMEOUT` | 30 min | 单个 container 最长存活时间 |
| `CONTAINER_MAX_OUTPUT_SIZE` | 10 MB | container stdout 缓冲上限 |
| `MAX_MESSAGES_PER_PROMPT` | 10 | 一次 prompt 打包多少条 messages_in |
| `IDLE_TIMEOUT` | 30 min | container 闲置多久后停掉 |
| `MAX_CONCURRENT_CONTAINERS` | 5 | host 同时最多跑多少 container |

注意 `MAX_CONCURRENT_CONTAINERS` 与 `MAX_MESSAGES_PER_PROMPT` 都做了 `Math.max(1, ...)` 防御——避免被人手贱设 0 把整个系统冻死。

### 5.10.4 Trigger 模式

```ts
// src/config.ts:42-57
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);
```

历史遗留 API。Router 已经优先用 adapter SDK 提供的 `isMention` 信号（[`src/channels/adapter.ts:71-87`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/channels/adapter.ts#L71)），这套 regex 是 fallback——某些"老式 native adapter"或没实现 mention 信号的 channel 才会回落到 `@Andy` 字符串匹配。

### 5.10.5 时区解析

```ts
// src/config.ts:60-68
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
```

三级 fallback：`process.env.TZ` → `.env` 里的 `TZ` → 操作系统当前时区；都不合法就 `UTC`。`isValidTimezone` ([`src/timezone.ts`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/timezone.ts)) 用 `Intl.DateTimeFormat` 构造测试，无效 IANA 标识符直接 catch。

## 5.11 `src/env.ts` 与 `.env`

[`src/env.ts:11-42`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/env.ts#L11)：

```ts
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    log.debug('.env file not found, using defaults', { err });
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
```

这个 .env 解析器有两个 NanoClaw 独有的设计决策：

1. **不写 `process.env`**：函数注释最显眼的一句话是

   > Does NOT load anything into process.env — callers decide what to do with the values. This keeps secrets out of the process environment so they don't leak to child processes.

   传统的 dotenv 库会把整个 `.env` 倒进 `process.env`，结果 `child_process.spawn(...)` 默认继承父进程 env，secret 跟着泄露到每个 container/agent-runner 进程。NanoClaw 不要这种行为——secret 必须通过 OneCLI gateway 走（参考 CLAUDE.md "Secrets / Credentials / OneCLI" 节）。
2. **只读指定 key**：参数 `keys: string[]` 是"白名单"——caller 提前知道要读什么，避免把 .env 当成"无差别 KV 注入"。

`.env.example` 文件本身是个空文件（[`/Users/xgliu/Documents/git/nanoclaw/.env.example`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/.env.example) 只有 1 行）——示例放在 docs 里，避免人在示例里写 fake secret 误以为是真配置。

可识别 key 总集（来自 config.ts 显式 `readEnvFile([...])` 调用 + 各模块自己的 readEnvFile 调用）：

| key | 用途 |
|-----|------|
| `ASSISTANT_NAME` | 默认 trigger 名（`@Andy`） |
| `ASSISTANT_HAS_OWN_NUMBER` | 是否使用专属手机号场景 |
| `ONECLI_URL` | OneCLI gateway 地址 |
| `ONECLI_API_KEY` | OneCLI 认证 key |
| `TZ` | IANA 时区 |
| `LOG_LEVEL` | 通过 process.env 直读（log.ts:16） |
| `CONTAINER_*` | 通过 process.env 直读 |
| `MAX_*` / `IDLE_*` | 通过 process.env 直读 |
| `INSTALL_CJK_FONTS` | `container/build.sh` 在构建时读 |

## 5.12 `src/log.ts`

[`src/log.ts:1-65`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/log.ts) 是一份**约 65 行的极简 logger**。看完你会发现它根本不是"JSON logger"——而是带 ANSI 颜色的人类可读 logger。

```ts
const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
...
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`[${ts()}] ${tag} ${MSG_COLOR}${msg}${RESET}${data ? formatData(data) : ''}\n`);
}
```

### 5.12.1 日志输出去向

注意 `stream`：`warn`/`error`/`fatal` 走 **stderr**，`debug`/`info` 走 **stdout**。配合 launchd / systemd 重定向：

| 文件 | 来源 |
|------|------|
| `logs/nanoclaw.log` | stdout — info/debug |
| `logs/nanoclaw.error.log` | stderr — warn/error/fatal |

CLAUDE.md "Troubleshooting" 节明确写过这套约定：

> Host logs — `logs/nanoclaw.error.log` first (delivery failures, crash-loop backoff, warnings), then `logs/nanoclaw.log` for the full routing chain

读日志的"正确姿势"：

```
tail -f logs/nanoclaw.error.log    # 先看异常
tail -f logs/nanoclaw.log          # 异常发生时去 info 里找完整 routing 链
```

### 5.12.2 全局兜底

[`src/log.ts:57-64`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/log.ts#L57)：

```ts
process.on('uncaughtException', (err) => {
  log.fatal('Uncaught exception', { err });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { err: reason });
});
```

- `uncaughtException` → fatal + exit 1（让 circuit breaker 接管）。
- `unhandledRejection` → 仅 log error，进程继续——避免一个 channel 模块里的小 promise 错误把整个 host 拉死。

### 5.12.3 formatErr 的小心思

```ts
// src/log.ts:18-23
function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{ type: "${err.constructor.name}", message: "${err.message}", stack: ${err.stack} }`;
  }
  return JSON.stringify(err);
}
```

只对名字为 `err` 的字段做 Error → 详细 dump，其他字段走 `JSON.stringify`。约定俗成：调 `log.error('xxx', { err })` 而不是 `{ error: err }` 才能拿到完整堆栈。

## 5.13 `response-registry.ts` 与循环 import

[`src/response-registry.ts:1-45`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/response-registry.ts) 文件不长但承担了一个微妙的架构责任——打破 `index.ts ↔ modules/` 之间的循环依赖。

文件顶部注释写得非常清楚：

```ts
/**
 * Response handler + shutdown callback registries.
 *
 * Extracted from index.ts so that modules calling `registerResponseHandler()`
 * or `onShutdown()` at import time don't hit a TDZ error on the const-array
 * declarations. index.ts imports src/modules/index.js for its side effects,
 * which triggers module registrations that would otherwise happen before
 * index.ts's own const initializers have run.
 *
 * Keep this file dependency-free (log.js is fine, but nothing from
 * modules/* or index.ts itself). Any file imported here must not in turn
 * import from src/index.ts, or the cycle returns.
 */
```

具体场景拆解：

```
src/index.ts
    import './modules/index.js'         ← 触发 modules 模块加载
        src/modules/permissions/index.ts
            import { registerResponseHandler } from '../../response-registry.js'
            registerResponseHandler(handleSenderApprovalResponse)   ← TOP-LEVEL 调用
```

如果 `registerResponseHandler` 与它所操作的 `responseHandlers: ResponseHandler[]` 数组**都定义在 index.ts 里**，那么：

- 当 index.ts 顶部 `import './modules/index.js'` 求值时，permissions 模块 top-level 就调用了 `registerResponseHandler(...)`；
- 但此刻 index.ts 自己的 `const responseHandlers: ResponseHandler[] = []` 还没执行到（它在文件下方）；
- 触发 ES module 的 **Temporal Dead Zone**（TDZ）错误——`Cannot access 'responseHandlers' before initialization`。

把 registry 抽到一个独立、零依赖的文件解决了这个：

```ts
// src/response-registry.ts:26-30
const responseHandlers: ResponseHandler[] = [];

export function registerResponseHandler(handler: ResponseHandler): void {
  responseHandlers.push(handler);
}
```

`response-registry.ts` 只有 const array + push/getter，被加载时就完成初始化。然后无论 index.ts 还是 modules/ 都通过它去注册/读取——没有循环了。

文件里同时承载两个 registry：

| Registry | 用途 |
|----------|------|
| `responseHandlers[]` | Ask question 卡片点击的回调链——`dispatchResponse` 依次试每个 handler，第一个 return `true` 的就 claim 这次响应 |
| `shutdownCallbacks[]` | 进程关闭前要跑的清理函数链——module 在 init 时 `onShutdown(() => stopMyPoller())` 注册 |

`src/index.ts:34` 还把这两个名字**重新 export 一遍**：

```ts
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };
```

——保留向后兼容，让历史调用者 `import { registerResponseHandler } from '../index.js'` 仍然能用，不用全代码搜索改 import 路径。

## 5.14 Shutdown 流程

[`src/index.ts:184-208`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/src/index.ts#L184)：

```ts
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopHostSweep();
  await stopCliServer();
  try {
    await teardownChannelAdapters();
  } finally {
    // Always reset on graceful shutdown — even if teardown threw, we got here
    // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
    // as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

关闭顺序与启动顺序**几乎逆向但又不完全是**——逐项解释：

```
   信号到达 (SIGTERM 或 SIGINT)
        │
        ▼
   1. 跑所有 module 注册的 onShutdown 回调
        │  (typing module 停 typing indicator、scheduling module 停定时器等)
        ▼
   2. stopDeliveryPolls()       ── 不再投递新 outbound
        │
        ▼
   3. stopHostSweep()           ── 不再 60s maintenance
        │
        ▼
   4. stopCliServer()           ── 关 ncl socket（不再接受新命令）
        │
        ▼
   5. teardownChannelAdapters() ── 断开 Discord/Slack/Telegram 等连接
        │
        ▼
   6. resetCircuitBreaker()     ── 把 circuit-breaker.json 删掉
        │
        ▼
   process.exit(0)
```

### 5.14.1 为什么这个顺序

- **shutdown callbacks 第一**：让 module 自己决定怎么"软关闭"。譬如 typing module 会把还没结束的 typing indicator 撤回——必须在 channel adapter 断开**之前**。
- **delivery poll 在 sweep 之前**：sweep 可能写 `process_after` 触发未来唤醒——但只要 host 进程要退出，这些唤醒永远不会发生；先停 delivery 减少 outbound 残留时长。
- **CLI server 在 channel adapter 之前**：避免"shutdown 进行中，操作员还能通过 ncl 调用 modify wiring 等"。
- **`teardownChannelAdapters` 包在 try/finally**：即便某个 adapter 断开时抛错，也保证 `resetCircuitBreaker` 一定执行——shutdown 是用户主动发的（SIGTERM/SIGINT），不能被算作"崩溃"，下一次启动 attempt 必须归 1。

注意 host **不主动 kill container**：

- Active container 由"挂入的 inbound.db 上不会再有新消息 + heartbeat 超过 IDLE_TIMEOUT/CONTAINER_TIMEOUT"自然退出；
- shutdown 期间的 container 会成为下次启动的 orphan，由 `cleanupOrphans` 在下次启动第 2 步收割。

这是一个有意为之的"放手"——host 不保证关 container，是因为关 container 需要 SIGTERM grace period（CONTAINER_TIMEOUT 默认 30 分钟），launchd/systemd 的 shutdown timeout 通常远小于此（10s ~ 60s），强行 wait 必然超时被 SIGKILL，反而留下更糟糕的状态（连 cleanupOrphans label 都没来得及落地）。**让孤儿存在，下次启动收割**——更健壮。

### 5.14.2 没接信号的崩溃

如果 host 通过 `process.exit(1)`、`SIGKILL`、`uncaughtException` 退出，根本跑不到 `shutdown(...)`：

- `circuit-breaker.json` 不会被 reset → 下次启动 attempt += 1，开始退避；
- container 留作孤儿 → 下次启动 `cleanupOrphans` 收割；
- ncl socket 留在磁盘上 → 下次启动 `startCliServer` 里的 stale-socket 清理；
- channel adapter 断开方式由 OS 处理（TCP RST、各 SDK 的 reconnect 逻辑）。

整个系统对"非干净退出"是宽容的——这是 NanoClaw 能在 launchd/systemd 自动重启策略下长期稳定运行的根本。

## 5.15 故障排查清单

把 CLAUDE.md "Troubleshooting" 节翻译成"如果某一步坏了，去哪里看"：

| 症状 | 第一应该看的位置 |
|------|------------------|
| Host 启动失败、log 里有 "FATAL: Container runtime failed to start" | 检查 docker daemon；运行 `docker info` 验证 |
| Host 启动延迟很久（log 里有 "Circuit breaker: delaying startup"） | 之前崩过几次；`data/circuit-breaker.json` 里看 attempt 字段；删掉它强制归 1（仅 debug 时） |
| Host 启动了但 Migration 报错 | `logs/nanoclaw.error.log` 找 stack；可能是新 migration bug 或老 DB 兼容问题 |
| Channel adapter 没启动（log 里 "Channel credentials missing, skipping"） | `.env` 缺凭据；或这个 channel skill 还没装 |
| Channel adapter 反复 retry NetworkError | DNS / 平台 API outage；`SETUP_RETRY_DELAYS_MS` 最多 retry 3 次 = 17s |
| ncl 命令报 "connect ENOENT data/ncl.sock" | host 没启动，或还卡在第 0-6 步；socket 是最后一步开 |
| 启动后某个 group 第一次 wake 缺包 | backfill 漏了；检查 `groups/<folder>/container.json` 是否合法；手动 `ncl groups config get --id <gid>` 看 DB row |
| 上次崩后 docker ps 里有一堆遗留 container | 正常——下次启动 `cleanupOrphans` 会收；如果第 2 步失败导致没清掉，检查 `CONTAINER_INSTALL_LABEL` 是否变了（譬如改了项目路径） |

完整日志路径（来自 CLAUDE.md）：

```
logs/nanoclaw.log         — stdout (info/debug)
logs/nanoclaw.error.log   — stderr (warn/error/fatal)
logs/setup.log            — overall setup
logs/setup-steps/*.log    — per-step: bootstrap, environment, container, onecli, mounts, service
```

会话级 DB：

```
data/v2-sessions/<agent-group>/<session>/
    inbound.db    ← 看 messages_in 判断 host 是否成功写消息
    outbound.db   ← 看 messages_out 判断 container 是否回复
    .heartbeat    ← container 存活信号（mtime）
```

Container stdout 默认是 `--rm` 模式，**进程退出后 log 即丢失**——这是 v2 一个有意的取舍（不想为每个 session 留 docker logs 占盘），调 agent 行为时只能靠 messages_in/messages_out 反推。

## 5.16 小结

`src/index.ts` 只有 213 行，但它把整个 host 的"启动节奏 + 资源生命周期 + 模块装配"全部表达出来了。关键 take-away：

1. **启动顺序是契约**：每一步隐式假设"前面的步骤都已完成"，越后面的步骤副作用越大、对外越可见。
2. **"`NanoClaw running`" 是承诺**：在这之前进程不接受外部请求；之后所有路径上线、随时可服务。
3. **崩溃容忍内嵌在架构里**：circuit breaker + orphan cleanup + stale socket cleanup + 「不强 kill container」组成一套"非干净退出可恢复"的网。
4. **Channel & module 都是自注册**：barrel import 触发副作用——简单、可扩展、但需要 `response-registry.ts` 这种独立文件来打破循环。
5. **路径与命名全靠 install slug**：同一台机器多份安装零冲突；docker label 是 cleanup 的边界。

第 6 章会沿着 `routeInbound` 钻进去，看入站消息如何在 router 里被层层过滤、解析、最终落到 inbound.db。
