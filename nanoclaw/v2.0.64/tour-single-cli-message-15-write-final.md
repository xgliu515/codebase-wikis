## 1. 当前情境

step 14 的主轨 `for await (const event of query.events)` 现在正在迭代第 N 个事件。SDK 在算完 "ping" 这一轮后会 emit 一个 `result` 事件，翻译后形如：

```ts
{ type: 'result', text: '<message to="cli:local">pong</message>' }
```

`text` 不是裸字符串「pong」—— 是经过 nanoclaw 约定的 `<message to="...">…</message>` 包裹结构（这层约定让 agent 在 agent-shared session 里能精确选投递目标；详见 step 14 第 5 段 c 小节的 `dispatchResultText`）。

主轨进入 `poll-loop.ts:372-394` 的 `result` 分支：

```ts
} else if (event.type === 'result') {
  markCompleted(initialBatchIds);             // (1) 释放本轮初批次的 processing_ack
  if (event.text) {
    const { hasUnwrapped } = dispatchResultText(event.text, routing);  // (2) 解析 + 写 outbound
    if (hasUnwrapped && !unwrappedNudged) { … }
  }
}
```

step 15 聚焦在 `markCompleted` + `dispatchResultText`（→ `sendToDestination` → `writeMessageOut`）这条 final 落地路径上：把 "pong" 写成一行 `outbound.db.messages_out`，并把对应的 `inbound.db.messages_in` 那行 "ping" 标 completed。

走到本步终点时，host 那侧（step 16）的 `startActiveDeliveryPoll` 定时器即将（≤ 1 秒内）扫到这条新行。

---

## 2. 问题

`result` 事件到手，本步要落地的事：

1. **持久化 final reply**。agent 算出的 `<message to="cli:local">pong</message>` 必须写到一个 host 能读到的地方，而且必须 **保证投递** —— 不是 fire-and-forget。
2. **路由信息一并落地**。"pong" 要被 host 路由回原 CLI client；目标 channel（`cli`）、platform_id（`local`）、可选 thread_id、可选 `in_reply_to` 都要写进同一行，host 不需要重新查表。
3. **本轮 inbound 的 status 翻面**。"ping" 那条 `messages_in` 的 `processing_ack` 是 `processing` 状态，下一轮 poll 必须不再捡到它 —— 翻成 `completed`。
4. **保持 seq 的全序**。outbound 的 seq 要跟 inbound 的 seq 在同一条数轴上 **严格交错**（奇 vs 偶），让用户在客户端看到的消息次序与 agent 视角一致，让 agent 用 seq 引用消息（`edit_message #5` / `add_reaction #3`）时不会指错。
5. **不重复投递、不漏投递**。如果 markCompleted 先于 writeMessageOut 出错、或反之，要能恢复 —— host 与 container 的故障域不能耦合。

---

## 3. 朴素思路

最直觉的写法：「agent 直接 push 给 channel adapter」。

```ts
// 假想：直接把 reply 喷给 cli adapter
import { channelRegistry } from '../host/channels';
channelRegistry.get('cli').deliver('local', 'pong');
markInboundCompleted('ping_msg_id');
```

省一张表（不要 `messages_out`），省一轮轮询（不要 host 扫 outbound.db），延迟最低。

---

## 4. 为什么朴素思路会崩

容器是个独立进程、跟 host 完全隔离 —— 这套方案直接死在第一步：

- **容器 import 不到 host 的 `channelRegistry`**。host 跑 Node、容器跑 Bun；host 是宿主进程、容器是隔离 sandbox（参考 `docs/isolation-model.md`）。`channelRegistry` 是 host 内存里的对象，容器拿不到它的引用 —— 不可能直接调 `deliver()`。要让容器调 host 的 channel adapter，唯一办法是开 IPC（HTTP / gRPC / socket），但那就把第 1 章已经反复否决的「IPC 同步耦合」又请回来了：channel 临时挂了（Discord API 抖动、网络分区、Slack token 失效）会阻塞 agent 后续 turn。
- **channel 失败要 retry，retry 状态得有地方存**。Discord 短时间挂了一分钟，"pong" 要存到某处、等恢复了再投。朴素方案没存储，丢了就丢了。`messages_out` 这张持久化队列就是为此而存在。
- **多 destination 怎么办**。agent 输出可能包含 `<message to="cli:local">…</message>` 和 `<message to="discord:#general">…</message>` 两条 —— 朴素方案要在 agent 里就知道每个 channel 的可用性、重试策略。在容器里管这些等于把 host 的责任搬进容器，与 NanoClaw 的「container 只管思考、host 管投递」分工背道而驰。
- **markCompleted 的时机与 writeMessageOut 的时机如果不一致，会双投或漏投**。先 markCompleted 再写 outbound，中途崩了 → "ping" 被吞但 "pong" 没出，下次 wake 没人理。先写 outbound 再 markCompleted，中途崩了 → "pong" 已在队列、"ping" 仍 processing，下次 wake 重处理 → 双投。
- **seq 失序导致用户看到「pong 在 ping 前面」**。agent 输出过 `mcp__nanoclaw__send_message` 在 turn 中段已经写过一条 outbound（seq=3），主轨 result 这条 "pong" 如果不重新 max() 一遍就分到 seq=1 —— 客户端按 seq 排就乱了。

