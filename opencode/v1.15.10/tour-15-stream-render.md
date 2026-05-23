# Trace 步骤 15 —— 渲染到终端 / stdout

## 1. 当前情境

上一步（第 14 步）里，最后一片 text part 已经写进 `PartTable`、`SessionTable.cost / tokens_*` 也累加进去了。bus 上发出了它的 `message.part.updated` 事件，进程内嵌 server 的 SSE handler 把这条事件编码成 `data: {"type":"message.part.updated",...}\n\n` 推给所有连着 `/event` 的客户端。

而本 trace 的客户端就是 run CLI 自己。

回到 run 进程的视角：

- 第 02 步时，run handler 已经创建了一个本地 `OpencodeClient` 实例（默认走进程内 fetch），并在 `execute(sdk)` 里 `await client.event.subscribe()` 拿到一个 `events` 对象。
- 第 04 步真正发请求之前，run 已经 `loop(client, events)` 起了一个并行的 async iterator 在消费 SSE。
- 从第 07 步开始的每一个 part 都被 loop 收到、判断、渲染。

进入本步骤时，run 进程的状态是：

- 一个 `for await (const event of events.stream)` 循环在另一根 async fiber 上转着。
- 一个 `toggles` Map 记着哪些 toggle（"第一次打 assistant 标题"、"task subagent 标题"）已经触发过了。
- stdout 已经先后被写过这些行：
  - `> bash · anthropic/claude-3.7-sonnet`（assistant 第一条 `message.updated` 时打的）
  - `⚙ read README.md`（tool 进入 completed 时由 `tool()` 异步打的）
  - `(空行) README.md 内容总结...（空行）`（最终 text part `time.end` 时由 `UI.println` 打的）

本步骤要把"这条 SSE 怎么变成终端字符"讲清楚——以及为什么 run 不直接 `Database.use(db => ...)` 查库，而要走一遍 HTTP + SSE 的远路。

## 2. 问题

run 是个 CLI，写 stdout；它要把后端 agent 的进展告诉用户。具体要解决：

1. **流式 text 增量打印**：用户看到的应该是"一段段文字逐渐冒出来"，不是 "agent 完事了一次性吐 800 字"。
2. **工具调用要有可见的痕迹**：用户必须知道 agent 调过 `read("README.md")`，否则它"读了什么文件"就是黑盒。
3. **错误要红色高亮**：tool 失败 / API 报错都要标记成 `✗ ... failed` 而不是默默无视。
4. **格式可切换**：人类用户要好看的彩色输出；脚本管道（`opencode run ... | jq`）要 JSON 一行一条。
5. **不能阻塞 prompt**：发送 prompt 的请求要立刻发出去，事件流要在另一条 fiber 上跟着跑——否则 stdout 输出会被请求 round-trip 卡住。

## 3. 朴素思路

朴素 CLI 写法两条路：

```ts
// 路 A：直接调 Session 模块
const result = await Session.runPrompt({ ... })   // 等它跑完
console.log(result.text)
```

或者，意识到要流式：

```ts
// 路 B：直接订阅 in-process bus
Bus.subscribe(MessageV2.Event.PartUpdated, (e) => {
  if (e.part.type === "text") process.stdout.write(e.part.text)
})
await Session.runPrompt({ ... })
```

或者，意识到本地有数据库：

```ts
// 路 C：每个 tick 查一次库
setInterval(() => {
  const parts = db.select().from(PartTable)...
  diff = parts.slice(lastSeen)
  print(diff)
}, 50)
```

都能跑通。Bus 订阅尤其干净——本进程里 bus 就在那，本来 PubSub 就专门为这个设计的。

## 4. 为什么朴素思路会崩

路 A 失败模式最明显——丢了流式体验。一个 30 秒的回答用户面对 30 秒空屏，绝对受不了。

路 B 看似优美，但有四个问题：

