# Tour 01：敲下 `openclaw gateway` 之后

## 1. 当前情境

trace 还没真正开始。屏幕上什么都没发生。我们手上只有一件事：用户在终端里敲下了一行命令，然后回车。

```
openclaw gateway
```

操作系统找到了 `openclaw` 这个可执行文件——它指向仓库里的 `openclaw.mjs`——并用 Node.js 把它跑起来。从这一刻起，代码开始执行。我们这一步要看的，就是从「一个被启动的 Node 进程」到「确定要运行 gateway 命令」之间发生的全部事情。

整条 17 步 trace 里，gateway 进程必须先活着、并选对命令路径，后面的 WebSocket、RPC、agent 才有舞台。这一步是地基。

## 2. 问题

把一个 CLI 命令跑起来，看似只是「读 `argv`、调对应函数」。但 `openclaw.mjs` 是用户机器上的真实入口，它要在调任何业务代码之前，先确保运行环境是健全的、并且把命令准确路由到 gateway 这条路径上。问题就是:

> 在不知道用户机器上 Node 版本、安装方式、信号处理习惯的前提下，如何稳妥地从「进程启动」过渡到「gateway 命令被选中执行」？

## 3. 朴素思路

最直接的写法：入口文件顶部直接 `import` 整个 CLI，把 `process.argv` 丢给一个命令解析库（比如 Commander），让它匹配到 `gateway` 子命令然后执行。一个文件、十几行、立刻能跑。

## 4. 为什么朴素思路会崩

这个朴素思路会在好几个真实场景下具体地崩掉：

- **Node 版本太旧直接报神秘错误**。OpenClaw 用到 `Node 22.16+` 的特性。如果用户的 Node 是 18，朴素思路会在加载某个深层模块时抛出一个语法错误或「未知 API」错误，堆栈指向某个用户根本没听说过的内部文件。用户完全无法从错误里看出「我该升级 Node」。
- **启动慢，且每次都慢**。`openclaw gateway` 是个长驻服务，但 CLI 里还有几十个子命令。朴素思路顶部一次性 `import` 整个 CLI，意味着每次启动都要解析、编译成百上千个模块文件。没有 compile cache 时，这是实打实的几秒钟。
- **信号处理在 respawn 场景下错位**。OpenClaw 的启动器在某些情况下需要「重新 spawn 自己」（比如要带不同的 compile-cache 设置重启）。一旦父进程 spawn 了子进程，用户按下 `Ctrl+C` 时，`SIGINT` 只到父进程。朴素思路里父进程收到信号就自己退了，子进程（真正的 gateway）变成孤儿继续跑——用户以为停了，其实没停。
- **源码检出和打包安装行为不一致**。从 GitHub 拉源码跑、和 `npm install` 装的包，目录结构、是否该启用 compile cache 都不同。朴素思路无法区分，会在其中一种安装方式下行为错乱。

核心矛盾是：业务代码（命令解析）必须晚于环境校验和进程治理，否则失败信息会被埋在堆栈深处，性能和正确性也无从保证。

## 5. OpenClaw 的做法

OpenClaw 把启动拆成两层，让「环境治理」严格先于「业务逻辑」。

**第一层：`openclaw.mjs` 启动器。** 这是一个故意保持纯 JavaScript（不经过 TypeScript 编译）的薄壳，因为它要在 TS 运行时还没就绪时就能跑。它从上到下做四件事：

1. **Node 版本闸门**。`ensureSupportedNodeVersion()` 在文件最顶上就执行。版本不够，直接打印一条带 `nvm install` 指引的人话错误并 `process.exit(1)`——用户立刻知道该干什么。
2. **compile cache 决策**。根据是源码检出还是打包安装，决定是否启用、用哪个目录的 Node compile cache，把模块编译结果缓存下来，加速后续启动。
3. **必要时 respawn**。如果当前的 compile-cache 设置不对，启动器会带正确的环境变量重新 spawn 一个自己。这是 `runRespawnedChild` 干的活。
4. **信号转发**。respawn 出子进程后，启动器为 `SIGTERM`/`SIGINT`/`SIGHUP` 等信号挂上监听器，把信号转发给子进程，并设置宽限计时器——子进程若赖着不退，启动器会强制 kill 它再退出。这正是为了堵上「孤儿 gateway 进程」那个洞。

只有当不需要 respawn 时，启动器才真正 `import('./dist/entry.js')`，进入第二层。

**第二层：`src/entry.ts` → `run-main.ts`。** `entry.ts` 先用 `isMainModule` 守卫确认自己确实是被当作入口运行（而不是被当依赖 import），再做一轮 TS 侧的环境准备（再次的 compile-cache、profile/容器参数解析、Windows argv 规整），然后调用 `runMainOrRootHelp`，它动态 `import('./cli/run-main.js')` 并调 `runCli`。

