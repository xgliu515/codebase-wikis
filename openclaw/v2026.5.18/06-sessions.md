# 第 06 章 会话与对话状态

> 代码版本锁定：`openclaw/openclaw@50a2481652`（tag `v2026.5.18`，2026-05-18）。
> 本章所有 `file:line` 引用均为仓库根相对路径。

## 0. 本章要解决的问题

第 05 章把一条入站消息收敛成了 `FinalizedMsgContext`，并在
`dispatchReplyFromConfig()` 里通过 `resolveSessionStoreEntry()` 找到了它对应
的会话条目。本章接着回答：

> 一个 LLM 助手要在多轮对话里保持记忆、保持模型/provider 选择、保持工具
> 策略，这些状态存在哪里、长什么样、如何被加载和保存、并发写如何不冲突、
> 对话太长怎么办？

OpenClaw 的会话状态被刻意拆成**两层物理存储**，这是理解整章的总纲：

```
┌─────────────────────────────────────────────────────────────┐
│  会话存储 (session store)                                     │
│  一个 JSON 文件: <stateDir>/agents/<agentId>/sessions/        │
│                  sessions.json                               │
│  内容: { sessionKey -> SessionEntry }                         │
│  角色: 「目录」/「路由表」——轻量元数据，频繁读写              │
│         模型选择、token 计数、路由、压缩标记、生命周期戳      │
└────────────────────────┬────────────────────────────────────┘
                         │ SessionEntry.sessionId + sessionFile
                         │ 指向 ↓
┌────────────────────────▼────────────────────────────────────┐
│  会话转录 (session transcript)                                │
│  每个会话一个 JSONL 文件:                                     │
│    <...>/sessions/<sessionId>.jsonl                           │
│  内容: 逐行 JSON——一个 session 头 + 若干 message 条目         │
│  角色: 「正文」——完整的对话消息历史，只追加                   │
└──────────────────────────────────────────────────────────────┘
```

为什么要分两层？因为两类数据的访问模式截然不同。**元数据**（当前用哪个
模型、token 用了多少、上次从哪个渠道来）很小、需要频繁随机读写、需要被
整体加载来做维护（裁剪、清理）；**对话正文**很大、只追加、极少需要整体
读取。把它们塞进一个文件，每次更新一个 token 计数就要重写整个对话历史，
代价不可接受。于是：元数据进一个 `sessions.json`（按会话键索引的字典），
正文每会话一个 `.jsonl`（只追加日志）。

> 关于格式：本章描述的是 `v2026.5.18` 代码的真实情况——会话存储是 **JSON**
> （`src/config/sessions/store.ts:374` 的 `JSON.stringify(store, null, 2)`），转录是 **JSONL**
> （`src/config/sessions/transcript-append.ts:310` 的 `fs.appendFile(..., JSON.stringify(entry))`）。
> 代码库中并不使用 YAML 来持久化会话。

涉及的核心文件：

| 关注点 | 文件 |
|--------|------|
| `SessionEntry` 等类型 | `src/config/sessions/types.ts` |
| 模块门面 | `src/config/sessions.ts` |
| 存储读 | `src/config/sessions/store-load.ts` |
| 存储写 / 维护 | `src/config/sessions/store.ts` |
| 写串行化队列 | `src/config/sessions/store-writer.ts` |
| 读缓存 | `src/config/sessions/store-cache.ts` |
| 键归一与查找 | `src/config/sessions/store-entry.ts` |
| 路径解析 | `src/config/sessions/paths.ts` |
| 转录追加 | `src/config/sessions/transcript.ts`、`transcript-append.ts` |
| 元数据派生 | `src/config/sessions/metadata.ts` |
| 生命周期 | `src/config/sessions/lifecycle.ts`、`reset.ts` |
| 压缩检查点 | `src/gateway/session-compaction-checkpoints.ts` |
| 多 agent 合并视图 | `src/config/sessions/combined-store-gateway.ts` |

`src/config/sessions.ts`（19 行）是一个 barrel 门面，`export *` 了
`store`/`types`/`transcript`/`paths`/`metadata`/`lifecycle` 等所有子模块。
下游代码统一从 `../config/sessions.js` 导入，不直接耦合内部文件布局。

---

## 1. `SessionEntry`：一个会话的元数据

`SessionEntry` 定义在 `src/config/sessions/types.ts:174-323`。它是会话存储
里一个会话桶的全部元数据。约 150 个字段，初看吓人，但按职责分组后脉络清晰。

### 1.1 身份与文件指针

```typescript
// src/config/sessions/types.ts:196
sessionId: string;          // 会话的稳定 id（UUID），转录文件名据此生成
updatedAt: number;          // 最近活动时间戳（ms）
sessionFile?: string;       // 转录文件路径（相对 sessions 目录）
sessionStartedAt?: number;  // 当前 sessionId 首次激活的时间（:225）
```

这是连接两层存储的纽带。`sessionId`（`:196`）是 `SessionEntry` 与 `.jsonl`
转录文件之间的唯一关联键——转录文件名就是 `<sessionId>.jsonl`（§3.1）。
`sessionFile`（`:198`）是一个可选的显式路径缓存。

注意**会话键**（`sessions.json` 字典的 key，如 `agent:main:main`）和
**`sessionId`**（UUID）是两个不同的东西。前者是路由用的逻辑标识，稳定地指向
「这个对话桶」；后者是某一段转录的物理标识。一次会话 reset 会换一个新的
`sessionId`（开一个新转录文件），但会话键不变——同一个对话桶换了新的「本子」。
`sessionStartedAt`（`:225`）只在 `sessionId` 轮换时刷新。

### 1.2 路由与来源

