## 1. 当前情境

走到这里，步骤 12 的 `formatMessagesWithCommands` 已经把这一轮的输入捏成了一个字符串 `prompt`。对 `pnpm run chat "ping"` 这条简单消息来说，`prompt` 大致长这样（如果 session 之前没有历史）：

```xml
<messages>
  <message from="cli:local" kind="chat" seq="2" timestamp="2026-05-18T14:32:11Z">
    ping
  </message>
</messages>
```

`poll-loop.ts:166` 把这个字符串塞进 `query` 调用：

```ts
const query = config.provider.query({
  prompt,
  continuation,
  cwd: config.cwd,
  systemContext: config.systemContext,
});
```

`config.provider` 是步骤 10 容器启动时通过 `createProvider('claude', { … })` 构造出的 `ClaudeProvider` 实例（`container/agent-runner/src/providers/factory.ts:11`）。`continuation` 是上一次成功对话留下的 SDK session id（首次对话时为 `undefined`）。`systemContext.instructions` 是 step 10 拼出的 `<assistant_name>` / destinations / MCP 工具说明等附加上下文。

现在控制权要交给 `container/agent-runner/src/providers/claude.ts:280` 的 `ClaudeProvider.query()`。它负责把这堆 nanoclaw 自家的形状翻译成 `@anthropic-ai/claude-agent-sdk` 的 `sdkQuery(...)` 入参，把 SDK 返回的 async iterable 包装回 nanoclaw 自家的 `AgentQuery` 形状，再交回给 `poll-loop.ts`。

---

## 2. 问题

容器拿到的是「一条 prompt + 一个可选 session id + 一坨 MCP 服务器配置」，它需要让 Claude 真正算出一个回复。具体要解决的子问题：

1. **协议接驳**：怎么把 prompt 真正喂给 Anthropic API？要不要管 tool use 协议、context window 自动 compact、API retry、rate limit？
2. **可控允许列表**：MCP 工具是按 session 动态注入的（由 `container.json` 决定），不能硬编码。但 SDK 自带一些「在 Claude Code 交互 UI 里有用、在 headless 容器里会卡死」的工具（`EnterPlanMode`、`AskUserQuestion`、`CronCreate`……），必须屏蔽。
3. **会话续接**：如果上一轮对话有 `continuation`（SDK 的 session id），这一轮要从同一条 transcript 继续，而不是从空白上下文开始 —— 不然 prompt cache 全废、消息历史也丢了。
4. **不阻塞 final**：`query()` 不能等到 SDK 跑完才返回 —— 否则在 SDK 跑的几十秒到几分钟里，`poll-loop` 没法继续 poll 新消息、没法 push 中途到的 follow-up、心跳也会断。它必须立刻返回一个 **可异步迭代** 的 handle。

step 13 这一刻聚焦在第 1、2、4 个问题上 —— 真正消费事件流是 step 14 的事。

---

## 3. 朴素思路

最直觉的写法：「不就是调个 HTTP API 吗」。直接：

```ts
const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({
    model: 'claude-sonnet-4-7',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
    tools: mcpToolDefinitions,
  }),
});
const json = await res.json();
return json.content[0].text;
```

简单、没依赖、看得到每一个字节。

---

## 4. 为什么朴素思路会崩

这个方案在 nanoclaw 的设定下会从五个方向同时垮：

