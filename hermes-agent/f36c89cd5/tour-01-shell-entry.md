# Trace 步骤 01 —— 敲下 hermes 之后，谁在跑？

## 1. 当前情境

trace 从一个空白终端开始。你输入：

```text
$ hermes
```

此刻还没有任何 Hermes 的对象、配置、agent 存在。存在的只有：操作系统的 shell、一个待解析的命令名 `hermes`，以及 `$PATH` 里某个能被找到的可执行文件。这一步要回答的是整条链路最开头、也最容易被跳过的问题——`hermes` 这个词到底指向什么，控制权是怎么落到 Python 代码里的。

## 2. 问题

`hermes` 必须能在用户的任意终端、任意当前目录下，作为一个普通命令被调用，并且行为和「subcommand 模式」（`hermes gateway`、`hermes doctor`）完全一致。同时它还有几个隐藏约束：

- 用户的机器上可能装了多个 Python；Hermes 跑在自己的 venv 里，不能误用系统 Python。
- 仓库开发者直接 `./hermes` 跑源码树，普通用户跑的是安装后 `~/.local/bin/hermes`——两条路径要殊途同归。
- 在 Windows 上，终端默认编码不是 UTF-8，banner 和中文输出会乱码——这必须在**任何东西打印之前**修好。

## 3. 朴素思路

最直觉的做法：把 `hermes` 写成一个 Python 文件，第一行 `#!/usr/bin/env python3`，正文直接 `import` 然后跑 CLI 逻辑。安装时 `chmod +x` 扔进 `$PATH`。

更"现代"一点：在 `pyproject.toml` 里写一个 `[project.scripts]` 入口点，让 pip 自动生成 launcher。

两种思路看起来都对——命令能跑起来，就完事了。

## 4. 为什么朴素思路会崩

把业务逻辑直接写进 `hermes` 这个文件，会立刻撞上几堵墙：

- **venv 绑定问题**。`#!/usr/bin/env python3` 解析出来的是 shell 当前 `PATH` 里第一个 `python3`，很可能是系统 Python，而 Hermes 的依赖（`httpx`、`rich`、`prompt_toolkit`……）只装在 venv 里。结果是 `ModuleNotFoundError`。开发者用 `./setup-hermes.sh` 装出来的 venv 必须被自动识别。
- **双入口漂移**。如果 `hermes` 脚本里塞了真实逻辑，那安装版和源码版就是两份代码，迟早不一致。
- **编码时机问题**。如果把 UTF-8 修复写在 CLI 逻辑深处，那在它生效之前任何一行 `print`（包括 import 期间的告警）都已经用错误编码输出了——乱码无法补救。
- **subcommand 一致性**。`hermes` 和 `hermes gateway` 必须共享同一套参数解析；如果裸 `hermes` 走一条捷径逻辑，subcommand 走另一条，两者行为会慢慢分叉。

核心矛盾是：`hermes` 这个文件想做的事（被当成命令调用）和它**不该**做的事（承载逻辑）必须分开。

## 5. Hermes 的做法

Hermes 把 `hermes` 脚本写成一个**极薄的加载器**——它唯一的职责就是把控制权转交出去。仓库根目录的 `hermes` 文件全文只有十来行：

```python
#!/usr/bin/env python3
"""Hermes Agent CLI launcher."""

if __name__ == "__main__":
    from hermes_cli.main import main
    main()
```

所有真实逻辑都在 `hermes_cli.main` 这个包模块里。这样无论你跑的是源码树里的 `./hermes`，还是 pip 安装后生成的 launcher，还是 `python -m hermes_cli.main`，最终都汇流到同一个 `main()` 函数——**双入口漂移**被消除了。

venv 问题由安装层解决：`setup-hermes.sh` 把 `~/.local/bin/hermes` 做成指向 venv 内解释器的包装，开发者的 `./hermes` 则依赖 `.envrc` / 已激活的 venv。脚本本身不掺和这件事，保持纯粹。

进入 `main()` 后，**第一件事**不是解析参数，而是修编码：

```python
def main():
    """Main entry point for hermes CLI."""
    # Force UTF-8 stdio on Windows before anything prints.  No-op elsewhere.
    try:
        from hermes_cli.stdio import configure_windows_stdio
        configure_windows_stdio()
    except Exception:
        pass
```

`configure_windows_stdio()` 在非 Windows 上是彻底的 no-op，在 Windows 上则重新配置 `stdout`/`stderr` 为 UTF-8。把它放在 `main()` 的**最顶端**、任何 import 副作用之后但任何业务 `print` 之前，是经过推敲的时机选择——这一行的位置本身就是设计。仓库里另有 `hermes_bootstrap.py` 提供同类的 `apply_windows_utf8_bootstrap()`，供其它入口（gateway、batch）在导入顶部调用。