```typescript
// src/config/sessions/types.ts
channel?: string;                 // :88
groupId?: string; subject?: string; groupChannel?: string; space?: string;  // :89-92
origin?: SessionOrigin;           // :93
deliveryContext?: DeliveryContext;// :94
lastChannel?: SessionChannelId;   // :95  上次回复用的渠道
lastTo?: string;                  // :96
lastAccountId?: string;           // :97
lastThreadId?: string | number;   // :98
```

`SessionOrigin`（`src/config/sessions/types.ts:15-26`）记录会话「从哪来」——provider/surface/
chatType/from/to/nativeChannelId/threadId。`last*` 字段记录「上次回复送去
哪」，使助手即便在没有当前入站消息的情况下（如定时心跳）也知道往哪发。
这一组字段由 `recordSessionMetaFromInbound()` 在每条入站消息时刷新（§5）。

### 1.3 模型 / provider / agent 路由

```typescript
// src/config/sessions/types.ts
modelProvider?: string;        // :62  当前运行时 provider
model?: string;                // :63  当前运行时 model
providerOverride?: string;     // :7   用户/会话级 provider 覆盖
modelOverride?: string;        // :8   用户/会话级 model 覆盖
modelOverrideSource?: "auto" | "user";  // :16
agentRuntimeOverride?: string; // :10  会话级 agent harness 覆盖
agentHarnessId?: string;       // :69  本会话 id 绑定的 harness
authProfileOverride?: string;  // :20
authProfileOverrideSource?: "auto" | "user";  // :21
liveModelSwitchPending?: boolean;  // :30
```

这里有两组字段，区分非常重要：

- `modelProvider`/`model`（`:62-63`）是**当前实际运行**的 provider/model。
- `modelOverride`/`providerOverride`（`:7-8`）是**会话级覆盖意图**。

`modelOverrideSource`（`src/config/sessions/types.ts:11-16` 的注释）区分这个覆盖来自用户显式动作
（`/model` 命令、`sessions.patch`）还是来自运行时临时回退（fallback）。这个
区分有实际后果：会话 reset 时**只保留用户驱动的覆盖**，自动回退产生的覆盖会
被丢弃——你手动选的模型 reset 后仍在，但因限流临时换的模型会归位。

`agentHarnessId`（`src/config/sessions/types.ts:64-69` 注释）把一个 agent 运行时 harness 钉死到
某个 `sessionId`，防止配置/环境变化把一段已有转录搬到不兼容的 harness 上。

`liveModelSwitchPending`（`src/config/sessions/types.ts:23-30` 注释）是一个微妙的并发标记：当
用户在 agent **正在运行**时改了模型，这个标记被置位，嵌入式运行器据此抛出
`LiveSessionModelSwitchError`；而系统发起的回退轮换**绝不**置这个标记，所以
永远不会被误判为用户切换。

### 1.4 token 计数与成本

```typescript
// src/config/sessions/types.ts
inputTokens?: number; outputTokens?: number; totalTokens?: number;  // :38-40
totalTokensFresh?: boolean;   // :58
estimatedCostUsd?: number;    // :59
cacheRead?: number; cacheWrite?: number;  // :60-61
contextTokens?: number;       // :77
```

`totalTokensFresh`（`src/config/sessions/types.ts:53-58` 注释）值得一提：它标记 `totalTokens`
是否反映了最新一次运行的新鲜上下文快照。`undefined` 表示「旧版/未知新鲜度」，
`false` 则强制消费者把 `totalTokens` 当作陈旧/未知。`resolveSessionTotalTokens()`
（`src/config/sessions/types.ts:277`）返回原始值，`resolveFreshSessionTotalTokens()`（`:287`）
在 `totalTokensFresh === false` 时返回 `undefined`——上下文利用率显示用后者，
避免显示一个不可信的旧数字。

### 1.5 压缩标记

```typescript
// src/config/sessions/types.ts
compactionCount?: number;                              // :78
compactionCheckpoints?: SessionCompactionCheckpoint[]; // :79
memoryFlushAt?: number;                                // :80
memoryFlushCompactionCount?: number;                   // :81
memoryFlushContextHash?: string;                       // :82
```

`compactionCount` 是这个会话被压缩过几次。`compactionCheckpoints` 是压缩
检查点数组（§6）。`memoryFlush*` 字段配合记忆刷写。

### 1.6 行为开关与队列

```typescript
// src/config/sessions/types.ts
thinkingLevel?: string; fastMode?: boolean; verboseLevel?: string;  // :250-252
traceLevel?: string; reasoningLevel?: string; elevatedLevel?: string;  // :253-255
ttsAuto?: TtsAutoMode;            // :256
groupActivation?: "mention" | "always";  // :31
sendPolicy?: "allow" | "deny";    // :33
queueMode?: "steer" | "followup" | "collect" | "interrupt";  // :34
queueDebounceMs?: number; queueCap?: number;  // :35-36
queueDrop?: "old" | "new" | "summarize";       // :37
execHost?: string; execSecurity?: string; execAsk?: string;  // :2-4
```

这些是**持久化**到会话的行为设置。对比第 05 章 `GetReplyOptions` 里
`thinkingLevelOverride`/`fastModeOverride` 那些「一次性、不持久化」的覆盖——
这里的 `thinkingLevel`/`fastMode` 是会话长期记住的。`/think`、`/fast`、
`/verbose` 之类命令改的就是这些字段。

### 1.7 子代理、ACP、配额、心跳

`SessionEntry` 还容纳多种特殊会话类型的状态：

- **子代理**（`src/config/sessions/types.ts:199-222`）：`spawnedBy`/`spawnedWorkspaceDir`/
  `parentSessionKey`/`spawnDepth`/`subagentRole`/`inheritedToolDeny`/
  `inheritedToolAllow`/`subagentRecovery`。
- **ACP**（`src/config/sessions/types.ts:106` 的 `acp?: SessionAcpMeta`，类型定义在 `:41-52`）：
  外部 agent 控制协议会话的运行时元数据。
