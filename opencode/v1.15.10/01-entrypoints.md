# 01. 入口与命令分派

opencode 是一个 TUI 形态的 AI 编码 Agent。它对外暴露一个 `opencode` 可执行文件，但同一个二进制内部承载了三种截然不同的运行模式：默认的交互式 TUI、单次提示的 `run`、以及无头 HTTP 服务 `serve`。这一章拆解从用户敲下 `opencode <args>` 到具体子命令 handler 被调用为止的所有代码路径。

## 1.1 二进制结构：从 npm bin 到 Bun 编译产物

npm 包名 `opencode-ai` 的 bin 字段指向 `packages/opencode/bin/opencode`，这是一个纯 Node.js 启动器（`packages/opencode/bin/opencode:1-200`）。它做的事情非常少：

1. 检测 OS 与 CPU 架构，构造平台特定的 npm 子包名（例如 `opencode-darwin-arm64`、`opencode-linux-x64-baseline-musl`）。CPU 是否支持 AVX2、Linux 是否是 musl libc，决定挑选 `baseline` 还是常规构建。
2. 在 `node_modules` 树里逐级向上找 `opencode-<platform>-<arch>/bin/opencode` 这个真正的二进制（`packages/opencode/bin/opencode:171-187`）。
3. 用 `child_process.spawn` 起子进程并把 SIGINT / SIGTERM / SIGHUP 转发过去（`packages/opencode/bin/opencode:8-44`）。

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="From npm bin stub to platform binary to src/index.ts">
  <defs>
    <marker id="r1ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="180" y="20" width="400" height="56" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="42" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">npm bin (opencode)</text>
  <text x="380" y="60" text-anchor="middle" font-size="10.5" fill="#64748b">Node.js stub，约 200 行，选平台、转信号</text>
  <path d="M380,76 L380,108" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r1ar1)"/>
  <text x="395" y="96" font-size="10" fill="#94a3b8">child_process.spawn</text>
  <rect x="140" y="110" width="480" height="64" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="380" y="134" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">opencode-darwin-arm64/bin/opencode</text>
  <text x="380" y="152" text-anchor="middle" font-size="10.5" fill="#64748b">bun build 出的 standalone 二进制</text>
  <text x="380" y="166" text-anchor="middle" font-size="10" fill="#94a3b8">内嵌 Bun runtime，无需用户安装 Bun</text>
  <path d="M380,174 L380,206" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r1ar1)"/>
  <text x="395" y="194" font-size="10" fill="#94a3b8">加载主模块</text>
  <rect x="180" y="208" width="400" height="56" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="230" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">packages/opencode/src/index.ts</text>
  <text x="380" y="248" text-anchor="middle" font-size="10.5" fill="#64748b">yargs 主入口，注册 21 个子命令</text>
</svg>
<span class="figure-caption">图 R1.1 ｜ opencode 的三层启动结构：npm stub 选平台二进制、二进制内嵌 Bun runtime、最终加载 src/index.ts 注册子命令。</span>

<details>
<summary>ASCII 原版</summary>

```text
npm bin (opencode)                 [Node.js stub, ~200 行]
   │ child_process.spawn
   ▼
opencode-darwin-arm64/bin/opencode  [bun build 出的 standalone 二进制]
   │ 内嵌 Bun runtime
   ▼
packages/opencode/src/index.ts      [真正的入口]
```

</details>

为什么不让 npm bin 直接执行 TS？因为 opencode 把整个 Bun runtime 编译进了平台二进制。这样最终用户机器上不需要装 Bun，npm 安装的本质是把对应平台的 standalone 二进制下载下来。stub 只是路径选择器。开发模式（`bun run dev`）则直接执行源码，绕开 stub，见 `packages/opencode/package.json:17`：

```json
"dev": "bun run --conditions=browser ./src/index.ts"
```

`--conditions=browser` 这个标志会贯穿后面的 TUI 章节。简短答案：TUI 用 SolidJS 渲染到 `@opentui/solid`，SolidJS 在 `package.json#exports` 里通过 `browser` 条件选不同的 reactive 内核，必须显式指定才能让 Solid 在 Bun 里正确工作。

## 1.2 主入口：yargs builder 的总图

`packages/opencode/src/index.ts` 是 244 行的单文件主入口，结构非常规整：

```ts
// packages/opencode/src/index.ts:44
const processMetadata = ensureProcessMetadata("main")

process.on("unhandledRejection", ...)   // line 46-50
process.on("uncaughtException",  ...)   // line 52-56

const args = hideBin(process.argv)
const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .version("version", ..., InstallationVersion)
  .option("print-logs", ...)
  .option("log-level",  ...)
  .option("pure",       ...)
  .middleware(async (opts) => { ... })   // line 91-155, 见 1.3
  .completion(...)
  .command(AcpCommand)                   // 子命令注册，line 158-180
  .command(McpCommand)
  ... 21 个 .command(...)
  .fail((msg, err) => { ... })           // line 181-192
  .strict()
```

