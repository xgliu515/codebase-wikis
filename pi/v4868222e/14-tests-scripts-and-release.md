# 第 14 章 测试、脚本与发布工具

> **版本锁定**:本章所有 `file:line` 引用均基于 commit `4868222e`(2026-05-20)。

---

## 14.1 测试套件全景

### `test.sh`(根目录)

这是 CI 和本地全量测试的入口脚本(`/test.sh`):

1. 将 `~/.pi/agent/auth.json` 备份为 `.bak`,并在 `trap cleanup EXIT` 中确保恢复
2. 导出 `PI_NO_LOCAL_LLM=1`,跳过依赖 ollama/lmstudio 的本地 LLM 测试
3. `unset` 全部 28 个提供商 API key 环境变量(确保测试不会意外消耗真实 token)
4. 执行 `npm test`(触发所有 workspace 的 `test` script)

核心设计意图:测试必须在零凭据的环境下通过。任何依赖真实 LLM 的代码路径都必须改为使用 faux provider,否则 `test.sh` 运行后会失败(因为所有 key 都被 unset)。

### `pi-test.sh`(根目录)

不需要全局安装 pi,直接从源码运行:

```bash
./pi-test.sh [args...]
./pi-test.sh --no-env [args...]  # --no-env 同样 unset 全部 API key
```

内部实现:

```bash
"$SCRIPT_DIR/node_modules/.bin/tsx" \
  --tsconfig "$SCRIPT_DIR/tsconfig.json" \
  "$SCRIPT_DIR/packages/coding-agent/src/cli.ts" \
  ${ARGS[@]+"${ARGS[@]}"}
```

目的是在 monorepo 根目录运行 pi 并自动加载 `AGENTS.md`,方便 agent 遵循项目约定。Windows 对应有 `pi-test.bat` 和 `pi-test.ps1`。

### 各 package 的 test 目录

| Package | 测试目录 | 主要内容 |
|---|---|---|
| `coding-agent` | `test/suite/` | 集成测试、回归测试、harness |
| `ai` | `test/` | Provider 单元测试 |
| `agent` | `test/` | agent-core 单元测试 |
| `tui` | `test/` | TUI 组件渲染测试 |

`coding-agent` 的测试子目录:

```
packages/coding-agent/test/
├── suite/
│   ├── harness.ts          测试脚手架(见 14.4)
│   ├── regressions/        回归测试(见 14.3)
│   └── *.test.ts           功能集成测试
└── utilities.ts            共享测试工具函数
```

---

## 14.2 faux provider

**位置**:`packages/ai/src/providers/faux.ts`

faux provider 是测试时的 LLM 替代品,完全在内存中运行,无网络请求:

```typescript
// faux.ts:37-45
export interface FauxModelDefinition {
    id: string;
    name?: string;
    reasoning?: boolean;
    input?: ("text" | "image")[];
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow?: number;
    maxTokens?: number;
}
```

**注册方式:**

```typescript
const faux = registerFauxProvider({ models: [...] });
faux.setResponses([
    fauxAssistantMessage("我来读一下文件"),
    fauxAssistantMessage([
        fauxToolCall("Read", { file_path: "README.md" })
    ]),
    fauxAssistantMessage("第一行是 # Pi"),
]);
```

**响应步骤格式 `FauxResponseStep`**:每个 step 对应 agent 的一次 LLM 调用。step 可以是:
- 字符串(直接文本响应)
- `AssistantMessage`(完整消息,用 `fauxAssistantMessage()` 构造)
- 工厂函数(接收上下文动态生成响应,用于测试复杂交互)

**流式模拟**:faux provider 将消息内容按 token 切分后逐步 emit,支持 `message_update` 事件流,测试可以验证流式渲染路径。

**典型用法模式:**

```typescript
// 来自 test/suite/harness.ts
const harness = await createHarness({
    models: [{ id: "test-model", reasoning: false }],
    settings: { compaction: { enabled: false } },
});
harness.setResponses([fauxAssistantMessage("Hello!")]);
await harness.session.prompt("Say hello");
assert(getAssistantTexts(harness)[0] === "Hello!");
```

---

## 14.3 回归测试约定

**目录**:`packages/coding-agent/test/suite/regressions/`

**命名规则**:`<issue-number>-<slug>.test.ts`

当前回归测试文件:

```
1717-2113-agent-session-event-settlement.test.ts
2023-queued-slash-command-followup.test.ts
2753-reload-stale-resource-settings.test.ts
2781-skill-collision-precedence.test.ts
2791-fswatch-error-crash.test.ts
2835-tools-allowlist-filters-extension-tools.test.ts
2860-replaced-session-context.test.ts
3217-scoped-model-order.test.ts
3302-find-path-glob.test.ts
3303-find-nested-gitignore.test.ts
3317-network-connection-lost-retry.test.ts
3592-no-builtin-tools-keeps-extension-tools.test.ts
3616-settings-inmemory-reload.test.ts
3686-session-name-event.test.ts
3688-tree-cancel-compacting.test.ts
3982-message-end-cost-override.test.ts
4167-thinking-toggle-pending-tool-render.test.ts
```

`AGENTS.md` 强调这条命名规则的原因是可追溯性:每个回归测试必须对应一个 issue 编号,方便未来的修改者理解"这个测试在保护什么"。没有 issue 号的测试文件无法与 bug 历史关联,修改时更容易误删。

规范要求:修复 bug 后必须在 `regressions/` 下新增以 issue 号命名的测试,不允许只改代码不写回归测试。

---

## 14.4 测试 harness

**位置**:`packages/coding-agent/test/suite/harness.ts`

`createHarness()` 是所有集成测试的统一构建函数:

```typescript
export interface Harness {
    session: AgentSession;        // 核心 session 实例
    sessionManager: SessionManager;
    settingsManager: SettingsManager;
    authStorage: AuthStorage;
    faux: FauxProviderRegistration;
    models: [Model<string>, ...Model<string>[]];
    getModel(): Model<string>;
    setResponses(responses: FauxResponseStep[]): void;
    appendResponses(responses: FauxResponseStep[]): void;
    getPendingResponseCount(): () => number;
    events: AgentSessionEvent[];  // 收集的全部事件
    eventsOfType<T>(type: T): Extract<AgentSessionEvent, {type: T}>[];
    tempDir: string;
    cleanup(): void;
}
```

harness 内部:

1. 创建临时目录(`mkdtempSync`)作为 session 存储和 cwd
2. 注册 faux provider,预配置 auth(`withConfiguredAuth: true` 时跳过 API key 校验)
3. 创建 `AgentSession`(含 `SessionManager`、`SettingsManager`、`ModelRegistry`)
4. 订阅所有 `AgentSessionEvent` 并推入 `events[]` 数组,方便测试断言事件顺序
5. `cleanup()` 卸载 faux provider 并删除临时目录

`getMessageText()` 和 `getAssistantTexts()` / `getUserTexts()` 是常用的消息内容提取工具函数(`harness.ts:29-56`)。

---

## 14.5 `scripts/` 目录全员

| 脚本文件 | 用途 |
|---|---|
| `generate-coding-agent-shrinkwrap.mjs` | 生成/校验 `npm-shrinkwrap.json` |
| `check-pinned-deps.mjs` | 校验所有直接依赖为精确版本 |
| `check-ts-relative-imports.mjs` | 禁止 `.ts` 文件使用 `.js` 后缀的相对 import |
| `check-browser-smoke.mjs` | 浏览器端冒烟测试入口 |
| `check-lockfile-commit.mjs` | pre-commit hook:防止意外提交 lockfile |
| `release.mjs` | 正式发布流程(含版本提升、CHANGELOG、npm publish) |
| `local-release.mjs` | 本地发布到 local registry 测试 |
| `sync-versions.js` | 在所有 workspace 间同步版本号 |
| `profile-coding-agent-node.mjs` | Node/Bun 启动时间基准测试 |
| `cost.ts` | 分析指定目录历史 session 的累计 API 费用 |
| `tool-stats.ts` | 统计 session 中各工具的调用次数 |
| `read-tool-stats.mjs` | Read 工具专项统计 |
| `edit-tool-stats.mjs` | Edit 工具专项统计 |
| `session-context-stats.mjs` | 分析 session 上下文 token 使用趋势 |
| `session-transcripts.ts` | 生成 session 的文本转录 |
| `stats.ts` | 综合统计工具 |
| `browser-smoke-entry.ts` | 浏览器构建 entry point |
| `build-binaries.sh` | 构建 native 二进制 |
| `update-source-imports-to-ts.sh` | 将 `.js` import 批量替换为 `.ts` |

