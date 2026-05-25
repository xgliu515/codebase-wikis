## 凭证不能进 env，敏感动作必须人工放行

第 11 章末尾留了个尾巴：channel registration、sender approval、self-mod、OneCLI credential —— 这四种 ask_question 卡片共享同一个 primitive 但 action 不同。这一章把它讲完。同时一起讲：**API key / OAuth token 是怎么进到容器里的，又是怎么在不让 agent 看见明文的前提下完成 HTTPS 调用的。**

两个问题听起来不相关，其实是同一套机制的两面。下面先把设计问题摆开。

---

### 1. 设计问题

NanoClaw 在三个维度上对 agent 不信任：

1. **agent 在容器里跑可能调危险操作**：删本地文件、调外部 API 扣费（Stripe / OpenAI 配额）、装新包（apt / npm postinstall script 是 RCE 入口）、`git push --force` ……一旦 model output 偏离，损失是实打实的。这些动作必须让人类管理员在合适时刻收到一张审批卡，决策（"允许 / 拒绝"），并 atomically 应用。
2. **API key / OAuth token 不能写 env**：进程的 environ 在容器里随便 `/proc/<pid>/environ` 就能读。一旦 agent 被 prompt injection 哄骗去 `cat /proc/self/environ`，所有凭证一次性外泄到 model context（然后被 model 总结进出站消息发到聊天）。
3. **凭证也不能进 chat context**：上面那条比较好理解，但还有个更隐蔽的：哪怕你把 token 藏在 `~/.config/myservice/token`，agent 只要被允许做 HTTP 调用就可以把 token 作为 `Authorization: Bearer` 头加进 curl。这意味着只要 token 一次性出现在 agent 的某个 tool call 参数里，它就 **已经进了上下文窗口**，下次模型 summary 时就可能被 leak。

回答这三个问题的不是 NanoClaw 自己写的代码，而是它依赖的一个独立 daemon：**OneCLI**。NanoClaw 只是把 OneCLI 当作"agent vault gateway"用，自己做的是：

- 启动每个 container 时调 OneCLI `ensureAgent` 注册一个 OneCLI agent；
- 注册 OneCLI 的 manual-approval callback —— 当 OneCLI hold 住一个需要审批的 request 时，NanoClaw 把审批卡发给 admin DM；
- 复用同一套 approval primitive 处理别的审批场景（self-mod、channel-registration、sender-approval）。

```
┌─────────────────────────────────────────────────────────────────────┐
│                       NanoClaw host process                          │
│                                                                     │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ src/modules/approvals/primitive.ts                              │ │
│ │   pickApprover / pickApprovalDelivery / requestApproval         │ │
│ │   registerApprovalHandler / approvalHandlers Map                │ │
│ └────────────────┬────────────────────────────────────────────────┘ │
│                  │                                                  │
│      ┌───────────┴─────────────┬──────────────┬─────────────────┐  │
│      ▼                         ▼              ▼                 ▼  │
│ ┌─────────┐         ┌───────────────────┐ ┌────────┐ ┌──────────┐ │
│ │self-mod │         │ onecli-approvals  │ │channel-│ │ sender-  │ │
│ │install_ │         │ ONECLI_ACTION =   │ │approval│ │ approval │ │
│ │packages │         │ 'onecli_credential'│ │        │ │          │ │
│ │/add_mcp │         │                   │ │        │ │          │ │
│ │_server  │         │ onecli.configureManualApproval(cb)         │ │
│ └─────────┘         └─────────┬─────────┘ └────────┘ └──────────┘ │
│                              │                                     │
│                              │ HTTP long-poll                      │
└──────────────────────────────┼─────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        OneCLI gateway (daemon)                       │
│                http://127.0.0.1:10254                                │
│                                                                     │
│  - secrets vault (本地加密存储 OAuth tokens / API keys)             │
│  - agent registry (per-agent secret allow-list)                     │
│  - HTTP proxy + CA cert (透明注入凭证)                              │
│  - approval rules (server-side decide *when* to hold a request)     │
└─────────────────────┬───────────────────────────────────────────────┘
                      │ HTTPS_PROXY + CA bundle 注入到 container
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│             per-agent container (Docker)                            │
│                                                                     │
│ env:                                                                │
│   HTTPS_PROXY=http://onecli-gateway:10254                           │
│   SSL_CERT_FILE=/onecli/ca.crt                                      │
│                                                                     │
│ 容器内 curl / fetch / requests / git 全部自动走 proxy                │
│ → OneCLI 注入 Authorization 头 → 上游真实 API                       │
│                                                                     │
│ container/skills/onecli-gateway/SKILL.md 教 agent 怎么用 + 出错处理 │
└─────────────────────────────────────────────────────────────────────┘
```

下面分八节展开。

---

### 2. OneCLI 是什么 / 不是什么

OneCLI 是 Anthropic（或第三方）做的本地 daemon —— **不是 NanoClaw 项目的一部分**。NanoClaw 通过 `@onecli-sh/sdk` 跟它交互。运行时它默认监听 `http://127.0.0.1:10254`（HTTP，本机回环）。

它管四件事：

| 资源        | 内容                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `secrets`   | 加密存储的 API keys、OAuth tokens、cookies、等。带 host pattern（"`*.gmail.googleapis.com`"），约束这个 secret 注入到哪些上游。 |
| `agents`    | 注册过的 agent，每个 agent 有 `secret_mode`（`all` / `selective`），决定 vault 里哪些 secret 会被注入到它的请求里。                |
| `proxy`     | HTTPS 透明代理 + 自签 CA cert。容器内进程通过 `HTTPS_PROXY` 把流量送过来，proxy 看 host → 决定注入哪个 secret → 发到上游。       |
| `approvals` | 服务端 rules：可以配"对 host `api.stripe.com` 的所有 POST 都需要 manual approval"。命中时挂起 request 并 emit pending approval。 |

NanoClaw 永远只跟 OneCLI 通过 SDK 通信，不直接走 HTTP API。SDK 接口：

```ts
// src/container-runner.ts:10 + 50 (相关 import)
import { OneCLI } from '@onecli-sh/sdk';
const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
```

`ONECLI_URL` / `ONECLI_API_KEY` 来自 `src/config.ts:36-37`：

```ts
// src/config.ts:36-37
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
```

由 `/init-onecli` skill 装上 OneCLI + 把这两个值写进 `.env`。

---

### 3. `ensureAgent`：每个 agent group 对应一个 OneCLI agent

