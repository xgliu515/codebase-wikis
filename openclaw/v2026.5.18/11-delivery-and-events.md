# 第 11 章 · 消息投递与事件流

> 代码版本锁定：`openclaw/openclaw@50a2481652`（tag `v2026.5.18`，2026-05-18）
>
> 本章面向熟悉 TypeScript/Node.js 的工程师，关注 OpenClaw 在 agent 产出回复之后、文本真正抵达用户之前的那一段管线：投递层（`ReplyDispatcher`）如何把 agent 事件累积成 `ReplyPayload`、如何把 payload 推到 channel、如何生成回执（`MessageReceipt`），以及与之并行的 WebSocket 事件广播（`broadcast("agent")` / `broadcast("chat")`）。

---

## 11.0 本章要回答的问题

agent runner 跑完一轮模型推理后，会产生一串「事件」（assistant 文本增量、工具调用、工具结果、生命周期相位）。这些事件有两个完全不同的去向：

1. **投递路径（delivery path）**：把可见的文本/媒体组装成 `ReplyPayload`，经投递层节流、排队、加人性化延迟，最终调用 channel 适配器发到 Telegram / Discord / Signal 等外部平台，并拿回 `MessageReceipt`。
2. **广播路径（broadcast path）**：把同样的事件（甚至更细粒度的增量）通过 WebSocket 推给所有订阅的 Control UI / WebChat 客户端，让前端实时渲染打字效果、工具卡片。

这两条路径是**并行且解耦**的。一个发到 Telegram 群的回复同时也会出现在打开的 WebChat 里——但走的是两套完全不同的代码。本章把这两条路径都讲透，并解释为什么要这样切分。

<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="OpenClaw 投递路径与广播路径双轨架构图">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="220" y="12" width="320" height="48" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="32" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">AgentEventPayload</text>
  <text x="380" y="48" text-anchor="middle" font-size="10" fill="#64748b">{ runId, seq, stream, ts, data }</text>
  <text x="380" y="64" text-anchor="middle" font-size="10" fill="#94a3b8">agent runner 产生事件（assistant / tool / ...）</text>
  <line x1="380" y1="60" x2="380" y2="84" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="200" y1="90" x2="560" y2="90" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="200" y1="90" x2="200" y2="110" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="560" y1="90" x2="560" y2="110" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="60" y="108" width="280" height="32" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="200" y="122" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">投递路径（外部平台）</text>
  <text x="200" y="136" text-anchor="middle" font-size="10" fill="#64748b">dispatch-from-config.ts</text>
  <rect x="420" y="108" width="280" height="32" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="560" y="122" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">广播路径（WebSocket 客户端）</text>
  <text x="560" y="136" text-anchor="middle" font-size="10" fill="#64748b">server-chat.ts: 事件投影器</text>
  <line x1="200" y1="140" x2="200" y2="162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="560" y1="140" x2="560" y2="162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="60" y="162" width="280" height="44" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="200" y="179" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ReplyDispatcher</text>
  <text x="200" y="193" text-anchor="middle" font-size="10" fill="#64748b">sendBlockReply / sendFinalReply</text>
  <text x="200" y="205" text-anchor="middle" font-size="10" fill="#94a3b8">normalizeReplyPayload → 排队 → humanDelay</text>
  <rect x="420" y="162" width="280" height="44" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="560" y="179" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">broadcast("agent") / broadcast("chat")</text>
  <text x="560" y="193" text-anchor="middle" font-size="10" fill="#64748b">emitChatDelta / sendAgentPayload</text>
  <line x1="200" y1="206" x2="200" y2="228" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="560" y1="206" x2="560" y2="228" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="60" y="228" width="280" height="32" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="200" y="244" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">options.deliver(payload, {kind})</text>
  <text x="200" y="257" text-anchor="middle" font-size="10" fill="#94a3b8">投递到 channel 适配器</text>
  <rect x="420" y="228" width="280" height="32" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="560" y="244" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">createGatewayBroadcaster</text>
  <text x="560" y="257" text-anchor="middle" font-size="10" fill="#64748b">按 scope 过滤 → WS frame</text>
  <line x1="200" y1="260" x2="200" y2="282" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="560" y1="260" x2="560" y2="282" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="60" y="282" width="280" height="44" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="200" y="299" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">sendDurableMessageBatch</text>
  <text x="200" y="313" text-anchor="middle" font-size="10" fill="#64748b">render → deliver → MessageReceipt</text>
  <rect x="420" y="282" width="280" height="44" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="560" y="299" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">GatewayBrowserClient.onEvent</text>
  <text x="560" y="313" text-anchor="middle" font-size="10" fill="#64748b">handleAgentEvent / handleChatEvent</text>
  <line x1="200" y1="326" x2="200" y2="348" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="60" y="348" width="280" height="32" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="200" y="364" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">外部平台</text>
  <text x="200" y="378" text-anchor="middle" font-size="10" fill="#64748b">Telegram / Discord / Signal ...</text>
  <rect x="420" y="348" width="280" height="32" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="560" y="364" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">前端渲染</text>
  <text x="560" y="378" text-anchor="middle" font-size="10" fill="#64748b">实时打字效果 · 工具卡片</text>
  <line x1="380" y1="86" x2="200" y2="90" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="380" y1="86" x2="560" y2="90" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="380" y1="84" x2="380" y2="88" stroke="#94a3b8" stroke-width="1.2"/>
</svg>
<span class="figure-caption">图 R11.1 ｜ 投递路径与广播路径双轨架构：agent 事件从产生到落地的两条并行管线</span>

<details>
<summary>ASCII 原版</summary>

```
                         ┌──────────────────────────────────────┐
   agent runner 产生事件   │  AgentEventPayload { runId, seq,      │
   (assistant/tool/...)   │    stream, ts, data }                │
                         └───────────────┬──────────────────────┘
                                         │
                  ┌──────────────────────┴───────────────────────┐
                  │                                              │
        投递路径（外部平台）                            广播路径（WebSocket 客户端）
                  │                                              │
                  ▼                                              ▼
   dispatch-from-config.ts                          server-chat.ts: 事件投影器
     accumulate → ReplyPayload                         emitChatDelta / sendAgentPayload
                  │                                              │
                  ▼                                              ▼
   ReplyDispatcher.sendBlockReply / sendFinalReply    broadcast("agent") / broadcast("chat")
     normalizeReplyPayload → 排队 → humanDelay                    │
                  │                                              ▼
                  ▼                                   createGatewayBroadcaster
   options.deliver(payload, {kind})                     按 scope 过滤 → WS frame
                  │                                              │
                  ▼                                              ▼
   sendDurableMessageBatch                            前端 GatewayBrowserClient.onEvent
     render → deliver → MessageReceipt                   handleAgentEvent / handleChatEvent
                  │
                  ▼
   外部平台 (Telegram / Discord / ...)
```

</details>

涉及的关键文件：

| 文件 | 角色 |
| --- | --- |
| `src/auto-reply/reply/reply-dispatcher.ts` | `ReplyDispatcher` 工厂：排队、节流、人性化延迟、idle 信号 |
| `src/auto-reply/reply/reply-dispatcher.types.ts` | `ReplyDispatcher` 接口与 `ReplyDispatchKind` |
| `src/auto-reply/reply/dispatcher-registry.ts` | 全局 dispatcher 注册表，用于 gateway 重启协调 |
| `src/auto-reply/reply/reply-payloads-base.ts` | `ReplyPayload` 的线程化、可渲染性判定 |
| `src/auto-reply/reply-payload.ts` | `ReplyPayload` 类型定义 |
| `src/channels/message/send.ts` | `sendDurableMessageBatch` / `withDurableMessageSendContext` |
| `src/channels/message/receipt.ts` | `MessageReceipt` 的组装 |
| `src/channels/message/types.ts` | `MessageReceipt` / `MessageDurabilityPolicy` 类型 |
| `src/gateway/server-chat.ts` | agent 事件投影器：节流、`broadcast("agent")`、`broadcast("chat")` |
| `src/gateway/server-broadcast.ts` | `createGatewayBroadcaster`：按 scope 过滤的 WS 广播 |
| `src/gateway/protocol/schema/agent.ts` | `AgentEventSchema` / `ChatEvent` 协议 schema |

