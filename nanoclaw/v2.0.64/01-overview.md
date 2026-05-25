## 一切皆消息

NanoClaw 是个人 Claude 助手网关：一个 Node 单进程同时挂在 Discord / Slack / Telegram / iMessage / WhatsApp / 邮件 / 本地终端等若干渠道上，按"实体模型"（用户 → 消息组 → 智能体组 → session）把消息路由到对应的 agent，再为每个 session 启动一个独立容器执行 Claude Agent SDK。

整套系统只有 **一个跨进程通信原语**：SQLite 文件。host 进程和容器之间没有 IPC socket、没有 stdin pipe、没有 inotify、没有 HTTP — 全部消息（用户的聊天、调度任务、Webhook、agent 给 host 的"系统动作"请求、host 给 agent 的"系统动作"回应、approval 卡片、按钮点击、reaction、消息编辑……）都化作 SQLite 表里的一行。

这章解释 NanoClaw 为什么会变成这副样子。

---

### 1. 设计问题

把它写得具体一点：

- 一个人在用 5 个聊天平台。在每个平台上有若干个"和 agent 对话"的窗口（Discord 的某个 channel、Slack 的某个 thread、Telegram DM、iMessage 群、WhatsApp 群……）。
- 这个人想为不同任务配置不同的 agent：一个负责 PR Review，一个负责日程，一个负责"和我聊天的私人助手"，一个负责 GitHub webhook 触发的工程任务。
- 每个 agent 需要 **独立的工作空间**：自己的 `CLAUDE.md`、自己的 skills、自己的 MCP 服务器、自己安装的 apt/npm 包、自己的 OneCLI 凭证子集。
- 每个 agent 又会派生出多个 **并发 session**：同一个 PR Review agent 会同时处理 10 个 PR thread，每个 thread 自带独立的 Claude SDK session、独立的对话历史、独立的 `.claude/` 持久化目录。
- 整个系统要能 **重启** 而不丢消息：一个 session 在跑到一半时容器被 kill（OOM、用户重启服务、agent 主动 `/clear`），下一次 wake 时所有未处理的入站消息必须还在，所有未投递的出站消息必须还在。
- 用户的 OAuth token / API key 不能 **泄漏给 agent**：agent 可以"使用"凭证（通过本地代理网关），但不能在上下文里看见凭证明文。
- agent 可以请求系统级动作（注册新 channel、安装包、重启容器、用别的 agent 名义发消息），但必须经过 **人工 approval**，approval 卡片要发到 admin 的某个 DM。

这是一个典型的"**多渠道、多 agent、长生命周期、高隔离要求**"的编排问题。

---

### 2. 几个直觉答案，逐一不够

#### 2.1 直觉一："单进程多线程，每个 session 一个 worker"

最简单的想法：host 进程内开一个 worker pool，每个 session 一个 Worker thread 跑 Claude SDK。

为什么不够：

- **隔离**：worker thread 共享文件系统。agent 在 `/workspace` 里写文件，会污染其他 agent 的 workspace。要给每个 agent 独立 chroot，意味着重新发明容器。
- **依赖隔离**：每个 agent 可以自己安装 apt/npm 包（self-mod 流程支持），这必然要 root + 独立 rootfs。worker thread 做不到。
- **OOM 隔离**：Claude SDK + browser automation + headless Chromium 内存常见到 1-2 GB。一个 worker OOM 不能把整个 host 拖垮。
- **凭证隔离**：OneCLI gateway 通过 HTTP proxy + CA cert 给每个 agent 注入凭证。每个 agent 进程的网络栈被独立的 envoy/HTTP_PROXY 配置接管 — 这只在独立网络命名空间里说得通。
- 结论：**必须用容器，每个 session 一个容器**。

#### 2.2 直觉二："host ↔ container 用 IPC（Unix socket / gRPC）"

容器化之后下一个问题：host 怎么和容器里的 agent 通信？

最直接：在容器里跑一个 RPC 服务器（Unix socket / gRPC over local TCP），host 推消息进来，agent 推结果出去。

为什么不够：

