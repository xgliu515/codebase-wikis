## 第 8 章 Agent-runner：容器内的轮询循环

> 关联代码版本：`nanocoai/nanoclaw@0683c6e`（v2.0.64）
>
> 入口文件：`container/agent-runner/src/index.ts`、`poll-loop.ts`、`formatter.ts`、`destinations.ts`、`providers/`、`db/`、`mcp-tools/`、`compact-instructions.ts`、`current-batch.ts`
>
> 相关文档：`docs/agent-runner-details.md`、`docs/SDK_DEEP_DIVE.md`

容器拉起后到底跑什么、跑多久、怎么知道自己该睡？这一章把"agent-runner"这个常驻进程从头到尾拆开。它是 NanoClaw 的"心脏"——所有其它模块都是为了让这 500 行代码能在隔离环境里干净地跑。

---

### 8.1 设计问题

agent-runner 是个 single-process、long-lived 的 Node/Bun 程序，跑在一个**只有它一个用户**的容器里。它要扛的责任清单：

1. **拉新消息**：每 1 秒（或 0.5 秒，active 状态下）扫一次 inbound.db 的 messages_in。新增 `on_wake` 优先级——首次 poll 才看 on_wake=1 的行，避免被 dying container 偷走。
2. **组 prompt**：把历史 + 当前批次组合成 SDK 入参。需要保留路由信息（thread_id、platform、sender）让 agent 知道"谁说的"，但又要剥离敏感字段（不让 agent 直接看 platform internal id）。
3. **调 SDK 并并发轮询**：调用期间还要继续 poll，让 follow-up 消息能 `push()` 进同一个 query stream，避免每条消息都开新 query（cache miss、SDK subprocess 重启很贵）。
4. **写多种 outbound**：chat reply、tool result、approval card、schedule reminder、edit、reaction、附件。每种 kind 落 messages_out 不同列、由 host delivery 端不同 adapter 处理。
5. **存活信号**：touch `.heartbeat` 让 host-sweep 知道我还活着，stuck 了让 host 能 kill。
6. **优雅退出**：SIGTERM 时 1 秒内把 outbound.db 落盘、容器退出。

整章按代码自然路径展开：`index.ts` 启动 → `poll-loop.ts` 主循环 → `formatter.ts` 整形 → `providers/claude.ts` 出场 → `mcp-tools/` 提供 agent 能调的工具。

---

### 8.2 入口：`index.ts`

`container/agent-runner/src/index.ts` 全文 109 行，主体在 `main()`（`:42-104`）。

#### 8.2.1 mount 结构提示

顶部 docstring（`:10-22`）把容器内目录复述了一遍，方便后续看代码时随手翻：

```
/workspace/
  inbound.db        ← host-owned session DB (container reads only)
  outbound.db       ← container-owned session DB
  .heartbeat        ← container touches for liveness detection
  outbox/           ← outbound files
  agent/            ← agent group folder (CLAUDE.md, container.json, working files)
    container.json  ← per-group config (RO nested mount)
  global/           ← shared global memory (RO)
/app/src/           ← shared agent-runner source (RO)
/app/skills/        ← shared skills (RO)
/home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
```

CWD 永远是 `/workspace/agent`（`:40`），意味着 agent 的 `pwd` 是 group 工作目录而不是 session 目录——这样 agent 写"./notes.md"会落到 group 级，跨 session 可见。

#### 8.2.2 启动序列

```ts
const config = loadConfig();
const providerName = config.provider.toLowerCase() as ProviderName;

// 1. 算系统提示尾部 addendum
const instructions = buildSystemPromptAddendum(config.assistantName || undefined);

// 2. 扫 /workspace/extra/* 加进 additionalDirectories
const additionalDirectories: string[] = [];
const extraBase = '/workspace/extra';
if (fs.existsSync(extraBase)) {
  for (const entry of fs.readdirSync(extraBase)) {
    const fullPath = path.join(extraBase, entry);
    if (fs.statSync(fullPath).isDirectory()) {
      additionalDirectories.push(fullPath);
    }
  }
}

// 3. 拼 mcpServers：内置 nanoclaw + container.json 来的外部 server
const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');
const mcpServers = {
  nanoclaw: { command: 'bun', args: ['run', mcpServerPath], env: {} },
};
for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
  mcpServers[name] = serverConfig;
}

// 4. 工厂创建 provider
const provider = createProvider(providerName, {
  assistantName: config.assistantName || undefined,
  mcpServers,
  env: { ...process.env },
  additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
  model: config.model,
  effort: config.effort,
});

// 5. 进 poll loop（永不返回）
await runPollLoop({
  provider,
  providerName,
  cwd: CWD,
  systemContext: { instructions },
});
```

几条说明：

- `buildSystemPromptAddendum`（`destinations.ts:82`）只产出"agent 身份 + destination 列表"两段——剩下的 instruction 全部走 CLAUDE.md import。这种切分是为了让 destination list 能**动态**：每次 spawn 都从 inbound.db 的 `destinations` 表读最新值，而不是烧死在 CLAUDE.md 里。
- `nanoclaw` MCP server 用 **同一 process 内的 child process** 启动：`{ command: 'bun', args: ['run', /app/src/mcp-tools/index.ts] }`。这意味着 agent-runner 和 mcp-tools server 是两个 bun 进程，通过 stdio 通信——Claude SDK 把 mcp tool 翻成 `mcp__nanoclaw__schedule_task` 这种命名后调 stdio JSON-RPC。
- `additionalDirectories` 这一段在 agent-runner 而不是 SDK 里扫，是因为 SDK 不知道这个目录约定；这里发现，再交给 SDK 配 `additionalDirectories` 让 agent 能 read。
- `loadConfig()` / `createProvider()` 都是工厂模式——切 provider（claude/opencode/mock）不改 index.ts。

#### 8.2.3 错误兜底

`main().catch(...)`（`:106-109`）：fatal error 打日志后 `process.exit(1)`。tini 收到 child 退出会自己退出，container 整个 stop——host close 事件清表，下次有消息再 spawn 新的。

---

### 8.3 主循环：`poll-loop.ts`

`container/agent-runner/src/poll-loop.ts` 518 行，是全章重点。

