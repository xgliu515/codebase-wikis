# 第 14 章 认证与安全

> 代码版本锁定：`openclaw/openclaw@50a2481652`（tag `v2026.5.18`，2026-05-18）

## 14.1 本章要解决的问题

OpenClaw 是一个「自托管的个人 AI 助手网关」。它有一个 Gateway 进程对外暴露 HTTP / WebSocket 接口，前面挂着 Control UI、移动 App、CLI、各种聊天频道。这就带来一连串安全问题：

- 谁能连这个 Gateway？凭什么连？（**鉴权**）
- 连上之后，一个调用方能做什么、不能做什么？（**scope 权限**）
- 一台新设备（手机、桌面 App）怎么第一次「认识」这个 Gateway？（**设备配对**）
- 各种厂商 API key、Gateway 口令这些**机密**怎么存、怎么注入、怎么轮换、怎么审计？（**secrets 管理**）
- 哪些事情是「危险操作」、需要额外护栏？（**安全边界**）

理解这一章之前，必须先抓住一个贯穿全局的前提——OpenClaw 的**信任模型**。`SECURITY.md` 把它写得非常直白：

> OpenClaw does **not** model one gateway as a multi-tenant, adversarial user boundary.
> Authenticated Gateway callers are treated as trusted operators for that gateway instance.
> （`SECURITY.md`，"Operator Trust Model" 一节）

也就是说：**一个 Gateway = 一个信任域，里面没有「互相提防的用户」**。能通过 Gateway 鉴权的调用方，一律被当作「这台 Gateway 的可信操作者（trusted operator）」。`SECURITY.md` 推荐的部署是「一人一机一 Gateway」：

> Recommended mode: one user per machine/host (or VPS), one gateway for that user, and one or more agents inside that gateway.

这个前提**直接决定了**本章很多设计为什么是现在这个样子。比如下文 14.3 会看到：用共享密钥（token / password）认证的 HTTP 调用方会直接拿到**全套** operator scope——这不是 bug，而是信任模型的必然结果。带着这个前提读，很多看似「权限不够细」的地方就讲得通了。

本章的目录地图：

| 子系统 | 入口目录 | 职责 |
| --- | --- | --- |
| Gateway 鉴权 | `src/gateway/auth.ts` 等 | 解析连接凭据，判定 token/password/tailscale/trusted-proxy |
| scope 权限 | `src/gateway/method-scopes.ts`、`operator-scopes.ts` | 把 RPC 方法映射到所需 scope，检查调用方 scope |
| 设备配对 | `src/pairing/` | 聊天频道侧的设备/账号配对（pairing code、allowFrom） |
| 设备令牌鉴权 | `src/gateway/device-auth.ts` | 设备签名 payload 构造 |
| Secrets 管理 | `src/secrets/` | 加密/外部 secret 解析、环境变量注入、审计 |
| 安全审计 | `src/security/` | `openclaw doctor` 的安全检查、危险配置识别 |

---

## 14.2 鉴权的三种模式

### 14.2.1 ResolvedGatewayAuth：鉴权配置的归一化

一切从「这个 Gateway 配的是哪种鉴权」开始。`src/gateway/auth-resolve.ts` 的 `resolveGatewayAuth`（`src/gateway/auth-resolve.ts:31`）把原始配置 + 环境变量 + 覆盖项归一成一个 `ResolvedGatewayAuth`：

```ts
// src/gateway/auth-resolve.ts:17
export type ResolvedGatewayAuth = {
  mode: ResolvedGatewayAuthMode;          // "none" | "token" | "password" | "trusted-proxy"
  modeSource?: ResolvedGatewayAuthModeSource;
  token?: string;
  password?: string;
  allowTailscale: boolean;
  trustedProxy?: GatewayTrustedProxyConfig;
};
```

四种 `mode`（`src/gateway/auth-resolve.ts:9`）：

- `none`——无鉴权（仅适合 loopback / 私网）；
- `token`——共享 Bearer token；
- `password`——共享口令；
- `trusted-proxy`——把鉴权交给前置反代，反代在 HTTP 头里传用户身份。

`mode` 的推导有优先级（`src/gateway/auth-resolve.ts:74`）：

```ts
// src/gateway/auth-resolve.ts:76
if (authOverride?.mode !== undefined) {
  mode = authOverride.mode;
  modeSource = "override";
} else if (authConfig.mode) {
  mode = authConfig.mode;
  modeSource = "config";
} else if (password) {
  mode = "password";
  modeSource = "password";
} else if (token) {
  mode = "token";
  modeSource = "token";
} else {
  mode = "token";
  modeSource = "default";
}
```

**显式 override → 配置的 mode → 配了 password 就 password → 配了 token 就 token → 默认 token**。`modeSource` 字段记下「是怎么推出来的」——这对诊断很有用，例如能区分「用户明确选了 token」和「啥都没配，默认成了 token」。

注意 token / password 的值是用 `resolveGatewayCredentialsFromValues` 解析的（`src/gateway/auth-resolve.ts:63`），并且如果配置里写的是 SecretRef（见 14.6），这里会先剥成 `undefined`——因为 Gateway 启动那一刻 secrets 系统还没初始化，bootstrap 凭据必须是明文或环境变量。这条约束在 14.3.3 的报错里也能看到。

`allowTailscale`（`src/gateway/auth-resolve.ts:93`）默认值很微妙：

```ts
// src/gateway/auth-resolve.ts:93
const allowTailscale =
  authConfig.allowTailscale ??
  (params.tailscaleMode === "serve" && mode !== "password" && mode !== "trusted-proxy");
```

只有当 Gateway 跑在 Tailscale `serve` 模式、且不是 password / trusted-proxy 模式时，才默认允许 Tailscale 头鉴权。

### 14.2.2 三种鉴权方法的全景

把 `resolveGatewayAuth` 的「配置」和 `authorizeGatewayConnect` 的「运行时判定」连起来，整个鉴权流程是这样的：

```
   连接进来 (HTTP 请求 / WS 握手)
        │
        ▼
   authorizeGatewayConnect (auth.ts:400)
        │
        ├─ authSurface = "http" 还是 "ws-control-ui"?
        │
        ▼
   authorizeGatewayConnectCore (auth.ts:435)
        │
        ├── mode === "trusted-proxy" ──► authorizeTrustedProxy
        │      检查来源 IP / 必需头 / userHeader / allowUsers
        │
        ├── mode === "none" ──────────► 直接 ok
        │
        ├── 速率限制检查 (limiter.check)
        │
        ├── allowTailscale 且 ws-control-ui ──► resolveVerifiedTailscaleUser
        │      读 Tailscale 头 + whois 反查 + login 比对
        │
        ├── mode === "token" ─────────► authorizeTokenAuth (safeEqualSecret)
        │
        └── mode === "password" ──────► authorizePasswordAuth (safeEqualSecret)
```

`GatewayAuthResult`（`src/gateway/auth.ts:36`）描述结果，`method` 字段记下用了哪种方法：

