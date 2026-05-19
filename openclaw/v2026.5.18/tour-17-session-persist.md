# Tour 17：会话持久化

## 1. 当前情境

上一步（tour-16）结束时，用户的 WebChat 界面上已经显示出完整的一轮对话：

```
你          你好
助手        你好！很高兴见到你，有什么可以帮你的吗？
```

投递路径和广播路径都跑完了。从用户的视角，这件事已经结束了——他问了，助手答了，屏幕上都有。

但从 gateway 的视角，还差最后一件事。屏幕上的文字只是 WebSocket 帧的渲染结果，它存在于浏览器的内存里。如果用户现在刷新页面、或者明天再来说一句「刚才聊到哪了」，gateway 必须能续上这轮对话——它得知道「上一轮用户说了你好、助手回了那句话」。这份记忆不在浏览器里，必须落到 gateway 的磁盘上。

我们手上现在有的：一个完整的 `ReplyPayload`（已投递、已广播），一个在 tour-08 就解析出来的 `session`（带 `sessionKey`、`sessionId`、`sessionFile`、当前 model/provider），以及这一轮的 `MsgContext`（带消息来源元数据）。这一步要把这些收束成磁盘上的持久状态。

## 2. 问题

> 本轮的用户消息「你好」和助手回复，如何作为转录条目写回 session 存储？模型选择、token 计数这类元数据如何回写？并发写、半截写如何不破坏一致性？

## 3. 朴素思路

最直接的想法：用一个文件存整个会话。`session.json` 里放一个数组,每轮对话往数组里 push 两条消息（用户的、助手的），同时把当前 model、累计 token 数也放进同一个对象。每次对话结束，`JSON.stringify` 整个对象、`fs.writeFile` 覆盖写回。一个文件、一次写、所有状态都在里面，简单直接。

## 4. 为什么朴素思路会崩

「单文件、整体覆盖写」在 OpenClaw 这种长期运行、多进程、长会话的网关里，会以几种很具体的方式崩掉：

- **写放大灾难**。对话正文是只追加、会无限增长的——一个聊了三个月的会话，转录可能几十 MB。而元数据（当前 model、token 计数）很小、却需要频繁更新——光是一次 token 计数刷新就要重写整个几十 MB 的对话历史。每轮对话、甚至每次心跳都付这个代价，磁盘 IO 直接被拖垮。

- **半截写毁掉整个会话**。`fs.writeFile` 覆盖一个大文件不是原子的。如果进程在写到一半时崩溃、或者断电，磁盘上留下的是一个被截断的、JSON 解析不了的文件。下次启动 `JSON.parse` 直接抛异常——不是丢一轮对话，是**整个会话历史全毁**。

- **并发写互相覆盖**。OpenClaw 是个网关，gateway 进程、CLI、daemon 可能同时活着。两个写操作同时「读出整个会话 → 各自改一点 → 写回」，后写的那个会把先写的改动整个盖掉。用户的「你好」和某个后台心跳更新的 token 计数,会互相吞掉对方。

- **元数据和正文的访问模式被强行捏在一起**。元数据小、频繁随机读写、需要被整体加载来做维护（裁剪过期会话、封顶条目数）；正文大、只追加、极少整读。塞进一个文件，意味着任何一种访问模式都被另一种拖累——想读个「当前用哪个 model」也要把几十 MB 对话拉进内存。

核心矛盾：**元数据和对话正文是两类访问模式截然相反的数据，混在一个文件里、用非原子的整体覆盖写、还没有并发保护——每一个维度都会出事。**

## 5. OpenClaw 的做法

**先把问题钉死**：需要一种持久化方案，让小而频繁更新的元数据和大而只追加的正文各得其所，让写操作原子（半截写不破坏文件），让并发写串行化（不互相覆盖）。

OpenClaw 的回答是**两层物理存储 + 原子写 + 写串行化**。

**第一，元数据与正文分层。** 这是理解整个会话系统的总纲：

- **会话存储**：一个 JSON 文件 `<stateDir>/agents/<agentId>/sessions/sessions.json`，内容是 `{ sessionKey -> SessionEntry }` 的字典。它是「目录」/「路由表」——装的是模型选择、token 计数、路由信息、压缩标记、生命周期戳这类**轻量元数据**。
- **会话转录**：每个会话一个 JSONL 文件 `<sessionId>.jsonl`，逐行 JSON——第一行是 session 头，之后每行一个 message 条目。它是「正文」——完整的对话消息历史，**只追加**。

两层用 `SessionEntry.sessionId` 串联。访问模式决定存储形态：频繁更新一个 token 计数,只动小小的 `sessions.json`,不碰几十 MB 的 `.jsonl`;往对话历史里加一条消息,只对 `.jsonl` 做一次 `fs.appendFile`,不重写任何东西。这正是朴素思路「写放大」问题的答案。