`src/container-runner.ts:139-148`：

```ts
// src/container-runner.ts:135-147 (节选)
const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
// OneCLI agent identifier is always the agent group id — stable across
// sessions and reversible via getAgentGroup() for approval routing.
const agentIdentifier = agentGroup.id;
const args = await buildContainerArgs(
  mounts,
  containerName,
  agentGroup,
  containerConfig,
  provider,
  contribution,
  agentIdentifier,
);
```

`buildContainerArgs` 里调 `ensureAgent` + `applyContainerConfig`：

```ts
// src/container-runner.ts:421-433 (节选)
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
log.info('OneCLI gateway applied', { containerName });
```

三件事：

1. **`ensureAgent({ name, identifier })`**：调用 OneCLI 的 `POST /api/agents`。如果 identifier（agent_group_id）不存在就创建一个，存在就 no-op。整个 NanoClaw 系统里 OneCLI agent identifier 就是 agent_group_id，反向映射用 `getAgentGroup(externalId)` 拿到 agent group 信息（approval routing 需要）。
2. **`applyContainerConfig`**：往 `args`（docker `run` 的参数数组）里 append 一组 `-e HTTPS_PROXY=...`、`-e SSL_CERT_FILE=...`、`-v <ca-bundle>:/onecli/ca.crt:ro` 之类的项。这一步是 OneCLI SDK 自己实现的。
3. **失败硬中断**：如果 OneCLI 没起 / 拒绝 apply，整个 spawn 抛错 —— host-sweep 会在下一拍重试。**绝不允许"凭证 gateway 失败 → 容器照样起 → agent 调 API 都失败"** 这种半通的状态。

#### 3.1 设计选择：每个 agent group 一个 agent identifier

为什么不是"每个 session 一个 OneCLI agent"？因为 OneCLI 里 agent 是个长寿对象 —— admin 在 OneCLI 控制台手动配置"这个 agent 用哪些 secrets / 哪些 host pattern 走 approval"。session 是临时的（生命周期几小时到几天），每次 spawn 都新建一个 OneCLI agent + 手动配 secret 模式 —— 没法用。agent group 才是"长寿 + 跟人类管理员心智模型对应"的粒度。

反过来"每个 OS user 一个 agent identifier"也不行 —— 一个用户多个 agent group（Sales agent、PR Review agent、Personal Assistant），每个用的 secrets 不同，混着 vault 安全语义就垮了。

---

### 4. 一个新 agent 一上来就 401 —— `selective` secret mode

这是 `CLAUDE.md:156-180` 里专门拿出来讲的 gotcha，因为踩过的人都印象深刻。

`onecli.ensureAgent` 创建 agent 时，OneCLI 默认给它 `secret_mode='selective'` —— 意思是"vault 里有什么 secret 我都不分配给这个 agent，除非你显式 `set-secrets`"。所以：

- 新 agent 启动后，容器内 HTTPS proxy 工作正常、CA cert 安装正常；
- 但 agent 调任何 API 都得到 401 / 403 / "app_not_connected"；
- 因为 OneCLI 收到 request → 查 agent secret mode → selective + 这个 host 不在 agent secrets allow-list → 不注入凭证 → upstream 看不到 Authorization 头 → 401。

修复 **不能** 通过 SDK 完成。`@onecli-sh/sdk` 故意不暴露 `setSecretMode` —— 这是设计上的"secret 配置只能由人工通过 CLI / web UI 完成"。三个选项：

```bash
# CLAUDE.md:164-178
# 1. 切到 'all' —— vault 里所有 host pattern 匹配的 secret 都注入
onecli agents set-secret-mode --id <agent-id> --mode all

# 2. 保持 selective，但显式 assign 具体 secret
onecli secrets list                                       # 找 secret id
onecli agents set-secrets --id <agent-id> --secret-ids <id1>,<id2>

# 3. 用 web UI（默认 http://127.0.0.1:10254）—— 可视化更友好
```

`onecli agents secrets --id <agent-id>` 查这个 agent 当前能用什么。

**配完不用重启 container** —— gateway 每次 request 都重新查 agent secret 配置，下一个 API call 就生效。

但相对的：如果 agent 已经在跑、admin 在 OneCLI 把它从 `all` 改回 `selective`，下一个 request 就会失败。这种"实时生效"是 OneCLI 故意的设计 —— 紧急 revoke 不需要 kill 容器。

---

### 5. Approval 双侧：server-side decide + host-side deliver

这是 `CLAUDE.md:182-189` 反复强调的核心机制：**OneCLI 决定什么时候 hold 一个 request、NanoClaw 决定怎么把审批发给人**。两侧任何一边没接通，整个流程都不工作。

#### 5.1 Server-side：configure rules

只能通过 OneCLI web UI 配（`http://127.0.0.1:10254`）。原话（`CLAUDE.md:186`）：

> As of `onecli@1.3.0`, the CLI does **not** expose this — `rules create --action` only accepts `block` or `rate_limit`, and `secrets create` has no approval flag.

意思是：

- CLI 里 `onecli rules create --action approve` 不支持（只支持 `block` / `rate_limit`）。
- 必须在 web UI "Rules" 标签页加一条 "match host `api.stripe.com` AND method=POST → action=approve TTL=10min" 这样的规则。
- 命中规则时，OneCLI 在 HTTP 上 hold 住 request（保持连接不返回），同时往 `/api/approvals/pending` queue 里塞一个 `ApprovalRequest`。

#### 5.2 Host-side：configureManualApproval callback

`src/modules/approvals/onecli-approvals.ts:85-101`：

```ts
// src/modules/approvals/onecli-approvals.ts:85-101 (节选)
export function startOneCLIApprovalHandler(deliveryAdapter: ChannelDeliveryAdapter): void {
  if (handle) return;
  adapterRef = deliveryAdapter;

  // 扫描上次进程留下的脏行
  sweepStaleApprovals().catch((err) =>
    log.error('OneCLI approval sweep failed', { err }),
  );

  handle = onecli.configureManualApproval(async (request: ApprovalRequest): Promise<Decision> => {
    try {
      return await handleRequest(request);
    } catch (err) {
      log.error('OneCLI approval handler errored', { id: request.id, err });
      return 'deny';
    }
  });
  log.info('OneCLI approval handler started');
}
```

`configureManualApproval` 内部是长 poll —— SDK 持续 GET `/api/approvals/pending`，每次回来一个 `ApprovalRequest` 就调 callback。callback 返回 `'approve'` / `'deny'`，SDK 把决定 POST 回 OneCLI，OneCLI 才放行或拒绝 upstream request。

