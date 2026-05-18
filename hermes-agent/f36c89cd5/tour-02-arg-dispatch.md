# Trace 步骤 02 —— 参数解析与子命令分发

## 1. 当前情境

上一步结束时，Python 解释器在跑，`hermes_cli.main` 模块已导入，Windows 编码已修，`main()` 函数握着控制权。但 `main()` 还没有看过命令行——`sys.argv` 里那串 token（在我们的 trace 里只有一个裸 `hermes`，后面什么都没有）还原封不动地躺着。

此刻系统里既没有「子命令」的概念，也没有任何 `cmd_*` 处理函数被选中。这一步要回答的是：`main()` 怎样把一串原始字符串变成一个**决定**——「该调用哪个函数」——而且让裸 `hermes` 和 `hermes chat` 走向同一个终点。

## 2. 问题

`hermes` 是一个多命令 CLI。同一个可执行文件要同时支持几十种用途：`hermes chat`（交互对话）、`hermes gateway`（消息网关）、`hermes model`（选模型）、`hermes doctor`、`hermes update`……每一种都对应一个独立的处理函数。`main()` 必须：

- 把 `sys.argv` 解析成结构化的 `args` 对象，并校验参数合法性（未知 flag 要报错、`--help` 要打印帮助）。
- 根据用户敲的子命令名，**路由**到正确的处理函数。
- 处理一个特殊情况：用户**什么子命令都不敲**，只打 `hermes`。这是最高频的用法——它必须等价于 `hermes chat`，而不是报「缺少子命令」的错。
- 让裸 `hermes` 和显式 `hermes chat` 共享**完全相同**的一套 flag（`-q`、`-r`、`-w`、`--model`……），不能出现「裸命令支持 `-c`，但 `chat` 子命令不支持」这种漂移。

利害关系在于：路由错了，用户会进错功能；裸命令和 `chat` 分叉了，文档和行为会慢慢对不上，每加一个新 flag 都要在两处维护。

## 3. 朴素思路

最直觉的做法是手写一个 `if/elif` 链。读 `sys.argv[1]`，挨个比对：

```python
def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "chat"
    if cmd == "chat":
        cmd_chat(parse_chat_args(sys.argv[2:]))
    elif cmd == "gateway":
        cmd_gateway(...)
    elif cmd == "model":
        cmd_model(...)
    # ... 三十多个 elif
    else:
        cmd_chat(parse_chat_args(sys.argv[1:]))  # 不认识？当成 chat 的参数
```

每个子命令再各自写一个 `parse_xxx_args` 手工拆 flag。看起来直白，加新命令就是加一个 `elif`。

## 4. 为什么朴素思路会崩

这条 `if/elif` 链有几个绕不过去的硬伤：

- **参数解析全靠手写**。`--help` 文本、`-q VALUE` 这种「带值 flag」、`--worktree`/`-w` 这种「同义短长名」、未知 flag 报错——argparse 免费给你的东西，手写要全部重做，而且每个子命令重做一遍。
- **裸命令与 `chat` 的漂移无法阻止**。朴素思路里裸 `hermes` 走 `parse_chat_args(argv[1:])`，`hermes chat` 走 `parse_chat_args(argv[2:])`——看似复用了同一个解析器，但只要有人给 `chat` 子命令单独加一个 flag 而忘了同步裸路径，两者就分叉了。它们「碰巧」一致，不是「结构上保证」一致。
- **「没有子命令」与「子命令名被当成参数值」会撞车**。考虑 `hermes -c model`：用户想「continue 一个名叫 model 的会话」，还是「运行 model 子命令」？朴素的 `argv[1]` 判断会把 `-c` 当 token、把 `model` 误判成子命令。这种歧义需要解析器有「回退」能力，`if/elif` 给不了。
- **路由逻辑和处理函数耦合死**。新增命令要同时改 `elif` 链和函数定义两处，几十个分支堆在 `main()` 里，没人敢动。

核心矛盾是：**「解析」和「路由」是两件事**，朴素思路把它们揉进一根 `if/elif` 里，于是两件事都做不好。

