# Chapter 11: Reply Delivery & Event Stream

Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 0. What this chapter answers

Chapter 07 closes with the agent runner producing a stream of events:
assistant text deltas, tool calls, tool results, model errors, lifecycle
phase transitions. Chapter 06 explained where those events get persisted
(the JSONL transcript) and broadcast (the `transcript-events.ts` channel).

This chapter answers what happens between **"the model produced output"**
and **"the human's screen lit up"** — and there is a lot more between
those two points than a single function call. The gateway has four
simultaneous responsibilities:

1. **Deliver the final assistant reply** to the channel that originally
   asked: Telegram, Signal, WhatsApp, WebChat, etc. That delivery must
   survive transient channel failures and survive process restarts.
2. **Broadcast streaming events** to every connected WebSocket client (the
   Chapter 12 UI) so that the operator can watch the model think in
   real time, see tool calls, see compaction status — even on a session
   they did not initiate.
3. **Run the typing indicator** on slow channels: start it when the model
   begins working, refresh it without spamming, stop it when the reply
   arrives or the run aborts.
4. **Avoid duplicates.** A retried webhook, a re-delivered queue entry, a
   reactivated subagent run, a re-broadcast announce — none of these
   must produce a second copy of the reply.

The naive answer ("send the text when the model is done") fails every one
of these. Reply delivery is a small distributed system. The rest of this
chapter is a tour of the components that make it work.

<svg viewBox="0 0 820 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Two-track event flow: durable delivery to channels and WebSocket broadcast to clients">
  <defs>
    <marker id="r111arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="270" y="14" width="280" height="56" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="410" y="38" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">AgentEventPayload stream</text>
  <text x="410" y="54" text-anchor="middle" font-size="10" fill="#64748b">{ runId, seq, stream, ts, data, errorKind? }</text>
  <text x="410" y="66" text-anchor="middle" font-size="10" fill="#94a3b8">from agent runner (Ch 07)</text>
  <line x1="410" y1="72" x2="410" y2="92" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#r111arrow)"/>
  <line x1="220" y1="98" x2="600" y2="98" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="220" y1="98" x2="220" y2="120" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#r111arrow)"/>
  <line x1="600" y1="98" x2="600" y2="120" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#r111arrow)"/>
  <rect x="80" y="120" width="280" height="40" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="220" y="138" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">Delivery track (channels)</text>
  <text x="220" y="153" text-anchor="middle" font-size="10" fill="#64748b">src/auto-reply/reply/reply-dispatcher.ts</text>
  <rect x="460" y="120" width="280" height="40" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="600" y="138" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">Broadcast track (WebSocket)</text>
  <text x="600" y="153" text-anchor="middle" font-size="10" fill="#64748b">src/gateway/server-chat.ts (sendAgentPayload)</text>
  <line x1="220" y1="160" x2="220" y2="180" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#r111arrow)"/>
  <line x1="600" y1="160" x2="600" y2="180" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#r111arrow)"/>
  <rect x="80" y="180" width="280" height="60" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="220" y="200" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ReplyDispatcher</text>
  <text x="220" y="216" text-anchor="middle" font-size="10" fill="#64748b">enqueue / normalize / serialize</text>
  <text x="220" y="230" text-anchor="middle" font-size="10" fill="#64748b">tool, block, final  (human-like delays)</text>
  <rect x="460" y="180" width="280" height="60" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="600" y="200" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">createGatewayBroadcaster</text>
  <text x="600" y="216" text-anchor="middle" font-size="10" fill="#64748b">per-client scope filter + frame</text>
  <text x="600" y="230" text-anchor="middle" font-size="10" fill="#64748b">dropIfSlow / close slow consumers</text>
  <line x1="220" y1="240" x2="220" y2="260" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#r111arrow)"/>
  <line x1="600" y1="240" x2="600" y2="260" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#r111arrow)"/>
  <rect x="80" y="260" width="280" height="60" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="220" y="280" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">deliverInboundReply...</text>
  <text x="220" y="296" text-anchor="middle" font-size="10" fill="#64748b">sendDurableMessageBatch -&gt; queue</text>
  <text x="220" y="310" text-anchor="middle" font-size="10" fill="#64748b">channel adapter -&gt; MessageReceipt</text>
  <rect x="460" y="260" width="280" height="60" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="600" y="280" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">broadcast(event, payload)</text>
  <text x="600" y="296" text-anchor="middle" font-size="10" fill="#64748b">type=event, seq, payload, stateVersion</text>
  <text x="600" y="310" text-anchor="middle" font-size="10" fill="#64748b">events: agent / chat / session.message</text>
  <line x1="220" y1="320" x2="220" y2="340" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#r111arrow)"/>
  <line x1="600" y1="320" x2="600" y2="340" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#r111arrow)"/>
  <rect x="80" y="340" width="280" height="44" rx="5" fill="#fef3c7" stroke="#d97706" stroke-width="1.2"/>
  <text x="220" y="360" text-anchor="middle" font-size="11" font-weight="600" fill="#d97706">delivery-queue (durable retry)</text>
  <text x="220" y="376" text-anchor="middle" font-size="10" fill="#64748b">backoff: 5s -&gt; 25s -&gt; 2m -&gt; 10m -&gt; max 5</text>
  <rect x="460" y="340" width="280" height="44" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="600" y="360" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">connected WS clients</text>
  <text x="600" y="376" text-anchor="middle" font-size="10" fill="#64748b">Control UI / WebChat / nodes</text>
  <line x1="220" y1="384" x2="220" y2="406" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#r111arrow)"/>
  <rect x="80" y="406" width="280" height="40" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="220" y="426" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">External channel (Telegram, Signal, ...)</text>
  <text x="220" y="440" text-anchor="middle" font-size="10" fill="#64748b">platform message id back into receipt</text>
</svg>
<span class="figure-caption">Figure R11.1 | Two parallel tracks from an agent event stream: durable delivery to the originating channel and best-effort WebSocket broadcast to every connected UI client.</span>

<details><summary>ASCII original</summary>

```
                AgentEventPayload stream (from agent runner, Ch 07)
                              |
                +-------------+-------------+
                |                           |
         Delivery track             Broadcast track
                |                           |
        ReplyDispatcher           createGatewayBroadcaster
        enqueue+normalize         per-client scope + frame
        tool/block/final          dropIfSlow / close slow
                |                           |
        deliverInboundReply...     broadcast(event, payload)
        sendDurableMessageBatch    type=event + seq + payload
                |                           |
        delivery-queue (durable    connected WS clients:
        retry: 5s,25s,2m,10m;       Control UI, WebChat,
        max 5 attempts)            nodes
                |
        external channel
        (Telegram, Signal, ...)
        platform message id -> MessageReceipt
```