NanoClaw 何时启动这个 callback？看 `src/modules/approvals/index.ts`：

```ts
// src/modules/approvals/index.ts:29-36 (节选)
registerResponseHandler(handleApprovalsResponse);

onDeliveryAdapterReady((adapter) => {
  startOneCLIApprovalHandler(adapter);
});

onShutdown(() => {
  stopOneCLIApprovalHandler();
});
```

依赖 delivery adapter（第 9 章的 `getDeliveryAdapter`）—— 因为 callback 要 deliver 审批卡，必须有可用的投递通道才能起。`onDeliveryAdapterReady` 是 host 启动序列里 delivery 装好后的钩子。

#### 5.3 callback 主体

`onecli-approvals.ts:113-215`，完整流程：

```ts
// src/modules/approvals/onecli-approvals.ts:113-215 (概览)
async function handleRequest(request: ApprovalRequest): Promise<Decision> {
  if (!adapterRef) return 'deny';

  // 1. 反查这个 OneCLI request 来自哪个 agent group
  const originGroup = request.agent.externalId
    ? getAgentGroup(request.agent.externalId)
    : undefined;
  const agentGroupId = originGroup?.id ?? null;

  // 2. 选 approver + delivery DM
  const approvers = pickApprover(agentGroupId);
  if (approvers.length === 0) return 'deny';
  const target = await pickApprovalDelivery(approvers, '');
  if (!target) return 'deny';

  // 3. 短 id（Telegram callback_data 64B 限制）
  const approvalId = shortApprovalId();   // "oa-" + 8 base36 chars
  const question = buildQuestion(request, originGroup?.name ?? request.agent.name);

  // 4. deliver 卡片
  const platformMessageId = await adapterRef.deliver(
    target.messagingGroup.channel_type,
    target.messagingGroup.platform_id,
    null,
    'chat-sdk',
    JSON.stringify({
      type: 'ask_question',
      questionId: approvalId,
      title: 'Credentials Request',
      question,
      options: [
        { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
        { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
      ],
    }),
  );

  // 5. 写 pending_approvals 行
  createPendingApproval({
    approval_id: approvalId,
    session_id: null,                  // ← OneCLI approval 没有 session 上下文
    request_id: request.id,
    action: ONECLI_ACTION,             // = 'onecli_credential'
    payload: JSON.stringify({
      oneCliRequestId: request.id,
      method: request.method,
      host: request.host,
      path: request.path,
      bodyPreview: request.bodyPreview,
      agent: request.agent,
      approver: target.userId,
    }),
    created_at: new Date().toISOString(),
    agent_group_id: agentGroupId,
    channel_type: target.messagingGroup.channel_type,
    platform_id: target.messagingGroup.platform_id,
    platform_message_id: platformMessageId ?? null,
    expires_at: request.expiresAt,
    status: 'pending',
    title: 'Credentials Request',
    options_json: JSON.stringify(onecliOptions),
  });

  // 6. 等待 admin 点按钮 OR 超时
  return new Promise<Decision>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(approvalId)) return;
      pending.delete(approvalId);
      expireApproval(approvalId, 'no response').catch(...);
      resolve('deny');
    }, timeoutMs);
    pending.set(approvalId, { resolve, timer });
  });
}
```

几个值得停一下的细节：

**短 id**：`shortApprovalId()`（`onecli-approvals.ts:63-65`）生成 `oa-XXXXXXXX`（10 字节）。OneCLI 的 `request.id` 是 UUID（36 字节），塞进 chat-sdk-bridge 的 `ncq:<id>:Approve` 格式按钮里会超 Telegram 64 字节 callback_data 上限。OneCLI 的 UUID 保存在 payload 里供审计。

**双层存活**：状态同时活在两个地方 —— 内存 `pending` Map（持有 resolve 函数和 timer）+ DB `pending_approvals` 行。两个的目的不同：

- 内存：因为 OneCLI HTTP 连接还挂着，必须能在收到点击时同步 resolve 那个 Promise，把决定送回 OneCLI gateway。
- DB：让 host 重启不丢可视化记录 + 让 sweep 能编辑 expired 卡片为"❌ Expired (host restarted)"。

**`session_id: null`**：OneCLI approval 没有起源 session —— 它由 OneCLI gateway 触发，不来自 NanoClaw 的 router。这就是 `handleApprovalsResponse` 里对 ONECLI_ACTION 走专门 branch 的原因（见 §7）。

**`expires_at` 比 gateway TTL 早 1s**（`onecli-approvals.ts:200-201`）：

```ts
const expiresAtMs = new Date(request.expiresAt).getTime();
const timeoutMs = Math.max(1000, expiresAtMs - Date.now() - 1000);
```

确保我们的决定在 gateway 关连接之前送达 —— 即使 HTTP 那边已经超时，我们也要 resolve Promise 让 SDK callback 干净退出，否则下次 callback 会拒绝起。

#### 5.4 启动 sweep + 关机清理

进程启动时（`startOneCLIApprovalHandler` 里）调 `sweepStaleApprovals`：

```ts
// src/modules/approvals/onecli-approvals.ts:247-255
async function sweepStaleApprovals(): Promise<void> {
  const rows = getPendingApprovalsByAction(ONECLI_ACTION);
  if (rows.length === 0) return;
  log.info('Sweeping stale OneCLI approvals from previous process', { count: rows.length });
  for (const row of rows) {
    await editCardExpired(row, 'host restarted');
    deletePendingApproval(row.approval_id);
  }
}
```

把 DB 里上一次进程没处理完的 OneCLI approval 全部编辑成"Expired (host restarted)"。理由：

- 那些 OneCLI 那边的 HTTP request 早就已经超时关闭了 —— 即使现在 approve，凭证也不会注入。
- 留在 admin chat 上不动是误导（"我刚才点了 approve 怎么没反应"）。直接更新为 expired 状态更清晰。
- 这也是为什么 platform_message_id 持久化在 pending_approvals 上 —— 进程崩重启后还能找到那张卡片去编辑。

---

### 6. `primitive.ts`：跨场景共用的 approval 底座

`src/modules/approvals/primitive.ts`。三个公开 API：

```ts
// src/modules/approvals/primitive.ts (公开 surface)
export function pickApprover(agentGroupId: string | null): string[];
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null>;
export async function requestApproval(opts: RequestApprovalOptions): Promise<void>;
export function registerApprovalHandler(action: string, handler: ApprovalHandler): void;
export function notifyAgent(session: Session, text: string): void;
```

