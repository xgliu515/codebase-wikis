# 第 05 章 核心 Agent 循环（Session.chat）

opencode 不是「输入一次 prompt、模型回一次 text」的请求/响应 CLI，而是一个长循环：模型每一轮可能选择直接回复，也可能选择调用一个或多个工具；工具被本进程执行后，结果再送回模型，模型决定下一步。本章追踪一次用户消息从进入到沉默退出（finish=stop 且无 tool-calls）之间发生的所有事，并把容易让读者卡住的几个细节单独剖开：状态机、运行态 Runner、Processor 的事件机器、错误分类与重试退避、Ctrl-C 中断、上下文溢出 → 自动 compaction、subagent 嵌套。

读完本章你会能精确回答以下问题：

- 用户在 TUI 里按下 Enter 后，第一行执行的代码是哪一句？
- 第二轮 LLM 调用之前，opencode 在数据库里写入了哪些 `Part`、发布了哪些事件？
- LLM 返回 `tool_use` 时，是同一次 `streamText()` 内部完成工具执行（AI SDK 风格），还是 opencode 手动循环再次调用 LLM？
- 一个会话同时只能跑一个 LLM 流，靠的是哪个组件？
- 工具卡住、不响应 abort 时，会有什么后果？

## 5.1 五个文件，三层抽象

| 层 | 文件 | 行数 | 角色 |
|---|---|---|---|
| 编排 | `packages/opencode/src/session/prompt.ts:95-1623` | 1764 | `SessionPrompt` Effect 服务。`prompt` / `loop` / `command` / `shell` 入口，`runLoop` 主循环（`prompt.ts:1239-1482`），决定是否回到下一步、是否压缩、是否调度 subtask、是否退出 |
| 引擎 | `packages/opencode/src/session/processor.ts:87-863` | 883 | `SessionProcessor` Effect 服务。给定一个 `LLM.StreamInput`，把 LLM 流式事件翻译为 `MessageV2.Part`，写库、发布 bus 事件、维护 tool call 生命周期，最后返回 `"continue" | "stop" | "compact"` |
| 通道 | `packages/opencode/src/session/llm.ts:60-371` | 390 | `LLM` Effect 服务。把准备好的 `messages + tools + system` 喂给 AI SDK `streamText()`（或可选的 `@opencode-ai/llm` 原生路径），把得到的 fullStream 适配为统一的 `LLMEvent` 流。本层只跑一次 LLM 请求，不知道「循环」是什么 |

外加两个辅助文件：

- `packages/opencode/src/session/run-state.ts:28-108`（153 行）— 一个 sessionID 一个 `Runner`，保证「同会话最多一个生成在跑」，并管 Ctrl-C 取消。
- `packages/opencode/src/session/retry.ts:67-198`（200 行）— 哪些错误可重试、退避多久。

整体调用栈一图：

<svg viewBox="0 0 760 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Session chat call stack from TUI to AI SDK streamText">
  <defs>
    <marker id="ar51" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="240" y="14" width="280" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="36" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">TUI / HTTP / SDK</text>
  <path d="M380,50 L380,72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar51)"/>
  <rect x="120" y="74" width="520" height="64" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="92" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">SessionPrompt.prompt(input)</text>
  <text x="380" y="107" text-anchor="middle" font-size="10" fill="#64748b">prompt.ts:1210-1229</text>
  <text x="380" y="124" text-anchor="middle" font-size="10.5" fill="currentColor">revert.cleanup → createUserMessage → sessions.touch → loop()</text>
  <path d="M380,138 L380,160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar51)"/>
  <rect x="120" y="162" width="520" height="48" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="180" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">SessionPrompt.loop → state.ensureRunning</text>
  <text x="380" y="197" text-anchor="middle" font-size="10" fill="#64748b">run-state.ts:87-93 ｜ Runner 强制同会话单飞</text>
  <path d="M380,210 L380,232" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar51)"/>
  <rect x="80" y="234" width="600" height="118" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="252" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">SessionPrompt.runLoop  while (true)</text>
  <text x="380" y="265" text-anchor="middle" font-size="10" fill="#64748b">prompt.ts:1239-1482</text>
  <rect x="100" y="275" width="560" height="68" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="116" y="290" font-size="10.5" fill="currentColor">① status.busy → filterCompacted → latest(msgs)</text>
  <text x="116" y="304" font-size="10.5" fill="currentColor">② 终止判定（finish=stop &amp;&amp; !hasToolCalls）→ break</text>
  <text x="116" y="318" font-size="10.5" fill="currentColor">③ handleSubtask / compaction / overflow→compact</text>
  <text x="116" y="332" font-size="10.5" fill="currentColor">④ processor.create → handle.process(streamInput)</text>
  <path d="M380,352 L380,374" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar51)"/>
  <rect x="120" y="376" width="520" height="62" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="394" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">SessionProcessor.process</text>
  <text x="380" y="409" text-anchor="middle" font-size="10" fill="#64748b">processor.ts:780-849</text>
  <text x="380" y="425" text-anchor="middle" font-size="10.5" fill="currentColor">for event in llm.stream: handleEvent(event)  → "continue" | "stop" | "compact"</text>
  <path d="M380,438 L380,460" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar51)"/>
  <rect x="120" y="462" width="520" height="68" rx="6" fill="#fff" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="380" y="480" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">LLM.stream（单次模型调用）</text>
  <text x="380" y="495" text-anchor="middle" font-size="10" fill="#64748b">llm.ts:343-367 ｜ AbortController + acquireRelease</text>
  <text x="380" y="513" text-anchor="middle" font-size="10.5" fill="currentColor">LLMRequestPrep.prepare → streamText(...) → LLMAISDK.toLLMEvents</text>
