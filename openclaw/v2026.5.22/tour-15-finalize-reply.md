# Tour Step 15: Assembling the ReplyPayload

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

By the end of tour-14 the model's streaming inference is in full swing. Anthropic emits tokens, and the agent runner wraps each one into an `AgentEventPayload` — an object with `runId` / `seq` / `stream` / `ts` / `data`. These events are flowing to two distinct consumers in parallel:

- The reply accumulation logic inside `src/auto-reply/reply/dispatch-from-config.ts`, which watches `stream === "assistant"` events and prepares them for outbound delivery.
- The chat event projector in `src/gateway/server-chat.ts`, which throttles those same events and broadcasts them to any WebSocket clients listening on the session.

What we have right now is "a moving stream of agent events". What we do not yet have is "a reply". For a short "hello" turn the model will emit something like "Hello! How can I help today?" — about a dozen tokens split into a dozen `stream === "assistant"` events. Each event carries `data.text` (the cumulative text so far) and `data.delta` (the new fragment just added).

This step is about how that storm of incremental events collapses into one complete, finalized, deliverable reply object.

## 2. The problem

> The model produces text incrementally — a reply grows one token at a time. But "deliver to a channel" needs one **complete** unit. How do we accumulate, normalize, and finalize a stream of incremental events into a single channel-agnostic `ReplyPayload`, and how do we even know "the model is done speaking"?

## 3. Naive approach

The most direct idea: skip accumulation entirely, deliver token-by-token. Every `data.delta` the model emits triggers an immediate `channel.send(delta)` — the reply lands on the user's screen letter-by-letter, like a typewriter. No buffer to manage, no "is it done?" guess work: when the model stops, the sends stop.

## 4. Why the naive approach breaks

Token-by-token direct delivery breaks the OpenClaw "gateway-fronting-external-chat-platforms" model in several concrete ways:

- **Platform message-count explosion.** On Telegram or Discord, every `sendMessage` is a separate message. "Hello! How can I help today?" split into 15 tokens turns into 15 chat-window messages, 15 phone vibrations, and an immediate anti-spam rate-limit. That is not "real-time feel" — that is harassment.

- **No finalization means no normalization.** Before a reply leaves the gateway it must pass through a chain of transforms: response-prefix templating, heartbeat-marker stripping, plugin `transformReplyPayload`, threading (`[[reply_to]]`) decisions, empty-reply filtering. These transforms need the **complete** text — you cannot decide whether "Hello! How can" should be threaded to its parent, because the question mark and reply intent only show up after another five tokens.

- **`stream`-field garbage leaks.** Agent events carry `stream` values beyond `"assistant"` — `"thinking"` (reasoning blocks), `"tool"` (tool calls), `"lifecycle"` (phase transitions). Token-level direct sends drag all of these into the user's chat window. A user typed "hello" and gets a wall of internal monologue back.

- **There is no "done" signal anyone checks.** The real end-of-turn marker is a `stream === "lifecycle"` event with `data.phase === "end"`. The token-direct model has no place where that signal gets honored — so transcript persistence, typing-indicator teardown, and dispatcher idle marking never trigger. The whole back half of the trace (tour-16, tour-17) loses its anchor.

The core tension: **the model's output is incremental, multi-stream, and has no inherent terminus; the delivery layer needs a complete, visible-text-only, explicitly-final unit.** Something has to sit between them and "accumulate, normalize, finalize".

## 5. OpenClaw's approach

OpenClaw's approach is to **define a channel-agnostic reply unit** (`ReplyPayload`), let the dispatch loop in `dispatch-from-config.ts` accumulate `assistant` text across events, and **wait for the `lifecycle` `end` phase** before constructing a finalized payload and handing it to `dispatcher.sendFinalReply`. The answer has three pieces.

