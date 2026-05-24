# Tour Step 06: Building MsgContext

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

After step 05 we are inside the `chat.send` RPC handler at `src/gateway/server-methods/chat.ts:2183`. The handler has already validated parameters with the AJV-compiled schema (`validateChatSendParams`), normalized the inbound text via `sanitizeChatSendMessageInput` (`src/gateway/server-methods/chat.ts:2243-2251`), turned attachments into an empty array because our request carries none (`src/gateway/server-methods/chat.ts:2261`), and trimmed the message body. The user typed `"hello"`, so `rawMessage === "hello"`. We are running on the gateway process, holding the `respond` callback, the `context.logGateway` logger, and the authenticated `client` descriptor that tells us this client is connected over WebSocket with no privileged scopes.

What the handler does *not* yet have is anything the inbound pipeline can consume. The pipeline (`dispatchInboundMessage` in `src/auto-reply/dispatch.ts:246`) takes one input shape and one only: a `MsgContext` object defined in `src/auto-reply/templating.ts:42`. Everything from session resolution to agent invocation to reply dispatch reads fields off that object. There is no "WebChat code path" further downstream — once the context is built, the pipeline is channel-agnostic.

## 2. The problem

OpenClaw has more than twenty inbound surfaces: Telegram, Slack, Discord, Matrix, Signal, Email, Feishu, WhatsApp, SMS via Twilio, web push, the gateway-internal WebChat we are walking through right now, and several bot-mode plugins. Each of those surfaces exposes inbound events in its own provider-native shape: Telegram gives you a `Message` with `chat.id` and `from.username`; Slack gives you an `event` with `channel` and `user`; Discord gives you a `Message` with `guildId`/`channelId`; WebChat gives you an RPC payload with `sessionKey` and `idempotencyKey`. The pipeline downstream has to do the same job for all of them: figure out which session, which agent, which model, which authorization, which reply target, and which provenance.

If the rest of the pipeline branches on channel, every new channel multiplies code paths across every downstream module. That breaks the channel-as-plugin promise (see Chapter 04). The pipeline must converge to one shape, and that shape must carry enough information that no downstream consumer ever needs to look back at the raw provider event.

## 3. Naive approach

Pass the raw RPC payload through. Let `dispatchInboundMessage` accept `unknown`. Let session resolution sniff for `params.sessionKey`. Let reply dispatch sniff for `params.client`. Let the agent runtime sniff for `params.message`. This is the path of least resistance when you bolt on the first channel: WebChat is the gateway's own RPC, so the payload is already typed and validated; threading the typed payload directly is one line shorter than building a normalized object.

A close variant is "use a discriminated union": `type InboundEvent = WebChatEvent | TelegramEvent | SlackEvent | ...` with the consumer switching on `event.kind`. This *seems* type-safe but moves the same channel-coupling problem one level up: every downstream consumer still has to handle every variant, and adding a new channel requires editing every consumer to add the new arm.

## 4. Why the naive approach breaks

The shape that works for WebChat is `{ sessionKey, message, idempotencyKey, ... }`. The shape that works for Telegram is an `Update` with `message.chat.id` and `message.from.id`. The shape that works for Slack is `{ event: { type: "message", channel, user, text, ts, thread_ts } }`. To add a second channel under "pass the raw payload through" you either (a) make every downstream module aware of every payload shape, or (b) add an `if (channel === "telegram")` branch in every consumer. Either way, **adding a channel becomes a global refactor**.

There is a subtler failure too. Many fields are conceptually shared but spelled differently: a thread id is `message_thread_id` in Telegram, `thread_ts` in Slack, `topic_id` in Matrix, `MessageThreadId` in OpenClaw's WebChat RPC. Reply-to ids, forwarded-from metadata, sticker descriptors, attachment URLs — all carry the same downstream semantics behind incompatible names. Without normalization, the channel layer leaks into prompt assembly, transcript formatting, hook dispatch, and reply routing. Hooks in particular suffer: a plugin written against the Telegram shape silently breaks on Slack.

