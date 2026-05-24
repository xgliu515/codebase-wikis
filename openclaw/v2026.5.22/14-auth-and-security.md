# Chapter 14 — Auth and Security

Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 14.1 The problem this chapter solves

OpenClaw is a *self-hosted personal assistant gateway*. One long-running process — the **Gateway** — sits in front of a Control UI, mobile apps, the CLI, dozens of chat channels, and a stack of LLM providers. That single fact creates an entire family of security questions:

- Who is allowed to talk to the Gateway, and what proves it?
- Once they are talking, what are they allowed to do?
- How does a brand-new device (a phone, a new laptop) bootstrap trust the very first time?
- How are dozens of vendor API keys stored, rotated and audited without leaking?
- Which actions are dangerous enough to need an extra confirmation gate?

Before answering any of those, you have to internalise the one piece of context that drives every design decision in this chapter — the **operator trust model**. `SECURITY.md:121-123` states it bluntly:

> OpenClaw does **not** model one gateway as a multi-tenant, adversarial user boundary.
> Authenticated Gateway callers are treated as trusted operators for that gateway instance.

That sentence is load-bearing. It means there is no second-tier "user inside a tenant" boundary anywhere in the codebase: anything that authenticates to the Gateway is the operator. `SECURITY.md:136-138` doubles down on the deployment shape:

> Recommended mode: one user per machine/host (or VPS), one gateway for that user, and one or more agents inside that gateway.

The naive design would be a full RBAC system with per-user policies, ACLs, and audit logs of every action. OpenClaw deliberately rejects that — it would force a personal tool to carry the complexity of a multi-tenant SaaS and make the "I just want to run my assistant" path miserable. Instead, the security surface is laid out in concentric rings:

| Ring | Concern | Entry point |
| --- | --- | --- |
| 0 | Who can reach the Gateway socket at all? | `src/gateway/auth.ts`, `src/gateway/auth-resolve.ts` |
| 1 | Which authentication method are they using? | `src/gateway/auth-mode-policy.ts`, `src/gateway/auth-install-policy.ts` |
| 2 | Did they spell their credential right too many times? | `src/gateway/auth-rate-limit.ts` |
| 3 | Which RPC methods are they allowed to invoke? | `src/gateway/method-scopes.ts`, `src/gateway/operator-scopes.ts` |
| 4 | How does a new device get a credential in the first place? | `src/pairing/` |
| 5 | Where do credentials live on disk and how are they injected? | `src/secrets/`, `src/agents/auth-profiles/store.ts` |
| 6 | Which actions need the *human* to say yes? | tool approval gate (see Chapter 09) |
| 7 | What stops a malicious plugin from owning the host? | `src/security/audit-plugins-trust.ts`, plugin trust boundary in `SECURITY.md` |
| 8 | Self-diagnosis: what does the operator's setup actually look like? | `src/crestodian/`, `src/secrets/audit.ts` |

The rest of this chapter walks those rings outside-in.

---

## 14.2 Ring 0: Gateway connection auth

### 14.2.1 The naive design and why it fails

If you sketched the most obvious thing, it would be: "ship a shared bearer token; if the header matches, you're in." OpenClaw *does* support that mode, but if it were the only mode three things go wrong:

1. **Bootstrap chicken-and-egg.** Where does the operator get the token? If the gateway can't start without one, the very first `openclaw gateway` fails. If it auto-generates one and writes it to config, then any subsequent reload reads it back, and rotating it becomes a config edit (i.e., not really a rotation).
2. **Reverse proxies.** Real deployments terminate TLS in nginx/Caddy/Tailscale Serve and forward an identity header. A pure-token mode either ignores that header (worst) or trusts it everywhere (terrifying).
3. **Multi-surface drift.** The browser Control UI on `ws://127.0.0.1` and the OpenAI-compatible HTTP endpoint on `:port/v1/chat/completions` are very different attack surfaces. One pre-shared-token-everywhere policy ends up either too loose for the public surface or too strict for the local one.

OpenClaw's answer is a small *resolved-auth* object that captures the operator's intent and a *surface-aware* authoriser that knows which surface it is on. We meet both next.

### 14.2.2 ResolvedGatewayAuth — the normalised intent

Every code path that needs to know "what kind of auth is this Gateway running?" starts with `resolveGatewayAuth` in `src/gateway/auth-resolve.ts:31`. It folds the raw config object, an optional override, environment variables and the Tailscale mode into a single `ResolvedGatewayAuth` value:

```ts
// src/gateway/auth-resolve.ts:17
export type ResolvedGatewayAuth = {
  mode: ResolvedGatewayAuthMode;          // "none" | "token" | "password" | "trusted-proxy"
  modeSource?: ResolvedGatewayAuthModeSource;
  token?: string;
  password?: string;
  allowTailscale: boolean;
  trustedProxy?: GatewayTrustedProxyConfig;
};
```

There are exactly four modes (`src/gateway/auth-resolve.ts:9`):