```ts
// src/gateway/auth.ts:36
export type GatewayAuthResult = {
  ok: boolean;
  method?:
    | "none" | "token" | "password" | "tailscale"
    | "device-token" | "bootstrap-token" | "trusted-proxy";
  user?: string;
  reason?: string;
  rateLimited?: boolean;
  retryAfterMs?: number;
};
```

`reason` 字段在失败时给出非常细的原因码（`token_missing` / `token_mismatch` / `trusted_proxy_user_not_allowed` 等），便于运维排查——但注意这些码是给日志看的，不会原样回给客户端。

### 14.2.3 鉴权面（auth surface）的区别

`authorizeGatewayConnect` 有一个 `authSurface` 参数（`src/gateway/auth.ts:59`），两种取值：

```ts
// src/gateway/auth.ts:59
export type GatewayAuthSurface = "http" | "ws-control-ui";
```

为什么要分？关键差异在 Tailscale 头鉴权：

```ts
// src/gateway/auth.ts:324
function shouldAllowTailscaleHeaderAuth(authSurface: GatewayAuthSurface): boolean {
  return authSurface === "ws-control-ui";
}
```

`src/gateway/auth.ts:67` 的注释解释得很清楚：

> Explicit auth surface. HTTP keeps Tailscale forwarded-header auth disabled. WS Control UI enables it intentionally for tokenless trusted-host login.

**为什么 HTTP 面要禁掉 Tailscale 头鉴权？** 因为 HTTP 兼容端点（`/v1/chat/completions` 等）是给程序化客户端用的，让它们通过转发头「免 token 登录」会扩大攻击面。而 WS Control UI 面是给浏览器里的人用的，「在 Tailscale 网内打开 UI 就自动登录」是一个刻意的便利特性。`auth.ts` 末尾两个便捷封装 `authorizeHttpGatewayConnect`（`src/gateway/auth.ts:564`）/ `authorizeWsControlUiGatewayConnect`（`src/gateway/auth.ts:573`）就是把 surface 写死。

### 14.2.4 Token / Password 鉴权与时序安全比较

`authorizeTokenAuth`（`src/gateway/auth.ts:354`）/ `authorizePasswordAuth`（`src/gateway/auth.ts:378`）结构对称。以 token 为例：

```ts
// src/gateway/auth.ts:354
function authorizeTokenAuth(params: {...}): GatewayAuthResult {
  if (!params.authToken) {
    return { ok: false, reason: "token_missing_config" };
  }
  if (!params.connectToken) {
    // Don't burn rate-limit slots for missing credentials — the client
    // simply hasn't provided a token yet (e.g. bare browser open).
    return { ok: false, reason: "token_missing" };
  }
  if (!safeEqualSecret(params.connectToken, params.authToken)) {
    params.limiter?.recordFailure(params.ip, params.rateLimitScope);
    return { ok: false, reason: "token_mismatch" };
  }
  params.limiter?.reset(params.ip, params.rateLimitScope);
  return { ok: true, method: "token" };
}
```

两个关键设计：

**1）「没带凭据」与「凭据错了」区别对待。** 注释说明：客户端只是「还没提供 token」（比如裸开一个浏览器页面）时，不应消耗速率限制额度——只有**真正提供了错的 token** 才算一次失败（`recordFailure`）。成功登录则 `reset` 清空该 IP 的失败计数。

**2）时序安全比较。** `safeEqualSecret`（`src/security/secret-equal.ts:12`）用 `crypto.timingSafeEqual` 而不是 `===`：

```ts
// src/security/secret-equal.ts:12
export function safeEqualSecret(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  const byteLength = Math.max(providedBytes.length, expectedBytes.length);
  if (byteLength === 0) {
    return true;
  }
  return (
    timingSafeEqual(
      padSecretBytes(providedBytes, byteLength),
      padSecretBytes(expectedBytes, byteLength),
    ) && providedBytes.length === expectedBytes.length
  );
}
```

**为什么不能用 `===`？** 普通字符串比较会在第一个不等的字符处提前返回，攻击者可以通过测量响应时间逐字符猜出密钥。`timingSafeEqual` 的耗时与内容无关。但它要求两个 Buffer 等长——所以这里先 `padSecretBytes` 把短的那个补零到等长，再额外比较一次真实长度（`&& providedBytes.length === expectedBytes.length`）。padding 这一步本身也是为了避免「长度不同直接快速返回」泄露长度信息。

### 14.2.5 Trusted-proxy 模式

`trusted-proxy` 模式把鉴权委托给前置反代（如 nginx + OAuth2 proxy）。`authorizeTrustedProxy`（`src/gateway/auth.ts:270`）做了一长串校验：

```ts
// src/gateway/auth.ts:281
const remoteAddr = req.socket?.remoteAddress;
if (!remoteAddr || !isTrustedProxyAddress(remoteAddr, trustedProxies)) {
  return { reason: "trusted_proxy_untrusted_source" };
}
const remoteIsLoopback = isLoopbackAddress(remoteAddr);
if (remoteIsLoopback && trustedProxyConfig.allowLoopback !== true) {
  return { reason: "trusted_proxy_loopback_source" };
}
if (!remoteIsLoopback) {
  const localInterfaceMatch = resolveLocalInterfaceAddressMatch(remoteAddr);
  if (localInterfaceMatch === undefined) {
    return { reason: "trusted_proxy_local_interface_check_failed" };
  }
  if (localInterfaceMatch) {
    return { reason: "trusted_proxy_local_interface_source" };
  }
}
```

校验链条：

1. 来源 IP 必须在 `trustedProxies` 白名单里；
2. 来源是 loopback 时，必须显式 `allowLoopback`（否则任何本地进程都能伪造身份头）；
3. 来源是本机其他网卡地址时，直接拒——本机地址不该被当成「外部反代」；
4. `requiredHeaders` 里的头必须都存在（`src/gateway/auth.ts:299`）——反代会注入这些头，缺了说明请求绕过了反代；
5. `userHeader` 必须有值，且如果配了 `allowUsers` 白名单，用户必须在内（`src/gateway/auth.ts:316`）。

`authorizeGatewayConnectConfigured` 还有一个 `assertGatewayAuthConfigured`（`src/gateway/auth.ts:222`）做配置自检——比如 trusted-proxy 模式下又配了 token 会直接报错：

```ts
// src/gateway/auth.ts:258
if (auth.token) {
  throw new Error(
    "gateway auth mode is trusted-proxy, but a shared token is also configured; ..." +
    "trusted-proxy and token auth are mutually exclusive",
  );
}
```

trusted-proxy 模式还会对浏览器请求做 Origin 检查（`authorizeTrustedProxyBrowserOrigin`，`src/gateway/auth.ts:328`）——即使反代认证通过，跨站请求伪造的 Origin 仍会被 `checkBrowserOrigin` 拦下。

### 14.2.6 Tailscale 头鉴权

Tailscale 是一个 mesh VPN。当 Gateway 跑在 `tailscale serve` 后面时，Tailscale 会在请求头里塞 `tailscale-user-login` 等。`resolveVerifiedTailscaleUser`（`src/gateway/auth.ts:189`）验证这些头：

