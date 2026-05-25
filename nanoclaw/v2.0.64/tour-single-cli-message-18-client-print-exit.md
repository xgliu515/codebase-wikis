## 1. 当前情境

我们终于回到了客户端进程。上一步 `cliAdapter.deliver()` 在 host 进程里调用了 `client.write(JSON.stringify({ text: 'pong' }) + '\n')`——这个 `client` 是 step 02 里 `claimChatSlot()` 时存进闭包的 `net.Socket`，它的另一端就是 step 01 里 `scripts/chat.ts` 用 `net.connect(socketPath())` 建立的连接。

操作系统视角下，发生了这些事：

- host 端 `client.write` 把字节交给内核 socket buffer（Unix domain socket）。
- 内核把 14 字节（`{"text":"pong"}\n`）从 server-side fd 复制到 client-side fd 的 receive buffer。
- 客户端进程的 `net.Socket` 在 libuv 的 io loop 里收到 `EPOLLIN`，触发 `'data'` 事件。
- Node 的 event loop 把绑在 `socket.on('data', cb)` 上的 callback 排进 microtask queue。

下一刻，`scripts/chat.ts:70` 的 callback 就会被执行。客户端进程此时的状态：

- `firstReplySeen = false`（步骤 01 init 后一直没改过）。
- `silenceTimer = null`（还没启动）。
- `hardTimer` 是 `socket.on('connect')`（`scripts/chat.ts:60-66`）里 setTimeout 120 秒的 handle，挂着没触发。
- `buffer = ''`（流式 line buffer）。
- 出站方向：step 01 写过 `{"text":"ping"}\n` 之后再没写过，half-close 没发起。
- 整个 chat 进程除了 main loop 没有别的工作 —— 它一直在等这个 `'data'` 事件。

## 2. 这一步要解决什么

客户端 `pnpm run chat "ping"` 想做的事是：**收到 agent 的 reply，打印到 stdout，然后干净退出**，把控制权还给 shell（让 `$?` = 0）。把"干净退出"展开，难点其实有四个：

1. **怎么知道 reply 来全了？** TCP / Unix socket 是字节流，不是消息流。一次 `'data'` event 可能给你半条 JSON、可能给你两条 JSON 拼一起。需要 line-based reassembly。
2. **怎么知道 agent 不会再发了？** 一次用户输入 agent 可能回**多条** message（例如 "正在查……"+"找到了：xxx" 两段，或者 ask_question 之后再补一条说明）。如果客户端收到第一条就退出，后面那些就丢了。但 agent 不会主动告诉你"我说完了" —— SDK 也不会发 EOF marker。
3. **怎么避免永远等下去？** 如果 agent 死了 / host 死了 / API 抛错 / network 卡住，客户端不能挂在那 hang 着等永远不来的 reply。
4. **退出码要语义化**。reply 正常收到 → 0；连不上 daemon → 2；超时 → 3。让 shell 脚本能 `if pnpm run chat ...; then ... fi`。

约束 1 是技术问题，有标准解法（line buffer）。约束 2、3 是"什么时候算结束"的设计判断 —— 这是这一步的真正难点。

## 3. 朴素思路：等 server 主动 close socket

最自然的设计是：让 server 端在写完最后一条 reply 后调用 `socket.end()`，客户端 `socket.on('close')` 触发即退出。TCP 的标准 EOF 语义，对端发完 FIN 这边就知道说完了。

这个思路有个明显优势：**精确**。不需要 silence timer 这种 heuristic，agent 知道自己说完了、server 知道 agent 说完了、client 收到 close 信号那一刻就是 reply 结束的精确时刻。0 误差、0 多余等待。

## 4. 朴素思路在哪一档崩

"agent 知道自己说完了" 这句话本身就是错的。展开来看：

