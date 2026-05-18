# 第 2 章 入口与进程引导

第 1 章把 Hermes 压成了四层。本章聚焦最上面那一层——**入口层**：从你在终端敲下 `hermes` 那一刻，到一个 `AIAgent` 实例真正被构造出来、对话循环开始转动之前，进程内部到底发生了什么。

这一段"引导过程"看似平凡，却是整个项目里分支最密集的代码之一：单个 `main()` 函数注册了三十多个子命令；同一份配置有三条不同的加载路径；`hermes`、`hermes --tui`、`hermes gateway`、`hermes chat -q` 会走向四条截然不同的执行路线。本章把这些分支理清楚。

代码版本：`NousResearch/hermes-agent@f36c89cd5`。

---

## 2.1 进程启动链：从 `hermes` 脚本到 `cmd_chat`

最顶端是一个只有 12 行的启动器脚本 `hermes`（仓库根目录）：

```python
#!/usr/bin/env python3
"""Hermes Agent CLI launcher."""

if __name__ == "__main__":
    from hermes_cli.main import main
    main()
```

它故意做到极薄——除了把控制权交给 `hermes_cli/main.py` 的 `main()`，什么都不做。这样设计的原因是：真正安装后的 `hermes` 命令（由 `pyproject.toml` 定义的 entry point）和这个仓库内的脚本必须行为完全一致，包括 `gateway`、`cron`、`doctor` 等所有子命令。把逻辑全部收进 `main()`，就只有一个真相来源。

整条启动链：

<svg viewBox="0 0 800 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Process startup chain from hermes script to cmd_chat">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g font-size="11">
    <rect x="280" y="18" width="240" height="38" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
    <text x="400" y="42" font-weight="700" fill="currentColor" text-anchor="middle">$ hermes　用户敲命令</text>
    <rect x="240" y="80" width="320" height="40" rx="6" fill="#fff7ed" stroke="#cbd5e1"/>
    <text x="400" y="100" font-weight="600" fill="currentColor" text-anchor="middle">hermes（12 行脚本）</text>
    <text x="400" y="115" font-size="10" fill="#64748b" text-anchor="middle">from hermes_cli.main import main; main()</text>
    <rect x="200" y="144" width="400" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
    <text x="400" y="164" font-weight="600" fill="currentColor" text-anchor="middle">hermes_cli/main.py:9726　main()</text>
    <text x="400" y="180" font-size="10" fill="#64748b" text-anchor="middle">UTF-8 引导 → 构建 parser → 解析 argv</text>
    <rect x="40" y="222" width="320" height="56" rx="6" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.1"/>
    <text x="200" y="244" font-weight="600" fill="currentColor" text-anchor="middle">有已知子命令 token</text>
    <text x="200" y="260" font-size="10" fill="#64748b" text-anchor="middle">args.func(args)　main.py:12434</text>
    <text x="200" y="273" font-size="10" fill="#94a3b8" text-anchor="middle">例: hermes model / gateway / cron / doctor</text>
    <rect x="440" y="222" width="320" height="56" rx="6" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.1"/>
    <text x="600" y="244" font-weight="600" fill="currentColor" text-anchor="middle">无子命令（裸 hermes / 仅 flags）</text>
    <text x="600" y="262" font-size="10" fill="#64748b" text-anchor="middle">cmd_chat(args)　main.py:12417</text>
    <rect x="440" y="304" width="320" height="40" rx="6" fill="#faf5ff" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="600" y="328" font-weight="600" fill="currentColor" text-anchor="middle">cmd_chat(args)　main.py:1329</text>
    <rect x="280" y="368" width="220" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.1"/>
    <text x="390" y="388" font-weight="600" fill="currentColor" text-anchor="middle">use_tui? → _launch_tui(...)</text>
    <text x="390" y="402" font-size="10" fill="#64748b" text-anchor="middle">启动 Ink TUI 子进程</text>
    <rect x="520" y="368" width="240" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.1"/>
    <text x="640" y="388" font-weight="600" fill="currentColor" text-anchor="middle">否 → cli_main(**kwargs)</text>
    <text x="640" y="402" font-size="10" fill="#64748b" text-anchor="middle">进入经典 CLI</text>
  </g>
  <line x1="400" y1="56" x2="400" y2="78" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar1)"/>
  <line x1="400" y1="120" x2="400" y2="142" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar1)"/>
  <path d="M320,188 L200,220" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar1)"/>
  <path d="M480,188 L600,220" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar1)"/>
  <line x1="600" y1="278" x2="600" y2="302" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar1)"/>
  <path d="M560,344 L420,366" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar1)"/>
  <path d="M620,344 L640,366" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar1)"/>
</svg>
<span class="figure-caption">图 R2.1 ｜ 从 hermes 脚本到 cmd_chat 的进程启动链：裸 hermes 默认路由到 chat，子命令经 args.func 分发。</span>

<details>
<summary>ASCII 原版</summary>

```text
$ hermes                              用户敲命令
   │
   ▼
hermes (12 行脚本)                    from hermes_cli.main import main; main()
   │
   ▼
hermes_cli/main.py:9726  main()       UTF-8 引导 → 构建 parser → 解析 argv
   │
   ├─ 有已知子命令 token ──────────►  args.func(args)   见 main.py:12434
   │     例: hermes model / gateway / cron / doctor ...
   │
   └─ 无子命令（裸 hermes / 仅 flags）──►  cmd_chat(args)   见 main.py:12417
         │
         ▼
   hermes_cli/main.py:1329  cmd_chat(args)
         │
         ├─ use_tui? ──────────────►  _launch_tui(...)        启动 Ink TUI 子进程
         │
         └─ 否 ────────────────────►  from cli import main as cli_main
                                       cli_main(**kwargs)      进入经典 CLI
```

</details>

`main()` 的尾部（`hermes_cli/main.py:12416-12435`）是分发的核心：

```python
# Default to chat if no command specified
if args.command is None:
    for attr, default in [("query", None), ("model", None), ...]:
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

两个要点：

1. **裸 `hermes` 默认路由到 chat。** 当 `args.command is None`（用户没敲任何子命令）时，`main()` 不报错，而是补齐 `cmd_chat` 期望的属性然后直接调用它。这就是为什么 `hermes` 单独一个词就能开始对话。
2. **子命令通过 `args.func` 分发。** 每个子命令的 parser 都在注册时调用了 `set_defaults(func=cmd_xxx)`（例如 `chat_parser.set_defaults(func=cmd_chat)`，`main.py:9746`）。`main()` 最后只需 `args.func(args)`，argparse 已经把正确的处理函数绑好了。这是一种把"分发逻辑"下放给 argparse 的惯用法，避免写一长串 `if/elif`。

`cmd_chat`（`main.py:1329`）本身在真正进 CLI 之前还做了不少事：解析 `--continue` / `--resume`（`main.py:1334-1365`）、首次运行守卫（没有任何 provider 配置就引导用户跑 `hermes setup`，`main.py:1368`）、后台启动更新检查、同步内建技能、处理 `--yolo` / `--ignore-user-config` / `--ignore-rules` 等开关。

### 2.1.1 为什么开关要走环境变量

`cmd_chat` 处理这几个开关时（`main.py:1415-1435`）不是把它们作为参数传给 `cli_main`，而是写进环境变量：

```python
if getattr(args, "yolo", False):
    os.environ["HERMES_YOLO_MODE"] = "1"
if getattr(args, "ignore_user_config", False):
    os.environ["HERMES_IGNORE_USER_CONFIG"] = "1"
if getattr(args, "ignore_rules", False):
    os.environ["HERMES_IGNORE_RULES"] = "1"
if getattr(args, "source", None):
    os.environ["HERMES_SESSION_SOURCE"] = args.source
```

原因是时序：`cmd_chat` 紧接着会 `from cli import main as cli_main`，而 `cli.py` 在**模块 import 阶段**就执行了 `CLI_CONFIG = load_cli_config()`。`--ignore-user-config` 必须在那一刻之前生效，否则 `CLI_CONFIG` 已经把用户 YAML 读进来了。函数参数做不到"在 import 之前生效",环境变量可以——`cmd_chat` 先 `os.environ[...] = ...`,再 `import cli`,`load_cli_config()` 读到的就是设好的开关。`--yolo`(绕过危险命令审批)、`--ignore-rules`(跳过 AGENTS.md/SOUL.md 等规则注入,映射到 `AIAgent(skip_context_files=True, skip_memory=True)`)同理:它们影响的代码路径在 import 期或更深处,环境变量是唯一能"足够早"到达的通道。

这也解释了 `cmd_chat` 为什么必须在 `import cli` 之前做完所有这些准备——它和 `_pin_kanban_board_env()`（`main.py:1308`,把当前看板钉进 `HERMES_KANBAN_BOARD` 防并发切换）一样,都是"import 前必须落定"的环境配置。

---

## 2.2 Bootstrap 层：跨平台 UTF-8

在 `main()` 做任何 `print()` 之前，必须先解决一个 Windows 上的老问题。`main()` 的第一件事就是（`main.py:9728-9733`）：

```python
try:
    from hermes_cli.stdio import configure_windows_stdio
    configure_windows_stdio()
except Exception:
    pass
```

更底层的实现在 `hermes_bootstrap.py:59` 的 `apply_windows_utf8_bootstrap()`。Windows 上的 Python 有两个长期存在的编码地雷：

1. `sys.stdout` / `sys.stderr` 绑定在控制台代码页（美国区一般是 `cp1252`），`print("café")` 会直接 `UnicodeEncodeError` 崩溃。
2. 通过 `subprocess` 派生的子进程，除非环境里设了 `PYTHONUTF8` / `PYTHONIOENCODING`，否则继承同样的 cp1252 默认值——任何 Python 子进程（execute_code 沙箱、子 agent、linter）都会撞同一个错。

`apply_windows_utf8_bootstrap()` 同时修这两个，且**只在 Windows 上动手，POSIX 完全不碰**：

```python
def apply_windows_utf8_bootstrap() -> bool:
    if not _IS_WINDOWS:
        return False
    if _bootstrap_applied:
        return False
    os.environ.setdefault("PYTHONUTF8", "1")          # 子进程继承
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    for stream_name in ("stdout", "stderr"):          # 当前进程 stdio
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    _bootstrap_applied = True
    return True
