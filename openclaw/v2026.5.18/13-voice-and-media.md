# 第 13 章 语音与媒体

> 代码版本锁定：`openclaw/openclaw@50a2481652`（tag `v2026.5.18`，2026-05-18）

## 13.1 本章要解决的问题

OpenClaw 是一个「个人 AI 助手网关」。除了文本对话，它还需要处理大量与语音和媒体相关的能力：

- 把助手的文本回复念出来（TTS，文本转语音）；
- 把用户的语音输入转成文本（实时转写 / 离线转写）；
- 接管一通真实的电话或会议（Talk，通话处理）；
- 让模型「看懂」用户发来的图片、「听懂」音频（媒体理解）；
- 让模型「画图 / 拍视频 / 作曲」（媒体生成）；
- 把生成或下载的媒体安全地落盘并定期清理（媒体存储与 TTL）。

这七件事看起来差别很大，但在 OpenClaw 里它们共享同一套架构骨架：

```
                         ┌──────────────────────────┐
                         │   能力运行时 (runtime)    │  selects provider,
                         │  归一化参数 / fallback    │  normalizes params
                         └────────────┬─────────────┘
                                      │ 调用
                         ┌────────────▼─────────────┐
                         │   provider-registry      │  从插件能力表中
                         │  规范化 id / 别名解析    │  解析 provider 插件
                         └────────────┬─────────────┘
                                      │ 返回
                         ┌────────────▼─────────────┐
                         │  Provider Plugin 实例    │  ElevenLabs / OpenAI /
                         │  synthesize / generate.. │  Deepgram / Twilio ...
                         └──────────────────────────┘
```

核心代码库（`src/`）**不内置任何具体厂商**。每一种能力都定义一组 TypeScript 接口（`provider-types.ts`），由插件（`extensions/`）提供实现，core 只负责「选 provider、归一化参数、做 fallback、落盘」这些通用逻辑。这条原则在仓库根 `AGENTS.md` 里写得很明确：

> Core stays plugin-agnostic. No bundled ids/defaults/policy in core when manifest/registry/capability contracts work.
> （`AGENTS.md`，"Architecture" 一节）

> Providers own auth/catalog/runtime hooks; core owns generic loop.

理解这一章，最重要的是先抓住「能力（capability）」这个抽象。下表是本章涉及的全部能力及其入口目录：

| 能力 | 目录 | provider 插件类型 | registry key |
| --- | --- | --- | --- |
| TTS 文本转语音 | `src/tts/` | `SpeechProviderPlugin` | `speechProviders` |
| 实时转写 | `src/realtime-transcription/` | `RealtimeTranscriptionProviderPlugin` | `realtimeTranscriptionProviders` |
| 实时语音通话 | `src/talk/` | `RealtimeVoiceProviderPlugin` | `realtimeVoiceProviders` |
| 媒体理解 | `src/media-understanding/` | media-understanding provider | （见 13.5） |
| 图像生成 | `src/image-generation/` | `ImageGenerationProviderPlugin` | `imageGenerationProviders` |
| 视频生成 | `src/video-generation/` | video provider | `videoGenerationProviders` |
| 音乐生成 | `src/music-generation/` | music provider | `musicGenerationProviders` |
| 媒体生成共享逻辑 | `src/media-generation/` | （无 provider，纯共享代码） | — |
| 媒体存储 / 解码 | `src/media/` | （无 provider，基础设施） | — |

注意 `src/media/` 与 `src/media-generation/` 是两个完全不同的东西：前者是「文件 / 字节 / MIME / 落盘」这类基础设施，后者是图像/视频/音乐生成三者共享的「参数归一化 + provider fallback」逻辑。下文会逐一拆解。

---

## 13.2 TTS：文本转语音

### 13.2.1 目录结构与公开 API

`src/tts/` 是一个典型的「门面 + 配置 + provider 工厂」组合：

```
src/tts/
  tts.ts                              再导出门面（barrel）
  tts-types.ts                        ResolvedTtsConfig 等类型
  provider-types.ts                   SpeechProviderPlugin 契约用到的所有类型
  provider-registry.ts                speechProviders 能力表解析
  provider-registry-core.ts           registry 工厂（规范化 id / 别名）
  tts-config.ts                       多层配置合并 + auto 模式判定
  tts-auto-mode.ts                    "off/always/inbound/tagged" 归一化
  tts-core.ts                         summarizeText（长文本压缩）
  tts-provider-helpers.ts             参数校验 + 临时目录清理
  directives.ts                       解析 [[tts:...]] 内联指令
  status-config.ts                    TTS 状态/语音列表查询
  openai-compatible-speech-provider.ts OpenAI 兼容 TTS provider 的工厂
```

值得注意的是 `src/tts/tts.ts` 本身**不实现任何逻辑**，它只是一个再导出：

```ts
// src/tts/tts.ts:1
export {
  // ...
  synthesizeSpeech,
  streamSpeech,
  textToSpeech,
  textToSpeechStream,
  textToSpeechTelephony,
  // ...
} from "../plugin-sdk/tts-runtime.js";
```

而 `src/plugin-sdk/tts-runtime.ts` 才是真正的入口，它通过「门面延迟加载」把全部 TTS 运行时指向了一个**内置打包插件** `speech-core`：

```ts
// src/plugin-sdk/tts-runtime.ts:18
function loadFacadeModule(): FacadeModule {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "speech-core",
    artifactBasename: "runtime-api.js",
  });
}
// ...
export const synthesizeSpeech: FacadeModule["synthesizeSpeech"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "synthesizeSpeech");
```

**为什么这样设计？** 这正是 `AGENTS.md` 里那条规则的落地：

> Internal bundled plugins ship in core dist; bundled-only facade loader ok only for them.

TTS 的实际合成实现（带状态、带缓存、带流式）被搬到了 `extensions/` 下的 `speech-core` 内置插件里，core 只保留一个**类型化的门面**（`TtsRuntimeFacade`）。这样做的好处是：core 包体保持「插件无关」，而 `speech-core` 可以独立演进。`createLazyFacadeRuntimeValue` 保证只有真正调用 `synthesizeSpeech` 时才会去加载那个插件模块——避免给不用 TTS 的部署增加启动开销。

### 13.2.2 Provider 注册与解析

TTS 的 provider 注册走的是「能力插件表」机制。`provider-registry-core.ts` 提供了一个通用的注册表工厂：

```ts
// src/tts/provider-registry-core.ts:20
export function createSpeechProviderRegistry(resolver: SpeechProviderRegistryResolver) {
  const buildResolvedProviderMaps = (cfg?: OpenClawConfig) =>
    buildCapabilityProviderMaps(resolver.listProviders(cfg));

  const getProvider = (
    providerId: string | undefined,
    cfg?: OpenClawConfig,
  ): SpeechProviderPlugin | undefined => {
    const normalized = normalizeSpeechProviderId(providerId);
    if (!normalized) {
      return undefined;
    }
    return (
      resolver.getProvider(normalized, cfg) ??
      buildResolvedProviderMaps(cfg).aliases.get(normalized)
    );
  };
  // ...
}
```

`provider-registry.ts` 用它创建了**两个**注册表，对应两种「插件已加载」程度：

```ts
// src/tts/provider-registry.ts:35
const defaultSpeechProviderRegistry = createSpeechProviderRegistry(
  defaultSpeechProviderRegistryResolver,
);

const loadedSpeechProviderRegistry = createSpeechProviderRegistry({
  getProvider: (providerId) =>
    resolveLoadedSpeechProviderPluginEntries().find((provider) => {
      if (provider.id === providerId) {
        return true;
      }
      return provider.aliases?.includes(providerId) ?? false;
    }),
  listProviders: () => resolveLoadedSpeechProviderPluginEntries(),
});
```

- `defaultSpeechProviderRegistry`（`src/tts/provider-registry.ts:50`）通过 `resolvePluginCapabilityProviders` 解析「配置声明的」provider——即使插件还没运行起来也能列出；
- `loadedSpeechProviderRegistry`（`src/tts/provider-registry.ts:51`）只从 `getActiveRuntimePluginRegistry()` 取「真正激活加载了的」provider。

**为什么要分两个？** 例如 CLI 的 `openclaw doctor` 需要在插件没全部加载的情况下也能告诉用户「你声明了 ElevenLabs 但没装这个插件」，这时要用 default 注册表；而真正合成语音时必须用 loaded 注册表，确保 provider 代码可用。

`normalizeSpeechProviderId`（`src/tts/provider-registry-core.ts:14`）委托给共享的 `normalizeCapabilityProviderId`，把 `"ElevenLabs"`、`"eleven-labs"` 之类统一成规范 id——这是所有能力 registry 的通用前置步骤。

### 13.2.3 SpeechProviderPlugin 契约

