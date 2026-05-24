# Chapter 01: Architecture Overview & Boot Flow

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

This chapter is written for engineers fluent in TypeScript and Node.js who are about to read OpenClaw's source for the first time. Before any subsystem deep-dive, you need a reliable map: what OpenClaw is, how its code is laid out, and what actually happens between pressing Enter on `openclaw gateway` and the gateway accepting its first WebSocket connection. Later chapters drill down layer by layer; this one only draws the skeleton.

---

## 1. What OpenClaw Is

### 1.1 A one-sentence definition

OpenClaw is a **self-hosted personal AI assistant gateway**. It unifies the messaging channels you already use, lets a single LLM-driven assistant read and reply on every one of them, optionally speaks back through voice, and renders an interactive Canvas surface.

The opening of `README.md` is unusually precise (`README.md:21-22`):

```
OpenClaw is a personal AI assistant you run on your own devices.
It answers you on the channels you already use. ... The Gateway is just
the control plane — the product is the assistant.
```

Three judgements in that sentence shape the entire codebase:

1. **"run on your own devices"** — OpenClaw is single-user, self-hosted. It is not a SaaS and does not assume multi-tenancy. That decision propagates everywhere: a single `openclaw.json` config, the gateway binds loopback by default, and authentication is "operator + trusted devices" rather than user accounts.
2. **"the channels you already use"** — the value is not yet another chat box, it is reusing existing IMs. `README.md:26` lists the supported channels: WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, IRC, Microsoft Teams, Matrix, Feishu, LINE, Mattermost, Nextcloud Talk, Nostr, Synology Chat, Tlon, Twitch, Zalo, WeChat, QQ, WebChat, and more.
3. **"the Gateway is just the control plane"** — this is the key to reading the architecture. The Gateway is not the product, it is the **control plane**: connection management, RPC dispatch, session orchestration, and plugin loading. The "product" is the assistant (agent + LLM + tools) running on top of it.

### 1.2 Design constraints from VISION.md

`VISION.md` is not marketing copy, it is a list of **architectural constraints**. A few that matter most when reading the source:

- **Core stays lean; capability ships as plugins** (`VISION.md:54-57`): "Core stays lean; optional capability should usually ship as plugins." This is why `extensions/` contains ~137 sub-packages — channels, providers, memory, and tools are almost all plugins.
- **Why TypeScript** (`VISION.md:100-104`): "OpenClaw is primarily an orchestration system: prompts, tools, protocols, and integrations." OpenClaw positions itself as an **orchestration system** rather than a numerical one, so TS — readable, fast to modify, easy to extend — beats Python or Rust here.
- **Security as a deliberate tradeoff** (`VISION.md:43-44`): strong defaults plus explicit knobs for high-power workflows. The presence of a substantial `SECURITY.md` is unusual for a project this size.

`AGENTS.md` further codifies the boundary (`AGENTS.md:28-31`):

```
- Core stays plugin-agnostic. No bundled ids/defaults/policy in core ...
- Plugins cross into core only via openclaw/plugin-sdk/*, manifest metadata,
  injected runtime helpers, documented barrels (api.ts, runtime-api.ts).
```

In other words, **core may not import any plugin's `src/**`, and plugins may not import core internals**. The only path between them is `src/plugin-sdk/*`, manifest metadata, and injected runtime helpers. When you see anything in `src/` that looks like it knows about `extensions/`, it is either a bug or one of the deliberate "bundled plugin" exceptions.

### 1.3 Project history

`VISION.md:13` records the rename chain: `Warelay -> Clawdbot -> Moltbot -> OpenClaw`. This history occasionally leaks into the code as environment variables and config keys with older names; `src/config/paths.ts:21` still keeps a `.clawdbot` state-dir fallback as a "remaining legacy pre-rebrand state dir." All user-facing naming today is `openclaw` (see `src/entry.ts:94`, which sets `process.title = "openclaw"`).

---

## 2. Monorepo Layout

OpenClaw is a pnpm-workspaces monorepo. `pnpm-workspace.yaml:1-5` declares four kinds of workspace:

```yaml
packages:
  - .            # root package "openclaw" (the core)
  - ui           # browser-side Control UI
  - packages/*   # publishable SDKs
  - extensions/* # channel / provider / memory plugins
```

The top-level directory responsibilities — memorise this table and you will rarely get lost when grepping:

| Directory | Role | Key entry points |
|-----------|------|------------------|
| `src/` | **Core**. Gateway, CLI, agent orchestration, inbound pipeline, plugin loader, protocol definitions | `src/entry.ts`, `src/gateway/`, `src/cli/` |
| `apps/` | **Native companion apps**. macOS / iOS / Android clients plus `macos-mlx-tts`, `swabble` | `apps/macos`, `apps/ios`, `apps/android` |
| `packages/` | **Publishable SDKs**. Stable surfaces external authors compile against | `packages/sdk`, `packages/plugin-sdk`, `packages/memory-host-sdk`, `packages/plugin-package-contract` |
| `extensions/` | **Plugins**. Channels, providers, memory, tools. ~137 sub-packages — almost all real "capability" lives here | `extensions/telegram`, `extensions/whatsapp`, ... |
| `ui/` | **Browser Control UI**. Vite single-page app | `ui/index.html`, `ui/vite.config.ts`, `ui/src/` |
| `config/` | **Build-time tool config**. tsconfig templates, lint, format, Swift configs | `config/tsconfig/` |
| `scripts/` | **Build & ops scripts**. Build orchestration, release validation, test runners | `scripts/build-all.mjs` |

A few notes:

- `src/` itself contains more than 100 sub-directories. "Lean core" is a direction (`VISION.md:56` says "generally slimming down core"), not a current claim.
- `extensions/` is called "plugins" in user-facing docs but `extensions/` internally. `AGENTS.md:17` is explicit: "Product/docs/UI/changelog wording: 'plugin/plugins'; `extensions/` is internal." This wiki uses "plugin" except when discussing the on-disk directory layout.
- `packages/` exports the four published SDKs visible to plugin authors:
  - `@openclaw/sdk` — public type and helper surface for runtime consumers.
  - `@openclaw/plugin-sdk` — the official cross-boundary API for plugin code.
  - `@openclaw/memory-host-sdk` — the contract for memory plugins (only one can be active at a time, see `VISION.md:75-77`).
  - `@openclaw/plugin-package-contract` — describes the package shape so installers can validate plugin packages before activation.
- Root `package.json` is large because it carries dependencies for both the core and many bundled plugins that ship in the npm dist tarball.

---

## 3. The Four-Layer Runtime

OpenClaw's runtime cleanly slices into four layers. Understanding the four layers and the direction of traffic between them is the foundation for everything that follows.

### 3.1 Architecture diagram