```

设计上有几处值得注意：

- 用 `os.environ.setdefault` 而不是直接赋值——用户仍可显式设 `PYTHONUTF8=0` 来 opt out。
- `_bootstrap_applied` 守卫保证幂等，重复调用是 no-op。
- 模块底部有 `apply_windows_utf8_bootstrap()` 这一行——**import 即生效**。所以每个入口点（`hermes`、`hermes-agent`、`hermes-acp`、`gateway.run`、`batch_runner.py`、`cron/scheduler.py`）只要在最顶端 `import hermes_bootstrap` 就够了。
- 它**不做**的事：不 re-exec Python，所以当前进程里 `open()` 仍按 locale 编码——那个需要在每个 `open()` 调用点显式写 `encoding="utf-8"`（由 ruff 的 `PLW1514` 规则兜底）。

为什么这件事必须最先做？因为 Hermes 的欢迎横幅、Rich 面板里全是 Unicode 制表符。如果引导晚一步，第一个 `print()` 就崩了。

### 各入口点的 bootstrap 接入方式

`hermes_bootstrap` 的接入因入口而异——这取决于该入口是"经 `hermes` 命令树进入"还是"作为独立脚本启动":

| 入口 | 接入方式 | 位置 |
|---|---|---|
| `hermes` CLI | `main()` 内 `configure_windows_stdio()` | `main.py:9728` |
| ACP (`hermes-acp` / `python -m`) | 模块顶端 `import hermes_bootstrap` | `acp_adapter/entry.py:18` |
| 批量运行 (`batch_runner.py`) | 模块顶端 `import hermes_bootstrap` | `batch_runner.py:23` |
| TUI Python 后端 | 经 `entry.py` 间接初始化 | `tui_gateway/entry.py` |

经 `hermes` 命令树进入的统一在 `main()` 第一行调 `configure_windows_stdio()`;而 ACP、批量运行这类**可以被直接 `python -m` 启动**的入口,必须自己在模块最顶端 `import hermes_bootstrap`——因为它们的 `main()` 不一定是进程的第一段代码,模块级 import 才是。两个独立入口都对这个 import 包了 `ModuleNotFoundError` 兜底(`acp_adapter/entry.py:18-26`、`batch_runner.py:23-28`),应对 `hermes update` 中途态——git-reset 落地了引用 bootstrap 的新代码、但 `uv pip install -e .` 还没把 bootstrap 注册进 venv。POSIX 上 bootstrap 本就是 no-op,跳过无害;Windows 上则是"宁可丢 UTF-8 设置也不要 import 崩溃"的取舍。

---

## 2.3 CLI 入口：`cli.py` 的 `main()` 与 `run()`

`cmd_chat` 在非 TUI 路径下会 `from cli import main as cli_main` 并调用它（`main.py:1459-1483`）。`cli.py:13930` 的 `main()` 是经典交互式 CLI 的真正入口。它的职责可以拆成五步：

<svg viewBox="0 0 800 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Five steps of cli.py main function">
  <defs>
    <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g font-size="11">
    <rect x="120" y="18" width="560" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
    <text x="400" y="41" font-weight="700" fill="currentColor" text-anchor="middle">cli.py:13930　main(query, model, toolsets, skills, resume, worktree, ...)</text>
    <circle cx="48" cy="84" r="13" fill="#0d9488"/><text x="48" y="89" font-size="12" font-weight="700" fill="#fff" text-anchor="middle">1</text>
    <rect x="80" y="68" width="600" height="34" rx="6" fill="#f0fdfa" stroke="#cbd5e1"/>
    <text x="96" y="89" fill="currentColor">configure_windows_stdio() — UTF-8 兜底（横幅会打 Unicode）</text>
    <circle cx="48" cy="130" r="13" fill="#0d9488"/><text x="48" y="135" font-size="12" font-weight="700" fill="#fff" text-anchor="middle">2</text>
    <rect x="80" y="114" width="600" height="34" rx="6" fill="#f0fdfa" stroke="#cbd5e1"/>
    <text x="96" y="135" fill="currentColor">if gateway: asyncio.run(start_gateway()); return — 网关早退分流</text>
    <circle cx="48" cy="186" r="13" fill="#0d9488"/><text x="48" y="191" font-size="12" font-weight="700" fill="#fff" text-anchor="middle">3</text>
    <rect x="80" y="160" width="600" height="52" rx="6" fill="#f0fdfa" stroke="#cbd5e1"/>
    <text x="96" y="180" fill="currentColor">worktree 隔离　cli.py:14012-14033</text>
    <text x="96" y="200" font-size="10" fill="#64748b">_prune_stale_worktrees() → _setup_worktree()，成功则设 TERMINAL_CWD + atexit 清理</text>
    <circle cx="48" cy="252" r="13" fill="#0d9488"/><text x="48" y="257" font-size="12" font-weight="700" fill="#fff" text-anchor="middle">4</text>
    <rect x="80" y="226" width="600" height="52" rx="6" fill="#f0fdfa" stroke="#cbd5e1"/>
    <text x="96" y="246" fill="currentColor">cli = HermesCLI(model, toolsets, provider, resume, ...) — 构造编排器</text>
    <text x="96" y="266" font-size="10" fill="#64748b">build_preloaded_skills_prompt() 技能预加载；worktree 上下文注入 system_prompt</text>
    <circle cx="48" cy="324" r="13" fill="#0d9488"/><text x="48" y="329" font-size="12" font-weight="700" fill="#fff" text-anchor="middle">5</text>
    <rect x="80" y="292" width="600" height="64" rx="6" fill="#faf5ff" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="96" y="312" fill="currentColor">分流：</text>
    <text x="110" y="328" font-size="10" fill="#64748b">--list-tools / --list-toolsets → 打印后 sys.exit(0)</text>
    <text x="110" y="342" font-size="10" fill="#64748b">query 或 image（单查询）→ cli.chat(query) 后退出</text>
    <text x="110" y="354" font-size="10" fill="#64748b">否则 → cli.run() 进入交互循环</text>
  </g>
  <line x1="400" y1="54" x2="400" y2="66" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar2)"/>
  <line x1="400" y1="102" x2="400" y2="112" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar2)"/>
  <line x1="400" y1="148" x2="400" y2="158" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar2)"/>
  <line x1="400" y1="212" x2="400" y2="224" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar2)"/>
  <line x1="400" y1="278" x2="400" y2="290" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#ar2)"/>
</svg>
<span class="figure-caption">图 R2.2 ｜ cli.py 的 main() 五步：UTF-8 兜底、网关分流、worktree 隔离、构造 HermesCLI、按模式分流。</span>

<details>
<summary>ASCII 原版</summary>

```text
cli.py:13930  main(query, model, toolsets, skills, resume, worktree, ...)
   │
   1. configure_windows_stdio()           UTF-8 兜底（横幅会打 Unicode）
   │
   2. if gateway:  asyncio.run(start_gateway()); return     网关分流
   │
   3. worktree 隔离                         cli.py:14012-14033
   │    use_worktree = worktree or w or CLI_CONFIG.get("worktree")
   │    _prune_stale_worktrees() → _setup_worktree()
   │    成功则设 TERMINAL_CWD，注册 atexit 清理
   │
   4. cli = HermesCLI(model, toolsets, provider, resume, ...)   构造编排器
   │    技能预加载: build_preloaded_skills_prompt(parsed_skills)
   │    worktree 上下文注入 system_prompt
   │
   5. 分流:
   │    --list-tools / --list-toolsets  → 打印后 sys.exit(0)
   │    query 或 image (单查询模式)      → cli.chat(query) 后退出
   │    否则                            → cli.run()  进入交互循环