</details>

## 1. The ReplyDispatcher: ordering, normalization, idle-tracking

`src/auto-reply/reply/reply-dispatcher.ts` is the gateway-internal coordinator that an agent run hands its replies to. It is a small object factory whose constructor returns three send methods plus four observability calls:

```ts
// src/auto-reply/reply/reply-dispatcher.types.ts:3
export type ReplyDispatchKind = "tool" | "block" | "final";

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

Three kinds of payload exist because they have different semantics for the
human reader:

- `tool`  — a tool call's user-visible result (or its preview). The
  dispatcher delivers it as soon as the tool finishes; tool messages do
  not wait for the model to finish thinking.
- `block` — a self-contained text or media block that the model has
  already finalised mid-turn. Two consecutive `block` payloads get a
  human-like delay between them so a long answer arrives as a paced
  sequence of bubbles rather than a wall of text.
- `final` — the closing reply of the turn. Marked as final so durable
  delivery knows this is the bit that has to survive a crash.

Internally the dispatcher serialises everything through a single Promise
chain:

```ts
// src/auto-reply/reply/reply-dispatcher.ts:122
export function createReplyDispatcher(options: ReplyDispatcherOptions): ReplyDispatcher {
  let sendChain: Promise<void> = Promise.resolve();
  let pending = 1;          // 1 = reservation, prevents premature idle
  let completeCalled = false;
  let sentFirstBlock = false;
  const queuedCounts: Record<ReplyDispatchKind, number> = { tool: 0, block: 0, final: 0 };
  const failedCounts: Record<ReplyDispatchKind, number> = { tool: 0, block: 0, final: 0 };
  const cancelledCounts: Record<ReplyDispatchKind, number> = { tool: 0, block: 0, final: 0 };
  const { unregister } = registerDispatcher({ pending: () => pending, waitForIdle: () => sendChain });
  ...
```

The `sendChain` is the heart of the ordering guarantee: every `enqueue`
call appends to the chain, so even if `sendToolResult(t1)` and
`sendBlockReply(b1)` are called back-to-back, `b1` waits for `t1` to
finish before its `options.deliver(...)` runs. Without that chain, an
asynchronous channel adapter could reorder tool output and assistant
text into the wrong sequence on the wire.

The reservation (`pending = 1` at construction) is the second subtle
invariant. The gateway has a global "dispatcher idle" tracker
(`registerDispatcher` at line 153) that downstream code consults before
restarting the gateway. The reservation guarantees that a freshly created
dispatcher whose first `enqueue` hasn't yet landed is **not** observably
idle. Only `markComplete()` clears it.

The actual enqueue body is the part that explains the in-order delivery
and the human-delay rule:

```ts
// src/auto-reply/reply/reply-dispatcher.ts:155
const enqueue = (kind: ReplyDispatchKind, payload: ReplyPayload) => {
  const originalWasExactSilent = isSilentReplyText(payload.text, SILENT_REPLY_TOKEN);
  const normalized = normalizeReplyPayloadInternal(payload, {
    responsePrefix: options.responsePrefix,
    responsePrefixContext: options.responsePrefixContext,
    responsePrefixContextProvider: options.responsePrefixContextProvider,
    transformReplyPayload: options.transformReplyPayload,
    onHeartbeatStrip: options.onHeartbeatStrip,
    onSkip: (reason) => options.onSkip?.(payload, { kind, reason }),
  });
  if (!normalized) { /* silent / empty payload */ return false; }
  queuedCounts[kind] += 1;
  pending += 1;
  const shouldDelay = kind === "block" && sentFirstBlock;
  if (kind === "block") sentFirstBlock = true;
  sendChain = sendChain
    .then(async () => {
      if (shouldDelay) {
        const delayMs = getHumanDelay(options.humanDelay);
        if (delayMs > 0) await sleep(delayMs);
      }
      let deliverPayload: ReplyPayload | null = normalized;
      if (options.beforeDeliver) {
        deliverPayload = await options.beforeDeliver(normalized, { kind });
        if (!deliverPayload) { cancelledCounts[kind] += 1; return; }
      }
      await options.deliver(deliverPayload, { kind });
    })
    ...
};
```

Three observations on this body:

- The **first** block reply skips the human delay (`sentFirstBlock` starts
  false). Only the second and subsequent blocks get a 0.8–2.5 second
  scheduled wait between them; the first arrives as fast as the channel
  will accept it.
- The **delay value** is generated by `generateSecureInt` (line 50),
  which is `getHumanDelay` in disguise — bounded uniform from a CSPRNG.
  This is just a touch over-engineered for the use case, but it ensures
  there is no observable timing fingerprint.
- The `beforeDeliver` hook gets to **veto** a normalised payload. That's
  what session-level send-policy and channel-side guards plug into.

`options.deliver` is the host-supplied function that actually turns a
normalised `ReplyPayload` into a channel send. For inbound replies this
ultimately routes through `deliverInboundReplyWithMessageSendContext`
(`src/channels/turn/durable-delivery.ts:110`) — see §6.

## 2. The `ReplyPayload` shape

`ReplyPayload` is the channel-agnostic envelope every produced reply
flows through. It is small enough to read in one sitting:

```ts
// src/auto-reply/reply-payload.ts:6
export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  trustedLocalMedia?: boolean;
  sensitiveMedia?: boolean;
  presentation?: MessagePresentation;
  delivery?: ReplyPayloadDelivery;
  interactive?: InteractiveReply;       // @deprecated
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
  isStatusNotice?: boolean;
  channelData?: Record<string, unknown>;
};
```

Three groups of fields:

| Group | Fields | Purpose |
|------|--------|--------|
| Content | `text`, `mediaUrl`, `mediaUrls`, `presentation`, `interactive`, `btw`, `spokenText`, `ttsSupplement` | The actual bytes the user will see/hear |
| Delivery hints | `replyToId`, `replyToTag`, `replyToCurrent`, `audioAsVoice`, `delivery`, `channelData` | Channel-specific behaviour: reply threading, pin, voice bubble, raw envelope |
| Semantic flags | `isError`, `isReasoning`, `isCompactionNotice`, `isFallbackNotice`, `isStatusNotice`, `trustedLocalMedia`, `sensitiveMedia` | Routing/visibility metadata channels use to suppress, render specially, or transform |

The `isReasoning` flag is a representative example of why these flags
matter. WhatsApp does not have a dedicated reasoning lane, but
Control UI does. A reasoning trace marked `isReasoning: true` is fully
delivered to WebChat but is suppressed by the WhatsApp outbound adapter.
A single payload, two completely different fates per channel — and the
agent runner does not need to know which channel it's running into.

<svg viewBox="0 0 780 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ReplyPayload field groups and their consumers">
  <rect x="40" y="20" width="700" height="36" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="390" y="42" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">ReplyPayload  (src/auto-reply/reply-payload.ts:6)</text>
  <rect x="40" y="76" width="220" height="200" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="150" y="98" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">Content</text>
  <text x="52" y="120" font-size="11" fill="#64748b">text?: string</text>
  <text x="52" y="138" font-size="11" fill="#64748b">mediaUrl?: string</text>
  <text x="52" y="156" font-size="11" fill="#64748b">mediaUrls?: string[]</text>
  <text x="52" y="174" font-size="11" fill="#64748b">presentation?: ...</text>
  <text x="52" y="192" font-size="11" fill="#64748b">interactive?: ... (deprecated)</text>
  <text x="52" y="210" font-size="11" fill="#64748b">btw?: { question }</text>
  <text x="52" y="228" font-size="11" fill="#64748b">spokenText?: string</text>
  <text x="52" y="246" font-size="11" fill="#64748b">ttsSupplement?: ...</text>
  <text x="52" y="264" font-size="11" fill="#94a3b8">consumed by: outbound payload renderer</text>
  <rect x="280" y="76" width="220" height="200" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="390" y="98" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">Delivery hints</text>
  <text x="292" y="120" font-size="11" fill="#64748b">replyToId?: string</text>
  <text x="292" y="138" font-size="11" fill="#64748b">replyToTag?: boolean</text>
  <text x="292" y="156" font-size="11" fill="#64748b">replyToCurrent?: boolean</text>
  <text x="292" y="174" font-size="11" fill="#64748b">audioAsVoice?: boolean</text>
  <text x="292" y="192" font-size="11" fill="#64748b">delivery?: { pin?, ... }</text>
  <text x="292" y="210" font-size="11" fill="#64748b">channelData?: Record&lt;string, unknown&gt;</text>
  <text x="292" y="264" font-size="11" fill="#94a3b8">consumed by: channel adapter</text>
  <rect x="520" y="76" width="220" height="200" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="630" y="98" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">Semantic flags</text>
  <text x="532" y="120" font-size="11" fill="#64748b">isError?: boolean</text>
  <text x="532" y="138" font-size="11" fill="#64748b">isReasoning?: boolean</text>
  <text x="532" y="156" font-size="11" fill="#64748b">isCompactionNotice?: boolean</text>
  <text x="532" y="174" font-size="11" fill="#64748b">isFallbackNotice?: boolean</text>
  <text x="532" y="192" font-size="11" fill="#64748b">isStatusNotice?: boolean</text>
  <text x="532" y="210" font-size="11" fill="#64748b">trustedLocalMedia?: boolean</text>
  <text x="532" y="228" font-size="11" fill="#64748b">sensitiveMedia?: boolean</text>
  <text x="532" y="264" font-size="11" fill="#94a3b8">consumed by: per-channel visibility</text>
  <rect x="40" y="296" width="700" height="60" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.2"/>
  <text x="390" y="320" text-anchor="middle" font-size="12" font-weight="700" fill="#d97706">Accumulated from the agent event stream</text>
  <text x="390" y="338" text-anchor="middle" font-size="10" fill="#64748b">text deltas concatenate; tool calls become block payloads; media events fill mediaUrls;</text>
  <text x="390" y="352" text-anchor="middle" font-size="10" fill="#64748b">stop event triggers final payload assembly; compaction events become isCompactionNotice payloads</text>
  <rect x="40" y="376" width="700" height="60" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="390" y="400" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Materialises into a MessageReceipt after deliverInboundReplyWithMessageSendContext</text>
  <text x="390" y="416" text-anchor="middle" font-size="10" fill="#64748b">MessageReceipt = { platformMessageIds, parts, sentAt, primaryPlatformMessageId? }</text>
  <text x="390" y="430" text-anchor="middle" font-size="10" fill="#64748b">listMessageReceiptPlatformIds(receipt) -&gt; messageIds for the ChannelDeliveryResult</text>
</svg>
<span class="figure-caption">Figure R11.2 | ReplyPayload field groups, accumulated from the agent event stream and materialised into a MessageReceipt after channel delivery.</span>

<details><summary>ASCII original</summary>

```
ReplyPayload  (auto-reply/reply-payload.ts:6)
+----------------+----------------+----------------+
|   Content      |  Delivery hint |  Semantic flag |
| text           | replyToId      | isError        |
| mediaUrl(s)    | replyToTag     | isReasoning    |
| presentation   | audioAsVoice   | isCompactionN. |
| interactive    | delivery       | isFallbackN.   |
| btw            | channelData    | isStatusN.     |
| spokenText     |                | trustedLocal.  |
| ttsSupplement  |                | sensitiveMedia |
+----------------+----------------+----------------+
   |
   | accumulated from agent event stream
   v