<svg viewBox="0 0 760 480" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="OpenClaw four-layer runtime architecture: channels, gateway control plane, message orchestration, AI core">
<defs>
<marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">OpenClaw four-layer runtime</text>
<rect x="20" y="36" width="720" height="52" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" rx="6"/>
<text x="380" y="57" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">Outside world &mdash; 20+ messaging channels</text>
<rect x="36" y="63" width="90" height="18" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="3"/>
<text x="81" y="76" text-anchor="middle" font-size="10" fill="#7c3aed">WhatsApp</text>
<rect x="136" y="63" width="90" height="18" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="3"/>
<text x="181" y="76" text-anchor="middle" font-size="10" fill="#7c3aed">Telegram</text>
<rect x="236" y="63" width="90" height="18" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="3"/>
<text x="281" y="76" text-anchor="middle" font-size="10" fill="#7c3aed">Slack</text>
<rect x="336" y="63" width="90" height="18" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="3"/>
<text x="381" y="76" text-anchor="middle" font-size="10" fill="#7c3aed">Feishu</text>
<rect x="436" y="63" width="90" height="18" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="3"/>
<text x="481" y="76" text-anchor="middle" font-size="10" fill="#7c3aed">WebChat</text>
<text x="560" y="76" font-size="10" fill="#94a3b8">... more</text>
<line x1="380" y1="88" x2="380" y2="104" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar1)"/>
<rect x="20" y="104" width="720" height="80" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="380" y="122" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">L1 &middot; Channels</text>
<text x="380" y="140" text-anchor="middle" font-size="11" fill="#64748b">extensions/&lt;channel&gt;/  +  src/channels/</text>
<text x="380" y="156" text-anchor="middle" font-size="11" fill="#64748b">Each channel is a plugin; normalizes platform-native events into OpenClaw inbound messages</text>
<line x1="380" y1="184" x2="380" y2="200" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar1)"/>
<rect x="20" y="200" width="720" height="88" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
<text x="380" y="218" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">L2 &middot; Gateway control plane</text>
<text x="380" y="236" text-anchor="middle" font-size="11" fill="#64748b">src/gateway/server.impl.ts</text>
<text x="180" y="254" text-anchor="middle" font-size="10" fill="#64748b">HTTP / WebSocket listeners</text>
<text x="380" y="254" text-anchor="middle" font-size="10" fill="#64748b">RPC method registry</text>
<text x="580" y="254" text-anchor="middle" font-size="10" fill="#64748b">WS lifecycle / auth / scope gating</text>
<text x="380" y="272" text-anchor="middle" font-size="10" fill="#64748b">In-memory registries: chat runs / sessions / nodes</text>
<line x1="380" y1="288" x2="380" y2="304" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar1)"/>
<rect x="20" y="304" width="720" height="80" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5" rx="6"/>
<text x="380" y="322" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">L3 &middot; Message orchestration</text>
<text x="220" y="342" text-anchor="middle" font-size="10" fill="#64748b">src/auto-reply/  inbound pipeline: dedupe, route, throttle</text>
<text x="580" y="342" text-anchor="middle" font-size="10" fill="#64748b">src/sessions/  session state &amp; history</text>
<text x="380" y="360" text-anchor="middle" font-size="10" fill="#64748b">src/auto-reply/reply/  outbound dispatch (reply dispatcher)</text>
<line x1="380" y1="384" x2="380" y2="400" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar1)"/>
<rect x="20" y="400" width="720" height="64" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="380" y="418" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">L4 &middot; AI core (assistant)</text>
<text x="180" y="438" text-anchor="middle" font-size="10" fill="#64748b">src/agents/  agent harness</text>
<text x="380" y="438" text-anchor="middle" font-size="10" fill="#64748b">provider plugins  LLM</text>
<text x="560" y="438" text-anchor="middle" font-size="10" fill="#64748b">src/tools/  src/plugins/</text>
<line x1="380" y1="464" x2="380" y2="476" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
<text x="380" y="476" text-anchor="middle" font-size="9" fill="#94a3b8">LLM inference + tool side-effects -&gt; reply travels back L3-&gt;L2-&gt;L1</text>
</svg>
<span class="figure-caption">Figure R1.1 | OpenClaw four-layer runtime; inbound traffic flows top-down through channels, gateway, orchestration, AI core, and replies travel back along the same path.</span>

<details>
<summary>ASCII original</summary>

```
                          Outside world
   ┌──────────┬──────────┬──────────┬──────────┬──────────┐
   │ WhatsApp │ Telegram │  Slack   │  Feishu  │ WebChat  │  ... 20+ channels
   └────┬─────┴────┬─────┴────┬─────┴────┬─────┴────┬─────┘
        │          │          │          │          │
═══════════════════ L1: Channels ═════════════════════════
        │   extensions/<channel>/  +  src/channels/
        │   Each channel is a plugin; normalizes
        │   platform-native events into OpenClaw inbound messages
        ▼
═════════════ L2: Gateway control plane ═════════════════
        │   src/gateway/server.impl.ts
        │   - HTTP / WebSocket listeners
        │   - RPC method registry
        │   - WS lifecycle / auth / scope gating
        │   - In-memory registries: chat runs, sessions, nodes
        ▼
═════════════ L3: Message orchestration ═════════════════
        │   src/auto-reply/   inbound pipeline (dedupe, route, throttle)
        │   src/sessions/     session state & history
        │   src/auto-reply/reply/  outbound reply dispatcher
        ▼
═════════════ L4: AI core (assistant) ═══════════════════
        │   src/agents/        agent harness & run loop
        │   provider plugins   LLM (OpenAI/Anthropic/...)
        │   src/tools/         tool calls
        │   src/plugins/       plugin loader & runtime
        ▼
    LLM inference + tool side-effects (files, shell, Canvas, nodes)
        │
        └──► Reply travels back L3 -> L2 -> L1 to the origin channel
```

</details>

The four layers are **bidirectional**. Inbound messages travel top-down through all four; agent-produced replies travel bottom-up back to the originating channel. The Gateway (layer L2) is the funnel — every CLI command, the browser Control UI, native apps, and node devices all connect to it through WebSocket.

### 3.2 L1: Channels

The job of L1 is to **normalise a zoo of platform event formats** into a single inbound message shape. Two halves cooperate:

- `extensions/<channel>/` — one plugin package per channel that wraps the platform SDK (Telegram uses grammY, WhatsApp uses baileys, etc.).
- `src/channels/` — core-side channel contract types, registry, allowlist, conversation labelling, message metadata helpers. See `src/channels/registry.ts:19` which notes "`src/channels/plugins/*` can eagerly load channel implementations."

The channel layer is a plugin layer. Gateway startup discovers loaded channels via the plugin registry rather than direct imports — this is enforced by `AGENTS.md:30-31` and by the Gateway hot-paths guardrails in `src/gateway/AGENTS.md:1-23`, which forbid the Gateway HTTP/server code from "loading broad bundled channel registries just to answer static questions."

In bigger deployments the channel layer also handles a long list of "boring but real" concerns: webhook signature verification (Slack, Discord), QR-code pairing flows (WhatsApp, Signal), session reconnect after rate-limit lockouts, attachments and media downloading with size caps, and per-channel ack semantics (Slack reactions, Telegram typing-then-read receipts). Each channel plugin owns its own subdirectory under `extensions/<channel>/` and exposes only the contract surface in its `runtime-api.ts` to core.

### 3.3 L2: Gateway control plane

This is the subject of Chapter 02; here we only locate it. The gateway is a long-running process exposing:

- A **WebSocket service** — every control-plane RPC (request and event push) flows over it.
- An **HTTP service** — serves Control UI static assets and optional OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/responses`), plus an MCP loopback bridge.

`src/gateway/server.impl.ts:459-461` defines the minimal handle returned to callers — a `GatewayServer` only exposes `close()`:

```ts
export type GatewayServer = {
  close: (opts?: GatewayCloseOptions) => Promise<void>;
};
```

The factory `startGatewayServer` lives at `src/gateway/server.impl.ts:531`, but callers reach it through the thin facade in `src/gateway/server.ts:24-29` which lazy-imports the heavy implementation only when needed:

```ts
export async function startGatewayServer(
  ...args: Parameters<typeof import("./server.impl.js").startGatewayServer>
): ReturnType<typeof import("./server.impl.js").startGatewayServer> {
  const mod = await loadServerImpl();
  return await mod.startGatewayServer(...args);
}
```

The default listening port is `18789` (`src/config/paths.ts:262`).

### 3.4 L3: Message orchestration

An inbound message that arrives at the Gateway is **not** handed to the LLM directly. It first flows through `src/auto-reply/`'s **inbound pipeline**: deduplication, deciding whether a reply is needed, routing to the correct session, throttling. The companion `src/sessions/` directory holds session state — one "session" is one conversation context with its own history, configuration, and owning agent.

When the assistant produces output (streamed tokens, tool calls, final text), those become events. The **reply dispatcher** under `src/auto-reply/reply/` is responsible for delivering them back to the originating channel: it ties an event stream to a specific outbound surface, applies channel-specific formatting (Telegram markdown vs. WhatsApp plain), and enforces backpressure.

The Gateway also bridges directly into orchestration through `agentCommand` — see `src/gateway/boot.ts:6-7` and `src/gateway/openai-http.ts:14` — which is how external HTTP entry points hand a request off to the assistant pipeline.

Two design decisions in L3 are worth flagging up front because they show up repeatedly in later chapters:

- **One session = one agent at a time.** Sessions belong to a specific agent (the `agentId` in `agents.<id>` of the config). A binding (`bindings[]` in the config) maps a channel + peer + thread tuple to a session, which determines the agent that will handle it. Multi-agent routing is a routing-rule problem, not a scheduling problem.
- **The reply dispatcher is per-session, not per-channel.** The dispatcher tracks pending replies on a per-session basis (`getTotalPendingReplies` from `auto-reply/reply/dispatcher-registry.js`). That choice lets a single Telegram chat that is talking to two different agents at once keep their reply streams independent.

### 3.5 L4: AI core

The bottom layer is where work actually happens:

- `src/agents/` — agent harness and run loop. Agents are pluggable; `src/cli/run-main.ts:220-222` calls into `agents/harness/registry.js`, confirming that harnesses are registered resources with explicit lifecycle.
- `src/provider-runtime/` and provider plugins — LLM providers (OpenAI, Anthropic, Bedrock, ...) are plugins. `pnpm-workspace.yaml:62` pins `@anthropic-ai/sdk` exact version via overrides, showing how tightly provider integrations depend on vendor SDK shapes.
- `src/tools/` — tool calls (file read/write, shell, web search, etc.) the agent can invoke.
- `src/plugins/` and `src/plugin-sdk/` — the loader and runtime that activate plugins, plus the public surface plugins import.

Agent output (streamed tokens, tool calls, final text) is broadcast as **events** through the gateway's chat-stream registry, then the dispatcher in L3 routes those events back into the originating channel. That round-trip is the subject of the trace tour.

### 3.6 The "Gateway is the control plane, the assistant is the product" framing

The architectural framing is the single most useful sentence in `README.md:22`: "The Gateway is just the control plane — the product is the assistant." Treat this as a partitioning function:

- **Control-plane code** lives in L2 (`src/gateway/`). It is responsible for *who talks to what*, not *what is said*. Connection auth, scope gating, RPC dispatch, lifecycle, lock files — these are control plane.
- **Product code** lives in L1, L3, and L4. It is responsible for *what gets said and what happens*. Channels translate platforms, orchestration decides who replies, the AI core figures out what to say.

Treat any pull request that puts "what is said" logic into L2 as suspicious. The Gateway-hot-paths guardrails (`src/gateway/AGENTS.md:7-11`) reinforce this: "Do not load broad bundled channel registries from Gateway HTTP/server code just to answer static questions." The Gateway is allowed to know that *a* channel exists, not what messages it forms.

---

## 4. The Boot Chain

This is the most hands-on part of the chapter. From a shell prompt to the Gateway port being LISTEN, control flows through five distinct stages. Each stage has a narrow responsibility, and each has at least one feature that becomes mysterious if you don't know it exists.

<svg viewBox="0 0 640 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Boot chain: five stages from openclaw.mjs to server.impl.ts">
<defs>
<marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="320" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Boot chain (five stages)</text>
<rect x="60" y="32" width="520" height="54" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="200" y="52" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">1. openclaw.mjs</text>
<text x="200" y="68" text-anchor="middle" font-size="10" fill="#64748b">Launcher (pure .mjs, no build needed)</text>
<text x="470" y="52" text-anchor="middle" font-size="10" fill="#64748b">Node version guard</text>
<text x="470" y="66" text-anchor="middle" font-size="10" fill="#64748b">Compile-cache decision / respawn</text>
<line x1="320" y1="86" x2="320" y2="100" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar2)"/>
<rect x="60" y="100" width="520" height="54" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5" rx="6"/>
<text x="200" y="120" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">2. src/entry.ts</text>
<text x="200" y="136" text-anchor="middle" font-size="10" fill="#64748b">Entry (compiled to dist/entry.js)</text>
<text x="470" y="120" text-anchor="middle" font-size="10" fill="#64748b">isMainModule guard</text>
<text x="470" y="136" text-anchor="middle" font-size="10" fill="#64748b">argv normalize / profile / container / trace</text>
<line x1="320" y1="154" x2="320" y2="168" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar2)"/>
<rect x="60" y="168" width="520" height="54" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5" rx="6"/>
<text x="200" y="188" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">3. src/cli/run-main.ts</text>
<text x="200" y="204" text-anchor="middle" font-size="10" fill="#64748b">Command router</text>
<text x="470" y="188" text-anchor="middle" font-size="10" fill="#64748b">Container target / dotenv / proxy</text>
<text x="470" y="204" text-anchor="middle" font-size="10" fill="#64748b">gateway-run fast-path / Commander</text>
<line x1="320" y1="222" x2="320" y2="236" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar2)"/>
<rect x="60" y="236" width="520" height="54" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
<text x="200" y="256" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">4. gateway command</text>
<text x="200" y="272" text-anchor="middle" font-size="10" fill="#64748b">src/cli/gateway-cli/run.ts</text>
<text x="470" y="264" text-anchor="middle" font-size="10" fill="#64748b">Parse --port / --bind / --auth options</text>
<line x1="320" y1="290" x2="320" y2="304" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar2)"/>
<rect x="60" y="304" width="520" height="54" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="200" y="324" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">5. server.ts -&gt; server.impl.ts</text>
<text x="200" y="340" text-anchor="middle" font-size="10" fill="#64748b">Actually starts the gateway</text>
<text x="470" y="332" text-anchor="middle" font-size="10" fill="#64748b">Lazy import of server.impl.ts</text>
<text x="470" y="348" text-anchor="middle" font-size="10" fill="#64748b">HTTP/WS listening on port 18789</text>
</svg>
<span class="figure-caption">Figure R1.2 | The five stages of the boot chain — pure .mjs launcher, TypeScript entry, command router, gateway-cli, and finally the server implementation.</span>

<details>
<summary>ASCII original</summary>

```
   openclaw.mjs        Stage 1: Launcher (pure .mjs)
        │  - Node version guard
        │  - Compile-cache decision / respawn
        │  - import dist/entry.js
        ▼
   src/entry.ts        Stage 2: Entry (compiled to dist/entry.js)
        │  - isMainModule guard
        │  - normalize argv, apply profile/container
        │  - emit startup trace events
        ▼
   src/cli/run-main.ts Stage 3: Command router
        │  - container fast-path
        │  - dotenv / proxy bootstrap
        │  - gateway-run fast-path or Commander dispatch
        ▼
   gateway command     Stage 4: src/cli/gateway-cli/run.ts
        │  - parse --port/--bind/--auth/--tailscale
        │  - read config snapshot
        │  - resolve auth / bind mode
        ▼
   server.ts -> server.impl.ts  Stage 5: actually listen
                       HTTP + WS on port 18789
```

</details>

### 4.1 Stage 1 — `openclaw.mjs` launcher

The npm bin entry is **not** TypeScript-compiled. It is a plain `.mjs` (`openclaw.mjs:1`, `package.json` declares `"bin": { "openclaw": "openclaw.mjs" }`). The reason is hard requirement: you must be able to run `openclaw` from a globally installed package without depending on the rest of the dist tree being importable. This file does three things only:

**Node version guard.** `openclaw.mjs:11-13` declares the minimum (`Node 22.19+`, `Node 24` recommended), and `openclaw.mjs:27-40` exits with a curated nvm-friendly error if you are below it:

```js
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 19;
const MIN_NODE_VERSION = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`;
// ...
process.stderr.write(
  `openclaw: Node.js v${MIN_NODE_VERSION}+ is required (current: v${process.versions.node}).\n` +
    "If you use nvm, run:\n" +
    `  nvm install ${MIN_NODE_MAJOR}\n` +
    ...
);
```

