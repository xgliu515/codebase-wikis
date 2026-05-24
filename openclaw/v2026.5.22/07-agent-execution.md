# Chapter 07: Agent Command Execution

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 7.1 The problem this chapter solves

By the end of Chapter 06 an inbound message has flowed through the normalization pipeline and become an in-process *agent run request*. Everything downstream — choosing which agent owns the conversation, which provider/model to call, which credential to use, how to assemble the prompt, how to detect a stuck turn, how to retry on transient failure, how to emit the partial assistant text back to the UI — happens inside a single coordinator surface called the **agent command**.

The naive design is "load a config, call the LLM, write the answer." That falls apart almost immediately. A real personal-assistant gateway must answer all of the following on every turn:

- Which **agent profile** owns this session? A session key like `agent:planner:tg:1234` already encodes one; an unscoped legacy key must be scoped to a default. See `src/agents/agent-scope.ts`.
- Which **model**? Configured default? Agent-specific default? Persisted per-session override? Per-call CLI override (`--model`)? An auto-fallback probe scheduled for this minute? See `src/agents/model-selection.ts` and `src/agents/agent-command.ts:823-983`.
- Which **auth profile / credential**? A user can have several Anthropic credentials (CLI OAuth, setup-token, an API key). Some are in cool-down. The Claude-CLI runtime requires a specific profile. See `src/agents/auth-profiles.ts` and `src/agents/auth-profiles/`.
- Does this turn go through the **embedded pi runner** (in-process), through the **ACP** (agent-client-protocol, a separate child process), or through a **CLI backend** (Claude CLI, Codex CLI)? See `src/agents/acp-spawn.ts`, `src/agents/pi-embedded-runner/`, and the harness selection in `src/agents/agent-command.ts:985-992`.
- If the model returns no visible text (reasoning-only, planning-only, empty turn) — **retry, ack, or surface as failure**? See `src/agents/pi-embedded-runner/run/incomplete-turn.ts`.
- If the model fails (rate limit, 5xx, abort), **same model with another credential** or **fall through to a fallback model**? Both. See `src/agents/api-key-rotation.ts` and `src/agents/model-fallback.ts`.
- If the user switches model mid-turn through the UI, **how does the live run learn**? See `src/agents/live-model-switch.ts` and `src/agents/agent-command.live-model-switch.test.ts`.
- Where do **streaming events** go? Lifecycle, tool calls, deltas, item updates — they fan out through `src/infra/agent-events.ts` and are picked up by ReplyDispatcher (Chapter 11).

The coordinator that holds all of this together is `agentCommand` (`src/agents/agent-command.ts:1681`) plus its ingress sibling `agentCommandFromIngress` (`src/agents/agent-command.ts:1709`). They are thin trust-boundary wrappers around `agentCommandInternal` (`src/agents/agent-command.ts:525`), a roughly 1100-line orchestrator. This chapter walks it top-down, then opens up the model-selection precedence, the attempt model, the ACP escape hatch, and the two narrow but illuminating fixes shipped in v2026.5.22.

<svg viewBox="0 0 820 440" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="agent-command end-to-end pipeline"><defs><marker id="r71arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><rect x="20" y="20" width="780" height="44" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="410" y="42" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">Caller (server-node-events, openai-http, TUI, agent-step tool, ACP)</text><text x="410" y="58" text-anchor="middle" font-size="10" fill="#64748b">agentCommandFromIngress / agentCommand</text><line x1="410" y1="64" x2="410" y2="82" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r71arrow)"/><rect x="60" y="82" width="700" height="36" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.2"/><text x="410" y="106" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">trust wrapper: senderIsOwner + allowModelOverride gating (agent-command.ts:1681-1722)</text><line x1="410" y1="118" x2="410" y2="136" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r71arrow)"/><rect x="40" y="136" width="740" height="280" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="410" y="158" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">agentCommandInternal (agent-command.ts:525)</text><rect x="60" y="172" width="330" height="34" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/><text x="225" y="192" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">prepareAgentCommandExecution (line 323)</text><text x="225" y="204" text-anchor="middle" font-size="9" fill="#64748b">session, agent id, workspace, ACP resolution</text><rect x="430" y="172" width="330" height="34" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/><text x="595" y="192" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ACP ready? runTurn() → emit deltas (line 580-718)</text><text x="595" y="204" text-anchor="middle" font-size="9" fill="#64748b">short-circuit branch for ACP-bound sessions</text><rect x="60" y="216" width="330" height="34" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/><text x="225" y="236" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">model selection (line 823-983)</text><text x="225" y="248" text-anchor="middle" font-size="9" fill="#64748b">default → agent → stored → per-run → fallback probe</text><rect x="430" y="216" width="330" height="34" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/><text x="595" y="236" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">auth profile validation (line 994-1042)</text><text x="595" y="248" text-anchor="middle" font-size="9" fill="#64748b">stored override must match runtime providers</text><rect x="60" y="258" width="330" height="34" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/><text x="225" y="278" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">harness selection (line 985-992)</text><text x="225" y="290" text-anchor="middle" font-size="9" fill="#64748b">pi embedded / acpx / claude-cli / codex-cli</text><rect x="430" y="258" width="330" height="34" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/><text x="595" y="278" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">runWithModelFallback (line 1235-1333)</text><text x="595" y="290" text-anchor="middle" font-size="9" fill="#64748b">attempt loop with classifier + auth rotation</text><rect x="60" y="300" width="330" height="34" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/><text x="225" y="320" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">runAgentAttempt (attempt-execution.ts:367)</text><text x="225" y="332" text-anchor="middle" font-size="9" fill="#64748b">prompt build + stream + tool loop + retry guard</text><rect x="430" y="300" width="330" height="34" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/><text x="595" y="320" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">LiveSessionModelSwitchError? retry outer (line 1394-1450)</text><text x="595" y="332" text-anchor="middle" font-size="9" fill="#64748b">cap = MAX_LIVE_SWITCH_RETRIES (5)</text><rect x="60" y="342" width="700" height="34" rx="4" fill="#fde68a" stroke="#f59e0b" stroke-width="1.2"/><text x="410" y="362" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">emit lifecycle "finishing" → deliverAgentCommandResult → lifecycle "end"</text><text x="410" y="374" text-anchor="middle" font-size="9" fill="#64748b">agent-command.ts:1135-1194; delivery.runtime.ts</text><rect x="60" y="382" width="700" height="22" rx="4" fill="#bbf7d0" stroke="#16a34a" stroke-width="1.2"/><text x="410" y="397" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">final payloads + meta returned to caller; events have already streamed</text></svg>
<details><summary>ASCII original</summary>
```
Caller (server-node-events, openai-http, TUI, agent-step, ACP)
        ↓ agentCommandFromIngress / agentCommand
[trust wrapper: senderIsOwner + allowModelOverride gating]
        ↓
agentCommandInternal (agent-command.ts:525)
  ├─ prepareAgentCommandExecution     ─── session, agent id, workspace, ACP resolution
  ├─ ACP ready? → runTurn() → deltas  ─── short-circuit for ACP-bound sessions
  ├─ model selection (823-983)        ─── default → agent → stored → per-run → fallback probe
  ├─ auth profile validation          ─── stored override must match runtime providers
  ├─ harness selection                ─── pi embedded / acpx / claude-cli / codex-cli
  ├─ runWithModelFallback (1235-1333) ─── attempt loop with classifier + auth rotation
  ├─ runAgentAttempt (attempt-execution.ts:367)
  └─ LiveSessionModelSwitchError? retry outer (cap 5)
        ↓
emit lifecycle "finishing" → deliverAgentCommandResult → lifecycle "end"
        ↓
final payloads + meta returned; events have already streamed
```
</details>
<span class="figure-caption">Figure R7.1 | agentCommand pipeline: trust wrapper → coordinator → selection layers → attempt loop → lifecycle/delivery.</span>

## 7.2 The two entry points and the trust boundary

The exported surface is intentionally tiny:

```ts
// src/agents/agent-command.ts:1681-1722
export async function agentCommand(opts, runtime, deps) {
  const resolvedDeps = await resolveAgentCommandDeps(deps);
  return await withLocalGatewayRequestScope(
    { deps: resolvedDeps, getRuntimeConfig },
    async () => await agentCommandInternal(
      { ...opts,
        senderIsOwner: opts.senderIsOwner ?? true,
        allowModelOverride: opts.allowModelOverride ?? true,
      },
      runtime, resolvedDeps,
    ),
  );
}

export async function agentCommandFromIngress(opts, runtime, deps) {
  if (typeof opts.allowModelOverride !== "boolean") {
    throw new Error("allowModelOverride must be explicitly set for ingress agent runs.");
  }
  return await agentCommandInternal(
    { ...opts, senderIsOwner: opts.senderIsOwner === true },
    runtime, deps,
  );
}
```

