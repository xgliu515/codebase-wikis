## 第 7 章 会话与容器生命周期

> 关联代码版本：`nanocoai/nanoclaw@0683c6e`（v2.0.64）
>
> 入口文件：`src/session-manager.ts`、`src/container-runner.ts`、`src/container-runtime.ts`、`src/container-restart.ts`、`src/container-config.ts`、`src/group-init.ts`、`src/circuit-breaker.ts`、`src/claude-md-compose.ts`、`container/Dockerfile`、`container/build.sh`、`container/entrypoint.sh`

NanoClaw 在第 6 章把"消息怎么落到 inbound.db"讲清楚了，但还没回答一个更基础的问题：**那个会读 inbound.db 的进程是谁、什么时候启动、跑在哪里、跑完去哪里**。本章是这个问题的完整答卷。

---

### 7.1 设计问题

把 NanoClaw 想象成一个微型 SaaS：每个 agent group（"GitHub 助手"、"个人秘书"、"客服机器人"）都要一个 24×7 在线的"独立人格"。如果用一个长跑的进程来扛所有 agent group，会立刻撞上四类难题：

1. **隔离**
   - 工作目录隔离：agent 写文件不能相互覆盖。
   - Claude 上下文隔离：每个 group 维护自己的 `.jsonl` transcript、`.claude` state、settings。
   - 代码执行隔离：agent 会跑 `Bash`、`pnpm install`、`playwright`。一个 group 的 `rm -rf /` 不能波及另一个 group，更不能波及 host。
   - 网络/凭证隔离：HTTP 请求要走各 group 自己的 OneCLI agent，得到的密钥也只属于那个 agent。

2. **热启动**
   - 用户在 Telegram 发一句"明天提醒我"，按下回车的 1 秒内要看到 agent 在"输入中"。容器拉起、agent SDK 初始化必须在这 1 秒内完成；否则要有 fallback。

3. **可重启**
   - `install_packages` 之后，container image 变了，必须 kill 旧的、拉新的。
   - 重启过程中新到的消息不能丢；同时不能让"还在 SIGTERM grace period 里的旧容器"偷走"专门为新容器准备的 on_wake 消息"。

4. **orphan 回收**
   - Host 进程崩了重启后，上一轮跑剩下的容器会成为 zombie：占内存、占 docker name、可能还会继续往 outbound.db 写消息。host 必须知道怎么扫干净。
   - 多个 NanoClaw 安装（比如开发机上同时跑 prod 和 dev）共用一个 docker daemon 时，A 安装不能误杀 B 安装的容器。

NanoClaw 给出的答案是：**一个 session 一个容器，每次启动都是新进程**。session 在 host 端管，container 在 docker（或 Apple container）那一侧跑。下面我们顺着代码自上而下走一遍。

---

### 7.2 Session 模型

#### 7.2.1 表与查询

central DB 里 `sessions` 表的列在第 5 章已经列过；这里关注几条关键查询。

`src/session-manager.ts:92` 的 `resolveSession()` 是所有 session 的唯一入口：

```ts
export function resolveSession(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: 'shared' | 'per-thread' | 'agent-shared',
): { session: Session; created: boolean }
```

`sessionMode` 决定查找键：

| sessionMode | 查找键 | 典型用法 |
|-------------|--------|----------|
| `shared`     | `(agent_group_id, messaging_group_id)`           | 一个 Slack channel 一个 session，threads 合并到同一上下文 |
| `per-thread` | `(agent_group_id, messaging_group_id, thread_id)` | Discord forum thread、Telegram topic：每个 thread 单独 session |
| `agent-shared` | `(agent_group_id)`                              | 同一个 agent group 跨多 channel 共享一个 session（GitHub + Slack 同一思路） |

`agent-shared` 分支特别走 `findSessionByAgentGroup`（`src/session-manager.ts:99-103`）；剩下两种走 `findSessionForAgent`。**注意 lookup 是按 `agent_group_id` scope 的**（注释见 `:105-108`）：同一个 Slack channel 里挂了两个 agent group 时，每个 agent 各有一份 session 行，互不串扰。

找不到时第 114-128 行构造一个新 `Session`，落库 + 创建会话目录。

#### 7.2.2 会话目录与两个 DB

`sessionDir`、`inboundDbPath`、`outboundDbPath`、`heartbeatPath` 四个 helper 在 `src/session-manager.ts:47-69` 给出唯一的真相源：