```

</details>

### worktree 隔离

`--worktree`（或 `-w`，或 config 里的 `worktree: true`）让这个 CLI 会话跑在一个独立的 git worktree 里，这样多个并行 agent 在同一个 repo 上工作时不会互相踩。`cli.py:14012-14033` 的逻辑：先 `_prune_stale_worktrees()` 清理崩溃会话残留的 worktree，再 `_setup_worktree()` 创建新的；成功后把 worktree 路径写进 `TERMINAL_CWD` 环境变量（工具子进程会读它），并注册 `atexit` 钩子在退出时清理。worktree 的路径与分支信息还会被注入 agent 的 `system_prompt`（`cli.py:14090-14098`），让模型知道自己在隔离环境里、记得提交和推送。

注意一个安全细节：如果用户**显式**要求 worktree 但创建失败，`main()` 直接 `return`（`cli.py:14029-14031`）——绝不静默退化到无隔离运行。

### 技能预加载

`--skills hermes-agent-dev,github-auth` 这类参数在 `cli.py:14075-14087` 处理。`build_preloaded_skills_prompt()` 把技能内容拼成一段提示，追加到 `cli.system_prompt`。一个关键的设计决定（见 `AGENTS.md:150`）：技能内容是作为**用户消息**注入的，不是塞进 system prompt——这样做是为了保护 prompt 缓存（system prompt 改动会让供应商的 prefix 缓存失效）。这里 `main()` 走的是 system_prompt 路径用于 CLI 启动期预加载，运行时 slash 命令触发的技能则走用户消息路径。

### 交互模式 vs 单查询模式

`cli.py:14152` 起的分流决定了 CLI 的两种形态：

- **单查询模式（`-q` / `--query`，或 `--image`）**：`cli.chat(query)` 跑一个回合就退出。其中又分 `--quiet`（`-Q`）的**机器可读**子模式（`cli.py:14155-14216`）——关掉横幅、spinner、工具预览，stdout 只剩最终回复，`session_id` 走 stderr，专供自动化脚本——和普通单查询模式（`cli.py:14217-14239`，跳过欢迎横幅以省下约 420ms 冷启动，但保留人类友好的输出）。
- **交互模式**：`cli.run()`（`cli.py` 中 `HermesCLI` 的方法）。这是你敲裸 `hermes` 时看到的那个带 prompt_toolkit 输入、slash 命令补全、流式工具输出的界面。它内部是一个读取输入 → 调 `agent.run_conversation()` → 显示 → 再读取的循环。

单查询模式还专门安装了 SIGTERM/SIGHUP 信号处理器（`cli.py:14129-14150`）。原因很微妙：交互模式在 `run()` 里有自己的信号处理，但 `-q` 模式直接调 `agent.run_conversation()`，而 agent 会为工具派生 worker 线程。如果 SIGTERM 到达主线程时只抛 `KeyboardInterrupt`，只能展开主线程；跑在 worker 线程里的子进程（用 `os.setsid` 派生、自成进程组）会被 reparent 成孤儿继续运行。信号处理器因此改为调用 `agent.interrupt()`——设置 per-thread 中断标志，给 worker 一个宽限窗口去 kill 子进程组，然后才抛 `KeyboardInterrupt`。中断机制的细节见 [第 3 章](03-conversation-loop.md)。

### `gateway` 在 `cli.py` 内的分流

`cli.py:main()` 的第 2 步有一个容易忽略的分支——`gateway` 不止能从 `hermes gateway` 子命令进,裸 `hermes --gateway` 也会在 `cli.py` 里被截获:`if gateway: asyncio.run(start_gateway()); return`。这是个早退分支,在 worktree 隔离、`HermesCLI` 构造之前就 `return`,因为网关有自己的进程模型(长期运行的 asyncio loop)和自己的配置加载路径(2.7 的第三条),与交互式 CLI 的同步循环完全不同。把它放在 `main()` 靠前的位置,是为了让"网关其实是另一种东西"这件事在代码结构上一目了然——它借用了 `cli.py` 的入口,但越过了交互式 CLI 的几乎所有初始化。

### `HermesCLI` 构造期做了什么

`cli.py:main()` 的第 4 步 `cli = HermesCLI(model, toolsets, provider, resume, ...)` 是入口层与核心层的交接点。这个构造函数(在 `cli.py` 中)负责:解析 `--model` / `--provider` 成具体的 provider 配置;把 `--toolsets` 解析成工具集列表;若有 `--resume`,从会话存储加载历史消息;调 `build_preloaded_skills_prompt()` 把 `--skills` 指定的技能拼进 `system_prompt`;若在 worktree 里,把 worktree 路径与分支注入 `system_prompt`。构造完成后,`HermesCLI` 内部持有一个(或按需创建)`AIAgent` 实例——入口层的使命到此基本结束,后面的 `cli.run()` 或 `cli.chat()` 只是驱动这个已经装配好的对象。换句话说,从 2.1 到这里的全部分支、解析、环境变量设置,目的都是为了让 `HermesCLI(...)` 这一行拿到正确的参数。

---

## 2.4 五大入口对比

同一个 `AIAgent` 核心被多种前端复用，这是 Hermes 架构的核心收益。把它们摆在一起对比，能看清每种入口"喂给 agent 什么、从 agent 拿什么"：

<svg viewBox="0 0 800 290" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Five entrypoints all sharing the AIAgent core">
  <defs>
    <marker id="ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="270" y="20" width="260" height="56" rx="10" fill="#fed7aa" stroke="#ea580c" stroke-width="1.6"/>
  <text x="400" y="44" font-size="13" font-weight="700" fill="currentColor" text-anchor="middle">AIAgent 核心</text>
  <text x="400" y="64" font-size="11" fill="#64748b" text-anchor="middle">run_conversation() · 所有入口共享</text>
  <g font-size="11">
    <rect x="20" y="170" width="140" height="96" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
    <text x="90" y="194" font-weight="700" fill="currentColor" text-anchor="middle">交互式 CLI</text>
    <text x="90" y="214" font-size="10" fill="#64748b" text-anchor="middle">cli.py</text>
    <text x="90" y="230" font-size="10" fill="#64748b" text-anchor="middle">HermesCLI</text>
    <rect x="172" y="170" width="140" height="96" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
    <text x="242" y="194" font-weight="700" fill="currentColor" text-anchor="middle">消息网关</text>
    <text x="242" y="214" font-size="10" fill="#64748b" text-anchor="middle">gateway/run.py</text>
    <rect x="324" y="170" width="152" height="96" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
    <text x="400" y="194" font-weight="700" fill="currentColor" text-anchor="middle">批量运行</text>
    <text x="400" y="214" font-size="10" fill="#64748b" text-anchor="middle">batch_runner.py</text>
    <text x="400" y="230" font-size="10" fill="#64748b" text-anchor="middle">mini_swe_runner.py</text>
    <rect x="488" y="170" width="140" height="96" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
    <text x="558" y="194" font-weight="700" fill="currentColor" text-anchor="middle">TUI</text>
    <text x="558" y="214" font-size="10" fill="#64748b" text-anchor="middle">ui-tui +</text>
    <text x="558" y="230" font-size="10" fill="#64748b" text-anchor="middle">tui_gateway</text>
    <rect x="640" y="170" width="140" height="96" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
    <text x="710" y="194" font-weight="700" fill="currentColor" text-anchor="middle">ACP</text>
    <text x="710" y="214" font-size="10" fill="#64748b" text-anchor="middle">acp_adapter</text>
  </g>
  <line x1="400" y1="76" x2="400" y2="110" stroke="#94a3b8" stroke-width="1.4"/>
  <line x1="90" y1="110" x2="710" y2="110" stroke="#94a3b8" stroke-width="1.4"/>
  <line x1="90" y1="110" x2="90" y2="168" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar3)"/>
  <line x1="242" y1="110" x2="242" y2="168" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar3)"/>
  <line x1="400" y1="110" x2="400" y2="168" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar3)"/>
  <line x1="558" y1="110" x2="558" y2="168" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar3)"/>
  <line x1="710" y1="110" x2="710" y2="168" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar3)"/>
</svg>
<span class="figure-caption">图 R2.3 ｜ 五种前端入口都构造并复用同一个 AIAgent 核心，差异只在输入来源与进程模型。</span>

<details>
<summary>ASCII 原版</summary>

```text
                          ┌──────────────────────┐
                          │   AIAgent 核心        │
                          │  run_conversation()   │
                          └──────────┬───────────┘
                                     │ 所有入口共享
        ┌──────────────┬─────────────┼──────────────┬───────────────┐
        ▼              ▼             ▼              ▼               ▼
   交互式 CLI       消息网关       批量运行         TUI            ACP
   cli.py          gateway/      batch_runner    ui-tui +        acp_adapter
   HermesCLI       run.py        mini_swe_       tui_gateway
                                 runner.py
```

</details>

| 入口 | 启动命令 | 输入来源 | 进程模型 | 主要用途 |
|---|---|---|---|---|
| 交互式 CLI | `hermes` | 终端 stdin（prompt_toolkit） | 单进程，同步循环 | 日常人机对话 |
| 消息网关 | `hermes gateway` | Telegram/Discord/Slack/... | 单进程 asyncio，多平台并发 | 从聊天软件远程使用 agent |
| 批量运行 | `batch_runner.py` / `mini_swe_runner.py` | prompt 文件 / 数据集 | 多进程并行 worker | 轨迹生成、评测、训练数据 |
| TUI | `hermes --tui` | Ink (React) UI | Node 子进程 + Python 后端，stdio JSON-RPC | 现代终端体验 |
| ACP | `hermes acp` | 编辑器（VS Code/Zed/JetBrains） | ACP server | IDE 集成 |

三种"主力"入口的差异：

- **交互式 CLI** 是同步的、单进程的，一次只服务一个会话。它的代码在 `cli.py`，详见 [第 13 章](13-gateway.md) 之外的 CLI 相关章节。
- **消息网关**（`hermes gateway`）是一个 asyncio 进程，同时桥接多个平台。它为每条入站消息构造一个新的 `AIAgent`（缓存命中时复用），细节见 [第 13 章 消息网关](13-gateway.md)。
- **批量运行**（`batch_runner.py` 的 `main()`，`batch_runner.py:1128`；以及 SWE-bench 风格的 `mini_swe_runner.py`）派生多进程 worker 并行跑 agent，每个 prompt 一条轨迹，主要服务研究和评测，详见 [第 14 章 批量运行与轨迹压缩](14-batch-trajectory.md)。

`batch_runner.py` 作为独立入口（不经过 `hermes` 命令树），它的开头同样以 `import hermes_bootstrap` 开场（`batch_runner.py:23-28`，带 `ModuleNotFoundError` 兜底），印证了 2.2 说的"每个入口点只要顶端 import bootstrap 就够了"。它的并发模型用 `multiprocessing.Pool`（`batch_runner.py:41` / `899`）：`with Pool(processes=self.num_workers) as pool` 派生固定数量的 worker 进程,每个进程独立构造 `AIAgent` 跑一批 prompt。选多进程而非多线程是因为每条轨迹要完全隔离的 agent 状态与工具沙箱,进程边界天然提供这种隔离。这与交互式 CLI 的"单进程同步循环"形成鲜明对比——同一个 `AIAgent` 核心,被并发度需求完全相反的两种入口复用。

TUI 走的是另一条路（`main.py:1439` 的 `_launch_tui`）：Node 端的 Ink (React) UI 通过 stdio 上的换行分隔 JSON-RPC 和 Python 端的 `tui_gateway` 通信，TypeScript 拥有屏幕，Python 拥有会话/工具/模型调用。ACP adapter（`acp_adapter/entry.py`）则把 Hermes 包装成 Agent Client Protocol server 供编辑器调用。

### `run_agent.py`：作为库被 import 的入口

除了上述以"启动进程"为目的的入口,还有一个性质不同的入口——`run_agent.py`。它定义了 `AIAgent` 类本身,本章前面所有路线最终都收敛到它的 `run_conversation()`。它的 docstring 写明了它的另一种用法:

```python
from run_agent import AIAgent
agent = AIAgent(base_url="...", model="claude-opus-4-20250514")
response = agent.run_conversation("Tell me about the latest Python updates")
```

也就是说 `run_agent.py` 既是核心模块,也是一个"库式入口"——任何 Python 代码都能直接 `import` 它、绕过整个 `hermes_cli` 命令树构造 agent。这正是 `batch_runner.py`、`tui_gateway`、ACP server 在底层做的事:它们不是平行于 `AIAgent` 的实现,而是 `AIAgent` 的不同包装。`run_agent.py` 同样以 `import hermes_bootstrap` 开场(`run_agent.py:23` 起,带 `ModuleNotFoundError` 兜底),因为它可能是某个嵌入式调用方加载的第一个 hermes 模块。把它理解成"入口"有助于看清 2.4 那张图的本质:图里五个前端不是五份 agent,而是五种喂参数给 `AIAgent(...)` 构造函数的方式。

另一个边缘入口是 `mcp_serve.py`——它起一个 stdio MCP server,把 Hermes 的消息平台会话暴露成 MCP 工具(`conversations_list`、`messages_send` 等),让 Claude Code / Cursor / Codex 这类 MCP 客户端能读写 Hermes 管理的对话。它对应 `hermes mcp serve` 这个嵌套子命令(在 `_AGENT_SUBCOMMANDS` 门控集里,见 2.6.5),与 ACP 的区别在于:ACP 把 Hermes 当 agent 后端,MCP server 把 Hermes 的会话当工具数据源。

### `cmd_xxx` 薄转发器模式与惰性 import

观察 `main.py` 里大多数 `cmd_xxx` 处理函数，会发现一个一致的模式——它们是薄转发器，函数体只有一句惰性 import 加一句调用：

```python
def cmd_gateway(args):
    """Gateway management commands."""
    from hermes_cli.gateway import gateway_command
    gateway_command(args)
