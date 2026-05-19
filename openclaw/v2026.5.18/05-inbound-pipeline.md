# 第 05 章 入站消息管线

> 代码版本锁定：`openclaw/openclaw@50a2481652`（tag `v2026.5.18`，2026-05-18）。
> 本章所有 `file:line` 引用均为仓库根相对路径。

## 0. 本章要解决的问题

OpenClaw 把二十余种异构消息渠道（Telegram、Slack、WhatsApp、Signal、Matrix、
飞书、Discord、邮件、网页聊天……）统一接入一个 LLM 助手。每个渠道的原始
载荷千差万别：Telegram 有 forum topic、Slack 有 subteam mention、飞书有
`root_id`、WhatsApp 有 E.164 电话号码。如果让 agent 执行层直接面对这些
差异，每加一个渠道都要改一遍核心逻辑，复杂度会爆炸。

入站管线（inbound pipeline）就是这道**收敛层**。它的契约可以一句话概括：

> 无论消息从哪个渠道来，进入 agent 执行层之前都必须被规整成同一种数据结构
> ——`MsgContext`——并且经过一次确定性的「定稿」（finalize），使下游永远
> 不必关心渠道差异，也永远不必担心字段缺失。

本章按一条入站消息的真实旅程展开：

```
渠道插件原始载荷
      │  (各渠道适配代码)
      ▼
buildChannelInboundEventContext()         ← 把渠道事实装进 MsgContext
      │
      ▼
finalizeInboundContext()                  ← 规范化 / 默认拒绝 / 派生字段
      │  得到 FinalizedMsgContext
      ▼
dispatchInboundMessage()                  ← 入站分发总协调器
      │
      ├─ resolveDispatcherSilentReplyContext()   静默回复策略
      ├─ beginForegroundReplyFence()              前台代次围栏
      ▼
dispatchReplyFromConfig()                 ← 会话解析 + agent 执行 + 投递
      │
      ▼
ReplyDispatcher → 渠道出站
```

涉及的核心文件：

| 关注点 | 文件 |
|--------|------|
| `MsgContext` / `FinalizedMsgContext` 类型 | `src/auto-reply/templating.ts` |
| 入站分发协调器 | `src/auto-reply/dispatch.ts` |
| 定稿逻辑 | `src/auto-reply/reply/inbound-context.ts` |
| 渠道事实 → MsgContext | `src/channels/inbound-event/context.ts` |
| 命令回合解析 | `src/auto-reply/command-turn-context.ts` |
| 命令检测 | `src/auto-reply/command-detection.ts` |
| 会话键派生 | `src/config/sessions/session-key.ts` |
| 关键回复类型 | `src/auto-reply/get-reply-options.types.ts`、`src/auto-reply/reply-payload.ts` |
| 类型再导出门面 | `src/auto-reply/types.ts` |

---

## 1. `MsgContext`：入站消息信封

### 1.1 为什么需要一个「信封」

`MsgContext` 定义在 `src/auto-reply/templating.ts:42`。它不是一个「消息」，
而是一个**信封**（envelope）——一个汇集了「围绕这条入站消息所能知道的一切
事实」的扁平记录。它有意做成一个巨大的可选字段袋（`src/auto-reply/templating.ts:42-281`，
约 240 行字段定义），原因有三：

1. **跨渠道并集**。任何单个渠道都只会填其中一部分字段。Telegram 填
   `MessageThreadId`/`IsForum`/`Sticker`；Slack 填 `MentionedSubteamIds`；
   邮件填 `ForwardedFrom*`。把所有渠道的字段做成一个并集类型，下游就只需
   面对一个类型，按需读取。
2. **可选即默认缺省**。所有字段都是 `?:` 可选。渠道适配代码不需要构造
   完整对象，只填它知道的；下游用 `??` 兜底。这让新增渠道几乎零成本。
3. **它同时是模板上下文**。`MsgContext` 被 `TemplateContext`
   （`src/auto-reply/templating.ts:296`）扩展后直接喂给 `applyTemplate()`
   （`src/auto-reply/templating.ts:338`）做 `{{Placeholder}}` 插值。信封字段名
   （`From`、`SenderName`、`ChatType`……）即是模板占位符名。

### 1.2 字段分组导览

240 行字段并非杂乱无章，按职责可分为几组。

**消息正文的多重表示**（`src/auto-reply/templating.ts:43-71`）。这是初次阅读最易困惑之处
——为什么一条消息有 `Body`、`BodyForAgent`、`RawBody`、`CommandBody`、
`BodyForCommands` 五个正文字段？答案是不同消费者需要不同「净度」的文本：

| 字段 | 用途 | 净度 |
|------|------|------|
| `Body` (`:43`) | 原始正文，可能含信封头/历史 | 最脏 |
| `BodyForAgent` (`:49`) | 喂给 LLM 的提示词正文 | 含结构上下文 |
| `RawBody` (`:61`) | 已废弃，`CommandBody` 的旧别名 | — |
| `CommandBody` (`:65`) | 命令检测优先用 | 去掉信封 |
| `BodyForCommands` (`:70`) | 命令解析最优先 | 「干净」文本 |

为什么要拆这么细？因为**命令检测**和**提示词组装**对文本的要求相反。
命令检测需要绝对干净的文本——`/status` 必须出现在行首才算命令，群聊里
拼接的发送者标签（`Alice: /status`）会污染判断；而提示词组装恰恰需要
那些发送者标签和历史上下文来让 LLM 理解语境。一个字段无法同时满足，
于是拆成「面向命令的视图」和「面向 agent 的视图」。`finalizeInboundContext()`
负责在缺字段时按优先级回填（见 §3）。

**会话路由相关**（`src/auto-reply/templating.ts:72-88`）。`From`/`To`/`SessionKey`/
`AccountId`/`ParentSessionKey`/`ModelParentSessionKey`/`RuntimePolicySessionKey`。
其中 `SessionKey` 是路由的终点（决定消息落入哪个会话桶），`From`/`To` 是
路由的输入（在 `SessionKey` 缺省时用来派生，见 §4）。`ModelParentSessionKey`
（`:88`）特别值得注意：它只用于继承模型/provider 覆盖，不触发 transcript
分叉或父会话生命周期——这是一个「我想借你的模型设置，但不想成为你的子会话」
的精细信号。

