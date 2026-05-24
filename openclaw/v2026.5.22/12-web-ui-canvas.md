# Chapter 12 — Web UI and Canvas

Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 12.1 What the Web UI is — and what it is not

OpenClaw is, at its heart, a gateway. The runtime in `src/` ingests messages from chat channels (Telegram, Signal, iMessage, Slack, Discord, …), runs an agent loop, dispatches tools, and writes replies back through whatever channel the user used. None of that needs a web browser.

So why does the project ship `ui/` — a complete Vite-built single-page application that lives next to the gateway? Because once a user is running a self-hosted assistant, three jobs become awkward in chat:

1. **Operating the gateway.** Listing sessions, viewing health and presence, reading audit logs, browsing agents, editing configuration. Chat is fine for "what is the weather" but not for "show me the JSON schema of the Telegram channel".
2. **Pairing devices and surfacing pending approvals.** When the agent wants to run `rm -rf` or change a `models.providers` secret, the operator needs a clearly identified UI — not a chat bubble.
3. **Rendering rich content the agent produces.** Markdown is fine, but the agent also wants to emit charts, embedded forms, sandboxed iframes, and capability widgets. This is what *Canvas* is for, and Canvas needs a real DOM, not a chat client written by a third party.

The Web UI in `ui/` is therefore the **control surface** of the gateway. It is shipped as a separate Vite project, built into `dist/control-ui/`, and served by the gateway's HTTP layer under `/__openclaw__/control-ui/`. It connects to the gateway via the same WebSocket RPC protocol that mobile clients use (Chapter 02 — RPC Registry, Chapter 03 — Gateway Protocol). The chat tab in this UI is the *operator's* chat client. Messaging users still go through Telegram, Signal, iMessage, etc.

This split — gateway runtime in TypeScript-on-Node, UI in TypeScript-on-Lit — is the first thing to internalise before reading anything in `ui/src/ui/`.

### What the v2026.5.22 release changed

The 2026.5.22 release stamp is in `ui/vite.config.ts:31-39`:

```ts
function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : "dev";
  } catch {
    return "dev";
  }
}
```

This release was a *UI-heavy* one. The diff between v2026.5.21 and v2026.5.22 touched roughly thirty files under `ui/src/ui/` — predominantly tests grew (e.g., `ui/src/ui/views/chat.test.ts` is 1964 lines at this commit), and there were structural changes in:

- the dreaming view (`ui/src/ui/views/dreaming.ts`, 1480 lines) and its controller,
- the exec-approval view and controller (a stronger separation of *requested* vs *resolved* approval events),
- the markdown renderer (`ui/src/ui/markdown.ts`, 625 lines) — citation-control-marker stripping, CJK URL-boundary detection, hooks-based link rewriting,
- the custom-theme test coverage (themes are resolved in the inline `index.html` boot script before Vite hydrates),
- a removal of the `src/ui/thinking-labels.ts` module on the gateway side, with the UI keeping its own `ui/src/ui/thinking-labels.ts`.

We will not enumerate every test. The themes are: stricter envelope discipline, defensive sanitisation, and pulling rendering decisions out of `app.ts` into per-feature controllers.

<svg viewBox="0 0 880 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="UI ↔ gateway WebSocket protocol overview">
<rect x="20" y="20" width="280" height="380" rx="10" fill="#fed7aa" stroke="#ea580c"/>
<text x="160" y="50" text-anchor="middle" font-size="16" font-weight="700" fill="#7c2d12">Browser (ui/)</text>
<rect x="40" y="70" width="240" height="36" rx="6" fill="#ffffff" stroke="#ea580c"/>
<text x="160" y="93" text-anchor="middle" font-size="13" fill="currentColor">OpenClawApp (LitElement)</text>
<rect x="40" y="120" width="240" height="36" rx="6" fill="#ffffff" stroke="#ea580c"/>
<text x="160" y="143" text-anchor="middle" font-size="13" fill="currentColor">controllers/* (state)</text>
<rect x="40" y="170" width="240" height="36" rx="6" fill="#ffffff" stroke="#ea580c"/>
<text x="160" y="193" text-anchor="middle" font-size="13" fill="currentColor">views/* (lit-html templates)</text>
<rect x="40" y="220" width="240" height="36" rx="6" fill="#ffffff" stroke="#ea580c"/>
<text x="160" y="243" text-anchor="middle" font-size="13" fill="currentColor">GatewayBrowserClient</text>
<rect x="40" y="270" width="240" height="36" rx="6" fill="#ffffff" stroke="#ea580c"/>
<text x="160" y="293" text-anchor="middle" font-size="13" fill="currentColor">WebSocket (ws/wss)</text>
<text x="160" y="330" text-anchor="middle" font-size="11" fill="#64748b">build id, device identity,</text>
<text x="160" y="346" text-anchor="middle" font-size="11" fill="#64748b">protocol version, settings</text>
<text x="160" y="362" text-anchor="middle" font-size="11" fill="#64748b">live in localStorage</text>
<rect x="580" y="20" width="280" height="380" rx="10" fill="#99f6e4" stroke="#0d9488"/>
<text x="720" y="50" text-anchor="middle" font-size="16" font-weight="700" fill="#134e4a">Gateway (src/)</text>
<rect x="600" y="70" width="240" height="36" rx="6" fill="#ffffff" stroke="#0d9488"/>
<text x="720" y="93" text-anchor="middle" font-size="13" fill="currentColor">control-ui.ts (HTTP host)</text>
<rect x="600" y="120" width="240" height="36" rx="6" fill="#ffffff" stroke="#0d9488"/>
<text x="720" y="143" text-anchor="middle" font-size="13" fill="currentColor">control-ui-routing.ts</text>
<rect x="600" y="170" width="240" height="36" rx="6" fill="#ffffff" stroke="#0d9488"/>
<text x="720" y="193" text-anchor="middle" font-size="13" fill="currentColor">WebSocket upgrade</text>
<rect x="600" y="220" width="240" height="36" rx="6" fill="#ffffff" stroke="#0d9488"/>
<text x="720" y="243" text-anchor="middle" font-size="13" fill="currentColor">RPC registry (Ch 02)</text>
<rect x="600" y="270" width="240" height="36" rx="6" fill="#ffffff" stroke="#0d9488"/>
<text x="720" y="293" text-anchor="middle" font-size="13" fill="currentColor">Event bus / agents loop</text>
<text x="720" y="330" text-anchor="middle" font-size="11" fill="#64748b">control-ui-assets bundles</text>
<text x="720" y="346" text-anchor="middle" font-size="11" fill="#64748b">dist/control-ui/ for serving;</text>
<text x="720" y="362" text-anchor="middle" font-size="11" fill="#64748b">CSP enforced per response</text>
<line x1="300" y1="288" x2="600" y2="288" stroke="#7c3aed" stroke-width="2"/>
<text x="450" y="280" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">req frames {type:"req", id, method, params}</text>
<text x="450" y="304" text-anchor="middle" font-size="12" fill="#7c3aed">res frames {type:"res", id, ok, payload|error}</text>
<text x="450" y="322" text-anchor="middle" font-size="12" fill="#7c3aed">event frames {type:"event", event, payload, seq}</text>
</svg>
<span class="figure-caption">Figure R12.1 | The Web UI is one of many gateway clients; it speaks the same WebSocket RPC protocol as mobile and CLI peers.</span>
<details><summary>ASCII original</summary>

```
+------------------------+              +---------------------------+
| Browser (ui/)          |              | Gateway (src/)            |
|------------------------|   WS req/    |---------------------------|
| OpenClawApp Lit element|<- res/event->| control-ui.ts             |
| controllers/*          |              | control-ui-routing.ts     |
| views/*                |              | WebSocket upgrade         |
| GatewayBrowserClient   |              | RPC registry              |
| WebSocket (ws/wss)     |              | Event bus / agents loop   |
+------------------------+              +---------------------------+
```
</details>

## 12.2 Build and layout

The UI is its own pnpm workspace with its own `package.json`, dependencies, and Vite build pipeline. Reading the build configuration first saves a lot of time later when something refuses to behave like a normal SPA.

```ts
// ui/package.json (commit a374c3a5bf, lines 1-20)
{
  "name": "openclaw-control-ui",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "preview": "vite preview",
    "test": "vitest run --config vitest.config.ts"
  },
  "dependencies": {
    "@create-markdown/preview": "2.0.3",
    "@noble/ed25519": "3.1.0",
    "dompurify": "3.4.5",
    "highlight.js": "11.11.1",
    "json5": "2.2.3",
    "lit": "3.3.3",
    "markdown-it": "14.1.1",
    "markdown-it-task-lists": "2.1.1",
    "marked": "18.0.4"
  }
}
```

The framework choice is **Lit 3** — web components plus `lit-html` templates. There is no React, no Svelte, no signals library; the *components* are LitElement subclasses, and the *templates* are tagged template literals consumed by `lit-html`. Rendering is incremental, reactive on `@state`, and produces real DOM, which matters when you embed sandboxed iframes for Canvas (§12.7).

The cryptography library `@noble/ed25519` is loaded because the UI signs device-auth payloads when pairing to a gateway — see Chapter 03 for the protocol; the UI side lives in `ui/src/ui/device-identity.ts` and the client uses it through `loadOrCreateDeviceIdentity`.

The Vite config does five non-trivial things (`ui/vite.config.ts:107-128`):

```ts
export default defineConfig(() => {
  const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  const controlUiBuildId = resolveControlUiBuildId();
  return {
    base,
    define: {
      OPENCLAW_CONTROL_UI_BUILD_ID: JSON.stringify(controlUiBuildId),
    },
    publicDir: path.resolve(here, "public"),
    optimizeDeps: {
      include: ["lit/directives/repeat.js"],
    },
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      chunkSizeWarningLimit: 1024,
    },
    /* … */
  };
});
```

1. **`base: "./"` by default**, but configurable via `OPENCLAW_CONTROL_UI_BASE_PATH`. The UI must be servable both at the gateway's root *and* at a scoped path like `/__openclaw__/cap/<plugin>/control-ui/`.
2. **`outDir` resolves to `dist/control-ui/` in the monorepo root**, not under `ui/`. This is on purpose — the gateway's `src/infra/control-ui-assets.ts` knows where to find the artifacts at runtime without crossing a workspace boundary.
3. **`OPENCLAW_CONTROL_UI_BUILD_ID` is injected at build time** (`ui/vite.config.ts:54-64`). It combines the root `package.json` version with the short git SHA. The service worker (see `ui/public/sw.js`, post-processed in `controlUiServiceWorkerBuildIdPlugin`) uses the build id as its cache namespace so old clients evict cleanly after deploys.
4. **A dev-only middleware stub** (`configureServer`, lines 122-135) returns a fake `/__openclaw/control-ui-config.json` so the SPA boots in `vite dev` without a real gateway behind it.
5. **`emptyOutDir: true` with sourcemaps on** — small build, no minification race, and you can step through the production UI in DevTools.

### The directory layout

```
ui/
├─ AGENTS.md
├─ CLAUDE.md
├─ index.html
├─ package.json
├─ vite.config.ts
├─ vitest.config.ts
└─ public/
   ├─ favicon.svg
   ├─ manifest.webmanifest
   └─ sw.js
