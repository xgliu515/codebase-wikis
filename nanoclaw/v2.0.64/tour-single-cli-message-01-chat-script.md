## 1. 当前情境

终端里，你刚敲完：

```bash
$ pnpm run chat "ping"
```

按下回车的一瞬间，整个 nanoclaw 代码库还没有任何一行被执行。`pnpm` 查 `package.json:23` 那行 `"chat": "tsx scripts/chat.ts"`，把 `"ping"` 作为参数交给 `tsx`，由 `tsx` 启动 Node 解释器去运行 `scripts/chat.ts`。

可见的状态只有：

- `process.cwd()` 是 nanoclaw 仓库根目录（关键 —— `DATA_DIR` 是从这里 resolve 出来的）。
- `process.argv = ["node", ".../tsx", "scripts/chat.ts", "ping"]`。
- host 进程（launchd 或开发者手动 `pnpm start` 启的那个）已经在 background 跑了一会儿，`data/cli.sock` 已经被它创建并 chmod 0600。
- 还没有任何 socket 连接、没有任何 SQLite 句柄、没有任何 host 侧代码被这次客户端进程触发。

## 2. 问题

"客户端" 这个角色要解决的核心问题就两个：

1. **找到 host 的入口**。host 进程并不监听 TCP 端口，也不暴露 HTTP API —— 它只在文件系统某个固定位置开了个 Unix domain socket。客户端必须知道这个路径，而且这个路径必须跟 host 算出来的路径**完全一致**（否则 host 在 A 处监听、客户端去 B 处连，永远连不上）。
2. **把"ping"送进去，再把回复读出来，然后干净退出**。socket 是字节流，不是 RPC —— 谁负责分帧？谁决定"对话结束"？客户端怎么知道 agent 已经回完了？

第二个问题的 **干净退出** 部分尤其麻烦。HTTP 有 `Content-Length`、有 connection close。但 nanoclaw 的 agent 不知道自己什么时候"说完"了 —— 它可能先回一行 `"pong"`，过几秒又突然补一句 `"by the way..."`（比如调了个工具之后产生新输出）。客户端不能在第一行回来就立刻 exit，否则后续回复会被静默丢弃；也不能等到天荒地老，那是个 CLI 命令，不是个长跑 daemon。

## 3. 朴素思路

最直白的写法：

```ts
const socket = net.connect('/tmp/nanoclaw.sock')
socket.write('ping\n')
socket.once('data', (chunk) => {
  console.log(chunk.toString())
  socket.end()
  process.exit(0)
})
```

- socket 路径写死。
- 写一行原始文本进去。
- 拿到 **第一片** 字节就打印、关闭、退出。

简单、能跑、能在 90% 的开发场景下"看到 pong 然后退出"。

## 4. 为什么朴素思路会崩

每一条假设都会在 nanoclaw 真实部署里翻车：

- **socket 路径写死会跟 host 不一致**。host 的 `DATA_DIR` 在 `src/config.ts:24` 是 `path.resolve(PROJECT_ROOT, 'data')`，而 `PROJECT_ROOT = process.cwd()`（同文件 line 16）。host 在哪个目录被 launchd 拉起，`cli.sock` 就生在哪个目录的 `data/` 里。客户端必须复用同一个 `DATA_DIR` 计算 —— 写死路径就跟"换台机器装 nanoclaw"立刻冲突。
- **原始文本协议没有扩展空间**。今天是 "ping"，明天 admin 工具想用同一个 socket 注入"以 Discord 身份发一条到这个 channel"，需要带 `to.channelType`、`to.platformId`、`reply_to` 之类的结构化字段（见 `src/channels/cli.ts:11-25` 的 wire format 注释）。纯文本协议会逼你重新设计编码 —— 第一天就该走 JSON。
- **`socket.once('data')` 拿不到完整一行**。Node 的 `data` 事件按 TCP packet 触发，可能一次给你半行、可能一次给你两行。要 buffer + 按 `\n` 切。
- **回头还会来消息**。agent 处理 "ping" 时如果触发了 tool call，可能先回一句"让我看看……"，再回 "pong"。客户端一收到第一行就 exit，第二行就丢了。
- **错误码要可观察**。CI 跑 smoke test 时要区分"host 没起来"（`ENOENT`）、"host 起来了但没回复"（timeout）、"agent 回了"（success）。一律 exit(0) 没法用。

