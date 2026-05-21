# Tour 步骤 13:agent-loop 执行 read 工具

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:agent-loop 持有 `PreparedToolCall { kind:"prepared", toolCall:{name:"read", arguments:{path:"README.md"}}, tool:<read AgentTool>, args:{path:"README.md"} }`,即将进入 `executePreparedToolCall`。

**下一步起点**:`ToolResultMessage { role:"toolResult", toolCallId:"toulu_01...", toolName:"read", content:[{type:"text", text:"<行号格式化的 README 内容>"}], isError:false }` 已发射。agent-loop 将此消息追加到 `context.messages`,准备发起第二次 `ai.stream()` 调用。

---

## 1. 当前情境

`executePreparedToolCall`(`agent-loop.ts:628-663`)收到 `PreparedToolCall` 后,调用:

```typescript
const result = await prepared.tool.execute(
    prepared.toolCall.id,
    prepared.args as never,
    signal,
    (partialResult) => { /* onUpdate callback */ },
);
// agent-loop.ts:636-653
```

`prepared.tool` 是 `createReadTool(cwd)` 返回的 `AgentTool`(`read.ts:361-363`)。`prepared.args` 已经通过 TypeBox 校验,类型为 `{ path: string; offset?: number; limit?: number }`。本次 trace:`path="README.md"`,`offset`/`limit` 均为 `undefined`。

---

## 2. 问题

本步需要回答五个具体问题:

1. **`resolveReadPath` 如何把 `"README.md"` 变成绝对路径**——相对路径必须相对于进程 cwd,而非某个固定目录。

2. **`fs.readFile` 后如何应用 offset/limit 并格式化行号**——本次 trace 没有指定 offset/limit,但代码路径要走完。

3. **大文件截断保护在哪里触发,截断后模型看到什么**——`truncateHead` 的两个独立限制:行数和字节数。

4. **read 工具为什么不需要 `beforeToolCall` 拦截和 `file-mutation-queue`**——只读操作无副作用,无并发写风险。

5. **InteractiveMode 如何在工具执行期间更新 UI**——`tool_execution_start` 和 `tool_execution_end` 事件被订阅链捕获,渲染 "Reading README.md..." 行。

---

## 3. 朴素思路

直接 `fs.readFileSync(path, "utf-8")`,把结果字符串包装为 `ToolResultMessage`。简洁,同步,无异步复杂性。

---

## 4. 为什么朴素思路会崩

**同步 I/O 阻塞事件循环**:Node.js 单线程,`readFileSync` 在文件 I/O 期间挂起整个进程。对于大文件(几十 MB 的日志)这会让 TUI 完全无响应。

**无法响应 AbortSignal**:用户在文件读取中途按 Escape,同步调用无法中断。`read.ts` 的 execute 实现注册了 `signal.addEventListener("abort", onAbort)`(`read.ts:236-238`),异步路径可以在任意等待点检查 `aborted` 标志。

**无截断保护**:模型的上下文窗口有限,几十 MB 的文件直接塞入会超出 token 限制,导致请求失败。

---

## 5. pi 的做法

### 5.1 路径解析:`resolveReadPath`

`read.ts:226`:

```typescript
const absolutePath = resolveReadPath(path, cwd);
```

`resolveReadPath`(`path-utils.ts:62-94`)的处理流程:

```
"README.md"
    |
    | expandPath()          path-utils.ts:39-48
    |   去除 @ 前缀,展开 ~/,规范化 Unicode 空格
    v
"README.md"  (无变化)
    |
    | resolveToCwd("README.md", cwd)   path-utils.ts:54-60
    |   !isAbsolute -> resolvePath(cwd, "README.md")
    v
"/Users/xgliu/git/pi/README.md"
    |
    | fileExists(resolved)?  -> true (文件存在)
    v
返回 "/Users/xgliu/git/pi/README.md"
```

若 `fileExists` 返回 `false`,`resolveReadPath` 依次尝试四种 macOS 路径变体:AM/PM 格式(截图文件名)、NFD 编码(macOS 文件系统存储格式)、弯引号(`'` → `'`)、NFD+弯引号组合(`path-utils.ts:69-93`)。本次 trace 直接命中第一次 `fileExists` 检查。

### 5.2 权限检查

```typescript
await ops.access(absolutePath);   // read.ts:243
```

`ops.access` 默认为 `fsAccess(path, constants.R_OK)`(`read.ts:53-54`)。若文件不可读(权限拒绝或不存在),`access` 抛出异常,execute 的 `catch` 块在 `read.ts:335-339` 调用 `reject(error)`,最终 agent-loop 在 `executePreparedToolCall:656-660` 捕获异常并包装为错误 `ToolResultMessage`。

### 5.3 文本读取、offset/limit、行号格式化

```typescript
const buffer = await ops.readFile(absolutePath);   // read.ts:280
const textContent = buffer.toString("utf-8");
const allLines = textContent.split("\n");
const totalFileLines = allLines.length;
```