1. **未来的 `--attach`**：opencode 支持 `opencode run --attach https://remote:4096 "..."` 连远端 server。如果 run 的渲染逻辑写死走 in-process bus，attach 模式就要再写一份"基于 HTTP SSE 的复制品"，两条路径并行维护，必然漂移。
2. **同一份 stream，多消费者**：interactive TUI 也要消费这些事件，desktop GUI 也要，web 也要。如果每个客户端都直接调 bus，意味着每个客户端都得在同一个进程里——但 desktop 不一定。
3. **bus 没有断线重连语义**：Bus 是 `PubSub.unbounded`，订阅者断了再连，错过的事件就丢了；SSE 协议本身有 retry / last-event-id 这套约定（参见 `serverSentEvents.gen.ts:67-72` 的 StreamEvent 结构），SDK 帮你 handle。
4. **Bus 的事件 schema 是 effect Schema，渲染层不应直接耦合到内部 schema**：通过 SSE + SDK 出口，event payload 走的是 OpenAPI 描述的稳定 schema，对未来"用别的语言写 client"（已经有 sdk/go 路径）友好。

路 C（轮询库）成本完全不可接受——SQLite 每 50ms 全表扫一次，并且会和 writer 抢锁。

opencode 的选择是"run 也是一个 client"——它**通过 SDK 连本进程嵌的 server**，等价于远端客户端，只是 fetch 实现被换成了内存 hand-off。

## 5. opencode 的做法

run 进程在 `execute(sdk)` 里干这两件事，**顺序很关键**：

```ts
// run.ts:768-803 简化
const events = await client.event.subscribe()       // ① 先订阅，建立 SSE 长连接
loop(client, events).catch(...)                     // ② 起 async loop 消费事件
const result = await client.session.prompt({        // ③ 才发 prompt
  sessionID, agent, model, parts: [...files, { type: "text", text: message }],
})
```

为什么是这个顺序——`event.subscribe()` 必须早于 `session.prompt()`：服务端在收到 prompt 那一刻就会立刻 publish 第一波 `session.status: busy`，如果 subscribe 晚一步，那条事件就丢了。SDK 在这一层用的是 **eager subscription**：HTTP GET `/event` 在 `await` 这一行就发出去了，server 端在 `handlers/event.ts:27` 收到请求时就立即调 `bus.subscribeAll()` 并把订阅锁在请求 scope 里（注释里 `events.ts:23-26` 专门说明 "subscribe eagerly... close the race where Stream.concat used to drop publishes in the prefix-consume window"）。

`loop()` 主体就是一个 `for await` 在 SSE async iterator 上转（`run.ts:641-757`）。每个 event 进来按 type dispatch：

- `message.updated`：当 role 是 assistant 且第一次见到时，打出 `> bash · anthropic/claude-3.7-sonnet` 这一行作为对话开头标题（`run.ts:642-653`）。
- `message.part.updated`：这是主力分支（`run.ts:655-714`），按 part.type 再分：
  - `tool` 且 `state.status === "completed"`：调 `await tool(part)`，进而调 `toolInlineInfo(part)`（`run.ts:91-107`）。这函数在 `cli/cmd/run/tool.ts:1303` 定义，本质是"每种工具一条 inline 规则"——`read` 工具有自己的 rule，会把 path 抽出来画成 `⚙ Read README.md`；rule 找不到时回落 `fallbackInline`。
  - `tool` 且 `state.status === "error"`：换成 `✗ Read README.md failed` 加 stderr。
  - `text` 且 `part.time?.end` 已经有值：表示这片 text 已经流完，调 `UI.println(text)` 写成块。注意——run 的默认模式**不是按 token 流式打**，而是 part 关闭后一次性 println（`run.ts:688-699`）。TUI 是按 PartDelta 实时跑的，run 没接 PartDelta。
  - `reasoning` 同 text，但有 `--thinking` 开关控制（`run.ts:701-713`）。
  - `step-start` / `step-finish`：只在 `--format json` 模式下转发出去（`run.ts:680-686`）。