---

## 11.1 ReplyDispatcher：投递层的中枢

### 11.1.1 它解决的问题

agent runner 不会一次性产出整段回复。它会流式产出：先一段思考，再一个工具调用，工具返回结果后再继续生成文本，最后给出收尾文本。如果每产生一小段就直接调 `channelAdapter.send()`，会出现三个问题：

1. **乱序**：异步 `send()` 没有串行化，两个 block 可能并发发出、后发先至。
2. **轰炸**：连续多条短消息会让用户的手机连环震动，体验像机器人而非真人。
3. **生命周期失控**：gateway 想优雅重启时，无法知道「还有没有回复在途中」。

`ReplyDispatcher`（`src/auto-reply/reply/reply-dispatcher.ts:123` 的 `createReplyDispatcher`）就是为解决这三件事而生的。它的核心是一个 **Promise 链**：

```ts
// src/auto-reply/reply/reply-dispatcher.ts:124
let sendChain: Promise<void> = Promise.resolve();
```

每次入队一个 payload，都把投递动作 `.then()` 到这条链尾。因为 Promise 链天然串行，所以 tool / block / final 三类回复**严格按入队顺序**抵达 channel，永不乱序。

### 11.1.2 三种投递类型

`ReplyDispatchKind`（`src/auto-reply/reply/reply-dispatcher.types.ts:3`）只有三个取值：

```ts
// src/auto-reply/reply/reply-dispatcher.types.ts:3
export type ReplyDispatchKind = "tool" | "block" | "final";
```

- `tool`：工具调用/结果的中间播报（取决于 verbose 配置才会真发到 channel）。
- `block`：多段回复中的一个中间段（agent 显式 `[[block]]` 切段，或长文被切分）。
- `final`：本轮的收尾回复。

对应 `ReplyDispatcher` 暴露的三个方法（`src/auto-reply/reply/reply-dispatcher.types.ts:5`）：

```ts
export type ReplyDispatcher = {
  sendToolResult: (payload: ReplyPayload) => boolean;
  sendBlockReply: (payload: ReplyPayload) => boolean;
  sendFinalReply: (payload: ReplyPayload) => boolean;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<ReplyDispatchKind, number>;
  getCancelledCounts?: () => Record<ReplyDispatchKind, number>;
  getFailedCounts: () => Record<ReplyDispatchKind, number>;
  markComplete: () => void;
};
```

三个 `send*` 方法返回 `boolean`：`true` 表示成功入队，`false` 表示 payload 在归一化阶段被丢弃（例如 `NO_REPLY` 静默回复、空内容）。调用方需要这个返回值来决定是否触发兜底逻辑——例如 Telegram 在「agent 什么都没说」时会发一句占位文本。

`dispatch-from-config.ts` 是这三个方法的主要调用方：工具结果走 `dispatcher.sendToolResult`（`src/auto-reply/reply/dispatch-from-config.ts:1239`、`:1260`、`:1461`），中间段走 `dispatcher.sendBlockReply`（`src/auto-reply/reply/dispatch-from-config.ts:1585`），收尾走 `dispatcher.sendFinalReply`（`src/auto-reply/reply/dispatch-from-config.ts:1025`、`:1091`、`:1744`）。

### 11.1.3 入队逻辑：`enqueue`

所有三个 `send*` 方法都委托给同一个内部 `enqueue`（`src/auto-reply/reply/reply-dispatcher.ts:155`）。它做四件事：

**第一步：归一化。** 调用 `normalizeReplyPayloadInternal`（`src/auto-reply/reply/reply-dispatcher.ts:107`），它会应用回复前缀（response prefix）模板、剥离心跳标记、运行插件提供的 `transformReplyPayload`，并判定 payload 是否该被丢弃：

```ts
// src/auto-reply/reply/reply-dispatcher.ts:157
const normalized = normalizeReplyPayloadInternal(payload, {
  responsePrefix: options.responsePrefix,
  responsePrefixContext: options.responsePrefixContext,
  responsePrefixContextProvider: options.responsePrefixContextProvider,
  transformReplyPayload: options.transformReplyPayload,
  onHeartbeatStrip: options.onHeartbeatStrip,
  onSkip: (reason) => options.onSkip?.(payload, { kind, reason }),
});
if (!normalized) {
  // ...
  return false;
}
```

注意 `responsePrefixContextProvider` 是一个**惰性 provider**（`src/auto-reply/reply/reply-dispatcher.ts:67` 的注释解释了原因）：回复前缀模板可能要插值「当前模型名」，而模型选择要等到 agent run 真正开始才确定，所以这里在归一化时刻才调用 provider 取最新上下文，而不是用静态快照。

**第二步：登记计数并占位 pending。**

```ts
// src/auto-reply/reply/reply-dispatcher.ts:175
queuedCounts[kind] += 1;
pending += 1;
```

`pending` 是投递层的「在途计数」，11.1.5 详述。

**第三步：决定人性化延迟。** 只有 `block` 类型、且不是第一个 block，才加延迟：

```ts
// src/auto-reply/reply/reply-dispatcher.ts:179
const shouldDelay = kind === "block" && sentFirstBlock;
if (kind === "block") {
  sentFirstBlock = true;
}
```

**第四步：把投递动作接到 `sendChain` 链尾。**

```ts
// src/auto-reply/reply/reply-dispatcher.ts:184
sendChain = sendChain
  .then(async () => {
    if (shouldDelay) {
      const delayMs = getHumanDelay(options.humanDelay);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
    let deliverPayload: ReplyPayload | null = normalized;
    if (options.beforeDeliver) {
      deliverPayload = await options.beforeDeliver(normalized, { kind });
      if (!deliverPayload) {
        cancelledCounts[kind] += 1;
        return;
      }
    }
    await options.deliver(deliverPayload, { kind });
  })
  .catch((err) => {
    failedCounts[kind] += 1;
    options.onError?.(err, { kind });
  })
  .finally(() => {
    pending -= 1;
    // ...idle 判定
  });
```

这里有几个值得强调的设计点：

- **`beforeDeliver` 钩子**（`src/auto-reply/reply/reply-dispatcher.ts:30`）：在真正投递前的最后一道闸。它可以返回 `null` 表示「取消这一条」（计入 `cancelledCounts`），或返回一个被改写过的 payload。abort（取消）逻辑就是通过它实现的——run 被中断后，链上排队的 payload 在轮到自己时被 `beforeDeliver` 拦下。
- **`.catch` 不抛出**：单条投递失败只计入 `failedCounts` 并触发 `onError`，**不会中断 `sendChain`**。这是刻意的：第 2 条发送失败不应该让第 3、4 条永远卡住。投递层选择「尽力而为、逐条隔离失败」，可靠性兜底交给下游的 durable batch（见 11.4）。
- **`.finally` 永远执行**：无论成功失败，`pending` 都会减一，保证 idle 信号最终一定会发出。

### 11.1.4 人性化延迟

`getHumanDelay`（`src/auto-reply/reply/reply-dispatcher.ts:40`）根据 `HumanDelayConfig` 计算一个随机延迟：

