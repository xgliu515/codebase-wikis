// Chapter metadata. id is the filename basename; title/desc drive the sidebar and home page cards.

export const CHAPTERS = [
  { id: '01-architecture-overview', num: '01', title: 'Architecture Overview & Boot Flow',
    desc: 'What OpenClaw is, the four-layer architecture, the monorepo layout, and the boot chain from openclaw.mjs to a running Gateway',
    layers: [1, 2, 3, 4] },
  { id: '02-gateway-control-plane', num: '02', title: 'Gateway Control Plane',
    desc: 'server.impl startup, HTTP/WebSocket listening, the RPC method registry, and connection lifecycle',
    layers: [2],
    addenda: [
      { id: '02a-cron-scheduler', title: 'Cron Scheduler Implementation',
        question: 'How are scheduled tasks implemented in OpenClaw',
        asked_at: '2026-05-22',
        classification: 'matched' },
    ] },
  { id: '03-config-system', num: '03', title: 'Configuration System',
    desc: 'The OpenClawConfig schema, config file loading, env var and runtime overrides, and hot reload',
    layers: [2] },
  { id: '04-channel-layer', num: '04', title: 'Channel Abstraction & Transport Layer',
    desc: 'The multi-platform channel plugin model, the message-type contract, send/receive runtime, and delivery policy',
    layers: [1] },
  { id: '05-inbound-pipeline', num: '05', title: 'Inbound Message Pipeline',
    desc: 'MsgContext construction, dispatchInboundMessage, session routing, and command parsing',
    layers: [3] },
  { id: '06-sessions', num: '06', title: 'Sessions & Conversation State',
    desc: 'SessionEntry, the transcript, agent run records, context compaction, and session persistence',
    layers: [3] },
  { id: '07-agent-execution', num: '07', title: 'Agent Command Execution',
    desc: 'runAgentCommand, model selection, auth profile resolution, attempt execution, and event emission',
    layers: [4] },
  { id: '08-llm-providers', num: '08', title: 'LLM Provider Integration',
    desc: 'The provider extension model, the Anthropic/OpenAI unified abstraction, the model catalog, streaming, and credential rotation',
    layers: [4] },
  { id: '09-tools-and-skills', num: '09', title: 'Tools & Skills System',
    desc: 'The tool catalog, tool resolution and invocation, skill loading, approval gating, and MCP integration',
    layers: [4] },
  { id: '10-plugin-system', num: '10', title: 'Plugin System & Extension SDK',
    desc: 'The extensions/ directory, the plugin-sdk barrel, the plugin loader, manifest metadata, and the hook mechanism',
    layers: [4] },
  { id: '11-delivery-and-events', num: '11', title: 'Reply Delivery & Event Stream',
    desc: 'ReplyDispatcher, ReplyPayload assembly, delivery receipts, agent event broadcasting, and retries',
    layers: [3, 1] },
  { id: '12-web-ui-canvas', num: '12', title: 'Web UI & Canvas',
    desc: 'The ui/ React frontend, the WebSocket protocol, real-time rendering, and the Canvas rich-message surface',
    layers: [1] },
  { id: '13-voice-and-media', num: '13', title: 'Voice & Media',
    desc: 'TTS, real-time transcription, media understanding, and the image/video generation extension integrations',
    layers: [4] },
  { id: '14-auth-and-security', num: '14', title: 'Auth & Security',
    desc: 'Token/session authentication, scope-based permissions, the pairing flow, secret storage, and audit logging',
    layers: [2] },
  { id: '15-glossary-and-faq', num: '15', title: 'Glossary & FAQ',
    desc: 'Glossary, FAQ, and a quick reference of environment variables and commands',
    layers: [] },
];

// Single-request trace tour: tour-00 is the overview, tour-01..N are the steps.
export const TOURS = [
  { id: 'tour-00-overview', num: '00', title: 'Trace Tour Overview',
    desc: 'Entry point for the full trace, the 8-section template, a 17-step preview, and the state-variable table' },
  { id: 'tour-01-cli-boot', num: '01', title: 'After typing `openclaw gateway`', desc: 'The openclaw.mjs launcher and entry.ts bootstrap' },
  { id: 'tour-02-gateway-listen', num: '02', title: 'Gateway server starts listening', desc: 'server.impl brings up HTTP/WebSocket' },
  { id: 'tour-03-ws-connect', num: '03', title: 'WebChat opens a connection', desc: 'WebSocket handshake and connection auth' },
  { id: 'tour-04-chat-send-rpc', num: '04', title: 'Client sends chat.send', desc: 'The frontend wraps "hello" into an RPC frame' },
  { id: 'tour-05-method-dispatch', num: '05', title: 'RPC method registry dispatch', desc: 'The registry routes to handleChatSend' },
  { id: 'tour-06-build-msgcontext', num: '06', title: 'Building MsgContext', desc: 'Turning RPC params into an inbound message context' },
  { id: 'tour-07-dispatch-inbound', num: '07', title: 'dispatchInboundMessage', desc: 'The top-level coordinator for inbound dispatch' },
  { id: 'tour-08-session-resolve', num: '08', title: 'Session resolution & load', desc: 'Locating the session, agent, and model' },
  { id: 'tour-09-message-received-hook', num: '09', title: 'message_received hook', desc: 'Plugins can intercept before dispatch' },
  { id: 'tour-10-reply-dispatcher', num: '10', title: 'Creating the ReplyDispatcher', desc: 'The coordinator for delivery, retry, and typing indicators' },
  { id: 'tour-11-agent-command', num: '11', title: 'Entering the agent command', desc: 'runAgentCommand resolves the runtime' },
  { id: 'tour-12-build-prompt', num: '12', title: 'Building the prompt & context', desc: 'History + system prompt + current message' },
  { id: 'tour-13-llm-call', num: '13', title: 'Calling the LLM provider', desc: 'Anthropic streaming inference call' },
  { id: 'tour-14-stream-events', num: '14', title: 'Emitting & subscribing to stream events', desc: 'How agent events are consumed' },
  { id: 'tour-15-finalize-reply', num: '15', title: 'Assembling the ReplyPayload', desc: 'Events accumulate into the final reply' },
  { id: 'tour-16-channel-deliver', num: '16', title: 'Delivering back to WebChat and broadcasting', desc: 'Channel send and event broadcast' },
  { id: 'tour-17-session-persist', num: '17', title: 'Session persistence', desc: 'Transcript written back to session storage' },
];

