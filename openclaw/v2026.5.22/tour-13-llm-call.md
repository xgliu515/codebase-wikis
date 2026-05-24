# Tour Step 13: Calling the LLM provider

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

Tour-12 left the attempt holding a fully-formed `(model, context, options)` triple. `model` carries `{ provider: "anthropic", api: "anthropic-messages", id: "claude-opus-4-7", baseUrl }`. `context` carries the system block(s) and a single user message `"hello"`. `options` carries the `apiKey` (resolved from the auth profile), the `signal` for cancellation, and an `onPayload` callback installed by the payload logger. The attempt has invoked `activeSession.agent.streamFn(model, context, options)` and the call has crossed out of core code into the provider plugin layer.

No socket is open yet. No bytes have left the host. This step covers what happens from the call site in `src/agents/pi-embedded-runner/run/attempt.ts:2697` down through the provider-runtime retry wrapper, into the Anthropic extension's stream wrappers, through the `pi-ai` HTTP transport, and out onto the wire — ending the moment the first SSE byte arrives back. By the end the TLS connection is established, the auth header is sent, the request body is on the wire, and the SSE parser is positioned at `event:` of the first message.

## 2. The problem

> One agent runtime must talk to a long and growing list of providers — Anthropic, OpenAI completions and Responses, Azure OpenAI, Bedrock Converse, Vertex, Ollama, LM Studio, Gemini, xAI, and a half-dozen self-hosted shims — each with its own endpoint, request body shape, streaming protocol (SSE vs JSONL vs WebSocket), auth scheme (API key, OAuth, OIDC, cloud SDK), and rate-limit error catalogue. The core must call any of them through a single call site and must transparently retry only the **transient** failures while letting auth errors, validation errors, and model-not-found errors fail loudly.

