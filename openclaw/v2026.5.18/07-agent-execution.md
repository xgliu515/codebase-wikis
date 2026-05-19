# 第 07 章　Agent 命令执行

> 代码版本锁定：`openclaw/openclaw@50a2481652`（tag `v2026.5.18`，2026-05-18）。本章所有 `file:line` 引用均基于该提交。

## 7.1 本章解决的问题

第 06 章结束时，一条入站消息已经走完入站管线，被归一化成一个 agent 运行请求。从这里开始，OpenClaw 需要回答一系列具体而棘手的问题：

- 这条消息该由**哪个 agent**处理？是 session 里固定的 agent，还是默认 agent？
- 这个 agent 该用**哪个 provider / 模型**？配置里写了默认值，但 session 可能有持久化覆盖，本次调用还可能带显式 `--model`，三者如何叠加？
- 用哪一份**凭证**去调 provider？同一个 provider 可能配了多个 auth profile，其中一些正在冷却，怎么选、怎么轮换、怎么 fallback？
- prompt 怎么拼？聊天历史、工具、技能快照、上下文如何组装进一次 LLM 请求？
- LLM 调用失败了怎么办？是重试同一个模型，还是切到 fallback 模型？session 中途被切换模型又怎么处理？
- 运行过程中产生的**事件**（开始、工具调用、流式输出、结束）发给谁？

这一整套逻辑的中枢就是 `agentCommand`，定义在 `src/agents/agent-command.ts`。它是一个长达 1623 行的协调器，本身几乎不做"业务"，而是把上面每个问题委托给一个专门模块，然后把结果串起来。本章逐层拆解这个协调过程。

阅读本章前，建议先建立一个心智模型：

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="agentCommand 调用层级：信任包装→协调器→各子步骤">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="30" y="10" width="700" height="50" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="32" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">agentCommand  (信任边界 / 包装)</text>
  <text x="380" y="50" text-anchor="middle" font-size="10" fill="#64748b">agent-command.ts:1568</text>
  <line x1="380" y1="60" x2="380" y2="80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="60" y="80" width="640" height="240" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="102" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">agentCommandInternal  (真正的协调器)</text>
  <text x="380" y="118" text-anchor="middle" font-size="10" fill="#94a3b8">agent-command.ts:485</text>
  <line x1="110" y1="128" x2="110" y2="308" stroke="#cbd5e1" stroke-width="1.2"/>
  <line x1="110" y1="140" x2="128" y2="140" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="128" y="128" width="560" height="22" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="148" y="143" font-size="11" font-weight="600" fill="currentColor">prepareAgentCommandExecution</text>
  <text x="420" y="143" font-size="11" fill="#64748b">解析 session / agent / workspace</text>
  <line x1="110" y1="162" x2="128" y2="162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="128" y="150" width="560" height="22" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="148" y="165" font-size="11" font-weight="600" fill="currentColor">[模型选择]</text>
  <text x="280" y="165" font-size="11" fill="#64748b">默认 → 持久化覆盖 → 显式覆盖 → allowlist</text>
  <line x1="110" y1="184" x2="128" y2="184" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="128" y="172" width="560" height="22" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="148" y="187" font-size="11" font-weight="600" fill="currentColor">[auth profile 校验]</text>
  <text x="310" y="187" font-size="11" fill="#64748b">session 固定的 profile 是否还兼容当前 provider</text>
  <line x1="110" y1="206" x2="128" y2="206" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="128" y="194" width="560" height="44" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="148" y="210" font-size="11" font-weight="600" fill="#0d9488">runWithModelFallback</text>
  <text x="320" y="210" font-size="11" fill="#64748b">外层 fallback 循环</text>
  <text x="168" y="228" font-size="11" fill="#64748b">└── runAgentAttempt  单次 attempt（embedded pi / CLI / ACP）</text>
  <text x="188" y="232" font-size="10" fill="#94a3b8">└── runEmbeddedPiAgent / runCliAgent</text>
  <line x1="110" y1="252" x2="128" y2="252" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="128" y="240" width="560" height="22" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="148" y="255" font-size="11" font-weight="600" fill="currentColor">[事件发射]</text>
  <text x="260" y="255" font-size="11" fill="#64748b">lifecycle / assistant / tool / item ...</text>
  <line x1="110" y1="274" x2="128" y2="274" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="128" y="262" width="560" height="22" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="148" y="277" font-size="11" font-weight="600" fill="currentColor">[transcript 持久化 + compaction]</text>
  <line x1="110" y1="296" x2="128" y2="296" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="128" y="284" width="560" height="22" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="148" y="299" font-size="11" font-weight="600" fill="currentColor">deliverAgentCommandResult</text>
  <text x="370" y="299" font-size="11" fill="#64748b">把响应投递回渠道</text>
</svg>
<span class="figure-caption">图 R7.1 ｜ agentCommand 调用层级：外层信任包装薄委托内层协调器，协调器顺序编排准备、模型选择、fallback 执行、事件发射、转录持久化、结果投递</span>

<details>
<summary>ASCII 原版</summary>

```
agentCommand (信任边界 / 包装)
   └── agentCommandInternal (真正的协调器)
         ├── prepareAgentCommandExecution  解析 session / agent / workspace
         ├── [模型选择]                     默认 → 持久化覆盖 → 显式覆盖 → allowlist
         ├── [auth profile 校验]            session 固定的 profile 是否还兼容当前 provider
         ├── runWithModelFallback           外层 fallback 循环
         │     └── runAgentAttempt          单次 attempt（embedded pi / CLI / ACP）
         │           └── runEmbeddedPiAgent / runCliAgent
         ├── [事件发射]                     lifecycle / assistant / tool / item ...
         ├── [transcript 持久化 + compaction]
         └── deliverAgentCommandResult      把响应投递回渠道
```

</details>

---

## 7.2 入口：`agentCommand` 与信任边界

`src/agents/agent-command.ts` 导出三个公开符号（`src/agents/agent-command.ts:1568`、`:1596`、`:1620`）：

| 导出 | 用途 |
| --- | --- |
| `agentCommand` | 受信任的本地 / CLI 入口 |
| `agentCommandFromIngress` | 网络面（HTTP / WS ingress）入口 |
| `__testing` | 测试专用，暴露 `resolveAgentRuntimeConfig` / `prepareAgentCommandExecution` |

两个公开入口都只是薄包装，最终都汇入私有的 `agentCommandInternal`（`src/agents/agent-command.ts:485`）。它们的差别**只在两个布尔字段的默认值上**，但这个差别是安全设计的核心。

`agentCommand`（`src/agents/agent-command.ts:1568-1594`）：

```ts
export async function agentCommand(opts, runtime = defaultRuntime, deps?) {
  const resolvedDeps = await resolveAgentCommandDeps(deps);
  return await withLocalGatewayRequestScope({ deps, getRuntimeConfig }, async () =>
    await agentCommandInternal(
      {
        ...opts,
        // 本地 / CLI 调用默认视为 owner
        senderIsOwner: opts.senderIsOwner ?? true,
        // 本地调用默认允许 per-run 模型覆盖
        allowModelOverride: opts.allowModelOverride ?? true,
      },
      runtime,
      resolvedDeps,
    ),
  );
}
```

