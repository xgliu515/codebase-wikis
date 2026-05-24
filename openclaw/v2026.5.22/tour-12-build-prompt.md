# Tour Step 12: Building the prompt and context

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

The previous step (tour-11) left us with everything an attempt needs to actually call a model. The agent runtime is resolved: provider `anthropic`, default model `claude-opus-4-7` (from `extensions/anthropic/register.runtime.ts:48`), workspace directory, session id and key, an auth profile, and a still-empty attempt record waiting for `assistant` events. The current user message — the literal string `"hello"` — has already passed through inbound normalization. The session transcript file exists on disk with one user entry written into it. What we do not yet have is a payload anything resembling an HTTP body. The provider runtime expects to be handed a fully-shaped `{ model, context, options }` triple, where `context` carries the conversation history plus the assembled system prompt, and where every byte is a deliberate choice. This step builds that object.

For WebChat with the default Anthropic provider, the visible work happens in two places: the gateway HTTP layer that turned the OpenAI-shaped chat request into an internal `ConversationEntry[]` plus a flat prompt string (`src/gateway/openai-http.ts:666` calls `buildAgentMessageFromConversationEntries`), and the embedded agent runner inside the attempt that turns that string back into a model-specific message list. Both halves cooperate, but the gateway side owns the **filter** for stream-error placeholders that landed in v2026.5.22 via PR #85652.

The gateway layer is the one we trace in detail here because WebChat's path goes through `/v1/chat/completions` on the OpenAI-compatible endpoint and reaches `agent-command` only after the flat-prompt assembly. Once `agent-command` invokes `runEmbeddedPiAgent`, the attempt-internal builder takes over and produces the structured `system` plus `messages` shape that the provider expects. We name both halves below because the failure modes the v2026.5.22 fix addresses live at the gateway, where stale assistant rows from previous failed turns can reappear in the incoming chat-completions request body and need to be filtered before they reach the model.

## 2. The problem

> Build an LLM request that is correct (every needed piece included, none missing), byte-deterministic across runs (so Anthropic prefix caching can hit), provider-shape-aware (Anthropic Messages, OpenAI completions, and OpenAI Responses do not share a payload), and free of garbage from past failures — specifically, do **not** re-feed the model assistant turns whose content was the sentinel placeholder we wrote when a previous stream errored.

The third constraint, byte-determinism, is not aesthetic. Anthropic Messages caching is computed over the exact serialized prefix of `system` + leading `messages`; any field order shuffle on rebuild discards the cache hit and bills the entire context as fresh input tokens. The fourth constraint is the surprising one: OpenClaw deliberately writes a sentinel string (`STREAM_ERROR_FALLBACK_TEXT`, `src/agents/stream-message-shared.ts:90`) into the assistant `content` of any turn whose stream died before producing real text, because empty assistant content trips Bedrock Converse validation and produces a fatal replay loop. The sentinel keeps the session file replayable, but it must never reach the next provider call.

## 3. Naive approach

Read the transcript file, deserialize it, append the new user message, send the whole thing verbatim as `messages`, hand the agent config's `systemPrompt` field as `system`, hand the registered tool list as `tools`. One function, one shape, ship it.

```ts
const history = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
const messages = [...history, { role: "user", content: "hello" }];
return streamFn(model, { system: agentConfig.systemPrompt, messages, tools });
```

## 4. Why the naive approach breaks

**Stream-error placeholders poison the next turn.** When a previous attempt's stream blew up halfway, OpenClaw persisted an `assistant` turn whose `content` is `[{ type: "text", text: "[assistant turn failed before producing content]" }]` and whose `stopReason` is `"error"` (`src/agents/stream-message-shared.ts:92-107`). The next call would replay that sentinel back to the model, asking it to continue from "assistant said: turn failed before producing content" — pure nonsense. Worse, the live provider error string is intentionally **not** stored in `content` to avoid prompt-injection from upstream hostnames or stack frames (`src/agents/stream-message-shared.ts:75-90`), so even diagnostic info is unavailable in the content slot. The sentinel exists because Bedrock Converse rejects assistant messages with `content: []` during replay; deleting the turn entirely would lose the timestamped audit trail, so OpenClaw keeps the row and filters it at the prompt boundary instead.