**消息标识与线程**（`src/auto-reply/templating.ts:89-147`）。`MessageSid` 系列是消息 id；
`ReplyToId`/`RootMessageId`/`ReplyChain`/`ThreadStarterBody` 用于线程重建；
`ForwardedFrom*` 系列描述转发来源。`ReplyChain`（`:108-125`）是一个结构化
数组，每一项是引用链上的一条消息，让 agent 能看到完整的引用上下文。

**媒体**（`src/auto-reply/templating.ts:148-174`）。单数字段（`MediaPath`/`MediaUrl`/
`MediaType`）和复数字段（`MediaPaths`/`MediaUrls`/`MediaTypes`）并存，是
历史演进的结果——早期只支持单附件。`finalizeInboundContext()` 会把两者
对齐补齐（见 §3.4）。`MediaUnderstanding`/`MediaUnderstandingDecisions`
（`:173-174`）是媒体理解管线（音频转写、图像描述）的产物，被回填进信封。

**会话语境**（`src/auto-reply/templating.ts:178-209`）。`ChatType`（direct/group/channel）、
`ConversationLabel`、`GroupSubject`、`GroupMembers`、发送者信息
（`SenderName`/`SenderId`/`SenderE164`……）、地理位置（`Location*`）。

**不可信内容标记**（`src/auto-reply/templating.ts:189-194`）。`UntrustedContext` /
`UntrustedStructuredContext` 是一个安全设计：来自用户的元数据必须被明确
标注为「不可信」，提示词组装层会把它渲染成带围栏的 JSON，**而绝不会**当作
系统指令。这是抵御 prompt injection 的第一道结构性防线。

**渠道与提及**（`src/auto-reply/templating.ts:211-227`）。`Provider`/`Surface`/`BotUsername`、
`WasMentioned`/`ExplicitlyMentionedBot`/`MentionSource`。注释明确写道
「`Surface` 优先于 `Provider`」（`:213`），因为同一个 provider 可能有多个
surface（如 Slack 的 DM surface 与 channel surface）。

**命令回合**（`src/auto-reply/templating.ts:228-236`）。`CommandAuthorized`/`CommandTurn`/
`CommandSource`/`CommandTargetSessionKey`，见 §5。

**回复路由**（`src/auto-reply/templating.ts:255-280`）。`OriginatingChannel`/`OriginatingTo`/
`ExplicitDeliverRoute`：当这条入站消息要求把回复送到与来源不同的渠道时使用。
`HookMessages`（`:280`）让插件钩子能往回复里塞额外文本。

### 1.3 `FinalizedMsgContext`：定稿后的契约升级

```typescript
// src/auto-reply/templating.ts:283
export type FinalizedMsgContext = Omit<MsgContext, "CommandAuthorized"> & {
  CommandAuthorized: boolean;        // :288  从可选升级为必填
  CommandTurn?: CommandTurnContext;  // :293  由 finalize 填充
};
```

这个类型差异是整条管线的关键约定。`MsgContext` 里 `CommandAuthorized?` 是
**可选** `boolean`；`FinalizedMsgContext` 里它是**必填** `boolean`。

为什么？这是一个**默认拒绝**（default-deny）的安全设计。`CommandAuthorized`
门控命令/指令的执行——如果某段渠道适配代码忘记设置它，可选类型下它会是
`undefined`，而 `undefined` 在松散判断下可能被误当作「未明确拒绝」。把
定稿后的类型升级为必填，并由 `finalizeInboundContext()` 强制
`CommandAuthorized === true`（见 §3.3），就保证了「缺失 = false = 拒绝」。
类型系统在此充当了安全不变量的守卫：下游凡是接收 `FinalizedMsgContext` 的
代码，编译期就知道这个字段一定有值。

`src/auto-reply/dispatch.ts` 全程同时接受 `MsgContext | FinalizedMsgContext`
（如 `src/auto-reply/dispatch.ts:245`），并在内部第一步统一调用 `finalizeInboundContext()`
把它收敛为 `FinalizedMsgContext`——这是「在边界处定稿一次，内部只信定稿值」
的典型模式。

---

## 2. 从渠道载荷到 `MsgContext`

### 2.1 渠道事实的中间形态

渠道适配代码并不直接手搓 240 个字段的 `MsgContext`。OpenClaw 在
`src/channels/inbound-event/context.ts` 提供了一个统一的构造入口
`buildChannelInboundEventContext()`，它接受一个**结构化的「事实」对象**
（`BuildChannelInboundEventContextParams`，`src/channels/inbound-event/context.ts:24-45`）：

```typescript
// src/channels/inbound-event/context.ts:24
export type BuildChannelInboundEventContextParams = {
  channel: string;
  accountId?: string;
  provider?: string;
  surface?: string;
  messageId?: string;
  from: string;
  sender: SenderFacts;
  conversation: ConversationFacts;
  route: RouteFacts;
  reply: ReplyPlanFacts;
  message: MessageFacts;
  access?: AccessFacts;
  command?: CommandFacts;
  commandTurn?: CommandTurnContext;
  media?: InboundMediaFacts[];
  supplemental?: SupplementalContextFacts;
  contextVisibility?: ContextVisibilityMode;
  extra?: Record<string, unknown>;
};
```

这里的 `SenderFacts`/`ConversationFacts`/`RouteFacts`/`MessageFacts` 等
（定义在 `src/channels/turn/types.ts`）是**按语义分组的事实集合**，而不是
扁平的 240 字段袋。渠道适配代码只需把它解析出的渠道原始载荷分门别类填进
这些「事实」分组——这比直接面对 `MsgContext` 的扁平大袋子更不易出错，也
更能表达「这是会话事实」「这是发送者事实」的意图。

`buildChannelInboundEventContext()` 内部把这些事实**铺平**进一个 `MsgContext`
形状的对象，并直接调用 `finalizeInboundContext()`（`src/channels/inbound-event/context.ts:6` 导入），
因此它的返回类型是 `BuiltChannelInboundEventContext`
（`src/channels/inbound-event/context.ts:47-59`）——一个 `FinalizedMsgContext` 的细化，强约束了
`Body`/`BodyForAgent`/`BodyForCommands`/`ChatType`/`From`/`SessionKey`/`To`
等关键字段必为 `string`（非可选）：