- **配额挂起**（`src/config/sessions/types.ts:224` 的 `quotaSuspension?: QuotaSuspension`，
  类型 `:158-172`）：配额耗尽时的级联保护状态机。
- **心跳**（`src/config/sessions/types.ts:179-189`）：`lastHeartbeatText`/`heartbeatTaskState`/
  `heartbeatIsolatedBaseSessionKey`。
- **待投递重试**（`src/config/sessions/types.ts:42-52`）：`pendingFinalDelivery*` 系列，标记
  最终回复尚需重试投递，并冻结回复文本和投递上下文。

### 1.8 插件扩展槽

```typescript
// src/config/sessions/types.ts:190
pluginExtensions?: Record<string, Record<string, SessionPluginJsonValue>>;
pluginExtensionSlotKeys?: Record<string, Record<string, string>>;       // :193
pluginNextTurnInjections?: Record<string, SessionPluginNextTurnInjection[]>;  // :195
pluginDebugEntries?: SessionPluginDebugEntry[];  // :105
```

插件不能往 `SessionEntry` 上随意加字段（那会污染核心类型），而是把状态写进
`pluginExtensions` ——按 `pluginId` 再按命名空间分组的 JSON 值袋
（`SessionPluginJsonValue` 是一个递归 JSON 类型，`src/config/sessions/types.ts:117-123`）。
`pluginNextTurnInjections`（`:125-135`）让插件能往下一回合的提示词里塞一次性
文本。这是一个隔离设计：插件状态与核心状态在同一个 `SessionEntry` 里物理
共存，但命名空间上彼此隔离。

### 1.9 `SessionEntry` 的合并语义

`SessionEntry` 几乎从不被整体替换，而是被**补丁合并**。
`mergeSessionEntryWithPolicy()`（`src/config/sessions/types.ts:224-259`）是核心：

```typescript
// src/config/sessions/types.ts:224
export function mergeSessionEntryWithPolicy(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
  options?: MergeSessionEntryOptions,
): SessionEntry {
  const sessionId = patch.sessionId ?? existing?.sessionId ?? crypto.randomUUID();
  const updatedAt = resolveMergedUpdatedAt(existing, patch, options);
  if (!existing) {
    return normalizeSessionRuntimeModelFields({
      ...patch, sessionId, updatedAt,
      sessionStartedAt: patch.sessionStartedAt ?? updatedAt,
    });
  }
  const next = { ...existing, ...patch, sessionId, updatedAt, /* :244 */ };
  // 防止「补丁了 model 但没补丁 provider」导致陈旧 provider 残留
  if (Object.hasOwn(patch, "model") && !Object.hasOwn(patch, "modelProvider")) {
    const patchedModel = normalizeOptionalString(patch.model);
    const existingModel = normalizeOptionalString(existing.model);
    if (patchedModel && patchedModel !== existingModel) {
      delete next.modelProvider;     // :255
    }
  }
  return normalizeSessionRuntimeModelFields(next);
}
```

两个值得注意的设计：

1. **provider 陈旧防护**（`:251-257`）。如果补丁只改了 `model` 没改
   `modelProvider`，且新 model 与旧不同，就**删掉** `modelProvider`——因为
   旧 provider 配新 model 很可能是错的组合。`normalizeSessionRuntimeModelFields()`
   （`:142-180`）进一步保证 `model` 为空时连带清掉 `modelProvider`。

2. **合并策略**。`SessionEntryMergePolicy`（`src/config/sessions/types.ts:196`）有两种：
   `"touch-activity"`（默认，`resolveMergedUpdatedAt` 取
   `max(existing, patch, now)`，`:203-215`）刷新活动时间；
   `"preserve-activity"`（保留旧 `updatedAt`）。后者用于**入站元数据更新**
   ——`recordSessionMetaFromInbound` 用它（见 §5），因为单纯记录「消息从
   哪来」不应被算作一次真实的会话活动，否则会干扰基于 `updatedAt` 的空闲
   reset 判定。

---

## 2. 会话存储：`sessions.json` 的组织、加载与保存

### 2.1 路径布局

会话存储路径由 `src/config/sessions/paths.ts` 解析。

```typescript
// src/config/sessions/paths.ts:10
function resolveAgentSessionsDir(agentId?, env, homedir): string {
  const root = resolveStateDir(env, homedir);
  const id = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
  return path.join(root, "agents", id, "sessions");
}
```

布局是 `<stateDir>/agents/<agentId>/sessions/`。这个目录里有：

- `sessions.json` —— 会话存储（`resolveDefaultSessionStorePath()`，`src/config/sessions/paths.ts:35`）。
- `<sessionId>.jsonl` —— 各会话的转录文件。
- `<sessionId>-topic-<topicId>.jsonl` —— 线程/topic 会话的转录
  （`resolveSessionTranscriptPathInDir()`，`src/config/sessions/paths.ts:240-257`）。
- 归档/检查点产物（§6）。

**每个 agent 一套独立目录**——这是 OpenClaw 多 agent 设计的体现。
`resolveStorePath()`（`src/config/sessions/paths.ts:284`）还支持 `{agentId}` 模板占位符和
`~` 家目录前缀的自定义路径。

`validateSessionId()`（`src/config/sessions/paths.ts:64-73`）用正则
`SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i`（`:62`）校验
`sessionId`，并拒绝形如压缩检查点文件名的 id——这是防路径穿越攻击：
`sessionId` 会被直接拼进文件名，必须严格白名单。

`resolveSessionFilePath()`（`src/config/sessions/paths.ts:267`）和它依赖的
`resolvePathWithinSessionsDir()`（`src/config/sessions/paths.ts:176-238`）做了大量**容器化校验**：
解析出的路径必须在 sessions 目录之内（`normalized.startsWith("..")` 检查，
`:234`），并对旧版本存的绝对路径做兼容性转换。又一道安全边界。

### 2.2 加载：`loadSessionStore`