`agentCommandFromIngress`（`src/agents/agent-command.ts:1596-1618`）则**强制**调用方显式声明这两个字段：

```ts
if (typeof opts.senderIsOwner !== "boolean") {
  throw new Error("senderIsOwner must be explicitly set for ingress agent runs.");
}
if (typeof opts.allowModelOverride !== "boolean") {
  throw new Error("allowModelOverride must be explicitly set for ingress agent runs.");
}
```

**为什么这样设计**：`senderIsOwner` 决定 agent 是否拥有 owner 级权限（敏感工具、不受限的文件访问等）；`allowModelOverride` 决定调用方能否用 `--model` 临时切换模型。如果网络面入口也能继承"默认即 owner"，那么任何打进 HTTP ingress 的请求都会悄悄拿到 owner 权限——这是典型的"默认不安全"陷阱。OpenClaw 的做法是：本地 CLI 路径享受便利的默认值，而网络面路径在边界上**必须显式表态**，少写一个字段就直接抛错，让"忘记设置"变成可观测的失败而不是静默的提权。

`withLocalGatewayRequestScope`（`src/agents/agent-command.ts:1574`，定义在 `src/gateway/local-request-context.ts`）为本次运行建立一个 request-scoped 上下文，让下游能拿到 `deps` 和 `getRuntimeConfig` 而不必层层透传。

### 7.2.1 依赖解析

`resolveAgentCommandDeps`（`src/agents/agent-command.ts:218-262`）负责补全 `CliDeps`。OpenClaw 大量使用**惰性导入**来切割启动成本：文件顶部一大批 `createLazyImportLoader` 调用（`src/agents/agent-command.ts:116-156`）把 attempt 执行运行时、ACP 运行时、delivery、session store、skills 等重模块都包成 lazy loader，只有真正用到时才 `import()`。例如 `loadAttemptExecutionRuntime`（`src/agents/agent-command.ts:158-160`）：

```ts
const attemptExecutionRuntimeLoader = createLazyImportLoader<AttemptExecutionRuntime>(
  () => import("./command/attempt-execution.runtime.js"),
);
function loadAttemptExecutionRuntime() {
  return attemptExecutionRuntimeLoader.load();
}
```

**为什么**：`agent-command.ts` 处在 CLI 启动的关键路径上。如果在模块顶层静态 `import` 整个 ACP 子系统、技能子系统，那么哪怕用户只是跑 `openclaw --version` 也得把它们全部加载并求值。惰性导入把这些成本推迟到第一次真正执行 agent 时，且 `createLazyImportLoader` 内部缓存了 Promise，多次调用只 import 一次。

---

## 7.3 准备阶段：`prepareAgentCommandExecution`

`agentCommandInternal` 做的第一件实事是调用 `prepareAgentCommandExecution`（`src/agents/agent-command.ts:303-483`）。这个函数把"一条裸消息 + 一堆 opts"解析成一个结构化的执行上下文，返回约 25 个字段（`src/agents/agent-command.ts:455-482`）。它内部不调 LLM，纯粹是解析和校验。

### 7.3.1 输入校验

开头两条硬校验（`src/agents/agent-command.ts:307-314`）：

```ts
const message = opts.message ?? "";
if (!message.trim()) {
  throw new Error("Message (--message) is required");
}
if (!opts.to && !opts.sessionId && !opts.sessionKey && !opts.agentId) {
  throw new Error("Pass --to <E.164>, --session-id, or --agent to choose a session");
}
```

消息不能为空；并且必须有某种方式定位一个 session（电话号、session id、session key 或 agent id）。

### 7.3.2 agent 解析

agent 的解析分两步。第一步处理**显式 agent 覆盖**（`src/agents/agent-command.ts:326-343`）：

```ts
const agentIdOverride = agentIdOverrideRaw ? normalizeAgentId(agentIdOverrideRaw) : undefined;
if (agentIdOverride) {
  const knownAgents = listAgentIds(cfg);
  if (!knownAgents.includes(agentIdOverride)) {
    throw new Error(`Unknown agent id "${agentIdOverrideRaw}". ...`);
  }
}
if (agentIdOverride && opts.sessionKey) {
  const sessionAgentId = resolveAgentIdFromSessionKey(opts.sessionKey);
  if (sessionAgentId !== agentIdOverride) {
    throw new Error(`Agent id "..." does not match session key agent "${sessionAgentId}".`);
  }
}
```

如果调用方同时给了 `--agent` 和一个 `sessionKey`，二者必须一致——**session key 本身编码了 agent id**（`resolveAgentIdFromSessionKey`，`src/routing/session-key.ts`），不允许"用 A agent 的 key 跑 B agent"。

第二步在 session 解析之后，得出最终的 `sessionAgentId`（`src/agents/agent-command.ts:385-390`）：

```ts
const sessionAgentId =
  agentIdOverride ??
  resolveSessionAgentId({
    sessionKey: sessionKey ?? opts.sessionKey?.trim(),
    config: cfg,
  });
```

优先级：**显式 `--agent` > 从 session key 推断 > 默认 agent**。`resolveSessionAgentId` 定义在 `src/agents/agent-scope.js`，当 session key 不带 agent 段时回退到 `cfg.agents.defaults` 对应的默认 agent。

确定 `sessionAgentId` 后，准备阶段顺势解析出该 agent 的几项配置（`src/agents/agent-command.ts:397-405`）：

- `workspaceDir`：`resolveAgentWorkspaceDir(cfg, sessionAgentId)`，可被 spawn 元数据 `normalizedSpawned.workspaceDir` 覆盖（subagent 继承父 workspace）。
- `agentDir`：`resolveAgentDir(cfg, sessionAgentId)`，agent 的私有目录（auth store、agent 级配置都落在这里）。
- `manifestMetadataSnapshot`：`loadManifestMetadataSnapshot`，加载已安装插件清单，用于后续模型 id 归一化。

### 7.3.3 session 解析

`resolveSession`（`src/agents/agent-command.ts:367-373`，定义在 `src/agents/command/session.ts`）根据 `to / sessionId / sessionKey / agentId` 解析出 session 全家桶：`sessionId`、`sessionKey`、`sessionEntry`、`sessionStore`、`storePath`、`isNewSession`，以及该 session 上持久化的 `persistedThinking` / `persistedVerbose`（`src/agents/agent-command.ts:375-384`）。

### 7.3.4 thinking / verbose / timeout 归一化

准备阶段还把 CLI 传入的字符串参数归一化成内部枚举：