#### 6.1 `pickApprover`：从 `user_roles` 表挑

`primitive.ts:76-93`：

```ts
// src/modules/approvals/primitive.ts:76-93
export function pickApprover(agentGroupId: string | null): string[] {
  const approvers: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      approvers.push(id);
    }
  };

  if (agentGroupId) {
    for (const r of getAdminsOfAgentGroup(agentGroupId)) add(r.user_id);
  }
  for (const r of getGlobalAdmins()) add(r.user_id);
  for (const r of getOwners()) add(r.user_id);

  return approvers;
}
```

优先顺序：

```
scoped admin（针对该 agent group）→ global admin → owner
```

没有 env 变量（如 `NANOCLAW_ADMIN_USER_IDS`）—— roles 全部从 central DB 的 `user_roles` 表读。设置 role 通过 `ncl roles set <user-id> <role>` 命令（`src/cli/resources/roles.ts`）。

#### 6.2 `pickApprovalDelivery`：选第一个能 DM 通的

`primitive.ts:103-119`：

```ts
// src/modules/approvals/primitive.ts:103-119 (节选)
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null> {
  // 同 channel 优先 —— 减少跨 platform 体验跳跃
  if (originChannelType) {
    for (const userId of approvers) {
      if (channelTypeOf(userId) !== originChannelType) continue;
      const mg = await ensureUserDm(userId);
      if (mg) return { userId, messagingGroup: mg };
    }
  }
  // 退化：第一个能 DM 通的
  for (const userId of approvers) {
    const mg = await ensureUserDm(userId);
    if (mg) return { userId, messagingGroup: mg };
  }
  return null;
}
```

tie-break 规则：

1. 优先和原始事件同 channel kind 的 approver。例：messaging_group 来自 Slack，那么先试 Slack-namespaced 的 approver id（`slack:U...`）。
2. 都不通就按 `approvers` 顺序找第一个能 `ensureUserDm` 成功的。

`ensureUserDm` 在第 11 章 §1 的 `openDM` 接口下已经讲过 —— 详细看 `src/modules/permissions/user-dm.ts`。它是个有 cache 的两类资源解析器：

- **Direct-addressable channels**（Telegram / WhatsApp / iMessage / Matrix / email）：user handle 就是 DM platform id，无需 openDM 调用。
- **Resolution-required channels**（Discord / Slack / Teams / Webex / Google Chat）：必须调 `adapter.openDM(handle)` 拿一个 DM channel id。

结果 cache 在 `user_dms` 表（`src/modules/permissions/db/user-dms.ts` + migration），按 `(user_id, channel_type)` 索引。冷 DM 第一次付出一次 platform round-trip，后续都是纯 DB 读。

#### 6.3 `requestApproval`：模块发起审批的入口

`primitive.ts:164-220`：

```ts
// src/modules/approvals/primitive.ts:164-220 (节选)
export async function requestApproval(opts: RequestApprovalOptions): Promise<void> {
  const { session, action, payload, title, question, agentName } = opts;

  const approvers = pickApprover(session.agent_group_id);
  if (approvers.length === 0) {
    notifyAgent(session, `${action} failed: no owner or admin configured to approve.`);
    return;
  }

  const originChannelType = session.messaging_group_id
    ? (getMessagingGroup(session.messaging_group_id)?.channel_type ?? '')
    : '';

  const target = await pickApprovalDelivery(approvers, originChannelType);
  if (!target) {
    notifyAgent(session, `${action} failed: no DM channel found for any eligible approver.`);
    return;
  }

  const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedOptions = normalizeOptions(APPROVAL_OPTIONS);  // ['Approve','Reject']
  createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    request_id: approvalId,
    action,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    title,
    options_json: JSON.stringify(normalizedOptions),
  });

  const adapter = getDeliveryAdapter();
  if (adapter) {
    try {
      await adapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: approvalId,
          title,
          question,
          options: APPROVAL_OPTIONS,
        }),
      );
    } catch (err) {
      log.error('Failed to deliver approval card', { action, approvalId, err });
      notifyAgent(session, `${action} failed: could not deliver approval request to ${target.userId}.`);
      return;
    }
  }
}
```

签名（`primitive.ts:145-156`）：

```ts
export interface RequestApprovalOptions {
  session: Session;
  agentName: string;
  /** 自由文本动作标识。必须匹配消费者用 registerApprovalHandler 注册的 key。 */
  action: string;
  payload: Record<string, unknown>;
  title: string;
  question: string;
}
```

caller 必须先 `registerApprovalHandler(action, handler)` —— 否则 approve 之后系统找不到处理回调，会通知 agent "approved but no handler installed"（见 §7）。

#### 6.4 `registerApprovalHandler`：模块挂回调

`primitive.ts:59-68`：

```ts
// src/modules/approvals/primitive.ts:57-68
const approvalHandlers = new Map<string, ApprovalHandler>();

export function registerApprovalHandler(action: string, handler: ApprovalHandler): void {
  if (approvalHandlers.has(action)) {
    log.warn('Approval handler re-registered (overwriting)', { action });
  }
  approvalHandlers.set(action, handler);
}

export function getApprovalHandler(action: string): ApprovalHandler | undefined {
  return approvalHandlers.get(action);
}
```

`ApprovalHandlerContext`（`primitive.ts:46-53`）传给 handler 的上下文：

```ts
export interface ApprovalHandlerContext {
  session: Session;
  payload: Record<string, unknown>;
  userId: string;
  /** 给 agent session 写一条系统消息（agent 看得见） */
  notify: (text: string) => void;
}
```

self-mod 模块的注册（`src/modules/self-mod/index.ts:22-30`）：

```ts
// src/modules/self-mod/index.ts:22-30
import { registerApprovalHandler } from '../approvals/index.js';
import { applyInstallPackages } from './apply.js';
import { applyAddMcpServer } from './apply.js';

registerApprovalHandler('install_packages', applyInstallPackages);
registerApprovalHandler('add_mcp_server', applyAddMcpServer);
```

`install_packages` / `add_mcp_server` 是 container 里 agent 通过 MCP 工具发起的"我想装个 puppeteer" / "我想新加一个 MCP server"。container agent 那边走 `requestApproval` MCP 工具 → host 写 pending_approvals 行 → admin 看到卡片 → approve → handler 实际去 rebuild docker image / 更新 container_configs。

