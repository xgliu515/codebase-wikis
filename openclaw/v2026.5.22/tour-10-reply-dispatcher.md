# Tour Step 10: Constructing the ReplyDispatcher

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

We are still inside the WebChat `chat.send` handler at `src/gateway/server-methods/chat.ts`, **before** any agent has been asked for a reply. The `MsgContext` is final, the `SessionEntry` is resolved, the `message_received` hook fan-out has happened (and was a no-op). The next thing the gateway needs is a *sink* for whatever the agent will emit.

What will the agent emit? Not a single string. In OpenClaw, a single turn produces a heterogeneous stream: zero or more tool-call announcements, zero or more intermediate "block" replies (think mid-turn user-facing notes), and exactly one (or zero, if silenced) final reply. They arrive over many seconds and out of order with the live UI's needs. The gateway has to:

- serialize the stream into a single ordered queue of deliveries;
- run a typing indicator while the model is thinking;
- collect the visible blocks into a `deliveredReplies` array so the JSON-RPC response can return them to the caller;
- broadcast each block, as it happens, to any WebSocket clients subscribed to the session;
- handle partial failures (one block delivery throws — the next must still go);
- coordinate idle detection so the gateway can answer "is any work in flight?" during shutdown.

Concretely, control is at `src/gateway/server-methods/chat.ts:2817`, about to call `createReplyDispatcher`. The reply pipeline configuration object `replyPipeline` has already been built by `createChannelMessageReplyPipeline` (`src/gateway/server-methods/chat.ts:2635-2639`, defined in `src/plugin-sdk/channel-message.ts:33-38` which re-exports `createChannelReplyPipeline`). `deliveredReplies` is initialised as an empty array (`chat.ts:2645`).

## 2. The problem

The agent runtime drives a long-running async generator. It can emit tens of events over tens of seconds. The reply path has to bridge that bursty async event stream into:

- **one final response** for the JSON-RPC return value (in the WebChat case, the assembled text + media from `deliveredReplies`);
- **a live broadcast** of each visible block to subscribed clients so the typing UI updates in near real time;
- **a typing indicator** that starts when the model says it is thinking and stops the moment the dispatcher idles;
- **strict ordering** between tool-result events, mid-turn block replies, and the final reply — even when the underlying delivery is async and may take variable time per item;
- **resilience** to per-item failures so one rogue block does not poison the rest of the turn.

If the host gets any of this wrong, the user sees a stuck typing dot, or a final reply with no body, or blocks arriving in the wrong order, or two replies for one turn, or a frozen gateway because nobody told it the turn ended.

## 3. Naive approach

Buffer everything the agent emits into a list. When the agent's async generator returns, format the list into a single reply and write it to the response.

```ts
async function handleChat(msg) {
  const out: string[] = [];
  for await (const event of runAgent(msg)) {
    if (event.type === "block" || event.type === "final") {
      out.push(event.text);
    }
  }
  return { text: out.join("\n") };
}
```

Simple, deterministic. One reply per turn. No ordering bugs.

## 4. Why the naive approach breaks