```ts
// src/gateway/auth.ts:189
async function resolveVerifiedTailscaleUser(params: {...}) {
  const tailscaleUser = getTailscaleUser(req);
  if (!tailscaleUser) {
    return { ok: false, reason: "tailscale_user_missing" };
  }
  if (!isTailscaleProxyRequest(req)) {
    return { ok: false, reason: "tailscale_proxy_missing" };
  }
  const clientIp = resolveTailscaleClientIp(req);
  if (!clientIp) {
    return { ok: false, reason: "tailscale_whois_failed" };
  }
  const whois = await tailscaleWhois(clientIp);
  if (!whois?.login) {
    return { ok: false, reason: "tailscale_whois_failed" };
  }
  if (normalizeLogin(whois.login) !== normalizeLogin(tailscaleUser.login)) {
    return { ok: false, reason: "tailscale_user_mismatch" };
  }
  return { ok: true, user: { login: whois.login, /* ... */ } };
}
```

**为什么不能只信请求头？** HTTP 头是可以伪造的。`resolveVerifiedTailscaleUser` 做了双重确认：

1. `isTailscaleProxyRequest`（`src/gateway/auth.ts:182`）——请求必须来自 loopback，且带全套 `x-forwarded-*` 头（说明确实经过了本机的 `tailscale serve`）；
2. 用客户端 IP 调 Tailscale 的 `whois` 反查真实身份，再与请求头里声称的 `login` 比对。

只有「头里写的人」和「whois 反查出来的人」一致，才认这个身份。

### 14.2.7 速率限制

`src/gateway/auth-rate-limit.ts` 是一个**纯内存滑动窗口限流器**。设计权衡在文件头注释里写得很清楚（`src/gateway/auth-rate-limit.ts:1`）:

```
// src/gateway/auth-rate-limit.ts:9
 * Design decisions:
 * - Pure in-memory Map – no external dependencies; suitable for a single
 *   gateway process.
 * - Loopback addresses (127.0.0.1 / ::1) are exempt by default so that local
 *   CLI sessions are never locked out.
```

默认参数（`src/gateway/auth-rate-limit.ts:79`）：1 分钟窗口内最多 10 次失败，超限锁定 5 分钟。限流器支持「scope」——不同凭据类别用独立计数器（`src/gateway/auth-rate-limit.ts:38`）：

```ts
// src/gateway/auth-rate-limit.ts:38
export const AUTH_RATE_LIMIT_SCOPE_DEFAULT = "default";
export const AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET = "shared-secret";
export const AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN = "device-token";
export const AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH = "hook-auth";
```

**为什么 loopback 默认豁免？** 本机的 CLI 会话频繁连接 Gateway，如果把它们也限流，一个调试脚本就能把自己锁在门外。`SECURITY.md` 的信任模型里本机调用本来就是可信的。

Tailscale 鉴权这条异步分支限流要特别处理——`authorizeGatewayConnect`（`src/gateway/auth.ts:419`）用 `withSerializedRateLimitAttempt` 把同一 `{scope, ip}` 的「预检查 + 失败写入」串行化，防止异步窗口里并发请求绕过限流。

---

## 14.3 Scope 权限体系

### 14.3.1 六种 operator scope

通过鉴权只是第一关。第二关是：**这个调用方能调哪些 RPC 方法?** OpenClaw 用 scope 来表达。`src/gateway/operator-scopes.ts` 定义了全部六种：

```ts
// src/gateway/operator-scopes.ts:1
export const ADMIN_SCOPE = "operator.admin" as const;
export const READ_SCOPE = "operator.read" as const;
export const WRITE_SCOPE = "operator.write" as const;
export const APPROVALS_SCOPE = "operator.approvals" as const;
export const PAIRING_SCOPE = "operator.pairing" as const;
export const TALK_SECRETS_SCOPE = "operator.talk.secrets" as const;
```

| Scope | 含义 |
| --- | --- |
| `operator.admin` | 管理操作（改配置、敏感动作）。**它是超级 scope**——见 14.3.3 |
| `operator.read` | 只读（列会话、看历史） |
| `operator.write` | 写操作（发消息、建会话） |
| `operator.approvals` | 审批相关（批准/拒绝待审操作） |
| `operator.pairing` | 设备配对相关方法 |
| `operator.talk.secrets` | Talk 通话的 secrets 访问 |

`isOperatorScope`（`src/gateway/operator-scopes.ts:27`）用一个 `Set` 做白名单校验——确保只有这六个已知值会被当作合法 scope。

CLI 默认拿到全套（`src/gateway/method-scopes.ts:30`）:

```ts
// src/gateway/method-scopes.ts:30
export const CLI_DEFAULT_OPERATOR_SCOPES: OperatorScope[] = [
  ADMIN_SCOPE, READ_SCOPE, WRITE_SCOPE, APPROVALS_SCOPE, PAIRING_SCOPE, TALK_SECRETS_SCOPE,
];
```

### 14.3.2 方法 → scope 的映射

`src/gateway/method-scopes.ts` 把每个 RPC 方法映射到它所需的 scope。`resolveScopedMethod`（`src/gateway/method-scopes.ts:39`）按三个来源依次查找：

```ts
// src/gateway/method-scopes.ts:39
function resolveScopedMethod(method: string): OperatorScope | undefined {
  const explicitScope = resolveCoreOperatorGatewayMethodScope(method);
  if (explicitScope) {
    return explicitScope;
  }
  const reservedScope = resolveReservedGatewayMethodScope(method);
  if (reservedScope) {
    return reservedScope;
  }
  const pluginDescriptor = getPluginRegistryState()?.activeRegistry?.gatewayMethodDescriptors?.find(
    (descriptor) => descriptor.name === method,
  );
  const pluginScope = pluginDescriptor?.scope;
  return pluginScope === "node" || pluginScope === "dynamic" ? undefined : pluginScope;
}
```

查找顺序：**core 方法描述符 → 保留方法策略 → 插件声明的方法描述符**。插件可以注册自己的 RPC 方法并声明所需 scope——但 `node` / `dynamic` 这两类特殊 scope 在这里返回 `undefined`，由别处单独处理。

围绕 `resolveScopedMethod` 还有一组语义化判定函数：`isReadMethod` / `isWriteMethod` / `isAdminOnlyMethod` / `isApprovalMethod` / `isPairingMethod`（`src/gateway/method-scopes.ts:55`–`77`）。

### 14.3.3 scope 检查：authorizeOperatorScopesForMethod

实际检查在 `authorizeOperatorScopesForMethod`（`src/gateway/method-scopes.ts:150`）。它的逻辑揭示了 scope 体系的两个核心规则：

```ts
// src/gateway/method-scopes.ts:150
export function authorizeOperatorScopesForMethod(
  method: string,
  scopes: readonly string[],
  params?: unknown,
): { allowed: true } | { allowed: false; missingScope: OperatorScope } {
  if (scopes.includes(ADMIN_SCOPE)) {
    return { allowed: true };
  }
  // ... dynamic 方法处理 ...
  const requiredScope = resolveRequiredOperatorScopeForMethod(method) ?? ADMIN_SCOPE;
  if (requiredScope === READ_SCOPE) {
    if (scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE)) {
      return { allowed: true };
    }
    return { allowed: false, missingScope: READ_SCOPE };
  }
  if (scopes.includes(requiredScope)) {
    return { allowed: true };
  }
  return { allowed: false, missingScope: requiredScope };
}
```

