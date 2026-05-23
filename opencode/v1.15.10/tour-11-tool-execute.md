# Trace 步骤 11 —— 执行 `read("README.md")`

## 1. 当前情境

上一步 `Permission.evaluate(...)` 在 `read` 工具的默认 ruleset 上落到了 `allow`，没有阻塞主循环、也没有触发交互式询问。控制权穿过 `Tool.Context.ask`，立刻回到 `tool/read.ts` 里那个 `run` 函数 —— 它是 `Tool.define("read", ...)` 返回的 `execute` 之核心。

此时进程里成型的状态：

- `session/tools.ts` 的 `execute(args, options)` 已经被 AI SDK 调起；`args = { filePath: "README.md" }`。
- `Tool.Context` 已绑定 `sessionID`、`messageID`、`callID = options.toolCallId`、`abortSignal`、`messages`。
- assistant 消息里那个 `Part(toolCall, state: "running")` 已写进 SQLite，UI 端订阅者已经收到一次 `MessagePartUpdated`。
- LLM 第一次的 stream 尚未关闭：处理器还在等 `tool-result` 事件回来才能进入下一步。

也就是说，**read 函数现在的输出会变成一条 `Part(toolResult)`，它要回到流里、回到数据库、回到事件总线**。

## 2. 问题

read 工具表面上只是 `fs.readFile(path)` 几行字。但放到 agent 链路里，它必须解决一连串相互纠缠的具体问题：

1. **路径解释**：LLM 大概率传一个相对路径（这次就是 `"README.md"`）。"相对于谁"是个棘手问题——相对于 cwd？worktree 根？session 创建时的 path？答错就读到别的仓库。
2. **越权检查**：即使权限层放行了"读文件"这个操作，也要再确认目标 path 没有越出当前 instance 的 directory。一条 `..` 链就能把 agent 引到 `/etc/passwd`。
3. **大文件不能整体回灌**：README 不大，但同一个 `read` 工具要服务 100 MB 日志的场景；如果整段塞给 LLM，context window 会立刻爆炸。
4. **二进制 / 图片 / 目录**：read 不能假设传进来的就是文本。
5. **结果结构**：不能只回一个字符串。LLM 第二轮要读到"我读到了什么、被截断了吗、文件多大、要不要换 offset 继续"——这些 metadata 缺一不可。
6. **链路状态**：结果要落到一个新 Part 里、要更新到 PartTable、要让订阅 SSE 的进程（包括我们 trace 走的 `opencode run` 自己）马上看到。

## 3. 朴素思路

最直观的写法：

```ts
execute(args) {
  const text = await fs.readFile(args.filePath, "utf-8")
  return text
}
```

外面包一层 try/catch，返回个 `{ ok, text }` 也能让 LLM 用。

## 4. 为什么朴素思路会崩

朴素版每一条问题都会塌：

- **相对路径无解**：`fs.readFile("README.md")` 取的是 Node 进程的 cwd，不是用户的 worktree——`opencode run` 在 `/tmp` 跑都能"成功读到" `/tmp/README.md`。
- **safety hole**：`fs.readFile("../../etc/passwd")` 直接通过。
- **OOM**：模型一句 `read("/var/log/system.log")`，几百 MB 读进 RAM、整段塞回 messages，下一次请求直接爆 token 上限。
- **乱码**：jpg 也好、二进制 `.so` 也好，被当 utf-8 解码后是无意义的"�"洪流，浪费 tokens、误导模型。
- **没有可二次决策的 metadata**：LLM 看不到"被截断了"、"还有 8000 行"，下一轮就会拍脑袋自信地总结。
- **不进总线**：返回字符串以后没人通知 UI、没人写库；UI 上"read README.md"那一行永远停在 `running`。

## 5. opencode 的做法

opencode 把 read 拆成一条**清晰的 8 步流水线**，每一步都对应上面的一个问题。整段代码在 `packages/opencode/src/tool/read.ts:200-332` 的 `run` Effect 里。