**Compile-cache management.** Node's V8 compile cache (`module.enableCompileCache`) can shave hundreds of ms off subsequent boots, but the directory layout matters. `openclaw.mjs:66-85` builds a versioned cache path: `os.tmpdir()/node-compile-cache/openclaw/<version>/<install-marker>`. The version comes from `package.json`; the install-marker is `mtime-size` of that same `package.json`. This isolates caches per install and prevents a stale cache from a different package version being used by accident.

The launcher detects whether it is a source checkout (`isSourceCheckoutLauncher` at `openclaw.mjs:44-46` checks for `.git` or `src/entry.ts`) — in source checkouts, the compile cache is disabled to avoid pinning stale TypeScript-derived output. If a respawn is needed (to set `NODE_COMPILE_CACHE` env, or to clear it), `runRespawnedChild` (`openclaw.mjs:94-181`) forks Node with the right env and forwards signals.

**Help fast-paths.** `openclaw.mjs:472-486` checks for bare-root help (`openclaw -h`) and a few common subcommand helps (`openclaw browser --help`, `openclaw secrets --help`, `openclaw nodes --help`). For these it tries to read precomputed help text from `dist/cli-startup-metadata.json` and print it without ever importing the heavy entry. This is the difference between a 50 ms `openclaw --help` and a 2-second one.

Finally, the launcher imports `./dist/entry.js` (`openclaw.mjs:479`) — that is where TypeScript-compiled code lives. If the dist tree is missing, `buildMissingEntryErrorMessage` (`openclaw.mjs:311-326`) explains why ("This install looks like an unbuilt source tree or GitHub source archive...").

### 4.2 Stage 2 — `src/entry.ts`

This is the TypeScript entry compiled to `dist/entry.js`. Five responsibilities, each guarded.

**Main-module guard** (`src/entry.ts:79-86`):

```ts
if (
  !isMainModule({
    currentFile: fileURLToPath(import.meta.url),
    wrapperEntryPairs: [...ENTRY_WRAPPER_PAIRS],
  })
) {
  // Imported as a dependency — skip all entry-point side effects.
}
```

Why this guard? The bundler may import `entry.js` as a shared dependency when `dist/index.js` is the actual entry. Without the guard, the top-level code would call `runCli` a second time, starting a duplicate gateway that crashes on the port lock — the comment at `src/entry.ts:75-78` spells this out. The wrapper-entry-pairs list (`src/entry.ts:21-24`) tells the guard which launcher filenames count as a "wrapper" (here: `openclaw.mjs` and `openclaw.js` paired with `entry.js`).

**Compile-cache respawn (TS side).** `src/entry.ts:89-92` calls `resolveEntryInstallRoot` and `respawnWithoutOpenClawCompileCacheIfNeeded`. This intentionally overlaps with the launcher's compile-cache logic — see the comment at `openclaw.mjs:100-103`: "This intentionally overlaps with src/entry.compile-cache.ts; keep the respawn supervision behavior in sync until the launcher can share TS code." The duplication exists because the launcher cannot import compiled TS until it has decided on the cache.

**Argv normalisation, profile, and container target** (`src/entry.ts:124-150`):

```ts
process.argv = normalizeWindowsArgv(process.argv);

if (!ensureCliRespawnReady()) {
  const parsedContainer = parseCliContainerArgs(process.argv);
  // ...
  const parsed = parseCliProfileArgs(parsedContainer.argv);
  // ...
  if (parsed.profile) {
    applyCliProfileEnv({ profile: parsed.profile });
    process.argv = parsed.argv;
  }
  gatewayEntryStartupTrace.mark("argv");
  // ...
}
```

This is the spot where `--profile foo` or `--dev` is consumed before Commander sees the argv. `src/cli/profile.ts:86-114` shows what `applyCliProfileEnv` does: it sets `OPENCLAW_PROFILE=<name>`, points `OPENCLAW_STATE_DIR` at `~/.openclaw-<name>` (or `~/.openclaw` for `default`), and for `--dev` defaults the gateway port to `19001`. Profiles are how a developer keeps a "dev" gateway state distinct from their daily-driver state.

**Version fast-path** (`src/entry.ts:153`): `tryHandleRootVersionFastPath` short-circuits `openclaw -v` / `--version` without importing the CLI program tree. The same idea as the launcher's help fast-path — print and exit.

**Startup trace.** Throughout entry, `gatewayEntryStartupTrace.mark(...)` (`src/entry.ts:39-70`, `src/entry.ts:102`) emits `[gateway] startup trace: entry.<name> 12.3ms total=45.6ms` to stderr — but only when `OPENCLAW_GATEWAY_STARTUP_TRACE` is set and the command line includes `gateway`:

```ts
const enabled =
  isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) &&
  argv.slice(2).includes("gateway");
```

This is your debugging knob when "the gateway takes 8 seconds to start". Stage-3 (`src/cli/run-main.ts:70-101`) and stage-4 (`src/cli/gateway-cli/run.ts:150-178`) emit their own trace marks under the same env variable, so you get a single timeline across the whole boot.

Finally, `src/entry.ts:154` calls `runMainOrRootHelp(process.argv)`, which dynamically imports `./cli/run-main.js` (`src/entry.ts:290-294`) — that is stage 3.

### 4.3 Stage 3 — `src/cli/run-main.ts`

This is the command router. Roughly: container handling, dotenv + proxy bootstrap, gateway-run fast-path check, then either the gateway-run path or `Commander`'s usual dispatch. Two notable details:

**State-dir resolution drives dotenv loading.** `src/cli/run-main.ts:281-286`:

```ts
function shouldLoadCliDotEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (existsSync(path.join(process.cwd(), ".env"))) {
    return true;
  }
  return existsSync(path.join(resolveStateDir(env), ".env"));
}
```

CLI processes will load a `.env` from `cwd` *or* from the state directory. That second case is what makes `~/.openclaw/.env` work for systemd-managed gateway services where `cwd` is the wrong place to look. Chapter 03 explores the full state-dir machinery.

**Gateway-run fast-path.** `isGatewayRunFastPathArgv` (`src/cli/run-main.ts:103-160`) detects `openclaw gateway` invocations and bypasses Commander's full command registration tree — which would otherwise import every plugin descriptor — in favour of going straight to `runGatewayCommand`. This was the difference between a 2-second cold start and a 5-second one on big plugin sets.

If no fast-path applies, Commander's program tree is built via `buildProgram` (`src/cli/program/build-program.ts:9-29`), which registers core CLI command descriptors and sub-CLI descriptors. The Commander tree dispatches to `runGatewayCommand` in `src/cli/gateway-cli/run.ts:472` for the `gateway` command.

### 4.4 Stage 4 — `src/cli/gateway-cli/run.ts`

`runGatewayCommand` (`src/cli/gateway-cli/run.ts:472-575`) is where CLI flags meet config file. The order matters:

1. **Pin state-dir env early** (`src/cli/gateway-cli/run.ts:473`):
   ```ts
   normalizeStateDirEnv(process.env);
   ```
   This pins a possibly-relative `OPENCLAW_STATE_DIR` to an absolute path at startup. **This is the v2026.5.22 fix #52264** ("pin relative `OPENCLAW_STATE_DIR` overrides to an absolute path at startup so later working-directory changes cannot retarget gateway state"). Without it, an operator running `cd /tmp` later in the same process could redirect session storage. See Chapter 03 for the full rationale.

2. **Install QA parent watchdog** (`src/cli/gateway-cli/run.ts:474`) — only meaningful for the QA harness.

3. **Lazy-import `startGatewayServer`** behind a `withProgress` spinner (`src/cli/gateway-cli/run.ts:518-523`):
   ```ts
   const { startGatewayServer } = await startupTrace.measure("cli.server-import", () =>
     withProgress(
       { label: "Loading gateway modules…", indeterminate: true },
       async () => import("../../gateway/server.js"),
     ),
   );
   ```
   The comment above this block is honest: "The heaviest part of gateway startup is loading the server module tree (channels, plugins, HTTP stack, etc.). Show a spinner so the user sees progress instead of a silent 15-20 s pause (especially on Windows/NTFS)."

