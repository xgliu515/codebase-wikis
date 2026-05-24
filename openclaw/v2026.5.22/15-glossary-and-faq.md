# Chapter 15 — Glossary and FAQ

Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

This chapter is the appendix the rest of the wiki points back to. **Part 1** is the term-by-term glossary — every load-bearing noun in the codebase. **Part 2** answers the questions a first-time reader keeps tripping over; most are the kind that need cross-file evidence rather than a single function definition. **Part 3** is the cheatsheet — env vars and CLI subcommands you reach for while debugging or onboarding.

There are no figures in this chapter. Use the search box and the in-line `file:line` refs to jump straight into source.

---

## Part 1 — Glossary

### ACP (Agent Control Protocol)

- **Definition**: A JSON-RPC dialect spoken between OpenClaw and external coding agents (Codex, Claude Code, Antigravity). ACP is OpenClaw's *out-bound* protocol to drive another agent runtime, separate from the gateway's own RPC.
- **Code location**: `src/acp/client.ts`, `src/acp/commands.ts`, control-plane integration in `src/acp/control-plane/`.
- **See also**: `extensions/codex/`, Chapter 07 on agent execution.

### Agent

- **Definition**: A named persona configured under `agents.entries[<agentId>]` in `openclaw.json`. Each agent ties together a model, a system prompt, a tool set, a workspace, and channel bindings. The default agent is conventionally `main`.
- **Code location**: `src/agents/agent-scope.ts` (`listAgentIds`, `resolveAgentDir`), `src/config/types.openclaw.ts:54` (`OpenClawConfig.agents`).
- **See also**: Chapter 07.

### Agent Command

- **Definition**: The central coordinator that turns a normalised inbound message into an actual agent run. It selects the agent, picks the model, builds the prompt, hands the work to a runner, and handles fallback/retry. Despite the name, it is not a CLI command — it's the in-process function `agentCommand(...)`.
- **Code location**: `src/agents/agent-command.ts` (`agentCommand`, `agentCommandFromIngress`).
- **See also**: Chapter 07.

### Agent Profile

- **Definition**: A per-agent config object (extracted from `agents.entries[<agentId>]`) that captures model selection, default thinking level, tool policy profile, channel mappings, workspace, and skill mappings.
- **Code location**: `src/agents/agent-scope.ts:resolveAgentConfig`, schema baseline in `src/config/types.openclaw.ts`.
- **See also**: Chapter 07.

### Anthropic Provider

- **Definition**: The bundled provider plugin that calls Anthropic's `/v1/messages` API (Claude family). Ships with the gateway under `extensions/anthropic/`.
- **Code location**: `extensions/anthropic/` (manifest at `extensions/anthropic/openclaw.plugin.json`).
- **See also**: Chapter 08 on LLM providers.

### Attempt

- **Definition**: One LLM call cycle within `runWithModelFallback`. Each attempt picks a model, calls the provider, and may succeed, fail with a retryable error, or fail terminally; the fallback loop iterates over models, the attempt is the single call inside that loop.
- **Code location**: `src/agents/command/attempt-execution.ts` (`runAgentAttempt`), used from `src/agents/agent-command.ts`.
- **See also**: Chapter 07.

### Auth Profile

- **Definition**: A persisted credential record for an agent — OAuth tokens, refresh tokens, external-CLI auth blobs (e.g., Claude/Codex CLI sessions). Lives at `<stateDir>/agents/<agentId>/agent/auth-profiles.json`.
- **Code location**: `src/agents/auth-profiles/store.ts`, path resolver at `src/secrets/auth-store-paths.ts:12`.
- **See also**: Chapter 14 §14.7.

### Auth Token

- **Definition**: The shared bearer secret the gateway authenticates callers against when `gateway.auth.mode = "token"`. Configurable via `gateway.auth.token`, env `OPENCLAW_GATEWAY_TOKEN`, or a `SecretRef`.
- **Code location**: `src/gateway/auth.ts:354` (`authorizeTokenAuth`), `src/gateway/auth-token-resolution.ts`, `src/gateway/known-weak-gateway-secrets.ts`.
- **Aliases**: AKA "gateway token", "bearer secret".
- **See also**: Chapter 14 §14.2.

### Bootstrap Token

- **Definition**: A one-shot credential a new device exchanges, on first connect, for a long-lived device identity. Embedded in pairing QR payloads. Separate from the gateway shared secret.
- **Code location**: `src/infra/device-bootstrap.ts:issueDeviceBootstrapToken`, consumed at `src/pairing/setup-code.ts:404`.
- **See also**: Chapter 14 §14.6.2.

### Bundled Plugin

- **Definition**: A plugin shipped inside the `extensions/` directory of the OpenClaw distribution, as opposed to being installed by the operator. Treated as part of OpenClaw's trusted computing base.
- **Code location**: `extensions/`; metadata loader at `src/plugins/manifest.ts`; bundled vs installed split in `OPENCLAW_BUNDLED_PLUGINS_DIR`.
- **See also**: Chapter 10 on plugins; Chapter 14 §14.9.

### Canvas

