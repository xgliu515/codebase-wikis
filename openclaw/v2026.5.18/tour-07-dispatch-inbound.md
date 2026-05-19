# Tour 07：dispatchInboundMessage

## 1. 当前情境

上一步结束时，`chat.send` handler 已经把那条「你好」翻译成了一个填好的 `MsgContext`——信封里正文五视图齐备、`Provider`/`Surface` 标注为 `webchat`、`SessionKey` 已归一、`ChatType: "direct"`、`CommandTurn` 判定为 `normal`。

handler 在分发之前还做了几件收尾：它已经 `respond` 了一个 ack 帧回前端（带 `runId`，前端那个 `await` 的 Promise 已经 resolve）、把这次 chat run 登记进了活跃 run 注册表（`context.addChatRun`）、并组装好了一个**回复 dispatcher**（负责把 agent 产出的回复投递回去）。

现在 handler 走到 `src/gateway/server-methods/chat.ts:2626`，调用 `dispatchInboundMessage`，把 `ctx`、`cfg`、`dispatcher` 和一组 `replyOptions` 一起交出去。我们这一步要看的，就是 `dispatchInboundMessage`——`src/auto-reply/dispatch.ts:244`——这个**入站分发总协调器**接管 `MsgContext` 之后做什么。

## 2. 问题

手上有一个填好的 `MsgContext` 信封，目标是「让 agent 处理它并产出回复」。但「处理一条入站消息」不是一个原子动作——它要解析会话、跑插件钩子、执行 agent、投递回复、结算计数，还要处理并发、诊断埋点、生命周期。问题是：

> 从「一个 `MsgContext`」到「agent 跑完、回复投递出去」之间，是一长串有先后、有围栏、可能抛错的步骤。谁来**编排**这一长串步骤，并保证无论中途成功失败，分发器的生命周期都被正确收尾？

## 3. 朴素思路

写一个大函数 `handleInbound(ctx)`，从上到下把所有事一口气做完：解析会话、跑钩子、调 agent、把回复发出去、记日志。一条直线，顺序执行。`chat.send` handler 直接调它。

## 4. 为什么朴素思路会崩

这个朴素的「一个大函数顺序做完」会以几种具体方式崩掉：

- **职责全糅在一起，没有收敛点**。会话解析、agent 执行、回复投递是三件性质完全不同的事，分别是几个独立子系统的入口。糅进一个函数，这个函数会变成几千行，而且没有一个清晰的「这里是入站消息的统一入口」——二十余种渠道每条消息都要经过这里，它必须是一个**明确的、薄的、可复用的协调层**，不是一锅粥。
- **分发器生命周期会泄漏**。回复 dispatcher 是有状态的——它要在分发开始时「开启」、结束时「结算」（拿回投递成功/失败/取消的计数）。如果 agent 执行中途抛了异常，而收尾逻辑写在函数末尾顺序执行，异常会跳过收尾——dispatcher 永远不结算，打字指示器永远转着，计数永远对不上。收尾必须在 `finally` 语义里，无论成功失败都执行。
- **并发陈旧回复无人抑制**。用户在聊天里连发两条消息，触发两次 `dispatchInboundMessage`。第一次的 agent 还在慢慢生成，第二次已经开始。第一次那个「旧」回复此刻若还投递出去，就是陈旧的、令人困惑的输出。一个纯顺序的大函数没有任何机制感知「我这次分发已经被一次更新的分发取代了」。
- **入站定稿不被保证**。`MsgContext` 进来时可能字段残缺、文本未规范、命令授权未明确设置（第 05 章 §1.3 的 default-deny）。如果每个下游步骤各自防御性地处理「万一这个字段没有」，逻辑会到处是 `??` 兜底。应该有一个地方**无条件定稿一次**，之后内部只信定稿值。
- **诊断埋点散落**。「这次入站处理花了多久、哪一段慢」需要诊断时间线。如果埋点散落在大函数各处，既乱又容易漏。

核心矛盾：「处理一条入站消息」是一个**多步骤、有围栏、可能抛错、需要生命周期管理**的编排问题。一个顺序执行的大函数能跑通 happy path，但在收尾、并发、定稿、可观测性每一个维度上都漏。

## 5. OpenClaw 的做法

OpenClaw 把 `dispatchInboundMessage` 设计成一个**薄的总协调器**——它自己**不做**会话解析，也**不做** agent 执行，那些委托给下一层 `dispatchReplyFromConfig`。它的职责只有四个字：**编排与收尾**。

**先回到问题：谁来编排、谁来保证收尾。** `dispatchInboundMessage`（`src/auto-reply/dispatch.ts:244`）的主体就是四步，每一步对应朴素思路漏掉的一块：

