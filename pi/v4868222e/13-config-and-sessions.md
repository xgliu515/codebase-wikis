# 第 13 章 配置、Session 文件与项目级定制

> **版本锁定**:本章所有 `file:line` 引用均基于 commit `4868222e`(2026-05-20)。

---

## 13.1 配置体系的设计目标

pi 的配置需要同时满足三类用户的需求:

1. **个人用户**:设置一次 API key、默认模型、个人偏好,全机器通用
2. **项目协作者**:在 `.pi/settings.json` 里写入团队共用的工具列表、系统提示扩展,提交到 git
3. **临时运行**:CLI flag 覆盖某次运行的模型或工具集,不污染持久配置

这要求配置是"可叠加的",低优先级的设置可以被高优先级的覆盖,但冲突时规则必须明确。pi 选择的方案是:

- **三层合并**:用户级全局 → 项目级 → CLI flag/运行时覆盖
- **深度合并**:嵌套对象(如 `compaction`、`retry`)递归合并,数组和基本类型高优先级完全覆盖
- **失败回退**:任何一层解析失败时记录错误但不崩溃,使用空对象继续

---

## 13.2 配置文件位置

```
~/.pi/
└── agent/
    ├── auth.json          API key 和 OAuth token 存储 (chmod 600)
    ├── settings.json      用户级全局设置
    ├── keybindings.json   键盘快捷键覆盖
    ├── models.json        自定义模型列表 (可选)
    ├── sessions/          会话文件目录
    │   ├── --home-user-project--/       按 cwd 哈希编码的子目录
    │   │   ├── 2025-01-15T10-00-00-000Z_<uuid>.jsonl
    │   │   └── ...
    │   └── ...
    ├── themes/            自定义主题 (可选)
    ├── prompts/           用户级 prompt template (可选)
    ├── bin/               自动下载的工具 (fd, rg)
    └── pi-debug.log       调试日志 (PI_LOG_LEVEL=debug 时)

<project>/
└── .pi/
    ├── settings.json      项目级设置 (可提交 git)
    ├── AGENTS.md          项目系统提示扩展 (被 pi 自动加载)
    └── extensions/        项目级扩展 (可选)
```

根目录由 `getAgentDir()` 计算(`config.ts:475-481`):

```typescript
export function getAgentDir(): string {
    const envDir = process.env[ENV_AGENT_DIR]; // PI_CODING_AGENT_DIR
    if (envDir) {
        return expandTildePath(envDir);
    }
    return join(homedir(), CONFIG_DIR_NAME, "agent"); // ~/.pi/agent
}
```

`CONFIG_DIR_NAME` 默认为 `".pi"`,但可通过 `package.json` 的 `piConfig.configDir` 字段改变(允许 pi 的 fork 使用不同的配置目录,如 tau 使用 `.tau`)。

---

## 13.3 `auth.json` 结构

`auth.json` 是一个以 provider ID 为键的扁平 JSON 对象:

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "sk-ant-..."
  },
  "github-copilot": {
    "type": "oauth",
    "access_token": "gho_...",
    "refresh_token": "ghr_...",
    "expires_at": "2025-06-15T10:00:00.000Z",
    "token_type": "Bearer",
    "scope": "user"
  }
}
```

类型定义在 `auth-storage.ts:23-34`:

```typescript
export type ApiKeyCredential = {
    type: "api_key";
    key: string;
};

export type OAuthCredential = {
    type: "oauth";
} & OAuthCredentials;  // access_token, refresh_token, expires_at...