`provider-types.ts` 定义了一个 TTS provider 插件必须提供的接口。最关键的几个类型：

```ts
// src/tts/provider-types.ts:44
export type SpeechSynthesisRequest = {
  text: string;
  cfg: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  target: SpeechSynthesisTarget;       // "audio-file" | "voice-note" | "telephony"
  providerOverrides?: SpeechProviderOverrides;
  timeoutMs: number;
};

// src/tts/provider-types.ts:53
export type SpeechSynthesisResult = {
  audioBuffer: Buffer;
  outputFormat: string;
  fileExtension: string;
  voiceCompatible: boolean;
};
```

`SpeechSynthesisTarget`（`src/tts/provider-types.ts:7`）是 `"audio-file" | "voice-note" | "telephony"` 三选一——同一个 provider 既能合成普通音频文件，也能合成「语音消息」（如 Telegram voice note），还能合成专供电话使用的 8kHz 流。

`SpeechSynthesisStreamResult`（`src/tts/provider-types.ts:62`）则给出**流式**版本，返回的是 `ReadableStream<Uint8Array>` 而不是 `Buffer`，并带一个可选的 `release()` 资源释放钩子：

```ts
// src/tts/provider-types.ts:62
export type SpeechSynthesisStreamResult = {
  audioStream: ReadableStream<Uint8Array>;
  outputFormat: string;
  fileExtension: string;
  voiceCompatible: boolean;
  release?: () => Promise<void>;
};
```

**为什么需要流式？** 长回复念全篇要等几秒，体验差。流式让助手「边合成边播」，第一个音频块到了就能开始播放。`release()` 用于在流被消费完或中断后清理底层 HTTP 连接——这正是 OpenClaw 处理「热路径资源生命周期」的一贯做法。

`SpeechModelOverridePolicy`（`src/tts/provider-types.ts:13`）是一组布尔开关，决定用户能否在运行时改某些参数：

```ts
// src/tts/provider-types.ts:13
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

这个策略与下文 13.2.6 的 `[[tts:...]]` 内联指令配合：管理员可以禁止用户在消息里临时换 provider 或换声音。

### 13.2.4 OpenAI 兼容 provider 工厂

OpenClaw 没有为每个厂商写一份 provider，而是提供了一个**工厂函数** `createOpenAiCompatibleSpeechProvider`（`src/tts/openai-compatible-speech-provider.ts:188`）。任何兼容 OpenAI `/audio/speech` 接口的厂商（OpenAI 自己、各种本地推理服务）都可以用一行配置生成一个 provider 插件。

工厂接收一份 `OpenAiCompatibleSpeechProviderOptions`（`src/tts/openai-compatible-speech-provider.ts:41`），描述这个厂商的 id、默认 model/voice/baseUrl、支持的 `responseFormats`、环境变量名等。它内部会处理三类配置来源的优先级：

```ts
// src/tts/openai-compatible-speech-provider.ts:252
function resolveApiKey(params: {...}): string | undefined {
  return (
    params.providerConfig.apiKey ??
    normalizeResolvedSecretInputString({
      value: readModelProviderConfig(params.cfg, providerConfigKey)?.apiKey,
      path: `models.providers.${providerConfigKey}.apiKey`,
    }) ??
    trimToUndefined(process.env[options.envKey])
  );
}
```

API key 的查找顺序是：**TTS provider 专属配置 → `models.providers` 全局配置 → 环境变量**。注意 `normalizeResolvedSecretInputString` 这一步——它会把配置里的 SecretRef（见第 14 章）解析成明文，意味着 TTS 凭据也能用加密 secrets 管理，而不必裸写 API key。

真正的合成在 `synthesize`（`src/tts/openai-compatible-speech-provider.ts:338`）里：

```ts
// src/tts/openai-compatible-speech-provider.ts:363
const { response, release } = await postJsonRequest({
  url: `${baseUrl}/audio/speech`,
  headers,
  body: {
    model: normalizeModel(overrides.model ?? config.model, options.defaultModel),
    input: req.text,
    voice: overrides.voice ?? config.voice,
    response_format: responseFormat,
    ...(speed == null ? {} : { speed }),
    ...buildExtraJsonBodyFields(config, options.extraJsonBodyFields),
  },
  timeoutMs: req.timeoutMs,
  fetchFn: fetch,
  allowPrivateNetwork,
  dispatcherPolicy,
});
```

注意 `allowPrivateNetwork: false`（在 `resolveProviderHttpRequestConfig` 调用里，`src/tts/openai-compatible-speech-provider.ts:349`）——TTS 出站请求默认禁止访问私网地址，这是一道 SSRF 防线。`buildExtraJsonBodyFields`（`src/tts/openai-compatible-speech-provider.ts:174`）允许某些厂商往请求体里塞自定义字段（如不同的稳定性参数），由 `extraJsonBodyFields` 配置驱动。

`parseDirectiveToken`（`src/tts/openai-compatible-speech-provider.ts:145`）让这个工厂生成的 provider 自动支持 `voice` / `model` 内联指令——但只有当 `SpeechModelOverridePolicy` 允许时才生效：

```ts
// src/tts/openai-compatible-speech-provider.ts:155
case `${compactProviderKey}voice`:
  if (!ctx.policy.allowVoice) {
    return { handled: true };          // 识别了但忽略
  }
  return { handled: true, overrides: { voice: ctx.value } };
```

### 13.2.5 多层配置合并与按 session 选音

`tts-config.ts` 解决一个实际问题：**不同 agent / 不同频道 / 不同账号需要不同的 TTS 行为**。它实现了一个分层覆盖（layered override）模型。

`resolveEffectiveTtsConfig`（`src/tts/tts-config.ts:124`）按固定顺序逐层深合并：

```ts
// src/tts/tts-config.ts:124
export function resolveEffectiveTtsConfig(
  cfg: OpenClawConfig,
  contextOrAgentId?: string | TtsConfigResolutionContext,
): TtsConfig {
  const context = resolveTtsConfigContext(contextOrAgentId);
  const base = cfg.messages?.tts ?? {};
  const agentOverride = resolveAgentTtsOverride(cfg, context.agentId);
  const channelOverride = resolveChannelTtsOverride(cfg, context);
  const accountOverride = resolveAccountTtsOverride(cfg, context);
  let merged: unknown = base;
  for (const override of [agentOverride, channelOverride, accountOverride]) {
    merged = deepMergeDefined(merged, override ?? {});
  }
  return merged as TtsConfig;
}
```

合并顺序是：**全局 `messages.tts` → agent 级 → channel 级 → account 级**，后者覆盖前者。这意味着「按 session 选音」其实就是把 `voice` 字段写在不同层级——例如给某个 agent 配一个专属声音，或给某个 Telegram 账号配另一个声音。

`deepMergeDefined`（`src/tts/tts-config.ts:26`）有两个安全细节：

```ts
// src/tts/tts-config.ts:14
const BLOCKED_MERGE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
```

它显式拒绝 `__proto__` 等键，防止原型链污染；同时 `value === undefined` 的字段被跳过，保证「未设置」不会覆盖掉下层的有效值。

`auto` 模式的判定走另一条线。`tts-auto-mode.ts` 定义了四种模式：

```ts
// src/tts/tts-auto-mode.ts:4
export const TTS_AUTO_MODES = new Set<TtsAutoMode>(["off", "always", "inbound", "tagged"]);
```

`shouldAttemptTtsPayload`（`src/tts/tts-config.ts:179`）按优先级判断这一条消息要不要朗读：

```ts
// src/tts/tts-config.ts:179
export function shouldAttemptTtsPayload(params: {...}): boolean {
  const sessionAuto = normalizeTtsAutoMode(params.ttsAuto);
  if (sessionAuto) {
    return sessionAuto !== "off";          // 1) session 运行时设置最高优先级
  }
  const raw = resolveEffectiveTtsConfig(params.cfg, params);
  const prefsAuto = readTtsPrefsAutoMode(resolveTtsPrefsPathValue(raw?.prefsPath));
  if (prefsAuto) {
    return prefsAuto !== "off";            // 2) 用户偏好文件 tts.json
  }
  const configuredAuto = normalizeTtsAutoMode(raw?.auto);
  if (configuredAuto) {
    return configuredAuto !== "off";       // 3) 配置文件
  }
  return raw?.enabled === true;            // 4) 旧式 enabled 布尔
}
```

优先级是：**会话内临时设置 → 用户偏好文件 → 配置文件 → 旧式 `enabled`**。偏好文件路径由 `resolveTtsPrefsPathValue`（`src/tts/tts-config.ts:147`）解析，默认落在 `<configDir>/settings/tts.json`，也可被 `OPENCLAW_TTS_PREFS` 环境变量覆盖——这让用户在 UI 里点一下「打开/关闭朗读」就能持久化，不必改主配置。

### 13.2.6 内联 TTS 指令

`directives.ts` 解析助手回复里的 `[[tts:...]]` 指令。例如助手输出 `[[tts:voice=alloy]] 你好` 时，core 会把 `voice=alloy` 解析为 override、把 `[[tts:...]]` 从对外文本里清掉。

`shouldCleanTtsDirectiveText`（`src/tts/tts-config.ts:204`）决定要不要清理指令文本：

```ts
// src/tts/tts-config.ts:204
export function shouldCleanTtsDirectiveText(params: {...}): boolean {
  if (!shouldAttemptTtsPayload(params)) {
    return false;
  }
  return resolveEffectiveTtsConfig(params.cfg, params).modelOverrides?.enabled !== false;
}
```

只有「确实要朗读」且「未禁用 modelOverrides」时才清理；否则指令原样保留——这避免在 TTS 关闭时把指令文本误删。

### 13.2.7 长文本压缩与临时文件清理

`tts-core.ts` 里的 `summarizeText`（`src/tts/tts-core.ts:78`）处理一个边界问题：助手回复太长，全念出来会很冗长。它调用一个 LLM 把文本压缩到目标长度：

```ts
// src/tts/tts-core.ts:88
const { text, targetLength, cfg, config, timeoutMs } = params;
if (targetLength < 100 || targetLength > 10_000) {
  throw new Error(`Invalid targetLength: ${targetLength}`);
}
```

用哪个模型来压缩？`resolveSummaryModelRef`（`src/tts/tts-core.ts:52`）优先用 `config.summaryModel`，没配就用 agent 默认模型。压缩时 `temperature: 0.3`、`maxTokens: Math.ceil(targetLength / 2)`（`src/tts/tts-core.ts:127`）——低温度保证稳定，token 上限按目标字符数折算。

临时文件清理在 `tts-provider-helpers.ts`：

```ts
// src/tts/tts-provider-helpers.ts:45
export function scheduleCleanup(
  tempDir: string,
  delayMs: number = TEMP_FILE_CLEANUP_DELAY_MS,   // 5 分钟
): void {
  const timer = setTimeout(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }, delayMs);
  timer.unref();
}
```

`timer.unref()` 是关键细节：它让这个清理定时器**不阻止进程退出**。如果进程在 5 分钟内正常关闭，临时目录就交给操作系统的临时目录回收去处理；只有进程长期运行时定时器才会触发。

---

## 13.3 实时转写：把语音变成文本

### 13.3.1 目录与契约

`src/realtime-transcription/` 出乎意料地小——只有四个文件：

```
src/realtime-transcription/
  provider-registry.ts      realtimeTranscriptionProviders 能力表解析
  provider-types.ts         RealtimeTranscriptionSession 契约
  websocket-session.ts      通用 WebSocket 会话实现（带重连）
