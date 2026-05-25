## 一个 host，N 个聊天平台

前面的章节已经把 host 的核心讲完：路由（第 5 章）、session（第 7 章）、container runner（第 8 章）、SQLite 双向消息表（第 6 章）。但有个问题一直被绕开 —— **入站消息究竟是怎么钻进 host 的？出站消息又是怎么变成 Telegram bot 的 `sendMessage` 调用的？**

答案就是这一章要讲的"通道适配器层"。它要解决一个看似不大、实则相当棘手的工程问题：

- NanoClaw 想支持十几种聊天平台 —— Discord（WebSocket Gateway）、Slack（HTTP webhook + Web API）、Telegram（HTTPS bot polling 或 webhook）、WhatsApp（Cloud API + 私有 webhook）、Teams（Bot Framework + Graph API）、iMessage（AppleScript + SQLite 监控）、Linear / GitHub（webhook + GraphQL）、Webex、Matrix、Resend（email-out）、Google Chat 等等。
- 每种平台的 API 形态完全不同：消息格式不同，鉴权方式不同，"thread" 的概念不同，"被 @ 提及"的语义不同，按钮交互的载荷不同……
- 但 **router** 和 **delivery** 不想知道这些。它们只想说"给我读一条入站消息"或"把这条出站消息送到那个目标"。
- 同时 NanoClaw 不想把所有平台依赖塞进 trunk —— 包体积会爆炸（每个平台 SDK 几十 MB），维护成本极高（每个平台月度 API 变更），而绝大多数个人用户只用其中 1-2 个。

这就是"trunk + 可插拔适配器 + sibling branch"模型的来源。

```
┌───────────────────────────────────────────────────────────────────────┐
│                              trunk (主干)                              │
│                                                                       │
│   src/channels/adapter.ts        ← ChannelAdapter 接口定义           │
│   src/channels/channel-registry.ts ← 注册中心 + 初始化逻辑          │
│   src/channels/index.ts          ← barrel — import 触发副作用       │
│   src/channels/cli.ts            ← 唯一内置 adapter — CLI 终端     │
│   src/channels/chat-sdk-bridge.ts ← Vercel Chat SDK 适配器桥        │
│   src/channels/ask-question.ts    ← 跨平台问答原语                  │
│                                                                       │
└─────────────┬─────────────────────────────────────────────────────────┘
              │  trunk 不带任何具体平台适配器
              │  （没有 discord.ts、没有 slack.ts、没有 telegram.ts）
              │
              │  按需通过 /add-<name> skill 安装
              ▼
┌───────────────────────────────────────────────────────────────────────┐
│                       channels (sibling branch)                       │
│                                                                       │
│   src/channels/discord.ts     ← 装上后 import './discord.js';        │
│   src/channels/slack.ts                                              │
│   src/channels/telegram.ts                                           │
│   src/channels/whatsapp.ts                                           │
│   src/channels/iMessage.ts                                           │
│   src/channels/teams.ts        … 等等十几个                         │
│   tests/                                                              │
│   setup/channels/*.ts          ← 每个 channel 的交互式 OAuth 引导  │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

`channels` 是仓库里一个长寿的 sibling branch（不是主干的子目录、不是 git submodule、也不是 npm package），通过 `git fetch origin channels` 拉下来，然后 skill 把单个文件 `git show channels:src/channels/discord.ts` 提取出来落到本地的 `src/channels/discord.ts`，再 `pnpm install` 锁版本的依赖。每个 `/add-<name>` skill 都遵循同一个模板（详见 §9）。

`CLAUDE.md:115` 把这个设计原则讲得很直接：

> Trunk does not ship any specific channel adapter or non-default agent provider. The codebase is the registry/infra; the actual adapters and providers live on long-lived sibling branches and get copied in by skills.

完整的 channel 列表在 `docs/skills-as-branches.md`，本章后半段会引用。

---

### 1. `ChannelAdapter` 接口

入口文件：`src/channels/adapter.ts:111`。它定义了一个 channel 适配器必须实现的契约。完整接口（节选）：

```ts
// src/channels/adapter.ts:111-167
export interface ChannelAdapter {
  name: string;             // 唯一名字，注册中心用，例如 'cli'、'discord'
  channelType: string;      // 大多数情况下 === name，但 chat-sdk-bridge
                            // 可能让它等于 adapter.name (e.g. 'telegram')
  supportsThreads: boolean; // true: 平台把 thread 作为主要会话单元
                            // false: channel 本身就是会话（Telegram / WhatsApp）