export type AuthStorageData = Record<string, AuthCredential>;
```

文件权限强制为 `0o600`(仅所有者可读写),在写入时由 `chmodSync(this.authPath, 0o600)` 执行(`auth-storage.ts:69`、`auth-storage.ts:116`)。父目录创建时使用 `0o700`。

**读写模块**:`AuthStorage` 类(`auth-storage.ts:195-末`)

- `AuthStorage.create()` 读取 `~/.pi/agent/auth.json`
- `get(provider)` / `set(provider, credential)` / `remove(provider)` 提供 CRUD
- 写操作通过 `withLock` / `withLockAsync` 加文件锁(`proper-lockfile`)防止多实例竞争
- `getApiKey(provider)` 按优先级查找:runtime override → auth.json → 环境变量 → fallback resolver

---

## 13.4 `settings.json` 结构

完整的 `Settings` 接口定义在 `settings-manager.ts:77-115`:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5",
  "defaultThinkingLevel": "off",
  "transport": "auto",
  "theme": "dark",
  "quietStartup": false,
  "collapseChangelog": true,
  "steeringMode": "all",
  "followUpMode": "all",
  "doubleEscapeAction": "tree",

  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },

  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000
  },

  "terminal": {
    "showImages": true,
    "imageWidthCells": 60,
    "clearOnShrink": false,
    "showTerminalProgress": false
  },

  "markdown": {
    "codeBlockIndent": "  "
  },

  "packages": ["npm:my-pi-extension"],
  "extensions": ["./extensions/my-ext.ts"],
  "skills": ["./skills/"],
  "prompts": ["./prompts/"],

  "keybindings": {
    "app.interrupt": "escape",
    "app.model.select": "ctrl+k"
  }
}
```

关键设计:

- **数组字段**(如 `packages`、`extensions`)在合并时高优先级完全替换低优先级,不追加。这是有意的:项目配置不应自动继承用户级的扩展列表。
- **嵌套对象**(`compaction`、`retry`、`terminal` 等)做浅合并,未指定的子键继承低优先级的值
- **`keybindings`** 不在 `Settings` 接口里,而是存储在独立的 `keybindings.json`

---

## 13.5 SettingsManager

代码位置:`packages/coding-agent/src/core/settings-manager.ts`

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="SettingsManager 类结构图：工厂方法、内部状态与读写接口">
  <defs>
    <marker id="ar131" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="18" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">SettingsManager</text>
  <rect x="20" y="28" width="720" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="42" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">工厂方法</text>
  <text x="80" y="54" font-size="10" fill="#64748b">create(cwd, agentDir)  — 从文件创建：全局 agentDir/settings.json · 项目 cwd/.pi/settings.json</text>
  <line x1="60" y1="60" x2="60" y2="72" stroke="#94a3b8" stroke-width="1"/>
  <line x1="380" y1="60" x2="380" y2="72" stroke="#94a3b8" stroke-width="1"/>
  <line x1="700" y1="60" x2="700" y2="72" stroke="#94a3b8" stroke-width="1"/>
  <line x1="60" y1="72" x2="700" y2="72" stroke="#94a3b8" stroke-width="1"/>
  <line x1="60" y1="72" x2="60" y2="84" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar131)"/>
  <line x1="380" y1="72" x2="380" y2="84" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar131)"/>
  <line x1="700" y1="72" x2="700" y2="84" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar131)"/>
  <rect x="20" y="84" width="200" height="36" rx="5" fill="#f1f5f9" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="120" y="99" text-anchor="middle" font-size="10" font-weight="600" fill="#7c3aed">fromStorage(storage)</text>
  <text x="120" y="113" text-anchor="middle" font-size="9" fill="#64748b">注入任意 SettingsStorage backend</text>
  <rect x="280" y="84" width="200" height="36" rx="5" fill="#f1f5f9" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="99" text-anchor="middle" font-size="10" font-weight="600" fill="#7c3aed">inMemory(settings)</text>
  <text x="380" y="113" text-anchor="middle" font-size="9" fill="#64748b">测试用，无文件 I/O</text>
  <rect x="540" y="84" width="200" height="36" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="640" y="99" text-anchor="middle" font-size="10" font-weight="600" fill="#7c3aed">内部状态</text>
  <text x="640" y="113" text-anchor="middle" font-size="9" fill="#64748b">globalSettings · projectSettings · settings</text>
  <text x="640" y="124" text-anchor="middle" font-size="9" fill="#94a3b8">deepMergeSettings(global, project)</text>
  <line x1="380" y1="140" x2="380" y2="154" stroke="#94a3b8" stroke-width="1"/>
  <line x1="200" y1="154" x2="560" y2="154" stroke="#94a3b8" stroke-width="1"/>
  <line x1="200" y1="154" x2="200" y2="166" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar131)"/>
  <line x1="560" y1="154" x2="560" y2="166" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar131)"/>
  <rect x="20" y="166" width="360" height="60" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="200" y="182" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">读接口</text>
  <text x="200" y="196" text-anchor="middle" font-size="10" fill="#64748b">getTheme() / getDefaultModel()</text>
  <text x="200" y="208" text-anchor="middle" font-size="10" fill="#64748b">getCompactionSettings() …</text>
  <text x="200" y="220" text-anchor="middle" font-size="9" fill="#94a3b8">直接读 this.settings.*，不再做合并</text>
  <rect x="400" y="166" width="360" height="60" rx="6" fill="#f1f5f9" stroke="#ea580c" stroke-width="1.5"/>
  <text x="580" y="182" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">写接口</text>
  <text x="580" y="196" text-anchor="middle" font-size="10" fill="#64748b">setTheme(name) → 按 scope 写 global / project</text>
  <text x="580" y="210" text-anchor="middle" font-size="10" fill="#64748b">所有写操作通过 FileSettingsStorage</text>
  <text x="580" y="222" text-anchor="middle" font-size="9" fill="#94a3b8">.withLock() 加锁</text>
  <text x="8" y="258" font-size="10" fill="#94a3b8">代码位置：packages/coding-agent/src/core/settings-manager.ts</text>