```

`provider-registry.ts` 与 TTS 的结构几乎一致——`getRealtimeTranscriptionProvider`（`src/realtime-transcription/provider-registry.ts:41`）先尝试 `resolvePluginCapabilityProvider` 直接命中，再回落到别名表查找。这种「直接命中优先 / 别名表兜底」是所有能力 registry 的统一模式。

provider 必须实现的会话接口非常精简：

```ts
// src/realtime-transcription/provider-types.ts:29
export type RealtimeTranscriptionSession = {
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  close(): void;
  isConnected(): boolean;
};
```

回调接口 `RealtimeTranscriptionSessionCallbacks`（`src/realtime-transcription/provider-types.ts:17`）有四个事件：

```ts
// src/realtime-transcription/provider-types.ts:17
export type RealtimeTranscriptionSessionCallbacks = {
  onPartial?: (partial: string) => void;       // 中间结果（边说边出）
  onTranscript?: (transcript: string) => void; // 最终结果
  onSpeechStart?: () => void;                  // 检测到开始说话
  onError?: (error: Error) => void;
};
```

`onPartial` 与 `onTranscript` 的区别是实时转写体验的核心：用户还在说时不断给中间结果（可在 UI 里灰字预览），说完了给最终的稳定文本。

### 13.3.2 通用 WebSocket 会话

实时转写厂商几乎都用 WebSocket 推流。`websocket-session.ts` 把「连一个 WebSocket、推音频、解析消息、断线重连」这套样板代码做成了通用基类，provider 只需填几个回调。

`createRealtimeTranscriptionWebSocketSession`（`src/realtime-transcription/websocket-session.ts:469`）接收一份 `RealtimeTranscriptionWebSocketSessionOptions`（`src/realtime-transcription/websocket-session.ts:21`），关键字段包括 `url`（可以是函数，支持动态签名 URL）、`headers`（同样可以是异步函数）、`parseMessage`、`sendAudio`、`onMessage`。

这个会话实现了几个重要的健壮性机制：

**1）连接前排队音频。** 在 WebSocket 还没 ready 时，`sendAudio` 把音频放进队列，连接就绪后由 `flushQueuedAudio` 一次性补发：

```ts
// src/realtime-transcription/websocket-session.ts:110
sendAudio(audio: Buffer): void {
  if (this.closed || audio.byteLength === 0) {
    return;
  }
  if (this.ws?.readyState === WebSocket.OPEN && this.ready) {
    this.options.sendAudio(audio, this.transport);
    return;
  }
  this.queueAudio(audio);
}
```

**2）有界队列防内存膨胀。** 队列默认上限 2MB（`DEFAULT_MAX_QUEUED_BYTES`，`src/realtime-transcription/websocket-session.ts:48`），超限时丢弃最旧的音频块：

```ts
// src/realtime-transcription/websocket-session.ts:368
private queueAudio(audio: Buffer): void {
  this.queuedAudio.push(Buffer.from(audio));
  this.queuedBytes += audio.byteLength;
  while (this.queuedBytes > this.maxQueuedBytes && this.queuedAudio.length > 0) {
    const dropped = this.queuedAudio.shift();
    this.queuedBytes -= dropped?.byteLength ?? 0;
  }
}
```

**为什么丢最旧的？** 转写场景下旧音频已经过时，丢掉它保留最新音频对最终文本质量影响最小。

**3）指数退避重连。** 连接意外断开（不是主动 `close`）时触发重连，延迟按 `2^(attempt-1)` 增长，默认最多 5 次：

```ts
// src/realtime-transcription/websocket-session.ts:336
private async attemptReconnect(): Promise<void> {
  if (this.closed || this.reconnecting) {
    return;
  }
  if (this.reconnectAttempts >= this.maxReconnectAttempts) {
    this.emitError(new Error(/* reconnect limit reached */));
    return;
  }
  this.reconnectAttempts += 1;
  const delay = this.reconnectDelayMs * 2 ** (this.reconnectAttempts - 1);
  // ...
}
```

注意 `connect()` 入口（`src/realtime-transcription/websocket-session.ts:103`）每次都把 `reconnectAttempts` 重置为 0，而 `open` 事件里也会重置（`src/realtime-transcription/websocket-session.ts:256`）——保证「一次成功连接」会清空重连计数。

**4）连接超时与「未就绪即关闭」处理。** `doConnect`（`src/realtime-transcription/websocket-session.ts:163`）里有一个 `connectTimeout`（默认 10 秒），还区分了「open 之前就 close」与「open 之后才 close」——前者视为连接失败并 reject，后者才走重连：

```ts
// src/realtime-transcription/websocket-session.ts:308
if (!opened || !settled) {
  failConnect(new Error(/* connection closed before ready */));
  return;
}
void this.attemptReconnect();
```

**5）调试代理捕获。** 每一帧 inbound/outbound、open/close/error 都通过 `captureWsEvent`（`src/realtime-transcription/websocket-session.ts:421`）上报给 `proxy-capture` 子系统——这让开发者能在调试代理里看到完整的 WebSocket 流量，标记 `capability: "realtime-transcription"`。

---

## 13.4 Talk：实时语音通话

### 13.4.1 Talk 解决的问题

`src/talk/` 是本章最复杂的子系统。它处理的是「助手接管一通真实通话」——用户拨进来（Twilio 电话）、或在一个会议里（Google Meet）、或一个 WebRTC 浏览器会话，助手用语音实时对话，期间还能调工具。

这与 13.3 的实时转写不同：转写只把语音变文本，Talk 是**双向实时语音 + 工具调用**的完整闭环，通常对接厂商的「Realtime Voice API」（如 OpenAI Realtime）。

`src/talk/` 目录里的文件可分四类：

```
provider-types.ts / provider-registry.ts / provider-resolver.ts   provider 契约与解析
session-runtime.ts / talk-session-controller.ts                   会话桥接与回合管理
talk-events.ts / session-log-runtime.ts / logging.ts              事件序列与日志
agent-consult-*.ts / agent-talkback-runtime.ts / fast-context-*   通话中咨询/回话/快速上下文
audio-codec.ts / diagnostics.ts                                   音频编解码与诊断
```

### 13.4.2 Provider 契约：RealtimeVoiceBridge

Talk 的 provider 类型是 `RealtimeVoiceProviderPlugin`，registry key 为 `realtimeVoiceProviders`（`src/talk/provider-registry.ts:20`）。provider 的核心产出是一个 `RealtimeVoiceBridge`（`provider-types.ts` 末尾）——一座连接「OpenClaw 这一侧」和「厂商 Realtime API」的桥。

音频格式有两种固定预设：

```ts
// src/talk/provider-types.ts:22
export const REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ: RealtimeVoiceAudioFormat = {
  encoding: "g711_ulaw",
  sampleRateHz: 8000,
  channels: 1,
};