- **agent 在 SDK level 没有 "turn end" 信号**。Claude Agent SDK 的 `query()` 返回一个 stream，stream 结束时 agent 这一 turn 是技术性结束了，但**业务层面的"对话回合"**可以包含多次 SDK 调用 —— 例如 ask_question 之后等用户答、agent 拿到回答再继续。host 看到 SDK stream 结束，不能就 `socket.end()`，因为下一秒 agent 可能又触发新 turn 写新 outbound row。
- **outbound row 不带 "is_last" 标志**。`messages_out` schema 里没有"这是这一轮最后一条"的字段（第 3 章 §3.5.2 的字段表可以验证）。host 的 delivery 是按 row 投递，每行独立，根本不知道"轮"的概念。
- **delivery 是 pull，不是 push**。host 是定时扫 outbound.db，扫到几条投几条。在两次 tick 之间 agent 又写了新 row，host 下次 tick 才看到 —— 这意味着即便 host 看到 outbound 表是空的，**也不能推断"agent 没新东西了"**，可能下一秒就有。
- **多 agent / 异步触发**。一个 session 可以挂多个 agent group（fan-out），任何一个 agent 任意时刻都可能往 outbound 写。即便当前 user query 的 agent 完事了，另一个定时触发的 agent 可能马上要 push 一条 reminder。
- **session 是长生命周期，client 是短生命周期**。session 本身可以挂 days/weeks，host 没有 "session 结束" 的概念可以推给 client。client 自己必须决定"什么时候算我的这次 invocation 结束"。

所以 server 不能主动 close —— 它**不知道**该什么时候 close。close 的决策权必须在 client，而 client 在没有任何来自 server 的明确信号的情况下，只能用 **heuristic**：**沉默 N 秒就当结束**。这就是 silence timer 的来由。

那 N 选多少？

- 太短（< 500ms）：agent 在两条 reply 之间想一下，client 就提前退出，后续 reply 丢失（host 还会送到 socket 但 socket 已 close，host 端 `client.write` throw、被 catch 成 warn，消息 mark delivered 但用户没看到）。
- 太长（> 10s）：用户等 shell prompt 等到不耐烦，体感慢。
- **2s** 是 nanoclaw 选的折中：足够覆盖 agent 的常见"思考间隙"（streaming 是 sub-second，多 message 之间几百 ms），又足够短到不让 shell 用户等到烦。配合 120s 的 hard timeout 兜底（agent 完全死透时不会 hang）。

## 5. nanoclaw 的做法：line buffer + first-reply latch + silence timer + hard timer

<svg viewBox="0 0 820 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Client lifecycle: 120s hard timer until first reply, then 2s silence timer reset per reply, exit 0/3">
  <defs>
    <marker id="ce-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <text x="410" y="20" font-size="13" font-weight="700" fill="currentColor" text-anchor="middle">chat.ts client — 120s hardTimer until firstReplySeen, then 2s silenceTimer per reply</text>
  <text x="60" y="50" font-size="10" fill="#94a3b8">t=</text>
  <line x1="80" y1="46" x2="780" y2="46" stroke="#cbd5e1"/>
  <text x="100" y="38" font-size="9" fill="#64748b">0s</text>
  <text x="240" y="38" font-size="9" fill="#64748b">~3s</text>
  <text x="380" y="38" font-size="9" fill="#64748b">~3.5s</text>
  <text x="520" y="38" font-size="9" fill="#64748b">~5.5s</text>
  <text x="660" y="38" font-size="9" fill="#64748b">→ exit 0</text>
  <rect x="20" y="62" width="780" height="86" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="30" y="80" font-size="11" font-weight="700" fill="#9a3412">Phase 1 · hardTimer = 120s (firstReplySeen = false)</text>
  <line x1="100" y1="118" x2="380" y2="118" stroke="#dc2626" stroke-width="3"/>
  <circle cx="100" cy="118" r="6" fill="#dc2626"/>
  <text x="100" y="138" font-size="9" fill="currentColor" text-anchor="middle">connect</text>
  <text x="100" y="92" font-size="9" fill="#94a3b8" text-anchor="middle">setTimeout</text>
  <text x="100" y="104" font-size="9" fill="#94a3b8" text-anchor="middle">120s</text>
  <text x="240" y="100" font-size="9" fill="#dc2626" text-anchor="middle">if no reply by 120s → exit 3 (timeout)</text>
  <circle cx="380" cy="118" r="10" fill="#16a34a"/>
  <text x="380" y="138" font-size="10" font-weight="700" fill="#16a34a" text-anchor="middle">first 'pong'</text>
  <text x="380" y="92" font-size="9" fill="#16a34a" text-anchor="middle" font-weight="600">clearTimeout</text>
  <text x="380" y="104" font-size="9" fill="#16a34a" text-anchor="middle" font-weight="600">latch flips</text>
  <rect x="20" y="160" width="780" height="120" rx="6" fill="#ecfdf5" stroke="#0d9488" stroke-width="1.2"/>
  <text x="30" y="178" font-size="11" font-weight="700" fill="#0f766e">Phase 2 · silenceTimer = 2s (reset on every reply)</text>
  <line x1="380" y1="218" x2="660" y2="218" stroke="#0d9488" stroke-width="3"/>
  <circle cx="380" cy="218" r="6" fill="#0d9488"/>
  <text x="380" y="238" font-size="9" fill="currentColor" text-anchor="middle">stdout.write</text>
  <circle cx="450" cy="218" r="5" fill="#0d9488"/>
  <text x="450" y="238" font-size="9" fill="#94a3b8" text-anchor="middle">reply 2 (resets)</text>
  <circle cx="520" cy="218" r="5" fill="#0d9488"/>
  <text x="520" y="238" font-size="9" fill="#94a3b8" text-anchor="middle">reply 3 (resets)</text>
  <line x1="520" y1="218" x2="660" y2="218" stroke="#0d9488" stroke-width="3" stroke-dasharray="3,2"/>
  <text x="590" y="208" font-size="9" fill="#0d9488" text-anchor="middle">2s silence</text>
  <circle cx="660" cy="218" r="10" fill="#7c3aed"/>
  <text x="660" y="238" font-size="9" fill="#7c3aed" text-anchor="middle" font-weight="600">socket.end() + exit 0</text>
  <text x="410" y="262" font-size="10" fill="#64748b" text-anchor="middle">why 2s? covers multi-message gaps without making shell wait too long</text>
  <text x="410" y="274" font-size="10" fill="#dc2626" text-anchor="middle">naive "server.end() on done" can't work — agent has no "turn end" signal</text>
  <rect x="20" y="292" width="780" height="36" rx="4" fill="#fef3c7" stroke="#ea580c" stroke-width="1.2"/>
  <text x="410" y="308" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">exit codes: 0 ok · 1 usage · 2 daemon down (ENOENT/ECONNREFUSED) · 3 timeout</text>
  <text x="410" y="322" font-size="10" fill="#64748b" text-anchor="middle">on socket.close: exit(firstReplySeen ? 0 : 3) — server-initiated close also clean</text>