</svg>
<span class="figure-caption">图 R5.1 ｜ 一次用户消息从 TUI/SDK 入口下钻到 AI SDK streamText 的五层调用栈；runLoop 是真正的"循环"，processor 是单次流的翻译器。</span>

<details>
<summary>ASCII 原版</summary>

```text
TUI / HTTP / SDK
   |
   v
SessionPrompt.prompt(input)            prompt.ts:1210-1229
   |   1. revert.cleanup(session)
   |   2. createUserMessage(input)     prompt.ts:688-1208  (写入 User Message + 各 Part)
   |   3. sessions.touch
   |   4. loop({ sessionID })
   v
SessionPrompt.loop                     prompt.ts:1484-1488
   |   state.ensureRunning(...)        run-state.ts:87-93
   v                                   (Runner 强制单飞)
SessionPrompt.runLoop                  prompt.ts:1239-1482
   |   while (true) {
   |     1. status.set(busy)
   |     2. msgs = filterCompacted
   |     3. lastUser / lastAssistant / lastFinished / tasks = latest(msgs)
   |     4. 终止判定 (lastAssistant.finish && no toolCalls)
   |     5. handleSubtask  / compaction  / overflow→compact
   |     6. processor.create({ assistantMessage, sessionID, model })
   |     7. handle.process(streamInput)   <-- 单次 LLM 流
   |     8. 根据 process 返回 break/continue
   |   }
   v
SessionProcessor.process               processor.ts:780-849
   |   llm.stream(streamInput)          <-- 真正一次模型调用
   |   for event in stream { handleEvent(event) }   processor.ts:305-689
   |   Effect.retry(SessionRetry.policy)
   |   return "continue"|"stop"|"compact"
   v
LLM.stream                             llm.ts:343-367
   |   AbortController + acquireRelease
   |   run(StreamRequest)               llm.ts:81-341
   |     LLMRequestPrep.prepare(...)    llm/request.ts:54-186
   |     streamText({ ... })            (AI SDK 主路径)
   |     LLMAISDK.toLLMEvents(...)      llm/ai-sdk.ts:61-251
```

</details>

下文按 `prompt.ts:1239-1482` 的 `runLoop` 顺序展开。

## 5.2 入口：prompt → loop → runLoop

`SessionPrompt.Interface`（`prompt.ts:84-91`）只暴露 5 个方法：

```text
cancel              中断当前 session 的所有生成
prompt              发送用户消息并默认进入 loop；noReply=true 则只落库不调模型
loop                没有新用户消息，让模型继续（subagent 完成、background 任务回灌时用）
shell               跑一条 shell 命令并落到一条 assistant 消息（不调 LLM）
command             解析 /命令 并展开为 prompt
resolvePromptParts  把 "@文件" / "@agent" 等 mention 解析成 file/agent parts
```

`prompt()` 流程（`prompt.ts:1210-1229`）只做四件事：

```ts
const session = yield* sessions.get(input.sessionID)
yield* revert.cleanup(session)                  // 清理上一次 revert 残留快照
const message = yield* createUserMessage(input) // 落库 User Message 及所有 part
yield* sessions.touch(input.sessionID)          // 更新 time_updated
if (input.noReply === true) return message
return yield* loop({ sessionID })
```

`createUserMessage`（`prompt.ts:688-1208`）干的活非常多但与 chat 循环主旨无关：解析 `@file` → 直接调 Read 工具把文件内容塞进同步 part（合成 `synthetic: true`，模型看到时显得像之前调用 Read 工具拿到的）、解析 `@agent` → 给后续工具 use task 留下提示、把 MCP resource 抓取并展开、规范化 image part。最终落库 `MessageV2.User` 主体 + 多个 `MessageV2.Part`。

接着 `loop({ sessionID })` 把控制权交给 `runLoop`，但中间隔了一层 `state.ensureRunning`。

## 5.3 RunState：同会话单飞与中断

`SessionRunState`（`run-state.ts:28-108`）维护 `Map<SessionID, Runner>`。`ensureRunning` 拿到/新建 sessionID 对应的 Runner，再把 `runLoop(sessionID)` 这个 Effect 交给 `Runner.ensureRunning(work)`。Runner 的关键性质：

- 同一时间最多一个 `work` 在跑（`assertNotBusy` 检测，外面要并发提交直接抛 `Session.BusyError`，`session.ts:445-447`）。
- `cancel`（`run-state.ts:76-85`）通过 Effect 的 interrupt 触发：Runner 内部的 fiber 收到 interrupt，AbortController 的 `abort()` 被调用，AI SDK 的 streamText 立刻终止，processor 的 `Effect.onInterrupt` 把 assistant 消息标记 `AbortError`。
- 同时取消「与该 session 相关的所有 BackgroundJob」（`run-state.ts:115-147`）：递归找出 `sessionId === sessionID` 或 `parentSessionId === sessionID` 的 background job 一律 cancel。这就是为什么用户在 TUI 里 Ctrl-C 父会话，会同时杀掉跑在它名下的 `task` 工具开的所有子 session。

Runner 还负责 `onIdle / onBusy` 回调：

```ts
const next = Runner.make<MessageV2.WithParts>(data.scope, {
  onIdle: status.set(sessionID, { type: "idle" }),  // run-state.ts:59-62
  onBusy: status.set(sessionID, { type: "busy" }),
  onInterrupt,
})
```

`SessionStatus.set`（`status.ts:77-86`）发布 `Event.Status`（替代旧的 `Event.Idle`），TUI 据此切换 spinner / 用户输入框是否禁用。

