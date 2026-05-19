# Tour 11：进入 agent 执行，组装运行时

## 1. 当前情境

上一步（tour-10）结束时，`ReplyDispatcher` 已经就绪——一条空的 `sendChain`、`pending` 为 1（预约位）、计数器清零、`beforeDeliver` 与 `TypingController` 都接好。它在等 agent 往里灌回复。

现在回复流程要真正调用 agent 了。`dispatchReplyFromConfig` 一路往下，会通过惰性加载的 `getReplyFromConfig` 进入 `auto-reply` 的回复解析层，最终汇入 agent 执行的入口。

这里要先澄清一个命名事实，因为它直接决定本步讲什么。OpenClaw 有**两个并列的 agent 执行入口**：

- `agentCommand`（`src/agents/agent-command.ts:1568`）—— 受信任的本地 / CLI 入口；它的网络面孪生兄弟是 `agentCommandFromIngress`（`:1596`）。两者都汇入私有的 `agentCommandInternal`。
- `runReplyAgent`（`src/auto-reply/reply/agent-runner.ts:1027`）—— **auto-reply 回复管线**专用的 agent 执行入口。

我们这条 trace（WebChat 「你好」→ `chat.send` → `dispatchInboundMessage`）走的是回复管线，进的是 **`runReplyAgent`**，**不是** `agentCommand`。但两者要解决的是同一类问题——「这一轮该用哪个 agent、哪个 model/provider、哪份凭证」。第 07 章是围绕 `agentCommand`/`agentCommandInternal` 这条更完整的协调器讲透这套运行时组装逻辑的；本步讲的是回复管线这条路径上对应的等价环节。

此刻我们手上有：`FinalizedMsgContext`、tour-08 解出的 agent id 与 `SessionEntry`、就绪的 `ReplyDispatcher`。要把它们组装成一个能真正发起一轮模型对话的「agent 运行时」。

## 2. 问题

> agent 真正跑起来之前，必须把一组松散的输入——agent 配置、四层来源的模型选择、可能正在冷却的 provider 凭证——解析、叠加、校验成一个确定的「运行时」。这套解析逻辑很绕，怎么把它收敛成一个清晰、可复用、且对网络面安全的环节？

## 3. 朴素思路

agent 执行不就是「拿消息 + 模型名 → 调 LLM」吗。那么在回复流程里直接：

1. 模型名？取配置里的全局默认 model。
2. 凭证？取这个 provider 配的那把 API key。
3. agent？反正会话已经定了 agent id，直接把 agent 配置取出来。
4. 把这三样拼一拼，连同消息一起丢给 LLM 调用函数。

四步，没有循环、没有校验，最直接。

## 4. 为什么朴素思路会崩

这个朴素思路在 OpenClaw 的真实环境里会以几种很具体的方式崩掉：

- **「取全局默认 model」无视了覆盖层次。** 模型选择**不是**一个值，而是四层来源的叠加：agent 配置里的默认 model → 会话持久化的 `modelOverride`（用户用 `/model` 钉的，或限流自动回退留下的）→ 本次调用的一次性显式覆盖（`--model` / 内联指令）→ agent 的模型 allowlist 过滤。直接取全局默认，等于把用户用 `/model` 切到的模型、上一轮限流回退后的模型全部丢掉——用户切了模型却发现没生效。
- **「取那把 API key」无视了 auth profile。** 同一个 provider（比如 Anthropic）可以配**多份具名凭证**（auth profile）——一把 API key、一份 OAuth、一个设备 token。其中某些可能正在冷却（上次触发了限流）。朴素思路里「取那把 key」既不知道该用哪一份，也不知道哪份在冷却、更不知道失败了该怎么轮换。
- **会话上钉的 auth profile 可能已经不兼容。** 会话级的 auth profile 是当初为**当时的 provider** 选的。如果模型选择阶段把 provider 切了（比如从 anthropic 切到 openai），会话上钉的那份 anthropic OAuth 凭证就不再适用——朴素思路不会发现这个不兼容，会拿着错的凭证去调错的 provider。
- **没有 fallback，一次失败就是终点。** 主模型这次因为限流 503 了——朴素思路里这就直接失败、用户收不到回复。真实环境需要「主模型坏了自动切到 fallback 模型重试」。
- **会话运行中被切模型无处处理。** 用户在 agent **正在跑**的时候用 `/model` 改了模型，朴素思路完全没有感知这个并发事件的机制。
- **网络面与本地面共用「默认即 owner」会提权。** 如果 agent 执行入口对「调用者是不是 owner」「能不能用 `--model`」用同一套默认值，那么任何打进网络面的请求都会悄悄继承本地 CLI 的便利默认值，拿到 owner 权限——典型的「默认不安全」陷阱。

核心矛盾：agent 执行的「运行时」是一组**有优先级、有校验、有冷却状态、有 fallback、有信任边界**的解析结果，绝不是「默认值拼一拼」。把这套逻辑散在调用点里，每个维度都会漏。

