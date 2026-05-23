# Trace 步骤 08 —— 解码 `tool_use` 片段

## 1. 当前情境

上一步把第一次 LLM 调用送上 HTTP 管线。AI SDK 已经握住一条 SSE 长连接，正在源源不断收到 `data:` 行。每条 SSE 行经过反序列化后是 Anthropic Messages API 标准的 stream event：

<svg viewBox="0 0 760 470" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Anthropic SSE event timeline for one tool_use response with two content blocks">
  <defs>
    <marker id="art81" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="40" y="24" font-size="12" font-weight="700" fill="currentColor">Anthropic Messages SSE 帧流（一次 tool_use 回复）</text>
  <line x1="56" y1="42" x2="56" y2="430" stroke="#cbd5e1" stroke-width="1.2" stroke-dasharray="3,3"/>
  <circle cx="56" cy="56" r="4" fill="#0ea5e9"/>
  <rect x="72" y="44" width="660" height="24" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="80" y="60" font-size="10" fill="currentColor">message_start  usage={...}</text>
  <text x="40" y="90" font-size="11" font-weight="600" fill="#ea580c">block 0 (text)</text>
  <circle cx="56" cy="100" r="4" fill="#ea580c"/>
  <rect x="72" y="88" width="660" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="80" y="104" font-size="10" fill="currentColor">content_block_start  index=0  content_block={type:"text"}</text>
  <circle cx="56" cy="128" r="4" fill="#ea580c"/>
  <rect x="72" y="116" width="660" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="80" y="132" font-size="10" fill="currentColor">content_block_delta  index=0  text_delta "Let me read"</text>
  <circle cx="56" cy="156" r="4" fill="#ea580c"/>
  <rect x="72" y="144" width="660" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="80" y="160" font-size="10" fill="currentColor">content_block_delta  index=0  text_delta " README.md..."</text>
  <circle cx="56" cy="184" r="4" fill="#ea580c"/>
  <rect x="72" y="172" width="660" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="80" y="188" font-size="10" fill="currentColor">content_block_stop  index=0</text>
  <text x="40" y="218" font-size="11" font-weight="600" fill="#7c3aed">block 1 (tool_use)</text>
  <circle cx="56" cy="228" r="4" fill="#7c3aed"/>
  <rect x="72" y="216" width="660" height="24" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="80" y="232" font-size="10" fill="currentColor">content_block_start  index=1  tool_use id="toolu_01..." name="read"</text>
  <circle cx="56" cy="256" r="4" fill="#7c3aed"/>
  <rect x="72" y="244" width="660" height="24" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="80" y="260" font-size="10" fill="currentColor">content_block_delta  index=1  input_json_delta partial_json='{"file'</text>
  <circle cx="56" cy="284" r="4" fill="#7c3aed"/>
  <rect x="72" y="272" width="660" height="24" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="80" y="288" font-size="10" fill="currentColor">content_block_delta  index=1  input_json_delta partial_json='Path":"REA'</text>
  <circle cx="56" cy="312" r="4" fill="#7c3aed"/>
  <rect x="72" y="300" width="660" height="24" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="80" y="316" font-size="10" fill="currentColor">content_block_delta  index=1  input_json_delta partial_json='DME.md"}'</text>
  <circle cx="56" cy="340" r="4" fill="#7c3aed"/>
  <rect x="72" y="328" width="660" height="24" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="80" y="344" font-size="10" fill="currentColor">content_block_stop  index=1</text>
  <circle cx="56" cy="372" r="4" fill="#0ea5e9"/>
  <rect x="72" y="360" width="660" height="24" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="80" y="376" font-size="10" fill="currentColor">message_delta  stop_reason="tool_use"</text>
  <text x="40" y="412" font-size="10" fill="#64748b">两个 content block：block 0 = "Let me read README.md..." 文本；</text>
  <text x="40" y="430" font-size="10" fill="#64748b">block 1 = tool_use(read)，参数 JSON 被切成 3 个 partial_json 片段，stop 时拼起来再 JSON.parse。</text>
</svg>
<span class="figure-caption">图 T8.1 ｜ Anthropic SSE 帧流：一次 tool_use 回复由两个 content block 组成，参数被切成 partial_json 片段——本步骤就是要把这串归一成 LLMEvent。</span>