**offset 处理**(`read.ts:285-290`):offset 是 1-indexed,转换为 0-indexed:`startLine = offset ? Math.max(0, offset-1) : 0`。本次 trace `offset === undefined`,`startLine = 0`,从头读取。

**limit 处理**(`read.ts:294-300`):若指定 `limit`,`selectedContent = allLines.slice(startLine, startLine+limit).join("\n")`;否则 `selectedContent = allLines.slice(startLine).join("\n")`。本次 trace 读全文。

**注意**:行号前缀格式化由**渲染层**(`renderResult`)完成,execute 返回的 `content[0].text` 是原始文本内容,不含行号。若需要行号格式,调用方在 UI 渲染时添加。

### 5.4 大文件截断保护:`truncateHead`

```typescript
const truncation = truncateHead(selectedContent);   // read.ts:302
```

`truncateHead`(`truncate.ts:67-149`)有两个独立硬限制,取先触发者:

| 限制 | 默认值 | 常量 |
|------|--------|------|
| 行数 | 2000 行 | `DEFAULT_MAX_LINES` |
| 字节数 | 50 KB | `DEFAULT_MAX_BYTES` |

**三种结果分支**(`read.ts:303-328`):

- **`firstLineExceedsLimit`**:第一行本身就超过 50KB(如 minified JS)。返回文本提示 `[Line N is Xkb, exceeds 50.0KB limit. Use bash: sed -n 'Np' path | head -c 51200]`(`read.ts:307`),引导模型用 bash 工具读取。
- **`truncation.truncated`**:内容被截断。在 `truncation.content` 末尾追加续读提示:`[Showing lines 1-2000 of 5000. Use offset=2001 to continue.]`(`read.ts:314-318`)。
- **未截断**:直接使用 `truncation.content`(`read.ts:326`)。

本次 trace `README.md` 是普通小文件,不触发截断,直接走第三条分支。

### 5.5 结果包装

```typescript
content = [{ type: "text", text: outputText }];   // read.ts:329
resolve({ content, details });                     // read.ts:334
```

execute 返回 `{ content, details: { truncation? } }`,类型为 `AgentToolResult<ReadToolDetails>`。

agent-loop 在 `executePreparedToolCall`(`agent-loop.ts:654`) 收到 result 后,经 `finalizeExecutedToolCall`(`agent-loop.ts:665-708`)调用 `config.afterToolCall`(coding-agent 可选注入),再由 `createToolResultMessage`(`agent-loop.ts:727-737`)包装:

```typescript
return {
    role: "toolResult",
    toolCallId: finalized.toolCall.id,
    toolName: "read",
    content: [{ type:"text", text:"<README 内容>" }],
    details: { truncation: null },
    isError: false,
    timestamp: Date.now(),
};
```

### 5.6 read 工具不走 file-mutation-queue

`file-mutation-queue.ts` 是 write/edit/bash 等**写操作**的并发保护机制(保证同一文件不被并发写入)。`read.ts` 不引用 `file-mutation-queue`——只读操作无需写锁,也不会修改文件系统状态。

### 5.7 InteractiveMode 的 UI 更新

agent-loop 的 `emit` 是 `AgentEventSink`,`InteractiveMode` 通过 `AgentSession.subscribe()` 订阅到 `AgentEvent`。相关事件链:

```
agent-loop emit tool_execution_start  -->  AgentSession onAgentEvent
    -->  InteractiveMode onAgentEvent()
    -->  ToolsComponent.addToolCall()   "Reading README.md..." 行出现

(read.ts execute 运行中,文件 I/O...)

agent-loop emit tool_execution_end    -->  InteractiveMode onAgentEvent()
    -->  ToolsComponent.updateToolCall() 状态从 "in_progress" 改为 "done"
                                         "Reading README.md..." 行显示对勾标志
```

read 工具的 `execute` 没有调用 `onUpdate` callback(`_onUpdate?` 参数在 `read.ts:221` 被忽略),因此不会发射 `tool_execution_update` 事件——文件读取是一次性操作,不需要进度更新。

### 5.8 执行路径 ASCII 图

