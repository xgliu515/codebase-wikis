# Trace 步骤 13 —— 生成最终文本响应

## 1. 当前情境

第 12 步出发的第二次 LLM 调用现在正在 streaming。从外向内看，这条流的层级是：

<svg viewBox="0 0 760 470" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Streaming layers from Anthropic SSE down to SQLite and Bus">
  <defs>
    <marker id="art131" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="200" y="20" width="360" height="40" rx="6" fill="#fff" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="380" y="38" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Anthropic API</text>
  <text x="380" y="54" text-anchor="middle" font-size="10" fill="#64748b">SSE: content_block_delta { text_delta }</text>
  <path d="M380,62 L380,82" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#art131)"/>
  <rect x="80" y="86" width="600" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="106" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">packages/llm  route/client.ts  →  protocols/anthropic-messages.ts</text>
  <text x="380" y="124" text-anchor="middle" font-size="10" fill="#64748b">parse SSE → LLMEvent（mapFinishReason 归一）</text>
  <path d="M380,136 L380,156" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#art131)"/>
  <rect x="80" y="160" width="600" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="180" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">AI SDK streamText (session/llm.ts)</text>
  <text x="380" y="196" text-anchor="middle" font-size="10" fill="#64748b">fullStream（默认 runtime）</text>
  <path d="M380,206 L380,226" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#art131)"/>
  <rect x="80" y="230" width="600" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="250" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">LLMAISDK.toLLMEvents (session/llm/ai-sdk.ts)</text>
  <text x="380" y="266" text-anchor="middle" font-size="10" fill="#64748b">把 fullStream / native 流统一成 LLMEvent</text>
  <path d="M380,276 L380,296" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#art131)"/>
  <rect x="80" y="300" width="600" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="320" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">SessionProcessor.handleEvent (session/processor.ts)</text>
  <text x="380" y="336" text-anchor="middle" font-size="10" fill="#64748b">case "text-start" / "text-delta" / "text-end" / "step-finish"</text>
  <path d="M380,346 L380,366" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#art131)"/>
  <rect x="80" y="370" width="600" height="58" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="390" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Session.updatePartDelta / updatePart</text>
  <text x="200" y="410" text-anchor="middle" font-size="10" fill="#64748b">updatePartDelta：只发 Bus</text>
  <text x="560" y="410" text-anchor="middle" font-size="10" fill="#64748b">updatePart：写 SQLite + 发 Bus</text>
  <text x="380" y="426" text-anchor="middle" font-size="10" fill="#64748b">订阅者按 Delta 累加；冷启动从 SQLite 读快照</text>
  <text x="380" y="452" text-anchor="middle" font-size="10" font-weight="600" fill="#64748b">每层只关心相邻层的"协议"——上层完全感知不到换没换 provider</text>
</svg>
<span class="figure-caption">图 T13.1 ｜ 第二次 LLM 调用的 streaming 分层管线：从 SSE 字节到 SQLite + Bus，五层逐级归一，每层都封装相邻层的差异。</span>

<details>
<summary>ASCII 原版</summary>

```text
Anthropic API ─SSE─▶ packages/llm route/client.ts ──▶ protocols/anthropic-messages.ts
              ▲                                  parse SSE → LLMEvent
              │
       AI SDK streamText (session/llm.ts)
              │
       LLMAISDK.toLLMEvents (session/llm/ai-sdk.ts)
              │
       SessionProcessor.handleEvent (session/processor.ts)
              │
       Session.updatePartDelta / updatePart  → SQLite + Bus
```

</details>

PartTable 里已经成型的东西：

- `Message(assistant, id=msg_3)`：第二次响应所属的那条新行，刚被 `prompt.ts:1346` 建出来，`finish=undefined`、`time.completed=undefined`。
- `msg_3` 名下还没有任何 Part。第一条即将到达——按 protocol 顺序它会是 `LLMEvent.stepStart`，处理器会写一个 `Part(step-start, snapshot=...)`。

