# Trace 步骤 16 —— 会话 idle 与进程退出

## 1. 当前情境

上一步（第 15 步）里，run 进程的 `loop()` 函数已经把 assistant 的最终回答写到了 stdout，但 loop 本身**没退出**——它现在阻塞在 `for await (const event of events.stream)` 上，等下一个 SSE event。

服务端的视角：第二次 LLM stream 的最后一片 chunk 已经过去；`SessionProcessor.process()` 函数体已经走完 `Stream.runDrain` 一行（`processor.ts:795`）；外层 `runLoop` 没有发现 `shouldBreak === false` 且 `needsCompaction === false`，循环不再继续；整个 prompt 的 Effect 走到了尽头，`SessionRunState` 内部 Runner 的工作 fiber 即将进入 `onIdle` 回调。

进入本步骤的可见状态：

- Runner 状态：busy → 即将转 idle。
- `SessionStatus.set(sessionID, { type: "idle" })` 即将被调用。
- `SessionTable.cost / tokens_*` 几列已经在第 14 步累加完成；下一次 `opencode stats` 直接能读到。
- run 进程：SSE long-poll 还连着，loop fiber 在 `for await` 上 idle wait；主 fiber 已经 `await client.session.prompt(...)` 返回（一旦 server handler 把 prompt 推到 background 就立刻返回 200，没有等 LLM 跑完）。
- `~/.opencode/opencode.db` 文件已经存在；`migration` marker 也写了。

本步骤要把以下几件事讲透：

1. server 怎么发出 idle 信号。
2. run 进程怎么接到 idle 信号、退出 loop、做清理。
3. `process.exit()` 在 `index.ts` finally 里为什么是必要的。
4. 下次启动这个进程时数据库的状态是什么。

## 2. 问题

CLI 进程退出听起来天经地义——但 opencode 这个特定形态有几个具体麻烦：

1. **agent 退出 ≠ 进程退出**：server 不知道 "用户是 run 这种一次性 CLI" 还是 "用户是开着 TUI 还会再发第二轮"。所以服务端只能广播 "这个 session 现在 idle 了"，**让客户端自己决定退不退**。
2. **subprocess 不响应 SIGTERM**：opencode 启动过的子进程包括 docker 化的 MCP server、ripgrep 子进程、shell 工具进程。Node/Bun 主进程退出时这些 child 不一定会跟着死，整个进程就会僵死在那儿——这是开发者最痛恨的"CLI 退不出"。
3. **退出码语义要清晰**：脚本 `opencode run "..." && echo done` 必须依赖退出码；任何中间错误（API key 错、LLM 返回 error、tool 执行失败）都该让退出码非 0。
4. **cost / tokens 状态不能丢**：用户跑完想看 `opencode stats`，那张表必须在进程退出前 commit 完成；否则下次启动看到的会是 stale 数字。

## 3. 朴素思路

朴素 CLI 写法：

```ts
// pseudo
await runEverything()
process.exit(0)
```

或者更激进：

```ts
// 让 Node 自己判断
await runEverything()
// 没人写 exit；事件循环空了 Node 自己退
```

或者再朴素一点：

```ts
on('SIGTERM', () => process.exit(0))
// 等用户 Ctrl-C
```

直觉上都没毛病。

## 4. 为什么朴素思路会崩

把"等 Node 自己退"作为退出条件，**对 opencode 不成立**：

1. **MCP docker container**：`docker run` 启动的 MCP server 子进程，不被 `--init` 包的话不会传 SIGTERM 给 PID 1。Bun 主进程的事件循环明明已经空了（没人持有 timer、socket 也都关了），但 stdio 还连在 docker 子进程上，子进程不死、stdio 不关、Bun 不退。终端就那么干等着。
2. **SSE 长连接的 keepalive 心跳**：server 每 10 秒发 `server.heartbeat` 事件（`server/routes/instance/httpapi/handlers/event.ts:30-33`）；只要 SSE 还连着这个心跳就在跑——一个 `setInterval` 永远不会让 Node 自己退。
3. **依赖 SIGTERM**：run 是非交互、没有人按 Ctrl-C；server 也不会自杀。**没人发 signal，靠 signal 就死锁了。**