- **心跳与重连**：每个 socket 都需要心跳来检测对端死活，需要重连逻辑。一个 session 平均每天可能只收 3-5 条消息，但 socket 要 24 小时挂着。这是大量为零收益的活体连接。
- **容器死亡时状态丢失**：如果消息只活在 socket buffer 里，容器 OOM 时这条消息就丢了。要不丢，就必须有持久化 — 那就回到了"消息走数据库"的方案。
- **半双工 stdin pipe**：在 v1 里曾经尝试过用 stdin pipe 给 agent 喂消息，容器内输出走 stdout 加特殊 marker 解析。这种方案：
  - 受限于 PTY buffer 大小；
  - 容易卡死在没人 read 的 pipe 上；
  - agent 容器一旦死，所有未读完的输出永久丢失；
  - 没法做"agent 主动请求 host 帮忙做事"这种反向调用 — 你得用控制字符或 sentinel 字符串再发明一种协议。
- 结论：**socket / pipe 都不够，需要一个持久化、双向、对断电安全的消息表面**。

#### 2.3 直觉三："共享文件 + 文件监听 (inotify / fsevents)"

继续退一步：让 host 把消息写成 `/data/sessions/<id>/inbox/<msg>.json`，容器里跑 inotify 监听新文件，agent 处理完写到 `outbox/`。

为什么不够：

- **跨挂载边界的 inotify 不可靠**：Docker bind mount 在 macOS / Linux VirtioFS 下，inotify 事件经常丢失或延迟数秒到数分钟。Apple Container 同理。NanoClaw 既要支持 Linux Docker 也要支持 macOS Apple Container — 没有任何 inotify 实现是跨这两个 runtime 都稳定的。
- **没有原子性**：写一个 `msg.json` 文件不是原子操作。读端可能读到半个文件。要"先写到 `.tmp` 再 rename"再加上 fsync，这套逻辑很容易写错。
- **没有事务/查询**：要查"所有未处理的消息"，要 `readdir` + 解析每个文件 + 按 timestamp 排序。在消息数量多时极慢。
- **没有索引**：要根据 messageId 做编辑、根据 seq 做 reaction —— 全都要扫目录。
- 结论：**文件系统作为消息传递面，需要重新发明半个数据库**。

#### 2.4 直觉四："共享 SQLite，host 和 container 都读写"

那就用 SQLite。host 和容器都打开同一个 `session.db`，host 写 `messages_in`、读 `messages_out`；容器读 `messages_in`、写 `messages_out`。

这条路接近答案了，但有一个坑：

- **跨挂载的 SQLite 多 writer 不可靠**。WAL 模式靠 `-shm` 共享内存映射，VirtioFS / 9P / gVisor 上的 `mmap` 在 host ↔ guest 之间不会一致更新 — 容器读 WAL 帧时会读到陈旧的 page cache。
- 改 `journal_mode=DELETE` 部分缓解，但 DELETE 模式下 journal 文件的 unlink 不是跨挂载原子的 — host 和容器同时尝试写时偶发数据库 corruption。
- 即便用 `busy_timeout` 顶着锁竞争，调试起来仍然是不可复现的灾难。
- 结论：**SQLite 是对的，但必须保证每个 DB 文件只有一个 writer**。

---

### 3. NanoClaw 的选择：两个 DB + 单 writer + everything-is-a-message

把上面的约束合到一起，NanoClaw 的设计是：

> **每个 session 有两个 SQLite 文件。`inbound.db` 只由 host 写，container 只读。`outbound.db` 只由 container 写，host 只读。所有跨进程通信都是这两个文件里的行。**

这同时解决了所有问题：

| 约束 | 解决方式 |
|------|----------|
| 隔离 | 每个 session 一个容器，session DB bind-mount 进容器 |
| 持久化 | SQLite 本身。容器 OOM 不丢消息 |
| 双向通信 | 两个 DB，host 写 inbound、container 写 outbound |
| 锁竞争 | 每个文件 **正好一个 writer**，没有跨挂载锁 |
| 半双工无效 | 不存在 stdin / pipe，agent 主动发起的"系统动作"也是 `outbound.db` 里的 `kind: 'system'` 行 |
| 心跳 | 容器周期性 `touch /workspace/.heartbeat`，文件 mtime 是 liveness — 不抢 DB 写锁 |
| 编辑、reaction、approval、调度、agent-to-agent | 全都用 `messages_in` / `messages_out` 里的特殊 `kind` 或 `operation` 字段 |

这就是 `CLAUDE.md:24` 反复强调的那句话：

> Everything is a message. There is no IPC, no file watcher, no stdin piping between host and container. The two session DBs are the sole IO surface.