## 5. Hermes 的做法

Hermes 用 argparse 的 **subparser 机制**，再叠加一个关键技巧：**默认子命令绑定**。

第一步，`main()` 调用 `build_top_level_parser()`（位于独立模块 `hermes_cli/_parser.py`）。这个函数构建顶级 parser、subparsers 动作、以及 `chat` 子命令的 parser，三者一起返回：

```python
# hermes_cli/_parser.py:82
def build_top_level_parser():
    """Build the top-level parser, the subparsers action, and the ``chat`` subparser.

    Returns ``(parser, subparsers, chat_parser)``. The caller wires
    ``chat_parser.set_defaults(func=cmd_chat)`` and continues registering
    other subparsers via ``subparsers.add_parser(...)``.
    """
```

为什么 `chat` parser 单独被抽进 `_parser.py`、而其它子命令留在 `main.py` 里内联构建？模块开头的 docstring 说明了：`relaunch.py` 等模块需要**内省** parser，去发现「有哪些 flag 存在」，而不想真的跑 `main()`。把顶级 parser 和 `chat` parser 抽出来，内省就不必加载 `main.py` 的全部副作用。

第二步，回到 `main()`，拿到三元组后立刻钉上默认处理函数：

```python
# hermes_cli/main.py:9745
parser, subparsers, chat_parser = build_top_level_parser()
chat_parser.set_defaults(func=cmd_chat)
```

`set_defaults(func=cmd_chat)` 把一个名为 `func` 的属性预置到 `chat` 子命令的解析结果上。其后 `main.py` 用同样的模式为每个子命令注册 subparser 并各绑一个 `func`——`model_parser.set_defaults(func=cmd_model)`（`main.py:9791`）、`gateway_parser.set_defaults(func=cmd_gateway)`（`main.py:10021`）、`doctor`、`update`……几十个，全是同一个套路。**「子命令名 → 处理函数」的映射不再是 `if/elif`，而是数据**。

第三步，解析。`main.py:12313`/`12325`/`12328` 三处 `parser.parse_args()`——之所以有三处，是为了绕开旧版 Python（bpo-9338）在「父 parser 带 `nargs='?'` 可选参数 + subparser」组合下的路由 bug：先尝试把 subparsers 设为 required 强制确定性路由，失败了（比如 `hermes -c model` 里 `model` 被 `-c` 当成会话名吃掉）再回退。这正是朴素思路应付不了的歧义，argparse 的回退能力把它接住了。

第四步，分发。解析完得到 `args`，`main()` 末尾只有一句路由逻辑：

```python
# hermes_cli/main.py:12417
# Default to chat if no command specified
if args.command is None:
    for attr, default in [
        ("query", None), ("model", None), ("provider", None),
        ("toolsets", None), ("verbose", False), ("resume", None),
        ("continue_last", None), ("worktree", False),
    ]:
        if not hasattr(args, attr):
            setattr(args, attr, default)
    cmd_chat(args)
    return

# Execute the command
if hasattr(args, "func"):
    args.func(args)
else:
    parser.print_help()
```

这里有两条路通向 `cmd_chat`：

- 用户敲了 `hermes chat`：argparse 选中 `chat` subparser，`set_defaults` 注入的 `func=cmd_chat` 落在 `args` 上，最后 `args.func(args)` 调到它。
- 用户敲了裸 `hermes`：没有任何 subparser 被选中，`args.command is None`，于是 `main()` 显式补齐缺省属性后直接调 `cmd_chat(args)`。

我们的 trace 走的是第二条——裸 `hermes`。注意补属性那段：裸路径不会经过 `chat` subparser，所以 `chat` 专属的 flag（`query`、`worktree` 等）在 `args` 上不存在，`main()` 用 `hasattr` 检查后补上默认值，让 `cmd_chat` 不管从哪条路进来都能安全地 `getattr`。

