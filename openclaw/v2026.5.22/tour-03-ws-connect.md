# Tour Step 03: WebChat opens a connection

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

At the end of tour-02 the gateway process is alive on `ws://127.0.0.1:18789`. The HTTP server is listening, the `WebSocketServer` is attached, the method registry is built, plugins are loaded, and `attachGatewayWsConnectionHandler` has already wired `wss.on("connection", ...)` at `src/gateway/server/ws-connection.ts:233`. No browser has connected yet. The gateway is holding the `clients: Set<GatewayWsClient>` empty, holding `resolvedAuth` (the resolved token/password/trusted-proxy decision), and holding a `preauthConnectionBudget` that caps how many unauthenticated half-open sockets can sit on the wire.

What we are about to add: one specific socket — the WebChat browser tab — opening the WebSocket upgrade. The browser was served the WebChat HTML by the same gateway over HTTP a moment ago; that HTML loaded a JS bundle from `ui/`, which has now constructed a `WebSocket(...)` against the same origin.

## 2. The problem

A browser-side WebSocket carries less identity than an HTTP request. The two sides need to agree on **who is connecting, with what permissions, over a transport that the browser cannot freely shape**. In one sentence:

> How does the gateway make the WS handshake auth feel HTTP-friendly (token-bearing, replay-resistant, rate-limited) while still letting a long-lived browser client survive disconnects, resume cleanly, and never silently inflate its own privileges?

The pressure here is real. The connection sits open for hours. Whatever scopes it gets, it keeps. A token leaked in a URL log shows up forever. A reconnect storm during a network blip cannot be allowed to be a brute-force amplifier.

## 3. Naive approach

Just rely on cookies. The browser already knows how to send cookies on the WS upgrade. Issue a session cookie at HTTP login, then accept the WS connection if the cookie checks out. Treat the connection as authenticated for life. Done.

## 4. Why the naive approach breaks

The browser WS API gives you almost no control over the handshake. You cannot set custom `Authorization` headers from JS. You cannot easily refuse a stale cookie at the cheapest layer. And the handshake is a one-shot: once the upgrade is accepted, the connection lives until either side closes. Specifically:

- **No header rewrite from JS.** `new WebSocket(url)` does not let you attach headers. If your only auth signal is `Authorization: Bearer`, browsers cannot send it. You are forced to put credentials in the URL or in a post-upgrade message.
- **Cookies get dropped silently.** Third-party-context iframes, Safari's ITP, and "secure context" requirements regularly strip cookies. A cookie-only design produces "logged out for unclear reasons" tickets that are agony to diagnose.
- **Replay of revoked tokens.** If auth is a single check at upgrade time, a connection opened just before a token revocation outlives the revocation indefinitely. The gateway must be able to **rotate** the operator credential and kick old sockets.
- **Reconnect storms become brute-force amplifiers.** A flaky network triggers `WebSocket` reconnect loops. Without per-IP throttling on the auth check itself, ten thousand failed reconnects per second are indistinguishable from a password-guessing attack — except the latter is invisible because there is no log of "we just rejected 9,997 of those".
- **Silent scope inflation.** A naive design lets the client declare its own `scopes: ["operator.admin"]` on connect and trusts it. Default-deny on the server is the only safe shape — otherwise a paired-but-low-privilege device upgrades itself.

## 5. OpenClaw's approach

OpenClaw's approach is to **defer all auth to a single first request frame on the open socket, validate it against shared-secret plus optional device-binding, and tag the resulting connection record with the exact scopes the server is willing to grant — not the scopes the client asked for**. The shape walks like this.

**Step A — the cheap admission gate.** The WebSocket upgrade itself accepts any browser that passes the origin check (`src/gateway/server/ws-connection/message-handler.ts:635`). The socket is now open but the gateway has no `GatewayWsClient` yet — it is sitting in the `pending` `handshakeState` (`ws-connection.ts:272`). A preauth payload-size cap kicks in immediately (`MAX_PREAUTH_PAYLOAD_BYTES`, checked at `message-handler.ts:446`); a 30 KB attacker probe is dropped before parsing. A handshake timer is armed at `ws-connection.ts:436`; a socket that never speaks is collected.

**Step B — the challenge.** Before the client says anything, the gateway sends a `connect.challenge` event (`ws-connection.ts:313`) carrying a fresh `connectNonce`. This is what device-bound clients sign over, defeating offline replay of a prior connect frame: even if an attacker captured a complete connect frame from a previous session, the nonce mismatch closes the new attempt at `message-handler.ts:884`.