```ts
// src/auto-reply/reply/reply-dispatcher.ts:40
function getHumanDelay(config: HumanDelayConfig | undefined): number {
  const mode = config?.mode ?? "off";
  if (mode === "off") {
    return 0;
  }
  const min =
    mode === "custom" ? (config?.minMs ?? DEFAULT_HUMAN_DELAY_MIN_MS) : DEFAULT_HUMAN_DELAY_MIN_MS;
  const max =
    mode === "custom" ? (config?.maxMs ?? DEFAULT_HUMAN_DELAY_MAX_MS) : DEFAULT_HUMAN_DELAY_MAX_MS;
  if (max <= min) {
    return min;
  }
  return min + generateSecureInt(max - min + 1);
}
```

默认区间是 800ms–2500ms（`src/auto-reply/reply/reply-dispatcher.ts:35`）。两个细节：

1. 用的是 `generateSecureInt`（`src/infra/secure-random.js`）而不是 `Math.random()`。对延迟而言密码学随机并非必需，但项目统一用安全随机源以避免可预测性，也避免给安全审计留下「为什么这里用了弱随机」的疑问。
2. **第一个 block 不延迟**（`sentFirstBlock` 标志）。设计意图是：用户刚发完消息，第一段回复应当尽快出现，让对话「有响应感」；后续段才模拟人类打字停顿。

为什么要人性化延迟？因为 OpenClaw 是接到真实聊天平台的助手。一个机器人在 50ms 内连发 5 条消息会非常突兀，也容易触发平台的反垃圾限速。把节奏拉到接近人类，既改善体验也降低被限流的风险。

### 11.1.5 in-flight 追踪与 idle 信号

`pending` 计数器是 dispatcher 里最微妙的一段。它初始化为 **1**，注释解释为「reservation（预约位）」：

```ts
// src/auto-reply/reply/reply-dispatcher.ts:126
// Start with pending=1 as a "reservation" to prevent premature gateway restart.
let pending = 1;
let completeCalled = false;
```

为什么需要这个预约位？考虑竞态：dispatcher 刚被创建，还没来得及 `enqueue` 第一条，此时 gateway 收到重启信号，去查「有没有 dispatcher 在忙」。如果 `pending` 初始为 0，gateway 会误判为空闲、直接重启，正在路上的回复就丢了。预约位让 dispatcher 一出生就标记为「忙」，直到调用方明确说「我不会再发了」。

调用方通过 `markComplete()`（`src/auto-reply/reply/reply-dispatcher.ts:225`）告知「本轮不会再有新回复」。`markComplete` 不立即清预约位，而是 `Promise.resolve().then(...)` 推迟到下一个微任务——给那些可能正在 `enqueue` 途中的调用一个递增 `pending` 的窗口：

```ts
// src/auto-reply/reply/reply-dispatcher.ts:225
const markComplete = () => {
  if (completeCalled) {
    return;
  }
  completeCalled = true;
  void Promise.resolve().then(() => {
    if (pending === 1 && completeCalled) {
      pending -= 1;          // 还只有预约位，没有真实回复
      if (pending === 0) {
        unregister();
        options.onIdle?.();
      }
    }
  });
};
```

而每条投递完成时，`.finally` 里也会检查：如果 `pending` 降到 1 且 `completeCalled` 为真，说明「只剩预约位了」，于是把预约位也清掉（`src/auto-reply/reply/reply-dispatcher.ts:213`）。`pending` 归零的瞬间触发两件事：从全局注册表 `unregister()`、回调 `onIdle`。

`registerDispatcher`（`src/auto-reply/reply/dispatcher-registry.ts`，在 `src/auto-reply/reply/reply-dispatcher.ts:150` 调用）把 dispatcher 登记到一个全局注册表，暴露 `pending()` 和 `waitForIdle()`。gateway 优雅关闭时遍历这个注册表，等所有 dispatcher idle 后再退出——这就是「投递层参与生命周期协调」的具体落地。

### 11.1.6 带打字指示器的变体

`createReplyDispatcherWithTyping`（`src/auto-reply/reply/reply-dispatcher.ts:257`）在普通 dispatcher 外面包了一层，把 dispatcher 的生命周期事件接到 `TypingController`：

```ts
// src/auto-reply/reply/reply-dispatcher.ts:265
const dispatcher = createReplyDispatcher({
  ...dispatcherOptions,
  onIdle: () => {
    typingController?.markDispatchIdle();
    resolvedOnIdle?.();
  },
});
```

它返回的不只是 dispatcher，还有 `replyOptions`（`onReplyStart` / `onTypingController` / `onTypingCleanup`，传给 agent runner）、`markDispatchIdle`、`markRunComplete`。

打字指示器（Telegram 的「正在输入…」气泡、Discord 的 typing 状态）的生命周期由 `TypingController`（`src/auto-reply/reply/typing.ts:17`）管理：

- agent run 一开始，`onReplyStart` 触发，typing 气泡亮起。
- `markRunComplete()`（`src/auto-reply/reply/typing.ts:219`）告诉 controller「模型推理结束了」。
- `markDispatchIdle()`（`src/auto-reply/reply/typing.ts:232`）告诉 controller「所有回复也都投递完了」。
- 只有这两个信号都到齐，typing 气泡才熄灭。

为什么要拆成两个信号？因为「模型推理完成」和「回复投递完成」之间有时间差——人性化延迟、durable 重试都会让最后一条 payload 在模型早就停了之后才抵达。如果只看模型完成就熄灭气泡，用户会看到「停止输入」后又突然蹦出一条消息，很怪。两个信号都到齐才熄灭，气泡才会一直亮到最后一个字真正发出去。

`createTypingCallbacks`（`src/channels/typing.ts:23`）是 channel 侧提供这套回调的工厂，每个 channel 适配器据此把抽象的 `onReplyStart` / `onIdle` / `onCleanup` 映射到自己平台的 typing API。

---

## 11.2 ReplyPayload 的组装

### 11.2.1 ReplyPayload 的形状

`ReplyPayload`（`src/auto-reply/reply-payload.ts:7`）是投递层的通用货币——一个 channel 无关的回复单元：

```ts
// src/auto-reply/reply-payload.ts:7
export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  trustedLocalMedia?: boolean;
  sensitiveMedia?: boolean;
  presentation?: MessagePresentation;
  delivery?: ReplyPayloadDelivery;
  interactive?: InteractiveReply;          // @deprecated，迁移期遗留
  btw?: { question: string };
  replyToId?: string;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
  audioAsVoice?: boolean;
  spokenText?: string;
  ttsSupplement?: ReplyPayloadTtsSupplement;
  isError?: boolean;
  isReasoning?: boolean;
  isCompactionNotice?: boolean;
  isFallbackNotice?: boolean;
  channelData?: Record<string, unknown>;
};
```

它**故意**保持 channel 无关：`presentation` 描述「想要的富展示」，由 channel 渲染器去 map 或降级；`channelData` 才是逐 channel 的逃生舱口。`isReasoning` / `isCompactionNotice` / `isFallbackNotice` 这些布尔位让下游能精准地决定「这条要不要进 TTS 转写」「web 端要不要显示」——例如 `isReasoning` 的 payload 在没有专门 reasoning 通道的 channel（WhatsApp、web）上会被抑制（见 `shouldSuppressReasoningPayload`，`src/auto-reply/reply/reply-payloads-base.ts:86`）。

### 11.2.2 从 agent 事件累积到 payload

OpenClaw **没有一个名叫 `finalizeReply` 的函数**——回复的累积逻辑分散在 `dispatch-from-config.ts`（`src/auto-reply/reply/dispatch-from-config.ts`）里。整体流程是：

