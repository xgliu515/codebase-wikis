# 第 6 章 终端后端：七种执行环境

agent 要做事，归根结底是要跑 shell 命令——`ls`、`git`、`pytest`、`npm build`。但「在哪里跑」这件事，Hermes 给了用户七个选择：本地机器、Docker 容器、SSH 远端、Singularity/Apptainer 容器、Modal serverless、Daytona 开发环境、Vercel Sandbox。本章讲清楚这套可插拔执行环境的抽象设计，以及为什么一个 agent 框架需要这么多后端。

---

## 6.1 为什么需要可插拔的执行环境

最朴素的 agent 实现会直接 `subprocess.run(command)`——在 agent 进程所在的机器上跑命令。这对「在自己笔记本上写代码」的场景没问题，但 Hermes 的定位决定了它撑不住：

- **隔离**。agent 会自主决定跑什么命令。让一个 LLM 在你的主力机器上有 shell 权限是危险的——一次幻觉就可能 `rm` 掉重要文件。把它关进容器或一次性 sandbox 里，爆炸半径就被框住了。
- **「不绑定你的笔记本」**。Hermes 的卖点之一是 agent 活在云上：你在 Telegram 上发消息，它在一台云 VM 上干活。这要求执行环境能是远程的（SSH）、容器化的（Docker/Singularity）、甚至 serverless 的（Modal/Daytona）。
- **成本**。serverless 后端（Daytona、Modal）在空闲时休眠，几乎不花钱；需要时几秒唤醒。一个挂在 `$5 VPS` 上的 agent 和一个用 Daytona 的 agent，成本模型完全不同。
- **可复现性**。批量轨迹生成（见[第 14 章](14-cron-delegate-batch.md)）需要干净、一致的环境——容器镜像保证每个样本从同一起点出发。

所以 Hermes 不把「执行命令」写死成 `subprocess`，而是抽象成一个 `BaseEnvironment` 接口，七个后端各自实现。`terminal` 工具不关心命令最终在哪跑——它只跟接口打交道。

<svg viewBox="0 0 800 290" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="BaseEnvironment abstraction with seven terminal backends">
  <defs>
    <marker id="ar6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="250" y="16" width="300" height="38" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="400" y="40" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">terminal 工具（terminal_tool.py）</text>
  <line x1="400" y1="54" x2="400" y2="78" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6)"/>
  <text x="416" y="71" font-size="10" fill="#94a3b8">_create_environment() 读 TERMINAL_ENV</text>
  <rect x="200" y="80" width="400" height="56" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="400" y="103" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">BaseEnvironment (ABC)</text>
  <text x="400" y="122" text-anchor="middle" font-size="10.5" fill="#64748b">execute() / init_session() / cleanup()</text>
  <line x1="400" y1="136" x2="400" y2="156" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="93" y1="156" x2="707" y2="156" stroke="#94a3b8" stroke-width="1.2"/>
  <g font-size="10.5" font-weight="600">
    <line x1="93" y1="156" x2="93" y2="200" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar6)"/>
    <rect x="40" y="202" width="106" height="60" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="93" y="228" text-anchor="middle" fill="currentColor">local</text>
    <line x1="195" y1="156" x2="195" y2="200" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar6)"/>
    <rect x="152" y="202" width="86" height="60" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="195" y="228" text-anchor="middle" fill="currentColor">docker</text>
    <line x1="297" y1="156" x2="297" y2="200" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar6)"/>
    <rect x="244" y="202" width="106" height="60" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="297" y="228" text-anchor="middle" fill="currentColor">ssh</text>
    <line x1="400" y1="156" x2="400" y2="200" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar6)"/>
    <rect x="356" y="202" width="88" height="60" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="400" y="228" text-anchor="middle" fill="currentColor">singularity</text>
    <line x1="503" y1="156" x2="503" y2="200" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar6)"/>
    <rect x="450" y="202" width="106" height="60" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="503" y="228" text-anchor="middle" fill="currentColor">modal</text>
    <line x1="605" y1="156" x2="605" y2="200" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar6)"/>
    <rect x="562" y="202" width="86" height="60" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="605" y="228" text-anchor="middle" fill="currentColor">daytona</text>
    <line x1="707" y1="156" x2="707" y2="200" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar6)"/>
    <rect x="654" y="202" width="106" height="60" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="707" y="228" text-anchor="middle" fill="currentColor">vercel</text>
  </g>
  <text x="400" y="280" text-anchor="middle" font-size="10" fill="#94a3b8">terminal 工具只跟接口打交道，不关心命令最终在哪跑</text>
</svg>
<span class="figure-caption">图 R6.1 ｜ terminal 工具经 BaseEnvironment 抽象分发到七种可插拔执行后端</span>

<details>
<summary>ASCII 原版</summary>

```text
        terminal 工具（tools/terminal_tool.py）
                    │
                    │  _create_environment()  读 TERMINAL_ENV
                    ▼
        ┌───────────────────────────────────────────┐
        │          BaseEnvironment (ABC)             │
        │   execute() / init_session() / cleanup()   │
        └───────────────────────────────────────────┘
          │      │      │      │      │      │      │
        local docker  ssh  sing. modal daytona vercel
```

</details>

后端的选择由 `TERMINAL_ENV` 环境变量驱动（默认 `local`），它本身桥接自 `config.yaml` 的 `terminal.*` 配置。`tools/environments/__init__.py` 的模块 docstring 把这件事说得很直白：「The `terminal_tool.py` factory (`_create_environment`) selects the backend based on the `TERMINAL_ENV` configuration.」

## 6.2 工厂分发：_create_environment 如何挑后端

所有后端实例都从同一个工厂函数 `_create_environment`（`tools/terminal_tool.py:1112`）产出。它接受一个已规范化的 `env_type` 字符串，外加镜像名、cwd、timeout、各类 config 字典，返回一个带 `execute()` 的环境对象。理解这个工厂要先理解它的「输入是怎么来的」。

### 配置读取：_get_env_config

工厂的输入由 `_get_env_config()`（`terminal_tool.py:1009`）从环境变量整理出来。它做的第一件事是定 `env_type`，第二件事是按后端类型决定一个**合理的默认 cwd**：

```python
if env_type == "local":
    default_cwd = os.getcwd()
elif env_type == "ssh":
    default_cwd = "~"
elif env_type == "vercel_sandbox":
    default_cwd = _VERCEL_SANDBOX_DEFAULT_CWD
else:
    default_cwd = "/root"
```

差异不是随意的：本地后端理应继承用户当前所在目录；SSH 用 `~` 让 shell 在远端展开成远程 home；容器类后端默认落在 `/root`。

接着是一段容易被忽略但很关键的防御逻辑——**容器后端拒绝宿主路径**。用户的 `TERMINAL_CWD` 可能是 `/Users/alice/project` 这样的 macOS 路径，但这个路径在 Docker/Modal/Daytona 容器里根本不存在。`_get_env_config` 检测到「宿主前缀路径」或「相对路径」时，对容器后端直接丢弃该值、退回 `default_cwd`，并打一条 info 日志：

```python
elif env_type in {"modal", "docker", "singularity", "daytona", "vercel_sandbox"} and cwd:
    is_host_path = any(cwd.startswith(p) for p in host_prefixes)
    is_relative = not os.path.isabs(cwd)  # e.g. "." or "src/"
    if (is_host_path or is_relative) and cwd != default_cwd:
        logger.info("Ignoring TERMINAL_CWD=%r for %s backend ...", cwd, env_type, default_cwd)
        cwd = default_cwd
```

唯一的例外是 Docker 的 `mount_docker_cwd` 模式：此时宿主路径不是被丢弃，而是被记进 `host_cwd`、把容器内 `cwd` 重映射成 `/workspace`，后续由 `_DockerEnvironment` 把宿主目录 bind mount 进 `/workspace`。

### 分发表

`_create_environment` 的主体是一串 `if/elif`（`terminal_tool.py:1133`–`1255`），逐一对应七种后端。它先从 `container_config` 里取出共享的资源参数（cpu/memory/disk/persistent/volumes），再分发：

| `env_type` | 构造的类 | 关键行 | 备注 |
|---|---|---|---|
| `local` | `_LocalEnvironment` | `terminal_tool.py:1139` | 只传 cwd/timeout，无资源参数 |
| `docker` | `_DockerEnvironment` | `terminal_tool.py:1142` | 透传 volumes/host_cwd/forward_env 等全套 |
| `singularity` | `_SingularityEnvironment` | `terminal_tool.py:1156` | 资源参数子集 |
| `modal` | `_ModalEnvironment` / `_ManagedModalEnvironment` | `terminal_tool.py:1163` | 经 `_get_modal_backend_state` 二选一 |
| `daytona` | `DaytonaEnvironment` | `terminal_tool.py:1217` | 惰性 import SDK |
| `vercel_sandbox` | `VercelSandboxEnvironment` | `terminal_tool.py:1228` | 惰性 import，传 runtime |
| `ssh` | `_SSHEnvironment` | `terminal_tool.py:1242` | 缺 host/user 直接抛 `ValueError` |

几个值得留意的分发细节：

- **Modal 的双后端决策**最复杂。`_get_modal_backend_state` 综合「用户是否有直连 Modal 凭据」和「托管工具网关是否就绪」，得出 `selected_backend` 为 `managed` / `direct` / 都不可用。三种「都不可用」的子情况各自抛出不同措辞的 `ValueError`，明确告诉用户该去 `hermes model` 登录还是改 `TERMINAL_MODAL_MODE`。
- **Modal 的 `ephemeral_disk`** 通过 `inspect.signature` 探测 SDK 是否支持该参数后才传，避免老版本 SDK 报未知 kwarg。
- **Daytona 与 Vercel 用函数内 import**（`from tools.environments.daytona import ...`），这样它们的重型 SDK 只在真正选中该后端时才被加载，不拖累其它后端的启动。
- **未知 `env_type`** 落到最后的 `else`，抛出列举了全部七种合法值的 `ValueError`。

工厂产出的实例随后被 `_active_environments` 字典按 `task_id` 缓存复用；`_cleanup_inactive_envs`（`terminal_tool.py:1257`）定期把闲置超过 `lifetime_seconds` 的环境回收掉（细节见 6.4 与 6.6）。

### 配置项一览

`_get_env_config` 读的不只是 `TERMINAL_ENV`，它把一整套 `TERMINAL_*` 环境变量整理成配置字典。这些环境变量本身又桥接自 `config.yaml` 的 `terminal.*` 节。值得记住的几组：

