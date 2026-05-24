# Tour Step 08: Session resolution & load

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

`dispatchInboundMessage` has finalized the context and called `dispatchReplyFromConfig` (`src/auto-reply/reply/dispatch-from-config.ts:744`). The very first thing that function does after extracting easy attributes — `channel`, `chatId`, `messageId`, `sessionKey` — is run `resolveSessionStoreLookup(ctx, cfg)` at line 852:

```ts
const initialSessionStoreEntry = resolveSessionStoreLookup(ctx, cfg);
const boundAcpDispatchSessionKey = resolveBoundAcpDispatchSessionKey({ ctx, cfg });
const acpDispatchSessionKey =
  boundAcpDispatchSessionKey ?? initialSessionStoreEntry.sessionKey ?? sessionKey;
const dispatchOperationSessionKey =
  initialSessionStoreEntry.sessionKey ?? sessionKey ?? acpDispatchSessionKey;
```

(`src/auto-reply/reply/dispatch-from-config.ts:852-860`). The MsgContext carries `SessionKey` (set by chat.send in step 06), and the gateway has already called `loadSessionEntry(rawSessionKey)` once during request validation (step 05, `src/gateway/session-utils.ts:764-784`) to canonicalize the key. So the SessionKey on `ctx` is already in canonical form — for our trace, something like `agent:default:webchat:direct:<sessionId>`. What is *not* yet known is the SessionEntry, the per-session overrides, and the agent and model for this turn.

## 2. The problem

A single OpenClaw user spans many surfaces and many points in time. They start a WebChat session in the morning, switch to Telegram at noon, archive a thread, come back next week. Every inbound message has to resolve to a single, stable session identity — but "stable" has to mean something different depending on context:

- The same WebSocket connection from the browser sending two messages back-to-back must hit the same session.
- A reload of the page (new WebSocket, same WebChat sessionKey persisted in localStorage) must still hit the same session.
- A user typing in two different WebChat threads must produce two *different* sessions even though the channel id is the same.
- A user opening an archived session must reattach to it (with the old transcript) rather than create a fresh one.
- A new conversation that happens to reuse an old chat-id at the provider level (e.g. Slack channel renamed and reused) must *not* bleed across.

And on top of that: this user can have per-session overrides — a specific model, a specific verbose/trace level, a specific send-policy. The session-level overrides must layer cleanly over the agent-level defaults and the global config defaults.

## 3. Naive approach

Use the channel-provided chat-id directly as the session-id. `telegram:chat:12345` is the session key. WebChat passes its own `sessionKey` parameter, so use that verbatim. Look up the entry in the store by string equality. If not found, create one.

## 4. Why the naive approach breaks

- **Cross-channel collisions**: Telegram chat id `12345` and Slack channel id `12345` are unrelated, but the chat-id-only key cannot distinguish them. The agent prefix (`agent:<agentId>:`) is needed too.
- **Casing**: provider ids come back inconsistently cased (Slack user ids are upper-case `U…`, Matrix room ids contain mixed case, WebChat keys may be user-typed). String-equal lookups miss aliased entries. The store must be queried case-insensitively, but the canonical key stored on disk must be stable so that the *same* entry is updated and not duplicated.
- **Sub-conversations**: a single Telegram supergroup can host many topic threads. A single Slack channel can host many `thread_ts` threads. A single WebChat session can spawn child agents. The chat-id alone cannot represent "this thread in this channel".
- **Archive vs reopen**: archived sessions stay in the store with `archivedAt` set. A naive "find by key, else create" path would happily revive an archived entry when the user actually wanted a clean session.
- **Agent dispatch**: which agent runs this turn? The agent is encoded in the key (`agent:<agentId>:...`), but only after parsing — the channel layer cannot know which agent its inbound event belongs to without consulting the conversation binding config (Chapter 06 §5).
- **Override layering**: per-session model overrides live on the SessionEntry. If session resolution returns just a key without loading the entry, every downstream consumer has to load the store independently, leading to N reads per turn.

## 5. OpenClaw's approach

OpenClaw's approach is a four-step pipeline: (1) classify the session-key shape, (2) compute a canonical composite key, (3) load the freshest matching SessionEntry from the agent-scoped store, and (4) layer overrides from session, agent, and global config.