为什么这叫「默认子命令」模式而不是直接 `cmd_chat(sys.argv)`？因为顶级 parser **本身**就声明了 `-q`/`-r`/`-c`/`-w`/`--model` 这一整套与 `chat` 重叠的 flag（`_parser.py:96` 起）。裸 `hermes -c "项目名"` 这串字，是被**顶级 parser** 解析的，解析结果和 `hermes chat -c "项目名"` 经 `chat` subparser 解析的结果结构一致——两条路殊途同归，不是靠人工同步，而是靠「同一套 flag 声明 + 同一个 `cmd_chat` 终点」结构性地保证。

<svg viewBox="0 0 780 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Argument parsing and subcommand dispatch flow">
  <defs>
    <marker id="t2ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="120" y="14" width="540" height="34" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="390" y="35" text-anchor="middle" font-size="10.5" fill="currentColor">sys.argv  ["hermes"] / ["hermes","chat"] / ["hermes","model"]</text>
  <path d="M390,48 L390,66" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t2ar)"/>
  <rect x="160" y="68" width="460" height="52" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="390" y="88" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">build_top_level_parser()</text>
  <text x="390" y="105" text-anchor="middle" font-size="10" fill="#64748b">chat_parser.set_defaults(func=cmd_chat) · model_parser … ×N</text>
  <path d="M390,120 L390,138" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t2ar)"/>
  <rect x="240" y="140" width="300" height="32" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="390" y="160" text-anchor="middle" font-size="10.5" fill="currentColor">parser.parse_args() → args</text>
  <path d="M390,172 L390,196" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t2ar)"/>
  <polygon points="390,198 480,232 390,266 300,232" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="390" y="236" text-anchor="middle" font-size="10.5" fill="currentColor">args.command</text>
  <text x="390" y="250" text-anchor="middle" font-size="10.5" fill="currentColor">is None ?</text>
  <path d="M300,232 L150,232 L150,288" stroke="#94a3b8" stroke-width="1.2" fill="none" marker-end="url(#t2ar)"/>
  <text x="230" y="224" font-size="10" fill="#64748b">是</text>
  <path d="M480,232 L630,232 L630,288" stroke="#94a3b8" stroke-width="1.2" fill="none" marker-end="url(#t2ar)"/>
  <text x="540" y="224" font-size="10" fill="#64748b">否</text>
  <rect x="40" y="290" width="220" height="56" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="150" y="310" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">补默认属性 → cmd_chat(args)</text>
  <text x="150" y="326" text-anchor="middle" font-size="9.5" fill="#64748b">裸 hermes 走这里（本 trace）</text>
  <text x="150" y="340" text-anchor="middle" font-size="9.5" fill="#64748b">hasattr 检查后补 chat 专属 flag</text>
  <rect x="520" y="290" width="220" height="56" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="630" y="312" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">args.func(args)</text>
  <text x="630" y="330" text-anchor="middle" font-size="9.5" fill="#64748b">chat→cmd_chat · model→cmd_model …</text>
</svg>
<span class="figure-caption">图 T2.1 ｜ 参数解析到子命令分发：裸 hermes 走 args.command is None 分支，subcommand 走 args.func 分支，两者殊途同归。</span>

<details>
<summary>ASCII 原版</summary>

```text
        sys.argv  ["hermes"]   或   ["hermes","chat"]   或   ["hermes","model"]
              │
              ▼
   build_top_level_parser()         ← 顶级 parser + subparsers + chat_parser
              │  chat_parser.set_defaults(func=cmd_chat)
              │  model_parser.set_defaults(func=cmd_model)  ... ×N
              ▼
   parser.parse_args()  → args
              │
   ┌──────────┴───────────────────────────────┐
   │ args.command is None ?                    │
   │   是  → 补默认属性 → cmd_chat(args)  ◀── 裸 hermes 走这里（本 trace）
   │   否  → args.func(args)                   │
   │           func 来自 set_defaults：         │
   │           chat→cmd_chat  model→cmd_model … │
   └───────────────────────────────────────────┘
```

</details>

