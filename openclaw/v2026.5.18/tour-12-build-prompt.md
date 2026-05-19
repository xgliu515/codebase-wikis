# Tour 12：构建 prompt 与上下文

## 1. 当前情境

上一步（tour-11）结束时，`agentCommand` 已经把这一轮 agent 运行的「运行时」全部配齐：

- `prepareAgentCommandExecution` 解析出了 session（`sessionId` / `sessionKey` / `sessionEntry` / `sessionStore`）、`sessionAgentId`、`workspaceDir`、`agentDir`，并把用户那句「你好」整理成了两个字符串——`body`（投给模型的版本）和 `transcriptBody`（写进历史记录的版本）。
- 模型选择四层叠加完成：provider 是 `anthropic`，model 是某个 `claude-*`。
- auth profile 选序完成，`authProfileId` 已定（一份 Anthropic 凭证）。
- `runAgentAttempt` 已经判定走 embedded pi 路径，正准备调 `runEmbeddedPiAgent`。

我们手上有一堆**离散的原料**：一句用户文本、一个 agent id、一个 workspace 路径、一个历史 transcript 文件路径、一个技能快照。但模型不吃这些离散原料——Anthropic Messages API 只认一个 `system` 字符串加一个有序的 `messages` 数组。这一步要做的，就是把原料拼成模型能吃的形状。

## 2. 问题

> 如何把「系统提示 + 这个 session 的历史对话 + 当前这句『你好』」拼装成一次 LLM 请求的 `system` + `messages`，并且让这个拼装过程在多次运行之间保持**逐字节可复现**？

注意问题里藏着两个要求。第一个是「拼对」——内容要全、顺序要对。第二个是「拼稳」——同一段历史每次拼出来的字节必须一模一样。第二个要求看起来多余，第 4 段会说明它为什么是硬约束。

## 3. 朴素思路

最直接的写法：在 `agent-command.ts` 里，把用户消息、读到的历史、agent 配置里的 system prompt 字符串拼接起来。

```ts
const systemPrompt = agentCfg.systemPrompt;
const history = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
const messages = [...history, { role: "user", content: body }];
return callAnthropic({ system: systemPrompt, messages });
```

system prompt 是配置里的一个静态字符串；历史就是 transcript 文件反序列化出来的数组；当前消息追加在末尾。一次拼装，一把梭。

## 4. 为什么朴素思路会崩

这个朴素思路会在四个具体的地方崩掉。

**第一，system prompt 根本不是一个静态字符串。** OpenClaw 的 agent 系统提示是**当场组装**出来的，它依赖一堆运行时才能确定的东西：当前模型 id（要写进「你是基于 X 模型」的身份段）、thinking 级别、技能快照内容、workspace 里的 `AGENTS.md` / 上下文文件、用户时区与当前时间、可用工具清单、provider 插件贡献的 system prompt 片段、bootstrap 模式提示。`agentCfg.systemPrompt` 这个字段在很多 agent 上压根是空的——真正的系统提示由 `buildAttemptSystemPrompt` 在 attempt 内部现造。朴素思路拿一个不存在的静态字段去拼，拼出来的是半成品。

**第二，历史不能原样喂回。** transcript 文件里存的是「OpenClaw 内部格式」的转录，里面有 inbound 元数据、思考块、工具结果细节、心跳标记。直接 `JSON.parse` 丢进 `messages`，模型会收到一堆它不该看见的内部噪音——而且不同 provider 对历史里的 assistant prefill、thinking 块、tool 消息的接受规则完全不同（Anthropic 在 thinking 模式下对尾部 assistant prefill 有硬约束）。原样喂回要么报错，要么污染模型行为。

**第三，拼装顺序若不稳定，prompt 缓存全废。** Anthropic 的 prompt caching 按**前缀**命中：只要请求的前缀字节和上一次完全一致，这段前缀就走缓存价、不重新计费 input token。一个典型对话里，`system`（长、稳定）+ 历史前 N 轮（已固定）就是这个可缓存前缀。但缓存命中的判定是**逐字节**的——如果这次把工具 schema 排在 system 之前、下次排在之后，或者历史里某条消息的字段顺序变了、时间戳精度变了，前缀字节就不一致，缓存直接失效。朴素思路里 `JSON.parse` 出来的对象字段顺序、`{ role, content }` 的拼法没有任何「确定性」保证，每次运行都可能产生字节不同但语义相同的 prompt。结果是：每一轮对话都按全价重算整个上下文的 input token，长会话的成本和延迟成倍上涨。