```typescript
// src/channels/inbound-event/context.ts:47
export type BuiltChannelInboundEventContext = FinalizedMsgContext & {
  Body: string;
  BodyForAgent: string;
  BodyForCommands: string;
  ChatType: ConversationFacts["kind"];
  CommandAuthorized: boolean;
  CommandBody: string;
  From: string;
  RawBody: string;
  SessionKey: string;
  To: string;
  InboundEventKind: InboundEventKind;
};
```

### 2.2 命令回合在构造期就已就位

注意 `BuildChannelInboundEventContextParams` 里有 `commandTurn?:
CommandTurnContext`（`src/channels/inbound-event/context.ts:40`），并且 `src/channels/inbound-event/context.ts:2-5` 导入了
`commandTurnKindToSource`/`createCommandTurnContext`。这意味着渠道适配代码
在构造信封时，如果它已经知道这条消息是「原生斜杠命令」（如 Telegram 的
`bot_command` entity、Slack 的 slash command webhook），就可以直接构造一个
权威的 `CommandTurnContext` 塞进来。`finalizeInboundContext()` 之后会复用它
（见 §5.3）。这是「让最了解原始载荷的一层做决策」的设计。

### 2.3 数据流小结

```
Telegram update / Slack event / 邮件 MIME / ...
        │
        │  渠道适配层：解析原始载荷
        ▼
   { channel, sender: SenderFacts,
     conversation: ConversationFacts,
     route: RouteFacts, message: MessageFacts,
     command?, commandTurn?, media?, ... }
        │
        │  buildChannelInboundEventContext()
        │  · 把分组事实铺平进 MsgContext 形状
        │  · 调用 finalizeInboundContext()
        ▼
   BuiltChannelInboundEventContext   (FinalizedMsgContext 的细化)
        │
        ▼
   交给 dispatchInboundMessage*()
```

---

## 3. `finalizeInboundContext`：定稿与变量插值

`finalizeInboundContext()` 在 `src/auto-reply/reply/inbound-context.ts:39`。
它是整条管线的**确定性收敛点**：输入一个可能字段残缺、文本未规范的
`MsgContext`，输出一个所有不变量都已建立的 `FinalizedMsgContext`。

它的签名很有意思——是泛型 `<T extends Record<string, unknown>>`
（`src/auto-reply/reply/inbound-context.ts:39`），返回 `T & FinalizedMsgContext`。这样它既能处理
原始 `MsgContext`，也能处理渠道层构造的细化类型，并保留输入的额外字段。

它**原地修改**传入对象（`const normalized = ctx as T & MsgContext`，
`:43`），不复制——因为它处在性能敏感的入站热路径上，定稿是一次性的、幂等的，
原地修改避免了大对象拷贝。

### 3.1 文本规范化

`src/auto-reply/reply/inbound-context.ts:45-58` 对所有正文字段做两件事：

```typescript
// src/auto-reply/reply/inbound-context.ts:45
normalized.Body = sanitizeInboundSystemTags(
  normalizeInboundTextNewlines(typeof normalized.Body === "string" ? normalized.Body : ""),
);
normalized.RawBody = normalizeTextField(normalized.RawBody);
normalized.CommandBody = normalizeTextField(normalized.CommandBody);
normalized.Transcript = normalizeTextField(normalized.Transcript);
// ...
```

- `normalizeInboundTextNewlines()`：把转义的 `\\n` 修正成真实换行 `\n`
  （`MsgContext.BodyForAgent` 注释在 `src/auto-reply/templating.ts:48` 明确要求这一点）。
- `sanitizeInboundSystemTags()`：剥除用户文本里伪造的系统标签——又一道
  prompt injection 防线。用户不能通过在消息里写 `<system>...</system>`
  来伪装成系统指令。

`UntrustedContext` 数组也逐项做同样处理并过滤空项（`:53-58`）。

### 3.2 正文字段的优先级回填

这是 §1.2 提到的「五个正文字段」的协调逻辑：

```typescript
// src/auto-reply/reply/inbound-context.ts:65
const bodyForAgentSource = opts.forceBodyForAgent
  ? normalized.Body
  : (normalized.BodyForAgent ??
     normalized.CommandBody ??
     normalized.RawBody ??
     normalized.Body);
normalized.BodyForAgent = sanitizeInboundSystemTags(
  normalizeInboundTextNewlines(bodyForAgentSource),
);
```

`BodyForAgent` 的回填链是 `BodyForAgent → CommandBody → RawBody → Body`
（`:67-71`）。注释（`:68`）解释了为什么不直接用 `Body`：当上游忘记设置
`BodyForAgent` 时，「干净」的 `CommandBody` 比旧式信封形态的 `Body` 更适合
做提示词。

`BodyForCommands` 的回填链是 `BodyForCommands → CommandBody → RawBody → Body`
（`:76-84`）。两条链的差别体现了 §1.2 说的「面向 agent 的视图」与
「面向命令的视图」分治。

`opts.forceBodyForAgent` / `forceBodyForCommands`
（`FinalizeInboundContextOptions`，`src/auto-reply/reply/inbound-context.ts:8-13`）允许调用方
强制重算——某些场景（如消息被改写后重新定稿）需要丢弃上游已设的值。

### 3.3 命令授权的默认拒绝

```typescript
// src/auto-reply/reply/inbound-context.ts:96
// Always set. Default-deny when upstream forgets to populate it.
normalized.CommandAuthorized = normalized.CommandAuthorized === true;
normalized.CommandTurn = resolveCommandTurnContext(normalized);
if (normalized.CommandTurn.source === "native" || normalized.CommandTurn.source === "text") {
  normalized.CommandSource = normalized.CommandTurn.source;
  normalized.CommandAuthorized = normalized.CommandTurn.authorized;
} else {
  normalized.CommandSource = undefined;
}
```

这就是 §1.3 所说类型不变量的实现：`=== true` 把 `undefined`/任何非
`true` 值统统折叠成 `false`。随后 `resolveCommandTurnContext()`
（见 §5）解析出权威的 `CommandTurn`，并用它**覆盖** `CommandAuthorized` 与
`CommandSource`——`CommandTurn` 是命令语义的单一事实来源，散落的
`CommandAuthorized`/`CommandSource` 字段以它为准。

### 3.4 媒体类型对齐

`src/auto-reply/reply/inbound-context.ts:106-134` 处理单/复数媒体字段的不一致。`countMediaEntries()`
（`:32-37`）取 `MediaPaths`/`MediaUrls`/单数字段三者长度的最大值。当有媒体时：

