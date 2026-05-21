# Tour 步骤 01:pi 命令进入 main.ts

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:无(用户刚在 shell 中键入 `pi` 并回车)。

**下一步起点**:`appMode` 已确定为 `"interactive"`,`AgentSessionRuntime` 工厂闭包 `createRuntime` 已定义但尚未执行,auth/models/extensions 都还没加载,TUI 也还没拉起。

---

## 1. 当前情境

用户在终端按下回车的瞬间,shell 触发了 PATH 查找。此时进程尚未启动:

- `PATH` 中存在 npm 全局安装目录(例如 `~/.npm-global/bin/` 或 `/usr/local/bin/`)。
- `pi` 是该目录下的一个可执行符号链接,指向 `dist/cli.js`。
- Node.js 进程还没有任何 js 模块加载进来,`process.argv` 就是 `["node", "/path/to/dist/cli.js"]`。
- `process.stdin.isTTY` 为 `true`(用户在终端直接输入,没有管道)。
- `process.env.ANTHROPIC_API_KEY` 已设置,其他环境变量没有 `PI_OFFLINE`、`PI_CODING_AGENT` 等标志。

---

## 2. 问题

本步需要解决两个紧密相关的具体问题:

1. **如何从一个文件路径(`dist/cli.js`)走到真正执行业务逻辑的 `main()` 函数**,中间的 ESM shebang 入口层干什么、为什么要单独存在。

2. **`main()` 收到 `args = []`(无任何 CLI 参数)之后,如何判断应该进入哪种运行模式**。判断错误会导致用户看到纯文本输出流或 JSON 事件流,而不是预期的 TUI 界面。

---

## 3. 朴素思路

最直接的做法:把 shebang、全局副作用、参数解析、模式判断全部写在同一个 `index.ts` 里。`bin` 字段指向编译后的 `dist/index.js`,`main()` 函数就是模块顶层代码。

---

## 4. 为什么朴素思路会崩

**副作用污染库调用方**:如果 `main.ts` 顶层就执行了 `process.title = "pi"`、`process.emitWarning = (() => {})` 和 `configureHttpDispatcher()`，那么任何 `import { main } from "@earendil-works/pi-coding-agent"` 的第三方代码都会在 import 时立即触发这些操作。`process.emitWarning` 被静音会影响整个宿主进程,`configureHttpDispatcher()` 会替换 Node.js 全局 `fetch` 的底层 dispatcher。

**`--help` 打印时机问题**:如果参数解析和模式判断都在顶层立即执行,那么 `--help` 会在扩展加载之前输出,导致扩展自定义 flag 无法出现在帮助文本里(`main.ts:623-628` 显示 `--help` 故意延迟到 `resourceLoader.getExtensions()` 完成之后才打印)。

**Bun 入口无法复用**:项目里同时存在 `packages/coding-agent/src/bun/cli.ts` 这套 Bun 专用入口。如果 Node.js 的 shim 代码混进 `main.ts`,Bun 入口就无法简单地 `import { main }` 后直接复用。

---

## 5. pi 的做法

pi 用两层薄壳来解决上述问题:

```
dist/cli.js          <- npm bin 指向,含 shebang
    |
    | import { main }
    v
dist/main.js         <- 真正的引导逻辑,纯模块,可被第三方 import
```

**第一层:`cli.ts`(20 行)**

```typescript
// packages/coding-agent/src/cli.ts:1-20
#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = APP_NAME;                              // ps/top 显示 "pi"
process.env.PI_CODING_AGENT = "true";                  // 子进程感知自己在 pi 内部
process.emitWarning = (() => {}) as typeof process.emitWarning; // 静音 undici 警告
configureHttpDispatcher();                             // 配置全局 HTTP dispatcher
main(process.argv.slice(2));                           // 转交 main.ts
```

`configureHttpDispatcher()` 必须在所有 provider SDK import 之前调用——某些 SDK 在 import 时就初始化 HTTP 客户端,这行必须出现在 `main.ts` 的任何真正 `import` 语句执行之前。

**第二层:`main.ts` 的参数解析与模式分支**

`main()` 函数(`packages/coding-agent/src/main.ts:425`) 收到 `args = []` 后的执行路径如下:

```
main([])
 |
 +-- resetTimings()                      计时桩,用于 PI_STARTUP_BENCHMARK
 |
 +-- offlineMode = false                 args 里没有 --offline
 |
 +-- handlePackageCommand([])  → false   不是 install/remove/update 等命令
 +-- handleConfigCommand([])   → false   不是 config 命令
 |
 +-- parseArgs([])
 |     -> Args {
 |          messages: [],
 |          fileArgs: [],
 |          unknownFlags: Map {},
 |          diagnostics: [],
 |          // 所有 boolean flag 均 undefined
 |        }
 |
 +-- resolveAppMode(parsed, process.stdin.isTTY=true)
       parsed.mode    = undefined  -> 不是 "rpc"
       parsed.mode    = undefined  -> 不是 "json"
       parsed.print   = undefined  -> 不是 print
       !stdinIsTTY    = false      -> 不是 pipe
       -> return "interactive"          ✓ 进入 TUI 模式
```

