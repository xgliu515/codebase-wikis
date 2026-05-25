## 1. 当前情境

`drainSession` 在 `src/delivery.ts:190` 的 for 循环里走到了我们这一行 outbound 消息。具体绑定如下：

- `msg = { id: 'uuid-...', kind: 'chat', platform_id: 'local', channel_type: 'cli', thread_id: null, content: '{"text":"pong"}', in_reply_to: '<step 8 写入的 messages_in.id>' }`
- `session` 是从 v2.db.sessions 里拉出来的整行，含 `agent_group_id`、`messaging_group_id`（指向 `(cli, local)`）等。
- `inDb` 已开（读写、`inbound.db`），`outDb` 已开（只读、`outbound.db`），都在 `drainSession` 的 try-finally 里。
- `deliveryAdapter` 全局变量（`src/delivery.ts:64`）此时早已被 `src/index.ts` 启动时 `setDeliveryAdapter()` 设过，它的具体 instance 是 `MultiChannelDeliveryAdapter`（第 9 章 §"Adapter.deliver" 会拆），内部按 `channel_type` 路由到具体 adapter 实例 —— 对 `cli` 而言就是 step 02 里 `registerChannelAdapter('cli', { factory: createAdapter })` 注册的那一份 `ChannelAdapter`，setup 阶段已经把 `client: net.Socket | null` 闭包变量绑定到了我们这次 `pnpm run chat "ping"` 进程的 socket（参见 step 02 的 `claimChatSlot()`）。
- 进入这一步时，`deliverMessage` 已经做完三件检查：(a) `kind !== 'system'`、(b) `channel_type !== 'agent'`、(c) **权限检查**（`src/delivery.ts:289-311`）—— `getMessagingGroupByPlatform('cli', 'local')` 返回的 mg.id 跟 `session.messaging_group_id` 相等，命中 `isOriginChat` 分支，所以跳过 `agent_destinations` 查询，无条件放行。
- `content.files` 为空数组（pong 没附件），所以 `files` 变量是 `undefined`，不会触发 `readOutboxFiles`。

下一行代码 `src/delivery.ts:356` 就是：

```ts
const platformMsgId = await deliveryAdapter.deliver(
  msg.channel_type, msg.platform_id, msg.thread_id, msg.kind, msg.content, files,
);
```

我们要拆的，就是这一调用进入 `src/channels/cli.ts:119` 之后到底发生了什么。

## 2. 这一步要解决什么

把一条已经在 `outbound.db` 里、`kind='chat'`、`content='{"text":"pong"}'` 的消息，**写到对应 CLI client 的 socket buffer 里**，使其能被客户端进程的 `socket.on('data', ...)` 读到。同时还要正确处理：

1. **client 可能已经断开**。`pnpm run chat` 进程可能在 agent 还在思考时被 Ctrl-C 了；client socket 早就 close 掉了。这种情况 deliver 该怎么办？
2. **platform_id 路由**。CLI adapter 只服务一个 platform_id `'local'`（`src/channels/cli.ts:45`）。万一传进来的 `platform_id` 不是 `local`，要怎么响应？
3. **wire format 一致性**。客户端 step 18 会按 `\n` 切 line 然后 `JSON.parse`，server 端写出的字节流必须严格满足"每条 message 一行 JSON、`\n` 结尾"，多一个少一个都会让客户端 buffer 错位。
4. **回报 `platform_message_id`**。delivery 拿到返回值后要写 `inbound.db.delivered`，行格式是 `(message_out_id, platform_message_id, status, delivered_at)`。Discord / Slack 这类 channel 的 `platform_message_id` 就是 Discord 的 message ID（用于后续 edit / react），CLI 没有这个概念，要回 `undefined`，delivery 写 NULL。

## 3. 朴素思路：client 断开就丢消息（throw）

"既然客户端不在了，这条 reply 投递不出去，就当 delivery 失败 —— `throw new Error('client disconnected')`，让 `drainSession` 走 retry 路径，三次后 `markDeliveryFailed`。"

这思路自洽得很：HTTP 投递、邮件投递、Discord webhook 投递都是这么干的 —— 对端不可达就 retry，retry 用尽就标记 failed。统一行为、统一处理路径，没什么特殊 case。

更激进一点你可能会说：CLI 干脆把 `client` 维护成一个**队列**——客户端不在的时候 enqueue 等下次连上 flush。这样 reply 既不丢也不失败。

## 4. 朴素思路在哪一档崩

第一种（throw）和第二种（队列）都崩，但崩的方式不同：

**throw 路径的问题**：

- "client 断开" 在 CLI 是**常态**，不是异常。`pnpm run chat "ping"` 的设计就是"问一句、等 silence、退出"。client 在 reply 落地之前断开不是 bug，是预期生命周期的尾段。
- 把常态当异常会让 `delivered` 表里大量出现 `status='failed'` 行，污染 retry 计数器（`deliveryAttempts` Map），让真正失败的 Discord / Slack 投递的可见度变差。
- 更糟的是，throw 会触发 retry。retry 三次都会失败（client 不会突然回来），消息被 mark failed 之后**用户再开一次 `pnpm run chat`** 也再也看不到这条 reply 了。
- 退一步说，"reply 在 client 重连时该不该补发"是个产品决策，不该被 retry 机制隐式决定。