## 5. nanoclaw 的做法

`scripts/chat.ts` 这 100 行做了这几件事，每一件都精确对应上面一个坑：

```ts
// scripts/chat.ts:13-23
import net from 'net';
import path from 'path';
import { DATA_DIR } from '../src/config.js';
const SILENCE_MS = 2000;
const TOTAL_TIMEOUT_MS = 120_000;
function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}
```

第一招就解决了"和 host 算出来的 socket 路径一致"的问题：**直接 import host 的 `DATA_DIR` 常量**。客户端代码物理上和 host 代码住在同一个仓库（`scripts/chat.ts` ↔ `src/config.ts`），同一个 `process.cwd()`，编译后 `DATA_DIR` 一字不差。换台机器、换个安装目录，照样对得上。

第二招是 wire format 用 **一行一个 JSON 对象**（`scripts/chat.ts:59`）：

```ts
socket.write(JSON.stringify({ text }) + '\n');
```

今天只填 `{text}`。明天 admin 想路由到别的 channel，可以加 `{text, to:{...}, reply_to:{...}}` —— 见 `src/channels/cli.ts:181-245` 的 `handleLine` 解析 `to` 和 `reply_to` 的分支。schema 演进零破坏。

第三招是 **silence timer 而不是 first-reply exit**（`scripts/chat.ts:50-56`）：

```ts
function scheduleExit(): void {
  if (silenceTimer) clearTimeout(silenceTimer);
  silenceTimer = setTimeout(() => {
    socket.end();
    process.exit(0);
  }, SILENCE_MS);
}
```

每收到一行有效 JSON 就 **重置** 这个 2 秒定时器。"安静 2 秒"才认为 agent 说完了。`hardTimer`（120 秒）是兜底 —— 真出问题（host 接住了但 agent 卡死了），客户端不至于挂到天荒地老。

第四招是 **分错误码**（`scripts/chat.ts:35-44, 97`）：

```ts
socket.on('error', (err) => {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
    console.error(`NanoClaw daemon not reachable at ${socketPath()}.`);
    process.exit(2);
  }
  // ...
  process.exit(2);
});
// close handler:
process.exit(firstReplySeen ? 0 : 3);
```

- exit 0：正常收到至少一条回复。
- exit 1：参数错误（没传消息）。
- exit 2：socket 层错误（host 没起 / 没权限）。
- exit 3：socket 通了但 agent 没回（timeout 或 server 主动 close）。

第五招是 **按 `\n` 分帧的接收 buffer**（`scripts/chat.ts:69-92`）：累计 `buffer`、循环找 `\n`、把每行 `JSON.parse`、合法行才 `stdout.write` + `firstReplySeen=true` + `scheduleExit()`。`try/catch` 包住 parse，未来某天 server 加新字段或非 JSON 调试输出，老客户端也不会崩。

整体时序：

```
shell                         chat.ts                 data/cli.sock
  │   pnpm run chat "ping"      │                         │
  │ ───────────────────────────►│                         │
  │                             │ net.connect()           │
  │                             │ ───────────────────────►│
  │                             │ write JSON+\n           │
  │                             │ ───────────────────────►│
  │                             │ wait reply (silence:2s) │
```

注意一个反直觉的小细节：客户端 **第一时间就 write**，连 `connect` 事件都不必等 —— Node 的 `net.Socket` 在 `connect` 完成前会自己 buffer 写入。但 `scripts/chat.ts:58-67` 明确把 `write` 放在 `'connect'` 回调里，**顺便启动 `hardTimer`**。这样 hardTimer 不会因为 connect 阶段花了几百毫秒而提前超时；hardTimer 衡量的是"连上之后没回复"的时间窗口。

