# Tour 08：会话解析与加载

## 1. 当前情境

上一步（tour-07）结束时，`dispatchInboundMessage` 已经启动。它做的第一件事是把传入的 `MsgContext` 用 `finalizeInboundContext()` 收敛成 `FinalizedMsgContext`，然后用 `withReplyDispatcher` 包住核心逻辑，转交给 `dispatchReplyFromConfig()`。

现在我们站在 `dispatchReplyFromConfig()` 的入口处。手上有：

- 一个 `FinalizedMsgContext` —— 它带着 `SessionKey`（在 tour-06 由入站管线算出，对 WebChat 直聊大致是 `agent:main:main` 这样的字符串）、`Provider`、`Surface`、消息正文「你好」等字段。
- 一份 `OpenClawConfig` —— 全局配置，里面有 `agents` 定义、`session.store` 路径模板、各 provider 的默认模型。

但我们还**没有**任何会话对象。`SessionKey` 只是一个字符串——一把钥匙，还没插进锁里。这一步要做的，就是拿这把钥匙去开锁：定位（或新建）这条对话对应的 `SessionEntry`，并从中解出「这一轮该用哪个 agent、哪个 model、哪个 provider」。

## 2. 问题

> 给定一个 `sessionKey` 字符串，如何在持久化的会话存储里**容错地**定位到它对应的会话元数据条目，并据此确定本轮对话要用的 agent / model / provider——即便这是一个从未出现过的全新会话？

## 3. 朴素思路

会话存储不就是一个「会话键 → 会话数据」的字典吗。那么：

1. 把 `sessions.json` 整个读进内存，`JSON.parse`。
2. `store[sessionKey]` 直接取出会话条目。取不到就 `store[sessionKey] = {}` 新建一个。
3. 会话条目里要是存了 `model` 就用存的，没存就用配置里的全局默认 model。
4. agent？直接用配置里的默认 agent 就行。

四行代码，干净利落。

## 4. 为什么朴素思路会崩

这个朴素思路在 OpenClaw 的真实环境里会以几种很具体的方式崩掉：

- **`store[sessionKey]` 会漏查。** 会话键的格式在 OpenClaw 演进过——大小写折叠规则变过，Signal 之类渠道用过不透明 id，主会话有过多种历史别名（裸 `main`、硬编码的 `agent:main:` 旧前缀）。`sessions.json` 里实际存的键可能是 `Agent:Main:Main`，而这次传进来的是 `agent:main:main`。精确字典查找一个字符不差才命中，于是同一条对话会被劈成两个会话桶，对话记忆凭空丢失。
- **「agent 用默认就行」是错的。** 会话键本身就**编码了 agent id**——`agent:<agentId>:<...>` 这个结构里的中间段就是 agent。一个配置了 `work` 和 `personal` 两个 agent 的用户，他的 `agent:work:main` 会话必须路由到 `work` agent。无视 sessionKey 里的 agent 段、一律走默认 agent，等于把所有会话都搅进同一个 agent。
- **存储路径不是固定的一个文件。** OpenClaw 是多 agent 设计，**每个 agent 一套独立的 `sessions.json`**，路径形如 `<stateDir>/agents/<agentId>/sessions/sessions.json`，由带 `{agentId}` 占位符的模板解析。你必须先知道是哪个 agent，才知道去哪个文件里找会话——朴素思路里「先查字典」和「先定 agent」是个先有鸡还是先有蛋的死结，必须按正确顺序拆开。
- **每条消息全量读盘解析 JSON 太贵。** WebChat 里用户可能连发几条，每条入站消息都把整个 `sessions.json` 读盘 + `JSON.parse`，在高频场景下是纯粹的浪费。
- **model 为空 ≠ 用全局默认。** 会话条目里 `model` 字段的语义有层次：可能是用户用 `/model` 命令显式钉死的覆盖，可能是上次因限流自动回退留下的临时值，也可能压根没设。直接「有就用、没有用默认」会把这些来源混为一谈，下一步模型选择就失去了判断依据。

核心矛盾：`sessionKey` 是一个会演进、有内部结构的逻辑标识，而它指向的存储是「按 agent 分片的多个文件」。定位会话必须先从 key 里解出 agent、据此找到正确的存储文件、再在文件里做**容错**查找——朴素思路把这三件事全跳过了。

## 5. OpenClaw 的做法