<svg viewBox="0 0 760 600" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="read tool 8-step pipeline from path resolve to tool result triple">
  <defs>
    <marker id="art11" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="220" y="16" width="320" height="36" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="38" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">args { filePath, offset?, limit? }</text>
  <path d="M380,54 L380,72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#art11)"/>
  <rect x="40" y="76" width="680" height="412" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="60" y="100" font-size="12" font-weight="700" fill="currentColor">tool/read.ts :: run (Effect)</text>
  <rect x="60" y="110" width="640" height="28" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="76" y="128" font-size="11" fill="currentColor">① 解析路径：isAbsolute? → path.resolve(instance.directory, filepath)</text>
  <text x="690" y="128" text-anchor="end" font-size="10" fill="#64748b">:205-211</text>
  <rect x="60" y="142" width="640" height="28" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="76" y="160" font-size="11" fill="currentColor">② reference.ensure(filepath) 记录"被访问的文件"</text>
  <text x="690" y="160" text-anchor="end" font-size="10" fill="#64748b">:212</text>
  <rect x="60" y="174" width="640" height="28" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="76" y="192" font-size="11" fill="currentColor">③ fs.stat（容忍 NotFound，留给 miss() 做猜建议）</text>
  <text x="690" y="192" text-anchor="end" font-size="10" fill="#64748b">:215-220</text>
  <rect x="60" y="206" width="640" height="28" rx="4" fill="#fff" stroke="#dc2626" stroke-width="1.2"/>
  <text x="76" y="224" font-size="11" fill="currentColor">④ assertExternalDirectoryEffect 越界检查</text>
  <text x="690" y="224" text-anchor="end" font-size="10" fill="#64748b">:222-225</text>
  <rect x="60" y="238" width="640" height="28" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="76" y="256" font-size="11" fill="currentColor">⑤ ctx.ask({ permission: "read", patterns: [...] })</text>
  <text x="690" y="256" text-anchor="end" font-size="10" fill="#64748b">:227-232 ← 第 10 步</text>
  <rect x="60" y="270" width="640" height="76" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="76" y="288" font-size="11" font-weight="600" fill="currentColor">⑥ 三个分支：</text>
  <text x="90" y="305" font-size="10.5" fill="currentColor">• !stat → miss()："did you mean..."</text>
  <text x="690" y="305" text-anchor="end" font-size="10" fill="#64748b">:234</text>
  <text x="90" y="322" font-size="10.5" fill="currentColor">• directory → list() 列目录</text>
  <text x="690" y="322" text-anchor="end" font-size="10" fill="#64748b">:236-262</text>
  <text x="90" y="339" font-size="10.5" fill="currentColor">• 文件 → readSample → mime sniff</text>
  <text x="690" y="339" text-anchor="end" font-size="10" fill="#64748b">:265-269</text>
  <rect x="60" y="350" width="640" height="92" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="76" y="368" font-size="11" font-weight="600" fill="currentColor">⑦ 文件子分支：</text>
  <text x="90" y="385" font-size="10.5" fill="currentColor">• image / PDF → 附件 base64</text>
  <text x="690" y="385" text-anchor="end" font-size="10" fill="#64748b">:270-289</text>
  <text x="90" y="402" font-size="10.5" fill="currentColor">• binary → fail()</text>
  <text x="690" y="402" text-anchor="end" font-size="10" fill="#64748b">:291-293</text>
  <text x="90" y="419" font-size="10.5" fill="currentColor">• text → lines() 流式按行读，撞 50 KB 即停（ReadStop）</text>
  <text x="690" y="419" text-anchor="end" font-size="10" fill="#64748b">:295-315</text>
  <rect x="60" y="446" width="640" height="32" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="76" y="466" font-size="11" font-weight="600" fill="currentColor">⑧ 构造 { title, output, metadata } 三件套</text>
  <text x="690" y="466" text-anchor="end" font-size="10" fill="#64748b">:323-331</text>
  <path d="M380,490 L380,508" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#art11)"/>
  <rect x="120" y="512" width="520" height="40" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="530" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">session/tools.ts:84-114</text>
  <text x="380" y="546" text-anchor="middle" font-size="10" fill="#64748b">把它包成 AI SDK 的 ToolExecution 结果</text>
</svg>
<span class="figure-caption">图 T11.1 ｜ read 工具的 8 步流水线：路径解释 → 越界检查 → 权限询问 → 类型分支 → 流式行读 50KB 截断 → ToolResult 三件套，每一步对应一个真实失败模式。</span>