This is the *worst* shape for a switch statement: provider list grows monthly, each entry is complex, and the retry semantics live one layer **below** the provider specifics. Compounding this, the v2026.5.22 release fixed a footgun (PR #85603) where the empty-response retry guard had not yet been extended to the entire `openai-responses` family, causing reasoning-only turns to slip through as "successful" with no visible content.

## 3. Naive approach

Switch on provider name at the call site:

```ts
switch (model.provider) {
  case "anthropic":
    return callAnthropic(model, context, options);
  case "openai":
    return callOpenAI(model, context, options);
  case "bedrock":
    return callBedrock(model, context, options);
  // ...one more case per provider, forever
}
```

Retry by wrapping each branch in a `for (let i = 0; i < 3; i++)` loop and catch all errors.

## 4. Why the naive approach breaks

**Coupling.** The core file containing the switch grows every time someone adds a provider. Worse, the switch must also know each provider's auth flow, error catalogue, and streaming protocol — so the file grows in two dimensions simultaneously.

**Out-of-tree providers become impossible.** OpenClaw deliberately wants third-party plugins to contribute providers (`openclaw/openclaw-aws-bedrock`, etc.). With a hard-coded switch in core, that becomes a fork.

**Retry semantics duplicate.** Each branch must reimplement "which status codes are transient" and "what is the backoff", and they will drift. The real signal — HTTP 500/502/503/504, `ECONNRESET`, `ETIMEDOUT`, named `TimeoutError`, fetch-failed-with-transient-cause — is the same across providers (`src/provider-runtime/operation-retry.ts:145-171`); only the auth and payload differ.

**Non-retryable errors get retried.** The footgun the v2026.5.22 retry guard fix addresses (#85603) is a sibling concern: certain providers can return a "successful" HTTP response that nevertheless contains **no visible assistant text** (only reasoning tokens), and the empty-response retry must fire on those too. A naive `if (transient) retry` does not catch this case at all.

**API-key validation errors look transient to a naive matcher.** Strings like "invalid api key" or "permission denied" arrive with status codes that vary by provider; a regex-only matcher will either let them through as transient or kill genuine retries. The shared `operation-retry` module curates this list once.

## 5. OpenClaw's approach

OpenClaw's approach is to model the provider as a **plugin behind a unified call interface** and to centralise transient-error retry in a small core module that every provider sits behind.

**The unified interface is `StreamFn`.** The contract type lives in `@earendil-works/pi-agent-core` and is the only signature core ever calls: `streamFn(model, context, options)` returns a stream-like object the runtime can consume. Every provider extension supplies a `StreamFn` (or wraps one) — see Anthropic's `wrapAnthropicProviderStream` at `extensions/anthropic/stream-wrappers.ts:203-222`. That function uses `composeProviderStreamWrappers` from the plugin SDK to layer beta-header injection, service-tier policy, fast-mode policy, and the thinking-prefill cleanup, **without ever knowing the underlying transport**. The chain ends at `streamSimple` from `@earendil-works/pi-ai`, which is what speaks HTTP.

**Plugin registration is declarative.** `extensions/anthropic/index.ts:4-11` calls `definePluginEntry({ id: "anthropic", ..., register })`. The runtime invokes `registerAnthropicPlugin(api)` once at startup; that registers the provider's auth methods, model normalisation, and stream wrapper. Core never imports the extension.

**Retry lives in `src/provider-runtime/operation-retry.ts`.** Stages are typed: `"read" | "poll" | "download" | "create"` (line 4). Default policy for `"create"` (the stream open) is **no** retry — `defaultTransientProviderRetryForStage` returns `undefined` for create (line 51). For other stages, `attempts: 2` (one initial plus one retry) is the default (line 30-34). The transient-error classifier is the single source of truth:

```ts
export function isTransientProviderOperationError(error: unknown, message: string): boolean {
  const status = readErrorStatus(error);
  if (status !== undefined) {
    return status === 500 || status === 502 || status === 503 || status === 504;
  }
  if (
    /\b(?:HTTP\s*)?(?:400|401|403|404)\b/i.test(message) ||
    /\b(?:invalid api key|permission denied|model not found|validation|unsupported model)\b/i.test(message)
  ) {
    return false;
  }
  if (/\b(?:HTTP\s*)?(?:500|502|503|504)\b/i.test(message)) {
    return true;
  }
  if (hasTransientNetworkSignal(error, message)) return true;
  if (hasTimeoutSignal(error, message)) return true;
  if (/\bfetch failed\b/i.test(message)) return hasTransientNetworkSignal(error, message);
  return false;
}
```

The 4xx-as-text guard (`src/provider-runtime/operation-retry.ts:150-157`) is the safety net: even when a provider reports the error as a string message instead of a structured `status`, a 400/401/403/404 is recognised as **non-retryable** and bubbles up immediately. Status 500/502/503/504, the curated transient network codes (`ECONNRESET | ECONNREFUSED | ETIMEDOUT | EAI_AGAIN`), and named `TimeoutError`/`RequestTimeoutError` are the only retry triggers. Backoff is exponential, capped (line 180-195): `baseDelayMs * 2^(attempt-1)`, clamped at `maxDelayMs` (defaults 250ms base, 1000ms cap).

**A separate retry guard, sitting at the visible-turn boundary**, handles the "successful HTTP, empty content" case the transient classifier cannot detect. `RETRY_GUARD_MODEL_APIS` (`src/agents/pi-embedded-runner/run/incomplete-turn.ts:139-148`) lists which model APIs participate: `openai-completions`, `anthropic-messages`, `bedrock-converse-stream`, plus the entire `openai-responses` family (added in PR #85603 to close #85364). For our Anthropic Messages call, this set is mostly defensive — Anthropic rarely produces a reasoning-only turn — but the inclusion is unconditional, so if the model surprises us with `usage.output > 0` and `assistantTexts === []`, the embedded runner will re-issue the call.

**Auth resolution happens inside the wrapper.** The Anthropic wrapper inspects `options.apiKey` at call time (`extensions/anthropic/stream-wrappers.ts:117-127`) to detect Claude CLI OAuth tokens (`sk-ant-oat...`) and silently strips the `context-1m-2025-08-07` beta header for that auth mode — Anthropic rejects the 1M-context beta with non-API-key auth. This is the right shape for the abstraction: auth is the wrapper's job to inspect, not core's.

**What goes on the wire.** After the wrappers compose, the final `streamFn` is invoked. The OAuth-vs-API-key branch picks one of two beta lists (`PI_AI_DEFAULT_ANTHROPIC_BETAS` or `PI_AI_OAUTH_ANTHROPIC_BETAS`, lines 23-31), merges with any user-configured betas, sets the `anthropic-beta` header (line 50-63), and calls into `streamSimple` from `@earendil-works/pi-ai`. `streamSimple` builds the Anthropic Messages request body, opens an HTTPS connection to `api.anthropic.com/v1/messages`, writes the body, and starts reading the SSE stream. The first byte arrives.

## 6. Code locations

- `src/provider-runtime/operation-retry.ts:1-3` — the only file in `src/provider-runtime/` for this concern.
- `src/provider-runtime/operation-retry.ts:30-34` — `DEFAULT_TRANSIENT_PROVIDER_RETRY_OPTIONS`: 2 attempts, 250ms base, 1000ms cap.
- `src/provider-runtime/operation-retry.ts:48-52` — `defaultTransientProviderRetryForStage`: **no retry on `"create"`** (the stream open); transient retry on `read | poll | download`.
- `src/provider-runtime/operation-retry.ts:145-171` — `isTransientProviderOperationError`, the single classifier with explicit non-retryable 4xx fast-path.
- `src/provider-runtime/operation-retry.ts:197-224` — `shouldRetrySameKeyProviderOperation`, gating attempt-by-attempt with abort-signal check.
- `src/provider-runtime/operation-retry.ts:226-266` — `executeProviderOperationWithRetry`, the loop with exponential-backoff sleep.
- `src/plugin-sdk/provider-http.ts:44-53` — plugin SDK re-export so extensions get the retry helpers through the public surface.
- `extensions/anthropic/index.ts:4-11` — plugin entry definition; the only file `core` resolves at registration time.
- `extensions/anthropic/register.runtime.ts:46-49` — the `PROVIDER_ID = "anthropic"` constant and the default model.
- `extensions/anthropic/stream-wrappers.ts:111-138` — `createAnthropicBetaHeadersWrapper` with the OAuth-detection branch that strips the 1M-context beta.
- `extensions/anthropic/stream-wrappers.ts:203-222` — `wrapAnthropicProviderStream`, the composition root for the provider's stream pipeline.
- `src/agents/pi-embedded-runner/run/attempt.ts:2697-2706` — call-site that obtains the wrapped `streamFn` via `resolveEmbeddedAgentStreamFn` and binds it to the active session.
- `src/agents/pi-embedded-runner/run/incomplete-turn.ts:139-148` — `RETRY_GUARD_MODEL_APIS`, the visible-turn retry guard set (with the v2026.5.22 PR #85603 additions for the openai-responses family).
- `src/agents/anthropic-payload-log.ts:136-158` — `wrapStreamFn` chains the payload logger in front of the provider's `streamFn` via the `onPayload` callback, without changing payload bytes.

## 7. Branches and extensions

The chosen path here is the cleanest one: API-key auth, default model, Anthropic Messages over SSE, single attempt, no retry, no thinking budget, no media. Variations:

- See [Chapter 08 §2 — provider as plugin](08-llm-providers.md) for the full plugin SDK surface and how alternate providers (Vertex, Bedrock, Ollama, LM Studio) bind to the same `StreamFn` contract.
- See [Chapter 08 §7 — operation retry, status classification, and backoff](08-llm-providers.md) for the rationale behind the non-retryable 4xx fast-path and why the stream-open stage defaults to no retry.
- See [Chapter 08 §9 — openai-responses retry guard](08-llm-providers.md) for the visible-turn retry guard and the v2026.5.22 PR #85603 fix that closed the reasoning-only blind spot.

Off-trace concerns: **API key rotation** (`src/agents/api-key-rotation.ts`) cycles among configured keys when one is in cooldown; **auth health** (`src/agents/auth-health.ts`) tracks failed auth profiles to bias the next selection; the **anthropic-vertex** path (`src/agents/anthropic-vertex-stream.ts`) uses Google ADC instead of a plain API key; the **anthropic CLI backend** (`extensions/anthropic/cli-backend.ts`) delegates to the locally installed Claude CLI when present, completely bypassing the HTTPS path; and **payload-logging-as-diagnostic** (`OPENCLAW_ANTHROPIC_PAYLOAD_LOG=1`, `src/agents/anthropic-payload-log.ts:41-48`) writes redacted request payloads to a JSONL file under the state directory for offline analysis.

## 8. What you should now have in your head

- Every provider call goes through a single signature: `streamFn(model, context, options)`. Providers are plugins behind that signature; core never imports an extension.
- Retry is centralised in `src/provider-runtime/operation-retry.ts` and is **stage-aware**: stream creation does not retry by default, but reads, polls, and downloads do. The transient classifier explicitly **excludes** 4xx auth/validation errors even when they arrive as plain message text.
- Backoff is exponential with a hard cap (default 250ms → 1000ms over two attempts); the loop honours the `signal` and bails on abort.
- A second retry mechanism — the **visible-turn retry guard** at `src/agents/pi-embedded-runner/run/incomplete-turn.ts:139` — exists for the orthogonal failure mode where the HTTP call succeeded but the assistant produced no visible content. v2026.5.22 PR #85603 extended this set to the entire `openai-responses` family.
- After this step, an SSE connection to Anthropic is open, the request body is sent, and the first event byte has been received. The next step turns those bytes into emitted agent events and pushes them to every subscriber.
