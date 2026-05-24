# Tour Step 16: Delivering back to WebChat and broadcasting

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

At the end of tour-15 we hold a finalized `ReplyPayload`:

```
{ text: "Hello! How can I help today?" }
```

It has been handed to `dispatcher.sendFinalReply(payload)` and queued onto this turn's `ReplyDispatcher` chain. `dispatcher.markComplete()` has been called too — the delivery layer knows "no more replies for this turn".

But "queued" is not "the user has seen it". The payload is still sitting on the `sendChain` Promise chain. And let us not forget the origin of the trace: the user typed "hello" in a browser WebChat tab. WebChat is gateway's built-in channel (`INTERNAL_MESSAGE_CHANNEL = "webchat"`), not Telegram or Discord. The reply does not "leave the gateway" via an external HTTP API — it travels back through the same WebSocket that was established way back in tour-03.

This step traces the journey from "payload in dispatcher queue" to "user's WebChat tab shows the assistant text". It is a two-track journey, and that two-track structure is the key.

## 2. The problem

> A finalized `ReplyPayload` must both (a) be delivered through the delivery layer as a proper reply, and (b) be broadcast to every WebSocket client that is observing this session so each open browser tab renders it in real time. Channels differ: some send via HTTP (Slack, Telegram), some via the same WS (WebChat), some require receipts and retries. How does the dispatcher abstract over that, and how does broadcast not turn into spam-or-leakage?

## 3. Naive approach

WebChat is internal, the reply is going back into a browser — just grab the originating WebSocket and `socket.send(payload.text)`. One call, one connection, one send. No external API, no token refresh, no HTTP round-trip — why layer abstractions over something this direct?

## 4. Why the naive approach breaks

Direct `socket.send` to "the originating connection" falls apart in production OpenClaw deployments in several specific ways:

- **"That one connection" is rarely one connection.** The same session may be observed by multiple clients simultaneously: a desktop browser tab, a phone tab, a Control UI panel. If the reply only goes to the connection that issued `chat.send`, the other two screens never update. A chat transcript is session-level shared state, not "whoever asked sees it".

- **Direct `socket.send` bypasses scope checks.** Chat transcripts are operator-grade sensitive data. A pairing-scope handshake connection or a node-role voice device might happen to be open on the same gateway. Writing the reply text directly to those sockets leaks transcript contents to clients that have no read scope. Authentication was checked at handshake (tour-03), but "is this connection allowed to receive this event?" is a check that must be re-applied on every broadcast.

- **Slow clients silently exhaust gateway memory.** A background tab on a flaky network keeps a high WebSocket `bufferedAmount`. Direct `socket.send` does not check that; one stalled tab can balloon gateway memory.

- **Delivery and broadcast get tangled.** "Persist this reply as part of the session" (delivery) and "push this event to every observer in real time" (broadcast) are two semantically different concerns. Delivery worries about durability, retries, and receipts. Broadcast worries about scope filtering, throttling, slow-consumer protection. Cramming them into a single `socket.send` couples their failure modes — any future change to one ripples into the other.

The core tension: **a reply needs to land on every connection with read scope to this session, not just the one that asked; and "delivered to the platform" vs "broadcast to observers" are two decoupled semantics, not one.** Bare `socket.send` violates both.

## 5. OpenClaw's approach

OpenClaw's approach is to run **two parallel tracks** for the same reply: a **delivery path** that hands the finalized payload to `ReplyDispatcher` and routes it back through `routeReplyToOriginating` to the originating channel (WebChat in our trace); and a **broadcast path** that the `server-chat.ts` projector drives — fanning agent events out as throttled `"chat"` events to every WebSocket client with read scope, with slow-consumer protection. The two tracks diverge after the reply is created and meet only at the user's screen.

**Track one: delivery path — `ReplyDispatcher` → `routeReplyToOriginating` → WebChat.**

