# 第 08 章 Coding Agent:内置工具系统

> **版本锁**: 本章所有文件引用均锁定在 commit `4868222e`(2026-05-20)。
> 代码库路径: `packages/coding-agent/src/core/tools/`

---

## 8.1 工具系统的设计目标

LLM 本身没有 IO 能力,所有与外部世界的交互(读文件、写文件、执行命令、搜索内容)都必须通过工具调用实现。工具系统需要满足三个目标:

1. **Schema 校验**: 每个工具的入参都有 TypeBox schema,LLM 生成的 JSON 先经过 schema 验证再执行。验证失败时,错误信息以 `tool_result(isError=true)` 形式回传给 LLM,而不是抛出异常让整个 agent loop 崩溃。这与"让 LLM 自我修正"的设计哲学一致。

2. **可观测性**: 每次工具调用都有 `toolCallId`,工具执行开始、更新、结束都触发对应的扩展事件(`tool_execution_start` / `tool_execution_update` / `tool_execution_end`),TUI 可以实时渲染工具执行状态。

3. **可扩展性**: 内置工具和扩展工具使用同一套 `ToolDefinition` 接口,扩展可以注册新工具、覆盖内置工具、或拦截工具调用(`tool_call` 事件 + `block`机制)。

---

## 8.2 工具定义接口:`ToolDefinition<TParams, TDetails, TState>`

`core/extensions/types.ts:426-473` 定义了核心接口:

```typescript
export interface ToolDefinition<TParams extends TSchema, TDetails = unknown, TState = any> {
  name: string;
  label: string;
  description: string;        // 发给 LLM 的描述
  promptSnippet?: string;     // system prompt 里的一行摘要
  promptGuidelines?: string[];// system prompt Guidelines 节的附加条目
  parameters: TParams;        // TypeBox schema
  renderShell?: "default" | "self";
  prepareArguments?: (args: unknown) => Static<TParams>;  // 参数兼容性 shim
  executionMode?: ToolExecutionMode;  // "sequential" | "parallel"
  execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>;
  renderCall?(args, theme, context: ToolRenderContext<TState>): Component;
  renderResult?(result, options, theme, context: ToolRenderContext<TState>): Component;
}
```

**为什么 `ToolDefinition` 比 `AgentTool` 多了这么多字段?**

`AgentTool`(来自 `@earendil-works/pi-agent-core`)是最小化接口,只有 agent loop 执行工具所需的字段:`name`、`description`、`parameters`、`execute`。

`ToolDefinition` 在此基础上增加了:
- `promptSnippet` / `promptGuidelines`:允许工具向 system prompt 注入上下文,而不需要修改中心化的 system prompt 构建逻辑
- `renderCall` / `renderResult`:TUI 渲染钩子,工具可以控制自己在终端的显示样式
- `prepareArguments`:参数兼容性 shim(比如处理某些模型把 `edits` 序列化为 JSON 字符串的 bug,见 `edit.ts:98-103`)
- `renderShell`:控制 TUI 是否为工具渲染标准彩色边框

### `wrapToolDefinition` 和 `createToolDefinitionFromAgentTool`

`tool-definition-wrapper.ts` 提供两个方向的转换:

```typescript
// tool-definition-wrapper.ts:5-18
// ToolDefinition -> AgentTool (用于注册到 agent core)
export function wrapToolDefinition<TDetails>(
  definition: ToolDefinition<any, TDetails>,
  ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    prepareArguments: definition.prepareArguments,
    executionMode: definition.executionMode,
    execute: (toolCallId, params, signal, onUpdate) =>
      definition.execute(toolCallId, params, signal, onUpdate, ctxFactory?.() as ExtensionContext),
  };
}

// AgentTool -> ToolDefinition (用于 baseToolsOverride)
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
  // ... 合成最小 ToolDefinition,无 renderCall/renderResult/promptSnippet
}
```

`ctxFactory` 是一个延迟求值的工厂函数:每次工具执行时才调用,而不是在工具注册时。这让工具在执行时能拿到当前 `ExtensionContext`(包括当前 model、当前 cwd 等动态信息)。

---

## 8.3 七大内置工具

### 8.3.1 `bash`:命令执行

**文件**: `core/tools/bash.ts`

**Schema**:
```typescript
// bash.ts:23-27
const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});
```

**执行流程**:

`createLocalBashOperations` (`bash.ts:65-128`) 是本地 shell 后端的实现:

```typescript
exec: (command, cwd, { onData, signal, timeout, env }) => {
  const { shell, args } = getShellConfig(options?.shellPath);
  const child = spawn(shell, [...args, command], {
    cwd,
    detached: process.platform !== "win32",  // Unix: 创建独立进程组
    env: env ?? getShellEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid) trackDetachedChildPid(child.pid);
  // ...stdout + stderr 合流到 onData
}
```

**为什么 `detached: true`?** 在 Unix 上,以 detached 方式 spawn 会让子进程成为新进程组的组长。当用户 abort 时,`killProcessTree(pid)` 向整个进程组发 SIGKILL,确保子进程启动的孙进程(如 `make` 调用的编译器)也被终止。

