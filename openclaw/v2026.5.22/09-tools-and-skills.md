# Chapter 09 — Tools and Skills System

Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

OpenClaw's "tool layer" is the surface a language model sees. The agent receives a list of tool descriptors, decides to emit `tool_use`, and the gateway must do four things very precisely: (1) match the call to the right implementation, (2) check whether the tool is presently usable, (3) gate sensitive calls behind operator approval, and (4) marshal the result back into the transcript. Doing those four things while staying lean and plugin-agnostic is the design goal of `src/tools/`, `src/agents/`, and `src/mcp/`.

This chapter walks the catalog, the dispatch, the approval flow, the MCP bridge, and the tool-search surface that lets a model browse and call tools by name. It deliberately stops short of agent-level prompt building (covered in chapter 04) and channel-level message handling (covered in chapter 05).

## 1. Vocabulary: tools vs. skills

OpenClaw uses both words and they are not synonyms.

- **Tool** — a single callable function exposed to the LLM. It has a stable `name`, a human-readable `description`, a JSON-schema `inputSchema`, an owner (core, plugin, channel, or MCP server), and an executor reference. The descriptor is the contract the model sees; the executor is the implementation the gateway runs.
- **Skill** — an operator-facing bundle that ships a prompt, an allowed tool list, and supporting files. A skill is loaded *into a session* via the agent's harness configuration. Skills live under `.agents/skills/<id>/SKILL.md` (operator skills), under each plugin via the manifest `skills` field (plugin-bundled skills), and under per-agent directories. The agent harness materializes them as system-prompt contributions plus an allowlist.

The split matters because tools are model-visible and called per turn; skills are prompt-visible and bound per session. A tool change requires registry plumbing and dispatch wiring. A skill change is metadata: drop a Markdown file into the right directory and the next session picks it up.

This chapter focuses on tools. Skill loading is covered briefly in section 7 because it is where the two systems meet.

<svg viewBox="0 0 920 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="tool registration and resolution"><defs><marker id="r91arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#64748b"/></marker></defs><rect x="0" y="0" width="920" height="380" fill="#f1f5f9"/><rect x="20" y="20" width="200" height="120" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/><text x="120" y="50" text-anchor="middle" font-family="ui-sans-serif" font-size="15" font-weight="700" fill="#ea580c">Tool sources</text><text x="120" y="75" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">core (src/agents)</text><text x="120" y="93" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">plugin tools</text><text x="120" y="111" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">channel actions</text><text x="120" y="129" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">MCP servers</text><rect x="260" y="20" width="220" height="120" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="2"/><text x="370" y="50" text-anchor="middle" font-family="ui-sans-serif" font-size="15" font-weight="700" fill="#7c3aed">defineToolDescriptor</text><text x="370" y="75" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">name, description,</text><text x="370" y="93" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">inputSchema, owner,</text><text x="370" y="111" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">executor, availability</text><text x="370" y="129" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">src/tools/descriptors.ts</text><rect x="520" y="20" width="200" height="120" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="2"/><text x="620" y="50" text-anchor="middle" font-family="ui-sans-serif" font-size="15" font-weight="700" fill="#0d9488">buildToolPlan</text><text x="620" y="75" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">sort by sortKey/name</text><text x="620" y="93" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">assert unique names</text><text x="620" y="111" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">evaluate availability</text><text x="620" y="129" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">→ visible + hidden</text><rect x="760" y="20" width="140" height="120" rx="8" fill="#e2e8f0" stroke="#475569" stroke-width="2"/><text x="830" y="50" text-anchor="middle" font-family="ui-sans-serif" font-size="15" font-weight="700" fill="#1e293b">model</text><text x="830" y="75" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">protocol</text><text x="830" y="93" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">descriptor</text><text x="830" y="111" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">{name, desc,</text><text x="830" y="129" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">inputSchema}</text><path d="M 220 80 L 256 80" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r91arrow)"/><path d="M 480 80 L 516 80" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r91arrow)"/><path d="M 720 80 L 756 80" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r91arrow)"/><rect x="20" y="190" width="880" height="170" rx="8" fill="#ffffff" stroke="#cbd5e1" stroke-width="2"/><text x="40" y="220" font-family="ui-sans-serif" font-size="15" font-weight="700" fill="#7c3aed">Dispatch path on tool_use</text><text x="40" y="248" font-family="ui-mono,monospace" font-size="12" fill="#1e293b">1. extract name from tool_use block</text><text x="40" y="268" font-family="ui-mono,monospace" font-size="12" fill="#1e293b">2. lookup executor: core | plugin:&lt;id&gt; | channel:&lt;id&gt; | mcp:&lt;server&gt;</text><text x="40" y="288" font-family="ui-mono,monospace" font-size="12" fill="#1e293b">3. wrap with before_tool_call hook (approval gate, policy)</text><text x="40" y="308" font-family="ui-mono,monospace" font-size="12" fill="#1e293b">4. execute, marshal result (content blocks) back to transcript</text><text x="40" y="328" font-family="ui-mono,monospace" font-size="12" fill="#1e293b">5. fire after_tool_call + tool_result_persist hooks</text><text x="40" y="348" font-family="ui-sans-serif" font-size="11" fill="#64748b">src/agents/pi-tools.before-tool-call.ts, src/mcp/plugin-tools-handlers.ts, src/tools/execution.ts</text></svg>
<span class="figure-caption">Figure R9.1 | Tool registration: descriptors flow from sources through `buildToolPlan` to the model, and dispatch flows back through executor refs with hook wrapping.</span>
<details><summary>ASCII original</summary>
```
+----------------+   +------------------------+   +----------------+   +-----------+
| Tool sources   |-> | defineToolDescriptor   |-> | buildToolPlan  |-> |   model   |
| core / plugin  |   | name desc schema owner |   | sort, unique,  |   | protocol  |
| channel / MCP  |   | executor availability  |   | availability   |   | descriptor|
+----------------+   +------------------------+   +----------------+   +-----------+

Dispatch on tool_use:
1. extract name
2. lookup executor (core | plugin | channel | mcp)
3. wrap with before_tool_call (approval, policy)
4. execute, marshal content blocks
5. fire after_tool_call + tool_result_persist
```
</details>

## 2. The tool catalog: shape of a descriptor

Every tool, regardless of origin, must produce a `ToolDescriptor`. The type lives at `src/tools/types.ts:38-51`:

```ts
export type ToolDescriptor = {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly owner: ToolOwnerRef;
  readonly executor?: ToolExecutorRef;
  readonly availability?: ToolAvailabilityExpression;
  readonly annotations?: JsonObject;
  readonly sortKey?: string;
};
```

Five things are load-bearing:

1. **`name`** is the wire name. Models call by name. Two descriptors with the same name collide and `buildToolPlan` rejects the registry — see `assertUniqueNames` at `src/tools/planner.ts:20-32`.
2. **`description`** is what the model reads when deciding to call. It is the *contract surface*; rewording it changes model behavior, so OpenClaw treats descriptions like API copy.
3. **`inputSchema`** is a plain JSON-schema object. The model uses it to construct arguments; the gateway uses it to validate the call before dispatch.
4. **`owner` and `executor`** are discriminated unions (`src/tools/types.ts:11-22`) that tell the gateway *who* registered the tool and *how* to run it. The four kinds — `core`, `plugin`, `channel`, `mcp` — flow through dispatch unchanged.
5. **`availability`** is a structured expression evaluated against the current runtime (auth providers configured, env vars set, plugin enabled, config path populated, context flag true). It is the reason the same tool list looks different on different installs.

