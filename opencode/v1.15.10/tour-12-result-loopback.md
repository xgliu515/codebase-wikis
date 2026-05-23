# Trace 步骤 12 —— 工具结果回灌

## 1. 当前情境

第 11 步执行完，assistant 消息现在长这样（按 PartTable 的写入顺序）：

```text
Message(assistant, id=msg_2, finish=undefined, time.completed=undefined)
 ├─ Part(step-start, snapshot=...)
 ├─ Part(text, "Let me read README.md to find out.")
 ├─ Part(toolCall, tool=read, callID=call_1, state=completed, output=<...README...>)
```

那条 toolCall 的 `state` 已经被 `completeToolCall` 翻成 `completed`、`output` 字段塞满了 README 内容。SQLite 也已经写了一次、Bus 也已经发了一次 `MessagePartUpdated`。

**但 agent 循环并没有停**——SessionProcessor 这次的 stream 在收到 `tool-result` 之后还会继续等：AI SDK 内部循环很可能立刻发一个 `step-finish` 把这一"步"画上句号，然后接下来会不会 `start-step` 再发一次取决于 stop reason。

第一次 LLM 给的 `finishReason` 是 `tool-calls`（Anthropic 叫 `tool_use`），意味着"模型只是想用个工具，话还没说完"。这一步要做的事，就是**把工具结果当作新的 assistant 内容拼回 messages，启动第二次 LLM 调用**。

## 2. 问题

具体要解决：

1. **决定要不要继续循环**：第一次 stream 关闭之后，到底是终止、还是接着发请求？依据是什么？
2. **重新组装 messages**：第二次请求发出去的 `messages` 列表，跟第一次有什么不同？assistant 那条新长出来的 tool_use + tool_result 怎么编码成模型理解的格式？
3. **不重复劳动**：system prompt、工具表、user 消息这些第一次已经计算过，第二次要不要全部重算？
4. **provider 的 cache 优势怎么用上**：Anthropic / Bedrock 提供 prompt cache，能把 system + tools + 历史消息的 prefix 复用 5 分钟。第二次请求的 prefix 跟第一次几乎全等，理想情况下只有 assistant 段是"新写入"，剩下都应该命中 cache。
5. **副作用要排队**：summary 任务、snapshot diff 写入、status 切换……这些 step-finish 触发的善后必须在新一轮启动之前归位，不然新请求和旧请求会在 status 总线上打架。

## 3. 朴素思路

```ts
while (true) {
  const res = await llm.stream({ messages })
  if (!res.toolCalls.length) break
  for (const call of res.toolCalls) {
    const out = await runTool(call)
    messages.push({ role: "tool", content: out })
  }
}
```

每轮自己看模型有没有发工具，发了就执行、append 进 messages 继续转。

## 4. 为什么朴素思路会崩

- **"模型回了答案就结束"是错的**：模型发完 `tool_use` 就停了，AI SDK 视角的 `finishReason` 是 `tool-calls`，但这跟 `end_turn` 完全不一样。当成结束，用户就只看到第一轮那句铺垫。
- **`stop` 这个 reason 也会骗你**：某些 provider 即使发了 tool_use 也回 `stop`——opencode 在 `prompt.ts:1260-1265` 专门处理过这个 case："Some providers return 'stop' even when the assistant message contains tool calls."
- **"messages 一直 push"会爆**：10 轮工具调用之后 prefix 长成 100 KB，但 provider 看不出这 100 KB 跟上次基本一样——除非显式打 cache 断点。
- **system / tools 重算**：每轮重新 build system + serialize tool schemas 是几十到几百毫秒的浪费，还容易让"环境提示"漂移。
- **副作用乱序**：朴素循环里 step-finish 还没跑完就开下一轮，summary 进程和新 LLM 流可能同时改 assistantMessage。

## 5. opencode 的做法

opencode 的回灌不是发生在 SessionProcessor 内部，而是在**更外一层的 `runLoop`**（`session/prompt.ts:1239-1481`）里。SessionProcessor 只负责消费一次 stream，**它跑完一次 process 就返回 `"compact" | "stop" | "continue"`**，由 runLoop 决定要不要再来一次：

