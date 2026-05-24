# Tour Step 11: Entering the agent command

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

The `ReplyDispatcher` from the previous step is constructed and inert. The gateway has called `dispatchInboundMessage` (`src/auto-reply/dispatch.ts:246-292`), which has called `dispatchReplyFromConfig` (`src/auto-reply/reply/dispatch-from-config.ts:744`), which has just finished the `message_received` hook fan-out and the abort-runtime check. The dispatcher is hooked into the agent's event stream through `getReplyOptions()` (`dispatch-from-config.ts:937`). The next call is:

```ts
// src/auto-reply/reply/dispatch-from-config.ts:1883-1893
const replyResult = await runWithReplyOperationAbort(dispatchAbortOperation, () =>
  traceReplyPhase("reply.run_reply_resolver", () =>
    replyResolver(
      ctx,
      {
        ...getReplyOptions(),
        sourceReplyDeliveryMode,
        suppressToolErrorWarnings,
        typingPolicy: typing.typingPolicy,
        ...
```

`replyResolver` is `getReplyFromConfig` (`src/auto-reply/reply/get-reply.ts:205`). Inside it, the agent runtime — the layered selection of "what version of the agent runs for this turn" — is built and a single agent attempt is launched.

For trace purposes the WebChat path eventually reaches `runWithModelFallback` at `src/auto-reply/reply/agent-runner-execution.ts:1612`, the same primitive that the CLI entrypoint `agentCommand` (`src/agents/agent-command.ts:1235`) uses. Both paths converge on `attempt-execution.runtime.ts:runAgentAttempt`. For this tour we trace the resolution layer — the part that decides *which* agent runtime, *which* model, *which* auth profile — independent of whether the entry was the CLI or the gateway.

End state of this step: the agent runtime metadata is resolved, the auth profile is chosen, the ACP-vs-embedded decision is made, an attempt record is created in "pending" state, and the next call is `runAgentAttempt`, which will build the prompt and stream events. The agent has not yet been spoken to.

## 2. The problem

OpenClaw is a multi-agent host. "The agent" is not a single thing. A single OpenClaw deployment can have:

- Several configured agent ids (`cfg.agents.list[]`), each with its own model, system prompt, skill filter, sub-agent budget, workspace directory.
- Per-session model overrides — a user can `/model gpt-5` and the session entry remembers it across turns.
- Per-call model overrides — an ingress request can specify `modelOverride` for one turn only.
- Provider auth profiles with rotation — multiple OAuth credentials for the same provider, chosen per turn.
- Multiple harness runtimes — embedded Pi, Claude Code ACP, OpenAI Codex, each with different streaming protocols.
- Skill snapshots that can be stale and need refresh.
- Sub-agent vs main lane vs heartbeat lane, all sharing the same code.

The host must choose all of these before spawning the agent, in a way that:

- a malicious ingress request cannot escape its scope (network-facing callers must opt in to per-call overrides);
- a user-set session override survives across compactions but is invalidated if the configured allowlist changes;
- a model that becomes unavailable triggers a fallback to the next configured model *without* losing the session's user-friendly model name in the UI;
- a model that vanished from the visibility policy gets cleared from the session entry so the user is not stuck with a "model not allowed" loop;
- auth profile incompatibilities (e.g., a stored OpenAI profile when the resolved provider is Anthropic) are detected and recovered from.

If any of these are baked into the dispatcher, the codebase loses the ability to evolve agents independently.

## 3. Naive approach

Hard-code a single model, a single provider, a single system prompt. The "agent" is a function:

```ts
async function runAgent(prompt: string): Promise<string> {
  const anthropic = new Anthropic();
  return anthropic.messages.create({
    model: "claude-3-5-sonnet-20241022",
    messages: [{ role: "user", content: prompt }],
  });
}
```

The dispatcher calls it. Done.

## 4. Why the naive approach breaks

- **No per-session model override.** Every user is locked to the host's default. A workspace that needs Opus 4.7 for the orchestrator and Haiku for the cheap sub-agent cannot express that.
- **No skill adoption.** The agent's tool catalogue must be discovered from the workspace's `skills/` directory at runtime. Hard-coding "the agent" means the user cannot add a skill without redeploying.
- **No provider rotation.** When the Anthropic API returns 529 (overloaded), the host has nowhere to send the next turn. The user sees a permanent error instead of a graceful fallback to the configured backup model.
- **No multi-agent.** If a user wants two agents — say, a coding agent with one system prompt and a chat agent with another — the naive design has no place to put the second.
- **No ACP.** Anthropic's Claude Code Agent Connector Protocol (ACP) is a different streaming protocol than the embedded harness. The host needs to decide per-session whether to spawn an ACP child or run the embedded loop. The naive design has nowhere to make that choice.
- **No auth profile selection.** A user with two OpenAI keys cannot rotate between them; a user with an Anthropic OAuth token has no way to attach it to the right turns.

