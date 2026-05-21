# 第 04 章 AI 层:认证、OAuth 与 API Key

> **版本锁定**: 本章内容基于 commit `4868222e`(2026-05-20),
> 所有 `file:line` 引用均指向该快照,后续变更不在本章讨论范围内。

---

## 目录

1. [认证模式总览](#1-认证模式总览)
2. [环境变量自动检测](#2-环境变量自动检测)
3. [OAuth 总体框架](#3-oauth-总体框架)
4. [三家 OAuth 实现详解](#4-三家-oauth-实现详解)
5. [Token 存储与读取](#5-token-存储与读取)
6. [API 调用时的认证流转](#6-api-调用时的认证流转)
7. [pi-ai CLI 的认证子命令](#7-pi-ai-cli-的认证子命令)
8. [失败处理](#8-失败处理)

---

## 1 认证模式总览

### 1.1 Provider × 认证模式矩阵

```
Provider               API Key (env)    OAuth           AWS SigV4       Bearer Token    ADC
---------------------------------------------------------------------------------------------
anthropic              ANTHROPIC_API_KEY  ANTHROPIC_OAUTH_TOKEN (*)  --            --          --
github-copilot         COPILOT_GITHUB_TOKEN  GitHub device flow  --            --          --
openai                 OPENAI_API_KEY    --              --            --          --
openai-codex           OPENAI_API_KEY    ChatGPT OAuth   --            --          --
azure-openai-responses AZURE_OPENAI_API_KEY  --          --            --          --
google / gemini        GEMINI_API_KEY    --              --            --          --
google-vertex          GOOGLE_CLOUD_API_KEY  --          --            --          GOOGLE_ADC (*)
amazon-bedrock         --               --              SigV4 (*)     AWS_BEARER_TOKEN_BEDROCK  --
mistral                MISTRAL_API_KEY   --              --            --          --
deepseek               DEEPSEEK_API_KEY  --              --            --          --
groq                   GROQ_API_KEY      --              --            --          --
cerebras               CEREBRAS_API_KEY  --              --            --          --
xai                    XAI_API_KEY       --              --            --          --
openrouter             OPENROUTER_API_KEY  --            --            --          --
cloudflare-workers-ai  CLOUDFLARE_API_KEY  --            --            --          --
fireworks              FIREWORKS_API_KEY  --              --            --          --
huggingface            HF_TOKEN          --              --            --          --
```

`(*)` 标记表示该方式由 pi 的认证层专门处理(非简单 env → header 透传):

- Anthropic OAuth:生成 `sk-ant-oat...` 格式的 access token,注入 beta headers 并伪装 Claude Code 身份。
- Google Vertex ADC:检测 `~/.config/gcloud/application_default_credentials.json` + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` 三者同时存在时返回 `"<authenticated>"` 标记。
- AWS SigV4:完全委托给 AWS SDK credential chain,pi 只检测是否有任何 AWS 凭据存在。

### 1.2 认证优先级

在 `getEnvApiKey` 的实现中(`env-api-keys.ts:97-99`),Anthropic provider 的优先级如下:

```
ANTHROPIC_OAUTH_TOKEN  >  ANTHROPIC_API_KEY
```

OAuth token 优先,以确保已登录用户不会意外降级到 API key 模式。

---

## 2 环境变量自动检测

文件:`packages/ai/src/env-api-keys.ts`

### 2.1 模块初始化策略

该模块的顶部有一个特殊的动态 import 模式:

```typescript
// env-api-keys.ts:1-24
// NEVER convert to top-level imports - breaks browser/Vite builds
let _existsSync: typeof import("node:fs").existsSync | null = null;
let _homedir: typeof import("node:os").homedir | null = null;
let _join: typeof import("node:path").join | null = null;

if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
    dynamicImport(NODE_FS_SPECIFIER).then((m) => { _existsSync = m.existsSync; });
    // ...
}
```

Node.js 原生模块通过动态 import 异步加载,使得这个文件可以在浏览器 / Vite 构建环境中安全 import 而不报错。Bun 有一个已知 bug(`bun/issues/27802`):编译二进制在 Linux sandbox 中 `process.env` 为空,通过读取 `/proc/self/environ` 作为 fallback(`env-api-keys.ts:35-59`)。

### 2.2 Provider 到环境变量的映射

```typescript
// env-api-keys.ts:91-134 (核心映射表)
function getApiKeyEnvVars(provider: string): readonly string[] | undefined {
    if (provider === "github-copilot") {
        return ["COPILOT_GITHUB_TOKEN"];
    }
    if (provider === "anthropic") {
        return ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];  // 顺序有意义
    }
    const envMap: Record<string, string> = {
        openai: "OPENAI_API_KEY",
        "azure-openai-responses": "AZURE_OPENAI_API_KEY",
        google: "GEMINI_API_KEY",
        "google-vertex": "GOOGLE_CLOUD_API_KEY",
        mistral: "MISTRAL_API_KEY",
        // ...
    };
    return envMap[provider] ? [envMap[provider]] : undefined;
}
```

`findEnvKeys` 返回实际已设置的变量名列表(可用于 UI 展示);`getEnvApiKey` 返回第一个已设置变量的值。

### 2.3 特殊认证来源

**Google Vertex ADC**(`env-api-keys.ts:62-89`):三个条件必须同时满足才返回 `"<authenticated>"`:

1. `~/.config/gcloud/application_default_credentials.json` 存在(或 `GOOGLE_APPLICATION_CREDENTIALS` 指向的文件存在)。
2. `GOOGLE_CLOUD_PROJECT` 或 `GCLOUD_PROJECT` 已设置。
3. `GOOGLE_CLOUD_LOCATION` 已设置。

返回 `"<authenticated>"` 而非实际凭据,是因为 Vertex SDK 会自己读取 ADC 文件;pi 只需确认凭据存在,不需要传递具体值。

**Amazon Bedrock**(`env-api-keys.ts:183-208`):检测以下任意条件:

```
AWS_PROFILE
AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
AWS_BEARER_TOKEN_BEDROCK
AWS_CONTAINER_CREDENTIALS_RELATIVE_URI  (ECS task role)
AWS_CONTAINER_CREDENTIALS_FULL_URI      (ECS task role)
AWS_WEB_IDENTITY_TOKEN_FILE             (IRSA)
```

同样返回 `"<authenticated>"` 标记,实际 SigV4 签名由 `@aws-sdk/client-bedrock-runtime` 的 credential provider chain 处理。

---

## 3 OAuth 总体框架

### 3.1 文件结构

```
packages/ai/src/
  oauth.ts                        -- 公共 re-export 入口
  utils/oauth/
    types.ts                      -- OAuthCredentials, OAuthProviderInterface 等接口定义
    index.ts                      -- Provider 注册表 + 高层 API
    anthropic.ts                  -- Anthropic OAuth 实现 (Authorization Code + PKCE)
    github-copilot.ts             -- GitHub Copilot OAuth 实现 (Device Flow)
    openai-codex.ts               -- OpenAI Codex OAuth 实现 (Authorization Code + PKCE)
    pkce.ts                       -- PKCE 工具函数 (Web Crypto API)
    oauth-page.ts                 -- 本地回调服务器返回的成功/错误 HTML
```

`oauth.ts` 是一行 re-export(`oauth.ts:1`),确保外部只需 `import from "@earendil-works/pi-ai/oauth"` 即可获得所有公共 API。

### 3.2 OAuthProviderInterface

```typescript
// utils/oauth/types.ts:46-64
export interface OAuthProviderInterface {
    readonly id: OAuthProviderId;
    readonly name: string;

    login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
    usesCallbackServer?: boolean;

    refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
    getApiKey(credentials: OAuthCredentials): string;

    /** 可选:登录后修改 model 配置,例如更新 baseUrl */
    modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}
```

`OAuthCredentials` 是最小结构:

```typescript
// utils/oauth/types.ts:3-8
export type OAuthCredentials = {
    refresh: string;
    access: string;
    expires: number;  // Unix ms,含 5 分钟提前量
    [key: string]: unknown;
};
```

`expires` 存储的是 `Date.now() + expires_in * 1000 - 5 * 60 * 1000`,即有效期减去 5 分钟的安全边距,确保在 token 真正过期前完成刷新。

### 3.3 Provider 注册表

```typescript
// utils/oauth/index.ts:34-42
const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
    anthropicOAuthProvider,
    githubCopilotOAuthProvider,
    openaiCodexOAuthProvider,
];

const oauthProviderRegistry = new Map<string, OAuthProviderInterface>(
    BUILT_IN_OAUTH_PROVIDERS.map((provider) => [provider.id, provider]),
);
```

注册表支持 `registerOAuthProvider` / `unregisterOAuthProvider` / `resetOAuthProviders`,允许测试场景注入 mock provider,或第三方扩展注册自定义 OAuth provider。

### 3.4 getOAuthApiKey:自动刷新

```typescript
// utils/oauth/index.ts:127-152
export async function getOAuthApiKey(
    providerId: OAuthProviderId,
    credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
    let creds = credentials[providerId];
    if (!creds) return null;

    if (Date.now() >= creds.expires) {
        creds = await provider.refreshToken(creds);
    }

    return { newCredentials: creds, apiKey: provider.getApiKey(creds) };
}
```

这是 agent 层调用的标准路径:传入持久化的 credentials map,拿到当前有效的 `apiKey` 字符串,同时返回可能已刷新的 `newCredentials` 供持久化。

---

## 4 三家 OAuth 实现详解

### 4.1 Anthropic OAuth

**协议**: Authorization Code + PKCE(RFC 7636)
**端点**:
- 授权:`https://claude.ai/oauth/authorize`
- Token:`https://platform.claude.com/v1/oauth/token`
- 本地回调:`http://localhost:53692/callback`

**Scope**: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`

**登录流程**:

```
loginAnthropic()
    |
    1. generatePKCE()  --> verifier + challenge (Web Crypto SHA-256)
    |
    2. startCallbackServer(verifier)  --> Node.js http.createServer on :53692
    |
    3. 构建 authorize URL 并通过 onAuth 回调展示给用户
    |
    4. 并行等待:
       - server.waitForCode()  (浏览器在本机跳转)
       - onManualCodeInput()   (远程机器粘贴 URL)
    |
    5. exchangeAuthorizationCode(code, state, verifier, redirectUri)
       POST platform.claude.com/v1/oauth/token
    |
    6. 返回 OAuthCredentials { refresh, access, expires }
```

**刷新**(`anthropic.ts:348-379`):
```
POST platform.claude.com/v1/oauth/token
{ grant_type: "refresh_token", client_id, refresh_token }
```

**getApiKey**: 直接返回 `credentials.access`(即 `sk-ant-oat...` 格式的 access token)。

**modifyModels**: 未定义,Anthropic 模型的 baseUrl 是固定的。

### 4.2 GitHub Copilot OAuth

**协议**: Device Authorization Grant(RFC 8628)
**端点**(默认 github.com,支持 Enterprise):
- device_code:`https://github.com/login/device/code`
- access_token:`https://github.com/login/oauth/access_token`
- copilot_token:`https://api.github.com/copilot_internal/v2/token`

**登录流程**:

```
loginGitHubCopilot()
    |
    1. 询问用户是否使用 GitHub Enterprise URL/domain
    |
    2. startDeviceFlow(domain)
       POST /login/device/code { client_id, scope: "read:user" }
       --> device_code, user_code, verification_uri, interval, expires_in
    |
    3. 展示 verification_uri 和 user_code,用户在浏览器中授权
    |
    4. pollForGitHubAccessToken(domain, device_code, interval, expires_in, signal)
       循环 POST /login/oauth/access_token
       - authorization_pending: 继续等待
       - slow_down: 增加轮询间隔 (× 1.4 倍)
       - 其他 error: 抛出异常
    |
    5. refreshGitHubCopilotToken(githubAccessToken, enterpriseDomain)
       GET /copilot_internal/v2/token  --> 短期 Copilot API token
    |
    6. enableAllGitHubCopilotModels()  --> 激活账号中尚未启用的模型
    |
    7. 返回 OAuthCredentials { refresh: githubToken, access: copilotToken, expires }
```

注意两级 token 的语义:
- `refresh` 存储的是 GitHub OAuth access token(长期有效,用于调用 copilot_internal API)。
- `access` 存储的是 Copilot API token(短期,约 30 分钟,用于实际 LLM 调用)。

**刷新**:用 `credentials.refresh`(GitHub token)调用 `/copilot_internal/v2/token` 换取新的 Copilot token。

**modifyModels**(`github-copilot.ts:390-396`):从 Copilot token 的 `proxy-ep=...` 字段提取 API 基地址,将 `github-copilot` provider 的所有模型 baseUrl 更新为 `https://api.individual.githubcopilot.com`(或 Enterprise 对应地址)。这是因为 Copilot 用 token payload 而非配置文件决定路由目标。

### 4.3 OpenAI Codex OAuth

**协议**: Authorization Code + PKCE
**端点**:
- 授权:`https://auth.openai.com/oauth/authorize`
- Token:`https://auth.openai.com/oauth/token`
- 本地回调:`http://localhost:1455/auth/callback`

**Scope**: `openid profile email offline_access`

**登录流程**与 Anthropic 类似:PKCE + 本地 HTTP server 接收 callback。区别:

1. 授权 URL 携带 `codex_cli_simplified_flow=true` 和 `originator=pi` 参数。
2. `id_token_add_organizations=true` 使 JWT 中含有组织信息。
3. Token JWT 的 `https://api.openai.com/auth` claim 中含 `chatgpt_account_id`,用于用户标识。

**刷新**:标准 `grant_type: refresh_token` 流程,向 `auth.openai.com/oauth/token` 发送。

**getApiKey**: 返回 `credentials.access`,即 OpenAI JWT access token(与 API key 格式不同,Codex 后端直接接受)。

### 4.4 三家对比

| 维度 | Anthropic | GitHub Copilot | OpenAI Codex |
|------|-----------|----------------|--------------|
| 协议 | Authorization Code + PKCE | Device Flow | Authorization Code + PKCE |
| 本地 server | 端口 53692 | 无 | 端口 1455 |
| refresh token 语义 | 标准 refresh | GitHub OAuth token | 标准 refresh |
| access token 格式 | `sk-ant-oat...` | Copilot JWT | OpenAI JWT |
| 刷新端点 | `platform.claude.com` | `api.github.com/copilot_internal` | `auth.openai.com` |
| 登录后操作 | 无 | 批量 enableModel | 无 |
| modifyModels | 无 | 更新 baseUrl | 无 |
| 适合场景 | Claude Pro/Max 订阅 | GitHub Copilot 订阅 | ChatGPT Plus/Pro 订阅 |

**共同设计**:三家都通过 `utils/oauth/pkce.ts` 使用 Web Crypto API 生成 PKCE challenge,实现跨平台兼容(Node.js 20+ 和浏览器)。

---

## 5 Token 存储与读取

### 5.1 pi-ai CLI 的存储格式

`cli.ts` 将 token 写入当前工作目录的 `auth.json`(`cli.ts:24-26`):

```typescript
function saveAuth(auth: Record<string, { type: "oauth" } & OAuthCredentials>): void {
    writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), "utf-8");
}
```

文件格式:

```json
{
  "anthropic": {
    "type": "oauth",
    "refresh": "...",
    "access": "sk-ant-oat...",
    "expires": 1748000000000
  },
  "github-copilot": {
    "type": "oauth",
    "refresh": "ghu_...",
    "access": "...",
    "expires": 1748001800000,
    "enterpriseUrl": null
  }
}
```

**注意**:`cli.ts` 是一个独立的 CLI 工具脚本,写入的是执行目录的 `auth.json`。在 coding-agent 场景中,认证文件的实际路径和读取逻辑由 agent 层负责管理(通常是 `~/.pi/agent/auth.json` 或类似位置),pi-ai 包只提供 `getOAuthApiKey` 函数供 agent 层调用。

### 5.2 token 注入链路

agent 层持有 credentials map,每次调用 `stream()` 前通过以下路径获得 apiKey:

```
agent 层持有 auth state
    |
    getOAuthApiKey(providerId, credentials)
    -- 若 Date.now() >= expires: refreshToken() 并更新 auth state
    -- 返回 { newCredentials, apiKey }
    |
    stream(model, context, { apiKey: apiKey, ... })
    |
    provider impl 的 options?.apiKey 参数
    -- 优先于 getEnvApiKey(model.provider)
```

`getEnvApiKey` 只作为环境变量的 fallback。当 `options.apiKey` 有值时,所有 provider 都优先使用它。

---

## 6 API 调用时的认证流转

### 6.1 Anthropic:API Key 模式

```
stream(model, context, { apiKey: "sk-ant-api..." })
    |
    anthropic.ts: createClient()
        apiKey 检测不含 "sk-ant-oat" --> 走普通 API key 分支
        new Anthropic({
            apiKey: "sk-ant-api...",
            authToken: null,
            baseURL: model.baseUrl,
            defaultHeaders: {
                "anthropic-beta": betaFeatures.join(","),
                // 可选: "x-session-affinity": sessionId
            }
        })
    |
    最终 HTTP header:
        Authorization: <Anthropic SDK 自动生成 x-api-key 格式>
        anthropic-beta: fine-grained-tool-streaming-2025-05-14,...
```

### 6.2 Anthropic:OAuth 模式

```
stream(model, context, { apiKey: "sk-ant-oat..." })
    |
    anthropic.ts: isOAuthToken("sk-ant-oat...") == true
        new Anthropic({
            apiKey: null,
            authToken: "sk-ant-oat...",
            defaultHeaders: {
                "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,...",
                "user-agent": "claude-cli/2.1.75",
                "x-app": "cli",
            }
        })
    |
    最终 HTTP header:
        Authorization: Bearer sk-ant-oat...
        anthropic-beta: claude-code-20250219,oauth-2025-04-20,...
        user-agent: claude-cli/2.1.75
        x-app: cli
```

`authToken` 对应 `Authorization: Bearer ...` 头;`apiKey` 对应 Anthropic 专属的 `x-api-key` 头。通过在同一个 SDK 客户端上切换这两个字段实现认证模式的切换。

### 6.3 GitHub Copilot:via Anthropic 协议

```
stream(copilotModel, context, { apiKey: copilotAccessToken })
    |
    model.provider == "github-copilot"
        --> buildCopilotDynamicHeaders() 检测消息链
        --> copilotDynamicHeaders = {
               "X-Initiator": "user" | "agent",
               "Openai-Intent": "conversation-edits",
               ["Copilot-Vision-Request": "true"]
           }
        createClient():
            new Anthropic({
                apiKey: null,
                authToken: copilotAccessToken,
                baseURL: "https://api.individual.githubcopilot.com",
                defaultHeaders: {
                    ...COPILOT_DYNAMIC_HEADERS,
                    "anthropic-beta": betaFeatures,
                }
            })
    |
    最终 HTTP header:
        Authorization: Bearer <copilot-token>
        X-Initiator: agent
        Openai-Intent: conversation-edits
        anthropic-beta: fine-grained-tool-streaming-2025-05-14
```

### 6.4 Amazon Bedrock:SigV4

```
stream(bedrockModel, context, options)
    |
    amazon-bedrock.ts
        若 options.bearerToken 或 AWS_BEARER_TOKEN_BEDROCK 存在:
            customFetch 注入 Authorization: Bearer <token>
            绕过 SigV4 签名
        否则:
            BedrockRuntimeClient({
                region: options.region || AWS_DEFAULT_REGION,
                credentials: <AWS SDK credential chain>,
                requestHandler: NodeHttpHandler (代理支持)
            })
    |
    最终 HTTP header:
        Authorization: AWS4-HMAC-SHA256 ... (SigV4)
        x-amz-date: ...
        x-amz-security-token: ... (临时凭据)
    或:
        Authorization: Bearer <bearer-token>
```

---

## 7 pi-ai CLI 的认证子命令

文件:`packages/ai/src/cli.ts`

`cli.ts` 是 `@earendil-works/pi-ai` 包的 `bin` 入口,提供以下子命令:

### 7.1 可用命令

```
npx @earendil-works/pi-ai <command> [provider]

Commands:
  login [provider]   登录 OAuth provider,凭据写入 auth.json
  list               列出所有可用 OAuth provider
  help / --help / -h 显示帮助
```

**login 流程**(`cli.ts:28-58`):

```typescript
async function login(providerId: OAuthProviderId): Promise<void> {
    const credentials = await provider.login({
        onAuth: (info) => { console.log(info.url); /* 显示授权 URL */ },
        onPrompt: async (p) => await promptFn(`${p.message}...`),
        onProgress: (msg) => console.log(msg),
    });
    const auth = loadAuth();
    auth[providerId] = { type: "oauth", ...credentials };
    saveAuth(auth);
    console.log(`Credentials saved to ${AUTH_FILE}`);
}
```

若不指定 provider,进入交互式选择菜单(数字选择);指定 provider ID 则直接进入对应 login 流程。

### 7.2 provider 列表

`getOAuthProviders()` 返回内置的三个 provider:

```
anthropic             Anthropic (Claude Pro/Max)
github-copilot        GitHub Copilot
openai-codex          OpenAI Codex (ChatGPT)
```

### 7.3 auth.json 路径

CLI 固定将 `auth.json` 写入**当前工作目录**(`cli.ts:4` `const AUTH_FILE = "auth.json"`)。在 agent 集成场景中,agent 层通常将 auth 数据存储在用户主目录的配置文件夹(如 `~/.pi/agent/auth.json`),并通过自己的存储逻辑管理,不依赖 CLI 的路径约定。

---

## 8 失败处理

### 8.1 token 过期与刷新失败

`getOAuthApiKey`(`utils/oauth/index.ts:127-152`)的刷新逻辑:

```typescript
if (Date.now() >= creds.expires) {
    try {
        creds = await provider.refreshToken(creds);
    } catch (_error) {
        throw new Error(`Failed to refresh OAuth token for ${providerId}`);
    }
}
```

刷新失败时抛出异常,**不** catch 到 `AssistantMessage` 中,因为刷新失败代表认证配置问题而非模型调用问题,需要上层 agent 决定如何向用户呈现(通常是触发重新登录)。

### 8.2 API key 缺失

在 provider 的 `stream()` 函数中:

```typescript
// openai-completions.ts:459-462
if (!apiKey) {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error(
            "OpenAI API key is required. Set OPENAI_API_KEY or pass it as an argument."
        );
    }
}
```

注意这个 throw 发生在 async IIFE 内部但在 `stream.push` 之前,因此错误会被 try/catch 捕获并编码进流:

```typescript
// anthropic.ts:673-683
} catch (error) {
    output.stopReason = options?.signal?.aborted ? "aborted" : "error";
    output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
    stream.push({ type: "error", reason: output.stopReason, error: output });
    stream.end();
}
```

最终消费方通过检查 `stream.result()` resolve 的 `AssistantMessage.stopReason === "error"` 和 `errorMessage` 字段得知失败原因。

### 8.3 401 未授权

HTTP 401 从 SDK 层抛出为 `Error`(如 `Anthropic.AuthenticationError`、`OpenAI.AuthenticationError`),被 provider 的 catch 块捕获并写入 `errorMessage`。pi 不在 AI 层自动重试 401:

- API key 错误是配置问题,重试无意义。
- OAuth token 过期在 `getOAuthApiKey` 阶段已处理,到达 `stream()` 时 token 应该是有效的。

### 8.4 与 coding-agent 的 UX 衔接

`errorMessage` 字段从 `AssistantMessage` 向上传递到 agent 层。coding-agent 检测到 `stopReason === "error"` 时会:

1. 检查 `errorMessage` 是否含 auth 相关关键词(如 "401"、"authentication"、"token")。
2. 若是 OAuth token 失效,触发重新登录流程(调用 `loginXxx()`)。
3. 若是 API key 缺失,向用户展示配置指南。
4. 其他错误(网络、超时等)进入重试逻辑或向用户展示错误信息。

`AssistantMessageDiagnostic`(`utils/diagnostics.ts`)用于记录可恢复的诊断信息,不影响主流程的 `errorMessage` 字段。

### 8.5 Bun 环境的 env 访问 fallback

`getProcEnv`(`env-api-keys.ts:35-59`)通过读取 `/proc/self/environ` 绕过 Bun 编译二进制的 `process.env` 为空 bug。这在 sandbox 化的企业部署(如 Xiaomi 的多区域 token plan)中尤为重要:这类环境可能通过 container 注入 env 但 Bun 无法读取。读取结果缓存在 `_procEnvCache` 中避免重复 I/O。
