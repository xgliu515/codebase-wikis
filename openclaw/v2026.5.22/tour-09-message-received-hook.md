# Tour Step 09: The `message_received` hook fires

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

`dispatchReplyFromConfig` in `src/auto-reply/reply/dispatch-from-config.ts` has just walked through a chain of checks. The inbound dedupe key was claimed (`inboundDedupeClaim.status === "claimed"`), so this is a genuinely new "hello" — not a redelivery. No plugin-owned conversation binding exists for this WebChat session, so the `pluginOwnedBinding` block was skipped. The `SessionEntry` is loaded into `sessionEntry`, the session key like `agent:default:webchat:<connId>` is bound to `sessionKey`, the chosen agent id is `sessionAgentId`. Everything routing-related is decided.

What is *not* yet decided: whether the message should reach the agent at all. The host is now obligated to give third-party code a chance to look at "hello" before any model call is made. That is the contract of the `message_received` hook.

Concretely, control is at `src/auto-reply/reply/dispatch-from-config.ts:1407`. The dispatcher (the `ReplyDispatcher` from the previous step) has been constructed but holds no work. No agent has been spawned. `ctx` is the canonical `MsgContext`, `hookContext` is the matching `CanonicalInboundMessageHookContext` (`src/hooks/message-hook-mappers.ts`).

## 2. The problem

Third-party plugins live alongside OpenClaw. Some are bundled, some are user-installed, some are workspace-local. They want to do at least three different things with each inbound message:

- **Observe.** Write the message to an analytics sink, increment a counter, log to Sentry, mirror to a Slack monitoring channel.
- **Augment.** Attach an enriched body (e.g. a media transcript), add metadata that downstream hooks can consume.
- **Short-circuit.** Decline the message and prevent any agent run — for example, a "do not disturb" plugin that drops messages outside business hours, or a binding plugin that owns the conversation entirely.

These behaviours must coexist in the same process without:

- one slow plugin blocking the inbound pipeline for tens of seconds;
- one buggy plugin's `throw` taking down every other plugin;
- the order of plugin registration silently controlling which one "wins" when their outputs disagree;
- a plugin being able to read or write data it should not see.

The host owns the process; the plugins are guests. The hook layer is the membrane.

## 3. Naive approach

Keep a module-level array of callbacks. When a message arrives, walk the array synchronously, `await` each one, and continue.

```ts
const onMessageReceived: ((evt: MsgEvent) => Promise<void>)[] = [];

export function registerOnMessageReceived(cb: ...) { onMessageReceived.push(cb); }

export async function dispatchInbound(evt: MsgEvent) {
  for (const cb of onMessageReceived) {
    await cb(evt);
  }
  await runAgent(evt);
}
```

This is the shape every "event emitter" library suggests at first. It is also what most early codebases ship before the failures below catch them.

## 4. Why the naive approach breaks

- **Head-of-line blocking.** One plugin that issues a slow HTTP call to its own backend will block "hello" for the duration of that call. The user types `hello`, sees nothing for 8 seconds, then sees the response. The plugin author has accidentally serialised a slow side effect onto the critical path.
- **One throw kills the chain.** If the second callback throws, the third never runs. The host has no way to know which callback was responsible, no way to disable it, and the operator sees nothing actionable in the logs.
- **Bundle-splitting silently breaks registration.** When the entry point is bundled and the registration array lives in one chunk but `dispatchInbound` runs from another chunk, each chunk gets its own copy of the array. Plugins registered against the "wrong" copy are silently never invoked.
- **No priorities, no ordering contract.** A `do-not-disturb` plugin and an analytics plugin both want to receive the event, but only DND should be able to short-circuit. The registration array gives them the same power and the same position. Behaviour depends on which plugin's module was imported first — an accident of the bundle graph.
- **Type-erased context.** The naive callback signature is `(evt: any) => Promise<void>`. Plugins reach into private fields, host refactors break plugins, plugins start to reach into the database the host happens to keep open. The membrane has holes.
- **No timeout, no concurrency cap.** An unbounded `Promise.all` over plugin callbacks lets a poorly-written plugin fan out to a few hundred outbound requests. The host has no defence.

## 5. OpenClaw's approach

OpenClaw's approach is to split the hook surface into **two parallel registries with different concurrency contracts**, route the inbound `MessageReceivedHookEvent` through both, and apply per-hook timeouts and per-hook error isolation so that one plugin's slow or buggy handler cannot stall the dispatch pipeline.

The two registries:

1. **The plugin hook runner.** A `PluginHookRunner` instance, retrieved via `getGlobalHookRunner()`, holds a typed registry built from each loaded plugin's `hooks` export. Hook names are taken from the closed `PluginHookName` union at `src/plugins/hook-types.ts:51-106`. Handlers carry priority and per-plugin id, and are invoked through one of three execution policies in `src/plugins/hooks.ts:557-639`:
   - `runVoidHook` — parallel `Promise.all`, per-hook timeout, errors caught per handler. Used by `message_received` and other observation hooks.
   - `runClaimingHook` — sequential, first `{ handled: true }` wins. Used by `inbound_claim`, `before_dispatch`, `reply_dispatch`.
   - `runModifyingHook` — sequential, merge results, can short-circuit. Used by `message_sending`.