```text
   runLoop (session/prompt.ts:1239)
        │
        ▼
   while (true) {
        msgs = MessageV2.filterCompactedEffect(sessionID)   // 重新读库
        判断 last assistant 是否已经 finished
        if (finished && !hasToolCalls) break                // 终止条件
        msg = new Assistant(...)                            // 新一轮 assistant
        handle = processor.create({ assistantMessage: msg, sessionID, model })
        result = handle.process({ system, messages, tools, ... })
        if (result === "stop") break
        if (result === "compact") compaction.create(...)
        continue
   }
```

这是一个**外层循环 + 内层一次性 processor** 的结构。SessionProcessor 是"消费一个 stream"，runLoop 是"决定要不要再来一个 stream"。

### 5.1 终止条件：到底什么时候 break

`session/prompt.ts:1267-1275` 写得很显式：

```ts
if (
  lastAssistant?.finish &&
  !["tool-calls"].includes(lastAssistant.finish) &&
  !hasToolCalls &&
  lastUser.id < lastAssistant.id
) {
  yield* slog.info("exiting loop")
  break
}
```

三个 AND 条件：

1. **`finish` 字段存在**：说明上一轮拿到了 step-finish。
2. **`finish !== "tool-calls"`**：模型自己说"我说完了"。
3. **assistant parts 里没有"未被 provider 执行"的 tool call**：因为有些 provider 即使 finish=stop 也照样夹带 tool_use（见 `prompt.ts:1260-1265` 的注释）。
4. **`lastUser.id < lastAssistant.id`**：消息序确实在 assistant 之后才该停（防止 user 中途插话被忽略）。

刚跑完第 11 步，`hasToolCalls === true`（那个 read toolCall 就是），所以**第一次循环判定失败，不 break**。继续走。

### 5.2 新一轮 assistant 消息

每轮**新建一条 Assistant 消息**（`prompt.ts:1331-1346`）：`MessageID.ascending()` 申一个新 id、`parentID = lastUser.id`、`finish` 留空、`tokens` 清零、`time.created = now`、立刻 `sessions.updateMessage(msg)` 落库。

也就是说 `Message(assistant, id=msg_3)` 是新建的、不是续写 `msg_2`。第 11 步那条 toolCall 留在 `msg_2` 里；第二次模型的回答会落在 `msg_3`。这就是 opencode "一次 stream = 一条 assistant 消息" 的约定。

### 5.3 重新组装 messages 喂给 LLM

`prompt.ts:1419-1424` 这一段：

```ts
const [skills, env, instructions, modelMsgs] = yield* Effect.all([
  sys.skills(agent),
  sys.environment(model),
  instruction.system().pipe(Effect.orDie),
  MessageV2.toModelMessagesEffect(msgs, model),
])
const system = [...env, ...instructions, ...(skills ? [skills] : [])]
```

注意 `msgs` 是循环开头通过 `MessageV2.filterCompactedEffect(sessionID)` **重新从库里读**出来的——含 user、含 `msg_2`（带 toolCall+toolResult）、还可能含之前的对话历史。

`MessageV2.toModelMessagesEffect(msgs, model)` 是 opencode 把内部 Part 模型翻译成 AI SDK 通用 `ModelMessage` 的关键 effect：每个 `Part(toolCall)` 翻成 `{ type: "tool-call", toolCallId, toolName, input }`、每个 `Part(toolResult)` 翻成 `{ type: "tool-result", toolCallId, output }`，纳入 assistant content array。**system 段每轮都 rebuild**（cwd 可能变了、agent skills 可能不同），但 messages 是从存储里 deserialize 出来的，结构上跟第一次的 messages 完全一致——只是多了两段（assistant 的 toolCall + tool result）。

`step === 1` 时还会触发 `summary.summarize` fork（`prompt.ts:1396-1397`），但只 fork 一次——本次循环是 step=2，跳过。

### 5.4 第二次 stream 的入口：handle.process

`prompt.ts:1428-1439` 调 `handle.process({ user, agent, system, messages, tools, model, ... })`。`handle.process`（`session/processor.ts:780-849`）的核心三行：

```ts
const stream = llm.stream(streamInput)
yield* stream.pipe(Stream.tap(handleEvent), Stream.takeUntil(() => ctx.needsCompaction), Stream.runDrain)
```