The helper `defineToolDescriptor` at `src/tools/descriptors.ts:1-11` is the identity function. Its purpose is to push descriptor objects through a typed gate so that TypeScript narrows them at the call site; it does not register or store anything. Registration happens later via channel/plugin/MCP plumbing, and `buildToolPlan` collects the descriptors into a sorted plan.

### Owner and executor refs

The two refs serve different roles. `ToolOwnerRef` answers "whose tool is this?" — useful for capability gates, billing, and inventories. `ToolExecutorRef` answers "where do I dispatch the call?" — useful for the resolver. They can diverge: a channel-owned tool can have a plugin executor when the channel plugin wires its actions to a shared runtime.

The executor's wire format is just a string, but the gateway never serializes it that way. The format helper at `src/tools/execution.ts:1-20` produces strings like `core:exec`, `plugin:browser:click`, `channel:discord:send`, or `mcp:notion:search` — strictly for logs, diagnostics, and error messages.

### Availability is a small DSL

`ToolAvailabilitySignal` enumerates the cheap, manifest-friendly checks the planner can make without loading runtime code (`src/tools/types.ts:23-32`):

- `always` — the tool is ungated.
- `auth` — a specific auth provider id must be configured.
- `config` — a dotted config path must exist (`exists`), be non-empty (`non-empty`), or be deemed available by a custom probe (`available`).
- `env` — an environment variable must be non-empty.
- `plugin-enabled` — a plugin id must be in the enabled set.
- `context` — a session-scoped context key must be present (and optionally match).

These signals compose into `allOf` / `anyOf` trees (`src/tools/types.ts:34-37`). Empty groups are explicitly rejected so a typo can't silently let everything through:

```ts
if (expression.allOf.length === 0) {
  return [{ reason: "unsupported-signal", message: "Empty availability allOf group" }];
}
```
(`src/tools/availability.ts:120-126`)

Evaluation walks the tree and accumulates diagnostics. For `anyOf` it returns no diagnostics when at least one branch passes (`src/tools/availability.ts:131-135`). For `allOf` it flattens the failures so callers can show every reason a tool was hidden.

### Plan output: visible vs. hidden

`buildToolPlan` returns `{ visible, hidden }`. Visible entries carry an executor and are ready to dispatch. Hidden entries carry diagnostics ("missing auth provider X", "config path tools.web.search.provider is empty") so the gateway can surface *why* a tool is unavailable instead of silently dropping it. The `/help tools` UI and `openclaw doctor` both consume this shape.

A key contract: a visible tool *must* declare an executor. `buildToolPlan` throws `ToolPlanContractError` if a visible descriptor is missing one (`src/tools/planner.ts:47-52`). This is the seam that prevents "ghost tools" — descriptors that look callable but have nowhere to dispatch to.

### Protocol projection

The model doesn't see owner refs, executor refs, or availability. It sees only the protocol descriptor — name, description, inputSchema. That projection is one function:

```ts
export function toToolProtocolDescriptor(entry: ToolPlanEntry): ToolProtocolDescriptor {
  return {
    name: entry.descriptor.name,
    description: entry.descriptor.description,
    inputSchema: entry.descriptor.inputSchema,
  };
}
```
(`src/tools/protocol.ts:10-16`)

That deliberate slimness is why the same descriptor shape can target Anthropic, OpenAI, Codex, and Pi: provider adapters take the protocol descriptor and shape it into the on-the-wire format they need.

## 3. The core tool catalog at a glance

The biggest single source of tools is `src/agents/openclaw-tools.ts` — the OpenClaw agent's native toolkit. Reading the import list (`src/agents/openclaw-tools.ts:1-58`) is a quick tour:

- File-system primitives — `read`, `write`, `edit`, `apply_patch` (Pi coding tools).
- Runtime — `exec`, `process`, `code_execution` (sandbox/remote).
- Web — `web_search`, `web_fetch`.
- Sessions — `sessions_list`, `sessions_send`, `sessions_spawn`, `sessions_history`, `session_status`, `sessions_yield`.
- Subagents — `subagents`, `agents_list`.
- Media — `image_generate`, `video_generate`, `music_generate`, `tts`, `image`, `pdf`.
- UI / Plan — `update_plan`, `message`, `heartbeat_response`.
- Automation — `nodes`, `cron`, `gateway`.

The static description summaries that the model sees come from a single preset file `src/agents/tool-description-presets.ts` so that wording stays consistent. The display-side metadata (catalog labels, sections, profiles) lives in `src/agents/tool-catalog.ts`, which groups tools into eleven sections (`fs`, `runtime`, `web`, `memory`, `sessions`, `ui`, `messaging`, `automation`, `nodes`, `agents`, `media`) and four profiles (`minimal`, `coding`, `messaging`, `full`) — see `src/agents/tool-catalog.ts:39-52`.

The catalog isn't a registry of executors; it's a description of the *intent* of the tools. The executor registry sits one layer down at `src/agents/pi-tools.ts` (the Pi coding-agent integration) and on a per-tool basis in `src/agents/tools/*-tool.ts`. Each `createXTool` factory returns an `AnyAgentTool` (a `pi-coding-agent` tool shape) which the harness later wraps with the before-tool-call hook.

## 4. Tool resolution: matching `tool_use` to an executor

The protocol-level dispatch table is implicit. The agent harness builds a `Map<string, AnyAgentTool>` from whichever tools the run is configured with, and when a `tool_use` block arrives it looks the name up in that map. The MCP-facing version of this is the easiest to read:

```ts
const toolMap = new Map<string, AnyAgentTool>();
for (const tool of wrappedTools) {
  toolMap.set(tool.name, tool);
}
return {
  listTools: async () => ({ tools: wrappedTools.map(...) }),
  callTool: async (params: CallPluginToolParams, signal?: AbortSignal) => {
    const tool = toolMap.get(params.name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${params.name}` }], isError: true };
    }
    ...
  }
};
```
(`src/mcp/plugin-tools-handlers.ts:24-50`)

Three things deserve attention.

**Each tool is wrapped before it goes in the map.** The wrapper `wrapToolWithBeforeToolCallHook` (declared in `src/agents/pi-tools.before-tool-call.ts`, used at `src/mcp/plugin-tools-handlers.ts:23-32`) inserts the policy/approval gate. The wrapping is *idempotent*: `isToolWrappedWithBeforeToolCallHook` short-circuits when the tool is already wrapped, so layered registration (channel → agent → MCP) doesn't double-wrap.

**Unknown tool name is a content error, not a thrown error.** The handler returns `{ isError: true }` in the same shape as a successful result. This lets the model see the failure as a normal tool result and either retry, switch tools, or report it to the user. Throwing would unwind the agent's loop, which is the wrong behavior for a recoverable mistake.

**Result content is coerced.** Whatever the tool returns — string, structured object, AgentToolResult — is normalized through `coerceChatContentText` (`src/mcp/plugin-tools-handlers.ts:52-60`) so the transcript gets a uniform `content: [{ type: "text", text }]` block. Provider-specific normalizations happen later in the agent harness.

The non-MCP dispatch follows the same pattern, just inside the agent's own run loop. See `src/agents/pi-tools.before-tool-call.ts` for the wrapper and `src/agents/pi-embedded-subscribe.handlers.tools.ts` for the harness-side notification handler.

## 5. Approval gating: the `exec` flow as the canonical example

Some tools are too dangerous to run without explicit user consent. The clearest case is `exec` (shell command execution), which must prompt the operator for unfamiliar commands. OpenClaw implements this as a *two-phase RPC* through the gateway.

### Why naive approaches fail

A naive design would block the tool inside the agent process and `prompt()` for input. That breaks immediately for non-interactive runs (cron jobs, channel-driven sessions, embedded mode). A second naive try would short-circuit by always denying unfamiliar commands; that produces a useless agent. A third would always allow them; that produces a dangerous one.

The real design treats approval as another RPC: the agent fires a structured `exec_approval_request` toward the gateway, the gateway routes the question to whichever surface is appropriate (interactive CLI, channel reply, UI prompt), collects the answer, and resolves the RPC. The agent is just waiting for an answer, so it works the same in any context.

### The request payload

`RequestExecApprovalDecisionParams` (`src/agents/bash-tools.exec-approval-request.ts:34-58`) is the input to that RPC. The relevant fields:

```ts
export type RequestExecApprovalDecisionParams = {
  id: string;
  command?: string;
  commandArgv?: string[];
  systemRunPlan?: SystemRunApprovalPlan;
  env?: Record<string, string>;
  cwd: string | undefined;
  nodeId?: string;
  host: "gateway" | "node";
  security: ExecSecurity;
  ask: ExecAsk;
  warningText?: string;
  commandSpans?: ExecApprovalCommandSpan[];
  agentId?: string;
  resolvedPath?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};
```

This is more than "the command string." It carries source routing (channel, account, thread) so the gateway can answer back through the right surface; `security` and `ask` flags describe the risk class; `commandSpans` carries parsed shell tokens so the UI can highlight `rm -rf` differently from `ls`.

The wrapper that resolves spans is intentionally lazy. The shell parser is heavy, so the runtime is loaded only when needed:

```ts
let execApprovalCommandSpansRuntimePromise: Promise<ExecApprovalCommandSpansRuntime> | null = null;
function loadExecApprovalCommandSpansRuntime(): Promise<ExecApprovalCommandSpansRuntime> {
  execApprovalCommandSpansRuntimePromise ??=
    import("./bash-tools.exec-approval-request.runtime.js");
  return execApprovalCommandSpansRuntimePromise;
}
```
(`src/agents/bash-tools.exec-approval-request.ts:21-30`)

### Two-phase delivery

The tool sets `twoPhase: true` on the gateway call (`src/agents/bash-tools.exec-approval-request.ts:60-86`). Phase one registers the question; the gateway returns immediately with an approval id, so the agent knows the request is live. Phase two is a `wait` call that resolves when the user replies. This matters because:

- The agent can release any abort-handlers it needs to.
- The gateway can persist the question and survive a restart; the agent will pick the answer up.
- A second agent in the same session can see the pending question (visible in `pendingApprovals`) instead of double-prompting.

The decision-string parsing is also defensive. Tool stdout that *looks like* `Exec denied (...)` must not spoof an approval; the parser at `src/agents/exec-approval-result.ts:30-44` requires the metadata block to start with `gateway id=` or `node=`, which the legitimate approval system always produces:

```ts
// Approval-system-generated wrappers always start with either `gateway id=` or
// `node=` inside the parenthesized metadata (see bash-tools.exec-host-gateway.ts,
// bash-tools.exec-host-node.ts, and gateway/server-node-events.ts). Untrusted
// command stdout that happens to start with "Exec denied (...)" or
// "Exec finished (...)" should be rejected by the parser to prevent CWE-841
// spoofed approval events from arbitrary tool output.
const APPROVAL_METADATA_SOURCE_RE = /^(?:gateway\s+id=|node=)/i;
```
(`src/agents/exec-approval-result.ts:31-38`)

The comment names the CWE — this is a deliberate hardening, not a casual pattern.

### Where the gate hooks in

The general `before_tool_call` hook (chapter 04 covered hooks more broadly) is what calls into the approval RPC. The wiring lives in `src/agents/pi-tools.before-tool-call.ts`. The hook can short-circuit a tool call with a denial result, or it can rewrite the arguments (for example, applying file-system policy). Every wrapped tool sees the hook before the inner executor runs.

The MCP-side wrapper (`src/mcp/plugin-tools-handlers.ts:18-32`) deliberately re-wraps tools that come in through ACPX. The comment is explicit:

```ts
// The ACPX MCP bridge should enforce the same pre-execution hook boundary
// as the agent and HTTP tool execution paths.
return wrapToolWithBeforeToolCallHook(tool);
```

This is the lever that says "the approval policy is one decision point, applied uniformly, no matter which dispatch path delivers the call."

<svg viewBox="0 0 920 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="approval gating sequence"><defs><marker id="r92arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#64748b"/></marker></defs><rect x="0" y="0" width="920" height="460" fill="#f1f5f9"/><rect x="40" y="20" width="140" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="2"/><text x="110" y="45" text-anchor="middle" font-family="ui-sans-serif" font-size="13" font-weight="700" fill="#7c3aed">model</text><rect x="220" y="20" width="180" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/><text x="310" y="45" text-anchor="middle" font-family="ui-sans-serif" font-size="13" font-weight="700" fill="#ea580c">agent (pi-tools)</text><rect x="440" y="20" width="180" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="2"/><text x="530" y="45" text-anchor="middle" font-family="ui-sans-serif" font-size="13" font-weight="700" fill="#0d9488">gateway</text><rect x="660" y="20" width="220" height="40" rx="6" fill="#bae6fd" stroke="#0ea5e9" stroke-width="2"/><text x="770" y="45" text-anchor="middle" font-family="ui-sans-serif" font-size="13" font-weight="700" fill="#0ea5e9">channel / UI / CLI</text><line x1="110" y1="60" x2="110" y2="440" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,3"/><line x1="310" y1="60" x2="310" y2="440" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,3"/><line x1="530" y1="60" x2="530" y2="440" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,3"/><line x1="770" y1="60" x2="770" y2="440" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,3"/><path d="M 110 90 L 310 90" stroke="#7c3aed" stroke-width="2" fill="none" marker-end="url(#r92arrow)"/><text x="210" y="84" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">tool_use exec({command:"rm -rf …"})</text><rect x="220" y="105" width="180" height="50" rx="4" fill="#ffffff" stroke="#7c3aed"/><text x="310" y="125" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">before_tool_call hook</text><text x="310" y="140" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">classify, build request</text><path d="M 310 170 L 530 170" stroke="#ea580c" stroke-width="2" fill="none" marker-end="url(#r92arrow)"/><text x="420" y="164" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">exec_approval_request twoPhase:true</text><path d="M 530 195 L 310 195" stroke="#0d9488" stroke-width="2" fill="none" marker-end="url(#r92arrow)"/><text x="420" y="189" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">{ approvalId }</text><path d="M 530 225 L 770 225" stroke="#0d9488" stroke-width="2" fill="none" marker-end="url(#r92arrow)"/><text x="650" y="219" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">prompt operator (with commandSpans)</text><path d="M 770 260 L 530 260" stroke="#0ea5e9" stroke-width="2" fill="none" marker-end="url(#r92arrow)"/><text x="650" y="254" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">approve / deny / always</text><path d="M 310 290 L 530 290" stroke="#ea580c" stroke-width="2" fill="none" marker-end="url(#r92arrow)"/><text x="420" y="284" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">wait_for_decision(approvalId)</text><path d="M 530 320 L 310 320" stroke="#0d9488" stroke-width="2" fill="none" marker-end="url(#r92arrow)"/><text x="420" y="314" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">{ decision: "allow" }</text><rect x="220" y="335" width="180" height="50" rx="4" fill="#ffffff" stroke="#16a34a"/><text x="310" y="355" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">run exec, capture stdout</text><text x="310" y="370" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">fire after_tool_call</text><path d="M 310 410 L 110 410" stroke="#ea580c" stroke-width="2" fill="none" marker-end="url(#r92arrow)"/><text x="210" y="404" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">tool_result(content blocks)</text></svg>
<span class="figure-caption">Figure R9.2 | Approval gating: the agent's `before_tool_call` wrapper converts a sensitive `tool_use` into a two-phase gateway RPC, then runs the tool only if the operator allows it.</span>
<details><summary>ASCII original</summary>
```
model              agent                gateway             channel/UI/CLI
  | tool_use exec   |                     |                       |
  |---------------> | before_tool_call    |                       |
  |                 | classify, build req |                       |
  |                 |------ req ---------> | (twoPhase:true)      |
  |                 | <----- approvalId -- |                       |
  |                 |                     |---- prompt ---------->|
  |                 |                     | <--- allow/deny ------|
  |                 |--- wait_decision ---> |                     |
  |                 | <--- {decision} ---- |                      |
  |                 | run exec, after_tool_call                   |
  | <- tool_result -|                     |                       |