**规则一：`operator.admin` 是超级 scope。** 第一行——只要持有 `ADMIN_SCOPE`，任何方法都放行。

**规则二：`operator.write` 隐含 `operator.read`。** 当方法只需要 `READ_SCOPE` 时，持有 `WRITE_SCOPE` 也算满足——「能写当然能读」。

**规则三：默认拒绝（default-deny）。** 当方法没有被分类（`resolveRequiredOperatorScopeForMethod` 返回 `undefined`）时，`?? ADMIN_SCOPE` 把它兜底成「需要 admin」。换句话说，**一个未知/未分类的方法默认只有 admin 能调**。`resolveLeastPrivilegeOperatorScopesForMethod`（`src/gateway/method-scopes.ts:135`）对未分类方法直接返回空数组——也是 default-deny 的体现。

`AGENTS.md` 把这条原则写进了协议规则：

> Gateway protocol changes: additive first; incompatible needs versioning/docs/client follow-through.

新增方法时如果忘了分类，default-deny 保证它不会意外对低权限调用方开放。

### 14.3.4 共享密钥 = 全套 scope：信任模型的落地

这是本章最容易被误解的地方。`src/gateway/http-auth-utils.ts` 处理 HTTP 请求的 scope。注意 `shouldTrustDeclaredHttpOperatorScopes`（`src/gateway/http-auth-utils.ts:74`）:

```ts
// src/gateway/http-auth-utils.ts:74
function shouldTrustDeclaredHttpOperatorScopes(
  req: IncomingMessage,
  authOrRequest: ...,
): boolean {
  if (authOrRequest && "trustDeclaredOperatorScopes" in authOrRequest) {
    return authOrRequest.trustDeclaredOperatorScopes;
  }
  return !isGatewayBearerHttpRequest(req, authOrRequest);
}
```

`usesSharedSecretHttpAuth`（`src/gateway/http-auth-utils.ts:66`）判定是否共享密钥模式：

```ts
// src/gateway/http-auth-utils.ts:66
function usesSharedSecretHttpAuth(auth: SharedSecretGatewayAuth | undefined): boolean {
  return auth?.mode === "token" || auth?.mode === "password";
}
```

`SECURITY.md` 的 "Operator Trust Model" 一节把规则写死了：

> shared-secret bearer auth (`token` / `password`) authenticates possession of the gateway operator secret
> those requests receive the full default operator scope set (`operator.admin`, `operator.read`, `operator.write`, `operator.approvals`, `operator.pairing`)
> narrower `x-openclaw-scopes` headers are ignored for that shared-secret path

意思是：**用 token / password 通过鉴权的 HTTP 调用方，会直接拿到全套 operator scope，请求头里声明的更窄的 `x-openclaw-scopes` 会被忽略。** 只有「带身份的」HTTP 模式（trusted-proxy 鉴权、或私网入口 + `auth.mode="none"`）才会尊重请求声明的 per-request scope。

**为什么 scope 在共享密钥下「形同虚设」?** 回到 14.1 的信任模型——一个 Gateway 是一个信任域。共享密钥就是这个域的「主钥匙」，谁拿到它就是这台 Gateway 的可信操作者。在「一人一 Gateway」的模型下，没有「操作者 A 想限制操作者 B」的场景，所以也就没必要让共享密钥持有者去声明更窄的 scope。`SECURITY.md` 的 "Detailed False-Positive Patterns" 明确把「期待 `/v1/chat/completions` 实现 scope 边界」列为**非漏洞**。

scope 体系真正发挥作用的地方是**带身份的多客户端场景**——比如不同设备配对后持有不同 scope 的 device token，或 trusted-proxy 模式下不同用户。`getBearerToken`（`src/gateway/http-auth-utils.ts:29`）从 `Authorization: Bearer ...` 头里抽 token，是这套 HTTP scope 逻辑的入口。

### 14.3.5 动态方法与最小权限

`plugins.sessionAction` 这类「动态方法」需要特殊处理——它的所需 scope 取决于具体调的是哪个插件动作。`resolveSessionActionRegisteredScopes`（`src/gateway/method-scopes.ts:87`）从插件注册表里查这个动作声明的 `requiredScopes`：

```ts
// src/gateway/method-scopes.ts:102
const requiredScopes = registration.action.requiredScopes;
return requiredScopes && requiredScopes.length > 0 ? [...requiredScopes] : [WRITE_SCOPE];
```

有意思的是 `resolveSessionActionLeastPrivilegeScopes`（`src/gateway/method-scopes.ts:106`）的兜底逻辑——当本地进程没有那个插件的注册表信息时：

```ts
// src/gateway/method-scopes.ts:115
// A standalone CLI/tool caller may be talking to a gateway whose live
// plugin registry is not present in this local process. Avoid under-scoping
// valid dynamic actions when we cannot determine the exact requirement
// locally.
return [...CLI_DEFAULT_OPERATOR_SCOPES];
```

这里它**故意返回全套 scope** 而不是空数组。原因在注释里——一个独立 CLI 进程可能在跟一个远程 Gateway 通信，本地拿不到 Gateway 的实时插件注册表。如果这时按 default-deny 返回空 scope，会把合法的动态动作误拒。这是「default-deny」原则的一个**经过权衡的例外**：本地不知道精确要求时，宁可声明全套 scope 让远端 Gateway 去做最终判定，也不本地误拒。

---

## 14.4 设备配对

### 14.4.1 两种「配对」

OpenClaw 里「pairing」有两个层面，容易混淆：

1. **设备令牌鉴权**（`src/gateway/device-auth.ts`）——一台已配对的设备（手机 App、桌面 App）连 Gateway 时，用签名 payload 证明自己；
2. **聊天频道配对**（`src/pairing/`）——一个新的聊天身份（某个 Telegram 用户）第一次给助手发消息时，怎么建立「这个人是不是被授权的」的信任。

本节先讲 `src/pairing/`（聊天频道配对），device-auth 在 14.4.4。

### 14.4.2 pairing code 与配对挑战

`src/pairing/` 目录：

```
src/pairing/
  pairing-challenge.ts        发起配对挑战（生成 code、回复用户）
  pairing-store.ts            配对请求/allowFrom 名单的持久化
  pairing-store.types.ts      PairingChannel 类型
  pairing-messages.ts         配对回复文案
  pairing-labels.ts           频道标签
  setup-code.ts               setup code 处理
  allow-from-store-*.ts       allowFrom 名单的文件读写
```

配对流程的核心数据是 `PairingRequest`（`src/pairing/pairing-store.ts:48`）:

```ts
// src/pairing/pairing-store.ts:48
export type PairingRequest = {
  id: string;          // 发起方身份（如 Telegram user id）
  code: string;        // 8 位人类友好配对码
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, string>;
};
```

当一个未授权身份发消息进来，`issuePairingChallenge`（`src/pairing/pairing-challenge.ts:24`）发起挑战：