</svg>
<span class="figure-caption">图 T1.28 ｜ chat.ts 客户端两段超时模型：Phase 1（红）firstReplySeen 之前用 120s 硬超时防 agent 死透；Phase 2（青）每收一条 reply 重置 2s silence timer，最后一条之后 2s 静默触发干净退出。</span>

<details>
<summary>ASCII 原版</summary>

```
Phase 1 (firstReplySeen=false):     Phase 2 (firstReplySeen=true):
  hardTimer = 120s                     silenceTimer = 2s (reset per reply)

t=0s ────────────────────► 3s        3s ── 3.5s ── 5.5s ── 2s silence ── exit 0
     connect ... waiting              'pong' reply2 reply3
     (if 120s no reply → exit 3)      clearHard  reset  reset  silence trips

exit codes:  0 ok | 1 usage | 2 daemon down | 3 timeout
```

</details>

整段 client 收数据逻辑就 `scripts/chat.ts:69-92`：

```ts
let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx: number;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (typeof msg.text === 'string') {
        process.stdout.write(msg.text + '\n');
        firstReplySeen = true;
        if (hardTimer) {
          clearTimeout(hardTimer);
          hardTimer = null;
        }
        scheduleExit();
      }
    } catch {
      // Ignore non-JSON lines — forward compatibility.
    }
  }
});
```

逐块拆：

**Line buffer（`scripts/chat.ts:69-76`）**。`buffer` 持续累积字节，每次循环 `indexOf('\n')` 找到一条完整 line 就切走、剩下的留到下一个 chunk。`if (!line) continue` 处理连续 `\n\n` 或末尾空 line。这是 Node 网络代码里教科书级的 line reassembly，没有花活。

**JSON.parse + `msg.text` 字段检查（`scripts/chat.ts:77-81`）**。wire format 是 `{ text: string }`，但 client 用 `if (typeof msg.text === 'string')` 而不是 destructuring + assert——是为了**forward compatibility**。server 端如果未来发了带额外字段的 line（比如 `{ text: 'pong', toolUse: { ... } }`），老 client 仍能正确打印 `text`，忽略不认识的字段。catch 块也是同样意图：非 JSON line 直接 ignore，留给 server 未来加 protocol marker 用（比如 `# heartbeat` 之类）。