把"等 server 退"作为条件也不对——server 是同进程嵌的，在 run 模式下它就是为这一次 prompt 跑的临时 server，但 server 自身不知道"我的客户端是一次性的"。这种生命周期由谁来定，opencode 选择的是 **run 自己决定**：run 看到 idle 就主动断开 + 主动 exit。

## 5. opencode 的做法

整个收尾分四层。

**第一层：server 侧发 idle 事件**

`runLoop` 的最外层 effect 跑完后，`SessionRunState.runner` 注册的 `onIdle` 回调被触发（`session/run-state.ts:58-65`）：

```ts
const next = Runner.make(data.scope, {
  onIdle: Effect.gen(function* () {
    data.runners.delete(sessionID)
    yield* status.set(sessionID, { type: "idle" })
  }),
  onBusy: status.set(sessionID, { type: "busy" }),
  onInterrupt,
})
```

`status.set(sessionID, { type: "idle" })` 内部做了三件事（`session/status.ts:77-86`）：

1. 发 `session.status` 事件，payload `{ status: { type: "idle" } }`。
2. 因为 `status.type === "idle"`，**再额外发**一个老的 `session.idle` 事件（`Event.Idle`）做向后兼容。
3. 把 sessionID 从内存 status Map 里 delete 掉。

这两个事件都流入 bus；bus 通过 `bus.subscribeAll()` 推给 `/event` SSE handler；handler 用 `Sse.encode()` 编码成 `data: {"type":"session.status",...}\n\n` 写进 HTTP body。

**第二层：run 侧 loop break**

`run.ts:728-734` 这段是 loop 的退出条件：

```ts
if (
  event.type === "session.status" &&
  event.properties.sessionID === sessionID &&
  event.properties.status.type === "idle"
) {
  break
}
```

注意它只在 `event.type === "session.status"` 上 break——不监听老的 `session.idle`。前者是新的、带完整 status info 的事件；后者是给老客户端兼容用的。这是个细节但很重要：新版 run + 老版 server，run 也能正常工作。

break 后 loop 函数 return。它返回的可能是 `undefined` 或 累积下来的 error 字符串（`run.ts:639` 声明的 `let error: string | undefined`）。

**第三层：execute / handler 收尾**

`execute()` 函数的最外层（`run.ts:768-803`）几件事并行：`loop()` 是 fire-and-forget 起的（没 `await`，靠 `.catch(e => process.exit(1))` 兜底），`await client.session.prompt(...)` 才是主路径——server 端 prompt handler 等到 RunState 进入 idle 才完成 HTTP response，所以这一 `await` 自然阻塞到全部流式完成。如果 prompt 本身报错（API key 无效、provider 拒绝），`result.error` 非空，run 设 `process.exitCode = 1`（注意只设不 exit，真正退出在 finally）。普通工具失败不会让它非空，因为那些是 agent 内部状态的一部分而非 prompt API 错误。

execute 返回后 `handler` 的 Effect 也跟着完成，yargs 的 `cli.parse()` await 链解开，回到 `index.ts:203`。

**第四层：`process.exit()` 在 finally**

`packages/opencode/src/index.ts:245-251`：

```ts
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
```

这段在 [Trace 步骤 01](tour-01-shell-entry.md) 里已经埋过伏笔——当时只解释了"为什么需要"，现在它真的起作用：