<details>
<summary>ASCII 原版</summary>

```text
event: message_start         data: {"type":"message_start","message":{"usage":{...}}}
event: content_block_start   data: {"type":"content_block_start","index":0,
                                    "content_block":{"type":"text","text":""}}
event: content_block_delta   data: {"type":"content_block_delta","index":0,
                                    "delta":{"type":"text_delta","text":"Let me read"}}
event: content_block_delta   data: {"type":"content_block_delta","index":0,
                                    "delta":{"type":"text_delta","text":" README.md..."}}
event: content_block_stop    data: {"type":"content_block_stop","index":0}
event: content_block_start   data: {"type":"content_block_start","index":1,
                                    "content_block":{"type":"tool_use",
                                                     "id":"toolu_01...","name":"read","input":{}}}
event: content_block_delta   data: {"type":"content_block_delta","index":1,
                                    "delta":{"type":"input_json_delta","partial_json":"{\"file"}}
event: content_block_delta   data: {"type":"content_block_delta","index":1,
                                    "delta":{"type":"input_json_delta","partial_json":"Path\":\"REA"}}
event: content_block_delta   data: {"type":"content_block_delta","index":1,
                                    "delta":{"type":"input_json_delta","partial_json":"DME.md\"}"}}
event: content_block_stop    data: {"type":"content_block_stop","index":1}
event: message_delta         data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}
```

</details>

这是**两个 content block**——block 0 是 "Let me read README.md..." 文本，block 1 是 `tool_use` 工具调用，参数被切成三个 `input_json_delta` 片段。系统现在的任务是把这一长串 provider-specific 事件，归一成 opencode 上层认识的 `LLMEvent`。

## 2. 问题

上层 `SessionProcessor`（trace 第 12 步会看到）只想消费一种 schema：`LLMEvent`——`text-delta`、`tool-input-start`、`tool-input-delta`、`tool-input-end`、`tool-call`、`step-finish`、`finish` 等十几种 tagged union。它不应该知道：

- Anthropic 把 tool_use id 放在 `content_block_start` 里，但参数 JSON 是分块 `partial_json` 拼出来的；
- OpenAI Chat 把 tool_calls 放进 `choices[0].delta.tool_calls[]`，每个元素自带 `index` 和 `function.arguments` 增量；
- OpenAI Responses 用 `response.output_item.added` + `response.function_call_arguments.delta`；
- Gemini 在 `candidates[0].content.parts` 里直接给完整 `functionCall`；
- Bedrock Converse 用 `contentBlockStart` + `toolUse.input`（结构类 Anthropic 但事件类型名不同）。

每个 provider 还都有自己的 finish reason 命名、usage 统计字段、错误体格式。如果让上层关心这些，每加一家 provider 就要改 SessionProcessor。

这一步要做的事：把 SSE 字节流变成一串干净的 `LLMEvent`，并保证两个不变量——`tool-call` 事件出现时 `input` 已经是**解析过的对象**（不是半截 JSON 字符串），text/tool-call 的顺序与模型实际产出的顺序一致。

## 3. 朴素思路

最直接的写法是在 `session/llm.ts` 里写一个大 `switch (event.type)`，每个 case 把 provider 字段往业务字段映射：

```ts
for await (const ev of sseStream) {
  if (provider === "anthropic") {
    if (ev.type === "content_block_delta" && ev.delta.type === "input_json_delta") {
      pendingArgs[ev.index] += ev.delta.partial_json
    }
    // ...
  }
  if (provider === "openai") {
    if (ev.choices?.[0]?.delta?.tool_calls) {
      // ...
    }
  }
  // ...
}
```

写过 langchain-style 集成的人会觉得这就是日常活——switch 大但可读。

## 4. 为什么朴素思路会崩

第一个反例：opencode 同时支持 anthropic、openai、openai-responses、openai-compatible、gemini、bedrock、vertex 等十几家，每家还有十几种 OpenAI-兼容的中转网关（Together、DeepSeek、Cerebras、Groq、Fireworks、OpenRouter…）。把它们塞进同一个文件，函数行数会冲过 3000，每加一家都要改公共代码。