---

### 7. 用户回应处理：response handler 链

按钮点击的流向（继承第 11 章末尾那张图）：

```
admin 点 Approve 按钮
        │
        ▼
chat-sdk-bridge.chat.onAction
        │
        ▼
setupConfig.onAction(questionId, selectedOption, userId)
        │
        ▼
host writeSessionMessage (kind='question_response')
        │
        ▼
router 拣到 → dispatchResponse(payload)
        │
        ▼
按注册顺序依次试 response handler，第一个 return true 的 claim
```

`src/modules/approvals/response-handler.ts:24-43`：

```ts
// src/modules/approvals/response-handler.ts:24-43
export async function handleApprovalsResponse(payload: ResponsePayload): Promise<boolean> {
  // 1. 先检查内存 OneCLI Promise resolver
  if (resolveOneCLIApproval(payload.questionId, payload.value)) {
    return true;
  }

  // 2. DB-backed pending_approvals
  const approval = getPendingApproval(payload.questionId);
  if (!approval) return false;

  if (approval.action === ONECLI_ACTION) {
    // 行存在但内存 resolver 没了 —— timer 触发或进程怪状态。drop 即可。
    deletePendingApproval(payload.questionId);
    return true;
  }

  await handleRegisteredApproval(approval, payload.value, payload.userId ?? '');
  return true;
}
```

注意 `return false` 的语义 —— "我不认领这个 questionId，让下一个 handler 试"。这就是 dispatchResponse 用得着 handler 链而不是单一 handler 的原因：sender-approval / channel-approval（permissions module）注册了自己的 response handler；同一个按钮点击事件可能来自任意一种 pending 表，先到的链先尝试 claim，未中再传给下一个。

#### 7.1 OneCLI claim 优先

为什么 OneCLI 在最前？因为 OneCLI approval 是 in-memory Promise — 时间敏感。HTTP 那边等着我们的决定，不要 round-trip 走 DB 再回来。`resolveOneCLIApproval`（`onecli-approvals.ts:68-83`）做的事：

```ts
// src/modules/approvals/onecli-approvals.ts:68-83
export function resolveOneCLIApproval(approvalId: string, selectedOption: string): boolean {
  const state = pending.get(approvalId);
  if (!state) return false;
  pending.delete(approvalId);
  clearTimeout(state.timer);

  const decision: Decision = selectedOption === 'approve' ? 'approve' : 'deny';
  updatePendingApprovalStatus(approvalId, decision === 'approve' ? 'approved' : 'rejected');
  // Card 已经被 chat-sdk-bridge.onAction 自动编辑成"✅ Approved"了，
  // 我们不用再 deliver edit。
  deletePendingApproval(approvalId);

  state.resolve(decision);
  log.info('OneCLI approval resolved', { approvalId, decision });
  return true;
}
```

`state.resolve(decision)` 唤醒第 5.3 节里那个挂着的 Promise，SDK callback 返回，SDK 把决定 POST 回 OneCLI，OneCLI 放行 / 拒绝 upstream HTTP request。

#### 7.2 一般 registered approval

`handleRegisteredApproval`（`response-handler.ts:45-106`）：

```ts
// src/modules/approvals/response-handler.ts:45-106 (概览)
async function handleRegisteredApproval(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
): Promise<void> {
  if (!approval.session_id) { deletePendingApproval(approval.approval_id); return; }
  const session = getSession(approval.session_id);
  if (!session) { deletePendingApproval(approval.approval_id); return; }

  const notify = (text: string): void => {
    writeSessionMessage(session.agent_group_id, session.id, { ... sys chat ... });
  };

  if (selectedOption !== 'approve') {
    notify(`Your ${approval.action} request was rejected by admin.`);
    deletePendingApproval(approval.approval_id);
    await wakeContainer(session);
    return;
  }

  // Approved
  const handler = getApprovalHandler(approval.action);
  if (!handler) {
    notify(`Your ${approval.action} was approved, but no handler is installed to apply it.`);
    deletePendingApproval(approval.approval_id);
    await wakeContainer(session);
    return;
  }

  const payload = JSON.parse(approval.payload);
  try {
    await handler({ session, payload, userId, notify });
  } catch (err) {
    notify(`Your ${approval.action} was approved, but applying it failed: ${err.message}.`);
  }

  deletePendingApproval(approval.approval_id);
  await wakeContainer(session);
}
```

几个细节：

- 总是 `wakeContainer(session)` —— 把 agent 唤醒去看 system notify 消息 + 看修改后的状态。即使 reject，agent 也应该被告知"你被拒了"，否则它会一直等。
- `payload` 是 caller `requestApproval` 时传的 opaque JSON —— handler 自己 parse 自己用。例：`install_packages` 的 payload 是 `{ apt: [...], npm: [...] }`，handler 把它写进 container_configs 然后 rebuild image。
- handler throw 不会泄漏给 admin —— admin 已经走完了点击。只通知 agent。

---

### 8. 其它 approval kind 共享同一个 primitive

按 §6 的设计，"action 字符串"就是分发 key。表格汇总：

| Action          | 触发                                                         | Payload                                | Handler 在哪                                                                 |
| --------------- | ------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------- |
| `install_packages` | container 里 agent 调 self-mod MCP tool                    | `{ apt: [...], npm: [...] }`           | `src/modules/self-mod/apply.ts:applyInstallPackages`                          |
| `add_mcp_server`   | 同上                                                       | `{ serverName, config }`               | `src/modules/self-mod/apply.ts:applyAddMcpServer`                             |
| `onecli_credential` | OneCLI gateway hold 一个 request                          | `{ oneCliRequestId, method, host, ... }` | 不用 handler —— resolveOneCLIApproval Promise resolver                       |
| —（不走 pending_approvals）| 未知 channel 第一次产生消息                          | InboundEvent JSON                      | `src/modules/permissions/index.ts:handleChannelApprovalResponse`              |
| —（不走 pending_approvals）| 已知 channel 上未知 sender 触发                      | InboundEvent JSON                      | `src/modules/permissions/index.ts:handleSenderApprovalResponse`               |

注意最下两行**不走 pending_approvals 表**，走专门的 `pending_channel_approvals` / `pending_sender_approvals` 表（migration 011 / 012 创建）。原因：