| 配置维度 | 关键环境变量 | 作用范围 |
|---|---|---|
| 后端选择 | `TERMINAL_ENV` | 全部 |
| 工作目录 | `TERMINAL_CWD` | 全部（容器后端会做宿主路径校验） |
| 超时/生命周期 | `TERMINAL_TIMEOUT`（默认 180s）、`TERMINAL_LIFETIME_SECONDS`（默认 300s） | 全部 |
| 镜像 | `TERMINAL_DOCKER_IMAGE` / `TERMINAL_SINGULARITY_IMAGE` / `TERMINAL_MODAL_IMAGE` / `TERMINAL_DAYTONA_IMAGE` | 对应容器后端 |
| 容器资源 | `TERMINAL_CONTAINER_CPU` / `_MEMORY`（5GB）/ `_DISK`（50GB）/ `_PERSISTENT` | docker/singularity/modal/daytona/vercel |
| Docker 专属 | `TERMINAL_DOCKER_VOLUMES` / `_ENV` / `_FORWARD_ENV` / `_EXTRA_ARGS` / `_MOUNT_CWD_TO_WORKSPACE` / `_RUN_AS_HOST_USER` | docker |
| SSH 专属 | `TERMINAL_SSH_HOST` / `_USER` / `_PORT` / `_KEY` / `_PERSISTENT` | ssh |
| Modal 专属 | `TERMINAL_MODAL_MODE`（auto/direct/managed） | modal |
| 持久 shell | `TERMINAL_PERSISTENT_SHELL`、`TERMINAL_LOCAL_PERSISTENT` | 会话快照行为 |

注意默认镜像统一是 `nikolaik/python-nodejs:python3.11-nodejs20`——一个同时带 Python 和 Node 的镜像，为的是「最大兼容」：agent 跑的命令既可能是 `pip install` 也可能是 `npm build`，预装两套运行时省去 agent 自己装环境的来回。`_parse_env_var` 在解析这些变量时带类型校验，非法值会抛出带提示的 `ValueError`，告诉用户去哪个文件改配置。

## 6.3 抽象基类 BaseEnvironment

七个后端的统一接口定义在 `tools/environments/base.py:288` 的 `class BaseEnvironment(ABC)`。它的类 docstring 划清了基类和子类的分工：

```python
class BaseEnvironment(ABC):
    """Common interface and unified execution flow for all Hermes backends.

    Subclasses implement ``_run_bash()`` and ``cleanup()``.  The base class
    provides ``execute()`` with session snapshot sourcing, CWD tracking,
    interrupt handling, and timeout enforcement.
    """
```

这是一个经典的「模板方法」分工：

- **子类只需实现两个抽象方法**：`_run_bash()`（`base.py:327`）——把一段 bash 真正送进目标环境跑；`cleanup()`（`base.py:343`）——回收后端资源（停容器、关 SSH、销毁 sandbox）。
- **基类提供一切公共逻辑**：`execute()`（`base.py:776`）才是对外的执行入口，它在 `_run_bash()` 之上叠加了会话快照注入、CWD 跟踪、中断处理、超时控制。子类作者不用操心这些——他们只管「把命令塞进我的环境」。

这种分工的好处在写新后端时最明显：要接一个第八种后端，作者只需回答一个问题——「我怎么把一段 bash 字符串送进去跑」。会话连续性、sudo、超时、中断、活动心跳全部白送。`_run_bash` 的签名也刻意收得很窄：

```python
def _run_bash(self, cmd_string, *, login=False, timeout=120,
              stdin_data=None) -> ProcessHandle:
    ...
```

它返回一个 `ProcessHandle`——可以是 `subprocess.Popen`（local/docker/ssh/singularity），也可以是 `_ThreadedProcessHandle`（modal/daytona/vercel，用线程包裹异步或阻塞 SDK 调用，对外暴露 `poll()`/`kill()`/`stdout` 这套与 Popen 一致的接口）。基类的轮询循环只跟 `ProcessHandle` 协议打交道，不在乎它底下是真子进程还是 SDK 调用——这正是七个后端能共用一套 `_wait_for_process` 的原因。

除两个抽象方法外，还有两个**可选钩子**子类可按需重写：`_before_execute()`（每条命令前的文件同步触发点）和 `_update_cwd()`（CWD 回收方式）。基类给它们都备了合理默认，不重写也能工作。

构造函数 `__init__`（`base.py` 288 之后）为每个后端实例分配一个 12 位 `_session_id`，并据此推导出两个临时文件路径：

```python
def __init__(self, cwd: str, timeout: int, env: dict = None):
    self.cwd = cwd
    self.timeout = timeout
    self.env = env or {}
    self._session_id = uuid.uuid4().hex[:12]
    temp_dir = self.get_temp_dir().rstrip("/") or "/"
    self._snapshot_path = f"{temp_dir}/hermes-snap-{self._session_id}.sh"
    self._cwd_file = f"{temp_dir}/hermes-cwd-{self._session_id}.txt"
    self._cwd_marker = _cwd_marker(self._session_id)
    self._snapshot_ready = False
```

这两个文件（`hermes-snap-*.sh` 和 `hermes-cwd-*.txt`）是会话快照机制的物理载体，下一节展开。`get_temp_dir()` 默认返回 `/tmp`，但 `LocalEnvironment` 会重写它——在 Termux 这类没有 `/tmp` 的平台上，临时目录得用 `TMPDIR`。

类上还有两个可被子类覆盖的字段，它们是「抽象接口里留的旋钮」：

- `_stdin_mode`（默认 `"pipe"`）——Modal、Daytona、Vercel 这类用 heredoc 嵌入 stdin 的后端会改成 `"heredoc"`。
- `_snapshot_timeout`（默认 30 秒）——冷启动慢的后端可以调大；`ModalEnvironment` 就把它设成 60 秒。

## 6.4 统一执行流程：execute() 在 _run_bash 之上叠了什么

`execute()`（`base.py:776`）是对外的唯一执行入口。它把一段裸命令转成一次后端调用，中间叠了六层处理。子类作者只写 `_run_bash()`，这六层都是白送的。

```python
def execute(self, command, cwd="", *, timeout=None, stdin_data=None) -> dict:
    self._before_execute()                                    # ① 文件同步钩子
    exec_command, sudo_stdin = self._prepare_command(command) # ② sudo 变换
    exec_command = _rewrite_compound_background(exec_command) # ③ 复合后台改写
    ...
    if effective_stdin and self._stdin_mode == "heredoc":     # ④ heredoc 嵌入
        exec_command = self._embed_stdin_heredoc(exec_command, effective_stdin)
    wrapped = self._wrap_command(exec_command, effective_cwd) # ⑤ 快照包裹
    login = not self._snapshot_ready
    proc = self._run_bash(wrapped, login=login, timeout=..., stdin_data=...)
    result = self._wait_for_process(proc, timeout=...)        # ⑥ 超时/中断轮询
    self._update_cwd(result)
    return result
```

逐层拆解：

1. **`_before_execute()` 钩子**——基类是空实现。SSH/Modal/Daytona/Vercel 重写它，在每条命令前触发 `FileSyncManager.sync()`，把宿主侧改动过的凭据/skill/cache 文件推到远端（见 6.6）。Docker/Singularity 用 bind mount，宿主文件系统直接可见，不需要同步，保持空实现。

2. **`_prepare_command()`**——委托给 `_transform_sudo_command()`，把命令里的裸 `sudo` 改写成 `sudo -S -p ''`，并返回需要前置进 stdin 的密码串（见 6.7）。

3. **`_rewrite_compound_background()`**——修一个 bash 的坑：`A && B &` 会让 bash fork 一个子 shell 包住整个 `A && B` 再后台化，子 shell 随后阻塞等待一个永不退出的 `B`（服务器、`yes > /dev/null`），导致子 shell 永久泄漏。基类在深度 0（不在引号、括号、子 shell 内）把尾部的 `&` 改写成 `A && { B & }`：花括号组在当前 shell 里跑、把 `B` 作为普通后台子进程，组本身立刻退出，没有子 shell 在等。改写保留了 `&&` 的错误语义（`A` 失败则不跑 `B`）。`_rewrite_compound_background`（`terminal_tool.py:651`）做了细致的扫描——区分引号内的字面 `&`、`A & B`（中间的真后台运算符）、以及自己已经产出过的 `{ B & }`（幂等，不重复改写）。

4. **heredoc 嵌入**——`_stdin_mode == "heredoc"` 的后端（Modal/Daytona/Vercel）无法给子进程喂 stdin pipe，于是 `_embed_stdin_heredoc()`（`base.py:474`）用一个随机定界符把 stdin 数据接成 shell heredoc 拼进命令字符串：

   ```python
   delimiter = f"HERMES_STDIN_{uuid.uuid4().hex[:12]}"
   return f"{command} << '{delimiter}'\n{stdin_data}\n{delimiter}"
   ```

   定界符用 `uuid` 随机生成、且加单引号（heredoc 定界符加引号会关掉变量展开），保证即便 `stdin_data` 里恰好含有定界符文本也不会提前截断、且数据内容原样传递不被 shell 解释。嵌入后 `effective_stdin` 被清空——数据已经在命令字符串里了，不再需要单独的 stdin 流。

5. **`_wrap_command()`**——会话快照的核心包裹逻辑，下一节展开。

6. **`_wait_for_process()`**——非阻塞轮询循环，每 0.2 秒查一次进程状态，叠超时与中断（见 6.5）。

注意第 6 步之后还有一个 `_update_cwd(result)`：它从结果里解析 CWD 标记、更新 `self.cwd`，让 `cd` 的副作用对下一条命令可见。基类版本走 `_extract_cwd_from_output()`（解析 stdout 标记），`LocalEnvironment` 重写成直接读临时文件。

### ProcessHandle 与输出收集

`_run_bash` 的返回值是 `ProcessHandle`——它不是一个具体类，而是一组协议：要有 `poll()`（查是否结束）、`kill()`（终止）、`returncode`、以及一个可读的 `stdout`。`subprocess.Popen` 天然满足；SDK 后端则用 `_ThreadedProcessHandle` 适配——它内部开一个工作线程跑异步/阻塞的 SDK 调用，把 SDK 的输出喂进一个队列，对外伪装成 `Popen` 的样子。这层适配让基类的轮询循环对七个后端「一视同仁」。

