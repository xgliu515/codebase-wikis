## 1. 当前情境

第 11 步的尾声：poll loop 已经把那行 'ping' 的 id 写进 outbound.db 的 `processing_ack` (status='processing')，从 `normalMessages` 数组里得到了一份 trigger=1 的待处理批次（本 trace 只有一条），并完成了 pre-task script gate（no-op）。具体变量状态：

- `messages: MessageInRow[]` —— `[{ id: 'msg-...', seq: <某偶数>, kind: 'chat', content: '{"text":"ping","sender":"…","author":{…}}', timestamp: '...', platform_id: 'local', channel_type: 'cli', thread_id: null, trigger: 1, on_wake: 0, ... }]`
- `normalMessages` = `messages`（没有 /clear）
- `keep` = `normalMessages`（pre-task gate 没刷掉任何行）
- `routing` = `{ platformId: 'local', channelType: 'cli', threadId: null, inReplyTo: 'msg-...' }`
- `continuation: string | undefined` —— 本 trace 是首次对话，`undefined`
- `config.provider.supportsNativeSlashCommands === true`（Claude 实现里写死 true，[`providers/claude.ts:254`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/providers/claude.ts#L254)）
- outbound.db 里有 `processing_ack` 行；没有 `messages_out` 行（这是首条回复）

下一拍 poll loop 调 [`formatMessagesWithCommands(keep, true)`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L166)，它会进 `formatter.ts`。

## 2. 这一步要解决的问题

把零散的 inbound 行**翻译成 SDK 能直接消费的 prompt 字符串**。具体子问题：

1. **shape 怎么对**：Claude Agent SDK 的 `query({ prompt: string | AsyncIterable<...> })` 接受文本 prompt——多条消息要序列化成单一字符串。
2. **历史怎么带**：用户发了 'ping'，agent 需要知道之前的对话上下文吗？Continuation 机制让 SDK 自己 resume transcript（[`providers/claude.ts:291`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/providers/claude.ts#L291) 的 `resume: input.continuation`），但**首次对话没有 continuation**——只能靠这次 prompt 提供完整上下文。本 trace 这一条恰好就是首条，所以历史是空。
3. **结构化标记**：消息不只是 text，还有 `sender`、`time`、`reply_to`、`attachments`、`from=<destination>`（agent 知道是谁发的、什么时候、回复哪条）。光塞文本会丢这些结构。
4. **时区**：agent 给出的"明天 9 点开会"必须用用户本地时区解释——SDK 不知道用户在哪个时区。
5. **混合 kind**：一个 batch 里可能同时有 `chat` / `task` / `webhook` / `system`，不同 kind 的渲染规则不一样（task 要带 script output、webhook 要带 payload）。
6. **路由字段隔离**：`platform_id` / `channel_type` / `thread_id` 是 host-side 路由信息，agent 不应该看见（看见也没法用、还会污染上下文 token budget）。
7. **slash command 分流**：`/cost`、`/compact`、`/context` 这些 Claude Code 原生命令必须以 **raw text** 而不是 XML 包裹送进 SDK——SDK 只在 prompt 第一个 input 是裸命令时才 dispatch。
8. **destinations 反查**：从 inbound 的 `(channel_type, platform_id)` 反向找出"这条是从哪个 destination 进来的"，渲染成 `from="kira-cli"` 让 agent 知道默认回哪。
9. **XML 注入防御**：消息 text 里可能有 `<` / `>` / `&`——必须 escape，否则 SDK / agent parser 会爆。

第 (2)/(3) 是核心；其余都是"细节地雷"。

## 3. 朴素思路

"反正都要给 SDK 看，那就把所有历史 messages_in + messages_out 顺序展开，每条加个 `User:` / `Assistant:` 前缀，串成一个大字符串"：

```ts
function buildPrompt(history: AllMessages[], newMsg: MessageIn): string {
  const lines = [];
  for (const m of history) {
    lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`);
  }
  lines.push(`User: ${newMsg.content.text}`);
  return lines.join('\n\n');
}
```

每次 turn 重新拼。Stateless、好 debug、不需要管 continuation——agent 看到的就是所有历史明文。

## 4. 为什么朴素思路会崩

**(a) Token 限制**。Claude opus-4.7 默认 ~200k context，一个 session 跑两周后 messages_in + messages_out 行数轻松上千、单消息平均几百 token、再加 attachment——一次 prompt 直接超 window。Claude Code 的 auto-compact ([`providers/claude.ts:244`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/providers/claude.ts#L244)) 设在 165k，超过会自动压缩，但前提是 SDK 自己能 incrementally 看到对话——朴素思路每次重新构造 prompt，等于丢掉 SDK 的所有 incremental 状态，每次 cache miss、每次都跑 compact。

**(b) Prompt cache miss 浪费钱**。Anthropic prompt cache 5min TTL，key 是 prefix hash。每次重排历史 → prefix 变 → cache 失效。一个 session 一天对话几十轮，每次重发整段历史，TTL 内大量重复内容反复计费。

**(c) Attachment 重复嵌入**。如果朴素思路把附件每次都内联进 prompt（base64 图片、长文档原文），一次 turn 几 MB token——直接破产。

**(d) 丢结构信息**。`User: ping` 字符串里没有 sender 名字（多人聊天）、没有 time（agent 不知道是 5 秒前还是 5 小时前）、没有 reply context（"回复某条"看不出来）、没有 destination 标记（agent 不知道默认回哪个 channel）。

**(e) 多 destination 场景没法寻址**。NanoClaw 的 agent 可能挂 Discord + Telegram + CLI 三个 destination；agent 怎么决定回哪个？朴素思路丢了 from 信息，agent 只能猜或者全发。

NanoClaw 选择**结构化喂 + 增量委托给 SDK** 的双策略：当前 turn 的消息批走 formatter 拼成结构化 XML 字符串，**历史让 SDK 通过 continuation resume**——SDK 自己读它落地的 `.jsonl` transcript，cache 命中、增量更新、auto-compact 由 SDK 维护。

## 5. NanoClaw 的做法

[`formatMessagesWithCommands(keep, true)`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L228) 是 entry，干两件事：分流 slash command + 把其余 normal batch 交给 [`formatMessages()`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/formatter.ts#L129)。

**5.1 Slash command 分流**：[`poll-loop.ts:230-253`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L230)。对每条 chat 消息调 `categorizeMessage(msg)` ([`formatter.ts:35-56`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/formatter.ts#L35))，如果是 `passthrough` / `admin` category，就先 flush 已积累的 normal batch，再把 raw 文本（不包 XML）push 进 parts。这是因为 Claude Code SDK 只在 prompt 的"第一个 input"是裸 `/cost` 时才把它当命令 dispatch；包了 XML 它就只是文本。本 trace 'ping' 不以 `/` 开头，category 是 `none`，落进 normalBatch。

**5.2 `formatMessages(messages)`** ([`formatter.ts:129-155`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/formatter.ts#L129)) 头部加 `<context timezone="..." />`：

```ts
const header = `<context timezone="${escapeXml(TIMEZONE)}" />\n`;
```

——v1 也这么做（注释里点了出处 `src/v1/router.ts:20-22`）。没有这行，agent 会把"明天 9 点"解释成 UTC 9 点。

然后按 kind 分组（chat / task / webhook / system），每组各自渲染。本 trace 只有一条 chat，进 `formatChatMessages([msg])`，因为 `messages.length === 1` 直接走 `formatSingleChat(msg)`。

**5.3 `formatSingleChat(msg)`** ([`formatter.ts:170-183`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/formatter.ts#L170)) 把一条消息渲染成：

```xml
<message id="2" from="kira-cli" sender="cli" time="2026-05-24 14:32">ping</message>
```

——具体字段提取：
- `content = parseContent(msg.content)`——JSON.parse，失败 fallback 成 `{ text: raw }`（[`formatter.ts:260-266`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/formatter.ts#L260)）
- `sender = content.sender ?? content.author?.fullName ?? content.author?.userName ?? 'Unknown'`
- `time = formatLocalTime(msg.timestamp, TIMEZONE)`——按容器 TZ 转
- `idAttr` 只在 `msg.seq != null` 时加（` id="2"`）——seq 是 agent-facing message id，被 `send_message` / `edit_message` MCP tool 用 ([`messages-out.ts:35-44`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/db/messages-out.ts#L35) 解释了 seq 奇偶 disjoint 不只是防撞)
- `replyAttr` 加 `reply_to="..."` 如果有
- `replyPrefix` 嵌一段 `<quoted_message from="X">Y</quoted_message>` 如果 reply 同时有 sender+text
- `attachmentsSuffix` 把每个附件渲染成 `[image: foo.png — saved to /workspace/inbox/foo.png]` 形式
- `fromAttr` 用 `originAttr(msg)` 反查 destinations

**5.4 `originAttr` / `findByRouting`**：[`formatter.ts:190-197`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/formatter.ts#L190) → [`destinations.ts:58-73`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/destinations.ts#L58)。在 inbound.db `destinations` 表里反查 `(channel_type='cli', platform_id='local')` → 返回 `{ name: 'kira-cli', ... }`。渲染成 ` from="kira-cli"`。Agent 在系统 prompt 里看到 destinations 列表（step 10 第三层 prompt）已经知道 "kira-cli" 是个合法 destination，看到 `from="kira-cli"` 就知道默认回它就行。

**5.5 历史哪去了？** 不在 prompt 里。Continuation 机制：
- 第 11 步开头 [`poll-loop.ts:59`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L59) 已经从 session_state 读出上次 SDK session_id（如果有）。
- 第 13 步会把这个 id 作为 `resume: continuation` 传给 SDK ([`providers/claude.ts:291`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/providers/claude.ts#L291))。
- SDK 自己去读它落地的 `.jsonl` transcript（Claude Code 标准持久化路径 `~/.claude/...`），把历史装回它的 in-memory state，**整段 prefix 都 cache-hit**（5min TTL 内）。

本 trace 是首次对话，continuation 是 undefined，SDK 直接 start fresh。

**5.6 escapeXml**：[`formatter.ts:268-270`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/formatter.ts#L268) 把 text 里的 `<` `>` `&` `"` escape——防止用户消息里的 XML/HTML 把 prompt 的 XML 结构破坏。