MessageReceipt = { platformMessageIds, parts, sentAt, primary? }
```

</details>

### Where the payload is built

The agent event stream lands in the gateway via `sendAgentPayload`
(`src/gateway/server-chat.ts:670`) and is concurrently consumed by:

- The **WebSocket broadcaster** (§7), which forwards the raw events as-is.
- The **transcript appender**, which persists them into the JSONL log.
- The **block reply pipeline** at `src/auto-reply/reply/block-reply-pipeline.ts`,
  which buffers text deltas until a stop reason or paragraph boundary
  triggers a `sendBlockReply()` call into the dispatcher above.
- The **final payload assembler**, which on the run's `stop` event coalesces
  any unsent text plus media attachments into the closing `sendFinalReply()`.

Two of those consumers can mutate the dispatcher's view of the payload —
the agent text helper at `src/gateway/agent-event-assistant-text.ts:1`
trivially extracts the text delta so the block pipeline can grow its
buffer:

```ts
// src/gateway/agent-event-assistant-text.ts:1
import type { AgentEventPayload } from "../infra/agent-events.js";

export function resolveAssistantStreamDeltaText(evt: AgentEventPayload): string {
  const delta = evt.data.delta;
  const text = evt.data.text;
  return typeof delta === "string" ? delta : typeof text === "string" ? text : "";
}
```

That tiny helper exists because the upstream provider events use either
`delta` (incremental) or `text` (whole) keys depending on the streaming
mode; both consumers must agree on which one means "new text".

## 3. Stream-error placeholder filtering (PR #85652)

When the model upstream fails mid-stream — TCP reset, 5xx, malformed JSON,
provider timeout — the agent runner cannot just stop. The current attempt
must be **terminated** as an assistant turn in the transcript so that the
history is well-formed, so that the next user message has a syntactically
valid prior context. The runner accomplishes this by appending a special
"stream-error placeholder" assistant message:

```ts
// src/agents/stream-message-shared.ts:85
// raw provider error text is intentionally NOT placed in `content` because that
// array is replayed back to the model on the next turn — provider error strings
// can carry hostnames or upstream metadata, and replaying them as assistant
// content opens a prompt-injection surface (CWE-200). The detailed error stays
// in the peer `errorMessage` field, which clients/UIs read directly and
// providers do not include in their wire payloads.
export const STREAM_ERROR_FALLBACK_TEXT = "[assistant turn failed before producing content]";