输出收集也在 `_wait_for_process` 里：它另起一个 **drain 线程**持续从 `proc.stdout` 读数据塞进 `output_chunks` 列表，主轮询线程只管查状态和超时。读写分离的原因是——若主线程既轮询又读 stdout，一个写满 OS 管道缓冲区却迟迟不被读取的命令会让双方互相死锁。命令结束（或被杀）后，主线程 `drain_thread.join(timeout=2)` 等 drain 线程把残余输出收完。最终 `result["output"]` 是所有 chunk 拼接的结果，`returncode` 取自 `proc.returncode` 或三条特殊路径的约定码。

### 前台 vs 后台

`execute()` 描述的是**前台命令**：调用方阻塞等待，拿到 `{"output", "returncode"}`。前台超时上限受 `FOREGROUND_MAX_TIMEOUT`（`terminal_tool.py:108`）约束——agent 给前台命令设了超过这个上限的 `timeout` 时，terminal 工具会直接拒绝（`terminal_tool.py:1745`）并提示改用 `background=true`。这条限制存在的原因是：前台命令会占住调用链阻塞等待，一个真的要跑半小时的任务不该用前台模式霸占着 agent，而应该后台化、让 agent 腾出手干别的、稍后再查结果。`terminal` 工具的描述里也明确写了「Returns INSTANTLY when command finishes」——前台超时设高不会让你白等，命令一结束就返回，超时值只是上限。

**后台命令**走的是另一条路。terminal 工具收到 `background=true` 时不调 `execute()`，而是通过 `tools/process_registry.py` 的 `spawn_local` / `spawn_via_env`（`terminal_tool.py:1932`/`:1941`）把进程登记进进程注册表，立刻返回一个 `session_id`。后台进程的生命周期由注册表跟踪——它还反过来影响环境回收：`_cleanup_inactive_envs` 发现某 `task_id` 有活跃后台进程时，会刷新 `_last_activity` 把该环境续命，不让 sandbox 被回收掉一个正在跑的服务器。

为什么不让 agent 自己用 `nohup ... &`？因为那样起的进程脱离了 Hermes 的视线——它不知道进程还在不在、输出去了哪、agent 结束后该不该清理。`background=true` 让 Hermes 拿到进程句柄，能查状态、收输出、在会话结束时统一清理。`_foreground_background_guidance()`（`terminal_tool.py:1595`）正是为此而设：它在前台命令里检测 `nohup`/`disown`/`setsid`/尾随 `&` 等 shell 级后台手法，以及看起来会长期运行的命令（启动服务器、watcher），提示模型改用 `background=true`。两种后台模式的对应关系是：

```text
agent 写法                Hermes 行为
------------------------  -------------------------------------
terminal(bg=true)         spawn 进 process_registry，返回 session_id，可追踪
terminal("cmd &")         前台路径里被 _rewrite_compound_background 兜底，
                          但仍建议改 bg=true（_foreground_background_guidance 提示）
terminal("nohup cmd &")   脱离追踪，guidance 明确劝阻
```

## 6.5 会话快照：让无状态的命令执行「记住」环境

### 问题

LLM 一条一条地发命令。它可能先 `export API_KEY=xxx`，再 `cd src`，再 `make`。如果每条命令都是一个全新的 `bash -c`，那 `export` 和 `cd` 的效果在下一条命令里就蒸发了——这违反任何使用过终端的人的直觉。

朴素的修法是：维护一个长期存活的 shell 进程，把命令一条条喂给它的 stdin。但这对远程/容器后端很脆——一个挂了的 SSH 连接、一个被 OOM kill 的容器进程，会让整个会话状态丢失且难以恢复；而且跨平台（Windows 的 Git Bash、Termux）行为不一。还有一个隐患：长存 shell 里一条命令若读 stdin 卡住、或开了个不退出的子进程，会污染整个会话，后续命令全部受牵连。spawn-per-call（每条命令起一个新 shell）则天然把每条命令隔离开——一条卡死不影响下一条。

### Hermes 的做法

Hermes 不维护长存 shell，而是用**快照文件**模拟会话连续性。`init_session()`（`base.py:351`）在后端构造后调用一次，它的 docstring 说明了意图：

```python
def init_session(self):
    """Capture login shell environment into a snapshot file.

    Called once after backend construction.  On success, sets
    ``_snapshot_ready = True`` so subsequent commands source the snapshot
    instead of running with ``bash -l``.
    """
```

机制是这样的：

1. **首次**：用 `bash -l`（login shell）跑一遍，完整捕获环境变量、shell 函数（过滤后）、别名、shell 选项，连同当前工作目录一起，写进 `_snapshot_path` 指向的 `hermes-snap-*.sh` 脚本。设 `_snapshot_ready = True`。
2. **此后每条命令**：不再 `bash -l`（重跑 profile 脚本既慢又可能有副作用），而是 `source` 那个快照脚本来还原环境，再跑命令。
3. **命令结束**：把命令运行后的 CWD 写进 `hermes-cwd-*.txt`；下一条命令开头先读这个文件 `cd` 过去。

CWD 持久化在不同后端用了不同手法——本地后端直接读写临时文件，远程后端则在 stdout 里埋一个 `_cwd_marker`（用 `_session_id` 生成的唯一标记），从输出里解析出 CWD。这样 `cd` 的效果就跨命令保留了。

为什么只在首次用 `bash -l`、之后改 `source` 快照？`bash -l` 会完整跑一遍用户的 profile 链（`/etc/profile`、`~/.bash_profile`、`~/.bashrc` ……），这有两个代价：**慢**——profile 里可能有 `nvm`、`pyenv`、`conda` 初始化，每条命令重跑一遍累计开销可观；**有副作用**——profile 里若有 `cd ~`、`echo` 欢迎语、甚至联网检查，会污染命令输出或工作目录。首次 `bash -l` 把 profile 的「成果」（环境、函数、别名）固化进快照，之后 `source` 快照只是重放这些成果，跳过了重跑 profile 的过程，既快又干净。

每个后端实例的快照文件用 `_session_id`（12 位随机 hex）命名——`hermes-snap-<id>.sh` 和 `hermes-cwd-<id>.txt`。这保证了**会话隔离**：两个并发的 task（比如主 agent 和一个子 agent）各有各的快照文件，彼此的 `export`/`cd` 不会串味。同理 `_cwd_marker` 也带 `_session_id`，远程后端解析 CWD 时不会被另一个会话的标记干扰。

### 快照脚本捕获了什么

`init_session()` 在 login shell 里跑的 bootstrap 脚本（`base.py:372`）就是快照的「写入端」。它分四类内容追加进 `hermes-snap-*.sh`：

```python
bootstrap = (
    f"export -p > {_quoted_snap}\n"                              # 环境变量
    f"declare -f | grep -vE '^_[^_]' >> {_quoted_snap}\n"        # shell 函数（过滤）
    f"alias -p >> {_quoted_snap}\n"                              # 别名
    f"echo 'shopt -s expand_aliases' >> {_quoted_snap}\n"        # 让别名在非交互 shell 生效
    f"echo 'set +e' >> {_quoted_snap}\n"                         # 单条命令失败不中止脚本
    f"echo 'set +u' >> {_quoted_snap}\n"                         # 引用未定义变量不报错
    f"builtin cd {_quoted_cwd} 2>/dev/null || true\n"            # 还原到配置的 cwd
    f"pwd -P > {_quoted_cwd_file} 2>/dev/null || true\n"         # 落地初始 cwd 文件
    f"printf '\\n{self._cwd_marker}%s{self._cwd_marker}\\n' ...\n" # stdout 埋 CWD 标记
)
```

几处设计取舍：

- **`export -p`** 而非 `env`——`export -p` 输出的是可被 `source` 重新执行的 `declare -x` 语句，能精确还原导出属性。
- **`declare -f | grep -vE '^_[^_]'`**——捕获所有 shell 函数，但用正则把以单下划线开头（如 `_foo`）的内部/补全函数过滤掉，避免把 bash-completion 的几百个私有函数塞进每个快照。
- **`shopt -s expand_aliases`**——别名在非交互 bash 里默认不展开，写进快照才能让 `source` 后的别名真的可用。
- **`set +e` / `set +u`**——快照脚本里强制关掉 errexit 和 nounset，防止某条 `declare` 失败或某个变量为空就让整条命令链崩掉。
- **`builtin cd` 而非 `cd`**——用 `builtin` 前缀绕开用户可能定义的 `cd` 函数/别名，确保是真的内建 `cd`。注释还点出了一个微妙问题：login shell 跑 profile 脚本时，bashrc 里若有 `cd ~` 会把工作目录改掉，所以 bootstrap 必须在 profile 之后**显式 `cd` 回配置的 `cwd`**，再 `pwd -P`，否则快照记下的会是 profile 的目录而非 `terminal.cwd`。

### init_session 失败时的降级

`init_session` 不是「成功才能用」的硬依赖。它整个包在 `try/except` 里（`base.py:383`）：bootstrap 跑成功就 `_snapshot_ready = True`，跑失败（比如远程后端冷启动超时、目标环境没有 `bash`）就只打一条 warning 并把 `_snapshot_ready` 留在 `False`。

`_snapshot_ready` 这个布尔值随后在两处分叉行为：

- `execute()` 里 `login = not self._snapshot_ready`——快照没建成时，每条命令都退回 `bash -l` 模式（重跑 profile），慢一点但用户的环境变量、PATH 仍然加载得到。
- `_wrap_command()` 里 `if self._snapshot_ready` 才插入 `source 快照` 和 `回写快照` 两行——没快照就跳过，命令裸跑。

也就是说，快照是一个**纯优化**：有它，会话连续且省去重复 profile 开销；没它，功能不丢，只是退化成「每条命令独立 login shell」。这种「优化失败可降级」的设计让快照机制在七个差异巨大的后端上都能安全启用。

### 包裹脚本：_wrap_command 的「读取端」

`init_session` 之后，每条命令都经 `_wrap_command()`（`base.py:417`）包裹成一段多行 bash 脚本。它和 bootstrap 对称——bootstrap 写快照，wrap 读快照：

```python
parts = []
if self._snapshot_ready:
    parts.append(f"source {_quoted_snap} >/dev/null 2>&1 || true")  # 还原环境
parts.append(f"builtin cd -- {quoted_cwd} || exit 126")             # 进入 cwd
parts.append(f"eval '{escaped}'")                                   # 跑真正的命令
parts.append("__hermes_ec=$?")                                      # 存退出码
if self._snapshot_ready:
    parts.append(f"export -p > {_quoted_snap} 2>/dev/null || true") # 回写环境
parts.append(f"pwd -P > {_quoted_cwd_file} 2>/dev/null || true")    # 回写 cwd 文件
parts.append(f"printf '\\n{marker}%s{marker}\\n' \"$(pwd -P)\"")    # stdout 埋 cwd 标记
parts.append("exit $__hermes_ec")                                   # 透传退出码
```