```

`cmd_claw`、`cmd_gateway`、`cmd_proxy` 等都是这个形状。把 import 放在函数体内（而非模块顶部）是有意为之的**启动期优化**:`hermes config get x` 这样的轻命令不该为了一个它不会用到的子命令而付 import 代价。`cmd_proxy`(`main.py:1496`)的注释把这点说得很直白——它惰性 import 是因为代理功能依赖 `aiohttp`,而 `aiohttp` 被 gated 在 extras 安装里,没装代理/网关的用户根本不该在 import 时撞到它。

这个模式与 2.6.4 的发现门控、2.6 的 `_plugin_cli_discovery_needed()` 是同一套启动期哲学的三个侧面:**只为你真正要跑的命令付代价**。`main.py` 文件本身近 12000 行、注册 42 个子命令,如果所有 `cmd_xxx` 都在顶部 import,裸 `hermes --help` 都会慢得难以接受。薄转发器把每个子命令的真实实现推迟到它被选中的那一刻。

除了这五个，还有一条更轻量的旁路：`main.py:12386-12398` 的顶层 `--oneshot` / `-z`——它**完全绕过 `cli.py`**，直接调用 `hermes_cli/oneshot.py` 的 `run_oneshot()`，stdout 只输出最终回复，连横幅和会话管理都省了，是比 `-q --quiet` 更极致的自动化入口。

`run_oneshot()`（`hermes_cli/oneshot.py:124`）的实现体现了"为自动化而生"的取舍：

- **彻底静音 stdlib 日志**——`logging.disable(logging.CRITICAL)`。`AIAgent`、工具、provider 适配器都通过 root logger 往 stderr 写日志，oneshot 把它们全部压掉，但 `setup_logging()` 挂的文件 handler 不受影响（按文件落盘照常），只是没有字节到达终端。
- **`--provider` 不带 `--model` 直接报错**——把用户配置的模型搬到另一个 provider 通常是错的（那个 provider 未必托管该模型），静默选目标 provider 的目录默认值又会掩盖这个错配。oneshot 因此要求调用方显式给出，且校验放在 stderr 重定向之前，保证错误信息能到达终端。

oneshot 与 `-q --quiet` 的边界：两者输出都干净，但 `-q` 仍走 `cli.py`、保留会话持久化与 `HermesCLI` 编排器；oneshot 连这些都不要，最适合 `RESULT=$(hermes -z "...")` 这样嵌进 shell。

---

## 2.5 TUI 入口：Ink 前端与 `tui_gateway` 后端

`hermes --tui`（或环境变量 `HERMES_TUI=1`）走的不是 `cli.py`，而是一条 Node + Python 双进程的路线。分流点在 `cmd_chat` 的第一行（`main.py:1331`）：

```python
use_tui = getattr(args, "tui", False) or os.environ.get("HERMES_TUI") == "1"
```

`cmd_chat` 仍会先做完 `--continue`/`--resume` 解析、首次运行守卫、技能同步、各种环境变量开关（2.1 列出的那一套），然后在 `main.py:1439` 处分流：`use_tui` 为真就调用 `_launch_tui(...)` 并把所有相关参数转交给它（`main.py:1440-1456`），否则才 `from cli import main`。这意味着 TUI 和经典 CLI 共享同一段引导前缀，只在最后一步分叉。

### 进程模型

`_launch_tui()`（`main.py:1175`）的职责是"把当前进程替换成 TUI"。它不直接构造 agent，而是派生一个 Node 子进程跑 Ink (React) 终端 UI，再由那个 Node 进程反过来派生 Python 的 `tui_gateway` 后端：

<svg viewBox="0 0 780 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="TUI two-process model: Node Ink frontend and Python tui_gateway backend">
  <defs>
    <marker id="ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g font-size="11">
    <rect x="260" y="18" width="260" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
    <text x="390" y="40" font-weight="700" fill="currentColor" text-anchor="middle">hermes --tui</text>
    <rect x="120" y="76" width="540" height="98" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
    <text x="140" y="98" font-weight="700" fill="currentColor">cmd_chat → _launch_tui()　main.py:1175</text>
    <text x="140" y="118" font-size="10" fill="#64748b">· 准备 env：HERMES_PYTHON / HERMES_CWD / HERMES_TUI_*（model/toolsets/skills/...）</text>
    <text x="140" y="135" font-size="10" fill="#64748b">· NODE_OPTIONS 注入 --max-old-space-size=8192 + --expose-gc（防长会话 V8 OOM）</text>
    <text x="140" y="152" font-size="10" fill="#64748b">· mkstemp 一个 active-session 文件用于退出摘要</text>
    <text x="140" y="168" font-size="10" fill="#94a3b8">subprocess.call(node dist/entry.js)</text>
    <rect x="120" y="198" width="540" height="56" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="140" y="220" font-weight="700" fill="currentColor">Node / Ink 进程（ui-tui/）</text>
    <text x="140" y="238" font-size="10" fill="#64748b">拥有屏幕渲染（输入框、流式渲染、面板布局）</text>
    <rect x="120" y="296" width="540" height="56" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
    <text x="140" y="318" font-weight="700" fill="currentColor">python -m tui_gateway.entry　tui_gateway/entry.py</text>
    <text x="140" y="336" font-size="10" fill="#64748b">拥有会话 / 工具 / 模型调用 / AIAgent</text>
  </g>
  <line x1="390" y1="52" x2="390" y2="74" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar4)"/>
  <line x1="390" y1="174" x2="390" y2="196" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar4)"/>
  <text x="400" y="190" font-size="10" fill="#64748b">subprocess.call</text>
  <line x1="260" y1="254" x2="260" y2="294" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar4)"/>
  <text x="270" y="278" font-size="10" fill="#64748b">派生 Python 子进程</text>
  <path d="M540,296 L540,256" fill="none" stroke="#94a3b8" stroke-width="1.4" stroke-dasharray="3,2" marker-end="url(#ar4)"/>
  <path d="M560,256 L560,296" fill="none" stroke="#94a3b8" stroke-width="1.4" stroke-dasharray="3,2" marker-end="url(#ar4)"/>
  <text x="550" y="278" font-size="10" fill="#94a3b8" text-anchor="middle">stdio 换行分隔 JSON-RPC</text>
</svg>
<span class="figure-caption">图 R2.4 ｜ TUI 的双进程模型：Node/Ink 拥有屏幕，Python tui_gateway 拥有 AIAgent，两端经 stdio JSON-RPC 通信。</span>

<details>
<summary>ASCII 原版</summary>

```text
hermes --tui
   │
   ▼
cmd_chat → _launch_tui()                    main.py:1175
   │  · 准备 env：HERMES_PYTHON / HERMES_CWD /
   │    HERMES_TUI_* 一组参数（model/toolsets/
   │    skills/query/resume/checkpoints…）
   │  · NODE_OPTIONS 注入 --max-old-space-size=8192
   │    + --expose-gc（防长会话 V8 OOM）
   │  · mkstemp 一个 active-session 文件用于退出摘要
   │
   ▼  subprocess.call(node dist/entry.js)
Node / Ink 进程（ui-tui/）                   拥有屏幕渲染
   │
   ▼  派生 Python 子进程
python -m tui_gateway.entry                  tui_gateway/entry.py
   │  拥有会话 / 工具 / 模型调用 / AIAgent
   │
   └─ stdio 上换行分隔 JSON-RPC ◄────► Node 端
```

</details>

职责切分很清晰：**TypeScript 拥有屏幕**（输入框、流式渲染、面板布局），**Python 拥有一切有状态的东西**（`AIAgent`、会话持久化、工具执行、provider 调用）。两端通过子进程 stdio 上的换行分隔 JSON-RPC 帧通信。

### 参数如何过桥

`_launch_tui()` 不能像 `cli_main(**kwargs)` 那样直接传 Python 参数——它派生的是 Node 进程。所有参数因此被编码进环境变量（`main.py:1232-1269`）：`HERMES_MODEL`、`HERMES_TUI_TOOLSETS`、`HERMES_TUI_SKILLS`、`HERMES_TUI_QUERY`、`HERMES_TUI_RESUME`、`HERMES_TUI_CHECKPOINTS` 等。Node 端读这些变量，再在发起 JSON-RPC 时转交给 `tui_gateway`。两个值得注意的细节：

- **V8 堆扩容**（`main.py:1270-1280`）：Node 默认堆上限约 1.5–4GB，长会话里堆积的大段 transcript 和 reasoning blob 会触发 fatal OOM。`_launch_tui` 强制注入 `--max-old-space-size=8192` 和 `--expose-gc`，但用 token 级合并——若用户已在 `NODE_OPTIONS` 里设了更高的值就尊重它，也不重复加 `--expose-gc`。
- **worktree 在父进程创建**（`main.py:1210-1230`）：`--tui --worktree` 时，worktree 由 `_launch_tui` 自己调 `cli` 里的 `_setup_worktree()` 创建，路径通过 `HERMES_CWD` / `TERMINAL_CWD` 传给子进程，退出时在 `finally` 里 `_cleanup_worktree()`。这是因为 Python 后端是孙进程，让父进程统一管理 worktree 生命周期更可靠。

### `tui_gateway` 后端的进程卫生

`tui_gateway/entry.py` 是 Python 后端的入口，开头两件事就体现了它作为"被派生的子进程"的特殊处境：

```python
_src_root = os.environ.get("HERMES_PYTHON_SRC_ROOT", "")
if _src_root and _src_root not in sys.path:
    sys.path.insert(0, _src_root)