### `packages/ai/scripts/generate-models.ts` — 模型清单生成

这是 pi 的模型数据来源(不在 `scripts/` 下,在 `packages/ai/scripts/`):

**工作原理:**

1. 从各 provider 的 API 端点 fetch 模型列表(Copilot、Together、AI Gateway 等)
2. 对于静态已知的 provider(Anthropic、OpenAI、Gemini 等),直接在脚本中硬编码模型定义
3. 合并所有来源,去重,写入 `packages/ai/src/models.generated.ts`

`biome.json` 的 `files.includes` 中明确排除 `!**/models.generated.ts`,`npm run check` 不对该文件执行 lint/format,也不允许手动修改。

**禁止手改的原因**:生成文件包含从 provider API 抓取的精确 cost、context window、capability 数据。手动编辑容易与下次 `generate-models` 运行产生冲突,且无法知道哪些字段是最新的。正确做法是修改 `generate-models.ts` 里的 Provider 定义后重新生成。

### `check-pinned-deps.mjs` — 依赖精确版本校验

遍历所有 `package.json` 文件的 `dependencies`、`devDependencies`、`optionalDependencies`:

```javascript
// check-pinned-deps.mjs:5
const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)...$/;
```

- workspace 内部依赖(`@earendil-works/pi-*`)被跳过
- `workspace:`、`file:`、`git+` 等非 registry 来源被跳过
- `npm:alias@x.y.z` 格式提取 `x.y.z` 部分进行校验

**为什么重要**:如果使用 `^1.2.3` 这样的范围版本,不同时间安装的 `node_modules` 内容可能不同,破坏可重复构建。配合 `.npmrc` 的 `save-exact=true` 和 `min-release-age=2`,构成了 supply chain hardening 的基础。

### `check-ts-relative-imports.mjs` — TS import 路径校验

使用 TypeScript compiler API 解析所有 `.ts` 文件的 import 路径:

```javascript
// check-ts-relative-imports.mjs:23-25
function isRelativeJavaScriptSpecifier(specifier) {
    return /^\.\.?\//.test(specifier) && /\.js(?:[?#].*)?$/.test(specifier);
}
```

禁止形如 `import "./foo.js"` 的相对 `.js` 后缀 import。

**技术背景**:pi 使用 `tsgo`(TypeScript Go 端口,strip-only 模式)执行 TypeScript,这种模式只剥离类型注解,不做路径转换。Node.js 的 ES module 解析器要求 `.ts` 文件中的 import 直接写 `.ts` 后缀(如 `import "./foo.ts"`),而不是传统 tsc 项目里常见的 `.js`。如果写成 `.js`,运行时 Node 会真的去找 `.js` 文件,找不到就崩溃。

### `check-browser-smoke.mjs` — 浏览器端冒烟

将 `browser-smoke-entry.ts` 打包并在无头浏览器中执行,验证 `packages/ai` 的核心 API 可以在浏览器环境下工作(某些工具函数需要兼容浏览器,例如 SDK 文档里提到的浏览器端用法)。

### `generate-coding-agent-shrinkwrap.mjs` — Shrinkwrap 生成与校验

从根 `package-lock.json` 中提取 `packages/coding-agent` 的全部依赖子树,生成 `packages/coding-agent/npm-shrinkwrap.json`。

关键逻辑:

- 仅包含 `packages/coding-agent` 实际引用的依赖
- 跳过内部 workspace 依赖(`@earendil-works/pi-*`)
- 校验模式(`--check`):比较现有 shrinkwrap 与刚生成的内容是否一致,不一致则失败
- 保护条件:任何有 `hasInstallScript` 的包必须在 `allowedInstallScriptPackages` 白名单中

Shrinkwrap 的意义:npm 在安装 `@earendil-works/pi-coding-agent` 时会读取 `npm-shrinkwrap.json`,锁定所有间接依赖的版本。最终用户安装的依赖树与 CI 构建完全一致。

### `release.mjs` / `local-release.mjs` — 发布流程