// src/talk/provider-types.ts:28
export const REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ: RealtimeVoiceAudioFormat = {
  encoding: "pcm16",
  sampleRateHz: 24000,
  channels: 1,
};
```

`g711_ulaw` 8kHz 是**电话标准**（Twilio 等用它），`pcm16` 24kHz 是 WebRTC / 高质量场景。provider 根据传输方式选格式。

bridge 还要支持「通话中调工具」，工具类型是 `RealtimeVoiceTool`（`src/talk/provider-types.ts:34`），结构与普通函数调用工具一致。`RealtimeVoiceToolResultOptions`（`src/talk/provider-types.ts:52`）里有一个值得注意的 `suppressResponse`：

```ts
// src/talk/provider-types.ts:52
export type RealtimeVoiceToolResultOptions = {
  /**
   * Submit the tool result without prompting the realtime provider to generate a new assistant
   * response. Use when another channel has already delivered the user-visible answer.
   */
  suppressResponse?: boolean;
  willContinue?: boolean;
};
```

**为什么需要它？** 有时工具的结果已经通过别的渠道告诉了用户（比如发了条文本消息），就不需要让 Realtime API 再生成一段语音回复——`suppressResponse` 把工具结果交回去但不触发新一轮发声。

### 13.4.3 Provider 解析与配置

`provider-resolver.ts` 的 `resolveConfiguredRealtimeVoiceProvider`（`src/talk/provider-resolver.ts:23`）负责挑选实际可用的 provider。它委托给共享的 `resolveConfiguredCapabilityProvider`，并根据失败码给出清晰的错误：

```ts
// src/talk/provider-resolver.ts:55
if (!resolution.ok && resolution.code === "missing-configured-provider") {
  throw new Error(
    `Realtime voice provider "${resolution.configuredProviderId}" is not registered`,
  );
}
if (!resolution.ok && resolution.code === "no-registered-provider") {
  throw new Error(params.noRegisteredProviderMessage ?? "No realtime voice provider registered");
}
if (!resolution.ok) {
  throw new Error(`Realtime voice provider "${resolution.provider?.id}" is not configured`);
}
```

三种失败有明显区别：「声明的 provider 没注册」（拼错 / 没装插件）、「一个 provider 都没注册」、「provider 注册了但没配凭据」。把它们分开报，用户能立刻知道下一步该做什么。

### 13.4.4 会话桥接：createRealtimeVoiceBridgeSession

`session-runtime.ts` 的 `createRealtimeVoiceBridgeSession`（`src/talk/session-runtime.ts:59`）把 provider 的 bridge 包成一个面向上层的 `RealtimeVoiceBridgeSession`。它做的事是「把厂商 bridge 的音频输出接到一个 `RealtimeVoiceAudioSink`」：

```ts
// src/talk/session-runtime.ts:16
export type RealtimeVoiceAudioSink = {
  isOpen?: () => boolean;
  sendAudio: (audio: Buffer) => void;
  clearAudio?: () => void;
  sendMark?: (markName: string) => void;
};
```

`sink` 是「音频要往哪儿播」的抽象——可能是 Twilio 的媒体流，也可能是 WebRTC 通道。bridge 产出音频时通过 `onAudio` 回调写进 sink，但有个守卫 `canSendAudio()`：

```ts
// src/talk/session-runtime.ts:84
const canSendAudio = () => params.audioSink.isOpen?.() ?? true;
bridge = params.provider.createBridge({
  // ...
  onAudio: (audio) => {
    if (canSendAudio()) {
      params.audioSink.sendAudio(audio);
    }
  },
```

**为什么要检查 sink 是否 open？** 通话可能在助手还在说话时被对方挂断，此时继续往一个已关闭的流写音频会报错——`isOpen()` 守卫优雅地丢弃这些音频。

#### Mark 策略

「mark」是电话语音的一个微妙概念。当助手发一段音频后，需要知道这段音频**什么时候真正播完了**——这影响 barge-in（用户打断）的判定。`RealtimeVoiceMarkStrategy`（`src/talk/session-runtime.ts:23`）有三种：

```ts
// src/talk/session-runtime.ts:23
export type RealtimeVoiceMarkStrategy = "transport" | "ack-immediately" | "ignore";
```

```ts
// src/talk/session-runtime.ts:103
onMark: (markName) => {
  if (!canSendAudio() || params.markStrategy === "ignore") {
    return;
  }
  if (params.markStrategy === "ack-immediately") {
    bridge?.acknowledgeMark();
    return;
  }
  if (params.markStrategy === undefined || params.markStrategy === "transport") {
    params.audioSink.sendMark?.(markName);
  }
},
```

- `transport`（默认）：把 mark 交给传输层（如 Twilio），传输层在音频真正播完后回传 mark 事件——最精确；
- `ack-immediately`：传输层不支持 mark 时，立即假装「播完了」；
- `ignore`：完全不处理 mark。

### 13.4.5 回合管理：TalkSessionController

一通通话由若干「回合（turn）」组成：用户说一句、助手回一句，就是一个回合。`talk-session-controller.ts` 的 `createTalkSessionController`（`src/talk/talk-session-controller.ts:58`）是一个**状态机**，管理「当前是不是有活跃回合」「输出音频有没有在播」。

它对外暴露的方法：

```ts
// src/talk/talk-session-controller.ts:32
export type TalkSessionController = {
  readonly activeTurnId: string | undefined;
  readonly outputAudioActive: boolean;
  startTurn(...): TalkEnsureTurnResult;
  endTurn(...): TalkTurnResult;
  cancelTurn(...): TalkTurnResult;
  startOutputAudio(...): TalkEnsureTurnResult;
  finishOutputAudio(...): TalkEvent | undefined;
  // ...
};
```

每个状态变更都 `emit` 一个事件（`turn.started` / `turn.ended` / `turn.cancelled` / `output.audio.started` / `output.audio.done`），事件被记入 `recentEvents` 环形缓冲（默认保留 20 条，`src/talk/talk-session-controller.ts:62`）。

`resolveActiveTurn`（`src/talk/talk-session-controller.ts:86`）处理一个并发问题——「过期回合」：

```ts
// src/talk/talk-session-controller.ts:86
const resolveActiveTurn = (requestedTurnId: string | undefined): string | TalkTurnFailure => {
  if (!activeTurnId) {
    return { ok: false, reason: "no_active_turn" };
  }
  const normalizedRequested = normalizeOptionalString(requestedTurnId);
  if (normalizedRequested && normalizedRequested !== activeTurnId) {
    return { ok: false, reason: "stale_turn" };
  }
  return activeTurnId;
};
```

**为什么需要 stale_turn？** 实时语音里事件是异步的。可能 turn A 的「结束」事件还在路上，turn B 已经开始了。如果一个携带 `turnId=A` 的 `endTurn` 此时到达，它指向的回合已经不是当前回合——`stale_turn` 让它被安全忽略，不会误终止 turn B。

`normalizeTalkTransport`（`src/talk/talk-session-controller.ts:198`）做了一点传输名的向后兼容映射：`"webrtc-sdp"` → `"webrtc"`，`"json-pcm-websocket"` → `"provider-websocket"`。

### 13.4.6 音频编解码

`audio-codec.ts` 是一段纯算法代码，处理电话音频的两个转换需求：**重采样**和 **μ-law 编解码**。

电话用 8kHz μ-law，而模型/TTS 可能产出 24kHz PCM16。`resamplePcm`（`src/talk/audio-codec.ts:50`）做带限重采样——不是简单丢样本，而是用一个 31 抽头的 sinc 低通滤波器（带 Hann 窗）：

```ts
// src/talk/audio-codec.ts:1
const TELEPHONY_SAMPLE_RATE = 8000;
const RESAMPLE_FILTER_TAPS = 31;
const RESAMPLE_CUTOFF_GUARD = 0.94;
```

```ts
// src/talk/audio-codec.ts:34
const lowPass = 2 * cutoffCyclesPerSample * sinc(2 * cutoffCyclesPerSample * distance);
const tapIndex = tap + half;
const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * tapIndex) / (RESAMPLE_FILTER_TAPS - 1));
const coeff = lowPass * window;
```

**为什么不用简单重采样？** 从 24kHz 降到 8kHz 时，原信号里高于 4kHz 的成分会发生混叠（aliasing），变成刺耳的杂音。下采样前必须先低通滤波。`RESAMPLE_CUTOFF_GUARD = 0.94` 把截止频率略压低于奈奎斯特频率，留出滤波器过渡带。

`convertPcmToMulaw8k`（`src/talk/audio-codec.ts:104`）把一段任意采样率的 PCM 一步转成电话用的 8kHz μ-law：

```ts
// src/talk/audio-codec.ts:104
export function convertPcmToMulaw8k(pcm: Buffer, inputSampleRate: number): Buffer {
  return pcmToMulaw(resamplePcmTo8k(pcm, inputSampleRate));
}
```

`linearToMulaw`（`src/talk/audio-codec.ts:108`）/ `mulawToLinear`（`src/talk/audio-codec.ts:130`）是标准 G.711 μ-law 实现——把 16 位线性 PCM 压成 8 位对数编码（电话带宽有限）。这段代码自己实现而不依赖外部库，是因为它很短、很稳定，且在通话热路径上被反复调用。

---

## 13.5 媒体理解：让模型「看懂、听懂」

### 13.5.1 目录概览

`src/media-understanding/` 是本章文件最多的目录（70 个文件）。它解决的问题是：用户在聊天里发来一张图、一段语音、一个视频，怎么让模型理解其内容？

核心入口在 `runtime.ts`，对外暴露四个函数：

```ts
// src/media-understanding/runtime.ts:209
export async function describeImageFile(...): Promise<RunMediaUnderstandingFileResult>
export async function describeImageFileWithModel(...)
export async function describeVideoFile(...): Promise<RunMediaUnderstandingFileResult>
export async function transcribeAudioFile(...): Promise<RunMediaUnderstandingFileResult>
export async function extractStructuredWithModel(...)
```

三种能力 `image` / `audio` / `video` 共用一条管线，由 `runMediaUnderstandingFile`（`src/media-understanding/runtime.ts:112`）统一处理。

### 13.5.2 统一管线 runMediaUnderstandingFile

`describeImageFile` / `describeVideoFile` / `transcribeAudioFile` 都是薄包装，只是把 `capability` 字段填好后调同一个函数：

```ts
// src/media-understanding/runtime.ts:209
export async function describeImageFile(params): Promise<RunMediaUnderstandingFileResult> {
  return await runMediaUnderstandingFile({ ...params, capability: "image" });
}
```

`runMediaUnderstandingFile`（`src/media-understanding/runtime.ts:112`）的处理流程：

```
  输入: filePath / mediaUrl / mime + capability + prompt
        │
        ▼
  buildFileContext  ── 区分本地路径 vs 远程 URL，推断 MIME
        │
        ▼
  normalizeMediaAttachments  ── 归一化成附件列表
        │
        ├── 附件为空 → outcome: "no-attachment"
        │
        ▼
  检查 cfg.tools.media[capability].enabled
        │
        ├── enabled === false → outcome: "disabled"
        │
        ▼
  createMediaAttachmentCache  ── 建附件缓存（带 SSRF 策略）
        │
        ▼
  runCapability  ── 实际跑 provider / CLI，带 fallback
        │
        ▼
  提取 output.text，组装 RunMediaUnderstandingFileResult
        │
        ▼
  finally: cache.cleanup()