└─ src/
   ├─ i18n/        # 20+ locale bundles + glossaries
   ├─ test-helpers/
   └─ ui/
      ├─ app.ts                  # top-level LitElement
      ├─ app-*.ts                # app modules: chat, events, gateway, render, settings, …
      ├─ markdown.ts             # in-UI markdown renderer
      ├─ canvas-url.ts           # Canvas URL sanitiser
      ├─ controllers/*.ts        # state + RPC plumbing per feature
      ├─ views/*.ts              # lit-html templates per feature
      ├─ chat/*.ts               # chat-tab subcomponents
      ├─ e2e/*.e2e.test.ts       # Playwright-driven flows
      └─ __screenshots__/        # browser snapshot fixtures
```

The `controllers/` vs `views/` split is enforced by convention but visible in every file (§12.3).

### Vitest configuration: three projects

`ui/vitest.config.ts` splits tests into three projects (`ui/vitest.config.ts:13-58`):

```ts
projects: [
  defineProject({ test: { name: "unit",        environment: "jsdom",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.browser.test.ts", "src/**/*.e2e.test.ts", "src/**/*.node.test.ts"] }}),
  defineProject({ test: { name: "unit-node",   environment: "jsdom",
    include: ["src/**/*.node.test.ts", ...nodeDrivenBrowserLayoutTests] }}),
  defineProject({ test: { name: "browser",
    include: ["src/**/*.browser.test.ts"],
    browser: { enabled: true, provider: playwright(),
      instances: [{ browser: "chromium", name: "chromium" }],
      headless: true, ui: false } }}),
]
```

- **unit** — pure jsdom, the bulk of the suite.
- **unit-node** — also jsdom, but for tests that need slightly different setup (e.g., they touch Node-flavoured helpers or sized window mocks). The list `nodeDrivenBrowserLayoutTests` pins `ui/src/ui/chat/chat-responsive.browser.test.ts` and `ui/src/ui/views/sessions.browser.test.ts` into this lane for stability.
- **browser** — real Chromium via Playwright. This is where snapshot tests under `ui/src/ui/__screenshots__/` are validated, and where the `*.browser.test.ts` files run.

`e2e/*.e2e.test.ts` is **not** in any of these projects' `include` patterns directly; instead, the e2e suite is opt-in and runs Playwright as a regular Node-driven harness with a mock gateway. We will read those in §12.10.

## 12.3 The WebSocket protocol from the UI's side

The UI's gateway client lives in `ui/src/ui/gateway.ts`. The first useful types in that file describe what comes off the wire (`ui/src/ui/gateway.ts:27-49`):

```ts
export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: { presence: number; health: number };
};

export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  };
};
```

There are exactly two envelope shapes the UI cares about: **response frames** answering an outgoing request, and **event frames** pushed unsolicited by the gateway. The naive design — pretend a WebSocket is a duplex JSON channel and let the application figure it out — would mix request answers and pushed events on the same code path and break sequencing the moment events arrive between request and response. The actual design separates them by `type` so the client can route each independently:

- A `req` carries `{ type:"req", id, method, params }`, the gateway answers exactly once with a `res` carrying the same `id`.
- An `event` has no `id`; it carries a name (`event`), a payload, and an optional monotonic `seq` per state domain (presence, health). The optional `stateVersion` field lets the UI gap-detect — if the latest known `presence` is N and the next event arrives at N+2, refetch.

The UI request error type (`ui/src/ui/gateway.ts:57-76`) wraps server-side error details and adds two crucial flags — `retryable` and `retryAfterMs` — which are surfaced by `GatewayRequestError`. The UI doesn't need to know each error code's semantics; it learns from these flags whether to back off and retry, or to give up.

Protocol version handshake is enforced (`ui/src/ui/gateway.ts:80-95`):

```ts
function enrichProtocolMismatchDetails(message: string | undefined, details: unknown): unknown {
  if (readConnectErrorDetailCode(details) === ConnectErrorDetailCodes.PROTOCOL_MISMATCH) {
    return details;
  }
  if (!message?.toLowerCase().includes("protocol mismatch")) {
    return details;
  }
  return {
    code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
    clientMinProtocol: MIN_CLIENT_PROTOCOL_VERSION,
    clientMaxProtocol: PROTOCOL_VERSION,
    ...(details && typeof details === "object" && !Array.isArray(details) ? details : {}),
  };
}
```

This is defence in depth: if the gateway returned only a free-form "protocol mismatch" message, the UI synthesises proper detail fields so the connect-error UI can show the operator which versions don't agree. The constants are imported from `src/gateway/protocol/version.ts` — the same module both sides build against.

Reconnection policy lives a few lines further down (`ui/src/ui/gateway.ts:120-145`). It draws an important distinction: an `AUTH_TOKEN_MISMATCH` error is *retryable once* with a cached device token (because the cause is often a brief gateway restart that re-issued tokens), whereas `AUTH_PASSWORD_INVALID` is not — the operator must intervene. This kind of nuance is exactly why a UI client deserves more than `if (error) setTimeout(reconnect, 1000)`.

### The agents-of-this-protocol pattern

A particular structure recurs across `ui/src/ui/app-gateway.ts`: the gateway client publishes a typed *event* stream and the UI installs *handlers* per concern. `ui/src/ui/app-gateway.ts:38-58` reads like a manifest:

```ts
import {
  handleAgentEvent,
  handleSessionOperationEvent,
  resetToolStream,
  type AgentEventPayload,
  type SessionOperationEventPayload,
} from "./app-tool-stream.ts";
import { shouldReloadHistoryForFinalEvent } from "./chat-event-reload.ts";
import { reconcileChatRunLifecycle } from "./chat/run-lifecycle.ts";
import { parseChatSideResult, type ChatSideResult } from "./chat/side-result.ts";
import { formatConnectError } from "./connect-error.ts";
import { recordControlUiRpcTiming } from "./control-ui-performance.ts";
import { loadAgents, type AgentsState } from "./controllers/agents.ts";
```

Each event class — agent stream, session ops, chat lifecycle, side-result, exec-approval — gets its own module with its own parsers and reducers. The top-level `app.ts` does not parse event payloads itself; it routes them.

## 12.4 The controller / view split

In a naive single-file Lit app, render logic and data fetching live together in the component. That works until you have twenty tabs, each with its own RPC calls, error handling, pagination, and local state. The OpenClaw UI therefore enforces a hard split:

- **`ui/src/ui/controllers/<feature>.ts`** owns *state* and *gateway calls* for that feature. It exposes a typed state object and pure-ish functions (`loadSessions`, `applySessionsChangedEvent`, `createSession`, …) that mutate it.
- **`ui/src/ui/views/<feature>.ts`** owns *DOM*. It is a `lit-html` template module that receives a typed `props` object and emits HTML.
- **`ui/src/ui/app.ts`** glues them: it owns reactive state via `@state` decorators, calls controllers on events, and passes props into views.

You can see the seam clearly. The sessions controller declares the shape (`ui/src/ui/controllers/sessions.ts:18-39`):

```ts
export type SessionsState = SessionsChatRunState & {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
  sessionsShowArchived: boolean;
  sessionsExpandedCheckpointKey: string | null;
  sessionsCheckpointItemsByKey: Record<string, SessionCompactionCheckpoint[]>;
  sessionsCheckpointLoadingKey: string | null;
  sessionsCheckpointBusyKey: string | null;
  sessionsCheckpointErrorByKey: Record<string, string>;
};
```

And the sessions view declares only its props and callbacks (`ui/src/ui/views/sessions.ts:11-58`):

```ts
export type SessionsProps = {
  loading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  showArchived: boolean;
  filtersCollapsed: boolean;
  basePath: string;
  searchQuery: string;
  agentIdentityById: Record<string, AgentIdentityResult>;
  sortColumn: "key" | "kind" | "updated" | "tokens";
  sortDir: "asc" | "desc";
  page: number;
  pageSize: number;
  selectedKeys: Set<string>;
  expandedCheckpointKey: string | null;
  /* … callbacks … */
};
```

The view does not import the gateway client. It does not import the sessions controller. It receives props and emits events back via callbacks. This means:

- The view is trivially testable with hand-built props. See `ui/src/ui/views/sessions.test.ts` — it just constructs a `SessionsProps`, calls `renderSessions(props)`, and inspects DOM.
- The controller is testable without a DOM. See `ui/src/ui/controllers/sessions.test.ts`.
- The integration is reduced to `app.ts` calling `loadSessions(this)` and then `renderSessions({ ...propsFromState })`.

The same split exists for chat, channels, dreaming, exec-approval, usage, agents, models, debug, logs, devices, nodes, cron, skills, instances, config, presence — see the listing under `ui/src/ui/controllers/` and `ui/src/ui/views/`.

### App modules sit alongside

There is a *third* tier the file names hint at: `app-*.ts` files in `ui/src/ui/` (e.g., `app-chat.ts`, `app-channels.ts`, `app-events.ts`, `app-tool-stream.ts`, `app-render.ts`, `app-settings.ts`, `app-lifecycle.ts`). These are "controllers that also touch the app's own private surface" — they call `state.requestUpdate()`, queue messages on the chat draft, or wire up the native-bridge handshake. They are split out of `app.ts` purely so that `app.ts` itself can stay close to a dispatcher and `app-chat.ts` etc. can be unit-tested independently.

<svg viewBox="0 0 900 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Controller / view architecture in the UI">
<rect x="20" y="20" width="860" height="60" rx="8" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="450" y="55" text-anchor="middle" font-size="16" font-weight="700" fill="#3b0764">ui/src/ui/app.ts — OpenClawApp (LitElement, top-level state, requestUpdate)</text>
<rect x="20" y="100" width="270" height="120" rx="8" fill="#fed7aa" stroke="#ea580c"/>
<text x="155" y="125" text-anchor="middle" font-size="14" font-weight="700" fill="#7c2d12">app-*.ts modules</text>
<text x="155" y="148" text-anchor="middle" font-size="11" fill="currentColor">app-chat.ts</text>
<text x="155" y="166" text-anchor="middle" font-size="11" fill="currentColor">app-channels.ts</text>
<text x="155" y="184" text-anchor="middle" font-size="11" fill="currentColor">app-events.ts</text>
<text x="155" y="202" text-anchor="middle" font-size="11" fill="currentColor">app-tool-stream.ts</text>
<rect x="315" y="100" width="270" height="120" rx="8" fill="#99f6e4" stroke="#0d9488"/>
<text x="450" y="125" text-anchor="middle" font-size="14" font-weight="700" fill="#134e4a">controllers/*.ts</text>
<text x="450" y="148" text-anchor="middle" font-size="11" fill="currentColor">sessions, chat, channels,</text>
<text x="450" y="166" text-anchor="middle" font-size="11" fill="currentColor">dreaming, exec-approval,</text>
<text x="450" y="184" text-anchor="middle" font-size="11" fill="currentColor">usage, agents, models,</text>
<text x="450" y="202" text-anchor="middle" font-size="11" fill="currentColor">cron, skills, debug, logs</text>
<rect x="610" y="100" width="270" height="120" rx="8" fill="#fee2e2" stroke="#dc2626"/>
<text x="745" y="125" text-anchor="middle" font-size="14" font-weight="700" fill="#7f1d1d">views/*.ts</text>
<text x="745" y="148" text-anchor="middle" font-size="11" fill="currentColor">chat, sessions, channels,</text>
<text x="745" y="166" text-anchor="middle" font-size="11" fill="currentColor">dreaming, exec-approval,</text>
<text x="745" y="184" text-anchor="middle" font-size="11" fill="currentColor">usage-render-*,</text>
<text x="745" y="202" text-anchor="middle" font-size="11" fill="currentColor">overview, agents, ...</text>
<line x1="155" y1="220" x2="155" y2="260" stroke="#64748b" stroke-width="2"/>
<line x1="450" y1="220" x2="450" y2="260" stroke="#64748b" stroke-width="2"/>
<line x1="745" y1="220" x2="745" y2="260" stroke="#64748b" stroke-width="2"/>
<rect x="20" y="260" width="860" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="450" y="285" text-anchor="middle" font-size="14" font-weight="700" fill="#78350f">gateway.ts — GatewayBrowserClient (RPC + event subscriptions)</text>
<text x="450" y="305" text-anchor="middle" font-size="11" fill="currentColor">request(method, params), addEventListener(handler), reconnect policy</text>
<rect x="20" y="340" width="860" height="60" rx="8" fill="#bae6fd" stroke="#0ea5e9"/>
<text x="450" y="365" text-anchor="middle" font-size="14" font-weight="700" fill="#075985">WebSocket transport — req/res/event frames over ws|wss</text>
<text x="450" y="385" text-anchor="middle" font-size="11" fill="currentColor">protocol version handshake, device-auth, reconnect with retry budget</text>
<text x="450" y="420" text-anchor="middle" font-size="11" fill="#64748b">View receives props only. Controller is the only layer that imports the gateway client.</text>
</svg>
<span class="figure-caption">Figure R12.2 | The UI's controller/view split keeps DOM and RPC in separate files and makes each layer independently testable.</span>
<details><summary>ASCII original</summary>

```
[ui/src/ui/app.ts — top-level LitElement, requestUpdate]
   |               |                |
   v               v                v
