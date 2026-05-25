## 这条 tour 跟的是什么

打开终端，在 nanoclaw 仓库根目录敲：

```bash
$ pnpm run chat "ping"
pong
$
```

看起来像最普通不过的一来一回。但回车按下之后，"ping" 这三个字节会穿过 **两个进程、两个 runtime（Node + Bun）、三个 SQLite 文件、一个 Unix socket、一个容器、一个 HTTP 流式连接到 Anthropic API**，最后才以 "pong" 的样子写回你的终端。

这条 tour 沿着这条最短链路一步步走，逐文件、逐函数、逐行号地把每一步拆给你看。

具体说，`pnpm run chat "ping"` 在 `package.json:23` 实际上就是 `tsx scripts/chat.ts "ping"`：

1. **客户端进程**（`scripts/chat.ts`）`net.connect` 到 `data/cli.sock`，写一行 `{"text":"ping"}\n`，挂个 silence timer 等响应。
2. **host 进程**（Node，启动入口是 `src/index.ts`）里 `src/channels/cli.ts` 的 server accept 到这条连接、按行解析、构造一个 `InboundEvent`，调用 setup 时注入的 `onInbound` callback。
3. callback 是 `src/index.ts:92` 写好的一段 `routeInbound` 的 thin wrapper —— **channel-registry 不参与路由调度**，它只是个 `Map<channelType, ChannelAdapter>`；事件从 adapter 主动 push 出来。
4. `src/router.ts:158` 的 `routeInbound` 按 `(channel_type='cli', platform_id='local')` 查 `messaging_groups` 表，决定有哪些 agent group 该被 fan-out。
5. 选出 agent → 跑权限 gate → `resolveSession()` 找到（或新建）这个 session 的 `inbound.db` / `outbound.db` 路径。
6. host 用偶数 `seq` `INSERT` 一行到 `inbound.db.messages_in`，然后 `wakeContainer()`。
7. **容器进程**（Bun，`container/agent-runner/`）启动，加载 `container.json`，注册 providers，组装系统 prompt。
8. 容器侧的 `poll-loop.ts` 每秒 `SELECT pending FROM messages_in`，捡到 "ping" 这一行，写 `processing_ack` 占用。
9. `formatter.ts` 把这条消息拼成 Claude Agent SDK 能吃的形状，`providers/claude.ts` 调 `@anthropic-ai/claude-agent-sdk` 的 `query()` 开始流式。
10. SDK 边吐字边触发 `push()` 往 `outbound.db` 写 partial 行；最终一条 `messages_out`（奇数 `seq`，`kind='chat'`，`content={"text":"pong"}`）落地。
11. host 侧 `src/delivery.ts` 的 `startActiveDeliveryPoll()` 每 1 秒扫一遍所有运行中 session 的 `outbound.db`，捡到 "pong"。
12. `delivery` 把这一行交给 `cli` adapter 的 `deliver()` —— 也就是 `src/channels/cli.ts:119`，写 `{"text":"pong"}\n` 回客户端 socket。
13. 客户端 `scripts/chat.ts` 收到，`stdout.write`，silence timer 2 秒到点，`process.exit(0)`。

为什么挑 CLI 这条最简单的：

- **CLI 是 trunk 唯一内置的 channel**（见第 11 章），不需要 Discord / Slack / Telegram 任何 token，不走 OAuth，单机就能跑通。
- 它经过了 **每一个核心层**：channel adapter、router、session manager、container runner、agent runner、provider、delivery —— 一层都不少。
- 客户端代码（`scripts/chat.ts`）只有 100 行，整个客户端逻辑可以一眼看完，不会喧宾夺主。

当本 wiki 后续加入其他 tour（比如"agent 主动发起 self-mod 重启"或者"approval 流程从 Discord 用户点击按钮"），它们会跟这条 tour 在某些步骤汇合 —— 比如所有 inbound 都要过 `routeInbound`，所有 outbound 都要写 `outbound.db`。所以这条 tour 是其他 tour 的 **底座**：读懂这一条，其他 tour 只需要看分叉点。

---

## 每一步的写法

从步骤 01 开始，每一步都用同一个 **8 段模板** 写。这个模板的目的，是让每个设计决策都看起来像是"被某个具体问题逼出来的逻辑结果"，而不是天降的结论。

