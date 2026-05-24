# Tour Step 17: Session persistence

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

By the end of tour-16, the user's WebChat window shows a complete round-trip:

```
you         hello
assistant   Hello! How can I help today?
```

Delivery has happened. Broadcast has happened. From the user's perspective the turn is over — they asked, the assistant replied, both lines are on screen.

But from the gateway's perspective there is still one thing left. The on-screen text is only a render of WebSocket frames; it lives in browser memory. If the user refreshes the tab now, or comes back tomorrow with "where did we leave off?", the gateway must be able to resume — meaning it has to know "the user said hello, the assistant said that line". That memory does not live in the browser. It has to land on the gateway's disk.

What we have in hand: a delivered, broadcast `ReplyPayload`; a `session` resolved back in tour-08 (with `sessionKey`, `sessionId`, `sessionFile`, current model/provider); the `MsgContext` carrying inbound provenance. This step folds all of that into durable, on-disk state.

## 2. The problem

> The user's "hello" and the assistant's reply must be appended to the session transcript. Model selection, token usage, last-activity, and message count must be reflected in the session metadata. Concurrent writes from multiple gateway processes and crash-mid-write must not break consistency. How?

## 3. Naive approach

Keep one file per session. `session.json` holds an array of messages plus a small bag of metadata (current model, cumulative token count). At end-of-turn, push two messages into the array, update the metadata, `JSON.stringify` the whole object, `fs.writeFile` over the old file. One file, one write — what could be simpler?

## 4. Why the naive approach breaks

"One file, full overwrite" breaks in OpenClaw's long-running, multi-process, long-session deployment in several concrete ways:

- **Write amplification disaster.** The transcript is append-only and grows without bound; a three-month-old session can be tens of megabytes. Metadata (current model, token counts) is tiny but updated frequently. A single token-count refresh would rewrite tens of megabytes — every turn, every heartbeat. Disk IO is overwhelmed.

- **Partial writes corrupt the whole session.** `fs.writeFile` over a large file is not atomic. A crash or power loss mid-write leaves a truncated, unparseable file. On the next start, `JSON.parse` throws — and not "one turn lost", but **the entire conversation history gone**.

- **Concurrent writers clobber each other.** OpenClaw is a gateway; the gateway process, CLI sessions, and daemons can all be live at once. Two writers that each "read whole file, edit, write back" race; whichever writes second overwrites the other's changes. A user turn and a background metadata refresh silently eat each other.

- **Metadata and transcript have opposite access patterns.** Metadata is small, frequently read/written, needs scans for maintenance (cull stale sessions, cap entry count). Transcripts are large, append-only, rarely read end-to-end. Joining them into one file means every access pattern pays the other's cost — asking "which model is in use?" requires loading tens of megabytes.

The core tension: **metadata and transcript are two access patterns shoved into one file, non-atomic full-overwrite, no concurrency protection — every dimension fails.**

## 5. OpenClaw's approach

OpenClaw's approach is to **split metadata and transcript into two physical stores**, write each atomically (write-temp + rename), and serialize writes per-storePath in-process (plus an OS-level write lock for the transcript). The answer has four pieces.

**First, two-layer physical storage.** This is the linchpin of the whole session system:

- **Session store**: a JSON file at `<stateDir>/agents/<agentId>/sessions/sessions.json`, content shape `{ sessionKey -> SessionEntry }`. It is the **directory / routing table** — light metadata: model selection, token usage, route info, compaction markers, lifecycle timestamps.
- **Session transcript**: one JSONL file per session, `<sessionId>.jsonl`. The first line is a session header; subsequent lines each carry one message entry. This is the **content** — full conversation history, **append-only**.

The two layers are linked by `SessionEntry.sessionId`. Access pattern drives storage shape: bumping a token count touches only the small `sessions.json`, never the multi-megabyte `.jsonl`; appending a message is one `fs.appendFile` to the JSONL, no rewriting at all. This is the answer to the naive "write amplification" problem.