These failures all share a root cause: the *runtime configuration* — model, provider, harness, auth, skills, workspace — has been conflated with *the agent function*. Decoupling them is the entire job of this step.

## 5. OpenClaw's approach

OpenClaw's approach is to **separate the agent execution into two phases — a resolution phase and an execution phase — and to layer the resolution itself: session override → agent scope → global default**, each layer optional, each layer accountable, and each layer guarded by a visibility policy that can refuse a stale override.

The resolution phase happens in `prepareAgentCommandExecution` (`src/agents/agent-command.ts:323-524`) for the CLI entry, and in the equivalent block at `src/auto-reply/reply/get-reply.ts:205-300` for the gateway entry. Both paths perform the same five resolutions, in the same order.

**Layer one: the agent id.** Three sources, in priority order:

1. Explicit `--agent <id>` flag (or `agentId` parameter on the ingress call). Validated against `listAgentIds(cfg)` at `src/agents/agent-command.ts:347-355`. If unknown, the call throws with a "use `openclaw agents list`" message.
2. Embedded in the session key. A session key like `agent:coding:webchat:abc` carries its agent id; `resolveAgentIdFromSessionKey` (`src/routing/session-key.ts`) extracts it.
3. `resolveDefaultAgentId(cfg)` (`src/agents/agent-scope-config.ts:87-99`), which walks `cfg.agents.list[]`, takes the first entry with `default: true`, warns if multiple defaults are configured, and falls back to `DEFAULT_AGENT_ID` if no agents are configured at all.

For the "hello" trace with no overrides, the WebChat session key embeds `default`, so the agent id is `default`.

**Layer two: the runtime config.** `resolveAgentRuntimeConfig` (`src/agents/agent-runtime-config.ts:8-48`) loads the runtime config and, if any secret refs are present (provider API keys, skills entries, TTS providers), resolves them through the secret store via `resolveCommandConfigWithSecrets`. The fast path is the unwrapped config; the slow path snapshots the resolved result so downstream code never sees an unresolved `SecretRef`. The cache is global; subsequent turns reuse the snapshot.

**Layer three: the model.** Three sources, also in priority order:

1. Per-call override via `opts.model` / `opts.provider`. Network ingress paths gate this with `allowModelOverride`: `agentCommandFromIngress` (`agent-command.ts:1709-1722`) refuses to call into the internal function unless the caller explicitly sets `allowModelOverride: true`. The trusted `agentCommand` entry (used by CLI) sets it to `true` by default. The check at `agent-command.ts:853-855` throws "Model override is not authorized for this caller." if the caller forgot.
2. Per-session override stored on the `SessionEntry` (`modelOverride`, `providerOverride`, `modelOverrideSource`). Resolved at `agent-command.ts:921-935`. Subject to a visibility policy.
3. The configured default for the agent, via `resolveDefaultModelForAgent({ cfg, agentId })` (`src/agents/model-selection.ts`).

The visibility policy is the gatekeeper. `createModelVisibilityPolicy` (`src/agents/model-visibility-policy.ts`) builds a per-agent allowlist from `cfg.agents.defaults.models`. Before any model is accepted, `visibilityPolicy.allowsKey(modelKey(provider, model))` must return `true`. If a stored override is no longer allowed (the config changed), the override is silently cleared and the default is used (`agent-command.ts:902-918`). The user is not stuck.

**Layer four: the runtime metadata (harness).** `resolveAgentRuntimeMetadata` (`src/agents/agent-runtime-metadata.ts:8-17`) returns the unparameterised metadata `{ id: "auto", source: "implicit" }`. The parameterised variant `resolveModelAgentRuntimeMetadata` (`src/agents/agent-runtime-metadata.ts:19-55`) is where the actual harness decision is made:

```ts
const policy = resolveAgentHarnessPolicy({
  provider: resolved.provider,
  modelId: resolved.model,
  config: params.cfg,
  agentId: params.agentId,
  sessionKey: params.sessionKey,
});
const meta: AgentRuntimeMetadata = {
  id: policy.runtime,
  source: policy.runtimeSource ?? "implicit",
};
return applyAcpRuntimeOverlay(meta, params.sessionKey, params.acpRuntime, params.acpBackend);
```