</svg>
<span class="figure-caption">图 R13.1 ｜ SettingsManager 类结构——工厂方法、双层内部状态与读写接口</span>

<details>
<summary>ASCII 原版</summary>

```
SettingsManager
├── static create(cwd, agentDir)     从文件创建,全局路径 = agentDir/settings.json
│                                    项目路径 = cwd/.pi/settings.json
├── static fromStorage(storage)      注入任意 SettingsStorage backend
├── static inMemory(settings)        测试用,无文件 I/O
│
├── 内部状态
│   ├── globalSettings   全局 settings.json 解析结果
│   ├── projectSettings  项目 settings.json 解析结果
│   └── settings         deepMergeSettings(global, project)
│
├── 读接口
│   ├── getTheme() / getDefaultModel() / getCompactionSettings() ...
│   └── 每个 getter 直接读 this.settings.*,不再做合并
│
└── 写接口
    ├── setTheme(name) → 写 global 或 project 根据 scope
    └── 所有写操作通过 FileSettingsStorage.withLock() 加锁
```

</details>

**版本迁移**:`migrateSettings()` 在加载时自动处理旧字段:

- `queueMode` → `steeringMode`(`settings-manager.ts:338-341`)
- `websockets: boolean` → `transport: "websocket" | "sse"`(`settings-manager.ts:343-347`)
- 旧 `skills` 对象格式 → 新数组格式

失败时 `tryLoadFromStorage` 记录 `Error` 并返回空对象,保证 pi 在配置文件损坏时仍能启动。

---

## 13.6 Session 文件格式

### 命名规则

会话文件路径:

```
~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<uuid>.jsonl
```

编码规则(`session-manager.ts:不直接,通过 JsonlSessionRepo.encodeCwd`):

```typescript
// jsonl-repo.ts:34-36
function encodeCwd(cwd: string): string {
    return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
```

例如:`/home/user/project` → `--home-user-project--`

时间戳格式:ISO 8601,冒号和点替换为连字符。UUID 使用 uuidv7(时间有序)。

### 文件格式

JSONL 文件,每行一个 JSON 对象。第一行固定为 session header:

```jsonl
{"type":"session","version":3,"id":"0195f4a2-...","timestamp":"2025-01-15T10:00:00.000Z","cwd":"/home/user/project"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2025-01-15T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"读一下 README.md"}],"timestamp":1737000001000}}
{"type":"message","id":"e5f6g7h8","parentId":"a1b2c3d4","timestamp":"2025-01-15T10:00:03.000Z","message":{"role":"assistant","content":[...],"usage":{"input":1200,"output":300,"cacheRead":0,"cacheWrite":0,"totalTokens":1500,"cost":{...}},"stopReason":"stop","model":"claude-sonnet-4-5","provider":"anthropic","api":"anthropic","responseId":"msg_01..."}}
{"type":"compaction","id":"i9j0k1l2","parentId":"e5f6g7h8","timestamp":"...","summary":"...(summary text)...","firstKeptEntryId":"m3n4o5p6","tokensBefore":45000}
{"type":"session_info","id":"q7r8s9t0","parentId":"i9j0k1l2","timestamp":"...","name":"README 探索"}
{"type":"label","id":"u1v2w3x4","parentId":"e5f6g7h8","targetId":"e5f6g7h8","timestamp":"...","label":"重要回复"}
```

