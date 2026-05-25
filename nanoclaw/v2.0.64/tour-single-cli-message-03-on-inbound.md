## 1. 当前情境

上一步结束时：

- `src/channels/cli.ts:181-245` 的 `handleLine()` 已经把客户端写进 socket 的 `{"text":"ping"}\n` 解析成了一个内部 `InboundMessage` 对象：

  ```ts
  {
    id: 'cli-1716200000123-a4f7e2',
    kind: 'chat',
    timestamp: '2026-05-24T10:00:00.000Z',
    content: {
      text: 'ping',
      sender: 'cli',
      senderId: 'cli:local',
    },
  }
  ```

- adapter 注入了自己的 `channelType = 'cli'` 和 `platformId = PLATFORM_ID = 'local'`、`threadId = null`。
- 紧接着调用：

  ```ts
  await config.onInbound(PLATFORM_ID, null, message);
  ```

- `config` 这个 `ChannelSetup` 是 setup 阶段被 host 注入的。`config.onInbound` 指向哪段代码？这一步就专门讲它。

## 2. 问题

adapter 和 router 之间需要一座桥。这座桥要满足：

1. **解耦 adapter 和 router 的实现细节**：adapter 不该 `import` router，否则未来想做单元测试（mock 一个假 router 跑 adapter）就被锁死了。
2. **adapter 不知道还有谁也注册了同一种 channel**。CLI 的 `cli/local` 在系统里只能有一个 adapter 实例 —— "事件丢给谁" 必须是 setup 时就确定，不能 adapter 自己跑去查表。
3. **把 raw `InboundMessage`（内容是 JS object）转成 router 想要的 `InboundEvent`（内容是 JSON string）**。两个 shape 几乎一样，但 `content` 字段一个是 object 一个是字符串 —— 这个转换发生在哪？
4. **错误隔离**：router 抛了不能把 adapter 拖死。adapter 同一个 socket 还要处理后续消息。

## 3. 朴素思路

最自然的设想：channel-registry 是一个 N:M 的路由表 —— "事件类型 A 来了，查表找到 handler 1、handler 2、handler 3，一一调用"。adapter 把事件 push 进 registry，registry 负责 fan-out 到所有订阅者。

```ts
// pseudo
channelRegistry.publish('cli', event)
// internally:
for (const handler of subscribers['cli']) handler(event)
```

而且既然有个 "registry"，那它应该也兼管反向调度 —— router 想知道某个 channel 有没有新事件，从 registry 拉。

## 4. 为什么朴素思路会崩

具体讲为什么这两个直觉都不对：

- **N:M fan-out 没有真实需求**：nanoclaw 里每种 `channelType` **只能有一个 adapter 实例**（不能同时跑两个 Discord adapter 对应同一个 bot token）。同样，router 在系统里也 **只有一个**（`routeInbound` 是个全局 async 函数）。所以"事件"和"处理者"是 1:1 的，引入 publisher/subscriber 抽象等于发明用不上的复杂度。
- **registry 拉模式（pull）违反 IO 模型**：每个 adapter 内部有自己的 IO 循环 —— CLI 是 `net.createServer` 的回调链、Discord 是 Chat SDK 的 WebSocket 事件、Telegram 是 long-poll 循环。它们都是 **由外部事件驱动**主动 push，让 registry"睡眠等事件、被叫醒拉数据" 既绕远路又破坏每个 adapter 自然的 IO 形状。adapter 醒着就直接调 callback，最简单。
- **如果 adapter 拿到的 callback 真的是 `routeInbound` 本体**，那么 adapter 必须自己拼一个完整 `InboundEvent`（包括把 `content` JSON.stringify、塞 `channelType` 字段）—— 但 adapter 99% 的事件用的都是"我自己 channelType 的事件，content 是 object"，强迫每个 adapter 重复这段拼装代码就很丑。

## 5. nanoclaw 的做法

答案让人有点失望也很省事：**channel-registry 根本不参与事件路由，它只是个 `Map<channelType, ChannelAdapter>`**。事件路由就是 setup 时 host 注入的一段 **thin closure**，每次调用就是直接 `routeInbound(event)`。

证据看 `src/index.ts:90-142`：