```

请求级参数（如临时 prompt、超时）通过**浅拷贝注入 cfg** 的方式传进去：

```ts
// src/media-understanding/runtime.ts:122
const cfg =
  requestPrompt || requestTimeoutSeconds !== undefined
    ? {
        ...params.cfg,
        tools: {
          ...params.cfg.tools,
          media: {
            ...params.cfg.tools?.media,
            [params.capability]: {
              ...params.cfg.tools?.media?.[params.capability],
              ...(requestPrompt
                ? { prompt: requestPrompt, _requestPromptOverride: requestPrompt }
                : {}),
              // ...
            },
          },
        },
      }
    : params.cfg;
```

**为什么用这种「克隆配置」而不是单独传参？** 这样下游的 `runCapability`、provider 解析逻辑只需读 `cfg.tools.media[capability]` 一个地方，不必到处接收额外参数。`_requestPromptOverride` 这个带下划线前缀的字段是内部标记，用于区分「请求临时指定的 prompt」和「配置文件里的 prompt」。

`transcribeAudioFile`（`src/media-understanding/runtime.ts:316`）同理注入 `language` / `prompt`：

```ts
// src/media-understanding/runtime.ts:329
...(params.language ? { _requestLanguageOverride: params.language } : {}),
...(params.prompt ? { _requestPromptOverride: params.prompt } : {}),
```

### 13.5.3 本地文件 vs 远程 URL

`buildFileContext`（`src/media-understanding/runtime.ts:53`）要处理一个微妙的区别：媒体可能是本地磁盘文件，也可能是一个 `https://` URL（比如 Twilio 的 `MediaUrl`）。

```ts
// src/media-understanding/runtime.ts:82
function isRemoteMediaReference(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}
```

如果是远程引用，上下文里放 `MediaUrl`；本地则放 `MediaPath`。MIME 推断也分情况——远程 URL 没有 magic bytes 可嗅探时，会用「扩展名 + capability」拼出 `image/*` 这类通配类型。

读取远程图片时（`readImageDescriptionInput`，`src/media-understanding/runtime.ts:242`），通过附件缓存下载，并传入 SSRF 策略：

```ts
// src/media-understanding/runtime.ts:262
const cache = createMediaAttachmentCache(attachments, {
  ssrfPolicy: params.cfg.tools?.web?.fetch?.ssrfPolicy,
});
```

这一步很重要：用户发来的「图片 URL」是不可信输入，可能指向内网地址。SSRF 策略由 `tools.web.fetch.ssrfPolicy` 配置统一管控（详见第 14 章）。

### 13.5.4 决策结构与可观测性

媒体理解不只是「成功 / 失败」，它会记录一份**决策树**。`MediaUnderstandingDecision`（`src/media-understanding/types.ts:53`）：

```ts
// src/media-understanding/types.ts:53
export type MediaUnderstandingDecision = {
  capability: MediaUnderstandingCapability;
  outcome: MediaUnderstandingDecisionOutcome;
  attachments: MediaUnderstandingAttachmentDecision[];
};
```

`outcome` 有六种可能（`src/media-understanding/types.ts:31`）：`success` / `failed` / `skipped` / `disabled` / `no-attachment` / `scope-deny`。每个附件还有自己的 `attempts` 列表（`src/media-understanding/types.ts:47`），记录每次 provider/CLI 尝试的结果。

**为什么要记这么细的决策树？** 媒体理解涉及多 provider fallback、scope 检查、附件过滤等多个可能「不出结果」的环节。当用户问「为什么我发的图没被识别」，这棵决策树能精确回答是「能力被禁用」「scope 拒绝」还是「所有 provider 都失败了」。`resolveDecisionFailureReason`（`src/media-understanding/runtime.ts:47`）会从决策树里挖出 `failed` 的原因生成异常消息。

### 13.5.5 Scope：按频道决定要不要理解媒体

`scope.ts` 解决一个隐私/成本问题：不是所有频道里的图片都该送给模型理解。`resolveMediaUnderstandingScope`（`src/media-understanding/scope.ts:22`）按规则列表做匹配：

```ts
// src/media-understanding/scope.ts:37
for (const rule of scope.rules ?? []) {
  if (!rule) {
    continue;
  }
  const action = normalizeDecision(rule.action) ?? "allow";
  const match = rule.match ?? {};
  const matchChannel = normalizeOptionalLowercaseString(match.channel);
  const matchChatType = normalizeMediaUnderstandingChatType(match.chatType);
  const matchPrefix = normalizeOptionalLowercaseString(match.keyPrefix);

  if (matchChannel && matchChannel !== channel) {
    continue;
  }
  if (matchChatType && matchChatType !== chatType) {
    continue;
  }
  if (matchPrefix && !sessionKey.startsWith(matchPrefix)) {
    continue;
  }
  return action;
}
return normalizeDecision(scope.default) ?? "allow";
```

规则按声明顺序匹配，第一条命中的就生效；都不命中走 `scope.default`，再没有就默认 `allow`。匹配维度有三个：`channel`（哪个频道）、`chatType`（私聊 / 群聊）、`keyPrefix`（session key 前缀）。