> 关于格式：`v2026.5.18` 的会话存储是 **JSON**（`src/config/sessions/store.ts:374` 的 `JSON.stringify(store, null, 2)`），转录是 **JSONL**（`src/config/sessions/transcript-append.ts:310` 的 `fs.appendFile(..., JSON.stringify(entry))`）。代码库不用 YAML 持久化会话。

**第二，本轮对话作为转录条目写回。** 用户消息和助手回复各是一条 message 条目，由 `appendSessionTranscriptMessage`（`src/config/sessions/transcript-append.ts:254`）追加。条目的形状（`src/config/sessions/transcript-append.ts:306`）是一个内联结构：

```
{ type: "message", id: <randomUUID>, parentId: <上一条的 id>, timestamp, message }
```

`message` 字段装的才是对话载荷——`role`（`user` / `assistant`）、`content`，助手消息上还带运行元数据：`provider`、`model`、`usage`（input/output/cacheRead/cacheWrite/totalTokens/cost）、`stopReason`。

> 纠正一个误解：代码库里**没有** `SessionMessageEntry` / `SessionAgentRunEntry` 这样的具名类型。转录条目就是上面那个 `{type, id, parentId, timestamp, message}` 内联结构，`message` 是来自 `@earendil-works/pi-agent-core` 的 `AgentMessage`。

`parentId` 让转录从「线性日志」升级成「树」——每条新条目的 `parentId` 指向当前叶子（`src/config/sessions/transcript-append.ts:306`），支持会话 fork、压缩分支。对「你好」这条 trace，转录里只是平凡地多了两个条目，`parentId` 串成一条直线。

注意 WebChat 这条内建渠道路径有一处专门处理：助手回复经 `routeReplyToOriginating` 投递成功后，`mirrorInternalSourceReplyToTranscript`（`src/auto-reply/reply/dispatch-from-config.ts:393`）调 `appendAssistantMessageToSessionTranscript`（`src/config/sessions/transcript.ts:205`）把回复镜像进转录,`updateMode: "inline"` 让它同时更新会话存储里的镜像与计数。

**第三，元数据回写。** 入站侧，`recordSessionMetaFromInbound`（`src/config/sessions/store.ts:577`）把 `MsgContext` 里的来源/路由信息（provider、surface、`lastChannel`、`lastTo`）回写进 `SessionEntry`。运行侧，模型选择、token 计数、`updatedAt` 戳随这一轮的执行结果回写。`SessionEntry` 几乎从不被整体替换，而是被**补丁合并**——`mergeSessionEntryWithPolicy`（`src/config/sessions/types.ts:224`）打补丁，内建「补丁了 model 没补丁 provider 就清掉陈旧 provider」之类的防护。

**第四，原子写 + 写串行化保证一致。** 这是朴素思路「半截写」「并发覆盖」两个问题的答案：

- **原子写**：`saveSessionStoreUnlocked`（`src/config/sessions/store.ts:228`）序列化后，`writeSessionStoreAtomic` 调 `writeTextAtomic`——**写临时文件,再 `rename`**。`rename` 在 POSIX 上是原子的：读者要么看到旧的完整文件，要么看到新的完整文件，永远不会看到写一半的状态。文件 `mode: 0o600`——会话数据含敏感信息,只对属主可读写。写盘前还做内容去重:序列化结果和上次字节一致就直接跳过写盘。
- **写串行化**：`sessions.json` 是单文件,`runExclusiveSessionStoreWrite`（`src/config/sessions/store-writer.ts:72`）按 `storePath` 维护一个**串行队列**,所有写路径都排进去,read-modify-write 整体在队列任务内执行,不会有别的写穿插。
- **转录的并发保护更精细**：转录可能被多个 OpenClaw 进程同时追加,所以除了进程内队列(`withTranscriptAppendQueue`),还加了一个 **OS 级文件写锁** `acquireSessionWriteLock`(`src/config/sessions/transcript-append.ts:262`)。会话存储用进程内队列够用,转录用文件锁——因为跨进程并发。

走完这一步,本轮的「你好」和助手回复已经作为两个 message 条目落进 `<sessionId>.jsonl`,`SessionEntry` 里的 model、token 计数、`updatedAt` 也更新了,全都通过原子 `rename` 安全落盘。

## 6. 代码位置

