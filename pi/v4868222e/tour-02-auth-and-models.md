# Tour 步骤 02:加载认证与模型注册表

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:`appMode` 已确定为 `"interactive"`,进程持有 `parsed: Args` 和 `cwd`。`AuthStorage.create()` 已在 `main.ts:527` 被同步调用——但 `createRuntime` 工厂闭包尚未执行,auth/models/extensions 都还没真正加载。

**下一步起点**:`createAgentSessionServices()` 内部完成,`AuthStorage` 实例已从 `~/.pi/agent/auth.json` 读取凭证到内存,`ModelRegistry` 已将 `models.generated.ts` 里的静态注册表和 `models.json` 里的自定义模型合并进内存。`services` 对象作为 runtime 的第一批产出返回给 `createAgentSessionRuntime()`。

---

## 1. 当前情境

`main.ts:527` 执行了 `AuthStorage.create()`——这只是同步地创建了一个空对象并读取了 `~/.pi/agent/auth.json` 文件内容到内存,但并没有验证任何 token。真正的"服务装配"发生在 `main.ts:528-612` 定义的 `createRuntime` 工厂闭包里:

```
main.ts:614  await createAgentSessionRuntime(createRuntime, {...})
              |
              | 工厂闭包第一次被调用
              v
main.ts:534  await createAgentSessionServices({cwd, agentDir, authStorage, ...})
```

此刻进程的状态:
- `process.env.ANTHROPIC_API_KEY` 已设置。
- `~/.pi/agent/auth.json` 存在(即使为空对象 `{}` 也可以)。
- `~/.pi/agent/models.json` 不存在(默认情况下)。
- 还没有任何扩展被加载,没有 system prompt 被构造。

---

## 2. 问题

这一步需要解决三个具体问题:

1. **credential 从哪里来,优先级如何**:用户可能同时拥有 `ANTHROPIC_API_KEY` 环境变量、`auth.json` 里的 `api_key` 条目,以及 `auth.json` 里的 OAuth token。哪个优先?OAuth token 过期后谁负责刷新?

2. **模型表有 16000 多行静态数据,如何高效加载进内存**:`models.generated.ts` 是纯 TypeScript 字面量,在 ESM 层面是模块常量,Node.js 首次 `import` 时已经解析;但 `ModelRegistry` 需要把它转成可查询的 `Map<provider, Map<id, Model>>`。

3. **如何处理用户在 `models.json` 里声明的自定义模型**:内置模型来自静态注册表,自定义模型来自磁盘文件。两者可能有同一 `(provider, id)` 对——冲突时谁赢?

---

## 3. 朴素思路

在启动时做一次全量验证:对 `auth.json` 里的每个 provider 逐一发 HTTP 请求验证 token 是否有效,再把 `MODELS` 常量原样暴露为全局变量。

---

## 4. 为什么朴素思路会崩

**全量验证拖慢启动**:在 interactive mode 下,用户期望 TUI 在 500ms 内出现。对每个已保存 provider 逐一做 HTTP 验证会增加数秒延迟。pi 的做法是**惰性验证**:启动时只读文件、解析 JSON,不发任何 HTTP 请求;OAuth token 过期状态只在第一次实际调用 `getApiKey()` 时才触发刷新。

**全局变量无法支持多实例并发写**:当两个 `pi` 进程同时尝试刷新同一个 OAuth token 时,如果都直接写 `auth.json`,最后写入的那个会覆盖另一个刚拿到的新 token。`AuthStorage` 用 `proper-lockfile` 在文件级别加锁解决这个问题(`auth-storage.ts:406-450`)。

**`MODELS` 常量结构嵌套太深**:原始结构是 `MODELS[provider][modelId] = Model`,直接查询需要两层嵌套属性访问且无法做模糊搜索。`models.ts:4-13` 在模块初始化时把 `MODELS` 展平成 `Map<string, Map<string, Model<Api>>>`,查询复杂度降到 O(1)。

---

## 5. pi 的做法