**Tool-call placeholders without their results corrupt the call.** A naive replay re-emits an assistant turn with `tool_use` blocks but no matching `tool_result` entries, which Anthropic rejects outright. Even if the model accepts the malformed pair, the next assistant turn would be free to invent fictional tool outputs.

**The "system prompt" is not the config field.** Each provider has its own shape — Anthropic wants a structured array of `text` blocks with optional `cache_control`, OpenAI Responses wants instructions on the request itself — and provider plugins contribute prompt fragments (`promptContribution`) that must be merged in deterministic order. A single string field cannot express any of this.

**Order shuffles break Anthropic prefix caching.** `applyAnthropicPayloadPolicyToParams` (`src/agents/anthropic-payload-policy.ts:205`) only tags the **last** user block with `cache_control` (line 228), counting on the prefix being byte-stable up to that point. If the prompt builder reorders system blocks across runs, the cache write key shifts and the next turn pays full freight. Multiply by hundreds of turns in a long chat session and the bill becomes obvious.

**Provider-specific encoding leaks through.** Tools come back from the tool registry as a generic schema; Anthropic and OpenAI demand different field names and nesting; the naive call has no place to make that translation without coupling the gateway HTTP shim to every provider.

## 5. OpenClaw's approach

OpenClaw's approach is to split prompt construction into a **layered builder** with a **provenance-aware filter** at the gateway boundary, then hand a provider-agnostic intermediate shape to the agent runtime, which finalises it for the chosen provider.

**Layer 1 — gateway flattens, filters, hands off a string.** The WebChat / OpenAI-compatible HTTP layer at `src/gateway/openai-http.ts:666` walks the incoming `messages[]` from the chat request and builds `ConversationEntry[]` (`src/gateway/agent-prompt.ts:5-9`). Each entry carries `{ role, entry: { sender, body }, internalStreamError? }`. The crucial flag `internalStreamError` is set when the assistant message has `stopReason === "error"` **and** its body equals `STREAM_ERROR_FALLBACK_TEXT` (`src/gateway/openai-http.ts:659-663`). The filter is conservative: it does not match by content alone — ordinary assistant text that happens to mention the sentinel substring is preserved (`src/gateway/agent-prompt.test.ts:119-128`); only the exact sentinel paired with the error role is dropped.

The drop happens in `toPromptEntry` (`src/gateway/agent-prompt.ts:20-33`):