> Format note: at `v2026.5.22` the session store is **JSON** (serialized at [`src/config/sessions/store.ts:444`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/store.ts#L444) via `JSON.stringify(store, null, 2)`); the transcript is **JSONL** (appended at [`src/config/sessions/transcript-append.ts:332`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/transcript-append.ts#L332) via `fs.appendFile(..., JSON.stringify(entry))`). No session storage uses YAML.

**Second, this turn's exchange goes into the transcript as two entries.** The user message and the assistant reply are each appended by `appendSessionTranscriptMessage` at [`src/config/sessions/transcript-append.ts:255`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/transcript-append.ts#L255). The entry shape, constructed inline at [`src/config/sessions/transcript-append.ts:325`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/transcript-append.ts#L325), is:

```ts
const entry = {
  type: "message",
  id: messageId,
  ...(shouldRawAppend ? {} : { parentId: leafInfo.leafId ?? null }),
  timestamp: new Date(now).toISOString(),
  message: finalMessage,
};
await fs.appendFile(params.transcriptPath, `${JSON.stringify(entry)}\n`, "utf-8");
```

The `message` field carries the actual conversation payload — `role` (`user` / `assistant`), `content`, and on assistant messages a runtime metadata bundle: `provider`, `model`, `usage` (`input` / `output` / `cacheRead` / `cacheWrite` / `totalTokens` / `cost`), `stopReason` (constructed for the WebChat mirror case at [`src/config/sessions/transcript.ts:256`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/transcript.ts#L256) onward).

> One correction worth holding: there is no named type `SessionMessageEntry` or `SessionAgentRunEntry` in this codebase. Transcript entries are the inline `{type, id, parentId, timestamp, message}` shape above; `message` is an `AgentMessage` from `@earendil-works/pi-agent-core`.

`parentId` upgrades the transcript from "linear log" to "tree" — each entry points back at the current leaf — which is what makes session forking and compaction branches representable. Our "hello" turn is the trivial case: two entries get added in sequence, `parentId` walks a straight line.

The WebChat built-in path has a dedicated mirror: after `routeReplyToOriginating` succeeds, `mirrorInternalSourceReplyToTranscript` at [`src/auto-reply/reply/dispatch-from-config.ts:645`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L645) calls `appendAssistantMessageToSessionTranscript` at [`src/config/sessions/transcript.ts:219`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/transcript.ts#L219) with `updateMode: "inline"`, which simultaneously updates the session store's mirror counters.

**Third, metadata write-back.** Inbound provenance (provider, surface, `lastChannel`, `lastTo`) is folded back into `SessionEntry` by `recordSessionMetaFromInbound` at [`src/config/sessions/store.ts:708`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/store.ts#L708). Runtime state — model in use, usage totals, `updatedAt` — is written at turn boundary. `SessionEntry` is almost never replaced wholesale; instead `mergeSessionEntryWithPolicy` at [`src/config/sessions/types.ts:486`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/types.ts#L486) merges patches with built-in safety policies (e.g. clearing a stale provider when only model is being patched).

**Fourth, atomic writes plus serialized writes guard consistency.** These are the answers to "partial write" and "concurrent overwrite":

- **Atomic write.** `saveSessionStoreUnlocked` at [`src/config/sessions/store.ts:298`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/store.ts#L298) runs maintenance, serializes, and then calls `writeTextAtomic` at [`src/config/sessions/store.ts:596`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/store.ts#L596): write to a temp file, then `rename` over the target. `rename` is atomic on POSIX — readers see either the old file complete or the new file complete, never a half-written one. Mode is `0o600` since the file holds operator-sensitive state. Same-bytes deduplication skips the write entirely when nothing changed.
- **Per-store serialized writes.** `sessions.json` is a single shared file. `runExclusiveSessionStoreWrite` at [`src/config/sessions/store-writer.ts:72`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/store-writer.ts#L72) maintains an in-process serial queue keyed by `storePath`. Every write — read-modify-write included — runs inside one queue task, so concurrent writers in the same process never interleave.
- **Transcript: queue + OS lock.** The transcript can be appended to by multiple OpenClaw processes (sidecar daemons, CLI sessions). Beyond the in-process append queue (`withTranscriptAppendQueue`), `acquireSessionWriteLock` (called from [`src/config/sessions/transcript-append.ts:280`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/transcript-append.ts#L280)) takes an **OS-level file lock** before appending. The store can rely on in-process serialization; the transcript needs cross-process protection.

**Lifecycle event for turn completion.** When the turn finishes successfully, `emitSessionLifecycleEvent` at [`src/sessions/session-lifecycle-events.ts:20`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/sessions/session-lifecycle-events.ts#L20) fires; subscribers registered via `onSessionLifecycleEvent` (line 13) run post-turn hooks (e.g. cron checkpoints, UI refresh, telemetry). Transcript subscribers wire up similarly via `onSessionTranscriptUpdate` at [`src/sessions/transcript-events.ts:16`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/sessions/transcript-events.ts#L16) and receive a `SessionTranscriptUpdate` (`sessionFile`, `messageId`, `messageSeq`).

When this step is done, the "hello" and the assistant reply are two `message` entries in `<sessionId>.jsonl`; `SessionEntry`'s model / usage / `updatedAt` reflect the new turn; everything has landed via atomic `rename`. The attempt record (tour-12) flips to `succeeded` via the same dispatcher cleanup that called `markComplete`. If the gateway crashes immediately after, on restart the session can be re-loaded from disk with the full transcript intact.

## 6. Code locations

- [`src/config/sessions/types.ts:176`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/types.ts#L176) — `SessionEntry`, the per-session metadata bag (identity, route, model, usage, compaction markers).
- [`src/config/sessions/types.ts:198`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/types.ts#L198) — `sessionId`, the link between session store and `.jsonl` transcript.
- [`src/config/sessions/types.ts:486`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/types.ts#L486) — `mergeSessionEntryWithPolicy`, patch-merge with safety rules (stale-provider clearing, etc.).
- [`src/config/sessions/store.ts:708`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/store.ts#L708) — `recordSessionMetaFromInbound`, writes inbound provenance into `SessionEntry`.
- [`src/config/sessions/store.ts:298`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/store.ts#L298) — `saveSessionStoreUnlocked`, maintenance + serialize, called inside the writer queue.
- [`src/config/sessions/store.ts:444`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/store.ts#L444) — `JSON.stringify(store, null, 2)`: session store is JSON.
- [`src/config/sessions/store.ts:596`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/store.ts#L596) — `writeTextAtomic(params.storePath, params.serialized, { durable: false, mode: 0o600 })`: temp file then rename.
- [`src/config/sessions/store-writer.ts:72`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/store-writer.ts#L72) — `runExclusiveSessionStoreWrite`, in-process serial write queue keyed by `storePath`.
- [`src/config/sessions/transcript-append.ts:255`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/transcript-append.ts#L255) — `appendSessionTranscriptMessage`, transcript append entry point.
- [`src/config/sessions/transcript-append.ts:280`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/transcript-append.ts#L280) — `acquireSessionWriteLock`, cross-process OS file lock for the transcript.
- [`src/config/sessions/transcript-append.ts:325`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/transcript-append.ts#L325) — inline transcript entry shape `{type, id, parentId, timestamp, message}`.
- [`src/config/sessions/transcript-append.ts:332`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/transcript-append.ts#L332) — `fs.appendFile(params.transcriptPath, ...)`, JSONL append.
- [`src/config/sessions/transcript.ts:219`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/config/sessions/transcript.ts#L219) — `appendAssistantMessageToSessionTranscript`, assistant-side append (with `usage` sub-object).
- [`src/auto-reply/reply/dispatch-from-config.ts:645`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/auto-reply/reply/dispatch-from-config.ts#L645) — `mirrorInternalSourceReplyToTranscript`, WebChat-channel reply mirror into transcript.
- [`src/sessions/transcript-events.ts:16`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/sessions/transcript-events.ts#L16) — `onSessionTranscriptUpdate`, subscriber API for transcript updates.
- [`src/sessions/transcript-events.ts:23`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/sessions/transcript-events.ts#L23) — `emitSessionTranscriptUpdate`, fire-and-forget broadcast.
- [`src/sessions/session-lifecycle-events.ts:13`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/sessions/session-lifecycle-events.ts#L13) — `onSessionLifecycleEvent`, subscriber for turn-completion / lifecycle.
- [`src/sessions/session-lifecycle-events.ts:20`](https://github.com/openclaw/openclaw/blob/a374c3a5bf/src/sessions/session-lifecycle-events.ts#L20) — `emitSessionLifecycleEvent`, fires the post-turn hooks.

## 7. Branches and extensions

We walked the simplest persistence path: short session, two new entries, one atomic write of the store, no compaction. Branches you would hit on other traces:

- **Context compaction**: when transcript token count exceeds the model limit, compaction summarizes a span into one summary entry, recording a `SessionCompactionCheckpoint` with pre/post transcript references so it is reversible.
- **Session reset**: `/reset` or a daily-scheduled reset issues a new `sessionId` and a new transcript file; the old transcript is archived with a timestamp suffix, not deleted.
- **Session-store maintenance**: on load/save, entries older than 30 days or beyond a count cap (500) are pruned — but never the active session.
- **Idempotent appends**: `idempotencyKey` prevents delivery retries from duplicating entries.
- **Multi-agent merged view**: with multiple configured agents, `combined-store-gateway.ts` exposes a read-only union view across the per-agent `sessions.json` stores.
- **Linear-to-tree migration**: legacy linear transcripts are migrated in-place to `parentId`-linked trees on first append (with a size threshold escape hatch for huge files).

For the full session system — both layers, the 150-something fields on `SessionEntry`, the two-level concurrency design, compaction and archiving — see [Chapter 06 §4 (transcript)](06-sessions.md), [Chapter 06 §5 (lifecycle events)](06-sessions.md), and [Chapter 06 §9 (storage backend)](06-sessions.md).

## 8. What you should now have in your head

- Session state is **two physical stores**: light metadata in `sessions.json` (JSON dict), large append-only transcripts in `<sessionId>.jsonl` (JSONL), linked by `sessionId`. **Access pattern drives storage shape** — this is what defeats write amplification.
- This turn's user message and assistant reply each become one transcript entry — the inline shape `{type, id, parentId, timestamp, message}`. There is **no `SessionMessageEntry` / `SessionAgentRunEntry` named type**; `message` is `AgentMessage`.
- `parentId` upgrades transcript from "linear log" to "tree" (fork, compaction branches). Consistency comes from **atomic write** (temp file + `rename`, partial-write safe).
- Concurrency safety is two-tier: session store uses an **in-process serial write queue** (`runExclusiveSessionStoreWrite`); the transcript adds an **OS-level file lock** (`acquireSessionWriteLock`) because multiple OpenClaw processes may append.
- `SessionEntry` is almost never replaced wholesale — it is patched via `mergeSessionEntryWithPolicy`, which encodes safety rules like clearing stale provider when only model is patched.
- **This is the end of the trace.** From tour-01 (the CLI bootstrap) to tour-03 (WebSocket handshake) to tour-07 (inbound dispatch) to tour-13 (the Anthropic call) to tour-15 (assembling the ReplyPayload) to tour-16 (delivery and broadcast) — and now this step where the turn is durably persisted. One "hello → reply" cycle is complete. The gateway is back in the steady state described in tour-00: listeners ready, registries populated, connections idle, waiting for the next message.

*That concludes the narrative trace. To deepen any subsystem you saw flash past on the way through, return to the reference chapters via the sidebar — the broadcast layer, the session model, the agent runtime, the channel sender — each chapter takes the same threads further than a single-turn trace ever could.*