`ReplyDispatcher`'s `sendChain` is a Promise chain at [`src/auto-reply/reply/reply-dispatcher.ts:124`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/reply-dispatcher.ts#L124) that guarantees `tool` / `block` / `final` replies leave in their enqueue order. When our final payload reaches the head of the chain, `normalizeReplyPayloadInternal` runs (prefix, heartbeat strip, plugin `transformReplyPayload`); `final` carries no humanization delay (only mid-stream `block` payloads do); then `options.deliver(payload, { kind: "final" })` fires.

For the WebChat trace, the `deliver` closure ultimately lands on `routeReplyToOriginating` at [`src/auto-reply/reply/dispatch-from-config.ts:1061`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L1061). It decides which channel the reply goes back to. Because the inbound message's surface is `webchat` (the `INTERNAL_MESSAGE_CHANNEL` defined at [`src/utils/message-channel-constants.ts:1`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/utils/message-channel-constants.ts#L1), used in branches like [`src/auto-reply/reply/dispatch-from-config.ts:1000`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L1000)), the reply routes back to the WebChat built-in channel — it does not travel to any external platform.

One correction worth carrying: **there is no `sendChannelMessage` function in the codebase**. The general-purpose durable-delivery entry point for external channels is `sendDurableMessageBatch` at [`src/channels/message/send.ts:336`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/channels/message/send.ts#L336) (render → send → commit/fail, producing a `MessageReceipt`). WebChat as built-in skips that path entirely — the reply content stays inside the gateway process and is mirrored into the transcript via `mirrorInternalSourceReplyToTranscript` at [`src/auto-reply/reply/dispatch-from-config.ts:645`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L645).

**Track two: broadcast path — `server-chat.ts` projector → `broadcast("chat" / "agent")` → WebSocket clients.**

In parallel with delivery, the `server-chat.ts` projector watches the same agent event stream. Two correction-worthy facts: (1) the gateway broadcasts only **two top-level event names** for assistant content, `"agent"` and `"chat"` — there is no event named `chat_message_text`; (2) the `"chat"` event uses a `state` field for sub-typing, with values `"delta"` / `"final"` / `"error"` / `"aborted"`.

| Top-level event | Purpose | Key fields |
| --- | --- | --- |
| `"agent"` | Fine-grained agent stream (deltas, tool phases, lifecycle) | `stream`, `seq`, `data` |
| `"chat"` | High-level conversation state for WebChat | `state`, `message` |

`"chat"` flows in two shapes:

- **Streaming deltas.** Each assistant token batch triggers `emitChatDelta` at [`src/gateway/server-chat.ts:480`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-chat.ts#L480). It applies a **150 ms throttle** ([`src/gateway/server-chat.ts:510`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-chat.ts#L510): `if (now - last < 150) return`), merges the delta, and calls `broadcast("chat", payload, { dropIfSlow: true })` with `state: "delta"`. The `deltaText` field carries the new fragment; `message.content[0].text` carries the cumulative buffer. **This is the typewriter effect** — and it comes from the broadcast path, not delivery.
- **Final.** When the model stream ends (`stream === "lifecycle"` + `data.phase === "end"`), the projector calls `emitChatFinal` at [`src/gateway/server-chat.ts:611`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-chat.ts#L611). It first calls `flushBufferedChatDeltaIfNeeded` ([`src/gateway/server-chat.ts:564`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-chat.ts#L564)) to drain any 150 ms-throttled fragment that never escaped — without this, the user would be left seeing penultimate text, not the full reply. Then `broadcast("chat", payload)` runs with `state: "final"` and `message` carrying the complete assistant text ([`src/gateway/server-chat.ts:653`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-chat.ts#L653)).

Every `broadcast("chat", payload)` is followed immediately by `nodeSendToSession(sessionKey, "chat", payload)` ([`src/gateway/server-chat.ts:654`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-chat.ts#L654)) — the former pushes to WebSocket clients, the latter pushes to bound nodes (voice devices, peripheral hardware). One payload, two distribution targets.

**The three broadcast safeguards — exactly the things the naive approach lacked.**

The actual frame-writer is `createGatewayBroadcaster` at [`src/gateway/server-broadcast.ts:95`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-broadcast.ts#L95). It does three things a naive `socket.send` does not:

1. **Fan out to every authorized client.** `broadcastInternal` ([`src/gateway/server-broadcast.ts:99`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-broadcast.ts#L99)) iterates the full `clients` set. This solves "many tabs on one session".
2. **Scope filtering.** `EVENT_SCOPE_GUARDS` at [`src/gateway/server-broadcast.ts:21`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-broadcast.ts#L21) declares that both `agent` and `chat` events require `READ_SCOPE`; `hasEventScope` at [`src/gateway/server-broadcast.ts:62`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-broadcast.ts#L62) per-client-checks it. Pairing-scope or node-role connections silently get skipped.
3. **Slow-consumer protection.** Every iteration checks `c.socket.bufferedAmount > MAX_BUFFERED_BYTES` ([`src/gateway/server-broadcast.ts:152`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-broadcast.ts#L152)). If `dropIfSlow` is set (delta path), the frame is dropped silently for that client; otherwise the socket is force-closed with `1008 "slow consumer"` ([`src/gateway/server-broadcast.ts:172`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-broadcast.ts#L172)). A wedged tab does not take the gateway down.

A representative slice of that loop:

```ts
// src/gateway/server-broadcast.ts:148
if (!hasEventScope(c, event)) {
  continue;
}
const nextSeq = (clientSeq.get(c) ?? 0) + 1;
const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
if (slow && opts?.dropIfSlow) {
  if (!isTargeted) clientSeq.set(c, nextSeq);
  continue;
}
if (slow) {
  try { c.socket.close(1008, "slow consumer"); } catch {}
  continue;
}
```

**Convergence point: the user's screen.** The WebChat frontend's `GatewayBrowserClient` receives the `"chat"` frame and `handleChatEvent` branches on `state`. `delta` events grow the current assistant bubble (typewriter). The `final` event pins the complete message into the `chatMessages` array. On screen, "Hello! How can I help today?" appears letter-by-letter and then settles.

When this step is done, the reply is on the user's screen. Both tracks have run: delivery has handled the reply as a reply (routed it back, mirrored it into the transcript via `mirrorInternalSourceReplyToTranscript`); broadcast has pushed it to every observing screen.

## 6. Code locations

- [`src/auto-reply/reply/reply-dispatcher.ts:124`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/reply-dispatcher.ts#L124) — `sendChain` Promise chain, guarantees in-order delivery to the channel.
- [`src/auto-reply/reply/reply-dispatcher.ts:157`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/reply-dispatcher.ts#L157) — `normalizeReplyPayloadInternal` invocation inside `enqueue`.
- [`src/auto-reply/reply/dispatch-from-config.ts:1061`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L1061) — `routeReplyToOriginating`, decides the originating channel for the reply.
- [`src/auto-reply/reply/dispatch-from-config.ts:1000`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L1000) — checks whether the current surface is `INTERNAL_MESSAGE_CHANNEL` (webchat).
- [`src/auto-reply/reply/dispatch-from-config.ts:645`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L645) — `mirrorInternalSourceReplyToTranscript`, internal-channel reply mirror into transcript.
- [`src/auto-reply/reply/dispatch-from-config.ts:92`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L92) — `import { INTERNAL_MESSAGE_CHANNEL }`, the webchat built-in channel constant.
- [`src/channels/message/send.ts:336`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/channels/message/send.ts#L336) — `sendDurableMessageBatch`, durable delivery entry for external channels (render → send → commit/fail). There is no `sendChannelMessage` function.
- [`src/gateway/server-chat.ts:480`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-chat.ts#L480) — `emitChatDelta`, constructs `state: "delta"` `"chat"` events.
- [`src/gateway/server-chat.ts:510`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-chat.ts#L510) — the 150 ms throttle threshold.
- [`src/gateway/server-chat.ts:538`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-chat.ts#L538) — `broadcast("chat", payload, { dropIfSlow: true })` + `nodeSendToSession` for deltas.
- [`src/gateway/server-chat.ts:564`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-chat.ts#L564) — `flushBufferedChatDeltaIfNeeded`, drains the throttled fragment before final.
- [`src/gateway/server-chat.ts:611`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-chat.ts#L611) — `emitChatFinal`, constructs `state: "final"` / error `"chat"` event.
- [`src/gateway/server-chat.ts:653`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-chat.ts#L653) — final path `broadcast("chat", payload)`.
- [`src/gateway/server-broadcast.ts:95`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-broadcast.ts#L95) — `createGatewayBroadcaster`, the real frame-writer (scope, slow-consumer).
- [`src/gateway/server-broadcast.ts:21`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-broadcast.ts#L21) — `EVENT_SCOPE_GUARDS`, declares `agent`/`chat` require `READ_SCOPE`.
- [`src/gateway/server-broadcast.ts:62`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-broadcast.ts#L62) — `hasEventScope`, per-client per-event scope check.
- [`src/gateway/server-broadcast.ts:172`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/server-broadcast.ts#L172) — `c.socket.close(1008, "slow consumer")` slow-client termination.
- [`src/utils/message-channel-constants.ts:1`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/utils/message-channel-constants.ts#L1) — `INTERNAL_MESSAGE_CHANNEL = "webchat"`.

## 7. Branches and extensions

We walked the simplest delivery path: one session, WebChat built-in channel, one final reply, broadcast to current connections. Branches on other traces:

- **External-channel delivery**: Telegram / Discord targets land at `sendDurableMessageBatch` (render → send → commit), producing a `MessageReceipt` that lets the agent later edit or delete the platform message.
- **Multi-channel parallel delivery**: a reply slated for the originating channel plus a copy-to group keeps a separate `ReplyDispatcher` per target so chains do not block each other.
- **`seq` gap detection**: if the broadcast path sees agent events skip a sequence number, it broadcasts a `stream: "error"` agent event so the client knows it lost a frame.
- **`partial_failed`**: a batch of multiple messages with one failure is held in a dedicated state; retry targets only the failed message, never reissuing successes.
- **Typing indicator**: external platforms (Telegram "typing…") use `TypingController`; the indicator only clears when both "model finished" and "reply delivered" arrive.

For the systematic story — `ReplyDispatcher` queueing/throttling, `MessageReceipt`, broadcast scope and frame reuse — see [Chapter 04 §4 (send/receive runtime)](04-channel-layer.md), [Chapter 11 §6 (delivery receipts)](11-delivery-and-events.md), and [Chapter 12 §7 (Canvas / WS push)](12-web-ui-canvas.md).

## 8. What you should now have in your head

- A reply reaches the user on **two parallel tracks**: the **delivery path** (`ReplyDispatcher` → `routeReplyToOriginating` → WebChat, reply-as-reply handling) and the **broadcast path** (`server-chat.ts` projector → `broadcast` → WebSocket clients, real-time fan-out to all observers).
- The gateway broadcasts only two top-level events for assistant content: `"agent"` and `"chat"`. `"chat"` uses a `state` field (`delta` / `final` / `error` / `aborted`) for sub-typing. There is no `chat_message_text` event.
- The typewriter effect comes from `emitChatDelta` (150 ms throttled `state: "delta"`); the final lock-in comes from `emitChatFinal` (which calls `flushBufferedChatDeltaIfNeeded` first so the user does not miss the last fragment).
- Broadcast is never bare `socket.send`. `createGatewayBroadcaster` fans out to all authorized clients, runs `READ_SCOPE` filtering (transcripts are operator-sensitive), and applies slow-consumer protection (drop or `1008` close).
- WebChat is gateway's built-in channel (`INTERNAL_MESSAGE_CHANNEL = "webchat"`); the reply never leaves the gateway process. External channels go through `sendDurableMessageBatch` — there is no `sendChannelMessage` function in the codebase.