**第四，一把梭没有切面，无法测试也无法复用。** system prompt 组装、历史归一化、工具 schema 构造各有大量分支（不同 provider、不同 promptMode、raw model run、subagent）。糊在一个函数里，既测不了单个环节，也没法让 provider 插件介入自己那部分。

核心矛盾：prompt 不是「字符串拼接」，而是一条**有明确阶段、每阶段有确定性约束**的装配线。其中「确定性」不是锦上添花，而是 prompt 缓存能不能命中的前提——而 prompt 缓存直接决定长会话的钱和延迟。

## 5. OpenClaw 的做法

**先把问题摆正**：prompt 构建要满足三件事——(a) system prompt 必须用运行时信息现造；(b) 历史必须经过「面向 LLM 边界」的归一化才能喂回；(c) 整个拼装过程对相同输入必须产出相同字节，否则缓存失效。OpenClaw 的回应是把 prompt 构建**下沉到 attempt 内部**，拆成三条独立的、可测试的装配线，并在 LLM 边界上做确定性归一化。

**关键事实先说清**：`agent-command.ts` **自己不拼 prompt**。它是协调器，只负责把原料备齐——`body`（`src/agents/agent-command.ts:451-456`，由 `prependInternalEventContext` 处理）、`skillsSnapshot`（`src/agents/agent-command.ts:729-733`）、`sessionFile`（历史 transcript 路径，`src/agents/agent-command.ts:1060-1086` 由 `resolveSessionTranscriptFile` 解析）、`resolvedThinkLevel`、`extraSystemPrompt`——然后把这些原料连同 provider/model/authProfileId 一起传进 `runEmbeddedPiAgent`。真正的拼装发生在 `pi-embedded-runner` 子系统的 `attempt.ts` 里。

**装配线一：system prompt。** `src/agents/pi-embedded-runner/run/attempt.ts:1932` 调用 `buildAttemptSystemPrompt`（定义在 `src/agents/pi-embedded-runner/run/attempt-system-prompt.ts:50`）。它现造系统提示，输入是一个 `embeddedSystemPrompt` 大对象（`src/agents/pi-embedded-runner/run/attempt.ts:1936-1971`），里面塞满了运行时信息：`runtimeInfo`（含当前 model）、`skillsPrompt`、`contextFiles`、`workspaceNotes`、`userTimezone` / `userTime`、`tools`、`promptContribution`（provider 插件贡献的片段）、`bootstrapMode`。没有 `systemPromptOverrideText` 时，走 `buildEmbeddedSystemPrompt`（`src/agents/pi-embedded-runner/run/attempt-system-prompt.ts:67`）按固定段落顺序拼出基础系统提示；有 override 时则把 override 文本依次套上 bootstrap 补充、runtime extra、模型身份段（`src/agents/pi-embedded-runner/run/attempt-system-prompt.ts:53-66`）。最后再经过 `transformProviderSystemPrompt`（`src/agents/pi-embedded-runner/run/attempt-system-prompt.ts:71-79`）让 provider 做最后一道改写。返回 `{ baseSystemPrompt, systemPrompt, systemPromptOverride }`。