- `verboseOverride = normalizeVerboseLevel(opts.verbose)`（`src/agents/agent-command.ts:346`），非法值抛错。
- `thinkOverride` / `thinkOnce`（`src/agents/agent-command.ts:426-433`），分别对应持久化的 thinking 级别和一次性 thinking 级别；非法值抛错，错误消息里带上当前 provider/model 支持的级别列表 `thinkingLevelsHint`（`src/agents/agent-command.ts:420-425`）。
- `timeoutMs = resolveAgentTimeoutMs(...)`（`src/agents/agent-command.ts:362-365`）。注意 subagent lane（`laneRaw === AGENT_LANE_SUBAGENT`）默认 timeout 为 `0`（不超时，`src/agents/agent-command.ts:354-355`），因为 subagent 的生命周期由父 agent 管理。

### 7.3.5 ACP 分支判定与 prompt body

准备阶段最后判断这次运行是否走 **ACP（Agent Client Protocol）** 通道（`src/agents/agent-command.ts:440-453`）：

```ts
const { getAcpSessionManager } = await loadAcpManagerRuntime();
const acpManager = getAcpSessionManager();
const acpResolution = sessionKey ? acpManager.resolveSession({ cfg, sessionKey }) : null;
const body =
  !isRawModelRun && acpResolution?.kind === "ready"
    ? resolveAcpPromptBody(message, opts.internalEvents)
    : prependInternalEventContext(message, opts.internalEvents);
```

`prependInternalEventContext` 会把"内部事件"（如系统提醒）以特定格式前置进 prompt body。`transcriptBody`（写进 transcript 的版本）单独解析（`src/agents/agent-command.ts:452-453`），因为投给模型的 body 和写进历史记录的 body 可能不同。

---

## 7.4 模型选择

回到 `agentCommandInternal`。准备阶段返回后，从 `src/agents/agent-command.ts:783` 起进入模型选择。这是整个流程里最绕的一段，因为有四层来源需要按优先级合并。`src/agents/model-selection.ts`（507 行）是这套逻辑的门面模块，它本身大量 re-export 自更专门的 `model-selection-shared.ts`、`model-selection-normalize.ts`、`model-thinking-default.ts`。

### 7.4.1 四层来源

模型选择从"agent 配置的默认值"出发，逐层叠加覆盖：

<svg viewBox="0 0 640 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="模型选择四层优先级：配置默认→session 持久化覆盖→本次显式覆盖→allowlist 收敛">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="60" y="10" width="520" height="44" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="110" y="28" font-size="11" fill="#94a3b8">第 1 层</text>
  <text x="160" y="28" font-size="13" font-weight="700" fill="currentColor">配置默认</text>
  <text x="290" y="28" font-size="11" fill="#64748b">resolveDefaultModelForAgent(cfg, agentId)</text>
  <text x="160" y="46" font-size="10" fill="#94a3b8">agent 级别 model 覆盖 → resolveConfiguredModelRef → normalizeModelRef</text>
  <line x1="320" y1="54" x2="320" y2="76" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)" stroke-dasharray="3,2"/>
  <text x="330" y="70" font-size="10" fill="#94a3b8">被覆盖</text>
  <rect x="60" y="76" width="520" height="44" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="110" y="94" font-size="11" fill="#ea580c">第 2 层</text>
  <text x="160" y="94" font-size="13" font-weight="700" fill="#ea580c">session 持久化覆盖</text>
  <text x="380" y="94" font-size="11" fill="#64748b">sessionEntry.providerOverride / modelOverride</text>
  <text x="160" y="112" font-size="10" fill="#94a3b8">仅在仍被 allowlist 允许时采纳；不在则清除并回退到默认</text>
  <line x1="320" y1="120" x2="320" y2="142" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)" stroke-dasharray="3,2"/>
  <text x="330" y="136" font-size="10" fill="#94a3b8">被覆盖</text>
  <rect x="60" y="142" width="520" height="44" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="110" y="160" font-size="11" fill="#7c3aed">第 3 层</text>
  <text x="160" y="160" font-size="13" font-weight="700" fill="#7c3aed">本次显式覆盖</text>
  <text x="320" y="160" font-size="11" fill="#64748b">opts.provider / opts.model（需 allowModelOverride）</text>
  <text x="160" y="178" font-size="10" fill="#94a3b8">agentCommandFromIngress 调用方必须显式声明 allowModelOverride</text>
  <line x1="320" y1="186" x2="320" y2="208" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)" stroke-dasharray="3,2"/>
  <text x="330" y="202" font-size="10" fill="#94a3b8">受约束</text>
  <rect x="60" y="208" width="520" height="44" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="110" y="226" font-size="11" fill="#0d9488">第 4 层</text>
  <text x="160" y="226" font-size="13" font-weight="700" fill="#0d9488">allowlist 收敛</text>
  <text x="310" y="226" font-size="11" fill="#64748b">visibilityPolicy.resolveSelection(...)</text>
  <text x="160" y="244" font-size="10" fill="#94a3b8">最终模型必须在 agent 的 models 白名单内；否则报错或回退</text>
</svg>
<span class="figure-caption">图 R7.2 ｜ 模型选择四层优先级：下层覆盖上层，但第 4 层 allowlist 收敛是硬约束，任何覆盖都不能绕过</span>

<details>
<summary>ASCII 原版</summary>

```
第 1 层  配置默认       resolveDefaultModelForAgent(cfg, agentId)
              ↓ (被覆盖)
第 2 层  session 持久化覆盖   sessionEntry.providerOverride / modelOverride
              ↓ (被覆盖)
第 3 层  本次显式覆盖    opts.provider / opts.model（需 allowModelOverride）
              ↓ (受约束)
第 4 层  allowlist 收敛  visibilityPolicy.resolveSelection(...)
```

</details>

**第 1 层 — 配置默认。** `resolveDefaultModelForAgent`（`src/agents/model-selection.ts:214-247`）先看 agent 级别的 model 覆盖（`resolveAgentEffectiveModelPrimary`），若有就把它塞进一份临时 cfg 的 `agents.defaults.model.primary`，再交给 `resolveConfiguredModelRef` 统一解析。`src/agents/agent-command.ts:783-794` 取出结果并归一化：

```ts
const configuredDefaultRef = resolveDefaultModelForAgent({ cfg, agentId: sessionAgentId, ...modelManifestContext });
const { provider: defaultProvider, model: defaultModel } = normalizeModelRef(
  configuredDefaultRef.provider, configuredDefaultRef.model, modelManifestContext);
let provider = defaultProvider;
let model = defaultModel;
```

`normalizeModelRef` 会把模型 id 经过插件清单（`modelManifestContext.manifestPlugins`）的别名归一化——例如 anthropic 插件清单里 `opus-4.6 → claude-opus-4-6`（见第 08 章 8.3）。

**第 2 层 — session 持久化覆盖。** 如果用户之前在这个 session 里 `/model` 切过模型，覆盖会落在 `sessionEntry.providerOverride` / `modelOverride`。`src/agents/agent-command.ts:881-895`：