- `process.exit()` 不带 argument，使用之前累积的 `process.exitCode`。正常路径 exitCode 没被设置，默认 0；prompt 报错路径设了 1。
- `process.exit()` 立即终止进程，**不等 pending 的 await / timer / open socket**。SSE 长连接、heartbeat interval、MCP docker 子进程的 stdio 全部一刀切。
- catch 块和 finally 块的顺序保证：异常 → 打日志（`Log.Default.error("fatal", data)`）→ exitCode = 1 → finally exit。无异常 → finally exit 拿到默认 exitCode 0。

**第五层：副作用沉淀，下次启动直接复用**

到这一刻磁盘上的状态：

- `~/.opencode/opencode.db`：完整 SessionTable / MessageTable / PartTable / EventSequenceTable。SessionTable 这一行的 `cost / tokens_*` 已经累计了本次跑两轮 LLM 的成本。
- `~/.opencode/storage/migration`：旧的 file storage 的 migration marker（沿用至今，与 SQLite 无关）。
- `~/.opencode/opencode.db` 这个文件本身就是"JSON 迁移已经跑过"的 marker（见 [Trace 步骤 01 §5](tour-01-shell-entry.md#5-opencode-的做法) 那段 `if (!Filesystem.exists(marker)) JsonMigration.run()`）。

下次执行 `opencode run "..."`：

- middleware 看到 `opencode.db` 已存在，跳过 JSON 迁移。
- `Database.Client()` 直接打开，跑增量 SQL migration（如有），然后立刻可用。
- 启动到第一次 LLM 请求的时间约 1 秒级。

如果用户接着想看花了多少钱：

```bash
$ opencode stats
```

`cli/cmd/stats.ts:84` 直接 `db.select().from(SessionTable).all()` 把所有 session 拿出来，按 `session.cost` / `session.tokens` 做聚合（`stats.ts:170-200`）——这条数据路径**完全独立于 bus / SSE**，纯 SQL 查询；本次 trace 第 14 步在 projector 里 SQL `${cost} + ${value.cost}` 累加上去的数字，stats 这里直接读出来。两条路径靠 `SessionTable.cost` 这一列作为唯一事实源。

## 6. 代码位置

按事件发生顺序：

- `packages/opencode/src/session/run-state.ts:58-65` —— Runner 的 `onIdle` 回调：删 runner、`status.set(sessionID, { type: "idle" })`。
- `packages/opencode/src/session/status.ts:77-86` —— `set()`：publish `Event.Status` + 当 idle 时再 publish 老的 `Event.Idle`，并从内存 Map 删 sessionID。
- `packages/opencode/src/session/status.ts:34-48` —— `Event.Status` 和 `Event.Idle` 两个 bus event 的 schema 定义。注释里写着 `// deprecated` 提醒 Idle 是兼容遗物。
- `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:21-54` —— `/event` handler 把 bus 事件编码进 SSE；`Stream.takeUntil(event => event.type === Bus.InstanceDisposed.type)` 决定何时关闭 SSE。
- `packages/opencode/src/cli/cmd/run.ts:728-734` —— loop 里的 idle break 条件。注意只匹配 `session.status` + `status.type === "idle"`，不读老的 `session.idle`。
- `packages/opencode/src/cli/cmd/run.ts:768-803` —— execute() 主路径：起 loop（fire-and-forget）+ await prompt + 按 `result.error` 设 exitCode。
- `packages/opencode/src/cli/cmd/run.ts:770-773` —— `loop(...).catch(e => process.exit(1))`：loop 内部抛出（不是正常 break）就直接进程死。
- `packages/opencode/src/index.ts:245-251` —— `finally { process.exit() }`：本步骤的"硬退出"，附带 MCP docker 的注释。
- `packages/opencode/src/session/session.sql.ts:36-41` —— `SessionTable.cost / tokens_input / tokens_output / tokens_reasoning / tokens_cache_read / tokens_cache_write` 六列；它们在第 14 步累加，本步骤进程结束前已经 commit 到 WAL。
- `packages/opencode/src/cli/cmd/stats.ts:51-100, 170-200` —— `opencode stats` 命令实现：直接 SQL 查询 `SessionTable` + 遍历 message 做按模型聚合，**完全旁路 bus**。
- `packages/opencode/src/storage/db.ts:142-146` —— `close()`：清掉 client 单例并关闭 SQLite 连接。run 路径下其实不会专门调它——`process.exit()` 一刀切，Bun 在退出时会关闭 fd；WAL 模式下未 commit 数据已经在 `Database.transaction` 内同步落盘，没有数据风险。

## 7. 分支与延伸

- **事件发布 / Session idle 的完整定义**：见 [第 05 章 §5.10 事件总线：谁在被通知](05-agent-loop.md#510-事件总线谁在被通知)；那一节列了"哪个事件由谁发、谁订阅"。本步骤的 `Event.Status` / `Event.Idle` 是该清单上 idle 类的两个。
- **`opencode stats` 怎么把 cost 拿来给用户看**：见 [第 13 章 §13.7 成本统计](13-advanced-features.md#137-成本统计)；那里讲了 `stats` 命令的字段、`--days` 过滤、`opencode stats --json` 输出。
- **`finally { process.exit() }` 的故事**：见 [Trace 步骤 01 §`index.ts:245-251`](tour-01-shell-entry.md#5-opencode-的做法)；第 1 步给了"为什么需要"，本步骤给"它真的起作用"。两步合起来是完整闭环。
- **TUI 的"会话 idle"长什么样**：TUI 进程拿到 `session.status: idle` 不会退出，会让输入框重新可用——见 [第 09 章 §9.5 事件订阅：bus → TUI](09-tui.md#95-事件订阅bus--tui)、[§9.12 退出与持久化](09-tui.md#912-退出与持久化)。
- **interactive run（`opencode run -i`）的退出路径**：和本 trace 不同——`runInteractiveMode` 自己管 idle，进入 `for (;;) { await read input; await prompt; ... }` 循环。本 trace 的非交互路径只处理一次 prompt。
- **`--continue` / `--session` 的复用**：下次启动用 `opencode run -c "...继续上一轮"`，会读 SessionTable 找到最近的 session，cost 接着上次的数字累计。这一切都来自本步骤"已经写完且 commit"的事实。

## 8. 走完这一步你脑子里应该多了什么

1. **"agent 跑完" 和 "进程退出" 是两个独立决策**——server 只负责广播 idle；client 自己决定退不退。这是 opencode "in-process server + same-process client" 这种诡异结构能复用同一份 server 代码（不论是被 TUI 还是 run 还是 attach 调用）的关键。
2. **idle 事件发了两个：新的 `session.status` 和老的 `session.idle`**——新代码只读前者，后者是兼容遗物。client / server 跨版本就靠这种"双发"过渡。
3. **`process.exit()` 在 finally 里是硬性必需的**——MCP docker / SSE heartbeat / 任何不响应 SIGTERM 的子进程都会让 Bun 主进程的事件循环不空，只有显式 exit 能斩断。
4. **退出码从 `process.exitCode` 拿**——loop 正常 break 时 exitCode 是默认 0；prompt 错时被设为 1；任何阶段 `process.exit(1)` 是立刻死。脚本组合用 `&&` / `||` 完全靠这一条。
5. **`SessionTable.cost / tokens_*` 是单事实源**——第 14 步 projector 用 SQL 表达式累加，第 16 步进程退出前已 commit；`opencode stats` 下次启动直接读这张表，不靠任何运行时状态。
6. **下次 `opencode run "..."` 启动**：`~/.opencode/opencode.db` marker 已在，JSON 迁移跳过；启动到首请求大约 1 秒级。这条链路的所有环节，从入口 → run 分派 → 配置加载 → SQLite 初始化 → 创建 session → ... → idle 退出，你已经走过一遍。

回到总览：[Trace 导览总览](tour-00-overview.md)