——它进 `LLM.stream`、订阅 stream、对每个 LLMEvent 调 `handleEvent`，直到 stream 结束或标记 needsCompaction。`LLM.stream`（`session/llm.ts:343-367`）里 `run({ ...input, abort })` 触发 `streamText({ messages: prepared.messages, tools: prepared.tools, ... })`，AI SDK 把这堆消息发到 provider——**这就是第二次 LLM 请求真正出发的瞬间。**

### 5.5 Cache 怎么用上

`LLMRequestPrep.prepare`（`session/llm/request.ts`）里 messages 跑过 `cache-policy.ts` 一遍。默认 `"auto"` 策略（`cache-policy.ts:18-22`）`{ tools: true, system: true, messages: "latest-user-message" }`，三个 cache breakpoint 自动落在最后一条 tool definition、最后一段 system、最新的 user 消息尾部。

这三个断点意味着：第二次请求里，system + tools + 整段 user 段都跟第一次一模一样，provider 的 cache 直接命中（Anthropic 写入是 base 价的 1.25 倍、读取只有 0.1 倍——`cache-policy.ts:27-29` 算过帐）。**新增的只有 assistant 段 toolCall + toolResult**——在断点之后，cache miss、需要重新算。多轮叠下来成本是线性而非平方的。

只有 Anthropic Messages 和 Bedrock Converse 协议尊重 inline cache hints（`cache-policy.ts:42` 的 `RESPECTS_INLINE_HINTS` 白名单），OpenAI / Gemini 走的是"前缀隐式 cache"或 "out-of-band cached content"，那条路径里 cache-policy 整个 pass 跳过。

### 5.6 上一轮 step-finish 的善后

回灌之前其实 SessionProcessor 已经处理过 step-finish 事件（`session/processor.ts:555-617`）：

- snapshot diff 写成 `Part(patch)`（如果有文件改动）；
- usage 累计进 `assistantMessage.tokens` / `assistantMessage.cost`；
- `summary.summarize` fork 出去（异步，不阻塞循环）；
- 检查 overflow，必要时设 `ctx.needsCompaction = true`。

只有这些 effect 全跑完、stream `runDrain` 真返回，`handle.process` 才会 return `"continue"`、runLoop 才会 `continue` 进入下一轮。**这就是 opencode 不会让善后和新请求打架的根本原因**：处理器是同步消费一整条 stream 的，外层 while 拿到 string 才推下一步。

## 6. 代码位置

按本步骤的执行顺序：

- `packages/opencode/src/session/processor.ts:555-617` — step-finish 善后：snapshot patch、usage 累计、summary fork、overflow 检测。
- `packages/opencode/src/session/processor.ts:780-849` — `handle.process` 的 effect 体：起 stream、跑 takeUntil、判定 `compact / stop / continue` 三选一。
- `packages/opencode/src/session/processor.ts:35` — `Result = "compact" | "stop" | "continue"` 的类型定义。
- `packages/opencode/src/session/run-state.ts:87-93` — `ensureRunning`：保证同 session 只有一个 runner 在跑，runLoop 整个被它包住。
- `packages/opencode/src/session/prompt.ts:1239-1247` — `runLoop` 函数签名 + 外层 `while (true)`。
- `packages/opencode/src/session/prompt.ts:1251` — `MessageV2.filterCompactedEffect(sessionID)`：从 SQLite 重新读 messages（含上一步刚写入的 toolResult）。
- `packages/opencode/src/session/prompt.ts:1260-1275` — 终止条件三件套（`finish + !tool-calls + !hasToolCalls + lastUser.id < lastAssistant.id`），含那段"providers return 'stop' even with tool calls"的注释。
- `packages/opencode/src/session/prompt.ts:1331-1346` — 新建 Assistant 消息 `msg_3`。
- `packages/opencode/src/session/prompt.ts:1371-1385` — 调 `SessionTools.resolve`：重组 tool registry（system+MCP+plugin）。
- `packages/opencode/src/session/prompt.ts:1419-1426` — rebuild system + 翻译 messages 成 ModelMessage。
- `packages/opencode/src/session/prompt.ts:1428-1439` — 真正调 `handle.process`，第二次 LLM 请求出发。
- `packages/opencode/src/session/prompt.ts:1448-1470` — 看 `result`：`structured / "stop" / "compact" / "continue"` 四个分支。
- `packages/opencode/src/session/llm.ts:81-340` — `LLM.run`：拼参数、起 `streamText`、装配 transform middleware。
- `packages/opencode/src/session/llm.ts:343-367` — `Service.stream`：把 AI SDK fullStream 适配成 LLMEvent 流。
- `packages/opencode/src/session/llm/request.ts:54` — `LLMRequestPrep.prepare`：cache-policy 在这里跑。
- `packages/llm/src/cache-policy.ts:18-22` — `AUTO` 策略的三个 breakpoint。
- `packages/llm/src/cache-policy.ts:42` — `RESPECTS_INLINE_HINTS` 协议白名单。
- `packages/llm/src/cache-policy.ts:47-58` — 在最后一条 tool / 最后一段 system 上挂 CacheHint。
- `packages/llm/src/cache-policy.ts:67-80` — 给最新 user 消息标 cache 断点。