## 5.4 runLoop：一次循环的完整身世

`runLoop`（`prompt.ts:1239-1482`）是核心。删掉日志和 Effect 编织后，结构是一个无限 `while (true)`：

```text
loop step++
  1) status.busy
  2) msgs = filterCompactedEffect(sessionID)
     (从 DB 拉出消息，但用最新 compaction 之后的 tail，老消息隐藏)

  3) { user: lastUser,
       assistant: lastAssistant,
       finished: lastFinished,
       tasks } = MessageV2.latest(msgs)

  4) 终止判定:
     if (lastAssistant.finish &&
         finish != "tool-calls" &&
         !hasToolCalls(lastAssistant.parts) &&
         lastUser.id < lastAssistant.id) {
       break    // 模型已经收尾、没有未跑的工具，循环退出
     }

  5) step==1 时 fork title 生成（异步、忽略错误）

  6) tasks.pop() 拿到此前用户/前一轮埋下的 SubtaskPart 或 CompactionPart:
     - subtask:    handleSubtask(...) → 开子会话跑 task 工具 → continue
     - compaction: compaction.process(...) → "stop" 则 break，否则 continue

  7) overflow auto-compact:
     if (lastFinished && !summary && isOverflow(lastFinished.tokens, model)) {
       compaction.create({ auto: true })
       continue
     }

  8) maxSteps 检查 (agent.steps), 若 isLastStep 给 messages 追加 MAX_STEPS 提示

  9) reminders.apply(msgs, agent, session)  注入 system-reminder 段

 10) 写新的 assistant msg 骨架（写库 → 发 Updated 事件，UI 立即看到一个空的 assistant 气泡）

 11) processor.create({ assistantMessage, sessionID, model }) 得到 handle

 12) tools = SessionTools.resolve(...)      tools.ts:24-206
     (从 registry + MCP 取所有工具，按 permission 过滤，每个 tool 绑定 callID/messageID/sessionID
      的 ctx，AI SDK 调用 execute 时通过 EffectBridge 跑 Effect)

 13) 若用户要求 json_schema 结构化输出，额外注入 StructuredOutput 工具，toolChoice="required"

 14) step==1 时 fork summary.summarize（写入 summary 流）

 15) step>1 && lastFinished:  把新用户消息包成 <system-reminder>… 提示文本
     防止"用户中间打断"的内容被模型当作前序工具结果

 16) plugin.trigger("experimental.chat.messages.transform")

 17) 收集 [skills, env, instructions, modelMsgs]，拼出 system 数组

 18) result = handle.process({ user, agent, system, messages, tools, model, ... })
     ↑ 真正调一次 LLM，把所有 LLMEvent 翻译为 part 写库

 19) 根据 result:
       "stop"     → break
       "compact"  → compaction.create + continue
       否则       → continue
```

`handleSubtask`、`overflow auto-compact`、`runLoop break` 这三类才是循环真正的退出点。终止判定（第 4 步）很微妙：有些 provider 即使返回 `finish=stop` 仍然在 assistantMessage 里塞了 `tool-call` part，这里 `hasToolCalls(lastAssistant.parts)` 的兜底允许这种情况下也再来一轮，把工具结果回灌给模型（`prompt.ts:1263-1275`）。

## 5.5 状态机视角

把 runLoop + processor + tool 执行合到一张图，跨进程状态如下：