export function buildStreamErrorAssistantMessage(params: {
  model: StreamModelDescriptor;
  errorMessage: string;
  timestamp?: number;
}): AssistantMessage & { stopReason: "error"; errorMessage: string } {
  return {
    ...buildAssistantMessageWithZeroUsage({
      model: params.model,
      content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
      stopReason: "error",
      timestamp: params.timestamp,
    }),
    stopReason: "error",
    errorMessage: params.errorMessage,
  };
}
```

The header comment explains the design crisply: the **content** must be a
constant string ("[assistant turn failed before producing content]") so
that the transcript remains well-formed, and the actual error text
remains in a **peer field** that providers never replay. This is a
deliberate prompt-injection defence: a provider error message can include
attacker-controlled hostnames or upstream payloads (think SSRF or 4xx
bodies); embedding that text into the assistant content would silently
slip it into the next prompt.

The constant `[assistant turn failed before producing content]` shows up
in three places: the runner appends it on stream error; the replay
history normaliser (`src/agents/pi-embedded-runner/replay-history.ts:406`)
restores it on replay; and `src/agents/session-file-repair.ts:96` writes
it when repairing a torn JSONL on startup. All three paths share the
exact same string so an offline repair reads identically to a live
stream-error turn.

### The bug PR #85652 fixed

Before commit `57b956fd7c`, the gateway's prompt builder
(`src/gateway/agent-prompt.ts:1`) walked the conversation entries and
emitted **every** assistant entry into the next turn's history — including
the placeholder. That meant the next user message saw the literal text
`[assistant turn failed before producing content]` as the last assistant
line, and the model would frequently respond apologetically to a
non-existent failure ("Sorry I failed earlier!"), or worse, hallucinate
context around the placeholder.

The fix is small and surgical. The conversation entries now carry an
`internalStreamError` flag, and the prompt builder drops any assistant
entry whose body equals the placeholder **and** whose `internalStreamError`
is true:

```ts
// src/gateway/agent-prompt.ts:5
export type ConversationEntry = {
  role: "user" | "assistant" | "tool";
  entry: HistoryEntry;
  internalStreamError?: boolean;
};

