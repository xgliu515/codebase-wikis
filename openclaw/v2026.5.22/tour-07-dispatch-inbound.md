# Tour Step 07: dispatchInboundMessage

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

The chat.send handler in `src/gateway/server-methods/chat.ts` has finished assembling the `MsgContext` (`ctx`) at line 2579-2620, built a `ReplyDispatcher` with delivery callbacks (line 2817-2842), and wrapped a measurement span around the next call. It now invokes the inbound pipeline:

```ts
void measureDiagnosticsTimelineSpan(
  "gateway.chat_send.dispatch_inbound",
  () =>
    dispatchInboundMessage({
      ctx,
      cfg,
      dispatcher,
      replyOptions: {
        runId: clientRunId,
        abortSignal: activeRunAbort.controller.signal,
        images: parsedImages.length > 0 ? parsedImages : undefined,
        ...
      },
    }),
  ...
);
```

(`src/gateway/server-methods/chat.ts:2844-2862`). The call is deliberately `void`-prefixed: the gateway returns to the WebSocket frame loop immediately so the same connection can process aborts and ping frames while the agent runs. The handler keeps a reference to the promise only through the ReplyDispatcher's lifecycle, not through `await`.

`dispatchInboundMessage` is defined at `src/auto-reply/dispatch.ts:246-292`. Its signature takes `ctx`, `cfg`, `dispatcher`, optional `replyOptions`, and optional `replyResolver`. Note what it does *not* take: it does not take a channel discriminator, does not take a session id, does not take an agent id. Everything it needs is derived from `ctx` or `cfg`.

## 2. The problem

Inbound handling for a single user turn has at least six phases that must run in order:

1. Normalize and lock down the inbound context (finalize body/command fields, default-deny authorization).
2. Record diagnostics and provenance so the run can be debugged later.
3. Resolve the session: from `SessionKey`, find the store path, load the entry, fall back to legacy aliases.
4. Run plugin hooks — `message_received`, internal `message_received`, `before_dispatch` — letting plugins observe or short-circuit the turn.
5. Decide whether this turn dispatches to the agent at all (slash command absorbed locally, `before_dispatch` returned `handled`, send-policy denies, ACP child, parent-owned background session, etc.).
6. If dispatching, hand control to the reply resolver, which calls the LLM, streams blocks back through the dispatcher, and eventually settles.

If you write that as one function it crosses 500 lines. If you fragment it into a chain of `nextPhase(ctx)` calls it becomes untraceable: a stack trace from inside the LLM call shows only the last micro-step, not the lifecycle. Worse, each phase has cross-cutting concerns — diagnostics, abort signalling, hook gating, foreground-reply fence ordering — that touch most other phases.

## 3. Naive approach

Write one big sequential `async function dispatchInbound(ctx, cfg, dispatcher)` and inline every phase. Diagnostics get logged as side effects. Hook fan-out happens inline. Session loading happens inline. The reply-resolver call happens inline at the end.

## 4. Why the naive approach breaks

- **Testability**: the only entry point is the whole function. Unit-testing the hook ordering means standing up a session store, a config, a dispatcher, and a fake LLM.
- **Hook insertion**: plugins want to hook *between* phases (`message_received` before resolution, `before_dispatch` after, `message_sending` per reply). Wiring those hooks inline at six different code points means six different mocked-runner branches in tests.
- **Retry semantics**: when a downstream phase fails (LLM error, abort, dedupe replay), the function needs to roll back partial state. Inlined code mixes the "rollback what I did" logic with the forward path; the fence/idempotency invariants become local to one file.
- **Backpressure and abort**: the chat.send caller wants to cancel the run mid-flight. A monolithic function would need to thread an abort signal through every line.
- **The five callers**: `dispatchInboundMessage` has three sibling wrappers (`dispatchInboundMessageWithBufferedDispatcher`, `dispatchInboundMessageWithDispatcher`) and two plugin-SDK callers (`src/plugin-sdk/inbound-reply-dispatch.ts`, `src/plugin-sdk/channel-inbound.ts`). A monolith forces each caller to duplicate the dispatcher-creation prelude.

## 5. OpenClaw's approach

OpenClaw's approach is to make `dispatchInboundMessage` a thin orchestrator that owns three responsibilities only: (a) finalize the context, (b) attach the reply dispatcher to the active scope, and (c) delegate the heavy lifting to `dispatchReplyFromConfig`. Everything else lives in named, phase-specific modules. The full body is short (`src/auto-reply/dispatch.ts:246-292`):