**`stdout.write(msg.text + '\n')`**。注意是 `write` 不是 `console.log`。`console.log` 会做额外的 format（util.format）、做 newline 处理、走 Console object 的 stream 锁。在客户端这种"我只想原样吐字符串"的场景，`stdout.write` 更直接更可控。

**`firstReplySeen = true` + 杀 hardTimer**。这是 latch：一旦看到任何 reply，120s 的硬超时就解除。`hardTimer` 只防"agent 完全没动静"的最坏情况；只要看见一条 reply 就证明系统活着，后续等多久由 silence timer 控制。

**`scheduleExit()`（`scripts/chat.ts:50-56`）**。

```ts
function scheduleExit(): void {
  if (silenceTimer) clearTimeout(silenceTimer);
  silenceTimer = setTimeout(() => {
    socket.end();
    process.exit(0);
  }, SILENCE_MS);
}
```

`clearTimeout(silenceTimer)` 是关键——**每条新 reply 都重置 silence timer**。所以 silence 的语义是"距离最后一条 reply 已过 SILENCE_MS"，不是"距离第一条 reply 已过 SILENCE_MS"。多条 reply 流式过来时 timer 不断重置，最后一条之后 2s 没动静才真触发退出。

**退出动作**：`socket.end()` 触发 TCP half-close（client → server 方向 FIN），让 host 端 `socket.on('close')` fire、`client = null` 复位（`src/channels/cli.ts:171-174`）。然后 `process.exit(0)`。

**`socket.on('close')` 兜底（`scripts/chat.ts:94-98`）**：

```ts
socket.on('close', () => {
  if (silenceTimer) clearTimeout(silenceTimer);
  if (hardTimer) clearTimeout(hardTimer);
  process.exit(firstReplySeen ? 0 : 3);
});
```

如果 server 因任何原因主动 close（host 重启、server-side 异常），客户端能干净退出而不是 hang。退出码看 firstReplySeen——见过 reply 就当成功，没见过就是 3（数据丢失或服务异常）。

**整体退出码语义**：

| 触发 | 退出码 | 来源 |
|------|--------|------|
| 收到 reply、silence 2s | 0 | `scheduleExit` 内 `process.exit(0)` |
| socket 无 args | 1 | `scripts/chat.ts:28-30` |
| daemon 不可达（ENOENT / ECONNREFUSED） | 2 | `socket.on('error')` `scripts/chat.ts:35-44` |
| 120s 内没有 reply | 3 | hardTimer 内 `process.exit(3)` |
| 收到部分 reply 后 server 异常 close | 0 / 3 | `socket.on('close')` 看 `firstReplySeen` |

这些码让 shell 脚本能区分"agent 没回应"、"daemon 没起"、"成功"，不需要 stderr 解析。

回到 user 的视角：terminal 上出现一行 `pong`、shell prompt 返回、`$?` 是 0。整个 trace 闭环。

## 6. 代码位置（按读这一步源码的顺序）

| 顺序 | 文件:行 | 是什么 |
|------|---------|--------|
| 1 | `scripts/chat.ts:18-19` | `SILENCE_MS = 2000` / `TOTAL_TIMEOUT_MS = 120_000` 常量 |
| 2 | `scripts/chat.ts:46-48` | `firstReplySeen` / `silenceTimer` / `hardTimer` 三个状态变量声明 |
| 3 | `scripts/chat.ts:50-56` | `scheduleExit`：silence timer 重置 + 触发退出 |
| 4 | `scripts/chat.ts:58-67` | `socket.on('connect')`：发起请求 + 装 hardTimer |
| 5 | `scripts/chat.ts:69-92` | `socket.on('data')`：line buffer + JSON.parse + 打印 + 重置 timer |
| 6 | `scripts/chat.ts:94-98` | `socket.on('close')`：兜底退出 + 退出码判定 |
| 7 | `src/channels/cli.ts:171-174` | host 侧 `socket.on('close')`：把 `client` 置 null，对应 client 退出后的 server 状态 |

## 7. 分支与延伸

