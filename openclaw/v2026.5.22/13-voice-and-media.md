# Chapter 13 — Voice and Media

Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 13.1 Four subsystems, one taxonomy

When an LLM is the brain of a multi-channel assistant, "media" is not one feature but four. OpenClaw separates them with intent:

1. **TTS (speak).** Turn assistant text into spoken audio that goes out a voice-capable channel (telephony, voice notes, the browser tab). Sources: `src/tts/`.
2. **Realtime transcription (listen).** A WebSocket-style streaming session that takes live audio and pushes partial / final transcripts into the agent. Sources: `src/realtime-transcription/`.
3. **Media understanding (interpret).** Take an image, video, or audio attachment the user sent and produce something the LLM can reason about — either by uploading it to a vision-capable provider, or by transcribing/describing it server-side first. Sources: `src/media-understanding/`, `src/media/`, `src/link-understanding/`.
4. **Media generation (produce).** Tools the agent calls to *produce* media — generated images, videos, music. Sources: `src/image-generation/`, `src/video-generation/`, `src/music-generation/`, `src/media-generation/` (the shared runtime).

These four exist because the question "should the assistant be able to handle audio?" has at least three different answers: "yes, with our own ears" (transcription), "yes, by reading lips on the server" (media understanding for audio), and "yes, by talking back" (TTS). Conflating any two would force a single implementation to make trade-offs that hurt at least one of them.

Talk — the full-duplex voice mode — composes (1) and (2) (and optionally (3)) around an agent loop. Its home is `src/talk/`.

The rest of this chapter walks each subsystem with a focus on the public seams and the design decisions that are not obvious from the source.

## 13.2 TTS: speak

### Re-exports as the public surface

If you grep for `tts.synthesizeSpeech` you'll find the call. If you then read `src/tts/tts.ts` you'll find a one-screen file that does only re-exports:

```ts
// src/tts/tts.ts (commit a374c3a5bf, full file)
export {
  testApi as _test,
  testApi,
  buildTtsSystemPromptHint,
  getLastTtsAttempt,
  getResolvedSpeechProviderConfig,
  getTtsMaxLength,
  getTtsPersona,
  getTtsProvider,
  isSummarizationEnabled,
  isTtsEnabled,
  isTtsProviderConfigured,
  listSpeechVoices,
  listTtsPersonas,
  maybeApplyTtsToPayload,
  resolveExplicitTtsOverrides,
  resolveTtsAutoMode,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  resolveTtsProviderOrder,
  setLastTtsAttempt,
  setSummarizationEnabled,
  setTtsAutoMode,
  setTtsEnabled,
  setTtsMaxLength,
  setTtsPersona,
  setTtsProvider,
  synthesizeSpeech,
  streamSpeech,
  textToSpeech,
  textToSpeechStream,
  textToSpeechTelephony,
  type ResolvedTtsConfig,
  type ResolvedTtsModelOverrides,
  type TtsDirectiveOverrides,
  type TtsDirectiveParseResult,
  type TtsResult,
  type TtsSynthesisResult,
  type TtsSynthesisStreamResult,
  type TtsStreamResult,
  type TtsTelephonyResult,
} from "../plugin-sdk/tts-runtime.js";
```

The implementation lives in `src/plugin-sdk/tts-runtime.js` (a generated alias of `src/plugin-sdk/tts-runtime.ts`). Why the indirection? Because *plug-ins* — third-party packages that drop into OpenClaw — want a stable public surface, and `openclaw/plugin-sdk/tts-runtime` is the contract. The internal modules under `src/tts/` may move and refactor; the SDK alias stays. This same pattern recurs across the codebase (`src/plugin-sdk/provider-http`, `src/plugin-sdk/secret-input`, …).

### The resolved configuration

The shape every TTS call resolves to is `ResolvedTtsConfig` (`src/tts/tts-types.ts:3-28`):

```ts
export type ResolvedTtsConfig = {
  auto: TtsAutoMode;
  mode: TtsMode;
  provider: TtsProvider;
  providerSource: "config" | "default";
  persona?: string;
  personas: Record<string, ResolvedTtsPersona>;
  summaryModel?: string;
  modelOverrides: ResolvedTtsModelOverrides;
  providerConfigs: Record<string, SpeechProviderConfig>;
  prefsPath?: string;
  maxTextLength: number;
  timeoutMs: number;
  timeoutMsSource?: "config" | "default";
  rawConfig?: TtsConfig;
  sourceConfig?: OpenClawConfig;
};
```

Three fields are subtle:

- **`auto`** decides whether the agent's reply should be spoken automatically (always / never / by-channel-policy). The normalizer is `normalizeTtsAutoMode` in `src/tts/tts-auto-mode.ts`.
- **`persona` + `personas`** capture voice styling. A persona is a named bundle of `{ provider, voice, voiceSettings, voiceCompatibleResponseFormats, … }`. The agent (or the channel) picks a persona by name and the runtime resolves it.
- **`modelOverrides`** is a policy object (see below).

### The override policy

A naive design would say "let agents override TTS settings on the fly" (`provider`, `voice`, `text`). The actual policy (`src/tts/provider-types.ts:11-20`) is a boolean *allow-list*:

```ts
export type SpeechModelOverridePolicy = {
  enabled: boolean;
  allowText: boolean;
  allowProvider: boolean;
  allowVoice: boolean;
  allowModelId: boolean;
  allowVoiceSettings: boolean;
  allowNormalization: boolean;
  allowSeed: boolean;
};
```

Why this fine-grained: an operator might trust the agent to *rephrase* the TTS text (allowing `allowText: true`) but not to *switch providers* (`allowProvider: false`), because providers cost different money. The override policy is enforced at directive parse time (`src/tts/directives.ts`) so the agent cannot smuggle changes past it.

### TTS directives in assistant text

Agents emit directives inline in their text — small markers the TTS layer notices and removes before the text becomes voice. `parseTtsDirective` (in `src/tts/directives.ts`) returns:

```ts
export type TtsDirectiveParseResult = {
  cleanedText: string;
  ttsText?: string;
  hasDirective: boolean;
  overrides: TtsDirectiveOverrides;
  warnings: string[];
};
```

`cleanedText` is what the user reads in chat. `ttsText`, if present, is what the speaker should hear (so the agent can write "**Important:** the deal is closed" in chat and have TTS say "Important — the deal is closed" without the bold marks). The directive parser also extracts provider override hints, but only fields the policy allows; rejected overrides surface as `warnings`.

### Providers: registry + plug-in capability

TTS speaks via *speech providers*. The registry is loaded as a plug-in capability (`src/tts/provider-registry.ts:14-32`):

```ts
function resolveSpeechProviderPluginEntries(cfg?: OpenClawConfig): SpeechProviderPlugin[] {
  return resolvePluginCapabilityProviders({
    key: "speechProviders",
    cfg,
  });
}

function resolveLoadedSpeechProviderPluginEntries(): SpeechProviderPlugin[] {
  return (getActiveRuntimePluginRegistry()?.speechProviders ?? []).map((entry) => entry.provider);
}

const defaultSpeechProviderRegistryResolver: SpeechProviderRegistryResolver = {
  getProvider: (providerId, cfg) =>
    resolvePluginCapabilityProvider({
      key: "speechProviders",
      providerId,
      cfg,
    }),
  listProviders: resolveSpeechProviderPluginEntries,
};
```