<svg viewBox="0 0 820 480" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="One iteration of the poll loop: fetch, gate, claim, format, run query, handle errors, sleep"><defs><marker id="ar8a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="410" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">poll-loop 一轮：9 步从拉消息到 markCompleted</text><g><rect x="40" y="44" width="740" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="60" y="66" font-size="12" font-weight="700" fill="currentColor">①</text><text x="410" y="66" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">getPendingMessages(isFirstPoll)  → 短连接读 inbound.db，filter 掉 system + processing_ack</text></g><line x1="410" y1="80" x2="410" y2="98" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8a)"/><g><rect x="40" y="98" width="360" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/><text x="60" y="120" font-size="12" font-weight="700" fill="currentColor">②</text><text x="220" y="120" text-anchor="middle" font-size="11" fill="currentColor">messages 为空 → sleep 1s · continue</text></g><g><rect x="420" y="98" width="360" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/><text x="440" y="120" font-size="12" font-weight="700" fill="currentColor">③</text><text x="600" y="120" text-anchor="middle" font-size="11" fill="currentColor">全是 trigger=0 累积 → sleep 不唤醒</text></g><line x1="410" y1="138" x2="410" y2="156" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8a)"/><g><rect x="40" y="156" width="740" height="36" rx="6" fill="#ccfbf1" stroke="#0d9488" stroke-width="1.2"/><text x="60" y="178" font-size="12" font-weight="700" fill="currentColor">④</text><text x="410" y="178" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">markProcessing(ids)  → 写 outbound.processing_ack（status='processing'），抢消息</text></g><line x1="410" y1="192" x2="410" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8a)"/><g><rect x="40" y="210" width="740" height="36" rx="6" fill="#ccfbf1" stroke="#0d9488" stroke-width="1"/><text x="60" y="232" font-size="12" font-weight="700" fill="currentColor">⑤</text><text x="410" y="232" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">extractRouting + 拦截 /clear (重置 continuation，写回执，从 batch 移除)</text></g><line x1="410" y1="246" x2="410" y2="264" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8a)"/><g><rect x="40" y="264" width="740" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/><text x="60" y="286" font-size="12" font-weight="700" fill="currentColor">⑥</text><text x="410" y="286" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">applyPreTaskScripts  → scheduled task 的 script，wakeAgent=false 直接 markCompleted 吞掉</text></g><line x1="410" y1="300" x2="410" y2="318" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8a)"/><g><rect x="40" y="318" width="740" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/><text x="60" y="340" font-size="12" font-weight="700" fill="currentColor">⑦</text><text x="410" y="340" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">formatMessagesWithCommands  → passthrough slash 命令原文穿插，普通消息走 XML</text></g><line x1="410" y1="354" x2="410" y2="372" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8a)"/><g><rect x="40" y="372" width="740" height="42" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/><text x="60" y="394" font-size="12" font-weight="700" fill="currentColor">⑧</text><text x="410" y="394" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">provider.query(prompt, continuation) → processQuery</text><text x="410" y="408" text-anchor="middle" font-size="10" fill="#64748b">异步消费 SDK events + 500ms follow-up poll（详见图 R8.2）</text></g><line x1="410" y1="414" x2="410" y2="432" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8a)"/><g><rect x="40" y="432" width="740" height="36" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/><text x="60" y="454" font-size="12" font-weight="700" fill="currentColor">⑨</text><text x="410" y="454" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">markCompleted(processingIds) (兜底)  → 循环回顶</text></g></svg>
<span class="figure-caption">图 R8.1 ｜ poll-loop 一轮迭代的 9 步：橙=拉取、灰=早退 gate、青=claim/路由、紫=格式化、黄=核心 query 阶段、绿=收尾。早退分支（②③）跳过 ④-⑨ 回到 sleep。</span>

#### 8.3.1 高层结构

```ts
const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // 0. 起手：取 continuation、清 stale acks
  let continuation = migrateLegacyContinuation(config.providerName);
  clearStaleProcessingAcks();

  let isFirstPoll = true;
  while (true) {
    // 1. 拉新消息（首次包含 on_wake）
    const messages = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
    isFirstPoll = false;

    // 2. 无消息 → 睡
    if (messages.length === 0) { await sleep(POLL_INTERVAL_MS); continue; }

    // 3. 全是 trigger=0 → 累积模式，不唤醒
    if (!messages.some((m) => m.trigger === 1)) { await sleep(POLL_INTERVAL_MS); continue; }

    // 4. claim
    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    // 5. 抽路由 + 处理 /clear
    const routing = extractRouting(messages);
    // ...拆出 normalMessages 和 commandIds...

    // 6. 跑 pre-task script（scheduling 模块）
    // ...

    // 7. 格式化 prompt（passthrough slash 命令走原文）
    const prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    // 8. 启动 query + 并发 poll
    const query = config.provider.query({ prompt, continuation, cwd, systemContext });
    setCurrentInReplyTo(routing.inReplyTo);
    try {
      const result = await processQuery(query, routing, processingIds, providerName);
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(providerName, continuation);
      }
    } catch (err) { /* 写错误回复 + 检查 stale session */ }
    finally { clearCurrentInReplyTo(); }

    // 9. 兜底 markCompleted
    markCompleted(processingIds);
  }
}
```

下面逐段拆。

#### 8.3.2 起手：continuation 和 stale ack

```ts
let continuation: string | undefined = migrateLegacyContinuation(config.providerName);
if (continuation) log(`Resuming agent session ${continuation}`);
clearStaleProcessingAcks();
```

`continuation` 是 provider 私有的 opaque 字符串（Claude 是 SDK 的 `session_id`，对应 transcript .jsonl 文件名）。`migrateLegacyContinuation` 做两件事（`db/session-state.ts:52-67`）：

1. 看 legacy key `sdk_session_id` 是否还在（v2 早期没按 provider 分键），有就删掉；
2. 如果当前 provider 自己的 `continuation:<provider>` 没值，把 legacy 值收编过来。

`clearStaleProcessingAcks()`（`db/connection.ts:175-177`）：`DELETE FROM processing_ack WHERE status = 'processing'`。上次 container crash 留下的"processing"标记必须清，否则那些消息会被 `getPendingMessages` 的反向 filter 当成"已被另一个 worker 接走"而漏掉。

#### 8.3.3 拉消息：`getPendingMessages`

`db/messages-in.ts:65-97`：

```ts
export function getPendingMessages(isFirstPoll = false): MessageInRow[] {
  const inbound = openInboundDb();   // ← 每次都新开！
  const outbound = getOutboundDb();  // ← 长连接

  try {
    const onWakeFilter = hasOnWakeColumn(inbound) ? 'AND (on_wake = 0 OR ?1 = 1)' : '';
    const pending = inbound.prepare(
      `SELECT * FROM messages_in
       WHERE status = 'pending'
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
         ${onWakeFilter}
       ORDER BY seq DESC
       LIMIT ?2`,
    ).all(isFirstPoll ? 1 : 0, getMaxMessagesPerPrompt()) as MessageInRow[];

    if (pending.length === 0) return [];

    const ackedIds = new Set(
      (outbound.prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>)
        .map((r) => r.message_id),
    );

    return pending.filter((m) => !ackedIds.has(m.id)).reverse();
  } finally {
    inbound.close();
  }
}
```