**流式 vs 一次性输出**: `OutputAccumulator` 在 `onData` 回调中累积数据。`onUpdate` 存在时,每 100ms(`BASH_UPDATE_THROTTLE_MS`)向 TUI 发送一次中间快照。工具执行完毕后,调用 `output.snapshot({ persistIfTruncated: true })` 获取最终结果。

**截断策略**: 使用 `truncateTail`(保留末尾),因为 bash 命令的错误信息和最终结果通常在最后几行。与 `read` 工具用 `truncateHead` 相反。

**超时**: 如果设置了 `timeout` 秒数,`setTimeout` 届时调用 `killProcessTree(pid)`,之后 `waitForChildProcess` 收到退出信号,以 `"timeout:{n}"` 错误 reject promise,工具返回包含已输出内容的 timeout 错误。

**`BashOperations` 接口**:抽象了执行方式。扩展可以提供自定义 `operations` 将命令转发到 SSH 远端或容器内部(`bash.ts:39-57`)。

### 8.3.2 `read`:文件读取

**文件**: `core/tools/read.ts`

**Schema**:
```typescript
// read.ts:20-24
const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum lines to read" })),
});
```

**路径解析**: 调用 `resolveReadPath(path, cwd)`(`path-utils.ts:62-94`),先做基础路径解析,失败时依次尝试 macOS 截图文件的特殊变体(AM/PM narrow no-break space、NFD 编码、卷曲引号)。这解决了用户粘贴 macOS 截图文件名时的常见问题。

**图片文件处理**: 通过 MIME type 检测识别图片,读取为 base64,可选自动缩放到 2000x2000 以内。如果当前模型不支持图片输入(非 vision 模型),在 text content 中加入警告说明。

**文本截断逻辑**(`read.ts:283-330`):
- 先应用 `offset` 和 `limit` 做行范围选择
- 再用 `truncateHead` 做字节/行数截断
- 如果首行就超过 50KB,返回特殊提示引导 LLM 用 `bash sed` 读取
- 截断后附加 "继续阅读" 提示:`Use offset={nextOffset} to continue.`

**特殊文件的紧凑显示**(`read.ts:120-141`): `AGENTS.md`、`CLAUDE.md`、skill 的 `SKILL.md` 等资源文件在 TUI 中默认折叠显示,通过 `renderCall` 中的 `getCompactReadClassification` 实现。

### 8.3.3 `write`:文件写入

**文件**: `core/tools/write.ts`

**Schema**:
```typescript
const writeSchema = Type.Object({
  path: Type.String({ description: "Path to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write" }),
});
```

**目录自动创建**: 写入前调用 `ops.mkdir(dirname(absolutePath))`,递归创建父目录。这避免了 LLM 需要先执行 `mkdir -p` 才能写文件。

**`FileMutationQueue`**: 写操作通过 `withFileMutationQueue(absolutePath, fn)` 包装(`write.ts:203`)。这确保同一文件的并发写操作被串行化,防止 LLM 在工具并发执行时出现写冲突。

**没有原子写**:直接调用 `fs.writeFile`,不使用 tmp 文件 + rename 的原子写模式。原因是 agent 场景中文件操作通常是顺序的(write 之后 verify),事务性要求不高,而 `FileMutationQueue` 已经提供了并发保护。

**流式渲染**:写入进行时 TUI 实时渲染文件内容的语法高亮预览(`write.ts:90-119`),`updateWriteHighlightCacheIncremental` 实现增量高亮计算,避免每次 streaming 更新都重新高亮全文。

### 8.3.4 `edit`:精确字符串替换

**文件**: `core/tools/edit.ts` + `core/tools/edit-diff.ts`

**Schema**:
```typescript
// edit.ts:31-51
const editSchema = Type.Object({
  path: Type.String({ description: "Path to edit" }),
  edits: Type.Array(Type.Object({
    oldText: Type.String({ description: "Exact text to match (must be unique in file)" }),
    newText: Type.String({ description: "Replacement text" }),
  })),
});
```

**为什么用精确字符串匹配而不是 line diff?**

行号在 LLM 上下文中极不稳定:每次读文件、每次编辑后行号都可能变化,LLM 产生的行号往往过时。精确字符串匹配直接锚定语义内容,只要 LLM 正确引用了原始字符串就能工作。

**多编辑批处理** (`edit-diff.ts:193-259`):

```typescript
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): AppliedEditsResult {
  // 1. 全部编辑先在原始 content 上匹配(不是增量匹配)
  // 2. 按 matchIndex 升序排序
  // 3. 检查重叠(相邻编辑不能覆盖同一区域)
  // 4. 倒序应用替换(保持偏移量稳定)
}
```

倒序应用是关键:先处理文件末尾的编辑,这样前面编辑的偏移量不会因为后面的文本变化而失效。

**模糊匹配** (`edit-diff.ts:96-133`): 先尝试精确匹配,失败后尝试:
- 行尾去空白
- 智能引号(`""`/`''`) → ASCII 引号
- Unicode 破折号 → ASCII 连字符
- 非断行空格 → 普通空格