```ts
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

The builder then takes the last `user`-or-`tool` entry as the **current message** (`src/gateway/agent-prompt.ts:42-52`) and renders the remaining history with `buildHistoryContextFromEntries` (line 73). For our "hello" trace, history is empty, so the function returns just `"hello"`.

The walk in the gateway is intentionally shallow — it does not interpret tool calls, multimodal attachments, or thinking blocks at this stage. Image-only user turns get a fixed placeholder (`IMAGE_ONLY_USER_MESSAGE`, applied at `src/gateway/openai-http.ts:632-634`) so a hidden historical image does not silently empty out an entry; the actual image bytes ride a separate attachment path that re-attaches them at the attempt layer when relevant. The conversation-entry walk also normalises the `sender` label (`"Assistant"` / `"User"` / `"Tool:<id>"`) so the formatted history reads the same regardless of upstream client conventions.

**Layer 2 — attempt assembles the structured payload.** The flat prompt string flows through `agentCommand` (the runtime resolved in tour-11) down into the embedded pi attempt at `src/agents/pi-embedded-runner/run/attempt.ts:2697`, where `resolveEmbeddedAgentStreamFn` produces the `streamFn` and the system prompt is built by `buildAttemptSystemPrompt` (called earlier in the same attempt). The system text is then provider-policed by `applyAnthropicPayloadPolicyToParams` (`src/agents/anthropic-payload-policy.ts:205-229`), which splits the system text around any cache boundary marker, attaches `cache_control: { type: "ephemeral" }` to the stable prefix, and tags the trailing user content block — the "hello" — with `cache_control` so the next turn can write through it.

The cache-control TTL itself is eligibility-gated by `isLongTtlEligibleEndpoint` (`src/agents/anthropic-payload-policy.ts:40-53`): only `api.anthropic.com` and the Vertex hostnames `aiplatform.googleapis.com` / `*-aiplatform.googleapis.com` are trusted for the 1-hour TTL by default, with explicit `cacheRetention: "long"` opt-ins respected for Anthropic-compatible custom providers. Everything else gets the short TTL.

A second policy responsibility worth flagging: `applyAnthropicPayloadPolicyToParams` also calls `stripAnthropicSystemPromptBoundary` (line 120-134) when caching is disabled, so the boundary markers embedded in the system text never leak out as visible content. The same function inserts the `service_tier` field only when both the provider's capability map allows it (`allowsServiceTier`, resolved by `resolveProviderRequestCapabilities`) and the caller explicitly opted in — defaults stay conservative so a custom Anthropic-compatible endpoint without service-tier support is not sent an unsupported field.

**Layer 3 — observability without mutation.** `createAnthropicPayloadLogger` (`src/agents/anthropic-payload-log.ts:100-158`) wraps the `streamFn` so that whenever the model api is `"anthropic-messages"` it can record the *exact* outgoing payload through the `onPayload` callback the provider exposes. The wrapper does not change the payload, only observes it — important because byte-determinism would die if the logger touched the request. The recorded entry is gated on `OPENCLAW_ANTHROPIC_PAYLOAD_LOG=1` (`src/agents/anthropic-payload-log.ts:41-48`) and writes JSONL to a state-dir log, with a SHA-256 digest of the canonicalised payload for deduplication across reruns.

**Why this composition holds.** The gateway filter is purely additive (it drops, never rewrites); the attempt-level builder is purely constructive (it composes from typed inputs in fixed order); the payload-policy pass is a single deterministic patch that runs last and only sets fields. No layer reads the wall clock, no layer iterates a `Map` in insertion order without sorting. The result is the same bytes on the wire every time the same inputs are presented — which is what Anthropic's prefix cache needs to amortize the (eventually large) system block across hundreds of follow-up turns in a chat session.

For our "hello" trace, the user prompt has no preceding history, so `buildAgentMessageFromConversationEntries` returns `"hello"` unchanged at line 69; the attempt-level builder produces a single system block plus one user message containing the literal `"hello"`; the payload-policy pass attaches `cache_control` to that user block. The whole pipeline collapses to a few hundred bytes for a first turn — but the same code path scales to a 200-turn coding session where the system prompt and history dwarf the latest user message, and the cache hit is what keeps that session affordable.

## 6. Code locations

- `src/gateway/agent-prompt.ts:5-9` — `ConversationEntry` shape with the `internalStreamError` provenance flag.
- `src/gateway/agent-prompt.ts:20-33` — `toPromptEntry`, the provenance-aware drop logic.
- `src/gateway/agent-prompt.ts:35-78` — `buildAgentMessageFromConversationEntries`, the flat-prompt assembler.
- `src/gateway/openai-http.ts:656-663` — where the gateway tags `internalStreamError` on assistant entries before passing them to the builder.
- `src/gateway/openai-http.ts:666-671` — call site producing the flat `message` plus `extraSystemPrompt`.
- `src/agents/stream-message-shared.ts:75-107` — `STREAM_ERROR_FALLBACK_TEXT` definition, with the in-source rationale explaining why the placeholder lives in `content` but the raw error must not.
- `src/agents/anthropic-payload-policy.ts:55-71` — Anthropic ephemeral cache-control resolver and TTL eligibility.
- `src/agents/anthropic-payload-policy.ts:136-180` — apply cache control to the trailing user block (only the last block, to preserve cache-write scope).
- `src/agents/anthropic-payload-policy.ts:205-229` — `applyAnthropicPayloadPolicyToParams`, the deterministic payload patch.
- `src/agents/anthropic-payload-log.ts:100-158` — observability wrapper around `streamFn` via `onPayload`.
- `src/agents/pi-embedded-runner/run/attempt.ts:2697-2706` — where the attempt installs its `streamFn` and locks in the context.
- `src/sessions/transcript-events.ts:23-57` — `emitSessionTranscriptUpdate`, the channel by which transcript writes notify listeners (used in tour-14).
- `src/gateway/agent-prompt.test.ts:98-117` — the contract test for stream-error placeholder filtering.

## 7. Branches and extensions

The "hello" trace is the simplest possible build: no tools needed, no skills snapshot, no thinking budget, no compaction, no multimodal blobs. Variations live in dedicated subsystems:

- See [Chapter 07 §4 — model and provider resolution](07-agent-execution.md) for how the four-layer model override (request, session, agent, default) settles to `anthropic/claude-opus-4-7` for this run.
- See [Chapter 08 §4 — plugin-SDK and the unified call shape](08-llm-providers.md) for how `StreamFn(model, context, options)` is the single type every provider implements, and how `ProviderWrapStreamFnContext` lets provider plugins layer their own transforms.
- See [Chapter 11 §4 — stream-error placeholder filtering](11-delivery-and-events.md) for the full v2026.5.22 PR #85652 design: which roles the filter applies to, why content-only matching is unsafe, and how the same sentinel is also dropped by `replay-history.ts` on the embedded path.
- See [Chapter 06 §4 — transcript events](06-sessions.md) for the writer side of the transcript that becomes next turn's history input.

Other branches worth noting but not on this trace:

- **Long-conversation compaction** (`src/agents/pi-embedded-runner/compaction-*.ts`) rewrites history before it reaches the builder when total tokens approach the context window. The compacted summary message replaces a span of older turns and itself carries metadata that the builder respects.
- **Raw model runs** bypass `buildAttemptSystemPrompt` entirely and submit a minimal system block, used for evaluator-style fixtures and the `--no-agent` debug path.
- **Tool replay normalization** strips internal tool-call metadata before the messages leave the attempt, so provider-side replay does not see OpenClaw-specific telemetry fields.
- The **OpenAI Responses** flavor at `src/gateway/openresponses-prompt.ts` uses the same `buildAgentMessageFromConversationEntries` entry point but feeds a different downstream shape (`instructions` field on the request rather than `system` messages, and a structured input array for multimodal turns).
- **Skills context** is loaded by `agent-command` and travels alongside the prompt as a separate `skillsSnapshot` field, which the attempt's system-prompt builder splices in at a fixed location; for "hello" the snapshot is empty.
- The **Anthropic CLI backend** path (`extensions/anthropic/cli-backend.ts`) when present locally delegates the entire call to the installed Claude CLI binary; the gateway-side filter still applies because the CLI is reached through the same `agent-command` entry point, but the structured payload assembly is owned by the CLI process instead of the in-process payload-policy code.

## 8. What you should now have in your head

- Prompt construction is **two layers**: a gateway-side flattener that drops stream-error placeholders before they leave the gateway, and an attempt-side assembler that produces the structured provider payload. The two layers cannot be merged: the gateway only sees the OpenAI-shape request, the attempt only sees the agent-shape context, and the filter must run at the boundary.
- The stream-error sentinel exists for a real reason — empty assistant content trips Bedrock Converse on replay — but it must be **provenance-tagged at write time** (`internalStreamError: true`) and filtered at read time. Content-only matching is unsafe because ordinary text could mention the sentinel string verbatim, as the test at `src/gateway/agent-prompt.test.ts:119-128` enforces.
- Anthropic prefix caching is **byte-deterministic or it does not hit**. The payload policy in `anthropic-payload-policy.ts` tags only the trailing user block with `cache_control` so the entire preceding prefix forms a stable cache key; reorder it and you pay full freight on every turn.
- Observability (`createAnthropicPayloadLogger`) attaches via the provider's `onPayload` hook **without** mutating the payload, which is mandatory for cache-determinism.
- After this step, the agent runtime holds a fully-formed `(model, context, options)` triple ready to invoke. The next step opens the SSE stream to Anthropic.
- The Anthropic policy module is one of three reasons the v2026.5.22 release shipped tighter byte-determinism guarantees: (i) the gateway-side stream-error filter (#85652), (ii) the policy module's last-block-only cache tagging, and (iii) the openai-responses retry guard expansion (#85603) covered in the next step. Together they reduce both prompt-token cost and the risk of garbage replay.