随后入口在 `try / catch / finally` 里把 `cli.parse()` 跑起来（`packages/opencode/src/index.ts:195-251`）。对 `-h` / `--help` 做特判，是为了把 yargs 默认输出到 stdout 的帮助文本改写成走 stderr 并前置 `UI.logo()`（`packages/opencode/src/index.ts:60-68`、`196-204`）。

最后 `finally` 块强制 `process.exit()`（`packages/opencode/src/index.ts:245-250`），注释解释了原因：某些 docker-container-based MCP server 不响应 SIGTERM，不显式 exit 整个进程会挂起。这个细节预示了 opencode 后面会反复出现的一个主题——子进程治理。

### 1.2.1 yargs 选择的几个非默认参数

| 配置 | 含义 |
|---|---|
| `parserConfiguration({ "populate--": true })` | 把 `--` 后面的位置参数收集到 `args["--"]` 数组。`run` 命令用它把 shell 引号转义掉的字符还原（见 1.5）。 |
| `wrap(100)` | 帮助文本宽度。 |
| `.alias("help", "h")` / `.alias("version", "v")` | 单字母短选项。 |
| `.completion(...)` | 注入 `opencode completion` 子命令，输出 bash / zsh 补全脚本。 |
| `.strict()` | 未知选项直接报错。配合自定义 `.fail(...)` 把 "Unknown argument" 转换成显示帮助文本。 |

`.strict()` + 自定义 `.fail()` 的组合很值得借鉴。yargs 默认行为是把任何 fail 都打印一遍 usage，但 opencode 想区分"用户笔误"和"业务异常"——前者展示 help，后者抛出去让外层 `catch` 块处理日志和退出码（`packages/opencode/src/index.ts:181-192`）。

## 1.3 中间件链：日志、迁移、心跳

`.middleware(async (opts) => { ... })` 在每个子命令 handler 之前必跑（`packages/opencode/src/index.ts:91-155`）。这是整个 CLI 唯一的"全局初始化"位置，按顺序做了五件事：