# 剔除 '' 和 '.'——它们在 import 时解析为 CWD，
# 会让 CWD 下的本地目录遮蔽已安装的 hermes 包
sys.path = [p for p in sys.path if p not in {"", "."}]
```

因为 TUI 后端常常跑在用户的项目目录里，而项目里可能恰好有个 `utils/` 之类的目录会遮蔽 Hermes 自己的包，所以它必须把 `HERMES_PYTHON_SRC_ROOT`（由 `_launch_tui` 设置）插到 `sys.path` 最前面、并剔除指向 CWD 的条目。

后端的另一处工程考量是关停。`entry.py` 安装了信号处理器记录"信号打在了哪个线程的哪一行"，并给出 `HERMES_TUI_GATEWAY_SHUTDOWN_GRACE_S`（默认 1 秒）的关停宽限窗口：先记栈、给后台线程 1 秒自然 drain，超时则 `os._exit(0)` 兜底，防止某个握着 `_stdout_lock` 的线程把解释器关停卡死。这里的根因是 `SIG_DFL` 处理 `SIGPIPE` 会在任何后台线程(TTS 播放、提示音、语音状态发射器)向一个 TUI 已停止读取的 stdout 写入的瞬间静默杀死进程——内核在解释器跑任何东西之前就把进程收割了,崩溃日志根本看不到 Python 异常。装上处理器后,至少能在崩溃日志里留下"信号打在哪"的栈。

传输层（`tui_gateway/transport.py`）把 JSON-RPC 的 I/O sink 抽象成 `Transport` 协议——任何能接受一个可 JSON 序列化的 dict 并转发给对端的东西都算。当前请求的活动传输用 `contextvars.ContextVar` 跟踪,使得派发到 worker 池上的 handler 也能把写入路由到正确的对端。这套抽象的好处是同一套 dispatcher 既能跑在 stdio 上（`tui_gateway.entry`）也能跑在 WebSocket 上（`tui_gateway.ws`,供 dashboard 嵌入聊天标签页用）。`transport.py` 还区分"对端没了"和"主机有真 I/O 问题"两类错误:`_PEER_GONE_ERRNOS`(`EPIPE` / `ECONNRESET` / `EBADF` / `ESHUTDOWN`)被当作干净断连静默吞掉,集合外的错误 re-raise 进崩溃日志。TUI 的渲染与协议细节见 [第 12 章](12-tui.md)。

### TUI 退出摘要

`_launch_tui` 在派生 Node 进程前用 `tempfile.mkstemp` 建了一个 active-session 文件,路径通过 `HERMES_TUI_ACTIVE_SESSION_FILE` 传给子进程(`main.py:1198-1202`)。TUI 运行期会把当前会话 ID 写进这个文件;子进程正常退出(退出码 0 或 130)后,`_print_tui_exit_summary()`(`main.py:824`)读它,在终端打印一行"如何继续这个会话"的提示,例如 `hermes --tui --resume <id>` 或 `hermes --tui -c "<标题>"`。文件在 `finally` 里 `os.unlink` 清掉。这个小机制弥补了 TUI 接管全屏后退出即清屏、用户来不及记会话 ID 的体验缺口。

---

## 2.6 子命令体系

`hermes` 命令是一棵相当宽的子命令树。所有子命令都在 `hermes_cli/main.py` 的 `main()` 函数体里集中注册——这个函数因此长达近 3000 行，绝大部分是 `subparsers.add_parser(...)` 调用。

注册的标准模式（以 `model` 命令为例，`main.py:9751-9791`）：

```python
model_parser = subparsers.add_parser(
    "model",
    help="Select default model and provider",
    description="Interactively select your inference provider and default model",
)
model_parser.add_argument("--portal-url", help="...")
# ... 更多 add_argument ...
model_parser.set_defaults(func=cmd_model)        # ← 关键：绑定处理函数
```

`set_defaults(func=...)` 是把分发逻辑交给 argparse 的关键——解析完成后 `args.func` 就指向正确的处理函数，`main()` 末尾一句 `args.func(args)` 就完成分发。从 `main.py` 里 grep `set_defaults(func` 可以列出全部子命令，主要的有：

| 子命令 | 处理函数 | 职责 |
|---|---|---|
| `chat`（默认） | `cmd_chat`（`main.py:1329`） | 交互式 / 单查询对话 |
| `model` | `cmd_model`（`main.py:1754`） | 选择 provider 和默认模型 |
| `tools` | `cmd_tools`（`main.py:11341`） | 配置启用哪些工具 |
| `config` | `cmd_config`（`main.py:10799`） | 读写单个配置项 |
| `gateway` | `cmd_gateway`（`main.py:1489`） | 启动消息网关 |
| `setup` | `cmd_setup`（`main.py:1729`） | 完整 setup 向导 |
| `doctor` | `cmd_doctor`（`main.py:10623`） | 诊断问题 |
| `update` | `cmd_update`（`main.py:11897`） | 升级到最新版 |
| `cron` | `cmd_cron`（`main.py:10461`） | 管理 cron 调度任务 |
| `sessions` | `cmd_sessions`（`main.py:11731`） | 浏览历史会话 |
| `mcp` | `cmd_mcp`（`main.py:11491`） | 管理 MCP server |
| `skills` | `cmd_skills`（`main.py:11031`） | 浏览/管理技能 |
| `memory` | `cmd_memory`（`main.py:11262`） | 管理记忆 |
| `plugins` | `cmd_plugins`（`main.py:11095`） | 管理插件 |
| `fallback` | `cmd_fallback`（`main.py:9796`） | 管理 failover provider 链 |
| `profile` | —（`main.py:11984`） | 多 profile 隔离实例管理 |
| `acp` | `cmd_acp`（`main.py:11957`） | 启动 ACP server |

几个值得注意的注册期优化：

- **延迟插件发现**：`main.py:9705` 的 `_plugin_cli_discovery_needed()`。插件可以贡献自己的子命令，但发现插件每次要花约 500-650ms。这个函数检查第一个位置参数是否是已知内建子命令——是的话就完全跳过插件发现。只有遇到未知 token（可能是插件命令，也可能是聊天 prompt）时才付这个代价。
- **嵌套子命令的 hook 门控**：`main.py:12342-12384`。插件发现、MCP 工具发现、shell hook 注册只在"会真正跑 agent 的命令"上执行——`_AGENT_COMMANDS = {None, "chat", "acp", "rl"}`，外加 `cron run`、`gateway run`、`mcp serve` 这些嵌套子命令。`hermes hooks list`、`cron list` 这类纯查询命令不付发现成本，也不会触发 hook 的 consent 提示。

`main()` 的参数解析本身还有一处巧思——双段解析（`main.py:12300-12328`）：

```python
_known_cmds = set(subparsers.choices.keys())
_has_cmd_token = any(
    t in _known_cmds for t in _processed_argv if not t.startswith("-"))

if _has_cmd_token:
    subparsers.required = True              # 第一段：严格
    try:
        sys.stderr = _io.StringIO()         # 吞掉这一段的错误输出
        args = parser.parse_args(_processed_argv)
        sys.stderr = _saved_stderr
    except SystemExit as exc:
        sys.stderr = _saved_stderr
        if exc.code == 0:
            raise                            # --help/--version 已打印，直接退出
        subparsers.required = False         # 第二段：宽松，重新解析
        args = parser.parse_args(_processed_argv)
else:
    subparsers.required = False
    args = parser.parse_args(_processed_argv)
```

逻辑是"先严格、失败再宽松":argv 里含已知子命令 token 时,把 `subparsers.required` 设为 `True` 强制确定性路由,并临时把 stderr 重定向到 StringIO(因为这一段如果失败,它的错误输出是噪音);若解析抛 `SystemExit` 且退出码非 0(子命令名被当成了某个 flag 的值,典型如 `hermes -c model` 里 `model` 被 `--continue` 吞掉),就把 `subparsers` 改回可选再解析一遍。退出码为 0 的情况(`--help` / `--version` 已经打印过输出)直接 re-raise——否则第二段会把同一份 help 文本再打印一次(`#10230`)。这套设计同时满足两个相互冲突的诉求:对真正写错的子命令给出好的错误信息,又不破坏 `-c <session-name>` 这类合法用法。

### 2.6.1 子命令分组与各自职责

`grep set_defaults(func` 在 `main.py` 里得到约 42 条命令绑定。按职责把它们分成几组，更容易理解这棵树的形状：

**配置与引导组** —— 让一台新机器从零跑起来。`setup`（`cmd_setup`，`main.py:10071`）是完整的交互式向导：检测 provider、采集凭证、写 `config.yaml`、装可选技能；`postinstall`（`cmd_postinstall`，`main.py:10082`）是 pip/uv 安装后由打包脚本自动触发的一次性钩子。`model`（`cmd_model`，`main.py:9791`）只负责"选 provider + 选默认模型"这一个子任务，是 `setup` 的轻量子集，日常换模型用它而不必跑整个向导。`config`（`cmd_config`，`main.py:10799`）是点路径式的单项读写：`hermes config get agent.max_turns` / `hermes config set compression.threshold 0.6`。`tools`（`cmd_tools`，`main.py:11341`）和 `fallback`（`cmd_fallback`，`main.py:9827`）分别管理"启用哪些工具集"和"failover provider 链"。

**诊断与维护组** —— `doctor`（`cmd_doctor`，`main.py:10623`）跑一组健康检查：provider 可达性、依赖版本、配置结构、TUI 的 Node 环境，把问题连同修复建议一并打印。`update`（`cmd_update`，`main.py:11897`）做 git-reset + `uv pip install -e .` 的自我升级；注意 ACP 入口（`acp_adapter/entry.py:18-26`）对"git-reset 已落地、`uv pip install` 还没跑完"这种 update 中途态有专门的 `ModuleNotFoundError` 兜底。`backup` / `import`（`main.py:10729` / `10762`）做 `~/.hermes/` 的快照与恢复——`hermes claw migrate` 的 `--no-backup` 关掉的就是它。`logs`（见 2.5.3）和 `dump`（`cmd_dump`，`main.py:10639`）服务事后排查。

**运行时入口组** —— 真正会构造 `AIAgent` 的命令：`chat`（默认）、`gateway`（`cmd_gateway`，`main.py:10021`）、`acp`（见 2.7）、`cron run` / `gateway run` / `mcp serve` 这些嵌套子命令。`_AGENT_COMMANDS`（`main.py:12342`）正是用来门控这一组的——只有它们才付插件发现、MCP 工具发现、shell hook 注册的代价。

**资源管理组** —— `sessions`、`skills`、`memory`、`plugins`、`mcp`、`profile`、`cron`、`kanban`、`hooks` 等，各自是一棵小的 CRUD 子树（`list` / `add` / `remove` / `show`），不跑 agent，因此走轻量解析路径。

### 2.6.2 `hermes claw`：OpenClaw 迁移入口

`claw`（`cmd_claw`，`main.py:11850`）是个专用的一次性迁移工具，把 OpenClaw（Hermes 的前身/同类项目）的用户状态搬进 `~/.hermes/`。它的处理函数只是个转发壳：

```python
def cmd_claw(args):
    from hermes_cli.claw import claw_command
    claw_command(args)
```

真正的逻辑在 `hermes_cli/claw.py`。该模块顶部（`claw.py:36-49`）解析迁移脚本路径：优先用仓库内 `optional-skills/migration/openclaw-migration/scripts/openclaw_to_hermes.py`，找不到再回退到从技能 Hub 安装的副本。`claw` 有两个子命令：`migrate`（默认先 dry-run 预览再确认）和 `cleanup`（归档迁移后残留的 OpenClaw 目录，防止状态碎片化）。安全开关值得注意：`--migrate-secrets` 必须显式给出才会搬运 allowlist 内的密钥（`TELEGRAM_BOT_TOKEN`、API key 等），即便用了 `--preset full` 也不例外；`migrate` 默认会先写一份恢复点 zip 到 `~/.hermes/backups/`，`--no-backup` 才跳过。

### 2.6.3 `hermes logs`：日志查看入口

`logs`（`cmd_logs`，`main.py:9581`，注册在 `main.py:12207`）是个不构造 agent 的纯查看命令，等价于一个懂 Hermes 日志格式的 `tail`。位置参数 `log_name` 选择查看哪个日志文件，默认 `agent`，可选 `errors` / `gateway`，或特殊值 `list` 列出所有日志文件及其大小。它的过滤维度直接对应日志行的结构化字段：

```text
hermes logs                    agent.log 最后 50 行
hermes logs -f                 实时跟随（tail -f）
hermes logs errors -n 100      errors.log 最后 100 行
hermes logs --level WARNING    只看 WARNING 及以上
hermes logs --session abc123   按 session ID 子串过滤
hermes logs --component tools  只看工具相关行（gateway/agent/tools/cli/cron）
hermes logs --since 30m -f     从 30 分钟前开始跟随
```

把它做成一等子命令而非让用户自己 `tail ~/.hermes/logs/agent.log` 的价值在于：`--level` / `--component` / `--session` 这些过滤器理解 Hermes 的日志行格式，能在多平台并发的 `gateway.log` 里精确切出某一个会话的轨迹——这在排查网关问题时几乎是必需的。日志体系的全貌见 [第 15 章](15-testing-config.md)。

### 2.6.4 配置写入类命令的一致性

`config` / `model` / `tools` / `setup` 这几个命令的共同点是它们都会**写** `~/.hermes/config.yaml`,因此都依赖 `load_config()` / `save_config()`(`hermes_cli/config.py`)这对函数,而不碰 `load_cli_config()`。这是 2.7 那条"必须知道你在哪条加载器上"规则的直接体现:它们看到的是 `DEFAULT_CONFIG` 这棵权威默认树,改的 key 也按这棵树的结构落盘。

它们之间是粒度递进的关系:

- `hermes config set <点路径> <值>` —— 最细,改一个 key。
- `hermes model` —— 中等,交互式选 provider + 默认模型,等价于改 `model.*` 那一小簇 key。
- `hermes tools` —— 改 `toolsets` / 工具启用状态。
- `hermes setup` —— 最粗,把上面这些连同凭证采集、技能安装全跑一遍。

`save_config()` 写回时会保留 `_config_version`,并把内嵌的安全注释块(`config.py` 里的 `_SECURITY_COMMENT` 等)一并写出,使生成的 YAML 自带文档。`config get` 这类纯读命令则属于 2.6.1 的"资源管理组",不付发现成本。

### 2.6.5 注册期的发现门控

`main()` 在解析完命令之后、分发之前，有一段决定"要不要付昂贵的发现成本"的逻辑（`main.py:12342-12384`）。三件昂贵的事——插件发现、MCP 工具发现、shell hook 注册——只在确实会跑 agent 的命令上做：

```python
_AGENT_COMMANDS = {None, "chat", "acp", "rl"}
_AGENT_SUBCOMMANDS = {
    "cron":    ("cron_command",  {"run", "tick"}),
    "gateway": ("gateway_command", {"run"}),
    "mcp":     ("mcp_action",    {"serve"}),
}
_sub_attr, _sub_set = _AGENT_SUBCOMMANDS.get(args.command, (None, None))
if args.command in _AGENT_COMMANDS or (
    _sub_attr and getattr(args, _sub_attr, None) in _sub_set
):
    discover_plugins()
    discover_mcp_tools()
    register_from_config(load_config(), accept_hooks=_accept_hooks)
```

两层门控的原因不同：

- **顶层命令门控**：`hermes hooks list`、`hermes sessions list`、`hermes config get` 这类纯查询命令不跑 agent，没必要付插件发现（约 500-650ms）和 MCP 发现的代价，也不该触发 hook 注册时的 consent 提示。
- **嵌套子命令门控**：`cron` / `gateway` / `mcp` 这些命令名下既有"管理"子命令（`cron list`）也有"运行"子命令（`cron run`）。只有运行态才需要 agent 环境，所以门控要看嵌套子命令的值——`getattr(args, "cron_command", None) in {"run", "tick"}`。

注意 MCP 工具发现特意从 `model_tools.py` 的模块作用域移到了这里（`main.py:12363-12366` 的注释）：放在模块作用域会让网关收到第一条消息时、在它的 event loop 里被惰性 import 触发，从而冻结整个 loop。在 CLI/TUI 启动期没有 event loop 在跑，inline 发现是安全的。

与此配对的还有 `_plugin_cli_discovery_needed()`（`main.py:9705`）——它在更早的 parser 构建阶段决定要不要为了"插件可能贡献子命令"而去发现插件。判据是第一个位置参数是否为已知内建子命令：是则跳过发现（内建命令不可能来自插件），只有遇到未知 token（可能是插件命令，也可能是聊天 prompt）时才付这个代价。这两处优化合起来，让 `hermes config get x` 这样的高频轻量命令几乎零启动开销。

---

## 2.7 配置加载的三条路径

Hermes 同一份 `~/.hermes/config.yaml`，有**三个不同的加载函数**。这看起来是冗余，但 `AGENTS.md:377` 把它列为一条"必须知道你在哪条路径上"的硬规则：

```text
┌────────────────────────┬─────────────────────────┬──────────────────────────┐
│ 加载器                  │ 谁用它                   │ 位置                      │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ load_cli_config()      │ CLI 交互模式             │ cli.py:271                │
│                        │                         │ CLI 专属默认值 + 用户 YAML │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ load_config()          │ hermes tools / setup    │ hermes_cli/config.py      │
│                        │ 等大多数子命令           │ DEFAULT_CONFIG + 用户 YAML │
├────────────────────────┼─────────────────────────┼──────────────────────────┤
│ 直接 YAML 加载          │ 网关运行时               │ gateway/run.py +          │
│                        │                         │ gateway/config.py，读原始  │
└────────────────────────┴─────────────────────────┴──────────────────────────┘
```

为什么是三条而不是一条？

1. **`load_cli_config()`（`cli.py:271`）** 服务交互式 CLI。CLI 有一批只对终端界面有意义的默认值（横幅、spinner、skin、工具进度显示模式等），这些不属于通用 `DEFAULT_CONFIG`。`load_cli_config()` 把这批 CLI 专属默认值和用户 YAML 合并。注意 `cli.py` 在**模块 import 时**就执行 `CLI_CONFIG = load_cli_config()`——这正是 `--ignore-user-config` 必须通过环境变量 `HERMES_IGNORE_USER_CONFIG` 在 import 前传入的原因。

2. **`load_config()`（`hermes_cli/config.py`）** 服务 `hermes tools`、`hermes setup` 和大多数子命令。它合并的是权威的 `DEFAULT_CONFIG`（`hermes_cli/config.py:470`，一棵带 `_config_version` 版本号的大字典）和用户 YAML。新增一个配置项时，要加进 `DEFAULT_CONFIG`；只有当需要主动迁移/改结构时才 bump `_config_version`（`hermes_cli/config.py:1648`，当前为 23）——单纯加新 key 由 deep-merge 自动处理，不需要 bump。

3. **网关直接 YAML 加载**（`gateway/run.py` + `gateway/config.py`）。网关是个长期运行的 asyncio 进程，它读原始用户 YAML。

`AGENTS.md:385` 给出了这条规则的实用价值：**如果你加了一个新配置 key，CLI 能看到但网关看不到（或反之），那就是你用错了加载器**——检查 `DEFAULT_CONFIG` 的覆盖情况。三条路径的存在本质上是"不同前端有不同的默认值需求"，但权威的非默认值（用户实际写在 YAML 里的）三条路径看到的是同一份。

配置体系还有一条相关规则——**工作目录**（`AGENTS.md:388`）：CLI 用进程的当前目录（`os.getcwd()`）；消息平台用 `config.yaml` 里的 `terminal.cwd`，网关把它桥接成 `TERMINAL_CWD` 环境变量供子工具读取。

`TERMINAL_CWD` 这个环境变量是入口层一个反复出现的桥接点,把它在各入口的来源摆在一起能看清它的角色:

| 入口 | `TERMINAL_CWD` 来源 |
|---|---|
| 交互式 CLI（普通） | 不设,工具用 `os.getcwd()` |
| 交互式 CLI（`--worktree`） | `_setup_worktree()` 后写入 worktree 路径（`cli.py:14012-14033`） |
| TUI（`--worktree`） | `_launch_tui` 写入,同时设 `HERMES_CWD`（`main.py:1230`） |
| 消息网关 | 由 `config.yaml` 的 `terminal.cwd` 桥接而来 |

它的存在解决的是同一个问题:agent 派生的工具子进程(shell 命令、代码执行)必须知道"我该在哪个目录里干活",而这个目录未必等于 Python 进程的 CWD——worktree 隔离时它是隔离目录,网关里它是配置指定的目录。把它统一成一个环境变量,工具侧就只需读一处,不必关心自己是被哪种入口启动的。这正是 2.3 worktree 小节和 2.5 TUI 小节都提到设 `TERMINAL_CWD` 的原因——它们在为同一个下游契约供值。

读取单个配置值时，运行时代码常用 `cfg_get()`（`agent/agent_init.py:52` 处 `from hermes_cli.config import cfg_get`），它是一个支持点路径（如 `"delegation.max_iterations"`）的便捷读取器。

### 2.7.1 `load_config()` 的合并细节

把 `load_config()`（`hermes_cli/config.py:4231`）拆开看，"加载一份配置"实际包含五步：

```python
config = copy.deepcopy(DEFAULT_CONFIG)          # 1. 从权威默认值出发
# ...
user_config = yaml.safe_load(f) or {}           # 2. 读用户 YAML
# 兼容旧版顶层 max_turns → agent.max_turns
config = _deep_merge(config, user_config)        # 3. 深合并：用户值覆盖默认值
normalized = _normalize_root_model_keys(
    _normalize_max_turns_config(config))         # 4. 规范化历史遗留 key
expanded = _expand_env_vars(normalized)          # 5. 展开 ${ENV_VAR}
```

几个要点：

- **deep-merge 而非整体替换**。`_deep_merge` 递归地把用户 YAML 叠加到 `DEFAULT_CONFIG` 上——用户只写他想改的 key，其余全部继承默认值。这正是"加新 key 无需 bump `_config_version`"的原因：新 key 出现在 `DEFAULT_CONFIG` 里，旧用户的 YAML 没写它，deep-merge 会自动补上默认值。
- **结果带缓存**。`load_config()` 用 `(config_path, mtime_ns, size)` 做缓存键，缓存命中时返回 `deepcopy`——因为大量调用方会就地修改返回值（`cfg["model"]["default"] = ...` 然后 `save_config`）。缓存键含路径，所以 `hermes profile` 切换 `HERMES_HOME` 时不会撞缓存。
- **历史兼容层**。`_normalize_root_model_keys` / `_normalize_max_turns_config` 把早期版本的顶层 key（如裸 `max_turns`）搬到现在的嵌套位置。这是"宁可在加载时静默规范化，也不强迫老用户改 YAML"的取舍。

`load_cli_config()`（`cli.py:271`）的结构类似，但默认值是另一棵树——内嵌在函数体里的 `defaults` 字典（`cli.py:303` 起），覆盖的是 `terminal`、`browser`、`compression`、`agent`、`display` 等 CLI 关心的分支。它和 `load_config()` 看同一份用户 YAML，差异只在"未被用户覆盖时的兜底值"。`--ignore-user-config` 在两个加载器里都生效：检测到 `HERMES_IGNORE_USER_CONFIG=1` 就跳过 `~/.hermes/config.yaml`，只留内建默认值加项目级 `cli-config.yaml`——这也是为什么该开关必须在 `import cli` 之前通过环境变量设好（`cli.py` 在 import 期就执行 `CLI_CONFIG = load_cli_config()`）。

`_config_version` 当前是 23（`hermes_cli/config.py:1648`）。它只在需要**主动迁移**（重命名 key、改结构、删旧字段）时才 bump；`check_config_version()`（`config.py:3144`）比对用户配置版本与最新版本，触发迁移流程。版本迁移的全貌见 [第 15 章](15-testing-config.md)。

---

## 2.8 ACP adapter：编辑器集成入口

`hermes acp`（`cmd_acp`，`main.py:11957`）把 Hermes 包装成一个 [Agent Client Protocol](https://agentclientprotocol.com/) server，供 VS Code、Zed、JetBrains 这类编辑器作为 AI agent 后端调用。`cmd_acp` 本身是个薄转发器：

```python
def cmd_acp(args):
    try:
        from acp_adapter.entry import main as acp_main
        acp_argv = []
        if getattr(args, "acp_version", False):
            acp_argv.append("--version")
        # ... --check / --setup / --setup-browser / --yes ...
        acp_main(acp_argv)
    except ImportError:
        print("ACP dependencies not installed.", file=sys.stderr)
        print("Install them with:  pip install -e '.[acp]'", file=sys.stderr)
        sys.exit(1)
```

真正的入口是 `acp_adapter/entry.py` 的 `main()`，它也可以被直接调用——`python -m acp_adapter.entry` 或安装后的 `hermes-acp` 命令。`acp_adapter/` 目录的分工：`server.py`（ACP server 主体）、`session.py`（会话映射）、`tools.py`（工具桥接）、`permissions.py`（编辑器侧的权限提示）、`events.py`（事件流）、`bootstrap/`（编辑器侧安装脚手架）。

ACP 入口有几处与其他入口不同的工程约束：

- **stdout 是协议通道**。ACP 走 JSON-RPC over stdio，stdout 必须只跑协议帧。`entry.py` 因此把日志全部配到 stderr——任何误入 stdout 的 `print` 都会破坏与编辑器的握手。
- **update 中途态兜底**。`entry.py:18-26` 对 `import hermes_bootstrap` 包了 `ModuleNotFoundError` 捕获：`hermes update` 可能在"git-reset 已落地新代码、`uv pip install -e .` 还没跑完"的中途态被打断，此时 bootstrap 模块可能尚未注册进 venv。POSIX 上 bootstrap 是 no-op，跳过无害；Windows 上则牺牲 UTF-8 stdio 设置换取不崩溃。
- **良性探针降噪**。`_BENIGN_PROBE_METHODS = {"ping", "health", "healthcheck"}`（`entry.py:44`）。编辑器客户端会周期性发这些非 ACP 方法做存活探测，路由器正确回 JSON-RPC `-32601`，但 supervisor 任务随后会把它当后台任务失败打一条 traceback。`_BenignProbeMethodFilter` 这个 `logging.Filter` 专门吞掉这类探针引发的 traceback，同时保留所有其他后台错误可见——`-32601` 协议响应本身保持不变，客户端（如 acp-bridge）仍把它当"agent 存活"解读，只是 stderr 不再每个探针周期吐一遍栈。

`cmd_acp` 透传给 `acp_main` 的几个标志（`main.py:11961-11973`）对应 ACP 入口的几种非 server 模式：`--version` 打印版本；`--check` 做依赖与环境自检（类似 `doctor` 但聚焦 ACP）；`--setup` / `--setup-browser` 跑编辑器侧集成的安装脚手架（`acp_adapter/bootstrap/`），把 Hermes 注册成编辑器认得的 agent；`--yes` 跳过其中的确认提示。也就是说 `hermes acp` 不带标志才真正起 server，带这些标志时它是个一次性的配置/诊断工具。ACP 的会话语义、工具桥接与权限模型见专门讨论编辑器集成的章节。

---

## 2.9 单查询模式与会话恢复

入口层在真正进 `cli.py` / TUI 之前，还要处理两组与"会话"相关的参数：单查询模式和 `--continue` / `--resume`。

### 单查询模式（`-q`）的三个层级

"跑一次就退出"在 Hermes 里其实有三档，越往下越精简：

| 模式 | 触发 | 路径 | 输出 |
|---|---|---|---|
| 普通单查询 | `-q "..."` | `cli.py:14217` `cli.chat(query)` | 跳过欢迎横幅（省约 420ms 冷启动），保留人类友好输出 |
| 机器可读单查询 | `-q -Q` / `--quiet` | `cli.py:14155` | 关横幅/spinner/工具预览，stdout 只剩最终回复，`session_id` 走 stderr |
| oneshot | `-z` / `--oneshot` | `hermes_cli/oneshot.py` | 完全绕过 `cli.py`，连会话管理都省 |

三者的取舍是"自动化友好度 vs 功能完整度"：`oneshot` 最适合嵌进 shell 管道，普通单查询则保留了会话持久化和可读输出。

机器可读单查询模式（`-q -Q`）有一份隐式契约值得自动化脚本作者知道:**stdout 只跑最终回复,session ID 走 stderr**。这条 stream 分离让 `RESULT=$(hermes -q -Q "...")` 拿到的纯粹是回复正文,而需要会话 ID 续接的脚本可以单独捕获 stderr。它同时关掉横幅、spinner、工具预览——这些在交互式终端里是体验,在管道里是污染。`oneshot` 比它更进一步,连 stdlib 日志都 `logging.disable(logging.CRITICAL)`(见 2.4),但代价是丢掉会话持久化。三档模式因此覆盖了从"我要可读地跑一次"到"我要把它当 unix 工具用"的完整光谱。

### `--continue` / `--resume` 的解析

会话恢复的解析全在 `cmd_chat` 开头（`main.py:1334-1365`），早于任何 agent 构造。两个参数的关系是：`--continue` 最终都会被归一化成 `--resume <session-id>`。

`--continue`（`-c`）有两种形态：

- **带参数**（`-c "重构 PR"`）：`_resolve_session_by_name_or_id()` 按标题或 ID 解析；解析不到就报错退出，提示 `hermes sessions list`。
- **不带参数**（裸 `-c`）：`_resolve_last_session(source=...)` 取最近一次会话。`source` 按当前是否 TUI 取 `"tui"` 或 `"cli"`——而且有个跨源回退：TUI 模式下若没有 TUI 会话，会再试 `source="cli"`（`main.py:1349-1350`），让用户能从经典 CLI 会话无缝切到 TUI 继续。

`--resume <值>` 本身也走一遍 `_resolve_session_by_name_or_id()`——它既接受裸 session ID，也接受会话标题。解析失败时**不报错**（`main.py:1361-1365`），而是把原值原样传下去，由 `_init_agent` 在更靠后的位置给出"Session not found"——这样错误信息只在一个地方产生。

`main()` 顶层还有一条捷径（`main.py:12401-12414`）：裸 `hermes --resume xxx`（不带 `chat` 子命令）会被识别为 chat 的简写，补齐属性后直接转 `cmd_chat`。

### worktree 隔离再探

`--worktree` 在两条路径上都生效但实现位置不同：经典 CLI 在 `cli.py:14012-14033` 的 `main()` 里建（见 2.3），TUI 在 `_launch_tui` 里建（见 2.5）。共同点是：`_prune_stale_worktrees()` 先清理崩溃会话残留 → `_setup_worktree()` 建新的 → 路径写进 `TERMINAL_CWD` 供工具子进程读 → `atexit` / `finally` 清理。共同的安全约束是：用户**显式**要 worktree 而创建失败时，绝不静默退化到无隔离运行——经典 CLI 直接 `return`，TUI 直接 `sys.exit(1)`。

---

## 2.10 启动期的 banner 与 skin 引擎

`cli.py` 在模块 import 阶段（`CLI_CONFIG = load_cli_config()` 之后）就完成了若干"界面引擎"的初始化，远早于 `main()` 被调用。

**skin 引擎**（`cli.py:638-643`）：

```python
try:
    from hermes_cli.skin_engine import init_skin_from_config
    init_skin_from_config(CLI_CONFIG)
except Exception:
    pass  # 皮肤引擎是可选的——失败则退回 default 皮肤
```

`init_skin_from_config()`（`skin_engine.py:785`）从 `CLI_CONFIG["display"]["skin"]` 取皮肤名，调 `set_active_skin()` 设进模块级全局 `_active_skin`。之后 CLI 各处通过 `get_active_skin().get_color(key, fallback)` 读颜色。皮肤体系还有一个值得注意的钩子——`_install_skin_light_mode_hook()`（`cli.py:1470`）在 import 时包装 `SkinConfig.get_color`，让每一次颜色读取都经过浅色模式重映射：某些皮肤的"近白色"（如 banner 文字 `#FFF8DC`）在浅色终端上不可读，钩子把它们换成更深的等价色。这是"在最底层一次性修，而不是在每个调用点判断"的设计。

**banner 与更新检查**：欢迎横幅由 `hermes_cli/banner.py` 的 `build_welcome_banner()`（`banner.py:450`）构建。它和更新检查是解耦的：`cmd_chat` 在引导早期就 `prefetch_update_check()`（`banner.py:402`，`main.py:1400-1405`）在后台线程发起版本检查，让网络往返与其余初始化重叠；等横幅真正要渲染时，结果通常已经就绪，于是 "有新版本可用" 这行提示能直接拼进横幅而不阻塞启动。单查询模式（`-q`）会跳过横幅渲染，这正是它能省下约 420ms 冷启动的来源——构建横幅本身（含 Rich 面板布局、版本标签格式化）有可观成本。

横幅里全是 Unicode 制表符，这也回扣到 2.2：Windows UTF-8 bootstrap 必须在第一个 `print` 之前完成，否则横幅就是第一个崩溃点。

---

## 2.11 启动链全景时序

把前面各节串起来，一次裸 `hermes`（非 TUI、非单查询）从进程启动到对话循环开始的完整时序：

<svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Full startup timeline from hermes to run_conversation">
  <defs>
    <marker id="ar5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g font-size="10.5">
    <rect x="290" y="16" width="220" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
    <text x="400" y="36" font-weight="700" fill="currentColor" text-anchor="middle">$ hermes</text>
    <rect x="120" y="64" width="560" height="100" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.1"/>
    <text x="136" y="84" font-weight="700" fill="currentColor">[hermes 脚本 / main()]</text>
    <text x="136" y="102" fill="#64748b">configure_windows_stdio() — UTF-8 引导（Win-only）　main.py:9728</text>
    <text x="136" y="120" fill="#64748b">构建 argparse parser + 注册 ~42 个子命令</text>
    <text x="136" y="136" fill="#94a3b8">_plugin_cli_discovery_needed() — 已知子命令则跳过插件发现</text>
    <text x="136" y="154" fill="#64748b">双段解析 argv（先严格、失败再宽松）　main.py:12300</text>
    <rect x="120" y="182" width="560" height="174" rx="8" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.2"/>
    <text x="136" y="202" font-weight="700" fill="currentColor">[cmd_chat]　main.py:1329（args.command is None → cmd_chat）</text>
    <text x="136" y="222" fill="#64748b">use_tui? = args.tui or HERMES_TUI==1</text>
    <text x="136" y="240" fill="#64748b">解析 --continue → 归一化为 --resume &lt;id&gt;；解析 --resume（按标题或 ID）</text>
    <text x="136" y="258" fill="#64748b">首次运行守卫：无 provider → 引导 hermes setup</text>
    <text x="136" y="276" fill="#64748b">prefetch_update_check() 后台版本检查；sync_skills(quiet=True) 同步内建技能</text>
    <text x="136" y="294" fill="#64748b">设环境开关：HERMES_YOLO_MODE / IGNORE_USER_CONFIG / IGNORE_RULES / SESSION_SOURCE</text>
    <text x="136" y="312" fill="#64748b">_pin_kanban_board_env()</text>
    <text x="136" y="338" fill="#94a3b8">use_tui=true → _launch_tui() 派生 Node(Ink) → Python(tui_gateway)，TUI 路线见 2.5</text>
    <rect x="120" y="374" width="560" height="70" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="136" y="394" font-weight="700" fill="currentColor">use_tui=false → from cli import main as cli_main</text>
    <text x="136" y="412" fill="#64748b">import cli 触发模块级初始化：CLI_CONFIG = load_cli_config()</text>
    <text x="136" y="430" fill="#64748b">init_skin_from_config() · _install_skin_light_mode_hook() · neuter_async_httpx_del()</text>
    <rect x="120" y="462" width="560" height="110" rx="8" fill="#faf5ff" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="136" y="482" font-weight="700" fill="currentColor">[cli.py:13930　main()]</text>
    <text x="136" y="500" fill="#64748b">configure_windows_stdio() 二次兜底；gateway? → start_gateway(); return</text>
    <text x="136" y="518" fill="#64748b">worktree 隔离 _prune → _setup_worktree → TERMINAL_CWD</text>
    <text x="136" y="536" fill="#64748b">cli = HermesCLI(...) 构造编排器（技能预加载、worktree 注入 system_prompt）</text>
    <text x="136" y="554" fill="#64748b">单查询 → cli.chat(query) → exit；否则 → cli.run() → AIAgent.run_conversation()（第 3 章）</text>
  </g>
  <line x1="400" y1="46" x2="400" y2="62" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar5)"/>
  <line x1="400" y1="164" x2="400" y2="180" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar5)"/>
  <line x1="400" y1="356" x2="400" y2="372" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar5)"/>
  <line x1="400" y1="444" x2="400" y2="460" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar5)"/>