四条关键约束：

1. **inbound 每次新开 + 关**（`connection.ts:45-57` 的 `openInboundDb`）。`PRAGMA mmap_size = 0` 关掉 mmap，绕开 virtiofs / NFS 不传 mmap 一致性的坑。代价是每次 query 多几十微秒，相比 cross-mount 失效造成的"永远看不到新消息"是极小代价。
2. **outbound 走长连接**（`connection.ts:65-72`、`75-113`）。container 是 outbound 的唯一 writer，没人和它竞争。第一次 `getOutboundDb()` 会建表（session_state、container_state），是 forward-compat 的 lightweight migration。
3. **on_wake 是 forward-compat**：`hasOnWakeColumn()` cache 一次，因为容器开的是 RO 读，不能 `ALTER TABLE`——遇到老 session DB（v2.0.48 之前）就降级，给 on_wake 等价 0。
4. **DESC + reverse**：取最近 N 条（按 seq 倒序 + LIMIT），但 agent 应看到时间顺序，所以最后 reverse。`MAX_MESSAGES_PER_PROMPT` 从 `config.maxMessagesPerPrompt` 取，默认 10。

`getPendingMessages` 还做了**outbound 端 join**：把 outbound.processing_ack 里已经 claim 过的 id 过滤掉。这样 dying container 即使捡了一行（写了 processing_ack），新 container 看到也会跳过——除非新 container 启动时 `clearStaleProcessingAcks()` 把 'processing' 行删了，那些就重新可见。

#### 8.3.4 trigger=0 累积模式

```ts
if (!messages.some((m) => m.trigger === 1)) {
  await sleep(POLL_INTERVAL_MS);
  continue;
}
```

router 那一侧（第 6 章）会用 `ignored_message_policy='accumulate'` 把"我不该回的群消息"以 `trigger=0` 写进 inbound——这些行不会触发 wake，但下次有真正 wake 的消息来时会一起被 fetch 进 prompt 当上下文。注释（`:87-98`）解释这条 gate 不能少：warm container 不加这个 check 会在每个 accumulate-only batch 上跑 SDK，等于 agent 偷偷参与了用户没要它参与的对话。

host-side `countDueMessages` 也按这个规则 gate cold start——逻辑对称。

#### 8.3.5 命令处理：`/clear` 在 runner，其它在 host

```ts
for (const msg of messages) {
  if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
    log('Clearing session (resetting continuation)');
    continuation = undefined;
    clearContinuation(config.providerName);
    writeMessageOut({
      id: generateId(),
      kind: 'chat',
      platform_id: routing.platformId,
      channel_type: routing.channelType,
      thread_id: routing.threadId,
      content: JSON.stringify({ text: 'Session cleared.' }),
    });
    commandIds.push(msg.id);
    continue;
  }
  normalMessages.push(msg);
}
```

注释（`:106-109`）写明：所有 admin / filtered slash 命令在 host router 那里就被拦/分派了，唯一到达 runner 的是 `/clear`——只能在这里处理，因为它要重置 runner 本进程的 `continuation` 变量，host 没办法跨进程改。

#### 8.3.6 Pre-task script 注入点

```ts
// MODULE-HOOK:scheduling-pre-task:start
const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
const preTask = await applyPreTaskScripts(normalMessages);
keep = preTask.keep;
skipped = preTask.skipped;
if (skipped.length > 0) {
  markCompleted(skipped);
  log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
}
// MODULE-HOOK:scheduling-pre-task:end
```

`scheduling` 模块允许给 scheduled task 配一个 script——例如每 10 分钟跑一次 `check-deploy.sh`，脚本输出 JSON：如果 `wakeAgent=false`，task 被吞掉（写 completed，不进 prompt）；否则继续。`MODULE-HOOK` 注释是 host setup 工具（第 11 章）识别"可裁剪模块"的标记，不是 runtime 语义。

#### 8.3.7 命令 vs 普通：`formatMessagesWithCommands`

```ts
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        if (normalBatch.length > 0) { parts.push(formatMessages(normalBatch)); normalBatch.length = 0; }
        parts.push(cmdInfo.text);   // 原文，不包 XML
        continue;
      }
    }
    normalBatch.push(msg);
  }
  if (normalBatch.length > 0) parts.push(formatMessages(normalBatch));
  return parts.join('\n\n');
}
```

Claude Code 原生认识 `/compact`、`/cost`、`/context` 这些 slash 命令，但只有当它们是 query 的**首条输入**时才会被 SDK dispatch。包成 XML（`<message>...</message>`）就成了普通文本。所以这里要分裂 batch：normal 部分照常格式化，passthrough/admin 部分以原文穿插。

`MockProvider` `.supportsNativeSlashCommands = false`，永远走 XML——测试不需要真跑 slash 命令。

#### 8.3.8 启动 query + 跟踪 in_reply_to

```ts
const query = config.provider.query({
  prompt,
  continuation,
  cwd: config.cwd,
  systemContext: config.systemContext,
});

const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
setCurrentInReplyTo(routing.inReplyTo);
try {
  const result = await processQuery(query, routing, processingIds, config.providerName);
  // ...persist continuation...
} catch (err) {
  // ...error reply, maybe clear stale continuation...
} finally {
  clearCurrentInReplyTo();
}
markCompleted(processingIds);
```

`setCurrentInReplyTo` 把 batch 的"原 inbound 消息 id"放到 module-level state（`current-batch.ts`）。MCP 工具（`send_message`、`send_file`）在 batch 处理期间会被 agent 调用，它们读这个值塞到 outbound 行的 `in_reply_to` 列——这是 agent-to-agent 模块"return-path routing"的依据：让 reply 能准确找回发起方 session。`finally` 里清，避免下次 batch 串值。

为什么不通过函数参数传？因为 MCP 工具是 SDK 通过 child process + JSON-RPC 调起来的，调用栈隔着 process 边界，没法把 `inReplyTo` 顺着函数链传过去。设计上 agent-runner 是单进程、一次一个 batch，module-level state 是合理近似。

#### 8.3.9 `processQuery`：核心并发模型