第二个反例：**流式状态机里有微妙的不变量**。Anthropic 的 `input_json_delta` 必须在 `content_block_start(type=tool_use)` 之后到来；OpenAI Chat 不发独立 stop 事件、所有 tool_call 在 `finish_reason` 时一齐 finalize；OpenAI Responses 在 `response.output_item.done` 里还会**重复一次完整 arguments**，要求 final 值覆盖 streaming 累积值。这些规则放在 switch 里很容易写错——一个 if 漏分支，partial_json 会拼出无效 JSON，下游 `JSON.parse` 直接抛错把整个回合废掉。

第三个反例：tool_call 的 args 在网线上是**字符串片段**，但 `LLMEvent.toolCall.input` 必须是已 parse 的对象。这个"从片段拼字符串到对象"的过程跟"识别 tool 的 id/name"是两件不同的事，但它们的状态机彼此咬合（你需要先在 start 阶段记下 id/name，到 stop 阶段才能 emit `tool-call`）。把这些状态混在大 switch 里很难写对。

## 5. opencode 的做法

opencode 把这一层叫做 **Protocols**：每个 provider 的 wire protocol 是一个独立文件，向外暴露统一的 `Protocol` 接口。Anthropic Messages 的实现在 `packages/llm/src/protocols/anthropic-messages.ts`，OpenAI Chat 在 `openai-chat.ts`，等等。

`Protocol` 的形状（`packages/llm/src/route/protocol.ts:36-43`）：

```ts
interface Protocol<Body, Frame, Event, State> {
  readonly id: ProtocolID
  readonly body: ProtocolBody<Body>     // 请求侧：构造 + 校验 provider body
  readonly stream: ProtocolStream<Frame, Event, State>  // 响应侧：状态机
}

interface ProtocolStream<Frame, Event, State> {
  readonly event: Schema.Codec<Event, Frame>                  // 把帧解析成 provider event
  readonly initial: () => State                               // 状态机初值
  readonly step: (state, event) => Effect<[State, LLMEvent[]]> // 单步：输入 event，输出零或多个 LLMEvent
  readonly onHalt?: (state) => LLMEvent[]
}
```

整个流水线在 `packages/llm/src/route/client.ts:276-292` 拼起来：

```ts
streamPrepared: (prepared, request, runtime) => {
  const events = routeInput.transport
    .frames(prepared, request, runtime)            // 字节 → 帧（SSE 切 data: 行）
    .pipe(Stream.mapEffect(decodeEvent(route)),    // 帧 → provider Event（JSON 解码 + schema 校验）
          protocol.stream.terminal ? ... : id)
  return events.pipe(
    Stream.mapAccumEffect(
      protocol.stream.initial,                     // 起一个 ParserState
      protocol.stream.step,                        // 每个 event 跑一步，输出 [新 state, LLMEvent[]]
      protocol.stream.onHalt ? { onHalt } : ...,
    ),
    Stream.catchCause(...),
  )
}
```

`Stream.mapAccumEffect` 是关键——它把"有状态的解码"封进 Effect 的 Stream 原语里，外面看就是一条干净的 `LLMEvent` 流。

具体到 Anthropic：

- `anthropic-messages.ts:202-217` 把每条 SSE event 当作 `AnthropicEvent` schema 解；
- `:219-223` 定义 `ParserState`：一个 `tools` map（按 `event.index` 索引每个 pending tool_use 的 id/name/累积 input 字符串）、一个 `usage` 字段、一个 `Lifecycle.State`（管 `step-start`/`step-finish` 的成对）；
- `:726-734` 的 `step` 函数按 `event.type` 分派到 `onMessageStart / onContentBlockStart / onContentBlockDelta / onContentBlockStop / onMessageDelta / onError`；
- `:574-618` 的 `onContentBlockStart` 看到 `type === "tool_use"` 时调 `ToolStream.start(...)` 把 `{id, name, input: ""}` 存进 `state.tools[index]`，同时 emit 一个 `LLMEvent.toolInputStart`；
- `:661-674` 的 `input_json_delta` 分支把 `partial_json` 字符串追加到 `state.tools[index].input`，每追加一段就 emit 一个 `LLMEvent.toolInputDelta`（让上层做流式预览成为可能）；
- `:680-697` 的 `onContentBlockStop` 调 `ToolStream.finish(...)`：从累积的 JSON 字符串 `JSON.parse` 出最终对象，emit `LLMEvent.toolInputEnd` 和 `LLMEvent.toolCall({input: parsedObject})`。