```
data/v2-sessions/
  <agent_group_id>/
    <session_id>/
      inbound.db    ← host 写
      outbound.db   ← container 写
      .heartbeat    ← container 触摸
      inbox/<message_id>/<filename>   ← host 落附件
      outbox/<message_id>/<filename>  ← container 落附件
    .claude-shared/                   ← group 级 Claude state（settings.json、skills/）
```

`initSessionFolder()`（`:136-143`）创建目录并对两个 DB 调 `ensureSchema()`，决定了 `journal_mode=DELETE`（DB 模式细节见第 6 章）。

#### 7.2.3 lazy open + 立刻 close

文件顶端的 12 行 docstring 写得很清楚：**host 端永远是"打开 → 写 → 关闭"**。所有写消息的接口（`writeSessionMessage` `:193-250`、`writeOutboundDirect` `:382-403`、`writeSystemResponse` `:413-431`）都遵守 `try / finally { db.close(); }` 的模板。原因有三条，重述一遍：

1. **WAL 不可用**：cross-mount 时 `-shm` mmap 不会同步，所以必须 `journal_mode=DELETE`。
2. **不关 = 容器读不到**：host 不 close 就不会触发 journal unlink，container 那侧的 page cache 永远停在第一次读取时的快照。
3. **单写者**：DELETE 模式下并发 writer 在跨 mount 时会损坏文件。

`openInboundDb` / `openOutboundDb`（`:361-375`）是给短期操作用的；container 那一侧（第 8 章）会有截然不同的连接复用策略——host 永远是短连接，container 永远是长连接 + readonly。

#### 7.2.4 附件下盘

`writeSessionMessage` 接到一条 chat 消息时，先把 base64 的 `attachments[].data` 拆出来落到 `inbox/<message_id>/`，然后用 `localPath` 字段替换 `data`，再写 messages_in 行。这一步在 `extractAttachmentFiles()`（`:270-358`），有四层防御：

- `isSafeAttachmentName(messageId)` 拦截 `../` 风格的 message id；
- `lstat` inbox 目录拒绝 pre-placed symlink（容器有 RW 挂载，恶意 agent 可以提前埋符号链接等 host 跟进来写）；
- `realpath` containment 校验；
- `writeFileSync(..., { flag: 'wx' })` 排他创建，拒绝 follow symlink。

文件名靠 `src/attachment-naming.ts:60` 的 `deriveAttachmentName` 计算：先看 `att.name`，再 MIME → 扩展名映射（`MIME_TO_EXT` 表，jpg/png/webp 等），再 `att.type` 兜底（Telegram 的 photo/sticker/voice）。最终输出仍要过 `isSafeAttachmentName` 校验，所以 derive 函数本身不能构造越权路径。

#### 7.2.5 状态机

```
                wakeContainer() succeeds
created  ───────────────────────────────────┐
   │                                        ▼
   │                                     active (heartbeat 持续)
   │     no due messages, container exits   │
   ▼                                        ▼
 stopped  ◄────────────  idle  ────────  on close()
   ▲                       ▲
   │  killContainer        │  no follow-up within
   │  (host-sweep / restart)│  poll loop's natural drain
   └───────────────────────┘
```

DB 上对应的字段是 `container_status` 三态：`stopped` / `running` / `idle`，由 `markContainerRunning` / `markContainerIdle` / `markContainerStopped` 三个 helper 维护（`:531-543`）。注意：v2.0.64 的代码**没有 host 端的 wall-clock idle 超时**——`spawnContainer` 的注释（`src/container-runner.ts:172-175`）写明放弃了"按时长 kill"的逻辑，改由 `host-sweep` 综合 heartbeat 文件 mtime + processing_ack claim age 来判断（细节在第 10 章）。

---

### 7.3 `wakeContainer` 与 `spawnContainer`

#### 7.3.1 公开接口：`wakeContainer`

`src/container-runner.ts:85-106`：

```ts
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) return existing;
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => { /* host-sweep retries */ return false; })
    .finally(() => { wakePromises.delete(session.id); });
  wakePromises.set(session.id, promise);
  return promise;
}
```

合同（文件第 73-84 行注释）：