```ts
async function processQuery(query, routing, initialBatchIds, providerName): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;
  let unwrappedNudged = false;
  let pollInFlight = false;
  let endedForCommand = false;

  // 每 500ms：在 query 仍 alive 时尝试 push follow-ups
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;
    void (async () => {
      try {
        const pending = getPendingMessages();
        // 1) 出现 slash 命令 → end stream，让外层循环用首条命令路径
        if (pending.some((m) => isRunnerCommand(m))) {
          endedForCommand = true;
          query.end();
          return;
        }
        // 2) 普通新消息：跑 pre-task → format → query.push() → markCompleted
        const newMessages = pending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) return;
        markProcessing(newMessages.map((m) => m.id));
        // ... pre-task script gate ...
        if (keep.length === 0) return;
        if (done) return;   // 再次检查，query 可能已结束
        const prompt = formatMessages(keep);
        query.push(prompt);
        markCompleted(keep.map((m) => m.id));
      } catch (err) {
        log(`Follow-up poll error: ${err}`);
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();          // ← 每个 SDK event 都 touch
      if (event.type === 'init') {
        queryContinuation = event.continuation;
        setContinuation(providerName, event.continuation);   // 立刻持久化
      } else if (event.type === 'result') {
        markCompleted(initialBatchIds);                       // 一旦有 result，初始批次算完
        if (event.text) {
          const { hasUnwrapped } = dispatchResultText(event.text, routing);
          if (hasUnwrapped && !unwrappedNudged) {
            unwrappedNudged = true;
            query.push(`<system>Your response was not delivered — ...</system>`);
          }
        }
      }
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
  }
  return { continuation: queryContinuation };
}
```

<svg viewBox="0 0 860 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="processQuery concurrent model: SDK event consumer and 500ms follow-up poll share state, both can end the stream"><defs><marker id="ar8b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="430" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">processQuery：两条并发协程共享 done/endedForCommand</text><g><rect x="320" y="44" width="220" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="430" y="63" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">provider.query(...)</text><text x="430" y="79" text-anchor="middle" font-size="10" fill="#64748b">push-based async iterable</text></g><line x1="370" y1="88" x2="200" y2="118" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8b)"/><line x1="490" y1="88" x2="660" y2="118" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8b)"/><g><rect x="20" y="118" width="360" height="240" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/><text x="200" y="138" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">协程 A：for await (event of query.events)</text><g><rect x="40" y="155" width="320" height="30" rx="4" fill="#ffffff" stroke="#d97706" stroke-width="1"/><text x="200" y="174" text-anchor="middle" font-size="11" fill="currentColor">init → setContinuation (立刻持久化)</text></g><g><rect x="40" y="190" width="320" height="30" rx="4" fill="#ffffff" stroke="#d97706" stroke-width="1"/><text x="200" y="209" text-anchor="middle" font-size="11" fill="currentColor">每 event → touchHeartbeat()</text></g><g><rect x="40" y="225" width="320" height="50" rx="4" fill="#ffffff" stroke="#d97706" stroke-width="1"/><text x="200" y="244" text-anchor="middle" font-size="11" fill="currentColor">result → markCompleted(initialBatchIds)</text><text x="200" y="262" text-anchor="middle" font-size="10" fill="#64748b">dispatchResultText (解析 &lt;message to=&gt;)</text></g><g><rect x="40" y="280" width="320" height="40" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/><text x="200" y="297" text-anchor="middle" font-size="11" fill="currentColor">unwrappedNudged?  →  query.push(&lt;system&gt;...)</text><text x="200" y="312" text-anchor="middle" font-size="10" fill="#64748b">agent 忘 wrap 时回灌一次提示</text></g><g><rect x="40" y="325" width="320" height="28" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/><text x="200" y="343" text-anchor="middle" font-size="11" fill="currentColor">stream 关闭 → finally: done=true</text></g></g><g><rect x="480" y="118" width="360" height="240" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="660" y="138" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">协程 B：setInterval(500ms) follow-up poll</text><g><rect x="500" y="155" width="320" height="30" rx="4" fill="#ffffff" stroke="#7c3aed" stroke-width="1"/><text x="660" y="174" text-anchor="middle" font-size="11" fill="currentColor">guard: done | pollInFlight | endedForCmd</text></g><g><rect x="500" y="190" width="320" height="30" rx="4" fill="#ffffff" stroke="#7c3aed" stroke-width="1"/><text x="660" y="209" text-anchor="middle" font-size="11" fill="currentColor">getPendingMessages()</text></g><g><rect x="500" y="225" width="320" height="50" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/><text x="660" y="244" text-anchor="middle" font-size="11" fill="currentColor">含 slash 命令 → endedForCommand=true</text><text x="660" y="262" text-anchor="middle" font-size="11" fill="currentColor">query.end()  → 外层走首命令路径</text></g><g><rect x="500" y="280" width="320" height="40" rx="4" fill="#ffffff" stroke="#7c3aed" stroke-width="1"/><text x="660" y="297" text-anchor="middle" font-size="11" fill="currentColor">普通新消息 → pre-task → query.push(prompt)</text><text x="660" y="312" text-anchor="middle" font-size="10" fill="#64748b">不开新 query，复用 SDK 子进程</text></g><g><rect x="500" y="325" width="320" height="28" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/><text x="660" y="343" text-anchor="middle" font-size="11" fill="currentColor">markCompleted(keep) 收尾</text></g></g><g><rect x="40" y="380" width="780" height="60" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-dasharray="4,3"/><text x="430" y="402" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">共享 module-level state（同进程，无锁）</text><text x="430" y="421" text-anchor="middle" font-size="10" fill="#64748b">done · pollInFlight · endedForCommand · unwrappedNudged · setCurrentInReplyTo</text><text x="430" y="435" text-anchor="middle" font-size="10" fill="#94a3b8">两条协程都能写 done；A 关 stream，B 关 stream（slash 命令场景）；finally 清 interval</text></g></svg>
<span class="figure-caption">图 R8.2 ｜ processQuery 的并发模型：黄=事件消费协程 A、紫=每 500ms 的 follow-up poll 协程 B。两者共享 done/endedForCommand 等 boolean，任一可 end stream。push 进同一 query 避免 SDK 子进程重启。</span>

几个关键细节：

**(a) 不强制 silence-based end**。注释（`:270-278`）写得很清楚：保持 query 开放避免 SDK 子进程重启（几秒成本）和重读 transcript。**Anthropic prompt cache 是服务器侧、5 分钟 TTL、按 prefix hash key**——所以 stream 开关与 cache 命中无关。"stuck"检测交给 host-sweep（heartbeat + processing claim age）。

**(b) Init 时立刻持久化 continuation**（`:362-374`）。早期实现等 result 才写，结果 mid-turn crash 后下次 wake 找不到 session，agent 从零开始失去上下文。现在改成 init 一来就写。

**(c) `result` 不一定有 text**。agent 可能整轮只用 MCP `send_message` 回复，没有 final text；可能就是没什么要说的（schedule trigger 触发，但没到处理时间）。`event.text` 是 nullable，nullable 时不调 `dispatchResultText`。**但 result 事件本身就是 "turn done" 的信号**，所以无条件 markCompleted。