**Step C — the one and only handshake frame.** The client must send a single request frame with `method: "connect"` and `params: ConnectParams` (`message-handler.ts:491`). Anything else closes the socket with `invalid-handshake`. The `ConnectParams` carry `client.id`, `role` (operator | node), the client's requested `scopes`, the protocol version negotiated, and credentials — `auth.token`, `auth.password`, an optional `device` signature block keyed to `connectNonce` (`src/gateway/protocol/schema/frames.ts:138`). For WebChat the credentials are simply the shared token the page picked up at HTML load.

**Step D — credential check.** `resolveConnectAuthState` (`ws-connection/auth-context.ts`, called from `message-handler.ts:696`) routes through `authorizeGatewayConnect` (`src/gateway/auth.ts:400`). That function checks shared-secret with `safeEqualSecret` (constant-time), consults the rate limiter on **failed** attempts only, and returns a `GatewayAuthResult` carrying the auth `method` (`token` | `password` | `device-token` | `bootstrap-token` | `trusted-proxy` | `tailscale`). Missing credentials never burn a rate-limit slot (`auth.ts:368`); only wrong ones do (`auth.ts:371`). The limiter is per-IP, per-scope, sliding-window with lockout, and exempts loopback (`auth-rate-limit.ts:99`). Default thresholds: 10 failures inside 60 s window triggers a 5-minute lockout.

**Step E — scope clamping.** Default-deny on scopes. The client's requested `scopes` are not trusted at face value. They are clamped against what the paired device record actually approved (`message-handler.ts:1354`). If the device is unknown, scopes are cleared (`message-handler.ts:810`); if the device asks for a role/scope the pairing does not cover, the connect returns `NOT_PAIRED` with a recovery `requestId` and the upgrade fails (`message-handler.ts:1255`). Browsers without a device identity at all are still allowed for the bundled control-UI/webchat surfaces, but their scopes are zeroed. The connection always ends up with `scopes ⊆ approved`, never the other direction.

**Step F — the connection record.** Only when all checks pass does the gateway build the `GatewayWsClient` record — `socket`, `connect: connectParams`, `connId`, `presenceKey`, `clientIp`, plus the resolved `scopes` baked into `connect.scopes` (`message-handler.ts:1559`). `setClient(nextClient)` inserts it into `clients` and starts a 25 s ping timer (`ws-connection.ts:489`). The reply is a `hello-ok` frame carrying the protocol version, the advertised method list, the issued device token (if any), the server's `stateVersion` snapshot, and the policy block (`maxPayload`, `maxBufferedBytes`, `tickIntervalMs`) — see `message-handler.ts:1695`. The `handshakeState` flips to `connected`.

**Step G — surviving rotation.** For shared-token clients there is one extra trick: each connection records the `sharedGatewaySessionGeneration` (`message-handler.ts:1550`). When the operator rotates the token, the generation bumps and stale connections are closed with code `4001` `gateway auth changed` on their next frame (`message-handler.ts:1810`). That is the answer to the "revoked-token replay" problem — a one-line per-frame check that costs nothing in the common case.

## 6. Code locations

- `src/gateway/server/ws-connection.ts:202` — `attachGatewayWsConnectionHandler`, the per-socket onConnection wiring.
- `src/gateway/server/ws-connection.ts:237` — `connId = randomUUID()`; the connection-scoped id is born here.
- `src/gateway/server/ws-connection.ts:313` — `connect.challenge` nonce sent eagerly before the client's first frame.
- `src/gateway/server/ws-connection.ts:436` — handshake timeout (`handshakeTimer`); a socket that never says `connect` is dropped.
- `src/gateway/server/ws-connection/message-handler.ts:491` — guard that the first frame must be `req` + `method:"connect"`.
- `src/gateway/server/ws-connection/message-handler.ts:635` — origin check for browser clients (control-UI + WebChat).
- `src/gateway/server/ws-connection/message-handler.ts:696` — `resolveConnectAuthState` call; rate-limit and auth-method resolution.
- `src/gateway/auth.ts:400` — `authorizeGatewayConnect`; the shared-secret / trusted-proxy / Tailscale router.
- `src/gateway/auth.ts:354` — `authorizeTokenAuth`; constant-time compare + per-IP failure record.
- `src/gateway/auth-rate-limit.ts:99` — `createAuthRateLimiter`; sliding-window with loopback exemption.
- `src/gateway/auth-resolve.ts:31` — `resolveGatewayAuth`; merges config + env + override into a single `ResolvedGatewayAuth`.
- `src/gateway/server/ws-connection/message-handler.ts:1559` — `GatewayWsClient` constructed; the connection record is born.
- `src/gateway/server/ws-connection/message-handler.ts:1695` — `hello-ok` reply payload assembled.
- `src/gateway/server/ws-types.ts:5` — `GatewayWsClient` shape; this is what every later step holds as `client`.
- `src/gateway/active-sessions-shutdown-tracker.ts:25` — the sibling tracker that keeps live session ids known across shutdown, so the connection layer can drain cleanly on gateway restart.