**(1) Classification.** `classifySessionKind` (`src/sessions/classify-session-kind.ts:16-39`) takes a key plus an optional entry and returns one of `"cron" | "direct" | "group" | "global" | "spawn-child" | "unknown"`. Evaluation order matters — more-specific signals win first:

```ts
if (key === "global") return "global";
if (key === "unknown") return "unknown";
if (isCronSessionKey(key)) return "cron";
if (entry?.spawnedBy) return "spawn-child";
if (entry?.chatType === "group" || entry?.chatType === "channel") return "group";
if (key.includes(":group:") || key.includes(":channel:")) return "group";
return "direct";
```

For our WebChat "hello" the key is `agent:default:webchat:direct:<uuid>`, no `:group:`/`:channel:` substring, no `cron:` prefix, no `spawnedBy` on the entry, so the kind is `"direct"`.

**(2) Composite key.** The canonical session key shape is `agent:<agentId>:<channel>:<chatType>:<chatId>[:thread:<threadId>]`. `parseAgentSessionKey` (`src/sessions/session-key-utils.ts:70-90`) splits it; `normalizeSessionKeyPreservingOpaquePeerIds` (`src/sessions/session-key-utils.ts:42-63`) lowercases all parts except provider-opaque peer ids (e.g., Signal group base64 ids preserve case). `parseThreadSessionSuffix` (`src/sessions/session-key-utils.ts:141-160`) splits off the `:thread:<id>` suffix when present so the parent session can be located by stripping it. Thread sessions inherit overrides from their parent via `resolveThreadParentSessionKey` (`src/sessions/session-key-utils.ts:193-205`).

**(3) Store load.** `resolveSessionStoreLookup` (`src/auto-reply/reply/dispatch-from-config.ts:292-322`) is concise:

```ts
const resolveSessionStoreLookup = (ctx, cfg) => {
  const targetSessionKey = resolveCommandTurnTargetSessionKey(ctx);
  const sessionKey = normalizeOptionalString(targetSessionKey ?? ctx.SessionKey);
  if (!sessionKey) return {};
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath);
    return {
      sessionKey, storePath, store,
      entry: resolveSessionStoreEntry({ store, sessionKey }).existing,
    };
  } catch { return { sessionKey, storePath }; }
};
```

`resolveSessionAgentId` (`src/agents/agent-scope.ts:299-304`) parses the agent id out of the key, falling back to the default agent id from config if the key is not in agent-prefixed form. `resolveStorePath` derives the disk path for that agent's session store (one JSON file per agent). `loadSessionStore` reads and caches it. `resolveSessionStoreEntry` resolves aliases case-insensitively.

When the lookup succeeds, `ctx`-derived `sessionKey` aligns with the store's canonical key, and `entry` is the persisted SessionEntry. For an existing WebChat conversation this returns the entry with the current `model`, `modelProvider`, `verboseLevel`, etc. For a brand-new "hello" turn from a brand-new WebChat session, the gateway's earlier `loadSessionEntry` call already created or upserted the entry, so `entry` is non-null here.

When the key resolves ambiguously (multiple aliases match), `resolveSessionIdMatchSelection` (`src/sessions/session-id-resolution.ts:96-126`) picks the freshest entry by `updatedAt`, preferring the canonical form when timestamps tie. This is what guarantees that an archived alias never wins over an active session.

**(4) Override layering.** Once the entry is in memory, the agent and model for this turn are decided. The runtime reads `entry.modelOverride`/`entry.providerOverride` first (set via `applyModelOverrideToSessionEntry` at `src/sessions/model-overrides.ts:23-110`), then falls back to the agent's configured model, then to the global default model. `applyVerboseOverride` and `applyTraceOverride` (`src/sessions/level-overrides.ts:30-58`) layer the diagnostic levels the same way. Send-policy enforcement is independent: `resolveSendPolicy` (`src/sessions/send-policy.ts:74-152`) evaluates `entry.sendPolicy` first, then the global `cfg.session.sendPolicy.rules`, returning `"allow"` or `"deny"`. For our WebChat turn the per-session policy is absent, the global default is `"allow"`, and the run proceeds. For Slack, where the default may be `"deny"` for `#random`, this is where filtering happens.

The chosen agent and model are not written back to the entry yet — the pipeline only locks the model when the LLM call starts (step 13). Up to that point, the model can still be changed by a `before_dispatch` plugin or a `/model` slash command earlier in the same turn.

