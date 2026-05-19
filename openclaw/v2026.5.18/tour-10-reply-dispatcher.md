# Tour 10：创建 ReplyDispatcher

## 1. 当前情境

上一步（tour-09）结束时，`message_received` 钩子已经触发完毕——无论当前部署是否真装了用这个钩子的插件，主流程都没有被阻塞，消息**确认进入回复流程**。

但要注意一个时序细节：`ReplyDispatcher` 并不是在 tour-09 之后才出生的。回过头看 tour-07——`dispatchInboundMessage` 接到的入参里**已经带着一个 `dispatcher`**。真正创建它的是更外层的 `dispatchInboundMessageWithBufferedDispatcher`（gateway 的 `chat.send` 路径走的就是它）。也就是说，`ReplyDispatcher` 在整条 trace 刚进入 `auto-reply` 子系统时就被构造好了，然后一路作为参数传到这里。

这一步我们把镜头拉回去，专门讲清楚这个一直在「背景」里的对象：`ReplyDispatcher` 是怎么被创建的、它到底负责什么。理解它，是理解后面 tour-14~17（流式事件、组装回复、投递、持久化）的前提——因为那几步的回复全都要经过它。

此刻我们手上有：`FinalizedMsgContext`、确定的 agent / 会话、一个**已经存在并即将被 agent 回填的 `ReplyDispatcher`**。

## 2. 问题

> agent 跑一轮对话不会一次性吐出整段回复，而是流式地、分段地产出（思考、工具调用、工具结果、收尾文本）。如何把这些零碎、异步、可能失败的产出，可靠、有序、不轰炸用户地投递到 channel——同时让 gateway 在想优雅重启时知道「还有没有回复在途中」？

## 3. 朴素思路

agent 每产出一段可见文本，就直接调用 channel 适配器的 `send()` 把它发出去。回复来了就发，简单直接。打字指示器？agent 一开始就让 channel 亮起「正在输入」，agent 结束就熄灭。

## 4. 为什么朴素思路会崩

「产出即发送」这个朴素思路，在 OpenClaw「接入二十多个真实聊天平台」的环境里会以几种很具体的方式崩掉：

- **乱序。** `channelAdapter.send()` 是异步的。agent 先产出 block A、再产出 block B，两次 `send()` 并发飞出去，平台侧 B 可能先到。用户看到的回复段落顺序是乱的——对一段连贯的回答，这是硬伤。
- **轰炸用户。** agent 把一段长回答切成 5 个 block，「产出即发送」会在几十毫秒内连发 5 条消息。用户的手机连环震动 5 下，体验像机器人故障，还容易触发平台的反垃圾限速。
- **生命周期失控。** gateway 想优雅重启，它需要知道「现在还有没有回复正在投递中」。「产出即发送」没有任何「在途计数」，gateway 无从判断——要么粗暴杀进程丢消息，要么永远不敢重启。
- **打字指示器熄得太早。** 朴素思路里「agent 结束就熄灭 typing」。但「模型推理结束」和「最后一条回复真正发出去」之间有时间差——人性化延迟、投递重试都会让最后一条消息在模型早停之后才抵达。气泡先熄灭、然后又蹦出一条消息，很怪。
- **失败处理一刀切。** 第 2 条 `send()` 失败了——朴素思路要么让异常冒泡把后面 3 条也带崩，要么默默忽略。没有「逐条隔离失败、其余照常」的中间地带。
- **回复前缀要插值「当前模型名」，但模型还没定。** 回复可能要带一个前缀模板，模板里要插当前用的模型名。可模型选择要等 agent run 真正开始才确定（tour-11）。「产出即发送」没有一个「投递前最后一刻再取上下文」的钩子点。

核心矛盾：agent 的产出是**流式、异步、分段、可能失败**的，而「投递到真实聊天平台」要求**有序、有节奏、可追踪、可隔离失败**。中间必须有一个协调层，把前者整理成后者。

## 5. OpenClaw 的做法

**先把问题摆清楚**：在「agent 流式产出」和「channel 投递」之间，需要一个中枢，它要同时解决有序、节流、生命周期可见、失败隔离、投递前回调这五件事。OpenClaw 的答案就是 `ReplyDispatcher`，由 `createReplyDispatcher()` 工厂创建。