```ts
const storedProviderOverride = sessionEntry?.providerOverride?.trim();
let storedModelOverride = sessionEntry?.modelOverride?.trim();
if (storedModelOverride) {
  const normalizedStored = normalizeModelRef(candidateProvider, storedModelOverride, modelManifestContext);
  const key = modelKey(normalizedStored.provider, normalizedStored.model);
  if (visibilityPolicy.allowsKey(key)) {       // 仍在 allowlist 内才采纳
    provider = normalizedStored.provider;
    model = normalizedStored.model;
  }
}
```

关键点：持久化覆盖**只有在仍被 allowlist 允许时才采纳**。在此之前（`src/agents/agent-command.ts:840-879`）还有一段"修复 + 失效清理"逻辑：`repairProviderWrappedModelOverride` 处理历史上误把 `provider/model` 整体写进 `modelOverride` 的脏数据；若发现持久化覆盖的模型已不在 allowlist，则用 `applyModelOverrideToSessionEntry` 把 session 上的覆盖重置回默认模型并落盘。**为什么**：agent 的 `models` allowlist 可能在用户改配置后收紧，旧 session 里残留的覆盖必须自我修复，否则会一直跑一个已被禁用的模型。

**第 3 层 — 本次显式覆盖。** `src/agents/agent-command.ts:804-815`：

```ts
const explicitProviderOverride =
  typeof opts.provider === "string" ? normalizeExplicitOverrideInput(opts.provider, "provider") : undefined;
const explicitModelOverride =
  typeof opts.model === "string" ? normalizeExplicitOverrideInput(opts.model, "model") : undefined;
const hasExplicitRunOverride = Boolean(explicitProviderOverride || explicitModelOverride);
if (hasExplicitRunOverride && opts.allowModelOverride !== true) {
  throw new Error("Model override is not authorized for this caller.");
}
```

`normalizeExplicitOverrideInput`（`src/agents/agent-command.ts:288-301`）会先 `containsControlCharacters` 检查，拒绝带控制字符的输入——这是来自不可信渠道的输入清洗。显式覆盖的实际应用在 `src/agents/agent-command.ts:912-931`，同样要过 `visibilityPolicy.allowsKey`，不在 allowlist 内直接抛错（注意这里是抛错，而第 2 层是静默重置——因为显式覆盖是用户**本次**的明确意图，应该用错误反馈，而持久化覆盖是历史残留，应该静默修复）。

**第 4 层 — allowlist 收敛。** `visibilityPolicy` 由 `createModelVisibilityPolicy` 构造（`src/agents/agent-command.ts:819-838`）。只有当 agent 配了非空 `models` allowlist（`hasAllowlist`，`src/agents/agent-command.ts:795`）时才会真正加载模型目录 `loadManifestModelCatalog` 并计算 `allowedModelCatalog`。最终一步 `resolveSelection`（`src/agents/agent-command.ts:932-942`）：

```ts
const allowedInitialSelection = visibilityPolicy.resolveSelection({ provider, model });
if (!allowedInitialSelection) {
  throw new Error(`Configured default model "${modelKey(provider, model)}" is not allowed ... and no allowed model is available.`);
}
provider = allowedInitialSelection.provider;
model = allowedInitialSelection.model;
```

`resolveSelection` 不仅校验，还会在请求的模型被禁时尝试**收敛到一个被允许的替代模型**；若一个都没有则抛错。

### 7.4.2 auto-fallback primary probe

在第 2 层和第 3 层之间还有一个特殊机制：**auto-fallback primary probe**（`src/agents/agent-command.ts:896-910`）。

```ts
const autoFallbackPrimaryProbe = !hasExplicitRunOverride
  ? resolveAutoFallbackPrimaryProbe({ entry: sessionEntry, sessionKey,
      primaryProvider: defaultProvider, primaryModel: defaultModel })
  : undefined;
if (autoFallbackPrimaryProbe && sessionEntry) {
  provider = autoFallbackPrimaryProbe.provider;
  model = autoFallbackPrimaryProbe.model;
  autoFallbackPrimaryProbeSessionEntry = { ...sessionEntry };
  clearAutoFallbackPrimaryProbeSelection(autoFallbackPrimaryProbeSessionEntry);
}
```

**场景**：上一次运行时 primary 模型挂了（限流/故障），系统自动 fallback 到了备用模型，并把这个 fallback 选择持久化进了 session。下次运行时，OpenClaw 不想永久钉死在备用模型上——它会先**探测一次** primary 是否恢复（probe = primary），如果 primary 又跑成功了就把 session 上的 auto-fallback 覆盖清掉（`src/agents/agent-command.ts:1248-1283` 的回写逻辑），否则保持 fallback。`modelOverrideSource` 字段区分覆盖来源是 `"user"`（用户显式 `/model`）还是 `"auto"`（系统自动 fallback），probe 只对 `"auto"` 来源生效——用户显式选的模型不会被探测掉。

### 7.4.3 thinking 级别的最终解析

模型确定后，thinking 级别才能最终敲定（`src/agents/agent-command.ts:1004-1059`），因为不同模型支持的 thinking 级别不同：

```ts
if (!resolvedThinkLevel) {
  resolvedThinkLevel = resolveThinkingDefault({ cfg, provider, model, catalog: thinkingCatalog });
}
if (!isThinkingLevelSupported({ provider, model, level: resolvedThinkLevel, catalog: thinkingCatalog })) {
  const explicitThink = Boolean(thinkOnce || thinkOverride);
  if (explicitThink) {
    throw new Error(`Thinking level "${resolvedThinkLevel}" is not supported for ${provider}/${model}. ...`);
  }
  const fallbackThinkLevel = resolveSupportedThinkingLevel({ provider, model, level: resolvedThinkLevel, catalog: thinkingCatalog });
  // ...静默降级，并在 session 上同步修正持久化的 thinkingLevel
}
```

同样的"显式抛错 / 隐式降级"二分法：用户明确要的 thinking 级别如果模型不支持就报错；继承来的级别不支持则静默降到一个支持的级别（`resolveSupportedThinkingLevel`），并把 session 里持久化的 `thinkingLevel` 一并修正落盘。

---

## 7.5 auth profile：provider 凭证管理

模型选好了，但用什么凭证去调 provider？这是 `src/agents/auth-profiles/` 子系统的职责。一个 **auth profile** 就是"某个 provider 的一份具名凭证"，凭证类型有三种（`src/agents/auth-profiles/types.ts:62`）：

```ts
export type AuthProfileCredential = ApiKeyCredential | TokenCredential | OAuthCredential;
```

- `ApiKeyCredential`（`src/agents/auth-profiles/types.ts:19`）：纯 API key。
- `TokenCredential`（`src/agents/auth-profiles/types.ts:32`）：bearer token（如 anthropic setup-token）。
- `OAuthCredential`（`src/agents/auth-profiles/types.ts:49`）：OAuth，带 refresh token、过期时间。

整个 auth profile 子系统的公开门面是 `src/agents/auth-profiles.ts`（89 行），它只做 re-export，把 `auth-profiles/` 目录下十几个文件的 API 汇总暴露。下面看三个核心环节。

