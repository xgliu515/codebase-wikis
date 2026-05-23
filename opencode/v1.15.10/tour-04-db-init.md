# Trace 步骤 04 —— 数据库初始化与 JSON 迁移

## 1. 当前情境

上一步走完，进程里这些东西全部就位：

- `Config.Service`：8 层合并后的最终 `Info` 对象，缓存在 `cachedGlobal` 里；
- `Provider.Service`：所有 provider 注册完，`anthropic/claude-sonnet-4-5` 是 default model；
- `Auth.Service`：`~/.opencode/data/auth.json` 已读，假设里面有一条 `anthropic: { type: "api", key: "sk-..." }`；
- `InstanceBootstrap` 串完，Plugin / LSP / FileWatcher / Snapshot 等子系统已 fork；
- `Server.Default()` 这个 lazy 还没被触发——`fetchFn` 此刻还是个挂着的函数指针。

但是有一件事必须在 server 接客之前**已经做完**——这件事的执行点其实位于本 trace 的更早期：`packages/opencode/src/index.ts:119-153` 那段 yargs middleware。当时讲第 01 步只描了它的轮廓，本步把它拆开。

为什么放在第 04 步讲？因为：

- 它的输出（一个就绪的 SQLite 连接、schema 表全存在、JSON 一次性迁移已完成）是后续每一步的硬前置；
- 它在 trace 中处于 "config 加载完 / session 还没创建" 的中间——逻辑位置就是这儿。

可见状态：

- `Database.Client.loaded()` 仍是 `false`，client 是 `undefined`；
- `~/.opencode/data/opencode.db` 文件**可能已存在**（老用户），**也可能不存在**（首次启动）；
- 如果是老用户从 v0.x 升级上来，`~/.opencode/data/storage/{project,session,message,part,todo,permission,session_share}/*.json` 文件还在。

## 2. 问题

具体要解决的：

1. **拿到一个 SQLite client**——drizzle ORM 包好的 `BunSQLiteDatabase`，能 `db.select(...).from(...)`、能 `db.insert(...).values(...)`、能 `db.transaction(...)`；
2. **应用 schema migrations**——20 个 drizzle 生成的 `migration.sql` 必须按时间序应用，迭代过程中的列添加、表新增、索引变更全部跑一遍，否则后续插入会 `no such table` 或 `no such column`；
3. **JSON → SQLite 一次性迁移**——如果用户是从 v0.x 升级上来，`~/.opencode/data/storage/*` 里堆着几千甚至几万个 JSON 文件。这些数据要能被新的 `session.list()` / `session.get()` 看见，否则用户会以为"我的历史会话全没了"；
4. **不能让用户等几分钟没反馈**——上述迁移在大用户那儿可能扫上百 MB JSON、做几万行 SQL insert；要有 TTY 进度条；
5. **必须只发生一次**——迁移完毕后下次启动不能再扫一遍，否则每次开机都卡半天。

## 3. 朴素思路

凭直觉：

```ts
function initDatabase() {
  const db = drizzle(new BunSQLite("~/.opencode/data/opencode.db", { create: true }))
  applyMigrations(db, MIGRATIONS_DIR)

  if (existsSync("~/.opencode/data/storage")) {
    for (const file of glob("~/.opencode/data/storage/session/*/*.json")) {
      const data = JSON.parse(readFileSync(file))
      db.insert(SessionTable).values({ ... }).run()
    }
    // ...同样跑 message / part / todo / permission / share
  }
}
```

放在 `index.ts` 顶层调一下就完事。

## 4. 为什么朴素思路会崩

朴素方案在 opencode 的生产路径上有这些坑：