**(d) Stream 仍开放允许 follow-up**。result 后 SDK 可能还在等下一轮 user message（流式 push pattern）。`pollHandle` 这时还会跑，新消息进来就 `query.push()`。query 真正结束是 stream iter 完成（next user 不再来 → done）。

**(e) Re-check `done` 在 push 前**。follow-up poll 异步、awaits pre-task script，期间 outer for-await 可能已经收到 stream 关闭。push 进已关闭 stream 是浪费——markProcessing 写过的行靠 host-sweep 的 processing-claim 超时回收（第 10 章）。

**(f) Slash 命令中途出现 → end stream**。slash 命令必须是 query 首条输入才被 SDK dispatch，中途 push 进来等于普通文本。所以发现待处理消息含 runner command，立刻 `query.end()`、不 markProcessing 不 markCompleted，让 outer loop 下一轮通过首条命令路径处理。

#### 8.3.10 `dispatchResultText`：解析 `<message to="...">` 块

```ts
const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

while ((match = MESSAGE_RE.exec(text)) !== null) {
  const toName = match[1];
  const body = match[2].trim();
  const dest = findByName(toName);
  if (!dest) {
    log(`Unknown destination in <message to="${toName}">, dropping block`);
    scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
    continue;
  }
  sendToDestination(dest, body, routing);
  sent++;
}
```

合约：**agent 的所有 user-facing 输出必须包在 `<message to="name">…</message>` 里**，哪怕只有一个 destination。块外的文字（包括 `<internal>...</internal>`）是 scratchpad，只 log 不发。`destinations.ts` 注入的 system prompt 反复强调这一点。

如果 agent 偷懒没包 `<message>` 而直接写普通文本，`sent === 0 && scratchpad.length > 0` 触发"nudge"：

```ts
query.push(
  `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
    `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
    `Your destinations: ${names}. Please re-send your response with the correct wrapping.</system>`,
);
```

`unwrappedNudged = true` 避免同 batch 内反复 nudge。这是个常见 bug-correction loop——LLM 偶尔会忘记 wrapping 约定，nudge 一次基本就回到正轨。

#### 8.3.11 destination resolve 与 thread

`sendToDestination`（`:473-490`）：

```ts
function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  const destRouting = resolveDestinationThread(channelType, platformId);
  writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
}
```

`resolveDestinationThread`（`:496-514`）在 inbound.db 里反查同 `(channel_type, platform_id)` 下最近一条消息的 `thread_id` 和 `id`。两个目的：

- **agent-shared session 跨多个 channel**时，单一 `routing.threadId` 会把一个 channel 的 thread id 盖到另一个 channel 上——必须按 destination 单独解析。
- 把"上次的 inbound id"放到 `in_reply_to`，让平台 adapter 能渲染成"引用回复"形态。

---

### 8.4 `formatter.ts`：prompt 整形

`formatter.ts` 280 行，把 batch 翻成给 SDK 的 string。

#### 8.4.1 命令分类

```ts
const ADMIN_COMMANDS = new Set(['/remote-control', '/clear', '/compact', '/context', '/cost', '/files']);
const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/start']);
```

- `admin`：sender 必须在 `NANOCLAW_ADMIN_USER_IDS`（host router gate）。`/clear` 是 runner 自己处理；其它在 host 拦了或在 SDK 那里 dispatch。
- `filtered`：channel 自带的"我是聊天机器人的 help"风格，直接吞，避免污染 agent context。
- `passthrough`：未知 slash，agent 自己看着办（Claude Code 可能识别 user-defined slash command）。
- `none`：普通文本。

`extractSenderId` 在 `:82-90` 给 raw `userId` 补 `<channel_type>:` 前缀，因为 chat-sdk-bridge 给 raw id，而 `NANOCLAW_ADMIN_USER_IDS` 存的是 namespaced 形式。

#### 8.4.2 主格式化

```ts
export function formatMessages(messages: MessageInRow[]): string {
  const header = `<context timezone="${escapeXml(TIMEZONE)}" />\n`;
  // ...按 kind 分组...
  return header + parts.join('\n\n');
}
```

`<context timezone=...>` 是必须的（注释 `:124-127`）：agent 看到的所有时间戳都是 user local time，所有 schedule 输出也按这个 zone 解释。早期忘了塞这个 header，scheduled task 集体错时区。

四类 kind：

- **chat**（单条或 `<messages>...</messages>` 包多条）：
  ```xml
  <message id="42" from="ts:slack-cust" sender="Alice" time="2026-05-24 10:00"
           reply_to="msg-abc">
    <quoted_message from="Bob">Hi Alice</quoted_message>
    Hello!
    [image: photo.jpg — saved to /workspace/inbox/msg-abc/photo.jpg]
  </message>
  ```
- **task**：scheduled task firing。如果有 `scriptOutput`（pre-task script 返回的 JSON），先输出脚本结果再放 prompt。
  ```xml
  <task from="agent" time="2026-05-24 09:00">
  Script output:
  {...}

  Instructions:
  check the deploy status
  </task>
  ```
- **webhook**：HTTP webhook 转发的 event。
- **system**：MCP tool 异步响应（`ask_user_question` 的回答）。

#### 8.4.3 `from="name"` 反查

`originAttr`（`:190-197`）反查 `destinations` 表，把 `(channel_type, platform_id)` 翻成 destination name。Agent 看到的不是 raw platform id 而是 `from="alice"`、`from="github-issues"` 这种语义名——和它要给 `<message to="...">` 用的名字一致。这极大简化了"回复给原 sender"的逻辑：agent 看 `from` 直接 copy 到 `to`。

#### 8.4.4 附件渲染

`formatAttachments`（`:244-257`）只输出文件名 + localPath（容器内路径，前缀 `/workspace/`），不内联内容。Agent 拿到 `/workspace/inbox/<msg>/photo.jpg` 后用 `Read` 或 `Bash` 工具自己加载。这避免把 base64 灌进 prompt（费 token、cache miss）。

---

### 8.5 Destinations：路由 ACL

`destinations.ts` 130 行，逻辑很轻。

`destinations` 表（inbound.db）字段：
```
name, display_name, type ('channel'|'agent'),
channel_type, platform_id, agent_group_id
```

host 在每次 wake 都写一遍这张表（`src/session-manager.ts:156` 的 `writeSessionRouting` 写 session_routing；agent-to-agent 模块的 `writeDestinations` 写 destinations 表）。container 这一侧只读（注释 `:1-12`）：

```ts
export function getAllDestinations(): DestinationEntry[] { /* SELECT * ORDER BY name */ }
export function findByName(name: string): DestinationEntry | undefined { /* WHERE name = ? */ }
export function findByRouting(channelType, platformId): DestinationEntry | undefined { /* 反查 */ }
```