  // 生命周期
  setup(config: ChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;

  // 出站投递 — 返回平台消息 ID（用于后续 edit / reaction）
  deliver(
    platformId: string,
    threadId: string | null,
    message: OutboundMessage,
  ): Promise<string | undefined>;

  // 可选
  setTyping?(platformId: string, threadId: string | null): Promise<void>;
  syncConversations?(): Promise<ConversationInfo[]>;
  resolveChannelName?(platformId: string): Promise<string | null>;
  subscribe?(platformId: string, threadId: string): Promise<void>;
  openDM?(userHandle: string): Promise<string>;
}
```

#### `supportsThreads`：两类平台

这个字段表面上不起眼，但决定了下游 router 的一整块逻辑（第 5 章已经讲过 mention-sticky engage）。文档化在 `adapter.ts:115-125`：

```
supportsThreads = true   → Discord、Slack、Linear、GitHub
                            一个 thread = 一个 session
                            agent 在原 thread 内回复

supportsThreads = false  → Telegram、WhatsApp、iMessage
                            channel 本身就是会话
                            router 在入站时丢弃 threadId
                            agent 直接回到 channel
```

举例：Slack 用户在 `#general` 里发起 thread，每个 thread 都是一个独立 session（独立的对话历史、独立的 `.claude/` 目录）。而 Telegram 群里所有消息都共享同一个 session —— 因为 Telegram 群里没有"thread"概念。

#### `ChannelSetup`：host 给 adapter 的回调集合

`adapter.ts:9-26` 定义了 host 在 `setup()` 时塞给 adapter 的回调对象：

```ts
export interface ChannelSetup {
  onInbound(platformId, threadId, message): void | Promise<void>;
  onInboundEvent(event: InboundEvent): void | Promise<void>;
  onMetadata(platformId, name?, isGroup?): void;
  onAction(questionId, selectedOption, userId): void;
}
```

四个回调的分工：

| 回调            | 谁会调           | 用途                                                                                       |
| --------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `onInbound`     | 普通 chat adapter | 收到来自平台的普通消息。host 自动把 `event.channelType` 设为 adapter 自己的 channelType。 |
| `onInboundEvent` | 管理员透传通道（仅 CLI 用）  | adapter 可以指定任意 channelType / platformId / threadId，甚至 redirect 回复（`replyTo`）。 |
| `onMetadata`    | 任何 adapter      | 平台告诉 host "这个 channel 叫什么"、"它是不是群"。host 用来更新 `messaging_groups` 的 name。 |
| `onAction`      | chat-sdk-bridge   | 用户点击 ask_question 卡片的按钮 / 选项。host 把 `questionId + value + userId` 喂给 approvals 响应器。 |

`InboundEvent`（`adapter.ts:45-63`）和 `InboundMessage`（`adapter.ts:66-88`）的差别也值得停一下：

- `InboundMessage` 是 adapter 已知"这条消息属于 _我这个_ adapter"的语义。host 根据 adapter.channelType 自动填空。
- `InboundEvent` 是已经组装完整的 event（含 channelType / platformId / threadId），用于 admin 透传 —— CLI 想代表 owner 给 Discord 注入一条消息时用 `onInboundEvent`，因为消息明明不是 cli channelType。

注意 `isMention` 字段（`adapter.ts:70-85`）—— 这是平台自己确认的"@ 提及 bot"信号。Chat SDK bridge 从 `onNewMention` / `onDirectMessage` 把它设为 true。**router 用这个字段而不是文本正则匹配**，因为 Telegram 上 mention 是 bot 的平台 username（`@nanoclaw_v2_refactr_1_bot`），不是 agent 显示名（`@Andy`），正则匹配会漏掉。

---

### 2. `channel-registry.ts`：注册中心

`src/channels/channel-registry.ts:21-94`。设计极简：

```ts
const registry = new Map<string, ChannelRegistration>();
const activeAdapters = new Map<string, ChannelAdapter>();

export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}

export function getChannelAdapter(channelType: string): ChannelAdapter | undefined {
  return activeAdapters.get(channelType);
}
```

两个 map 的命名要看清：

- `registry`：按 **adapter name** 索引（`'discord'`、`'slack'`、`'cli'`）。是 `ChannelRegistration`（带 factory + 可选的 containerConfig）的注册表。
- `activeAdapters`：按 **channelType** 索引（多数情况 channelType === name）。是已经 `setup()` 完成的活体 adapter。

`registerChannelAdapter` 是 channel 模块在 import 时自调用 —— 每个 `src/channels/<x>.ts` 末尾必有一句：

```ts
// 例：src/channels/cli.ts:276
registerChannelAdapter('cli', { factory: createAdapter });
```

`initChannelAdapters`（`channel-registry.ts:53-94`）由 host 在启动时调用一次，遍历注册表、调 factory 实例化 adapter、调 `adapter.setup(...)`，最后把活体 adapter 塞进 `activeAdapters`：

```ts
// src/channels/channel-registry.ts:53-94 (节选)
export async function initChannelAdapters(
  setupFn: (adapter: ChannelAdapter) => ChannelSetup,
): Promise<void> {
  for (const [name, registration] of registry) {
    try {
      const adapter = await registration.factory();
      if (!adapter) {
        log.warn('Channel credentials missing, skipping', { channel: name });
        continue;
      }
      const setup = setupFn(adapter);
      // 重试一下网络错误（NetworkError）
      let attempt = 0;
      while (true) {
        try {
          await adapter.setup(setup);
          break;
        } catch (err) {
          if (isNetworkError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
            await sleep(SETUP_RETRY_DELAYS_MS[attempt]!);
            attempt += 1;
            continue;
          }
          throw err;
        }
      }
      activeAdapters.set(adapter.channelType, adapter);
    } catch (err) {
      log.error('Failed to start channel adapter', { channel: name, err });
    }
  }
}
```

几个细节：

1. **factory 返回 null 是合法的**（`channel-registry.ts:57-60`）。意思是"凭证不全，跳过"。例如 Discord adapter 检测到 `DISCORD_BOT_TOKEN` 没设，就 return null，host 静默跳过；其他 channel 照常起。这避免了"开发机上没设 Telegram token，整个 host 起不来"。
2. **NetworkError 重试**（`channel-registry.ts:67-87`）。退避 2s → 5s → 10s。这只针对 `err.name === 'NetworkError'` —— Telegram bot SDK 启动时调用 `deleteWebhook` 可能因为 DNS 抖动失败，这种情况要重试；但 bad token / 配置错应该立即报错，不要被埋掉。
3. **每个 adapter 错独立 catch**：一个 channel 起不来不会拖垮其他。

---

### 3. `channels/index.ts`：barrel

`src/channels/index.ts` 全部内容：

```ts
// src/channels/index.ts
import './cli.js';
```

就这一行。这是整个 trunk 上的全部 channel —— 只挂 CLI。

`/add-discord` 装好之后，这个文件会变成：

```ts
import './cli.js';
import './discord.js';
```

`/add-telegram` 再追加一行 `import './telegram.js';`，依此类推。每次新装一个 channel skill，文件就追加一行；卸载就用 `git revert` 把对应的 merge commit 撤掉，import 行随之消失。

这个"barrel + import side effect"的模式刻意保持笨拙：

- 一目了然 —— 看一眼 `src/channels/index.ts` 就知道这套部署装了哪些 channel。
- 没有反射 / 没有动态 require —— TypeScript 静态分析、Tree shaking、IDE jump-to-definition 全部正常工作。
- 添加是 **追加一行**，移除是 **删一行**。配合 git 操作天然 atomic。

这条规约的存在让 `setup/add-discord.sh:71-74` 那段 awk 都不需要 —— 只判断 grep 一下 import 已经在不在，不在就 append：

```bash
# setup/add-discord.sh:71-74
if ! grep -q "^import './discord.js';" src/channels/index.ts; then
  echo "import './discord.js';" >> src/channels/index.ts
fi
```

---

### 4. 内置 adapter：CLI（详细 walkthrough）

`src/channels/cli.ts` 是 trunk 里唯一的实例 adapter。两个目的：

1. **零凭证可用**：装上 NanoClaw 第一次跑，不配任何 OAuth，就能用 `scripts/chat.ts` 走 Unix socket 跟 agent 对话。
2. **管理员透传通道**：`/init-first-agent` skill 安装第一个 agent 时，需要给 owner 在他选定的渠道（比如 Telegram）注入一条欢迎 DM —— 这个动作通过给 CLI socket 写一行 `{"text": "...", "to": {channelType: "telegram", ...}}` 触发。

它也是这本 wiki 里唯一可以完整读一遍的 adapter 实现样本 —— 真正的 Discord / Slack / Telegram adapter 在 `channels` branch 上，本地默认看不到。下面把整个文件拆开看。

#### 4.1 socket 路径与权限

```ts
// src/channels/cli.ts:45-49
const PLATFORM_ID = 'local';

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}
```

socket 文件落在 `data/cli.sock`。`DATA_DIR` 由 `src/config.ts` 决定，默认 `./data`。

`setup()` 时主动 unlink 旧 socket，然后 chmod 0600：

```ts
// src/channels/cli.ts:60-90 (节选)
async setup(config: ChannelSetup): Promise<void> {
  const sock = socketPath();

  // 旧 socket 清理 —— 上一次崩溃可能留下了 socket 文件，
  // net.createServer 不接受已存在的路径。
  try {
    fs.unlinkSync(sock);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      log.warn('Failed to unlink stale CLI socket (will try to bind anyway)', { sock, err });
    }
  }

  server = net.createServer((socket) => handleConnection(socket, config));
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(sock, () => {
      // 0600：只有 owner 能连。Unix socket 走文件系统权限。
      try {
        fs.chmodSync(sock, 0o600);
      } catch (err) {
        log.warn('Failed to chmod CLI socket (continuing)', { sock, err });
      }
      log.info('CLI channel listening', { sock });
      resolve();
    });
  });
},
```

`0o600` 这一步至关重要 —— 它在文件系统层挡住"同机器上的其他普通用户给我的 agent 发消息"。配合下面"连到 socket ≈ owner"的简化授权模型（见 §4.4），整个 CLI channel 不需要任何鉴权代码。

#### 4.2 wire format：一行一个 JSON

文档化在 `cli.ts:11-26`：

```
Client → server:
  { "text": "user message" }                                # 默认 — 跟 cli/local 对话
  { "text": "...", "to": {"channelType": "discord",
                          "platformId": "discord:@me:149...",
                          "threadId": null} }              # 路由到指定 mg
  { "text": "...", "to": {...}, "reply_to": {...} }         # + redirect 回复
Server → client:
  { "text": "agent reply" }
```

每行一个 JSON 对象，UTF-8，换行符切分。简单到极致 —— 没有 frame length prefix、没有 protobuf、没有版本字段。如果将来要演化，新字段直接加就行。

#### 4.3 single-client chat 语义

`cli.ts:138-179`。一个 adapter 实例只允许一个 *chat* 客户端在线 —— 第二个 chat client 连上来时，第一个收到 `[superseded by a newer client]` 然后被踢掉：

```ts
// src/channels/cli.ts:144-157 (节选)
const claimChatSlot = () => {
  if (claimedChatSlot) return;
  claimedChatSlot = true;
  if (client && client !== socket) {
    try {
      client.write(JSON.stringify({ text: '[superseded by a newer client]' }) + '\n');
      client.end();
    } catch {
      // swallow
    }
  }
  client = socket;
  log.info('CLI client connected');
};
```

为什么不允许多 client 同时收消息？因为"我现在在哪个终端窗口"是个有副作用的状态 —— `setTyping`、CLI 回显格式都得知道往哪写。如果允许两个终端同时连，agent 一条回复要在两边都出现就得做 fan-out；要么就只在第一个连接上出现，让用户困惑。Supersede 是最简单的语义：你换了个终端，旧的不工作了，新的接管。

#### 4.4 admin route-opcode（`to` 字段）

`cli.ts:200-226` —— 如果 client 写的 JSON 里带 `to` 字段，说明这是个"管理员透传"消息：不要把它当作普通 cli 消息，而是构造一个完整的 `InboundEvent`，channelType / platformId / threadId 都按 `to` 字段填，可选的 `reply_to` 决定 agent 回复发回哪里。

```ts
// src/channels/cli.ts:200-226 (节选)
if (to) {
  // 路由型消息 —— 管理员透传。构造完整的 InboundEvent，
  // 目标是 `to` 的 channel/platform，回复由 `reply_to`（如果有）重定向。
  // 不抢占 chat slot —— 不会把当前在线的 chat 客户端踢掉。
  const event: InboundEvent = {
    channelType: to.channelType,
    platformId: to.platformId,
    threadId: to.threadId,
    message: {
      id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({
        text: payload.text,
        sender: typeof payload.sender === 'string' ? payload.sender : 'cli',
        senderId: typeof payload.senderId === 'string'
          ? payload.senderId
          : `cli:${PLATFORM_ID}`,
      }),
    },
    replyTo: replyTo ?? undefined,
  };
  try {
    await config.onInboundEvent(event);
  } catch (err) {
    log.error('CLI: onInboundEvent threw', { err });
  }
  return;
}
```

注意 `onInboundEvent` 而不是 `onInbound` —— 后者会把 channelType 强行覆盖成 adapter 自己的 channelType（即 `'cli'`），那就达不到"代发到别的渠道"的目的了。

应用举例 —— `/init-first-agent` skill 跑到"给 owner 发欢迎 DM"那一步时：

```bash
# 伪代码
echo '{
  "text": "👋 你好！我是你的 NanoClaw agent...",
  "to": {"channelType": "telegram", "platformId": "telegram:6037840640", "threadId": null}
}' | socat - UNIX-CONNECT:./data/cli.sock
```

host 收到这条 JSON 后，调 `onInboundEvent`，按 telegram channel 走 router，最终通过 telegram delivery adapter 把欢迎语发到 Telegram。本地这边 socket 不接收任何回复（没设 `reply_to`），消息在 Telegram 那边自然成为 thread 的起点。

#### 4.5 deliver：no-client 情况静默 no-op

`cli.ts:119-135`：

```ts
async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
  if (platformId !== PLATFORM_ID) return undefined;
  if (!client) {
    // 没有活体终端 —— outbound 行已经在 outbound.db 里持久化了，
    // 所以不是数据丢失。用户下次连接时会看见后续消息（如果以后我们加
    // scroll-back 的话）。不值得 throw。
    return undefined;
  }
  const text = extractText(message);
  if (text === null) return undefined;
  try {
    client.write(JSON.stringify({ text }) + '\n');
  } catch (err) {
    log.warn('Failed to write to CLI client', { err });
  }
  return undefined;
}
```

设计选择是"消息已经在 outbound.db 里、不会丢；但如果当前没人在线，那这条就只是当下不显示"。这跟其他 channel 的"如果发不出去就重试 + 报错"完全不同 —— CLI 的语义就是"如果终端窗口没开就不显示，因为它本来就不是给重要业务用的，是给开发 / 调试用的"。

---

### 5. Chat SDK bridge

绝大多数主流 channel（Discord、Slack、Telegram、WhatsApp、Teams、Webex、Google Chat）的 adapter 都不是"裸写一个 ChannelAdapter"，而是包装 [Vercel AI Chat SDK](https://github.com/vercel/ai) 的现成 adapter。理由也明显：

- Chat SDK 已经帮你处理了"如何在 Discord 上认 mention"、"如何在 Slack 上 open DM"、"如何在 Telegram 上 send / edit / reaction"等所有平台细节。
- 装一个新平台只需要 `pnpm install @chat-adapter/discord@4.26.0`（版本是 skill 里 pin 死的）+ 一个 20 行的 wrapper 把 Chat SDK adapter 实例化、传给 bridge。

`src/channels/chat-sdk-bridge.ts:122` 暴露的核心函数 `createChatSdkBridge`：

```ts
// src/channels/chat-sdk-bridge.ts:122 (签名)
export function createChatSdkBridge(config: ChatSdkBridgeConfig): ChannelAdapter
```

`ChatSdkBridgeConfig`（`chat-sdk-bridge.ts:48-77`）的字段：

| 字段                     | 含义                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `adapter`                | Chat SDK 的 `Adapter` 实例（来自 `@chat-adapter/discord` 等）。                                  |
| `concurrency`            | Chat SDK 的并发策略（默认 `'concurrent'`）。                                                     |
| `botToken`               | 用于转发 Gateway 事件签名验证（仅 Discord 这类用得到）。                                          |
| `extractReplyContext`    | 平台特定的"被回复消息"上下文提取函数。                                                            |
| `supportsThreads`        | 透传给 ChannelAdapter。Discord 这种既可线性又可 thread 用的平台，由 skill 显式声明用哪种模式。  |
| `transformOutboundText`  | 出站文本预处理（例如 Telegram 旧版 Markdown 需要 escape 特殊字符）。                              |
| `maxTextLength`          | 平台单条消息文本上限 —— 超过就走 `splitForLimit` 拆成多条（Discord 2000、Telegram 4096）。      |

#### 5.1 setup：4 条 inbound 路径 + 按钮 action

`chat-sdk-bridge.ts:200-300` 的 `setup()` 大致结构：

```ts
// src/channels/chat-sdk-bridge.ts:200-300 (节选)
async setup(hostConfig: ChannelSetup) {
  setupConfig = hostConfig;
  state = new SqliteStateAdapter();
  chat = new Chat({
    adapters: { [adapter.name]: adapter },
    userName: adapter.userName || 'NanoClaw',
    concurrency: config.concurrency ?? 'concurrent',
    state,
    logger: 'silent',
  });

  // 路径 1：已订阅 thread 中的后续消息
  chat.onSubscribedMessage(async (thread, message) => { ... });

  // 路径 2：未订阅 thread 中被 @mention bot
  chat.onNewMention(async (thread, message) => { ... });

  // 路径 3：DM —— 定义上就是发给 bot 的
  chat.onDirectMessage(async (thread, message) => { ... });

  // 路径 4：未订阅 thread 中的普通消息（pattern 匹配 /[\s\S]*/）
  chat.onNewMessage(/[\s\S]*/, async (thread, message) => { ... });

  // 按钮点击 / select 选项
  chat.onAction(async (event) => { ... });

  await chat.initialize();
}
```

Chat SDK 的 handler dispatch 是 **互斥** 的（注释引用了 SDK 文档 `handling-events.mdx`）：

```
subscribed thread       → onSubscribedMessage
unsubscribed + mention  → onNewMention
unsubscribed + pattern  → onNewMessage
DM                      → onDirectMessage
```

bridge 注册 `onNewMessage(/[\s\S]*/)` 是为了"接到所有未订阅 thread 的所有普通消息"—— router 内部再决定是丢弃、累积、还是 engage。这条注释（`chat-sdk-bridge.ts:253-262`）特别提到：

> getMessagingGroupWithAgentCount (~1 DB read) for unwired channels, so forwarding every one is cheap enough to not need a bridge-side flood gate.

意思是即使全转给 router 也不贵，没必要在 bridge 层做防泛洪。

每个回调里都调一次 `messageToInbound(message, isMention, isGroup)` 把 Chat SDK 的 `Message` 对象序列化成 NanoClaw 的 `InboundMessage`（`chat-sdk-bridge.ts:130-193`）。这里有几个细节值得注意：

1. **附件 base64 化**：附件如果有 `fetchData()` 方法，必须在序列化前下载，因为 `serialize` 之后丢失方法引用：

   ```ts
   // src/channels/chat-sdk-bridge.ts:139-162 (节选)
   if (message.attachments && message.attachments.length > 0) {
     const enriched = [];
     for (const att of message.attachments) {
       const entry: Record<string, any> = {
         type: att.type, name: att.name, mimeType: att.mimeType,
         size: att.size, width: ..., height: ...,
       };
       if (att.fetchData) {
         try {
           const buffer = await att.fetchData();
           entry.data = buffer.toString('base64');
         } catch (err) {
           log.warn('Failed to download attachment', { type: att.type, err });
         }
       }
       enriched.push(entry);
     }
     serialized.attachments = enriched;
   }
   ```

2. **author → senderId 投影**：Chat SDK 用 `serialized.author.{userId, fullName, userName}`，但 router 期望平铺的 `senderId / sender / senderName`（见 permissions 模块 `extractAndUpsertUser`，第 12 章会讲到）。bridge 在这里做归一：

   ```ts
   // src/channels/chat-sdk-bridge.ts:173-180
   const author = serialized.author as { userId?: string; fullName?: string; userName?: string } | undefined;
   if (author) {
     const name = author.fullName ?? author.userName;
     serialized.senderId = author.userId;
     serialized.sender = name;
     serialized.senderName = name;
   }
   ```

3. **`raw` 字段丢弃**：Chat SDK 的 `Message` 默认带平台原始 JSON（`serialized.raw`），可能极大。bridge 一律 `serialized.raw = undefined`，节省 DB 空间。如果上游需要"reply to 引用上下文"，单独通过 `extractReplyContext` 钩子提取一小段（`chat-sdk-bridge.ts:165-169`）。

#### 5.2 deliver：多种 outbound payload kind

`chat-sdk-bridge.ts:368-507`。出站 message 是个 `OutboundMessage`，`content` 是 outbound.db 里一行的 JSON parse 结果。bridge 根据 `content` 的 shape 分发：

```ts
// 概览
if (content.operation === 'edit')       → adapter.editMessage(...)
if (content.operation === 'reaction')   → adapter.addReaction(...)
if (content.type === 'ask_question')    → 渲染按钮 Card
if (content.type === 'card')            → 渲染 send_card Card（fire-and-forget）
else if (content.text || content.markdown) → adapter.postMessage（必要时 splitForLimit）
else if (message.files)                 → 纯文件投递
```

**`ask_question` 渲染**（`chat-sdk-bridge.ts:387-417`）是个值得展开的样本，它是 §6 跨平台 interactive question 机制的 wire-level 实现：

```ts
// src/channels/chat-sdk-bridge.ts:387-417 (节选)
if (content.type === 'ask_question' && content.questionId && content.options) {
  const questionId = content.questionId as string;
  const title = content.title as string;
  const question = content.question as string;
  if (!title) {
    log.error('ask_question missing required title — skipping delivery', { questionId });
    return;
  }
  const options: NormalizedOption[] = normalizeOptions(content.options as never);
  const card = Card({
    title,
    children: [
      CardText(question),
      Actions(
        // 把 button id / value 编码成"选项下标"而不是完整 value。
        // Telegram callback_data 上限 64 字节，长 value（ISO 时间戳、URL）
        // 会把 JSON payload 推过上限。onAction 用 getAskQuestionRender(questionId)
        // 把下标还原成实际 value。
        options.map((opt, idx) =>
          Button({ id: `ncq:${questionId}:${idx}`, label: opt.label, value: String(idx) }),
        ),
      ),
    ],
  });
  const result = await adapter.postMessage(tid, {
    card,
    fallbackText: `${title}\n\n${question}\nOptions: ${options.map((o) => o.label).join(', ')}`,
  });
  return result?.id;
}
```

注释里揭示了一个非常具体的工程取舍：Telegram 的 callback_data 字段限 64 字节，所以 button id 不能塞完整 option value，只能塞 option 下标。Discord 也走同样的索引化编码（`chat-sdk-bridge.ts:393-407` + `chat-sdk-bridge.ts:622-665` 的 forwarded Gateway 解码）—— 保持两端编码一致，是为了让同一个 onAction 路径不分平台。

#### 5.3 状态持久化：`SqliteStateAdapter`

Chat SDK 自己定义了 `StateAdapter` 接口（KV / list / lock / subscription）。`src/state-sqlite.ts` 实现了它，把所有状态持久化到 `v2.db` 里的 `chat_sdk_*` 表。这样 host 重启后 Chat SDK 不会丢"我订阅了哪些 thread"这种重要状态。

实现是直白的 SQL：

```ts
// src/state-sqlite.ts:72-83 (节选)
async subscribe(threadId: string): Promise<void> {
  this.db
    .prepare('INSERT OR REPLACE INTO chat_sdk_subscriptions (thread_id) VALUES (?)')
    .run(threadId);
}

async unsubscribe(threadId: string): Promise<void> {
  this.db.prepare('DELETE FROM chat_sdk_subscriptions WHERE thread_id = ?').run(threadId);
}

async isSubscribed(threadId: string): Promise<boolean> {
  const row = this.db
    .prepare('SELECT 1 FROM chat_sdk_subscriptions WHERE thread_id = ? LIMIT 1')
    .get(threadId);
  return !!row;
}
```

KV、locks、lists 用同样的模式（`state-sqlite.ts:30-172`）。注意：

- **KV 支持 TTL**（`chat_sdk_kv.expires_at`），每次读时顺手 `cleanup()` 删过期行。
- **locks** 也带 TTL —— Chat SDK 的并发控制依赖它确保"同一 thread 同时只有一个 agent reply 在飞"。
- **lists** 用 `(key, idx)` 编排，`appendToList` 自动维护下标 + maxLength 裁剪。

Schema 由 migration 002（`src/db/migrations/002-chat-sdk-state.ts`）创建。

#### 5.4 Webhook 服务器（非-Gateway 平台）

`chat-sdk-bridge.ts:360-364` 决定 webhook 怎么暴露：

```ts
// src/channels/chat-sdk-bridge.ts:360-364
} else {
  // 非 Gateway adapter (Slack, Teams, GitHub, etc.) —— 在共享 webhook server 上注册
  registerWebhookAdapter(chat, adapter.name);
}
```

`src/webhook-server.ts` 提供一个共享的 HTTP server（默认端口 3000），按 `POST /webhook/<adapterName>` 路由，路由到对应 Chat 实例的 webhook handler：

```ts
// src/webhook-server.ts:73-77 (节选)
export function registerWebhookAdapter(chat: Chat, adapterName: string): void {
  routes.set(adapterName, { chat, adapterName });
  ensureServer();
  log.info('Webhook adapter registered', { adapter: adapterName, path: `/webhook/${adapterName}` });
}
```

为什么是共享而不是每个 channel 一个端口？因为外网入口（ngrok / cloudflared / 直接 IP）通常每开一个端口都得多一条 reverse-proxy 规则。集中在一个端口、按路径分流，让运维端 nginx 配置简单到一行 `proxy_pass http://localhost:3000;`。

对 Discord 这种 Gateway-based adapter，bridge 自己额外起一个本地 webhook 接收 Gateway 转发的事件（`chat-sdk-bridge.ts:308-358` + `560-680`）—— Gateway 模式下 Discord 的 INTERACTION_CREATE 也走这条本地 webhook，bridge 在 `handleForwardedEvent` 里直接处理按钮点击。

---

### 6. `ask-question.ts`：跨平台交互式问答原语

`src/channels/ask-question.ts`：

```ts
// src/channels/ask-question.ts
export interface NormalizedOption {
  label: string;
  selectedLabel: string;   // 点击后卡片上显示什么
  value: string;            // 写入 messages_in 的值
}

export function normalizeOption(raw: RawOption): NormalizedOption {
  if (typeof raw === 'string') {
    return { label: raw, selectedLabel: raw, value: raw };
  }
  const label = raw.label;
  return {
    label,
    selectedLabel: raw.selectedLabel ?? label,
    value: raw.value ?? label,
  };
}

export function normalizeOptions(raws: RawOption[]): NormalizedOption[] {
  return raws.map(normalizeOption);
}

export interface AskQuestionPayload {
  type: 'ask_question';
  questionId: string;
  title: string;
  question: string;
  options: NormalizedOption[];
}
```

这是 NanoClaw 整套审批 / 选择 UI 的共享底层。两个生产者：

- **host 侧 approval primitive**（第 12 章详细讲）—— `requestApproval()` emit 一个 ask_question payload 到 admin 的 DM。
- **container 侧 `ask_user_question` MCP 工具**—— agent 想问用户"这个 PR 我要不要直接 squash？[squash / rebase / merge / abort]" 也走同一个 payload。

消费者只有 chat-sdk-bridge `deliver()` 里的 `if (content.type === 'ask_question')` 那一段。整个机制：

```
agent / host  ─┬─→  写一条 outbound row (kind='chat-sdk',
               │     content={ type:'ask_question', questionId, ... })
               │
               │     (走第 9 章的 delivery poll 机制)
               ▼
chat-sdk-bridge.deliver ──→ adapter.postMessage(Card{Actions{Button[]}})
                                        │
                                        ▼
                            Discord Embed + Buttons /
                            Slack Blocks /
                            Telegram InlineKeyboard /
                            ...

(用户点击)
                                        │
                                        ▼
chat.onAction(event)  ──→  setupConfig.onAction(questionId, selectedOption, userId)
                                        │
                                        ▼
                            写一条 messages_in 行 (kind='question_response')
                            (走 router → 找到 pending_approvals / pending_*_approvals)
                                        │
                                        ▼
                            匹配 questionId 的 handler 执行
```

`getAskQuestionRender(questionId)`（`src/db/sessions.ts`）是个反查 —— 因为 button callback_data 里只塞了 option 下标（见 §5.2），点击事件回来时要查"questionId X 的第 idx 个选项的真实 value 是什么、selectedLabel 是什么"。这个反查也支持 host 侧 sweep 修改 expired card 文本（"❌ Expired"），所以 render metadata 需要持久化 —— 这就是 migration 013（`src/db/migrations/013-approval-render-metadata.ts`）的来源，第 12 章 §8 会展开。

---

### 7. Skill install 模板

每个 `/add-<name>` skill 的入口 `setup/add-<name>.sh` 都遵循固定 7 步。以 `setup/add-discord.sh` 为模板，结构如下：

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. 校验凭证 env vars（DISCORD_BOT_TOKEN / APPLICATION_ID / ...）│
├─────────────────────────────────────────────────────────────────┤
│ 2. 判定是否已装：                                                │
│    - src/channels/<name>.ts 是否存在                            │
│    - src/channels/index.ts 是否已有 import 该文件               │
├─────────────────────────────────────────────────────────────────┤
│ 3. （仅未装）git fetch <remote> channels                         │
│    git show <remote>/channels:src/channels/<name>.ts            │
│      > src/channels/<name>.ts                                   │
├─────────────────────────────────────────────────────────────────┤
│ 4. （仅未装）若 src/channels/index.ts 不含 import 行：           │
│    echo "import './<name>.js';" >> src/channels/index.ts        │
├─────────────────────────────────────────────────────────────────┤
│ 5. （仅未装）pnpm install <pkg>@<pinned-version>                 │
│    例：pnpm install @chat-adapter/discord@4.26.0                │
├─────────────────────────────────────────────────────────────────┤
│ 6. （仅未装）pnpm run build                                      │
├─────────────────────────────────────────────────────────────────┤
│ 7. 把凭证写入 .env + data/env/env，                              │
│    然后 launchctl kickstart / systemctl restart 服务            │
└─────────────────────────────────────────────────────────────────┘
```

实际样本（`setup/add-discord.sh:53-90`）：

```bash
# setup/add-discord.sh:53-90 (节选)
need_install() {
  [ ! -f src/channels/discord.ts ] && return 0
  ! grep -q "^import './discord.js';" src/channels/index.ts 2>/dev/null && return 0
  return 1
}

ADAPTER_ALREADY_INSTALLED=true
if need_install; then
  ADAPTER_ALREADY_INSTALLED=false
  log "Fetching channels branch…"
  git fetch "$CHANNELS_REMOTE" channels >&2 2>/dev/null || {
    emit_status failed "git fetch ${CHANNELS_REMOTE} channels failed"
    exit 1
  }

  log "Copying adapter from ${CHANNELS_BRANCH}…"
  git show "${CHANNELS_BRANCH}:src/channels/discord.ts" > src/channels/discord.ts

  # 自动注册 import
  if ! grep -q "^import './discord.js';" src/channels/index.ts; then
    echo "import './discord.js';" >> src/channels/index.ts
  fi

  log "Installing ${ADAPTER_VERSION}…"
  pnpm install "${ADAPTER_VERSION}" >&2 2>/dev/null || {
    emit_status failed "pnpm install ${ADAPTER_VERSION} failed"
    exit 1
  }

  log "Building…"
  pnpm run build >&2 2>/dev/null || {
    emit_status failed "pnpm run build failed"
    exit 1
  }
else
  log "Adapter files already installed — skipping install phase."
fi
```

为什么不用 `git merge channels` 把整个 branch 合进来？因为不同 channel 互不依赖，用户大概率只想要 Discord 不想要其他十几个。文件级别 `git show > dest` 比 merge 更精确、不会污染 git 历史、卸载也只需删一个文件 + 删一行 import。

`ADAPTER_VERSION` 是 hardcode 的版本字符串（例：`"@chat-adapter/discord@4.26.0"`）。每次 skill 升级，hardcoded 版本同步升。这跟前面提到的 `setup/channels/discord.ts` 里那段交互式 OAuth 引导分开 —— 交互式引导跑在 Claude Code 上下文里，根据 platform 不同（Discord 要建 Application、要拿三个 token；Telegram 要去找 BotFather；iMessage 要打开 Accessibility 权限），由 skill 的 SKILL.md 指导 Claude 去带用户走。`add-<name>.sh` 只负责"凭证已经到位之后落地"。

#### channels 分支里到底有哪些 adapter？

引用 `CLAUDE.md:119` 和 `docs/skills-as-branches.md`（§Migration / Skill branches 列表）：

| Channel | 模式 | 备注 |
| --- | --- | --- |
| Discord | Chat SDK + Gateway | `@chat-adapter/discord` |
| Slack | Chat SDK + webhook | `@chat-adapter/slack` |
| Telegram | Chat SDK + bot polling / webhook | callback_data 64B 限制 |
| WhatsApp | 私有 webhook | WhatsApp Business Cloud API |
| WhatsApp Cloud | 独立 adapter | Meta WhatsApp Cloud API |
| Teams | Chat SDK + Bot Framework | 用户 id 是 `29:xxx` 形式 |
| Linear | webhook | 任务工作流 |
| GitHub | webhook | issue / PR 评论 |
| iMessage | AppleScript + SQLite 监控 | macOS only |
| Webex | Chat SDK | Cisco Webex |
| Resend | email-out only | 发邮件，不接收 |
| Matrix | 客户端 SDK | 自托管 |
| Google Chat | Chat SDK | Workspace |
| Signal | signal-cli wrapper | 自托管 daemon |

完整 SKILL.md 在 marketplace repo `nanocoai/nanoclaw-skills`（见 `docs/skills-as-branches.md:88-108`）。

---

### 8. 新 channel 首次产生消息：审批

到目前为止讲的都是"管理员已经把 channel 接好"之后的事。第一次有人在某个新 Discord channel 里 @ 我的 bot —— 那个 channel 还不在 `messaging_groups` 表里 —— 会发生什么？

答案在 `src/modules/permissions/channel-approval.ts`。流程：

1. router（`src/router.ts`）发现这个 messaging_group 不存在且消息是 bot mention，调 `requestChannelApproval({ messagingGroupId, event })`。
2. `requestChannelApproval`（`channel-approval.ts:128-237`）：
   a. 用 `pickApprover` + `pickApprovalDelivery`（第 12 章 §6）选一个 admin 和能投递的 DM。
   b. 构造一个 ask_question 卡片，options 是：
      - 单 agent 时："Connect to <agent name>"
      - 多 agent 时："Choose existing agent"
      - 始终包含："Connect new agent"、"Reject"
   c. 在 `pending_channel_approvals` 表里写一行（PK 是 messaging_group_id —— 天然防卡片刷屏，重复 mention 期间静默丢弃）。
   d. deliver 卡片到 admin DM。
3. admin 点 "Connect"：`src/modules/permissions/index.ts:310-508` 的 `handleChannelApprovalResponse` 接管：
   a. 在 `messaging_group_agents` 写一行（默认 `mention-sticky` for groups / `pattern='.'` for DMs，`sender_scope='known'`，`ignored_message_policy='accumulate'`）。
   b. 把触发的 sender 加进 `agent_group_members` —— 避免 sender_scope 又把重放的消息当 unknown sender 弹一次审批。
   c. 删 pending 行。
   d. `routeInbound(originalEvent)` 重放原消息。这次 messaging_group 已经存在且 wired，正常 engage。
4. admin 点 "Reject"：`setMessagingGroupDeniedAt(...)` 把 `messaging_groups.denied_at` 设为当前时间。router 后续遇到同一个 mg 时会查 `denied_at` 直接丢弃，不再升级。

详细的 schema 和 migration（denied_at 列、pending_channel_approvals 表）在 `src/db/migrations/012-channel-registration.ts`（第 12 章 §8 会回到这里）。

注意这条流程跟"sender approval"（已知 channel 上的未知发送者）是两个独立的表 + 两个独立的 pending 行 + 共享同一个 ask_question / approval primitive。第 12 章会在统一视角下讲。

---

### 9. 运行时排错指南

#### "我装好 Discord 但 bot 不响应"

依次检查：

1. **adapter 是否在启动序列里被 init**？
   ```bash
   grep "Channel adapter started" logs/nanoclaw.log | grep discord
   ```
   预期看到 `{"channel":"discord","type":"discord"}`。
   - 没看到，但有 `Channel credentials missing` —— factory return null，去 `.env` / `data/env/env` 查 `DISCORD_*` 凭证。
   - 没看到，且没有任何 discord 相关日志 —— `src/channels/index.ts` 没有 `import './discord.js';` 一行，或 `src/channels/discord.ts` 文件根本不存在。看 §7 的 `need_install()` 判定。

2. **adapter setup 抛错**？
   ```bash
   grep "Failed to start channel adapter" logs/nanoclaw.error.log
   ```
   或者：
   ```bash
   grep "Channel adapter setup failed with network error" logs/nanoclaw.log
   ```
   后者是被 NetworkError 重试机制吞了 —— 如果重试三次后还失败，会变成"Failed to start"。

3. **消息收到了但 router 丢了**？
   消息进入 host 后会留下一堆 `routeInbound` 的 trace。grep 一下 platform message id 或 sender id：
   ```bash
   grep "<your-discord-user-id>" logs/nanoclaw.log
   ```
   如果完全没有命中，是 adapter 自己根本没拿到事件。装 Discord 时常见原因是 bot 没被 invite 到那个 server，或 Privileged Intents 没在 Discord Developer Portal 勾选。

4. **router 收到但没投递回 Discord**？
   看 `delivery` 相关日志（第 9 章覆盖了 delivery polls）。`outbound.db` 里能看到行但没 platform_message_id —— `getChannelAdapter('discord')` 返回 undefined，说明 adapter 没被 set 进 `activeAdapters`。回到检查 1。

#### "我点了按钮但没有任何反应"

按钮点击的事件路径：

```
用户点按钮
    │
    ▼
平台事件
    │
    ├─ Gateway-based (Discord) → bridge 内部 webhook → handleForwardedEvent
    └─ webhook-based (Slack, Teams) → /webhook/<adapter> → chat.webhooks[...](req)
    │
    ▼
chat.onAction handler
    │
    ▼
setupConfig.onAction(questionId, selectedOption, userId)
    │
    ▼
host writeSessionMessage (kind='question_response')
    │
    ▼
router 拣到 → dispatchResponse → 各种 response handler 轮流 claim
    │
    ▼
match 到的 handler 执行（approvals / sender-approval / channel-approval / 等）
```

最常见的卡点是中间那一段 —— 卡片 deliver 成功了，但点击事件没回到 host。

- Slack：检查 `WEBHOOK_PORT`（默认 3000）外网可达 + Slack App 的 Interactivity URL 配对了。
- Discord：检查 `DISCORD_PUBLIC_KEY` 配对 + bot 有 `Use Slash Commands` 权限。

按钮 id 编码用了短下标（见 §5.2）—— 如果是手动测试时构造的 callback_data 走了"完整 value" fallback path，`resolveSelectedOption`（`chat-sdk-bridge.ts:93-104`）会原样返回，但 handler 那边只认 normalized option value，可能 mismatch。看 `getAskQuestionRender(questionId)` 返回的 options 是不是空。

---

### 10. 测试参考

通道层有两个测试文件值得读，它们也是给读者构造心智模型的好样本：

#### `src/channels/channel-registry.test.ts`

包含两块：

- **registry 自身的契约**：注册 → 拿 → 列出；null factory 跳过；containerConfig 透传。
- **channel + router 集成**：mock 一个 adapter，从 inbound → router → session DB 写消息；setDeliveryAdapter 桥 → 出站消息回到 adapter delivered 列表。

代码很短（约 230 行），是理解"adapter 跟 host 怎么对接"的最佳起点：

```ts
// src/channels/channel-registry.test.ts:204-234 (节选)
const mockAdapter = createMockAdapter('mock');
registerChannelAdapter('mock-delivery', { factory: () => mockAdapter });

await initChannelAdapters(() => ({
  conversations: [],
  onInbound: () => {},
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: () => {},
}));

setDeliveryAdapter({
  async deliver(channelType, platformId, threadId, kind, content) {
    const adapter = getChannelAdapter(channelType);
    if (!adapter) return undefined;
    return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content) });
  },
});