`loadSessionStore()` 在 `src/config/sessions/store-load.ts:324`。流程：

```
loadSessionStore(storePath)
  │
  ├─ 缓存命中? (store-cache, 默认 TTL 45s, 校验 mtime+size)
  │    └─ 是 → 直接返回缓存的 store 记录
  │
  ├─ fs.readFileSync(storePath, "utf-8")        :351
  │    (Windows 上空文件/瞬时无效会重试最多 3 次, :43-47)
  │
  ├─ JSON.parse(raw)                            :356
  │
  ├─ applySessionStoreMigrations(store)         :49  旧格式迁移
  ├─ normalizeSessionStore(store)               :50  归一
  │
  ├─ opts.runMaintenance? → 裁剪/封顶 (§2.5)    :54-88
  │
  └─ 写回缓存, 返回 store
```

关键点：

- **读缓存**。`store-cache.ts` 维护一个带 TTL 的 Map 缓存
  （`SESSION_STORE_CACHE`，`src/config/sessions/store-cache.ts:13`），默认 TTL 45 秒
  （`DEFAULT_SESSION_STORE_TTL_MS`，`:11`，可由
  `OPENCLAW_SESSION_CACHE_TTL_MS` 环境变量覆盖）。缓存条目带
  `mtimeMs`/`sizeBytes`（`src/config/sessions/store-cache.ts:4-9`）——读时用文件 stat 校验，
  文件变了就失效。`src/config/sessions/store-load.ts:329-338` 在 `skipCache` 未设且缓存启用时
  优先走缓存。这避免了高频入站消息每条都全量读盘解析 JSON。
- **同步读**。`loadSessionStore` 是**同步**函数（`fs.readFileSync`）。会话
  存储通常不大（最多几百个条目），同步读简化了大量调用点。
- **Windows 重试**（`src/config/sessions/store-load.ts:42-47`）：另一个进程正在原子换文件时，
  读者可能短暂看到空文件，故重试。

### 2.3 序列化与原子写

保存路径在 `src/config/sessions/store.ts`。`saveSessionStoreUnlocked()`
（`src/config/sessions/store.ts:228`）最后：

```typescript
// src/config/sessions/store.ts:373
await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
const json = JSON.stringify(store, null, 2);
if (getSerializedSessionStore(storePath) === json) {
  updateSessionStoreWriteCaches({ storePath, store, serialized: json });
  return;   // 内容未变, 跳过写盘
}
// ... writeSessionStoreAtomic(...)
```

三个设计：

1. **JSON 缩进 2 空格**（`:374`）。人类可读，便于调试。
2. **内容去重**（`:375-378`）。如果序列化后与上次写盘内容字节一致，直接
   跳过写盘——只更新内存缓存。
3. **原子写**。`writeSessionStoreAtomic()`（`src/config/sessions/store.ts:521-532`）调用
   `writeTextAtomic()`（`src/infra/json-files.js`），它写临时文件再 rename。
   rename 在 POSIX 上是原子的，保证读者永远看到完整文件，不会读到写一半的
   状态。`mode: 0o600`（`:526`）——会话数据含敏感信息，只对属主可读写。
   Windows 上 rename 可能因读者持锁失败，故有 5 次重试（`src/config/sessions/store.ts:386-399`）。

### 2.4 写串行化：`store-writer`

会话存储是单个文件，多个并发写会互相覆盖。`src/config/sessions/store-writer.ts`
用一个**按 storePath 的串行队列**解决：

```typescript
// src/config/sessions/store-writer.ts:72
export async function runExclusiveSessionStoreWrite<T>(
  storePath: string, fn: () => Promise<T>,
): Promise<T> {
  const queue = getOrCreateWriterQueue(storePath);   // 每个 storePath 一个队列
  const promise = new Promise<T>((resolve, reject) => {
    const task = { fn: async () => await fn(), resolve, reject };
    queue.pending.push(task);                        // 入队
    void drainSessionStoreWriterQueue(storePath);    // 触发排空
  });
  return await promise;
}
```

`drainSessionStoreWriterQueue()`（`src/config/sessions/store-writer.ts:24-70`）逐个执行 `pending`
里的任务，**严格串行**——前一个 await 完才取下一个。所有写路径
（`saveSessionStore`、`updateSessionStore`、`updateSessionStoreEntry`、
`updateLastRoute`）都包在 `runExclusiveSessionStoreWrite` 里。

`updateSessionStore()`（`src/config/sessions/store.ts:437-453`）是典型的 read-modify-write：

```typescript
// src/config/sessions/store.ts:437
export async function updateSessionStore<T>(storePath, mutator, opts): Promise<T> {
  return await runExclusiveSessionStoreWrite(storePath, async () => {
    const store = loadMutableSessionStoreForWriter(storePath);  // 队列内读最新
    const previousAcpByKey = collectAcpMetadataSnapshot(store);
    const result = await mutator(store);                        // 调用方改 store
    preserveExistingAcpMetadata({ previousAcpByKey, nextStore: store, ... });
    await saveSessionStoreUnlocked(storePath, store, opts);     // 写回
    return result;
  });
}
```

因为读、改、写**整体**在队列任务内执行，不会有别的写穿插，read-modify-write
是原子的。`loadMutableSessionStoreForWriter()`（`src/config/sessions/store.ts:155`）在队列内
拿到一份可变 store 副本。

`preserveExistingAcpMetadata()`（`src/config/sessions/store.ts:200-226`）：mutator 可能粗心地丢掉
ACP 元数据，这里在写回前把它补救回来——一个针对易错点的防护。

### 2.5 加载/保存时的维护

`saveSessionStoreUnlocked()`（`src/config/sessions/store.ts:228-426`）在写盘前会跑**会话维护**
（除非 `opts.skipMaintenance`）。维护配置由 `resolveMaintenanceConfig()` 给出，
默认值在 `store-maintenance.ts`：