这里有几个不显眼但重要的处理：

- **`source ... >/dev/null 2>&1`**——macOS 上 bash 3.2 及部分 Homebrew bash 在 `source` 含 `declare -x` 的文件时会把声明回显到 stdout，泄漏约 60 行环境变量进每个工具响应（issue #15459）。重定向到 `/dev/null` 修掉它，Linux bash 本来就静默，重定向无害。
- **回写快照**——命令跑完后再 `export -p` 一次，把本条命令里 `export` 的新变量写回快照文件。并发调用下是「last-writer-wins」。
- **`exit 126`**——`cd` 失败时用 126（命令找不到/不可执行的约定码），与命令本身的退出码区分开。
- **`eval '...'`**——命令里的单引号被预先转义成 `'\''`，整体用单引号包住交给 `eval`，保证任意命令文本都能安全传递。

### cd 目标的引用：_quote_cwd_for_cd

包裹脚本里那句 `builtin cd -- {quoted_cwd}` 的 `quoted_cwd` 由 `_quote_cwd_for_cd()`（`base.py:406`）算出，它要同时满足两个矛盾的需求——既要让 `~` 展开成 home，又要让带空格的路径保持成单个 shell 词：

```python
@staticmethod
def _quote_cwd_for_cd(cwd: str) -> str:
    if cwd == "~":            return cwd            # 裸 ~：原样，让 shell 展开
    if cwd == "~/":           return "$HOME"        # ~/ ：换成 $HOME
    if cwd.startswith("~/"):  return f"$HOME/{shlex.quote(cwd[2:])}"  # ~/sub：$HOME + 引用后缀
    return shlex.quote(cwd)                          # 普通路径：整体引用
```

如果直接 `shlex.quote("~/my dir")`，结果是 `'~/my dir'`——`~` 被引号关掉、不展开，`cd` 失败。如果直接不引用，`~/my dir` 里的空格又会把它拆成两个参数。这个函数的解法是：`~` 部分换成 `$HOME`（变量展开在双引号外也安全），后缀部分单独 `shlex.quote`，拼起来既展开了 home 又保住了空格。`--` 前缀则防止以连字符开头的目录名被 `cd` 当成选项。这是一处典型的「为边角 case 写的小函数」——绝大多数路径用不到，但带 `~` 和空格的路径没它就会出错。

### CWD 标记的解析

远程后端拿不到本地临时文件，只能从 stdout 里把 CWD「捞」出来。`_cwd_marker(session_id)`（`base.py:279`）生成形如 `__HERMES_CWD_{session}__` 的唯一标记，wrap 脚本用 `printf '\n MARKER path MARKER \n'` 把当前目录夹在两个标记之间打到 stdout。

`_extract_cwd_from_output()`（`base.py:724`）反向解析：先 `rfind` 找最后一个标记当闭合标记，再在它前 4096 字节内 `rfind` 找开合标记，取中间那段当 `self.cwd`。最后还要把标记**连同注入的那个前导 `\n` 一起从 `result["output"]` 里抠掉**——否则 agent 看到的命令输出末尾就会多一行乱码。用 `_session_id` 派生标记是为了避免命令本身偶然打印出这串字符造成误判。

### 一个跨命令连续性的例子

把快照机制串起来看一个具体例子。假设 agent 连发三条命令：

1. `export BUILD=release` —— 包裹脚本 `eval` 完这条后，`export -p > 快照` 把含 `BUILD` 的环境写回 `hermes-snap-*.sh`；`pwd -P` 写回 CWD（未变）。
2. `cd build` —— 第二条命令开头 `source 快照` 还原出 `BUILD`，`cd` 进 `build`，命令结束 `pwd -P` 把新 CWD `.../build` 写进 `hermes-cwd-*.txt` 并打进 stdout 标记；`_update_cwd` 把 `self.cwd` 更新成 `.../build`。
3. `echo $BUILD && cmake ..` —— 第三条命令 `source 快照` 拿到 `BUILD=release`，`_wrap_command` 用 `self.cwd`（已是 `.../build`）生成 `cd` 目标，于是命令在 `build` 目录里、带着 `BUILD` 变量跑。

三条命令是三个互相独立的 `bash` 进程，但 `export` 和 `cd` 的效果像在同一个终端里一样传递了下来——这正是快照文件 + CWD 跟踪要达成的「无状态执行模拟有状态会话」。

`init_session` 里还藏着一个跨平台细节，值得一看，因为它体现了 Hermes 对边角 case 的处理风格：

```python
_quoted_cwd = shlex.quote(self.cwd)
# Quote the snapshot / cwd-file paths so Git Bash on Windows handles
# ``C:/Users/...``-shaped paths without glob-splitting the colon ...
_quoted_snap = shlex.quote(self._snapshot_path)
_quoted_cwd_file = shlex.quote(self._cwd_file)
```

Windows 上 Git Bash 会把 `C:/Users/...` 里的冒号当 glob 特殊字符，导致「No such file or directory」错误并经 stderr 泄进每个 terminal 响应。这一处 `shlex.quote` 在 POSIX 上是 no-op，在 Windows 上则修掉了这个 bug。

### 超时、中断与活动检查

`_wait_for_process()`（`base.py` 约 580 起）是所有后端命令真正「等结果」的地方。它不是一句 `proc.wait()`，而是一个每 0.2 秒醒一次的非阻塞轮询循环，每次循环要同时盯三件事：

```python
while proc.poll() is None:
    if is_interrupted():                        # ① 用户/上层中断
        self._kill_process(proc)
        return {"output": ... + "\n[Command interrupted]", "returncode": 130}
    if time.monotonic() > deadline:             # ② 超时
        self._kill_process(proc)
        return {"output": partial + f"\n[Command timed out after {timeout}s]",
                "returncode": 124}
    touch_activity_if_due(_activity_state, "terminal command running")  # ③ 心跳
    time.sleep(0.2)
```

三条退出路径各有约定退出码：

- **中断**——`is_interrupted()` 为真时杀进程，返回 `returncode 130`（约定的「被 SIGINT 终止」码），输出尾部追加 `[Command interrupted]`。
- **超时**——`monotonic()` 越过 `deadline` 时杀进程，返回 `returncode 124`（GNU `timeout` 的约定码），并把已收集的**部分输出**带回去，附 `[Command timed out after Ns]`。超时值由 `execute()` 的 `timeout` 参数或后端默认 `self.timeout` 决定。
- **信号异常**——轮询期间收到 `KeyboardInterrupt`/`SystemExit`（进程收到 SIGTERM/SIGHUP）时，`except` 块先**杀掉子进程组**再 re-raise。本地后端用 `os.setsid` 把子进程放进独立进程组，若不主动杀组，Python 退出后子进程会被 init 收养成孤儿继续跑。杀进程组保证「agent 停了，它的副作用也停」。

杀进程本身走 `_kill_process()`（`base.py:709`），基类默认 `proc.kill()`，子类可重写成进程组级 kill。

长命令（`pytest` 跑几分钟）不能让 agent 看起来「卡死」。`base.py:55` 的 `touch_activity_if_due()` 解决这个：

```python
def touch_activity_if_due(state: dict, label: str) -> None:
    """Fire the activity callback at most once every ``state['interval']`` seconds."""
    now = time.monotonic()
    interval = state.get("interval", 10.0)
    if now - state["last_touch"] < interval:
        return
    state["last_touch"] = now
    try:
        cb = _get_activity_callback()
        if cb:
            elapsed = int(now - state["start"])
            cb(f"{label} ({elapsed}s elapsed)")
    except Exception:
        pass
```

它每 10 秒最多触发一次活动回调，把「已运行 N 秒」喂给 CLI 的 spinner（见[第 2 章](02-entrypoints.md)），同时也是 agent 整体「活着」判定的心跳信号之一。注意它**吞掉所有异常**——活动上报失败绝不能影响命令本身。

活动回调还有一个不那么显眼的作用：在消息网关/远程托管场景下，上游有一个「停滞看门狗」会判定 agent 是否还在干活，长时间无信号就可能终止它。`pytest`、`npm build` 这类几分钟的命令若没有心跳，看门狗会误判 agent 卡死。`touch_activity_if_due` 在轮询循环里每 10 秒打一次心跳，正是为了让看门狗知道「命令还在跑，不是死了」。`_wait_for_process` 里那段 `_DEBUG_INTERRUPT` 守护的心跳日志还会每 30 秒检查活动回调本身是否「丢失」——回调是 thread-local 的，嵌套工具调用或线程复用可能把它清掉，这段日志是为排查这类问题留的。

## 6.6 七种后端逐一解析

下面把七个后端各展开成一节，统一从「构造/连接 — _run_bash — cleanup — 适用与限制」四个角度看。

在逐一看之前，先理清一个贯穿七个后端的分类轴——**进程模型**：

- **spawn-per-call**——每条命令起一个全新进程。`local`（每次新 `bash`）、`ssh`（每次新 `ssh ... bash -c`，但底层连接经 ControlMaster 复用）属于此类。优点是命令间天然隔离，一条卡死不影响下一条。
- **长存实例 + exec**——容器/实例长期存在，每条命令通过 `exec` 进同一个实例。`docker`（`docker exec`）、`singularity`（`singularity exec` 进 instance）属于此类。
- **SDK 调用**——命令经云服务 SDK 下发，本地没有真子进程。`modal`、`daytona`、`vercel_sandbox` 属于此类，它们用 `_ThreadedProcessHandle` 把 SDK 调用伪装成 `Popen`。

不论哪种进程模型，「跨命令状态」都不靠进程本身存活来保证——靠的是 6.5 的会话快照文件。进程模型只决定「命令送进哪里、怎么送」，不决定「会话连不连续」。这就是为什么 spawn-per-call 后端也能让 `export`/`cd` 跨命令生效。

另一个共性是**惰性加载**。`docker`/`singularity` 的依赖（CLI 工具）轻量，在模块顶部 import 即可；但 `daytona`/`vercel_sandbox` 的 SDK 较重，工厂里用函数内 import 加载；`modal` 用 `_ensure_modal_sdk()` 惰性装。这样选 `local` 后端的用户不会被迫装上 Modal/Daytona/Vercel 的 SDK——七个后端的依赖互相隔离，按需付费。`tools/lazy_deps.py` 的 `ensure()` 还能在依赖缺失时按提示装包。

