# Chapter 06: Sessions & Conversation State

Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 0. What this chapter answers

Chapter 05 ended with an inbound message that had been classified, sanitized,
and routed: the gateway knows which channel it came from, which agent should
handle it, and which conversation context it belongs to. The very next
question is the one this chapter answers in full:

> A single human user spans many channels (Telegram, Signal, WhatsApp,
> WebChat), many devices, many days, and frequently many running
> conversations at once. The assistant needs a stable per-conversation
> memory that **survives process restarts**, **does not bleed across
> unrelated conversations**, and **does not pretend two distinct
> conversations are one** just because they came from the same human.

That requirement quickly explodes into a dozen smaller problems:

- How is a session uniquely identified, given that a Telegram DM, a Signal
  group, and a WebChat session all have completely different native
  identifier shapes?
- Where is the conversation transcript stored when it can grow to megabytes
  per session over weeks?
- What happens to that transcript if the gateway is killed mid-stream?
- What happens to the transcript when an agent is invoked twice in parallel
  for the same session (a retry, a follow-up, a duplicated webhook)?
- How does a per-session override (a `/model` switch, a verbose level, a
  send-policy override) live alongside the underlying transcript?
- How is a runaway transcript prevented from blowing past the model's
  context window?

The session subsystem is the layer that answers each of these. It is split
into two physical layers and a thin compositional layer of supporting
modules — and the file-level lock that prevents corruption is itself a
nontrivial story this release had to backport (PR #85764 — see §10).

## 1. The two-layer storage model

Naively, one would store the entire conversation in a single document keyed
by user id. That works for one channel and one user; it dies the moment the
same user has three concurrent conversations on two channels and you want
to update a token count without rewriting the entire chat log.

OpenClaw splits storage into a thin **session store** (a JSON dictionary of
metadata keyed by session) and a **session transcript** (one append-only
JSONL file per session). The split is the structural backbone of every
other concern in this chapter.

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Two-layer session storage with metadata directory and per-session JSONL transcripts">
  <defs>
    <marker id="r61arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="40" y="20" width="680" height="118" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="46" text-anchor="middle" font-size="14" font-weight="700" fill="#ea580c">Session store (metadata directory)</text>
  <text x="380" y="68" text-anchor="middle" font-size="11" fill="#64748b">&lt;stateDir&gt;/agents/&lt;agentId&gt;/sessions/sessions.json</text>
  <text x="380" y="86" text-anchor="middle" font-size="11" fill="#64748b">Shape: { sessionKey -&gt; SessionEntry }</text>
  <text x="380" y="104" text-anchor="middle" font-size="11" fill="#64748b">Role: routing table — token counters, model overrides,</text>
  <text x="380" y="120" text-anchor="middle" font-size="11" fill="#64748b">channel hints, send-policy, compaction markers</text>
  <line x1="380" y1="140" x2="380" y2="186" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r61arrow)"/>
  <text x="392" y="160" font-size="10" fill="#94a3b8">SessionEntry.sessionId + sessionFile point here</text>
  <rect x="40" y="190" width="680" height="118" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="216" text-anchor="middle" font-size="14" font-weight="700" fill="#0d9488">Session transcript (append-only log)</text>
  <text x="380" y="238" text-anchor="middle" font-size="11" fill="#64748b">&lt;...&gt;/sessions/&lt;sessionId&gt;.jsonl  (one file per session)</text>
  <text x="380" y="256" text-anchor="middle" font-size="11" fill="#64748b">One header line + N event lines (user / assistant / tool / system)</text>
  <text x="380" y="274" text-anchor="middle" font-size="11" fill="#64748b">Role: the actual conversation — append-only, never rewritten in-place</text>
  <text x="380" y="292" text-anchor="middle" font-size="11" fill="#64748b">Guarded by &lt;sessionId&gt;.jsonl.lock  (see §10)</text>
</svg>
<span class="figure-caption">Figure R6.1 | Two-layer session storage: a small metadata directory and per-session append-only transcripts.</span>

<details><summary>ASCII original</summary>

```
+------------------------------------------------------------+
| Session store (metadata directory)                         |
| <stateDir>/agents/<agentId>/sessions/sessions.json         |
| { sessionKey -> SessionEntry }                              |
| - token counters, model overrides, channel hints,          |
|   send-policy, compaction markers                          |
+----------------------------+-------------------------------+
                             |
                             v
+------------------------------------------------------------+
| Session transcript                                          |
| <...>/sessions/<sessionId>.jsonl  (one per session)         |
| header line + N event lines (user / assistant / tool ...)   |
| append-only; guarded by <sessionId>.jsonl.lock (see §10)    |
+------------------------------------------------------------+
```

</details>

The split is justified by access patterns:

- **Metadata is small, mutated frequently, read whole.** Every token count
  bump, every model override, every reset rewrites the entire JSON map.
  Putting the chat history in the same file would mean rewriting the chat
  history every time the input-token counter ticks. That is unacceptable
  at scale.
- **Transcripts are large, append-only, rarely read whole.** Each new event
  is one line at the end of the file. Reads happen at the start of a turn
  (to assemble prompt history) and at compaction time. They almost never
  rewrite older bytes.

The session store layer is described in the `config/sessions/` package
(`src/config/sessions.ts:1` re-exports it); the actual SessionEntry shape
lives at `src/config/sessions/types.ts:175`. The transcript event channel
is described in `src/sessions/transcript-events.ts:1`.