把"流式拼接 tool 参数"这个最容易写错的部分抽到了 `protocols/utils/tool-stream.ts` 的小状态机里——五家 provider 共用它：`packages/llm/src/protocols/utils/tool-stream.ts:105-109` 的 `start`、`:146-157` 的 `appendExisting`（要求先 start）、`:117-139` 的 `appendOrStart`（OpenAI Chat 用的，因为它在第一个 delta 才给 id/name）、`:164-175` 的 `finish`、`:200-216` 的 `finishAll`。

对本 trace 来说，走完所有 SSE 事件后产生的 `LLMEvent` 序列大致是：

<svg viewBox="0 0 760 470" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="LLMEvent normalized sequence produced from SSE for one trace turn">
  <defs>
    <marker id="art82" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="40" y="24" font-size="12" font-weight="700" fill="currentColor">归一化后的 LLMEvent 序列（处理器视角）</text>
  <line x1="56" y1="42" x2="56" y2="448" stroke="#cbd5e1" stroke-width="1.2" stroke-dasharray="3,3"/>
  <g font-size="10" fill="currentColor">
    <circle cx="56" cy="56" r="4" fill="#0ea5e9"/>
    <rect x="72" y="44" width="660" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
    <text x="80" y="59">step-start</text>
    <circle cx="56" cy="82" r="4" fill="#ea580c"/>
    <rect x="72" y="70" width="660" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
    <text x="80" y="85">text-start  id="text-0"</text>
    <circle cx="56" cy="108" r="4" fill="#ea580c"/>
    <rect x="72" y="96" width="660" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
    <text x="80" y="111">text-delta  id="text-0"  text="Let me read"</text>
    <circle cx="56" cy="134" r="4" fill="#ea580c"/>
    <rect x="72" y="122" width="660" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
    <text x="80" y="137">text-delta  id="text-0"  text=" README.md..."</text>
    <circle cx="56" cy="160" r="4" fill="#ea580c"/>
    <rect x="72" y="148" width="660" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
    <text x="80" y="163">text-end    id="text-0"</text>
    <circle cx="56" cy="186" r="4" fill="#7c3aed"/>
    <rect x="72" y="174" width="660" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="80" y="189">tool-input-start  id="toolu_01..."  name="read"</text>
    <circle cx="56" cy="212" r="4" fill="#7c3aed"/>
    <rect x="72" y="200" width="660" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="80" y="215">tool-input-delta  id="toolu_01..."  text='{"file'</text>
    <circle cx="56" cy="238" r="4" fill="#7c3aed"/>
    <rect x="72" y="226" width="660" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="80" y="241">tool-input-delta  id="toolu_01..."  text='Path":"REA'</text>
    <circle cx="56" cy="264" r="4" fill="#7c3aed"/>
    <rect x="72" y="252" width="660" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="80" y="267">tool-input-delta  id="toolu_01..."  text='DME.md"}'</text>
    <circle cx="56" cy="290" r="4" fill="#7c3aed"/>
    <rect x="72" y="278" width="660" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="80" y="293">tool-input-end    id="toolu_01..."  name="read"</text>
    <circle cx="56" cy="316" r="4" fill="#7c3aed"/>
    <rect x="72" y="304" width="660" height="24" rx="3" fill="#7c3aed" stroke="#7c3aed"/>
    <text x="80" y="320" fill="#fff" font-weight="600">tool-call  id="toolu_01..."  name="read"  input={ filePath:"README.md" }</text>
    <circle cx="56" cy="346" r="4" fill="#0d9488"/>
    <rect x="72" y="334" width="660" height="22" rx="3" fill="#99f6e4" stroke="#0d9488"/>
    <text x="80" y="349">step-finish  reason="tool-calls"  usage={...}</text>
    <circle cx="56" cy="372" r="4" fill="#0d9488"/>
    <rect x="72" y="360" width="660" height="22" rx="3" fill="#99f6e4" stroke="#0d9488"/>
    <text x="80" y="375">finish       reason="tool-calls"  usage={...}</text>
  </g>
  <text x="40" y="410" font-size="10" fill="#64748b">• ToolStream.start 在 content_block_start(tool_use) 时存 {id, name, input:""}</text>
  <text x="40" y="426" font-size="10" fill="#64748b">• 每个 partial_json 追加到 state.tools[index].input 并 emit tool-input-delta</text>
  <text x="40" y="442" font-size="10" fill="#64748b">• content_block_stop → ToolStream.finish：JSON.parse 累积串 → emit tool-input-end + tool-call</text>