- `none` — no auth at the gateway layer. Only sensible on a private loopback or trusted network.
- `token` — a shared bearer token. The default starting point.
- `password` — a shared password (used by the Control UI's password prompt).
- `trusted-proxy` — auth is delegated to an upstream reverse proxy that injects an identity header.

The mode is *inferred* with an explicit precedence chain (`src/gateway/auth-resolve.ts:74-91`):

```ts
// src/gateway/auth-resolve.ts:76
if (authOverride?.mode !== undefined) {
  mode = authOverride.mode;
  modeSource = "override";
} else if (authConfig.mode) {
  mode = authConfig.mode;
  modeSource = "config";
} else if (password) {
  mode = "password";
  modeSource = "password";
} else if (token) {
  mode = "token";
  modeSource = "token";
} else {
  mode = "token";
  modeSource = "default";
}
```

That's *explicit override → explicit config → inferred-from-password → inferred-from-token → default-to-token*. The `modeSource` field is preserved so diagnostics can later distinguish "the operator typed `token`" from "we defaulted to `token` because nothing was configured". `src/gateway/auth-mode-policy.ts:7-19` adds a guardrail: if `mode` is *unset* but both `token` and `password` are configured, startup throws `EXPLICIT_GATEWAY_AUTH_MODE_REQUIRED_ERROR` (`src/gateway/auth-mode-policy.ts:4-5`) — silent precedence between two co-configured secrets is exactly the kind of footgun the operator should be forced to resolve.

The `allowTailscale` default (`src/gateway/auth-resolve.ts:93-95`) is subtle:

```ts
// src/gateway/auth-resolve.ts:93
const allowTailscale =
  authConfig.allowTailscale ??
  (params.tailscaleMode === "serve" && mode !== "password" && mode !== "trusted-proxy");
```

In words: Tailscale header auth is only on by default if the Gateway is actually fronted by Tailscale Serve *and* the operator hasn't chosen `password` or `trusted-proxy`. The two excluded modes already designate someone else as the trust anchor (a human typing a password, or an upstream proxy), so layering Tailscale identity on top would create exactly the kind of "who really authorised this?" ambiguity the chapter intro warned against.

### 14.2.3 authorizeGatewayConnect — the surface-aware dispatch

Once `ResolvedGatewayAuth` exists, `authorizeGatewayConnect` (`src/gateway/auth.ts:400`) is the single function every accept path in the Gateway funnels through. Its key signature pieces (`src/gateway/auth.ts:61-87`):

```ts
// src/gateway/auth.ts:59
export type GatewayAuthSurface = "http" | "ws-control-ui";

export type AuthorizeGatewayConnectParams = {
  auth: ResolvedGatewayAuth;
  connectAuth?: ConnectAuth | null;
  req?: IncomingMessage;
  trustedProxies?: string[];
  tailscaleWhois?: TailscaleWhoisLookup;
  authSurface?: GatewayAuthSurface;
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
  // ...
};
```

The `authSurface` discriminator is why this function exists at all. `src/gateway/auth.ts:324-326` resolves it:

```ts
function shouldAllowTailscaleHeaderAuth(authSurface: GatewayAuthSurface): boolean {
  return authSurface === "ws-control-ui";
}
```

In other words, **Tailscale header-based login is only honoured for the Control UI WebSocket**, never for the OpenAI-compatible HTTP surface. That answers a real attack: a public HTTP endpoint with forwarded headers should not be silently trustworthy just because the headers *look* like Tailscale forwarded the request. Two thin wrappers (`src/gateway/auth.ts:564-580`) lock each surface in:

```ts
// src/gateway/auth.ts:564
export async function authorizeHttpGatewayConnect(...) {
  return authorizeGatewayConnect({ ...params, authSurface: "http" });
}
export async function authorizeWsControlUiGatewayConnect(...) {
  return authorizeGatewayConnect({ ...params, authSurface: "ws-control-ui" });
}
```

Inside `authorizeGatewayConnectCore` (`src/gateway/auth.ts:435`), the dispatch fans out by `mode`:

- `mode: "trusted-proxy"` — `authorizeTrustedProxy` (`src/gateway/auth.ts:270`) validates that the request actually came *from* a trusted-proxy IP (`isTrustedProxyAddress`), is not a bare loopback or local-interface request (those would trivially forge the header), carries every `requiredHeaders` entry, and surfaces a user identity through `userHeader`. `allowUsers` is enforced if set. There's an interesting fallback at `src/gateway/auth.ts:481-500`: if the trusted-proxy check fails but the request is local-direct *and* a shared password is configured, the request is allowed to fall through to password auth — that lets a local CLI keep working even when the gateway is reverse-proxied.
- `mode: "none"` — short-circuit to `{ ok: true, method: "none" }` (`src/gateway/auth.ts:504-506`). No rate limiter check, no header inspection; this mode is only for closed-host networks.
- Tailscale header path (`src/gateway/auth.ts:520-538`) — when `authSurface === "ws-control-ui"` and `allowTailscale` is on and the connect did *not* supply an explicit shared secret, the resolver pulls `tailscale-user-login` / `tailscale-user-name` from the proxied headers and cross-checks with the `tailscaled` whois RPC (`resolveVerifiedTailscaleUser`, `src/gateway/auth.ts:189`). Both the header-declared login and the IP whois must agree.
- `mode: "token"` — `authorizeTokenAuth` (`src/gateway/auth.ts:354`) uses `safeEqualSecret` (timing-safe compare from `src/security/secret-equal.ts`) and only records a rate-limiter failure on *mismatch*. A missing token returns `token_missing` *without* burning a rate-limit slot — see 14.4.
- `mode: "password"` — `authorizePasswordAuth` (`src/gateway/auth.ts:378`) is symmetrical.

The serialisation wrapper at `src/gateway/auth.ts:419-430` is worth a beat:

```ts
// src/gateway/auth.ts:419
if (
  limiter &&
  shouldAllowTailscaleHeaderAuth(authSurface) &&
  auth.allowTailscale &&
  !localDirect
) {
  return await withSerializedRateLimitAttempt({
    ip,
    scope: rateLimitScope,
    run: async () => await authorizeGatewayConnectCore(params),
  });
}
```

The Tailscale branch is *async* (whois is an out-of-process RPC). Without this serialisation, a flood of concurrent attempts from the same IP could each pass the pre-check before any of them recorded a failure, defeating the limiter. Tying pre-check and failure-write under one `{scope, ip}` lock closes that race.

<svg viewBox="0 0 760 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="authorizeGatewayConnect dispatch flow: an inbound HTTP or WebSocket request enters authorizeGatewayConnect, is dispatched by authSurface, and branches across trusted-proxy, none, Tailscale, token and password modes into a single GatewayAuthResult.">
<defs>
<marker id="g14-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
<marker id="g14-arrd" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="220" y="10" width="320" height="38" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
<text x="380" y="28" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">inbound connection</text>
<text x="380" y="42" text-anchor="middle" font-size="10" fill="#64748b">HTTP request OR WS upgrade</text>
<line x1="380" y1="48" x2="380" y2="70" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14-arr)"/>
<rect x="200" y="72" width="360" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="380" y="90" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">authorizeGatewayConnect (auth.ts:400)</text>
<text x="380" y="106" text-anchor="middle" font-size="10" fill="#64748b">authSurface = "http" | "ws-control-ui"</text>
<line x1="380" y1="116" x2="380" y2="138" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14-arr)"/>
<rect x="200" y="140" width="360" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="380" y="160" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">authorizeGatewayConnectCore (auth.ts:435)</text>
<line x1="380" y1="174" x2="380" y2="196" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14-arr)"/>
<line x1="80" y1="210" x2="680" y2="210" stroke="#cbd5e1" stroke-width="1"/>
<line x1="140" y1="196" x2="140" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14-arr)"/>
<line x1="260" y1="196" x2="260" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14-arr)"/>
<line x1="380" y1="196" x2="380" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14-arr)"/>
<line x1="500" y1="196" x2="500" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14-arr)"/>
<line x1="620" y1="196" x2="620" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14-arr)"/>
<line x1="140" y1="210" x2="140" y2="232" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14-arr)"/>
<line x1="260" y1="210" x2="260" y2="232" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14-arr)"/>
<line x1="380" y1="210" x2="380" y2="232" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14-arr)"/>
<line x1="500" y1="210" x2="500" y2="232" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14-arr)"/>
<line x1="620" y1="210" x2="620" y2="232" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14-arr)"/>
<rect x="64" y="234" width="152" height="62" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
<text x="140" y="252" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">trusted-proxy</text>
<text x="140" y="268" text-anchor="middle" font-size="9" fill="#64748b">authorizeTrustedProxy</text>
<text x="140" y="280" text-anchor="middle" font-size="9" fill="#64748b">IP + required headers</text>
<text x="140" y="291" text-anchor="middle" font-size="9" fill="#64748b">+ allowUsers</text>
<rect x="200" y="234" width="120" height="62" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
<text x="260" y="256" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">none</text>
<text x="260" y="272" text-anchor="middle" font-size="9" fill="#64748b">short-circuit ok</text>
<text x="260" y="287" text-anchor="middle" font-size="9" fill="#94a3b8">no rate-limit</text>
<rect x="324" y="234" width="120" height="62" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
<text x="384" y="252" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">tailscale</text>
<text x="384" y="268" text-anchor="middle" font-size="9" fill="#64748b">ws-control-ui only</text>
<text x="384" y="280" text-anchor="middle" font-size="9" fill="#64748b">whois + login</text>
<text x="384" y="291" text-anchor="middle" font-size="9" fill="#64748b">cross-check</text>
<rect x="448" y="234" width="120" height="62" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="508" y="252" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">token</text>
<text x="508" y="268" text-anchor="middle" font-size="9" fill="#64748b">authorizeTokenAuth</text>
<text x="508" y="280" text-anchor="middle" font-size="9" fill="#64748b">safeEqualSecret</text>
<text x="508" y="291" text-anchor="middle" font-size="9" fill="#64748b">recordFailure on miss</text>
<rect x="572" y="234" width="120" height="62" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="632" y="252" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">password</text>
<text x="632" y="268" text-anchor="middle" font-size="9" fill="#64748b">authorizePasswordAuth</text>
<text x="632" y="280" text-anchor="middle" font-size="9" fill="#64748b">safeEqualSecret</text>
<text x="632" y="291" text-anchor="middle" font-size="9" fill="#64748b">recordFailure on miss</text>
<line x1="140" y1="296" x2="380" y2="328" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#g14-arrd)"/>
<line x1="260" y1="296" x2="380" y2="328" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#g14-arrd)"/>
<line x1="384" y1="296" x2="380" y2="328" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#g14-arrd)"/>
<line x1="508" y1="296" x2="380" y2="328" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#g14-arrd)"/>
<line x1="632" y1="296" x2="380" y2="328" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#g14-arrd)"/>
<rect x="220" y="330" width="320" height="38" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
<text x="380" y="348" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">GatewayAuthResult</text>
<text x="380" y="362" text-anchor="middle" font-size="10" fill="#64748b">ok | method | user | reason | rateLimited</text>
<rect x="60" y="394" width="640" height="50" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
<text x="380" y="412" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">Async whois branch (Tailscale) is serialised per {scope, ip} via</text>
<text x="380" y="427" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">withSerializedRateLimitAttempt — prevents concurrent attempts from outrunning the limiter (auth.ts:419-430).</text>
</svg>
<span class="figure-caption">Figure R14.1 | authorizeGatewayConnect dispatch: surface-aware mode branches into a single GatewayAuthResult.</span>

