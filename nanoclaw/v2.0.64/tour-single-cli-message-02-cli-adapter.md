## 1. 当前情境

上一步结束时：

- 客户端 `scripts/chat.ts` 已经 `net.connect(data/cli.sock)` 成功。
- 客户端写了一行 `{"text":"ping"}\n`（10 个字节 + 换行）进 socket。
- 客户端进入 `'data'` 事件的等待状态，silence timer 2 秒、hardTimer 120 秒都在跑。
- host 进程那一侧，`src/channels/cli.ts` 里 `net.createServer(...)` 的 connection 回调即将被触发。

数据已经在 socket 内核 buffer 里。下面看 host 怎么把它捞出来。

## 2. 问题

CLI channel 的服务端要做的事比客户端复杂得多：

1. **接受连接，但要区分"chat 客户端"和"admin 单发"两种角色**。`pnpm run chat` 是 chat 客户端（长连接、会持续接 deliver），但同一个 socket 还要支持 `init-first-agent` / bootstrap 脚本那种"我只想发一条消息到某个 channel，发完就走"的 admin 调用。两种角色不能互相挤掉。
2. **chat 客户端只允许一个**。如果第二个终端也开了 `pnpm run chat`，把它的回复发给谁？答案是 **新人接管**：第二个客户端开起来就把第一个踢掉（带 "[superseded by a newer client]" 通知）。
3. **TCP/Unix socket 是字节流，必须按 `\n` 分帧**。一次 `data` 事件可能给半行、可能给两行，绝不能假设"一次 data = 一条消息"。
4. **JSON 解析失败不能崩 server**。客户端可能是老版本、可能是手工 `printf '{"bad"' | nc -U cli.sock` 测试的，server 必须容错。
5. **把消息交给 host 路由层时，要给它打上正确的 `(channelType, platformId, threadId)` 标签**。CLI channel 的 `platformId` 永远是 `'local'`、`threadId` 永远是 `null` —— 但这要 adapter 自己注入，路由器不该关心 channel 内部约定。

## 3. 朴素思路

一个常见 Node.js 服务端写法：

```ts
net.createServer((socket) => {
  socket.on('data', (chunk) => {
    const obj = JSON.parse(chunk.toString())
    handleMessage(obj)
  })
}).listen('/tmp/cli.sock')
```

- 每来一个连接就开始读。
- 假设一次 `data` 是一条完整消息。
- 直接 `JSON.parse`。

写得快，看得懂。

## 4. 为什么朴素思路会崩

每一步都有具体翻车点：

- **不按 `\n` 分帧 → 半条消息或两条粘连**。客户端如果一次写两行（admin bootstrap 脚本会这么干，连续注入多条 seed），server 收到 `{"text":"a"}\n{"text":"b"}\n` 会让 `JSON.parse` 直接抛。或者反过来，包大被 TCP 切两段，第一段 `{"text":"pi` 就抛。
- **`JSON.parse` 不 try/catch → 一条坏行直接 crash 整个 server**。CLI 是 in-tree 唯一 channel，崩了就连 admin 也连不上。
- **每个连接平等接管 `client = socket` → 第二个 admin oneshot 把 chat 客户端踢掉**。bootstrap 脚本注入一条 seed 时，正在等 reply 的开发者终端就被无声 close 了。这是个**实际发生过的坑**，所以 cli.ts 里有 "claimChatSlot" 这个细分。
- **不区分 `(channelType, platformId)` → router 不知道这条消息属于哪个 messaging group**。host 的 `messaging_groups` 表是按 `(channel_type, platform_id)` 唯一索引的（见第 6 章），adapter 不告诉 router 这条消息是 `('cli', 'local')`，router 就没法查表。

## 5. nanoclaw 的做法

`src/channels/cli.ts` 的 `setup()` 和 `handleConnection()` 把上面 5 个坑各拆掉。

**Setup 阶段**（`src/channels/cli.ts:60-90`）：

```ts
async setup(config: ChannelSetup): Promise<void> {
  const sock = socketPath();
  try { fs.unlinkSync(sock); } catch (err) { /* swallow ENOENT */ }
  server = net.createServer((socket) => handleConnection(socket, config));
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(sock, () => {
      try { fs.chmodSync(sock, 0o600); } catch (err) { /* warn */ }
      log.info('CLI channel listening', { sock });
      resolve();
    });
  });
}
```