Two facts are encoded here that look bureaucratic but matter for safety:

1. **`agentCommand`** is the local-CLI / trusted-operator entry. It opts the caller into owner identity (`senderIsOwner: true`) and into per-run model overrides (`allowModelOverride: true`). Used by `src/tui/embedded-backend.ts:733` and `src/agents/tools/agent-step.ts:67` (the subagent-spawn tool).
2. **`agentCommandFromIngress`** is the network-facing entry. It refuses to default `allowModelOverride` — every ingress caller must decide. Used by `src/gateway/openai-http.ts:975`, `src/gateway/openresponses-http.ts:406`, and `src/gateway/server-node-events.ts:416,586`.

A naive design would expose one entry and trust the option object. Then a bug in a new gateway HTTP handler that forgets to set `senderIsOwner: false` would silently grant the request owner-equivalent permission for, say, executing `bash` tools. The two-entry split makes that mistake a type-level mistake: `AgentCommandIngressOpts` (`src/agents/command/types.ts:133-141`) types `allowModelOverride` as `required`, so omission won't compile. This is the recurring pattern in `agent-command.ts`: every dimension that has a "safe default for local, dangerous default for network" is split at the boundary.

The opts shape itself (`src/agents/command/types.ts:41-131`) carries forty-plus fields. The most important for this chapter:

- `message`, `transcriptMessage` — what the user typed and what should be written to transcript (they differ when an internal event prefixes runtime context, see `src/agents/agent-command.ts:488-493`).
- `agentId`, `sessionId`, `sessionKey`, `to` — at least one is required for routing (`src/agents/agent-command.ts:329-334`).
- `provider`, `model` — per-run overrides, only honored if `allowModelOverride` is true.
- `thinking`, `thinkingOnce`, `verbose` — reasoning effort and verbosity overrides.
- `internalEvents` — synthetic prompt blocks injected by upstream (cron triggers, retries, subagent results).
- `acpTurnSource` — when set to `"manual_spawn"`, bypasses the ACP dispatch gate (only the explicit-turn gate is checked).
- `runId`, `lane`, `groupId`, `spawnedBy` — subagent / lane bookkeeping.
- `abortSignal` — propagated all the way down to the LLM transport so client disconnects abort the request.

## 7.3 `prepareAgentCommandExecution`: turning opts into a run plan

`prepareAgentCommandExecution` (`src/agents/agent-command.ts:323`) is purely synchronous-style coordination: no LLM calls, no I/O retries, just data assembly. It returns a 24-field struct that `agentCommandInternal` consumes. The work breaks down into seven steps:

**Step 1 — validate.** Reject empty messages; reject calls with no routing hint (`src/agents/agent-command.ts:325-334`).

**Step 2 — resolve config.** Call `resolveAgentRuntimeConfig` (`src/agents/agent-runtime-config.ts:8-48`). This loads the runtime config (the in-process snapshot), then in parallel reads the source file snapshot. If the runtime config references `${secret:...}` placeholders, it runs them through `resolveCommandConfigWithSecrets` so the agent sees plaintext credentials. Otherwise it returns the raw config to avoid unnecessary secret-store taps. The function also resets the global config snapshot (`setRuntimeConfigSnapshot`) so anything that reads `getRuntimeConfig()` later in this turn sees a coherent view.

The secret-ref check itself (`hasAgentRuntimeSecretRefs`, `src/agents/agent-runtime-config.ts:63-101`) is a hand-coded walk over the parts of the config tree the agent might read: provider auth blocks, memory-search API keys, TTS provider configs, skill entries, web-search and per-plugin web configs, and — only when `runtimeTargetsChannelSecrets` is true — channel configs.

**Step 3 — resolve agent.**

```ts
// src/agents/agent-command.ts:346-355
const agentIdOverrideRaw = opts.agentId?.trim();
const agentIdOverride = agentIdOverrideRaw ? normalizeAgentId(agentIdOverrideRaw) : undefined;
if (agentIdOverride) {
  const knownAgents = listAgentIds(cfg);
  if (!knownAgents.includes(agentIdOverride)) {
    throw new Error(`Unknown agent id "${agentIdOverrideRaw}". ...`);
  }
}
```

`listAgentIds` (`src/agents/agent-scope-config.ts:69-85`) returns the unique configured ids (or `[DEFAULT_AGENT_ID]` if none). `resolveDefaultAgentId` (`src/agents/agent-scope-config.ts:87-99`) returns the first agent with `default: true`, warning when multiple are marked.

**Step 4 — scope the session key.** This is the trickiest piece. A session key like `tg:1234` is legacy (no agent prefix). If `agentId` is supplied, the key is rewritten to `agent:<agentId>:tg:1234` so the rest of the pipeline can treat it uniformly. If `agentId` is *not* supplied but the key looks legacy, the default agent is used. The full logic lives at `src/agents/agent-command.ts:356-383`. Mismatched explicit `agentId` and key-encoded agent throw rather than silently override.

**Step 5 — resolve session.** `resolveSession` (`src/agents/command/session.ts`) loads or synthesizes the `SessionEntry` from the on-disk session store, returning `sessionId`, `sessionKey`, `sessionEntry`, the store handle, the store path, `isNewSession`, and any persisted `thinking`/`verbose` levels.

**Step 6 — assemble paths and ACP resolution.**

```ts
// src/agents/agent-command.ts:432-447
const outboundSession = buildOutboundSessionContext({
  cfg, agentId: sessionAgentId, sessionKey,
});
const workspaceDirRaw = normalizedSpawned.workspaceDir
  ?? resolveAgentWorkspaceDir(cfg, sessionAgentId);
const workspaceDir = resolveUserPath(workspaceDirRaw);
const agentDir = resolveAgentDir(cfg, sessionAgentId);
const manifestMetadataSnapshot = loadManifestMetadataSnapshot({
  config: cfg, workspaceDir, env: process.env,
});
```

`resolveAgentWorkspaceDir` (`src/agents/agent-scope-config.ts`) returns the per-agent workspace path. The manifest metadata snapshot captures which provider plugins are currently loaded — required when normalizing provider-prefixed model refs that the host doesn't know about natively.

The function then asks the ACP session manager whether this session has a persistent ACP binding:

```ts
// src/agents/agent-command.ts:480-487
const { getAcpSessionManager } = await loadAcpManagerRuntime();
const acpManager = getAcpSessionManager();
const acpResolution = sessionKey
  ? acpManager.resolveSession({ cfg, sessionKey })
  : null;
```

`acpResolution.kind` is `"ready"`, `"stale"`, or `null`. The `agentCommandInternal` body branches off of this immediately (§7.5).

**Step 7 — wrap the message.** Two text representations are computed: `body` (what gets fed to the model) and `transcriptBody` (what gets persisted as the user message). When ACP is ready, internal events are inlined via `resolveAcpPromptBody`; otherwise they are formatted as a context preamble by `prependInternalEventContext`. See `src/agents/agent-command.ts:488-493` and `src/agents/command/attempt-execution.shared.ts`.

## 7.4 The ACP short-circuit branch

When `acpResolution.kind === "ready"` and we are not in a raw-model probe, `agentCommandInternal` does *not* fall through to the embedded pi runner. Instead it pushes the turn into the long-lived ACP child process via `acpManager.runTurn`:

```ts
// src/agents/agent-command.ts:611-658 (abridged)
await acpManager.runTurn({
  cfg, sessionKey, text: body, mode: "prompt",
  requestId: runId, signal: opts.abortSignal,
  onLifecycle: (event) => {
    if (event.type === "prompt_submitted") {
      attemptExecutionRuntime.emitAcpPromptSubmitted({ runId, sessionKey, at: event.at });
    }
  },
  onEvent: (event) => {
    if (event.type !== "text_delta") {
      attemptExecutionRuntime.emitAcpRuntimeEvent({ runId, sessionKey, event });
    }
    if (event.type === "done") { stopReason = event.stopReason; return; }
    if (event.type !== "text_delta") return;
    if (event.stream && event.stream !== "output") return;
    if (!event.text) return;
    const visibleUpdate = visibleTextAccumulator.consume(event.text);
    if (!visibleUpdate) return;
    attemptExecutionRuntime.emitAcpAssistantDelta({
      runId, text: visibleUpdate.text, delta: visibleUpdate.delta,
    });
  },
});
```