```ts
// src/index.ts:90-142
await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
  return {
    onInbound(platformId, threadId, message) {
      routeInbound({
        channelType: adapter.channelType,    // <- 这里！adapter 自身的 channelType 被注入
        platformId,
        threadId,
        message: {
          id: message.id,
          kind: message.kind,
          content: JSON.stringify(message.content),  // <- object → string 转换
          timestamp: message.timestamp,
          isMention: message.isMention,
          isGroup: message.isGroup,
        },
      }).catch((err) => {
        log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
      });
    },
    onInboundEvent(event) {
      routeInbound(event).catch((err) => {
        log.error('Failed to route inbound event', {
          sourceAdapter: adapter.channelType,
          targetChannelType: event.channelType,
          err,
        });
      });
    },
    onMetadata(platformId, name, isGroup) { /* ... */ },
    onAction(questionId, selectedOption, userId) { /* ... */ },
  };
});
```

仔细看这段做了什么：

1. `initChannelAdapters(setupFn)` 在 `src/channels/channel-registry.ts:53-94`，对每个 registered adapter 调 `setupFn(adapter)` 拿到 `ChannelSetup`，然后 `await adapter.setup(setup)`。
2. **`setupFn` 是 host 写的 closure**：它接到一个 adapter，**返回一份 callback bundle**。CLI adapter 在 `setup()` 里把这份 bundle 存进 `config` 局部变量。
3. closure **闭包了 `adapter`** 这个变量 —— 所以 `routeInbound` 调用时 `adapter.channelType` 总能从对应的 adapter 实例上拿到（CLI adapter 调 callback 时 = `'cli'`，Discord adapter 调 = `'discord'`）。adapter 自己不需要把 `channelType` 当参数传过来。

这就解释了：

- **为什么 `onInbound` 的签名是 `(platformId, threadId, message)` 而不是完整 event**：channelType 已经从 adapter 实例闭包进来，不必再传。
- **为什么 `content` 在 adapter 那里是 object、到 router 那里是 string**：转换发生在这段 wrapper closure 里，`JSON.stringify(message.content)`。router 一律拿 string，因为后续会原封不动 INSERT 进 `messages_in.content` 列。
- **为什么 `onInboundEvent` 不做转换**：admin 路径已经从客户端拿到了完整 `InboundEvent`（包括 `content: string` 和任意 `channelType`），透传即可 —— 这是 CLI admin 注入"以 Discord 名义发消息"那条路径的需求。

对应到 channel-registry 里 `initChannelAdapters`（`src/channels/channel-registry.ts:53-94`）的全部职责：

```ts
export async function initChannelAdapters(setupFn: ...): Promise<void> {
  for (const [name, registration] of registry) {
    const adapter = await registration.factory();
    if (!adapter) continue;  // 凭证缺失，跳
    const setup = setupFn(adapter);  // <- 调 host 提供的 closure 拿 callback bundle
    // ... NetworkError 重试 ...
    await adapter.setup(setup);  // <- 注入给 adapter
    activeAdapters.set(adapter.channelType, adapter);  // <- 装进活跃表（供 deliver 用）
  }
}
```

`activeAdapters` 这个 Map 唯一的用途是 **反向** ——`src/index.ts:154` 的 `getChannelAdapter(channelType)` 在 deliver 时根据 channelType 找到 adapter 调 `deliver()`。事件路由 (inbound) 不查这张表，**adapter 主动 push closure**。

所以这一步实际发生的事情，跟"封装良好的 framework 路由层"那种想象完全不同：