- **空场景也要付钱**：朴素代码每次启动都跑 `if (existsSync(storage))`——对新用户来说没问题，但对已经迁移完的老用户，"该不该再迁一次"靠的是"目录还在不在"。问题是迁移完之后留不留 `storage/` 目录？删了用户回滚就麻烦；留了下次启动还得 glob 扫一遍才知道没东西可做。
- **`opencode -h` 也会触发迁移**：朴素方案在 `initDatabase()` 顶层调用——只是看个 help 也要等 SQLite 开库 + 跑 20 个 migration。坏体验。
- **`bun:sqlite` 与 `node:sqlite` 二选一**：opencode 同时支持 Bun runtime 和 Node runtime（开发时调试可能跑 Node）。两个 driver 的 `Database` 构造参数和返回类型完全不同——硬写一份就只能 work 一边。
- **进度反馈**：扫几千个 JSON 文件 + 几万 row insert，没进度的话用户会以为程序挂了。但进度逻辑不能跟"是否首次迁移"的判断绑死——后者还没确定，前者就不能起。
- **数据完整性 vs 顺序**：JSON 时代每条记录是独立文件——`message/{messageID}.json` 可能引用一个 `session/{sessionID}.json`，但前者写完后者还没刷盘的情形真实存在。新的 SQL schema 带外键（`MessageTable.session_id REFERENCES SessionTable`），插入顺序错了或孤儿数据没过滤会直接报错。
- **bundled vs dev**：发行版（npm 装的）应该把所有 `migration.sql` **预先内联**进 bundle，不能依赖 `migration/` 目录还在；本地开发跑源码时则要从 `packages/opencode/migration/` 现场读。

## 5. opencode 的做法

opencode 把这件事拆成三件互锁的事，并把"启动副作用"压到最早可能的一刻——yargs middleware 里头。

### 5.1 `Database.Client()` 单例懒打开

`packages/opencode/src/storage/db.ts:92-140` 是这个单例：

```ts
let client: Client | undefined
let loaded = false

export const Client = Object.assign(
  (flags = readRuntimeFlags()): Client => {
    if (loaded) return client as Client          // ← 单例
    const dbPath = getPath(flags)
    const db = init(dbPath)                      // ← runtime-specific factory
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    db.run("PRAGMA busy_timeout = 5000")
    db.run("PRAGMA cache_size = -64000")
    db.run("PRAGMA foreign_keys = ON")
    db.run("PRAGMA wal_checkpoint(PASSIVE)")
    // Apply schema migrations
    const entries = typeof OPENCODE_MIGRATIONS !== "undefined"
      ? OPENCODE_MIGRATIONS                       // ← bundled 模式
      : migrations(path.join(import.meta.dirname, "../../migration"))  // ← dev 模式
    applyMigrations(db, entries)
    client = db; loaded = true
    return db
  },
  { reset: () => { loaded = false; client = undefined }, loaded: () => loaded },
)
```

几个细节：

- **`#db` 路径取决于 runtime**：`import { init } from "#db"` 是一个 `package.json` 的 `imports` 字段定义的 conditional resolution。`db.bun.ts` 用 `bun:sqlite + drizzle/bun-sqlite`，`db.node.ts` 用 `better-sqlite3 / node:sqlite + drizzle/node-sqlite`。同一份业务代码、双 runtime。
- **`OPENCODE_MIGRATIONS` 是 bundler 注入的常量**：`declare const OPENCODE_MIGRATIONS: { sql, timestamp, name }[] | undefined`（`db.ts:18`）。发行版打包时把 20 个 `migration.sql` 拍平成 JS 数组塞进 bundle；本地开发跑源码时该常量是 undefined，触发 `migrations(...)` 在 `packages/opencode/migration` 目录现场读（`db.ts:72-90`）。
- **PRAGMA 配置**：`journal_mode=WAL` 让读不阻塞写；`synchronous=NORMAL` 是 WAL 推荐配置（CRITICAL durability 牺牲一点点换性能）；`busy_timeout=5000` 让并发争用时退避 5 秒而非立即报错；`foreign_keys=ON` 强制 schema 外键；`wal_checkpoint(PASSIVE)` 启动时尝试合并 WAL 历史。
- **db 路径**：`getPath()`（`db.ts:38-44`）支持三种来源——`Flag.OPENCODE_DB` 环境变量（可以是 `:memory:` 跑测试）、`getChannelPath` 按发行 channel 区分（`opencode-nightly.db` / `opencode-canary.db` ...）、默认 `~/.opencode/data/opencode.db`。

### 5.2 schema 是 drizzle migrations，**不是**手写 SQL

`packages/opencode/migration/` 目录下 20 个时间戳命名的子目录：

```text
20260228203230_blue_harpoon/migration.sql       (最早)
20260303231226_add_workspace_fields/
20260312043431_session_message_cursor/
20260323234822_events/
20260403164413_drop-message-overlay/
20260410174513_workspace-name/
20260411180149_pretty_anaconda/
20260413175956_chief_energizer/
20260423040420_unworthy_chief/
20260427172553_slow_nightmare/
20260428004200_add_session_path/
20260503042029_remove-events/
20260504145000_add_sync_owner/
20260511000411_data_migration_state/             (最新)
... 其余
```