<details><summary>ASCII original</summary>
```
              inbound connection (HTTP / WS upgrade)
                              |
                              v
            authorizeGatewayConnect (auth.ts:400)
              [authSurface = "http" | "ws-control-ui"]
                              |
                              v
          authorizeGatewayConnectCore (auth.ts:435)
                              |
    +-----------+-----+-------+-------+--------+----------+
    v           v               v             v           v
trusted-proxy  none         tailscale       token     password
(IP/header/   (ok)          ws-only,      safeEqual  safeEqual
 allowUsers)                 whois)                  
    \           \              |              /          /
     \           \             v             /          /
      ---------------> GatewayAuthResult <----------
        (Async Tailscale branch wrapped in withSerializedRateLimitAttempt)
```
</details>

### 14.2.4 The startup-token problem (and the v2026.5.22 fix)

What happens if the gateway boots with no token configured at all? `ensureGatewayStartupAuth` (`src/gateway/startup-auth.ts:125`) handles that. If `mode` resolves to `token` and the resolved token is empty, the function generates a runtime-only token:

```ts
// src/gateway/startup-auth.ts:192
const generatedToken = crypto.randomBytes(24).toString("hex");
const nextCfg: OpenClawConfig = {
  ...params.cfg,
  gateway: {
    ...params.cfg.gateway,
    auth: {
      ...params.cfg.gateway?.auth,
      mode: "token",
      token: generatedToken,
    },
  },
};
```

The companion warning template (`src/gateway/server.impl.ts:420-431`) is explicit that this is *runtime-only*: "Generated a runtime token for this startup without changing config; restart will generate a different token." The operator-facing CLI tells them how to make it persistent. There is no auto-persist back to config — that would silently mutate config on a server that already started up once, and operators would lose track of which value was canonical.

Two other safety rails are bolted on to this path:

- `assertGatewayAuthNotKnownWeak` (`src/gateway/known-weak-gateway-secrets.ts:26-49`) rejects two specific token values (`"change-me-to-a-long-random-token"`, `"change-me-now"`) and one password (`"change-me-to-a-strong-password"`). Those have all shipped in `.env.example` files at some point; if any of them resolves as the live secret it almost certainly means the operator copy-pasted an example file verbatim. The check is run both on the configured path *and* on the generated path (`src/gateway/startup-auth.ts:187,214`) — the comment at `:210-213` explains why it's there even when the token was just crypto-randomly generated: it documents the rule uniformly and guards against any future path that feeds an external value through `nextAuth`.
- `assertHooksTokenSeparateFromGatewayAuth` (`src/gateway/startup-auth.ts:224-246`) forbids reusing the gateway auth token as the `hooks.token`. Hooks are an *inbound* webhook surface that anyone with a forwardable URL can reach; sharing its secret with the operator-control bearer would mean a leaked webhook token grants operator access.

#### The v2026.5.22 Docker log leak

Until v2026.5.22, the bundled `scripts/docker/setup.sh` printed the gateway token directly to its standard output as part of the "you're ready" summary. That meant the token ended up in `docker logs`, in compose logs piped to syslog, and in any CI scrollback that captured the container's first run. Commit `75b5c76c7f` ("fix(docker): avoid printing gateway token") closes that. Two changes do the actual work:

1. `scripts/docker/setup.sh` no longer echoes `$OPENCLAW_GATEWAY_TOKEN`. Both occurrences become `"Gateway token: stored in Docker environment/config (not printed)."`, and the health-check example uses a shell `'…\$OPENCLAW_GATEWAY_TOKEN…'` so the variable is *expanded by the container's shell at run time*, not by the host shell that wrote the message.
2. The container now invokes `openclaw onboard` with two new flags (`src/cli/program/register.onboard.ts:170`):

```ts
.option("--suppress-gateway-token-output", "Suppress token-bearing Gateway/UI output")
```

The wizard finalizer (`src/wizard/setup.finalize.ts:80`) reads `opts.suppressGatewayTokenOutput` and gates every place that would otherwise print the token-bearing URL or the dashboard token hint. The relevant guards are `setup.finalize.ts:395-396`, `:421-422`, `:507-510` and `:514-518`. The note panel that prints token-management commands is built from a filter chain (`setup.finalize.ts:454-469`) that drops the two lines containing the live token when the suppression flag is set.

This is a useful pattern to internalise: the codebase treats *log output* as a security surface in its own right. A correct token still leaks if it's printed to the wrong stream.

### 14.2.5 Auth surface resolution — the "interactive vs. probe" split

`src/gateway/auth-surface-resolution.ts` answers a different question from connection auth: *what credentials should an outbound CLI/probe present back to the gateway?* The Gateway and the CLI run in the same process tree on a desktop install, but the CLI may also be calling a *remote* gateway. Two flavours:

- `resolveGatewayProbeSurfaceAuth` (`src/gateway/auth-surface-resolution.ts:46-142`) is the probe path — what `openclaw doctor` / `openclaw gateway status` should send. It picks the local vs. remote credential pair based on `surface: "local" | "remote"` and the configured `authMode`. When `mode` is `none` or `trusted-proxy` it returns `{}` (probes don't carry bearer secrets on those surfaces).
- `resolveGatewayInteractiveSurfaceAuth` (`src/gateway/auth-surface-resolution.ts:144-289`) is the interactive path used by long-running CLI sessions. It honours an `explicitAuth` override (e.g., `--gateway-token …`) and a `suppressEnvAuthFallback` toggle for tests/sandbox.

The key insight is that *outbound* credentials are resolved separately from *inbound* validation. The same shared secret may take three different paths into a config — `gateway.auth.token`, `${OPENCLAW_GATEWAY_TOKEN}`, or a `SecretRef` — and the resolver normalises them all to a string before any wire bytes go out.

### 14.2.6 The env-vs-config conflict detector

`resolveGatewayAuthTokenSourceConflict` (`src/gateway/auth-token-source-conflict.ts:17-74`) catches a very specific footgun: the operator put a token in `gateway.auth.token` *and* exported `OPENCLAW_GATEWAY_TOKEN` to a different value. The function deliberately *only* triggers when:

- `OPENCLAW_GATEWAY_TOKEN` is set and is *not* the config-resolved value (`:21,52-54`);
- the process is not itself the managed gateway service (`:26-28`);
- the gateway isn't in `remote` mode (`:30-32`);
- the auth mode isn't `password`/`none`/`trusted-proxy` (`:34-37`);
- the configured value is *not* literally `${OPENCLAW_GATEWAY_TOKEN}` (`:40-46`) — that case is a deliberate "point the config at the env var" pattern, so it's not a conflict.

When all of those hold, it returns a structured `GatewayAuthTokenSourceConflict` with a title, detail, remediation and warning lines. The detail (`:58-61`) is the actual reason the check exists:

> "Direct local Gateway clients commonly prefer the env token, while the managed gateway service prefers gateway.auth.token. If the values differ, CLI/RPC calls can fail to authenticate with the running gateway."

That is the bug class this whole module is named after.

### 14.2.7 Auth install policy

`shouldRequireGatewayTokenForInstall` (`src/gateway/auth-install-policy.ts:35-55`) is the inverse question, used during `openclaw onboard` and service-install paths: *should we generate/require a token before installing the gateway as a long-running service?* It returns `true` (i.e., require a token) by default. The logic is short and worth reading whole:

```ts
// src/gateway/auth-install-policy.ts:35
export function shouldRequireGatewayTokenForInstall(cfg, env) {
  const explicitModeDecision = hasExplicitGatewayInstallAuthMode(cfg.gateway?.auth?.mode);
  if (explicitModeDecision !== undefined) {
    return explicitModeDecision;
  }
  if (hasConfiguredGatewayPasswordForInstall(cfg)) {
    return false;
  }
  if (hasDurableGatewayPasswordEnvForInstall(cfg, env)) {
    return false;
  }
  return true;
}
```

The comment at `:48-49` is the load-bearing bit: only *durable* password env sources (from `~/.openclaw/.env` or launchctl env, not the invoking shell) count, because the installed service won't see the shell that ran `openclaw onboard`.

---

## 14.3 Ring 1 — Auth modes in practice

The four modes from §14.2.2 are not theoretical. Here's how each one is meant to be deployed.

**`mode: "none"`.** Only safe when the gateway is bound to loopback or a private network you fully control (e.g., a container's internal network with no external port mapping). Used by the in-process gateway path when the CLI and gateway are the same Node.js process. There is no rate limiter and no header inspection; anyone who can open a socket is in.

**`mode: "token"`.** The default. The operator (or a generated startup token) holds a long-random bearer. The client passes it in:
- the WebSocket `connectAuth.token` payload (CLI, Control UI),
- the HTTP `Authorization: Bearer …` header (OpenAI-compatible endpoints),
- or as a hash fragment in the Control UI URL (the wizard prints `…/#token=…` for one-click open).

`SECURITY.md:129-133` is explicit that for the shared-secret HTTP path the requests are *granted the full default operator scope set* — there is no narrower `operator.write`-only token. The same trust-model logic from §14.1 applies: anyone holding the shared secret is the operator.

**`mode: "password"`.** Functionally identical to `token` at the wire level (same `safeEqualSecret` check), but ships through the Control UI's password prompt — designed for the case where the operator opens the UI in a fresh browser and types a value they remember. The Control UI dashboard token note (`src/wizard/setup.finalize.ts:455-463`) calls this out.

**`mode: "trusted-proxy"`.** The gateway runs behind a reverse proxy (e.g., Caddy, nginx, Tailscale Serve, oauth2-proxy) that handles authentication and injects an identity header. The config (`GatewayTrustedProxyConfig`) declares `userHeader`, optional `requiredHeaders`, optional `allowUsers`, and `allowLoopback`. The gateway:

- only accepts requests whose remote socket address is in `trustedProxies`;
- by default *rejects* loopback (because a local user can spoof the header), unless `allowLoopback: true`;
- rejects requests whose remote address resolves to a local interface (defence against tunnelled requests).

If you read `src/gateway/auth.ts:454-502` carefully you'll notice it never *cracks open* the user identity — it just lets the request through and stamps `method: "trusted-proxy"` with the upstream's user string. The upstream is the trust anchor; the gateway's job is only to confirm "you really did come from that upstream".

---

## 14.4 Ring 2 — Brute-force rate limiting

`src/gateway/auth-rate-limit.ts` is a pure-in-memory sliding-window limiter, keyed by `{scope, clientIp}`. It exists for one purpose: stop a misconfigured public gateway from being trivially brute-forced.

Defaults (`src/gateway/auth-rate-limit.ts:79-82`):

```ts
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_WINDOW_MS = 60_000;   // 1 minute
const DEFAULT_LOCKOUT_MS = 300_000; // 5 minutes
const PRUNE_INTERVAL_MS = 60_000;
```

Three design choices are worth calling out:

**Loopback is exempt by default** (`src/gateway/auth-rate-limit.ts:135-137,33`). If the operator typo-tested their token ten times locally we don't want their next `openclaw chat` to be locked out for five minutes. Setting `exemptLoopback: false` is reserved for the browser-origin variant (see below).

**Scopes give the same limiter multiple counters.** `src/gateway/auth-rate-limit.ts:38-42` declares `AUTH_RATE_LIMIT_SCOPE_DEFAULT`, `_SHARED_SECRET`, `_DEVICE_TOKEN`, `_HOOK_AUTH`. The shared-secret WebSocket handshake increments the `shared-secret` counter; the per-device pairing flow increments `device-token`; an inbound webhook with a bad signature increments `hook-auth`. One bad webhook secret never locks out an operator's legitimate device-token login. Scope strings are concatenated into the key with `${scope}:${ip}` (`src/gateway/auth-rate-limit.ts:132`).

**Missing credentials don't burn a slot** — a *wrong* credential does. `src/gateway/auth.ts:364-369` is explicit:

```ts
if (!params.connectToken) {
  // Don't burn rate-limit slots for missing credentials — the client
  // simply hasn't provided a token yet (e.g. bare browser open).
  // Only actual *wrong* credentials should count as failures.
  return { ok: false, reason: "token_missing" };
}
if (!safeEqualSecret(params.connectToken, params.authToken)) {
  params.limiter?.recordFailure(params.ip, params.rateLimitScope);
  return { ok: false, reason: "token_mismatch" };
}
```

That's a real-world calibration choice: someone hitting `https://gateway.local/` in a browser with no credentials at all shouldn't lock themselves out — they didn't *try* a wrong value. Only wrong values count as attempts.

`src/gateway/server.impl.ts:438-451` also creates a second, stricter limiter for browser-origin attempts (`exemptLoopback: false`). Why? Because the loopback exemption logic uses the client-IP, but a malicious in-browser script *on a local page* can still send WS handshakes through loopback. The browser-origin path uses a different key prefix (`browser-origin:`, `src/gateway/auth-rate-limit.ts:42`) and refuses to be loopback-exempt.

---

## 14.5 Ring 3 — Scope-based permissions

### 14.5.1 The six operator scopes

`src/gateway/operator-scopes.ts:1-14` defines exactly six scopes:

```ts
// src/gateway/operator-scopes.ts:1
export const ADMIN_SCOPE = "operator.admin" as const;
export const READ_SCOPE = "operator.read" as const;
export const WRITE_SCOPE = "operator.write" as const;
export const APPROVALS_SCOPE = "operator.approvals" as const;
export const PAIRING_SCOPE = "operator.pairing" as const;
export const TALK_SECRETS_SCOPE = "operator.talk.secrets" as const;
```

`ADMIN_SCOPE` is a meta-scope: holding it implies every other scope. `READ_SCOPE` is included by `WRITE_SCOPE` (write implies read, see `src/gateway/method-scopes.ts:177-180`). The other three (`APPROVALS_SCOPE`, `PAIRING_SCOPE`, `TALK_SECRETS_SCOPE`) are *independent* — a caller can have `operator.write` and still be rejected for `plugins.pair.*` if they don't also hold `operator.pairing`.

### 14.5.2 How a method declares its required scope

`src/gateway/method-scopes.ts:39-53` is the resolver:

```ts
function resolveScopedMethod(method: string): OperatorScope | undefined {
  const explicitScope = resolveCoreOperatorGatewayMethodScope(method);
  if (explicitScope) {
    return explicitScope;
  }
  const reservedScope = resolveReservedGatewayMethodScope(method);
  if (reservedScope) {
    return reservedScope;
  }
  const pluginDescriptor = getPluginRegistryState()?.activeRegistry?.gatewayMethodDescriptors?.find(
    (descriptor) => descriptor.name === method,
  );
  const pluginScope = pluginDescriptor?.scope;
  return pluginScope === "node" || pluginScope === "dynamic" ? undefined : pluginScope;
}
```

There are three sources of declarations, in priority order:

1. **Core descriptors.** `src/gateway/methods/core-descriptors.ts` (referenced via `resolveCoreOperatorGatewayMethodScope` at `src/gateway/method-scopes.ts:7`) is a static table of every built-in gateway method and its scope. So `chat.send` requires `operator.write`, `sessions.list` requires `operator.read`, `plugins.pair.*` requires `operator.pairing`, etc.
2. **Reserved policy.** `resolveReservedGatewayMethodScope` (`src/shared/gateway-method-policy.ts`, imported at `src/gateway/method-scopes.ts:2`) handles namespace conventions like `*.pair` → `operator.pairing`. This is what lets newly added pairing-like methods Just Work without amending core-descriptors.
3. **Plugin-declared.** Plugins that ship RPC methods can declare a scope on the method descriptor (`src/gateway/method-scopes.ts:48-52`). Unrecognised plugin scopes (`"node"`, `"dynamic"`) fall through and trigger the dynamic policy at `src/gateway/method-scopes.ts:125-133`.

### 14.5.3 Enforcement

`authorizeOperatorScopesForMethod` (`src/gateway/method-scopes.ts:150-186`) is what the request handlers actually call:

```ts
// src/gateway/method-scopes.ts:150
export function authorizeOperatorScopesForMethod(method, scopes, params) {
  if (scopes.includes(ADMIN_SCOPE)) {
    return { allowed: true };
  }
  if (isDynamicOperatorGatewayMethod(method)) {
    // ... least-privilege resolution for dynamic plugin actions ...
  }
  const requiredScope = resolveRequiredOperatorScopeForMethod(method) ?? ADMIN_SCOPE;
  if (requiredScope === READ_SCOPE) {
    if (scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE)) {
      return { allowed: true };
    }
    return { allowed: false, missingScope: READ_SCOPE };
  }
  if (scopes.includes(requiredScope)) {
    return { allowed: true };
  }
  return { allowed: false, missingScope: requiredScope };
}
```

Three pieces of policy are encoded here:

- **`operator.admin` is a master key.** This is the trust-model assumption made concrete: shared-secret-authenticated requests receive the full default operator scope set including `admin`, so they pass every gate.
- **Default-deny on unclassified methods.** `resolveLeastPrivilegeOperatorScopesForMethod` (`src/gateway/method-scopes.ts:135-148`) returns `[]` if a method has no declared scope and isn't a dynamic plugin action. That means a method nobody declared is callable *only* by callers with `operator.admin` (because of the master-key rule above) — never by a narrower `operator.write` caller. New core methods have to opt in to a scope explicitly.
- **`READ_SCOPE` is a subset of `WRITE_SCOPE`.** This is the only built-in scope subsumption; everything else is independent.

<svg viewBox="0 0 760 440" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Scope enforcement architecture: an RPC request flows through auth resolution, then method-scope lookup, then authorize check; an admin scope is a master key, write implies read, and unclassified methods default-deny.">
<defs>
<marker id="g14b-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="40" y="20" width="160" height="46" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
<text x="120" y="40" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">RPC request</text>
<text x="120" y="56" text-anchor="middle" font-size="10" fill="#64748b">method = "sessions.delete"</text>
<line x1="200" y1="42" x2="232" y2="42" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14b-arr)"/>
<rect x="232" y="20" width="180" height="46" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="322" y="40" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">Gateway middleware</text>
<text x="322" y="56" text-anchor="middle" font-size="10" fill="#64748b">authorizeGatewayConnect → ok</text>
<line x1="412" y1="42" x2="444" y2="42" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14b-arr)"/>
<rect x="444" y="20" width="200" height="46" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="544" y="40" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">caller scopes</text>
<text x="544" y="56" text-anchor="middle" font-size="10" fill="#64748b">[operator.write, operator.read]</text>
<line x1="544" y1="66" x2="544" y2="98" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14b-arr)"/>
<rect x="200" y="100" width="380" height="58" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
<text x="390" y="120" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">authorizeOperatorScopesForMethod (method-scopes.ts:150)</text>
<text x="390" y="138" text-anchor="middle" font-size="10" fill="#64748b">1. ADMIN_SCOPE master-key check</text>
<text x="390" y="152" text-anchor="middle" font-size="10" fill="#64748b">2. dynamic plugin action? → resolveSessionActionLeastPrivilegeScopes</text>
<line x1="390" y1="158" x2="390" y2="178" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14b-arr)"/>
<rect x="180" y="180" width="420" height="74" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
<text x="390" y="200" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">resolveScopedMethod (method-scopes.ts:39)</text>
<text x="390" y="218" text-anchor="middle" font-size="10" fill="#64748b">core-descriptors → reserved policy → plugin descriptor</text>
<text x="390" y="232" text-anchor="middle" font-size="10" fill="#64748b">returns: operator.read | write | approvals | pairing | talk.secrets</text>
<text x="390" y="246" text-anchor="middle" font-size="10" fill="#64748b">unclassified → undefined → defaults to operator.admin</text>
<line x1="390" y1="254" x2="390" y2="276" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14b-arr)"/>
<rect x="220" y="278" width="340" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="390" y="299" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">required scope: operator.write</text>
<line x1="200" y1="312" x2="200" y2="332" stroke="#94a3b8" stroke-width="1.2"/>
<line x1="580" y1="312" x2="580" y2="332" stroke="#94a3b8" stroke-width="1.2"/>
<line x1="200" y1="332" x2="220" y2="332" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14b-arr)"/>
<line x1="580" y1="332" x2="560" y2="332" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14b-arr)"/>
<rect x="60" y="320" width="160" height="46" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
<text x="140" y="340" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">scopes include required</text>
<text x="140" y="356" text-anchor="middle" font-size="10" fill="#64748b">→ { allowed: true }</text>
<rect x="560" y="320" width="160" height="46" rx="6" fill="#f1f5f9" stroke="#dc2626" stroke-width="1.5"/>
<text x="640" y="340" text-anchor="middle" font-size="11" font-weight="700" fill="#dc2626">missing scope</text>
<text x="640" y="356" text-anchor="middle" font-size="10" fill="#64748b">→ allowed=false</text>
<line x1="140" y1="366" x2="140" y2="386" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14b-arr)"/>
<line x1="640" y1="366" x2="640" y2="386" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14b-arr)"/>
<rect x="60" y="388" width="160" height="38" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
<text x="140" y="412" text-anchor="middle" font-size="11" fill="currentColor">handler runs</text>
<rect x="560" y="388" width="160" height="38" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
<text x="640" y="412" text-anchor="middle" font-size="11" fill="currentColor">RPC error returned</text>
</svg>
<span class="figure-caption">Figure R14.2 | Scope enforcement: middleware → caller scopes → method-scope lookup → allow/deny.</span>