- **永不抛**。返回 `true`/`false` 给关心结果的 caller（例如 router 的 typing indicator），其它人忽略也无所谓。
- 已经在跑：直接返回 `true`。
- 正在 spawn 中：复用同一个 `wakePromises` 里的 promise——这是 v2.0 才加的 dedup（详细原因见 `:54-63` 注释）。**没有这个 dedup，两个并发 `wakeContainer` 调用会撞过 `activeContainers.has` 检查、双开容器、双写 outbound、双回复用户。**

`activeContainers` 是 host 进程内的 `Map<sessionId, { process, containerName }>`（`:53`）。两个数据源：DB 里的 `container_status` 列、以及这个内存表。host 重启后 DB 行还在，但内存表清空——所以下一节 `cleanupOrphans` 必须负责扫清留在 docker 那侧的 zombie。

#### 7.3.2 `spawnContainer` 流程

按 `src/container-runner.ts:108-190` 顺序拆解：

| 步骤 | 行号 | 做了什么 |
|------|------|----------|
| 1. 取 agent group | 108-113 | `getAgentGroup`；找不到放弃 |
| 2. 刷 destinations（如果 a2a 模块装了） | 117-121 | `writeDestinations` 写入 inbound.db |
| 3. 刷 session routing | 122 | `writeSessionRouting` 写默认回复路由 |
| 4. 物化 container.json | 127 | `materializeContainerJson(agentGroup.id)` |
| 5. 选 provider + 取 host-side 贡献 | 132 | `resolveProviderContribution` |
| 6. 组装 mounts | 134 | `buildMounts(...)`（见 7.4） |
| 7. 生成 container 名 | 135 | `nanoclaw-v2-<folder>-<timestamp>` |
| 8. agent identifier | 138 | 永远 = agent group id（OneCLI 用） |
| 9. 拼 docker args | 139-147 | `buildContainerArgs(...)` |
| 10. 清旧 heartbeat | 155 | `fs.rmSync(heartbeatPath(...))` |
| 11. spawn | 157 | `spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })` |
| 12. 登记 | 159-160 | 写 `activeContainers` + `markContainerRunning` |
| 13. 绑事件 | 163-189 | stderr → log.debug；close → 清表 + stopTypingRefresh |

第 10 步（清旧 heartbeat）容易被误解：注释（`:151-155`）解释，host-sweep 的 ceiling 检查在 heartbeat 文件**缺失**时给"宽限期"，但在文件存在却 mtime 很旧时立刻 kill。如果上一轮容器留下了一个旧 heartbeat，新容器在第一次 touch 之前会被 sweep 误杀。所以 spawn 前先 `rm -f`。

`spawn()` 用 stdio `['ignore', 'pipe', 'pipe']`：v2 里 host 和 container 之间**不走 stdin**，所有 IO 都在 DB 里。stderr 转发到 host log（用于 debug），stdout 故意丢弃。entrypoint.sh 那个 `cat > /tmp/input.json` 是 v1 残留——v2 写了空字符串进去，agent-runner 不读。

> 第 8 章会展开 agent-runner 的入口；这里只需要知道 spawn 出去后约 200-500ms 内容器就会 touch heartbeat、开始 `getPendingMessages` 轮询。

#### 7.3.3 `wakeContainer` vs `spawnContainer` 的区别

- `wakeContainer` 是公开接口，**幂等 + dedup + 永不抛**。所有 caller（router、host-sweep、container-restart、self-mod、scheduling）都调它。
- `spawnContainer` 是内部实现，**会抛**（`OneCLI gateway not applied` 等）。只有 `wakeContainer` 调它，被 `.catch` 包住转成 boolean。

#### 7.3.4 OneCLI gateway 注入

`buildContainerArgs`（`:399-465`）里有一段是绕不开的：

```ts
if (agentIdentifier) {
  await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
}
const onecliApplied = await onecli.applyContainerConfig(args, {
  addHostMapping: false,
  agent: agentIdentifier,
});
if (!onecliApplied) {
  throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
}
```

`ensureAgent` 在 OneCLI 那边创建/更新一个 agent 记录（identifier = agent group id，可逆查询用）；`applyContainerConfig` 往 args 里追加 `HTTPS_PROXY`、`NO_PROXY`、CA cert 挂载等。失败就抛——message 留在 pending 状态，下一次 sweep 重试。这是合同里"transient hard failure"的具体含义。

> 注意 CLAUDE.md 中提到的一个坑（root 文档"Container Config"节）：OneCLI 新建的 agent 默认是 `selective` 模式，**不会自动绑定任何 vault secret**。第一次跑会拿到 401。须用 `onecli` CLI 或 web UI 改成 `wildcard` 或显式 attach。

