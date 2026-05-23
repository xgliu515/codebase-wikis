# Trace 步骤 01 —— 敲下 `opencode run` 之后，谁在跑？

## 1. 当前情境

终端里你刚敲完：

```bash
$ opencode run "What's in README.md?"
```

按下回车的一瞬间，shell 还没把控制权交给任何 opencode 自己的代码。`opencode` 此时只是 `$PATH` 里某个可执行入口——它会启动 Bun 解释器，然后让 Bun 去加载 `packages/opencode/src/index.ts`。在那一行 `import yargs from "yargs"` 真正执行之前，本步骤要解决一系列"还没人替你做"的引导问题。

可见的状态只有：

- `process.argv = ["bun", ".../index.ts", "run", "What's in README.md?"]`
- 还没有任何配置、数据库、provider、session

## 2. 问题

CLI 启动有几件事**必须先做**，否则后面任何业务代码都没法运行：

1. **决定运行模式 / 日志等级**：debug 还是 prod？日志写文件还是 stderr？
2. **保证全局副作用安全**：进程异常不能直接闷死掉而不留下任何信息。
3. **首次运行的数据库迁移**：v1.x 之前 opencode 把 session 存成 JSON 文件，v1.x 改为 SQLite。**首次启动**得把旧文件搬过去——而且必须放在解析 `run` 子命令之前，否则后续访问数据库就 `no such table`。
4. **命令路由**：用户输入 `run`，要找到 `RunCommand` 这个 yargs builder 并把控制权交过去。

而且这些步骤之间**有顺序依赖**：日志要先就绪，否则迁移阶段 100MB 数据慢慢扫的时候用户什么反馈都看不到；迁移要先于命令，否则 `run` 第一行 `Storage.read(...)` 就崩。

## 3. 朴素思路

最直白的写法：

```ts
// pseudo
const cmd = process.argv[2]
if (cmd === "run") return runCommand(process.argv.slice(3))
if (cmd === "serve") return serveCommand(process.argv.slice(3))
// ...
```

每个子命令自己关心鉴权、配置、迁移。哪怕共用一个 `init()` 函数，让每个 command handler 第一行调一下也很自然。

## 4. 为什么朴素思路会崩

opencode 有 **25+ 个子命令**（`run` / `serve` / `web` / `tui` / `attach` / `mcp` / `acp` / `agent` / `session` / `export` / `import` / `upgrade` / `stats` / `generate` / `providers` / `models` / `account` / `debug` / `db` / `pr` / `github` / `plug` / `uninstall` ...）。让每个 command 自己在第一行调 init 有三个坏结果：

- **顺序混乱**：新增 command 的人忘记调 `init()`，或者只调了一半。
- **重复代码**：每个 command 都得写一遍异常 wiring、log init、迁移检查。
- **`-h` / `-v` 会跑迁移**：用户只是想看 help，结果触发了几分钟的数据库迁移——非常糟糕。

另外，"首次启动迁移"需要一个 TTY 进度条——这种事情交给业务命令自己做就乱了：每个命令都要带一份进度条代码。

## 5. opencode 的做法

opencode 把整个引导链路压到 **yargs 的一个 `.middleware()` 钩子里**，加上几个进程级的 `process.on` 注册。这条 middleware 在**任何子命令的 handler 之前**都会运行**一次**——除非用户走的是 `-h / --help`，那时候 yargs 内部短路掉 middleware。

整体形状是这样：