Three policy checks gate this branch (`src/agents/agent-command.ts:592-610`):

1. **Dispatch policy** — is ACP allowed for non-manual turns? `resolveAcpDispatchPolicyError(cfg)`.
2. **Explicit-turn policy** — for `acpTurnSource === "manual_spawn"`, only the explicit-turn permission is checked (manual spawns can run even when general dispatch is disabled).
3. **Per-agent policy** — `resolveAcpAgentPolicyError(cfg, acpAgent)` returns an error when the resolved agent is on the deny list.

The ACP branch builds an `AcpVisibleTextAccumulator` (a chunked-delta consumer that hides chain-of-thought blocks when configured). Visible deltas become `assistant` events; everything else (tool calls, lifecycle, errors) is emitted as `acp_runtime` events for diagnostics. The final transcript is persisted via `persistAcpTurnTranscript` and the response is built by `buildAcpResult`. The result is then handed to `deliverAgentCommandResult` exactly like a non-ACP run.

Why route through a separate child process at all? Three reasons:

- **Process isolation.** A CLI-backed agent (Claude CLI, Codex CLI) wraps a third-party binary that may leak file handles, mutate `cwd`, or terminate uncleanly. Running it as a child contains the blast radius.
- **Language interop.** The Agent-Client-Protocol is defined as a stdio JSON-RPC dialect (`@agentclientprotocol/sdk`), so non-Node implementations can plug in.
- **Long-lived sessions.** Some agent backends (Claude CLI) keep a *persistent* conversation handle across turns. ACP binds that handle to a session key and reuses it. Without ACP we would re-handshake on every turn.

The persistent binding is materialized in `src/acp/persistent-bindings.lifecycle.ts` (lifecycle), `.resolve.ts` (resolution), and `.types.ts` (shape). The architecture has a guardrail test:

```ts
// src/agents/acp-binding-architecture.guardrail.test.ts:13-29
const GUARDED_SOURCES: GuardedSource[] = [
  { path: "agents/acp-spawn.ts",
    forbiddenPatterns: [/\bgetThreadBindingManager\b/, /\bparseDiscordTarget\b/] },
  { path: "auto-reply/reply/commands-acp/lifecycle.ts",
    forbiddenPatterns: [/\bgetThreadBindingManager\b/, /\bunbindThreadBindingsBySessionKey\b/] },
  ...
];
```

The test prevents ACP code paths from reaching into Discord-specific channel-binding APIs — ACP must stay agent-binding-only and not couple to a single channel implementation. The guardrail runs in CI and is the cheapest possible defense against architectural drift.

<svg viewBox="0 0 820 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ACP binding architecture"><defs><marker id="r72arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><rect x="20" y="20" width="380" height="340" rx="10" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="210" y="42" text-anchor="middle" font-size="13" font-weight="700" fill="#92400e">openclaw host process</text><rect x="40" y="56" width="340" height="36" rx="6" fill="#fed7aa" stroke="#ea580c"/><text x="210" y="78" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">agentCommandInternal (agent-command.ts:525)</text><rect x="40" y="100" width="340" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed"/><text x="210" y="122" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">acpManager (acp/control-plane/manager.ts)</text><rect x="40" y="144" width="340" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed"/><text x="210" y="166" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">PersistentBindings (acp/persistent-bindings.*)</text><rect x="40" y="188" width="340" height="36" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/><text x="210" y="210" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">SpawnControlPlane (acp/control-plane/spawn.ts)</text><rect x="40" y="232" width="340" height="36" rx="6" fill="#bbf7d0" stroke="#16a34a"/><text x="210" y="254" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">AgentSideConnection (ndjson stdio)</text><rect x="40" y="276" width="340" height="68" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/><text x="210" y="296" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">guardrail test</text><text x="210" y="312" text-anchor="middle" font-size="10" fill="#64748b">acp-spawn.ts MUST NOT call</text><text x="210" y="326" text-anchor="middle" font-size="10" fill="#64748b">getThreadBindingManager / parseDiscordTarget</text><text x="210" y="340" text-anchor="middle" font-size="9" fill="#94a3b8">acp-binding-architecture.guardrail.test.ts:13-29</text><line x1="400" y1="200" x2="450" y2="200" stroke="#94a3b8" stroke-width="1.8" marker-end="url(#r72arrow)"/><text x="425" y="194" text-anchor="middle" font-size="9" fill="#64748b">stdio</text><rect x="450" y="40" width="350" height="320" rx="10" fill="#bbf7d0" stroke="#16a34a" stroke-width="1.5"/><text x="625" y="62" text-anchor="middle" font-size="13" font-weight="700" fill="#166534">ACP child process</text><rect x="470" y="80" width="310" height="40" rx="6" fill="#f0fdf4" stroke="#16a34a"/><text x="625" y="100" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">acp/server.ts (serveAcpGateway)</text><text x="625" y="113" text-anchor="middle" font-size="9" fill="#64748b">src/acp/server.ts:22</text><rect x="470" y="130" width="310" height="60" rx="6" fill="#f0fdf4" stroke="#16a34a"/><text x="625" y="150" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">AcpGatewayAgent (translator)</text><text x="625" y="165" text-anchor="middle" font-size="9" fill="#64748b">src/acp/translator.ts (2171 lines)</text><text x="625" y="180" text-anchor="middle" font-size="9" fill="#64748b">JSON-RPC: initialize / newSession / prompt / cancel</text><rect x="470" y="200" width="310" height="36" rx="6" fill="#f0fdf4" stroke="#16a34a"/><text x="625" y="222" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">GatewayClient (back to host RPC)</text><rect x="470" y="246" width="310" height="36" rx="6" fill="#fde68a" stroke="#f59e0b"/><text x="625" y="268" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">spawned backend: Claude CLI / Codex / custom</text><rect x="470" y="292" width="310" height="60" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/><text x="625" y="312" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">acp-spawn-parent-stream</text><text x="625" y="328" text-anchor="middle" font-size="9" fill="#64748b">relays partial output to parent session</text><text x="625" y="342" text-anchor="middle" font-size="9" fill="#64748b">src/agents/acp-spawn-parent-stream.ts:523 lines</text></svg>
<details><summary>ASCII original</summary>
```
openclaw host process                        ACP child process
─────────────────────                        ──────────────────
agentCommandInternal                         acp/server.ts (serveAcpGateway)
       ↓                                            ↓
acpManager (acp/control-plane/manager.ts)    AcpGatewayAgent (acp/translator.ts)
       ↓                                            ↓  JSON-RPC: initialize/newSession/prompt
PersistentBindings                           GatewayClient (back to host RPC)
       ↓                                            ↓
SpawnControlPlane (acp/control-plane/spawn.ts)  spawned backend (Claude CLI, Codex, ...)
       ↓                                            ↓
AgentSideConnection (ndjson stdio)  ────────► acp-spawn-parent-stream (relay)

guardrail: acp-spawn.ts MUST NOT call getThreadBindingManager / parseDiscordTarget
           (acp-binding-architecture.guardrail.test.ts)
```
</details>
<span class="figure-caption">Figure R7.2 | ACP binding architecture: host coordinator talks to a child agent process over stdio JSON-RPC; persistent bindings survive turn boundaries.</span>

For sessions where ACP is *not* the resolution kind, the body of `agentCommandInternal` continues into the embedded path — the rest of this chapter.

## 7.5 Model selection precedence

Once we know the agent and the session, we need a provider and a model. The relevant config knobs (in increasing specificity):

- `models.providers[*]` — declares which providers exist and which models they expose.
- `agents.defaults.model.primary`, `agents.defaults.model.fallbacks[]` — the global agent defaults.
- `agents.list[*].model.primary` — per-agent overrides (resolved via `resolveAgentEffectiveModelPrimary` and folded into `resolveDefaultModelForAgent`, `src/agents/model-selection.ts:214-247`).
- `sessionEntry.providerOverride` / `sessionEntry.modelOverride` — persisted per-session override (set by `/model` in chat or by the auto-fallback bookkeeper).
- `opts.provider` / `opts.model` — per-call CLI/HTTP override.

