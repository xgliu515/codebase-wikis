> 代码版本锁定在 `glifocat/nanoclaw@0683c6e`（tag `v2.0.64`, 2026-05-18）。下文所有 `file:line` 引用都是仓库根目录的相对路径，并落在这个 commit 上。

## 1. 当前情境

[步骤 08](./tour-single-cli-message-08-insert-messages-in.md) 已经把 `ping` 写进了 `data/v2-sessions/ag-default/sess-1715290000-abc123/inbound.db.messages_in`，`seq=2`、`status='pending'`、`trigger=1`、`on_wake=0`。Router 紧接着 `await wakeContainer(freshSession)`（`src/router.ts:478`），现在控制权在 `src/container-runner.ts:85` 的 `wakeContainer`。

CLI 第一条消息的关键状态：

- `activeContainers` map 里**没有** `sess-1715...-abc123` 的 entry（`src/container-runner.ts:52-53` 全局变量）。
- `wakePromises` map 里也**没有**这个 session 的 in-flight promise（`src/container-runner.ts:63`）。
- 磁盘上 `data/v2-sessions/ag-default/sess-1715...-abc123/.heartbeat` 文件可能存在（前一次 container 退出时没清），也可能不存在。
- Central DB 的 `sessions` 行 `container_status = 'stopped'`。
- `groups/<agent_group.folder>/CLAUDE.md` 可能存在（之前 spawn 过）也可能不存在（fresh install）。
- `container_configs` 表里有 `ag-default` 这一行（agent group 创建时 backfill 写入，`src/backfill-container-configs.ts`）。

`wakeContainer` 走 `src/container-runner.ts:95-105` 的分支：既没在 active 也没在 wakePromises，所以创建一个新 promise——`spawnContainer(session).then(() => true).catch(...).finally(...)`——存进 `wakePromises[session.id]`，立刻 return 给 router。**router 拿到的是 pending Promise，但 `spawnContainer` 内部的同步前缀执行很快，await 一回头基本就 ready。**

整个 spawn 过程到 `child_process.spawn` 返回前是同步 + 几次 async await（initGroupFilesystem、materializeContainerJson、onecli.ensureAgent、onecli.applyContainerConfig）；spawn 返回后立刻把 child 注册进 activeContainers，**不等容器内部 boot**。等容器跑起来 + 第一轮 poll 是 [步骤 10-11](./tour-single-cli-message-10-container-boot.md) 的事。

## 2. 这一步要解决的问题

> 在 host 进程里准备好一个**独立的 docker child process**，让它带着正确的 mount、env、用户映射、OneCLI 凭据 proxy 启动，并把这个 child 注册到 host 内存里以便后续 kill/health/cleanup。整个过程不能阻塞 channel adapter 超过 ~50ms 的同步预算（async 段需要的 IO 都尽量晚做或并行），且对**重复 wake**、**孤儿心跳**、**spawn 中途失败**、**容器自然退出**、**OOM 隔离**这些情况要 idempotent。

子问题清单：

- **避免双 spawn**：同一个 session 在 race 下两条入站消息分别触发 wake，第二条不能再起一个 container（两个 container 抢同一份 outbound.db 写盘就 DB 损坏）。
- **凭据注入零信任**：container 内的 Claude / Codex / curl 不能直接拿 host 的 API key——必须走 OneCLI 的 gateway proxy，由 vault 按 agent identifier 注入。host 也不能把 key 通过 env 透传，那等于裸奔。
- **CLAUDE.md / skills / mount 必须 fresh**：agent group 改了 model、加了 skill、admin 装了 MCP server——这些 admin plane 的状态变化必须在下一次 spawn 时反映出来，不能用上次 container 残留的视图。
- **失败处理可重试**：OneCLI gateway 临时不可达、docker daemon 在重启、image 不存在——任何一种瞬态失败都不能丢消息，container 起不来就让 host-sweep 下一轮重试。
- **容器死了要清干净**：container `close` event 必须更新 Central DB `container_status='stopped'`、清 typing indicator、把 activeContainers entry 删掉。否则下次 wake 检查 activeContainers 时还在，误以为容器还活着。

## 3. 朴素方案 A：容器永久跑、host 用 IPC 直接发消息