- **Definition**: An interactive tool surface that lets the agent open a programmable, in-process JS evaluator window in the Control UI. An explicit operator-trust feature: it can run arbitrary JS by design.
- **Code location**: `extensions/canvas/`.
- **See also**: `SECURITY.md` "Detailed False-Positive Patterns".

### Channel

- **Definition**: A messaging platform plugin (Slack, Telegram, WhatsApp, Discord, Feishu, Mattermost, WebChat, etc.). Each channel adapts that platform's native messages to OpenClaw's `MsgContext` shape and routes outbound replies back through the platform SDK.
- **Code location**: `src/channels/plugins/types.plugin.ts:61` (`ChannelPlugin`); channel implementations under `extensions/<channel>/`.
- **See also**: Chapter 04.

### Channel Catalog

- **Definition**: The static metadata table of every channel plugin OpenClaw knows about, with their config schemas and UI hints. Used by `openclaw doctor`, the wizard, and the Control UI's "add a channel" flow.
- **Code location**: `src/channels/bundled-channel-catalog-read.ts`, generated metadata at `src/config/bundled-channel-config-metadata.generated.ts`.
- **See also**: Chapter 04.

### Chat Type

- **Definition**: A coarse classification of an inbound chat conversation: `"direct"`, `"group"`, or `"channel"`. Drives DM-vs-group policy gates (`dmPolicy`, `groupPolicy`).
- **Code location**: `src/channels/chat-type.ts:3` defines `type ChatType = "direct" | "group" | "channel"`.
- **See also**: Chapter 04.

### Compaction

- **Definition**: The process of summarising a long session transcript into a shorter prompt-friendly form when it would otherwise blow past the model's context window. Triggered by token budgets or by an explicit `/compact` command.
- **Code location**: `src/sessions/model-overrides.ts`; context-engine compaction operations in `src/context-engine/types.ts:47` (`ContextEngineOperation`).
- **See also**: Chapter 06.

### Context Engine

- **Definition**: The subsystem that decides what slice of the session transcript and which auxiliary context (skills, memory, attachments) is fed to the model on each turn. Replaces ad-hoc prompt assembly with a delegate-driven projection.
- **Code location**: `src/context-engine/types.ts`, `src/context-engine/delegate.ts`, registry at `src/context-engine/registry.ts`.
- **See also**: Chapter 07.

### Control Plane

- **Definition**: The Gateway's role as the singular routing/authorisation/orchestration layer for OpenClaw. It is *not* the product — agents and providers are. All CLIs, the Control UI, mobile apps, and paired nodes connect to the control plane.
- **Code location**: `src/gateway/server.impl.ts`, audit helper at `src/gateway/control-plane-audit.ts`.
- **See also**: Chapter 02.

### Crestodian

- **Definition**: OpenClaw's ring-zero setup/repair helper — a separate assistant whose only job is to inspect the user's install (config validity, agents, gateway reachability, API key presence, local tool availability) and walk the operator through fixes. Deliberately isolated from the regular agent runtime so it stays usable when other things are broken.
- **Code location**: `src/crestodian/crestodian.ts`, overview at `src/crestodian/overview.ts:30`, CLI at `src/cli/program/register.crestodian.ts:8`.
- **Aliases**: AKA "the guard" (the name is a play on Latin *custos*).
- **See also**: Chapter 14 §14.10.1.

### Discord Channel

- **Definition**: The bundled Discord channel plugin. Connects through Discord's bot WebSocket gateway.
- **Code location**: `extensions/discord/`.
- **See also**: Chapter 04.

### dispatchInboundMessage

- **Definition**: The single entry point that takes a normalised inbound message and runs the full reply pipeline: filtering, routing, agent invocation, reply dispatch. Channel plugins all funnel into this.
- **Code location**: `src/auto-reply/dispatch.ts:246`; buffered/dispatcher variants at `:294,347`.
- **See also**: Chapter 04, Chapter 05.

### Event Stream

- **Definition**: The structured event stream a gateway client subscribes to over its WebSocket connection. Receives agent text deltas, tool-call events, reply lifecycle events, status updates, etc.
- **Code location**: `src/gateway/server-events/`.
- **See also**: Chapter 02, Chapter 11.

### Extensions Directory

- **Definition**: Where plugins live on disk. Two roots: the *bundled* extensions dir baked into the distribution (`extensions/` at repo root, set by `OPENCLAW_BUNDLED_PLUGINS_DIR`) and the operator's installed extensions under `<stateDir>/extensions/`.
- **Code location**: Resolved by `listInstalledPluginDirs` in `src/security/installed-plugin-dirs.ts`; env vars in `src/entry.ts`.
- **See also**: Chapter 10.

### Gateway

- **Definition**: The long-running OpenClaw process. It binds HTTP + WebSocket, hosts the plugin runtime, owns sessions, dispatches RPC, and is the single trust domain in the OpenClaw security model.
- **Code location**: `src/gateway/server.impl.ts:startGatewayServer` (default port 18789); thin shim at `src/gateway/server.ts`.
- **See also**: Chapter 02.

### Gateway Lock

- **Definition**: A file-based mutex that prevents two gateway processes from starting against the same state directory and port. Stores `{pid, createdAt, configPath, startTime}` and reclaims stale locks older than 30s.
- **Code location**: `src/infra/gateway-lock.ts`; payload schema at `src/infra/gateway-lock.ts:18-30`.
- **See also**: Chapter 14 §14.11.