- 若 `MediaTypes` 数组存在，补齐到 `mediaCount` 长度，空槽填
  `DEFAULT_MEDIA_TYPE`（`application/octet-stream`，`:15`）。
- 若只有单数 `MediaType`，扩展成数组。
- 都没有，则整列填默认类型。

最后保证 `MediaType` 与 `MediaTypes[0]` 一致（`:133`）。下游媒体处理代码
因此可以无条件地按 `MediaTypes` 数组遍历，不必处理「有 path 没 type」的
边界情况。注意：**无媒体时不注入任何默认值**（`:111` 的 `if (mediaCount > 0)`
守卫），避免给纯文本消息凭空挂上媒体字段。

### 3.5 会话标签解析

`src/auto-reply/reply/inbound-context.ts:86-94`：若调用方没给 `ConversationLabel`（或要求强制
重算），调用 `resolveConversationLabel()` 从信封其他字段（群名、发送者名等）
派生一个人类可读标签。

### 3.6 `{{Placeholder}}` 变量插值

「定稿」之外，`templating.ts` 还承担**模板插值**。`applyTemplate()`
（`src/auto-reply/templating.ts:338`）对配置里带占位符的字符串（如 `responsePrefix`、
系统提示模板）做 `{{Placeholder}}` 替换：

```typescript
// src/auto-reply/templating.ts:338
export function applyTemplate(str: string | undefined, ctx: TemplateContext) {
  if (!str) return "";
  return str.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const value = ctx[key as keyof TemplateContext];
    return formatTemplateValue(value);
  });
}
```

`TemplateContext`（`src/auto-reply/templating.ts:296`）= `MsgContext` 再加
`BodyStripped`/`SessionId`/`IsNewSession`。所以模板能直接引用任何信封字段：
`{{SenderName}}`、`{{ChatType}}`、`{{From}}`……。`formatTemplateValue()`
（`:302-335`）做安全的值转字符串：`null`→空串，数组→逗号连接的标量，对象→
空串（防止 `[object Object]` 泄漏）。

把「信封」和「模板上下文」做成同一份数据，正是 §1.1 第 3 点的意义——
入站事实天然就是模板可用的变量。

---

## 4. 会话路由：决定 `SessionKey`

一条入站消息最终要落进某个**会话桶**。会话桶由 `SessionKey` 字符串标识。
路由逻辑集中在 `src/config/sessions/session-key.ts`。

### 4.1 `resolveSessionKey`

```typescript
// src/config/sessions/session-key.ts:30
export function resolveSessionKey(
  scope: SessionScope,
  ctx: MsgContext,
  mainKey?: string,
  agentId: string = DEFAULT_AGENT_ID,
) {
  const explicit = ctx.SessionKey?.trim();
  if (explicit) {
    return normalizeExplicitSessionKey(explicit, ctx);   // :38
  }
  const raw = deriveSessionKey(scope, ctx);              // :40
  if (scope === "global") return raw;                    // :41-43
  const canonicalAgentId = normalizeAgentId(agentId);
  const canonicalMainKey = normalizeMainKey(mainKey);
  const canonical = buildAgentMainSessionKey({
    agentId: canonicalAgentId,
    mainKey: canonicalMainKey,
  });
  const isGroup = raw.includes(":group:") || raw.includes(":channel:");
  if (!isGroup) return canonical;                        // :51-53
  return `agent:${canonicalAgentId}:${raw}`;             // :54
}
```

决策树：

```
ctx.SessionKey 已显式给出?
  └─ 是 → normalizeExplicitSessionKey() → 直接用
  └─ 否 ↓
scope === "global"?
  └─ 是 → 返回 "global"（全局共享一个桶）
  └─ 否 ↓
deriveSessionKey() 得到 raw
raw 含 ":group:" 或 ":channel:"?
  └─ 否（直聊）→ 折叠到规范主会话键 agent:<id>:<mainKey>
  └─ 是（群聊）→ agent:<agentId>:<raw>（每个群独立桶）
```

**关键设计：直聊折叠，群聊隔离。** 注释（`src/config/sessions/session-key.ts:27-28`）说得很清楚：
「所有非群直聊折叠到一个规范桶（默认 `main`）；群聊保持隔离。」也就是说，
同一个用户从 Telegram DM 和 WhatsApp DM 发来的消息，会落进同一个主会话——
对个人助手而言这正是想要的：助手对你只有一个连续的对话记忆，跨渠道延续。
而每个群聊各自独立，互不串台。

### 4.2 `deriveSessionKey`

```typescript
// src/config/sessions/session-key.ts:14
export function deriveSessionKey(scope: SessionScope, ctx: MsgContext) {
  if (scope === "global") return "global";
  const resolvedGroup = resolveGroupSessionKey(ctx);    // :17
  if (resolvedGroup) return resolvedGroup.key;
  const from = ctx.From ? normalizeE164(ctx.From) : ""; // :22
  return from || "unknown";
}
```

- 群聊：`resolveGroupSessionKey(ctx)`（`src/config/sessions/group.ts`）
  从渠道/群 id 拼出形如 `<channel>:group:<id>` 的键。
- 直聊：用 `From` 经 `normalizeE164()` 规范化（电话号码归一），缺省回退
  `"unknown"`。

`SessionScope` 只有两种取值（`src/config/sessions/types.ts:9`）：
`"per-sender"` | `"global"`。

### 4.3 会话键的结构与解析

会话键是带语义的冒号分隔字符串。`src/sessions/session-key-utils.ts` 提供了
一组**解析**而非构造的工具，因为路由下游需要从键反推语义：

- `parseAgentSessionKey()`（`src/sessions/session-key-utils.ts:70`）：解析
  `agent:<agentId>:<rest>` 形态。
- `parseThreadSessionSuffix()`（`:141`）：拆出 `:thread:<threadId>` 后缀，
  用于线程会话。
- `parseRawSessionConversationRef()`（`:162`）：识别
  `<channel>:group:<id>` / `<channel>:channel:<id>`。
- `isCronSessionKey()`/`isSubagentSessionKey()`/`isAcpSessionKey()`
  （`:100`/`:108`/`:128`）：识别特殊来源的会话键。
- `getSubagentDepth()`（`:120`）：数 `:subagent:` 出现次数得子代理深度。