## 2. The `SessionEntry` concept

A `SessionEntry` is the dictionary value stored against each session key in
`sessions.json`. It is intentionally fat: it carries everything that needs
to be cheap to read between turns. The full definition lives at
`src/config/sessions/types.ts:175` and runs more than 150 fields. The
important groups are:

```ts
// src/config/sessions/types.ts:175
export type SessionEntry = {
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
  parentSessionKey?: string;
  spawnedBy?: string;
  spawnDepth?: number;
  subagentRole?: "orchestrator" | "leaf";
  chatType?: SessionChatType;
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  traceLevel?: string;
  ...
```

Conceptually the fields fall into seven groups:

| Group | Examples | Where set |
|------|----------|----------|
| Identity | `sessionId`, `sessionFile`, `updatedAt`, `parentSessionKey`, `spawnedBy`, `spawnDepth` | session resolution / spawn |
| Channel/origin | `channel`, `chatType`, `origin`, `lastChannel`, `lastTo`, `lastAccountId`, `lastThreadId`, `route`, `deliveryContext` | inbound classification |
| Display | `label`, `displayName`, `subject`, `groupChannel`, `space` | label commands |
| Model & runtime overrides | `providerOverride`, `modelOverride`, `modelOverrideSource`, `authProfileOverride`, `agentHarnessId`, `agentRuntimeOverride` | `/model`, fallback rotation |
| Behavioural overrides | `thinkingLevel`, `verboseLevel`, `traceLevel`, `reasoningLevel`, `elevatedLevel`, `sendPolicy`, `groupActivation`, `queueMode`, `ttsAuto` | `/verbose`, `/think`, `/silence`, … |
| Counters & rollups | `inputTokens`, `outputTokens`, `totalTokens`, `totalTokensFresh`, `contextTokens`, `estimatedCostUsd`, `cacheRead`, `cacheWrite`, `compactionCount` | post-turn accounting |
| Durable in-flight flags | `pendingFinalDelivery`, `pendingFinalDeliveryText`, `pendingFinalDeliveryAttemptCount`, `pendingFinalDeliveryContext`, `abortCutoffMessageSid`, `quotaSuspension` | delivery / abort hooks |

The two fields that anchor everything else are `sessionId` (a UUID, the
filename of the transcript) and `sessionFile` (the absolute path of that
JSONL). Together they let any caller go from a `SessionEntry` to the bytes
of the conversation without needing to know any path conventions.

Token counters are particularly worth calling out because they explain why
the two-layer split is non-negotiable: `inputTokens`, `outputTokens`,
`totalTokens`, `contextTokens`, `estimatedCostUsd`, `cacheRead`, `cacheWrite`
are all updated **after every turn**. If the session entry were stored in
the transcript itself, every reply would force a full rewrite of every byte
the model has ever said in this conversation. With the split, an entry
update is a `JSON.stringify(store)` and a single `writeFile` of a few
kilobytes regardless of how long the conversation has been running.

The `pendingFinalDelivery*` fields encode the durable retry state for the
final user-facing reply — that subsystem lives in Chapter 11; the entry
just owns the persisted markers so a crashed gateway can resume the send.

## 3. Session id resolution: chat metadata to stable id

The session subsystem must answer four orthogonal naming questions:

1. **What does a session look like on disk?** A UUID (`sessionId`) — a fact
   asserted by a single regex at `src/sessions/session-id.ts:1`:

   ```ts
   // src/sessions/session-id.ts:1
   export const SESSION_ID_RE =
     /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
   export function looksLikeSessionId(value: string): boolean {
     return SESSION_ID_RE.test(value.trim());
   }
   ```

   That regex is the entire definition of "is this a session id" — anywhere
   the gateway needs to disambiguate a session id from some other identifier
   (a channel id, a message id, a label), it calls `looksLikeSessionId`.

2. **What does a session look like in the routing table?** A `sessionKey`
   string with a structured prefix shape. The canonical form is
   `agent:<agentId>:<scopedKey>` where `<scopedKey>` itself encodes channel,
   chat type, peer id, and optional thread suffix. The parser sits at
   `src/sessions/session-key-utils.ts:64`:

   ```ts
   // src/sessions/session-key-utils.ts:64
   export function parseAgentSessionKey(
     sessionKey: string | undefined | null,
   ): ParsedAgentSessionKey | null {
     const raw = normalizeSessionKeyPreservingOpaquePeerIds(sessionKey);
     if (!raw) return null;
     const parts = raw.split(":").filter(Boolean);
     if (parts.length < 3) return null;
     if (parts[0] !== "agent") return null;
     const agentId = normalizeOptionalString(parts[1]);
     const rest = parts.slice(2).join(":");
     if (!agentId || !rest) return null;
     return { agentId, rest };
   }
   ```

   The wrapper above it, `normalizeSessionKeyPreservingOpaquePeerIds`
   (`src/sessions/session-key-utils.ts:42`), is what makes case-insensitive
   normalization safe in the presence of channels (notably Signal groups)
   whose peer ids are opaque base64 — those segments are protected by the
   `SIGNAL_GROUP_SESSION_SEGMENT_RE` regex on the line above so that
   lowercase normalization does not corrupt them.