```typescript
// src/config/sessions/store-maintenance.ts
const DEFAULT_SESSION_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;  // :20  30 天
const DEFAULT_SESSION_MAX_ENTRIES = 500;                          // :21
const DEFAULT_SESSION_MAINTENANCE_MODE = "enforce";               // :22
```

维护做三件事（`src/config/sessions/store.ts:286-371`）：

1. **`pruneStaleEntries`** —— 删掉超过 `pruneAfterMs`（默认 30 天）没更新的
   会话条目。
2. **`capEntryCount`** —— 条目数超过 `maxEntries`（默认 500）时删最旧的。
3. **`enforceSessionDiskBudget`** —— 转录文件磁盘占用超预算时清理。

被删条目对应的转录文件会被**归档**而非直接删除
（`archiveRemovedSessionTranscripts`，`src/config/sessions/store.ts:494`，§6.4）。
`activeSessionKey`（`opts.activeSessionKey`）始终被加入
`preserveKeys`（`collectSessionMaintenancePreserveKeys`，`src/config/sessions/store.ts:286`）——
**当前正在用的会话永远不会被维护清掉**。`mode: "warn"` 模式下只告警不实删
（`src/config/sessions/store.ts:250-285`）。`loadSessionStore` 也能在 `runMaintenance` 选项下做
轻量裁剪（`src/config/sessions/store-load.ts:54-88`）。

### 2.6 键归一与查找：`resolveSessionStoreEntry`

会话键随时间演进过（大小写、Signal 不透明 id），所以查找不能简单地
`store[key]`。`resolveSessionStoreEntry()`（`src/config/sessions/store-entry.ts:9-61`）做**容错
查找**：

```typescript
// src/config/sessions/store-entry.ts:9
export function resolveSessionStoreEntry(params: {
  store: Record<string, SessionEntry>; sessionKey: string;
}): { normalizedKey: string; existing: SessionEntry | undefined; legacyKeys: string[] }
```

它返回三样东西：规范化后的键、找到的条目、以及一组**旧键**（legacy keys）。
查找逻辑（`:33-55`）：先按规范键、再按大小写折叠键、再遍历整个 store 找
「归一后等价」的键；多个候选时取 `updatedAt` 最新的。所有非规范的等价键都
被收进 `legacyKeys`。

调用方（如 `persistResolvedSessionEntry`，`src/config/sessions/store.ts:534-548`）随后会把条目
写到 `normalizedKey` 下，并 `delete` 掉所有 `legacyKeys`——**写时顺手把旧键
迁移成规范键**。这是一个渐进式数据迁移：不需要一次性全量迁移，每个会话被
访问到时自然归一。

### 2.7 主会话别名

`src/config/sessions/main-session.ts` 处理「主会话」的多种别名。
`resolveMainSessionKey()`（`src/config/sessions/main-session.ts:14`）从配置算出主会话键
（`global` scope 下是 `"global"`，否则 `agent:<defaultAgentId>:<mainKey>`）。
`canonicalizeMainSessionAlias()`（`src/config/sessions/main-session.ts:47-84`）把
`"main"`、裸 `mainKey`、各种历史形态（包括 issue #29683 提到的硬编码
`agent:main:` 旧键）统统折叠到规范主会话键。这是为第 05 章 §4.1 的「直聊
折叠到主会话桶」兜底的归一层。

---

## 3. 会话转录：JSONL 消息历史

### 3.1 文件格式

转录文件是 **JSONL**——逐行 JSON。第一行是 session 头，之后每行一个条目。
头由 `ensureSessionHeader()`（`src/config/sessions/transcript.ts:37-57`）写入：

```typescript
// src/config/sessions/transcript.ts:46
const header = {
  type: "session",
  version: CURRENT_SESSION_VERSION,
  id: params.sessionId,
  timestamp: new Date().toISOString(),
  cwd: process.cwd(),
};
await fs.promises.writeFile(params.sessionFile, `${JSON.stringify(header)}\n`,
  { encoding: "utf-8", mode: 0o600 });
```

之后的每一行是一个 message 条目。`appendSessionTranscriptMessage()`
（`src/config/sessions/transcript-append.ts:254`）追加，条目形状（`src/config/sessions/transcript-append.ts:294-301`）：

```typescript
// src/config/sessions/transcript-append.ts:294
const entry = {
  type: "message",
  id: messageId,                                  // randomUUID
  ...(shouldRawAppend ? {} : { parentId: leafInfo.leafId ?? null }),
  timestamp: new Date(now).toISOString(),
  message: finalMessage,                          // 实际消息载荷
};
await fs.appendFile(params.transcriptPath, `${JSON.stringify(entry)}\n`, "utf-8");
```

`message` 字段里装的是 agent 消息——含 `role`（`user`/`assistant`）、
`content`、以及助手消息上的运行元数据：`provider`、`model`、`usage`
（input/output/cacheRead/cacheWrite/totalTokens/cost）、`stopReason`、
`timestamp`。`appendAssistantMessageToSessionTranscript()`
（`src/config/sessions/transcript.ts:205-261`）展示了一个完整的助手消息构造，含 `usage` 子对象
（`src/config/sessions/transcript.ts:238-251`）——这正是任务描述里说的「runId/model/finish_reason/
token 计数」这类运行记录在转录里的承载方式。

> 任务描述假设转录条目是 `SessionMessageEntry`/`SessionAgentRunEntry` 这样
> 具名的类型。在 `v2026.5.18` 代码里并不存在这两个具名类型——转录条目就是
> 上面 `{type, id, parentId, timestamp, message}` 这个内联结构，`message`
> 是来自 `@earendil-works/pi-agent-core` 的 `AgentMessage`。本节描述的是
> 代码真实形态。

### 3.2 父链接：从线性日志到树

早期转录是**线性**的（条目顺序即对话顺序）。新格式给每个 message 条目加了
`parentId`，让转录成为一棵**树**——支持分叉（会话 fork、压缩后的分支）。

