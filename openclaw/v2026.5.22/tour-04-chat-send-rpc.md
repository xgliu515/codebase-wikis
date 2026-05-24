# Tour Step 04: Client sends chat.send

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

At the end of tour-03 the WebSocket is open and the gateway has one `GatewayWsClient` in its `clients` set. The browser side holds a corresponding `client` object — the WebChat module's gateway client — whose `request(method, params)` shape we saw at `src/gateway/client.ts:1202`. The user is staring at an empty chat panel. The input box is focused. The browser tab is sitting idle, holding `state.sessionKey`, `state.client`, `state.connected = true`, and an empty `state.chatMessages` array (`ui/src/ui/controllers/chat.ts`).

What changes now is one user gesture: they type `hello` and hit Enter. The DOM input event fires, the view layer calls `onSend`, and the controller's `sendChatMessage` takes over.

## 2. The problem

A real chat client must do three things at once: feel instant, recover from a flaky network, and never let the same user input post twice.

> The UI must (a) optimistically render the user's message before any server acknowledgement, (b) survive a transport disconnect mid-send and keep the message in-flight, and (c) tolerate reconnects and retries without producing a duplicate `chat.send` on the server side.

These pull in different directions. Instant render says "stop waiting for the server". Survive-disconnect says "queue everything that left the input box". No-double-send says "the server must be able to recognize the same message-attempt twice and accept it only once".

## 3. Naive approach

`fetch('/chat/send', {method:'POST', body:{text:'hello'}})`. Wait for the JSON response. When it arrives, render the assistant reply. One HTTP request per message. Simple, stateless, debuggable.

## 4. Why the naive approach breaks

POST-per-message is wrong for three different reasons, each fatal in its own way:

- **Streaming responses are not a request/response shape.** The assistant reply is dozens of token-delta events plus tool-event lifecycle markers plus a final aggregate. A single POST cannot stream them naturally without falling back to SSE or chunked-transfer hacks, and both require a second long-lived connection anyway — defeating the original simplicity.
- **Reconnect storms create lost typing indicators and ghost messages.** During a 5-second connectivity blip, a POST that left the browser before the disconnect either succeeded (and the response is lost) or never arrived. The UI cannot tell which. The user sees their message bubble vanish, or sees the assistant typing forever. Worse, if the UI retries, the server may now see two `hello`s arrive 5 seconds apart and answer both.
- **No natural place for typing/stream events to arrive.** Token deltas are server-pushed. Without a live socket they need a parallel SSE channel, with its own auth, reconnect, ordering. Now you have two transports for one logical conversation. State drift between them becomes the new bug class.

The naive approach also misses a subtle but important fourth issue: **the user message must render before the server replies**. With request/response, the bubble naturally pops in after the network round-trip. That feels laggy on a slow link. Real chat clients render the user bubble synchronously and reconcile after.

## 5. OpenClaw's approach

OpenClaw's approach is to **send `chat.send` as an RPC frame on the already-open WebSocket, carry a client-generated `idempotencyKey` for server-side dedup, and decouple the user-bubble rendering from the round-trip entirely**. Concretely:

When the user hits send, `sendChatMessage` in `ui/src/ui/controllers/chat.ts:483` runs. Before any network call it: trims the message, checks `state.connected`, returns null if the input is empty, and bails early if `state.chatSending` is already true (so spamming Enter cannot double-fire). Then it does the optimistic part:

```ts
state.chatMessages = [
  ...state.chatMessages,
  { role: "user", content: contentBlocks, timestamp: now },
];
state.chatSending = true;
const runId = generateUUID();
state.chatRunId = runId;
state.chatStream = "";
```

The user's bubble is already in `chatMessages`. The view re-renders. The user sees their message immediately — no waiting on the server. The `runId` is a UUIDv4 minted **client-side** at `controllers/chat.ts:563`, and it serves two distinct roles: it identifies the in-flight "run" so the controller can match later stream events back to this exact send (`handleChatEvent`, `controllers/chat.ts:661`), and it doubles as the server-side dedup key.

Now the actual RPC. `requestChatSend` (`controllers/chat.ts:416`) builds the params and ships them:

```ts
await state.client!.request("chat.send", {
  sessionKey: state.sessionKey,
  ...(sessionId ? { sessionId } : {}),
  message: params.message,
  deliver: false,
  idempotencyKey: params.runId,
  attachments: buildApiAttachments(params.attachments),
});
```

`state.client.request` is the gateway client's per-request promise wrapper (`src/gateway/client.ts:1202`). It mints a fresh frame id (also a UUID), validates the frame against `RequestFrameSchema` (`src/gateway/protocol/schema/frames.ts:138`), registers a pending entry keyed by that id, and writes `JSON.stringify(frame)` to the open socket. The wire frame is exactly:

```json
{"type":"req","id":"<uuid>","method":"chat.send",
 "params":{"sessionKey":"...","message":"hello",
           "deliver":false,"idempotencyKey":"<runId>"}}
```

The `idempotencyKey` shape is enforced by `ChatSendParamsSchema` at `src/gateway/protocol/schema/logs-chat.ts:51` — it is `NonEmptyString` and required. If a reconnect or transient error causes the UI to retry the same `runId`, the server can recognize it and refuse to spawn a second agent run. That is the no-double-send guarantee.