3. **What kind of session is this?** A small enum, `SessionKind`, derived
   from the key plus the entry. The classifier lives in
   `src/sessions/classify-session-kind.ts:1`:

   ```ts
   // src/sessions/classify-session-kind.ts:11
   export function classifySessionKind(
     key: string,
     entry?: { chatType?: string | null; spawnedBy?: string | null },
   ): SessionKind {
     if (key === "global") return "global";
     if (key === "unknown") return "unknown";
     if (isCronSessionKey(key)) return "cron";
     if (entry?.spawnedBy) return "spawn-child";
     if (entry?.chatType === "group" || entry?.chatType === "channel") {
       return "group";
     }
     if (key.includes(":group:") || key.includes(":channel:")) {
       return "group";
     }
     return "direct";
   }
   ```

   The function comment in the source explicitly documents the order — and
   why: "more-specific signals take priority. spawn-child is checked before
   key-shape so ACP spawn-child sessions with opaque keys are not
   misclassified as direct." That ordering is load-bearing for the UI:
   misclassifying a spawned subagent as "direct" would let it appear in
   user-facing conversation lists.

4. **Given a free-form session id, which row do I want?** This is where
   `src/sessions/session-id-resolution.ts:1` does the real work. The
   ambient session store is keyed by `sessionKey`, not by `sessionId`. When
   the gateway receives a "select session" request with a UUID (from
   WebChat URL parameters, CLI args, or a deep-link), it scans the store
   for entries whose key contains that UUID and must pick exactly one. The
   answer is shaped as `SessionIdMatchSelection`:

   ```ts
   // src/sessions/session-id-resolution.ts:15
   export type SessionIdMatchSelection =
     | { kind: "none" }
     | { kind: "ambiguous"; sessionKeys: string[] }
     | { kind: "selected"; sessionKey: string };
   ```

   The naive implementation would `find(matches => matches[0].endsWith(id))`
   and call it a day. That fails three ways:

   - Case-sensitivity. Two store keys that differ only in case (`AGENT:main:MAIN`
     vs `agent:main:main`) refer to the same session but compare unequal.
     `collapseAliasMatches` at `src/sessions/session-id-resolution.ts:54`
     groups them and keeps the freshest, preferring the canonical
     lower-case form when both were updated at the same instant.
   - Structural vs fuzzy. A session id can appear in the **suffix** of a
     key (the canonical case — `agent:main:telegram:direct:<id>`) or as a
     **substring** of some unrelated key. `normalizeSessionIdMatches`
     (line 31) computes an `isStructural` flag that requires the id to be
     at the end of a `:`-segmented region, then the resolver gives
     structural matches priority over fuzzy ones.
   - Genuine ambiguity. If two entries are structurally tied for the same
     id with identical `updatedAt`, the resolver reports
     `{ kind: "ambiguous", sessionKeys: [...] }` instead of guessing. The
     caller's job is to ask the user, not to invent an answer.

   The top-level entry point that ties this together is at line 94:

   ```ts
   // src/sessions/session-id-resolution.ts:94
   export function resolveSessionIdMatchSelection(
     matches: Array<[string, SessionEntry]>,
     sessionId: string,
   ): SessionIdMatchSelection {
     if (matches.length === 0) return { kind: "none" };
     const canonicalMatches = collapseAliasMatches(
       normalizeSessionIdMatches(matches, normalizeLowercaseStringOrEmpty(sessionId)),
     );
     if (canonicalMatches.length === 1) {
       return { kind: "selected", sessionKey: canonicalMatches[0].sessionKey };
     }
     const structuralMatches = canonicalMatches.filter((m) => m.isStructural);
     const selectedStructuralMatch = selectFreshestUniqueMatch(structuralMatches);
     if (selectedStructuralMatch) {
       return { kind: "selected", sessionKey: selectedStructuralMatch.sessionKey };
     }
     ...
   }
   ```

Figure R6.2 shows the resolution flow end to end. The interesting feature
of this design is that the four kinds of identifier (chat metadata,
sessionKey, sessionId, SessionEntry) are crisp, single-purpose values —
none of them tries to be more than one thing.