让每个 agent group 启动时各起一个长寿命 container，host 用 stdin/HTTP/socket 把入站消息推给容器，容器永不退出。**这个方案在 README 草稿期被认真考虑过**，但塌得很彻底：

- **OOM 隔离全没了**：一个 agent 的 Bash 跑爆内存把 host 一起带走。container 本来就是用来兜底 agent 失控的，永久跑 = 把这层兜底拆了。
- **`/clear` 不可能干净**：Claude SDK 的 in-memory 状态、subprocess、文件描述符都在长寿命进程里——`/clear` 想"重置一切"必须重启进程，那跟 short-lived container 一样了。
- **重启恢复路径不存在**：容器 crash 或者 host 重启，所有 in-memory KV 全没。NanoClaw 显式要求"消息和 session 状态跨重启存活"——只能落盘——那又回到 SQLite 模型，长寿命容器不带来优势。
- **per-session workspace 不可能**：每个 session 要独立的 `/workspace`（含 inbound.db、outbox/、agent 临时文件）。一个 container 跑多 session 要么共享 workspace（隔离破坏），要么动态切换 mount（不支持）。
- **container 健康判定要靠 DB**：长寿命 container 是不是卡住？host 看不到，只能靠某种 ping。但 ping 走 IPC 又把"host 必须能可靠 reach container"加回 critical path。
- **agent group 数量爆炸时资源爆炸**：装 50 个 agent group 就是 50 个常驻 container 占着 RAM。NanoClaw 是个人助手网关，希望"没在用的 agent 不消耗资源"——short-lived container 自动达成。

## 4. 朴素方案 B：每条消息一个 container（fork-per-message）

矫枉过正的另一头：每条消息都启一个新 container，处理完立刻退。

- **延迟暴涨**：container 启动 5-10 秒 + image 加载 + OneCLI gateway apply ~1s + agent-runner Bun 启动 ~500ms。每条消息都付一次这个成本——用户体验毁灭。
- **Claude session id 没法续**：Claude SDK 用 `--continue` 接续上轮对话，依赖 in-memory session id。每条消息新 container，每条都是冷启动——agent 看不到"上一句你说了什么"。
- **OOM 没解决，连击没保护**：用户连发 10 条消息 → 10 个 container 同时启动。

中间方案：**per-session container，按需 wake、自然 idle 死、wake 时去重**。

## 5. NanoClaw 的方案

`wakeContainer` + `spawnContainer` + 容器自己的 idle exit（见 [步骤 11](./tour-single-cli-message-11-poll-loop.md)）三件事配合起来落地这个折中。

**(1) `wakeContainer` 的去重**（`src/container-runner.ts:85-106`）：

```ts
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}
```

两层去重：第一层 `activeContainers` 是"已经在跑"，第二层 `wakePromises` 是"正在 spawn"。**第二层不能少**——`spawnContainer` 是 async，进入函数体到 `child_process.spawn` 返回（再把 child 写进 activeContainers）有几百毫秒的 async 间隙（initGroupFilesystem、materializeContainerJson、`onecli.ensureAgent`、`onecli.applyContainerConfig`）。在这个间隙里如果第二条消息触发第二次 wake，第一层检查通不过（activeContainers 还空），就会走到 `spawnContainer` 第二次——两个 container 同时启动，一个 session 两份 docker run，outbound.db 双写者，DB 损坏。

contract 三条：(a) 永不 throw（`.catch` 转 boolean）；(b) 永不阻塞超过 spawn 同步段（router 的 await 因此安全）；(c) 失败时 `wakePromises.delete` 由 finally 兜底，保证下一次 wake 不会被 stale promise 卡住。

**(2) `spawnContainer` 的前置 IO**（`src/container-runner.ts:108-160`，主要片段）：

```ts
async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) { log.error('Agent group not found', ...); return; }

  // 1. 投影 destinations + session_routing 到 inbound.db
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // 2. 物化 container.json + 算 mount + 算 args
  const containerConfig = materializeContainerJson(agentGroup.id);
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);
  const mounts = buildMounts(agentGroup, session, containerConfig, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(mounts, containerName, agentGroup, containerConfig, provider, contribution, agentIdentifier);

  // 3. 清孤儿心跳 → spawn child → 注册
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });
  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  activeContainers.set(session.id, { process: container, containerName });
  markContainerRunning(session.id);
  // ...stdout/stderr 接 log, close/error handler
}
```