- channel-approval 的"卡片选项"动态依赖现有 agent group 数（"Connect to <name>" + "Connect new agent" + "Reject"，不是固定的 Approve/Reject），所以 row 上需要存 render metadata。
- sender-approval 需要存 `sender_identity` 用来 dedup（migration 011 的 `UNIQUE(messaging_group_id, sender_identity)`）。
- 两者都 PK on messaging_group_id 或 sender_identity，给"重复刷"提供天然 dedup。

但 **共享同一个 chat-sdk-bridge → onAction → response handler 链**。chat-sdk-bridge 不知道 questionId 指向哪个表 —— 它只负责把 (questionId, value, userId) 送上来。response handler 链按顺序试，谁先认领算谁的：

```
dispatchResponse (src/index.ts:37-47)
  ├─ handleSenderApprovalResponse    (permissions/index.ts:225)
  ├─ handleChannelApprovalResponse   (permissions/index.ts:310)
  ├─ handleApprovalsResponse         (approvals/response-handler.ts:24)
  │     ├─ resolveOneCLIApproval (内存)
  │     └─ getPendingApproval(questionId) (DB → action handler dispatch)
  └─ ... (其他模块注册的)
```

`registerResponseHandler` 在各模块 import 时按 import 顺序注册（`src/index.ts` 第 49-55 行 import 顺序决定）。

---

### 8.5. Approval 表 schema 演化

`pending_approvals` 本身是 migration 003 / module-approvals-pending-approvals 建的（早期）。后续三个 migration 演化出了别的 approval 表，也演化出了 render metadata 列：

**migration 011** (`src/db/migrations/011-pending-sender-approvals.ts`)：

```sql
-- src/db/migrations/011-pending-sender-approvals.ts:23-38
CREATE TABLE IF NOT EXISTS pending_sender_approvals (
  id                   TEXT PRIMARY KEY,
  messaging_group_id   TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
  sender_identity      TEXT NOT NULL,      -- namespaced user id
  sender_name          TEXT,
  original_message     TEXT NOT NULL,      -- JSON serialized InboundEvent
  approver_user_id     TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  UNIQUE(messaging_group_id, sender_identity)
);
```

注释（migration 011 的 doc-comment）讲了一段有意思的历史：原本这个 migration 还想顺手 rebuild messaging_groups 把默认 unknown_sender_policy 从 `'strict'` 改成 `'request_approval'`，但 SQLite 在有 FK 引用时不允许 DROP TABLE rebuild，PRAGMA foreign_keys 也不能在 implicit migration transaction 里切。最终改为"cosmetic default 不改、每个 createMessagingGroup 显式传 unknown_sender_policy、router auto-create 路径 hardcode 默认值"。

**migration 012** (`012-channel-registration.ts`)：

```sql
-- src/db/migrations/012-channel-registration.ts:30-48
-- 1. messaging_groups.denied_at —— ALTER ADD COLUMN, FK-safe
ALTER TABLE messaging_groups ADD COLUMN denied_at TEXT;

-- 2. pending_channel_approvals
CREATE TABLE IF NOT EXISTS pending_channel_approvals (
  messaging_group_id   TEXT PRIMARY KEY REFERENCES messaging_groups(id),
  agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
  original_message     TEXT NOT NULL,
  approver_user_id     TEXT NOT NULL,
  created_at           TEXT NOT NULL
);
```

`PRIMARY KEY ON messaging_group_id` 给免费的 in-flight dedup（INSERT OR IGNORE 第二次 mention 时静默丢弃，不发第二张卡）。

`denied_at` 的用法：admin reject → 写当前 ISO 时间。router 后续遇到此 mg 直接丢消息：

```
// src/router.ts:212-215
if (mg.denied_at) {
  log.info('MESSAGE DROPPED — messaging group denied', { ..., deniedAt: mg.denied_at });
  return;
}
```

**migration 013** (`013-approval-render-metadata.ts`)：

```sql
-- src/db/migrations/013-approval-render-metadata.ts:22-25
ALTER TABLE pending_channel_approvals ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE pending_channel_approvals ADD COLUMN options_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE pending_sender_approvals  ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE pending_sender_approvals  ADD COLUMN options_json TEXT NOT NULL DEFAULT '[]';
```

migration 13 的 doc-comment 解释了原因：之前这两张表的 `getAskQuestionRender` 在 DB 访问层 hardcode 了 title / option labels，导致 **初始卡片标题** ("📣 Bot mentioned in new chat" / "💬 New direct message"，按 event 不同) 和 **post-click render**（"📣 Channel registration"，固定）肉眼可见地漂移。把 render metadata 跟 row 一起存，两边读同一份才一致。

总结 schema：所有"待处理审批"行都满足 `(questionId, title, options_json, ...)` 这套通用形状，且这套形状被 `getAskQuestionRender(questionId)` 在 chat-sdk-bridge 那边统一查到。

---

### 9. CLI 视角：`ncl approvals` 给运维

`src/cli/resources/approvals.ts` 注册了一个只读资源。列出待审批：

```bash
ncl approvals list                              # 列所有 pending_approvals 行
ncl approvals get <approval_id>                 # 单行详情
ncl approvals list --filter action=install_packages
ncl approvals list --filter status=pending
```

代码很短：

```ts
// src/cli/resources/approvals.ts
registerResource({
  name: 'approval',
  plural: 'approvals',
  table: 'pending_approvals',
  description: 'Pending approval — in-flight approval cards waiting for an admin response. ...',
  idColumn: 'approval_id',
  columns: [
    { name: 'approval_id', type: 'string', ... },
    { name: 'session_id', type: 'string', description: 'Null for OneCLI credential approvals.' },
    { name: 'request_id', ... },
    { name: 'action', ... },  // install_packages / add_mcp_server / onecli_credential
    { name: 'payload', type: 'json', ... },
    { name: 'created_at', ... },
    { name: 'agent_group_id', ... },
    { name: 'channel_type', ... },
    { name: 'platform_id', ... },
    { name: 'platform_message_id', ... },
    { name: 'expires_at', ... },
    { name: 'status', ... },  // pending / approved / rejected / expired
    { name: 'title', ... },
    { name: 'options_json', ... },
  ],
  operations: { list: 'open', get: 'open' },  // 任意 cli_scope 都能读
});
```

`operations: { list: 'open', get: 'open' }` 表示无论 cli_scope（self / group / global）都能读 —— 因为 approval row 不含敏感凭证（payload 里的 OneCLI request 已被 `bodyPreview` 截断）。但 `pending_channel_approvals` / `pending_sender_approvals` 没注册 CLI 资源，要查得直接 sqlite shell。

---