2. **The internal hook bus.** A simpler `Map<string, InternalHookHandler[]>` keyed on event type and `${type}:${action}`, held under `Symbol.for("openclaw.internalHookHandlers")` so that bundle splitting cannot fork it. Lives in `src/hooks/internal-hooks.ts:189-198`. This is the surface that workspace-discovered `HOOK.md` modules attach to.

For "hello" the dispatcher does both, in this order, both fire-and-forget:

```ts
// src/auto-reply/reply/dispatch-from-config.ts:1407-1429
if (hookRunner?.hasHooks("message_received")) {
  fireAndForgetHook(
    hookRunner.runMessageReceived(
      toPluginMessageReceivedEvent(hookContext),
      toPluginMessageContext(hookContext),
    ),
    "dispatch-from-config: message_received plugin hook failed",
  );
}

if (sessionKey) {
  fireAndForgetHook(
    triggerInternalHook(
      createInternalHookEvent("message", "received", sessionKey, {
        ...toInternalMessageReceivedContext(hookContext),
        timestamp,
      }),
    ),
    "dispatch-from-config: message_received internal hook failed",
  );
}

markProcessing();
```

Three details to notice.

First, `hasHooks("message_received")` is a fast path. With no plugins registering against the hook, `getHooksForName` returns an empty array and the runner returns immediately without even allocating a promise (`src/plugins/hooks.ts:557-587`). For "hello" with no relevant plugins active, this branch costs a Map lookup.

Second, `fireAndForgetHook` (`src/hooks/fire-and-forget.ts:67-75`) attaches `.catch` only — the dispatcher does **not** await the hook. If a plugin handler hangs forever, the inbound dispatch proceeds. The hook runner internally enforces a per-handler timeout via `withHookTimeout` (`src/plugins/hooks.ts:575-580`); on expiry the handler's promise rejects, the `try/catch` in `runVoidHook` captures it, `handleHookError` records it, and the rest of the handlers continue.

Third, the two events are different shapes. The plugin event (`PluginHookMessageReceivedEvent`) is built by `toPluginMessageReceivedEvent` at `src/hooks/message-hook-mappers.ts:360-391` and includes `from`, `content`, `senderId`, `runId`, plus a flat `metadata` blob. The internal event (`MessageReceivedHookContext`) is built by `toInternalMessageReceivedContext` at `src/hooks/message-hook-mappers.ts:409-434` and exposes `channelId`, `accountId`, `conversationId`, `messageId` more prominently because workspace `HOOK.md` modules tend to want to dispatch by channel and chat.

The `triggerInternalHook` implementation in `src/hooks/internal-hooks.ts:286-306` is the canonical fan-out:

```ts
export async function triggerInternalHook(event: InternalHookEvent): Promise<void> {
  if (!internalHooksEnabledState.enabled) return;
  if (!hasInternalHookListeners(event.type, event.action)) return;

  const typeHandlers = handlers.get(event.type) ?? [];
  const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];
  const allHandlers = [...typeHandlers, ...specificHandlers];

  for (const handler of allHandlers) {
    try {
      await handler(event);
    } catch (err) {
      log.error(`Hook error [${event.type}:${event.action}]: ${message}`);
    }
  }
}
```

For our "hello" trace, `handlers.get("message")` and `handlers.get("message:received")` are both empty arrays (no `HOOK.md` listener was wired up in the workspace; bundled hooks like the Gmail watcher subscribe to different events). The function returns at line 290 without invoking anything. The plugin runner's `hasHooks("message_received")` likewise returns `false`, and the entire hook block is skipped.

Immediately after, `markProcessing()` runs (`src/auto-reply/reply/dispatch-from-config.ts:1431`) and the dispatcher proceeds to abort-runtime resolution and finally to the agent reply pipeline. The hook layer was a true pass-through for this turn.

## 6. Code locations

