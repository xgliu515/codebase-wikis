# Trace 步骤 03 —— 构造 HermesCLI 与三路配置加载

## 1. 当前情境

上一步结束时，`args` 解析完毕，`args.func` 指向 `cmd_chat`，`main()` 把控制权交给了 `cmd_chat(args)`。我们的 trace 走的是裸 `hermes`——没有 `--tui`、没有 `HERMES_TUI=1`，所以 `cmd_chat` 里 `use_tui` 判定为否，走的是经典 CLI 路径（而不是 Ink 写的现代 TUI）。

此刻进程里依然没有任何 Hermes 业务对象：没有配置字典、没有 `HermesCLI` 实例、没有 agent。`cmd_chat` 做完一串前置检查（首次运行 guard、`--continue` 解析、skill 同步……）后，会把参数打包成 kwargs，调进 `cli.py` 的 `main()`。这一步要回答的是：**配置从哪来、怎么合并、`HermesCLI` 实例如何诞生**。

## 2. 问题

Hermes 要在一个 `HermesCLI` 对象里就位「这次会话所有的行为参数」——用什么模型、终端用本地还是 Docker、压缩阈值多少、显示是否流式、最大工具迭代次数……几十上百个旋钮。这些旋钮的取值来源不止一处：

- **内置默认值**：开箱即用，用户什么都不配也能跑。
- **用户配置文件** `~/.hermes/config.yaml`：用户长期偏好。
- **命令行参数**：本次调用的临时覆盖（`hermes --model X`）。
- **环境变量**：`.env` 文件或 shell 导出。

更麻烦的是，「`~/.hermes`」这个路径本身不是固定的——Hermes 支持 **profile**（`hermes --profile coder` 让同一台机器上多套独立配置共存），所以配置目录可能是 `~/.hermes`，也可能是 `~/.hermes/profiles/coder`。配置加载必须先知道「家在哪」。

利害关系：合并顺序错了，用户在 `config.yaml` 里设的模型会被硬编码默认值悄悄盖掉；profile 路径解析晚了，会读错目录的配置。

## 3. 朴素思路

最直觉的做法：在 `HermesCLI.__init__` 里直接 `open("~/.hermes/config.yaml")` 读一遍，`yaml.safe_load` 出一个字典，缺的键用 `dict.get(key, default)` 临时补。模型这种关键值就 `model = args.model or config.get("model") or "claude-..."` 一行搞定。

路径就硬写 `Path.home() / ".hermes"`。每个需要配置的地方各自读一次文件。

## 4. 为什么朴素思路会崩

这套做法在 Hermes 这种规模的 CLI 上会迅速失控：

- **profile 路径解析时机太晚**。如果路径硬写 `~/.hermes`，profile 功能根本无从谈起。而且 profile 必须在**任何模块导入之前**就定下来——因为 `cli.py` 在模块顶层就执行 `CLI_CONFIG = load_cli_config()`（`cli.py:620`），`agent_init.py` 等模块在 import 期间也会读 `HERMES_HOME`。等到 `__init__` 里再解析 profile，半个进程已经按错误的家目录初始化过了。
- **散点式 `dict.get` 无法表达深层合并**。`config.yaml` 是嵌套结构（`terminal.timeout`、`display.streaming`、`auxiliary.vision.model`……）。`config.get("terminal", {}).get("timeout", 60)` 这种写法散落到几百处，任何一个缺省值写错都是一个静默 bug。需要的是「内置默认整树 + 用户文件整树」做一次**深合并**。
- **格式漂移没人接得住**。`config.yaml` 里 `model:` 历史上既可能是字符串（新格式）也可能是字典（旧格式）；`max_turns` 既可能在根层也可能在 `agent.` 下。朴素 `dict.get` 把这些兼容逻辑摊到读取点，每处都得重写一遍。
- **重复读文件**。多个组件各自 `open` 配置文件，既慢又可能读到不一致的快照（用户中途改了文件）。

核心矛盾：配置不是「一个文件 + 几个 `get`」，而是「**多个来源、有优先级、需深合并、要兼容历史格式**」——这必须集中成一个流程，且要在恰当的早期时机跑。