## 7. Branches and extensions

The trace took the simplest path: WebChat in a loopback browser, default `token` auth mode, no device identity, no Tailscale, no trusted proxy. Each of those is a real branch in the code we did not walk:

- **Device-bound clients.** Mobile apps and the native desktop app sign each connect with their device key against the `connectNonce`. The signature carries `role + scopes + signedAt + nonce`. Pairing approval (silent on local LAN, prompted on remote IPs) is the gate for first-time devices, and the v2/v3 payload formats are negotiated through `resolveDeviceSignaturePayloadVersion` (`message-handler.ts:889`). See [14-auth-and-security.md §3](./14-auth-and-security.md#3-device-pairing-and-signed-handshakes).
- **Trusted-proxy auth.** Reverse proxies (Cloudflare Tunnel, nginx-with-OIDC) inject a user header on a loopback connection. The gateway honors it only when the source is in `gateway.trustedProxies` and the forwarded headers are non-empty. The `authorizeTrustedProxy` body at `auth.ts:270` enforces `allowUsers`, `requiredHeaders`, and a local-interface check that prevents a trusted-proxy mode from accidentally treating direct LAN traffic as proxied. See [14-auth-and-security.md §2](./14-auth-and-security.md#2-token-and-shared-secret-auth) for token mode and the same chapter §3 for trusted-proxy and Tailscale.
- **Rate-limit lockout and recovery.** The limiter logic — window, threshold, lockout, recovery — is its own design study. The browser-origin variant uses a key prefix (`auth-rate-limit.ts:42`) so cross-origin attacks fall into a separate bucket from real-credential attacks. See [14-auth-and-security.md §4](./14-auth-and-security.md#4-auth-rate-limit-and-lockout).
- **Plugin-issued sub-surface tokens.** When plugin host capabilities are advertised, the gateway mints a one-shot capability token per surface and bundles its scoped URL into `hello-ok` (`message-handler.ts:1532`). That feeds the iframe sandbox model used by plugin UIs; each capability has a TTL and is revoked on disconnect.
- **Reconnect resume.** A client that drops mid-stream reconnects with a fresh `connId`. There is no resume-with-replay — the stream is re-subscribed by the client based on the server-issued `stateVersion` numbers in `hello-ok`. The disconnect path drains active session subscriptions (`ws-connection.ts:401`) and node-registry entries before the close completes. See [02-gateway-control-plane.md §5](./02-gateway-control-plane.md#5-connection-lifecycle-and-presence).
- **Shutdown bookkeeping.** The sibling `active-sessions-shutdown-tracker.ts:25` keeps a registry of sessions that opened a `session_start` plugin hook but have not yet emitted `session_end`. On gateway shutdown the close handler drains the set so plugins (`claude-mem` and friends) can finalize sessions even when their connection dies with the process. This is the same tracker that gets cleared if a session is reset or compacted mid-flight.

## 8. What you should now have in your head

- The WS upgrade itself is **not** the auth boundary. The auth boundary is the **first request frame** on the open socket — a `connect` request. Until that frame validates, the socket is in `pending` state and any other frame closes it.
- A `connId` is minted at upgrade time (`randomUUID()`), but the `GatewayWsClient` record — the thing that makes the connection real to the rest of the gateway — only exists after `setClient(nextClient)` runs at `message-handler.ts:1583`.
- Scopes are **default-deny**. Whatever the client puts in `connectParams.scopes` is clamped to what the paired device record has approved; an un-paired browser ends up with `scopes: []`.
- Token rotation is enforced by stamping every connection with the `sharedGatewaySessionGeneration` of the auth at connect time, and re-checking it on every later frame.
- After this step we hold one `GatewayWsClient` in the `clients` set. It has `connId`, `connect: ConnectParams`, `scopes` (post-clamp), `presenceKey`, and a live socket. We are ready to receive `chat.send`.