4. **Read config snapshot** (`src/cli/gateway-cli/run.ts:535-537`) via `readGatewayStartupConfig`, which calls `readConfigFileSnapshotWithPluginMetadata` from `src/config/config.js`. This is the entry to Chapter 03's machinery.

5. **Resolve port, bind mode, auth mode, tailscale mode** in that order. Each takes the CLI flag if present, otherwise falls back to `cfg.gateway.*`, otherwise to defaults. `src/cli/gateway-cli/run.ts:578-587` validates `--bind`; lines 651-666 validate `--auth` and `--tailscale`.

6. **Force-free port** if `--force` was passed (`src/cli/gateway-cli/run.ts:597-644`) — calls `forceFreePortAndWait`, escalating SIGTERM → SIGKILL, then waits for the port to become bindable again. This is operator armour against the "I rebooted and a stale gateway is squatting on 18789" scenario.

7. **Finally**, `runGatewayLoopWithSupervisedLockRecovery` or `runGatewayLoop` (`src/cli/gateway-cli/run.ts:811-840`) acquires the gateway lock and calls `startGatewayServer`.

### 4.5 Stage 5 — `server.ts` → `server.impl.ts`

`src/gateway/server.ts` is a deliberately thin facade. Its only exports are `startGatewayServer` and `resetModelCatalogCacheForTest`, and both lazy-import `./server.impl.js`. The whole file is 35 lines.

This separation is not cosmetic. `server.impl.ts` is enormous (large module graph including channels, plugin registry, HTTP framework Hono, websockets), so importing it costs noticeable startup time. The CLI imports the facade unconditionally; the facade only imports the impl when `startGatewayServer` is actually called. Tests that need to verify gateway types can import `GatewayServer` and `GatewayServerOptions` (re-exported as types at `src/gateway/server.ts:2`) without paying the cost.

`server.impl.ts:531` defines `startGatewayServer`. From there, Chapter 02 takes over: route registration, the WebSocket handler, RPC dispatch, the chat-stream registry, lifecycle handlers, the connection auth pipeline, and the channel manager.

---

### 4.6 Source-checkout vs. installed package

One detail the launcher hides: it behaves differently when run from a source checkout vs. an installed npm package. The function `isSourceCheckoutLauncher` (`openclaw.mjs:44-46`) distinguishes them by looking for `.git` or `src/entry.ts` next to the launcher:

```js
const isSourceCheckoutLauncher = () =>
  existsSync(new URL("./.git", import.meta.url)) ||
  existsSync(new URL("./src/entry.ts", import.meta.url));
```

The two paths diverge in three ways:

- **Compile cache.** Source checkouts disable the compile cache (`openclaw.mjs:183-204`'s `respawnWithoutCompileCacheIfNeeded`) so a stale cache cannot pin you to old TS output during dev. Installed packages always use a versioned, packaged compile cache directory.
- **Help fast-paths.** `shouldDeferRootHelpToRuntimeEntry` (`openclaw.mjs:398-414`) defers root help to the full runtime when the config file mentions plugins — because plugin-contributed commands need to be listed in help, and that requires plugin loading. Production installs without config-driven plugins get the fast path; dev installs typically do not.
- **Missing-dist error message.** `buildMissingEntryErrorMessage` (`openclaw.mjs:311-326`) explains exactly what is wrong when `dist/entry.js` is missing — source checkouts need `pnpm build`, raw GitHub tarballs need to be installed via `npm install -g github:openclaw/openclaw#<ref>` instead.

This is the kind of detail that pays off when somebody asks "why does my dev gateway behave differently from production." Mostly the answer is the compile cache; occasionally it is the help fast-path.

---

## 5. Boot Phases Inside `startGatewayServer`

Once stage 5 starts, the in-process boot has its own pipeline. The same `OPENCLAW_GATEWAY_STARTUP_TRACE` you set in stage 2 keeps emitting marks. Highlights:

<svg viewBox="0 0 720 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Gateway in-process boot pipeline">
<defs>
<marker id="ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="360" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Gateway in-process boot pipeline</text>
<rect x="40" y="40" width="640" height="40" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="360" y="56" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">Config + auth preflight</text>
<text x="360" y="72" text-anchor="middle" font-size="10" fill="#64748b">server-startup-config.ts: validate snapshot, apply runtime overrides, resolve secrets</text>
<line x1="360" y1="80" x2="360" y2="94" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar3)"/>
<rect x="40" y="94" width="640" height="40" fill="#fed7aa" stroke="#ea580c" stroke-width="1" rx="6"/>
<text x="360" y="110" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">Plugin registry warm-up</text>
<text x="360" y="126" text-anchor="middle" font-size="10" fill="#64748b">server-startup-plugins.ts: discover bundled + installed plugins, build dispatch registry</text>
<line x1="360" y1="134" x2="360" y2="148" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar3)"/>
<rect x="40" y="148" width="640" height="40" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
<text x="360" y="164" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">HTTP + WS server bind</text>
<text x="360" y="180" text-anchor="middle" font-size="10" fill="#64748b">server.impl.ts + server/http-listen.ts: bind port, attach upgrade handler</text>
<line x1="360" y1="188" x2="360" y2="202" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar3)"/>
<rect x="40" y="202" width="640" height="40" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="6"/>
<text x="360" y="218" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">Channel manager + connections</text>
<text x="360" y="234" text-anchor="middle" font-size="10" fill="#64748b">channelManager: start configured channel instances, register their gateway RPC methods</text>
<line x1="360" y1="242" x2="360" y2="256" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar3)"/>
<rect x="40" y="256" width="640" height="40" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="360" y="272" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">Post-attach + watchers</text>
<text x="360" y="288" text-anchor="middle" font-size="10" fill="#64748b">server-startup-post-attach.ts: cron, gmail, heartbeat, hooks, health monitor</text>
<line x1="360" y1="296" x2="360" y2="310" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar3)"/>
<rect x="40" y="310" width="640" height="40" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" rx="6"/>
<text x="360" y="326" text-anchor="middle" font-size="12" font-weight="700" fill="#16a34a">Config reloader + ready</text>
<text x="360" y="342" text-anchor="middle" font-size="10" fill="#64748b">config-reload.ts: chokidar watcher on openclaw.json; emit "gateway ready"</text>
</svg>
<span class="figure-caption">Figure R1.3 | The gateway's own boot phases after the CLI hands off — config preflight, plugin warm-up, HTTP/WS bind, channels, watchers, ready.</span>

<details>
<summary>ASCII original</summary>

```
[Config preflight]   server-startup-config.ts
        ▼            validate snapshot, apply runtime overrides, resolve secrets
[Plugin warm-up]     server-startup-plugins.ts
        ▼            discover bundled + installed plugins, build dispatch registry
[HTTP + WS bind]     server.impl.ts + server/http-listen.ts
        ▼            bind port, attach upgrade handler
[Channel manager]    start configured channel plugins, register RPC methods
        ▼
[Post-attach]        server-startup-post-attach.ts
        ▼            cron, gmail, heartbeat, hooks, health monitor
[Config reloader]    config-reload.ts
                     chokidar watcher on openclaw.json; emit "gateway ready"
```

</details>

Two boot-time files are worth knowing by name even before Chapter 02:

- `src/gateway/server-startup-config.ts:335-356` — `prepareGatewayStartupConfig` is the pivot that turns a raw `ConfigFileSnapshot` into a runtime-ready config: it validates the snapshot, applies CLI/runtime overrides (`applyConfigOverrides`), then runs a secret-surface preflight so authentication failures surface early instead of mid-request.
- `src/gateway/config-reload.ts:86-119` — `startGatewayConfigReloader` wires a `chokidar` watcher to `openclaw.json` and routes changes through a "reload plan" that distinguishes hot-reloadable (`reloadHooks`, `restartCron`, `restartChannels`) from `restartGateway` changes. This is the source-of-truth for which config keys can be changed live.