</svg>
<span class="figure-caption">图 R2.5 ｜ 一次裸 hermes（非 TUI、非单查询）从进程启动到 run_conversation() 转动的完整引导时序。</span>

<details>
<summary>ASCII 原版</summary>

```text
$ hermes
 │
 ├─[hermes 脚本]            from hermes_cli.main import main; main()
 │
 ├─[main.py:9728]           configure_windows_stdio()         UTF-8 引导（Win-only）
 ├─[main.py]                构建 argparse parser + 注册 ~42 个子命令
 │                          · _plugin_cli_discovery_needed()  已知子命令则跳过插件发现
 ├─[main.py:12300]          双段解析 argv（先严格、失败再宽松）
 │
 ├─ args.command is None →  补齐 cmd_chat 期望属性 → cmd_chat(args)
 │
 └─[cmd_chat / main.py:1329]
     │
     ├─ use_tui? = args.tui or HERMES_TUI==1
     ├─ 解析 --continue → 归一化为 --resume <id>
     ├─ 解析 --resume（按标题或 ID）
     ├─ 首次运行守卫：无 provider → 引导 hermes setup
     ├─ prefetch_update_check()         后台线程发起版本检查
     ├─ sync_skills(quiet=True)         同步内建技能
     ├─ 设环境开关：HERMES_YOLO_MODE / HERMES_IGNORE_USER_CONFIG /
     │              HERMES_IGNORE_RULES / HERMES_SESSION_SOURCE
     ├─ _pin_kanban_board_env()
     │
     ├─ use_tui ─true─►  _launch_tui()  派生 Node(Ink) → Python(tui_gateway)
     │                                  ＊本图到此分叉，TUI 路线见 2.5
     │
     └─ use_tui false ►  from cli import main as cli_main
         │               ＊import cli 触发模块级初始化：
         │                 · CLI_CONFIG = load_cli_config()
         │                 · init_skin_from_config()
         │                 · _install_skin_light_mode_hook()
         │                 · neuter_async_httpx_del()
         │
         └─[cli.py:13930  main()]
             ├─ configure_windows_stdio()        二次兜底
             ├─ gateway? → asyncio.run(start_gateway()); return
             ├─ worktree 隔离 _prune → _setup_worktree → TERMINAL_CWD
             ├─ cli = HermesCLI(...)              构造编排器
             │   · build_preloaded_skills_prompt()  技能预加载入 system_prompt
             │   · worktree 上下文注入 system_prompt
             ├─ --list-tools / --list-toolsets → 打印后 exit(0)
             ├─ query / image (单查询) → cli.chat(query) → exit
             └─ 否则 → cli.run()                  进入交互循环
                         │
                         └─► AIAgent.run_conversation()   见第 3 章
```