1. **MCP 协议是双向 RPC，不是参数列表**。`mcpServers` 不是「给 API 一段 schema」就完事的 —— 每个 MCP server 是一个子进程，agent 发起 tool call 之后，SDK 要 spawn / 找到那个 server、发 JSON-RPC、拿回结果、再喂回 Claude 的 tool_use_id。自己写要实现 MCP transport（stdio / SSE）+ session 协商 + 错误恢复，几百行起步。
2. **Agent loop 不是一次 API call**。Claude 决定调工具 → 我们执行 → 把结果 stuff 回去 → Claude 接着 think → 也许再调一个工具 → …… 这个循环要自己写，每一轮还要管 token 计数、context 是否要 compact、是否超 max_turns。SDK 已经做好了。
3. **165k token 之后必须 auto-compact**。`CLAUDE_CODE_AUTO_COMPACT_WINDOW=165000`（`claude.ts:244`）触发后 SDK 会自动让 Claude 总结历史、丢掉细节、保留要点 —— 不然下一轮直接 413 / context overflow。`PreCompact` hook 还要趁机把 transcript 归档到 `/workspace/agent/conversations/`（`claude.ts:191-232`）。这套机制朴素方案完全没有。
4. **API retry 与 rate limit 分类**。429 / 529 / 网络抖动 SDK 内置指数退避；nanoclaw 只需要看 `system / api_retry` 和 `system / rate_limit_event` 事件、把 retryable 标志和 `classification: 'quota'` 透出去（`claude.ts:332-335`）。自己写就要管所有 HTTP 错误码 + retry-after 头 + jittered backoff。
5. **interruption / 多输入**。Claude Code SDK 支持「query 还在跑，再 push 一条用户消息进去」—— 这正是 nanoclaw `processQuery` 第 281 行 `setInterval` 里 `query.push(prompt)` 的基础（后续 step 14 详谈）。`fetch` 一次性 request/response，根本没法插话。

简而言之：`@anthropic-ai/claude-agent-sdk` 不是「方便的 HTTP 封装」，它是一整套 agent runtime —— spawn `cli.js` 子进程、stdin/stdout 用 JSON-lines 流转、内置 tool router、内置 compaction、内置 hook 系统、prompt cache 自动维护（见 `docs/SDK_DEEP_DIVE.md:15` 及 `docs/SDK_DEEP_DIVE.md:25-52`）。自己重写等于把 Claude Code 整个 headless 模式重写一遍。

---

## 5. nanoclaw 的做法