<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Diagram showing the CLI adapter calling the onInbound closure which forwards to routeInbound — no registry, no event bus in between">
  <defs>
    <marker id="ar31" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="30" y="60" width="200" height="100" rx="8" fill="#0d9488" opacity="0.15" stroke="#0d9488" stroke-width="1.5"/>
  <text x="130" y="84" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">CLI adapter</text>
  <text x="130" y="104" text-anchor="middle" font-size="11" fill="#64748b">handleLine()</text>
  <text x="130" y="122" text-anchor="middle" font-size="11" fill="#64748b">持有 config</text>
  <text x="130" y="146" text-anchor="middle" font-size="10" fill="#94a3b8">src/channels/cli.ts:181</text>
  <line x1="232" y1="110" x2="316" y2="110" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar31)"/>
  <text x="274" y="100" text-anchor="middle" font-size="10" fill="#64748b">config.onInbound(</text>
  <text x="274" y="124" text-anchor="middle" font-size="10" fill="#64748b">platformId, threadId, msg)</text>
  <rect x="320" y="60" width="220" height="100" rx="8" fill="#ea580c" opacity="0.15" stroke="#ea580c" stroke-width="1.5"/>
  <text x="430" y="84" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">onInbound wrapper</text>
  <text x="430" y="104" text-anchor="middle" font-size="11" fill="#64748b">inject adapter.channelType</text>
  <text x="430" y="120" text-anchor="middle" font-size="11" fill="#64748b">JSON.stringify(content)</text>
  <text x="430" y="136" text-anchor="middle" font-size="11" fill="#64748b">.catch(err =&gt; log.error)</text>
  <text x="430" y="152" text-anchor="middle" font-size="10" fill="#94a3b8">src/index.ts:92</text>
  <line x1="430" y1="160" x2="430" y2="200" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar31)"/>
  <text x="500" y="184" text-anchor="middle" font-size="10" fill="#64748b">routeInbound(event)</text>
  <rect x="320" y="200" width="220" height="60" rx="8" fill="#7c3aed" opacity="0.18" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="430" y="222" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">routeInbound()</text>
  <text x="430" y="240" text-anchor="middle" font-size="10" fill="#94a3b8">src/router.ts:158</text>
  <rect x="570" y="80" width="170" height="64" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="4,3"/>
  <text x="655" y="100" text-anchor="middle" font-size="11" font-weight="600" fill="#dc2626">朴素想象：</text>
  <text x="655" y="118" text-anchor="middle" font-size="10" fill="#64748b">registry 查表 + 事件总线</text>
  <text x="655" y="134" text-anchor="middle" font-size="10" fill="#64748b">+ pub/sub fan-out</text>
  <text x="655" y="170" text-anchor="middle" font-size="11" font-weight="600" fill="#16a34a">实际：</text>
  <text x="655" y="186" text-anchor="middle" font-size="10" fill="#64748b">同一 await 调用栈</text>
  <text x="655" y="200" text-anchor="middle" font-size="10" fill="#64748b">零中间层</text>
</svg>
<span class="figure-caption">图 T1.2 ｜ adapter → router 是一个 thin closure 调用链：channel-registry 不参与路由，wrapper 只做 channelType 注入 + content stringify + 错误隔离。</span>

<details>
<summary>ASCII 原版</summary>

```
+----------------+                  +-------------------+
| CLI adapter    |    closure call  | onInbound wrapper |
| handleLine()   | ---------------> | (src/index.ts:92) |
| 持有 config    |  config.onInbound|                   |
+----------------+                  +-------------------+
                                              |
                                              | routeInbound(event)
                                              v
                                    +-------------------+
                                    | src/router.ts:158 |
                                    | routeInbound()    |
                                    +-------------------+
```

</details>

中间没有 registry 查表、没有事件总线、没有队列。从 `handleLine` 到 `routeInbound` 是 **同一个 await 调用栈**（同步堆栈 + Promise chain）。

异步只在两个地方出现：

- `routeInbound` 本身是 async（返回 Promise），所以 `handleLine` 用 `void handleLine(...)` 在 `socket.on('data')` 循环里 fire-and-forget。
- wrapper 里的 `.catch(err => log.error(...))` 是 **错误隔离屏障**：router 抛了只 log，不会冒泡到 adapter 的 `socket.on('data')` 把整个 connection handler 拖死。这是上面"问题 4"的解。

回到 "ping" 这条消息的状态：

```ts
// 即将传给 routeInbound 的 event：
{
  channelType: 'cli',
  platformId: 'local',
  threadId: null,
  message: {
    id: 'cli-1716200000123-a4f7e2',
    kind: 'chat',
    content: '{"text":"ping","sender":"cli","senderId":"cli:local"}',  // <- 已 stringify
    timestamp: '2026-05-24T10:00:00.000Z',
    isMention: undefined,
    isGroup: undefined,
  },
  // 没有 replyTo —— chat 路径不带
}
```

这就是 router 即将看到的输入。

## 6. 代码位置

按阅读顺序：

