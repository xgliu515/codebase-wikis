# Tour Step 05: RPC method registry dispatch

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

The `chat.send` JSON frame has arrived at the gateway. Inside the WS message handler at `src/gateway/server/ws-connection/message-handler.ts:441`, the bytes were parsed into a JS object. The early-handshake branch was skipped because `getClient()` is now non-null (we built the `GatewayWsClient` in tour-03). The frame passed `validateRequestFrame` at `message-handler.ts:1785`, so `req` has the shape `{ type: "req", id, method: "chat.send", params: {...} }`.

The handler at `message-handler.ts:1859` is about to do one thing: lazy-import `../../server-methods.js`, build the `respond` closure, and call `handleGatewayRequest({ req, respond, client, ... })`. We are standing at the front door of the dispatcher. The shared gateway-session-generation check has already run (`message-handler.ts:1799`) and not closed the connection. Nothing else has been validated yet.

## 2. The problem

The gateway exposes a lot of RPC methods. Look at `src/gateway/methods/core-descriptors.ts:18` — over 130 of them at this commit: `chat.send`, `chat.abort`, `chat.history`, `sessions.list`, `sessions.delete`, `agent.cancel`, `tools.invoke`, `models.list`, `cron.add`, `node.pair.request`, `update.run`, and so on. Plus dynamic plugin methods.

> Every one of those methods needs the same scaffolding done correctly: parse-time validation, role check (operator vs node), scope check (`operator.read` vs `operator.write` vs `operator.admin`), startup-availability gating, control-plane write rate-limiting, error envelope with consistent shape, telemetry/logging hooks, and finally a call to the actual business logic. Doing it in 130 places is wrong.

The hard part is that the scaffolding is **not uniform**. Some methods are admin-only. Some are node-role-only. Some are unavailable until sidecars come up. Some count toward a control-plane write budget. Some accept any operator scope, some require a specific one. A switch statement papers over this; a real design has to make the metadata first-class.

## 3. Naive approach

A giant `switch (method) { ... }`. Each case parses its own params, does its own scope check inline (`if (!scopes.includes("operator.write")) return error`), calls its handler, formats its response. Easy to grep. Easy to debug.

## 4. Why the naive approach breaks

The switch is exactly the wrong shape for the requirements above. It fails along four axes:

- **Scope checks are scattered and easy to forget.** Adding a new method means remembering to write the scope check in your case branch. Skip it and you have a privilege escalation. Forget the role check (`role === "node"` vs operator) and a node connection can call operator-only methods. There is no central audit point that says "every method passes through one authorize() call".
- **No way to ask the system "what methods exist, what do they need?"** A switch is opaque to introspection. The `hello-ok` frame needs to advertise the available method names. The CLI's `--help` wants to enumerate. Tools like the `openclaw doctor` introspection paths want to enumerate, too. A switch makes you maintain a parallel list, which will drift.
- **Plugins cannot contribute methods.** When a plugin adds a new RPC method, the giant switch is in the wrong file — the core. Either every plugin patches core (impossible), or plugins live somewhere else with their own dispatch logic, which means the auth boundary is now duplicated.
- **Startup ordering needs a way to mark methods unavailable.** Some methods (`models.list`, `sessions.list`, `chat.history`) are unavailable until sidecars and stores are ready (`core-descriptors.ts:86,124,188`). A switch needs an `if (!ready) return UNAVAILABLE` line in every case branch. A registry can carry the flag as metadata.

The deeper issue is that the switch confuses **routing** (name → handler) with **policy** (scope, startup, control-plane-write). Policy wants to be queried and applied centrally; routing wants to be extended dynamically.

## 5. OpenClaw's approach

OpenClaw's approach is to **build a method registry where each entry is a descriptor carrying `name`, `handler`, `scope`, `owner`, `startup`, `controlPlaneWrite`, and `advertise` — and to dispatch through one function that consults the descriptor metadata before calling the handler**. The handlers themselves do nothing about auth.

The descriptor type lives at `src/gateway/methods/descriptor.ts:21`:

```ts
export type GatewayMethodDescriptor = {
  name: string;
  handler: GatewayMethodHandler;
  scope: GatewayMethodScope;
  owner: GatewayMethodOwner;        // core | plugin | channel | aux
  startup?: "unavailable-until-sidecars";
  controlPlaneWrite?: boolean;
  advertise?: boolean;
  description?: string;
};
```

The registry is just a Map-backed `getHandler` / `getScope` / `descriptors` view built by `createGatewayMethodRegistry` (`src/gateway/methods/registry.ts:51`). Core methods are listed declaratively in `CORE_GATEWAY_METHOD_SPECS` (`src/gateway/methods/core-descriptors.ts:18`). `chat.send` is registered with:

```ts
{ name: "chat.send", scope: "operator.write" }
// at src/gateway/methods/core-descriptors.ts:190
```

That single line encodes the policy. The actual handler is mapped to it in `coreGatewayHandlers` (`src/gateway/server-methods.ts:99`) where `...chatHandlers` is spread; the `chat.send` key under `chatHandlers` (defined at `src/gateway/server-methods/chat.ts:2183`) is matched to the descriptor by name. The descriptor and the handler meet inside `createCoreGatewayMethodDescriptors` (`core-descriptors.ts:253`), which iterates the specs and binds each spec's metadata to the named handler.

Dispatch is `handleGatewayRequest` at `src/gateway/server-methods.ts:179`. The sequence is fixed:

```ts
const methodRegistry = opts.methodRegistry ?? createRequestGatewayMethodRegistry(opts.extraHandlers);
const authError = authorizeGatewayMethod(req.method, client, req.params);
if (authError) { respond(false, undefined, authError); return; }
if (context.unavailableGatewayMethods?.has(req.method)) { /* UNAVAILABLE */ }
if (methodRegistry.isControlPlaneWrite(req.method)) { /* rate budget */ }
const handler = methodRegistry.getHandler(req.method);
if (!handler) { respond(false, ..., "unknown method"); return; }
await withPluginRuntimeGatewayRequestScope(..., invokeHandler);
```

`authorizeGatewayMethod` (`server-methods.ts:66`) consolidates all the policy: parse the role from `client.connect.role`, check `isRoleAuthorizedForMethod` (so a `node` role cannot call an operator method, and vice versa), then read the connection's scopes and call `authorizeOperatorScopesForMethod` (`src/gateway/method-scopes.ts:150`) for operators. Inside that function: `ADMIN_SCOPE` is the master key (`method-scopes.ts:155`), `READ_SCOPE` accepts read or write (`method-scopes.ts:177`), everything else requires exact-scope match. The required scope itself comes from the descriptor, not the call site.

For `chat.send`, our `GatewayWsClient` has `role: "operator"` and `scopes` containing `"operator.write"` (because the paired device/local-client allowed it during tour-03 connect). `isRoleAuthorizedForMethod("operator", "chat.send")` returns true, `authorizeOperatorScopesForMethod("chat.send", scopes)` returns `{ allowed: true }`. No `authError`. `unavailableGatewayMethods` does not include `chat.send` after startup. `isControlPlaneWrite("chat.send")` is false (control-plane writes are config mutations, restart, etc., flagged in the specs — see `core-descriptors.ts:47-48`). The registry returns the `chatHandlers["chat.send"]` function (`server-methods/chat.ts:2183`), and `invokeHandler` calls it with `{ req, params, client, isWebchatConnect, respond, context }`.

Errors at every step use the same envelope: `errorShape(code, message, opts?)` from `src/gateway/protocol/schema/error-codes.ts:14`. The reply over the wire is always `{type:"res", id:<same as req.id>, ok:false, error:{code, message, details?, retryable?, retryAfterMs?}}`. Five error codes total (`NOT_LINKED`, `NOT_PAIRED`, `AGENT_TIMEOUT`, `INVALID_REQUEST`, `UNAVAILABLE`), and `INVALID_REQUEST` covers both shape and authorization failures — by design, so an attacker probing for valid method names cannot distinguish "wrong scope" from "wrong params".

One more thing this design buys: `withPluginRuntimeGatewayRequestScope` (`src/plugins/runtime/gateway-request-scope.ts`) wraps every handler invocation so plugin runtime calls made *during* the handler (subagent spawns, plugin-owned tool execution) can dispatch back through the same registry without re-doing connection-level auth. The scope carries the `client` and `context` references through async hops.

## 6. Code locations