### HTTP Server

- **Definition**: The plain-HTTP surface the Gateway exposes alongside its WebSocket. Serves the Control UI, the OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/responses`), the direct tool endpoint (`/tools/invoke`), and webhook ingress.
- **Code location**: `src/gateway/server.impl.ts` (alongside the WebSocket listener), HTTP-specific helpers in `src/gateway/control-ui-http-utils.ts`.
- **See also**: Chapter 02.

### Hook

- **Definition**: A webhook-driven external trigger — Gmail polling, IMAP, a scheduled HTTP endpoint — that produces inbound events the gateway treats like a channel message.
- **Code location**: `src/hooks/types.ts:35` defines `type Hook`; webhook auth boundary at `src/gateway/startup-auth.ts:224` (`assertHooksTokenSeparateFromGatewayAuth`).
- **See also**: Chapter 04.

### Inbound Message

- **Definition**: A unified shape every channel produces before handing into the pipeline. Holds channel id, sender id, message body, attachments, reply-context, and routing hints.
- **Code location**: `src/auto-reply/dispatch.ts` (consumed by `dispatchInboundMessage`); the runtime-rich form is `MsgContext`.
- **See also**: Chapter 05.

### LLM Provider

- **Definition**: A bundled or installed plugin that knows how to call a specific LLM vendor's API and translate it to OpenClaw's internal model contract.
- **Code location**: `src/agents/runtime-plan/types.ts` (`AgentRuntimeProviderHandle`); provider plugins under `extensions/<provider>/` (e.g., `extensions/openai/`, `extensions/anthropic/`).
- **See also**: Chapter 08.

### Manifest

- **Definition**: A plugin's `openclaw.plugin.json` file. Declares the plugin id, version, contributed channels/providers/tools/skills, and capabilities. Loaded by the plugin registry at gateway startup.
- **Code location**: `src/plugins/manifest.ts:loadPluginManifest`, schema in `src/plugins/types.ts`.
- **Aliases**: "plugin manifest", `openclaw.plugin.json`.
- **See also**: Chapter 10.

### MCP (Model Context Protocol)

- **Definition**: An external standard for exposing tools/resources to an LLM. OpenClaw can act as an MCP client (consuming external MCP servers) and ships an MCP surface for its own tools.
- **Code location**: `src/mcp/`.
- **See also**: Chapter 09.

### Memory Host SDK

- **Definition**: The host-side SDK that memory plugins (e.g., `extensions/memory-lancedb`) link against to integrate with OpenClaw's memory layer. Defines the engine interface, multimodal helpers, and host config utilities.
- **Code location**: `src/memory-host-sdk/` (thin re-export shells over `packages/memory-host-sdk/src/`).
- **See also**: Chapter 09.

### Message Received Hook

- **Definition**: A user-configurable callback (declared in `agents.entries.*.hooks` or similar) that fires when an inbound message is received, before it reaches the agent.
- **Code location**: Hook contracts in `src/plugins/types.ts`; dispatch in `src/auto-reply/dispatch.ts`.
- **See also**: Chapter 04.

### Model Catalog

- **Definition**: The merged view of every model OpenClaw knows about — from bundled defaults, from each provider's listed models, and from user overrides in `agents.defaults.models`. Used to populate model pickers and to validate `<provider>/<model>` refs.
- **Code location**: `src/model-catalog/` (`buildModelCatalogRef`, `mergeModelCatalogRowsByAuthority`).
- **See also**: Chapter 08.

### MsgContext

- **Definition**: The normalised "envelope" the dispatch pipeline uses internally. After `finalizeInboundContext` it becomes `FinalizedMsgContext` (adds derived/computed fields, removes the authorization stage marker).
- **Code location**: `src/auto-reply/templating.ts:42` (`type MsgContext`).
- **See also**: Chapter 05.

### OAuth Subscription

- **Definition**: An OAuth profile inside the auth-profile store that represents a refreshable subscription credential for a provider that uses OAuth (e.g., Anthropic Claude OAuth, OpenAI Codex OAuth).
- **Code location**: `src/agents/auth-profiles/oauth.ts`, `src/agents/auth-profiles/oauth-shared.ts:5` (`RuntimeExternalOAuthProfile`).
- **See also**: Chapter 14 §14.7.2.

### OpenAI Provider

- **Definition**: The bundled provider plugin that calls OpenAI's chat-completions and Responses APIs. Ships under `extensions/openai/`.
- **Code location**: `extensions/openai/`.
- **See also**: Chapter 08.

### OpenAI Responses

- **Definition**: OpenAI's newer streaming response API (alongside chat-completions). Treated as a distinct model "API kind" by the provider runtime so persistence and replay can be tagged accordingly.
- **Code location**: `src/config/types.models.ts:12` lists `"openai-responses"` as a model api kind.
- **See also**: Chapter 08.

### OpenClaw Config

- **Definition**: The user's `openclaw.json` (or `~/.openclaw/openclaw.json`). The single document that declares agents, channels, providers, secrets, hooks, gateway settings, and plugin allowlists.
- **Code location**: Type at `src/config/types.openclaw.ts:54` (`OpenClawConfig`); resolution in `src/config/config.ts`.
- **See also**: Chapter 03.

### Operator

- **Definition**: The trusted human who owns this OpenClaw install. Every authenticated gateway caller is treated as the operator; OpenClaw deliberately does not model inter-operator isolation on one gateway.
- **Code location**: Concept defined in `SECURITY.md:121-138` ("Operator Trust Model"); scopes in `src/gateway/operator-scopes.ts`.
- **See also**: Chapter 14 §14.1.

### Pairing

- **Definition**: Two distinct flows that both live under `src/pairing/`. **Device pairing** uses a QR-encoded setup payload (URL + one-shot bootstrap token) to bring a phone/desktop client onto the gateway. **Channel pairing** is a per-message TOFU flow where unknown senders get a code the operator approves via CLI.
- **Code location**: `src/pairing/setup-code.ts`, `src/pairing/pairing-challenge.ts`, `src/pairing/pairing-store.ts`.
- **See also**: Chapter 14 §14.6.

### Plugin

- **Definition**: A self-contained extension that contributes channels, providers, tools, skills, hooks, or memory backends. Loaded in-process with the Gateway and trusted with the same OS privileges.
- **Code location**: `src/plugins/`, manifests under `extensions/<id>/openclaw.plugin.json`.
- **Aliases**: AKA "extension"; bundled vs installed split.
- **See also**: Chapter 10; trust boundary in Chapter 14 §14.9.

### Plugin Activation Boundary

- **Definition**: The point in startup where a plugin's `activate()` lifecycle runs. Crossing this boundary is what turns an installed manifest into a live runtime contribution.
- **Code location**: Tests at `src/plugin-activation-boundary.test.ts`; activation flow in `src/plugins/`.
- **See also**: Chapter 10.

### Plugin SDK

- **Definition**: The TypeScript types and runtime helpers a plugin imports to integrate with the gateway. Re-exported through `src/plugin-sdk/`. Includes channel adapter types, gateway context types, secret-ref helpers, JSON store, runtime fs helpers.
- **Code location**: `src/plugin-sdk/index.ts` (and many adjacent helper files).
- **See also**: Chapter 10.

### ReplyDispatcher

- **Definition**: The outbound delivery hub. Receives reply payloads from the agent, queues them by delivery type, applies humanising delays, tracks in-flight deliveries, and routes each payload back to the originating channel.
- **Code location**: `src/auto-reply/reply/reply-dispatcher.types.ts:5`; runtime at `src/auto-reply/reply/reply-dispatcher.ts`.
- **See also**: Chapter 11.

### ReplyPayload

- **Definition**: The structured form of one outbound reply. Text, media, metadata, delivery hints. Internal form carries `trustedLocalMedia`; the SDK-exposed subset omits it.
- **Code location**: `src/auto-reply/reply-payload.ts:7` (internal), `src/plugin-sdk/reply-payload.ts:9` (SDK subset).
- **See also**: Chapter 11.

### RPC Method Registry

- **Definition**: The set of `method` strings the gateway will accept on its WebSocket. Built from core descriptors + reserved namespaces + plugin-declared methods, each pinned to a required scope.
- **Code location**: `src/gateway/methods/core-descriptors.ts`, scope lookup at `src/gateway/method-scopes.ts:39`.
- **See also**: Chapter 02.

### Scope

- **Definition**: A coarse-grained permission attached to a caller. OpenClaw has six: `operator.admin`, `operator.read`, `operator.write`, `operator.approvals`, `operator.pairing`, `operator.talk.secrets`. Each RPC method declares which scope a caller must hold.
- **Code location**: `src/gateway/operator-scopes.ts:1-14`; enforcement at `src/gateway/method-scopes.ts:150` (`authorizeOperatorScopesForMethod`).
- **See also**: Chapter 14 §14.5.

### Search Tool

- **Definition**: The agent-facing tool that runs web search. Backed by a configurable provider (Brave, Tavily, etc.); shipped as a plugin.
- **Code location**: `src/web-search/`; provider plugins under `extensions/brave/`, `extensions/tavily/`, etc.
- **See also**: Chapter 09.

### Secret Store

- **Definition**: The disk locations that hold credentials. OpenClaw has three: (1) `openclaw.json` (refs + opt-in plaintext), (2) the per-agent auth-profile store, (3) external provider state (env files, mounted JSON, vault daemons).
- **Code location**: `src/secrets/`, auth-profile store at `src/agents/auth-profiles/store.ts`.
- **See also**: Chapter 14 §14.7.

### Session

- **Definition**: A persistent conversation context — one row in a session store, paired with a JSONL transcript on disk. Holds model state, token usage, lifecycle timestamps, plugin extension slots, and a pointer to the transcript file.
- **Code location**: `src/config/sessions/types.ts:176` (`SessionEntry`); `src/sessions/`.
- **See also**: Chapter 06.

### SessionEntry

- **Definition**: The metadata record for one session in `sessions.json`. Small, mutable, integer-keyed map row. Distinct from the (separate, append-only) transcript file.
- **Code location**: `src/config/sessions/types.ts:176`.
- **See also**: Chapter 06.

### Session Lock

- **Definition**: A per-session advisory lock that prevents two agent attempts from interleaving writes against the same transcript. Configurable max-hold; reclamation is rate-limited.
- **Code location**: Session-lock backport `0b2f8dfbdb` and fix `8ac7cd621b`; `src/sessions/`.
- **See also**: Chapter 06.

### Skill

- **Definition**: A markdown-defined capability snippet (a `SKILL.md` file plus auxiliary assets) that an agent can be granted. Skills are smaller than tools and act more like role/playbook scaffolding.
- **Code location**: `src/agents/skills/skill-contract.ts:6` (`type Skill`); workspace loader at `src/agents/skills/workspace.ts`.
- **See also**: Chapter 09.

### Slash Command

- **Definition**: A command starting with `/` typed in a chat (or the TUI) — for example `/new`, `/compact`, `/export-session`. Resolved against the agent's installed commands.
- **Code location**: `src/commands/`; channel-native slash handlers in each channel plugin.
- **See also**: Chapter 09.

### State Directory

- **Definition**: Where OpenClaw writes mutable state — `<stateDir>` is typically `~/.openclaw/`. Holds `agents/<agentId>/agent/auth-profiles.json`, session stores, pairing files, installed extensions, lock file.
- **Code location**: `resolveStateDir` in `src/config/paths.js` (re-exported from `src/config/config.ts`); env `OPENCLAW_STATE_DIR`.
- **See also**: Chapter 03.

### Stream Error Placeholder

- **Definition**: A canonical sentinel string injected into a transcript when an assistant turn fails before producing any content. `"[assistant turn failed before producing content]"`. Detected during prompt replay so it can be omitted from the replayed history.
- **Code location**: `src/agents/stream-message-shared.ts:90` (`STREAM_ERROR_FALLBACK_TEXT`); replay-skip logic in `src/gateway/agent-prompt.ts:25`.
- **See also**: Chapter 07.

### System Prompt

- **Definition**: The leading message that sets the agent's persona, rules, and tool-use contract. Resolved per-agent from `agents.entries.<id>.systemPrompt` plus channel-specific overlays.
- **Code location**: Composed in `src/gateway/agent-prompt.ts`.
- **See also**: Chapter 07.

### Tool

- **Definition**: A function the agent can invoke during a turn. Declared with a `ToolDescriptor` and gated by tool policy, availability rules, and (for exec-class tools) an approval gate.
- **Code location**: `src/tools/types.ts:39` (`ToolDescriptor`); planner at `src/tools/planner.ts`.
- **See also**: Chapter 09.

### Tool Approval Gate

- **Definition**: The two-phase human-in-the-loop check that runs before an exec-class tool invocation. Binds the approval to the exact command + cwd + env (+ a script-file snapshot when resolvable) and delivers the approval card back through whichever channel the user is on.
- **Code location**: `src/agents/bash-tools.exec-approval-request.ts` (`buildExecApprovalRequestToolParams`); two-phase contract documented at `SECURITY.md:281-284`.
- **See also**: Chapter 09; Chapter 14 §14.8.

### Tool Use Block

- **Definition**: A content block in the agent's output stream that represents a structured tool call (name + arguments) rather than free text. Both the LLM and the gateway speak this shape.
- **Code location**: Stream wrappers in provider plugins (e.g., `extensions/anthropic/stream-wrappers.ts`); content typing in `src/agents/`.
- **See also**: Chapter 09.

### Transcript

- **Definition**: A JSONL file under `<stateDir>/agents/<agentId>/sessions/<sessionId>.jsonl`. Append-only line-per-event format; one header line plus one line per message/event. Different from the session store which is the map of all sessions.
- **Code location**: `src/sessions/transcript-events.ts`.
- **See also**: Chapter 06.

### Transcription

- **Definition**: Speech-to-text conversion of inbound audio. Backed by a configurable provider (OpenAI, Deepgram, …) and a realtime variant.
- **Code location**: `src/realtime-transcription/`; provider plugins like `extensions/deepgram/`.
- **See also**: Chapter 13 on voice/media.

### TTS

- **Definition**: Text-to-speech conversion of outbound text. Provider-pluggable; the wire format is normalised by the TTS provider runtime.
- **Code location**: `src/tts/`; provider plugins like `extensions/inworld/`, `extensions/azure-speech/`.
- **See also**: Chapter 13.

### WebChat

- **Definition**: The browser-based chat surface served directly by the gateway as a built-in channel. Lets the operator (and anyone they trust) chat with their agents from any device with a browser.
- **Code location**: `src/web/`; Control-UI plumbing in `src/gateway/control-ui-routing.ts`.
- **See also**: Chapter 12 on the Web UI.

### WebSocket Protocol

- **Definition**: The Gateway's primary RPC channel. JSON-RPC frames with `method`, `params`, `id`; the connect payload carries `connectAuth.{token|password}` and optional `scopes`. Used by CLI, Control UI, mobile apps, and node devices.
- **Code location**: `src/gateway/server.impl.ts`; connection auth at `src/gateway/auth.ts:400`.
- **See also**: Chapter 02.

### Workspace

- **Definition**: A per-agent root directory the agent's tools have file access to. Distinct from the state directory; the workspace is *the agent's work* (notes, scratch files, project clones), the state dir is OpenClaw's housekeeping.
- **Code location**: `agents.entries.<id>.workspace` in `OpenClawConfig`; workspace skill loader at `src/agents/skills/workspace.ts`.
- **See also**: Chapter 07.

---

## Part 2 — FAQ

### Q: How is OpenClaw different from Claude Desktop / ChatGPT?

OpenClaw runs *as a gateway* on your machine, not as a single chat window owned by one vendor. You point any number of frontends — Slack DMs, Telegram bots, the bundled Web UI, a phone app, the CLI, the OpenAI-compatible HTTP API — at the same Gateway, and each of them talks to whichever LLM provider you have configured (Anthropic, OpenAI, OpenRouter, local Ollama, etc.). The persona, tools, memory, and approvals are *yours*, configured in `openclaw.json`. Claude Desktop and ChatGPT are vertically integrated products owned by one vendor; OpenClaw is the *plumbing* you bring together yourself.

### Q: Why is the agent code in `extensions/` instead of `src/`?

`src/` is the gateway runtime — the always-loaded core. `extensions/` is plugin code that's loaded through the plugin registry. Anything that can vary by deployment — providers, channels, memory backends, the Codex/Claude bridges — lives in `extensions/` so it can be toggled off, swapped out, or shipped by third parties without forking `src/`. The bundled extensions ship inside the distribution and are loaded by default, but they go through the same manifest + activation path an external plugin would. This is the boundary that turns "what OpenClaw is" (gateway core) from "what OpenClaw does today" (the plugins you have installed).

### Q: How do I write a new channel plugin?

Start with `src/plugin-sdk/` and look at the smallest existing channel as a template — `extensions/synology-chat/` is a good size. You need an `openclaw.plugin.json` manifest declaring the `channelId`, a `register.runtime.ts` that registers a `ChannelPlugin` (`src/channels/plugins/types.plugin.ts:61`), and an adapter that produces inbound messages and accepts outbound `ReplyPayload`s. The Plugin SDK gives you a `runtime` helper for HTTP, filesystem, JSON store, and secret-ref resolution. The Gateway will pick up your plugin via the extensions directory and the operator's `plugins.allow` list.

### Q: How is config reloaded without restarting the gateway?

`gateway.reload.*` config knobs and the `config.patch` / `config.apply` RPC methods (`src/gateway/server-methods/config.ts`) coordinate live reload. Writers go through a debounced, audited path that records changed paths via `summarizeChangedPaths` (`src/gateway/control-plane-audit.ts:31`). Restart-required changes trigger a coalesced restart (`config.patch` and `update.run` both log a `restartReason=…` with the actor). The watcher path is `src/gateway/config-reload.ts`. Not every change is live — large structural changes still kick a restart, but typical edits (model defaults, allowlists, channel toggles) reload in place.

### Q: How are scheduled tasks implemented?

Through the **cron subsystem** in `src/cron/`. Tasks declared under `agents.entries.<id>.tasks` are turned into scheduled session keys of the form `agent:<id>:cron:<taskId>:run:<runId>` (`src/cron/session-reaper.test.ts:44`). On its schedule, the cron runner spawns an *isolated agent run* with that session key — meaning each cron firing is its own session, not a continuation of an interactive chat. See addendum 02a for the deep dive.

### Q: How does OpenClaw avoid the n×m provider/channel matrix explosion?

By making both ends speak through narrow contracts. A *channel plugin* implements `ChannelPlugin` (`src/channels/plugins/types.plugin.ts:61`); a *provider plugin* implements an `AgentRuntimeProviderHandle` (`src/agents/runtime-plan/types.ts:73`). The middle — message normalisation (`MsgContext`), agent execution (`agentCommand`), reply delivery (`ReplyDispatcher`) — only knows about the contracts, never about specific platforms. Adding a new channel or provider extends *one* side of the matrix; the other side keeps working unchanged. That is why the codebase has dozens of channel plugins and dozens of provider plugins without combinatorial wiring.

### Q: What is the difference between a Tool and a Skill?

A **tool** is a function the LLM calls during a turn — structured arguments, a return value, possibly side effects. Tools are declared with a `ToolDescriptor` (`src/tools/types.ts:39`) and gated by availability/policy/approval. A **skill** is a markdown document plus assets that the agent reads to learn *how to do something* — closer to a playbook than to a function. Skills are loaded from a workspace directory; tools are typed callables. You'd write a skill for "how to triage a P0 incident"; you'd write a tool for "fetch the JIRA issue with this id".

### Q: Why is there a `Crestodian` directory and what is it for?

Crestodian is the "guardian" assistant — the help desk you talk to when something is broken in your install. It's deliberately separate from the regular agent runtime so that "my agent doesn't answer" support questions can be diagnosed without the broken thing being the diagnostic itself. Run `openclaw crestodian` (`src/cli/program/register.crestodian.ts:8`) and it loads a static overview of your config, agents, default model, gateway reachability, and local tool presence (`src/crestodian/overview.ts:30`), then either prints it or drops into an interactive TUI. The persistent-write operations require `--yes`.

### Q: How does the gateway prevent two instances from running at once?

Through the **gateway lock** (`src/infra/gateway-lock.ts`). Before binding the listener, the gateway writes a `gateway.lock` file under the state directory containing `{pid, createdAt, configPath, startTime}`. A second gateway starting up reads the lock, checks `isPidAlive(pid)`, and probes the configured port via a quick TCP connect — if either says "still alive", the second instance aborts. Stale locks older than 30 s (`DEFAULT_STALE_MS`, `src/infra/gateway-lock.ts:15`) are reclaimed automatically. The lock makes `openclaw gateway` safe to invoke from any shell.

### Q: Where do session transcripts live on disk?

Two layers. The **session store** at `<stateDir>/agents/<agentId>/sessions/sessions.json` holds the small map of session metadata — one `SessionEntry` per session (`src/config/sessions/types.ts:176`). The **transcript** for each session lives at `<stateDir>/agents/<agentId>/sessions/<sessionId>.jsonl` — append-only, one JSON object per line, a header line plus one line per message/event. The store is mutable and re-written atomically; the transcript is append-only and replayable. The split exists so opening "list of sessions" doesn't load gigabytes of message bodies.

### Q: How are credentials kept out of `openclaw.json`?

By using `SecretRef`s. Anywhere config accepts a secret it also accepts `{source, provider, id}` (`src/config/types.secrets.ts:12`). The three sources are `env` (read a process env var), `file` (read a JSON path in a provider-mounted file), and `exec` (shell out to a provider command like a vault CLI). The resolver in `src/secrets/resolve.ts` is the only place that turns a ref into a value, and the value is never logged. `openclaw secrets audit` walks the config for plaintext secrets, unresolved refs, and shadowing — see Chapter 14 §14.7.

### Q: What does the v2026.5.22 Docker token-print fix actually do?

Earlier `scripts/docker/setup.sh` printed `$OPENCLAW_GATEWAY_TOKEN` to its standard output, which meant the live token ended up in `docker logs` and any CI scrollback. Commit `75b5c76c7f` ("fix(docker): avoid printing gateway token") removes the literal echo and adds a `--suppress-gateway-token-output` flag to `openclaw onboard` (`src/cli/program/register.onboard.ts:170`). The wizard finalizer reads `opts.suppressGatewayTokenOutput` (`src/wizard/setup.finalize.ts:80`) and filters every token-bearing note line from the post-onboard summary. See Chapter 14 §14.2.4.

### Q: Why are the OpenAI-compatible endpoints "full operator" and not scoped?

Because the OpenAI-compatible HTTP surface authenticates by *possession of the shared gateway secret*. In OpenClaw's trust model, anyone holding that secret is the operator; there is no second-tier "user inside the operator" boundary to scope down to. Narrower `x-openclaw-scopes` headers are explicitly *ignored* on the shared-secret path (`SECURITY.md:131-134`). If you want a narrower bearer, use `gateway.auth.mode = "none"` behind an identity-bearing reverse proxy that honours per-request scope headers.

### Q: How does OpenClaw know whether to default the auth mode to token or password?

`src/gateway/auth-resolve.ts:74-91` walks an explicit precedence chain: explicit override → configured `gateway.auth.mode` → "password if a password is configured" → "token if a token is configured" → default to "token". The `modeSource` field records which step won, which is useful in diagnostics. If *both* a token and a password are configured but `mode` is unset, `assertExplicitGatewayAuthModeWhenBothConfigured` (`src/gateway/auth-mode-policy.ts:21`) throws — silent precedence between two co-configured secrets would be the bug that hides for months.

### Q: What's the difference between the gateway lock and a session lock?

The **gateway lock** is one global per state-directory: it stops two gateway processes from racing on the same state. The **session lock** is one per-session: it stops two agent attempts from interleaving writes against the same transcript. The gateway lock lives in `src/infra/gateway-lock.ts`; the session lock backport is commit `0b2f8dfbdb` and the v2026.5.22 fix to enforce its `maxHoldMs` during reclaim is `8ac7cd621b`.

---

## Part 3 — Cheatsheet

### Environment variables (selected)

| Variable | What it controls |
| --- | --- |
| `OPENCLAW_HOME` | Root directory for OpenClaw state (default `~/.openclaw`). Most other path defaults are derived from this. |
| `OPENCLAW_STATE_DIR` | Override for the state directory specifically (where sessions, auth profiles, pairing, installed extensions live). |
| `OPENCLAW_CONFIG_PATH` | Path to `openclaw.json`. Otherwise resolved from the state dir. |
| `OPENCLAW_AGENT_DIR` | Per-agent directory override (rarely needed; usually agent dirs are derived from the state dir + agentId). |
| `OPENCLAW_GATEWAY_TOKEN` | The shared bearer secret for `gateway.auth.mode = "token"`. Conflicts with `gateway.auth.token` are surfaced by `auth-token-source-conflict.ts:17`. |
| `OPENCLAW_GATEWAY_PASSWORD` | The shared password for `gateway.auth.mode = "password"`. |
| `OPENCLAW_GATEWAY_URL` | URL a CLI invocation should target (defaults to the local gateway). |
| `OPENCLAW_GATEWAY_PORT` | Port the gateway binds (default 18789). |
| `OPENCLAW_BIND` | Bind policy: `loopback`, `lan`, `tailnet`, `auto`. |
| `OPENCLAW_GATEWAY_STARTUP_TRACE` | When truthy, emits per-phase startup timings to stderr (`src/entry.ts:41`, `src/gateway/server.impl.ts:223`). |
| `OPENCLAW_GATEWAY_RESTART_TRACE` | Same idea for live-restart paths. |
| `OPENCLAW_AUTH_STORE_READONLY` | Forces the auth-profile store into read-only mode. Set automatically by `entry.ts:104` during `openclaw secrets audit`. |
| `OPENCLAW_AUTH_PROFILE_SECRET_KEY` | Override for the auth-profile encryption key. |
| `OPENCLAW_BUNDLED_PLUGINS_DIR` | Override for the bundled-extensions root (test/dev-time only). |
| `OPENCLAW_BUNDLED_HOOKS_DIR` | Override for the bundled-hooks root. |
| `OPENCLAW_BUNDLED_SKILLS_DIR` | Override for the bundled-skills root. |
| `OPENCLAW_DISABLE_BUNDLED_PLUGINS` | If set, skip loading bundled extensions entirely (helpful for minimal repro). |
| `OPENCLAW_DISABLE_BONJOUR` | Disable mDNS gateway advertising (Docker compose sets this on by default — see `scripts/docker/setup.sh`). |
| `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS` | Allow plaintext `ws://` to public hosts (off by default; mobile pairing has stricter rules — `src/pairing/setup-code.ts:135`). |
| `OPENCLAW_DEBUG_PROXY_*` | Family of toggles for the debug HTTP proxy capture (off in production). |
| `OPENCLAW_DIAGNOSTICS_EVENT_LOOP` | Enables event-loop lag sampling in startup timing. |
| `OPENCLAW_HANDSHAKE_TIMEOUT_MS` / `OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS` | Tune connection handshake timeouts. |
| `OPENCLAW_HIDE_BANNER` | Hide the CLI startup banner. |
| `NODE_COMPILE_CACHE` / `NODE_DISABLE_COMPILE_CACHE` | Node.js native compile cache toggles. `src/entry.compile-cache.ts` opts in by default and respawns without it on failure (see `entry.respawn.ts`). |
| `NODE_ENV` | Standard; affects logging defaults. |