1. agent runner 流式吐出 `AgentEventPayload`，其中 `stream === "assistant"` 的事件携带 `data.text`（截至目前累积的全文）和 `data.delta`（本次增量）。
2. `dispatch-from-config.ts` 监听这些事件，按 agent 显式的切段标记（`[[block]]`）或长度阈值把累积文本切成若干段。
3. 每切出一段就构造一个 `ReplyPayload`，调用 `dispatcher.sendBlockReply(payload)`。
4. 本轮结束时，把剩余累积文本构造成最终 `ReplyPayload`，调用 `dispatcher.sendFinalReply(payload)`（`src/auto-reply/reply/dispatch-from-config.ts:1025`、`:1091`）。
5. 调用 `dispatcher.markComplete()` 收尾。

工具调用同理：agent 吐出 `stream === "tool"` 的事件，`dispatch-from-config.ts` 把工具名、参数、结果整理成播报文本的 `ReplyPayload`，走 `dispatcher.sendToolResult`（`src/auto-reply/reply/dispatch-from-config.ts:1239` 等）。

### 11.2.3 投递前的归一化

payload 在被 `enqueue` 后、真正 `deliver` 前还要过几道处理（这些都属于「组装的尾声」）：

**回复线程化（threading）。** `applyReplyThreading`（`src/auto-reply/reply/reply-payloads-base.ts:90`）决定回复要不要「引用/回复」原消息：

```ts
// src/auto-reply/reply/reply-payloads-base.ts:90
export function applyReplyThreading(params: {
  payloads: ReplyPayload[];
  replyToMode: ReplyToMode;
  replyToChannel?: OriginatingChannelType;
  currentMessageId?: string;
  replyThreading?: ReplyThreadingPolicy;
}): ReplyPayload[] {
  const { payloads, replyToMode, replyToChannel, currentMessageId, replyThreading } = params;
  const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const implicitReplyToId = normalizeOptionalString(currentMessageId);
  return payloads
    .map((payload) => resolveReplyThreadingForPayload({ /* ... */ }))
    .filter(isRenderablePayload)
    .map(applyReplyToMode);
}
```

`replyToMode` 有四档：`off` / `first` / `all` / `batched`（见 `src/gateway/protocol/schema/agent.ts:61` 的 `MessageActionToolContextSchema`）。`first` 只让第一条回复引用原消息，`all` 让每条都引用。agent 还能在文本里写 `[[reply_to:<id>]]` 标记，`extractReplyToTag`（`src/auto-reply/reply/reply-payloads-base.ts:52`）会把它解析出来并从可见文本里剥掉。

**可渲染性过滤。** `isRenderablePayload`（`src/auto-reply/reply/reply-payloads-base.ts:82`）判定 payload 是否有任何可见内容；`shouldSuppressReasoningPayload`（`:86`）判定 reasoning 块是否该被某 channel 抑制。空 payload 在 `applyReplyThreading` 的 `.filter` 里就被剔除，不会浪费一次外发。

**BTW 问题前缀。** `formatBtwTextForExternalDelivery`（`src/auto-reply/reply/reply-payloads-base.ts:13`）：当 payload 带 `btw.question` 时，把问题以 `BTW\nQuestion: ...` 形式拼到文本前。

至此 payload 才进入 `options.deliver`。

---

## 11.3 投递到 channel

### 11.3.1 deliver 回调的去向

`ReplyDispatcher` 本身不认识任何 channel——它只调 `options.deliver(payload, { kind })`。`deliver` 是创建 dispatcher 时由 `dispatch-from-config.ts` 注入的闭包（`src/auto-reply/reply/dispatch-from-config.ts:703` 一带能看到它如何根据 kind 路由）。这个 `deliver` 闭包最终会落到 `sendDurableMessageBatch`。

这是一个经典的依赖倒置：dispatcher 负责「排队/节流/生命周期」这些与平台无关的事，把「真正怎么发」交给注入的回调。换 channel 不用改 dispatcher 一行代码。

> 注意：仓库里并没有一个叫 `sendChannelMessage` 的导出函数。投递到 channel 的实际入口是 `src/channels/message/send.ts` 的 `sendDurableMessageBatch`，本节按它来讲。

### 11.3.2 sendDurableMessageBatch

`sendDurableMessageBatch`（`src/channels/message/send.ts:336`）是一个极薄的封装：

```ts
// src/channels/message/send.ts:336
export async function sendDurableMessageBatch(
  params: DurableMessageSendContextParams,
): Promise<DurableMessageBatchSendResult> {
  return await withDurableMessageSendContext(params, async (ctx) => {
    const rendered = await ctx.render();
    const result = await ctx.send(rendered);
    if (result.status === "sent" || result.status === "suppressed") {
      await ctx.commit(result.receipt);
    } else {
      await ctx.fail(result.error);
    }
    return result;
  });
}
```

三步走：`render`（把 `ReplyPayload[]` 渲成 `RenderedMessageBatch`）→ `send`（真正外发）→ 根据结果 `commit` 或 `fail`。

`withDurableMessageSendContext`（`src/channels/message/send.ts:155`）构造出 `ctx`。最核心的是 `ctx.send`（`src/channels/message/send.ts:198`），它调用 `deliverOutboundPayloadsInternal`（`src/infra/outbound/deliver.js`）做真正的平台外发，然后把结果汇成回执：

```ts
// src/channels/message/send.ts:218
const receipt = createMessageReceiptFromOutboundResults({
  results,
  threadId: params.threadId == null ? undefined : String(params.threadId),
  replyToId: params.replyToId ?? undefined,
});
```

### 11.3.3 渲染计划 RenderedMessageBatch

`ctx.render()`（`src/channels/message/send.ts:189`）调用 `createRenderedMessageBatch(payloads)`。`RenderedMessageBatch`（`src/channels/message/types.ts:104`）由 `payloads` 加一份 `RenderedMessageBatchPlan` 组成，`plan`（`src/channels/message/types.ts:93`）里逐条标注了每个 payload 是文本/媒体/语音/富展示，以及统计计数。下游的平台适配器据此决定该用 `sendMessage` 还是 `sendPhoto` 还是 `sendVoice`。

`RenderedMessageBatchPlanKind`（`src/channels/message/types.ts:73`）枚举了所有种类：`text` / `media` / `voice` / `presentation` / `interactive` / `channelData` / `empty`。

---

## 11.4 MessageReceipt：投递回执

### 11.4.1 为什么需要回执

把消息发到平台只是开始。如果 agent 后续想编辑或删除这条消息（比如先发「正在生成…」再改成最终结果，或者发现说错了要撤回），就必须记住「这条消息在平台上的 ID 是什么」。`MessageReceipt` 就是这份记忆。

### 11.4.2 MessageReceipt 的形状

```ts
// src/channels/message/types.ts:61
export type MessageReceipt = {
  primaryPlatformMessageId?: string;
  platformMessageIds: string[];
  parts: MessageReceiptPart[];
  threadId?: string;
  replyToId?: string;
  editToken?: string;
  deleteToken?: string;
  sentAt: number;
  raw?: readonly MessageReceiptSourceResult[];
};
```

每个 `MessageReceiptPart`（`src/channels/message/types.ts:52`）记录一条平台消息的 ID、种类（`text` / `media` / `voice` / `card` / `preview` / `unknown`）、在 batch 中的序号，以及可选的 `threadId` / `replyToId`：

```ts
// src/channels/message/types.ts:52
export type MessageReceiptPart = {
  platformMessageId: string;
  kind: MessageReceiptPartKind;
  index: number;
  threadId?: string;
  replyToId?: string;
  raw?: MessageReceiptSourceResult;
};
```

为什么 `platformMessageIds` 是数组而不是单值？因为一个 `ReplyPayload` 批次可能在平台上变成多条消息——长文被切分、文本加图片各算一条。`parts` 保留逐条结构，`platformMessageIds` 是去重后的扁平 ID 列表，`primaryPlatformMessageId` 是「主」消息（通常是第一条文本），编辑/删除时优先操作它。