**典型用法：** 在公开群聊里关闭媒体理解（省钱、避免误把群里的图都送模型），只在与主人的私聊里开启。`scope-deny` 这个 outcome 就来自这里。

### 13.5.6 结构化抽取

`extractStructuredWithModel`（`src/media-understanding/runtime.ts:281`）是一个特殊能力——它不是「描述图片」，而是「按给定 JSON Schema 从图片里抽取结构化数据」（比如从发票图片里抽出金额、日期）：

```ts
// src/media-understanding/runtime.ts:281
export async function extractStructuredWithModel(params: ExtractStructuredWithModelParams) {
  const timeoutMs = params.timeoutMs ?? 30_000;
  if (!hasStructuredImageInput(params.input)) {
    throw new Error("Structured extraction requires at least one image input.");
  }
  const provider = getMediaUnderstandingProvider(
    params.provider,
    buildMediaUnderstandingRegistry(undefined, params.cfg),
  );
  if (!provider?.extractStructured) {
    throw new Error(`Provider does not support structured extraction: ${params.provider}`);
  }
  return await provider.extractStructured({ /* ... jsonSchema, jsonMode ... */ });
}
```

不是所有 provider 都支持它——`provider?.extractStructured` 是可选方法。这体现了 OpenClaw 的能力分级：基础的 `describeImage` 人人有，进阶的 `extractStructured` 由 provider 自愿实现。

---

## 13.6 媒体生成：图像 / 视频 / 音乐

### 13.6.1 三个目录 + 一个共享目录

媒体生成被拆成四个目录，职责划分清晰：

| 目录 | 职责 |
| --- | --- |
| `src/image-generation/` | 图像生成的运行时、provider 注册、参数归一化 |
| `src/video-generation/` | 视频生成的运行时、provider 注册、capability overlay |
| `src/music-generation/` | 音乐生成的运行时、provider 注册 |
| `src/media-generation/` | **三者共享**的模型候选解析、参数归一化、catalog 合成 |

`src/media-generation/` 不含任何 provider，它是「公共骨架」。三个具体目录各自调用它的共享函数。

### 13.6.2 共享的模型候选解析

媒体生成最核心的共享逻辑是 `resolveCapabilityModelCandidates`（`media-generation/runtime-shared.ts:196`）——它决定「这次生成要按什么顺序尝试哪些 provider/model」。

它产出一个**候选列表**（`ParsedProviderModelRef[]`），运行时按顺序逐个试，前面的失败就 fallback 到后面的：

```ts
// src/media-generation/runtime-shared.ts:245
const override = (() => {
  return resolveCandidate(params.modelOverride, { useProviderMetadata: true });
})();
if (override) {
  return [override];          // 显式 override → 只用它，不 fallback
}

const autoProviderFallbackEnabled =
  params.autoProviderFallback ??
  params.cfg.agents?.defaults?.mediaGenerationAutoProviderFallback !== false;
add(params.modelOverride, { useProviderMetadata: true });
add(resolveAgentModelPrimaryValue(params.modelConfig), { useProviderMetadata: autoProviderFallbackEnabled });
for (const fallback of resolveAgentModelFallbackValues(params.modelConfig)) {
  add(fallback, { useProviderMetadata: autoProviderFallbackEnabled });
}
if (autoProviderFallbackEnabled && params.listProviders) {
  for (const candidate of resolveAutoCapabilityFallbackRefs({ /* ... */ })) {
    add(candidate, { useProviderMetadata: false });
  }
}
```

候选来源的优先级是：

1. **显式 `modelOverride`**——如果用户/调用方明确指定了模型，就只用它（直接 `return`，连 fallback 都不做）；
2. agent 配置的主模型；
3. agent 配置的 fallback 模型们；
4. 当 `autoProviderFallback` 开启时，自动把「所有已配置凭据的 provider 的默认模型」加进来。

第 4 步的「自动 provider fallback」由 `resolveAutoCapabilityFallbackRefs`（`src/media-generation/runtime-shared.ts:122`）实现，它会检查每个 provider 是否真的配了凭据：

```ts
// src/media-generation/runtime-shared.ts:98
function isCapabilityProviderConfigured(params: {...}): boolean {
  if (params.provider.isConfigured) {
    return params.provider.isConfigured({ cfg: params.cfg, agentDir: params.agentDir });
  }
  if (resolveEnvApiKey(params.provider.id)?.apiKey) {
    return true;
  }
  const agentDir = normalizeOptionalString(params.agentDir);
  if (!agentDir) {
    return false;
  }
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  return listProfilesForProvider(store, params.provider.id).length > 0;
}
```

它还会把「当前默认 provider」排到候选列表最前面（`src/media-generation/runtime-shared.ts:156`）——这样如果你平时用 OpenAI，图像生成也优先用 OpenAI 的图像模型。

**为什么这套逻辑要共享？** 因为图像/视频/音乐生成都面临同一个问题：用户可能没专门配生成模型，但配了某个厂商的凭据，而那个厂商恰好也能生成图。自动 fallback 让「配了凭据就能用」成为默认体验，无需为每种生成能力单独配置。

### 13.6.3 参数归一化：尺寸 / 宽高比

不同图像模型支持的尺寸、宽高比各不相同。`runtime-shared.ts` 里有一组共享函数把用户请求的尺寸「贴近」到模型实际支持的值。

`resolveClosestAspectRatio`（`src/media-generation/runtime-shared.ts:362`）在模型支持的宽高比列表里找最接近用户请求的那个：

```ts
// src/media-generation/runtime-shared.ts:388
const score = {
  primary: Math.abs(Math.log(parsed.value / requested.value)),
  secondary: Math.abs(parsed.width * requested.height - requested.width * parsed.height),
  tertiary: candidate,
};
if (compareScores(score, bestScore)) {
  bestValue = candidate;
  bestScore = score;
}
```

距离用「比值的对数差」衡量（`Math.abs(Math.log(...))`）——这比简单相减更对称：16:9 和 9:16 离 1:1 的「感知距离」应该相等，对数差正好满足这点。`secondary` 是叉积差做 tiebreak，`tertiary` 是字符串排序保证结果**确定**（这对 prompt cache 很重要，见 `AGENTS.md` 的 "Prompt cache: deterministic ordering" 一条）。

`deriveAspectRatioFromSize`（`src/media-generation/runtime-shared.ts:353`）能从 `"1920x1080"` 这样的尺寸用最大公约数反推出 `"16:9"`：

```ts
// src/media-generation/runtime-shared.ts:353
export function deriveAspectRatioFromSize(size?: string): string | undefined {
  const parsed = parseSizeValue(size);
  if (!parsed) {
    return undefined;
  }
  const divisor = greatestCommonDivisor(parsed.width, parsed.height);
  return `${parsed.width / divisor}:${parsed.height / divisor}`;
}
```

### 13.6.4 Catalog 合成

`media-generation/catalog.ts` 把 provider 声明的 `models` 列表展开成一组「模型目录条目」。`synthesizeMediaGenerationCatalogEntries`（`src/media-generation/catalog.ts:43`）：

```ts
// src/media-generation/catalog.ts:43
export function synthesizeMediaGenerationCatalogEntries<TCapabilities>(params: {
  kind: MediaGenerationCatalogKind;
  provider: MediaGenerationCatalogProvider<TCapabilities>;
  modes?: readonly string[];
}): Array<MediaGenerationCatalogEntry<TCapabilities>> {
  const models = uniqueModels(params.provider);
  return models.map((model) => {
    const entry: MediaGenerationCatalogEntry<TCapabilities> = {
      kind: params.kind,
      provider: params.provider.id,
      model,
      source: "static",
      capabilities: params.provider.capabilities,
    };
    // ... default 标记、label、modes
    return entry;
  });
}
```

`MediaGenerationCatalogKind`（`src/media-generation/catalog.ts:7`）被定义为 `Exclude<UnifiedModelCatalogKind, "text">`——即「除文本外的所有模型种类」。这说明媒体生成的模型目录与文本模型目录是**同一套统一目录系统**（`model-catalog`），只是 kind 不同。这让 UI 可以用一套代码列出「所有可用模型」，不论文本还是图像。

### 13.6.5 图像生成运行时

`image-generation/runtime.ts` 的 `generateImage`（`src/image-generation/runtime.ts:51`）是图像生成的实际入口。它把上面的共享逻辑串起来：

```ts
// src/image-generation/runtime.ts:61
const candidates = resolveCapabilityModelCandidates({
  cfg: params.cfg,
  modelConfig: params.cfg.agents?.defaults?.imageGenerationModel,
  modelOverride: params.modelOverride,
  parseModelRef: parseImageGenerationModelRef,
  agentDir: params.agentDir,
  listProviders,
  autoProviderFallback: params.autoProviderFallback,
});
if (candidates.length === 0) {
  throw new Error(buildNoImageGenerationModelConfiguredMessage(params.cfg, deps));
}
```

