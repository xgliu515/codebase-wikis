## 1. 当前情境

step 13 已经把 `ClaudeProvider.query()` 调完。`poll-loop.ts:170-184` 现在持有一个 `AgentQuery` handle：

```ts
const query = config.provider.query({ prompt, continuation, cwd, systemContext });
// …
setCurrentInReplyTo(routing.inReplyTo);
try {
  const result = await processQuery(query, routing, processingIds, config.providerName);
  // …
}
```

`AgentQuery` 长这样（`providers/types.ts:68-80`）：

```ts
interface AgentQuery {
  push(message: string): void;       // 把 follow-up user message 塞进活着的 query
  end(): void;                       // 关掉输入流
  events: AsyncIterable<ProviderEvent>;  // 5 种事件：activity / init / result / error / progress
  abort(): void;
}
```

控制权进入 `poll-loop.ts:260` 的 `processQuery()`。SDK 的子进程 (`/pnpm/claude` Claude Code CLI) 此时已经在跑，开始向 stdout 发 JSON-lines —— `translateEvents()`（step 13 第 5 段）会把这些行翻译成 `ProviderEvent` 流出。`processQuery()` 要做的，是 **一边消费这条事件流、一边并行 poll 新的 inbound 消息 push 进同一条 query**。

对 `pnpm run chat "ping"` 这条简单消息来说，整个 query 的事件序列大致是：

```
{ type: 'activity' }              // 第一个 SDK 消息
{ type: 'init', continuation: 'sess-abc123' }   // SDK 给出 session id
{ type: 'activity' } { type: 'activity' } …    // agent 思考、调工具、生成 token …
{ type: 'result', text: '<message to="cli:local">pong</message>' }   // 最终回复
```

没有「partial / delta」事件 —— 下面第 5 段会解释为什么。

---

## 2. 问题

step 13 已经让 SDK 开跑，但有四个独立的、需要 **并行** 处理的事情：

1. **消费 SDK 事件流到 final**。final 来之前必须不阻塞地拉事件 —— 不然 SDK stdout buffer 满了会反压住 agent。
2. **保持心跳活的**。host 那侧的 `host-sweep` 会按 `processing_ack` 的 `status_changed` 时间和 `container_state.heartbeat_at` 文件 mtime 判定 stuck，超时就杀容器。Bash 跑一个 30 秒的脚本时容器并没死、只是 agent 在等，host 不能误杀。
3. **接住中途到的新消息**。用户在 "ping" 还没回完时发了 "wait actually stop" —— 这条消息不能等当前 query 结束才进入下一轮，而要 **push 进活着的 query**，让 agent 在同一个 turn 里看到。
4. **处理 SDK 已经在跑、但下一条新消息其实是 slash 命令** 的尴尬情况。`/clear` 要重建 SDK 状态（resume id 在 `sdkQuery()` 时就 fix 了，没法热改），`/compact` 等只能在 query 起手时 dispatch。这类命令必须 **结束当前 stream**，让外层 loop 进下一轮规范处理。

第 2、3 件事是 **并行轮询** 的真正驱动力。这一步是这条 trace 里第一个出现「主线程 await 事件、定时器并行 poll DB」双轨结构的地方。

---

## 3. 朴素思路

最直觉的写法：「等 final 再说」。

```ts
async function processQuery(query: AgentQuery, routing, ids, providerName) {
  let continuation: string | undefined;
  let finalText: string | null = null;
  for await (const event of query.events) {
    if (event.type === 'init') continuation = event.continuation;
    else if (event.type === 'result') finalText = event.text;
  }
  if (finalText) dispatchResultText(finalText, routing);
  return { continuation };
}
```

简洁、单线程、好读。`for await` 一直拉直到 SDK 关流，拿到 `result` 时写 outbound，全场结束。

---

## 4. 为什么朴素思路会崩

对 `ping → pong` 这种亚秒级回复，朴素方案没毛病。但只要 agent 开始用工具，问题立刻浮现：