一个微妙之处：`normalizeSessionPeerId()`（`:24`）对 Signal 群 id **不做**
小写化（`:35-37`），因为 Signal 群 id 是 base64 不透明值，大小写敏感。
`normalizeSessionKeyPreservingOpaquePeerIds()`（`:42`）通过正则
`SIGNAL_GROUP_SESSION_SEGMENT_RE`（`:40`）精确地只对非 peer-id 片段做归一，
保留 peer id 原样——这是「规范化」与「不破坏不透明标识」之间的权衡。

### 4.4 `SessionKey` 与运行时策略键的分离

`MsgContext` 还有 `RuntimePolicySessionKey`（`src/auto-reply/templating.ts:79`）和
`CommandTargetSessionKey`（`:231`）。前者的注释解释：当会话键本身有意保持
宽泛（如主会话 DM），但运行时策略（沙箱/工具策略）需要更细粒度的键时，用
`RuntimePolicySessionKey` 单独承载。这是「对话归属键」与「策略作用域键」
分离的设计——同一条消息，对话上算「主会话」，但策略上可能算「某个受限子域」。

### 4.5 命令目标会话键

`src/auto-reply/dispatch.ts:124` 用 `resolveCommandTurnTargetSessionKey(finalized)` 取
**命令目标会话键**，它优先于 `finalized.SessionKey` 成为策略键
（`policySessionKey`，`src/auto-reply/dispatch.ts:125`）。原因见 §5.4：原生命令可以
显式作用于另一个会话（如从主会话 DM 控制某个子代理会话）。

---

## 5. 命令解析与 turn context

### 5.1 命令检测：`hasControlCommand`

`src/auto-reply/command-detection.ts` 回答「这条文本是不是一条控制命令」。
`hasControlCommand()`（`src/auto-reply/command-detection.ts:12`）的流程：

```
text
 │ trim
 │ stripInboundMetadata()        剥掉信封元数据（发送者标签等）
 │ normalizeCommandBody()        命令体归一（去 @botname 后缀等）
 │ toLowerCase
 ▼
遍历命令注册表的所有 textAliases:
  · lowered === alias            精确匹配 → 是命令
  · command.acceptsArgs &&
    lowered 以 alias 开头 &&
    紧跟空白字符                 → 带参数的命令 → 是
```

`isControlCommandMessage()`（`:54`）在 `hasControlCommand()` 之外还额外识别
**中止触发词**（`isAbortTrigger()`，`:69-72`）——「stop」之类的中止意图也算
控制命令。

`hasInlineCommandTokens()`（`:82`）做一个**粗粒度**检测：正则
`/(?:^|\s)[/!][a-z]/i` 看文本里有没有像 `/x` 或 `!x` 的 token（如
「hey /status」）。注释（`:78-81`）明确说这「有意偏向 false positive」——
它只用来决定渠道监视器要不要去**计算** `CommandAuthorized`，并不直接执行命令。

`shouldComputeCommandAuthorized()`（`:90`）= 二者之一为真。这是一个性能
优化：只有看起来可能含命令的消息才走授权计算路径。

### 5.2 `CommandTurnContext`：命令回合的判别联合

`src/auto-reply/command-turn-context.ts` 定义了命令回合的权威表示。它是一个
**判别联合**（discriminated union，`src/auto-reply/command-turn-context.ts:27-30`）：

```typescript
// src/auto-reply/command-turn-context.ts
export type CommandTurnContext =
  | NativeCommandTurnContext      // kind: "native"     :9
  | TextSlashCommandTurnContext   // kind: "text-slash" :15
  | NormalCommandTurnContext;     // kind: "normal"     :21
```

三种回合：

| kind | source | 含义 | authorized |
|------|--------|------|------------|
| `native` | `native` | 渠道原生命令（Telegram bot_command、Slack slash） | 可为 `true` |
| `text-slash` | `text` | 文本里打的斜杠命令（`/status`） | 可为 `true` |
| `normal` | `message` | 普通聊天消息 | **恒为 `false`** |

注意 `NormalCommandTurnContext`（`:21-25`）的 `authorized` 字段类型被收窄为
字面量 `false`——类型层面就保证普通消息永远不可能被当作授权命令。这与 §1.3
的 default-deny 是同一种「用类型系统钉死安全不变量」的手法。

### 5.3 `resolveCommandTurnContext`

```typescript
// src/auto-reply/command-turn-context.ts:161
export function resolveCommandTurnContext(input: CommandTurnContextInput): CommandTurnContext {
  const explicit = normalizeExplicitCommandTurn(input.CommandTurn, input);
  if (explicit) return explicit;                          // :163

  const source =
    input.CommandSource === "native" ? "native"
    : input.CommandSource === "text" ? "text"
    : "message";                                          // :166-171
  const body = resolveCommandBody(input);
  const kind = commandTurnSourceToKind(source);
  return createCommandTurnContext(source, {
    authorized: kind === "normal" ? false : input.CommandAuthorized === true,
    commandName: parseCommandName(body),
    body,
  });
}
```

两条路径：

1. **显式优先**。若信封里已有 `CommandTurn` 对象（§2.2 渠道层构造的），
   `normalizeExplicitCommandTurn()`（`:130`）校验并复用它。校验里有一处
   一致性检查（`:142-144`）：若 `kind` 与 `source` 互相矛盾（如
   `kind: "native"` 配 `source: "text"`），直接判定无效、丢弃。
2. **回退派生**。否则从扁平的 `CommandSource`/`CommandAuthorized` 字段重建。
   `resolveCommandBody()`（`:50`）按 `CommandBody → BodyForCommands →
   RawBody → Body` 优先级取命令体——与 §3.2 的 `BodyForCommands` 回填链
   呼应。`parseCommandName()`（`:59`）从 `/name@bot args` 形态里抠出
   `name`。

无论哪条路径，**`normal` 回合的 `authorized` 一律被强制为 `false`**
（`:151-155` 与 `:175`）。

### 5.4 命令目标会话键

```typescript
// src/auto-reply/command-turn-context.ts:201
export function resolveCommandTurnTargetSessionKey(input: {
  CommandTurn?: CommandTurnContext;
  /* ...CommandSource/CommandAuthorized/CommandBody/.../ CommandTargetSessionKey */
}): string | undefined {
  if (
    !isNativeCommandTurn(resolveCommandTurnContext(input)) ||
    typeof input.CommandTargetSessionKey !== "string"
  ) {
    return undefined;                                     // :211-216
  }
  const trimmed = input.CommandTargetSessionKey.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
```

