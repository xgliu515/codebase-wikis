## 1. 当前情境

第 10 步把 boot 全部跑完了：bun 正在 `runPollLoop()` 里。具体状态：

- `provider` 是个实例化好的 `ClaudeProvider`，闭包了 `mcpServers`、`assistantName`、`model`、`effort`。
- `cwd = '/workspace/agent'`。
- `systemContext.instructions` 是已经拼好的 identity + destinations 字符串。
- `providerName = 'claude'`。
- 全局 `_inbound` / `_outbound` 还是 `null`——poll loop 第一次进入循环体时，里面调的 `clearStaleProcessingAcks()` 会触发 `getOutboundDb()` 第一次打开 outbound.db。
- `.heartbeat` 文件不存在（第一次进 loop 时 `touchHeartbeat()` 才会创建）。
- inbound.db 里有 host 在 step 08 写进去的那一行 `messages_in`：`kind='chat'`、`content='{"text":"ping"}'`、`seq` 是某个偶数、`status='pending'`、`trigger=1`、`on_wake=0`（一般默认）。

poll loop 已经做了两件 startup-time 准备工作：

1. [`runPollLoop():59`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L59) 调 `migrateLegacyContinuation(providerName)` 读出上次 session 的 continuation id（用于 SDK resume）。本 trace 假设是新 session，所以返回 `undefined`。
2. [`poll-loop.ts:67`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L67) 调 `clearStaleProcessingAcks()`，把上一次 crash 留下的 `processing` 行删掉（让新 container 能重新 process 那些消息）。新 session 这步是 no-op。

现在 `while (true)` 大循环已经进入了第一轮，`isFirstPoll = true`，`pollCount = 0`。下一拍要执行 `getPendingMessages(isFirstPoll).filter(...)`。

## 2. 这一步要解决的问题

Poll loop 一轮的核心问题是：**在 inbound.db 里有没有"该处理的新消息"——而且这个判定要在所有"已经被处理过 / 正在被处理 / 不该触发 wake / 不到时间 / 必须冷启才触发"的边界条件下都正确**。

把上面那句话拆开：

1. **怎么知道某行没被处理过？** 上次 container 已经吃掉的，processing_ack 里有它的 id。但是 inbound.db 是 host 写的、container 不能写——所以 `messages_in.status` 不会反映 container 进度。**进度只能写在 outbound.db 的 processing_ack 表里**。
2. **怎么知道某行已经被并发的同一 container 拿走了？** 我们用的是 single-threaded 模型——但同一 container 在 poll loop 主循环 + 内部 `pollHandle` setInterval 都会调 `getPendingMessages()`。两次调用之间，第一次的 batch 若还没写 ack，第二次会看见同样的行。**ack 是 claim**，必须在 query 启动前就写。
3. **`on_wake=1` 怎么处理？** 这是 host 标的"只有在冷启时才该 trigger 的消息"（welcome 消息、resume notification 等）。Warm container 拿到不要触发。
4. **`trigger=0` 怎么处理？** 这类 row 是"context-only accumulate"——agent 不该被它"唤醒"，但**下次真有 trigger=1 来 wake 时它要被一起带上**。
5. **多少行一次喂给 agent？** SDK 单 turn 的 context window 有限，全量喂太大；最近 N 行最合理。N 取自 `container.json.maxMessagesPerPrompt`，默认 10。
6. **顺序怎么定？** SDK 期望 chronological（旧 → 新）；DB 按 seq DESC 才能"取最近 N 条"。所以查询完要 reverse。
7. **host 怎么区分"container 死了"和"container 在跑长任务"？** 心跳 ≠ 任务进度。要有两个独立信号。

这一步的副作用要落到 outbound.db 的 processing_ack 表上——claim 那条 'ping' 消息。

## 3. 朴素思路

直觉的伪代码：