**第一步 —— 定稿（`src/auto-reply/dispatch.ts:251`）。** 无条件调用 `finalizeInboundContext(params.ctx)`：

```ts
// src/auto-reply/dispatch.ts:251
const finalized = measureDiagnosticsTimelineSpanSync(
  "auto_reply.finalize_context",
  () => finalizeInboundContext(params.ctx),
  { phase: "agent-turn", config: params.cfg, attributes: ... },
);
```

`finalizeInboundContext`（第 05 章 §3）是整条入站管线的**确定性收敛点**：它把可能字段残缺的 `MsgContext` 整形成一个所有不变量都成立的 `FinalizedMsgContext`——正文字段按优先级回填、`CommandAuthorized` 按 default-deny 折叠成确定的 `boolean`、媒体单复数字段对齐。注意：即便上一步 handler 传进来的 `ctx` 已经填得很全，这里**还是再跑一遍**——`finalizeInboundContext` 是幂等的，在边界处定稿一次，内部就只信定稿值。整个调用被 `measureDiagnosticsTimelineSpanSync` 包成一个诊断 span，可观测性问题就地解决。

我们 trace 里这条「你好」的 `ctx` 在上一步已经填得很完整，所以这次定稿基本是「确认不变量已成立」——但这个无条件的一遍，正是「不让下游各自防御性兜底」的保证。

**第二步 —— 包裹分发器生命周期（`src/auto-reply/dispatch.ts:260`）。** 这是朴素思路「收尾会泄漏」问题的答案：

```ts
// src/auto-reply/dispatch.ts:260
const result = await withReplyDispatcher({
  dispatcher: params.dispatcher,
  run: () => measureDiagnosticsTimelineSpan(
    "auto_reply.dispatch_reply_from_config",
    () => dispatchReplyFromConfig({ ctx: finalized, cfg, dispatcher, ... }),
    ...
  ),
});
```

`withReplyDispatcher` 把真正的工作（`run` 回调）夹在「开启 dispatcher」和「结算 dispatcher」中间——无论 `run` 正常返回还是抛异常，dispatcher 都被正确收尾。这就是 `finally` 语义：打字指示器一定会停，计数一定会被结算。

**第三步 —— 委托（`src/auto-reply/dispatch.ts:266`）。** `run` 回调里调的 `dispatchReplyFromConfig` 才是真正做会话解析 + agent 执行 + 回复投递的地方。`dispatchInboundMessage` 把定稿后的 `finalized`、配置、dispatcher、`replyOptions` 一起传下去，自己**不碰**那些细节。这正是「薄协调器」的体现——它知道「下一步该轮到 `dispatchReplyFromConfig`」，但不知道也不关心会话怎么解析、agent 怎么跑。

**第四步 —— 结算（`src/auto-reply/dispatch.ts:280`）。** `finalizeDispatchResult(result, params.dispatcher)` 从 dispatcher 取回「被取消」和「失败」的计数，从结果里扣除，得到真实交付数。

**并发陈旧回复抑制 —— 在带缓冲的入口。** 我们这条 trace 实际走的不是裸 `dispatchInboundMessage`，而是它的上层封装 `dispatchInboundMessageWithBufferedDispatcher`（`src/auto-reply/dispatch.ts:283`）——「带打字指示器的缓冲分发器」版本，多数渠道走这个，因为 agent 思考时要显示「正在输入…」。它在调 `dispatchInboundMessage` 之前多做两件事：

- **前台代次围栏（`src/auto-reply/dispatch.ts:291`）。** `beginForegroundReplyFence(finalized)` 给本次分发分配一个 `generation` 计数器快照。投递回复前会检查 `isForegroundReplyFenceSuperseded`——如果期间有更新的分发开始（用户连发了第二条），本次「旧」回复就被作废。这就是朴素思路「并发陈旧回复无人抑制」的答案。我们这条「你好」是单条消息，不会被取代，围栏顺利放行。
- **静默回复策略（`src/auto-reply/dispatch.ts:292`）。** `resolveDispatcherSilentReplyContext` 决定本次回复是否该静默（如群里未被提及的消息）。WebChat 是 `direct` 会话，助手总该出声回复，这里不静默。

走完这一步，`dispatchInboundMessage` 已经把整个入站处理编排起来了：`MsgContext` 已定稿成 `FinalizedMsgContext`、dispatcher 生命周期已被 `withReplyDispatcher` 包好、前台围栏已就位、控制权已经交给 `dispatchReplyFromConfig`。从这里往后，trace 进入「会话解析」——下一步，`dispatchReplyFromConfig` 会拿着定稿上下文去会话存储里定位那条「你好」属于哪个 session。

## 6. 代码位置