然后逐个候选尝试，每次失败都记进 `attempts`：

```ts
// src/image-generation/runtime.ts:77
for (const candidate of candidates) {
  const provider = getProvider(candidate.provider, params.cfg);
  if (!provider) {
    attempts.push({ provider: candidate.provider, model: candidate.model, error });
    continue;
  }
  try {
    const sanitized = resolveImageGenerationOverrides({ provider, /* size, aspectRatio... */ });
    const result: ImageGenerationResult = await provider.generateImage({ /* ... */ });
    if (!Array.isArray(result.images) || result.images.length === 0) {
      throw new Error("Image generation provider returned no images.");
    }
    return { images: result.images, /* ... */ attempts };
  } catch (err) {
    lastError = err;
    const described = isFailoverError(err) ? describeFailoverError(err) : undefined;
    attempts.push({ provider: candidate.provider, model: candidate.model, /* ... */ });
  }
}
return throwCapabilityGenerationFailure({ capabilityLabel: "image generation", attempts, lastError });
```

注意 `resolveImageGenerationOverrides`（在 `normalization.ts`）会调用 13.6.3 的归一化逻辑，把请求的 `size` / `aspectRatio` 贴近到这个 provider 支持的值，并返回 `ignoredOverrides`（哪些参数被这个 provider 忽略了）。最终结果会带上 `buildMediaGenerationNormalizationMetadata`——告诉调用方「你要的是 1:1，但实际用了 1:1，并且这个 provider 不支持 background 参数」之类的透明信息。

图像 provider 注册表 `provider-registry.ts` 还做了原型污染防护：

```ts
// src/image-generation/provider-registry.ts:8
const UNSAFE_PROVIDER_IDS = new Set(["__proto__", "constructor", "prototype"]);
// ...
function isSafeImageGenerationProviderId(id: string | undefined): id is string {
  return Boolean(id && !UNSAFE_PROVIDER_IDS.has(id));
}
```

provider id 会进 Map 作为键，显式拒绝危险键名是一道纵深防御。

视频生成（`video-generation/runtime.ts`）、音乐生成（`music-generation/runtime.ts`）的结构与图像几乎一致——同样 `resolveCapabilityModelCandidates` → 逐候选尝试 → 记 `attempts` → fallback。视频额外有 `capability-overlays.ts`（按模型叠加能力元数据，如时长支持）和 `duration-support.ts`。

### 13.6.6 生成结果的图像资产处理

`image-generation/image-assets.ts` 处理生成结果的字节层细节。`sniffImageMimeType`（`src/image-generation/image-assets.ts:55`）通过 magic bytes 嗅探真实图片类型：

```ts
// src/image-generation/image-assets.ts:59
if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
  return { mimeType: "image/jpeg", extension: "jpg" };
}
if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 /* PNG */) {
  return { mimeType: "image/png", extension: "png" };
}
```

**为什么不信 provider 声称的 MIME？** provider 可能在响应里标错类型，或返回 data URL 里写的 MIME 与实际字节不符。嗅探 magic bytes 保证落盘文件的扩展名与内容一致——这对下游「按扩展名判断类型」的代码很关键。`parseImageDataUrl`（`src/image-generation/image-assets.ts:96`）则用正则从 `data:image/...;base64,...` 里抽出 MIME 和 base64 体。

---

## 13.7 媒体存储与 TTL 清理

### 13.7.1 src/media 的职责

`src/media/` 是所有媒体能力的「地基」——77 个文件，涵盖 MIME 检测、文件落盘、图像处理、Web 媒体抓取、QR 码、PDF 抽取等。本节聚焦其中与「存储 + 清理」直接相关的部分：`store.ts`。

### 13.7.2 媒体目录与权限

媒体文件落在配置目录下的 `media/` 子目录：

```ts
// src/media/store.ts:21
const resolveMediaDir = () => path.join(resolveConfigDir(), "media");
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024; // 5MB default
```

文件权限的设计很有讲究：

```ts
// src/media/store.ts:25
// Files are intentionally readable by non-owner UIDs so Docker sandbox containers can access
// inbound media. The containing state/media directories remain 0o700, which is the trust boundary.
const MEDIA_FILE_MODE = 0o644;
```

```ts
// src/media/store.ts:83
function openMediaStore(maxBytes = MAX_BYTES) {
  return fileStore({
    rootDir: resolveMediaDir(),
    dirMode: 0o700,           // 目录只有 owner 能进
    maxBytes,
    mode: MEDIA_FILE_MODE,    // 文件 0o644
  });
}
```

**为什么文件是 0o644（其他用户可读）而目录是 0o700（其他用户不可进）？** 这是个刻意的权衡。OpenClaw 的 Docker 沙箱容器以不同 UID 运行，需要读到入站媒体文件——所以文件本身可读。但**目录** `0o700` 才是真正的信任边界：别的本地用户进不了 `media/` 目录，就拿不到里面文件的路径，0o644 也就无从利用。注释把这句话说得很明确。

### 13.7.3 路径安全：防目录穿越

媒体 id、子目录都可能来自不可信输入。`store.ts` 有三道路径校验：

```ts
// src/media/store.ts:75
function resolveMediaRelativePath(id: string, subdir: string, caller: string): string {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0") || id === "..") {
    throw new Error(`${caller}: unsafe media ID: ${JSON.stringify(id)}`);
  }
  // ...
}
```

`resolveMediaSubdir`（`src/media/store.ts:43`）更严格——拒绝绝对路径（POSIX / Win32 两种都查）、拒绝含 `.` 或 `..` 的段、拒绝 `\0`：

```ts
// src/media/store.ts:50
if (
  subdir.includes("\0") ||
  path.isAbsolute(subdir) ||
  path.posix.isAbsolute(subdir) ||
  path.win32.isAbsolute(subdir)
) {
  throw new Error(`${caller}: unsafe media subdir: ${JSON.stringify(subdir)}`);
}
const segments = subdir.split(/[\\/]+/u);
if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
  throw new Error(`${caller}: unsafe media subdir: ${JSON.stringify(subdir)}`);
}
```

最后 `resolveMediaScopedDir`（`src/media/store.ts:65`）还会用 `isPathInside` 做一次最终校验，确保解析后的目录确实在 `media/` 内部：

```ts
// src/media/store.ts:69
if (!isPathInside(mediaDir, dir)) {
  throw new Error(`${caller}: media subdir escapes media directory: ${JSON.stringify(subdir)}`);
}
```

**为什么要校验两遍（先逐段查 + 最后 isPathInside）？** 逐段校验拦掉显式的 `..`，`isPathInside` 是「不论前面逻辑有没有漏，最终结果必须在边界内」的兜底。纵深防御。

### 13.7.4 TTL 清理

媒体文件是**临时**的——下载来给模型看一眼、或生成出来发给用户后，就没用了。`store.ts` 默认 TTL 只有 2 分钟：

```ts
// src/media/store.ts:24
const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes
```

清理由 `cleanOldMedia`（`src/media/store.ts:188`）执行，它委托给底层 `fileStore` 的 `pruneExpired`：

```ts
// src/media/store.ts:188
export async function cleanOldMedia(ttlMs = DEFAULT_TTL_MS, options: CleanOldMediaOptions = {}) {
  await openMediaStore().pruneExpired({
    maxDepth: options.recursive ? undefined : 1,
    ttlMs,
    recursive: options.recursive ?? true,
    pruneEmptyDirs: options.pruneEmptyDirs,
  });
}
```

清理有两种触发时机：

1. **周期性扫描**——一个定时任务定期调 `cleanOldMedia` 做全量递归清理；
2. **写入时机会式清理**——每次往 store 写新文件后顺手清一下顶层（`src/media/store.ts:493`）：

```ts
// src/media/store.ts:493
await cleanOldMedia(DEFAULT_TTL_MS, { recursive: false });
```

第二种用 `recursive: false`（`maxDepth: 1`）只扫顶层，开销小，目的如注释所说：

```
// src/media/store.ts:706
// from accumulating on disk ahead of the periodic TTL sweep.
```

**为什么 TTL 只有 2 分钟这么短？** 媒体文件是 OpenClaw 数据流里的「过路货」——一旦它被读进 Buffer 送给模型、或被附件系统转发给用户，磁盘上的副本就失去价值。短 TTL 让 `media/` 目录始终保持很小，避免长期运行的网关把磁盘塞满。机会式清理 + 周期清理双保险，确保即使周期任务挂了，正常的写入流量也会顺带清掉旧文件。

### 13.7.5 下载时的 SSRF 防护与大小限制