**唯一性检查**: `countOccurrences` 确保 `oldText` 在文件中出现且仅出现一次。如果出现多次,返回错误提示 LLM 提供更多上下文。

**行尾符保护** (`edit-diff.ts:11-25`):
```typescript
export function detectLineEnding(content: string): "\r\n" | "\n" {
  // 检测原文件的行尾风格
}
// 标准化到 LF 做匹配,写入时恢复原始行尾符
```
确保 Windows 格式(CRLF)文件被修改后不会变成 LF。

**BOM 处理**: `stripBom` 在匹配前去掉 UTF-8 BOM,写入时恢复,因为 LLM 的 `oldText` 不会包含不可见的 BOM 字符。

**预览 diff**:在 TUI 中,当 `argsComplete` 时(参数流式传输完毕),`renderCall` 会调用 `computeEditsDiff` 预计算 diff 并渲染,让用户在工具实际执行前看到将要发生的变化。

**`prepareArguments` 兼容 shim** (`edit.ts:90-114`):
```typescript
// 某些模型(如 Opus 4.6, GLM-5.1)把 edits 序列化为 JSON 字符串
if (typeof args.edits === "string") {
  try {
    const parsed = JSON.parse(args.edits);
    if (Array.isArray(parsed)) args.edits = parsed;
  } catch {}
}
// 旧版单次 edit 格式兼容(oldText/newText 顶级字段)
if (typeof legacy.oldText === "string" && typeof legacy.newText === "string") {
  edits.push({ oldText: legacy.oldText, newText: legacy.newText });
}
```

### 8.3.5 `find`:文件路径搜索

**文件**: `core/tools/find.ts`

**Schema**:
```typescript
const findSchema = Type.Object({
  pattern: Type.String({ description: "Glob pattern, e.g. '*.ts', '**/*.json'" }),
  path: Type.Optional(Type.String({ description: "Directory to search (default: cwd)" })),
  limit: Type.Optional(Type.Number({ description: "Max results (default: 1000)" })),
});
```