**核心是一条 Promise 链。** `createReplyDispatcher` 内部维护一个 `let sendChain: Promise<void> = Promise.resolve()`。每入队一个回复，就把它的投递动作 `.then()` 接到链尾。Promise 链天然串行——前一个 `await` 完才轮到下一个。于是 tool / block / final 三类回复**严格按入队顺序**抵达 channel，永不乱序。这就堵上了朴素思路的「乱序」洞。

**三种投递类型，三个入队方法。** `ReplyDispatchKind` 只有三个取值——`tool`（工具调用/结果的中间播报）、`block`（多段回复中的一个中间段）、`final`（本轮收尾回复）。对应 dispatcher 暴露 `sendToolResult` / `sendBlockReply` / `sendFinalReply` 三个方法，全都委托给同一个内部 `enqueue`。它们返回 `boolean`——`true` 表示成功入队，`false` 表示 payload 在归一化阶段被丢弃（如静默回复、空内容）。

**`enqueue` 做四件事：**

1. **归一化**（`normalizeReplyPayloadInternal`）。应用回复前缀模板、剥离心跳标记、跑插件的 `transformReplyPayload`，并判定 payload 该不该被丢弃。回复前缀里要插值「当前模型名」的问题，OpenClaw 用一个**惰性 provider**（`responsePrefixContextProvider`）解决——前缀上下文不是构造时的静态快照，而是在归一化这一刻才调 provider 取最新值，所以即便模型要等 agent run 才定，前缀也能拿到正确的模型名。
2. **登记计数并占位 pending**。`queuedCounts[kind] += 1`、`pending += 1`。
3. **决定人性化延迟**。只有 `block` 类型、且不是第一个 block，才加延迟。第一个 block 不延迟——用户刚发完消息，第一段回复应尽快出现；后续段才模拟人类打字停顿（默认 800ms–2500ms 的随机延迟）。这就回答了朴素思路的「轰炸用户」。
4. **把投递动作接到 `sendChain` 链尾**。投递前若配了 `beforeDeliver` 回调，先过它一遍——它可以返回 `null` 表示「取消这一条」（abort 逻辑就靠它），或返回改写过的 payload。这一步的 `.catch` **不向上抛**：单条投递失败只计入 `failedCounts` 并触发 `onError`，**不中断 `sendChain`**——第 2 条失败不会让第 3、4 条永远卡住。这就是「逐条隔离失败」。`.finally` 里 `pending -= 1`，保证 idle 信号最终一定发出。

**`pending` 计数器 = 生命周期可见性。** `pending` 初始化为 **1**（一个「预约位」），每入队一条 +1、每投递完一条 -1，`markComplete()` 被调时再 -1 把预约位释放掉。只有 `pending` 归零，dispatcher 才算 idle。`waitForIdle()` 返回 `sendChain`，gateway 优雅重启时 `await` 它就能确知「所有在途回复都投递完了」——这堵上了「生命周期失控」的洞。

**带打字指示器的变体。** gateway 的 `chat.send` 路径用的不是裸的 `createReplyDispatcher`，而是 `createReplyDispatcherWithTyping`——它在普通 dispatcher 外面包一层，把 dispatcher 的生命周期事件接到 `TypingController`。打字气泡的熄灭需要**两个信号都到齐**：`markRunComplete()`（模型推理结束）和 `markDispatchIdle()`（所有回复也投递完）。为什么拆两个？因为人性化延迟、投递重试会让最后一条 payload 在模型早停后才抵达——只有两个信号都到，气泡才熄灭，用户不会看到「停止输入」后又突然蹦出一条消息。这堵上了「打字指示器熄太早」的洞。`dispatchInboundMessageWithBufferedDispatcher` 在 `finally` 里就是先 `markRunComplete()` 再 `markDispatchIdle()`。

走完这一步，`ReplyDispatcher`（带打字协调）已经就绪——一条空的 `sendChain`、`pending` 为 1（预约位）、计数器清零、`beforeDeliver` 与 `TypingController` 都接好。它在等 agent 开始往里灌回复。下一步，回复流程将真正调用 agent。

## 6. 代码位置