模型这一轮的认知很清楚："工具结果我看到了，README.md 讲的是 opencode 这个项目"。它会直接产文字，**没有新工具调用要发**。

## 2. 问题

这一步要解决：

1. **拼字符串**：流式接收 `text_delta` 增量字符串，组装成完整文本——但**不能等接收完再写**，要让用户在 stdout 上看到 token 边到达边出现。
2. **状态机要对齐**：assistant 消息这条 Part 从 `text-start` 到 `text-end` 之间，要持续可被订阅者读到"半成品"——既要支持增量更新，也要保证最终态可靠。
3. **辨认终止信号**：模型这次发的是 `end_turn` 而不是 `tool_use`，外层的 agent 循环要识别出"真的说完了"，否则就会被第 12 步那个 while 拉回去再发第三次请求。
4. **不要在每个 delta 都 fsync**：几百个 text_delta 都触发一次 SQLite 写入，磁盘会爆，UI 也会被淹没。
5. **协议差异要抽掉**：Anthropic 发 `content_block_delta { type: "text_delta", text }`，OpenAI 发 `chat.completion.chunk { delta: { content } }`，Gemini 又不一样。处理器代码不应该感知这些。

## 3. 朴素思路

天然写法：

```ts
let final = ""
for await (const chunk of stream) {
  if (chunk.type === "text") {
    final += chunk.text
    db.update(partId, { text: final })          // 每个 chunk 一次写库
    process.stdout.write(chunk.text)
  }
}
if (chunk.stop_reason === "end_turn") return final
```

stdout 直接 pipe，库每 chunk 一写，最后判 stop_reason。简单粗暴。

## 4. 为什么朴素思路会崩

- **每 chunk fsync** 一次 SQLite，几十 ms 的 token 流被磁盘 wall-clock 拖到几百 ms；多个订阅者（TUI + `run` 命令）同时读同一条 Part 会出现 phantom 读到部分写入的字符串。
- **`text` 同 step 多次更新整段字符串**：一条 5KB 的回答，发了 100 个 delta，就有 5KB × 100 ≈ 500KB 的累计写入流量。
- **stop_reason 这一行写死 `end_turn`** 是 Anthropic 的协议。OpenAI 是 `stop`、Gemini 是 `STOP`。朴素代码立刻锁死在某个 provider 上。
- **没有 `isStreaming` 信号** 给订阅者：UI 端不知道这段 text 是"还在长"还是"已经定稿"。打印行光标会闪烁还是定住？
- **没有协议层的归一化**：第 12 步说"agent 循环看 finishReason"，但 reason 字符串差异如果一直传到 processor，processor 就要写 8 个分支判定不同 provider——破坏可维护性。

## 5. opencode 的做法