- `session.error`：打 `UI.error(err)`（`run.ts:716-726`）。
- `session.status` 且 `status.type === "idle"`：`break` 出 for-await（`run.ts:728-734`）——这是 loop 结束的唯一正常出口，下一步要讲。
- `permission.asked`：非交互模式默认 `auto-reject`，除非 `--dangerously-skip-permissions` 才走 `auto-allow`（`run.ts:736-756`）。

`UI.println` / `UI.empty` / `UI.error` 在 `cli/ui.ts:31-47, 121-126`——本质就是 `process.stdout.write(message + EOL)` 加颜色代码（`Style.TEXT_DIM`、`Style.TEXT_DANGER_BOLD`）。`UI.empty` 写一个空行做视觉间隔。

`--format json` 走的是 `emit(type, data)`（`run.ts:618-631`）：把每个事件原样序列化成 JSON 一行写 stdout，**不**走人类格式分支。run 自己在 each branch 第一行先 `if (emit(...)) continue`——意思是 JSON 模式下 emit 返回 true，后面的格式化跳过；默认模式下 emit 返回 false，往下走 UI.println。这是同一个 loop 适配两种输出的小技巧。

整体形状：

```text
   ┌───────────────────────────────────────────────────────┐
   │ run process                                           │
   │                                                       │
   │  ① await client.event.subscribe()                     │
   │     │                                                 │
   │     ▼                                                 │
   │  HTTP GET /event  (in-process fetch → server.fetch)   │
   │     │                                                 │
   │     ▼                                                 │
   │  bus.subscribeAll()   (scope 锁在请求 scope)          │
   │     │                                                 │
   │     │  ② Sse.encode 流持续 push 事件                  │
   │     │                                                 │
   │  ③ for await (event of events.stream)                 │
   │       │                                               │
   │       ├─ message.updated      → 打标题                │
   │       ├─ message.part.updated → tool/text/reasoning   │
   │       ├─ session.error        → UI.error              │
   │       ├─ session.status idle  → break                 │
   │       └─ permission.asked     → auto reply            │
   └───────────────────────────────────────────────────────┘
```

对本 trace，loop 在第二次 LLM 完成时拿到一连串事件：

1. `message.part.updated` part.type=text, time.end=... → `UI.empty(); UI.println("README.md 是 ...一段总结..."); UI.empty()`
2. `message.part.updated` part.type=step-finish → 非 JSON 模式被忽略
3. `message.updated` 最终态 → 已经打过标题不再触发
4. `session.status status.type=idle` → `break`

loop 函数 return（带回可能的 error 字符串），但**进程不退出**——下一步要讲。

`process.stdout.isTTY` 在第 692-695 行被用来区分 piped vs TTY：管道里写纯文本不加空行，TTY 加空行视觉分隔。

## 6. 代码位置

按订阅与渲染顺序：

- `packages/opencode/src/cli/cmd/run.ts:768-773` —— `client.event.subscribe()` + 起 loop。**必须早于 prompt**。
- `packages/opencode/src/cli/cmd/run.ts:792-803` —— `client.session.prompt(...)` 真正发请求；同一个进程通过 in-process fetch 走到 server handler。
- `packages/opencode/src/cli/cmd/run.ts:874-878` —— `createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn })`：注意 baseUrl 是假的，fetch 被替换成 `Server.Default().app.fetch(request)`，直接把请求交给 server 而不走真实网络。
- `packages/opencode/src/cli/cmd/run.ts:637-758` —— `loop()` 函数主体；分支齐全。
- `packages/opencode/src/cli/cmd/run.ts:91-125` —— `tool()` / `toolError()`：薄包装，`await import("./run/tool")` 是为了延迟加载这个 1400 行的渲染规则文件。
- `packages/opencode/src/cli/cmd/run/tool.ts:1303-1315` —— `toolInlineInfo`：按 tool name 在 rule 表里查，找不到回 `fallbackInline`。
- `packages/opencode/src/cli/cmd/run/tool.ts:1262-1291` —— `toolFrame` / `toolView`：从 `ToolPart` 拼出渲染上下文。
- `packages/opencode/src/cli/ui.ts:14-29` —— `Style` 表：ANSI 颜色常量。
- `packages/opencode/src/cli/ui.ts:31-47, 121-126` —— `println` / `print` / `empty` / `error`：所有终端输出的实际写入点。
- `packages/sdk/js/src/v2/gen/sdk.gen.ts:601-630` —— `Event.subscribe()`：SDK 暴露的 SSE 入口；本质 `this.client.sse.get({ url: "/event" })`。
- `packages/sdk/js/src/v2/gen/core/serverSentEvents.gen.ts:67-99` —— SSE client：retry / lastEventId / `createStream` async generator。SDK 帮你做了断线重连、解析 `data:` 行、yield JSON-parsed event。
- `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:21-54` —— server 端 `/event` handler：`bus.subscribeAll()` → `Sse.encode()` → HTTP body。注意它在请求 scope 内 eager subscribe（注释 `:23-26`）。