**`parseArgs` 的两阶段设计**(`packages/coding-agent/src/cli/args.ts:59-189`):

`parseArgs` 是手写单遍扫描器,不使用 `commander` / `yargs`。对于以 `--` 开头但不在已知列表中的参数,不是报错退出,而是写入 `unknownFlags: Map<string, boolean | string>`。这是为了支持扩展自定义 flag:扩展在 `createAgentSessionServices` 之后才加载,无法在 `parseArgs` 时预知其 flag 列表;先收集、后验证的两阶段模式避免了循环依赖。

**`resolveAppMode` 的优先级顺序**(`packages/coding-agent/src/main.ts:100-111`):

```typescript
function resolveAppMode(parsed: Args, stdinIsTTY: boolean): AppMode {
  if (parsed.mode === "rpc")          return "rpc";       // --mode rpc
  if (parsed.mode === "json")         return "json";      // --mode json
  if (parsed.print || !stdinIsTTY)    return "print";     // --print 或 pipe
  return "interactive";                                   // 默认
}
```

`!stdinIsTTY` 这个条件意味着 `echo "fix the bug" | pi` 会自动进入 print 模式,不会尝试启动 TUI——TUI 需要控制终端的原始输入模式,而 stdin 已被管道占用时这是不可能的。

<svg viewBox="0 0 760 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="CLI 启动时序:从 shell 到 appMode=interactive">
  <defs>
    <marker id="arT1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="540" fill="#f8fafc" rx="6"/>
  <text x="380" y="28" text-anchor="middle" font-size="14" font-weight="600" fill="#1e293b">CLI 启动时序:shell → appMode</text>
  <rect x="270" y="48" width="220" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="70" text-anchor="middle" font-size="12" fill="#9a3412">shell: $ pi</text>
  <line x1="380" y1="84" x2="380" y2="112" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT1)"/>
  <text x="390" y="102" font-size="10" fill="#64748b">PATH 查找</text>
  <rect x="210" y="112" width="340" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="134" text-anchor="middle" font-size="11" fill="#334155">~/.npm-global/bin/pi  (symlink)</text>
  <line x1="380" y1="148" x2="380" y2="176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT1)"/>
  <text x="390" y="165" font-size="10" fill="#64748b">→ dist/cli.js  (shebang: #!/usr/bin/env node)</text>
  <rect x="180" y="176" width="400" height="50" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="380" y="196" text-anchor="middle" font-size="12" fill="#4c1d95">cli.ts</text>
  <text x="380" y="214" text-anchor="middle" font-size="10" fill="#6d28d9">全局副作用 + configureHttpDispatcher()</text>
  <line x1="380" y1="226" x2="380" y2="254" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT1)"/>
  <text x="390" y="243" font-size="10" fill="#64748b">main(argv.slice(2))  argv.slice(2) = []</text>
  <rect x="180" y="254" width="400" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="380" y="276" text-anchor="middle" font-size="12" fill="#4c1d95">main.ts: main([])</text>
  <line x1="380" y1="290" x2="380" y2="316" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT1)"/>
  <rect x="90" y="316" width="580" height="110" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="336" text-anchor="middle" font-size="11" font-weight="600" fill="#475569">parseArgs([]) → resolveAppMode(parsed, isTTY=true)</text>
  <rect x="110" y="344" width="220" height="28" rx="4" fill="white" stroke="#cbd5e1"/>
  <text x="220" y="362" text-anchor="middle" font-size="10" fill="#64748b">handlePackageCommand → false</text>
  <rect x="340" y="344" width="220" height="28" rx="4" fill="white" stroke="#cbd5e1"/>
  <text x="450" y="362" text-anchor="middle" font-size="10" fill="#64748b">handleConfigCommand → false</text>
  <text x="110" y="395" font-size="10" fill="#64748b">parsed.mode?  no  |  parsed.print?  no  |  !isTTY?  no</text>
  <text x="380" y="416" text-anchor="middle" font-size="10" fill="#0d9488">→ return "interactive"  ✓</text>
  <line x1="380" y1="426" x2="380" y2="454" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT1)"/>
  <rect x="230" y="454" width="300" height="44" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="472" text-anchor="middle" font-size="13" font-weight="600" fill="#134e4a">appMode = "interactive"</text>
  <text x="380" y="490" text-anchor="middle" font-size="10" fill="#0f766e">← 本步结束</text>
</svg>
<span class="figure-caption">图 T1.1 ｜ shell 键入 `pi` 到确定 appMode="interactive" 的完整调用链</span>