opencode 把这件事拆成 **3 层逐级归一**，每一层都只关心相邻层的"协议"：

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Three-layer normalization funnel from many provider SSEs down to LLMEvent and Part">
  <defs>
    <marker id="art132" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g font-size="11" fill="currentColor">
    <rect x="40" y="20" width="180" height="30" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="130" y="40" text-anchor="middle">Anthropic SSE</text>
    <rect x="40" y="60" width="180" height="30" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="130" y="80" text-anchor="middle">OpenAI SSE</text>
    <rect x="40" y="100" width="180" height="30" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="130" y="120" text-anchor="middle">Bedrock SSE</text>
    <rect x="40" y="140" width="180" height="30" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="130" y="160" text-anchor="middle">Gemini SSE</text>
  </g>
  <path d="M220,35 L320,90" stroke="#94a3b8" stroke-width="1.2" fill="none" marker-end="url(#art132)"/>
  <path d="M220,75 L320,95" stroke="#94a3b8" stroke-width="1.2" fill="none" marker-end="url(#art132)"/>
  <path d="M220,115 L320,105" stroke="#94a3b8" stroke-width="1.2" fill="none" marker-end="url(#art132)"/>
  <path d="M220,155 L320,115" stroke="#94a3b8" stroke-width="1.2" fill="none" marker-end="url(#art132)"/>
  <rect x="330" y="60" width="330" height="80" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="495" y="84" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">packages/llm/src/protocols/*.ts</text>
  <text x="495" y="104" text-anchor="middle" font-size="10" fill="#64748b">解厂商 schema → LLMEvent</text>
  <text x="495" y="122" text-anchor="middle" font-size="10" fill="#64748b">含 finishReason 归一（end_turn → "stop"）</text>
  <path d="M495,144 L495,170" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#art132)"/>
  <rect x="290" y="174" width="410" height="60" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="495" y="198" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">LLMEvent  →  session/llm/ai-sdk.ts (toLLMEvents)</text>
  <text x="495" y="218" text-anchor="middle" font-size="10" fill="#64748b">把 AI SDK 的 fullStream 或 native 流统一成同一 LLMEvent</text>
  <path d="M495,236 L495,262" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#art132)"/>
  <rect x="290" y="266" width="410" height="60" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="495" y="290" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">SessionProcessor</text>
  <text x="495" y="310" text-anchor="middle" font-size="10" fill="#64748b">写 Part / 推 Bus（updatePart vs updatePartDelta）</text>
  <text x="40" y="350" font-size="10" fill="#64748b">关键：模型发的 end_turn 在协议层就被归一成 finishReason="stop"，processor 不感知 provider。</text>
  <text x="40" y="366" font-size="10" fill="#64748b">新增 provider = 加一个 protocols/&lt;name&gt;.ts；上层零改动。</text>
</svg>
<span class="figure-caption">图 T13.2 ｜ 三层归一漏斗：多 provider SSE → protocols 层 → LLMEvent → ai-sdk 适配 → SessionProcessor；finishReason 在协议层就拍平成五选一。</span>

<details>
<summary>ASCII 原版</summary>

```text
Anthropic SSE        ──┐
OpenAI SSE           ──┤──▶ packages/llm/src/protocols/*.ts
Bedrock SSE          ──┤    把厂商 schema 解成 LLMEvent
Gemini SSE           ──┘    （含 finishReason 归一）
                       │
                       ▼
                   LLMEvent  ─────▶ session/llm/ai-sdk.ts (toLLMEvents)
                       │            把 AI SDK 的 fullStream
                       │            或者 native 流统一成 LLMEvent
                       ▼
                  SessionProcessor ──▶ 写 Part / 推 Bus
```

</details>

### 5.1 协议层把 `text_delta` 归一化

Anthropic 的 SSE 体每个 chunk 形如：

```json
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"是 "}}
```

`packages/llm/src/protocols/anthropic-messages.ts:620-632` 的 `onContentBlockDelta` 看到 `delta.type === "text_delta"`，把它转成 LLMEvent 的 `textDelta`：

关键一行：

```ts
if (delta?.type === "text_delta" && delta.text) {
  return [{ ...state, lifecycle: Lifecycle.textDelta(state.lifecycle, events, `text-${event.index ?? 0}`, delta.text) }, events]
}
```

`Lifecycle.textDelta` 是个状态机辅助：第一次 text_delta 之前自动补发 `LLMEvent.textStart`，本次 emit `LLMEvent.textDelta`，遇到 `content_block_stop` 时 emit `LLMEvent.textEnd`。所有 provider 看出去都长一样。

`mapFinishReason`（`anthropic-messages.ts:475-481`）做 reason 归一：`end_turn / stop_sequence / pause_turn → "stop"`、`max_tokens → "length"`、`tool_use → "tool-calls"`、`refusal → "content-filter"`、其它 `"unknown"`。

也就是说，**模型发的 `end_turn` 到上层就是 `"stop"`**。这一次不是 `"tool-calls"`，第 12 步那条终止判定 (`!["tool-calls"].includes(lastAssistant.finish)`) 这次会落地为 true。