This is the same plug-in-registry pattern used everywhere else in the codebase (Chapter 06 — Plug-ins): the core `src/` does not enumerate "openai", "elevenlabs", "azure" by name. Each provider is a plug-in. The OpenAI-compatible base class is in `src/tts/openai-compatible-speech-provider.ts`; concrete providers register themselves via the plug-in capability map (`speechProviders`) and are reachable by id.

The OpenAI-compatible adapter takes a wide options object (`src/tts/openai-compatible-speech-provider.ts:42-60`):

```ts
export type OpenAiCompatibleSpeechProviderOptions<
  ExtraConfig extends Record<string, unknown> = Record<string, never>,
> = {
  id: string;
  label: string;
  autoSelectOrder: number;
  models: readonly string[];
  voices: readonly string[];
  defaultModel: string;
  defaultVoice: string;
  defaultBaseUrl: string;
  envKey: string;
  responseFormats: readonly string[];
  defaultResponseFormat: string;
  voiceCompatibleResponseFormats: readonly string[];
  baseUrlPolicy?: OpenAiCompatibleSpeechProviderBaseUrlPolicy;
  /* … */
};
```

`autoSelectOrder` is what picks the default provider when more than one is configured — the smallest non-undefined wins. This is the *only* implicit policy; everything else is explicit per call.

### Local TTS on macOS — `apps/macos-mlx-tts`

The cloud round-trip is slow. For users on Apple Silicon, OpenClaw ships a *helper binary* that runs the MLX-Audio TTS model locally. Read `apps/macos-mlx-tts/Sources/OpenClawMLXTTSHelper/main.swift:1-26`:

```swift
import Foundation
import MLXAudioTTS

@main
enum OpenClawMLXTTSHelper {
    static func main() async {
        do {
            let options = try Options.parse(CommandLine.arguments.dropFirst())
            let data = try await synthesize(options)
            try data.write(to: options.outputURL, options: [.atomic])
        } catch {
            FileHandle.standardError.write(Data("openclaw-mlx-tts: \(error)\n".utf8))
            exit(1)
        }
    }

    private static func synthesize(_ options: Options) async throws -> Data {
        let model = try await TTS.loadModel(modelRepo: options.modelRepo)
        let audio = try await UncheckedSpeechModel(raw: model).generateAudio(
            text: options.text,
            voice: options.voice,
            language: options.language)
        return makeWavData(samples: audio, sampleRate: Double(model.sampleRate))
    }
}
```

A Swift CLI: takes `--text` and `--output`, loads `mlx-community/Soprano-80M-bf16` (the default), generates WAV samples, writes the file atomically. The gateway invokes this via `runExec` exactly like any other external tool; a corresponding speech provider plug-in wraps the binary path. The benefit is *no network*, *no per-second cost*, and very low latency on capable hardware. The cost is that it only works on macOS with the MLX runtime installed. The split — cloud as default, local as a registered provider when the binary is present — keeps the platform-neutral core platform-neutral.

## 13.3 Realtime transcription: listen

The transcription subsystem is the leanest of the four. The provider interface fits on one screen (`src/realtime-transcription/provider-types.ts:1-34`):

```ts
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type RealtimeTranscriptionProviderId = string;

export type RealtimeTranscriptionProviderConfig = Record<string, unknown>;

export type RealtimeTranscriptionSessionCallbacks = {
  onPartial?: (partial: string) => void;
  onTranscript?: (transcript: string) => void;
  onSpeechStart?: () => void;
  onError?: (error: Error) => void;
};

export type RealtimeTranscriptionSessionCreateRequest = RealtimeTranscriptionSessionCallbacks & {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeTranscriptionProviderConfig;
};

export type RealtimeTranscriptionSession = {
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  close(): void;
  isConnected(): boolean;
};
```

A *transcription session* is an object you `connect()`, `sendAudio(buffer)` to, and `close()`. While it's alive, four callbacks fire:

- `onSpeechStart` — heard speech (used for barge-in detection in Talk).
- `onPartial(text)` — an evolving partial transcript; the agent may show it to the user but not yet treat it as final.
- `onTranscript(text)` — a final segment; this is what the agent reasons on.
- `onError(err)` — a fatal session error; the caller closes.

Final and partial are deliberately separated. A common design mistake is to unify them with a "is_final" flag, which forces every consumer to handle both states. With two callbacks, code that only cares about finals (e.g., the agent loop) ignores `onPartial` entirely.

### The WebSocket transport helper

Most providers want a long-lived WebSocket. Rather than each plug-in implementing reconnection, queueing, and timeout handling, `src/realtime-transcription/websocket-session.ts` is a shared transport (`src/realtime-transcription/websocket-session.ts:11-22`):

```ts
export type RealtimeTranscriptionWebSocketTransport = {
  readonly callbacks: RealtimeTranscriptionSessionCallbacks;
  closeNow(): void;
  failConnect(error: Error): void;
  isOpen(): boolean;
  isReady(): boolean;
  markReady(): void;
  sendBinary(payload: Buffer): boolean;
  sendJson(payload: unknown): boolean;
};
```

Providers extend this by supplying `parseMessage` (provider-specific JSON shape), `sendAudio` (which knows whether the provider expects raw PCM, base64 JSON, or framed), and event handlers. The defaults are sensible: 10-second connect timeout, 5-second close timeout, five reconnect attempts with one-second base delay, and a 2 MB queue for audio buffered before the WebSocket is ready (`src/realtime-transcription/websocket-session.ts:45-49`):

```ts
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_DELAY_MS = 1000;
const DEFAULT_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
```

The 2 MB bound exists because, otherwise, a user holding the mic button while the provider is unreachable would eventually OOM the gateway. With a bound, dropped audio is preferable to a crashed process.

The transport also integrates with the debug-proxy capture (`createDebugProxyWebSocketAgent` / `captureWsEvent` from `src/proxy-capture/`), so operators debugging audio issues can record provider traffic for later replay.

## 13.4 Talk: full-duplex orchestration

Talk is the meta-feature. It combines mic capture, transcription, an agent loop, and TTS playback into a single duplex experience. It does **not** "do" transcription or TTS itself — it routes audio between four kinds of components.

### Modes and transports

The mode and transport types are declared in `src/talk/talk-events.ts:34-43`:

```ts
export type TalkMode = "realtime" | "stt-tts" | "transcription";

export type TalkTransport = "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";

export type TalkBrain = "agent-consult" | "direct-tools" | "none";

export type TalkEventContext = {
  sessionId: string;
  mode: TalkMode;
  transport: TalkTransport;
  brain: TalkBrain;
  provider?: string;
};
```

Three orthogonal axes:

- **Mode.** `realtime` uses a provider that handles audio in/out end-to-end (OpenAI Realtime, Google Live). `stt-tts` is the build-it-yourself path: transcribe with one provider, run the agent loop, synthesise with another. `transcription` is one-way listening.
- **Transport.** `webrtc` and `provider-websocket` connect the *client* directly to the provider. `gateway-relay` routes audio through OpenClaw (so the gateway holds the provider key). `managed-room` is the rendezvous-room variant for multi-party calls.
- **Brain.** `agent-consult` runs the full agent loop on top of the realtime session via a "consult" tool. `direct-tools` exposes the realtime provider's own tool-calling. `none` is pure transcript pass-through.

The reason for orthogonality is that almost every combination is valid for *some* deployment. Splitting the dimensions in the type system enables the runtime to dispatch correctly without if-trees.

### The event stream

A Talk session emits events from a 28-entry vocabulary (`src/talk/talk-events.ts:1-32`):

```ts
export const TALK_EVENT_TYPES = [
  "session.started",
  "session.ready",
  "session.closed",
  "session.error",
  "session.replaced",
  "turn.started",
  "turn.ended",
  "turn.cancelled",
  "capture.started",
  "capture.stopped",
  "capture.cancelled",
  "capture.once",
  "input.audio.delta",
  "input.audio.committed",
  "transcript.delta",
  "transcript.done",
  "output.text.delta",
  "output.text.done",
  "output.audio.started",
  "output.audio.delta",
  "output.audio.done",
  "tool.call",
  "tool.progress",
  "tool.result",
  "tool.error",
  "usage.metrics",
  "latency.metrics",
  "health.changed",
] as const;
```

Read it as four phases:

1. **Session lifecycle** — `started`, `ready`, `closed`, `error`, `replaced` (the latter when the operator restarts mid-call).
2. **Turn lifecycle** — a turn is one user-utterance plus the agent's response. `turn.started` / `turn.ended` / `turn.cancelled` mark the boundary; `capture.*` reports the mic state during the turn.
3. **Stream deltas** — `input.audio.delta`, `transcript.delta`, `output.text.delta`, `output.audio.delta`. These are the per-chunk events used by the UI to render in real time.
4. **Tools and metrics** — `tool.call` / `tool.result` / `tool.error` / `tool.progress`, plus `usage.metrics`, `latency.metrics`, and `health.changed`.

Each event carries `seq` (monotonic), `timestamp` (ISO), optional `turnId`, `captureId`, `callId`, `itemId`, `parentId`, and a typed `payload`. This vocabulary is durable: it's recorded by `src/talk/session-log-runtime.ts` for diagnostics and surfaced by the UI's `talk.event` gateway frame (Chapter 12 §12.9).

### The session controller

`src/talk/talk-session-controller.ts` is the small state machine that owns "what turn is active right now?". The interface (`src/talk/talk-session-controller.ts:22-45`):

```ts
export type TalkSessionController = {
  readonly activeTurnId: string | undefined;
  readonly context: TalkEventContext;
  readonly outputAudioActive: boolean;
  readonly recentEvents: readonly TalkEvent[];
  clearActiveTurn(): void;
  emit<TPayload>(input: TalkEventInput<TPayload>): TalkEvent<TPayload>;
  ensureTurn(params?: { payload?: unknown; turnId?: string }): TalkEnsureTurnResult;
  startTurn(params?: { payload?: unknown; turnId?: string }): TalkEnsureTurnResult;
  endTurn(params?: { payload?: unknown; turnId?: string }): TalkTurnResult;
  cancelTurn(params?: { payload?: unknown; turnId?: string }): TalkTurnResult;
  finishOutputAudio(params?: { payload?: unknown; turnId?: string }): TalkEvent | undefined;
  startOutputAudio(params?: { payload?: unknown; turnId?: string }): TalkEnsureTurnResult;
};
```

`ensureTurn` is the most-used method: it either returns the active turn id or starts a new one and returns that. The pattern protects against races where an audio packet arrives before `turn.started`. `startTurn` is unconditional; `endTurn` / `cancelTurn` succeed only if the supplied id matches the active turn (otherwise return `{ ok: false, reason: "stale_turn" }`), which prevents an out-of-date provider callback from ending a fresh turn.

### Bridges to provider runtimes

The actual provider session is the `RealtimeVoiceBridge`. The factory is in `src/talk/session-runtime.ts:26-38`:

```ts
export type RealtimeVoiceBridgeSession = {
  bridge: RealtimeVoiceBridge;
  acknowledgeMark(): void;
  close(): void;
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  sendUserMessage(text: string): void;
  handleBargeIn(options?: RealtimeVoiceBargeInOptions): void;
  setMediaTimestamp(ts: number): void;
  submitToolResult(callId: string, result: unknown, options?: RealtimeVoiceToolResultOptions): void;
  triggerGreeting(instructions?: string): void;
};
```

`handleBargeIn` is the user interrupting the assistant: when the mic detects speech while output audio is still playing, the bridge tells the provider to cancel the in-flight response. This is non-trivial because some providers buffer hundreds of milliseconds of TTS ahead — the bridge issues an *audio clear* in addition to a cancel.

`setMediaTimestamp` propagates the receiver's playback clock back to the provider so it can compute drift and adjust. Without this, server-side cancellation latency snowballs.

### Talkback debouncing

When the assistant is *also* a chat agent (e.g., a Pi-style chat) and the user is on a phone call, you don't want every short utterance to spin up a full Pi consult. `src/talk/agent-talkback-runtime.ts:5-30` implements a debounced talkback queue:

```ts
export type RealtimeVoiceAgentTalkbackQueueParams = {
  debounceMs: number;
  isStopped: () => boolean;
  logger: Pick<RuntimeLogger, "info" | "warn">;
  logPrefix: string;
  responseStyle: string;
  fallbackText: string;
  consult: (args: {
    question: string;
    metadata?: unknown;
    responseStyle: string;
    signal: AbortSignal;
  }) => Promise<RealtimeVoiceAgentTalkbackResult>;
  deliver: (text: string) => void;
};
```

The queue collects question utterances for `debounceMs` and then runs *one* consult with the concatenated text, cancelling earlier in-flight consults via `AbortSignal`. The `fallbackText` is what gets delivered if the consult fails — so the call doesn't go silent on a transient error.