- `src/config/sessions/types.ts:174` — `SessionEntry`,一个会话桶的全部元数据(身份、路由、model、token、压缩标记)。
- `src/config/sessions/types.ts:196` — `sessionId`,连接会话存储与 `.jsonl` 转录的纽带。
- `src/config/sessions/types.ts:224` — `mergeSessionEntryWithPolicy`,`SessionEntry` 的补丁合并(含陈旧 provider 防护)。
- `src/config/sessions/store.ts:577` — `recordSessionMetaFromInbound`,把 `MsgContext` 来源元数据回写进 `SessionEntry`。
- `src/config/sessions/store.ts:228` — `saveSessionStoreUnlocked`,写盘前跑会话维护、再序列化。
- `src/config/sessions/store.ts:374` — `JSON.stringify(store, null, 2)`,会话存储是 JSON。
- `src/config/sessions/store-writer.ts:72` — `runExclusiveSessionStoreWrite`,按 `storePath` 的写串行队列。
- `src/config/sessions/transcript-append.ts:254` — `appendSessionTranscriptMessage`,转录条目追加入口。
- `src/config/sessions/transcript-append.ts:262` — `acquireSessionWriteLock`,转录的跨进程文件写锁。
- `src/config/sessions/transcript-append.ts:306` — 转录条目的内联结构 `{type, id, parentId, timestamp, message}`。
- `src/config/sessions/transcript-append.ts:310` — `fs.appendFile(..., JSON.stringify(entry))`,转录是 JSONL,只追加。
- `src/config/sessions/transcript.ts:205` — `appendAssistantMessageToSessionTranscript`,助手消息追加(含 `usage` 子对象)。
- `src/auto-reply/reply/dispatch-from-config.ts:393` — `mirrorInternalSourceReplyToTranscript`,WebChat 内建渠道回复镜像进转录。

## 7. 分支与延伸

我们这条 trace 走的是「短会话、转录线性追加两条、原子写一次落盘」。这一步上的岔路:

- **上下文压缩**:会话太长、转录 token 超模型上限时,压缩(compaction)把一段历史浓缩成摘要,产生 `SessionCompactionCheckpoint`,带 pre/post 转录引用让压缩可追溯、可回滚。
- **会话 reset**:`/reset` 或每日定点 reset 换一个新 `sessionId`、开新转录文件,旧转录被**归档**(加时间戳后缀)而非删除。
- **会话维护**:`sessions.json` 加载/保存时跑维护——删超 30 天没更新的条目、条目数超 500 时删最旧的——但当前活跃会话永不被清。
- **幂等追加**:`idempotencyKey` 让投递重试不在转录里产生重复条目。
- **多 agent 合并视图**:配了多个 agent 时,`combined-store-gateway.ts` 把多个 `sessions.json` 合并成只读聚合视图。
- **线性转录迁移**:旧的线性转录在追加时会就地迁移成 `parentId` 链接的树(超大文件例外,直接 raw 追加)。

想系统理解会话系统——两层存储、`SessionEntry` 的 150 个字段、并发安全的两级设计、压缩与归档——去读 [第 6 章](06-sessions.md)。

## 8. 走完这一步你脑子里应该多了什么

- 会话状态是**两层物理存储**:轻量元数据进 `sessions.json`(JSON 字典),大而只追加的对话正文每会话一个 `.jsonl`(JSONL),两层用 `sessionId` 串联——**访问模式决定存储形态**,这是为了避免「更新一个 token 计数就重写整个对话历史」的写放大。
- 本轮的用户消息和助手回复各作为一条转录条目追加,条目是内联结构 `{type, id, parentId, timestamp, message}`——代码库里**没有 `SessionMessageEntry` / `SessionAgentRunEntry` 这样的具名类型**,`message` 是 `AgentMessage`。
- 转录用 `parentId` 从「线性日志」升级成「树」,支持 fork 和压缩分支;一致性靠**原子写**(写临时文件再 `rename`,半截写不破坏文件)。
- 并发安全分两级:会话存储用**进程内串行写队列**(`runExclusiveSessionStoreWrite`),转录用 **OS 级文件锁**(`acquireSessionWriteLock`)——因为转录可能被多个 OpenClaw 进程并发追加。
- `SessionEntry` 几乎从不整体替换,而是 `mergeSessionEntryWithPolicy` **补丁合并**,内建陈旧 provider 防护等易错点防护。
- **这是 trace 的终点**。从 tour-01 用户敲下 `openclaw gateway`,到 tour-03 WebSocket 握手,到 tour-07 入站分发,到 tour-13 调 Anthropic,到 tour-15 组装 `ReplyPayload`,到 tour-16 投递回 WebChat——再到这一步把对话落盘,一轮「你好 → 回复」彻底完成。gateway 回到 tour-00 描述的那个状态:监听器就绪、注册表在册、连接长驻,静静等待下一条消息。整张「请求在系统里流动」的地图,你已经走完了一遍。