The `deliver: false` flag matters too — it tells the server not to round-trip the message back out through delivery channels (Slack, Discord, etc.) for this WebChat-originated message. WebChat itself is the surface; broadcasting would loop.

Control returns to the caller as soon as `ws.send` succeeds. The `request(...)` promise stays pending in `this.pending`, awaiting the server's `res` frame for this `id`. Token deltas arriving as separate `event` frames are matched to the run via the `runId` carried in their payload, not the request id. That separation — `id` for the RPC envelope, `runId` for the multi-event run — is what lets one logical "send a message" produce one ack plus N stream events without confusing the client.

If `request(...)` rejects (timeout, socket close, server error), the controller's `catch` block at `controllers/chat.ts:571` reverses the optimistic state: it appends an error bubble, clears `chatStream`, resets `chatRunId`, and surfaces the formatted error. The user message bubble stays — it really was sent or attempted; we tell the truth about that.

## 6. Code locations

- `ui/src/ui/views/chat.ts:146` — the `onSend` prop on the chat view; the input bar wires its submit button and Enter key here.
- `ui/src/ui/views/chat.ts:703` — submit button click handler invoking `props.onSend()`.
- `ui/src/ui/views/chat.ts:1387` — Enter-key path also invoking `props.onSend()`.
- `ui/src/ui/controllers/chat.ts:483` — `sendChatMessage`, the entry point from the view's `onSend`.
- `ui/src/ui/controllers/chat.ts:549` — optimistic insert of the user bubble into `chatMessages` before any network call.
- `ui/src/ui/controllers/chat.ts:563` — `generateUUID()` mint of `runId`, the idempotency key.
- `ui/src/ui/controllers/chat.ts:416` — `requestChatSend`, the RPC wrapper that builds the `chat.send` params.
- `ui/src/ui/controllers/chat.ts:424` — the `client.request("chat.send", {...})` call on the wire-side gateway client.
- `src/gateway/client.ts:1202` — `request<T>(method, params, opts)`; mints frame id, validates, registers pending entry, sends.
- `src/gateway/client.ts:1214` — `frame: RequestFrame = { type: "req", id, method, params }`; the literal envelope shape.
- `src/gateway/protocol/schema/frames.ts:138` — `RequestFrameSchema`; the protocol-level definition of a `req` frame.
- `src/gateway/protocol/schema/logs-chat.ts:35` — `ChatSendParamsSchema`; the validated shape of the `chat.send` body.
- `src/gateway/protocol/schema/logs-chat.ts:51` — `idempotencyKey: NonEmptyString` is required, not optional.

## 7. Branches and extensions

This step took the minimum WebChat path. The real surface has more knobs we glossed over:

- **`sendDetachedChatMessage` and `sendSteerChatMessage`** (`controllers/chat.ts:596`, `:620`) are sibling entry points used by other gestures — sending a message without claiming the chat run, and sending while another run is active to steer it. Both reuse `requestChatSend` and the same `idempotencyKey` pattern.
- **Attachments.** WebChat supports image and file attachments alongside the text; `buildApiAttachments` (`controllers/chat.ts:395`) converts the local data URLs into the wire shape. The branch that uploads bytes through the gateway lives in [12-web-ui-canvas.md §4](./12-web-ui-canvas.md#4-the-chat-view-and-the-controller-split).
- **Slash commands and special inputs.** Inputs that begin with `/` route through `ui/src/ui/chat/slash-command-executor.node.test.ts` and may resolve locally without ever sending `chat.send`. Out of scope for the trace.
- **Reconnect-time queue.** WebChat does not yet ship a true offline queue; if the socket is down, `sendChatMessage` returns null at `controllers/chat.ts:489` and the UI shows the disconnect state. The idempotency hooks are in place for a future queue, but the current behavior is reject-on-disconnect.
- **Stream events.** The matching `chat` events (`delta`, `final`, `aborted`, `error`) the server pushes back are not part of this step. See [11-delivery-and-events.md §7](./11-delivery-and-events.md#7-idempotency-and-message-deduplication) for how `idempotencyKey` feeds server-side dedup, and [12-web-ui-canvas.md §3](./12-web-ui-canvas.md#3-the-websocket-protocol-from-the-browser-side) for the full event-handling shape on the client.

## 8. What you should now have in your head

- The `chat.send` call is **one RPC frame on the existing WebSocket**, not a fresh HTTP request. The transport is reused; only the application-level envelope changes.
- The wire shape is `{type:"req", id:<uuid>, method:"chat.send", params:{...}}`. The `id` is the RPC frame correlation id (one per `request()` call). It is distinct from the `idempotencyKey`/`runId`, which spans the whole run including its stream events.
- `runId` is generated client-side **before** the network call. It enters the optimistic UI state (`state.chatRunId`) and is sent as `idempotencyKey` so the server can dedupe a retried send.
- The user bubble is inserted into `state.chatMessages` **before** the network call returns. Optimistic rendering is what makes WebChat feel local; the catch-block reverses it only when `request(...)` rejects.
- At the end of this step a JSON `chat.send` frame is mid-flight on the socket. The server has not yet parsed it. The browser holds `state.chatSending = true`, the optimistic user bubble visible, and one entry in `client.pending` keyed by the frame id, awaiting the `res`.