## 7. 分支与延伸

- **TUI 的渲染对比 run**：TUI 走 React + opentui，订阅同一份 bus 但是直接 in-process（不绕 SSE），并且消费 `PartDelta` 做 token 级流式；见 [第 09 章 §9.5 事件订阅：bus → TUI](09-tui.md#95-事件订阅bus--tui) 和 [§9.6 消息渲染：route/session/index.tsx](09-tui.md#96-消息渲染routesessionindextsx)。run 与 TUI 共享的就是 bus 事件 schema；分歧在"用 SSE 还是直连"。
- **SSE 协议 & 客户端 SDK**：见 [第 10 章 §10.5 SSE：实时事件流](10-server.md#105-sse实时事件流)、[§10.13 客户端 SDK：`@opencode-ai/sdk`](10-server.md#1013-客户端-sdkopencode-aisdk)。
- **for await SDK 这种范式哪里来**：`@hey-api/client` 帮你把 `text/event-stream` 包装成 async generator——这是 `packages/sdk/js/src/v2/gen/core/serverSentEvents.gen.ts` 的核心。
- **run 子命令的全部分支**：`--interactive`、`--attach`、`--format json`、`--continue`、`--session`、`--fork`、`--command`，见 [第 01 章 §1.6 run 子命令深挖](01-entrypoints.md#16-run-子命令深挖)。
- **`--attach` 怎么把 fetch 换成真网络**：`run.ts:326-332` 的 `attachSDK(dir)`：baseUrl 改成 `args.attach` URL，fetch 走默认 `globalThis.fetch`，loop 和渲染代码**一字未改**——这就是"run 也是 client"的红利。
- **per-tool 渲染规则在哪**：`cli/cmd/run/tool.ts` 上千行 rule 注册；它复用了 TUI 那边的 toolFrame/toolView 抽象，所以 run 和 TUI 的工具显示风格基本一致。

## 8. 走完这一步你脑子里应该多了什么

1. **run 不是直接读数据库，而是 SSE 客户端**——它和 web / desktop / `opencode run --attach` 走完全同一条管道，仅 fetch 实现不同。这是"in-process 但走完整 client 路径"的设计红利。
2. **`event.subscribe()` 必须早于 `session.prompt()`**——否则 `session.status: busy` 这种首个事件会丢，loop 永远等不到 idle。server 端用 eager subscribe（在请求 scope 内立刻订阅 bus）来保证不丢失"prefix"事件。
3. **run 默认是 part 级流式，不是 token 级**——text part 等 `time.end` 才打成块；TUI 才接 `PartDelta` 做 token 级。这是个有意的产品取舍：run 输出要适合 piped 给其他命令，连续 token 流不好处理。
4. **`--format json` 与默认彩色模式同一条 loop**——靠每分支第一行 `if (emit(...)) continue` 双轨；不存在两个 loop 实现。
5. **走到这一步，stdout 已经吐完了 assistant 的最终回答**——loop 还没退，它正阻塞在 `for await` 上等 `session.status: idle` 事件。下一步进入第 16 步：idle 事件到来、loop break、进程清理、退出码、`process.exit()`。

下一步：[Trace 步骤 16 —— 会话 idle 与进程退出](tour-16-idle-and-exit.md)