**5.7 路由字段被吐掉**：注意 `formatSingleChat` 渲染时**没**输出 `platform_id` / `channel_type` / `thread_id`——agent 一辈子看不到这些 host-side 字段，只看到 reverse-mapped `from="<destination-name>"`。这是 abstraction barrier：换 channel adapter（CLI → Discord）不影响 agent prompt shape。

**最终拼出来的 prompt**（本 trace）形如：

```
<context timezone="America/Los_Angeles" />
<message id="2" from="kira-cli" sender="cli" time="2026-05-24 14:32">ping</message>
```

——一个 short string，会作为 [`provider.query({ prompt, continuation, cwd, systemContext })`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L170) 的 `prompt` 字段往 SDK 灌（步骤 13）。

为什么 NanoClaw 把 history 完全交给 SDK 而不是自己塞？因为 [§"为什么 SQLite 通信"](01-overview.md#3-nanoclaw-的选择两个-db--单-writer--everything-is-a-message) 的设计原则是"DB 只存事实，演化让上游负责"——历史属于"演化"，让 SDK 自己 incremental cache 是最好的。messages_in / messages_out 只是 audit trail，不是 prompt 源。

## 6. 代码位置

按 formatter 实际调用栈：

1. [`container/agent-runner/src/poll-loop.ts:166`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L166)——`formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands)`
2. [`container/agent-runner/src/poll-loop.ts:228-254`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L228)——`formatMessagesWithCommands()` slash command 分流
3. [`container/agent-runner/src/formatter.ts:35-56`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/formatter.ts#L35)——`categorizeMessage()` 命令分类
4. [`container/agent-runner/src/formatter.ts:129-155`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/formatter.ts#L129)——`formatMessages()` 头部 + 按 kind 分组
5. [`container/agent-runner/src/formatter.ts:157-168`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/formatter.ts#L157)——`formatChatMessages()` 单条 / 多条切分
6. [`container/agent-runner/src/formatter.ts:170-183`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/formatter.ts#L170)——`formatSingleChat()` 主渲染
7. [`container/agent-runner/src/formatter.ts:190-197`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/formatter.ts#L190)——`originAttr()`
8. [`container/agent-runner/src/destinations.ts:58-73`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/destinations.ts#L58)——`findByRouting()` 反查 destinations
9. [`container/agent-runner/src/formatter.ts:235-241`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/formatter.ts#L235)——`formatReplyContext()` 引用渲染（本 trace 无）
10. [`container/agent-runner/src/formatter.ts:244-257`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/formatter.ts#L244)——`formatAttachments()`（本 trace 无）
11. [`container/agent-runner/src/formatter.ts:260-266`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/formatter.ts#L260)——`parseContent()` JSON parse + fallback
12. [`container/agent-runner/src/formatter.ts:268-270`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/formatter.ts#L268)——`escapeXml()`
13. [`container/agent-runner/src/timezone.ts`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/timezone.ts)——`TIMEZONE` + `formatLocalTime()`
14. [`container/agent-runner/src/poll-loop.ts:170-175`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L170)——`config.provider.query({ prompt, continuation, cwd, systemContext })` 调用点（本步终态）

## 7. 分支与延伸

- Formatter 的完整 XML schema、reply 链怎么渲、kind 之间的差异（task 带 script output、webhook 带 payload、system 带 action/result），见 [第 8 章 §`formatter.ts`](08-container-agent-runner.md#formatterts) 的逐方法解读。
- Destinations 表的双向用法——既给 agent 系统 prompt 列 destination（[`destinations.ts:82-130`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/destinations.ts#L82)），又用于 inbound 反查 from 标签——见 [第 8 章 §`destinations.ts`](08-container-agent-runner.md#destinationsts)。
- 为什么 NanoClaw 把对话历史塞给 SDK 而不是自己每次重组：背后的"DB 存事实，SDK 管演化"分工见 [第 1 章 §为什么 SQLite 通信](01-overview.md#3-nanoclaw-的选择两个-db--单-writer--everything-is-a-message) 第 3 节的策略论述。
- Continuation id 的 per-provider 命名空间、stale 检测（`STALE_SESSION_RE`）、crash mid-turn 的恢复，见 [第 8 章 §Provider 抽象](08-container-agent-runner.md#provider-抽象)。
- Slash command 全分类规则（admin / filtered / passthrough / none）、host router 怎么 gate filtered/admin、为什么 runner 只直接处理 `/clear`，见 [第 6 章 §router 与命令分流](06-router.md)。

## 8. 走完这一步你脑子里应该多了什么

- Prompt 不带历史——历史完全委托给 SDK 通过 `resume: continuation` 增量 resume；NanoClaw 只负责"当前 turn 的消息批"翻译成结构化 XML。
- `<context timezone="..." />` 头是必须的，少了 agent 就把时间往 UTC 解释——这是个有真实事故的 v1 经验教训。
- Agent 视野里没有 `platform_id` / `channel_type` / `thread_id` 这种 host-side 路由原语，只看见 reverse-mapped 的 `from="<destination-name>"`——destination 名字是 agent 与外部世界的唯一接口。
- Slash command 必须以 raw 文本送进 SDK 的"第一个 input"，否则 Claude Code 不 dispatch——这是 SDK 的硬约束，所以 formatter 要先把 passthrough/admin 命令从 batch 里"切出来"分别送。
- 一条消息的 `seq` 是 agent-facing message id（不是 row id）；agent 用 seq 而不是 uuid 称呼消息，所以渲染时一定要带 ` id="<seq>"`。
- `escapeXml` 是防御：用户消息可能有 `<` `>` `&`，不 escape 会把整段 prompt XML 弄坏。

下一步：把这个 prompt 串 + continuation 喂给 ClaudeProvider，开启流式 query。