## 5. Hermes 的做法

Hermes 把配置处理拆成「**先定家目录、再单点加载、最后实例化**」三段，并且让 profile 解析跑在最早的时刻。

### 第一段：profile 解析（最早，模块导入前）

`hermes_cli/main.py` 在**模块层**就调用 `_apply_profile_override()`（`main.py:205`，函数体在 `main.py:119`）。它在 argparse 还没跑、`cli.py` 还没导入时，手工扫一遍 `sys.argv` 找 `--profile`/`-p`，再读 `active_profile` 文件，确定 profile 名后**直接写 `os.environ["HERMES_HOME"]`** 并把 `--profile` flag 从 `sys.argv` 里剥掉（免得 argparse 不认）：

```python
# hermes_cli/main.py:176
if profile_name is not None:
    try:
        from hermes_cli.profiles import resolve_profile_env
        hermes_home = resolve_profile_env(profile_name)
    except (ValueError, FileNotFoundError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
    ...
    os.environ["HERMES_HOME"] = hermes_home
```

`_parser.py` 顶部那段注释解释了为什么 `--profile` **不在 argparse 上**：它「被 `_apply_profile_override` 在 argparse 跑之前消费掉了」。从此以后，所有代码问「家在哪」都通过 `hermes_constants.get_hermes_home()`（`hermes_constants.py:14`）——它读 `HERMES_HOME` 环境变量，没有才回退 `~/.hermes`。profile 模式下这个变量早已被填好，全进程一致。

### 第二段：单点配置加载

`cli.py` 在模块顶层执行两件事：`_hermes_home = get_hermes_home()`（`cli.py:114`）和 `CLI_CONFIG = load_cli_config()`（`cli.py:620`）。`load_cli_config()`（`cli.py:271`）是配置加载的**唯一入口**：

```python
# cli.py:288
# Check user config first ({HERMES_HOME}/config.yaml)
user_config_path = _hermes_home / 'config.yaml'
project_config_path = Path(__file__).parent / 'cli-config.yaml'

ignore_user_config = os.environ.get("HERMES_IGNORE_USER_CONFIG") == "1"

if user_config_path.exists() and not ignore_user_config:
    config_path = user_config_path
else:
    config_path = project_config_path
```

它先在函数里写死一棵**完整的内置默认树**（`defaults = {...}`，`cli.py:302` 起，覆盖 `model`/`terminal`/`browser`/`compression`/`agent`/`display`…… 全部 section），再把用户文件 `yaml.safe_load` 出来**深合并**进去（`cli.py:448-463`：两层 section 的字典做 `update`，标量直接覆盖，文件里有而默认树没有的键原样带过来）。历史格式兼容也集中在这里——`model:` 字符串还是字典的判断（`cli.py:417`）、根层 `max_turns` 提升到 `agent.max_turns`（`cli.py:468`）、`${ENV_VAR}` 展开（`cli.py:477`），都在这一个函数内解决，读取点只管拿合并后的干净字典。

注意 `--ignore-user-config`：`cmd_chat` 把它转成环境变量 `HERMES_IGNORE_USER_CONFIG=1`（`main.py:1424`），`load_cli_config()` 读到后跳过用户文件、只用内置默认 + 项目级 `cli-config.yaml`——这是为隔离的 CI / 复现场景设计的。

### 第三段：实例化 HermesCLI

`cmd_chat`（`hermes_cli/main.py:1329`）做完前置检查后，`from cli import main as cli_main`，把 `args` 打包成 kwargs 调进去（`main.py:1462-1483`）。`cli.py::main`（`cli.py:13930`）处理 worktree、toolset 解析等，然后构造实例：

```python
# cli.py:14060
cli = HermesCLI(
    model=model,
    toolsets=toolsets_list,
    provider=provider,
    api_key=api_key,
    base_url=base_url,
    max_turns=max_turns,
    verbose=verbose,
    compact=compact,
    resume=resume,
    checkpoints=checkpoints,
    pass_session_id=pass_session_id,
    ignore_rules=ignore_rules,
)
```