- **30 秒不发心跳就被杀**。host 的 stuck-sweep（见第 5 章主循环）按 `heartbeat_at` 文件 mtime 看活性 —— 朴素方案的 `for await` 在 Bash 跑长脚本时主线程是 blocked 在 `await` 上，没人调 `touchHeartbeat()`，文件 mtime 不变，host 不久就发 SIGTERM 给容器、把 messages 重置成 pending、下一个容器又从头跑一遍，永远跑不完。
- **follow-up 消息要等下一轮才被看到**。用户「ping」之后立刻又发「actually wait」—— 朴素方案要等 `pong` 的 query 完全结束、回到外层 `while (true)` 顶部、下一次 `getPendingMessages()` 才捡到「actually wait」。中间这段时间用户已经接到了无关的 `pong`。把 follow-up `push` 进活着的 query，agent 才有机会在同一个 turn 里改变行为。
- **每次新消息都重启 SDK 子进程要 2-3 秒**。如果不复用活着的 query，每条消息都要 `sdkQuery(...)` 一次 —— spawn 新 cli.js 子进程、读 transcript .jsonl、重新初始化 MCP servers，单是 startup 就要几秒。这把多轮对话变成秒级延迟。`processQuery` 注释（`poll-loop.ts:270-278`）原话："keeping the query open avoids re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl transcript on every turn. The Anthropic prompt cache is server-side with a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect cache lifetime."
- **mid-stream 的 slash 命令会被吞掉**。`/clear` 在 query 跑到一半时 push 进 SDK，SDK 把它当普通用户消息看 —— resume id 是固定的、上下文不会清。`/compact` 这种 SDK 内置命令也只能在 input 开头识别。朴素方案对此无动于衷。

### 而「写 partial 到 outbound.db」根本没发生

`@anthropic-ai/claude-agent-sdk` 支持 `includePartialMessages: true`（`docs/SDK_DEEP_DIVE.md:82`、`docs/SDK_DEEP_DIVE.md:179`），开启后 emit `stream_event` 增量。但 **`ClaudeProvider.query()` 没开这个选项**（`providers/claude.ts:286-314` 的 options 对象里没有 `includePartialMessages` 字段）。`ProviderEvent` 一共五种 (`providers/types.ts:82-93`)：`init` / `result` / `error` / `progress` / `activity` —— 没有 `delta` 或 `partial`。final 文本只在 `result` 事件来到时一次性 dispatch 给 `outbound.db`（step 15）。

为什么不开：Discord / Telegram / Slack 都不喜欢被秒级 edit 同一条消息（rate limit + UX flicker）；用户体感的「typing indicator」由 channel adapter 自己处理；nanoclaw 的保活靠文件 touch、不靠 partial reply；agent 用 `mcp__nanoclaw__send_message` 主动 turn 中段发消息（`poll-loop.ts:373-378` 注释：「The agent may have responded via MCP (send_message) mid-turn」）才是真正的「中途响应」。

所以 **本步的「流式 push」指的是「follow-up 用户消息 push 进活着的 query」**，而不是「partial reply push 出 outbound.db」。task brief 里描述的「每 N 字符 throttle 写 partial 到 messages_out」在 v2.0.64 不存在 —— 这是值得如实记录的设计决定。

---

## 5. nanoclaw 的做法