`release.mjs` 是 lockstep 版本发布脚本,所有 package 必须同步升级:

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="release.mjs 发布流程：8 个步骤从检查工作树到最终 git commit">
  <defs>
    <marker id="ar141" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="18" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">release.mjs 发布流程</text>
  <rect x="180" y="26" width="400" height="26" rx="5" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="43" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">① 检查工作树无未提交变更</text>
  <line x1="380" y1="52" x2="380" y2="62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar141)"/>
  <rect x="100" y="62" width="560" height="40" rx="5" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="77" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">② npm run version:patch/minor/major</text>
  <text x="380" y="91" text-anchor="middle" font-size="9" fill="#64748b">npm version -ws（所有 workspace 同步）→ sync-versions.js → npm install --package-lock-only</text>
  <line x1="380" y1="102" x2="380" y2="112" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar141)"/>
  <rect x="180" y="112" width="400" height="26" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="129" text-anchor="middle" font-size="11" fill="#64748b">③ CHANGELOG.md：[Unreleased] → [x.y.z] - date</text>
  <line x1="380" y1="138" x2="380" y2="148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar141)"/>
  <rect x="180" y="148" width="400" height="26" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="165" text-anchor="middle" font-size="11" fill="#64748b">④ generate-coding-agent-shrinkwrap.mjs 重新生成</text>
  <line x1="380" y1="174" x2="380" y2="184" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar141)"/>
  <rect x="180" y="184" width="400" height="26" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="201" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">⑤ git add + git commit + git tag vx.y.z</text>
  <line x1="380" y1="210" x2="380" y2="220" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar141)"/>
  <rect x="180" y="220" width="400" height="26" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="237" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">⑥ npm publish -ws --access public</text>
  <line x1="380" y1="246" x2="380" y2="256" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar141)"/>
  <rect x="180" y="256" width="400" height="26" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="273" text-anchor="middle" font-size="11" fill="#64748b">⑦ CHANGELOG.md 追加新 [Unreleased] 节</text>
  <line x1="380" y1="282" x2="380" y2="288" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar141)"/>
  <rect x="180" y="288" width="400" height="8" rx="4" fill="#0d9488" stroke="#0d9488" stroke-width="0"/>
  <text x="590" y="300" text-anchor="end" font-size="9" fill="#94a3b8">⑧ git commit</text>
</svg>
<span class="figure-caption">图 R14.1 ｜ release.mjs 发布流程——lockstep 八步从版本检查到发布完成</span>

<details>
<summary>ASCII 原版</summary>

```
1. 检查工作树无未提交变更
2. npm run version:patch/minor/major
   → npm version -ws (所有 workspace 同步)
   → sync-versions.js 更新 package.json 中的内部依赖版本
   → npm install --package-lock-only 更新 lockfile
3. CHANGELOG.md 中 [Unreleased] → [x.y.z] - date
4. generate-coding-agent-shrinkwrap.mjs 重新生成
5. git add + git commit + git tag vx.y.z
6. npm publish -ws --access public
7. CHANGELOG.md 追加新 [Unreleased] 节
8. git commit
```

</details>

`local-release.mjs` 是本地测试版:发布到本地 npm registry(verdaccio),用于在不污染 npm 的情况下测试完整安装流程。

### `profile-coding-agent-node.mjs` — 性能 profile

测量 pi 冷启动时间:

- `--mode tui`:测量 TUI 模式启动到就绪的时间
- `--mode rpc`:测量 RPC 模式(无 TUI)启动时间
- `--runs N`:多次测量取平均
- `--cpu-profile`:写出 V8 CPU profile 供 flamegraph 分析
- 支持 Node.js 和 Bun 两种运行时

### `cost.ts`、`tool-stats.ts`、`session-context-stats.mjs` — 数据分析

这三个脚本针对真实 session 数据:

- `cost.ts`:统计指定目录过去 N 天的每日 API 花费(input/output/cacheRead/cacheWrite token + 金额)
- `tool-stats.ts`:统计各工具被调用的频率、平均输出大小
- `session-context-stats.mjs`:分析 session 上下文增长趋势,辅助调整 compaction 参数

会话目录路径编码与 `session-manager.ts` 里的 `encodeCwd` 逻辑一致(`cost.ts` 里有独立实现的 `encodeSessionDir` 函数)。

---

## 14.6 biome.json 配置