全部 entry 类型(`session-manager.ts:136-146`):

| 类型 | 说明 |
|---|---|
| `session` | header,仅第一行 |
| `message` | LLM 消息(user/assistant/toolResult) |
| `thinking_level_change` | 用户切换 thinking level |
| `model_change` | 用户切换模型 |
| `compaction` | 上下文压缩记录,含摘要文本和 `firstKeptEntryId` |
| `branch_summary` | 分叉前的分支摘要 |
| `custom` | 扩展专用持久化数据(不进 LLM context) |
| `custom_message` | 扩展注入的 LLM context 消息 |
| `label` | 用户标签/书签 |
| `session_info` | 会话元数据(显示名等) |

### 版本迁移

当前版本:`CURRENT_SESSION_VERSION = 3`(`session-manager.ts:27`)

- v1 → v2:为所有 entry 添加 `id`/`parentId` 树结构(`migrateV1ToV2`)
- v2 → v3:将 `hookMessage` role 重命名为 `custom`(`migrateV2ToV3`)

迁移在加载时自动执行,迁移后会写回文件。

### 树结构与分叉

`id`/`parentId` 构成了会话历史的 DAG 树。正常对话是一条链,`/fork` 创建新的 JSONL 文件,其 header 包含 `parentSession: <源文件路径>`。`SessionManager.getTree()` 返回当前文件的树结构,`runtimeHost.fork()` 处理跨文件分叉。

---

## 13.7 环境变量参考

完整的环境变量列表(`packages/coding-agent/src/cli/args.ts:302-343`):

### Provider API Keys

| 变量名 | 说明 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Claude API key |
| `ANTHROPIC_OAUTH_TOKEN` | Anthropic OAuth token |
| `OPENAI_API_KEY` | OpenAI GPT API key |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key |
| `AZURE_OPENAI_BASE_URL` | Azure 基础 URL |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `GROQ_API_KEY` | Groq API key |
| `CEREBRAS_API_KEY` | Cerebras API key |
| `XAI_API_KEY` | xAI Grok API key |
| `FIREWORKS_API_KEY` | Fireworks AI API key |
| `TOGETHER_API_KEY` | Together AI API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `MISTRAL_API_KEY` | Mistral AI API key |
| `MOONSHOT_API_KEY` / `KIMI_API_KEY` | Moonshot/Kimi API key |
| `CLOUDFLARE_API_KEY` | Cloudflare Workers AI API token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `AWS_PROFILE` / `AWS_ACCESS_KEY_ID` / ... | Amazon Bedrock 凭据 |
| `GOOGLE_APPLICATION_CREDENTIALS` | Google Cloud 服务账户 JSON |
| `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` | GitHub Copilot token |

### pi 自身行为控制

| 变量名 | 说明 | 来源 |
|---|---|---|
| `PI_CODING_AGENT_DIR` | 覆盖配置目录(默认 `~/.pi/agent`) | `config.ts:453` |
| `PI_CODING_AGENT_SESSION_DIR` | 覆盖 session 存储目录 | `config.ts:454` |
| `PI_PACKAGE_DIR` | Nix/Guix store 路径覆盖 | `config.ts:331` |
| `PI_SHARE_VIEWER_URL` | `/share` 命令的 viewer base URL | `config.ts:466` |
| `PI_OFFLINE` | 设为 `1` 禁用所有启动时网络操作 | `main.ts:427` |
| `PI_SKIP_VERSION_CHECK` | 跳过新版本检查 | `version-check.ts:60` |
| `PI_STARTUP_BENCHMARK` | 打印启动耗时后退出 | `main.ts:673` |
| `PI_TELEMETRY` | 覆盖遥测开关 | `telemetry.ts:10` |
| `PI_TIMING` | 输出内部计时信息 | `timings.ts:6` |
| `PI_CLEAR_ON_SHRINK` | 强制开启 clearOnShrink | `settings-manager.ts:964` |
| `PI_HARDWARE_CURSOR` | 强制显示硬件光标 | `settings-manager.ts:1048` |
| `PI_CODING_AGENT` | 进程启动时设为 `"true"`,供子进程识别 | `cli.ts:13` |
| `PI_NO_LOCAL_LLM` | 测试时跳过本地 LLM(ollama/lmstudio) | `test.sh:23` |