只有**原生命令回合**（`isNativeCommandTurn`）才允许有命令目标会话键。
这是一条安全约束：原生命令来自渠道可信的命令通道，可以授权它作用于另一个
会话；而文本斜杠命令不能凭一段用户文本就跨会话操作。`src/auto-reply/dispatch.ts:124-128`
据此决定静默回复策略时用哪个会话键。

---

## 6. `dispatchInboundMessage`：入站分发总协调器

`src/auto-reply/dispatch.ts` 是入站管线的**总协调器**。它本身**不**做会话
解析或 agent 执行——那些委托给 `dispatchReplyFromConfig()`。它的职责是：
定稿上下文、装配回复分发器（`ReplyDispatcher`）、应用前台代次围栏与静默
回复策略、串起诊断时间线、收尾结算。

### 6.1 三个入口函数

`dispatch.ts` 导出三个层次的入口：

| 函数 | 行 | 调用方需自备 | 用途 |
|------|----|-----|------|
| `dispatchInboundMessage` | `:244` | 已构造好的 `ReplyDispatcher` | 最底层 |
| `dispatchInboundMessageWithDispatcher` | `:336` | `ReplyDispatcherOptions` | 自动建普通分发器 |
| `dispatchInboundMessageWithBufferedDispatcher` | `:283` | `ReplyDispatcherWithTypingOptions` | 带打字指示的缓冲分发器 |

后两者都最终调用 `dispatchInboundMessage`。多数渠道走带打字指示的版本
（`dispatchInboundMessageWithBufferedDispatcher`），因为它要在 agent 思考时
显示「正在输入…」。

### 6.2 `dispatchInboundMessage` 主流程

```typescript
// src/auto-reply/dispatch.ts:244
export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const finalized = measureDiagnosticsTimelineSpanSync(
    "auto_reply.finalize_context",
    () => finalizeInboundContext(params.ctx),          // :253  ① 定稿
    { phase: "agent-turn", config: params.cfg,
      attributes: buildDispatchTimelineAttributes(params.ctx) },
  );
  const result = await withReplyDispatcher({           // :260  ② 包裹分发器生命周期
    dispatcher: params.dispatcher,
    run: () =>
      measureDiagnosticsTimelineSpan(
        "auto_reply.dispatch_reply_from_config",
        () => dispatchReplyFromConfig({                // :266  ③ 委托给会话/agent 层
          ctx: finalized,
          cfg: params.cfg,
          dispatcher: params.dispatcher,
          replyOptions: params.replyOptions,
          replyResolver: params.replyResolver,
        }),
        { phase: "agent-turn", config: params.cfg,
          attributes: buildDispatchTimelineAttributes(finalized) },
      ),
  });
  return finalizeDispatchResult(result, params.dispatcher);  // :280  ④ 结算
}
```

四步：

1. **定稿**（`:251-259`）。无条件 `finalizeInboundContext()`——即便调用方
   传进来的已经是 `FinalizedMsgContext` 也再跑一遍（幂等）。整个调用被
   `measureDiagnosticsTimelineSpanSync` 包成一个诊断时间线 span
   `auto_reply.finalize_context`。
2. **包裹分发器生命周期**（`:260`）。`withReplyDispatcher()`（再导出自
   `dispatch-dispatcher.ts`，`src/auto-reply/dispatch.ts:204`）确保分发器在 `run` 前后被
   正确开启/结算，即使 `run` 抛错。
3. **委托**（`:266`）。`dispatchReplyFromConfig()` 才是真正做会话解析 +
   agent 执行 + 回复投递的地方（见 §7）。
4. **结算**（`:280`）。`finalizeDispatchResult()`（`:206-242`）从分发器
   取回「被取消」和「失败」的计数，从结果计数里扣除，得到真实交付数。
   注释（`:236-241`）：若有失败计数还会把它附在结果上。

### 6.3 前台代次围栏（foreground reply fence）

`dispatchInboundMessageWithBufferedDispatcher`（`:283`）里有一段
`beginForegroundReplyFence` / `isForegroundReplyFenceSuperseded` /
`endForegroundReplyFence`（`src/auto-reply/dispatch.ts:79-117`）。这是一个**并发陈旧回复
抑制**机制。

模型问题：用户在群里连发两条消息，触发两次入站分发；第一次的 agent 还在
慢慢生成回复，第二次已经开始。第一次那个「旧」回复此时若还投递出去，就是
陈旧的、可能令人困惑的输出。

围栏机制：每个「围栏键」（由 `resolveForegroundReplyFenceKey()`，
`:53-77`，从 `SessionKey + channel + target + chatType + accountId` 构造）
维护一个 `generation` 计数器。每次分发开始 `generation += 1` 并记下快照
（`beginForegroundReplyFence`，`:79`）。投递前的 `beforeDeliver` 钩子
（`:295-309`）检查 `isForegroundReplyFenceSuperseded()`——若当前 generation
已大于本次快照的 generation，说明已有更新的分发开始，本次回复**作废**
（返回 `null` 取消投递）。

```
分发 #1 begin → fence.generation = 1, snapshot#1 = 1
分发 #2 begin → fence.generation = 2, snapshot#2 = 2
分发 #1 的 beforeDeliver → fence.generation(2) !== snapshot#1(1) → 作废
分发 #2 的 beforeDeliver → fence.generation(2) === snapshot#2(2) → 投递
```

`endForegroundReplyFence()`（`:108`）在 `finally`（`:328`）里把活跃计数减
1，归零时清掉 Map 项防止泄漏。

### 6.4 静默回复策略

`resolveDispatcherSilentReplyContext()`（`src/auto-reply/dispatch.ts:119-141`）为分发器
构造 `silentReplyContext`。它从定稿上下文取**策略会话键**
（`commandTargetSessionKey ?? finalized.SessionKey`，§4.5/§5.4）和**会话
类型**（direct/group），交给 `silent-reply-policy` 决定是否静默——例如群里
未被提及的消息可能不该出声回复。`SilentReplyConversationType` 的取值
（`:127-134`）：命令跨会话时为 `undefined`（不套用），否则按 `chatType`
映射成 `"direct"` / `"group"`。

### 6.5 `message_sending` 钩子