<svg viewBox="0 0 800 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Session id resolution flow from chat metadata to SessionEntry">
  <defs>
    <marker id="r62arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="40" y="20" width="200" height="68" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.4"/>
  <text x="140" y="42" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">Inbound chat metadata</text>
  <text x="140" y="60" text-anchor="middle" font-size="10" fill="#64748b">channel + chatType + peerId</text>
  <text x="140" y="76" text-anchor="middle" font-size="10" fill="#64748b">+ optional threadId / accountId</text>
  <rect x="300" y="20" width="200" height="68" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
  <text x="400" y="42" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">sessionKey</text>
  <text x="400" y="60" text-anchor="middle" font-size="10" fill="#64748b">agent:&lt;agentId&gt;:&lt;channel&gt;:</text>
  <text x="400" y="76" text-anchor="middle" font-size="10" fill="#64748b">&lt;chatType&gt;:&lt;peerId&gt;[:thread:&lt;tid&gt;]</text>
  <rect x="560" y="20" width="200" height="68" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.4"/>
  <text x="660" y="42" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">SessionEntry</text>
  <text x="660" y="60" text-anchor="middle" font-size="10" fill="#64748b">stored at sessions.json</text>
  <text x="660" y="76" text-anchor="middle" font-size="10" fill="#64748b">includes sessionId + sessionFile</text>
  <line x1="240" y1="54" x2="296" y2="54" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r62arrow)"/>
  <line x1="500" y1="54" x2="556" y2="54" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r62arrow)"/>
  <text x="270" y="46" text-anchor="middle" font-size="9" fill="#94a3b8">classify</text>
  <text x="530" y="46" text-anchor="middle" font-size="9" fill="#94a3b8">lookup</text>
  <rect x="40" y="120" width="720" height="80" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="400" y="142" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Path A: forward lookup (chat metadata to entry)</text>
  <text x="400" y="162" text-anchor="middle" font-size="10" fill="#64748b">deriveSessionChatType + parseAgentSessionKey + store-by-key read</text>
  <text x="400" y="180" text-anchor="middle" font-size="10" fill="#64748b">src/sessions/session-chat-type.ts + src/sessions/session-key-utils.ts</text>
  <rect x="40" y="220" width="720" height="220" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.2"/>
  <text x="400" y="244" text-anchor="middle" font-size="12" font-weight="700" fill="#d97706">Path B: reverse lookup (sessionId to sessionKey)</text>
  <text x="60" y="270" font-size="11" fill="#64748b">1. Collect candidate matches (key, entry) where key looks-like or contains the id</text>
  <text x="60" y="290" font-size="11" fill="#64748b">2. normalizeSessionIdMatches  ->  isCanonicalSessionKey  +  isStructural</text>
  <text x="60" y="310" font-size="11" fill="#64748b">3. collapseAliasMatches  ->  dedupe by canonical request-key form</text>
  <text x="60" y="330" font-size="11" fill="#64748b">4. structural matches take priority; freshest by updatedAt wins ties</text>
  <text x="60" y="350" font-size="11" fill="#64748b">5. tied with no structural answer  ->  selectFreshestUniqueMatch on canonical set</text>
  <text x="60" y="370" font-size="11" fill="#64748b">6. still ambiguous  ->  return { kind: "ambiguous", sessionKeys: [...] }</text>
  <text x="60" y="390" font-size="11" fill="#64748b">7. exactly one survives  ->  return { kind: "selected", sessionKey }</text>
  <text x="60" y="410" font-size="11" fill="#94a3b8">src/sessions/session-id-resolution.ts:94 (resolveSessionIdMatchSelection)</text>
</svg>
<span class="figure-caption">Figure R6.2 | Session id resolution: forward lookup (Path A) builds a key from chat metadata; reverse lookup (Path B) selects the right entry from a UUID via structural and freshness heuristics.</span>

<details><summary>ASCII original</summary>

```
[chat metadata] -classify-> [sessionKey] -lookup-> [SessionEntry]

Forward (Path A): channel+chatType+peerId
  - deriveSessionChatType (session-chat-type.ts)
  - parseAgentSessionKey  (session-key-utils.ts)
  - store lookup by key

Reverse (Path B): sessionId
  1. collect (key,entry) matches containing the id
  2. normalizeSessionIdMatches -> isCanonical, isStructural
  3. collapseAliasMatches      -> dedupe by canonical
  4. prefer structural; freshest updatedAt wins ties
  5. tied with no structural answer -> selectFreshestUniqueMatch
  6. still ambiguous -> { kind: "ambiguous", sessionKeys }
  7. unique answer   -> { kind: "selected", sessionKey }
```

</details>

## 4. The transcript: an append-only event log

Once a session key has been resolved into an entry, the entry's `sessionFile`
points to a JSONL file containing the conversation. The file is **never**
edited in place: every new turn appends one or more JSON lines at the end.
This is the single most important property of the transcript format. It
guarantees:

- A crash midway through a write can corrupt at most the last line, never
  the bytes before it. Crash-recovery code (`src/agents/session-file-repair.ts`)
  truncates the trailing partial line and resumes.
- Multiple readers (the agent runner, transcript-update broadcasters, the
  WebChat history loader) can stream the file without blocking writers.
- The "current state" of a conversation is a pure function of the file's
  bytes — there is no in-memory state that, if lost, would silently leave
  the user with a wrong history.

Each line is one of: a `session` header (only the first line), a `user`
message, an `assistant` message, a `tool_call` / `tool_result` pair, or a
`system_note`. The shape of these lines is owned by `@earendil-works/pi-coding-agent`
and is read back into typed records by the embedded runner; from the
gateway's perspective the transcript is opaque JSONL plus a tiny notification
channel.

That notification channel is the entirety of `src/sessions/transcript-events.ts`:

```ts
// src/sessions/transcript-events.ts:4
export type SessionTranscriptUpdate = {
  sessionFile: string;
  sessionKey?: string;
  message?: unknown;
  messageId?: string;
  messageSeq?: number;
};

const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();

export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => { SESSION_TRANSCRIPT_LISTENERS.delete(listener); };
}

export function emitSessionTranscriptUpdate(update: string | SessionTranscriptUpdate): void {
  const normalized = typeof update === "string"
    ? { sessionFile: update }
    : { sessionFile: update.sessionFile, sessionKey: update.sessionKey, ... };
  ...
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    try { listener(nextUpdate); } catch { /* ignore */ }
  }
}
```

This is the trigger that fires every time anyone appends a line. The
gateway-side broadcaster (Chapter 11) subscribes to it and turns the file
update into a `session.message` WebSocket event for every connected client
that is watching that session — that wiring lives at
`src/gateway/server-session-events.ts:84` (`createTranscriptUpdateBroadcastHandler`).