**装配线二：历史归一化。** transcript 文件被读进来后，不是原样进 `messages`。`attempt.ts` 里有一条专门的「LLM 边界归一化」函数 `normalizeMessagesForLlmBoundary`（`src/agents/pi-embedded-runner/run/attempt.ts:884-890`）：它先 `normalizeAssistantReplayContent` 归一化 assistant 历史内容，再 `stripToolResultDetails` 剥掉工具结果细节。它被装在 `activeSession.agent.convertToLlm` 上（`src/agents/pi-embedded-runner/run/attempt.ts:2362-2363`）——也就是说，**每次把内部 message 转成 LLM 格式时都会过这道归一化**。此外还有 `stripHistoricalInboundMetadataFromUserMessages`（`src/agents/pi-embedded-runner/run/attempt.ts:891-932`）剥掉历史 user 消息上的 inbound 元数据，以及 `attempt.transcript-policy.ts` 算出的 `transcriptPolicy` 决定要不要丢弃 thinking 块、reasoning 历史（`src/agents/pi-embedded-runner/run/attempt.ts:2696-2715`）。历史还会被 `limitHistoryTurns`（`src/agents/pi-embedded-runner/run/attempt.ts:217`）按 session key 编码的上限截断。对我们这条「你好」trace——这是个新 session，历史基本为空，归一化几乎是空操作；但这条装配线本身是 prompt 正确性的保证。

**装配线三：当前消息接到末尾。** `body`（`prependInternalEventContext(message, opts.internalEvents)` 的结果，`src/agents/agent-command.ts:451`）作为最新一条 user 消息进入对话。`transcriptBody`（`src/agents/agent-command.ts:452-453`）是另一个版本——写进历史记录用的，它和投给模型的 `body` 可能不同（比如内部事件上下文只前置给模型、不一定原样进 transcript）。区分这两者，正是「投给模型的」和「记进历史的」解耦。

**确定性从哪来。** 三条装配线都不是「随手拼」：system prompt 由 `buildEmbeddedSystemPrompt` 按**固定段落顺序**生成，相同输入产出相同字节；历史归一化是纯函数式的（`normalizeMessagesForLlmBoundary` 对相同 messages 产出相同结果）；工具 schema 由 `attempt-tool-construction-plan.ts` 按确定计划构造。更关键的是，OpenClaw 显式管理 prompt 缓存的「边界」——`stream-resolution.ts` 里能看到 `stripSystemPromptCacheBoundary`（`src/agents/pi-embedded-runner/stream-resolution.ts:127`、`:153`），系统提示里嵌有缓存边界标记，由 provider 流处理在发出前统一处理。`createSystemPromptOverride`（`src/agents/pi-embedded-runner/run/attempt-system-prompt.ts:84`）把组装结果固化成一个 override 对象，整轮运行复用同一份，不会每个 turn 重算出字节不同的版本。Anthropic 的 `isCacheTtlEligible: () => true`（见第 08 章 8.3.1）声明它的请求适用缓存 TTL——确定性拼装 + 缓存边界标记，才让那段长长的 `system` + 稳定历史前缀真正命中缓存价。

走完这一步，attempt 内部手上有了 `attemptSystemPrompt.systemPrompt`（一个确定的系统提示字符串）、一个经归一化的历史 message 列表、以及末尾那条「你好」user 消息——它们即将被组装成传给 provider `StreamFn` 的 `context`。

## 6. 代码位置

- `src/agents/agent-command.ts:451` — `body = prependInternalEventContext(message, opts.internalEvents)`，投给模型的用户消息文本。
- `src/agents/agent-command.ts:452-453` — `transcriptBody`，写进 transcript 的消息版本，与 `body` 解耦。
- `src/agents/agent-command.ts:692-733` — 技能快照处理，产出随 prompt 传下去的 `skillsSnapshot`。
- `src/agents/agent-command.ts:1060-1086` — `resolveSessionTranscriptFile` 解析本次运行读写的历史 transcript 文件路径 `sessionFile`。
- `src/agents/pi-embedded-runner/run/attempt-system-prompt.ts:50` — `buildAttemptSystemPrompt`，system prompt 装配入口。
- `src/agents/pi-embedded-runner/run/attempt-system-prompt.ts:67` — `buildEmbeddedSystemPrompt`，按固定段落顺序拼基础系统提示。
- `src/agents/pi-embedded-runner/run/attempt-system-prompt.ts:71-79` — `transformProviderSystemPrompt`，provider 对 system prompt 的最后一道改写。
- `src/agents/pi-embedded-runner/run/attempt-system-prompt.ts:84` — `createSystemPromptOverride`，把组装结果固化成整轮复用的 override。
- `src/agents/pi-embedded-runner/run/attempt.ts:1932-1990` — `buildAttemptSystemPrompt` 的实际调用点，可见 `embeddedSystemPrompt` 大对象的全部运行时字段。
- `src/agents/pi-embedded-runner/run/attempt.ts:884-890` — `normalizeMessagesForLlmBoundary`，LLM 边界历史归一化。
- `src/agents/pi-embedded-runner/run/attempt.ts:2362-2363` — 把归一化函数装上 `activeSession.agent.convertToLlm`。
- `src/agents/pi-embedded-runner/run/attempt.ts:891-932` — `stripHistoricalInboundMetadataFromUserMessages`，剥历史 user 消息的 inbound 元数据。
- `src/agents/pi-embedded-runner/run/attempt.ts:2696-2715` — 按 `transcriptPolicy` 丢弃 thinking / reasoning 历史。
- `src/agents/pi-embedded-runner/run/attempt.ts:217` — `limitHistoryTurns`，按 session key 上限截断历史轮数。
- `src/agents/pi-embedded-runner/run/attempt-tool-construction-plan.ts` — 工具 schema 的确定性构造计划。

