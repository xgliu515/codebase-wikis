# Chapter 04: Channel Abstraction & Transport Layer

> Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 0. The problem this chapter solves

OpenClaw's pitch is "one self-hosted agent across the twenty-plus messaging surfaces you already use." Translated into code, that promise is uncomfortable. Telegram is a long-polling HTTPS bot API. Slack is a WebSocket socket-mode connection with retries and ack windows. Discord is a gateway WebSocket with separate REST APIs per resource. Signal sits behind a desktop daemon. iMessage talks to a sidecar Mac running AppleScript. Matrix is a federated HTTP API with end-to-end-encrypted variants. Mattermost, Microsoft Teams, Feishu, LINE, IRC, WhatsApp via several different backends, plus the in-process WebChat that the gateway serves itself — each has its own:

- **transport** (HTTPS poll vs. WebSocket vs. local socket vs. process pipe),
- **message shape** (text + attachment vs. blocks vs. mrkdwn vs. card),
- **authentication** (bot token, app token, session cookie, OAuth, pairing code),
- **rate-limit and reaction model** (some support typing indicators, some don't, some have ack reactions),
- **threading model** (Slack threads, Telegram reply-to, Matrix root, Discord channels-within-channels),
- **identity model** (bare user id, JID, ACI/PNI for Signal, room+user pair for Matrix).

The core (`src/`) must drive an agent loop without baking in any of these. The constraint is spelled out at the top of the repo's `AGENTS.md`:

```text
- Core stays plugin-agnostic. No bundled ids/defaults/policy in core when manifest/registry/capability contracts work.
- Plugins cross into core only via `openclaw/plugin-sdk/*`, manifest metadata, injected runtime helpers, documented barrels (`api.ts`, `runtime-api.ts`).
- Channels are implementation under `src/channels/**`; plugin authors get SDK seams.
```
(`AGENTS.md:26-30` and `:54-55`)

A scoped guide enforces the same boundary for the channels tree itself:

```text
`src/channels/**` is core channel implementation. Plugin authors should not import from this tree directly.
```
(`src/channels/AGENTS.md:1-4`)

That is the rule. This chapter walks the contracts and runtime helpers that make it work, the message-type discriminator that lets twenty different platforms share one inbound pipeline, the allow-from / ack-reaction / conversation-binding seams that gate who can talk to your agent, and the v2026.5.22 catalog-cache refactor that quietly cut startup work in half.

## 1. The shape of `src/channels/`

```text
src/channels/                ChannelPlugin contract, shared chat types, runtime seams
├── chat-type.ts             "direct" | "group" | "channel"
├── chat-meta.ts             channel id → display metadata (label, blurb, icon)
├── chat-meta-shared.ts      builds the metadata from the bundled catalog
├── ids.ts                   ChatChannelId, alias normalization, channel order
├── bundled-channel-catalog-read.ts   reads dist/channel-catalog.json + bundled package.json
├── channel-config.ts        match/wildcard/parent key resolution
├── account-inspection.ts    plugin-provided account introspection
├── account-snapshot-fields.ts        safe-projection helpers for status snapshots
├── allow-from.ts            DM/group allowlist merge & match
├── ack-reactions.ts         when to render an ack emoji on a received message
├── conversation-binding-context.ts   /agent bind → (channel, account, conversation, thread)
├── conversation-label.ts    user-visible label for a conversation in envelopes
├── conversation-resolution.ts        full resolver (used by binding-context above)
├── command-gating.ts        which channels accept which native commands
├── mention-gating.ts        do we require @-mention in groups?
├── model-overrides.ts       per-channel model selection
├── inbound-debounce-policy.ts        text inbound debouncing (multi-line WhatsApp etc.)
├── inbound-event/           classification + payload normalization
│   ├── kind.ts              InboundEventKind: "user_request" | "room_event"
│   ├── classification.ts    decides which one given mention/policy
│   ├── context.ts           buildChannelInboundEventContext → MsgContext
│   └── media.ts             media payload merging
├── message/                 outbound delivery contract
│   ├── types.ts             ChannelMessageAdapterShape + capability vocabulary
│   ├── contracts.ts         capability proof verifiers
│   ├── send.ts              orchestrated send entry-point
│   ├── receipt.ts           MessageReceipt assembly + reconciliation
│   ├── live.ts              draft/preview/finalize state machine
│   └── outbound-bridge.ts   gateway → channel adapter call
├── message-access/          per-channel allowlist runtime
└── plugins/                 ChannelPlugin contract + bundled registry
    ├── types.plugin.ts      ChannelPlugin (top-level capability bag)
    ├── types.core.ts        ChannelMeta, ChannelCapabilities, ChannelAccountSnapshot, ...
    ├── types.adapters.ts    Adapter interfaces (status, gateway, doctor, directory, ...)
    └── ...
```

The split is intentional. Anything that's pure data about the *idea* of a channel — what is a chat type, what is an inbound event, what does an outbound message receipt look like — lives at the top level. Anything that's pluggable per channel — auth flow, status probe, send routine, command set — lives under `plugins/`. Anything that mediates between core and plugin authors lives in `src/plugin-sdk/`.

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Channel layer contracts and the plugin-sdk seam between core and plugins"><defs><marker id="r41ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Channel layer: contracts in core, capabilities in plugins</text><rect x="20" y="36" width="720" height="138" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/><text x="40" y="56" font-size="12" font-weight="700" fill="#ea580c">core (src/) — plugin-agnostic</text><rect x="40" y="64" width="220" height="50" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/><text x="50" y="80" font-size="10" font-weight="700" fill="#9a3412">src/channels/inbound-event/</text><text x="50" y="94" font-size="10" fill="#7c2d12">classify event, build MsgContext</text><text x="50" y="108" font-size="10" fill="#7c2d12">discriminator: user_request/room_event</text><rect x="270" y="64" width="220" height="50" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/><text x="280" y="80" font-size="10" font-weight="700" fill="#9a3412">src/channels/message/</text><text x="280" y="94" font-size="10" fill="#7c2d12">send / receipt / live preview</text><text x="280" y="108" font-size="10" fill="#7c2d12">capability proofs</text><rect x="500" y="64" width="220" height="50" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/><text x="510" y="80" font-size="10" font-weight="700" fill="#9a3412">src/channels/plugins/types.*</text><text x="510" y="94" font-size="10" fill="#7c2d12">ChannelPlugin shape</text><text x="510" y="108" font-size="10" fill="#7c2d12">adapter interfaces</text><rect x="40" y="120" width="680" height="48" rx="5" fill="#ffedd5" stroke="#ea580c" stroke-width="1"/><text x="50" y="138" font-size="10" font-weight="700" fill="#9a3412">src/channels/{allow-from, ack-reactions, conversation-binding-context, conversation-label, account-inspection}</text><text x="50" y="155" font-size="10" fill="#7c2d12">policy seams: who can send, how to ack, how to label, how to introspect</text><rect x="20" y="186" width="720" height="44" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="1.5"/><text x="40" y="206" font-size="12" font-weight="700" fill="#7c3aed">src/plugin-sdk/ — only door between core and plugins</text><text x="40" y="222" font-size="10" fill="#5b21b6">channel-contract.ts re-exports types; runtime helpers are injected (no direct src/channels imports from plugins)</text><rect x="20" y="244" width="720" height="100" rx="8" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.5"/><text x="40" y="264" font-size="12" font-weight="700" fill="#0d9488">plugins — independently loadable</text><rect x="40" y="272" width="220" height="60" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/><text x="50" y="288" font-size="10" font-weight="700" fill="#115e59">extensions/telegram/</text><text x="50" y="302" font-size="10" fill="#115e59">long-poll + reply-to threads</text><text x="50" y="316" font-size="10" fill="#115e59">native /commands via bot menu</text><rect x="270" y="272" width="220" height="60" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/><text x="280" y="288" font-size="10" font-weight="700" fill="#115e59">extensions/slack/</text><text x="280" y="302" font-size="10" fill="#115e59">socket-mode WS, ack-policy</text><text x="280" y="316" font-size="10" fill="#115e59">thread root id is event ts</text><rect x="500" y="272" width="220" height="60" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/><text x="510" y="288" font-size="10" font-weight="700" fill="#115e59">internal channels (web, cron)</text><text x="510" y="302" font-size="10" fill="#115e59">served directly by gateway</text><text x="510" y="316" font-size="10" fill="#115e59">no transport adapter required</text><line x1="380" y1="174" x2="380" y2="186" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4,2" marker-end="url(#r41ar)"/><line x1="380" y1="230" x2="380" y2="244" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4,2" marker-end="url(#r41ar)"/></svg>
<span class="figure-caption">Figure R4.1 | Contracts and runtime helpers live in core; transports and surface-specific code live in plugins; the plugin-sdk seam is the only door between them.</span>

<details><summary>ASCII original</summary>

```
core (src/, plugin-agnostic)
├── src/channels/inbound-event/   classify, build MsgContext, discriminator
├── src/channels/message/          send / receipt / live preview / proofs
├── src/channels/plugins/types.*   ChannelPlugin shape, adapter interfaces
└── policy seams: allow-from, ack-reactions, conversation-binding-context,
                  conversation-label, account-inspection

           src/plugin-sdk/  ── only door between core and plugins ──
                 (channel-contract.ts re-exports; runtime helpers injected)

plugins (independently loadable)
├── extensions/telegram/    long-poll bot, reply-to threads
├── extensions/slack/       socket-mode WS, ack-policy
└── internal channels       web, cron — gateway serves directly
```
</details>

## 2. Naive design and why it fails

The naive design is: write a `ChannelTransport` interface with `connect()`, `send(text, to)`, `onMessage(handler)`, register implementations in a switch statement in core, done. This collapses inside a week of real platform usage.

- **Send is not one-shot.** A long Slack response needs to be edited live as the model streams, then finalized when the model finishes. Telegram cannot edit messages older than 48 hours; iMessage cannot edit at all; Matrix can edit but only with a follow-up "m.replace" event. The shape of "send" is different per channel, and the *capability* has to be discoverable so the core agent loop knows whether to stream-preview or not. Look at `LiveMessagePhase = "idle" | "previewing" | "finalizing" | "finalized" | "cancelled"` and `ChannelMessageLiveCapability` (`src/channels/message/types.ts:118` and `:293-306`) — these are not flags one transport can wave away.
- **Receipt is not one-shot either.** A single agent reply may emit text + voice + a poll; on Telegram that's three platform messages, each with its own id, and editing the right one later requires storing all three. `MessageReceipt` carries `platformMessageIds[]`, `parts[]`, and a `raw` array for that reason (`src/channels/message/types.ts:70-80`).
- **Authentication is not a string.** Slack has bot token + app token + signing secret, each of which can be "available", "configured_unavailable" (we have a refresh token but no live token), or "missing." Read-only commands like `openclaw channels status` need to show "configured but not connected" without ever loading the actual secret. That's the entire reason `src/channels/account-snapshot-fields.ts` exists.
- **Allowlists differ by chat type.** DMs typically have one allowlist; groups usually fall back to it but may override; `accessGroup:` prefixes pull from a reusable list. A single `allowFrom: string[]` per channel does not survive contact with reality (`src/channels/allow-from.ts`).
- **Group messages need a routing decision before anything else.** When a user sends "hi" in a 50-person Slack channel where your bot is a member, is that *for* the agent or just chatter? The classification depends on mention, command source, and per-agent policy. `classifyChannelInboundEvent` returns the binary discriminator that drives the rest of the pipeline (`src/channels/inbound-event/classification.ts:15-33`).

So the actual design is not "one interface." It's an opt-in capability bag (`ChannelPlugin`) plus a shared message vocabulary (`MsgContext`, `MessageReceipt`) plus a runtime helper surface that the gateway injects.

## 3. The `ChannelPlugin` shape

`src/channels/plugins/types.plugin.ts:57-105` is the load-bearing definition. Every channel — bundled or external — produces one of these objects:

```typescript
// src/channels/plugins/types.plugin.ts:57-105
export type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  defaults?: { queue?: { debounceMs?: number } };
  reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
  setupWizard?: ChannelPluginSetupWizard;
  config: ChannelConfigAdapter<ResolvedAccount>;
  configSchema?: ChannelConfigSchema;
  setup?: ChannelSetupAdapter;
  pairing?: ChannelPairingAdapter;
  security?: ChannelSecurityAdapter<ResolvedAccount>;
  groups?: ChannelGroupAdapter;
  mentions?: ChannelMentionAdapter;
  outbound?: ChannelOutboundAdapter;
  status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;
  auth?: ChannelAuthAdapter;
  approvalCapability?: ChannelApprovalCapability;
  commands?: ChannelCommandAdapter;
  lifecycle?: ChannelLifecycleAdapter;
  secrets?: ChannelSecretsAdapter;
  allowlist?: ChannelAllowlistAdapter;
  doctor?: ChannelDoctorAdapter;
  bindings?: ChannelConfiguredBindingProvider;
  conversationBindings?: ChannelConversationBindingSupport;
  streaming?: ChannelStreamingAdapter;
  threading?: ChannelThreadingAdapter;
  message?: ChannelMessageAdapterShape;
  messaging?: ChannelMessagingAdapter;
  agentPrompt?: ChannelAgentPromptAdapter;
  directory?: ChannelDirectoryAdapter;
  resolver?: ChannelResolverAdapter;
  actions?: ChannelMessageActionAdapter;
  heartbeat?: ChannelHeartbeatAdapter;
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];
};
```

Read it as a checklist: every adapter is optional. WebChat (the internal channel served by the gateway) supplies a tiny subset; Telegram supplies almost all of them. The two non-optional fields are `id`, `meta`, `capabilities`, and `config`. Everything else is a feature the channel either has or doesn't.

`ChannelCapabilities` is the declarative side. It lets the core ask "can you edit messages?" or "can you stream a live preview?" without calling and catching exceptions. `ChannelMessageAdapterShape` then *executes* what was declared — and at boot time the proof verifiers in `src/channels/message/contracts.ts:94-115, 117-138` walk the declared capability bitmap and demand that each one have a contract proof callback. A plugin that says "yes I support `afterCommit`" but doesn't ship a proof callback fails at registration. That keeps the runtime honest about what each channel actually does.

## 4. The bundled channel catalog and the v2026.5.22 cache refactor

There are two ways a channel ends up in OpenClaw: **bundled** (shipped inside the main package's `dist/channel-catalog.json`) or **bundled-extension** (a sibling package under the bundled plugins directory). Both are scanned at startup so the CLI can list them in `openclaw channels add`. The reader is `src/channels/bundled-channel-catalog-read.ts`.

The whole file is 134 lines and worth reading top-to-bottom. The relevant cache structure is:

```typescript
// src/channels/bundled-channel-catalog-read.ts:22-24
const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH = path.join("dist", "channel-catalog.json");
const officialCatalogFileCache = new Map<string, ChannelCatalogEntryLike[] | null>();
const bundledPackageCatalogCache = new Map<string, ChannelCatalogEntryLike[] | null>();
```

Two module-scope caches, both keyed by the resolved directory. The `null` value is meaningful — it means "we already tried this path and it failed; do not retry." That last bit was the point of the May 2026 commit:

```text
ad0d87d881 perf: cache startup package metadata
```
(`git log -1 ad0d87d881`)

Before that commit, every list call re-`fs.readdirSync`'d the bundled-plugins directory and re-parsed each `package.json`. With ~20 bundled plugins and several call sites during boot, that was a measurable chunk of cold-start latency on slow disks. The fix is the two-line cache on lines 23–24, plus `cached !== undefined` short-circuits inside the readers:

```typescript
// src/channels/bundled-channel-catalog-read.ts:38-56
const cached = bundledPackageCatalogCache.get(pluginsDir);
if (cached !== undefined) {
  return cached ?? [];
}
try {
  const entries = fs
    .readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry): ChannelCatalogEntryLike[] => {
      const packageJsonPath = path.join(pluginsDir, entry.name, "package.json");
      const parsed = tryReadJsonSync<ChannelCatalogEntryLike>(packageJsonPath);
      return parsed ? [parsed] : [];
    });
  bundledPackageCatalogCache.set(pluginsDir, entries);
  return entries;
} catch {
  bundledPackageCatalogCache.set(pluginsDir, null);
  return [];
}
```

Two months later, `9b13616240 fix: tolerate bundled channel catalog discovery failures` and `2ab08c8a19 fix(cli): keep plugin parent help lightweight` finished the story by hardening the failure mode so a missing `dist/channel-catalog.json` doesn't crash global CLI help. The shipped state at `a374c3a5bf` is a stable, idempotent reader that runs once per process per directory and quietly handles missing files.

What makes this work end-to-end is `ids.ts`, which freezes the channel set at module load:

```typescript
// src/channels/ids.ts:25-30
const BUNDLED_CHAT_CHANNEL_ENTRIES = Object.freeze(listBundledChatChannelEntries());
const CHAT_CHANNEL_ID_SET = new Set(BUNDLED_CHAT_CHANNEL_ENTRIES.map((entry) => entry.id));

export const CHAT_CHANNEL_ORDER = Object.freeze(
  BUNDLED_CHAT_CHANNEL_ENTRIES.map((entry) => entry.id),
);
```

`CHAT_CHANNEL_ORDER` and `CHAT_CHANNEL_ALIASES` are referenced from dozens of places — UI dropdowns, status renderers, allowlist parsers, command gating. Because the catalog reader is now cached, all of them resolve from the same in-memory map and the same id set without a single repeat disk read.

The lookup contract for these ids — `normalizeChatChannelId` — folds aliases, returns `null` for unknown values, and is the only sanctioned way to turn a user-supplied channel string into a `ChatChannelId`:

```typescript
// src/channels/ids.ts:46-53
export function normalizeChatChannelId(raw?: string | null): ChatChannelId | null {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (!normalized) {
    return null;
  }
  const resolved = CHAT_CHANNEL_ALIASES[normalized] ?? normalized;
  return CHAT_CHANNEL_ID_SET.has(resolved) ? resolved : null;
}
```

## 5. The shared chat-type vocabulary

Every channel inbound event normalizes down to three kinds of conversation:

```typescript
// src/channels/chat-type.ts:3
export type ChatType = "direct" | "group" | "channel";
```

`direct` is a DM with one human; `group` is a multi-party room where everyone can speak; `channel` is a broadcast room where mostly one party speaks. Slack treats public channels as `channel` and group DMs as `group`; Telegram treats supergroups as `group` and broadcast channels as `channel`; Matrix uses the same split. `normalizeChatType` (lines 5–20 of that file) accepts the common alias `dm` and rejects anything else by returning `undefined`, which downstream code interprets as "we don't know, default to direct."

This three-way split is the single most important invariant in the channel layer: the unmentioned-group policy, the per-channel command gating, the allowlist split between DM-allow and group-allow, the threading model — all of them branch on this enum.

## 6. The message-type discriminator and the inbound event shape

OpenClaw classifies *every* inbound event into one of two top-level kinds before it touches the agent:

```typescript
// src/channels/inbound-event/kind.ts:1
export type InboundEventKind = "user_request" | "room_event";
```

`user_request` means "the user is talking to the agent" — direct DMs, @-mentions in groups, native slash-commands, abort triggers. `room_event` means "we are watching this room but the human is talking to other humans" — the typical group-chat case where a stream of side conversation arrives and the agent should NOT respond as if addressed. The classifier:

```typescript
// src/channels/inbound-event/classification.ts:15-33
export function classifyChannelInboundEvent(
  params: ClassifyChannelInboundEventParams,
): InboundEventKind {
  if (params.unmentionedGroupPolicy !== "room_event") {
    return "user_request";
  }
  if (params.conversation.kind !== "group" && params.conversation.kind !== "channel") {
    return "user_request";
  }
  if (
    params.wasMentioned === true ||
    params.hasControlCommand === true ||
    params.hasAbortRequest === true ||
    params.commandSource === "native"
  ) {
    return "user_request";
  }
  return "room_event";
}
```

The default policy is "treat everything as a user request." Only when the operator has explicitly set the `unmentionedInbound: "room_event"` policy (either per-agent or via `messages.groupChat.unmentionedInbound`) does the unmentioned-group path actually return `"room_event"`. The classifier reads that config-vs-agent precedence in `resolveUnmentionedGroupInboundPolicy` on lines 35–46 of the same file.

The classifier's output rides on the resulting `MsgContext` as `InboundEventKind`. Down in the dispatch layer, it gates whether replies are delivered as a real outbound send or only as a `message` tool result that the agent can consume without spamming the room (`src/auto-reply/reply/dispatch-from-config.ts:1205-1211`).

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Hierarchy of message and event discriminators in the channel layer"><defs><marker id="r42ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Discriminator hierarchy</text><rect x="290" y="40" width="180" height="42" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="380" y="58" text-anchor="middle" font-size="11" font-weight="700" fill="#7c2d12">Inbound channel event</text><text x="380" y="74" text-anchor="middle" font-size="10" fill="#7c2d12">raw payload from transport</text><line x1="380" y1="82" x2="380" y2="104" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r42ar)"/><rect x="40" y="110" width="200" height="56" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="140" y="128" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">ChatType</text><text x="140" y="144" text-anchor="middle" font-size="10" fill="#5b21b6">direct | group | channel</text><text x="140" y="158" text-anchor="middle" font-size="10" fill="#5b21b6">src/channels/chat-type.ts</text><rect x="280" y="110" width="200" height="56" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="380" y="128" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">InboundEventKind</text><text x="380" y="144" text-anchor="middle" font-size="10" fill="#5b21b6">user_request | room_event</text><text x="380" y="158" text-anchor="middle" font-size="10" fill="#5b21b6">src/channels/inbound-event/kind.ts</text><rect x="520" y="110" width="200" height="56" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="620" y="128" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">CommandTurn.source</text><text x="620" y="144" text-anchor="middle" font-size="10" fill="#5b21b6">native | text | none</text><text x="620" y="158" text-anchor="middle" font-size="10" fill="#5b21b6">src/auto-reply/command-turn-context</text><line x1="140" y1="166" x2="140" y2="186" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r42ar)"/><line x1="380" y1="166" x2="380" y2="186" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r42ar)"/><line x1="620" y1="166" x2="620" y2="186" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r42ar)"/><rect x="40" y="190" width="680" height="68" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="380" y="208" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">MsgContext (carries all three) — built by buildChannelInboundEventContext</text><text x="380" y="226" text-anchor="middle" font-size="10" fill="#115e59">SessionKey · From · To · Body · BodyForAgent · BodyForCommands · ChatType · InboundEventKind</text><text x="380" y="240" text-anchor="middle" font-size="10" fill="#115e59">+ media payload + supplemental quote/forward/thread + sender facts + reply/route facts</text><text x="380" y="253" text-anchor="middle" font-size="10" fill="#115e59">src/channels/inbound-event/context.ts:148</text><line x1="380" y1="258" x2="380" y2="280" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r42ar)"/><rect x="40" y="282" width="320" height="68" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="200" y="300" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">Outbound: ChannelMessageSendAttemptKind</text><text x="200" y="316" text-anchor="middle" font-size="10" fill="#78350f">text | media | payload | poll</text><text x="200" y="332" text-anchor="middle" font-size="10" fill="#78350f">+ lifecycle (beforeSendAttempt / afterSendSuccess / afterCommit)</text><text x="200" y="346" text-anchor="middle" font-size="10" fill="#78350f">src/channels/message/types.ts:199-281</text><rect x="400" y="282" width="320" height="68" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="560" y="300" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">Live phase machine</text><text x="560" y="316" text-anchor="middle" font-size="10" fill="#78350f">idle → previewing → finalizing → finalized</text><text x="560" y="332" text-anchor="middle" font-size="10" fill="#78350f">(or cancelled)</text><text x="560" y="346" text-anchor="middle" font-size="10" fill="#78350f">src/channels/message/types.ts:118</text></svg>
<span class="figure-caption">Figure R4.2 | Three discriminator axes — ChatType, InboundEventKind, CommandTurn.source — all flow into MsgContext, which then drives the outbound send-kind machine.</span>

<details><summary>ASCII original</summary>

```
                            Inbound channel event (raw payload)
                                            |
        ┌───────────────────────────────────┼───────────────────────────────────┐
        v                                   v                                   v
   ChatType                          InboundEventKind                   CommandTurn.source
   direct / group / channel          user_request / room_event          native / text / none

                                            v
        MsgContext  (SessionKey, From, To, Body, BodyForAgent, BodyForCommands,
                     ChatType, InboundEventKind, media payload, sender facts, ...)
                                            |
        ┌───────────────────────────────────┴───────────────────────────────────┐
        v                                                                       v
   Outbound send-kind                                          Live phase machine
   text / media / payload / poll                               idle → previewing → finalizing
   + lifecycle hooks                                                  → finalized | cancelled
```
</details>

The companion vocabulary on the outbound side is in `src/channels/message/types.ts`. The relevant pieces:

```typescript
// src/channels/message/types.ts:199-205
export type ChannelMessageSendAttemptKind = "text" | "media" | "payload" | "poll";

export type ChannelMessageSendAttemptContext<TConfig = OpenClawConfig> =
  | (ChannelMessageSendTextContext<TConfig> & { kind: "text" })
  | (ChannelMessageSendMediaContext<TConfig> & { kind: "media" })
  | (ChannelMessageSendPayloadContext<TConfig> & { kind: "payload" })
  | (ChannelMessageSendPollContext<TConfig> & { kind: "poll" });
```

A `payload` is a multi-part rendered batch — used when the channel can render a single user-visible message that combines text + attachment + interactive controls. `poll` is its own kind because Telegram polls have a separate API endpoint than chat messages. The lifecycle hooks on `ChannelMessageSendLifecycleAdapter` (lines 258–270 of the same file) give the channel four chances to observe a send: before attempt, after success, after failure, after commit. "After commit" is post-durable-storage; that's where `outbox`-style guarantees live.

## 7. Building a `MsgContext` from an inbound payload

The bridge from "raw inbound from the transport" to "thing the inbound pipeline can dispatch" is `buildChannelInboundEventContext` in `src/channels/inbound-event/context.ts:148-218`. It accepts about twenty optional groups of facts — `SenderFacts`, `ConversationFacts`, `RouteFacts`, `ReplyPlanFacts`, `MessageFacts`, `AccessFacts`, `CommandFacts`, `InboundMediaFacts[]`, `SupplementalContextFacts` — and assembles them into a `FinalizedMsgContext`:

```typescript
// src/channels/inbound-event/context.ts:165-217 (excerpt)
return finalizeInboundContext({
  Body: body,
  InboundEventKind: params.message.inboundEventKind ?? "user_request",
  BodyForAgent: params.message.bodyForAgent ?? params.message.rawBody,
  RawBody: params.message.rawBody,
  CommandBody: params.message.commandBody ?? params.message.rawBody,
  BodyForCommands: params.message.commandBody ?? params.message.rawBody,
  From: params.from,
  To: params.reply.to,
  SessionKey: params.route.dispatchSessionKey ?? params.route.routeSessionKey,
  AccountId: params.route.accountId ?? params.accountId,
  // ...
  ChatType: params.conversation.kind,
  ConversationLabel: params.conversation.label,
  SenderId: params.sender.id,
  SenderUsername: params.sender.username,
  // ...
  Provider: params.provider ?? params.channel,
  Surface: params.surface ?? params.provider ?? params.channel,
  WasMentioned: params.access?.mentions?.wasMentioned,
  CommandAuthorized: resolveAccessFactsCommandAuthorized(params.access) === true,
  CommandTurn: commandTurn,
  OriginatingChannel: params.channel,
  // ...
});
```

Three things to notice:

1. **Body has three projections.** `Body` is the legacy rendered body. `BodyForAgent` is the clean text the model should see — no envelope, no inline command syntax. `BodyForCommands` is the text the command parser should match against — original casing, no envelope. This split exists because legacy code sometimes set `Body` to an envelope-shaped string (`[user X said] hello`), and the model would then see the envelope as user input. `finalizeInboundContext` in `src/auto-reply/reply/inbound-context.ts:39-104` enforces the three-way split downstream.
2. **`Provider`, `Surface`, and `OriginatingChannel` are three distinct fields.** Provider is the platform id (`telegram`, `slack`). Surface is the display label or sub-surface (e.g. `slack:thread:1234`). OriginatingChannel is locked to whatever channel actually generated the event, even if the session is shared across surfaces.
3. **`SessionKey` is already resolved by the channel.** The channel layer hands the dispatch pipeline a pre-built session key; resolving it is somebody else's problem (Ch 05). This is intentional: per `AGENTS.md:39-40`, "hot paths should carry prepared facts forward… do not rediscover with broad… loaders."

The return type `BuiltChannelInboundEventContext` adds back five required fields that downstream code can count on being populated (`src/channels/inbound-event/context.ts:47-59`). Everything else is optional. This is the contract `MsgContext` upgrades to once it's been finalized.

## 8. Send and receive: the runtime helper surface

The `outbound` adapter on a `ChannelPlugin` is what the core actually calls when an agent produces a reply. The interface is `ChannelOutboundAdapter` in `src/channels/plugins/types.adapters.ts` (not quoted here; ~80 lines). For the modern path, channels also supply the `message` field — `ChannelMessageAdapterShape` — which is the typed, capability-discoverable side:

```typescript
// src/channels/message/types.ts:349-358
export type ChannelMessageAdapterShape<
  TConfig = OpenClawConfig,
  TSendResult extends ChannelMessageSendResult = ChannelMessageSendResult,
> = {
  id?: string;
  durableFinal?: ChannelMessageDurableFinalAdapter;
  send?: ChannelMessageSendAdapter<TConfig, TSendResult>;
  live?: ChannelMessageLiveAdapterShape;
  receive?: ChannelMessageReceiveAdapterShape;
};
```

`send` carries four optional functions — `text`, `media`, `payload`, `poll` — matching the four `ChannelMessageSendAttemptKind` values. `live` declares whether the channel can preview/edit before finalize. `durableFinal` declares which durability capabilities exist (text vs. media, batched vs. single, post-send hooks, the ability to reconcile an `unknown_send` reply ack — see `ChannelMessageUnknownSendReconciliationResult` on lines 243-256).

`receive` is the small but important counterpart that says **when** the channel wants to ack the platform that we've taken responsibility for the message:

```typescript
// src/channels/message/types.ts:331-348
export type ChannelMessageReceiveAckPolicy =
  | "after_receive_record"
  | "after_agent_dispatch"
  | "after_durable_send"
  | "manual";

export const channelMessageReceiveAckPolicies = [
  "after_receive_record",
  "after_agent_dispatch",
  "after_durable_send",
  "manual",
] as const satisfies readonly ChannelMessageReceiveAckPolicy[];
```

Telegram is `after_receive_record` because long-polling already implies "I got it." Slack socket-mode is `after_durable_send` because the ack-and-redeliver window matters. Matrix wants `manual` so the plugin can decide based on the room policy. The capability proof harness verifies each declared policy has an actual implementation: see `verifyChannelMessageReceiveAckPolicyProofs` in `src/channels/message/contracts.ts:163-185`.

**Registration** happens through the plugin runtime, not through direct imports. The injected runtime helpers — `outbound`, `gateway`, `binding-routing`, etc. — are wired by the plugin loader; a channel plugin sees them in its `register(api)` call and never reaches into `src/channels/**` directly. That boundary is enforced by codeql rules listed under `.github/codeql/codeql-channel-runtime-boundary-*.yml` and by the runtime test in `src/plugins/contracts/boundary-invariants.test.ts`.

## 9. Allowlists: who can talk to your agent

Even a perfectly-built channel plugin would be a security disaster without allowlists. The DM allowlist is the simplest case: a list of sender ids that may message the bot in private. The group case is messier because most channels let the agent operator either reuse the DM list or specify a separate group-only list. `mergeDmAllowFromSources` and `resolveGroupAllowFromSources` resolve those:

```typescript
// src/channels/allow-from.ts:14-41
export function mergeDmAllowFromSources(params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: Array<string | number>;
  dmPolicy?: string;
}): string[] {
  const storeEntries =
    params.dmPolicy === "allowlist" || params.dmPolicy === "open"
      ? []
      : (params.storeAllowFrom ?? []);
  return normalizeStringEntries([...(params.allowFrom ?? []), ...storeEntries]);
}

export function resolveGroupAllowFromSources(params: {
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  fallbackToAllowFrom?: boolean;
}): string[] {
  const explicitGroupAllowFrom =
    Array.isArray(params.groupAllowFrom) && params.groupAllowFrom.length > 0
      ? params.groupAllowFrom
      : undefined;
  const scoped = explicitGroupAllowFrom
    ? explicitGroupAllowFrom
    : params.fallbackToAllowFrom === false
      ? []
      : (params.allowFrom ?? []);
  return normalizeStringEntries(scoped);
}
```

A reusable named allowlist (an "access group") is supported via the `accessGroup:` prefix:

```typescript
// src/channels/allow-from.ts:3-12
export const ACCESS_GROUP_ALLOW_FROM_PREFIX = "accessGroup:";

export function parseAccessGroupAllowFromEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed.startsWith(ACCESS_GROUP_ALLOW_FROM_PREFIX)) {
    return null;
  }
  const name = trimmed.slice(ACCESS_GROUP_ALLOW_FROM_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}
```

That lets an operator define `accessGroup: ops-team` once at the top of their config and reference it across channels (`allowFrom: ["accessGroup:ops-team"]`). The matching logic is `isSenderIdAllowed` on lines 52–67 of the same file, deliberately simple: wildcard wins, explicit-id wins, empty list means "deny" unless the caller opts into "allow when empty."

The full per-channel allowlist runtime — including DM-allow state, group runtime identities, allowlist decisions, sender gating — lives one directory deeper at `src/channels/message-access/`. The public entry point is `runtime.ts`; everything else is implementation.

## 10. Ack reactions

A subtle UX problem: when the agent takes a few seconds to think, the user wonders if their message was even received. Most platforms have an emoji-reaction primitive; OpenClaw uses it for "we've got it, working on a reply." But the policy depends on chat type and operator preference, so `shouldAckReaction` returns a decision based on a small struct:

```typescript
// src/channels/ack-reactions.ts:22-49
export function shouldAckReaction(params: AckReactionGateParams): boolean {
  const scope = params.scope ?? "group-mentions";
  if (scope === "off" || scope === "none") {
    return false;
  }
  if (scope === "all") {
    return true;
  }
  if (scope === "direct") {
    return params.isDirect;
  }
  if (scope === "group-all") {
    return params.isGroup;
  }
  if (scope === "group-mentions") {
    if (!params.isMentionableGroup) {
      return false;
    }
    if (!params.requireMention) {
      return false;
    }
    if (!params.canDetectMention) {
      return false;
    }
    return params.effectiveWasMentioned || params.shouldBypassMention === true;
  }
  return false;
}
```

The default `group-mentions` is the carefully-chosen middle ground — ack only when the user actually @-mentioned the bot in a group. The lifecycle is then managed by `createAckReactionHandle` (lines 87–116) which immediately fires the send promise and returns a handle whose `remove()` is called after the real reply lands. `removeAckReactionAfterReply` (lines 118–140) only removes the reaction if the original ack actually succeeded — a forgotten `await` would leave a stray emoji on the message, which the test suite catches.

WhatsApp deserves its own variant `shouldAckReactionForWhatsApp` (lines 51–85) because it has a distinct three-mode policy (`always` | `mentions` | `never`) and the "group activated" concept where a previous turn in the group flipped the bot into actively-engaged mode.

## 11. Conversation binding

When a user types `/agent bind` in some chat to lock that conversation onto a specific agent, OpenClaw needs to record three things atomically: which channel, which account on that channel, which conversation. Plus an optional thread id. That tuple is `ConversationBindingContext`:

```typescript
// src/channels/conversation-binding-context.ts:7-13
type ConversationBindingContext = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string;
};
```

`resolveConversationBindingContext` (lines 22–41) calls `resolveCommandConversationResolution` (in `conversation-resolution.ts`) to do the heavy lifting — fold reply-to chains, peel thread ids out of the message, decide whether the binding lives on a parent conversation or a child thread — and projects the result down to the four-or-five-field tuple above. The reason it's a thin wrapper is that the resolution function also produces UI placement hints used by status renderers; the binding code doesn't need those, so it strips them with `includePlacementHint: false`.

## 12. Conversation labels

Every envelope rendered to the agent prompt needs a one-line label like `direct: Alice` or `#general (slack:T01234)`. `resolveConversationLabel` walks the priority list and picks whichever is set:

```typescript
// src/channels/conversation-label.ts:27-73 (excerpt)
export function resolveConversationLabel(ctx: MsgContext): string | undefined {
  const explicit = normalizeOptionalString(ctx.ConversationLabel);
  if (explicit) return explicit;

  const threadLabel = normalizeOptionalString(ctx.ThreadLabel);
  if (threadLabel) return threadLabel;

  const chatType = normalizeChatType(ctx.ChatType);
  if (chatType === "direct") {
    return normalizeOptionalString(ctx.SenderName) ?? normalizeOptionalString(ctx.From);
  }

  const base =
    normalizeOptionalString(ctx.GroupChannel) ||
    normalizeOptionalString(ctx.GroupSubject) ||
    normalizeOptionalString(ctx.GroupSpace) ||
    normalizeOptionalString(ctx.From) ||
    "";
  // ... append " id:<id>" when base is opaque ...
}
```

The fall-back chain — `ConversationLabel` → `ThreadLabel` → sender name (direct) → group-channel | group-subject | group-space | `From` — is what makes the label survive cross-channel binding: a Slack thread bound to a session that later receives an in-process WebChat message still renders a reasonable label, because each channel populates whichever fields it knows about and the resolver just picks the first non-empty one.

## 13. Account inspection and snapshot fields

Status commands (`openclaw channels status`) need to show "Telegram is configured but disconnected" without ever loading the bot token. The two-layer mechanism:

```typescript
// src/channels/account-inspection.ts:18-31
export async function inspectChannelAccount(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
}): Promise<unknown> {
  return (
    params.plugin.config.inspectAccount?.(params.cfg, params.accountId) ??
    (await inspectReadOnlyChannelAccount({
      channelId: params.plugin.id,
      cfg: params.cfg,
      accountId: params.accountId,
    }))
  );
}
```

Plugins may supply `inspectAccount` on the `config` adapter; if not, a read-only default scrapes whatever it can from disk without resolving secrets. `resolveInspectedChannelAccount` (lines 33–77) then reconciles two views: the *source* config (what the user wrote) and the *resolved* config (what live secrets resolved to). If the source says "configured" but the resolved view says "unavailable," the status command shows "configured_unavailable" — credentials *are* on file, but they can't be loaded right now. That's the case where `hasConfiguredUnavailableCredentialStatus` returns `true` in `src/channels/account-snapshot-fields.ts:99-107`.

The whitelist of safe fields to project into a snapshot is `projectSafeChannelAccountSnapshotFields` (lines 167–241 of the same file). Everything outside that allowlist — actual tokens, derived signing material, raw cookies — is silently dropped. URLs go through `stripUrlUserInfo` (line 233) to remove embedded basic-auth credentials. This is also where credential-source attribution (`tokenSource: "env"` vs `"keychain"` vs `"config"`) is preserved without revealing the value.

The credential-status alphabet is fixed at the top of the file:

```typescript
// src/channels/account-snapshot-fields.ts:10-16
const CREDENTIAL_STATUS_KEYS = [
  "tokenStatus",
  "botTokenStatus",
  "appTokenStatus",
  "signingSecretStatus",
  "userTokenStatus",
] as const;
```

Five named credentials with three states each (`available` / `configured_unavailable` / `missing`). Any channel plugin that wants nuanced status reporting populates whichever subset applies; Slack uses all five, Telegram uses just `botTokenStatus`, WebChat uses none.

## 14. The inbound debounce policy

Some surfaces (notably WhatsApp) emit one inbound event per line when a user types a multi-line message. To keep the agent from waking up three times for one thought, the channel layer debounces text inbound — but only when the inbound is *not* a control command:

```typescript
// src/channels/inbound-debounce-policy.ts:11-29
export function shouldDebounceTextInbound(params: {
  text: string | null | undefined;
  cfg: OpenClawConfig;
  hasMedia?: boolean;
  commandOptions?: CommandNormalizeOptions;
  allowDebounce?: boolean;
}): boolean {
  if (params.allowDebounce === false) {
    return false;
  }
  if (params.hasMedia) {
    return false;
  }
  const text = normalizeOptionalString(params.text) ?? "";
  if (!text) {
    return false;
  }
  return !isControlCommandMessage(text, params.cfg, params.commandOptions);
}
```

The shape of the debouncer itself is built in `createChannelInboundDebouncer` (lines 31–52), which resolves the per-channel debounce window from config and constructs an `InboundDebouncer` from `src/auto-reply/inbound-debounce.ts`. Default windows are channel-specific defaults in the plugin's `defaults.queue.debounceMs` (`src/channels/plugins/types.plugin.ts:63-66`); operators can override via `messages.queue.debounceMs` or per-channel config.

This deserves attention because the debounce window is one of the few places where "did the user finish typing?" is encoded numerically. Too short and the agent wakes up to half-thoughts; too long and the user thinks the bot is dead. Telegram defaults to zero; WhatsApp defaults to 600 ms; Slack to ~300 ms.

## 15. Delivery policy: typing, retries, idempotency

Three concerns the channel layer surfaces to the dispatcher but lets policies live further down (covered in Ch 11):

- **Typing indicators**. The `streaming` adapter on `ChannelPlugin` may declare typing-indicator support. The reply dispatcher consults `resolveDispatcherSilentReplyContext` in `src/auto-reply/dispatch.ts:121-143` to decide whether to send a typing event before the model starts producing. Silent-reply policy can suppress it entirely (e.g. when the message was a `room_event` and we don't want to advertise that the bot heard).
- **Retries**. The `durableFinal` adapter declares `reconcileUnknownSend` capability, which is the policy for "we sent a message but the channel never returned an ack — should we retry? assume sent? assume failed?" The reconciliation result vocabulary on `src/channels/message/types.ts:243-256` (`"sent" | "not_sent" | "unresolved"`) is what the queue uses to decide whether to schedule a retry, mark complete, or escalate to operator. Each channel implements its own reconciliation by querying its API for the platform message id.
- **Idempotency keys**. Inbound dedupe runs in `src/auto-reply/reply/inbound-dedupe.ts:56-76`. The key is `JSON.stringify([sessionScope, routeKey, messageId])` where `routeKey` is built from `channel:account:to:thread` via `channelRouteDedupeKey` in `src/plugin-sdk/channel-route.ts`. Every channel plugin gets idempotency for free as long as it populates `MessageSid` and `OriginatingChannel` on the `MsgContext`. The dispatcher checks `claimInboundDedupe(ctx)` at the top of `dispatchReplyFromConfig` (`src/auto-reply/reply/dispatch-from-config.ts:1292-1304`) and short-circuits "duplicate" and "inflight" outcomes.

## 16. The shared `ChatChannelMeta`

For UI surfaces — onboarding wizard, status commands, web control plane — every channel needs a stable description. `ChatChannelMeta` is built once at module load from the catalog data:

```typescript
// src/channels/chat-meta-shared.ts:36-55
export function buildChatChannelMetaById(): Record<ChatChannelId, ChatChannelMeta> {
  const entries = new Map<ChatChannelId, ChatChannelMeta>();

  for (const entry of listBundledChannelCatalogEntries()) {
    const rawId = normalizeOptionalString(entry.id);
    if (!rawId || !CHAT_CHANNEL_ID_SET.has(rawId)) {
      continue;
    }
    const id = rawId;
    entries.set(
      id,
      toChatChannelMeta({ id, channel: entry.channel }),
    );
  }

  return Object.freeze(Object.fromEntries(entries)) as Record<ChatChannelId, ChatChannelMeta>;
}
```

Note the second-level filter: even if the catalog contains an entry, it's only promoted to a `ChatChannelMeta` if its id is in the frozen `CHAT_CHANNEL_ID_SET`. That makes adding a new channel id a deliberate two-step act — write the catalog entry, *and* land the new id in the chat-channel order — and prevents typos from silently becoming new channels.

The user-visible side is `getChatChannelMeta(id)` in `src/channels/chat-meta.ts:12-14`. Everything in the UI reads through that single lookup; nothing reaches into the catalog directly.

## 17. Two example channels: where the contract meets reality

### 17.1 Telegram (external bundled plugin under `extensions/telegram/`)

Telegram is a long-polling HTTPS bot. Its `ChannelPlugin` implementation:

- supplies `setup` and `pairing` adapters for the bot-token flow,
- declares `outbound` and a fully-populated `message.send` adapter with `text`, `media`, `payload`, and `poll`,
- declares `message.live.capabilities.previewFinalization = true` (Telegram supports message edit within 48h),
- declares `message.receive.defaultAckPolicy = "after_receive_record"` (long-polling auto-acks),
- supplies `commands` declaring native `/start`, `/help`, `/agent`, `/cancel`, etc., mapped to the slash-command body so the gateway can recognize them,
- supplies `mentions` so group `@bot` matching is local to the plugin,
- supplies `threading` mapping Telegram's `reply_to_message` chain to the shared `ThreadingContext`.

The inbound flow: the plugin's monitor receives a Telegram update, builds the inbound-event facts (sender, conversation, message, route), and calls `buildChannelInboundEventContext`. The resulting `MsgContext` is handed to the gateway's inbound dispatcher (Ch 05). The outbound flow: `dispatch-from-config` calls into `ChannelMessageSendAdapter.text` (or `.media`, `.payload`, `.poll`) which the plugin implements as a Telegram Bot API call. The lifecycle hooks let the plugin attach the returned `message_id` to a `MessageReceipt`, which the gateway stores for later edits.

### 17.2 WebChat (internal channel served by the gateway)

WebChat has no `outbound` adapter that talks to a remote API; the gateway serves the chat UI directly over HTTP. Its `ChannelPlugin` still goes through the same registration path so that every other piece of code — allowlist matching, status reporting, model overrides, conversation binding — works without special-casing. Its `message.send` adapter simply pushes payloads into the in-memory broadcast channel that the gateway's chat WebSocket subscribes to. Its `receive` is `manual` because the gateway already knows when a message has been delivered to the connected client.

This is the load-bearing reason every internal channel still implements the full plugin contract: the rest of the system is uniform.

## 18. The boundary in practice

A quick sanity check on what does *not* leak across the boundary.

- **Channel plugins do not import from `src/channels/**`.** They go through `openclaw/plugin-sdk/*`. The codeql queries under `.github/codeql/codeql-channel-runtime-boundary-*.yml` enforce this at CI.
- **Core does not import plugin internals.** The catalog reader reaches into `package.json` for *metadata* about bundled plugins, but never imports their runtime code at module load. Plugins are loaded dynamically by `src/plugins/` based on what the config requests.
- **The discriminator vocabulary is shared, not extended per channel.** A channel cannot invent a new `InboundEventKind`. It must classify each event as `user_request` or `room_event` using the shared classifier.
- **`MsgContext` is the *only* protocol between channel and inbound pipeline.** Anything a channel wants the agent to see has to go through `buildChannelInboundEventContext` (or be added to `MsgContext` and `BuiltChannelInboundEventContext`). There is no parallel back-channel.

## 19. What this means for the inbound pipeline

By the time Chapter 05 picks up, the channel has already done a lot. It has:

1. classified the event as `user_request` or `room_event` (via `classifyChannelInboundEvent`);
2. resolved the sender against allowlists (via `mergeDmAllowFromSources` / `resolveGroupAllowFromSources` / `isSenderIdAllowed`);
3. decided whether to ack-react (via `shouldAckReaction`);
4. checked dedupe candidacy (`MessageSid` populated);
5. populated `MsgContext` with three body projections, sender facts, route facts, supplemental quote/forward/thread context, and a candidate `SessionKey`;
6. flagged whether a control command was detected (`hasControlCommand`, `CommandTurn.source`).

The inbound pipeline then turns that into an agent dispatch.

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Capability proof verification at channel registration time"><defs><marker id="r43ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Capability proofs at registration</text><rect x="40" y="40" width="200" height="50" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="140" y="58" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">Plugin declares</text><text x="140" y="74" text-anchor="middle" font-size="10" fill="#5b21b6">capabilities: { batch: true }</text><rect x="280" y="40" width="200" height="50" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="380" y="58" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">Plugin supplies</text><text x="380" y="74" text-anchor="middle" font-size="10" fill="#7c2d12">proofs: { batch: () =&gt; ... }</text><rect x="520" y="40" width="200" height="50" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="620" y="58" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">Core verifies</text><text x="620" y="74" text-anchor="middle" font-size="10" fill="#115e59">contracts.ts:94-115</text><line x1="240" y1="65" x2="280" y2="65" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r43ar)"/><line x1="480" y1="65" x2="520" y2="65" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r43ar)"/><rect x="40" y="116" width="680" height="46" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="380" y="134" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">declared without proof → throw at registration</text><text x="380" y="150" text-anchor="middle" font-size="10" fill="#78350f">"adapter declares durable final capability X without a contract proof"</text><rect x="40" y="180" width="220" height="100" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="150" y="200" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">DurableFinal</text><text x="150" y="216" text-anchor="middle" font-size="10" fill="#78350f">text · media · poll · payload</text><text x="150" y="230" text-anchor="middle" font-size="10" fill="#78350f">silent · replyTo · thread</text><text x="150" y="244" text-anchor="middle" font-size="10" fill="#78350f">nativeQuote · batch · hooks</text><text x="150" y="258" text-anchor="middle" font-size="10" fill="#78350f">reconcileUnknownSend</text><text x="150" y="272" text-anchor="middle" font-size="10" fill="#78350f">afterSendSuccess · afterCommit</text><rect x="270" y="180" width="220" height="100" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="380" y="200" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">Live</text><text x="380" y="216" text-anchor="middle" font-size="10" fill="#78350f">draftPreview</text><text x="380" y="230" text-anchor="middle" font-size="10" fill="#78350f">previewFinalization</text><text x="380" y="244" text-anchor="middle" font-size="10" fill="#78350f">progressUpdates</text><text x="380" y="258" text-anchor="middle" font-size="10" fill="#78350f">nativeStreaming</text><text x="380" y="272" text-anchor="middle" font-size="10" fill="#78350f">quietFinalization</text><rect x="500" y="180" width="220" height="100" rx="6" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/><text x="610" y="200" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">Receive ack</text><text x="610" y="216" text-anchor="middle" font-size="10" fill="#78350f">after_receive_record</text><text x="610" y="230" text-anchor="middle" font-size="10" fill="#78350f">after_agent_dispatch</text><text x="610" y="244" text-anchor="middle" font-size="10" fill="#78350f">after_durable_send</text><text x="610" y="258" text-anchor="middle" font-size="10" fill="#78350f">manual</text></svg>
<span class="figure-caption">Figure R4.3 | Three capability families — durable-final delivery, live preview, and receive ack — are declared per channel and verified at registration; missing proofs fail boot.</span>

<details><summary>ASCII original</summary>

```
plugin declares      plugin supplies         core verifies
capabilities:  ───►  proofs: { batch:  ───►  contracts.ts:94-115
{ batch: true }      () => ... }             throws on missing proof

DurableFinal              Live                    Receive ack
text · media · poll       draftPreview            after_receive_record
payload · silent          previewFinalization     after_agent_dispatch
replyTo · thread          progressUpdates         after_durable_send
nativeQuote · batch       nativeStreaming         manual
hooks · reconcile         quietFinalization
afterSendSuccess
afterCommit
```
</details>

## 20. Recap

The channel layer is, in shape:

- a small set of **shared types** — `ChatType`, `InboundEventKind`, `MsgContext`, `MessageReceipt`, `ChannelMessageSendAttemptKind`, `LiveMessagePhase` — that core code reasons about;
- a **capability bag** — `ChannelPlugin` — that each channel populates as much of as it can;
- **contract proofs** that verify each declared capability has an implementation;
- a **set of policy seams** — allowlists, ack reactions, conversation binding, conversation labels, account inspection — that hold per-channel concerns at the boundary instead of letting them seep into the agent loop;
- a **bundled catalog reader** that runs once per process, with two new caches as of `ad0d87d881` that quietly removed a chunk of cold-start latency;
- and a **plugin-sdk seam** (`src/plugin-sdk/channel-contract.ts`) that is the only sanctioned door between core and a channel plugin's runtime.

Everything beyond — how a channel actually long-polls or sockets, how it formats blocks or markdown, how it negotiates pairing — lives in the plugin and is not core's problem. Chapter 05 picks up from the moment a channel hands a built `MsgContext` to the inbound dispatcher.
