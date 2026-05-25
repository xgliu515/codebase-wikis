## 1. 当前情境

第 09 步把 host 的 `container-runner.ts` 走完了：`docker run` 已经把 image fork 成了一个新进程，挂载点全部按 spec 就位（`/workspace/inbound.db`、`/workspace/outbound.db`、`/workspace/agent/`、`/workspace/global/`、`/app/src/`），`entrypoint.sh` 通过 stdin 收到了一段 JSON spawn-blob（OneCLI 网络参数、TZ 等），把它落到 `/tmp/input.json`。现在 PID 1 是 tini，tini 的直接子进程是 bun，bun 的命令行是：

```bash
exec bun run /app/src/index.ts < /tmp/input.json
```

——见 [`container/entrypoint.sh:14-16`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/entrypoint.sh#L14)。

容器内部的状态：

- **代码**：`/app/src/` 是 host 端 `container/agent-runner/src/` 的 read-only bind mount。bun 直接跑 TypeScript，没有 build step。
- **配置**：`/workspace/agent/container.json` 是 host 在 step 09 用 `materializeAgentGroup()` 写出来的，里面有 provider name、model、effort、`mcpServers`、`assistantName` 等。
- **session DBs**：`/workspace/inbound.db` 已经被 host 在 step 08 用 even-seq INSERT 写过一行 `messages_in`（kind=`chat`, content=`{"text":"ping"}`）。`outbound.db` 可能是新文件（首次 wake），也可能已存在（warm session）。
- **没启动**：poll loop 还没跑、provider 没注册、system prompt 没拼、heartbeat 文件没创建。

bun 进程刚启动、JS 还没执行到 user code。下一拍它会开始 import 模块。

## 2. 这一步要解决的问题

bun 跑到 `index.ts` 那一刻，需要在**进入 poll loop 之前**把所有"per-agent-group 差异"配齐：

1. **谁是这个 agent？** 它的 displayName 叫什么、给的什么名字（写在系统 prompt 里）。
2. **用哪个 provider？** Claude？Codex？OpenCode？三家 SDK 的入参形状都不一样。
3. **用哪个 model、什么 effort？** opus-4.7 还是 haiku-4.5？thinking budget 多少？
4. **挂哪些 MCP server？** 默认的 nanoclaw 内置 MCP（`mcp-tools/index.ts`）一定要挂，operator 通过 `add_mcp_server` 加的（如 `playwright`、`fetch`）也要挂。
5. **system prompt 怎么拼？** 共享 base（`/app/CLAUDE.md`）+ per-group append（`/workspace/agent/CLAUDE.md`）+ 运行时附录（identity + destinations）。
6. **DB 连接怎么开？** inbound 只读、outbound 读写，pragma 必须对（journal_mode、busy_timeout、mmap_size）。
7. **以什么进程身份运行？** cwd 设到 `/workspace/agent`（agent 视角的"项目根"），additional directories 挂上去。

任何一项配错，poll loop 跑起来就是一颗哑炮。例如：provider 名字弄成 `Claude`（大写）而注册表只有 `claude`，第一次 `query()` 就抛"Unknown provider"，agent 一辈子收不到 "ping"。

## 3. 朴素思路

最直觉的写法是**把 provider 和 model 写死在 image 里**，build image 时就烤进环境变量：

```dockerfile
ENV NANOCLAW_PROVIDER=claude
ENV NANOCLAW_MODEL=opus-4.7
ENV NANOCLAW_MCP_SERVERS=playwright,fetch
```

然后 `index.ts` 里：

```ts
const provider = createProvider(process.env.NANOCLAW_PROVIDER as ProviderName, {
  model: process.env.NANOCLAW_MODEL,
  // ...
});
```

直观、能跑、改 model 只要改 Dockerfile 重新 build——经典做法。

## 4. 为什么朴素思路会崩

它崩在 NanoClaw 的核心承诺上：**一个 host 同时跑很多个 agent group**。

举三种立即崩的场景：

- **同一 host 上两个 agent 想用不同 model**。例如 `kira` 用 opus-4.7 干通用对话，`miko` 用 haiku-4.5 做高频低延迟摘要。env 是 docker run 时按容器注入的，可以做到——但运维要为每个 agent group 维护一份 `docker run -e ...` 拼接表，且任何字段变更都要重启容器。NanoClaw 想做的是**操作员在 web UI 改 model 立即生效**（下次 wake 时新 model 就上）。
- **MCP server 列表是动态的**。`add_mcp_server` 是 admin command，运行时往中央 DB 写一行。env-baked image 看不见 DB 的变化，必须重启容器才能感知。NanoClaw 的 spec 是"下次 wake 自动 pick up"。
- **assistantName / displayName 是运行时改的**。Operator 给 agent 改个名字，立即生效——不能要求重建 image。

更深一层：image 是**共享的**——所有 agent group 共用同一个 `nanoclaw-agent:<install-slug>` image（见 chapter 7 的容器命名章节）。把 per-agent 状态烤进 image 等于禁掉了共享。

朴素思路也违反了 NanoClaw 自己的 [§"为什么 SQLite 通信"](01-overview.md#3-nanoclaw-的选择两个-db--单-writer--everything-is-a-message) 原则：**host 是 schema 拥有者，container 只读**。Container 不应该有自己的 "私货配置源"，必须从 host 物化的 mount 里读。

## 5. NanoClaw 的做法

每次 spawn 容器前，host 把 per-agent-group 配置**物化**成 `/workspace/agent/container.json`（RO bind mount），容器 boot 时读这一个文件就拿到全部 per-group 差异。

<svg viewBox="0 0 820 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Container boot pipeline from tini PID1 to poll loop with config sources">
  <defs>
    <marker id="boot-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <text x="410" y="20" font-size="13" font-weight="700" fill="currentColor" text-anchor="middle">Container boot (entrypoint.sh → index.ts → runPollLoop)</text>
  <rect x="20" y="40" width="180" height="290" rx="6" fill="#fef3c7" stroke="#ea580c" stroke-width="1.2"/>
  <text x="110" y="60" font-size="12" font-weight="700" fill="#9a3412" text-anchor="middle">Mounted (RO) by host</text>
  <rect x="34" y="76" width="152" height="38" rx="4" fill="#ffffff" stroke="#fcd34d"/>
  <text x="110" y="92" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">/workspace/agent/</text>
  <text x="110" y="106" font-size="10" fill="#64748b" text-anchor="middle">container.json + CLAUDE.md</text>
  <rect x="34" y="120" width="152" height="38" rx="4" fill="#ffffff" stroke="#fcd34d"/>
  <text x="110" y="136" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">/workspace/inbound.db</text>
  <text x="110" y="150" font-size="10" fill="#64748b" text-anchor="middle">readonly (host writes)</text>
  <rect x="34" y="164" width="152" height="38" rx="4" fill="#ffffff" stroke="#fcd34d"/>
  <text x="110" y="180" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">/workspace/outbound.db</text>
  <text x="110" y="194" font-size="10" fill="#64748b" text-anchor="middle">read+write (container)</text>
  <rect x="34" y="208" width="152" height="38" rx="4" fill="#ffffff" stroke="#fcd34d"/>
  <text x="110" y="224" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">/app/src/ (code RO)</text>
  <text x="110" y="238" font-size="10" fill="#64748b" text-anchor="middle">+ /app/CLAUDE.md (base)</text>
  <rect x="34" y="252" width="152" height="38" rx="4" fill="#ffffff" stroke="#fcd34d"/>
  <text x="110" y="268" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">/workspace/extra/*</text>
  <text x="110" y="282" font-size="10" fill="#64748b" text-anchor="middle">extra additional dirs</text>
  <text x="110" y="316" font-size="10" fill="#94a3b8" text-anchor="middle">per-agent-group materialised</text>
  <rect x="240" y="40" width="560" height="290" rx="6" fill="#ffffff" stroke="#cbd5e1"/>
  <text x="520" y="60" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">PID 1 tini   →   bun run /app/src/index.ts &lt; /tmp/input.json</text>
  <rect x="260" y="78" width="160" height="56" rx="6" fill="#fef3c7" stroke="#ea580c"/>
  <text x="340" y="98" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">1. loadConfig()</text>
  <text x="340" y="114" font-size="10" fill="#64748b" text-anchor="middle">read container.json</text>
  <text x="340" y="126" font-size="10" fill="#64748b" text-anchor="middle">model · effort · mcpServers</text>
  <rect x="440" y="78" width="160" height="56" rx="6" fill="#fef3c7" stroke="#ea580c"/>
  <text x="520" y="98" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">2. providers/index.ts</text>
  <text x="520" y="114" font-size="10" fill="#64748b" text-anchor="middle">import side-effect</text>
  <text x="520" y="126" font-size="10" fill="#64748b" text-anchor="middle">registerProvider() ×N</text>
  <rect x="620" y="78" width="160" height="56" rx="6" fill="#fef3c7" stroke="#ea580c"/>
  <text x="700" y="98" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">3. system prompt</text>
  <text x="700" y="114" font-size="10" fill="#64748b" text-anchor="middle">base + per-group +</text>
  <text x="700" y="126" font-size="10" fill="#64748b" text-anchor="middle">addendum (identity)</text>
  <line x1="420" y1="106" x2="438" y2="106" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#boot-ar)"/>
  <line x1="600" y1="106" x2="618" y2="106" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#boot-ar)"/>
  <rect x="260" y="152" width="160" height="56" rx="6" fill="#fef3c7" stroke="#ea580c"/>
  <text x="340" y="172" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">4. scan extra dirs</text>
  <text x="340" y="188" font-size="10" fill="#64748b" text-anchor="middle">→ additionalDirectories</text>
  <rect x="440" y="152" width="160" height="56" rx="6" fill="#fef3c7" stroke="#ea580c"/>
  <text x="520" y="172" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">5. merge mcpServers</text>
  <text x="520" y="188" font-size="10" fill="#64748b" text-anchor="middle">builtin + per-group</text>
  <rect x="620" y="152" width="160" height="56" rx="6" fill="#fef3c7" stroke="#ea580c"/>
  <text x="700" y="172" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">6. createProvider()</text>
  <text x="700" y="188" font-size="10" fill="#64748b" text-anchor="middle">factory lookup → closure</text>
  <line x1="420" y1="180" x2="438" y2="180" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#boot-ar)"/>
  <line x1="600" y1="180" x2="618" y2="180" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#boot-ar)"/>
  <rect x="260" y="232" width="520" height="58" rx="6" fill="#ecfdf5" stroke="#16a34a" stroke-width="1.5"/>
  <text x="520" y="252" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">7. runPollLoop({ provider, cwd:/workspace/agent, systemContext })</text>
  <text x="520" y="270" font-size="11" fill="#64748b" text-anchor="middle">never returns · DB connection lazy-open on first getInboundDb()/getOutboundDb()</text>
  <text x="520" y="282" font-size="10" fill="#94a3b8" text-anchor="middle">inbound readonly · outbound rw · pragmas: busy_timeout=5000 mmap=0 journal=DELETE</text>
  <rect x="260" y="300" width="520" height="22" rx="3" fill="#7c3aed" opacity="0.12" stroke="#7c3aed" stroke-width="0.8" stroke-dasharray="3,2"/>
  <text x="520" y="316" font-size="10" fill="#7c3aed" text-anchor="middle">→ next step: step 11 poll loop iteration</text>
  <line x1="200" y1="106" x2="258" y2="106" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#boot-ar)"/>
  <line x1="200" y1="180" x2="258" y2="180" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#boot-ar)"/>
  <line x1="200" y1="260" x2="258" y2="260" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#boot-ar)"/>
</svg>
<span class="figure-caption">图 T1.20 ｜ 容器 boot 阶段图：host 物化的 5 个挂载点（左）→ index.ts 的 7 步初始化 → runPollLoop 进入 poll 循环（DB 连接 lazy-open）。</span>

<details>
<summary>ASCII 原版</summary>

```
[mounted by host]                  [bun process inside container]
/workspace/agent/container.json --> loadConfig() ──┐
/app/CLAUDE.md (base)              import providers/index.js (self-register)
/workspace/agent/CLAUDE.md         buildSystemPromptAddendum()
/workspace/extra/*                 scan extra → additionalDirectories
/workspace/inbound.db (RO)         merge builtin + per-group mcpServers
/workspace/outbound.db (RW)        createProvider(name, opts)
                                   └──> runPollLoop({...})  (never returns)
```

</details>

具体路径：

**5.1 `loadConfig()`——一次性读 container.json**

[`container/agent-runner/src/config.ts:31-53`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/config.ts#L31) 同步读 `/workspace/agent/container.json`，JSON.parse 后用 `??` fallback 补齐缺字段，singleton 缓存。读失败时不 throw——只打 log、用 default，让 container 能 boot 起来去 poll 一个 empty config（操作员能从 log 看到失败原因）。Schema 字段有：`provider`、`assistantName`、`groupName`、`agentGroupId`、`maxMessagesPerPrompt`、`mcpServers`、`model`、`effort`。

**5.2 Provider 自注册 + 工厂**

[`container/agent-runner/src/index.ts:32`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/index.ts#L32) 一行 `import './providers/index.js';`——这个 barrel ([`providers/index.ts`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/providers/index.ts)) 里每个 provider 模块都在 top-level 调 `registerProvider(name, factory)` ([`providers/claude.ts:360`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/providers/claude.ts#L360))，import 副作用把 factory 塞进 `Map<string, ProviderFactory>`。然后 [`createProvider()`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/providers/factory.ts#L11) 按名查表实例化。

**5.3 System prompt 三层拼装**

NanoClaw 把系统 prompt 切成三段：

| 层 | 文件 | 谁写谁改 |
|---|---|---|
| Base | `/app/CLAUDE.md`（image 里） | NanoClaw 维护，所有 agent 共享 |
| Per-group | `/workspace/agent/CLAUDE.md` + `CLAUDE.local.md` | Host 物化，每 agent 一份 |
| Runtime addendum | 进程内 `buildSystemPromptAddendum()` | 每次 boot 算 |

`index.ts:54` 调 [`buildSystemPromptAddendum(config.assistantName)`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/destinations.ts#L82) 算第三层——identity 段（"You are Kira"）+ destinations 列表（"You can send messages to: kira-discord, kira-telegram, ..."）。前两层走 Claude Code 自身的 CLAUDE.md auto-load 机制，不在这里手动塞。

**5.4 Additional directories 自动发现**

`index.ts:57-69` 扫 `/workspace/extra/`——operator 可以挂额外目录进来（git repo / 文档库），agent 用 Bash/Read/Glob 能看见。host 端在 spawn 时把要挂的 dir bind 进去。

**5.5 MCP server 拼装**

`index.ts:76-87` 把内置 nanoclaw MCP (`mcp-tools/index.ts`，命令 `bun run /app/src/mcp-tools/index.ts`) 和 `container.json.mcpServers` 合并成最终给 SDK 的 dict。Server 名字会被 SDK normalize 成 `[A-Za-z0-9_-]` 拼成 tool prefix `mcp__<server>__<tool>`。

**5.6 Provider 实例化**

`index.ts:89-96` 调 `createProvider('claude', {...})`——返回的对象实现 `AgentProvider` 接口（`query()` / `isSessionInvalid()`）。Provider 内部状态（assistant name、mcp servers、env、model、effort）都被 closure 起来，不再依赖 global。

**5.7 进入 poll loop**

`index.ts:98-103` 调 [`runPollLoop({ provider, providerName, cwd: '/workspace/agent', systemContext: { instructions } })`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/poll-loop.ts#L53)——一个永不返回的 async fn。Cwd 是 `/workspace/agent`，意味着 Bash / Read / Write 看到的"项目根"就是当前 agent group 的文件夹。

**5.8 DB connection 在第一次 getter 调用时 lazy 打开**

`index.ts` 自己不开 DB——它把这事 defer 给 poll loop 第一次调 `getInboundDb()` / `getOutboundDb()`。[`db/connection.ts:65-72`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/db/connection.ts#L65) 里：

```ts
_inbound = new Database(DEFAULT_INBOUND_PATH, { readonly: true });
_inbound.exec('PRAGMA busy_timeout = 5000');
_inbound.exec('PRAGMA mmap_size = 0');
```

`readonly: true` 是硬约束——container 永远不能写 inbound.db（违反单写者不变量）。`mmap_size = 0` 关掉 SQLite 自带的 mmap 页缓存（关于"为什么必须关"见 [chapter 8 §`bun:sqlite` gotchas](08-container-agent-runner.md#bun-sqlite-gotchas)）。Outbound 是读写、`journal_mode = DELETE` ([`connection.ts:78`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/db/connection.ts#L78))——同理走"open-write-close" 跨 mount 兼容路径。

## 6. 代码位置

按 `index.ts` 的执行顺序：

1. [`container/entrypoint.sh:14-16`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/entrypoint.sh#L14)——`cat > /tmp/input.json; exec bun run /app/src/index.ts < /tmp/input.json`
2. [`container/agent-runner/src/index.ts:42`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/index.ts#L42)——`async function main()`
3. [`container/agent-runner/src/index.ts:43`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/index.ts#L43)——`const config = loadConfig()`
4. [`container/agent-runner/src/config.ts:31-53`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/config.ts#L31)——`loadConfig()` 实现
5. [`container/agent-runner/src/index.ts:32`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/index.ts#L32)——`import './providers/index.js'` 触发 provider 自注册
6. [`container/agent-runner/src/providers/claude.ts:360`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/providers/claude.ts#L360)——`registerProvider('claude', ...)`
7. [`container/agent-runner/src/index.ts:54`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/index.ts#L54)——`buildSystemPromptAddendum(config.assistantName)`
8. [`container/agent-runner/src/destinations.ts:82-92`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/destinations.ts#L82)——identity + destinations 拼装
9. [`container/agent-runner/src/index.ts:57-69`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/index.ts#L57)——extra dir 扫描
10. [`container/agent-runner/src/index.ts:76-87`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/index.ts#L76)——MCP server 合并
11. [`container/agent-runner/src/index.ts:89-96`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/index.ts#L89)——`createProvider(name, opts)`
12. [`container/agent-runner/src/providers/factory.ts:11`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/providers/factory.ts#L11)——查注册表实例化
13. [`container/agent-runner/src/index.ts:98-103`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/index.ts#L98)——`runPollLoop({...})`，永不返回
14. [`container/agent-runner/src/db/connection.ts:65-72`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/db/connection.ts#L65)——`getInboundDb()` lazy open（poll loop 第一调）
15. [`container/agent-runner/src/db/connection.ts:75-112`](https://github.com/nanocoai/nanoclaw/blob/0683c6ec589ec0df74c2a3d99f9544127317b490/container/agent-runner/src/db/connection.ts#L75)——`getOutboundDb()` lazy open + on-demand schema patch

## 7. 分支与延伸

- Container 内整套 runner 是个独立子系统——架构总图、模块边界、与 host 进程的双向关系，见 [第 8 章 §`container/agent-runner/src/index.ts`](08-container-agent-runner.md#containeragent-runnersrcindexts) 的入口章节。
- 多 provider 支持（Claude / Codex / OpenCode / mock）通过自注册 registry 实现——[第 8 章 §Provider 抽象](08-container-agent-runner.md#provider-抽象) 详细讲了 `AgentProvider` 接口、Claude SDK 适配的几个非 trivial 坑（disallowed tools、tool allowlist、stale session 识别）。
- 三个 PRAGMA（`busy_timeout=5000`、`mmap_size=0`、`journal_mode=DELETE`）每一个都对应一个跨 VirtioFS mount 时踩过的坑——[第 8 章 §`bun:sqlite` gotchas](08-container-agent-runner.md#bun-sqlite-gotchas) 收录了完整 trace。
- container.json 是 host 物化出来的——host 端写文件那一步在第 09 步（`materializeAgentGroup()`），它的源 schema 在 [第 7 章 §agent group 物化](07-session-container-lifecycle.md)。
- 三 DB 分工的全景（host 写哪些表、container 写哪些表）在 [第 3 章 §3.5 Session DBs](03-three-db-model.md#35-session-dbsinbounddb-与-outbounddb)。

## 8. 走完这一步你脑子里应该多了什么

- Container boot 的"per-group 差异"全部从一个文件 `/workspace/agent/container.json` 读出来——这就是为什么 image 可以共享、为什么改 model 不用 rebuild。
- Provider 注册是 import 副作用驱动的 self-registration 模式，新增 provider 只要在 `providers/index.ts` 加一行 import，不用改 factory。
- System prompt 有三层：image 内 base（`/app/CLAUDE.md`）+ host 物化 per-group（`/workspace/agent/CLAUDE.md`）+ 进程内动态 addendum（identity + destinations）。每一层负责不同生命周期的变化。
- DB connection 是 lazy 的——`index.ts` 完成 boot 后才让 poll loop 触发第一次打开；singleton 模式 + 严格 readonly inbound 守住"单写者"不变量。
- 容器 PID 1 是 tini，bun 是 tini 的直接子进程；SIGTERM 由 tini 转发给 bun，bun 优雅退出。
- `index.ts:main()` 的 `.catch()` 会 `process.exit(1)`——任何 boot 阶段 throw 都让 container 立即死，host 看到 exit code 知道 wake 失败。

下一步：进入 poll loop 的第一轮迭代。