所以 nanoclaw 一开始就选了「container 写一张表、host 异步消费」的解耦路径 —— 也就是 step 14 主轨这一步要做的事。

---

## 5. nanoclaw 的做法

整条 final 落地路径分四节，按主轨 `result` 分支的执行顺序来：

### a. `markCompleted(initialBatchIds)` —— 提前释放 inbound

```ts
// poll-loop.ts:379
markCompleted(initialBatchIds);
```

`initialBatchIds` 是 `processQuery` 入参时记下来的「本轮 query 起手时的那批 inbound 消息 id」(`poll-loop.ts:179`)。这里在 **写 outbound 之前** 就把它们标 completed，原因在 `poll-loop.ts:373-378` 的注释里讲得很直接：

> A result — with or without text — means the turn is done. Mark the initial batch completed now so the host sweep doesn't see stale 'processing' claims while the query stays open for follow-up pushes.

`markCompleted`（`db/messages-in.ts:112-121`）写的不是 `inbound.db.messages_in.status`（容器只读权限），而是 `outbound.db.processing_ack`：

```sql
INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed)
VALUES (?, 'completed', datetime('now'))
```

下一轮 `getPendingMessages` 会拉 `inbound.db` 的 pending 行后用 `processing_ack` 过滤掉 acked 的（`db/messages-in.ts:84-93`）。这就是 step 11 提到的 single-writer 不变量在收尾阶段的体现。

### b. `dispatchResultText` 解析 `<message to="…">…</message>`

`poll-loop.ts:431-471` 用正则 `/<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g` 全局匹配 final text 里的每一块。对 "ping → pong" 单 destination 的简单流程只循环一次：

- `toName = "cli:local"`、`body = "pong"`
- `findByName("cli:local")` 从 destinations 表（`destinations.ts`，step 10 容器启动时加载）查到对应行
- 调 `sendToDestination(dest, "pong", routing)`（进入 c）

正则外的文本（含 `<internal>…</internal>` scratchpad、未包裹的裸文本）收集到 `scratchpadParts`，stripInternalTags 后只 log 不发。完全没有 `<message>` 块时（`hasUnwrapped`），返回标志位让上层注入纠正提示（见 step 14 第 5 段 c）。

### c. `sendToDestination` —— per-destination 路由解析

`poll-loop.ts:473-490` 把 destination 翻成 `(platform_id, channel_type)` 二元组，再调 `resolveDestinationThread(channelType, platformId)`（`poll-loop.ts:496-514`）按 `(channel_type, platform_id)` 在 inbound.db 里 `SELECT thread_id, id FROM messages_in ... ORDER BY seq DESC LIMIT 1` 找最近一条同源消息，借它的 `thread_id` 和 `id` 作为这条 outbound 的 thread 上下文和 `in_reply_to`。

为什么 per-destination 而不是用 `routing.threadId`？`poll-loop.ts:476-480` 的注释：「In agent-shared sessions, different destinations have different thread contexts — using a single routing.threadId would stamp one channel's thread onto another」。本例 cli 单 channel 退化成「就用 cli 上次那条 ping 的 routing」—— 但代码路径相同。

最后调 `writeMessageOut({ id, in_reply_to, kind: 'chat', platform_id, channel_type, thread_id, content: JSON.stringify({text: body}) })`。`content` 包成 JSON 而非裸字符串 —— 这是 host adapter 反序列化时认的 schema，留出未来扩展富文本 / attachments 的口子。