### Raw events vs shown text

The transcript stores **raw events**. They include things the user must
never see: internal tool-call arguments, exec stdout streams, runtime
context blocks, system notes describing model fallback transitions. The
projection from raw transcript to user-visible text lives in
`src/gateway/chat-display-projection.ts:1` (1219 lines of carefully
type-driven sanitisation; see `projectChatDisplayMessage` on line 84 of
`server-session-events.ts` for the call site).

The split between raw and shown matters in three places:

- **WebChat history.** When the UI loads a session, the gateway runs the
  raw transcript through `projectChatDisplayMessage` so that the WebChat
  surface shows the same text the original channel showed.
- **Replay history sent back to the model.** The prompt builder in
  `src/gateway/agent-prompt.ts` works from the raw transcript, not from
  the projected version, because the model needs the genuine tool I/O. The
  one exception is the stream-error placeholder (see §11.4 of Chapter 11
  for the v2026.5.22 fix that removes those placeholders before the prompt
  is built).
- **Exports.** Session export and search both target the raw transcript so
  that nothing is lost.

## 5. Lifecycle events

The transcript-event channel above only fires on **content** updates.
Higher-level state transitions — a new session was created, a session was
archived, a session was reset, a label changed — go through a parallel
channel at `src/sessions/session-lifecycle-events.ts:1`:

```ts
// src/sessions/session-lifecycle-events.ts:1
export type SessionLifecycleEvent = {
  sessionKey: string;
  reason: string;
  parentSessionKey?: string;
  label?: string;
  displayName?: string;
};

const SESSION_LIFECYCLE_LISTENERS = new Set<SessionLifecycleListener>();

export function emitSessionLifecycleEvent(event: SessionLifecycleEvent): void {
  for (const listener of SESSION_LIFECYCLE_LISTENERS) {
    try { listener(event); } catch {
      // Best-effort, do not propagate listener errors.
    }
  }
}
```

The `reason` string is conventional — `"created"`, `"resumed"`, `"archived"`,
`"deleted"`, `"reset"`, `"label-changed"` and similar — and is consumed by
`createLifecycleEventBroadcastHandler` in `src/gateway/server-session-events.ts:174`,
which packages the event into a `sessions.changed` WebSocket payload along
with a fresh snapshot of the row pulled via `loadGatewaySessionRow`.

Why two channels and not one? Because they have very different fan-out
characteristics. Transcript events fire on every message — possibly several
per second during a streaming reply — and the broadcaster needs to dedupe
and serialise them. Lifecycle events fire a handful of times per session,
never on the hot path, and carry a fundamentally different payload
(sessionKey-only, not message-level). Trying to multiplex them through a
single channel would force every transcript-event consumer to filter out
lifecycle noise and vice versa.

## 6. Run-state: attempts per user message

A user sends one message. The gateway frequently invokes the agent **more
than once** to serve it. The transcript event log faithfully records every
attempt — model-rotation retries after a rate limit, recovery attempts
after a stream error, follow-up turns that the agent itself queued
(`queueMode: "followup"` on the entry, see §7) — and each attempt
produces a status the gateway needs to surface.

The attempt-record machinery proper lives in the agent runner
(`src/agents/pi-embedded-runner/`); from the session subsystem's
perspective, three SessionEntry fields encode the visible state:

- `status?: "running" | "done" | "failed" | "killed" | "timeout"` — the
  durable status of the last attempt for subagent sessions. The
  status-update machinery is at `src/agents/pi-embedded-runner/run/attempt.ts`.
- `abortedLastRun?: boolean` — a sticky flag set when `/stop` cuts an
  attempt short. It tells the next turn that the prior assistant message
  is incomplete.
- `quotaSuspension?: QuotaSuspension` — see `src/config/sessions/types.ts:147`.
  When a quota cascade trips a lane suspension, the suspension state is
  persisted on the entry so a restart can resume rather than retry into
  the same wall.

The attempts model is the reason the SessionEntry carries a
`liveModelSwitchPending?: boolean` (line 280 of types.ts) — the runner has
to distinguish a user-driven `/model` change during an active attempt
(which throws `LiveSessionModelSwitchError` and tears the attempt down
cleanly) from a system-driven fallback rotation (which transparently swaps
the provider and continues the same attempt).

## 7. Per-session overrides

A session is not a passive memory; users routinely customise its
behaviour mid-conversation. These customisations all live as direct fields
on the `SessionEntry`, with thin per-field modules that handle parsing,
validation, and the conventional null/undefined "clear vs keep" semantics.

### 7.1 Verbose & trace level (`src/sessions/level-overrides.ts`)

`level-overrides.ts:1` owns four operations, each on `entry.verboseLevel`
and `entry.traceLevel`:

```ts
// src/sessions/level-overrides.ts:12
export function parseVerboseOverride(
  raw: unknown,
): { ok: true; value: VerboseLevel | null | undefined } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return { ok: false, error: 'invalid verboseLevel (use "on"|"off"|"full")' };
  }
  const normalized = normalizeVerboseLevel(raw);
  if (!normalized) {
    return { ok: false, error: 'invalid verboseLevel (use "on"|"off"|"full")' };
  }
  return { ok: true, value: normalized };
}

export function applyVerboseOverride(entry: SessionEntry, level: VerboseLevel | null | undefined) {
  if (level === undefined) return;
  if (level === null) { delete entry.verboseLevel; return; }
  entry.verboseLevel = level;
}
```