### LocalEnvironment（`tools/environments/local.py`）

最直接的后端——在 agent 进程所在机器上 `bash -c` 跑命令。

- **构造**——`__init__`（`local.py:408`）只接 `cwd`/`timeout`/`env`，对 `cwd` 做 `expanduser`，无 `cwd` 时取 `os.getcwd()`，随后立刻 `init_session()` 建快照。
- **`get_temp_dir()` 重写**（`local.py:414`）——这是本地后端最特殊的地方。基类硬编码 `/tmp`，但本地后端要面对真实多样的宿主：Termux 没有 `/tmp` 但有 POSIX `TMPDIR`；Windows 上 `/tmp` 既不能被原生 Python 打开、`%TEMP%` 又常含空格破坏 bash 插值。本地后端因此按「`TMPDIR`/`TMP`/`TEMP` 环境变量 → `/tmp` → `tempfile.gettempdir()`」的顺序探测，Windows 上则专门退到 `HERMES_HOME/cache/terminal`（强制正斜杠、保证无空格）。
- **`_run_bash`**（`local.py:462`）——`subprocess.Popen` 起一个 `bash`，POSIX 上加 `os.setsid` 让子进程独立成组。独立进程组是为了「整组 kill」：命令本身可能再 fork 出子进程（`make` 调编译器、脚本起后台任务），杀单个 `bash` 不够，必须杀整个进程组才能保证副作用全停。这也是 `_kill_process` 在本地后端被重写成进程组级 kill 的原因。
- **CWD 持久化**——本地后端能直接读宿主 `/tmp` 下的 `hermes-cwd-*.txt`，所以重写 `_update_cwd` 走文件读取，比解析 stdout 标记更可靠（命令输出再乱也不影响 CWD 读取）。
- **持久 shell 选项**——本地后端默认 `local_persistent = false`（`TERMINAL_LOCAL_PERSISTENT` 可开），即每条命令独立 spawn；非本地后端的 `persistent_shell` 默认为 true。本地之所以默认关，是因为本地零隔离场景下，独立 spawn 的隔离性比持久 shell 的便利性更重要。
- **CWD 持久化**——重写 `_update_cwd` 直接读 `hermes-cwd-*.txt` 文件，不走 stdout 标记解析。
- **适用场景**：自己的开发机，或一台专属 VPS——你接受 agent 对这台机器有完整 shell 权限。**限制**：零隔离，一次幻觉命令就能动到宿主任意文件。

### DockerEnvironment（`tools/environments/docker.py`）

通过 `docker exec` 在长存容器内执行命令。

- **构造**（`docker.py:286`）——参数最丰富的后端：`image`、`cpu`/`memory`/`disk` 资源限制、`volumes`、`forward_env`、`env`、`host_cwd`+`auto_mount_cwd`、`run_as_host_user`、`extra_args`。`cwd == "~"` 会被规整成 `/root`。
- **启动流程**——`_ensure_docker_available()` 先 fail-fast 探测 docker 可用；资源参数转成 `--cpus`/`--memory`/`--storage-opt`（disk 限额仅在非 macOS、且存储驱动为 overlay2+XFS+pquota 时生效，否则只打 warning）；持久模式用 `TERMINAL_SANDBOX_DIR`（默认 `~/.hermes/sandboxes/`）下的目录做 bind mount，非持久模式用 tmpfs。
- **文件可见性**——容器走 bind mount，宿主文件系统直接在容器内可见，因此**不需要 FileSyncManager**，`_before_execute` 保持空。
- **`_run_bash`**（`docker.py:566`）——容器在构造时就 `docker run -d` 起好并长存，每条命令通过 `docker exec` 进同一个容器，`_container_id` 记着它的句柄。这与 SSH 的「每条命令新连接」不同——Docker 是「容器长存、exec 复用」。
- **环境变量透传**——`forward_env` 让指定的宿主环境变量名透传进容器（`_normalize_forward_env_names` 做名称规整），`env` 字典则直接设固定键值。两者配合让容器内能拿到宿主的 API key 等凭据，又不必把整个环境一股脑灌进去。`run_as_host_user` 进一步让容器进程以宿主 uid/gid 运行，避免 bind mount 目录里产出 root 属主的文件。
- **`auto_mount_cwd`**——开启后（`TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE=true`），工厂会把宿主当前目录记进 `host_cwd`、容器内 `cwd` 重映射成 `/workspace`，构造时把 `host_cwd` bind mount 到 `/workspace`。这让「agent 在本机某个项目目录里工作、但命令在容器内跑」成为可能——容器内 `/workspace` 就是宿主的项目目录，改动实时双向可见。不开这个开关时，宿主路径被丢弃，容器从 `/root` 这种干净 cwd 起步。
- **`cleanup`**（`docker.py:629`）——停掉容器；持久模式下 bind mount 目录保留，下次同 `task_id` 复用。
- **适用场景**：希望 agent 有 shell 自由、但要和宿主隔开；坏了重建。**限制**：依赖宿主装有 Docker daemon；macOS 上不支持每容器 disk 限额。

### SSHEnvironment（`tools/environments/ssh.py`）

SSH 连到远程机器执行命令——文件里最小的后端（约 295 行）。

- **构造/连接**（`ssh.py:45`）——接 `host`/`user`/`port`/`key_path`。它在 `control_dir` 下建一个 **ControlMaster** socket，文件名用 `sha256(user@host:port)[:16]` 哈希命名——为的是把路径压在 macOS Unix domain socket 104 字节 `sun_path` 限制内（macOS 的 `$TMPDIR` 嵌套很深）。`_establish_connection` 跑一句 `echo` 验证连通，`_detect_remote_home` 探测远程 `$HOME`。
- **连接复用**——`_build_ssh_command`（`ssh.py:83`）固定带 `ControlMaster=auto`、`ControlPersist=300`、`BatchMode=yes`、`StrictHostKeyChecking=accept-new`，让后续每条命令复用同一条 TCP/认证连接，省掉重复握手。
- **文件同步**——构造时就建好 `FileSyncManager`（`scp` 上传 / `ssh rm` 删除 / tar 批量传），并 `sync(force=True)` 做一次全量推送；之后 `_before_execute`（`ssh.py:260`）每条命令前增量同步。
- **`_run_bash`**（`ssh.py:268`）——每次 `execute()` spawn 一个全新的 `ssh ... bash -c` 进程（spawn-per-call）。每条命令一个新进程听起来开销大，但 ControlMaster 让所有这些 `ssh` 进程复用底层的同一条已认证连接，实际握手只发生一次。会话连续性靠快照文件、CWD 靠 stdout 标记——这也是为什么远程后端必须用 stdout 标记而非临时文件读 CWD：宿主进程读不到远端的 `/tmp`。
- **`cleanup`**（`ssh.py:280`）——关掉 ControlMaster 主连接、清理 socket 文件。
- **适用场景**：agent 跑在笔记本上，活儿要在远程 GPU 机/跳板机上干。**限制**：远端必须有 `bash` 和 SSH 服务；网络抖动会让命令失败。

### SingularityEnvironment（`tools/environments/singularity.py`）

Singularity/Apptainer 容器——HPC 集群上常见、不需要 root 的容器运行时。

- **构造**（`singularity.py:164`）——接 `image`（默认 `docker://` 前缀的镜像）、资源参数、`persistent_filesystem`、`task_id`。镜像若是 `docker://` 形式会先被拉取并缓存成本地 SIF。
- **持久化机制**——持久模式用一个 **overlay 目录**承载可写层；`cleanup`（`singularity.py:246`）停掉 instance 后，把 overlay 目录路径按 `task_id` 写进 snapshots 索引，下次同 `task_id` 直接挂回去——这就是它的「快照」。
- **`_run_bash`**（`singularity.py:230`）——容器作为一个长存 instance 起好（`singularity instance start`），每条命令通过 `singularity exec` 进 instance 跑，模式与 Docker 的「容器长存 + exec」一致。
- **`cleanup`**（`singularity.py:246`）——`singularity instance stop` 停掉 instance；持久模式下不删 overlay 目录，而是把它的路径记进 snapshots 索引，下次复用。可执行文件名（`singularity` 还是 `apptainer`）由 `self.executable` 决定，两套运行时都兼容。
- **适用场景**：大学/超算集群——那里通常禁用 Docker（需要 root daemon）但装有 Apptainer。**限制**：rootless 运行，部分需要特权的操作受限。

### ModalEnvironment 与 ManagedModalEnvironment（`modal.py` / `managed_modal.py`）

两种 Modal serverless 模式，由工厂里的 `_get_modal_backend_state` 二选一（见 6.2）。

- **`ModalEnvironment`**（`modal.py:164`）——用户自己的 Modal 账号。`_stdin_mode = "heredoc"`、`_snapshot_timeout = 60`（冷启动慢）。构造时 `_ensure_modal_sdk()` 惰性装 SDK，把凭据/skill/cache 文件通过 `Mount.from_local_file` 挂进 sandbox。持久模式下用 `_get_snapshot_restore_candidate(task_id)` 找可恢复的快照 ID，从上次状态恢复。`_run_bash` 通过 `_ThreadedProcessHandle` 包裹异步 SDK 调用，`cancel_fn` 接到 `sandbox.terminate` 以支持中断。
- **`ManagedModalEnvironment`**（`managed_modal.py:36`）——Nous 托管后端，用户不用自己配 Modal 凭据，命令经托管工具网关转发。它继承自 `BaseModalExecutionEnvironment`（与 `ModalEnvironment` 共享 Modal 相关的执行逻辑），差别主要在「sandbox 由谁的账号创建、流量经哪条路」。选直连还是托管由 `TERMINAL_MODAL_MODE`（`auto`/`direct`/`managed`）与凭据/网关可用性共同决定（见 6.2）。
- **持久化与快照恢复**——Modal 的杀手锏是 serverless 持久化：sandbox 空闲休眠、按需几秒唤醒，闲时几乎零成本。持久模式下还能跨进程恢复——`_get_snapshot_restore_candidate(task_id)` 找上次留下的 Modal 文件系统快照 ID，新 sandbox 从该快照起步，连上次装的依赖、改的文件都还在。辅助函数集中在 `modal_utils.py`。
- **heredoc 模式的由来**——Modal/Daytona/Vercel 的命令是通过 SDK 调用（而非 `Popen`）下发的，SDK 接口通常只收一个命令字符串、不暴露独立的 stdin 流。`_stdin_mode = "heredoc"` 让基类把 stdin 数据接成 shell heredoc 拼进命令字符串，绕开「无法喂 stdin pipe」的限制。
- **适用场景**：想要按需唤醒、闲时不烧钱的云上 agent。**限制**：冷启动有秒级延迟（故 `_snapshot_timeout` 调到 60）。