A third failure mode is *trust*. Provider payloads mix trusted and untrusted fields freely: the sender id is trusted (the provider attests to it), but the sender's display name is user-controlled. The message text is user-controlled, but the message id is trusted. If the pipeline reads from the raw payload, every downstream consumer must know which fields can be safely interpolated into a system prompt and which must be quoted as untrusted content. MsgContext separates these by name (`UntrustedContext`, `UntrustedStructuredContext`, `SenderId` vs `SenderName`) so the trust boundary is encoded in the shape itself.

## 5. OpenClaw's approach

OpenClaw's approach is to define one canonical inbound shape, `MsgContext`, and require every channel adapter to build it before handing control to the pipeline. The type is declared at `src/auto-reply/templating.ts:42-279` and is consumed by `dispatchInboundMessage` (`src/auto-reply/dispatch.ts:246-292`). It covers six families of fields, all optional so each channel populates only what makes sense:

- **Origin**: `Provider`, `Surface`, `AccountId`, `OriginatingChannel`, `OriginatingTo`, `ExplicitDeliverRoute` — who the message came from and where replies should go back.
- **Identity**: `From`, `To`, `SenderId`, `SenderName`, `SenderUsername`, `SenderE164`, `SessionKey`, `MessageSid`, `MessageThreadId`.
- **Content (multi-view)**: `Body` (raw, for UI), `BodyForAgent` (prompt-ready, may be timestamped), `BodyForCommands` (clean, for slash-command detection), `CommandBody` (legacy alias), `RawBody` (legacy alias). The pipeline always reads `BodyForAgent`/`BodyForCommands` — never the raw provider text.
- **Attachments and media**: `MediaPath`, `MediaPaths`, `MediaType`, `MediaTypes`, `MediaWorkspaceDir`, `MediaStaged` (the marker that staging already ran and the dispatcher should not re-stage).
- **Provenance**: `InputProvenance` (kind: `external_user` | `inter_session` | `internal_system`, with `sourceChannel`/`sourceTool`), `GatewayClientScopes` — see `src/sessions/input-provenance.ts:12-18`.
- **Command intent**: `CommandTurn`, `CommandAuthorized`, `CommandSource`, `CommandArgs`, `CommandTargetSessionKey`. For "hello" the command turn is `{ kind: "normal", source: "message", authorized: false }`.

The chat.send handler constructs the context inline at `src/gateway/server-methods/chat.ts:2579-2620`:

```ts
const ctx: MsgContext = {
  Body: messageForAgent,
  BodyForAgent: stampedMessage,
  BodyForCommands: commandBody,
  RawBody: parsedMessage,
  CommandBody: commandBody,
  InputProvenance: systemInputProvenance,
  SessionKey: sessionKey,
  Provider: INTERNAL_MESSAGE_CHANNEL,
  Surface: INTERNAL_MESSAGE_CHANNEL,
  OriginatingChannel: originatingChannel,
  OriginatingTo: originatingTo,
  ExplicitDeliverRoute: explicitDeliverRoute,
  AccountId: accountId,
  MessageThreadId: messageThreadId,
  ChatType: "direct",
  ...(commandSource ? { CommandSource: commandSource } : {}),
  CommandAuthorized: true,
  CommandTurn: commandSource
    ? { kind: "text-slash", source: commandSource, authorized: true, body: commandBody }
    : { kind: "normal", source: "message", authorized: false, body: commandBody },
  MessageSid: clientRunId,
  ...(!isOperatorUiClient(clientInfo) ? { SenderId: clientInfo?.id, ... } : {}),
  GatewayClientScopes: client?.connect?.scopes ?? [],
  ...pluginBoundMediaFields,
};
```

For our request:

- `Body === "hello"` and `BodyForAgent` is `"hello"` with an injected timestamp prefix (see `injectTimestamp` at `src/gateway/server-methods/chat.ts:2577`). `BodyForCommands === "hello"`.
- `Provider === Surface === INTERNAL_MESSAGE_CHANNEL`, which resolves to the literal `"webchat"` (`src/utils/message-channel-constants.ts:1`). This is how the rest of the pipeline knows the inbound surface without reading the raw RPC payload.
- `InputProvenance` is `undefined` because the WebChat client did not pass `systemInputProvenance` — the client lacks admin scope, and admin gating at `src/gateway/server-methods/chat.ts:2227-2242` would have rejected any attempt to inject one. For an end-user WebChat message, provenance is implicit (`external_user`); only inter-session and system-injected messages carry an explicit `InputProvenance` object.
- `SessionKey` is the canonical key returned from `loadSessionEntry(rawSessionKey)` at `src/gateway/server-methods/chat.ts:2272-2289`. The raw key from the client (e.g. `agent:default:webchat:direct:abc123`) is normalized to its lowercase canonical form before this assignment so downstream lookups are case-stable.
- `MessageSid === clientRunId`, a per-call UUID the gateway mints. Downstream uses this as the `runId` for abort signalling and tool-event routing.
- `GatewayClientScopes` is the scope set negotiated during connection auth (step 03). For an unprivileged WebChat connection this is typically `[]`.
- `CommandAuthorized: true` and `CommandTurn.kind: "normal"` because `"hello"` is not a slash command and the gateway-initiated turn is trusted to dispatch.

Attachments are empty for our case, so the `mediaPathOffloadPaths.length > 0` branch at `src/gateway/server-methods/chat.ts:2621-2633` does not run and `ctx.MediaPath`/`ctx.MediaPaths`/`ctx.MediaStaged` stay unset.

Note the duality between `Body` and `BodyForAgent`. The UI eventually replays transcripts to the user; transcript rendering reads `Body` so the human sees their literal text. The agent prompt, on the other hand, benefits from a timestamp — turn-by-turn temporal grounding matters for reasoning — so `injectTimestamp` produces `"[2026-05-24 …] hello"` and writes it to `BodyForAgent`. Slash-command detection (later in step 09) reads `BodyForCommands`, which is the cleanest of the three: no timestamp, no envelope decoration, just the raw command text. Sloppy channel adapters sometimes forget to set `BodyForAgent` or `BodyForCommands`; `finalizeInboundContext` (next step) backfills both from `CommandBody`/`RawBody`/`Body` so the dispatch path always has all three populated.

After this block the context is complete. The handler will hand it to `dispatchInboundMessage` in step 07 with no further channel-specific transformation. The `clientInfo`/`isOperatorUiClient` ternary in the field block deserves one more note: for an authenticated end-user connection, sender fields are stamped from the WebSocket connect handshake (`client.connect`), so the agent sees who is talking. For the operator UI client (gateway admin) the sender fields are omitted, because operator-UI traffic represents the gateway itself talking to its own agents, not a third-party user — leaving sender fields blank lets downstream code treat the turn as system-internal.

## 6. Code locations

- `src/auto-reply/templating.ts:42-279` — `MsgContext` type definition, every field documented.
- `src/auto-reply/templating.ts:281-292` — `FinalizedMsgContext`, the post-finalization variant that promises `CommandAuthorized` is always a boolean.
- `src/gateway/server-methods/chat.ts:2579-2620` — WebChat's MsgContext construction call site (the focus of this step).
- `src/gateway/server-methods/chat.ts:2272-2289` — `loadSessionEntry(rawSessionKey)` that produces the canonical `sessionKey` written into the context.
- `src/utils/message-channel-constants.ts:1` — `INTERNAL_MESSAGE_CHANNEL = "webchat"`, the surface identifier.
- `src/sessions/input-provenance.ts:12-18` — `InputProvenance` shape; `src/sessions/input-provenance.ts:30-45` — `normalizeInputProvenance` used at `src/gateway/server-methods/chat.ts:2258` to validate any caller-supplied provenance.
- `src/auto-reply/reply/inbound-context.ts:39-100` — `finalizeInboundContext`, the entry point that step 07 calls to lock down `Body`, `BodyForAgent`, `BodyForCommands`, `ChatType`, `ConversationLabel`, and `CommandAuthorized`.
- `src/channels/chat-meta.ts:1-15` and `src/channels/chat-meta-shared.ts:36-55` — the registry of channel metadata that `Provider`/`Surface` strings are eventually matched against; not consulted at MsgContext build time but needed when later steps display a human label for the surface.
- `src/channels/chat-type.ts` — `normalizeChatType`, called by `finalizeInboundContext` to canonicalize `ChatType` to `direct` | `group` | `channel`.