<svg viewBox="0 0 920 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Voice loop from mic to speaker">
<rect x="20" y="20" width="160" height="80" rx="8" fill="#fed7aa" stroke="#ea580c"/>
<text x="100" y="48" text-anchor="middle" font-size="14" font-weight="700" fill="#7c2d12">Microphone</text>
<text x="100" y="68" text-anchor="middle" font-size="11" fill="currentColor">browser tab,</text>
<text x="100" y="84" text-anchor="middle" font-size="11" fill="currentColor">telephony, mobile</text>
<rect x="220" y="20" width="180" height="80" rx="8" fill="#99f6e4" stroke="#0d9488"/>
<text x="310" y="48" text-anchor="middle" font-size="14" font-weight="700" fill="#134e4a">Realtime transcription</text>
<text x="310" y="68" text-anchor="middle" font-size="11" fill="currentColor">src/realtime-transcription/</text>
<text x="310" y="84" text-anchor="middle" font-size="11" fill="currentColor">onPartial / onTranscript</text>
<rect x="440" y="20" width="180" height="80" rx="8" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="530" y="48" text-anchor="middle" font-size="14" font-weight="700" fill="#3b0764">Talk session controller</text>
<text x="530" y="68" text-anchor="middle" font-size="11" fill="currentColor">src/talk/</text>
<text x="530" y="84" text-anchor="middle" font-size="11" fill="currentColor">turns + events + brain</text>
<rect x="660" y="20" width="160" height="80" rx="8" fill="#fee2e2" stroke="#dc2626"/>
<text x="740" y="48" text-anchor="middle" font-size="14" font-weight="700" fill="#7f1d1d">Agent loop</text>
<text x="740" y="68" text-anchor="middle" font-size="11" fill="currentColor">Chapter 04</text>
<text x="740" y="84" text-anchor="middle" font-size="11" fill="currentColor">tools + LLM</text>
<line x1="180" y1="60" x2="220" y2="60" stroke="#64748b" stroke-width="2" marker-end="url(#arr)"/>
<line x1="400" y1="60" x2="440" y2="60" stroke="#64748b" stroke-width="2" marker-end="url(#arr)"/>
<line x1="620" y1="60" x2="660" y2="60" stroke="#64748b" stroke-width="2" marker-end="url(#arr)"/>
<rect x="660" y="180" width="160" height="80" rx="8" fill="#fed7aa" stroke="#ea580c"/>
<text x="740" y="208" text-anchor="middle" font-size="14" font-weight="700" fill="#7c2d12">TTS</text>
<text x="740" y="228" text-anchor="middle" font-size="11" fill="currentColor">src/tts/</text>
<text x="740" y="244" text-anchor="middle" font-size="11" fill="currentColor">synthesise (stream)</text>
<rect x="440" y="180" width="180" height="80" rx="8" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="530" y="208" text-anchor="middle" font-size="14" font-weight="700" fill="#3b0764">Audio sink + bridge</text>
<text x="530" y="228" text-anchor="middle" font-size="11" fill="currentColor">session-runtime.ts</text>
<text x="530" y="244" text-anchor="middle" font-size="11" fill="currentColor">marks + barge-in</text>
<rect x="220" y="180" width="180" height="80" rx="8" fill="#bae6fd" stroke="#0ea5e9"/>
<text x="310" y="208" text-anchor="middle" font-size="14" font-weight="700" fill="#075985">Transport</text>
<text x="310" y="228" text-anchor="middle" font-size="11" fill="currentColor">webrtc / ws / relay</text>
<text x="310" y="244" text-anchor="middle" font-size="11" fill="currentColor">/ managed-room</text>
<rect x="20" y="180" width="160" height="80" rx="8" fill="#fed7aa" stroke="#ea580c"/>
<text x="100" y="208" text-anchor="middle" font-size="14" font-weight="700" fill="#7c2d12">Speaker</text>
<text x="100" y="228" text-anchor="middle" font-size="11" fill="currentColor">browser tab,</text>
<text x="100" y="244" text-anchor="middle" font-size="11" fill="currentColor">telephony, mobile</text>
<line x1="660" y1="220" x2="620" y2="220" stroke="#64748b" stroke-width="2" marker-end="url(#arr)"/>
<line x1="440" y1="220" x2="400" y2="220" stroke="#64748b" stroke-width="2" marker-end="url(#arr)"/>
<line x1="220" y1="220" x2="180" y2="220" stroke="#64748b" stroke-width="2" marker-end="url(#arr)"/>
<line x1="740" y1="100" x2="740" y2="180" stroke="#7c3aed" stroke-width="2" stroke-dasharray="6 4" marker-end="url(#arr)"/>
<text x="450" y="320" text-anchor="middle" font-size="12" fill="#64748b">Realtime mode: a single provider runs steps 2–4 internally; gateway relays events.</text>
<text x="450" y="340" text-anchor="middle" font-size="12" fill="#64748b">stt-tts mode: each box is a separate provider; the bridge composes them.</text>
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="#64748b"/></marker></defs>
</svg>
<span class="figure-caption">Figure R13.1 | The voice loop: in stt-tts mode each box is a separate component; in realtime mode the provider collapses transcription and TTS into one socket.</span>
<details><summary>ASCII original</summary>

```
mic -> transcription -> talk session controller -> agent loop
                                                       |
speaker <- transport <- audio sink/bridge <- TTS <-----+
```
</details>

## 13.5 Media understanding: interpret

When the user sends an image attached to a chat message, the gateway has two options:

1. **Native multimodal.** If the active model accepts image input (Claude, GPT-4o, Gemini, etc.), forward the image bytes as a content block in the prompt; the model "sees" it.
2. **Server-side description.** Otherwise, run a dedicated vision model first to produce a text description, then include the description in the prompt.

Both paths must apply size limits, MIME sanitisation, SSRF guards for URL-fetched media, transcription for audio, frame extraction for video, and policy checks for who is allowed to upload what. `src/media-understanding/` and `src/media/` together implement this.

### The decision tree

`src/media-understanding/runner.ts` is the dispatch core (`runCapability(capability, attachments, …)`). The capability is one of `image` / `audio` / `video`. For each attachment it builds a `MediaUnderstandingDecision` describing the outcome — `applied`, `skipped`, `failed` — with a `reason` (e.g., "no_provider_model_configured", "attachment_too_small", "scope_denied").

The reason vocabulary is canonical: every skip or failure has a single source of truth in `runner.entries.ts`, and `formatDecisionSummary` turns the structured decision into a human-readable line for logs.

The dispatcher's most subtle piece is *provider ordering*. The naive design hard-codes "use OpenAI Vision for images, Deepgram for audio". The actual logic (`src/media-understanding/runner.ts:93-113`):

```ts
function resolveConfiguredKeyProviderOrder(params: {
  cfg: OpenClawConfig;
  providerRegistry: ProviderRegistry;
  capability: MediaUnderstandingCapability;
  fallbackProviders: readonly string[];
}): string[] {
  const configuredProviders = Object.keys(params.cfg.models?.providers ?? {})
    .map((providerId) => normalizeMediaExecutionProviderId(providerId))
    .filter(Boolean)
    .filter((providerId, index, values) => values.indexOf(providerId) === index)
    .filter((providerId) =>
      providerSupportsCapability(
        params.providerRegistry.get(normalizeMediaProviderId(providerId)),
        params.capability,
      ),
    );

  return [...new Set([...configuredProviders, ...params.fallbackProviders])];
}
```

The order is: *user-configured providers first* (preserving the order they appear in `models.providers`), then a built-in fallback list. So if you have OpenAI and Anthropic configured, and Anthropic happens to be listed first, OpenClaw will try Anthropic first even if the fallback list has OpenAI first. This is a small but important UX detail: configuration *is* preference.

### The apply step

`src/media-understanding/apply.ts` exposes `applyMediaUnderstanding(...)` (re-exported through `apply.runtime.ts` as a one-liner: `export { applyMediaUnderstanding } from "./apply.js";`). The function processes attachments in a fixed capability order:

```ts
// src/media-understanding/apply.ts:48-54
const CAPABILITY_ORDER: MediaUnderstandingCapability[] = ["image", "audio", "video"];
const EMPTY_VOICE_NOTE_PLACEHOLDER =
  "[Voice note could not be transcribed because the audio attachment was too small]";
```

Three notable choices:

1. **Capability order is fixed**, not parameterised. Images first because they're the most common; audio second; video last because it's the slowest.
2. **Empty voice notes get a placeholder.** When a transcription returns nothing (e.g., the audio is below the provider's minimum length), the user's message still has a visible marker so the agent doesn't silently drop context.
3. **External content is wrapped.** The function imports `wrapExternalContent` from `src/security/external-content.ts` — every transcribed/described attachment is tagged so the LLM treats it as third-party content. This is the same prompt-injection guard used elsewhere in the codebase.

### MIME sanitisation

Image and audio attachments arrive with MIME types from channel SDKs that are not always trustworthy. The sanitiser is in `src/media-understanding/apply.ts:81-92`:

```ts
const MIME_TYPE = String.raw`([a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+)`;
const HTTP_TOKEN = String.raw`[a-z0-9!#$%&'*+.^_\x60|~-]+`;
const HTTP_QUOTED_STRING = String.raw`"(?:[\t !#-\[\]-~]|\\[\t -~])*"`;
const MIME_PARAMETER = String.raw`[ \t]*;[ \t]*${HTTP_TOKEN}=(?:${HTTP_TOKEN}|${HTTP_QUOTED_STRING})`;
const MIME_TYPE_WITH_OPTIONAL_PARAMS = new RegExp(
  String.raw`^${MIME_TYPE}(?:${MIME_PARAMETER})*$`,
  "i",
);

export function sanitizeMimeType(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(MIME_TYPE_WITH_OPTIONAL_PARAMS);
  return match?.[1]?.toLowerCase();
}
```

This regex is precisely RFC 9110 §8.3 (Content-Type with optional parameters): it parses the `type/subtype` and discards any trailing `;param=value` parameters. The point is not to lose information but to *normalise* — every downstream consumer sees `image/png`, never `IMAGE/PNG; charset=binary, oops`. The dedicated test file `apply.sanitize-mime.test.ts` proves it on weird inputs.

### Image understanding: native vs synthetic

For images, `src/media-understanding/image.ts` runs a vision model. It interoperates with two LLM SDKs (pi-ai and minimax-vlm) and handles a subtle case (`src/media-understanding/image.ts:88-118`): some providers' "reasoning" mode returns *only* reasoning tokens and no user-visible text. The helper `isImageModelNoTextError` detects this and retries with reasoning disabled:

```ts
function isImageModelNoTextError(err: unknown): boolean {
  return err instanceof Error && /^Image model returned no text\b/.test(err.message);
}

function disableReasoningForImageRetryPayload(payload: unknown, model: Model<Api>): unknown {
  if (!isRecord(payload)) {
    return undefined;
  }
  const next = { ...payload };
  delete next.reasoning;
  delete next.reasoning_effort;

  const include = removeReasoningInclude(next.include);
  if (include === undefined) {
    delete next.include;
  } else {
    next.include = include;
  }

  if (isNativeResponsesReasoningPayload(model)) {
    next.reasoning = { effort: "none" };
  }
  return next;
}
```

This is the kind of provider-quirk handling that *should* be in the runtime, not in user agents: agents see "image was understood" and never know about the retry.

### Link understanding — a different beast

URLs in messages are handled by `src/link-understanding/`, which is *not* part of media understanding but lives next door. `src/link-understanding/runner.ts:1-25` shows the integration:

```ts
import type { MsgContext } from "../auto-reply/templating.js";
import { applyTemplate } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { LinkModelConfig, LinkToolsConfig } from "../config/types.tools.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { fetchWithSsrFGuard, GUARDED_FETCH_MODE } from "../infra/net/fetch-guard.js";
import { CLI_OUTPUT_MAX_BUFFER } from "../media-understanding/defaults.js";
import { resolveTimeoutMs } from "../media-understanding/resolve.js";
import {
  normalizeMediaUnderstandingChatType,
  resolveMediaUnderstandingScope,
} from "../media-understanding/scope.js";
import { readResponseWithLimit } from "../media/read-response-with-limit.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { DEFAULT_LINK_TIMEOUT_SECONDS } from "./defaults.js";
import { extractLinksFromMessage } from "./detect.js";
```

Three reused primitives jump out: the same `fetchWithSsrFGuard` (so a malicious URL can't redirect into the gateway's loopback), the same `resolveMediaUnderstandingScope` (so the operator's policy applies uniformly), and `runCommandWithTimeout` (so external fetchers like `curl` or `wget` cannot hang forever). Link understanding shares plumbing with media understanding but operates on URLs rather than file attachments.

<svg viewBox="0 0 920 410" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Media understanding pipeline">
<rect x="20" y="20" width="180" height="60" rx="8" fill="#fed7aa" stroke="#ea580c"/>
<text x="110" y="46" text-anchor="middle" font-size="14" font-weight="700" fill="#7c2d12">Inbound message</text>
<text x="110" y="65" text-anchor="middle" font-size="11" fill="currentColor">attachment(s) + text</text>
<rect x="240" y="20" width="200" height="60" rx="8" fill="#99f6e4" stroke="#0d9488"/>
<text x="340" y="46" text-anchor="middle" font-size="14" font-weight="700" fill="#134e4a">normalize + sanitize</text>
<text x="340" y="65" text-anchor="middle" font-size="11" fill="currentColor">attachments.normalize / mime</text>
<rect x="480" y="20" width="180" height="60" rx="8" fill="#99f6e4" stroke="#0d9488"/>
<text x="570" y="46" text-anchor="middle" font-size="14" font-weight="700" fill="#134e4a">scope decision</text>
<text x="570" y="65" text-anchor="middle" font-size="11" fill="currentColor">scope.ts (allow/deny)</text>
<rect x="700" y="20" width="200" height="60" rx="8" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="800" y="46" text-anchor="middle" font-size="14" font-weight="700" fill="#3b0764">capability dispatch</text>
<text x="800" y="65" text-anchor="middle" font-size="11" fill="currentColor">image | audio | video</text>
<line x1="200" y1="50" x2="240" y2="50" stroke="#64748b" stroke-width="2" marker-end="url(#arr2)"/>
<line x1="440" y1="50" x2="480" y2="50" stroke="#64748b" stroke-width="2" marker-end="url(#arr2)"/>
<line x1="660" y1="50" x2="700" y2="50" stroke="#64748b" stroke-width="2" marker-end="url(#arr2)"/>
<rect x="20" y="120" width="220" height="100" rx="8" fill="#bae6fd" stroke="#0ea5e9"/>
<text x="130" y="148" text-anchor="middle" font-size="13" font-weight="700" fill="#075985">Image path</text>
<text x="130" y="170" text-anchor="middle" font-size="11" fill="currentColor">describeImageWithModel()</text>
<text x="130" y="186" text-anchor="middle" font-size="11" fill="currentColor">retry-without-reasoning</text>
<text x="130" y="202" text-anchor="middle" font-size="11" fill="currentColor">minimax / pi-ai SDKs</text>
<rect x="260" y="120" width="220" height="100" rx="8" fill="#bae6fd" stroke="#0ea5e9"/>
<text x="370" y="148" text-anchor="middle" font-size="13" font-weight="700" fill="#075985">Audio path</text>
<text x="370" y="170" text-anchor="middle" font-size="11" fill="currentColor">audio-preflight.ts</text>
<text x="370" y="186" text-anchor="middle" font-size="11" fill="currentColor">audio-transcription-runner</text>
<text x="370" y="202" text-anchor="middle" font-size="11" fill="currentColor">echo-transcript (opt)</text>
<rect x="500" y="120" width="220" height="100" rx="8" fill="#bae6fd" stroke="#0ea5e9"/>
<text x="610" y="148" text-anchor="middle" font-size="13" font-weight="700" fill="#075985">Video path</text>
<text x="610" y="170" text-anchor="middle" font-size="11" fill="currentColor">video.ts</text>
<text x="610" y="186" text-anchor="middle" font-size="11" fill="currentColor">frame extract + describe</text>
<text x="610" y="202" text-anchor="middle" font-size="11" fill="currentColor">openai-compatible-video</text>
<rect x="740" y="120" width="160" height="100" rx="8" fill="#fee2e2" stroke="#dc2626"/>
<text x="820" y="148" text-anchor="middle" font-size="13" font-weight="700" fill="#7f1d1d">Skip</text>
<text x="820" y="170" text-anchor="middle" font-size="11" fill="currentColor">policy denied,</text>
<text x="820" y="186" text-anchor="middle" font-size="11" fill="currentColor">too small,</text>
<text x="820" y="202" text-anchor="middle" font-size="11" fill="currentColor">no provider model</text>
<rect x="160" y="260" width="600" height="80" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="460" y="288" text-anchor="middle" font-size="14" font-weight="700" fill="#78350f">wrapExternalContent() + formatMediaUnderstandingBody()</text>
<text x="460" y="310" text-anchor="middle" font-size="11" fill="currentColor">prompt-injection guarded</text>
<text x="460" y="326" text-anchor="middle" font-size="11" fill="currentColor">appended to user message as a content block</text>
<line x1="130" y1="220" x2="430" y2="260" stroke="#64748b" stroke-width="2"/>
<line x1="370" y1="220" x2="460" y2="260" stroke="#64748b" stroke-width="2"/>
<line x1="610" y1="220" x2="490" y2="260" stroke="#64748b" stroke-width="2"/>
<text x="460" y="380" text-anchor="middle" font-size="12" fill="#64748b">Each capability has its own runner, but they share scope/limit logic and the wrapping step.</text>
<defs><marker id="arr2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="#64748b"/></marker></defs>
</svg>
<span class="figure-caption">Figure R13.2 | Media understanding pipeline — attachments are normalised, then dispatched to a per-capability runner, then wrapped as third-party content before joining the prompt.</span>
<details><summary>ASCII original</summary>

```
attachment -> normalize+sanitize -> scope decision -> dispatch(image|audio|video)
                                                          |
                                                          v
                                              capability-specific runner
                                                          |
                                                          v
                            wrapExternalContent + formatMediaUnderstandingBody
                                                          |
                                                          v
                                              content block appended to prompt
```
</details>

## 13.6 Media generation: produce

Where understanding *consumes* media, generation *produces* it. There are three concrete subsystems (image, video, music) plus a shared runtime (`src/media-generation/`) that they all build on.

### Common shape

Every generation provider exposes a `generateXxx(params, deps) => GenerateXxxRuntimeResult` function. For images (`src/image-generation/runtime.ts:51-62`):

```ts
export async function generateImage(
  params: GenerateImageParams,
  deps: ImageGenerationRuntimeDeps = {},
): Promise<GenerateImageRuntimeResult> {
  const getProvider = deps.getProvider ?? getImageGenerationProvider;
  const listProviders = deps.listProviders ?? listImageGenerationProviders;
  const logger = deps.log ?? log;
  const requestedTimeoutMs =
    params.timeoutMs ??
    /* … resolved from agent defaults … */
```

`deps` is the dependency-injection seam — tests pass mock providers, production uses the real registry. The pattern recurs identically in `src/video-generation/runtime.ts:23-37` and `src/music-generation/runtime.ts:23-34`, all three pulling shared helpers from `src/media-generation/runtime-shared.ts`:

```ts
// src/media-generation/runtime-shared.ts:31-46
export function recordCapabilityCandidateFailure(params: {
  attempts: FallbackAttempt[];
  provider: string;
  model: string;
  error: unknown;
}): void {
  const described = isFailoverError(params.error) ? describeFailoverError(params.error) : undefined;
  params.attempts.push({
    provider: params.provider,
    model: params.model,
    error: described?.message ?? formatErrorMessage(params.error),
    reason: described?.reason,
    status: described?.status,
    code: described?.code,
  });
}
```

A failed provider is recorded as a structured `FallbackAttempt`. If the agent's configuration lists `{ openai-image, dashscope-image }` and OpenAI 503s, the runtime falls over to dashscope and the response includes the `attempts` array so the operator can see what happened. This pattern is identical to how the chat completion fallback works (Chapter 04).

### The result asset

Generated assets are uniform across image/video/music: a buffer (or URL), a MIME type, an optional filename and metadata. The image variant (`src/image-generation/types.ts:5-11`):

```ts
export type GeneratedImageAsset = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  revisedPrompt?: string;
  metadata?: Record<string, unknown>;
};
```

The video variant adds a `url` alternative (`src/video-generation/types.ts:4-15`):

```ts
export type GeneratedVideoAsset = {
  /** Raw video bytes. Required for local delivery; omit when url is provided instead. */
  buffer?: Buffer;
  /** External URL for the video (for example a pre-signed cloud storage URL).
   * When set and buffer is absent, delivery surfaces can forward the URL
   * without downloading the full video into memory first. */
  url?: string;
  mimeType: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
};
```

The URL fork matters: video files are large (often hundreds of megabytes), and pre-signed cloud URLs let the gateway forward the link to a channel (e.g., Telegram) without round-tripping the bytes through Node memory. The cost is that the URL has a TTL — channels that don't fetch quickly will see expired links. The runtime mitigates this by passing the URL through immediately rather than queueing it.

### Tools wrap runtimes

Generation runtimes are reached from agents via *tools*. The image tool is `src/agents/tools/image-generate-tool.ts` (`src/agents/tools/image-generate-tool.ts:1-30`):

```ts
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseImageGenerationModelRef } from "../../image-generation/model-ref.js";
import {
  generateImage,
  listRuntimeImageGenerationProviders,
} from "../../image-generation/runtime.js";
/* … */
import { saveMediaBuffer } from "../../media/store.js";
/* … */
import {
  formatGeneratedAttachmentLines,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import {
  buildMediaGenerationRequestKey,
  recordRecentMediaGenerationTaskStartForSession,
} from "../media-generation-task-status-shared.js";
```

The tool's job is to:

1. Validate the agent's call (TypeBox schema).
2. Resolve the configured image-gen model.
3. Call `generateImage(...)` from the runtime.
4. Save the buffer to the media store (`src/media/store.ts`).
5. Build an `AgentGeneratedAttachment` record so the agent's reply includes it.
6. Record the task in the session's "recent media generation" status so the UI can show progress.

### The async-job pattern

Image/video/music generation often takes 10–300 seconds. Blocking the agent's turn on synchronous generation would be terrible UX — the user would wait, the gateway would hold connections open, and a single slow run could starve other channels.

The actual pattern is *background tasks*. `src/agents/tools/image-generate-background.ts:6-22`:

```ts
export type ImageGenerationTaskHandle = MediaGenerationTaskHandle;

export const imageGenerationTaskLifecycle = createMediaGenerationTaskLifecycle({
  toolName: "image_generate",
  taskKind: IMAGE_GENERATION_TASK_KIND,
  label: "Image generation",
  queuedProgressSummary: "Queued image generation",
  generatedLabel: "image",
  failureProgressSummary: "Image generation failed",
  eventSource: "image_generation",
  announceType: "image generation task",
  completionLabel: "image",
});
```

The same factory pattern is replicated by `music-generate-background.ts` and `video-generate-background.ts`. A task lifecycle exposes:

- `createTaskRun(params)` — registers a new task and returns a handle the tool can later resolve.
- `recordTaskProgress(handle, summary)` — push a progress update; the UI sees `tool.progress` events.
- `completeTaskRun(handle, result)` — final success.
- `failTaskRun(handle, error)` — final failure.
- `wakeTaskCompletion(handle, status, attachments, …)` — used when the task finished while the agent was off doing other things (e.g., the agent moved to a new turn while video was rendering). When the task completes, this wakes a side-result that the UI can render in the original message context.

This is the only way a multi-turn agent can sensibly emit generated media: start the job, keep the conversation going, surface the result when it arrives. The conversation flow does not freeze.

### How generated media flows back

When the task completes, the result is announced in two places:

1. As a *side result* on the original session run (so the UI renders it inline in the chat bubble, even if the agent moved to a new turn).
2. As a *channel send* if the agent's reply requested it.

The conversion to channel-outbound media is in `src/media/outbound-attachment.ts` — it takes the saved buffer and metadata, the target channel's capability profile, and produces the channel-specific payload (Telegram has its own envelope, Signal another, iMessage another). The agent's tool doesn't need to know these; it returns the `AgentGeneratedAttachment` and the runtime fans it out.

<svg viewBox="0 0 920 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Media generation tool dispatch and async job pattern">
<rect x="20" y="20" width="170" height="70" rx="8" fill="#fed7aa" stroke="#ea580c"/>
<text x="105" y="48" text-anchor="middle" font-size="14" font-weight="700" fill="#7c2d12">LLM tool_call</text>
<text x="105" y="68" text-anchor="middle" font-size="11" fill="currentColor">image_generate, ...</text>
<rect x="220" y="20" width="190" height="70" rx="8" fill="#99f6e4" stroke="#0d9488"/>
<text x="315" y="48" text-anchor="middle" font-size="14" font-weight="700" fill="#134e4a">Tool wrapper</text>
<text x="315" y="68" text-anchor="middle" font-size="11" fill="currentColor">agents/tools/...-tool.ts</text>
<rect x="440" y="20" width="190" height="70" rx="8" fill="#99f6e4" stroke="#0d9488"/>
<text x="535" y="48" text-anchor="middle" font-size="14" font-weight="700" fill="#134e4a">Lifecycle: createTaskRun</text>
<text x="535" y="68" text-anchor="middle" font-size="11" fill="currentColor">background.ts</text>
<rect x="660" y="20" width="240" height="70" rx="8" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="780" y="48" text-anchor="middle" font-size="14" font-weight="700" fill="#3b0764">Provider runtime</text>
<text x="780" y="68" text-anchor="middle" font-size="11" fill="currentColor">image/video/music-generation/runtime.ts</text>
<line x1="190" y1="55" x2="220" y2="55" stroke="#64748b" stroke-width="2" marker-end="url(#arr3)"/>
<line x1="410" y1="55" x2="440" y2="55" stroke="#64748b" stroke-width="2" marker-end="url(#arr3)"/>
<line x1="630" y1="55" x2="660" y2="55" stroke="#64748b" stroke-width="2" marker-end="url(#arr3)"/>
<rect x="660" y="140" width="240" height="80" rx="8" fill="#bae6fd" stroke="#0ea5e9"/>
<text x="780" y="166" text-anchor="middle" font-size="13" font-weight="700" fill="#075985">Provider HTTP call</text>
<text x="780" y="186" text-anchor="middle" font-size="11" fill="currentColor">OpenAI Images, Dashscope,</text>
<text x="780" y="202" text-anchor="middle" font-size="11" fill="currentColor">Suno, ... (seconds to minutes)</text>
<line x1="780" y1="90" x2="780" y2="140" stroke="#7c3aed" stroke-width="2" marker-end="url(#arr3)"/>
<rect x="440" y="140" width="190" height="80" rx="8" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="535" y="166" text-anchor="middle" font-size="13" font-weight="700" fill="#3b0764">recordTaskProgress</text>
<text x="535" y="186" text-anchor="middle" font-size="11" fill="currentColor">tool.progress events</text>
<text x="535" y="202" text-anchor="middle" font-size="11" fill="currentColor">to chat</text>
<line x1="660" y1="180" x2="630" y2="180" stroke="#64748b" stroke-width="2" marker-end="url(#arr3)"/>
<rect x="440" y="260" width="190" height="80" rx="8" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="535" y="286" text-anchor="middle" font-size="13" font-weight="700" fill="#3b0764">completeTaskRun</text>
<text x="535" y="306" text-anchor="middle" font-size="11" fill="currentColor">saveMediaBuffer()</text>
<text x="535" y="322" text-anchor="middle" font-size="11" fill="currentColor">media/store.ts</text>
<line x1="535" y1="220" x2="535" y2="260" stroke="#64748b" stroke-width="2" marker-end="url(#arr3)"/>
<rect x="220" y="260" width="190" height="80" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="315" y="286" text-anchor="middle" font-size="13" font-weight="700" fill="#78350f">wakeTaskCompletion</text>
<text x="315" y="306" text-anchor="middle" font-size="11" fill="currentColor">side-result on session</text>
<text x="315" y="322" text-anchor="middle" font-size="11" fill="currentColor">even after turn ended</text>
<line x1="440" y1="300" x2="410" y2="300" stroke="#64748b" stroke-width="2" marker-end="url(#arr3)"/>
<rect x="20" y="260" width="170" height="80" rx="8" fill="#fed7aa" stroke="#ea580c"/>
<text x="105" y="286" text-anchor="middle" font-size="13" font-weight="700" fill="#7c2d12">Channel outbound</text>
<text x="105" y="306" text-anchor="middle" font-size="11" fill="currentColor">media/outbound-</text>
<text x="105" y="322" text-anchor="middle" font-size="11" fill="currentColor">attachment.ts</text>
<line x1="220" y1="300" x2="190" y2="300" stroke="#64748b" stroke-width="2" marker-end="url(#arr3)"/>
<text x="450" y="380" text-anchor="middle" font-size="12" fill="#64748b">Generation is async by design — progress events stream, completion wakes a side-result, agent never blocks.</text>
<defs><marker id="arr3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="#64748b"/></marker></defs>
</svg>
<span class="figure-caption">Figure R13.3 | Media generation dispatch — tool wraps runtime, runtime calls provider, lifecycle owns progress / completion / side-result delivery.</span>
<details><summary>ASCII original</summary>

```
LLM tool_call -> tool wrapper -> createTaskRun -> provider runtime
                                       |              |
                                       v              v
                                recordTaskProgress  HTTP call (slow)
                                       |              |
                                       v              v
                                completeTaskRun  saveMediaBuffer
                                       |
                                       v
                            wakeTaskCompletion -> side-result on session
                                       |
                                       v
                                channel outbound attachment
```
</details>

## 13.7 Image and video as agent outputs — the chat round trip

A worked example brings the pieces together. Suppose the user types:

> "Generate a watercolour of a fox in the snow and send it to me."

What happens:

1. The agent's LLM sees the request and emits a `tool_call` with `image_generate({ prompt: "watercolour of a fox in snow", … })`.
2. `src/agents/tools/image-generate-tool.ts` validates the arguments, resolves the configured image-gen model (`agents.defaults.imageGenerationModel` in config), and creates a task via `imageGenerationTaskLifecycle.createTaskRun(...)`.
3. The task is enqueued. The tool returns a *handle reference* immediately and emits a `tool.progress` event with "Queued image generation". The agent's turn proceeds; it can say "Working on it" and continue the conversation.
4. The lifecycle's background worker calls `generateImage(...)` in `src/image-generation/runtime.ts`. That iterates candidate providers (with the user's configured order first), HTTP-POSTs to the chosen provider, reads back the binary response, and returns a `GeneratedImageAsset`.
5. `saveMediaBuffer(...)` writes the bytes to the media store under a content-addressed key. The store applies `resolveGeneratedMediaMaxBytes(...)` to reject implausibly large files; it also stores PNG/JPEG/WebP encoded with `src/media/png-encode.ts` if a re-encode is needed.
6. `completeTaskRun(handle, asset)` records success.
7. `wakeTaskCompletion(...)` emits a session-level side-result. If the original chat turn is still active, the UI receives a `chat.sideResult` event; if not, the side-result attaches to the latest message in the session and the UI surfaces it as an *update* (Chapter 12 §12.8 — same Canvas-style update flow, but the payload is an attachment, not a Canvas preview).
8. If the channel is a messaging client (e.g., Telegram), the runtime also enqueues a *channel outbound* attachment via `src/media/outbound-attachment.ts`. The recipient sees the image arrive in their chat the moment the gateway flushes its send queue.

The user's perspective is: the agent said "Working on it" immediately, then 12 seconds later a watercolour fox appeared in the same conversation. The agent did not block. Other messages, other sessions, other channels kept moving.

## 13.8 The removed `src/ui/thinking-labels.ts`

The 2026.5.22 release dropped `src/ui/thinking-labels.ts` from the gateway side (`-3` lines in the diff stat). Why is this in a *voice and media* chapter?

Because the rationale is shared with the broader media/UI separation we keep seeing in this codebase. The thinking-label module used to format human-readable strings ("Off", "Adaptive", "Minimal", "Low", "Medium", "High", "Extra high", "Max") for the `agents.defaults.thinking` configuration value. The gateway emitted these strings to several clients.

Two problems with that design:

1. The strings are user-facing copy. Translating them belongs in the UI's i18n catalogue, not the gateway.
2. Different clients want different copy. The macOS UI says "Extra high"; a small phone client might say "X-High". A terminal client might want only the canonical value.

The fix in 2026.5.22 is that the gateway stops emitting labels. Each client formats its own. The UI keeps a copy of the formatter at `ui/src/ui/thinking-labels.ts` — visible in `ui/src/ui/views/sessions.ts:14-18`:

```ts
import {
  formatInheritedThinkingLabel,
  formatThinkingOverrideLabel,
  normalizeThinkingOptionValue,
} from "../thinking-labels.ts";
```

The label values themselves are unchanged (`ui/src/ui/thinking-labels.ts:30-50`); only the *home* of the function moved. The general rule embedded in this change applies across the codebase: **presentation is a client concern**. The gateway emits canonical values; clients format them. The same rule explains why TTS speech text uses `cleanedText` vs `ttsText` (§13.2), why media-understanding bodies are wrapped before being shown to the LLM (§13.5), and why Canvas previews are sanitised on the UI side rather than being signed off by the gateway (Chapter 12 §12.8).

## 13.9 Reading list by topic

If you want to extend or audit any of the four subsystems, start in the order below.

**Add a new speech (TTS) provider.** Read `src/tts/openai-compatible-speech-provider.ts` (the base), then `src/tts/provider-types.ts` (the SpeechProviderPlugin interface), then `src/tts/directives.ts` to understand how directive overrides interact with your provider. Drop your plug-in into the runtime registry (Chapter 06).

**Add a realtime transcription provider.** `src/realtime-transcription/provider-types.ts` (session interface), `src/realtime-transcription/websocket-session.ts` (transport helper), `src/realtime-transcription/provider-registry.ts` (registry pattern). Test with the `runner.deepgram.test.ts`-style fixtures from `src/media-understanding/`.

**Add a Talk mode/transport.** `src/talk/talk-events.ts` (extend `TalkMode` / `TalkTransport`), `src/talk/talk-session-controller.ts` (turn state machine), `src/talk/session-runtime.ts` (bridge factory). For a UI-facing transport, follow the pattern in `ui/src/ui/chat/realtime-talk-*.ts` (Chapter 12 §12.9).

**Add a media-understanding capability.** Read `src/media-understanding/runner.ts` end-to-end, then `src/media-understanding/apply.ts`, then pick a sibling capability runner (`runner.deepgram.test.ts` is the most worked example) and mirror its structure. Be sure to wire the scope check (`src/media-understanding/scope.ts`).

**Add a generation provider (image/video/music).** Read `src/media-generation/runtime-shared.ts` first, then the runtime for your capability (`src/image-generation/runtime.ts` etc.), then the corresponding tool in `src/agents/tools/`. The async-job pattern in `image-generate-background.ts` is the contract you must satisfy if your provider is non-trivial in duration.

The boundary lines drawn here — separate registries, distinct provider plug-in types, scope checks and SSRF guards on every external fetch, async jobs for slow operations, and "presentation is a client concern" — are not arbitrary. They are the design hypotheses that make a self-hosted personal AI assistant gateway feasible on a single machine while still supporting voice, images, video, and music as first-class outputs.