`runCli` 是命令路由的大脑。对于 `openclaw gateway`，它走一条特别优化的快路径：`isGatewayRunFastPathArgv` 检测到 argv 形如 `gateway` 或 `gateway run`，于是 `tryRunGatewayRunFastPath` 只 import gateway 命令需要的那一小撮模块，注册一个最小的 Commander 程序，匹配到 `gateway` 命令。**关键设计**：命令体只是 `addGatewayRunCommand` 注册的一组 `.option(...)`，真正的执行逻辑在 `.action` 里才 `await import('./run.js')`——也就是说，连 gateway 的实现都是懒加载的。这就是朴素思路「顶部全量 import」问题的答案：只为你真正要跑的命令付出加载成本。

走完这一步，命令路由已经锁定在 gateway 路径上，Commander 的 `.action` 回调即将被触发。

## 6. 代码位置

- `openclaw.mjs:27` — `ensureSupportedNodeVersion`，最顶层的 Node 版本闸门。
- `openclaw.mjs:42` — 在任何其他逻辑之前调用版本闸门。
- `openclaw.mjs:94` — `runRespawnedChild`，spawn 子进程并接管信号转发。
- `openclaw.mjs:148` — 为各信号挂监听器，把信号转发给子进程。
- `openclaw.mjs:233` — `waitingForCompileCacheRespawn`，决定是否需要 respawn。
- `openclaw.mjs:393` — 不需要 respawn 时，`tryImport('./dist/entry.js')` 进入第二层。
- `src/entry.ts:75` — `isMainModule` 守卫，避免被当依赖 import 时重复启动。
- `src/entry.ts:199` — `runMainOrRootHelp`，动态 import `run-main.js`。
- `src/entry.ts:204` — `import('./cli/run-main.js')` 并调用 `runCli`。
- `src/cli/run-main.ts:430` — `runCli`，命令路由主函数。
- `src/cli/run-main.ts:94` — `isGatewayRunFastPathArgv`，识别 `gateway`/`gateway run` 形态的 argv。
- `src/cli/run-main.ts:148` — `tryRunGatewayRunFastPath`，gateway 命令的快路径，只 import 必需模块。
- `src/cli/run-main.ts:189` — `addGatewayRunCommand` 把 `gateway` 命令挂到 Commander。
- `src/cli/gateway-cli/run-command.ts:10` — `addGatewayRunCommand`，注册 `--port`/`--bind`/`--auth` 等选项。
- `src/cli/gateway-cli/run-command.ts:56` — `.action` 回调，懒加载 `./run.js` 并调 `runGatewayCommand`。

## 7. 分支与延伸

我们这条 trace 走的是「`openclaw gateway` 干净启动」。这一步上挂着的岔路：

- **root help 快路径**：`openclaw --help` 不进 `runCli` 主体，直接吐预算好的帮助文本（`tryHandleRootHelpFastPath`）。
- **version 快路径**：`openclaw --version` 同理走 `tryHandleRootVersionFastPath`。
- **respawn 真正发生时**：父进程不会执行后面任何业务逻辑，整个流程在子进程里重来一遍。
- **容器/profile 模式**：`--container`、`--profile`/`--dev` 会改变 argv 和环境，我们这次都没用。
- **插件 CLI 命令**：非内建命令会触发插件命令注册，那是另一条很长的路径。

想完整理解 OpenClaw 的进程模型、启动器分层、以及为什么入口要这样切两层，去读 [第 1 章](01-architecture-overview.md)。

## 8. 走完这一步你脑子里应该多了什么

- OpenClaw 的启动是**两层**的：纯 JS 的 `openclaw.mjs` 启动器负责环境治理（Node 版本、compile cache、respawn、信号），TS 的 `entry.ts`/`run-main.ts` 负责业务路由——业务代码严格晚于环境校验。
- 启动器在 respawn 出子进程后会**转发信号并设置宽限计时器**，这是为了防止用户 `Ctrl+C` 时真正的 gateway 变成孤儿进程。
- `gateway` 命令走的是一条**快路径**（`tryRunGatewayRunFastPath`），只 import 它需要的模块，而非全量加载整个 CLI——这是 OpenClaw 处处可见的「懒加载」风格的第一个例子。
- 连 gateway 命令的实现本身都是懒加载的：Commander 的 `.action` 回调里才 `import('./run.js')`。
- 这一步结束时，命令路由已锁定 gateway 路径，`runGatewayCommand` 即将被调用——下一步它会真正去启动 server。