---

### 7.4 Mounts、container.json、CLAUDE.md

#### 7.4.1 Mount 列表

`buildMounts`（`src/container-runner.ts:242-335`）按下表挂载：

| host 路径 | container 路径 | 模式 | 说明 |
|-----------|----------------|------|------|
| `data/v2-sessions/<group>/<session>/` | `/workspace` | RW | inbound.db、outbound.db、outbox/、inbox/、.heartbeat |
| `groups/<folder>/` | `/workspace/agent` | RW | working dir、CLAUDE.local.md、conversations/ |
| `groups/<folder>/container.json` | `/workspace/agent/container.json` | RO | 嵌套 RO 屏蔽 agent 写配置 |
| `groups/<folder>/CLAUDE.md` | `/workspace/agent/CLAUDE.md` | RO | composed entry，写会被下次覆盖 |
| `groups/<folder>/.claude-fragments/` | `/workspace/agent/.claude-fragments` | RO | skill / mcp fragments |
| `groups/global/` | `/workspace/global` | RO | 全局只读记忆 |
| `container/CLAUDE.md` | `/app/CLAUDE.md` | RO | 共享 base |
| `data/v2-sessions/<group>/.claude-shared/` | `/home/node/.claude` | RW | settings.json、skill symlinks、SDK state |
| `container/agent-runner/src/` | `/app/src` | RO | agent-runner 源码 |
| `container/skills/` | `/app/skills` | RO | 共享 skills |
| 用户配置 additionalMounts | `/workspace/extra/<name>` | 视 allowlist | mount-security 校验 |
| provider contribution mounts | provider 决定 | provider 决定 | 比如 opencode-xdg |

几条值得专门说：

- **`.claude-shared`** 在 host 端的位置是 `data/v2-sessions/<group_id>/.claude-shared/`——注意不是 session 子目录，是 group 子目录。它装 `settings.json` 和 `skills/` 软链。每个 group 共享一个，跨 session 复用 Claude state。
- **`agent-runner-src` overlay**：CLAUDE.md / SPEC.md 多处提到"per-group `agent-runner-src/` overlay 可以覆盖默认 agent-runner"——v2.0.64 代码里这一段被简化成 `container/agent-runner/src/` 永远 RO 挂在 `/app/src`，是所有 group 共用的；**v2.0.64 没有 per-group overlay 实现**。如果 self-mod 后续做了真正的源码级 self-edit（CLAUDE.md self-mod 节最后一段提到"a second tier ... is planned but not yet implemented"），overlay 会是它的物化形式。

#### 7.4.2 Skill symlink 同步

`syncSkillSymlinks`（`:342-397`）每次 spawn 都执行：

1. 列出当前 `.claude-shared/skills/` 里的 symlink；
2. 对照 `container.json` 的 `skills` 字段（`['all']` 或显式数组）算出 desired set；
3. 删除多余的 symlink；
4. 为新增的 skill 创建指向 `/app/skills/<name>` 的符号链接（注意 target 是**容器内路径**，host 上是悬空 symlink，正常）。

`container.json.skills = "all"` 时 desired 在每次 spawn 都重新扫 `container/skills/` 目录——新加的 skill 自动生效，不用改任何配置。

#### 7.4.3 CLAUDE.md 组装

`composeGroupClaudeMd`（`src/claude-md-compose.ts:43-136`）每次 spawn 跑一次，输出物：

```
groups/<folder>/
  CLAUDE.md                ← 组合后的入口，只 import
  .claude-shared.md        ← symlink → /app/CLAUDE.md（容器内可达）
  .claude-fragments/
    skill-<name>.md        ← symlink → /app/skills/<name>/instructions.md
    module-<name>.md       ← symlink → /app/src/mcp-tools/<name>.instructions.md
    mcp-<name>.md          ← 内联 instructions（来自 container.json）
  CLAUDE.local.md          ← per-group 长记忆，永不被覆盖
```

`CLAUDE.md` 的内容是确定性的：

```
<!-- Composed at spawn — do not edit. Edit CLAUDE.local.md for per-group content. -->
@./.claude-shared.md
@./.claude-fragments/mcp-foo.md
@./.claude-fragments/module-scheduling.md
@./.claude-fragments/skill-onecli-gateway.md
```

`@` 是 Claude Code 的 import 语法。这种"宿主重写、agent 只能 import" 的做法解决两个问题：