### 5.2 AI SDK 适配层

opencode 默认走 AI SDK runtime（`session/llm.ts:343-367` 把 fullStream 通过 `LLMAISDK.toLLMEvents` 翻译）。`text-delta` 映射成 `LLMEvent.textDelta`（`ai-sdk.ts:108-115`）；`finish` 事件映射时同时跑 `Object.assign(state, adapterState())` 重置 counters，使 adapter 可被下一条 stream 复用（`ai-sdk.ts:82-95`）。reason 字段进 processor 时已经是 `"stop" | "length" | "tool-calls" | "content-filter" | "unknown"` 五选一。

`currentTextID`（`ai-sdk.ts:51-54`）兜底——某些 provider 不发 `event.id`，适配层用 `state.currentTextID ?? "text-${state.text++}"` 保证 processor 看到的每个 delta 都挂在一致的 part id 上。

### 5.3 SessionProcessor 把 LLMEvent 落库

text 路径走三段 case：

**text-start**（`processor.ts:619-639`）：建一个 `ctx.currentText = { id: PartID.ascending(), messageID: msg_3.id, type: "text", text: "", time: { start: now }, ... }`，立刻 `session.updatePart(ctx.currentText)` 把空 text Part 直接落库。这是给订阅者的"我开始要说话了"信号；UI 拿到 `MessagePartUpdated` 就能渲染一个空字符串行+光标。

**text-delta**（`processor.ts:641-652`）：累加 `ctx.currentText.text += value.text`，走 `session.updatePartDelta({ ..., field: "text", delta: value.text })`。

注意这里**没有调 `updatePart`**——`updatePart` 是全量覆盖 + 落库 + 发 `PartUpdated`；`updatePartDelta` 在 `session/session.ts:812-820` 的实现极轻：

```ts
const updatePartDelta = Effect.fnUntraced(function* (input) {
  yield* bus.publish(MessageV2.Event.PartDelta, input)
})
```

**只发总线，不写库**。

这就是 opencode 解决"每 delta 都写库会爆"的方案：**delta 走 `PartDelta` 事件（轻量、in-memory）；快照走 `PartUpdated`（落库 + 发事件）**。订阅者拿到 PartDelta 累加字符串增量即可；从冷启动加载历史时，重读 SQLite 拿到的就是最近一次 PartUpdated 写入的全量。

**text-end**（`processor.ts:654-684`）：跑 plugin `experimental.text.complete` hook（可改写最终文本）、盖 `time.end = now`、最后一次 `session.updatePart(ctx.currentText)` 全量写库、`ctx.currentText = undefined` 释放槽位。

### 5.4 `isStreaming` 信号——靠"有没有 text-end"区分

opencode **没有显式 `isStreaming: boolean`**，靠两件事区分：(1) `time.end` 字段——start 时 `{ start: now }`，end 时盖 `end`，订阅者看到 `end !== undefined` 就知道定稿；(2) `PartDelta` vs `PartUpdated`——前者还在累加，后者代表一次完整快照。

### 5.5 step-finish + finish 关掉这条 stream

text-end 之后到 `step-finish`（`processor.ts:555-617`）：写 `Part(step-finish, reason: "stop", tokens, cost, snapshot)`；把 `ctx.assistantMessage.finish = "stop"`、`cost += usage.cost`、`tokens = usage.tokens`；`session.updateMessage(ctx.assistantMessage)`——assistant 消息现在带上 `finish: "stop"` 这个关键字段。

接着 `finish` event（`processor.ts:686-687`）no-op、`stream.runDrain` 看到 stream 关闭返回。`handle.process` 走到 `processor.ts:846-848` 的判定：`needsCompaction = false`、`blocked = false`、`error = undefined`，return `"continue"` 给 runLoop。