The three-state convention is load-bearing across this whole module
family: `undefined` means "the caller did not specify, keep the existing
value", `null` means "the caller explicitly cleared it, fall back to the
config-level default", and a concrete string means "set it to this".
Without that convention, the RPC handlers in `src/gateway/server-methods/sessions.ts`
could not distinguish "the API caller did not send this field" from "the
caller wants to reset it to default" — both would look like `undefined`
JSON values.

### 7.2 Model & provider (`src/sessions/model-overrides.ts`)

`model-overrides.ts:23` walks the same three-state pattern but with more
fields, because a model change can ripple into the auth profile, the
fallback origin, and the runtime model identity:

```ts
// src/sessions/model-overrides.ts:23
export function applyModelOverrideToSessionEntry(params: {
  entry: SessionEntry;
  selection: ModelOverrideSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  ...
}): { updated: boolean } {
  ...
  if (selection.isDefault) {
    if (entry.providerOverride) { delete entry.providerOverride; updated = true; }
    if (entry.modelOverride) { delete entry.modelOverride; updated = true; }
    ...
  } else {
    if (entry.providerOverride !== selection.provider) { ... }
    if (entry.modelOverride !== selection.model) { ... }
    ...
  }
  ...
```

The `modelOverrideSource: "auto" | "user"` distinction is the analogue of
`liveModelSwitchPending` from §6: when a transient fallback writes the
override (e.g. rate-limit rotation), the source is `"auto"`, and a session
reset will clear it. A user-driven `/model` writes `"user"`, and reset
preserves it — the user's explicit choice survives a transient outage.

### 7.3 Send policy (`src/sessions/send-policy.ts`)

`send-policy.ts:1` answers a simple question with surprisingly intricate
input: should this session allow outbound replies at all? Useful for
silencing a noisy session without deleting it. The entry carries
`sendPolicy?: "allow" | "deny"`; the resolver `resolveSendPolicy` at
`src/sessions/send-policy.ts:81` combines that with the global config
defaults, the channel id, and the chat type to produce a final allow/deny.

The non-trivial bits are the inferences when the entry hasn't been
explicitly stamped:

```ts
// src/sessions/send-policy.ts:46
function deriveChatTypeFromKey(key?: string): SessionChatType | undefined {
  const normalizedKey = normalizeOptionalLowercaseString(stripAgentSessionKeyPrefix(key));
  if (!normalizedKey) return undefined;
  const tokens = new Set(normalizedKey.split(":").filter(Boolean));
  if (tokens.has("group")) return "group";
  if (tokens.has("channel")) return "channel";
  if (tokens.has("direct") || tokens.has("dm")) return "direct";
  const derived = deriveSessionChatType(normalizedKey);
  if (derived !== "unknown") return derived;
  return undefined;
}
```

This is the same chat-type inference that `classifySessionKind` uses,
factored out so that a send-policy decision can be made for a key whose
entry has not yet been loaded (the dispatch path needs it before
`resolveSessionStoreEntry`).

## 8. Context compaction

Even with the cheapest possible token rate, a conversation that runs for a
week will exceed any model's context window. The session subsystem cannot
"just stop replying" — it has to summarise. The mechanism is **context
compaction**, and the SessionEntry carries its checkpoint history in
`compactionCheckpoints?: SessionCompactionCheckpoint[]` (defined at
`src/config/sessions/types.ts:96`).

```ts
// src/config/sessions/types.ts:88
export type SessionCompactionCheckpointReason =
  | "manual"
  | "auto-threshold"
  | "overflow-retry"
  | "timeout-retry";

export type SessionCompactionCheckpoint = {
  checkpointId: string;
  sessionKey: string;
  sessionId: string;
  createdAt: number;
  reason: SessionCompactionCheckpointReason;
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
  firstKeptEntryId?: string;
  preCompaction: SessionCompactionTranscriptReference;
  postCompaction: SessionCompactionTranscriptReference;
};
```

Each checkpoint records the "before" and "after" transcript references —
crucially, **compaction does not edit the existing transcript file**.
Instead, it forks a new `sessionId` and writes a new JSONL with a
summary-derived header, leaving the old transcript intact and reachable
via the checkpoint's `preCompaction` reference. The checkpoint list is
capped at `MAX_COMPACTION_CHECKPOINTS_PER_SESSION = 25`
(`src/gateway/session-compaction-checkpoints.ts:24`); older checkpoints
are trimmed and their transcripts garbage-collected.

The four reasons differentiate the trigger:

- `"auto-threshold"` — the runner's pre-turn budget check projected an
  overflow and ran compaction proactively.
- `"overflow-retry"` — the runner sent a turn, the provider returned a
  context-overflow error, the runner compacted and retried.
- `"timeout-retry"` — the runner's compaction call itself timed out and
  the retry succeeded with a smaller window.
- `"manual"` — a `/compact` command from the user.

The compaction trigger itself lives in the embedded runner
(`src/agents/pi-embedded-runner/compact.ts` — note line 989, where the
session-lock `maxHoldMs` resolves to a value derived from the compaction
timeout: a compaction that holds a lock for longer than its own timeout
should be reclaimable, which is the very property the v2026.5.22 backport
in §10 enforces).

