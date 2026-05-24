# Tour Step 14: Emitting and subscribing to stream events

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

The SSE connection to `api.anthropic.com/v1/messages` is open. The provider's stream consumer (inside `@earendil-works/pi-ai`, invoked via `streamSimple`) is reading the first events: `message_start`, then a `content_block_start` for a `text` block, then a series of `content_block_delta` events carrying `"Hello"`, `"!"`, `" How"`, `" can"`, `" I"`, `" help"`, `"?"`. Each delta the provider consumer parses must travel three places at once:

1. into the **assistant attempt object** in the embedded runner, which accumulates `currentAttemptAssistant.content` so the final transcript message is built from the same bytes the user saw;
2. into **WebChat over WebSocket**, so the user watches the reply appear character-by-character;
3. into the **transcript writer**, so each visible incremental update is reflected in the persisted session log and any other subscriber (search index, audit feed) can react.

By the end of this step the model has produced a complete reply, all subscribers have received the events that matter to them, and the SSE stream is about to close with `message_stop`. The next step (tour-15) handles finalisation.

## 2. The problem

> One stream of events from a single LLM call has multiple consumers with **different lifecycles and different durability requirements**: the WebChat UI must see deltas live (best-effort, lose on disconnect, never block the model), the transcript writer must record per-event facts (durable, ordered, never miss any), and the agent runtime must wait for the **final** state before it can decide whether to stop or continue. A single bytes-to-screen pipeline is wrong: the UI needs speed, the transcript needs durability, the runtime needs finality, and none of those three should be able to slow down or break the others.

A second problem layered on top: events have a global ordering invariant per run (sequence numbers monotonically increasing, attempts are isolated by `runId`), and consumers must be able to filter to "their" run cheaply.

## 3. Naive approach

Three loops, each polling the stream. Or, equivalently, the SSE consumer returns an async iterator that the embedded runner consumes; the runner mutates the session message; the WebChat reads the session message file with `fs.watch`; the transcript writer also reads the session file. Polling everywhere.

## 4. Why the naive approach breaks

**Polling tears partial events.** A reader peeking at a half-written file may see `"Hel"` then `"Hello! How can I "` then `"Hello! How can I help?"`, but the WebChat needs *deltas* (`"Hel"`, then `"lo! How can I "`, then `"help?"`), not snapshots. Computing deltas from snapshots is racy and wastes work.

**Disconnects lose events.** The WebChat client disconnects mid-stream when the user closes the tab. If the writer is shoving events into a queue tied to the WebSocket, those events vanish — but the transcript writer also wanted them. Sharing one queue couples lifecycles.

**Back-pressure cross-pollutes.** A slow transcript writer (fsync on disk) becoming the rate-limiter for the WebChat UI would make the live stream visibly stutter to the user. The reverse — a slow UI delaying transcript persistence — would risk losing events on crash.

**One subscriber's exception kills the others.** If the transcript writer throws on an unexpected event shape, a naive shared loop would abort the broadcast to the UI as well.

**Multiple runs interleave.** Two attempts running in parallel (a sub-agent and the main session) would have their deltas inter-mingled on any shared channel without `runId` discrimination.

## 5. OpenClaw's approach

OpenClaw's approach is a **typed, per-run event emitter scoped to the attempt**, with `runId`-keyed sequence numbers, multiple independent subscribers, and per-subscriber failure isolation. Three orthogonal subscribers — the runtime's own accumulator, the WebChat broadcaster, and the transcript writer — each hold their own filter and their own lifecycle. The same delta is delivered to all three, but they cannot starve or break each other.

**The emitter.** `src/infra/agent-events.ts:209-235` is `emitAgentEvent`. Every event carries `{ runId, stream, data, ts, seq, sessionKey? }`, with `seq` assigned monotonically per `runId`:

```ts
export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const state = getAgentEventState();
  const nextSeq = (state.seqByRun.get(event.runId) ?? 0) + 1;
  state.seqByRun.set(event.runId, nextSeq);
  const context = state.runContextById.get(event.runId);
  if (context) context.lastActiveAt = Date.now();
  const isControlUiVisible = context?.isControlUiVisible ?? true;
  // ...sessionKey scrubbing for hidden channel runs...
  const enriched: AgentEventPayload = { ...event, sessionKey, seq: nextSeq, ts: Date.now() };
  notifyListeners(state.listeners, enriched);
}
```