- `src/gateway/server/ws-connection/message-handler.ts:1859` — the per-frame call site: `handleGatewayRequest({ req, respond, client, ... })`.
- `src/gateway/server-methods.ts:179` — `handleGatewayRequest`, the dispatcher entry.
- `src/gateway/server-methods.ts:185` — `authorizeGatewayMethod` invocation; central scope/role gate.
- `src/gateway/server-methods.ts:66` — `authorizeGatewayMethod` body: role parse, role allowlist, admin shortcut, operator scope check.
- `src/gateway/server-methods.ts:228` — `methodRegistry.getHandler(req.method)`; the name-to-function lookup.
- `src/gateway/server-methods.ts:237` — `invokeHandler` builds the call-time options object passed to the handler.
- `src/gateway/server-methods.ts:99` — `coreGatewayHandlers` aggregate (the `...chatHandlers` spread is here).
- `src/gateway/server-methods/chat.ts:2183` — the `chat.send` handler entry: `"chat.send": async ({ params, respond, context, client }) => { ... }`.
- `src/gateway/methods/descriptor.ts:21` — `GatewayMethodDescriptor` type; the metadata schema.
- `src/gateway/methods/registry.ts:51` — `createGatewayMethodRegistry`; the Map-backed registry constructor.
- `src/gateway/methods/core-descriptors.ts:190` — `{ name: "chat.send", scope: "operator.write" }` registration line.
- `src/gateway/method-scopes.ts:150` — `authorizeOperatorScopesForMethod`; the scope-policy core.
- `src/gateway/protocol/schema/error-codes.ts:14` — `errorShape(code, message, opts?)`; uniform error envelope.

## 7. Branches and extensions

The trace took the happy path: an operator-role client with `operator.write` calling a core method that is available and not control-plane-write. The branches we did not walk:

- **Plugin-contributed methods.** When a plugin's `gatewayHandlers` map carries a method not in `CORE_GATEWAY_METHOD_SPECS`, `createRequestGatewayMethodRegistry` (`server-methods.ts:142`) folds it in via `createPluginGatewayMethodDescriptors` (`methods/registry.ts:112`). Default scope is `ADMIN_SCOPE` unless the plugin specified one. See [02-gateway-control-plane.md §4](./02-gateway-control-plane.md#4-the-rpc-method-registry) for the full registry build.
- **Dynamic scopes (`plugins.sessionAction`).** A method whose required scope depends on the params (the plugin-registered action) goes through the dynamic-scope branch (`method-scopes.ts:158`). The registered action's `requiredScopes` is consulted; absent that, `WRITE_SCOPE` is the default. See [14-auth-and-security.md §6](./14-auth-and-security.md#6-scope-based-permissions-and-method-authorization).
- **Control-plane-write rate limiting.** Methods marked `controlPlaneWrite: true` (`config.apply`, `config.patch`, `update.run`, `gateway.restart.request`, `models.authLogout` — see `core-descriptors.ts`) flow through `consumeControlPlaneWriteBudget` (`server-methods.ts:203`). A burst-protected budget per actor caps mutation rate. Audit log via `formatControlPlaneActor`.
- **Startup-unavailable methods.** `models.list`, `sessions.list`, `sessions.create`, `sessions.send`, `sessions.abort`, `agent.wait`, `chat.history`, `tools.effective` carry `startup: true` (`core-descriptors.ts:86-188`). Before sidecars finish, these return `UNAVAILABLE` with `retryAfterMs`. The `context.unavailableGatewayMethods` set is the source of truth.
- **Node-role methods.** Methods scoped `"node"` (`node.event`, `node.invoke.result`, `node.pending.pull`, etc.) are short-circuited at `server-methods.ts:86` — node role passes; operator role is rejected. The role/scope dual-axis design is what makes this work without per-method conditionals.
- **`respond` flood guard.** Repeated unauthorized responses on one connection trip the `UnauthorizedFloodGuard` (`message-handler.ts:1822`), which suppresses logs and eventually closes the socket. Hostile probing does not produce infinite log noise.

For the lifecycle of a single request from socket-read to handler-return, the umbrella story is in [02-gateway-control-plane.md §5](./02-gateway-control-plane.md#5-connection-lifecycle-and-presence). For the broader scope/permissions model — operator scopes, role taxonomy, admin override — see [14-auth-and-security.md §6](./14-auth-and-security.md#6-scope-based-permissions-and-method-authorization).

## 8. What you should now have in your head

- The gateway's RPC dispatch is **a registry of descriptors keyed by method name**, not a switch. Each descriptor carries the policy (scope, startup, control-plane-write, owner) as data.
- `handleGatewayRequest` at `src/gateway/server-methods.ts:179` is the single funnel. Every method passes through one role check, one scope check, one startup check, one control-plane-write check, before the handler ever runs.
- Handlers receive `{ req, params, client, isWebchatConnect, respond, context }` and have no auth code of their own. The `chat.send` handler at `server-methods/chat.ts:2183` starts straight from params validation.
- Errors use one envelope, `errorShape(code, message, opts?)`, with only five codes. Scope failures and shape failures both report `INVALID_REQUEST` — by design, to avoid leaking authorization signal to probers.
- After this step we are inside the `chat.send` handler, holding `params: { sessionKey, message: "hello", deliver:false, idempotencyKey:<runId> }` and `client: GatewayWsClient`. No `MsgContext` yet, no session resolved. That is the next step.