`buildMessageSendingBeforeDeliver()`（`src/auto-reply/dispatch.ts:156-186`）：若插件注册了
`message_sending` 钩子，构造一个 `beforeDeliver` 钩子，在每条回复投递前调用
`hookRunner.runMessageSending()`。钩子可以**取消**投递（`result.cancel`，
`:178`）或**改写**文本（`result.content`，`:181`）。这让插件能在出站最后
一刻拦截/修改回复。`resolveInboundReplyHookTarget()`（`:143-154`）算出回复
目标地址传给钩子。

注意 `dispatchInboundMessageWithBufferedDispatcher` 里
（`:295-309`）把前台围栏检查和 `message_sending` 钩子**串联**进同一个
`beforeDeliver`：先查围栏是否作废 → 跑钩子 → 再查一次围栏（因为钩子是异步的，
期间可能又有新分发）。

---

## 7. `dispatchReplyFromConfig`：会话解析与 agent 委派

`src/auto-reply/reply/dispatch-from-config.ts` 是 `dispatchInboundMessage`
委托的下一层。本章只勾勒它与会话路由的衔接，agent 执行细节属后续章节。

`dispatchReplyFromConfig()`（`src/auto-reply/reply/dispatch-from-config.ts:420`）开头
（`:423-441`）从定稿上下文抽取分发元信息：

```typescript
// src/auto-reply/reply/dispatch-from-config.ts:424
const channel = normalizeLowercaseStringOrEmpty(ctx.Surface ?? ctx.Provider ?? "unknown");
const chatId = ctx.To ?? ctx.From;
const messageId = ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
const sessionKey =
  normalizeOptionalString(ctx.SessionKey) ?? normalizeOptionalString(ctx.CommandTargetSessionKey);
```

注意 `channel` 取值再次体现「`Surface` 优先于 `Provider`」（§1.2）。
`sessionKey` 取 `SessionKey`，缺省回退 `CommandTargetSessionKey`。

随后它解析会话存储条目：

```typescript
// src/auto-reply/reply/dispatch-from-config.ts:494
const initialSessionStoreEntry = resolveSessionStoreLookup(ctx, cfg);
const boundAcpDispatchSessionKey = resolveBoundAcpDispatchSessionKey({ ctx, cfg });
const acpDispatchSessionKey =
  boundAcpDispatchSessionKey ?? initialSessionStoreEntry.sessionKey ?? sessionKey;
```

`resolveSessionStoreLookup()`（定义于 `src/auto-reply/reply/dispatch-from-config.ts:254` 附近）
内部用 `resolveSessionStoreEntry({ store, sessionKey })`
（来自 `src/config/sessions/store-entry.ts`，见第 06 章）从会话存储里找出
（或准备创建）对应的 `SessionEntry`。至此，入站管线与会话状态层正式交接：
`MsgContext` 携带的路由信息变成了一个具体的会话条目。

`dispatchReplyFromConfig()` 之后会读取该会话条目上的 `verboseLevel`、
`ttsAuto` 等持久化设置（`:537-543`），解析有效回复路由
（`resolveEffectiveReplyRoute`，`:546`），最终调用回复解析器跑 agent。
这条「会话条目如何被加载、键如何归一、并发写如何保证」的链路，是第 06 章
的主题。

---

## 8. 关键回复类型

入站管线的产物是回复。三个类型刻画了「期望什么回复」「回复长什么样」。

### 8.1 `GetReplyOptions`

`GetReplyOptions`（`src/auto-reply/get-reply-options.types.ts:48-204`）是
喂给回复解析器的一大袋选项。它本质上是一组**回调钩子**加一组**一次性
覆盖项**。

回调钩子描述了 agent 运行过程中各种事件的订阅点，渠道借此实现流式 UX：

| 回调 | 行 | 触发时机 |
|------|----|---------| 
| `onAgentRunStart` | `:58` | agent run 真正开始 |
| `onPartialReply` | `:89` | 流式增量文本 |
| `onReasoningStream` / `onReasoningEnd` | `:90`/`:92` | 思考块流式 / 结束 |
| `onBlockReply` / `onBlockReplyQueued` | `:99`/`:98` | 一个回复块逻辑产出 |
| `onToolStart` / `onToolResult` | `:102`/`:100` | 工具调用阶段 |
| `onItemEvent` / `onPlanUpdate` | `:109`/`:123` | 工作项 / 计划更新 |
| `onApprovalEvent` | `:131` | 审批挂起/解决 |
| `onCommandOutput` / `onPatchSummary` | `:147`/`:160` | 命令输出 / 补丁摘要 |
| `onCompactionStart` / `onCompactionEnd` | `:172`/`:174` | 上下文压缩起止 |
| `onModelSelected` | `:177` | 实际模型选定（含 fallback 后） |

一次性覆盖项是**只作用于本回合、不持久化到会话**的设置，如
`thinkingLevelOverride`（`:71`）、`fastModeOverride`（`:73`）、
`modelOverride`（`:201`）、`skillFilter`（`:194`）、
`timeoutOverrideSeconds`（`:199`）。注释反复强调「does not persist to the
session」——这与第 06 章会讲的 `SessionEntry` 上的持久覆盖字段形成对照：
入站某一回合可以临时改模型，但不污染会话长期状态。

`sourceReplyDeliveryMode`（`:184`，`"automatic" | "message_tool_only"`）控制
普通助手回复是否自动投递回源会话——这与 §6.4 的静默回复策略协同。

`PartialReplyPayload`（`:43-46`）= `ReplyPayload` 的 `text`/`mediaUrls` 子集
再加 `delta`/`replace`，用于流式增量。

### 8.2 `ReplyPayload`

`ReplyPayload`（`src/auto-reply/reply-payload.ts:7-56`）是**一条回复的
渠道无关表示**：

```typescript
// src/auto-reply/reply-payload.ts:7
export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  presentation?: MessagePresentation;   // :16  渠道无关富展示
  delivery?: ReplyPayloadDelivery;      // :18  投递偏好（如置顶）
  replyToId?: string;
  audioAsVoice?: boolean;               // :33  作为语音气泡发送
  spokenText?: string;                  // :38  TTS 文本
  ttsSupplement?: ReplyPayloadTtsSupplement;
  isError?: boolean;
  isReasoning?: boolean;                // :47  思考块标记
  isCompactionNotice?: boolean;         // :51  压缩状态通知标记
  isFallbackNotice?: boolean;           // :53  模型回退通知标记
  channelData?: Record<string, unknown>;// :55  渠道特定数据
};
```

设计要点：