1. shared base 的更新（`container/CLAUDE.md`）自动覆盖到所有 group；
2. agent 不能给自己改注入的 instructions——CLAUDE.md 是 RO mount，写会失败。

CLI scope（`disabled`/`group`/`global`）在 `:83-95` 影响 module 列表：`cli_scope=disabled` 时 `cli.instructions.md` 不进 fragments，agent 完全感知不到 `ncl` 的存在。

#### 7.4.4 Mount 安全：additionalMounts

agent group 可以在 `container.json` 里申请额外挂载（"把我的 ~/projects 挂进来"）。这是攻击面，所以 `src/modules/mount-security/index.ts` 做三层防御：

1. **Allowlist 必须存在**（`MOUNT_ALLOWLIST_PATH`，位于 `~/.config/nanoclaw/mount-allowlist.json`，**项目根目录之外**——container agent 写不到）。文件不存在 → 拒绝所有 additionalMounts。
2. **Blocked patterns**：`.ssh`、`.gnupg`、`.aws`、`credentials`、`id_rsa` 等（`DEFAULT_BLOCKED_PATTERNS` 第 39-57 行），合并用户自定义的 `blockedPatterns`。任何路径分量命中即拒。
3. **Allowed roots**：必须落在用户在 allowlist 里声明的根目录下；每个根可以独立声明 `allowReadWrite`，否则强制 RO（`:289-298`）。
4. **Container path 校验**（`isValidContainerPath` `:194-216`）：禁 `..`、绝对路径、空、冒号（防 `-v` 选项注入）。

校验通过的 mount 全部落在 `/workspace/extra/<basename>` 下（`:334`）。`container/agent-runner/src/index.ts:56-69` 扫这个目录把每个子目录加进 `additionalDirectories`，传给 Claude SDK 让 agent 能 read 这些路径。

---

### 7.5 容器运行时抽象

`src/container-runtime.ts` 是整个 host 与 docker/Apple container 交互的边界，全文 90 行。

```ts
export const CONTAINER_RUNTIME_BIN = 'docker';

export function hostGatewayArgs(): string[] {
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}
```

`stopContainer` 用 `-t 1`（1 秒 SIGTERM grace）。从这里能看到一个隐含设计：**容器收到 SIGTERM 后必须在 1 秒内完成 outbound.db 落盘**，否则被 SIGKILL。tini（Dockerfile `:52` 安装的）做 PID 1，负责 signal forwarding 给 `bun`；agent-runner 的 finalize 路径必须够轻。

#### 7.5.1 启动检查

`ensureContainerRuntimeRunning()`（`:37-58`）在 `src/index.ts` host 启动时调一次：试 `docker info`，超时 10 秒。失败就打印一个 FATAL banner（`:46-53`）然后抛。host 不会"半挂"运行。

> Apple container 想替 docker？v2.0.64 的代码硬编码 `CONTAINER_RUNTIME_BIN = 'docker'`。要切换实际上是把这行改成 `container`、把 `hostGatewayArgs` 调整成 Apple container 的等价物。`docs/APPLE-CONTAINER-NETWORKING.md` 说明了用 Apple container 时必须做的 macOS 26 网络设置（IP forwarding、pfctl NAT、`NODE_OPTIONS=--dns-result-order=ipv4first` 强制 IPv4）。

#### 7.5.2 Orphan 回收

`cleanupOrphans()`（`:67-90`）：