也是 `docs/db.md:24` 里 single-writer rule 的来源：

> Every SQLite file has exactly one writer. Host writes the central DB and every `inbound.db`; container writes only its own `outbound.db`.

---

### 4. 三 DB 模型

NanoClaw 实际上有 **三种** SQLite 数据库（不是三个 — 是三种角色）：

<svg viewBox="0 0 820 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="NanoClaw three DB roles: central, inbound, outbound">
  <defs>
    <marker id="ar-r11" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="20" y="20" width="200" height="320" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="120" y="42" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">HOST (Node)</text>
  <text x="120" y="60" text-anchor="middle" font-size="10" fill="#64748b">better-sqlite3</text>
  <rect x="600" y="20" width="200" height="320" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="700" y="42" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">CONTAINER (Bun)</text>
  <text x="700" y="60" text-anchor="middle" font-size="10" fill="#64748b">bun:sqlite</text>
  <rect x="260" y="80" width="300" height="58" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="410" y="103" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">Central DB · data/v2.db</text>
  <text x="410" y="122" text-anchor="middle" font-size="10" fill="#64748b">identities · roles · wiring · approvals · sessions</text>
  <rect x="260" y="158" width="300" height="58" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="410" y="181" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">inbound.db</text>
  <text x="410" y="200" text-anchor="middle" font-size="10" fill="#64748b">host writes · container reads (RO)</text>
  <rect x="260" y="236" width="300" height="58" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="410" y="259" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">outbound.db</text>
  <text x="410" y="278" text-anchor="middle" font-size="10" fill="#64748b">container writes · host reads (RO)</text>
  <rect x="260" y="304" width="300" height="36" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="410" y="327" text-anchor="middle" font-size="11" fill="currentColor">.heartbeat (mtime · no lock)</text>
  <line x1="220" y1="109" x2="258" y2="109" stroke="#0d9488" stroke-width="1.6" marker-end="url(#ar-r11)"/>
  <text x="239" y="100" text-anchor="middle" font-size="9" fill="#0d9488">RW</text>
  <line x1="220" y1="187" x2="258" y2="187" stroke="#0d9488" stroke-width="1.6" marker-end="url(#ar-r11)"/>
  <text x="239" y="178" text-anchor="middle" font-size="9" fill="#0d9488">RW</text>
  <line x1="562" y1="187" x2="598" y2="187" stroke="#ea580c" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar-r11)"/>
  <text x="580" y="178" text-anchor="middle" font-size="9" fill="#ea580c">RO</text>
  <line x1="220" y1="265" x2="258" y2="265" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar-r11)"/>
  <text x="239" y="256" text-anchor="middle" font-size="9" fill="#0d9488">RO</text>
  <line x1="562" y1="265" x2="598" y2="265" stroke="#ea580c" stroke-width="1.6" marker-end="url(#ar-r11)"/>
  <text x="580" y="256" text-anchor="middle" font-size="9" fill="#ea580c">RW</text>
  <line x1="562" y1="322" x2="598" y2="322" stroke="#ea580c" stroke-width="1.6" marker-end="url(#ar-r11)"/>
  <text x="580" y="313" text-anchor="middle" font-size="9" fill="#ea580c">touch</text>
  <text x="410" y="350" text-anchor="middle" font-size="10" fill="#94a3b8">single-writer rule · no IPC · no socket · no pipe</text>
</svg>
<span class="figure-caption">图 R1.1 ｜ 三 DB 角色与单 writer 边界：host 独占中央 + inbound，container 独占 outbound + 心跳</span>

<details>
<summary>ASCII 原版</summary>

```
data/
  v2.db                                   <- CENTRAL: 中央 DB（host 写，host 读）
  v2-sessions/
    <agent_group_id>/
      .claude-shared/                     <- 这个 agent group 的 Claude SDK 共享状态
      agent-runner-src/                   <- 每个 group 的 agent-runner 源代码 overlay
      <session_id>/
        inbound.db                        <- 这个 session 的入站消息（host 写，container 读）
        outbound.db                       <- 这个 session 的出站消息（container 写，host 读）
        .heartbeat                        <- 容器周期 touch，liveness 信号
        inbox/<message_id>/               <- 用户附件解码后落盘
        outbox/<message_id>/              <- agent 产出的附件
```

</details>