- 先 `unlinkSync` 清理上一次 crash 留下的陈旧 socket 文件 —— `net.createServer` 不会自动覆盖。
- `chmodSync(0o600)` 把 socket 收紧到 only-owner-can-connect。这是 [第 4 章 §"CLI 与 socket file perms"](04-host-bootstrap.md#cli-与-socket-file-perms) 里的"能连上=即 owner"安全模型的物理实现。
- `config` 是 host 在 `src/index.ts:90-142` 注入的 `ChannelSetup`（见步骤 03），里面装着 `onInbound` / `onInboundEvent` 回调 —— adapter 不直接知道 router 长什么样，它只持有 callback。

**handleConnection 阶段**（`src/channels/cli.ts:138-179`）—— 这是本步的核心：

```ts
function handleConnection(socket: net.Socket, config: ChannelSetup): void {
  let claimedChatSlot = false;

  const claimChatSlot = () => {
    if (claimedChatSlot) return;
    claimedChatSlot = true;
    if (client && client !== socket) {
      try {
        client.write(JSON.stringify({ text: '[superseded by a newer client]' }) + '\n');
        client.end();
      } catch { /* swallow */ }
    }
    client = socket;
    log.info('CLI client connected');
  };

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      void handleLine(line, config, claimChatSlot);
    }
  });

  socket.on('close', () => {
    if (client === socket) client = null;
    if (claimedChatSlot) log.info('CLI client disconnected');
  });
  socket.on('error', (err) => log.warn('CLI client socket error', { err }));
}
```

注意关键设计：**`claimChatSlot` 是个 closure，且默认不被调用**。也就是说，**仅仅 connect 上来不会自动占用 chat 槽位**。要等到 `handleLine` 读到第一行、判断不是 admin 的 `{to:...}` 单发后，才会调 `claimChatSlot()` 真正把当前 socket 装进模块级 `client` 变量。这就解决了"admin bootstrap 脚本把 chat 客户端无声踢掉"那个坑。

**handleLine 阶段**（`src/channels/cli.ts:181-245`）：

```ts
async function handleLine(line: string, config: ChannelSetup, claimChatSlot: () => void): Promise<void> {
  let payload;
  try { payload = JSON.parse(line); }
  catch (err) { log.warn('CLI: ignoring non-JSON line from client', { line }); return; }
  if (typeof payload.text !== 'string' || payload.text.length === 0) return;

  const to = parseAddress(payload.to);
  const replyTo = parseAddress(payload.reply_to);

  if (to) {
    // ADMIN PATH — does NOT claim chat slot
    const event: InboundEvent = {
      channelType: to.channelType,
      platformId: to.platformId,
      threadId: to.threadId,
      message: { id: `cli-...`, kind: 'chat', timestamp: ..., content: JSON.stringify({...}) },
      replyTo: replyTo ?? undefined,
    };
    await config.onInboundEvent(event);
    return;
  }

  // PLAIN CHAT PATH — claims chat slot
  claimChatSlot();
  await config.onInbound(PLATFORM_ID, null, {
    id: `cli-...`,
    kind: 'chat',
    timestamp: ...,
    content: { text: payload.text, sender: 'cli', senderId: `cli:${PLATFORM_ID}` },
  });
}
```

两条路径的本质差别：

| | admin 路径 (`to` 字段存在) | chat 路径（默认） |
|---|---|---|
| 入口 | `config.onInboundEvent(event)` | `config.onInbound(platformId, threadId, message)` |
| 抢 chat 槽位 | 否 | **是**（踢掉前一个客户端） |
| channelType | `event.channelType`（**任意** wired channel） | adapter 自己注入 `'cli'`（在 `src/index.ts:92-108` 那段 wrapper 里） |
| platformId | `event.platformId`（任意） | adapter 固定传 `'local'` |
| 用途 | bootstrap 脚本以 admin 身份注入"以 Discord 名义发条消息到那个 channel" | 普通终端聊天 |

针对本 tour 的 "ping" —— 没有 `to` 字段，走 **chat 路径**：调 `claimChatSlot()`（把当前 socket 装到模块级 `client` 变量，以便后续 `deliver()` 知道往哪写），然后调 `config.onInbound('local', null, message)`。下一步追这个 callback。

**为什么把 `content` 写成 `{text, sender:'cli', senderId:'cli:local'}` 这种 shape？** 因为这是所有 channel 通用的 inbound 消息 schema（见第 6 章），后续 router 的 sender resolver 要从 `senderId` 里识别 user。CLI 没有真实 user 概念，所以塞一个固定的 `cli:local` —— permission 模块会把它当成一个特殊 user 处理。

`deliver()` 时（步骤 17）：

```ts
async deliver(platformId, _threadId, message): Promise<string | undefined> {
  if (platformId !== PLATFORM_ID) return undefined;
  if (!client) return undefined;  // 没人连，静默 no-op
  client.write(JSON.stringify({ text }) + '\n');
}
```

—— 注意 **没有 chat 客户端连接时 silently no-op**。这是有意的（见 `src/channels/cli.ts:33-34` 注释）：outbound 行已经写进 `outbound.db` 持久化了，没人收只是这次"看不到"，不算 data loss。

## 6. 代码位置

按阅读顺序：

- `src/channels/cli.ts:36-44` —— 模块顶部 imports + `PLATFORM_ID = 'local'` 常量。
- `src/channels/cli.ts:47-49` —— `socketPath()` 复用 `DATA_DIR`，和客户端 `scripts/chat.ts:21-23` 算同一个路径。
- `src/channels/cli.ts:51-53` —— `createAdapter()` 闭包里的两个模块级变量 `server` 和 `client`。
- `src/channels/cli.ts:60-90` —— `setup()`：unlink 陈旧 socket、`createServer` 注册 `handleConnection`、`listen` + `chmod 0600`。
- `src/channels/cli.ts:92-113` —— `teardown()`：踢 client、close server、unlink socket 文件。
- `src/channels/cli.ts:115-117` —— `isConnected()` 看 server 在不在跑。
- `src/channels/cli.ts:119-135` —— `deliver()`：往 `client` socket 写一行 JSON。
- `src/channels/cli.ts:138-179` —— `handleConnection()`：本步骤主体，包括 `claimChatSlot` closure 和 `socket.on('data')` 的按 `\n` 分帧 buffer。
- `src/channels/cli.ts:181-245` —— `handleLine()`：JSON.parse → 区分 `to` admin 路径 vs chat 路径 → 调 `config.onInboundEvent` 或 `config.onInbound`。
- `src/channels/cli.ts:247-262` —— `parseAddress()`：安全解析 `to` / `reply_to` 的 `{channelType, platformId, threadId}`。
- `src/channels/cli.ts:267-274` —— `extractText()`：从 `OutboundMessage.content` 里提取 text（deliver 时用）。
- `src/channels/cli.ts:276` —— 模块底部的 `registerChannelAdapter('cli', { factory: createAdapter })`：**模块 import 时立即注册**到 channel-registry。
- `src/channels/adapter.ts:9-26` —— `ChannelSetup` 接口定义：`onInbound` / `onInboundEvent` / `onMetadata` / `onAction` 四个 callback。
- `src/channels/adapter.ts:45-63` —— `InboundEvent` shape：`channelType` / `platformId` / `threadId` + 嵌套的 `message` + 可选 `replyTo`。
- `src/channels/adapter.ts:66-88` —— `InboundMessage` shape（不带 `channelType` —— adapter 自己注入）。
- `src/channels/index.ts` —— 整个 channel 模块 barrel：trunk 里就一行 `import './cli.js';`。

## 7. 分支与延伸

- **CLI adapter 的 wire format 完整描述（含 `to` / `reply_to` admin 路径）**：见 [第 11 章 §"In-tree CLI adapter"](11-self-modification.md#in-tree-cli-adapter)。
- **adapter 接口为什么长这样（`setup` / `teardown` / `deliver` / 可选 `subscribe` / `openDM`）**：见 [第 11 章 §"adapter 接口"](11-self-modification.md#adapter-接口)。
- **socket file perms 0600 与 nanoclaw 的"connected = owner"安全模型**：见 [第 4 章 §"CLI 与 socket file perms"](04-host-bootstrap.md#cli-与-socket-file-perms)。
- **下一步：onInbound callback 到底是 router 直连还是中间还有一层**：见 [03 - onInbound 进入 channel-registry](tour-single-cli-message-03-on-inbound.md)。

## 8. 走完这一步你脑子里应该多了什么

1. **CLI adapter 是 trunk 里唯一内置的 channel**，住在 `src/channels/cli.ts`；其它 channel 都靠 sibling branch + `/add-<channel>` skill 加进来。
2. **server accept 不等于占用 chat 槽位**：只有读到非 admin 的第一行 JSON 才会 `claimChatSlot`，避免 admin bootstrap 脚本踢掉正在等回复的开发者终端。
3. **socket 数据流必须按 `\n` 自己分帧**：用模块内 closure buffer + `while indexOf('\n')` 循环；JSON.parse 永远包 try/catch。
4. **inbound 在 adapter 这一层就被打上 `(channelType='cli', platformId='local', threadId=null)` 标签**：到了 router 那一层就能直接拿来查 `messaging_groups`。
5. **走到这一步**，host 进程持有了：(a) `client` 模块变量指向当前活跃终端 socket（供后续 `deliver()` 用），(b) 一个即将被调用的 `config.onInbound('local', null, message)`。下一步追这个 callback 落到哪。

下一步：[Trace 步骤 03 —— onInbound 进入 channel-registry](tour-single-cli-message-03-on-inbound.md)