```ts
const output = execSync(
  `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
  { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
);
const orphans = output.trim().split('\n').filter(Boolean);
for (const name of orphans) {
  try { stopContainer(name); } catch { /* already stopped */ }
}
```

**用 label `nanoclaw-install=<slug>` 隔离多个 NanoClaw 安装**。`CONTAINER_INSTALL_LABEL` 由 `src/install-slug.ts` 从项目根路径派生（hash 后取前若干字符），所以两台同一台 host 上的安装（比如开发机上的 prod/dev）有不同的 label，互不可见。

调用时机：

- `src/index.ts` host 启动时调一次（host crash 后 cleanup）；
- 可能在周期任务里调（具体在第 10 章 host-sweep 节）。

---

### 7.6 Kill + Respawn：`container-restart.ts`

第三方场景驱动重启：

- `install_packages` 通过后，image 变了；
- `add_mcp_server` 通过后，container.json 变了；
- `ncl groups restart --id <group>` 手动；
- self-mod 改了文件需要重新加载。

`src/container-restart.ts`（全 59 行）：

```ts
export function restartAgentGroupContainers(
  agentGroupId: string,
  reason: string,
  wakeMessage?: string,
): number {
  const sessions = getSessionsByAgentGroup(agentGroupId).filter(
    (s) => s.status === 'active' && isContainerRunning(s.id),
  );

  for (const session of sessions) {
    if (wakeMessage) {
      writeSessionMessage(agentGroupId, session.id, {
        id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: agentGroupId,
        channelType: 'agent',
        threadId: null,
        content: JSON.stringify({ text: wakeMessage, sender: 'system', senderId: 'system' }),
        onWake: 1,   // ← 关键
      });
    }
    killContainer(
      session.id,
      reason,
      wakeMessage
        ? () => {
            const s = getSession(session.id);
            if (s) wakeContainer(s);
          }
        : undefined,
    );
  }
  return sessions.length;
}
```

#### 7.6.1 `on_wake` 防偷窃

container A 收到 SIGTERM 后还有 1 秒 grace period，期间它的 poll loop 可能再扫一次 inbound.db。如果 wake message 没有 `on_wake=1`，A 就会捡走然后立刻死掉，新生的 B 拿不到——用户看不到"已重启，可以继续了"那条消息。

`on_wake=1` 的含义（DB 层在 `container/agent-runner/src/db/messages-in.ts:65-97`）：

```sql
WHERE status = 'pending'
  AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
  AND (on_wake = 0 OR ?1 = 1)
```

`?1` 是 `isFirstPoll`——只在 container 启动的第一次 poll 里传 1。其它 poll 看不到 `on_wake=1` 的行。**dying container 早已过了 first poll，所以这个查询自动排除掉 on_wake 行**。

#### 7.6.2 `killContainer` 的 `onExit`

`src/container-runner.ts:193-207`：

```ts
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;
  if (onExit) entry.process.once('close', onExit);
  try { stopContainer(entry.containerName); }
  catch { entry.process.kill('SIGKILL'); }
}
```

`onExit` 注册在 child process 的 `close` 事件上——只有 docker 容器真正退出、host 端 `spawn` 出来的子进程关 stdio 后才触发。回调里再 `wakeContainer(session)`。这样**串行保证**了"旧的死透 → 新的拉起"。如果没有 `onExit`，A 还没死、`wakeContainer(B)` 立刻执行——`activeContainers.has(session.id)` 还命中（A 没 close 不会从表里删，见 `:177-181`），直接 return `true`，B 永远不会起。

#### 7.6.3 时间线

```
host                 docker             container A           container B
  │                    │                    │                    │
  │ writeSessionMsg(on_wake=1)              │                    │
  ├───────────────────────────────────────►│                    │
  │                    │                    │ (next poll skips,  │
  │                    │                    │  on_wake column)   │
  │ killContainer(A, onExit)                │                    │
  │  stopContainer(A) ─►│  docker stop -t 1 │                    │
  │                    │ ──────SIGTERM────►│                    │
  │                    │                    │ touch heartbeat... │
  │                    │                    │ finalize outbound  │
  │                    │                    │ exit               │
  │                    │ ◄──────exit code──┤                    │
  │  child.on('close') fires                                     │
  │   ↓                                                          │
  │  onExit() → wakeContainer(B)                                 │
  │  spawnContainer(B)                                           │
  │  docker run ───────►│                                        │
  │                    │ ─────────────────────────create────────►│
  │                    │                                         │ touch heartbeat
  │                    │                                         │ isFirstPoll = true
  │                    │                                         │ getPendingMessages()
  │                    │                                         │   → 包含 on_wake=1 行
  │                    │                                         │ process → reply