</details>

这张图覆盖了本章讨论的全部分支点：UTF-8 引导（2.2）、子命令注册与解析（2.6）、TUI 分流（2.5）、配置加载（2.7）、worktree（2.9）、skin/banner 初始化（2.10）。从敲下 `hermes` 到 `run_conversation()` 转动，控制权依次穿过启动器脚本、`main()`、`cmd_chat`、`cli.py:main()`、`HermesCLI`——每一层都只做自己那一段引导，再把控制权交给下一层。

---

## 延伸阅读

- [第 1 章 导论与全局架构](01-architecture-overview.md)——四层架构、目录导览、`get_hermes_home()` 路径解析。
- [第 3 章 核心对话循环](03-conversation-loop.md)——入口层构造出 `AIAgent` 之后，`run_conversation()` 如何驱动一个回合。
- [第 4 章 Provider 适配与凭证池](04-provider-credentials.md)——`hermes model` 选定的 provider 如何在运行时被解析。
- [第 12 章 TUI 前端](12-tui.md)——Ink 渲染、`tui_gateway` 后端、JSON-RPC 协议的完整细节。
- [第 13 章 消息网关](13-gateway.md)——`hermes gateway` 入口的完整架构、多平台并发模型。
- [第 14 章 批量运行与轨迹压缩](14-batch-trajectory.md)——`batch_runner.py` 与 `mini_swe_runner.py` 的多进程模型。
- [第 15 章 测试、配置与可观测性](15-testing-config.md)——`DEFAULT_CONFIG`、`_config_version` 迁移机制的全貌。