`AgentEventStream` is an open union (`src/infra/agent-events.ts:5-17`): `lifecycle | tool | assistant | error | item | plan | approval | command_output | patch | compaction | thinking | ...`. The `"assistant"` stream is what carries our text deltas. Subscribers filter on stream + runId.

**`runContextById` separates visible from hidden runs.** A run can be marked `isControlUiVisible: false` (e.g. an internal channel-routed run), in which case `sessionKey` is stripped from non-lifecycle events (`src/infra/agent-events.ts:217-227`) so the Control UI's listener cannot accidentally surface them. Lifecycle events are preserved unconditionally so terminal session state still propagates. For our visible WebChat run, `isControlUiVisible` is the default `true` and every assistant delta carries the session key.

**Subscriber 1 — the WebChat broadcaster.** The OpenAI-compatible gateway endpoint (`src/gateway/openai-http.ts:1100-1135`) subscribes via `onAgentEvent` for the duration of the in-flight request, filters by `runId`, and forwards assistant text deltas as Server-Sent-Event chunks to the WebChat client:

```ts
const unsubscribe = onAgentEvent((evt) => {
  if (evt.runId !== runId) return;
  if (closed) return;
  if (evt.stream === "assistant") {
    const content = resolveAssistantStreamDeltaText(evt) ?? "";
    if (!content) return;
    if (!wroteRole) { wroteRole = true; writeAssistantRoleChunk(res, { runId, model }); }
    sawAssistantDelta = true;
    writeAssistantContentChunk(res, { runId, model, content, finishReason: null });
    return;
  }
  if (evt.stream === "lifecycle") {
    const phase = evt.data?.phase;
    if (phase === "end" || phase === "error") requestFinalize();
  }
});
```

The helper `resolveAssistantStreamDeltaText` (`src/gateway/agent-event-assistant-text.ts:3-7`) handles the dual shape — Anthropic-derived events use `data.delta`, OpenAI-derived events use `data.text` — and returns whichever the runtime emitted, so the broadcaster does not branch on provider. The disconnect watcher at line 1137 unsubscribes the moment the client TCP socket closes; the emitter keeps emitting to the other subscribers regardless.

**Subscriber 2 — the transcript writer.** `src/sessions/transcript-events.ts:23-57` exposes `emitSessionTranscriptUpdate(update)` which the embedded runner calls every time it commits a piece of incremental state to the session file (`messageSeq` increments, body grows). Listeners register via `onSessionTranscriptUpdate(listener)` (line 16-21). Failures in any one listener are swallowed (line 50-55) so a misbehaving subscriber cannot interrupt the others:

```ts
for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
  try { listener(nextUpdate); } catch { /* ignore */ }
}
```

The transcript writer subscribes alongside an optional search-indexer and any other registered consumer; each one sees the same `SessionTranscriptUpdate` shape.

**Subscriber 3 — the runtime accumulator.** The embedded runner's own stream consumer is the *first* subscriber — it does not listen via `onAgentEvent`, it produces them. As the SSE parser inside the provider plugin yields events, the runner translates each into both an `emitAgentEvent({ stream: "assistant", data: { delta }, ... })` call (for live subscribers) and a mutation of the current `assistantTexts`/`currentAttemptAssistant` accumulators (for the eventual transcript message). The single physical event splits cleanly: live broadcast goes through the emitter, durable state goes through the in-memory accumulator that the writer flushes.

**Failure isolation.** `notifyListeners` (called at `src/infra/agent-events.ts:234`) wraps each listener in its own try/catch. The transcript writer can fail without blocking the broadcaster. The broadcaster can disconnect without aborting the runtime. The runtime can error and emit a terminal `lifecycle` event that the broadcaster recognises and ends the SSE response cleanly.

**Sequence numbers as the contract.** `seq` is assigned per `runId` and is monotonically increasing. The WebChat broadcaster does not need it (it just streams whatever arrives), but the transcript writer uses `messageSeq` to deduplicate idempotent writes (`src/sessions/transcript-events.ts:38`, `asPositiveSafeInteger(normalized.messageSeq)`), and the run context's `lastActiveAt` (line 215) is updated on every emit, feeding the stale-context sweeper at line 186-202.

## 6. Code locations