### 11.4.3 回执的组装

`createMessageReceiptFromOutboundResults`（`src/channels/message/receipt.ts:39`）把平台返回的原始结果转成 `MessageReceipt`。它要应对的复杂性在于：不同平台返回的 ID 字段名各异。`resolveReceiptMessageId`（`src/channels/message/receipt.ts:11`）就是一张「字段名兼容表」：

```ts
// src/channels/message/receipt.ts:11
function resolveReceiptMessageId(result: MessageReceiptInputResult): string | undefined {
  return (
    result.messageId ||
    result.chatId ||
    result.channelId ||
    result.roomId ||
    result.conversationId ||
    result.toJid ||
    result.pollId
  );
}
```

Telegram 用 `messageId`，WhatsApp 用 `toJid`，投票用 `pollId`——这里用一串 `||` 把它们统一成一个抽象的 platform message id。

如果某个平台适配器自己已经构造了嵌套的 `receipt`，`hasNestedReceiptData`（`src/channels/message/receipt.ts:23`）会检测到并直接展平它的 `parts` / `platformMessageIds`，而不是再走字段猜测。`appendUnique`（`src/channels/message/receipt.ts:32`）保证 ID 列表去重。

两个便捷读取器：`listMessageReceiptPlatformIds`（`src/channels/message/receipt.ts:110`）返回去重的 ID 列表，`resolveMessageReceiptPrimaryId`（`src/channels/message/receipt.ts:116`）返回主 ID（优先 `primaryPlatformMessageId`，否则取列表首个）。

### 11.4.4 回执驱动的编辑/删除

`withDurableMessageSendContext` 的 `ctx` 还暴露 `edit` 和 `delete`（`src/channels/message/send.ts:294`、`:307`）：

```ts
// src/channels/message/send.ts:294
edit: async (receipt, rendered): Promise<MessageReceipt> => {
  if (!onEditReceipt) {
    throw new Error("message send context edit is not configured");
  }
  const editedReceipt = await onEditReceipt(receipt, rendered);
  liveState = { ...liveState, receipt: editedReceipt, lastRendered: rendered };
  ctx.preview = liveState;
  return editedReceipt;
},
```

`edit` 拿着旧 `receipt`（里面有 `platformMessageId`）和新 `rendered` 内容去平台改那条消息，并返回更新后的回执。`delete` 同理。这正是「draft preview / 流式编辑」能力的基础：先发一条占位消息拿到 receipt，随着 agent 流式产出不断 `edit` 它，最终定稿——`LiveMessageState`（`src/channels/message/types.ts:109`，相位 `idle` / `previewing` / `finalizing` / `finalized` / `cancelled`）就是这套流式编辑的状态机。

---

## 11.5 错误处理、durability 与重试

### 11.5.1 durability 三档策略

`MessageDurabilityPolicy`（`src/channels/message/types.ts:7`）有三个取值：

```ts
// src/channels/message/types.ts:7
export type MessageDurabilityPolicy = "required" | "best_effort" | "disabled";
```

- `required`：必须送达。失败会进持久化重试队列。
- `best_effort`：尽力而为。失败就失败，不重试。
- `disabled`：完全不走 durable 路径。

`withDurableMessageSendContext` 把它映射成下游的 `queuePolicy`：

```ts
// src/channels/message/send.ts:177
const queuePolicy = durability === "best_effort" ? "best_effort" : "required";
```

`toDurableMessageIntent`（`src/channels/message/send.ts:108`）则把 intent 的 `queuePolicy` 反向映射回 `durability` 字段。`required` 对应的是「写入持久队列、进程重启后仍会重投」，`best_effort` 对应「只在内存里试一次」。

### 11.5.2 send 的结果分类

`ctx.send` 的返回类型 `DurableMessageBatchSendResult`（`src/channels/message/send.ts:72`）是一个四态联合：

| status | 含义 |
| --- | --- |
| `sent` | 全部成功，带 `results` + `receipt` |
| `suppressed` | 没有可见内容被发出（hook 取消、payload 为空），带 `reason` |
| `partial_failed` | 发了一部分后失败，`sentBeforeError: true`，带已发出的 `results` + `receipt` |
| `failed` | 完全失败，带 `error` + `stage` |

`partial_failed` 是这里最重要的一态。`ctx.send`（`src/channels/message/send.ts:198`）在收集 `payloadOutcomes` 后判定：

```ts
// src/channels/message/send.ts:223
const failedOutcome = payloadOutcomes.find((outcome) => outcome.status === "failed");
if (failedOutcome) {
  if (results.length > 0) {
    return { status: "partial_failed", results, receipt, error: failedOutcome.error,
             sentBeforeError: true, /* ... */ };
  }
  return { status: "failed", error: failedOutcome.error, stage: failedOutcome.stage, /* ... */ };
}
```

为什么 `partial_failed` 要单独成一态、而且还带 `receipt`？因为「3 条里发出了 2 条」绝不能当成「完全失败」去整批重投——那会让前 2 条重复发送。带上 `receipt` 让上层能记住「这 2 条已经在平台上了」，重试只针对没发出去的那条。这是投递层「不重复发送」承诺的核心。

`DurableMessageFailureStage`（`src/channels/message/send.ts:47`）标注失败发生在哪一阶段：`platform_send`（平台拒收）/ `queue`（入队失败）/ `unknown`。重试策略据此区分——`platform_send` 失败可能是限流，值得退避重试；`queue` 失败可能是磁盘满，重试无意义。

`DurableMessageSuppressionReason`（`src/channels/message/send.ts:40`）则枚举了「为什么没发」：被 message-sending hook 取消、hook 处理后变空、没有可见 payload、适配器没返回身份、没有可见结果。

### 11.5.3 异常路径与 OutboundDeliveryError

`ctx.send` 用 `try/catch` 包住 `deliverOutboundPayloadsInternal`。如果抛出的是 `OutboundDeliveryError`（`isOutboundDeliveryError`，`src/channels/message/send.ts:263`），catch 块会检查 `error.results`——如果错误对象里仍带着已成功发出的结果，同样降级为 `partial_failed` 并附回执：

```ts
// src/channels/message/send.ts:262
} catch (error: unknown) {
  if (isOutboundDeliveryError(error)) {
    if (error.results.length > 0) {
      const receipt = createMessageReceiptFromOutboundResults({ results: error.results, /* ... */ });
      return { status: "partial_failed", results: error.results, receipt, error,
               sentBeforeError: true, /* ... */ };
    }
    return { status: "failed", error, stage: error.stage, /* ... */ };
  }
  return { status: "failed", error };
}
```

即「抛异常」和「返回 failed status」在这里被统一对待——异常只是另一种表达失败的方式，都要尽量保留「已发出部分」的信息。

### 11.5.4 失败清理：ctx.fail

`ctx.fail`（`src/channels/message/send.ts:316`）在投递失败时调 `onSendFailure`。注意它对清理逻辑自身的失败做了吞咽处理：

```ts
// src/channels/message/send.ts:316
fail: async (error) => {
  try {
    await onSendFailure?.(error);
  } catch (cleanupError: unknown) {
    log.warn(
      `message send failure cleanup failed; preserving original send error: ${formatErrorMessage(cleanupError)}`,
    );
  }
},
```

设计意图明确写在日志里：「保留原始 send 错误」。清理动作（比如撤回半截消息）失败了不能掩盖根因——用户最需要知道的是「为什么没发出去」，而不是「清理时又出了什么岔子」。

### 11.5.5 dispatcher 层的错误隔离

回到 dispatcher 这一层（11.1.3 已提过）：`sendChain` 的 `.catch` 只把失败计入 `failedCounts` 并触发 `onError`，不传播。所以 durable batch 的 `failed` / `partial_failed` 结果若被 `deliver` 闭包转成异常抛出，会被 dispatcher 的 `.catch` 接住，**第 N 条失败不影响第 N+1 条**。