### d. `writeMessageOut` —— INSERT 一行、分配奇数 seq

`db/messages-out.ts:45-77` 的核心逻辑：

```ts
const maxOut = ... 'SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out' ...
const maxIn  = ... 'SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in' ...
const max = Math.max(maxOut, maxIn);
const nextSeq = max % 2 === 0 ? max + 1 : max + 2;  // next odd
outbound.prepare('INSERT INTO messages_out (id, seq, in_reply_to, timestamp, ...) VALUES (...)').run({...});
return nextSeq;
```

几个不显然但关键的点：

- **同时 SELECT inbound 和 outbound 的 max(seq)**。只看 outbound 会乱 —— 如果 inbound 已写到 seq=4，这条 outbound 算成 nextSeq=1/3，全序就破了。`Math.max(maxOut, maxIn)` 把两侧拉齐到单调递增的数轴上，奇偶约定才能保证「container 只写奇、host 只写偶」。
- **跨 DB 读是安全的**。注释 `db/messages-out.ts:48` 明示：「Safe: each side only reads the other DB, never writes to it」—— 单写者不变量没破。
- **bun:sqlite 命名参数必须带 `$` 前缀**（`db/messages-out.ts:56-57` 注释：「better-sqlite3 auto-stripped it, bun:sqlite does not」）—— 从 better-sqlite3 迁移踩过的坑。
- **`timestamp` 用 `datetime('now')` 由 SQL 端生成**，不传 JS 端 `new Date()` —— 让 host/container 共用 SQLite 的 UTC 时钟，避免容器内系统时钟漂移引发 ordering bug。
- **`deliver_after` 留空** = host poll 立刻可见（`db/messages-out.ts:138-141`：`WHERE deliver_after IS NULL OR deliver_after <= datetime('now')`）。scheduled task 走 `mcp__nanoclaw__schedule_task` 时才会塞未来时间。

返回的 `nextSeq` 通过 `mcp__nanoclaw__send_message` 回流给 agent，成为后续 `edit_message` / `add_reaction` 引用的 agent-facing message ID（`db/messages-out.ts:36-44` 明示这是「load-bearing」而非纯防撞）。

### e. 主轨 for await 继续 / 自然结束

`result` 事件处理完后，主轨 `for await` 没有 `break` —— 继续等下一个事件。SDK 在 `result` 之后通常 close 输入流（特别是输入流没有更多 `push`），迭代器自然 `done`，主轨 try 退出、finally `done = true; clearInterval(pollHandle)`。

外层 `runPollLoop`（`poll-loop.ts:211-218`）再做一次 belt-and-braces：

```ts
} finally {
  clearCurrentInReplyTo();
}
markCompleted(processingIds);  // 兜底：万一 processQuery 没正常发 result 也得标
log(`Completed ${ids.length} message(s)`);
```

然后 `while (true)` 顶部 sleep `POLL_INTERVAL_MS = 1000`，进入下一轮 poll。

---

## 6. 代码位置

按执行顺序：

- `poll-loop.ts:372-394` —— 主轨 `result` 分支
- `poll-loop.ts:379` —— `markCompleted(initialBatchIds)` 提前释放
- `db/messages-in.ts:112-121` —— `markCompleted` 写 `processing_ack` 而非 `messages_in.status`
- `poll-loop.ts:381` —— `dispatchResultText(event.text, routing)`
- `poll-loop.ts:431-471` —— `dispatchResultText` 解析 `<message to="...">...</message>`
  - `poll-loop.ts:432` —— `MESSAGE_RE` 正则
  - `poll-loop.ts:447` —— `findByName(toName)` 解 destination
  - `poll-loop.ts:453` —— `sendToDestination` 调用点
- `poll-loop.ts:473-490` —— `sendToDestination` per-destination 路由
- `poll-loop.ts:496-514` —— `resolveDestinationThread` 按 channel/platform 找最近 inbound
- `db/messages-out.ts:45-77` —— `writeMessageOut` INSERT + 算 nextSeq
  - `db/messages-out.ts:51-54` —— 跨 DB max(seq) + 下一个奇数
  - `db/messages-out.ts:56-57` —— `$` 前缀命名参数（bun:sqlite 约定）
  - `db/messages-out.ts:60-62` —— `timestamp = datetime('now')` SQL 端生成