<details>
<summary>ASCII 原版</summary>

```text
                args { filePath, offset?, limit? }
                              │
                              ▼
   ┌──────────────────────────────────────────────────────┐
   │ 1. 解析路径：path.isAbsolute? → path.resolve(cwd)   │ :205-211
   │ 2. reference.ensure(filepath) 记录"被访问的文件"     │ :212
   │ 3. fs.stat（容忍 NotFound，留给 miss() 做猜建议）   │ :215-220
   │ 4. assertExternalDirectoryEffect 越界检查           │ :222-225
   │ 5. ctx.ask({ permission: "read", patterns: [...] }) │ :227-232 ← 第 10 步
   │ 6. 三个分支：                                        │
   │       - !stat → miss(): "did you mean..."           │ :234
   │       - directory → list() 列目录                   │ :236-262
   │       - 文件 → readSample → mime sniff              │ :265-269
   │ 7. 文件子分支：                                      │
   │       - image / PDF → 附件 base64                   │ :270-289
   │       - binary → fail()                             │ :291-293
   │       - text → lines() 流式按行读，撞 50KB 即停    │ :295-315
   │ 8. 构造 { title, output, metadata } 三件套         │ :323-331
   └──────────────────────────────────────────────────────┘
                              │
                              ▼
   session/tools.ts:84-114 把它包成 AI SDK 的 ToolExecution 结果
```

</details>

几个值得拆开看的设计：

**路径解释——relative to `instance.directory`**。`InstanceState.context` 给出一个 instance 级别的 `directory`，read 用它做 base：

```ts
// tool/read.ts:204-208
const instance = yield* InstanceState.context
let filepath = params.filePath
if (!path.isAbsolute(filepath)) {
  filepath = path.resolve(instance.directory, filepath)
}
```

这里没用 `process.cwd()`——`opencode run` 启动以后 cwd 可能被 yargs middleware 切换过，instance.directory 才是用户语义里的"项目根"。

**越界检查独立成 effect**。`assertExternalDirectoryEffect(ctx, filepath, { bypass, kind })` 在 `tool/external-directory.ts` 实现：默认不允许跨出 `instance.worktree`，除非 caller 提供 `bypassCwdCheck` 或者 reference 表里已经登记过这个 path（比如用户在 prompt 里 `@filename` 引用过）。

**流式 + 双阈值截断**。文本文件不会一次性 `fs.readFile`，而是用 `fs.stream(filepath)` 的 Stream，配合 `Stream.splitLines`，逐行进 buffer，撞到 `MAX_BYTES = 50 KB` 立刻抛 `ReadStop` 标签错误退出（`tool/read.ts:108-151`）。这样无论文件多大，进 LLM 的内容都不会超过 50 KB。

```ts
// tool/read.ts:14-18
const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
```

注意三层限制叠加：单行最长 2000 字符（更长加截断后缀）、默认最多 2000 行、整体上限 50 KB。哪个先到都会停。

**结果不是字符串，是 `ToolResult` 三件套**。read 返回的对象长这样：

```ts
// tool/read.ts:323-331
return {
  title,            // "README.md" 相对 worktree 的 path
  output,           // 拼好的 <path>...</path><type>file</type><content>...</content>
  metadata: {
    preview: file.raw.slice(0, 20).join("\n"),
    truncated,      // boolean
    loaded: loaded.map((i) => i.filepath),
  },
}
```

`output` 里夹了 XML 标签——LLM 在第二轮就能区分"哪段是路径、哪段是内容"。`metadata.truncated` 是给模型的暗号："你看到的不全，要不要发 `read(..., offset=51)` 接着看"。这就是为什么不能直接 `return text`：**ToolResult 是一个会被模型二次解读的协议，不是一段给人看的字符串**。

**README 这次根本没碰截断**。README.md 通常几 KB，`lines()` 跑到最后一行自然结束，`file.cut = false / file.more = false`，输出末尾会拼上 `\n\n(End of file - total N lines)`（`tool/read.ts:312-314`）——这就是给模型的"读完了，别再追"信号。