<svg viewBox="0 0 820 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ClaudeProvider.query layering: MessageStream into sdkQuery into cli.js child, AgentQuery handle out">
  <defs>
    <marker id="pq-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <text x="410" y="20" font-size="13" font-weight="700" fill="currentColor" text-anchor="middle">ClaudeProvider.query() — sync return of AgentQuery handle, ≪1ms</text>
  <rect x="20" y="40" width="780" height="80" rx="6" fill="#fef3c7" stroke="#ea580c" stroke-width="1.2"/>
  <text x="410" y="58" font-size="12" font-weight="700" fill="#9a3412" text-anchor="middle">poll-loop.ts:170 — provider.query({ prompt, continuation, cwd, systemContext })</text>
  <rect x="36" y="70" width="180" height="40" rx="4" fill="#ffffff" stroke="#fcd34d"/>
  <text x="126" y="86" font-size="10" font-weight="600" fill="currentColor" text-anchor="middle">prompt: string (XML)</text>
  <text x="126" y="100" font-size="9" fill="#64748b" text-anchor="middle">from step 12 formatter</text>
  <rect x="226" y="70" width="180" height="40" rx="4" fill="#ffffff" stroke="#fcd34d"/>
  <text x="316" y="86" font-size="10" font-weight="600" fill="currentColor" text-anchor="middle">continuation: string | undef</text>
  <text x="316" y="100" font-size="9" fill="#64748b" text-anchor="middle">SDK session id (resume)</text>
  <rect x="416" y="70" width="180" height="40" rx="4" fill="#ffffff" stroke="#fcd34d"/>
  <text x="506" y="86" font-size="10" font-weight="600" fill="currentColor" text-anchor="middle">cwd = /workspace/agent</text>
  <text x="506" y="100" font-size="9" fill="#64748b" text-anchor="middle">+ additionalDirectories</text>
  <rect x="606" y="70" width="178" height="40" rx="4" fill="#ffffff" stroke="#fcd34d"/>
  <text x="695" y="86" font-size="10" font-weight="600" fill="currentColor" text-anchor="middle">systemContext.instructions</text>
  <text x="695" y="100" font-size="9" fill="#64748b" text-anchor="middle">append to claude_code preset</text>
  <rect x="20" y="140" width="780" height="130" rx="6" fill="#ecfdf5" stroke="#0d9488" stroke-width="1.2"/>
  <text x="410" y="158" font-size="12" font-weight="700" fill="#0f766e" text-anchor="middle">ClaudeProvider.query() — providers/claude.ts:280-356</text>
  <rect x="36" y="170" width="220" height="88" rx="4" fill="#ffffff" stroke="#5eead4"/>
  <text x="146" y="188" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">a) MessageStream</text>
  <text x="146" y="204" font-size="10" fill="#64748b" text-anchor="middle">push-based AsyncIterable</text>
  <text x="146" y="218" font-size="10" fill="#64748b" text-anchor="middle">stream.push(input.prompt)</text>
  <text x="146" y="236" font-size="9" fill="#94a3b8" text-anchor="middle">later: query.push(followup)</text>
  <text x="146" y="250" font-size="9" fill="#94a3b8" text-anchor="middle">appends to same stream</text>
  <rect x="266" y="170" width="282" height="88" rx="4" fill="#ffffff" stroke="#5eead4"/>
  <text x="407" y="188" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">b) sdkQuery({ prompt: stream, options })</text>
  <text x="407" y="206" font-size="10" fill="#64748b" text-anchor="middle">allowedTools = TOOL_ALLOWLIST + mcp__&lt;name&gt;__*</text>
  <text x="407" y="220" font-size="10" fill="#64748b" text-anchor="middle">disallowedTools = SDK_DISALLOWED_TOOLS</text>
  <text x="407" y="234" font-size="10" fill="#64748b" text-anchor="middle">systemPrompt: preset + append</text>
  <text x="407" y="248" font-size="10" fill="#dc2626" text-anchor="middle">hooks: PreToolUse / PostToolUse / PreCompact</text>
  <rect x="558" y="170" width="226" height="88" rx="4" fill="#ffffff" stroke="#5eead4"/>
  <text x="671" y="188" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">c) translateEvents() (lazy gen)</text>
  <text x="671" y="206" font-size="10" fill="#64748b" text-anchor="middle">SDK msg → ProviderEvent</text>
  <text x="671" y="220" font-size="10" fill="#64748b" text-anchor="middle">any → activity (heartbeat)</text>
  <text x="671" y="234" font-size="10" fill="#64748b" text-anchor="middle">init / result / error / progress</text>
  <text x="671" y="250" font-size="9" fill="#94a3b8" text-anchor="middle">NO partial / NO delta</text>
  <line x1="256" y1="214" x2="264" y2="214" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#pq-ar)"/>
  <line x1="548" y1="214" x2="556" y2="214" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#pq-ar)"/>
  <rect x="20" y="290" width="780" height="80" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="410" y="308" font-size="12" font-weight="700" fill="#5b21b6" text-anchor="middle">@anthropic-ai/claude-agent-sdk runtime</text>
  <rect x="36" y="318" width="244" height="46" rx="4" fill="#ffffff" stroke="#a78bfa"/>
  <text x="158" y="335" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">spawn /pnpm/claude (cli.js child)</text>
  <text x="158" y="350" font-size="10" fill="#64748b" text-anchor="middle">stream-json over stdin/stdout</text>
  <rect x="290" y="318" width="244" height="46" rx="4" fill="#ffffff" stroke="#a78bfa"/>
  <text x="412" y="335" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">agent loop · tool dispatch</text>
  <text x="412" y="350" font-size="10" fill="#64748b" text-anchor="middle">auto-compact at 165k tokens</text>
  <rect x="544" y="318" width="240" height="46" rx="4" fill="#ffffff" stroke="#a78bfa"/>
  <text x="664" y="335" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">MCP RPC · retry / rate-limit</text>
  <text x="664" y="350" font-size="10" fill="#64748b" text-anchor="middle">prompt cache · jsonl transcript</text>
  <rect x="20" y="386" width="780" height="28" rx="4" fill="#fef3c7" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="404" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">d) returns AgentQuery { push, end, events, abort } — SYNC, ≪1ms; for-await drives SDK in step 14</text>
</svg>
<span class="figure-caption">图 T1.23 ｜ ClaudeProvider.query() 分层：橙色 nanoclaw 接口层（MessageStream + sdkQuery + 翻译 generator）→ 紫色 SDK runtime（spawn cli.js + agent loop + MCP + cache）。返回 AgentQuery 同步、事件惰性。</span>

<details>
<summary>ASCII 原版</summary>