- `src/auto-reply/dispatch.ts:283` — `dispatchInboundMessageWithBufferedDispatcher`，`chat.send` 路径的入口，在这里创建带打字的 dispatcher。
- `src/auto-reply/dispatch.ts:310` — `createReplyDispatcherWithTyping({ ... })` 调用点，拿回 `dispatcher` / `markDispatchIdle` / `markRunComplete`。
- `src/auto-reply/dispatch.ts:328` — `finally` 块里 `markRunComplete()` + `markDispatchIdle()`，两个信号收尾。
- `src/auto-reply/reply/reply-dispatcher.ts:123` — `createReplyDispatcher`，dispatcher 工厂。
- `src/auto-reply/reply/reply-dispatcher.ts:124` — `let sendChain: Promise<void> = Promise.resolve()`，串行投递链。
- `src/auto-reply/reply/reply-dispatcher.ts:128` — `let pending = 1`，在途计数的「预约位」初值。
- `src/auto-reply/reply/reply-dispatcher.ts:155` — 内部 `enqueue`，三个 `send*` 方法的共同实现。
- `src/auto-reply/reply/reply-dispatcher.ts:184` — `sendChain = sendChain.then(...)`，把投递动作接到链尾（含 `beforeDeliver`、`.catch` 隔离失败、`.finally` 减 `pending`）。
- `src/auto-reply/reply/reply-dispatcher.ts:40` — `getHumanDelay`，人性化延迟计算（默认 800–2500ms）。
- `src/auto-reply/reply/reply-dispatcher.ts:152` — `waitForIdle: () => sendChain`，生命周期可见性入口。
- `src/auto-reply/reply/reply-dispatcher.ts:225` — `markComplete`，释放预约位。
- `src/auto-reply/reply/reply-dispatcher.ts:257` — `createReplyDispatcherWithTyping`，接 `TypingController` 的变体。
- `src/auto-reply/reply/reply-dispatcher.types.ts:3` — `ReplyDispatchKind`（`"tool" | "block" | "final"`）与 `ReplyDispatcher` 接口。

## 7. 分支与延伸

我们这条 trace 走的是「WebChat、带打字指示器的 dispatcher、单条短回复」。这一步附近的岔路：

- **裸 dispatcher**：`dispatchInboundMessageWithDispatcher` 用不带打字的 `createReplyDispatcher`，用于不需要 typing 协调的场景。
- **前台回复栅栏**：`dispatchInboundMessageWithBufferedDispatcher` 还套了一层 `foregroundReplyFence`——同一会话同一目标若有新一轮 dispatch 抢进来，旧的会在 `beforeDeliver` 阶段被判定为「已被取代」而取消。
- **`beforeDeliver` 与 `message_sending` 钩子**：`buildMessageSendingBeforeDeliver` 会把 `message_sending` 插件钩子接成 `beforeDeliver`——回复发出前最后一刻插件还能改写或取消。
- **durable 投递与重试**：`deliver` 回调下游接的是 `sendDurableMessageBatch`，`required` 级别的消息失败会进持久化重试队列，`partial_failed` 时只重投没发出的那部分、不重复发送。
- **dispatcher 注册表**：全局 `dispatcher-registry` 让 gateway 重启时能协调所有在途 dispatcher。

想系统理解投递层——`enqueue` 四步、`pending` 计数、人性化延迟、`TypingController` 双信号、`MessageReceipt` 与 durable 重试，去读 [第 11 章](11-delivery-and-events.md)。

## 8. 走完这一步你脑子里应该多了什么

- **`ReplyDispatcher` 是 agent 产出与 channel 投递之间的中枢。** 它在 trace 刚进 `auto-reply` 子系统时就被创建（由 `dispatchInboundMessageWithBufferedDispatcher`），一路作为参数传递，agent 后续把回复灌进它。
- **核心是一条 Promise 链 `sendChain`。** 每条回复的投递动作 `.then()` 接到链尾，Promise 链天然串行 → tool/block/final 严格按入队顺序抵达 channel，永不乱序。
- **三种投递类型**——`tool` / `block` / `final`，对应 `sendToolResult` / `sendBlockReply` / `sendFinalReply`，全部委托给同一个 `enqueue`（归一化 → 计数 → 人性化延迟 → 接链尾）。
- **`pending` 计数器提供生命周期可见性。** 初值 1 是「预约位」，`waitForIdle()` 让 gateway 优雅重启时能确知「所有在途回复都投递完了」。
- **打字指示器需要两个信号才熄灭**——`markRunComplete()`（模型推理结束）与 `markDispatchIdle()`（回复全部投递完），避免气泡熄灭后又蹦出消息。
- **失败是逐条隔离的。** 单条投递失败只计入 `failedCounts`、触发 `onError`，`.catch` 不向上抛，不会卡住后面的回复。
- 这一步结束时，`ReplyDispatcher` 就绪、`sendChain` 为空、计数器清零——下一步，回复流程将真正调用 agent，开始往这个 dispatcher 里灌回复。