**先把问题摆清楚**：定位会话不是一次字典查找，而是一条「解 agent → 定文件 → 容错查 → 解运行时」的链。OpenClaw 在 `dispatchReplyFromConfig()` 里用 `resolveSessionStoreLookup()` 这个内部函数把前三步打包，再用一对 `resolveSessionAgentId` / `resolveAgentConfig` 完成第四步。

**第一步，从 sessionKey 解出 agent id。** `resolveSessionStoreLookup()` 先把 `ctx.SessionKey`（或命令转发场景下的目标 sessionKey）归一成非空字符串，然后调 `resolveSessionAgentId({ sessionKey, config })`。这个函数解析 `agent:<agentId>:<...>` 结构里的 agent 段；如果 sessionKey 不带 agent 段，就回退到配置里的默认 agent。对我们这条 WebChat 「你好」，解出来的就是 `main`。

**第二步，据 agent id 定位存储文件。** `resolveStorePath(cfg.session?.store, { agentId })` 把配置里带 `{agentId}` 占位符的路径模板实例化成具体文件路径——这就回答了朴素思路「存储路径不固定」的问题：路径是 agent 的函数，必须先有 agent。

**第三步，加载存储并容错查找。** `loadSessionStore(storePath)` 把 `sessions.json` 读进来——但它**不是**裸的 `readFileSync + JSON.parse`。它前面挂着一层带 TTL 的读缓存（默认 45 秒，按文件 mtime + size 校验失效），高频入站消息不会每条都全量读盘解析。读进来之后，`resolveSessionStoreEntry({ store, sessionKey })` 做**容错查找**：它不只 `store[key]`，而是先按规范键、再按大小写折叠键、再遍历整个 store 找「归一后等价」的键，多个候选时取 `updatedAt` 最新的。它返回三样东西——规范化后的键、找到的 `SessionEntry`（`existing`，可能是 `undefined`）、以及一组发现的**旧键**。这就堵上了朴素思路「字典查找会漏」的洞。注意这一步**不**新建会话：`existing` 为 `undefined` 完全合法，表示这是个全新会话，新建被推迟到真正要写入时（由 `mergeSessionEntryWithPolicy` 在缺 `existing` 时补一个新 `sessionId`）。

**第四步，解出运行时 agent / model / provider。** 有了会话条目后：

- **agent 配置**：`resolveAgentConfig(cfg, sessionAgentId)` 取出这个 agent 的配置块（默认 model、workspace、工具策略等）。
- **model / provider**：这里要尊重 `SessionEntry` 上字段的层次。`SessionEntry` 区分两组字段——`modelProvider`/`model` 是**当前实际运行**的 provider/model，而 `modelOverride`/`providerOverride` 是**会话级覆盖意图**，还带一个 `modelOverrideSource`（`"user"` 还是 `"auto"`）标明覆盖是用户显式动作还是运行时自动回退。后续步骤（tour-11 的模型选择）会按「agent 默认 → 会话持久化覆盖 → 本次显式覆盖」的优先级把它们叠起来。本步只负责把 `SessionEntry` 这个承载体连同 agent 配置一起备好。

对我们这条「你好」：它是个新会话（`existing` 为 `undefined`），agent 解析为 `main`，model/provider 将沿用 `main` agent 配置里的 Anthropic 默认模型——会话条目本身此刻还没有任何覆盖。

走完这一步，我们手上从「一个 sessionKey 字符串」升级成了「一个明确的 agent id + agent 配置 + 一个 `SessionEntry`（或确认它是新会话）+ 存储路径」。锁被打开了。

## 6. 代码位置