The runtime side of compaction — *what* to keep, *what* to summarise — is
delegated to the **context engine** (`src/context-engine/`). The engine
returns an `AssembleResult`:

```ts
// src/context-engine/types.ts:5
export type AssembleResult = {
  messages: AgentMessage[];
  estimatedTokens: number;
  promptAuthority?: "assembled" | "preassembly_may_overflow";
  systemPromptAddition?: string;
  contextProjection?: ContextEngineProjection;
};
```

Reading that result back into a session is straightforward: the new
transcript file becomes the session's transcript, the entry's `sessionId`
rotates to the new UUID, `compactionCount` increments, a checkpoint is
pushed, and the old transcript is reachable but no longer the active one.
Importantly, the session **key does not change** — only the entry's
`sessionId` / `sessionFile`. The UI sees a session that "remembers"
everything; under the hood it has been re-anchored to a smaller transcript.

## 9. Storage backend

The session store is one JSON file per agent, written atomically (write to
a temp file then rename). The transcript is one JSONL file per session
written with `fs.appendFile`. There is no database. This choice is
intentional and is justified by three properties:

- **Portability.** OpenClaw runs on user laptops, dev machines, Raspberry
  Pi boxes, headless servers. Mandating a database engine would alienate
  half the deployments.
- **Inspectability.** The transcript files are `cat`-able JSONL. A user
  can grep them, back them up with rsync, and inspect them with `jq`.
- **No schema migrations to coordinate with users.** Schema is enforced
  by the TypeScript types; format mismatches become parse errors handled
  by `session-file-repair.ts`.

What the filesystem does **not** give you for free is concurrency. Two
gateway processes (or two threads inside one process) trying to append to
the same transcript at the same time will produce one transcript with two
attempts interleaved — possibly two half-written assistant messages. The
answer is the session write lock.

## 10. The v2026.5.22 session-lock backport

The session write lock is one file per transcript: `<sessionFile>.lock`.
Its payload — JSON, written into the lockfile when acquired — is the
owning PID, the process start time (to detect PID recycling), the
ISO-formatted `createdAt`, and a `maxHoldMs` value:

```ts
// src/agents/session-write-lock.ts:10
type LockFilePayload = {
  pid?: number;
  createdAt?: string;
  starttime?: number;
  maxHoldMs?: number;
};

export const DEFAULT_SESSION_WRITE_LOCK_STALE_MS = 30 * 60 * 1000;
export const DEFAULT_SESSION_WRITE_LOCK_MAX_HOLD_MS = 5 * 60 * 1000;
export const DEFAULT_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
```

The three timeouts are deliberately tiered:

- **`acquireTimeoutMs = 60s`** — how long a caller will wait for the lock
  before giving up and throwing `SessionWriteLockTimeoutError`.
- **`maxHoldMs = 5min`** — how long a single holder is allowed to keep
  the lock. The local-process watchdog releases its own lock if a single
  hold exceeds this.
- **`staleMs = 30min`** — how long another process's lock can persist on
  disk before it is considered abandoned regardless of liveness.

Two separate enforcement paths exist:

1. A **watchdog** running inside the holding process. Every minute it
   walks every lock currently held by this process and force-releases any
   that have been held longer than `maxHoldMs`:

   ```ts
   // src/agents/session-write-lock.ts:254
   async function runLockWatchdogCheck(nowMs = Date.now()): Promise<number> {
     let released = 0;
     for (const held of SESSION_LOCKS.heldEntries()) {
       const maxHoldMs = typeof held.metadata.maxHoldMs === "number"
         ? held.metadata.maxHoldMs
         : DEFAULT_SESSION_WRITE_LOCK_MAX_HOLD_MS;
       const heldForMs = nowMs - held.acquiredAt;
       if (heldForMs <= maxHoldMs) continue;
       process.stderr.write(
         `[session-write-lock] releasing lock held for ${heldForMs}ms (max=${maxHoldMs}ms): ${held.lockPath}\n`,
       );
       const didRelease = await held.forceRelease();
       if (didRelease) released += 1;
     }
     return released;
   }
   ```

2. A **`shouldReclaim`** callback invoked during lock acquisition. When a
   contending process can't grab the lock, it asks "is the current holder
   actually still working?". Until PR #85764, that callback only checked
   `staleMs` (30 minutes). That meant a buggy hold of 10 minutes on a
   live PID would block contenders for the full 60 second acquire timeout
   and then throw — even though the local watchdog would have released
   the lock had it been awake. The fix is the addition of `respectMaxHold`
   to the inspection at `src/agents/session-write-lock.ts:484`:

   ```ts
   // src/agents/session-write-lock.ts:484
   const holderMaxHoldMs =
     isValidLockNumber(payload?.maxHoldMs) && payload.maxHoldMs > 0
       ? payload.maxHoldMs : undefined;
   if (
     opts.respectMaxHold === true &&
     typeof holderMaxHoldMs === "number" &&
     ageMs !== null &&
     ageMs > holderMaxHoldMs
   ) {
     staleReasons.push("hold-exceeded");
   }
   ```

   The acquisition path threads `respectMaxHold: !heldByThisProcess` into
   both `shouldReclaim` and `shouldRemoveStaleLock`
   (`src/agents/session-write-lock.ts:752`):

   ```ts
   // src/agents/session-write-lock.ts:752
   shouldReclaim: async ({ payload, nowMs, heldByThisProcess }) => {
     const inspected = inspectLockPayloadForSession({
       payload: payload as LockFilePayload | null,
       staleMs,
       nowMs,
       heldByThisProcess,
       reclaimLockWithoutStarttime: true,
       readOwnerProcessArgs: readProcessArgsSync,
       respectMaxHold: !heldByThisProcess,
     });
     return await shouldReclaimContendedLockFile(lockPath, inspected, staleMs, nowMs);
   },
   ```

   The `!heldByThisProcess` clause is the asymmetry that makes the model
   safe: a process only enforces `maxHoldMs` against **other** processes'
   locks. Its own holder is allowed to remain — releasing your own lock
   from under your own writer would corrupt the very file the lock was
   protecting.