**队列路径的问题**：

- 这个队列要持久化吗？如果不持久化，host 重启就丢了；如果持久化，你刚刚在 `outbound.db` 之上**又造了一个队列** —— 但 `outbound.db` 本身就是消息队列。
- 队列的去重在哪里做？同一条 outbound 行进入队列两次，怎么避免？答案是把队列状态也维护在 DB 里，于是你需要在 outbound.db 之外再开一个 cli-specific 的 state DB。
- 重连之后 flush 多少？最近一条？最近 10 条？最近 24 小时？这又是产品决策。

**真正的洞察**：reply 已经写在 `outbound.db` 里了。**"已经持久化"和"已经送到用户眼前"是两件事**，CLI adapter 只该负责后者。如果用户暂时看不到，那是产品体验问题，不是数据丢失问题。把 deliver 写成 **silent no-op** 后，从 host 的角度看这条消息**已经 delivered**（因为我们做了 `markDelivered`），但从 user 体验角度它没出现 —— 这是有意识的设计取舍，不是 bug。

## 5. nanoclaw 的做法：no-op + 短路 + 不抛

`src/channels/cli.ts:119-135` 的 `deliver()` 函数体就 17 行：

```ts
async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
  if (platformId !== PLATFORM_ID) return undefined;       // ① 不是 'local'：短路
  if (!client) {                                          // ② 没活客户端：silent no-op
    return undefined;
  }
  const text = extractText(message);                      // ③ 从 content 抽 text
  if (text === null) return undefined;                    // ④ 非 text payload：短路
  try {
    client.write(JSON.stringify({ text }) + '\n');        // ⑤ 写 socket buffer
  } catch (err) {
    log.warn('Failed to write to CLI client', { err });   // ⑥ 写失败 warn 不 throw
  }
  return undefined;                                       // ⑦ 永远不返回 platform_message_id
}
```

逐条说为什么这样：

**① `platformId !== PLATFORM_ID` 短路**。CLI 只服务 `platform_id='local'`。理论上 `messaging_groups` 表对 `channel_type='cli'` 的行也只会写 `local`，但 defensive check 没坏处 —— 比如未来某次 schema 演进或 manual SQL 修改塞了别的值，这里默默返回比 throw 强（throw 进 retry，retry 也修不好 —— 不如不动）。

**② `!client` silent no-op**。这是上一节讨论的核心。`client` 是 module-level 闭包变量（`src/channels/cli.ts:53`），由 `handleConnection` 的 `claimChatSlot()` 赋值、由 `socket.on('close')` 置 null。`pnpm run chat` 进程退出 → socket close → client = null → 下一次 deliver 命中这条短路。注释里写得很明确：