### CLI subcommands (selected)

| Command | What it does |
| --- | --- |
| `openclaw` | Launches Crestodian by default (the ring-zero helper) — see `src/cli/program/register.crestodian.ts:18`. |
| `openclaw gateway` | Start the gateway in the foreground. Registers core CLI plumbing at `src/cli/program/`. |
| `openclaw onboard` | Run the setup wizard. Supports `--mode local`, `--no-install-daemon`, `--gateway-auth token`, `--skip-ui`, `--suppress-gateway-token-output` (v2026.5.22; `src/cli/program/register.onboard.ts:170`). |
| `openclaw crestodian` | Open the ring-zero setup and repair helper (`src/cli/program/register.crestodian.ts:10`). Supports `-m <text>`, `--yes`, `--json`. |
| `openclaw secrets audit` | Scan config and auth stores for plaintext secrets, unresolved refs, shadowed refs, and legacy residue. `--check` for non-zero exit on findings; `--allow-exec` to actually run exec providers; `--json` for machine output (`src/cli/secrets-cli.ts:97`). Forces `OPENCLAW_AUTH_STORE_READONLY` via `entry.ts:104`. |
| `openclaw secrets reload` | Tell a running gateway to re-resolve secrets without a full restart (`src/cli/secrets-cli.ts:62`). |
| `openclaw secrets configure` | Interactive provider setup and SecretRef mapping. `--apply` to write changes (`src/cli/secrets-cli.ts:150`). |
| `openclaw secrets apply` | Apply a pre-computed secrets plan (`src/cli/secrets-cli.ts:268`). |
| `openclaw security audit` | Run the security-side audit (`src/cli/security-cli.ts`); complements `secrets audit`. |
| `openclaw doctor` | Aggregate health check — config validity, gateway reachability, model providers, auth, dangerous flags. Includes `--generate-gateway-token` for the runtime-token path (`src/commands/doctor-gateway-auth-token.ts`). |
| `openclaw nodes` | Manage paired nodes (the remote-execution surface). |
| `openclaw browser` | Drive the embedded browser tool. |
| `openclaw pairing approve <channel> <code>` | Approve a pending pairing request from a chat user (`src/pairing/pairing-messages.ts:10`). |
| `openclaw config get/set <path>` | Read/write `openclaw.json` paths from the CLI. |
| `openclaw dashboard` | Open the bundled Control UI in a browser. `--no-open` to print the URL without launching. |

### Useful state-directory paths

- `~/.openclaw/openclaw.json` — main config.
- `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` — auth profile store.
- `~/.openclaw/agents/<agentId>/sessions/sessions.json` — session store.
- `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl` — session transcript.
- `~/.openclaw/pairing/<channel>-pairing.json` — pending pairing requests.
- `~/.openclaw/pairing/allow-from-<channel>.json` — approved senders per channel.
- `<state>/extensions/` — operator-installed plugins (separate from bundled `extensions/` in the distribution).
- `<state>/gateway.lock` — process lock (`src/infra/gateway-lock.ts`).