`appendSessionTranscriptMessageLocked()`（`src/config/sessions/transcript-append.ts:54-77`）追加时：

1. `readTranscriptLeafInfo()`（`:42-88`）扫整个文件，找出当前**叶子条目**
   （最后一个带 `parentId` 的条目 id）、是否有父链接条目、非 session 条目数。
2. 若文件还是**线性**格式（有非 session 条目但没有 `parentId`，`:50`），
   且文件不太大，调用 `migrateLinearTranscriptToParentLinked()`（`:102`）
   **就地迁移**——给每个条目补 `parentId` 指向前一条。
3. 新条目的 `parentId` 设为当前叶子 id（`:296`），把它接到树的末端。

**例外**：若线性文件已经很大（超过 `SESSION_MANAGER_APPEND_MAX_BYTES`），
`shouldRawAppend` 为真（`:52-55`），跳过迁移、不加 `parentId` 直接追加——
避免为追加一条消息而重写一个巨大文件的性能灾难。这是「正确的数据结构」与
「写放大」之间的务实权衡。

### 3.3 转录写并发

转录追加也有并发保护，但比会话存储更精细：

- `withTranscriptAppendQueue()`（`src/config/sessions/transcript-append.ts:255`）—— 按
  `transcriptPath` 串行化追加。
- `acquireSessionWriteLock()`（`src/config/sessions/transcript-append.ts:56-60`）—— 一个**文件
  级写锁**，`allowReentrant: true`。这一层锁保护的是跨进程并发（gateway、
  CLI、daemon 可能同时写同一个转录）。

为什么转录用文件锁而会话存储用进程内队列？因为会话存储的写都集中在一个
进程的写路径里，进程内队列够用；转录则可能被多个 OpenClaw 进程同时追加，
需要 OS 级的文件锁。

### 3.4 幂等追加

`appendExactAssistantMessageToSessionTranscript()`（`src/config/sessions/transcript.ts:262`）支持
`idempotencyKey`：追加前用 `transcriptHasIdempotencyKey()`（`src/config/sessions/transcript.ts:108`）
检查同 key 是否已写过，已写就直接返回旧 messageId（`:110-116`）。这让投递
重试不会在转录里产生重复条目。它还有一个 `isRedundantDeliveryMirror` 检查
（`:118-123`）跳过冗余的「投递镜像」消息——`delivery-mirror`/`gateway-injected`
这类 `provider: "openclaw"` 的合成助手消息（`src/config/sessions/transcript.ts:111-119`）。

`SessionTranscriptUpdateMode`（`src/config/sessions/transcript.ts:63`，`"inline" | "file-only" |
"none"`）控制追加同时是否更新会话存储里的镜像/计数。

---

## 4. 会话生命周期与 reset

### 4.1 生命周期时间戳

`src/config/sessions/lifecycle.ts` 解析会话的生命周期时间。
`resolveSessionLifecycleTimestamps()`（`src/config/sessions/lifecycle.ts:93`）返回
`sessionStartedAt` 和 `lastInteractionAt`。`sessionStartedAt` 优先取
`SessionEntry.sessionStartedAt`，缺失时回退去**读转录文件第一行的 session
头时间戳**（`readSessionHeaderStartedAtMs()`，`src/config/sessions/lifecycle.ts:49-91`）：

```typescript
// src/config/sessions/lifecycle.ts:71
const firstLine = readFirstLine(sessionFile);   // 只读前 8KB, 取第一行
const header = JSON.parse(firstLine);
if (header.type !== "session") return undefined;
if (header.id !== sessionId) return undefined;  // 防串文件
return parseTimestampMs(header.timestamp);
```

`readFirstLine()`（`src/config/sessions/lifecycle.ts:29-47`）只读文件头 8192 字节——读一个开始
时间不需要整文件。这是「转录是只追加日志，头永远在最前」这一结构特性带来
的廉价读取。

### 4.2 reset 策略

`src/config/sessions/reset.ts` 与 `reset-policy.ts` 处理会话 reset——即换一个
新 `sessionId`、开一个新转录文件、把对话记忆清零。

`resolveSessionResetType()`（`src/config/sessions/reset.ts:27-43`）从会话键判定 reset 类型：
`"thread"`（线程会话）/`"group"`（群聊，键含 `:group:`/`:channel:`）/
`"direct"`。不同类型适用不同 reset 策略。`resolveChannelResetConfig()`
（`src/config/sessions/reset.ts:67-82`）支持按渠道配置 reset（`resetByChannel`）。

`reset.ts` 还再导出了 `reset-policy.ts` 的 `evaluateSessionFreshness()`、
`resolveDailyResetAtMs()`、`DEFAULT_RESET_AT_HOUR` 等（`src/config/sessions/reset.ts:8-18`）——
支持「每天定点 reset」之类的策略。reset 时旧转录文件会被归档（后缀
`.reset.<timestamp>`，§6.4），并按 §1.3 所述只保留用户驱动的模型覆盖。

---

## 5. 入站元数据回写：`recordSessionMetaFromInbound`

把第 05 章和本章接起来：每条入站消息处理时，`recordSessionMetaFromInbound()`
（`src/config/sessions/store.ts:577-623`）把 `MsgContext` 里的来源/路由信息回写进 `SessionEntry`：

```typescript
// src/config/sessions/store.ts:577
export async function recordSessionMetaFromInbound(params: {
  storePath: string; sessionKey: string; ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null; createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  return await updateSessionStore(storePath, (store) => {
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const patch = deriveSessionMetaPatch({          // metadata.ts:181
      ctx, sessionKey: resolved.normalizedKey,
      existing: resolved.existing, groupResolution: params.groupResolution,
    });
    if (!patch) { /* 仅做 legacy key 迁移 */ return resolved.existing ?? null; }
    const next = resolved.existing
      ? mergeSessionEntryPreserveActivity(resolved.existing, patch)  // :63
      : mergeSessionEntry(resolved.existing, patch);
    store[resolved.normalizedKey] = next;
    for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
    return next;
  }, { activeSessionKey: normalizeStoreSessionKey(sessionKey) });
}
```