const adapter = getChannelAdapter('mock');
if (adapter) {
  await adapter.deliver('chan-100', null, { kind: 'chat', content: { text: 'Agent response' } });
}

expect(mockAdapter.delivered).toHaveLength(1);
```

#### `src/channels/chat-sdk-bridge.test.ts`

测的是 bridge 的"窄、平台相邻"的表面 —— 不重复测 router 逻辑（那部分在 `host-core.test.ts` 端到端测）。覆盖：

- `splitForLimit` 三种切分策略（paragraph / line / hard-cut）。
- `openDM` 仅在底层 Chat SDK adapter 实现了 openDM 时才暴露 + 通过 `channelIdFromThreadId` 转一道。
- `subscribe` 总是暴露（哪怕底层 adapter 没实现 —— 走 state 的 idempotent INSERT OR REPLACE）。
- `send_card` 路径：title + description + children 渲染、url-less actions 被丢、url-only actions 渲成 link buttons、空卡跳过。
- 非 card chat-sdk payload 回退到 text 路径。

注释里那条原话（`chat-sdk-bridge.test.ts:54-59`）是给后续维护者的提醒：

> The bridge is now transport-only: forward inbound events, relay outbound ops. All per-wiring engage / accumulate / drop / subscribe decisions live in the router (src/router.ts routeInbound / evaluateEngage) and are exercised by host-core.test.ts end-to-end. These tests only cover the bridge's narrow, platform-adjacent surface.

意思是别给 bridge 测里塞业务逻辑测试 —— 那些归 router。

---

### 11. 总结：分层一图

把这章涉及的所有部件拼在一起：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          外部聊天平台                                    │
│  Discord WS  Slack Web API  Telegram bot API  WhatsApp Cloud  ...      │
└─┬───────────────┬───────────────┬───────────────┬───────────────────────┘
  │ Gateway       │ webhook       │ polling/webhook│ webhook
  ▼               ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                Chat SDK adapter (chat / @chat-adapter/*)                │
│   handlers: onSubscribedMessage / onNewMention / onDirectMessage /     │
│             onNewMessage / onAction                                    │
└─┬──────────────────────────────────────────────────────────────────────┘
  │ Chat SDK 抽象的 thread / Message / Card / Button
  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│         chat-sdk-bridge (src/channels/chat-sdk-bridge.ts)               │
│ - messageToInbound → ChannelAdapter.onInbound                          │
│ - deliver → adapter.postMessage / editMessage / addReaction            │
│ - state → SqliteStateAdapter (chat_sdk_* 表)                           │
│ - openDM, subscribe 桥接                                                │
└─┬──────────────────────────────────────────────────────────────────────┘
  │ NanoClaw 的 ChannelAdapter / InboundMessage / OutboundMessage
  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              channel-registry (src/channels/channel-registry.ts)        │
│ - registerChannelAdapter / getChannelAdapter / initChannelAdapters     │
│ - 启动重试 / null factory 跳过                                          │
└─┬──────────────────────────────────────────────────────────────────────┘
  │ router 调 getChannelAdapter(channelType) 拿活体 adapter
  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│   src/router.ts / src/delivery.ts                                       │
│   核心实体模型（用户、消息组、智能体组、session）见第 5 章               │
└─────────────────────────────────────────────────────────────────────────┘
```