```ts
while (true) {
  await sleep(1000);
  const rows = inbound.prepare(
    "SELECT * FROM messages_in WHERE status='pending'"
  ).all();
  if (rows.length === 0) continue;
  for (const r of rows) {
    await processOne(r);   // 调 provider、写 messages_out
    inbound.prepare("UPDATE messages_in SET status='completed' WHERE id=?")
           .run(r.id);
  }
}
```

——"poll、查、处理、改 status、循环"。这是任何人第一稿都会写的形状。

## 4. 为什么朴素思路会崩

它在 NanoClaw 的实际部署条件下至少有 5 处会炸：

**(a) Container 不能 UPDATE inbound.db**。`UPDATE messages_in` 这一行直接违反单写者不变量——inbound.db 的唯一写者是 host。如果 container 也写，双写者会在 VirtioFS / NFS 上产生锁竞争和不一致。NanoClaw 让 container 用 `Database(path, { readonly: true })` 打开 inbound（[`connection.ts:53,67`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/db/connection.ts#L53)），这条 SQL 会立刻抛 `SQLITE_READONLY`。

**(b) 没有 claim，setInterval 内部 poll 会重复处理同一行**。Poll loop 的 [`pollHandle = setInterval(..., 500)`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L281) 在 query 跑期间每 500ms 也会调 `getPendingMessages()` 推 follow-up——如果不写 ack，外层那条 'ping' 还在 `status='pending'`（host 视角是 pending；processing_ack 还没写），内层 poll 会再拿一次，重复 `query.push('ping')`。

**(c) 关键边界条件：host sweep 怎么判 container 卡住？** 如果只看 `messages_in.status` 不变就当卡住，会把长 Bash 任务（5 分钟的 build）误判成死。如果只看心跳文件 mtime（每秒 touch），同样不够——心跳活着但 query 流出了 unhandled-promise rejection 也算"假活"。

NanoClaw 用 **三个独立信号** 综合判断：
- `processing_ack.status_changed`——"上次状态变化时间"，反映 query 进度。
- `.heartbeat` 文件 mtime——"runtime 还在 iterate provider 事件"，反映 event loop 活性。
- `container_state.tool_started_at` + `tool_declared_timeout_ms`——"现在在跑哪个 tool、它自己声明的超时是多少"，让 sweep 知道"这个 5 分钟没动的 Bash 是合法的"。

没有 ack 写入，第一条信号就丢了，host 只能用心跳判断；任何"心跳活着但 query 卡死"的故障都漏检。

**(d) `trigger=0` accumulate 行**。Host router 有一条策略 `ignored_message_policy='accumulate'`——某些 inbound 消息（非 trigger）该当作上下文存起来，**等下次真消息触发 wake 时和它们一起喂给 agent**。朴素 SQL 不区分这个，每次都会把 accumulate 行当 trigger，导致 agent 被"伪消息"反复 wake，违反"store as context, don't engage"契约。

**(e) `on_wake=1` 区分冷热**。一些行只在冷启时该 trigger（host 标了 `on_wake=1`），warm container 拿到要忽略——朴素 SQL 不查 `on_wake` 字段，warm session 会被这些 marker 反复唤醒。

## 5. NanoClaw 的做法

<svg viewBox="0 0 820 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="One iteration of poll-loop: pending fetch, gates, claim ack, hand to formatter">
  <defs>
    <marker id="pl-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <text x="410" y="20" font-size="13" font-weight="700" fill="currentColor" text-anchor="middle">runPollLoop() — one iteration of the while(true)</text>
  <rect x="20" y="40" width="170" height="360" rx="6" fill="#fef3c7" stroke="#ea580c" stroke-width="1.2"/>
  <text x="105" y="58" font-size="11" font-weight="700" fill="#9a3412" text-anchor="middle">container (Bun)</text>
  <rect x="32" y="70" width="146" height="46" rx="4" fill="#ffffff" stroke="#fcd34d"/>
  <text x="105" y="86" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">inbound.db (RO)</text>
  <text x="105" y="100" font-size="10" fill="#64748b" text-anchor="middle">messages_in</text>
  <text x="105" y="112" font-size="10" fill="#94a3b8" text-anchor="middle">'ping' seq=2 pending</text>
  <rect x="32" y="124" width="146" height="46" rx="4" fill="#ffffff" stroke="#fcd34d"/>
  <text x="105" y="140" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">outbound.db (RW)</text>
  <text x="105" y="154" font-size="10" fill="#64748b" text-anchor="middle">processing_ack</text>
  <text x="105" y="166" font-size="10" fill="#94a3b8" text-anchor="middle">claim / progress signal</text>
  <rect x="32" y="178" width="146" height="46" rx="4" fill="#ffffff" stroke="#fcd34d"/>
  <text x="105" y="194" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">.heartbeat file</text>
  <text x="105" y="208" font-size="10" fill="#64748b" text-anchor="middle">mtime touched per</text>
  <text x="105" y="220" font-size="10" fill="#94a3b8" text-anchor="middle">SDK event</text>
  <text x="105" y="260" font-size="10" fill="#7c3aed" text-anchor="middle" font-weight="600">3 independent</text>
  <text x="105" y="274" font-size="10" fill="#7c3aed" text-anchor="middle" font-weight="600">stuck signals</text>
  <text x="105" y="296" font-size="10" fill="#64748b" text-anchor="middle">+ container_state</text>
  <text x="105" y="310" font-size="10" fill="#64748b" text-anchor="middle">tool_started_at</text>
  <text x="105" y="324" font-size="10" fill="#64748b" text-anchor="middle">tool_declared_</text>
  <text x="105" y="336" font-size="10" fill="#64748b" text-anchor="middle">timeout_ms</text>
  <rect x="220" y="50" width="580" height="60" rx="6" fill="#fef3c7" stroke="#ea580c"/>
  <text x="510" y="70" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">getPendingMessages(isFirstPoll)  →  filter kind != 'system'</text>
  <text x="510" y="86" font-size="10" fill="#64748b" text-anchor="middle">WHERE status='pending' AND (process_after IS NULL OR ...) AND (on_wake=0 OR isFirstPoll=1)</text>
  <text x="510" y="100" font-size="10" fill="#64748b" text-anchor="middle">ORDER BY seq DESC LIMIT N · then LEFT EXCEPT processing_ack · then .reverse()</text>
  <line x1="190" y1="80" x2="218" y2="80" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#pl-ar)"/>
  <rect x="220" y="124" width="180" height="50" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="310" y="143" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">gate: empty?</text>
  <text x="310" y="160" font-size="10" fill="#64748b" text-anchor="middle">yes → sleep 1s, continue</text>
  <rect x="420" y="124" width="180" height="50" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="510" y="143" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">gate: all trigger=0?</text>
  <text x="510" y="160" font-size="10" fill="#64748b" text-anchor="middle">yes (accumulate) → no wake</text>
  <rect x="620" y="124" width="180" height="50" rx="6" fill="#ecfdf5" stroke="#16a34a" stroke-width="1.5"/>
  <text x="710" y="143" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">has trigger=1 ✓</text>
  <text x="710" y="160" font-size="10" fill="#64748b" text-anchor="middle">our 'ping' falls through</text>
  <line x1="510" y1="110" x2="510" y2="122" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#pl-ar)"/>
  <rect x="220" y="190" width="580" height="56" rx="6" fill="#fef3c7" stroke="#ea580c" stroke-width="1.5"/>
  <text x="510" y="210" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">markProcessing(ids)   ←  THE CLAIM (key invariant)</text>
  <text x="510" y="226" font-size="10" fill="#64748b" text-anchor="middle">INSERT OR REPLACE INTO outbound.processing_ack (id, 'processing', NOW())</text>
  <text x="510" y="238" font-size="10" fill="#94a3b8" text-anchor="middle">claim + progress signal + crash-recovery (clearStaleProcessingAcks at startup)</text>
  <line x1="190" y1="216" x2="218" y2="216" stroke="#7c3aed" stroke-width="1.4" marker-end="url(#pl-ar)"/>
  <text x="204" y="210" font-size="9" fill="#7c3aed" text-anchor="end">writes</text>
  <rect x="220" y="262" width="280" height="46" rx="6" fill="#ffffff" stroke="#cbd5e1"/>
  <text x="360" y="280" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">extractRouting(messages)</text>
  <text x="360" y="296" font-size="10" fill="#64748b" text-anchor="middle">platform_id · channel_type · in_reply_to</text>
  <rect x="520" y="262" width="280" height="46" rx="6" fill="#ffffff" stroke="#cbd5e1"/>
  <text x="660" y="280" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">/clear command split + pre-task gate</text>
  <text x="660" y="296" font-size="10" fill="#64748b" text-anchor="middle">our 'ping' = no-op (not /clear, not task)</text>
  <rect x="220" y="324" width="580" height="60" rx="6" fill="#ecfdf5" stroke="#16a34a" stroke-width="1.5"/>
  <text x="510" y="344" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">→ hand normalMessages to step 12 formatter</text>
  <text x="510" y="362" font-size="10" fill="#64748b" text-anchor="middle">poll-loop sleeps after a full provider turn returns (next iteration)</text>
  <text x="510" y="374" font-size="10" fill="#94a3b8" text-anchor="middle">if all kinds were skipped → sleep POLL_INTERVAL_MS (1000ms)</text>
</svg>
<span class="figure-caption">图 T1.21 ｜ poll-loop 一轮：pending query → 3 道 gate（空 / accumulate / trigger）→ markProcessing 写 ack（claim + progress + crash-recovery 三合一）→ 路由抽取 → 命令分流 → 交给 formatter。</span>

<details>
<summary>ASCII 原版</summary>

```
inbound.db (RO) ──SELECT──> getPendingMessages(isFirstPoll)
                              │
                              ▼
                      filter kind != 'system'
                              │
                ┌─────────────┼──────────────┐
                ▼             ▼              ▼
            empty?       all trigger=0?   trigger=1
            sleep 1s     accumulate         │
                         (no wake)          ▼
                                  markProcessing(ids) ──INSERT──> outbound.processing_ack
                                            │             (claim + progress + recovery)
                                            ▼
                                     extractRouting()
                                            │
                                            ▼
                                   [/clear | pre-task gate]
                                            │
                                            ▼
                                  hand to step 12 formatter
```

</details>

[`runPollLoop()` 第 71-219 行](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L71) 的一轮迭代是这样的：

**5.1 拉候选 pending row**：[`getPendingMessages(isFirstPoll).filter(m => m.kind !== 'system')`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L73)。

`getPendingMessages()` 实现在 [`db/messages-in.ts:65-97`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/db/messages-in.ts#L65)：

```ts
const onWakeFilter = hasOnWakeColumn(inbound) ? 'AND (on_wake = 0 OR ?1 = 1)' : '';
const pending = inbound.prepare(
  `SELECT * FROM messages_in
   WHERE status = 'pending'
     AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
     ${onWakeFilter}
   ORDER BY seq DESC
   LIMIT ?2`
).all(isFirstPoll ? 1 : 0, getMaxMessagesPerPrompt()) as MessageInRow[];
```

注意三处设计：
- `ORDER BY seq DESC LIMIT N` 拉最近 N 行（不是所有 pending）——SDK context 不爆。然后第 93 行 `.reverse()` 调回 chronological。
- `on_wake` 条件：列存在才加，新增的 column 用了向后兼容写法（[`messages-in.ts:17-24`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/db/messages-in.ts#L17) 缓存了一次 `PRAGMA table_info`）。
- 第二次过滤是用 outbound 的 `processing_ack` 表减掉已 claim 行（[`messages-in.ts:85-93`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/db/messages-in.ts#L85)）——这是 container 视角的"已处理"判定。

本 trace：返回一行——我们那条 'ping'。`kind='chat'` 不是 'system'，过 filter。

**5.2 心跳日志**：每 30 次循环 log 一行 `Poll heartbeat (... iterations, ... pending)` ([`poll-loop.ts:78-80`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L78))。注意这跟 `.heartbeat` 文件不是同一个东西——文件 touch 在 query 跑起来之后 inner loop 里 ([`poll-loop.ts:361`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L361))。

**5.3 Accumulate gate**：[`if (!messages.some((m) => m.trigger === 1)) { sleep; continue }`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L95)——批里全部都是 trigger=0 时不 wake agent。本 trace 这条 'ping' 是 trigger=1，过 gate。

**5.4 Claim（关键的一步）**：[`markProcessing(ids)`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L101)——实现在 [`messages-in.ts:100-109`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/db/messages-in.ts#L100)：

```ts
const stmt = db.prepare(
  "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', datetime('now'))"
);
db.transaction(() => {
  for (const id of ids) stmt.run(id);
})();
```

写入 outbound.db（container 唯一可写的 session DB），状态 `'processing'`、`status_changed=NOW()`。三件事一次完成：
- **占用语义**：下次 `getPendingMessages()` 看见 ack 就 skip ([`messages-in.ts:91`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/db/messages-in.ts#L91))。
- **进度信号**：host sweep 读 `status_changed` 判断进度（详见 [chapter 10 §"任务 1：processing_ack 同步与 stale 检测"](10-host-sweep.md#任务-1processing_ack-同步与-stale-检测)）。
- **跨进程持久**：container 即使被杀，下次 startup 跑 `clearStaleProcessingAcks()` 会把残留 `'processing'` 删掉，那行又能重新被 process。

**5.5 抽路由**：[`extractRouting(messages)`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L103) 从第一行扒 `platform_id` / `channel_type` / `thread_id` / `inReplyTo`——后面给 messages_out 写 in_reply_to 用。

**5.6 命令分流（/clear 等）**：[`poll-loop.ts:108-128`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L108)——`/clear` 是 runner 自己直接处理的命令（reset continuation，写一条 "Session cleared." 回应），不投给 provider。本 trace 'ping' 不是命令，进 `normalMessages`。

**5.7 Pre-task script gate**：[`poll-loop.ts:148-157`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L148)（`scheduling-pre-task` hook）——把任何带 `script` 字段的 task 行先执行那个 script，让它决定要不要 wake。本 trace 'ping' 是 chat 不是 task，no-op。

**5.8 ack 完毕，下一步进入 formatter**——poll loop 把这批 normalMessages 交给 step 12 的 formatter。我们这一步收束在 `markProcessing(['msg-...'])` 写完。

**为什么 ack + heartbeat 双判依据？** 见第 4 段：心跳证 "JS event loop 活着"，ack 证 "messages_in 拉取 → query 推进有进度"。两条信号独立失败：crash JS 进程同时杀掉两者；只是 query 死循环只杀 ack（心跳还在 inner loop touch）；只是 fs.utimes 失败只丢心跳。Host sweep 用 `Math.max(heartbeat_mtime, ack.status_changed)` 拿 freshness，再用 `container_state` 加宽容忍——三层投票。

## 6. 代码位置

按一轮 poll 的执行顺序：

1. [`container/agent-runner/src/poll-loop.ts:59`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L59)——`migrateLegacyContinuation(providerName)`（startup 一次）
2. [`container/agent-runner/src/poll-loop.ts:67`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L67)——`clearStaleProcessingAcks()`（startup 一次）
3. [`container/agent-runner/src/poll-loop.ts:71-73`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L71)——`while (true)`，`getPendingMessages(isFirstPoll).filter(...)`
4. [`container/agent-runner/src/db/messages-in.ts:65-97`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/db/messages-in.ts#L65)——`getPendingMessages()` 实现
5. [`container/agent-runner/src/db/connection.ts:45-57`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/db/connection.ts#L45)——`openInboundDb()` 短连接（每次新打开关闭，绕过缓存）
6. [`container/agent-runner/src/db/messages-in.ts:85-93`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/db/messages-in.ts#L85)——读 outbound.db `processing_ack` 减掉已 claim 行
7. [`container/agent-runner/src/poll-loop.ts:78-80`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L78)——pollCount 心跳 log
8. [`container/agent-runner/src/poll-loop.ts:82-85`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L82)——`messages.length === 0` 时 sleep 1s
9. [`container/agent-runner/src/poll-loop.ts:95-98`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L95)——accumulate gate（全部 trigger=0 时不 wake）
10. [`container/agent-runner/src/poll-loop.ts:100-101`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L100)——`markProcessing(ids)` 写 ack
11. [`container/agent-runner/src/db/messages-in.ts:100-109`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/db/messages-in.ts#L100)——`markProcessing()` 实现
12. [`container/agent-runner/src/poll-loop.ts:103`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L103)——`extractRouting(messages)`
13. [`container/agent-runner/src/poll-loop.ts:108-138`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L108)——`/clear` 命令分流（本 trace skip）
14. [`container/agent-runner/src/poll-loop.ts:148-157`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L148)——pre-task script gate（本 trace no-op）

## 7. 分支与延伸

- Poll loop 整体——主循环 + inner setInterval 的双层 polling、follow-up push、stale continuation recovery——见 [第 8 章 §`container/agent-runner/src/poll-loop.ts`](08-container-agent-runner.md#containeragent-runnersrcpoll-loopts) 的全函数走读。
- `processing_ack` 表的 schema（`message_id`、`status` 三态、`status_changed` 时间戳）和它跟 `messages_in.status` 的双向同步规则，见 [第 3 章 §3.5.2 Outbound DB schema](03-three-db-model.md#352-outbounddbcontainer--host)。
- Host 端怎么用 `processing_ack.status_changed` 做 stale-container 检测、跟心跳文件 mtime 怎么做 OR/AND、`container_state.tool_declared_timeout_ms` 怎么放宽容忍，见 [第 10 章 §任务 1：processing_ack 同步与 stale 检测](10-host-sweep.md#任务-1processing_ack-同步与-stale-检测)。
- 为什么 `openInboundDb()` 每次新开关而不复用 singleton——VirtioFS / NFS 不传播 mmap coherency 的根本原因和踩坑过程见 [第 8 章 §`bun:sqlite` gotchas](08-container-agent-runner.md#bun-sqlite-gotchas)。
- accumulate / on_wake 这些 router-side flag 怎么 set，见 [第 6 章 §router 与 trigger 规则](06-router.md)。

## 8. 走完这一步你脑子里应该多了什么

- Container 永远不写 inbound.db；"我开始处理这条了"只能写到 outbound.db 的 `processing_ack`——这是 NanoClaw 单写者不变量的具体体现。
- `processing_ack` 同时承担三件事：claim 防重、进度信号、跨重启 idempotency（重启时 `clearStaleProcessingAcks()` 把残留清掉重做）。
- Host sweep 用 **三个独立信号**（ack `status_changed`、heartbeat mtime、`container_state.tool_started_at`）综合判断 container 卡没卡——任何单一信号失败都不足以误判。
- `ORDER BY seq DESC LIMIT N` + `.reverse()` 是"取最近 N 条 + 还原时间序"的标准组合。
- `on_wake=1` 给冷启专属消息、`trigger=0` 给 context-accumulate 消息——两个 flag 互相正交，覆盖 host router 的不同语义。
- pollCount-based log 心跳 ≠ `.heartbeat` 文件 mtime 心跳，不要混淆：前者是人看的 debug log（30 iter 一次），后者是 host sweep 读的 mtime 信号（每个 SDK event touch 一次）。

下一步：把 'ping' 这条 row 跟可能的历史一起拼成 SDK 入参。