<details><summary>ASCII original</summary>
```
RPC request -> Gateway middleware -> caller scopes
                                          |
                                          v
                authorizeOperatorScopesForMethod (method-scopes.ts:150)
                          1. admin master-key
                          2. dynamic plugin action least-privilege
                                          |
                                          v
                resolveScopedMethod (core -> reserved -> plugin)
                          returns required scope (or admin-default)
                                          |
                  +-----------------------+------------------------+
                  v                                                v
        scopes include required                       missing scope
                  |                                                |
                  v                                                v
            handler runs                                RPC error returned
```
</details>

### 14.5.4 Where the caller's scopes come from

Different surfaces produce different scope sets:

- **Shared-secret HTTP (`Authorization: Bearer <token>` on `/v1/*` or `/tools/invoke`)** — receives the full default operator scope set, including `admin` (`SECURITY.md:130-134`). Narrower `x-openclaw-scopes` headers are *ignored* for this path — see `SECURITY.md:131-134`.
- **WebSocket from a CLI/Control UI** — declares scopes in the connect payload (`src/gateway/server-request-context.ts:73`), defaulting to `CLI_DEFAULT_OPERATOR_SCOPES` (`src/gateway/method-scopes.ts:30-37`) which is also the full set.
- **Trusted-proxy identity path** — `gateway.auth.mode="none"` with an upstream identity header *does* honour declared scopes (`SECURITY.md:134-135`), because the upstream is asserting a per-request identity, not a possession-of-secret.
- **Device-paired tokens** — narrower; see §14.6.

---

## 14.6 Ring 4 — Channel pairing

### 14.6.1 The problem

The Gateway is fine for in-process and HTTP callers, but how does a *third-party chat app* (Slack DM, Telegram bot, WhatsApp number) bootstrap trust? Two halves:

1. A new device — phone running the OpenClaw mobile app — needs the Gateway URL and a bearer to call the Gateway WS API. This is the *setup-code* / device pairing flow.
2. A new chat *user* — someone messaging your Slack bot — needs to be approved by the operator before the bot answers them. This is the *pairing-code* / allowlist flow.

Both live under `src/pairing/`, but they're different mechanisms.

### 14.6.2 Device setup-code

`resolvePairingSetupFromConfig` (`src/pairing/setup-code.ts:361-413`) builds the payload that the desktop wizard turns into a QR code for the mobile app to scan. The payload is small:

```ts
// src/pairing/setup-code.ts:28
export type PairingSetupPayload = {
  url: string;
  bootstrapToken: string;
};
```

The flow:

1. Resolve the *URL* the mobile app should connect to. `resolveGatewayUrl` (`src/pairing/setup-code.ts:292-353`) picks: explicit `publicUrl` config → `gateway.remote.url` → Tailscale Serve/Funnel MagicDNS → finally `resolveGatewayBindUrl` (LAN-bind or tailnet-bind). If none of those produce a routable URL it errors with "Gateway is only bound to loopback".
2. Validate the URL is safe for mobile pairing. `validateMobilePairingUrl` (`src/pairing/setup-code.ts:135-151`) rejects cleartext `ws://` for any host except localhost, RFC1918, `.local`, link-local, and the Android emulator gateway `10.0.2.2`. Public-network mobile pairing must be `wss://`.
3. Resolve the *auth label* (`resolvePairingSetupAuthLabel`, `src/pairing/setup-code.ts:249-290`) so the mobile app knows whether it should send the user's value as a token or as a password.
4. Mint a one-shot **bootstrap token** via `issueDeviceBootstrapToken` (called at `src/pairing/setup-code.ts:404`). The bootstrap token is rate-limited under the `device-token` scope (see §14.4) and is *not* the shared gateway token — it's a per-pairing credential the mobile app exchanges, on first connect, for its long-term device identity.
5. Encode the payload as base64url (`encodePairingSetupCode`, `src/pairing/setup-code.ts:355-359`) for the QR.

The payload deliberately does *not* include the Gateway's shared secret. Even if the QR is photographed by a passer-by, an attacker only gets a one-shot bootstrap token bound to an outbound URL — they don't get the operator's long-term gateway credential.

### 14.6.3 Channel pairing-code

When a chat user sends a DM to your Telegram bot and they're not in the allowlist, the bot answers with a pairing challenge. The shared core is `issuePairingChallenge` in `src/pairing/pairing-challenge.ts:24-48`:

```ts
// src/pairing/pairing-challenge.ts:24
export async function issuePairingChallenge(params) {
  const { code, created } = await params.upsertPairingRequest({
    id: params.senderId,
    meta: params.meta,
  });
  if (!created) {
    return { created: false };
  }
  params.onCreated?.({ code });
  const replyText =
    params.buildReplyText?.({ code, senderIdLine: params.senderIdLine }) ??
    buildPairingReply({ channel: params.channel, idLine: params.senderIdLine, code });
  try {
    await params.sendPairingReply(replyText);
  } catch (err) {
    params.onReplyError?.(err);
  }
  return { created: true, code };
}
```

`buildPairingReply` (`src/pairing/pairing-messages.ts:4-26`) renders the message the user sees, which contains a code and a CLI line such as `openclaw pairing approve telegram ABCD2345`. The pairing store (`src/pairing/pairing-store.ts`) persists pending requests to a per-channel JSON file (`src/pairing/pairing-store.ts:65-67`); pending requests TTL out after one hour (`PAIRING_PENDING_TTL_MS`, `src/pairing/pairing-store.ts:34`) and there's a hard cap of three pending requests per identity (`PAIRING_PENDING_MAX`, `:35`). When the operator runs `openclaw pairing approve <channel> <code>`, the sender ID is appended to the channel's `allowFrom` list — that's the actual permission, not the code.

This is "ask before answering strangers" implemented as a TOFU (trust-on-first-use) flow gated by the operator's CLI. The pairing code is *not* a credential — it only identifies which pending request to approve.

---

## 14.7 Ring 5 — Secret storage

### 14.7.1 Three sources, one shape

`SecretRef` (`src/config/types.secrets.ts:12-16`) is the unified handle:

```ts
// src/config/types.secrets.ts:12
export type SecretRef = {
  source: SecretRefSource;  // "env" | "file" | "exec"
  provider: string;
  id: string;
};
```

Anywhere in `openclaw.json` that accepts a secret can accept either a literal string *or* a `SecretRef`. The three sources cover the three realistic stores:

- **`env`** — read from a process environment variable. The `id` is the variable name (`OPENAI_API_KEY`, `OPENCLAW_GATEWAY_TOKEN`, etc.), constrained by `ENV_SECRET_REF_ID_RE` at `src/config/types.secrets.ts:20`. The `provider` is a logical namespace (`"default"` is fine; advanced setups use multiple providers for layered .env files).
- **`file`** — read from a JSON file. The `id` is a JSON-pointer into the file (`/providers/openai/apiKey`). The provider config (in `secrets.providers`) declares the path. This is the route for mounted-secret deployments — Kubernetes `Secret` mounted as a JSON volume, etc.
- **`exec`** — shell out to a command. The `id` is whatever the provider command understands (`openai/api-key` for a `vault read`-style provider). Use cases: 1Password CLI, Bitwarden CLI, gopass.

The resolver lives in `src/secrets/resolve.ts`. The function `resolveSecretRefValue` (defined earlier in the file, exported at `:25`) is the workhorse; it routes by `source` to a provider-specific resolver. `src/secrets/resolve.ts:55-92` defines two error types — `SecretProviderResolutionError` (the provider itself failed; e.g., `vault` couldn't reach the server) and `SecretRefResolutionError` (the provider is healthy but the ref doesn't exist). These are different problem classes; the audit code in `src/secrets/audit.ts` distinguishes them.

### 14.7.2 Where credentials actually live on disk

There's no single "credentials.json". There are four physical stores:

1. **`openclaw.json`** — the main config. Holds *references* (`SecretRef`s) and any plain-text secrets the operator explicitly chose to embed.
2. **`<stateDir>/agents/<agentId>/agent/auth-profiles.json`** — the **auth profile store** (`src/secrets/auth-store-paths.ts:12,32`). Holds OAuth tokens, refresh tokens, and external-CLI auth blobs (e.g., your Claude/Codex CLI sessions imported via `sync-external-cli`).
3. **Per-channel pairing state** — `<stateDir>/pairing/<channel>-pairing.json` and `<stateDir>/pairing/allow-from-<channel>.json`. Allowlists and pending pairing requests (see §14.6).
4. **External provider state** — whatever your secret-provider plugin points at: env files, mounted JSON, an external `vault` daemon.

The auth-profile store is by far the most security-sensitive, because it contains *live OAuth refresh tokens*. `src/agents/auth-profiles/store.ts` uses a file lock per-path (`acquireAuthStoreLockSync`, called at `:321`) and atomic writes. It also exposes a *read-only mode* via `OPENCLAW_AUTH_STORE_READONLY=1` (`:301, :527`), which we use next.

### 14.7.3 The v2026.5.22 `secrets audit` read-only path

A bad pattern in older releases: running `openclaw secrets audit` could itself trigger an external-CLI sync that touched the auth-profile store (because the audit walks the store and the load path tries to mirror external CLI state on its way in). For a *read-only audit*, that's a foot-gun: running the diagnostic mutates the thing being diagnosed.

The v2026.5.22 fix is `shouldForceReadOnlyAuthStore` at `src/entry.ts:29-37`:

```ts
// src/entry.ts:29
function shouldForceReadOnlyAuthStore(argv: string[]): boolean {
  const tokens = argv.slice(2).filter((token) => token.length > 0 && !token.startsWith("-"));
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "secrets" && tokens[index + 1] === "audit") {
      return true;
    }
  }
  return false;
}
```

The check runs at the entry point, before any subcommand modules are imported. If the argv contains the subcommand sequence `secrets audit`, the entry sets `OPENCLAW_AUTH_STORE_READONLY=1` *before* anything reads the store:

```ts
// src/entry.ts:104
if (shouldForceReadOnlyAuthStore(process.argv)) {
  process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
}
```

Downstream, both the external-CLI sync path (`src/agents/auth-profiles/store.ts:299-303`) and the legacy migration path (`src/agents/auth-profiles/store.ts:527-528`) check this env var and refuse to write. Result: `openclaw secrets audit` is *guaranteed* to be a read-only operation against the auth store. The entry-level argv parse is deliberate — it avoids relying on the actual `commander` subcommand resolution, which would already have side-effects loaded by the time it ran.