- `src/auto-reply/dispatch.ts:244` — `dispatchInboundMessage`，finalize 后转交 `dispatchReplyFromConfig`。
- `src/auto-reply/reply/dispatch-from-config.ts:420` — `dispatchReplyFromConfig`，本步的宿主函数。
- `src/auto-reply/reply/dispatch-from-config.ts:250` — `resolveSessionStoreLookup`，把「解 agent → 定文件 → 容错查」打包的内部函数。
- `src/auto-reply/reply/dispatch-from-config.ts:259` — 从 `ctx.SessionKey`（或命令转发目标）归一出 `sessionKey`。
- `src/auto-reply/reply/dispatch-from-config.ts:263` — `resolveSessionAgentId({ sessionKey, config })`，从 key 解出 agent id。
- `src/auto-reply/reply/dispatch-from-config.ts:264` — `resolveStorePath(cfg.session?.store, { agentId })`，按 agent 实例化存储路径模板。
- `src/auto-reply/reply/dispatch-from-config.ts:266` — `loadSessionStore(storePath)`，加载（走 TTL 读缓存）。
- `src/auto-reply/reply/dispatch-from-config.ts:270` — `resolveSessionStoreEntry({ store, sessionKey }).existing`，容错查找会话条目。
- `src/auto-reply/reply/dispatch-from-config.ts:510` — `resolveSessionAgentId` + `:511` `resolveAgentConfig`，解出本轮 agent id 与 agent 配置。
- `src/agents/agent-scope.ts:299` — `resolveSessionAgentId` 定义，缺 agent 段时回退默认 agent。
- `src/config/sessions/store-load.ts:324` — `loadSessionStore`，带 TTL 读缓存 + 旧格式迁移。
- `src/config/sessions/store-entry.ts:9` — `resolveSessionStoreEntry`，容错查找 + 旧键收集。
- `src/config/sessions/types.ts:174` — `SessionEntry` 类型定义（含 `modelProvider`/`model`/`modelOverride` 等运行时字段）。
- `src/config/sessions/paths.ts:284` — `resolveStorePath`，解析 `{agentId}` 模板与 `~` 前缀。

## 7. 分支与延伸

我们这条 trace 走的是「WebChat 直聊、新会话、单 agent（`main`）、无模型覆盖」。这一步上的岔路：

- **群聊会话键**：群/频道场景下 `resolveGroupSessionKey` 会先派生群会话键，会话桶按群而非按发送者聚合。
- **命令转发**：`/...` 命令可能把回复目标指向另一个 sessionKey（`resolveCommandTurnTargetSessionKey`），此时定位的是转发目标会话而非来源会话。
- **ACP 绑定会话**：`resolveBoundAcpDispatchSessionKey` 会检查这条对话是否被绑定到某个外部 agent 控制协议会话，若是则改用绑定的目标 sessionKey。
- **会话已存在且带覆盖**：老会话的 `SessionEntry` 上可能有用户 `/model` 钉的 `modelOverride`，或限流自动回退留下的 `modelOverrideSource: "auto"` 临时值——这些会在 tour-11 的模型选择里被分别对待。
- **多 agent 合并视图**：dashboard 的 `/sessions` 列表需要跨所有 agent 的会话，走的是 `combined-store-gateway` 的只读聚合层。

想系统理解会话存储的两层结构（`sessions.json` 元数据 + `.jsonl` 转录）、容错查找与旧键迁移、并发写串行化，去读 [第 06 章](06-sessions.md)。想了解入站管线如何在更早的 tour-06 算出 `SessionKey`，去读 [第 05 章](05-inbound-pipeline.md)。

## 8. 走完这一步你脑子里应该多了什么

- **`sessionKey` 是一把有结构的钥匙，不是一个普通字典键。** 它编码了 agent id，定位会话必须先从它解出 agent，才能找到「该 agent 的那个 `sessions.json`」——OpenClaw 每个 agent 一套独立存储。
- **会话查找是容错的。** `resolveSessionStoreEntry` 不做精确字典查找，而是规范键 / 大小写折叠 / 等价键遍历层层兜底，并顺手收集旧键——同一条对话不会因键格式演进而被劈成两个桶。
- **加载会话有读缓存。** `loadSessionStore` 前面有一层 45 秒 TTL、按 mtime+size 校验的缓存，高频入站消息不会每条都全量读盘解析 JSON。
- **「新会话」是合法状态。** 这一步只定位、不新建——`existing` 为 `undefined` 表示全新会话，真正新建被推迟到首次写入。
- **`SessionEntry` 里 model 字段有层次。** `modelProvider`/`model`（当前运行值）与 `modelOverride`/`providerOverride`（会话级覆盖意图，带 `user`/`auto` 来源标记）是两组不同语义的字段，本步只是把它们连同 agent 配置备好，真正的模型选择留到 tour-11。
- 这一步结束时，我们手上有了**确定的 agent id + agent 配置 + 一个 `SessionEntry`（或新会话标记）+ 存储路径**——下一步，`message_received` 钩子会在消息正式进入 agent 之前获得一次介入机会。