runLoop 在 `prompt.ts:1460-1476` 拿到 `"continue"` **不会 break**——但下一次 while 迭代开头（`prompt.ts:1247`）会重新读 messages、重新算 `hasToolCalls`：这次 `msg_3` 没有任何 toolCall part、`finish === "stop"`，三个终止条件全满足，**循环这一次 break**。

### 5.6 第二次 stream 与第一次的对照

| 阶段 | 第一次 stream | 第二次 stream |
|------|--------------|--------------|
| 起点 | user 发完话 | toolResult 已回灌 |
| events | step-start → text-start → text-delta* → text-end → tool-input-start → tool-input-delta* → tool-call → tool-result → step-finish → finish | step-start → text-start → text-delta* → text-end → step-finish → finish |
| finishReason | `tool-calls` | `stop` |
| 产物 Part | 1 text + 1 toolCall | 1 text |
| 触发下一轮？ | 是（runLoop continue） | 否（runLoop break） |

## 6. 代码位置

按本步骤的事件顺序：

- `packages/llm/src/protocols/anthropic-messages.ts:620-632` — `onContentBlockDelta` 把 `text_delta` 转 `LLMEvent.textDelta`。
- `packages/llm/src/protocols/anthropic-messages.ts:475-481` — `mapFinishReason`：`end_turn → "stop"`、`tool_use → "tool-calls"` 等归一规则。
- `packages/llm/src/protocols/anthropic-messages.ts:728-730` — content_block 三事件分派（start / delta / stop）。
- `packages/llm/src/route/client.ts` — SSE/WebSocket 传输 + framing；protocol parser 是它的下游消费者。
- `packages/opencode/src/session/llm/ai-sdk.ts:108-115` — `text-delta` 适配。
- `packages/opencode/src/session/llm/ai-sdk.ts:82-95` — `finish` 事件适配 + adapter state reset。
- `packages/opencode/src/session/llm/ai-sdk.ts:51-59` — `currentTextID` 兜底逻辑（provider 不发 id 时给个稳定的 `text-N`）。
- `packages/opencode/src/session/llm.ts:343-367` — `Service.stream` 的 fullStream → LLMEvent 流转换。
- `packages/opencode/src/session/processor.ts:619-639` — `text-start`：建一个空 `Part(text)`、`time.start = now`、走全量 `updatePart`。
- `packages/opencode/src/session/processor.ts:641-652` — `text-delta`：累加 `ctx.currentText.text`、走轻量 `updatePartDelta`（只发 Bus，不写 SQLite）。
- `packages/opencode/src/session/processor.ts:654-684` — `text-end`：跑 plugin hook、盖 `time.end`、最终一次 `updatePart` 写库。
- `packages/opencode/src/session/processor.ts:555-617` — `step-finish`：算 usage、写 `Part(step-finish)`、把 `finish: "stop"` 盖到 `assistantMessage`、必要时做 snapshot patch、检查 overflow。
- `packages/opencode/src/session/processor.ts:686-687` — `finish` event：no-op，让 stream 自然关闭。
- `packages/opencode/src/session/processor.ts:780-849` — `handle.process` 主体：消费完 stream → return `"compact" | "stop" | "continue"`。
- `packages/opencode/src/session/processor.ts:846-848` — 三选一返回值的判定。
- `packages/opencode/src/session/session.ts:812-820` — `updatePartDelta`：极轻的"只发 Bus 不写库"路径。
- `packages/opencode/src/session/session.ts:624-632` — `updatePart`：写库 + 发 `PartUpdated`。
- `packages/opencode/src/session/prompt.ts:1247-1275` — runLoop 下一轮迭代时的终止判定：这次三个条件全满足，break。
- `packages/opencode/src/session/run-state.ts:51-68` — runner 的 `onIdle` 钩子：循环 break 后会把 status 切到 `idle`、把 runner 从 map 里清掉（第 16 步会进这条路径）。

## 7. 分支与延伸