`ENV_AGENT_DIR` 和 `ENV_SESSION_DIR` 实际上是动态计算的:`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`,因此 fork 版的 tau 对应 `TAU_CODING_AGENT_DIR`。

---

## 13.8 多 Profile / 多账户

pi 当前**不支持命名 profile**,但支持以下等效方式:

1. **运行时覆盖**:`PI_CODING_AGENT_DIR=/path/to/other-profile pi` 完全切换到另一套配置目录
2. **`--api-key` flag**:通过 CLI 传入临时 API key,不修改 auth.json
3. **多套 auth.json**:`AuthStorage.setRuntimeApiKey(provider, key)` 支持运行时注入,无持久化

OAuth 多账户:每个 provider ID 只能存储一条 OAuth 凭据。如需在同一 provider 下使用多个账户,必须使用不同的 `PI_CODING_AGENT_DIR`。

---

## 13.9 配置迁移策略

迁移逻辑分布在三处:

1. **`SettingsManager.migrateSettings()`**(`settings-manager.ts:336-约390`):字段重命名,JSON schema 演化
2. **`migrateKeybindingsConfig()`**(`keybindings.ts:290-310`):旧键名映射到新的 `tui.*` / `app.*` 命名空间
3. **`migrateV1ToV2()` / `migrateV2ToV3()`**(`session-manager.ts:214-260`):session JSONL 格式升级

迁移的核心原则:

- **只迁移,不强制**:如果字段不存在则保持默认,不报错
- **写回迁移结果**:keybindings 和 session 文件在检测到旧格式后自动写回新格式
- **向后兼容**:旧版 pi 打开新格式 session 文件时,未知字段被忽略(JSON 解析后只读已知字段)

---

## 13.10 配置加载流程

<svg viewBox="0 0 760 480" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="pi 启动配置加载流程：从 getAgentDir 到 InteractiveMode 运行">
  <defs>
    <marker id="ar132" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="18" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">配置加载流程</text>
  <rect x="280" y="26" width="200" height="28" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="45" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">pi 启动</text>
  <line x1="380" y1="54" x2="380" y2="70" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar132)"/>
  <rect x="160" y="70" width="440" height="44" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="86" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">SettingsManager.create(cwd, agentDir)</text>
  <text x="380" y="100" text-anchor="middle" font-size="9" fill="#64748b">getAgentDir() → ~/.pi/agent（或 PI_CODING_AGENT_DIR）</text>
  <line x1="280" y1="114" x2="280" y2="126" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar132)"/>
  <line x1="480" y1="114" x2="480" y2="126" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar132)"/>
  <rect x="160" y="126" width="240" height="56" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="280" y="142" text-anchor="middle" font-size="10" font-weight="600" fill="#64748b">读 global settings.json</text>
  <text x="280" y="156" text-anchor="middle" font-size="9" fill="#64748b">tryLoadFromStorage("global")</text>
  <text x="280" y="168" text-anchor="middle" font-size="9" fill="#64748b">→ 解析 + migrateSettings()</text>
  <text x="280" y="180" text-anchor="middle" font-size="9" fill="#94a3b8">失败 → errors[] 记录</text>
  <rect x="400" y="126" width="240" height="56" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="520" y="142" text-anchor="middle" font-size="10" font-weight="600" fill="#64748b">读 project settings.json</text>
  <text x="520" y="156" text-anchor="middle" font-size="9" fill="#64748b">tryLoadFromStorage("project")</text>
  <text x="520" y="168" text-anchor="middle" font-size="9" fill="#64748b">→ 解析 + migrateSettings()</text>
  <text x="520" y="180" text-anchor="middle" font-size="9" fill="#94a3b8">失败 → errors[] 记录</text>
  <line x1="280" y1="182" x2="380" y2="200" stroke="#94a3b8" stroke-width="1"/>
  <line x1="520" y1="182" x2="380" y2="200" stroke="#94a3b8" stroke-width="1"/>
  <line x1="380" y1="200" x2="380" y2="208" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar132)"/>
  <rect x="200" y="208" width="360" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="221" text-anchor="middle" font-size="10" font-weight="600" fill="#7c3aed">deepMergeSettings(global, project)</text>
  <text x="380" y="232" text-anchor="middle" font-size="9" fill="#64748b">嵌套对象浅合并 / 基本类型&amp;数组 project 完全替换</text>
  <line x1="380" y1="238" x2="380" y2="254" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar132)"/>
  <rect x="200" y="254" width="360" height="36" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="269" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">AuthStorage.create()</text>
  <text x="380" y="281" text-anchor="middle" font-size="9" fill="#64748b">读 auth.json · fallbackResolver → models.json 自定义 key</text>
  <line x1="380" y1="290" x2="380" y2="306" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar132)"/>
  <rect x="200" y="306" width="360" height="44" rx="6" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="380" y="321" text-anchor="middle" font-size="11" font-weight="600" fill="#0ea5e9">CLI flag 解析（main.ts）</text>
  <text x="380" y="333" text-anchor="middle" font-size="9" fill="#64748b">--provider/--model / --api-key / --session-dir</text>
  <text x="380" y="345" text-anchor="middle" font-size="9" fill="#94a3b8">--offline → PI_OFFLINE="1"</text>
  <line x1="380" y1="350" x2="380" y2="366" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar132)"/>
  <rect x="200" y="366" width="360" height="36" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="381" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">KeybindingsManager.create(agentDir)</text>
  <text x="380" y="393" text-anchor="middle" font-size="9" fill="#64748b">读 keybindings.json · migrateKeybindingsConfig() 处理旧键名</text>
  <line x1="380" y1="402" x2="380" y2="418" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar132)"/>
  <rect x="160" y="418" width="440" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="433" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">InteractiveMode 运行</text>
  <text x="380" y="447" text-anchor="middle" font-size="9" fill="#64748b">settingsManager.setXxx() → withLock 写回文件（project 优先 / global 备选）</text>
  <text x="8" y="468" font-size="10" fill="#94a3b8">优先级（高 → 低）：CLI flag → project settings → global settings → 代码默认值</text>