[app-*.ts]    [controllers/*]   [views/*]
   |               |                |
   v               v                |
[gateway.ts: GatewayBrowserClient]<-+ (views receive props only)
   |
   v
[WebSocket: req / res / event frames]
```
</details>

## 12.5 The chat view

The chat view is by far the largest single piece of the UI. The template module is `ui/src/ui/views/chat.ts`; the tests are `ui/src/ui/views/chat.test.ts` (1964 lines at this commit). The view assembles many smaller renderers from `ui/src/ui/chat/`:

```ts
// ui/src/ui/views/chat.ts:1-32
import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../i18n/index.ts";
import type { CompactionStatus, FallbackStatus } from "../app-tool-stream.ts";
import {
  getChatAttachmentPreviewUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "../chat/attachment-payload-store.ts";
import {
  CHAT_ATTACHMENT_ACCEPT,
  isSupportedChatAttachmentFile,
} from "../chat/attachment-support.ts";
import { buildChatItems } from "../chat/build-chat-items.ts";
import { renderChatQueue } from "../chat/chat-queue.ts";
import { buildRawSidebarContent } from "../chat/chat-sidebar-raw.ts";
import { renderWelcomeState, resolveAssistantDisplayAvatar } from "../chat/chat-welcome.ts";
import { renderContextNotice } from "../chat/context-notice.ts";
import { DeletedMessages } from "../chat/deleted-messages.ts";
import { exportChatMarkdown } from "../chat/export.ts";
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
} from "../chat/grouped-render.ts";
```

Read that import list as an inventory of the chat surface:

- **`attachment-*`** — drag-and-drop attachments, previews held outside the lit render path, accept lists, and a payload store so large blobs don't re-render on every keystroke.
- **`build-chat-items`** — turns the raw session message list into a renderable item list (groups consecutive assistant messages, inserts deletion markers, etc.).
- **`chat-queue`** — the *send queue*, distinct from history: messages the user typed but the gateway hasn't acknowledged yet.
- **`chat-welcome`** — the empty-state for a fresh session.
- **`context-notice`** — banners surfacing model context-window pressure or compaction.
- **`deleted-messages`** — soft-deleted messages that the operator may restore.
- **`grouped-render`** — the actual `renderMessageGroup` / `renderStreamingGroup` / `renderReadingIndicatorGroup` functions.
- **`pinned-messages`** + **`pinned-summary`** — pinned content shown above the conversation.
- **`run-controls`** + **`run-lifecycle`** + **`status-indicators`** — the run state machine: idle / streaming / interrupted / done, plus pause / abort / resume buttons.
- **`slash-commands`** — `/clear`, `/model`, `/agent`, …; this module declares categories, completions, and hidden command counts so the dropdown can show a "+N hidden" hint.
- **`tool-expansion-state`** — which tool cards (e.g., `bash`, `web_fetch`) are expanded so the state survives re-renders.
- **`side-result-render`** — additional payloads accompanying a run (e.g., a generated image, a Canvas update).
- **`realtime-talk-conversation`** + **`realtime-talk`** — the live voice transcript when Talk mode is active (§12.8 and Chapter 13).

The corresponding controller (`ui/src/ui/controllers/chat.ts`) handles the *data* side. It defines `loadChatHistory`, `handleChatEvent`, and several normalisations for edge cases the gateway emits. Two are worth highlighting (`ui/src/ui/controllers/chat.ts:21-25`):

```ts
const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const SYNTHETIC_TRANSCRIPT_REPAIR_RESULT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
```

`NO_REPLY` is OpenClaw's convention for "the agent decided not to reply"; the UI silently swallows it so the operator doesn't see an empty assistant bubble. The synthetic-tool-result string is what the gateway writes when a tool call's result was lost (e.g., gateway crashed mid-run); the UI knows to render this differently — it's a transcript repair, not a real tool failure.

### Why the chat tests are huge

`ui/src/ui/views/chat.test.ts` weighs in at 1964 lines (file count via `wc -l` at the commit) and `ui/src/ui/controllers/chat.test.ts` is also large because the chat view sits at the intersection of *every* asynchronous behaviour in the UI:

- Streaming tokens arrive as deltas; the renderer must coalesce them without flicker.
- Tool calls may finish out of order with their replies; `grouped-render.ts` must keep the order stable.
- Compaction events shrink history mid-run.
- Attachments may resolve their preview URLs after the message renders.
- Realtime-talk overlays its own conversation onto the chat stream.
- Side results may push a Canvas update for an already-rendered message.

The growth in tests during 2026.5.22 is, in spirit, a hardening sweep. Reading any single test in isolation is fine — see the import block:

```ts
// ui/src/ui/views/chat.test.ts:1-24
/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import {
  createModelCatalog,
  createSessionsListResult,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "../chat-model.test-helpers.ts";
import {
  getChatAttachmentDataUrl,
  resetChatAttachmentPayloadStoreForTest,
} from "../chat/attachment-payload-store.ts";
import { renderChatQueue } from "../chat/chat-queue.ts";
import { buildRawSidebarContent } from "../chat/chat-sidebar-raw.ts";
import { renderWelcomeState } from "../chat/chat-welcome.ts";
import { renderChatSessionSelect } from "../chat/session-controls.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { GatewaySessionRow, ModelCatalogEntry, SessionsListResult } from "../types.ts";
import type { ChatAttachment, ChatQueueItem } from "../ui-types.ts";
import { renderChat, resetChatViewState } from "./chat.ts";
```

It is the same pattern as production code — pull in just what the test exercises and feed `renderChat(props)` to lit-html's `render` function under jsdom.

## 12.6 Sessions: list, switch, create

The sessions tab is a good worked example of the controller/view split because both halves are small enough to read.

The view (`ui/src/ui/views/sessions.ts:1-9`) imports nothing gateway-shaped:

```ts
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp, parseSessionKeyParts } from "../format.ts";
import { icons } from "../icons.ts";
import { pathForTab } from "../navigation.ts";
import { formatSessionTokens } from "../presenter.ts";
import { isSessionRunActive } from "../session-run-state.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../string-coerce.ts";
import {
  formatInheritedThinkingLabel,
  formatThinkingOverrideLabel,
  normalizeThinkingOptionValue,
} from "../thinking-labels.ts";
```

The controller (`ui/src/ui/controllers/sessions.ts`) defines load and event-reconcile primitives. The key idea is that the sessions list is *cached* and *event-driven*: a `sessions.changed` event mutates the list in place without a full re-fetch (`applySessionsChangedEvent`). The view never knows.

Session creation is a one-shot RPC (`ui/src/ui/controllers/sessions.ts:51-63`):

```ts
type CreateSessionParams = {
  agentId?: string;
  label?: string;
  model?: string;
  parentSessionKey?: string;
  emitCommandHooks?: boolean;
};

type CreateSessionResult = {
  key?: string;
};
```

After it resolves with a key, the *router* (Chapter 02) updates `sessionKey` in the URL via `syncUrlWithSessionKey` (called from `app-gateway.ts:17-22`). The chat view then renders for the new key.

## 12.7 Markdown rendering in the UI

The markdown renderer in `ui/src/ui/markdown.ts` is one of the most security-sensitive files in the entire UI, because it converts text the agent produced into DOM the operator sees. The naive approach — feed `markdown-it` output to `innerHTML` — gets you a stored-XSS hole the first time an agent emits `<img src=x onerror=fetch(...)>`.

The actual design is a five-stage pipeline:

1. **Citation-control-marker stripping** before parsing. The gateway uses zero-width control characters around citation markers; the UI strips them so they don't appear in user-visible text. See the import (`ui/src/ui/markdown.ts:18`):

   ```ts
   import { stripUnsupportedCitationControlMarkers } from "../../../src/shared/text/citation-control-markers.js";
   ```

2. **markdown-it parsing**, with `markdown-it-task-lists` enabled so `[ ]` / `[x]` render as checkboxes.

3. **`highlight.js`** with an explicit subset of languages (`ui/src/ui/markdown.ts:170-185`):

   ```ts
   for (const [language, definition, aliases] of [
     ["bash", bash, ["sh", "shell"]],
     ["cpp", cpp, ["c++", "cxx"]],
     ["css", css, []],
     ["diff", diff, ["patch"]],
     ["go", go, ["golang"]],
     ["java", java, []],
     ["javascript", javascript, ["js", "jsx"]],
     ["json", json, []],
     ["markdown", markdown, ["md"]],
     ["python", python, ["py"]],
     ["rust", rust, ["rs"]],
     ["typescript", typescript, ["ts", "tsx"]],
     ["xml", xml, ["html", "svg"]],
     ["yaml", yaml, ["yml"]],
   ] as const) {
     hljs.registerLanguage(language, definition);
     if (aliases.length > 0) {
       hljs.registerAliases([...aliases], { languageName: language });
     }
   }
   ```

   Each language is imported by path (`highlight.js/lib/languages/<lang>`) so the bundle stays small.

4. **DOMPurify** with an explicit allowlist (`ui/src/ui/markdown.ts:25-77`). Tag list includes `details`, `summary`, `table`, `input` (for task lists), `img`, and `button` (for code-block actions). Attribute list contains `class`, `href`, `target`, `rel`, `data-code`, `aria-label`, and a few others. Anything else is dropped.

5. **`afterSanitizeAttributes` hook** that re-validates anchor `href`s (`ui/src/ui/markdown.ts:121-156`):

   ```ts
   DOMPurify.addHook("afterSanitizeAttributes", (node) => {
     if (!(node instanceof HTMLAnchorElement)) {
       return;
     }
     const href = node.getAttribute("href");
     if (!href) {
       return;
     }

     // Block dangerous URL schemes (javascript:, data:, vbscript:, etc.)
     try {
       const url = new URL(href, window.location.href);
       if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") {
         node.removeAttribute("href");
         return;
       }
     } catch {
       // Relative URLs are fine; malformed absolute URLs with dangerous schemes
       // will fail to parse and keep their href — but DOMPurify already strips
       // javascript: by default. This is defense-in-depth.
     }

     node.setAttribute("rel", "noreferrer noopener");
     node.setAttribute("target", "_blank");
     if (normalizeLowercaseStringOrEmpty(href).includes("tail")) {
       node.classList.add(TAIL_LINK_BLUR_CLASS);
     }
   });
   ```

There is also a **content cache** (`MARKDOWN_CACHE_LIMIT = 200`, `MARKDOWN_CACHE_MAX_CHARS = 50_000`) keyed on the input text so re-renders of the same text don't repeatedly trip the sanitiser. The eviction is LRU, hand-rolled with `Map` insertion ordering:

```ts
// ui/src/ui/markdown.ts:104-119
function setCachedMarkdown(key: string, value: string) {
  markdownCache.set(key, value);
  if (markdownCache.size <= MARKDOWN_CACHE_LIMIT) {
    return;
  }
  const oldest = markdownCache.keys().next().value;
  if (oldest) {
    markdownCache.delete(oldest);
  }
}
```

CJK boundary detection is a small but interesting touch (`ui/src/ui/markdown.ts:93-99`). RFC 3986 does not permit CJK characters in raw URLs, but markdown-it's autolinker is greedy and will swallow trailing CJK characters into a link. The regex `CJK_RE` is used to find the natural URL boundary so links don't run into Chinese/Japanese/Korean punctuation that follows.

The exported entry point is `toSanitizedMarkdownHtml(raw)`; it returns a string of HTML safe to pass to `unsafeHTML` from `lit/directives/unsafe-html.js`. Every callsite in the UI that renders agent text goes through this — see, for instance, `ui/src/ui/views/dreaming.ts:8` re-importing it for diary rendering.

## 12.8 Canvas — the rich rendered surface

Canvas is the OpenClaw answer to the question "what if the agent wants to show me something that is not text?". The gateway-side render module is `src/chat/canvas-render.ts` (245 lines), and the UI-side URL sanitiser is `ui/src/ui/canvas-url.ts`.

### What Canvas is

The agent emits a JSON record (or a `[embed …]` shortcode in its assistant text) that the gateway parses and surfaces as a *preview* on the assistant message. The preview carries a URL to an HTML document hosted under the gateway's `/__openclaw__/canvas/` path, plus optional title, preferred height, class name, and inline style. The UI renders this preview as a sandboxed iframe within the assistant bubble.

The surface type is presently a single literal (`src/chat/canvas-render.ts:3`):

```ts
type CanvasSurface = "assistant_message";
```

There is exactly one Canvas surface today — the assistant's own message — but the enum is reserved for expansion (sidebar, modal, full-pane). The discriminator is in the data; the renderer is in the UI.

### The two emission paths

A canvas preview can arrive in two ways:

1. **A tool returns a JSON object with `kind: "canvas"`.** `coerceCanvasPreview` (`src/chat/canvas-render.ts:62-128`) reads `presentation`, `view`, and `source` sub-records and produces a normalised `CanvasPreview`. Either `view.url` or `source.type === "url"` produces a renderable URL; otherwise the preview is dropped.

2. **The assistant's text contains an `[embed]` shortcode** (`src/chat/canvas-render.ts:175-244`):

   ```ts
   export function extractCanvasShortcodes(text: string | undefined): {
     text: string;
     previews: CanvasPreview[];
   } {
     if (!text?.trim() || !text.toLowerCase().includes("[embed")) {
       return { text: text ?? "", previews: [] };
     }
     const fenceSpans = parseFenceSpans(text);
     const matches: Array<{
       start: number;
       end: number;
       attrs: Record<string, string>;
       body?: string;
     }> = [];
     const blockRe = /\[embed\s+([^\]]*?)\]([\s\S]*?)\[\/embed\]/gi;
     const selfClosingRe = /\[embed\s+([^\]]*?)\/\]/gi;
     for (const re of [blockRe, selfClosingRe]) {
       /* … match outside of code fences … */
     }
     /* … */
   }
   ```

   This is why `parseFenceSpans` is imported up top: a `[embed]` *inside* a code fence is part of the conversation, not an embed instruction. The renderer extracts only embeds that are outside fenced code.

### Default canvas URL

When the shortcode supplies only a `ref` (not a `url`), the helper synthesises one (`src/chat/canvas-render.ts:159-162`):

```ts
function defaultCanvasEntryUrl(ref: string): string {
  const encoded = encodeURIComponent(ref.trim());
  return `/__openclaw__/canvas/documents/${encoded}/index.html`;
}
```

The gateway hosts a static document directory at this path; agents can write small HTML capsules (e.g., a chart rendered by a tool) and reference them by id.

### UI-side sanitisation

The URL is only safe because the UI *re-validates* it before assigning to an iframe. `ui/src/ui/canvas-url.ts` (the full file fits) enforces three rules:

```ts
const A2UI_PATH = "/__openclaw__/a2ui";
const CANVAS_HOST_PATH = "/__openclaw__/canvas";
const CANVAS_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";