- `src/hooks/internal-hooks.ts:54-77` — `MessageReceivedHookContext` and `MessageReceivedHookEvent` shape definitions.
- `src/hooks/internal-hooks.ts:189-198` — global singleton-backed handler `Map` and enabled flag (the bundle-splitting fix).
- `src/hooks/internal-hooks.ts:220-225` — `registerInternalHook`.
- `src/hooks/internal-hooks.ts:268-272` — `hasInternalHookListeners` (the fast-skip used inside `triggerInternalHook`).
- `src/hooks/internal-hooks.ts:286-306` — `triggerInternalHook`, the canonical sequential fan-out with per-handler `try/catch`.
- `src/hooks/internal-hooks.ts:316-330` — `createInternalHookEvent`.
- `src/hooks/internal-hooks.ts:385-396` — `isMessageReceivedEvent` discriminator used by listeners.
- `src/hooks/internal-hook-types.ts` — the `InternalHookEvent` envelope.
- `src/hooks/message-hook-mappers.ts:221-246` — `toPluginMessageContext`, the canonical → plugin-context mapper.
- `src/hooks/message-hook-mappers.ts:360-391` — `toPluginMessageReceivedEvent`, plugin event shape.
- `src/hooks/message-hook-mappers.ts:409-434` — `toInternalMessageReceivedContext`, internal-hook event shape.
- `src/plugins/hook-types.ts:84,124` — `"message_received"` declared in both the `PluginHookName` union and the `PLUGIN_HOOK_NAMES` runtime list (the type/value parity is enforced by an assertion at lines 148-151).
- `src/plugins/hook-types.ts:977-980` — handler signature for `message_received`.
- `src/plugins/hooks.ts:557-587` — `runVoidHook`, the parallel-with-timeout policy used here.
- `src/plugins/hooks.ts:1008-1017` — `runMessageReceived`.
- `src/plugins/hooks.ts:1489` — `hasHooks`, the empty-array fast path.
- `src/plugins/plugin-hooks.ts:21-101` — `resolvePluginHookDirs`, where each plugin's `HOOK.md` directory enters the registry. Manifest activation, security path checks, and memory-slot selection all happen here.
- `src/hooks/fire-and-forget.ts:67-75` — `fireAndForgetHook`, the `.catch`-only pattern the dispatcher uses for `message_received`.
- `src/hooks/fire-and-forget.ts:121-148` — `fireAndForgetBoundedHook`, the queue-bounded variant used elsewhere.
- `src/auto-reply/reply/dispatch-from-config.ts:1407-1429` — the actual fan-out for "hello".
- `src/agents/announce-idempotency.ts:1-13` — separate concern: deduplicating subagent announcements by `(childSessionKey, childRunId)`. Touched here only because announcements are a different kind of fan-out that uses a deduplication key rather than a hook membrane.

## 7. Branches and extensions

If a workspace `HOOK.md` registers against `"message:received"` via the plugin loader (`src/hooks/loader.ts`), `triggerInternalHook` walks that handler at `src/hooks/internal-hooks.ts:298`. If a loaded plugin exports a `message_received` handler in its manifest, `runVoidHook` walks it in parallel. The two paths are independent.

The other side of the membrane is the *claim* hooks. `inbound_claim` (sequential first-wins) runs **before** `message_received` when a `pluginOwnedBinding` is detected and the plugin can declare the message "handled" (see the block at `src/auto-reply/reply/dispatch-from-config.ts:1311-1405`). `before_dispatch` runs later, immediately before the agent is spawned, and also follows the first-wins policy. These are the short-circuit surfaces; `message_received` is the observe-only surface.

The same fan-out pattern is reused for `message_sent` (`src/plugins/hooks.ts:1086-1091`), `session_start`, `session_end`, `gateway_start`, `gateway_stop`, and other lifecycle events. The runner / void-vs-claiming-vs-modifying distinction is the single design vocabulary.

Further reading in the reference chapters:

- [Chapter 10 §8 — Hook dispatch policies and timeouts](./10-plugins.md#8-hook-dispatch-policies-and-timeouts).
- [Chapter 05 §6 — `message_received` and the inbound hook chain](./05-channels-inbound.md#6-message_received-and-the-inbound-hook-chain).
- [Chapter 10 §3 — Manifest, activation, and the `HOOK.md` discovery system](./10-plugins.md#3-manifest-activation-and-the-hookmd-discovery-system).

## 8. What you should now have in your head

- The hook layer is two parallel surfaces: the **plugin hook runner** (typed, per-plugin id, priority, three execution policies — void/claim/modify) and the **internal hook bus** (`Map<string, handlers[]>`, sequential, used for `HOOK.md`-discovered handlers). Both are global singletons keyed by `Symbol.for` so that bundle splitting cannot fork them.
- `message_received` is a **void/parallel** hook. Per-handler timeouts and per-handler error isolation make one slow or buggy plugin a local problem. The dispatcher fires both surfaces fire-and-forget — it does not block on them. The short-circuit semantics live in different hooks (`inbound_claim`, `before_dispatch`).
- For "hello" with no plugins registering anything, the `hasHooks("message_received")` and `hasInternalHookListeners("message", "received")` checks return false and the entire block at `src/auto-reply/reply/dispatch-from-config.ts:1407-1429` is two cheap Map lookups followed by `markProcessing()`.
- The handler context is built by explicit mappers (`toPluginMessageReceivedEvent`, `toInternalMessageReceivedContext`) so the plugin- and internal-hook surfaces can diverge over time without leaking host internals. The mappers are the membrane.
- Naive `for await (cb of cbs) await cb()` would have failed at three different layers — bundle splitting, head-of-line blocking, and exception propagation. Each was a real bug the present design exists to prevent.