```

---

### 7.7 Circuit breaker：避免 restart 风暴

`src/circuit-breaker.ts`（84 行）。

```
attempt:    1   2   3    4    5    6+
delay (s):  0   0   10   30   120  300 → 900 (cap)
```

`enforceStartupBackoff()`（`:46-84`）在 host 启动时调用一次：

1. 读 `data/circuit-breaker.json`，没有就 `attempt = 1`；
2. 有：若距上次 < 1 小时，`attempt = prev + 1`；否则 reset 为 1；
3. 写入新的 attempt；
4. `setTimeout(delay)`。

clean shutdown 时（`resetCircuitBreaker()`）删文件。所以：
- 单次崩溃后立刻重启：`attempt=2`，延迟 0；
- 连续崩两次：`attempt=3`，延迟 10 秒；
- 连续 6 次：延迟 900 秒（15 分钟），上限。

> 注意这是**全 host 级别**的 breaker，不是 per-session。一个 group 让 host crash，所有 group 都会陪着 backoff。设计上接受这个权衡——host crash 通常是 bug、配置错或基础设施故障，不该让用户用半残的服务。

> 实现细节：`write()` 里 `fs.mkdirSync(DATA_DIR, { recursive: true })` 是因为 breaker 比 initDb 更早跑，DATA_DIR 可能还不存在。

---

### 7.8 `container_configs` 的物化

`src/container-config.ts:33-46` 定义了 `ContainerConfig`：

```ts
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  effort?: string;
}
```

`materializeContainerJson(agentGroupId)`（`:74-89`）：每次 spawn 都从 `getContainerConfig(agentGroupId)` 读 DB 行，转成上面这个 shape，写进 `groups/<folder>/container.json`（pretty-printed JSON + 末尾换行），然后**返回这个对象**——后续 `buildMounts` / `buildContainerArgs` 用同一对象，避免双重读盘。

container 那一侧的入口（`container/agent-runner/src/config.ts:31-53`）：

```ts
const CONFIG_PATH = '/workspace/agent/container.json';
// ...
raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
_config = {
  provider: (raw.provider as string) || 'claude',
  assistantName: (raw.assistantName as string) || '',
  groupName: (raw.groupName as string) || '',
  agentGroupId: (raw.agentGroupId as string) || '',
  maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
  mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
  model: (raw.model as string) || undefined,
  effort: (raw.effort as string) || undefined,
};
```

为什么走文件而非环境变量？两条原因：

1. **可读性**：agent 自己想看自己的配置，`cat /workspace/agent/container.json` 就行，比拉一长串 `printenv` 直观。
2. **大小**：`mcpServers` 可能很大（每个 server 含 `command`、`args[]`、`env{}`、`instructions`），塞 env 不优雅。

`cli_scope` 字段不在 `RunnerConfig` 里——它只影响 host 端的 CLAUDE.md 组合（决定要不要 import `cli.instructions.md`）和 host 端的 ncl dispatch 校验，container 自己不需要看。

---

### 7.9 Image build

#### 7.9.1 Dockerfile 关键设计

`container/Dockerfile`（132 行）。要点：

- **`FROM node:22-slim`**：固定 Node 22。
- **`ARG INSTALL_CJK_FONTS=false`**（`:17`）：编译时开关，省 ~200MB。
- **CLI 版本全部 pin**：`CLAUDE_CODE_VERSION=2.1.128`、`AGENT_BROWSER_VERSION=latest`（agent-browser 是自家库，跟 nanoclaw 配套迭代）、`VERCEL_VERSION=52.2.1`、`BUN_VERSION=1.3.12`。
- **tini PID 1**（`:130-132`）：`ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]`。`entrypoint.sh` 是 `exec bun ...`，所以 bun 是 tini 的直接子进程、收得到 SIGTERM。
- **agent-runner 源不进镜像**：`/app` WORKDIR 下只装 `package.json` + `bun.lock` 并 `bun install --frozen-lockfile`；源码靠 host 启动时 RO 挂载 `/app/src`。**所以改 agent-runner 源码不需要 rebuild image**——重启容器即可（自动会拿到新代码，因为 mount 是 live 的）。
- **pnpm 必须 pin**（`:99-100`）：注释解释 pnpm 11 不再 honor `only-built-dependencies[]=`，会静默跳过 claude-code 的 native binary 安装。
- **`only-built-dependencies` 名单**：`agent-browser`（有 postinstall build）、`@anthropic-ai/claude-code`（postinstall 下载 native binary）。
- **`/workspace/group` + `/workspace/extra`** 在镜像里 mkdir 好（`:123`），等 host 挂载时填进去。

#### 7.9.2 `build.sh` 的两个 trick

```bash
if [ -z "${INSTALL_CJK_FONTS:-}" ] && [ -f "../.env" ]; then
  INSTALL_CJK_FONTS="$(grep '^INSTALL_CJK_FONTS=' ../.env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