function isCanvasHttpPath(pathname: string): boolean {
  return (
    pathname === CANVAS_HOST_PATH ||
    pathname.startsWith(`${CANVAS_HOST_PATH}/`) ||
    pathname === A2UI_PATH ||
    pathname.startsWith(`${A2UI_PATH}/`)
  );
}
```

Only paths under `/__openclaw__/canvas` or `/__openclaw__/a2ui` are accepted. External URLs are rejected *unless* `allowExternalEmbedUrls` is set and the URL is `http(s):` — a setting only enabled when the operator has explicitly opted into rendering external content.

When the gateway is reached through a capability plug-in's scoped path (`/__openclaw__/cap/<plugin>/…`), the URL is rewritten to that scope:

```ts
export function resolveCanvasIframeUrl(
  entryUrl: string | undefined,
  canvasPluginSurfaceUrl?: string | null,
  allowExternalEmbedUrls = false,
): string | undefined {
  const rawEntryUrl = entryUrl?.trim();
  if (!rawEntryUrl) {
    return undefined;
  }
  const safeEntryUrl = sanitizeCanvasEntryUrl(rawEntryUrl, allowExternalEmbedUrls);
  if (!safeEntryUrl) {
    return undefined;
  }
  if (!canvasPluginSurfaceUrl?.trim()) {
    return safeEntryUrl;
  }
  try {
    const scopedHostUrl = new URL(canvasPluginSurfaceUrl);
    const scopedPrefix = scopedHostUrl.pathname.replace(/\/+$/, "");
    if (!scopedPrefix.startsWith(CANVAS_CAPABILITY_PATH_PREFIX)) {
      return safeEntryUrl;
    }
    /* rewrite entry URL into the scoped host */
  } catch {
    return safeEntryUrl;
  }
}
```

This is what lets an agent under a sandboxed capability plug-in still render canvases without breaking the same-origin assumptions.

<svg viewBox="0 0 920 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Canvas update flow from agent to UI iframe">
<rect x="20" y="20" width="200" height="80" rx="8" fill="#fed7aa" stroke="#ea580c"/>
<text x="120" y="48" text-anchor="middle" font-size="14" font-weight="700" fill="#7c2d12">1. Agent / tool</text>
<text x="120" y="68" text-anchor="middle" font-size="11" fill="currentColor">emits JSON {kind:"canvas"}</text>
<text x="120" y="84" text-anchor="middle" font-size="11" fill="currentColor">or [embed ref="..."]</text>
<rect x="260" y="20" width="200" height="80" rx="8" fill="#fed7aa" stroke="#ea580c"/>
<text x="360" y="48" text-anchor="middle" font-size="14" font-weight="700" fill="#7c2d12">2. canvas-render.ts</text>
<text x="360" y="68" text-anchor="middle" font-size="11" fill="currentColor">coerceCanvasPreview()</text>
<text x="360" y="84" text-anchor="middle" font-size="11" fill="currentColor">extractCanvasShortcodes()</text>
<rect x="500" y="20" width="200" height="80" rx="8" fill="#99f6e4" stroke="#0d9488"/>
<text x="600" y="48" text-anchor="middle" font-size="14" font-weight="700" fill="#134e4a">3. Gateway message</text>
<text x="600" y="68" text-anchor="middle" font-size="11" fill="currentColor">side-result frame carries</text>
<text x="600" y="84" text-anchor="middle" font-size="11" fill="currentColor">CanvasPreview to UI</text>
<rect x="740" y="20" width="160" height="80" rx="8" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="820" y="48" text-anchor="middle" font-size="14" font-weight="700" fill="#3b0764">4. UI controller</text>
<text x="820" y="68" text-anchor="middle" font-size="11" fill="currentColor">parseChatSideResult()</text>
<text x="820" y="84" text-anchor="middle" font-size="11" fill="currentColor">in app-gateway.ts</text>
<line x1="220" y1="60" x2="260" y2="60" stroke="#64748b" stroke-width="2"/>
<line x1="460" y1="60" x2="500" y2="60" stroke="#64748b" stroke-width="2"/>
<line x1="700" y1="60" x2="740" y2="60" stroke="#64748b" stroke-width="2"/>
<rect x="20" y="160" width="200" height="80" rx="8" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="120" y="188" text-anchor="middle" font-size="14" font-weight="700" fill="#3b0764">5. canvas-url.ts</text>
<text x="120" y="208" text-anchor="middle" font-size="11" fill="currentColor">resolveCanvasIframeUrl()</text>
<text x="120" y="224" text-anchor="middle" font-size="11" fill="currentColor">enforces canvas host</text>
<rect x="260" y="160" width="200" height="80" rx="8" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="360" y="188" text-anchor="middle" font-size="14" font-weight="700" fill="#3b0764">6. side-result-render</text>
<text x="360" y="208" text-anchor="middle" font-size="11" fill="currentColor">builds &lt;iframe sandbox&gt;</text>
<text x="360" y="224" text-anchor="middle" font-size="11" fill="currentColor">with preferredHeight</text>
<rect x="500" y="160" width="200" height="80" rx="8" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="600" y="188" text-anchor="middle" font-size="14" font-weight="700" fill="#3b0764">7. lit-html renders</text>
<text x="600" y="208" text-anchor="middle" font-size="11" fill="currentColor">into chat bubble</text>
<text x="600" y="224" text-anchor="middle" font-size="11" fill="currentColor">in views/chat.ts</text>
<rect x="740" y="160" width="160" height="80" rx="8" fill="#bae6fd" stroke="#0ea5e9"/>
<text x="820" y="188" text-anchor="middle" font-size="14" font-weight="700" fill="#075985">8. Iframe</text>
<text x="820" y="208" text-anchor="middle" font-size="11" fill="currentColor">loads from</text>
<text x="820" y="224" text-anchor="middle" font-size="11" fill="currentColor">/__openclaw__/canvas/...</text>
<line x1="220" y1="200" x2="260" y2="200" stroke="#64748b" stroke-width="2"/>
<line x1="460" y1="200" x2="500" y2="200" stroke="#64748b" stroke-width="2"/>
<line x1="700" y1="200" x2="740" y2="200" stroke="#64748b" stroke-width="2"/>
<line x1="820" y1="100" x2="820" y2="160" stroke="#7c3aed" stroke-width="2" stroke-dasharray="4 4"/>
<text x="450" y="290" text-anchor="middle" font-size="12" fill="#64748b">Each step is in a separate module. Steps 5–8 run in the browser only.</text>
<text x="450" y="310" text-anchor="middle" font-size="12" fill="#64748b">URL sanitisation (step 5) prevents canvas previews from pointing outside the canvas host.</text>
</svg>
<span class="figure-caption">Figure R12.3 | Canvas update flow — the gateway parses a canvas payload, the UI sanitises the URL, and lit-html renders a sandboxed iframe.</span>
<details><summary>ASCII original</summary>

```
agent emits JSON|shortcode -> canvas-render.ts coerce/extract -> gateway side-result frame
                                  v
