# 第 04 章：Channel 抽象与传输层

> 代码版本锁定：`openclaw/openclaw@50a2481652`（tag `v2026.5.18`，2026-05-18）。本章所有 `file:line` 引用均以仓库根为相对起点。

## 0. 这一章要解决的问题

OpenClaw 的核心卖点是「把你已经在用的二十余种消息渠道统一接入一个 AI 助手」。这句话翻译成工程问题就是：

- WhatsApp、Telegram、Slack、Discord、iMessage、Feishu、微信、WebChat……每个渠道的 API 形状、认证方式、消息模型、限流策略全都不同。
- core（`src/`）必须在不知道任何具体渠道存在的前提下，把入站消息送进 Agent、把 Agent 的回复送出去。
- 渠道实现要能被独立开发、独立加载、独立测试——理想情况下第三方也能写一个新渠道插件。

这要求一个**抽象层**：core 只和「渠道契约」打交道，具体渠道是插件。本章讲清楚这个契约长什么样、消息怎么进出、投递怎么保证可靠、以及一个真实渠道插件（Telegram）和一个内建渠道（WebChat）各自怎么落地。

```
                Channel 层分工全景
  ┌──────────────────────────────────────────────────────────────┐
  │  core (src/)         只认契约，不认具体渠道                    │
  │   │                                                            │
  │   ├─ src/channels/message/   消息类型契约 + 投递运行时         │
  │   ├─ src/channels/plugins/   ChannelPlugin 契约 + 注册表       │
  │   └─ src/plugin-sdk/         插件作者拿到的 SDK seam (barrel)  │
  │                                                                │
  │  渠道插件                                                      │
  │   ├─ extensions/telegram/    外置插件（独立 package）          │
  │   ├─ extensions/slack/  ...  其余 channel extension            │
  │   └─ (WebChat)               内建渠道，由 gateway 直接服务     │
  └──────────────────────────────────────────────────────────────┘
```

---

## 1. Channel 插件模型

### 1.1 为什么 core 对插件保持无关（plugin-agnostic）

`src/channels/registry.ts:22-26` 的注释把这条原则写得很直白：