The gateway's in-process boot also enforces an important ordering: **secrets activate after the config snapshot is validated, but before any plugin actually runs**. `ensureGatewayStartupAuth` (called from `prepareGatewayStartupConfig`) materialises every `SecretRef` declared by the gateway-auth surface and stages them as `PreparedRuntimeSecretsSnapshot` (`src/gateway/server-startup-config.ts:360-371`). If a secret is missing or unreadable, the gateway exits with `EX_CONFIG` (78) — the systemd-aware "bad config" code (`src/cli/gateway-cli/run.ts:112` declares the constant with a comment about `RestartPreventExitStatus=78` preventing restart storms on a misconfigured host). Channels and other plugins start later, by which point they can rely on `getActiveRuntimeSecrets()` to surface a fully resolved set.

---

## 6. The Core ↔ Plugin Boundary

You will see the words "core" and "plugin" everywhere in OpenClaw. The boundary is **enforced** rather than convention. Re-reading `AGENTS.md:28-31` slowly:

### 6.1 Why the boundary exists

A single-user gateway with 137 plugins has a real coordination problem: every channel, every model provider, every memory backend, and every tool is a candidate dependency. If core imported them directly, three things would go wrong:

1. **The dist tarball would explode in size**, because the npm package would need every plugin's transitive deps.
2. **Releases would block on plugin churn** — a single misbehaving plugin would block a core release.
3. **Security ownership would blur** — when an OAuth bug shows up in the GitHub Copilot provider, who owns it: core or the plugin?

The boundary makes ownership explicit. `extensions/<plugin>/` is the responsibility of its owner; `src/` knows only the public contract. `AGENTS.md:32-36` makes this concrete:

```
- Owner boundary: owner-specific repair/detection/onboarding/auth/defaults/
  provider behavior lives in owner plugin. Shared/core gets generic seams only.
- Dependency ownership follows runtime ownership: plugin-only deps stay
  plugin-local; root deps only for core imports or intentionally internalized
  bundled plugin runtime.
```

```
- Core stays plugin-agnostic. No bundled ids/defaults/policy in core when
  manifest/registry/capability contracts work.
- Plugins cross into core only via openclaw/plugin-sdk/*, manifest metadata,
  injected runtime helpers, documented barrels (api.ts, runtime-api.ts).
- Plugin prod code: no core src/**, src/plugin-sdk-internal/**, other plugin
  src/**, or relative outside package.
- Core/tests: no deep plugin internals (extensions/*/src/**, onboard.js). Use
  public barrels, SDK facade, generic contracts.
```

### 6.2 The four traversable contact points

There are four traversable contact points between a plugin and core:

1. **Manifest metadata** — a static JSON-ish description of the plugin's capabilities. Core reads this without executing plugin code. The contract for what may live in a manifest is published in `@openclaw/plugin-package-contract`.
2. **`src/plugin-sdk/*`** — the public TypeScript surface plugins are expected to import. It re-exports types and helper functions plus an injected runtime API.
3. **Documented barrels** — `api.ts` and `runtime-api.ts` files inside each plugin act as the only allowed entry points from core.
4. **Capability contracts** — for things like channels, providers, embeddings; core defines the interface, plugins implement it.

When the rule says "no `extensions/*/src/**`," it means core code cannot reach **inside** a plugin's source tree to grab an internal helper. Even bundled (built-in) plugins must look exactly the same to core as third-party plugins do. The escape hatches that exist (a `facade-runtime` registry-aware loader, internal compat APIs) are explicitly noted as time-bounded, with the goal of removing them.

### 6.3 What `@openclaw/plugin-sdk` actually exports

The plugin SDK is **not** a single index file. `packages/plugin-sdk/package.json` declares per-feature export subpaths so a plugin imports only what it needs and the bundler can shake the rest. A non-exhaustive sample of the 50+ exports:

- **Lifecycle**: `./plugin-entry`, `./plugin-runtime`, `./plugin-config-runtime` — the basic `register` / `activate` / `dispose` shape.
- **Capability seams**: `./channel-runtime`, `./channel-streaming`, `./channel-secret-runtime`, `./provider-entry`, `./provider-auth-runtime`, `./provider-http`, `./provider-tools`, `./model-session-runtime` — these are what channel and provider plugins implement.
- **Runtime helpers**: `./time-runtime`, `./dedupe-runtime`, `./concurrency-runtime`, `./async-lock-runtime`, `./heartbeat-runtime`, `./delivery-queue-runtime`, `./secure-random-runtime` — utilities every plugin needs but should not reinvent.
- **Cross-cutting**: `./security-runtime`, `./ssrf-runtime`, `./secret-ref-runtime`, `./secret-input`, `./gateway-method-runtime`, `./infra-runtime`, `./runtime-doctor`, `./runtime-env` — security primitives and ops integrations.
- **External types**: `./zod`, `./config-types`, `./config-contracts`, `./error-runtime` — schema and error vocabulary shared with core.

The pattern is that **every exported subpath is a thin contract**. The plugin imports the contract; core injects the runtime helper at activation. This is what `AGENTS.md:30` means by "injected runtime helpers, documented barrels (`api.ts`, `runtime-api.ts`)."

The size of this surface matters: when the SDK gains a new entry like `./channel-streaming` (added because token-delta channel messages were causing inbound dedupe bugs — see `AGENTS.md:187` "External messaging: no token-delta channel messages. Follow `docs/concepts/streaming.md`"), it is a deliberate, additive change. `AGENTS.md:48` is explicit: "Gateway protocol changes: additive first; incompatible needs versioning/docs/client follow-through."

### 6.4 What goes wrong when the boundary leaks

A leak in the boundary usually presents as one of three symptoms:

1. **A test that imports through `extensions/*/src/**` starts to flake** because the plugin's internal helpers change shape. The fix is almost always to surface the helper through the plugin's `api.ts` barrel or `@openclaw/plugin-sdk/testing`.
2. **A bundled plugin "magically works in dev but not when installed"** because dev resolves the plugin's local source while the installed package resolves the published dist — and the dev-only path imports something that does not exist in dist. `AGENTS.md:35-36` calls this out: "Externalizing a bundled plugin: update package excludes, official catalogs, docs, tests, and prove core runtime paths resolve installed plugin roots before root-dep removal."
3. **A capability silently disables itself in production** because a plugin reaches into core internals that the production build tree-shook away. The build is correct; the import is wrong.

The codebase ships several guards to catch leaks early: `pnpm check:import-cycles`, the plugin-activation boundary test (`src/plugin-activation-boundary.test.ts`), and the protocol contract tests under `src/gateway/protocol/`. Run these locally with `pnpm check:changed` after touching anything near the plugin SDK.

This boundary is the reason later chapters are organised the way they are:

- Chapter 04 (channels), Chapter 08 (LLM providers), and Chapter 10 (plugin system) all stay on the **core** side of the boundary, describing what core expects to see.
- Plugin internals (Telegram's grammY usage, OpenAI's streaming protocol details) are only described as far as their public contract goes.

If, while reading core code, you find a hard-coded reference to a specific plugin id, that is a flag. The codebase's own AGENTS guides treat this as an anti-pattern worth fixing.

---

## 7. Reading the Startup Trace

If a `gateway` start takes longer than expected, the `OPENCLAW_GATEWAY_STARTUP_TRACE` env var is the first tool to reach for. Setting it to `1` (or any truthy value as defined by `isTruthyEnvValue` in `src/infra/env.ts:65-78`) makes each stage emit a line of timing breakdown to stderr.

```bash
OPENCLAW_GATEWAY_STARTUP_TRACE=1 openclaw gateway --port 18789
```

A typical trace prefix:

```
[gateway] startup trace: entry.bootstrap 12.3ms total=12.3ms
[gateway] startup trace: entry.argv 0.4ms total=12.7ms
[gateway] startup trace: cli.main.argv-normalize 1.1ms total=13.8ms
[gateway] startup trace: cli.server-import 1820.4ms total=1840.2ms
[gateway] startup trace: config.snapshot.read.file 4.2ms total=1846.7ms
[gateway] startup trace: config.snapshot.read.parse 11.8ms total=1858.5ms
[gateway] startup trace: config.snapshot.read.includes 3.5ms total=1862.0ms
[gateway] startup trace: config.snapshot.read.env 1.2ms total=1863.2ms
[gateway] startup trace: cli.config-snapshot 21.3ms total=1864.6ms
...
```

Three things to know about the trace format:

- **Per-line cost vs. running total.** `12.3ms total=12.3ms` means "this step took 12.3 ms; total elapsed since process start is also 12.3 ms." A single slow step shows as a big delta in both numbers.
- **Subsystem prefixes.** `entry.*` comes from `src/entry.ts:39-70`, `cli.main.*` from `src/cli/run-main.ts:70-101`, `cli.*` (without `main`) from `src/cli/gateway-cli/run.ts:150-178`, `config.snapshot.*` from `src/config/io.ts`, and `gateway.*` from `src/gateway/server.ts:4-11`. The prefix tells you which file's `createStartupTrace` factory emitted it.
- **Largest single cost is usually `cli.server-import`.** It is the import cost of `server.impl.ts` and its transitive plugin tree. The v2026.5.22 release explicitly worked on this with "Gateway/perf: reuse immutable plugin metadata snapshots across startup..." and "lazy-load startup-idle plugin work." Earlier versions could see 8-15 seconds here on cold cache; v2026.5.22 should be in the 1-3 second range on warm SSD.

If you are diagnosing a slow start, layer the trace with `--verbose` and read for one of these signals:

| Signal | Likely cause |
|--------|--------------|
| `cli.server-import` > 5 s on warm cache | Many large plugins eagerly loaded; check `OPENCLAW_DISABLE_BUNDLED_PLUGINS=1` baseline |
| `config.snapshot.*` > 200 ms total | Huge `$include` tree or filesystem latency (NFS / cloud volumes) |
| `cli.dev-config` present but slow | Dev profile is recreating the dev workspace; `pnpm gateway:watch` triggers this |
| `gateway.server-impl-import` > `cli.server-import` | The facade was bypassed, look for tests that import `server.impl.js` directly |

The trace is intentionally cheap (string concatenation + `performance.now()`); leaving it on in production daemons is fine and is occasionally the only practical way to debug a hosting platform that is slow on cold boot.

---

## 8. Reading the Boot Chain at the Code Level

If you want to trace the boot in your editor instead of reading prose, follow this path. Each step is one or two lines of code and a one-line action. Open the files side by side; you will read the entire boot in ten minutes:

| Step | File:Line | What happens |
|------|-----------|--------------|
| 1 | `package.json` (bin field) | npm `openclaw` symlink points to `openclaw.mjs` |
| 2 | `openclaw.mjs:42` | `ensureSupportedNodeVersion()` — exit if Node < 22.19 |
| 3 | `openclaw.mjs:472` | Help fast-paths (`openclaw -h`, `browser --help`, ...) try precomputed text first |
| 4 | `openclaw.mjs:478-486` | `tryImport("./dist/entry.js")` then `./dist/entry.mjs` |
| 5 | `src/entry.ts:79-86` | `isMainModule` guard — skip if imported as a dep |
| 6 | `src/entry.ts:89` | `resolveEntryInstallRoot(entryFile)` finds where the install lives |
| 7 | `src/entry.ts:94` | `process.title = "openclaw"` so `ps` shows the right name |
| 8 | `src/entry.ts:97` | `normalizeEnv()` — currently `normalizeZaiEnv()` only |
| 9 | `src/entry.ts:124` | `normalizeWindowsArgv(process.argv)` handles cmd.exe quirks |
| 10 | `src/entry.ts:127-150` | `parseCliContainerArgs` → `parseCliProfileArgs` → `applyCliProfileEnv` |
| 11 | `src/entry.ts:153` | `tryHandleRootVersionFastPath` short-circuits `-v` |
| 12 | `src/entry.ts:154` | `runMainOrRootHelp(process.argv)` dynamic-imports `cli/run-main.js` |
| 13 | `src/cli/run-main.ts` (default export `runCli`) | Container fast-path, dotenv check, proxy bootstrap |
| 14 | `src/cli/run-main.ts:103-160` | `isGatewayRunFastPathArgv` detects `openclaw gateway` |
| 15 | `src/cli/gateway-cli/run.ts:472` | `runGatewayCommand` starts |
| 16 | `src/cli/gateway-cli/run.ts:473` | **`normalizeStateDirEnv(process.env)`** (v2026.5.22 fix #52264) |
| 17 | `src/cli/gateway-cli/run.ts:518-523` | Lazy `import("../../gateway/server.js")` behind a spinner |
| 18 | `src/cli/gateway-cli/run.ts:535-537` | `readGatewayStartupConfig` reads + validates `openclaw.json` |
| 19 | `src/cli/gateway-cli/run.ts:541-552` | Resolve port (CLI → env → config → default) |
| 20 | `src/cli/gateway-cli/run.ts:811-840` | `runGatewayLoop` acquires lock + calls `startGatewayServer` |
| 21 | `src/gateway/server.ts:24-29` | Facade lazy-imports `server.impl.js` |
| 22 | `src/gateway/server.impl.ts:531` | The real `startGatewayServer` — Chapter 02 picks up here |

The line numbers will drift as the code changes; the structure will not.

A few things this table deliberately does **not** trace:

- **The signal-handling layer.** Both the launcher (`openclaw.mjs:87-181`) and gateway lifecycle (Chapter 02) install signal handlers. The launcher's job is "forward SIGTERM/SIGINT/SIGHUP/SIGQUIT to the child and exit on a grace timer." The gateway's job is "drain in-flight requests, close WebSocket connections, release the lock, then exit." If a `SIGTERM` ever feels unresponsive in production, both layers have a one-second grace timer plus a SIGKILL escalation (`openclaw.mjs:91-92`); look at the child to see if it is stuck on cleanup.
- **The respawn supervisor.** `src/cli/respawn-policy.ts` lists argv shapes that should *not* respawn (test runners, certain doctor commands). `shouldSkipRespawnForArgv` is the predicate; when it returns `true`, the respawn-plan logic in `src/entry.respawn.ts:34-44` returns null and the process runs in place. This avoids respawning a `node scripts/doctor.mjs` invocation that already targets the right runtime.
- **Bun support.** `AGENTS.md:55` says "Keep Node + Bun paths working." The launcher's `runCli` and `runGatewayCommand` are runtime-agnostic; the daemon adapter at `src/daemon/runtime-binary.ts` provides `isNodeRuntime()` and `isBunRuntime()` for the few places where runtime-specific behaviour matters (e.g. argv normalisation on Windows).

---

## 9. Two Worked Examples Across the Layers

To make the four-layer picture concrete, here are two end-to-end paths a typical event takes. Both are summarised; the trace tour walks them in full detail.

### 9.1 A Telegram user types "summarise yesterday's email"

1. **L1 inbound.** `extensions/telegram/` receives the message from grammY. The plugin normalises it into an OpenClaw inbound message structure (sender id, channel id, thread id, content parts), then calls into the channel-runtime SDK seam.
2. **L2 routing.** The Gateway receives the inbound event through the channel manager's adapter. It looks up the binding (`bindings[]` in config) — which agent owns this Telegram chat + topic combination? It marks the run as "live" in the in-memory chat-run registry.
3. **L3 orchestration.** `src/auto-reply/` deduplicates against recent events (Telegram retransmits on slow networks), checks throttle/silence policies, then routes to the agent's session. The session loads history from `$stateDir/sessions/<agentId>/sessions.json`.
4. **L4 assistant.** The agent harness builds a prompt with history + current turn, picks a model from the configured catalog, dispatches through the provider plugin. If the request needs a tool ("read my Gmail"), the agent invokes `gmail_read` (a skill plugin) and receives results. The reasoning loop continues until a final text reply.
5. **L3 reply dispatch.** The agent's `assistant_text` events flow through the reply dispatcher, which **does not** stream token deltas to Telegram (per `AGENTS.md:187`). Instead, it batches sentences into "send-worthy chunks" and produces a final coherent message.
6. **L1 outbound.** `extensions/telegram/`'s channel-runtime sends the reply through grammY back to the user.

A round trip touches every layer, with the bulk of the runtime cost in L4 (model inference) and the bulk of the architectural complexity in L3 (orchestration, session, dispatch).

### 9.2 An operator edits `openclaw.json` to add a new memory provider

1. **No layer involvement during edit.** The file is just a JSON5 file on disk.
2. **L2 hot reload.** `src/gateway/config-reload.ts`'s `chokidar` watcher fires. `diffConfigPaths` reports `memory.provider` as a changed key. The reload-plan classifier sees this is a memory-config change.
3. **L4 plugin lifecycle.** The plan triggers `reloadPlugins` (Chapter 10 details this). The old memory plugin instance is asked to dispose its sqlite connection. The new memory plugin spec is read; if the package is already installed, it activates immediately; otherwise the operator must install it first via `openclaw plugins install`.
4. **L3 ↔ L4 wiring re-attached.** Agent harnesses keep working — the memory provider is a capability they look up dynamically through the plugin registry, not a baked-in reference.
5. **No connection drop.** Channels (L1) and WebSocket connections (L2) keep running; no inbound message is lost.

This is the kind of operator workflow the architecture was designed to make smooth. Compare to the alternative — restart the whole gateway, drop every WebSocket connection, lose any in-flight tool execution — and the value of the "narrow reload plan" pays off immediately.

---

## 10. How To Read This Wiki

The wiki has 15 reference chapters and a single-shot trace tour. Use them in pairs.

| Layer (Figure R1.1) | Reference chapters | What you get |
|---------------------|---------------------|---------------|
| Cross-cutting | 01 (this), 02, 03 | Architecture, gateway control plane, config system |
| L1 — Channels | 04, 05 | Channel layer, inbound pipeline |
| L3 — Orchestration | 06, 11 | Sessions, delivery and events |
| L4 — AI core | 07, 08, 09, 10, 13 | Agent execution, providers, tools/skills, plugin system, voice/media |
| Cross-layer | 12, 14, 15 | Web UI / Canvas, auth & security, glossary |

The **trace tour** (`tour-00-overview.md` and the 18 numbered `tour-NN-*.md` files) takes one concrete request — a WebChat "hello" — through every layer end-to-end. Each step is structured as "problem → naive solution → why it fails → actual design". First-time readers should run the trace tour before opening any reference chapter, because the trace tour builds the mental model the reference chapters fill in.

A few practical reading aids in the viewer:

- All `file:line` refs are clickable and deep-link to the exact commit (`a374c3a5bf`).
- The architecture diagram (Figure R1.1 above) is clickable in the viewer — each layer jumps to the responsible chapter.
- Glossary terms are underlined and hover-able.
- The keyboard `?` shortcut shows all shortcuts.

The boot chain ends with one process listening on port 18789. Chapter 02 picks up there: what that process actually does for every connection that hits it.

---

## 11. Anti-Patterns to Watch For

While reading the source, a few patterns should raise eyebrows. They are not always wrong — sometimes they are an intentional escape hatch — but they merit a second look because they cross the architecture's grain:

- **Core code that mentions a specific plugin id by name.** "OpenAI" or "Telegram" appearing as a string literal in `src/` is usually wrong. `AGENTS.md:28` says "No bundled ids/defaults/policy in core." There are exceptions for the bundled-plugin facade loader, but those are explicit and time-boxed.
- **Deep imports into `extensions/*/src/**`.** Core or test code reaching into a plugin's internal source tree is a layering violation. The fix is to surface what the test needs through the plugin's `api.ts` or `runtime-api.ts` barrel, or to use the SDK testing helpers in `@openclaw/plugin-sdk/testing`.
- **Caching for what should be a hot fact.** `AGENTS.md:44-45` says it plainly: "Do not fix repeated request-time discovery with scattered caches. Move the canonical fact earlier; reuse prepared runtime objects; delete duplicate lookup branches." If you see a per-request `getOrCreate` map that maintains a cache because the upstream lookup is expensive, the upstream lookup is the bug.
- **`@ts-nocheck` or `as any` in core.** `AGENTS.md:111` forbids both: "Avoid `any`; prefer real types, `unknown`, narrow adapters. No `@ts-nocheck`."
- **Static + dynamic import of the same module.** Causes bundler `[INEFFECTIVE_DYNAMIC_IMPORT]` warnings; `AGENTS.md:119` says use `*.runtime.ts` lazy boundaries instead. The Gateway server facade (`src/gateway/server.ts`) is the canonical example of doing this right.
- **Token-delta channel messages.** `AGENTS.md:187` says no: "External messaging: no token-delta channel messages." Stream rendering belongs to the chat-stream registry and the delivery dispatcher, not to channel I/O.

The codebase actively enforces several of these via custom lint rules (`pnpm check:import-cycles`, the staged checks in `pnpm check:changed`) and CI guards. If you see one in code that landed recently, file an issue — it is almost certainly a regression rather than an intentional pattern.

The next chapter (Chapter 02) opens up `src/gateway/server.impl.ts`: how it builds the HTTP and WebSocket stack, how RPC methods are registered, how connection auth interacts with scope gating, and how the channel manager fits in.

---

## 12. Summary Card

Before moving on, the load-bearing facts to keep in your head:

- **OpenClaw is a single-user, self-hosted AI assistant gateway.** It is not a SaaS. Configuration is local; secrets are local; data lives under `$HOME/.openclaw`.
- **The Gateway is the control plane, the product is the assistant.** L2 routes; L1, L3, L4 do the work.
- **Four layers** flow top-down for inbound and bottom-up for outbound: channels (L1) → gateway control plane (L2) → message orchestration (L3) → AI core (L4).
- **Five boot stages**: `openclaw.mjs` launcher → `src/entry.ts` → `src/cli/run-main.ts` → `src/cli/gateway-cli/run.ts` → `src/gateway/server.ts → server.impl.ts`. `OPENCLAW_GATEWAY_STARTUP_TRACE=1` makes every stage tell you how long it took.
- **The core ↔ plugin boundary is enforced.** Core imports `@openclaw/plugin-sdk/*` only; plugins import `@openclaw/plugin-sdk/*` only. No reaching across.
- **Config is layered.** Defaults → file → env → CLI → runtime. The file is the source of truth; runtime overrides are ephemeral. Chapter 03 has the full picture.

If you remember just one architectural diagram, make it Figure R1.1. The rest of this wiki is structured around its four layers.

A practical reading order for a first pass:

1. Finish this chapter, then read Chapter 03 (Configuration System) — it is referenced by almost every later chapter.
2. Walk the trace tour end-to-end (~1-2 hours). The tour follows a single WebChat round-trip through every layer; finishing it builds the mental model that the reference chapters fill in.
3. Open the reference chapters in the order you actually care about — Chapter 02 (gateway control plane) is the natural follow-up, but for someone bringing up a new channel plugin Chapter 04 (channel layer) is more useful next.
4. Keep `OPENCLAW_GATEWAY_STARTUP_TRACE=1` and `--verbose` handy while you read, and run `openclaw gateway` against a scratch state directory (`OPENCLAW_STATE_DIR=/tmp/openclaw-scratch openclaw gateway`) so you can experiment without touching your real install.

Welcome to the codebase.