<svg viewBox="0 0 820 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Dual-track processQuery: main for-await events plus 500ms setInterval poll-and-push follow-ups">
  <defs>
    <marker id="sp-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <text x="410" y="20" font-size="13" font-weight="700" fill="currentColor" text-anchor="middle">processQuery() — dual-track concurrency (main await + setInterval push)</text>
  <text x="60" y="50" font-size="10" fill="#94a3b8">t=</text>
  <line x1="80" y1="46" x2="780" y2="46" stroke="#cbd5e1"/>
  <text x="120" y="38" font-size="9" fill="#64748b">0ms</text>
  <text x="260" y="38" font-size="9" fill="#64748b">500</text>
  <text x="400" y="38" font-size="9" fill="#64748b">1000</text>
  <text x="540" y="38" font-size="9" fill="#64748b">1500</text>
  <text x="680" y="38" font-size="9" fill="#64748b">2000ms</text>
  <rect x="20" y="70" width="780" height="130" rx="6" fill="#ecfdf5" stroke="#0d9488" stroke-width="1.2"/>
  <text x="30" y="88" font-size="11" font-weight="700" fill="#0f766e">Main track  ·  for await (event of query.events)</text>
  <line x1="80" y1="138" x2="780" y2="138" stroke="#0d9488" stroke-width="2"/>
  <circle cx="120" cy="138" r="8" fill="#0d9488"/>
  <text x="120" y="160" font-size="10" fill="currentColor" text-anchor="middle">activity</text>
  <text x="120" y="172" font-size="9" fill="#94a3b8" text-anchor="middle">touchHeartbeat</text>
  <circle cx="180" cy="138" r="10" fill="#7c3aed"/>
  <text x="180" y="160" font-size="10" font-weight="700" fill="#7c3aed" text-anchor="middle">init</text>
  <text x="180" y="172" font-size="9" fill="#94a3b8" text-anchor="middle">setContinuation</text>
  <text x="180" y="184" font-size="9" fill="#dc2626" text-anchor="middle" font-weight="600">eager! crash-safe</text>
  <circle cx="260" cy="138" r="6" fill="#0d9488"/>
  <circle cx="320" cy="138" r="6" fill="#0d9488"/>
  <circle cx="380" cy="138" r="6" fill="#0d9488"/>
  <circle cx="460" cy="138" r="6" fill="#0d9488"/>
  <circle cx="540" cy="138" r="6" fill="#0d9488"/>
  <text x="400" y="116" font-size="10" fill="#0d9488" text-anchor="middle">activity events (every tool call / thinking / retry) → touchHeartbeat each</text>
  <circle cx="700" cy="138" r="10" fill="#ea580c"/>
  <text x="700" y="160" font-size="10" font-weight="700" fill="#ea580c" text-anchor="middle">result</text>
  <text x="700" y="172" font-size="9" fill="#94a3b8" text-anchor="middle">dispatchResultText</text>
  <text x="700" y="184" font-size="9" fill="#94a3b8" text-anchor="middle">→ step 15</text>
  <rect x="20" y="210" width="780" height="170" rx="6" fill="#fef3c7" stroke="#ea580c" stroke-width="1.2"/>
  <text x="30" y="228" font-size="11" font-weight="700" fill="#9a3412">Side track  ·  setInterval(500ms) — poll new inbound, push into live query</text>
  <line x1="80" y1="284" x2="780" y2="284" stroke="#ea580c" stroke-width="2" stroke-dasharray="4,3"/>
  <rect x="252" y="270" width="16" height="28" rx="2" fill="#ea580c"/>
  <text x="260" y="316" font-size="10" fill="currentColor" text-anchor="middle">tick</text>
  <text x="260" y="328" font-size="9" fill="#94a3b8" text-anchor="middle">no new inbound</text>
  <text x="260" y="340" font-size="9" fill="#94a3b8" text-anchor="middle">no-op</text>
  <rect x="392" y="270" width="16" height="28" rx="2" fill="#ea580c"/>
  <text x="400" y="316" font-size="10" fill="currentColor" text-anchor="middle">tick</text>
  <text x="400" y="328" font-size="9" fill="#16a34a" text-anchor="middle" font-weight="600">"wait stop"</text>
  <text x="400" y="340" font-size="9" fill="#94a3b8" text-anchor="middle">markProcessing</text>
  <text x="400" y="352" font-size="9" fill="#94a3b8" text-anchor="middle">→ query.push()</text>
  <rect x="532" y="270" width="16" height="28" rx="2" fill="#ea580c"/>
  <text x="540" y="316" font-size="10" fill="currentColor" text-anchor="middle">tick</text>
  <text x="540" y="328" font-size="9" fill="#dc2626" text-anchor="middle" font-weight="600">/clear seen</text>
  <text x="540" y="340" font-size="9" fill="#94a3b8" text-anchor="middle">query.end()</text>
  <text x="540" y="352" font-size="9" fill="#94a3b8" text-anchor="middle">main exits naturally</text>
  <rect x="672" y="270" width="16" height="28" rx="2" fill="#94a3b8"/>
  <text x="680" y="316" font-size="10" fill="#94a3b8" text-anchor="middle">tick</text>
  <text x="680" y="328" font-size="9" fill="#94a3b8" text-anchor="middle">done=true → return</text>
  <text x="680" y="340" font-size="9" fill="#94a3b8" text-anchor="middle">finally clearInterval</text>
  <text x="120" y="262" font-size="10" fill="#64748b">guarded by pollInFlight (re-entrant mutex)  ·  explicit catch (unhandled rejection kills container)</text>
  <text x="400" y="376" font-size="10" fill="#dc2626" font-weight="600" text-anchor="middle">push appends to same MessageStream → SDK sees new user input mid-turn (no respawn)</text>