### DaytonaEnvironment（`tools/environments/daytona.py`）

Daytona 云开发环境供给。

- **构造**（`daytona.py:40`）——`_stdin_mode = "heredoc"`。先 `lazy_deps.ensure("terminal.daytona")` 惰性装 SDK（工厂里也用函数内 import 保证只在选中时加载），再 `Daytona()` 建客户端。`memory`/`disk` 从 MB 向上取整成 GiB（`disk_gib > 10` 会打 warning）。
- **`_run_bash`**（`daytona.py:219`）——同样用 `_ThreadedProcessHandle` 包裹阻塞 SDK 调用，`cancel_fn` 接 `sandbox.stop()`。注释特别说明 SDK 自带超时不可靠，所以仍保留 shell 层的 timeout 包裹——这是「不信任 SDK 超时、用基类轮询兜底」的一个具体案例。
- **文件同步**——`_before_execute`（`daytona.py:213`）触发 FileSyncManager；与 SSH/Modal 共用同一套 `file_sync.py` 逻辑，只是注入的传输回调换成 Daytona SDK 的文件接口。
- **`cleanup`**（`daytona.py:244`）——停掉 sandbox；持久模式下 sandbox 状态保留，下次按 `task_id` 唤醒。
- **适用场景**：长期存在、有状态、但闲时省钱的 agent 工作环境。

### VercelSandboxEnvironment（`tools/environments/vercel_sandbox.py`）

Vercel 的隔离 sandbox。

- **构造**（`vercel_sandbox.py:240`）——`_stdin_mode = "heredoc"`，接 `runtime`、cwd、资源参数。`terminal_tool.py:126` 的 `_is_supported_vercel_runtime()` 与 `:130` 的 `_check_vercel_sandbox_requirements()` 在创建前做运行时与配置校验。
- **`_run_bash`**（`vercel_sandbox.py:589`）——heredoc 模式由基类 `execute()` 负责把 stdin 嵌进命令字符串。
- **`cleanup`**（`vercel_sandbox.py:631`）——它的回收顺序值得细看：先在 `_lock` 下取出 `sandbox` 和 `sync_manager` 并置空字段，再 `sync_manager.sync_back()` 把 sandbox 内改动同步回宿主，然后 `_snapshot_sandbox` 拍快照、`_stop_sandbox` 停止、`_close_sandbox_client` 关客户端。cleanup 总是停 sandbox 避免资源泄漏，与 Modal/Daytona 一致。`sync_back` 这一步对一次性后端尤其关键——sandbox 销毁后里面的文件就没了，不回写宿主就等于丢了 agent 的工作产物。
- **适用场景**：一次性、强隔离的代码执行。**限制**：runtime 受 `_is_supported_vercel_runtime` 约束，仅支持 Vercel 列出的运行时。

把七者放在一起对比：

```text
后端              隔离强度   持久化       _stdin_mode   文件可见性        典型场景
local            无         进程内       pipe          直接读宿主 FS      自己的开发机 / 专属 VPS
docker           容器        容器存活期    pipe          bind mount        本地隔离，坏了重建
ssh              远端机器    远端存活期    pipe          FileSyncManager   活儿在另一台机器上
singularity      容器        容器存活期    pipe          overlay 目录      HPC / 超算集群（无 Docker）
modal            sandbox    serverless   heredoc       FileSyncManager   按需唤醒，闲时近零成本
daytona          dev env    serverless   heredoc       FileSyncManager   长期有状态环境，闲时省钱
vercel_sandbox   sandbox    一次性        heredoc       FileSyncManager   强隔离的一次性执行
```

### 持久化的三种实现

「持久化」这个词在七个后端里指向三种不同的物理机制，理解差异有助于判断「重启后还在不在」：

- **进程内**（local）——所谓持久只在单个环境实例的生命周期内，靠快照文件维持；环境实例被回收、快照文件就清了。
- **可写层留存**（docker / singularity）——docker 用 bind mount 目录、singularity 用 overlay 目录承载容器的可写层，`persistent_filesystem=true` 时这个目录在 `cleanup` 后不删，按 `task_id` 索引，下次同 task 挂回去。容器本身没了，但「容器里装过的东西、改过的文件」留在那个目录里。
- **服务端快照**（modal / daytona / vercel）——持久化由云服务负责。Modal 拍文件系统快照、记 snapshot ID；Daytona/Vercel 由 SDK 管理 sandbox 状态。下次唤醒时从服务端快照恢复，连进程视角的状态都可能保留。

这解释了为什么 `TERMINAL_CONTAINER_PERSISTENT`（默认 true）对不同后端意味着不同的「代价/收益」：对 docker 它意味着宿主磁盘上多一个 sandbox 目录；对 modal 它意味着多一份服务端快照。关掉它，每次都是干净起点，但 agent 装的依赖、改的文件都不跨会话保留。

### 环境的复用与回收

七个后端的实例不是「每条命令新建一个」，而是按 `task_id` 在 `_active_environments` 字典里缓存。同一个 task（同一轮对话、同一个子 agent）发出的连续命令复用同一个环境实例——这才让会话快照、容器持久层、SSH ControlMaster 这些「跨命令状态」有意义。

回收由 `_cleanup_inactive_envs(lifetime_seconds)`（`terminal_tool.py:1257`）周期性执行，逻辑分两阶段：

1. **持锁阶段**——在 `_env_lock` 下扫 `_last_activity`，把闲置超过 `lifetime_seconds`（默认 300 秒）的 task 从跟踪字典里摘出来。但**绝不在锁内调 `env.cleanup()`**——Modal/Docker 的 teardown 能阻塞 10-15 秒，会卡住所有并发的 terminal/file 工具调用。
2. **释锁后阶段**——逐个调 `cleanup()` 真正销毁资源。

回收前还有一道闸：若 `process_registry.has_active_processes(task_id)` 为真（该环境里有后台进程在跑），就把 `_last_activity` 刷新到当前时间、跳过回收——不能把一个正在跑服务器的 sandbox 给关了。

## 6.7 sudo 处理：跨后端的统一逻辑

`sudo` 是个尴尬的命令——它要交互式终端输密码，而 agent 跑的命令通常没有 tty。Hermes 用一套统一逻辑（`_transform_sudo_command`，`terminal_tool.py:816`）让所有后端的 sudo 行为一致。它被 `BaseEnvironment._prepare_command()` 调用，因此七个后端都受益。

核心思路：把交互式密码输入改成 **`sudo -S` 从 stdin 读密码**。

```python
transformed, has_real_sudo = _rewrite_real_sudo_invocations(command)
if not has_real_sudo:
    return command, None
# 决定密码来源：SUDO_PASSWORD 环境变量 > 缓存 > 交互式询问
...
if has_configured_password or sudo_password:
    return transformed, sudo_password + "\n"   # 命令 + 待前置进 stdin 的密码
return command, None                            # 无密码：原样返回，优雅失败
```

返回的二元组 `(transformed_command, sudo_stdin)`：

- `transformed_command` 把每个裸 `sudo` 改成 `sudo -S -p ''`（`-S` 从 stdin 读密码，`-p ''` 抑制提示符）。`_rewrite_real_sudo_invocations` 只改真正的 sudo 调用，不会误伤 `echo sudo` 这类字面量。
- `sudo_stdin` 是带尾随换行的密码串。`sudo -S` 只读 stdin 的第一行当密码，剩下的透传给子命令——所以即便调用方自己也有 `stdin_data`，把密码**前置**拼上去也是安全的。`execute()` 里正是这么合并的（`base.py:799`）。

密码来源有三条优先级：

1. **`SUDO_PASSWORD` 环境变量**——配置好就直接用，适合无人值守。
2. **`_sudo_nopasswd_works()` 探测**——仅对本地后端：宿主 sudoers 配了 NOPASSWD 时，原样返回命令、不走密码管道。每次重新探测，不缓存，避免 sudo 时间戳过期后命令静默卡住。
3. **交互式询问**——`HERMES_INTERACTIVE=1` 时调 `_prompt_for_sudo_password()`（`terminal_tool.py:385`，45 秒超时），拿到后写进缓存。

**缓存作用域**是个关键设计。`_get_sudo_password_cache_scope()`（`terminal_tool.py:267`）按优先级生成 scope key：有 `HERMES_SESSION_KEY` 就用 `session:<key>`；否则用审批回调对象的 `id` 作 `callback-owner:...`；再不行退到 `thread:<tid>`。这保证一个用户会话里输一次密码后整会话复用，但**不会跨会话/跨用户泄漏**——不同 session 的 scope key 不同，缓存天然隔离。`_reset_cached_sudo_passwords()` 在测试和进程退出时清空缓存。

不同后端拿到 `sudo_stdin` 后处理方式不同：local/ssh/docker/singularity 直接把它前置进 Popen 的 stdin pipe；modal/daytona/vercel 无法喂 stdin pipe，由各自 `execute()` 把密码嵌进命令字符串。`_handle_sudo_failure()`（`terminal_tool.py:359`）还会在消息网关场景下，检测到 `sudo: a password is required` / `sudo: no tty present` 等失败标志时追加一句提示，引导用户去 `.env` 里配 `SUDO_PASSWORD`。

值得强调的是 `_rewrite_real_sudo_invocations` 的「只改真 sudo」语义。一个朴素的字符串替换会把 `git commit -m "run sudo first"` 里的 `sudo` 也改掉，破坏命令。这个函数做的是词法级别的识别——只命中处于命令位置的 `sudo`，跳过引号内、注释内、作为其它命令参数的字面 `sudo`。它还返回一个 `has_real_sudo` 布尔：命令里根本没有真 sudo 时，`_transform_sudo_command` 直接原样返回、连密码逻辑都不进入，零开销。这种「精确识别 + 无 sudo 时短路」的设计让 sudo 处理对绝大多数不含 sudo 的命令完全透明。

## 6.8 远程环境的文件同步

本地后端读写文件就是读写宿主文件系统。但 SSH/Modal/Daytona/Vercel 这些后端，文件在「那一边」——agent 的 `read_file`/`write_file` 工具（见[第 5 章](05-tool-system.md)）以及凭据/skill/cache 文件需要在宿主和远程环境之间搬运。这件事由 `tools/environments/file_sync.py` 的 `FileSyncManager` 负责。