```
</details>

## 6. MCP integration: external tools as first-class OpenClaw tools

OpenClaw speaks Model Context Protocol both ways. It can expose its own surfaces to MCP clients (`src/mcp/openclaw-tools-serve.ts`, `src/mcp/plugin-tools-serve.ts`), and it can mount external MCP servers as tool sources visible to its own agent.

### The OpenClaw side: serving tools

`createPluginToolsMcpHandlers` (`src/mcp/plugin-tools-handlers.ts:24-67`) is the bridge in the *serve* direction. Given an array of `AnyAgentTool`, it returns the `listTools` and `callTool` handlers that an MCP server exposes. The listing step projects each tool to MCP's `{name, description, inputSchema}` (`src/mcp/plugin-tools-handlers.ts:36-44`), which is — not coincidentally — the same shape as the protocol descriptor in section 2. The call step is the same map lookup we saw earlier, with content normalization to MCP's array form (`src/mcp/plugin-tools-handlers.ts:53-60`).

There is a second OpenClaw MCP surface — the *channel bridge* — under `src/mcp/channel-bridge.ts`. It exposes OpenClaw's session/channel API as MCP tools (`conversations_list`, `messages_read`, `events_poll`, etc.) for Claude Desktop and similar clients. The tools are defined declaratively at `src/mcp/channel-tools.ts:20-60`, using the MCP SDK's `server.tool()` helper:

```ts
server.tool(
  "conversations_list",
  "List OpenClaw channel-backed conversations available through session routes.",
  {
    limit: z.number().int().min(1).max(500).optional(),
    search: z.string().optional(),
    channel: z.string().optional(),
    ...
  },
  async (args) => {
    const conversations = await bridge.listConversations(args);
    return { ...summarizeStructuredResult(...), structuredContent: { conversations } };
  },
);
```
(`src/mcp/channel-tools.ts:26-42`)

Notice that the schemas are zod schemas, not raw JSON-schema objects. The MCP SDK converts them. This is the rare case where OpenClaw uses zod directly at the boundary; everywhere else, descriptors carry raw JSON-schema so multiple model providers can consume them.

### The inverse: mounting external MCP servers

An external MCP server (e.g., a Notion or Linear MCP) registers in the manifest of an `extensions/<plugin>/openclaw.plugin.json` file as a tool source. The plugin's runtime entry constructs an MCP client, lists the remote tools, and feeds them through the same descriptor machinery the rest of the catalog uses. The owner becomes `{ kind: "mcp", serverId }`, the executor becomes `{ kind: "mcp", serverId, toolName }`, and dispatch routes back through the MCP client at call time.

The shutdown semantics are non-trivial. `src/mcp/channel-server.shutdown-unhandled-rejection.test.ts` exists precisely because pulling the rug out from under an active MCP call must not produce an unhandled rejection that crashes the gateway. The bridge keeps a registry of pending waiters and resolves them with `null` on shutdown rather than throwing.

<svg viewBox="0 0 920 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="MCP bridge architecture"><defs><marker id="r93arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#64748b"/></marker></defs><rect x="0" y="0" width="920" height="360" fill="#f1f5f9"/><rect x="40" y="40" width="220" height="280" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/><text x="150" y="68" text-anchor="middle" font-family="ui-sans-serif" font-size="14" font-weight="700" fill="#ea580c">OpenClaw agent</text><rect x="60" y="90" width="180" height="50" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="150" y="110" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">tool catalog</text><text x="150" y="124" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">(plan: visible/hidden)</text><rect x="60" y="155" width="180" height="50" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="150" y="175" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">before_tool_call wrap</text><text x="150" y="189" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">(approval, policy)</text><rect x="60" y="220" width="180" height="50" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="150" y="240" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">executor dispatch</text><text x="150" y="254" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">mcp:&lt;serverId&gt;:&lt;name&gt;</text><rect x="60" y="285" width="180" height="25" rx="4" fill="#e2e8f0" stroke="#cbd5e1"/><text x="150" y="302" text-anchor="middle" font-family="ui-sans-serif" font-size="10" fill="#475569">src/agents/, src/tools/</text><rect x="320" y="40" width="240" height="280" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="2"/><text x="440" y="68" text-anchor="middle" font-family="ui-sans-serif" font-size="14" font-weight="700" fill="#7c3aed">MCP bridge</text><rect x="340" y="90" width="200" height="60" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="440" y="110" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">channel-bridge.ts</text><text x="440" y="124" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">channel-server.ts</text><text x="440" y="140" text-anchor="middle" font-family="ui-sans-serif" font-size="10" fill="#475569">expose OpenClaw → MCP</text><rect x="340" y="165" width="200" height="60" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="440" y="185" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">plugin-tools-handlers</text><text x="440" y="199" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">plugin-tools-serve</text><text x="440" y="215" text-anchor="middle" font-family="ui-sans-serif" font-size="10" fill="#475569">expose plugin tools</text><rect x="340" y="240" width="200" height="60" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="440" y="260" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">mcp client wrapper</text><text x="440" y="274" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">mount external as tools</text><text x="440" y="290" text-anchor="middle" font-family="ui-sans-serif" font-size="10" fill="#475569">extensions/&lt;mcp-plugin&gt;</text><rect x="620" y="40" width="260" height="280" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="2"/><text x="750" y="68" text-anchor="middle" font-family="ui-sans-serif" font-size="14" font-weight="700" fill="#0d9488">External world</text><rect x="640" y="90" width="220" height="80" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="750" y="115" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">Claude Desktop, Codex,</text><text x="750" y="133" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">other MCP clients</text><text x="750" y="155" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#475569">(consume OpenClaw tools)</text><rect x="640" y="190" width="220" height="110" rx="4" fill="#ffffff" stroke="#cbd5e1"/><text x="750" y="215" text-anchor="middle" font-family="ui-sans-serif" font-size="12" fill="#1e293b">External MCP servers</text><text x="750" y="235" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#1e293b">notion, linear, fs, …</text><text x="750" y="260" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#475569">(provide tools to OpenClaw)</text><text x="750" y="285" text-anchor="middle" font-family="ui-sans-serif" font-size="11" fill="#475569">stdio / sse / websocket</text><path d="M 260 130 L 336 130" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r93arrow)"/><path d="M 560 130 L 636 130" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r93arrow)"/><path d="M 636 270 L 560 270" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r93arrow)"/><path d="M 336 270 L 260 270" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#r93arrow)"/></svg>
<span class="figure-caption">Figure R9.3 | MCP bridge runs both ways: the upper arrows expose OpenClaw tools to MCP clients; the lower arrows mount external MCP servers as OpenClaw tools.</span>
<details><summary>ASCII original</summary>
```
+-------------------+   +-----------------------+   +---------------------+
| OpenClaw agent    |   | MCP bridge            |   | External world      |
| - tool catalog    |-->| - channel-bridge      |-->| Claude Desktop /    |
| - before_tool_call|   | - plugin-tools-serve  |   | Codex (consumers)   |
| - executor lookup |<--| - mcp client wrapper  |<--| External MCP servers|
+-------------------+   +-----------------------+   +---------------------+
```
</details>

## 7. Skills: where the system-prompt-side meets the tool-side

A skill in OpenClaw vocabulary is *not* a tool. It is a bundle: a `SKILL.md` system-prompt fragment, sometimes a short `agents/openai.yaml` declaring which model/profile it expects, and optional supporting scripts. When a session adopts a skill, the harness injects the prompt fragment into the system prompt and applies any tool allowlist the skill declares.

Skills live in three places:

1. **Operator / dev skills** at `.agents/skills/<id>/SKILL.md`. These are the workflow/policy bundles a maintainer or contributor uses — examples include `.agents/skills/autoreview/SKILL.md`, `.agents/skills/openclaw-pr-maintainer/SKILL.md`, `.agents/skills/clawsweeper/SKILL.md`. They are repo-tree assets, not registered through the plugin manifest.
2. **Per-agent skills** under each user's agent directory, picked up at agent harness setup time.
3. **Plugin-bundled skills** declared in the plugin manifest's `skills` field. The manifest registry at `src/plugins/manifest-registry.ts` (referenced from `src/plugins/runtime/runtime-plugin-boundary.ts:24-40`) collects them into the global skill catalog.

The manifest field is plain metadata: a skill is a directory name plus optional metadata. No runtime activation is needed to *discover* a skill; the discovery layer reads the file. Runtime activation happens when a session asks for it. This split (discovery cheap, activation explicit) is the same control-plane / runtime-plane separation chapter 10 examines for plugins generally.

The lightweight QA scenario `qa/scenarios/jsonl-replay/plugin-lifecycle-searchable-tools.jsonl` is the closest thing to a regression test of "tool discovery vs. activation lifecycle" — it replays an agent run that exercises `tool_search` against a deferred tool surface.

## 8. Searchable tools and forced tools

The OpenClaw catalog can grow into the hundreds when many plugins are active. Two mechanisms keep the model's tool window manageable.

### Searchable tools (`tool_search`)

When the catalog is too large to ship in every turn, OpenClaw exposes four control tools instead of every leaf tool:

```ts
export const TOOL_SEARCH_CODE_MODE_TOOL_NAME = "tool_search_code";
export const TOOL_SEARCH_RAW_TOOL_NAME = "tool_search";
export const TOOL_DESCRIBE_RAW_TOOL_NAME = "tool_describe";
export const TOOL_CALL_RAW_TOOL_NAME = "tool_call";
```
(`src/agents/tool-search.ts:21-25`)

The model uses `tool_search(query)` to find candidate tools, `tool_describe(id)` to read the full descriptor for one, and `tool_call(id, input)` to invoke it. `tool_search_code` is a sandboxed JavaScript dialect that lets the model script multi-step lookups in a single turn.

The catalog the search reads from is the same plan output from `buildToolPlan`. Each entry projects into a `ToolSearchCatalogEntry`:

```ts
export type ToolSearchCatalogEntry = {
  id: string;
  source: CatalogSource;
  sourceName?: string;
  name: string;
  label?: string;
  description: string;
  parameters?: unknown;
  tool: CatalogTool;
};
```
(`src/agents/tool-search.ts:80-89`)

The `source` is one of `"openclaw"`, `"mcp"`, `"client"`. Codex and other harnesses use this to keep search results stable across runs.

The flake-stabilization commit `5067a84d9d test(codex): avoid searchable-tool registration flake` (in the v2026.5.22 series) tightened how Codex's app-server tests stub the searchable-tool registration so the test no longer depends on a particular registration race. It's a good sign that this surface is doing real work in production: tests had to be made deterministic around it.

### Forced tools (allowlist)

Where searchable tools restrict what's *visible* to keep the prompt small, the forced-tool / explicit-allowlist mechanism restricts what's *callable* to keep behavior safe. The OpenClaw agent supports an `allow` list that names exactly which tools the model may call; anything else is rejected at the gate.

If the allowlist names tools that don't exist after resolution, the run aborts with a helpful message:

```ts
return new Error(
  `No callable tools remain after resolving explicit tool allowlist (${requested}); ${reason}. Fix the allowlist or enable the plugin that registers the requested tool.`,
);
```
(`src/agents/tool-allowlist-guard.ts:50-52`)

Empty-allowlist guards are crucial because the failure mode without them is silent. The agent would run with zero callable tools and the model would assume tools were broken; the error here says exactly what to do.

The Codex side also has a "forced" injection — certain tools must always be in the allowlist when the session is using them. Example:

```ts
function includeForcedCodexDynamicToolAllow(
  toolsAllow: string[] | undefined,
  params: EmbeddedRunAttemptParams,
): string[] | undefined {
  if (toolsAllow === undefined || hasWildcardCodexToolsAllow(toolsAllow)) {
    return toolsAllow;
  }
  const forcedToolNames = shouldForceMessageTool(params) ? ["message"] : [];
  ...
  return missingToolNames.length === 0 ? toolsAllow : [...toolsAllow, ...missingToolNames];
}
```
(`extensions/codex/src/app-server/run-attempt.ts:4010-4030`)

The forced-tool flake commits (`b0153953b4 test(codex): avoid forced-tool allowlist flake`, `6b31e1e365 test(codex): type forced-tool request mock`, `2ba346a8eb test(codex): avoid forced-tool turn flake`) all touched the same Codex test surface. They are not changes to the policy itself — they are changes to how tests assert the policy without depending on registration timing. The point worth keeping is that "policy is uniform, but tests need to be hermetic about when registration happens."

### Why this is two mechanisms, not one

A naive design would conflate "visibility" and "callability" — if the model can't see a tool, it can't call it, so why have both? Two reasons:

- Visibility is a *prompt-budget* concern. A 600-tool catalog can't fit; searchable tools let the model navigate without paying the prompt cost.
- Callability is a *safety / scope* concern. An operator might want the model to see `web_search` (so it knows it's an option) but not call it (because the agent should narrate, not actually fetch).

Decoupling lets each surface be tuned independently.

## 9. Concrete examples: web-search, web-fetch, terminal

### Web-search

`src/web-search/runtime.ts` is the resolution layer between "the agent wants to search" and "this provider plugin will do the searching." It does not implement search itself; it picks a provider.

```ts
export function resolveWebSearchEnabled(params: {
  search?: WebSearchConfig;
  sandboxed?: boolean;
}): boolean {
  if (typeof params.search?.enabled === "boolean") {
    return params.search.enabled;
  }
  if (params.sandboxed) {
    return true;
  }
  return true;
}
```
(`src/web-search/runtime.ts:64-74`)

Three knobs decide the answer: explicit config, sandbox mode (always on), default (on). The actual provider lookup goes through `resolvePluginWebSearchProviders` and `resolveRuntimeWebSearchProviders` (imported at `src/web-search/runtime.ts:13-19`), which return the list of plugin-owned search providers. The plugin-side declarations live in extensions like `extensions/brave`, `extensions/duckduckgo`, `extensions/exa`, `extensions/firecrawl`.

Notice the bigger pattern: `web-search` is not a single tool implementation — it is a contract that a plugin satisfies. The tool descriptor's `executor` resolves to whichever plugin won the auto-detect (`sortWebSearchProvidersForAutoDetect`). Operators can override with `tools.web.search.provider` in config.

### Web-fetch

The mirror image. `src/web-fetch/runtime.ts:38-44` mirrors `web-search`'s enable-check:

```ts
export function resolveWebFetchEnabled(params: {
  fetch?: WebFetchConfig;
  sandboxed?: boolean;
}): boolean {
  if (typeof params.fetch?.enabled === "boolean") {
    return params.fetch.enabled;
  }
  return true;
}
```

Web-fetch and web-search share the `provider-runtime-shared` helper (`src/web-fetch/runtime.ts:17-22`) — the credential evidence checks, the env-var lookups, the entry-config resolution are common code. This was a deliberate consolidation; before it, both runtimes had near-copies of the same provider-resolution logic.

### Terminal

`src/terminal/` is not a tool. It is the support library the gateway and CLI use to format human-facing terminal output: ANSI codes, link decorations, decorative-emoji handling, prompt styling. The `palette.ts` and `theme.ts` files define the OpenClaw color tokens used everywhere from `clawlog.sh` to interactive prompts.

The relevant pieces for this chapter are:

- `src/terminal/links.ts` — emits OSC-8 terminal hyperlinks so command output can include clickable references to chat sessions.
- `src/terminal/safe-text.ts` — sanitizes model output before it lands in the user's terminal, blocking escape sequences that could rewrite the prompt.
- `src/terminal/osc-progress.ts` — emits OSC-9;4 progress codes so iTerm/Windows Terminal show progress bars for long-running tool calls.

`src/terminal/` is the seam that makes tool output safe and pleasant to read. None of it is exposed to the model directly — it sits between the tool result and the operator's eyeballs.

## 10. Diagnostics: why didn't this tool show up?

The diagnostic surface is small but well-defined. `ToolPlanContractError` (`src/tools/diagnostics.ts:1-...`) is thrown when a descriptor set is inconsistent: duplicate names, missing executors, malformed availability expressions. `ToolAvailabilityDiagnostic` (`src/tools/types.ts:68-72`) is the per-tool, per-signal explanation of why a tool moved from `visible` to `hidden`:

```ts
export type ToolAvailabilityDiagnostic = {
  readonly reason: ToolUnavailableReason;
  readonly signal?: ToolAvailabilitySignal;
  readonly message: string;
};
```

The `reason` is a closed enum (`src/tools/types.ts:60-66`): `"auth-missing" | "config-missing" | "context-mismatch" | "env-missing" | "plugin-disabled" | "unsupported-signal"`. The closed union is what lets `openclaw doctor` produce stable error categories instead of free-text strings.

When `openclaw doctor` says "the `web_search` tool is hidden because plugin `brave` is not enabled," it's reading exactly this `ToolAvailabilityDiagnostic` chain.

## 11. Inside `OpenClawChannelBridge`: a worked example

The clearest way to understand how OpenClaw expresses its internal surfaces as tools is to read `OpenClawChannelBridge` (`src/mcp/channel-bridge.ts:39-90`). It is what the macOS Claude desktop app talks to when it wants OpenClaw's session and channel data.

### The state

```ts
export class OpenClawChannelBridge {
  private gateway: GatewayClient | null = null;
  private readonly verbose: boolean;
  private readonly claudeChannelMode: ClaudeChannelMode;
  private readonly queue: QueueEvent[] = [];
  private readonly pendingWaiters = new Set<PendingWaiter>();
  private readonly pendingClaudePermissions = new Map<string, ClaudePermissionRequest>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private server: McpServer | null = null;
  private cursor = 0;
  private closed = false;
  private ready = false;
  private started = false;
  private retryingInitialConnect = false;
  private readonly readyPromise: Promise<void>;
  ...
}
```
(`src/mcp/channel-bridge.ts:41-65`)

Four state pieces matter for the tool surface:

- `queue` — buffered queue of `QueueEvent` that the polling tool consumes. Cap is `QUEUE_LIMIT = 1_000` (`src/mcp/channel-bridge.ts:36`); older events drop off the back to keep memory bounded.
- `pendingWaiters` — long-poll waiters. When a client calls `events_wait`, it parks here until matching events arrive.
- `pendingClaudePermissions` / `pendingApprovals` — separate registries for the two flavors of approval (Claude's native permission prompt vs. OpenClaw's general approval system). Both are maps keyed by approval id.
- `cursor` — monotonically increasing event counter so clients can resume from a known position.

### Connection bring-up

The `start()` method (`src/mcp/channel-bridge.ts:78-150`) is illuminating because it's almost entirely lazy imports:

```ts
async start(): Promise<void> {
  if (this.started) { await this.readyPromise; return; }
  this.started = true;
  const [
    { resolveGatewayClientBootstrap },
    { GatewayClient: GatewayClientCtor },
    { startGatewayClientWhenEventLoopReady },
    { APPROVALS_SCOPE, READ_SCOPE, WRITE_SCOPE },
    { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES },
  ] = await Promise.all([
    import("../gateway/client-bootstrap.js"),
    import("../gateway/client.js"),
    import("../gateway/client-start-readiness.js"),
    import("../gateway/method-scopes.js"),
    import("../gateway/protocol/client-info.js"),
  ]);
  ...
}
```
(`src/mcp/channel-bridge.ts:89-101`)

This bundle pulls in the gateway client, which is heavy. The bridge defers that import until it actually has to connect. The same `*.runtime.ts` pattern that the broader codebase uses, here applied to dynamic `import()` calls.

The constructed gateway client is configured with three scopes — `READ_SCOPE`, `WRITE_SCOPE`, `APPROVALS_SCOPE`. These are the same OperatorScopes a CLI session would request; the MCP bridge is not a privileged client, it just happens to be a long-lived one. The request timeout is generous (180 seconds) because some session operations are slow.

### Tool implementations

The tools in `src/mcp/channel-tools.ts:20-130` are thin shells around bridge methods. `conversation_get` is representative:

```ts
server.tool(
  "conversation_get",
  "Get one OpenClaw conversation by session key.",
  { session_key: z.string().min(1) },
  async ({ session_key }) => {
    const conversation = await bridge.getConversation(session_key);
    if (!conversation) {
      return {
        content: [{ type: "text", text: `conversation not found: ${session_key}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `conversation ${conversation.sessionKey}` }],
      structuredContent: { conversation },
    };
  },
);
```
(`src/mcp/channel-tools.ts:44-60`)

Three things to notice:

- **Both `content` and `structuredContent`.** The text content is what a non-structured model sees; the `structuredContent` is what a structured-output-capable client (Claude desktop, Codex) can parse into typed objects. The MCP SDK transmits both.
- **`isError: true` for the not-found case.** Exactly the same pattern as in section 4 — recoverable not-found errors come back as content with `isError`, not as exceptions.
- **Argument schema is zod.** Conversion to JSON-schema happens inside the MCP SDK; the rest of OpenClaw stays in raw JSON-schema.

The implementation calls the bridge method which calls the gateway:

```ts
async getConversation(sessionKey: string): Promise<ConversationDescriptor | null> {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return null;
  }
  await this.waitUntilReady();
  const response: SessionDescribeResult = await this.requestGateway("sessions.describe", {
    key: normalizedSessionKey,
    includeDerivedTitles: true,
    includeLastMessage: true,
  });
  return response.session ? toConversation(response.session) : null;
}
```
(`src/mcp/channel-bridge.ts:206-218`)

The shape `SessionDescribeResult` is defined in `src/mcp/channel-shared.ts:48-50`. The bridge's job is to be a thin translation layer between MCP semantics ("get conversation") and gateway RPCs (`sessions.describe` with all the right flags).

### Shutdown semantics

The bridge's `close()` method (`src/mcp/channel-bridge.ts:166-180`) is the seam tested by `src/mcp/channel-server.shutdown-unhandled-rejection.test.ts`:

```ts
async close(): Promise<void> {
  if (this.closed) { return; }
  this.closed = true;
  this.resolveReadyOnce();
  for (const waiter of this.pendingWaiters) {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout);
    }
    waiter.resolve(null);
  }
  this.pendingWaiters.clear();
  const gateway = this.gateway;
  this.gateway = null;
  await gateway?.stopAndWait().catch(() => undefined);
}
```

Four hardening details:

- **Idempotent.** Calling `close()` twice is safe.
- **Pending waiters resolved with `null`.** Long-poll tools waiting on `events_wait` get a clean `null` answer instead of a rejected promise.
- **Timeouts cleared.** Each waiter has its own `setTimeout`; close clears them all so the event loop doesn't keep references alive.
- **Gateway stop is swallowed.** `.catch(() => undefined)` so a slow gateway shutdown can't bubble up as an unhandled rejection.

The shutdown test (`src/mcp/channel-server.shutdown-unhandled-rejection.test.ts:10-21`) stubs the bridge to *throw* during close and asserts that the server's own shutdown handler treats the error gracefully:

```ts
const bridgeState = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  close: vi.fn(async () => {
    throw new Error("close boom");
  }),
  setServer: vi.fn(),
  ...
}));
```

That intentionally cruel mock is what lets OpenClaw guarantee "no unhandled rejection on shutdown" as a property, not as a hope.

## 12. The Pi tools layer: Pi as the executor harness

So far this chapter has talked about *tool descriptors* (the contract) and *tool dispatch* (the mechanics). What actually *runs* a tool inside the agent is the Pi coding-agent harness (`@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`). OpenClaw uses Pi as the orchestrator that, given a model client and a tool map, runs the agentic loop.

`src/agents/pi-tools.ts` is the integration point. It declares the OpenClaw-side adaptations:

- Pi's tool shape (`AnyAgentTool` re-exported from `src/agents/tools/common.ts`) is the in-memory representation.
- The before-tool-call wrapping is implemented in `src/agents/pi-tools.before-tool-call.ts` and applied wherever tools enter dispatch (via MCP, via the OpenClaw agent run, via subagent spawns).
- Schema conversion happens in `src/agents/pi-tools.schema.ts` so a tool's JSON-schema-style `parameters` survives the trip through Pi.

`src/agents/pi-tool-definition-adapter.ts` is the adapter that turns a tool plan entry into a Pi tool definition. The `after-tool-call.fires-once.test.ts` ensures the `after_tool_call` hook fires exactly once per dispatch — a regression test against double-firing when the wrapper composition got changed.

The pieces relevant to this chapter are:

- `src/agents/pi-tools.before-tool-call.ts` — `wrapToolWithBeforeToolCallHook`, `isToolWrappedWithBeforeToolCallHook`. The idempotent wrapper that interposes the approval / policy check.
- `src/agents/pi-tools.policy.ts` — the tool policy engine. Decides per-call whether a tool may run, must request approval, or is denied outright.
- `src/agents/pi-tools.params.ts` — argument normalization and validation. Where the JSON-schema check actually runs before dispatch.

The pi-tools test surface (`src/agents/pi-tools.*.test.ts` — there are roughly 40 tests with this prefix) is the densest in the agent directory. Reading them is a tour of every edge case the tool layer has had to handle: param normalization, host-edit access, workspace-root guard, sandbox-mounted-paths only, deferred followup guidance, tool-id preservation, message-provider policy. Most of these test files are short (under 200 lines each) but each one captures a specific bug class that previously slipped through.

## 13. Five concrete tool implementations in 30 lines each

These five tools illustrate the patterns described above with actual code shapes. Each one is roughly 30 lines from its respective file.

### `web_search` factory shape

The tool factory pattern is consistent. From `src/agents/tools/web-tools.js` (the file is `web-tools.ts` in source) the export is `createWebSearchTool(opts)` which returns an `AnyAgentTool` object. Its `parameters` is a TypeBox schema, its `execute` is an async function. The implementation delegates to `src/web-search/runtime.ts` to resolve the provider and dispatch the search request to the right plugin (Brave, DuckDuckGo, Exa, …).

### `message` (channel-send)

The `message` tool is what gives the agent the ability to send a reply on the originating channel. It's *trusted* (no approval) but *constrained* — it can only target the conversation the agent is currently running for. Codex's "forced tool" mechanism (section 8) ensures `message` is always in the allowlist when an embedded Codex session is running so the model can always answer back.

### `exec` (shell command)

The full approval flow described in section 5 lives in `src/agents/bash-tools.exec.ts` and the surrounding `bash-tools.exec-*` files. Pre-flight checks (`bash-tools.exec.script-preflight.test.ts`), command-spans for the UI (`bash-tools.exec-approval-request.runtime.ts`), the security floor (`bash-tools.exec.security-floor.test.ts`), and PTY fallback (`bash-tools.exec-runtime.pty-fallback.test.ts`) form a defense-in-depth stack. The `exec` tool is by far the most tested in the codebase.

### `sessions.spawn` (subagent)

`createSessionsSpawnTool` in `src/agents/tools/sessions-spawn-tool.ts` produces a tool that spawns a child agent. The lifecycle is broken into many tests (`openclaw-tools.subagents.sessions-spawn.*.test.ts`) because it has to interact with approval, model selection, allowlist propagation, and thinking-default inheritance. A subagent inherits the parent's approval session but gets its own tool plan.

### `cron`

`createCronTool` in `src/agents/tools/cron-tool.ts` lets the agent schedule a future turn. The tool itself is small — it pushes a job into the gateway's cron registry. The interesting integration is the `cron_changed` hook (one of the `PluginHookName` entries) that fires when the cron registry changes; plugins like the diagnostics OTEL exporter listen for it.

## 14. The tool plan and the `/help tools` surface

Operators see the tool plan via `/help tools` in the CLI and through the web UI. Both call into the same plan: they list visible tools grouped by section (`fs`, `runtime`, `web`, …) and list hidden tools with their diagnostic reasons.

The display ordering is stable because `buildToolPlan` sorts deterministically:

```ts
function compareDescriptors(left: ToolDescriptor, right: ToolDescriptor): number {
  return (
    (left.sortKey ?? left.name).localeCompare(right.sortKey ?? right.name) ||
    left.name.localeCompare(right.name)
  );
}
```
(`src/tools/planner.ts:13-17`)

`sortKey` lets a tool override its name for sorting purposes. The fallback to `name` is the natural alphabetic order; the secondary tiebreak by `name` exists so two descriptors with the same `sortKey` still sort deterministically.

The same comparator drives the prompt-cache stability that `AGENTS.md:67-70` calls out:

> Prompt cache: deterministic ordering for maps/sets/registries/plugin lists/files/network results before model/tool payloads. Preserve old transcript bytes when possible.

If the tool order changes turn-to-turn, the model provider can't cache prefixes. The deterministic sort is what makes prefix caching effective.

## 15. Tool result shape: the `AgentToolResult` and the persistence hook

A tool's return value is constrained. From the Pi tool definition perspective, an `execute` function returns either a raw value (which OpenClaw coerces into a text content block) or an `AgentToolResult<T>` shape with explicit `content`, optional `structuredContent`, and optional `isError`. The MCP-side handler captures both branches:

```ts
const rawContent =
  result && typeof result === "object" && "content" in result
    ? (result as { content?: unknown }).content
    : result;
return {
  content: Array.isArray(rawContent)
    ? rawContent
    : [{ type: "text", text: coerceChatContentText(rawContent) }],
};
```
(`src/mcp/plugin-tools-handlers.ts:46-62`)

The shape coerces *anything* into a `content: ContentBlock[]` array. This is what the transcript stores, what the next turn's prompt builder sees, and what the prompt-cache hashes for cache hits.

The `tool_result_persist` hook (one of the `PluginHookName` entries) fires *after* the dispatch resolves but *before* the result is written to the persistent transcript. Plugins listening on this hook can redact, rewrite, or stamp metadata onto the tool result. The hook handler is synchronous and the wrapping happens in `src/agents/session-tool-result-guard-wrapper.ts` — there's a dedicated `session-tool-result-guard.tool-result-persist-hook.test.ts` that verifies the hook actually runs at write time and not at dispatch time.

This split between *execute-time* and *persist-time* lets compaction plugins or memory plugins observe finalized results without slowing down the agent loop. They see the result that will actually be written, not an intermediate one.

## 16. Compaction-aware tools and the tool-result middleware

When the conversation grows past the model's context window, OpenClaw runs compaction (chapter 04 covers this in depth). The challenge for tools is that a compacted transcript can no longer carry every full tool result — they have to be summarized.

`src/plugins/agent-tool-result-middleware.ts` and `src/agents/compaction.tool-result-details.test.ts` are the two halves of this. A plugin can register an `AgentToolResultMiddleware` that gets a chance to transform a tool result before it's written. The middleware can:

- Return the result unchanged (most cases).
- Return a summarized version (large search results, file reads).
- Mark the result as "elideable" so compaction can drop the body and keep the summary.

The compaction-side test (`src/agents/compaction.tool-result-details.test.ts`) verifies that when compaction runs, the original tool results stored on the transcript still have enough metadata to rebuild a useful summary. If a middleware stripped the structure too aggressively, compaction would fail to summarize and the conversation would lose context.

This is the third place the *split-time-of-handling* pattern shows up:

1. Tool dispatch runs at *call time*.
2. `tool_result_persist` runs at *write time*.
3. Tool-result middleware composes with persistence to make results *compaction-aware*.

Each phase has its own hook surface so a plugin can subscribe to exactly the moment it cares about.

## 17. Diagnostic events and the tool catalog inspector

`pnpm openclaw doctor` and `pnpm openclaw inspect-tools` are the two operator-facing introspection tools that read the catalog.

`openclaw doctor` runs every `runtime-doctor` check that plugins have registered, plus core checks. For tools, the relevant checks ask: "Is this tool's availability satisfied? If not, why?" Each negative answer is a `ToolAvailabilityDiagnostic` and shows up in the doctor output with the closed-enum reason.

`openclaw inspect-tools` (and the bundle-equivalent `bundle-inspect`) reads the manifest registry and prints the tool catalog tree. For plugin-developer debugging — "why doesn't my tool show up?" — this is the first stop. The output groups tools by source (`core`, `plugin:<id>`, `channel:<id>`, `mcp:<server>`) and shows availability state inline.

The relevant scripts live under `src/scripts/` and are wired into the CLI by `src/cli/` (specifically the `openclaw plugin inspect` and `openclaw bundle inspect` commands at `src/plugins/bundle-claude-inspect.test.ts:1-...`).

When debugging tool issues, the diagnostic loop is:

1. `openclaw doctor` — does the runtime think the tool's availability is satisfied?
2. `openclaw inspect-tools --plugin <id>` — does the plugin register the tool at all?
3. `openclaw inspect-tools --hidden` — what diagnostics does the planner emit for hidden tools?
4. Server-side gateway logs — does the dispatch arrive and get rejected by the policy gate?

Each step narrows the question; if you reach step 4 and the dispatch arrived but didn't run, the policy or approval layer is what to debug next.

## 18. The seven things to remember

1. **Descriptors are the contract.** Everything is a `ToolDescriptor`. Owner and executor refs are the two sides of registration; availability is the gate.
2. **`buildToolPlan` is the only place the visible/hidden split is decided.** It sorts, asserts unique names, evaluates availability, returns diagnostics for hidden entries. No "secret" filtering happens elsewhere.
3. **The model only sees `{name, description, inputSchema}`.** That projection is `toToolProtocolDescriptor`. Provider adapters reshape it for their wire format.
4. **Dispatch is a `Map<name, tool>` lookup wrapped by `before_tool_call`.** The wrapper is idempotent. The MCP bridge wraps explicitly so policy is uniform across the agent path and the MCP path.
5. **Approval is a two-phase RPC.** The agent fires a request, gets an approval id, then waits on a separate decision. Approval-system messages are anti-spoof-guarded (`gateway id=` / `node=` prefix).
6. **MCP is bidirectional.** OpenClaw serves its tools over MCP (`channel-bridge`, `plugin-tools-serve`) and mounts external MCP servers as additional tool sources.
7. **Searchable vs. forced tools are different axes.** Searchable controls *visibility* (prompt budget); forced/allowlist controls *callability* (safety). The flake-stabilization commits around them in v2026.5.22 hardened test determinism without changing the policy.

This is the surface a model sees. The next chapter walks the plugin layer that *populates* this surface — how `extensions/brave` ends up registering a `web_search` provider that the planner can see.