两层错误处理的分工很清晰：

- **durable batch 层**关心「这一批怎么尽量送达、怎么记住已发出部分、怎么重试」。
- **dispatcher 层**关心「一条失败不要拖垮整条回复链、idle 信号一定要发出」。

`getFailedCounts()` / `getCancelledCounts()` / `getQueuedCounts()` 让调用方在 run 结束后能拿到投递统计，用于诊断和遥测。

---

## 11.6 agent 事件广播：WebSocket 路径

### 11.6.1 两类广播事件

投递路径之外的另一条线，是把事件推给 WebSocket 客户端。OpenClaw **没有** `chat_message_text` / `chat_tool_call` 这种事件名——实际的广播事件只有两个顶层名字，区别在 payload 内部字段：

| 广播事件名 | 用途 | 关键字段 |
| --- | --- | --- |
| `"agent"` | 细粒度 agent 事件流（增量文本、工具相位、生命周期） | `stream`、`seq`、`data` |
| `"chat"` | 面向 WebChat 的高层对话状态（delta / final / error / aborted） | `state`、`message` |

`"agent"` 事件的 schema 是 `AgentEventSchema`（`src/gateway/protocol/schema/agent.ts:41`）：

```ts
// src/gateway/protocol/schema/agent.ts:41
export const AgentEventSchema = Type.Object(
  {
    runId: NonEmptyString,
    seq: Type.Integer({ minimum: 0 }),
    stream: NonEmptyString,
    ts: Type.Integer({ minimum: 0 }),
    spawnedBy: Type.Optional(NonEmptyString),
    isHeartbeat: Type.Optional(Type.Boolean()),
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
```

`stream` 字段才是真正的「事件类型」。在 `server-chat.ts` 里能看到它的取值：`"assistant"`（助手文本，`src/gateway/server-chat.ts:697`）、`"thinking"`（思考，`:700`）、`"tool"`（工具，`:839`）、`"item"`（结构化条目，`:840`）、`"lifecycle"`（生命周期，`:807`）、`"compaction"`、`"fallback"`、`"error"`。

工具事件的 `data.phase` 又细分为 `"start"` / `"update"` / `"result"`——这就是任务描述里 `chat_tool_call` / `chat_tool_result` 在本代码库的真实对应：它们不是独立事件名，而是 `stream === "tool"` 加上不同 `data.phase`。同理 `chat_done` 对应的是 `stream === "lifecycle"` 且 `data.phase === "end"`。

### 11.6.2 事件投影器：server-chat.ts

`server-chat.ts` 返回的那个函数（从 `src/gateway/server-chat.ts:805` 开始的 `return (evt: AgentEventPayload) => { ... }`）是 agent 事件的**投影器**：每个从 agent runner 出来的事件都流经它，由它决定推给谁、推什么、怎么节流。

主要决策点：

**runId 重映射。** 客户端发起 `chat.send` 时用的是客户端生成的 UUID（`clientRunId`），而引擎内部用自己的 `runId`。投影器通过 `chatRunState.registry` 把两者关联，对外的事件统一改写成 `clientRunId`：

```ts
// src/gateway/server-chat.ts:820
const clientRunId = chatLink?.clientRunId ?? evt.runId;
const eventRunId = chatLink?.clientRunId ?? evt.runId;
const eventForClients = chatLink ? { ...evt, runId: eventRunId } : evt;
```

**seq gap 检测。** 每个 run 的事件带单调递增的 `seq`。投影器记录 `agentRunSeq`，发现跳号就广播一个 `stream: "error"` 的事件告知客户端「丢事件了」：

```ts
// src/gateway/server-chat.ts:856
if (last > 0 && evt.seq !== last + 1 && isControlUiVisible) {
  flushBufferedAgentDeltaIfNeeded(clientRunId);
  broadcast("agent", {
    runId: eventRunId, stream: "error", ts: Date.now(), sessionKey,
    data: { reason: "seq gap", expected: last + 1, received: evt.seq },
  });
}
```

**verbose 裁剪。** 工具事件对「频道订阅者」（Telegram、Discord 等）按 `verboseLevel` 裁剪——非 `full` 时把 `data.result` / `data.partialResult` 删掉（`src/gateway/server-chat.ts:847`），避免把大段工具输出灌进聊天频道。但对已认证的 Control UI，工具结果照发，因为前端要渲染工具卡片。

### 11.6.3 文本增量节流

逐 token 广播会把 WebSocket 打爆。投影器对 `assistant` / `thinking` 两路文本做 150ms 节流。

`server-chat.ts` 侧的 `sendOrBufferAgentTextEvent`（`src/gateway/server-chat.ts:751`）：

```ts
// src/gateway/server-chat.ts:761
const now = Date.now();
const key = agentTextThrottleKey(clientRunId, stream);
const last = chatRunState.agentDeltaSentAt.get(key);
if (last !== undefined && now - last < 150) {
  // 距上次广播不足 150ms：缓冲，并把增量 delta 合并进去
  const nextBuffered = buildBufferedAgentEvent(sessionKey, payload);
  const buffered = chatRunState.bufferedAgentEvents.get(key);
  chatRunState.bufferedAgentEvents.set(
    key, buffered ? mergeBufferedAgentPayload(buffered, nextBuffered) : nextBuffered,
  );
  return;
}
flushBufferedAgentDeltaIfNeeded(clientRunId);
sendAgentPayload(sessionKey, payload);
chatRunState.agentDeltaSentAt.set(key, now);
```

`mergeBufferedAgentPayload`（`src/gateway/server-chat.ts:727`）在缓冲多个增量时把它们的 `delta` 字符串拼接合并——节流不是丢弃数据，而是攒批。

节流也带来一个隐患：最后一个增量可能正卡在缓冲里没发。所以工具事件 `start` 相位前会强制 flush（`flushBufferedChatDeltaIfNeeded` / `flushBufferedAgentDeltaIfNeeded`，`src/gateway/server-chat.ts:884`），让客户端在工具卡片出现前先看到完整的「工具前文本」；`emitChatFinal`（`src/gateway/server-chat.ts:602`）在收尾时也会先 flush 再发 final：

```ts
// src/gateway/server-chat.ts:619
flushBufferedChatDeltaIfNeeded(sessionKey, clientRunId, sourceRunId, seq);
```

### 11.6.4 chat 事件：emitChatFinal

`"chat"` 事件是给 WebChat 的高层视图。`emitChatFinal`（`src/gateway/server-chat.ts:602`）在 run 结束时发出 `state: "final"` 或 `state: "error"`：

```ts
// src/gateway/server-chat.ts:627
if (jobState === "done") {
  const payload = {
    runId: clientRunId, sessionKey, seq,
    state: "final" as const,
    ...(stopReason && { stopReason }),
    message:
      text && !shouldSuppressSilent
        ? { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() }
        : undefined,
  };
  broadcast("chat", payload);
  nodeSendToSession(sessionKey, "chat", payload);
  return;
}
```

`state` 字段的取值（在 `chat-abort.ts` 与 `server-chat.ts` 一致使用）：`"delta"`（增量）/ `"final"`（收尾）/ `"error"`（出错）/ `"aborted"`（被中断）。

注意每次 `broadcast("chat", payload)` 之后都跟一个 `nodeSendToSession(sessionKey, "chat", payload)`——前者推给 WebSocket 客户端，后者推给绑定到该 session 的 node（语音设备等）。两个分发目标，一份 payload。

### 11.6.5 createGatewayBroadcaster 与 scope 过滤