</svg>
<span class="figure-caption">图 R13.2 ｜ 配置加载流程——从 getAgentDir() 到 InteractiveMode 运行的五步初始化链</span>

<details>
<summary>ASCII 原版</summary>

```
pi 启动
    |
    v  config.ts: getAgentDir() → ~/.pi/agent (or PI_CODING_AGENT_DIR)
    |
    v  SettingsManager.create(cwd, agentDir)
    |   |
    |   ├─ 读 ~/.pi/agent/settings.json (global)
    |   │   tryLoadFromStorage("global") → 解析 + migrateSettings()
    |   │   失败? → errors[] 记录,globalSettings = {}
    |   │
    |   ├─ 读 <cwd>/.pi/settings.json (project)
    |   │   tryLoadFromStorage("project") → 解析 + migrateSettings()
    |   │   失败? → errors[] 记录,projectSettings = {}
    |   │
    |   └─ settings = deepMergeSettings(global, project)
    |       嵌套对象: 浅合并(project 字段优先)
    |       基本类型/数组: project 值完全替换 global 值
    |
    v  AuthStorage.create()
    |   读 ~/.pi/agent/auth.json (FileAuthStorageBackend)
    |   设置 fallbackResolver → models.json 自定义 key
    |
    v  CLI flag 解析 (main.ts)
    |   --provider/--model → 覆盖 settings.defaultProvider/defaultModel
    |   --api-key → authStorage.setRuntimeApiKey(provider, key)
    |   --session-dir → 覆盖 sessionDir
    |   --offline → process.env.PI_OFFLINE = "1"
    |
    v  KeybindingsManager.create(agentDir)
    |   读 ~/.pi/agent/keybindings.json
    |   migrateKeybindingsConfig() 处理旧键名
    |
    v  InteractiveMode 运行
        运行时设置变更: settingsManager.setXxx() → withLock 写回文件
        (project scope 优先写 .pi/settings.json,
         global scope 写 ~/.pi/agent/settings.json)
```

</details>

合并顺序摘要:

```
优先级(高 → 低): CLI flag → project settings → global settings → 代码默认值
```

深度合并的例外:当 project settings 里有一个 `compaction` 对象只设置了 `enabled: false`,全局里有 `reserveTokens: 16384`,合并结果是 `{enabled: false, reserveTokens: 16384}`。但若 project 里有 `packages: [...]`,它完全替换全局的 `packages` 列表,而不是追加。