The release notes for the PR (commit `8ac7cd621b`) explain the user-visible
symptom that motivated the change:

> Previously shouldReclaim only used staleMs (30min default), meaning a
> lock held for 10+ minutes by a live PID would never be reclaimable,
> causing 60s timeout failures and gateway freezes.

A follow-up commit in the same PR also adds a **dead-PID fast-path** at
the top of `acquireSessionWriteLock` — if the lock file's owner PID is
dead, the entry is removed immediately before entering the retry loop
rather than waiting through up to 60 seconds of futile retries. Both fixes
shipped together as the "keep session lock backport scoped" branch in this
release (`0b2f8dfbdb`).

The combined effect: a v2026.5.22 gateway never freezes for 60 seconds on
a contended lock when the holder is misbehaving or dead. It either grabs
the lock immediately (dead holder), reclaims it after `maxHoldMs` (live
but-overlong holder), or fails fast.

## 11. Putting it together: the lifetime of a session

A concrete trace stitches the pieces above together.

1. A user sends a message in a Telegram DM. The inbound pipeline
   (Chapter 05) classifies it as `chatType: "direct"` and computes the
   sessionKey `agent:main:telegram:direct:<peerId>` via the helpers in
   `session-key-utils.ts` plus the channel-side label resolvers.
2. `resolveSessionStoreEntry` (in the gateway, not the sessions package)
   reads the session store and either finds an existing entry or creates
   a fresh one. A new entry gets a UUID for `sessionId` and an absolute
   path for `sessionFile`.
3. `classifySessionKind(key, entry)` returns `"direct"`. The UI uses this
   to put the session in the right list.
4. The dispatch pipeline checks `entry.sendPolicy` via `resolveSendPolicy`
   from `src/sessions/send-policy.ts`. If `"deny"`, the message is
   silently dropped; if `"allow"`, it proceeds.
5. The agent runner acquires the session write lock
   (`acquireSessionWriteLock` from `src/agents/session-write-lock.ts:712`)
   for `<sessionFile>.lock`. With the v2026.5.22 fix, a contending
   process will be able to reclaim the lock if this attempt holds it
   longer than `maxHoldMs`.
6. The runner appends a `user` line to the transcript. `emitSessionTranscriptUpdate`
   fires; the gateway broadcaster relays it to WebChat clients as a
   `session.message` event.
7. The runner calls the context engine to assemble a prompt. If
   `estimatedTokens` exceeds the budget, the engine triggers compaction;
   a new `sessionId` is allocated, the old transcript becomes a
   checkpoint reference on the entry, and the session continues with a
   summarised seed.
8. The provider streams an assistant reply. Each delta is appended to
   the transcript and fires a transcript-update event.
9. On completion the runner releases the lock; `entry.updatedAt`,
   `entry.inputTokens`, `entry.outputTokens`, `entry.totalTokens`,
   `entry.contextTokens`, and `entry.estimatedCostUsd` are updated and
   the session store is rewritten.
10. If the user issues `/model gpt-something`, `applyModelOverrideToSessionEntry`
    runs on the entry with `selectionSource: "user"`. The next turn picks
    up the override; a later `/reset` will preserve it because the
    `modelOverrideSource` is `"user"`.
11. If the user closes the Telegram chat and the same conversation is
    opened on WebChat 12 hours later — same channel, same peerId — the
    session resolves to the **same** sessionKey, and the same entry, and
    therefore the same transcript. Persistence has worked.
12. Eventually a `/delete` command issues `emitSessionLifecycleEvent({
    sessionKey, reason: "deleted" })`; the broadcaster turns it into a
    `sessions.changed` WebSocket event so every open UI removes the row.

Throughout: every byte the agent wrote can be `cat`-ed from the JSONL
file. Every override can be inspected with `jq` over `sessions.json`.
There is no hidden state — and there is no opportunity for two processes
to silently corrupt the same transcript even if one of them misbehaves
for ten minutes.

## 12. Where to read next

The session subsystem is small in absolute LOC but is touched by almost
every other chapter. The cleanest reading order from here is:

- Chapter 07 picks up at the agent runner that holds the write lock.
- Chapter 11 picks up at the transcript event channel and turns it into
  WebSocket broadcasts and durable delivery.
- The context-engine package (`src/context-engine/`) hides behind the
  compaction interface and is where the actual "what to summarise"
  decision lives.

The smallest mental model that survives this whole subsystem is the
one this chapter started with: **two layers, one lock, one append-only
log**. Every other complication — session-id resolution, overrides,
compaction, lifecycle events — is bolted onto that core without
disturbing it.