> 'No live terminal — outbound row is already persisted, so this isn't a data loss. User will see it on the next connect cycle (or never, if we don't add scroll-back). Not worth throwing.'  
> —— `src/channels/cli.ts:121-126`

**③ `extractText`** （`src/channels/cli.ts:267-274`）是 wire-format 适配。content 可能是纯 string，也可能是 `{ text: ... }` 对象，还可能是富格式（如 ask_question card）。CLI 只能转发 plain text，富格式被 silent drop。这是 CLI adapter 故意能力受限——TUI / web UI 是别的 channel 的事。

**④ `text === null`** 是 ask_question 卡片之类非 text payload 的情况。同样 silent —— 既不告警也不 retry。理由：CLI 客户端没办法渲染 card，能告诉用户什么？告诉了又如何？真要 CLI 支持 card，得改 client 的渲染逻辑，那是 step 18 client 端的事，不是 adapter 的事。

**⑤ `client.write(JSON.stringify({ text }) + '\n')`** 是 wire format 的真身。注意：
- JSON.stringify 一次（content 原本就是字符串化的 JSON，这里**重新构造** `{ text }`，所以不会双重转义）。
- `\n` 必须有，client 按 `\n` 切。
- 不 await。Node `net.Socket.write` 是 sync 返回 boolean（buffer 是否满），失败由 `'error'` 事件单独 emit。

**⑥ try-catch 包 write**。`net.Socket.write` 在极端情况（socket 已 close 但 close 事件尚未在 event loop 上 fire、对端 RST 已到但 fd 还活）会同步 throw `ERR_STREAM_DESTROYED`。catch 后 `log.warn` —— 又一次"不 throw 给 delivery"的设计选择，理由跟 ② 完全一致：消息没丢、只是没送达活客户端。

**⑦ `return undefined`** 而不是返回 row id。CLI 没有"平台原生 message id"概念 —— socket 写出去的字节没有 id。delivery 拿到 `undefined`，在 `src/delivery.ts:193` 转成 `null` 写进 `delivered.platform_message_id`：

```ts
markDelivered(inDb, msg.id, platformMsgId ?? null);
```

`markDelivered` 的 SQL（`src/db/session-db.ts:280-284`）：

```sql
INSERT OR IGNORE INTO delivered (message_out_id, platform_message_id, status, delivered_at)
VALUES (?, ?, 'delivered', datetime('now'))
```

`INSERT OR IGNORE` 是另一道防双投递护栏 —— 即便上面 `inflightDeliveries` 锁失效，DB unique constraint 也兜底保证一行 outbound 只对应一行 delivered。

**与 Discord adapter 的对比**（第 11 章会展开）：Discord adapter 的 `deliver()` 调 `discord.js` 的 `channel.send(...)`，网络失败必须 throw —— 因为消息**真的没送到 Discord 服务器**，retry 是正确动作。CLI 跟 Discord 的差别不在"网络协议"，而在 **"消息已落库"和"消息已送达对端"是否是一回事**。Discord 的 outbound.db 行只是"打算发"，没发到 Discord 就是没发；CLI 的 outbound.db 行就是"已发"，socket 那一头看没看到是 client 的事。

回到 delivery 的视角，`deliverMessage` 返回后 `drainSession`（`src/delivery.ts:190-204`）继续：

```ts
const platformMsgId = await deliverMessage(msg, session, inDb);  // undefined
markDelivered(inDb, msg.id, platformMsgId ?? null);              // 写 delivered 表
deliveryAttempts.delete(msg.id);                                  // 清 retry 计数
if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
  pauseTypingRefreshAfterDelivery(session.id);                    // 通知 typing module 暂停
}
```

`pauseTypingRefreshAfterDelivery` 是另一个 module 钩子（第 8 章 §"typing indicator"），让客户端能在 visual 上看到"对方停止打字"。CLI 没有 typing indicator，hook 实际 no-op，但代码层面统一调用——这种"channel-agnostic 调用 + 单 channel no-op"是 nanoclaw 大量模块的标准模式。

最后 `src/delivery.ts:372` 调 `clearOutbox(session.agent_group_id, session.id, msg.id)`——删 attachment 临时文件。我们这条没附件，no-op。

## 6. 代码位置（按读这一步源码的顺序）

| 顺序 | 文件:行 | 是什么 |
|------|---------|--------|
| 1 | `src/delivery.ts:356-363` | `deliveryAdapter.deliver(...)` 调用点（call site） |
| 2 | `src/channels/cli.ts:119-135` | `cliAdapter.deliver`：本步主体 |
| 3 | `src/channels/cli.ts:267-274` | `extractText`：从 `content` 中抽 plain text 的小工具 |
| 4 | `src/channels/cli.ts:45-49` | `PLATFORM_ID = 'local'` 和 `socketPath()` —— 让 ① 短路有依据 |
| 5 | `src/channels/cli.ts:138-179` | `handleConnection` / `claimChatSlot`：解释 `client` 闭包变量是怎么被赋值 / 置 null 的（step 02 已细讲，这里只需要回忆） |
| 6 | `src/delivery.ts:190-204` | 拿到 `platformMsgId` 之后的 `markDelivered` + `deliveryAttempts.delete` + typing pause |
| 7 | `src/db/session-db.ts:280-284` | `markDelivered`：`INSERT OR IGNORE` 防双投递 |
| 8 | `src/delivery.ts:372` | `clearOutbox`：清 attachment 临时文件 |

## 7. 分支与延伸

- 想看 CLI adapter 全貌（setup、teardown、handleConnection、routed `to`-bearing 消息、admin transport semantic）：跳第 11 章 [In-tree CLI adapter](11-channels-adapters.md#in-tree-cli-adapter)。
- 想看 `Adapter.deliver` 的统一接口签名、`MultiChannelDeliveryAdapter` 怎么按 `channel_type` 分发到具体 adapter：跳第 9 章 [Adapter.deliver](09-outbound-delivery.md#adapterdeliver)。
- 想看 `delivered` 表完整 schema（`status` 列的 `delivered` / `failed` 两种值、`migrateDeliveredTable` 为什么自适应 schema 演进）：跳第 9 章 [`delivered` 表](09-outbound-delivery.md#delivered-表)。

## 8. 走完这一步你脑子里应该多了什么

1. **CLI deliver 是 silent no-op when client disconnected**。这不是 robustness bug，是对"client 断开是常态"的有意识响应——消息已经在 outbound.db 里，没丢，只是这次没送到活终端。
2. **silent no-op 跟 Discord adapter 的 retry-on-failure 是不同设计哲学**，背后区别是"outbound.db 行 = 已发"还是"outbound.db 行 = 打算发"。CLI 是前者，Discord 是后者。
3. **CLI 没有 platform_message_id**，deliver 返回 `undefined`，delivery 写 `null` 进 `delivered.platform_message_id`。Discord 会把消息原生 id 写进去用于后续 edit / react。
4. **wire format 是 "一行 JSON + `\n`"**，server 用 `JSON.stringify({ text }) + '\n'` 写，client 用 `\n` 切。多一字节少一字节都会让对端 buffer 错位。
5. **deliver 完成后立刻 `markDelivered` + `INSERT OR IGNORE`** 是双重幂等保险——上层 `inflightDeliveries` Set 是第一道、DB unique constraint 是第二道。两道都失效才会真的双投递。