```json
{
  "linter": {
    "rules": {
      "style": { "noNonNullAssertion": "off", "useNodejsImportProtocol": "off" },
      "suspicious": { "noExplicitAny": "off", "noEmptyInterface": "off" }
    }
  },
  "formatter": {
    "indentStyle": "tab",
    "indentWidth": 3,
    "lineWidth": 120
  },
  "files": {
    "includes": ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts", ...]
  }
}
```

**为什么用 biome 而不是 eslint + prettier?**

biome 将 lint 和 format 合并为单一工具,一次 `biome check --write` 完成格式化和 lint 修复。这消除了 eslint 和 prettier 规则冲突的问题(两者都操作 AST,可能相互抵消)。biome 是用 Rust 编写的,比 eslint + prettier 快约 10-100 倍,在大型 monorepo 里感知明显。

关键配置项:

- `noNonNullAssertion: "off"`:pi 代码库大量使用 `!` 断言,开启会产生太多噪音
- `useNodejsImportProtocol: "off"`:不强制 `node:fs` 前缀(允许 `import fs from "fs"`)
- `noExplicitAny: "off"`:部分代码有合理的 `any` 使用(如扩展 API 的动态类型)

---

## 14.7 `npm run check` 做了什么

完整的 check pipeline(`package.json` scripts):

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="npm run check 流水线：六个并行检查步骤">
  <defs>
    <marker id="ar142" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="18" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">npm run check 流水线</text>
  <rect x="240" y="26" width="280" height="28" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="45" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">npm run check</text>
  <line x1="380" y1="54" x2="380" y2="68" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="60" y1="68" x2="700" y2="68" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="60" y1="68" x2="60" y2="80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar142)"/>
  <line x1="188" y1="68" x2="188" y2="80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar142)"/>
  <line x1="316" y1="68" x2="316" y2="80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar142)"/>
  <line x1="444" y1="68" x2="444" y2="80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar142)"/>
  <line x1="572" y1="68" x2="572" y2="80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar142)"/>
  <line x1="700" y1="68" x2="700" y2="80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar142)"/>
  <rect x="4" y="80" width="113" height="70" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="60" y="96" text-anchor="middle" font-size="9" font-weight="600" fill="#7c3aed">biome check</text>
  <text x="60" y="108" text-anchor="middle" font-size="9" fill="#64748b">--write</text>
  <text x="60" y="120" text-anchor="middle" font-size="9" fill="#64748b">--error-on-</text>
  <text x="60" y="132" text-anchor="middle" font-size="9" fill="#64748b">warnings</text>
  <text x="60" y="144" text-anchor="middle" font-size="8" fill="#94a3b8">格式化 + lint</text>
  <rect x="131" y="80" width="113" height="70" rx="5" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="188" y="96" text-anchor="middle" font-size="9" font-weight="600" fill="#0d9488">check:</text>
  <text x="188" y="108" text-anchor="middle" font-size="9" font-weight="600" fill="#0d9488">pinned-deps</text>
  <text x="188" y="122" text-anchor="middle" font-size="9" fill="#64748b">check-pinned-</text>
  <text x="188" y="134" text-anchor="middle" font-size="9" fill="#64748b">deps.mjs</text>
  <text x="188" y="146" text-anchor="middle" font-size="8" fill="#94a3b8">精确版本校验</text>
  <rect x="258" y="80" width="113" height="70" rx="5" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="316" y="96" text-anchor="middle" font-size="9" font-weight="600" fill="#0d9488">check:</text>
  <text x="316" y="108" text-anchor="middle" font-size="9" font-weight="600" fill="#0d9488">ts-imports</text>
  <text x="316" y="122" text-anchor="middle" font-size="9" fill="#64748b">check-ts-</text>
  <text x="316" y="134" text-anchor="middle" font-size="9" fill="#64748b">relative-imports</text>
  <text x="316" y="146" text-anchor="middle" font-size="8" fill="#94a3b8">禁止 .js 后缀</text>
  <rect x="386" y="80" width="113" height="70" rx="5" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="444" y="96" text-anchor="middle" font-size="9" font-weight="600" fill="#0d9488">check:</text>
  <text x="444" y="108" text-anchor="middle" font-size="9" font-weight="600" fill="#0d9488">shrinkwrap</text>
  <text x="444" y="122" text-anchor="middle" font-size="9" fill="#64748b">generate-</text>
  <text x="444" y="134" text-anchor="middle" font-size="9" fill="#64748b">shrinkwrap --check</text>
  <text x="444" y="146" text-anchor="middle" font-size="8" fill="#94a3b8">锁定验证</text>
  <rect x="514" y="80" width="113" height="70" rx="5" fill="#f1f5f9" stroke="#ea580c" stroke-width="1.5"/>
  <text x="572" y="96" text-anchor="middle" font-size="9" font-weight="600" fill="#ea580c">tsgo --noEmit</text>
  <text x="572" y="110" text-anchor="middle" font-size="9" fill="#64748b">TypeScript</text>
  <text x="572" y="122" text-anchor="middle" font-size="9" fill="#64748b">类型检查</text>
  <text x="572" y="134" text-anchor="middle" font-size="9" fill="#64748b">（Go 端口）</text>
  <text x="572" y="146" text-anchor="middle" font-size="8" fill="#94a3b8">不生成输出</text>
  <rect x="642" y="80" width="113" height="70" rx="5" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="700" y="96" text-anchor="middle" font-size="9" font-weight="600" fill="#0ea5e9">check:</text>
  <text x="700" y="108" text-anchor="middle" font-size="9" font-weight="600" fill="#0ea5e9">browser-smoke</text>
  <text x="700" y="122" text-anchor="middle" font-size="9" fill="#64748b">check-browser-</text>
  <text x="700" y="134" text-anchor="middle" font-size="9" fill="#64748b">smoke.mjs</text>
  <text x="700" y="146" text-anchor="middle" font-size="8" fill="#94a3b8">浏览器兼容</text>
  <line x1="60" y1="150" x2="60" y2="168" stroke="#94a3b8" stroke-width="1"/>
  <line x1="188" y1="150" x2="188" y2="168" stroke="#94a3b8" stroke-width="1"/>
  <line x1="316" y1="150" x2="316" y2="168" stroke="#94a3b8" stroke-width="1"/>
  <line x1="444" y1="150" x2="444" y2="168" stroke="#94a3b8" stroke-width="1"/>
  <line x1="572" y1="150" x2="572" y2="168" stroke="#94a3b8" stroke-width="1"/>
  <line x1="700" y1="150" x2="700" y2="168" stroke="#94a3b8" stroke-width="1"/>
  <line x1="60" y1="168" x2="700" y2="168" stroke="#94a3b8" stroke-width="1"/>
  <line x1="380" y1="168" x2="380" y2="180" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar142)"/>
  <rect x="200" y="180" width="360" height="28" rx="6" fill="#f0fdf4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="195" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">全部通过 → check 成功</text>
  <text x="380" y="206" text-anchor="middle" font-size="9" fill="#64748b">prepublishOnly：clean → build → check（发布前完整验证）</text>