- `db/messages-out.ts:36-44` —— 注释：seq 是 agent-facing message ID（不是只防撞）
- `db/messages-out.ts:134-143` —— `getUndeliveredMessages`（host 端 step 16 读这个）
- `poll-loop.ts:217` —— 外层兜底 `markCompleted(processingIds)`
- `db/connection.ts` —— `getInboundDb` / `getOutboundDb`（步骤 11 已述）
- `destinations.ts` —— `findByName` 实现

---

## 7. 分支与延伸

- container 写 outbound、host 读 outbound 的全 schema（kind 合法值、`deliver_after`、`recurrence`、`in_reply_to`）→ [第 3 章 §`outbound.db`：container → host](03-three-db-model.md#352-outbounddbcontainer--host)
- seq 奇偶在两侧的写入点对照、为什么不用 UUID、host 那侧 `nextOutboundSeq` 怎么对称地算偶数 → [第 3 章 §Seq 奇偶约定](03-three-db-model.md#36-seq-奇偶约定)
- `processing_ack` 表的生命周期：container 写 processing/completed/failed、host 用 stale-claim sweep 释放卡住的 → [第 8 章 §poll-loop](08-agent-runner-and-providers.md#containeragent-runnersrcpoll-loopts)
- 单写者不变量为什么允许「容器读 inbound、host 读 outbound」却不允许任何一方写对端 → [第 3 章 §单写者不变量](03-three-db-model.md#单写者不变量)
- `<message to="...">...</message>` 包裹约定怎么来的、agent-shared session 多 destination 时的工作机制 → [第 9 章 §destination 解析与多目标投递](09-message-and-channel.md#destination-解析与多目标投递)
- DELETE journal mode + open-write-close 为什么保证 host 立刻能读到刚 INSERT 的行（跨 mount 的可见性不变量）→ [第 3 章 §跨 mount 不变量](03-three-db-model.md#37-跨-mount-不变量delete-模式与-open-write-close)

---

## 8. 走完这一步你脑子里应该多了什么

1. **`markCompleted` 写的是 `outbound.db.processing_ack`，不是 `inbound.db.messages_in.status`**。容器对 inbound 只读 —— status 翻转只能通过这张 container-owned 表「侧写」，host 下次 sync 时合并。这是单写者不变量在收尾阶段的具体落实。
2. **seq 全序跨两张表**。`writeMessageOut` 同时 SELECT inbound 与 outbound 的 max(seq)，从两者最大值起算下一个奇数。这让 seq 既是消息全序、又是 agent-facing message ID —— `mcp__nanoclaw__edit_message #5` 能精准定位无论 #5 是 inbound 还是 outbound。
3. **markCompleted 在 writeMessageOut 之前调**。理由是 result 来了就说明 turn 结束、不能让 host sweep 看到 stale processing claim；至于「写 outbound 之前进程挂了」的极端 case，外层兜底 `markCompleted(processingIds)` 与 host 的 stuck-sweep 会接住。这种顺序是定向取舍 —— 「让 in 表先归位、out 表的去重让 host 端管」。
4. **`<message to="...">...</message>` 包裹是一切 outbound 必经的栅门**。没包就被吞，会触发 `unwrappedNudged` 自动 nudge agent 重发；包了一个不存在的 destination 就 log + drop。这层正则栅门让 agent-shared session 在多 channel fan-out 时不会错位投递。
5. **`writeMessageOut` 返回的 seq 是 agent 真正用的「消息号」**。它通过 `mcp__nanoclaw__send_message` 等工具回流给 agent，agent 再用它做 edit / reaction。`getMessageIdBySeq`（`db/messages-out.ts:90-113`）后续把这个内部 seq 翻译成 channel 平台的 message id —— 这条 indirection 是 nanoclaw 让 agent「不需要知道任何 platform-specific id」的关键。
6. **写完这条 outbound 后，container 不主动通知任何人**。它就一个 INSERT、return；唤醒 host 这条路径完全靠 step 16 的 `startActiveDeliveryPoll` 每秒扫一次 outbound.db。这种 polling 看似低效，但避免了 IPC、避免了 host-container 同步耦合 —— 与第 3 章对所有 IPC 方案的否决一脉相承。

下一步：[Trace 步骤 16 —— host delivery 轮询发现新行](tour-single-cli-message-16-delivery-poll.md)。