- **渠道无关 + 优雅降级**。`presentation`（`:16`）注释说核心会「降级或交给
  渠道渲染器映射」富展示。WhatsApp/网页等没有专门「思考通道」的渠道，看到
  `isReasoning: true` 的载荷会**抑制**它（`:45-46`）。一份载荷，各渠道按
  能力渲染。
- **标记位驱动下游行为**。`isReasoning`/`isCompactionNotice`/
  `isFallbackNotice` 这些布尔标记让 TTS、transcript 投影等下游能区分
  「真正的助手回复」与「状态噪声」。例如 `isCompactionNotice` 注释
  （`:48-50`）说它必须排除出 TTS 累积，否则压缩状态行会被合成进语音回复。

`reply-payload.ts` 还提供 TTS 辅助逻辑：`getReplyPayloadTtsSupplement()`
（`:83`）、`markReplyPayloadAsTtsSupplement()`（`:104`）、
`buildTtsSupplementMediaPayload()`（`:125`）。`ttsSupplement` 把
「已可见的助手文本」与「为它合成的语音媒体」关联起来，避免重复。

### 8.3 `ReplyPayloadMetadata`：带外元数据

`ReplyPayloadMetadata`（`src/auto-reply/reply-payload.ts:144-166`）不是 `ReplyPayload` 的
字段，而是通过一个 **`WeakMap`** 旁挂在载荷对象上的元数据
（`replyPayloadMetadata`，`:168`）：

```typescript
// src/auto-reply/reply-payload.ts:168
const replyPayloadMetadata = new WeakMap<object, ReplyPayloadMetadata>();

export function setReplyPayloadMetadata<T extends object>(
  payload: T, metadata: ReplyPayloadMetadata,
): T { /* :170 */ }
export function getReplyPayloadMetadata(payload: object): ReplyPayloadMetadata | undefined {
  return replyPayloadMetadata.get(payload);  // :179
}
```

为什么用 `WeakMap` 而不是直接加字段？因为这些是**内部带外信息**，不应出现
在序列化到渠道的载荷里，也不应被插件 SDK 看见。`WeakMap` 让元数据「跟着
对象走」却不污染对象结构，且对象被回收时元数据自动释放。

元数据里有 `deliverDespiteSourceReplySuppression`（`:151`，配合
`markReplyPayloadForSourceSuppressionDelivery()`，`:188`）——标记某条
（如运行时失败通知）即便在「源回复被抑制」模式下也应投递；以及
`sourceReplyTranscriptMirror`（`:158`），把内部 UI 的源回复镜像进
transcript 使其持久（第 06 章）。

### 8.4 `src/auto-reply/types.ts`：门面再导出

`src/auto-reply/types.ts`（全文 14 行）本身不定义任何类型，它是一个
**门面**（barrel），把分散的类型从一个稳定入口再导出：

```typescript
// src/auto-reply/types.ts
export type {
  BlockReplyContext, GetReplyOptions, PartialReplyPayload,
  ReplyThreadingPolicy, TypingPolicy,
} from "./get-reply-options.types.js";
export {
  copyReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "./reply-payload.js";
export type { ReplyPayload } from "./reply-payload.js";
```

`src/auto-reply/dispatch.ts:31` 正是从这个门面导入 `GetReplyOptions` 和 `ReplyPayload`。
门面的价值：内部实现文件可以重构、拆分，只要门面的再导出列表不变，所有
下游导入就不受影响。

---

## 9. 全链路回顾

把本章串成一条完整的入站旅程：

```
┌──────────────────────────────────────────────────────────────────┐
│  渠道原始载荷 (Telegram update / Slack event / 邮件 / ...)         │
└───────────────────────────┬──────────────────────────────────────┘
                            │ 渠道适配层解析
                            ▼
        BuildChannelInboundEventContextParams  (分组事实)
          { sender, conversation, route, message, command?,
            commandTurn?, media?, ... }
                            │ buildChannelInboundEventContext()
                            │   src/channels/inbound-event/context.ts:24
                            ▼
        finalizeInboundContext()   src/auto-reply/reply/inbound-context.ts:39
          · 文本规范化 (换行修正 + 剥系统标签)        :45-58
          · 正文字段优先级回填 (BodyForAgent/Commands) :65-84
          · ConversationLabel 派生                     :86-94
          · CommandAuthorized 默认拒绝 + CommandTurn   :96-104
          · 媒体单/复数字段对齐                        :106-134
                            │
                            ▼   FinalizedMsgContext  (不变量已建立)
        dispatchInboundMessage()        src/auto-reply/dispatch.ts:244
          ① finalizeInboundContext (幂等再跑)          :253
          ② withReplyDispatcher 包裹生命周期           :260
          ③ ──► dispatchReplyFromConfig                :266
          ④ finalizeDispatchResult 结算计数            :280
          · 前台代次围栏 (并发陈旧回复抑制)   :79-117
          · 静默回复策略                     :119-141
          · message_sending 钩子             :156-186
                            │
                            ▼
        dispatchReplyFromConfig()  src/auto-reply/reply/dispatch-from-config.ts:420
          · 抽取 channel/sessionKey/messageId          :424-431
          · resolveSessionStoreLookup → SessionEntry   :494
          · 读会话持久设置 (verboseLevel/ttsAuto/...)   :537-543
          · resolveEffectiveReplyRoute                 :546
          · ──► 回复解析器 / agent 执行
                            │
                            ▼
                  ReplyPayload  ──► ReplyDispatcher ──► 渠道出站
```

**贯穿全章的两个设计主题：**

1. **在边界定稿一次，内部只信定稿值。** `finalizeInboundContext()` 是唯一
   的收敛点；它把「字段可能缺失、文本可能未规范、授权可能未设」的混乱输入，
   一次性整形成一个所有不变量都成立的 `FinalizedMsgContext`。类型系统
   （`MsgContext` → `FinalizedMsgContext` 的 `CommandAuthorized` 必填化）
   把这个约定钉死在编译期。

2. **用类型与结构钉死安全不变量。** 默认拒绝（`CommandAuthorized === true`
   折叠）、`NormalCommandTurnContext.authorized: false` 字面量、不可信内容
   显式标注（`UntrustedContext`）、系统标签剥除、原生命令才允许跨会话目标
   ——这些都不是运行时的临时检查，而是被编进类型和结构里的硬约束。一条
   不可信的入站消息，从进入信封那一刻起，它能造成的影响范围就已被结构性
   地限定。