</svg>
<span class="figure-caption">图 R14.2 ｜ npm run check 流水线——六步并行检查覆盖格式化、版本、类型与安全</span>

<details>
<summary>ASCII 原版</summary>

```
npm run check
    ├─ biome check --write --error-on-warnings .
    │   格式化 + lint,警告级别的 lint 也视为错误
    │   只处理 biome.json files.includes 指定的文件
    │
    ├─ npm run check:pinned-deps
    │   node scripts/check-pinned-deps.mjs
    │
    ├─ npm run check:ts-imports
    │   node scripts/check-ts-relative-imports.mjs
    │
    ├─ npm run check:shrinkwrap
    │   node scripts/generate-coding-agent-shrinkwrap.mjs --check
    │
    ├─ tsgo --noEmit
    │   TypeScript 类型检查(Go 端口,比 tsc 更快)
    │   仅类型检查,不生成输出
    │
    └─ npm run check:browser-smoke
        node scripts/check-browser-smoke.mjs
```

</details>

`prepublishOnly` 脚本在 `npm publish` 前执行 `clean → build → check`,发布前的完整验证链。

---

## 14.8 CONTRIBUTING.md 中值得注意的流程

**自动关闭机制:**

所有新贡献者的 issue 和 PR 默认被 auto-close bot 关闭。maintainer 每天审查并 reopen 合格的 issue。

- `lgtmi`:该用户未来的 issue 不再 auto-close
- `lgtm`:该用户未来的 issue 和 PR 都不 auto-close

`lgtmi` 不赋予提交 PR 的权利,只有 `lgtm` 才允许提交 PR。