真正把 frame 写进 socket 的是 `createGatewayBroadcaster`（`src/gateway/server-broadcast.ts:95`）。它返回 `broadcast` 和 `broadcastToConnIds` 两个函数：前者发给所有有权限的客户端，后者只发给指定 connId 集合。

最关键的安全机制是 `hasEventScope`（`src/gateway/server-broadcast.ts:62`）。`EVENT_SCOPE_GUARDS`（`src/gateway/server-broadcast.ts:21`）声明了每个事件需要的 scope：

```ts
// src/gateway/server-broadcast.ts:21
const EVENT_SCOPE_GUARDS: Record<string, string[]> = {
  agent: [READ_SCOPE],
  chat: [READ_SCOPE],
  "chat.side_result": [READ_SCOPE],
  // ...
  "exec.approval.requested": [APPROVALS_SCOPE],
  "device.pair.requested": [PAIRING_SCOPE],
  // ...
};
```

`agent` 和 `chat` 都要 `READ_SCOPE`。文件顶部的注释（`src/gateway/server-broadcast.ts:18`）解释了为什么：聊天记录属于 operator 级敏感数据，pairing-scope 的握手连接、node-role 连接绝不能被动收到聊天广播。`hasEventScope` 还对 `node` 角色开了一个白名单 `NODE_ALLOWED_EVENTS`（`src/gateway/server-broadcast.ts:53`），只放行 voicewake 相关事件。

### 11.6.6 慢消费者保护与 frame 拼装

`broadcastInternal`（`src/gateway/server-broadcast.ts:99`）逐客户端发送时检查 `bufferedAmount`：

```ts
// src/gateway/server-broadcast.ts:152
const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
// ...
if (slow && opts?.dropIfSlow) {
  // ... 跳过这一帧
  continue;
}
if (slow) {
  try { c.socket.close(1008, "slow consumer"); } catch { /* ignore */ }
  continue;
}
```

如果某客户端的发送缓冲超过 `MAX_BUFFERED_BYTES`（`src/gateway/server-constants.ts`），且事件标了 `dropIfSlow`，就跳过这一帧（比如 typing 这种可丢的事件）；否则直接以 `1008 slow consumer` 关闭连接。这保证一个卡住的客户端不会把 gateway 的内存拖垮。

frame 的 JSON 是手工拼字符串而非 `JSON.stringify` 整个对象——`getFrameBase`（`src/gateway/server-broadcast.ts:131`）只对 `payload` 和 `stateVersion` 各序列化一次，然后在循环里复用，只有 `seq` 是逐客户端不同的：

```ts
// src/gateway/server-broadcast.ts:185
const frame = `{"type":"event","event":${base.eventJSON}${base.payloadFragment}${seqFragment}${base.stateVersionFragment}}`;
c.socket.send(frame);
```

为什么这么抠？因为同一个事件要广播给几十上百个连接。对每个连接都 `JSON.stringify` 一遍完整对象是 O(N×payload) 的浪费；这里把不变部分序列化一次、只逐连接拼一个小小的 `seq` 片段，降到 O(payload + N)。这是一个被广播放大的热路径，值得这点不优雅。

---

## 11.7 多 channel 并行投递

一个 agent run 的回复可能要同时投到多个目的地——比如配置了「同一条回复既发原频道又抄送一个监控群」，或者一个 group 绑定了多个 channel。

并行性体现在**多个 `ReplyDispatcher` 实例**：每个投递目标拥有自己独立的 dispatcher。因为 dispatcher 的 `sendChain` 是实例级的，目标 A 的串行链和目标 B 的串行链互不阻塞——A 在等人性化延迟时，B 可以照常推进。「同一目标内严格有序、不同目标间完全并行」由此自然成立。

`dispatcher-registry.ts`（`src/auto-reply/reply/dispatcher-registry.ts`）正是为多实例而生的全局协调点。每个 dispatcher 创建时 `registerDispatcher`（`src/auto-reply/reply/reply-dispatcher.ts:150`）登记自己，idle 时 `unregister`。gateway 优雅关闭时遍历整个注册表，对每个还在忙的 dispatcher 调 `waitForIdle()`——只有当**所有**目标的所有回复都投递完，gateway 才退出。否则就会出现「重启时把 3 个群里各自正发到一半的回复全丢了」。

在 WebSocket 广播侧，「并行」是另一种含义：一次 `broadcast("agent", payload)` 把同一份 payload 扇出给所有订阅连接（11.6.6 的循环），它们各自独立接收、互不影响——某个慢客户端被 `1008` 踢掉，不影响其余客户端继续收事件。

---

## 11.8 一次完整投递的时序

把本章串起来，跟踪一条 final 回复从产生到落地：