</svg>
<span class="figure-caption">图 T8.2 ｜ 归一化后的 LLMEvent 序列：text-* / tool-input-* / tool-call / step-finish 全部对应到统一 schema，processor 完全无需感知 provider 协议。</span>

<details>
<summary>ASCII 原版</summary>

```text
step-start
text-start id="text-0"
text-delta id="text-0" text="Let me read"
text-delta id="text-0" text=" README.md..."
text-end   id="text-0"
tool-input-start id="toolu_01..." name="read"
tool-input-delta id="toolu_01..." text="{\"file"
tool-input-delta id="toolu_01..." text="Path\":\"REA"
tool-input-delta id="toolu_01..." text="DME.md\"}"
tool-input-end   id="toolu_01..." name="read"
tool-call        id="toolu_01..." name="read" input={filePath:"README.md"}
step-finish reason="tool-calls" usage={...}
finish      reason="tool-calls" usage={...}
```

</details>

注意：opencode 默认实际跑的是 **AI SDK 路径**（`session/llm.ts:271-340` 里的 `streamText({...})`）。AI SDK 内部自己实现了一套类似的 provider 解码，然后 opencode 在 `session/llm/ai-sdk.ts:61-251` 用 `LLMAISDK.toLLMEvents` 把 AI SDK 的 `fullStream` 事件**再翻译一次**到同一份 `LLMEvent` 联合。"native" 协议层（本步骤讲的 `packages/llm/protocols/*`）是 1.15 推出的 opt-in 路径，由 `flags.experimentalNativeLlm` 切换（`session/llm.ts:220-258`）。两条路径**收敛在同一个 `LLMEvent` schema**——这正是这一层抽象的价值：上层完全感知不到换没换协议实现。

## 6. 代码位置

按数据流方向：

- `packages/llm/src/route/protocol.ts:36-63` —— `Protocol` 接口定义，是这一层的契约。
- `packages/llm/src/protocols/index.ts:1-6` —— 五个协议家族的导出汇总（Anthropic / Bedrock / Gemini / OpenAI Chat / OpenAI Responses / OpenAI Compatible）。
- `packages/llm/src/route/client.ts:223-298` —— `makeFromTransport`：把 `Protocol` 接到具体 transport（HTTP/SSE）上；`:276-292` 是 `streamPrepared` 的核心流水线。
- `packages/llm/src/protocols/anthropic-messages.ts:177-217` —— Anthropic SSE event 的 schema（`AnthropicStreamBlock` / `AnthropicStreamDelta` / `AnthropicEvent`）。
- `packages/llm/src/protocols/anthropic-messages.ts:219-223` —— `ParserState` 定义。
- `packages/llm/src/protocols/anthropic-messages.ts:574-618` —— `onContentBlockStart`：识别 `tool_use` / `server_tool_use` / `text` / `thinking`。
- `packages/llm/src/protocols/anthropic-messages.ts:620-678` —— `onContentBlockDelta`：处理 `text_delta` / `thinking_delta` / `signature_delta` / `input_json_delta` 四种 delta。`:661-674` 是本 trace 关心的 `input_json_delta` 拼接。
- `packages/llm/src/protocols/anthropic-messages.ts:680-697` —— `onContentBlockStop`：调 `ToolStream.finish` 终结一个 tool_use，emit `tool-input-end` + `tool-call`。
- `packages/llm/src/protocols/anthropic-messages.ts:726-755` —— `step` 调度 + `protocol = Protocol.make({...})`。
- `packages/llm/src/protocols/utils/tool-stream.ts:12-39` —— `PendingTool` / `State` / `AppendOutcome`：通用 tool-call 累积器的核心数据类型。
- `packages/llm/src/protocols/utils/tool-stream.ts:105-216` —— `start` / `appendOrStart` / `appendExisting` / `finish` / `finishAll`：跨 provider 复用的小状态机。
- `packages/llm/src/schema/events.ts:127-159` —— `ToolInputStart` / `ToolInputDelta` / `ToolInputEnd` / `ToolCall` 的 schema 定义；`:206-223` 把它们和 `text-*` / `reasoning-*` / `step-*` / `finish` / `provider-error` 合并成 tagged union `LLMEvent`。
- `packages/llm/src/schema/messages.ts:89-103` —— `ToolCallPart` 的 internal Part schema：`{type:"tool-call", id, name, input}`，是 `tool-call` 事件最终累积进 message 的载体。
- `packages/llm/src/tool-runtime.ts:181-217` —— `accumulate`：把流出来的 `LLMEvent` 累进 `StepState`，`event.type === "tool-call"` 时把 `ToolCallPart` push 进 `assistantContent` 和 `toolCalls` 两个数组。
- `packages/opencode/src/session/llm/ai-sdk.ts:161-203` —— AI SDK 路径下的对偶实现：把 AI SDK 的 `tool-input-start` / `tool-input-delta` / `tool-call` event 翻译成同一份 `LLMEvent`。
- `packages/opencode/src/session/llm.ts:343-367` —— 两条 runtime 路径汇聚点：native 直接返回 `LLMEvent` 流；AI SDK 经过 `LLMAISDK.toLLMEvents` 转一道。