紧接着是一次 Windows 专属的清理——扫掉上次 `hermes update` 留下的 `hermes.exe.old.*` 隔离文件；同样用 `try/except` 包住，非 Windows 静默跳过。

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Control flow from hermes launcher script into main()">
  <defs>
    <marker id="t1ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="200" y="16" width="360" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="34" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">hermes（仓库根，~10 行薄脚本）</text>
  <text x="380" y="49" text-anchor="middle" font-size="10" fill="#64748b">from hermes_cli.main import main</text>
  <path d="M380,56 L380,80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t1ar)"/>
  <rect x="140" y="82" width="480" height="120" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="380" y="104" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">hermes_cli/main.py :: main()</text>
  <rect x="160" y="116" width="440" height="24" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="180" y="132" font-size="10.5" fill="currentColor">① configure_windows_stdio() ── 编码必须最先修</text>
  <rect x="160" y="144" width="440" height="24" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="180" y="160" font-size="10.5" fill="currentColor">② _cleanup_quarantined_exes() ── Windows 清理</text>
  <rect x="160" y="172" width="440" height="24" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="180" y="188" font-size="10.5" fill="currentColor">③ build_top_level_parser() ── 下一步（步骤 02）</text>
  <path d="M380,202 L380,226" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t1ar)"/>
  <rect x="200" y="228" width="360" height="38" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="252" text-anchor="middle" font-size="12" fill="currentColor">参数解析与子命令分发</text>
</svg>
<span class="figure-caption">图 T1.1 ｜ 控制权从薄脚本 hermes 转入 main()，依次修编码、清理隔离文件、再构建参数解析器。</span>

<details>
<summary>ASCII 原版</summary>

```text
        hermes（仓库根，~10 行薄脚本）
              │  from hermes_cli.main import main
              ▼
        hermes_cli/main.py :: main()
              │  ① configure_windows_stdio()   ← 编码必须最先修
              │  ② _cleanup_quarantined_exes() ← Windows 清理
              │  ③ build_top_level_parser()    ← 下一步（步骤 02）
              ▼
        参数解析与子命令分发
```

</details>

到这一步结束，Python 解释器已经在跑，`hermes_cli.main` 模块已导入，编码已就位，`main()` 函数正握着控制权——但还没有解析任何参数，也还没有任何 Hermes 业务对象诞生。

## 6. 代码位置

按阅读顺序：

- 入口脚本：`hermes:9-11` —— `if __name__ == "__main__"` 里 `from hermes_cli.main import main` 然后 `main()`。
- 真正入口：`hermes_cli/main.py:9726` —— `def main()`。
- 编码修复：`hermes_cli/main.py:9729-9734` —— 调 `configure_windows_stdio()`。
- 隔离文件清理：`hermes_cli/main.py:9740` 附近 —— `_cleanup_quarantined_exes()`。
- 跨入口的 bootstrap 变体：`hermes_bootstrap.py:59` —— `apply_windows_utf8_bootstrap()`。

## 7. 分支与延伸

- 这十来行之后，`main()` 立刻构建参数解析器并分发子命令 → 见 [Trace 步骤 02](tour-02-arg-dispatch.md)。
- `hermes` 不止有 `chat` 一种子命令，还有 `model` / `gateway` / `setup` / `doctor` / `update` 等；它们如何在 `main()` 里集中注册 → [第 2 章 入口与进程引导](02-entrypoints.md)。
- 如果用户跑的是 `hermes gateway`，控制权会走向消息网关而非交互式 CLI → [第 13 章 消息网关与多平台](13-messaging-gateway.md)。
- 如果设置了 `HERMES_TUI=1` 或加了 `--tui`，`cmd_chat` 会转去启动 Ink TUI 而非经典 CLI → [第 2 章 §TUI 入口](02-entrypoints.md)。
- profile-aware 的路径（`~/.hermes` 还是 `~/.hermes-<profile>`）此刻尚未解析，要等配置加载阶段 → [Trace 步骤 03](tour-03-cli-construct.md)。

## 8. 走完这一步你脑子里应该多了什么

1. `hermes` 不是一个程序，而是一个**十来行的加载器**——它的唯一价值是把所有入口（源码 `./hermes`、安装版、`python -m`）收敛到同一个 `main()`。
2. `main()` 干的第一件正事是**修 stdio 编码**，不是解析参数；这个顺序是刻意的——编码必须在任何 `print` 之前生效。
3. Hermes 的跨平台代码模式是「`try/except` 包住、非目标平台静默 no-op」——`configure_windows_stdio` 和 `_cleanup_quarantined_exes` 都是这个样子。
4. 走完这一步，进程在跑、模块已导入、控制权在 `main()` 手里，但**还没有任何 Hermes 业务对象**——配置、CLI、agent 全都不存在。

---

下一步：[Trace 步骤 02 —— 参数解析与子命令分发](tour-02-arg-dispatch.md)