</svg>
<span class="figure-caption">图 T1.24 ｜ processQuery 双轨时间线：青色主轨持续 await SDK 事件，每事件 touchHeartbeat；橙色副轨 500ms tick 把新 inbound 消息 markProcessing 后 query.push 进活着的 stream。/clear 触发 query.end() 让主轨自然结束。</span>

<details>
<summary>ASCII 原版</summary>

```
t=  0ms  500    1000    1500    2000
    ────────────────────────────────────  (main track: for await events)
    activity init activity activity activity activity result
              │                                          │
              ▼ setContinuation (eager)                  ▼ dispatchResultText
              persist before crash window               → step 15

    ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  (side track: setInterval 500ms)
              tick          tick           tick           tick
              no-op    push "wait stop"  /clear→end()    done→return
                       markProcessing
```

</details>

`processQuery()`（`poll-loop.ts:260-402`）把双轨并行做成「主 await 事件流 + setInterval 轮询 DB」：

**a. 主轨：`for await` 消费事件流，每个事件 touchHeartbeat。**

```ts
// poll-loop.ts:358-395
try {
  for await (const event of query.events) {
    handleEvent(event, routing);   // 日志
    touchHeartbeat();              // 心跳

    if (event.type === 'init') {
      queryContinuation = event.continuation;
      setContinuation(providerName, event.continuation);  // 立刻持久化 session id
    } else if (event.type === 'result') {
      markCompleted(initialBatchIds);
      if (event.text) {
        const { hasUnwrapped } = dispatchResultText(event.text, routing);
        // 如果 agent 输出没用 <message to="..."> 包裹，注入 nudge 让它重发
        if (hasUnwrapped && !unwrappedNudged) { … query.push(`<system>…</system>`); }
      }
    }
  }
} finally {
  done = true;
  clearInterval(pollHandle);
}
```

注意几个细节：

- 每收到一个事件就 `touchHeartbeat()`（`poll-loop.ts:361`）—— 这就是「保活」机制。SDK 在 agent 思考、调工具、发 progress 的每一步都会 emit 至少一个 `activity` 事件（参见 step 13 第 5 段的翻译表），所以心跳间隔 = SDK 事件间隔，通常 < 1 秒。
- `init` 事件来到时 **立刻** 持久化 `continuation` 到 v2.db sessions 表（`poll-loop.ts:371` 的 `setContinuation`）。`poll-loop.ts:367-371` 的注释解释了为什么不能等到 query 结束：「if the container died between init and result, the SDK session was effectively orphaned and the next message started a blank Claude session with no prior context」。
- `result` 事件来到时 **不退出 for await**，只是 `markCompleted(initialBatchIds)` —— 因为 query 可能还会 emit 更多事件（最常见的：被 `query.push()` 触发的下一轮 `init`+`activity`+`result`）。退出靠的是 SDK 自己 close 输入流（`query.end()` 或 `abort()`）或迭代器自然结束。
- `dispatchResultText`（`poll-loop.ts:431-471`）把 `<message to="cli:local">pong</message>` 这样的块解析出来，每个块通过 `sendToDestination` 调 `writeMessageOut`（step 15 的入口）。

**b. 副轨：`setInterval` 每 500ms 轮询新消息，push 进活着的 query。**

`poll-loop.ts:281-356` 启了一个 `setInterval(..., ACTIVE_POLL_INTERVAL_MS)` —— 500ms（比 idle 1000ms 更激进，因为 query 在跑、用户更可能再发一条）。每个 tick 做的事：