## 7. 分支与延伸

- **Protocols 层全貌**：见 [第 06 章 §Protocols 层 / Tool 协议适配 / 流式：协议解码](06-llm-providers.md#protocols-层)。本步骤只展开了 Anthropic 一家；OpenAI Chat / Responses / Gemini / Bedrock 都遵循同样的 `Protocol.make({...})` 形状，差异都封进各自文件。
- **LLMEvent 与 MessageV2 的对应**：`LLMEvent` 是**流式中间态**，最终会落进 `MessageV2.Part`。它们的关系见 [第 03 章 §MessageV2 与 Part](03-session-and-messages.md#messagev2-与-part为什么要拆开)。
- **AI SDK 路径 vs Native 路径**：默认走 AI SDK，`flags.experimentalNativeLlm` 切到 native。两条路径的取舍和 fallback 见 [第 06 章 §Tool runtime](06-llm-providers.md#tool-runtime)。
- **`tool-input-delta` 谁在消费**：默认情况下没人消费——`session/processor.ts:357-360` 直接 return。它的存在是为了让前端（TUI / Web UI）实时渲染"正在写 args"的占位 UI。本 trace 用的 `opencode run` 不依赖这个。
- **server_tool_use**：Anthropic 的 `web_search` / `code_execution` / `web_fetch` 是 provider 内部执行的，结果直接灌进 assistant 消息——见 `anthropic-messages.ts:541-563` 的 `serverToolResultEvent`，本 trace 不触发。

## 8. 走完这一步你脑子里应该多了什么

1. **`LLMEvent` 是 opencode 的"统一币"**——只要把 provider 的 wire protocol 翻译成它，上层就完全跟 provider 解耦；新接一家 provider = 加一个 `Protocol.make({...})`。
2. **流式 tool_use 解码是一个小状态机**：start 记 id/name，delta 拼 JSON 字符串，stop 一次 parse 出对象。这套机制抽进了 `protocols/utils/tool-stream.ts`，五家协议复用同一份。
3. **`Protocol` 把"语义契约"和"部署细节"分开**：协议（哪种 API、什么 schema、什么状态机）和路由（哪个 URL、什么 auth、什么 framing）是两层抽象——`Protocol.make` 写一次，`Route.make` 可以拼出 Vertex Anthropic、Bedrock Anthropic、原生 Anthropic 三个部署而不重复代码。
4. **`Stream.mapAccumEffect` 是流式状态机的核心**：它让"带状态的解码"成为一个 declarative 的流变换，不需要手写 while 循环和 mutable state。
5. **走完这一步，opencode 视角里这条 stream 已经看完一半**：`Let me read README.md...` 文本和 `tool_use(read, {filePath: "README.md"})` 都已经被解出来，下一步上层要做的是"找到 read 这个工具对象、校验 args"。
6. **opencode 里 AI SDK 和 native 是同一份合约的两条实现**——`session/llm.ts` 在最后把它们都收束到同一个 `LLMEvent` 流。

下一步：[Trace 步骤 09 —— 查表分派 `read` 工具](tour-09-tool-dispatch.md)