The agent-command resolves these in a fixed order:

```ts
// src/agents/agent-command.ts:823-983 (abridged)
const configuredDefaultRef = resolveDefaultModelForAgent({
  cfg, agentId: sessionAgentId, ...modelManifestContext,
});
const { provider: defaultProvider, model: defaultModel } = normalizeModelRef(
  configuredDefaultRef.provider, configuredDefaultRef.model, modelManifestContext,
);
let provider = defaultProvider;
let model = defaultModel;
// ... allowlist + visibility policy ...

const storedProviderOverride = sessionEntry?.providerOverride?.trim();
let storedModelOverride = sessionEntry?.modelOverride?.trim();
if (storedModelOverride) {
  // accept only if it is still in the visibility policy
  ...
  if (visibilityPolicy.allowsKey(key)) { provider = ...; model = ...; }
}
// auto-fallback primary probe (re-test the original primary every 5 minutes)
const autoFallbackPrimaryProbe = !hasExplicitRunOverride
  ? resolveAutoFallbackPrimaryProbe({ entry: sessionEntry, sessionKey,
      primaryProvider: defaultProvider, primaryModel: defaultModel })
  : undefined;
if (autoFallbackPrimaryProbe && sessionEntry) {
  provider = autoFallbackPrimaryProbe.provider;
  model = autoFallbackPrimaryProbe.model;
  ...
}
// per-run explicit override
if (hasExplicitRunOverride) {
  if (opts.allowModelOverride !== true) {
    throw new Error("Model override is not authorized for this caller.");
  }
  ...
  provider = explicitRef.provider;
  model = explicitRef.model;
}
```

A few things worth highlighting:

1. **Auto-fallback primary probe.** When the primary model has been auto-failed to a fallback, the session entry records that as a stored override. After a cool-down (`AUTO_FALLBACK_PRIMARY_PROBE_INTERVAL_MS = 5 * 60 * 1000`, `src/agents/agent-scope.ts:50`), the agent-command will *probe* the original primary on the next turn — if it still works, the override is cleared (`clearAutoFallbackPrimaryProbeSelection`, `src/agents/agent-command.ts:1346-1357`); if it fails again, the override stays and the run uses the fallback.

2. **Explicit override is the last word, but only if authorized.** Network-facing callers must pass `allowModelOverride: true` deliberately. The check (`src/agents/agent-command.ts:853-854`) refuses to honor it otherwise.

3. **Visibility policy guards everything.** `createModelVisibilityPolicy` (`src/agents/model-visibility-policy.ts`) returns a single `allowsKey(provider/model)` function that incorporates `agents.defaults.models` allowlists, agent-specific allowlists, and provider wildcards (`anthropic/*`). Every candidate model — default, stored override, explicit override — passes through it. If the configured default itself is rejected, the call throws (`src/agents/agent-command.ts:976-980`) rather than silently degrading to "whatever is allowed."

The live-model-switch test confirms the outer loop also obeys this. When `LiveSessionModelSwitchError` is thrown mid-attempt (e.g. user toggles model in the UI while the run is in-flight), the catch handler re-runs visibility against the new `(provider, model)`:

```ts
// src/agents/agent-command.ts:1394-1428 (abridged)
} catch (err) {
  if (err instanceof LiveSessionModelSwitchError) {
    liveSwitchRetries++;
    if (liveSwitchRetries > MAX_LIVE_SWITCH_RETRIES) {  // 5
      ...
      throw new Error(`Exceeded maximum live model switch retries (${MAX_LIVE_SWITCH_RETRIES})`, { cause: err });
    }
    const switchRef = normalizeModelRef(err.provider, err.model, modelManifestContext);
    const switchKey = modelKey(switchRef.provider, switchRef.model);
    if (!visibilityPolicy.allowsKey(switchKey)) {
      log.info(`Live session model switch in subagent run ${runId}: rejected ${...} (not in allowlist)`);
      // fall through and re-raise
```

The test (`src/agents/agent-command.live-model-switch.test.ts:811-858`) verifies: two `runWithModelFallback` calls happen, the second uses the switched provider/model, and lifecycle events fire in the right order (finishing → delivery → end). That last point is load-bearing: if `end` fires *before* delivery completes, the UI marks the run done and downstream listeners may discard the assistant payload — see `deferTerminalLifecycleEnd: true` on the attempt call (`src/agents/agent-command.ts:1330`).

## 7.6 Auth profiles and credential rotation

After the model is chosen, the credential is chosen. Two coupled mechanisms:

**Auth profile selection.** Each provider can have multiple profiles in the auth store (`AuthProfileStore`, declared via `src/agents/auth-profiles.ts:73-77` and stored under `src/agents/auth-profiles/`). When a session pins an auth profile (`sessionEntry.authProfileOverride`), the agent-command re-validates that the profile is still compatible with the *currently selected* provider and harness runtime:

```ts
// src/agents/agent-command.ts:994-1042 (abridged)
let sessionEntryForAttempt = autoFallbackPrimaryProbeSessionEntry ?? sessionEntry;
if (sessionEntryForAttempt) {
  const authProfileId = sessionEntryForAttempt.authProfileOverride;
  if (authProfileId) {
    const store = ensureAuthProfileStore();
    const profile = store.profiles[authProfileId];
    const validationHarnessPolicy = resolveAvailableAgentHarnessPolicy(...);
    const acceptedAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime(...)
      .map((p) => resolveProviderIdForAuth(p, { config: cfg, workspaceDir }));
    const profileMatchesRuntime = profile && acceptedAuthProviders.some(
      (p) => isStoredCredentialCompatibleWithAuthProvider({ cfg, provider: p, credential: profile }),
    );
    if (!profileMatchesRuntime) {
      if (hasExplicitRunOverride || autoFallbackPrimaryProbe) {
        sessionEntryForAttempt = { ...entry, authProfileOverride: undefined, ... };
      } else if (sessionStore && sessionKey) {
        await clearSessionAuthProfileOverride({ ... });
      }
    }
  }
}
```

If the session previously pinned a Codex CLI profile but the user just switched to an Anthropic model, the pin is cleared rather than blowing up the call.

**Per-call rotation.** Within a single attempt, if a credential gets rate-limited, the host can try another credential for the same provider before falling through to a fallback model. This is `executeWithApiKeyRotation` (`src/agents/api-key-rotation.ts:1-100+`), built on top of the provider-agnostic `executeProviderOperationWithRetry` (`src/provider-runtime/operation-retry.ts:226-266`). Chapter 08 covers the retry classifier in detail; here it is enough to note that rotation is *intra-provider*, fallback is *inter-model*, and both exist.

The list `auth-profiles*` files in `src/agents/` is dense (50+ files) — most of it is glue around store I/O, cool-down clocks (`src/agents/auth-profiles/usage.ts`), and per-vendor onboarding (`src/agents/auth-profiles/external-cli-*`). The relevant surface for this chapter is small: `ensureAuthProfileStore`, `resolveAuthProfileOrder`, `markAuthProfileCooldown`, and `clearSessionAuthProfileOverride`.

## 7.7 The attempt and the attempt loop

After selection, control passes to `runWithModelFallback` (`src/agents/model-fallback.ts:905`). This is *not* the same loop as the LiveSessionModelSwitch retry above — the live-switch retry is at the agent-command level, and the model-fallback loop is one layer in. They nest:

```
agent-command outer loop (live-switch retry, cap 5)
  └─ runWithModelFallback (model fallback chain)
      └─ runAgentAttempt (one provider call, with its own credential rotation)
```

`runWithModelFallback` accepts an explicit candidate list (via `effectiveFallbacksOverride` computed at `src/agents/agent-command.ts:1221-1231`) plus a `classifyResult` callback that inspects the attempt return value to decide whether to fall through. For agent runs the classifier is `classifyEmbeddedPiRunResultForModelFallback` (`src/agents/pi-embedded-runner/result-fallback-classifier.ts`): if the result is "empty turn, reasoning-only, or planning-only" *and* the model is in the retry-guard allowlist, the runner has already retried internally; if the result is "outright provider error," the loop falls through to the next model in the chain.