**依赖 `fd`**: 优先使用 [`fd`](https://github.com/sharkdp/fd) 命令行工具,通过 `ensureTool("fd", true)` 获取路径(如果未安装则自动下载到 pi 的缓存目录)。

**`.gitignore` 兼容**: `fd --no-require-git` 参数在非 git 目录也启用 `.gitignore` 语义层叠。`--hidden` 显示隐藏文件(LLM 经常需要读 `.env`、`.gitignore` 等)。

**路径模式处理** (`find.ts:239-249`):
```typescript
// fd --glob 默认只匹配 basename
// 如果 pattern 包含 /,切换到 --full-path 模式
if (pattern.includes("/")) {
  args.push("--full-path");
  // 非 / 或 **/ 开头的路径模式前加 **/
  if (!pattern.startsWith("/") && !pattern.startsWith("**/")) {
    effectivePattern = `**/${pattern}`;
  }
}
```

**`FindOperations` 接口**: 提供 `exists` 和 `glob` 抽象,允许扩展提供自定义文件搜索后端(如搜索远程文件系统)。当 `customOps?.glob` 存在时跳过 fd,使用自定义实现。

### 8.3.6 `grep`:正则内容搜索

**文件**: `core/tools/grep.ts`

**Schema**:
```typescript
const grepSchema = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal)" }),
  path: Type.Optional(Type.String({ description: "Directory or file" })),
  glob: Type.Optional(Type.String({ description: "File filter, e.g. '*.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean()),
  literal: Type.Optional(Type.Boolean({ description: "Treat as literal string" })),
  context: Type.Optional(Type.Number({ description: "Lines before/after match" })),
  limit: Type.Optional(Type.Number({ description: "Max matches (default: 100)" })),
});
```

**依赖 `ripgrep`(rg)**: 通过 `ensureTool("rg", true)` 获取。ripgrep 原生支持 `.gitignore`、`--hidden`、正则、字面量模式。

**JSON 输出解析**: 使用 `rg --json` 格式,逐行解析 match 事件提取文件路径和行号,然后读取原文件获取上下文行。这样:
1. 允许 context 行数(`-A/-B`)在工具层实现,而不依赖 rg 的 `-C` 参数
2. 允许自定义 `readFile` 操作(用于远端文件系统)
3. 可以对每行应用 `truncateLine` 截断超长行

**匹配数限制**: 到达 limit 后立即 kill rg 进程,而不等待其扫描完毕。已收集的 matches 继续格式化。

**二进制文件**:ripgrep 默认跳过二进制文件,工具不需要额外处理。

**单行截断** (`truncate.ts:257-264`):
```typescript
export function truncateLine(line: string, maxChars = 500): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
```
长行(minified JS、base64 数据)截断到 500 字符,避免撑爆 LLM context window。

### 8.3.7 `ls`:目录列表

**文件**: `core/tools/ls.ts`

**Schema**:
```typescript
const lsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory (default: cwd)" })),
  limit: Type.Optional(Type.Number({ description: "Max entries (default: 500)" })),
});
```

`ls` 是最简单的工具:读取目录条目,按字母顺序排序(大小写不敏感),目录名加 `/` 后缀,包含隐藏文件。输出截断到 500 条或 50KB。

**`LsOperations` 接口**: `exists`、`stat`、`readdir` 三个操作可被替换,同样支持远端文件系统。

---

## 8.4 辅助工具模块

### 8.4.1 `file-mutation-queue.ts`:并发写保护

```typescript
// file-mutation-queue.ts:19-39
const fileMutationQueues = new Map<string, Promise<void>>();

export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = getMutationQueueKey(filePath);   // realpathSync 规范化路径(处理符号链接)
  const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
  // 链式 promise:当前队列完成后才执行 fn
  // fn 完成后释放下一个等待者
}
```

**为什么用 Promise 链而不是 Mutex?**
JavaScript 是单线程的,只有异步操作才会产生并发问题。Promise 链天然适合这个场景:每次 `withFileMutationQueue` 调用都在队列末尾追加一个新的 Promise,确保 FIFO 顺序执行。

不同文件的操作仍然并发:Map 的键是文件路径,每个文件有独立的队列。

**使用者**: `write.ts:203` 和 `edit.ts:313` 都用 `withFileMutationQueue` 包装写操作。

### 8.4.2 `path-utils.ts`:路径解析

```typescript
// path-utils.ts:39-48
export function expandPath(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
  if (normalized === "~") return os.homedir();
  if (normalized.startsWith("~/")) return os.homedir() + normalized.slice(1);
  return normalized;
}

export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (isAbsolute(expanded)) return expanded;
  return resolvePath(cwd, expanded);
}
```

`resolveReadPath`(`path-utils.ts:62-94`)额外处理 macOS 文件名的几种变体,用于 `read` 工具。其他工具使用更简单的 `resolveToCwd`。

### 8.4.3 `output-accumulator.ts`:流式输出聚合

`OutputAccumulator` 解决了 bash 工具需要同时满足的两个冲突需求:
- **实时 TUI 预览**: 需要随时能拿到当前输出的可读快照
- **超限保存全量日志**: 超过阈值时需要把完整输出写到临时文件

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="OutputAccumulator 两路径：append 写入与 snapshot 快照">
  <defs>
    <marker id="arR81" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">OutputAccumulator 流式聚合</text>
  <rect x="60" y="36" width="160" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="140" y="56" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">append(Buffer)</text>
  <line x1="140" y1="66" x2="140" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR81)"/>
  <rect x="30" y="88" width="220" height="56" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="140" y="106" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">appendDecodedText()</text>
  <text x="140" y="122" text-anchor="middle" font-size="10" fill="#64748b">维护 tailText 滑动窗口（2x maxBytes）</text>
  <text x="140" y="136" text-anchor="middle" font-size="10" fill="#64748b">计数换行 → totalLines / totalDecodedBytes</text>
  <line x1="140" y1="144" x2="140" y2="164" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR81)"/>
  <rect x="30" y="166" width="220" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="140" y="184" text-anchor="middle" font-size="11" fill="#64748b">shouldUseTempFile()?</text>
  <text x="140" y="198" text-anchor="middle" font-size="10" fill="#94a3b8">超过写入阈值时</text>
  <line x1="250" y1="186" x2="310" y2="186" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR81)"/>
  <text x="278" y="180" text-anchor="middle" font-size="10" fill="#64748b">Yes</text>
  <rect x="312" y="166" width="220" height="40" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="422" y="184" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">ensureTempFile()</text>
  <text x="422" y="198" text-anchor="middle" font-size="10" fill="#64748b">惰性创建 + tempFileStream.write(data)</text>
  <rect x="540" y="36" width="180" height="30" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="630" y="56" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">snapshot()</text>
  <line x1="630" y1="66" x2="630" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR81)"/>
  <rect x="510" y="88" width="240" height="40" rx="6" fill="#f1f5f9" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="630" y="106" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">truncateTail(tailText)</text>
  <text x="630" y="122" text-anchor="middle" font-size="10" fill="#64748b">从滑动窗口截取最后 N 行/KB</text>
  <line x1="630" y1="128" x2="630" y2="148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR81)"/>
  <rect x="490" y="150" width="280" height="50" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="630" y="170" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">OutputSnapshot</text>
  <text x="630" y="186" text-anchor="middle" font-size="10" fill="#64748b">{ content, truncation, fullOutputPath? }</text>
  <line x1="630" y1="200" x2="630" y2="220" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <text x="630" y="235" text-anchor="middle" font-size="10" fill="#94a3b8">fullOutputPath 仅超限时非空</text>
  <rect x="30" y="256" width="700" height="46" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="380" y="274" text-anchor="middle" font-size="10" fill="#64748b">finish() 后不可追加 ｜ trimTail() 对齐 UTF-8 字符边界 ｜ 惰性临时文件避免短命令磁盘 IO</text>
  <text x="380" y="292" text-anchor="middle" font-size="10" fill="#94a3b8">append 路径维护内存窗口 ↔ snapshot 路径消费内存窗口产出只读快照</text>