```
poll-loop.ts:170
    provider.query({ prompt, continuation, cwd, systemContext })
                              │
                              ▼
┌─ ClaudeProvider.query() (claude.ts:280-356) ─────────────────┐
│  a) MessageStream  →  b) sdkQuery({ prompt: stream, ... })   │
│       push(prompt)     allowedTools / hooks / preset         │
│                          │                                   │
│                          ▼                                   │
│              c) translateEvents() (lazy generator)           │
│                          │                                   │
│                          ▼                                   │
│        d) return { push, end, events, abort }                │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
       @anthropic-ai/claude-agent-sdk runtime
       spawn /pnpm/claude  ·  agent loop  ·  MCP  ·  cache
```

</details>

`ClaudeProvider.query()` 是 nanoclaw 与 SDK 之间唯一的接口。它做四件事：

**a. 用 push-based async iterable 喂初始 prompt。**

```ts
// claude.ts:281-282
const stream = new MessageStream();
stream.push(input.prompt);
```

`MessageStream`（`claude.ts:80-112`）实现了 `Symbol.asyncIterator`，每次 SDK 拉时 yield 已入队的 `SDKUserMessage`，没货就 `await` 一个 promise、由 `push()` 来 resolve。这意味着 SDK 看到的 prompt 流可以随时被 `query.push(msg)` 追加 —— 这是 step 14 follow-up 消息的入口。`session_id: ''` 留空，由 SDK 自己负责重写。

**b. 用 `sdkQuery({ prompt: stream, options: { … } })` 启动。**

```ts
// claude.ts:286-314
const sdkResult = sdkQuery({
  prompt: stream,
  options: {
    cwd: input.cwd,
    additionalDirectories: this.additionalDirectories,
    resume: input.continuation,            // 续接旧 session
    pathToClaudeCodeExecutable: '/pnpm/claude',
    systemPrompt: instructions ? { type: 'preset', preset: 'claude_code', append: instructions } : undefined,
    allowedTools: [...TOOL_ALLOWLIST, ...Object.keys(this.mcpServers).map(mcpAllowPattern)],
    disallowedTools: SDK_DISALLOWED_TOOLS,
    env: this.env,
    model: this.model,
    effort: this.effort as any,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project', 'user'],
    mcpServers: this.mcpServers,
    hooks: { PreToolUse: [...], PostToolUse: [...], PostToolUseFailure: [...], PreCompact: [...] },
  },
});
```

几个看起来微小但关键的字段：