注释强调（`:9-12`）：这张表既是路由表也是容器内可见的 ACL；host 还会在 delivery 那一侧用 central DB 重新校验，container 即使有过期表也不会被绕过。

#### 8.5.1 System prompt addendum

`buildSystemPromptAddendum`（`:82-92`）：

```ts
sections.push([
  '# You are ' + assistantName,
  '',
  `Your name is **${assistantName}**. Use it when the channel asks who you are, ` +
  `when introducing yourself, and when signing any message that explicitly calls for a signature.`,
].join('\n'));

sections.push(buildDestinationsSection());
```

`buildDestinationsSection`（`:94-130`）罗列所有 destination 名，附带使用规则："默认回 `from` 一致的目的地"、"`send_message` MCP 工具可以中途发"。这段是**唯一**注入到 system prompt 里的部分；其余 instruction 走 CLAUDE.md import。

---

### 8.6 Provider 抽象

<svg viewBox="0 0 820 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Provider abstraction: poll-loop talks to AgentProvider/AgentQuery interface, factory + registry route to ClaudeProvider or MockProvider"><defs><marker id="ar8c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="410" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Provider 抽象：poll-loop ⊥ 具体 SDK</text><g><rect x="240" y="44" width="340" height="50" rx="8" fill="#ccfbf1" stroke="#0d9488" stroke-width="1.5"/><text x="410" y="64" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">poll-loop.ts (consumer)</text><text x="410" y="82" text-anchor="middle" font-size="10" fill="#64748b">只知道 AgentProvider / AgentQuery 接口</text></g><line x1="410" y1="94" x2="410" y2="118" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8c)"/><g><rect x="100" y="118" width="620" height="100" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="410" y="138" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">providers/types.ts  (contract)</text><text x="410" y="158" text-anchor="middle" font-size="11" fill="currentColor">AgentProvider: supportsNativeSlashCommands · query() · isSessionInvalid()</text><text x="410" y="176" text-anchor="middle" font-size="11" fill="currentColor">AgentQuery: push() · end() · events: AsyncIterable · abort()</text><text x="410" y="196" text-anchor="middle" font-size="11" fill="currentColor">ProviderEvent: init | result | error | progress | activity</text><text x="410" y="212" text-anchor="middle" font-size="10" fill="#94a3b8">activity 事件用于 touchHeartbeat()</text></g><line x1="410" y1="218" x2="410" y2="240" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8c)"/><g><rect x="260" y="240" width="300" height="48" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="410" y="260" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">factory.ts + provider-registry.ts</text><text x="410" y="278" text-anchor="middle" font-size="10" fill="#64748b">registerProvider(name, factory)  (import side effect)</text></g><line x1="350" y1="288" x2="180" y2="318" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8c)"/><line x1="470" y1="288" x2="640" y2="318" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8c)"/><g><rect x="30" y="318" width="300" height="90" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/><text x="180" y="338" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">ClaudeProvider</text><text x="180" y="357" text-anchor="middle" font-size="11" fill="currentColor">@anthropic/claude-code SDK</text><text x="180" y="374" text-anchor="middle" font-size="10" fill="#64748b">手写 MessageStream (push iterable)</text><text x="180" y="390" text-anchor="middle" font-size="10" fill="#64748b">SDK message → ProviderEvent 翻译</text><text x="180" y="404" text-anchor="middle" font-size="10" fill="#94a3b8">STALE_SESSION_RE 兜底 isSessionInvalid</text></g><g><rect x="490" y="318" width="300" height="90" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/><text x="640" y="338" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">MockProvider</text><text x="640" y="357" text-anchor="middle" font-size="11" fill="currentColor">纯测试 stub (bun:test)</text><text x="640" y="374" text-anchor="middle" font-size="10" fill="#64748b">supportsNativeSlashCommands = false</text><text x="640" y="390" text-anchor="middle" font-size="10" fill="#64748b">每个 push → yield 一次 result</text><text x="640" y="404" text-anchor="middle" font-size="10" fill="#94a3b8">responseFactory 可注入</text></g></svg>
<span class="figure-caption">图 R8.3 ｜ Provider 抽象的四层：消费者只依赖青色接口，由紫色 registry 把名字映射到橙色具体 provider；加新 provider 只需 registerProvider 一行，不改 poll-loop。</span>

#### 8.6.1 接口

`providers/types.ts`：

```ts
export interface AgentProvider {
  readonly supportsNativeSlashCommands: boolean;
  query(input: QueryInput): AgentQuery;
  isSessionInvalid(err: unknown): boolean;
}

export interface AgentQuery {
  push(message: string): void;
  end(): void;
  events: AsyncIterable<ProviderEvent>;
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  | { type: 'activity' };
```

`activity` 是"liveness"事件，poll-loop 拿来 touch heartbeat。provider 在每个底层 SDK event（tool call、thinking、partial message）都要 yield 一次。

#### 8.6.2 Factory + Registry

`providers/factory.ts` 是一行 `getProviderFactory(name)(options)`。真正的注册在 `provider-registry.ts`，每个 provider 模块在文件末尾调 `registerProvider('claude', (opts) => new ClaudeProvider(opts))`（claude.ts:360）。`providers/index.ts` barrel 通过 import 触发副作用。

加新 provider 流程：建文件 → `registerProvider` → 在 `providers/index.ts` import。无需改 factory.ts。

#### 8.6.3 ClaudeProvider 关键点

`providers/claude.ts` 360 行。挑要紧的：

**Tool 允许清单（`:42-61`）**：硬编码内置 tool 名 + MCP server 名 → `mcp__<name>__*` 通配。不在清单上的 tool 被 SDK 静默丢弃，所以新增 MCP server 必须经过 `mcpAllowPattern` 模式转换。

**禁用清单（`:25-35`）**：CronCreate/Delete/List、ScheduleWakeup、AskUserQuestion、EnterPlanMode、EnterWorktree 等。原因：要么 nanoclaw 自己有等价物（schedule_task、ask_user_question MCP 工具），要么 SDK 内置实现在 headless 容器里会挂死。`preToolUseHook` 在 SDK 试图调这些时返回 `decision: 'block'`，给 agent 一句"use the nanoclaw equivalent"提示。

**`MessageStream` 类（`:80-112`）**：手写的 push-based async iterable，把 `query.push(text)` 转成 SDK 期待的 `SDKUserMessage` 流。`end()` 通过设 `done=true` + resolve 等待 promise 让 iterator 退出。

**ToolUse hook + container_state**：`preToolUseHook` 把当前 tool 名和 declared timeout（Bash tool input 里的 `timeout` 字段）写进 `outbound.db.container_state`。host-sweep 看到 Bash 在跑且声明超时 30 分钟，就把 stuck tolerance 放宽到 30 分钟（第 10 章）。`postToolUseHook` 清空。这一对 hook 是 host-sweep 的"我现在合理地慢"的信号。