## 6. 代码位置

按阅读顺序：

- `package.json:23` —— `"chat": "tsx scripts/chat.ts"` 把命令绑到脚本。
- `scripts/chat.ts:13-16` —— import `net` / `path` 和 host 共享的 `DATA_DIR`。
- `scripts/chat.ts:18-19` —— `SILENCE_MS = 2000` / `TOTAL_TIMEOUT_MS = 120_000` 两个超时常量。
- `scripts/chat.ts:21-23` —— `socketPath()` 复用 `DATA_DIR`。
- `scripts/chat.ts:25-32` —— 解析 argv、空参数报错 exit(1)、拼成单字符串 `text`。
- `scripts/chat.ts:33` —— `net.connect(socketPath())`，发起 Unix domain socket 连接。
- `scripts/chat.ts:35-44` —— `'error'` handler：`ENOENT` / `ECONNREFUSED` 提示 daemon 没起；其它错误 exit(2)。
- `scripts/chat.ts:46-56` —— `silenceTimer` 状态机和 `scheduleExit()` 重置逻辑。
- `scripts/chat.ts:58-67` —— `'connect'` 回调：write payload + 启动 `hardTimer`。
- `scripts/chat.ts:69-92` —— `'data'` handler：按 `\n` 切行、JSON.parse、合法行 `stdout.write` + `scheduleExit()`。
- `scripts/chat.ts:94-98` —— `'close'` handler：cleanup timer，按 `firstReplySeen` 决定 exit(0/3)。
- `src/config.ts:16` —— `PROJECT_ROOT = process.cwd()`。
- `src/config.ts:24` —— `DATA_DIR = path.resolve(PROJECT_ROOT, 'data')`，host 和客户端共享。

## 7. 分支与延伸

- **CLI channel 的服务端这一侧（accept、`{to}` 和 `{reply_to}` 的 admin 模式、单 client `superseded` 语义）**：见 [第 11 章 §"In-tree CLI adapter"](11-self-modification.md#in-tree-cli-adapter)。
- **socket 文件权限为什么是 0600 / 0700 系列**：见 [第 4 章 §"CLI 与 socket file perms"](04-host-bootstrap.md#cli-与-socket-file-perms)。在 nanoclaw 的安全模型里，"能连上这个 socket"≈"拥有 daemon 运行用户的权限"，所以客户端用 admin 身份注入路由也是合法的。
- **`pnpm run chat` 之外的 admin CLI（`ncl`）**：`ncl` 走的是另一个 socket `data/ncl.sock`，wire format 不同 —— 见 [第 12 章 §"ncl admin CLI"](12-ncl-admin-cli.md#socket-server-与-dispatch)。
- **第一条消息进 host 之后会发生什么**：直接看 tour 下一步 [02 - CLI adapter 收到字节](tour-single-cli-message-02-cli-adapter.md)。

## 8. 走完这一步你脑子里应该多了什么

1. **客户端和 host 物理上是同一个仓库里的两个进程**，靠 `DATA_DIR` 这个共享常量来对齐 socket 路径 —— 没有任何配置文件，也没有环境变量。
2. **wire format 是 line-delimited JSON**，今天用 `{text}`，明天用 `{text, to, reply_to}`，老客户端可以无感升级。
3. **silence timer 取代 first-reply exit**：CLI agent 可能多次回复，等"安静 2 秒"才算说完；并配一个 120 秒的 `hardTimer` 兜底。
4. **退出码区分四种结果**：成功 (0)、用法错误 (1)、socket 不可达 (2)、连通但无回复 (3) —— CI 可观察。
5. **走到这一步，host 进程对你来说仍然是黑盒**：你只看到自己一头 `connect` + `write`。下一步要从 host 一侧看 server 怎么 accept、怎么解析这一行 JSON。

下一步：[Trace 步骤 02 —— CLI adapter 收到字节](tour-single-cli-message-02-cli-adapter.md)