`deriveSessionMetaPatch()`（`src/config/sessions/metadata.ts:181-203`）从 `MsgContext` 派生一个
补丁：`deriveSessionOrigin()`（`src/config/sessions/metadata.ts:54-113`）抽取 provider/surface/
chatType/from/to/threadId 等组成 `SessionOrigin`；群聊还会
`deriveGroupSessionPatch()`（`src/config/sessions/metadata.ts:122-179`）派生 channel/groupId/
subject/displayName。

注意它用 `mergeSessionEntryPreserveActivity`（§1.9）——入站元数据更新**不**
刷新 `updatedAt`，因为「记录消息来源」不算一次真实会话活动。注释
（`src/config/sessions/store.ts:60-62`）明确说明：空闲 reset 评估依赖来自真实会话回合的
`updatedAt`，元数据更新不能污染它。`updateLastRoute()`（`src/config/sessions/store.ts:624`）类似，
专门更新 `lastChannel`/`lastTo`/`deliveryContext` 等回复路由字段。

---

## 6. 上下文压缩与归档

### 6.1 为什么需要压缩

LLM 上下文窗口有限。一个长会话的转录会无限增长，迟早超出模型的上下文上限，
或者光是 token 成本就高得离谱。**压缩**（compaction）就是把一段长对话历史
浓缩成一段摘要，用摘要替代原始消息，从而把上下文 token 数压回可控范围。

### 6.2 压缩检查点

每次压缩会产生一个 `SessionCompactionCheckpoint`（类型在
`src/config/sessions/types.ts:98-110`）：

```typescript
// src/config/sessions/types.ts:98
export type SessionCompactionCheckpoint = {
  checkpointId: string;
  sessionKey: string;
  sessionId: string;
  createdAt: number;
  reason: SessionCompactionCheckpointReason;  // "manual"|"auto-threshold"|
                                              // "overflow-retry"|"timeout-retry"  (:85)
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
  firstKeptEntryId?: string;
  preCompaction: SessionCompactionTranscriptReference;   // 压缩前的转录引用
  postCompaction: SessionCompactionTranscriptReference;  // 压缩后的转录引用
};
```

`SessionCompactionTranscriptReference`（`src/config/sessions/types.ts:91-96`）= `sessionId` +
`sessionFile` + `leafId` + `entryId`。`pre`/`post` 两个引用让压缩**可追溯、
可回滚**：压缩前的完整转录被快照保留下来，检查点记录指向它的指针。

`reason` 的四种取值（`src/config/sessions/types.ts:85-89`）揭示了压缩的触发场景：手动
（`/compact`）、自动阈值（token 数到线）、溢出重试（一次请求 token 超限后
压缩重试）、超时重试。

### 6.3 检查点的持久化

压缩检查点存在 `SessionEntry.compactionCheckpoints` 数组里，由
`persistSessionCompactionCheckpoint()`（`src/gateway/session-compaction-checkpoints.ts:394`）
写入：

```typescript
// src/gateway/session-compaction-checkpoints.ts:451
const checkpoints = sessionStoreCheckpoints(existing);
checkpoints.push(checkpoint);
trimmedCheckpoints = trimSessionCheckpoints(checkpoints);  // 只保留最近 25 个
store[target.canonicalKey] = {
  ...existing,
  updatedAt: Math.max(existing.updatedAt ?? 0, createdAt),
  compactionCheckpoints: trimmedCheckpoints.kept,
};
```

`MAX_COMPACTION_CHECKPOINTS_PER_SESSION = 25`
（`src/gateway/session-compaction-checkpoints.ts:23`）——每会话最多留 25 个检查点，
`trimSessionCheckpoints()`（`:37-52`）用 `slice(-25)` 丢最旧的。被丢的检查点
对应的快照转录文件由 `cleanupTrimmedCompactionCheckpointFiles()`
（`:75`）清理。

压缩前快照由 `captureCompactionCheckpointSnapshotAsync()`
（`src/gateway/session-compaction-checkpoints.ts:294`）生成——把压缩前的转录 fork 成一个
独立文件 `<sessionId>.checkpoint.<uuid>.jsonl`（命名见 `:323` 和
`src/config/sessions/artifacts.ts:5-6` 的 `COMPACTION_CHECKPOINT_TRANSCRIPT_RE`）。快照有大小上限
`MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES = 64MB`（`:24`）。

整个压缩流程（捕获快照 → 压缩 → 持久化检查点 → 失败时清理快照）的编排在
`src/agents/pi-embedded-runner/compact.ts`（`src/agents/pi-embedded-runner/compact.ts:1006` 捕获、
`:1322-1341` 持久化、`:1447-1448` 清理），属 agent 执行章节。

### 6.4 转录归档

会话被删/被 reset 时，转录文件不是直接删除而是**归档**——加时间戳后缀重命名。
`SessionArchiveReason`（`src/config/sessions/artifacts.ts:1`）有三种：`"bak"`/`"reset"`/`"deleted"`。
归档文件名形如 `<sessionId>.jsonl.reset.<2026-05-18T10-30-00.000Z>`
（`formatSessionArchiveTimestamp()` 把 `:` 换成 `-`，`src/config/sessions/artifacts.ts:92-94`）。

`artifacts.ts` 用一组谓词函数区分文件类型：
`isPrimarySessionTranscriptFileName()`（`:55`，活跃转录）、
`isSessionArchiveArtifactName()`（`:18`，归档）、
`isCompactionCheckpointTranscriptFileName()`（`:39`，压缩快照）、
`isTrajectorySessionArtifactName()`（`:51`，轨迹产物）。维护清理时据此分类。