<svg viewBox="0 0 760 480" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Session state machine across runLoop steps">
  <defs>
    <marker id="ar52" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="180" y="14" width="400" height="38" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="32" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">SESSION (one row in DB)</text>
  <text x="380" y="46" text-anchor="middle" font-size="10" fill="#64748b">sessionID 持久状态</text>
  <rect x="60" y="74" width="160" height="34" rx="14" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="140" y="95" text-anchor="middle" font-size="11" fill="currentColor">status = idle</text>
  <rect x="540" y="74" width="160" height="34" rx="14" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="620" y="95" text-anchor="middle" font-size="11" fill="currentColor">status = busy / retry</text>
  <path d="M220,90 L538,90" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar52)"/>
  <path d="M540,98 L222,98" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar52)"/>
  <text x="380" y="84" text-anchor="middle" font-size="10" fill="#64748b">prompt() / loop()</text>
  <text x="380" y="115" text-anchor="middle" font-size="10" fill="#64748b">finish=stop &amp;&amp; !hasToolCalls</text>
  <rect x="60" y="138" width="640" height="280" rx="8" fill="#ddd6fe" fill-opacity="0.35" stroke="#7c3aed" stroke-width="1.5" stroke-dasharray="4,3"/>
  <text x="380" y="158" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">runLoop  step = 1, 2, 3, ...</text>
  <rect x="240" y="174" width="280" height="34" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="195" text-anchor="middle" font-size="11" fill="currentColor">create assistant msg（写库空骨架）</text>
  <path d="M380,208 L380,228" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar52)"/>
  <rect x="180" y="230" width="400" height="100" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="250" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">processor.process(streamInput)</text>
  <text x="380" y="268" text-anchor="middle" font-size="10.5" fill="currentColor">for event in llm.stream():</text>
  <text x="380" y="284" text-anchor="middle" font-size="10.5" fill="currentColor">handleEvent(event)  →  写 part / 发 bus</text>
  <text x="380" y="312" text-anchor="middle" font-size="10" fill="#64748b">Effect.retry(SessionRetry.policy)  // 5.7 节</text>
  <rect x="588" y="252" width="112" height="58" rx="6" fill="#fff" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="644" y="272" text-anchor="middle" font-size="10" fill="currentColor">retry</text>
  <text x="644" y="286" text-anchor="middle" font-size="10" fill="currentColor">on APIError</text>
  <text x="644" y="300" text-anchor="middle" font-size="9.5" fill="#64748b">退避见 5.7</text>
  <path d="M580,280 L590,280" stroke="#0ea5e9" stroke-width="1.2"/>
  <path d="M590,300 Q540,360 380,332" stroke="#0ea5e9" stroke-width="1.2" stroke-dasharray="3,2" fill="none" marker-end="url(#ar52)"/>
  <path d="M380,330 L380,350" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar52)"/>
  <rect x="180" y="352" width="400" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="380" y="376" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">result = "stop" | "continue" | "compact"</text>
  <path d="M180,372 Q120,372 90,108" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" fill="none" marker-end="url(#ar52)"/>
  <text x="124" y="436" font-size="10.5" fill="currentColor">stop → loop 退出 → status = idle</text>
  <text x="124" y="452" font-size="10.5" fill="#64748b">continue / compact → 下一步 step</text>
</svg>
<span class="figure-caption">图 R5.2 ｜ 单条 session 的 busy/idle 双态机外加 runLoop 内嵌的 processor 单次流；retry 仅作用于 process 本身，循环退出靠"finish=stop 且无 tool-call"。</span>

<details>
<summary>ASCII 原版</summary>

```text
                  ┌─────────────────────────────────────────────┐
                  │            SESSION (one row in DB)          │
                  └───────────────────┬─────────────────────────┘
                                      │
              status=idle  ◀──────────┴──────────▶ status=busy / retry
                                      │
                       prompt() / loop() 触发
                                      │
                                      ▼
              ┌──────── runLoop step=1, 2, 3, ... ────────────┐
              │                                                │
              │   create assistant msg                         │
              │     │                                          │
              │     ▼                                          │
              │   processor.process(streamInput) ─┐            │
              │     │                             │            │
              │     │   for event in              │ Retry      │
              │     │     llm.stream():           │ on API     │
              │     │       handleEvent(event)    │ Error      │
              │     │   ----------------------    │ (退避见 5.7)│
              │     │                             │            │
              │     ▼                             ▼            │
              │   result = "stop"/"continue"/"compact"          │
              │                                                │
              └───────────────┬────────────────────────────────┘
                              │
                              ▼
              finish=stop && !hasToolCalls
                              │
                              ▼
                          status=idle
                          loop 退出
```

</details>

模型每发一个 step（一段 text + 若干 tool_call）就会触发：

```text
step-start
  text-start ─── text-delta×N ─── text-end
  tool-input-start ─── tool-input-end
  tool-call ──[ AI SDK 执行 execute(args) ]── tool-result
  ...
step-finish (finishReason: tool-calls)
```

如果 finishReason 是 `tool-calls`，AI SDK 的 `streamText` 内部会自动续上下一个 step（同一个 fullStream），直到 finishReason 不再是 tool-calls。换句话说：

- **同一次 `LLM.stream` 内**，模型可以走多个 step、跨多轮工具调用，processor 一次性消费到底，直到该 stream 收到 `finish`。
- **runLoop 的下一次迭代** 只在「stream 完整结束 + 仍要继续」时才发生，例如 deny、compaction、subtask。

## 5.6 SessionProcessor：把 stream 翻成 part

`SessionProcessor.create`（`processor.ts:105-859`）每次为一条 assistant 消息建一个 Handle，内部 `ProcessorContext`：

```text
ctx = {
  assistantMessage,
  sessionID,
  model,
  toolcalls: Record<string, ToolCall>,   // 按 toolCallID 跟踪生命周期
  shouldBreak,                            // deny 时是否退出
  snapshot,                               // 当前 step 之前的快照 hash
  blocked,                                // 用户拒绝后是否硬停
  needsCompaction,                        // 检测到 overflow
  currentText,                            // 当前 text-delta 累加的目标 part
  reasoningMap,                           // 多路并发 reasoning 段
}
```

`handleEvent`（`processor.ts:305-689`）就是一个大 switch，每个 LLMEvent 映射到 part 的增量写入。挑几条最关键的：

`text-start` / `text-delta` / `text-end`（`processor.ts:619-684`）：

```ts
case "text-start":
  ctx.currentText = {
    id: PartID.ascending(),
    type: "text", text: "",
    time: { start: Date.now() },
    metadata: value.providerMetadata,
    ...partBase
  }
  yield* session.updatePart(ctx.currentText)       // 写一条空 text part

case "text-delta":
  ctx.currentText.text += value.text
  yield* session.updatePartDelta({                  // 发增量事件，UI 不重读整条
    sessionID, messageID, partID,
    field: "text",
    delta: value.text,
  })

case "text-end":
  ctx.currentText.text = (yield* plugin.trigger(    // 给 plugin 修改文本的机会
    "experimental.text.complete", ctx, { text }
  )).text
  yield* session.updatePart(ctx.currentText)        // 一次性把最终态写库
```

`updatePartDelta`（`session.ts:812-820`）只通过 bus 推一个 `MessageV2.Event.PartDelta` 增量事件，不写库。`updatePart`（`session.ts:624-632`）才是 sync 写入：本地 DB + bus + 跨实例同步。

`tool-input-start` → `tool-call` → `tool-result`（`processor.ts:350-523`）跟踪一个工具调用：

```text
tool-input-start  → ensureToolCall(id,name) → 写 ToolPart(status: "pending")
tool-input-delta  → 直接 drop (AI SDK 最后会给完整 input)
tool-input-end    → mark inputEnded
tool-call         → state.status="running", input=value.input
                    检测 DOOM_LOOP_THRESHOLD=3:
                      若最近 3 个 part 都是同一工具同样输入 → permission.ask("doom_loop")
                      由用户决定是否继续
tool-result       → completeToolCall(id, {output, metadata, title, attachments})
tool-error        → failToolCall(id, error)
                    若 error 是 Permission.RejectedError → ctx.blocked = ctx.shouldBreak
```

DOOM_LOOP_THRESHOLD（`processor.ts:32, 425-449`）是简单粗暴的护栏：模型对同一个工具传同一个 input 连开 3 次，就强行触发权限询问，避免吃 token。

`step-finish`（`processor.ts:555-617`）：取 `Session.getUsage`（`session.ts:378-443`）算 cost 和 token，更新 assistantMessage.finish/cost/tokens、写一条 `step-finish` part、写本 step 文件 patch（来自 snapshot diff）、fork summary、检查 overflow → 置 `needsCompaction=true`。

`provider-error`（`processor.ts:525-526`）直接 throw，外层 retry policy 决定退避还是抛出。

最后注意 `Stream.takeUntil(() => ctx.needsCompaction)`（`processor.ts:794`）：一旦 step-finish 里发现要 compact，剩下的事件不再消费，stream 提前结束，runLoop 收到 `"compact"` 信号去走 compaction 流程。

## 5.7 错误分类与重试退避

`SessionRetry.policy`（`retry.ts:175-197`）是处理整条 LLM stream 失败的总闸：

```ts
Effect.retry(
  SessionRetry.policy({
    provider: input.model.providerID,
    parse,                                       // unknown → MessageV2.* Error
    set: (info) => status.set(sessionID, {
      type: "retry",
      attempt: info.attempt,
      message: info.message,
      action: info.action,
      next: info.next,
    }),
  }),
)
```

`retryable(error, provider)`（`retry.ts:67-151`）判定哪种错误可重试，并产出可读 message 与可点击 action：

| 输入 | 结果 |
|---|---|
| `MessageV2.ContextOverflowError` | `undefined` — 永不重试，直接走 compaction |
| `APIError` 且 `isRetryable=false` 且 `statusCode<500` | `undefined` — 抛给用户 |
| 5xx | 总是重试（即使 provider SDK 没标 retryable） |
| `responseBody` 含 `FreeUsageLimitError` | 返回带 `link=opencode.ai/go` 的 upsell |
| `responseBody` 含 `GoUsageLimitError` | 返回工作区限额到期信息（解析 retry-after 时长） |
| 普通限流（"rate limit"/"too many requests"/Anthropic too_many_requests/google exhausted/...） | message="Too Many Requests" 等，重试 |

退避时长 `delay(attempt, error)`（`retry.ts:34-65`）：

```text
若 error 是 APIError 且 responseHeaders 有 retry-after-ms / retry-after / HTTP-date:
   parse 并 cap(RETRY_MAX_DELAY)        # 32-bit 上限
否则:
   min(2000 * 2^(attempt-1), 30_000)    # 指数退避，无 header 时 30s 封顶
```

`SessionStatus.set({type:"retry", next: now+wait, ...})` 让 TUI 显示「第 N 次重试，下一次将在 …」并展示 action 链接（如 `subscribe` 跳转）。

错误 → DB 持久化由 `processor.halt`（`processor.ts:751-778`）完成：

```ts
const error = parse(e)
if (MessageV2.ContextOverflowError.isInstance(error)) {
  ctx.needsCompaction = true               // 由 runLoop 触发 compaction
  yield* bus.publish(Session.Event.Error, ...)
  return                                   // 不写入 assistant.error
}
ctx.assistantMessage.error = error
yield* bus.publish(Session.Event.Error, {...})
yield* status.set(ctx.sessionID, { type: "idle" })
```

`parse` 实质就是 `MessageV2.fromError`（`message-v2.ts:1096-1201`），将原始异常归一为：

- `AbortedError` — Ctrl-C / abort
- `OutputLengthError` — 模型输出超长
- `AuthError` — provider key 缺失/失效
- `APIError` — 通用 API 错误（携带 statusCode、headers、body、isRetryable）
- `ContextOverflowError` — 上下文超限（参见 `provider/error.ts:8-46` 的正则匹配 30+ 种 provider 错误文案）
- `NamedError.Unknown` — 兜底

`session/message-error.ts:1-14` 还定义了几个简单的 NamedError：`OutputLengthError`、`AuthError`、`Unknown`，集中导出 `SharedSchema` 给消息错误 union 使用。

## 5.8 Ctrl-C / abort 的全过程

按下 Ctrl-C → TUI 调 `SessionPrompt.cancel(sessionID)`（`prompt.ts:135-138`）→ `state.cancel(sessionID)`（`run-state.ts:76-85`）：

```ts
const cancel = function* (sessionID: SessionID) {
  yield* cancelBackgroundJobs(background, sessionID)   // 杀关联子 job
  const existing = data.runners.get(sessionID)
  if (!existing || !existing.busy) {
    yield* status.set(sessionID, { type: "idle" })     // 已经空闲，只更新状态
    return
  }
  yield* existing.cancel                               // Runner.cancel → fiber.interrupt
}
```

Runner 的 cancel 触发 fiber interrupt，沿着 Effect 调用链一路传播：

```text
runner fiber          interrupt
  ▼
SessionPrompt.runLoop  Effect.onInterrupt(finalizeInterruptedAssistant)   prompt.ts:1348-1356
  ▼                    (把当前 assistant msg 标记 AbortError, 写完成时间)
processor.process     Effect.onInterrupt → halt(new DOMException("Aborted","AbortError"))
  ▼                    cleanup() finally: 把所有 status=running 的工具置 status=error
LLM.stream            acquireRelease 释放 → ctrl.abort()                  llm.ts:347-350
  ▼
AI SDK streamText     abortSignal 触发，HTTP 请求关闭，fullStream 停止
```

`LLM.stream` 用 `Effect.acquireRelease`（`llm.ts:344-352`）确保无论是正常完成还是 interrupt，AbortController 都被 abort（释放 socket）：

```ts
const stream: Interface["stream"] = (input) =>
  Stream.scoped(Stream.unwrap(Effect.gen(function* () {
    const ctrl = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (ctrl) => Effect.sync(() => ctrl.abort()),
    )
    const result = yield* run({ ...input, abort: ctrl.signal })
    ...
  })))
```

工具如果不响应 abort（例如循环里没有检查 `abort.signal.aborted`），processor 的 `cleanup`（`processor.ts:691-749`）等待最多 250ms 后强制把这些工具的 part 标记为 `interrupted`，但实际 OS 进程可能仍在跑。Shell 工具在 `prompt.ts:608-633` 用了 `ChildProcess.make` 的 `forceKillAfter: "3 seconds"`：先 SIGTERM、3 秒后 SIGKILL。

## 5.9 多轮预算与"跑飞了怎么办"

opencode 不靠"最大 turn 数"来兜底，而是叠加几道更软的护栏：

1. **agent.steps**（`prompt.ts:1323`）— 每个 agent 配置一个 `steps` 上限（默认 Infinity）。`isLastStep = step >= maxSteps`，到了最后一步会把 `assistant: MAX_STEPS` 这段提示追加到 messages（`prompt.ts:1435`），文本在 `packages/opencode/src/session/prompt/max-steps.txt`，告诉模型这是最后一步，必须给出结论而不是再开工具。
2. **DOOM_LOOP_THRESHOLD = 3**（`processor.ts:32`）— 同一工具同 input 连开 3 次触发 permission.ask（5.6 节）。
3. **overflow → compaction**（`processor.ts:610-615`、`prompt.ts:1306-1313`）— `isOverflow` 用模型 `limit.context` 减去 `compaction.reserved`（默认 `min(20_000, maxOutputTokens)`），见 `session/overflow.ts:8-32`：

   ```ts
   export function isOverflow(input): boolean {
     if (input.cfg.compaction?.auto === false) return false
     if (input.model.limit.context === 0) return false
     const count = input.tokens.total
       || input.tokens.input + input.tokens.output
          + input.tokens.cache.read + input.tokens.cache.write
     return count >= usable(input)
   }
   ```

   `compaction.create({ auto: true, overflow: true })` 会把已有消息「折叠」为 summary，下一轮 `filterCompactedEffect` 只返回 compaction tail 之后的消息。如果模型在 step-finish 之后才发现 overflow，processor 把 `needsCompaction=true`，stream 提前结束，runLoop 拿到 `"compact"`，再触发 compaction。

4. **`finishReason="length"`** — 模型自己说输出截断了，processor 在终止判定（`prompt.ts:1267-1275`）里看 finish != "tool-calls" 就直接退出循环，不再续。

`session/overflow.ts` 只导出 `usable` 和 `isOverflow` 两个纯函数，没有副作用。所有"折叠"逻辑实际在 `session/compaction.ts` 里实现，本章不展开。

## 5.10 事件总线：谁在被通知

opencode 内部一切跨组件通信都走 `Bus` Service（`bus/index.ts:35-188`）。事件类型用 `BusEvent.define(type, schema)`（`bus/bus-event.ts`）或 `SyncEvent.define(...)`（后者会同时落本地 DB 并跨实例广播）定义。一次 chat 循环里发的主要事件：

| 时机 | 事件 | 定义位置 |
|---|---|---|
| 创建会话 | `session.created` | `session.ts:333-339` |
| 写消息（用户或助手） | `MessageV2.Event.Updated` | `message-v2.ts` 内 |
| 写 part / 增量 | `MessageV2.Event.PartUpdated` / `Event.PartDelta` | `session.ts:624-632, 812-820` |
| 状态变化 | `session.status` + 已废弃的 `session.idle` | `status.ts:34-49` |
| 出错 | `session.error` | `session.ts:360-368` |
| 文件 diff | `session.diff` | `session.ts:353-358` |
| Tool / Step / Reasoning 等"语义事件" | `SessionEvent.*`（仅在 `experimentalEventSystem` 开关下） | `@opencode-ai/core/session-event` |
| Permission 请求/应答 | `Permission.Event.*` | `permission/index.ts` |

订阅有四种：

```ts
bus.publish(def, props, options?)        // 发布

bus.subscribe(def): Stream<Payload>      // 拿到 Effect Stream
bus.subscribeAll(): Stream<Payload>      // 通配
bus.subscribeCallback(def, fn)           // 注册 callback，返回 unsub
bus.subscribeAllCallback(fn)             // 通配 callback
```

TUI 把 `session.status` / `MessageV2.PartUpdated` / `MessageV2.PartDelta` 喂给 React Ink；HTTP/SDK 也是订阅同样的事件透传给前端。`SyncEvent` 类事件还会通过 `sync.run` 落到 `SyncEventTable` 并广播给同机器其他实例（多窗口共享同一 session 的基础）。

## 5.11 subagent 调度（task 工具）

opencode 把"嵌套 agent"实现成一个普通工具 `task`（`packages/opencode/src/tool/task.ts:103-345`）。模型调用：

```json
{
  "name": "task",
  "input": {
    "subagent_type": "search-grep",
    "description": "Find usages of X",
    "prompt": "Search for...",
    "background": false
  }
}
```

执行路径（`task.ts:115-335`）：

1. `permission.ask("task", patterns=[subagent_type])`（除非 `bypassAgentCheck`）。
2. `agent.get(subagent_type)` 找到子 agent；找不到直接抛 `Unknown agent type`。
3. 如果传了 `task_id` 且找得到 session，就「续跑」该子 session；否则 `sessions.create({ parentID: 父 sessionID, title: ..., permission: deriveSubagentSessionPermission(...) })` 开新子 session。子 session 的 permission 是父 ruleset、父 agent permission 和子 agent permission 的合并。
4. 调 `ctx.extra.promptOps.prompt(...)` ——`promptOps` 实际就是父 SessionPrompt 服务自身暴露出来的 `{cancel, prompt, loop, resolvePromptParts}`（`prompt.ts:126-133`）。
5. `ops.prompt` 在子 session 上跑一整个 `runLoop`，返回时 `result.parts.findLast(text)` 作为输出文字回给父模型，工具 output 形如：

   ```text
   task_id: ses_abc123 (for resuming to continue this task if needed)

   <task_result>
   ...
   </task_result>
   ```

6. 父循环看到 `tool-result`，processor 把结果作为 part 写进父 assistant 消息，AI SDK 在同一个 streamText 内继续下一个 step，把这段文字回灌给父模型。

「同 session 嵌套」还是「开新 session」？答：**开新 session**（`parentID = 父 sessionID`）。这有两个直接后果：

- 父 session 与子 session 各自有独立的消息流、独立的 cost/token 统计，子 session 用自己的 agent 的 system prompt 和工具集。
- 父 session 的 Runner 仍然标 busy；子 session 也有自己的 Runner，但是因为父 Runner 通过 `ops.prompt(...)` 同步等子 session 完成，从外面看父 session 一直 busy，子 session 跑完 idle。

`background: true` 则不同（`task.ts:278-303`）：通过 `BackgroundJob.start` 把 `runTask()` 丢进 background，立刻返回 `task_id` 给模型；子完成后 `inject("completed", text)` 给父 session 写一条 `synthetic` user message + 触发父 session 的 loop 续跑。`SessionPrompt.cancel` 的 `cancelBackgroundJobs` 递归就靠 `metadata.parentSessionId` 把这些后台 job 全部取消（`run-state.ts:120-127`）。

Subagent 在父 session 里的可见痕迹是一个 `MessageV2.SubtaskPart`（用户预先在 prompt 里 mention `@agent` 或 command 用 `subtask: true` 触发），由 `handleSubtask`（`prompt.ts:298-489`）专门处理，不是直接调 task 工具——它在父 session 写一个虚拟的 assistant message 包一个 tool part，执行 task 工具，最后再写一条 synthetic 用户消息 `"Summarize the task tool output above and continue with your task."` 让父循环续上。

## 5.12 一次循环的代码踪迹（concrete trace）

把上面所有抽象落到一次真实跑：用户在父 session `ses_p` 发 `"修复 bug 并跑测试"`，agent 是 `build`，模型是 `claude-sonnet-4-5`。

```text
[t=0]   TUI → SessionPrompt.prompt({ sessionID: ses_p, parts: [{type:"text", text:"..."}] })
         createUserMessage 写 MessageV2.User msg_u1 + TextPart pt_t1
         发 MessageV2.Event.Updated(msg_u1), PartUpdated(pt_t1)
         loop({sessionID: ses_p})

[t=10ms] runner.ensureRunning → runLoop step=1
         status.set(busy) → bus publish session.status
         msgs = filterCompacted → 含 msg_u1
         lastUser=msg_u1, lastAssistant=undefined, lastFinished=undefined
         fork title 生成 (后台异步, 调小模型)
         tools = SessionTools.resolve(...)
            → registry.tools 给 read/write/grep/glob/bash/edit/task/... 都打包
            → MCP 工具拼到 tools[]
         写 assistant msg_a1 骨架 (空 parts) → bus publish MessageV2.Event.Updated(msg_a1)
         processor.create({msg_a1, ses_p, model}) → 取 initial snapshot
         handle.process(streamInput)

[t=30ms]   llm.stream(streamInput)
              LLMRequestPrep.prepare(...)
                system = [provider system prompt, env, instructions, ...]
                messages = [{role:"system",content:...}, {role:"user", content:...}]
                tools = sorted({read, write, ..., task})
                headers = {x-session-affinity: ses_p, User-Agent: opencode/v1.15.10, ...}
              streamText({ model, messages, tools, abortSignal, maxRetries=0, ... })
              fullStream 异步迭代
              LLMAISDK.toLLMEvents 把 AI SDK 事件翻 LLMEvent

[t=50ms]   LLMEvent step-start → processor 写 snapshot part
[t=200ms]  text-start id=t0 → 创建 currentText = textPart pt_x1, 写库
[t=210ms]  text-delta "好的" → updatePartDelta (UI 实时刷新)
[t=240ms]  text-delta ", 我先看一下..." → 累加
[t=900ms]  text-end → updatePart (final)
[t=901ms]  tool-input-start id=call_1 name=read → 写 ToolPart pt_tool1 status=pending
[t=950ms]  tool-call id=call_1 input={filePath:"src/foo.ts"}
              → state.status=running, time.start=now
              AI SDK 同步调 execute(args)
              → SessionTools.context 构造 ctx (sessionID/messageID/callID/abort/extra)
              → ReadTool.execute 读文件，返回 {output, title, metadata}
[t=970ms]  tool-result id=call_1 → completeToolCall, state.status=completed
[t=980ms]  step-finish reason=tool-calls usage={input:8200, output:120, ...}
              processor 写 step-finish part, 更新 assistant.tokens/cost
              isOverflow(usage, model) ⇒ false
              (AI SDK 自动续 step, 不需 runLoop 介入)

[t=1.0s]   step-start (step=2)
[t=1.1s]   text-delta "我看完了，bug 在第 42 行..."
[t=1.5s]   tool-call id=call_2 name=edit ...
              EditTool.execute 申请 permission.ask("edit","src/foo.ts")
              用户在 TUI 点 allow
              EditTool 写文件, 返回 diff
[t=2.0s]   tool-call id=call_3 name=bash input={command:"npm test"}
              Permission 检查通过, BashTool.execute 起子进程
              输出流式追加到 tool part metadata
[t=15s]    tool-result id=call_3 (测试通过)
[t=15.1s]  text-delta "测试通过，bug 已修复"
[t=15.5s]  step-finish reason=stop usage={...}
              assistantMessage.finish="stop"
[t=15.6s]  finish reason=stop
           stream 自然结束
           processor.process Effect 链:
             cleanup() finalizes 所有 part (无 dangling)
             assistantMessage.time.completed = now
             updateMessage(msg_a1)
           return "continue" (因为 !needsCompaction && !blocked && !error)

[t=15.7s] runLoop 下一轮:
           lastAssistant = msg_a1 (finish=stop)
           hasToolCalls = false (所有工具 part 都已 completed)
           lastUser=msg_u1 < lastAssistant=msg_a1
           ⇒ break

[t=15.8s] compaction.prune (后台 fork)
           lastAssistant(sessionID) 取最终消息返回
           Runner.onIdle → status.set(idle)
           bus publish session.status idle
           TUI 看到 idle, 让用户重新输入
```

整条轨迹只有 1 次 `LLM.stream`（包含 2 个 step），3 次工具执行（read/edit/bash），8 类 LLMEvent，以及若干 bus 事件。runLoop 只迭代了一轮——这是 opencode 在「一个完整对话」与「一次 LLM 调用」之间最常见的中间形态：一次 streamText 内部完成多 step + 多工具，runLoop 用来兜住 subagent / compaction / 异常重试 / 用户拒绝后是否继续等"流之外"的决策。

## 5.13 几个容易踩的坑

**1. processor.process 是单次流，runLoop 才是循环。** 很多人第一次看 `runLoop` 觉得「为什么没有重复 LLM 调用？多轮工具调用怎么发生的？」答：在 AI SDK `streamText` 内部，finishReason=tool-calls 时它自己续 step，processor 把所有 step 的事件统统消费完，return 一次 result。runLoop 的下一次迭代主要为了 subagent/compaction/拒绝/异常这些场景。

**2. `Effect.retry(SessionRetry.policy)` 在 process 这层。** 整条 stream 处理失败（包含已经吐出的 part 写入），policy 决定重试。一旦 retry，processor 内部状态由 `ctx.currentText = undefined; ctx.reasoningMap = {}` 重置（`processor.ts:787-788`），但之前写库的 part 不会撤销——这意味着重试时已经看到的 text 会保留，下一次 stream 会再来一段（用户看到的可能是「重复了一遍」）。这是已知 trade-off。

**3. AbortError 的两个来源很容易混。** Runner cancel 是「用户主动取消」，会在 assistantMessage 上写 `MessageV2.AbortedError`；HTTP/网络层主动中断也走 `AbortError`，但 `parse(e)` 同样归一为 AbortedError。两者唯一区别是 ctx.aborted 标志位（`processor.ts:122, 800`）。

**4. `session.touch` 的位置很微妙。** `prompt.ts:1216` 调一次 touch，让会话的 time_updated 在收到用户消息时就更新（即使后面 LLM 报错没出任何 assistant 文本，列表里这个 session 也会浮到顶）；step-finish 时不再单独 touch。

**5. 终止判定里 `lastUser.id < lastAssistant.id` 不可省略。** 因为有 subagent / compaction 等场景会插入 synthetic user 消息「在已完成的 assistant 之后」，必须确认 lastAssistant 是在最新 user 之后的，否则会错误地以为模型已经回完了。

**6. `Stream.takeUntil(() => ctx.needsCompaction)`（`processor.ts:794`）会让 stream 提前结束，但是 step-finish 已经发了。** 也就是说 compaction 触发的时候，本 step 的 usage/cost 已经写入 assistantMessage，下一段还没来得及消费就被丢掉。这是把 overflow 处理从「等到下一次循环开头」改成「step 结束立即跳出」的实现。

## 5.14 复习清单

- `SessionPrompt.prompt → createUserMessage → loop → runLoop` 的入口与展开。
- `SessionRunState.Runner` 提供「同 session 单飞 + interrupt-safe cancel」。
- `SessionProcessor.handleEvent` 处理 LLMEvent 的 16 种 case，把流翻译成 part。
- `SessionRetry.policy` 给整条 stream 重试，根据响应头/body 文案智能退避，并把 next 时间写入 status 供 UI 展示。
- 工具调用走 AI SDK 内部 step 续上，runLoop 只在 subagent/compaction/异常时迭代下一轮。
- subagent 通过 `task` 工具开新子 session 同步等待；`background:true` 则丢 BackgroundJob 异步回灌。
- 上下文溢出会在 step-finish 时自动触发 compaction，policy 由 `session/overflow.ts:isOverflow` 决定。
- 所有事件通过 `Bus` Service 推送，TUI / HTTP / SDK 都是订阅者。