| DB | 路径 | Writer | Reader | 用途 |
|----|------|--------|--------|------|
| **中央** | `data/v2.db` | host | host | 身份、权限、wiring、approval、session 注册表 — admin plane |
| **session inbound** | `data/v2-sessions/<group>/<session>/inbound.db` | host | host（同步）、container（只读） | host → container 的消息 + 路由投影 |
| **session outbound** | `data/v2-sessions/<group>/<session>/outbound.db` | container | host（轮询） | container → host 的消息 + 处理状态 |

不要把中央 DB 和 session DB 混淆 — 它们职责完全不同：

- **中央 DB** 是 "**谁是谁、谁能访问谁**" — 用户、角色、agent group、messaging group、wiring 规则、approval 排队、session 注册表。它从不接触消息内容。schema 在 `src/db/schema.ts`，通过 `src/db/migrations/` 下的 numbered migrations 演化。
- **session DB（两个）** 是 "**这个具体对话里发生了什么**" — 入站消息、出站消息、处理状态、本地路由投影。它们在 session 创建时由 `ensureSchema()` (`src/db/session-db.ts:13`) 用 `CREATE TABLE IF NOT EXISTS` 建出来，没有 numbered migration — schema 演进靠 lazy migration helper（如 `migrateDeliveredTable()`）。

#### 4.1 Seq parity（偶/奇分号段）

`inbound.db` 和 `outbound.db` 都有 `seq` 列。约定：

- **host 写偶数 seq**（2、4、6 …）到 `messages_in`，由 `nextEvenSeq()` (`src/db/session-db.ts:89`) 维护。
- **container 写奇数 seq**（1、3、5 …）到 `messages_out`，由 `container/agent-runner/src/db/messages-out.ts:54` 那段 `max % 2 === 0 ? max + 1 : max + 2` 逻辑维护。

两边写时都读 `MAX(seq)` 跨 **两张表** 的并集，保证 seq 是全局单调递增的。

为什么要奇偶分号段？因为 `seq` 是 **agent 面对的消息 ID**。当 agent 调 `edit_message(seq=5)` 或 `add_reaction(seq=6)`，`getMessageIdBySeq()` 看奇偶就知道：奇数 → `messages_out`，偶数 → `messages_in`，不需要 join 两张表。冲突就会破坏编辑功能。

#### 4.2 Heartbeat 是文件 touch

`.heartbeat` 文件的 mtime 是容器的 liveness 信号。`src/host-sweep.ts` 通过 `fs.statSync(heartbeatPath).mtimeMs` 判断容器多久没动静（参见 `ABSOLUTE_CEILING_MS = 30 * 60 * 1000`，`src/host-sweep.ts:65`）。

为什么不是 DB 写？因为 heartbeat 是 **每秒一次** 的事情。如果 heartbeat 是 DB 写，会和 messages_out 写排队等同一把锁。文件 mtime 不抢任何锁，是 nanoclaw 这种 cross-mount 环境下最便宜的 liveness 信号。

---

### 5. Host / Container 分工全景图

把上面的所有规则拼起来，一条消息从用户到 agent 再回到用户的完整路径是这样：