### 7.5.1 store 与 session 级覆盖校验

profile 持久化在 auth store 中（`AuthProfileStore`，`src/agents/auth-profiles/types.ts:120`，由 secrets 部分和 state 部分合并而成）。`ensureAuthProfileStore`（`src/agents/auth-profiles/store.js`）加载它。

`agentCommandInternal` 在 `src/agents/agent-command.ts:954-1002` 校验 session 上是否钉了一个 `authProfileOverride`，以及它是否还和当前 provider 兼容：

```ts
const authProfileId = sessionEntryForAttempt.authProfileOverride;
if (authProfileId) {
  const profile = store.profiles[authProfileId];
  const acceptedAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({...})
    .map((p) => resolveProviderIdForAuth(p, { config: cfg, workspaceDir }));
  const profileMatchesRuntime = profile && acceptedAuthProviders.some((p) =>
    isStoredCredentialCompatibleWithAuthProvider({ cfg, provider: p, credential: profile }));
  if (!profileMatchesRuntime) {
    // 显式覆盖 / probe 场景：临时丢弃 session 的 authProfileOverride
    // 否则：clearSessionAuthProfileOverride 落盘清除
  }
}
```

**为什么**：session 上钉的 auth profile 是为当时的 provider 选的；如果模型选择阶段切换了 provider，这份 profile 可能就不再兼容（比如它是 anthropic 的 OAuth，而现在要跑 openai）。这里把不兼容的 session 级 profile 覆盖清掉，让后面 attempt 阶段重新自动选一个。

### 7.5.2 选序：`resolveAuthProfileOrder`

真正"该用哪个 profile"由 `resolveAuthProfileOrder`（`src/agents/auth-profiles/order.ts:217-262+`）决定。它返回一个**有序的 profile id 列表**——按优先级排好的候选凭证，attempt 阶段从头往后试。排序综合了多个来源：

- store 里持久化的显式顺序 `store.order`；
- 配置里的 `cfg.auth.order`；
- `cfg.auth.profiles` 里声明的、且 provider 兼容的 profile（`src/agents/auth-profiles/order.ts:249-261`）。

函数开头有一个重要副作用（`src/agents/auth-profiles/order.ts:228-231`）：

```ts
// 清掉已经过期的冷却，让 profile 拿到新鲜的错误计数，
// 不会在下一次瞬时失败时立刻被重新惩罚。
clearExpiredCooldowns(store, now);
```

每次解析选序时顺手把过期冷却清掉——这是一种 lazy 的冷却回收策略，不需要后台定时器。

### 7.5.3 eligibility、冷却与轮换

单个 profile 是否"现在可用"由 `resolveAuthProfileEligibility`（`src/agents/auth-profiles/order.ts:157-215`）判定。它逐项检查：凭证是否存在（`profile_missing`）、provider 是否匹配（`provider_mismatch`）、配置里声明的 mode 与凭证类型是否一致（`mode_mismatch`，注意 OAuth 与 token 视为兼容，`src/agents/auth-profiles/order.ts:200-205`），最后委托 `evaluateStoredCredentialEligibility` 看凭证本身（是否冷却中、token 是否过期）。

**冷却**是凭证轮换的核心。当一个 profile 触发限流或失败，`markAuthProfileFailure` / `markAuthProfileCooldown`（`src/agents/auth-profiles/usage.ts`）会给它打上冷却时间。冷却时长按错误次数指数式增长——`calculateAuthProfileCooldownMs`（`src/agents/auth-profiles/usage.ts:359-368`）：

```ts
export function calculateAuthProfileCooldownMs(errorCount: number): number {
  const normalized = Math.max(1, errorCount);
  if (normalized <= 1) return 30_000;        // 第 1 次：30 秒
  if (normalized <= 2) return 60_000;        // 第 2 次：1 分钟
  return 5 * 60_000;                          // 之后封顶 5 分钟
}
```

对于 billing / auth_permanent 这类更严重的失败，`src/agents/auth-profiles/usage.ts:370` 起的 `ResolvedAuthCooldownConfig` 用一套独立、更长的退避参数。

于是凭证 **fallback** 的整体行为是：`resolveAuthProfileOrder` 给出有序候选 → attempt 阶段依次尝试 → 失败的 profile 被打冷却 → 下一次 `resolveAuthProfileOrder` 会因为 `clearExpiredCooldowns` + eligibility 判定自动把冷却中的 profile 排到后面或排除。多 profile 在健康时近似轮询，在部分凭证受限时自动绕开。

### 7.5.4 OAuth 刷新

OAuth 凭证有过期时间，`refreshOAuthCredentialForRuntime`（`src/agents/auth-profiles/oauth.ts:204-235`）负责在运行时刷新。它内部用一个 per-profile 的刷新队列做串行化（`resetOAuthRefreshQueuesForTest` 暗示了队列结构），避免并发 attempt 同时刷新同一个 profile 导致 refresh token 被重复消费——`isRefreshTokenReusedError`（`src/agents/auth-profiles/oauth.ts:160`）专门识别"refresh token 已被用过"的错误。`resolveApiKeyForProfile`（`src/agents/auth-profiles/oauth.ts:330`）则把任意类型的 profile 统一解析成一个可直接用的 API key/token（OAuth profile 会先触发刷新）。

---

## 7.6 prompt 构建与 attempt 准备

模型、凭证都备齐后，`agentCommandInternal` 还要为本次 attempt 准备几样东西。

### 7.6.1 技能快照

`src/agents/agent-command.ts:692-756` 处理**技能快照**（skills snapshot）。技能是 agent 可用的一组能力，它们被打包成一个 `skillsSnapshot` 随 prompt 一起传给 runner。是否需要重建快照由三个条件决定（`src/agents/agent-command.ts:697-701`）：

```ts
const shouldRefreshSkillsSnapshot =
  !currentSkillsSnapshot ||
  shouldRefreshSnapshotForVersion(currentSkillsSnapshot.version, skillsSnapshotVersion) ||
  !matchesSkillFilter(currentSkillsSnapshot.skillFilter, skillFilter);
const needsSkillsSnapshot = isNewSession || shouldRefreshSkillsSnapshot;
```

没有旧快照、workspace 技能版本变了、或 agent 的技能过滤器变了，就重建。`buildSkillsSnapshot`（`src/agents/agent-command.ts:702-728`）调 `buildWorkspaceSkillSnapshot` 扫描 workspace。重建后的快照会落盘进 session（`src/agents/agent-command.ts:735-756`），下次复用。**为什么持久化**：扫描 workspace 技能有 I/O 成本，把快照钉在 session 上意味着只要 workspace 没变就不重扫。

### 7.6.2 transcript 文件解析

`resolveSessionTranscriptFile`（`src/agents/agent-command.ts:1060-1086`）解析出本次运行要读写的 transcript 文件路径。transcript 就是这个 session 的聊天历史，runner 后续会把它读进来作为 LLM 的对话上下文。