- **`systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions }`**：不写自己的 system prompt，而是 *append* 到 Claude Code 自带的预设上。nanoclaw 加的只是「你叫什么名字、发什么人能收到、有哪些 MCP 工具」之类的少量增量上下文，CLI 的 personality、tool-use convention 由 SDK preset 兜底。
- **`allowedTools` 由两部分拼成**：写死的 `TOOL_ALLOWLIST`（`claude.ts:42-61`，包含 Bash/Read/Write/Edit/Glob/Grep/WebSearch/Skill/…）+ 动态由 `mcpServers` 衍生的 `mcp__<name>__*` 通配（`claude.ts:66`）。SDK 的 allowedTools 是白名单过滤器，没列出的 MCP 命名空间会被静默丢弃 —— 不动态拼就等于装了 MCP 工具但 agent 用不到。
- **`mcpAllowPattern(serverName)`** 用 `[^a-zA-Z0-9_-]` 替换为 `_` —— 镜像 SDK 自身对 server name 的 sanitize，否则 allowlist 模式会跟 SDK 暴露的 tool 名对不上（`claude.ts:63-68` 的注释明示这一点）。
- **`disallowedTools: SDK_DISALLOWED_TOOLS`**：黑名单兜底。`AskUserQuestion`/`EnterPlanMode`/`EnterWorktree`/`CronCreate` 这些在交互式 Claude Code UI 里有意义，在 headless 容器里会 hang —— nanoclaw 各有等价的 `mcp__nanoclaw__*` 工具替代（`claude.ts:14-35` 注释）。`preToolUseHook`（`claude.ts:160-179`）还在执行入口再 block 一次，作为 defense-in-depth。
- **`permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`**：容器整个是沙箱、agent 的所有 tool call 不需要再弹权限对话框 —— 容器边界本身就是权限层。
- **`hooks`**：注册四个 hook —— `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `PreCompact`。前三个 hook 用来在 `container_state` 表里记录「当前在跑哪个 tool、声明的 timeout 是多少」，让 host 的 stuck-sweep 知道「Bash 正在 declare 长 timeout、别杀我」（`claude.ts:160-189`）；最后一个 hook 在 SDK 触发 auto-compact 之前把当前 transcript 归档到 conversations 文件夹（`claude.ts:191-232`）。

**c. 包装 SDK 的 async iterable 为 nanoclaw 自家的 `ProviderEvent` 流。**

`sdkResult` 本身是 `AsyncGenerator<SDKMessage>`，但 nanoclaw 不想让 `poll-loop.ts` 知道 SDK 内部消息形状。`translateEvents()`（`claude.ts:318-346`）用 `for await (const message of sdkResult)` 消费，按 `message.type` 翻译成 5 种 `ProviderEvent`：

| SDK 事件 | 翻译为 | 意义 |
|---|---|---|
| 任何事件 | `{ type: 'activity' }` | 心跳：告诉 poll-loop「agent 还活着，别 timeout」 |
| `system / init` | `{ type: 'init', continuation: session_id }` | 拿到这次的 SDK session id，poll-loop 立刻 `setContinuation` 持久化 |
| `result` | `{ type: 'result', text }` | 最终回复文本（也可能是 `null`，例如 agent 完全靠 MCP `send_message` 回了） |
| `system / api_retry` | `{ type: 'error', retryable: true }` | API 抖动重试中，日志一行 |
| `system / rate_limit_event` | `{ type: 'error', retryable: false, classification: 'quota' }` | 触配额，外层会写 error message_out |
| `system / compact_boundary` | `{ type: 'result', text: 'Context compacted (N tokens compacted).' }` | auto-compact 完成时给用户一条提示 |
| `system / task_notification` | `{ type: 'progress', message }` | 子 Task 工具状态变化 |

**d. 返回 `AgentQuery` handle 立刻返回，不阻塞。**

```ts
// claude.ts:348-356
return {
  push: (msg) => stream.push(msg),  // 把 follow-up user message 塞进同一条 SDK 输入流
  end: () => stream.end(),          // 关掉输入流，SDK 跑完手头的会自然结束
  events: translateEvents(),         // poll-loop 用 for await 消费
  abort: () => { aborted = true; stream.end(); }, // 紧急刹车
};
```

`translateEvents()` 是 generator —— 一调用就立刻返回，body 里的 `for await` 直到 poll-loop 第一次 `for await (const event of query.events)` 才真正开始拉 SDK。SDK 自己的子进程（`/pnpm/claude`，即 Claude Code CLI）在 `sdkQuery(...)` 那一行就已经被 spawn 了，进入「等输入」状态。

整个 `query()` 函数从调用到 return 全程同步、不到一毫秒。重头戏在下一步迭代事件流时才开始。

---

## 6. 代码位置

按阅读顺序：

- `poll-loop.ts:170-175` —— `config.provider.query({ prompt, continuation, cwd, systemContext })` 入口
- `providers/factory.ts:11` —— `createProvider` 通过 registry 找到 `ClaudeProvider` 工厂
- `providers/provider-registry.ts` —— `registerProvider('claude', …)` 注册（`claude.ts:360` 调用）
- `providers/claude.ts:253-273` —— `ClaudeProvider` 构造函数（保存 `assistantName` / `mcpServers` / `additionalDirectories` / `model` / `effort` / `env`）
- `providers/claude.ts:80-112` —— `MessageStream` push-based async iterable
- `providers/claude.ts:280-282` —— `query()` 入口、构造 stream 并 push 初始 prompt
- `providers/claude.ts:286-314` —— `sdkQuery({ prompt: stream, options: { … } })` 调用
- `providers/claude.ts:25-35` —— `SDK_DISALLOWED_TOOLS` 列表
- `providers/claude.ts:42-61` —— `TOOL_ALLOWLIST` 列表
- `providers/claude.ts:63-68` —— `mcpAllowPattern` MCP 名字 sanitize
- `providers/claude.ts:160-189` —— `preToolUseHook` / `postToolUseHook`（写 `container_state`）
- `providers/claude.ts:191-232` —— `createPreCompactHook`（archive transcript）
- `providers/claude.ts:244` —— `CLAUDE_CODE_AUTO_COMPACT_WINDOW=165000`
- `providers/claude.ts:251` —— `STALE_SESSION_RE` —— stale continuation 检测
- `providers/claude.ts:318-346` —— `translateEvents()` SDK → `ProviderEvent` 翻译
- `providers/claude.ts:348-356` —— 返回 `AgentQuery` handle
- `providers/types.ts:68-93` —— `AgentQuery` / `ProviderEvent` 接口定义
- `docs/SDK_DEEP_DIVE.md:15-52` —— SDK 的 `cli.js` 子进程 + JSON-lines 协议
- `docs/SDK_DEEP_DIVE.md:431-452` —— V2 `createSession()` 与本文用的 V1 `query()` 对比

---

## 7. 分支与延伸

- 想知道 `AgentProvider` 抽象的全貌（为什么不直接调 `sdkQuery`、`codex` / `opencode` provider 怎么共享同一个接口）→ [第 8 章 §Provider 抽象](08-agent-runner-and-providers.md#provider-抽象)
- `processQuery` 里的 `setInterval` 怎么把 follow-up 消息 push 进活着的 SDK 流（这正是 step 14 的主线）→ [第 8 章 §流式 push 中途更新](08-agent-runner-and-providers.md#流式-push-中途更新)
- SDK 本身是怎么 spawn `cli.js`、用 stream-json 协议交互的、partial messages 为什么 nanoclaw 不开 → [第 1 章 §`@anthropic-ai/claude-agent-sdk` 调用](01-overview.md#nanoclaw-的选择两个-db--单-writer--everything-is-a-message)
- `continuation`（SDK session id）怎么持久化、stale 时怎么回收 → [第 7 章 §session 生命周期](07-session-container-lifecycle.md)
- MCP tools 是从 `container_configs.mcp_servers` 怎么注入到这里的 → [第 8 章 §MCP server 装配](08-agent-runner-and-providers.md#mcp-server-装配)

---

## 8. 走完这一步你脑子里应该多了什么

1. **`@anthropic-ai/claude-agent-sdk` 不是 HTTP 封装，是 agent runtime**。它内部 spawn `/pnpm/claude`（Claude Code CLI）作为子进程，用 stream-json over stdin/stdout 通信，自己跑 agent loop、tool dispatch、context compaction、prompt cache —— nanoclaw 借助它省掉了上千行 agent infrastructure。
2. **`MessageStream` 让 SDK 输入「可追加」**。`sdkQuery` 接受 `AsyncIterable<SDKUserMessage>` 作为 prompt，而不是单个字符串。这给了 nanoclaw 在 query 还活着的时候 `query.push(msg)` 塞 follow-up 的能力 —— step 14 的核心机制。
3. **allowedTools 必须显式拼上 MCP 通配**。SDK 的 allowedTools 是白名单过滤器，`mcp__*` 不会自动豁免；漏拼一个就是「装了 MCP server 但 agent 看不到」的静默 bug。`mcpAllowPattern` 还要镜像 SDK 自家的 name sanitize 规则。
4. **disallowedTools 是定义性配置而非性能配置**。`EnterPlanMode` / `AskUserQuestion` / `CronCreate` 在 headless 容器里没有承接 UI，开着会卡死整个 turn。nanoclaw 用 `mcp__nanoclaw__*` 提供了语义等价物。
5. **`query()` 返回是同步的、事件流是惰性的**。`translateEvents()` 是 generator，构造时不消费；真正驱动 SDK 跑起来的是 step 14 里 `for await (const event of query.events)` 的第一次拉取。`query()` 函数本身用时 ≪1ms。
6. **`activity` 事件是设计性的心跳**。SDK 每收到一个 message（无论 tool call、thinking、retry）都翻成一个 `activity` 事件 —— poll-loop 用它来 `touchHeartbeat`，避免 host 误判 stuck。这是 nanoclaw 在 SDK 之上加的薄薄一层但很关键。

下一步：[Trace 步骤 14 —— 流式 push 中途更新](tour-single-cli-message-14-streaming-push.md)。