`HermesCLI.__init__`（`cli.py:2511`）此刻不再碰文件——它直接引用模块级已经加载好的 `CLI_CONFIG`：`self.config = CLI_CONFIG`（`cli.py:2543`），然后从里面读出几十个 display/terminal/agent 旋钮赋到 `self.*`。命令行传进来的参数（如 `model`）此处与 `CLI_CONFIG` 的值做最后一层「命令行优先」的取舍。

### 三条配置加载路径

为什么前面说「配置加载有三条路径」？因为 Hermes 不止 CLI 一个入口。`load_cli_config()`（`cli.py`，给经典 CLI/TUI）是其一；`hermes_cli/config.py` 里的 `load_config()` 是给子命令和库代码用的通用加载器（`main.py:12376` 注册 shell hook 时就用它）；消息网关（gateway）启动时又有自己的配置装配路径。三者读的是**同一个 `config.yaml`**、解析的是**同一个 `HERMES_HOME`**，但封装成不同入口，因为各自要补的默认值和上下文不同。共同的不变量是：家目录由 `get_hermes_home()` 统一裁决，profile 由 `_apply_profile_override()` 在最早时刻钉死。

<svg viewBox="0 0 780 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Three-stage configuration loading pipeline">
  <defs>
    <marker id="t3ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="300" y="14" width="180" height="30" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="390" y="34" text-anchor="middle" font-size="11" fill="currentColor">进程启动</text>
  <path d="M390,44 L390,62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t3ar)"/>
  <rect x="120" y="64" width="540" height="50" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="390" y="84" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">① main.py 模块层 ── _apply_profile_override()</text>
  <text x="390" y="101" text-anchor="middle" font-size="10" fill="#64748b">扫 sys.argv / active_profile → os.environ["HERMES_HOME"]</text>
  <path d="M390,114 L390,132" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t3ar)"/>
  <rect x="120" y="134" width="540" height="110" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="390" y="154" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">② cli.py 模块层 ── get_hermes_home() · load_cli_config()</text>
  <rect x="150" y="166" width="140" height="22" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="220" y="181" text-anchor="middle" font-size="9.5" fill="#64748b">内置默认树</text>
  <rect x="150" y="192" width="140" height="22" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="220" y="207" text-anchor="middle" font-size="9.5" fill="#64748b">config.yaml</text>
  <rect x="150" y="218" width="140" height="22" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="220" y="233" text-anchor="middle" font-size="9.5" fill="#64748b">环境变量</text>
  <path d="M290,177 L320,200" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t3ar)"/>
  <path d="M290,203 L320,203" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t3ar)"/>
  <path d="M290,229 L320,206" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t3ar)"/>
  <rect x="334" y="180" width="306" height="46" rx="5" fill="#fff" stroke="#0d9488" stroke-width="1.2"/>
  <text x="487" y="199" text-anchor="middle" font-size="10" fill="currentColor">深合并 + 格式兼容 + ${ENV} 展开</text>
  <text x="487" y="215" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">→ CLI_CONFIG 字典</text>
  <path d="M390,244 L390,262" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t3ar)"/>
  <rect x="120" y="264" width="540" height="50" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="390" y="284" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">③ cli.py::main() ── HermesCLI(model=…, toolsets=…)</text>
  <text x="390" y="301" text-anchor="middle" font-size="10" fill="#64748b">self.config = CLI_CONFIG（不再读文件）· 命令行参数做最后覆盖</text>
</svg>
<span class="figure-caption">图 T3.1 ｜ 三阶段配置加载：钉死 HERMES_HOME → 深合并三来源成 CLI_CONFIG → 实例化 HermesCLI 并由命令行参数最后覆盖。</span>

<details>
<summary>ASCII 原版</summary>

```text
   进程启动
      │
      ▼  ① main.py 模块层
   _apply_profile_override()  ──扫 sys.argv / active_profile──▶  os.environ["HERMES_HOME"]
      │
      ▼  ② cli.py 模块层
   _hermes_home = get_hermes_home()         ← 读 HERMES_HOME，回退 ~/.hermes
   CLI_CONFIG  = load_cli_config()
        │  内置默认树  ┐
        │  config.yaml ┼─ 深合并 + 格式兼容 + ${ENV} 展开 ─▶ CLI_CONFIG 字典
        │  环境变量    ┘
      │
      ▼  ③ cli.py::main()
   cli = HermesCLI(model=…, toolsets=…, …)   ← self.config = CLI_CONFIG（不再读文件）
                                               命令行参数做最后一层覆盖
```