```ts
// src/agents/agent-command.ts:1235-1333 (abridged)
const fallbackResult = await runWithModelFallback<AgentAttemptResult>({
  cfg, provider, model, ...modelManifestContext,
  runId, agentDir, agentId: sessionAgentId, sessionKey: sessionKey ?? sessionId,
  prepareAgentHarnessRuntime: async ({ provider, model, agentHarnessRuntimeOverride }) => {
    await ensureSelectedAgentHarnessPlugin({ ... });
  },
  fallbacksOverride: effectiveFallbacksOverride,
  onFallbackStep: (step) => {
    fallbackTrajectoryRecorder?.recordEvent("model.fallback_step", step);
  },
  classifyResult: ({ provider, model, result }) =>
    classifyEmbeddedPiRunResultForModelFallback({ provider, model, result }),
  run: async (providerOverride, modelOverride, runOptions) => {
    ...
    return attemptExecutionRuntime.runAgentAttempt({
      providerOverride, modelOverride,
      modelFallbacksOverride: effectiveFallbacksOverride,
      originalProvider: provider, cfg, sessionEntry: attemptSessionEntry,
      sessionId, sessionKey, sessionAgentId, sessionFile, workspaceDir, body,
      isFallbackRetry, resolvedThinkLevel,
      fastMode: resolveFastModeState({ ... }).enabled,
      timeoutMs, runId, opts, runContext, spawnedBy, messageChannel,
      skillsSnapshot, resolvedVerboseLevel, agentDir,
      authProfileProvider: providerForAuthProfileValidation,
      sessionStore, storePath,
      allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
      sessionHasHistory: !isNewSession || (await sessionFileHasContent(sessionFile)),
      suppressPromptPersistenceOnRetry: ...,
      onUserMessagePersisted: attemptLifecycleCallbacks.onUserMessagePersisted,
      onAgentEvent: attemptLifecycleCallbacks.onAgentEvent,
      deferTerminalLifecycleEnd: true,
    });
  },
});
```

`runAgentAttempt` (`src/agents/command/attempt-execution.ts:367`) is where the actual LLM round-trip happens. Its shape (full signature lines 367-405) takes most of the prepared state plus two lifecycle callbacks (`onUserMessagePersisted`, `onAgentEvent`). Internally it:

1. Picks the runtime — embedded pi runner, Claude CLI, Codex CLI, or a custom harness — via `resolveAvailableAgentHarnessPolicy`.
2. Builds the prompt (system prompt overlays, skills snapshot, tool descriptions, history). System-prompt construction is a chapter by itself; the relevant entry point is `src/gateway/agent-prompt.ts`.
3. Calls the provider stream (Anthropic transport or OpenAI transport — Chapter 08).
4. Runs the tool-loop: when the model emits `tool_use`, dispatch the tool, append the result, re-stream.
5. Applies the non-visible-turn retry guard (§7.9) when needed.
6. Persists the assistant turn to the session transcript.
7. Returns an `AgentAttemptResult` whose `meta` carries usage, stop reason, agent metadata, and (after live-switch retries) the cumulative `fallbackAttempts` array.

<svg viewBox="0 0 820 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="attempt state machine"><defs><marker id="r73arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker><marker id="r73err" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#dc2626"/></marker></defs><rect x="40" y="30" width="160" height="50" rx="25" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="120" y="56" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">proposed</text><text x="120" y="72" text-anchor="middle" font-size="9" fill="#64748b">attempt opts assembled</text><line x1="200" y1="55" x2="260" y2="55" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r73arrow)"/><rect x="260" y="30" width="160" height="50" rx="25" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="340" y="56" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">running (stream)</text><text x="340" y="72" text-anchor="middle" font-size="9" fill="#64748b">SSE deltas → assistant events</text><line x1="420" y1="55" x2="480" y2="55" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r73arrow)"/><rect x="480" y="30" width="180" height="50" rx="25" fill="#fde68a" stroke="#f59e0b" stroke-width="1.5"/><text x="570" y="52" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">tool_use loop</text><text x="570" y="68" text-anchor="middle" font-size="9" fill="#64748b">dispatch tool, append result, stream again</text><path d="M 570 80 Q 570 110 480 110 Q 390 110 390 80" stroke="#94a3b8" fill="none" stroke-width="1.2" marker-end="url(#r73arrow)"/><text x="480" y="106" text-anchor="middle" font-size="9" fill="#64748b">loop until stop_reason ≠ tool_use</text><line x1="660" y1="55" x2="720" y2="55" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r73arrow)"/><rect x="720" y="30" width="80" height="50" rx="25" fill="#bbf7d0" stroke="#16a34a" stroke-width="1.5"/><text x="760" y="60" text-anchor="middle" font-size="12" font-weight="700" fill="#166534">succeeded</text><line x1="340" y1="80" x2="340" y2="140" stroke="#dc2626" stroke-width="1.5" marker-end="url(#r73err)"/><rect x="220" y="140" width="240" height="44" rx="6" fill="#fee2e2" stroke="#dc2626" stroke-width="1.2"/><text x="340" y="160" text-anchor="middle" font-size="11" font-weight="700" fill="#991b1b">stream error / 5xx / timeout</text><text x="340" y="174" text-anchor="middle" font-size="9" fill="#64748b">api-key-rotation, then operation-retry</text><line x1="340" y1="184" x2="340" y2="220" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r73arrow)"/><rect x="220" y="220" width="240" height="36" rx="6" fill="#fef3c7" stroke="#f59e0b"/><text x="340" y="244" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">retry same key? rotate? fall through?</text><line x1="220" y1="240" x2="120" y2="240" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r73arrow)"/><line x1="460" y1="240" x2="560" y2="240" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r73arrow)"/><rect x="40" y="220" width="160" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed"/><text x="120" y="240" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">model-fallback</text><text x="120" y="254" text-anchor="middle" font-size="9" fill="#64748b">next candidate in chain</text><rect x="560" y="220" width="220" height="44" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="670" y="240" text-anchor="middle" font-size="11" font-weight="700" fill="#991b1b">failed (FallbackSummaryError)</text><text x="670" y="254" text-anchor="middle" font-size="9" fill="#64748b">surface to caller, emit lifecycle error</text><rect x="40" y="290" width="160" height="44" rx="6" fill="#e2e8f0" stroke="#64748b"/><text x="120" y="310" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">cancelled</text><text x="120" y="324" text-anchor="middle" font-size="9" fill="#64748b">abortSignal fired</text><line x1="120" y1="80" x2="120" y2="290" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#r73arrow)"/><rect x="260" y="290" width="240" height="44" rx="6" fill="#fde68a" stroke="#f59e0b"/><text x="380" y="308" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">non-visible turn?</text><text x="380" y="322" text-anchor="middle" font-size="9" fill="#64748b">retry up to DEFAULT_REASONING_ONLY_RETRY_LIMIT=2</text><line x1="380" y1="184" x2="380" y2="290" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#r73arrow)"/></svg>
<details><summary>ASCII original</summary>
```
proposed → running (stream) → tool_use loop ⟲ → succeeded
              ↓ (stream error / 5xx / timeout)
              retry-same-key → rotate-credential → model-fallback → failed
              ↓ (abortSignal)
              cancelled
              ↓ (empty / reasoning-only response)
              non-visible-turn retry (cap = 1 or 2)
```
</details>
<span class="figure-caption">Figure R7.3 | The attempt state machine: success path runs a tool-loop until end_turn; failures route to credential rotation, model fallback, or the non-visible-turn retry guard.</span>

## 7.8 Lifecycle event emission

The other half of `agentCommandInternal` is event plumbing. Three closures (`src/agents/agent-command.ts:1129-1194`) emit lifecycle events:

```ts
const emitLifecycleFinishing = (runResult: AgentAttemptResult) => { ... };
const emitLifecycleEnd      = (runResult: AgentAttemptResult) => { ... };
const emitLifecyclePostTurnError = (error: unknown) => { ... };
```

All three call `emitAgentEvent` from `src/infra/agent-events.ts:209`. The event stream type is one of `lifecycle | tool | assistant | error | item | plan | approval | command_output | patch | compaction | thinking` (`src/infra/agent-events.ts:5-16`). For lifecycle the data shape is `{ phase, startedAt, endedAt, aborted, stopReason }` (finishing/end) or `{ phase, error }` (error).

Three properties of this emission are worth pinning down:

1. **Sequence numbers per run.** `emitAgentEvent` (`src/infra/agent-events.ts:209-235`) increments a per-run counter (`seqByRun`) on every emit. Consumers can re-order by `seq` if a transport reorders. The TUI and the ReplyDispatcher (Chapter 11) both rely on this for de-duplication after reconnect.