```
executePreparedToolCall(prepared)
  |
  | prepared.tool.execute(id, {path:"README.md"}, signal, onUpdate)
  v
read.ts execute()
  |
  +-- resolveReadPath("README.md", cwd)
  |     resolveToCwd -> "/path/to/README.md"
  |     fileExists?  -> true
  |     返回绝对路径
  |
  +-- ops.access(absolutePath)   <- fs.access(R_OK)
  |     OK (文件可读)
  |
  +-- ops.detectImageMimeType()  <- 检测是否为图片
  |     null (README.md 是文本文件)
  |
  +-- ops.readFile(absolutePath) <- fs.readFile
  |     返回 Buffer
  |
  +-- textContent = buffer.toString("utf-8")
  +-- allLines = textContent.split("\n")
  +-- offset=undefined -> startLine=0
  +-- limit=undefined  -> selectedContent = allLines.slice(0).join("\n")
  |
  +-- truncateHead(selectedContent)
  |     totalLines <= 2000 && totalBytes <= 50KB?  -> true (无截断)
  |     返回 { truncated:false, content:selectedContent, ... }
  |
  +-- outputText = truncation.content  (原文)
  +-- content = [{ type:"text", text:outputText }]
  +-- resolve({ content, details:undefined })

executePreparedToolCall 收到 { result, isError:false }
  |
finalizeExecutedToolCall()  (afterToolCall 钩子,本例不修改)
  |
emitToolExecutionEnd()  -->  emit tool_execution_end
  |
createToolResultMessage()  -->  ToolResultMessage { role:"toolResult", ... }
  |
emitToolResultMessage()  -->  emit message_start + message_end
```

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/coding-agent/src/core/tools/read.ts` | 20-24 | `readSchema` TypeBox 定义 |
| `packages/coding-agent/src/core/tools/read.ts` | 219-339 | `execute` 实现:路径解析、权限检查、读取、截断、包装 |
| `packages/coding-agent/src/core/tools/read.ts` | 226 | `resolveReadPath(path, cwd)` 调用 |
| `packages/coding-agent/src/core/tools/read.ts` | 243 | `ops.access(absolutePath)` 权限检查 |
| `packages/coding-agent/src/core/tools/read.ts` | 280-329 | 文本读取、offset/limit、truncateHead、分支 |
| `packages/coding-agent/src/core/tools/path-utils.ts` | 39-48 | `expandPath`:@ 前缀、~ 展开、Unicode 规范化 |
| `packages/coding-agent/src/core/tools/path-utils.ts` | 54-60 | `resolveToCwd`:绝对/相对路径处理 |
| `packages/coding-agent/src/core/tools/path-utils.ts` | 62-94 | `resolveReadPath`:四种 macOS 路径变体尝试 |
| `packages/coding-agent/src/core/tools/truncate.ts` | 11-12 | `DEFAULT_MAX_LINES=2000`, `DEFAULT_MAX_BYTES=50*1024` |
| `packages/coding-agent/src/core/tools/truncate.ts` | 67-149 | `truncateHead` 实现 |
| `packages/agent/src/agent-loop.ts` | 628-663 | `executePreparedToolCall`:调用 tool.execute |
| `packages/agent/src/agent-loop.ts` | 665-708 | `finalizeExecutedToolCall`:afterToolCall 钩子 |
| `packages/agent/src/agent-loop.ts` | 727-737 | `createToolResultMessage`:包装为 ToolResultMessage |
| `packages/agent/src/agent-loop.ts` | 739-742 | `emitToolResultMessage`:emit message_start + message_end |

---

## 7. 分支与延伸

- **read 工具完整实现(含图片支持、compact 分类)**:见 [第 08 章 §8.3.2「read:文件读取」](./08-coding-agent-tools.md#832-read文件读取)。
- **`path-utils.ts` 与 `truncate.ts` 详细设计**:见 [第 08 章 §8.4「辅助工具模块」](./08-coding-agent-tools.md#84-辅助工具模块)。
- **工具调用完整状态机(prepare → execute → finalize → result → 下一轮 LLM)**:见 [第 05 章 §5「工具调用闭环」](./05-agent-runtime-loop.md#5-工具调用闭环)。
- **InteractiveMode 订阅 AgentEvent 更新工具调用 UI 的完整事件链**:见 [第 12 章 §12.4「AgentSession 事件订阅」](./12-interactive-mode.md#124-agentsession-事件订阅)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **路径解析是防御性的四步降级**:`resolveReadPath` 先做最直接的 `resolvePath(cwd, path)`,若文件不存在则依次尝试 macOS 截图特有的路径变体。这不是过度设计——macOS 文件名的 NFD/NFC 编码差异和 AM/PM 格式是真实用户痛点。

2. **截断保护的两个独立维度不可合并**:行数限制防止极长文件把上下文窗口撑爆(即使每行只有一个字节);字节限制防止单行超长的 minified 文件(即使只有一行)。两个维度必须独立检查,取先触发者。`firstLineExceedsLimit` 是第三种边界情况:第一行本身就超限,无法返回任何内容,只能给出 bash 替代方案。

3. **read 工具的 execute 不产生 `tool_execution_update` 事件**:`onUpdate` callback 在 `read.ts:221` 是 `_onUpdate?`,下划线表示有意忽略。文件读取是原子操作,没有可报告的中间进度。只有 bash 工具这类流式输出的工具才会调用 `onUpdate`。

4. **工具结果的 `details` 字段是 UI 专用**:`details: { truncation? }` 不会发送给模型。它的唯一用途是让 `renderResult` 在 TUI 中显示截断警告(`read.ts:193-203`)。模型看到的是 `content[0].text`——一个含截断提示和续读说明的纯文本字符串。