每个子目录里一份 `migration.sql` + `snapshot.json`（drizzle 自己的 schema diff 记录）。`db.ts:55-90` 的 `migrations(dir)` 函数把它们按时间戳排序、传给 drizzle 的 `migrate()` 应用。drizzle 自己在 db 里建一个 `__drizzle_migrations` 表记录已应用的版本号，幂等。

drizzle 同时是 ORM——schema 定义在 TypeScript 里：

```ts
// packages/opencode/src/session/session.sql.ts:16-58
export const SessionTable = sqliteTable("session", {
  id: text().$type<SessionID>().primaryKey(),
  project_id: text().$type<ProjectID>().notNull()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  parent_id: text().$type<SessionID>(),
  slug: text().notNull(),
  directory: text().notNull(),
  title: text().notNull(),
  cost: real().notNull().default(0),
  tokens_input: integer().notNull().default(0),
  ...
}, (table) => [
  index("session_project_idx").on(table.project_id),
  index("session_parent_idx").on(table.parent_id),
])
```

`MessageTable / PartTable / TodoTable / SessionMessageTable / PermissionTable` 同文件定义。`packages/opencode/src/storage/schema.ts` 把所有表统一 re-export 给 ORM 用。

### 5.3 JSON 一次性迁移 ——本步的高潮

`packages/opencode/src/index.ts:119-154`（迁移调用点）：

```ts
const marker = path.join(Global.Path.data, "opencode.db")
if (!(await Filesystem.exists(marker))) {
  process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
  // ... TTY 进度条变量
  await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
    progress: (event) => { /* draw TTY bar */ },
  })
}
```

这里有一个**微妙的契约**：marker 用的是 db 文件本身——只要 `opencode.db` 存在，就不再迁移。这就解决了"迁移完后该不该留 `storage/` 目录"的两难——把 `storage/` 留着就行，反正下次根本不看它。

`JsonMigration.run`（`packages/opencode/src/storage/json-migration.ts:25-435`）的骨架：

```text
1. if (!existsSync("$DATA/storage")) return {empty stats}        ← 全新用户直接退出
2. PRAGMA journal_mode=WAL / synchronous=OFF / cache_size=10000  ← bulk insert 模式
3. Glob.scan 并行扫 7 类文件路径
4. BEGIN TRANSACTION
5. 按外键依赖顺序导入：
     project        (无 FK)
     session        (FK → project)
     message        (FK → session)
     part           (FK → message)
     todo           (FK → session)
     permission     (FK → project)
     session_share  (FK → session)
6. 每类 batchSize = 1000、insert(...).onConflictDoNothing().run()
7. 孤儿数据（找不到 parent 的）丢弃，记 orphans.count
8. COMMIT
```

值得注意的几点：

- **ID 来自路径而非 JSON 内容**（`json-migration.ts:163-164、198-199、262-264`）：

  ```ts
  const id = path.basename(projectFiles[i + j], ".json")
  const projectID = sessionProjects[i + j]   // session 的 projectID 来自父目录名
  ```

  注释里说："since earlier migrations may have moved sessions to new directories without updating the JSON"——历史上 opencode 自己也搬过文件没改 JSON，所以 path 才是可信源。

- **`PRAGMA synchronous = OFF`**（`json-migration.ts:49`）：批量 insert 时关闭 fsync。意味着如果迁移过程中断电，db 状态可能损坏——但因为它发生在 `BEGIN TRANSACTION` 内部、且 marker 文件还没建立，下次启动会**重新跑一次**——所以这个 trade-off 是安全的。

- **进度回调与 batch step 解耦**（`json-migration.ts:131-148`）：

  ```ts
  const total = max(1, sum of all 7 file counts)
  let current = 0
  const step = (label, count) => {
    current = min(total, current + count)
    progress?.({ current, total, label })
  }
  ```

  `step("sessions", 1000)` 在每个 batch 后被调用；TTY 进度条只在百分比变化时重画（`index.ts:131-145`），节省 stderr 写入次数。