**周末不审 issue:**

周五到周日提交的 issue 不会被审查,体现了 maintainer 对工作边界的明确划定。

**PR 前置条件:**

```bash
npm run check  # 必须通过
./test.sh      # 必须通过
```

两者都必须通过,且不能修改 `CHANGELOG.md`(由 maintainer 负责)。

**核心哲学**:pi 的核心应当保持最小化。不属于核心的功能应该通过扩展实现。会使核心膨胀的 PR 大概率被拒绝。

---

## 14.9 Supply-chain hardening

根 README 末尾专门描述了 supply chain 安全措施:

**`.npmrc` 配置:**

```
save-exact=true
min-release-age=2
```

- `save-exact=true`:每次 `npm install <pkg>` 都保存精确版本号,不使用 `^` 或 `~`
- `min-release-age=2`:npm 在解析依赖时,拒绝安装发布时间少于 2 天的版本

`min-release-age=2` 的意图:防御 "fast publish attack"——攻击者在发现 typosquat 或劫持机会后,立即发布恶意版本,希望在被发现之前被大量安装。2 天的窗口给了社区时间发现问题。

**`PI_ALLOW_LOCKFILE_CHANGE` — lockfile 提交保护:**

`check-lockfile-commit.mjs` 被注册为 pre-commit hook(通过 husky):

```javascript
// check-lockfile-commit.mjs:5-6
const allowValue = process.env.PI_ALLOW_LOCKFILE_CHANGE;
const allowed = allowValue === "1" || allowValue === "true" || allowValue === "yes";
```

如果 `package-lock.json` 被 stage 了但没有设置 `PI_ALLOW_LOCKFILE_CHANGE=1`,pre-commit hook 会:

1. 输出 lockfile 变更摘要(新增/移除/版本变更的包)
2. 拒绝提交

这迫使开发者在提交 lockfile 变更时显式确认变更内容,防止意外引入恶意依赖。

**`npm-shrinkwrap.json` — 端到端锁定:**

`packages/coding-agent` 包含 `npm-shrinkwrap.json`(由 `generate-coding-agent-shrinkwrap.mjs` 生成)。与 `package-lock.json` 不同,`npm-shrinkwrap.json` 随包发布,最终用户安装时会使用它而不是自行解析。这保证生产用户安装的依赖树与 CI 构建完全一致,即使某个依赖发布了新 patch 版本也不会被自动采用。

三道防线合在一起:

<svg viewBox="0 0 640 180" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Supply-chain 三道防线加一道人工审查">
  <defs>
    <marker id="ar143" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="320" y="16" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Supply-chain 四道防线</text>
  <rect x="20" y="26" width="600" height="28" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="140" y="41" font-size="11" font-weight="700" fill="#ea580c">① save-exact</text>
  <text x="260" y="41" font-size="10" fill="#64748b">→ package.json 里没有 range 版本（无 ^ 或 ~）</text>
  <rect x="20" y="62" width="600" height="28" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="140" y="77" font-size="11" font-weight="700" fill="#7c3aed">② min-release-age=2</text>
  <text x="260" y="77" font-size="10" fill="#64748b">→ 新版本至少 2 天后才被解析到，阻断 fast publish attack</text>
  <rect x="20" y="98" width="600" height="28" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="140" y="113" font-size="11" font-weight="700" fill="#0d9488">③ shrinkwrap</text>
  <text x="260" y="113" font-size="10" fill="#64748b">→ 最终用户安装时强制锁定到构建时的版本</text>
  <rect x="20" y="134" width="600" height="28" rx="6" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="140" y="149" font-size="11" font-weight="700" fill="#0ea5e9">④ PI_ALLOW_LOCKFILE_CHANGE</text>
  <text x="340" y="149" font-size="10" fill="#64748b">→ 人工审查 lockfile 变更时的强制确认</text>
</svg>
<span class="figure-caption">图 R14.3 ｜ Supply-chain 四道防线——从版本精确锁定到人工审查的纵深防御</span>

<details>
<summary>ASCII 原版</summary>

```
save-exact      → package.json 里没有 range 版本
min-release-age → 新版本至少 2 天后才被解析到
shrinkwrap      → 最终用户安装时强制锁定到构建时的版本
PI_ALLOW...     → 人工审查 lockfile 变更时的强制确认
```

</details>