归档由 `archiveRemovedSessionTranscripts()`（`src/config/sessions/store.ts:494-520`）执行，
`src/config/sessions/store.ts:300-325` 在维护中调用 `archiveRemovedSessionTranscripts` +
`cleanupArchivedSessionTranscripts` ——归档文件本身也有保留期
（`maintenance.resetArchiveRetentionMs`），过期后才真正删除。这是一个
「软删除 + 延迟硬删除」的两阶段策略：会话被删后还有一段窗口可以从归档恢复。

`isUsageCountedSessionTranscriptFileName()`（`src/config/sessions/artifacts.ts:71`）说明即便归档了
（`reset`/`deleted`），转录的 token 用量仍被计入用量统计——历史成本不因
归档而消失。`SessionEntry` 上的 `usageFamilyKey`/`usageFamilySessionIds`
（`src/config/sessions/types.ts:227-230`）维护跨 `sessionId` 轮换的用量谱系。

---

## 7. 数据库后端？多 agent 合并视图

任务大纲问到「可选的数据库后端」。在 `v2026.5.18` 里，会话存储**没有**数据库
后端——持久化机制就是 §2 描述的「单个 `sessions.json` + 写串行队列 + 原子写
+ TTL 读缓存」。这个方案对个人助手网关的规模（每 agent 最多几百会话）足够，
且零外部依赖、易备份、易调试。

与「多后端」最接近的概念是**多 agent 合并视图**。`combined-store-gateway.ts`
（`src/config/sessions/combined-store-gateway.ts`）解决的是：当配置了多个
agent、每个 agent 一个独立 `sessions.json`（`{agentId}` 模板路径），需要一个
**跨 agent 的统一会话视图**时，把多个 store 合并成一个。

`mergeSessionEntryIntoCombined()`（`src/config/sessions/combined-store-gateway.ts:20-45`）合并时
按 `updatedAt` 取较新者（`:30`），并归一 `spawnedBy` 指针
（`canonicalizeSpawnedByForAgent`）。它依赖 `targets.ts` 的
`resolveAllAgentSessionStoreTargetsSync()` 枚举所有 agent 的 store 路径。
这不是另一种存储后端，而是同一种文件后端之上的**只读聚合层**——给
dashboard、`/sessions` 列表之类需要「看到所有 agent 的所有会话」的场景用。

---

## 8. 全链路回顾

把会话状态的读写串成一张图：

```
 入站消息 (第 05 章)
     │
     │ resolveSessionKey() → sessionKey   (第 05 章 §4)
     ▼
┌─────────────────────────────────────────────────────────────┐
│ recordSessionMetaFromInbound()         store.ts:577           │
│   updateSessionStore(写队列内 RMW)                            │
│     ├─ loadMutableSessionStoreForWriter → 读 sessions.json    │
│     ├─ resolveSessionStoreEntry  键归一 + 旧键收集            │
│     ├─ deriveSessionMetaPatch    从 MsgContext 派生补丁       │
│     ├─ mergeSessionEntryPreserveActivity  合并(不刷活动戳)    │
│     └─ saveSessionStoreUnlocked  维护 → JSON → 原子写         │
└────────────────────────────┬────────────────────────────────┘
                             │ SessionEntry { sessionId, sessionFile,
                             │   model, modelOverride, totalTokens,
                             │   compactionCheckpoints, ... }
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ agent 执行 (后续章节)                                         │
│   读 SessionEntry 上的 model/provider/thinkingLevel/...       │
│   运行模型, 产出助手消息                                       │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ appendSessionTranscriptMessage()    transcript-append.ts:254  │
│   withTranscriptAppendQueue (按路径串行)                      │
│   acquireSessionWriteLock (跨进程文件锁)                       │
│     ├─ ensureTranscriptHeader  首次写 session 头              │
│     ├─ readTranscriptLeafInfo  找叶子, 线性→树迁移            │
│     └─ fs.appendFile  追加 {type,id,parentId,timestamp,       │
│                                message} 一行 JSONL            │
│   → 写入 <sessionId>.jsonl                                    │
└────────────────────────────┬────────────────────────────────┘
                             │ 上下文太长?
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ 压缩  (compact.ts 编排)                                       │
│   captureCompactionCheckpointSnapshotAsync  fork 转录快照     │
│   压缩对话历史为摘要                                          │
│   persistSessionCompactionCheckpoint                          │
│     → SessionEntry.compactionCheckpoints (最多 25)            │
│       { preCompaction, postCompaction } 可追溯指针            │
└──────────────────────────────────────────────────────────────┘
```

**贯穿全章的设计主题：**

1. **元数据与正文分层。** 轻量、频繁读写、需整体加载的元数据进
   `sessions.json` 字典；庞大、只追加、极少整读的对话正文每会话一个
   `.jsonl`。两层用 `sessionId` 串联。访问模式决定存储形态。

2. **并发安全分两级。** 会话存储用进程内串行写队列
   （`runExclusiveSessionStoreWrite`）——足以应对单进程内的 read-modify-write；
   转录用 OS 级文件锁（`acquireSessionWriteLock`）——因为多个 OpenClaw 进程
   可能并发追加同一文件。两者都配合临时文件 + rename 的原子写，保证读者
   永不见半成品。

3. **补丁合并而非整体替换。** `SessionEntry` 始终通过
   `mergeSessionEntryWithPolicy` 打补丁，并内建陈旧 provider 防护、活动时间
   保留策略。`resolveSessionStoreEntry` 在查找时顺手把旧键归一——渐进式
   数据迁移，不需要停机全量迁移。

4. **可追溯的软删除。** 会话被删/reset/压缩时，旧转录被归档（加时间戳后缀）
   而非立即销毁；归档有保留期，过期才硬删；压缩保留 pre/post 检查点指针。
   一切重大状态变更都留有回溯路径。