1. **重入互斥**：`pollInFlight` flag 防止上一次 poll 还没跑完时再起一次，避免同一条新消息被 push 两次。
2. **slash command 检测分流**（`poll-loop.ts:296-301`）：新到的消息里如有 `isRunnerCommand`（`/clear` / `/compact` / `/cost` / …），置 `endedForCommand = true` 并调 `query.end()` 关掉输入流；主轨 `for await` 因 SDK 见 EOF 而自然结束；外层 while 下一轮由 `formatMessagesWithCommands` 走 native slash 路径。
3. **过 pre-task script gate**：与初批次同款的 `applyPreTaskScripts` 钩子，让脚本控制定时任务消息是否进 query。
4. **`if (done) return`**（`poll-loop.ts:337`）：`applyPreTaskScripts` 是 `await import`，期间主轨可能已经完成；push 进死流是浪费 + 让 markProcessing 的消息卡住；改由 host `processing_ack` sweep 兜底释放。
5. **真正 push**：`query.push(formatMessages(keep))` 把 follow-up 塞进 SDK 输入流，立刻 `markCompleted(keptIds)`。
6. **显式 catch**（`poll-loop.ts:345-354`）：注释明示「Without this catch the rejection escapes the void IIFE and Node terminates the container on unhandled-rejection」—— 这条容易踩，因为 setInterval callback 是 fire-and-forget。

**c. `unwrappedNudged` 自纠机制**

`dispatchResultText` 解析 `<message to="...">...</message>` 块；如果 agent 出错忘了包，整个回复被当 scratchpad 丢掉、用户什么都收不到。这种情况下 `poll-loop.ts:381-393` 会向 query.push 一段 `<system>...</system>` 指令告诉 agent：「你刚才没包，请重发」。`unwrappedNudged` 是单次 flag，避免无限纠错循环。

**d. 双轨何时收尾**

主轨结束触发条件：

1. SDK 自然关闭输入流（input stream EOF）—— 通常是 `query.end()` 被调，例如 slash command 分流时。
2. 或者主轨外层 try/catch 抓到错误，外层 `finally { done = true }` 释放定时器。

副轨结束触发条件：`finally { clearInterval(pollHandle) }`（`poll-loop.ts:398`）—— 必然在主轨 for await 退出后执行。

收尾顺序保证：先 `done = true` → 副轨的下一次 tick 看到 `done` 直接 return → `clearInterval` 干净停掉。

---

## 6. 代码位置

按阅读顺序：

- `poll-loop.ts:18-19` —— `POLL_INTERVAL_MS = 1000` / `ACTIVE_POLL_INTERVAL_MS = 500`
- `poll-loop.ts:260-265` —— `processQuery` 签名
- `poll-loop.ts:266-279` —— 双轨变量初始化，注释解释「为什么不在 silence 时 force end stream」
- `poll-loop.ts:281-356` —— `setInterval` 副轨：poll + push follow-up
  - `poll-loop.ts:287-301` —— pending slash command 分流，`endedForCommand` flag + `query.end()`
  - `poll-loop.ts:310-314` —— `markProcessing(newIds)` 占用新消息
  - `poll-loop.ts:322-331` —— follow-up 的 pre-task script gate（与初批次同款）
  - `poll-loop.ts:337-344` —— `if (done) return` + `query.push(prompt)` + `markCompleted`
  - `poll-loop.ts:345-354` —— 显式 catch unhandled rejection
- `poll-loop.ts:358-395` —— 主轨 `for await (const event of query.events)`
  - `poll-loop.ts:361` —— 每事件 `touchHeartbeat()`（保活）
  - `poll-loop.ts:363-371` —— `init` → 立刻 `setContinuation` 持久化 session id
  - `poll-loop.ts:372-394` —— `result` → `markCompleted` + `dispatchResultText` + unwrapped nudge
- `poll-loop.ts:381-392` —— `unwrappedNudged` 自纠 `<system>...</system>` 注入
- `poll-loop.ts:396-399` —— `finally { done = true; clearInterval(pollHandle) }`
- `poll-loop.ts:404-421` —— `handleEvent` 日志
- `poll-loop.ts:431-471` —— `dispatchResultText` 解析 `<message to="...">...</message>`
- `poll-loop.ts:473-490` —— `sendToDestination` 调 `writeMessageOut`（衔接 step 15）
- `db/connection.ts` —— `touchHeartbeat()` 实现（touch heartbeat 文件）
- `providers/types.ts:82-93` —— `ProviderEvent` 五种类型定义（**没有** `delta` / `partial`）
- `providers/claude.ts:286-314` —— `sdkQuery` options，**未设置** `includePartialMessages`
- `docs/SDK_DEEP_DIVE.md:82` —— `includePartialMessages` SDK 选项说明
- `docs/SDK_DEEP_DIVE.md:179` —— `stream_event` partial 事件类型说明