### 7.6.3 实际的 prompt 拼装在哪

值得强调：`agent-command.ts` **本身不拼 prompt**。它把 `body`（用户消息）、`skillsSnapshot`（工具/技能）、`sessionFile`（历史 transcript 路径）、`resolvedThinkLevel`、`extraSystemPrompt` 等原料整理好，交给下游的 runner（`runEmbeddedPiAgent` 或 `runCliAgent`）。真正的"系统提示 + 历史 + 工具 schema + 当前消息"组装发生在 runner 内部和 `pi-embedded-runner` 子系统里（`src/agents/pi-embedded-runner/run/attempt-system-prompt.ts`、`attempt.prompt-helpers.ts` 等）。`agent-command.ts` 是协调器，prompt 工程是 runner 的职责。

attempt 入口处 `runAgentAttempt` 会对 prompt 做一层薄包装：`resolveFallbackRetryPrompt`（`src/agents/command/attempt-execution.ts:415-420`）在 fallback 重试时可能加前缀提示，`annotateInterSessionPromptText`（`src/agents/command/attempt-execution.ts:421-423`）给跨 session 输入打来源标注。这些是"消息级"修饰，不是完整 prompt 组装。

---

## 7.7 attempt 执行

现在进入真正调用 LLM 的部分。这里有两层循环：外层是 `runWithModelFallback`（**模型 fallback**），内层 `runAgentAttempt` 是**单次尝试**。整段代码在 `src/agents/agent-command.ts:1113-1411` 一个 `for (;;)` 里，最外层那个 for 是为了处理 live model switch（见 7.7.4）。

### 7.7.1 attempt 运行时模块

`attempt-execution.runtime.ts` 只有 14 行，它是一个 re-export 聚合点：

```ts
// src/agents/command/attempt-execution.runtime.ts —— 整个文件
export * from "./attempt-execution.js";
// （以及若干 ACP / helpers re-export）
```

**为什么单独留一个 `.runtime.ts`**：它就是 7.2.1 提到的惰性导入目标。`agent-command.ts` 通过 `loadAttemptExecutionRuntime()` 动态 import 这个聚合模块，从而把 attempt 执行的全部依赖（`runEmbeddedPiAgent`、`runCliAgent`、ACP 运行时）推迟到运行时才加载。`.runtime.ts` 后缀在 OpenClaw 里是"惰性加载边界"的约定俗成命名。

真正的实现都在 `attempt-execution.ts`（851 行）。

### 7.7.2 外层：`runWithModelFallback`

`runWithModelFallback`（`src/agents/model-fallback.ts:904`）在 `src/agents/agent-command.ts:1130-1237` 被调用。它接收 primary `provider`/`model`、一个 `fallbacksOverride` 列表，以及两个回调：

- `run(providerOverride, modelOverride, runOptions)` —— 实际执行一次 attempt；
- `classifyResult({ provider, model, result })` —— 判断一个结果是否"需要 fallback"（`classifyEmbeddedPiRunResultForModelFallback`，`src/agents/agent-command.ts:1154-1159`）。

fallback 列表由 `resolveEffectiveModelFallbacks` 计算（`src/agents/agent-command.ts:1116-1126`）：

```ts
const effectiveFallbacksOverride = resolveEffectiveModelFallbacks({
  cfg, agentId: sessionAgentId, sessionKey,
  hasSessionModelOverride: hasExplicitRunOverride || Boolean(storedProviderOverride || storedModelOverride),
  modelOverrideSource: hasExplicitRunOverride ? "user" : storedModelOverrideSource,
  hasAutoFallbackProvenance: hasExplicitRunOverride ? false : hasStoredAutoFallbackProvenance,
});
```

**为什么 fallback 列表跟覆盖来源有关**：如果用户**显式**选了某个模型（`hasExplicitRunOverride`），系统通常不该擅自 fallback 到别的模型——用户要的就是这个。fallback 主要服务于"跑默认模型时遇到故障自动绕路"的场景。

`runWithModelFallback` 内部依次对 primary、fallback1、fallback2... 调 `run`，每次失败/被 classify 成需要 fallback 就推进到下一个。它返回 `{ result, provider, model, attempts }`——`provider`/`model` 是**最终成功的**那一对，`attempts` 是所有尝试记录。如果最终落在了 fallback 模型上（`fallbackResult.attempts.length > 0`），`src/agents/agent-command.ts:1284-1295` 会把 attempt 记录塞进 `result.meta.agentMeta.fallbackAttempts`。

`onFallbackStep` 回调把每一步 fallback 记进 trajectory recorder（`src/agents/agent-command.ts:1151-1153`），用于后续诊断。

### 7.7.3 内层：`runAgentAttempt` 与三种 runner

`runAgentAttempt`（`src/agents/command/attempt-execution.ts:367-691`）是单次 attempt 的核心。它的任务是：根据 provider/model/harness 策略，决定走**三条 runner 路径**中的哪一条。

<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="runAgentAttempt 三条 runner 路径：isRawModelRun→强制 pi harness，isCliProvider→runCliAgent，默认→runEmbeddedPiAgent">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="280" y="10" width="200" height="36" rx="8" fill="#ea580c" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="33" text-anchor="middle" font-size="13" font-weight="700" fill="white">runAgentAttempt</text>
  <line x1="380" y1="46" x2="380" y2="76" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="100" y1="76" x2="660" y2="76" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="100" y1="76" x2="100" y2="106" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="380" y1="76" x2="380" y2="106" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="660" y1="76" x2="660" y2="106" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="20" y="106" width="160" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="100" y="122" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">isRawModelRun?</text>
  <text x="100" y="138" text-anchor="middle" font-size="10" fill="#64748b">harness 策略判断</text>
  <rect x="300" y="106" width="160" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="380" y="122" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">isCliProvider?</text>
  <text x="380" y="138" text-anchor="middle" font-size="10" fill="#64748b">CLI 执行 provider 判断</text>
  <rect x="580" y="106" width="160" height="40" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="660" y="122" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">默认 (embedded pi)</text>
  <text x="660" y="138" text-anchor="middle" font-size="10" fill="#64748b">其余情况</text>
  <line x1="100" y1="146" x2="100" y2="176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="380" y1="146" x2="380" y2="176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="660" y1="146" x2="660" y2="176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="20" y="176" width="160" height="60" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="100" y="196" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">强制 pi harness</text>
  <text x="100" y="214" text-anchor="middle" font-size="10" fill="#64748b">跳过 CLI 包装，</text>
  <text x="100" y="228" text-anchor="middle" font-size="10" fill="#64748b">直走 embedded pi</text>
  <rect x="300" y="176" width="160" height="60" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="196" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">runCliAgent</text>
  <text x="380" y="214" text-anchor="middle" font-size="10" fill="#64748b">claude-cli 等外部</text>
  <text x="380" y="228" text-anchor="middle" font-size="10" fill="#64748b">CLI 工具</text>
  <rect x="580" y="176" width="160" height="60" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="660" y="196" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">runEmbeddedPiAgent</text>
  <text x="660" y="214" text-anchor="middle" font-size="10" fill="#64748b">内嵌 pi-agent，</text>
  <text x="660" y="228" text-anchor="middle" font-size="10" fill="#64748b">真正调 LLM provider</text>