- **`Promise.allSettled` 容错读**（`json-migration.ts:84-95`）：单个 JSON 损坏不阻塞 batch，错误塞进 `stats.errors`，迁移结束时一并 warn。

- **三种 SQLite driver 都收**：函数签名是 `db: SQLiteBunDatabase<any, any> | NodeSQLiteDatabase<any, any>`——bun 和 node 都行。

### 5.4 第二种迁移：DataMigration（数据修复）

光把 JSON 搬进 SQLite 还不够。schema 迭代过程中产生过这样一种需求——表结构没变，但**某些字段的值需要重新计算**。例子：从某个版本起 `SessionTable.cost / tokens_input` 等开始基于 `MessageTable.data` 里 `cost / tokens.*` 字段聚合写入；老 session 的 cost 字段是 0，得回填一遍。

`packages/opencode/src/data-migration.ts` 就是为这种需求而存在：

```ts
const migrations: Migration[] = [
  {
    name: "session_usage_from_messages",
    run: Effect.gen(function* () {
      // 分页扫 SessionTable，对每个 session SELECT json_extract(data, '$.cost') from MessageTable
      // 聚合 → UPDATE SessionTable SET cost = ..., tokens_input = ...
    })
  },
]

// 检查是否跑过：select from DataMigrationTable where name = ?
// 跑过则跳过；没跑则跑然后写入 DataMigrationTable
```

它跟 drizzle 的 schema migration 互补——schema migration 改表结构（`ADD COLUMN`、`CREATE INDEX`），data migration 改数据值。state 表是 `data_migration`（`packages/opencode/src/data-migration.sql.ts`，2 列：`name` + `time_completed`）；它本身由编号 `20260511000411_data_migration_state` 的 schema migration 建好。

DataMigration 在 AppLayer 里被 `Effect.forkScoped`（`data-migration.ts:147-153`）——不阻塞启动，后台并发跑。也就是说："schema 迁移"是同步硬阻塞（不跑完没法插数据），"data 修复"是后台软异步（先用着，慢慢补）。

## 6. 代码位置

按"开库 → 跑 schema → 跑 JSON 迁移 → 数据修复"的阅读顺序：

- `packages/opencode/src/storage/db.ts:31-44` —— `getChannelPath(flags)`、`getPath(flags)`：决定 `~/.opencode/data/opencode.db` 或 channel 变体的位置；
- `packages/opencode/src/storage/db.ts:55-90` —— `migrations(dir)`：扫 `packages/opencode/migration/*/migration.sql`，按时间戳排序；
- `packages/opencode/src/storage/db.ts:92-140` —— `Database.Client()`：核心懒单例，PRAGMA 配置、`init(dbPath)`、`applyMigrations(db, entries)`；
- `packages/opencode/src/storage/db.bun.ts:1-8` —— Bun 路径的 `init()`：`new Database(path, { create: true })` + `drizzle({ client })`；
- `packages/opencode/src/storage/db.node.ts` —— Node 路径的 `init()`（同形不同 driver）；
- `packages/opencode/src/storage/schema.ts:1-6` —— 把所有 5 张主表 re-export：`SessionTable / MessageTable / PartTable / TodoTable / PermissionTable / AccountTable / ProjectTable / WorkspaceTable / SessionShareTable`；
- `packages/opencode/src/storage/schema.sql.ts:1-10` —— `Timestamps` 复合字段：`time_created` + `time_updated`，被 sqliteTable spread 进每张表；
- `packages/opencode/src/session/session.sql.ts:16-137` —— 主战场的 5 张表 schema 完整定义；
- `packages/opencode/migration/20260228203230_blue_harpoon/` ~ `20260511000411_data_migration_state/` —— 20 个 schema 增量，时间戳排序应用；
- `packages/opencode/src/storage/json-migration.ts:25-435` —— `JsonMigration.run(db, options)`：file scan → BEGIN → 按外键序 7 段 batch insert → COMMIT；
- `packages/opencode/src/storage/json-migration.ts:15-19` —— `Progress` 类型：`{ current, total, label }`；
- `packages/opencode/src/index.ts:119-154` —— 调用点：marker 检查 + TTY 进度条 + `JsonMigration.run(...)`（trace 第 01 步已见，本步是真正展开）；
- `packages/opencode/src/data-migration.sql.ts:3-6` —— `DataMigrationTable`：`name` primary key + `time_completed`；
- `packages/opencode/src/data-migration.ts:23-119` —— `session_usage_from_messages` 这个 data migration 的实现：分页扫 SessionTable、SQL `json_extract` 聚合 MessageTable、批量 UPDATE；
- `packages/opencode/src/data-migration.ts:123-154` —— DataMigration 的执行调度：依次跑、跑完写 `DataMigrationTable`、整段 `Effect.forkScoped` 后台化；
- `packages/opencode/src/effect/app-runtime.ts:116` —— `DataMigration.defaultLayer` 进 AppLayer 的 mergeAll；
- `packages/opencode/src/storage/db.ts:148-198` —— `use(callback)`、`transaction(callback, opts)`、`effect(fn)`：本步骤之外的"事务上下文"工具——后续步骤会大量使用。