```ts
// src/pairing/pairing-challenge.ts:24
export async function issuePairingChallenge(
  params: PairingChallengeParams,
): Promise<{ created: boolean; code?: string }> {
  const { code, created } = await params.upsertPairingRequest({
    id: params.senderId,
    meta: params.meta,
  });
  if (!created) {
    return { created: false };       // 已存在挑战，不重复发
  }
  params.onCreated?.({ code });
  const replyText = params.buildReplyText?.({ code, senderIdLine: params.senderIdLine })
    ?? buildPairingReply({ channel: params.channel, idLine: params.senderIdLine, code });
  try {
    await params.sendPairingReply(replyText);
  } catch (err) {
    params.onReplyError?.(err);
  }
  return { created: true, code };
}
```

流程是：未授权用户发消息 → Gateway 生成一个 pairing code 并回复给他（「你的配对码是 XXXX，请把它告诉网关管理员」）→ 管理员在 Control UI 里输入这个 code 批准 → 该身份进入 allowFrom 名单。

「create-if-missing」语义很重要（`src/pairing/pairing-challenge.ts:31`）——同一个人反复发消息只会生成一个 code，避免刷屏。

### 14.4.3 pairing code 的安全设计

`pairing-store.ts` 的常量定义体现了几个安全考量：

```ts
// src/pairing/pairing-store.ts:31
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_MAX_ATTEMPTS = 500;
const PAIRING_PENDING_TTL_MS = 60 * 60 * 1000;   // 1 小时
const PAIRING_PENDING_MAX = 3;
```

**1）密码学随机 + 无歧义字母表。** `randomCode`（`src/pairing/pairing-store.ts:246`）用 `crypto.randomInt`：

```ts
// src/pairing/pairing-store.ts:246
function randomCode(): string {
  // Human-friendly: 8 chars, upper, no ambiguous chars (0O1I).
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    const idx = crypto.randomInt(0, PAIRING_CODE_ALPHABET.length);
    out += PAIRING_CODE_ALPHABET[idx];
  }
  return out;
}
```

字母表 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` 故意去掉了 `0/O/1/I` 这些容易看错的字符——配对码要人念给管理员，无歧义很重要。用 `crypto.randomInt` 而非 `Math.random()` 保证不可预测。

**2）唯一性保证。** `generateUniqueCode`（`src/pairing/pairing-store.ts:256`）最多重试 500 次确保 code 不撞，撞不出来就抛错——不会静默复用一个已存在的 code。

**3）过期清理。** `PAIRING_PENDING_TTL_MS` 是 1 小时，`pruneExpiredRequests`（`src/pairing/pairing-store.ts:189`）在每次读取时顺带清掉过期请求：

```ts
// src/pairing/pairing-store.ts:181
function isExpired(entry: PairingRequest, nowMs: number): boolean {
  const createdAt = parseTimestamp(entry.createdAt);
  if (!createdAt) {
    return true;
  }
  return nowMs - createdAt > PAIRING_PENDING_TTL_MS;
}
```

`parseTimestamp` 解析失败时 `isExpired` 直接返回 `true`——损坏的记录被当作过期清掉，不会留垃圾。

**4）每账号上限。** `pruneExcessRequestsByAccount`（`src/pairing/pairing-store.ts:210`）按账号分组，每个账号最多保留 `PAIRING_PENDING_MAX`（3）个待处理请求，超出的丢最旧的：

```ts
// src/pairing/pairing-store.ts:230
const sortedIndexes = indexes
  .slice()
  .toSorted((left, right) => resolveLastSeenAt(reqs[left]) - resolveLastSeenAt(reqs[right]));
for (const index of sortedIndexes.slice(0, sortedIndexes.length - maxPending)) {
  droppedIndexes.add(index);
}
```

**为什么要限上限？** 防止一个攻击者用大量假身份发消息，把配对请求列表塞满，淹没掉合法的配对请求。

**5）并发安全。** 配对存储是文件，多进程/多请求可能并发改它。`withFileLock`（`src/pairing/pairing-store.ts:117`）用文件锁串行化所有写操作，带重试和 stale 超时（`src/pairing/pairing-store.ts:36`）:

```ts
// src/pairing/pairing-store.ts:36
const PAIRING_STORE_LOCK_OPTIONS = {
  retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
  stale: 30_000,
} as const;
```

写文件本身用 `writeJsonFileAtomically`（`src/pairing/pairing-store.ts:84`）——原子写（写临时文件再 rename），避免半截文件。

### 14.4.4 allowFrom 名单：建立信任之后

配对批准后，身份进入 `allowFrom` 名单。`AllowFromStore` 是一个版本化的 JSON：`{ version: 1, allowFrom: string[] }`。

名单条目要归一化。`normalizeAllowEntry`（`src/pairing/pairing-store.ts:283`）:

```ts
// src/pairing/pairing-store.ts:283
function normalizeAllowEntry(channel: PairingChannel, entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "";          // 拒绝通配符
  }
  const adapter = getPairingAdapter(channel);
  const normalized = adapter?.normalizeAllowEntry ? adapter.normalizeAllowEntry(trimmed) : trimmed;
  return normalizeOptionalString(normalized) ?? "";
}
```

注意它**显式拒绝 `*` 通配符**——`*` 会被归一成空字符串然后被过滤掉。这防止有人往名单里写一个「允许所有人」的条目，把配对机制架空。每个频道还能通过 `getPairingAdapter` 提供自己的归一化逻辑（不同频道的 user id 格式不同）。

名单按账号分文件存（`resolveAllowFromFilePath`），并有读缓存（按文件 mtime/size 失效，`src/pairing/pairing-store.ts:366`）——配对名单在每条入站消息上都要查，缓存避免反复读盘。

### 14.4.5 设备令牌 payload

回到 `src/gateway/device-auth.ts`。已配对的设备连 Gateway 时，要用一个签名 payload 证明身份。`buildDeviceAuthPayloadV3`（`src/gateway/device-auth.ts:36`）构造待签名字符串：

```ts
// src/gateway/device-auth.ts:36
export function buildDeviceAuthPayloadV3(params: DeviceAuthPayloadV3Params): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  const platform = normalizeDeviceMetadataForAuth(params.platform);
  const deviceFamily = normalizeDeviceMetadataForAuth(params.deviceFamily);
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join("|");
}
```

payload 用 `|` 拼接固定字段，开头是版本号 `v3`（旧版 `buildDeviceAuthPayload` 是 `v2`，`src/gateway/device-auth.ts:20`）。设备用自己的私钥对这个字符串签名，Gateway 验签。

几个关键字段：

- `scopes`——**设备令牌可以携带受限 scope**。与 14.3.4 的共享密钥不同，device token 是「带身份的」凭据，它声明的 scope 会被尊重。这正是 scope 体系真正发挥作用的场景；
- `signedAtMs`——签名时间，用于拒绝过旧的签名（重放窗口）；
- `nonce`——一次性随机数，防重放；
- `platform` / `deviceFamily`——v3 新增的设备元数据，绑进签名，防止 token 在不同设备类型间挪用。

**为什么 payload 要带版本号且字段顺序固定？** 验签必须用与签名时完全一致的字符串。版本号让 Gateway 知道按哪个字段布局重建 payload；字段顺序固定保证签名方和验签方拼出的字符串逐字节一致。`v2` → `v3` 的演进（多了 `platform`/`deviceFamily`）正符合 `AGENTS.md` 的「additive first」协议演进原则。

`device-auth.ts` 对应的速率限制 scope 是 `AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN`（`src/gateway/auth-rate-limit.ts:40`）——设备令牌鉴权失败与共享密钥失败用独立计数器，互不影响。

---

## 14.5 Secrets 管理

### 14.5.1 secrets 子系统要解决的问题

一个 Gateway 要管很多机密：各个模型厂商的 API key、Gateway 自己的 token/password、频道的 bot token……这些不能裸写在配置文件里。`src/secrets/` 子系统解决：

- 机密怎么**存**——支持环境变量、外部文件、外部命令三种来源；
- 配置里怎么**引用**机密——用 `SecretRef`；
- 运行时怎么把机密**注入**给需要它的子系统；
- 怎么**审计**——扫出裸明文、扫出引用不到的 ref。

`src/secrets/` 是个大目录（120+ 文件）。核心几块：

```
src/secrets/
  ref-contract.ts          SecretRef 的格式契约与校验
  resolve.ts               把 SecretRef 解析成实际值（env/file/exec 三种 source）
  apply.ts                 把解析出的机密应用到运行时配置
  configure.ts             secrets 配置向导（openclaw secrets）
  audit.ts                 secrets 安全审计（裸明文/未解析 ref/影子 ref）
  provider-env-vars.ts     已知的 secret 环境变量名清单
  runtime-auth-collectors.ts 运行时认证收集器
  secret-value.ts          机密值类型判定