<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Bootstrap pipeline from process.argv through yargs middleware to command dispatch">
  <defs>
    <marker id="art1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="280" y="16" width="200" height="34" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="38" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">process.argv</text>
  <path d="M380,52 L380,72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#art1)"/>
  <rect x="40" y="76" width="680" height="328" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="60" y="98" font-size="12" font-weight="700" fill="currentColor">packages/opencode/src/index.ts</text>
  <rect x="60" y="108" width="640" height="38" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="76" y="126" font-size="11" fill="currentColor">process.on('unhandledRejection') / ('uncaughtException')</text>
  <text x="630" y="138" font-size="10" fill="#64748b">← 进程级保险</text>
  <rect x="60" y="156" width="640" height="200" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="76" y="176" font-size="12" font-weight="700" fill="currentColor">yargs(args)</text>
  <text x="76" y="196" font-size="11" font-weight="600" fill="currentColor">.middleware( async (opts) =&gt; {</text>
  <rect x="100" y="204" width="580" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="219" font-size="10.5" fill="currentColor">① Log.init(...)</text>
  <text x="640" y="219" text-anchor="end" font-size="10" fill="#64748b">log 先就绪</text>
  <rect x="100" y="228" width="580" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="243" font-size="10.5" fill="currentColor">② Heap.start()</text>
  <text x="640" y="243" text-anchor="end" font-size="10" fill="#64748b">debug heap snapshot</text>
  <rect x="100" y="252" width="580" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="267" font-size="10.5" fill="currentColor">③ set OPENCODE / OPENCODE_PID env</text>
  <rect x="100" y="276" width="580" height="38" rx="3" fill="#fff" stroke="#ea580c" stroke-width="1.2"/>
  <text x="116" y="291" font-size="10.5" fill="currentColor">④ if (first run) JsonMigration.run()</text>
  <text x="116" y="307" font-size="10" fill="#64748b">marker = opencode.db；不存在 → 跑迁移 + TTY 进度条</text>
  <text x="76" y="332" font-size="11" font-weight="600" fill="currentColor">})</text>
  <text x="76" y="350" font-size="11" font-weight="600" fill="currentColor">.command(RunCommand) .command(ServeCommand) ... .parse()</text>
  <text x="640" y="350" text-anchor="end" font-size="10" fill="#64748b">⑤ 25 个 command</text>
  <path d="M76,378 L 700,378" stroke="#cbd5e1" stroke-dasharray="4,3"/>
  <text x="380" y="394" text-anchor="middle" font-size="10" fill="#64748b">-h / --help 走 :196 短路：不进 middleware，不触发迁移</text>
</svg>
<span class="figure-caption">图 T1.1 ｜ 启动管线：进程级异常 hook 先到位，yargs.middleware 集中跑日志 / heap / env / 一次性迁移，再分派到 25 个子命令。</span>

<details>
<summary>ASCII 原版</summary>

```text
                        process.argv
                              │
                              ▼
   ┌────────────────────────────────────────────────────┐
   │ packages/opencode/src/index.ts                     │
   │                                                    │
   │  process.on('unhandledRejection') / ('uncaught…')  │ ← 进程级保险
   │                                                    │
   │  yargs(args)                                       │
   │    .middleware( async (opts) => {                  │
   │       Log.init(...)            // 1                │
   │       Heap.start()             // 2                │
   │       set OPENCODE / PID env   // 3                │
   │       if (first run)           // 4                │
   │           JsonMigration.run()  //   带 TTY 进度条  │
   │    })                                              │
   │    .command(RunCommand)        // 5                │
   │    .command(ServeCommand)                          │
   │    .command(...)                                   │
   │    .parse()                                        │
   └────────────────────────────────────────────────────┘
```

</details>

`packages/opencode/src/index.ts:91-155` 把 middleware 函数体定义出来；`:158-180` 注册 25 个 `.command(...)`；`:195-203` 真正调 `cli.parse()`。

关键的设计选择：

- **`yargs.middleware` 只跑一次**：所有命令公用一份 init 路径，不会重复执行。
- **`--help` 走特殊路径**：`:196` 显式检查 `-h / --help`，把 help 输出走 `show()` 函数（带 logo），同时 yargs 不会进入 middleware——所以看 help 不会触发迁移。
- **finally 里 `process.exit()`**：`:245-251` 这段是因为某些 MCP 子进程不响应 SIGTERM；如果不主动 exit，主进程会被这些 docker 容器卡住。

举一段精简的 middleware 主体：