`downloadToFile`（`src/media/store.ts:204`）从 URL 下载媒体到磁盘时有多重防护：

```ts
// src/media/store.ts:219
if (!["http:", "https:"].includes(parsedUrl.protocol)) {
  reject(new Error(`Invalid URL protocol: ${parsedUrl.protocol}. Only HTTP/HTTPS allowed.`));
  return;
}
const requestImpl = parsedUrl.protocol === "https:" ? httpsRequestImpl : httpRequestImpl;
resolvePinnedHostnameImpl(parsedUrl.hostname)
  .then((pinned) => {
    const req = requestImpl(parsedUrl, { headers, lookup: pinned.lookup }, (res) => {
```

`resolvePinnedHostname`（`src/media/store.ts:13` 导入）做 DNS 钉扎——把主机名解析成 IP 并锁定，防止「DNS 重绑定」攻击在解析与连接之间偷换 IP。下载过程中还做大小限制和重定向跨域 header 清理：

```ts
// src/media/store.ts:240
const redirectHeaders =
  redirectUrl.origin === parsedUrl.origin
    ? headers
    : retainSafeHeadersForCrossOriginRedirect(headers);
```

跨域重定向时，`Authorization` 等敏感头会被 `retainSafeHeadersForCrossOriginRedirect` 剥掉——防止凭据跟着重定向泄露到第三方主机。重定向次数上限 `maxRedirects = 5`（`src/media/store.ts:208`），防重定向循环。

---

## 13.8 这些能力如何作为 provider 插件接入

回到本章开头那张架构图，现在可以把「插件接入」这条线讲透。

### 13.8.1 统一的能力插件机制

所有语音/媒体能力共享同一套插件接入机制。每种能力都有一个 **registry key**（见 13.1 的表），core 通过两个共享函数解析插件：

- `resolvePluginCapabilityProviders({ key, cfg })`——列出该能力的所有 provider；
- `resolvePluginCapabilityProvider({ key, providerId, cfg })`——按 id 取单个 provider。

以 TTS 为例（`tts/provider-registry.ts:14`）：

```ts
// src/tts/provider-registry.ts:14
function resolveSpeechProviderPluginEntries(cfg?: OpenClawConfig): SpeechProviderPlugin[] {
  return resolvePluginCapabilityProviders({
    key: "speechProviders",
    cfg,
  });
}
```

实时转写（`realtime-transcription/provider-registry.ts:19`）、Talk（`talk/provider-registry.ts:19`）、图像生成（`image-generation/provider-registry.ts:22`）的代码几乎逐行相同，只是 `key` 不同。**这种高度重复是有意的**——每种能力的 provider 类型不同（`SpeechProviderPlugin` vs `RealtimeVoiceProviderPlugin`），TypeScript 需要各自的强类型出口，但底层机制完全共用 `buildCapabilityProviderMaps` / `normalizeCapabilityProviderId`。

### 13.8.2 插件如何「跨入」core

`AGENTS.md` 规定了插件与 core 的边界：

> Plugins cross into core only via `openclaw/plugin-sdk/*`, manifest metadata, injected runtime helpers, documented barrels (`api.ts`, `runtime-api.ts`).

具体到语音/媒体能力，一个 provider 插件的接入路径是：

```
  插件的 manifest 声明它提供 "speechProviders" 能力
        │
        ▼
  插件加载时，其 SpeechProviderPlugin 实例被注册进 active runtime registry
        │
        ▼
  core 的 provider-registry 通过 resolvePluginCapabilityProvider 读到它
        │
        ▼
  能力运行时（synthesizeSpeech / generateImage / ...）拿到 provider 实例
        │
        ▼
  调用 provider 的方法（synthesize / createBridge / generateImage / ...）
```

插件实现一个 provider 时，只需满足对应的契约接口（`provider-types.ts` 里定义的那些 type）。对于 OpenAI 兼容的 TTS 厂商，甚至连接口都不用手写——直接调 `createOpenAiCompatibleSpeechProvider`（13.2.4）传一份配置即可。

### 13.8.3 内置打包插件 vs 外部插件

`AGENTS.md` 区分了两类插件：

> Internal bundled plugins ship in core dist; bundled-only facade loader ok only for them.
> External official plugins own package/deps and are excluded from core dist; core uses registry-aware `facade-runtime` or generic contracts.

TTS 的 `speech-core` 就是「内置打包插件」——它随 core 一起发布，所以 `tts-runtime.ts` 可以用 `loadActivatedBundledPluginPublicSurfaceModuleSync` 这种「仅限内置插件」的门面加载器（13.2.1）。而具体厂商（ElevenLabs、Azure、Twilio 等）的 provider 通常是「外部官方插件」——它们有自己的 npm 包和依赖，不进 core 的 dist。

**为什么这样分？** core 包必须保持小且「插件无关」。一个只用文本对话、不用语音的部署，不应该被迫装上 ElevenLabs SDK 的依赖。把 `speech-core` 设为「内置」是因为它只是通用合成框架（缓存、流式、状态机），不绑任何厂商;真正绑厂商 SDK 的代码留在外部插件里，按需安装。

### 13.8.4 全章数据流总览

把本章七种能力放在一起，数据流向是这样的：

```
   入站方向（理解）                       出站方向（生成 / 朗读）
   ────────────────                       ──────────────────────

   用户发图/语音/视频                      助手产出文本回复
        │                                       │
        ▼                                       ▼
   media-understanding                     tts-config（判定是否朗读 + 选音）
   - scope 检查                                  │
   - 多 provider fallback                        ▼
   - 决策树记录                             tts-runtime (speech-core 门面)
        │                                       │
        ▼                                       ▼
   文本（描述/转写）送入模型               SpeechProvider.synthesize / stream
                                                 │
   ─── 实时通话（双向）───                       ▼
   Talk: RealtimeVoiceBridge               audio Buffer / ReadableStream
   - audio-codec 重采样 + μ-law                  │
   - TalkSessionController 回合状态机             ▼
   - 工具调用闭环                           媒体落盘 (src/media/store.ts)
                                            - 路径安全校验
   ─── 生成（图/视频/音乐）───               - 0o700 目录 + 0o644 文件
   media-generation 共享层                  - 2 分钟 TTL 清理
   - resolveCapabilityModelCandidates              │
   - 参数归一化（尺寸/宽高比）                      ▼
   - image/video/music provider             发送给用户
```

贯穿始终的两条主线：

1. **能力抽象 + provider 插件**——core 只写通用循环，厂商实现塞进插件，靠 registry 解耦；
2. **不可信输入处处设防**——用户发来的 URL 走 SSRF 钉扎，媒体落盘走路径穿越校验，生成结果嗅探真实 MIME，临时文件短 TTL 自动清理。

---

## 13.9 本章小结

| 主题 | 关键文件 | 要点 |
| --- | --- | --- |
| TTS 门面 | `src/tts/tts.ts:1`、`src/plugin-sdk/tts-runtime.ts:18` | core 只留类型化门面，实现在内置插件 `speech-core` |
| TTS 配置分层 | `src/tts/tts-config.ts:124` | 全局→agent→channel→account 深合并；`auto` 模式按 4 级优先级判定 |
| OpenAI 兼容 TTS | `src/tts/openai-compatible-speech-provider.ts:188` | 工厂一行生成 provider；凭据查找走 secrets；默认禁私网 |
| 实时转写 | `src/realtime-transcription/websocket-session.ts:469` | 通用 WS 会话：排队补发、有界队列、指数退避重连 |
| Talk 通话 | `src/talk/session-runtime.ts:59`、`src/talk/talk-session-controller.ts:58` | RealtimeVoiceBridge 桥接；回合状态机带 `stale_turn` 防护 |
| 音频编解码 | `src/talk/audio-codec.ts:50` | 带限重采样（sinc + Hann 窗）+ G.711 μ-law |
| 媒体理解 | `src/media-understanding/runtime.ts:112` | 三能力共用一条管线；决策树可观测；scope 按频道控制 |
| 媒体生成共享层 | `src/media-generation/runtime-shared.ts:196` | 候选模型解析 + 自动 provider fallback + 尺寸归一化 |
| 图像生成 | `src/image-generation/runtime.ts:51` | 逐候选尝试、记 `attempts`、归一化元数据透明返回 |
| 媒体存储 | `src/media/store.ts:188` | 0o700 目录 + 0o644 文件；2 分钟 TTL；路径穿越多重校验 |
| 插件接入 | `src/tts/provider-registry.ts:14` 等 | 统一 `resolvePluginCapabilityProvider*`；内置 vs 外部插件 |

下一章（第 14 章）将深入认证与安全体系——本章多次提到的 SecretRef、SSRF 策略、scope 权限将在那里得到完整解释。