它的 docstring 划清了适用范围：「Used by SSH, Modal, and Daytona. Docker and Singularity use bind mounts (live host FS view) and don't need this.」——bind mount 后端宿主文件系统直接可见，无需同步；只有「真·远程」后端才需要。

`FileSyncManager` 由各后端注入一组**传输回调**构造，自己不关心传输细节：

```python
UploadFn       # (host_path, remote_path) -> 上传单文件
BulkUploadFn   # [(host, remote), ...]   -> 批量上传
BulkDownloadFn # (dest_tar_path)         -> 把远端打成 tar 拉回
DeleteFn       # (remote_paths)          -> 删远端文件
GetFilesFn     # ()                      -> 枚举该同步哪些文件
```

SSH 后端注入的就是 `scp` 上传 / `ssh rm` 删除 / `tar` 批量传（`ssh.py:72`）。

工作方式：

- **变更检测**——`FileSyncManager` 用 `_file_mtime_key`（mtime + size）给每个文件算指纹，对比上次同步的快照，识别出新增/修改/删除。
- **同步时机**——构造时做一次 `sync(force=True)` 全量推送；之后每条命令前由 `_before_execute()` 触发增量 `sync()`。`_SYNC_INTERVAL_SECONDS = 5.0` 给增量同步设了节流，避免每条命令都全盘扫描。
- **同步内容**——`iter_sync_files(container_base)` 把凭据、skill、cache 三类文件汇成一张 `(host_path, remote_path)` 列表。`container_base` 参数很重要：凭据路径硬编码在 `/root/.hermes`，但远程用户的 home 可能是 `/home/daytona`，所以要把前缀重映射过去。
- **同步回写**——Vercel 的 `cleanup` 会调 `sync_manager.sync_back()`，把 sandbox 内的改动拉回宿主，再销毁 sandbox——否则 agent 在 sandbox 里写的文件就丢了。

`file_sync.py` 里还有几个值得注意的细节：

- **批量优先**——它提供 `BulkUploadFn`/`BulkDownloadFn`，能把一批文件打成 tar 一次传输，而非逐文件 N 次往返。对远程后端这是显著的性能差异——逐文件 `scp` 一百个小文件可能比 tar 一次传慢一个数量级。`quoted_rm_command` / `quoted_mkdir_command` 也是批处理风格，一条 `rm -f a b c` / `mkdir -p` 处理一批路径。
- **事务性**——docstring 明确说同步是「transactionally」的：要么一批文件都同步成功，要么失败抛异常，不留半同步的中间态。
- **文件锁**——同步过程用 `fcntl` 加文件锁（Windows 无 `fcntl` 时跳过），避免多个并发的同步操作互相覆盖。
- **可 patch 的 sleep**——模块里特意把 `time.sleep` 存成局部 `_sleep`，注释解释这是为了让测试能 patch 重试间隔，又不会因为 patch 了全局 `time` 模块而影响到其它后台线程。这是个为可测试性做的小设计。

## 6.9 命令守卫与审批回调

`execute()` 负责「怎么跑」，但「该不该跑」由 terminal 工具在调 `execute()` **之前**判定。这层就是命令守卫。

`_check_all_guards(command, env_type)`（`terminal_tool.py:324`）是统一入口，委托给 `tools/approval.py` 的 `check_all_command_guards`，并把审批回调一并传入：

```python
def _check_all_guards(command: str, env_type: str) -> dict:
    return _check_all_guards_impl(command, env_type,
                                  approval_callback=_get_approval_callback())
```

它做两件事：**Tirith 安全策略检查** + **危险命令检测**。两者都已收敛进 `tools/approval.py`，不再散落在 terminal 工具里。这两层的角色不同：

- **危险命令检测**——识别 `rm -rf /`、覆盖系统文件、`curl | sh` 这类高风险模式，命中就要求审批。
- **Tirith 安全策略**——一套可配置的策略引擎（见 `tools/tirith_security.py`），按用户/部署定义的规则做更细的判定。

注意守卫吃 `env_type` 参数——同一条命令在 `local` 后端和在 `vercel_sandbox` 后端的危险程度天差地别：在一次性 sandbox 里 `rm -rf` 顶多毁掉 sandbox，在 `local` 后端则可能毁掉用户的机器。守卫据此调整严格度——这正是 6.12 「后端即隔离」原则在守卫层的体现：隔离越强，规则可以越宽松。

审批回调由 `set_approval_callback()`（`terminal_tool.py:257`）注册。命中危险命令时，守卫通过这个回调把命令呈给用户批准；CLI 注册的回调会在终端弹确认提示，消息网关场景下则走另一套交互。子 agent 与 cron 任务因为没有用户实时盯着，审批策略与交互式会话不同（见[第 14 章](14-cron-delegate-batch.md)）。

terminal 工具还在守卫之前做 `_validate_workdir()`（`terminal_tool.py:337`）——用**白名单正则**校验 `workdir` 参数只含合法路径字符，挡掉混在工作目录里的 shell 元字符注入，比黑名单更难被绕过。

## 6.10 一条命令的完整数据流

把前面各节串起来，一条命令从 agent 发出到在某个后端执行，经过的路径如下：

<svg viewBox="0 0 820 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Full data flow of a command from agent to backend execution">
  <defs>
    <marker id="ar6b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="250" y="14" width="320" height="32" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="410" y="34" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">agent 决定调用 terminal 工具</text>
  <line x1="410" y1="46" x2="410" y2="62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6b)"/>
  <rect x="150" y="64" width="520" height="78" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
  <text x="168" y="84" font-size="11" font-weight="700" fill="currentColor">terminal_tool 入口</text>
  <text x="168" y="102" font-size="10" fill="#64748b">_validate_workdir() 白名单校验工作目录</text>
  <text x="168" y="118" font-size="10" fill="#64748b">_check_all_guards() → approval.py: Tirith + 危险命令检测</text>
  <text x="168" y="134" font-size="10" fill="#dc2626">命中危险命令 → 审批回调（拒绝 → 中止）　background=true → process_registry</text>
  <line x1="410" y1="142" x2="410" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6b)"/>
  <rect x="150" y="160" width="520" height="36" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.4"/>
  <text x="410" y="183" text-anchor="middle" font-size="10.5" fill="currentColor">_create_environment(env_type, ...) — 按 TERMINAL_ENV 分发，task_id 命中则复用</text>
  <line x1="410" y1="196" x2="410" y2="212" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6b)"/>
  <rect x="150" y="214" width="520" height="106" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.4"/>
  <text x="168" y="234" font-size="11" font-weight="700" fill="currentColor">BaseEnvironment.execute(command)</text>
  <text x="168" y="252" font-size="10" fill="#64748b">① _before_execute() — SSH/Modal/Daytona/Vercel → FileSyncManager.sync()</text>
  <text x="168" y="268" font-size="10" fill="#64748b">② _prepare_command() — _transform_sudo_command(): sudo → sudo -S</text>
  <text x="168" y="284" font-size="10" fill="#64748b">③ _rewrite_compound_background(): A && B & → A && { B & }</text>
  <text x="168" y="300" font-size="10" fill="#64748b">④ heredoc 嵌入 stdin（仅 _stdin_mode=="heredoc"）</text>
  <text x="168" y="314" font-size="10" fill="#64748b">⑤ _wrap_command() — source 快照 → cd → eval → 回写快照/CWD 标记</text>
  <line x1="410" y1="320" x2="410" y2="336" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6b)"/>
  <rect x="150" y="338" width="520" height="74" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="168" y="358" font-size="11" font-weight="700" fill="currentColor">_run_bash(wrapped, login, timeout, stdin) — 子类唯一必须实现的方法</text>
  <text x="168" y="376" font-size="10" fill="#64748b">local: Popen + setsid　docker/singularity: exec 进容器</text>
  <text x="168" y="392" font-size="10" fill="#64748b">ssh: ssh ... bash -c（ControlMaster 复用）</text>
  <text x="168" y="406" font-size="10" fill="#64748b">modal/daytona/vercel: _ThreadedProcessHandle 包裹 SDK 调用</text>
  <line x1="410" y1="412" x2="410" y2="428" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6b)"/>
  <rect x="150" y="430" width="520" height="34" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="410" y="451" text-anchor="middle" font-size="10" fill="currentColor">_wait_for_process() — 每 0.2s 轮询：中断→130 / 超时→124 / 心跳 touch_activity</text>
  <line x1="410" y1="464" x2="410" y2="478" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6b)"/>
  <rect x="150" y="480" width="520" height="30" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="410" y="500" text-anchor="middle" font-size="10" fill="currentColor">_update_cwd(result) — 解析 __HERMES_CWD_* 标记或读 cwd 文件</text>
  <line x1="410" y1="510" x2="410" y2="522" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6b)"/>
  <rect x="220" y="510" width="380" height="26" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
  <text x="410" y="527" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">返回 {"output", "returncode"} → terminal 工具 → agent</text>
</svg>
<span class="figure-caption">图 R6.2 ｜ 一条命令从 agent 发出到后端执行的完整数据流，七后端差异被压缩进 _run_bash 一点</span>

<details>
<summary>ASCII 原版</summary>

```text
  agent 决定调用 terminal 工具
        │  command, workdir, background, timeout
        ▼
  terminal_tool 入口
        │  _validate_workdir()          白名单校验工作目录
        │  _check_all_guards()  ───────▶ approval.py: Tirith + 危险命令检测
        │        │                              │
        │        │  命中危险命令                 ▼
        │        └──────────────────▶  审批回调（CLI 弹确认 / 网关交互）
        │                                       │ 拒绝 → 中止
        │  background=true ─────────▶  process_registry.spawn_*  → 返回 session_id
        │  background=false
        ▼
  _create_environment(env_type, ...)   工厂按 TERMINAL_ENV 分发，task_id 命中则复用
        │
        ▼
  BaseEnvironment.execute(command)
        │  ① _before_execute()        SSH/Modal/Daytona/Vercel → FileSyncManager.sync()
        │  ② _prepare_command()       _transform_sudo_command(): sudo → sudo -S
        │  ③ _rewrite_compound_background()   A && B &  →  A && { B & }
        │  ④ heredoc 嵌入 stdin       仅 _stdin_mode == "heredoc" 的后端
        │  ⑤ _wrap_command()          source 快照 → cd → eval 命令 → 回写快照/CWD 标记
        ▼
  _run_bash(wrapped, login, timeout, stdin)   ← 子类唯一必须实现的方法
        │   local: Popen + setsid
        │   docker/singularity: exec 进容器
        │   ssh: ssh ... bash -c（ControlMaster 复用）
        │   modal/daytona/vercel: _ThreadedProcessHandle 包裹 SDK 调用
        ▼
  _wait_for_process()  每 0.2s 轮询：中断→130 / 超时→124 / 心跳 touch_activity
        ▼
  _update_cwd(result)  解析 __HERMES_CWD_* 标记或读 cwd 文件，更新 self.cwd
        ▼
  返回 {"output": str, "returncode": int}  →  terminal 工具  →  agent
```