```

### 14.5.2 SecretRef：配置里的机密引用

OpenClaw 配置里不写明文机密，写 `SecretRef`——一个「指向某处机密」的引用。`ref-contract.ts` 定义了它的格式契约。一个 SecretRef 有三个部分：`source`（env / file / exec）、`provider`（哪个 secret provider）、`id`（在那个 provider 里的标识）。`secretRefKey`（`src/secrets/ref-contract.ts:37`）把它序列化成 `source:provider:id`：

```ts
// src/secrets/ref-contract.ts:37
export function secretRefKey(ref: SecretRef): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}
```

三种 `source` 对应三种机密来源：

- `env`——从环境变量读；
- `file`——从外部文件读（可以是单值文件，也可以是 JSON + JSON Pointer 定位）；
- `exec`——运行一个外部命令，拿它的 stdout（适合对接 1Password / Vault 等的 CLI）。

ref 的 id 格式有严格校验。`file` source 的 id 要么是字面量 `"value"`（单值文件），要么是一个 JSON Pointer（`src/secrets/ref-contract.ts:70`）:

```ts
// src/secrets/ref-contract.ts:70
export function isValidFileSecretRefId(value: string): boolean {
  if (value === SINGLE_VALUE_FILE_REF_ID) {
    return true;
  }
  if (!value.startsWith("/")) {
    return false;
  }
  return value.slice(1).split("/").every((segment) => FILE_SECRET_REF_SEGMENT_PATTERN.test(segment));
}
```

`exec` source 的 id 校验更严，要防路径穿越：

```ts
// src/secrets/ref-contract.ts:14
export const EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN =
  "^(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$";