</details>

到这一步结束，`HermesCLI` 实例化完成，`cli.config`（即 `CLI_CONFIG` 字典）就位，`HERMES_HOME` 已定，`session_id` 等基础字段已生成。但 `cli.agent` 此刻仍是 `None`——`AIAgent` 还没被创建。

## 6. 代码位置

按阅读顺序：

- profile 预解析：`hermes_cli/main.py:119` —— `def _apply_profile_override()`；`main.py:205` 在模块层调用它。
- 家目录裁决：`hermes_constants.py:14` —— `def get_hermes_home()`，读 `HERMES_HOME` 回退 `~/.hermes`。
- `cmd_chat` 转入 `cli.py`：`hermes_cli/main.py:1329` `def cmd_chat`；`main.py:1459-1483` 打包 kwargs 调 `from cli import main`。
- CLI 入口：`cli.py:13930` —— `def main(...)`。
- 配置加载唯一入口：`cli.py:271` —— `def load_cli_config()`；内置默认树 `cli.py:302` 起，深合并 `cli.py:448-463`。
- 模块级加载点：`cli.py:114` `_hermes_home = get_hermes_home()`；`cli.py:620` `CLI_CONFIG = load_cli_config()`。
- 实例化：`cli.py:14060` `cli = HermesCLI(...)`；`HermesCLI.__init__` 在 `cli.py:2511`，`self.config = CLI_CONFIG` 在 `cli.py:2543`。

## 7. 分支与延伸

- 下一步 `cli.py::main` 会调用 `cli._init_agent()` 创建 `AIAgent` → 见 [Trace 步骤 04](tour-04-init-agent.md)。
- 上一步把 `args` 路由到 `cmd_chat` → [Trace 步骤 02](tour-02-arg-dispatch.md)。
- 入口层全貌、`load_cli_config` 与 `hermes_cli/config.py::load_config` 的分工 → [第 2 章 入口与进程引导](02-entrypoints.md)。
- profile 到底怎么隔离多套配置、`~/.hermes` 与 `~/.hermes/profiles/<name>` 的目录布局 → [第 15 章 FAQ 与故障排查](15-faq.md) 关于 profile 的条目。
- 若 `use_tui` 为真，`cmd_chat` 会走 `_launch_tui`（`main.py:1439`）而不是 `cli.py::main`，配置加载路径也随之不同 → [第 2 章 §TUI 入口](02-entrypoints.md)。

## 8. 走完这一步你脑子里应该多了什么

1. 「家在哪」由 `get_hermes_home()` 统一裁决，而 profile（让 `~/.hermes` 变成 `~/.hermes/profiles/coder`）必须在**任何模块导入之前**由 `_apply_profile_override()` 写好 `HERMES_HOME`——因为 `cli.py` 在模块层就 `load_cli_config()` 了。
2. 配置加载是**单点**的：`load_cli_config()` 把「内置默认整树 + `config.yaml` 深合并 + 历史格式兼容 + `${ENV}` 展开」全部收进一个函数，读取点只拿合并后的干净字典，不再各自 `open` 文件。
3. `HermesCLI.__init__` **不读文件**——它引用模块级早已加载好的 `CLI_CONFIG`，命令行参数在此做最后一层「命令行优先」覆盖。
4. 配置有三条加载路径（CLI 的 `load_cli_config`、子命令/库用的 `load_config`、gateway 自己的装配），但它们共享同一个 `config.yaml` 和同一个 `HERMES_HOME`——封装不同只因上下文不同。
5. 走完这一步，`HermesCLI` 实例和 `config` 字典都就位，但 `cli.agent` 仍是 `None`。

---

下一步：[Trace 步骤 04 —— 创建 AIAgent](tour-04-init-agent.md)