<svg viewBox="0 0 880 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="End-to-end message flow from platform through host to container and back">
  <defs>
    <marker id="ar-r12" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
    <marker id="ar-r12-orange" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/></marker>
    <marker id="ar-r12-teal" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#0d9488"/></marker>
  </defs>
  <rect x="20" y="50" width="120" height="60" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="80" y="76" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Platform</text>
  <text x="80" y="94" text-anchor="middle" font-size="10" fill="#64748b">Discord / Slack / CLI</text>
  <rect x="170" y="30" width="500" height="200" rx="8" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.5"/>
  <text x="420" y="50" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">HOST · Node + better-sqlite3</text>
  <rect x="185" y="62" width="100" height="42" rx="4" fill="#ffffff" stroke="#0d9488" stroke-width="1"/>
  <text x="235" y="80" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">adapter</text>
  <text x="235" y="95" text-anchor="middle" font-size="9" fill="#64748b">channels/*.ts</text>
  <rect x="305" y="62" width="100" height="42" rx="4" fill="#ffffff" stroke="#0d9488" stroke-width="1"/>
  <text x="355" y="80" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">router</text>
  <text x="355" y="95" text-anchor="middle" font-size="9" fill="#64748b">fan-out · wiring</text>
  <rect x="425" y="62" width="120" height="42" rx="4" fill="#ffffff" stroke="#0d9488" stroke-width="1"/>
  <text x="485" y="80" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">session-manager</text>
  <text x="485" y="95" text-anchor="middle" font-size="9" fill="#64748b">resolveSession</text>
  <rect x="565" y="62" width="90" height="42" rx="4" fill="#ffffff" stroke="#0d9488" stroke-width="1"/>
  <text x="610" y="80" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">wakeContainer</text>
  <text x="610" y="95" text-anchor="middle" font-size="9" fill="#64748b">docker run</text>
  <line x1="285" y1="83" x2="303" y2="83" stroke="#0d9488" stroke-width="1.2" marker-end="url(#ar-r12-teal)"/>
  <line x1="405" y1="83" x2="423" y2="83" stroke="#0d9488" stroke-width="1.2" marker-end="url(#ar-r12-teal)"/>
  <line x1="545" y1="83" x2="563" y2="83" stroke="#0d9488" stroke-width="1.2" marker-end="url(#ar-r12-teal)"/>
  <rect x="185" y="124" width="200" height="44" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="285" y="142" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">insertMessage → inbound.db</text>
  <text x="285" y="158" text-anchor="middle" font-size="9" fill="#64748b">messages_in (seq=even)</text>
  <rect x="405" y="124" width="170" height="44" rx="4" fill="#fef3e2" stroke="#ea580c" stroke-width="1.5"/>
  <text x="490" y="142" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">delivery poll · 1s/60s</text>
  <text x="490" y="158" text-anchor="middle" font-size="9" fill="#64748b">scan outbound.db</text>
  <rect x="185" y="180" width="455" height="40" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="412" y="204" text-anchor="middle" font-size="10" fill="currentColor">bind mount → /workspace/inbound.db (RO) · /workspace/outbound.db (RW)</text>
  <rect x="170" y="250" width="500" height="200" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/>
  <text x="420" y="270" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">CONTAINER · Bun + bun:sqlite</text>
  <rect x="185" y="282" width="110" height="40" rx="4" fill="#ffffff" stroke="#ea580c" stroke-width="1"/>
  <text x="240" y="299" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">poll-loop</text>
  <text x="240" y="313" text-anchor="middle" font-size="9" fill="#64748b">SELECT pending</text>
  <rect x="315" y="282" width="110" height="40" rx="4" fill="#ffffff" stroke="#ea580c" stroke-width="1"/>
  <text x="370" y="299" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">formatter</text>
  <text x="370" y="313" text-anchor="middle" font-size="9" fill="#64748b">&lt;messages&gt; XML</text>
  <rect x="445" y="282" width="130" height="40" rx="4" fill="#ffffff" stroke="#ea580c" stroke-width="1"/>
  <text x="510" y="299" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">claude provider</text>
  <text x="510" y="313" text-anchor="middle" font-size="9" fill="#64748b">claude-agent-sdk</text>
  <line x1="295" y1="302" x2="313" y2="302" stroke="#ea580c" stroke-width="1.2" marker-end="url(#ar-r12-orange)"/>
  <line x1="425" y1="302" x2="443" y2="302" stroke="#ea580c" stroke-width="1.2" marker-end="url(#ar-r12-orange)"/>
  <rect x="185" y="340" width="240" height="40" rx="4" fill="#ffffff" stroke="#ea580c" stroke-width="1"/>
  <text x="305" y="358" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">mcp-tools/core.ts</text>
  <text x="305" y="372" text-anchor="middle" font-size="9" fill="#64748b">send_message · send_file</text>
  <rect x="445" y="340" width="210" height="40" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="550" y="358" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">writeMessageOut → outbound.db</text>
  <text x="550" y="372" text-anchor="middle" font-size="9" fill="#64748b">messages_out (seq=odd)</text>
  <line x1="425" y1="360" x2="443" y2="360" stroke="#ea580c" stroke-width="1.2" marker-end="url(#ar-r12-orange)"/>
  <rect x="185" y="398" width="470" height="36" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="420" y="421" text-anchor="middle" font-size="10" fill="currentColor">touch /workspace/.heartbeat (liveness · no SQLite lock)</text>
  <line x1="140" y1="80" x2="183" y2="80" stroke="#0ea5e9" stroke-width="1.4" marker-end="url(#ar-r12)"/>
  <text x="161" y="72" text-anchor="middle" font-size="9" fill="#0ea5e9">inbound</text>
  <line x1="183" y1="100" x2="140" y2="100" stroke="#0ea5e9" stroke-width="1.4" marker-end="url(#ar-r12)"/>
  <text x="161" y="113" text-anchor="middle" font-size="9" fill="#0ea5e9">deliver</text>
  <rect x="700" y="50" width="160" height="60" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="780" y="76" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">No socket</text>
  <text x="780" y="94" text-anchor="middle" font-size="10" fill="#64748b">no IPC · no stdin pipe</text>
  <text x="780" y="140" text-anchor="middle" font-size="10" fill="#94a3b8">two SQLite files</text>
  <text x="780" y="155" text-anchor="middle" font-size="10" fill="#94a3b8">+ one mtime file</text>
  <text x="780" y="170" text-anchor="middle" font-size="10" fill="#94a3b8">= entire IO surface</text>
</svg>
<span class="figure-caption">图 R1.2 ｜ 入站 → 路由 → 写 inbound → wake → 容器轮询 → 写 outbound → host 投递的完整闭环</span>

<details>
<summary>ASCII 原版</summary>

```
                                        [HOST 进程 (Node + better-sqlite3)]
                                        +---------------------------------------------------+
                                        |                                                   |
   +-----------+   inbound event   +---------+    +----------+    +-----------------+        |
   |  Discord  | ----------------> | adapter | -> | router.ts | -> | session-manager |        |
   |  Slack    |  isMention=true   | (channel|    |  fan-out  |    | resolveSession  |        |
   |  CLI      |                   |  /cli.ts|    |  by wiring|    | create folder?  |        |
   |  ...      |                   +---------+    +----------+    +-----------------+        |
   +-----------+                                                            |                |
        ^                                                                   v                |
        |                                                +--------------------------+        |
        |                                                | insertMessage()          |        |
        |                                                | -> inbound.db            |        |
        |                                                |    messages_in (seq=2)   |        |
        |                                                +--------------------------+        |
        |                                                            |                       |
        |                                                            v                       |
        |                                                +--------------------------+        |
        |                                                | wakeContainer()          |        |
        |                                                | -> docker run            |        |
        |                                                +-----------+--------------+        |
        |                                                            |                       |
        +------------------------------------------------------------|-----------------------+
                       ^                                             |
                       |                                             |  bind mount:
                       |  outbound.db poll (1s/60s)                  |    /workspace/inbound.db (RO)
                       |  delivery.ts -> adapter.deliver()           |    /workspace/outbound.db (RW)
                       |                                             v
   +-----------+       |                                  [CONTAINER (Bun + bun:sqlite)]
   |   user    | <-----+                                  +---------------------------------+
   +-----------+                                          |                                 |
                                                          |  poll-loop.ts:                  |
                                                          |    SELECT pending FROM          |
                                                          |    messages_in                  |
                                                          |        |                        |
                                                          |        v                        |
                                                          |  formatter.ts                   |
                                                          |        |                        |
                                                          |        v                        |
                                                          |  claude provider                |
                                                          |  @anthropic-ai/                 |
                                                          |  claude-agent-sdk               |
                                                          |        |                        |
                                                          |        v  (mcp tool calls)      |
                                                          |  mcp-tools/core.ts             |
                                                          |  send_message / send_file / ... |
                                                          |        |                        |
                                                          |        v                        |
                                                          |  writeMessageOut() ->          |
                                                          |  outbound.db                    |
                                                          |    messages_out (seq=3)         |
                                                          |                                 |
                                                          |  touch /workspace/.heartbeat    |
                                                          +---------------------------------+
```

</details>

文字描述这条路：

1. **入站**：channel adapter（如 `src/channels/cli.ts`）从平台拿到 raw 事件，调用 host 注入的 `onInbound` 回调（`src/index.ts:92`）。
2. **路由**：`routeInbound()` (`src/router.ts:158`) 解析 messaging group → wired agent groups → 评估 `engage_mode` / `access_gate` / `sender_scope` / `command_gate` → fan-out 到每一个匹配的 agent。
3. **session 解析**：每个匹配的 agent，调 `resolveSession()` (`src/session-manager.ts:92`) 找到或创建 session。session_mode 决定是 shared / per-thread / agent-shared。
4. **写入 inbound.db**：`writeSessionMessage()` 打开 inbound.db、`INSERT INTO messages_in`（含 even seq）、close。
5. **唤醒容器**：`wakeContainer()` 启动 docker（或 apple container）。如果容器已在跑则跳过。
6. **容器轮询**：`runPollLoop()` (`container/agent-runner/src/poll-loop.ts`) 每秒 `SELECT * FROM messages_in WHERE status = 'pending' AND (process_after IS NULL OR process_after <= now)`。
7. **格式化与调用**：`formatter.ts` 把多条 messages_in 合并成一个 `<messages>` XML block，调 `provider.query()` 推给 Claude Agent SDK。
8. **agent 输出**：Claude SDK 调用 nanoclaw MCP server（在容器内由 `bun run /app/src/mcp-tools/index.ts` 跑起来），每个 MCP tool 都通过 `bun:sqlite` 直接写 `outbound.db`。
9. **host 轮询出站**：`startActiveDeliveryPoll()` (`src/delivery.ts`) 每 1 秒扫所有 running session 的 outbound.db；`startSweepDeliveryPoll()` 每 60 秒扫所有 active session（覆盖 idle 容器场景）。
10. **投递**：`deliver()` 把 messages_out 内容交给同一个 channel adapter 的 `adapter.deliver()`。投递成功后 host 把 `(message_out_id, platform_message_id)` 写到 inbound.db 的 `delivered` 表 — 容器后续做 edit/reaction 时通过这张表查到 platform message id。

整条链路 **没有任何** 跨进程 socket / pipe / IPC。host 和容器靠两个 SQLite 文件 + 一个 mtime 文件交换全部状态。

---

### 6. Skill-installed 渠道和 provider — trunk 里没有 Discord

打开 `src/channels/index.ts` 你会发现整个文件只有一行 `import './cli.js';`。打开 `src/providers/index.ts` 你会发现只有几行注释，没有任何 `import`。

这是有意的。NanoClaw trunk 只内置：

- **一个 channel**：`cli` — 通过 `data/cli.sock` Unix socket 和本地 `scripts/chat.ts` 客户端对话。永远开启，零凭证，便于开发和 bootstrap。
- **一个 provider**：`claude` — 包装 `@anthropic-ai/claude-agent-sdk`。

任何其他渠道（Discord / Slack / Telegram / WhatsApp / Teams / Linear / GitHub / iMessage / Webex / Resend / Matrix / Google Chat / WhatsApp Cloud）和任何其他 provider（OpenCode、未来的 Codex 等）都 **不在 trunk**，而是住在两个 sibling branches：

- **`channels` 分支** — 所有 channel adapter 模块。`/add-discord`、`/add-slack`、`/add-telegram` 等 skill 把它们拉进来。
- **`providers` 分支** — 非默认 provider。`/add-opencode` 把它们拉进来。

每个 `/add-<name>` skill 都是 **幂等** 的：

1. `git fetch origin <branch>`
2. 把模块文件 checkout 到 trunk 的标准路径（例如 `src/channels/discord.ts`）
3. 在 barrel 文件（如 `src/channels/index.ts`）追加一行 `import './discord.js';`
4. `pnpm install <pkg>@<pinned-version>` 把依赖加入 lockfile
5. 触发一次构建

为什么这么搞？为了 **避免合并冲突**。`docs/architecture.md:519-545` 的"Conflict Hotspots and Solutions"一节列举了 33 个 skill 分支的实际冲突分布 — `src/channels/index.ts`、`src/container-runner.ts`、`src/config.ts`、`src/db.ts` 等。把每个 adapter 拆成独立文件 + barrel 自注册，让"加 Discord"和"加 Slack"只各自动一个文件，永不冲突。

这给阅读代码带来一个直接的后果：**你在 trunk 里看到的所有 channel 接口（`src/channels/adapter.ts`、`src/channels/chat-sdk-bridge.ts`、`src/channels/channel-registry.ts`）都是 framework**，**真实 adapter 的实现在 sibling branch**。同理对 provider：`container/agent-runner/src/providers/claude.ts` 是唯一在 trunk 的 provider，OpenCode 装上后会出现 `container/agent-runner/src/providers/opencode.ts`。

---

### 7. 本 wiki 的阅读路径

剩下的章节按"由表及里、由静态到动态"组织：

| 章 | 主题 | 你能搞懂什么 |
|----|------|--------------|
| 2 | 代码布局与构建拓扑 | host 和 container 各自的源码树、Node vs Bun 双 runtime、lockfile 政策、CI、launchd |
| 3 | 三 DB 模型与 schema | 中央 DB 每张表、session DB 每张表、seq parity、cross-mount 不变量 |
| 4 | Host 引导与生命周期 | `main()`、迁移、circuit breaker、shutdown 路径、`response-registry` 解循环 |
| 5 | Channel adapter 框架 | `ChannelAdapter` 接口、`channel-registry`、Chat SDK bridge、cli channel 范例 |
| 6 | 路由与实体模型 | `routeInbound`、fan-out、engage_mode、access gate、sender scope、command gate |
| 7 | Session 解析与容器生命周期 | `resolveSession`、`wakeContainer`、mount 编排、idle 检测、kill 决策 |
| 8 | Agent-runner | poll loop、formatter、provider 抽象、MCP tools、destinations、heartbeat |
| 9 | 模块系统 | `src/modules/` 下的 typing/approvals/permissions/self-mod/scheduling/agent-to-agent/interactive/mount-security |
| 10 | OneCLI 凭证与 approval | 凭证 proxy、selective vs all 模式、两侧 approval 流、admin 卡片投递 |
| 11 | Self-modification 与容器重启 | `install_packages` / `add_mcp_server`、container_configs、on_wake 消息、`onExit` 回调 |
| 12 | ncl admin CLI | socket server、dispatch、scope 强制、resources/CRUD 注册器 |
| 13 | Skill 系统 | 四种 skill 类型、`/add-<channel>` 幂等流程、container skills mount |
| 14 | 运维与故障排查 | 日志、`logs/setup-steps/`、launchd/systemd、`migrate-v2.sh` |
| 15 | 术语表 | 全部专有名词 |

另外还有一个 **trace tour**，跟着一条最简的 CLI 消息（"hello"）走完从 `scripts/chat.ts` 写入 socket，到 agent 回 "hi"，再投回 socket 的全过程 — 跨 10-15 个文件、约 30 步。建议读完本章再走 tour，然后再回来读细节章节。

---

### 8. 必看文档索引

NanoClaw 自带详细文档在 `docs/`。本 wiki 是 **学习路径**，但权威细节在以下文件里。强烈建议交叉对照：

| 文件 | 内容 | 何时读 |
|------|------|--------|
| `CLAUDE.md` | 项目根的 README for Claude，包含 Quick Context、Key Files 表、所有 gotcha | 任何时候卡住，先读 CLAUDE.md |
| `docs/architecture.md` | 完整架构白皮书，含设计决策的"为什么" | 想理解某个机制存在的理由时 |
| `docs/db.md` | 三 DB 总览、cross-mount 不变量、读者/写者地图 | 改任何 DB 代码之前 |
| `docs/db-central.md` | 中央 DB 每张表的完整 schema + migration 编号 | 读 `src/db/` 时 |
| `docs/db-session.md` | session DB 两张表的 schema + seq parity + folder layout | 读 `src/db/session-db.ts` 或容器侧 DB 代码时 |
| `docs/agent-runner-details.md` | provider 接口、MCP tool 全集、message 格式化、媒体处理 | 读 `container/agent-runner/` 时 |
| `docs/isolation-model.md` | 三级 channel isolation 模型（agent-shared / shared / 独立 agents） | 配置 wiring 时 |
| `docs/build-and-runtime.md` | Node + pnpm host vs Bun container 的运行时分裂、lockfile、CI、关键不变量 | 改依赖或 Dockerfile 时 |
| `docs/api-details.md` | host API + DB schema 细节，inbound/outbound content 的所有 shape | 写新的 channel adapter 或 MCP tool 时 |
| `docs/migration-dev.md` | v1→v2 迁移开发指南 | 维护 `migrate-v2.sh` 时 |

---

### 9. 一句话总结

NanoClaw 把"多渠道多 agent 编排"压缩到一句不变量：

> **每个 session 有两个 SQLite 文件。inbound 是 host 写、container 读的入站消息表；outbound 是 container 写、host 读的出站消息表。两边正好各一个 writer。其它一切（编辑、reaction、调度、approval、agent-to-agent、self-mod）都是这两张表里的一行。**

记住这一点，剩下的所有代码都是这条规则的具体实现。