fi
```

- caller 没显式 export 时从 `.env` 读，让 `setup/container.ts` 与 build.sh 两条路径保持一致。
- image 名通过 `setup/lib/install-slug.sh` 的 `container_image_base` 函数生成，匹配 `src/install-slug.ts`——两个不同安装不会撞 tag。

为什么 build.sh 没用 `--no-cache`？因为 BuildKit 的多种 mount cache（apt、pnpm、bun install cache）是缓存层之外的——`--no-cache` 只清 layer cache，clean rebuild 需要的话还得 `docker builder prune` 或 `BUILDKIT_NO_CLIENT_TOKEN=1` 之类组合。这里干脆不提供 `--no-cache`，要彻底重建去 doc 里看 prune 步骤。

#### 7.9.3 Per-agent-group image

`src/container-runner.ts:468-515` 的 `buildAgentGroupImage`：

1. 读 DB 里的 `packages_apt`、`packages_npm`；
2. 拼一个临时 Dockerfile `FROM <base>`，加 apt-get + pnpm install -g 两层；
3. `docker build -t nanoclaw-agent:<agent_group_id> -f tmpDockerfile DATA_DIR`；
4. 把生成的 tag 写回 `container_configs.image_tag`；
5. 下次 spawn `buildContainerArgs` 里 `containerConfig.imageTag || CONTAINER_IMAGE`，自动用新 image。

`only-built-dependencies` 在这里也要逐个 echo 到 `/root/.npmrc`（`:489`）——否则带 native addon 的 npm 包（playwright、puppeteer、native modules）会静默装坏，运行时炸。

---

### 7.10 错误路径与诊断

集中列一遍 spawn 阶段可能挂掉的位置和宿主的应对：

| 错误 | 触发位置 | host 行为 |
|------|---------|----------|
| Agent group 不存在 | `spawnContainer:110` | `log.error`、return（消息留 pending） |
| Container config 不存在 | `materializeContainerJson:79` | 抛，`wakeContainer.catch` 转 `false` |
| OneCLI gateway 失败 | `buildContainerArgs:430` | 抛 `OneCLI gateway not applied` |
| docker daemon 没起 | `ensureContainerRuntimeRunning` | 启动时 FATAL banner 后退出，host 不启动 |
| Image missing | `docker run` 失败 → child stderr | `container.on('error')` → 清 activeContainers + markStopped |
| Apple container 网络没配 | container 起来但 API 拿不到响应 | agent SDK 报错；container 自己 exit；host close 事件清表 |
| Mount allowlist 缺失 | `validateAdditionalMounts` 拒绝 | `log.warn 'Mount allowlist not found'` + 全部 reject |

**所有 spawn 失败都不抛到调用方**——`wakeContainer` 的合同就是不抛。`host-sweep` 周期扫描会重试，凡是 `messages_in.status='pending'` 又过了 `process_after` 的消息总会被再次尝试。

---

### 7.11 小结：lifecycle 全景图

```
host process (Node)                                docker daemon
─────────────────────────────                      ─────────────
boot
  enforceStartupBackoff                            (already running)
  initDb / migrate                                                 
  cleanupOrphans  ──── docker ps --filter label ──►│
  ensureContainerRuntimeRunning ── docker info ────►│
  router.start, host-sweep.start

incoming message
  channel adapter → router
    resolveSession (create if needed)
    writeSessionMessage(on_wake=0)
    wakeContainer(session)
      if running → return true
      else spawnContainer
        materializeContainerJson  ──► groups/<x>/container.json
        composeGroupClaudeMd       ──► groups/<x>/CLAUDE.md
        buildMounts (incl. mount-security)
        OneCLI ensureAgent + applyContainerConfig
        rm -f .heartbeat
        spawn('docker', [run --rm --name ...]) ──► │ create container
                                                   │ run /app/entrypoint.sh
                                                   │   → exec bun /app/src/index.ts
        activeContainers.set / markContainerRunning

container running
  agent-runner poll loop                            │
    open inbound.db readonly                        │
    touch /workspace/.heartbeat 每 N 秒             │
    SDK query → write outbound.db                   │
  host delivery (第 9 章) 读 outbound.db、发回 channel

container stopping
  自然退出 (无消息) | host kill (host-sweep) | restart
  child.on('close') ──► activeContainers.delete
                        markContainerStopped
                        stopTypingRefresh
                        onExit 回调 (若有)
```

到此 session 与 container 的两侧"骨架"建好了。下一章我们钻进容器内部，看 agent-runner 在那个 `bun run /app/src/index.ts` 之后到底做了什么。