- 想看 wire format 的完整定义（包括 `to` / `reply_to` 这些 client → server 方向的 admin 字段、`superseded by a newer client` 这种 server → client 的 control message）：跳第 11 章 [In-tree CLI adapter](11-channels-adapters.md#in-tree-cli-adapter)。
- 想理解为什么 silence 设到 2s 而不是其他值、为什么不让 server 主动 close 的根本原因（system action / multi-turn）：跳第 9 章 [出站投递与系统动作](09-outbound-delivery.md#出站投递与系统动作)。
- 回到 trace 的起点看完整环路：[Trace step 01 —— 客户端连上 CLI socket](tour-single-cli-message-01-chat-script.md)。

## 8. 走完这一步你脑子里应该多了什么 + 整条 tour 闭环复盘

**本步 takeaway**：

1. **client 用 silence timer 决定何时退出**，不是靠 server 主动 close —— 因为 server 不知道 agent 啥时候说完。2s 是覆盖多 message 切分 / 又不让 user 等太久的折中。
2. **firstReplySeen latch 双段超时模型**：见到第一条 reply 之前用 120s 硬超时防 agent 死透；之后切换到 2s silence timer 防 hang。
3. **退出码语义化**：0 / 1 / 2 / 3 对应成功 / usage / daemon down / timeout，让 shell 脚本可判断。
4. **wire format 的 forward compatibility 来自 client 的"只认 `msg.text` 字段、其他全 ignore"**——server 加新字段时老 client 不会爆。

<svg viewBox="0 0 880 520" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Full 18-step closure: client to host to inbound DB to container to SDK to outbound DB to delivery and back">
  <defs>
    <marker id="cl-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
    <marker id="cl-arO" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/></marker>
    <marker id="cl-arP" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" font-size="14" font-weight="700" fill="currentColor" text-anchor="middle">Full 18-step closure: 2 processes · 3 SQLite files · 1 Unix socket · 1 container · 1 Anthropic stream</text>
  <rect x="20" y="40" width="180" height="460" rx="6" fill="#0ea5e9" opacity="0.08" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="110" y="58" font-size="11" font-weight="700" fill="#0369a1" text-anchor="middle">CLI client</text>
  <text x="110" y="72" font-size="10" fill="#64748b" text-anchor="middle">(scripts/chat.ts)</text>
  <rect x="220" y="40" width="220" height="460" rx="6" fill="#0d9488" opacity="0.08" stroke="#0d9488" stroke-width="1.2"/>
  <text x="330" y="58" font-size="11" font-weight="700" fill="#0f766e" text-anchor="middle">Host (Node)</text>
  <text x="330" y="72" font-size="10" fill="#64748b" text-anchor="middle">adapter / router / sessions / delivery</text>
  <rect x="460" y="40" width="180" height="460" rx="6" fill="#7c3aed" opacity="0.08" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="550" y="58" font-size="11" font-weight="700" fill="#5b21b6" text-anchor="middle">SQLite (the wire)</text>
  <text x="550" y="72" font-size="10" fill="#64748b" text-anchor="middle">v2.db · inbound.db · outbound.db</text>
  <rect x="660" y="40" width="200" height="460" rx="6" fill="#ea580c" opacity="0.08" stroke="#ea580c" stroke-width="1.2"/>
  <text x="760" y="58" font-size="11" font-weight="700" fill="#9a3412" text-anchor="middle">Container (Bun)</text>
  <text x="760" y="72" font-size="10" fill="#64748b" text-anchor="middle">poll-loop · formatter · provider · SDK</text>
  <rect x="32" y="88" width="156" height="34" rx="4" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="110" y="103" font-size="10" font-weight="700" fill="currentColor" text-anchor="middle">01 chat.ts connect</text>
  <text x="110" y="115" font-size="9" fill="#64748b" text-anchor="middle">net.connect /tmp/.../cli.sock</text>
  <rect x="232" y="130" width="196" height="34" rx="4" fill="#ffffff" stroke="#0d9488"/>
  <text x="330" y="145" font-size="10" font-weight="700" fill="currentColor" text-anchor="middle">02 CLI adapter accept</text>
  <text x="330" y="157" font-size="9" fill="#64748b" text-anchor="middle">claimChatSlot · '{"text":"ping"}'</text>
  <rect x="232" y="170" width="196" height="34" rx="4" fill="#ffffff" stroke="#0d9488"/>
  <text x="330" y="185" font-size="10" font-weight="700" fill="currentColor" text-anchor="middle">03-07 router · session</text>
  <text x="330" y="197" font-size="9" fill="#64748b" text-anchor="middle">resolve mg · ensureContainer</text>
  <rect x="472" y="210" width="156" height="34" rx="4" fill="#ffffff" stroke="#7c3aed"/>
  <text x="550" y="225" font-size="10" font-weight="700" fill="currentColor" text-anchor="middle">08 INSERT inbound.db</text>
  <text x="550" y="237" font-size="9" fill="#64748b" text-anchor="middle">messages_in seq=2 (even)</text>
  <rect x="232" y="250" width="196" height="34" rx="4" fill="#ffffff" stroke="#0d9488"/>
  <text x="330" y="265" font-size="10" font-weight="700" fill="currentColor" text-anchor="middle">09 container-runner</text>
  <text x="330" y="277" font-size="9" fill="#64748b" text-anchor="middle">docker run + spawn blob (fire-forget)</text>
  <rect x="672" y="290" width="180" height="34" rx="4" fill="#ffffff" stroke="#ea580c"/>
  <text x="762" y="305" font-size="10" font-weight="700" fill="currentColor" text-anchor="middle">10-11 boot + poll-loop</text>
  <text x="762" y="317" font-size="9" fill="#64748b" text-anchor="middle">loadConfig · markProcessing</text>
  <rect x="672" y="330" width="180" height="34" rx="4" fill="#ffffff" stroke="#ea580c"/>
  <text x="762" y="345" font-size="10" font-weight="700" fill="currentColor" text-anchor="middle">12-13 formatter + SDK</text>
  <text x="762" y="357" font-size="9" fill="#64748b" text-anchor="middle">XML prompt + resume:continuation</text>
  <rect x="672" y="370" width="180" height="34" rx="4" fill="#ffffff" stroke="#ea580c"/>
  <text x="762" y="385" font-size="10" font-weight="700" fill="currentColor" text-anchor="middle">14 dual-track (await+push)</text>
  <text x="762" y="397" font-size="9" fill="#64748b" text-anchor="middle">heartbeat per event</text>
  <rect x="472" y="410" width="156" height="34" rx="4" fill="#ffffff" stroke="#7c3aed"/>
  <text x="550" y="425" font-size="10" font-weight="700" fill="currentColor" text-anchor="middle">15 INSERT outbound.db</text>
  <text x="550" y="437" font-size="9" fill="#64748b" text-anchor="middle">messages_out seq=3 (odd)</text>
  <rect x="232" y="450" width="196" height="34" rx="4" fill="#ffffff" stroke="#0d9488"/>
  <text x="330" y="465" font-size="10" font-weight="700" fill="currentColor" text-anchor="middle">16-17 delivery + adapter</text>
  <text x="330" y="477" font-size="9" fill="#64748b" text-anchor="middle">pollActive 1s · client.write +\n</text>
  <rect x="32" y="450" width="156" height="34" rx="4" fill="#ffffff" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="110" y="465" font-size="10" font-weight="700" fill="currentColor" text-anchor="middle">18 print + exit 0</text>
  <text x="110" y="477" font-size="9" fill="#64748b" text-anchor="middle">silence 2s · socket.end()</text>
  <line x1="188" y1="105" x2="230" y2="140" stroke="#0d9488" stroke-width="1.2" marker-end="url(#cl-ar)"/>
  <line x1="330" y1="164" x2="330" y2="168" stroke="#0d9488" stroke-width="1.2" marker-end="url(#cl-ar)"/>
  <line x1="428" y1="187" x2="470" y2="218" stroke="#7c3aed" stroke-width="1.2" marker-end="url(#cl-arP)"/>
  <line x1="470" y1="227" x2="430" y2="262" stroke="#0d9488" stroke-width="1.2" marker-end="url(#cl-ar)"/>
  <line x1="428" y1="267" x2="670" y2="300" stroke="#ea580c" stroke-width="1.2" marker-end="url(#cl-arO)"/>
  <text x="546" y="282" font-size="9" fill="#ea580c" font-style="italic">spawn (one-shot)</text>
  <line x1="672" y1="307" x2="630" y2="220" stroke="#7c3aed" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#cl-arP)"/>
  <text x="640" y="266" font-size="9" fill="#7c3aed" font-style="italic">SELECT inbound</text>
  <line x1="762" y1="364" x2="762" y2="368" stroke="#ea580c" stroke-width="1.2" marker-end="url(#cl-arO)"/>
  <line x1="762" y1="404" x2="630" y2="418" stroke="#7c3aed" stroke-width="1.2" marker-end="url(#cl-arP)"/>
  <text x="700" y="416" font-size="9" fill="#7c3aed" font-style="italic">INSERT outbound</text>
  <line x1="470" y1="427" x2="430" y2="462" stroke="#0d9488" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#cl-ar)"/>
  <text x="438" y="450" font-size="9" fill="#0d9488" font-style="italic">poll (1s)</text>
  <line x1="230" y1="467" x2="190" y2="467" stroke="#0d9488" stroke-width="1.2" marker-end="url(#cl-ar)"/>
  <text x="210" y="460" font-size="9" fill="#0d9488">socket.write</text>
  <text x="110" y="494" font-size="9" fill="#dc2626" text-anchor="middle">no host↔container IPC — only 3 SQLite files</text>
  <text x="550" y="494" font-size="9" fill="#7c3aed" text-anchor="middle">single-writer: each table has exactly one writer</text>
  <text x="762" y="494" font-size="9" fill="#ea580c" text-anchor="middle">wake = fire-forget · delivery = pull</text>
</svg>
<span class="figure-caption">图 T1.29 ｜ 整条 18 步闭环：4 列泳道（client / host / SQLite / container）覆盖 18 个步骤；紫色箭头是 DB 读写（唯一的跨进程同步点），青/橙箭头是同进程调用，蓝→青是 socket。注意：host↔container 之间 ZERO IPC，只通过 3 个 SQLite 文件对账。</span>

<details>
<summary>ASCII 原版</summary>

```
CLI client       Host (Node)            SQLite (the wire)        Container (Bun)
──────────       ───────────            ─────────────────        ─────────────────
01 chat.ts ──socket──► 02 CLI adapter
                       03-07 router/session
                                 │ INSERT
                                 ▼
                               08 inbound.db (seq=2 even)
                       09 container-runner ──── spawn (one-shot) ──►
                                                                  10-11 boot + poll-loop
                                                                          │ SELECT
                                                                          ▼
                                                                  12-13 formatter + SDK
                                                                  14 dual-track (await+push)
                                                                          │ INSERT
                                                                          ▼
                                                                  15 outbound.db (seq=3 odd)
                       16-17 delivery + adapter ◄─ pollActive 1s ──┘
                                 │ socket.write
                                 ▼
18 print + exit 0
```

</details>

**整条 tour 闭环复盘**——18 步走下来你应该带走的 macro 认知：

1. **一次完整 trace 跨过了 18 步、2 个进程（host Node、container Bun）、3 个 SQLite 文件（v2.db、inbound.db、outbound.db）、1 个 Unix socket、1 个 Docker container、1 个 HTTP 流式连接到 Anthropic API**。链条是 chat.ts → cli adapter → router → session-manager → inbound.db → container-runner → poll-loop → formatter → provider → SDK → outbound.db → delivery → cli adapter → chat.ts。读完每一步你心里应该能默写出这条链。
2. **整个系统里唯一的跨进程同步点就是那两个 session DB 文件**（inbound.db、outbound.db）。host 和 container 之间没有 IPC、没有 socket、没有 shared memory、没有任何长连接。这是"一切皆消息、消息皆持久化"的最极致版本——任何一边崩了，另一边只需要 reopen DB 就能 resume。
3. **wake 是 fire-and-forget；delivery 是 pull-based**。host 唤醒 container 是单次信号（step 09），不要求 ack；container 写完 outbound 不通知 host（step 16），host 自己定时来扫。这两个设计是 push / pull 的极端选择，但底层 reasoning 一致：**任何依赖对端 alive 的同步原语都会在 crash 场景下需要补偿，与其补偿不如绕开**。
4. **host crash、container crash、client crash 都可恢复，没有 in-memory data loss 风险**。所有"系统状态"都在 SQLite 文件里：messages_in、messages_out、delivered 三张表把"消息在系统里走到了哪一步"完整描述出来。重启任意一方，对账机制（delivery 的 `delivered` 表 diff、container 的 `processing_ack`）自然继续推进。
5. **这条 CLI tour 走过的 18 步，对 Discord / Slack / Telegram 同样适用**。只有 step 02（adapter 收字节）和 step 17（adapter 投递回 channel）的实现不同——其它 16 步是 router、session-manager、container-runner、poll-loop、formatter、provider、SDK、delivery，**channel 一律不参与**。这就是 channel adapter 抽象的真正回报：换 channel 不动核心。