</details>

这张图也解释了为什么 `_run_bash` 是唯一抽象方法：从 ① 到 `_wait_for_process` 全是后端无关的公共逻辑，七个后端的差异被压缩进了「`_run_bash` 把命令送进哪里」这一个点。

### 沿途的几个退出点

这条数据流不是一定走到底，有几个早退点值得记住：

- **`_validate_workdir` 失败**——`workdir` 含非法字符，直接返回错误，不进环境。
- **守卫拒绝**——危险命令未通过审批，中止。
- **`background=true`**——分流到 `process_registry`，立刻返回 `session_id`，不走 `execute()`。
- **`_create_environment` 抛 `ValueError`**——SSH 缺 host/user、Modal 凭据不全、未知 `env_type` 等配置问题在工厂阶段就 fail-fast。
- **`init_session` 失败**——不算退出点，降级到 `bash -l` 继续。
- **超时/中断**——`_wait_for_process` 里以 `returncode 124`/`130` 提前返回。

最终返回给 agent 的始终是统一的 `{"output", "returncode"}` 结构。terminal 工具拿到后还会做输出长度截断（见[第 5 章](05-tool-system.md)的 `tool_output_limits`）、把退出码与输出格式化成 agent 可读的工具结果。agent 据此判断命令成败、决定下一步——整条链路对它而言只是「调了个 terminal 工具，拿到了结果」，七个后端的复杂度全被这层接口吸收了。

## 6.11 怎么选后端

七个后端不是平行的备选，而是对应七种部署形态。按几个问题就能定下来：

<svg viewBox="0 0 800 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Decision tree for choosing one of seven terminal backends">
  <defs>
    <marker id="ar6c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="300" y="14" width="200" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="400" y="34" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">agent 跑在哪？</text>
  <rect x="40" y="78" width="280" height="36" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="180" y="100" text-anchor="middle" font-size="10" fill="currentColor">开发机 / 专属 VPS，命令也在这里跑</text>
  <line x1="350" y1="46" x2="180" y2="76" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6c)"/>
  <rect x="480" y="78" width="290" height="36" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="625" y="100" text-anchor="middle" font-size="10" fill="currentColor">命令要在另一台机器跑（GPU 机、跳板机）</text>
  <line x1="450" y1="46" x2="625" y2="76" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6c)"/>
  <rect x="40" y="200" width="280" height="36" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="180" y="222" text-anchor="middle" font-size="10" fill="currentColor">HPC / 超算集群（无 Docker daemon）</text>
  <line x1="320" y1="55" x2="180" y2="198" stroke="#94a3b8" stroke-width="1.1" stroke-dasharray="3,2" marker-end="url(#ar6c)"/>
  <rect x="480" y="200" width="290" height="36" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="625" y="222" text-anchor="middle" font-size="10" fill="currentColor">想要云上、闲时不烧钱</text>
  <line x1="480" y1="55" x2="625" y2="198" stroke="#94a3b8" stroke-width="1.1" stroke-dasharray="3,2" marker-end="url(#ar6c)"/>
  <rect x="40" y="128" width="130" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="105" y="148" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">local</text>
  <text x="105" y="172" text-anchor="middle" font-size="9" fill="#64748b">接受零隔离</text>
  <rect x="190" y="128" width="130" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="255" y="148" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">docker</text>
  <text x="255" y="172" text-anchor="middle" font-size="9" fill="#64748b">不接受，要同机隔离</text>
  <line x1="120" y1="114" x2="105" y2="126" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar6c)"/>
  <line x1="240" y1="114" x2="255" y2="126" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar6c)"/>
  <rect x="560" y="128" width="130" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="625" y="148" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">ssh</text>
  <line x1="625" y1="114" x2="625" y2="126" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar6c)"/>
  <rect x="115" y="250" width="130" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="180" y="270" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">singularity</text>
  <line x1="180" y1="236" x2="180" y2="248" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar6c)"/>
  <rect x="450" y="252" width="155" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="527" y="271" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">daytona</text>
  <text x="527" y="296" text-anchor="middle" font-size="9" fill="#64748b">长期有状态环境</text>
  <rect x="450" y="312" width="155" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="527" y="331" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">modal</text>
  <text x="527" y="356" text-anchor="middle" font-size="9" fill="#64748b">按需唤醒 sandbox</text>
  <rect x="630" y="282" width="155" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="707" y="301" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">vercel_sandbox</text>
  <text x="707" y="326" text-anchor="middle" font-size="9" fill="#64748b">一次性强隔离执行</text>
  <line x1="625" y1="236" x2="527" y2="250" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar6c)"/>
  <line x1="625" y1="236" x2="527" y2="310" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar6c)"/>
  <line x1="625" y1="236" x2="707" y2="280" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar6c)"/>
</svg>
<span class="figure-caption">图 R6.3 ｜ 七种终端后端的选型决策树：按部署形态逐步收敛到一个后端</span>

<details>
<summary>ASCII 原版</summary>

```text
agent 跑在哪？
├─ 我的开发机 / 专属 VPS，命令也在这里跑
│   └─ 接受零隔离？  → local
│       不接受？     → docker（同机隔离，坏了重建）
├─ 命令要在另一台机器跑（GPU 机、跳板机）
│   └─ ssh
├─ HPC / 超算集群（无 Docker daemon）
│   └─ singularity
└─ 想要云上、闲时不烧钱
    ├─ 长期有状态的工作环境          → daytona
    ├─ 按需唤醒的 sandbox            → modal（有 Modal 账号→direct，没有→managed）
    └─ 一次性、强隔离的代码执行      → vercel_sandbox
```

</details>

几条经验法则：

- **子 agent 和 cron 任务优先选受限后端**。它们没有用户实时盯着，跑在 `docker`/`modal`/`vercel_sandbox` 里能把失控的爆炸半径框住（见[第 14 章](14-cron-delegate-batch.md)）。
- **批量轨迹生成选容器后端**。容器镜像保证每个样本从同一干净起点出发，可复现。
- **成本敏感选 serverless**。`modal`/`daytona` 闲时休眠，按需唤醒；挂在常驻 VPS 上的 `local`/`ssh` 是另一种成本模型。
- **`local` 只在你真的信任这台机器、且接受 agent 有完整 shell 权限时用**。

切换后端不需要改任何代码——改 `config.yaml` 的 `terminal.*`（或对应 `TERMINAL_*` 环境变量）就行。这正是把执行环境做成可插拔接口的回报。

## 6.12 安全考量：审批与受限环境

执行环境是 agent 风险面最大的地方，Hermes 在这里叠了几层防护：

- **命令审批**。`set_approval_callback()`（`terminal_tool.py:257`）注册审批回调，危险命令在执行前要经用户批准（见 6.9）。
- **sudo 处理**。`_transform_sudo_command()`（`terminal_tool.py:816`）在所有后端间提供一致的 sudo 处理，密码缓存按会话作用域隔离（见 6.7）。
- **守卫检查**。`_check_all_guards()`（`terminal_tool.py:324`）按 `env_type` 做命令级守卫，并叠 `_validate_workdir()` 白名单。
- **后端即隔离**。把 `TERMINAL_ENV` 设成 docker/modal/vercel_sandbox，本身就是最有效的安全措施——子 agent 和 cron 任务尤其应该跑在受限后端里，因为它们没有用户实时盯着。

设计上的取舍很清楚：Hermes 不试图用「命令黑名单」来保证安全（黑名单永远漏），而是把「换一个隔离的执行环境」做成一个配置项——真正的边界是后端，不是规则。

## 6.13 设计回顾

回头看整章，终端后端这套设计可以归结为几条贯穿始终的原则：

- **窄抽象 + 厚基类**。子类只需实现 `_run_bash` + `cleanup` 两个方法，七个后端的差异被压进「命令送去哪里跑」一个点；会话、sudo、超时、中断、心跳全在基类。新增后端的成本因此很低。
- **快照而非长存 shell**。用 `hermes-snap-*.sh` 文件模拟会话连续性，避开了长存 shell 在远程/容器场景下的脆弱性，并让每条命令彼此隔离。
- **优化可降级**。会话快照、ControlMaster 复用、容器持久层都是优化——失败时功能不丢，只退化性能。`init_session` 失败就退回 `bash -l`，是这条原则最典型的体现。
- **统一处理边角情况**。sudo、Windows Git Bash 的冒号路径、macOS bash 3.2 的 `declare` 回显、`A && B &` 子 shell 泄漏——这些坑都在基类里一次性修掉，七个后端共同受益。
- **隔离是配置项**。安全不靠命令规则，靠换后端。`TERMINAL_ENV` 一个变量就能把爆炸半径从「整台机器」收缩到「一个一次性 sandbox」。

这也解释了为什么一个 agent 框架值得为「在哪里跑命令」写七个后端——它对应的是七种真实的部署形态，而统一的 `BaseEnvironment` 接口让上层的 terminal 工具、文件工具、子 agent 全都不必关心这个选择。

---

## 延伸阅读

- `terminal` 工具如何被注册、如何被 agent 调用 → [第 5 章 工具系统](05-tool-system.md)
- 命令执行在一次真实请求中的位置 → [Trace 步骤 13](tour-13-tool-execute.md)
- 子 agent 与 cron 为何应跑在受限后端 → [第 14 章 Cron 调度、子 Agent 派发与批量运行](14-cron-delegate-batch.md)
- 活动回调如何驱动 CLI spinner → [第 2 章 入口与进程引导](02-entrypoints.md)
- 批量轨迹生成为何依赖一致的容器环境 → [第 14 章](14-cron-delegate-batch.md)
- 命令输出截断与工具结果格式化 → [第 5 章 工具系统](05-tool-system.md)
- 危险命令检测与审批策略的实现 → `tools/approval.py`、`tools/tirith_security.py`
- 后台进程注册表如何跟踪 `background=true` 起的进程 → `tools/process_registry.py`