- `src/gateway/server-methods/chat.ts:2626` — `chat.send` handler 调用 `dispatchInboundMessage`，传入 `ctx`/`cfg`/`dispatcher`/`replyOptions`。
- `src/auto-reply/dispatch.ts:244` — `dispatchInboundMessage`，入站分发总协调器，本步主体。
- `src/auto-reply/dispatch.ts:251` — 第一步：无条件 `finalizeInboundContext(params.ctx)` 定稿，包成诊断 span。
- `src/auto-reply/dispatch.ts:260` — 第二步：`withReplyDispatcher` 包裹分发器生命周期。
- `src/auto-reply/dispatch.ts:266` — 第三步：委托给 `dispatchReplyFromConfig`（真正做会话解析 + agent 执行）。
- `src/auto-reply/dispatch.ts:280` — 第四步：`finalizeDispatchResult` 结算交付/取消/失败计数。
- `src/auto-reply/dispatch.ts:283` — `dispatchInboundMessageWithBufferedDispatcher`，带打字指示器的上层封装（trace 实际走这条）。
- `src/auto-reply/dispatch.ts:291` — `beginForegroundReplyFence`，前台代次围栏（并发陈旧回复抑制）。
- `src/auto-reply/dispatch.ts:292` — `resolveDispatcherSilentReplyContext`，静默回复策略。
- `src/auto-reply/dispatch.ts:79` — `beginForegroundReplyFence` 定义，`generation` 计数器机制。
- `src/auto-reply/dispatch.ts:206` — `finalizeDispatchResult` 定义。
- `src/auto-reply/reply/inbound-context.ts:39` — `finalizeInboundContext`，入站管线的确定性收敛点。
- `src/auto-reply/reply/dispatch-from-config.ts:420` — `dispatchReplyFromConfig`，下一步的起点。

## 7. 分支与延伸

我们这条 trace 走的是「单条『你好』、`direct` 会话、不静默、围栏顺利放行、agent 正常跑完」。这一步上的岔路：

- **三个入口层次**：`dispatch.ts` 导出 `dispatchInboundMessage`（最底层，需自备 dispatcher）、`dispatchInboundMessageWithDispatcher`（自动建普通分发器）、`dispatchInboundMessageWithBufferedDispatcher`（带打字指示器，trace 走这个）。
- **并发取代**：用户连发两条消息时，第一次分发的回复在 `beforeDeliver` 检查时发现 `generation` 已被推进，回复作废（返回 `null` 取消投递）。
- **静默回复**：群聊里未被提及的消息，`resolveDispatcherSilentReplyContext` 可能判定为静默，助手不出声。
- **`message_sending` 钩子**：若插件注册了 `message_sending` 钩子，`buildMessageSendingBeforeDeliver` 会在每条回复投递前调用它，钩子能取消或改写回复。
- **分发抛错**：`dispatchReplyFromConfig` 中途抛异常时，`withReplyDispatcher` 仍保证 dispatcher 被结算，`finalizeDispatchResult` 把失败计数附在结果上。

想完整理解入站管线全貌（`finalizeInboundContext` 的定稿逻辑、`dispatchInboundMessage` 的三个入口、前台代次围栏、静默回复策略、`dispatchReplyFromConfig` 如何衔接会话解析），去读 [第 5 章](05-inbound-pipeline.md)。

## 8. 走完这一步你脑子里应该多了什么

- `dispatchInboundMessage` 是入站消息的**总协调器**，但它是**薄的**——它自己不解析会话、不跑 agent，那些委托给下一层 `dispatchReplyFromConfig`。它的职责是编排与收尾。
- 它的主体是四步：**定稿** → **包裹 dispatcher 生命周期** → **委托** → **结算**。第一步无条件跑 `finalizeInboundContext`（幂等），把 `MsgContext` 整形成不变量齐全的 `FinalizedMsgContext`——「在边界定稿一次，内部只信定稿值」。
- 分发器生命周期由 `withReplyDispatcher` 用 `finally` 语义包住：无论 agent 执行成功还是抛错，dispatcher 都被正确结算——打字指示器一定停，计数一定对得上。
- **前台代次围栏**（`beginForegroundReplyFence`）解决并发陈旧回复：用户连发消息时，旧的那次分发的回复在投递前会被检测到「已被更新分发取代」而作废。
- trace 实际走的是 `dispatchInboundMessageWithBufferedDispatcher`——带打字指示器的版本，它在裸 `dispatchInboundMessage` 之外多加了前台围栏和静默回复策略。
- 这一步结束时，dispatch 已启动、上下文已定稿、控制权已交给 `dispatchReplyFromConfig`——下一步，会话解析：定位那条「你好」属于哪个 session、要用哪个 agent、哪个 model。