- `src/infra/agent-events.ts:5-17` — `AgentEventStream` open union; `"assistant"` carries our text deltas.
- `src/infra/agent-events.ts:102-109` — `AgentEventPayload` shape (`runId`, `seq`, `stream`, `ts`, `data`, `sessionKey?`).
- `src/infra/agent-events.ts:111-121` — `AgentRunContext`, the per-run metadata including `isControlUiVisible` that gates session-key leakage.
- `src/infra/agent-events.ts:139-180` — register / get / clear / sweep run contexts.
- `src/infra/agent-events.ts:209-235` — `emitAgentEvent`, the per-run sequence assignment, the visibility-aware session-key scrub, and the `notifyListeners` fan-out.
- `src/infra/agent-events.ts:302-305` — `onAgentEvent`, the subscription API.
- `src/gateway/agent-event-assistant-text.ts:3-7` — `resolveAssistantStreamDeltaText`, the provider-agnostic delta extractor.
- `src/gateway/openai-http.ts:16` — `emitAgentEvent, onAgentEvent` import into the gateway HTTP path.
- `src/gateway/openai-http.ts:1100-1135` — the WebChat broadcaster subscription: assistant deltas become SSE chunks, lifecycle terminal phases trigger finalise.
- `src/gateway/openai-http.ts:1137-1140` — disconnect watcher: client closes → unsubscribe, but the run keeps going.
- `src/sessions/transcript-events.ts:14-21` — `onSessionTranscriptUpdate`, the second event bus for per-message transcript writes.
- `src/sessions/transcript-events.ts:23-57` — `emitSessionTranscriptUpdate`, with `try/catch`-isolated listener invocation.
- `src/agents/pi-embedded-runner/run/attempt.ts:2697-2706` — the call site whose `streamFn` is being consumed (referenced from tour-13) and whose internal accumulators are subscriber 3.

## 7. Branches and extensions

This step's trace is the visible WebChat path. Variations sit in adjacent subsystems:

- See [Chapter 11 §1 — event stream framing](11-delivery-and-events.md) for the full `AgentEventStream` taxonomy, the `seq` contract, and how `lifecycle.error` vs the `error` stream divide observational from terminal failures.
- See [Chapter 11 §8 — event broadcast to UI](11-delivery-and-events.md) for the WebSocket projection layer that the same emitter also feeds when WebChat clients use the WS path instead of the OpenAI-compatible HTTP/SSE path used here, and for the `isControlUiVisible` gating.
- See [Chapter 06 §4 — transcript events](06-sessions.md) for the writer pipeline — how `emitSessionTranscriptUpdate` feeds the session-file persister, the JSONL append, and the durability tier for crash recovery.

Off-trace concerns: the **tool** stream (`emitAgentItemEvent`, `emitAgentCommandOutputEvent` at lines 237-300) carries tool lifecycle that this hello-only trace does not produce; the **approval** stream (line 263-274) handles HITL approval requests; `sweepStaleRunContexts` (line 186-202) reclaims memory from orphaned runs that miss their terminal lifecycle event (TTL 30 minutes); and the gateway's separate `openresponses-http.ts` path (also using `resolveAssistantStreamDeltaText`) covers the OpenAI Responses protocol shape with the same event source.

## 8. What you should now have in your head

- The emitter is a **per-run event bus** with sequence numbers keyed by `runId`. Multiple subscribers receive the same event independently; failures in one are isolated by `notifyListeners`' try/catch.
- The WebChat broadcaster, the transcript writer, and the runtime accumulator are **three subscribers of the same stream**, each with its own lifecycle: UI is best-effort and dies with the socket, transcript is durable and acknowledged per message, accumulator is in-memory and feeds finalisation.
- `resolveAssistantStreamDeltaText` (`src/gateway/agent-event-assistant-text.ts:3`) is the deliberately tiny provider-agnostic shim that hides the `delta` vs `text` field difference between Anthropic-derived and OpenAI-derived events so the broadcaster does not branch.
- The `isControlUiVisible` flag on `AgentRunContext` scrubs the `sessionKey` from non-lifecycle events for hidden runs so Control UI listeners cannot accidentally surface internal traffic — but lifecycle events still propagate so terminal state is never lost.
- At the end of this step, the deltas have already streamed to the user (they are reading `"Hello! How can I help?"` in WebChat right now); the SSE upstream is one `message_stop` event away from closing; the runtime accumulators hold the complete assistant turn ready for finalisation in tour-15.