</svg>
<span class="figure-caption">图 R7.3 ｜ runAgentAttempt 三条 runner 路径：按 harness 策略和 CLI provider 判断分流，默认走内嵌 pi-agent 直接调 LLM</span>

<details>
<summary>ASCII 原版</summary>

```
            runAgentAttempt
                  │
   ┌──────────────┼──────────────────────┐
   │              │                      │
isRawModelRun?  isCliProvider?       默认 (embedded pi)
   │              │                      │
 强制 pi      runCliAgent          runEmbeddedPiAgent
 harness     (claude-cli 等         (内嵌 pi-agent，
              外部 CLI 工具)         真正调 LLM provider)
```

</details>

判定逻辑（`src/agents/command/attempt-execution.ts:430-485`）：

1. **harness 策略**：`resolveAvailableAgentHarnessPolicy`（`src/agents/command/attempt-execution.ts:438-446`）算出该 provider/model 用哪个 agent harness（运行时框架）。
2. **CLI 执行 provider**：`resolveCliRuntimeExecutionProvider`（`src/agents/command/attempt-execution.ts:430-437`）判断是否要走外部 CLI 工具。
3. **auth 计划**：`resolveHarnessAuthProfileSelection`（`src/agents/command/attempt-execution.ts:447-458`）+ `buildAgentRuntimeAuthPlan`（`src/agents/command/attempt-execution.ts:459-469`）算出 `authProfileId`——如果 session 没钉 profile，就调 `resolveAuthProfileOrder` 取第一个（`src/agents/command/attempt-execution.ts:180-184`），这正是 7.5.2 选序的落点。

**CLI 路径**（`src/agents/command/attempt-execution.ts:485-627`）：当 `isCliProvider(cliExecutionProvider, cfg)` 为真，走 `runCliAgent`。这条路径还有一套精细的 **CLI session 复用与失效处理**：claude-cli 这类外部工具自己维护 session id，OpenClaw 通过 `getCliSessionBinding` / `setCliSessionBinding`（`src/agents/command/attempt-execution.ts:486`、`:586`）把外部 session id 绑在 `sessionEntry` 上复用。如果复用的 CLI session 已过期（`FailoverError` with `reason === "session_expired"`，`src/agents/command/attempt-execution.ts:556-603`），就 `clearCliSessionInStore` 清掉绑定、用全新 session 重跑，并把新 session id 回写落盘。`shouldClearReusedCliSessionAfterError`（`src/agents/command/attempt-execution.ts:53-58`）还覆盖了 AbortError 和其它非过期失败的清理。

**embedded pi 路径**（`src/agents/command/attempt-execution.ts:629-691`）：默认路径，调 `runEmbeddedPiAgent`。这是内嵌的 `pi-agent` 运行时，**真正发起 HTTP LLM 调用、处理流式响应、执行工具调用**就发生在这里（详见第 08 章 provider-runtime 部分）。`runAgentAttempt` 把约 50 个参数传进去：prompt、images、`clientTools`、`provider`/`model`、`modelFallbacksOverride`、`authProfileId`、`thinkLevel`、`fastMode`、`timeoutMs`、`abortSignal`、`onAgentEvent` 回调等等。

**ACP 路径**：这条不在 `runAgentAttempt` 里，而在 `agentCommandInternal` 更早的分支（`src/agents/agent-command.ts:540-679`）。当 `acpResolution?.kind === "ready"`，运行直接交给 `acpManager.runTurn`，通过 `onEvent` 回调把 ACP 的 text_delta、tool_call 等事件转译成 agent 事件（见 7.8）。ACP 是把整个 turn 委托给一个外部 agent 进程的协议。

### 7.7.4 live model switch 重试

最外层 `for (;;)` 循环（`src/agents/agent-command.ts:1113`）是为了捕获 `LiveSessionModelSwitchError`（`src/agents/agent-command.ts:1315`）。**场景**：一个 subagent 运行到一半，会话被实时切到另一个模型。捕获后（`src/agents/agent-command.ts:1315-1395`）：

- 校验新模型是否在 allowlist（`visibilityPolicy.allowsKey`，不在则抛错，`src/agents/agent-command.ts:1341-1363`）；
- 重试次数超过 `MAX_LIVE_SWITCH_RETRIES = 5`（`src/agents/agent-command.ts:1100`、`:1317`）则放弃；
- 否则更新 `provider`/`model`/`authProfileId`，`continue` 回到循环顶重跑整个 fallback 流程。

这与 `runWithModelFallback` 的"故障 fallback"是两种不同的重试：fallback 是"模型坏了换一个"，live switch 是"会话被人为切了模型"。

---

## 7.8 事件发射

agent 运行的整个过程通过 `src/infra/agent-events.ts`（312 行）对外广播事件。这是 OpenClaw 把"内部执行进度"暴露给 Control UI、渠道流式回显、诊断 timeline 的统一通道。

### 7.8.1 事件模型

一个事件是 `AgentEventPayload`（`src/infra/agent-events.ts:102-109`）：

```ts
export type AgentEventPayload = {
  runId: string;        // 哪一次运行
  seq: number;          // 同一 run 内单调递增序号
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};
```

`stream` 是事件分类（`src/infra/agent-events.ts:5-17`）：`lifecycle` / `tool` / `assistant` / `error` / `item` / `plan` / `approval` / `command_output` / `patch` / `compaction` / `thinking`，且类型是开放的 `(string & {})` 允许扩展。各 stream 的语义：

| stream | 含义 | 典型 data |
| --- | --- | --- |
| `lifecycle` | 运行开始/结束/出错 | `{ phase: "start"\|"end"\|"error", startedAt, endedAt, stopReason, aborted }` |
| `assistant` | 助手文本（含流式增量） | `{ text, delta }` |
| `item` | 一个工作项的生命周期 | `AgentItemEventData`（`src/infra/agent-events.ts:29`） |
| `plan` | 计划更新 | `AgentPlanEventData`（`src/infra/agent-events.ts:49`） |
| `approval` | 工具/命令审批 | `AgentApprovalEventData`（`src/infra/agent-events.ts:61`） |
| `command_output` | shell 命令输出（增量） | `AgentCommandOutputEventData`（`src/infra/agent-events.ts:77`） |
| `patch` | 文件改动摘要 | `AgentPatchSummaryEventData`（`src/infra/agent-events.ts:90`） |

### 7.8.2 emit 与序号

`emitAgentEvent`（`src/infra/agent-events.ts:209-235`）是所有发射的底座。它做三件事：