## 5. OpenClaw 的做法

**先把问题摆清楚**：进入 agent 执行前，必须有一个环节把「agent 配置 + 四层模型选择 + auth profile 凭证 + fallback 策略」解析成一个确定且经过校验的运行时，并且这个环节对网络面要安全。OpenClaw 把这件事收敛成一个专门的协调器——回复管线里是 `runReplyAgent`，CLI/ingress 那条路径里是 `agentCommand`/`agentCommandInternal`（第 07 章详述的对象）。两者结构一致，本步沿回复管线讲。

**信任边界：本地便利，网络面强制表态。** 这是运行时组装的第一道关。`agentCommand`（本地 CLI 入口）把 `senderIsOwner`、`allowModelOverride` 默认设为 `true`——本地调用享受便利。而 `agentCommandFromIngress`（网络面入口）**强制**调用方显式传这两个布尔值，少传一个就直接抛错。`senderIsOwner` 决定 agent 是否有 owner 级权限，`allowModelOverride` 决定能否用 `--model` 临时切模型。这样网络面路径在边界上必须显式表态，「忘记设置」变成可观测的失败而非静默提权——堵上了朴素思路的「默认不安全」洞。

**准备阶段：把裸消息解析成结构化执行上下文。** agent 执行的第一件实事是「准备阶段」（`agentCommandInternal` 里是 `prepareAgentCommandExecution`）。它纯粹做解析和校验、不调 LLM：

- **agent 解析**：优先级是「显式 `--agent` > 从 sessionKey 推断 > 默认 agent」。注意一个一致性校验——如果同时给了 `--agent` 和一个 sessionKey，二者必须一致，因为 **sessionKey 本身编码了 agent id**，不允许「用 A agent 的 key 跑 B agent」。
- **agent 配置**：据 agent id 解出 `workspaceDir`（agent 工作目录）、`agentDir`（agent 私有目录，auth store 落在这里）、agent 配置块。
- **session 解析**：解出 `sessionId` / `sessionKey` / `sessionEntry` / `sessionStore` / `storePath` / `isNewSession`，以及会话上持久化的 thinking/verbose 级别。

**模型选择：四层来源按优先级叠加。** 这是整个组装里最绕的一段。回复管线用 `createModelSelectionState` 把四层来源合成一个 `ModelSelectionState`：从「agent 配置的默认 model」出发（`defaultProvider`/`defaultModel`），叠上会话 `SessionEntry` 上持久化的 `providerOverride`/`modelOverride`（`resolvePersistedOverrideModelRef`），再叠上本次的一次性显式覆盖（内联 `/model` 指令、`--model`），最后用 agent 的模型 allowlist（`agentCfg.models`）和可见性策略过滤。这里要尊重 tour-08 强调过的字段层次——`modelOverrideSource` 区分覆盖来自用户显式动作还是运行时自动回退，会话 reset 时只保留前者。对我们这条新会话「你好」，`SessionEntry` 上没有任何覆盖，模型选择落在 `main` agent 配置的 Anthropic 默认模型上。

**auth profile：选凭证、校兼容、备 fallback。** 模型选好了，用哪份凭证调 provider？一个 **auth profile** 就是「某个 provider 的一份具名凭证」（API key / OAuth / 设备 token 三类）。运行时组装要做三件事：

1. **校验会话级覆盖的兼容性**：会话上若钉了一份 auth profile，但模型选择阶段切换了 provider，这份 profile 可能已不兼容——不兼容的会话级 profile 覆盖会被清掉，让后面的 attempt 重新自动选一个。
2. **解析选序**：同一 provider 多份 profile，按 eligibility（是否在冷却中）排出一个尝试顺序。回复管线里 `resolveRunAuthProfile` 据 provider 解析出本次运行该用的 profile。
3. **fallback**：把「主模型坏了切 fallback 模型」的能力备好——`runWithModelFallback` 这层外循环依次对 primary、fallback1、fallback2... 尝试，返回最终成功的那一对 provider/model。

**live model switch：感知会话运行中被切模型。** `SessionEntry` 上有个 `liveModelSwitchPending` 标记。用户在 agent 正在跑时改了模型，这个标记被置位，嵌入式运行器据此抛 `LiveSessionModelSwitchError`，触发用新模型重跑。这与「故障 fallback」是两种不同的重试——fallback 是「模型坏了换一个」，live switch 是「会话被人为切了模型」。

走完这一步，一个完整的 agent 运行时已经组装好：确定的 agent + 经四层叠加并校验过的 provider/model + 选定且兼容的 auth profile + 备好的 fallback 列表。`runReplyAgent` 拿着它，连同 `ReplyDispatcher`、会话上下文，即将发起真正的模型对话。下一步，prompt 与上下文会被拼装出来，喂给模型。

## 6. 代码位置