- `src/index.ts:64` —— `import { initChannelAdapters, ..., getChannelAdapter } from './channels/channel-registry.js'`。
- `src/index.ts:90-142` —— `initChannelAdapters(setupFn => {...})` 调用：返回 `ChannelSetup` 的那段 closure 就是本步骤的"路由中转层"。
- `src/index.ts:92-108` —— `onInbound` wrapper：注入 `adapter.channelType`、JSON.stringify content、调 `routeInbound`、catch 错误。
- `src/index.ts:109-117` —— `onInboundEvent` wrapper：admin 路径直接透传 event 给 `routeInbound`。
- `src/index.ts:118-125` —— `onMetadata` callback：channel metadata 仅记日志。
- `src/index.ts:126-140` —— `onAction` callback：按钮点击进 `dispatchResponse`（approval 流相关，本 tour 不涉及）。
- `src/channels/channel-registry.ts:21-22` —— 模块级 `registry` 和 `activeAdapters` 两个 Map。
- `src/channels/channel-registry.ts:25-27` —— `registerChannelAdapter(name, registration)`：被 `src/channels/cli.ts:276` 在 import 阶段调用。
- `src/channels/channel-registry.ts:30-32` —— `getChannelAdapter(channelType)`：deliver 时根据 channelType 反查 adapter。
- `src/channels/channel-registry.ts:53-94` —— `initChannelAdapters(setupFn)`：对每个 registered adapter 调 `setupFn(adapter)` 拿 callback bundle、跑 adapter.setup、装进 activeAdapters。
- `src/channels/channel-registry.ts:67-87` —— NetworkError 重试逻辑（CLI 用不上 —— 它不会 NetworkError —— 但 Discord/Telegram setup 时会）。
- `src/router.ts:158` —— `routeInbound(event)` 的入口签名。
- `src/router.ts:159-167` —— routeInbound 头两行：先跑 interceptor、再 strip threadId（如果 adapter 不 supportsThreads）。CLI `supportsThreads=false`（见 `src/channels/cli.ts:58`），所以这里会把 `threadId` 再次确认为 null。

## 7. 分支与延伸

- **channel-registry 完整设计（register / init / teardown、为什么是 `Map<channelType, Adapter>` 而不是事件总线）**：见 [第 11 章 §"channel-registry"](11-self-modification.md#channel-registry)。
- **channel adapter 在 `src/index.ts` main() 里被注册的整体顺序（DB 先 → 容器 runtime → channel → delivery → host sweep → ncl）**：见 [第 5 章 §"channel 注册"](05-channel-adapters.md#channel-注册)。
- **`routeInbound` 入口之后的完整流程（messaging_group 解析、sender resolver、agent fan-out、access gate、session 解析、写入 messages_in、唤醒容器）**：见 [第 6 章 §"routeInbound 总入口"](06-routing-and-entities.md#routeinbound-总入口)。
- **下一步：router 用 `(channelType='cli', platformId='local')` 去查 `messaging_groups` 表**：见 [04 - router 解析 messaging_group](tour-single-cli-message-04-resolve-mg.md)。

## 8. 走完这一步你脑子里应该多了什么

1. **channel-registry 不做事件路由**：它只是 `Map<channelType, ChannelAdapter>`，作用是 setup 阶段挂 adapter、deliver 阶段反查 adapter。
2. **adapter → router 的桥是 `src/index.ts:90-142` 那段 closure**：host 写好一份 `ChannelSetup` callback bundle，setup 时塞给每个 adapter；adapter 持有这份 bundle 主动 push 事件。
3. **closure 在传递过程中悄悄做了两件事**：(a) 注入 `adapter.channelType`（adapter 不必自己传），(b) `JSON.stringify(message.content)`（object → string）—— 让 router 拿到一个对 DB 友好的 `InboundEvent`。
4. **错误隔离靠 wrapper 的 `.catch`**：router 抛任何错只进 log，不会冒泡到 adapter 把 socket connection 拖死。
5. **走到这一步**，"ping" 这条消息已经离开 channel 层，进入 `routeInbound(event)` 的第一行。下一步 router 开始按 `(channelType, platformId)` 查 `messaging_groups` —— 真正的业务路由从这里开始。

下一步：[Trace 步骤 04 —— router 解析 messaging_group](tour-single-cli-message-04-resolve-mg.md)