export const TOUR_BY_ID = Object.fromEntries(TOURS.map(t => [t.id, t]));

// All docs (chapters + addenda + tour), used for routing and search.
// addenda is flattened into ALL_DOCS; each addendum carries a parentId so content rendering can back-link.
const FLATTENED_CHAPTERS = CHAPTERS.flatMap(c => {
  const entries = [c];
  if (Array.isArray(c.addenda)) {
    for (const a of c.addenda) {
      entries.push({ ...a, parentId: c.id, num: a.id.match(/^(\d+[a-z]?)/)?.[1] ?? c.num });
    }
  }
  return entries;
});
export const ALL_DOCS = [...FLATTENED_CHAPTERS, ...TOURS];
export const CHAPTER_BY_ID = Object.fromEntries(ALL_DOCS.map(c => [c.id, c]));

// =========================================================
// Project info — this file is the ONLY per-project JS file the viewer needs.
// Every other web/js/*.js imports these constants; do not hardcode the project name elsewhere.
// =========================================================
export const PROJECT_NAME = 'OpenClaw';

// Analyzed code version (bump these 4 constants when re-running; all GitHub deep-links update).
export const PROJECT_GITHUB_REPO = 'openclaw/openclaw';
export const ANALYZED_COMMIT = 'a374c3a5bf';
export const ANALYZED_TAG = 'v2026.5.22';
export const ANALYZED_DATE = '2026-05-24';

// Home page strings
export const PROJECT_TAGLINE = 'OpenClaw source-code reference Wiki — a self-hosted personal AI assistant gateway that unifies twenty-plus messaging channels.';
export const PROJECT_FOCUS = 'Gateway control plane and the full single-message round-trip';
export const TRACE_TARGET = 'WebChat sends one "hello", the assistant replies';

// Current version directory name: the last non-.html path segment, e.g.
//   /xxx-wiki/v0.22.0/index.html  →  'v0.22.0'
// Used by the version dropdown and localStorage isolation. Returns '' if empty.
export function getCurrentVersionDir() {
  const segs = location.pathname.split('/').filter(Boolean);
  if (segs.length && /\.html?$/i.test(segs[segs.length - 1])) segs.pop();
  return segs.length ? segs[segs.length - 1] : '';
}

// Current project directory name: the parent of the version dir in mono-repo, e.g.
//   /wikis/vllm/v0.22.0/index.html  →  'vllm'
// Used by the project dropdown. Returns '' if the path has fewer than two segments.
export function getCurrentProjectDir() {
  const segs = location.pathname.split('/').filter(Boolean);
  if (segs.length && /\.html?$/i.test(segs[segs.length - 1])) segs.pop();
  return segs.length >= 2 ? segs[segs.length - 2] : '';
}

// localStorage key prefix derived from PROJECT_NAME, with the version dir name appended,
// so multiple versions on the same origin don't trample each other's reading state.
export const STORAGE_PREFIX = (() => {
  const base = (PROJECT_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'codebase') + '-wiki';
  const ver = getCurrentVersionDir();
  return ver ? `${base}-${ver}` : base;
})();

// =========================================================
// file:line jump links: default to GitHub (anyone can use), can be switched to local VSCode.
// localStorage has a path → 'local' mode; absent → 'github' mode.
// =========================================================
const REPO_ROOT_KEY = STORAGE_PREFIX + '-repo-root';

export function getRepoMode() {
  return getRepoRoot() ? 'local' : 'github';
}

export function getRepoRoot() {
  try { return localStorage.getItem(REPO_ROOT_KEY) || ''; }
  catch { return ''; }
}

export function setRepoRoot(path) {
  try {
    if (path && path.trim()) localStorage.setItem(REPO_ROOT_KEY, path.trim());
    else localStorage.removeItem(REPO_ROOT_KEY);
  } catch {}
}