`policy.runtime` is the harness id — `embedded-pi`, `acp`, or another registered backend. `applyAcpRuntimeOverlay` (`src/agents/acp-runtime-overlay.ts`) handles the case where the session has persisted ACP metadata: an ACP-shaped session keeps its ACP backend identifier even if the model itself could run on the embedded harness.

For our "hello" with Anthropic provider and default model, the policy returns `embedded-pi` and the overlay is a no-op (no ACP metadata on the session). For a session that was previously spawned through ACP (`acp-spawn.ts`), the overlay would route the turn through the ACP control plane (`agent-command.ts:580-718`).

**Layer five: the auth profile.** Resolved at `agent-command.ts:994-1042`. The session-side override stores an `authProfileOverride` id; the host validates it against the resolved provider's accepted auth providers (`listOpenAIAuthProfileProvidersForAgentRuntime`). If a stored profile is incompatible with the resolved provider (e.g., an OpenAI profile bound to a session that's now using Anthropic), the host clears it and re-resolves the default. This is silent recovery, the same shape as the model-allowlist case.

After all five layers, the call site logs the lifecycle start, registers the run context via `registerAgentRunContext` (`src/infra/agent-events.ts`), builds a trajectory recorder (`src/trajectory/runtime.ts`), and enters `runWithModelFallback` (`src/agents/model-fallback.ts`):

```ts
// src/agents/agent-command.ts:1218-1288 (excerpt)
for (;;) {
  try {
    const fallbackResult = await runWithModelFallback<AgentAttemptResult>({
      cfg, provider, model,
      runId, agentDir, agentId: sessionAgentId,
      sessionKey: sessionKey ?? sessionId,
      prepareAgentHarnessRuntime: async ({ provider, model, agentHarnessRuntimeOverride }) => {
        await ensureSelectedAgentHarnessPlugin({ config: cfg, provider, modelId: model, ... });
      },
      fallbacksOverride: effectiveFallbacksOverride,
      onFallbackStep: (step) => fallbackTrajectoryRecorder?.recordEvent("model.fallback_step", step),
      classifyResult: ({ provider, model, result }) =>
        classifyEmbeddedPiRunResultForModelFallback({ provider, model, result }),
      run: async (providerOverride, modelOverride, runOptions) => {
        ...
        return attemptExecutionRuntime.runAgentAttempt({
          providerOverride, modelOverride, ...
        });
      },
    });
```

`runWithModelFallback` walks `[primary, fallback1, fallback2, ...]` and stops on the first classifyResult that reports "this is a real reply, not a transient error". On each step it calls `prepareAgentHarnessRuntime` to load the right harness plugin, then `run(provider, model, opts)`, then classifies. The actual attempt — prompt build, stream open, tool-call loop — happens inside `runAgentAttempt` (`src/agents/command/attempt-execution.runtime.ts`); the dispatcher wired in via `getReplyOptions()` receives the live events, and the return value is the post-hoc summary.

This step ends here. The attempt record is created in "pending" state inside `attemptLifecycleState` (`agent-command.ts:1129-1133`), the lifecycle callbacks are installed (lines 1134-1194), and Step 12 will be the prompt build.

## 6. Code locations

- `src/agents/agent-command.ts:1681-1722` — the two entrypoints: trusted `agentCommand` (defaults `senderIsOwner` and `allowModelOverride` to `true`) and `agentCommandFromIngress` (refuses unless `allowModelOverride` is explicit).
- `src/agents/agent-command.ts:323-524` — `prepareAgentCommandExecution`, the resolution phase; agent-id validation at 347-355; session resolution at 407-413 via `resolveSession` (`src/agents/command/session.ts`).
- `src/agents/agent-command.ts:823-918` — model resolution with visibility policy and stale-override clearing.
- `src/agents/agent-command.ts:985-992` — `ensureSelectedAgentHarnessPlugin` loads the right harness backend.
- `src/agents/agent-command.ts:994-1042` — auth profile validation and silent recovery.
- `src/agents/agent-command.ts:1128-1218` — attempt lifecycle state and lifecycle event emitters.
- `src/agents/agent-command.ts:1235-1335` — `runWithModelFallback` invocation wrapping each `runAgentAttempt`.
- `src/agents/agent-command.ts:580-718` — the ACP fast path: when a session has ACP metadata, the turn is driven through `acpManager.runTurn` instead.
- `src/agents/agent-runtime-config.ts:8-48` — `resolveAgentRuntimeConfig`, secret resolution and snapshot install.
- `src/agents/agent-runtime-config.ts:63-101` — `hasAgentRuntimeSecretRefs`, the fast-skip predicate.
- `src/agents/agent-runtime-metadata.ts:19-55` — `resolveModelAgentRuntimeMetadata`, parameterised harness selection with ACP overlay.
- `src/agents/agent-scope-config.ts:69-99` — `listAgentIds` and `resolveDefaultAgentId`.
- `src/agents/agent-scope.ts:25-42` — re-exports of `listAgentIds`, `resolveAgentConfig`, `resolveAgentDir`, `resolveAgentWorkspaceDir`, `resolveDefaultAgentId`.
- `src/agents/model-selection.ts` — `resolveDefaultModelForAgent`, `resolveConfiguredModelRef`, `parseModelRef`, `normalizeModelRef`, `modelKey`.
- `src/agents/model-visibility-policy.ts` — `createModelVisibilityPolicy` and `allowsKey`.
- `src/agents/model-fallback.ts` — `runWithModelFallback`.
- `src/agents/acp-spawn.ts:1-60` — ACP spawn primitives. Used only when materialising a new ACP session.
- `src/agents/command/attempt-execution.runtime.ts` — `runAgentAttempt`.
- `src/auto-reply/reply/agent-runner-execution.ts:1612-1681` — the gateway-path `runWithModelFallback` invocation reaching the same `runAgentAttempt`.
- `src/auto-reply/reply/get-reply.ts:205-300` — `getReplyFromConfig`, the gateway-side resolver mirroring `prepareAgentCommandExecution`.