1. **`OPENCODE_PURE` 透传**（line 92-94）：`--pure` 走 env 而不是直接传给业务层。这样在内嵌 server 的 fetch 里调用同一份业务代码时也能感知到。
2. **`Log.init`**（line 96-104）：决定 log 写到哪、什么级别。`Installation.isLocal()` 来自 `packages/opencode/src/installation/index.ts:64-66`，当 `InstallationChannel === "local"` 时默认 DEBUG 且 print 到 stderr，正式包则默认 INFO 且写文件。
3. **Heap 监控**（line 106）：`Heap.start()` 启动 v8 heap 周期采样。`packages/opencode/src/cli/heap.ts` 里读 `OPENCODE_AUTO_HEAP_SNAPSHOT` flag，在内存涨到阈值时 dump heap snapshot，主要用于追查 TUI 长时间运行后的内存增长。
4. **环境变量旗标**（line 108-117）：设置 `AGENT=1`、`OPENCODE=1`、`OPENCODE_PID`。`AGENT=1` 是一个事实标准——下游的 git hook、CI 脚本可以 `if [ -n "$AGENT" ]` 来识别"这是 Agent 在跑而不是真人"。
5. **JSON → SQLite 一次性迁移**（line 119-154）：核心逻辑。下一节详述。

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Middleware chain runs before subcommand handler">
  <defs>
    <marker id="r1ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="240" y="16" width="280" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="38" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">opencode &lt;subcommand&gt;</text>
  <path d="M380,52 L380,72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r1ar2)"/>
  <rect x="240" y="74" width="280" height="36" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="96" text-anchor="middle" font-size="12" fill="currentColor">yargs main parser</text>
  <path d="M380,110 L380,130" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r1ar2)"/>
  <rect x="120" y="132" width="520" height="160" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="380" y="152" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">middleware（必在 handler 前执行）</text>
  <rect x="140" y="160" width="480" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="156" y="175" font-size="10.5" fill="currentColor">① Log.init</text>
  <text x="280" y="175" font-size="10" fill="#64748b">写 ~/.local/state/opencode/log/*.log</text>
  <rect x="140" y="186" width="480" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="156" y="201" font-size="10.5" fill="currentColor">② Heap.start</text>
  <text x="280" y="201" font-size="10" fill="#64748b">启动 v8 heap 采样</text>
  <rect x="140" y="212" width="480" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="156" y="227" font-size="10.5" fill="currentColor">③ 设 env var</text>
  <text x="280" y="227" font-size="10" fill="#64748b">AGENT / OPENCODE / OPENCODE_PID</text>
  <rect x="140" y="238" width="480" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="156" y="253" font-size="10.5" fill="currentColor">④ 一次性数据迁移</text>
  <text x="280" y="253" font-size="10" fill="#64748b">无 opencode.db 则跑 JsonMigration.run</text>
  <rect x="140" y="264" width="480" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="156" y="279" font-size="10.5" fill="currentColor">⑤ OPENCODE_PURE 透传</text>
  <text x="280" y="279" font-size="10" fill="#64748b">--pure 走 env，跨内嵌 fetch 也可感知</text>
  <path d="M380,292 L380,316" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r1ar2)"/>
  <rect x="200" y="318" width="360" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="338" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">subcommand handler</text>
  <text x="380" y="354" text-anchor="middle" font-size="10.5" fill="#64748b">真正业务（run / serve / tui / attach / ...）</text>
</svg>
<span class="figure-caption">图 R1.2 ｜ yargs 主解析器先跑 middleware 五步（日志、堆采样、env、迁移、pure 透传），再把控制权交给子命令 handler，保证后续代码拥有一致的全局初始化状态。</span>

<details>
<summary>ASCII 原版</summary>

```text
opencode <subcommand>
   │
   ▼
yargs main parser
   │
   ▼
middleware (always runs first)
   ├── Log.init      ── 写 ~/.local/state/opencode/log/*.log
   ├── Heap.start    ── 启动 GC / heap 采样
   ├── 设 env var    ── AGENT/OPENCODE/OPENCODE_PID
   ├── 一次性数据迁移 ── 检测 opencode.db 是否存在，没就跑 JsonMigration.run
   ▼
subcommand handler  ── 真正业务
```

</details>

### 1.3.1 为什么这些一定要早于业务命令？

`Log.init` 必须早，因为后面所有代码都通过 `Log.create({ service: "..." })` 拿 logger；没初始化时会写到 fallback transport，造成日志丢失。`Heap.start` 早是为了能观察启动过程本身。env var 早是因为 child_process 的 env 在 spawn 之前必须就位——TUI 子命令 5 行后就 spawn worker，迟一拍 worker 就拿不到这些标记。

数据库迁移更微妙。opencode 历史上把 session / message / part 这类记录序列化成 JSON 散落在 `~/.local/share/opencode/storage/` 下，1.x 版本切换到 SQLite（drizzle-orm）。如果用户从旧版本升级上来，第一次启动会看到所有命令"卡"几分钟：

```ts
// packages/opencode/src/index.ts:119-154
const marker = path.join(Global.Path.data, "opencode.db")
if (!(await Filesystem.exists(marker))) {
  process.stderr.write("Performing one time database migration, ...")
  await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
    progress: (event) => {
      // 渲染进度条：■■■■■･･･  35% messages 350/1000
    },
  })
}
```

迁移代码本身在 `packages/opencode/src/storage/json-migration.ts:25-437`，会把 `storage/` 目录下的 JSON 全部扫一遍、批量插入到 SQLite 表（`ProjectTable / SessionTable / MessageTable / PartTable / TodoTable / PermissionTable / SessionShareTable`）。它选择把 PRAGMA 调整成 `journal_mode=WAL, synchronous=OFF`（`packages/opencode/src/storage/json-migration.ts:48-51`）来加速，这是合法的——失败了就重跑，并不破坏旧的 JSON 文件。

放在 middleware 而不是各子命令的好处：所有路径（run、serve、tui、attach...）首次启动都会触发迁移，行为一致。坏处是不能跳过——即使你只想 `opencode --version` 也会先等迁移。但因为有 `marker = opencode.db` 这个文件，第二次起就直接跳过了。

## 1.4 子命令地图

`packages/opencode/src/index.ts:158-180` 顺序注册了 21 个子命令。下面按"用户日常出现频率"排序而不是注册顺序：

```text
opencode
├── (default)                    交互式 TUI            packages/opencode/src/cli/cmd/tui/thread.ts
├── run [message..]              单次 prompt          packages/opencode/src/cli/cmd/run.ts            (882 行)
├── attach <url>                 连到远端 server 跑 TUI packages/opencode/src/cli/cmd/tui/attach.ts
├── serve                        无头 HTTP server     packages/opencode/src/cli/cmd/serve.ts          (24 行)
├── web                          serve + 打开 web UI  packages/opencode/src/cli/cmd/web.ts
│
├── auth / providers
│   ├── providers login [url]    登录 provider       packages/opencode/src/cli/cmd/providers.ts:298
│   ├── providers list           列出 credentials    packages/opencode/src/cli/cmd/providers.ts:247
│   └── providers logout         删除 credential     packages/opencode/src/cli/cmd/providers.ts:488
├── models [provider]            列出可用 model      packages/opencode/src/cli/cmd/models.ts
├── account                      console 账户管理    packages/opencode/src/cli/cmd/account.ts
│
├── agent                        agent 配置/生成     packages/opencode/src/cli/cmd/agent.ts
├── session                      会话管理            packages/opencode/src/cli/cmd/session.ts
├── stats                        token / 成本统计    packages/opencode/src/cli/cmd/stats.ts
├── export / import              会话导入导出        packages/opencode/src/cli/cmd/{export,import}.ts
│
├── mcp                          MCP server 管理     packages/opencode/src/cli/cmd/mcp.ts            (~700 行)
├── plugin <module>              安装插件            packages/opencode/src/cli/cmd/plug.ts
├── acp                          ACP server          packages/opencode/src/cli/cmd/acp.ts
├── github                       GitHub agent 安装   packages/opencode/src/cli/cmd/github.ts
├── pr                           检出 PR 并跑 opencode packages/opencode/src/cli/cmd/pr.ts
│
├── upgrade [target]             升级 opencode 自身  packages/opencode/src/cli/cmd/upgrade.ts
├── uninstall                    卸载 opencode      packages/opencode/src/cli/cmd/uninstall.ts
│
├── db [query]                   sqlite 交互 shell  packages/opencode/src/cli/cmd/db.ts
├── debug                        诊断工具集合       packages/opencode/src/cli/cmd/debug/index.ts
├── generate                     输出 OpenAPI spec  packages/opencode/src/cli/cmd/generate.ts
└── completion                   生成 shell 补全    (yargs 内置)
```

`debug` 下还有自己的子命令树（`packages/opencode/src/cli/cmd/debug/index.ts:22-38`）：`debug config / lsp / ripgrep / file / scrap / skill / snapshot / startup / agent / v2 / info / paths / wait`。这些是给 opencode 自己开发者用的，正常用户基本碰不到。

`providers` 命令带 alias `auth`（`packages/opencode/src/cli/cmd/providers.ts:240`），所以 `opencode auth login` 和 `opencode providers login` 完全等价。文档里两种说法都能见到。

### 1.4.1 单文件命令的标准骨架

opencode 用了两套包装：`cmd()` 和 `effectCmd()`。前者是 yargs `CommandModule` 的简单类型化封装，handler 返回 `Promise<void>`；后者是 Effect 加持版本，handler 是 `Effect.fn("...")(function* (args) { ... })`，可以直接 `yield* SomeService` 拿到 IoC 注入的服务。两者在同一份代码里混用，按业务复杂度选——例如 `serve.ts` 只有 24 行，用了 `effectCmd`：

```ts
// packages/opencode/src/cli/cmd/serve.ts:7-24
export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  instance: false,                              // 不需要 project context
  handler: Effect.fn("Cli.serve")(function* (args) {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: ... server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    yield* Effect.never                          // 永远不返回
  }),
})
```

注意 `instance: false`——`effectCmd` 默认会在 handler 前自动调 `bootstrap(...)` 加载 project instance（项目工作目录、worktree、配置层级、auth 等），但 `serve` 这种"按请求加载"的命令显式声明不需要全局 instance，提速且避免锁定 cwd。

## 1.5 默认行为：opencode 不带子命令时

注册顺序里有一个特殊条目：

```ts
// packages/opencode/src/index.ts:160
.command(TuiThreadCommand)
```

而 `TuiThreadCommand.command === "$0 [project]"`（`packages/opencode/src/cli/cmd/tui/thread.ts:80`）。yargs 里 `$0` 表示"默认命令"——当用户跑 `opencode` 或 `opencode ./some/dir` 而没有指明子命令时，落到这条。所以：

```text
opencode                    → 启动 TUI（默认目录 = cwd）
opencode ./packages/foo     → 启动 TUI，目录切到 ./packages/foo
opencode run "fix bug X"    → 单次 prompt，输出到 stdout
opencode serve              → 无头 HTTP 后端
opencode attach http://...  → 连接到已有 server 跑 TUI
```

这四条路径有一个共性：除了 `serve` 之外，最终都在用同一个 HTTP server。`run` 在进程内嵌一个 server，`tui` 把 server 跑在 worker thread 里，`attach` 则连到远端 server。这是 opencode 的核心架构决定——下面 1.7 会详细讲。

## 1.6 run 子命令深挖

`packages/opencode/src/cli/cmd/run.ts` 882 行，是除 TUI 之外最重的子命令实现。它的开头注释一句话说清了三种模式（`packages/opencode/src/cli/cmd/run.ts:1-13`）：

```text
1. Non-interactive (default): 发一个 prompt，把事件流式打印到 stdout，session idle 后退出
2. Interactive local (--interactive): 启动 "split-footer direct mode" + 进程内 server
3. Interactive attach (--interactive --attach <url>): 同 2 但连到远端 server
```

### 1.6.1 参数与 stdin 合并

`run` 接受大量选项（`packages/opencode/src/cli/cmd/run.ts:136-245`），分四类：

- 会话控制：`--continue / --session / --fork / --title`
- 模型选择：`--model anthropic/claude-sonnet-4-5 --variant high --agent build`
- 输出控制：`--format default|json --thinking`
- 远程：`--attach <url> --username --password`

参数解析后第一件大事是把 message 拼出来：

```ts
// packages/opencode/src/cli/cmd/run.ts:251, 265-267, 356-357
const rawMessage = [...args.message, ...(args["--"] || [])].join(" ")
let message = [...args.message, ...(args["--"] || [])]
  .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
  .join(" ")
// ... 然后：
const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
message = resolveRunInput(message, piped) ?? ""
```

`piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()` 这一行是经典的 "Unix 哲学"：当 stdin 不是 TTY 就把它读完，拼到命令行参数之后。这样 `git diff | opencode run "explain this diff"` 能工作。`resolveRunInput()`（`packages/opencode/src/cli/cmd/run.ts:43-53`）就是把两者 join 起来。

参数和 `--` 的处理：`populate--: true` 让 `--foo bar -- xyz` 里的 `xyz` 进 `args["--"]`，避免 yargs 把它当未知选项报错。这是 run 命令支持 `opencode run -- 任意带 dashes 的内容` 的关键。

### 1.6.2 Session 选择与创建

run 模式下需要决定"这次 prompt 投给哪个 session"。`session(sdk)` 函数（`packages/opencode/src/cli/cmd/run.ts:396-473`）按优先级解决：

1. `--session <id>` 给了就用那个，可选 fork。
2. `--continue` 找最近一个无 parent 的 session（"root session"）继续。
3. 都没有就 `sdk.session.create({ title, permission: rules })` 起新的。

`rules` 默认是 deny `question/plan_enter/plan_exit` 三种 permission（`packages/opencode/src/cli/cmd/run.ts:370-388`），目的是让非交互模式下 agent 不会卡在等待用户回答上——这些权限被 deny 后，agent 的 `question` 工具直接报错返回，而不会无限等待。

### 1.6.3 事件循环：subscribe + 流式输出

核心是 `execute(sdk)` 里的 `loop(client, events)`（`packages/opencode/src/cli/cmd/run.ts:637-759`）。它通过 SDK 的 `sdk.event.subscribe()` 拿一个 async iterator，然后在 `for await (const event of events.stream)` 里处理几类事件：

- `message.updated`：assistant 新消息开始，打印 `> agent · modelID` 头部一次。
- `message.part.updated`：消息的 part 更新。这里又分情况：
  - `tool` 完成或失败 → 调 `tool(part)` 渲染图标 + 标题（`packages/opencode/src/cli/cmd/run.ts:659-667`）
  - `text` 完成 → 写到 stdout（非 TTY）或 UI.println（TTY）
  - `reasoning` 完成 + `--thinking` → 用斜体灰色打印
  - `step-start / step-finish` → JSON 模式才 emit
- `session.error` → 累积错误消息
- `session.status === "idle"` → 跳出循环
- `permission.asked` → 默认 reject；`--dangerously-skip-permissions` 时 reply "once"（`packages/opencode/src/cli/cmd/run.ts:736-756`）

<svg viewBox="0 0 820 440" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="run subcommand event loop with in-process server">
  <defs>
    <marker id="r1ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="40" y="18" width="320" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="200" y="38" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">opencode run &quot;...&quot;</text>
  <text x="200" y="54" text-anchor="middle" font-size="10" fill="#64748b">CLI 进程，parse args + read stdin</text>
  <rect x="440" y="18" width="340" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="610" y="38" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">in-process Server</text>
  <text x="610" y="54" text-anchor="middle" font-size="10" fill="#64748b">Server.Default().app.fetch（同进程函数）</text>
  <rect x="40" y="86" width="320" height="32" rx="5" fill="#fff" stroke="#cbd5e1"/>
  <text x="200" y="106" text-anchor="middle" font-size="11" fill="currentColor">sdk.session.create({ ... })</text>
  <path d="M360,102 L440,102" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r1ar3)"/>
  <text x="400" y="96" text-anchor="middle" font-size="9.5" fill="#94a3b8">HTTP POST</text>
  <rect x="440" y="86" width="340" height="32" rx="5" fill="#fff" stroke="#cbd5e1"/>
  <text x="610" y="106" text-anchor="middle" font-size="11" fill="currentColor">Session.create + 准备 stream</text>
  <rect x="40" y="138" width="320" height="32" rx="5" fill="#fff" stroke="#cbd5e1"/>
  <text x="200" y="158" text-anchor="middle" font-size="11" fill="currentColor">sdk.event.subscribe()</text>
  <path d="M440,154 L360,154" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r1ar3)"/>
  <text x="400" y="148" text-anchor="middle" font-size="9.5" fill="#94a3b8">EventStream</text>
  <rect x="440" y="138" width="340" height="32" rx="5" fill="#fff" stroke="#cbd5e1"/>
  <text x="610" y="158" text-anchor="middle" font-size="11" fill="currentColor">server pushes events</text>
  <rect x="40" y="190" width="320" height="32" rx="5" fill="#fff" stroke="#cbd5e1"/>
  <text x="200" y="210" text-anchor="middle" font-size="11" fill="currentColor">sdk.session.prompt({ sessionID, parts })</text>
  <path d="M360,206 L440,206" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r1ar3)"/>
  <rect x="440" y="190" width="340" height="32" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="610" y="210" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">Agent.run inside server</text>
  <rect x="40" y="246" width="320" height="80" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="200" y="266" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">for await (event of stream)</text>
  <text x="200" y="284" text-anchor="middle" font-size="10" fill="#64748b">message.updated / part.updated</text>
  <text x="200" y="300" text-anchor="middle" font-size="10" fill="#64748b">permission.asked / session.error</text>
  <text x="200" y="316" text-anchor="middle" font-size="10" fill="#64748b">emit JSON 或 println 到 UI</text>
  <path d="M440,286 L360,286" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r1ar3)"/>
  <text x="400" y="280" text-anchor="middle" font-size="9.5" fill="#94a3b8">streaming</text>
  <rect x="440" y="246" width="340" height="80" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="610" y="266" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">LLM loop（tool 调用 + 流式输出）</text>
  <text x="610" y="290" text-anchor="middle" font-size="10" fill="#64748b">每个 part 累积进 PartTable</text>
  <text x="610" y="306" text-anchor="middle" font-size="10" fill="#64748b">空闲后发 session.status = idle</text>
  <path d="M200,326 L200,360" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r1ar3)"/>
  <path d="M610,326 L610,360" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r1ar3)"/>
  <rect x="240" y="362" width="340" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="382" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">status = idle → process.exit</text>
  <text x="410" y="398" text-anchor="middle" font-size="10" fill="#64748b">non-TTY 时按行写 JSON 给下游脚本</text>
</svg>
<span class="figure-caption">图 R1.3 ｜ opencode run 把进程内嵌的 Server 当成 HTTP server 调用，SDK 通过 fetch 走"同进程函数"完成 create / subscribe / prompt 三步，再在事件循环里增量输出，直到 session 空闲退出。</span>

<details>
<summary>ASCII 原版</summary>

```text
                    ┌──────────────────────────────────────┐
opencode run "..."  │ in-process Server.Default().app.fetch │
   │                └──────────────┬───────────────────────┘
   │                               │
   ▼                               ▼
parse args ──── sdk.session.create({ ... }) (HTTP POST)
   │
   ▼
sdk.event.subscribe()  ◄────── server pushes EventStream
   │
   ▼
sdk.session.prompt({ sessionID, parts, ... })
   │                              │
   │  (event loop in for-await)   │
   ▼                              ▼
emit JSON / print to UI    Agent.run inside server
   │                              │
   └────── status=idle ───────────┘
              │
              ▼
          process.exit
```

</details>

`--format json` 时所有 emit() 都返回 `true`，跳过 UI 渲染，让脚本能直接消费 newline-delimited JSON。

### 1.6.4 进程内嵌 server 的诡异点

`run` 默认（非 attach）情况下创建 SDK 客户端时给的 baseUrl 是 `http://opencode.internal`（`packages/opencode/src/cli/cmd/run.ts:874-878`）：

```ts
const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const { Server } = await import("@/server/server")
  const request = new Request(input, init)
  return Server.Default().app.fetch(request)
}) as typeof globalThis.fetch

const sdk = createOpencodeClient({
  baseUrl: "http://opencode.internal",
  fetch: fetchFn,
  directory,
})
```

这里没有实际开 TCP 端口。`Server.Default()` 返回一个 `{ app: { fetch(request) } }`（`packages/opencode/src/server/server.ts:58-67`），是一个把 HTTP API webHandler 转成同步函数调用的壳。所有 SDK 调用本质是 `new Request(...) → app.fetch(request) → new Response(...)` 的直接函数调用，零网络开销，但代码路径和真实 HTTP server 完全一致。`baseUrl` 只用于 URL 合成，实际不会被解析。这是 opencode "一切走 HTTP" 设计哲学的关键trick。

## 1.7 serve 子命令与单进程内嵌 server 哲学

`packages/opencode/src/cli/cmd/serve.ts` 全文 24 行（上文已贴）。真正的 server 实现是 `packages/opencode/src/server/server.ts:75-101`：

```ts
export async function listen(opts: ListenOptions): Promise<Listener> {
  const listener = await Effect.runPromise(listenEffect(opts))
  return {
    hostname: listener.hostname,
    port: listener.port,
    url: listener.url,
    stop: (close) => Effect.runPromiseExit(listener.stop(close)).then(() => undefined),
  }
}
```

底层用 `@effect/platform-node` 的 `NodeHttpServer`，套上 `@effect/platform` 的 `HttpRouter` 和 `HttpApi`（即 OpenAPI 风格的类型安全路由声明），加上 `WebSocketTracker` 中间件做 websocket 生命周期管理（`packages/opencode/src/server/server.ts:103-118`）。`startWithPortFallback` 实现"先试 4096，失败任意端口"的策略（`packages/opencode/src/server/server.ts:120-125`）。

### 1.7.1 为什么 TUI / run 也是连"server"跑的？

这是 opencode 与 Claude Code / aider 风格 CLI 的最大架构差异。三个原因：

1. **同一份业务逻辑**。Session、Agent、Tool、Permission 这些核心抽象都是 HTTP API 的 handler。TUI 调它，CLI run 调它，远程 web 客户端也调它——只是 transport 不同。维护一份代码，三种 UI 都能跑。
2. **`attach` 模式**。用户可以在 server A 上跑 `opencode serve`，在另一台机器上跑 `opencode attach http://A:4096` 连过来用 TUI。如果不抽出 server，这是不可能的。
3. **Web / Desktop / Extension**。`packages/web`、`packages/desktop`、VSCode extension 都消费同一个 HTTP API。

代价是即便单进程使用，所有跨"层"调用都会经过一次 Request/Response 序列化。但 `Server.Default()` 这条进程内 fetch 路径避免了真正的网络 IO，只有对象构造的开销，实测 < 1ms 量级，可以忽略。

### 1.7.2 为什么 `serve` 默认警告 password 缺失？

```ts
// packages/opencode/src/cli/cmd/serve.ts:15-17
if (!Flag.OPENCODE_SERVER_PASSWORD) {
  console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
}
```

`Flag.OPENCODE_SERVER_PASSWORD` 从 env var 读（`packages/core/src/flag/flag.ts:28`）。当 server 暴露到非 loopback 接口时，没有 basic auth 等于全 internet 都能直接发 prompt 让你 spend 100k tokens。serve 命令故意不强制——大量本地用户在 localhost:4096 上跑只是为了开 web UI——但会响亮地警告。

## 1.8 TUI 子命令：worker + browser conditions

TUI 是 opencode 用户日常使用的形态。入口是 `TuiThreadCommand`（`packages/opencode/src/cli/cmd/tui/thread.ts:79-200+`），handler 做了一件出乎意料的事情——它不直接渲染 TUI，而是 spawn 一个 Bun `Worker` 来跑 TUI：

```ts
// packages/opencode/src/cli/cmd/tui/thread.ts:146-148
const worker = new Worker(file, { env })
worker.onerror = (e) => { Log.Default.error("thread error", { ... }) }
```

`file` 解析逻辑（`packages/opencode/src/cli/cmd/tui/thread.ts:59-64`）：开发模式取 `./worker.ts`，bundle 后取 `OPENCODE_WORKER_PATH` global（编译期替换的常量）。Worker 文件是 `packages/opencode/src/cli/cmd/tui/worker.ts`。

主线程和 worker 之间用 `Rpc.client<typeof rpc>` / `Rpc.server`（`packages/opencode/src/cli/cmd/tui/thread.ts:159` + `worker.ts`）通信，主线程作为 fetch 代理：

```ts
// packages/opencode/src/cli/cmd/tui/thread.ts:31-47
function createWorkerFetch(client: RpcClient): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const result = await client.call("fetch", { url, method, headers, body })
    return new Response(result.body, { status: result.status, headers: result.headers })
  }
}
```

为什么把 TUI 关进 worker？两个原因：

- **隔离 GC 与渲染**：主线程负责 IO / SDK / 网络。worker 专门跑 SolidJS 的 reactive graph 和 `@opentui/core` 的渲染循环。SolidJS 的 `createEffect` 在 reactive 更新时会进入大量微任务；主线程的网络 IO 不会拖累渲染帧率。
- **`--conditions=browser` 仅限 worker**：SolidJS 是浏览器优先库，在 Node/Bun 里需要明示 browser 条件才能选对子模块。整个进程开 `--conditions=browser` 会让其它依赖（比如 `@ai-sdk/*`、`drizzle-orm`）出现兼容问题。把 SolidJS 关进 worker，只在 worker 里挑 browser 条件，是最干净的方案。

实际 `--conditions=browser` 的应用点在两处：
1. 开发时整个进程开（`packages/opencode/package.json:17`），因为开发模式不分 worker。
2. 打包时通过 bun build 的 `--conditions` 参数对 worker 子 bundle 单独打 browser 条件。

### 1.8.1 TUI 内的组件层级

`packages/opencode/src/cli/cmd/tui/app.tsx` 是 worker 里运行的根组件（`packages/opencode/src/cli/cmd/tui/app.tsx:1-200`）。它套了大量 Provider，从外到内是：

```text
ThemeProvider           ── 主题 / 颜色
  ArgsProvider          ── CLI 传入的参数
    SDKProvider         ── opencode SDK client
      LocalProvider     ── 本地状态（cwd, agents, models, ...）
        SyncProvider    ── 与 server 的事件订阅
          KVProvider    ── 持久化 key-value（最近 model 等）
            ProjectProvider ── 当前项目元信息
              RouteProvider ── 路由：Home / Session
                DialogProvider ── 模态对话框栈
                  ToastProvider / ExitProvider
                    <App />
```

`Switch / Match` 在 `<App />` 里根据 route 渲染 `Home` 或 `Session` 路由（`packages/opencode/src/cli/cmd/tui/app.tsx:46-47`、`routes/home.tsx`、`routes/session.tsx`）。

### 1.8.2 win32 特殊处理

`tui/thread.ts` 第一件事就是调 `win32InstallCtrlCGuard()` 和 `win32DisableProcessedInput()`（`packages/opencode/src/cli/cmd/tui/thread.ts:118-122`）。Windows 控制台默认开 ENABLE_PROCESSED_INPUT，会把 Ctrl-C 转成 SIGINT 杀掉整个 process group；TUI 需要自己处理 Ctrl-C 才能做"按一次进 confirm dialog，按两次退出"这种交互。所以在 spawn worker 之前必须禁用。`unguard` finalizer 退出时恢复。

## 1.9 attach：连远端 server 跑 TUI

`AttachCommand`（`packages/opencode/src/cli/cmd/tui/attach.ts:9-46`）与 thread 几乎对称，只是不 spawn worker 而是给一个远端 URL，TUI 的 fetch 走真实网络。`--username` / `--password` 接 basic auth，回退到 `OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD`。这条路径的存在意味着：

- 你可以把 server 放在自己的开发服务器上（有更好的 CPU、GPU、网速），TUI 跑在笔记本上。
- 团队可以共享一个 server，多人 attach（虽然实际多用户隔离需要 reverse proxy 配置）。
- 远程容器 / GitHub Actions 里跑 `opencode serve`，本地 `opencode attach` 进去操作。

## 1.10 启动时间预算

opencode 的启动路径里有几个让人意外的"慢点"：

1. **`processMetadata = ensureProcessMetadata("main")`**（`packages/opencode/src/index.ts:44`）：在模块加载阶段就跑，写 `~/.local/state/opencode/process/<pid>.json`，建立"哪个进程是 main / worker / mcp-server"的注册表。后面 `opencode stats` 之类命令读这个目录来查询活跃进程。
2. **`Global.Path` 模块顶层 `await`**（`packages/core/src/global.ts:34-42`）：模块加载阶段就 mkdir 所有 xdg 路径。每次启动都跑——目录已存在是 no-op，但 `fs.mkdir { recursive }` 还是有 syscall 开销。
3. **`bin/opencode` Node 启动 + spawn 平台二进制**：双 fork 加上 Node V8 启动，冷启动经常要 100-300ms。npm install opencode-ai 后第一次的额外开销在 stub 这一层很难规避。

冷启动后 `opencode --version` 的实测时间通常在 400-800ms 量级，绝大部分花在 Bun runtime 启动和模块加载（不包括迁移）。这也是 `Heap.start` 设计为可选、并把日志默认级别调高的原因——不要在启动路径上做不必要的工作。

## 1.11 错误路径与退出码

主入口的 `try / catch`（`packages/opencode/src/index.ts:195-244`）把任意 Throwable 收敛成两件事：

1. `Log.Default.error("fatal", data)`，结构化日志包含 name / message / cause / stack。
2. `FormatError(e)` 把已知的 `NamedError` 类型格式化成用户友好的多行文本，否则 fallback 到 "Unexpected error, check log file at ..."。

退出码：

- `process.exit(1)` 由各子命令在校验失败时直接调（如 `--interactive cannot be used with --command`）。
- 主入口 catch 块设 `process.exitCode = 1`，让 `finally` 里的 `process.exit()` 携带 1 退出。
- 正常路径 yargs 让 handler 自然返回，`process.exit()` 用默认 0。

`fail` callback 里还有一段巧思（`packages/opencode/src/index.ts:181-192`）：

```ts
.fail((msg, err) => {
  if (msg?.startsWith("Unknown argument") || msg?.startsWith("Not enough non-option arguments") || msg?.startsWith("Invalid values:")) {
    if (err) throw err
    cli.showHelp(show)
  }
  if (err) throw err
  process.exit(1)
})
```

对"用户笔误"类的 yargs 错误显示 help 而不是 throw；对 handler 内部抛出的 Error（`err` 非空）则继续抛给外层 try/catch。这种"既保留 yargs 标准 UX，又让业务异常走自己日志管道"的分流写法值得学习。