<svg viewBox="0 0 880 560" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="createAgentSessionServices 加载流程:Auth / ModelRegistry / ResourceLoader">
  <defs>
    <marker id="arT2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
    <marker id="arT2b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="880" height="560" fill="#f8fafc" rx="6"/>
  <text x="440" y="28" text-anchor="middle" font-size="14" font-weight="600" fill="#1e293b">createAgentSessionServices() 加载流程</text>
  <rect x="260" y="44" width="360" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="440" y="59" text-anchor="middle" font-size="11" font-weight="600" fill="#9a3412">createAgentSessionServices()</text>
  <text x="440" y="74" text-anchor="middle" font-size="10" fill="#c2410c">agent-session-services.ts:129</text>
  <line x1="440" y1="80" x2="440" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT2)"/>
  <line x1="440" y1="100" x2="160" y2="100" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="440" y1="100" x2="440" y2="100" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="440" y1="100" x2="720" y2="100" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="160" y1="100" x2="160" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT2)"/>
  <line x1="440" y1="100" x2="440" y2="220" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT2)"/>
  <line x1="720" y1="100" x2="720" y2="460" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT2)"/>
  <rect x="60" y="120" width="200" height="110" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="160" y="138" text-anchor="middle" font-size="11" font-weight="600" fill="#4c1d95">AuthStorage.create()</text>
  <text x="160" y="152" text-anchor="middle" font-size="9" fill="#6d28d9">auth-storage.ts:208</text>
  <line x1="90" y1="162" x2="105" y2="162" stroke="#94a3b8" stroke-width="1"/>
  <text x="108" y="166" font-size="9" fill="#64748b">FileAuthStorageBackend</text>
  <line x1="90" y1="182" x2="105" y2="182" stroke="#94a3b8" stroke-width="1"/>
  <text x="108" y="186" font-size="9" fill="#64748b">this.reload()</text>
  <text x="108" y="200" font-size="9" fill="#94a3b8">withLock → readFileSync</text>
  <text x="108" y="212" font-size="9" fill="#94a3b8">→ JSON.parse → this.data</text>
  <rect x="310" y="220" width="260" height="220" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="440" y="238" text-anchor="middle" font-size="11" font-weight="600" fill="#4c1d95">ModelRegistry.create()</text>
  <text x="440" y="252" text-anchor="middle" font-size="9" fill="#6d28d9">model-registry.ts:346</text>
  <text x="440" y="268" text-anchor="middle" font-size="10" fill="#4c1d95">this.loadModels()  :380</text>
  <line x1="330" y1="280" x2="345" y2="280" stroke="#94a3b8" stroke-width="1"/>
  <text x="348" y="284" font-size="9" fill="#64748b">loadCustomModels(models.json)  :455</text>
  <text x="348" y="298" font-size="9" fill="#94a3b8">→ emptyCustomModelsResult()</text>
  <text x="348" y="310" font-size="9" fill="#94a3b8">(文件不存在时)</text>
  <line x1="330" y1="322" x2="345" y2="322" stroke="#94a3b8" stroke-width="1"/>
  <text x="348" y="326" font-size="9" fill="#64748b">loadBuiltInModels(overrides)</text>
  <text x="348" y="340" font-size="9" fill="#94a3b8">getProviders() → Map → flatMap</text>
  <line x1="330" y1="354" x2="345" y2="354" stroke="#94a3b8" stroke-width="1"/>
  <text x="348" y="358" font-size="9" fill="#64748b">mergeCustomModels(builtIn, custom)</text>
  <text x="348" y="372" font-size="9" fill="#94a3b8">custom 同 (provider+id) 覆盖 builtIn</text>
  <text x="348" y="386" font-size="9" fill="#94a3b8">→ Map&lt;string, Model[]&gt;</text>
  <text x="440" y="428" text-anchor="middle" font-size="9" fill="#94a3b8">model-registry.ts:380</text>
  <rect x="600" y="460" width="240" height="56" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="720" y="478" text-anchor="middle" font-size="11" font-weight="600" fill="#4c1d95">DefaultResourceLoader</text>
  <text x="720" y="494" text-anchor="middle" font-size="9" fill="#6d28d9">await resourceLoader.reload()</text>
  <text x="720" y="508" text-anchor="middle" font-size="9" fill="#94a3b8">扫描扩展目录、加载扩展</text>
  <line x1="440" y1="520" x2="440" y2="540" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT2)"/>
  <rect x="290" y="520" width="300" height="32" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="440" y="540" text-anchor="middle" font-size="12" font-weight="600" fill="#134e4a">return services: AgentSessionServices</text>
</svg>
<span class="figure-caption">图 T2.1 ｜ createAgentSessionServices() 内 Auth / ModelRegistry / ResourceLoader 三支并行加载</span>

<details>
<summary>ASCII 原版</summary>