<details>
<summary>ASCII 原版</summary>

```
  shell: $ pi
      |
      | PATH 查找
      v
  ~/.npm-global/bin/pi  (symlink)
      |
      | -> dist/cli.js  (shebang: #!/usr/bin/env node)
      v
  cli.ts: 全局副作用 + configureHttpDispatcher()
      |
      | main(argv.slice(2))  argv.slice(2) = []
      v
  main.ts: main([])
      |
      +--[handlePackageCommand] false
      +--[handleConfigCommand]  false
      |
      +--[parseArgs([])]
      |    -> Args { messages:[], ... }
      |
      +--[resolveAppMode(parsed, isTTY=true)]
           parsed.mode? no
           parsed.print? no
           !isTTY? no
           -> "interactive"
      |
      v
  appMode = "interactive"    <-- 本步结束
```

</details>

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/coding-agent/package.json` | 9-11 | `bin` 字段:`"pi": "dist/cli.js"` |
| `packages/coding-agent/src/cli.ts` | 1-20 | ESM 入口:shebang、全局副作用、`configureHttpDispatcher()`、`main()` 调用 |
| `packages/coding-agent/src/core/http-dispatcher.ts` | (全文) | undici 全局 dispatcher 配置 |
| `packages/coding-agent/src/main.ts` | 98 | `type AppMode` 定义 |
| `packages/coding-agent/src/main.ts` | 100-111 | `resolveAppMode()` 函数 |
| `packages/coding-agent/src/main.ts` | 425-456 | `main()` 函数前段:resetTimings、packageCommand、configCommand、parseArgs、resolveAppMode |
| `packages/coding-agent/src/cli/args.ts` | 12-51 | `Args` 接口定义 |
| `packages/coding-agent/src/cli/args.ts` | 59-189 | `parseArgs()` 单遍扫描实现 |
| `packages/coding-agent/src/bun/cli.ts` | (全文) | Bun 入口,与 Node.js cli.ts 并行复用同一 `main.ts` |

---

## 7. 分支与延伸

- **`cli.ts` 两层薄壳的详细工程理由**:见 [第 07 章 §7.1「两层薄壳:为什么 `cli.ts` 只有 21 行」](./07-coding-agent-cli-startup.md#71-两层薄壳为什么-clits-只有-21-行)。

- **`main.ts` 引导链完整时序图**:见 [第 07 章 §7.2「`main.ts` 引导链」](./07-coding-agent-cli-startup.md#72-maints-引导链)。

- **`parseArgs` 两阶段设计的完整说明**:见 [第 07 章 §7.3「参数解析:`parseArgs` 的设计原则」](./07-coding-agent-cli-startup.md#73-参数解析parseargs-的设计原则)。

- **四种运行模式(`interactive`/`print`/`json`/`rpc`)的具体行为差异**:见 [第 01 章 §1.6「四种运行模式」](./01-architecture-overview.md#16-四种运行模式)。

- **`bin` 字段与 shebang 的 npm 全局安装机制**:见 [第 01 章 §1.5.1「`bin` 字段与 shebang」](./01-architecture-overview.md#151-bin-字段与-shebang)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **`cli.ts` 是进程级副作用的隔离屏**:把 `process.title`、`process.emitWarning` 静音、`configureHttpDispatcher()` 这三个只能执行一次且不应污染库调用方的操作收在 `cli.ts` 里,`main.ts` 保持纯函数语义,可被 `import { main }` 直接调用或在测试中调用,也可被 Bun 入口复用。

2. **`parseArgs` 故意不拒绝未知 flag**:未知 `--xxx` 存入 `unknownFlags: Map`,等扩展加载后二次验证。这是"先收集后验证"的两阶段模式,解决了参数解析时扩展还没加载的鸡生蛋问题。如果你在调试时看到 `unknownFlags` 里有内容,说明某个扩展 flag 正在等待处理。

3. **`!stdinIsTTY` 是 print 模式的隐式触发器**:当 stdin 不是终端时,`resolveAppMode` 会返回 `"print"` 而不是 `"interactive"`。这意味着 `echo "xxx" | pi` 和 `pi --print "xxx"` 行为完全等价,不会尝试启动 TUI。

4. **`appMode = "interactive"` 是本步的唯一关键输出**:后续所有步骤(AgentSessionRuntime 装配、TUI 启动)都依赖这个判断。如果这一步判断错了(例如误判为 `"print"`),进程会用纯文本模式运行,没有 TUI,也不会等待多轮输入。

5. **`handlePackageCommand` 和 `handleConfigCommand` 是早期返回路径**:如果用户运行的是 `pi install` 或 `pi config`,这两个函数会处理完毕后直接 `return`,整个 runtime 装配流程不会发生。能验证这一点的方式:在 `main.ts:437` 处打断点并运行 `pi install`,会发现进程在这里退出,不会到达 `resolveAppMode`。