</svg>
<span class="figure-caption">图 R8.1 ｜ OutputAccumulator 两路径——append 写入维护滑动窗口，snapshot 消费窗口产出只读快照</span>

<details>
<summary>ASCII 原版</summary>

```
append(Buffer)
  │
  ├─ appendDecodedText()     <- 维护 tailText(滑动窗口,最多 2x maxBytes)
  │   ├─ 计数换行符 → totalLines
  │   └─ 记录解码字节数 → totalDecodedBytes
  │
  └─ shouldUseTempFile()?
      → Yes: ensureTempFile()  <- 惰性创建临时文件
             tempFileStream.write(data)

snapshot()
  └─ truncateTail(tailText)   <- 从滑动窗口截取最后 N 行/KB
      → OutputSnapshot { content, truncation, fullOutputPath? }
```

</details>

关键设计:
- **滑动窗口 `tailText`**: 在内存中只保留最近 `2x maxBytes` 的解码文本,`trimTail()` 在边界对齐 UTF-8 字符边界
- **惰性临时文件**: 只有在确认输出超限时才创建临时文件,避免为短命令分配磁盘 IO
- **`finish()` 后不可追加**: 工具执行完毕调用 `finish()`,之后的 `snapshot()` 是最终结果

### 8.4.4 `truncate.ts`:截断策略

两个主要函数:

| 函数 | 方向 | 适用场景 | 策略 |
|------|------|---------|------|
| `truncateHead` | 保留开头 | `read`(想看文件开头)、`find`/`grep`/`ls` | 顺序遍历行,满则停 |
| `truncateTail` | 保留结尾 | `bash`(想看命令输出末尾) | 从末尾反向遍历 |

两个维度的限制取最先触发:
- 默认行限 `DEFAULT_MAX_LINES = 2000`
- 默认字节限 `DEFAULT_MAX_BYTES = 50 * 1024`(50KB)

`TruncationResult` 携带丰富的元信息(`totalLines`、`outputLines`、`truncatedBy`等),让工具可以在输出中附加精确的"已截断,继续用 offset=N"提示。

### 8.4.5 `render-utils.ts`:输出渲染工具函数

```typescript
// render-utils.ts
shortenPath(path)   <- ~/... 缩写
str(value)          <- 类型安全转 string(null=非 string 类型,""=空)
replaceTabs(text)   <- \t 替换为 3 空格(等宽字体对齐)
getTextOutput(result, showImages)  <- 从 content 数组提取文本,图片降级为文字占位
invalidArgText(theme)  <- "[invalid arg]" 错误提示
```

`getTextOutput` 中 `sanitizeBinaryOutput(stripAnsi(...))` 去掉 ANSI 转义码,防止工具输出污染 TUI 渲染。

---

## 8.5 工具注册流程

`AgentSession._buildRuntime()` 在构造函数中调用,完成工具注册。关键路径(`agent-session.ts` 中的 `_buildRuntime`):

<svg viewBox="0 0 760 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="_buildRuntime 工具注册流程：从工具定义到 system prompt">
  <defs>
    <marker id="arR82" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">_buildRuntime 工具注册流程</text>
  <rect x="200" y="34" width="360" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="50" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">_buildRuntime({ activeToolNames, includeAllExtensionTools })</text>
  <text x="380" y="62" text-anchor="middle" font-size="10" fill="#64748b">agent-session.ts</text>
  <line x1="380" y1="66" x2="380" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR82)"/>
  <rect x="80" y="88" width="260" height="46" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="210" y="106" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">createAllToolDefinitions(cwd, options)</text>
  <text x="210" y="120" text-anchor="middle" font-size="10" fill="#64748b">创建 7 个 ToolDefinition（tools/index.ts:156-166）</text>
  <text x="210" y="132" text-anchor="middle" font-size="10" fill="#64748b">每个绑定当前 cwd</text>
  <rect x="400" y="88" width="270" height="46" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="535" y="106" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">resourceLoader.getExtensions()</text>
  <text x="535" y="120" text-anchor="middle" font-size="10" fill="#64748b">extensionTools: Map&lt;name, RegisteredTool&gt;</text>
  <text x="535" y="132" text-anchor="middle" font-size="10" fill="#94a3b8">扩展注册的工具</text>
  <line x1="210" y1="134" x2="380" y2="160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR82)"/>
  <line x1="535" y1="134" x2="380" y2="160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR82)"/>
  <rect x="160" y="162" width="440" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="178" text-anchor="middle" font-size="11" fill="#64748b">合并工具列表</text>
  <text x="380" y="194" text-anchor="middle" font-size="10" fill="#94a3b8">_baseToolDefinitions + _toolDefinitions (Map)</text>
  <line x1="380" y1="202" x2="380" y2="222" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR82)"/>
  <rect x="160" y="224" width="440" height="30" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="244" text-anchor="middle" font-size="11" fill="#64748b">allowedToolNames 过滤（--tools 参数）</text>
  <line x1="380" y1="254" x2="380" y2="274" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR82)"/>
  <rect x="160" y="276" width="440" height="30" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="296" text-anchor="middle" font-size="11" fill="#64748b">activeToolNames 过滤（默认 read / bash / edit / write）</text>
  <line x1="380" y1="306" x2="380" y2="326" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR82)"/>
  <rect x="160" y="328" width="440" height="38" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="346" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">wrapToolDefinition(definition, ctxFactory)</text>
  <text x="380" y="360" text-anchor="middle" font-size="10" fill="#64748b">激活工具 → AgentTool[]  ；  agent.state.tools = wrappedTools</text>
  <line x1="380" y1="366" x2="380" y2="386" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR82)"/>
  <rect x="160" y="388" width="440" height="46" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="406" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">buildSystemPrompt({ activeToolNames, … })</text>
  <text x="380" y="420" text-anchor="middle" font-size="10" fill="#64748b">promptSnippet → "Available Tools" 节</text>
  <text x="380" y="434" text-anchor="middle" font-size="10" fill="#64748b">promptGuidelines → "Guidelines" 节</text>