```
createAgentSessionServices()          [agent-session-services.ts:129]
    |
    +-- AuthStorage.create(auth.json)  [auth-storage.ts:208]
    |       |
    |       +-- FileAuthStorageBackend(auth.json)
    |       +-- this.reload()          [auth-storage.ts:260]
    |             withLock → readFileSync → JSON.parse → this.data
    |
    +-- ModelRegistry.create(authStorage, models.json)  [model-registry.ts:346]
    |       |
    |       +-- this.loadModels()      [model-registry.ts:380]
    |             |
    |             +-- loadCustomModels(models.json)   [model-registry.ts:455]
    |             |     -> emptyCustomModelsResult()  (文件不存在时)
    |             |
    |             +-- loadBuiltInModels(overrides, modelOverrides)
    |             |     getProviders() -> modelRegistry(Map) -> flatMap -> []
    |             |
    |             +-- mergeCustomModels(builtIn, custom)
    |                   custom 同 (provider+id) 的覆盖 builtIn
    |
    +-- DefaultResourceLoader({cwd, agentDir, settingsManager})
    +-- await resourceLoader.reload()  [resource-loader.ts]
    |     -> 扫描扩展目录、加载扩展(下一步讲)
    |
    +-- return services: AgentSessionServices
```

</details>

**凭证优先级链**(`auth-storage.ts:461-522`):

```
getApiKey(providerId) 的优先级(从高到低):
  1. runtimeOverrides (--api-key CLI flag)
  2. auth.json 里的 api_key 条目     -> resolveConfigValue(key)
  3. auth.json 里的 oauth 条目       -> 检查 expires, 过期则 refreshOAuthTokenWithLock()
  4. 环境变量                         -> getEnvApiKey(providerId)
  5. fallbackResolver                -> models.json 里 providers.X.apiKey
```

`getEnvApiKey()` 在 `env-api-keys.ts:158-210` 实现。对于 `anthropic` provider,它按序检查 `ANTHROPIC_OAUTH_TOKEN`(优先)和 `ANTHROPIC_API_KEY`。对于 `google-vertex`,它还会检测 ADC 文件是否存在(`env-api-keys.ts:63-89`)——有些 provider 不需要显式 API key,用 ambient credential 即可。

**OAuth token 刷新的并发安全**(`auth-storage.ts:406-450`):

`refreshOAuthTokenWithLock()` 用 `storage.withLockAsync()` 包裹整个"读文件 → 检查过期 → 刷新 → 写文件"流程。若其他进程已在锁内刷新完毕,当前进程拿到锁后读到的 `cred.expires` 已经更新,直接返回新 token,不再重复刷新。

**静态模型注册表的初始化**(`models.ts:4-13`):

```typescript
// 模块级初始化——Node.js import 时执行一次
const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();
for (const [provider, models] of Object.entries(MODELS)) {
    const providerModels = new Map<string, Model<Api>>();
    for (const [id, model] of Object.entries(models)) {
        providerModels.set(id, model as Model<Api>);
    }
    modelRegistry.set(provider, providerModels);
}
```

`MODELS` 常量本身在 `models.generated.ts:6` 定义,是一个以 provider 为顶层 key 的嵌套对象字面量,包含约 600 个模型条目。

**自定义模型的合并策略**(`model-registry.ts:441-453`):

```typescript
private mergeCustomModels(builtInModels, customModels): Model<Api>[] {
    const merged = [...builtInModels];
    for (const customModel of customModels) {
        const existingIndex = merged.findIndex(
            (m) => m.provider === customModel.provider && m.id === customModel.id
        );
        if (existingIndex >= 0) {
            merged[existingIndex] = customModel;  // 自定义模型胜出
        } else {
            merged.push(customModel);
        }
    }
    return merged;
}
```