---

## 7. 分支与延伸

- `processQuery` 双轨设计在 nanoclaw provider 抽象里的位置 —— 这套并行机制对其他 provider（codex / opencode）同样适用，因为 `AgentQuery.push` 是接口约定 → [第 8 章 §流式 push 中途更新](08-agent-runner-and-providers.md#流式-push-中途更新)
- 为什么 nanoclaw 没有 `kind='typing'` / `kind='partial'` 这种消息类型（与许多 chat 系统的对比）→ [第 9 章 §Message kind dispatch](09-message-and-channel.md#message-kind-dispatch)
- `outbound.db` schema 全貌（kind 的合法值、seq 奇偶、deliver_after 语义）→ [第 3 章 §`outbound.db`：container → host](03-three-db-model.md#352-outbounddbcontainer--host)
- host 的 stuck-sweep 如何用 `heartbeat_at` 文件 mtime + `processing_ack.status_changed` 决定杀容器 → [第 5 章 host 入口主循环](05-host-entrypoint.md)
- agent 用 `mcp__nanoclaw__send_message` 在 turn 中段主动发消息出去（nanoclaw 真正的「中途响应」）→ [第 8 章 §MCP server 装配](08-agent-runner-and-providers.md#mcp-server-装配)
- slash command 在 mid-stream 时为什么必须 end query 而不是 push —— 与 SDK resume id 在 `sdkQuery()` 时 fix 的关系 → [第 8 章 §slash command 与 native dispatch](08-agent-runner-and-providers.md#slash-command-与-native-dispatch)

---

## 8. 走完这一步你脑子里应该多了什么

1. **「流式 push」在 nanoclaw 里指的是 inbound 方向**：把新到的用户消息 push 进活着的 SDK query —— 而不是把 agent 的 partial reply 喷给用户。partial reply 这条路线根本没接（`includePartialMessages` 未开），final 文本只在 `result` 事件来到时一次性 dispatch（step 15）。
2. **保活靠每事件 `touchHeartbeat` 文件 touch**。`for await` 主线程并不阻塞 —— SDK 的 `activity` 事件以亚秒粒度持续到达（每个 tool call、每个 thinking、每个 retry），心跳间隔由此自动跟上 agent 实际节奏。host 的 stuck-sweep 看的就是这个文件的 mtime。
3. **`setInterval` 副轨 + `pollInFlight` 互斥 + `done` 检查 = nanoclaw 的并发原语**。这种「主 await 流 + 定时器 poll DB push 进流」的模式贯穿整个 agent-runner，是它能 keep-warm 同时接 follow-up 的关键。每次定时器 tick 都重新跑 pre-task script gate，对持续到来的定时任务行为一致。
4. **`init` 事件持久化必须 eager，不能等到 result**。容器在 init 与 result 之间崩，下次 wake 没有 continuation 就是空白上下文 —— `setContinuation` 写到 sessions 表的时机选在 init 不是 result，是显式针对这个 crash 路径设计的。
5. **slash command 不能 mid-stream push**。`/clear` 重建 SDK 状态（resume id 在 `sdkQuery()` 时 baked in 没法热改）、`/compact` 等只能在 input 起手识别。副轨检测到这种命令时 `query.end()` 把活着的 stream 干净收尾，让外层 loop 通过 `formatMessagesWithCommands` 走 native dispatch。
6. **保留 query 活着是延迟优化、不是 prompt cache 优化**。注释明确："Anthropic prompt cache is server-side with 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect cache lifetime"。保活的意义在于省 cli.js 的 spawn + transcript reload 那几秒。

下一步：[Trace 步骤 15 —— 写入最终 messages_out](tour-single-cli-message-15-write-final.md)。