## 7. 分支与延伸

我们这条 trace 走的是「新 session、无历史、Anthropic、无工具、embedded pi」。这一步上没走的岔路：

- **长会话与压缩**：历史一旦超过上下文窗口，会触发 compaction（`attempt.preemptive-compaction.ts`、`compaction-successor-transcript.ts`），把旧历史摘要化。
- **raw model run**：`isRawModelRun` 为真时系统提示直接为空字符串（`src/agents/pi-embedded-runner/run/attempt-system-prompt.ts:69`），不走任何 agent 包装。
- **ACP 路径**：走 ACP 通道时 prompt body 由 `resolveAcpPromptBody` 处理，整个 turn 委托给外部 agent，不经过 `buildAttemptSystemPrompt`。
- **图片与附件**：带媒体的消息会走 `images.ts` 与 `history-image-prune.ts`，本 trace 是纯文本。
- **工具 schema 的 provider 差异**：不同 provider 的工具 schema 格式由 `normalizeToolSchemas` 一类钩子吸收。
- **provider 的 system prompt 贡献**：`promptContribution` 让 provider 插件往系统提示里注入自己的片段（OpenAI 就用了 `buildProviderWithPromptContribution`）。

想系统理解 agent 命令执行如何把原料备齐、再委托给 runner，去读 [第 07 章](07-agent-execution.md)（尤其 7.6「prompt 构建与 attempt 准备」）。想了解 prompt 缓存边界、provider 流包装、模型目录如何描述上下文窗口，去读 [第 08 章](08-llm-providers.md)。想了解历史 transcript 的存储与会话系统，去读 [第 06 章](06-sessions.md)。

## 8. 走完这一步你脑子里应该多了什么

- **`agent-command.ts` 不拼 prompt，它只备料**。真正的拼装下沉在 `pi-embedded-runner` 的 `attempt.ts`，`agent-command.ts` 是协调器——记住「协调器备料、runner 拼装」这条分工。
- **system prompt 是现造的，不是配置里的静态字符串**。`buildAttemptSystemPrompt` 用一个塞满运行时信息（model、技能、上下文文件、时区、工具、provider 贡献）的大对象当场组装。
- **历史不能原样喂回模型**。`normalizeMessagesForLlmBoundary` 在 LLM 边界做归一化，剥掉内部元数据、工具结果细节、按策略丢弃 thinking 块——transcript 的内部格式和喂给模型的格式是两回事。
- **拼装必须确定性，否则 prompt 缓存失效**。Anthropic 缓存按前缀逐字节命中；固定段落顺序的 system prompt + 纯函数式历史归一化 + `stripSystemPromptCacheBoundary` 的缓存边界管理，共同保证长长的 `system` + 稳定历史前缀能命中缓存价，省下 input token 的钱和延迟。
- **`body` 与 `transcriptBody` 是两个版本**：一个投给模型、一个记进历史，故意解耦——投给模型的可以带内部事件上下文，记进历史的保持干净。
- 这一步结束时，attempt 内部有了确定的 `systemPrompt`、归一化的历史、末尾的「你好」user 消息——下一步它们将组装进 `context`，发起真正的 Anthropic 流式调用。