2. **Visibility redaction.** When the run context is marked hidden (`isControlUiVisible: false`, set by channel-routed runs that don't want their internals shown in Control UI), every stream *except* `lifecycle` is stripped of `sessionKey`. Lifecycle keeps the key so terminal persistence still works (`src/infra/agent-events.ts:220-227`).

3. **Order vs. delivery.** `deferTerminalLifecycleEnd: true` on the attempt call prevents the attempt from emitting `end` itself. The agent-command emits `finishing` *before* `deliverAgentCommandResult`, the delivery runtime sends the assistant text to the channel, then the agent-command emits `end`. The live-model-switch test (`src/agents/agent-command.live-model-switch.test.ts:842-857`) asserts exactly this order:

```ts
expect(state.emitAgentEventMock.mock.invocationCallOrder[firstFinishingIndex] ?? 0)
  .toBeLessThan(deliveryOrder);
expect(deliveryOrder).toBeLessThan(
  state.emitAgentEventMock.mock.invocationCallOrder[lastEndIndex] ?? 0,
);
```

The agent-events bus is fan-out: anything that registers a listener (`registerListener`) gets every event. ReplyDispatcher subscribes to drive channel delivery and progress indicators; the trajectory recorder subscribes to write JSONL; the TUI subscribes to render. Chapter 11 walks the consumer side.

## 7.9 The non-visible-turn retry guard (PR #85603)

Sometimes the model returns *something* — usage counters tick up, the API call succeeds — but the user sees nothing. Three flavors:

- **Empty turn.** `usage.output > 0` but every content block is an empty assistant message. Some providers do this when the safety filter trips on the model output.
- **Reasoning-only.** Only `thinking` / hidden `reasoning` blocks are emitted; no `text` blocks. OpenAI codex-responses can do this when context is exhausted before the visible reply starts.
- **Tool-use terminal.** The last assistant message ended with `stop_reason: "tool_use"` but the post-tool reply never came.

`incomplete-turn.ts` (`src/agents/pi-embedded-runner/run/incomplete-turn.ts`) classifies these and decides whether to surface an error, request a silent reply, or *retry* with a continuation prompt. The retry decision is gated by `RETRY_GUARD_MODEL_APIS`:

```ts
// src/agents/pi-embedded-runner/run/incomplete-turn.ts:136-148
// Model APIs eligible for the non-visible turn retry guard.  OpenAI Responses
// family can produce reasoning-only turns where usage.output > 0 but no visible
// text is emitted; without the guard these pass through as successful. (#85364)
const RETRY_GUARD_MODEL_APIS = new Set([
  "openai-completions",
  "anthropic-messages",
  "bedrock-converse-stream",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "openclaw-openai-responses-transport",
  "openclaw-azure-openai-responses-transport",
]);
```

Before PR #85603 (commit `49e9c3eb13`), this set contained only `openai-completions`, `anthropic-messages`, and `bedrock-converse-stream`. OpenAI Codex-Responses turns that came back with hidden reasoning tokens passed through as "successful completions with no content delivered to the user." The fix added the full openai-responses family (`openai-responses`, `openai-codex-responses`, `azure-openai-responses`, and the `openclaw-*-transport` variants used by proxy plugins).

The retry is *not* a blind re-call. The continuation prompt is one of:

```ts
// src/agents/pi-embedded-runner/run/incomplete-turn.ts:201-208
export const PLANNING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn only described the plan. Do not restate the plan. Act now: ...";
export const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn ...";
export const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state ...";
export const ACK_EXECUTION_FAST_PATH_INSTRUCTION =
  "The latest user message is a short approval to proceed. Do not recap or restate the plan. ...";
```

The retry-limit is intentionally low (`DEFAULT_REASONING_ONLY_RETRY_LIMIT = 2`, `DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT = 1`, `src/agents/pi-embedded-runner/run/incomplete-turn.ts:153-154`) because the failure modes are mostly deterministic — burning ten retries on the same root cause doesn't help. The decision tree also bails out when the previous attempt had side effects (mutating tool calls, accepted child session spawns), because re-prompting could double-execute (`shouldSkipPlanningOnlyRetry`, `src/agents/pi-embedded-runner/run/incomplete-turn.ts:495-510`).

The `shouldApplyNonVisibleTurnRetryGuard` helper (`src/agents/pi-embedded-runner/run/incomplete-turn.ts:634-653`) is the actual gate. It returns true when:

- The provider/model is on the strict-agentic or Gemini incomplete-turn allowlist, **or**
- The model's API id is in `RETRY_GUARD_MODEL_APIS` (the PR #85603 addition), **or**
- The provider is Ollama (which can finish with thinking-only when constrained).

## 7.10 The empty-tools fix for proxy-like endpoints

The second narrow fix shipped in v2026.5.22 lives in the OpenAI transport. When an agent run has no client-provided tools but the conversation history contains prior `tool_use` blocks, the payload builder sets `tools: []` so the model can still parse the tool_use history (`src/agents/openai-transport-stream.ts:3403-3404`). For native OpenAI / Azure / OpenRouter this is fine. For *proxy-like* endpoints (vLLM, LocalAI, llama.cpp, LM Studio, and current OpenAI itself), `tools: []` is rejected by strict validators.

The fix (commit `75081569b0`):

```ts
// src/agents/openai-transport-stream.ts:3391-3413
if (supportsModelTools(model)) {
  if (context.tools) {
    params.tools = convertTools(context.tools, compat, model);
    if (options?.toolChoice) {
      params.tool_choice = options.toolChoice;
    } else if (
      compatDetection.capabilities.usesExplicitProxyLikeEndpoint &&
      Array.isArray(params.tools) &&
      params.tools.length > 0
    ) {
      params.tool_choice = "auto";
    }
  } else if (hasToolHistory(context.messages)) {
    params.tools = [];
  }
  if (
    compatDetection.capabilities.usesExplicitProxyLikeEndpoint &&
    Array.isArray(params.tools) &&
    params.tools.length === 0
  ) {
    delete params.tools;
    delete params.tool_choice;
  }
}
```

The `usesExplicitProxyLikeEndpoint` flag comes from `detectOpenAICompletionsCompat` (`src/agents/openai-completions-compat.ts`), which inspects the model's endpoint class and provider id. It is true for plugins that declare themselves as proxy-shaped (`copilot-proxy`, `litellm`, `vllm`, the zai/xiaomi/deepseek SDK consumers). The fix is narrow on purpose: native OpenAI / Azure / OpenRouter payloads are byte-identical to before.

Two things to notice about this code:

1. **The strip happens *after* the conditional that sets `tools = []`.** If the model has tool history but no current tools, the first branch sets `tools = []`; the second branch then strips it if the endpoint is proxy-like. The `tool_choice` (set above when tools are non-empty) is removed in lockstep so the request stays well-formed.
2. **`supersedes #70790` from the commit message** signals that an earlier patch addressed the same surface in fewer places (gateway-only, not the embedded runner or public SDK consumers). The new patch moves the policy to the canonical payload builder seam (`buildOpenAICompletionsParams`), so all three call paths — gateway, embedded runner, plugin-SDK — get it for free.

These two fixes together are characteristic of how `agent-command` evolves: small, surgical changes at well-chosen seams, often with a test pair (the PR includes 48 test lines in `run.incomplete-turn.test.ts` and 136 test lines in `openai-transport-stream.test.ts`).

## 7.11 The harness layer and the `isRawModelRun` escape hatch

One more wrinkle. Not every "agent command" is a real conversational turn. Two probe modes exist:

- **`opts.modelRun === true`** — raw model probe. Used by gateway `/models/probe` to confirm a model returns *something*. Skips bootstrap, tools, system prompt overlay, and workspace context. (`src/agents/agent-command.ts:324, 406, 422-424, 430-431, 440-441, 530-531`.)
- **`opts.promptMode === "none"`** — same effect via the prompt-mode dimension. Used by gateway model-list runtime checks.

When either flag is true, `isRawModelRun` (`src/agents/agent-command.ts:324, 531`) short-circuits ACP resolution (`agent-command.ts:576-580`), forces the harness id to `"pi"` (`src/agents/command/attempt-execution.ts:430-441`), and skips most of the workspace machinery. This keeps the same code path serving "is this provider reachable with this credential?" and "run a real turn for the user," at the price of one boolean threaded down through `runAgentAttempt`.

The harness layer itself — `src/agents/harness/policy.ts`, `src/agents/harness/selection.ts`, `src/agents/harness/runtime-plugin.ts` — decides which runtime actually executes the attempt. Possible values include `"pi"` (embedded runner), `"acpx"` (the ACP general-purpose backend), `"claude-cli"`, `"codex-cli"`, `"openai-codex"`, and whatever else provider plugins register. The decision draws on the configured agent harness preference, the provider id, the model id, and the auth-profile pin. Once selected, `ensureSelectedAgentHarnessPlugin` (`src/agents/harness/runtime-plugin.ts`) makes sure the plugin is loaded before the attempt runs.

## 7.12 Putting it together: a single turn

Putting the pieces in time order, a single non-ACP turn looks like this (call sites annotated):

1. **HTTP handler receives chat completion request**, builds `AgentCommandIngressOpts`, calls `agentCommandFromIngress` (e.g. `src/gateway/openai-http.ts:975`).
2. **`agentCommandFromIngress` validates `allowModelOverride` is set** and forwards to `agentCommandInternal` (`src/agents/agent-command.ts:1709-1722`).
3. **`prepareAgentCommandExecution`** loads runtime config, resolves agent id, normalizes session key, loads session entry, computes workspace and agent dirs, resolves manifest plugins, asks the ACP manager whether the session is bound to a child process (`src/agents/agent-command.ts:323-523`).
4. **If ACP is ready**, run `acpManager.runTurn`, accumulate visible deltas, persist transcript, build result, deliver, return (`src/agents/agent-command.ts:580-718`).
5. **Otherwise**, run the model-selection precedence (`src/agents/agent-command.ts:823-983`).
6. **Validate stored auth-profile override** against the chosen provider/runtime; clear it if incompatible (`src/agents/agent-command.ts:994-1042`).
7. **Resolve thinking level** with provider/model support check (`src/agents/agent-command.ts:1051-1099`).
8. **Resolve session transcript file** path (`src/agents/agent-command.ts:1100-1126`).
9. **Set up lifecycle callbacks**, `emitAgentEvent` closures, the trajectory recorder (`src/agents/agent-command.ts:1128-1217`).
10. **Enter the outer LiveSessionModelSwitch loop** (`src/agents/agent-command.ts:1218-...`).
11. **Inside the loop**, call `runWithModelFallback`, which iterates the fallback chain, calling `runAgentAttempt` per candidate (`src/agents/agent-command.ts:1235-1333`).
12. **`runAgentAttempt`** builds the prompt, streams the provider, runs the tool loop, applies the non-visible-turn retry guard, persists the assistant turn, returns an `AgentAttemptResult` (`src/agents/command/attempt-execution.ts:367-...`).
13. **Auto-fallback bookkeeping**: if the run landed on a fallback model, persist that as the session override so the next turn skips the broken primary (`src/agents/agent-command.ts:1337-1379`).
14. **Emit lifecycle "finishing"** (`src/agents/agent-command.ts:1392`).
15. **`deliverAgentCommandResult`** sends the assistant text to the configured channel and writes meta (`src/agents/command/delivery.runtime.ts`).
16. **Emit lifecycle "end"** (`src/agents/agent-command.ts:1158-1178`).
17. **Return the `AgentAttemptResult`** to the caller; the HTTP handler converts it to a `ChatCompletion` response (or to a streamed SSE response, when `stream: true`).

Throughout the run, `emitAgentEvent` is firing on multiple streams (`lifecycle`, `assistant`, `tool`, `item`, `thinking`, `error`, `compaction`, `approval`, `command_output`, `patch`). The TUI subscribes and renders; ReplyDispatcher subscribes and dispatches to channels; the trajectory recorder subscribes and writes JSONL. None of these consumers block the attempt — emission is fire-and-forget into the global event bus.

## 7.13 Lazy module loading: keeping cold-start small

A subtle but pervasive pattern in `agent-command.ts` is *lazy module loading*. The top of the file declares loader hooks for every runtime module the coordinator might need:

```ts
// src/agents/agent-command.ts:121-161 (excerpt)
const attemptExecutionRuntimeLoader = createLazyImportLoader<AttemptExecutionRuntime>(
  () => import("./command/attempt-execution.runtime.js"),
);
const acpManagerRuntimeLoader = createLazyImportLoader<AcpManagerRuntime>(
  () => import("../acp/control-plane/manager.js"),
);
const acpPolicyRuntimeLoader = createLazyImportLoader<AcpPolicyRuntime>(
  () => import("../acp/policy.js"),
);
...
const skillsRuntimeLoader = createLazyImportLoader<SkillsRuntime>(
  () => import("./skills.js"),
);
const skillsRemoteRuntimeLoader = createLazyImportLoader<SkillsRemoteRuntime>(
  () => import("../infra/skills-remote.js"),
);
```

Each call site that needs a heavy module awaits the loader, not the import directly:

```ts
const { getAcpSessionManager } = await loadAcpManagerRuntime();
const acpManager = getAcpSessionManager();
```

`createLazyImportLoader` (from `src/shared/lazy-promise.js`) caches the imported module after the first call. The effect is that a cold-start `openclaw agent send ...` invocation only loads the modules its branch actually touches:

- A raw model probe never loads the skills runtime, the ACP policy module, or the trajectory recorder.
- An ACP-bound session loads `acp-manager`, `acp-policy`, `attempt-execution.runtime` (for the ACP helpers) but skips the embedded pi runner.
- A normal embedded run loads everything except the ACP helpers.

This matters because the openclaw binary is one large Node bundle. The cold-start budget is measured in hundreds of milliseconds, and every `await import(...)` of a 50-KB module that doesn't get reached pays the user back. The pattern also keeps the top of `agent-command.ts` typecheck-fast — only the *types* of the runtime modules are imported at the static level (`type AttemptExecutionRuntime = typeof import("./command/attempt-execution.runtime.js")`, lines 104-119).

A related pattern is the **runtime façade**: `src/agents/command/attempt-execution.runtime.ts` is a 14-line file that re-exports the heavy `attempt-execution.ts`. Splitting the heavy module from its façade lets the agent-command layer reach for the façade (which the bundler can split out) without pulling the implementation into the agent-command chunk.

## 7.14 Sanitizing per-run overrides

When the caller passes `opts.provider` or `opts.model`, those strings reach the agent-command from outside the trust boundary. They could contain control characters, be megabytes long, or have leading/trailing whitespace. The validator is brief but important:

```ts
// src/agents/agent-command.ts:308-322
function normalizeExplicitOverrideInput(raw: string, kind: "provider" | "model"): string {
  const trimmed = raw.trim();
  const label = kind === "provider" ? "Provider" : "Model";
  if (!trimmed) {
    throw new Error(`${label} override must be non-empty.`);
  }
  if (trimmed.length > OVERRIDE_VALUE_MAX_LENGTH) {  // 256
    throw new Error(`${label} override exceeds ${String(OVERRIDE_VALUE_MAX_LENGTH)} characters.`);
  }
  if (containsControlCharacters(trimmed)) {
    throw new Error(`${label} override contains invalid control characters.`);
  }
  return trimmed;
}
```

`containsControlCharacters` (`src/agents/agent-command.ts:295-306`) rejects bytes in `0x00-0x1f` and `0x7f-0x9f`. Why bother? Two reasons:

1. **Log integrity.** A provider id containing `\n` would split a single log line into two, breaking JSONL parsers and security audits.
2. **Path integrity.** A model id is concatenated into session-store keys and into per-session transcript paths. A null byte in a path on macOS/Linux is a recipe for `ENOTDIR` at best and silent truncation at worst (the `stripNullBytes` helper at `src/agents/agent-scope.ts:45-48` exists for the same reason).

The list of fields that can be *cleared* by an override (`OVERRIDE_FIELDS_CLEARED_BY_DELETE`, `src/agents/agent-command.ts:252-265`) is also carefully maintained:

```ts
const OVERRIDE_FIELDS_CLEARED_BY_DELETE: OverrideFieldClearedByDelete[] = [
  "providerOverride",
  "modelOverride",
  "modelOverrideSource",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
  "fallbackNoticeSelectedModel",
  "fallbackNoticeActiveModel",
  "fallbackNoticeReason",
  "claudeCliSessionId",
];
```

The `persistSessionEntry` wrapper (line 269-278) passes this list to `persistSessionEntryBase` so that when an override is removed, *every related field* is removed atomically. A stored `modelOverrideFallbackOriginProvider` without a corresponding `modelOverride` would represent a state the system never intends; the explicit clear list prevents this from happening when a partial update is persisted.

## 7.15 Skills snapshot freshness and persistence

After model and credential are resolved, the agent-command computes the **skills snapshot** — the set of workspace-local skill files that should be rendered into the system prompt. This is the bridge between Chapter 09 (tools and skills) and the agent-command:

```ts
// src/agents/agent-command.ts:732-773 (abridged)
const [{ getSkillsSnapshotVersion, shouldRefreshSnapshotForVersion }, { matchesSkillFilter }] =
  await Promise.all([loadSkillsRefreshStateRuntime(), loadSkillsFilterRuntime()]);
const skillsSnapshotVersion = getSkillsSnapshotVersion(workspaceDir);
const skillFilter = resolveAgentSkillsFilter(cfg, sessionAgentId);
const currentSkillsSnapshot = sessionEntry?.skillsSnapshot;
const shouldRefreshSkillsSnapshot =
  !currentSkillsSnapshot ||
  shouldRefreshSnapshotForVersion(currentSkillsSnapshot.version, skillsSnapshotVersion) ||
  !matchesSkillFilter(currentSkillsSnapshot.skillFilter, skillFilter);
const needsSkillsSnapshot = isNewSession || shouldRefreshSkillsSnapshot;
const buildSkillsSnapshot = async () => {
  const [
    { buildWorkspaceSkillSnapshot },
    { getRemoteSkillEligibility },
    { canExecRequestNode },
  ] = await Promise.all([
    loadSkillsRuntime(), loadSkillsRemoteRuntime(), loadExecDefaultsRuntime(),
  ]);
  return buildWorkspaceSkillSnapshot(workspaceDir, {
    config: cfg,
    eligibility: {
      remote: getRemoteSkillEligibility({
        advertiseExecNode: canExecRequestNode({
          cfg, sessionEntry, sessionKey, agentId: sessionAgentId,
        }),
      }),
    },
    snapshotVersion: skillsSnapshotVersion,
    skillFilter,
    agentId: sessionAgentId,
  });
};
const skillsSnapshot = needsSkillsSnapshot
  ? await buildSkillsSnapshot()
  : !currentSkillsSnapshot
    ? undefined
    : await hydrateResolvedSkillsAsync(currentSkillsSnapshot, buildSkillsSnapshot);
```

Three things to notice:

1. **Per-session caching.** The previous run's snapshot is stored on the session entry. On the next turn, the agent-command checks if the snapshot is still fresh (same version, same filter) and skips the rebuild. For long-running conversations this saves a workspace scan every turn.

2. **Lazy hydration.** Even when the cached snapshot is "fresh enough," some skill content (e.g. remote skill bodies fetched from the host's skills store) needs to be lazily re-resolved if the cache was stripped between turns. `hydrateResolvedSkillsAsync` does that without forcing a full rebuild.

3. **Three-way load.** Building the snapshot touches three runtime modules that the cache path never needs: the skills builder, the remote-skills eligibility resolver, and the exec-defaults policy. They're loaded in parallel via `Promise.all`, but only when `needsSkillsSnapshot` is true. This is the lazy-loading pattern from §7.13 applied at the function level.

After the snapshot is computed, it is persisted back to the session store (`src/agents/agent-command.ts:775-796`) so the next turn can reuse it.

## 7.16 The Anthropic transport stream

For non-CLI, non-ACP runs that target Anthropic Messages (and Anthropic-on-Vertex, and Bedrock-on-Anthropic), the actual provider call lands in `createAnthropicMessagesTransportStreamFn` (`src/agents/anthropic-transport-stream.ts:918`). It is a `StreamFn` that returns a writable transport event stream:

```ts
// src/agents/anthropic-transport-stream.ts:918-955 (abridged)
export function createAnthropicMessagesTransportStreamFn(): StreamFn {
  return (rawModel, context, rawOptions) => {
    const model = rawModel as AnthropicTransportModel;
    const options = rawOptions as AnthropicTransportOptions | undefined;
    const { eventStream, stream } = createWritableTransportEventStream();
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant", content: [], api: "anthropic-messages",
        provider: model.provider, model: model.id,
        usage: createEmptyTransportUsage(), stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
        if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
        const transportOptions = resolveAnthropicTransportOptions(model, options, apiKey);
        const { client, isOAuthToken } = createAnthropicTransportClient({ ... });
        let params = buildAnthropicParams(model, context, isOAuthToken, transportOptions);
        const nextParams = await transportOptions.onPayload?.(params, model);
        if (nextParams !== undefined) params = nextParams as Record<string, unknown>;
        const anthropicStream = client.messages.stream(
          { ...params, stream: true },
          transportOptions.signal ? { signal: transportOptions.signal } : undefined,
        );
        stream.push({ type: "start", partial: output as never });
        ...
```

The agent-command never calls this directly. The attempt-execution runtime resolves the right `StreamFn` for the model API at `src/agents/command/attempt-execution.ts:367-…` and passes it through `runAgentAttempt`. From the agent-command's perspective, this is a black box that emits `text_delta`, `thinking_delta`, `tool_use_*`, and `done` events on a stream the runner already knows how to consume. (Chapter 08 walks the transport in depth.)

Two pieces of this code reach back into the agent layer worth flagging:

- **`transportOptions.onPayload`** is the hook that lets `wrapStreamFn` (provided by the Anthropic plugin's `register.runtime.ts`) mutate the outbound payload. This is how `anthropic-beta` headers, cache_control markers, and service_tier flags get applied without the host having to know what they mean.
- **`buildAnthropicParams`** consults `resolveAnthropicPayloadPolicy` from `src/agents/anthropic-payload-policy.ts`. That module exists in the agent layer (not in the provider plugin) because the host owns the wire-shape canonicalization. The plugin contributes via the wrapper, not by replacing the builder.

## 7.17 Anthropic-specific payload bookkeeping

Two utility files exist purely for Anthropic-shaped providers (real Anthropic, Vertex-hosted Claude, Bedrock-hosted Claude via the converse API):

- **`src/agents/anthropic-payload-policy.ts`** — resolves cache-control TTL (`"ephemeral"` with optional `1h`) based on endpoint hostname and explicit retention opt-ins; resolves `service_tier` (`"auto"` vs `"standard_only"`); applies `cache_control` markers to the system prompt blocks. The hostname allowlist for long-TTL caching is small:
  ```ts
  // src/agents/anthropic-payload-policy.ts:40-53
  function isLongTtlEligibleEndpoint(baseUrl: string | undefined): boolean {
    ...
    return (
      hostname === "api.anthropic.com" ||
      hostname === "aiplatform.googleapis.com" ||
      hostname.endsWith("-aiplatform.googleapis.com")
    );
  }
  ```

- **`src/agents/anthropic-payload-log.ts`** — when `OPENCLAW_ANTHROPIC_PAYLOAD_LOG=1`, every outbound request and every usage callback gets a JSONL line written under `state/logs/anthropic-payload.jsonl`. Payloads are redacted via `sanitizeDiagnosticPayload` before write, and a SHA-256 digest of the original is included so two log lines can be correlated without leaking content. This is a debug-only opt-in, but its presence in the agent layer (rather than the provider plugin) tells you that *the host* owns the wire-level diagnostic trail, not the provider plugin.

Both files are deprecated for third-party consumers (their type aliases carry `@deprecated` tags), which is the right design: provider plugins should not reach across into host-side payload policy. The lift-out path is the plugin-SDK's `provider-stream-shared` module (Chapter 08).

## 7.18 What we left for later

This chapter walked the coordinator. Three big topics are deferred to neighboring chapters:

- **System-prompt assembly**, including the bootstrap context block, skills snapshot rendering, tool descriptions, identity injection, and provider-specific overlays. Entry point `src/gateway/agent-prompt.ts`; the embedded prompt-mode handling at `src/agents/agent-command.ts:1196-1200` is the only piece relevant here.
- **Tool execution** — bash, web-fetch, web-search, agent-step (subagent spawn), patch tools, MCP tools. Each is its own subsystem. Chapter 09 covers them.
- **LLM provider integration** — the actual SSE wire format, the unified streaming events, the provider plugin contract, the operation-retry classifier. Chapter 08 next.

The throughline is: `agent-command` is *coordination*, not LLM logic. The fact that `agent-command.ts` is 1730 lines without doing any LLM work directly is itself the design statement.