- **流式 Part 模型**：增量更新 vs 全量快照、PartDelta vs PartUpdated 的设计动机，见 [第 03 章 §流式 Part 与增量更新](03-session-and-messages.md#流式-part-与增量更新) 与 [第 03 章 §两个事件：`PartUpdated` vs `PartDelta`](03-session-and-messages.md#两个事件partupdated-vs-partdelta)。
- **为什么没有显式 `isStreaming`**：见 [第 03 章 §为什么没有 isStreaming 标志](03-session-and-messages.md#为什么没有-isstreaming-标志)。
- **整体循环结构**：runLoop 看到 `"continue"` 还会进入下一次 while；但下一次迭代开头的判定就会 break——见 [第 05 章 §5.5 状态机视角](05-agent-loop.md#55-状态机视角) 里那张状态机图，以及 [第 05 章 §5.6 SessionProcessor：把 stream 翻成 part](05-agent-loop.md#56-sessionprocessor把-stream-翻成-part)。
- **协议解码细节**：每个 provider 的 SSE 格式差异、reason 字段映射表、reasoning_delta / signature_delta 等特殊 case，见 [第 06 章 §流式：协议解码](06-llm-layer.md#流式协议解码)（章节按计划属第 06 章 LLM 层）。
- **AI SDK runtime vs native runtime**：opencode 默认走 AI SDK，但 `flags.experimentalNativeLlm` 开启时走 `LLMNativeRuntime` 直连 `packages/llm`，绕开 AI SDK——`session/llm.ts:220-258`。
- **`experimental.text.complete` 插件 hook**：插件可以在 text-end 时改写最终文本——审计、过滤、注入水印都走这里；见第 12 章插件系统。
- **subagent 的 final text**：子 agent 的最终 text 也走同一条 text-start/delta/end 路径，只是 part 落在子 session 的 PartTable 里；父循环通过 `task` 工具的 ToolResult 拿到子 session 的输出汇总——第 5.11 节有详解。

## 8. 走完这一步你脑子里应该多了什么

1. **流式 Part 的核心 trick**：`updatePart` 全量写库（用于 start/end），`updatePartDelta` 轻量推总线（用于每个 delta）。订阅者按 Delta 累加、冷启动按 SQLite 读全量。
2. **`text-start / text-delta+ / text-end` 是一个被状态机隐含的协议**：opencode 没有 `isStreaming: boolean`，看 `time.end` 是否成立就够了。
3. **`end_turn` 不会直接进 processor**：协议层（`anthropic-messages.ts`）已经把它归一成 `finishReason: "stop"`，processor 完全不感知 provider。要新增一个 provider，只在 `packages/llm/src/protocols/<name>.ts` 里实现解码 + reason 映射。
4. **第二次 stream 的"完成"由两件事联合签署**：`text-end` 盖 `time.end`，`step-finish` 给 `assistantMessage.finish = "stop"`。两个都到位、`finish` event 关闭 stream，processor 的 effect 才 return `"continue"`。
5. **runLoop 是"懒人停"**：拿到 `"continue"` 仍然会进下一次 while，但下一次迭代开头一查 `hasToolCalls = false && finish === "stop"`，break。也就是说"模型说完了"实际上要等到**下一次循环开头**才被识别——这是 opencode 把"决策"和"动作"分到两层的代价，也是它能干净处理 "stop 里还有 tool_use" 这种 corner case 的根本原因。
6. **下一步起点**：assistant msg_3 完整成型（text part 定稿、step-finish 写完、finish="stop" 盖戳）；runLoop 即将 break；接下来要做的事是把所有累积的 Part 完成最后一次持久化、走 `Effect.ensuring(cleanup())`、把 `SessionIdle` 事件发出去、SSE 把缓存的 delta 全部 flush 到 stdout。这就是第 14、15、16 步。

下一步：[Trace 步骤 14 —— 持久化与事件广播](tour-14-persist-broadcast.md)