同 `(provider, id)` 对时,`models.json` 里的自定义定义完全替换内置条目,而不是 patch 合并。若只想修改部分字段(如 `contextWindow`),应使用 `modelOverrides` 而不是 `models`。

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/coding-agent/src/main.ts` | 527 | `AuthStorage.create()` 同步创建 |
| `packages/coding-agent/src/main.ts` | 528-612 | `createRuntime` 工厂闭包定义 |
| `packages/coding-agent/src/main.ts` | 534 | `createAgentSessionServices({...})` 调用 |
| `packages/coding-agent/src/core/agent-session-services.ts` | 129-170 | `createAgentSessionServices()` 全文 |
| `packages/coding-agent/src/core/auth-storage.ts` | 52-170 | `FileAuthStorageBackend` — 文件锁实现 |
| `packages/coding-agent/src/core/auth-storage.ts` | 195-209 | `AuthStorage.create()` 工厂方法 |
| `packages/coding-agent/src/core/auth-storage.ts` | 260-273 | `reload()` — 带锁读文件 |
| `packages/coding-agent/src/core/auth-storage.ts` | 406-450 | `refreshOAuthTokenWithLock()` |
| `packages/coding-agent/src/core/auth-storage.ts` | 461-522 | `getApiKey()` — 五级优先级链 |
| `packages/ai/src/env-api-keys.ts` | 91-134 | `getApiKeyEnvVars()` — 环境变量名映射表 |
| `packages/ai/src/env-api-keys.ts` | 158-210 | `getEnvApiKey()` — 读环境变量 |
| `packages/ai/src/models.generated.ts` | 1-6 | 文件头与 `MODELS` 常量起点 |
| `packages/ai/src/models.ts` | 4-13 | 模块级初始化:MODELS → `Map<Map>` |
| `packages/ai/src/models.ts` | 20-26 | `getModel()` — O(1) 查询 |
| `packages/coding-agent/src/core/model-registry.ts` | 331-349 | `ModelRegistry` 构造函数与 `create()` |
| `packages/coding-agent/src/core/model-registry.ts` | 380-406 | `loadModels()` — 内置 + 自定义合并 |
| `packages/coding-agent/src/core/model-registry.ts` | 441-453 | `mergeCustomModels()` — 自定义覆盖策略 |
| `packages/coding-agent/src/core/model-registry.ts` | 455-508 | `loadCustomModels()` — 读 models.json |
| `packages/ai/src/oauth.ts` | 1 | re-export `./utils/oauth/index.ts` |

---

## 7. 分支与延伸

- **OAuth 登录流程(首次 `/login` 命令)**:见 [第 04 章 §4.2「OAuth 登录流程」](./04-ai-auth-and-oauth.md#42-oauth-登录流程)。本步仅涵盖 token 读取与自动刷新,不涉及首次登录。

- **`models.json` 自定义 provider 的完整 schema**:见 [第 04 章 §4.4「models.json 自定义模型」](./04-ai-auth-and-oauth.md#44-modelsjson-自定义模型)。`modelOverrides` 字段可做字段级 patch 而不完全替换。

- **内置模型注册表的结构与 provider 列表**:见 [第 02 章 §2.3「模型注册表」](./02-ai-layer-providers-registry.md#23-模型注册表)。本步的 `ModelRegistry` 是 coding-agent 层的封装;`models.ts` 里的 `modelRegistry` Map 是 ai 层的底层存储。

- **`resolveConfigValue()` 的 `!command` 语法**:见 [第 04 章 §4.5「config value 解析」](./04-ai-auth-and-oauth.md#45-config-value-解析)。`models.json` 里的 `apiKey` 字段如果以 `!` 开头,会被作为 shell 命令执行,返回值作为 API key——适合密钥管理工具集成。

---

## 8. 走完这一步你脑子里应该多了什么

1. **`AuthStorage` 是惰性的**:它在构造时只做一件事——同步读 `auth.json` 到 `this.data`。不发 HTTP、不验证 token、不刷新 OAuth。真正的 credential 消费(调用 `getApiKey()`)发生在第一次 LLM 请求发出之前,届时才按优先级链决定用哪个 key,必要时触发 OAuth 刷新。

2. **OAuth 刷新是文件锁保护的临界区**:`refreshOAuthTokenWithLock()` 用 `proper-lockfile` 对 `auth.json` 加文件锁,保证多进程环境下最多只有一个进程发刷新请求。其他进程在等锁期间,已刷新的 token 会被它们读到,直接用即可,无需再次刷新。

3. **`MODELS` 对象在 import 时被展平成嵌套 Map**:这是模块级副作用,发生在进程首次 `import models.ts` 时。此后 `getModel(provider, id)` 的查询复杂度是 O(1)。`ModelRegistry` 是 coding-agent 层的服务对象,封装了内置模型 + 自定义模型合并、per-model 请求鉴权、provider display name 等功能,比直接调用 `getModel()` 能力更强。

4. **自定义模型"覆盖"而不是"合并"**:如果 `models.json` 里声明了与内置模型相同的 `(provider, id)`,整条内置记录会被完全替换。若只想改 `contextWindow` 或 `cost` 等字段,必须用 `modelOverrides` 做 patch 合并,否则会丢失 `compat`、`reasoning`、`thinkingLevelMap` 等字段。

5. **`authStorage` 在 `createRuntime` 工厂外部创建并闭包捕获**:`main.ts:527` 的 `AuthStorage.create()` 只执行一次。`createRuntime` 工厂闭包每次被调用(如 `/new`、`/resume`)时都复用同一个 `authStorage` 实例。这意味着用户通过 `/login` 或 `--api-key` 修改的 runtime key,在切换 session 后仍然有效。