<svg viewBox="0 0 760 580" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="OpenClaw 一次完整投递时序图，从 agent 事件产生到消息落地的 9 个步骤">
  <defs>
    <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#0d9488"/>
    </marker>
  </defs>
  <line x1="60" y1="30" x2="60" y2="560" stroke="#cbd5e1" stroke-width="1.5"/>
  <circle cx="60" cy="44" r="11" fill="#ea580c"/>
  <text x="60" y="48" text-anchor="middle" font-size="10" font-weight="700" fill="white">1</text>
  <rect x="82" y="30" width="380" height="30" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="272" y="45" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">agent runner 流式产出 AgentEventPayload</text>
  <text x="272" y="58" text-anchor="middle" font-size="10" fill="#64748b">stream="assistant", data.text=...</text>
  <line x1="460" y1="44" x2="600" y2="44" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar3)"/>
  <rect x="600" y="28" width="148" height="32" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="674" y="41" text-anchor="middle" font-size="10" font-weight="600" fill="#0d9488">[广播路径]</text>
  <text x="674" y="53" text-anchor="middle" font-size="9" fill="#64748b">server-chat.ts 投影器</text>
  <line x1="60" y1="60" x2="60" y2="82" stroke="#cbd5e1" stroke-width="1.5"/>
  <line x1="60" y1="82" x2="462" y2="82" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <rect x="462" y="68" width="286" height="42" rx="4" fill="#f1f5f9" stroke="#0d9488" stroke-width="1"/>
  <text x="605" y="84" text-anchor="middle" font-size="10" fill="#0d9488">sendOrBufferAgentTextEvent → 150ms 节流</text>
  <text x="605" y="96" text-anchor="middle" font-size="10" fill="#0d9488">broadcast("agent") → WS frame → handleAgentEvent</text>
  <line x1="60" y1="82" x2="60" y2="118" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="75" y="112" font-size="10" fill="#64748b">[投递路径] dispatch-from-config.ts 累积文本</text>
  <circle cx="60" cy="132" r="11" fill="#ea580c"/>
  <text x="60" y="136" text-anchor="middle" font-size="10" font-weight="700" fill="white">2</text>
  <rect x="82" y="118" width="420" height="30" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="292" y="133" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">本轮结束 → dispatcher.sendFinalReply(payload)</text>
  <text x="292" y="146" text-anchor="middle" font-size="10" fill="#94a3b8">返回 true</text>
  <line x1="60" y1="148" x2="60" y2="168" stroke="#cbd5e1" stroke-width="1.5" marker-end="url(#ar2)"/>
  <circle cx="60" cy="182" r="11" fill="#ea580c"/>
  <text x="60" y="186" text-anchor="middle" font-size="10" font-weight="700" fill="white">3</text>
  <rect x="82" y="168" width="420" height="30" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="292" y="183" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">enqueue(): normalizeReplyPayload</text>
  <text x="292" y="196" text-anchor="middle" font-size="10" fill="#64748b">前缀 / 线程化 / transform　　pending += 1, queuedCounts.final += 1</text>
  <line x1="60" y1="198" x2="60" y2="218" stroke="#cbd5e1" stroke-width="1.5" marker-end="url(#ar2)"/>
  <circle cx="60" cy="232" r="11" fill="#ea580c"/>
  <text x="60" y="236" text-anchor="middle" font-size="10" font-weight="700" fill="white">4</text>
  <rect x="82" y="218" width="420" height="44" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="292" y="234" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">接到 sendChain 链尾（final 不加人性化延迟）</text>
  <text x="292" y="248" text-anchor="middle" font-size="10" fill="#64748b">→ beforeDeliver 钩子（abort 检查）</text>
  <text x="292" y="260" text-anchor="middle" font-size="10" fill="#64748b">→ options.deliver(payload, {kind:"final"})</text>
  <line x1="60" y1="262" x2="60" y2="282" stroke="#cbd5e1" stroke-width="1.5" marker-end="url(#ar2)"/>
  <circle cx="60" cy="296" r="11" fill="#ea580c"/>
  <text x="60" y="300" text-anchor="middle" font-size="10" font-weight="700" fill="white">5</text>
  <rect x="82" y="282" width="420" height="44" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="292" y="298" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">sendDurableMessageBatch</text>
  <text x="292" y="312" text-anchor="middle" font-size="10" fill="#64748b">ctx.render() → RenderedMessageBatch</text>
  <text x="292" y="324" text-anchor="middle" font-size="10" fill="#64748b">ctx.send() → 外部平台　　createMessageReceiptFromOutboundResults → MessageReceipt</text>
  <line x1="60" y1="326" x2="60" y2="346" stroke="#cbd5e1" stroke-width="1.5" marker-end="url(#ar2)"/>
  <circle cx="60" cy="360" r="11" fill="#7c3aed"/>
  <text x="60" y="364" text-anchor="middle" font-size="10" font-weight="700" fill="white">6</text>
  <rect x="82" y="346" width="420" height="28" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="292" y="361" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">result.status === "sent" → ctx.commit(receipt)</text>
  <text x="292" y="374" text-anchor="middle" font-size="10" fill="#94a3b8">消息已落地</text>
  <line x1="60" y1="374" x2="60" y2="394" stroke="#cbd5e1" stroke-width="1.5" marker-end="url(#ar2)"/>
  <circle cx="60" cy="408" r="11" fill="#ea580c"/>
  <text x="60" y="412" text-anchor="middle" font-size="10" font-weight="700" fill="white">7</text>
  <rect x="82" y="394" width="280" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="222" y="410" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">.finally: pending -= 1</text>
  <line x1="60" y1="422" x2="60" y2="442" stroke="#cbd5e1" stroke-width="1.5" marker-end="url(#ar2)"/>
  <circle cx="60" cy="456" r="11" fill="#ea580c"/>
  <text x="60" y="460" text-anchor="middle" font-size="10" font-weight="700" fill="white">8</text>
  <rect x="82" y="442" width="420" height="42" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="292" y="458" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">dispatcher.markComplete() → pending 归零</text>
  <text x="292" y="472" text-anchor="middle" font-size="10" fill="#64748b">unregister() + onIdle()　　typingController.markDispatchIdle() → typing 气泡熄灭</text>
  <line x1="60" y1="484" x2="60" y2="504" stroke="#0d9488" stroke-width="1.5" marker-end="url(#ar3)"/>
  <circle cx="60" cy="518" r="11" fill="#0d9488"/>
  <text x="60" y="522" text-anchor="middle" font-size="10" font-weight="700" fill="white">9</text>
  <rect x="82" y="504" width="420" height="42" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="292" y="520" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">server-chat.ts: emitChatFinal</text>
  <text x="292" y="534" text-anchor="middle" font-size="10" fill="#0d9488">broadcast("chat", {state:"final"})　→　前端 handleChatEvent → chatMessages 追加定稿消息</text>
</svg>
<span class="figure-caption">图 R11.2 ｜ 一次 final 回复完整投递时序：从 agent 事件到外部平台落地与前端渲染的 9 步流程</span>

<details>
<summary>ASCII 原版</summary>

```
1. agent runner 流式产出 AgentEventPayload(stream="assistant", data.text=...)
        │
        ├─→ [广播路径] server-chat.ts 投影器
        │      sendOrBufferAgentTextEvent → 150ms 节流 → broadcast("agent", payload)
        │      createGatewayBroadcaster: hasEventScope 过滤 → WS frame
        │      前端 GatewayBrowserClient.onEvent → handleAgentEvent
        │
        └─→ [投递路径] dispatch-from-config.ts 累积文本
               │
2.             本轮结束 → dispatcher.sendFinalReply(payload)  返回 true
               │
3.       enqueue(): normalizeReplyPayload（前缀/线程化/transform）
               │  pending += 1, queuedCounts.final += 1
               │
4.       接到 sendChain 链尾 → （final 不加人性化延迟）
               │  → beforeDeliver 钩子（abort 检查）
               │  → options.deliver(payload, {kind:"final"})
               │
5.       sendDurableMessageBatch
               │  ctx.render() → RenderedMessageBatch
               │  ctx.send() → deliverOutboundPayloadsInternal → 外部平台
               │  createMessageReceiptFromOutboundResults → MessageReceipt
               │
6.       result.status === "sent" → ctx.commit(receipt)
               │
7.       .finally: pending -= 1
               │
8.       dispatcher.markComplete() 已调用 → pending 归零
               │  → unregister() + onIdle()
               │  → typingController.markDispatchIdle() → typing 气泡熄灭
               │
9.       server-chat.ts: emitChatFinal → broadcast("chat", {state:"final", message})
               │  前端 handleChatEvent: state==="final" → 把消息追加进 chatMessages
```

</details>

第 1 步之后投递路径和广播路径就**彻底分头跑**，唯一的「汇合」是用户视角——他在 Telegram 看到的消息（投递路径，第 6 步）和在 WebChat 看到的消息（广播路径，第 9 步）内容一致，但来自两套独立管线。理解这个「双轨」是理解 OpenClaw 投递层的钥匙。

---

## 11.9 小结

- `ReplyDispatcher`（`src/auto-reply/reply/reply-dispatcher.ts:123`）用一条 `sendChain` Promise 链保证 `tool`/`block`/`final` 三类回复严格有序，并提供人性化延迟、in-flight 追踪、idle 信号。
- `pending` 计数器从 1（预约位）起步，`markComplete()` 后才可能归零——这是为了防止 gateway 在 dispatcher 还没来得及发第一条时就误判空闲、提前重启。
- `ReplyPayload`（`src/auto-reply/reply-payload.ts:7`）是 channel 无关的回复单元；线程化（`applyReplyThreading`）、可渲染性过滤、BTW 前缀是它投递前的最后加工。代码库里没有 `finalizeReply` 函数，累积逻辑在 `dispatch-from-config.ts`。
- 真正的 channel 投递入口是 `sendDurableMessageBatch`（`src/channels/message/send.ts:336`），它 render → send → commit/fail，并产出 `MessageReceipt`。代码库里没有 `sendChannelMessage` 函数。
- `MessageReceipt`（`src/channels/message/types.ts:61`）记录 `platformMessageIds` / `parts` / `threadId`，是后续编辑、删除、流式预览的依据。
- durability 三档（`required` / `best_effort` / `disabled`）+ 四态结果（`sent` / `suppressed` / `partial_failed` / `failed`）共同保证「失败可重试、已发出部分不重复」。
- WebSocket 广播只有 `"agent"` 和 `"chat"` 两个顶层事件名；`stream` + `data.phase` 才是细粒度类型。`createGatewayBroadcaster`（`src/gateway/server-broadcast.ts:95`）做 scope 过滤、慢消费者保护、frame 复用优化。
- 投递路径与广播路径并行解耦，多 channel 各持一个 dispatcher 实例并通过 `dispatcher-registry.ts` 参与 gateway 的优雅关闭协调。