```ts
export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const finalized = measureDiagnosticsTimelineSpanSync(
    "auto_reply.finalize_context",
    () => finalizeInboundContext(params.ctx),
    { phase: "agent-turn", config: params.cfg,
      attributes: buildDispatchTimelineAttributes(params.ctx) },
  );
  if (isDiagnosticsEnabled(params.cfg)) {
    logMessageReceived({
      sessionKey: finalized.SessionKey,
      channel: finalized.Surface ?? finalized.Provider,
      chatId: finalized.To ?? finalized.From,
      messageId: finalized.MessageSid ?? finalized.MessageSidFirst ?? finalized.MessageSidLast,
      source: "dispatchInboundMessage",
    });
  }
  const result = await withReplyDispatcher({
    dispatcher: params.dispatcher,
    run: () => measureDiagnosticsTimelineSpan(
      "auto_reply.dispatch_reply_from_config",
      () => dispatchReplyFromConfig({ ctx: finalized, cfg: params.cfg,
        dispatcher: params.dispatcher, replyOptions: params.replyOptions,
        replyResolver: params.replyResolver }),
      ...,
    ),
  });
  return finalizeDispatchResult(result, params.dispatcher);
}
```

Three things to notice:

**(a) Finalization first.** `finalizeInboundContext` (`src/auto-reply/reply/inbound-context.ts:39-100`) runs synchronously and rewrites `ctx` in place: `Body`/`RawBody`/`CommandBody`/`Transcript` are normalized through `normalizeInboundTextNewlines` and `sanitizeInboundSystemTags`; `BodyForAgent` is filled in from the best available source; `ChatType` is canonicalized via `normalizeChatType`; `ConversationLabel` is resolved if missing; and crucially `CommandAuthorized = ctx.CommandAuthorized === true` (default-deny). After this point the rest of the pipeline sees a `FinalizedMsgContext`, never a raw `MsgContext`.

**(b) Diagnostics gated, not removed.** `logMessageReceived` only runs when `isDiagnosticsEnabled(cfg)`. The `measureDiagnosticsTimelineSpanSync`/`measureDiagnosticsTimelineSpan` wrappers add OpenTelemetry-style spans with the `agent-turn` phase tag and the attributes from `buildDispatchTimelineAttributes` (`src/auto-reply/dispatch.ts:190-203`). When diagnostics are off these wrappers are zero-cost passthroughs.

**(c) Dispatcher scope, not parameter passing.** `withReplyDispatcher` (`src/auto-reply/dispatch-dispatcher.js`) attaches the dispatcher to AsyncLocalStorage for the duration of the inner promise. Code anywhere inside `dispatchReplyFromConfig` — hooks, the reply resolver, even tool handlers — can call `getActiveReplyDispatcher()` instead of receiving the dispatcher as a parameter. This is what lets the orchestrator stay flat while the inner pipeline branches deeply.

For our "hello" turn the orchestrator's work is uneventful:

1. `finalizeInboundContext` reads `ctx.Body === "hello"`, leaves it as-is, copies `BodyForAgent` (already timestamped), defaults `CommandAuthorized` to `true` (which the gateway already set), resolves `CommandTurn` to `{ kind: "normal", source: "message", authorized: false, body: "hello" }`.
2. `logMessageReceived` emits a diagnostic event with `sessionKey`, `channel: "webchat"`, `chatId`, `messageId`.
3. `withReplyDispatcher` installs the dispatcher and invokes `dispatchReplyFromConfig`.

Phases 3-6 from §2 above all happen *inside* `dispatchReplyFromConfig` (`src/auto-reply/reply/dispatch-from-config.ts:744`), which is itself a 1500-line function — but one whose subroutines are individually testable: `resolveSessionStoreLookup` (line 292), `resolveBoundAcpDispatchSessionKey` (line 324), `resolveReplyRoutingDecision`, the inbound-claim plugin hook (line 1328), the `message_received` fan-out (line 1407-1428), the `before_dispatch` hook (line 1581-1616). The orchestrator does not call these directly — they live inside the resolver — but the orchestrator owns the *lifecycle* (`withReplyDispatcher` scope, `finalizeInboundContext`, `finalizeDispatchResult`) so the resolver can stay focused on flow control.

Slash-command parsing deserves a separate note. The MsgContext for our turn carries `CommandTurn.kind === "normal"`, so the slash-command path is never taken. If the user had typed `/help`, the gateway would have run `parseTextSlashCommand` upstream and set `CommandTurn.kind === "text-slash"` with `authorized: true`. Inside `dispatchReplyFromConfig`, `shouldBypassPluginOwnedBindingForCommand` (`src/auto-reply/reply/dispatch-from-config.ts:581-615`) decides whether the command bypasses the normal agent flow entirely. For "hello" we skip past that branch.