### 10. `src/modules/approvals/onecli-approvals.ts` vs `src/onecli-approvals.ts`

任务描述里提到两个文件名 —— 验证一下当前代码版本只有 module 里那一个：

```
$ find /Users/xgliu/Documents/git/nanoclaw/src -name "onecli*" -type f
/Users/xgliu/Documents/git/nanoclaw/src/modules/approvals/onecli-approvals.ts
```

v2.0.64 上 **`src/onecli-approvals.ts` 已经不存在**。早期版本曾有过两层结构（CLAUDE.md:154 仍然提到 `src/onecli-approvals.ts` —— 是 stale 引用，PR #7 重构把 OneCLI approval 整体折叠进 approvals module 时清理掉了）。

当前架构（PR #7 之后）：

```
src/modules/approvals/
├── index.ts                # 模块入口 —— registerResponseHandler + onDeliveryAdapterReady + onShutdown
├── primitive.ts            # 公开 API: pickApprover / requestApproval / registerApprovalHandler
├── onecli-approvals.ts     # OneCLI-specific：startOneCLIApprovalHandler / resolveOneCLIApproval / sweep
└── response-handler.ts     # handleApprovalsResponse —— claim 在 questionId 上 dispatch
```

回顾启动逻辑 `index.ts`（§5.2 已引用）：

```ts
// src/modules/approvals/index.ts:28-36
registerResponseHandler(handleApprovalsResponse);   // 注册响应处理器

onDeliveryAdapterReady((adapter) => {
  startOneCLIApprovalHandler(adapter);              // 启动 OneCLI 长 poll callback
});

onShutdown(() => {
  stopOneCLIApprovalHandler();                      // 关机停 callback
});
```

`onDeliveryAdapterReady` 把 OneCLI 启动延迟到 delivery 准备好之后 —— 否则 callback 触发时拿不到 adapterRef 没法 deliver 卡片。如果你看代码注释里仍写"`src/onecli-approvals.ts`"，参考 §11 troubleshooting 里说的，那是文档 stale，看实际代码以这章为准。

---

### 11. 常见问题诊断

#### 问题 A："agent 调 Gmail API 一直 401"

排查（按可能性排序）：

1. **secret mode 没切**（§4 / `CLAUDE.md:156-180`）。
   ```bash
   onecli agents list
   onecli agents secrets --id <agent-id>     # 这个 agent 当前有哪些 secret
   onecli secrets list                       # vault 里有哪些 secret + host pattern
   ```
   如果 agent secrets 列表是空 + selective mode，那就是这个问题。
   ```bash
   onecli agents set-secret-mode --id <agent-id> --mode all
   # 或者 set-secrets --secret-ids <id>
   ```
   不需要重启容器，下次 request 立即生效。

2. **vault 里没这个服务的 secret**。
   ```bash
   onecli secrets list | grep -i gmail
   ```
   没有 —— 去 OneCLI web UI（http://127.0.0.1:10254）"Connect Service" 走 OAuth。或者按 `container/skills/onecli-gateway/SKILL.md` 教的，agent 第一次拿到 `app_not_connected` 错误时，本来就该把 connect URL 给用户。

3. **`ensureAgent` 根本没跑成功**。看 `logs/nanoclaw.log`：
   ```bash
   grep "OneCLI gateway applied" logs/nanoclaw.log
   ```
   没看到 —— `applyContainerConfig` 返回 false，container 在 spawn 时已经被 reject 了。

#### 问题 B："admin 点了 Approve 卡片但是没动静"

按 §5 + §7 的双侧 + dispatch 链分析：

1. **server-side（OneCLI）规则没配**：你以为有 rule 但其实没有。
   ```bash
   onecli rules list
   ```
   只有 block / rate_limit 规则的话，那 OneCLI 从来就没 hold 过任何 request，host callback 也从没被调用过 —— 卡片是别的 action 触发的（self-mod？ channel-approval？）。

2. **host callback 没起**：
   ```bash
   grep "OneCLI approval handler started" logs/nanoclaw.log
   ```
   没看到 —— `startOneCLIApprovalHandler` 没被调。检查 delivery adapter 是不是没装好（`onDeliveryAdapterReady` 没触发）。

3. **callback throw 了**：
   ```bash
   grep "OneCLI approval handler errored" logs/nanoclaw.error.log
   ```

4. **response 没被任何 handler claim**：
   ```bash
   grep "Unclaimed response" logs/nanoclaw.log
   ```
   有命中 —— 说明 questionId 在所有表里都查不到。可能 sweep 已经把行清了（host 重启 + sweep），或者 questionId 是手动伪造的。

#### 问题 C："新 channel 第一次 mention bot 没收到审批卡"

参考第 11 章 §8 的 channel-approval 流程。检查：

1. **没 owner / admin**：
   ```
   grep "Channel registration skipped — no owner or admin configured" logs/nanoclaw.log
   ```
   先去 `ncl roles set <user-id> owner` 装一个 role。

2. **没 agent group**（fresh install 没跑过 `/init-first-agent`）：
   ```
   grep "Channel registration skipped — no agent groups configured" logs/nanoclaw.log
   ```

3. **approver 不可达**：
   ```
   grep "Channel registration skipped — no DM channel for any approver" logs/nanoclaw.log
   ```
   approver 是 Discord user 但 Discord adapter 没装；或 Discord adapter 装了但 bot 没和这个 user 有过任何 DM 历史，openDM 拒绝（user 设置了 "only friends can DM me"）。

#### 问题 D："agent 不停被卡在 OneCLI approval timeout 上"

通常说明 server-side 规则配得太宽 —— 把"agent 频繁正常调用"的 API 也设成 approve。每次都要 admin 点，admin 累 → admin 不在线 → request 超时 → agent 失败 → agent 重试 → 死循环。

解决方法是 OneCLI rules 改得更细：只对 "高风险动作"（POST / DELETE 到敏感 host）开 approve，纯读 API 放过。

---

### 12. 容器里 agent 视角：`onecli-gateway` SKILL.md

为了让 agent 知道"我应该怎么用这套代理"，NanoClaw 容器里挂了个 container skill：`container/skills/onecli-gateway/SKILL.md`。容器启动时 skill 被加载进 Claude Agent 的 CLAUDE.md，让 agent 在 prompt 层就知道：

引用关键段落（`container/skills/onecli-gateway/SKILL.md:16-43`）：