到这一步结束，`args` 解析完毕，`args.func` 指向 `cmd_chat`（无论经由 `set_defaults` 还是裸路径的显式调用），`cmd_chat(args)` 即将被调用。还没有任何 Hermes 业务对象诞生——配置、`HermesCLI`、agent 全都不存在。

## 6. 代码位置

按阅读顺序：

- 顶级 parser 构建：`hermes_cli/_parser.py:82` —— `def build_top_level_parser()`，返回 `(parser, subparsers, chat_parser)`。
- `chat` 子命令的 flag 声明：`hermes_cli/_parser.py:234-374` —— `subparsers.add_parser("chat", ...)` 及其 `add_argument`。
- 顶级 parser 上与 `chat` 重叠的 flag：`hermes_cli/_parser.py:96-227` —— `-q`/`-r`/`-c`/`-w`/`--model` 等也声明在顶级，使裸 `hermes` 能接收它们。
- 默认子命令绑定：`hermes_cli/main.py:9745-9746` —— `build_top_level_parser()` 后立刻 `chat_parser.set_defaults(func=cmd_chat)`。
- 其它子命令注册：`hermes_cli/main.py:9751` 起 —— `model`、`fallback`、`gateway`…… 每个都 `subparsers.add_parser(...)` + `set_defaults(func=cmd_xxx)`。
- 解析（含 bpo-9338 回退）：`hermes_cli/main.py:12308-12328` —— 三处 `parser.parse_args(_processed_argv)`。
- 分发：`hermes_cli/main.py:12417-12437` —— `args.command is None` 走 `cmd_chat`，否则 `args.func(args)`。
- 处理函数本身：`hermes_cli/main.py:1329` —— `def cmd_chat(args)`。

## 7. 分支与延伸

- 控制权马上进入 `cmd_chat(args)`，它会判定 TUI 与否、解析 `--continue`、再走向 `cli.py::main` → 见 [Trace 步骤 03](tour-03-cli-construct.md)。
- 这趟 trace 走的是裸 `hermes`；如果用户敲 `hermes gateway`，`args.func` 会是 `cmd_gateway`，控制权转向消息网关 → [第 13 章 消息网关与多平台](13-messaging-gateway.md)。
- 几十个子命令如何在 `main()` 里集中注册、为什么 `chat` 单独抽进 `_parser.py` 而其余内联 → [第 2 章 入口与进程引导](02-entrypoints.md)。
- 上一步把控制权交到 `main()` 手里、修好编码 → [Trace 步骤 01](tour-01-shell-entry.md)。
- `--oneshot`/`-z` 会在分发前被截胡，绕过 `cli.py` 直接跑 `run_oneshot`（`main.py:12388`）；`--resume`/`--continue` 在无子命令时也会被当成 `chat` 的快捷方式（`main.py:12401`）。

## 8. 走完这一步你脑子里应该多了什么

1. `main()` 解决「该调哪个函数」不靠 `if/elif`，靠 argparse 的 subparser + `set_defaults(func=...)`——**「子命令名 → 处理函数」是数据**，每个子命令一行 `set_defaults` 就把自己挂上路由表。
2. 裸 `hermes` 等价于 `hermes chat`，靠的是「**默认子命令**」模式：顶级 parser 自己也声明了与 `chat` 重叠的 flag，解析后 `args.command is None` 时 `main()` 显式补默认属性再调 `cmd_chat`——两条路结构性地汇流到同一个终点，不是人工同步。
3. `chat` 的 parser 被单独抽进 `hermes_cli/_parser.py`，是为了让 `relaunch.py` 等模块能**内省** flag 而不必加载整个 `main.py`。
4. `parse_args()` 在 `main()` 里出现三次，是为绕开旧版 Python 在「`nargs='?'` 可选参数 + subparser」下的路由 bug——先强制 required 路由，失败再回退。
5. 走完这一步，`args` 成型、`args.func = cmd_chat`，但所有 Hermes 业务对象（配置、CLI、agent）仍不存在。

---

下一步：[Trace 步骤 03 —— 构造 HermesCLI 与三路配置加载](tour-03-cli-construct.md)