**PreCompact hook**：把待 compact 的 transcript 解析成 markdown，存到 `/workspace/agent/conversations/<date>-<summary>.md`。这是 group memory 的另一面——`CLAUDE.local.md` 装短期、`conversations/` 装长期归档，agent 之后 grep 这个目录查历史。

**SDK 配置（`:286-313`）**：

```ts
const sdkResult = sdkQuery({
  prompt: stream,
  options: {
    cwd: input.cwd,
    additionalDirectories: this.additionalDirectories,
    resume: input.continuation,
    pathToClaudeCodeExecutable: '/pnpm/claude',
    systemPrompt: instructions
      ? { type: 'preset', preset: 'claude_code', append: instructions }
      : undefined,
    allowedTools: [...TOOL_ALLOWLIST, ...Object.keys(this.mcpServers).map(mcpAllowPattern)],
    disallowedTools: SDK_DISALLOWED_TOOLS,
    env: this.env,
    model: this.model,
    effort: this.effort,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project', 'user'],
    mcpServers: this.mcpServers,
    hooks: { /* PreToolUse, PostToolUse, PostToolUseFailure, PreCompact */ },
  },
});
```

- `resume: continuation`：让 SDK 沿用上一轮的 transcript .jsonl。
- `systemPrompt: { preset: 'claude_code', append: instructions }`：用 Claude Code 默认 system prompt + 追加我们的 addendum（agent 身份 + destination list）。
- `permissionMode: 'bypassPermissions'`、`allowDangerouslySkipPermissions: true`：容器是 isolation 边界，agent 在里面跑啥 host 不审批，所以禁用 permission prompt。
- `settingSources: ['project', 'user']`：让 SDK 读 `/workspace/agent/.claude/`（project）和 `/home/node/.claude/`（user）里的 settings——这就是为什么 group_init 写的 `settings.json`（注册 PreCompact hook）能起作用。

**Event 翻译（`:318-346`）**：把 SDK 自然事件翻成 nanoclaw `ProviderEvent`。每个 SDK message 触发一次 `{ type: 'activity' }`——保证 poll-loop 的 `touchHeartbeat()` 一直被调到。

**`isSessionInvalid` 与 stale-session 恢复（`:251-278`）**：

```ts
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

isSessionInvalid(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return STALE_SESSION_RE.test(msg);
}
```

poll-loop 在 catch 路径用这个判断——transcript 文件被删/丢失/损坏时 clear continuation，下一次重新开 session。

#### 8.6.4 Mock provider

`providers/mock.ts`（77 行）：纯测试 stub。`MessageStream` 等价物 inline 实现，每个 push/prompt 都 yield 一个 result event。`responseFactory` 默认返回 `"Mock response to: <prompt slice>"`。

#### 8.6.5 OpenCode / 其它 provider

v2.0.64 的 repo 里 `providers/` 目录除了 claude/mock 还可能有 opencode（参见 `src/providers/` 在 host 端的对应 contribution）；container 端的 `providers/index.ts` barrel 决定 import 哪些。这是热插拔点：构建时按需裁掉某些 provider 模块，对应 import 消失即可。

---

### 8.7 `bun:sqlite` 与 better-sqlite3 的差异

`db/connection.ts:20` `import { Database } from 'bun:sqlite'`。container 端用 bun 内置的 sqlite，与 host 端的 `better-sqlite3` 行为差几处，踩过坑：

1. **named params 必须带 `$` 前缀**：`db/messages-out.ts:60-74` 显示 SQL 写 `$id`、`$seq` 等；JS 对象的 key 也必须是 `$id`、`$seq`。better-sqlite3 自动 strip `$`、`@`、`:` 前缀，bun:sqlite 不会。注释（`:57-58`）专门标注。
2. **journal_mode**：`getOutboundDb()` 显式设 `PRAGMA journal_mode = DELETE`——和 host 端约定一致。
3. **测试用 `bun:test`**：连接层 `:179-254` 给了 `initTestSessionDb()`，让 in-memory `:memory:` 数据库走同一 schema；测试用 `bun:test` 而非 vitest。

`mmap_size = 0` + `busy_timeout = 5000` 在 inbound 两条路径（短连接 + 长单例）都设了——一致行为。

---

### 8.8 Heartbeat

`touchHeartbeat()`（`db/connection.ts:152-168`）：

```ts
export function touchHeartbeat(): void {
  const p = _heartbeatPath;
  const now = new Date();
  try {
    fs.utimesSync(p, now, now);
  } catch {
    try { fs.writeFileSync(p, ''); } catch { /* silently ignore */ }
  }
}
```

文件即心跳，**不写 DB**。两个理由：

1. 跨 mount DB 写很重（journal create/unlink、fsync）；
2. 单纯 utime 几乎零开销，host 一个 `fs.statSync(p).mtimeMs` 就能读。

调用点：`processQuery` 的 for-await 循环里每个 SDK event 触发（`poll-loop.ts:361`）。也就是说**只要 SDK 在产事件，heartbeat 就更新**——tool 调用、thinking、message stream 都算。SDK 卡死（API 一直没响应）时 heartbeat 也会停。host-sweep 的 ceiling 检查（`heartbeat_age > max(30min, current_bash_timeout)`）就是兜底。

`heartbeatPath` 是 `/workspace/.heartbeat`，agent-runner 启动时不预创建（spawn 前 host 已经 `rm -f` 过；container 第一次 touch 才会出现）。

---

### 8.9 MCP 工具一览

`mcp-tools/` 目录是 agent 在容器内可调的所有"动作"，按模块分文件，barrel 在 `mcp-tools/index.ts`：

```ts
import './core.js';
import './scheduling.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
import { startMcpServer } from './server.js';
```

每个文件用 `registerTools([...])` 自注册。简表（仅工具名 + 一行用途；具体细节留给后续章节）：

| 文件 | Tool | 用途 |
|------|------|------|
| `core.ts` | `send_message` | 中途发消息（不等到 final result） |
| `core.ts` | `send_file` | 发附件（写 outbox/<id>/） |
| `core.ts` | `edit_message` | 编辑已发出消息（按 seq 查 platform_message_id） |
| `core.ts` | `add_reaction` | 加 emoji 反应 |
| `scheduling.ts` | `schedule_task` | 写 messages_in 一个未来时间的 task 行，自唤醒 |
| `scheduling.ts` | `list_tasks` | 查未完成的 task |
| `scheduling.ts` | `update_task` / `cancel_task` / `pause_task` / `resume_task` | 任务管理 |
| `interactive.ts` | `ask_user_question` | 写 pending_questions 行 + 阻塞等回答（findQuestionResponse 轮询） |
| `interactive.ts` | `send_card` | 发交互式 approval card |
| `agents.ts` | `create_agent` | 新建一个 agent group（自我繁殖） |
| `self-mod.ts` | `install_packages` | 提 apt/npm 安装请求（写 pending_approvals，需 admin 同意） |
| `self-mod.ts` | `add_mcp_server` | 加 MCP server（同样走审批 + 重启容器） |