## 7. 分支与延伸

- **runLoop 全貌**：本步骤只切了"回灌"这一刀，整段循环含 compaction、subtask、reminders、max steps 上限等岔路，见 [第 05 章 §5.4 runLoop：一次循环的完整身世](05-agent-loop.md#54-runloop一次循环的完整身世) 和 [第 05 章 §5.5 状态机视角](05-agent-loop.md#55-状态机视角)。
- **终止条件的全集**：除了"finish + 无 toolCall" 之外，`max_steps`、`abort`、`compact` 都能终止，见 [第 05 章 §5.9 多轮预算与"跑飞了怎么办"](05-agent-loop.md#59-多轮预算与跑飞了怎么办)。
- **`SessionTools.resolve` 第二次会不会重读 plugin / MCP**：会，每轮都跑一遍 resolve；MCP 工具列表如果 server 端 push 了变更，下一轮就生效——这是 MCP 工具热更新的隐含路径，见 [第 11 章 MCP 集成](11-mcp.md)。
- **cache policy**：完整的 5 种 policy（`auto / none / 显式对象 / latest-user-message / 数组指定位置`）见 [第 06 章 §cache policy](06-llm-layer.md#cache-policy)（章节按计划属第 06 章 LLM 层）。
- **MessageV2 → ModelMessage 翻译**：`toModelMessagesEffect` 处理图片附件、合并连续同 role 段、把 reasoning Part 转为 provider-specific 格式，见 [第 03 章 §翻译到 LLM 的输入](03-session-and-messages.md#翻译到-llm-的输入)。
- **doom loop 检测**：连续 3 次同名同 args 的 tool call 会触发 `permission.ask({ permission: "doom_loop" })`，对应 `session/processor.ts:424-449`——这是循环失控时的最后一道闸。

## 8. 走完这一步你脑子里应该多了什么

1. **agent 循环的本质是"模型决定何时停"**：opencode 不在工具执行完之后假定结束，只在 `finish != "tool-calls" && parts 里没有 unhandled tool call` 时才退出。
2. **一次 stream = 一条 assistant 消息**：第二次 LLM 调用会建一条新的 `Assistant` 行（`msg_3`），不是续写 `msg_2`。前一轮的 toolCall + toolResult 留在 `msg_2` 里、被 `MessageV2.toModelMessagesEffect` 拼回去当历史。
3. **system + tools + history 每轮 rebuild，但靠 cache breakpoint 复用**：默认 `auto` 策略给 tools / system / 最新 user 三处打 cache hint，所以多轮工具调用的 token 成本是线性而非平方。
4. **`SessionProcessor.process` 是一次性的**：它消费一条 stream 直到 step-finish 善后跑完才 return；外层 `runLoop` 看 return 值再决定要不要发下一轮。**这两层分工是 opencode 不让"善后"和"新请求"打架的根本原因**。
5. **'stop' 不一定就是停**：某些 provider（早期 Anthropic、部分自托管模型）会在 tool_use 时也回 stop，opencode 显式忽略 finish 字段、改看"parts 里还有没有未消化的 toolCall"。
6. **下一步起点**：第二次 stream 已经发出去，处理器正在等第一波 LLMEvent 到达。这次的 stream 不会再有 toolCall——会只产 text delta，最终以 `end_turn` 收尾。这就是第 13 步要拆的"生成最终文本响应"。

下一步：[Trace 步骤 13 —— 生成最终文本响应](tour-13-final-text.md)