### 14.7.4 `openclaw secrets audit` itself

`src/cli/secrets-cli.ts:97-147` registers the CLI. The audit runner is `runSecretsAudit` (lazily imported from `src/secrets/audit.ts:109`). The report has four finding codes (`src/secrets/audit.ts:41-45`):

```ts
export type SecretsAuditCode =
  | "PLAINTEXT_FOUND"     // a value that looks like a real secret sits in plain text
  | "REF_UNRESOLVED"      // a SecretRef points at something we can't resolve right now
  | "REF_SHADOWED"        // two SecretRefs would resolve to different values
  | "LEGACY_RESIDUE";     // older legacy markers still in the file
```

`exec` SecretRefs are *not* run by default — they require `--allow-exec` (`src/cli/secrets-cli.ts:100-104`). The rationale is "an audit shouldn't shell out to your password manager" — that would defeat the entire "this is read-only diagnostic" promise.

<svg viewBox="0 0 760 470" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Secret storage architecture: openclaw.json holds SecretRef pointers, the resolver dispatches to env, file or exec providers, and the auth-profile store on disk holds live OAuth tokens with a read-only override during secrets audit.">
<defs>
<marker id="g14c-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="40" y="20" width="200" height="60" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="140" y="40" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">openclaw.json</text>
<text x="140" y="56" text-anchor="middle" font-size="10" fill="#64748b">SecretInput = string | SecretRef</text>
<text x="140" y="70" text-anchor="middle" font-size="10" fill="#64748b">{source, provider, id}</text>
<line x1="240" y1="50" x2="272" y2="50" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14c-arr)"/>
<rect x="272" y="20" width="200" height="60" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
<text x="372" y="40" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">resolveSecretRefValue</text>
<text x="372" y="56" text-anchor="middle" font-size="10" fill="#64748b">src/secrets/resolve.ts</text>
<text x="372" y="70" text-anchor="middle" font-size="10" fill="#64748b">dispatch by source</text>
<line x1="372" y1="80" x2="372" y2="108" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14c-arr)"/>
<rect x="40" y="112" width="200" height="84" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
<text x="140" y="132" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">source: env</text>
<text x="140" y="148" text-anchor="middle" font-size="9" fill="#64748b">process.env[id]</text>
<text x="140" y="162" text-anchor="middle" font-size="9" fill="#64748b">id = ENV_SECRET_REF_ID_RE</text>
<text x="140" y="178" text-anchor="middle" font-size="9" fill="#64748b">.env files,</text>
<text x="140" y="190" text-anchor="middle" font-size="9" fill="#64748b">launchctl/systemd env</text>
<rect x="270" y="112" width="200" height="84" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
<text x="370" y="132" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">source: file</text>
<text x="370" y="148" text-anchor="middle" font-size="9" fill="#64748b">read provider path,</text>
<text x="370" y="162" text-anchor="middle" font-size="9" fill="#64748b">id = JSON pointer</text>
<text x="370" y="178" text-anchor="middle" font-size="9" fill="#64748b">mounted-json,</text>
<text x="370" y="190" text-anchor="middle" font-size="9" fill="#64748b">k8s secret volumes</text>
<rect x="500" y="112" width="200" height="84" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
<text x="600" y="132" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">source: exec</text>
<text x="600" y="148" text-anchor="middle" font-size="9" fill="#64748b">spawn provider cmd</text>
<text x="600" y="162" text-anchor="middle" font-size="9" fill="#64748b">id = provider-defined</text>
<text x="600" y="178" text-anchor="middle" font-size="9" fill="#64748b">1Password / Bitwarden /</text>
<text x="600" y="190" text-anchor="middle" font-size="9" fill="#64748b">vault / gopass</text>
<line x1="140" y1="196" x2="140" y2="218" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14c-arr)"/>
<line x1="370" y1="196" x2="370" y2="218" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14c-arr)"/>
<line x1="600" y1="196" x2="600" y2="218" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#g14c-arr)"/>
<rect x="220" y="220" width="300" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="370" y="240" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">resolved string (never logged)</text>
<text x="370" y="254" text-anchor="middle" font-size="10" fill="#64748b">injected into provider client / gateway auth</text>
<line x1="370" y1="260" x2="370" y2="284" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
<rect x="40" y="290" width="320" height="74" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
<text x="200" y="310" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">auth-profile store (on disk)</text>
<text x="200" y="326" text-anchor="middle" font-size="9" fill="#64748b">&lt;stateDir&gt;/agents/&lt;agentId&gt;/agent/</text>
<text x="200" y="340" text-anchor="middle" font-size="9" fill="#64748b">auth-profiles.json</text>
<text x="200" y="356" text-anchor="middle" font-size="9" fill="#64748b">OAuth refresh tokens, external-CLI sessions</text>
<rect x="380" y="290" width="320" height="74" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="540" y="310" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">read-only override</text>
<text x="540" y="326" text-anchor="middle" font-size="9" fill="#64748b">OPENCLAW_AUTH_STORE_READONLY=1</text>
<text x="540" y="340" text-anchor="middle" font-size="9" fill="#64748b">set by entry.ts:104 when argv = "secrets audit"</text>
<text x="540" y="356" text-anchor="middle" font-size="9" fill="#64748b">store.ts:301,527 honour the flag</text>
<rect x="40" y="384" width="660" height="76" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
<text x="370" y="404" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">openclaw secrets audit (src/cli/secrets-cli.ts:97)</text>
<text x="370" y="420" text-anchor="middle" font-size="10" fill="#64748b">scans for PLAINTEXT_FOUND, REF_UNRESOLVED, REF_SHADOWED, LEGACY_RESIDUE</text>
<text x="370" y="434" text-anchor="middle" font-size="10" fill="#64748b">--allow-exec to actually run exec providers; without it, exec refs are reported as skipped</text>
<text x="370" y="448" text-anchor="middle" font-size="10" fill="#64748b">v2026.5.22: guaranteed read-only against auth-profile store</text>
</svg>
<span class="figure-caption">Figure R14.3 | Secret storage architecture: SecretRef pointers, three-source resolution, and the auth-profile store with the v2026.5.22 read-only override.</span>

<details><summary>ASCII original</summary>
```
openclaw.json (SecretInput = string | SecretRef)
        |
        v
resolveSecretRefValue (src/secrets/resolve.ts)
        |
   +----+----+--------+--------+
   v         v        v
 env       file      exec
 process.  read      spawn
 env       json      provider
 (id)      (ptr)     command
   |         |        |
   +----+----+--------+
        v
   resolved string (never logged)

auth-profile store on disk: <stateDir>/agents/<agentId>/agent/auth-profiles.json
v2026.5.22: OPENCLAW_AUTH_STORE_READONLY=1 set at entry.ts:104 when argv = "secrets audit"
            store.ts:301,527 honour the flag
```
</details>

---

## 14.8 Ring 6 — The tool approval gate

Scopes get a caller into a method. Inside the agent runtime, a separate gate covers a different question: *should this specific tool call be allowed to run, even though the caller is the operator?* Long-running, locally-destructive operations — running shell commands, writing arbitrary files, calling `node.invoke` — need an extra human-in-the-loop check.

Chapter 09 covers the full approval flow; the security-relevant takeaways are:

- The exec approval request is two-phase by design (`src/agents/bash-tools.exec-approval-request.ts`) so that an approval can sit pending for hours without blocking an agent process. Approval payloads bind to *exact* command/cwd/env context plus, where OpenClaw can resolve one, a snapshot of the concrete local script/file operand. `SECURITY.md:281-284` is explicit that this is "best-effort integrity hardening, not a complete semantic model of everything a runtime may load."
- The approval card is delivered through `callGatewayTool` and rendered in whichever channel the user is on — so a Slack DM can approve a shell command initiated from Telegram, as long as the operator can answer.
- Differences in command-risk heuristics across exec surfaces (`gateway`, `node`, `sandbox`) are explicitly *not* a security-boundary bypass — they're hardening (`SECURITY.md`, "Detailed False-Positive Patterns").