1. 给该 `runId` 的 seq +1（`src/infra/agent-events.ts:211-212`），保证同一运行内事件**严格有序**；
2. 刷新该 run 的 `lastActiveAt`（`src/infra/agent-events.ts:213-216`），供 TTL 清理用；
3. `notifyListeners` 广播给所有订阅者（`src/infra/agent-events.ts:234`）。

针对各 stream 还有便捷函数：`emitAgentItemEvent`（`src/infra/agent-events.ts:237`）、`emitAgentPlanEvent`（`:250`）、`emitAgentApprovalEvent`（`:263`）、`emitAgentCommandOutputEvent`（`:276`）、`emitAgentPatchSummaryEvent`（`:289`），它们都只是用固定 `stream` 调 `emitAgentEvent`。

### 7.8.3 run context 与可见性

事件系统维护一个 `runContextById` 映射（`src/infra/agent-events.ts:123-127`），由 `registerAgentRunContext`（`src/infra/agent-events.ts:139-170`）登记。`agentCommandInternal` 在运行开始时登记（`src/agents/agent-command.ts:543-545`、`:686-690`），`finally` 里 `clearAgentRunContext`（`src/agents/agent-command.ts:1564`）清掉。

run context 里有一个关键字段 `isControlUiVisible`。`emitAgentEvent` 用它决定**是否把 `sessionKey` 一并广播**（`src/infra/agent-events.ts:217-227`）：

```ts
const isControlUiVisible = context?.isControlUiVisible ?? true;
// 隐藏渠道的运行不应把 assistant/tool 流量泄漏进 Control UI，
// 但 lifecycle 事件仍需带 sessionKey，好让 gateway 监听器能持久化终态。
const preserveSessionKey = isControlUiVisible || event.stream === "lifecycle";
const sessionKey = preserveSessionKey ? (eventSessionKey ?? context?.sessionKey) : undefined;
```

**为什么**：有些运行是"隐藏"的（如后台 heartbeat），不该让它的助手文本、工具调用实时刷进 Control UI。但 `lifecycle` 事件是例外——即使隐藏，gateway 监听器也必须知道这个 session 何时结束/失败，才能持久化终态 session 状态。所以 lifecycle 始终保留 `sessionKey`，其它 stream 对隐藏运行则抹掉。

`sweepStaleRunContexts`（`src/infra/agent-events.ts:186-202`）按 TTL（默认 30 分钟）清理孤儿 run context——防止 lifecycle 的 `end`/`error` 事件丢失导致 context 永久泄漏。

### 7.8.4 谁发射、谁订阅

**发射方**遍布执行链：

- `agentCommandInternal` 直接发 `lifecycle` 事件——成功结束（`src/agents/agent-command.ts:1301-1311`）、出错（`:1396-1407`）、live switch 失败（`:1322-1331`）。
- ACP 路径通过 `attempt-execution.ts` 的一组 `emitAcp*` 函数：`emitAcpLifecycleStart`（`src/agents/command/attempt-execution.ts:713`）、`emitAcpPromptSubmitted`（`:782`）、`emitAcpRuntimeEvent`（`:795`）、`emitAcpLifecycleEnd`（`:811`）、`emitAcpLifecycleError`（`:822`）、`emitAcpAssistantDelta`（`:842`）。
- embedded pi runner 内部在工具调用、流式增量等节点发 `tool`/`assistant`/`item` 事件，并通过 `onAgentEvent` 回调把 lifecycle 状态回传给 `agentCommandInternal`（`src/agents/agent-command.ts:1226-1234`，用于设置 `lifecycleEnded` 标志，避免重复发 lifecycle end）。

**订阅方**通过 `onAgentEvent(listener)`（`src/infra/agent-events.ts:302-305`）注册：

- Control UI 的 gateway 把事件流推给前端做实时渲染；
- 渠道流式回显（streaming reply）订阅 `assistant` 增量，边生成边往 IM 渠道推；
- 诊断 timeline 订阅全量事件做事后追溯。

事件系统用 `resolveGlobalSingleton`（`src/infra/agent-events.ts:131-137`）保证整个进程共享同一份 listener 集合与 seq 表——它是一个进程级单例。

---

## 7.9 收尾：session 回写与投递

attempt 跑完、`for` 循环 `break` 后（`src/agents/agent-command.ts:1412` 起），还有三步收尾：

1. **session store 回写**（`src/agents/agent-command.ts:1414-1436`）：`updateSessionStoreAfterAgentRun` 把 token 用量、最终使用的 `fallbackProvider`/`fallbackModel` 写回 session。注意 heartbeat 运行 `preserveRuntimeModel: true`——后台心跳不该污染 session 的"运行时模型"记录。

2. **transcript 持久化 + compaction**（`src/agents/agent-command.ts:1438-1486`）：CLI runner 和 embedded gap-fill 场景需要补写 transcript（`persistCliTurnTranscript`，`src/agents/command/attempt-execution.ts:324`），随后 `runCliTurnCompactionLifecycle` 视情况触发历史压缩。

3. **投递**（`src/agents/agent-command.ts:1488-1562`）：在投递前，对非 subagent 的 main session 会先把待投递的最终响应**持久化**进 `pendingFinalDelivery`（`src/agents/agent-command.ts:1492-1524`）——这样即使进程在投递途中崩溃，payload 仍可恢复。`deliverAgentCommandResult`（`src/agents/agent-command.ts:1526-1536`）真正把响应推回渠道；投递成功后再清掉 `pendingFinalDelivery`（`src/agents/agent-command.ts:1539-1560`）。

整个 `agentCommandInternal` 的 `try` 块外是 `finally { clearAgentRunContext(runId) }`（`src/agents/agent-command.ts:1563-1565`），无论成功失败都清理 run context。

---

## 7.10 小结

本章追踪了一条 agent 运行请求从 `agentCommand` 入口到响应投递的完整路径：

- **信任边界**：`agentCommand`（本地默认 owner）与 `agentCommandFromIngress`（强制显式声明）通过两个布尔字段在边界上区分信任级别。
- **准备阶段**：`prepareAgentCommandExecution` 解析 agent（显式 > session key 推断 > 默认）、session、workspace、timeout，并判定是否走 ACP。
- **模型选择**：四层来源——配置默认 → session 持久化覆盖 → 本次显式覆盖 → allowlist 收敛；auto-fallback primary probe 负责在 primary 恢复后自动解除自动 fallback。
- **auth profile**：`resolveAuthProfileOrder` 给出有序候选凭证；冷却按错误次数指数退避；多 profile 在受限时自动绕开实现凭证 fallback。
- **attempt 执行**：外层 `runWithModelFallback` 处理模型故障 fallback，内层 `runAgentAttempt` 在 embedded pi / 外部 CLI / ACP 三条 runner 间分流；最外层 `for` 处理 live model switch。
- **事件发射**：`agent-events.ts` 用 per-run 单调 seq 广播 `lifecycle`/`assistant`/`tool` 等多 stream 事件，`isControlUiVisible` 控制隐藏运行的事件可见性。

下一章进入 attempt 真正调 LLM 的内核——LLM provider 作为 extension 插件的集成机制。