```ts
// Channel docking: prefer this helper in shared code. Importing from
// `src/channels/plugins/*` can eagerly load channel implementations.
export function normalizeChannelId(raw?: string | null): ChatChannelId | null {
  return normalizeChatChannelId(raw);
}
```

紧接着 `src/channels/registry.ts:24-31` 又强调：

> Keep this light: we do not import channel plugins here (those are "heavy" and can pull in monitors, web login, etc).

核心规则是：**core 里的共享代码绝不直接 `import` 任何渠道实现**。一旦某个共享模块 `import` 了 `extensions/telegram/...`，整个 Telegram 渠道（连同它的 HTTP 监控、长轮询循环、代理逻辑）就会被拖进任何用到那个共享模块的代码路径。后果是：CLI 的一条轻量命令也会冷启动整个 Telegram 子系统；一个渠道的 bug 能波及不相干的功能;启动时间随渠道数量线性膨胀。

所以 core 只和「渠道 ID」（`ChannelId` / `ChatChannelId`，定义在 `src/channels/plugins/channel-id.types.ts` 和 `src/channels/ids.ts`）以及「渠道契约接口」打交道。`registry.ts` 提供 `normalizeAnyChannelId`（`src/channels/registry.ts:28-35`）、`listRegisteredChannelPluginIds`（`src/channels/registry.ts:37`）这类只查注册表、不加载实现的轻量函数。真正加载渠道实现的入口被隔离在 `src/channels/plugins/registry-loader.ts` 和 `module-loader.ts`，由明确的「渠道对接」（channel docking）流程触发，而非随便哪个 `import` 都能引爆。

### 1.2 `ChannelPlugin` 契约

一个渠道实现要满足的完整契约是 `ChannelPlugin`，定义在 `src/channels/plugins/types.plugin.ts:61-106`。它是一个**能力适配器的集合**——`id` / `meta` / `capabilities` 是必填核心，其余几十个字段全是可选的「适配器槽位」：

```ts
// types.plugin.ts:61-72 节选
export type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  defaults?: { queue?: { debounceMs?: number } };
  reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
  setupWizard?: ChannelPluginSetupWizard;
  config: ChannelConfigAdapter<ResolvedAccount>;
  // ... outbound / status / auth / pairing / message / messaging / directory ...
};
```

为什么是「一堆可选适配器」而不是一个统一的大接口？因为渠道能力差异巨大：WhatsApp 有配对（pairing），Telegram 有论坛话题（forum topic），Slack 有交互式块（interactive blocks），WebChat 什么外部认证都不需要。如果把所有能力塞进一个必实现的接口，每个渠道都要为它不支持的能力写一堆空桩。改成「可选适配器槽位」后，渠道只填它真正支持的：Telegram 填 `pairing` / `outbound` / `message` / `directory` ……，WebChat 只填最小集合。core 在用某个能力前先检查对应槽位是否存在。

几个值得注意的槽位：
- `reload`（`src/channels/plugins/types.plugin.ts:70`）：`configPrefixes` 声明「配置树里哪些路径前缀的改动需要重载本渠道」，`noopPrefixes` 声明「哪些前缀改了可忽略」。这正是第 03 章 §5.4 重载计划的数据来源——渠道自己声明它的重载敏感面。
- `defaults.queue.debounceMs`（`src/channels/plugins/types.plugin.ts:67-68`）：渠道为出站队列声明默认去抖窗口。
- `message` vs `messaging`（`src/channels/plugins/types.plugin.ts:97-98`）：`message` 是新的 `ChannelMessageAdapterShape`（见 §2），`messaging` 是更老的适配器，二者并存是渐进迁移的产物。

### 1.3 插件作者拿到的 SDK seam

第三方（以及 OpenClaw 自己的 `extensions/*`）写渠道插件时，**不直接 import core 的内部模块**，而是 import 一个稳定的 SDK 表面（seam）。这个 seam 就是 `src/plugin-sdk/` 下的一组 barrel 文件。看 Telegram 插件的 `runtime-api.ts`：

```ts
// extensions/telegram/runtime-api.ts:1-3 节选
export type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
export type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
export type { TelegramApiOverride } from "./src/send.js";
```

注意它 import 的是 `openclaw/plugin-sdk/...`——一个**包别名**，而不是相对路径深入 core 内部。`src/plugin-sdk/sdk-alias.ts`（被 `src/plugin-sdk/channel-entry-contract.ts:22` 的 `resolveLoaderPackageRoot` 引用）负责把这个别名解析到真实位置。

这层间接的意义：`src/plugin-sdk/` 是 OpenClaw 对插件作者的**公开 API 契约**。core 内部模块可以随意重构、改名、移动，只要 `plugin-sdk/` 这层 barrel 的导出保持稳定，所有插件就不受影响。`plugin-sdk/` 目录里 200 多个文件大多是 `*-runtime.ts`（运行时能力）和契约定义，它们 re-export core 的精选子集。第 03 章 §1.1 提到的 `config-contracts.ts` 就是其中之一——插件拿到的是「配置契约视图」而非整个内部配置树。

---

## 2. 消息类型契约

`src/channels/message/types.ts`（367 行）是 core 和渠道之间「一条出站消息长什么样」的契约。这里的类型是 plugin-agnostic 的——它们用 `TConfig = OpenClawConfig` 泛型参数化，渠道插件用自己的账号配置类型把它特化。

### 2.1 三种发送上下文

core 要发的东西分三类，对应三个上下文类型。基类是 `ChannelMessageSendTextContext`（`src/channels/message/types.ts:138-151`）：

```ts
export type ChannelMessageSendTextContext<TConfig = OpenClawConfig> = {
  cfg: TConfig;
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  replyToIdSource?: "explicit" | "implicit";
  replyToMode?: ReplyToMode;
  threadId?: string | number | null;
  silent?: boolean;
  signal?: AbortSignal;
  gatewayClientScopes?: readonly string[];
};
```

另外两个在它基础上扩展：
- `ChannelMessageSendMediaContext`（`src/channels/message/types.ts:153-162`）：加 `mediaUrl`、`mediaAccess`、`audioAsVoice`、`gifPlayback`、`forceDocument` 等媒体字段。
- `ChannelMessageSendPayloadContext`（`src/channels/message/types.ts:164-174`）：加一个完整的 `payload: ReplyPayload`——payload 是 Agent 产出的结构化回复，可能含多种富内容。

为什么不合并成一个全字段上下文？因为渠道适配器把这三者作为**独立可选方法**实现（见下文 `ChannelMessageSendAdapter`）。一个渠道可能只支持纯文本不支持媒体，分开后类型系统能精确表达「这个渠道有 `text` 没有 `media`」。`ChannelMessageSendAttemptContext`（`src/channels/message/types.ts:183-186`）用一个带 `kind` 判别字段的联合把三者重新合一，供需要统一处理的代码用。

### 2.2 `MessageReceipt`：发送的确定性凭据

发送成功后，渠道必须返回一个 `MessageReceipt`（`src/channels/message/types.ts:61-71`）：

```ts
export type MessageReceipt = {
  primaryPlatformMessageId?: string;
  platformMessageIds: string[];
  parts: MessageReceiptPart[];
  threadId?: string;
  replyToId?: string;
  editToken?: string;
  deleteToken?: string;
  sentAt: number;
  raw?: readonly MessageReceiptSourceResult[];
};
```

回执的核心是 `platformMessageIds`——平台侧的消息 ID 列表。为什么是**列表**而不是单个 ID？因为一次「逻辑发送」可能在平台上落成多条消息：一段长文本被切分，一个 payload 同时含文本和图片。`parts`（`MessageReceiptPart`，`src/channels/message/types.ts:52-59`）逐条记录每段的 `platformMessageId` / `kind`（text/media/voice/card…）/ `index` / `threadId`。

回执为什么重要？两个用途：
1. **`threadId`**——把回复挂回正确的会话线程。第 03 章讲的配置里渠道有 threading 能力，回执里的 `threadId` 就是它的运行时载体。
2. **`editToken` / `deleteToken`**——后续要编辑或撤回这条消息（Live 预览、流式更新场景）需要的句柄。

`MessageReceiptSourceResult`（`src/channels/message/types.ts:37-48`）是「平台原始返回」的归一化形状，`raw` 字段保留它供调试和高级场景。`src/channels/message/receipt.ts` 的 `createMessageReceiptFromOutboundResults` 负责把底层投递结果组装成回执。

### 2.3 `ChannelMessageSendAdapter`：渠道实现的发送槽位

渠道把发送能力实现成 `ChannelMessageSendAdapter`（`src/channels/message/types.ts:253-261`）：

```ts
export type ChannelMessageSendAdapter<TConfig, TSendResult> = {
  text?: (ctx: ChannelMessageSendTextContext<TConfig>) => Promise<TSendResult>;
  media?: (ctx: ChannelMessageSendMediaContext<TConfig>) => Promise<TSendResult>;
  payload?: (ctx: ChannelMessageSendPayloadContext<TConfig>) => Promise<TSendResult>;
  lifecycle?: ChannelMessageSendLifecycleAdapter<TConfig, TSendResult>;
};
```

三个发送方法全可选——渠道只实现它支持的。`lifecycle` 是钩子集合（见 §5）。这些适配器最终被装进 `ChannelMessageAdapterShape`（`src/channels/message/types.ts:329-338`），那才是挂在 `ChannelPlugin.message` 槽位上的完整对象，它还含 `durableFinal`（投递可靠性）、`live`（实时预览）、`receive`（入站 ack 策略）三个子适配器。

---

## 3. send 运行时

`src/channels/message/send.ts`（349 行）是「把一批 payload 真正送出去」的运行时。它不是某个渠道的代码——它是 core 侧的发送编排器，调用底层的 outbound 投递设施（`src/infra/outbound/deliver.ts`），再把结果整理成回执。

### 3.1 `MessageSendContext`：发送的状态机

`src/channels/message/types.ts:118-136` 的 `MessageSendContext` 是一个带行为方法的上下文对象，它把一次发送建模成显式状态机：

```ts
export type MessageSendContext<TPayload, TSendResult> = {
  id: string; channel: string; to: string;
  durability: Exclude<MessageDurabilityPolicy, "disabled">;
  attempt: number;
  signal: AbortSignal;
  render(): Promise<RenderedMessageBatch<TPayload>>;
  previewUpdate(rendered): Promise<LiveMessageState<TPayload>>;
  send(rendered): Promise<TSendResult>;
  edit(receipt, rendered): Promise<MessageReceipt>;
  delete(receipt): Promise<void>;
  commit(receipt): Promise<void>;
  fail(error): Promise<void>;
};
```

`render → send → commit`（成功）或 `render → send → fail`（失败）是主路径，`edit` / `delete` / `previewUpdate` 服务 Live 预览场景。把这些做成上下文方法而非散落的函数，是为了让发送的每个阶段都能被钩子和重试逻辑统一拦截。

### 3.2 `withDurableMessageSendContext`：构造上下文

`src/channels/message/send.ts:155-334` 的 `withDurableMessageSendContext(params, run)` 构造一个 `DurableMessageSendContext` 并把它交给 `run` 回调。它把 §3.1 那些方法逐个实现出来。最核心的是 `send`（`src/channels/message/send.ts:198-293`），它调底层投递并把结果分类：

```ts
// send.ts:177 —— durability 决定队列策略
const queuePolicy = durability === "best_effort" ? "best_effort" : "required";
```

`send` 的返回值是 `DurableMessageBatchSendResult`（`src/channels/message/send.ts:72-102`），一个判别联合，把发送结果穷举成四种状态：

| status | 含义 | 触发条件 |
|---|---|---|
| `sent` | 全部送达 | 有结果、无失败 outcome |
| `suppressed` | 被抑制，未发出任何东西 | `results.length === 0`（如被 hook 取消、无可见内容） |
| `partial_failed` | 部分送达后失败 | 有失败 outcome 但已有结果落地 |
| `failed` | 完全失败 | 失败且无任何结果 |

为什么要这么细分？因为「部分发送成功」是真实存在的：一个批次里第一条图片发出去了、第二条文本超时了。如果只有「成功/失败」二态，`partial_failed` 会被误判成完全失败，导致重试时把已经发出去的第一条又发一遍。`src/channels/message/send.ts:223-242` 专门处理这个：检测到失败 outcome 时，看 `results.length > 0` 决定是 `partial_failed` 还是 `failed`。

### 3.3 `sendDurableMessageBatch`：标准发送流程

`src/channels/message/send.ts:336-349` 的 `sendDurableMessageBatch` 是给普通调用方的便捷入口，它把状态机跑完整条：

```ts
export async function sendDurableMessageBatch(params): Promise<DurableMessageBatchSendResult> {
  return await withDurableMessageSendContext(params, async (ctx) => {
    const rendered = await ctx.render();
    const result = await ctx.send(rendered);
    if (result.status === "sent" || result.status === "suppressed") {
      await ctx.commit(result.receipt);
    } else {
      await ctx.fail(result.error);
    }
    return result;
  });
}
```

注意 `suppressed` 也走 `commit`——「被有意抑制」是一个**成功的终态**，不是错误。只有 `failed` / `partial_failed` 走 `fail`。`withDurableMessageSendContext` 外层还有一个 `try/catch`（`src/channels/message/send.ts:327-333`），保证 `run` 回调里任何抛出的异常都会先调 `ctx.fail` 做清理再向上传播。`ctx.fail`（`src/channels/message/send.ts:316-324`）自身又裹了一层 try/catch——清理逻辑失败不能掩盖原始的发送错误。

```
        发送编排数据流
  调用方 payloads[]
       │
       ▼  sendDurableMessageBatch()
  withDurableMessageSendContext()  ── 构造 DurableMessageSendContext
       │
       ▼  ctx.render()
  RenderedMessageBatch  ── createRenderedMessageBatch(payloads)
       │
       ▼  ctx.send(rendered)
  deliverOutboundPayloadsInternal()  ── infra/outbound/deliver.ts
       │  (queuePolicy = required | best_effort)
       ▼
  OutboundDeliveryResult[]
       │  createMessageReceiptFromOutboundResults()
       ▼
  MessageReceipt  ──► result: sent | suppressed | partial_failed | failed
       │
       ├─ sent/suppressed ──► ctx.commit(receipt)
       └─ failed/partial  ──► ctx.fail(error)
```

---

## 4. 投递持久化策略 durability

`src/channels/message/types.ts:7` 定义了投递可靠性的三档：

```ts
export type MessageDurabilityPolicy = "required" | "best_effort" | "disabled";
```

含义与权衡：

| 策略 | 行为 | 适用场景 |
|---|---|---|
| `required` | 进持久化队列，失败重试，进程重启后续投 | 用户可见的助手回复——丢了就是「助手没回我」 |
| `best_effort` | 尝试投递，失败不重试 | 输入态指示、已读回执这类瞬时信号——过期就无意义 |
| `disabled` | 不走持久化路径 | 完全不需要可靠性保证的内部消息 |

`src/channels/message/send.ts:177` 把 `durability` 映射成底层 `queuePolicy`：`best_effort` → `"best_effort"`，其余 → `"required"`。注意 `MessageSendContext` 和 `DurableMessageSendIntent` 的 `durability` 字段类型都是 `Exclude<MessageDurabilityPolicy, "disabled">`（`src/channels/message/types.ts:123`、`src/channels/message/types.ts:365`）——一旦进入「durable 发送」这条运行时，`disabled` 在类型上就被排除了，因为走到 `send.ts` 这条路本身就意味着「要做持久化投递」。

### 4.1 durable final delivery 能力协商

`required` 投递有一个额外问题：进程崩溃重启后要重投，但平台可能已经收到了第一次发送——不能盲目重投造成重复。这就需要渠道支持「对账」（reconcile）。`src/channels/message/types.ts:9-24` 定义了一组 durable final delivery 能力：

```ts
export const durableFinalDeliveryCapabilities = [
  "text", "media", "payload", "silent", "replyTo", "thread",
  "nativeQuote", "messageSendingHooks", "batch",
  "reconcileUnknownSend", "afterSendSuccess", "afterCommit",
] as const;
```

渠道在 `ChannelMessageDurableFinalAdapter`（`src/channels/message/types.ts:263-271`）里声明它支持哪些能力，并提供 `reconcileUnknownSend` 回调——给定一个 `ChannelMessageUnknownSendContext`（`src/channels/message/types.ts:207-222`，含 `queueId` / `enqueuedAt` / `retryCount` / payload 等），渠道去平台侧查「这条到底发出去没有」，返回 `sent` / `not_sent` / `unresolved`（`src/channels/message/types.ts:224-237`）。

`src/channels/message/capabilities.ts` 的 `deriveDurableFinalDeliveryRequirements`（`src/channels/message/capabilities.ts:28` 起）反向计算「这条具体消息需要渠道支持哪些 durable 能力」：有媒体就要求 `media`，有 `replyToId` 就要求 `replyTo`，有 `threadId` 就要求 `thread`。core 拿「需求」和渠道声明的「能力」比对——如果一条 `required` 消息需要 `thread` 能力但渠道没声明，core 就知道这条消息在崩溃恢复后无法精确对账，可以提前降级或告警。`src/channels/message/contracts.ts` 提供 `verifyDurableFinalCapabilityProofs` 等一系列 `verify*` 函数（由 `message/index.ts:7-16` 导出），在测试期强制渠道为它声明的每个能力提供一个「证明」（proof），防止渠道声明了能力却没真正实现。

---

## 5. 发送钩子

`src/channels/message/types.ts:239-251` 的 `ChannelMessageSendLifecycleAdapter` 定义了发送生命周期的四个钩子：

```ts
export type ChannelMessageSendLifecycleAdapter<TConfig, TSendResult> = {
  beforeSendAttempt?: (ctx: ChannelMessageSendAttemptContext<TConfig>) => unknown;
  afterSendSuccess?: (ctx: ChannelMessageSendSuccessContext<TConfig, TSendResult>) => Promise<void> | void;
  afterSendFailure?: (ctx: ChannelMessageSendFailureContext<TConfig>) => Promise<void> | void;
  afterCommit?: (ctx: ChannelMessageSendCommitContext<TConfig, TSendResult>) => Promise<void> | void;
};
```

四个钩子对应发送状态机的关键转换点：

- `beforeSendAttempt` —— 每次尝试（含重试）前。可用于改写 payload、注入限流。
- `afterSendSuccess` —— 单次平台发送成功后。此时拿得到 `result`。
- `afterSendFailure` —— 单次发送失败后。
- `afterCommit` —— 整个发送被 commit 之后（`src/channels/message/send.ts:343` 那个 `ctx.commit`）。

`afterSendSuccess` 和 `afterCommit` 的区别是这套设计的微妙之处。`afterSendSuccess` 在「平台确认收到」时触发，`afterCommit` 在「core 把这次发送在内部状态里定案」时触发。对 `required` durability 来说，「平台收到」和「内部定案」之间有一个窗口——这个窗口里如果进程崩溃，恢复逻辑要靠 §4.1 的对账。把两个钩子分开，让渠道能分别在这两个语义点挂逻辑（比如 `afterSendSuccess` 更新平台侧 UI，`afterCommit` 才清理本地草稿）。

除了发送生命周期钩子，还有一类 **message sending hook**——它是 `durableFinalDeliveryCapabilities` 里的 `messageSendingHooks` 能力（`src/channels/message/types.ts:17`）和 `src/channels/message/send.ts:41` 的 `DurableMessageSuppressionReason` 里的 `cancelled_by_message_sending_hook` / `empty_after_message_sending_hook`。这是一个**能取消或改写整条消息**的钩子，跑在更外层（用户配置的 `hooks` 段，见第 03 章配置树）。如果它取消了消息，`src/channels/message/send.ts:198-254` 的 `send` 就会因为 `results.length === 0` 返回 `suppressed`，`reason` 标记成 hook 取消。这就是「pre-send 钩子」和上面四个「lifecycle 钩子」的分层：message sending hook 决定「这条消息要不要发、发什么」，lifecycle 钩子观察「这条消息发的过程」。

---

## 6. 一个 channel extension 的结构：Telegram

`extensions/telegram/` 是一个完整的渠道插件，也是理解「插件结构」的最佳样本。它是一个独立的 npm package（有自己的 `package.json`），通过 `openclaw/plugin-sdk` 别名依赖 core。

### 6.1 插件清单与入口

`extensions/telegram/openclaw.plugin.json` 是插件清单：

```json
{
  "id": "telegram",
  "activation": { "onStartup": false },
  "channels": ["telegram"],
  "channelEnvVars": { "telegram": ["TELEGRAM_BOT_TOKEN"] },
  "configSchema": { "type": "object", "additionalProperties": false, "properties": {} }
}
```

- `activation.onStartup: false` —— 不在网关启动时无条件加载。Telegram 渠道只在配置里真正启用了才被加载。这正是 §1.1「core 对插件无关」原则的运行时兑现：没用的渠道根本不进内存。
- `channelEnvVars` —— 声明本渠道认哪些环境变量。`TELEGRAM_BOT_TOKEN` 这个名字必须和第 03 章 `.env.example:74` 里的对得上。
- `channels: ["telegram"]` —— 本插件提供哪些渠道 ID。

`extensions/telegram/index.ts` 是运行入口，它调 `defineBundledChannelEntry`（来自 `openclaw/plugin-sdk/channel-entry-contract`）声明一组「模块引用」：

```ts
// extensions/telegram/index.ts 节选
export default defineBundledChannelEntry({
  id: "telegram", name: "Telegram",
  importMetaUrl: import.meta.url,
  plugin:  { specifier: "./channel-plugin-api.js", exportName: "telegramPlugin" },
  secrets: { specifier: "./secret-contract-api.js", exportName: "channelSecrets" },
  runtime: { specifier: "./runtime-setter-api.js", exportName: "setTelegramRuntime" },
  accountInspect: { specifier: "./account-inspect-api.js", exportName: "inspectTelegramReadOnlyAccount" },
});
```

关键点：入口本身**不 import 实现**，只声明「需要时去哪个 specifier 取什么导出」。`channel-entry-contract.ts` 的 `getCachedPluginSourceModuleLoader`（`src/plugin-sdk/channel-entry-contract.ts:18`）负责按需懒加载这些模块。这把「插件被发现」和「插件被加载」彻底解耦——网关启动时只需要读清单和入口的轻量声明，沉重的实现按需才进内存。

### 6.2 各 barrel 的分工

Telegram 插件根目录有十几个 `*-api.ts` 文件，每个是一个**窄 barrel**——把 `src/` 下的实现按「用途」重新分组导出。这种分层不是冗余，而是为了让不同的加载路径只拉它需要的那部分。`channel-plugin-api.ts` 的注释说得最清楚：

```ts
// extensions/telegram/channel-plugin-api.ts
// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not drag the broad Telegram API barrel into lightweight plugin loads.
export { telegramPlugin } from "./src/channel.js";
export { telegramSetupPlugin } from "./src/channel.setup.js";
```

各 barrel 的职责：

| barrel | 导出什么 | 谁来加载它 |
|---|---|---|
| `channel-plugin-api.ts` | `telegramPlugin`（完整 `ChannelPlugin` 对象）、setup 插件 | 渠道真正激活时 |
| `runtime-api.ts` | 几十个运行时函数 + 类型：发送、监控、探针、线程绑定、token 解析、代理 fetch | 渠道运行期，是最「宽」的 barrel |
| `secret-contract-api.ts` | `channelSecrets`、`secretTargetRegistryEntries`、`collectRuntimeConfigAssignments` | 密钥解析路径 |
| `config-api.ts` / `channel-config-api.ts` | `TelegramConfigSchema`、命令名归一化 | 配置校验 / schema 路径 |
| `contract-api.ts` | doctor 兼容规则、目录配置、安全审计、交互分发 | 诊断 / 设置流程 |

为什么 `channel-plugin-api.ts` 要刻意保持「窄」？因为 bootstrap/discovery（启动期的插件发现）只想知道「这个插件长什么样」，不该顺带把 `runtime-api.ts` 里的 HTTP 监控、长轮询、代理 fetch 全拉进来。把入口 barrel 切窄，发现路径的内存和启动开销就被压住了。`runtime-api.ts` 反过来是最宽的——它服务的是「渠道已经在跑」的路径，那时本来就需要全部能力。

`runtime-api.ts` 还展示了 SDK seam 的用法（§1.3）：它一边 `export ... from "openclaw/plugin-sdk/..."`（把 SDK 的东西转发给插件内部其他文件），一边 `export ... from "./src/..."`（导出 Telegram 自己的实现）。插件作者写 `./src/*.ts` 时，统一从这些 barrel 取依赖，而不是到处写相对路径或直接钻 core 内部。

### 6.3 setup 与 runtime 的分离

注意 `index.ts`（运行入口）和 `setup-entry.ts`（设置入口，`extensions/telegram/setup-entry.ts`）是两个独立入口。`setup-entry.ts` 用 `defineBundledChannelSetupEntry` 声明了 setup 插件、密钥契约、以及 `legacyStateMigrations`（旧状态迁移）。「设置渠道」（跑配对向导、迁移旧状态）和「运行渠道」（收发消息）是不同生命周期阶段，需要的代码不同——分成两个入口让「只是想跑设置向导」时不必加载收发消息的运行时。

---

## 7. WebChat 渠道

WebChat 是 OpenClaw 自带的一个浏览器内聊天渠道。它和其他渠道有一个根本区别：**它不是 `extensions/` 下的外置插件，而是由 Gateway 直接服务的内建渠道**。`extensions/` 里没有 `webchat` 目录；WebChat 的运行时逻辑分布在 `src/gateway/`。

### 7.1 为什么 WebChat 是内建的

其他渠道（Telegram、Slack…）是「桥接到外部平台」——它们需要外部平台的 token、要和外部 API 通信、要处理外部认证。WebChat 不一样：它的「平台」就是 OpenClaw Gateway 自己。浏览器直接连到网关，消息不出网关进程。因此：

- 它没有外部 token，不需要 `channelEnvVars`。
- 它没有配对流程，不需要 `pairing` 适配器。
- 它的认证就是网关自己的认证（`OPENCLAW_GATEWAY_TOKEN`，见第 03 章 §7.1）。

把它做成插件反而别扭——插件模型是为「桥接外部平台」设计的，WebChat 没有外部平台。所以它内建在 gateway 里。

### 7.2 `INTERNAL_MESSAGE_CHANNEL`

`src/utils/message-channel-constants.ts:1` 把 WebChat 钉成「内部渠道」常量：

```ts
export const INTERNAL_MESSAGE_CHANNEL = "webchat" as const;
```

core 里大量代码（`src/auto-reply/`、`src/agents/`、`src/config/sessions/group.ts` 等几十个文件，可以 `grep -rln "webchat" src` 看到）引用这个常量，把 `"webchat"` 当作「来自网关自身、不经过外部平台」的标志渠道。例如系统提示词构造（`src/agents/system-prompt.ts`）、消息工具（`src/agents/tools/message-tool.ts`）、静默回复策略（`src/shared/silent-reply-policy.ts`）都对 WebChat 有特殊分支——因为它是 trace 导览和本地交互的默认面。

### 7.3 WebChat 的媒体路径

WebChat 渠道服务的核心实现之一是 `src/gateway/server-methods/chat-webchat-media.ts`。因为 WebChat 跑在浏览器里，Agent 回复里的媒体（图片、语音）要直接嵌进网页，而不是像 Telegram 那样上传到外部平台。这个文件就是把 Agent 产出的 `ReplyPayload` 转成浏览器能直接渲染的内容块。

它体现了「内建渠道也要遵守同样的安全约束」：

```ts
// chat-webchat-media.ts:11-23 节选
const MAX_WEBCHAT_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_WEBCHAT_IMAGE_DATA_URL_CHARS = 2_000_000;
const MAX_WEBCHAT_IMAGE_DATA_BYTES = 1_500_000;
const ALLOWED_WEBCHAT_DATA_IMAGE_MEDIA_TYPES = new Set([
  "image/apng", "image/avif", "image/bmp", "image/gif",
  "image/jpeg", "image/png", "image/webp",
]);
```

- 音频文件嵌入有 15MB 上限——防止一个超大文件把网页内存撑爆。
- 图片以 data URL 内联，但限制字符数和字节数——data URL 内联避免了额外 HTTP 往返，但不加上限就是 DoS 入口。
- 媒体类型白名单——只允许已知安全的图片格式。

`chat-webchat-media.ts` 公开两个函数：`buildWebchatAudioContentBlocksFromReplyPayloads`（`src/gateway/server-methods/chat-webchat-media.ts:178`）和 `buildWebchatAssistantMessageFromReplyPayloads`（`src/gateway/server-methods/chat-webchat-media.ts:205`）。本地媒体路径的解析走 `resolveLocalMediaPathForEmbedding`（`src/gateway/server-methods/chat-webchat-media.ts:50` 附近），并通过 `assertLocalMediaAllowed`、`assertNoWindowsNetworkPath`、`safeFileURLToPath`（`src/gateway/server-methods/chat-webchat-media.ts:3-7` 引入）做路径安全校验——WebChat 能嵌本地文件，所以必须防「让 WebChat 嵌入任意系统文件」的路径穿越攻击。

WebChat 是本 wiki 配套的「单请求叙事 trace 导览」所追踪的渠道——因为它路径最短（消息不出网关进程），最适合把「一条消息从入站到 Agent 到回复出站」的完整链路讲清楚。

---

## 8. 小结

本章拆解了 OpenClaw 的 Channel 抽象与传输层：

| 主题 | 核心机制 | 关键文件 |
|---|---|---|
| 插件无关 | core 只认 `ChannelId` 与契约，绝不 import 渠道实现 | `channels/registry.ts:22-31` |
| 渠道契约 | `ChannelPlugin` 的可选适配器槽位集合 | `channels/plugins/types.plugin.ts:61-106` |
| SDK seam | `src/plugin-sdk/` barrel 作为对插件的稳定公开 API | `extensions/telegram/runtime-api.ts` |
| 消息契约 | 三种发送上下文 + `MessageReceipt` | `channels/message/types.ts` |
| 发送运行时 | `MessageSendContext` 状态机 + 四态结果 | `channels/message/send.ts` |
| 投递可靠性 | `required`/`best_effort`/`disabled` + 能力协商对账 | `channels/message/types.ts:7-24`、`capabilities.ts` |
| 发送钩子 | 4 个 lifecycle 钩子 + message sending hook | `channels/message/types.ts:239-251` |
| 插件结构 | 窄/宽 barrel 分层 + 懒加载入口 | `extensions/telegram/` |
| WebChat | 内建渠道，由 gateway 直接服务 | `gateway/server-methods/chat-webchat-media.ts` |

贯穿全章的设计哲学是**用契约和懒加载把「core」和「渠道」彻底解耦**：core 永远不知道 Telegram 存在，渠道永远不碰 core 内部；插件按需才进内存；新渠道只需实现它支持的那部分适配器槽位。这正是「统一接入二十余种渠道」这个产品承诺在工程上可持续的前提。下一章将进入入站消息的处理链路，本章的 `MessageReceipt` 与发送运行时会在那里和 Agent 回复管线接上。