## 7. 分支与延伸

- **为什么从 JSON 改到 SQLite**：[第 03 章 §JSON → SQLite 一次性迁移](03-session-and-messages.md#json--sqlite-一次性迁移) 给了 5 条原始动机——并发写入安全、多 client 订阅、FTS5 全文索引、增量更新成本、schema 演化能力。本步只引用结论；那一节解释来龙去脉。
- **Storage 抽象 vs SQLite**：opencode 同时存在 `Storage.Service`（基于 `~/.opencode/data/storage/<key>.json` 文件 IO 的 façade）和 `Database` SQLite 主存。前者承担"不进 SQLite 的边角资料"——会话 diff、临时 blob、share 元数据。详见 [第 03 章 §Storage 抽象](03-session-and-messages.md#storage-抽象) 与 §Storage façade 上仍然有事件层吗。
- **每写一行触发 bus 事件**：写 SQLite 的同时会调 `SyncEvent.run` 把变更写入 `session_message` 事件日志 + bus publish——客户端能从某个 sync 序号开始重放。这是 opencode 客户端/服务端架构的事件协议核心。[第 03 章 §每次写都发事件](03-session-and-messages.md#每次写都发事件) 讲了为什么。
- **server 端的 SQLite 单例**：`Database.Client` 是模块级 `let client`，意味着同进程内**所有** AppRuntime fiber 共享同一个 db 连接。打开 / 关闭由 `Database.close()` 集中管理。详见参考手册 10 章 §server 启动（待写）。
- **运行时双轨**：`#db` conditional import 是 Bun vs Node 切换的入口；同源码 + 不同 driver 的工程化处理见 `packages/opencode/package.json` 的 `"imports"` 字段。

## 8. 走完这一步你脑子里应该多了什么

1. **`Database.Client()` 是模块级单例 + 懒开库**——首次调用做 `init(path)`、PRAGMA、`applyMigrations()`；之后无脑返回 cached client。`#db` conditional import 把 driver 选择推到 package.json `imports`。
2. **schema 由 drizzle migrations 管理，不是手写 SQL**——`packages/opencode/migration/<ts>_<name>/migration.sql` 按时间序应用；ORM schema 在 TypeScript 里（`*.sql.ts`），同时给 drizzle migrate 用、给业务代码用。
3. **首跑迁移用 `opencode.db` 文件本身做 marker**——存在则跳过，不存在则扫 `~/.opencode/data/storage/*` 并迁过来。这把"是否首次"的判断绑死在最终产物上，不会留下"中间状态"的歧义。
4. **`JsonMigration.run` 按外键依赖 7 段 batch、ID 来自路径而非 JSON、`onConflictDoNothing` 幂等、孤儿数据丢弃**——这些设计共同保证迁移可以中断后重跑、容忍历史上文件搬移留下的不一致。
5. **schema migration（同步硬阻塞）+ data migration（后台异步软修复）双轨**——前者保表结构 ready 才能跑，后者用 `DataMigrationTable` 记 name → time_completed 实现幂等，整段 `Effect.forkScoped` 不挡启动路径。
6. **走完这一步**：`Database.Client()` 已经能返回可用的 drizzle `SQLiteBunDatabase`；所有 schema 表存在；老 JSON 数据（如果有）已经被搬进 SQLite；`session` / `message` / `part` 表此刻**还没有任何属于本次 trace 的行**——下一步将创建 `sessionID = "ses_..."` 这一行。

下一步：Trace 步骤 05 —— 创建 Session 与首条消息（待写）