trunk 里只有这张图的中间三层（adapter 接口 / registry / bridge）。最底下的"具体平台 Chat SDK adapter"由 `/add-<name>` skill 装上 + `pnpm install` 锁版本。整套机制让 NanoClaw 既能保持 trunk 苗条（300 KB），又能让单个开发者维护十几个 channel 不撑死。

下一章（第 12 章）转向"凭证"和"审批"—— 上面提到的 `ask_question` 卡片 + admin DM + pending_channel_approvals / pending_sender_approvals 表共享同一个底层 primitive，那一章会详细讲 OneCLI gateway 和 `src/modules/approvals/`。

---

### 关键文件汇总

| 文件                                                  | 行数参考          | 用途                                       |
| ----------------------------------------------------- | ----------------- | ------------------------------------------ |
| `src/channels/adapter.ts`                             | 111-167           | ChannelAdapter 接口、InboundEvent、OutboundMessage |
| `src/channels/channel-registry.ts`                    | 21-94             | registerChannelAdapter / initChannelAdapters |
| `src/channels/index.ts`                               | 全部              | barrel - import 触发副作用                  |
| `src/channels/cli.ts`                                 | 全部              | 内置 CLI adapter（详细 walkthrough）        |
| `src/channels/chat-sdk-bridge.ts`                     | 122 (createChatSdkBridge), 200-300 (setup), 368-507 (deliver) | Vercel Chat SDK 适配桥 |
| `src/channels/ask-question.ts`                        | 全部              | 跨平台交互式问答原语                        |
| `src/state-sqlite.ts`                                 | 20-180            | Chat SDK StateAdapter 的 SQLite 实现        |
| `src/webhook-server.ts`                               | 73-125            | 共享 HTTP webhook server                    |
| `src/modules/permissions/channel-approval.ts`         | 128-237 (requestChannelApproval) | 新 channel 注册审批 |
| `src/modules/permissions/index.ts`                    | 292-624 (handleChannelApprovalResponse + name interceptor) | 审批响应处理 |
| `src/channels/channel-registry.test.ts`               | 全部              | registry + 集成测试样本                     |
| `src/channels/chat-sdk-bridge.test.ts`                | 全部              | bridge 单元测试样本                         |
| `setup/add-discord.sh`                                | 全部              | skill install 模板                          |
| `setup/channels/discord.ts`                           | 全部              | 交互式 OAuth 引导                           |
| `docs/skills-as-branches.md`                          | 全部              | sibling branch 模型                         |
| `docs/setup-wiring.md`                                | 全部              | 起步流程                                    |
| `CLAUDE.md`                                           | §"Channels and Providers (skill-installed)" | 设计原则 |