## 7. Branches and extensions

The MsgContext shape is the convergence point for every other inbound channel. The reference chapters cover the surrounding machinery:

- [Chapter 05 §2 — Building MsgContext from channel events](./05-inbound-pipeline.md) walks through how Telegram, Slack, Matrix, and Discord adapters populate the same shape from very different provider payloads, and why `BodyForAgent` vs `BodyForCommands` exists.
- [Chapter 04 §3 — Inbound event types and message shapes](./04-channel-layer.md) describes the channel layer's `InboundEvent` discriminated union and how it maps onto MsgContext fields.
- [Chapter 06 §3 — Session id resolution from channel context](./06-sessions.md) is the next stop: how the `SessionKey` written here is later parsed and used to locate per-session overrides.
- Inter-session messages: when one OpenClaw session writes a message to another via a tool, `InputProvenance.kind === "inter_session"` and the prompt is prefixed by `buildInterSessionPromptPrefix` (`src/sessions/input-provenance.ts:80-95`) so the receiving agent does not treat the content as a direct user instruction.
- Plugins that inject MsgContext directly use `src/plugin-sdk/inbound-reply-dispatch.ts` and `src/plugin-sdk/channel-inbound.ts`, going through the same `dispatchInboundMessage` entry point.
- The `OriginatingChannel`/`OriginatingTo`/`ExplicitDeliverRoute` triple supports cross-channel replies: a turn received on Telegram can be replied to on Slack when the user has bound their sessions across channels. For our WebChat run these fields are unset, so replies route back to the same WebSocket connection.
- Media-bearing turns: when attachments are non-empty, the WebChat handler pre-stages them and sets `MediaStaged: true` to prevent re-staging downstream — covered in Chapter 13.
- WebChat's RPC-shaped origin is special-cased only in one place: `dispatchReplyFromConfig` (`src/auto-reply/reply/dispatch-from-config.ts:999-1002`) treats `surface === "webchat"` with `ExplicitDeliverRoute !== true` as `isInternalWebchatTurn` to suppress the cross-channel reply-routing detection. Every other downstream consumer is fully channel-agnostic.

## 8. What you should now have in your head

1. The pipeline downstream of `dispatchInboundMessage` reads MsgContext fields exclusively. The raw RPC payload, the WebSocket frame, the channel-specific event — none of those exist past this point.
2. MsgContext is a flat, optional-field bag, not a class. Each channel populates only what applies. There is no `WebChatContext extends MsgContext` — convergence is by *shape*, not by inheritance.
3. For our "hello" trace: `Provider === Surface === "webchat"`, `ChatType === "direct"`, `Body === BodyForAgent === BodyForCommands === "hello"` (modulo timestamp injection), `CommandAuthorized === true`, `CommandTurn.kind === "normal"`, `InputProvenance === undefined`, attachments and media unset.
4. The `SessionKey` written into MsgContext is already canonical (lowercased, alias-collapsed) — step 08 will not need to re-normalize it, only parse it.
5. `finalizeInboundContext` is the second pass that runs at the start of `dispatchInboundMessage`. It is what guarantees that any downstream consumer sees `BodyForAgent` and `BodyForCommands` populated even if a sloppy channel adapter forgot to set them.