> Your outbound HTTPS traffic is transparently proxied through the OneCLI gateway, which injects stored credentials at the proxy boundary. You never see or handle credential values directly.
>
> You have direct HTTP access to external APIs. OAuth apps (Gmail, GitHub, Google Calendar, Google Drive, etc.) and API key services are all available through the gateway. Just make the request directly; the gateway injects credentials if the app is connected. If not, it returns an error with a connect URL you can present to the user.

agent 出错时怎么办（同文件 56-71 行）：

> If you get a 401, 403, or a gateway error (e.g., `app_not_connected`):
>
> Step 1 — Show the user a connect link. Use the `connect_url` from the error response.
>
> Step 2 — Retry after the user connects.

外加几条硬规则（73-86 行）：

> - **Never** say "I don't have access to X" without first making the HTTP request through the proxy.
> - **Never** use browser extensions, gcloud, or manual auth flows.
> - **Never** ask the user for API keys or tokens directly.
> - **Never** suggest the user open Gmail/Calendar/GitHub in their browser when they ask you to read or interact with those services.
> - If the gateway returns a policy error (403 with a JSON body), respect the block.

这些规则的目的是消除一类常见 LLM 失败模式："看到 401 就放弃 / 看到 OAuth 就让用户去浏览器手动登录 / 看到 token 就索取明文"。agent 知道有 gateway 在，就会正确地把 connect URL 交给用户而不是绕远路。

---

### 13. 总结

把这章涉及的所有部件按照"一个 admin approve OneCLI credential request"的全路径走一遍：

```
1. agent (container)  →  curl https://api.stripe.com/v1/charges
                         走 HTTPS_PROXY，转给 OneCLI gateway

2. OneCLI gateway     →  匹配 rule "host=api.stripe.com AND method=POST → approve"
                         hold HTTP connection
                         emit ApprovalRequest 到 /api/approvals/pending

3. NanoClaw           →  SDK long-poll 收到 ApprovalRequest
   onecli-approvals.ts    handleRequest(request):
                          - reverse-lookup agent_group via request.agent.externalId
                          - pickApprover(agentGroupId)
                          - pickApprovalDelivery → ensureUserDm
                          - shortApprovalId() (10 bytes for Telegram)
                          - deliver ask_question 卡片 到 admin DM
                          - createPendingApproval row (action='onecli_credential')
                          - new Promise + setTimeout(expires_at - 1s)

4. chat-sdk-bridge    →  收到 outbound row，渲染 Discord embed + buttons
                         postMessage to admin DM

5. admin              →  在 Discord 里看到 "Credentials Request" 卡，点 ✅ Approve

6. chat-sdk-bridge    →  chat.onAction fires
                         setupConfig.onAction(approvalId, 'approve', adminUserId)

7. router             →  writeSessionMessage (kind='question_response')
                         dispatchResponse → handleApprovalsResponse
                         → resolveOneCLIApproval(approvalId, 'approve')
                         → 找到内存 Promise resolver
                         → updatePendingApprovalStatus(approved)
                         → deletePendingApproval(approvalId)
                         → state.resolve('approve')

8. SDK callback       →  return 'approve'
                         SDK POST decision 回 OneCLI gateway

9. OneCLI gateway     →  注入 Authorization header
                         转发请求到 api.stripe.com
                         返回 200 给 container 内 curl

10. agent             →  正常拿到响应，继续干活
```

整套链路里：

- 凭证从来没出过 OneCLI vault；
- container env 里没有任何 secret；
- chat context 里只有"approval request"的 metadata（method、host、path、bodyPreview），没有 token；
- admin 看到的是"agent 想调 Stripe API charges 接口"，决策足够信息但没有泄漏 secret。

这就是 NanoClaw + OneCLI 这套"agent vault + 双侧审批 + 共享 primitive"的协同 —— 安全语义全在 OneCLI（独立 daemon、独立加密 vault、独立审计），NanoClaw 只做"把审批卡片送到合适的人 + 把人的决定送回去"的连接职责。

---

### 关键文件汇总

| 文件                                                       | 行数参考           | 用途                                                                |
| ---------------------------------------------------------- | ------------------ | ------------------------------------------------------------------- |
| `src/config.ts`                                            | 36-37              | ONECLI_URL / ONECLI_API_KEY 配置                                    |
| `src/container-runner.ts`                                  | 50, 139-148, 421-433 | `onecli.ensureAgent` + `applyContainerConfig` 调用点               |
| `src/modules/approvals/index.ts`                           | 全部              | 模块入口：注册 response handler、启动 OneCLI callback、关机清理     |
| `src/modules/approvals/primitive.ts`                       | 76-93 (pickApprover), 103-119 (pickApprovalDelivery), 164-220 (requestApproval), 57-68 (registerApprovalHandler) | 跨场景共用 primitive |
| `src/modules/approvals/onecli-approvals.ts`                | 85-101 (start), 113-215 (handleRequest), 68-83 (resolveOneCLIApproval), 247-255 (sweep) | OneCLI gateway 桥 + 内存 Promise resolver |
| `src/modules/approvals/response-handler.ts`                | 24-43 (handleApprovalsResponse), 45-106 (handleRegisteredApproval) | response handler 链入口 |
| `src/modules/self-mod/index.ts`                            | 22-30              | `install_packages` / `add_mcp_server` 注册样本                      |
| `src/modules/permissions/user-dm.ts`                       | 52-112             | ensureUserDm（cold-DM 解析 + 缓存）                                  |
| `src/modules/permissions/channel-approval.ts`              | 128-237            | 新 channel 注册审批                                                  |
| `src/modules/permissions/sender-approval.ts`               | 全部              | 已知 channel 上未知 sender 审批                                      |
| `src/modules/permissions/index.ts`                         | 225-510            | sender / channel approval response handler + 名字 interceptor       |
| `src/db/migrations/011-pending-sender-approvals.ts`        | 全部              | pending_sender_approvals schema                                     |
| `src/db/migrations/012-channel-registration.ts`            | 全部              | denied_at 列 + pending_channel_approvals schema                     |
| `src/db/migrations/013-approval-render-metadata.ts`        | 全部              | title / options_json 列追加                                          |
| `src/cli/resources/approvals.ts`                           | 全部              | `ncl approvals list/get` CLI 资源                                    |
| `container/skills/onecli-gateway/SKILL.md`                 | 全部              | 容器内 agent 的 gateway 使用 / 错误处理指导                          |
| `CLAUDE.md` §"Secrets / Credentials / OneCLI"              | 152-189            | 设计 + secret mode gotcha + 双侧 approval 解释                       |