## 7. Branches and extensions

The two entry points (`agentCommand`, `agentCommandFromIngress`) and the gateway path through `getReplyFromConfig` all converge on `runWithModelFallback` → `runAgentAttempt`. The convergence is what makes "the same agent" mean the same thing whether the user typed `openclaw agent --message hello` at the CLI or sent `chat.send` to the gateway from WebChat.

ACP is a fork in the road. When the session has stored ACP metadata (`entry.acp.backend` is set), the code path bypasses the embedded harness loop entirely. `acpManager.runTurn` (`src/acp/control-plane/manager.ts`) drives the turn over the ACP wire protocol, and `runAgentAttempt` is never called. The split happens at `agent-command.ts:580-583`. The decision is made before the dispatcher because ACP turns have a different lifecycle event shape (`emitAcpLifecycleStart`, `emitAcpRuntimeEvent`, `emitAcpLifecycleEnd`).

The `runWithModelFallback` loop is reused for sub-agents. When `agent-step.ts` (`src/agents/tools/agent-step.ts:67`) invokes `agentCommandFromIngress` to spawn a sub-agent, it goes through the same resolution layers — sub-agent's own session key, sub-agent's own agent id, sub-agent's own model. Sub-agent depth is enforced via `DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH` (`src/config/agent-limits.ts`).

The auto-fallback primary probe (`agent-command.ts:936-950`) is a self-healing mechanism. Every five minutes a session that previously fell back to a secondary model is re-tested against the primary; if the primary now works, the session naturally migrates back. The probe state lives in `autoFallbackPrimaryProbeState` (`agent-scope.ts:52`), capped at 4096 keys.

Further reading in the reference chapters:

- [Chapter 07 §2 — `runAgentCommand` and the two entry points](./07-agent-runtime.md#2-runagentcommand-and-the-two-entry-points).
- [Chapter 07 §3 — Runtime resolution: session override → agent scope → global default](./07-agent-runtime.md#3-runtime-resolution-session-override--agent-scope--global-default).
- [Chapter 07 §7 — ACP: when the session is owned by an external agent process](./07-agent-runtime.md#7-acp-when-the-session-is-owned-by-an-external-agent-process).

## 8. What you should now have in your head

- "The agent" is **not one thing**. It is the composition of (agent id) × (provider/model) × (auth profile) × (harness runtime) × (skill snapshot) × (workspace dir). Each is resolved from a layered set of sources: per-call override → per-session override → per-agent default → global default. Each layer is optional, each layer is auditable.
- **Network-facing callers cannot override silently.** `agentCommandFromIngress` refuses to run unless the caller explicitly opts into `allowModelOverride`. The CLI entry (`agentCommand`) opts in by default. The asymmetry is the security boundary.
- **Stale overrides self-heal.** Model-allowlist changes, vanished auth profiles, broken-harness sessions — all are detected at resolution time and silently re-resolved to defaults. The user is never stuck.
- **ACP forks early.** Sessions with persisted ACP metadata bypass `runWithModelFallback` and `runAgentAttempt` and instead drive the turn through `acpManager.runTurn`. The split happens before the dispatcher emits anything to the agent.
- The next step (prompt build) runs *inside* `runAgentAttempt`. By the time it starts, the runtime is fully resolved and the attempt is registered in the lifecycle state. There is no further "which agent" decision to make.