每一步的"为什么"：

- **`writeDestinations` + `writeSessionRouting`**：admin 改了 wiring / 改了 destinations 之后，新值此时才被投影进 `inbound.db.destinations` 和 `inbound.db.session_routing`。这是"projection 投影"模式（[第 3 章 §3.4.2](./03-three-db-model.md#342-agentdestinations投影到-session-inbound-的-acl)）——central DB 是真值，session DB 是 fast local cache，cache 在 wake 时整表刷新。
- **`materializeContainerJson`**（`src/container-config.ts:74-89`）：从 `container_configs` 表读出 row，序列化成 `groups/<folder>/container.json`，container 启动后第一时间读。这个文件**每次 spawn 都重写**——确保 self-mod 调 `install_packages` 之后 admin 端的改动在下次 spawn 生效。
- **`resolveProviderContribution`**（`src/container-runner.ts:225-240`）：根据 `session.agent_provider` → `container_configs.provider` → `'claude'` 三级回退（`resolveProviderName`，第 218-223 行）算 provider，然后从 `provider-container-registry` 取 provider 自己的 host-side 贡献（额外 mount、额外 env，例如 opencode 需要的 XDG\_DATA\_HOME 目录）。这步把 provider 异质性收拢到一个 contribution 对象。
- **`buildMounts`**（`src/container-runner.ts:242-335`）：算 8-12 个 mount，详见 §5 的小节 (3)。
- **`buildContainerArgs`**（`src/container-runner.ts:399-465`）：拼 `docker run` 的 argv，含 OneCLI gateway 注入——详见小节 (4)。
- **`fs.rmSync(heartbeatPath, { force: true })`**：清前一次 container 留下的 `.heartbeat`。这一步有详细 in-source 注释（`src/container-runner.ts:151-155`）："host-sweep 把 missing file 当 'fresh spawn, give grace'；不清的话 stale mtime 会触发 immediate kill"。
- **`spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })`**：`CONTAINER_RUNTIME_BIN = 'docker'`（`src/container-runtime.ts:12`，硬编码 docker，apple-container 路径预留但 v2.0.64 未走通）。stdio 配置：stdin ignore（容器不读 stdin，所有 IO 走 session DB）、stdout/stderr pipe 是为了让 host 抓 log。
- **`activeContainers.set(...)` + `markContainerRunning(...)`**：注册到内存表、Central DB `sessions.container_status = 'running'`。注意**先 set 再 mark**——如果反过来，DB 写成 running 但内存 map 没注册，下一次 wake 检查 activeContainers 不命中又会 spawn 一次。

**(3) `buildMounts` 的 8-12 个 mount**（`src/container-runner.ts:242-335`）：

| host 路径 | container 路径 | RW/RO | 用途 |
|---|---|---|---|
| `<sessionDir>` | `/workspace` | RW | session 数据：inbound.db、outbound.db、outbox/、.heartbeat、.claude/ |
| `groups/<folder>/` | `/workspace/agent` | RW | agent group 工作文件、`CLAUDE.local.md` |
| `groups/<folder>/container.json` | `/workspace/agent/container.json` | RO | container 配置；nest 在 RW group dir 上当 RO 锁住不让 agent 改 |
| `groups/<folder>/CLAUDE.md` | `/workspace/agent/CLAUDE.md` | RO | 组合好的 system prompt 文件；agent 不能写 |
| `groups/<folder>/.claude-fragments/` | `/workspace/agent/.claude-fragments` | RO | 各 skill 贡献的 prompt 片段 |
| `groups/global/` | `/workspace/global` | RO | 全局 memory，所有 agent 共享 |
| `container/CLAUDE.md` | `/app/CLAUDE.md` | RO | 跨 agent group 共享的 base prompt |
| `<sessionDir>/../.claude-shared/` | `/home/node/.claude` | RW | Claude state、settings、skill symlinks（per-agent-group） |
| `container/agent-runner/src/` | `/app/src` | RO | agent-runner 源码 |
| `container/skills/` | `/app/skills` | RO | 所有 skill 实现 |
| `containerConfig.additionalMounts` | 用户配置 | 可 RW/RO | self-mod 加的额外 mount（要走 `validateAdditionalMounts` 白名单） |
| `providerContribution.mounts` | provider 配置 | 看 provider | 比如 opencode 的 XDG dir mount |

`/workspace/agent/container.json` 是**嵌套 RO mount 套在 RW group dir 之上**——典型用法：让 agent 能写工作文件但不能改自己的配置。同理 `CLAUDE.md` 和 `.claude-fragments`。这个嵌套是 docker 的 mount-over-mount，host 上是单一文件，container 看到的是先 RW 大目录覆盖、再 RO 小文件覆盖。

`syncSkillSymlinks`（`src/container-runner.ts:342-397`）在 `.claude-shared/skills/` 里维护一组 symlink 指向 `/app/skills/<name>`——symlink 在 host 上是 dangling 的（`/app/skills` 是容器路径），只在 container 内有意义。`containerConfig.skills` 是 `'all'` 时 host 端 readdir `container/skills/` 算出实际列表；是数组时按数组建。每次 spawn 都对比 desired vs existing 增删 symlink，让 admin 加/减 skill 立刻生效。

**(4) `buildContainerArgs` + OneCLI gateway**（`src/container-runner.ts:399-465`）：

argv 顺序：`run --rm --name <name> --label <install-label> -e TZ=<tz>` + provider env + OneCLI 注入 + host gateway args + user mapping + 所有 mount + `--entrypoint bash <image> -c 'exec bun run /app/src/index.ts'`。

关键是 OneCLI 注入（`src/container-runner.ts:426-433`）：

```ts
if (agentIdentifier) {
  await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
}
const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
if (!onecliApplied) {
  throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
}
log.info('OneCLI gateway applied', { containerName });
```

`ensureAgent` 在 OneCLI vault 里注册（或确认）当前 agent group 的 identity——`identifier = agent_group.id`，**用 ID 而不是 name 是有意的**：name 可能被 admin 改、被 rename，identifier 全生命周期稳定，approval flow 反向查 `getAgentGroup(identifier)` 还能找到对应行。

`applyContainerConfig` 给已经在拼的 `args` 数组**就地添加** `-e HTTPS_PROXY=...`、`-v <cert>:<container-cert-path>:ro`、`--env REQUESTS_CA_BUNDLE=...` 这些字段。container 内 Claude/Codex/curl 发 https 全走 OneCLI proxy，proxy 看 SNI/host header 决定注入哪份凭据。**host 进程从头到尾不接触 API key 明文**，凭据存在 vault 里、由 proxy 在 request 上下文里临时注入。

返回 false 直接 throw——意味着 OneCLI 临时不可达。throw 顺着 `spawnContainer` → `wakeContainer` 的 `.catch` 链路转成 `return false`，messages_in 那条 pending 不动，host-sweep 下一轮 retry。

最后 `args.push('--entrypoint', 'bash')` 把 image 的默认 entrypoint 覆盖了，再 `args.push('-c', 'exec bun run /app/src/index.ts')`——这条 bash command 启动 Bun runtime 直接跑 agent-runner 的 `index.ts`，**没有 `tsc` 编译步、没有 npm install**，因为镜像里已经把 Bun 装好了、agent-runner 源码 mount 在 `/app/src` RO。开发体感是改完 agent-runner 代码不用 rebuild image，下次 spawn 直接生效。

**(5) child process 生命周期管理**（`src/container-runner.ts:162-189`）：

```ts
container.stderr?.on('data', (data) => {
  for (const line of data.toString().trim().split('\n')) {
    if (line) log.debug(line, { container: agentGroup.folder });
  }
});
container.stdout?.on('data', () => {});  // v2 不走 stdout

container.on('close', (code) => {
  activeContainers.delete(session.id);
  markContainerStopped(session.id);
  stopTypingRefresh(session.id);
  log.info('Container exited', { sessionId: session.id, code, containerName });
});

container.on('error', (err) => {
  activeContainers.delete(session.id);
  markContainerStopped(session.id);
  stopTypingRefresh(session.id);
  log.error('Container spawn error', { sessionId: session.id, err });
});
```

`close` 和 `error` 两个 handler 都做三件事：从 activeContainers 删、`container_status='stopped'`、停 typing indicator。**没有 idle timeout**——container 自己在 agent-runner 的 poll loop 里决定何时退出（连续 N 轮 poll 空、且 outbound queue 空、且 last_active 超过阈值），host 端用 host-sweep 配合心跳/processing_ack 做 stuck 检测但不做硬性时钟杀。详见 [步骤 11](./tour-single-cli-message-11-poll-loop.md) 和 host-sweep 章节。

**Image cache 旁注**：`./container/build.sh --no-cache` 在某些 docker 版本上**仍然会**用上层 cache（base image 层），因为 `--no-cache` 只禁用本次 build 的层 cache 不会 pull fresh base。改完容器 entrypoint 之后如果发现行为没变，先 `docker rmi nanoclaw-v2:latest && ./container/build.sh` 再试。这是 NanoClaw 调试时常踩的坑，写在 `container/README.md` 但常被忽略。

## 6. 代码位置

- `src/container-runner.ts:85-106` — `wakeContainer` 双层去重 + try/catch 转 boolean。
- `src/container-runner.ts:108-190` — `spawnContainer` 主流程：projection → materialize → mounts → args → child spawn → handlers。
- `src/container-runner.ts:118-122` — `writeDestinations` + `writeSessionRouting` 投影 admin plane 到 session DB。
- `src/container-runner.ts:131-147` — provider 解析 + mount/args 计算。
- `src/container-runner.ts:151-155` — 孤儿心跳清理 + in-source rationale。
- `src/container-runner.ts:157-160` — `child_process.spawn` + activeContainers 注册 + `markContainerRunning`。
- `src/container-runner.ts:177-189` — close/error handler，统一清理三件事。
- `src/container-runner.ts:218-240` — `resolveProviderName` + `resolveProviderContribution`。
- `src/container-runner.ts:242-335` — `buildMounts`，12 类 mount + provider/additional 扩展。
- `src/container-runner.ts:342-397` — `syncSkillSymlinks`，按 container.json 维护 `.claude-shared/skills/` 符号链。
- `src/container-runner.ts:399-465` — `buildContainerArgs`，含 OneCLI gateway 注入（约 423-433 行）。
- `src/container-runner.ts:426-433` — `onecli.ensureAgent` 调用点，identifier = agent\_group.id。
- `src/container-runtime.ts:12` — `CONTAINER_RUNTIME_BIN = 'docker'`，硬编码。
- `src/container-runtime.ts:15-21` — `hostGatewayArgs`，linux 上补 `--add-host=host.docker.internal:host-gateway`。
- `src/container-runtime.ts:24-26` — `readonlyMountArgs`，`-v ...:ro`。
- `src/container-runtime.ts:29-34` — `stopContainer`，用 execSync `docker stop -t 1`，名字正则校验防 shell 注入。
- `src/container-runtime.ts:67-90` — `cleanupOrphans`，按 install label 清同一安装的孤儿容器（不会误杀同机器的别人）。
- `src/container-config.ts:74-89` — `materializeContainerJson`，把 DB row 写成 `container.json`。
- `container/Dockerfile` — 镜像构建（Bun + pnpm + Claude SDK + Codex SDK + OneCLI + skills）。

## 7. 分支与扩展

继续 trace：

- **下一步** [步骤 10：container boot / agent-runner index.ts](./tour-single-cli-message-10-container-boot.md) 切到容器侧，从 `exec bun run /app/src/index.ts` 开始，看 agent-runner 怎么读 container.json、打开两个 DB、起 poll loop。

横向章节：

- [第 7 章 §src/container-runner.ts](./07-host-architecture.md#srccontainer-runnerts) 是这个模块的高层介绍，含 active container map、wake 去重、close/error 清理三件套的总览。
- [第 7 章 §Mounts](./07-host-architecture.md#mounts) 把所有 mount 列出来按"为什么 RW 为什么 RO"分组，比上面那张表更细。
- [第 12 章 §`src/container-runner.ts:ensureAgent` 调用点](./12-onecli-integration.md#srccontainer-runnertsensureagent-调用点) 解释 `onecli.ensureAgent` 在 OneCLI 集成大图里的位置，含 vault 里 identity row 的字段、和 approval flow（`onecli-approvals.ts`）的对接。

其他分支：

- **per-agent-group image**：`containerConfig.imageTag` 非空时 spawn 用自定义 image（`buildAgentGroupImage` 在 `src/container-runner.ts:468-515` 构建），允许 self-mod 装 apt/npm 包。fresh install 都是空 → 用基础 image `CONTAINER_IMAGE`。
- **apple-container 路径**：v2.0.64 里 `CONTAINER_RUNTIME_BIN` 硬编码 docker，apple-container 的兼容路径预留但未走通（`src/container-runtime.ts` 的注释提到"All runtime-specific logic lives here"）。M 系列 Mac 下 docker desktop 跑 linux container 仍然是默认路径。
- **`--user` 映射**：non-root non-1000 的 host UID 时（`src/container-runner.ts:439-444`）传 `--user hostUid:hostGid` 让 container 里的写文件回到 host owner——开发机器最常见情况。
- **host gateway**：linux 上 `host.docker.internal` 不是内置域名，要 `--add-host=host.docker.internal:host-gateway`。macOS 上 docker desktop 自带，hostGatewayArgs() return 空数组。container 内 agent 调 host API（host-sweep 暴露的 webhook 之类）需要这个。
- **mount-security 模块**：`additionalMounts` 走 `validateAdditionalMounts`（`src/modules/mount-security/index.ts`）按 `~/.config/nanoclaw/mount-allowlist.json` 白名单过——防止 self-mod 写一行 `additionalMounts: [{hostPath: '/', containerPath: '/host'}]` 把 host root mount 进容器。
- **container 死亡恢复**：spawn 失败、容器 OOM-kill、host-sweep 主动 kill 都走 `close` event 这一路。下次 wake 时 activeContainers 是空、wakePromises 是空，spawn 流程重跑。**没有指数退避**——OneCLI gateway 这种瞬态故障的 backoff 由 host-sweep 周期（默认 30s）兜底，不在 wakeContainer 里。
- **`getActiveContainerCount`**（`src/container-runner.ts:65`）暴露给 admin 命令 `/stats` 看当前并发容器数。

## 8. 看完这一步你脑子里要装的

1. spawn 不是新建容器那么简单——前置 IO 链路是"projection（投影 admin plane 到 session DB）→ materialize（写 container.json）→ mounts → args（含 OneCLI 注入）→ child spawn → activeContainers 注册"。每一段都对应一条不变量。
2. `wakeContainer` 双层去重必须存在：active 表查"已经在跑"，wakePromises 查"正在 spawn 但 child 还没 set"。少了第二层就在 race 下出双 container 双 outbound writer = DB 损坏。
3. OneCLI gateway 是凭据隔离的核心：host 不接触明文 API key，container 内所有 https 流量走 proxy 由 vault 按 agent identifier 注入。`identifier = agent_group.id`（不是 name），稳定可反查。
4. mount 设计的核心模式是"RW 大目录 + 嵌套 RO 小文件"。`/workspace/agent` 整个 RW 给 agent 写文件，但其中 `container.json` / `CLAUDE.md` / `.claude-fragments/` 用嵌套 mount 锁死 RO——agent 改不了自己的配置。
5. spawn 失败、container 死亡都是 normal flow，不是 error。`wakeContainer` 把 throw 转成 `return false`，host-sweep 下一轮 retry。messages\_in 那条 pending 不动，零丢失。
6. container 的 stdio：stdin ignore（所有 IO 走 session DB）、stdout 丢弃（v2 不用）、stderr 进 log。container 退出由它自己的 agent-runner poll loop 决定（idle exit），host 不设硬时钟超时——靠 .heartbeat mtime + processing_ack 状态做软判定。
7. `materializeContainerJson` 每次 spawn 都重写 `container.json`，admin 改 model / 加 skill / 改 MCP server 立即在下次 wake 生效。这是 admin plane 和 runtime plane 之间唯一的"配置投影点"，是 self-mod 工具能 hot-reload 的根因。