function toPromptEntry(entry: ConversationEntry): HistoryEntry | null {
  const body = safeBody(entry.entry.body);
  if (
    entry.role === "assistant" &&
    entry.internalStreamError === true &&
    body.trim() === STREAM_ERROR_FALLBACK_TEXT
  ) {
    return null;
  }
  return { ...entry.entry, body };
}
```

Three properties of this filter are important:

- It is **role-gated**: only assistant entries are dropped. A user or
  tool entry whose body coincidentally matches the placeholder string is
  preserved. (The test at `src/gateway/agent-prompt.test.ts:130` exists
  to lock this in.)
- It is **provenance-gated**: an assistant entry from the transcript that
  matches the placeholder **without** the `internalStreamError` marker
  is preserved. The test at line 140 of the same file pins this down —
  any historical transcript that doesn't carry the marker is treated as
  ordinary text, no matter what it says.
- It is **substring-immune**: the comparison is `body.trim() ===
  STREAM_ERROR_FALLBACK_TEXT`, not `includes(...)`. An assistant message
  that legitimately quotes the placeholder string as part of a longer
  answer (a diagnostic note, a "the system emitted this:" preamble)
  survives. The test at line 119 covers this.

Together the three properties mean the fix removes exactly the right
messages and nothing else. The release notes for this commit list six
follow-up commits that hardened adjacent edge cases (`filter placeholder
by role`, `preserve current prompt text`, `mark internal stream-error
prompt entries`, `preserve empty tool prompt entries`); each of them
exists to keep that "remove exactly the right messages" property intact
under different shapes of history.

## 4. Typing indicators: keepalive without spam

A long-running model call can run for many minutes. The user staring at
their Telegram window deserves some signal that work is in progress, but
the channel adapters all rate-limit typing-indicator updates and most
auto-expire them after a few seconds. The naive answer ("fire `start
typing` once") leaves the indicator dropping silently after 3-5 seconds.

The keepalive lives in `src/channels/typing-lifecycle.ts:1` and is a tiny
state machine that schedules `onTick` (the channel's actual "still
typing" call) at a fixed cadence as long as the loop is running:

```ts
// src/channels/typing-lifecycle.ts:11
export function createTypingKeepaliveLoop(params: {
  intervalMs: number;
  onTick: AsyncTick;
}): TypingKeepaliveLoop {
  let timer: ReturnType<typeof setInterval> | undefined;
  let tickInFlight = false;
  const tick = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try { await params.onTick(); }
    finally { tickInFlight = false; }
  };
  const start = () => {
    if (params.intervalMs <= 0 || timer) return;
    timer = setInterval(() => { void tick(); }, params.intervalMs);
  };
  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    tickInFlight = false;
  };
  ...
};
```

The `tickInFlight` guard exists because the channel adapter call is
async, and a slow channel could pile up overlapping calls if a second
tick fires while the first is still in flight. The guard makes the loop
inherently rate-limited to "no more than one in flight at a time", which
is what every channel API documents as the correct cadence.

The orchestrator above the keepalive is `createTypingCallbacks` in
`src/channels/typing.ts:23`. It wires together three signals — start,
idle, cleanup — and adds two layers of safety:

```ts
// src/channels/typing.ts:23
export function createTypingCallbacks(params: CreateTypingCallbacksParams): TypingCallbacks {
  const stop = params.stop;
  const keepaliveIntervalMs = params.keepaliveIntervalMs ?? 3_000;
  const maxConsecutiveFailures = Math.max(1, params.maxConsecutiveFailures ?? 2);
  const maxDurationMs = params.maxDurationMs ?? 60_000;
  let stopSent = false;
  let closed = false;
  let ttlTimer: ReturnType<typeof setTimeout> | undefined;
  const startGuard = createTypingStartGuard({
    isSealed: () => closed,
    onStartError: params.onStartError,
    maxConsecutiveFailures,
    onTrip: () => { keepaliveLoop.stop(); },
  });
  ...
```

The two safety layers are:

- **Start-failure trip.** `createTypingStartGuard` (in
  `src/channels/typing-start-guard.ts`) counts consecutive `start()`
  errors. After `maxConsecutiveFailures` (default 2), it stops the
  keepalive entirely. If Telegram is refusing typing events because the
  bot was blocked, OpenClaw will not retry forever.
- **TTL fallback.** A `maxDurationMs` (default 60 seconds) timer
  auto-stops the indicator regardless of run state. If the run ends
  abnormally without calling `onIdle`, the user is not stuck staring at
  a perpetually typing bot.

The state machine itself is a four-state ring: idle → typing → stopped,
plus a "tripped" terminal sub-state of typing.

<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Typing indicator state machine with keepalive, trip, and TTL transitions">
  <defs>
    <marker id="r113arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <circle cx="120" cy="120" r="56" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.6"/>
  <text x="120" y="116" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">idle</text>
  <text x="120" y="134" text-anchor="middle" font-size="10" fill="#64748b">no timer</text>
  <circle cx="380" cy="120" r="60" fill="#fed7aa" stroke="#ea580c" stroke-width="1.6"/>
  <text x="380" y="110" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">typing</text>
  <text x="380" y="128" text-anchor="middle" font-size="10" fill="#64748b">start() pinged</text>
  <text x="380" y="144" text-anchor="middle" font-size="10" fill="#64748b">keepalive @ 3s</text>
  <text x="380" y="160" text-anchor="middle" font-size="10" fill="#64748b">TTL timer armed</text>
  <circle cx="640" cy="120" r="56" fill="#99f6e4" stroke="#0d9488" stroke-width="1.6"/>
  <text x="640" y="116" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">stopped</text>
  <text x="640" y="134" text-anchor="middle" font-size="10" fill="#64748b">stop() emitted once</text>
  <circle cx="380" cy="320" r="56" fill="#fee2e2" stroke="#dc2626" stroke-width="1.6"/>
  <text x="380" y="316" text-anchor="middle" font-size="13" font-weight="700" fill="#dc2626">tripped</text>
  <text x="380" y="334" text-anchor="middle" font-size="10" fill="#64748b">N consecutive errors</text>
  <line x1="176" y1="120" x2="316" y2="120" stroke="#94a3b8" stroke-width="1.6" marker-end="url(#r113arrow)"/>
  <text x="246" y="110" text-anchor="middle" font-size="10" fill="#64748b">onReplyStart()</text>
  <line x1="440" y1="120" x2="580" y2="120" stroke="#94a3b8" stroke-width="1.6" marker-end="url(#r113arrow)"/>
  <text x="510" y="110" text-anchor="middle" font-size="10" fill="#64748b">onIdle() / TTL fires</text>
  <path d="M380,180 C380,230 380,260 380,260" stroke="#dc2626" stroke-width="1.4" fill="none" marker-end="url(#r113arrow)"/>
  <text x="396" y="222" font-size="10" fill="#dc2626">start() failed N times</text>
  <path d="M412,290 C470,260 540,180 600,148" stroke="#94a3b8" stroke-width="1.4" stroke-dasharray="4,3" fill="none" marker-end="url(#r113arrow)"/>
  <text x="556" y="226" font-size="10" fill="#94a3b8">finally: stop()</text>
  <rect x="40" y="380" width="680" height="32" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="400" text-anchor="middle" font-size="11" fill="#64748b">tickInFlight guard ensures the keepalive is self-rate-limited: at most one in-flight typing call at any moment</text>
</svg>
<span class="figure-caption">Figure R11.3 | The typing indicator state machine: idle, typing (with keepalive and TTL armed), stopped, and the failure-tripped terminal state.</span>

<details><summary>ASCII original</summary>

```
                 onReplyStart()                onIdle() / TTL fires
  [ idle ] ------------------> [ typing ] ------------------> [ stopped ]
                                  |  keepalive @ 3s
                                  |  TTL timer (60s)
                                  v
                              [ tripped ]  start() failed N times
                                  | finally: stop()
                                  v
                              [ stopped ]
```

</details>

## 5. Ack reactions: lightweight delivery receipts

Some channels do not need typing indicators (web UIs, channels that
already render bot status). What they do appreciate is a small emoji
reaction on the user's inbound message saying "I got it; I'm working".
That is the ack-reaction system at `src/channels/ack-reactions.ts:1`.

The gating logic is centralised in `shouldAckReaction`:

```ts
// src/channels/ack-reactions.ts:22
export function shouldAckReaction(params: AckReactionGateParams): boolean {
  const scope = params.scope ?? "group-mentions";
  if (scope === "off" || scope === "none") return false;
  if (scope === "all") return true;
  if (scope === "direct") return params.isDirect;
  if (scope === "group-all") return params.isGroup;
  if (scope === "group-mentions") {
    if (!params.isMentionableGroup) return false;
    if (!params.requireMention) return false;
    if (!params.canDetectMention) return false;
    return params.effectiveWasMentioned || params.shouldBypassMention === true;
  }
  return false;
}
```

Six scopes encode the deployment-time policy: `off`/`none` disable
reactions entirely; `all` is the noisy mode for testing; `direct` reacts
only on DMs; `group-all` reacts on every group message addressed to the
bot; `group-mentions` (the default) reacts only when the bot was
mentioned.

The lifetime of an ack reaction is wrapped in `AckReactionHandle`:

```ts
// src/channels/ack-reactions.ts:6
export type AckReactionHandle = {
  ackReactionPromise: Promise<boolean>;
  ackReactionValue: string;
  remove: () => Promise<void>;
};
```

The `ackReactionPromise` resolves to whether the platform actually
accepted the reaction (it may fail silently — the channel might have
been deleted, the bot might have been blocked). `removeAckReactionAfterReply`
(line 119) then optionally clears it once the real reply has been sent;
the reaction was the "I'm working" hint, and once the work is delivered
the hint becomes stale.

This is one place where OpenClaw deliberately uses **two signals** for
the same human concept ("the bot is working"): the ack reaction is a
durable, message-scoped marker; the typing indicator is a transient,
chat-scoped marker. Different channels prefer different signals, and
some support both at once.

## 6. Durable delivery: from ReplyPayload to channel send

When the dispatcher calls `options.deliver(payload, { kind: "final" })`,
the host-provided deliverer for inbound replies is
`deliverInboundReplyWithMessageSendContext` (`src/channels/turn/durable-delivery.ts:110`). Its job is to translate a `ReplyPayload` into a `sendDurableMessageBatch` call and return a `ChannelDeliveryResult`:

```ts
// src/channels/turn/durable-delivery.ts:110
export async function deliverInboundReplyWithMessageSendContext(
  params: DurableInboundReplyDeliveryParams,
): Promise<DurableInboundReplyDeliveryResult> {
  if (params.info.kind !== "final") {
    return { status: "not_applicable", reason: "non_final" };
  }
  const channel = normalizeDeliverableOutboundChannel(params.channel);
  const to = resolveDeliveryTarget(params);
  if (!channel) return { status: "unsupported", reason: "missing_channel" };
  if (!to) return { status: "unsupported", reason: "missing_target" };
  const replyToId = resolveDurableInboundReplyToId(params);
  const threadId = resolveDurableInboundReplyThreadId(params);
  const requiredCapabilities =
    params.requiredCapabilities ??
    deriveDurableFinalDeliveryRequirements({
      payload: params.payload,
      replyToId,
      threadId,
      silent: params.silent,
    });
  const durability =
    requiredCapabilities.reconcileUnknownSend === true ? "required" : "best_effort";
  ...
```

The result type enumerates every possible outcome (`src/channels/turn/durable-delivery.ts:38`):

```ts
// src/channels/turn/durable-delivery.ts:38
export type DurableInboundReplyDeliveryResult =
  | { status: "not_applicable"; reason: "non_final" }
  | { status: "unsupported"; reason:
       | "missing_channel" | "missing_target" | "missing_outbound_handler"
       | "capability_mismatch"; capability?: DurableFinalDeliveryRequirement }
  | { status: "handled_visible"; delivery: ChannelDeliveryResult }
  | { status: "handled_no_send"; reason: "no_visible_result"; delivery: ChannelDeliveryResult }
  | { status: "failed"; error: unknown };
```

Five outcomes, in order of "did the user see anything":

- `handled_visible` — the channel sent the message and the platform
  returned a message id. The receipt is attached.
- `handled_no_send` — nothing was sent (e.g. `silent: true`), but the
  delivery is "complete" — no retry is warranted.
- `unsupported` — the channel cannot deliver this payload (no outbound
  handler, missing recipient, capability mismatch). The caller decides
  whether to fall back or surface.
- `not_applicable` — this dispatcher kind isn't a `final` — the durable
  path skipped it.
- `failed` — the send raised. The error propagates; the queue layer
  (§9) takes over.

The platform message id round-trips back into a `MessageReceipt`:

```ts
// src/channels/turn/delivery-result.ts:6
export function createChannelDeliveryResultFromReceipt(params: {
  receipt: MessageReceipt;
  threadId?: string;
  replyToId?: string;
  visibleReplySent?: boolean;
  deliveryIntent?: ChannelDeliveryIntent;
}): ChannelDeliveryResult {
  const messageIds = listMessageReceiptPlatformIds(params.receipt);
  return {
    ...(messageIds.length > 0 ? { messageIds } : {}),
    receipt: params.receipt,
    ...(params.threadId ? { threadId: params.threadId } : {}),
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    ...(params.visibleReplySent === undefined ? {} : { visibleReplySent: params.visibleReplySent }),
    ...(params.deliveryIntent ? { deliveryIntent: params.deliveryIntent } : {}),
  };
}
```

That receipt is what the next inbound message uses for `replyToId`
threading, and what session-persistence uses to mark the entry's
`pendingFinalDelivery*` fields cleared (see Chapter 06 §2 and
`src/auto-reply/reply/dispatch-from-config.ts:628`).

## 7. Event broadcast to UI

The broadcaster track lives at `src/gateway/server-broadcast.ts:1`. It
exposes two functions a chat-side caller uses:

```ts
// src/gateway/server-broadcast.ts:95
export function createGatewayBroadcaster(params: { clients: Set<GatewayWsClient> }) {
  const clientSeq = new WeakMap<GatewayWsClient, number>();
  const reportedSlowPayloadClients = new WeakSet<GatewayWsClient>();
  const broadcastInternal = (
    event: string,
    payload: unknown,
    opts?: GatewayBroadcastOpts,
    targetConnIds?: ReadonlySet<string>,
  ) => {
    if (params.clients.size === 0) return;
    ...
  };
  const broadcast: GatewayBroadcastFn = (event, payload, opts) =>
    broadcastInternal(event, payload, opts);
  const broadcastToConnIds: GatewayBroadcastToConnIdsFn = (event, payload, connIds, opts) => {
    if (connIds.size === 0) return;
    broadcastInternal(event, payload, opts, connIds);
  };
  return { broadcast, broadcastToConnIds };
}
```

Three properties of the broadcaster matter for delivery semantics:

- **Per-client sequence numbers.** `clientSeq` assigns a monotone seq per
  WebSocket connection. Each frame includes its `seq` so the client can
  detect gaps (a missed frame from a slow consumer).
- **Scope guards.** `EVENT_SCOPE_GUARDS` (line 21) maps each event name
  to the WS scope required to receive it. A node-role connection only
  receives `voicewake.*` and the bare-minimum signalling events; a
  pairing-scope connection cannot listen to chat. The check is at line 64
  (`hasEventScope`).
- **Slow-consumer protection.** Every send checks
  `c.socket.bufferedAmount > MAX_BUFFERED_BYTES` (`src/gateway/server-broadcast.ts:151`).
  If the client is slow and the call asked for `dropIfSlow`, the frame
  is dropped silently and the client's seq still advances (so the client
  sees a gap and can re-fetch). If the client is slow and `dropIfSlow`
  was **not** set, the broadcaster closes the socket with `1008 "slow
  consumer"` (line 168) — the client must reconnect rather than back up
  the gateway with megabytes of buffered events.

The agent event chain on the broadcast side reads as follows from
`src/gateway/server-chat.ts`. Every agent event passes through
`sendAgentPayload`:

```ts
// src/gateway/server-chat.ts:670
const sendAgentPayload = (
  sessionKey: string | undefined,
  payload: AgentEventPayload & { spawnedBy?: string },
) => {
  broadcast("agent", payload);
  if (sessionKey) {
    nodeSendToSession(sessionKey, "agent", payload);
  }
};
```

Notice two destinations: the top-level WebSocket broadcaster (Control UI
/ WebChat) and the node fan-out (`nodeSendToSession`) which forwards to
remote node-role connections that watch that session. A single agent
event reaches all interested operators without any per-event routing
code — the scope filter inside `broadcastInternal` does that work.

The session-transcript and lifecycle channels feed the same broadcaster.
`createTranscriptUpdateBroadcastHandler` (`src/gateway/server-session-events.ts:84`)
takes a `SessionTranscriptUpdate` (from Chapter 06 §4), projects it
through `projectChatDisplayMessage`, and emits a `session.message` event:

```ts
// src/gateway/server-session-events.ts:139
const message = projectChatDisplayMessage(rawMessage);
if (message) {
  params.broadcastToConnIds(
    "session.message",
    {
      sessionKey,
      message,
      ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
      ...(messageSeq !== undefined ? { messageSeq } : {}),
      ...sessionSnapshot,
    },
    connIds,
    { dropIfSlow: true },
  );
}
```

`dropIfSlow: true` is the explicit acknowledgement that this is a
best-effort stream — losing a delta event during a long reply degrades
gracefully because the next event re-sends the updated full message, and
because the canonical state is the JSONL file on disk that the client
can re-read at any time.

## 8. Idempotency and dedup

Two distinct dedup problems live in this subsystem.

### 8.1 Per-channel message-id dedup

Each channel adapter is responsible for not re-sending a message whose
platform message id is already known. The mechanism is the
`MessageReceipt` carried through the queue: when a delivery completes
the queue entry is acknowledged with the receipt, and any later
re-delivery attempt for the same queue id is a no-op. The receipt's
`platformMessageIds` is what idempotency-aware adapters (Telegram,
Signal, …) check against the platform before issuing a second send.

### 8.2 Announce idempotency

Subagents can announce results back to their parent session. If the
runner reactivates a subagent run (orphan recovery, restart) and the
announce flag is still set, we must not double-announce. The mechanism
is at `src/agents/announce-idempotency.ts`:

```ts
// src/agents/announce-idempotency.ts:1
type AnnounceIdFromChildRunParams = {
  childSessionKey: string;
  childRunId: string;
};

export function buildAnnounceIdFromChildRun(params: AnnounceIdFromChildRunParams): string {
  return `v1:${params.childSessionKey}:${params.childRunId}`;
}

export function buildAnnounceIdempotencyKey(announceId: string): string {
  return `announce:${announceId}`;
}
```

Twelve lines. The announce id is a deterministic function of
`(childSessionKey, childRunId)` — both of which are persistent — so any
process that picks up the run later derives the same key. The idempotency
key is then used to scope a cache lookup before issuing the announce
into the parent's reply pipeline.

The `v1:` prefix is the schema version; a future format change can be
rolled out without colliding with stored keys. The wrapping namespace
`announce:` lets the same idempotency table host other event classes if
they ever need it.

## 9. Retry and backoff

The delivery queue (`src/infra/outbound/delivery-queue.ts:1` and the
recovery module `src/infra/outbound/delivery-queue-recovery.ts`) is where
durable retry actually happens. The queue is on disk
(`src/infra/outbound/delivery-queue-storage.ts`), so a queue entry
survives a gateway restart.

The backoff table is fixed:

```ts
// src/infra/outbound/delivery-queue-recovery.ts:54
const MAX_RETRIES = 5;

/** Backoff delays in milliseconds indexed by retry count (1-based). */
const BACKOFF_MS: readonly number[] = [
  5_000,   // retry 1: 5s
  25_000,  // retry 2: 25s
  120_000, // retry 3: 2m
  600_000, // retry 4: 10m
];
```

That's roughly five attempts spread over thirteen-ish minutes. The
exponential-ish (5x) factor is the conventional compromise: fast enough
to recover from a brief network glitch, slow enough not to hammer a
broken channel.

`computeBackoffMs` (line 323) is the queryable function; eligibility for
retry is a separate check that also handles the "first replay after
crash" case (line 333), where an entry that never even started its first
attempt is treated as eligible immediately:

```ts
// src/infra/outbound/delivery-queue-recovery.ts:323
export function computeBackoffMs(retryCount: number): number {
  if (retryCount <= 0) return 0;
  return BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1) ?? 0;
}

export function isEntryEligibleForRecoveryRetry(
  entry: QueuedDelivery,
  now: number,
): { eligible: true } | { eligible: false; remainingBackoffMs: number } {
  const backoff = computeBackoffMs(entry.retryCount + 1);
  if (backoff <= 0) return { eligible: true };
  const firstReplayAfterCrash = entry.retryCount === 0 && entry.lastAttemptAt === undefined;
  if (firstReplayAfterCrash) return { eligible: true };
  ...
```

Distinct from transient failure: some errors are permanent. The
`PERMANENT_ERROR_PATTERNS` list (`src/infra/outbound/delivery-queue-recovery.ts:65`)
encodes the "do not retry" verdicts:

```ts
// src/infra/outbound/delivery-queue-recovery.ts:65
const PERMANENT_ERROR_PATTERNS: readonly RegExp[] = [
  /no conversation reference found/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /chat_id is empty/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
  /ambiguous .* recipient/i,
  /User .* not in room/i,
];

export function isPermanentDeliveryError(error: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(error));
}
```

These are all "the recipient cannot accept this message" rather than
"the network is having a bad day". A blocked bot, a deleted chat, an
unjoined group — retrying every five minutes for an hour buys nothing
and floods the logs. The queue moves these entries straight to
`failed/`.

## 10. The interaction between dispatcher and session entry

The two subsystems described in this chapter and Chapter 06 talk to each
other through three SessionEntry fields:

- `pendingFinalDelivery: boolean` — set true after the runner emits the
  final reply but before the channel has confirmed delivery (`src/auto-reply/reply/agent-runner.ts:2146`).
- `pendingFinalDeliveryText: string` — the frozen reply text awaiting
  delivery. If the gateway dies before the channel send completes, the
  next startup reads this field and re-issues the send.
- `pendingFinalDeliveryAttemptCount`, `pendingFinalDeliveryLastAttemptAt`,
  `pendingFinalDeliveryLastError` — the retry book-keeping that mirrors
  the queue entry's state on the session side.

The runner writes these durably:

```ts
// src/auto-reply/reply/agent-runner.ts:2141
if (resolvedPendingText) {
  await updateSessionStoreEntry({
    storePath, sessionKey,
    update: async () => ({
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: resolvedPendingText,
      pendingFinalDeliveryCreatedAt: Date.now(),
      updatedAt: Date.now(),
    }),
  });
}
```

The dispatch path clears them on successful delivery:

```ts
// src/auto-reply/reply/dispatch-from-config.ts:628
if (!entry.pendingFinalDelivery && !entry.pendingFinalDeliveryText) {
  ...
}
// otherwise: clear all of the fields:
//   pendingFinalDelivery: undefined,
//   pendingFinalDeliveryText: undefined,
//   pendingFinalDeliveryCreatedAt: undefined,
//   pendingFinalDeliveryLastAttemptAt: undefined,
//   pendingFinalDeliveryAttemptCount: undefined,
//   pendingFinalDeliveryLastError: undefined,
//   pendingFinalDeliveryContext: undefined,
```

The result is that a final reply has two parallel durability stories:
the on-disk queue entry (channel-agnostic, retry semantics owned by
`delivery-queue-recovery.ts`) **and** the on-entry `pendingFinalDelivery*`
markers (session-scoped, owned by the session subsystem). Both must
agree before the system regards the reply as delivered.

## 11. End-to-end trace

A concrete example assembles the moving parts into one timeline.

1. A user sends "summarise the meeting" in a Telegram DM. The inbound
   pipeline (Chapter 05) classifies, dispatches, and ends up at
   `dispatch-from-config.ts`. A `ReplyDispatcher` is created with
   `deliver: deliverInboundReplyWithMessageSendContext.bind(...)` and
   `typingCallbacks` wired through `createTypingCallbacks(...)`.
2. `dispatcher.markComplete()` is **not** called yet — the reservation
   keeps the gateway from observing this dispatcher as idle.
3. The runner starts. `onReplyStart` fires; the typing keepalive starts
   pinging Telegram every three seconds. The ack-reaction emoji
   (`shouldAckReaction` returns true for `scope: "direct"`) is sent.
4. The runner streams assistant deltas. The block reply pipeline buffers
   them; once a paragraph boundary appears, it calls
   `dispatcher.sendBlockReply(payload)`. The first block delivers
   immediately; later blocks are paced by `humanDelay`.
5. Concurrently, every `AgentEventPayload` runs through
   `sendAgentPayload` (`src/gateway/server-chat.ts:670`), which calls
   `broadcast("agent", payload)`. Control UI and WebChat see token-by-
   token deltas.
6. Mid-stream the provider 5xx's. The runner emits
   `buildStreamErrorAssistantMessage(...)` to keep the transcript
   well-formed and triggers an automatic retry. The placeholder appears
   in the transcript, and the next prompt build (§3) drops it. The user
   does **not** see the placeholder; they see a fresh response.
7. The retry succeeds, the model emits a `stop`. The final payload is
   assembled (`§2`) and pushed via `dispatcher.sendFinalReply(payload)`.
8. The dispatcher's deliver hook runs
   `deliverInboundReplyWithMessageSendContext`. The payload is enqueued
   into the delivery queue (durability "required" because reconcile-
   unknown-send is supported). The channel adapter calls Telegram's API
   and gets a platform message id back. The receipt is materialised into
   a `ChannelDeliveryResult` and the queue entry is acked.
9. The session entry's `pendingFinalDelivery*` markers are cleared.
   `dispatcher.markComplete()` is called; `onIdle` fires; the typing
   keepalive stops; the ack reaction is removed.
10. Three weeks later the user reads the conversation back through
    WebChat. The transcript loader replays the JSONL through
    `projectChatDisplayMessage`; the placeholder line is **not** in the
    transcript (it was added at stream-error time but is now nothing more
    than a marked assistant entry; the projection treats it as such),
    and the WebChat sees only what the Telegram user saw.

If step 8 had crashed mid-flight, the gateway restart would have noticed
the live queue entry with `retryCount < 5`, computed an eligible-for-
retry timestamp, replayed the delivery, and observed the session entry's
`pendingFinalDelivery*` markers to reconcile state. The reply would
land — possibly several minutes late, possibly with an "I'm catching up"
follow-up to the user — but it would land.

If step 6's retry had also failed permanently (channel blocked the bot
mid-conversation), the placeholder filtering at §3 would still prevent
the next user message from seeing the failure in its prompt; and the
queue entry would move to `failed/` once one of the `PERMANENT_ERROR_PATTERNS`
matched. The user would see the error surfaced once, through a
`isError: true` payload routed through the same dispatcher.

## 12. Where to read next

This chapter handed off three threads that other chapters pick up:

- **Chapter 12** (Web UI canvas) consumes the WebSocket events broadcast
  here. The `session.message`, `agent`, `chat`, and `sessions.changed`
  payloads above are the entire input contract of the UI.
- **Chapter 13** (Voice & media) explains the `mediaUrl` / `ttsSupplement`
  / `spokenText` paths inside `ReplyPayload`. They flow through the same
  ReplyDispatcher but exercise the audio side of `deliverInboundReply...`.
- **Chapter 06** §10 detailed the session-lock mechanism the runner uses
  before any of this can happen.

The shape of the whole subsystem is best held in mind as the three
pictures of this chapter: a two-track event flow (Fig R11.1), a fielded
envelope (Fig R11.2), and a tiny indicator state machine (Fig R11.3).
Everything else — durable retry, scope-gated broadcast, ack reactions,
announce idempotency — bolts onto those three primitives without
disturbing them.