| # | 段落 | 它负责什么 |
|---|------|-----------|
| 1 | 当前情境 | 锚定你在系统里的位置 —— 上一步结束时哪些数据结构已经成型 |
| 2 | 问题 | 这一步必须解决的具体需求，连带它的利害关系 |
| 3 | 朴素思路 | 凭直觉你会怎么写 —— 要让读者觉得"换我也这么写" |
| 4 | 为什么朴素思路会崩 | 具体的失败模式，不是"性能差"，而是"差在哪、错在哪" |
| 5 | nanoclaw 的做法 | 此时真实设计读起来像水到渠成的答案 |
| 6 | 代码位置 | 按阅读顺序列出 `file:line` 引用 |
| 7 | 分支与延伸 | 链回参考章节，把线性 trace 接进知识网络 |
| 8 | 走完这一步你脑子里应该多了什么 | 3-5 条以"新知识"措辞的收获 |

代码版本锁定在 `glifocat/nanoclaw@0683c6e`（v2.0.64，2026-05-18）。所有 `file:line` 都基于这个 commit。8 段模板详见 [reference/8-section-template.md] 或第 1 章的导读。

---

## 步骤列表

| 步骤 | 标题 | 一句话 |
|------|------|--------|
| [01](tour-single-cli-message-01-chat-script.md) | 客户端连上 CLI socket | `pnpm run chat "ping"` 连接 `data/cli.sock` 并写一行 JSON |
| [02](tour-single-cli-message-02-cli-adapter.md) | CLI adapter 收到字节 | server accept → 按行解析 → 构造 InboundEvent |
| [03](tour-single-cli-message-03-on-inbound.md) | onInbound 进入 channel-registry | adapter 把事件交给注册的 inbound 回调，进入 router |
| [04](tour-single-cli-message-04-resolve-mg.md) | router 解析 messaging_group | 按 `(channel_type='cli', platform_id='local')` 在 v2.db 查 messaging_groups |
| [05](tour-single-cli-message-05-resolve-ag.md) | router 解析 agent_group | 按 messaging_group_agents 的 priority + trigger_rules 选 agent group |
| [06](tour-single-cli-message-06-permission.md) | 权限检查 canAccessAgentGroup | 查 user_roles + agent_group_members，决定是否放行 |
| [07](tour-single-cli-message-07-resolve-session.md) | session-manager 解析/创建 session | 在 v2.db sessions 表里找或新建 session 行，算出 inbound/outbound.db 路径 |
| [08](tour-single-cli-message-08-insert-messages-in.md) | 写 messages_in 并发出 wake | 用 even seq INSERT 一行 messages_in；唤醒容器 |
| [09](tour-single-cli-message-09-spawn-container.md) | container-runner 拉起容器 | 无 running container 时 docker run 一个，挂载 session + agent group，OneCLI ensureAgent |
| [10](tour-single-cli-message-10-container-boot.md) | 容器内 agent-runner 启动 | bun 启动 index.ts → 加载 container.json → 注册 providers → 组装系统 prompt |
| [11](tour-single-cli-message-11-poll-loop.md) | poll-loop 拿到 messages_in | poll inbound.db；写 processing_ack 占用 |
| [12](tour-single-cli-message-12-formatter.md) | formatter 组装 prompt | 把 session 历史 + 新消息格式化成 SDK 入参 |
| [13](tour-single-cli-message-13-provider-query.md) | provider.query() 调用 Claude | claude.ts 调 `@anthropic-ai/claude-agent-sdk` 的 query()，开始流式 |
| [14](tour-single-cli-message-14-streaming-push.md) | 流式 push() 中途更新 | SDK 事件触发 push()，往 outbound.db 写 partial |
| [15](tour-single-cli-message-15-write-final.md) | 写入最终 messages_out | INSERT messages_out（odd seq，kind=chat，content="pong"），markCompleted |
| [16](tour-single-cli-message-16-delivery-poll.md) | host delivery 轮询发现新行 | 每 1s 扫 outbound.db，挑未投递行 |
| [17](tour-single-cli-message-17-adapter-deliver.md) | adapter.deliver 写回 CLI client | `cli.ts deliver()` 把 JSON 行写回客户端 socket |
| [18](tour-single-cli-message-18-client-print-exit.md) | 客户端打印并退出 | chat.ts 收 JSON、stdout 打印 "pong"、silence timer 触发退出 |

---

## 怎么用这份导览

- **顺着读**：从第 01 步走到第 18 步，你会对"消息怎么穿过整个系统"建立完整的肌肉记忆。
- **跳着读**：每一步第 6 段给了精确 `file:line`，第 7 段链回参考章节 —— 想深挖某个子系统就跳进对应章节。
- **对照源码读**：tour 锁定 commit `0683c6e`，所有行号可在 GitHub 上一键跳转验证。

下一步：[Trace 步骤 01 —— 客户端连上 CLI socket](tour-single-cli-message-01-chat-script.md)