每个 tool 的 instructions 文件（`<name>.instructions.md`）通过 `claude-md-compose.ts` 拼到 `/workspace/agent/CLAUDE.md`——agent 看 CLAUDE.md 就知道"我有哪些工具、什么时候用"。

工具实现都很短（120-300 行），主要是参数校验 + 写表 + 返回 `ok()`/`err()` 字符串。深入留给第 12 章（scheduling）、第 13 章（self-mod）、第 14 章（interactive）。

---

### 8.10 PreCompact hook 的 instruction 注入

`compact-instructions.ts`（34 行）：

```ts
import { getAllDestinations } from './destinations.js';

const destinations = getAllDestinations();
const names = destinations.map((d) => d.name);

const instructions = [
  'Preserve the following in the compaction summary:',
  '',
  '1. For recent messages, keep the full XML structure including all attributes:',
  '   - <message from="..." sender="..." time="..."> for chat messages',
  '   - <task from="..." time="..."> for scheduled tasks',
  '   - <webhook from="..." source="..." event="..."> for webhooks',
  '   The message content can be summarized if long, but the XML tags and attributes must remain.',
  '',
  '2. Preserve the chronological message/reply sequence of recent exchanges.',
  '   The agent needs to see: who said what, in what order, and from which destination.',
  '',
  '3. At the END of the compaction summary, include this verbatim reminder:',
  '   "You MUST wrap all responses in <message to="name">...</message> blocks.',
  `   Available destinations: ${names.length > 0 ? names.map((n) => `\`${n}\``).join(', ') : '(none)'}."`,
];
console.log(instructions.join('\n'));
```

它是个一次性脚本，由 `.claude-shared/settings.json` 的 PreCompact hook 触发：

```json
{ "type": "command", "command": "bun /app/src/compact-instructions.ts" }
```

stdout 被 Claude Code 当作 `customInstructions` 喂给 compaction prompt。**作用**：context 压缩时不让 LLM 丢掉路由元数据（`<message from=>`、destination 列表）。没这步，long session 在 auto-compact 之后 agent 会"忘了"自己有几个 destination、不再 wrap `<message to=>`，回复永远进 scratchpad，用户什么都收不到。

`group_init.ts:9-32` 创建 `.claude-shared/settings.json` 时直接把这个 hook 写进去；`ensurePreCompactHook`（`group-init.ts:112-133`）对老 group 兜底补丁。

---

### 8.11 Session state

`db/session-state.ts`（80 行）是 outbound.db 里的 K/V 表，键是 `continuation:<provider>`。两条说明：

1. **per provider**：切 provider（Claude → Codex）不会拿对方的 thread id。注释（`:1-11`）反复强调"continuations are provider-private"。
2. **legacy 迁移**：v2 早期所有 provider 共用 `sdk_session_id`，现在 `migrateLegacyContinuation` 在 runner 启动时跑一次，把 legacy 行删掉、按当前 provider 收编。

可以扩展（`session_state` 是通用 K/V）：modal answer、interrupted state、用户偏好的"暗号"等都能存这里——但 v2.0.64 只用了 continuation。

---

### 8.12 退出

#### 8.12.1 自然结束

poll loop 是 `while (true)`，**理论上不会自然结束**——只有进程被 kill 才停。所以"自然结束"实际上是这样：

- 一段时间没消息（host-sweep 决定）→ host 决定"够久 idle 了"→ `killContainer(session)` → SIGTERM → tini → bun → process exits → host close 事件清表。

`spawnContainer` 没装 host-side idle timer（注释 `:172-175`），所以何时 kill 完全由 host-sweep 综合 heartbeat + processing_ack age 决定。这个判断在第 10 章详谈。

#### 8.12.2 SIGTERM grace

`docker stop -t 1` 给 1 秒 grace。bun 接到 SIGTERM 后：

- 中断 `await sleep(...)` / `for await` 抛 AbortError；
- 已经在 fly 的 SQLite write 跑完（DELETE 模式 journal 同步）；
- process exit。

container 端**没有显式 SIGTERM handler**——靠 SQLite write 的原子性 + DELETE journal 的 fsync 保证一致性。如果 bun 自己 1 秒没退出，tini 会发 SIGKILL，那一笔 in-flight 的 outbound write 可能丢一半 journal——下次 host 读 outbound.db 时 SQLite 会自动 rollback 那笔事务（journal 文件未被 unlink → 视为未提交）。所以即使被 SIGKILL，最坏情况是丢最后一条没写完的消息，不会让 DB 损坏。

#### 8.12.3 fatal error

`index.ts:106` 的 `main().catch(...)` 打 fatal log 后 `process.exit(1)`。tini 收到 child exit 自己退；host close 事件清表 + markContainerStopped。下次有消息再 spawn 新容器——上一次的 continuation 还在 outbound.db 里，agent 自动续上。

---

### 8.13 关键观察总结

回顾本章的设计选择，几个原则贯穿始终：

1. **DB 即 IPC**：host 和 container 之间没有 socket、没有 stdin、没有 IPC 文件，所有通信经过 inbound.db / outbound.db。这让 container crash、host crash、network 中断都成了"无状态 replay"。
2. **短连接读 host-owned DB，长连接写自有 DB**：跨 mount 的可见性靠 connection close 触发 page cache invalidation。同样的 SQLite，因为读写者不同处理方式截然不同。
3. **stream 不轻易关**：避免 SDK subprocess 重启；prompt cache 由服务器侧 5 分钟 TTL 管，stream 状态无影响。"stuck"检测下放到 host-sweep。
4. **`<message to=>` 强制 wrap**：唯一的"是否要发给用户"信号。Agent 偷懒 → nudge 一次。Wrap 协议同时是 routing 协议（按 destination 名查 channel）。
5. **continuation 早写晚读**：init 一拿到立刻 setContinuation，所以 mid-turn crash 也保得住。读则要小心 stale，靠 `isSessionInvalid` + STALE_SESSION_RE 兜底。
6. **heartbeat 是文件而不是 DB 行**：跨 mount utime 几乎零成本，比 DB write 便宜两个量级。

下一章我们走到管道的另一头——host 怎么从 outbound.db 取消息、按 channel 分发回去、处理 retry。