**First, `ReplyPayload` is the channel-agnostic reply unit.** The type lives in [`src/auto-reply/reply-payload.ts:7`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply-payload.ts#L7). It is deliberately ignorant of any particular platform: `text` carries visible text, `mediaUrl` / `mediaUrls` carry media, `presentation` describes "richer rendering hints" that the per-channel renderer either maps or degrades, and `channelData` is the escape hatch for channel-specific envelope fields. A small set of booleans — `isReasoning`, `isError`, `isCompactionNotice`, `isFallbackNotice`, `isStatusNotice` — lets downstream consumers make precise routing decisions ("send this to TTS?", "show this on the web?"). For our "hello" trace, the final `ReplyPayload` is the trivial case: just `{ text: "Hello! How can I help today?" }`. No media, no presentation, no metadata.

**Second, the accumulation logic is *not* one function called `finalizeReply`.** This is a common misconception worth correcting: **there is no `finalizeReply` symbol in the codebase**. The reply finalization is spread across `src/auto-reply/reply/dispatch-from-config.ts`, in particular `sendFinalPayload` at [`src/auto-reply/reply/dispatch-from-config.ts:1522`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L1522). The flow is:

1. The agent runner emits `AgentEventPayload`s. `stream === "assistant"` events carry `data.text` (cumulative) and `data.delta` (this token's increment).
2. `dispatch-from-config.ts` listens to these events. Block markers (`[[block]]`) or length thresholds may carve intermediate pieces. The "hello" reply triggers none of that — it stays one block from start to finish.
3. At end-of-turn the accumulated text is wrapped into a final `ReplyPayload` and handed to `dispatcher.sendFinalReply(payload)`. The call sites of interest are [`src/auto-reply/reply/dispatch-from-config.ts:1568`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L1568) (inside `sendFinalPayload`), [`src/auto-reply/reply/dispatch-from-config.ts:1462`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L1462) (abort path), and [`src/auto-reply/reply/dispatch-from-config.ts:1135`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L1135) (binding-notice fallback).
4. `sendFinalReply` returns a `boolean`. `true` means the payload was queued. `false` means normalization dropped it (e.g. `NO_REPLY`, empty body, suppressed reasoning). Callers branch on the return to decide fallback behavior.

**Third, "done" is judged by the lifecycle phase, not by the assistant stream.** A `stream === "assistant"` event only means "we grew some more". The real terminus is `stream === "lifecycle"` with `data.phase === "end"` — this is what the request brief loosely calls `chat_done`; in the actual codebase it is the lifecycle event (see Chapter 11 §6). The accumulator waits for this phase, then constructs the final `ReplyPayload` from the buffered text, calls `sendFinalReply`, and finally `dispatcher.markComplete()` to tell the delivery layer "no more replies coming for this turn".

Why finalize, why not stream directly? Because finalization is the only anchor for everything that follows:

- Only a complete text can run normalization (response-prefix, heartbeat strip, `transformReplyPayload`, renderability).
- Only the `final` kind (one of three values defined at [`src/auto-reply/reply/reply-dispatcher.types.ts:3`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/reply-dispatcher.types.ts#L3) — `"tool" | "block" | "final"`) tells the delivery layer "this is the last one, you can clean up".
- The typing-indicator teardown, the transcript persistence, the lifecycle "completed" event all hang off this semantic point.

Important distinction: the **delivery path** waits for the final (accumulates to a complete `ReplyPayload` before sending), but the **broadcast path** does not — the `server-chat.ts` projector pushes 150 ms-throttled incremental events to WebSocket clients in real time, which is what gives WebChat the typewriter effect (see tour-16). The two paths run in parallel and are decoupled. "Real-time feel" comes from broadcast; "one complete reply lands on the platform" comes from delivery. Holding both in your head is the key to the OpenClaw delivery layer.

When this step is done, we hold a complete, finalized `ReplyPayload`: `{ text: "Hello! How can I help today?" }`, queued via `sendFinalReply` into the `ReplyDispatcher`, ready to be delivered.

## 6. Code locations

- [`src/auto-reply/reply-payload.ts:7`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply-payload.ts#L7) — `ReplyPayload` type definition, channel-agnostic reply unit.
- [`src/auto-reply/reply/dispatch-from-config.ts:40`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L40) — `appendAssistantMessageToSessionTranscript` import, used by mirror logic.
- [`src/auto-reply/reply/dispatch-from-config.ts:1522`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L1522) — `sendFinalPayload`, the local async helper that finalizes a payload, applies TTS/media normalization, routes to originating channel or queues via `sendFinalReply`.
- [`src/auto-reply/reply/dispatch-from-config.ts:1568`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L1568) — `dispatcher.sendFinalReply(normalizedPayload)`, finalized payload enqueued into the dispatch chain.
- [`src/auto-reply/reply/dispatch-from-config.ts:1462`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L1462) — abort-path `dispatcher.sendFinalReply(payload)`.
- [`src/auto-reply/reply/dispatch-from-config.ts:1135`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L1135) — binding-notice `dispatcher.sendFinalReply(payload)` fallback.
- [`src/auto-reply/reply/reply-dispatcher.types.ts:3`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/reply-dispatcher.types.ts#L3) — `ReplyDispatchKind = "tool" | "block" | "final"`; only these three kinds exist.
- [`src/auto-reply/reply/reply-dispatcher.ts:107`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/reply-dispatcher.ts#L107) — `normalizeReplyPayloadInternal`, finalize-then-deliver normalization (prefix, heartbeat strip, `transformReplyPayload`).
- [`src/auto-reply/reply/reply-payloads-base.ts:82`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/reply-payloads-base.ts#L82) — `isRenderablePayload`, empty/invisible payloads filtered here.
- [`src/auto-reply/reply/reply-payloads-base.ts:90`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/reply-payloads-base.ts#L90) — `applyReplyThreading`, decides whether the reply quotes the original.
- [`src/gateway/agent-event-assistant-text.ts:3`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/agent-event-assistant-text.ts#L3) — `resolveAssistantStreamDeltaText`, the tiny helper that picks `data.delta` (preferred) or falls back to `data.text` for live assistant events.
- [`src/gateway/protocol/schema/agent.ts:41`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/gateway/protocol/schema/agent.ts#L41) — `AgentEventSchema`, the on-wire shape; `stream` is the real event-type discriminator.

Here is what a final `assistant` event accumulator looks like in practice — a tiny piece of `agent-event-assistant-text.ts`:

```ts
// src/gateway/agent-event-assistant-text.ts:3
export function resolveAssistantStreamDeltaText(evt: AgentEventPayload): string {
  const delta = evt.data.delta;
  const text = evt.data.text;
  return typeof delta === "string" ? delta : typeof text === "string" ? text : "";
}
```

Notice the preference order: `delta` first, then full `text` as a fallback. Cumulative-text fallback exists for streams where the provider does not break out deltas — but in the common Anthropic case `data.delta` carries each fragment cleanly, and the accumulator joins them into the buffer the projector later projects (see `chatRunState.rawBuffers` at `src/gateway/server-chat.ts:489`).

A small worked example: imagine the model emits three `assistant` events with deltas `"Hello"`, `"! How can I"`, `"help today?"`. After the third event the dispatcher's buffer holds `"Hello! How can I help today?"`. None of these have hit `sendFinalReply` yet — they have only updated the internal accumulator and (via the broadcast track) been pushed at 150 ms intervals to the WebSocket. Then a fourth event arrives: `stream: "lifecycle"`, `data.phase: "end"`. That is the trigger. The dispatcher's `sendFinalPayload` builds a `ReplyPayload` from the buffer, normalizes it, and the call to `dispatcher.sendFinalReply` returns `true`. The dispatcher's `markComplete()` then signals "no more replies inbound for this turn", letting downstream consumers (typing indicator, transcript persistence) wind down.

Worth pausing on the v2026.5.22 stream-error placeholder fix. Earlier releases occasionally let an `assistant`-stream event with empty `data.delta` and `data.text` slip into the buffer when a provider truncated a stream. Those empty events used to leave a literal "(stream error)" placeholder in the user-facing reply. The fix lives in the dispatch accumulator: empty assistant events are now dropped before they reach the buffer, and `stream === "error"` events route to a separate error sink that the projector turns into a UI-only `state: "error"` chat event — never part of the assembled `ReplyPayload`.

One last note on `markComplete`. The marker is what tells the delivery layer that the `final` payload it is about to send (or already sent) is the last one for the turn. Without that signal, the dispatcher would keep waiting for additional `tool` or `block` replies. The pairing of `sendFinalReply` followed by `markComplete` is the standard idiom for closing out a turn cleanly; you will see it in the abort path (line 1462) and the binding-notice fallback (line 1135) too. If `sendFinalReply` returns `false` (normalization dropped the payload), the caller still calls `markComplete` so the turn ends — there just is not a user-visible reply.

## 7. Branches and extensions

We are walking the simplest path: one short text reply, no blocks, no tool calls, no media, one `sendFinalReply` and done. The branches you would hit on other traces:

- **Multi-block reply (`block` kind)**: the agent emits `[[block]]` markers or the accumulated text exceeds a length threshold; the accumulator slices it into mid-stream pieces, each going to `dispatcher.sendBlockReply` via the same chain.
- **Tool-call narration (`tool` kind)**: `stream === "tool"` events get summarized into a separate `tool` reply; `data.phase` (`start` / `update` / `result`) discriminates between announce, progress, and completion.
- **Media replies**: image and audio outputs populate `mediaUrl` / `mediaUrls` and trigger presentation degradation per channel renderer.
- **Silent replies (`NO_REPLY`)**: the model decides not to answer; normalization drops the payload and `sendFinalReply` returns `false`.
- **Reasoning stream (`stream === "thinking"`)**: reasoning content sets `isReasoning: true` and is suppressed on channels without a dedicated reasoning lane (most chat surfaces).
- **v2026.5.22 stream-error placeholders**: empty `stream === "error"` placeholders (the truncation fix shipped this release) are filtered before they hit the final buffer — they never become part of the user-visible payload.
- **Plugin-handled before-dispatch**: a `before_dispatch` hook may produce a short-circuit text answer; that path also funnels through `sendFinalPayload` (line 1610) so the same normalization and dispatcher contract apply.
- **TTS-only finals**: when the agent reply is voice-only (no visible text), the dispatcher still produces a `ReplyPayload` with `spokenText` and routes through `sendFinalReply` (line 2292) — the broadcast-vs-delivery split still applies, just with audio media instead of text.

For the full delivery-and-events story — `ReplyDispatcher` queueing/throttling, normalization, the split between broadcast and delivery paths — see [Chapter 11 §3 (ReplyPayload)](11-delivery-and-events.md), [Chapter 11 §4 (stream-error filtering)](11-delivery-and-events.md), and [Chapter 07 §10 (event emission)](07-agent-execution.md).

## 8. What you should now have in your head

- `ReplyPayload` (`src/auto-reply/reply-payload.ts:7`) is the **channel-agnostic** reply unit — it intentionally knows nothing about any specific platform; per-channel renderers map or degrade its fields.
- There is no `finalizeReply` function. Finalization lives in `dispatch-from-config.ts`'s `sendFinalPayload` (line 1522) and the surrounding `assistant`-event accumulator.
- A reply **must wait until finalization to be delivered** — only the complete text can run normalization (prefix, heartbeat strip, threading, empty-filter), and only `kind: "final"` is the anchor for downstream cleanup.
- "Done" is the `stream === "lifecycle"` + `data.phase === "end"` event, not anything in the assistant stream. This is the real `chat_done` analog in OpenClaw.
- "Typewriter feel" comes from the **broadcast path** (WS incremental events with 150 ms throttle); "the final assembled reply for the platform" comes from the **delivery path**. Two paths, parallel, decoupled.
- After this step we hand off to tour-16: the queued `ReplyPayload` is routed by `routeReplyToOriginating` back to WebChat, and in parallel the projector flushes any buffered delta and emits the `state: "final"` chat event.
- The five `ReplyPayload` boolean flags (`isError`, `isReasoning`, `isCompactionNotice`, `isFallbackNotice`, `isStatusNotice`) carry routing intent — they let TTS, transcript mirror, and channel renderers each apply the right filter without re-parsing the payload's text.