## 6. Code locations

- `src/sessions/session-id-resolution.ts:30-126` — alias collapsing and freshest-entry selection (`resolveSessionIdMatchSelection`).
- `src/sessions/session-id.ts:1-6` — UUID regex `SESSION_ID_RE` and `looksLikeSessionId` predicate used when the client passes a bare session id.
- `src/sessions/session-key-utils.ts:42-205` — key normalization, parsing, cron/subagent/ACP/thread predicates.
- `src/sessions/classify-session-kind.ts:16-39` — the `SessionKind` decision tree.
- `src/sessions/send-policy.ts:74-152` — `resolveSendPolicy` returning `"allow" | "deny"` from entry override, then config rules.
- `src/sessions/level-overrides.ts:11-58` — `parseVerboseOverride`/`applyVerboseOverride`, `parseTraceOverride`/`applyTraceOverride`.
- `src/sessions/model-overrides.ts:23-110` — `applyModelOverrideToSessionEntry`, the canonical mutator for per-session model selection.
- `src/auto-reply/reply/dispatch-from-config.ts:292-322` — `resolveSessionStoreLookup`, the call site that ties classification + parsing + loading together.
- `src/auto-reply/reply/dispatch-from-config.ts:852-860` — the orchestrator's first session-resolution lines.
- `src/agents/agent-scope.ts:280-304` — `resolveSessionAgentIds`/`resolveSessionAgentId` that decide which agent owns the key.
- `src/gateway/session-utils.ts:764-802` — gateway-side `loadSessionEntry` and `resolveFreshestSessionStoreMatchFromStoreKeys` used both at request validation and during dispatch.

## 7. Branches and extensions

- [Chapter 06 §3 — Session id resolution and store layout](./06-sessions.md) describes the on-disk schema, the per-agent store partitioning, and the `updatedAt`-based freshness rule.
- [Chapter 06 §7 — Per-session overrides (model, verbose, trace, send-policy)](./06-sessions.md) walks through how overrides are applied at the start of a turn and committed back at the end.
- [Chapter 07 §3 — Agent runtime resolution](./07-agent-execution.md) is the next stop: how the resolved agent id and model selection feed into `runAgentCommand` and the embedded-Pi runtime.
- Cron sessions: keys of the form `agent:<id>:cron:<job>:run:<runId>` route through the cron scheduler (Chapter 02a) rather than user channels; classification short-circuits at the cron predicate.
- Subagent sessions: keys containing `:subagent:` carry a depth count via `getSubagentDepth` (`src/sessions/session-key-utils.ts:120-126`) — depth gating prevents infinite recursion.
- ACP-bound sessions: when a conversation is bound to an ACP (Agent Client Protocol) child, `resolveBoundAcpDispatchSessionKey` (`src/auto-reply/reply/dispatch-from-config.ts:324-345`) returns a different key for dispatch routing while the orchestrator still operates on the user-facing key. The two keys diverge to keep ACP routing source-key owned while user-visible session state stays on the canonical key.
- Spawn-child sessions: when an agent invokes the `spawn` tool to start a child, the child SessionEntry carries `spawnedBy`, which makes `classifySessionKind` return `"spawn-child"` regardless of the key shape. This is why `entry?.spawnedBy` is checked *before* key-shape substrings.
- Thread sessions: a Telegram topic or Slack thread is a separate session with a `:thread:<id>` suffix. Override resolution walks up to the parent session via `resolveThreadParentSessionKey` so a per-base-session model selection is inherited by all thread children.

## 8. What you should now have in your head

1. Session resolution is **classification + composite key + override layering**, not a chat-id lookup. The chat-id is one component of the key, not the key itself.
2. Per-agent stores are loaded from one JSON file each (path derived by `resolveStorePath`). Casing-stable canonical keys keep the store from accumulating alias duplicates; aliased reads are tolerated via `resolveSessionStoreEntry`.
3. Freshness wins over canonicality on ties. Two entries that normalize to the same key collapse to the most recently updated one. Archived entries lose to active ones, so reopening produces a fresh session.
4. The agent id is encoded in the canonical session key. `resolveSessionAgentId` parses it out (defaulting to the configured default agent) and is what determines which agent runs this turn.
5. Overrides layer in a fixed order: session > agent > global. The chosen model is held in memory until the LLM call commits to it; until then, plugins or slash commands can still change it.