</svg>
<span class="figure-caption">图 R8.2 ｜ _buildRuntime 工具注册流程——从工厂函数、扩展合并、两级过滤到 system prompt 写入</span>

<details>
<summary>ASCII 原版</summary>

```
_buildRuntime({ activeToolNames, includeAllExtensionTools })
  │
  ├─ createAllToolDefinitions(cwd, toolsOptions)    <- tools/index.ts:156-166
  │   → 创建 7 个 ToolDefinition 对象
  │   → 每个 ToolDefinition 绑定当前 cwd
  │
  ├─ resourceLoader.getExtensions()
  │   → extensionTools: Map<name, RegisteredTool>   <- 扩展注册的工具
  │
  ├─ 合并工具列表
  │   → _baseToolDefinitions: Map<string, ToolDefinition>
  │   → _toolDefinitions: Map<string, ToolDefinitionEntry>
  │
  ├─ 应用 allowedToolNames 过滤(--tools 参数)
  │
  ├─ 应用 activeToolNames 过滤(默认 [read, bash, edit, write])
  │
  ├─ 将激活的工具转换为 AgentTool[]
  │   └─ wrapToolDefinition(definition, ctxFactory)
  │
  ├─ agent.state.tools = wrappedTools
  │
  └─ buildSystemPrompt({ activeToolNames, ... })
      → 将 promptSnippet 汇总到 system prompt 的 "Available Tools" 节
      → 将 promptGuidelines 追加到 "Guidelines" 节
```

</details>

**`createAllToolDefinitions`** (`tools/index.ts:156-166`):

```typescript
export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
  return {
    read:  createReadToolDefinition(cwd, options?.read),
    bash:  createBashToolDefinition(cwd, options?.bash),
    edit:  createEditToolDefinition(cwd, options?.edit),
    write: createWriteToolDefinition(cwd, options?.write),
    grep:  createGrepToolDefinition(cwd, options?.grep),
    find:  createFindToolDefinition(cwd, options?.find),
    ls:    createLsToolDefinition(cwd, options?.ls),
  };
}
```

每个工具定义都是纯函数工厂:`create*ToolDefinition(cwd)` 返回一个闭包捕获了 `cwd` 的 `ToolDefinition` 对象。`cwd` 被内嵌到 `execute` 函数体里,工具执行时无需再次查找工作目录。

**默认激活工具**: `read`、`bash`、`edit`、`write`(`sdk.ts:271`)。`grep`、`find`、`ls` 默认关闭,因为它们的功能可以通过 bash 实现,默认开启会增加 system prompt 长度。用户可通过 `--tools grep,find,ls` 启用。

---

## 8.6 TypeBox Schema 校验与 Agent Loop 反应

工具参数的 TypeBox schema 在两个层面使用:

1. **LLM 请求构建**: schema 被序列化为 JSON Schema 发给 LLM,指导 LLM 生成合法的工具调用参数。

2. **运行时校验**: `@earendil-works/pi-agent-core` 的 `Agent` 在调用工具前用 TypeBox `Value.Check` 验证参数。验证失败时,agent loop 将错误以 `tool_result(isError=true)` 形式注入对话历史,使 LLM 在下一轮修正参数重试。

**为什么 AGENTS.md 要求扩展工具必须有 schema?**

没有 schema 的工具无法生成 JSON Schema 发给 LLM,LLM 就不知道该传什么参数。更重要的是,没有 schema 意味着没有运行时校验,LLM 传入非法参数时工具会直接崩溃,而不是优雅地返回错误让 LLM 自我修正。TypeBox schema 是工具契约的形式化表达。

---

## 8.7 审批与权限:危险工具有没有拦截机制

pi 的危险工具拦截不在工具层实现,而是通过**扩展的 `tool_call` 事件**实现:

```typescript
// extensions/types.ts:771-830 (ToolCallEvent 定义)
// extensions/types.ts:984-991 (ToolCallEventResult)
export interface ToolCallEventResult {
  block?: boolean;    // 阻止执行
  reason?: string;    // 阻止原因(返回给 LLM)
}
```

任何扩展都可以订阅 `tool_call` 事件并返回 `{ block: true, reason: "..." }` 来阻止工具执行。这让权限策略完全可定制,不需要修改核心工具代码。