- `src/auto-reply/reply/get-reply-run.ts:1161` — `runReplyAgent({ ... })` 调用点，回复管线进入 agent 执行。
- `src/auto-reply/reply/agent-runner.ts:1027` — `runReplyAgent`，回复管线专用的 agent 执行入口。
- `src/auto-reply/reply/model-selection.ts:90` — `createModelSelectionState`，把四层来源叠加成 `ModelSelectionState`。
- `src/auto-reply/reply/get-reply.ts:251` — `resolveDefaultModel`，解出 `defaultProvider`/`defaultModel` 起点。
- `src/auto-reply/reply/agent-runner-auth-profile.ts:27` — `resolveRunAuthProfile`，据 provider 解析本次运行的 auth profile。
- `src/auto-reply/reply/agent-runner-execution.ts:86` — `import { resolveRunAuthProfile }`，attempt 执行阶段使用 auth profile。
- `src/agents/agent-command.ts:1568` — `agentCommand`，受信任本地 / CLI 入口（本地默认 `senderIsOwner`/`allowModelOverride` 为 `true`）。
- `src/agents/agent-command.ts:1596` — `agentCommandFromIngress`，网络面入口（强制显式传 `senderIsOwner`/`allowModelOverride`）。
- `src/agents/agent-command.ts:485` — `agentCommandInternal`，两个入口共同汇入的私有协调器。
- `src/agents/agent-command.ts:303` — `prepareAgentCommandExecution`，把裸消息解析成结构化执行上下文。
- `src/agents/agent-scope.ts:299` — `resolveSessionAgentId`，agent id 解析（缺 agent 段回退默认）。
- `src/config/sessions/types.ts:174` — `SessionEntry`，含 `modelProvider`/`model`/`modelOverride`/`liveModelSwitchPending`/`authProfileOverride` 等运行时字段。

## 7. 分支与延伸

我们这条 trace 走的是「WebChat 回复管线、`runReplyAgent`、新会话、无模型覆盖、单 agent、Anthropic 默认模型」。这一步附近的岔路：

- **`agentCommand` / `agentCommandFromIngress`**：CLI 与网络面 ingress 走的是 `agent-command.ts` 这条入口，结构与 `runReplyAgent` 平行但更完整——这正是 [第 07 章](07-agent-execution.md) 详细拆解的对象。
- **模型 fallback**：`runWithModelFallback` 在主模型失败时依次尝试 fallback 模型，最终把成功的 attempt 记录塞进 `result.meta.agentMeta.fallbackAttempts`。
- **live model switch**：会话运行中被 `/model` 切模型，触发 `LiveSessionModelSwitchError` 与用新模型重跑。
- **auth profile 冷却与轮换**：多份 profile 按 eligibility 排序，冷却中的被跳过；OAuth 凭证过期会触发刷新。
- **三种 runner**：attempt 内层可走 embedded pi（`runEmbeddedPiAgent`）、CLI（`runCliAgentWithLifecycle`）、或 ACP 通道，取决于 provider/会话类型。
- **subagent lane**：子代理运行 timeout 默认为 0（不超时），生命周期由父 agent 管理。

想系统理解 agent 执行——`agentCommand` 的信任边界设计、`prepareAgentCommandExecution` 的 25 个字段、模型选择四层来源、auth profile 子系统的选序/冷却/OAuth 刷新、`runWithModelFallback` 与三种 runner、事件发射，去读 [第 07 章](07-agent-execution.md)。想回顾会话字段如何承载模型覆盖意图，去读 [第 06 章](06-sessions.md)。

## 8. 走完这一步你脑子里应该多了什么

- **OpenClaw 有两个平行的 agent 执行入口。** 回复管线（我们这条 trace）走 `runReplyAgent`；CLI/ingress 走 `agentCommand` / `agentCommandFromIngress`。两者解决同一类「组装 agent 运行时」的问题，第 07 章围绕后者讲透。
- **模型选择是四层来源的叠加，不是一个值。** agent 默认 → 会话持久化覆盖 → 本次显式覆盖 → allowlist 过滤，按优先级合并；`modelOverrideSource` 还区分覆盖来自用户还是自动回退。
- **auth profile 是「provider 的一份具名凭证」。** 同 provider 可有多份（key/OAuth/设备 token），组装时要校验会话级覆盖是否还兼容当前 provider、按冷却状态排选序、并备好 fallback。
- **信任边界靠默认值差异钉死。** 本地 `agentCommand` 默认 `senderIsOwner`/`allowModelOverride` 为真享受便利；网络面 `agentCommandFromIngress` 强制显式传值，少传即抛错——杜绝静默提权。
- **fallback 与 live model switch 是两种不同的重试。** 前者是「模型坏了换一个」，后者是「会话运行中被人为切了模型」，由 `liveModelSwitchPending` 标记触发。
- 这一步结束时，agent 运行时已组装好——确定的 agent + 校验过的 provider/model + 选定的 auth profile + fallback 列表——下一步，prompt 与上下文将被拼装出来喂给模型。