UI controller (app-gateway.ts) -> canvas-url.resolveCanvasIframeUrl -> side-result-render
                                  v
                              lit-html renders sandboxed iframe in chat bubble
                                  v
                              loads /__openclaw__/canvas/...
```
</details>

## 12.9 Realtime Talk gateway relay (mic audio in the browser)

When the operator turns on Talk in the UI, the browser tab becomes the microphone *and* the speaker for a full-duplex realtime voice loop with the agent. The trickier path — and the one new in 2026.5.22 — is the *gateway relay* transport, where the browser doesn't talk directly to a third-party realtime API but instead forwards mic frames through the gateway, which holds the provider session.

The transport implementation is in `ui/src/ui/chat/realtime-talk-gateway-relay.ts`. The test fixture is `ui/src/ui/realtime-talk-gateway-relay.test.ts`, which mocks `AudioContext`, `getUserMedia`, and the gateway client.

The mock harness shows what real audio capture looks like (`ui/src/ui/realtime-talk-gateway-relay.test.ts:21-58`):

```ts
type MockProcessor = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onaudioprocess:
    | ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void)
    | null;
};

const listeners = new Set<GatewayListener>();
const processors: MockProcessor[] = [];

class MockAudioContext {
  readonly currentTime = 0;
  readonly destination = {};
  readonly close = vi.fn(async () => undefined);

  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }

  createScriptProcessor() {
    const processor: MockProcessor = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null,
    };
    processors.push(processor);
    return processor;
  }
}
```

That is the real shape of the production code path: `createMediaStreamSource(mediaStream).connect(scriptProcessor)`, with `scriptProcessor.onaudioprocess` reading `Float32Array` PCM, converting to 16-bit PCM via `floatToPcm16` (`ui/src/ui/chat/realtime-talk-audio.ts`), and base64-encoding it for the WebSocket frame.

Outbound audio is sent as a gateway request (`realtime-talk-gateway-relay.ts` constructor wires `submitRealtimeTalkConsult`); inbound events arrive as `event: "talk.event"` frames carrying a `RealtimeTalkEvent` from the gateway's Talk subsystem (Chapter 13). The transport surface — `RealtimeTalkTransport` — is uniform: there are sibling implementations for WebRTC (`realtime-talk-webrtc.ts`) and Google Live (`realtime-talk-google-live.ts`); the controller (`ui/src/ui/app.ts`, `RealtimeTalkSession`) picks the transport based on which provider the gateway authorises.

The gateway-relay flavour is the only one that keeps API keys *off* the browser. In WebRTC mode the browser holds an ephemeral provider key; in gateway-relay mode the gateway is the only party that ever sees provider credentials. That difference is invisible to the UI — both transports satisfy the same `RealtimeTalkTransport` interface — but it is the reason the relay test grew significant coverage during 2026.5.22.

## 12.10 Usage and telemetry view

The usage tab summarises cost, tokens, and per-session activity over a configurable date range. It is a useful read because its controller demonstrates how the UI handles *evolving* RPC parameter shapes without breaking older gateways.

The state structure is in `ui/src/ui/controllers/usage.ts:13-31`:

```ts
export type UsageState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  usageLoading: boolean;
  usageResult: SessionsUsageResult | null;
  usageCostSummary: CostUsageSummary | null;
  usageError: string | null;
  usageStartDate: string;
  usageEndDate: string;
  usageScope: "instance" | "family";
  usageSelectedSessions: string[];
  usageSelectedDays: string[];
  usageTimeSeries: SessionUsageTimeSeries | null;
  usageTimeSeriesLoading: boolean;
  usageTimeSeriesCursorStart: number | null;
  usageTimeSeriesCursorEnd: number | null;
  usageSessionLogs: SessionLogEntry[] | null;
  usageSessionLogsLoading: boolean;
  usageTimeZone: "local" | "utc";
  settings?: { gatewayUrl?: string };
};
```

A few lines further down it caches *gateway parameter rejections* (`ui/src/ui/controllers/usage.ts:33-44`):

```ts
const LEGACY_USAGE_DATE_PARAMS_STORAGE_KEY = "openclaw.control.usage.date-params.v1";
const LEGACY_USAGE_SCOPE_PARAMS_STORAGE_KEY = "openclaw.control.usage.scope-params.v1";
const LEGACY_USAGE_DATE_PARAMS_MODE_RE = /unexpected property ['"]mode['"]/i;
const LEGACY_USAGE_DATE_PARAMS_OFFSET_RE = /unexpected property ['"]utcoffset['"]/i;
const LEGACY_USAGE_SCOPE_PARAMS_GROUP_BY_RE = /unexpected property ['"]groupby['"]/i;
const LEGACY_USAGE_SCOPE_PARAMS_INCLUDE_HISTORICAL_RE =
  /unexpected property ['"]includehistorical['"]/i;
const LEGACY_USAGE_DATE_PARAMS_INVALID_RE = /invalid sessions\.usage params/i;
```

What is happening here is a forward-compat pattern: when the UI hits an older gateway that rejects newer optional parameters (`mode`, `utcOffset`, `groupBy`, `includeHistorical`), it remembers which keys were rejected (in localStorage), strips them on subsequent calls, and the user sees a degraded but functional usage view. The cache is a `Set<string>` of rejected keys, persisted as JSON. Reads and writes go through `loadLegacyGatewayParamCache` / `persistLegacyGatewayParamCache` defined just below; both swallow quota/private-mode errors silently.

The view side is split across:

- `ui/src/ui/views/usage.ts` — top-level layout
- `ui/src/ui/views/usage-render-overview.ts` — the summary cards (insights, top sessions)
- `ui/src/ui/views/usage-render-details.ts` (1231 lines) — the time-series chart, including SVG bar rendering, range selection, and drag handles

The chart constants are inline at the top of `usage-render-details.ts` (`ui/src/ui/views/usage-render-details.ts:14-21`):

```ts
const CHART_BAR_WIDTH_RATIO = 0.75; // Fraction of slot used for bar (rest is gap)
const CHART_MAX_BAR_WIDTH = 8; // Max bar width in SVG viewBox units
const CHART_SELECTION_OPACITY = 0.06; // Opacity of range selection overlay
const HANDLE_WIDTH = 5; // Width of drag handle in SVG units
const HANDLE_HEIGHT = 12; // Height of drag handle
const HANDLE_GRIP_OFFSET = 0.7; // Offset of grip lines inside handle
```

Note the small idiom: SVG `viewBox` units are abstract, so dimensions are kept symbolic and the SVG scales to whatever the container measures. This avoids pixel-snapping bugs when the user changes window size.

## 12.11 End-to-end tests

The UI ships two e2e tests under `ui/src/ui/e2e/`:

- `chat-flow.e2e.test.ts` — drive the chat tab through Playwright against a mock gateway, send a turn, observe the final assistant event.
- `chat-picker-pagination.e2e.test.ts` — paginate through a large sessions list with the chat session picker.

The harness machinery is in `ui/src/test-helpers/control-ui-e2e.ts` (referenced from both e2e tests; not reproduced here). It does three things: starts a tiny HTTP server that serves the built control-UI assets, installs a mock gateway via Playwright route interception, and tracks gateway requests so the test can assert on them.

Read the top of `chat-flow.e2e.test.ts:1-15`:

```ts
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = chromium.executablePath();
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
```

Two production-hardening choices are visible: the test silently skips when Chromium is missing (so CI lanes without Playwright don't fail), but only if `OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1` is set — otherwise it throws a hard error in `beforeAll` to prevent accidental green builds.

The mock gateway is a request-routing layer Playwright installs; tests pre-populate `historyMessages` so the UI sees seed data without contacting a real gateway. This is enough fidelity to exercise the *client-side* code paths without bringing up the full Node runtime.

## 12.12 The 2026.5.22 UI changes in theme

A walk through the diff (we won't enumerate test files) shows a small number of *themes* recurring:

1. **Stronger separation between request frames and event frames.** Several controllers gained dedicated event-handler entry points (e.g., `applySessionsChangedEvent` in the sessions controller, `parseChatSideResult` in `app-gateway.ts`). The pattern is to keep the gateway client neutral about feature semantics, and have each controller own its event handling.
2. **Markdown overhaul.** The renderer at `ui/src/ui/markdown.ts` is now 625 lines, with CJK-aware autolink boundaries, an LRU content cache, a hook-based anchor rewrite that classifies "tail" links as blurred, and a strict scheme allowlist. The bulk of the new size is comments and defensive checks.
3. **Dreaming view expansion.** `ui/src/ui/views/dreaming.ts` (1480 lines) renders memory-palace entries and structured diary blocks; its controller adds wiki-import insights. The diary parser uses HTML comments as start/end markers (`<!-- openclaw:dreaming:diary:start -->` … `:end -->`) — a robust delimiter choice because comments survive markdown round-trips.
4. **Exec-approval ergonomics.** The view (`ui/src/ui/views/exec-approval.ts`) gained `formatApprovalDisplayPath`-based path formatting, sortable command spans, and the controller distinguishes *requested* events from *resolved* events (`parseExecApprovalRequested`, `parseExecApprovalResolved`, `parsePluginApprovalRequested` are imported from `app-gateway.ts:43-49`).
5. **Theme bootstrap robustness.** The inline `<script>` in `ui/index.html:13-49` reads `localStorage` *before* Vite hydrates, falls back gracefully on legacy theme names, and resolves system mode via `matchMedia`. This avoids the white-flash on dark-mode reload.
6. **Removal of `src/ui/thinking-labels.ts` on the gateway side.** The thinking-level labels (off, low, medium, high, …) are now owned by the UI exclusively at `ui/src/ui/thinking-labels.ts`, which exports `normalizeThinkingOptionValue`, `formatInheritedThinkingLabel`, `formatThinkingOverrideLabel`. The gateway no longer formats user-facing labels for thinking levels — it only stores the canonical value, and any client renders its own label. This is the right separation: presentation is a client concern.

### Where to start reading next

If you want to dig deeper into a specific area:

- **A new tab from scratch.** Read `ui/src/ui/controllers/debug.ts` plus `ui/src/ui/views/debug.ts` — they're small enough to grok in one sitting and exercise the full controller/view/app dance.
- **Streaming chat.** Read `ui/src/ui/app-tool-stream.ts` (handlers) plus `ui/src/ui/chat/grouped-render.ts` (templates) plus `ui/src/ui/chat/run-lifecycle.ts` (state machine).
- **WebSocket internals.** Read `ui/src/ui/gateway.ts` end-to-end. The class `GatewayBrowserClient` is the entire WS surface.
- **Canvas.** Read `src/chat/canvas-render.ts` and `ui/src/ui/canvas-url.ts` together. The two files are the security boundary between agent output and DOM injection.
- **Realtime Talk.** Read `ui/src/ui/chat/realtime-talk-shared.ts`, then pick one of the three transports (`realtime-talk-gateway-relay.ts`, `realtime-talk-webrtc.ts`, `realtime-talk-google-live.ts`). The relay variant is the most representative.

Chapter 13 picks up where Talk leaves off — TTS, transcription, media understanding, and media generation as gateway-side subsystems.