**回灌路径在 `session/tools.ts`**。read 返回那个 `{ title, output, metadata }` 之后，外层的 AI SDK 包装并不直接写库；它把对象当 `ToolExecutionResult` 抛回 AI SDK 的内部循环，AI SDK 再把它发成一个 `tool-result` 事件进 fullStream（见 `session/llm/ai-sdk.ts:205-218` 里 `toLLMEvents` 的 `case "tool-result"`）。**真正落库**发生在 processor 里：

```ts
// session/processor.ts:452-501 (节选)
case "tool-result": {
  const toolCall = yield* readToolCall(value.id)
  const rawOutput = toolResultOutput(value)
  // ... 图片 normalize ...
  yield* completeToolCall(value.id, output)
}
```

`completeToolCall` 在 `session/processor.ts:168-192`，做的事是用 `session.updatePart` 把同一个 `Part(toolCall)` 的 `state` 从 `running` 翻到 `completed`，把 `output / metadata / title` 写进去，把 `time.end` 盖戳。**不是新插一行**——是覆盖那行的 `state`。

**写库一次 → 总线一次**。`session.updatePart` 内部走的是 `sync.run(MessageV2.Event.PartUpdated, ...)`（`session/session.ts:624-632`）。`sync.run` 既负责把变更落 SQLite，又负责往 Bus 发 `MessagePartUpdated` 事件；订阅 SSE 的 `run` 命令在主进程那一端瞬间拿到事件，于是 stdout 上"read README.md"那一行从 `…` 变成 `✓`。

**为什么 read 不直接返回字符串而是 ToolResult**：

- `output` 给模型读懂内容；
- `metadata.truncated / preview` 给模型决定要不要继续；
- `title` 给 UI 渲染"工具名 + 主参数"那一行；
- `attachments`（image/PDF 才有）走 Part(file) 通道而不是文字流，免得 base64 污染对话。

这套四元组就是 opencode 在工具系统的"输出标准协议"。

## 6. 代码位置

按本步骤的执行顺序：

- `packages/opencode/src/tool/read.ts:14-20` — 截断阈值常量（`MAX_BYTES = 50 * 1024`、`DEFAULT_READ_LIMIT = 2000`）。
- `packages/opencode/src/tool/read.ts:29-37` — `Parameters` schema：`filePath` 必填、`offset / limit` 可选。
- `packages/opencode/src/tool/read.ts:200-211` — 路径解析（相对 → `instance.directory`，win32 normalize）。
- `packages/opencode/src/tool/read.ts:212` — `reference.ensure(filepath)`：登记到"已访问"表。
- `packages/opencode/src/tool/read.ts:215-225` — `fs.stat` + `assertExternalDirectoryEffect` 越界检查。
- `packages/opencode/src/tool/read.ts:227-232` — `ctx.ask({ permission: "read", ... })`：这是第 10 步真正命中的入口。
- `packages/opencode/src/tool/read.ts:236-262` — directory 分支（README.md 不走这）。
- `packages/opencode/src/tool/read.ts:265-289` — image / PDF 嗅探与附件路径。
- `packages/opencode/src/tool/read.ts:108-151` — `lines()`：Stream-based 行读 + `ReadStop` 提前终止。
- `packages/opencode/src/tool/read.ts:295-321` — 拼 `output` 字符串：`<path>` / `<type>` / `<content>` / 截断尾注。
- `packages/opencode/src/tool/read.ts:323-331` — 返回 `ToolResult` 三件套。
- `packages/opencode/src/tool/truncate.ts:17-27` — 公共 `MAX_LINES / MAX_BYTES`（read 在自己文件里独立维护一份给文本路径用，跟 truncate.ts 的常量值对齐）。
- `packages/opencode/src/tool/truncate.ts:86-142` — 通用 `output()`：被 MCP 工具用、shell 输出用；read 自己不调它，但 read 的设计动机和它一样。
- `packages/opencode/src/tool/truncation-dir.ts:4` — `TRUNCATION_DIR = Global.Path.data + "tool-output"`：被截断的完整输出落盘的地方。
- `packages/opencode/src/session/tools.ts:84-114` — AI SDK 视角的 `execute` 包装：调 plugin hook、调真正的 `item.execute`、附件打 PartID。
- `packages/opencode/src/session/processor.ts:452-501` — 接到 `tool-result` 事件后的处理：图片 normalize → `completeToolCall`。
- `packages/opencode/src/session/processor.ts:168-192` — `completeToolCall`：把同一行 `Part(toolCall)` 翻成 `state: "completed"`。
- `packages/opencode/src/session/session.ts:624-632` — `updatePart` 调 `sync.run(PartUpdated, ...)`：落库 + 发总线。
- `packages/opencode/src/storage/storage.ts:302-305` — Storage 的 `write` 实现（JSON 路径的兜底，主路径是 SQLite）。
- `packages/opencode/src/bus/index.ts:100-121` — `publish`：把 `MessagePartUpdated` 喂给本地 PubSub 和 GlobalBus。