```

`validateExecSecretRefId`（`src/secrets/ref-contract.ts:87`）会把失败原因区分成 `pattern`（字符不合法）和 `traversal-segment`（含 `.`/`..` 段）——后者是明确的路径穿越企图。

### 14.5.3 SecretRef 的解析

`resolve.ts` 是 secrets 子系统最重的文件（940 行）。它把 SecretRef 解析成实际值。

`resolveConfiguredProvider`（`src/secrets/resolve.ts:181`）先确认配置里声明了这个 provider，且它的 source 与 ref 一致：

```ts
// src/secrets/resolve.ts:193
if (providerConfig.source !== ref.source) {
  throw providerResolutionError({
    source: ref.source,
    provider: ref.provider,
    message: `Secret provider "${ref.provider}" has source "${providerConfig.source}" but ref requests "${ref.source}".`,
  });
}
```

**为什么要校验 source 一致?** 防止一个 `file` ref 意外指到一个 `exec` provider 上去执行命令——明确的类型对齐。

解析时有一组上限（`src/secrets/resolve.ts:29`）防止 secrets 解析本身被滥用：

```ts
// src/secrets/resolve.ts:29
const DEFAULT_PROVIDER_CONCURRENCY = 4;
const DEFAULT_MAX_REFS_PER_PROVIDER = 512;
const DEFAULT_MAX_BATCH_BYTES = 256 * 1024;
const DEFAULT_FILE_MAX_BYTES = 1024 * 1024;
const DEFAULT_FILE_TIMEOUT_MS = 5_000;
const DEFAULT_EXEC_TIMEOUT_MS = 5_000;
const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 1024 * 1024;
```

#### 文件 provider 的路径安全

`file` source 读外部文件时，`assertSecurePath`（`src/secrets/resolve.ts:203`）做了一长串校验，这是 secrets 子系统最关键的安全代码之一：

```ts
// src/secrets/resolve.ts:203
async function assertSecurePath(params: {...}): Promise<string> {
  if (!isAbsolutePathname(params.targetPath)) {
    throw new Error(`${params.label} must be an absolute path.`);
  }
  // ... symlink 处理 ...
  const perms = await inspectPathPermissions(effectivePath);
  // ...
  const writableByOthers = perms.worldWritable || perms.groupWritable;
  const readableByOthers = perms.worldReadable || perms.groupReadable;
  if (writableByOthers || (!params.allowReadableByOthers && readableByOthers)) {
    throw new Error(`${params.label} permissions are too open: ${effectivePath}`);
  }
```

校验项：

1. **必须绝对路径**——相对路径会随 cwd 变化，不可靠；
2. **symlink 处理**（`src/secrets/resolve.ts:217`）——默认拒绝 symlink；允许时会 `realpath` 解析并再次检查目标不是 symlink（防 symlink 链）；
3. **必须在 `trustedDirs` 内**（如果配了，`src/secrets/resolve.ts:235`）——用 `isPathInside` 兜底；
4. **权限不能太松**——文件不能 group/world 可写；默认也不能 group/world 可读；
5. **必须属当前用户**（`src/secrets/resolve.ts:262`）——`stat.uid !== process.getuid()` 直接拒；
6. **Windows ACL 不可验证时拒绝**（`src/secrets/resolve.ts:256`）——除非显式 `allowInsecurePath`。

**为什么对 secret 文件这么苛刻?** 这个文件里是 API key、口令。如果它 world-readable，同机其他用户能读到机密；如果它 world-writable，攻击者能把机密换成自己的。`assertSecurePath` 把这些都堵死。

文件 provider 的 payload 还有读缓存（`readFileProviderPayload`，`src/secrets/resolve.ts:273`）——同一个 provider 文件在一次解析里只读一次。读取用 `readSecureFile` 带 maxBytes/timeout（`src/secrets/resolve.ts:293`），超时会包装成清晰的错误（`src/secrets/resolve.ts:309`）。

#### 环境变量 provider 的 allowlist

`env` source 解析时（`resolveEnvRefs`，`src/secrets/resolve.ts:325`）支持 allowlist：

```ts
// src/secrets/resolve.ts:332
const allowlist = params.providerConfig.allowlist
  ? new Set(params.providerConfig.allowlist)
  : null;
for (const ref of params.refs) {
  if (allowlist && !allowlist.has(ref.id)) {
    throw refResolutionError({ source: "env", provider: params.providerName, refId: ref.id, /* ... */ });
  }
```

配了 allowlist 后，只有名单内的环境变量名能被引用——防止一个 secret ref 把任意环境变量（比如 `PATH`、其他敏感变量）读出来。

### 14.5.4 Secrets 审计

`audit.ts`（750 行）实现 `openclaw doctor` 的 secrets 检查。它扫四类问题（`src/secrets/audit.ts:41`）:

```ts
// src/secrets/audit.ts:41
export type SecretsAuditCode =
  | "PLAINTEXT_FOUND"     // 配置里发现裸明文机密
  | "REF_UNRESOLVED"      // SecretRef 引用不到值
  | "REF_SHADOWED"        // ref 被同名环境变量「影子」了
  | "LEGACY_RESIDUE";     // 旧版遗留的机密残留
```

审计报告 `SecretsAuditReport`（`src/secrets/audit.ts:61`）汇总各类计数，状态分 `clean` / `findings` / `unresolved`（`src/secrets/audit.ts:59`）。入口是 `runSecurityAudit`/`audit.ts` 里的 `runSecretsAudit`（`audit.ts` 末尾）。

审计里有一段值得注意的「敏感 header 名识别」——`isLikelySensitiveModelProviderHeaderName`（`src/secrets/audit.ts:128`）:

```ts
// src/secrets/audit.ts:30
const ALWAYS_SENSITIVE_MODEL_PROVIDER_HEADER_NAMES = new Set([
  "authorization", "proxy-authorization", "x-api-key", "api-key", "apikey",
  "x-auth-token", "auth-token", "x-access-token", "access-token", "x-secret-key", "secret-key",
]);
const SENSITIVE_MODEL_PROVIDER_HEADER_NAME_FRAGMENTS = [
  "api-key", "apikey", "token", "secret", "password", "credential",
];
```

模型 provider 配置里可以自定义 HTTP header。如果用户把 API key 塞进一个 `X-Custom-Token` 头明文，审计能识别出「这个 header 名看起来含机密」并报 `PLAINTEXT_FOUND`。识别用「精确白名单 + 片段匹配」双层。

`hasConfiguredPlaintextSecretValue`（`src/secrets/secret-value.ts:15`）判断一个配置值是不是「配了明文机密」:

```ts
// src/secrets/secret-value.ts:15
export function hasConfiguredPlaintextSecretValue(
  value: unknown,
  expected: SecretExpectedResolvedValue,
): boolean {
  if (expected === "string") {
    return isNonEmptyString(value);
  }
  return isNonEmptyString(value) || (isRecord(value) && Object.keys(value).length > 0);
}
```

`audit.ts` 还会追踪每个 provider 的认证状态（`ProviderAuthState`，`src/secrets/audit.ts:87`），区分 `api_key` / `token` / `oauth` 三种模式——这支撑「按 provider 凭证轮换」：审计能告诉你某个 provider 当前用的是哪种凭据、有没有可用的静态/OAuth 凭据。

**为什么审计要这么细?** `AGENTS.md` 反复强调「Never print secrets」「Live-verify when feasible」。secrets 审计是把「机密管理是否健康」这件事变成可检查、可报告的——`openclaw doctor` 跑一遍就知道有没有裸明文、有没有失效的 ref。

### 14.5.5 环境变量注入

`provider-env-vars.ts` 维护「已知的 secret 环境变量名」清单（`listKnownSecretEnvVarNames`）。`runtime-auth-collectors.ts` 等收集器在运行时把解析好的机密注入给各子系统。

回顾第 13 章 13.2.4——TTS provider 解析 API key 时调的 `normalizeResolvedSecretInputString`，就是 secrets 子系统暴露给其他模块的「把这个配置值（可能是 SecretRef）解析成明文」的接口。媒体生成（13.6.2）的 `isCapabilityProviderConfigured` 调 `resolveEnvApiKey` 检查 provider 凭据，也是同一套环境变量注入机制。**整个代码库里所有「需要 API key」的地方，最终都汇到 secrets 子系统**——这保证了机密只有一个权威来源。

---

## 14.6 安全审计与安全边界

### 14.6.1 src/security 的职责

`src/security/`（80+ 文件）实现 `openclaw doctor` 的**安全审计**——它不是运行时鉴权，而是「扫描这台 Gateway 的配置/文件系统/插件，找出安全隐患」的工具。

`audit.ts`（750 行）是总入口。`runSecurityAudit`（`src/security/audit.ts:1038`）汇总各个 collector：

```ts
// src/security/audit.ts （collector 列表，节选）
collectFilesystemFindings        文件系统权限/可疑路径
collectGatewayConfigFindings     Gateway 配置暴露面
collectPluginSecurityAuditFindings 插件安全
collectLoggingFindings           日志里的机密泄露风险
collectElevatedFindings          提权相关
collectExecRuntimeFindings       exec 工具运行时风险
```

`SecurityAuditFinding` 是统一的发现结构，审计报告把所有 finding 汇总分级。

### 14.6.2 危险配置标识

`src/security/` 里有一组文件专门识别「危险配置」——`dangerous-config-flags.ts`、`core-dangerous-config-flags.ts`、`dangerous-tools.ts`。

OpenClaw 配置里有一些 `dangerous*` / `dangerously*` 前缀的开关（第 13 章见过 `dangerouslyAllowHostHeaderOriginFallback`）。`SECURITY.md` 的 "Out of Scope" 明确：

> Any report whose only claim is that an operator-enabled `dangerous*`/`dangerously*` config option weakens defaults (these are explicit break-glass tradeoffs by design)

也就是说——这些开关**故意命名得吓人**，开启它们就是操作者明确选择「破窗」（break-glass），削弱默认安全。审计会把它们标出来提醒，但「操作者主动开了危险开关」本身不算漏洞。`safe-regex.ts` 则检测可能导致 ReDoS 的正则配置——同样属于「防御性硬化」而非边界。

### 14.6.3 外部内容与上下文可见性

`external-content.ts` / `external-content-source.ts` 处理「来自外部的不可信内容」的标记。`context-visibility.ts` 控制哪些上下文对模型可见。

这呼应 `SECURITY.md` 的一条 false-positive 模式：

> Reports that only show quoted/replied/thread/forwarded supplemental context from non-allowlisted senders being visible to the model, without demonstrating an auth, policy, approval, or sandbox boundary bypass.

非授权发送者的引用/转发内容对模型可见，本身不是漏洞——只要没有突破鉴权/策略/审批/沙箱边界。`external-content` 的标记机制让这些内容被正确归类为「外部不可信」，但「可见」与「可执行特权操作」是两回事。

### 14.6.4 AGENTS.md / SECURITY.md 的安全约束要点

最后把散落在 `AGENTS.md` / `SECURITY.md` 里的硬约束归纳一下，它们是理解整章设计意图的「宪法」。

**来自 `AGENTS.md`：**

| 约束 | 出处与含义 |
| --- | --- |
| 永不打印机密 | "Never print secrets." 所有日志/输出路径都要假设可能含机密 |
| 依赖契约要先查上游 | "Dependency-backed behavior: read upstream docs/source/types first. No API/default/error/timing guesses." |
| 协议变更先做加法 | "Gateway protocol changes: additive first; incompatible needs versioning/docs/client follow-through." 解释了 device-auth `v2`→`v3` 为什么是加字段 |
| 协议版本号只由 owner 确认 | "Protocol version bumps: explicit owner confirmation only" |
| 所有权随运行时所有权走 | "Owner boundary: owner-specific repair/detection/onboarding/auth/defaults/provider behavior lives in owner plugin." auth 相关的 owner 专属逻辑应在 owner 插件，core 只留通用接缝 |
| 处理真实生产状态 | "Handle real production states, shipped upgrade paths, security boundaries... Public/hostile/observed malformed input gets care; hypothetical malformed input does not." |

**来自 `SECURITY.md`：**

| 约束 | 含义 |
| --- | --- |
| 单 Gateway 非多租户边界 | "OpenClaw does **not** model one gateway as a multi-tenant, adversarial user boundary." 这是整章设计的根基 |
| 共享密钥 = 全套 operator scope | token/password 鉴权的 HTTP 调用方拿全套 scope，`x-openclaw-scopes` 被忽略 |
| session 标识符是路由而非授权 | "Session identifiers (`sessionKey`, session IDs, labels) are routing controls, not per-user authorization boundaries." |
| 插件是可信计算基础 | "Plugins/extensions are part of OpenClaw's trusted computing base." 装一个插件 = 授予它本机代码级信任 |
| exec 默认 host-first | `agents.defaults.sandbox.mode` 默认 `off`；需要隔离要显式开沙箱 |
| 仅 prompt-injection 不算漏洞 | 没有突破策略/鉴权/沙箱/工具边界的 prompt injection 出范围 |
| 操作者主动破窗不算漏洞 | `dangerous*` 开关是设计上的 break-glass 权衡 |

把这些约束串起来，本章每个看似「权限不够细」的设计——共享密钥拿全套 scope、loopback 豁免限流、`x-openclaw-scopes` 被忽略——都是「单 Gateway 单信任域」这个根本前提下的**正确**取舍，而非疏漏。真正严格设防的是**信任域的边界**：谁能进 Gateway（鉴权）、机密怎么存（secrets 路径/权限校验）、不可信输入怎么处理（pairing 通配符拒绝、SSRF、路径穿越）。

---

## 14.7 端到端：一次请求的安全旅程

把本章拼起来，一次「带凭据的 HTTP 请求」的完整旅程：

```
   1. 请求到达 Gateway
        │
        ▼
   2. resolveGatewayAuth      解析配置 → ResolvedGatewayAuth (mode/token/...)
        │
        ▼
   3. authorizeHttpGatewayConnect
        │
        ├─ 速率限制 check（loopback 豁免）
        ├─ trusted-proxy？ → 校验来源 IP / 必需头 / allowUsers / Origin
        ├─ Tailscale？     → HTTP 面禁用，跳过
        ├─ token/password？ → getBearerToken → safeEqualSecret（时序安全）
        │       失败 → recordFailure，可能锁定
        │       成功 → reset 计数
        │
        ▼  ok: true, method: "token"
   4. scope 判定
        │
        ├─ usesSharedSecretHttpAuth? → trustDeclaredOperatorScopes = false
        │       共享密钥 → 授予全套 operator scope，忽略 x-openclaw-scopes
        ├─ 带身份模式 → 尊重声明的 per-request scope
        │
        ▼
   5. authorizeOperatorScopesForMethod(method, scopes)
        │
        ├─ 持有 ADMIN_SCOPE → 放行一切
        ├─ 方法未分类 → 默认需要 admin（default-deny）
        ├─ WRITE 隐含 READ
        │
        ▼  allowed
   6. 方法执行
        │  执行中如需机密 → SecretRef 解析（assertSecurePath / allowlist）
        │  执行中如读外部内容 → external-content 标记为不可信
        ▼
   7. 响应（永不打印机密）
```

七步里，第 2-3 步是「谁能进」（鉴权），第 4-5 步是「能做什么」（scope），第 6 步触及 secrets 与外部内容边界。设备配对（14.4）是「一个新身份怎么第一次进到第 2 步」的前置流程。

---

## 14.8 本章小结

| 主题 | 关键文件 | 要点 |
| --- | --- | --- |
| 鉴权配置归一化 | `src/gateway/auth-resolve.ts:31` | 四种 mode；`modeSource` 记录推导来源 |
| 连接鉴权 | `src/gateway/auth.ts:400` | 区分 http / ws-control-ui 面；token/password/tailscale/trusted-proxy |
| 时序安全比较 | `src/security/secret-equal.ts:12` | `timingSafeEqual` + padding，防时序侧信道 |
| 速率限制 | `src/gateway/auth-rate-limit.ts` | 内存滑动窗口；loopback 豁免；按 scope 分计数 |
| operator scope | `src/gateway/operator-scopes.ts:1` | 六种 scope；`admin` 是超级 scope |
| scope 检查 | `src/gateway/method-scopes.ts:150` | admin 通吃；write 含 read；未分类方法 default-deny |
| 共享密钥 = 全套 scope | `src/gateway/http-auth-utils.ts:66` | 信任模型决定：token/password 调用方拿全套 scope |
| 聊天频道配对 | `src/pairing/pairing-store.ts:48` | pairing code 用 `crypto.randomInt`；无歧义字母表；TTL + 每账号上限 |
| allowFrom 名单 | `src/pairing/pairing-store.ts:283` | 显式拒绝 `*` 通配符；原子写 + 文件锁 |
| 设备令牌 payload | `src/gateway/device-auth.ts:36` | 版本化 `\|` 拼接；带 scope/nonce/signedAt；device token 尊重声明 scope |
| SecretRef 契约 | `src/secrets/ref-contract.ts:37` | `source:provider:id`；exec id 防路径穿越 |
| SecretRef 解析 | `src/secrets/resolve.ts:203` | `assertSecurePath` 六重校验；env allowlist |
| Secrets 审计 | `src/secrets/audit.ts:41` | 扫裸明文/未解析 ref/影子 ref/遗留残留 |
| 安全审计 | `src/security/audit.ts:1038` | `openclaw doctor` 的多 collector 安全扫描 |
| 信任模型 | `SECURITY.md` "Operator Trust Model" | 单 Gateway 单信任域，是全章设计的根基 |

OpenClaw 的认证与安全体系，本质是「在一个明确的信任模型下，把信任域的边界守严，域内保持便利」。理解了「单 Gateway = 单信任域」这个前提，本章所有设计就都自洽了。