**`agent-session.ts`中的 `beforeToolCall` 钩子** (`agent-session.ts:395-440`):

```typescript
this.agent.beforeToolCall = async ({ toolCall, args }) => {
  const runner = this._extensionRunner;
  if (!runner.hasHandlers("tool_call")) return undefined;
  // 触发所有 tool_call 处理器
  // 如果任一返回 block:true,返回错误结果
  // args 可被处理器原地修改(参数注入/拦截)
};
```

**内置工具没有硬编码的用户确认**。如果需要白名单机制,应通过扩展实现(例如 Claude Code 本身的 permission 系统就是通过类似机制实现的)。

---

## 8.8 一次完整工具调用:从 LLM 到结果回传

以 `read("./README.md")` 为例,完整路径:

<svg viewBox="0 0 880 700" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="完整工具调用时序：从 LLM 流式响应到 tool_result 回传">
  <defs>
    <marker id="arR83" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="arR83r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/>
    </marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">一次完整工具调用：read("./README.md")</text>
  <rect x="60" y="34" width="760" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="440" y="50" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">[LLM 流式响应]</text>
  <text x="440" y="63" text-anchor="middle" font-size="10" fill="#64748b">tool_call: { name: "read", id: "tc_001", input: { path: "./README.md" } }</text>
  <line x1="440" y1="68" x2="440" y2="88" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR83)"/>
  <rect x="60" y="90" width="760" height="62" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="440" y="106" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">[pi-agent-core Agent.loop]  beforeToolCall</text>
  <text x="440" y="120" text-anchor="middle" font-size="10" fill="#64748b">extensionRunner.emit({ type: "tool_call", toolName: "read", input })</text>
  <text x="440" y="134" text-anchor="middle" font-size="10" fill="#94a3b8">block=true → 返回 isError=true 跳过执行 ｜ 修改 input → 使用修改后参数</text>
  <text x="440" y="148" text-anchor="middle" font-size="10" fill="#64748b">schema 校验（TypeBox Value.Check）→ 失败则返回 isError=true</text>
  <line x1="440" y1="152" x2="440" y2="172" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR83)"/>
  <rect x="60" y="174" width="760" height="34" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="440" y="190" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">AgentTool.execute("tc_001", { path: "./README.md" }, signal, onUpdate)</text>
  <text x="440" y="204" text-anchor="middle" font-size="10" fill="#64748b">= wrapToolDefinition 包装的函数</text>
  <line x1="440" y1="208" x2="440" y2="228" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR83)"/>
  <rect x="60" y="230" width="760" height="130" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="440" y="248" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">[read.ts execute 函数]</text>
  <rect x="80" y="255" width="340" height="30" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="250" y="268" text-anchor="middle" font-size="10" fill="#7c3aed">resolveReadPath("./README.md", cwd)</text>
  <text x="250" y="280" text-anchor="middle" font-size="10" fill="#64748b">→ "/project/README.md"（含 macOS 变体回退）</text>
  <rect x="440" y="255" width="360" height="30" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="620" y="268" text-anchor="middle" font-size="10" fill="#7c3aed">detectImageMimeType → null（非图片）</text>
  <text x="620" y="280" text-anchor="middle" font-size="10" fill="#64748b">ops.readFile → Buffer</text>
  <rect x="80" y="295" width="720" height="30" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="440" y="308" text-anchor="middle" font-size="10" fill="#7c3aed">buffer.toString("utf-8") → allLines.slice() → truncateHead(selectedContent)</text>
  <text x="440" y="320" text-anchor="middle" font-size="10" fill="#64748b">→ { content: "…(前2000行)…", truncated, totalLines: 1247, outputLines: 1247 }</text>
  <rect x="80" y="335" width="720" height="20" rx="4" fill="#ede9fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="440" y="348" text-anchor="middle" font-size="10" fill="#7c3aed">返回 { content: [{ type: "text", text: outputText }], details: undefined }</text>
  <line x1="440" y1="360" x2="440" y2="380" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR83)"/>
  <rect x="60" y="382" width="760" height="48" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="440" y="398" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">[tool_result 事件]</text>
  <text x="440" y="412" text-anchor="middle" font-size="10" fill="#64748b">extensionRunner.emit({ type: "tool_result", toolName: "read", content, isError: false })</text>
  <text x="440" y="426" text-anchor="middle" font-size="10" fill="#94a3b8">扩展可修改 content（例如插入额外上下文）</text>
  <line x1="440" y1="430" x2="440" y2="450" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR83)"/>
  <rect x="60" y="452" width="760" height="50" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
  <text x="440" y="468" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">[AgentSession._handleAgentEvent]  type: "tool_end"</text>
  <text x="440" y="482" text-anchor="middle" font-size="10" fill="#64748b">sessionManager.appendToolResult(…) → 持久化到 JSONL</text>
  <text x="440" y="496" text-anchor="middle" font-size="10" fill="#64748b">emit({ type: "tool_execution_end" }) → TUI 更新</text>
  <line x1="440" y1="502" x2="440" y2="522" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arR83)"/>
  <rect x="60" y="524" width="760" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="440" y="542" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">[LLM 收到 tool_result message]</text>
  <text x="440" y="558" text-anchor="middle" font-size="10" fill="#64748b">下一轮：LLM 分析 README.md 内容，继续回答用户问题</text>
  <rect x="60" y="580" width="760" height="100" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="440" y="598" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">关键路径说明</text>
  <text x="80" y="614" font-size="10" fill="#64748b">① beforeToolCall：扩展可 block 或改写 input，block=true 时跳过后续所有步骤</text>
  <text x="80" y="630" font-size="10" fill="#64748b">② TypeBox schema 校验：失败返回 isError=true，LLM 下一轮自我修正参数</text>
  <text x="80" y="646" font-size="10" fill="#64748b">③ tool_result 事件：扩展可追加上下文（如文件摘要），影响 LLM 下轮推理</text>
  <text x="80" y="662" font-size="10" fill="#64748b">④ appendToolResult：每次工具结果持久化到 JSONL，支持会话恢复</text>
  <text x="80" y="678" font-size="10" fill="#94a3b8">整条链路无用户阻塞——危险工具拦截由扩展 tool_call handler 负责，不硬编码在工具层</text>