## 7. 分支与延伸

- **其它内置工具**：read 是文件读取的一员，glob / grep / lsp 三件套的设计权衡见 [第 07 章 §7.3.1 文件读取与搜索](07-tool-system.md#731-文件读取与搜索)。
- **截断子系统**：read 自己写了一份精简版 lines；通用的 `Truncate.Service` 服务于 shell / MCP / repo_overview 等输出更不可控的工具，见 [第 07 章 §7.6 输出截断](07-tool-system.md#76-输出截断truncatets-与-truncation-dirts)。
- **execution pipeline**：从 `tool-input-start` 到 `tool-result` 落库的全过程见 [第 07 章 §7.5 Execution Pipeline](07-tool-system.md#75-execution-pipeline从-tool_call-到-toolresult)。
- **流式 Part 与增量更新**：read 的 ToolResult 是一次性写入；但同一个 `Part(toolCall)` 历经 `pending → running → completed` 三态，是流式 Part 模型的典型例子，参见 [第 03 章 §流式 Part 与增量更新](03-session-and-messages.md#流式-part-与增量更新)。
- **SSE 怎么把这个 PartUpdated 转给 stdout**：将在第 14、15 步细讲。事件本身在 `bus/index.ts` 发布、订阅在 `server` / `run` 命令侧；见 [第 10 章 §SSE](10-server-and-sse.md#sse-推流)（章节暂未撰写，按计划属第 10 章）。
- **`reference.ensure`**：被 `@filename` 语法引用过的文件会进 reference 表，read 就允许 bypass `assertExternalDirectoryEffect`——这是 opencode "用户显式授权"的一个细分入口。
- **`isBinaryFile` 启发式**：扩展名黑名单 + 非可打印字节占比 > 30% 双重判定（`tool/read.ts:153-198`），简单粗暴但够用。

## 8. 走完这一步你脑子里应该多了什么

1. **`read("README.md")` 不是一行 `fs.readFile`**——它是路径解释、越界检查、流式行读、截断尾注、metadata 打包一整条流水线，每一步都对应一个真实失败模式。
2. **ToolResult 是一个协议而不是一个字符串**：`{ title, output, metadata, attachments? }` 四元组分别服务于模型理解、UI 渲染、模型二次决策、二进制附件。
3. **路径相对的是 `InstanceState.context.directory`**，不是 `process.cwd()`——这就是为什么从任何目录跑 `opencode run` 都"知道"项目根。
4. **流式行读 + 50 KB 上限**让 read 在面对 1 GB 日志时也不会拖垮进程，模型靠 `metadata.truncated + offset` 决定要不要继续。
5. **读完不是结束**：return 出去的 `ToolResult` 经 AI SDK → `tool-result` 事件 → `processor.completeToolCall` → `session.updatePart` → `sync.run(PartUpdated)` 一路流回 SQLite 和 Bus；那个原本 `state: "running"` 的 Part 现在 `state: "completed"`，UI 上的灰色圆点变绿了。
6. **下一步起点**：assistant 消息现在含三段：`text("Let me read...") + toolCall(read, args) + toolResult(README 内容)`。第一次 LLM stream 即将关闭、agent 循环必须把这三段连同 user 一起拼回 messages，再发第二次 LLM 请求——这就是第 12 步要做的事。

下一步：[Trace 步骤 12 —— 工具结果回灌](tour-12-result-loopback.md)