The `src/terminal/` directory in this repo is the *terminal output rendering* layer (ANSI palettes, OSC progress, table layout), not the shell-exec surface. The actual shell-exec gating sits in the agent runtime and tool descriptors; see `src/tools/` and the `bash-tools.exec-approval-*.ts` family.

---

## 14.9 Ring 7 — Plugin trust

`SECURITY.md:241-248` is plain-spoken:

> Plugins/extensions are loaded **in-process** with the Gateway and are treated as trusted code.
> - Plugins can execute with the same OS privileges as the OpenClaw process.
> - Runtime helpers (for example `runtime.system.runCommandWithTimeout`) are convenience APIs, not a sandbox boundary.
> - Only install plugins you trust, and prefer `plugins.allow` to pin explicit trusted plugin ids.

OpenClaw does *not* sandbox plugins. There is no V8 isolate, no separate process, no permission prompt before a plugin reads your filesystem. The codebase makes that contract explicit instead of pretending otherwise, and then layers two defensive checks on top:

- `collectPluginsTrustFindings` (`src/security/audit-plugins-trust.ts:277-280`) flags two patterns when `openclaw doctor` runs:
  - **Phantom allowlist entries.** `plugins.allow` contains a plugin id that doesn't correspond to any installed plugin (`audit-plugins-trust.ts:310-321`). The audit detail explains the threat: *"Phantom entries could be exploited by registering a new plugin with an allowlisted ID."* Without this check, a typo in `plugins.allow` would be a quietly-pre-approved drop-zone for a future malicious plugin.
  - **Extensions installed but `plugins.allow` unset.** When the extensions directory has plugins but `plugins.allow` isn't set, `audit-plugins-trust.ts:354-364` raises a warning: *"Without plugins.allow, any discovered plugin id may load."* The remediation is "Set plugins.allow to an explicit list of plugin ids you trust."

So the trust boundary is in *which plugins exist*, not in *what they can do*. Pin the list of plugin ids you trust; treat the extensions directory like any other code-execution path.

---

## 14.10 Ring 8 — Self-diagnosis: Crestodian, audit, dangerous flags

### 14.10.1 Crestodian — the "guard" assistant

`src/crestodian/` is the codebase's name for its ring-zero setup-and-repair helper. The CLI subcommand is `openclaw crestodian` (`src/cli/program/register.crestodian.ts:8-12`); its self-description is "Open the ring-zero setup and repair helper". The interactive surface (`src/crestodian/crestodian.ts:62-117`) loads a `CrestodianOverview` and either dumps it as JSON, runs a one-shot question, or drops into an interactive TTY backend.

The overview struct (`src/crestodian/overview.ts:30-61`) is the operator's "is my install OK?" picture:

```ts
export type CrestodianOverview = {
  config: { path, exists, valid, issues, hash };
  agents: CrestodianAgentSummary[];
  defaultAgentId: string;
  defaultModel?: string;
  tools: {
    codex: LocalCommandProbe;
    claude: LocalCommandProbe;
    apiKeys: { openai: boolean; anthropic: boolean };
  };
  gateway: { url, source, reachable, error? };
  references: { docsPath?, docsUrl, sourcePath?, sourceUrl };
};
```

Crestodian is deliberately a *separate* assistant from the user-facing agents. It exists so that "my agent isn't working" support questions can be answered without the broken thing being the diagnostic itself — the overview is gathered by static probes, not by routing through the same agent stack that may be misconfigured.

The persistent operations (`src/crestodian/operations.ts`) that *would* mutate config require explicit `--yes` (`src/cli/program/register.crestodian.ts:13`). This is the same "destructive operations need a confirmation flag" pattern as `secrets configure --apply`.

### 14.10.2 Dangerous config flags

`src/security/dangerous-config-flags.ts` and `core-dangerous-config-flags.ts` enumerate config keys that, when enabled, weaken a documented default — e.g. `hooks.gmail.allowUnsafeExternalContent`, `channels.telegram.network.dangerouslyAllowPrivateNetwork`, the various `dangerouslyAllow*` options on individual channels. `logGatewayStartup` (`src/gateway/server-startup-log.ts:63-69`) calls `collectEnabledInsecureOrDangerousFlags` and emits a `security warning: dangerous config flags enabled: …` line whenever any are on, with `Run \`openclaw security audit\`` as the remediation.

`SECURITY.md:298-300` describes the contract:

> Any report whose only claim is that an operator-enabled `dangerous*`/`dangerously*` config option weakens defaults … these are explicit break-glass tradeoffs by design.

That answers a natural question — "why aren't these vulnerabilities?" The codebase prefers honest, opt-in escape hatches with shouty warnings to making the safe path slightly less safe by default.

### 14.10.3 Audit logging of control-plane writes

There's no separate "audit log" file — instead, all control-plane writes log through the structured logger with a stable actor format. `src/gateway/control-plane-audit.ts:18-29` is the small helper:

```ts
// src/gateway/control-plane-audit.ts:18
export function resolveControlPlaneActor(client: GatewayClient | null): ControlPlaneActor {
  return {
    actor: normalizePart(client?.connect?.client?.id, "unknown-actor"),
    deviceId: normalizePart(client?.connect?.device?.id, "unknown-device"),
    clientIp: normalizePart(client?.clientIp, "unknown-ip"),
    connId: normalizePart(client?.connId, "unknown-conn"),
  };
}
export function formatControlPlaneActor(actor: ControlPlaneActor): string {
  return `actor=${actor.actor} device=${actor.deviceId} ip=${actor.clientIp} conn=${actor.connId}`;
}
```

That `formatControlPlaneActor` string is appended to every control-plane mutation log line. Real uses include `src/gateway/server-methods.ts:207` (rate-limited writes), `src/gateway/server-methods/config.ts:496,563` (config patches/applies), `src/gateway/server-methods/update.ts:163,249,253` (managed updates). Searching the logs for `actor=…` gives a chronological audit trail.

The `summarizeChangedPaths` helper (`src/gateway/control-plane-audit.ts:31-40`) trims paths lists to a max of 8 with a `+N more` suffix so the log line stays grep-friendly without overflowing.

---

## 14.11 Cross-cutting: the gateway lock

A separate kind of "security" issue — preventing two gateway processes from racing on the same state directory — is handled by the gateway lock (`src/infra/gateway-lock.ts`). The lock file `gateway.lock` lives under `resolveGatewayLockDir(...)` and contains:

```ts
// src/infra/gateway-lock.ts:18
type LockPayload = {
  pid: number;
  createdAt: string;
  configPath: string;
  startTime?: number;
};
```

`acquireGatewayLock` (referenced from `src/infra/gateway-lock.test.ts:11`) acquires it before starting the listener. The `pid` is cross-checked with `isPidAlive` (`src/infra/gateway-lock.ts:9`) and the configured port is probed with a quick TCP connect; if either is alive, the second gateway aborts. Stale locks (older than `DEFAULT_STALE_MS = 30_000`) are reclaimed. This is the mechanism that means `openclaw gateway` is safe to invoke from anywhere — it won't silently start a second listener.

---

## 14.12 What you took away

If you only retain three things from this chapter, make them:

1. **One Gateway = one trust domain.** Authenticated callers are operators; OpenClaw deliberately does not pretend to enforce inter-operator isolation on a single gateway. Deploy one gateway per user; the rest of the design follows from that.
2. **Auth is layered, not monolithic.** Connection auth (`src/gateway/auth.ts`) gets you to the door; scope auth (`src/gateway/method-scopes.ts`) decides what you can do once you're in; pairing (`src/pairing/`) is how a new principal becomes a known one; the tool-approval gate is the *human* in the human-in-the-loop.
3. **Output is a security surface.** The v2026.5.22 Docker fix (`75b5c76c7f`) and the entry-point `OPENCLAW_AUTH_STORE_READONLY` toggle (`src/entry.ts:29-37,104`) both fix bugs that look like UX issues — leaky logs, side-effectful diagnostics — but are *credential disclosure* bugs in practice. When you add a new diagnostic or onboarding helper, ask both "does this leak?" and "does this mutate?" before shipping it.