```ts
// packages/opencode/src/index.ts:91-155 (节选)
.middleware(async (opts) => {
  if (opts.pure) process.env.OPENCODE_PURE = "1"

  await Log.init({
    print: process.argv.includes("--print-logs"),
    dev: Installation.isLocal(),
    level: opts.logLevel ?? (Installation.isLocal() ? "DEBUG" : "INFO"),
  })

  Heap.start()
  process.env.OPENCODE = "1"
  process.env.OPENCODE_PID = String(process.pid)

  const marker = path.join(Global.Path.data, "opencode.db")
  if (!(await Filesystem.exists(marker))) {
    process.stderr.write("Performing one time database migration..." + EOL)
    await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
      progress: (event) => { /* 画 TTY 进度条 */ }
    })
  }
})
```

注意 `if (!await Filesystem.exists(marker))` 这个分支——它把"迁移"和"业务"解耦：迁移完，数据库文件本身就是 marker；下次启动一查就跳过。这是 opencode 第一次面对 v0 → v1 schema 改造的优雅出口。

## 6. 代码位置

按阅读顺序：

- `packages/opencode/src/index.ts:1-43` — 全部 command import；`processMetadata` 在文件作用域跑（先于 yargs）。
- `packages/opencode/src/index.ts:46-56` — `process.on('unhandledRejection' | 'uncaughtException')` 注册。
- `packages/opencode/src/index.ts:58` — `args = hideBin(process.argv)`，去掉 `["bun", "<entry>"]`。
- `packages/opencode/src/index.ts:70-90` — yargs builder 的 option 区段（`--print-logs` / `--log-level` / `--pure`）。
- `packages/opencode/src/index.ts:91-155` — 唯一的 `.middleware`，是本步骤的核心。
- `packages/opencode/src/index.ts:158-180` — 25 个 `.command()`，顺序基本与子命令字母表无关，按"用户出现频次"放置。
- `packages/opencode/src/index.ts:195-204` — `cli.parse()` 的两条路径：help 路径 vs 正常路径。
- `packages/opencode/src/index.ts:245-251` — `finally { process.exit() }`，处理 MCP 子进程卡死。
- `packages/opencode/src/storage/json-migration.ts` — 迁移逻辑实现（不进入本步骤细节，看第 4 步）。
- `packages/opencode/src/cli/heap.ts` — `Heap.start()` 的实现：写 heap snapshot 给 debug 用。

## 7. 分支与延伸

- **`opencode run` 之外的子命令**：所有 25 个 command 的角色映射，见 [第 01 章 §子命令地图](01-entrypoints.md#子命令地图)。
- **TUI 进程怎么跑**：`opencode <dir>` 默认进 TUI，子命令文件是 `cli/cmd/tui/`，启动需要 `--conditions=browser`——见 [第 09 章 §进程模型](09-tui.md#进程模型)。
- **JSON → SQLite 迁移到底搬什么**：见 [第 03 章 §JSON-SQLite 迁移](03-session-and-messages.md#json-→-sqlite-一次性迁移)。
- **`--pure` 跳插件**：见 [第 12 章 §插件加载入口](12-plugins.md#插件发现与加载)。
- **`Installation.isLocal()` 怎么判断的**：源码本地编译 vs npm 装的发行版——见 `packages/opencode/src/installation/`。

## 8. 走完这一步你脑子里应该多了什么

1. **opencode 启动的入口是 `packages/opencode/src/index.ts`**——所有命令路径在这里汇聚；这个文件只做"装配 + 调度"，不写业务。
2. **yargs middleware 是唯一可信的 init 钩子**——而不是每个 command 各调一次 init；这种"集中初始化"的代价是 `--help` 也要小心绕开。
3. **JSON → SQLite 迁移是首跑挂钩**——通过 `opencode.db` 是否存在判断；marker 跟数据本身合二为一。
4. **`process.exit()` 在 finally 里是一个有具体故事的兼容性 patch**——某些 dockerized MCP 子进程不响应 SIGTERM。
5. **走到这一步，进程已经能够：log 已就绪、数据库已迁移、能 dispatch 任何子命令。** 下一步 yargs 把 `argv` 喂给 `RunCommand` 的 builder + handler。

下一步：[Trace 步骤 02 —— `run` 子命令分派](tour-02-run-dispatch.md)