- **No typing indicator.** The UI shows nothing until the entire run completes. For "hello" with a fast model that is acceptable. For a 40-second tool-using turn, the user sees a blank screen for 40 seconds and gives up.
- **No streaming UI.** Even if the agent produces a partial block at 5 seconds and a final at 40 seconds, the naive approach hides the partial. There is no way to "see the model think out loud".
- **Retries lose progress.** When the channel-side delivery fails (a Telegram API hiccup, a WebSocket disconnect), the naive code has already overwritten the partial state and has nothing to retry with. It must either restart the whole turn or silently drop the partial.
- **Partial errors disappear.** If event #3 of a 5-event turn throws, the naive code may abort the entire for-await or, worse, swallow the throw silently. Either way the user gets a partial reply with no indication of what failed.
- **Idle detection is impossible.** Other parts of the gateway (graceful shutdown, lifecycle telemetry) want to ask "are there outstanding deliveries?". A list of strings answers no questions about in-flight work.
- **Tool-bearing payloads have nowhere to go.** A tool result that includes audio (the TTS tool's payload) needs to be promoted to a "final" so the downstream audio extractor can find it. The naive code has no kind discriminator, no promotion, no audio.
- **No queue boundary between the agent and the channel.** A fast agent can emit faster than the channel can deliver. With a naive append-and-join, the host has no backpressure; with a naive `await deliver(each)` chained tightly, ordering breaks if two awaits get reordered.

## 5. OpenClaw's approach

OpenClaw's approach is to introduce a **single per-turn coordinator object — the `ReplyDispatcher` — that serializes outbound deliveries onto one promise chain, tracks per-kind queued/failed/cancelled counts, exposes an `idle` signal for shutdown, and threads through an optional typing-indicator controller that the channel layer can hook into**.

It is built once per inbound dispatch by `createReplyDispatcher(options)` (`src/auto-reply/reply/reply-dispatcher.ts:123-255`), or by `createReplyDispatcherWithTyping(options)` (`src/auto-reply/reply/reply-dispatcher.ts:281-314`) when typing callbacks are present.

For WebChat the call site is direct (`src/gateway/server-methods/chat.ts:2817-2842`):

```ts
const dispatcher = createReplyDispatcher({
  ...replyPipeline,
  onError: (err) => {
    context.logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
  },
  deliver: async (payload, info) => {
    switch (info.kind) {
      case "block":
      case "final":
        deliveredReplies.push({ payload, kind: info.kind });
        await appendWebchatAgentMediaTranscriptIfNeeded(payload);
        break;
      case "tool":
        if (isMediaBearingPayload(payload)) {
          deliveredReplies.push({
            payload: { ...payload, text: undefined },
            kind: "final",
          });
        }
        break;
    }
  },
});
```

The dispatcher returned has three send methods and four observability methods (`src/auto-reply/reply/reply-dispatcher.types.ts:5-14`):

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

Internally, each `send*` call funnels into the same private `enqueue(kind, payload)` helper at `src/auto-reply/reply/reply-dispatcher.ts:155-223`. The mechanism has five pieces.

**Piece one: normalization.** `enqueue` first calls `normalizeReplyPayloadInternal` (`reply-dispatcher.ts:107-121` → `normalizeReplyPayload` in `normalize-reply.ts`). Silent-reply tokens are stripped, response-prefix templates are interpolated, transforms are applied. If normalization returns `null` (the payload was entirely a silent-reply marker), `enqueue` returns `false` without touching the queue. The `onSkip` callback is invoked so the channel can react.

**Piece two: the chained promise queue.** A single `let sendChain: Promise<void> = Promise.resolve();` (`reply-dispatcher.ts:124`) is the ordering primitive. Every successful enqueue appends `.then(async () => { ... deliver ... })` to `sendChain`, then catches errors per-link and finally decrements the in-flight counter (lines 184-221). Because every delivery is a `.then` on the same chain, two `sendBlockReply` calls that arrive simultaneously are guaranteed to deliver in call order even though `options.deliver` is async.

**Piece three: per-kind counters.** Three records track `queuedCounts`, `failedCounts`, and `cancelledCounts`, indexed by `"tool" | "block" | "final"` (`reply-dispatcher.ts:133-147`). The `getQueuedCounts`/`getFailedCounts` accessors give the dispatch result code at `dispatch-from-config.ts:1469` a numeric summary it can attach to `recordProcessed`.

**Piece four: human delay and `beforeDeliver`.** Between two block replies, `getHumanDelay(options.humanDelay)` (`reply-dispatcher.ts:39-53`) injects a randomised pause from `[min, max]` so an agent that emits five blocks in rapid succession does not look mechanical. The first block is exempt (`sentFirstBlock` flag at lines 130-131, 179-182). An optional `beforeDeliver` hook is the last gate — it can return `null` to cancel the specific delivery (`reply-dispatcher.ts:193-200`).

**Piece five: idle accounting.** `pending` starts at 1 — a reservation that prevents premature "idle" before the first enqueue and prevents shutdown coordination from declaring the dispatcher quiescent before the call site has had a chance to wire it up (`reply-dispatcher.ts:126-128`). Every `enqueue` increments `pending`, every `.finally` decrements it. When `pending` reaches the magic value 1 *and* `markComplete()` has been called, the reservation is released and the dispatcher signals idle by calling `options.onIdle?.()` and unregistering itself from the global dispatcher registry (`reply-dispatcher.ts:212-221`). The registry (`registerDispatcher` at `dispatcher-registry.ts`) is what shutdown waits on.

For "hello" with the typing-equipped wrapper (the WebChat path uses the plain `createReplyDispatcher`, but TUI and channel paths use `createReplyDispatcherWithTyping`), `createReplyDispatcherWithTyping` (`reply-dispatcher.ts:281-314`) adds a `TypingController` (`src/auto-reply/reply/typing.ts:17-90`):

```ts
const dispatcher = createReplyDispatcher({
  ...dispatcherOptions,
  onIdle: () => {
    typingController?.markDispatchIdle();
    resolvedOnIdle?.();
  },
});
```

The typing controller exposes `onReplyStart`, `startTypingLoop`, `refreshTypingTtl`, `markRunComplete`, `markDispatchIdle`, and `cleanup` (`src/auto-reply/reply/typing.ts:6-15`). It owns a keepalive loop (`createTypingKeepaliveLoop` in `src/channels/typing-lifecycle.ts`) that pings the channel every 6 seconds and tears down on TTL expiry or on dispatcher idle, whichever comes first.

The `deliver` callback the gateway passes is where the broadcast happens. In the WebChat snippet above:

- `block` and `final` payloads are appended to `deliveredReplies` (`chat.ts:2645`), which the surrounding handler turns into the JSON-RPC reply at `chat.ts:2906-2952`.
- Tool payloads with audio are *promoted* to `final` so the downstream audio extractor can find them (`chat.ts:2829-2839`).
- A non-trivial side path, `appendWebchatAgentMediaTranscriptIfNeeded`, persists assistant media into the transcript store (`chat.ts:2780-2815`).

For WebSocket fanout, the broadcast is one layer up — the chat handler also schedules `emitAgentEvent({ runId, stream: "lifecycle", data: ... })` at `chat.ts:2860` and similar, which the gateway's WebSocket router (`src/infra/agent-events.ts`) pushes to subscribed clients. The dispatcher itself does not broadcast directly; it is the *deterministic queue* and the `deliver` callback is the *broadcast site*. That separation is deliberate — channels that do not want WS broadcast (e.g., a CLI invocation) reuse the same dispatcher with a different `deliver`.

At the end of construction the dispatcher object is wired but inert. No deliveries have been queued. The next step — `dispatchInboundMessage` calling into the agent runtime — is what will actually push tool/block/final events through `sendToolResult` / `sendBlockReply` / `sendFinalReply`.

## 6. Code locations

- `src/auto-reply/reply/reply-dispatcher.types.ts:1-14` — the `ReplyDispatcher` and `ReplyDispatchKind` types.
- `src/auto-reply/reply/reply-dispatcher.ts:55-86` — `ReplyDispatcherOptions` and `ReplyDispatcherWithTypingOptions`.
- `src/auto-reply/reply/reply-dispatcher.ts:123-255` — `createReplyDispatcher`, the core factory. The `enqueue` closure at lines 155-223 is the heart.
- `src/auto-reply/reply/reply-dispatcher.ts:124` — `sendChain`, the single promise chain that gives ordering.
- `src/auto-reply/reply/reply-dispatcher.ts:126-128` — the `pending = 1` reservation pattern.
- `src/auto-reply/reply/reply-dispatcher.ts:150-153` — `registerDispatcher` integration for shutdown coordination.
- `src/auto-reply/reply/reply-dispatcher.ts:178-182` — first-block delay exemption.
- `src/auto-reply/reply/reply-dispatcher.ts:193-200` — `beforeDeliver` cancellation gate.
- `src/auto-reply/reply/reply-dispatcher.ts:225-243` — `markComplete`, the call-site signal that no more enqueues will arrive.
- `src/auto-reply/reply/reply-dispatcher.ts:257-279` — `waitForReplyDispatcherIdle`, abort-aware idle wait used by the agent runner at `dispatch-from-config.ts:2118`.
- `src/auto-reply/reply/reply-dispatcher.ts:281-314` — `createReplyDispatcherWithTyping`, the typing-aware wrapper.
- `src/auto-reply/reply/typing.ts:6-15` — `TypingController` type.
- `src/auto-reply/reply/typing.ts:17-90` — `createTypingController` factory (typing keepalive loop, TTL, seal semantics).
- `src/gateway/server-methods/chat.ts:2635-2639` — WebChat construction of `replyPipeline` from `createChannelMessageReplyPipeline`.
- `src/gateway/server-methods/chat.ts:2645` — `deliveredReplies` accumulator.
- `src/gateway/server-methods/chat.ts:2817-2842` — the WebChat `createReplyDispatcher` call with its `deliver` callback.
- `src/gateway/server-methods/chat.ts:2906-2952` — assembly of `deliveredReplies` into the JSON-RPC response.
- `src/auto-reply/dispatch.ts:294-345` — `dispatchInboundMessageWithBufferedDispatcher`, the channel path that uses `createReplyDispatcherWithTyping`.
- `src/auto-reply/dispatch.ts:347-368` — `dispatchInboundMessageWithDispatcher`, the variant that accepts an externally-constructed dispatcher (used by WebChat).
- `src/plugin-sdk/channel-message.ts:32-38` — re-export of `createChannelReplyPipeline` as `createChannelMessageReplyPipeline`, the channel-aware options builder.
- `src/auto-reply/reply/normalize-reply.ts` — payload normalization, silent-reply stripping, response-prefix interpolation.
- `src/auto-reply/reply/dispatcher-registry.ts` — the global registry that `pending`/`waitForIdle` plug into for shutdown.
- `src/agents/announce-idempotency.ts:1-13` — separate concern: announcement idempotency by `(childSessionKey, childRunId)`. Touched by the dispatcher world only when a subagent emits an "announce" payload through the same `sendBlockReply` path.
- `src/channels/ack-reactions.ts` — channel-side ack/reaction wiring that some `deliver` callbacks integrate with.

## 7. Branches and extensions

The dispatcher has two construction modes (`createReplyDispatcher` vs `createReplyDispatcherWithTyping`) and three dispatch kinds (`tool`, `block`, `final`). Tool payloads can be promoted to `final` via the `deliver` callback (the WebChat media-bearing case). Block payloads can be cancelled per-call via `beforeDeliver` (the WebChat `foregroundReplyFenceSuperseded` case at `src/auto-reply/dispatch.ts:308-318`).

When the agent emits an audio-bearing reply through the TTS tool, the dispatcher path becomes important: `sendToolResult` is called, the `deliver` callback in `chat.ts` recognises the media-bearing payload, strips the text, and re-injects it as a `final` so the JSON-RPC return value carries the audio (`chat.ts:2829-2839`).

The `waitForReplyDispatcherIdle` helper at `reply-dispatcher.ts:257-279` is what the agent runner uses to "drain" the dispatcher between turns (`dispatch-from-config.ts:2118`). It races the dispatcher's `waitForIdle()` against an `AbortSignal`, so an aborted run does not block forever on a stuck delivery.

The shutdown coordinator hooks in via `registerDispatcher` (`dispatcher-registry.ts`). Every live dispatcher reports its `pending()` count and its `waitForIdle()` promise. Gateway server-close (`src/gateway/server-close.ts`) waits on all live dispatchers before declaring shutdown clean.

Further reading in the reference chapters:

- [Chapter 11 §2 — The ReplyDispatcher contract](./11-reply-pipeline.md#2-the-replydispatcher-contract).
- [Chapter 11 §5 — Typing indicator and human delay](./11-reply-pipeline.md#5-typing-indicator-and-human-delay).
- [Chapter 11 §8 — Event broadcast and the dispatcher registry](./11-reply-pipeline.md#8-event-broadcast-and-the-dispatcher-registry).

## 8. What you should now have in your head

- The `ReplyDispatcher` is **one per inbound dispatch**, constructed by `createReplyDispatcher(options)` at `src/auto-reply/reply/reply-dispatcher.ts:123`. It owns a single `sendChain` promise that serializes all outbound deliveries onto a strictly ordered queue.
- The three send methods (`sendToolResult`, `sendBlockReply`, `sendFinalReply`) all funnel into the same private `enqueue(kind, payload)` helper. The `kind` discriminator lets the `deliver` callback do per-kind handling (e.g., promote audio-bearing tool results to `final`).
- The dispatcher does **not** broadcast directly. The caller provides a `deliver` callback that does whatever the channel wants — append to a JSON-RPC response array (WebChat), call the channel adapter (Telegram, Slack), or do both. The dispatcher's job is ordering, accounting, and idle detection.
- A `pending = 1` reservation pattern plus `markComplete()` give an explicit two-party termination protocol: the producer (agent) signals "no more emits", the consumer (dispatcher) drains its chain, and idle fires exactly once.
- The typing controller is a separate object (`src/auto-reply/reply/typing.ts`) attached by the `createReplyDispatcherWithTyping` wrapper. The wrapper is the integration point for channels that need a live "is typing…" indicator; the dispatcher core knows nothing about typing.