## 6. Code locations

- `src/auto-reply/dispatch.ts:246-292` — `dispatchInboundMessage`, the orchestrator body.
- `src/auto-reply/dispatch.ts:294-345` — `dispatchInboundMessageWithBufferedDispatcher`, the variant the chat.send handler actually wraps when buffered typing indicators are needed (it delegates to the same orchestrator).
- `src/auto-reply/dispatch.ts:190-203` — `buildDispatchTimelineAttributes`, the attribute extractor used for diagnostic spans.
- `src/auto-reply/reply/inbound-context.ts:39-100` — `finalizeInboundContext`, the first phase.
- `src/auto-reply/dispatch-dispatcher.ts` — `withReplyDispatcher`, the AsyncLocalStorage scope binder.
- `src/auto-reply/reply/dispatch-from-config.ts:744` — `dispatchReplyFromConfig`, the delegated heavy lifting; subroutines at lines 292, 324, 852, 1407, 1581 cover session lookup, ACP binding, session-store reconciliation, `message_received` hook, and `before_dispatch` hook respectively.
- `src/sessions/input-provenance.ts:47-65` — `applyInputProvenanceToUserMessage`, called downstream when the resolver builds the agent message; reads `ctx.InputProvenance` that was set in step 06.
- `src/hooks/internal-hooks.ts` and `src/plugins/hook-runner-global.ts` — the hook runner that fans `message_received` out to both plugin handlers and the internal HOOK.md system (refs #8807 in dispatch-from-config.ts:1418).
- `src/commands/agent/` — bundled command definitions; `resolveTextCommand` and `matchPluginCommand` decide whether a slash command is absorbed before agent dispatch.
- `src/auto-reply/command-turn-context.ts:161` — `resolveCommandTurnContext`, the single source of truth for whether a turn is a command.

## 7. Branches and extensions

- [Chapter 05 §3 — dispatchInboundMessage and the inbound pipeline](./05-inbound-pipeline.md) maps the full lifecycle and shows where each phase lives.
- [Chapter 06 §3 — Session resolution flow](./06-sessions.md) is the next stop: how `dispatchReplyFromConfig` turns `ctx.SessionKey` into a `SessionEntry` with overrides applied.
- [Chapter 10 §8 — Hook system (message_received, before_dispatch, message_sending)](./10-plugin-system.md) details the fan-out semantics, the `inbound_claim` outcome, and how plugin authors register listeners.
- Buffered-dispatcher variant (`dispatchInboundMessageWithBufferedDispatcher` at `src/auto-reply/dispatch.ts:294`) is what real channel adapters (Slack, Telegram, Matrix) use — it adds typing-indicator lifecycle and the foreground-reply fence (`beginForegroundReplyFence`/`endForegroundReplyFence` at lines 81-118) to prevent stale replies from older turns from overwriting a fresher one.
- Inbound claims: when a plugin's `inbound_claim` hook returns `{ claimed: true }`, the orchestrator's inner phases short-circuit and the dispatcher emits no model traffic. This is how plugin-owned channel bindings divert turns to plugin handlers (`src/auto-reply/reply/dispatch-from-config.ts:1328-1370`).
- Idempotency and dedupe: `inboundDedupeReplayUnsafe` (`src/auto-reply/reply/dispatch-from-config.ts:847`) tracks whether the run can be safely replayed under the same idempotency key — the orchestrator does not need to know about this, but the chat.send handler does, because it derives the WebSocket-level `respond()` ack from the dispatch result.

## 8. What you should now have in your head

1. `dispatchInboundMessage` is intentionally short. Its job is finalization, scope binding, delegation. The 1500 lines of work live in `dispatchReplyFromConfig`, not in the orchestrator.
2. `finalizeInboundContext` always runs at the top, even if the caller already passed a `FinalizedMsgContext`. Defensive normalization is cheap and prevents an entire class of bugs where downstream code reads `Body` and gets an envelope-shaped string the user never typed.
3. The reply dispatcher is bound to an AsyncLocalStorage scope, not threaded as a parameter. This is how hooks deep inside the pipeline can deliver replies without the orchestrator passing them a dispatcher reference.
4. The orchestrator never branches on channel. Everything channel-specific has already been compiled into MsgContext fields before this function is called.
5. For our "hello" run: finalize-context emits one diagnostic span, `logMessageReceived` fires once, `withReplyDispatcher` binds the dispatcher, and control passes to `dispatchReplyFromConfig` where session resolution starts.