</svg>
<span class="figure-caption">图 R8.3 ｜ 一次完整工具调用时序——从 LLM 流式响应经扩展拦截、schema 校验、read 执行到 tool_result 回传</span>

<details>
<summary>ASCII 原版</summary>

```
[LLM 流式响应]
  tool_call: { name: "read", id: "tc_001", input: { path: "./README.md" } }
         |
         v
[pi-agent-core Agent.loop]
  beforeToolCall({ toolCall, args })
    └─ extensionRunner.emit({ type: "tool_call", toolName: "read", input })
         → 如果 block=true: 返回 isError=true 结果,跳过执行
         → 如果修改了 input: 使用修改后的参数
         |
         v
  schema 校验 (TypeBox Value.Check)
    → 失败: { isError: true, content: [{ type:"text", text: "invalid args..." }] }
         |
         v
  AgentTool.execute("tc_001", { path: "./README.md" }, signal, onUpdate)
    = wrapToolDefinition 包装的函数
         |
         v
[read.ts execute 函数]
  resolveReadPath("./README.md", cwd)
    └─ resolveToCwd -> 绝对路径 "/project/README.md"
    └─ 文件不存在时尝试 macOS 变体
         |
         v
  ops.detectImageMimeType("/project/README.md")
    → null (不是图片)
         |
         v
  ops.readFile("/project/README.md")
    → Buffer (文件内容)
         |
         v
  buffer.toString("utf-8")
  allLines = content.split("\n")    // 1247 行
  selectedContent = allLines.slice(0).join("\n")
  truncateHead(selectedContent)
    → { content: "...(前2000行)...", truncated: true,
        totalLines: 1247, outputLines: 1247, ... }  // 假设未超限
         |
         v
  返回 { content: [{ type: "text", text: outputText }], details: undefined }
         |
         v
[tool_result 事件]
  extensionRunner.emit({ type: "tool_result", toolName: "read",
                         content, isError: false, ... })
    → 扩展可修改 content(例如插入额外上下文)
         |
         v
[AgentSession._handleAgentEvent]
  type: "tool_end"
    → sessionManager.appendToolResult(...)  <- 持久化到 JSONL
    → emit({ type: "tool_execution_end", ... })  <- TUI 更新
         |
         v
[LLM 收到 tool_result message]
  下一轮:LLM 分析 README.md 内容,继续回答用户问题
```

</details>

---

## 参考文件索引

| 文件 | 关键内容 |
|------|---------|
| `src/core/extensions/types.ts:426-473` | `ToolDefinition` 接口定义 |
| `src/core/tools/tool-definition-wrapper.ts` | `wrapToolDefinition` / `createToolDefinitionFromAgentTool` |
| `src/core/tools/index.ts:83-196` | 工具工厂函数集合,`createAllToolDefinitions` |
| `src/core/tools/bash.ts:23-441` | bash 工具完整实现 |
| `src/core/tools/read.ts:20-363` | read 工具完整实现 |
| `src/core/tools/write.ts:14-281` | write 工具完整实现 |
| `src/core/tools/edit.ts:31-489` | edit 工具完整实现 |
| `src/core/tools/edit-diff.ts:1-446` | diff 算法、模糊匹配、多编辑批处理 |
| `src/core/tools/find.ts:20-370` | find 工具(fd 后端) |
| `src/core/tools/grep.ts:23-384` | grep 工具(ripgrep 后端) |
| `src/core/tools/ls.ts:13-229` | ls 工具 |
| `src/core/tools/file-mutation-queue.ts` | 并发写保护 |
| `src/core/tools/path-utils.ts` | 路径解析(含 macOS 变体) |
| `src/core/tools/output-accumulator.ts` | 流式输出聚合 |
| `src/core/tools/truncate.ts` | head/tail 截断策略 |
| `src/core/tools/render-utils.ts` | TUI 渲染工具函数 |
